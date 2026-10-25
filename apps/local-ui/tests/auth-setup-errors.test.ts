/**
 * 認証の設定の検証の誤りを、画面の項目ごとに分ける部品（`src/server/auth-setup-errors.ts`。Task 25 の設計書 4.5。T25e）の確かめ。
 * - 誤りは、検証の owner（`validateAuthSetup`）が実際に返す誤りで確かめる（誤りの文の形を、テストに書き写さない）。
 * - 画面に返すのは、コードと項目と行だけ（英語の詳細は返さない）。
 * 例の値は、匿名の値（`example.invalid`）だけを使う。子の process もブラウザも使わない。
 */
import { describe, expect, it } from 'vitest';
import {  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  MAX_SUCCESS_SELECTOR_LENGTH,
  type AuthSetup,
} from '../../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../../../tests/helpers/auth-setup-samples.js';
import { validateAuthSetup } from '../../../src/control/auth/auth-setup-policy.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile, type ValidatedSiteProfile } from '../../../src/control/contracts.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../../src/control/profile-policy.js';
import { createTestConfig } from '../../../tests/helpers/test-config.js';
import { authSetupErrorViewsOf, type AuthSetupErrorView } from '../src/server/auth-setup-errors';

const TEST_ORIGIN = 'https://app.example.invalid';
const UNAPPROVED_ORIGIN = 'https://other.example.invalid';

const context: ProfileValidationContext = {
  targetConfig: { ...createTestConfig(TEST_ORIGIN), site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN, UNAPPROVED_ORIGIN] } },
};

const profileInput = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-auth-errors',
  revision: 2,
  targetConfigPath: 'config/targets/example-auth-errors.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: 'evidence/example-auth-errors/isolation-check-1',
} satisfies SiteProfile;

const profileOf = (input: SiteProfile): ValidatedSiteProfile => {
  const result = validateSiteProfile(input, context);
  if (!result.ok) {
    throw new Error(`the test profile was rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.profile;
};

const validSetup = {
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: profileInput.profileId,
  profileRevision: profileInput.revision,
  loginStartUrl: `${TEST_ORIGIN}/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: '#menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
} satisfies AuthSetup;

/** 検証の owner に通し、画面の誤りの値にする。 */
const viewsOf = (input: Record<string, unknown>, profile: SiteProfile = profileInput): readonly AuthSetupErrorView[] => {
  const result = validateAuthSetup(input, profileOf(profile), context);
  if (result.ok) {
    throw new Error('the test setup was accepted');
  }
  return authSetupErrorViewsOf(result.errors);
};

const withSetup = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...validSetup, ...overrides });

