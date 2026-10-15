// T25b（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.2、6 章）: ログインの段の Guard の指定
// （`PassiveRequestGuardOptions.loginStage`）。本物の Guard と、127.0.0.1 の fixture のサーバ（`tests/helpers/login-fixture-server.ts`）で確かめる。
// - 許すのは、許した Origin と path への、main frame のナビゲーションの POST だけ（回数の上限まで。route と CDP の層で二重に数えない）。
// - ほかの非読み取りの要求（fetch の POST、ナビゲーションでない POST、別の Origin への POST、pagehide の beacon と keepalive）、WebSocket、
//   Service Worker、許した POST の後の別の Origin への 303、上限を超えた POST、307 でやり直す POST、サブ frame の POST、別の path への
//   POST は、サーバに届かない。違反は 0。
// - 指定を外した Context では、ログインのフォームの再送信が届かない。
// - Chromium は headless だけ。テストの既定（headless shell）と、CLI の起動の設定（`launchCliChromium`）の両方で確かめる。
// - 資格情報は fixture が起動のたびに作る仮の値で、テストは入力の欄に入れるだけ（出力しない）。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  type GuardLoginStage,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { QUIET_PERIOD_MS } from '../helpers/gate-harness.js';
import {
  LOGIN_FIXTURE_PATHS,
  LOGIN_NEXT_IDP_QUERY,
  startLoginFixtureServer,
  type LoginFixtureRequest,
  type LoginFixtureServer,
} from '../helpers/login-fixture-server.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
/** ページの中の試み（fetch など）の結果を待つ上限（ms）。止められた要求は、すぐに失敗する。 */
const IN_PAGE_ATTEMPT_TIMEOUT_MS = 2_000;
/** ナビゲーションの結果（読み込みか、止められた失敗）を待つ上限（ms）。 */
const NAVIGATION_SETTLE_TIMEOUT_MS = 5_000;
/** 全部の試みの後に、閉じた後に遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;

interface ChromiumLaunch {
  readonly name: string;
  launch(): Promise<Browser>;
}

const CHROMIUM_LAUNCHES: readonly ChromiumLaunch[] = [
  { name: 'the headless shell (test default)', launch: () => launchHeadlessChromium() },
  { name: 'the CLI Chromium (launchCliChromium, headless)', launch: () => launchCliChromium() },
];

/** サーバに届いた、GET と HEAD 以外の要求（WebSocket の upgrade を含む）。 */
const nonReadRequests = (requests: readonly LoginFixtureRequest[]): string[] => requests
  .filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD')
  .map((entry) => `${entry.site} ${entry.method} ${entry.path}`);

/** サーバに届いた、別の Origin（B）への要求。 */
const siteBRequests = (requests: readonly LoginFixtureRequest[]): string[] => requests
  .filter((entry) => entry.site === 'B')
  .map((entry) => `${entry.method} ${entry.path}`);

