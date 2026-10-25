// T36b（Task 36 の設計書 3.3・3.4・4 章・5 章の 3）: 自動ログインのスクリプトで送るログインの段の Guard の、資格情報の持ち出しの守りと、token の送信の
// 応答の状態の観測。通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: `BrowserContextFactory.createLoginStageContext`
// に、スクリプトのログインの口と、入れる資格情報から作った部品（`credentialGuard`）を渡す。サイトは fixture（`startSpaAuthSite`）。
// - 登録したログインに伴う送信（ログインの記録の POST）の本文や URL に、ページのスクリプトが資格情報を入れると（そのまま、JSON の文字列、
//   `encodeURIComponent`、`URLSearchParams`、query）、Guard が止め、バックエンドに届かない。資格情報を含まない登録の送信は通る。token の送信は通る
//   （本文の資格情報は比べない）。手動のログイン（部品を渡さない）は比べない。
// - token の送信の応答の状態（200、400、429 と `Retry-After`、503、応答なし）が、ログインの段の monitor から読める。
// - 値（資格情報、token、API の鍵）は、Safety Ledger と monitor の写しに出ない。
// 届いたかは fixture の記録で数える。各場面の終わりに、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { createLoginCredentialGuard, type LoginCredentialGuard } from '../../src/safety/login-credential-guard.js';
import { LoginStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchCliChromium, launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  SPA_TOKEN_RETRY_AFTER,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaSideRequestBody,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 各場面の終わりに、遅れて届く要求と応答の事象を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const ONE_LOGIN_POST = 1;
const ONE_SIDE_POST = 1;
const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_SERVICE_UNAVAILABLE = 503;
/** 誤ったパスワードの接尾辞（正しいパスワードに足して、400 を受ける）。 */
const WRONG_PASSWORD_SUFFIX = '-wrong';
const EXISTING_NAME = '既存花子';
/** 資格情報を入れるログインの記録の POST の形。 */
const LEAKING_BODIES: readonly SpaSideRequestBody[] = ['rawBody', 'jsonBody', 'urlEncodedBody', 'formBody', 'query'];

describe.each(LAUNCHERS)('T36b: the credential guard and the token response observation of the script login stage with %s', (_label, launch) => {
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
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
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
  const waitForLoginError = async (page: Page): Promise<void> => {
    await page.locator(`#${SPA_STATE_ELEMENTS.loginError}[data-state="shown"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
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
  }, TEST_TIMEOUT_MS);

  it('does not create a login stage Context with a credential guard not made by the guard part, or without a script login', async () => {
    const site = await startSite({});
    const credentials = await credentialsOf(site);
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
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
  }, TEST_TIMEOUT_MS);

  it('passes the registered side request without the credentials, and the token request', async () => {
    const site = await startSite({ sideRequestBeforeToken: 'clean' });
    const credentials = await credentialsOf(site);
    const { page, monitor } = await login(site, { ...credentials, credentialGuard: createLoginCredentialGuard(credentials) });
    await waitForMembers(page);
    await wait(LATE_REQUEST_WAIT_MS);
    expect([...backendPosts(site)].sort()).toEqual([SPA_BACKEND_PATHS.rpcLogLogin, SPA_BACKEND_PATHS.token].sort());
    expect(monitor.credentialRequestsBlocked()).toBe(0);
    expect(monitor.tokenResponses()).toEqual([{ state: 'RESPONDED', status: STATUS_OK, retryAfter: null }]);
  }, TEST_TIMEOUT_MS);

  // T36b（設計者の判断で範囲を広げた。T36a の懸念）: 送信を止めない画面では、ブラウザがフォームを既定の GET で送り、資格情報が URL の query に乗る。
  // 自動ログインの守りは、承認した token の送信のほかのすべての要求（main frame のナビゲーションの GET を含む）に当てるので、サーバに届かない。
  // 資格情報を含まない読み取り（画面とスクリプト）は今どおり届く。手動のログイン（部品なし）では比べないので、既定の GET が届く（対比）。
  it.each([true, false])('keeps the default GET form submission carrying the credentials from the server (credential guard: %s)', async (guarded) => {
    const site = await startSite({ nativeFormSubmit: true });
    const credentials = await credentialsOf(site);
    const { monitor, ledgerText } = await login(site, { ...credentials, ...(guarded ? { credentialGuard: createLoginCredentialGuard(credentials) } : {}) });
    await wait(LATE_REQUEST_WAIT_MS);
    const appPaths = site.requests.filter((request) => request.origin === 'app' && !request.preflight).map(({ path }) => path);
    const carrying = appPaths.filter((path) => [credentials.username, credentials.password]
      .some((value) => path.includes(encodeURIComponent(value)) || path.includes(value)));
    expect(carrying.length).toBe(guarded ? 0 : 1);
    expect(appPaths).toContain(SPA_APP_PATHS.auth);
    expect(appPaths).toContain(SPA_APP_PATHS.script);
    expect(backendPosts(site)).toEqual([]);
    expect(monitor.credentialRequestsBlocked()).toBe(guarded ? 1 : 0);
    // Guard が止めた main frame の移動は、許した移動の失敗（違反）と取り違えない。
    expect((JSON.parse(ledgerText()) as { readonly invariantViolations: readonly unknown[] }).invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not compare on a manual login stage (no credential guard)', async () => {
    const site = await startSite({ sideRequestBeforeToken: 'jsonBody' });
    const credentials = await credentialsOf(site);
    const { page, monitor } = await login(site, credentials);
    await waitForMembers(page);
    await wait(LATE_REQUEST_WAIT_MS);
    expect([...backendPosts(site)].sort()).toEqual([SPA_BACKEND_PATHS.rpcLogLogin, SPA_BACKEND_PATHS.token].sort());
    expect(monitor.credentialRequestsBlocked()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [string, SpaAuthSiteOptions, boolean, { readonly state: string; readonly status: number | null; readonly retryAfter: string | null }]>([
    ['a wrong password (400)', {}, true, { state: 'RESPONDED', status: STATUS_BAD_REQUEST, retryAfter: null }],
    ['a rate limit (429 and Retry-After)', { tokenResponse: 'rateLimited' }, false, { state: 'RESPONDED', status: STATUS_TOO_MANY_REQUESTS, retryAfter: SPA_TOKEN_RETRY_AFTER }],
    ['a server error (503)', { tokenResponse: 'serverError' }, false, { state: 'RESPONDED', status: STATUS_SERVICE_UNAVAILABLE, retryAfter: null }],
    ['no response', { tokenResponse: 'noResponse' }, false, { state: 'FAILED', status: null, retryAfter: null }],
  ])('reads the token response state of %s from the monitor', async (_name, options, wrongPassword, expected) => {
    const site = await startSite(options);
    const credentials = await credentialsOf(site);
    const typed = { ...credentials, password: wrongPassword ? `${credentials.password}${WRONG_PASSWORD_SUFFIX}` : credentials.password };
    const { page, monitor } = await login(site, { ...typed, credentialGuard: createLoginCredentialGuard(typed) });
    await waitForLoginError(page);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendPosts(site)).toEqual([SPA_BACKEND_PATHS.token]);
    expect(monitor.tokenResponses()).toEqual([expected]);
  }, TEST_TIMEOUT_MS);
});
