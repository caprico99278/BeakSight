/**
 * 開始の画面に出す、開始できない理由の確かめ（`src/server/audit-start-check.ts`。Task 24 の設計書 4.8、Task 25 の設計書 4.5。T25e）。
 * - 判断の順が、ジョブの管理の開始の直前の確かめ（`startAuditJob`）と同じであること（取り消し → モード → 認証の方式 → 認証の設定がない →
 *   古い → パス → 読めない → プロファイルの検証 → 認証の設定の検証）。
 * - 保存の後に今の決まりで通らなくなった認証の設定（`AUTH_SETUP_INVALID`）の誤りを、コードと項目で返すこと（画面のテストでは、管理データを
 *   直接書き換えられないため（Gate (g)）、ここで確かめる）。
 * 例の値は、匿名の値（`example.invalid`）だけを使う。管理データもファイルも、子の process もブラウザも使わない。
 */
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_2, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../../src/control/auth/auth-setup-contracts.js';
import { validateAuthSetup } from '../../../src/control/auth/auth-setup-policy.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../../src/control/contracts.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../../src/control/profile-policy.js';
import type { CredentialMetadata } from '../../../src/control/credentials/credential-store.js';
import { decideAutoLoginStart } from '../../../src/control/job/auto-login-limits.js';
import type { StoredAuthSetup } from '../../../src/control/store/auth-setup-store.js';
import { createTestConfig } from '../../../tests/helpers/test-config.js';
import { auditStartCheckOf, startRejectionViewOf, type AuditStartCheckInput, type AutoLoginStartInputs } from '../src/server/audit-start-check';

const TEST_ORIGIN = 'https://app.example.invalid';
const OUTSIDE_ORIGIN = 'https://outside.example.invalid';
const REVISION = 4;
const UPDATED_AT = '20261010000000';

const context: ProfileValidationContext = {
  targetConfig: { ...createTestConfig(TEST_ORIGIN), site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN] } },
};

const publicProfile = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-public-start',
  revision: REVISION,
  targetConfigPath: 'config/targets/example-start.json',
  environment: 'PUBLIC',
  mode: 'PUBLIC_PASSIVE',
  auth: 'NONE',
  approvedTestOrigins: [],
  environmentEvidenceRef: null,
} satisfies SiteProfile;

const authProfile = {
  ...publicProfile,
  profileId: 'example-auth-start',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: 'evidence/example-auth-start/isolation-check-1',
} satisfies SiteProfile;

