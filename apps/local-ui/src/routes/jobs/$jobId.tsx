import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, notFound, useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatElapsedTime,
  formatInteger,
  formatRequestsWithPeak,
  formatTimes,
} from '../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  AUDIT_JOB_STOP_DIALOG_BODIES,
  AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS,
  AUDIT_JOB_STOP_REQUESTED_TEXTS,
  AUDIT_JOB_STOP_TARGET_NAMES,
  CLI_TEXT,
  LOCAL_UI_AUDIT_STAGE_TEXT,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_DISPLAY_SETTINGS_TEXT,
  LOCAL_UI_ENTRY_CHECK_TEXT,
  LOCAL_UI_JOB_NEXT_STEPS,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  PRECHECK_FAILURE_DETAIL_DESCRIPTIONS,
  LOCAL_UI_LOGIN_OBSERVATION_TEXT,
  LOCAL_UI_LOGIN_STAGE_TEXT,
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_MANUAL_LOGIN_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_REPORT_TEXT,
  LOCAL_UI_WRITE_TEXT,
  LOGIN_FORM_INVALID_REASON_DESCRIPTIONS,
  LOGIN_STAGE_BLOCK_REASON_LABELS,
  RUN_SUMMARY_TEXT,
  listText,
  serviceRequestPacingWaitText,
  siteUnavailableRecheckText,
  siteUnavailableSlowdownText,
} from '../../../../../src/presentation/messages.js';
import { MINUTE_MS } from '../../../../../src/core/time-units.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EntryCheckFacts, EntryCheckOutcome } from '../../components/EntryCheckResult';
import { ProfileJobEndReason, RunEndReasons, profileJobEndHasNextStep } from '../../components/JobEndReasons';
import { arrivedFromJobSearch } from '../../components/JobArrival';
import { StageChainSteps, StageChainStopNotice } from '../../components/StageChainPanel';
import { ExternalSchemeProbes, JobSafetyViolation, JobSafetyViolationDetails, PressLimitProbes } from '../../components/JobSafetyViolation';
import { PageIncompleteReasons } from '../../components/PageIncompleteReasons';
import { LoginStageObservationPanel, LoginStageQueryCell, LoginStageRegisterCell } from '../../components/LoginStageObservation';
import { LoginStageStateNames } from '../../components/LoginStageStateNames';
import { NextStepLinks } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { ARRIVAL_SEARCH, PageFrame, arrivalSearchOf, scenarioTrail, siteTrail } from '../../components/PageFrame';
import { SessionLossEvidence } from '../../components/SessionLossEvidence';
import { WriteResultDetails, WriteResultFacts, WriteResultWarning } from '../../components/WriteResultDetails';
import { AUDIT_JOB_POLL_INTERVAL_MS } from '../../display/job-polling';
import { finishedJobResultTextOf } from '../../display/next-steps';
import { closedListReason, settleServerFunction, type ServerFunctionOutcome } from '../../display/server-function-outcome';
import {
  auditJobAuthStateDisplay,
  auditJobEndKindDisplay,
  auditJobKindDisplay,
  auditJobStateDisplay,
  automatedLoginResultDisplay,
  automatedLoginSubmissionDisplay,
  requestResourceTypeLabel,
  runStatusDisplay,
  toneClass,
  usesAuthSetup,
  usesAutomatedLogin,
  writeChainStateDisplay,
  writeChainStopReasonDisplay,
} from '../../display/labels';
// T34e fix round 1・T43R-fix の M-7: 伏せた区切りがあるかの判定（path の値に見える区切りを伏せる唯一の部品）。
import { hasRedactedPathSegment } from '../../../../../src/core/url-path-redaction.js';
import {
  confirmManualLoginFn,
  getAuditJobFn,
  stopAuditJobFn,
  type AuditJobDetailView,
  type AuditJobStopView,
  type JobSummaryAdvance,
  type JobSummaryResult,
  type ManualLoginConfirmView,
} from '../../server/audit-job-functions';
import { LoginSetupPanel } from '../../components/LoginSetupPanel';
import type { JobArtifactKind } from '../../server/artifact-files';
import type { WorkerLoginStageBlockedRequests } from '../../../../../src/control/worker-protocol.js';
import type { AuditJobLoginAutoRegistration } from '../../../../../src/control/job/job-store.js';
// PRE42-CC 組 UI-K（N4-8f・CC-105 の `$jobId.tsx`）: ジョブの種類と状態の値は、管理データと Node の部品に触れない純粋な owner から読む
// （この画面に同じ定数を置かない。文字列で比べない。Gate `job-kind-constants`）。
import {
  FAILED_AUDIT_JOB_STATE,
  STOPPING_AUDIT_JOB_STATE,
  WORKER_AUDIT_JOB_KIND,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_LOGIN_CHECK_JOB_KIND,
} from '../../../../../src/core/audit-job-values.js';
// PRE42-CC 組 UI-K2（CC-113）: 認証の状態、まとめて実行の状態、続けて更新する状態の値も、純粋な core の owner から読む（書き写さない。文字列で比べない）。
import { RUNNING_CHAIN_STATE } from '../../../../../src/core/stage-chain-states.js';
import { PENDING_WRITE_CHAIN_STATES } from '../../../../../src/core/write-chain-states.js';

export const Route = createFileRoute('/jobs/$jobId')({
  // PL-2（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 5）: 続けて始まった作業へ自動で移ったときの印（h1 にフォーカスを置く）を受ける。
  validateSearch: (search: Record<string, unknown>) => arrivalSearchOf(search),
  loader: async ({ params }) => {
    const job = await getAuditJobFn({ data: { jobId: params.jobId } });
    if (job === null) {
      throw notFound();
    }
    return job;
  },
  component: JobDetailPage,
});

/** 成果物のリンクの文言と、ダウンロードにするか（JSON と ZIP。サーバも `Content-Disposition: attachment` で返す）。 */
const ARTIFACT_LINKS: Readonly<Record<JobArtifactKind, { readonly label: string; readonly download: boolean }>> = Object.freeze({
  REPORT: { label: LOCAL_UI_AUDIT_TEXT.job.openReport, download: false },
  RUN_JSON: { label: LOCAL_UI_AUDIT_TEXT.job.downloadRunJson, download: true },
  AUDIT_JSON: { label: LOCAL_UI_AUDIT_TEXT.job.downloadAuditJson, download: true },
  BUNDLE: { label: LOCAL_UI_AUDIT_TEXT.job.downloadBundle, download: true },
  // T27f: 発見と READ の確かめのジョブの成果物（どちらも JSON。ダウンロード）。
  DISCOVERY_JSON: { label: LOCAL_UI_DISCOVERY_TEXT.job.downloadDiscoveryJson, download: true },
  READ_EVIDENCE_JSON: { label: LOCAL_UI_DISCOVERY_TEXT.job.downloadReadEvidenceJson, download: true },
  // T32g: 書き込みのジョブの報告（親の確かめに通ったジョブだけ。サーバが一覧に入れる）。
  ACTION_REPORT: { label: LOCAL_UI_WRITE_REPORT_TEXT.artifacts.openActionReport, download: false },
  ACTION_EVIDENCE_JSON: { label: LOCAL_UI_WRITE_REPORT_TEXT.artifacts.downloadActionEvidenceJson, download: true },
  APPROVAL_SUMMARY_JSON: { label: LOCAL_UI_WRITE_REPORT_TEXT.artifacts.downloadApprovalSummaryJson, download: true },
  ACTION_BUNDLE: { label: LOCAL_UI_WRITE_REPORT_TEXT.artifacts.downloadActionBundle, download: true },
  // T43c: 入口の確かめのジョブの成果物（JSON。ダウンロード）。
  ENTRY_CHECK_JSON: { label: LOCAL_UI_ENTRY_CHECK_TEXT.job.downloadEntryCheckJson, download: true },
});

/**
 * PL-2（13 章の 13）: 詳しい内容の「できたファイル」に出さない成果物。点検と書き込みの報告（HTML）は要点の主のボタン（結果を見る）が開き、書き込みの報告の
 * ZIP は書き込みの詳しい記録（`WriteResultFacts`）が出す（同じファイルを 2 回出さない）。
 */
const ARTIFACTS_SHOWN_ELSEWHERE: ReadonlySet<JobArtifactKind> = new Set<JobArtifactKind>(['REPORT', 'ACTION_REPORT', 'ACTION_BUNDLE']);

