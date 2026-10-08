// DEF-042（設計書 `2026-10-08-beaksight-def-042-guard-fetch-all-design.md`）: ページを離れるときの送信（`pagehide` の `sendBeacon`、
// keepalive の `fetch`、`fetchLater()`）は、CDP の `Fetch.requestPaused` に `networkId` なしで来て、Playwright が route を呼ばずに通す。
// Guard は、CDP の Fetch の横取りを、すべての要求の Request の段階に広げて、これらを止める。
// - Chromium は headless だけで起動する。テストの既定（headless shell。`launchHeadlessChromium`）と、CLI の起動の設定
//   （`chromiumLaunchOptions`。`chrome.exe` の新しい headless）の両方で確かめる（漏れは、どちらでも起きた）。
// - 127.0.0.1 の fixture のサーバだけを使う。別のプロセスの iframe（OOPIF）は、`--site-per-process` と、同じサーバの別のホスト名
//   （`localhost`）で作る。
// - 場面: Passive でページ自身が同じ Origin へ移る、`fetchLater()`、Guard が許可 Origin の外への main frame の移動を止めた後、
//   Interaction の凍結の前、OOPIF の自己移動。どれも、サーバに届かず、`blockedRequests` に残り、違反 0。対照は、Guard なしで届く。
// - 記録は 1 要求につき 1 回（CDP の段階と route の両方で記録しない）。route が見た要求は、検証の記録のために出力する。
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { chromiumLaunchOptions } from '../../src/browser/chromium-launch.js';
import type { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { Viewport } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchHeadlessChromium, oopifTargetUrls, SITE_PER_PROCESS_ARGS } from '../helpers/chromium.js';
import { crossSiteFramePath, crossSiteOriginOf, NAVIGATION_TARGET_PAGE } from '../helpers/external-scheme-fixture.js';
import {
  createGateFactory,
  leaveUnguardedUnloadBeaconPage,
  NO_NON_READ_REQUESTS,
  openGuardedPassiveSession,
  openInteractionSessionBeforeFreeze,
  openServerWindow,
  pageUrlIs,
  QUIET_PERIOD_MS,
  readFetchLaterState,
  runGuardedSelfNavigationRounds,
  UNLOAD_BEACON_FETCH_LATER_PAGE,
  UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS,
  UNLOAD_BEACON_TARGET_PATH,
  unloadBeaconSelfNavigationPath,
  type SelfNavigationRounds,
} from '../helpers/gate-harness.js';

const viewport: Viewport = Object.freeze({ width: 900, height: 700 });
/** DEF-042 の設計書 2.4: 700 個の画像を一度に読む fixture（`fixtures/site/`）と、その画像のパス。 */
const MANY_RESOURCES_PAGE = '/many-resources.html';
const MANY_RESOURCES_IMAGE_PATH = '/unsized-image.svg';
/** fixture が読む資源の数の下限（設計書 2.4 の「600 以上」。実際の数は fixture の `data-total` から読む）。 */
const MANY_RESOURCES_MIN_COUNT = 600;
/** 700 個の画像の読み込みを待つ上限（ms）と、そのテストの期限（ms）。負荷の高い環境でも終わる余裕を取った値で、製品の値ではない。 */
const MANY_RESOURCES_LOAD_TIMEOUT_MS = 20_000;
const MANY_RESOURCES_TEST_TIMEOUT_MS = 40_000;
/** DEF-042 の設計書 2.4: 別のホスト名へ、独自ヘッダつきの GET（事前確認が要る）と単純な GET を行う fixture と、単純な GET の先。 */
const CORS_PREFLIGHT_PAGE = '/cors-preflight-fetch.html';
const CORS_SIMPLE_TARGET_PAGE = '/popup-target.html';

/** Chromium の起動の仕方（名前と、追加の引数を受けて起動する関数）。 */
interface ChromiumLaunch {
  readonly name: string;
  launch(extraArgs: readonly string[]): Promise<Browser>;
}

const CHROMIUM_LAUNCHES: readonly ChromiumLaunch[] = [
  {
    name: 'the headless shell (test default)',
    launch: (extraArgs) => launchHeadlessChromium({ args: extraArgs }),
  },
  {
    name: 'the CLI Chromium (chromiumLaunchOptions, headless)',
    launch: (extraArgs) => {
      const options = chromiumLaunchOptions({ headless: true });
      return chromium.launch({ ...options, args: [...(options.args ?? []), ...extraArgs] });
    },
  },
];

