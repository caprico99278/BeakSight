/**
 * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: まとめて実行の画面の部品。
 * - `StageChainStart`: 開始の画面の「まとめて実行する」の欄（行う段の一覧、案内、始められない理由、開始のボタン）。判断はジョブの管理が開始の直前に行う。
 * - `StageChainPanel`: ジョブの詳細の、連鎖の段の一覧と状態、止まった理由と次にできること（各段のジョブへのリンク）。
 * 文言は `LOCAL_UI_STAGE_CHAIN_TEXT`、段の種類の名前はジョブの種類の表示（`auditJobKindDisplay`）。
 */
import { useState } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
// PRE42-CC 組 UI-K（N4-8f）: 段の種類（ジョブの種類の値）は、管理データと Node の部品に触れない純粋な owner から読む（文字列で比べない）。
import { WORKER_AUDIT_JOB_KIND } from '../../../../src/core/audit-job-values.js';
// PRE42-CC 組 UI-K2（CC-113）: 連鎖と段の状態の値も、純粋な core の owner から読む（文字列で比べない）。
import { RUNNING_CHAIN_STATE, STOPPED_CHAIN_STAGE_STATE } from '../../../../src/core/stage-chain-states.js';
import { LOCAL_UI_STAGE_CHAIN_TEXT, LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import { auditJobKindDisplay, stageChainStageStateDisplay, stageChainStateDisplay, stageChainStopReasonDisplay, toneClass } from '../display/labels';
import { startStageChainFn, stopAuditJobFn, type AuditJobStartView, type AuditStartSummaryView } from '../server/audit-job-functions';
import type { ChainStopReason, StageChainView } from '../../../../src/control/job/stage-chain-policy.js';
import { Notice } from './Notice';
import { StartReasonDetails } from './StartReasonDetails';

const text = LOCAL_UI_STAGE_CHAIN_TEXT;

/**
 * 開始の画面の「まとめて実行する」の欄の、理由の欄の印の頭の名前（監査の開始の欄の `start-reason`・`start-open-auth-setup` などと分ける。印は
 * `start-stage-chain-reason` など）。
 */
const CHAIN_TEST_ID_PREFIX = 'start-stage-chain';

/** 開始の画面の「まとめて実行する」の欄（まとめて実行のできるモードだけ）。`startNew` は、監査の段の始め方（開始の画面の選択）。 */
export function StageChainStart({ summary, startNew }: Readonly<{ summary: AuditStartSummaryView; startNew: boolean }>) {
  const startChain = useServerFn(startStageChainFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const { chain } = summary;
  if (chain === null) {
    return null;
  }
  return (
    <section className="panel" data-testid="start-stage-chain">
      <h2 className="panel-heading">{text.start.heading}</h2>
      <p>{text.start.guidance}</p>
      <dl className="facts">
        <dt>{text.start.stagesLabel}</dt>
        <dd>
          <ol data-testid="start-stage-chain-stages">
            {chain.stages.map((kind) => <li key={kind} data-kind={kind}>{auditJobKindDisplay(kind).label}</li>)}
          </ol>
        </dd>
      </dl>
      <p className="muted">{text.start.readCheckNote}</p>
      <p className="muted">{text.start.stopNote}</p>
      <p className="muted">{text.start.resumeNote}</p>
      {chain.stages[0] === WORKER_AUDIT_JOB_KIND ? <p className="muted">{text.start.auditModeNote}</p> : null}
      {chain.blocker !== null ? (
        <Notice kind="critical" heading={text.start.cannotStartHeading}>
          {/* 上の開始の欄と同じ理由なら、理由の本文とリンクを繰り返さない（短い文だけ）。違う理由のときだけ、理由とリンクを出す。 */}
          {chain.blocker === summary.blocker ? (
            <p data-testid="start-stage-chain-same-reason" data-reason={chain.blocker}>{text.start.sameReasonAsAbove}</p>
          ) : (
            <StartReasonDetails
              profileId={summary.profileId}
              reason={chain.blocker}
              errorCodes={chain.errorCodes}
              configError={summary.configError}
              authSetupErrors={chain.authSetupErrors}
              nextAllowedAt={chain.nextAllowedAt}
              showLoginCheckLink
              testIdPrefix={CHAIN_TEST_ID_PREFIX}
            />
          )}
        </Notice>
      ) : (
        <>
          {rejection === null ? null : (
            <Notice kind="critical" heading={text.start.rejectedHeading}>
              <StartReasonDetails
                profileId={summary.profileId}
                reason={rejection.reason}
                errorCodes={rejection.errorCodes}
                configError={null}
                authSetupErrors={rejection.authSetupErrors}
                nextAllowedAt={rejection.nextAllowedAt ?? null}
                showLoginCheckLink
                testIdPrefix={CHAIN_TEST_ID_PREFIX}
              />
              <div className="button-row">
                <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>
                  {LOCAL_UI_TEXT.reload}
                </button>
              </div>
            </Notice>
          )}
          <div className="button-row">
            <button
              type="button"
              className="button button--primary"
              data-testid="start-stage-chain-submit"
              disabled={submitting}
              onClick={() => {
                setSubmitting(true);
                void startChain({ data: { profileId: summary.profileId, expectedRevision: summary.revision, startNew } })
                  .then((result) => {
                    if (result.ok) {
                      setRejection(null);
                      return navigate({ to: '/jobs/$jobId', params: { jobId: result.jobId } });
                    }
                    setRejection(result);
                    return undefined;
                  })
                  .finally(() => setSubmitting(false));
              }}
            >
              {submitting ? text.start.submitting : text.start.submit}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * FM2R の Minor 1: 止めた理由が、止まった段のジョブの画面の終わり方（Run の理由・失敗の理由・セッションの切れ）と同じ意味のもの。その画面では、理由の次に
 * できることを繰り返さず、上の欄を見る案内だけにする。連鎖だけの理由（止める要求・改訂の変化・次の段を始められない）は、どの画面でも出す。
 */
const STAGE_LEVEL_STOP_REASONS: ReadonlySet<ChainStopReason> = new Set<ChainStopReason>([
  'SAFETY_VIOLATION', 'SESSION_LOST', 'SITE_UNAVAILABLE', 'SERVICE_REQUEST_LIMIT_REACHED', 'STAGE_FAILED',
]);

/** ジョブの詳細の、まとめて実行の欄（段の一覧と状態、止まった理由と次にできること、連鎖の全体をやめるボタン）。 */
export function StageChainPanel({ chain, jobId }: Readonly<{ chain: StageChainView; jobId: string }>) {
  const stopChain = useServerFn(stopAuditJobFn);
  const [stopping, setStopping] = useState(false);
  const [stopResult, setStopResult] = useState<'REQUESTED' | 'FAILED' | null>(null);
  const state = stageChainStateDisplay(chain.state);
  const stopReason = chain.stopReason;
  const stopLabel = stopReason === null ? null : stageChainStopReasonDisplay(stopReason).label;
  // FM2R の Minor 1: この画面が、連鎖が止まった段のジョブで、理由がこの画面の終わり方と同じなら、次にできることを繰り返さない。
  const stoppedHere = stopReason !== null && STAGE_LEVEL_STOP_REASONS.has(stopReason)
    && chain.stages.some((stage) => stage.state === STOPPED_CHAIN_STAGE_STATE && stage.jobId === jobId);
  return (
    <section className="panel" data-testid="job-stage-chain" data-state={chain.state} data-reason={stopReason ?? ''}>
      <h2 className="panel-heading">{text.detail.heading}</h2>
      <dl className="facts">
        <dt>{text.detail.state}</dt>
        <dd><span className={toneClass(state.tone)}>{state.label}</span></dd>
        {stopLabel === null ? null : [
          <dt key="reason:name">{text.detail.stopReason}</dt>,
          <dd key="reason:value" data-testid="job-stage-chain-reason">{stopLabel}</dd>,
        ]}
      </dl>
      {/* FM2R の I-2: 連鎖の全体をやめる（今の段を止め、次の段を始めない。段の間に押しても受ける）。 */}
      {chain.state !== RUNNING_CHAIN_STATE ? null : (
        <div className="button-row">
          <button
            type="button"
            className="button"
            data-testid="job-stage-chain-stop"
            disabled={stopping || stopResult === 'REQUESTED'}
            aria-describedby="job-stage-chain-stop-hint"
            onClick={() => {
              setStopping(true);
              void stopChain({ data: { jobId: chain.chainId, force: false } })
                .then((result) => setStopResult(result.ok ? 'REQUESTED' : 'FAILED'))
                .catch(() => setStopResult('FAILED'))
                .finally(() => setStopping(false));
            }}
          >
            {stopping ? text.detail.stopping : text.detail.stop}
          </button>
          <span id="job-stage-chain-stop-hint" className="muted">{text.detail.stopHint}</span>
        </div>
      )}
      {stopResult === null ? null : (
        <p data-testid="job-stage-chain-stop-result" data-result={stopResult} role="status">
          {stopResult === 'REQUESTED' ? text.detail.stopRequested : text.detail.stopFailed}
        </p>
      )}
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
      {stopReason === null ? null : stoppedHere ? (
        <p data-testid="job-stage-chain-stopped-here">{text.detail.stoppedHere}</p>
      ) : (
        <>
          <h3>{text.detail.nextStep}</h3>
          <p data-testid="job-stage-chain-next">{text.stopReasons[stopReason].nextStep}</p>
        </>
      )}
      <p className="muted">{text.detail.memoryNote}</p>
    </section>
  );
}
