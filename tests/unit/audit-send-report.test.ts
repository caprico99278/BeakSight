// AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3、受け入れ条件 5）: 監査の段の送信の扱いの記録と表示。
// - ページの記録: Safety Ledger の通した要求の記録（`passedAuditSendRequests`。method・Origin・path・回数だけ）を、止めた要求と同じく Safety の Evidence に出す
//   （1 件でも通したときだけ。値は持たない）。
// - `run.json` の `safety.auditSend`: 実効の扱いと、通した数（総数と method ごと）。Run の Safety の集計の 1 か所（`summarizeRunSafety`）で、Ledger の snapshot から数える。
//   任意の項目（持たない古い `run.json` は `READ_ONLY` と読む）。
// - 表示: 表示用モデルの `summary.auditSend` を 1 回だけ組み立て、HTML・CLI・ChatGPT 用バンドルは、それを描くだけ。目立つ形で出すかは表示カタログ
//   （`AUDIT_SEND_POLICY_CATALOG` の `prominent`）が決める（`PASS_EXCEPT_DELETE` だけ）。文言はカタログ（`AUDIT_SEND_TEXT`）。
import { describe, expect, it } from 'vitest';
import { runSummaryLines } from '../../src/cli/output.js';
import type { RunSafetySummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { summarizeRunSafety } from '../../src/orchestration/run-aggregation.js';
import { AUDIT_SEND_POLICY_CATALOG } from '../../src/presentation/catalog.js';
import { formatCount } from '../../src/presentation/format.js';
import { AUDIT_SEND_TEXT } from '../../src/presentation/messages.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';
import { auditRun, runSummary } from '../helpers/audit-run-fixture.js';

const ORIGIN = 'http://127.0.0.1:4173';
const MARKER = 'marker-value-should-not-appear';
/** 値に見える path の区切り（32 字の 16 進。Ledger が伏せる。`src/core/url-path-redaction.ts` の (b)）。 */
const VALUE_LIKE_SEGMENT = '0123456789abcdef0123456789abcdef';

/** 通した要求を記録した Ledger（query の値と、値に見える path の区切りに目印を入れる）。 */
const passingLedger = (): SafetyLedger => {
  const ledger = new SafetyLedger();
  ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${ORIGIN}/api/save?token=${MARKER}` });
  ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${ORIGIN}/api/save` });
  ledger.recordPassedAuditSendRequest({ method: 'put', url: `${ORIGIN}/api/items/${VALUE_LIKE_SEGMENT}?name=${MARKER}` });
  return ledger;
};

/** 知らせの文の、件数の前まで（出ていないことを確かめる）。 */
const NOTICE_PREFIX = 'この監査では、ページが出す送信のうち削除のほかを通した';

/** AS-c: ほかの Origin へ通した数と、通した WebSocket の接続の数も持つ。AS-c fix round 1: Guard の判定を通らずに開いた接続と危険な語の接続の数も持つ。 */
const READ_ONLY_SUMMARY = {
  policy: 'READ_ONLY',
  passedRequests: 0,
  passedRequestsByMethod: {},
  passedOtherOriginRequests: 0,
  passedWebSockets: 0,
  passedWebSocketsOutsideGuard: 0,
  passedDangerousWebSockets: 0,
} as const;

const safetyWith = (auditSend: RunSafetySummary['auditSend']): RunSafetySummary => ({
  ...runSummary().safety,
  ...(auditSend === undefined ? {} : { auditSend }),
});

describe('AS-b: the passed requests in the page record (Safety Evidence)', () => {
  it('puts the record of the passed requests into the Safety Evidence without any value, only when there is one', () => {
    const snapshot = passingLedger().snapshot();
    const evidence = safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'PAGE_AUDIT' });
    expect(evidence.passedAuditSendRequests).toEqual(snapshot.passedAuditSendRequests);
    expect(evidence.passedAuditSendRequests?.count).toBe(3);
    expect(JSON.stringify(evidence)).not.toContain(MARKER);
    expect(JSON.stringify(evidence)).not.toContain(VALUE_LIKE_SEGMENT);
    expect('passedAuditSendRequests' in safetyEventsEvidenceFromSnapshot(new SafetyLedger().snapshot(), 'PASSIVE', { kind: 'PAGE_AUDIT' })).toBe(false);
  });
});

