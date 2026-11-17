// ログインの段の Guard の結合の家（SLIM WP1。ログインの段の Guard の「結合 1」。単体 1 は `request-policy-login-stage`・`request-policy-script-login`・
// `login-credential-guard`・`login-stage-blocked-requests`）。前の guard-script-login・guard-login-credential・guard-login-credential-leaks・
// login-stage-context（Shared Worker の自己検査）をまとめた。本物の Guard と factory と、127.0.0.1 の fixture のサイトで確かめる。Chromium は
// `BOTH_CHROMIUM_LAUNCHERS`（SLIM-B0: 区切りの回は CLI の起動の設定の 1 つ。安全の不具合の束では両方）で、describe ごとに 1 つ起こして共有する。
// 資格情報は fixture が起動のたびに作る仮の値か匿名の仮の値で、出力しない。
// 1. T25b（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.2、6 章）: フォームの送信のログインの段の指定
//    （`PassiveRequestGuardOptions.loginStage`。サイトは `tests/helpers/login-fixture-server.ts` を describe で共有する）。
//    - 許すのは、許した Origin と path への、main frame のナビゲーションの POST だけ（回数の上限まで。route と CDP の層で二重に数えない）。
//    - ほかの非読み取りの要求（fetch の POST、ナビゲーションでない POST、別の Origin への POST、pagehide の beacon と keepalive）、WebSocket、
//      Service Worker、許した POST の後の別の Origin への 303、上限を超えた POST、307 でやり直す POST、サブ frame の POST、別の path への
//      POST は、サーバに届かない。違反は 0。
//    - 指定を外した Context では、ログインのフォームの再送信が届かない。
// 2. T25d: Worker の自己検査がログインの段の Context にもかかる（Shared Worker を作ると `SHARED_WORKER_OBSERVED` を記録して閉じる）。
// 3. T34b・T34e（Task 34 の設計書 3.3、3.5、4 章、5 章の 2・3）: スクリプトで送るログイン（`scriptRequest`）で、登録した token の送信と、登録した
//    ログインに伴う送信だけを通す。敵対的な形（2 回目の token・別の grant・登録のない Origin・余分な POST・token の更新・beacon と文書の POST・
//    登録のない手続き）は届かない。止めた一覧は URL の値・本文・秘密の目印を持たない。形の違う指定と、認証つきの factory からは Context を作らない。
// 4. T36b（Task 36 の設計書 3.3・3.4・4 章・5 章の 3）: 資格情報の守り（`credentialGuard`）。資格情報を運ぶ登録の付随の送信と、既定の GET の
//    フォームの送信が届かない。符号化の網羅と token の応答の状態の分け方は単体 `login-credential-guard.test.ts`。
// 5. T36R-fix（T36R の C-1・C-2・I-1・M-8）: ヘッダ・Cookie・ブラウザが % の形にする URL のパスワードが届かない。止めた一覧に載せない。
//    ユーザー名は読み取りでない要求だけで比べる。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { wait } from '../../src/core/deadline.js';
import { createLoginCredentialGuard, type LoginCredentialGuard } from '../../src/safety/login-credential-guard.js';
import {
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
  LoginStageMonitor,
  type GuardLoginSideRequest,
  type GuardLoginStage,
} from '../../src/safety/passive-request-guard.js';
import { SCRIPT_LOGIN_BLOCK_REASONS, type ScriptLoginBlockReason } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS, closeTestContexts, testContextsOf } from '../helpers/chromium.js';
import {
  LEAK_SITE_PATHS,
  LEAK_SITE_PCT_WRAPPED_PATH,
  recordCarries,
  startCredentialLeakSite,
  type CredentialLeakSite,
  type LeakSiteScenario,
} from '../helpers/credential-leak-site.js';
import { QUIET_PERIOD_MS, sharedWorkerPostsPath } from '../helpers/gate-harness.js';
import {
  LOGIN_FIXTURE_PATHS,
  LOGIN_NEXT_IDP_QUERY,
  startLoginFixtureServer,
  type LoginFixtureRequest,
  type LoginFixtureServer,
} from '../helpers/login-fixture-server.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_REFRESH_LOOP_COUNT,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaAuthSiteRequest,
  type SpaSideRequestBody,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';

const VIEWPORT = Object.freeze({ width: 900, height: 700 });
/** ページの中の試み（fetch など）の結果を待つ上限（ms）。止められた要求は、すぐに失敗する。 */
const IN_PAGE_ATTEMPT_TIMEOUT_MS = 2_000;
/** ナビゲーションの結果（読み込みか、止められた失敗）を待つ上限（ms）。 */
const NAVIGATION_SETTLE_TIMEOUT_MS = 5_000;
/** 全部の試みの後に、閉じた後に遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 1_000;

/** サーバに届いた、GET と HEAD 以外の要求（WebSocket の upgrade を含む）。 */
const nonReadRequests = (requests: readonly LoginFixtureRequest[]): string[] => requests
  .filter((entry) => entry.method !== 'GET' && entry.method !== 'HEAD')
  .map((entry) => `${entry.site} ${entry.method} ${entry.path}`);

