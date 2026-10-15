// T26b（Task 26 の設計書 4.3、4.4 の結果の区別、4.5 の上限の「回数 1」）: 認証の設定の版 2（`beaksight-auth-setup/2`）の契約・スキーマ・検証の検査。
// - 契約（`src/control/auth/auth-setup-contracts.ts`）と版 2 の JSON Schema（`schemas/control/auth-setup-v2.schema.json`）の項目と上限の一致。
// - 版 1 のスキーマ（`schemas/control/auth-setup.schema.json`）は公開済みの形のまま（項目に `automatedLogin` がない）。
// - 検証（`validateAuthSetup`）: プロファイルの方式で `automatedLogin` の要否を決める。自動ログインでは回数は 1 だけ。3 つのセレクタの形と
//   重なり。失敗の条件どうしと、失敗の条件と成功の条件の重なり。方式の判定（`TEST_AUTH_PASSIVE` で、手動か自動のログイン）。
// - 誤りの文に、設定の値（セレクタ、path）を入れない。
// 例の値は、匿名の値（`example.invalid`、`127.0.0.1`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION,
  AUTH_SETUP_SCHEMA_VERSION_2,
  AUTH_SETUP_VALIDATION_ERROR_CODES,
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
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
  type AutomatedLoginSetup,
  type LoginResultCondition,
} from '../../src/control/auth/auth-setup-contracts.js';
import { validateAuthSetup } from '../../src/control/auth/auth-setup-policy.js';
import {
  MIN_PROFILE_REVISION,
  SITE_PROFILE_SCHEMA_VERSION,
  type SiteProfile,
  type ValidatedSiteProfile,
} from '../../src/control/contracts.js';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../src/control/profile-policy.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const LOOPBACK_ORIGIN = 'http://127.0.0.1:4173';

const AUTH_SETUP_V1_SCHEMA_PATH = resolve(process.cwd(), 'schemas', 'control', 'auth-setup.schema.json');
const AUTH_SETUP_V2_SCHEMA_PATH = resolve(process.cwd(), 'schemas', 'control', 'auth-setup-v2.schema.json');
const AUTH_SETUP_V2_SCHEMA_ID = 'urn:beaksight:schema:control:auth-setup:2';

const targetConfig: AuditConfig = {
  ...createTestConfig(TEST_ORIGIN),
  site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN, LOOPBACK_ORIGIN] },
};
const context: ProfileValidationContext = { targetConfig };

