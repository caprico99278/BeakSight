// L2（サイトへの負荷の制御の設計書 4.1、4.4、第7章）: ページの読み込みの間隔と、待ち時間を期限から除くこと。
// - 間隔: BeakSight が始めるすべてのページの読み込み（Passive の Desktop と Mobile、幅の走査の各幅、Interaction の各候補、robots.txt と
//   sitemap.xml）は、Run で1つの `NavigationPacer` の待ちを通り、読み込みの開始の間隔が設定以上になる。
//   fixture のサーバの記録には時刻がないので、読み込みの開始の時刻は pacer の記録（`snapshot().lastNavigationStartedAtMs`）で、
//   読み込みの要求の時刻は、Context の `request` の事象（main frame のナビゲーション）を受けた時刻で記録する。そのうえで、
//   「k 番目の開始 ≦ k 番目の要求 ≦ k+1 番目の開始」（どの要求も、それぞれの開始の後に送られた）と、「開始の間隔 ≧ 設定」を確かめる。
//   要求の数は、fixture のサーバが受け取った数とも比べる。
//   RL-fix（RL の Minor-4 (b)）: ページの監査の間隔は、サーバの側で受け取った文書の要求の時刻の間隔でも確かめる（テストの中だけの
//   小さなサーバで、受け取った時刻を記録する）。サーバの側の間隔は、開始から届くまでの遅れの分だけ揺れるので、従の確かめとして、
//   根拠を測った許容（`SERVER_ARRIVAL_DELAY_TOLERANCE_MS`。DEF-034-fix）を置いていた（DEF-100 fix から 0）。開始の間隔も許容なしに確かめる。
//   DEF-100 fix: pacer は、開始と、前の読み込みの文書の要求を送った時刻・その応答を受けた時刻（Guard が記録する）の最も遅い方から間隔を
//   数える。サイトに届く間隔が設定以上であることは、間隔の待ちの後の Context の作成を遅らせた場合（ページの監査と Run）で、許容なしで確かめる。
// - 期限から待ち時間を除く: ページの期限より長い待ちがあっても、Passive の監査、幅の走査、1件目の Interaction の候補が期限切れにならない。
//   RL-fix（RL の Minor-4 (a)）: 延ばし過ぎ（例: 待った時間の2倍）も見分ける。注入した時計と、期限を受け取る collector に渡された期限で、
//   延長の量そのものを確かめる。Interaction の段階は、期限で止まるはずの候補が、待った時間 + 期限で止まることを確かめる。
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Request } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { EvidenceRecord, EvidenceRecordFor, EvidenceType, PageAuditOutcome, ViewportProfile } from '../../src/core/contracts.js';
import { wait } from '../../src/core/deadline.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { COLLECTOR_DEADLINE_MARGIN_MS } from '../../src/core/limits.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { collectSiteMetadata } from '../../src/crawl/site-metadata.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import { collectLayoutEvidence, collectStressLayout } from '../../src/evidence/layout-collector.js';
import { discoverInteractionCandidates } from '../../src/interaction/discover-candidates.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditCollectors } from '../../src/orchestration/page-auditor.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserDelayingNewContext, overrideBrowser } from '../helpers/browser-proxies.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer, forwardingNavigationPacer } from '../helpers/navigation-pacer.js';
import { createRunLauncher } from '../helpers/run-harness.js';
import { createTestConfig, type TestConfigOverrides } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 180_000;
/** Interaction の候補が1つ（aria-expanded を切り替えるボタン）だけのページ。リンクはない。 */
const TOGGLE_PAGE = '/page-auditor-interaction-toggle.html';
/** Interaction の候補が複数（aria-expanded を切り替えるボタン）あるページ。リンクはない。 */
const MANY_TOGGLES_PAGE = '/page-auditor-interaction-many-toggles.html';
/**
 * 間隔のテストの、ページの読み込みの最小の間隔（ms）。幅の走査の幅と幅の間（読み込み、layout、セッションの終了と作成）は、
 * ループバックの fixture では、これより十分に短いので、少なくとも1回は待つ。
 */
const PACING_INTERVAL_MS = 1_000;
/** 幅の走査・performance・accessibility・スクリーンショットの有無（Interaction は有効）。幅は、主要な2つのビューポートの幅と違う。 */
const PACING_OVERRIDES: TestConfigOverrides = {
  crawl: { minNavigationIntervalMs: PACING_INTERVAL_MS },
  viewports: { stressWidths: [320, 768] },
  audit: { performance: false, accessibility: false, screenshots: false, interactions: true },
};

let browser: Browser;
const servers: FixtureServer[] = [];
const timedServers: LoopbackHttpServer[] = [];
const temporaryDirectories: string[] = [];
const runLaunchers: ReturnType<typeof createRunLauncher>[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftoverContexts = testContextsOf(browser);
  for (const context of leftoverContexts) {
    await context.close();
  }
  let leftoverBrowsers = 0;
  for (const launcher of runLaunchers.splice(0)) {
    leftoverBrowsers += await launcher.closeAll();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const server of timedServers.splice(0)) {
    await server.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftoverContexts, 'Contexts left in the browser after the test').toHaveLength(0);
  expect(leftoverBrowsers, 'Browsers left connected after the Run').toBe(0);
});