describe('T25e: the auth setup errors are split by the form fields', () => {
  it('accepts the valid setup (the base of the cases)', () => {
    expect(validateAuthSetup(validSetup, profileOf(profileInput), context).ok).toBe(true);
  });

  it.each([
    ['loginStartUrl', withSetup({ loginStartUrl: 'ftp://app.example.invalid/login' }), { code: 'AUTH_SETUP_URL_INVALID', field: 'loginStartUrl', line: null }],
    ['loginStartUrl', withSetup({ loginStartUrl: `${UNAPPROVED_ORIGIN}/login` }), { code: 'AUTH_SETUP_ORIGIN_NOT_APPROVED', field: 'loginStartUrl', line: null }],
    ['loginStartUrl', withSetup({ loginStartUrl: `${TEST_ORIGIN}/login?token=x` }), { code: 'AUTH_SETUP_SECRET_LIKE_VALUE', field: 'loginStartUrl', line: null }],
    [
      'loginPostEndpoints',
      withSetup({ loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }, { origin: UNAPPROVED_ORIGIN, path: '/login' }] }),
      { code: 'AUTH_SETUP_ORIGIN_NOT_APPROVED', field: 'loginPostEndpoints', line: 2 },
    ],
    [
      'loginPostEndpoints',
      withSetup({ loginPostEndpoints: [{ origin: TEST_ORIGIN, path: 'login' }] }),
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'loginPostEndpoints', line: 1 },
    ],
    [
      'successPathPrefix',
      withSetup({ successCondition: { pathPrefix: '/', selector: null } }),
      { code: 'AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS', field: 'successPathPrefix', line: null },
    ],
    [
      'successSelector',
      withSetup({ successCondition: { pathPrefix: '/admin', selector: '   ' } }),
      { code: 'AUTH_SETUP_SELECTOR_INVALID', field: 'successSelector', line: null },
    ],
    [
      'sessionLostPathPrefix',
      withSetup({ sessionLostCondition: { pathPrefix: 'login' } }),
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'sessionLostPathPrefix', line: null },
    ],
    ['excludedPaths', withSetup({ excludedPaths: ['/admin/logout', '/a/../b'] }), { code: 'AUTH_SETUP_PATH_INVALID', field: 'excludedPaths', line: 2 }],
    ['auditPathPrefixes', withSetup({ auditPathPrefixes: ['admin'] }), { code: 'AUTH_SETUP_PATH_INVALID', field: 'auditPathPrefixes', line: 1 }],
    [
      'maxLoginAttempts',
      withSetup({ maxLoginAttempts: MAX_LOGIN_ATTEMPTS + 1 }),
      { code: 'AUTH_SETUP_LIMIT_EXCEEDED', field: 'maxLoginAttempts', line: null },
    ],
  ] as const)('puts the error on the field %s', (_field, input, expected) => {
    expect(viewsOf(input)).toContainEqual(expected);
  });

  it('puts the schema errors on the field of their JSON pointer (and the missing property)', () => {
    expect(viewsOf(withSetup({ excludedPaths: ['/a', 7] }))).toContainEqual({ code: 'AUTH_SETUP_SCHEMA_INVALID', field: 'excludedPaths', line: 2 });
    const { loginStartUrl: _omitted, ...withoutLoginStartUrl } = validSetup;
    expect(viewsOf(withoutLoginStartUrl)).toContainEqual({ code: 'AUTH_SETUP_SCHEMA_INVALID', field: 'loginStartUrl', line: null });
  });

  it('puts the errors that are not about one field above the form (field null)', () => {
    expect(viewsOf(withSetup({ profileRevision: 1 }))).toEqual([{ code: 'AUTH_SETUP_PROFILE_REVISION_MISMATCH', field: null, line: null }]);
    expect(viewsOf(withSetup({ allowedIdpOrigins: [UNAPPROVED_ORIGIN] }))).toEqual([{ code: 'AUTH_SETUP_IDP_NOT_SUPPORTED', field: null, line: null }]);
    expect(viewsOf(withSetup({ unexpected: true }))).toEqual([{ code: 'AUTH_SETUP_SCHEMA_INVALID', field: null, line: null }]);
  });

  it('removes the duplicates and returns no English detail', () => {
    const views = viewsOf(withSetup({ excludedPaths: ['a', 'b'], auditPathPrefixes: ['c'] }));
    expect(views).toEqual([
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'excludedPaths', line: 1 },
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'excludedPaths', line: 2 },
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'auditPathPrefixes', line: 1 },
    ]);
    expect(Object.isFrozen(views)).toBe(true);
    expect(authSetupErrorViewsOf([
      { code: 'AUTH_SETUP_URL_INVALID', detail: 'loginStartUrl must be an absolute http(s) URL', pointer: '/loginStartUrl' },
      { code: 'AUTH_SETUP_URL_INVALID', detail: 'loginStartUrl must be an absolute http(s) URL', pointer: '/loginStartUrl' },
    ])).toEqual([{ code: 'AUTH_SETUP_URL_INVALID', field: 'loginStartUrl', line: null }]);
  });
});

