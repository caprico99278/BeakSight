// T36c（Task 36 の設計書 3.3・3.4・4 章・5 章の 2・3）: スクリプトで送るログインの自動ログインの段（`runAutomatedLoginStage`）。通す部品（どれも本物。
// Chromium はテストの既定の headless と、CLI の起動の設定の両方）: 自動ログインの段が、ログインの段の Context（スクリプトの口と、資格情報の守りの部品）を
// 作り、入力の部品（`SCRIPT_REQUEST`）で入れて押し、token の送信の応答の状態と成功の確かめで結果を区分する。サイトは fixture（`startSpaAuthSite`）。
// 資格情報の読み方は、テストの関数（fixture の資格情報。保存のファイルは使わない）。
// - 区分（設計書 3.4 の表）: 2xx と成功の確かめ → 成功、400 → `INVALID_CREDENTIALS`、429 → `RATE_LIMITED`（`Retry-After`）、423 → `ACCOUNT_LOCKED`、
//   503 と応答なし → `AUTH_RESULT_UNKNOWN`（送信 `YES`）。
// - 設計者の判断 3: 資格情報を含む要求を Guard が止めたら（送信を止めない form、登録の送信に資格情報を入れるページ）、成功の条件を満たしても成功にせず
//   `AUTH_RESULT_UNKNOWN`（送信は分からない `UNKNOWN` か `YES`。どちらでも自動ログインを止める）。資格情報を含む要求はサーバに届かない。
// - 結果は、スクリプトで送るログインの数（`scriptLogin`。止めた資格情報の数を含む）を持つ。
// 届いたかは fixture の記録で数える。各場面の終わりに、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
// SFIX-1104（SREV-1104 の C-1・I-2。設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 3.2。SLIM L-3 で前の automated-login-probe を
// まとめた）: 自動ログインの段の通し方（DEF-193）を崩す要求を、本物の factory・Guard・出口の中継・資格情報の守りで確かめる（fixture は
// `tests/helpers/login-probe-site.ts`。レビューの 30 種の場面と、読まないパスへの自動の POST）。
// - 資格情報を含んで届くのは、承認した token の送信だけ（そのまま・base64 の本文・`Authorization: Basic`・必須の query を保って query を足した 2 回目の
//   ログインの送信は届かない）。token の更新（必須の query の値が違う）は今のとおり通り、ログインの送信の回数に数えない。
// - 読まないパスへの、サイトの自動の POST は届かない（決まりで止めた行 `AUTOMATED_LOGIN_RULE_BLOCKED`）。
// SFIX-1104-2（SREV-1104-2 の C1・C2）: base64 に `+`・`/` が出る記号つきのパスワード（`symbol`）でも、16 進だけのパスワード（`hex`）でも同じ。
// - `encodeURIComponent` した base64 の query の値（GET・POST）も、「ID:パスワード」の同じ形も届かない。
// - 読み取りでない要求の、ID だけの base64（`X-` のヘッダ）も届かない。読み取りの要求の ID は比べない決まり（SREV-1104-2 の M1）なので、ID だけの
//   `Basic` の GET は届く（その 1 件だけ）。
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { createLoginCredentialGuard } from '../../src/safety/login-credential-guard.js';
import { LoginStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { BOTH_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import {
  LOGIN_PROBE_EXCLUDED_PATH,
  startLoginProbeSite,
  type LoginProbePasswordKind,
  type LoginProbeSite,
} from '../helpers/login-probe-site.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaLoginLayout,
} from '../helpers/spa-auth-site-fixture.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { runAutomatedLoginStage, type AutomatedLoginStageResult } from '../../src/worker/automated-login.js';

const TEST_TIMEOUT_MS = 120_000;
/** 送信の後に結果を待つ時間（ms。テストを速くする）。 */
const RESULT_TIMEOUT_MS = 10_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const CREDENTIAL_REVISION = 1;
const EXISTING_NAME = '既存花子';
const WRONG_PASSWORD_SUFFIX = '-wrong';
const ONE_SIDE_POST = 1;
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });

/** SFIX-1104: パスワードの 2 つの形。 */
const PROBE_PASSWORD_KINDS = ['hex', 'symbol'] as const satisfies readonly LoginProbePasswordKind[];
/** 読み取りの要求の ID は比べない決まり（SREV-1104-2 の M1）で届く、ID だけの `Basic` の GET。 */
const READ_WITH_USERNAME_ONLY = '/probe/x_basicIdOnlyGet';
const PROBE_RESULT_TIMEOUT_MS = 60_000;
const PROBE_LATE_REQUEST_WAIT_MS = 1_500;
const PROBE_TEST_TIMEOUT_MS = 180_000;

