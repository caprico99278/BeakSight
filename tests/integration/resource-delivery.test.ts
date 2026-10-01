// L5b（サイトへの負荷の制御の設計書 3.1 の2・3・5、4.6、4.7、第7章）: Run 全体のキャッシュと、許可された要求の届け方を、
// Guard と Context の factory に配線した結果を、ローカルの fixture のサーバが受け取った要求で確かめる。
// - 主の読み込み（Passive の Desktop と Mobile。役割 PRIMARY）は、すべてネットワークから取り、応答をキャッシュに入れる。
// - 読み込み直しの Context（幅の走査と Interaction。役割 REVISIT）は、キャッシュにある画像とスクリプトをキャッシュから返し、
//   許可 Origin の外への、キャッシュにない要求を送らない。文書の要求は、どの読み込みでも送る。
// - 凍結の後の要求と、GET・HEAD 以外の要求は、届け方の部品に渡らず、今のまま Guard が止めて Safety の記録に残す。
// 2つ目の Origin（許可 Origin の外）は、fixture のサーバをもう1つ起動して作る（ポートが違うので、別の Origin になる）。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { ResourceCache } from '../../src/browser/resource-delivery.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { EvidenceRecord, EvidenceRecordFor, EvidenceType, PageAuditOutcome, ViewportProfile } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createLoadMeter, type LoadMeter } from '../../src/crawl/load-meter.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createRunLauncher, expectOnlyReadRequests, runWithCoordinator } from '../helpers/run-harness.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';

const AUDIT_TEST_TIMEOUT_MS = 180_000;
/** 許可 Origin の画像とスクリプト、2つ目の Origin の画像とスクリプトを読み、Interaction の候補を1つ持つページ。 */
const RESOURCE_PAGE = '/resource-delivery.html';
/** クリックの後に、`RESOURCE_PAGE` が読む画像（`ALLOWED_IMAGE`）を読もうとするページ。読み込みのときには読まない。 */
const AFTER_CLICK_PAGE = '/resource-delivery-after-click.html';
const ALLOWED_IMAGE = '/resource-delivery.svg';
const ALLOWED_SCRIPT = '/resource-delivery.js';
/** 2つ目の Origin の画像（同じパスで、読み込みごとに違うクエリの計測の画像も読む。サーバの記録のパスはクエリを含まない）。 */
const OTHER_IMAGE = '/external-image.svg';
const OTHER_SCRIPT = '/external-script.js';
/** `RESOURCE_PAGE` の1回の読み込みで、2つ目の Origin に送る要求（画像、計測の画像、スクリプト）。 */
const OTHER_REQUESTS_PER_LOAD = 3;
/** `RESOURCE_PAGE` の1回の読み込み直しで、キャッシュから返す要求（許可 Origin と2つ目の Origin の、画像とスクリプト）。 */
const CACHED_REQUESTS_PER_REVISIT = 4;
/** `RESOURCE_PAGE` の1回の読み込み直しで、送らない要求（2つ目の Origin の計測の画像。読み込みごとに URL が違う）。 */
const WITHHELD_REQUESTS_PER_REVISIT = 1;
/** 主の読み込み（Passive の Desktop と Mobile）の回数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
/** `RESOURCE_PAGE` が2つ目の Origin のポートを受け取るクエリの名前。URL の正規化で落とさないよう、設定で残す。 */
const OTHER_PORT_QUERY_PARAMETER = 'otherPort';
/** 幅の走査（幅を1つ）と Interaction（候補は1つ）を行い、スクリーンショットは撮らない設定。 */
const REVISIT_OVERRIDES: TestConfigOverrides = Object.freeze({
  crawl: Object.freeze({ allowedQueryParameters: [OTHER_PORT_QUERY_PARAMETER] }),
  viewports: Object.freeze({ stressWidths: [1_024] }),
  audit: Object.freeze({ screenshots: false, interactions: true }),
});

