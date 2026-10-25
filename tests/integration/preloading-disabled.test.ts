// DEF-023（サイトへの負荷の制御の設計書 4.9）: CLI の Chromium の起動（`PRODUCTION_RUN_DEPENDENCIES.launchBrowser`）は、ページの先読みを
// 止める。先読みの要求は、Guard の route も、読み込みの間隔（NavigationPacer）も、負荷の記録（LoadMeter）も通らずに、サイトに届くため
// である。fixture のページ（`fixtures/site/preloading/index.html`）は、speculation rules の prefetch と prerender（すぐに行う設定）と、
// 古い形の先読み（`<link rel="prefetch">`、`<link rel="prerender">`）を持つ。先読みの対象のページは、ほかのどこからも読み込まないので、
// サーバに届いたら、先読みによる要求と分かる。Chromium の版が変わって起動の引数が効かなくなったら、このテストで気づく。
// 古い形の prefetch（`<link rel="prefetch">`）は、起動の引数では止められない。ページが読み込む画像などと同じく、Guard の route を通る
// （Guard に見えている）ことと、Run と同じ作りの Context（Guard と LoadMeter の付いた factory の Context）で、負荷の記録（LoadMeter）の
// 許可 Origin への要求の数に入ることを確かめる（R8）。
// 先読みを止める引数は `--enable-features` なので、CLI の起動が、Playwright の既定の feature の指定を変えないことも確かめる（最後の describe）。
// DEF-070: Google への接続を止める引数は `--disable-features` なので、Playwright の既定の値をすべて含むことも、最後の describe で確かめる。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from '../helpers/tls-test-certificate.js';
import {
  CHROMIUM_CHANNEL,
  CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES,
  CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES,
  CHROMIUM_PRELOADING_DISABLED_FEATURES,
  PLAYWRIGHT_DEFAULT_DISABLED_FEATURES,
} from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { PRODUCTION_RUN_DEPENDENCIES } from '../../src/cli/run-command.js';
import { wait } from '../../src/core/deadline.js';
import { createLoadMeter, type LoadMeter } from '../../src/crawl/load-meter.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  type GuardResourceDelivery,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { closePassiveResources } from '../helpers/passive-cleanup.js';
import { createTestConfig } from '../helpers/test-config.js';

/** 先読みの指定だけを持つ、fixture のページ。 */
const PRELOADING_PAGE = '/preloading/index.html';
/** speculation rules の prefetch と prerender の対象のページ。 */
const SPECULATION_RULES_TARGETS = Object.freeze(['/preloading/prefetch-target.html', '/preloading/prerender-target.html']);
/** 古い形の prerender（`<link rel="prerender">`）の対象のページ。 */
const LINK_PRERENDER_TARGET = '/preloading/link-prerender-target.html';
/** 古い形の prefetch（`<link rel="prefetch">`）の対象のページ。 */
const LINK_PREFETCH_TARGET = '/preloading/link-prefetch-target.html';
/**
 * ページの読み込みの後、先読みが起きるのを待つ時間（ms）。先読みの引数のない起動では、すべての先読みの要求が、ページの文書の要求から
 * 約30ms以内にサーバに届いた（Chromium 151、この PC での実測）。遅い環境でも見逃さないよう、その100倍の時間を待つ。
 */
const PRELOADING_SETTLE_MS = 3_000;
/** BN-R0 の C-1: 全部の後に、遅れて届く要求を待つ時間（ms）と、1 つの場面の期限（ms）。 */
const LATE_SETTLE_MS = 1_500;
const SPECULATION_TEST_TIMEOUT_MS = 60_000;

let browser: Browser;
let server: FixtureServer;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
  browser = await PRODUCTION_RUN_DEPENDENCIES.launchBrowser({ headless: true });
});