async function startServer(): Promise<FixtureServer> {
  const server = await startFixtureServer();
  servers.push(server);
  return server;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** テストの中だけの小さなサーバが受け取った要求。`atMs` は、サーバが要求を受け取った時刻（`Date.now()`）。 */
interface ReceivedRequest {
  readonly pathname: string;
  readonly atMs: number;
}

/**
 * `TOGGLE_PAGE` だけを、fixture と同じ本文（`fixtures/site/` のファイル）で返す、テストの中だけの小さなサーバ（RL-fix。RL の Minor-4 (b)）。
 * fixture のサーバの記録には時刻がないので、サーバの側で要求を受け取った時刻を、このサーバで記録する。ほかのパスには 404 を返す。
 */
async function startTimedTogglePageServer(): Promise<{ readonly origin: string; readonly received: readonly ReceivedRequest[] }> {
  const body = await readFile(fileURLToPath(new URL(`../../fixtures/site${TOGGLE_PAGE}`, import.meta.url)), 'utf8');
  const received: ReceivedRequest[] = [];
  const server = await startLoopbackHttpServer((request, response) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    received.push({ pathname, atMs: Date.now() });
    const found = pathname === TOGGLE_PAGE;
    response.statusCode = found ? 200 : 404;
    response.setHeader('Content-Type', found ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
    response.end(found ? body : 'not found\n');
  });
  timedServers.push(server);
  return { origin: server.origin, received };
}

/** ページの読み込み（main frame のナビゲーション）の要求。`atMs` は、Node 側で事象を受けた時刻。 */
interface DocumentRequest {
  readonly url: string;
  readonly atMs: number;
}

const isMainFrameNavigation = (request: Request): boolean => {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    // Service Worker の要求などは frame を持たない（ページの読み込みではない）。
    return false;
  }
};

/**
 * 作ったすべての Context の、ネットワークに出るページの読み込み（HTTP(S) の main frame のナビゲーション）の要求を、受けた順に
 * `requests` に記録する Browser の Proxy。`about:blank` の読み込み（環境の事実の読み取り）は、サイトに要求を送らないので記録しない。
 */
function recordingDocumentRequests(real: Browser, requests: DocumentRequest[]): Browser {
  return overrideBrowser(real, {
    newContext: async (...args: Parameters<Browser['newContext']>) => {
      const context = await real.newContext(...args);
      context.on('request', (request) => {
        if (isMainFrameNavigation(request) && /^https?:/u.test(request.url())) {
          requests.push({ url: request.url(), atMs: Date.now() });
        }
      });
      return context;
    },
  });
}

/** `pacer` の待ちを通すたびに、記録された読み込みの開始の時刻を `starts` に記録する（待ちと記録は `pacer` が行う）。 */
function recordingPacer(pacer: NavigationPacer, starts: number[]): NavigationPacer {
  return forwardingNavigationPacer(pacer, async () => {
    const waitedMs = await pacer.beforeNavigation();
    starts.push(pacer.snapshot().lastNavigationStartedAtMs ?? Number.NaN);
    return waitedMs;
  });
}

/** k 番目の要求が k 番目の開始の後に送られ、開始の間隔が `intervalMs` 以上である。 */
function expectPacedRequests(starts: readonly number[], requests: readonly DocumentRequest[], intervalMs: number): void {
  expect(requests).toHaveLength(starts.length);
  for (const [index, request] of requests.entries()) {
    const start = starts[index] ?? Number.NaN;
    expect(request.atMs, `request ${index} (${request.url}) is sent after its start`).toBeGreaterThanOrEqual(start);
    const nextStart = starts[index + 1];
    if (nextStart !== undefined) {
      expect(request.atMs, `request ${index} is sent before the next start`).toBeLessThanOrEqual(nextStart);
    }
    if (index > 0) {
      expect(start - (starts[index - 1] ?? Number.NaN), `pacer-side interval before navigation ${index}`).toBeGreaterThanOrEqual(intervalMs);
    }
  }
}

