// T35c（Task 35 の設計書 3.4。T35a の設計者の判断）: 承認したサービスの Origin への要求の上限に届いて止めた Run の、実行の終わり方と保存の終わり方。
// - 理由 `SERVICE_REQUEST_LIMIT_REACHED` の SKIPPED がある実行は `STOPPED_BY_SERVICE_REQUEST_LIMIT`（サイトの不調で止めた前例と同じ。違反とサイトの
//   不調とセッションの切れの後、実行時間の上限と止める印の前）。保存の状態は `STOPPED`（再開できる）。
// - 再開のときは、この理由の SKIPPED の URL を待ち行列に戻す（`RESUME_REQUEUE_SKIP_REASON_CODES`）。再開は新しい予算で数える（Run の側）。
// - 表示のカタログに、終わり方の文言がある（core の一覧の並びの最後）。
import { describe, expect, it } from 'vitest';
import { RUN_EXECUTION_END_REASONS } from '../../src/core/contracts.js';
import {
  RESUME_REQUEUE_SKIP_REASON_CODES,
  decideRunCheckpointConclusion,
  decideRunExecutionEndReason,
} from '../../src/orchestration/run-checkpoint.js';
import { RUN_EXECUTION_END_REASON_CATALOG } from '../../src/presentation/catalog.js';

describe('T35c: the execution stopped by the service request limit', () => {
  const skipReasonCodes = new Set(['SERVICE_REQUEST_LIMIT_REACHED'] as const);

  it('ends the execution with STOPPED_BY_SERVICE_REQUEST_LIMIT, after the safety, the site and the session reasons', () => {
    expect(decideRunExecutionEndReason({ runStatus: 'PARTIAL', skipReasonCodes })).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    expect(decideRunExecutionEndReason({ runStatus: 'ABORTED_BY_SAFETY', skipReasonCodes })).toBe('STOPPED_BY_SAFETY_VIOLATION');
    expect(decideRunExecutionEndReason({ runStatus: 'PARTIAL', skipReasonCodes: new Set(['SITE_UNAVAILABLE', 'SERVICE_REQUEST_LIMIT_REACHED'] as const) }))
      .toBe('STOPPED_BY_SITE_UNAVAILABLE');
    expect(decideRunExecutionEndReason({ runStatus: 'PARTIAL', skipReasonCodes: new Set(['AUTH_SESSION_LOST', 'SERVICE_REQUEST_LIMIT_REACHED'] as const) }))
      .toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(decideRunExecutionEndReason({
      runStatus: 'PARTIAL', skipReasonCodes: new Set(['SERVICE_REQUEST_LIMIT_REACHED', 'MAX_RUNTIME_REACHED', 'RUN_INTERRUPTED'] as const),
    })).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
  });

  it('keeps the checkpoint STOPPED (resumable), and requeues the skipped URLs on resume', () => {
    expect(decideRunCheckpointConclusion({
      sessionStarted: true,
      runStatus: 'PARTIAL',
      skipReasonCodes,
      checkpointWriteFailed: false,
      resumed: false,
      preflightFailed: false,
      hasWrittenCheckpoint: true,
    })).toMatchObject({ action: 'FINISH', state: 'STOPPED' });
    expect(RESUME_REQUEUE_SKIP_REASON_CODES).toContain('SERVICE_REQUEST_LIMIT_REACHED');
  });

  it('has the end reason in the closed list and the catalog', () => {
    expect(RUN_EXECUTION_END_REASONS.at(-1)).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    expect(RUN_EXECUTION_END_REASON_CATALOG.STOPPED_BY_SERVICE_REQUEST_LIMIT).toMatchObject({ tone: 'caution', order: RUN_EXECUTION_END_REASONS.length });
  });
});