/** 確かめのダイアログで、どちらの止め方を確かめているか。 */
type StopDialogKind = 'stop' | 'force';

/**
 * DEF-146: 止められなかった理由（ジョブの管理が拒んだ理由か、止める要求が届かなかったこと）。読み方は共通の部品（`settleServerFunction`）。
 */
type StopFailure = Exclude<
  ServerFunctionOutcome<Extract<AuditJobStopView, { ok: true }>, Extract<AuditJobStopView, { ok: false }>['reason']>,
  { readonly kind: 'ACCEPTED' }
>;

/** 止める要求を拒む理由の閉じた一覧の値か（一覧はカタログの鍵と同じ）。 */
const isStopRejectionReason = closedListReason(AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS);

/** DEF-146（の 3）: 「ログインを終えた」の結果の読み方（受け付けた・拒まれた・要求が届かなかった）。 */
type LoginConfirmAccepted = Extract<ManualLoginConfirmView, { ok: true }>;
type LoginConfirmRejectionReason = Extract<ManualLoginConfirmView, { ok: false }>['reason'];
type LoginConfirmOutcome = ServerFunctionOutcome<LoginConfirmAccepted, LoginConfirmRejectionReason>;

/** DEF-146（の 3）: 「ログインを終えた」を拒む理由の閉じた一覧の値か（一覧はカタログの鍵と同じ）。 */
const isLoginConfirmRejectionReason = closedListReason(LOCAL_UI_MANUAL_LOGIN_TEXT.rejectionReasons);

/** たたんだ詳しい内容の見出し（共通の部品 `AdvancedSettings` の見出し）。要点の文が、この語で案内する。 */
const DETAILS_HEADING = LOCAL_UI_TEXT.advancedSettings.summary;

/** 知らせの 1 行（CLI と同じ文言と書式）。 */
const noticeText = (notice: NonNullable<AuditJobDetailView['lastNotice']>): string => {
  switch (notice.kind) {
    case 'SITE_UNAVAILABLE_RECHECK':
      return siteUnavailableRecheckText(notice.url, formatDuration(notice.delayMs), notice.attempt, notice.maxAttempts);
    case 'SITE_UNAVAILABLE_SLOWDOWN':
      return siteUnavailableSlowdownText(formatDuration(notice.minIntervalMs));
    case 'SERVICE_REQUEST_PACING_WAIT':
      // DEF-141: 承認したサービスへの要求の 1 分あたりの上限で、次の読み込みの前に待つ（監査・発見・READ の確かめ）。
      return serviceRequestPacingWaitText(formatDuration(notice.waitMs), notice.waitCount, formatDuration(notice.totalWaitMs));
  }
};

// ---------------------------------------------------------------------------------------------------------------
// PL-2: 要点（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、13 章の 10・11・13）
// ---------------------------------------------------------------------------------------------------------------

/** 結果の 1 行の文（種類はサーバの要点 `summary.result`。止めている間は、種類ごとの止める要求の後の文）。 */
const resultTextOf = (job: AuditJobDetailView, result: JobSummaryResult): string => {
  const target = AUDIT_JOB_STOP_TARGET_NAMES[job.jobKind];
  switch (result) {
    case 'STARTING':
    case 'RUNNING':
      return LOCAL_UI_JOB_SUMMARY_TEXT.active[result](target);
    case 'AWAITING_LOGIN':
      return LOCAL_UI_JOB_SUMMARY_TEXT.active.AWAITING_LOGIN;
    case 'STOPPING':
      return AUDIT_JOB_STOP_REQUESTED_TEXTS[job.jobKind];
    default:
      // PL-R（設計書 14 章、13 章の 13）: 報告の小さなまとめを読めたときは、問題の数を出す（決めるのはサーバの要点 `summary.problemCount`）。文は、移ってきた
      // サイトの画面と共用の部品（PL-U）。
      return finishedJobResultTextOf(result, job.summary.problemCount);
  }
};

/**
 * 結果の 1 行。画面のテストと読み上げのために、作業の状態（`job-state`）、点検の回の状態（`job-run-status`。点検の回があるとき）、止める要求の後
 * （`job-stop-requested`）の印を、同じ 1 行に付ける（状態の札は出さない。結果の文が状態を言う）。
 */
