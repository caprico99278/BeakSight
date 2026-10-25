// T25a（Task 25 の設計書 4.1、5 章）: 認証の設定の契約・スキーマ・検証の検査。
// LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 認証の設定は版 3（`beaksight-auth-setup/3`）だけ。検証の例の値は、フォームの送信のログインの版 3 の
// 文書（`tests/helpers/auth-setup-samples.ts` の項目を足す）。自動ログインの検査は `control-auth-setup-v2.test.ts`、スクリプトで送るログインの検査は
// `control-auth-setup-v3.test.ts`。版 1・版 2 と知らない版の文書を形の誤りにする確かめは、ここの 1 か所（O1）。
// - 契約（`src/control/auth/auth-setup-contracts.ts`）と JSON Schema（`schemas/control/auth-setup-v3.schema.json`）の項目と上限の一致（O2: 上限の
//   一致の確かめは、ここの 1 か所）。
// - 検証（`validateAuthSetup`）: 正しい設定が通る。各決まりの違反が、それぞれの誤りで拒まれる（fail-closed。当たった誤りをすべて返す）。
// - 誤りの文に、設定の値（秘密に見える query の値など）を入れない。
// 例の値は、匿名の値（`example.invalid`、`127.0.0.1`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUTH_SETUP_VALIDATION_ERROR_CODES,
  MAX_ALLOWED_IDP_ORIGINS,
  MAX_AUTH_SETUP_PATH_LIST_ITEMS,
  MAX_AUTH_SETUP_URL_LENGTH,
  MAX_LOGIN_ATTEMPTS,
  MAX_LOGIN_POST_ENDPOINTS,
  MAX_SUCCESS_SELECTOR_LENGTH,
  MIN_LOGIN_ATTEMPTS,
  type AuthSetup,
  type AuthSetupValidationErrorCode,
  type AuthSetupValidationResult,
} from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { SECRET_LIKE_QUERY_NAME_WORDS } from '../../src/core/secret-query-names.js';
import { sessionLostPathPrefixOf, validateAuthSetup } from '../../src/control/auth/auth-setup-policy.js';
import {
  MIN_PROFILE_REVISION,
  PROFILE_ID_PATTERN,
  SITE_PROFILE_SCHEMA_VERSION,
  type SiteProfile,
  type ValidatedSiteProfile,
} from '../../src/control/contracts.js';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../src/control/profile-policy.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import { FORM_NAVIGATION_SETUP_ITEMS, previousVersionSetupDocumentOf } from '../helpers/auth-setup-samples.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:4173';
const UNAPPROVED_ORIGIN = 'https://other.example.invalid';
/** 誤りの文に出てはいけない目印（秘密に見える query の値）。 */
const SECRET_MARKER = 'secret-marker-7f3c9a';

const AUTH_SETUP_SCHEMA_PATH = resolve(process.cwd(), 'schemas', 'control', 'auth-setup-v3.schema.json');
const AUTH_SETUP_SCHEMA_ID = 'urn:beaksight:schema:control:auth-setup:3';

const targetConfig: AuditConfig = {
  ...createTestConfig(TEST_ORIGIN),
  site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN, LOOPBACK_ORIGIN, UNAPPROVED_ORIGIN] },
};
const context: ProfileValidationContext = { targetConfig };

const testAuthProfileInput = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-test-env',
  revision: 3,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN, LOOPBACK_ORIGIN],
  environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
} satisfies SiteProfile;

