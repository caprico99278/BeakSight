// T34b（Task 34 の設計書 `2026-10-16-beaksight-task-34-script-login-design.md` 3.3、3.5、4 章、5 章の 2・3）: ログインの段の Guard が、
// スクリプトで送るログイン（`SCRIPT_REQUEST`）で、登録したスクリプトの token の送信と、登録したログインに伴う送信だけを通すこと。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: `BrowserContextFactory.createLoginStageContext`
// （ログインの段の Context と Guard、出口の中継）に、スクリプトのログインの口（`scriptRequest`。token の送信先、ログインに伴う送信、承認した
// サービスの Origin）を渡す。サイトは fixture（`startSpaAuthSite`。アプリの Origin を許可 Origin、token と API のバックエンドの Origin を承認した
// サービスの Origin にする）。
// - 届いたかは、fixture の記録（バックエンドとアプリの Origin に届いた要求）で数える。各場面の終わりに、名前つきの時間（`LATE_REQUEST_WAIT_MS`）
//   だけ待ってから数え直す。
// - 止めた記録は、その Context の Safety Ledger（`blockedRequests`）と、ログインの段の monitor の数（URL・本文・値を持たない）で読む。
// 値（資格情報、token、API の鍵、ローカル ストレージの値）は出力しない（ローカル ストレージは、鍵があるかだけを読む）。
// T34e: monitor は、止めた読み取りでない要求の一覧（Origin・path・種類・理由・回数。query・本文・値なし）も持つ。スクリプトで送るログインでも、フォームの
// 送信のログイン（スクリプトの口なし）でも、ログインの段で止めた読み取りでない要求を載せる。
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { LoginStageMonitor, type GuardLoginSideRequest } from '../../src/safety/passive-request-guard.js';
import { SCRIPT_LOGIN_BLOCK_REASONS, type ScriptLoginBlockReason } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
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
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
/** 1 つの場面の上限（ms）。 */
const TEST_TIMEOUT_MS = 120_000;
/** 画面の状態を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** token の送信の回数の上限（認証の設定の `maxLoginAttempts` の値）。 */
const ONE_LOGIN_POST = 1;
const TWO_LOGIN_POSTS = 2;
/** ログインに伴う送信の、ログインの段 1 回あたりの上限。 */
const ONE_SIDE_POST = 1;
const THREE_SIDE_POSTS = 3;
/** fixture の既存の会員の名前。 */
const EXISTING_NAME = '既存花子';
/** `preLoginRpc` の画面が、手続きの呼び出しを送る回数（`/auth` と `/admin` を開いたときに 1 回ずつ）。 */
const TENANT_CALLS_THROUGH_LOGIN = 2;

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

