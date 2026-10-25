// T34a（Task 34 の設計書 3.1・3.2・4 章）: 認証の設定の版 3（`beaksight-auth-setup/3`）の契約・スキーマ・検証の検査。
// - 契約（`src/control/auth/auth-setup-contracts.ts`）と版 3 の JSON Schema（`schemas/control/auth-setup-v3.schema.json`）の項目・閉じた一覧・上限の
//   一致。
// - 検証（`validateAuthSetup`）は版 3 だけを受ける（LG-3b: 版 1・版 2 は形の誤り。確かめは `control-auth-setup.test.ts` の 1 か所）。版 3 の決まり:
//   - ログインの送り方（`loginTransport`）が `FORM_NAVIGATION` なら、スクリプトの送信先・ログインに伴う送信・成功のローカル ストレージの鍵を
//     持てず、フォームの送信先（`loginPostEndpoints`）が 1 つ以上要る（今の形）。
//   - `SCRIPT_REQUEST` なら、スクリプトの送信先（`scriptLogin`）と成功の鍵（`successStorageKey`）が要り、フォームの送信先は空でよい。送信先の
//     Origin はプロファイルの承認したサービスの Origin（`approvedServiceOrigins`）のどれか、必須の query は名前と値の組（名前の重なりなし。
//     秘密に見える名前は持てない）、成功の鍵の Origin は承認したテストの Origin のどれかで、接頭辞と接尾辞の両方が空ではいけない。
//   - ログインに伴う送信（`loginSideRequests`）の Origin は、承認したテストの Origin かサービスの Origin。同じ送信先（Origin と path）は 2 つ
//     持てず、スクリプトの送信先とも重ならない。method は `POST` だけ、ログインの段 1 回あたりの上限は 1〜3。
// - 誤りの文に、設定の値（Origin、path、query の名前と値、鍵の形）を入れない。
// 例の値は、匿名の値（`example.invalid`、`127.0.0.1`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_3,
  AUDIT_READ_REQUEST_METHODS,
  AUTH_SETUP_VALIDATION_ERROR_CODES,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  DEFAULT_SERVICE_REQUEST_LIMITS,
  MAX_AUDIT_READ_REQUESTS,
  MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD,
  MAX_SERVICE_REQUESTS_PER_MINUTE,
  MAX_SERVICE_REQUESTS_PER_RUN,
  MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD,
  MIN_SERVICE_REQUESTS_PER_MINUTE,
  MIN_SERVICE_REQUESTS_PER_RUN,
  LOGIN_SIDE_REQUEST_METHODS,
  LOGIN_TRANSPORTS,
  MAX_LOGIN_SIDE_REQUESTS,
  MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH,
  MAX_SCRIPT_LOGIN_REQUIRED_QUERY,
  MAX_SUCCESS_STORAGE_KEY_PART_LENGTH,
  MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE,
  type AuthSetupV3,
  type AuthSetupValidationErrorCode,
  type AuthSetupValidationResult,
} from '../../src/control/auth/auth-setup-contracts.js';
import { validateAuthSetup } from '../../src/control/auth/auth-setup-policy.js';
import { MAX_APPROVED_SERVICE_ORIGINS, SITE_PROFILE_SCHEMA_VERSION, type SiteProfile, type ValidatedSiteProfile } from '../../src/control/contracts.js';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../src/control/profile-policy.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'https://auth.example.invalid';
const API_ORIGIN = 'https://api.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';

const V3_SCHEMA_PATH = resolve(process.cwd(), 'schemas', 'control', 'auth-setup-v3.schema.json');

const targetConfig: AuditConfig = {
  ...createTestConfig(TEST_ORIGIN),
  site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN, LOOPBACK_ORIGIN] },
};
const context: ProfileValidationContext = { targetConfig };

const profileInput = {
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-test-env',
  revision: 3,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN, LOOPBACK_ORIGIN],
  environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
  approvedServiceOrigins: [SERVICE_ORIGIN, API_ORIGIN],
} satisfies SiteProfile;

