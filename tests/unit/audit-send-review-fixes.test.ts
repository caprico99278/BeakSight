// AS-c fix round 1（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 5 章の「AS-R … とユーザーの判断」の行）: 独立レビュー（AS-R）の指摘の直し
// のうち、判定と記録の部品で確かめられるもの。既定の `READ_ONLY`（口のない判定）は変えない。
// - I-2: method の上書き（ヘッダ `X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override`、form の本文の `_method`）が `DELETE` なら、通さない
//   （`DELETE` と同じ `NON_READ_METHOD`）。判定は `classifyPassiveRequest` の 1 か所。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import { runSummaryLines } from '../../src/cli/output.js';
import type { AuditConfig } from '../../src/config/types.js';
import { hasAuditSendWebSocketCaution } from '../../src/core/audit-send-policy.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import { formatCount } from '../../src/presentation/format.js';
import { AUDIT_SEND_TEXT } from '../../src/presentation/messages.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { MAX_WRITE_PAYLOAD_BYTES, formMethodOverrideValuesOf } from '../../src/safety/write-payload-policy.js';
import { auditRun, runSummary } from '../helpers/audit-run-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';
import {
  classifyPassiveRequest,
  type AuditSendPolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
  type RequestSentContent,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://example.com';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const DANGEROUS_TERMS = Object.freeze(['logout', 'delete', 'remove', 'cancel']);

const auditSend = (): AuditSendPolicy => ({
  approvedServiceOrigins: [],
  dangerousTerms: DANGEROUS_TERMS,
  remainingPasses: 1,
  remainingWebSockets: 1,
});

/**
 * 送る中身（ヘッダと本文。Guard と同じく、本文の欄は owner の `formMethodOverrideValuesOf` で読む。本文を読んだ回数を数える）。`body` が `null` なら本文なし、
 * `undefined` なら読めない本文。
 */
const content = (headers: Record<string, string>, body?: string | null): RequestSentContent & { readonly reads: () => number } => {
  let reads = 0;
  const readBody = (): { readonly kind: 'NONE' } | { readonly kind: 'TEXT'; readonly text: string } | { readonly kind: 'UNREADABLE' } => {
    reads += 1;
    if (body === null) return { kind: 'NONE' };
    return body === undefined ? { kind: 'UNREADABLE' } : { kind: 'TEXT', text: body };
  };
  return {
    headers,
    formMethodOverrides: () => formMethodOverrideValuesOf(headers, readBody),
    reads: () => reads,
  };
};

const facts = (method: string, url: string, sentContent?: RequestSentContent): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch', ...(sentContent === undefined ? {} : { sentContent }) });

const decide = (request: HttpRequestFacts, policy: PassiveRequestPolicyOptions = { auditSend: auditSend() }): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, policy);

const PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };
const NON_READ = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
const URLENCODED = { 'content-type': 'application/x-www-form-urlencoded' };
const BOUNDARY = 'boundary-1234';
const multipart = (fields: readonly (readonly [string, string])[]): string =>
  `${fields.map(([name, value]) => `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join('')}--${BOUNDARY}--\r\n`;
const MULTIPART = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` };

