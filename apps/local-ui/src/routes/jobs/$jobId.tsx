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
  AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS,
  CLI_TEXT,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_AUTH_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_REPORT_TEXT,
  LOCAL_UI_WRITE_TEXT,
  LOGIN_FORM_INVALID_REASON_DESCRIPTIONS,
  RUN_SUMMARY_TEXT,
  labelWithCodeText,
  siteUnavailableRecheckText,
  siteUnavailableSlowdownText,
} from '../../../../../src/presentation/messages.js';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { WriteResultDetails } from '../../components/WriteResultDetails';
import { AUDIT_JOB_POLL_INTERVAL_MS } from '../../display/job-polling';
import {
  auditJobAuthStateDisplay,
  auditJobEndKindDisplay,
  auditJobKindDisplay,
  auditJobStateDisplay,
  automatedLoginResultDisplay,
  automatedLoginSubmissionDisplay,
  runStatusDisplay,
  toneClass,
} from '../../display/labels';
import {
  getAuditJobFn,
  stopAuditJobFn,
  type AuditJobDetailView,
  type AuditJobStopView,
} from '../../server/audit-job-functions';
import type { JobArtifactKind } from '../../server/artifact-files';

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
});

/** 確かめのダイアログで、どちらの止め方を確かめているか。 */
type StopDialogKind = 'stop' | 'force';

