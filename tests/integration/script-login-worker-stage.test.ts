// T34c（Task 34 の設計書 3.3、3.4、3.5、5 章の 2・3）: ワーカーの手動のログインの段（`runLoginStage`）の、スクリプトで送るログイン（`SCRIPT_REQUEST`）。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: ワーカーのログインの段の関数 `runLoginStage`（人の操作は、
// テストだけの口 `onLoginPageReady` で代える。ログイン用の Browser も、テストが渡す launcher で起動する）。サイトは fixture（`startSpaAuthSite`。
// アプリの Origin を許可 Origin と承認したテストの Origin、token と API のバックエンドの Origin を承認したサービスの Origin にする）。
// - 成功は、成功の条件（Origin、path、セレクタ）に加え、Node の側の状態に成功の鍵の形の鍵があること。
// - 試みの上限は、Guard の monitor の「上限を超えて止めた token の送信の数」で決める。
// - ログインの段の結果は、数だけ（`scriptLogin`。URL・値を持たない）を持つ。
// 届いたかは fixture の記録で数える。各場面の終わりに、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
// T34e: ログインの段の結果は、止めた読み取りでない要求の一覧（`blockedRequests`。Origin・path・種類・理由・回数。query・本文・値なし。T34e fix round 1:
// path の値に見える区切りは伏せ、送信先の path は伏せない）も持つ（止めた要求があったときだけ）。token の query の値、資格情報、token の値は、一覧に出ない。
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  type AuthSetupV3,
  type LoginSideRequest,
} from '../../src/control/auth/auth-setup-contracts.js';
import { runLoginStage, type LoginStageResult } from '../../src/worker/authenticated-login.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaAuthSiteRequest,
} from '../helpers/spa-auth-site-fixture.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
/** 1 つの場面の上限（ms）。 */
const TEST_TIMEOUT_MS = 120_000;
/** 画面の状態を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
/** 成功する場面のログインを待つ上限（ms）。 */
const LOGIN_TIMEOUT_MS = 30_000;
/** 成功しない場面のログインを待つ上限（ms。短くする）。 */
const SHORT_LOGIN_TIMEOUT_MS = 6_000;
/** 確かめる間隔（ms）。 */
const LOGIN_POLL_MS = 100;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const ONE_LOGIN_ATTEMPT = 1;
const THREE_SIDE_POSTS = 3;
/** `preLoginRpc` の画面が、成功の確かめまでに手続きの呼び出しを送る回数（`/auth` と `/admin` を開いたときに 1 回ずつ）。 */
const TENANT_CALLS_THROUGH_LOGIN = 2;
/** fixture の既存の会員の名前。 */
const EXISTING_NAME = '既存花子';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形（接頭辞と接尾辞が重ならない）。 */
const FIXTURE_KEY_PREFIX = 'fixture';
const FIXTURE_KEY_SUFFIX = '-auth-token';

/**
 * T34e: スクリプトの送信の要求の種類（fetch か xhr）。fixture は `fetch()` で送るが、Guard が判定に使う種類は Chromium が報告する値（両方の Chromium で
 * xhr と報告された）なので、どちらも受ける。
 */
const SCRIPT_RESOURCE_TYPE = expect.stringMatching(/^(?:fetch|xhr)$/u);

const tokenPath = `${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.password}`;
/** バックエンドに届いた、本番の（事前確認でない）読み取りでない要求（`<method> <path>`）。 */
const backendNonReads = (site: SpaAuthSite): readonly string[] => site.requests
  .filter((request: SpaAuthSiteRequest) => request.origin !== 'app' && !request.preflight && !READ_METHODS.has(request.method))
  .map(({ method, path }) => `${method} ${path}`);

