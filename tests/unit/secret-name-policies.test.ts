// CCX-4（共通化の台帳の N3。`CC-plan.md` の「設計者の判断」の 3）: 秘密に見える名前の 3 つの方針の、今の判定の結果を固定する。
// 3 つの方針は意味が違うので、まとめない（同じ名前でも、方針ごとに結果が違ってよい。この表は、その違いも固定する）。
// 1. 伏せ字の完全一致（URL の query の伏せ字と、READ の定義の拒否）: `isSecretUrlQueryParameterName`。
// 2. 認証の設定の部分一致の拒否（fail-closed）: `validateAuthSetup` の `AUTH_SETUP_SECRET_LIKE_VALUE`（`loginStartUrl` の query の名前）。
// 3. header の部分一致（公開監査の Network の Evidence の伏せ字）: `redactHeaders`。
// 共通化の前に書いて PASS させ、共通化の後も同じ表で PASS させる（振る舞いを変えないことの確かめ）。
import { describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import {
  AUTH_SETUP_SCHEMA_VERSION_2,
  SECRET_LIKE_QUERY_NAME_WORDS as AUTH_SETUP_SECRET_LIKE_QUERY_NAME_WORDS,
  type AuthSetup,
} from '../../src/control/auth/auth-setup-contracts.js';
import { validateAuthSetup } from '../../src/control/auth/auth-setup-policy.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile } from '../../src/control/contracts.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../src/control/profile-policy.js';
import { REDACTED } from '../../src/core/redaction.js';
import {
  SECRET_LIKE_HEADER_EXACT_NAMES,
  SECRET_LIKE_HEADER_NAME_WORDS,
  SECRET_LIKE_QUERY_NAME_WORDS,
  SECRET_URL_QUERY_PARAMETER_NAMES,
  isSecretLikeHeaderName,
  isSecretLikeQueryName,
  isSecretUrlQueryParameterName,
} from '../../src/core/secret-query-names.js';
import { redactHeaders } from '../../src/safety/redact.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const HEADER_VALUE = 'header-value-marker';
const SECRET_LIKE_CODE = 'AUTH_SETUP_SECRET_LIKE_VALUE';

const targetConfig: AuditConfig = {
  ...createTestConfig(TEST_ORIGIN),
  site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN] },
};
const context: ProfileValidationContext = { targetConfig };

const profileResult = validateSiteProfile({
  schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
  profileId: 'example-test-env',
  revision: 1,
  targetConfigPath: 'local/targets/example-test.json',
  environment: 'TEST',
  mode: 'TEST_AUTH_PASSIVE',
  auth: 'MANUAL_SESSION',
  approvedTestOrigins: [TEST_ORIGIN],
  environmentEvidenceRef: 'evidence/example-test-env/isolation-check-1',
} satisfies SiteProfile, context);
if (!profileResult.ok) {
  throw new Error(`the test profile was rejected: ${JSON.stringify(profileResult.errors)}`);
}
const profile = profileResult.profile;

const setupWithLoginQueryName = (name: string): AuthSetup => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: 'example-test-env',
  profileRevision: 1,
  loginStartUrl: `${TEST_ORIGIN}/login?${name}=value`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 方針 2 の今の判定（`loginStartUrl` の query の名前で、`AUTH_SETUP_SECRET_LIKE_VALUE` が出るか）。 */
const authSetupRejectsQueryName = (name: string): boolean => {
  const result = validateAuthSetup(setupWithLoginQueryName(name), profile, context);
  return !result.ok && result.errors.some((error) => error.code === SECRET_LIKE_CODE);
};

/** 方針 3 の今の判定（`redactHeaders` で値が伏せられるか）。 */
const headerIsRedacted = (name: string): boolean => redactHeaders({ [name]: HEADER_VALUE })[name] === REDACTED;

/**
 * 名前と、3 つの方針の今の結果（完全一致の伏せ字、認証の設定の拒否、header の伏せ字）。認証の設定の欄の null は、その名前が `loginStartUrl` の
 * 正規の形に書けないので確かめない、の意味。
 */
const CASES: readonly (readonly [name: string, exact: boolean, authSetup: boolean | null, header: boolean])[] = [
  ['token', true, true, true],
  ['access_token', true, true, true],
  ['Access_Token', true, true, true],
  ['sessionToken', true, true, true],
  ['xsrf_token', true, true, true],
  ['client_secret', true, true, true],
  ['authorization', true, true, true],
  ['api-key', true, true, true],
  ['session-id', true, true, true],
  ['password', true, true, false],
  ['pwd', true, true, false],
  ['sid', true, true, false],
  ['code', true, true, false],
  ['state', true, true, false],
  ['credential', true, true, false],
  ['csrf', true, false, false],
  ['key', true, false, false],
  ['jwt', true, false, false],
  ['Proxy-Authorization', false, true, true],
  ['x-api-key', false, true, true],
  ['X-Auth-Key', false, true, true],
  ['x_api_secret', false, true, true],
  ['author', false, true, false],
  ['statement', false, true, false],
  ['unicode', false, true, false],
  ['cookie', false, false, true],
  ['Set-Cookie', false, false, true],
  ['Ocp-Apim-Subscription-Key', false, false, true],
  ['set_cookie', false, false, false],
  ['keyword', false, false, false],
  ['content-type', false, false, false],
  ['q', false, false, false],
  ['csrf%5Ftoken', true, null, true],
  ['', false, null, false],
];

describe('CCX-4: the current judgments of the three secret-like name policies', () => {
  it.each(CASES)('policy 1 (exact, URL query redaction): %j -> %s', (name, exact) => {
    expect(isSecretUrlQueryParameterName(name)).toBe(exact);
  });

  it.each(CASES.filter(([, , authSetup]) => authSetup !== null))(
    'policy 2 (partial, auth setup rejection): %j -> %s',
    (name, _exact, authSetup) => {
      expect(authSetupRejectsQueryName(name)).toBe(authSetup);
    },
  );

  it.each(CASES)('policy 3 (partial, header redaction): %j -> %s', (name, _exact, _authSetup, header) => {
    expect(headerIsRedacted(name)).toBe(header);
  });

  it('accepts the auth setup used by the table when its query name is not secret-like', () => {
    expect(validateAuthSetup(setupWithLoginQueryName('next'), profile, context)).toMatchObject({ ok: true });
  });
});

// 共通化の後（CCX-4）: 3 つの方針の語の一覧と比べ方は `src/core/secret-query-names.ts` に名前を付けて並び、元の場所は同じ値を公開し直す。
describe('CCX-4: the three policies are named in src/core/secret-query-names.ts', () => {
  it('re-exports the same frozen list of the auth setup policy from auth-setup-contracts.ts', () => {
    expect(AUTH_SETUP_SECRET_LIKE_QUERY_NAME_WORDS).toBe(SECRET_LIKE_QUERY_NAME_WORDS);
    for (const list of [SECRET_URL_QUERY_PARAMETER_NAMES, SECRET_LIKE_QUERY_NAME_WORDS, SECRET_LIKE_HEADER_EXACT_NAMES, SECRET_LIKE_HEADER_NAME_WORDS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it.each(CASES.filter(([, , authSetup]) => authSetup !== null))(
    'policy 2 in the owner (isSecretLikeQueryName): %j -> %s',
    (name, _exact, authSetup) => {
      expect(isSecretLikeQueryName(name)).toBe(authSetup);
    },
  );

  it.each(CASES)('policy 3 in the owner (isSecretLikeHeaderName): %j -> %s', (name, _exact, _authSetup, header) => {
    expect(isSecretLikeHeaderName(name)).toBe(header);
  });
});