/** 知らせの 1 行（CLI と同じ文言と書式）。 */
const noticeText = (notice: NonNullable<AuditJobDetailView['lastNotice']>): string => {
  switch (notice.kind) {
    case 'SITE_UNAVAILABLE_RECHECK':
      return siteUnavailableRecheckText(notice.url, formatDuration(notice.delayMs), notice.attempt, notice.maxAttempts);
    case 'SITE_UNAVAILABLE_SLOWDOWN':
      return siteUnavailableSlowdownText(formatDuration(notice.minIntervalMs));
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

/** 成功の結果。 */
const AUTOMATED_LOGIN_SUCCEEDED = 'SUCCEEDED';
/** ログインの確かめのジョブの種類。 */
const LOGIN_CHECK_JOB_KIND = 'LOGIN_CHECK';
/** 操作の候補の発見と READ の確かめのジョブの種類（T27f。どちらも進み具合を送らない。T27d の申し送り 5）。 */
const DISCOVERY_JOB_KIND = 'DISCOVERY';
const READ_CHECK_JOB_KIND = 'READ_CHECK';

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
      {job.active ? <p className="muted">{LOCAL_UI_AUDIT_TEXT.job.pollingNote(formatDuration(AUDIT_JOB_POLL_INTERVAL_MS))}</p> : null}
      <p>
        {job.jobKind === DISCOVERY_JOB_KIND ? (
          <Link to="/discovery/$profileId" params={{ profileId: job.profileId }} className="button" data-testid="job-open-discovery">
            {text.openDiscovery}
          </Link>
        ) : (
          <Link to="/read-checks/$profileId" params={{ profileId: job.profileId }} className="button" data-testid="job-open-read-checks">
            {text.openReadChecks}
          </Link>
        )}
      </p>
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
function JobDetailPage() {
  const initial = Route.useLoaderData();
  const { jobId } = Route.useParams();
  const fetchJob = useServerFn(getAuditJobFn);
  const stop = useServerFn(stopAuditJobFn);
  const query = useQuery({
    queryKey: ['audit-job', jobId],
    queryFn: () => fetchJob({ data: { jobId } }),
    initialData: initial,
    refetchInterval: (current) => (current.state.data?.active === true ? AUDIT_JOB_POLL_INTERVAL_MS : false),
  });
  const [dialog, setDialog] = useState<StopDialogKind | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopRejection, setStopRejection] = useState<Extract<AuditJobStopView, { ok: false }> | null>(null);
  const job = query.data ?? initial;
  const text = LOCAL_UI_AUDIT_TEXT.job;
  const state = auditJobStateDisplay(job.state);
  const runStatus = job.runStatus === null ? null : runStatusDisplay(job.runStatus);
  const endKind = job.endKind === null ? null : auditJobEndKindDisplay(job.endKind);
  const failure = job.failureReason === null ? null : AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[job.failureReason];
  const dialogText = dialog === 'force' ? LOCAL_UI_AUDIT_TEXT.forceStopDialog : LOCAL_UI_AUDIT_TEXT.stopDialog;
  // T26e: ログインの確かめのジョブは Run を作らないので、進み具合と成果物の欄を出さない。
  const kind = auditJobKindDisplay(job.jobKind);
  const loginCheck = job.jobKind === LOGIN_CHECK_JOB_KIND;
  // T27f: 発見と READ の確かめのジョブは進み具合を送らないので、進み具合の欄の代わりに、種類と状態だけを示す旨と結果の画面へのリンクを出す。
  const profileJob = job.jobKind === DISCOVERY_JOB_KIND || job.jobKind === READ_CHECK_JOB_KIND;

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
        {loginCheck || profileJob || state.description === null ? null : <p className="muted">{state.description}</p>}
        {kind.description === null ? null : <p className="muted">{kind.description}</p>}
        {endKind === null || endKind.description === null ? null : <p>{endKind.description}</p>}
      </section>

      {failure === null || job.failureReason === null ? null : (
        <Notice kind={job.state === 'FAILED' ? 'critical' : 'caution'} heading={text.failureReason}>
          <p data-testid="job-failure" data-reason={job.failureReason}>{failure.description}</p>
          <p>{failure.action}</p>
        </Notice>
      )}

      <AuthState job={job} />

      <AutoLoginResult job={job} />

      {/* T30g: 書き込みのジョブの結果（`UNKNOWN` は目立たせ、テスト環境での確かめを促す）。 */}
      {job.write === null ? null : (
        <section className="panel" aria-live="polite" data-testid="job-write">
          <h2 className="panel-heading">{LOCAL_UI_WRITE_TEXT.resultHeading}</h2>
          <WriteResultDetails result={job.write} />
          <p>
            <Link to="/scenarios/$profileId/$scenarioId" params={{ profileId: job.profileId, scenarioId: job.write.scenarioId }} className="button">
              {LOCAL_UI_WRITE_TEXT.backToScenario}
            </Link>
          </p>
        </section>
      )}

      {loginCheck ? null : profileJob ? <ProfileJobNote job={job} /> : <Progress job={job} />}

      {job.active ? (
        <section className="panel">
          {stopRejection === null ? null : (
            <Notice kind="critical" heading={text.stopRejectedHeading}>
              <p>{AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS[stopRejection.reason].description}</p>
              <p>{AUDIT_JOB_STOP_REJECTION_DESCRIPTIONS[stopRejection.reason].action}</p>
            </Notice>
          )}
          {job.state === 'STOPPING' ? <p data-testid="job-stop-requested">{text.stopRequested}</p> : null}
          <div className="button-row">
            {job.state === 'STOPPING' ? null : (
              <button type="button" className="button button--danger" onClick={() => setDialog('stop')}>{text.stop}</button>
            )}
            {job.forceStopAvailable ? (
              <button type="button" className="button button--danger" onClick={() => setDialog('force')}>{text.forceStop}</button>
            ) : null}
          </div>
          {job.forceStopAvailable ? <p className="muted">{text.forceStopHint(formatDuration(job.forceStopOfferAfterMs))}</p> : null}
          <ConfirmDialog
            open={dialog !== null}
            title={dialogText.title}
            body={dialogText.body}
            confirmLabel={dialogText.confirm}
            cancelLabel={dialogText.cancel}
            busy={stopping}
            onCancel={() => setDialog(null)}
            onConfirm={() => {
              setStopping(true);
              void stop({ data: { jobId: job.jobId, force: dialog === 'force' } })
                .then((result) => {
                  setDialog(null);
                  setStopRejection(result.ok ? null : result);
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
