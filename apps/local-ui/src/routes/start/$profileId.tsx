import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatCount, formatDateTime, formatDuration, formatElapsedTime } from '../../../../../src/presentation/format.js';
import { LOCAL_UI_AUDIT_TEXT, LOCAL_UI_AUTH_TEXT, LOCAL_UI_TEXT } from '../../../../../src/presentation/messages.js';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { StartReasonDetails } from '../../components/StartReasonDetails';
import {
  auditModeDisplay,
  authSetupFreshnessDisplay,
  automatedLoginResultDisplay,
  profileStatusDisplay,
  toneClass,
} from '../../display/labels';
import {
  auditStartSummaryFn,
  startAuditJobFn,
  type AuditJobStartView,
  type AuditStartSummaryView,
} from '../../server/audit-job-functions';

export const Route = createFileRoute('/start/$profileId')({
  loader: async ({ params }) => {
    const summary = await auditStartSummaryFn({ data: { profileId: params.profileId } });
    if (summary === null) {
      throw notFound();
    }
    return summary;
  },
  component: StartAuditPage,
});

/** 自動ログインの上限の状態（T26e。Task 26 の設計書 4.6。止めているか、次に始められる日時）。 */
function AutoLoginLimitState({ summary }: Readonly<{ summary: AuditStartSummaryView }>) {
  const text = LOCAL_UI_AUTH_TEXT.start;
  const { autoLogin } = summary;
  if (autoLogin === null) {
    return null;
  }
  const state = autoLogin.hold !== null ? 'held' : autoLogin.nextAllowedAt !== null ? 'waiting' : 'ready';
  return (
    <>
      <dt>{text.limitState}</dt>
      <dd data-testid="start-auto-login-limit" data-state={state}>
        {autoLogin.hold !== null
          ? `${text.limitHeld}（${automatedLoginResultDisplay(autoLogin.hold.reason).label}）`
          : autoLogin.nextAllowedAt !== null ? text.limitWaitText(formatDateTime(autoLogin.nextAllowedAt)) : text.limitReady}
      </dd>
    </>
  );
}

/** 認証つきの監査の、ログインの案内と認証の設定の要点（T25e。設計書 4.5。T26e: 自動ログインのプロファイルの案内と上限の状態）。 */
function LoginGuidance({ summary }: Readonly<{ summary: AuditStartSummaryView }>) {
  const text = LOCAL_UI_AUTH_TEXT.start;
  const { authSetup } = summary;
  const freshness = authSetup === null ? null : authSetupFreshnessDisplay(authSetup.freshness);
  const automated = summary.autoLogin !== null;
  return (
    <section className="panel" data-testid="start-login">
      <h2 className="panel-heading">{text.heading}</h2>
      <p data-testid="start-login-guidance" data-automated={automated ? 'yes' : 'no'}>{automated ? text.automatedGuidance : text.guidance}</p>
      <p className="muted">{automated ? text.automatedGuidanceNote : text.guidanceNote}</p>
      {automated ? (
        <dl className="facts">
          <AutoLoginLimitState summary={summary} />
        </dl>
      ) : null}
      {authSetup === null || freshness === null ? null : (
        <dl className="facts" data-testid="start-auth-setup">
          <dt>{text.loginStartUrl}</dt>
          <dd className="cell-break"><code>{authSetup.loginStartUrl}</code></dd>
          <dt>{text.auditScope}</dt>
          <dd className="cell-break">
            {authSetup.auditPathPrefixes.length === 0 ? text.auditScopeAll : (
              <ul className="word-list">
                {authSetup.auditPathPrefixes.map((prefix) => <li key={prefix}><code>{prefix}</code></li>)}
              </ul>
            )}
          </dd>
          <dt>{LOCAL_UI_AUTH_TEXT.setup.state}</dt>
          <dd><span className={toneClass(freshness.tone)}>{freshness.label}</span></dd>
        </dl>
      )}
      <p className="button-row">
        <Link to="/auth-setup/$profileId" params={{ profileId: summary.profileId }}>{text.openSetup}</Link>
        {automated ? <Link to="/credentials/$profileId" params={{ profileId: summary.profileId }}>{text.openCredentials}</Link> : null}
      </p>
    </section>
  );
}

