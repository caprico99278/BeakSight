// T37a（Task 37 の設計書 3.1）: Run Coordinator を通らないジョブ（発見・READ の確かめ・書き込み）の監査の段の口の、純粋な部品と契約。
// - `jobContextFactoryOptions` は、作った監査の段の状態も返す。発見と READ は登録した読み取りの手続きの呼び出しを通し（`REGISTERED`）、書き込みは
//   今どおり空にする（`NONE`）。口がなければ、状態はない。
// - 上限に届いたか・鍵が消えたか・1 画面の断った要求と 401 の数の判定は、Run Coordinator と共有する 1 か所（`audit-stage-run.ts`）。
// - 終わり方と理由の閉じた一覧（`SERVICE_REQUEST_LIMIT_REACHED`）、画面の不完全の理由（`SERVICE_READ_REFUSED`。読み切れなかった画面に数える）、
//   詳しい理由（`session-key`）、成果物の任意の項目 `authentication`、成果物の版、件数の要約、IPC の `FINISHED` の要約。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { WORKER_PROTOCOL_VERSION, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { SESSION_KEY_LOST_DETAIL as CORE_SESSION_KEY_LOST_DETAIL, type RunAuthenticationSummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { INCOMPLETE_REASONS, type DiscoveredCandidate, type DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  DISCOVERY_END_REASONS,
  DISCOVERY_UNREAD_REASONS,
  JOB_END_REASON_DETAILS,
  SERVICE_READ_REFUSED_REASON,
  discoveryReadPagePaths,
  discoveryRunStatusOf,
  discoverySummaryOf,
  isDiscoveryPageReadInFull,
  sameJobAuthenticationSummary,
  withServiceReadRefused,
  type DiscoveryDocument,
  type DiscoveryPageEntry,
  type DiscoveryReadPageRecord,
} from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import {
  READ_CHECK_END_REASONS,
  READ_CHECK_NOT_EXECUTED_REASONS,
  READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  readEvidenceRunStatusOf,
  readEvidenceSummaryOf,
  type ReadEvidenceDocument,
} from '../../src/discovery/read-check-evaluation.js';
import {
  SESSION_KEY_LOST_DETAIL,
  isServiceRequestLimitReached,
  jobContextFactoryOptions,
  serviceReadRefusalCountOf,
  sessionKeyLostDetailOf,
  auditStageReadObservationBetween,
  isAuditStageReadObstructed,
  type AuditStageReadCounts,
} from '../../src/orchestration/audit-stage-run.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SAMPLE_ALLOWED_ORIGINS, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const LIST_RPC_PATH = '/rest/v1/rpc/list_members';
const LIMIT_REASON = 'SERVICE_REQUEST_LIMIT_REACHED';

const AUDIT_STAGE: AuditStageServiceRequests = {
  approvedServiceOrigins: [SERVICE_ORIGIN],
  auditReadRequests: [{ origin: SERVICE_ORIGIN, path: LIST_RPC_PATH, method: 'POST', maxPerPageLoad: 1 }],
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  serviceRequestLimits: { perMinute: 2, perRun: 2 },
};
const authentication = (stage: AuditStageServiceRequests | undefined): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [APP_ORIGIN],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
  sessionLostPathPrefix: '/auth',
  filterState: (state) => state,
  ...(stage === undefined ? {} : { auditStage: stage }),
});

const SUMMARY: RunAuthenticationSummary = Object.freeze({
  registeredReadRequestsAllowed: 2,
  tokenRefreshBlocked: 0,
  otherNonReadBlocked: 1,
  serviceUnauthorizedResponses: 3,
  serviceRequestLimitReached: true,
});

const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(discovered),
});
const BUTTON = candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: '/admin' } }));

const recordOf = (path: string, incompleteReasons: DiscoveryReadPageRecord['incompleteReasons'] = []): DiscoveryReadPageRecord =>
  ({ location: { origin: SAMPLE_ORIGIN, path }, incompleteReasons, candidates: [BUTTON] });