// CCX-23（CC-061）: 項目と行は、検証の owner が誤りに付ける位置（JSON Pointer）から決める。英語の詳細は読まない。
describe('CCX-23: the field and the line come from the pointer of the error, not from its English detail', () => {
  /** 検証の owner の誤りの位置（誤りの順）。 */
  const pointersOf = (input: Record<string, unknown>, profile: SiteProfile = profileInput): readonly (string | null)[] => {
    const result = validateAuthSetup(input, profileOf(profile), context);
    if (result.ok) {
      throw new Error('the test setup was accepted');
    }
    return result.errors.map(({ pointer }) => pointer);
  };

  it('gives the pointer of the field, the missing property, the whole document, or none', () => {
    expect(pointersOf(withSetup({ loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }, { origin: UNAPPROVED_ORIGIN, path: 'x' }] })))
      .toEqual(['/loginPostEndpoints/1/origin', '/loginPostEndpoints/1/path']);
    expect(pointersOf(withSetup({ excludedPaths: ['/a', 7] }))).toEqual(['/excludedPaths/1']);
    const { loginStartUrl: _omitted, ...withoutLoginStartUrl } = validSetup;
    expect(pointersOf(withoutLoginStartUrl)).toEqual(['/loginStartUrl']);
    expect(pointersOf(withSetup({ unexpected: true }))).toEqual(['']);
    expect(pointersOf(withSetup({ profileRevision: 1 }))).toEqual(['/profileRevision']);
    expect(pointersOf(withSetup({ allowedIdpOrigins: [UNAPPROVED_ORIGIN] }))).toEqual(['/allowedIdpOrigins']);
    expect(pointersOf(withSetup({ loginStartUrl: (): number => 1 }))).toEqual([null]);
  });

  it('does not read the English detail', () => {
    const detail = 'excludedPaths[1] and loginStartUrl are named only in this detail';
    expect(authSetupErrorViewsOf([
      { code: 'AUTH_SETUP_PATH_INVALID', detail, pointer: '/auditPathPrefixes/0' },
      { code: 'AUTH_SETUP_PATH_INVALID', detail, pointer: null },
      { code: 'AUTH_SETUP_PATH_INVALID', detail, pointer: '' },
    ])).toEqual([
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'auditPathPrefixes', line: 1 },
      { code: 'AUTH_SETUP_PATH_INVALID', field: null, line: null },
    ]);
  });

  it('takes the longest field location, and the line only from an array position of a list field', () => {
    expect(authSetupErrorViewsOf([
      { code: 'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS', detail: '', pointer: '/automatedLogin/failureConditions/mfaRequired' },
      { code: 'AUTH_SETUP_SELECTOR_INVALID', detail: '', pointer: '/automatedLogin/failureConditions/mfaRequired/selector' },
      { code: 'AUTH_SETUP_SCHEMA_INVALID', detail: '', pointer: '/successCondition' },
      { code: 'AUTH_SETUP_SCHEMA_INVALID', detail: '', pointer: '/loginPostEndpoints/x' },
      { code: 'AUTH_SETUP_LIMIT_EXCEEDED', detail: '', pointer: '/maxLoginAttempts/0' },
      { code: 'AUTH_SETUP_SCHEMA_INVALID', detail: '', pointer: '/excludedPathsX/0' },
    ])).toEqual([
      { code: 'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS', field: 'mfaRequiredPathPrefix', line: null },
      { code: 'AUTH_SETUP_SELECTOR_INVALID', field: 'mfaRequiredSelector', line: null },
      { code: 'AUTH_SETUP_SCHEMA_INVALID', field: null, line: null },
      { code: 'AUTH_SETUP_SCHEMA_INVALID', field: 'loginPostEndpoints', line: null },
      { code: 'AUTH_SETUP_LIMIT_EXCEEDED', field: 'maxLoginAttempts', line: null },
    ]);
  });
});

