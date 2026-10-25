import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute, notFound } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatElapsedTime,
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
  LOCAL_UI_LOGIN_CHECK_TEXT,
  PRECHECK_FAILURE_DETAIL_DESCRIPTIONS,
  LOCAL_UI_LOGIN_OBSERVATION_TEXT,
  LOCAL_UI_LOGIN_STAGE_TEXT,
  LOCAL_UI_MANUAL_LOGIN_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_REPORT_TEXT,
  LOCAL_UI_WRITE_TEXT,
  LOGIN_FORM_INVALID_REASON_DESCRIPTIONS,
  LOGIN_STAGE_BLOCK_REASON_LABELS,
  RUN_SUMMARY_TEXT,
  labelWithCodeText,
  listText,
  serviceRequestPacingWaitText,
  siteUnavailableRecheckText,
  siteUnavailableSlowdownText,
} from '../../../../../src/presentation/messages.js';
import { AuditSendNotice } from '../../components/AuditSendNotice';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EntryCheckResult } from '../../components/EntryCheckResult';
import { ProfileJobEndReason, RunEndReasons } from '../../components/JobEndReasons';
import { StageChainPanel } from '../../components/StageChainPanel';
import { ExternalSchemeProbes, JobSafetyViolation, PressLimitProbes } from '../../components/JobSafetyViolation';
import { PageIncompleteReasons } from '../../components/PageIncompleteReasons';
import { LoginStageObservationPanel, LoginStageQueryCell, LoginStageRegisterCell } from '../../components/LoginStageObservation';
import { LoginStageStateNames } from '../../components/LoginStageStateNames';
import { NextStepLinks } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { SessionLossEvidence } from '../../components/SessionLossEvidence';
import { WriteResultDetails } from '../../components/WriteResultDetails';
import { AUDIT_JOB_POLL_INTERVAL_MS, awaitsAutoRegistration } from '../../display/job-polling';
import { closedListReason, settleServerFunction, type ServerFunctionOutcome } from '../../display/server-function-outcome';
import {
  auditJobAuthStateDisplay,
  auditJobEndKindDisplay,
  auditJobKindDisplay,
  auditJobStateDisplay,
  automatedLoginResultDisplay,
  automatedLoginSubmissionDisplay,
  offersAutomatedLogin,
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
  FINISHED_AUDIT_JOB_STATE,
  STOPPING_AUDIT_JOB_STATE,
  WORKER_DISCOVERY_JOB_KIND,
  WORKER_ENTRY_CHECK_JOB_KIND,
  WORKER_LOGIN_CHECK_JOB_KIND,
  WORKER_READ_CHECK_JOB_KIND,
} from '../../../../../src/core/audit-job-values.js';
// PRE42-CC 組 UI-K2（CC-113）: 認証の状態、まとめて実行の状態、続けて更新する状態の値も、純粋な core の owner から読む（書き写さない。文字列で比べない）。
import { RUNNING_CHAIN_STATE } from '../../../../../src/core/stage-chain-states.js';
import { WORKER_AWAITING_LOGIN_STATE } from '../../../../../src/core/worker-auth-states.js';
import { PENDING_WRITE_CHAIN_STATES } from '../../../../../src/core/write-chain-states.js';

