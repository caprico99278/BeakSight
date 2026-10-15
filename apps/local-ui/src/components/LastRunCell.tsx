import { Link } from '@tanstack/react-router';
import { LOCAL_UI_AUDIT_TEXT } from '../../../../src/presentation/messages.js';
import { auditJobStateDisplay, runStatusDisplay, toneClass } from '../display/labels';
import type { AuditJobRowView } from '../server/audit-job-functions';

/**
 * プロファイルの一覧の「最後の Run」の欄（Task 24 の設計書 4.8。T24f）。最後のジョブの状態と、Run の状態（あれば）を、表示カタログの
 * ラベルで示し、ジョブの詳細へのリンクを置く。ジョブがなければ「まだ実行していません」。
 */
export function LastRunCell({ job }: Readonly<{ job: AuditJobRowView | null }>) {
  if (job === null) {
    return <span className="muted">{LOCAL_UI_AUDIT_TEXT.profileList.lastRunNone}</span>;
  }
  const state = auditJobStateDisplay(job.state);
  const runStatus = job.runStatus === null ? null : runStatusDisplay(job.runStatus);
  return (
    <span className="badge-row">
      <span className={toneClass(state.tone)} data-testid="last-run-state">{state.label}</span>
      {runStatus === null ? null : <span className={toneClass(runStatus.tone)} data-testid="last-run-status">{runStatus.label}</span>}
      <Link to="/jobs/$jobId" params={{ jobId: job.jobId }}>{LOCAL_UI_AUDIT_TEXT.profileList.lastRunDetail}</Link>
    </span>
  );
}
