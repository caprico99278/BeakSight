/**
 * 入口の確かめの欄（Task 43 の設計書 4.3。T43c）。プロファイルの詳細と認証の設定の画面が共用する。
 * - 「入口を確かめる」: 始められるときは押せる。始められないときは、押せない形で、開始の確かめ（ジョブの管理と同じ順）の理由を出す。押した結果の拒否も
 *   同じ形で出す。始めたらジョブの詳細へ移る。
 * - 最後に成功した入口の確かめ（ジョブへのリンク、終わった日時、案を作れたか）。
 */
import { useState } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatDateTime } from '../../../../src/presentation/format.js';
import { LOCAL_UI_ENTRY_CHECK_TEXT, LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import type { AuditJobStartView } from '../server/audit-job-functions';
import { startEntryCheckFn, type EntryCheckSummaryView } from '../server/entry-check-functions';
import { Notice } from './Notice';
import { StartReasonDetails } from './StartReasonDetails';

export function EntryCheckPanel({ summary }: Readonly<{ summary: EntryCheckSummaryView }>) {
  const text = LOCAL_UI_ENTRY_CHECK_TEXT.panel;
  const start = useServerFn(startEntryCheckFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<Extract<AuditJobStartView, { ok: false }> | null>(null);
  const { latest } = summary;
  const blocker = summary.start.blocker;
  return (
    <section className="panel" data-testid="entry-check-panel">
      <h2 className="panel-heading">{text.heading}</h2>
      <p>{text.body}</p>
      {rejection === null ? null : (
        <Notice kind="critical" heading={text.rejectedHeading}>
          <div data-testid="entry-check-rejected" data-reason={rejection.reason}>
            <StartReasonDetails
              profileId={summary.profileId}
              reason={rejection.reason}
              errorCodes={rejection.errorCodes}
              configError={null}
              authSetupErrors={rejection.authSetupErrors}
              nextAllowedAt={rejection.nextAllowedAt ?? null}
              showLoginCheckLink={false}
            />
          </div>
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
          disabled={blocker !== null || submitting}
          aria-describedby={blocker === null ? undefined : 'entry-check-start-reason'}
          data-testid="entry-check-start"
          onClick={() => {
            setSubmitting(true);
            void start({ data: { profileId: summary.profileId, expectedRevision: summary.revision } })
              .then((started) => {
                if (started.ok) {
                  setRejection(null);
                  return navigate({ to: '/jobs/$jobId', params: { jobId: started.jobId } });
                }
                setRejection(started);
                return undefined;
              })
              .finally(() => setSubmitting(false));
          }}
        >
          {submitting ? text.starting : text.start}
        </button>
      </div>
      {blocker === null ? null : (
        <div id="entry-check-start-reason" data-testid="entry-check-start-reason" data-reason={blocker}>
          <p>{text.cannotStart}</p>
          <StartReasonDetails
            profileId={summary.profileId}
            reason={blocker}
            errorCodes={summary.start.errorCodes}
            configError={summary.configError}
            authSetupErrors={summary.start.authSetupErrors}
            nextAllowedAt={summary.start.nextAllowedAt}
            showLoginCheckLink={false}
          />
        </div>
      )}
      <h3>{text.latestHeading}</h3>
      {latest === null ? <p data-testid="entry-check-no-latest">{text.noLatest}</p> : (
        <div data-testid="entry-check-latest" data-job-id={latest.jobId}>
          <dl className="facts">
            <dt>{text.latestFinishedAt}</dt>
            <dd>{latest.finishedAt === null ? '' : formatDateTime(latest.finishedAt)}</dd>
          </dl>
          <p data-testid="entry-check-latest-proposal" data-proposal={String(latest.result?.proposal != null)}>
            {latest.result?.proposal == null ? text.noProposal : text.proposalAvailable}
          </p>
          <p>
            <Link to="/jobs/$jobId" params={{ jobId: latest.jobId }} className="button">{text.latestJob}</Link>
          </p>
        </div>
      )}
    </section>
  );
}