describe('AS-c fix round 1 (I-2): a method override to DELETE with PASS_EXCEPT_DELETE', () => {
  it('blocks the override headers whose value is DELETE in any case, also to another Origin', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({ 'X-HTTP-Method-Override': 'DELETE' })))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({ 'x-http-method': 'delete' })))).toEqual(NON_READ);
    expect(decide(facts('PUT', `${OTHER_ORIGIN}/api/item`, content({ 'X-Method-Override': ' Delete ' })))).toEqual(NON_READ);
  });

  it('blocks a urlencoded or multipart form body whose _method is DELETE in any case', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(URLENCODED, 'name=a&_method=DELETE')))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content({ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, '_method=delete')))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(MULTIPART, multipart([['name', 'a'], ['_method', 'Delete']]))))).toEqual(NON_READ);
  });

  it('blocks a form body that cannot be read or a broken multipart body (fail-closed)', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(URLENCODED, undefined)))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(MULTIPART, undefined)))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(MULTIPART, 'not a multipart body')))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content({ 'content-type': 'multipart/form-data' }, multipart([['name', 'a']]))))).toEqual(NON_READ);
  });

  it('passes other overrides and bodies, and reads the body only for a form', () => {
    // AS-c fix round 2: `Content-Type` のない本文は urlencoded として読むので、本文なし（`null`）で確かめる。
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({ 'X-HTTP-Method-Override': 'PUT' }, null)))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(URLENCODED, 'name=a&_method=patch')))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(MULTIPART, multipart([['note', 'DELETE'], ['_method', 'put']]))))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(URLENCODED, null)))).toEqual(PASSED);
    // urlencoded は、ページのスクリプトが書く本文として緩く読む（percent-encode していない文字、`=` のない組）。
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(URLENCODED, 'name=日本&flag&_method=put')))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/items/1`, content(URLENCODED, 'name=日本&flag&%5Fmethod=DELETE')))).toEqual(NON_READ);
    // 本文を読むのは、form・JSON・`Content-Type` のない本文だけ。
    const plain = content({ 'content-type': 'text/plain' }, '_method=DELETE');
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, plain))).toEqual(PASSED);
    expect(plain.reads()).toBe(0);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`))).toEqual(PASSED);
  });

  // AS-c fix round 2（I-E。設計書 5 章の「AS-R2」の行）: `Content-Type` のない本文は urlencoded として読み、JSON の本文は最上位の `_method` を見る。
  it('reads a body without Content-Type as urlencoded (AS-R2 A26)', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({}, '_method=DELETE')))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({}, 'a=1&_method=put')))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({}, null)))).toEqual(PASSED);
  });

  it('reads the top level _method of a JSON body (AS-R2 A27)', () => {
    const json = (body: string, type = 'application/json'): RequestSentContent => content({ 'Content-Type': type }, body);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, json('{"_method":"DELETE"}')))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, json('{"name":"a","_METHOD":" delete "}', 'application/vnd.api+json; charset=utf-8')))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, json('{"_method":"PUT","name":"a"}')))).toEqual(PASSED);
    // 入れ子の `_method`、配列、JSON でない本文は、上書きとして読まない（サーバも最上位の鍵だけを上書きとして読む）。
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, json('{"item":{"_method":"DELETE"}}')))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, json('[{"_method":"DELETE"}]')))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, json('not json')))).toEqual(PASSED);
    // 読めない JSON の本文は止める（form と同じ fail-closed）。
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({ 'content-type': 'application/json' }, undefined)))).toEqual(NON_READ);
  });

  // AS-c fix round 3（AS-R3 の V04・V05。設計書 5 章の「AS-R3 と区切り」の行）: 上限（1 MiB）を超える本文は、本文の `_method` を調べずに通す（ヘッダの上書き・
  // method・語は今どおり調べる）。
  it('passes a body over the limit without reading its _method, and keeps checking the override headers', () => {
    const pad = 'x'.repeat(MAX_WRITE_PAYLOAD_BYTES);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({ 'content-type': 'application/json' }, `{"pad":"${pad}","_method":"DELETE"}`)))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({}, `pad=${pad}&_method=DELETE`)))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content(URLENCODED, `pad=${pad}&_method=DELETE`)))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({ 'X-HTTP-Method-Override': 'DELETE' }, `pad=${pad}`)))).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/logout`, content({}, `pad=${pad}`)))).toEqual(NON_READ);
  });

  it('does not change the decision without the option (READ_ONLY)', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/api/item`, content({ 'X-HTTP-Method-Override': 'PUT' })), {})).toEqual(NON_READ);
    expect(decide(facts('GET', `${APP_ORIGIN}/page`, content({ 'X-HTTP-Method-Override': 'DELETE' })), {}))
      .toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
  });
});