function auditedUrl(origin: string, pathname: string): NormalizedHttpUrlEvidence {
  const normalized = normalizeUrl(`${origin}${pathname}`, `${origin}${pathname}`, new Set());
  if (!normalized.ok) {
    throw new Error(`fixture URL must normalize: ${pathname}`);
  }
  return normalized.url;
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

/**
 * `auditWith` の省略できる引数。
 * - `pathname`: 監査するページ（既定は `TOGGLE_PAGE`）。
 * - `now`: Page Auditor に注入する時計（既定は `Date.now()`）。
 * - `collectors`: collector の差し替え（既定は本番の関数）。
 */
interface AuditWithOptions {
  readonly pathname?: string;
  readonly now?: () => number;
  readonly collectors?: Partial<PageAuditCollectors>;
}

async function auditWith(
  origin: string,
  config: AuditConfig,
  navigationPacer: NavigationPacer,
  targetBrowser: Browser,
  options: AuditWithOptions = {},
): Promise<PageAuditOutcome> {
  const allocator = new IdAllocator();
  const auditor = new PageAuditor({
    // 本番（Run Coordinator）と同じく、同じ pacer を factory にも渡す（Guard が送った時刻を記録する。DEF-100 fix）。
    contextFactory: new BrowserContextFactory(targetBrowser, config, () => new SafetyLedger(), { navigationPacer }),
    config,
    allocator,
    clock: () => new Date(),
    now: options.now ?? (() => Date.now()),
    screenshotRootDirectory: await temporaryDirectory('beaksight-navigation-pacing-'),
    navigationPacer,
    safetyViolationRecorded: () => false,
    ...(options.collectors === undefined ? {} : { collectors: options.collectors }),
  });
  return await auditor.audit(auditedUrl(origin, options.pathname ?? TOGGLE_PAGE), allocator.allocatePageId());
}

const deadlineReasonsOf = (outcome: PageAuditOutcome): string[] => outcome.result.incompleteReasons
  .flatMap(({ code, detail }) => (code === 'DEADLINE_EXCEEDED' || detail?.includes('DEADLINE_EXCEEDED') === true
    ? [`${code}:${detail ?? ''}`]
    : []));

/**
 * 届く間隔の test（DEF-100 fix）の、ページの読み込みの最小の間隔（ms）。Passive の監査の後の処理（固定の待ちなど。ループバックの fixture で
 * 約 1.1 s）と、遅らせた Context の作成（`DESKTOP_CONTEXT_CREATION_DELAY_MS`）を足しても、この間隔に届かないので、pacer は間隔のちょうどまで
 * 待つ。前の読み込みの要求が、その開始より遅れてサーバに届いた分だけ、開始から数える間隔ではサーバの側の間隔が短くなる（DEF-100）。
 */
const ARRIVAL_INTERVAL_MS = 3_000;
/**
 * 届く間隔の test で、Desktop の幅の Context（Desktop の Passive の監査と Interaction の候補。どちらも、間隔の待ちの後に作る）の作成を
 * 遅らせる時間（ms）。混雑した環境で Context の作成が遅い場合（DEF-100 の調査で、CLI の監査で最大約 0.7 s）を作る。ほかの幅の Context
 * （幅の走査と Mobile）は遅らせない（揺れ）。
 */
const DESKTOP_CONTEXT_CREATION_DELAY_MS = 1_200;
/** 届く間隔の test の設定（`PACING_OVERRIDES` の間隔だけを変える）。 */
const ARRIVAL_PACING_OVERRIDES: TestConfigOverrides = {
  ...PACING_OVERRIDES,
  crawl: { minNavigationIntervalMs: ARRIVAL_INTERVAL_MS },
};

/** Desktop の幅（`desktopWidth`）の Context だけ、作成を `DESKTOP_CONTEXT_CREATION_DELAY_MS` 遅らせる（`browserDelayingNewContext` に渡す）。 */
const delayingDesktopContexts = (desktopWidth: number) => (options: Parameters<Browser['newContext']>[0]): number =>
  (options?.viewport?.width === desktopWidth ? DESKTOP_CONTEXT_CREATION_DELAY_MS : 0);

/** サーバが受け取った順の要求の、受け取った時刻の間隔が、どれも `intervalMs` 以上である（許容なし。DEF-100 fix）。 */
function expectServerArrivalIntervals(received: readonly ReceivedRequest[], intervalMs: number): void {
  for (const [index, request] of received.entries()) {
    if (index > 0) {
      expect(request.atMs - (received[index - 1]?.atMs ?? Number.NaN), `server-side interval before ${request.pathname} (${index})`)
        .toBeGreaterThanOrEqual(intervalMs);
    }
  }
}

describe('Navigation pacing of a page audit (load control design 4.1)', () => {
  /**
   * サーバが受け取った文書の要求の時刻の間隔で許す、設定の間隔からの不足（ms。RL-fix。RL の Minor-4 (b)。DEF-034-fix で根拠を測り直した）。
   * DEF-100 fix から 0（許容なし）。pacer は、開始と、前の読み込みの文書の要求を送った時刻・その応答を受けた時刻（Guard が記録する）の最も遅い方
   * から間隔を数える。応答はサーバが要求を受けた後にしか来ないので、次の要求がサーバに届くのは、前の要求が届いてから必ず間隔以上後である
   * （下の「前回の遅れ」は、サーバの側の間隔を短くしない）。この名前は、ほかのテスト（`discovery-job-fork.test.ts`、`write-job-harness.ts`、
   * 画面の `discovery-secret-markers.test.ts`）が根拠として参照するので残す。以下は、DEF-100 fix の前の根拠の記録である。
   *
   * 間隔の保証そのものは、pacer の側の開始の時刻（`snapshot().lastNavigationStartedAtMs`）の間隔が設定以上であることで、
   * `expectPacedRequests` が許容なしで確かめる（主な確かめ）。この許容は、サーバの側の間隔の確かめ（従の確かめ）だけに使う。
   *
   * pacer は、待ちの終わりを読み込みの開始として記録し、要求がサーバに届くのは、その後である。「開始から届くまで」を遅れと呼ぶと、
   * サーバの側の間隔 = pacer の側の間隔 + 今回の遅れ − 前回の遅れ である。今回の遅れは 0 以上（届く時刻 ≧ 開始は別に確かめる）なので、
   * サーバの側の間隔が pacer の側の間隔より短くなる量は、前回の遅れ以下である。遅れの中身は、読み込みの種類で違う。
   * - 幅の走査の幅: セッション（Context と page）は待つ前に作るので、待った後は、読み込みの観察の開始（CDP の session と
   *   `Network.enable`）と、`goto` から要求が Guard を通ってサーバに届くまで、だけである。
   * - Passive の監査と Interaction の候補: 待った後に Context と page を作り、観察を始めてから読み込む。
   * この test で間隔のちょうどで待つのは、幅と幅の間と、幅から Interaction の候補の間で、どちらも前回は幅の走査の幅である。
   * Desktop の Passive から1つ目の幅の間と、Interaction の候補から Mobile の Passive の間は、前回の読み込みの後の処理（Passive の監査の
   * 固定の待ち、Interaction の操作と落ち着くまでの待ち）が間隔より長くかかるので、サーバの側の間隔も設定の間隔より十分に長い。
   *
   * 測った値（DEF-034-fix。2026-10-09、Windows 11、16 論理 CPU。この test を 207 回。混雑は、`tests/integration` の並行の実行
   * （最大2つ）、この test の並行の実行（最大3つ）、CPU を回し続ける 12 個の process を重ねた。最も重い混雑では、この test 1回が、
   * 混雑のないときの約 3〜6 倍の時間かかり、全体の検証の中で失敗した 4 回の不足（60〜100 ms 程度）を上回る不足を再現した）:
   * - 幅の走査の幅の遅れ: 混雑のないとき 9〜20 ms。最も重い混雑で最大 183 ms（内訳は、後の 37 回で測った。観察の開始の
   *   完了まで最大 113 ms、その後サーバに届くまで最大 77 ms）。
   * - Passive と Interaction の遅れ（Context の作成と観察の開始を含む）: 混雑のないとき 72〜113 ms、最も重い混雑で最大約 5 s。
   * - pacer の側の間隔の最小: 1,000 ms（設定どおり。設定より短い回は 0 回）。
   * - サーバの側の間隔の最小: 幅と幅の間 931 ms、幅から Interaction の候補の間 1,076 ms、Desktop の Passive から1つ目の幅の間
   *   1,204 ms、Interaction の候補から Mobile の Passive の間 1,311 ms。
   * DEF-100 fix の前の許容は、ちょうどで待つ間隔の前回（幅の走査の幅）の遅れの最大 183 ms に、余裕を足した 250 ms だった（その前の 50 ms は、
   * 混雑のないときの遅れだけを根拠にしていたので、混雑のときに足りなかった。DEF-034）。
   */
  const SERVER_ARRIVAL_DELAY_TOLERANCE_MS = 0;

  it('starts every page navigation (Passive, stress widths, Interaction candidates) at least the interval after the previous one', async () => {
    const server = await startTimedTogglePageServer();
    const config = createTestConfig(server.origin, '/', PACING_OVERRIDES);
    const pacer = createTestNavigationPacer(config);
    const starts: number[] = [];
    const requests: DocumentRequest[] = [];

    const outcome = await auditWith(server.origin, config, recordingPacer(pacer, starts), recordingDocumentRequests(browser, requests));

    // Desktop、幅の走査の2つの幅、Interaction の1つの候補、Mobile の順に読み込む。
    const pageUrl = `${server.origin}${TOGGLE_PAGE}`;
    expect(requests.map(({ url }) => url)).toEqual(Array.from({ length: 5 }, () => pageUrl));
    const received = server.received.filter(({ pathname }) => pathname === TOGGLE_PAGE);
    expect(received).toHaveLength(5);
    expect(pacer.snapshot().navigationCount).toBe(5);
    // 主な確かめ: pacer の側の開始の時刻の間隔は、設定の間隔以上である（許容なし）。要求は、それぞれの開始の後に送られる。
    expectPacedRequests(starts, requests, PACING_INTERVAL_MS);
    // 従の確かめ: サーバの側でも、文書の要求は、それぞれの読み込みの開始の後に届き、受け取った時刻の間隔は、設定の間隔から
    // 前回の読み込みの遅れの分（`SERVER_ARRIVAL_DELAY_TOLERANCE_MS` の説明を参照）を除いた長さ以上である。
    for (const [index, request] of received.entries()) {
      expect(request.atMs, `request ${index} reaches the server after its start`).toBeGreaterThanOrEqual(starts[index] ?? Number.NaN);
      if (index > 0) {
        expect(request.atMs - (received[index - 1]?.atMs ?? Number.NaN), `server-side interval before navigation ${index}`)
          .toBeGreaterThanOrEqual(PACING_INTERVAL_MS - SERVER_ARRIVAL_DELAY_TOLERANCE_MS);
      }
    }
    // 少なくとも1回は待った（幅の走査の幅と幅の間など）。
    expect(pacer.snapshot().totalWaitMs).toBeGreaterThan(0);

    expect(evidenceOf(outcome, 'interaction', 'desktop')).toHaveLength(1);
    expect(outcome.result.viewports.desktop).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
  }, TEST_TIMEOUT_MS);

  it('keeps the intervals at which the documents reach the server at least the interval when the Context creation after the wait is slow (DEF-100)', async () => {
    const server = await startTimedTogglePageServer();
    const config = createTestConfig(server.origin, '/', ARRIVAL_PACING_OVERRIDES);
    const pacer = createTestNavigationPacer(config);
    const starts: number[] = [];
    const requests: DocumentRequest[] = [];
    const slowBrowser = browserDelayingNewContext(
      recordingDocumentRequests(browser, requests),
      delayingDesktopContexts(config.viewports.primaryDesktop.width),
    );

    const outcome = await auditWith(server.origin, config, recordingPacer(pacer, starts), slowBrowser);

    // Desktop、幅の走査の2つの幅、Interaction の1つの候補、Mobile の順に読み込む。
    const received = server.received.filter(({ pathname }) => pathname === TOGGLE_PAGE);
    expect(received).toHaveLength(5);
    expectPacedRequests(starts, requests, ARRIVAL_INTERVAL_MS);
    // 主な確かめ（DEF-100 fix）: サーバに届いた文書の要求の間隔は、設定の間隔以上である（許容なし）。
    expectServerArrivalIntervals(received, ARRIVAL_INTERVAL_MS);
    expect(outcome.result.viewports.desktop).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
  }, TEST_TIMEOUT_MS);
});

// L2（設計書 4.4）: 待った時間は、ページの監査の期限を消費しない。注入した pacer が、ページの期限より長く実際に待つ。
// RL-fix（RL の Minor-4 (a)）: 期限を延ばし過ぎる誤り（例: 待った時間の2倍）も見分ける。延長の量そのものは、注入した時計（待ちの後に
// 読まれた時刻）と、期限を受け取る collector に渡された期限で確かめる。Interaction の段階は、期限で止まるはずの候補が、待った時間 +
// 期限で止まることで確かめる。
describe('Navigation pacing waits do not use up the page deadlines (load control design 4.4)', () => {
  /** Interaction の候補1つの見積もり（2,000 + 2 × 2,000）と同じ、設定の検証の境界の値のページの期限。 */
  const OVERALL_PAGE_TIMEOUT_MS = 6_000;
  /** ページの期限より長い待ち。Interaction の候補1つの見積もりよりも長い。 */
  const LONG_WAIT_MS = OVERALL_PAGE_TIMEOUT_MS + 500;
  /**
   * 期限を受け取る collector に渡す期限の、ページの期限の数え始めからの長さ（ページの期限 − collector の余裕。Page Auditor の
   * `collectorAtMs`。Task 14〜17 の設計書 4.5.7）。
   */
  const COLLECTOR_BUDGET_MS = OVERALL_PAGE_TIMEOUT_MS - COLLECTOR_DEADLINE_MARGIN_MS;
  /** 期限の確かめで使う、Interaction の候補1つの見積もりとページの期限が同じ設定（`OVERALL_PAGE_TIMEOUT_MS` の説明のとおり）。 */
  const BOUNDARY_CRAWL_TIMEOUTS = { navigationTimeoutMs: 2_000, interactionTimeoutMs: 2_000, overallPageTimeoutMs: OVERALL_PAGE_TIMEOUT_MS };

  /**
   * 呼ばれた順に `delaysMs` の時間だけ実際に待ち、その時間を返す pacer（足りない分は待たない）。待ちが終わるたびに、その待ちの順番
   * （0 から）を `onWaitEnded` に渡してから返る。
   */
  function delayingPacer(
    delaysMs: readonly number[],
    onWaitEnded: (index: number) => void = () => undefined,
  ): NavigationPacer & { readonly calls: () => number } {
    let navigationCount = 0;
    let totalWaitMs = 0;
    let lastNavigationStartedAtMs: number | null = null;
    return {
      calls: () => navigationCount,
      beforeNavigation: async () => {
        const index = navigationCount;
        const delayMs = delaysMs[index] ?? 0;
        navigationCount += 1;
        await wait(delayMs);
        totalWaitMs += delayMs;
        lastNavigationStartedAtMs = Date.now();
        onWaitEnded(index);
        return delayMs;
      },
      snapshot: () => Object.freeze({ navigationCount, totalWaitMs, lastNavigationStartedAtMs }),
      // 独立の偽物なので、最小の間隔を上げる操作（SU6）と、送った時刻の記録（DEF-100 fix）は何もしない。
      raiseMinimumInterval: () => undefined,
      recordDocumentRequestSent: () => undefined,
    };
  }

  /**
   * Page Auditor に注入する時計。`Date.now()` と同じ基準の時刻を返す（期限を判定する部品と基準をそろえる。`PageAuditorDependencies.now`）。
   * pacer の待ちが終わった後に最初に読まれた時刻を、待ちの順番ごとに `readAfterWait` に記録する。Passive の監査は、待ちの直後に
   * この時刻を読み、ページの期限を数え始める（設計書 4.4）。
   */
  function clockReadAfterWaits(): {
    readonly now: () => number;
    readonly waitEnded: (index: number) => void;
    readonly readAfterWait: ReadonlyMap<number, number>;
  } {
    const readAfterWait = new Map<number, number>();
    let pendingIndex: number | null = null;
    return {
      readAfterWait,
      waitEnded: (index) => {
        pendingIndex = index;
      },
      now: () => {
        const nowMs = Date.now();
        if (pendingIndex !== null) {
          readAfterWait.set(pendingIndex, nowMs);
          pendingIndex = null;
        }
        return nowMs;
      },
    };
  }

  /** 期限を受け取る collector に渡された期限（ms）。呼ばれた順（Desktop、Mobile の順）に記録する。 */
  interface CollectorDeadlines {
    readonly primaryLayout: number[];
    readonly stressSweep: number[];
    readonly accessibility: number[];
  }

  /** 渡された期限を `deadlines` に記録してから、本番の collector に、そのまま渡す collector。 */
  function deadlineRecordingCollectors(deadlines: CollectorDeadlines): Partial<PageAuditCollectors> {
    return {
      collectLayoutEvidence: async (page, viewport, options) => {
        deadlines.primaryLayout.push(options?.deadlineAtMs ?? Number.NaN);
        return await collectLayoutEvidence(page, viewport, options);
      },
      collectStressLayout: async (createSession, url, widths, options) => {
        deadlines.stressSweep.push(options.deadlineAtMs);
        return await collectStressLayout(createSession, url, widths, options);
      },
      collectAccessibilityEvidence: async (page, options) => {
        deadlines.accessibility.push(options?.deadlineAtMs ?? Number.NaN);
        return await collectAccessibilityEvidence(page, options);
      },
    };
  }

  it('does not expire the Passive audit, the stress sweep, or the first Interaction candidate after a wait longer than the page deadline', async () => {
    const server = await startServer();
    const config = createTestConfig(server.origin, '/', {
      crawl: BOUNDARY_CRAWL_TIMEOUTS,
      viewports: { stressWidths: [320] },
      // accessibility は、幅の走査の後の段階の期限（延ばした期限）を、渡された期限で確かめるために有効にする。
      audit: { performance: false, accessibility: true, screenshots: false, interactions: true },
    });
    // Desktop の Passive、幅の走査の幅、1件目の Interaction の候補の前に、ページの期限より長く待つ（Mobile の前は待たない）。
    const clock = clockReadAfterWaits();
    const pacer = delayingPacer([LONG_WAIT_MS, LONG_WAIT_MS, LONG_WAIT_MS], clock.waitEnded);
    const deadlines: CollectorDeadlines = { primaryLayout: [], stressSweep: [], accessibility: [] };

    const outcome = await auditWith(server.origin, config, pacer, browser, {
      now: clock.now,
      collectors: deadlineRecordingCollectors(deadlines),
    });

    expect(pacer.calls()).toBe(4);
    expect(deadlineReasonsOf(outcome)).toEqual([]);
    expect(outcome.result.viewports.desktop).toMatchObject({ status: 'AUDITED', incompleteReasons: [], navigationOutcome: 'OK' });
    const [layout] = evidenceOf(outcome, 'layout', 'desktop');
    expect(layout?.payload.stressSweep?.map(({ width, status }) => [width, status])).toEqual([[320, 'COMPLETE']]);
    // 幅の走査の後の段階も、延ばした期限で行う。
    for (const type of ['color', 'accessibility', 'link'] as const) {
      expect(evidenceOf(outcome, type, 'desktop'), type).toHaveLength(1);
    }
    const interactions = evidenceOf(outcome, 'interaction', 'desktop');
    expect(interactions).toHaveLength(1);
    expect(interactions[0]?.payload.status).toBe('VERIFIED');
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });

    // 延長の量そのもの（RL-fix）。待ちの順番は、Desktop の Passive（0）、幅の走査の幅（1）、1件目の候補（2）、Mobile の Passive（3）。
    const desktopStartMs = clock.readAfterWait.get(0) ?? Number.NaN;
    const mobileStartMs = clock.readAfterWait.get(3) ?? Number.NaN;
    // Passive: ページの期限は、待ちの後に読んだ時刻から数える（待った時間を、さらに足さない）。
    expect(deadlines.primaryLayout).toEqual([desktopStartMs + COLLECTOR_BUDGET_MS, mobileStartMs + COLLECTOR_BUDGET_MS]);
    // 幅の走査に渡す期限は、延ばす前のもの。走査の後の段階の期限は、走査の中で待った時間（1回の `LONG_WAIT_MS`）だけ延びる
    // （それより多くも少なくも延ばさない）。Mobile は幅の走査をしないので、延ばさない。
    expect(deadlines.stressSweep).toEqual([desktopStartMs + COLLECTOR_BUDGET_MS]);
    expect(deadlines.accessibility).toEqual([desktopStartMs + COLLECTOR_BUDGET_MS + LONG_WAIT_MS, mobileStartMs + COLLECTOR_BUDGET_MS]);
  }, TEST_TIMEOUT_MS);

  it('stops the Interaction stage at its deadline extended by exactly the waits, so that the next candidate does not fit', async () => {
    // 候補1つの見積もりとページの期限が同じ設定。Interaction の段階の期限（候補の発見の終わり + ページの期限）は、候補の前に待った
    // 時間の分だけ延びる。1件目の候補の前に長く待っても、2件目の候補に残る時間は「ページの期限 − 1件目の候補の時間」で、見積もり
    // より短いので、2件目は予算で止まる。段階の期限を、待った時間より多く延ばす誤り（例: 2倍）があると、1件目の前の待ちの分だけ
    // 時間が余り、2件目の候補を始めてしまう。
    const server = await startServer();
    const config = createTestConfig(server.origin, '/', {
      crawl: BOUNDARY_CRAWL_TIMEOUTS,
      viewports: { stressWidths: [320] },
      audit: { performance: false, accessibility: false, screenshots: false, interactions: true },
    });
    // 1件目の候補の前だけ、ページの期限より長く待つ（Desktop の Passive、幅の走査の幅、2件目の候補、Mobile の前は待たない）。
    const pacer = delayingPacer([0, 0, LONG_WAIT_MS]);
    const discoveredCounts: number[] = [];

    const outcome = await auditWith(server.origin, config, pacer, browser, {
      pathname: MANY_TOGGLES_PAGE,
      collectors: {
        discoverInteractionCandidates: async (page, maxDomWork) => {
          const discovered = await discoverInteractionCandidates(page, maxDomWork);
          discoveredCounts.push(discovered.candidates.length);
          return discovered;
        },
      },
    });

    const [candidateCount = 0] = discoveredCounts;
    expect(candidateCount).toBeGreaterThan(1);
    // Desktop の Passive、幅の走査の幅、1件目の候補、2件目の候補（待った後に、予算で止める）、Mobile の Passive。
    expect(pacer.calls()).toBe(5);
    expect(evidenceOf(outcome, 'interaction', 'desktop').map(({ payload }) => payload.status)).toEqual(['VERIFIED']);
    expect(outcome.result.viewports.desktop.incompleteReasons).toEqual([
      { code: 'COLLECTOR_INCOMPLETE', detail: `interaction:budget:remaining=${candidateCount - 1}` },
    ]);
    expect(outcome.result.viewports.mobile).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
  }, TEST_TIMEOUT_MS);

  it('opens the session of the next stress width after a wait in the sweep that passes the original page deadline', async () => {
    const server = await startServer();
    const config = createTestConfig(server.origin, '/', {
      crawl: { overallPageTimeoutMs: OVERALL_PAGE_TIMEOUT_MS },
      viewports: { stressWidths: [320, 768] },
      audit: { performance: false, accessibility: false, screenshots: false, interactions: false },
    });
    // 1つ目の幅の読み込みの前だけ、ページの期限より長く待つ。2つ目の幅のセッションは、その後に作る（作成の期限の上限も延ばす）。
    const pacer = delayingPacer([0, LONG_WAIT_MS]);

    const outcome = await auditWith(server.origin, config, pacer, browser);

    // Desktop、2つの幅、Mobile。
    expect(pacer.calls()).toBe(4);
    expect(deadlineReasonsOf(outcome)).toEqual([]);
    expect(outcome.result.viewports.desktop).toMatchObject({ status: 'AUDITED', incompleteReasons: [] });
    const [layout] = evidenceOf(outcome, 'layout', 'desktop');
    expect(layout?.payload.stressSweep?.map(({ width, status }) => [width, status])).toEqual([[320, 'COMPLETE'], [768, 'COMPLETE']]);
  }, TEST_TIMEOUT_MS);
});