describe.each(LAUNCHERS)('T34b: the login stage Guard passes only the registered script requests with %s', (_label, launch) => {
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

  it('does not create a login stage Context from a malformed script login stage', async () => {
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
    expect(testContextsOf(browser)).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it('a correct script login: the token POST reaches the backend once, the token is stored, and the list is read from the service origin', async () => {
    const site = await startSite();
    const { page, monitor, ledger } = await openScriptLoginStage(site);
    await submitLogin(site, page);
    await waitForMembers(page, 'loaded');
    expect(await hasStoredSession(page)).toBe(true);
    expect(await page.locator(`#${SPA_STATE_ELEMENTS.members}`).textContent()).toContain(EXISTING_NAME);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(1);
    expect(postsTo(site, 'backend')).toHaveLength(1);
    expect(site.successfulLogins).toBe(1);
    expect(deliveredTo(site, 'backend', 'GET', `${SPA_BACKEND_PATHS.members}?select=*`).every((request) => request.bearerValid === true)).toBe(true);
    const snapshot = ledger();
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.blockedInteractionRequests).toEqual([]);
    expect(snapshot.invariantViolationCount).toBe(0);
    const counts = monitor.snapshot();
    expect(counts.scriptRequest.tokenRequestsAllowed).toBe(1);
    expect(counts.scriptRequest.sideRequestsAllowed).toEqual([]);
    expect(counts.scriptRequest.serviceOriginReads).toBeGreaterThan(0);
    expectScriptBlocks(counts.scriptRequest.blockedByScriptReason, {});
    expect(monitor.tokenRequestsBlockedOverLimit()).toBe(0);
    // monitor の数は、URL・本文・値を持たない。
    const text = JSON.stringify(counts);
    for (const marker of [site.appOrigin, site.backendOrigin, SPA_BACKEND_PATHS.token, ...site.secretValues()]) {
      expect(text).not.toContain(marker);
    }
  }, TEST_TIMEOUT_MS);

  it('the tenant RPC before the login (required) passes only when registered', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const { page, monitor, blocked } = await openScriptLoginStage(site, {
      sides: [backendSide(site, SPA_BACKEND_PATHS.rpcResolveTenant, THREE_SIDE_POSTS)],
    });
    await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="resolved"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await submitLogin(site, page);
    await waitForMembers(page, 'loaded');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', SPA_BACKEND_PATHS.rpcResolveTenant)).toHaveLength(TENANT_CALLS_THROUGH_LOGIN);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(1);
    expect(blocked()).toEqual([]);
    expect(monitor.snapshot().scriptRequest.sideRequestsAllowed).toEqual([TENANT_CALLS_THROUGH_LOGIN]);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, {});
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

  it('a registered side request is limited per item (the second tenant RPC over the limit is blocked)', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const { page, monitor, blocked } = await openScriptLoginStage(site, {
      sides: [backendSide(site, SPA_BACKEND_PATHS.rpcResolveTenant, ONE_SIDE_POST)],
    });
    await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="resolved"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await submitLogin(site, page);
    // `/admin` の 2 回目の手続きの呼び出しが止まるので、一覧は読まない。
    await waitForMembers(page, 'error');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', SPA_BACKEND_PATHS.rpcResolveTenant)).toHaveLength(ONE_SIDE_POST);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(1);
    expect(blocked()).toEqual([`POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcResolveTenant} NON_READ_METHOD`]);
    expect(monitor.snapshot().scriptRequest.sideRequestsAllowed).toEqual([ONE_SIDE_POST]);
    expectScriptBlocks(monitor.snapshot().scriptRequest.blockedByScriptReason, { SIDE_REQUEST_OVER_LIMIT: 1 });
  }, TEST_TIMEOUT_MS);

  it('the server function after the login passes only when registered', async () => {
    const site = await startSite({ postLoginFunction: 'stopOnFailure' });
    const { page, monitor, blocked } = await openScriptLoginStage(site, {
      sides: [backendSide(site, SPA_BACKEND_PATHS.functionSyncAccess, ONE_SIDE_POST)],
    });
    await submitLogin(site, page);
    await waitForMembers(page, 'loaded');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.functionCalls).toBe(1);
    expect(deliveredTo(site, 'backend', 'POST', SPA_BACKEND_PATHS.functionSyncAccess)).toHaveLength(1);
    expect(blocked()).toEqual([]);
    expect(monitor.snapshot().scriptRequest.sideRequestsAllowed).toEqual([1]);
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

  it('the token POST limit is the setup value (loginTwice with a limit of two reaches twice)', async () => {
    const site = await startSite({ hostileLogin: 'loginTwice' });
    const { page, monitor, blocked } = await openScriptLoginStage(site, { maxLoginPosts: TWO_LOGIN_POSTS });
    await submitLogin(site, page);
    await waitForMembers(page, 'loaded');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(deliveredTo(site, 'backend', 'POST', tokenPathOf(SPA_GRANT_TYPES.password))).toHaveLength(TWO_LOGIN_POSTS);
    expect(blocked()).toEqual([]);
    expect(monitor.snapshot().scriptRequest.tokenRequestsAllowed).toBe(TWO_LOGIN_POSTS);
    expect(monitor.tokenRequestsBlockedOverLimit()).toBe(0);
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);

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
  }, TEST_TIMEOUT_MS);
});
