/**
 * CC-100: 監査の除外の比べる path の形の作り方を、core の 1 か所（`src/core/audit-exclusion-forms.ts`）にまとめた。
 * - 形の作り方: 生の path から、`%XX` を変わらなくなるまで戻す（上限の回数まで）、連続した `/` をまとめる、各 segment の `;` から後を外す、
 *   `.` と `..` を解決する、を新しい形が出なくなるまで重ねる（読む範囲の形）。除外の比べの形は、さらに NFKC と大文字・小文字の畳み込みを重ね、
 *   小文字にする。戻せない `%`、形の数が上限を超えるときは `null`（fail-closed）。
 * - 表: Guard（`request-policy.ts` の `classifyPassiveRequest`）、認証の設定の保存の検証（`auth-setup-policy.ts` の登録した読み取りの手続きの
 *   呼び出しの path）、READ の確かめの画面の path の保存の検証（`read-check-policy.ts`）が、同じ入力で同じ判定をする（保存の検証を Guard と
 *   同じ形にそろえた。保存の検証は前より厳しくなりうる）。
 * 例の値は匿名の値（`example.invalid`）だけ。
 */
import { describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import {
  MAX_AUDIT_PATH_FORMS,
  MAX_PERCENT_DECODE_ROUNDS,
  auditScopePathFormsOf,
  exclusionMatchPathFormsOf,
  fullyPercentDecoded,
  isInsideAuditScope,
} from '../../src/core/audit-exclusion-forms.js';
import { AUTH_SETUP_SCHEMA_VERSION_3, type AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { validateAuthSetup } from '../../src/control/auth/auth-setup-policy.js';
import { SITE_PROFILE_SCHEMA_VERSION, type SiteProfile, type ValidatedSiteProfile } from '../../src/control/contracts.js';
import { validateSiteProfile, type ProfileValidationContext } from '../../src/control/profile-policy.js';
import { validateReadCheckDefinition, type ReadCheckPageContext } from '../../src/control/read-check-policy.js';
import { classifyPassiveRequest } from '../../src/safety/request-policy.js';
import { createTestConfig } from '../helpers/test-config.js';

const TEST_ORIGIN = 'https://app.example.invalid';
const SERVICE_ORIGIN = 'https://auth.example.invalid';
const API_ORIGIN = 'https://api.example.invalid';
const EXCLUDED = '/logout';
const SCOPE = '/admin';

describe('CC-100: the forms of a path to compare with the audit exclusions (core)', () => {
  it('decodes until nothing changes, within the limit, and refuses what it cannot decode', () => {
    expect(fullyPercentDecoded('/%256Cogout')).toBe('/logout');
    expect(fullyPercentDecoded('/plain')).toBe('/plain');
    expect(fullyPercentDecoded('/%E0%A4%A')).toBeNull();
    expect(fullyPercentDecoded(`/${'%25'.repeat(MAX_PERCENT_DECODE_ROUNDS)}41`)).toBeNull();
    expect(MAX_PERCENT_DECODE_ROUNDS).toBe(4);
    expect(MAX_AUDIT_PATH_FORMS).toBe(64);
  });

  it('builds the scope forms (case kept) and the match forms (folded and lower case)', () => {
    expect(auditScopePathFormsOf('/A//b;x=1/../C')).toEqual(expect.arrayContaining(['/A//b;x=1/../C', '/A/b;x=1/../C', '/A//b/../C', '/A/C']));
    expect(auditScopePathFormsOf('/A')).toEqual(['/A']);
    const match = exclusionMatchPathFormsOf('/%EF%BD%8Cogout/X');
    expect(match).toEqual(expect.arrayContaining(['/logout/x']));
    expect(match?.every((form) => form === form.toLowerCase())).toBe(true);
    expect(exclusionMatchPathFormsOf('/%zz')).toBeNull();
  });

  it('is inside the audit scope only when every scope form starts with a prefix (case sensitive), and anything is inside an empty scope', () => {
    expect(isInsideAuditScope(['/admin/list'], [SCOPE])).toBe(true);
    expect(isInsideAuditScope(['/ADMIN/list'], [SCOPE])).toBe(false);
    expect(isInsideAuditScope(['/admin/list', '/other'], [SCOPE])).toBe(false);
    expect(isInsideAuditScope(['/anything'], [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 表: 3 か所が同じ判定をする
// ---------------------------------------------------------------------------------------------------------------

const targetConfig: AuditConfig = { ...createTestConfig(TEST_ORIGIN), site: { startUrl: `${TEST_ORIGIN}/`, allowedOrigins: [TEST_ORIGIN] } };
const context: ProfileValidationContext = { targetConfig };
const profile = ((): ValidatedSiteProfile => {
  const input = {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: 'cc100-profile',
    revision: 1,
    targetConfigPath: 'local/targets/cc100.json',
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: 'MANUAL_SESSION',
    approvedTestOrigins: [TEST_ORIGIN],
    environmentEvidenceRef: 'evidence/cc100',
    approvedServiceOrigins: [SERVICE_ORIGIN, API_ORIGIN],
  } satisfies SiteProfile;
  const result = validateSiteProfile(input, context);
  if (!result.ok) {
    throw new Error(`the test profile was rejected: ${JSON.stringify(result.errors)}`);
  }
  return result.profile;
})();

/** 認証の設定（版 3。スクリプトで送るログイン）に、登録した読み取りの手続きの呼び出しを 1 つ置いたもの。 */
const setupWithRead = (path: string): AuthSetupV3 => ({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  profileId: 'cc100-profile',
  profileRevision: 1,
  loginStartUrl: `${TEST_ORIGIN}/login`,
  loginPostEndpoints: [],
  successCondition: { pathPrefix: '/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [EXCLUDED],
  auditPathPrefixes: [],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [],
  successStorageKey: { origin: TEST_ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
  auditReadRequests: [{ origin: API_ORIGIN, path, method: 'POST', maxPerPageLoad: 3 }],
});

/**
 * Guard: 許可 Origin への読み取りが、監査の除外に当たるか。BN-0（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0）から、監査の段の
 * Passive の Context の除外は文書の読み込みに当たる（ページが出す文書でない GET には当てない）ので、path の比べ方は main frame の文書の読み込みで確かめる。
 */
const guardExcludes = (path: string, auditPathPrefixes: readonly string[] = []): boolean => {
  const decision = classifyPassiveRequest(
    { kind: 'HTTP', method: 'GET', url: `${TEST_ORIGIN}${path}`, isNavigationRequest: true, isMainFrame: true, resourceType: 'document' },
    new Set([TEST_ORIGIN]),
    { auditExclusions: { excludedPathPrefixes: [EXCLUDED], auditPathPrefixes, dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS } },
  );
  return decision.action === 'BLOCK' && decision.reason === 'AUDIT_EXCLUDED_URL';
};

/** 認証の設定の保存の検証: 登録した読み取りの手続きの呼び出しの path を、読まないパスか危険な語として拒むか。 */
const authSetupExcludes = (path: string): boolean => {
  const result = validateAuthSetup(setupWithRead(path), profile, context);
  return !result.ok && result.errors.some((error) => error.code === 'AUTH_SETUP_PATH_INVALID');
};

/** READ の確かめの画面の path の保存の検証: 読まないパス・読む範囲の外・危険な語として拒むか。 */
const readCheckExcludes = (path: string, auditPathPrefixes: readonly string[] = []): boolean => {
  const page: ReadCheckPageContext = {
    startUrl: `${TEST_ORIGIN}/`,
    allowedOrigins: [TEST_ORIGIN],
    approvedTestOrigins: [TEST_ORIGIN],
    excludedPathPrefixes: [EXCLUDED],
    auditPathPrefixes,
    sessionLostPathPrefix: null,
  };
  const result = validateReadCheckDefinition(
    { targetPagePath: path, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    null,
    page,
  );
  return !result.ok && result.errors.some((error) => error.code === 'READ_PAGE_PATH_EXCLUDED' || error.code === 'READ_PAGE_PATH_DANGEROUS_WORD');
};

describe('CC-100: the Guard and the two save checks judge the same path in the same way', () => {
  it.each<readonly [string, string, boolean]>([
    ['a plain read path', '/rest/v1/rpc/list_members', false],
    ['the excluded path in another case', '/LogOut/x', true],
    ['the excluded path with an encoded letter', '/%6Cogout/x', true],
    ['the excluded path encoded twice', '/%256Cogout/x', true],
    ['a dangerous term with an encoded letter', '/x/de%6Cete', true],
    ['a dangerous term in upper case', '/x/DELETE', true],
    ['a dangerous term with an encoded full-width letter', '/x/%EF%BD%84elete', true],
  ])('%s', (_name, path, excluded) => {
    expect([guardExcludes(path), authSetupExcludes(path), readCheckExcludes(path)]).toEqual([excluded, excluded, excluded]);
  });

  it.each<readonly [string, string, boolean]>([
    ['a path inside the audit scope', '/admin/list', false],
    ['a path inside the scope only when the case is folded', '/ADMIN/list', true],
    ['a path inside the scope only when decoded', '/%61dmin/list', true],
  ])('the audit scope: %s', (_name, path, excluded) => {
    expect([guardExcludes(path, [SCOPE]), readCheckExcludes(path, [SCOPE])]).toEqual([excluded, excluded]);
  });
});