// L2（設計書 4.1）: Run で1つの pacer が、robots.txt と sitemap.xml も含めた、すべての読み込みの前で待つ（本番の待ちを使う）。
describe('Navigation pacing of a Run (load control design 4.1)', () => {
  it('paces robots.txt, sitemap.xml and every page navigation of the Run with one pacer and the production sleep', async () => {
    const server = await startServer();
    server.resetRequestObservations();
    const requests: DocumentRequest[] = [];
    const launcher = createRunLauncher((launched) => recordingDocumentRequests(launched, requests));
    runLaunchers.push(launcher);
    const config = createTestConfig(server.origin, TOGGLE_PAGE, PACING_OVERRIDES);
    let runPacer: NavigationPacer | undefined;
    const pageStarts: number[] = [];
    /** metadata の待ちが呼ばれた時点で、サーバが受け取っていた robots.txt と sitemap.xml の要求の数。 */
    const metadataRequestsAtWaits: number[] = [];
    /** metadata の待ちが返した、待った時間。 */
    const metadataWaits: number[] = [];
    const metadataRequestCount = (): number => server.getRequestObservations()
      .filter(({ pathname }) => pathname === '/robots.txt' || pathname === '/sitemap.xml').length;

    const result = await new RunCoordinator({
      config,
      launchBrowser: launcher.launcher,
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: await temporaryDirectory('beaksight-navigation-pacing-run-'),
      collectSiteMetadata: async (options) => {
        const { beforeNavigation } = options;
        if (beforeNavigation === undefined) {
          throw new Error('the site metadata must receive the navigation pacing');
        }
        return await collectSiteMetadata({
          ...options,
          beforeNavigation: async () => {
            metadataRequestsAtWaits.push(metadataRequestCount());
            const waitedMs = await beforeNavigation();
            metadataWaits.push(waitedMs);
            return waitedMs;
          },
        });
      },
      createPageAuditor: (dependencies) => {
        runPacer = dependencies.navigationPacer;
        return new PageAuditor({ ...dependencies, navigationPacer: recordingPacer(dependencies.navigationPacer, pageStarts) });
      },
    }).run();

    const pageUrl = `${server.origin}${TOGGLE_PAGE}`;
    expect(requests.map(({ url }) => url)).toEqual([
      `${server.origin}/robots.txt`,
      `${server.origin}/sitemap.xml`,
      ...Array.from({ length: 5 }, () => pageUrl),
    ]);
    // robots.txt と sitemap.xml は、それぞれの要求の前に待つ。Run の最初の読み込み（robots.txt）は待たず、sitemap.xml は、
    // robots.txt の開始から間隔が空くまで待つ（robots.txt の取得と page の作り直しは、間隔より十分に短い）。
    expect(metadataRequestsAtWaits).toEqual([0, 1]);
    expect(metadataWaits).toHaveLength(2);
    expect(metadataWaits[0]).toBe(0);
    expect(metadataWaits[1]).toBeGreaterThan(0);
    // すべての読み込みが、Run で1つの pacer を通った。
    expect(runPacer?.snapshot().navigationCount).toBe(requests.length);
    expect(runPacer?.snapshot().totalWaitMs).toBeGreaterThan(0);
    const observed = server.getRequestObservations();
    expect(observed.filter(({ pathname }) => pathname === TOGGLE_PAGE)).toHaveLength(5);
    expect(observed.filter(({ pathname }) => pathname === '/robots.txt')).toHaveLength(1);
    expect(observed.filter(({ pathname }) => pathname === '/sitemap.xml')).toHaveLength(1);
    // ページの読み込みは、それぞれの開始の後に送られ、開始の間隔は設定以上である。
    expectPacedRequests(pageStarts, requests.slice(2), PACING_INTERVAL_MS);
    expect(result.pages.map((page) => page.status)).toEqual(['AUDITED']);
    expect(result.run.incompleteReasons.filter(({ code }) => code === 'DEADLINE_EXCEEDED')).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps the intervals at which robots.txt, sitemap.xml and every page document reach the server at least the interval (DEF-100)', async () => {
    const server = await startTimedTogglePageServer();
    const config = createTestConfig(server.origin, TOGGLE_PAGE, ARRIVAL_PACING_OVERRIDES);
    const launcher = createRunLauncher((launched) => browserDelayingNewContext(
      launched,
      delayingDesktopContexts(config.viewports.primaryDesktop.width),
    ));
    runLaunchers.push(launcher);

    const result = await new RunCoordinator({
      config,
      launchBrowser: launcher.launcher,
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: await temporaryDirectory('beaksight-navigation-arrival-run-'),
    }).run();

    // robots.txt と sitemap.xml（どちらも 404）、ページの 5 回の読み込みの順に届く。
    const received = server.received.filter(({ pathname }) => ['/robots.txt', '/sitemap.xml', TOGGLE_PAGE].includes(pathname));
    expect(received.map(({ pathname }) => pathname)).toEqual(['/robots.txt', '/sitemap.xml', ...Array.from({ length: 5 }, () => TOGGLE_PAGE)]);
    expectServerArrivalIntervals(received, ARRIVAL_INTERVAL_MS);
    expect(result.pages.map((page) => page.status)).toEqual(['AUDITED']);
  }, TEST_TIMEOUT_MS);
});