// T26e（Task 26 の設計書 4.3）: 自動ログインの項目（3 つのセレクタ、4 つの失敗の条件のパスとセレクタ）の誤りを、画面の項目ごとに分ける。
describe('T26e: the automated login errors are split by the form fields', () => {
  const automatedProfile = { ...profileInput, auth: 'AUTOMATED_LOGIN' } satisfies SiteProfile;
  const automatedLogin = {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#go',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/login-error', selector: '#invalid' },
      accountLocked: { pathPrefix: '/locked', selector: null },
      mfaRequired: null,
      credentialExpired: null,
    },
  };
  const automatedSetup = { ...validSetup, maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, automatedLogin };
  const withAutomated = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    ...automatedSetup,
    automatedLogin: { ...automatedLogin, ...overrides },
  });
  const withConditions = (overrides: Record<string, unknown>): Record<string, unknown> =>
    withAutomated({ failureConditions: { ...automatedLogin.failureConditions, ...overrides } });
  const automatedViewsOf = (input: Record<string, unknown>): readonly AuthSetupErrorView[] => viewsOf(input, automatedProfile);

  it('accepts the valid automated login setup (the base of the cases)', () => {
    expect(validateAuthSetup(automatedSetup, profileOf(automatedProfile), context).ok).toBe(true);
  });

  it.each([
    ['usernameSelector', withAutomated({ usernameSelector: '   ' }), { code: 'AUTH_SETUP_SELECTOR_INVALID', field: 'usernameSelector', line: null }],
    ['passwordSelector', withAutomated({ passwordSelector: '#a\nb' }), { code: 'AUTH_SETUP_SELECTOR_INVALID', field: 'passwordSelector', line: null }],
    [
      'submitSelector',
      withAutomated({ submitSelector: `#${'s'.repeat(MAX_SUCCESS_SELECTOR_LENGTH)}` }),
      { code: 'AUTH_SETUP_LIMIT_EXCEEDED', field: 'submitSelector', line: null },
    ],
    [
      'usernameSelector',
      withAutomated({ passwordSelector: '#user' }),
      { code: 'AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED', field: 'usernameSelector', line: null },
    ],
    [
      'accountLockedPathPrefix',
      withConditions({ accountLocked: { pathPrefix: 'locked', selector: null } }),
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'accountLockedPathPrefix', line: null },
    ],
    [
      'mfaRequiredSelector',
      withConditions({ mfaRequired: { pathPrefix: '/mfa', selector: '   ' } }),
      { code: 'AUTH_SETUP_SELECTOR_INVALID', field: 'mfaRequiredSelector', line: null },
    ],
    [
      'invalidCredentialsPathPrefix',
      withConditions({ invalidCredentials: { pathPrefix: '/admin', selector: null } }),
      { code: 'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS', field: 'invalidCredentialsPathPrefix', line: null },
    ],
    [
      'credentialExpiredPathPrefix',
      withConditions({ credentialExpired: { pathPrefix: '/locked', selector: '#expired' } }),
      { code: 'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS', field: 'credentialExpiredPathPrefix', line: null },
    ],
    [
      'credentialExpiredPathPrefix',
      withConditions({ credentialExpired: { pathPrefix: 7, selector: null } }),
      { code: 'AUTH_SETUP_SCHEMA_INVALID', field: 'credentialExpiredPathPrefix', line: null },
    ],
    [
      'maxLoginAttempts',
      { ...automatedSetup, maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS + 1 },
      { code: 'AUTH_SETUP_LIMIT_EXCEEDED', field: 'maxLoginAttempts', line: null },
    ],
  ] as const)('puts the error on the field %s', (_field, input, expected) => {
    expect(automatedViewsOf(input)).toContainEqual(expected);
  });

  it('puts the missing automated login settings above the form (field null)', () => {
    expect(automatedViewsOf({ ...automatedSetup, automatedLogin: null })).toEqual([
      { code: 'AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED', field: null, line: null },
    ]);
  });
});

// T34d（Task 34 の設計書 3.2、3.6）: 版 3（スクリプトで送るログイン）の誤りも、検証の owner が付ける位置で、画面の欄と行に分ける。
const SERVICE_ORIGIN = 'https://service.example.invalid';
const serviceProfileInput = { ...profileInput, approvedServiceOrigins: [SERVICE_ORIGIN] } satisfies SiteProfile;
const validScriptSetup = {
  ...validSetup,
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  loginPostEndpoints: [],
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/functions/v1/sync', method: 'POST', maxPerLoginStage: 1 }],
  successStorageKey: { origin: TEST_ORIGIN, prefix: 'app-', suffix: '-auth-token' },
} satisfies AuthSetup;
const withScriptSetup = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...validScriptSetup, ...overrides });
const scriptViewsOf = (input: Record<string, unknown>): readonly AuthSetupErrorView[] => viewsOf(input, serviceProfileInput);

