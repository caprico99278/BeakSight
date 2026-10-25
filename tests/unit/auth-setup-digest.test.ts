// T28c（Task 28 の設計書 3 章の「承認を縛るもの」、10 章の 1）: 承認に縛る認証の設定の digest（`src/control/auth/auth-setup-digest.ts`）。
// - 保存した設定の内容（版 3 の文書）と資格情報の事実（版と、資格情報の変更の最後の出来事の id。T28R-fix-1 の I-1）から、鍵を並べた JSON の `createSha256Fingerprint`。保存の時刻・鮮度・今のプロファイルの改訂は
//   入れない。設定がなければ null（T28a の契約の形）。
// - 内容の各項目の変化で値が変わる。時刻だけの変化では変わらない。資格情報の版の変化で変わる。資格情報の値の口はない（文書の形の外の項目は拒む）。
// - LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 認証の設定は版 3 だけ。版 1・版 2 を捨てる前のコードで求めた版 3 の値を固定する（値は変わらない）。
import { describe, expect, it } from 'vitest';
import { type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { AUTH_SETUP_DIGEST_FORMAT, authSetupDigestOf } from '../../src/control/auth/auth-setup-digest.js';
import { isSha256Fingerprint } from '../../src/core/ids.js';
import { FORM_NAVIGATION_SETUP_ITEMS, previousVersionSetupDocumentOf } from '../helpers/auth-setup-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
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

// T34a（Task 34 の設計書 3.2）: 版 3 の設定は版 3 のスキーマで確かめて求め、版 3 の項目の変化で値が変わる。
describe('auth setup digest of version 3 (T34a)', () => {
  /** T35a の項目を足す前の、下の版 3 の設定の digest（固定の値。T35a の前のコードで求めた）。 */
  const VERSION_3_DIGEST_BEFORE_T35A = 'sha256:01d79973a66e9301a2c6e3c00a328d39ef81c7cf25cc74d4c2f63da355f92677';
  /** LG-3b: 版 1・版 2 を捨てる前のコードで求めた、上のフォームの送信の版 3 の設定と資格情報の事実の digest（固定の値）。 */
  const FORM_NAVIGATION_DIGEST = 'sha256:e0f2eb4feac2461bf49c6a43e79c88f5ba6b187483ff53879a293243d50fa040';
  const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
  const SCRIPT_SETUP: AuthSetup = Object.freeze({
    ...SETUP,
    loginPostEndpoints: [],
    maxLoginAttempts: 2,
    automatedLogin: null,
    loginTransport: 'SCRIPT_REQUEST',
    scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/resolve', method: 'POST', maxPerLoginStage: 1 }],
    successStorageKey: { origin: ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
  } as const);

  it('keeps the digest of a form navigation setup of version 3 (LG-3)', () => {
    expect(BASE).toBe(FORM_NAVIGATION_DIGEST);
  });

  it('computes the digest of a version 3 setup with the version 3 schema, and it changes with the version 3 items', () => {
    const base = authSetupDigestOf(stored(SCRIPT_SETUP), null);
    expect(isSha256Fingerprint(base)).toBe(true);
    for (const change of [
      { scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [] } },
      { loginSideRequests: [] },
      { successStorageKey: { origin: ORIGIN, prefix: 'sb-', suffix: '-token' } },
    ]) {
      expect(authSetupDigestOf(stored({ ...SCRIPT_SETUP, ...change } as AuthSetup), null), JSON.stringify(change)).not.toBe(base);
    }
    // 版 3 の文書の形に合わない値（版 2 の版の印で、版 3 の項目を持つ）は拒む。
    expect(() => authSetupDigestOf(stored({ ...SCRIPT_SETUP, schemaVersion: 'beaksight-auth-setup/2' } as unknown as AuthSetup), null)).toThrow(RangeError);
  });

  // LG-3b: 前の版（版 1・版 2）の文書の digest は求めない（版 3 のスキーマの誤り）。
  it.each([1, 2] as const)('rejects a setup of version %s (LG-3)', (version) => {
    expect(() => authSetupDigestOf(stored(previousVersionSetupDocumentOf(SETUP, version) as unknown as AuthSetup), CREDENTIAL)).toThrow(RangeError);
  });

  // T35a（Task 35 の設計書 3.1）: 版 3 の任意の項目（`auditReadRequests`・`serviceRequestLimits`）を足しても、項目のない版 3 の digest は変わらない。
  // 項目があれば digest が変わる（承認を縛り直す）。
  it('keeps the digest of a version 3 setup without the T35a items, and changes it with them', () => {
    expect(authSetupDigestOf(stored(SCRIPT_SETUP), null)).toBe(VERSION_3_DIGEST_BEFORE_T35A);
    const reads = { auditReadRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/list', method: 'POST', maxPerPageLoad: 2 }] };
    const limits = { serviceRequestLimits: { perMinute: 60, perRun: 300 } };
    for (const change of [reads, limits, { auditReadRequests: [] }]) {
      expect(authSetupDigestOf(stored({ ...SCRIPT_SETUP, ...change } as AuthSetup), null), JSON.stringify(change)).not.toBe(VERSION_3_DIGEST_BEFORE_T35A);
    }
  });
});
