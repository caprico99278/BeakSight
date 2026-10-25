// AS-c（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 5 章の「ユーザーの言葉と選択（AS-c）」「AS-c の Blocker」の行）: 監査の段の送信の扱い
// `PASS_EXCEPT_DELETE` で、次を変える（既定の `READ_ONLY`、口のない判定は変えない）。
// - 送り先の Origin の制限をなくす（DELETE・危険な語・文書のナビゲーションの POST・上限は今のまま止める）。
// - WebSocket の接続を通す（危険な語の path・除外は止める。1 つの Context の上限 `AUDIT_SEND_MAX_WEBSOCKETS_PER_CONTEXT` を超えたら `AUDIT_SEND_OVER_LIMIT`）。
//   接続の形（Origin、path、数）を Safety Ledger に記録する（query・送受信・値は記録しない）。
// - スクリプトで送るログインの監査の段の token の更新（`TOKEN_REFRESH`）を通す（サービスの Origin へ送らない Context は今どおり止める）。
// - ほかの Origin へ通した数を、Safety Ledger の通した要求の記録に数える。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import { runSummaryLines } from '../../src/cli/output.js';
import { BLOCKED_WEBSOCKET_REASONS } from '../../src/core/evidence-types.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import { formatCount } from '../../src/presentation/format.js';
import { AUDIT_SEND_TEXT } from '../../src/presentation/messages.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun, runSummary } from '../helpers/audit-run-fixture.js';
import {
  AUDIT_SEND_CONNECT_POLICY,
  AUDIT_SEND_MAX_WEBSOCKETS_PER_CONTEXT,
  WORKER_CONNECT_POLICY,
  WORKER_CONNECT_POLICY_INIT_SCRIPT,
  connectPolicyInitScriptOf,
  isGuardAuditSend,
  type GuardAuditSend,
} from '../../src/safety/passive-request-guard.js';
import {
  classifyPassiveRequest,
  type AuditSendPolicy,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestFacts,
  type PassiveRequestPolicyOptions,
} from '../../src/safety/request-policy.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const DANGEROUS_TERMS = Object.freeze(['logout', 'delete', 'remove', 'cancel']);
const TOKEN_PATH = '/auth/v1/token';
const MARKER = 'marker-value-should-not-appear';

/** 口（`remainingWebSockets` が `null` なら、WebSocket の残りの数を持たない口）。 */
const auditSend = (remainingPasses = 1, remainingWebSockets: number | null = 1): AuditSendPolicy => ({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  dangerousTerms: DANGEROUS_TERMS,
  remainingPasses,
  ...(remainingWebSockets === null ? {} : { remainingWebSockets }),
});

const facts = (method: string, url: string, isNavigationRequest = false, isMainFrame = false): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest, isMainFrame, resourceType: 'fetch' });
const socket = (url: string): PassiveRequestFacts => ({ kind: 'WEBSOCKET', url });

const decide = (request: PassiveRequestFacts, policy: PassiveRequestPolicyOptions = { auditSend: auditSend() }): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, policy);

const PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };
const NON_READ = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
const SOCKET_PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendWebSocketAdmission: true };
const SOCKET_BLOCKED = { action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' };

describe('AS-c: no Origin restriction for the page requests with PASS_EXCEPT_DELETE', () => {
  it('passes the page requests to any http(s) Origin', () => {
    expect(decide(facts('POST', `${OTHER_ORIGIN}/collect`))).toEqual(PASSED);
    expect(decide(facts('PUT', 'http://127.0.0.1:9/api/save'))).toEqual(PASSED);
  });

  it('keeps blocking DELETE, navigations (form posts), dangerous terms and the limit, also for another Origin', () => {
    expect(decide(facts('DELETE', `${OTHER_ORIGIN}/api/session`))).toEqual(NON_READ);
    expect(decide(facts('POST', `${OTHER_ORIGIN}/form`, true, true))).toEqual(NON_READ);
    expect(decide(facts('POST', `${OTHER_ORIGIN}/form`, true, false))).toEqual(NON_READ);
    expect(decide(facts('POST', `${OTHER_ORIGIN}/api/logout`))).toEqual(NON_READ);
    expect(decide(facts('POST', 'not a url'))).toEqual(NON_READ);
    expect(decide(facts('POST', `${OTHER_ORIGIN}/collect`), { auditSend: auditSend(0) }))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'AUDIT_SEND_OVER_LIMIT' });
  });

  it('does not change the request policy without the option (READ_ONLY)', () => {
    expect(decide(facts('POST', `${OTHER_ORIGIN}/collect`), {})).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/collect`), {})).toEqual(NON_READ);
  });
});

describe('AS-c: the token refresh with PASS_EXCEPT_DELETE', () => {
  const auditStage = (withheld = false): AuditStagePolicy => ({
    approvedServiceOrigins: [SERVICE_ORIGIN],
    auditReadRequests: [],
    scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    ...(withheld ? { serviceOriginRequestsWithheld: true } : {}),
  });

  it('passes the token refresh of the audit stage', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=refresh_token`), { auditSend: auditSend(), auditStage: auditStage() })).toEqual(PASSED);
  });

  it('keeps blocking it without the option and in a Context that does not send to the service Origin', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=refresh_token`), { auditStage: auditStage() }))
      .toEqual({ ...NON_READ, auditStageBlock: 'TOKEN_REFRESH' });
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=refresh_token`), { auditSend: auditSend(), auditStage: auditStage(true) }))
      .toEqual({ ...NON_READ, auditStageBlock: 'TOKEN_REFRESH' });
  });
});