const validatedProfileOf = (input: SiteProfile): ValidatedSiteProfile => {
  const result = validateSiteProfile(input, context);
  if (!result.ok) {
    throw new Error(`the test profile was rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.profile;
};

const scriptProfile = validatedProfileOf(profileInput);
const profileWithoutServices = validatedProfileOf((() => {
  const { approvedServiceOrigins: _omitted, ...rest } = profileInput;
  return rest;
})());

/** スクリプトで送るログインの版 3 の設定（受ける形）。 */
const scriptSetup = {
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: 'example-test-env',
  profileRevision: 3,
  loginStartUrl: `${TEST_ORIGIN}/login`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/logout'],
  auditPathPrefixes: [],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [
    { origin: API_ORIGIN, path: '/rest/v1/rpc/resolve_tenant', method: 'POST', maxPerLoginStage: 2 },
    { origin: TEST_ORIGIN, path: '/functions/v1/sync', method: 'POST', maxPerLoginStage: 1 },
  ],
  successStorageKey: { origin: TEST_ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
} satisfies AuthSetupV3;

/** フォームの送信のログインの版 3 の設定（今の形を版 3 で書いたもの）。 */
const formSetup = {
  ...scriptSetup,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
  loginTransport: 'FORM_NAVIGATION',
  scriptLogin: null,
  loginSideRequests: [],
  successStorageKey: null,
} satisfies AuthSetupV3;

const codesOf = (result: AuthSetupValidationResult): readonly AuthSetupValidationErrorCode[] =>
  result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();

const validate = (input: unknown, profile: ValidatedSiteProfile = scriptProfile): AuthSetupValidationResult =>
  validateAuthSetup(input, profile, context);

/** 版 3 のスキーマ（項目と上限の確かめ）。 */
type JsonSchema = Record<string, unknown> & { readonly properties?: Record<string, JsonSchema>; readonly items?: JsonSchema; readonly $defs?: Record<string, JsonSchema> };
const V3_SCHEMA = JSON.parse(readFileSync(V3_SCHEMA_PATH, 'utf8')) as JsonSchema;
const propertyOf = (node: JsonSchema | undefined, key: string): JsonSchema => node?.properties?.[key] ?? {};
const variantOf = (node: JsonSchema): JsonSchema => {
  const variants = node['anyOf'] as readonly JsonSchema[] | undefined;
  return variants?.find((variant) => variant['type'] === 'object') ?? node;
};

describe('T34a: the auth setup version 3 contract and schema', () => {
  // LG-3b: 版 1・版 2 のスキーマは捨てた（版 3 だけ）。
  it('registers the version 3 schema only', () => {
    expect(AUTH_SETUP_SCHEMA_VERSION_3).toBe('beaksight-auth-setup/3');
    expect(CONTROL_SCHEMA_NAMES).toContain('auth-setup-v3');
    expect(CONTROL_SCHEMA_NAMES).not.toContain('auth-setup');
    expect(CONTROL_SCHEMA_NAMES).not.toContain('auth-setup-v2');
    expect(propertyOf(V3_SCHEMA, 'schemaVersion')['const']).toBe(AUTH_SETUP_SCHEMA_VERSION_3);
  });

  it('has the closed lists and the limits of the contract in the schema', () => {
    expect(LOGIN_TRANSPORTS).toEqual(['FORM_NAVIGATION', 'SCRIPT_REQUEST']);
    expect(LOGIN_SIDE_REQUEST_METHODS).toEqual(['POST']);
    expect(Object.isFrozen(LOGIN_TRANSPORTS) && Object.isFrozen(LOGIN_SIDE_REQUEST_METHODS)).toBe(true);
    const script = variantOf(propertyOf(V3_SCHEMA, 'scriptLogin'));
    expect(propertyOf(script, 'requiredQuery')['maxItems']).toBe(MAX_SCRIPT_LOGIN_REQUIRED_QUERY);
    const query = propertyOf(script, 'requiredQuery').items;
    expect(propertyOf(query, 'name')['maxLength']).toBe(MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH);
    expect(propertyOf(query, 'value')['maxLength']).toBe(MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH);
    const side = propertyOf(V3_SCHEMA, 'loginSideRequests');
    expect(side['maxItems']).toBe(MAX_LOGIN_SIDE_REQUESTS);
    expect(propertyOf(side.items, 'maxPerLoginStage')['minimum']).toBe(MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE);
    expect(propertyOf(side.items, 'maxPerLoginStage')['maximum']).toBe(MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE);
    const key = variantOf(propertyOf(V3_SCHEMA, 'successStorageKey'));
    expect(propertyOf(key, 'prefix')['maxLength']).toBe(MAX_SUCCESS_STORAGE_KEY_PART_LENGTH);
    expect(propertyOf(key, 'suffix')['maxLength']).toBe(MAX_SUCCESS_STORAGE_KEY_PART_LENGTH);
    // スクリプトの送信先は method を持たない（`POST` に固定）。
    expect(Object.keys(script.properties ?? {}).sort()).toEqual(['origin', 'path', 'requiredQuery']);
    expect(MAX_APPROVED_SERVICE_ORIGINS).toBe(4);
  });

  it('accepts the version 3 documents in the schema, and rejects a version 3 document without the version 3 properties', () => {
    expect(validateControlDocument('auth-setup-v3', scriptSetup).ok).toBe(true);
    expect(validateControlDocument('auth-setup-v3', formSetup).ok).toBe(true);
    const { loginTransport: _a, scriptLogin: _b, loginSideRequests: _c, successStorageKey: _d, ...withoutVersion3Items } = formSetup;
    expect(validateControlDocument('auth-setup-v3', withoutVersion3Items).ok).toBe(false);
  });
});

// LG-3b: 版 1・版 2 と知らない版の文書を形の誤りにする確かめは、`control-auth-setup.test.ts` の 1 か所（O1）。
describe('T34a: validateAuthSetup accepts version 3', () => {
  it('accepts a script login setup and a form navigation setup of version 3', () => {
    for (const setup of [scriptSetup, formSetup]) {
      const result = validate(setup);
      expect(codesOf(result), setup.loginTransport).toEqual([]);
      expect(result.ok && result.setup).toEqual(setup);
    }
    // 承認したサービスの Origin のないプロファイルでも、フォームの送信の版 3 は受ける。
    expect(codesOf(validate(formSetup, profileWithoutServices))).toEqual([]);
  });

  it.each<readonly [string, Record<string, unknown>, readonly AuthSetupValidationErrorCode[]]>([
    // 送り方と項目の組。T44e（Task 44 の設計書 P2-8）: 手動のログインのプロファイル（このテストの既定）では、token の送信先と成功の鍵がなくてよい
    // （下の T44e の describe）。自動ログインのプロファイルは今どおり求める。
    ['a form navigation with a script target', { loginTransport: 'FORM_NAVIGATION', loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
      successStorageKey: null, loginSideRequests: [] }, ['AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED']],
    ['a form navigation with a success storage key', { ...formSetup, successStorageKey: scriptSetup.successStorageKey }, ['AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED']],
    ['a form navigation with login side requests', { ...formSetup, loginSideRequests: scriptSetup.loginSideRequests }, ['AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED']],
    ['a form navigation without a login endpoint', { ...formSetup, loginPostEndpoints: [] }, ['AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED']],
    ['an unknown transport', { loginTransport: 'BEACON' }, ['AUTH_SETUP_SCHEMA_INVALID']],
    // スクリプトの送信先。
    ['a script target on a test origin', { scriptLogin: { ...scriptSetup.scriptLogin, origin: TEST_ORIGIN } }, ['AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED']],
    ['a script target on an origin that is not approved', { scriptLogin: { ...scriptSetup.scriptLogin, origin: OTHER_ORIGIN } },
      ['AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED']],
    ['a script target origin that is not canonical', { scriptLogin: { ...scriptSetup.scriptLogin, origin: `${SERVICE_ORIGIN}/` } }, ['AUTH_SETUP_URL_INVALID']],
    ['a script target path with a parent segment', { scriptLogin: { ...scriptSetup.scriptLogin, path: '/auth/../token' } }, ['AUTH_SETUP_PATH_INVALID']],
    ['a script target path with a query', { scriptLogin: { ...scriptSetup.scriptLogin, path: '/auth/v1/token?grant_type=password' } }, ['AUTH_SETUP_PATH_INVALID']],
    ['a script method', { scriptLogin: { ...scriptSetup.scriptLogin, method: 'POST' } }, ['AUTH_SETUP_SCHEMA_INVALID']],
    ['a duplicated required query name', { scriptLogin: { ...scriptSetup.scriptLogin,
      requiredQuery: [{ name: 'grant_type', value: 'password' }, { name: 'grant_type', value: 'refresh_token' }] } }, ['AUTH_SETUP_REQUIRED_QUERY_INVALID']],
    ['an empty required query name', { scriptLogin: { ...scriptSetup.scriptLogin, requiredQuery: [{ name: '', value: 'password' }] } },
      ['AUTH_SETUP_REQUIRED_QUERY_INVALID']],
    ['a required query value with a control character', { scriptLogin: { ...scriptSetup.scriptLogin, requiredQuery: [{ name: 'grant_type', value: 'pass\nword' }] } },
      ['AUTH_SETUP_REQUIRED_QUERY_INVALID']],
    ['a required query name that looks like a secret', { scriptLogin: { ...scriptSetup.scriptLogin, requiredQuery: [{ name: 'password', value: 'x' }] } },
      ['AUTH_SETUP_SECRET_LIKE_VALUE']],
    ['too many required queries', { scriptLogin: { ...scriptSetup.scriptLogin,
      requiredQuery: Array.from({ length: MAX_SCRIPT_LOGIN_REQUIRED_QUERY + 1 }, (_, index) => ({ name: `q${index}`, value: 'x' })) } }, ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a too long required query value', { scriptLogin: { ...scriptSetup.scriptLogin,
      requiredQuery: [{ name: 'grant_type', value: 'x'.repeat(MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH + 1) }] } }, ['AUTH_SETUP_LIMIT_EXCEEDED']],
    // ログインに伴う送信。
    ['a side request on an origin that is not approved', { loginSideRequests: [{ origin: OTHER_ORIGIN, path: '/rpc', method: 'POST', maxPerLoginStage: 1 }] },
      ['AUTH_SETUP_ORIGIN_NOT_APPROVED']],
    ['a side request with another method', { loginSideRequests: [{ origin: API_ORIGIN, path: '/rpc', method: 'PUT', maxPerLoginStage: 1 }] },
      ['AUTH_SETUP_SCHEMA_INVALID']],
    ['a side request without a limit', { loginSideRequests: [{ origin: API_ORIGIN, path: '/rpc', method: 'POST', maxPerLoginStage: 0 }] },
      ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a side request above the limit', { loginSideRequests: [{ origin: API_ORIGIN, path: '/rpc', method: 'POST',
      maxPerLoginStage: MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE + 1 }] }, ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['too many side requests', { loginSideRequests: Array.from({ length: MAX_LOGIN_SIDE_REQUESTS + 1 }, (_, index) =>
      ({ origin: API_ORIGIN, path: `/rpc/${index}`, method: 'POST', maxPerLoginStage: 1 })) }, ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a duplicated side request', { loginSideRequests: [scriptSetup.loginSideRequests[0], { ...scriptSetup.loginSideRequests[0], maxPerLoginStage: 1 }] },
      ['AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED']],
    ['a side request to the script target', { loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/auth/v1/token', method: 'POST', maxPerLoginStage: 1 }] },
      ['AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED']],
    ['a side request path with a parent segment', { loginSideRequests: [{ origin: API_ORIGIN, path: '/rpc/../x', method: 'POST', maxPerLoginStage: 1 }] },
      ['AUTH_SETUP_PATH_INVALID']],
    // 成功のローカル ストレージの鍵。
    ['a storage key on a service origin', { successStorageKey: { ...scriptSetup.successStorageKey, origin: SERVICE_ORIGIN } }, ['AUTH_SETUP_ORIGIN_NOT_APPROVED']],
    ['a storage key without a prefix and a suffix', { successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '' } }, ['AUTH_SETUP_STORAGE_KEY_INVALID']],
    ['a storage key with a control character', { successStorageKey: { ...scriptSetup.successStorageKey, suffix: '-auth\ttoken' } }, ['AUTH_SETUP_STORAGE_KEY_INVALID']],
    ['a too long storage key prefix', { successStorageKey: { ...scriptSetup.successStorageKey, prefix: 'x'.repeat(MAX_SUCCESS_STORAGE_KEY_PART_LENGTH + 1) } },
      ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a storage key with a value', { successStorageKey: { ...scriptSetup.successStorageKey, value: 'x' } }, ['AUTH_SETUP_SCHEMA_INVALID']],
  ])('rejects a version 3 setup with %s', (_label, change, codes) => {
    expect(codesOf(validate({ ...scriptSetup, ...change }))).toEqual(codes);
  });

  it('rejects a script login for a profile without approved service origins', () => {
    expect(codesOf(validate(scriptSetup, profileWithoutServices))).toEqual(['AUTH_SETUP_ORIGIN_NOT_APPROVED', 'AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED']);
  });

  it('writes no value of the setup into the details, and points at the item', () => {
    const marked = {
      ...scriptSetup,
      scriptLogin: { origin: 'https://marker-origin.example.invalid', path: '/marker-path/../x', requiredQuery: [{ name: 'marker_name', value: 'marker\nvalue' }] },
      successStorageKey: { origin: TEST_ORIGIN, prefix: '', suffix: '' },
    };
    const result = validate(marked);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = result.errors.map(({ detail }) => detail).join(' ');
      for (const value of ['marker-origin', 'marker-path', 'marker_name', 'marker']) {
        expect(details, value).not.toContain(value);
      }
      expect(result.errors.map(({ pointer }) => pointer)).toEqual(expect.arrayContaining(['/scriptLogin/origin', '/scriptLogin/path',
        '/scriptLogin/requiredQuery/0', '/successStorageKey']));
      for (const error of result.errors) {
        expect(AUTH_SETUP_VALIDATION_ERROR_CODES).toContain(error.code);
      }
    }
  });
});

// T34R-fix-b（独立レビュー T34R の M-3・M-6。設計者の判断）:
// - M-3（T36a で外した。Task 36 の設計書 3.1）: 自動ログインのプロファイル（`AUTOMATED_LOGIN`）の設定も、スクリプトで送るログイン（`SCRIPT_REQUEST`）を
//   持てる。拒んでいた理由コード `AUTH_SETUP_SCRIPT_LOGIN_AUTOMATED_NOT_SUPPORTED` は、閉じた一覧から外した（検証の誤りのコードは保存しないので、
//   残す読み手がない）。フォームの送信は今どおり。
// - M-6: 必須の query の値に、値に見える判定（`src/core/url-path-redaction.ts` の `isValueLikeText`。長い base64url・16 進・標準の base64・JWT の形・
//   メールアドレスの形）を当て、当たれば `AUTH_SETUP_SECRET_LIKE_VALUE`。`password` のような語は通る。誤りの文に値を入れない。
describe('T34R-fix-b: the script login of an automated login profile, and the values of the required query', () => {
  const automatedProfile = validatedProfileOf({ ...profileInput, auth: 'AUTOMATED_LOGIN' });
  const automatedLogin = {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#go',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/login', selector: '#login-failed' },
      accountLocked: null,
      mfaRequired: null,
      credentialExpired: null,
    },
  };
  const automatedOf = (setup: AuthSetupV3): AuthSetupV3 => ({ ...setup, automatedLogin, maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS });

  it('T36a: accepts SCRIPT_REQUEST and the form navigation for an automated login profile, and has no code that rejects it', () => {
    for (const setup of [automatedOf(scriptSetup), automatedOf(formSetup)]) {
      const result = validate(setup, automatedProfile);
      expect(codesOf(result), setup.loginTransport).toEqual([]);
      expect(result.ok && result.setup).toEqual(setup);
    }
    expect(AUTH_SETUP_VALIDATION_ERROR_CODES as readonly string[]).not.toContain('AUTH_SETUP_SCRIPT_LOGIN_AUTOMATED_NOT_SUPPORTED');
  });

  // T44e（Task 44 の設計書 P2-8。設計の変更の履歴の T44e の行の (1)）: 手動のログインのプロファイルは、スクリプトで送るログインの設定を、token の送信先と成功の
  // 鍵なしで保存できる（手動のログインの段は送信を通して記録し、成功の後の自動の登録が埋める）。自動ログインのプロファイルは、今どおり両方を求める。
  it('T44e: accepts a script login without the target and the success key for a manual login profile, and still requires them for an automated login profile', () => {
    const empty = { ...scriptSetup, scriptLogin: null, successStorageKey: null, loginSideRequests: [] } satisfies AuthSetupV3;
    for (const setup of [empty, { ...scriptSetup, scriptLogin: null }, { ...scriptSetup, successStorageKey: null }]) {
      const result = validate(setup);
      expect(codesOf(result)).toEqual([]);
      expect(result.ok && result.setup).toEqual(setup);
    }
    // 承認したサービスの Origin がないプロファイルでも受ける（送信先がないので、サービスの Origin は要らない）。
    expect(codesOf(validate(empty, profileWithoutServices))).toEqual([]);
    for (const setup of [automatedOf(empty), automatedOf({ ...scriptSetup, scriptLogin: null }), automatedOf({ ...scriptSetup, successStorageKey: null })]) {
      expect(codesOf(validate(setup, automatedProfile))).toEqual(['AUTH_SETUP_SCRIPT_LOGIN_REQUIRED']);
    }
    // 送信先があるときの中身の確かめは、手動のログインでも今どおり（承認していない Origin の送信先は拒む）。
    expect(codesOf(validate({ ...scriptSetup, successStorageKey: null, scriptLogin: { ...scriptSetup.scriptLogin, origin: OTHER_ORIGIN } })))
      .toEqual(['AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED']);
  });

  it('T36a: keeps the rules of an automated login profile for SCRIPT_REQUEST (the automated login settings and the fixed attempts)', () => {
    expect(codesOf(validate({ ...automatedOf(scriptSetup), automatedLogin: null }, automatedProfile))).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED']);
    expect(codesOf(validate({ ...automatedOf(scriptSetup), maxLoginAttempts: 2 }, automatedProfile))).toEqual(['AUTH_SETUP_LIMIT_EXCEEDED']);
    // 手動のログインのプロファイルは、自動ログインの設定を持てない（今どおり）。
    expect(codesOf(validate(automatedOf(scriptSetup)))).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED']);
  });

  /** 値の目印（実在の値ではない）。 */
  const JWT_VALUE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
  const withQueryValue = (value: string): AuthSetupV3 =>
    ({ ...scriptSetup, scriptLogin: { ...scriptSetup.scriptLogin, requiredQuery: [{ name: 'grant_type', value }] } });

  it.each([
    ['a JWT', JWT_VALUE],
    ['a long base64url value', 'AbCdEfGhIjKlMnOpQrStUv12'],
    ['a long hexadecimal value', '0123456789abcdef0123456789abcdef'],
    ['a standard base64 value', 'YWJjZGVmZ2hpamtsbW5vcA=='],
    ['an e-mail address', 'someone@example.invalid'],
  ])('rejects a required query value that looks like a value (%s), without the value in the details', (_name, value) => {
    const result = validate(withQueryValue(value));
    expect(codesOf(result)).toEqual(['AUTH_SETUP_SECRET_LIKE_VALUE']);
    expect(result.ok ? [] : result.errors.map(({ pointer }) => pointer)).toEqual(['/scriptLogin/requiredQuery/0']);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it.each(['password', 'refresh_token', 'client_credentials', 'pkce', '1'])('accepts the required query value %s', (value) => {
    expect(validate(withQueryValue(value)).ok).toBe(true);
  });
});

// T35a（Task 35 の設計書 3.1）: 版 3 の任意の項目（スキーマの版は上げない）。
// - `auditReadRequests`（上限 8）: 監査の段で通す、読み取りのための手続きの呼び出し。`origin` は承認したサービスの Origin か承認したテストの Origin、
//   `path`、`method`（`POST` だけ）、`maxPerPageLoad`（1〜10）。Origin と path の組の重なりは拒む（`AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED`）。
//   ログインに伴う送信・スクリプトの送信先との重なりは許す（ログインの段と監査の段で、数え方も意味も違うため）。
// - `serviceRequestLimits`: `perMinute`（1〜600）、`perRun`（1〜10,000）。ないときは上限の値（`DEFAULT_SERVICE_REQUEST_LIMITS`）。DEF-141 で、120・600 から
//   上げた（前の範囲で保存した値は、そのまま受ける）。
// - `SCRIPT_REQUEST` でないときは、どちらも持てない（`AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED`。スクリプトで送るログインの項目と同じ扱い）。
describe('T35a: the audit read requests and the service request limits of version 3', () => {
  const READ = { origin: API_ORIGIN, path: '/rest/v1/rpc/list_members', method: 'POST', maxPerPageLoad: 3 } as const;
  const withReads = (change: Record<string, unknown>): Record<string, unknown> => ({ ...scriptSetup, ...change });

  it('has the closed list and the limits of the contract in the schema, and the default limits are the maximum', () => {
    expect(AUDIT_READ_REQUEST_METHODS).toEqual(['POST']);
    expect(Object.isFrozen(AUDIT_READ_REQUEST_METHODS)).toBe(true);
    expect([MAX_AUDIT_READ_REQUESTS, MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD, MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD]).toEqual([8, 1, 10]);
    expect([MIN_SERVICE_REQUESTS_PER_MINUTE, MAX_SERVICE_REQUESTS_PER_MINUTE, MIN_SERVICE_REQUESTS_PER_RUN, MAX_SERVICE_REQUESTS_PER_RUN])
      .toEqual([1, 600, 1, 10_000]);
    expect(DEFAULT_SERVICE_REQUEST_LIMITS).toEqual({ perMinute: MAX_SERVICE_REQUESTS_PER_MINUTE, perRun: MAX_SERVICE_REQUESTS_PER_RUN });
    expect(Object.isFrozen(DEFAULT_SERVICE_REQUEST_LIMITS)).toBe(true);
    const reads = propertyOf(V3_SCHEMA, 'auditReadRequests');
    expect(reads['maxItems']).toBe(MAX_AUDIT_READ_REQUESTS);
    expect(propertyOf(reads.items, 'maxPerPageLoad')['minimum']).toBe(MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD);
    expect(propertyOf(reads.items, 'maxPerPageLoad')['maximum']).toBe(MAX_AUDIT_READ_REQUESTS_PER_PAGE_LOAD);
    const limits = propertyOf(V3_SCHEMA, 'serviceRequestLimits');
    expect([propertyOf(limits, 'perMinute')['minimum'], propertyOf(limits, 'perMinute')['maximum']])
      .toEqual([MIN_SERVICE_REQUESTS_PER_MINUTE, MAX_SERVICE_REQUESTS_PER_MINUTE]);
    expect([propertyOf(limits, 'perRun')['minimum'], propertyOf(limits, 'perRun')['maximum']])
      .toEqual([MIN_SERVICE_REQUESTS_PER_RUN, MAX_SERVICE_REQUESTS_PER_RUN]);
    // 任意の項目（版 3 の必須の項目は変えない）。
    expect(V3_SCHEMA['required']).not.toContain('auditReadRequests');
    expect(V3_SCHEMA['required']).not.toContain('serviceRequestLimits');
  });

  it('accepts the audit read requests on a service or a test origin, the limits, and the overlap with the login stage items', () => {
    const setup = withReads({
      auditReadRequests: [READ, { origin: TEST_ORIGIN, path: '/functions/v1/list', method: 'POST', maxPerPageLoad: 10 }],
      serviceRequestLimits: { perMinute: 60, perRun: 300 },
    });
    const result = validate(setup);
    expect(codesOf(result)).toEqual([]);
    expect(result.ok && result.setup).toEqual(setup);
    // ログインに伴う送信とスクリプトの送信先と同じ Origin と path も受ける（段が違う）。
    expect(codesOf(validate(withReads({ auditReadRequests: [
      { ...READ, path: '/rest/v1/rpc/resolve_tenant' },
      { ...READ, origin: SERVICE_ORIGIN, path: '/auth/v1/token' },
    ] })))).toEqual([]);
    expect(codesOf(validate(withReads({ auditReadRequests: [] })))).toEqual([]);
  });

  // DEF-141: 前の範囲の上限の値（120・600。前の既定）で保存した設定も、新しい上限の値も、そのまま受ける。
  it.each([
    ['the earlier maximum limits', { perMinute: 120, perRun: 600 }],
    ['the new maximum limits', { perMinute: 600, perRun: 10_000 }],
    ['the minimum limits', { perMinute: 1, perRun: 1 }],
  ])('accepts %s as they are', (_label, limits) => {
    const setup = withReads({ serviceRequestLimits: limits });
    const result = validate(setup);
    expect(codesOf(result)).toEqual([]);
    expect(result.ok && result.setup).toEqual(setup);
  });

  it.each<readonly [string, Record<string, unknown>, readonly AuthSetupValidationErrorCode[]]>([
    ['the read requests of a form navigation setup', { ...formSetup, auditReadRequests: [READ] }, ['AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED']],
    ['an empty read request list of a form navigation setup', { ...formSetup, auditReadRequests: [] }, ['AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED']],
    ['the limits of a form navigation setup', { ...formSetup, serviceRequestLimits: { perMinute: 1, perRun: 1 } }, ['AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED']],
    ['a duplicated read request', withReads({ auditReadRequests: [READ, { ...READ, maxPerPageLoad: 1 }] }), ['AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED']],
    ['a read request on an origin that is not approved', withReads({ auditReadRequests: [{ ...READ, origin: OTHER_ORIGIN }] }),
      ['AUTH_SETUP_ORIGIN_NOT_APPROVED']],
    ['a read request on an origin that is not canonical', withReads({ auditReadRequests: [{ ...READ, origin: `${API_ORIGIN}/` }] }),
      ['AUTH_SETUP_URL_INVALID']],
    ['a read request with a bad path', withReads({ auditReadRequests: [{ ...READ, path: '/a/../b' }] }), ['AUTH_SETUP_PATH_INVALID']],
    // T35R-fix（T35R の M-1）: 登録した path が読まないパス（`excludedPaths`。前方一致。大文字と小文字を区別しない）に当たれば拒む。
    ['a read request on an excluded path', withReads({ auditReadRequests: [{ ...READ, path: '/logout/rpc' }] }), ['AUTH_SETUP_PATH_INVALID']],
    ['a read request on an excluded path in another case', withReads({ auditReadRequests: [{ ...READ, path: '/LogOut' }] }), ['AUTH_SETUP_PATH_INVALID']],
    // T35R2-fix（T35R2 の M-4）: 登録した path が危険な語（`DEFAULT_EXCLUDED_URL_WORDS`。Guard と同じ比べ方）を含めば拒む。
    ['a read request with a dangerous term', withReads({ auditReadRequests: [{ ...READ, path: '/rest/v1/rpc/delete_member' }] }), ['AUTH_SETUP_PATH_INVALID']],
    ['a read request with a dangerous term in another case', withReads({ auditReadRequests: [{ ...READ, path: '/rest/v1/rpc/SignOut' }] }),
      ['AUTH_SETUP_PATH_INVALID']],
    ['a read request of no time per page load', withReads({ auditReadRequests: [{ ...READ, maxPerPageLoad: 0 }] }), ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a read request over the limit per page load', withReads({ auditReadRequests: [{ ...READ, maxPerPageLoad: 11 }] }), ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['too many read requests', withReads({ auditReadRequests: Array.from({ length: MAX_AUDIT_READ_REQUESTS + 1 },
      (_, index) => ({ ...READ, path: `/rest/v1/rpc/read_${index}` })) }), ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a read request with GET', withReads({ auditReadRequests: [{ ...READ, method: 'GET' }] }), ['AUTH_SETUP_SCHEMA_INVALID']],
    ['a read request with an extra property', withReads({ auditReadRequests: [{ ...READ, body: 'x' }] }), ['AUTH_SETUP_SCHEMA_INVALID']],
    ['a limit per minute over the maximum', withReads({ serviceRequestLimits: { perMinute: 601, perRun: 600 } }), ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a limit per minute of zero', withReads({ serviceRequestLimits: { perMinute: 0, perRun: 600 } }), ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['a limit per Run over the maximum', withReads({ serviceRequestLimits: { perMinute: 120, perRun: 10_001 } }), ['AUTH_SETUP_LIMIT_EXCEEDED']],
    ['limits without the limit per Run', withReads({ serviceRequestLimits: { perMinute: 120 } }), ['AUTH_SETUP_SCHEMA_INVALID']],
  ])('rejects %s', (_name, input, expected) => {
    const result = validate(input);
    expect(codesOf(result)).toEqual([...expected].sort());
    for (const error of result.ok ? [] : result.errors) {
      expect(AUTH_SETUP_VALIDATION_ERROR_CODES).toContain(error.code);
    }
  });

  it('puts the errors of the read requests at their pointers', () => {
    const result = validate(withReads({ auditReadRequests: [READ, { ...READ, origin: OTHER_ORIGIN, path: '/x' }, READ] }));
    expect(result.ok ? [] : result.errors.map(({ code, pointer }) => `${code} ${pointer}`).sort()).toEqual([
      'AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED /auditReadRequests/2',
      'AUTH_SETUP_ORIGIN_NOT_APPROVED /auditReadRequests/1/origin',
    ]);
  });
});