/** サーバに届いた、別の Origin（B）への要求。 */
const siteBRequests = (requests: readonly LoginFixtureRequest[]): string[] => requests
  .filter((entry) => entry.site === 'B')
  .map((entry) => `${entry.method} ${entry.path}`);

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T25b: the login stage of the Guard, with %s', (name, launch) => {
  let browser: Browser;
  let server: LoginFixtureServer;
  const contexts: BrowserContext[] = [];
  /** サイトは describe で 1 つを共有する。場面の数えは、場面の初めの記録の数と成功の数からの差で読む。 */
  let requestBase = 0;
  let loginBase = 0;
  const requestsSince = (): readonly LoginFixtureRequest[] => server.requests.slice(requestBase);
  const loginsSince = (): number => server.successfulLogins - loginBase;

  beforeAll(async () => {
    browser = await launch();
    server = await startLoginFixtureServer();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  beforeEach(() => {
    requestBase = server.requests.length;
    loginBase = server.successfulLogins;
  });

  afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await closePassiveGuardedContext(context).catch(() => context.close().catch(() => undefined));
    }
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
    expect(loginsSince()).toBe(1);

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
    console.info(`T25b E9 (${name}): page ${JSON.stringify(outcome)}; server ${JSON.stringify(requestsSince())}`);

    expect(Object.values(outcome).every((result) => result.startsWith('error'))).toBe(true);
    expect(navigationToOtherOrigin).toBe('blocked');
    expect(nonReadRequests(requestsSince())).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
    expect(siteBRequests(requestsSince())).toEqual([]);
    expect(requestsSince().some((entry) => entry.path.startsWith(LOGIN_FIXTURE_PATHS.serviceWorker))).toBe(false);
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

    expect(nonReadRequests(requestsSince())).toEqual([
      `A POST ${LOGIN_FIXTURE_PATHS.login}`,
      `A POST ${LOGIN_FIXTURE_PATHS.login}`,
    ]);
    expect(loginsSince()).toBe(2);
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

    expect(nonReadRequests(requestsSince())).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.login}`,
    ]);
  });

  it('stops the 303 to another origin after the allowed POST by the main frame rule', async () => {
    const { page, ledger } = await openGuarded(loginStage(1));

    await submitLogin(page, `${LOGIN_FIXTURE_PATHS.login}${LOGIN_NEXT_IDP_QUERY}`);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(loginsSince()).toBe(1);
    expect(nonReadRequests(requestsSince())).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}${LOGIN_NEXT_IDP_QUERY}`]);
    expect(siteBRequests(requestsSince())).toEqual([]);
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

    expect(nonReadRequests(requestsSince())).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login307}`]);
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
    expect(nonReadRequests(requestsSince())).toEqual([]);

    await submitLogin(page);
    expect(new URL(page.url()).pathname).toBe(LOGIN_FIXTURE_PATHS.admin);
    await Promise.all([
      page.waitForEvent('requestfailed', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
      page.click('#update'),
    ]);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(nonReadRequests(requestsSince())).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
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
    expect(loginsSince()).toBe(1);

    const { page, ledger } = await openGuarded();
    await submitLogin(page);
    await wait(LATE_DELIVERY_SETTLE_MS);

    expect(nonReadRequests(requestsSince())).toEqual([`A POST ${LOGIN_FIXTURE_PATHS.login}`]);
    expect(loginsSince()).toBe(1);
    expect(ledger.snapshot().invariantViolations).toEqual([]);
    expect(ledger.snapshot().blockedRequests.map((entry) => `${entry.method} ${new URL(entry.url).pathname} ${entry.reason}`)).toEqual([
      `POST ${LOGIN_FIXTURE_PATHS.login} NON_READ_METHOD`,
    ]);
  });
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T25d: the Worker self-check covers the login stage Context (%s, without the Shared Worker disabling arguments)', (_name, launch) => {
  let allowingBrowser: Browser;
  let site: FixtureServer;

  beforeAll(async () => {
    site = await startFixtureServer();
    allowingBrowser = await launch({ sharedWorkers: 'allow' });
  });

  afterAll(async () => {
    await allowingBrowser?.close();
    await site?.close();
  });

  it('records SHARED_WORKER_OBSERVED and closes the login stage Context when its page creates a Shared Worker', async () => {
    const factory = new BrowserContextFactory(allowingBrowser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    try {
      const context = await factory.createLoginStageContext(VIEWPORT, {
        loginPostEndpoints: [{ origin: site.origin, path: '/login' }],
        maxLoginPosts: 1,
      });
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.origin}${sharedWorkerPostsPath('fetch')}`, { waitUntil: 'load' }).catch(() => undefined);

      await expect.poll(() => isPassiveRequestGuardClosed(context)).toBe(true);
      expect(factory.getSafetyLedger(context).snapshot().invariantViolations.map(({ code }) => code)).toContain('SHARED_WORKER_OBSERVED');
      await expect(factory.closePassiveContext(context)).resolves.toBeUndefined();
    } finally {
      await factory.close();
    }
  });
});

/** スクリプトのログインの場面の上限（ms）。 */
const SCRIPT_TEST_TIMEOUT_MS = 120_000;
/** 画面の状態を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms。ページを開いたままの数え直し）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** token の送信の回数の上限（認証の設定の `maxLoginAttempts` の値）。 */
const ONE_LOGIN_POST = 1;
const TWO_LOGIN_POSTS = 2;
/** ログインに伴う送信の、ログインの段 1 回あたりの上限（L11 の後は数えない）。 */
const ONE_SIDE_POST = 1;
const THREE_SIDE_POSTS = 3;
/** fixture の既存の会員の名前。 */
const EXISTING_NAME = '既存花子';
/** `preLoginRpc` の画面が、手続きの呼び出しを送る回数（`/auth` と `/admin` を開いたときに 1 回ずつ）。 */
const TENANT_CALLS_THROUGH_LOGIN = 2;
const STATUS_OK = 200;

/**
 * T34e: スクリプトの送信の要求の種類（fetch か xhr）。fixture は `fetch()` で送るが、Guard が判定に使う種類は Chromium が報告する値（両方の Chromium で
 * xhr と報告された）なので、どちらも受ける。
 */
const SCRIPT_RESOURCE_TYPE = expect.stringMatching(/^(?:fetch|xhr)$/u);

const tokenPathOf = (grant: string): string => `${SPA_BACKEND_PATHS.token}?grant_type=${grant}`;
/** 本番の要求（事前確認を除く）で、`origin` の `method` の `path`（query を含む）に届いたもの。 */
const deliveredTo = (site: SpaAuthSite, origin: SpaAuthSiteRequest['origin'], method: string, path: string): readonly SpaAuthSiteRequest[] =>
  site.requests.filter((request) => request.origin === origin && !request.preflight && request.method === method && request.path === path);
/** 本番の要求（事前確認を除く）で、`origin` に届いた POST のすべて。 */
const postsTo = (site: SpaAuthSite, origin: SpaAuthSiteRequest['origin']): readonly SpaAuthSiteRequest[] =>
  site.requests.filter((request) => request.origin === origin && !request.preflight && request.method === 'POST');