describe('AS-c: WebSocket connections with PASS_EXCEPT_DELETE', () => {
  it('passes a WebSocket connection to any Origin while connections remain', () => {
    expect(decide(socket('wss://example.com/realtime/v1/websocket?apikey=x'))).toEqual(SOCKET_PASSED);
    expect(decide(socket('ws://127.0.0.1:9/socket'))).toEqual(SOCKET_PASSED);
    expect(decide(socket(`wss://other.example.invalid/socket`))).toEqual(SOCKET_PASSED);
  });

  it('blocks a dangerous or excluded path, and blocks with AUDIT_SEND_OVER_LIMIT when nothing remains', () => {
    expect(decide(socket('wss://example.com/logout/socket'))).toEqual(SOCKET_BLOCKED);
    expect(decide(socket('wss://example.com/socket?action=cancel'))).toEqual(SOCKET_BLOCKED);
    expect(decide(socket('wss://example.com/admin/danger/socket'), {
      auditSend: auditSend(),
      auditExclusions: { excludedPathPrefixes: ['/admin/danger'], auditPathPrefixes: [], dangerousTerms: [] },
    })).toEqual(SOCKET_BLOCKED);
    expect(decide(socket('not a url'))).toEqual(SOCKET_BLOCKED);
    expect(decide(socket('wss://example.com/socket'), { auditSend: auditSend(1, 0) }))
      .toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'AUDIT_SEND_OVER_LIMIT' });
    // HTTP の残りの数とは別に数える。
    expect(decide(socket('wss://example.com/socket'), { auditSend: auditSend(0, 1) })).toEqual(SOCKET_PASSED);
  });

  it('keeps blocking without the option, without the WebSocket count, and with the login or write stage (fail-closed)', () => {
    expect(decide(socket('wss://example.com/socket'), {})).toEqual(SOCKET_BLOCKED);
    expect(decide(socket('wss://example.com/socket'), { auditSend: auditSend(1, null) })).toEqual(SOCKET_BLOCKED);
    const authSetup = { loginPostEndpoints: [{ origin: APP_ORIGIN, path: '/login' }], remainingPosts: 1 };
    expect(decide(socket('wss://example.com/socket'), { auditSend: auditSend(), authSetup })).toEqual(SOCKET_BLOCKED);
    const writeStage = { writeEndpoint: { origin: APP_ORIGIN, path: '/members' }, remainingPosts: 1 };
    expect(decide(socket('wss://example.com/socket'), { auditSend: auditSend(), writeStage })).toEqual(SOCKET_BLOCKED);
  });

  it('keeps blocking a WebSocket to the service Origin in a Context that does not send to it', () => {
    const auditStage: AuditStagePolicy = {
      approvedServiceOrigins: [SERVICE_ORIGIN],
      auditReadRequests: [],
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [] },
      serviceOriginRequestsWithheld: true,
    };
    expect(decide(socket('wss://service.example.invalid/realtime'), { auditSend: auditSend(), auditStage })).toEqual(SOCKET_BLOCKED);
    expect(decide(socket('wss://example.com/realtime'), { auditSend: auditSend(), auditStage })).toEqual(SOCKET_PASSED);
  });

  // AS-c の WebSocket の Blocker の判断 W1（設計書 5 章）: `PASS_EXCEPT_DELETE` の Passive の Context だけ、文書と http(s) の script の Worker の CSP の
  // `connect-src` に `ws:`・`wss:` を足す（ページの WebSocket は Guard の route が判定・記録・上限を当てる）。既定と Interaction の policy は今のまま。
  it('adds ws: and wss: to the connect-src of the PASS_EXCEPT_DELETE policy only', () => {
    expect(WORKER_CONNECT_POLICY).toBe('connect-src http: https: data: blob:');
    expect(AUDIT_SEND_CONNECT_POLICY).toBe('connect-src http: https: data: blob: ws: wss:');
    expect(connectPolicyInitScriptOf(WORKER_CONNECT_POLICY)).toBe(WORKER_CONNECT_POLICY_INIT_SCRIPT);
    expect(connectPolicyInitScriptOf(AUDIT_SEND_CONNECT_POLICY)).toContain(JSON.stringify(AUDIT_SEND_CONNECT_POLICY));
    expect(WORKER_CONNECT_POLICY_INIT_SCRIPT).not.toContain('ws:');
  });

  it('adds AUDIT_SEND_OVER_LIMIT to the blocked WebSocket reasons', () => {
    expect(BLOCKED_WEBSOCKET_REASONS).toContain('AUDIT_SEND_OVER_LIMIT');
  });

  it('accepts the WebSocket limit of the Guard option up to the named constant', () => {
    const valid: GuardAuditSend = { policy: 'PASS_EXCEPT_DELETE', approvedServiceOrigins: [], dangerousTerms: DANGEROUS_TERMS };
    expect(AUDIT_SEND_MAX_WEBSOCKETS_PER_CONTEXT).toBe(10);
    expect(isGuardAuditSend({ ...valid, maxWebSocketsPerContext: 1 })).toBe(true);
    expect(isGuardAuditSend({ ...valid, maxWebSocketsPerContext: AUDIT_SEND_MAX_WEBSOCKETS_PER_CONTEXT })).toBe(true);
    expect(isGuardAuditSend({ ...valid, maxWebSocketsPerContext: AUDIT_SEND_MAX_WEBSOCKETS_PER_CONTEXT + 1 })).toBe(false);
    expect(isGuardAuditSend({ ...valid, maxWebSocketsPerContext: 0 })).toBe(false);
  });
});

