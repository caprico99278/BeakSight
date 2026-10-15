// T28c（Task 28 の設計書 3 章の「承認を縛るもの」、10 章の 1）: 承認に縛る認証の設定の digest（`src/control/auth/auth-setup-digest.ts`）。
// - 保存した設定の内容（版 2 の文書）と資格情報の事実（版と、資格情報の変更の最後の出来事の id。T28R-fix-1 の I-1）から、鍵を並べた JSON の `createSha256Fingerprint`。保存の時刻・鮮度・今のプロファイルの改訂は
//   入れない。設定がなければ null（T28a の契約の形）。
// - 内容の各項目の変化で値が変わる。時刻だけの変化では変わらない。資格情報の版の変化で変わる。資格情報の値の口はない（文書の形の外の項目は拒む）。
import { describe, expect, it } from 'vitest';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { AUTH_SETUP_DIGEST_FORMAT, authSetupDigestOf } from '../../src/control/auth/auth-setup-digest.js';
import { isSha256Fingerprint } from '../../src/core/ids.js';

const ORIGIN = 'http://127.0.0.1:4173';

const SETUP: AuthSetup = Object.freeze({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: 'example-write',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#go',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/login', selector: '#login-failed' },
      accountLocked: null,
      mfaRequired: null,
      credentialExpired: null,
    },
  },
});

const stored = (setup: AuthSetup, updatedAt = '20261012000000') => ({ setup, updatedAt, freshness: 'CURRENT' as const, profileRevision: 1 });
/** 資格情報の事実（T28R-fix-1。I-1）: 資格情報の版と、資格情報の変更の最後の出来事の id（削除をまたいで必ず変わる）。 */
const CREDENTIAL = Object.freeze({ credentialRevision: 2, lastCredentialEventId: 5 });
const BASE = authSetupDigestOf(stored(SETUP), CREDENTIAL);

describe('auth setup digest (T28c)', () => {
  it('has a versioned format mark, returns a sha256 fingerprint, and null without a setup', () => {
    expect(AUTH_SETUP_DIGEST_FORMAT).toBe('beaksight-auth-setup-digest/2');
    expect(isSha256Fingerprint(BASE)).toBe(true);
    expect(authSetupDigestOf(null, CREDENTIAL)).toBeNull();
    expect(authSetupDigestOf(null, null)).toBeNull();
  });

  it('does not change with the save time, the freshness, the current profile revision or the key order', () => {
    const restamped = { ...stored(SETUP, '20270101000000'), freshness: 'STALE' as const, profileRevision: 9 };
    expect(authSetupDigestOf(restamped, CREDENTIAL)).toBe(BASE);
    const reordered = Object.fromEntries(Object.entries(SETUP).reverse()) as unknown as AuthSetup;
    expect(authSetupDigestOf(stored(reordered), { lastCredentialEventId: 5, credentialRevision: 2 })).toBe(BASE);
  });

  it.each<readonly [string, Partial<AuthSetup>]>([
    ['the profile revision of the setup', { profileRevision: 2 }],
    ['the login start URL', { loginStartUrl: `${ORIGIN}/signin` }],
    ['a login POST endpoint', { loginPostEndpoints: [{ origin: ORIGIN, path: '/session' }] }],
    ['the success condition', { successCondition: { pathPrefix: '/admin', selector: null } }],
    ['the session lost condition', { sessionLostCondition: { pathPrefix: '/login' } }],
    ['the excluded paths', { excludedPaths: [] }],
    ['the audit path prefixes', { auditPathPrefixes: ['/admin', '/items'] }],
    ['the login attempts', { maxLoginAttempts: 2 }],
    ['the automated login', { automatedLogin: null }],
    ['a selector of the automated login', { automatedLogin: { ...(SETUP.automatedLogin as NonNullable<AuthSetup['automatedLogin']>), submitSelector: '#submit' } }],
  ])('changes with %s', (_label, change) => {
    expect(authSetupDigestOf(stored({ ...SETUP, ...change }), CREDENTIAL)).not.toBe(BASE);
  });

  it('changes with the credential revision, the last credential event and without credential facts', () => {
    expect(authSetupDigestOf(stored(SETUP), { ...CREDENTIAL, credentialRevision: 3 })).not.toBe(BASE);
    expect(authSetupDigestOf(stored(SETUP), { ...CREDENTIAL, credentialRevision: null })).not.toBe(BASE);
    expect(authSetupDigestOf(stored(SETUP), null)).not.toBe(BASE);
  });

  // T28R-fix-1（I-1）: 資格情報を削除して登録し直すと、版は 1 に戻る。最後の出来事の id は増えるので、digest は変わる。
  it('changes when the credential was deleted and registered again at the same revision', () => {
    const first = authSetupDigestOf(stored(SETUP), { credentialRevision: 1, lastCredentialEventId: 1 });
    const again = authSetupDigestOf(stored(SETUP), { credentialRevision: 1, lastCredentialEventId: 3 });
    expect(again).not.toBe(first);
    expect(authSetupDigestOf(stored(SETUP), { credentialRevision: null, lastCredentialEventId: 2 })).not.toBe(first);
  });

  it('has no input for a credential value: a property outside the auth setup document is rejected', () => {
    const smuggled = { ...SETUP, password: 'MARKER-PASSWORD-VALUE' } as unknown as AuthSetup;
    expect(() => authSetupDigestOf(stored(smuggled), CREDENTIAL)).toThrow(RangeError);
    expect(() => authSetupDigestOf(stored(SETUP), { ...CREDENTIAL, credentialRevision: 0 })).toThrow(RangeError);
    expect(() => authSetupDigestOf(stored(SETUP), { ...CREDENTIAL, credentialRevision: 1.5 })).toThrow(RangeError);
    expect(() => authSetupDigestOf(stored(SETUP), { ...CREDENTIAL, lastCredentialEventId: 0 })).toThrow(RangeError);
    const extra = { ...CREDENTIAL, password: 'MARKER-PASSWORD-VALUE' };
    expect(authSetupDigestOf(stored(SETUP), extra)).toBe(BASE);
  });
});