let browser: Browser;
const servers: FixtureServer[] = [];
const temporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftoverContexts = browser.contexts();
  for (const context of leftoverContexts) {
    await context.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftoverContexts, 'Contexts left in the browser after the test').toHaveLength(0);
});

async function startServer(): Promise<FixtureServer> {
  const server = await startFixtureServer();
  servers.push(server);
  return server;
}

/** 許可 Origin のサーバ（`allowed`）と、2つ目の Origin のサーバ（`other`）。 */
async function startServers(): Promise<{ readonly allowed: FixtureServer; readonly other: FixtureServer }> {
  return { allowed: await startServer(), other: await startServer() };
}

/** `RESOURCE_PAGE` に、2つ目の Origin のポートを付けたパス。 */
const resourcePagePath = (other: FixtureServer): string =>
  `${RESOURCE_PAGE}?${OTHER_PORT_QUERY_PARAMETER}=${new URL(other.origin).port}`;

/** サーバが受け取った、`pathname` の要求の数。 */
const receivedCount = (server: FixtureServer, pathname: string): number =>
  server.getRequestObservations().filter((observation) => observation.pathname === pathname).length;

function meterFor(config: AuditConfig): LoadMeter {
  return createLoadMeter({ allowedOrigins: config.site.allowedOrigins, now: () => Date.now() });
}

interface CachedFactory {
  readonly config: AuditConfig;
  readonly factory: BrowserContextFactory;
  readonly cache: ResourceCache;
  readonly meter: LoadMeter;
}

/** Run Coordinator と同じく、Run 全体のキャッシュと meter を渡した factory。 */
function cachedFactory(allowed: FixtureServer, overrides: TestConfigOverrides = REVISIT_OVERRIDES): CachedFactory {
  const config = createTestConfig(allowed.origin, '/', overrides);
  const cache = new ResourceCache();
  const meter = meterFor(config);
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { loadMeter: meter, resourceCache: cache });
  return { config, factory, cache, meter };
}

/** `pathname` のページを、`cached` の factory の Page Auditor で監査する（本番の Run Coordinator と同じ部品の組み合わせ）。 */
async function auditPage(
  cached: CachedFactory,
  origin: string,
  pathname: string,
  pacer: NavigationPacer = createTestNavigationPacer(cached.config),
): Promise<PageAuditOutcome> {
  const allocator = new IdAllocator();
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-resource-delivery-'));
  temporaryDirectories.push(screenshotRootDirectory);
  const auditor = new PageAuditor({
    contextFactory: cached.factory,
    config: cached.config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    navigationPacer: pacer,
    safetyViolationRecorded: () => false,
  });
  const normalized = normalizeUrl(`${origin}${pathname}`, `${origin}${pathname}`, new Set(cached.config.crawl.allowedQueryParameters));
  if (!normalized.ok) {
    throw new Error(`fixture URL must normalize: ${pathname}`);
  }
  const outcome = await auditor.audit(normalized.url, allocator.allocatePageId());
  expect(browser.contexts(), 'Contexts left in the browser after audit()').toHaveLength(0);
  return outcome;
}

function evidenceOf<TType extends EvidenceType>(
  outcome: PageAuditOutcome,
  type: TType,
  viewport: ViewportProfile,
): EvidenceRecordFor<TType>[] {
  return outcome.result.evidence.filter(
    (record): record is EvidenceRecordFor<TType> & EvidenceRecord => record.type === type && record.viewport === viewport,
  );
}