const manualProfileInput = {
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

const validatedProfileOf = (input: SiteProfile): ValidatedSiteProfile => {
  const result = validateSiteProfile(input, context);
  if (!result.ok) {
    throw new Error(`the test profile was rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.profile;
};

const manualProfile = validatedProfileOf(manualProfileInput);
const automatedProfile = validatedProfileOf({ ...manualProfileInput, auth: 'AUTOMATED_LOGIN' });

const manualSetup = {
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: 'example-test-env',
  profileRevision: 3,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
} satisfies AuthSetup;

const automatedLogin = {
  usernameSelector: '#username',
  passwordSelector: '#password',
  submitSelector: 'form#login button[type=submit]',
  failureConditions: {
    invalidCredentials: { pathPrefix: '/admin/login', selector: '.login-error' },
    accountLocked: { pathPrefix: '/admin/locked', selector: null },
    mfaRequired: null,
    credentialExpired: { pathPrefix: '/admin/password-expired', selector: '#expired-notice' },
  },
} satisfies AutomatedLoginSetup;

const automatedSetup = {
  ...manualSetup,
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  automatedLogin,
} satisfies AuthSetup;

/** 拒否のコード（重複を除き、並べた値）。 */
const codesOf = (result: AuthSetupValidationResult): readonly AuthSetupValidationErrorCode[] =>
  result.ok ? [] : [...new Set(result.errors.map((error) => error.code))].sort();

const validate = (input: unknown, profile: ValidatedSiteProfile = automatedProfile): AuthSetupValidationResult =>
  validateAuthSetup(input, profile, context);

/** 自動ログインの設定の一部を変えた、版 2 の設定。 */
const withAutomatedLogin = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...automatedSetup,
  automatedLogin: { ...automatedLogin, ...overrides },
});

/** 失敗の条件の一部を変えた、版 2 の設定。 */
const withFailureConditions = (overrides: Record<string, LoginResultCondition | null>): Record<string, unknown> =>
  withAutomatedLogin({ failureConditions: { ...automatedLogin.failureConditions, ...overrides } });

const NO_FAILURE_CONDITIONS = Object.freeze({ invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null });

describe('T26b: the auth setup contract version 2 and its schema', () => {
  const v1Schema = JSON.parse(readFileSync(AUTH_SETUP_V1_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  const schema = JSON.parse(readFileSync(AUTH_SETUP_V2_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const definitions = (schema.$defs ?? {}) as Record<string, Record<string, unknown>>;

  /** `$ref`（このスキーマの中の `#/$defs/...`）を 1 段だけたどる。 */
  const resolved = (node: Record<string, unknown> | undefined): Record<string, unknown> => {
    const ref = node?.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/$defs/')) {
      return definitions[ref.slice('#/$defs/'.length)] ?? {};
    }
    return node ?? {};
  };
  const propertiesOf = (node: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> =>
    (resolved(node).properties ?? {}) as Record<string, Record<string, unknown>>;

  it('fixes the schema versions, the automated login limit and the closed list of the failure conditions', () => {
    expect(AUTH_SETUP_SCHEMA_VERSION).toBe('beaksight-auth-setup/1');
    expect(AUTH_SETUP_SCHEMA_VERSION_2).toBe('beaksight-auth-setup/2');
    expect(AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS).toBe(1);
    expect(AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS).toBeGreaterThanOrEqual(MIN_LOGIN_ATTEMPTS);
    expect(AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS).toEqual(['invalidCredentials', 'accountLocked', 'mfaRequired', 'credentialExpired']);
    expect(Object.isFrozen(AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS)).toBe(true);
    for (const code of [
      'AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED',
      'AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED',
      'AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED',
      'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS',
    ]) {
      expect(AUTH_SETUP_VALIDATION_ERROR_CODES).toContain(code);
    }
  });

  it('keeps the published version 1 schema as it was (no automatedLogin)', () => {
    expect(v1Schema.$id).toBe('urn:beaksight:schema:control:auth-setup:1');
    expect((v1Schema.properties as Record<string, Record<string, unknown>>).schemaVersion?.const).toBe(AUTH_SETUP_SCHEMA_VERSION);
    expect(Object.keys(v1Schema.properties as object)).not.toContain('automatedLogin');
  });

  it('has the $id of version 2, no additional properties, and the fields of version 1 plus automatedLogin', () => {
    const v1Keys = Object.keys(v1Schema.properties as object);
    expect(schema.$id).toBe(AUTH_SETUP_V2_SCHEMA_ID);
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([...v1Keys, 'automatedLogin']);
    expect(Object.keys(properties)).toEqual([...v1Keys, 'automatedLogin']);
    expect(Object.keys(manualSetup)).toEqual([...v1Keys, 'automatedLogin']);
  });

  it('uses the named constants as the limits of the schema (the same limits as version 1)', () => {
    const endpoints = properties.loginPostEndpoints ?? {};
    const endpointItem = propertiesOf(endpoints.items as Record<string, unknown>);
    expect(properties.schemaVersion?.const).toBe(AUTH_SETUP_SCHEMA_VERSION_2);
    expect(properties.loginStartUrl?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(endpoints.maxItems).toBe(MAX_LOGIN_POST_ENDPOINTS);
    expect(endpoints.minItems).toBe(1);
    expect(endpointItem.origin?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(endpointItem.path?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(propertiesOf(properties.successCondition).pathPrefix?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(propertiesOf(properties.successCondition).selector?.maxLength).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    expect(propertiesOf(properties.sessionLostCondition).pathPrefix?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(properties.excludedPaths?.maxItems).toBe(MAX_AUTH_SETUP_PATH_LIST_ITEMS);
    expect(properties.auditPathPrefixes?.maxItems).toBe(MAX_AUTH_SETUP_PATH_LIST_ITEMS);
    expect(properties.allowedIdpOrigins?.maxItems).toBe(MAX_ALLOWED_IDP_ORIGINS);
    expect(properties.maxLoginAttempts?.minimum).toBe(MIN_LOGIN_ATTEMPTS);
    expect(properties.maxLoginAttempts?.maximum).toBe(MAX_LOGIN_ATTEMPTS);
    expect(properties.profileRevision?.minimum).toBe(MIN_PROFILE_REVISION);
    expect(properties.profileId?.$ref).toBe('urn:beaksight:schema:control:profile:1#/properties/profileId');
  });

  it('defines automatedLogin as null or the three selectors and the closed list of the failure conditions', () => {
    const automated = resolved(properties.automatedLogin);
    expect(automated.type).toEqual(['object', 'null']);
    expect(automated.additionalProperties).toBe(false);
    expect(automated.required).toEqual(['usernameSelector', 'passwordSelector', 'submitSelector', 'failureConditions']);
    const automatedProperties = propertiesOf(automated);
    for (const name of ['usernameSelector', 'passwordSelector', 'submitSelector']) {
      expect(automatedProperties[name]?.type).toBe('string');
      expect(automatedProperties[name]?.maxLength).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    }
    const failure = resolved(automatedProperties.failureConditions);
    expect(failure.additionalProperties).toBe(false);
    expect(failure.required).toEqual([...AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS]);
    const failureProperties = propertiesOf(failure);
    expect(Object.keys(failureProperties)).toEqual([...AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS]);
    for (const kind of AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS) {
      const condition = resolved(failureProperties[kind]);
      expect(condition.type).toEqual(['object', 'null']);
      expect(condition.additionalProperties).toBe(false);
      expect(condition.required).toEqual(['pathPrefix', 'selector']);
      expect(propertiesOf(condition).pathPrefix?.maxLength).toBe(MAX_AUTH_SETUP_URL_LENGTH);
      expect(propertiesOf(condition).selector?.maxLength).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    }
  });

  it('is one of the control schema names, and the schemas tell version 1 and version 2 apart', () => {
    expect(CONTROL_SCHEMA_NAMES).toContain('auth-setup-v2');
    expect(validateControlDocument('auth-setup-v2', manualSetup)).toEqual({ ok: true });
    expect(validateControlDocument('auth-setup-v2', automatedSetup)).toEqual({ ok: true });
    expect(validateControlDocument('auth-setup', manualSetup).ok).toBe(false);
    const { automatedLogin: _omitted, ...withoutAutomatedLogin } = manualSetup;
    const v1Document = { ...withoutAutomatedLogin, schemaVersion: AUTH_SETUP_SCHEMA_VERSION };
    expect(validateControlDocument('auth-setup', v1Document)).toEqual({ ok: true });
    expect(validateControlDocument('auth-setup-v2', v1Document).ok).toBe(false);
    expect(validateControlDocument('auth-setup-v2', withoutAutomatedLogin).ok).toBe(false);
  });
});

describe('T26b: validateAuthSetup accepts version 2', () => {
  it('accepts an automated login setup for an AUTOMATED_LOGIN profile, as a deeply frozen copy', () => {
    const input = structuredClone(automatedSetup);
    const result = validate(input);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) {
      return;
    }
    expect(result.setup).toEqual(automatedSetup);
    expect(result.setup).not.toBe(input);
    expect(Object.isFrozen(result.setup.automatedLogin)).toBe(true);
    expect(Object.isFrozen(result.setup.automatedLogin?.failureConditions.invalidCredentials)).toBe(true);
  });

  it('accepts a manual setup (automatedLogin null) for a MANUAL_SESSION profile', () => {
    expect(validate(manualSetup, manualProfile), JSON.stringify(validate(manualSetup, manualProfile))).toMatchObject({ ok: true });
  });

  it.each([
    ['no failure condition', withAutomatedLogin({ failureConditions: NO_FAILURE_CONDITIONS })],
    ['every failure condition without a selector on its own path', withAutomatedLogin({
      failureConditions: {
        invalidCredentials: { pathPrefix: '/admin/login', selector: null },
        accountLocked: { pathPrefix: '/admin/locked', selector: null },
        mfaRequired: { pathPrefix: '/admin/mfa', selector: null },
        credentialExpired: { pathPrefix: '/admin/expired', selector: null },
      },
    })],
    ['failure conditions on the same path with different selectors', withFailureConditions({
      invalidCredentials: { pathPrefix: '/admin/login', selector: '.error-invalid' },
      accountLocked: { pathPrefix: '/admin/login', selector: '.error-locked' },
    })],
    ['a failure condition on the success path with another selector (both have selectors)', withFailureConditions({
      mfaRequired: { pathPrefix: '/admin/dashboard', selector: '#mfa-prompt' },
    })],
    ['a failure condition on the login page path (the success path does not match it)', withFailureConditions({
      invalidCredentials: { pathPrefix: '/admin/login', selector: null },
    })],
    ['selectors of the longest length', withAutomatedLogin({
      usernameSelector: `#${'u'.repeat(MAX_SUCCESS_SELECTOR_LENGTH - 1)}`,
      passwordSelector: `#${'p'.repeat(MAX_SUCCESS_SELECTOR_LENGTH - 1)}`,
      submitSelector: `#${'s'.repeat(MAX_SUCCESS_SELECTOR_LENGTH - 1)}`,
    })],
  ])('accepts %s', (_name, input) => {
    const result = validate(input);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  });
});

describe('T26b: validateAuthSetup rejects version 2 rule violations with their own codes', () => {
  it('rejects a version 1 document (it is turned into version 2 only when the store reads it)', () => {
    const { automatedLogin: _omitted, ...withoutAutomatedLogin } = manualSetup;
    expect(codesOf(validate({ ...withoutAutomatedLogin, schemaVersion: AUTH_SETUP_SCHEMA_VERSION }, manualProfile)))
      .toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
    expect(codesOf(validate(withoutAutomatedLogin, manualProfile))).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
  });

  it('rejects an automated login setup for a MANUAL_SESSION profile with AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED', () => {
    expect(codesOf(validate({ ...manualSetup, automatedLogin }, manualProfile))).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED']);
  });

  it('rejects an AUTOMATED_LOGIN profile without the automated login setup with AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED', () => {
    expect(codesOf(validate({ ...automatedSetup, automatedLogin: null }))).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED']);
  });

  it.each([2, MAX_LOGIN_ATTEMPTS])('rejects %i login attempts for an AUTOMATED_LOGIN profile with AUTH_SETUP_LIMIT_EXCEEDED', (attempts) => {
    const result = validate({ ...automatedSetup, maxLoginAttempts: attempts });
    expect(codesOf(result)).toEqual(['AUTH_SETUP_LIMIT_EXCEEDED']);
    expect(JSON.stringify(result)).toContain('maxLoginAttempts');
  });

  it('checks the login attempts of an AUTOMATED_LOGIN profile even without the automated login setup', () => {
    expect(codesOf(validate({ ...automatedSetup, automatedLogin: null, maxLoginAttempts: 2 })))
      .toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED', 'AUTH_SETUP_LIMIT_EXCEEDED']);
  });

  // T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5）: 書き込みのモード（`TEST_APPROVED_WRITE`）は、認証つきの読み取りの監査と同じ規則で受ける
  // （方式の規則も同じ）。T26b までは `AUTH_SETUP_MODE_UNSUPPORTED` だった。公開の監査は、今までどおり受けない。
  it('applies the rules of TEST_AUTH_PASSIVE to a TEST_APPROVED_WRITE profile, with either auth strategy (T28b)', () => {
    const writeManual = validatedProfileOf({ ...manualProfileInput, mode: 'TEST_APPROVED_WRITE' });
    const writeAutomated = validatedProfileOf({ ...manualProfileInput, mode: 'TEST_APPROVED_WRITE', auth: 'AUTOMATED_LOGIN' });
    expect(validate(manualSetup, writeManual)).toEqual(validate(manualSetup, manualProfile));
    expect(validate(manualSetup, writeManual).ok).toBe(true);
    expect(validate(automatedSetup, writeAutomated)).toEqual(validate(automatedSetup, automatedProfile));
    expect(validate(automatedSetup, writeAutomated).ok).toBe(true);
    expect(codesOf(validate(automatedSetup, writeManual))).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED']);
    expect(codesOf(validate(manualSetup, writeAutomated))).toEqual(codesOf(validate(manualSetup, automatedProfile)));
    expect(codesOf(validate(manualSetup, writeAutomated))).toContain('AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED');
  });

  it.each([
    ['PUBLIC_PASSIVE', { environment: 'PUBLIC', mode: 'PUBLIC_PASSIVE', auth: 'NONE', approvedTestOrigins: [], environmentEvidenceRef: null }],
  ] as const)('rejects a %s profile with AUTH_SETUP_MODE_UNSUPPORTED only (not with the automated login rules)', (_name, overrides) => {
    const profile = validatedProfileOf({ ...manualProfileInput, ...overrides });
    for (const input of [manualSetup, automatedSetup]) {
      const codes = codesOf(validate(input, profile));
      expect(codes).toContain('AUTH_SETUP_MODE_UNSUPPORTED');
      expect(codes).not.toContain('AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED');
      expect(codes).not.toContain('AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED');
      expect(codes).not.toContain('AUTH_SETUP_LIMIT_EXCEEDED');
    }
  });

  it.each([
    ['no automatedLogin', (() => {
      const { automatedLogin: _omitted, ...rest } = automatedSetup;
      return rest;
    })()],
    ['an extra item in automatedLogin', withAutomatedLogin({ password: 'x' })],
    ['a null selector', withAutomatedLogin({ usernameSelector: null })],
    ['a missing failure condition', withAutomatedLogin({ failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null } })],
    ['an unknown failure condition', withAutomatedLogin({ failureConditions: { ...NO_FAILURE_CONDITIONS, rateLimited: null } })],
    ['an extra item in a failure condition', withFailureConditions({
      accountLocked: { pathPrefix: '/admin/locked', selector: null, status: 423 } as unknown as LoginResultCondition,
    })],
    ['a failure condition without a selector item', withFailureConditions({
      accountLocked: { pathPrefix: '/admin/locked' } as unknown as LoginResultCondition,
    })],
  ])('rejects %s with AUTH_SETUP_SCHEMA_INVALID', (_name, input) => {
    expect(codesOf(validate(input))).toEqual(['AUTH_SETUP_SCHEMA_INVALID']);
  });

  it.each(['usernameSelector', 'passwordSelector', 'submitSelector'])('checks the form of %s with AUTH_SETUP_SELECTOR_INVALID', (name) => {
    for (const selector of ['', '   ', '#user\u0000', '#user\n.x', '#user ', '#user\ud800']) {
      const result = validate(withAutomatedLogin({ [name]: selector }));
      expect(codesOf(result), JSON.stringify(selector)).toEqual(['AUTH_SETUP_SELECTOR_INVALID']);
      expect(JSON.stringify(result)).toContain(`automatedLogin.${name}`);
    }
  });

  // T32j-4（ユーザーの判断 11「設定の検証で拒む」）: 自動ログインの 3 つのセレクタは、ログインの form の事前の確かめが isolated world の中で
  // 標準の CSS として探し直すので、Playwright 独自の書き方とエンジンの前置きを、閉じた一覧の印で拒む（完全な CSS の解析はしない）。
  it.each(['usernameSelector', 'passwordSelector', 'submitSelector'])('rejects the Playwright-only forms of %s with AUTH_SETUP_SELECTOR_NOT_STANDARD_CSS', (name) => {
    for (const selector of [
      '#go:has-text("Sign in")', 'button:visible', 'BUTTON:VISIBLE', ':nth-match(input, 1)', 'input:text("x")', 'input:text-is("x")',
      'input:text-matches("x")', 'input:right-of(#a)', 'input:left-of(#a)', 'input:above(#a)', 'input:below(#a)', 'input:near(#a)',
      '#f >> #user', 'css=#user', 'xpath=//input', 'text=Sign in', 'id=user', 'internal:role=button', 'css:light=#user', '//form/input',
      '..', '"Sign in"', "'Sign in'",
    ]) {
      const result = validate(withAutomatedLogin({ [name]: selector }));
      expect(codesOf(result), selector).toEqual(['AUTH_SETUP_SELECTOR_NOT_STANDARD_CSS']);
      expect(JSON.stringify(result)).toContain(`automatedLogin.${name}`);
    }
    for (const selector of [
      'form #name-field', 'input[name=action]', 'input:not([type=hidden])', 'button:is(.a, .b)', 'a:visited', 'form:has(> input.x)',
      'input[title="a=b"]', 'div > input + button', 'input:nth-child(2)',
    ]) {
      expect(validate(withAutomatedLogin({ [name]: selector })).ok, selector).toBe(true);
    }
  });

  it.each(AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS)('checks the path and the selector of the %s condition', (kind) => {
    expect(codesOf(validate(withFailureConditions({ [kind]: { pathPrefix: '/admin/../x', selector: null } }))))
      .toEqual(['AUTH_SETUP_PATH_INVALID']);
    expect(codesOf(validate(withFailureConditions({ [kind]: { pathPrefix: 'admin/x', selector: null } }))))
      .toEqual(['AUTH_SETUP_PATH_INVALID']);
    expect(codesOf(validate(withFailureConditions({ [kind]: { pathPrefix: '/admin/x', selector: ' ' } }))))
      .toEqual(['AUTH_SETUP_SELECTOR_INVALID']);
  });

  it.each([
    ['the user name and the password', { usernameSelector: '#field', passwordSelector: '#field' }],
    ['the password and the submit button', { passwordSelector: '#field', submitSelector: '#field' }],
    ['the user name and the submit button', { usernameSelector: '#field', submitSelector: '#field' }],
    ['all three', { usernameSelector: '#field', passwordSelector: '#field', submitSelector: '#field' }],
  ])('rejects the same selector for %s with AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED', (_name, overrides) => {
    expect(codesOf(validate(withAutomatedLogin(overrides)))).toEqual(['AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED']);
  });

  it.each([
    ['two failure conditions with the same path and selector', {
      invalidCredentials: { pathPrefix: '/admin/login', selector: '.error' },
      accountLocked: { pathPrefix: '/admin/login', selector: '.error' },
    }],
    ['two failure conditions with the same path and no selector', {
      accountLocked: { pathPrefix: '/admin/blocked', selector: null },
      credentialExpired: { pathPrefix: '/admin/blocked', selector: null },
    }],
    ['a failure condition equal to the success condition', {
      mfaRequired: { pathPrefix: '/admin/dashboard', selector: '#account-menu' },
    }],
    ['a failure condition on the success path without a selector', {
      mfaRequired: { pathPrefix: '/admin/dashboard', selector: null },
    }],
  ])('rejects %s with AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS', (_name, overrides) => {
    expect(codesOf(validate(withFailureConditions(overrides)))).toEqual(['AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS']);
  });

  // T26e（T26b の発見 6 への設計者の判断）: 失敗の条件どうしでも、成功の条件との規則と同じく、`pathPrefix` が同じで、どちらかに `selector` が
  // ない組（同時に当たりうる）を拒む。前の条件と後の条件の、どちらにセレクタがなくても拒む。
  it.each([
    ['two failure conditions on the same path, the later one without a selector', {
      invalidCredentials: { pathPrefix: '/admin/login', selector: '.error' },
      accountLocked: { pathPrefix: '/admin/login', selector: null },
    }],
    ['two failure conditions on the same path, the earlier one without a selector', {
      invalidCredentials: { pathPrefix: '/admin/login', selector: null },
      accountLocked: { pathPrefix: '/admin/login', selector: '.locked' },
    }],
    ['the third and the fourth failure conditions on the same path, one without a selector', {
      mfaRequired: { pathPrefix: '/admin/extra', selector: '#mfa' },
      credentialExpired: { pathPrefix: '/admin/extra', selector: null },
    }],
  ])('T26e: rejects %s with AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS', (_name, overrides) => {
    expect(codesOf(validate(withFailureConditions(overrides)))).toEqual(['AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS']);
  });

  it('rejects a failure condition on the success path when the success condition has no selector', () => {
    const input = {
      ...withFailureConditions({ mfaRequired: { pathPrefix: '/admin/dashboard', selector: '#mfa-prompt' } }),
      successCondition: { pathPrefix: '/admin/dashboard', selector: null },
    };
    expect(codesOf(validate(input))).toEqual(['AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS']);
  });

  it.each([
    ['a too long user name selector', withAutomatedLogin({ usernameSelector: `#${'a'.repeat(MAX_SUCCESS_SELECTOR_LENGTH)}` })],
    ['a too long password selector', withAutomatedLogin({ passwordSelector: `#${'a'.repeat(MAX_SUCCESS_SELECTOR_LENGTH)}` })],
    ['a too long submit selector', withAutomatedLogin({ submitSelector: `#${'a'.repeat(MAX_SUCCESS_SELECTOR_LENGTH)}` })],
    ['a too long failure path', withFailureConditions({ accountLocked: { pathPrefix: `/${'a'.repeat(MAX_AUTH_SETUP_URL_LENGTH)}`, selector: null } })],
    ['a too long failure selector', withFailureConditions({
      accountLocked: { pathPrefix: '/admin/locked', selector: `#${'a'.repeat(MAX_SUCCESS_SELECTOR_LENGTH)}` },
    })],
  ])('rejects %s with AUTH_SETUP_LIMIT_EXCEEDED before the schema', (_name, input) => {
    expect(codesOf(validate(input))).toEqual(['AUTH_SETUP_LIMIT_EXCEEDED']);
  });

  it('uses only the codes in the closed list, and puts no selector or path into the error details', () => {
    const marker = 'value-marker-26b0';
    const result = validate(withAutomatedLogin({
      usernameSelector: `#${marker}\n`,
      passwordSelector: `#${marker}-same`,
      submitSelector: `#${marker}-same`,
      failureConditions: {
        invalidCredentials: { pathPrefix: `/${marker}/../x`, selector: `.${marker}` },
        accountLocked: { pathPrefix: `/${marker}/../x`, selector: `.${marker}` },
        mfaRequired: { pathPrefix: '/admin/dashboard', selector: null },
        credentialExpired: { pathPrefix: `/${marker}`, selector: `\u0000${marker}` },
      },
    }));
    expect(codesOf(result)).toEqual([
      'AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED',
      'AUTH_SETUP_PATH_INVALID',
      'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS',
      'AUTH_SETUP_SELECTOR_INVALID',
    ]);
    if (result.ok) {
      return;
    }
    for (const error of result.errors) {
      expect(AUTH_SETUP_VALIDATION_ERROR_CODES).toContain(error.code);
      expect(Object.isFrozen(error)).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
