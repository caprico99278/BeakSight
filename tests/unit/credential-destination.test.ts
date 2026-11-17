// MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1）: 資格情報の送信先の不変条件の判定（`src/control/auth/credential-destination.ts`）。
// - 1・2: プロファイルの作成と編集の口の判定（承認したサービスの Origin を足さない、作成・編集で自動ログインにしない）。
// - 3: 自動ログインのプロファイル（保存の前も後も）で、送信先の項目の表のどれが変わったか。送信先でない欄は数えない。手動のログインと、切り替えは当たらない。
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  CREDENTIAL_DESTINATION_ITEMS,
  authSetupCredentialDestinationChangesOf,
  newOriginsOf,
  profileCredentialDestinationChangesOf,
  profileSaveGuardRejectionOf,
  type CredentialDestinationItem,
  type CredentialDestinationProfile,
} from '../../src/control/auth/credential-destination.js';

const TEST_ORIGIN = 'http://127.0.0.1:4173';
const OTHER_TEST_ORIGIN = 'http://127.0.0.1:4174';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const AUTO = 'AUTOMATED_LOGIN';
const MANUAL = 'MANUAL_SESSION';

const PROFILE: CredentialDestinationProfile = Object.freeze({
  auth: AUTO,
  targetConfigPath: 'config/targets/example.json',
  approvedTestOrigins: [TEST_ORIGIN],
  approvedServiceOrigins: [SERVICE_ORIGIN],
});

const SETUP: AuthSetup = Object.freeze<AuthSetup>({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: 'example',
  profileRevision: 1,
  loginStartUrl: `${TEST_ORIGIN}/auth`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: '/auth' },
  excludedPaths: ['/auth/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#login',
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }, { name: 'scope', value: 'a' }] },
  loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rpc/resolve', method: 'POST', maxPerLoginStage: 2 }],
  successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '-token' },
});

const setupChanges = (after: AuthSetup, beforeAuth: string = AUTO, afterAuth: string = AUTO): readonly CredentialDestinationItem[] =>
  authSetupCredentialDestinationChangesOf({ beforeAuth: beforeAuth as 'AUTOMATED_LOGIN', afterAuth: afterAuth as 'AUTOMATED_LOGIN', before: SETUP, after });

describe('MI-F1: the save guard of the profile creation and edit (4.7.1 items 1 and 2)', () => {
  it('rejects adding a service origin in any auth, and accepts removing one', () => {
    expect(profileSaveGuardRejectionOf(null, { auth: MANUAL, approvedServiceOrigins: [SERVICE_ORIGIN] })).toBe('SERVICE_ORIGIN_ADD_NOT_OBSERVED');
    expect(profileSaveGuardRejectionOf({ auth: MANUAL, approvedServiceOrigins: [SERVICE_ORIGIN] }, { auth: MANUAL, approvedServiceOrigins: [SERVICE_ORIGIN, OTHER_ORIGIN] }))
      .toBe('SERVICE_ORIGIN_ADD_NOT_OBSERVED');
    expect(profileSaveGuardRejectionOf({ auth: AUTO, approvedServiceOrigins: [SERVICE_ORIGIN] }, { auth: MANUAL, approvedServiceOrigins: [SERVICE_ORIGIN, OTHER_ORIGIN] }))
      .toBe('SERVICE_ORIGIN_ADD_NOT_OBSERVED');
    expect(profileSaveGuardRejectionOf({ auth: MANUAL, approvedServiceOrigins: [SERVICE_ORIGIN, OTHER_ORIGIN] }, { auth: MANUAL, approvedServiceOrigins: [OTHER_ORIGIN] }))
      .toBeNull();
    expect(profileSaveGuardRejectionOf(null, { auth: MANUAL })).toBeNull();
  });

  it('rejects making the auth AUTOMATED_LOGIN by the creation or the edit, and accepts keeping it or going back to MANUAL_SESSION', () => {
    expect(profileSaveGuardRejectionOf(null, { auth: AUTO })).toBe('AUTOMATED_LOGIN_SWITCH_REQUIRED');
    expect(profileSaveGuardRejectionOf({ auth: MANUAL }, { auth: AUTO })).toBe('AUTOMATED_LOGIN_SWITCH_REQUIRED');
    expect(profileSaveGuardRejectionOf({ auth: AUTO }, { auth: AUTO })).toBeNull();
    expect(profileSaveGuardRejectionOf({ auth: AUTO }, { auth: MANUAL })).toBeNull();
  });

  it('counts a new origin once, by the canonical origin', () => {
    expect(newOriginsOf([SERVICE_ORIGIN], [SERVICE_ORIGIN, OTHER_ORIGIN, OTHER_ORIGIN])).toEqual([OTHER_ORIGIN]);
    expect(newOriginsOf([], ['not an origin'])).toEqual(['not an origin']);
  });
});