describe('the Run cache and resource delivery through the Page Auditor (L5b)', () => {
  it('serves the main-load images and scripts from the Run cache in the width scan and Interaction Contexts and withholds the other origin', async () => {
    const { allowed, other } = await startServers();
    const cached = cachedFactory(allowed);
    const pacer = createTestNavigationPacer(cached.config);

    const outcome = await auditPage(cached, allowed.origin, resourcePagePath(other), pacer);

    // Passive の Desktop と Mobile に加えて、幅の走査（1つ）と Interaction（候補1つ）の読み込み直しを行った。
    const navigationCount = pacer.snapshot().navigationCount;
    const revisitLoads = navigationCount - PRIMARY_LOADS_PER_PAGE;
    expect(revisitLoads).toBe(2);
    expect(evidenceOf(outcome, 'interaction', 'desktop').map((record) => record.payload.status)).toEqual(['VERIFIED']);
    expect(outcome.result.viewports.desktop.status).toBe('AUDITED');
    expect(outcome.safety.invariantViolationCount).toBe(0);

    // 文書の要求は、すべての読み込みで届く。画像とスクリプトは、主の読み込みの分だけ届く（読み込み直しでは届かない）。
    expect(receivedCount(allowed, RESOURCE_PAGE)).toBe(navigationCount);
    expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(PRIMARY_LOADS_PER_PAGE);
    expect(receivedCount(allowed, ALLOWED_SCRIPT)).toBe(PRIMARY_LOADS_PER_PAGE);
    expect(allowed.getRequestObservations()).toHaveLength(navigationCount + 2 * PRIMARY_LOADS_PER_PAGE);
    // 2つ目の Origin には、主の読み込みの分だけ届く（読み込み直しの Context からは、何も届かない）。
    expect(receivedCount(other, OTHER_IMAGE)).toBe(2 * PRIMARY_LOADS_PER_PAGE);
    expect(receivedCount(other, OTHER_SCRIPT)).toBe(PRIMARY_LOADS_PER_PAGE);
    expect(other.getRequestObservations()).toHaveLength(OTHER_REQUESTS_PER_LOAD * PRIMARY_LOADS_PER_PAGE);
    expectOnlyReadRequests(allowed.getCounters(), allowed.getRequestObservations());
    expectOnlyReadRequests(other.getCounters(), other.getRequestObservations());

    // 負荷の記録: キャッシュから返した要求と送らなかった要求は、数に入らない（サーバが受け取った数と一致する）。
    expect(cached.meter.snapshot()).toEqual({
      allowedOrigins: { count: allowed.getRequestObservations().length, peakPerMinute: allowed.getRequestObservations().length },
      otherOrigins: { count: other.getRequestObservations().length, peakPerMinute: other.getRequestObservations().length },
      servedFromCache: CACHED_REQUESTS_PER_REVISIT * revisitLoads,
      withheldOtherOrigins: WITHHELD_REQUESTS_PER_REVISIT * revisitLoads,
    });

    // 主の読み込み（PRIMARY）は、キャッシュから返さない。Desktop と Mobile の network の Evidence に、画像とスクリプトの要求と
    // 応答がある（キャッシュにあっても、ネットワークから取った）。
    const resourceUrls = [
      `${allowed.origin}${ALLOWED_IMAGE}`,
      `${allowed.origin}${ALLOWED_SCRIPT}`,
      `${other.origin}${OTHER_IMAGE}`,
      `${other.origin}${OTHER_SCRIPT}`,
    ];
    for (const viewport of ['desktop', 'mobile'] as const) {
      const network = evidenceOf(outcome, 'network', viewport);
      expect(network, viewport).toHaveLength(1);
      const payload = network[0]!.payload;
      for (const url of resourceUrls) {
        expect(payload.requests.map((request) => request.url), `${viewport} ${url}`).toContain(url);
        expect(payload.responses.filter((response) => response.url === url).map((response) => response.status), `${viewport} ${url}`)
          .toEqual([200]);
      }
      expect(payload.failures, viewport).toEqual([]);
    }
  }, AUDIT_TEST_TIMEOUT_MS);

  it('does not serve a cached image requested after the freeze; the Guard blocks it and records it in the Safety Evidence', async () => {
    const { allowed, other } = await startServers();
    const cached = cachedFactory(allowed);
    // 先に、画像（`ALLOWED_IMAGE`）を読むページを監査し、Run 全体のキャッシュに入れる。
    await auditPage(cached, allowed.origin, resourcePagePath(other));
    expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(PRIMARY_LOADS_PER_PAGE);
    const before = cached.meter.snapshot();
    const imageUrl = `${allowed.origin}${ALLOWED_IMAGE}`;

    const outcome = await auditPage(cached, allowed.origin, AFTER_CLICK_PAGE);

    // クリックの後の画像の要求は、キャッシュにあっても、Guard が凍結で止め、Interaction の Safety の記録に残す。
    const interactions = evidenceOf(outcome, 'interaction', 'desktop');
    expect(interactions.map((record) => record.payload.status)).toEqual(['BLOCKED_BY_SAFETY']);
    const interactionSafety = evidenceOf(outcome, 'safety', 'desktop').filter((record) => record.payload.scope === 'INTERACTION');
    expect(interactionSafety).toHaveLength(1);
    expect(interactionSafety[0]?.payload.blockedInteractionRequests).toEqual([
      expect.objectContaining({ method: 'GET', url: imageUrl, reason: 'INTERACTION_FROZEN' }),
    ]);
    // キャッシュから返していない（数が増えていない）し、サーバにも届いていない。
    expect(cached.meter.snapshot().servedFromCache).toBe(before.servedFromCache);
    expect(cached.meter.snapshot().withheldOtherOrigins).toBe(before.withheldOtherOrigins);
    expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(PRIMARY_LOADS_PER_PAGE);
    expect(outcome.safety.invariantViolationCount).toBe(0);
  }, AUDIT_TEST_TIMEOUT_MS);
});