afterEach(async () => {
  for (const context of contexts.splice(0)) {
    await context.close();
  }
  server.resetRequestObservations();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** サーバが受けた要求のうち、パスが `pathname` のものの件数。 */
function receivedCount(pathname: string): number {
  return server.getRequestObservations().filter((observation) => observation.pathname === pathname).length;
}

/** 先読みの対象のページへの要求が、1件も届いていないこと（古い形の prefetch を除く）。 */
function expectNoPreloadingRequests(): void {
  for (const pathname of [...SPECULATION_RULES_TARGETS, LINK_PRERENDER_TARGET]) {
    expect(receivedCount(pathname), `requests for ${pathname}`).toBe(0);
  }
}

describe('the CLI launch of Chromium does not preload other pages (DEF-023)', () => {
  it('sends no speculation rules prefetch or prerender, nor link rel=prerender, and still loads the page itself', async () => {
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();

    const response = await page.goto(`${server.origin}${PRELOADING_PAGE}`, { waitUntil: 'load' });
    await wait(PRELOADING_SETTLE_MS);

    expect(response?.status()).toBe(200);
    expect(receivedCount(PRELOADING_PAGE)).toBe(1);
    expectNoPreloadingRequests();
  });

  it('in a Guarded Context, too, and the link rel=prefetch request goes through the Guard route', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const ledger = new SafetyLedger();
    // Guard は、許可した（ALLOW）、ナビゲーションでない要求だけを、届け方の部品に尋ねる。尋ねられた URL は、Guard の route を通った要求である。
    const askedUrls: string[] = [];
    const resourceDelivery: GuardResourceDelivery = {
      decide: (request) => {
        askedUrls.push(request.url);
        return { kind: 'NETWORK' };
      },
      beforeServeFromRunCache: () => undefined,
      afterWithhold: () => undefined,
    };
    await installPassiveRequestGuard(context, ledger, new Set([server.origin]), { resourceDelivery });
    try {
      const page = await context.newPage();
      await awaitPassiveRequestGuardReady(page);

      const response = await page.goto(`${server.origin}${PRELOADING_PAGE}`, { waitUntil: 'load' });
      await wait(PRELOADING_SETTLE_MS);

      expect(response?.status()).toBe(200);
      expect(receivedCount(PRELOADING_PAGE)).toBe(1);
      expectNoPreloadingRequests();
      // 古い形の prefetch がサーバに届いた分は、すべて Guard の route を通っている。
      const askedForLinkPrefetch = askedUrls.filter((url) => new URL(url).pathname === LINK_PREFETCH_TARGET).length;
      expect(askedForLinkPrefetch).toBe(receivedCount(LINK_PREFETCH_TARGET));
      expect(ledger.snapshot().invariantViolations).toEqual([]);
    } finally {
      await closePassiveGuardedContext(context);
    }
  });

  // R8（DEF-023 の報告の発見事項3。サイトへの負荷の制御の設計書 4.5、4.9）: 古い形の prefetch の要求は、Run と同じ作りの Context（Guard と
  // LoadMeter の付いた、`BrowserContextFactory` の Context）で、負荷の記録の許可 Origin への要求の数に入る（ページが読み込む画像などと同じ）。
  it('counts the link rel=prefetch request in the requests to the allowed origins of the LoadMeter, in a Context of the factory', async () => {
    const config = createTestConfig(server.origin, PRELOADING_PAGE);
    const loadMeter = createLoadMeter({ allowedOrigins: config.site.allowedOrigins, now: () => Date.now() });
    // 古い形の prefetch の要求の終わりの事象ごとに、meter の許可 Origin への要求の数が増えた分（meter には、そのまま渡す）。
    const linkPrefetchIncrements: number[] = [];
    const recordObserving = (url: string, record: () => void): void => {
      const before = loadMeter.snapshot().allowedOrigins.count;
      record();
      if (new URL(url).pathname === LINK_PREFETCH_TARGET) {
        linkPrefetchIncrements.push(loadMeter.snapshot().allowedOrigins.count - before);
      }
    };
    const observedMeter: LoadMeter = {
      ...loadMeter,
      recordRequestFinished: (request, url) => {
        recordObserving(url, () => loadMeter.recordRequestFinished(request, url));
      },
      recordRequestFailed: (request, url, errorText) => {
        recordObserving(url, () => loadMeter.recordRequestFailed(request, url, errorText));
      },
    };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { loadMeter: observedMeter });
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);
    try {
      const response = await page.goto(`${server.origin}${PRELOADING_PAGE}`, { waitUntil: 'load' });
      await wait(PRELOADING_SETTLE_MS);

      expect(response?.status()).toBe(200);
      expectNoPreloadingRequests();
      // 古い形の prefetch の要求は、サーバに届き、届いた分の終わりの事象が、どれも許可 Origin への要求として1件ずつ数えられた。
      const linkPrefetchReceived = receivedCount(LINK_PREFETCH_TARGET);
      expect(linkPrefetchReceived).toBeGreaterThan(0);
      await expect.poll(() => linkPrefetchIncrements.length).toBe(linkPrefetchReceived);
      expect(linkPrefetchIncrements).toEqual(Array.from({ length: linkPrefetchReceived }, () => 1));
      // サーバが受けた要求（ページと、古い形の prefetch）は、すべて負荷の記録に数えられた。
      await expect.poll(() => loadMeter.snapshot().allowedOrigins.count).toBe(server.getRequestObservations().length);
      expect(loadMeter.snapshot().otherOrigins.count).toBe(0);
      expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
    } finally {
      await closePassiveResources({ factory, context, page });
    }
  });
});

/**
 * Browser の実際の起動の引数（`chrome://version` の「Command Line」）のうち、`--<name>=` の値を、現れた順に返す
 * （例: `--enable-features` の値の一覧）。値は `,` で区切った一覧なので、区切って返す。
 */