const configOf = (site: SpaAuthSite): AuditConfig => {
  const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
  return { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
};

/** スクリプトで送るログインの認証の設定（版 3）。 */
const setupOf = (
  site: SpaAuthSite,
  change: { readonly sides?: readonly LoginSideRequest[]; readonly maxLoginAttempts?: number; readonly suffix?: string } = {},
): AuthSetupV3 => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: 'example-spa',
  profileRevision: 1,
  loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]` },
  sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
  excludedPaths: [SPA_APP_PATHS.logout],
  auditPathPrefixes: [],
  maxLoginAttempts: change.maxLoginAttempts ?? ONE_LOGIN_ATTEMPT,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
  loginSideRequests: change.sides ?? [],
  successStorageKey: { origin: site.appOrigin, prefix: FIXTURE_KEY_PREFIX, suffix: change.suffix ?? FIXTURE_KEY_SUFFIX },
});

const backendSide = (site: SpaAuthSite, path: string): LoginSideRequest =>
  ({ origin: site.backendOrigin, path, method: 'POST', maxPerLoginStage: THREE_SIDE_POSTS });

describe.each(LAUNCHERS)('T34c: the worker login stage of the script login with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  const browsers: Browser[] = [];

  beforeAll(() => {
    expect(SPA_AUTH_STORAGE_KEY).toBe(`${FIXTURE_KEY_PREFIX}${FIXTURE_KEY_SUFFIX}`);
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await Promise.all(browsers.map((browser) => browser.close().catch(() => undefined)));
  });

  const startSite = async (options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  /** ログインの段を行う（人の操作の代わりは `onLoginPageReady`。止める印は `controller`）。 */
  const runStage = async (
    site: SpaAuthSite,
    setup: AuthSetupV3,
    timeoutMs: number,
    onLoginPageReady: (page: Page) => Promise<void>,
    controller: AbortController = new AbortController(),
  ): Promise<LoginStageResult> => {
    const result = await runLoginStage({
      config: configOf(site),
      setup,
      approvedTestOrigins: [site.appOrigin],
      approvedServiceOrigins: [site.backendOrigin],
      signal: controller.signal,
      onAwaitingLogin: () => undefined,
    }, {
      launchLoginBrowser: async () => {
        const browser = await launch();
        browsers.push(browser);
        return browser;
      },
      loginTimeoutMs: timeoutMs,
      pollIntervalMs: LOGIN_POLL_MS,
      onLoginPageReady,
    });
    await wait(LATE_REQUEST_WAIT_MS);
    return result;
  };

  /** ログインの段を行う（人の操作の代わりに、ログインの画面に正しい資格情報を入れて送る）。 */
  const login = (site: SpaAuthSite, setup: AuthSetupV3, timeoutMs: number): Promise<LoginStageResult> =>
    runStage(site, setup, timeoutMs, async (page: Page) => {
      await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
      await site.fillCredentials(async (selector, value) => page.locator(selector).fill(value));
      await page.locator(SPA_LOGIN_FIELDS.submit).click();
    });

  /** T34e: ログインの段の結果の、止めた要求の一覧（なければ `undefined`）。 */
  const blockedOf = (result: LoginStageResult) => (result.kind === 'STOPPED' ? undefined : result.blockedRequests);
  /** T34e: 一覧の文字列に、秘密の目印（資格情報、token と API の鍵の値）と token の query の値が出ないこと。 */
  const expectNoSecretIn = (site: SpaAuthSite, value: unknown): void => {
    const text = JSON.stringify(value);
    for (const marker of [...site.secretValues(), `grant_type=${SPA_GRANT_TYPES.password}`, 'grant_type']) {
      expect(text).not.toContain(marker);
    }
  };

  /** 成功の結果の、成功の鍵の Origin の鍵の名前（値は返さない）。 */
  const storedKeyNames = (result: LoginStageResult, origin: string): readonly string[] =>
    (result.kind === 'AUTHENTICATED' ? result.state.origins : [])
      .filter((entry) => entry.origin === origin).flatMap((entry) => entry.localStorage.map(({ name }) => name));

  it('logs in by the script: AUTHENTICATED with the success key; only the token POST reaches the backend; the counts only', async () => {
    const site = await startSite();
    const result = await login(site, setupOf(site), LOGIN_TIMEOUT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(storedKeyNames(result, site.appOrigin)).toEqual([SPA_AUTH_STORAGE_KEY]);
    expect(backendNonReads(site)).toEqual([`POST ${tokenPath}`]);
    expect(site.successfulLogins).toBe(1);
    expect(result.kind === 'STOPPED' ? undefined : result.scriptLogin).toMatchObject({
      tokenRequestsAllowed: 1,
      sideRequestsAllowed: [],
      blockedByReason: { TOKEN_REQUEST_OVER_LIMIT: 0, UNREGISTERED_NON_READ: 0 },
    });
    // 数は URL・値を持たない。
    const counts = JSON.stringify(result.kind === 'STOPPED' ? null : result.scriptLogin);
    for (const marker of [site.appOrigin, site.backendOrigin, SPA_BACKEND_PATHS.token, ...site.secretValues()]) {
      expect(counts).not.toContain(marker);
    }
    // T34e: 止めた要求がなければ、一覧は持たない。
    expect(blockedOf(result)).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  it('passes the registered tenant RPC before the login (required) and logs in', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const result = await login(site, setupOf(site, { sides: [backendSide(site, SPA_BACKEND_PATHS.rpcResolveTenant)] }), LOGIN_TIMEOUT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    expect([...backendNonReads(site)].sort()).toEqual([
      ...Array.from({ length: TENANT_CALLS_THROUGH_LOGIN }, () => `POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`),
      `POST ${tokenPath}`,
    ].sort());
    expect(result.kind === 'STOPPED' ? undefined : result.scriptLogin?.sideRequestsAllowed).toEqual([TENANT_CALLS_THROUGH_LOGIN]);
  }, TEST_TIMEOUT_MS);

  // ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1。ユーザーの判断で意図して直した期待）: 前は、手動のログインの段でも登録していない
  // 手続きの呼び出しを止め、画面がログインを拒んで時間切れになった。今は、手動のログインの段はページの送信を止めずに通し、通した送信の一覧に形だけを残す
  // （登録した送信だけを通す決まりは、自動ログインの段だけ）。
  it('passes the unregistered tenant RPC (required) in the manual login stage, logs in, and records it in the passed list without values', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const result = await login(site, setupOf(site), LOGIN_TIMEOUT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    expect([...backendNonReads(site)].sort()).toEqual([
      ...Array.from({ length: TENANT_CALLS_THROUGH_LOGIN }, () => `POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`),
      `POST ${tokenPath}`,
    ].sort());
    expect(result.kind === 'STOPPED' ? undefined : result.scriptLogin?.blockedByReason.UNREGISTERED_NON_READ).toBe(0);
    expect(blockedOf(result)).toBeUndefined();
    const passed = result.kind === 'STOPPED' ? undefined : result.passedRequests;
    expect(passed?.requests).toEqual([expect.objectContaining({
      origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcResolveTenant, resourceType: SCRIPT_RESOURCE_TYPE, reason: 'UNREGISTERED_NON_READ',
    })]);
    expectNoSecretIn(site, passed);
  }, TEST_TIMEOUT_MS);

  it('passes the registered server function after the login and logs in', async () => {
    const site = await startSite({ postLoginFunction: 'stopOnFailure' });
    const result = await login(site, setupOf(site, { sides: [backendSide(site, SPA_BACKEND_PATHS.functionSyncAccess)] }), LOGIN_TIMEOUT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(site.functionCalls).toBe(1);
    expect([...backendNonReads(site)].sort()).toEqual([`POST ${tokenPath}`, `POST ${SPA_BACKEND_PATHS.functionSyncAccess}`].sort());
  }, TEST_TIMEOUT_MS);

  // ML-a（意図して直した期待）: 前は、登録していないサーバの関数を止め、時間切れになった。今は、手動のログインの段は通して、通した送信の一覧に残す。
  it('passes the unregistered server function after the login in the manual login stage, and records it in the passed list', async () => {
    const site = await startSite({ postLoginFunction: 'stopOnFailure' });
    const result = await login(site, setupOf(site), LOGIN_TIMEOUT_MS);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(site.functionCalls).toBe(1);
    expect([...backendNonReads(site)].sort()).toEqual([`POST ${tokenPath}`, `POST ${SPA_BACKEND_PATHS.functionSyncAccess}`].sort());
    expect(blockedOf(result)).toBeUndefined();
    const passed = result.kind === 'STOPPED' ? undefined : result.passedRequests;
    expect(passed?.requests).toEqual([expect.objectContaining({
      origin: site.backendOrigin, path: SPA_BACKEND_PATHS.functionSyncAccess, resourceType: SCRIPT_RESOURCE_TYPE, reason: 'UNREGISTERED_NON_READ', count: 1,
    })]);
    expectNoSecretIn(site, passed);
  }, TEST_TIMEOUT_MS);

  // ML-a（意図して直した期待）: 前は、上限を超えた token の送信を止めて `LOGIN_ATTEMPTS_EXCEEDED` で終えた。今は、回数の上限は自動ログインの段だけに当て、手動の
  // ログインの段は、上限を超えた送信も通して、通した送信の一覧に、通さなければ止めた理由（`TOKEN_REQUEST_OVER_LIMIT`）で残す。
  it('passes the token POST over the limit in the manual login stage and records it with the reason it would have been blocked with (loginTwice)', async () => {
    const site = await startSite({ hostileLogin: 'loginTwice' });
    const result = await login(site, setupOf(site), SHORT_LOGIN_TIMEOUT_MS);
    expect(result.kind).not.toBe('LOGIN_ATTEMPTS_EXCEEDED');
    expect(backendNonReads(site)).toEqual([`POST ${tokenPath}`, `POST ${tokenPath}`]);
    expect(result.kind === 'STOPPED' ? undefined : result.scriptLogin?.blockedByReason.TOKEN_REQUEST_OVER_LIMIT).toBe(0);
    const passed = result.kind === 'STOPPED' ? undefined : result.passedRequests;
    expect(passed?.requests).toEqual([expect.objectContaining({ origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, reason: 'TOKEN_REQUEST_OVER_LIMIT', count: 1 })]);
  }, TEST_TIMEOUT_MS);

  // ML-a（意図して直した期待）: 前は、別の grant の token の送信を止めた。今は、手動のログインの段は通し、通した送信の一覧に query の名前と閉じた一覧の値だけを残す。
  it('passes a token POST with another grant in the manual login stage, and records the query names and the closed list value only (loginOtherGrant)', async () => {
    const site = await startSite({ hostileLogin: 'loginOtherGrant' });
    const result = await login(site, setupOf(site), SHORT_LOGIN_TIMEOUT_MS);
    expect(backendNonReads(site)).toEqual([`POST ${SPA_BACKEND_PATHS.token}?grant_type=${SPA_GRANT_TYPES.other}`]);
    expect(result.kind === 'STOPPED' ? undefined : result.scriptLogin?.blockedByReason.TOKEN_REQUEST_QUERY_MISMATCH).toBe(0);
    const passed = result.kind === 'STOPPED' ? undefined : result.passedRequests;
    // T34e fix round 1: token の送信先の path は伏せない（利用者が見分けられる）。T43d: query の名前と、閉じた一覧の名前（`grant_type`）の決まった形の値を行に残す。
    expect(passed).toEqual({
      requests: [{
        origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, resourceType: SCRIPT_RESOURCE_TYPE, reason: 'TOKEN_REQUEST_QUERY_MISMATCH', count: 1,
        query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: SPA_GRANT_TYPES.other }] },
      }],
      unlisted: 0,
    });
    // 秘密の目印と、query の文字列そのもの（`名前=値`）は出ない。
    const text = JSON.stringify(passed);
    for (const marker of [...site.secretValues(), `grant_type=${SPA_GRANT_TYPES.other}`]) {
      expect(text).not.toContain(marker);
    }
  }, TEST_TIMEOUT_MS);

  it('does not succeed without the success key, even on the success page with the list', async () => {
    const site = await startSite();
    const result = await login(site, setupOf(site, { suffix: '-other-token' }), SHORT_LOGIN_TIMEOUT_MS);
    expect(result.kind).toBe('LOGIN_TIMEOUT');
    expect(backendNonReads(site)).toEqual([`POST ${tokenPath}`]);
    expect(site.successfulLogins).toBe(1);
  }, TEST_TIMEOUT_MS);

  // T34R-fix-a（T34R の M-1）: 成功には、token の送信を 1 回以上通したことも要る。ページの JS が成功の鍵の名前だけを作って成功の条件の画面へ移っても、
  // 成功にならない（時間切れ）。
  it('does not succeed when the page only creates the success key name and moves to the success page (no token request)', async () => {
    const site = await startSite();
    const setup = { ...setupOf(site), successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}` } };
    const result = await runStage(site, setup, SHORT_LOGIN_TIMEOUT_MS, async (page: Page) => {
      await page.locator(SPA_LOGIN_FIELDS.email).waitFor({ timeout: UI_TIMEOUT_MS });
      await page.evaluate(({ key, admin }) => {
        localStorage.setItem(key, '{"access_token":"forged"}');
        location.href = admin;
      }, { key: SPA_AUTH_STORAGE_KEY, admin: SPA_APP_PATHS.admin });
    });
    expect(result.kind).toBe('LOGIN_TIMEOUT');
    expect(backendNonReads(site)).toEqual([]);
    expect(site.successfulLogins).toBe(0);
    expect(result.kind === 'STOPPED' ? undefined : result.scriptLogin?.tokenRequestsAllowed).toBe(0);
  }, TEST_TIMEOUT_MS);

  // T34R-fix-a（T34R の I-1）: ログインの段で止めても、それまでの送信の一覧と数を結果に持つ（ワーカーが親に渡す）。ML-a（意図して直した期待）: 登録していない
  // 手続きの呼び出しは、止めずに通して、通した送信の一覧に残す（前は止めた送信の一覧）。
  it('keeps the counts and the list of the passed requests when the login stage is stopped after an unregistered request', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const controller = new AbortController();
    const result = await runStage(site, setupOf(site), LOGIN_TIMEOUT_MS, async (page: Page) => {
      await page.locator(`#${SPA_STATE_ELEMENTS.tenant}[data-state="resolved"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
      controller.abort();
    }, controller);
    expect(result.kind).toBe('STOPPED');
    expect(backendNonReads(site)).toEqual([`POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`]);
    expect(result.kind === 'STOPPED' ? result.blockedRequests : undefined).toBeUndefined();
    // ML-a-fix（ML-R の I-1）: token の送信より前に通したので、行は「token の送信より前」の印を持つ。
    expect(result.kind === 'STOPPED' ? result.passedRequests : undefined).toEqual({
      requests: [{
        origin: site.backendOrigin, path: SPA_BACKEND_PATHS.rpcResolveTenant, resourceType: SCRIPT_RESOURCE_TYPE, reason: 'UNREGISTERED_NON_READ', count: 1, beforeToken: true,
      }],
      unlisted: 0,
    });
    expect(result.kind === 'STOPPED' ? result.scriptLogin?.blockedByReason.UNREGISTERED_NON_READ : undefined).toBe(0);
    expectNoSecretIn(site, result);
  }, TEST_TIMEOUT_MS);
});
