import { useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import {
  AUTO_LOGIN_DAILY_MAX_ATTEMPTS,
  AUTO_LOGIN_DAILY_WINDOW_MS,
  AUTO_LOGIN_MIN_INTERVAL_MS,
} from '../../../../../src/control/job/auto-login-limits.js';
import { formatDateTime, formatElapsedTime, formatTimes } from '../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUDIT_TEXT,
  LOCAL_UI_LOGIN_CHECK_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
} from '../../../../../src/presentation/messages.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Notice } from '../../components/Notice';
import { PageFrame, siteTrail } from '../../components/PageFrame';
import { automatedLoginResultDisplay } from '../../display/labels';
import { closedSearchValueOf, isClosedSearchValue } from '../../display/search-values';
import { auditStartSummaryFn } from '../../server/audit-job-functions';
import { clearAutoLoginHoldFn, type CredentialHoldClearView } from '../../server/credential-functions';

/** 停止の解除の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。 */
const HOLD_NOTICES = Object.freeze(['cleared', 'notHeld'] as const);
type HoldNotice = (typeof HOLD_NOTICES)[number];
const isHoldNotice = (value: unknown): value is HoldNotice => isClosedSearchValue(HOLD_NOTICES, value);

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
  formatElapsedTime(AUTO_LOGIN_MIN_INTERVAL_MS),
  formatElapsedTime(AUTO_LOGIN_DAILY_WINDOW_MS),
  formatTimes(AUTO_LOGIN_DAILY_MAX_ATTEMPTS),
);

const HOLD_NOTICE_TEXT: Readonly<Record<HoldNotice, string>> = Object.freeze({ cleared: text.hold.cleared, notHeld: text.hold.notHeld });

/**
 * ログインの確かめの画面（Task 26 の設計書 4.6）。PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 1、3 章の 1、6 章の最後）で、止めた自動ログイン
 * （停止の hold）を再開する入口として、要点のパネル＋詳しい内容 1 つの形にした（ふだんの流れからは行かない）。
 * - 止めているとき: 要点に、なぜ止まったか（止めた理由）と確かめること（人がすること）、主のボタン「確かめたので再開する」（確認のダイアログ。危険の見た目）。
 * - 止めていないとき: 要点に「止まっていません」と、主のボタン「点検を始める」（開始の画面へ。点検の最初の自動ログインが、ログインの確かめを兼ねる）。
 * - ログインだけを試すボタン（`LOGIN_CHECK` のジョブ）はなくした（試すと自動ログインの間隔に当たり、すぐに点検を始められない。点検で兼ねる）。
 * - 詳しい内容: 自動ログインの回数の決まり、止めた日時、ID とパスワードの画面への入口。
 */
function LoginCheckPage() {
  const summary = Route.useLoaderData();
  const { hold: rawHold } = Route.useSearch();
  // MI-C2 項目 19: ルータは根の生の search も子へ渡すので、知らせの値は描く前に閉じた一覧でもう一度確かめる（`display/search-values.ts`）。
  const holdNotice = closedSearchValueOf(HOLD_NOTICES, rawHold);
  const clearHold = useServerFn(clearAutoLoginHoldFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearRejection, setClearRejection] = useState<Extract<CredentialHoldClearView, { ok: false }> | null>(null);
  const { autoLogin } = summary;
  const hold = autoLogin?.hold ?? null;
  const state = autoLogin === null ? 'notAutomated' : hold === null ? 'notHeld' : 'held';

  return (
    <PageFrame title={text.title} trail={siteTrail(summary.profileId)}>
      {/* 3 章の 1: 要点のパネル（なぜ止まったか、確かめること、主のボタン 1 つ。知らせもこの中）。 */}
      <section className="panel" data-testid="login-check-summary" data-state={state}>
        <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.summaryHeading}</h2>
        {holdNotice === undefined ? null : (
          <Notice kind="positive">
            <p data-testid="login-check-hold-notice" data-notice={holdNotice}>{HOLD_NOTICE_TEXT[holdNotice]}</p>
          </Notice>
        )}
        {autoLogin === null ? <p data-testid="login-check-not-automated">{text.summary.notAutomated}</p> : null}
        {autoLogin !== null && hold === null ? (
          <>
            <p data-testid="login-check-not-held">{text.summary.notHeld}</p>
            <div className="button-row">
              <Link to="/start/$profileId" params={{ profileId: summary.profileId }} className="button button--primary" data-testid="login-check-open-start">
                {LOCAL_UI_AUDIT_TEXT.start.submit}
              </Link>
            </div>
          </>
        ) : null}
        {hold === null ? null : (
          <>
            <p>{text.hold.summary}</p>
            <dl className="facts" data-testid="login-check-hold" data-reason={hold.reason}>
              <dt>{text.hold.reason}</dt>
              <dd>{automatedLoginResultDisplay(hold.reason).label}</dd>
              <dt>{text.hold.action}</dt>
              <dd>{AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[hold.reason].action}</dd>
            </dl>
            {clearRejection === null ? null : (
              <Notice kind="critical">
                <p data-testid="login-check-hold-rejection" data-reason={clearRejection.reason}>
                  {CREDENTIAL_REQUEST_REJECTION_DESCRIPTIONS[clearRejection.reason].description}
                </p>
              </Notice>
            )}
            <div className="button-row">
              <button type="button" className="button button--primary" data-testid="login-check-clear-hold" onClick={() => setDialogOpen(true)}>
                {text.hold.clear}
              </button>
            </div>
            <ConfirmDialog
              open={dialogOpen}
              title={text.hold.dialogTitle}
              body={text.hold.dialogBody}
              confirmLabel={text.hold.confirm}
              cancelLabel={text.hold.cancel}
              confirmTone="danger"
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
          </>
        )}
      </section>

      {/* 3 章の 1: 詳しい内容 1 つ（回数の決まり、止めた日時、直す画面への入口）。自動ログインのサイトだけ。 */}
      {autoLogin === null ? null : (
        <section className="panel">
          <AdvancedSettings testId="login-check-advanced-settings">
            <p className="muted" data-testid="login-check-limit-note">{LIMIT_NOTE}</p>
            {hold === null ? null : (
              <dl className="facts">
                <dt>{text.hold.heldAt}</dt>
                <dd data-testid="login-check-held-at">{formatDateTime(hold.heldAt)}</dd>
              </dl>
            )}
            <div className="button-row">
              <Link to="/credentials/$profileId" params={{ profileId: summary.profileId }} className="button">{text.openCredentials}</Link>
            </div>
          </AdvancedSettings>
        </section>
      )}
    </PageFrame>
  );
}
