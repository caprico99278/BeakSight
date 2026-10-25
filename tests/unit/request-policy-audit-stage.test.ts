// T35b（Task 35 の設計書 `2026-10-16-beaksight-task-35-spa-audit-design.md` 3.2、3.3、4 章）: 要求の判定（`classifyPassiveRequest`）の、
// スクリプトで送るログインの監査の段の口（`auditStage`）と、登録した送信の判定の共通の関数（`registeredSubmissionVerdict`）。
// - 共通の判定: `POST`、種類が fetch か xhr、Origin と path が一致（query は問わない）、その項目の残りが 1 以上のときだけ通す（項目の位置を返す）。
//   一致しなければ `NO_MATCH`。理由は共通の一覧（`REGISTERED_SUBMISSION_BLOCK_REASONS`）で、段の理由に写す（ログインの段の今の理由の値は変えない）。
// - 監査の段の口: 登録した読み取りの手続きの呼び出しだけを、読み込みごとの回数の中で通す（`auditStageAdmission`）。token の送信先への、必須の
//   query と違う POST（更新など）は `TOKEN_REFRESH`、ほかの読み取りでない要求は `UNREGISTERED_NON_READ`（今どおり `NON_READ_METHOD`）。
//   承認したサービスの Origin への読み取りは、数えるために `SERVICE_ORIGIN_READ` の印を付けて通す。
// - 読む範囲の外の静的な資源: 許可 Origin への GET のサブリソースで、種類が script・stylesheet・image・font・media なら、`auditPathPrefixes` の
//   外でも通す（監査の段の口があるときだけ）。読まないパスと危険な語は、すべての要求に当てる。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  AUDIT_STAGE_BLOCK_REASONS,
  REGISTERED_SUBMISSION_BLOCK_REASONS,
  SCRIPT_LOGIN_BLOCK_REASONS,
  STATIC_SUBRESOURCE_TYPES,
  classifyPassiveRequest,
  registeredSubmissionVerdict,
  type AuditExclusionPolicy,
  type AuditStageBlockReason,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type RegisteredSubmissionEndpoint,
  type RequestResourceType,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const TOKEN_PATH = '/auth/v1/token';
const LIST_RPC_PATH = '/rest/v1/rpc/list_members';
const APP_RPC_PATH = '/api/tenant';
const ONE = 1;
const NONE = 0;

const readRequest = (origin: string, path: string, remainingPosts: number, method = 'POST'): RegisteredSubmissionEndpoint =>
  ({ origin, path, method, remainingPosts });

const auditStage = (remaining: readonly [number, number] = [ONE, ONE]): AuditStagePolicy => ({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  auditReadRequests: [readRequest(SERVICE_ORIGIN, LIST_RPC_PATH, remaining[0]), readRequest(APP_ORIGIN, APP_RPC_PATH, remaining[1])],
  scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
});
const EXCLUSIONS: AuditExclusionPolicy = {
  excludedPathPrefixes: ['/auth/logout'],
  auditPathPrefixes: ['/admin'],
  dangerousTerms: ['logout', 'delete'],
};

const facts = (
  method: string,
  url: string,
  resourceType: RequestResourceType | undefined,
  isNavigationRequest = false,
  isMainFrame = false,
): HttpRequestFacts => ({ kind: 'HTTP', method, url, isNavigationRequest, isMainFrame, resourceType });
/** 判定する（`stage` が `null` なら監査の段の口を渡さない）。 */
const decide = (request: HttpRequestFacts, stage: AuditStagePolicy | null = auditStage()): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, { auditExclusions: EXCLUSIONS, ...(stage === null ? {} : { auditStage: stage }) });

const readAdmitted = (index: number, serviceOrigin: boolean): PassiveRequestDecision =>
  ({ action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: { kind: 'AUDIT_READ_REQUEST', index, serviceOrigin } });
