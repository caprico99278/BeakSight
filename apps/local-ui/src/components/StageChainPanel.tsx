/**
 * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の画面の部品。
 * - PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3）: 開始の画面の「まとめて実行する」の欄（前の `StageChainStart`）はなくした（開始の
 *   画面の主のボタン「点検を始める」が、まとめて実行を始める）。PL-2 の持ち越し: 「画面のサーバが動いている間だけ出ます」の技術の文は出さない。
 * - OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 作業の画面の「まとめて実行」の欄（状態・ステップの一覧・「まとめて実行をやめる」）は、
 *   要点のパネルにまとめた。止めるボタンは、要点の二次のボタン「点検を止める」の 1 つだけ（まとめて実行の段を止めると、ジョブの管理が連鎖の全体を止める。
 *   `audit-job-manager.ts` の `#requestStop`）。
 *   - `StageChainStopNotice`: 要点のパネルの中の、止まった理由と次にできること（止まったときだけ）。
 *   - `StageChainSteps`: 詳しい内容の中の、連鎖の状態とステップの一覧（各段のジョブへのリンク）。
 * 文言は `LOCAL_UI_STAGE_CHAIN_TEXT`、段の種類の名前はジョブの種類の表示（`auditJobKindDisplay`）。
 */
import { Link } from '@tanstack/react-router';
// PRE42-CC 組 UI-K2（CC-113）: 連鎖と段の状態の値は、純粋な core の owner から読む（文字列で比べない）。
import { STOPPED_CHAIN_STAGE_STATE } from '../../../../src/core/stage-chain-states.js';
import { LOCAL_UI_STAGE_CHAIN_TEXT } from '../../../../src/presentation/messages.js';
import { auditJobKindDisplay, stageChainStageStateDisplay, stageChainStateDisplay, stageChainStopReasonDisplay, toneClass } from '../display/labels';
import type { ChainStopReason, StageChainView } from '../../../../src/control/job/stage-chain-policy.js';

const text = LOCAL_UI_STAGE_CHAIN_TEXT;

/**
 * FM2R の Minor 1: 止めた理由が、止まった段のジョブの画面の終わり方（Run の理由・失敗の理由・セッションの切れ）と同じ意味のもの。その画面では、理由の次に
 * できることを繰り返さず、上の欄を見る案内だけにする。連鎖だけの理由（止める要求・改訂の変化・次の段を始められない）は、どの画面でも出す。
 */
const STAGE_LEVEL_STOP_REASONS: ReadonlySet<ChainStopReason> = new Set<ChainStopReason>([
  'SAFETY_VIOLATION', 'SESSION_LOST', 'SITE_UNAVAILABLE', 'SERVICE_REQUEST_LIMIT_REACHED', 'STAGE_FAILED',
]);

/** 要点のパネルの中の、まとめて実行が止まった理由と次にできること（止まっていなければ何も出さない）。 */
export function StageChainStopNotice({ chain, jobId }: Readonly<{ chain: StageChainView; jobId: string }>) {
  const stopReason = chain.stopReason;
  if (stopReason === null) {
    return null;
  }
  // FM2R の Minor 1: この画面が、連鎖が止まった段のジョブで、理由がこの画面の終わり方と同じなら、次にできることを繰り返さない。
  const stoppedHere = STAGE_LEVEL_STOP_REASONS.has(stopReason)
    && chain.stages.some((stage) => stage.state === STOPPED_CHAIN_STAGE_STATE && stage.jobId === jobId);
  return (
    <div data-testid="job-stage-chain" data-state={chain.state} data-reason={stopReason}>
      <p data-testid="job-stage-chain-reason">{text.detail.stopReasonLine(stageChainStopReasonDisplay(stopReason).label)}</p>
      {stoppedHere
        ? <p data-testid="job-stage-chain-stopped-here">{text.detail.stoppedHere}</p>
        : <p data-testid="job-stage-chain-next">{text.stopReasons[stopReason].nextStep}</p>}
    </div>
  );
}

/** 詳しい内容の中の、まとめて実行の状態とステップの一覧（各段のジョブへのリンク）。 */
export function StageChainSteps({ chain, jobId }: Readonly<{ chain: StageChainView; jobId: string }>) {
  const state = stageChainStateDisplay(chain.state);
  return (
    <section className="panel" data-testid="job-stage-chain-steps" data-state={chain.state}>
      <h2 className="panel-heading">{text.detail.heading}</h2>
      <dl className="facts">
        <dt>{text.detail.state}</dt>
        <dd><span className={toneClass(state.tone)}>{state.label}</span></dd>
      </dl>
      <h3>{text.detail.stages}</h3>
      <ol data-testid="job-stage-chain-stages">
        {chain.stages.map((stage) => {
          const stageState = stageChainStageStateDisplay(stage.state);
          return (
            <li key={stage.kind} data-kind={stage.kind} data-state={stage.state}>
              {auditJobKindDisplay(stage.kind).label}
              {' '}
              <span className={toneClass(stageState.tone)}>{stageState.label}</span>
              {stage.jobId === null ? null : stage.jobId === jobId ? <>{' '}<span className="muted">{text.detail.thisStage}</span></> : (
                <>
                  {' '}
                  <Link to="/jobs/$jobId" params={{ jobId: stage.jobId }}>{text.detail.openStage}</Link>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