describe('MI-F1: the credential destination items of an AUTOMATED_LOGIN profile (4.7.1 item 3)', () => {
  it('has one closed list of the destination items', () => {
    expect(CREDENTIAL_DESTINATION_ITEMS).toEqual([
      'TARGET_CONFIG', 'TEST_ORIGINS_ADDED', 'SERVICE_ORIGINS_ADDED', 'LOGIN_START_URL', 'LOGIN_TRANSPORT', 'SCRIPT_LOGIN_TARGET', 'LOGIN_SIDE_REQUESTS',
      'LOGIN_POST_ENDPOINTS', 'AUTOMATED_LOGIN_SELECTORS', 'IDP_ORIGINS_ADDED',
    ]);
  });

  it.each<readonly [CredentialDestinationItem, Partial<CredentialDestinationProfile>]>([
    ['TARGET_CONFIG', { targetConfigPath: 'config/targets/other.json' }],
    ['TEST_ORIGINS_ADDED', { approvedTestOrigins: [TEST_ORIGIN, OTHER_TEST_ORIGIN] }],
    ['SERVICE_ORIGINS_ADDED', { approvedServiceOrigins: [SERVICE_ORIGIN, OTHER_ORIGIN] }],
  ])('finds %s in the profile', (item, change) => {
    expect(profileCredentialDestinationChangesOf(PROFILE, { ...PROFILE, ...change })).toEqual([item]);
  });

  it.each<readonly [CredentialDestinationItem, Partial<AuthSetup>]>([
    ['LOGIN_START_URL', { loginStartUrl: `${TEST_ORIGIN}/other` }],
    ['SCRIPT_LOGIN_TARGET', { scriptLogin: { ...SETUP.scriptLogin!, origin: OTHER_ORIGIN } }],
    ['SCRIPT_LOGIN_TARGET', { scriptLogin: { ...SETUP.scriptLogin!, path: '/other' } }],
    ['SCRIPT_LOGIN_TARGET', { scriptLogin: { ...SETUP.scriptLogin!, requiredQuery: [{ name: 'grant_type', value: 'password' }] } }],
    ['LOGIN_SIDE_REQUESTS', { loginSideRequests: [...SETUP.loginSideRequests, { origin: SERVICE_ORIGIN, path: '/rpc/x', method: 'POST', maxPerLoginStage: 1 }] }],
    ['LOGIN_SIDE_REQUESTS', { loginSideRequests: [{ ...SETUP.loginSideRequests[0]!, maxPerLoginStage: 3 }] }],
    ['LOGIN_POST_ENDPOINTS', { loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/collect' }] }],
    ['AUTOMATED_LOGIN_SELECTORS', { automatedLogin: { ...SETUP.automatedLogin!, submitSelector: '#other' } }],
    ['IDP_ORIGINS_ADDED', { allowedIdpOrigins: [OTHER_ORIGIN] }],
  ])('finds %s in the auth setup', (item, change) => {
    expect(setupChanges({ ...SETUP, ...change })).toEqual([item]);
  });

  it('finds the login transport with the items it moves', () => {
    expect(setupChanges({ ...SETUP, loginTransport: 'FORM_NAVIGATION', scriptLogin: null, loginSideRequests: [], successStorageKey: null, loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/auth' }] }))
      .toEqual(['LOGIN_TRANSPORT', 'SCRIPT_LOGIN_TARGET', 'LOGIN_POST_ENDPOINTS']);
  });

  it('does not count the fields that are not destinations, nor fewer destinations', () => {
    expect(setupChanges({
      ...SETUP,
      profileRevision: 2,
      excludedPaths: ['/auth/logout', '/danger'],
      auditPathPrefixes: ['/admin'],
      successCondition: { pathPrefix: '/home', selector: '.ok' },
      sessionLostCondition: { pathPrefix: null },
      maxLoginAttempts: 1,
      automatedLogin: { ...SETUP.automatedLogin!, failureConditions: { ...SETUP.automatedLogin!.failureConditions, mfaRequired: { pathPrefix: '/mfa', selector: null } } },
      scriptLogin: { ...SETUP.scriptLogin!, requiredQuery: [...SETUP.scriptLogin!.requiredQuery].reverse() },
      loginSideRequests: [{ ...SETUP.loginSideRequests[0]!, maxPerLoginStage: 1 }],
      successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-token' },
    })).toEqual([]);
    expect(setupChanges({ ...SETUP, loginSideRequests: [] })).toEqual([]);
    expect(profileCredentialDestinationChangesOf(PROFILE, { ...PROFILE, approvedServiceOrigins: [] })).toEqual([]);
  });

  it('applies only when the profile is AUTOMATED_LOGIN before and after, and when an auth setup is saved', () => {
    const moved: AuthSetup = { ...SETUP, loginStartUrl: `${TEST_ORIGIN}/other` };
    expect(setupChanges(moved, MANUAL, AUTO)).toEqual([]);
    expect(setupChanges(moved, AUTO, MANUAL)).toEqual([]);
    expect(setupChanges(moved, MANUAL, MANUAL)).toEqual([]);
    expect(authSetupCredentialDestinationChangesOf({ beforeAuth: AUTO, afterAuth: AUTO, before: null, after: moved })).toEqual([]);
    expect(profileCredentialDestinationChangesOf({ ...PROFILE, auth: MANUAL }, { ...PROFILE, targetConfigPath: 'config/targets/other.json' })).toEqual([]);
  });
});

// MI-F5（設計書 4.7.1 の 6。再レビュー MI-R2 の Critical C-A）: ログインの送信先は、観察からだけ入る（方式によらない）。画面の保存の口が、判定の選択肢
// （`observedOnly`）を渡す。認証の設定があるときは、今保存してある設定（と、口が渡す観察の案）と比べる。ないときは、口が渡す案（入口の確かめの案）か、送信先の
// ない形（ログインの画面の URL だけ）と比べる。
describe('MI-F5: the login destination comes from the observation only, in any auth (4.7.1 item 6)', () => {
  const MANUAL_SETUP: AuthSetup = { ...SETUP, automatedLogin: null };
  const observedChanges = (input: { before: AuthSetup | null; after: AuthSetup; baselines?: readonly AuthSetup[] }): readonly CredentialDestinationItem[] =>
    authSetupCredentialDestinationChangesOf({
      beforeAuth: MANUAL, afterAuth: MANUAL, before: input.before, after: input.after, observedOnly: { baselines: input.baselines ?? [] },
    } as Parameters<typeof authSetupCredentialDestinationChangesOf>[0]);

  it('finds the destination changes of a MANUAL_SESSION profile, and not the other fields', () => {
    expect(observedChanges({ before: MANUAL_SETUP, after: { ...MANUAL_SETUP, scriptLogin: { ...SETUP.scriptLogin!, path: '/evil' } } })).toEqual(['SCRIPT_LOGIN_TARGET']);
    expect(observedChanges({ before: MANUAL_SETUP, after: { ...MANUAL_SETUP, loginSideRequests: [{ origin: TEST_ORIGIN, path: '/collect', method: 'POST', maxPerLoginStage: 1 }] } }))
      .toEqual(['LOGIN_SIDE_REQUESTS']);
    expect(observedChanges({ before: MANUAL_SETUP, after: { ...MANUAL_SETUP, excludedPaths: ['/danger'], loginSideRequests: [] } })).toEqual([]);
  });

  it('accepts the destination of one of the baselines (the observation of a row)', () => {
    const observed: AuthSetup = { ...MANUAL_SETUP, scriptLogin: { origin: OTHER_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] } };
    expect(observedChanges({ before: MANUAL_SETUP, after: observed, baselines: [observed] })).toEqual([]);
    expect(observedChanges({ before: MANUAL_SETUP, after: { ...observed, scriptLogin: { ...observed.scriptLogin!, path: '/evil' } }, baselines: [observed] }))
      .toEqual(['SCRIPT_LOGIN_TARGET']);
  });

  it('accepts a first save that is the proposal, or that has no destination but the login page URL', () => {
    const proposal: AuthSetup = {
      ...MANUAL_SETUP, loginTransport: 'FORM_NAVIGATION', loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/session' }], scriptLogin: null, loginSideRequests: [],
      successStorageKey: null,
    };
    expect(observedChanges({ before: null, after: { ...proposal, excludedPaths: ['/danger'] }, baselines: [proposal] })).toEqual([]);
    expect(observedChanges({ before: null, after: { ...proposal, loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/collect' }] }, baselines: [proposal] }))
      .toEqual(['LOGIN_POST_ENDPOINTS']);
    const none: AuthSetup = { ...MANUAL_SETUP, loginStartUrl: `${TEST_ORIGIN}/any-login`, scriptLogin: null, loginSideRequests: [], successStorageKey: null };
    expect(observedChanges({ before: null, after: none })).toEqual([]);
    expect(observedChanges({ before: null, after: MANUAL_SETUP }).length).toBeGreaterThan(0);
    // 案にログインの画面の URL がない（伏せた path）ときは、人が入れたログインの画面の URL を受ける。
    expect(observedChanges({ before: null, after: { ...proposal, loginStartUrl: `${TEST_ORIGIN}/login` }, baselines: [{ ...proposal, loginStartUrl: '' }] })).toEqual([]);
    // 自動ログインのセレクタも送信先（送信先のない形では持てない）。
    expect(observedChanges({ before: null, after: { ...none, automatedLogin: SETUP.automatedLogin } })).toContain('AUTOMATED_LOGIN_SELECTORS');
  });

  it('keeps the rule of item 3 when the option is not given', () => {
    expect(authSetupCredentialDestinationChangesOf({ beforeAuth: MANUAL, afterAuth: MANUAL, before: MANUAL_SETUP, after: { ...MANUAL_SETUP, loginStartUrl: `${TEST_ORIGIN}/x` } }))
      .toEqual([]);
  });
});