const serviceRead: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } };
const blocked = (auditStageBlock: AuditStageBlockReason): PassiveRequestDecision =>
  ({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', auditStageBlock });
const excluded: PassiveRequestDecision = { action: 'BLOCK', category: 'AUDIT_EXCLUSION', reason: 'AUDIT_EXCLUDED_URL' };
const directRead: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT' };

describe('T35b: the common judgment of the registered submissions', () => {
  const endpoints = [readRequest(SERVICE_ORIGIN, LIST_RPC_PATH, NONE), readRequest(SERVICE_ORIGIN, LIST_RPC_PATH, ONE), readRequest(APP_ORIGIN, APP_RPC_PATH, ONE)];

  it('closes the common reasons, and keeps the login stage reasons', () => {
    expect(REGISTERED_SUBMISSION_BLOCK_REASONS).toEqual(['OVER_LIMIT', 'NOT_SCRIPT']);
    expect(AUDIT_STAGE_BLOCK_REASONS).toEqual(['READ_REQUEST_OVER_LIMIT', 'READ_REQUEST_NOT_SCRIPT', 'TOKEN_REFRESH', 'UNREGISTERED_NON_READ']);
    expect(SCRIPT_LOGIN_BLOCK_REASONS).toEqual([
      'TOKEN_REQUEST_OVER_LIMIT', 'TOKEN_REQUEST_NOT_SCRIPT', 'TOKEN_REQUEST_QUERY_MISMATCH', 'SIDE_REQUEST_OVER_LIMIT', 'SIDE_REQUEST_NOT_SCRIPT', 'UNREGISTERED_NON_READ',
      // T36c: 自動ログインの資格情報の守りの理由を足した。
      'LOGIN_CREDENTIAL_IN_REQUEST',
    ]);
    expect(STATIC_SUBRESOURCE_TYPES).toEqual(['script', 'stylesheet', 'image', 'font', 'media']);
  });

  it.each([
    ['the first item with a remaining count (any query)', facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}?select=*`, 'fetch'), { kind: 'ADMIT', index: 1 }],
    ['an xhr request', facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'xhr'), { kind: 'ADMIT', index: 2 }],
    ['a beacon', facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'ping'), { kind: 'BLOCK', reason: 'NOT_SCRIPT' }],
    ['a document POST', facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'document', true, true), { kind: 'BLOCK', reason: 'NOT_SCRIPT' }],
    ['an omitted type', facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, undefined), { kind: 'BLOCK', reason: 'NOT_SCRIPT' }],
    ['another method', facts('PUT', `${APP_ORIGIN}${APP_RPC_PATH}`, 'fetch'), { kind: 'NO_MATCH' }],
    ['another path', facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}/x`, 'fetch'), { kind: 'NO_MATCH' }],
    ['another origin', facts('POST', `${OTHER_ORIGIN}${APP_RPC_PATH}`, 'fetch'), { kind: 'NO_MATCH' }],
  ] as const)('judges %s', (_label, request, expected) => {
    expect(registeredSubmissionVerdict(request, endpoints, true)).toEqual(expected);
  });

  it('blocks a matching request over the limit of every matching item, and admits nothing when not admissible', () => {
    expect(registeredSubmissionVerdict(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}`, 'fetch'), [endpoints[0]!], true))
      .toEqual({ kind: 'BLOCK', reason: 'OVER_LIMIT' });
    expect(registeredSubmissionVerdict(facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'fetch'), endpoints, false))
      .toEqual({ kind: 'BLOCK', reason: 'OVER_LIMIT' });
    expect(registeredSubmissionVerdict(facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'fetch'), [readRequest(APP_ORIGIN, APP_RPC_PATH, ONE, 'PUT')], true))
      .toEqual({ kind: 'NO_MATCH' });
  });
});

describe('T35b: the audit stage of the script login audit', () => {
  it('admits a registered read request per load (fetch or xhr, Origin and path, any query), and marks a service origin', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}`, 'fetch'))).toEqual(readAdmitted(0, true));
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}?limit=10`, 'xhr'))).toEqual(readAdmitted(0, true));
    expect(decide(facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'fetch'))).toEqual(readAdmitted(1, false));
  });

  it('counts each item by itself and blocks over the limit', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}`, 'fetch'), auditStage([NONE, ONE]))).toEqual(blocked('READ_REQUEST_OVER_LIMIT'));
    expect(decide(facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'fetch'), auditStage([NONE, ONE]))).toEqual(readAdmitted(1, false));
  });

  it.each([
    ['a beacon', facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}`, 'ping')],
    ['a document POST', facts('POST', `${APP_ORIGIN}${APP_RPC_PATH}`, 'document', true, true)],
  ])('blocks %s to a registered read request path', (_label, request) => {
    expect(decide(request)).toEqual(blocked('READ_REQUEST_NOT_SCRIPT'));
  });

  it.each([
    ['the token refresh', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=refresh_token`],
    ['another grant', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=pkce`],
    ['no query', `${SERVICE_ORIGIN}${TOKEN_PATH}`],
  ])('blocks %s to the token endpoint as a token refresh', (_label, url) => {
    expect(decide(facts('POST', url, 'fetch'))).toEqual(blocked('TOKEN_REFRESH'));
    expect(decide(facts('POST', url, 'ping'))).toEqual(blocked('TOKEN_REFRESH'));
  });

  it.each([
    ['the login request (the exact query)', facts('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=password`, 'fetch')],
    ['the server function', facts('POST', `${SERVICE_ORIGIN}/functions/v1/sync_access`, 'fetch')],
    ['the measurement beacon', facts('POST', `${APP_ORIGIN}/cdn-cgi/rum`, 'fetch')],
    ['another origin', facts('POST', `${OTHER_ORIGIN}${LIST_RPC_PATH}`, 'fetch')],
    ['a PATCH', facts('PATCH', `${SERVICE_ORIGIN}/rest/v1/members?id=eq.1`, 'fetch')],
    ['a DELETE', facts('DELETE', `${SERVICE_ORIGIN}/rest/v1/members?id=eq.1`, 'fetch')],
  ])('blocks %s as an unregistered non-read request', (_label, request) => {
    expect(decide(request)).toEqual(blocked('UNREGISTERED_NON_READ'));
  });

  it('admits no read request when the audit stage is combined with a submission stage (fail closed)', () => {
    const decision = classifyPassiveRequest(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}`, 'fetch'), ALLOWED_ORIGINS, {
      auditStage: auditStage(),
      writeStage: { writeEndpoint: { origin: APP_ORIGIN, path: '/items' }, remainingPosts: ONE },
    });
    expect(decision.action).toBe('BLOCK');
  });

  it.each(['GET', 'HEAD'])('marks a %s of the service origin for counting (not a navigation of the main frame)', (method) => {
    expect(decide(facts(method, `${SERVICE_ORIGIN}/rest/v1/members?select=*`, 'fetch'))).toEqual(serviceRead);
    expect(decide(facts(method, `${SERVICE_ORIGIN}/avatar.png`, 'image'))).toEqual(serviceRead);
    expect(decide(facts(method, `${SERVICE_ORIGIN}/frame`, 'document', true, false))).toEqual(serviceRead);
    expect(decide(facts(method, `${SERVICE_ORIGIN}/`, 'document', true, true)))
      .toEqual({ action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
  });

  it('keeps the other reads outside the allowed origins as before (no mark)', () => {
    expect(decide(facts('GET', `${OTHER_ORIGIN}/lib.js`, 'script'))).toEqual(directRead);
  });
});

describe('T35b: the static resources outside the read range', () => {
  it.each(STATIC_SUBRESOURCE_TYPES)('reads a GET %s sub resource of the allowed origin outside the read range', (type) => {
    expect(decide(facts('GET', `${APP_ORIGIN}/app.js?v=1`, type))).toEqual(directRead);
  });

  // BN-0（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0。ユーザーの判断 2026-10-23）: 監査の段の Passive の Context では、ページが出す
  // 文書でない GET・HEAD には、読む範囲も読まないパスも危険な語も当てない（データの GET と HEAD も読む）。種類の分からない要求と文書の読み込みは、今どおり当てる。
  it.each([
    ['a fetch', facts('GET', `${APP_ORIGIN}/api/members`, 'fetch')],
    ['an xhr', facts('GET', `${APP_ORIGIN}/api/members`, 'xhr')],
    ['an other type', facts('GET', `${APP_ORIGIN}/data.bin`, 'other')],
    ['a HEAD script', facts('HEAD', `${APP_ORIGIN}/app.js`, 'script')],
  ])('reads %s outside the read range in a Passive context (BN-0)', (_label, request) => {
    expect(decide(request)).toEqual(directRead);
  });

  it.each([
    ['an omitted type', facts('GET', `${APP_ORIGIN}/app.js`, undefined)],
    ['a sub frame navigation', facts('GET', `${APP_ORIGIN}/other`, 'document', true, false)],
    ['a main frame navigation', facts('GET', `${APP_ORIGIN}/other`, 'document', true, true)],
  ])('keeps %s outside the read range excluded', (_label, request) => {
    expect(decide(request)).toEqual(excluded);
  });

  it.each([
    ['a fetch', facts('GET', `${APP_ORIGIN}/api/members`, 'fetch')],
    ['a HEAD script', facts('HEAD', `${APP_ORIGIN}/app.js`, 'script')],
  ])('keeps %s outside the read range excluded in the Interaction context (BN-0)', (_label, request) => {
    expect(classifyPassiveRequest(request, ALLOWED_ORIGINS, {
      auditExclusions: { ...EXCLUSIONS, applyToPageSubresourceReads: true },
      auditStage: auditStage(),
    })).toEqual(excluded);
  });

  it('reads the page static resources that hit the excluded paths or the dangerous terms in a Passive context, and stops them in the Interaction context (BN-0)', () => {
    const urls = [`${APP_ORIGIN}/auth/logout/app.js`, `${APP_ORIGIN}/static/delete-icon.png`, `${APP_ORIGIN}/admin/app.js?action=logout`];
    const types = ['script', 'image', 'script'] as const;
    urls.forEach((url, index) => {
      expect(decide(facts('GET', url, types[index]))).toEqual(directRead);
      expect(classifyPassiveRequest(facts('GET', url, types[index]), ALLOWED_ORIGINS, {
        auditExclusions: { ...EXCLUSIONS, applyToPageSubresourceReads: true },
        auditStage: auditStage(),
      })).toEqual(excluded);
    });
    // 文書の読み込みには、今どおり当てる。
    expect(decide(facts('GET', `${APP_ORIGIN}/auth/logout`, 'document', true, true))).toEqual(excluded);
  });

  it('keeps the read range for the document loads and the Interaction context without the audit stage (the form navigation login audit)', () => {
    // BN-0: ページの文書でない読み取りは、監査の段の口がなくても読む。
    expect(decide(facts('GET', `${APP_ORIGIN}/app.js`, 'script'), null)).toEqual(directRead);
    expect(decide(facts('GET', `${APP_ORIGIN}/other`, 'document', true, true), null)).toEqual(excluded);
    expect(classifyPassiveRequest(facts('GET', `${APP_ORIGIN}/app.js`, 'script'), ALLOWED_ORIGINS, {
      auditExclusions: { ...EXCLUSIONS, applyToPageSubresourceReads: true },
    })).toEqual(excluded);
    expect(decide(facts('GET', `${APP_ORIGIN}/admin/app.js`, 'script'), null)).toEqual(directRead);
  });

  it('keeps the reads inside the read range', () => {
    expect(decide(facts('GET', `${APP_ORIGIN}/admin`, 'document', true, true))).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(decide(facts('GET', `${APP_ORIGIN}/admin/api`, 'fetch'))).toEqual(directRead);
  });
});
