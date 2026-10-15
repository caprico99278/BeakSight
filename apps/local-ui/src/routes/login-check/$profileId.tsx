import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  AUTO_LOGIN_DAILY_MAX_ATTEMPTS,
  AUTO_LOGIN_DAILY_WINDOW_MS,
  AUTO_LOGIN_MIN_INTERVAL_MS,
} from '../../../../../src/control/job/auto-login-limits.js';
import { formatDateTime, formatDuration, formatTimes } from '../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_TEXT,
} from '../../../../../src/presentation/messages.js';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Notice } from '../../components/Notice';
import { PageFrame } from '../../components/PageFrame';
import { StartReasonDetails } from '../../components/StartReasonDetails';
import { auditModeDisplay, automatedLoginResultDisplay, authStrategyDisplay, profileStatusDisplay, toneClass } from '../../display/labels';
import { auditStartSummaryFn, startLoginCheckFn, type AuditJobStartView } from '../../server/audit-job-functions';
import { clearAutoLoginHoldFn, type CredentialHoldClearView } from '../../server/credential-functions';

/** 停止の解除の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
const HOLD_NOTICES = Object.freeze(['cleared', 'notHeld'] as const);
type HoldNotice = (typeof HOLD_NOTICES)[number];
const isHoldNotice = (value: unknown): value is HoldNotice => HOLD_NOTICES.some((notice) => notice === value);

export const Route = createFileRoute('/login-check/$profileId')({
  validateSearch: (search: Record<string, unknown>): { hold?: HoldNotice } => (isHoldNotice(search['hold']) ? { hold: search['hold'] } : {}),
  loader: async ({ params }) => {
    const summary = await auditStartSummaryFn({ data: { profileId: params.profileId } });
    if (summary === null) {
      throw notFound();
    }
    return summary;
  },
  component: LoginCheckPage,
});

const text = LOCAL_UI_LOGIN_CHECK_TEXT;

/** 上限の説明（名前つきの定数を、既存の書式で示す）。 */
const LIMIT_NOTE = text.limitNote(
  formatDuration(AUTO_LOGIN_MIN_INTERVAL_MS),
  formatDuration(AUTO_LOGIN_DAILY_WINDOW_MS),
  formatTimes(AUTO_LOGIN_DAILY_MAX_ATTEMPTS),
);

const HOLD_NOTICE_TEXT: Readonly<Record<HoldNotice, string>> = Object.freeze({ cleared: text.hold.cleared, notHeld: text.hold.notHeld });

/**
 * ログインの確かめ（Task 26 の設計書 4.6）。保存した資格情報でログインだけを 1 回試すジョブ（`LOGIN_CHECK`）を始める。始められない理由
 * （開始の画面と同じ確かめ。判定はサーバ）を出し、始められないときは開始のボタンを出さない。止めているときは、理由と、人が確かめた後に再び許す操作
 * （確かめのダイアログの後）を出す。
 */
