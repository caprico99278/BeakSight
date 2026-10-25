/**
 * T44e（Task 44 の設計書 P2-7。測りの記録 `T44a-baseline.md` の 3.3）: ジョブの画面の「終わり方と理由」。理由の説明は今の表示のカタログ（作り直さない）、
 * 次にできることは `LOCAL_UI_JOB_NEXT_STEPS`（画面の操作を書く文。Run の理由に載せていないものは、HTML レポートと同じ `INCOMPLETE_REASON_NEXT_STEPS`）。
 * - 監査（`RunEndReasons`）: Run の状態の次にできること、最後の実行の終わり方（ラベル・説明・次にできること）、Run の全体の理由（説明・次にできること）、
 *   終えられなかったページの数とページごとの理由の置き場所（HTML レポート。`audit.json` は大きいので、この画面では読まない）。
 * - 発見と READ の確かめ（`ProfileJobEndReason`）: 終わり方（ラベル・説明・次にできること）。
 */
// PRE42-CC 組 UI-K（N4-8f）: ジョブの種類の値は、管理データと Node の部品に触れない純粋な owner から読む（文字列で比べない）。
import { WORKER_DISCOVERY_JOB_KIND } from '../../../../src/core/audit-job-values.js';
import type { RunStatus } from '../../../../src/core/contracts.js';
import { formatCount } from '../../../../src/presentation/format.js';
import { INCOMPLETE_REASON_DESCRIPTIONS, LOCAL_UI_JOB_END_TEXT, LOCAL_UI_JOB_NEXT_STEPS } from '../../../../src/presentation/messages.js';
import {
  discoveryEndReasonDisplay,
  readCheckEndReasonDisplay,
  runExecutionEndReasonDisplay,
  runReasonNextStepOf,
  toneClass,
} from '../display/labels';
import type { AuditJobProfileJobEndView, AuditJobRunEndView } from '../server/audit-job-functions';

const text = LOCAL_UI_JOB_END_TEXT;
const steps = LOCAL_UI_JOB_NEXT_STEPS;

/** 次にできること（なければ出さない）。 */
function NextStep({ value, testId }: Readonly<{ value: string | null; testId: string }>) {
  return value === null ? null : (
    <p data-testid={testId}>
      <strong>{text.nextStep}</strong>
      {': '}
      {value}
    </p>
  );
}

export function RunEndReasons({ runEnd, runStatus }: Readonly<{ runEnd: AuditJobRunEndView; runStatus: RunStatus | null }>) {
  const execution = runEnd.lastExecutionEndReason === null ? null : runExecutionEndReasonDisplay(runEnd.lastExecutionEndReason);
  const unfinishedPages = runEnd.partialPageCount + runEnd.failedPageCount + runEnd.skippedPageCount;
  return (
    <section className="panel" data-testid="job-run-end">
      <h2 className="panel-heading">{text.heading}</h2>
      {runStatus === null ? null : <NextStep value={steps.runStatuses[runStatus]} testId="job-run-status-next" />}
      {execution === null || runEnd.lastExecutionEndReason === null ? null : (
        <>
          <dl className="facts">
            <dt>{text.executionEnd}</dt>
            <dd>
              <span className={toneClass(execution.tone)} data-testid="job-run-execution-end" data-end-reason={runEnd.lastExecutionEndReason}>
                {execution.label}
              </span>
            </dd>
          </dl>
          {execution.description === null ? null : <p>{execution.description}</p>}
          <NextStep value={steps.runExecutionEndReasons[runEnd.lastExecutionEndReason]} testId="job-run-execution-next" />
        </>
      )}
      {runEnd.reasons.length === 0 ? null : (
        <>
          <h3>{text.reasons}</h3>
          <ul data-testid="job-run-reasons">
            {runEnd.reasons.map((code) => (
              <li key={code} data-testid="job-run-reason" data-reason={code}>
                <p>{INCOMPLETE_REASON_DESCRIPTIONS[code]}</p>
                <NextStep value={runReasonNextStepOf(code)} testId="job-run-reason-next" />
              </li>
            ))}
          </ul>
        </>
      )}
      {unfinishedPages === 0 ? null : (
        <p className="muted" data-testid="job-run-page-reasons">
          {text.pageReasons(formatCount(runEnd.partialPageCount), formatCount(runEnd.failedPageCount), formatCount(runEnd.skippedPageCount))}
        </p>
      )}
    </section>
  );
}

export function ProfileJobEndReason({ end }: Readonly<{ end: AuditJobProfileJobEndView }>) {
  const display = end.kind === WORKER_DISCOVERY_JOB_KIND ? discoveryEndReasonDisplay(end.endReason) : readCheckEndReasonDisplay(end.endReason);
  const next = end.kind === WORKER_DISCOVERY_JOB_KIND ? steps.discoveryEndReasons[end.endReason] : steps.readCheckEndReasons[end.endReason];
  return (
    <section className="panel" data-testid="job-profile-job-end">
      <h2 className="panel-heading">{text.heading}</h2>
      <dl className="facts">
        <dt>{text.endReason}</dt>
        <dd>
          <span className={toneClass(display.tone)} data-testid="job-end-reason" data-reason={end.endReason}>{display.label}</span>
        </dd>
      </dl>
      {display.description === null ? null : <p>{display.description}</p>}
      <NextStep value={next} testId="job-end-reason-next" />
    </section>
  );
}