async function featureSwitchValues(target: Browser, name: string): Promise<string[][]> {
  const context = await target.newContext();
  try {
    const page = await context.newPage();
    await page.goto('chrome://version');
    const commandLine = (await page.locator('#command_line').textContent()) ?? '';
    const prefix = `--${name}=`;
    return commandLine.split(/\s+/u)
      .filter((argument) => argument.startsWith(prefix))
      .map((argument) => argument.slice(prefix.length).split(','));
  } finally {
    await context.close();
  }
}

/** 同じ switch が複数あると、Chromium は最後の1つだけを使う（DEF-023 で確かめた）。その値（なければ空）。 */
function effectiveSwitchValue(occurrences: readonly string[][]): readonly string[] {
  return occurrences.at(-1) ?? [];
}

// DEF-023: 先読みを止める引数は `--enable-features` なので、Playwright が自分で加える `--enable-features` を上書きする（Chromium は最後の
// 1つだけを使う）。CLI の起動が、Playwright の既定の feature の指定（`--enable-features` と `--disable-features`）を変えないことを、
// 引数を渡さない起動（Playwright の既定）と比べて確かめる。Playwright の版が変わって既定が変わったら、ここで気づく。
// DEF-070: Google への接続を止める引数は `--disable-features` なので、同じく Playwright が自分で加える `--disable-features` を上書きする。
// CLI の起動の `--disable-features` は、Playwright の既定の1つと、その後の CLI の1つ（Playwright の既定の値すべてと、Google への接続を
// 止める feature）だけで、ほかの `--disable-features` の引数がないことを確かめる。Playwright の既定の値を写した定数
// （`PLAYWRIGHT_DEFAULT_DISABLED_FEATURES`）が、実際の既定と同じであることも確かめる（版が変わって既定が変わったら、ここで気づく）。
describe('the CLI launch of Chromium keeps the features Playwright enables and disables by default (DEF-023, DEF-070)', () => {
  it('enables the default features of Playwright and the preloading ones, and disables the default ones of Playwright and the Google services ones', async () => {
    const playwrightDefault = await chromium.launch({ headless: true, channel: CHROMIUM_CHANNEL });
    let defaultEnabled: readonly string[];
    let defaultDisabledOccurrences: readonly string[][];
    try {
      defaultEnabled = effectiveSwitchValue(await featureSwitchValues(playwrightDefault, 'enable-features'));
      defaultDisabledOccurrences = await featureSwitchValues(playwrightDefault, 'disable-features');
    } finally {
      await playwrightDefault.close();
    }

    const cliEnabled = effectiveSwitchValue(await featureSwitchValues(browser, 'enable-features'));
    const cliDisabledOccurrences = await featureSwitchValues(browser, 'disable-features');

    expect([...cliEnabled].sort()).toEqual([...defaultEnabled, ...CHROMIUM_PRELOADING_DISABLED_FEATURES].sort());
    // Playwright の既定の `--disable-features` は1つだけで、値は定数と同じ（並びも同じ）。
    expect(defaultDisabledOccurrences).toEqual([[...PLAYWRIGHT_DEFAULT_DISABLED_FEATURES]]);
    // CLI の起動の `--disable-features` は、Playwright の既定の1つと、最後の CLI の1つだけ。最後の1つ（Chromium が使う値）は、
    // Playwright の既定の値すべてと、Google への接続を止める feature。
    // BN-R0 の C-1 から、先読みを止める feature（`Prerender2FallbackPrefetchSpecRules`）も、同じ最後の 1 つに入る。
    expect(cliDisabledOccurrences).toEqual([
      ...defaultDisabledOccurrences,
      [...PLAYWRIGHT_DEFAULT_DISABLED_FEATURES, ...CHROMIUM_GOOGLE_SERVICES_DISABLED_FEATURES, ...CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES],
    ]);
  });
});