describe('the Run cache and resource delivery in the Contexts of the factory (L5b)', () => {
  it('renders the images and runs the scripts served from the Run cache in a REVISIT Context and withholds the other origin', async () => {
    const { allowed, other } = await startServers();
    const cached = cachedFactory(allowed);
    const viewport = cached.config.viewports.primaryDesktop;
    const pageUrl = `${allowed.origin}${resourcePagePath(other)}`;
    const primary = await cached.factory.createPassiveContext(viewport);
    const primaryPage = await cached.factory.createPassivePage(primary);
    const revisit = await cached.factory.createPassiveContext(viewport, 'REVISIT');
    const revisitPage = await cached.factory.createPassivePage(revisit);
    try {
      await primaryPage.goto(pageUrl, { waitUntil: 'load' });
      // 応答の本文は非同期で取ってからキャッシュに入れるので、4件（許可 Origin と2つ目の Origin の画像とスクリプト）が入るまで待つ。
      await expect.poll(() => cached.cache.stats().entryCount).toBeGreaterThanOrEqual(CACHED_REQUESTS_PER_REVISIT);

      await revisitPage.goto(pageUrl, { waitUntil: 'load' });
      const rendered = await revisitPage.evaluate(() => ({
        allowedImageWidth: document.querySelector<HTMLImageElement>('#allowed-image')?.naturalWidth ?? null,
        otherImageWidth: document.querySelector<HTMLImageElement>('#other-image')?.naturalWidth ?? null,
        allowedScriptLoaded: (globalThis as { fixtureResourceDeliveryScriptLoaded?: boolean }).fixtureResourceDeliveryScriptLoaded ?? false,
        otherScriptLoaded: (globalThis as { fixtureExternalScriptLoaded?: boolean }).fixtureExternalScriptLoaded ?? false,
      }));

      // キャッシュから返した画像は表示され、スクリプトは実行される。
      expect(rendered).toEqual({ allowedImageWidth: 8, otherImageWidth: 1, allowedScriptLoaded: true, otherScriptLoaded: true });
      // サーバには、文書が2回、画像とスクリプトは主の読み込みの1回だけ届く。2つ目の Origin にも、主の読み込みの分だけ届く。
      expect(receivedCount(allowed, RESOURCE_PAGE)).toBe(2);
      expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(1);
      expect(receivedCount(allowed, ALLOWED_SCRIPT)).toBe(1);
      expect(other.getRequestObservations()).toHaveLength(OTHER_REQUESTS_PER_LOAD);
      await expect.poll(() => cached.meter.snapshot().withheldOtherOrigins).toBe(WITHHELD_REQUESTS_PER_REVISIT);
      expect(cached.meter.snapshot().servedFromCache).toBe(CACHED_REQUESTS_PER_REVISIT);
      // 送らなかった要求は、安全のための遮断ではないので、Safety の記録に入れない。
      const revisitSafety = cached.factory.getSafetyLedger(revisit).snapshot();
      expect(revisitSafety.blockedRequests).toEqual([]);
      expect(revisitSafety.invariantViolationCount).toBe(0);
    } finally {
      await closePassiveResources({ factory: cached.factory, context: primary, page: primaryPage });
      await closePassiveResources({ factory: cached.factory, context: revisit, page: revisitPage });
    }
  });

  it('does not pass non-read requests of a REVISIT Context to the delivery part; the Guard blocks and records them', async () => {
    const allowed = await startServer();
    const cached = cachedFactory(allowed);
    const revisit = await cached.factory.createPassiveContext(cached.config.viewports.primaryDesktop, 'REVISIT');
    const page = await cached.factory.createPassivePage(revisit);
    try {
      await page.goto(`${allowed.origin}/passive-patch-request.html`, { waitUntil: 'load' });
      const ledger = cached.factory.getSafetyLedger(revisit);
      await expect.poll(() => ledger.snapshot().blockedRequests.length).toBe(1);

      // Guard が、許可の判定の BLOCK で止めた（Safety の記録に残る）。届け方の部品は、送らない要求として数えていない。
      expect(ledger.snapshot().blockedRequests).toEqual([
        expect.objectContaining({ method: 'PATCH', url: `${allowed.origin}/__mutation` }),
      ]);
      expect(cached.meter.snapshot().withheldOtherOrigins).toBe(0);
      expect(cached.meter.snapshot().servedFromCache).toBe(0);
      expect(allowed.getCounters().patch).toBe(0);
      expectOnlyReadRequests(allowed.getCounters(), allowed.getRequestObservations());
    } finally {
      await closePassiveResources({ factory: cached.factory, context: revisit, page });
    }
  });
});