describe('T34d: the version 3 auth setup errors are split by the form fields', () => {
  it('accepts the valid script login setup (the base of the cases)', () => {
    expect(validateAuthSetup(validScriptSetup, profileOf(serviceProfileInput), context).ok).toBe(true);
  });

  // T44e（Task 44 の設計書 P2-8）: 要る項目の欠け（`AUTH_SETUP_SCRIPT_LOGIN_REQUIRED`）は、自動ログインのプロファイルだけ（下の T44e の describe）。
  // 手動のログインのプロファイルは、token の送信先と鍵がなくても誤りにならない。
  it('T44e: has no required error for the script login without the target and the key of a manual login profile', () => {
    const empty = withScriptSetup({ scriptLogin: null, loginSideRequests: [], successStorageKey: null });
    expect(validateAuthSetup(empty, profileOf(serviceProfileInput), context).ok).toBe(true);
  });

  it.each([
    [
      'scriptOrigin (not approved)',
      withScriptSetup({ scriptLogin: { ...validScriptSetup.scriptLogin, origin: UNAPPROVED_ORIGIN } }),
      { code: 'AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED', field: 'scriptOrigin', line: null },
    ],
    [
      'scriptPath',
      withScriptSetup({ scriptLogin: { ...validScriptSetup.scriptLogin, path: 'token' } }),
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'scriptPath', line: null },
    ],
    [
      'requiredQuery',
      withScriptSetup({ scriptLogin: { ...validScriptSetup.scriptLogin, requiredQuery: [{ name: 'grant_type', value: 'password' }, { name: ' ', value: 'x' }] } }),
      { code: 'AUTH_SETUP_REQUIRED_QUERY_INVALID', field: 'requiredQuery', line: 2 },
    ],
    [
      'loginSideRequests',
      withScriptSetup({ loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/auth/v1/token', method: 'POST', maxPerLoginStage: 1 }] }),
      { code: 'AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED', field: 'loginSideRequests', line: 1 },
    ],
    [
      'storagePrefix',
      withScriptSetup({ successStorageKey: { origin: TEST_ORIGIN, prefix: 'a\nb', suffix: '' } }),
      { code: 'AUTH_SETUP_STORAGE_KEY_INVALID', field: 'storagePrefix', line: null },
    ],
    [
      'storageOrigin (empty prefix and suffix)',
      withScriptSetup({ successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '' } }),
      { code: 'AUTH_SETUP_STORAGE_KEY_INVALID', field: 'storageOrigin', line: null },
    ],
    [
      'loginTransport (form navigation with the script login items)',
      withScriptSetup({ loginTransport: 'FORM_NAVIGATION', loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }] }),
      { code: 'AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED', field: 'scriptOrigin', line: null },
    ],
    [
      'loginPostEndpoints (form navigation without an endpoint)',
      withScriptSetup({ loginTransport: 'FORM_NAVIGATION', scriptLogin: null, loginSideRequests: [], successStorageKey: null }),
      { code: 'AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED', field: 'loginPostEndpoints', line: null },
    ],
  ] as const)('puts the error on the field %s', (_field, input, expected) => {
    expect(scriptViewsOf(input)).toContainEqual(expected);
  });
});