/** 回ごとの結果を、検証の記録のために出力する（既定の報告では、PASS したテストの出力は表示されない）。 */
function logRounds(label: string, { rounds }: SelfNavigationRounds): void {
  console.info(`DEF-042 ${label}: ${JSON.stringify(rounds.map((round) => ({
    round: round.round,
    delivered: round.delivered,
    blockedRequests: round.blockedRequests.map((entry) => `${entry.method} ${entry.url} ${entry.reason}`),
    blockedNavigations: round.blockedNavigations.map((entry) => `${entry.method} ${entry.url} ${entry.reason}`),
    violations: round.invariantViolations,
    pageUrl: round.pageUrl,
  })))}`);
}

describe.each(CHROMIUM_LAUNCHES)('DEF-042: the leaving requests of a page that navigates itself are stopped by the Guard, with $name', ({ name, launch }) => {
  let server: FixtureServer;
  let browser: Browser;
  /** `--site-per-process` の Chromium（OOPIF の場面だけで使う）。 */
  let isolatedBrowser: Browser;
  let factory: BrowserContextFactory;
  let isolatedFactory: BrowserContextFactory;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    server = await startFixtureServer();
    browser = await launch([]);
    isolatedBrowser = await launch(SITE_PER_PROCESS_ARGS);
    factory = createGateFactory(browser, server.origin);
    isolatedFactory = createGateFactory(isolatedBrowser, server.origin);
  });

  afterAll(async () => {
    await browser?.close();
    await isolatedBrowser?.close();
    await server?.close();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const context of contexts.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    }
  });

  const urlOf = (path: string): string => `${server.origin}${path}`;

  it('Passive: the page leaves by itself to the same site; the pagehide beacon and keepalive POST never reach the server, are recorded, and there is no violation', async () => {
    const result = await runGuardedSelfNavigationRounds(
      () => openGuardedPassiveSession(factory, viewport),
      server,
      unloadBeaconSelfNavigationPath('same-site'),
      pageUrlIs(urlOf(NAVIGATION_TARGET_PAGE)),
    );
    logRounds(`Passive same-site (${name})`, result);

    expect(result.failedRounds).toEqual([]);
    expect(result.rounds.every((round) => round.blockedRequests.every((entry) => (
      entry.method === 'POST' && entry.url === urlOf(UNLOAD_BEACON_TARGET_PATH) && entry.reason === 'NON_READ_METHOD'
    )))).toBe(true);
    expect(result.allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(result.allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS);

  it('Passive: the fetchLater() POST scheduled by the page never reaches the server when the page leaves by itself, and is recorded', async () => {
    const result = await runGuardedSelfNavigationRounds(
      () => openGuardedPassiveSession(factory, viewport),
      server,
      UNLOAD_BEACON_FETCH_LATER_PAGE,
      pageUrlIs(urlOf(NAVIGATION_TARGET_PAGE)),
    );
    logRounds(`Passive fetchLater (${name})`, result);

    expect(result.failedRounds).toEqual([]);
    expect(result.rounds.every((round) => round.blockedRequests.every((entry) => (
      entry.method === 'POST' && entry.url === urlOf(UNLOAD_BEACON_TARGET_PATH) && entry.reason === 'NON_READ_METHOD'
    )))).toBe(true);
    expect(result.allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(result.allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS);

  it('Passive: after the Guard blocks the main frame navigation outside the allowed Origin, the leaving POST never reaches the allowed Origin (experiment 7)', async () => {
    const crossSiteTarget = `${crossSiteOriginOf(server.origin)}${NAVIGATION_TARGET_PAGE}`;
    const result = await runGuardedSelfNavigationRounds(
      () => openGuardedPassiveSession(factory, viewport),
      server,
      unloadBeaconSelfNavigationPath('cross-site'),
      (_page, ledger) => ledger.snapshot().blockedNavigations.length > 0,
    );
    logRounds(`Passive blocked cross-site navigation (${name})`, result);

    expect(result.failedRounds).toEqual([]);
    expect(result.rounds.map((round) => round.blockedNavigations)).toEqual(result.rounds.map(() => [
      { method: 'GET', url: crossSiteTarget, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' },
    ]));
    expect(result.allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(result.allRoundsWindow.count('GET', NAVIGATION_TARGET_PAGE)).toBe(0);
    expect(result.allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS);

  it('Interaction (before the freeze): the page leaves by itself; the leaving POST never reaches the server and is recorded (experiment 4)', async () => {
    const result = await runGuardedSelfNavigationRounds(
      () => openInteractionSessionBeforeFreeze(factory, viewport),
      server,
      unloadBeaconSelfNavigationPath('same-site'),
      pageUrlIs(urlOf(NAVIGATION_TARGET_PAGE)),
    );
    logRounds(`Interaction before freeze (${name})`, result);

    expect(result.failedRounds).toEqual([]);
    expect(result.rounds.every((round) => round.blockedRequests.every((entry) => (
      entry.method === 'POST' && entry.url === urlOf(UNLOAD_BEACON_TARGET_PATH) && entry.reason === 'NON_READ_METHOD'
    )))).toBe(true);
    expect(result.allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(result.allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS);

  it('Passive OOPIF (--site-per-process): the localhost iframe leaves by itself; its leaving POST never reaches the server and is recorded (experiment 6)', async () => {
    const crossSiteOrigin = crossSiteOriginOf(server.origin);
    const frameTarget = `${crossSiteOrigin}${NAVIGATION_TARGET_PAGE}`;
    let oopifObserved = false;
    const result = await runGuardedSelfNavigationRounds(
      () => openGuardedPassiveSession(isolatedFactory, viewport),
      server,
      crossSiteFramePath(unloadBeaconSelfNavigationPath('same-site')),
      (page) => page.frames().some((frame) => frame.url() === frameTarget),
      {
        inspect: async () => {
          oopifObserved ||= (await oopifTargetUrls(isolatedBrowser)).some((url) => url.startsWith(`${crossSiteOrigin}/`));
        },
      },
    );
    logRounds(`Passive OOPIF (${name})`, result);

    expect(oopifObserved).toBe(true);
    expect(result.failedRounds).toEqual([]);
    expect(result.rounds.every((round) => round.blockedRequests.every((entry) => (
      entry.method === 'POST' && entry.url === `${crossSiteOrigin}${UNLOAD_BEACON_TARGET_PATH}` && entry.reason === 'NON_READ_METHOD'
    )))).toBe(true);
    expect(result.allRoundsWindow.count(null, UNLOAD_BEACON_TARGET_PATH)).toBe(0);
    expect(result.allRoundsWindow.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
  }, UNLOAD_BEACON_SELF_NAVIGATION_TEST_TIMEOUT_MS);

  /**
   * 記録は 1 要求につき 1 回: ページが読み込みの間に送る POST（fetch）、POST（sendBeacon）、PUT、DELETE の 4 件が、CDP の段階と route の
   * 両方で記録されない。route が見た要求（Guard の route の処理に渡ったもの）は、CDP の段階と route の順の記録のために出力する。
   */
  it('Passive: each blocked non-read request is recorded exactly once between the CDP stage and the route', async () => {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const routed: string[] = [];
    const originalRoute = context.route.bind(context);
    vi.spyOn(context, 'route').mockImplementation((pattern, handler, options) => originalRoute(pattern, (route) => {
      routed.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return handler(route, route.request());
    }, options));
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(context, ledger, new Set([server.origin]));
    const page: Page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    const window = openServerWindow(server);

    await page.goto(urlOf('/page-auditor-non-read-requests.html'), { waitUntil: 'load' });
    await expect.poll(() => ledger.snapshot().blockedRequests.length).toBeGreaterThanOrEqual(4);
    await wait(QUIET_PERIOD_MS);
    console.info(`DEF-042 requests seen by the route (${name}): ${JSON.stringify(routed)}`);

    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequestsByMethod).toEqual({ POST: 2, PUT: 1, DELETE: 1 });
    expect(snapshot.blockedRequests).toHaveLength(4);
    expect(snapshot.blockedRequests.every((entry) => entry.url === urlOf(UNLOAD_BEACON_TARGET_PATH) && entry.reason === 'NON_READ_METHOD')).toBe(true);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
    expect(window.requestLines()).toEqual(['GET /page-auditor-non-read-requests.html']);
  });

  /**
   * DEF-042 の設計書 2.4（Guard の作業の上限）: すべての要求が Guard の作業になるので、700 個の画像を一度に読むページでも、要求の横取りの
   * 作業の上限（`MAX_PENDING_GUARD_REQUEST_TASKS`）を超えず（`GUARD_TASK_LIMIT_REACHED` にならず）、違反 0 で読める。
   */
  it('Passive: a page that loads 700 images at once is loaded with no violation (the Guard request task limit is not reached)', async () => {
    const session = await openGuardedPassiveSession(factory, viewport);
    const window = openServerWindow(server);
    try {
      await session.page.goto(urlOf(MANY_RESOURCES_PAGE), { waitUntil: 'load' });
      const total = Number(await session.page.evaluate(() => document.documentElement.dataset['total']));
      expect(total).toBeGreaterThanOrEqual(MANY_RESOURCES_MIN_COUNT);
      await expect.poll(
        () => session.page.evaluate(() => Number(document.documentElement.dataset['settled'])),
        { timeout: MANY_RESOURCES_LOAD_TIMEOUT_MS },
      ).toBe(total);
      await wait(QUIET_PERIOD_MS);

      expect(session.ledger.snapshot().invariantViolations).toEqual([]);
      expect(session.ledger.snapshot().blockedRequests).toEqual([]);
      expect(window.count('GET', MANY_RESOURCES_IMAGE_PATH)).toBe(total);
    } finally {
      expect(await session.close()).toEqual([]);
    }
  }, MANY_RESOURCES_TEST_TIMEOUT_MS);

  /**
   * DEF-042 の設計書 2.4（CORS の事前確認）: 許可 Origin の外（同じサーバの別のホスト名）への、独自ヘッダつきの GET の事前確認（OPTIONS）は、
   * Guard が Playwright と同じく 204 で満たし、サーバに届かず、記録しない。本体の GET は進み、サーバに届く。単純な GET も今までどおり届く。
   * fixture のサーバは CORS の応答のヘッダ（`Access-Control-Allow-Origin`）を返さないので、ページのスクリプトからは本体の応答を読めず、
   * fetch は失敗する（ブラウザが応答をページに渡さない）。届いたことは、サーバの記録（GET が 1 件、OPTIONS が 0 件）で確かめる。
   * ページの側の結果は、検証の記録のために出力する。
   */
  it('Passive: the CORS preflight of a cross-origin GET with a custom header is answered by the Guard, never reaches the server, and is not recorded; the GET itself reaches the server', async () => {
    const session = await openGuardedPassiveSession(factory, viewport);
    const window = openServerWindow(server);
    try {
      await session.page.goto(urlOf(CORS_PREFLIGHT_PAGE), { waitUntil: 'load' });
      await expect.poll(() => session.page.evaluate(() => document.documentElement.dataset['done'])).toBe('1');
      await wait(QUIET_PERIOD_MS);
      const outcome = await session.page.evaluate(() => ({
        preflighted: document.documentElement.dataset['preflighted'],
        simple: document.documentElement.dataset['simple'],
      }));
      console.info(`DEF-042 CORS preflight (${name}): page outcome ${JSON.stringify(outcome)}; server ${JSON.stringify(window.requestLines())}`);

      expect(window.count('OPTIONS', NAVIGATION_TARGET_PAGE)).toBe(0);
      expect(window.count('GET', NAVIGATION_TARGET_PAGE)).toBe(1);
      expect(window.count('GET', CORS_SIMPLE_TARGET_PAGE)).toBe(1);
      expect(window.nonReadCounters()).toEqual(NO_NON_READ_REQUESTS);
      expect(session.ledger.snapshot().blockedRequests).toEqual([]);
      expect(session.ledger.snapshot().invariantViolations).toEqual([]);
    } finally {
      expect(await session.close()).toEqual([]);
    }
  });

  it('control: without the Guard, the same page leaving by itself delivers POST /__mutation', async () => {
    const window = await leaveUnguardedUnloadBeaconPage(
      browser,
      server,
      viewport,
      unloadBeaconSelfNavigationPath('same-site'),
      pageUrlIs(urlOf(NAVIGATION_TARGET_PAGE)),
    );

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
  });

  it('control: without the Guard, the fetchLater() POST is scheduled and delivered when the page leaves by itself', async () => {
    const window = await leaveUnguardedUnloadBeaconPage(
      browser,
      server,
      viewport,
      UNLOAD_BEACON_FETCH_LATER_PAGE,
      pageUrlIs(urlOf(NAVIGATION_TARGET_PAGE)),
      { afterDomContentLoaded: async (page) => expect(await readFetchLaterState(page)).toBe('scheduled') },
    );

    expect(window.count('POST', UNLOAD_BEACON_TARGET_PATH)).toBeGreaterThan(0);
  });
});