const discoveryDocumentOf = (pages: readonly DiscoveryPageEntry[], overrides: Partial<DiscoveryDocument> = {}): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261017010000',
  startedAt: '20261017010000',
  finishedAt: '20261017010100',
  runStatus: 'PARTIAL',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages,
  omittedUnreadPages: 0,
  ...overrides,
});

const readEvidenceOf = (overrides: Partial<ReadEvidenceDocument> = {}): ReadEvidenceDocument => ({
  schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-2',
  runId: 'RUN-20261017010000',
  startedAt: '20261017010000',
  finishedAt: '20261017010100',
  runStatus: 'PARTIAL',
  endReason: LIMIT_REASON,
  // T37d: 版 1.2 の書き手は、対象の種類を必ず書く。
  checks: [{
    readCheckId: 'read-1', readCheckRevision: 1, targetKind: 'CANDIDATE', targetIdentityDigest: `sha256:${'a'.repeat(64)}`, state: 'NOT_EXECUTED',
    reason: LIMIT_REASON,
  }],
  ...overrides,
});

describe('T37a: the closed lists of the end reasons and the page reasons', () => {
  it('has SERVICE_REQUEST_LIMIT_REACHED in the end reasons and the reasons not to read of the discovery and the READ check', () => {
    expect(DISCOVERY_END_REASONS).toContain(LIMIT_REASON);
    expect(DISCOVERY_UNREAD_REASONS).toContain(LIMIT_REASON);
    expect(READ_CHECK_END_REASONS).toContain(LIMIT_REASON);
    expect(READ_CHECK_NOT_EXECUTED_REASONS).toContain(LIMIT_REASON);
  });

  it('has SERVICE_READ_REFUSED at the end of the page reasons, and session-key as the only detail of the end', () => {
    expect(SERVICE_READ_REFUSED_REASON).toBe('SERVICE_READ_REFUSED');
    expect(INCOMPLETE_REASONS.at(-1)).toBe(SERVICE_READ_REFUSED_REASON);
    expect(JOB_END_REASON_DETAILS).toEqual(['session-key']);
    // 詳しい理由の値は Task 35 と同じ（owner は `src/core/contracts.ts`。Run Coordinator と同じ値を使う）。
    expect(SESSION_KEY_LOST_DETAIL).toBe(CORE_SESSION_KEY_LOST_DETAIL);
    expect(SESSION_KEY_LOST_DETAIL).toBe('session-key');
  });

  it('raises the versions of discovery.json and read-evidence.json', () => {
    expect(DISCOVERY_ARTIFACT_SCHEMA_VERSION).toBe('discovery-schema/1.1');
    // T37d（Task 37 の設計書 3.5）: read-evidence.json は、対象の種類と画面の path を足して 1.2 に上げた。
    expect(READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION).toBe('read-evidence-schema/1.2');
  });
});

// LG-4（テストの組の設計書 3.7.3）: 読み手は今の版だけを受ける（discovery.json の 1.0、read-evidence.json の 1.0・1.1 は捨てた）。読める版の一覧と
// スキーマの enum の一致は `schema-enum-consistency.test.ts` が確かめる。
describe('LG-4: the readers accept only the current versions of discovery.json and read-evidence.json', () => {
  it('rejects the previous versions and another version, even in the current shape', async () => {
    const discovery = discoveryDocumentOf([{ url: `${SAMPLE_ORIGIN}/admin`, state: 'READ', record: recordOf('/admin'), blockedRequests: 0 }]);
    expect((await validateArtifact('discovery', discovery)).ok).toBe(true);
    for (const version of ['discovery-schema/1.0', 'discovery-schema/1.2']) {
      expect((await validateArtifact('discovery', { ...discovery, schemaVersion: version })).ok, version).toBe(false);
    }
    const evidence = readEvidenceOf();
    expect((await validateArtifact('read-evidence', evidence)).ok).toBe(true);
    for (const version of ['read-evidence-schema/1.0', 'read-evidence-schema/1.1', 'read-evidence-schema/1.3']) {
      expect((await validateArtifact('read-evidence', { ...evidence, schemaVersion: version })).ok, version).toBe(false);
    }
  });
});