// BN-R0 の C-1（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` の BN-0 の独立レビュー）: speculation rules の prerender だけの指定では、
// Chromium が prerender の代わりに prefetch（`Prerender2FallbackPrefetchSpecRules`）を行い、Guard を通らない文書の要求（`Sec-Purpose: prefetch;prerender`）が
// サーバに届き、その後の移動が、その応答で main frame を移していた（読まないパス・危険な語の URL でも、止めた記録がない）。factory の Context（認証つきの監査の段の
// 除外つき）で、ページの先読みの指定の形ごとに、先読みの文書の要求がサーバに届かず、その後の移動は Guard が判定して止める（除外の URL）ことを、両方の Chromium
// （CLI の起動と、テストの既定の headless shell）と、http・https で確かめる。全部の後に名前つきの時間だけ待ってから数え直す。
describe.each([
  ['the CLI launch of Chromium', (tls: boolean) => launchCliChromium(tls ? { args: [...TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS] } : {})],
  ['the default test Chromium', (tls: boolean) => launchHeadlessChromium(tls ? { args: [...TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS] } : {})],
] as const)('BN-R0 C-1: the speculation rules and the link prefetch of a document never bypass the Guard, with %s', (_label, launch) => {
  /** 先読みの指定の形（`target` は、先読みと移動の先の、除外に当たる URL の path）。 */
  const FORMS: Readonly<Record<string, (target: string) => string>> = Object.freeze({
    'prerender-immediate': (target) => `<script type="speculationrules">{"prerender":[{"source":"list","urls":["${target}"],"eagerness":"immediate"}]}</script>`,
    'prerender-eager': (target) => `<script type="speculationrules">{"prerender":[{"source":"list","urls":["${target}"],"eagerness":"eager"}]}</script>`,
    'prefetch-immediate': (target) => `<script type="speculationrules">{"prefetch":[{"source":"list","urls":["${target}"],"eagerness":"immediate"}]}</script>`,
    'document-rules': (target) => `<script type="speculationrules">{"prerender":[{"source":"document","where":{"href_matches":"${target}"},"eagerness":"immediate"}],`
      + `"prefetch":[{"source":"document","where":{"href_matches":"${target}"},"eagerness":"immediate"}]}</script><a href="${target}">next</a>`,
    'link-prefetch-document': (target) => `<link rel="prefetch" as="document" href="${target}">`,
  });
  /** 先読みが起きるのを待ってから、移動する（ms）。 */
  const NAVIGATE_AFTER_MS = 2_000;
  const SETTLE_MS = 4_000;

  it.each(Object.keys(FORMS).flatMap((form) => [[form, false], [form, true]] as const))('%s (https: %s)', async (form, tls) => {
    const target = `/admin/${form}/logout`;
    const received: { readonly method: string; readonly path: string; readonly purpose: string }[] = [];
    const site = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      received.push({ method: request.method ?? 'GET', path: url.pathname, purpose: String(request.headers['sec-purpose'] ?? request.headers['purpose'] ?? '-') });
      const html = (body: string): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
      };
      if (url.pathname === `/admin/${form}/start`) {
        html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>start</title>${FORMS[form]?.(target) ?? ''}</head>`
          + `<body><main><h1>start</h1></main><script>setTimeout(() => { location.href = '${target}'; }, ${String(NAVIGATE_AFTER_MS)});</script></body></html>`);
      } else {
        html('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>target</title></head><body><p>target</p></body></html>');
      }
    }, tls ? { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } } : {});
    const tested = await launch(tls);
    try {
      const config = createTestConfig(site.origin, `/admin/${form}/start`);
      const factory = new BrowserContextFactory(tested, config, () => new SafetyLedger(), {
        ...TEST_FACTORY_OPTIONS,
        authentication: {
          initialState: { cookies: [], origins: [] },
          filterState: (state) => state,
          auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        },
      });
      try {
        const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
        const page = await factory.createPassivePage(context);
        await page.goto(`${site.origin}/admin/${form}/start`, { waitUntil: 'load' });
        await wait(SETTLE_MS);
        const snapshot = factory.getSafetyLedger(context).snapshot();
        // 先読みの文書の要求も、移動の文書の要求も、サーバに届かない。移動は、Guard が判定して止め、記録する。
        expect(received.filter(({ path }) => path === target)).toEqual([]);
        expect(received.filter(({ purpose }) => purpose !== '-')).toEqual([]);
        expect(new URL(page.url()).pathname).not.toBe(target);
        expect(snapshot.blockedAuditExclusions?.events.some(({ url, mainFrameNavigation }) => mainFrameNavigation && new URL(url).pathname === target)).toBe(true);
        expect(snapshot.invariantViolations).toEqual([]);
        // BN-R1 の M-2: 止めた先読みの要求（`<link rel="prefetch">`）の記録には、先読みの印（`speculative: true`）が付く。移動の記録には付かない。
        const preloadRows = snapshot.blockedAuditExclusions?.events.filter(({ url, mainFrameNavigation }) => !mainFrameNavigation && new URL(url).pathname === target) ?? [];
        if (form === 'link-prefetch-document') {
          expect(preloadRows.length).toBeGreaterThan(0);
          expect(preloadRows.every(({ speculative }) => speculative === true)).toBe(true);
        }
        expect(snapshot.blockedAuditExclusions?.events.filter(({ mainFrameNavigation }) => mainFrameNavigation).every(({ speculative }) => speculative === undefined)).toBe(true);
        await factory.closePassiveContext(context);
      } finally {
        await factory.close();
      }
      await wait(LATE_SETTLE_MS);
      expect(received.filter(({ path }) => path === target)).toEqual([]);
    } finally {
      await tested.close();
      await site.close();
    }
  }, SPECULATION_TEST_TIMEOUT_MS);
});