describe.each(CHROMIUM_LAUNCHES)('T25b: the login stage of the Guard, with $name', ({ name, launch }) => {
  let browser: Browser;
  let server: LoginFixtureServer;
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterAll(async () => {
    await browser?.close();
  });

  beforeEach(async () => {
    server = await startLoginFixtureServer();
  });

  afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    }
    await server?.close();
  });

  const loginStage = (maxLoginPosts: number, paths: readonly string[] = [LOGIN_FIXTURE_PATHS.login]): GuardLoginStage => ({
    loginPostEndpoints: paths.map((path) => ({ origin: server.originA, path })),
    maxLoginPosts,
  });

  /** 本物の Guard を付けた Context と page（factory と同じ Context の作り方）。`stage` を省略すると、今の公開監査と同じ。 */
  const openGuarded = async (stage?: GuardLoginStage): Promise<{ readonly page: Page; readonly ledger: SafetyLedger }> => {
    const context = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block', acceptDownloads: false });
    contexts.push(context);
    const ledger = new SafetyLedger();
    await installPassiveRequestGuard(context, ledger, new Set([server.originA]), stage === undefined ? {} : { loginStage: stage });
    const page = await context.newPage();
    await awaitPassiveRequestGuardReady(page);
    return { page, ledger };
  };

  /** ログインの画面（`formPath`）を開き、資格情報を入れて送る。結果の読み込みか失敗を待つ。 */
  const submitLogin = async (page: Page, formPath: string = LOGIN_FIXTURE_PATHS.login): Promise<void> => {
    await page.goto(`${server.originA}${formPath}`);
    await server.fillCredentials((selector, value) => page.fill(selector, value));
    await Promise.all([
      page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#go'),
    ]);
    await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
    await wait(QUIET_PERIOD_MS);
  };

  it('the login form POST reaches the server, and no other non-read request, WebSocket or Service Worker does (E9)', async () => {
    const { page, ledger } = await openGuarded(loginStage(1));

    await submitLogin(page);
    expect(new URL(page.url()).pathname).toBe(LOGIN_FIXTURE_PATHS.admin);
    await expect(page.textContent('#admin-ok')).resolves.toBe('ADMIN-OK');
    expect(server.successfulLogins).toBe(1);

    const outcome = await page.evaluate(async ({ originB, paths, timeoutMs }) => {
      const results: Record<string, string> = {};
      const attempt = async (key: string, run: () => Promise<unknown>): Promise<void> => {
        try {
          const value = await Promise.race([
            run(),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
          ]);
          results[key] = `ok ${String((value as { status?: number } | null)?.status ?? value)}`;
        } catch (error) {
          results[key] = `error ${(error as Error).name}`;
        }
      };
      await attempt('fetchPostUpdate', () => fetch(paths.adminUpdate, { method: 'POST', body: 'x' }));
      await attempt('fetchPostLogin', () => fetch(paths.login, { method: 'POST', body: 'x' }));
      await attempt('xhrPostLogin', () => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', paths.login);
        xhr.onload = () => resolve(xhr.status);
        xhr.onerror = () => reject(new Error('xhr'));
        xhr.send('x');
      }));
      await attempt('fetchPostOtherOrigin', () => fetch(`${originB}${paths.collect}`, { method: 'POST', body: 'x', mode: 'no-cors' }));
      await attempt('webSocket', () => new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}${paths.webSocket}`);
        socket.onopen = () => resolve('open');
        socket.onerror = () => reject(new Error('error'));
        socket.onclose = () => reject(new Error('close'));
      }));
      await attempt('serviceWorker', () => ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker, paths.serviceWorker));
      addEventListener('pagehide', () => {
        navigator.sendBeacon(paths.beacon, 'x');
        void fetch(paths.keepalive, { method: 'POST', body: 'x', keepalive: true });
      });
      return results;
    }, { originB: server.originB, paths: LOGIN_FIXTURE_PATHS, timeoutMs: IN_PAGE_ATTEMPT_TIMEOUT_MS });
    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.blank}`);
    const navigationToOtherOrigin = await page.goto(`${server.originB}${LOGIN_FIXTURE_PATHS.blank}`)
      .then(() => 'loaded', () => 'blocked');
    await wait(LATE_DELIVERY_SETTLE_MS);
    console.info(`T25b E9 (${name}): page ${JSON.stringify(outcome)}; server ${JSON.stringify(server.requests)}`);

    expect(Object.values(outcome).every((result) => result.startsWith('error'))).toBe(true);
    expect(navigationToOtherOrigin).toBe('blocked');
    expect(nonReadRequests(server.requests)).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
    expect(siteBRequests(server.requests)).toEqual([]);
    expect(server.requests.some((entry) => entry.path.startsWith(LOGIN_FIXTURE_PATHS.serviceWorker))).toBe(false);
    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedWebSockets).toHaveLength(1);
    expect(snapshot.blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname} ${entry.reason}`).sort()).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.adminUpdate} NON_READ_METHOD`,
      `POST ${LOGIN_FIXTURE_PATHS.beacon} NON_READ_METHOD`,
      `POST ${LOGIN_FIXTURE_PATHS.collect} NON_READ_METHOD`,
      `POST ${LOGIN_FIXTURE_PATHS.keepalive} NON_READ_METHOD`,
      `POST ${LOGIN_FIXTURE_PATHS.login} NON_READ_METHOD`,
      `POST ${LOGIN_FIXTURE_PATHS.login} NON_READ_METHOD`,
    ].sort());
    expect(snapshot.blockedNavigations.map((entry) => `${entry.method} ${entry.url} ${entry.reason}`)).toEqual([
      `GET ${server.originB}${LOGIN_FIXTURE_PATHS.blank} EXTERNAL_MAIN_FRAME_NAVIGATION`,
    ]);
  });

  it('counts each allowed POST once across the route and CDP layers: two posts reach with a limit of 2, and the third does not', async () => {
    const { page, ledger } = await openGuarded(loginStage(2));

    await submitLogin(page);
    await submitLogin(page);
    await submitLogin(page);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(nonReadRequests(server.requests)).toEqual([
      `A POST ${LOGIN_FIXTURE_PATHS.login}`,
      `A POST ${LOGIN_FIXTURE_PATHS.login}`,
    ]);
    expect(server.successfulLogins).toBe(2);
    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname} ${entry.reason}`)).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.login} NON_READ_METHOD`,
    ]);
  });

  it('blocks the login POST beyond the limit of 1, without a violation', async () => {
    const { page, ledger } = await openGuarded(loginStage(1));

    await submitLogin(page);
    await submitLogin(page);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(nonReadRequests(server.requests)).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.login}`,
    ]);
  });

  it('stops the 303 to another origin after the allowed POST by the main frame rule', async () => {
    const { page, ledger } = await openGuarded(loginStage(1));

    await submitLogin(page, `${LOGIN_FIXTURE_PATHS.login}${LOGIN_NEXT_IDP_QUERY}`);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(server.successfulLogins).toBe(1);
    expect(nonReadRequests(server.requests)).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}${LOGIN_NEXT_IDP_QUERY}`]);
    expect(siteBRequests(server.requests)).toEqual([]);
    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedNavigations.map((entry) => `${entry.method} ${entry.url} ${entry.reason}`)).toEqual([
      `GET ${server.originB}${LOGIN_FIXTURE_PATHS.idpLanding} EXTERNAL_MAIN_FRAME_NAVIGATION`,
    ]);
  });

  it('counts the POST that a 307 repeats: with a limit of 1, the repeated POST does not reach the server', async () => {
    const { page, ledger } = await openGuarded(loginStage(1, [LOGIN_FIXTURE_PATHS.login307]));

    await submitLogin(page, LOGIN_FIXTURE_PATHS.login307Form);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(nonReadRequests(server.requests)).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login307}`]);
    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}${new URL(entry.url).search}`)).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.login307}?again=1`,
    ]);
  });

  it('blocks the login form POST of a sub frame, and a main frame form POST to a path that is not allowed', async () => {
    const { page, ledger } = await openGuarded(loginStage(3));

    await page.goto(`${server.originA}${LOGIN_FIXTURE_PATHS.framedLogin}`);
    const frame = page.frameLocator('#login-frame');
    await server.fillCredentials((selector, value) => frame.locator(selector).fill(value));
    await frame.locator('#go').click();
    await wait(LATE_DELIVERY_SETTLE_MS);
    expect(nonReadRequests(server.requests)).toEqual([]);

    await submitLogin(page);
    expect(new URL(page.url()).pathname).toBe(LOGIN_FIXTURE_PATHS.admin);
    await Promise.all([
      page.waitForEvent('requestfailed', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#update'),
    ]);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(nonReadRequests(server.requests)).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
    const snapshot = ledger.snapshot();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.login}`,
      `POST ${LOGIN_FIXTURE_PATHS.adminUpdate}`,
    ]);
  });

  it('a Context without the login stage does not deliver the login form POST (the permission is not carried over)', async () => {
    const loginContext = await openGuarded(loginStage(1));
    await submitLogin(loginContext.page);
    expect(server.successfulLogins).toBe(1);

    const { page, ledger } = await openGuarded();
    await submitLogin(page);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(nonReadRequests(server.requests)).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
    expect(server.successfulLogins).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname} ${entry.reason}`)).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.login} NON_READ_METHOD`,
    ]);
  });
});
