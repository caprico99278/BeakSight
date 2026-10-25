// T35R-fix（Task 35 の設計書の履歴の T35R の行。T35R の C-1・I-2・I-3・M-1）: 監査の段の判定と、Run の上限の数え方。
// - C-1: 幅の走査と Interaction（`REVISIT`）の Context の判定の口（`serviceOriginRequestsWithheld`）では、承認したサービスの Origin への要求を、
//   sub frame の文書を含めてすべて止める（読み取りは新しい理由 `SERVICE_ORIGIN_REVISIT`、読み取りでない要求と main frame の移動は今の理由）。
//   許可 Origin への要求は今どおり。
// - M-1: 登録した読み取りの手続きの呼び出しにも、読まないパスと危険な語を当てて止める（`AUDIT_EXCLUDED_URL`）。読む範囲（`auditPathPrefixes`）は
//   当てない（手続きの呼び出しのパスは画面のパスではない）。
// - I-3: 上限の部品は、前の実行までに数えた数（`initialAdmitted`）から数える（「1 回の Run で 600 件」。1 分あたりの窓は実行ごと）。Run の側は、
//   数えた数と断った数を保存に書き、再開で引き継ぐ。
// - I-2: 断った要求が 1 つでもあれば（前の実行を含めて）、上限に届いたとみなす（`run.json` の `serviceRequestLimitReached`）。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { BLOCKED_REQUEST_REASONS } from '../../src/core/evidence-types.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import {
  auditStageCountsOf,
  createAuditStageRunState,
  jobContextFactoryOptions,
  resumedAuditStageCounts,
  runAuthenticationSummaryOf,
} from '../../src/orchestration/audit-stage-run.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { BLOCKED_REQUEST_REASON_DESCRIPTIONS } from '../../src/presentation/messages.js';
import {
  classifyPassiveRequest,
  type AuditExclusionPolicy,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type RequestResourceType,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const LIST_RPC_PATH = '/rest/v1/rpc/list_members';
const DANGEROUS_RPC_PATH = '/rest/v1/rpc/delete_member';
const EXCLUDED_RPC_PATH = '/auth/logout/rpc';
const ONE = 1;

const stagePolicy = (withheld: boolean | undefined): AuditStagePolicy => ({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  auditReadRequests: [
    { origin: SERVICE_ORIGIN, path: LIST_RPC_PATH, method: 'POST', remainingPosts: withheld === true ? 0 : ONE },
    { origin: SERVICE_ORIGIN, path: DANGEROUS_RPC_PATH, method: 'POST', remainingPosts: ONE },
    { origin: APP_ORIGIN, path: EXCLUDED_RPC_PATH, method: 'POST', remainingPosts: ONE },
  ],
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  ...(withheld === undefined ? {} : { serviceOriginRequestsWithheld: withheld }),
});
const EXCLUSIONS: AuditExclusionPolicy = { excludedPathPrefixes: ['/auth/logout'], auditPathPrefixes: ['/admin'], dangerousTerms: ['logout', 'delete'] };

const facts = (
  method: string,
  url: string,
  resourceType: RequestResourceType | undefined,
  isNavigationRequest = false,
  isMainFrame = false,
): HttpRequestFacts => ({ kind: 'HTTP', method, url, isNavigationRequest, isMainFrame, resourceType });
const decide = (request: HttpRequestFacts, withheld: boolean | undefined): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, { auditExclusions: EXCLUSIONS, auditStage: stagePolicy(withheld) });

const revisitBlocked: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'SERVICE_ORIGIN_REVISIT' };
const excluded: PassiveRequestDecision = { action: 'BLOCK', category: 'AUDIT_EXCLUSION', reason: 'AUDIT_EXCLUDED_URL' };
const serviceRead: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } };

describe('T35R-fix C-1: no request to the approved service origins on the width scan and Interaction contexts', () => {
  it('has the reason in the closed list with a description', () => {
    expect(BLOCKED_REQUEST_REASONS).toContain('SERVICE_ORIGIN_REVISIT');
    expect(BLOCKED_REQUEST_REASON_DESCRIPTIONS.SERVICE_ORIGIN_REVISIT.length).toBeGreaterThan(0);
  });

  it.each<readonly [string, HttpRequestFacts]>([
    ['a fetch read', facts('GET', `${SERVICE_ORIGIN}/rest/v1/members?select=*`, 'fetch')],
    ['a sub frame document', facts('GET', `${SERVICE_ORIGIN}/frame.html`, 'document', true, false)],
    ['an image', facts('GET', `${SERVICE_ORIGIN}/storage/v1/a.png`, 'image')],
    ['a HEAD', facts('HEAD', `${SERVICE_ORIGIN}/rest/v1/members`, 'fetch')],
  ])('blocks %s to a service origin with SERVICE_ORIGIN_REVISIT when withheld', (_name, request) => {
    expect(decide(request, true)).toEqual(revisitBlocked);
    // 最初の読み込み（口が偽か、ない）は今どおり通す。
    expect(decide(request, false)).toEqual(serviceRead);
    expect(decide(request, undefined)).toEqual(serviceRead);
  });

  it('keeps the current reasons of the non-read requests and the main frame navigation, and the allowed origin reads', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}`, 'fetch'), true))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', auditStageBlock: 'READ_REQUEST_OVER_LIMIT' });
    expect(decide(facts('GET', `${SERVICE_ORIGIN}/`, 'document', true, true), true))
      .toEqual({ action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    expect(decide(facts('GET', `${APP_ORIGIN}/admin`, 'fetch'), true)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
  });
});

describe('T35R-fix M-1: the excluded paths and the dangerous terms on the registered read requests', () => {
  it('blocks a registered call whose path has a dangerous term or starts with an excluded path', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${DANGEROUS_RPC_PATH}`, 'fetch'), false)).toEqual(excluded);
    expect(decide(facts('POST', `${APP_ORIGIN}${EXCLUDED_RPC_PATH}`, 'fetch'), false)).toEqual(excluded);
  });

  it('blocks a registered call whose query has a dangerous term', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}?action=logout`, 'fetch'), false)).toEqual(excluded);
  });

  it('admits a registered call outside the read range (the range is for the screen paths)', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${LIST_RPC_PATH}`, 'fetch'), false))
      .toEqual({ action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: { kind: 'AUDIT_READ_REQUEST', index: 0, serviceOrigin: true } });
  });
});

describe('T35R-fix I-3: the service request budget of the whole Run', () => {
  it('counts from the requests admitted by the previous executions, with a new per minute window', () => {
    const budget = createServiceRequestBudget({ perMinute: 2, perRun: 3, now: () => 0, initialAdmitted: 2 });
    expect([budget.tryConsume(), budget.tryConsume()]).toEqual([true, false]);
    expect(budget.snapshot()).toEqual({ admitted: 3, refused: 1, limitReached: true });
    expect(createServiceRequestBudget({ perMinute: 2, perRun: 3, now: () => 0, initialAdmitted: 3 }).isLimitReached()).toBe(true);
    expect(createServiceRequestBudget({ perMinute: 2, perRun: 3, now: () => 0, initialAdmitted: 0 }).isLimitReached()).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN])('rejects the initial count %s', (initialAdmitted) => {
    expect(() => createServiceRequestBudget({ perMinute: 1, perRun: 1, now: () => 0, initialAdmitted })).toThrow(RangeError);
  });
});

describe('T35R-fix I-2・I-3: the counts of the audit stage carried by the checkpoint', () => {
  const auditStage: AuditStageServiceRequests = {
    approvedServiceOrigins: [SERVICE_ORIGIN],
    auditReadRequests: [],
    scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    serviceRequestLimits: { perMinute: 5, perRun: 3 },
  };
  const previous = {
    registeredReadRequestsAllowed: 0,
    tokenRefreshBlocked: 0,
    otherNonReadBlocked: 0,
    serviceUnauthorizedResponses: 0,
    serviceRequestsAdmitted: 2,
    serviceRequestLimitRefused: 1,
    allowedOriginDataRequestsBlocked: 0,
    serviceRequestPacingWaits: 0,
    serviceRequestPacingWaitMs: 0,
  };

  it('starts the budget from the saved admitted count, and saves the totals', () => {
    const state = createAuditStageRunState(auditStage, () => 0, previous);
    expect([state.budget.tryConsume(), state.budget.tryConsume()]).toEqual([true, false]);
    expect(auditStageCountsOf(state)).toMatchObject({ serviceRequestsAdmitted: 3, serviceRequestLimitRefused: 2 });
  });

  it('reports the limit reached in run.json when a previous execution refused a request, keeping the shape of run.json', () => {
    const state = createAuditStageRunState({ ...auditStage, serviceRequestLimits: { perMinute: 5, perRun: 10 } }, () => 0, previous);
    expect(state.budget.isLimitReached()).toBe(false);
    const summary = runAuthenticationSummaryOf(state);
    expect(summary.serviceRequestLimitReached).toBe(true);
    // T37R-fix-B2（Task 37 の設計書 8 章の最後の行）: 許可 Origin への `fetch`・`xhr` を止めた数を足した（記録だけ。前の実行の数は 0）。
    // DEF-141: 1 分あたりの上限で次の読み込みの前に待った回数と時間を足した（前の実行の数は 0）。
    expect(Object.keys(summary).sort()).toEqual([
      'allowedOriginDataRequestsBlocked', 'otherNonReadBlocked', 'registeredReadRequestsAllowed', 'serviceRequestLimitReached',
      'serviceRequestPacingWaitMs', 'serviceRequestPacingWaits', 'serviceUnauthorizedResponses', 'tokenRefreshBlocked',
    ]);
    expect(summary.allowedOriginDataRequestsBlocked).toBe(0);
    expect([summary.serviceRequestPacingWaits, summary.serviceRequestPacingWaitMs]).toEqual([0, 0]);
  });

  it('does not report the limit without a refusal under the limit', () => {
    const state = createAuditStageRunState({ ...auditStage, serviceRequestLimits: { perMinute: 5, perRun: 10 } }, () => 0, undefined);
    expect(state.budget.tryConsume()).toBe(true);
    expect(runAuthenticationSummaryOf(state).serviceRequestLimitReached).toBe(false);
    expect(auditStageCountsOf(state)).toMatchObject({ serviceRequestsAdmitted: 1, serviceRequestLimitRefused: 0 });
  });
});

