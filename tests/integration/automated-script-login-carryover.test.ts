// T36R-fix（Task 36 の独立レビュー T36R の C-4・M-8。設計書 7 章の T36R の行）: スクリプトで送るログインの自動ログインの段（`runAutomatedLoginStage`）が、
// 成功を返す前に、引き継ぐ状態（Cookie の名前と値、ローカル ストレージの鍵と値）を資格情報の守りの部品で比べる。Chromium はテストの既定の headless と、
// CLI の起動の設定の両方。サイトはテストだけのサイト（`startCredentialLeakSite`）。
// - C-4: ページがパスワードをローカル ストレージか、どの要求にも付かない Cookie に置いたら、`AUTH_RESULT_UNKNOWN`（送信 `YES`）で止め、状態を返さない
//   （監査の段に持ち越さない）。
// - M-8（設計者の既定）: ユーザー名は、引き継ぐ状態と読み取りでは比べない（ユーザー名で読む SPA、セッションの保存にユーザー名を持つ SPA は成功する）。
// - T36R-fix（ユーザーの判断。form の要素のないログインの画面）: form の要素のない画面でも、C-1（登録した送信のヘッダ）と C-2（URL にそのまま連結した
//   空白と `/` を含むパスワード）の持ち出しを止め（`AUTH_RESULT_UNKNOWN`）、パスワードを運ぶ要求はサーバに届かない。
import type { Browser } from 'playwright';
import { describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { runAutomatedLoginStage, type AutomatedLoginStageResult } from '../../src/worker/automated-login.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import {
  LEAK_SITE_FORMLESS_QUERY,
  LEAK_SITE_PATHS,
  LEAK_SITE_SUCCESS_KEY,
  recordCarries,
  startCredentialLeakSite,
  type CredentialLeakSite,
  type LeakSiteScenario,
} from '../helpers/credential-leak-site.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
/** 送信の後に結果を待つ時間（ms。テストを速くする）。 */
const RESULT_TIMEOUT_MS = 10_000;
const CREDENTIAL_REVISION = 1;
const CREDENTIALS = Object.freeze({ username: 'synth.user01@example.invalid', password: 'Zq9Kx7Lp3Wm' });
/** T36R-fix: C-2 の形（空白と `/` を含むパスワード。ブラウザが URL で一部の文字だけを % の形にする）。 */
const SPACED_CREDENTIALS = Object.freeze({ username: 'synth.user02@example.invalid', password: 'Zq9 Kx/7Lp' });
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 500;

/** 段を行った結果と、パスワードを運んでサーバに届いた要求の数。 */
interface StageRun {
  readonly result: AutomatedLoginStageResult;
  readonly carrying: number;
}

/** 段の行い方の指定（省略は `CREDENTIALS` と form の画面）。 */
interface StageOptions {
  readonly credentials?: { readonly username: string; readonly password: string };
  readonly formless?: boolean;
}

describe.each(LAUNCHERS)('T36R-fix: the carried-over state of the automated script login with %s', (_label, launch) => {
  const setupOf = (site: CredentialLeakSite, scenario: LeakSiteScenario, formless: boolean): AuthSetupV3 => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
    profileId: 'example-script-auto',
    profileRevision: 1,
    loginStartUrl: `${site.appOrigin}${LEAK_SITE_PATHS.auth}?s=${scenario}${formless ? LEAK_SITE_FORMLESS_QUERY : ''}`,
    loginPostEndpoints: [],
    successCondition: { pathPrefix: LEAK_SITE_PATHS.admin, selector: '#ok[data-state="loaded"]' },
    sessionLostCondition: { pathPrefix: LEAK_SITE_PATHS.auth },
    excludedPaths: [],
    auditPathPrefixes: [],
    maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
    allowedIdpOrigins: [],
    automatedLogin: {
      usernameSelector: '#u',
      passwordSelector: '#p',
      submitSelector: '#b',
      failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
    },
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: site.tokenOrigin, path: LEAK_SITE_PATHS.token, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [],
    successStorageKey: { origin: site.appOrigin, ...LEAK_SITE_SUCCESS_KEY },
  });

  const runStageOn = async (scenario: LeakSiteScenario, options: StageOptions = {}): Promise<StageRun> => {
    const credentials = options.credentials ?? CREDENTIALS;
    const site = await startCredentialLeakSite(credentials.username, credentials.password);
    try {
      const base = fastRunConfig(site.appOrigin, LEAK_SITE_PATHS.auth);
      const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${LEAK_SITE_PATHS.auth}`, allowedOrigins: [site.appOrigin] } };
      const result = await runAutomatedLoginStage({
        config,
        setup: setupOf(site, scenario, options.formless === true),
        approvedTestOrigins: [site.appOrigin],
        approvedServiceOrigins: [site.tokenOrigin, site.sideOrigin],
        expectedCredentialRevision: CREDENTIAL_REVISION,
        readCredentialMetadata: async () => ({ credentialRevision: CREDENTIAL_REVISION, loginOrigin: site.appOrigin }),
        readCredential: async () => ({ credentialRevision: CREDENTIAL_REVISION, ...credentials }),
        signal: new AbortController().signal,
      }, { launchAutomatedLoginBrowser: launch, resultTimeoutMs: RESULT_TIMEOUT_MS });
      await wait(LATE_REQUEST_WAIT_MS);
      // token の送信（T）のほかで、パスワードを運んで届いた要求の数。
      const carrying = site.records.filter((record) => record.origin !== 'T' && recordCarries(credentials.password, record)).length;
      return { result, carrying };
    } finally {
      await site.close();
    }
  };

  const runStage = async (scenario: LeakSiteScenario): Promise<AutomatedLoginStageResult> => (await runStageOn(scenario)).result;

  it.each<LeakSiteScenario>(['localStash', 'cookieStash'])(
    'C-4: stops with an unknown result and returns no state when the page put the password in the state (%s)',
    async (scenario) => {
      const result = await runStage(scenario);
      expect(result).toMatchObject({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES' });
      expect('state' in result).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it.each<LeakSiteScenario>(['none', 'usernameRead', 'usernameStash'])('M-8: authenticates with %s (the user name is not compared on reads and in the state)', async (scenario) => {
    const result = await runStage(scenario);
    expect(result.kind).toBe('AUTHENTICATED');
  }, TEST_TIMEOUT_MS);

  it('authenticates on the login page without a form element (no leak)', async () => {
    const { result, carrying } = await runStageOn('none', { formless: true });
    expect(result.kind).toBe('AUTHENTICATED');
    expect(carrying).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each<readonly [string, LeakSiteScenario, NonNullable<StageOptions['credentials']>]>([
    ['C-1: a header of the registered side request', 'hdrSide', CREDENTIALS],
    ['C-2: the password concatenated raw into the URL query (a space and a slash)', 'rawQuery', SPACED_CREDENTIALS],
  ])('stops %s on the login page without a form element, and nothing carrying the password arrives', async (_name, scenario, credentials) => {
    const { result, carrying } = await runStageOn(scenario, { formless: true, credentials });
    expect(result).toMatchObject({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES' });
    expect(result.scriptLogin?.blockedByReason.LOGIN_CREDENTIAL_IN_REQUEST).toBeGreaterThan(0);
    expect(carrying).toBe(0);
  }, TEST_TIMEOUT_MS);
});
