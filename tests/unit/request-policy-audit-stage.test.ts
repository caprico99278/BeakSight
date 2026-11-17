// T35b（Task 35 の設計書 `2026-10-16-beaksight-task-35-spa-audit-design.md` 3.2、3.3、4 章）: 要求の判定（`classifyPassiveRequest`）の、
// スクリプトで送るログインの監査の段の口（`auditStage`）と、登録した送信の判定の共通の関数（`registeredSubmissionVerdict`）。
// - 共通の判定: `POST`、種類が fetch か xhr、Origin と path が一致（query は問わない）、その項目の残りが 1 以上のときだけ通す（項目の位置を返す）。
//   一致しなければ `NO_MATCH`。理由は共通の一覧（`REGISTERED_SUBMISSION_BLOCK_REASONS`）で、段の理由に写す（ログインの段の今の理由の値は変えない）。
// - 監査の段の口: 登録した読み取りの手続きの呼び出しだけを、読み込みごとの回数の中で通す（`auditStageAdmission`）。token の送信先への、必須の
//   query と違う POST（更新など）は `TOKEN_REFRESH`、ほかの読み取りでない要求は `UNREGISTERED_NON_READ`（今どおり `NON_READ_METHOD`）。
//   承認したサービスの Origin への読み取りは、数えるために `SERVICE_ORIGIN_READ` の印を付けて通す。
// - SD-2: 読む範囲・読まないパス・危険な語は、main frame の文書の読み込みだけに当てる（前の静的な資源の例外は外した）。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  AUDIT_STAGE_BLOCK_REASONS,
  REGISTERED_SUBMISSION_BLOCK_REASONS,
  SCRIPT_LOGIN_BLOCK_REASONS,
  classifyPassiveRequest,
  isAuditExcludedUrl,
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
    // SD-2: main frame の移動は止めず、印も付けない（数えない。範囲の外へ移った画面は読み込みの側が点検しない）。
    expect(decide(facts(method, `${SERVICE_ORIGIN}/`, 'document', true, true))).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
  });

  it('keeps the other reads outside the allowed origins as before (no mark)', () => {
    expect(decide(facts('GET', `${OTHER_ORIGIN}/lib.js`, 'script'))).toEqual(directRead);
  });
});

// SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4。前の T35b の静的な資源の例外と BN-0 の Interaction の印は外した）: 読む範囲・
// 読まないパス・危険な語は、要求の判定では当てない（監査の段の口の有無によらない）。BeakSight 自身の移動の前の判定（`isAuditExcludedUrl`）が当てる。
describe('T35b and SD-2: the read range is not applied by the request policy', () => {
  it('reads the page reads and the main frame loads outside the read range or hitting the exclusions, with or without the audit stage', () => {
    for (const stage of [auditStage(), null] as const) {
      for (const request of [
        facts('GET', `${APP_ORIGIN}/app.js?v=1`, 'script'),
        facts('GET', `${APP_ORIGIN}/api/members`, 'fetch'),
        facts('HEAD', `${APP_ORIGIN}/app.js`, undefined),
        facts('GET', `${APP_ORIGIN}/other`, 'document', true, false),
        facts('GET', `${APP_ORIGIN}/static/delete-icon.png`, 'image'),
      ]) {
        expect(decide(request, stage)).toEqual(directRead);
      }
      expect(decide(facts('GET', `${APP_ORIGIN}/other`, 'document', true, true), stage)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    }
    expect([`${APP_ORIGIN}/other`, `${APP_ORIGIN}/auth/logout`].map((url) => isAuditExcludedUrl(url, ALLOWED_ORIGINS, EXCLUSIONS))).toEqual([true, true]);
  });

  it('keeps the reads inside the read range', () => {
    expect(decide(facts('GET', `${APP_ORIGIN}/admin`, 'document', true, true))).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(decide(facts('GET', `${APP_ORIGIN}/admin/api`, 'fetch'))).toEqual(directRead);
  });
});
