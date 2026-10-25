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
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_LOGIN_FIELDS,
  SPA_SHARED_HEADER_LINK,
  SPA_STATE_ELEMENTS,
  SPA_TOKEN_RETRY_AFTER,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaLoginLayout,
} from '../helpers/spa-auth-site-fixture.js';
import { runAutomatedLoginStage, type AutomatedLoginStageResult } from '../../src/worker/automated-login.js';
import { DISCOVERY_LOGOUT_WORDS } from '../../src/discovery/classification-words.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
/** 送信の後に結果を待つ時間（ms。テストを速くする）。 */
const RESULT_TIMEOUT_MS = 10_000;
/** 各場面の終わりに、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const CREDENTIAL_REVISION = 1;
const EXISTING_NAME = '既存花子';
const WRONG_PASSWORD_SUFFIX = '-wrong';
const ONE_SIDE_POST = 1;
/** `Retry-After` の秒数（fixture の値）を ms にする係数。 */
const MS_PER_SECOND = 1_000;
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });

describe.each(LAUNCHERS)('T36c: the automated script login stage with %s', (_label, launch) => {
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

  // T43d fix round 1（Task 43 の設計書 4.4）: 自動ログインの段も、結果を待った後に観察する。新しく出た鍵の名前（成功の鍵の名前の案。値は持たない）と、
  // 凍結した成功の画面のセレクタの案（ログアウトのリンク。ログインの画面にもある見出しのリンクは案にならない）が出る。秘密の目印は観察に出ない。
  it('proposes the new key name and the success screen selector after the automated login', async () => {
    const site = await startSite({ sharedHeaderLink: true });
    const result = await runStage(site);
    expect(result.kind).toBe('AUTHENTICATED');
    // T43R-fix の C-1 (a)（意図して直した期待）: 鍵の名前は、最初と最後の部分の接頭辞と接尾辞の案だけ。
    expect(SPA_AUTH_STORAGE_KEY).toBe('fixture-auth-token');
    expect(result.loginObservation?.storageKeys).toEqual({ origin: site.appOrigin, shapes: [{ prefix: '', suffix: '-token' }], omitted: 0 });
    expect(result.loginObservation?.successSelector).toMatchObject({ selector: '#logout', kind: 'LOGOUT_CONTROL' });
    expect(DISCOVERY_LOGOUT_WORDS as readonly (string | null | undefined)[]).toContain(result.loginObservation?.successSelector?.logoutWord);
    const text = JSON.stringify(result.loginObservation);
    expect(text).not.toContain(SPA_SHARED_HEADER_LINK.id);
    expect(text).not.toContain(SPA_SHARED_HEADER_LINK.href);
    expect(site.secretValues().filter((marker) => text.includes(marker))).toEqual([]);
  }, TEST_TIMEOUT_MS);

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

  // T36R-fix: form の要素のない画面でも、送信の要素が `href` のある `a` なら、値を入れずに止める（送信なし）。
  it('stops before filling on the form-less login page whose submit element is a link', async () => {
    const site = await startSite({ loginLayout: 'linkSubmit' });
    const result = await runStage(site);
    expect(result).toMatchObject({ kind: 'LOGIN_FORM_INVALID', submitted: 'NO', formInvalidReason: 'SUBMIT_BUTTON_INVALID' });
    expect(backendNonReads(site)).toEqual([]);
    expect(site.successfulLogins).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [string, SpaAuthSiteOptions, string | undefined, string]>([
    ['a wrong password (400)', {}, WRONG_PASSWORD_SUFFIX, 'INVALID_CREDENTIALS'],
    ['a locked account (423)', { tokenResponse: 'locked' }, undefined, 'ACCOUNT_LOCKED'],
    ['a server error (503)', { tokenResponse: 'serverError' }, undefined, 'AUTH_RESULT_UNKNOWN'],
    ['no response', { tokenResponse: 'noResponse' }, undefined, 'AUTH_RESULT_UNKNOWN'],
  ])('classifies %s from the token response, with the token request sent once', async (_name, options, passwordSuffix, expected) => {
    const site = await startSite(options);
    const result = await runStage(site, passwordSuffix === undefined ? {} : { passwordSuffix });
    expect(result).toMatchObject({ kind: expected, submitted: 'YES', retryAfterUntil: null });
    expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
    expect(result.scriptLogin?.tokenRequestsAllowed).toBe(1);
  }, TEST_TIMEOUT_MS);

  // T36R-fix（T36R の M-4。DEF-099 の印）: token を送って応答がなかった回は、送った後に応答がなかった印（親が試しを 2 回と数える）。応答のあった回は付けない。
  it('marks no response to the token request with responseAfterSubmission false, and not a response', async () => {
    const unanswered = await runStage(await startSite({ tokenResponse: 'noResponse' }));
    expect(unanswered).toMatchObject({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', responseAfterSubmission: false });
    await spa?.close();
    spa = undefined;
    const answered = await runStage(await startSite({ tokenResponse: 'serverError' }));
    expect(answered).toMatchObject({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES' });
    expect('responseAfterSubmission' in answered).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('classifies a rate limit (429) with the time to try again from Retry-After', async () => {
    const site = await startSite({ tokenResponse: 'rateLimited' });
    const before = Date.now();
    const result = await runStage(site);
    expect(result).toMatchObject({ kind: 'RATE_LIMITED', submitted: 'YES' });
    const until = result.kind === 'RATE_LIMITED' ? result.retryAfterUntil?.getTime() ?? 0 : 0;
    expect(until).toBeGreaterThanOrEqual(before + Number(SPA_TOKEN_RETRY_AFTER) * MS_PER_SECOND - MS_PER_SECOND);
    expect(backendNonReads(site)).toEqual([SPA_BACKEND_PATHS.token]);
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
});