// Run Coordinator は、Run の初めに Run 全体のキャッシュを1つ作り、PREFLIGHT を通して factory に渡す。Run の結果の `load` に、
// キャッシュから返した数と、送らなかった数が入る。許可 Origin とそれ以外の要求の数は、サーバが受け取った数と一致する。
describe('the Run cache through the Run Coordinator (L5b)', () => {
  it('records requests served from the Run cache and withheld requests in load, apart from the requests the servers received', async () => {
    const { allowed, other } = await startServers();
    const config = createTestConfig(allowed.origin, resourcePagePath(other), REVISIT_OVERRIDES);
    const launcher = createRunLauncher();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-resource-delivery-run-'));
    temporaryDirectories.push(outputDirectory);
    try {
      const result = await runWithCoordinator({ config, launchBrowser: launcher.launcher, outputDirectory });

      const { load } = result.run;
      expect(load.requests.servedFromCache).toBeGreaterThan(0);
      expect(load.requests.withheldOtherOrigins).toBeGreaterThan(0);
      // キャッシュから返した要求と送らなかった要求は、`allowedOrigins` と `otherOrigins` に入らない。
      expect(load.requests.allowedOrigins.count).toBe(allowed.getRequestObservations().length);
      expect(load.requests.otherOrigins.count).toBe(other.getRequestObservations().length);
      expect(receivedCount(allowed, ALLOWED_IMAGE)).toBe(PRIMARY_LOADS_PER_PAGE);
      expect(receivedCount(allowed, ALLOWED_SCRIPT)).toBe(PRIMARY_LOADS_PER_PAGE);
      expect(other.getRequestObservations()).toHaveLength(OTHER_REQUESTS_PER_LOAD * PRIMARY_LOADS_PER_PAGE);
      await expect(validateArtifact('run', result.run)).resolves.toEqual({ ok: true });
    } finally {
      expect(await launcher.closeAll(), 'Browsers left connected after the Run').toBe(0);
    }
  }, AUDIT_TEST_TIMEOUT_MS);
});