const validatedProfileOf = (input: SiteProfile, profileContext: ProfileValidationContext = context): ValidatedSiteProfile => {
  const result = validateSiteProfile(input, profileContext);
  if (!result.ok) {
    throw new Error(`the test profile was rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.profile;
};

const testAuthProfile = validatedProfileOf(testAuthProfileInput);

/** 検証の例の値（版 3 のフォームの送信のログイン。手動のログインなので `automatedLogin` は null）。 */
const validSetup = {
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-test-env',
  profileRevision: 3,
  loginStartUrl: `${TEST_ORIGIN}/admin/login?next=%2Fadmin`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout', '/admin/export'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
} satisfies AuthSetup;

/** 版 3 のスキーマの必須の項目（この順。設計書 4.1 の表、T26b の `automatedLogin`、T34a の版 3 の項目）。 */
const REQUIRED_SETUP_KEYS = Object.freeze([
  'schemaVersion', 'profileId', 'profileRevision', 'loginStartUrl', 'loginPostEndpoints', 'successCondition', 'sessionLostCondition', 'excludedPaths',
  'auditPathPrefixes', 'maxLoginAttempts', 'allowedIdpOrigins', 'automatedLogin', 'loginTransport', 'scriptLogin', 'loginSideRequests', 'successStorageKey',
]);

/** 版 3 のスキーマの任意の項目（T35a）。 */
const OPTIONAL_SETUP_KEYS = Object.freeze(['auditReadRequests', 'serviceRequestLimits']);

/** 拒否のコード（重複を除き、並べた値）。 */
const codesOf = (result: AuthSetupValidationResult): readonly AuthSetupValidationErrorCode[] =>
  result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();

const validate = (input: unknown, profile: ValidatedSiteProfile = testAuthProfile): AuthSetupValidationResult =>
  validateAuthSetup(input, profile, context);

const expectRejectedWith = (input: unknown, code: AuthSetupValidationErrorCode, profile?: ValidatedSiteProfile): void => {
  const result = validate(input, profile);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  expect(codesOf(result)).toContain(code);
};

const withSetup = (overrides: Record<string, unknown>): Record<string, unknown> => ({ ...validSetup, ...overrides });

describe('T25a: the auth setup contract and its schema', () => {
  const schema = JSON.parse(readFileSync(AUTH_SETUP_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>>;

  it('fixes the schema version, the error codes and the named limits', () => {
    expect(AUTH_SETUP_SCHEMA_VERSION_3).toBe('beaksight-auth-setup/3');
    expect(MIN_LOGIN_ATTEMPTS).toBe(1);
    expect(MAX_LOGIN_ATTEMPTS).toBe(3);
    expect(MAX_AUTH_SETUP_URL_LENGTH).toBe(MAX_URL_LENGTH);
    expect(Object.isFrozen(AUTH_SETUP_VALIDATION_ERROR_CODES)).toBe(true);
    expect(new Set(AUTH_SETUP_VALIDATION_ERROR_CODES).size).toBe(AUTH_SETUP_VALIDATION_ERROR_CODES.length);
  });

  it('fixes the closed list of the default excluded words (design 4.1)', () => {
    expect(DEFAULT_EXCLUDED_URL_WORDS).toEqual(['logout', 'signout', 'sign-out', 'log-out', 'delete', 'remove', 'destroy', 'cancel']);
    expect(Object.isFrozen(DEFAULT_EXCLUDED_URL_WORDS)).toBe(true);
    expect(Object.isFrozen(SECRET_LIKE_QUERY_NAME_WORDS)).toBe(true);
    expect(SECRET_LIKE_QUERY_NAME_WORDS).toContain('password');
  });

  it('has the $id of the control schemas, no additional properties, and the fields of the design 4.1 table', () => {
    expect(schema.$id).toBe(AUTH_SETUP_SCHEMA_ID);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(REQUIRED_SETUP_KEYS);
    expect(Object.keys(properties)).toEqual([...REQUIRED_SETUP_KEYS, ...OPTIONAL_SETUP_KEYS]);
    expect(Object.keys(validSetup).sort()).toEqual([...REQUIRED_SETUP_KEYS].sort());
  });

  it('uses the named constants as the limits of the schema', () => {
    const endpoints = properties.loginPostEndpoints ?? {};
    const endpointItem = (endpoints.items ?? {}) as { properties?: Record<string, Record<string, unknown>> };
    const success = (properties.successCondition ?? {}) as { properties?: Record<string, Record<string, unknown>> };
    expect(properties.schemaVersion?.const).toBe(AUTH_SETUP_SCHEMA_VERSION_3);
    expect(properties.loginStartUrl?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(endpoints.maxItems).toBe(MAX_LOGIN_POST_ENDPOINTS);
    // T34a: スクリプトで送るログインは空でよい（フォームの送信で 1 つ以上要るのは、検証の決まり `AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED`）。
    expect(endpoints.minItems).toBe(0);
    expect(endpointItem.properties?.origin?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(endpointItem.properties?.path?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(success.properties?.selector?.maxLength).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    expect(properties.excludedPaths?.maxItems).toBe(MAX_AUTH_SETUP_PATH_LIST_ITEMS);
    expect(properties.auditPathPrefixes?.maxItems).toBe(MAX_AUTH_SETUP_PATH_LIST_ITEMS);
    expect(properties.allowedIdpOrigins?.maxItems).toBe(MAX_ALLOWED_IDP_ORIGINS);
    expect(properties.maxLoginAttempts?.minimum).toBe(MIN_LOGIN_ATTEMPTS);
    expect(properties.maxLoginAttempts?.maximum).toBe(MAX_LOGIN_ATTEMPTS);
    expect(properties.profileRevision?.minimum).toBe(MIN_PROFILE_REVISION);
    expect(properties.profileId?.$ref).toBe('urn:beaksight:schema:control:profile:1#/properties/profileId');
    expect(PROFILE_ID_PATTERN.test(validSetup.profileId)).toBe(true);
  });

  // LG-3b: 版 1・版 2 のスキーマの名前は捨てた（版 3 だけ）。
  it('is one of the control schema names, and the schema accepts the valid setup', () => {
    expect(CONTROL_SCHEMA_NAMES).toContain('auth-setup-v3');
    expect(validateControlDocument('auth-setup-v3', validSetup)).toEqual({ ok: true });
    expect(validateControlDocument('auth-setup-v3', { ...validSetup, extra: true }).ok).toBe(false);
  });
});

describe('T25a: validateAuthSetup accepts a valid setup', () => {
  it('accepts the valid setup and returns a frozen copy that does not share references with the input', () => {
    const input = structuredClone(validSetup);
    const result = validate(input);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }
    expect(result.setup).toEqual(validSetup);
    expect(result.setup).not.toBe(input);
    expect(Object.isFrozen(result.setup)).toBe(true);
    expect(Object.isFrozen(result.setup.loginPostEndpoints[0])).toBe(true);
    input.excludedPaths.push('/changed');
    expect(result.setup.excludedPaths).toEqual(validSetup.excludedPaths);
  });

  it.each([
    ['a loopback http origin', withSetup({
      loginStartUrl: `${LOOPBACK_ORIGIN}/login`,
      loginPostEndpoints: [{ origin: LOOPBACK_ORIGIN, path: '/login' }],
    })],
    ['no selector, an explicit session lost path, and no audit prefixes', withSetup({
      successCondition: { pathPrefix: '/admin/home', selector: null },
      sessionLostCondition: { pathPrefix: '/admin/session-expired' },
      auditPathPrefixes: [],
      excludedPaths: [],
    })],
    ['the lowest number of login attempts', withSetup({ maxLoginAttempts: MIN_LOGIN_ATTEMPTS })],
    ['the highest number of login attempts', withSetup({ maxLoginAttempts: MAX_LOGIN_ATTEMPTS })],
    ['the most login post endpoints', withSetup({
      loginPostEndpoints: Array.from({ length: MAX_LOGIN_POST_ENDPOINTS }, (_value, index) => ({ origin: TEST_ORIGIN, path: `/login/${index}` })),
    })],
    ['the most excluded paths', withSetup({
      excludedPaths: Array.from({ length: MAX_AUTH_SETUP_PATH_LIST_ITEMS }, (_value, index) => `/admin/item-${index}`),
    })],
    ['percent-encoded characters in a path', withSetup({ excludedPaths: ['/admin/%E3%81%82'] })],
  ])('accepts %s', (_name, input) => {
    const result = validate(input);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it('resolves the session lost path from the login start URL when it is null (design 4.1 default)', () => {
    const result = validate(validSetup);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(sessionLostPathPrefixOf(result.setup)).toBe('/admin/login');
    const explicit = validate(withSetup({ sessionLostCondition: { pathPrefix: '/signin' } }));
    if (!explicit.ok) {
      throw new Error('unreachable');
    }
    expect(sessionLostPathPrefixOf(explicit.setup)).toBe('/signin');
  });
});

describe('T25a: validateAuthSetup rejects each rule violation with its own code (fail-closed)', () => {
  it('rejects values that are not plain JSON and wrong shapes with AUTH_SETUP_SCHEMA_INVALID', () => {
    expect(codesOf(validate(() => undefined))).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
    expect(codesOf(validate(null))).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
    expect(codesOf(validate(withSetup({ extra: 1 })))).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
    expect(codesOf(validate(withSetup({ maxLoginAttempts: 1.5 })))).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
  });

  // LG-3b（O1。`control-auth-setup-v2.test.ts` と `control-auth-setup-v3.test.ts` の同じ確かめをまとめた）: 検証が受けるのは版 3 だけ。前の版
  // （版 1・版 2）の文書、版の文字列だけを変えた文書、知らない版は、形の誤り。
  it('rejects the documents of version 1 and version 2 and of an unknown version with AUTH_SETUP_SCHEMA_INVALID (LG-3)', () => {
    for (const document of [
      previousVersionSetupDocumentOf(validSetup, 1),
      previousVersionSetupDocumentOf(validSetup, 2),
      withSetup({ schemaVersion: 'beaksight-auth-setup/1' }),
      withSetup({ schemaVersion: 'beaksight-auth-setup/2' }),
      withSetup({ schemaVersion: 'beaksight-auth-setup/4' }),
    ]) {
      expect(codesOf(validate(document)), JSON.stringify(document.schemaVersion)).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
    }
  });

  it('rejects a PUBLIC_PASSIVE profile with AUTH_SETUP_MODE_UNSUPPORTED', () => {
    const publicProfile = validatedProfileOf({
      ...testAuthProfileInput,
      environment: 'PUBLIC',
      mode: 'PUBLIC_PASSIVE',
      auth: 'NONE',
      approvedTestOrigins: [],
      environmentEvidenceRef: null,
    });
    const result = validate(validSetup, publicProfile);
    expect(codesOf(result)).toContain('AUTH_SETUP_MODE_UNSUPPORTED');
  });

  // T26b: `TEST_AUTH_PASSIVE` の `AUTOMATED_LOGIN` は受ける方式になった（版 2 の `automatedLogin` が要る。`control-auth-setup-v2.test.ts`）。
  // T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5）: `TEST_APPROVED_WRITE` も、認証つきの読み取りの監査と同じ条件で受ける（手動のログインは
  // そのまま通り、自動ログインは版 2 の `automatedLogin` が要る）。T26b までは、どちらの認証の方式でも `AUTH_SETUP_MODE_UNSUPPORTED` だった。
  it('accepts a TEST_APPROVED_WRITE profile on the same conditions as TEST_AUTH_PASSIVE (T28b)', () => {
    const manual = validate(validSetup, validatedProfileOf({ ...testAuthProfileInput, mode: 'TEST_APPROVED_WRITE' }));
    expect(manual.ok).toBe(true);
    expect(manual).toEqual(validate(validSetup, validatedProfileOf(testAuthProfileInput)));
    const automated = validate(validSetup, validatedProfileOf({ ...testAuthProfileInput, mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN' }));
    expect(codesOf(automated)).not.toContain('AUTH_SETUP_MODE_UNSUPPORTED');
    expect(codesOf(automated)).toContain('AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED');
  });

  it('does not reject a TEST_AUTH_PASSIVE profile with AUTOMATED_LOGIN as an unsupported mode (T26b)', () => {
    const result = validate(validSetup, validatedProfileOf({ ...testAuthProfileInput, auth: 'AUTOMATED_LOGIN' }));
    expect(codesOf(result)).not.toContain('AUTH_SETUP_MODE_UNSUPPORTED');
    expect(codesOf(result)).toContain('AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED');
  });

  it('rejects a profile that does not pass validateSiteProfile again with the given context', () => {
    // 型の変換で印を付けた、検証していないプロファイル（環境の証拠がない）。
    const forged = { ...testAuthProfileInput, environmentEvidenceRef: null } as unknown as ValidatedSiteProfile;
    expectRejectedWith(validSetup, 'AUTH_SETUP_PROFILE_INVALID', forged);
  });

  it('rejects a different profileId with AUTH_SETUP_PROFILE_MISMATCH', () => {
    expect(codesOf(validate(withSetup({ profileId: 'example-other' })))).toEqual(['AUTH_SETUP_PROFILE_MISMATCH']);
  });

  it('rejects a different profile revision with AUTH_SETUP_PROFILE_REVISION_MISMATCH (older and newer)', () => {
    expect(codesOf(validate(withSetup({ profileRevision: 2 })))).toEqual(['AUTH_SETUP_PROFILE_REVISION_MISMATCH']);
    expect(codesOf(validate(withSetup({ profileRevision: 4 })))).toEqual(['AUTH_SETUP_PROFILE_REVISION_MISMATCH']);
  });

  it('rejects origins outside approvedTestOrigins with AUTH_SETUP_ORIGIN_NOT_APPROVED (even when the target allows them)', () => {
    expect(codesOf(validate(withSetup({ loginStartUrl: `${UNAPPROVED_ORIGIN}/login` })))).toEqual(['AUTH_SETUP_ORIGIN_NOT_APPROVED']);
    expect(codesOf(validate(withSetup({ loginPostEndpoints: [{ origin: UNAPPROVED_ORIGIN, path: '/login' }] }))))
      .toEqual(['AUTH_SETUP_ORIGIN_NOT_APPROVED']);
    // 同じ host の別の port、別の scheme は、別の Origin。
    expectRejectedWith(withSetup({ loginStartUrl: 'https://app.example.invalid:8443/login' }), 'AUTH_SETUP_ORIGIN_NOT_APPROVED');
    expectRejectedWith(withSetup({ loginPostEndpoints: [{ origin: 'http://127.0.0.1:4174', path: '/login' }] }), 'AUTH_SETUP_ORIGIN_NOT_APPROVED');
  });

  it('rejects approvedTestOrigins that the current target configuration does not allow with AUTH_SETUP_ORIGIN_OUTSIDE_TARGET', () => {
    const narrowedContext: ProfileValidationContext = {
      targetConfig: { ...targetConfig, site: { ...targetConfig.site, allowedOrigins: [TEST_ORIGIN] } },
    };
    const result = validateAuthSetup(validSetup, testAuthProfile, narrowedContext);
    expect(codesOf(result)).toContain('AUTH_SETUP_ORIGIN_OUTSIDE_TARGET');
    expect(codesOf(result)).toContain('AUTH_SETUP_PROFILE_INVALID');
  });

  it('rejects any IdP origin in Stage 1 with AUTH_SETUP_IDP_NOT_SUPPORTED', () => {
    expect(codesOf(validate(withSetup({ allowedIdpOrigins: [TEST_ORIGIN] })))).toEqual(['AUTH_SETUP_IDP_NOT_SUPPORTED']);
    expect(codesOf(validate(withSetup({ allowedIdpOrigins: ['https://idp.example.invalid'] })))).toEqual(['AUTH_SETUP_IDP_NOT_SUPPORTED']);
  });

  it.each([
    ['userinfo', `https://user:pass@app.example.invalid/login`],
    ['a user name only', `https://user@app.example.invalid/login`],
    ['a fragment', `${TEST_ORIGIN}/login#top`],
    ['an empty fragment', `${TEST_ORIGIN}/login#`],
    ['a non-http scheme', 'ftp://app.example.invalid/login'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a relative URL', '/login'],
    ['a non-canonical URL (upper case host)', 'https://APP.example.invalid/login'],
    ['a non-canonical URL (dot segments)', `${TEST_ORIGIN}/admin/../login`],
    ['a leading space', ` ${TEST_ORIGIN}/login`],
    ['a tab inside', `${TEST_ORIGIN}/lo\tgin`],
  ])('rejects a login start URL with %s with AUTH_SETUP_URL_INVALID', (_name, loginStartUrl) => {
    expectRejectedWith(withSetup({ loginStartUrl }), 'AUTH_SETUP_URL_INVALID');
  });

  it.each([
    ['a trailing slash', `${TEST_ORIGIN}/`],
    ['a path', `${TEST_ORIGIN}/login`],
    ['userinfo', 'https://user@app.example.invalid'],
    ['upper case', 'https://APP.example.invalid'],
    ['not a URL', 'app.example.invalid'],
  ])('rejects a login post endpoint origin with %s with AUTH_SETUP_URL_INVALID', (_name, origin) => {
    expectRejectedWith(withSetup({ loginPostEndpoints: [{ origin, path: '/login' }] }), 'AUTH_SETUP_URL_INVALID');
  });

  it.each([
    ['an empty path', ''],
    ['no leading slash', 'admin/logout'],
    ['a protocol-relative path', '//other.example.invalid/logout'],
    ['a parent segment', '/admin/../logout'],
    ['two dots in a name', '/admin/a..b'],
    ['an encoded dot', '/admin/%2e%2e/logout'],
    ['an upper case encoded dot', '/admin/%2E%2E/logout'],
    ['a malformed percent encoding', '/admin/%zz'],
    ['a control character', '/admin/\u0000logout'],
    ['a line break', '/admin/\nlogout'],
    ['a space', '/admin/log out'],
    ['a backslash', '/admin\\logout'],
    ['a query', '/admin/logout?x=1'],
    ['a fragment', '/admin/logout#x'],
    ['a non-ASCII character', '/admin/あ'],
  ])('rejects an excluded path with %s with AUTH_SETUP_PATH_INVALID', (_name, path) => {
    expect(codesOf(validate(withSetup({ excludedPaths: [path] })))).toEqual(['AUTH_SETUP_PATH_INVALID']);
  });

  it('checks the path form of every path field', () => {
    const badPath = '/admin/../x';
    expectRejectedWith(withSetup({ auditPathPrefixes: [badPath] }), 'AUTH_SETUP_PATH_INVALID');
    expectRejectedWith(withSetup({ loginPostEndpoints: [{ origin: TEST_ORIGIN, path: badPath }] }), 'AUTH_SETUP_PATH_INVALID');
    expectRejectedWith(withSetup({ successCondition: { pathPrefix: badPath, selector: null } }), 'AUTH_SETUP_PATH_INVALID');
    expectRejectedWith(withSetup({ sessionLostCondition: { pathPrefix: badPath } }), 'AUTH_SETUP_PATH_INVALID');
  });

  it.each([
    ['blank', '   '],
    ['a control character', '#menu\u0000'],
    ['a line break', '#menu\n.item'],
    ['an empty string', ''],
  ])('rejects a success selector that is %s with AUTH_SETUP_SELECTOR_INVALID', (_name, selector) => {
    expectRejectedWith(withSetup({ successCondition: { pathPrefix: '/admin/home', selector } }), 'AUTH_SETUP_SELECTOR_INVALID');
  });

  it.each([
    ['the root path', '/'],
    ['a parent of the login path', '/admin/'],
    ['the login path itself', '/admin/login'],
    ['a string prefix of the login path', '/admin/log'],
  ])('rejects a success path prefix that is %s with AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS (even with a selector)', (_name, pathPrefix) => {
    expect(codesOf(validate(withSetup({ successCondition: { pathPrefix, selector: '#account-menu' } }))))
      .toEqual(['AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS']);
    expect(codesOf(validate(withSetup({ successCondition: { pathPrefix, selector: null } }))))
      .toEqual(['AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS']);
  });

  it('rejects a success path prefix that also matches the explicit session lost path with AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS', () => {
    expect(codesOf(validate(withSetup({
      successCondition: { pathPrefix: '/signin', selector: null },
      sessionLostCondition: { pathPrefix: '/signin/expired' },
    })))).toEqual(['AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS']);
    expect(codesOf(validate(withSetup({
      successCondition: { pathPrefix: '/account', selector: null },
      sessionLostCondition: { pathPrefix: '/account' },
    })))).toEqual(['AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS']);
  });

  it('accepts a success path prefix that only shares a beginning with the login path but does not match it', () => {
    const result = validate(withSetup({ successCondition: { pathPrefix: '/admin/login-done', selector: null } }));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });

  it.each([
    ['password', `password=${SECRET_MARKER}`],
    ['a mixed case token name', `Access_Token=${SECRET_MARKER}`],
    ['a session id', `sid=${SECRET_MARKER}`],
    ['an api key with a separator', `api-key=${SECRET_MARKER}`],
    ['an OAuth code', `code=${SECRET_MARKER}`],
  ])('rejects a login start URL whose query has %s with AUTH_SETUP_SECRET_LIKE_VALUE, without the value in the errors', (_name, query) => {
    const result = validate(withSetup({ loginStartUrl: `${TEST_ORIGIN}/login?${query}` }));
    expect(codesOf(result)).toEqual(['AUTH_SETUP_SECRET_LIKE_VALUE']);
    expect(JSON.stringify(result)).not.toContain(SECRET_MARKER);
  });

  it.each([
    ['a login attempt limit of 0', { maxLoginAttempts: 0 }],
    ['a login attempt limit above the maximum', { maxLoginAttempts: MAX_LOGIN_ATTEMPTS + 1 }],
    ['too many login post endpoints', {
      loginPostEndpoints: Array.from({ length: MAX_LOGIN_POST_ENDPOINTS + 1 }, (_value, index) => ({ origin: TEST_ORIGIN, path: `/l/${index}` })),
    }],
    ['too many excluded paths', { excludedPaths: Array.from({ length: MAX_AUTH_SETUP_PATH_LIST_ITEMS + 1 }, (_value, index) => `/x/${index}`) }],
    ['too many audit path prefixes', { auditPathPrefixes: Array.from({ length: MAX_AUTH_SETUP_PATH_LIST_ITEMS + 1 }, (_value, index) => `/x/${index}`) }],
    ['too many IdP origins', { allowedIdpOrigins: Array.from({ length: MAX_ALLOWED_IDP_ORIGINS + 1 }, (_value, index) => `https://idp${index}.example.invalid`) }],
    ['a too long login start URL', { loginStartUrl: `${TEST_ORIGIN}/${'a'.repeat(MAX_AUTH_SETUP_URL_LENGTH)}` }],
    ['a too long path', { excludedPaths: [`/${'a'.repeat(MAX_AUTH_SETUP_URL_LENGTH)}`] }],
    ['a too long selector', { successCondition: { pathPrefix: '/admin/home', selector: `#${'a'.repeat(MAX_SUCCESS_SELECTOR_LENGTH)}` } }],
    ['a too long selector in UTF-16 code units', {
      successCondition: { pathPrefix: '/admin/home', selector: '\u{1f600}'.repeat(MAX_SUCCESS_SELECTOR_LENGTH / 2 + 1) },
    }],
  ])('rejects %s with AUTH_SETUP_LIMIT_EXCEEDED', (_name, overrides) => {
    expect(codesOf(validate(withSetup(overrides)))).toEqual(['AUTH_SETUP_LIMIT_EXCEEDED']);
  });

  it('returns every rule violation at once', () => {
    const result = validate(withSetup({
      profileRevision: 2,
      loginStartUrl: `${UNAPPROVED_ORIGIN}/login`,
      excludedPaths: ['/a/../b'],
      allowedIdpOrigins: ['https://idp.example.invalid'],
    }));
    expect(codesOf(result)).toEqual([
      'AUTH_SETUP_IDP_NOT_SUPPORTED',
      'AUTH_SETUP_ORIGIN_NOT_APPROVED',
      'AUTH_SETUP_PATH_INVALID',
      'AUTH_SETUP_PROFILE_REVISION_MISMATCH',
    ]);
  });

  it('uses only the codes in the closed list, and puts no setting value into the error details', () => {
    const marker = 'value-marker-51d0';
    const result = validate(withSetup({
      loginStartUrl: `https://${marker}.example.invalid/login?password=${marker}#${marker}`,
      loginPostEndpoints: [{ origin: `https://${marker}.example.invalid`, path: `/${marker}/../x` }],
      excludedPaths: [`/${marker}/../x`],
      successCondition: { pathPrefix: `/${marker}/../x`, selector: `#${marker}\n` },
      allowedIdpOrigins: [`https://${marker}.example.invalid`],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    for (const error of result.errors) {
      expect(AUTH_SETUP_VALIDATION_ERROR_CODES).toContain(error.code);
      expect(Object.isFrozen(error)).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('does not throw for a Proxy or a getter that throws, and does not read the input twice', () => {
    let reads = 0;
    const tricky = { ...validSetup };
    Object.defineProperty(tricky, 'loginStartUrl', { enumerable: true, get: () => { reads += 1; return validSetup.loginStartUrl; } });
    expect(validate(tricky).ok).toBe(true);
    expect(reads).toBe(1);
    const throwing = new Proxy({}, { ownKeys: () => { throw new Error('trap'); } });
    expect(codesOf(validate(throwing))).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
  });
});
