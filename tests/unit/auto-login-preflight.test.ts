// T26c（Task 26 の設計書 4.5 の「開始の前の確かめ」）: 自動ログインの開始の前の確かめ（`src/control/job/auto-login-preflight.ts`。純粋な関数）。
// - 入力: プロファイル、認証の設定（版 2）、資格情報のメタデータ（T26a の `readMetadata` の結果）、暗号化が使えるか、上限の判定の結果。
// - 理由: `CREDENTIAL_MISSING`、`CREDENTIAL_STALE`（保存した `loginOrigin` が、認証の設定の `loginStartUrl` の Origin と違う）、
//   `CREDENTIAL_PROTECTION_UNAVAILABLE`、`AUTO_LOGIN_HELD`、`AUTO_LOGIN_RATE_LIMITED`（次に始められる時刻つき）と、通る場合。
// 例の値は、匿名の値（`example.invalid`）だけを使う。値（ユーザー名とパスワード）は、この確かめに渡さない（メタデータだけ）。
import { describe, expect, expectTypeOf, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../src/control/contracts.js';
import type { CredentialMetadata } from '../../src/control/credentials/credential-store.js';
import {
  AUTO_LOGIN_PREFLIGHT_REJECTION_REASONS,
  checkAutoLoginStart,
  type AutoLoginPreflightInput,
} from '../../src/control/job/auto-login-preflight.js';
import { AUDIT_JOB_START_REJECTION_REASONS } from '../../src/control/job/job-records.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const PROFILE_ID = 'example-auto-login';
const NEXT_ALLOWED_AT = '20261010121000';

const profile: SiteProfile = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: PROFILE_ID,
  revision: 2,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'AUTOMATED_LOGIN',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: 'example-evidence',
};

const authSetup: AuthSetup = {
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: 2,
  loginStartUrl: `${TEST_ORIGIN}/login?next=%2Fadmin`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/session' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#submit',
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
};

const credential: CredentialMetadata = {
  profileId: PROFILE_ID,
  loginOrigin: TEST_ORIGIN,
  credentialRevision: 3,
  createdAt: '20261009000000',
  updatedAt: '20261010000000',
  lastChangeKind: 'PASSWORD_CHANGED',
  protection: 'DPAPI_CURRENT_USER',
};

const passing: AutoLoginPreflightInput = { profile, authSetup, credential, protection: 'AVAILABLE', limit: { ok: true } };

describe('auto login preflight (design 4.5)', () => {
  it('passes when the credential exists, matches the login origin, protection works and the limits allow it', () => {
    expect(checkAutoLoginStart(passing)).toEqual({ ok: true });
  });

  it.each([
    ['no credential file', { credential: null }, 'CREDENTIAL_MISSING', null],
    ['a credential saved for another login origin', { credential: { ...credential, loginOrigin: OTHER_ORIGIN } }, 'CREDENTIAL_STALE', null],
    ['an auth setup whose login page moved to another origin', {
      authSetup: { ...authSetup, loginStartUrl: `${OTHER_ORIGIN}/login` },
    }, 'CREDENTIAL_STALE', null],
    ['protection that does not work', { protection: 'UNAVAILABLE' }, 'CREDENTIAL_PROTECTION_UNAVAILABLE', null],
    ['a held profile', { limit: { ok: false, reason: 'AUTO_LOGIN_HELD', nextAllowedAt: null } }, 'AUTO_LOGIN_HELD', null],
    ['the rate limits', {
      limit: { ok: false, reason: 'AUTO_LOGIN_RATE_LIMITED', nextAllowedAt: NEXT_ALLOWED_AT },
    }, 'AUTO_LOGIN_RATE_LIMITED', NEXT_ALLOWED_AT],
  ] as const)('refuses %s', (_name, overrides, reason, nextAllowedAt) => {
    expect(checkAutoLoginStart({ ...passing, ...overrides } as AutoLoginPreflightInput)).toEqual({ ok: false, reason, nextAllowedAt });
  });

  it('checks the credential before the limits (a missing credential is reported even while held)', () => {
    expect(checkAutoLoginStart({ ...passing, credential: null, limit: { ok: false, reason: 'AUTO_LOGIN_HELD', nextAllowedAt: null } }))
      .toEqual({ ok: false, reason: 'CREDENTIAL_MISSING', nextAllowedAt: null });
    expect(checkAutoLoginStart({ ...passing, protection: 'UNAVAILABLE', credential: { ...credential, loginOrigin: OTHER_ORIGIN } }))
      .toEqual({ ok: false, reason: 'CREDENTIAL_STALE', nextAllowedAt: null });
  });

  it('treats inputs for another profile or another strategy as a caller error', () => {
    expect(() => checkAutoLoginStart({ ...passing, profile: { ...profile, auth: 'MANUAL_SESSION' } })).toThrow(RangeError);
    expect(() => checkAutoLoginStart({ ...passing, authSetup: { ...authSetup, profileId: 'example-other' } })).toThrow(RangeError);
    expect(() => checkAutoLoginStart({ ...passing, authSetup: { ...authSetup, automatedLogin: null } })).toThrow(RangeError);
    expect(() => checkAutoLoginStart({ ...passing, credential: { ...credential, profileId: 'example-other' } })).toThrow(RangeError);
    expect(() => checkAutoLoginStart({ ...passing, authSetup: { ...authSetup, loginStartUrl: 'not a url' } })).toThrow(RangeError);
  });

  it('uses only reasons of the closed list of start rejections, and takes no credential values', () => {
    expect(AUDIT_JOB_START_REJECTION_REASONS).toEqual(expect.arrayContaining([...AUTO_LOGIN_PREFLIGHT_REJECTION_REASONS]));
    expect(AUTO_LOGIN_PREFLIGHT_REJECTION_REASONS).toEqual([
      'CREDENTIAL_MISSING', 'CREDENTIAL_STALE', 'CREDENTIAL_PROTECTION_UNAVAILABLE', 'AUTO_LOGIN_HELD', 'AUTO_LOGIN_RATE_LIMITED',
    ]);
    expectTypeOf<'username' extends keyof NonNullable<AutoLoginPreflightInput['credential']> ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'password' extends keyof NonNullable<AutoLoginPreflightInput['credential']> ? true : false>().toEqualTypeOf<false>();
  });
});