const setup = {
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: authProfile.profileId,
  profileRevision: REVISION,
  loginStartUrl: `${TEST_ORIGIN}/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
} satisfies AuthSetup;

const stored = (overrides: Partial<StoredAuthSetup> = {}): StoredAuthSetup => ({
  setup,
  updatedAt: UPDATED_AT,
  freshness: 'CURRENT',
  profileRevision: REVISION,
  ...overrides,
});

const check = (overrides: Partial<AuditStartCheckInput>) => auditStartCheckOf({
  status: 'ACTIVE',
  profile: authProfile,
  pathAccepted: true,
  context,
  storedSetup: stored(),
  ...overrides,
});

describe('T25e: the start screen check (the same order as the job manager)', () => {
  it('has no blocker for an executable public profile and for an authenticated profile with a CURRENT valid setup', () => {
    expect(check({ profile: publicProfile, storedSetup: null })).toEqual({
      blocker: null, errorCodes: [], authRequired: false, authSetupErrors: [], nextAllowedAt: null,
    });
    expect(check({})).toEqual({ blocker: null, errorCodes: [], authRequired: true, authSetupErrors: [], nextAllowedAt: null });
    // 公開の監査には、認証の設定を使わない（渡しても見ない）。
    expect(check({ profile: publicProfile, storedSetup: stored({ freshness: 'STALE' }) }).blocker).toBeNull();
  });

  it.each([
    ['PROFILE_RETIRED', { status: 'RETIRED', storedSetup: null, context: undefined }],
    ['MODE_NOT_EXECUTABLE', { profile: { ...authProfile, mode: 'TEST_APPROVED_WRITE' }, storedSetup: null }],
    // T26d-2 round 1: 自動ログインは方式として実行できる（どの OS でも。Windows だけであることは、ジョブの管理の開始の確かめで強制する）。今実行
    // できない方式は、公開の監査の手動のログインなど。
    ['AUTH_STRATEGY_NOT_EXECUTABLE', { profile: { ...publicProfile, auth: 'MANUAL_SESSION' }, storedSetup: null }],
    ['AUTH_SETUP_MISSING', { profile: { ...authProfile, auth: 'AUTOMATED_LOGIN' }, storedSetup: null }],
    ['AUTH_SETUP_MISSING', { storedSetup: null, pathAccepted: false, context: undefined }],
    ['AUTH_SETUP_STALE', { storedSetup: stored({ freshness: 'STALE' }), pathAccepted: false }],
    ['TARGET_PATH_INVALID', { pathAccepted: false, context: undefined }],
    ['TARGET_CONFIG_UNAVAILABLE', { context: undefined }],
  ] as const)('stops at %s first', (blocker, overrides) => {
    expect(check(overrides as Partial<AuditStartCheckInput>)).toMatchObject({ blocker, authSetupErrors: [] });
  });

  it('shows PROFILE_INVALID with the profile error codes before the auth setup check', () => {
    expect(check({ profile: { ...authProfile, approvedTestOrigins: [OUTSIDE_ORIGIN] } })).toEqual({
      blocker: 'PROFILE_INVALID',
      errorCodes: ['PROFILE_TEST_ORIGIN_OUTSIDE_TARGET'],
      authRequired: true,
      authSetupErrors: [],
      nextAllowedAt: null,
    });
  });

  it('shows AUTH_SETUP_INVALID with the errors by field when the stored setup no longer passes validateAuthSetup', () => {
    const ambiguous = stored({ setup: { ...setup, successCondition: { pathPrefix: '/', selector: null } } });
    expect(check({ storedSetup: ambiguous })).toEqual({
      blocker: 'AUTH_SETUP_INVALID',
      errorCodes: [],
      authRequired: true,
      authSetupErrors: [{ code: 'AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS', field: 'successPathPrefix', line: null }],
      nextAllowedAt: null,
    });
    const twoErrors = stored({ setup: { ...setup, excludedPaths: ['/admin/logout', 'x'], loginStartUrl: `${OUTSIDE_ORIGIN}/login` } });
    expect(check({ storedSetup: twoErrors }).authSetupErrors).toEqual([
      { code: 'AUTH_SETUP_ORIGIN_NOT_APPROVED', field: 'loginStartUrl', line: null },
      { code: 'AUTH_SETUP_PATH_INVALID', field: 'excludedPaths', line: 2 },
    ]);
  });
});

// T25e round 1（Blocker 1 の案 A）: ジョブの管理の開始の拒否が `AUTH_SETUP_INVALID` の誤りを持つとき、画面に返す開始の結果の
// `authSetupErrors` が、コードと項目と行で埋まる（英語の詳細は返さない）。ほかの理由では空。
describe('T25e round 1: the start rejection view carries the auth setup errors of AUTH_SETUP_INVALID', () => {
  const profileValidation = validateSiteProfile(authProfile, context);
  if (!profileValidation.ok) {
    throw new Error('the test profile was rejected');
  }
  const invalid = validateAuthSetup(
    { ...setup, successCondition: { pathPrefix: '/', selector: null }, excludedPaths: ['/admin/logout', 'x'] },
    profileValidation.profile,
    context,
  );
  if (invalid.ok) {
    throw new Error('the test setup was accepted');
  }

  it('fills authSetupErrors with the code, the field and the line, without the English detail', () => {
    const view = startRejectionViewOf({ ok: false, reason: 'AUTH_SETUP_INVALID', errors: [], authSetupErrors: invalid.errors });
    expect(view).toEqual({
      reason: 'AUTH_SETUP_INVALID',
      errorCodes: [],
      authSetupErrors: [
        { code: 'AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS', field: 'successPathPrefix', line: null },
        { code: 'AUTH_SETUP_PATH_INVALID', field: 'excludedPaths', line: 2 },
      ],
    });
    for (const { detail } of invalid.errors) {
      expect(JSON.stringify(view)).not.toContain(detail);
    }
  });

  it('keeps authSetupErrors empty for the other reasons, and passes the profile error codes through', () => {
    expect(startRejectionViewOf({ ok: false, reason: 'AUTH_SETUP_MISSING', errors: [] }))
      .toEqual({ reason: 'AUTH_SETUP_MISSING', errorCodes: [], authSetupErrors: [] });
    expect(startRejectionViewOf({
      ok: false,
      reason: 'PROFILE_INVALID',
      errors: [{ code: 'PROFILE_TEST_ORIGIN_OUTSIDE_TARGET', detail: 'outside' }],
    })).toEqual({ reason: 'PROFILE_INVALID', errorCodes: ['PROFILE_TEST_ORIGIN_OUTSIDE_TARGET'], authSetupErrors: [] });
  });
});

// T26e（T26d-2 の発見事項 3）: 自動ログインのプロファイルの開始の画面とログインの確かめの画面は、ジョブの管理と同じ確かめ（資格情報のメタデータ、
// 暗号化が使えるか、上限）を、読むだけで行う（`checkAutoLoginStart`、`decideAutoLoginStart` を使う。値は読まない）。
describe('T26e: the automated login check of the start screen and the login check screen', () => {
  const automatedProfile = { ...authProfile, profileId: 'example-auto-start', auth: 'AUTOMATED_LOGIN' } satisfies SiteProfile;
  const automatedSetup = {
    ...setup,
    profileId: automatedProfile.profileId,
    maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
    automatedLogin: {
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#go',
      failureConditions: { invalidCredentials: { pathPrefix: '/login-error', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
    },
  } satisfies AuthSetup;
  const NOW = new Date(Date.UTC(2026, 9, 11, 9, 0, 0));
  const credentialOf = (loginOrigin: string): CredentialMetadata => ({
    profileId: automatedProfile.profileId,
    loginOrigin,
    credentialRevision: 1,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    lastChangeKind: 'CREATED',
    protection: 'DPAPI_CURRENT_USER',
  });
  const ready: AutoLoginStartInputs = { credential: credentialOf(TEST_ORIGIN), protection: 'AVAILABLE', limit: { ok: true } };
  const automated = (autoLogin: AutoLoginStartInputs | null, overrides: Partial<AuditStartCheckInput> = {}) => check({
    profile: automatedProfile,
    storedSetup: stored({ setup: automatedSetup }),
    autoLogin,
    ...overrides,
  });

  it('has no blocker when the credential, the encryption and the limits allow the start', () => {
    expect(automated(ready)).toEqual({ blocker: null, errorCodes: [], authRequired: true, authSetupErrors: [], nextAllowedAt: null });
    expect(automated(ready, { jobKind: 'LOGIN_CHECK' }).blocker).toBeNull();
  });

  it.each([
    ['CREDENTIAL_MISSING', { ...ready, credential: null }],
    ['CREDENTIAL_STALE', { ...ready, credential: credentialOf(OUTSIDE_ORIGIN) }],
    ['CREDENTIAL_PROTECTION_UNAVAILABLE', { ...ready, protection: 'UNAVAILABLE' }],
    ['AUTO_LOGIN_HELD', { ...ready, limit: decideAutoLoginStart({ attempts: [], hold: { reason: 'ACCOUNT_LOCKED', heldAt: UPDATED_AT }, now: NOW }) }],
  ] as const)('stops at %s with the same order as the job manager', (blocker, autoLogin) => {
    expect(automated(autoLogin)).toEqual({ blocker, errorCodes: [], authRequired: true, authSetupErrors: [], nextAllowedAt: null });
  });

  it('shows AUTO_LOGIN_RATE_LIMITED with the next allowed time (ISO 8601)', () => {
    const limit = decideAutoLoginStart({ attempts: [{ startedAt: '20261011085800', retryAfterUntil: null }], hold: null, now: NOW });
    expect(limit).toMatchObject({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED' });
    expect(automated({ ...ready, limit })).toMatchObject({ blocker: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: '2026-10-11T09:03:00Z' });
  });

  it('puts the auth setup and the profile checks before the automated login check', () => {
    expect(automated({ ...ready, credential: null }, { storedSetup: null }).blocker).toBe('AUTH_SETUP_MISSING');
    expect(automated({ ...ready, credential: null }, { context: undefined }).blocker).toBe('TARGET_CONFIG_UNAVAILABLE');
  });

  it('rejects a login check of a profile that does not use the automated login (AUTH_STRATEGY_NOT_EXECUTABLE)', () => {
    expect(check({ jobKind: 'LOGIN_CHECK' }).blocker).toBe('AUTH_STRATEGY_NOT_EXECUTABLE');
    expect(check({ jobKind: 'LOGIN_CHECK', profile: publicProfile, storedSetup: null }).blocker).toBe('AUTH_STRATEGY_NOT_EXECUTABLE');
    expect(check({ jobKind: 'LOGIN_CHECK', status: 'RETIRED' }).blocker).toBe('PROFILE_RETIRED');
  });

  it('returns the next allowed time of a job manager rejection as ISO 8601, only for the limit reasons', () => {
    expect(startRejectionViewOf({ ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', errors: [], nextAllowedAt: '20261011090300' }))
      .toEqual({ reason: 'AUTO_LOGIN_RATE_LIMITED', errorCodes: [], authSetupErrors: [], nextAllowedAt: '2026-10-11T09:03:00Z' });
    expect(startRejectionViewOf({ ok: false, reason: 'AUTO_LOGIN_HELD', errors: [], nextAllowedAt: null }))
      .toEqual({ reason: 'AUTO_LOGIN_HELD', errorCodes: [], authSetupErrors: [], nextAllowedAt: null });
  });
});

// T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5）: 書き込みのモード（`TEST_APPROVED_WRITE`）のプロファイルでも、ジョブの管理と同じく、発見・
// READ の確かめ・（自動ログインなら）ログインの確かめを始められる（認証の設定が要る）。認証つきの監査（`AUDIT`）は、今までどおり
// `MODE_NOT_EXECUTABLE` で、認証の設定を要るとは言わない（始められないため）。
describe('T28b: the start check of a write mode profile', () => {
  const writeProfile = { ...authProfile, mode: 'TEST_APPROVED_WRITE' } satisfies SiteProfile;
  const writeAutomatedProfile = { ...writeProfile, auth: 'AUTOMATED_LOGIN' } satisfies SiteProfile;
  const writeAutomatedSetup = {
    ...setup,
    maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
    automatedLogin: {
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#go',
      failureConditions: { invalidCredentials: { pathPrefix: '/login-error', selector: null }, accountLocked: null, mfaRequired: null, credentialExpired: null },
    },
  } satisfies AuthSetup;
  const ready: AutoLoginStartInputs = {
    credential: {
      profileId: writeProfile.profileId,
      loginOrigin: TEST_ORIGIN,
      credentialRevision: 1,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      lastChangeKind: 'CREATED',
      protection: 'DPAPI_CURRENT_USER',
    },
    protection: 'AVAILABLE',
    limit: { ok: true },
  };

  it('has no blocker for DISCOVERY and READ_CHECK with a CURRENT valid setup, and needs the setup', () => {
    expect(check({ profile: writeProfile, jobKind: 'DISCOVERY' }))
      .toEqual({ blocker: null, errorCodes: [], authRequired: true, authSetupErrors: [], nextAllowedAt: null });
    expect(check({ profile: writeProfile, jobKind: 'READ_CHECK', readCheckDefinitionCount: 1 }))
      .toEqual({ blocker: null, errorCodes: [], authRequired: true, authSetupErrors: [], nextAllowedAt: null });
    expect(check({ profile: writeProfile, jobKind: 'DISCOVERY', storedSetup: null }).blocker).toBe('AUTH_SETUP_MISSING');
    expect(check({ profile: writeProfile, jobKind: 'DISCOVERY', storedSetup: stored({ freshness: 'STALE' }) }).blocker).toBe('AUTH_SETUP_STALE');
    expect(check({ profile: writeProfile, jobKind: 'READ_CHECK' }).blocker).toBe('READ_CHECK_DEFINITIONS_MISSING');
  });

  it('rejects the AUDIT of a write mode profile with MODE_NOT_EXECUTABLE, without asking for the auth setup', () => {
    expect(check({ profile: writeProfile })).toEqual({
      blocker: 'MODE_NOT_EXECUTABLE', errorCodes: [], authRequired: false, authSetupErrors: [], nextAllowedAt: null,
    });
    expect(check({ profile: writeProfile, jobKind: 'AUDIT', storedSetup: null }).blocker).toBe('MODE_NOT_EXECUTABLE');
  });

  it('allows the login check of an automated login write mode profile only', () => {
    expect(check({ profile: writeProfile, jobKind: 'LOGIN_CHECK' }).blocker).toBe('AUTH_STRATEGY_NOT_EXECUTABLE');
    expect(check({ profile: writeAutomatedProfile, jobKind: 'LOGIN_CHECK', storedSetup: stored({ setup: writeAutomatedSetup }), autoLogin: ready }))
      .toEqual({ blocker: null, errorCodes: [], authRequired: true, authSetupErrors: [], nextAllowedAt: null });
    expect(check({ profile: writeAutomatedProfile, jobKind: 'LOGIN_CHECK', storedSetup: stored({ setup: writeAutomatedSetup }), autoLogin: { ...ready, credential: null } }).blocker)
      .toBe('CREDENTIAL_MISSING');
  });
});