/** ページの結果（応答の状態。届かなければ 0）の期待。`credBeaconQueued` は送信の予約の結果（届いたかはサーバの記録で見る）。 */
const PROBE_EXPECTED_RESULTS: Readonly<Record<string, number>> = Object.freeze({
  ok: 200, credPath: 0, credCookie: 0, credB64Body: 0, credBasic: 0, credBasicGet: 0, credThird: 0, thirdNoCred: 200, credBeaconQueued: 1,
  credBlob: 0, credForm: 0, credBig: 0, credWorker: 0, refreshCred: 0, secondLoginQ: 0, secondLoginBasic: 0,
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 資格情報を含まないページの送信は、削除の上書き・危険な語・読まないパスでも届く。
  overrideForm: 200, overrideMultipart: 200, overrideJson: 200, overrideQuery: 200, overrideXHM: 200, overrideXMO: 200, putMethod: 200, patchMethod: 200,
  dangerQueryEnc: 200, dangerFullwidth: 200, dangerPathEnc: 200, dangerLogout: 200, excludedPath: 200, refresh1: 200, refresh2: 200,
  // SFIX-1104-2: レビュー（SREV-1104-2）の x_ の場面。届くのは、読み取りの要求の ID だけの Basic（M1）だけ。
  x_basicLower: 0, x_basicUpper: 0, x_basicTwoSpaces: 0, x_basicLowerGet: 0, x_basicUpperTwoGet: 0, x_basicUrlSafeGet: 0, x_basicIdOnlyPost: 0,
  x_basicIdColonPost: 0, x_basicIdOnlyGet: 200, x_basicPwOnlyPost: 0, x_basicPwOnlyGet: 0, x_basicColonPwGet: 0, x_b64JsonNested: 0, x_b64JsonUrlSafe: 0,
  x_b64JsonBasic: 0, x_b64QueryGetEnc: 0, x_b64QueryGetRaw: 0, x_b64QueryGetUrlSafe: 0, x_b64QueryGetBasicEnc: 0, x_b64QueryGetSimple: 0,
  x_b64QueryPostEnc: 0, x_xHeaderPw: 0, x_xHeaderPwGet: 0, x_xHeaderBasic: 0, x_xHeaderBasicGet: 0, x_xHeaderId: 0,
});

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T36c: the automated script login stage with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;

  beforeAll(() => undefined);

  afterEach(async () => {
    await spa?.close();
    spa = undefined;
  });

  afterAll(() => undefined);

  const startSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  const credentialsOf = async (site: SpaAuthSite): Promise<{ readonly username: string; readonly password: string }> => {
    const values: string[] = [];
    await site.fillCredentials(async (_selector, value) => {
      values.push(value);
    });
    const [username = '', password = ''] = values;
    return { username, password };
  };

  const setupOf = (site: SpaAuthSite, sides: readonly string[]): AuthSetupV3 => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId: 'example-script-auto',
    profileRevision: 1,
    loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`,
    loginPostEndpoints: [],
    successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}[data-state="loaded"]` },
    sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
    excludedPaths: [SPA_APP_PATHS.logout],
    auditPathPrefixes: [],
    maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
    allowedIdpOrigins: [],
    automatedLogin: {
      usernameSelector: SPA_LOGIN_FIELDS.email,
      passwordSelector: SPA_LOGIN_FIELDS.password,
      submitSelector: SPA_LOGIN_FIELDS.submit,
      failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
    },
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    loginSideRequests: sides.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerLoginStage: ONE_SIDE_POST })),
    successStorageKey: { origin: site.appOrigin, ...FIXTURE_KEY },
  });

  /** 自動ログインの段を行う（`password` を変えると、誤ったパスワード）。 */
  const runStage = async (
    site: SpaAuthSite,
    options: { readonly passwordSuffix?: string; readonly sides?: readonly string[] } = {},
  ): Promise<AutomatedLoginStageResult> => {
    const credentials = await credentialsOf(site);
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.auth);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
    const result = await runAutomatedLoginStage({
      config,
      setup: setupOf(site, options.sides ?? []),
      approvedTestOrigins: [site.appOrigin],
      approvedServiceOrigins: [site.backendOrigin],
      expectedCredentialRevision: CREDENTIAL_REVISION,
      readCredentialMetadata: async () => ({ credentialRevision: CREDENTIAL_REVISION, loginOrigin: site.appOrigin }),
      readCredential: async () => ({
        credentialRevision: CREDENTIAL_REVISION,
        username: credentials.username,
        password: `${credentials.password}${options.passwordSuffix ?? ''}`,
      }),
      signal: new AbortController().signal,
    }, { launchAutomatedLoginBrowser: launch, resultTimeoutMs: RESULT_TIMEOUT_MS });
    await wait(LATE_REQUEST_WAIT_MS);
    return result;
  };

  /** バックエンドに届いた（事前確認でない）読み取りでない要求の path（query を除く）。 */
  const backendNonReads = (site: SpaAuthSite): readonly string[] => site.requests
    .filter((request) => request.origin !== 'app' && !request.preflight && !READ_METHODS.has(request.method))
    .map(({ path }) => path.split('?')[0] ?? '');
  /** 資格情報を URL に含む、アプリに届いた要求の数。 */
  const appRequestsCarrying = (site: SpaAuthSite, values: readonly string[]): number => site.requests
    .filter((request) => request.origin === 'app' && values.some((value) => request.path.includes(value) || request.path.includes(encodeURIComponent(value))))
    .length;

  it('authenticates with the token request, the stored session key and the success page', async () => {
    const site = await startSite({});
    const result = await runStage(site);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
    expect(site.successfulLogins).toBe(1);
    expect(result.scriptLogin?.tokenRequestsAllowed).toBe(1);
    expect(result.scriptLogin?.blockedByReason.LOGIN_CREDENTIAL_IN_REQUEST).toBe(0);
  }, TEST_TIMEOUT_MS);

  // SLIM L-3: 結果の後の観察の案（T43d fix round 1）は、単体 `login-observation.test.ts`（鍵の名前の形・ログインの画面の CSS を除く成功のセレクタ）と、
  // 自動ログインの段の観察のつながりの結合 `login-observation-hostile.test.ts`（'keeps no user name after the automated login'）へ任せた。

  // T36R-fix（ユーザーの判断「ログインの画面に form の要素がなければ止めるのでは監査が開始できない」）: form の要素のないログインの画面でも、値を入れて
  // 押し、token の送信 1 回で成功する（送信の要素は `button type="button"` と `role="button"`）。
  it.each<SpaLoginLayout>(['formless', 'roleButton'])('authenticates on the login page without a form element (%s)', async (loginLayout) => {
    const site = await startSite({ loginLayout });
    const result = await runStage(site);
    expect(result.kind).toBe('AUTHENTICATED');
    expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
    expect(site.successfulLogins).toBe(1);
    expect(result.scriptLogin?.tokenRequestsAllowed).toBe(1);
    expect(result.scriptLogin?.blockedByReason.LOGIN_CREDENTIAL_IN_REQUEST).toBe(0);
  }, TEST_TIMEOUT_MS);

  // SLIM L-3: 送信の要素が `href` のある `a` の form のない画面で値を入れずに止める場面は、検査の結合 `login-form-submitter.test.ts`
  // （'inspects the %s layout of a script login by reading only' の `linkSubmit`）と、検査の失敗を `LOGIN_FORM_INVALID` にする `automated-login.test.ts` へ任せた。
  // 429 の `RATE_LIMITED` と `Retry-After` の期限は、偽のワーカーの `control-audit-jobs-auto-login.test.ts`（429 の期限を待つ場面）と単体
  // `login-http-status-results.test.ts`・`auto-login-limits.test.ts`（`retryAfterUntilOf`）へ任せた。

  // T36R-fix（T36R の M-4。DEF-099 の印。SLIM L-3 で前の別の場面をここへ畳んだ）: token を送って応答がなかった回は、送った後に応答がなかった印
  // （`responseAfterSubmission: false`。親が試しを 2 回と数える）。応答のあった回（503 など）は付けない。
  // RB-12: 423・503 などの表の行は、単体 `automated-login-result-steps.test.ts`（結果の輪）と `login-http-status-results.test.ts`（表）へ任せた。
  it.each<readonly [string, SpaAuthSiteOptions, string | undefined, string, boolean]>([
    ['a wrong password (400)', {}, WRONG_PASSWORD_SUFFIX, 'INVALID_CREDENTIALS', false],
    ['no response', { tokenResponse: 'noResponse' }, undefined, 'AUTH_RESULT_UNKNOWN', true],
  ])('classifies %s from the token response, with the token request sent once', async (_name, options, passwordSuffix, expected, unanswered) => {
    const site = await startSite(options);
    const result = await runStage(site, passwordSuffix === undefined ? {} : { passwordSuffix });
    expect(result).toMatchObject({ kind: expected, submitted: 'YES', retryAfterUntil: null });
    expect((result as { readonly responseAfterSubmission?: false }).responseAfterSubmission).toBe(unanswered ? false : undefined);
    expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
    expect(result.scriptLogin?.tokenRequestsAllowed).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('stops with an unknown result when the default GET form submission carries the credentials, and nothing carrying them arrives', async () => {
    const site = await startSite({ nativeFormSubmit: true });
    const credentials = await credentialsOf(site);
    const result = await runStage(site);
    expect(result).toMatchObject({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN' });
    expect(result.scriptLogin?.blockedByReason.LOGIN_CREDENTIAL_IN_REQUEST).toBeGreaterThan(0);
    expect(appRequestsCarrying(site, [credentials.username, credentials.password])).toBe(0);
    expect(backendNonReads(site)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('does not succeed when a registered side request carried the credentials, even though the login passed', async () => {
    const site = await startSite({ sideRequestBeforeToken: 'jsonBody' });
    const result = await runStage(site, { sides: [SPA_BACKEND_PATHS.rpcLogLogin] });
    expect(result).toMatchObject({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES' });
    expect(result.scriptLogin?.blockedByReason.LOGIN_CREDENTIAL_IN_REQUEST).toBe(1);
    expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
  }, TEST_TIMEOUT_MS);

  // SFIX-1104（前の automated-login-probe）: 2 つのパスワードの形で、自動ログインの段の通し方を崩す要求を確かめる。
  it.each(PROBE_PASSWORD_KINDS)('SFIX-1104: delivers only the approved token request with the credentials, and the excluded path send without them (SD-2) (the %s password)', async (kind) => {
    const site: LoginProbeSite = await startLoginProbeSite({ passwordKind: kind });
    let browser: Browser | undefined;
    let factory: BrowserContextFactory | undefined;
    try {
      browser = await launch();
      const config = createTestConfig(site.appOrigin, '/auth', { audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
      factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
      const monitor = new LoginStageMonitor();
      const context = await factory.createLoginStageContext(config.viewports.primaryDesktop, {
        loginPostEndpoints: [],
        maxLoginPosts: 1,
        monitor,
        scriptRequest: {
          scriptLogin: { origin: site.svcOrigin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
          loginSideRequests: [],
          approvedServiceOrigins: [site.svcOrigin],
        },
        credentialGuard: createLoginCredentialGuard({ username: site.username, password: site.password }),
      });
      const page = await factory.createPassivePage(context);
      await page.goto(`${site.appOrigin}/auth`);
      await page.locator('#email').fill(site.username);
      await page.locator('#password').fill(site.password);
      await page.locator('#submit').click();
      await page.locator('#state[data-state="done"], #state[data-state="login-failed"]').waitFor({ state: 'attached', timeout: PROBE_RESULT_TIMEOUT_MS });
      const results = JSON.parse((await page.locator('#state').getAttribute('data-results')) ?? '{}') as Record<string, number>;
      const arrivals = (): string => JSON.stringify(site.records.filter(({ preflight }) => !preflight));
      const counted = arrivals();
      // 名前つきの時間だけ待って、遅れて届く要求（beacon など）を数え直す。
      await wait(PROBE_LATE_REQUEST_WAIT_MS);
      expect(arrivals()).toBe(counted);
      const delivered = site.records.filter(({ preflight }) => !preflight);

      expect(results).toEqual(PROBE_EXPECTED_RESULTS);
      // 資格情報を含んで届いたのは、承認した token の送信 1 回だけ。
      expect(delivered.filter(({ carriesCredential }) => carriesCredential).map(({ path, search }) => `${path}${search}`))
        .toEqual(['/auth/v1/token?grant_type=password']);
      // SFIX-1104-2 の C2: 読み取りでない要求で ID を含んで届いたのも、承認した token の送信だけ。読み取りの要求では、ID だけの Basic の GET の 1 件（M1）。
      const isRead = (method: string): boolean => READ_METHODS.has(method);
      expect(delivered.filter(({ carriesUsername, method }) => carriesUsername && !isRead(method)).map(({ path, search }) => `${path}${search}`))
        .toEqual(['/auth/v1/token?grant_type=password']);
      expect(delivered.filter(({ carriesUsername, method }) => carriesUsername && isRead(method)).map(({ path }) => path)).toEqual([READ_WITH_USERNAME_ONLY]);
      // SD-2: 読まないパスへの送信（資格情報を含まない）も届き、止めた行には載らない。
      expect(delivered.filter(({ path }) => path.startsWith(LOGIN_PROBE_EXCLUDED_PATH)).map(({ method }) => method)).toEqual(['POST']);
      const snapshot = monitor.snapshot();
      expect(snapshot.scriptRequest.tokenRequestsAllowed).toBe(1);
      expect(snapshot.blockedRequests.requests.filter(({ path }) => path.startsWith(LOGIN_PROBE_EXCLUDED_PATH))).toEqual([]);
      // 必須の query を保って query を足した 2 回目のログインの送信は、token の更新として通さない（通した一覧に token の送信先は、更新の 1 行だけ）。
      expect(snapshot.passedRequests.requests.filter(({ path }) => path === '/auth/v1/token').map(({ query }) => query?.values))
        .toEqual([[{ name: 'grant_type', value: 'refresh_token' }]]);
      expect(factory.getSafetyLedger(context).snapshot().invariantViolationCount).toBe(0);
      await factory.closePassiveContext(context);
    } finally {
      await factory?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await site.close();
    }
  }, PROBE_TEST_TIMEOUT_MS);
});