export const Route = createFileRoute('/jobs/$jobId')({
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

/** 進み具合（最後の進み具合の知らせを、既存の書式で示す。値は事実のまま、計算しない）。 */
function Progress({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const report = job.lastProgress;
  return (
    <section className="panel" aria-live="polite">
      <h2 className="panel-heading">{text.progressHeading}</h2>
      {report === null ? (
        <p data-testid="job-progress-empty">{text.noProgress}</p>
      ) : (
        <>
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
        </>
      )}
      {job.lastNotice === null ? null : (
        <Notice kind="caution" heading={text.noticeHeading}>
          <p data-testid="job-notice">{noticeText(job.lastNotice)}</p>
        </Notice>
      )}
      {job.active ? <p className="muted">{text.pollingNote(formatDuration(AUDIT_JOB_POLL_INTERVAL_MS))}</p> : null}
    </section>
  );
}

/**
 * 認証つきの監査の、最後の認証の状態（T25e。Task 25 の設計書 4.5）。ログイン待ち、済んだ、止まった理由。セッションが切れて止まったときは、
 * 止まったページの URL（リンクにしない）と、そのページを読まないパスに足す案内と、認証の設定の画面へのリンク。値と秘密は、画面のサーバに
 * 届かない（ジョブの記録には、状態と、伏せ字の後の URL だけがある）。
 */
function AuthState({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_AUTH_TEXT.job;
  if (job.lastAuthState === null) {
    return null;
  }
  const state = auditJobAuthStateDisplay(job.lastAuthState);
  return (
    <section className="panel" aria-live="polite" data-testid="job-auth">
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
      {/* DEF-138: 止まったページの URL の近くに、セッションが切れたと判定した読み込みの記録を出す（記録があるときだけ）。 */}
      <SessionLossEvidence evidence={job.sessionLoss} />
      {job.sessionLostUrl === null ? null : (
        <>
          <p data-testid="job-session-lost-guidance">{text.sessionLostGuidance}</p>
          <p>
            <Link to="/auth-setup/$profileId" params={{ profileId: job.profileId }} className="button" data-testid="job-open-auth-setup">
              {text.openSetup}
            </Link>
          </p>
        </>
      )}
    </section>
  );
}

/**
 * ML-b（手動のログインの設計書 2.3）: 手動のログインの間に通した送信の表（Origin、パス、種類、回数、query の名前、登録）。ML-b-2: 行は、止めた一覧と
 * 同じ形（ジョブのまとめの `passedRequests`。ML-a）で、行の理由は、通さなければ止めた理由。「登録する」は、止めた行と同じ部品
 * （`loginStageRegistrationOf`）を、行のまま使う。
 */
function LoginStagePassed({ jobId, profileId, passed }: Readonly<{ jobId: string; profileId: string; passed: WorkerLoginStageBlockedRequests | undefined }>) {
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
                <th scope="col">{LOCAL_UI_LOGIN_OBSERVATION_TEXT.columns.register}</th>
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
                  <td><code>{request.resourceType}</code></td>
                  <td>{formatTimes(request.count)}</td>
                  <td className="cell-break"><LoginStageQueryCell request={request} /></td>
                  <td><LoginStageRegisterCell profileId={profileId} request={request} target={{ jobId, passed: true, index }} /></td>
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

// ML-b: 手動のログインを待っている認証の状態（この間だけ「ログインを終えた」を出す）。PRE42-CC 組 UI-K2: 値は core の `WORKER_AWAITING_LOGIN_STATE` を読む。

/**
 * ML-b（手動のログインの設計書 2.2、2.4）: ジョブが手動のログインを待っている（`AWAITING_LOGIN`。終わっていないジョブ）ときの、「ログインを終えた」のボタンと
 * 説明。押すとジョブの管理の口を呼ぶ Server Function（POST）を送る。受け付けるかはジョブの管理が決め、拒まれたら理由のコードを出す。
 */
function ManualLoginConfirm({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_MANUAL_LOGIN_TEXT;
  const confirm = useServerFn(confirmManualLoginFn);
  const [busy, setBusy] = useState(false);
  // DEF-146（の 3）: 結果は共通の読み方（`settleServerFunction`）で読む（例外と結果の形でない値は、要求が届かなかった）。
  const [result, setResult] = useState<LoginConfirmOutcome | null>(null);
  if (!job.active || job.lastAuthState !== WORKER_AWAITING_LOGIN_STATE) {
    return null;
  }
  return (
    <section className="panel" aria-live="polite" data-testid="job-manual-login">
      <h2 className="panel-heading">{text.heading}</h2>
      <p data-testid="job-manual-login-note">{text.note}</p>
      <div className="button-row">
        <button
          type="button"
          className="button button--primary"
          data-testid="job-manual-login-confirm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setResult(null);
            void settleServerFunction<LoginConfirmAccepted, LoginConfirmRejectionReason>(confirm({ data: { jobId: job.jobId } }), isLoginConfirmRejectionReason)
              .then(setResult)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? text.confirming : text.confirm}
        </button>
      </div>
      {result === null ? null : result.kind === 'ACCEPTED' ? <p data-testid="job-manual-login-accepted">{text.accepted}</p> : (
        <Notice kind="caution">
          {result.kind === 'REJECTED' ? (
            <div data-testid="job-manual-login-rejection" data-reason={result.reason}>
              <p>{text.rejected}</p>
              <p className="muted">{text.rejectionReasons[result.reason]}</p>
            </div>
          ) : (
            // DEF-146（の 3）: 要求が届かなかった（何も出さずに消さない。ボタンはもう一度押せる）。
            <div data-testid="job-manual-login-request-failed">
              <p>{text.rejected}</p>
              <p className="muted">{text.requestFailed}</p>
            </div>
          )}
        </Notice>
      )}
    </section>
  );
}

/**
 * ML-b-2（手動のログインの設計書 2.3）: このジョブの手動のログインから、設定を自動で登録した結果（ジョブの終わりの後に、ジョブの管理が背後で 1 回だけ書く）。
 * SAVED は、このジョブで登録したことと、保存したプロファイルの改訂と、足した承認したサービスの Origin。SKIPPED は、理由と次にすること（カタログ）。
 */
function AutoRegistrationResult({ registration }: Readonly<{ registration: AuditJobLoginAutoRegistration }>) {
  const text = LOCAL_UI_MANUAL_LOGIN_TEXT.autoRegistration;
  if (registration.result === 'SAVED') {
    return (
      <div data-testid="job-login-auto-registration" data-result={registration.result}>
        <p>{text.saved}</p>
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
 * T34e fix round 1: 値に見える区切りを伏せたパスは、パスに伏せた旨を添える。
 */
function LoginStageBlocked({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_LOGIN_STAGE_TEXT;
  const { loginStage } = job;
  if (loginStage === null) {
    return null;
  }
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
                <th scope="col">{LOCAL_UI_LOGIN_OBSERVATION_TEXT.columns.register}</th>
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
                  <td><code>{request.resourceType}</code></td>
                  <td>{LOGIN_STAGE_BLOCK_REASON_LABELS[request.reason]}</td>
                  <td>{formatTimes(request.count)}</td>
                  <td className="cell-break"><LoginStageQueryCell request={request} /></td>
                  <td><LoginStageRegisterCell profileId={job.profileId} request={request} target={{ jobId: job.jobId, passed: false, index }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {unlisted === 0 ? null : <p data-testid="job-login-stage-unlisted">{text.unlisted(formatCount(unlisted))}</p>}
      {/* ML-b（手動のログインの設計書 2.3）: 手動のログインの間に通した送信（止めた送信と分けて出す。行からも「登録する」を使える）。 */}
      <LoginStagePassed jobId={job.jobId} profileId={job.profileId} passed={loginStage.passedRequests} />
      {requests.length === 0 && unlisted === 0 ? null : (
        <>
          <p data-testid="job-login-stage-guidance">{text.guidance}</p>
          <p>
            <Link to="/auth-setup/$profileId" params={{ profileId: job.profileId }} className="button">{text.openSetup}</Link>
          </p>
        </>
      )}
      {/* T43d: ログインの段で観察した案（成功の鍵の名前と、成功の画面のセレクタ）。 */}
      <LoginStageObservationPanel profileId={job.profileId} observation={loginStage.observation} omitted={loginStage.observationOmitted === true} />
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
// ジョブの種類（PRE42-CC 組 UI-K: 値は `src/core/audit-job-values.ts` の `WORKER_*_JOB_KIND` を読む）: ログインの確かめ、操作の候補の発見と READ の確かめ
// （T27f。どちらも進み具合を送らない。T27d の申し送り 5）、入口の確かめ（T43c。進み具合を送らない。終わったら結果を出す）。

/**
 * 操作の候補の発見と READ の確かめのジョブの欄（T27f。Task 27 の設計書 4.7）。進み具合の知らせを送らないので、進み具合の代わりに、そのことと、
 * 結果を見る画面へのリンクを出す（種類と状態は、上の要点の欄に出る）。
 */
function ProfileJobNote({ job }: Readonly<{ job: AuditJobDetailView }>) {
  const text = LOCAL_UI_DISCOVERY_TEXT.job;
  return (
    <section className="panel" aria-live="polite" data-testid="job-profile-job">
      <h2 className="panel-heading">{LOCAL_UI_AUDIT_TEXT.job.progressHeading}</h2>
      <p data-testid="job-no-progress">{text.noProgress}</p>
      {/* DEF-136: 発見と READ の確かめのジョブも、サイトの不調の確かめ直しを待つ間と減速を、監査と同じ知らせで出す。 */}
      {job.lastNotice === null ? null : (
        <Notice kind="caution" heading={LOCAL_UI_AUDIT_TEXT.job.noticeHeading}>
          <p data-testid="job-notice">{noticeText(job.lastNotice)}</p>
        </Notice>
      )}
      {job.active ? <p className="muted">{LOCAL_UI_AUDIT_TEXT.job.pollingNote(formatDuration(AUDIT_JOB_POLL_INTERVAL_MS))}</p> : null}
      {/* T43c: 入口の確かめのジョブは、結果をこの画面に出すので、ほかの画面へのリンクを出さない。 */}
      {job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND ? null : (
        <p>
          {job.jobKind === WORKER_DISCOVERY_JOB_KIND ? (
            <Link to="/discovery/$profileId" params={{ profileId: job.profileId }} className="button" data-testid="job-open-discovery">
              {text.openDiscovery}
            </Link>
          ) : (
            <Link to="/read-checks/$profileId" params={{ profileId: job.profileId }} className="button" data-testid="job-open-read-checks">
              {text.openReadChecks}
            </Link>
          )}
        </p>
      )}
    </section>
  );
}

/**
 * 自動ログインの試しの結果（T26e。Task 26 の設計書 4.6）。結果、送信、サーバが示した次に試してよい日時、フォームの確かめの理由（カタログと文言の
 * 表示）と、結果ごとの人がすること（ジョブの失敗の理由の文言の手順。失敗の欄に同じ手順が出ているときは、重ねて出さない）。値は画面のサーバに届かない。
 */
function AutoLoginResult({ job }: Readonly<{ job: AuditJobDetailView }>) {
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
    <section className="panel" aria-live="polite" data-testid="job-auto-login">
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
      <p>
        <Link to="/login-check/$profileId" params={{ profileId: job.profileId }} className="button">{text.openLoginCheck}</Link>
      </p>
    </section>
  );
}

/** 監査のジョブの詳細と進み具合（Task 24 の設計書 4.8）。終わっていない間だけ、名前つきの間隔で読み直す。 */
/**
 * T41g（Task 41 の設計書 3.5.1）: 登録のジョブの、続けて更新する予定と状態（「登録してから更新する」で始めた登録のジョブだけ）。状態と理由のラベルは
 * カタログ。更新のジョブを始めたら、その画面へのリンクを出す。
 */
/**
 * T41g-2: 続けて更新する予定が、まだ決まっていない状態（この間は、ジョブが終わった後も読み直しを続ける）。登録のジョブの終わりを待っている間と、T41g-3 の
 * 自動ログインの間隔を待っている間。PRE42-CC 組 UI-K2: 一覧は core の `PENDING_WRITE_CHAIN_STATES` を読む（ここに書き写さない）。
 */
const CHAIN_PENDING_STATES: ReadonlySet<string> = new Set<string>(PENDING_WRITE_CHAIN_STATES);

function WriteChainState({ chain }: Readonly<{ chain: NonNullable<AuditJobDetailView['writeChain']> }>) {
  const chainText = LOCAL_UI_WRITE_TEXT.chain;
  const state = writeChainStateDisplay(chain.state);
  const reason = chain.reason === null ? null : writeChainStopReasonDisplay(chain.reason);
  return (
    <div data-testid="job-write-chain" data-state={chain.state} data-reason={chain.reason ?? ''}>
      <h3>{chainText.stateHeading}</h3>
      <dl className="facts">
        <dt>{chainText.updateScenario}</dt>
        <dd><code>{chain.updateScenarioId}</code></dd>
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

function JobDetailPage() {
  const initial = Route.useLoaderData();
  const { jobId } = Route.useParams();
  const fetchJob = useServerFn(getAuditJobFn);
  const stop = useServerFn(stopAuditJobFn);
  const query = useQuery({
    queryKey: ['audit-job', jobId],
    queryFn: () => fetchJob({ data: { jobId } }),
    initialData: initial,
    // T41g-2: 登録してから更新する、の予定が「登録中」の間は、登録のジョブが終わった後も同じ間隔で読み直す（更新のジョブへのリンクを、読み込み直しなしで出す）。
    // T41g-3: 自動ログインの間隔を待っている間も読み直す。
    // ML-b-2: 手動のログインの成功からの自動の登録の結果を、ジョブの管理が終わりの後に書くまで、短い間だけ読み直す（`awaitsAutoRegistration`）。
    refetchInterval: (current) => {
      const data = current.state.data;
      // FM2d: まとめて実行の連鎖が動いている間も読み直す（段のジョブが終わった後も、次の段が始まるまで）。
      return data?.active === true || CHAIN_PENDING_STATES.has(data?.writeChain?.state ?? '') || data?.stageChain?.state === RUNNING_CHAIN_STATE
        || (data !== undefined && data !== null && awaitsAutoRegistration(data, Date.now()))
        ? AUDIT_JOB_POLL_INTERVAL_MS
        : false;
    },
  });
  const [dialog, setDialog] = useState<StopDialogKind | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopFailure, setStopFailure] = useState<StopFailure | null>(null);
  const job = query.data ?? initial;
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const state = auditJobStateDisplay(job.state);
  const runStatus = job.runStatus === null ? null : runStatusDisplay(job.runStatus);
  const endKind = job.endKind === null ? null : auditJobEndKindDisplay(job.endKind);
  const failure = job.failureReason === null ? null : AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[job.failureReason];
  const dialogText = dialog === 'force' ? LOCAL_UI_AUDIT_TEXT.forceStopDialog : LOCAL_UI_AUDIT_TEXT.stopDialog;
  // DEF-146: 止める確認のダイアログの題と確定のボタンに入れる、ジョブの種類の呼び名（カタログ）。
  const stopTarget = AUDIT_JOB_STOP_TARGET_NAMES[job.jobKind];
  // T44d（Task 44 の設計書 P2-3）: ダイアログの本文も、ジョブの種類ごと（止めたときに何が起きるか。カタログ）。
  const stopBodies = AUDIT_JOB_STOP_DIALOG_BODIES[job.jobKind];
  // T26e: ログインの確かめのジョブは Run を作らないので、進み具合と成果物の欄を出さない。
  const kind = auditJobKindDisplay(job.jobKind);
  const loginCheck = job.jobKind === WORKER_LOGIN_CHECK_JOB_KIND;
  // T27f: 発見と READ の確かめのジョブは進み具合を送らないので、進み具合の欄の代わりに、種類と状態だけを示す旨と結果の画面へのリンクを出す。
  const profileJob = job.jobKind === WORKER_DISCOVERY_JOB_KIND || job.jobKind === WORKER_READ_CHECK_JOB_KIND;
  // T43c: 入口の確かめのジョブも進み具合を送らない（1 回の読み込みだけ）。終わったら、読んだ事実と案を出す。
  const entryCheckJob = job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND;

  return (
    <PageFrame title={LOCAL_UI_AUDIT_TEXT.pages.jobDetail}>
      <section className="panel">
        <h2 className="panel-heading">{text.summaryHeading}</h2>
        <dl className="facts" data-testid="job-summary">
          <dt>{text.state}</dt>
          <dd><span className={toneClass(state.tone)} data-testid="job-state" data-state={job.state}>{state.label}</span></dd>
          <dt>{LOCAL_UI_LOGIN_CHECK_TEXT.job.kind}</dt>
          <dd data-testid="job-kind" data-kind={job.jobKind}>{auditJobKindDisplay(job.jobKind).label}</dd>
          <dt>{text.profileId}</dt>
          <dd>
            <Link to="/profiles/$profileId" params={{ profileId: job.profileId }}>{job.profileId}</Link>
            {' '}
            {LOCAL_UI_TEXT.profileForm.revisionText(job.profileRevision)}
          </dd>
          {/* T26e: ログインの確かめは Run を作らないので、始め方と Run の項目を出さない。 */}
          {loginCheck ? null : (
            <>
              <dt>{text.startMode}</dt>
              <dd>{job.startNew ? LOCAL_UI_AUDIT_TEXT.start.startNew : LOCAL_UI_AUDIT_TEXT.start.resume}</dd>
              <dt>{text.runId}</dt>
              <dd data-testid="job-run-id">{job.runId ?? text.none}</dd>
              <dt>{text.runStatus}</dt>
              <dd>
                {runStatus === null || job.runStatus === null ? text.none : (
                  <span className={toneClass(runStatus.tone)} data-testid="job-run-status" data-run-status={job.runStatus}>
                    {labelWithCodeText(runStatus.label, job.runStatus)}
                  </span>
                )}
              </dd>
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
        {/* 状態の説明は監査のもの（Run の状態、続きからの再開）なので、ログインの確かめでは、種類の説明だけを出す。 */}
        {/* T27f: 発見と READ の確かめのジョブは再開しないので、監査の状態の説明（続きからの再開の案内を含む）も出さない。 */}
        {loginCheck || profileJob || entryCheckJob || state.description === null ? null : <p className="muted">{state.description}</p>}
        {kind.description === null ? null : <p className="muted">{kind.description}</p>}
        {endKind === null || endKind.description === null ? null : <p>{endKind.description}</p>}
        {/* T44e（Task 44 の設計書 P2-7）: 監査のジョブの終わり方の、次にできること（カタログ。説明が手順を含むものは出さない）。 */}
        {job.endKind === null || LOCAL_UI_JOB_NEXT_STEPS.endKinds[job.endKind] === null ? null : (
          <p data-testid="job-end-kind-next">{LOCAL_UI_JOB_NEXT_STEPS.endKinds[job.endKind]}</p>
        )}
      </section>

      {failure === null || job.failureReason === null ? null : (
        <Notice kind={job.state === FAILED_AUDIT_JOB_STATE ? 'critical' : 'caution'} heading={text.failureReason}>
          <p data-testid="job-failure" data-reason={job.failureReason}>{failure.description}</p>
          <p>{failure.action}</p>
        </Notice>
      )}

      {/* FM2d: まとめて実行の段の一覧と状態、止まった理由と次にできること（まとめて実行の段のジョブだけ）。 */}
      {job.stageChain === null ? null : <StageChainPanel chain={job.stageChain} jobId={job.jobId} />}

      {/* T44e（Task 44 の設計書 P2-7）: 終わり方と理由（監査は `run.json`、発見と READ の確かめは成果物から。説明はカタログ、次にできることも出す）。 */}
      {job.runEnd === null ? null : <RunEndReasons runEnd={job.runEnd} runStatus={job.runStatus} />}
      {job.profileJobEnd === null ? null : <ProfileJobEndReason end={job.profileJobEnd} />}

      {/* FM-1（手動の操作を減らす設計書 2.2）: 監査・発見・READ の確かめ・書き込みのジョブのブラウザを表示する設定のとき、動いている間は「見るだけ。
          操作しない」の注意を出す（ログインの確かめと入口の確かめは当たらない）。 */}
      {job.active && job.jobBrowserShown && !loginCheck && !entryCheckJob ? (
        <Notice kind="caution">
          <p data-testid="job-browser-watch-only">{LOCAL_UI_DISPLAY_SETTINGS_TEXT.watchOnly}</p>
        </Notice>
      ) : null}

      {/* AS-b（監査の段の送信の扱いの設計書 2.3）: 結果の記録の扱いが、ページが出す送信を通す扱いなら、目立つ形で知らせる（出すかは表示カタログ。文言は報告と共用）。 */}
      <AuditSendNotice auditSend={job.auditSend} />

      <AuthState job={job} />

      {/* ML-b（手動のログインの設計書 2.2、2.4）: 手動のログインを待っている間の「ログインを終えた」。 */}
      <ManualLoginConfirm job={job} />

      {/* ML-b（同 2.3）: 手動のログインの成功から自動で登録した設定（見直して直す入口）。ML-b-2: このジョブからの登録の結果も、同じ欄に出す。 */}
      {job.loginSetup === null && job.loginStage?.autoRegistration === undefined ? null : (
        <LoginSetupPanel
          profileId={job.profileId}
          setup={job.loginSetup}
          testId="job-login-setup"
          // FM-1（手動の操作を減らす設計書 2.3）: このジョブが手動のログインから登録した（SAVED）ときに、「次から自動でログインする」を案内する。
          offerAutomatedLogin={job.loginStage?.autoRegistration?.result === 'SAVED' && job.currentProfile !== null
            && offersAutomatedLogin(job.currentProfile.mode, job.currentProfile.auth)}
        >
          {job.loginStage?.autoRegistration === undefined ? null : <AutoRegistrationResult registration={job.loginStage.autoRegistration} />}
        </LoginSetupPanel>
      )}

      <LoginStageBlocked job={job} />

      {/* DEF-144: 発見と READ の確かめのジョブが安全の違反で止まったときの、違反の中身（種類・段・場所。値は成果物にない）。 */}
      <JobSafetyViolation violation={job.safetyViolation} />

      {/* DEF-144: 発見のジョブの、外部のアプリへ移るので押さなかったボタンの数と、読み込み直した画面の数。 */}
      <ExternalSchemeProbes counts={job.externalSchemeProbes} />
      {/* T44c: 発見のジョブの、押す数の上限で押せなかった登録・更新の語のボタンの数。 */}
      <PressLimitProbes counts={job.pressLimitProbes} />
      {/* T44c: 監査のジョブの、ページの未完了の理由ごとのページ数（説明と次にできること）。 */}
      <PageIncompleteReasons counts={job.pageIncompleteReasons} />

      {/* T37a: 発見と READ の確かめのジョブの監査の段の数（ログインの段の要約と並べる）。 */}
      <AuditStageCounts job={job} />

      <AutoLoginResult job={job} />

      {/* T43a（Task 43 の設計書 4.1）: ログインの確かめの成功の後に、次の手順（監査の開始）と「次にすること」へのリンク。 */}
      {loginCheck && job.autoLogin?.result === AUTOMATED_LOGIN_SUCCEEDED && job.currentProfile !== null ? (
        <NextStepLinks profileId={job.profileId} after="LOGIN_CHECK" mode={job.currentProfile.mode} auth={job.currentProfile.auth} />
      ) : null}

      {/* T30g: 書き込みのジョブの結果（`UNKNOWN` は目立たせ、テスト環境での確かめを促す）。 */}
      {job.write === null ? null : (
        <section className="panel" aria-live="polite" data-testid="job-write">
          <h2 className="panel-heading">{LOCAL_UI_WRITE_TEXT.resultHeading}</h2>
          <WriteResultDetails result={job.write} />
          {/* T41g（Task 41 の設計書 3.5.1）: 登録してから更新する、の続けて更新する予定と状態（更新のジョブを始めたら、その画面へのリンク）。 */}
          {job.writeChain === null ? null : <WriteChainState chain={job.writeChain} />}
          <p>
            <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId: job.profileId, scenarioId: job.write.scenarioId }} className="button">
              {LOCAL_UI_WRITE_TEXT.backToScenario}
            </Link>
          </p>
        </section>
      )}

      {/* T44e（Task 44 の設計書 P2-4）: 書き込みを送る前の確かめで止めた具体的な理由と、次にできること（`action-run.json` の任意の項目。カタログ）。 */}
      {job.writePrecheckDetail === null ? null : (
        <Notice kind="caution" heading={LOCAL_UI_WRITE_TEXT.precheckDetailHeading}>
          <div data-testid="job-write-precheck-detail" data-detail={job.writePrecheckDetail}>
            <p>{PRECHECK_FAILURE_DETAIL_DESCRIPTIONS[job.writePrecheckDetail].description}</p>
            <p>{PRECHECK_FAILURE_DETAIL_DESCRIPTIONS[job.writePrecheckDetail].action}</p>
          </div>
        </Notice>
      )}

      {/* T43c: 入口の確かめのジョブの結果（終わったジョブだけ）。 */}
      {entryCheckJob && job.state === FINISHED_AUDIT_JOB_STATE ? (
        <EntryCheckResult
          result={job.entryCheck}
          profileId={job.profileId}
          usesAuthSetup={job.currentProfile !== null && usesAuthSetup(job.currentProfile.mode, job.currentProfile.auth)}
          // T44e（P2-8）: 手動のログインのプロファイルでは、スクリプトで送るログインの案に、自動の登録の案内を出す。
          manualLogin={job.currentProfile !== null && usesAuthSetup(job.currentProfile.mode, job.currentProfile.auth)
            && !usesAutomatedLogin(job.currentProfile.mode, job.currentProfile.auth)}
        />
      ) : null}

      {loginCheck || (entryCheckJob && !job.active) ? null : profileJob || entryCheckJob ? <ProfileJobNote job={job} /> : <Progress job={job} />}

      {job.active ? (
        <section className="panel">
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
          {/* T44d: 止める要求の後の文も、ジョブの種類ごと（カタログ）。 */}
          {job.state === STOPPING_AUDIT_JOB_STATE ? <p data-testid="job-stop-requested">{AUDIT_JOB_STOP_REQUESTED_TEXTS[job.jobKind]}</p> : null}
          <div className="button-row">
            {job.state === STOPPING_AUDIT_JOB_STATE ? null : (
              <button type="button" className="button button--danger" onClick={() => setDialog('stop')}>{text.stop(stopTarget)}</button>
            )}
            {job.forceStopAvailable ? (
              <button type="button" className="button button--danger" onClick={() => setDialog('force')}>{text.forceStop}</button>
            ) : null}
          </div>
          {job.forceStopAvailable ? <p className="muted">{text.forceStopHint(formatDuration(job.forceStopOfferAfterMs))}</p> : null}
          <ConfirmDialog
            open={dialog !== null}
            title={dialogText.title(stopTarget)}
            body={dialog === 'force' ? stopBodies.force : stopBodies.stop}
            confirmLabel={dialogText.confirm(stopTarget)}
            cancelLabel={dialogText.cancel}
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
        </section>
      ) : null}

      {loginCheck ? null : (
      <section className="panel">
        <h2 className="panel-heading">{text.artifactsHeading}</h2>
        {job.artifacts.length === 0 ? (
          <p data-testid="job-artifacts-empty">{text.noArtifacts}</p>
        ) : (
          <ul className="link-list" data-testid="job-artifacts">
            {job.artifacts.map((artifact) => {
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
        )}
      </section>
      )}
      <p>
        <Link to="/jobs" className="button">{LOCAL_UI_AUDIT_TEXT.pages.jobs}</Link>
      </p>
    </PageFrame>
  );
}