describe('AS-b: safety.auditSend of run.json (summarizeRunSafety)', () => {
  it('records the policy and the number of passed requests (in total and by method) from the snapshots', () => {
    const snapshots = [passingLedger().snapshot(), new SafetyLedger().snapshot(), passingLedger().snapshot()];
    expect(summarizeRunSafety({ guardEnabled: true, snapshots, auditSendPolicy: 'PASS_EXCEPT_DELETE' }).auditSend).toEqual({
      policy: 'PASS_EXCEPT_DELETE',
      passedRequests: 6,
      passedRequestsByMethod: { POST: 4, PUT: 2 },
      // AS-c: 渡さなかった要求はほかの Origin に数えない。WebSocket の接続はない。
      passedOtherOriginRequests: 0,
      passedWebSockets: 0,
      passedWebSocketsOutsideGuard: 0,
      passedDangerousWebSockets: 0,
    });
    expect(summarizeRunSafety({ guardEnabled: true, snapshots: [new SafetyLedger().snapshot()], auditSendPolicy: 'READ_ONLY' }).auditSend)
      .toEqual(READ_ONLY_SUMMARY);
  });

  it('is an optional item of run.json with the listed policies only', async () => {
    const passing = { policy: 'PASS_EXCEPT_DELETE', passedRequests: 2, passedRequestsByMethod: { POST: 2 } } as const;
    expect((await validateArtifact('run', runSummary())).ok).toBe(true);
    expect((await validateArtifact('run', runSummary({ safety: safetyWith(passing) }))).ok).toBe(true);
    expect((await validateArtifact('run', runSummary({ safety: safetyWith(READ_ONLY_SUMMARY) }))).ok).toBe(true);
    for (const broken of [
      { ...passing, policy: 'PASS_ALL' },
      { ...passing, passedRequests: -1 },
      { ...passing, extra: 1 },
      { policy: 'PASS_EXCEPT_DELETE', passedRequests: 2 },
    ]) {
      expect((await validateArtifact('run', runSummary({ safety: safetyWith(broken as never) }))).ok, JSON.stringify(broken)).toBe(false);
    }
  });
});

describe('AS-b: the view model and the three surfaces', () => {
  const passingRun = () => auditRun({
    run: { safety: safetyWith({ policy: 'PASS_EXCEPT_DELETE', passedRequests: 3, passedRequestsByMethod: { POST: 2, PATCH: 1 } }) },
  });
  const notice = `${AUDIT_SEND_TEXT.passedNotice(formatCount(3))}`;

  it('marks PASS_EXCEPT_DELETE only as prominent in the display catalog', () => {
    expect(AUDIT_SEND_POLICY_CATALOG.PASS_EXCEPT_DELETE.prominent).toBe(true);
    expect(AUDIT_SEND_POLICY_CATALOG.READ_ONLY.prominent).toBe(false);
    expect(notice).toBe('この監査では、ページが出す送信のうち削除のほかを通した（3件）');
  });

  it('builds summary.auditSend once from run.json, reading a run without the item as READ_ONLY', () => {
    expect(buildReportViewModel(passingRun()).summary.auditSend).toEqual({
      policy: 'PASS_EXCEPT_DELETE',
      prominent: true,
      passedRequests: 3,
      passedRequestsByMethod: { POST: 2, PATCH: 1 },
      // AS-c: 持たない Run（AS-c の前）は 0 と読む。
      passedOtherOriginRequests: 0,
      passedWebSockets: 0,
      passedWebSocketsOutsideGuard: 0,
      passedDangerousWebSockets: 0,
      webSocketCaution: false,
    });
    expect(buildReportViewModel(auditRun()).summary.auditSend).toEqual({ ...READ_ONLY_SUMMARY, prominent: false, webSocketCaution: false });
  });

  it('shows the notice in the HTML report and the CLI result only for PASS_EXCEPT_DELETE', () => {
    const passingModel = buildReportViewModel(passingRun());
    const readOnlyModel = buildReportViewModel(auditRun());
    const passingHtml = renderHtmlReport(passingModel);
    expect(passingHtml).toContain(notice);
    expect(passingHtml).toContain(AUDIT_SEND_POLICY_CATALOG.PASS_EXCEPT_DELETE.label);
    expect(passingHtml).toContain('PATCH');
    const readOnlyHtml = renderHtmlReport(readOnlyModel);
    expect(readOnlyHtml).not.toContain(NOTICE_PREFIX);
    expect(readOnlyHtml).toContain(AUDIT_SEND_POLICY_CATALOG.READ_ONLY.label);
    expect(runSummaryLines(passingModel.summary, 'output/RUN-1')).toContain(notice);
    expect(runSummaryLines(readOnlyModel.summary, 'output/RUN-1').join('\n')).not.toContain(NOTICE_PREFIX);
  });
});
