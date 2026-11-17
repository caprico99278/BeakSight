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
// SAFE-B4: ブラウザの自身の通信の家。DEF-211（報告の送信と、ブラウザが自分で取りに行く要求）の確かめ（もとの `reporting-disabled.test.ts`）も、ここに置く。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { chromiumRunsOf, launchCliChromium, launchHeadlessChromium, launchTestDefaultChromium } from '../helpers/chromium.js';
import { settleLateDeliveries, startLoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { TEST_ONLY_GOOGLE_CONNECTION_DISABLED_FEATURES } from '../helpers/test-chromium-args.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY, TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS } from '../helpers/tls-test-certificate.js';
import {
  CHROMIUM_BROWSER_FETCH_DISABLED_FEATURES,
  CHROMIUM_CHANNEL,
  CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES,
  CHROMIUM_PRELOADING_DISABLED_FEATURES,
  CHROMIUM_REPORTING_DISABLED_FEATURES,
  PLAYWRIGHT_DEFAULT_DISABLED_FEATURES,
} from '../../src/browser/chromium-launch.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
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
/** BN-R0 の C-1: 全部の後に、遅れて届く要求を待つ上限（ms。`settleLateDeliveries`）と、1 つの場面の期限（ms）。 */
const LATE_SETTLE_MS = 1_500;
const SPECULATION_TEST_TIMEOUT_MS = 60_000;

let browser: Browser;
let server: FixtureServer;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
  // RB-4b: テストは外のインターネットへ出さないので、本番と同じ起動の部品と値に、テストだけの外へ出ない引数を足した起動（`launchCliChromium`）を使う。
  browser = await launchCliChromium();
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
    // 古い形の prefetch の要求ごとに、meter の許可 Origin への要求の数が増えた分（meter には、そのまま渡す）。DEF-241（L11）で直した: meter は応答の事象でも
    // 数える（同じ要求は 1 回だけ）ので、事象ごとでなく要求ごとに、増えた分を足す。
    const prefetchIncrements = new Map<object, number>();
    const recordObserving = (request: object, url: string, record: () => void): void => {
      const before = loadMeter.snapshot().allowedOrigins.count;
      record();
      if (new URL(url).pathname === LINK_PREFETCH_TARGET) {
        prefetchIncrements.set(request, (prefetchIncrements.get(request) ?? 0) + loadMeter.snapshot().allowedOrigins.count - before);
      }
    };
    const linkPrefetchIncrements = { get length(): number { return prefetchIncrements.size; }, values: (): number[] => [...prefetchIncrements.values()] };
    const observedMeter: LoadMeter = {
      ...loadMeter,
      recordRequestFinished: (request, url) => {
        recordObserving(request, url, () => loadMeter.recordRequestFinished(request, url));
      },
      recordRequestFailed: (request, url, errorText) => {
        recordObserving(request, url, () => loadMeter.recordRequestFailed(request, url, errorText));
      },
      recordResponseReceived: (request, url) => {
        recordObserving(request, url, () => loadMeter.recordResponseReceived(request, url));
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
      expect(linkPrefetchIncrements.values()).toEqual(Array.from({ length: linkPrefetchReceived }, () => 1));
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
    // RB-4b: 対照の Playwright の既定の起動は、Google への接続の feature が効くので、外のインターネットへ出ないよう、使われない中継と名前の解決の止めを付ける
    // （feature の値は変わらない）。
    const playwrightDefault = await chromium.launch({
      headless: true,
      channel: CHROMIUM_CHANNEL,
      args: ['--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND'],
    });
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
    // Playwright の既定の値すべて（RB-4b: Google への接続を止める feature は外した）。
    // BN-R0 の C-1 から、先読みを止める feature（`Prerender2FallbackPrefetchSpecRules`）も、同じ最後の 1 つに入る。
    const productDisabled = [
      ...PLAYWRIGHT_DEFAULT_DISABLED_FEATURES,
      ...CHROMIUM_PRELOADING_DISABLED_BY_DISABLE_FEATURES,
      // DEF-211: 報告の機能と、ブラウザが自分で取りに行く機能を止める feature も、同じ 1 つに入る。
      ...CHROMIUM_REPORTING_DISABLED_FEATURES,
      ...CHROMIUM_BROWSER_FETCH_DISABLED_FEATURES,
    ];
    // RB-4b: テストの起動は、製品の 1 つの後に、テストだけの Google への接続の止めを足した 1 つを置く（最後の 1 つが使われる）。
    expect(cliDisabledOccurrences).toEqual([
      ...defaultDisabledOccurrences,
      productDisabled,
      [...productDisabled, ...TEST_ONLY_GOOGLE_CONNECTION_DISABLED_FEATURES],
    ]);
  });
});