// T34R-fix-b（独立レビュー T34R の M-3・M-6）: 必須の query の値に見える値の誤りは、その行に出す（検証の owner が付ける位置で分ける。対応の表は変えない）。
// T36a（Task 36 の設計書 3.1）: 自動ログインのプロファイルのスクリプトで送るログインは、誤りにならない（M-3 の拒否を外した）。
describe('T34R-fix-b: the automated script login error and the value-like required query value are on their fields', () => {
  it('T36a: has no error for the script login of an automated login profile', () => {
    const automatedServiceProfile = { ...serviceProfileInput, auth: 'AUTOMATED_LOGIN' } satisfies SiteProfile;
    const automatedLogin = {
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#go',
      failureConditions: { invalidCredentials: { pathPrefix: '/login-error', selector: '#invalid' }, accountLocked: null, mfaRequired: null, credentialExpired: null },
    };
    const setup = withScriptSetup({ automatedLogin, maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS });
    expect(validateAuthSetup(setup, profileOf(automatedServiceProfile), context).ok).toBe(true);
  });

  // T44e（Task 44 の設計書 P2-8）: 自動ログインのプロファイルでは、今どおり token の送信先と鍵が要り、その誤りは欄に出す。
  it.each([
    ['scriptOrigin (required)', { scriptLogin: null }, { code: 'AUTH_SETUP_SCRIPT_LOGIN_REQUIRED', field: 'scriptOrigin', line: null }],
    ['storageOrigin (required)', { successStorageKey: null }, { code: 'AUTH_SETUP_SCRIPT_LOGIN_REQUIRED', field: 'storageOrigin', line: null }],
  ] as const)('T44e: puts the required error of an automated login profile on the field %s', (_field, overrides, expected) => {
    const automatedServiceProfile = { ...serviceProfileInput, auth: 'AUTOMATED_LOGIN' } satisfies SiteProfile;
    const automatedLogin = {
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#go',
      failureConditions: { invalidCredentials: { pathPrefix: '/login-error', selector: '#invalid' }, accountLocked: null, mfaRequired: null, credentialExpired: null },
    };
    expect(viewsOf(withScriptSetup({ ...overrides, automatedLogin, maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS }), automatedServiceProfile))
      .toContainEqual(expected);
  });

  it('puts SECRET_LIKE_VALUE of a required query value on its line', () => {
    const scriptLogin = { ...validScriptSetup.scriptLogin, requiredQuery: [{ name: 'grant_type', value: 'password' }, { name: 'email', value: 'someone@example.invalid' }] };
    expect(scriptViewsOf(withScriptSetup({ scriptLogin }))).toEqual([{ code: 'AUTH_SETUP_SECRET_LIKE_VALUE', field: 'requiredQuery', line: 2 }]);
  });
});

// T35d（Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出しと、サービスの Origin への要求の上限の誤りも、欄と行に分ける。
describe('T35d: the audit stage items of the version 3 auth setup are split by the form fields', () => {
  const read = { origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/list_items', method: 'POST', maxPerPageLoad: 2 } as const;

  it('accepts the script login setup with the audit stage items (the base of the cases)', () => {
    const input = withScriptSetup({ auditReadRequests: [read], serviceRequestLimits: { perMinute: 30, perRun: 300 } });
    expect(validateAuthSetup(input, profileOf(serviceProfileInput), context).ok).toBe(true);
  });

  it.each([
    [
      'auditReadRequests (duplicated)',
      withScriptSetup({ auditReadRequests: [read, read] }),
      { code: 'AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED', field: 'auditReadRequests', line: 2 },
    ],
    [
      'auditReadRequests (origin)',
      withScriptSetup({ auditReadRequests: [{ ...read, origin: UNAPPROVED_ORIGIN }] }),
      { code: 'AUTH_SETUP_ORIGIN_NOT_APPROVED', field: 'auditReadRequests', line: 1 },
    ],
    [
      'auditReadRequests (path)',
      withScriptSetup({ auditReadRequests: [read, { ...read, path: 'rpc' }] }),
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'auditReadRequests', line: 2 },
    ],
    [
      'servicePerMinute',
      // DEF-141: 1 分あたりの上限は 600 まで（前は 120 まで）。
      withScriptSetup({ serviceRequestLimits: { perMinute: 601, perRun: 300 } }),
      { code: 'AUTH_SETUP_LIMIT_EXCEEDED', field: 'servicePerMinute', line: null },
    ],
    [
      'servicePerRun',
      // DEF-141: 1 回の Run あたりの上限は 10,000 まで（前は 600 まで）。
      withScriptSetup({ serviceRequestLimits: { perMinute: 30, perRun: 10_001 } }),
      { code: 'AUTH_SETUP_LIMIT_EXCEEDED', field: 'servicePerRun', line: null },
    ],
  ] as const)('puts the error on the field %s', (_field, input, expected) => {
    expect(scriptViewsOf(input)).toContainEqual(expected);
  });
});