describe('T37a: a page with a refused service read is not read in full', () => {
  it('adds SERVICE_READ_REFUSED to the page and to each candidate in the order of the closed list, once', () => {
    const refused = withServiceReadRefused(recordOf('/admin', ['INCOMPLETE_LIMIT_REACHED']));
    expect(refused.incompleteReasons).toEqual(['INCOMPLETE_LIMIT_REACHED', SERVICE_READ_REFUSED_REASON]);
    expect(refused.candidates.map((candidate) => candidate.incompleteReasons)).toEqual([[SERVICE_READ_REFUSED_REASON]]);
    expect(withServiceReadRefused(refused)).toEqual(refused);
    // 識別と規則の digest は変えない（索引のドリフトは digest で見る）。
    expect(refused.candidates[0]?.identityDigest).toBe(BUTTON.identityDigest);
    expect(refused.candidates[0]?.ruleDigest).toBe(BUTTON.ruleDigest);
  });

  it('keeps the path of the page out of the read page paths, so that its candidates are not MISSING', () => {
    const refused = withServiceReadRefused(recordOf('/admin'));
    expect(isDiscoveryPageReadInFull(refused)).toBe(false);
    expect(isDiscoveryPageReadInFull(recordOf('/admin'))).toBe(true);
    const document = discoveryDocumentOf([
      { url: `${SAMPLE_ORIGIN}/admin`, state: 'READ', record: refused, blockedRequests: 0 },
      { url: `${SAMPLE_ORIGIN}/admin/b`, state: 'READ', record: recordOf('/admin/b'), blockedRequests: 0 },
    ]);
    expect(discoveryReadPagePaths(document)).toEqual(['/admin/b']);
    expect(discoveryRunStatusOf(document)).toBe('PARTIAL');
  });
});

describe('T37a: the Run Status of a job that reached the service request limit', () => {
  it('is PARTIAL for the discovery that ended at the limit', () => {
    const document = discoveryDocumentOf([
      { url: `${SAMPLE_ORIGIN}/admin`, state: 'READ', record: recordOf('/admin'), blockedRequests: 0 },
      { url: `${SAMPLE_ORIGIN}/admin/b`, state: 'NOT_READ', reason: LIMIT_REASON },
    ], { endReason: LIMIT_REASON });
    expect(discoveryRunStatusOf(document)).toBe('PARTIAL');
  });

  it('is PARTIAL for the READ check that ended at the limit', () => {
    expect(readEvidenceRunStatusOf(readEvidenceOf())).toBe('PARTIAL');
  });
});