describe('AS-c: run.json, the view model and the surfaces', () => {
  const passingLedger = (): SafetyLedger => {
    const ledger = new SafetyLedger();
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${APP_ORIGIN}/api/save`, otherOrigin: false });
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${OTHER_ORIGIN}/collect`, otherOrigin: true });
    ledger.recordPassedAuditSendWebSocket({ url: 'wss://example.com/realtime' });
    return ledger;
  };

  it('sums the passed requests to another Origin and the passed WebSocket connections in safety.auditSend', () => {
    const summary = summarizeRunSafety({ guardEnabled: true, snapshots: [passingLedger().snapshot(), passingLedger().snapshot()], auditSendPolicy: 'PASS_EXCEPT_DELETE' });
    expect(summary.auditSend).toEqual({
      policy: 'PASS_EXCEPT_DELETE', passedRequests: 4, passedRequestsByMethod: { POST: 4 }, passedOtherOriginRequests: 2, passedWebSockets: 2,
      // AS-c fix round 1: 印のない接続だけなので 0。
      passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0,
    });
  });

  it('builds the counts into the view model (0 for a Run without them) and shows them on the HTML report and the CLI result', () => {
    const auditSend = { policy: 'PASS_EXCEPT_DELETE', passedRequests: 4, passedRequestsByMethod: { POST: 4 }, passedOtherOriginRequests: 2, passedWebSockets: 3 } as const;
    const model = buildReportViewModel(auditRun({ run: { safety: { ...runSummary().safety, auditSend } } }));
    // AS-c fix round 1: 印の数を持たない Run は 0 と読み、知らせは出さない。
    expect(model.summary.auditSend).toEqual({
      ...auditSend, prominent: true, passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0, webSocketCaution: false,
    });
    const old = buildReportViewModel(auditRun({
      run: { safety: { ...runSummary().safety, auditSend: { policy: 'PASS_EXCEPT_DELETE', passedRequests: 1, passedRequestsByMethod: { POST: 1 } } } },
    }));
    expect(old.summary.auditSend).toMatchObject({ passedOtherOriginRequests: 0, passedWebSockets: 0 });
    const detail = AUDIT_SEND_TEXT.passedDetail(formatCount(2), formatCount(3));
    expect(renderHtmlReport(model)).toContain(detail);
    expect(runSummaryLines(model.summary, 'output/RUN-1')).toContain(detail);
    expect(renderHtmlReport(buildReportViewModel(auditRun()))).not.toContain(AUDIT_SEND_TEXT.passedDetail('', '').slice(0, 4));
  });
});

describe('AS-c: the Safety Ledger records of the wider passes', () => {
  it('counts the passed requests to another Origin', () => {
    const ledger = new SafetyLedger();
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${APP_ORIGIN}/api/save`, otherOrigin: false });
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${OTHER_ORIGIN}/collect?id=${MARKER}`, otherOrigin: true });
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${OTHER_ORIGIN}/collect`, otherOrigin: true });
    expect(ledger.snapshot().passedAuditSendRequests).toMatchObject({ count: 3, otherOrigins: 2 });
    expect(JSON.stringify(ledger.snapshot())).not.toContain(MARKER);
  });

  it('records the shape of the passed WebSocket connections (Origin, path, count) without the query, and puts it in the Evidence', () => {
    const ledger = new SafetyLedger();
    expect(ledger.snapshot().passedAuditSendWebSockets).toBeUndefined();
    ledger.recordPassedAuditSendWebSocket({ url: `wss://example.com/realtime/v1/websocket?apikey=${MARKER}&vsn=1.0.0` });
    ledger.recordPassedAuditSendWebSocket({ url: 'wss://example.com/realtime/v1/websocket' });
    ledger.recordPassedAuditSendWebSocket({ url: 'ws://127.0.0.1:9/socket' });
    ledger.recordPassedAuditSendWebSocket({ url: 'not a url' });
    const snapshot = ledger.snapshot();
    expect(snapshot.passedAuditSendWebSockets).toEqual({
      count: 4,
      connections: [
        { origin: 'wss://example.com', path: '/realtime/v1/websocket', count: 2 },
        { origin: 'ws://127.0.0.1:9', path: '/socket', count: 1 },
      ],
      unlisted: 1,
      outsideGuard: 0,
      dangerous: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain(MARKER);
    expect(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'PAGE_AUDIT' }).passedAuditSendWebSockets).toEqual(snapshot.passedAuditSendWebSockets);
    expect(snapshot.recordLimits.truncated).toBe(false);
  });
});
