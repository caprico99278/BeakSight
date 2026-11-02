/**
 * 入口の確かめの欄（Task 43 の設計書 4.3。T43c）。プロファイルの詳細と認証の設定の画面が共用する。
 * - 「入口を確かめる」: 始められるときは押せる。始められないときは、押せない形で、開始の確かめ（ジョブの管理と同じ順）の理由を出す。押した結果の拒否も
 *   同じ形で出す。始めたらジョブの詳細へ移る。
 * - 最後に成功した入口の確かめ（ジョブへのリンク、終わった日時、案を作れたか）。
 * - PL-4（PL-1 の報告による設計者の判断）: ボタンの名前は、サイトの画面と同じ「入口を確かめ直す」（`LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY`）。
 * - CC-117（PL-TD）: 入口の確かめを始める処理（`useEntryCheckStart`）と、拒まれたときの知らせ（`EntryCheckRejectedNotice`）は、この欄とサイトの画面の
 *   「入口を確かめ直す」（`NextSteps.tsx` の `EntryCheckStartButton`）が共用する 1 か所。
 */
import { useState } from 'react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { formatDateTime } from '../../../../src/presentation/format.js';
import { LOCAL_UI_ENTRY_CHECK_TEXT, LOCAL_UI_NEXT_STEP_TEXT, LOCAL_UI_TEXT } from '../../../../src/presentation/messages.js';
import type { AuditJobStartView } from '../server/audit-job-functions';
import { startEntryCheckFn, type EntryCheckSummaryView } from '../server/entry-check-functions';
import { Notice } from './Notice';
import { StartReasonDetails } from './StartReasonDetails';

/** 入口の確かめの開始を拒まれた結果。 */
export type EntryCheckStartRejection = Extract<AuditJobStartView, { ok: false }>;

/** 入口の確かめを始める処理の状態（`useEntryCheckStart`）。 */
export interface EntryCheckStart {
  /** 始めている間（ボタンを押せなくし、名前を「始めています」にする）。 */
  readonly submitting: boolean;
  /** 押した結果の拒否（なければ `null`）。 */
  readonly rejection: EntryCheckStartRejection | null;
  /** 始める（`revision` は画面が読んだサイトの改訂）。始めたら作業の画面へ移る。拒まれたら `rejection` に入れる。 */
  readonly begin: () => void;
  /** 拒否の知らせを閉じる。 */
  readonly clearRejection: () => void;
}

/**
 * 入口の確かめを始める処理（MI-2 の「入口を確かめる」と同じ Server Function `startEntryCheckFn`。開始の判断はジョブの管理）。CC-117: サイトの画面の
 * ボタンと、この欄のボタンの 1 か所。
 */
export function useEntryCheckStart(profileId: string, revision: number): EntryCheckStart {
  const start = useServerFn(startEntryCheckFn);
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [rejection, setRejection] = useState<EntryCheckStartRejection | null>(null);
  return {
    submitting,
    rejection,
    begin: () => {
      setSubmitting(true);
      void start({ data: { profileId, expectedRevision: revision } })
        .then((started) => {
          if (started.ok) {
            setRejection(null);
            return navigate({ to: '/jobs/$jobId', params: { jobId: started.jobId } });
          }
          setRejection(started);
          return undefined;
        })
        .finally(() => setSubmitting(false));
    },
    clearRejection: () => setRejection(null),
  };
}

/** 入口の確かめの開始を拒まれたときの知らせ（開始の画面と同じ理由の部品 `StartReasonDetails`）と、読み込み直すボタン。CC-117 の 1 か所。 */
export function EntryCheckRejectedNotice({ profileId, rejection, onCleared }: Readonly<{
  profileId: string;
  rejection: EntryCheckStartRejection;
  onCleared: () => void;
}>) {
  const router = useRouter();
  return (
    <Notice kind="critical" heading={LOCAL_UI_ENTRY_CHECK_TEXT.panel.rejectedHeading}>
      <div data-testid="entry-check-rejected" data-reason={rejection.reason}>
        <StartReasonDetails
          profileId={profileId}
          reason={rejection.reason}
          errorCodes={rejection.errorCodes}
          configError={null}
          authSetupErrors={rejection.authSetupErrors}
          nextAllowedAt={rejection.nextAllowedAt ?? null}
          showLoginCheckLink={false}
        />
      </div>
      <div className="button-row">
        <button type="button" className="button" onClick={() => void router.invalidate().then(onCleared)}>
          {LOCAL_UI_TEXT.reload}
        </button>
      </div>
    </Notice>
  );
}

export function EntryCheckPanel({ summary }: Readonly<{ summary: EntryCheckSummaryView }>) {
  const text = LOCAL_UI_ENTRY_CHECK_TEXT.panel;
  const { submitting, rejection, begin, clearRejection } = useEntryCheckStart(summary.profileId, summary.revision);
  const { latest } = summary;
  const blocker = summary.start.blocker;
  return (
    <section className="panel" data-testid="entry-check-panel">
      <h2 className="panel-heading">{text.heading}</h2>
      <p>{text.body}</p>
      {rejection === null ? null : <EntryCheckRejectedNotice profileId={summary.profileId} rejection={rejection} onCleared={clearRejection} />}
      <div className="button-row">
        <button
          type="button"
          className="button button--primary"
          disabled={blocker !== null || submitting}
          aria-describedby={blocker === null ? undefined : 'entry-check-start-reason'}
          data-testid="entry-check-start"
          onClick={begin}
        >
          {submitting ? text.starting : LOCAL_UI_NEXT_STEP_TEXT.actions.RECHECK_ENTRY}
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