function ResultLine({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const { result, chainStage } = job.summary;
  // OP-G2（OP-G の指示書の 6）: まとめて実行の連鎖が動いている間は、点検の画面にとどまり、今の段を言う（決めるのはサーバの要点 `summary.chainStage`）。
  const textOfResult = chainStage === null ? resultTextOf(job, result) : LOCAL_UI_JOB_SUMMARY_TEXT.chainStage[chainStage];
  const inner = result === 'STOPPING'
    ? <span data-testid="job-stop-requested">{textOfResult}</span>
    : job.runStatus === null ? textOfResult : <span data-testid="job-run-status" data-run-status={job.runStatus}>{textOfResult}</span>;
  return (
    <p data-testid="job-result" data-result={result} data-chain-stage={chainStage ?? ''}>
      <strong data-testid="job-state" data-state={job.state}>{inner}</strong>
    </p>
  );
}

/** 待つ間の進み具合の 1 行（13 章の 11。見積もりはサーバの `auditRemainingUpperBoundMs` の値を分に切り上げるだけ）。 */
function ProgressEstimate({ estimate }: Readonly<{ estimate: NonNullable<AuditJobDetailView['summary']['estimate']> }>) {
  const minutes = Math.max(1, Math.ceil(estimate.remainingUpperBoundMs / MINUTE_MS));
  return (
    <p data-testid="job-progress-estimate">
      {LOCAL_UI_JOB_SUMMARY_TEXT.progressEstimate(formatInteger(estimate.pagesFinished), formatInteger(estimate.maxPages), formatInteger(minutes))}
    </p>
  );
}

/** 主のボタン（要点の最後・左。サーバの `summary.primary` を描くだけ）。 */
function PrimaryAction({ job, onConfirmLogin, confirmingLogin }: Readonly<{
  job: AuditJobDetailView;
  onConfirmLogin: () => void;
  confirmingLogin: boolean;
}>) {
  const resultText = LOCAL_UI_JOB_SUMMARY_TEXT.openResult;
  switch (job.summary.primary) {
    case null:
      return null;
    case 'CONFIRM_LOGIN':
      return (
        <button type="button" className="button button--primary" data-testid="job-manual-login-confirm" disabled={confirmingLogin} onClick={onConfirmLogin}>
          {confirmingLogin ? LOCAL_UI_MANUAL_LOGIN_TEXT.confirming : LOCAL_UI_MANUAL_LOGIN_TEXT.confirm}
        </button>
      );
    case 'OPEN_REPORT': {
      const report = job.artifacts.find(({ kind }) => kind === 'REPORT');
      return report === undefined ? null : (
        <a href={report.href} target="_blank" rel="noopener noreferrer" className="button button--primary" data-testid="job-open-report" data-artifact={report.kind}>
          {resultText}
        </a>
      );
    }
    case 'OPEN_WRITE_REPORT': {
      const href = job.write?.report.reportHref ?? null;
      return href === null ? null : (
        <a href={href} target="_blank" rel="noopener noreferrer" className="button button--primary" data-testid="write-report-open">{resultText}</a>
      );
    }
    case 'START_AUDIT':
      return (
        <Link to="/start/$profileId" params={{ profileId: job.profileId }} className="button button--primary" data-testid="job-start-audit">
          {LOCAL_UI_AUDIT_TEXT.profileList.startAudit}
        </Link>
      );
    case 'OPEN_DISCOVERY':
      return (
        <Link to="/discovery/$profileId" params={{ profileId: job.profileId }} className="button button--primary" data-testid="job-open-discovery">
          {LOCAL_UI_DISCOVERY_TEXT.job.openDiscovery}
        </Link>
      );
    case 'OPEN_READ_CHECKS':
      return (
        <Link to="/read-checks/$profileId" params={{ profileId: job.profileId }} className="button button--primary" data-testid="job-open-read-checks">
          {LOCAL_UI_DISCOVERY_TEXT.job.openReadChecks}
        </Link>
      );
  }
}

/** 自動の登録の結果の、要点の 1 行（覚えた・行の登録が要る。ほかは出さない）。 */
function LoginRegistrationLine({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const registration = job.loginStage?.autoRegistration;
  // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 1）: 手でのログインの値を受け取ったときの、自動ログインへの切り替えの結果の 1 行（切り替えた・
  // このサイトでは使えない）。
  const switchLine = registration?.automatedLogin === undefined ? null : (
    <p data-testid="job-automated-login-switch" data-result={registration.automatedLogin}>
      {registration.automatedLogin === 'SWITCHED' ? LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration.switched : LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.notAvailable}
    </p>
  );
  if (registration?.result === 'SAVED') {
    return (
      <>
        <p data-testid="job-login-remembered">{LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration.saved}</p>
        {switchLine}
      </>
    );
  }
  if (switchLine !== null && job.summary.loginStageRegistration !== 'NEEDED') {
    return switchLine;
  }
  if (job.summary.loginStageRegistration !== 'NEEDED') {
    return null;
  }
  return (
    <div data-testid="job-login-registration-needed">
      <p>{LOCAL_UI_JOB_SUMMARY_TEXT.registrationNeeded(DETAILS_HEADING)}</p>
      {registration?.result === 'SKIPPED' ? <p>{LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration.skipReasons[registration.reason].next}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// 詳しい内容（たたんだ区画の中。ジョブの記録にしかない情報を、後で調べる道として残す）
// ---------------------------------------------------------------------------------------------------------------

/** 作業の記録の表（前の要点の表。ID・日時・終了コードは、ここだけに出す）。 */
function JobFacts({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const state = auditJobStateDisplay(job.state);
  const runStatus = job.runStatus === null ? null : runStatusDisplay(job.runStatus);
  const endKind = job.endKind === null ? null : auditJobEndKindDisplay(job.endKind);
  const kind = auditJobKindDisplay(job.jobKind);
  // T26e: ログインの確かめは Run を作らないので、始め方と Run の項目を出さない。
  const loginCheck = job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND;
  return (
    <section className="panel" data-testid="job-facts">
      <h2 className="panel-heading">{text.summaryHeading}</h2>
      <dl className="facts" data-testid="job-summary">
        <dt>{text.state}</dt>
        <dd><span className={toneClass(state.tone)} data-state={job.state}>{state.label}</span></dd>
        <dt>{LOCAL_UI_LOGIN_CHECK_TEXT.job.kind}</dt>
        <dd data-testid="job-kind" data-kind={job.jobKind}>{kind.label}</dd>
        <dt>{text.profileId}</dt>
        <dd>
          {job.profileId}
          {' '}
          {LOCAL_UI_TEXT.profileForm.revisionText(job.profileRevision)}
        </dd>
        {loginCheck ? null : (
          <>
            <dt>{text.startMode}</dt>
            <dd>{job.startNew ? LOCAL_UI_AUDIT_TEXT.start.startNew : LOCAL_UI_AUDIT_TEXT.start.resume}</dd>
            <dt>{text.runId}</dt>
            <dd data-testid="job-run-id">{job.runId ?? text.none}</dd>
            <dt>{text.runStatus}</dt>
            <dd>{runStatus === null ? text.none : <span className={toneClass(runStatus.tone)}>{runStatus.label}</span>}</dd>
            <dt>{text.endKind}</dt>
            <dd>{endKind === null ? text.none : endKind.label}</dd>
          </>
        )}
        <dt>{text.exitCode}</dt>
        <dd>{job.exitCode === null ? text.none : String(job.exitCode)}</dd>
        <dt>{text.createdAt}</dt>
        <dd>{formatDateTime(job.createdAt)}</dd>
        {loginCheck ? null : (
          <>
            <dt>{text.startedAt}</dt>
            <dd>{job.startedAt === null ? text.none : formatDateTime(job.startedAt)}</dd>
          </>
        )}
        <dt>{text.stopRequestedAt}</dt>
        <dd>{job.stopRequestedAt === null ? text.none : formatDateTime(job.stopRequestedAt)}</dd>
        <dt>{text.finishedAt}</dt>
        <dd>{job.finishedAt === null ? text.none : formatDateTime(job.finishedAt)}</dd>
      </dl>
      {kind.description === null ? null : <p className="muted">{kind.description}</p>}
      {endKind === null || endKind.description === null ? null : <p>{endKind.description}</p>}
      {/* T44e（Task 44 の設計書 P2-7）: 監査のジョブの終わり方の、次にできること（カタログ。説明が手順を含むものは出さない）。 */}
      {job.endKind === null || LOCAL_UI_JOB_NEXT_STEPS.endKinds[job.endKind] === null ? null : (
        <p data-testid="job-end-kind-next">{LOCAL_UI_JOB_NEXT_STEPS.endKinds[job.endKind]}</p>
      )}
    </section>
  );
}

/** 進み具合の数（最後の進み具合の知らせを、既存の書式で示す。値は事実のまま、計算しない）。 */
function Progress({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const report = job.lastProgress;
  if (report === null) {
    return null;
  }
  return (
    <section className="panel">
      <h2 className="panel-heading">{text.progressHeading}</h2>
      <progress className="progress" value={report.pagesFinished} max={report.maxPages} aria-label={text.pagesProgressLabel} />
      <dl className="facts" data-testid="job-progress">
        <dt>{CLI_TEXT.progress.pagesFinished}</dt>
        <dd data-testid="job-pages-finished">{formatCount(report.pagesFinished)}</dd>
        <dt>{RUN_SUMMARY_TEXT.coverage.discovered}</dt>
        <dd>{formatCount(report.pagesDiscovered)}</dd>
        <dt>{LOCAL_UI_AUDIT_TEXT.start.maxPages}</dt>
        <dd>{formatCount(report.maxPages)}</dd>
        <dt>{CLI_TEXT.progress.elapsed}</dt>
        <dd>{formatElapsedTime(report.elapsedMs)}</dd>
        <dt>{CLI_TEXT.run.navigationCount}</dt>
        <dd>{formatTimes(report.navigationCount)}</dd>
        <dt>{RUN_SUMMARY_TEXT.allowedOriginRequests}</dt>
        <dd>{formatRequestsWithPeak(report.requests.allowedOrigins, report.recentPerMinute.allowedOrigins)}</dd>
        <dt>{CLI_TEXT.progress.otherOriginRequests}</dt>
        <dd>{formatCount(report.requests.otherOrigins.count)}</dd>
      </dl>
    </section>
  );
}

/**
 * 認証つきの監査の、最後の認証の状態（T25e。Task 25 の設計書 4.5）と、セッションが切れたと判定した読み込みの記録（DEF-138）。PL-2: 詳しい内容に入れる
 * （ログインが切れたページと次にすることは、要点に出す）。値と秘密は、画面のサーバに届かない。
 */
function AuthState({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_AUTH_TEXT.job;
  if (job.lastAuthState === null) {
    return null;
  }
  const state = auditJobAuthStateDisplay(job.lastAuthState);
  return (
    <section className="panel" data-testid="job-auth">
      <h2 className="panel-heading">{text.heading}</h2>
      <dl className="facts">
        <dt>{text.state}</dt>
        <dd>
          <span className={toneClass(state.tone)} data-testid="job-auth-state" data-auth-state={job.lastAuthState}>{state.label}</span>
        </dd>
        {job.sessionLostUrl === null ? null : (
          <>
            <dt>{text.sessionLostUrl}</dt>
            <dd className="cell-break"><code data-testid="job-session-lost-url">{job.sessionLostUrl}</code></dd>
          </>
        )}
      </dl>
      {state.description === null ? null : <p data-testid="job-auth-description">{state.description}</p>}
      <SessionLossEvidence evidence={job.sessionLoss} />
    </section>
  );
}

/**
 * ML-b（手動のログインの設計書 2.3）: 手動のログインの間に通した送信の表（Origin、パス、種類、回数、query の名前、登録）。ML-b-2: 行は、止めた一覧と
 * 同じ形（ジョブのまとめの `passedRequests`。ML-a）で、行の理由は、通さなければ止めた理由。「登録する」は、止めた行と同じ部品
 * （`loginStageRegistrationOf`）を、行のまま使う。PL-2: 自動の登録が済んだら、行の登録の操作を出さない。
 */
function LoginStagePassed({ jobId, profileId, passed, automatedLoginContext, registrationDone }: Readonly<{
  jobId: string;
  profileId: string;
  passed: WorkerLoginStageBlockedRequests | undefined;
  /** MI-C 項目 12: 自動ログインの文脈の行か（真なら、下書きのリンクを出さない）。 */
  automatedLoginContext: boolean;
  registrationDone: boolean;
}>) {
  const text = LOCAL_UI_LOGIN_STAGE_TEXT;
  if (passed === undefined || (passed.requests.length === 0 && passed.unlisted === 0)) {
    return null;
  }
  return (
    <>
      {passed.requests.length === 0 ? null : (
        <div className="table-wrap">
          <table data-testid="job-login-stage-passed">
            <caption>{text.passedTableCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{text.columns.origin}</th>
                <th scope="col">{text.columns.path}</th>
                <th scope="col">{text.columns.resourceType}</th>
                <th scope="col">{text.columns.count}</th>
                <th scope="col">{LOCAL_UI_LOGIN_OBSERVATION_TEXT.columns.query}</th>
                {registrationDone ? null : <th scope="col">{LOCAL_UI_LOGIN_OBSERVATION_TEXT.columns.register}</th>}
              </tr>
            </thead>
            <tbody>
              {passed.requests.map((request, index) => (
                <tr
                  key={JSON.stringify([request.origin, request.path, request.resourceType, request.reason, request.query?.values ?? []])}
                  data-path={request.path}
                  data-reason={request.reason}
                  data-before-token={request.beforeToken === true ? 'true' : undefined}
                >
                  <td className="cell-break"><code>{request.origin}</code></td>
                  <td className="cell-break">
                    <code>{request.path}</code>
                    {hasRedactedPathSegment(request.path) ? <span className="muted">{text.redactedPathNote}</span> : null}
                    {/* ML-b-3: token の送信より前に最初に見た行の印（自動の登録が、ログインに伴う送信を見分ける印）。 */}
                    {request.beforeToken === true ? <span className="field-hint">{text.passedBeforeToken}</span> : null}
                  </td>
                  <td data-resource-type={request.resourceType}>{requestResourceTypeLabel(request.resourceType)}</td>
                  <td>{formatTimes(request.count)}</td>
                  <td className="cell-break"><LoginStageQueryCell request={request} /></td>
                  {registrationDone ? null : (
                    <td>
                      <LoginStageRegisterCell
                        profileId={profileId}
                        request={request}
                        target={{ jobId, passed: true, index }}
                        automatedLoginContext={automatedLoginContext}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {passed.unlisted === 0 ? null : <p data-testid="job-login-stage-passed-unlisted">{text.passedUnlisted(formatCount(passed.unlisted))}</p>}
    </>
  );
}

/**
 * ML-b-2（手動のログインの設計書 2.3）: このジョブの手動のログインから、設定を自動で登録した結果（ジョブの終わりの後に、ジョブの管理が背後で 1 回だけ書く）。
 * SAVED は、このジョブで登録したことと、保存したプロファイルの改訂と、足した承認したサービスの Origin。SKIPPED は、理由と次にすること（カタログ）。
 */
function AutoRegistrationResult({ registration }: Readonly<{ registration: AuditJobLoginAutoRegistration }>) {
  const text = LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration;
  // OP-K（K3）: 自動ログインへ切り替えられなかった理由の 1 行（記録にあるときだけ。文はカタログ）。
  const unavailableLine = registration.automatedLoginReason === undefined ? null : (
    <p data-testid="job-automated-login-reason" data-reason={registration.automatedLoginReason}>
      {text.automatedLoginReasons[registration.automatedLoginReason]}
    </p>
  );
  if (registration.result === 'SAVED') {
    return (
      <div data-testid="job-login-auto-registration" data-result={registration.result}>
        <p>{text.saved}</p>
        {unavailableLine}
        <dl className="facts">
          <dt>{text.savedRevision}</dt>
          <dd>{LOCAL_UI_TEXT.profileForm.revisionText(registration.profileRevision)}</dd>
          <dt>{text.addedServiceOrigins}</dt>
          <dd data-item="addedServiceOrigins">
            {registration.addedServiceOrigins.length === 0 ? LOCAL_UI_MANUAL_LOGIN_TEXT.none : listText(registration.addedServiceOrigins)}
          </dd>
        </dl>
      </div>
    );
  }
  const reason = text.skipReasons[registration.reason];
  return (
    <div data-testid="job-login-auto-registration" data-result={registration.result} data-reason={registration.reason}>
      <p>{text.skipped}</p>
      {unavailableLine}
      <dl className="facts">
        <dt>{text.skipReason}</dt>
        <dd>{reason.label}</dd>
        <dt>{text.next}</dt>
        <dd>{reason.next}</dd>
      </dl>
    </div>
  );
}

/** 数の合計。 */
const sumOf =(values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** 止めた理由ごとの数（スクリプトで送るログイン）。 */
type ScriptLoginBlockedByReason = NonNullable<NonNullable<AuditJobDetailView['loginStage']>['scriptLogin']>['blockedByReason'];

/** 資格情報を含む要求を止めた数のほかの、止めた数の合計（T36R-fix。T36R の M-7）。 */
const nonCredentialBlockedTotal = ({ LOGIN_CREDENTIAL_IN_REQUEST: _credential, ...others }: ScriptLoginBlockedByReason): number =>
  sumOf(Object.values(others));

/**
 * ログインの段で止めた送信（T34e。Task 34 の設計書 3.5 と 8 章の T34e の行）。止めた読み取りでない送信の表（Origin、パス、種類、理由、回数）と、
 * 数のまとめ（スクリプトで送るログインの数があれば、その数）と、「ログインに伴う送信」への登録の案内。値・query・本文は、ジョブの記録にない。
 * T34e fix round 1: 値に見える区切りを伏せたパスは、パスに伏せた旨を添える。PL-2: 自動の登録が済んだら、行の登録の操作と案内を出さない。
 */
function LoginStageBlocked({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_LOGIN_STAGE_TEXT;
  const { loginStage } = job;
  if (loginStage === null) {
    return null;
  }
  const registrationDone = job.summary.loginStageRegistration === 'DONE';
  const { scriptLogin, blockedRequests } = loginStage;
  const requests = blockedRequests?.requests ?? [];
  const unlisted = blockedRequests?.unlisted ?? 0;
  // T36R-fix（T36R の M-7）: 資格情報を含む要求を止めた数は、止めた読み取りでない送信の数に足さず（読み取りの要求も含むため）、独立の欄に出す
  // （鍵の名前は IPC の型 `WorkerScriptLoginBlockReason` で確かめる）。
  const blockedTotal = scriptLogin === null
    ? sumOf(requests.map(({ count }) => count)) + unlisted
    : nonCredentialBlockedTotal(scriptLogin.blockedByReason);
  return (
    <section className="panel" data-testid="job-login-stage">
      <h2 className="panel-heading">{text.heading}</h2>
      <p className="muted">{text.body}</p>
      <dl className="facts" data-testid="job-login-stage-counts">
        {scriptLogin === null ? null : (
          <>
            <dt>{text.tokenRequestsAllowed}</dt>
            <dd>{formatTimes(scriptLogin.tokenRequestsAllowed)}</dd>
            <dt>{text.sideRequestsAllowed}</dt>
            <dd>{formatTimes(sumOf(scriptLogin.sideRequestsAllowed))}</dd>
            <dt>{text.serviceOriginReads}</dt>
            <dd>{formatTimes(scriptLogin.serviceOriginReads)}</dd>
          </>
        )}
        <dt>{text.blockedTotal}</dt>
        <dd>{formatTimes(blockedTotal)}</dd>
        {scriptLogin === null ? null : (
          <>
            <dt>{text.credentialRequestsBlocked}</dt>
            <dd>{formatTimes(scriptLogin.blockedByReason.LOGIN_CREDENTIAL_IN_REQUEST)}</dd>
          </>
        )}
      </dl>
      {requests.length === 0 ? null : (
        <div className="table-wrap">
          <table data-testid="job-login-stage-blocked">
            <caption>{text.tableCaption}</caption>
            <thead>
              <tr>
                <th scope="col">{text.columns.origin}</th>
                <th scope="col">{text.columns.path}</th>
                <th scope="col">{text.columns.resourceType}</th>
                <th scope="col">{text.columns.reason}</th>
                <th scope="col">{text.columns.count}</th>
                {/* T43d: query の名前と、「登録する」（認証の設定の画面を下書きつきで開く。その場では保存しない）。 */}
                <th scope="col">{LOCAL_UI_LOGIN_OBSERVATION_TEXT.columns.query}</th>
                {registrationDone ? null : <th scope="col">{LOCAL_UI_LOGIN_OBSERVATION_TEXT.columns.register}</th>}
              </tr>
            </thead>
            <tbody>
              {requests.map((request, index) => (
                <tr
                  key={JSON.stringify([request.origin, request.path, request.resourceType, request.reason, request.query?.values ?? []])}
                  data-reason={request.reason}
                >
                  <td className="cell-break"><code>{request.origin}</code></td>
                  <td className="cell-break">
                    <code>{request.path}</code>
                    {hasRedactedPathSegment(request.path) ? <span className="muted">{text.redactedPathNote}</span> : null}
                  </td>
                  <td data-resource-type={request.resourceType}>{requestResourceTypeLabel(request.resourceType)}</td>
                  <td>{LOGIN_STAGE_BLOCK_REASON_LABELS[request.reason]}</td>
                  <td>{formatTimes(request.count)}</td>
                  <td className="cell-break"><LoginStageQueryCell request={request} /></td>
                  {registrationDone ? null : (
                    <td>
                      <LoginStageRegisterCell
                        profileId={job.profileId}
                        request={request}
                        target={{ jobId: job.jobId, passed: false, index }}
                        automatedLoginContext={job.automatedLoginContext}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unlisted === 0 ? null : <p data-testid="job-login-stage-unlisted">{text.unlisted(formatCount(unlisted))}</p>}
      {/* ML-b（手動のログインの設計書 2.3）: 手動のログインの間に通した送信（止めた送信と分けて出す。行からも「登録する」を使える）。 */}
      <LoginStagePassed
        jobId={job.jobId}
        profileId={job.profileId}
        passed={loginStage.passedRequests}
        automatedLoginContext={job.automatedLoginContext}
        registrationDone={registrationDone}
      />
      {registrationDone || (requests.length === 0 && unlisted === 0) ? null : (
        <>
          <p data-testid="job-login-stage-guidance">{text.guidance}</p>
          <p>
            <Link to="/auth-setup/$profileId" params={{ profileId: job.profileId }} className="button">{text.openSetup}</Link>
          </p>
        </>
      )}
      {/* T43d: ログインの段で観察した案（成功の鍵の名前と、成功の画面のセレクタ）。 */}
      <LoginStageObservationPanel
        profileId={job.profileId}
        observation={loginStage.observation}
        omitted={loginStage.observationOmitted === true}
        registrationDone={registrationDone}
      />
      {/* DEF-139: ログインの後のブラウザの状態の名前（引き継いだか外したか。値は記録にない）。 */}
      <LoginStageStateNames names={loginStage.stateNames} />
    </section>
  );
}

/**
 * 発見と READ の確かめのジョブの、監査の段の数（T37a。Task 37 の設計書 3.1）。成果物の `authentication`（`run.json` と同じ形）を、ログインの段の要約と
 * 並べて出す。上限に届いたときは、その説明を添える。数だけで、URL・値は出さない。
 */
function AuditStageCounts({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_AUDIT_STAGE_TEXT;
  const { auditStage } = job;
  if (auditStage === null) {
    return null;
  }
  return (
    <section className="panel" data-testid="job-audit-stage">
      <h2 className="panel-heading">{text.heading}</h2>
      <p className="muted">{text.body}</p>
      <dl className="facts" data-testid="job-audit-stage-counts">
        <dt>{text.registeredReadRequestsAllowed}</dt>
        <dd>{formatTimes(auditStage.registeredReadRequestsAllowed)}</dd>
        <dt>{text.tokenRefreshBlocked}</dt>
        <dd>{formatTimes(auditStage.tokenRefreshBlocked)}</dd>
        <dt>{text.otherNonReadBlocked}</dt>
        <dd>{formatTimes(auditStage.otherNonReadBlocked)}</dd>
        <dt>{text.serviceUnauthorizedResponses}</dt>
        <dd>{formatTimes(auditStage.serviceUnauthorizedResponses)}</dd>
        <dt>{text.serviceRequestLimitReached}</dt>
        <dd data-limit-reached={String(auditStage.serviceRequestLimitReached)}>
          {auditStage.serviceRequestLimitReached ? text.limitReached : text.limitNotReached}
        </dd>
        {/* DEF-141: 1 分あたりの上限で待った回数と時間の合計（前の版の成果物にはないので、ないときは出さない）。 */}
        {auditStage.serviceRequestPacingWaits === undefined ? null : (
          <>
            <dt>{text.serviceRequestPacingWaits}</dt>
            <dd>{formatTimes(auditStage.serviceRequestPacingWaits)}</dd>
          </>
        )}
        {auditStage.serviceRequestPacingWaitMs === undefined ? null : (
          <>
            <dt>{text.serviceRequestPacingWaitMs}</dt>
            <dd>{formatDuration(auditStage.serviceRequestPacingWaitMs)}</dd>
          </>
        )}
      </dl>
      {auditStage.serviceRequestLimitReached ? <p data-testid="job-audit-stage-limit">{text.limitReachedNote}</p> : null}
    </section>
  );
}

/** 成功の結果。 */
const AUTOMATED_LOGIN_SUCCEEDED = 'SUCCEEDED';

/**
 * 自動ログインの試しの結果（T26e。Task 26 の設計書 4.6）。結果、送信、サーバが示した次に試してよい日時、フォームの確かめの理由（カタログと文言の
 * 表示）と、結果ごとの人がすること（ジョブの失敗の理由の文言の手順。失敗の欄に同じ手順が出ているときは、重ねて出さない）。値は画面のサーバに届かない。
 * PL-2: 成功のときは詳しい内容に入れ、ログインの確かめの画面へのリンクを出さない（失敗・止めたときだけ、ふだんの画面に出して、確かめる入口を出す）。
 */
function AutoLoginResult({ job, succeeded }: Readonly<{ job: AuditJobDetailView; succeeded: boolean }>) {
  const text = LOCAL_UI_LOGIN_CHECK_TEXT.job;
  const attempt = job.autoLogin;
  if (attempt === null) {
    return null;
  }
  const result = attempt.result === null ? null : automatedLoginResultDisplay(attempt.result);
  const submitted = attempt.submitted === null ? null : automatedLoginSubmissionDisplay(attempt.submitted);
  const failureText = attempt.result === null || attempt.result === AUTOMATED_LOGIN_SUCCEEDED
    ? null
    : AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[attempt.result];
  const shownInFailure = job.failureReason !== null && job.failureReason === attempt.result;
  return (
    <section className="panel" data-testid="job-auto-login">
      <h2 className="panel-heading">{text.heading}</h2>
      <dl className="facts">
        <dt>{text.result}</dt>
        <dd>
          {result === null || attempt.result === null ? <span data-testid="job-auto-login-result" data-result="">{text.pending}</span> : (
            <span className={toneClass(result.tone)} data-testid="job-auto-login-result" data-result={attempt.result}>{result.label}</span>
          )}
        </dd>
        {submitted === null || attempt.submitted === null ? null : (
          <>
            <dt>{text.submitted}</dt>
            <dd data-testid="job-auto-login-submitted" data-submitted={attempt.submitted}>{submitted.label}</dd>
          </>
        )}
        {attempt.retryAfterUntil === null ? null : (
          <>
            <dt>{text.retryAfterUntil}</dt>
            <dd data-testid="job-auto-login-retry-after">{formatDateTime(attempt.retryAfterUntil)}</dd>
          </>
        )}
        {attempt.formInvalidReason === null ? null : (
          <>
            <dt>{text.formInvalidReason}</dt>
            <dd data-testid="job-auto-login-form-reason" data-reason={attempt.formInvalidReason}>
              {LOGIN_FORM_INVALID_REASON_DESCRIPTIONS[attempt.formInvalidReason]}
            </dd>
          </>
        )}
      </dl>
      {result === null || result.description === null ? null : <p data-testid="job-auto-login-description">{result.description}</p>}
      {submitted === null || submitted.description === null ? null : <p>{submitted.description}</p>}
      {failureText === null || shownInFailure ? null : (
        <>
          <p>{failureText.description}</p>
          <p data-testid="job-auto-login-action"><strong>{text.action}: </strong>{failureText.action}</p>
        </>
      )}
      {succeeded ? null : (
        <p>
          <Link to="/login-check/$profileId" params={{ profileId: job.profileId }} className="button">{text.openLoginCheck}</Link>
        </p>
      )}
    </section>
  );
}

/**
 * T41g-2: 続けて更新する予定が、まだ決まっていない状態（この間は、ジョブが終わった後も読み直しを続ける）。登録のジョブの終わりを待っている間と、T41g-3 の
 * 自動ログインの間隔を待っている間。PRE42-CC 組 UI-K2: 一覧は core の `PENDING_WRITE_CHAIN_STATES` を読む（ここに書き写さない）。
 */
const CHAIN_PENDING_STATES: ReadonlySet<string> = new Set<string>(PENDING_WRITE_CHAIN_STATES);

/**
 * T41g（Task 41 の設計書 3.5.1）: 登録のジョブの、続けて更新する予定と状態（「登録してから更新する」で始めた登録のジョブだけ）。状態と理由のラベルは
 * カタログ。更新のジョブを始めたら、その画面へのリンクを出す（PL-2: 成功のときは、その画面へ自動で移る）。PL-2（3 章の 2）: 書き込みの手順の ID は出さない。
 */
function WriteChainState({ chain }: Readonly<{ chain: NonNullable<AuditJobDetailView['writeChain']> }>) {
  const chainText = LOCAL_UI_WRITE_TEXT.chain;
  const state = writeChainStateDisplay(chain.state);
  const reason = chain.reason === null ? null : writeChainStopReasonDisplay(chain.reason);
  return (
    <div data-testid="job-write-chain" data-state={chain.state} data-reason={chain.reason ?? ''}>
      <h3>{chainText.stateHeading}</h3>
      <dl className="facts">
        <dt>{chainText.stateLabel}</dt>
        <dd><span className={toneClass(state.tone)}>{state.label}</span></dd>
        {reason === null ? null : [
          <dt key="reason:name">{chainText.reasonLabel}</dt>,
          <dd key="reason:value"><span className={toneClass(reason.tone)}>{reason.label}</span></dd>,
        ]}
        {/* T41g-3: 自動ログインの間隔を待っている間は、更新を始め直す時刻を出す。 */}
        {chain.nextStartAt === null ? null : [
          <dt key="next:name">{chainText.nextStartAt}</dt>,
          <dd key="next:value" data-testid="job-write-chain-next">{formatDateTime(chain.nextStartAt)}</dd>,
        ]}
      </dl>
      {state.description === null ? null : <p className="muted">{state.description}</p>}
      {reason === null || reason.description === null ? null : <p className="muted">{reason.description}</p>}
      {chain.updateJobId === null ? null : (
        <p>
          <Link to="/jobs/$jobId" params={{ jobId: chain.updateJobId }} data-testid="job-write-chain-update">{chainText.openUpdateJob}</Link>
        </p>
      )}
    </div>
  );
}

/** 詳しい内容の「できたファイル」（要点の主のボタンと書き込みの詳しい記録が出すものを除く）。 */
function JobArtifacts({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const artifacts = job.artifacts.filter(({ kind }) => !ARTIFACTS_SHOWN_ELSEWHERE.has(kind));
  if (job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND || artifacts.length === 0) {
    return null;
  }
  return (
    <section className="panel">
      <h2 className="panel-heading">{text.artifactsHeading}</h2>
      <ul className="link-list" data-testid="job-artifacts">
        {artifacts.map((artifact) => {
          const link = ARTIFACT_LINKS[artifact.kind];
          return (
            <li key={artifact.kind}>
              {link.download ? (
                <a href={artifact.href} download data-artifact={artifact.kind}>{link.label}</a>
              ) : (
                <a href={artifact.href} target="_blank" rel="noopener noreferrer" data-artifact={artifact.kind}>{link.label}</a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// PL-2: 成功のときに、次の画面へ自動で移す（3 章の 5、13 章の最後の段落）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 画面が読み直しを続ける間か（作業が動いている、続けて更新する予定を待つ、まとめて実行が動いている、手でのログインからの自動の登録を待つ）。PL-2: 自動の
 * 登録を待つかは、サーバの要点（`summary.awaitingRegistration`。管理データの日時で決める）を読む。
 */
const isUnsettled = (job: AuditJobDetailView | null | undefined): boolean =>
  job !== undefined && job !== null
  && (job.active || CHAIN_PENDING_STATES.has(job.writeChain?.state ?? '') || job.stageChain?.state === RUNNING_CHAIN_STATE || job.summary.awaitingRegistration);

/**
 * 成功のときに移す（サーバの `summary.advance`）。移すのは、この画面がその作業を動いている間（読み直しの間）に見ていたときだけ（作業の一覧から終わった作業を
 * 開いたときは移さない）。移った先には印（`ARRIVAL_SEARCH`。h1 にフォーカス）と、どの作業から移ったか（`arrivedFromJobSearch`）を付ける。
 */
function useAutoAdvance(job: AuditJobDetailView): void {
  const navigate = useNavigate();
  const watchedJob = useRef<string | null>(isUnsettled(job) ? job.jobId : null);
  const movedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (isUnsettled(job)) {
      watchedJob.current = job.jobId;
    }
    const advance: JobSummaryAdvance | null = job.summary.advance;
    if (advance === null || watchedJob.current !== job.jobId || movedFrom.current === job.jobId) {
      return;
    }
    movedFrom.current = job.jobId;
    // PL-1・PL-5: サイトの詳細と書き込みの手順の詳細の route の `validateSearch` は、この印の鍵（`arrived`・`fromJob`）を受ける。
    const marked = arrivedFromJobSearch(job.jobId);
    switch (advance.kind) {
      case 'SITE':
        void navigate({ to: '/profiles/$profileId', params: { profileId: job.profileId }, search: marked });
        return;
      case 'SCENARIO':
        void navigate({ to: '/scenarios/$profileId/$scenarioId', params: { profileId: job.profileId, scenarioId: advance.scenarioId }, search: marked });
        return;
      case 'JOB':
        void navigate({ to: '/jobs/$jobId', params: { jobId: advance.jobId }, search: { ...ARRIVAL_SEARCH } });
        return;
    }
  }, [job, navigate]);
}

function JobDetailPage() {
  const initial = Route.useLoaderData();
  const { jobId } = Route.useParams();
  const fetchJob = useServerFn(getAuditJobFn);
  const stop = useServerFn(stopAuditJobFn);
  const confirm = useServerFn(confirmManualLoginFn);
  const query = useQuery({
    queryKey: ['audit-job', jobId],
    queryFn: () => fetchJob({ data: { jobId } }),
    initialData: initial,
    // T41g-2: 登録してから更新する、の予定が「登録中」の間は、登録のジョブが終わった後も同じ間隔で読み直す（更新のジョブへのリンクを、読み込み直しなしで出す）。
    // T41g-3: 自動ログインの間隔を待っている間も読み直す。FM2d: まとめて実行の連鎖が動いている間も読み直す（段のジョブが終わった後も、次の段が始まるまで）。
    // ML-b-2: 手動のログインの成功からの自動の登録の結果を、ジョブの管理が終わりの後に書くまで、短い間だけ読み直す（PL-2: サーバの要点が決める）。
    refetchInterval: (current) => (isUnsettled(current.state.data) ? AUDIT_JOB_POLL_INTERVAL_MS : false),
  });
  const [dialog, setDialog] = useState<StopDialogKind | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailure, setStopFailure] = useState<StopFailure | null>(null);
  const [confirmingLogin, setConfirmingLogin] = useState(false);
  // DEF-146（の 3）: 「ログインを終えた」の結果は共通の読み方（`settleServerFunction`）で読む（例外と結果の形でない値は、要求が届かなかった）。
  const [loginConfirmResult, setLoginConfirmResult] = useState<LoginConfirmOutcome | null>(null);
  const job = query.data ?? initial;
  useAutoAdvance(job);
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const { summary } = job;
  const failure = job.failureReason === null ? null : AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[job.failureReason];
  const dialogText = dialog === 'force' ? LOCAL_UI_AUDIT_TEXT.forceStopDialog : LOCAL_UI_AUDIT_TEXT.stopDialog;
  // DEF-146: 止める確認のダイアログの題と確定のボタンに入れる、ジョブの種類の呼び名（カタログ）。OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md`
  // 4.1 の D12）: まとめて実行の段（操作さがし・見るだけの確かめ・書き込み）の作業は、点検の一部なので「点検を止める」（段を止めると、ジョブの管理が連鎖の
  // 全体を止める）。
  const stopKind = job.stageChain === null ? job.jobKind : WORKER_AUDIT_JOB_KIND;
  const stopTarget = AUDIT_JOB_STOP_TARGET_NAMES[stopKind];
  // T44d（Task 44 の設計書 P2-3）: ダイアログの本文も、ジョブの種類ごと（止めたときに何が起きるか。カタログ）。
  const stopBodies = AUDIT_JOB_STOP_DIALOG_BODIES[stopKind];
  const kind = auditJobKindDisplay(job.jobKind);
  // OP-G2（OP-G の指示書の 6）: 見ている作業が動いている間か、まとめて実行の連鎖が動いていて点検の画面にとどまっている間（止めるは連鎖の全体を止める。ジョブの
  // 管理が今の段へ回す）。
  const working = job.active || summary.chainStage !== null;
  const loginCheck = job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND;
  const entryCheckJob = job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND;
  const autoLoginSucceeded = job.autoLogin?.result === AUTOMATED_LOGIN_SUCCEEDED;
  /** OP-G（指示書の 6）: 自動ログインの結果が出て、成功でなかったか（まだ結果のない間は偽。そのときの区画は詳しい内容に置く）。 */
  const autoLoginFailed = job.autoLogin !== null && job.autoLogin.result !== null && !autoLoginSucceeded;
  // PL-V（13 章の 4）: 書き込みの作業は、書き込みの手順の下の 1 行（書き込みの手順の詳細へ戻る道。一番下の戻るボタンの代わり）。
  const trail = job.write === null ? siteTrail(job.profileId) : scenarioTrail(job.profileId, job.write.scenarioId);
  // PL-2（4 章の 2）: 行の登録が要るときは、登録の表のある詳しい内容を開いて出す。
  const detailsOpen = summary.loginStageRegistration === 'NEEDED';

  const confirmLogin = (): void => {
    setConfirmingLogin(true);
    setLoginConfirmResult(null);
    void settleServerFunction<LoginConfirmAccepted, LoginConfirmRejectionReason>(confirm({ data: { jobId: job.jobId } }), isLoginConfirmRejectionReason)
      .then(setLoginConfirmResult)
      .finally(() => setConfirmingLogin(false));
  };

  return (
    // PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 4・10）: 題は作業の種類。h1 の上の 1 行からサイトへ戻る。読み上げの区画は
    // 要点（この欄）の 1 つだけ（ほかの欄は `aria-live` を持たない）。PL-2（3 章の 1）: 要点 → ふだんの画面に出す安全の欄 → 詳しい内容 1 つ。
    <PageFrame title={kind.label} trail={trail}>
      <section className="panel" aria-live="polite" data-testid="job-summary-panel">
        <ResultLine job={job} />
        {/* 書き込みの作業は、サイトに書いたこと（テスト用のサイトに 1 件だけ）を必ず出す（7 章）。 */}
        {job.write === null || kind.description === null ? null : <p data-testid="job-kind-description">{kind.description}</p>}
        {/* PL-S（7 章）: 書き込みの後の要点に、BeakSight は作ったデータを消さないこと。 */}
        {job.write === null ? null : <p data-testid="job-write-no-cleanup">{LOCAL_UI_WRITE_TEXT.noCleanup}</p>}
        {/* 13 章の 11: 待つ間の進み具合（上限の見積もり）と、閉じても続くこと。 */}
        {summary.estimate === null ? null : <ProgressEstimate estimate={summary.estimate} />}
        {working ? <p data-testid="job-auto-refresh">{LOCAL_UI_JOB_SUMMARY_TEXT.autoRefresh(stopTarget)}</p> : null}
        {job.sessionLostUrl === null ? null : (
          <>
            <p data-testid="job-session-lost-page">{LOCAL_UI_JOB_SUMMARY_TEXT.sessionLostPage}</p>
            <p data-testid="job-session-lost-guidance">{LOCAL_UI_AUTH_TEXT.job.sessionLostGuidance}</p>
          </>
        )}
        <LoginRegistrationLine job={job} />
        {/* OP-3（D12）: まとめて実行が止まったときの理由と次にできること（要点の中。ステップの一覧は詳しい内容）。 */}
        {job.stageChain === null ? null : <StageChainStopNotice chain={job.stageChain} jobId={job.jobId} />}
        {summary.incomplete ? <p data-testid="job-incomplete">{LOCAL_UI_JOB_SUMMARY_TEXT.incomplete(DETAILS_HEADING)}</p> : null}

        {failure === null || job.failureReason === null ? null : (
          <Notice kind={job.state === FAILED_AUDIT_JOB_STATE ? 'critical' : 'caution'} heading={text.failureReason}>
            <p data-testid="job-failure" data-reason={job.failureReason}>{failure.description}</p>
            <p>{failure.action}</p>
          </Notice>
        )}
        {/* OP-U: ページが出す送信を通したことは、作業の画面に出さない（通した数は成果物と報告に残す）。 */}
        {/* T30g: 書き込みの `UNKNOWN`・`PARTIAL` は、要点の中で目立たせる（7 章）。 */}
        {job.write === null ? null : <WriteResultWarning result={job.write} />}
        {/* T44e（Task 44 の設計書 P2-4）: 書き込みを送る前の確かめで止めた具体的な理由と、次にできること（`action-run.json` の任意の項目。カタログ）。 */}
        {job.writePrecheckDetail === null ? null : (
          <Notice kind="caution" heading={LOCAL_UI_WRITE_TEXT.precheckDetailHeading}>
            <div data-testid="job-write-precheck-detail" data-detail={job.writePrecheckDetail}>
              <p>{PRECHECK_FAILURE_DETAIL_DESCRIPTIONS[job.writePrecheckDetail].description}</p>
              <p>{PRECHECK_FAILURE_DETAIL_DESCRIPTIONS[job.writePrecheckDetail].action}</p>
            </div>
          </Notice>
        )}
        {/* FM-1（手動の操作を減らす設計書 2.2）: ジョブのブラウザを表示する設定のとき、動いている間は「見るだけ。操作しない」の注意を出す（ログインの確かめと
            入口の確かめは当たらない）。PL-2: 手でのログインを待つ間は出さない（「ログインしてください」と食い違うため。UX-1 の 06）。 */}
        {working && job.jobBrowserShown && !loginCheck && !entryCheckJob && summary.result !== 'AWAITING_LOGIN' ? (
          <Notice kind="caution">
            <p data-testid="job-browser-watch-only">{LOCAL_UI_DISPLAY_SETTINGS_TEXT.watchOnly}</p>
          </Notice>
        ) : null}
        {job.lastNotice === null || !job.active ? null : (
          <Notice kind="caution" heading={text.noticeHeading}>
            <p data-testid="job-notice">{noticeText(job.lastNotice)}</p>
          </Notice>
        )}
        {stopFailure === null ? null : (
          <Notice kind="critical" heading={text.stopRejectedHeading}>
            {stopFailure.kind === 'REJECTED' ? (
              <div data-testid="job-stop-rejection" data-reason={stopFailure.reason}>
                <p>{AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS[stopFailure.reason].description}</p>
                <p>{AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS[stopFailure.reason].action}</p>
              </div>
            ) : (
              // DEF-146: 止める要求が届かなかった（何も出さずに消さない）。
              <p data-testid="job-stop-request-failed">{text.stopRequestFailed}</p>
            )}
          </Notice>
        )}
        {/* ML-b（手動のログインの設計書 2.2、2.4）: 手動のログインを待っている間の「ログインを終えた」（主のボタン）と、押した結果。 */}
        {summary.primary !== 'CONFIRM_LOGIN' ? null : (
          <div data-testid="job-manual-login">
            {loginConfirmResult === null ? null : loginConfirmResult.kind === 'ACCEPTED' ? (
              <p data-testid="job-manual-login-accepted">{LOCAL_UI_MANUAL_LOGIN_TEXT.accepted}</p>
            ) : (
              <Notice kind="caution">
                {loginConfirmResult.kind === 'REJECTED' ? (
                  <div data-testid="job-manual-login-rejection" data-reason={loginConfirmResult.reason}>
                    <p>{LOCAL_UI_MANUAL_LOGIN_TEXT.rejected}</p>
                    <p className="muted">{LOCAL_UI_MANUAL_LOGIN_TEXT.rejectionReasons[loginConfirmResult.reason]}</p>
                  </div>
                ) : (
                  // DEF-146（の 3）: 要求が届かなかった（何も出さずに消さない。ボタンはもう一度押せる）。
                  <div data-testid="job-manual-login-request-failed">
                    <p>{LOCAL_UI_MANUAL_LOGIN_TEXT.rejected}</p>
                    <p className="muted">{LOCAL_UI_MANUAL_LOGIN_TEXT.requestFailed}</p>
                  </div>
                )}
              </Notice>
            )}
          </div>
        )}
        {/* 13 章の 3: 主のボタンは最後・左に 1 つ。二次（止める、ログインの設定を開く）は同じ行の右。 */}
        <div className="button-row">
          <PrimaryAction job={job} onConfirmLogin={confirmLogin} confirmingLogin={confirmingLogin} />
          {job.sessionLostUrl === null ? null : (
            <Link to="/auth-setup/$profileId" params={{ profileId: job.profileId }} className="button" data-testid="job-open-auth-setup">
              {LOCAL_UI_AUTH_TEXT.job.openSetup}
            </Link>
          )}
          {!working || job.state === STOPPING_AUDIT_JOB_STATE ? null : (
            <button type="button" className="button button--danger" onClick={() => setDialog('stop')}>{text.stop(stopTarget)}</button>
          )}
          {job.active && job.forceStopAvailable ? (
            <button type="button" className="button button--danger" onClick={() => setDialog('force')}>{text.forceStop}</button>
          ) : null}
        </div>
        {job.active && job.forceStopAvailable ? <p className="muted">{text.forceStopHint(formatDuration(job.forceStopOfferAfterMs))}</p> : null}
        {!working ? null : (
          <ConfirmDialog
            open={dialog !== null}
            title={dialogText.title(stopTarget)}
            body={dialog === 'force' ? stopBodies.force : stopBodies.stop}
            confirmLabel={dialogText.confirm(stopTarget)}
            cancelLabel={dialogText.cancel}
            confirmTone="danger"
            busy={stopping}
            onCancel={() => setDialog(null)}
            onConfirm={() => {
              setStopping(true);
              setStopFailure(null);
              // DEF-146: 例外（通信の誤り、入力の検証の誤り）と結果の形でない値も、理由として出し、ダイアログを閉じる（もう一度押せる）。
              void settleServerFunction(stop({ data: { jobId: job.jobId, force: dialog === 'force' } }), isStopRejectionReason)
                .then((outcome) => {
                  setStopFailure(outcome.kind === 'ACCEPTED' ? null : outcome);
                  setDialog(null);
                  return query.refetch();
                })
                .finally(() => setStopping(false));
            }}
          />
        )}
      </section>

      {/* 7 章: 安全の違反で止めたときは、何を止めたか（ステップ・画面・押していたボタン）を、ふだんの画面に出す。 */}
      <JobSafetyViolation violation={job.safetyViolation} />

      {/* 自動ログインに失敗した・止めたときは、理由と確かめる入口を、ふだんの画面に出す（成功と、まだ結果のない間は詳しい内容。OP-G の指示書の 6）。 */}
      {!autoLoginFailed ? null : <AutoLoginResult job={job} succeeded={false} />}

      {/* 点検が途中で終わったときの、わけと次にすること（最後まで見たときは、詳しい内容）。 */}
      {job.runEnd === null || job.runStatus === 'COMPLETE' ? null : <RunEndReasons runEnd={job.runEnd} runStatus={job.runStatus} />}
      {/* 操作さがし・見るだけの確かめが途中で終わったときの、わけと次にすること（次にすることがないときは、詳しい内容）。 */}
      {job.profileJobEnd === null || !profileJobEndHasNextStep(job.profileJobEnd) ? null : <ProfileJobEndReason end={job.profileJobEnd} />}

      {/* T43a（Task 43 の設計書 4.1）: ログインの確かめの成功の後に、次の手順（監査の開始）。 */}
      {loginCheck && autoLoginSucceeded && job.currentProfile !== null ? (
        <NextStepLinks profileId={job.profileId} after="LOGIN_CHECK" mode={job.currentProfile.mode} auth={job.currentProfile.auth} />
      ) : null}

      {/* T30g: 書き込みのジョブの結果（送った値・レコードの番号・変えた所は、テスト用のサイトで確かめるのに使う。7 章）。 */}
      {job.write === null ? null : (
        <section className="panel" data-testid="job-write">
          <h2 className="panel-heading">{LOCAL_UI_WRITE_TEXT.resultHeading}</h2>
          <WriteResultDetails result={job.write} />
          {/* T41g（Task 41 の設計書 3.5.1）: 登録してから更新する、の続けて更新する予定と状態（更新のジョブを始めたら、その画面へのリンク）。 */}
          {job.writeChain === null ? null : <WriteChainState chain={job.writeChain} />}
        </section>
      )}

      {/* T43c: 入口の確かめのジョブの、進めないときの次にすること（終わったジョブだけ）。 */}
      {entryCheckJob && !job.active ? (
        <section className="panel">
          <EntryCheckOutcome
            result={job.entryCheck}
            profileId={job.profileId}
            // MI-3: 入口の確かめの後の認証の設定の状態（案で保存したか、保存しなかった理由。求め方はサーバの 1 か所）。
            authSetupState={job.entryCheckAuthSetup}
            // T44e（P2-8）: 手動のログインのプロファイルでは、スクリプトで送るログインの案に、自動の登録の案内を出す。
            manualLogin={job.currentProfile !== null && usesAuthSetup(job.currentProfile.mode, job.currentProfile.auth)
              && !usesAutomatedLogin(job.currentProfile.mode, job.currentProfile.auth)}
          />
        </section>
      ) : null}

      {/* PL-2（3 章の 1・2）: 詳しい内容 1 つ（ジョブの記録にしかない情報は、ここに残す）。 */}
      <AdvancedSettings testId="job-details" openRequested={detailsOpen}>
        <JobFacts job={job} />
        {/* FM2d・OP-3（D12）: まとめて実行の状態とステップの一覧（まとめて実行の段のジョブだけ）。 */}
        {job.stageChain === null ? null : <StageChainSteps chain={job.stageChain} jobId={job.jobId} />}
        <Progress job={job} />
        <AuthState job={job} />
        {/* ML-b（同 2.3）: 手動のログインの成功から自動で登録した設定。PL-2: 済んだ後の見直しの入口は出さない。 */}
        {job.loginSetup === null && job.loginStage?.autoRegistration === undefined ? null : (
          <LoginSetupPanel profileId={job.profileId} setup={job.loginSetup} testId="job-login-setup" showReview={false}>
            {job.loginStage?.autoRegistration === undefined ? null : <AutoRegistrationResult registration={job.loginStage.autoRegistration} />}
          </LoginSetupPanel>
        )}
        <LoginStageBlocked job={job} />
        <JobSafetyViolationDetails violation={job.safetyViolation} />
        {/* DEF-144: 発見のジョブの、外部のアプリへ移るので押さなかったボタンの数と、読み込み直した画面の数。 */}
        <ExternalSchemeProbes counts={job.externalSchemeProbes} />
        {/* T44c: 発見のジョブの、押す数の上限で押せなかった登録・更新の語のボタンの数。 */}
        <PressLimitProbes counts={job.pressLimitProbes} />
        {/* T44c: 監査のジョブの、ページの未完了の理由ごとのページ数（説明と次にできること）。 */}
        <PageIncompleteReasons counts={job.pageIncompleteReasons} />
        {/* T37a: 発見と READ の確かめのジョブの監査の段の数（ログインの段の要約と並べる）。 */}
        <AuditStageCounts job={job} />
        {/* T44e（Task 44 の設計書 P2-7）: 終わり方と理由（監査は `run.json`、発見と READ の確かめは成果物から）。 */}
        {job.runEnd === null || job.runStatus !== 'COMPLETE' ? null : <RunEndReasons runEnd={job.runEnd} runStatus={job.runStatus} />}
        {job.profileJobEnd === null || profileJobEndHasNextStep(job.profileJobEnd) ? null : <ProfileJobEndReason end={job.profileJobEnd} />}
        {/* OP-G（指示書の 6）: 成功と、まだ結果のない間（どちらも再開の画面への入口は出さない）。 */}
        {job.autoLogin === null || autoLoginFailed ? null : <AutoLoginResult job={job} succeeded />}
        {entryCheckJob && !job.active ? <EntryCheckFacts result={job.entryCheck} /> : null}
        {job.write === null ? null : <WriteResultFacts result={job.write} />}
        {job.lastNotice === null || job.active ? null : (
          <Notice kind="caution" heading={text.noticeHeading}>
            <p data-testid="job-notice">{noticeText(job.lastNotice)}</p>
          </Notice>
        )}
        <JobArtifacts job={job} />
      </AdvancedSettings>
    </PageFrame>
  );
}