// BN-R0 の C-1（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` の BN-0 の独立レビュー）: speculation rules の prerender だけの指定では、
// Chromium が prerender の代わりに prefetch（`Prerender2FallbackPrefetchSpecRules`）を行い、Guard を通らない文書の要求（`Sec-Purpose: prefetch;prerender`）が
// サーバに届き、その後の移動が、その応答で main frame を移していた（読まないパス・危険な語の URL でも、止めた記録がない）。factory の Context（認証つきの監査の段の
// 除外つき）で、ページの先読みの指定の形ごとに、先読みの文書の要求がサーバに届かず、その後の移動は Guard が判定して止める（除外の URL）ことを、`chromiumRunsOf`
// の Chromium と、http・https で確かめる。SAFE-B4: (Chromium, http/https) ごとに 1 つの Chromium で、全部の形を同時に（形ごとの Context で）開き、全部の形の移動を
// 止めた記録が台帳に揃うまで poll してから、短い余白だけ待つ。閉じた後は `settleLateDeliveries` で数え直す。
// FIN-1（SD-2 の 2.4）: サイト自身の移動は止めない。確かめは「speculation rules の先読みの文書の要求（Guard を通らない）が届かない」と「移動は届き、止めた記録が
// ない」に替えた。`<link rel="prefetch">` は Guard を通るサイト自身の読み取りなので届く。
describe.each(chromiumRunsOf([
  ['the default test Chromium', (tls: boolean) => launchHeadlessChromium(tls ? { args: [...TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS] } : {})],
  ['the CLI launch of Chromium', (tls: boolean) => launchCliChromium(tls ? { args: [...TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS] } : {})],
]))('BN-R0 C-1: the speculation rules and the link prefetch of a document never bypass the Guard, with %s', (_label, launch) => {
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
  /** 全部の形の移動を止めた記録が台帳に揃うのを待つ上限（ms。揃えば、すぐに先へ進む）。 */
  const LEDGER_POLL_LIMIT_MS = 15_000;
  /** 台帳に揃った後、遅れて送られる先読みの要求を待つ余白（ms。ページは開いたままなので固定の待ち）。 */
  const AFTER_RECORDED_MS = 1_000;
  const formNames = Object.keys(FORMS);
  const targetOf = (form: string): string => `/admin/${form}/logout`;

  it.each([false, true])('all the forms opened together (https: %s)', async (tls) => {
    const received: { readonly method: string; readonly path: string; readonly purpose: string }[] = [];
    const site = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      received.push({ method: request.method ?? 'GET', path: url.pathname, purpose: String(request.headers['sec-purpose'] ?? request.headers['purpose'] ?? '-') });
      const html = (body: string): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
      };
      const form = /^\/admin\/([^/]+)\/start$/u.exec(url.pathname)?.[1];
      const preloading = form === undefined ? undefined : FORMS[form];
      if (form !== undefined && preloading !== undefined) {
        const target = targetOf(form);
        html(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>start</title>${preloading(target)}</head>`
          + `<body><main><h1>start</h1></main><script>setTimeout(() => { location.href = '${target}'; }, ${String(NAVIGATE_AFTER_MS)});</script></body></html>`);
      } else {
        html('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>target</title></head><body><p>target</p></body></html>');
      }
    }, tls ? { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } } : {});
    const tested = await launch(tls);
    try {
      const config = createTestConfig(site.origin, `/admin/${formNames[0] ?? ''}/start`);
      const factory = new BrowserContextFactory(tested, config, () => new SafetyLedger(), {
        ...TEST_FACTORY_OPTIONS,
        authentication: {
          initialState: { cookies: [], origins: [] },
          filterState: (state) => state,
          auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        },
      });
      try {
        const opened = await Promise.all(formNames.map(async (form) => {
          const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY', { pageAuditLoad: true });
          const page = await factory.createPassivePage(context);
          await page.goto(`${site.origin}/admin/${form}/start`, { waitUntil: 'load' });
          return { form, context, page, ledger: factory.getSafetyLedger(context) };
        }));
        const navigationBlocked = ({ form, ledger }: (typeof opened)[number]): boolean => ledger.snapshot().blockedAuditExclusions?.events
          .some(({ url, mainFrameNavigation }) => mainFrameNavigation && new URL(url).pathname === targetOf(form)) === true;
        // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: ページの script の移動は、読む範囲の外でも止めずに届く（全部の形で揃うまで待つ）。
        const moved = (form: string): boolean => received.some(({ path, purpose }) => path === targetOf(form) && purpose === '-');
        await expect.poll(() => formNames.filter(moved), { timeout: LEDGER_POLL_LIMIT_MS }).toEqual(formNames);
        await wait(AFTER_RECORDED_MS);
        // speculation rules の先読みの文書の要求（Guard を通らない）は、サーバに届かない。`<link rel="prefetch">` は Guard を通る読み取りで、サイト自身の要求として
        // 止めない（SD-2）。
        expect(received.filter(({ path, purpose }) => purpose !== '-' && path !== targetOf('link-prefetch-document'))).toEqual([]);
        expect(opened.filter(navigationBlocked).map(({ form }) => form)).toEqual([]);
        for (const { form, ledger } of opened) {
          expect(ledger.snapshot().invariantViolations, form).toEqual([]);
        }
        for (const { context } of opened) {
          await factory.closePassiveContext(context);
        }
      } finally {
        await factory.close();
      }
      await settleLateDeliveries(LATE_SETTLE_MS, site);
      expect(received.filter(({ path, purpose }) => purpose !== '-' && path !== targetOf('link-prefetch-document'))).toEqual([]);
    } finally {
      await tested.close();
      await site.close();
    }
  }, SPECULATION_TEST_TIMEOUT_MS);
});

/** DEF-211: 報告の宛先の path の頭。ページもほかの要求も、この path を使わないので、ここに届いたら、報告の送信と分かる。 */
const REPORT_ENDPOINT_PREFIX = '/reports/';
/** 報告を受ける期間（秒）。`Report-To`・`NEL` の `max_age`。 */
const REPORT_POLICY_MAX_AGE_S = 86_400;
/** CSP の `img-src 'self'` に反する画像（ネットワークに出ない `data:` の URL）。 */
const CSP_VIOLATING_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
/**
 * ページを読み込んだ後、報告が送られるのを待つ時間（ms。ページは開いたままなので固定の待ち。全部の形を同時に開いて 1 回だけ）。feature のない CLI の Chromium
 * では、報告は CSP の違反から約 1 秒の後に届いた（Chromium 151、この PC での実測。SREV-1105-2 の実験では 3 秒の待ちで届いた）。
 */
const REPORT_SETTLE_MS = 6_000;
/** ページの script の後、ブラウザが取りに行くのを待つ時間（ms。全部の場面を同時に開いて 1 回だけ）。feature のない CLI の Chromium では、1 秒以内に届いた。 */
const BROWSER_FETCH_SETTLE_MS = 4_000;
/** 全部（Context を閉じた）の後に、遅れて届く要求を待つ上限（ms。`settleLateDeliveries`）。 */
const LATE_REPORT_SETTLE_MS = 3_000;

interface ReportingForm {
  /** ページの応答に付けるヘッダ（`endpoint` は、この形の報告の宛先の URL）。 */
  readonly headers: (endpoint: string) => Readonly<Record<string, string>>;
  /** CSP の違反を起こすか（起こす形は、ページの事象で違反を確かめる）。 */
  readonly cspViolation: boolean;
}

/** 報告が出る形（SREV-1105-2 の実験の形と、古いヘッダの形、NEL）。 */
const REPORTING_FORMS: Readonly<Record<string, ReportingForm>> = Object.freeze({
  'reporting-endpoints': {
    headers: (endpoint) => ({ 'content-security-policy': "img-src 'self'; report-to e", 'reporting-endpoints': `e="${endpoint}"` }),
    cspViolation: true,
  },
  'report-to-header': {
    headers: (endpoint) => ({
      'content-security-policy': "img-src 'self'; report-to g",
      'report-to': JSON.stringify({ group: 'g', max_age: REPORT_POLICY_MAX_AGE_S, endpoints: [{ url: endpoint }] }),
    }),
    cspViolation: true,
  },
  'network-error-logging': {
    headers: (endpoint) => ({
      'report-to': JSON.stringify({ group: 'n', max_age: REPORT_POLICY_MAX_AGE_S, endpoints: [{ url: endpoint }] }),
      nel: JSON.stringify({ report_to: 'n', max_age: REPORT_POLICY_MAX_AGE_S, success_fraction: 1, failure_fraction: 1 }),
    }),
    cspViolation: false,
  },
});

/**
 * DEF-211 の棚卸し: ページの代わりにブラウザが自分で取りに行く機能（`CHROMIUM_BROWSER_FETCH_DISABLED_FEATURES`）の場面。feature を入れる前の CLI の Chromium では、
 * FedCM は設定の URL・`/.well-known/web-identity`・アカウントの宛先を、Payment Request は支払い方法の URL（HEAD）と manifest を、Guard の route を通らずに
 * 取りに行った。どの場面も、ページの script の結果（API が見えないこと）を `window.__s` に置く。
 */
const BROWSER_FETCH_SCENES: Readonly<Record<string, { readonly script: string; readonly apiName: string }>> = Object.freeze({
  fedcm: {
    script: "window.__s = typeof IdentityCredential; navigator.credentials.get({ identity: { providers: [{ configURL: location.origin + '/fetches/fedcm-config.json', clientId: '1' }] } }).catch(() => undefined);",
    apiName: 'IdentityCredential',
  },
  payment: {
    script: "window.__s = typeof PaymentRequest; try { new PaymentRequest([{ supportedMethods: location.origin + '/fetches/pay-method' }], { total: { label: 't', amount: { currency: 'JPY', value: '1' } } }).canMakePayment().catch(() => undefined); } catch {}",
    apiName: 'PaymentRequest',
  },
  'protected-audience': {
    script: "window.__s = typeof navigator.joinAdInterestGroup; try { navigator.joinAdInterestGroup({ owner: location.origin, name: 'g', biddingLogicURL: location.origin + '/fetches/bid.js', updateURL: location.origin + '/fetches/update' }, 86400).catch(() => undefined); } catch {}",
    apiName: 'navigator.joinAdInterestGroup',
  },
});

describe('the reporting feature list (DEF-211)', () => {
  it('names the Reporting API, the document reporting and the Network Error Logging', () => {
    expect(CHROMIUM_REPORTING_DISABLED_FEATURES).toEqual(['Reporting', 'DocumentReporting', 'NetworkErrorLogging']);
  });

  it('names FedCM, Payment Request and Protected Audience as the fetches of the browser itself', () => {
    expect(CHROMIUM_BROWSER_FETCH_DISABLED_FEATURES).toEqual(['FedCm', 'WebPayments', 'AdInterestGroupAPI', 'Fledge']);
  });
});

// DEF-211（安全のレビュー SREV-1105-2）: Chromium 自身の報告の機能（Reporting API と NEL）の送信と、ブラウザが自分で取りに行く要求（FedCM・Payment Request・
// Protected Audience）は、ページの外（ブラウザのネットワークの処理）から出るので、Guard（CDP と route）を通らず、記録もなくサーバに届く。CLI の Chromium は、
// feature を入れる前に送っていた（テストの既定の headless shell は送らなかった）。起動の `--disable-features` に止める feature を入れたので、届かないことを、
// Guard の付いた factory の Context で確かめる（https だけ。http のページでは報告そのものが出ない）。SAFE-B4: 1 つの Chromium で、全部の形（場面）を同時に
// 形ごとの Context で開き、待ちは開いたままの 1 回と、閉じた後の `settleLateDeliveries` の 1 回だけ。CSP の違反が起きたこと（報告の元があったこと）は、ページの
// `securitypolicyviolation` の事象で確かめる。
describe.each(chromiumRunsOf([
  ['the default test Chromium', () => launchTestDefaultChromium({ args: [...TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS] })],
  ['the CLI launch of Chromium', () => launchCliChromium({ args: [...TEST_BROWSER_IGNORE_CERTIFICATE_ERRORS_ARGS] })],
]))('DEF-211: Chromium itself sends no reports and fetches nothing around the Guard, with %s', (_label, launch: () => Promise<Browser>) => {
  it('sends no reports for any reporting form', async () => {
    const received: { readonly method: string; readonly path: string }[] = [];
    const site = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const path = new URL(request.url ?? '/', 'https://127.0.0.1').pathname;
      received.push({ method: request.method ?? 'GET', path });
      const formName = /^\/reporting\/([^/]+)\/start$/u.exec(path)?.[1];
      const form = formName === undefined ? undefined : REPORTING_FORMS[formName];
      if (formName !== undefined && form !== undefined) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...form.headers(`${site.origin}${REPORT_ENDPOINT_PREFIX}${formName}`) });
        response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>start</title>'
          + '<script>window.__violations = 0; document.addEventListener("securitypolicyviolation", () => { window.__violations += 1; });</script></head>'
          + `<body><main><h1>start</h1></main>${form.cspViolation ? `<img alt="" src="${CSP_VIOLATING_IMAGE}">` : ''}`
          + `<img alt="" src="/reporting/${formName}/pixel"></body></html>`);
        return;
      }
      if (path.startsWith(REPORT_ENDPOINT_PREFIX)) {
        response.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
        }).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store' }).end();
    }, { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } });
    const reports = (): string[] => received.filter(({ path }) => path.startsWith(REPORT_ENDPOINT_PREFIX)).map(({ method, path }) => `${method} ${path}`);
    const tested = await launch();
    try {
      const config = createTestConfig(site.origin, '/reporting/');
      const factory = new BrowserContextFactory(tested, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
      try {
        const opened = await Promise.all(Object.entries(REPORTING_FORMS).map(async ([formName, form]) => {
          const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
          const page = await factory.createPassivePage(context);
          const response = await page.goto(`${site.origin}/reporting/${formName}/start`, { waitUntil: 'load' });
          expect(response?.status(), formName).toBe(200);
          // NEL は、方針を受けた後の要求について報告する。方針を受けた後に、同じページをもう一度読み込む。
          if (!form.cspViolation) {
            await page.reload({ waitUntil: 'load' });
          }
          return { formName, form, context, page };
        }));
        await wait(REPORT_SETTLE_MS);
        for (const { formName, form, context, page } of opened) {
          if (form.cspViolation) {
            // 報告の元（CSP の違反）は、たしかに起きた。
            expect(await page.evaluate(() => (window as unknown as { __violations: number }).__violations), formName).toBeGreaterThan(0);
          }
          expect(factory.getSafetyLedger(context).snapshot().invariantViolations, formName).toEqual([]);
        }
        expect(reports()).toEqual([]);
        for (const { context } of opened) {
          await factory.closePassiveContext(context);
        }
      } finally {
        await factory.close();
      }
    } finally {
      await tested.close();
    }
    try {
      await settleLateDeliveries(LATE_REPORT_SETTLE_MS, site);
      expect(reports()).toEqual([]);
    } finally {
      await site.close();
    }
  }, SPECULATION_TEST_TIMEOUT_MS);

  it('fetches nothing for FedCM, Payment Request and Protected Audience', async () => {
    const received: string[] = [];
    const site = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      const path = new URL(request.url ?? '/', 'https://127.0.0.1').pathname;
      received.push(`${request.method ?? 'GET'} ${path}`);
      const scene = BROWSER_FETCH_SCENES[/^\/fetches\/([^/]+)\/start$/u.exec(path)?.[1] ?? ''];
      if (scene !== undefined) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>start</title></head><body><main><h1>start</h1></main><script>${scene.script}</script></body></html>`);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    }, { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } });
    // サーバに届くのは、場面ごとのページの文書だけ。
    const onlyStartDocuments = Object.keys(BROWSER_FETCH_SCENES).map((sceneName) => `GET /fetches/${sceneName}/start`).sort();
    const tested = await launch();
    try {
      const config = createTestConfig(site.origin, '/fetches/');
      const factory = new BrowserContextFactory(tested, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
      try {
        const opened = await Promise.all(Object.entries(BROWSER_FETCH_SCENES).map(async ([sceneName, scene]) => {
          const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
          const page = await factory.createPassivePage(context);
          const response = await page.goto(`${site.origin}/fetches/${sceneName}/start`, { waitUntil: 'load' });
          expect(response?.status(), sceneName).toBe(200);
          return { scene, context, page };
        }));
        await wait(BROWSER_FETCH_SETTLE_MS);
        for (const { scene, context, page } of opened) {
          // 機能の API が、ページから見えない（止まっている）。
          expect(await page.evaluate(() => (window as unknown as { __s: string }).__s), scene.apiName).toBe('undefined');
          expect(factory.getSafetyLedger(context).snapshot().invariantViolations, scene.apiName).toEqual([]);
        }
        expect([...received].sort()).toEqual(onlyStartDocuments);
        for (const { context } of opened) {
          await factory.closePassiveContext(context);
        }
      } finally {
        await factory.close();
      }
    } finally {
      await tested.close();
    }
    try {
      await settleLateDeliveries(LATE_REPORT_SETTLE_MS, site);
      expect([...received].sort()).toEqual(onlyStartDocuments);
    } finally {
      await site.close();
    }
  }, SPECULATION_TEST_TIMEOUT_MS);
});