function LoginCheckPage() {
  const summary = Route.useLoaderData();
  const { hold: holdNotice } = Route.useSearch();
  const start = useServerFn(startLoginCheckFn);
  const clearHold = useServerFn(clearAutoLoginHoldFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearRejection, setClearRejection] = useState<Extract<CredentialHoldClearView, { ok: false }> | null>(null);
  const status = profileStatusDisplay(summary.status);
  const { loginCheck, autoLogin } = summary;
  const hold = autoLogin?.hold ?? null;

  return (
    <PageFrame title={text.pages.loginCheck}>
      {holdNotice === undefined ? null : (
        <Notice kind="positive">
          <p data-testid="login-check-hold-notice" data-notice={holdNotice}>{HOLD_NOTICE_TEXT[holdNotice]}</p>
        </Notice>
      )}
      <section className="panel">
        <h2 className="panel-heading">{summary.profileId}</h2>
        <dl className="facts" data-testid="login-check-profile">
          <dt>{LOCAL_UI_TEXT.profileList.columns.revision}</dt>
          <dd>{LOCAL_UI_TEXT.profileForm.revisionText(summary.revision)}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.mode}</dt>
          <dd>{auditModeDisplay(summary.mode).label}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.auth}</dt>
          <dd>{authStrategyDisplay(summary.auth).label}</dd>
          <dt>{LOCAL_UI_TEXT.profileList.columns.status}</dt>
          <dd><span className={toneClass(status.tone)}>{status.label}</span></dd>
        </dl>
      </section>

      <section className="panel">
        <h2 className="panel-heading">{text.heading}</h2>
        <p data-testid="login-check-guidance">{text.guidance}</p>
        <p className="muted">{LIMIT_NOTE}</p>
      </section>

      {hold === null ? null : (
        <Notice kind="caution" heading={text.hold.heading}>
          <dl className="facts" data-testid="login-check-hold" data-reason={hold.reason}>
            <dt>{text.hold.reason}</dt>
            <dd>{automatedLoginResultDisplay(hold.reason).label}</dd>
            <dt>{text.hold.heldAt}</dt>
            <dd>{formatDateTime(hold.heldAt)}</dd>
            <dt>{text.hold.action}</dt>
            <dd>{AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[hold.reason].action}</dd>
          </dl>
          {clearRejection === null ? null : (
            <p data-testid="login-check-hold-rejection" data-reason={clearRejection.reason}>
              {CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[clearRejection.reason].description}
            </p>
          )}
          <div className="button-row">
            <button type="button" className="button" data-testid="login-check-clear-hold" onClick={() => setDialogOpen(true)}>
              {text.hold.clear}
            </button>
          </div>
          <ConfirmDialog
            open={dialogOpen}
            title={text.hold.dialogTitle}
            body={text.hold.dialogBody}
            confirmLabel={text.hold.confirm}
            cancelLabel={text.hold.cancel}
            busy={clearing}
            onCancel={() => setDialogOpen(false)}
            onConfirm={() => {
              setClearing(true);
              void clearHold({ data: { profileId: summary.profileId } })
                .then((result) => {
                  setDialogOpen(false);
                  if (!result.ok) {
                    setClearRejection(result);
                    return undefined;
                  }
                  setClearRejection(null);
                  return router.invalidate().then(() => navigate({
                    to: '/login-check/$profileId',
                    params: { profileId: summary.profileId },
                    search: { hold: result.cleared ? 'cleared' : 'notHeld' },
                    replace: true,
                  }));
                })
                .finally(() => setClearing(false));
            }}
          />
        </Notice>
      )}

      {loginCheck.blocker === null ? (
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
                showLoginCheckLink={false}
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
              void start({ data: { profileId: summary.profileId, expectedRevision: summary.revision } })
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
            <div className="button-row">
              <button type="submit" className="button button--primary" disabled={submitting} data-testid="login-check-start">
                {submitting ? text.submitting : text.submit}
              </button>
            </div>
          </form>
        </section>
      ) : (
        <Notice kind="critical" heading={text.cannotStartHeading}>
          <StartReasonDetails
            profileId={summary.profileId}
            reason={loginCheck.blocker}
            errorCodes={loginCheck.errorCodes}
            configError={summary.configError}
            authSetupErrors={loginCheck.authSetupErrors}
            nextAllowedAt={loginCheck.nextAllowedAt}
            showLoginCheckLink={false}
          />
        </Notice>
      )}
      <div className="button-row">
        {autoLogin === null ? null : (
          <Link to="/credentials/$profileId" params={{ profileId: summary.profileId }} className="button">{text.openCredentials}</Link>
        )}
        <Link to="/profiles/$profileId" params={{ profileId: summary.profileId }} className="button">{LOCAL_UI_CREDENTIAL_TEXT.backToProfile}</Link>
      </div>
    </PageFrame>
  );
}