/** 監査の開始（Task 24 の設計書 4.8）。ターゲット設定の要点は読むだけ。始め方（再開か新しく始めるか）だけを選べる。 */
function StartAuditPage() {
  const summary = Route.useLoaderData();
  const start = useServerFn(startAuditJobFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [startNew, setStartNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const text = LOCAL_UI_AUDIT_TEXT.start;
  const status = profileStatusDisplay(summary.status);
  const { target } = summary;

  return (
    <PageFrame title={LOCAL_UI_AUDIT_TEXT.pages.startAudit}>
      <section className="panel">
        <h2 className="panel-heading">{text.profileHeading}</h2>
        <dl className="facts" data-testid="start-profile">
          <dt>{LOCAL_UI_TEXT.profileList.columns.profileId}</dt>
          <dd>{summary.profileId}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.revision}</dt>
          <dd>{LOCAL_UI_TEXT.profileForm.revisionText(summary.revision)}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.mode}</dt>
          <dd>{auditModeDisplay(summary.mode).label}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.status}</dt>
          <dd><span className={toneClass(status.tone)}>{status.label}</span></dd>
          <dt>{text.targetConfigPath}</dt>
          <dd><code>{summary.targetConfigPath}</code></dd>
        </dl>
      </section>

      {target === null ? null : (
        <section className="panel">
          <h2 className="panel-heading">{text.configHeading}</h2>
          <dl className="facts" data-testid="start-target">
            <dt>{text.startUrl}</dt>
            <dd className="cell-break"><code>{target.startUrl}</code></dd>
            <dt>{text.maxPages}</dt>
            <dd>{formatCount(target.maxPages)}</dd>
            <dt>{text.maxRuntime}</dt>
            <dd>{formatElapsedTime(target.maxRuntimeMs)}</dd>
            <dt>{text.minNavigationInterval}</dt>
            <dd data-testid="start-interval">{formatDuration(target.minNavigationIntervalMs)}</dd>
          </dl>
          <p className="muted">{text.configNote}</p>
        </section>
      )}

      {summary.authRequired ? <LoginGuidance summary={summary} /> : null}

      {summary.blocker === null ? (
        <section className="panel">
          {rejection === null ? null : (
            <Notice kind="critical" heading={text.rejectedHeading}>
              <StartReasonDetails
                profileId={summary.profileId}
                reason={rejection.reason}
                errorCodes={rejection.errorCodes}
                configError={null}
                authSetupErrors={rejection.authSetupErrors}
                nextAllowedAt={rejection.nextAllowedAt ?? null}
                showLoginCheckLink
              />
              <div className="button-row">
                <button type="button" className="button" onClick={() => void router.invalidate().then(() => setRejection(null))}>
                  {LOCAL_UI_TEXT.reload}
                </button>
              </div>
            </Notice>
          )}
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitting(true);
              void start({ data: { profileId: summary.profileId, expectedRevision: summary.revision, startNew } })
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
            <fieldset className="field">
              <legend className="field-label">{text.modeLegend}</legend>
              <label className="choice">
                <input type="radio" name="start-mode" value="resume" checked={!startNew} onChange={() => setStartNew(false)} />
                <span>{text.resume}</span>
              </label>
              <p className="field-hint">{text.resumeHint}</p>
              <label className="choice">
                <input type="radio" name="start-mode" value="new" checked={startNew} onChange={() => setStartNew(true)} />
                <span>{text.startNew}</span>
              </label>
              <p className="field-hint">{text.startNewHint}</p>
            </fieldset>
            <div className="button-row">
              <button type="submit" className="button button--primary" disabled={submitting}>
                {submitting ? text.submitting : text.submit}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <Notice kind="critical" heading={text.cannotStartHeading}>
          <StartReasonDetails
            profileId={summary.profileId}
            reason={summary.blocker}
            errorCodes={summary.errorCodes}
            configError={summary.configError}
            authSetupErrors={summary.authSetupErrors}
            nextAllowedAt={summary.nextAllowedAt}
            showLoginCheckLink
          />
        </Notice>
      )}
      <p>
        <Link to="/" className="button">{LOCAL_UI_TEXT.backToList}</Link>
      </p>
    </PageFrame>
  );
}