// T35R2-fix（T35R2 の M-1）: 再開の上限の数は、保存の `serviceRequestsAdmitted` と、負荷の記録の `approvedServiceOrigins.count` の大きい方から始める。
// 保存に監査の段の数がなければ、再開しない（`null`。Run Coordinator が理由つきで止める）。
describe('T35R2-fix M-1: the counts to resume the audit stage from', () => {
  const counts = {
    registeredReadRequestsAllowed: 1,
    tokenRefreshBlocked: 0,
    otherNonReadBlocked: 0,
    serviceUnauthorizedResponses: 0,
    serviceRequestsAdmitted: 2,
    serviceRequestLimitRefused: 0,
    allowedOriginDataRequestsBlocked: 0,
    serviceRequestPacingWaits: 0,
    serviceRequestPacingWaitMs: 0,
  };

  it('starts from the larger of the saved admitted count and the load record of the service origins', () => {
    expect(resumedAuditStageCounts({ auditStageCounts: { ...counts, serviceRequestsAdmitted: 0 }, approvedServiceOrigins: { count: 3, peakPerMinute: 3 } }))
      .toEqual({ ...counts, serviceRequestsAdmitted: 3 });
    expect(resumedAuditStageCounts({ auditStageCounts: { ...counts, serviceRequestsAdmitted: 5 }, approvedServiceOrigins: { count: 3, peakPerMinute: 3 } }))
      .toEqual({ ...counts, serviceRequestsAdmitted: 5 });
    expect(resumedAuditStageCounts({ auditStageCounts: counts })).toEqual(counts);
  });

  it('gives null without the saved counts', () => {
    expect(resumedAuditStageCounts({ approvedServiceOrigins: { count: 3, peakPerMinute: 3 } })).toBeNull();
    expect(resumedAuditStageCounts({})).toBeNull();
  });
});

// T35R2-fix（T35R2 の C-1 の (b)・(c)）: Run Coordinator を通らないジョブの流れ（発見・READ の確かめ・書き込み）の factory の指定。上限の部品は Run と
// 同じ共通の部品で作る（ジョブの全体で 1 つ）。登録した読み取りの手続きの呼び出しは、Task 37 で決めるまで通さない（口の項目を空にして渡す）。
describe('T35R2-fix C-1: the factory options of the jobs without the Run Coordinator', () => {
  const auditStage: AuditStageServiceRequests = {
    approvedServiceOrigins: [SERVICE_ORIGIN],
    auditReadRequests: [{ origin: SERVICE_ORIGIN, path: LIST_RPC_PATH, method: 'POST', maxPerPageLoad: ONE }],
    scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    serviceRequestLimits: { perMinute: 2, perRun: 2 },
  };
  const authentication = (stage: AuditStageServiceRequests | undefined): RunAuthentication => ({
    initialState: { cookies: [], origins: [] },
    approvedTestOrigins: [APP_ORIGIN],
    auditExclusions: EXCLUSIONS,
    sessionLostPathPrefix: '/auth',
    filterState: (state) => state,
    ...(stage === undefined ? {} : { auditStage: stage }),
  });

  // T37a（Task 37 の設計書 3.1）: 登録した読み取りの手続きの呼び出しを空にするのは、書き込みのジョブ（`NONE`）だけになった（発見と READ の確かめは
  // `REGISTERED`。`tests/unit/job-audit-stage.test.ts`）。ここは `NONE` の形を、今どおり確かめる。
  it('passes the audit stage without the registered read requests, with a budget of the whole job', () => {
    const options = jobContextFactoryOptions(authentication(auditStage), () => 0, 'NONE').factoryOptions;
    expect(options.authentication.auditStage).toEqual({ ...auditStage, auditReadRequests: [] });
    expect([options.serviceRequestBudget?.tryConsume(), options.serviceRequestBudget?.tryConsume(), options.serviceRequestBudget?.tryConsume()])
      .toEqual([true, true, false]);
    expect(options.auditStageMonitor).toBeDefined();
  });

  it('passes no budget without the audit stage', () => {
    const options = jobContextFactoryOptions(authentication(undefined), () => 0, 'NONE').factoryOptions;
    expect(options.authentication.auditStage).toBeUndefined();
    expect(options.serviceRequestBudget).toBeUndefined();
    expect(options.auditStageMonitor).toBeUndefined();
  });
});