describe('T37a: the artifacts carry the counts of the audit stage and the detail of the end', () => {
  it('accepts discovery.json with authentication and the session-key detail, and rejects other details and a wrong shape', async () => {
    const lost = discoveryDocumentOf([{ url: `${SAMPLE_ORIGIN}/admin`, state: 'NOT_READ', reason: 'AUTH_SESSION_LOST' }], {
      endReason: 'AUTH_SESSION_LOST', endReasonDetail: SESSION_KEY_LOST_DETAIL, authentication: SUMMARY,
    });
    expect((await validateArtifact('discovery', lost)).ok).toBe(true);
    expect((await validateArtifact('discovery', discoveryDocumentOf([]))).ok).toBe(true);
    expect((await validateArtifact('discovery', { ...lost, endReasonDetail: 'other' })).ok).toBe(false);
    expect((await validateArtifact('discovery', { ...lost, authentication: { ...SUMMARY, url: APP_ORIGIN } })).ok).toBe(false);
  });

  it('accepts read-evidence.json with authentication and the session-key detail', async () => {
    const document = readEvidenceOf({ authentication: SUMMARY });
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    const lost = readEvidenceOf({
      endReason: 'AUTH_SESSION_LOST', endReasonDetail: SESSION_KEY_LOST_DETAIL,
      checks: [{
        readCheckId: 'read-1', readCheckRevision: 1, targetKind: 'CANDIDATE', targetIdentityDigest: `sha256:${'a'.repeat(64)}`, state: 'NOT_EXECUTED',
        reason: 'AUTH_SESSION_LOST',
      }],
    });
    expect((await validateArtifact('read-evidence', lost)).ok).toBe(true);
    expect((await validateArtifact('read-evidence', { ...document, authentication: { ...SUMMARY, serviceRequestLimitReached: 1 } })).ok).toBe(false);
  });

  it('puts the counts of the audit stage into the summary of the job only when the artifact has them', () => {
    const page: DiscoveryPageEntry = { url: `${SAMPLE_ORIGIN}/admin`, state: 'READ', record: recordOf('/admin'), blockedRequests: 0 };
    expect(discoverySummaryOf(discoveryDocumentOf([page], { authentication: SUMMARY }))).toEqual({ pagesRead: 1, pagesNotRead: 0, candidates: 1, authentication: SUMMARY });
    expect(discoverySummaryOf(discoveryDocumentOf([page]))).toEqual({ pagesRead: 1, pagesNotRead: 0, candidates: 1 });
    expect(readEvidenceSummaryOf(readEvidenceOf({ authentication: SUMMARY }))).toEqual({ checks: 1, executed: 0, authentication: SUMMARY });
    expect(readEvidenceSummaryOf(readEvidenceOf())).toEqual({ checks: 1, executed: 0 });
  });

  it('tells the same counts of the audit stage (both absent, or the same numbers)', () => {
    expect(sameJobAuthenticationSummary(undefined, undefined)).toBe(true);
    expect(sameJobAuthenticationSummary(SUMMARY, { ...SUMMARY })).toBe(true);
    expect(sameJobAuthenticationSummary(SUMMARY, undefined)).toBe(false);
    expect(sameJobAuthenticationSummary(undefined, SUMMARY)).toBe(false);
    expect(sameJobAuthenticationSummary(SUMMARY, { ...SUMMARY, serviceUnauthorizedResponses: 4 })).toBe(false);
    expect(sameJobAuthenticationSummary(SUMMARY, { ...SUMMARY, serviceRequestLimitReached: false })).toBe(false);
  });
});

describe('T37a: FINISHED carries the counts of the audit stage in the summary of the discovery and the READ check', () => {
  const outcome = { kind: 'RAN', exitCode: 1, runId: 'RUN-20261017000000', runDirectory: 'RUN-20261017000000', runStatus: 'PARTIAL' };
  const finishedErrors = (extra: Record<string, unknown>): readonly string[] => {
    const checked = validateWorkerToParentMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome, ...extra });
    return checked.ok ? [] : checked.errors;
  };

  it('accepts the counts in the discovery and the READ check summaries, and rejects a wrong shape', () => {
    expect(finishedErrors({ discovery: { pagesRead: 1, pagesNotRead: 1, candidates: 0, authentication: SUMMARY } })).toEqual([]);
    expect(finishedErrors({ readCheck: { checks: 1, executed: 0, authentication: SUMMARY } })).toEqual([]);
    expect(finishedErrors({ discovery: { pagesRead: 1, pagesNotRead: 1, candidates: 0, authentication: { ...SUMMARY, url: APP_ORIGIN } } }).length)
      .toBeGreaterThan(0);
    expect(finishedErrors({ readCheck: { checks: 1, executed: 0, authentication: { ...SUMMARY, otherNonReadBlocked: -1 } } }).length).toBeGreaterThan(0);
  });
});