/** 事前確認を含めて、`origin` に届いた要求のすべて。 */
const anyTo = (site: SpaAuthSite, origin: SpaAuthSiteRequest['origin']): readonly SpaAuthSiteRequest[] =>
  site.requests.filter((request) => request.origin === origin);

/** 設定（許可 Origin はアプリの Origin だけ。token と API のバックエンドは、承認したサービスの Origin として段の口に渡す）。 */
const configOf = (site: SpaAuthSite): AuditConfig => {
  const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
  return { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
};

/** 登録するログインに伴う送信（バックエンドの path と上限）。 */
const backendSide = (site: SpaAuthSite, path: string, maxPerLoginStage: number): GuardLoginSideRequest =>
  ({ origin: site.backendOrigin, path, method: 'POST', maxPerLoginStage });

/** 理由ごとの数が、`expected` に書いた理由のほかは 0 であること。 */
const expectScriptBlocks = (
  counts: Readonly<Record<ScriptLoginBlockReason, number>>,
  expected: Partial<Record<ScriptLoginBlockReason, number>>,
): void => {
  expect(counts).toEqual(Object.fromEntries(SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [reason, expected[reason] ?? 0])));
};

// T34b: 通す部品は `BrowserContextFactory.createLoginStageContext` に、スクリプトのログインの口（`scriptRequest`。token の送信先、ログインに伴う送信、
// 承認したサービスの Origin）を渡したもの。サイトは fixture（`startSpaAuthSite`。場面ごとに振る舞いの指定が違うので、場面ごとに起こす）。届いたかは
// fixture の記録で数え、各場面の終わりに `LATE_REQUEST_WAIT_MS` だけ待ってから数え直す。止めた記録は Safety Ledger とログインの段の monitor で読む。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('T34b: the login stage Guard passes only the registered script requests with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSite = async (options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  /** スクリプトのログインの段の Context で `/auth` を開く。 */
  const openScriptLoginStage = async (
    site: SpaAuthSite,
    registration: { readonly maxLoginPosts?: number; readonly sides?: readonly GuardLoginSideRequest[] } = {},
  ) => {
    const config = configOf(site);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const monitor = new LoginStageMonitor();
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [],
      maxLoginPosts: registration.maxLoginPosts ?? ONE_LOGIN_POST,
      monitor,
      scriptRequest: {
        scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
        loginSideRequests: registration.sides ?? [],
        approvedServiceOrigins: [site.backendOrigin],
      },
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
    await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
    const ledger = () => factory.getSafetyLedger(context).snapshot();
    const blocked = (): readonly string[] => ledger().blockedRequests.map(({ method, url, reason }) => `${method} ${url} ${reason}`);
    return { page, monitor, ledger, blocked };
  };

  /** T34e: フォームの送信のログインの段の Context（スクリプトの口なし。フォームの送信先はアプリの `/auth`）で `/auth` を開く。 */
  const openFormLoginStage = async (site: SpaAuthSite) => {
    const config = configOf(site);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const monitor = new LoginStageMonitor();
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }],
      maxLoginPosts: ONE_LOGIN_POST,
      monitor,
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
    await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
    return { page, monitor };
  };

  const submitLogin = async (site: SpaAuthSite, page: Page): Promise<void> => {
    await site.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
    await page.locator(SPA_LOGIN_FIELDS.submit).click();
  };
  const loginErrorReason = async (page: Page): Promise<string | null> => {
    const error = page.locator(`#${SPA_STATE_ELEMENTS.loginError}[data-state="shown"]`);
    await error.waitFor({ timeout: UI_TIMEOUT_MS });
    return error.getAttribute('data-reason');
  };
  const waitForMembers = async (page: Page, state: 'loaded' | 'error'): Promise<void> => {
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="${state}"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  };
  /** ローカル ストレージに、ログインの状態の鍵があるか（値は読まない）。 */
  const hasStoredSession = (page: Page): Promise<boolean> =>
    page.evaluate((key) => localStorage.getItem(key) !== null, SPA_AUTH_STORAGE_KEY);

  // T25d（前の login-stage-context）: 認証つきの factory（監査の段）は、ログインの段の Context を作らない。フォームの送信の形の違う指定も拒む。
  it('does not create a login stage Context from a malformed script or form login stage, nor from an authenticated factory', async () => {
    const site = await startSite();
    const config = configOf(site);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const scriptLogin = { origin: site.backendOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] };
    const valid = { scriptLogin, loginSideRequests: [], approvedServiceOrigins: [site.backendOrigin] };
    const side = { origin: site.backendOrigin, path: SPA_BACKEND_PATHS.functionSyncAccess, method: 'POST', maxPerLoginStage: 1 };
    for (const scriptRequest of [
      null,
      { ...valid, scriptLogin: { origin: site.backendOrigin, path: SPA_BACKEND_PATHS.token } },
      { ...valid, scriptLogin: { ...scriptLogin, requiredQuery: [{ name: 'grant_type', value: 1 }] } },
      { ...valid, loginSideRequests: [{ ...side, maxPerLoginStage: -1 }] },
      { ...valid, loginSideRequests: [{ ...side, maxPerLoginStage: 1.5 }] },
      { ...valid, loginSideRequests: [{ origin: side.origin, path: side.path, maxPerLoginStage: 1 }] },
      { ...valid, loginSideRequests: 'x' },
      { ...valid, approvedServiceOrigins: site.backendOrigin },
    ]) {
      await expect(factory.createLoginStageContext(config.viewports.primaryDesktop, {
        loginPostEndpoints: [], maxLoginPosts: ONE_LOGIN_POST, scriptRequest,
      } as never), JSON.stringify(scriptRequest)).rejects.toThrow(TypeError);
    }
    await expect(factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [], maxLoginPosts: -1, scriptRequest: valid,
    })).rejects.toThrow(TypeError);
    for (const stage of [
      null,
      { loginPostEndpoints: 'x', maxLoginPosts: 1 },
      { loginPostEndpoints: [{ origin: site.appOrigin }], maxLoginPosts: 1 },
      { loginPostEndpoints: [], maxLoginPosts: 1 },
      { loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }], maxLoginPosts: 1.5 },
    ]) {
      await expect(factory.createLoginStageContext(config.viewports.primaryDesktop, stage as never), JSON.stringify(stage)).rejects.toThrow(TypeError);
    }
    // T44R の M-1（前の manual-login-pass-through）: 承認したサービスの Origin の読み取りの口は、手動のログインの段の、スクリプトの指定がない形だけが受ける
    // （自動ログインの段は今どおり拒む）。
    const manualBase = { loginPostEndpoints: [], maxLoginPosts: 1, manualServiceReadOrigins: [site.backendOrigin] };
    const manualScript = {
      scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [] },
      loginSideRequests: [],
      approvedServiceOrigins: [site.backendOrigin],
    };
    for (const stage of [
      manualBase,
      { ...manualBase, scriptRequest: manualScript },
      { ...manualBase, manualPassThrough: true, scriptRequest: manualScript },
      { ...manualBase, manualPassThrough: true, manualServiceReadOrigins: [1] },
    ]) {
      await expect(factory.createLoginStageContext(config.viewports.primaryDesktop, stage as never), JSON.stringify(stage)).rejects.toThrow(TypeError);
    }
    const manualContext = await factory.createLoginStageContext(config.viewports.primaryDesktop, { ...manualBase, manualPassThrough: true });
    await factory.closePassiveContext(manualContext);
    const authenticated = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [] },
        filterState: (state) => state,
        auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
      },
    });
    factories.push(authenticated);
    await expect(authenticated.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }], maxLoginPosts: ONE_LOGIN_POST,
    })).rejects.toThrow(TypeError);
    expect(testContextsOf(browser)).toHaveLength(0);
  }, SCRIPT_TEST_TIMEOUT_MS);

  // 「登録すれば通る」（使える度合い）を 1 つの場面に畳んだ（前の 5 場面: 正しいログイン、登録した手続きの呼び出し、L11 の 2 回目の手続きの呼び出し、
  // 登録したサーバの関数、token の送信の上限が設定の値）。L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。設計者の判断 (b)）: 登録した
  // ログインに伴う送信は、ログインの段 1 回あたりの回数を数えずに何回でも通す（上限 1 で 2 回届く）。token の送信の上限は設定の値（2 回）。
  it('a correct script login with the registered tenant RPC and server function: each registered request reaches, the token POST up to the setup limit', async () => {
    const site = await startSite({ preLoginRpc: 'required', postLoginFunction: 'stopOnFailure', hostileLogin: 'loginTwice' });
    const { page, monitor, ledger } = await openScriptLoginStage(site, {
      maxLoginPosts: TWO_LOGIN_POSTS,
      sides: [
        backendSide(site, SPA_BACKEND_PATHS.rpcResolveTenant, ONE_SIDE_POST),
        backendSide(site, SPA_BACKEND_PATHS.functionSyncAccess, ONE_SIDE_POST),
      ],
    });
    await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="resolved"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await submitLogin(site, page);
    await waitForMembers(page, 'loaded');
    expect(await hasStoredSession(page)).toBe(true);
    expect(await page.locator(`#${SPA_STATE_ELEMENTS.members}`).textContent()).toContain(EXISTING_NAME);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(TWO_LOGIN_POSTS);
    expect(site.successfulLogins).toBe(TWO_LOGIN_POSTS);
    expect(deliveredTo(site, 'backend', 'POST', SPA_BACKEND_PATHS.rpcResolveTenant)).toHaveLength(TENANT_CALLS_THROUGH_LOGIN);
    expect(deliveredTo(site, 'backend', 'POST', SPA_BACKEND_PATHS.functionSyncAccess)).toHaveLength(1);
    expect(site.functionCalls).toBe(1);
    expect(postsTo(site, 'backend')).toHaveLength(TWO_LOGIN_POSTS + TENANT_CALLS_THROUGH_LOGIN + 1);
    expect(deliveredTo(site, 'backend', 'GET', `${SPA_BACKEND_PATHS.members}?select=*`).every((request) => request.bearerValid === true)).toBe(true);
    const snapshot = ledger();
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.blockedInteractionRequests).toEqual([]);
    expect(snapshot.invariantViolationCount).toBe(0);
    const counts = monitor.snapshot();
    expect(counts.scriptRequest.tokenRequestsAllowed).toBe(TWO_LOGIN_POSTS);
    expect(counts.scriptRequest.sideRequestsAllowed).toEqual([TENANT_CALLS_THROUGH_LOGIN, 1]);
    expect(counts.scriptRequest.serviceOriginReads).toBeGreaterThan(0);
    expectScriptBlocks(counts.scriptRequest.blockedByScriptReason, {});
    expect(monitor.tokenRequestsBlockedOverLimit()).toBe(0);
    // monitor の数は、URL・本文・値を持たない。
    const text = JSON.stringify(counts);
    for (const marker of [site.appOrigin, site.backendOrigin, SPA_BACKEND_PATHS.token, ...site.secretValues()]) {
      expect(text).not.toContain(marker);
    }
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('the tenant RPC before the login (required) is blocked and recorded when not registered, so the screen refuses the login', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const { page, monitor, blocked } = await openScriptLoginStage(site);
    await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="error"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await submitLogin(site, page);
    expect(await loginErrorReason(page)).toBe('tenant');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(postsTo(site, 'backend')).toEqual([]);
    expect(blocked()).toEqual([`POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcResolveTenant} NON_READ_METHOD`]);
    expect(monitor.snapshot().scriptRequest.tokenRequestsAllowed).toBe(0);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { UNREGISTERED_NON_READ: 1 });
    // T34e: 一覧に、Origin と path と種類と理由が出る。
    expect(monitor.snapshot().blockedRequests).toEqual({
      requests: [{ origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcResolveTenant, resourceType: SCRIPT_RESOURCE_TYPE, reason: 'UNREGISTERED_NON_READ', count: 1 }],
      unlisted: 0,
    });
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('T34e: the form navigation login stage lists the blocked script POSTs with the form reason and the token path (not hidden)', async () => {
    const site = await startSite();
    const { page, monitor } = await openFormLoginStage(site);
    await submitLogin(site, page);
    expect(await loginErrorReason(page)).toBe('network');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(postsTo(site, 'backend')).toEqual([]);
    const { blockedRequests } = monitor.snapshot();
    // T43d（意図して直した期待。Task 43 の設計書 4.4）: 行に、query の名前と、閉じた一覧の名前（`grant_type`）の決まった形の値を足した。
    expect(blockedRequests).toEqual({
      requests: [{
        origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, resourceType: SCRIPT_RESOURCE_TYPE, reason: 'NON_READ_METHOD', count: 1,
        query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
      }],
      unlisted: 0,
    });
    // スクリプトで送るログインの数は、フォームの送信では数えない。
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, {});
    // 秘密の目印と、query の文字列そのもの（`名前=値`）は出ない。
    const text = JSON.stringify(blockedRequests);
    for (const marker of [...site.secretValues(), `grant_type=${SPA_GRANT_TYPES.password}`]) {
      expect(text).not.toContain(marker);
    }
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('the server function after the login is blocked and recorded when not registered (the token POST still reaches once)', async () => {
    const site = await startSite({ postLoginFunction: 'stopOnFailure' });
    const { page, monitor, blocked } = await openScriptLoginStage(site);
    await submitLogin(site, page);
    expect(await loginErrorReason(page)).toBe('function');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.functionCalls).toBe(0);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(1);
    expect(postsTo(site, 'backend')).toHaveLength(1);
    expect(blocked()).toEqual([`POST ${site.backendOrigin}${SPA_BACKEND_PATHS.functionSyncAccess} NON_READ_METHOD`]);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { UNREGISTERED_NON_READ: 1 });
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('hostile loginTwice: the second token POST over the limit is blocked and counted as over the limit', async () => {
    const site = await startSite({ hostileLogin: 'loginTwice' });
    const { page, monitor, blocked } = await openScriptLoginStage(site);
    await submitLogin(site, page);
    expect(await loginErrorReason(page)).toBe('network');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(ONE_LOGIN_POST);
    expect(site.successfulLogins).toBe(ONE_LOGIN_POST);
    expect(blocked()).toEqual([`POST ${site.tokenOrigin}${tokenPathOf(SPA_GRANT_TYPES.password)} NON_READ_METHOD`]);
    expect(monitor.snapshot().scriptRequest.tokenRequestsAllowed).toBe(ONE_LOGIN_POST);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { TOKEN_REQUEST_OVER_LIMIT: 1 });
    expect(monitor.tokenRequestsBlockedOverLimit()).toBe(1);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('hostile loginOtherGrant: the token POST with another grant is blocked as a query mismatch (not an attempt over the limit)', async () => {
    const site = await startSite({ hostileLogin: 'loginOtherGrant' });
    const { page, monitor, blocked } = await openScriptLoginStage(site);
    await submitLogin(site, page);
    expect(await loginErrorReason(page)).toBe('network');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(postsTo(site, 'backend')).toEqual([]);
    expect(blocked()).toEqual([`POST ${site.tokenOrigin}${tokenPathOf(SPA_GRANT_TYPES.other)} NON_READ_METHOD`]);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { TOKEN_REQUEST_QUERY_MISMATCH: 1 });
    expect(monitor.tokenRequestsBlockedOverLimit()).toBe(0);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('hostile loginToThirdOrigin: the token POST to an unregistered origin is blocked; nothing reaches that origin', async () => {
    const site = await startSite({ hostileLogin: 'loginToThirdOrigin' });
    const { page, monitor, blocked } = await openScriptLoginStage(site);
    await submitLogin(site, page);
    expect(await loginErrorReason(page)).toBe('network');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(anyTo(site, 'other')).toEqual([]);
    expect(postsTo(site, 'backend')).toEqual([]);
    expect(blocked()).toEqual([`POST ${site.otherOrigin}${tokenPathOf(SPA_GRANT_TYPES.password)} NON_READ_METHOD`]);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { UNREGISTERED_NON_READ: 1 });
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('hostile loginExtraPost: the token POST passes, the extra POST after it is blocked', async () => {
    const site = await startSite({ hostileLogin: 'loginExtraPost' });
    const { page, monitor, blocked } = await openScriptLoginStage(site);
    await submitLogin(site, page);
    await waitForMembers(page, 'loaded');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(1);
    expect(deliveredTo(site, 'backend', 'POST', SPA_BACKEND_PATHS.rpcLogLogin)).toEqual([]);
    expect(postsTo(site, 'backend')).toHaveLength(1);
    expect(blocked()).toEqual([`POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcLogLogin} NON_READ_METHOD`]);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { UNREGISTERED_NON_READ: 1 });
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('hostile refreshLoop: every token refresh after the login is blocked; only the login reaches the backend', async () => {
    const site = await startSite({ hostileLogin: 'refreshLoop' });
    const { page, monitor, blocked } = await openScriptLoginStage(site);
    await submitLogin(site, page);
    await waitForMembers(page, 'loaded');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(1);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.refresh))).toEqual([]);
    expect(site.refreshes).toBe(0);
    expect(blocked()).toEqual(Array.from({ length: SPA_REFRESH_LOOP_COUNT },
      () => `POST ${site.tokenOrigin}${tokenPathOf(SPA_GRANT_TYPES.refresh)} NON_READ_METHOD`));
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { TOKEN_REQUEST_QUERY_MISMATCH: SPA_REFRESH_LOOP_COUNT });
    expect(monitor.tokenRequestsBlockedOverLimit()).toBe(0);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('a beacon, the measurement beacon and a document POST are blocked even to the registered destinations', async () => {
    const site = await startSite({ rumBeacon: true });
    const sidePath = SPA_BACKEND_PATHS.rpcResolveTenant;
    const { page, monitor, blocked } = await openScriptLoginStage(site, { sides: [backendSide(site, sidePath, THREE_SIDE_POSTS)] });
    const tokenUrl = `${site.tokenOrigin}${tokenPathOf(SPA_GRANT_TYPES.password)}`;
    const sideUrl = `${site.backendOrigin}${sidePath}`;
    // ページの main world の JS が、登録した送信先へ beacon を送る（種類は fetch でも xhr でもない）。
    expect(await page.evaluate(({ token, sideRequest }) => [navigator.sendBeacon(token, '{}'), navigator.sendBeacon(sideRequest, '{}')],
      { token: tokenUrl, sideRequest: sideUrl })).toEqual([true, true]);
    await wait(LATE_REQUEST_WAIT_MS);
    // 最後に、token の送信先への document の POST（フォームの送信のページの移動）。
    await page.evaluate((action) => {
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      const field = document.createElement('input');
      field.name = 'grant';
      field.value = 'x';
      form.append(field);
      document.body.append(form);
      form.submit();
    }, tokenUrl);
    await wait(LATE_REQUEST_WAIT_MS);
    // 全部の後に、もう一度待って数え直す。
    await wait(LATE_REQUEST_WAIT_MS);
    expect(postsTo(site, 'backend')).toEqual([]);
    expect(postsTo(site, 'app')).toEqual([]);
    expect(site.rumBeacons).toBe(0);
    expect([...blocked()].sort()).toEqual([
      `POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`,
      `POST ${sideUrl} NON_READ_METHOD`,
      `POST ${tokenUrl} NON_READ_METHOD`,
      `POST ${tokenUrl} NON_READ_METHOD`,
    ].sort());
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, {
      TOKEN_REQUEST_NOT_SCRIPT: 2,
      SIDE_REQUEST_NOT_SCRIPT: 1,
      UNREGISTERED_NON_READ: 1,
    });
    expect(monitor.snapshot().scriptRequest.tokenRequestsAllowed).toBe(0);
    expect(monitor.snapshot().scriptRequest.sideRequestsAllowed).toEqual([0]);
  }, SCRIPT_TEST_TIMEOUT_MS);
});

/**
 * T36b: 資格情報を入れるログインの記録の POST の形。本文の符号化の網羅（そのまま・`encodeURIComponent`・`URLSearchParams`・JSON の文字列）は単体
 * `login-credential-guard.test.ts` に任せ、ここは本文の代表（JSON）と URL の query の 2 つ。
 */
const LEAKING_BODIES: readonly SpaSideRequestBody[] = ['jsonBody', 'query'];

// T36b: 自動ログインのスクリプトで送るログインの段に、入れる資格情報から作った部品（`credentialGuard`）を渡す。サイトは fixture（`startSpaAuthSite`。
// 場面ごとに振る舞いの指定が違うので、場面ごとに起こす）。token の送信の応答の状態の分け方（400・429 と `Retry-After`・503・応答なし）は単体
// `login-credential-guard.test.ts`（`TokenResponseTracker`）に任せ、ここは 200 の 1 つで monitor へのつながりを確かめる。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('T36b: the credential guard of the script login stage with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  /** fixture の資格情報（欄の順に、メールアドレスとパスワード）。 */
  const credentialsOf = async (site: SpaAuthSite): Promise<{ readonly username: string; readonly password: string }> => {
    const values: string[] = [];
    await site.fillCredentials(async (_selector, value) => {
      values.push(value);
    });
    const [username = '', password = ''] = values;
    return { username, password };
  };

  /** スクリプトのログインの段の Context で `/auth` を開き、資格情報を入れて送る。 */
  const login = async (
    site: SpaAuthSite,
    options: { readonly credentialGuard?: LoginCredentialGuard; readonly password?: string; readonly username: string },
  ): Promise<{ readonly page: Page; readonly monitor: LoginStageMonitor; readonly ledgerText: () => string; readonly blocked: () => readonly string[] }> => {
    const config = configOf(site);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const monitor = new LoginStageMonitor();
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [],
      maxLoginPosts: ONE_LOGIN_POST,
      monitor,
      scriptRequest: {
        scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
        loginSideRequests: [{ origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcLogLogin, method: 'POST', maxPerLoginStage: ONE_SIDE_POST }],
        approvedServiceOrigins: [site.backendOrigin],
      },
      ...(options.credentialGuard === undefined ? {} : { credentialGuard: options.credentialGuard }),
    });
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${SPA_APP_PATHS.auth}`);
    await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
    await page.locator(SPA_LOGIN_FIELDS.email).fill(options.username);
    await page.locator(SPA_LOGIN_FIELDS.password).fill(options.password ?? '');
    await page.locator(SPA_LOGIN_FIELDS.submit).click();
    const ledgerText = (): string => JSON.stringify(factory.getSafetyLedger(context).snapshot());
    const blocked = (): readonly string[] => factory.getSafetyLedger(context).snapshot().blockedRequests
      .map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`);
    return { page, monitor, ledgerText, blocked };
  };

  const waitForMembers = async (page: Page): Promise<void> => {
    await page.locator(`#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  };
  /** バックエンドに届いた（事前確認でない）POST の path（query を除く）。 */
  const backendPosts = (site: SpaAuthSite): readonly string[] => site.requests
    .filter((request) => request.origin === 'backend' && !request.preflight && request.method === 'POST')
    .map(({ path }) => path.split('?')[0] ?? '');

  it.each(LEAKING_BODIES)('blocks the registered side request carrying the credentials (%s), and the login still passes', async (body) => {
    const site = await startSite({ sideRequestBeforeToken: body });
    const credentials = await credentialsOf(site);
    const { page, monitor, ledgerText, blocked } = await login(site, { ...credentials, credentialGuard: createLoginCredentialGuard(credentials) });
    await waitForMembers(page);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendPosts(site)).toEqual([SPA_BACKEND_PATHS.token]);
    expect(monitor.credentialRequestsBlocked()).toBe(1);
    expect(monitor.snapshot().scriptRequest.sideRequestsAllowed).toEqual([0]);
    // 資格情報の守りで止めた要求は、Safety Ledger に書かない（URL の query や path に値が入っているため。数はログインの段の記録）。
    expect(blocked()).toEqual([]);
    const recorded = `${ledgerText()}\n${JSON.stringify(monitor.snapshot())}\n${JSON.stringify(monitor.tokenResponses())}`;
    expect(site.secretValues().filter((value) => recorded.includes(value) || recorded.includes(encodeURIComponent(value)))).toEqual([]);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('does not create a login stage Context with a credential guard not made by the guard part, or without a script login', async () => {
    const site = await startSite({});
    const credentials = await credentialsOf(site);
    const config = configOf(site);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const scriptRequest = {
      scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
      loginSideRequests: [],
      approvedServiceOrigins: [site.backendOrigin],
    };
    const contextsBefore = testContextsOf(browser).length;
    for (const stage of [
      { loginPostEndpoints: [], maxLoginPosts: ONE_LOGIN_POST, scriptRequest, credentialGuard: { ...credentials } },
      { loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }], maxLoginPosts: ONE_LOGIN_POST, credentialGuard: createLoginCredentialGuard(credentials) },
    ]) {
      await expect(factory.createLoginStageContext(config.viewports.primaryDesktop, stage as never)).rejects.toThrow(TypeError);
    }
    expect(testContextsOf(browser)).toHaveLength(contextsBefore);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('passes the registered side request without the credentials, and the token request (the monitor reads the 200 response)', async () => {
    const site = await startSite({ sideRequestBeforeToken: 'clean' });
    const credentials = await credentialsOf(site);
    const { page, monitor } = await login(site, { ...credentials, credentialGuard: createLoginCredentialGuard(credentials) });
    await waitForMembers(page);
    await wait(LATE_REQUEST_WAIT_MS);
    expect([...backendPosts(site)].sort()).toEqual([SPA_BACKEND_PATHS.rpcLogLogin, SPA_BACKEND_PATHS.token].sort());
    expect(monitor.credentialRequestsBlocked()).toBe(0);
    expect(monitor.tokenResponses()).toEqual([{ state: 'RESPONDED', status: STATUS_OK, retryAfter: null }]);
  }, SCRIPT_TEST_TIMEOUT_MS);

  // T36b（設計者の判断で範囲を広げた。T36a の懸念）: 送信を止めない画面では、ブラウザがフォームを既定の GET で送り、資格情報が URL の query に乗る。
  // 自動ログインの守りは、承認した token の送信のほかのすべての要求（main frame のナビゲーションの GET を含む）に当てるので、サーバに届かない。
  // 資格情報を含まない読み取り（画面とスクリプト）は今どおり届く。
  it('keeps the default GET form submission carrying the credentials from the server', async () => {
    const site = await startSite({ nativeFormSubmit: true });
    const credentials = await credentialsOf(site);
    const { monitor, ledgerText } = await login(site, { ...credentials, credentialGuard: createLoginCredentialGuard(credentials) });
    await expect.poll(() => monitor.credentialRequestsBlocked(), { timeout: UI_TIMEOUT_MS }).toBe(1);
    await wait(LATE_REQUEST_WAIT_MS);
    const appPaths = site.requests.filter((request) => request.origin === 'app' && !request.preflight).map(({ path }) => path);
    const carrying = appPaths.filter((path) => [credentials.username, credentials.password]
      .some((value) => path.includes(encodeURIComponent(value)) || path.includes(value)));
    expect(carrying).toEqual([]);
    expect(appPaths).toContain(SPA_APP_PATHS.auth);
    expect(appPaths).toContain(SPA_APP_PATHS.script);
    expect(backendPosts(site)).toEqual([]);
    expect(monitor.credentialRequestsBlocked()).toBe(1);
    // Guard が止めた main frame の移動は、許した移動の失敗（違反）と取り違えない。
    expect((JSON.parse(ledgerText()) as { readonly invariantViolations: readonly unknown[] }).invariantViolations).toEqual([]);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('does not compare on a manual login stage (no credential guard)', async () => {
    const site = await startSite({ sideRequestBeforeToken: 'jsonBody' });
    const credentials = await credentialsOf(site);
    const { page, monitor } = await login(site, credentials);
    await waitForMembers(page);
    await wait(LATE_REQUEST_WAIT_MS);
    expect([...backendPosts(site)].sort()).toEqual([SPA_BACKEND_PATHS.rpcLogLogin, SPA_BACKEND_PATHS.token].sort());
    expect(monitor.credentialRequestsBlocked()).toBe(0);
  }, SCRIPT_TEST_TIMEOUT_MS);
});

/** T36R-fix: 閉じた後に、遅れて届く要求を数え直す前の待ちの上限（ms。`settleLateDeliveries`）。 */
const LEAK_LATE_DELIVERY_LIMIT_MS = 1_000;
/**
 * T36R-fix: ページの最後の段（token の応答の後の `/admin` への移動）が資格情報の守りで止まったときの、止めた数の下限（持ち出しの要求と、Cookie か
 * `Referer` がパスワードを運ぶ移動の 2 つ）。
 */
const LEAK_AND_ADMIN_BLOCKED = 2;

/** 試す資格情報（どれも匿名の仮の値）。c2〜c4 は、ブラウザが一部の文字だけを % の形にする値（C-2）。 */
const CREDENTIALS = Object.freeze({
  c1: { username: 'synth.user01@example.invalid', password: 'Zq9Kx7Lp3Wm' },
  c2: { username: 'synthuser02', password: 'Zq9 Kx/7Lp' },
  c3: { username: 'synthuser03', password: "Zq9'Kx@7Lp" },
  c4: { username: 'synthuser04', password: 'Zqä9Kx@7Lp' },
} as const);
type CredentialKey = keyof typeof CREDENTIALS;

// T36R-fix: サイトはテストだけのサイト（`startCredentialLeakSite`。レビュー担当の実験を写した）。資格情報ごとに 1 つのサイトと factory を describe で
// 共有し、場面の初めに記録を空にする。届いたかはサーバの記録で数える（承認した token の送信は除く）。待ちは、ページの最後の段が届くか止まるまでの poll
// と、Context を閉じた後の `settleLateDeliveries` の 1 回（前の 2.5 秒と 1 秒の固定の待ちの代わり）。値は出力しない。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('T36R-fix: the credential guard on the headers, the cookies, the browser-encoded URLs and the blocked list with %s', (_label, launch) => {
  let browser: Browser;
  const shared = new Map<CredentialKey, { readonly site: CredentialLeakSite; readonly config: AuditConfig; readonly factory: BrowserContextFactory }>();

  beforeAll(async () => {
    browser = await launch();
    for (const key of Object.keys(CREDENTIALS) as CredentialKey[]) {
      const site = await startCredentialLeakSite(CREDENTIALS[key].username, CREDENTIALS[key].password);
      const base = fastRunConfig(site.appOrigin, LEAK_SITE_PATHS.auth);
      const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${LEAK_SITE_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
      shared.set(key, { site, config, factory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS) });
    }
  });

  afterAll(async () => {
    for (const { site, factory } of shared.values()) {
      await factory.close();
      await site.close();
    }
    shared.clear();
    await browser?.close();
  });

  /** 場面を流し、サーバの記録と monitor を返す。 */
  const runScenario = async (scenario: LeakSiteScenario, credentialKey: CredentialKey) => {
    const credentials = CREDENTIALS[credentialKey];
    const entry = shared.get(credentialKey);
    if (entry === undefined) {
      throw new Error(`no credential leak site for ${credentialKey}`);
    }
    const { site, config, factory } = entry;
    site.records.splice(0);
    const arrived = (path: string): number => site.records.filter((record) => record.url.startsWith(path)).length;
    const monitor = new LoginStageMonitor();
    const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
      loginPostEndpoints: [],
      maxLoginPosts: ONE_LOGIN_POST,
      monitor,
      scriptRequest: {
        scriptLogin: { origin: site.tokenOrigin, path: LEAK_SITE_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        loginSideRequests: [{ origin: site.sideOrigin, path: LEAK_SITE_PATHS.side, method: 'POST', maxPerLoginStage: ONE_SIDE_POST }],
        approvedServiceOrigins: [site.tokenOrigin, site.sideOrigin],
      },
      credentialGuard: createLoginCredentialGuard(credentials),
    });
    try {
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.appOrigin}${LEAK_SITE_PATHS.auth}?s=${scenario}`);
      await page.locator('#u').waitFor({ timeout: UI_TIMEOUT_MS });
      await page.locator('#u').fill(credentials.username);
      await page.locator('#p').fill(credentials.password);
      await page.locator('#b').click();
      // 判定が揃うまで待つ: 持ち出しの要求は送信を押したときに token の送信と一緒に出るので、ページの最後の段（token の応答の後の `/admin` への移動）が
      // サーバに届くか、資格情報の守りで止まったときには、Guard の判定は済んでいる。
      await expect.poll(
        () => arrived(LEAK_SITE_PATHS.admin) > 0 || monitor.credentialRequestsBlocked() >= LEAK_AND_ADMIN_BLOCKED,
        { timeout: UI_TIMEOUT_MS },
      ).toBe(true);
    } finally {
      await factory.closePassiveContext(context);
    }
    await settleLateDeliveries(LEAK_LATE_DELIVERY_LIMIT_MS);
    /** 承認した token の送信を除いて、値を運んで届いた要求の数。 */
    const carrying = (value: string): number => site.records
      .filter((record) => !(record.origin === 'T' && record.method === 'POST'))
      .filter((record) => recordCarries(value, record)).length;
    return {
      passwordCarried: carrying(credentials.password),
      usernameCarried: carrying(credentials.username),
      arrived,
      monitor,
      credentials,
    };
  };

  it.each<LeakSiteScenario>(['hdrGet', 'hdrSide', 'cookie', 'cookieRaw', 'referer'])(
    'C-1: keeps the password in %s from the server, and counts the blocked request',
    async (scenario) => {
      const { passwordCarried, monitor } = await runScenario(scenario, 'c1');
      expect(passwordCarried).toBe(0);
      expect(monitor.credentialRequestsBlocked()).toBeGreaterThan(0);
    },
    SCRIPT_TEST_TIMEOUT_MS,
  );

  it.each<readonly [LeakSiteScenario, CredentialKey]>([
    ['rawQuery', 'c2'], ['rawQuery', 'c3'], ['rawQuery', 'c4'],
    ['rawPath', 'c2'], ['rawPath', 'c3'], ['rawPath', 'c4'],
  ])('C-2: keeps the password concatenated as is in %s (%s) from the server', async (scenario, credentialKey) => {
    const { passwordCarried, monitor } = await runScenario(scenario, credentialKey);
    expect(passwordCarried).toBe(0);
    expect(monitor.credentialRequestsBlocked()).toBeGreaterThan(0);
  }, SCRIPT_TEST_TIMEOUT_MS);

  // T36R2-fix（寛容な `%XX` の戻し方）: 値の UTF-8 のバイトをすべて `%XX` にし、前後に戻せないバイト（`%FF`・`%FE`）を付けた URL でも届かない。
  it.each<CredentialKey>(['c1', 'c2', 'c4'])('C-2: keeps the password fully percent-encoded between undecodable bytes (%s) from the server', async (credentialKey) => {
    const { passwordCarried, monitor, arrived } = await runScenario('pctWrapped', credentialKey);
    expect(arrived(LEAK_SITE_PCT_WRAPPED_PATH)).toBe(0);
    expect(passwordCarried).toBe(0);
    expect(monitor.credentialRequestsBlocked()).toBeGreaterThan(0);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('I-1: does not list the path of a request blocked by the policy when it carries the password', async () => {
    const { passwordCarried, monitor, credentials } = await runScenario('postPathA', 'c1');
    expect(passwordCarried).toBe(0);
    const listed = JSON.stringify(monitor.snapshot().blockedRequests);
    expect(listed.includes(credentials.password) || listed.toLowerCase().includes(encodeURIComponent(credentials.password).toLowerCase())).toBe(false);
    expect(monitor.credentialRequestsBlocked()).toBe(1);
  }, SCRIPT_TEST_TIMEOUT_MS);

  it('M-8: lets a read with the user name through, and blocks a non-read request with the user name', async () => {
    const read = await runScenario('usernameRead', 'c1');
    expect(read.arrived('/r/profile')).toBe(1);
    expect(read.monitor.credentialRequestsBlocked()).toBe(0);
    const post = await runScenario('usernamePost', 'c1');
    expect(post.usernameCarried).toBe(0);
    expect(post.monitor.credentialRequestsBlocked()).toBe(1);
  }, SCRIPT_TEST_TIMEOUT_MS);
});
