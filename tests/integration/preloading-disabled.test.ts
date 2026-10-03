// DEF-023（サイトへの負荷の制御の設計書 4.9）: CLI の Chromium の起動（`PRODUCTION_RUN_DEPENDENCIES.launchBrowser`）は、ページの先読みを
// 止める。先読みの要求は、Guard の route も、読み込みの間隔（NavigationPacer）も、負荷の記録（LoadMeter）も通らずに、サイトに届くため
// である。fixture のページ（`fixtures/site/preloading/index.html`）は、speculation rules の prefetch と prerender（すぐに行う設定）と、
// 古い形の先読み（`<link rel="prefetch">`、`<link rel="prerender">`）を持つ。先読みの対象のページは、ほかのどこからも読み込まないので、
// サーバに届いたら、先読みによる要求と分かる。Chromium の版が変わって起動の引数が効かなくなったら、このテストで気づく。
// 古い形の prefetch（`<link rel="prefetch">`）は、起動の引数では止められない。ページが読み込む画像などと同じく、Guard の route を通る
// （Guard に見えている）ことと、Run と同じ作りの Context（Guard と LoadMeter の付いた factory の Context）で、負荷の記録（LoadMeter）の
// 許可 Origin への要求の数に入ることを確かめる（R8）。
// 先読みを止める引数は `--enable-features` なので、CLI の起動が、Playwright の既定の feature の指定を変えないことも確かめる（最後の describe）。
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { CHROMIUM_CHANNEL, CHROMIUM_PRELOADING_DISABLED_FEATURES } from '../../src/browser/chromium-launch.js';
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
describe('the CLI launch of Chromium keeps the features Playwright enables and disables by default (DEF-023)', () => {
  it('enables the default features of Playwright and the preloading ones, and disables the default ones of Playwright', async () => {
    const playwrightDefault = await chromium.launch({ headless: true, channel: CHROMIUM_CHANNEL });
    let defaultEnabled: readonly string[];
    let defaultDisabled: readonly string[];
    try {
      defaultEnabled = effectiveSwitchValue(await featureSwitchValues(playwrightDefault, 'enable-features'));
      defaultDisabled = effectiveSwitchValue(await featureSwitchValues(playwrightDefault, 'disable-features'));
    } finally {
      await playwrightDefault.close();
    }

    const cliEnabled = effectiveSwitchValue(await featureSwitchValues(browser, 'enable-features'));
    const cliDisabled = effectiveSwitchValue(await featureSwitchValues(browser, 'disable-features'));

    expect([...cliEnabled].sort()).toEqual([...defaultEnabled, ...CHROMIUM_PRELOADING_DISABLED_FEATURES].sort());
    expect(cliDisabled).toEqual(defaultDisabled);
  });
});