describe('T37a: the audit stage of the jobs without the Run Coordinator', () => {
  it('passes the registered read requests for the discovery and the READ check, and returns the state with the budget given to the factory', () => {
    const { factoryOptions, state } = jobContextFactoryOptions(authentication(AUDIT_STAGE), () => 0, 'REGISTERED');
    expect(factoryOptions.authentication.auditStage).toEqual(AUDIT_STAGE);
    expect(state).not.toBeNull();
    expect(factoryOptions.serviceRequestBudget).toBe(state?.budget);
    expect(factoryOptions.auditStageMonitor).toBe(state?.monitor);
  });

  it('keeps the registered read requests empty for the write jobs', () => {
    const { factoryOptions, state } = jobContextFactoryOptions(authentication(AUDIT_STAGE), () => 0, 'NONE');
    expect(factoryOptions.authentication.auditStage).toEqual({ ...AUDIT_STAGE, auditReadRequests: [] });
    expect(state).not.toBeNull();
  });

  it('has no state without the audit stage', () => {
    const { factoryOptions, state } = jobContextFactoryOptions(authentication(undefined), () => 0, 'REGISTERED');
    expect(state).toBeNull();
    expect(factoryOptions.authentication.auditStage).toBeUndefined();
    expect(factoryOptions.serviceRequestBudget).toBeUndefined();
  });

  it('tells the limit, the lost key and the refused reads of the state at one place', () => {
    const { factoryOptions, state } = jobContextFactoryOptions(authentication(AUDIT_STAGE), () => 0, 'REGISTERED');
    if (state === null) {
      throw new Error('the state was not made');
    }
    expect(isServiceRequestLimitReached(null)).toBe(false);
    expect(sessionKeyLostDetailOf(null)).toBeNull();
    expect(isServiceRequestLimitReached(state)).toBe(false);
    expect(serviceReadRefusalCountOf(state)).toBe(0);
    expect([state.budget.tryConsume(), state.budget.tryConsume()]).toEqual([true, true]);
    // `perRun` まで数えたら、次の画面を始めない（断った要求はまだない）。
    expect(isServiceRequestLimitReached(state)).toBe(true);
    expect(serviceReadRefusalCountOf(state)).toBe(0);
    expect(state.budget.tryConsume()).toBe(false);
    factoryOptions.onServiceUnauthorizedResponse?.();
    // 断った要求と 401 の数の和（画面ごとの差で、その画面の不完全の理由を決める）。
    expect(serviceReadRefusalCountOf(state)).toBe(2);
    expect(sessionKeyLostDetailOf(state)).toBeNull();
    factoryOptions.onSessionKeyLost?.();
    expect(sessionKeyLostDetailOf(state)).toBe(SESSION_KEY_LOST_DETAIL);
  });
});

// T37R-fix-B（T37R の M-2・M-5）: 「描けなかった画面」の判定は、発見と READ の確かめが共有する 1 か所（読み込みの前と後の数の差と、その判定）。
describe('T37R-fix-B: the one decision of a page that could not be drawn', () => {
  const zero: AuditStageReadCounts = { serviceReadRefusals: 0, registeredReadRequestsBlocked: 0, serviceOriginNonReadBlocked: 0, allowedOriginDataRequestsBlocked: 0 };

  it('makes the observation of one load from the counts before and after it', () => {
    expect(auditStageReadObservationBetween(zero, zero)).toEqual({
      serviceReadRefused: false, registeredReadRequestsBlocked: 0, serviceOriginNonReadBlocked: 0, allowedOriginDataRequestsBlocked: 0,
    });
    const before: AuditStageReadCounts = { serviceReadRefusals: 2, registeredReadRequestsBlocked: 1, serviceOriginNonReadBlocked: 3, allowedOriginDataRequestsBlocked: 4 };
    expect(auditStageReadObservationBetween(before, { ...before, serviceReadRefusals: 3, allowedOriginDataRequestsBlocked: 6 })).toEqual({
      serviceReadRefused: true, registeredReadRequestsBlocked: 0, serviceOriginNonReadBlocked: 0, allowedOriginDataRequestsBlocked: 2,
    });
  });

  it('tells a page that could not be drawn by any of the refusal, the stopped registered call, the stopped service and allowed origin requests', () => {
    const none = auditStageReadObservationBetween(zero, zero);
    expect(isAuditStageReadObstructed(null)).toBe(false);
    expect(isAuditStageReadObstructed(none)).toBe(false);
    for (const key of ['registeredReadRequestsBlocked', 'serviceOriginNonReadBlocked'] as const) {
      expect(isAuditStageReadObstructed({ ...none, [key]: 1 }), key).toBe(true);
    }
    // T37R-fix-B2（M-5 の取り下げ）: 許可 Origin への `fetch`・`xhr` を止めた数は、判定に使わない（記録するだけ）。
    expect(isAuditStageReadObstructed({ ...none, allowedOriginDataRequestsBlocked: 1 })).toBe(false);
    expect(isAuditStageReadObstructed({ ...none, serviceReadRefused: true })).toBe(true);
  });
});