// M-1（設計書 5 章の「AS-c fix round 1 の Blocker」の行）: `sign_out`・`log_out` は、`auditSendOptionsOf` が Guard に渡す送信の扱いの危険な語にだけ足す
// （`DEFAULT_EXCLUDED_URL_WORDS` は checkpoint の digest・認証の設定の検証・READ の path の検証に結ばれているので変えない）。
describe('AS-c fix round 1 (M-1): the dangerous words of the audit send policy', () => {
  const passingConfig = (): AuditConfig => {
    const config = createTestConfig('http://127.0.0.1:4173');
    return { ...config, audit: { ...config.audit, sendPolicy: 'PASS_EXCEPT_DELETE' } };
  };

  it('adds sign_out and log_out to the words given to the Guard, without changing the default list', () => {
    const terms = auditSendOptionsOf(passingConfig(), []).auditSend?.dangerousTerms ?? [];
    expect(terms).toEqual([...DEFAULT_EXCLUDED_URL_WORDS, 'sign_out', 'log_out']);
    expect(DEFAULT_EXCLUDED_URL_WORDS).not.toContain('sign_out');
    expect(DEFAULT_EXCLUDED_URL_WORDS).not.toContain('log_out');
  });

  it('blocks a request whose path has sign_out or log_out with the words of the option', () => {
    const terms = auditSendOptionsOf(passingConfig(), []).auditSend?.dangerousTerms ?? [];
    const policy: PassiveRequestPolicyOptions = { auditSend: { ...auditSend(), dangerousTerms: terms } };
    expect(decide(facts('POST', `${APP_ORIGIN}/api/sign_out`), policy)).toEqual(NON_READ);
    expect(decide(facts('POST', `${OTHER_ORIGIN}/users/Log_Out`), policy)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/save`), policy)).toEqual(PASSED);
  });
});

// C-1・C-2（ユーザーの判断: 限界として受け入れ、検知だけ足す）: 通した接続の記録は、ブラウザが実際に開いた接続から作り、Guard の route を通らずに開いた接続と、
// 危険な語の接続に印を付ける。`run.json`・報告・CLI に、その数を出す（表示用モデルを通す）。
describe('AS-c fix round 1 (C-1, C-2): the marks of the opened WebSocket connections', () => {
  const markedLedger = (): SafetyLedger => {
    const ledger = new SafetyLedger();
    ledger.recordPassedAuditSendWebSocket({ url: 'wss://example.com/realtime', outsideGuard: false, dangerous: false });
    ledger.recordPassedAuditSendWebSocket({ url: 'wss://example.com/realtime', outsideGuard: true, dangerous: false });
    ledger.recordPassedAuditSendWebSocket({ url: 'wss://example.com/logout?token=marker-value', outsideGuard: true, dangerous: true });
    ledger.recordPassedAuditSendWebSocket({ url: 'not a url', outsideGuard: true, dangerous: true });
    return ledger;
  };

  it('records the marked connections in their own rows and counts the marks (also for the unlisted ones)', () => {
    const snapshot = markedLedger().snapshot();
    expect(snapshot.passedAuditSendWebSockets).toEqual({
      count: 4,
      connections: [
        { origin: 'wss://example.com', path: '/realtime', count: 1 },
        { origin: 'wss://example.com', path: '/realtime', count: 1, outsideGuard: true },
        { origin: 'wss://example.com', path: '/logout', count: 1, outsideGuard: true, dangerous: true },
      ],
      unlisted: 1,
      outsideGuard: 3,
      dangerous: 2,
    });
    expect(JSON.stringify(snapshot)).not.toContain('marker-value');
  });

  it('sums the marks into safety.auditSend of run.json', () => {
    const summary = summarizeRunSafety({ guardEnabled: true, snapshots: [markedLedger().snapshot(), markedLedger().snapshot()], auditSendPolicy: 'PASS_EXCEPT_DELETE' });
    expect(summary.auditSend).toMatchObject({ passedWebSockets: 8, passedWebSocketsOutsideGuard: 6, passedDangerousWebSockets: 4 });
    const empty = summarizeRunSafety({ guardEnabled: true, snapshots: [], auditSendPolicy: 'READ_ONLY' });
    expect(empty.auditSend).toMatchObject({ passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0 });
  });

  it('shows the caution on the HTML report and the CLI result only when a marked connection was opened', () => {
    const base = { policy: 'PASS_EXCEPT_DELETE', passedRequests: 1, passedRequestsByMethod: { POST: 1 }, passedOtherOriginRequests: 0, passedWebSockets: 3 } as const;
    const marked = buildReportViewModel(auditRun({
      run: { safety: { ...runSummary().safety, auditSend: { ...base, passedWebSocketsOutsideGuard: 2, passedDangerousWebSockets: 1 } } },
    }));
    expect(marked.summary.auditSend).toMatchObject({ passedWebSocketsOutsideGuard: 2, passedDangerousWebSockets: 1 });
    const caution = AUDIT_SEND_TEXT.webSocketCaution(formatCount(2), formatCount(1));
    expect(renderHtmlReport(marked)).toContain(caution);
    expect(runSummaryLines(marked.summary, 'output/RUN-1')).toContain(caution);
    // 印の数を持たない Run（AS-c fix round 1 の前）と、印のある接続のない Run は 0 と読み、知らせを出さない。
    const old = buildReportViewModel(auditRun({ run: { safety: { ...runSummary().safety, auditSend: base } } }));
    expect(old.summary.auditSend).toMatchObject({ passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0 });
    const [head = ''] = AUDIT_SEND_TEXT.webSocketCaution('<count>', '<count>').split('<count>');
    expect(renderHtmlReport(old)).not.toContain(head);
    expect(runSummaryLines(old.summary, 'output/RUN-1').join('\n')).not.toContain(head);
  });

  it('decides whether to show the caution in one place', () => {
    expect(hasAuditSendWebSocketCaution({})).toBe(false);
    expect(hasAuditSendWebSocketCaution({ passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0 })).toBe(false);
    expect(hasAuditSendWebSocketCaution({ passedWebSocketsOutsideGuard: 1, passedDangerousWebSockets: 0 })).toBe(true);
    expect(hasAuditSendWebSocketCaution({ passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 1 })).toBe(true);
  });
});
