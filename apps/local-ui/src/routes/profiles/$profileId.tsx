import { useId, useState } from 'react';
import { Link, createFileRoute, notFound, useNavigate, useRouter } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { RETIRED_PROFILE_STATUS } from '../../../../../src/control/store/profile-records.js';
import { WORKER_AUDIT_JOB_KIND, WORKER_ENTRY_CHECK_JOB_KIND } from '../../../../../src/core/audit-job-values.js';
import { formatCount, formatPlainDateTime } from '../../../../../src/presentation/format.js';
import {
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
  LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT,
  LOCAL_UI_CREDENTIAL_TEXT,
  LOCAL_UI_DISCOVERY_TEXT,
  LOCAL_UI_ENTRY_CHECK_TEXT,
  LOCAL_UI_JOB_SUMMARY_TEXT,
  LOCAL_UI_LEDGER_TEXT,
  LOCAL_UI_NEXT_STEP_TEXT,
  LOCAL_UI_TEXT,
  LOCAL_UI_WRITE_SCREENS_TEXT,
  PROFILE_STORE_REJECTION_DESCRIPTIONS,
} from '../../../../../src/presentation/messages.js';
import type { AuditJobStartRejectionReason } from '../../../../../src/control/job/job-records.js';
import { AdvancedSettings } from '../../components/AdvancedSettings';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EntryCheckStartButton, NEXT_STEPS_ANCHOR, ProfileActionLink, type ProfileLinkAction } from '../../components/NextSteps';
import { Notice } from '../../components/Notice';
import { arrivedFromJobOf } from '../../components/JobArrival';
import { PageFrame, arrivalSearchOf } from '../../components/PageFrame';
import { ProfileForm, formValuesOf, profileDocumentOf } from '../../components/ProfileForm';
import {
  auditJobStateDisplay,
  auditModeDisplay,
  authStrategyDisplay,
  toneClass,
  usesAuthSetup,
  offersAutomatedLogin,
  usesAutomatedLogin,
  usesDiscovery,
  usesReadCheck,
  usesScenarios,
} from '../../display/labels';
import { finishedJobResultTextOf, profileStageAfterAuditArrivalOf, type ProfileAction, type ProfileStageKind } from '../../display/next-steps';
import {
  getProfileFn,
  retireProfileFn,
  targetConfigCandidatesFn,
  updateProfileFn,
  type ProfileChangeView,
} from '../../server/profile-functions';
import { closedListReason } from '../../display/server-function-outcome';
import { WriteScreenList } from '../../components/WriteScreenList';
import { writeScreensFn } from '../../server/write-screen-functions';
import { getAuditJobFn, listAuditJobsFn, type AuditJobDetailView, type AuditJobRowView } from '../../server/audit-job-functions';
import { profileOnboardingFn, type ProfileOnboardingView } from '../../server/profile-onboarding-functions';
import { DisplaySettingsPanel } from '../../components/DisplaySettingsPanel';
import { profileDisplaySettingsFn } from '../../server/display-settings-functions';
import { CrawlLimitsPanel } from '../../components/CrawlLimitsPanel';
import { crawlLimitsPanelFn } from '../../server/crawl-limits-functions';
import { isSavedNoticeCurrent, savedRevisionOf } from '../../display/saved-notice';
import { isClosedSearchValue } from '../../display/search-values';

/**
 * 保存の後に出す知らせ（URL の search で渡す。値は閉じた一覧）。`retiredCredentialKept` は、取り消しは成功したが、保存した資格情報を消せなかった
 * とき（T26g-2、T26R の I1。資格情報の画面から消すよう案内する）。
 */
// OP-2（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.1 の D7'）: 「書き込みも試す」をなくしたので、その保存の知らせ（`writeMode`）も外した。
const SAVED_NOTICES = Object.freeze(['created', 'updated', 'retired', 'retiredCredentialKept'] as const);
type SavedNotice = (typeof SAVED_NOTICES)[number];

const isSavedNotice = (value: unknown): value is SavedNotice => isClosedSearchValue(SAVED_NOTICES, value);

/**
 * MI-2（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.2）: 作成の保存に続けて入口の確かめを始められなかった理由（開始を拒む理由の閉じた一覧か、
 * 要求が届かなかった）。作成の画面（`routes/profiles/new.tsx`）が URL の search で渡す。
 */
type EntryCheckNotStarted = AuditJobStartRejectionReason | 'REQUEST_FAILED';
const ENTRY_CHECK_REQUEST_FAILED = 'REQUEST_FAILED';
const isEntryCheckStartRejection = closedListReason(AUDIT_JOB_START_REJECTION_DESCRIPTIONS);
const isEntryCheckNotStarted = (value: unknown): value is EntryCheckNotStarted =>
  value === ENTRY_CHECK_REQUEST_FAILED || isEntryCheckStartRejection(value);

/** PL-1（設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の 5、13 章の最後の段落）: 自動で移ってきた作業の、終わった結果（文の鍵はカタログと同じ）。 */
const isFinishedJobResult = closedListReason(LOCAL_UI_JOB_SUMMARY_TEXT.finished);

/**
 * PL-U（設計書 14.1 の U2）: 移ってきた作業の点検（点検の作業そのもの、まとめて実行のステップの作業なら、その連鎖の点検のステップの作業）。点検でない作業
 * （入口の確かめなど）は `null`。連鎖の点検の作業は、もう一度読む（移ってきた作業の詳細には、点検の結果がないため）。
 */
const arrivedAuditOf = async (job: AuditJobDetailView): Promise<AuditJobDetailView | null> => {
  if (job.jobKind === WORKER_AUDIT_JOB_KIND) {
    return job;
  }
  const auditJobId = job.stageChain?.stages.find((stage) => stage.kind === WORKER_AUDIT_JOB_KIND)?.jobId ?? null;
  return auditJobId === null ? null : getAuditJobFn({ data: { jobId: auditJobId } });
};

export const Route = createFileRoute('/profiles/$profileId')({
  // DEF-137: 保存した改訂（`savedRevision`）も受ける（知らせは、画面の改訂がそれに届いたときだけ出す）。
  // PL-1: 作業の画面から自動で移ってきた印（`arrived`。PL-V）と、どの作業から移ったか（`fromJob`。PL-2 の `JobArrival.tsx`）も受ける。
  validateSearch: (search: Record<string, unknown>): {
    saved?: SavedNotice;
    savedRevision?: number;
    entryCheckNotStarted?: EntryCheckNotStarted;
    arrived?: 'auto';
    fromJob?: string;
  } => {
    const savedRevision = savedRevisionOf(search['savedRevision']);
    const entryCheckNotStarted = search['entryCheckNotStarted'];
    const fromJob = arrivedFromJobOf(search);
    return {
      ...(isSavedNotice(search['saved']) ? { saved: search['saved'], ...(savedRevision === undefined ? {} : { savedRevision }) } : {}),
      ...(isEntryCheckNotStarted(entryCheckNotStarted) ? { entryCheckNotStarted } : {}),
      ...arrivalSearchOf(search),
      ...(fromJob === null ? {} : { fromJob }),
    };
  },
  // MI-F3（MI-R の Minor 14b）: 作成の画面が入口の確かめの開始の応答を取れなかったとき（`REQUEST_FAILED`）だけ、このプロファイルの入口の確かめのジョブを読む。
  // PL-1: 自動で移ってきたときだけ、その作業を読む。
  loaderDeps: ({ search }) => ({ entryCheckNotStarted: search.entryCheckNotStarted, fromJob: arrivedFromJobOf(search) }),
  loader: async ({ params, deps }) => {
    const [detail, candidates, onboarding, displaySettings, crawlLimits, entryCheckJobs, arrivedJob] = await Promise.all([
      getProfileFn({ data: { profileId: params.profileId } }),
      targetConfigCandidatesFn(),
      // PL-1: 要点の段と主のボタン（判定はサーバの 1 か所。「書き込みにも使う」の確認のダイアログの値も含む）。
      profileOnboardingFn({ data: { profileId: params.profileId } }),
      // FM-1（手動の操作を減らす設計書 2.2）: 表示の設定（プロファイルの改訂とは別に持つ）。
      profileDisplaySettingsFn({ data: { profileId: params.profileId } }),
      // T44d（Task 44 の設計書 P2-1）: 監査の負荷（設定のファイルの値。変えると設定のファイルを書き換える）。
      crawlLimitsPanelFn({ data: { profileId: params.profileId } }),
      deps.entryCheckNotStarted === ENTRY_CHECK_REQUEST_FAILED ? listAuditJobsFn() : Promise.resolve<readonly AuditJobRowView[]>([]),
      deps.fromJob === null ? Promise.resolve(null) : getAuditJobFn({ data: { jobId: deps.fromJob } }),
    ]);
    // OP-2（D7'）: 「登録・更新を試せる画面」の一覧（書き込みを試せないサイト・操作さがしがないサイトは null）。
    const writeScreens = await writeScreensFn({ data: { profileId: params.profileId } });
    if (detail === null || onboarding === null || crawlLimits === null) {
      throw notFound();
    }
    // PL-1（3 章の 5）: 移ってきた作業（このサイトの作業で、終わった結果のときだけ。ほかのサイトの作業の ID では出さない）。
    const arrivedSiteJob = arrivedJob !== null && arrivedJob.profileId === params.profileId && isFinishedJobResult(arrivedJob.summary.result)
      ? arrivedJob
      : null;
    // PL-U（14.1 の U2）: 点検を終えたばかりで移ってきたときは、その点検の結果（問題の数）を要点の 1 行目にする。
    const arrivedAudit = arrivedSiteJob === null ? null : await arrivedAuditOf(arrivedSiteJob);
    const arrivalJob = arrivedAudit !== null && arrivedAudit.profileId === params.profileId && isFinishedJobResult(arrivedAudit.summary.result)
      ? arrivedAudit
      : arrivedSiteJob;
    return {
      detail,
      candidates,
      onboarding,
      writeScreens,
      // OP-2（4.1.2）・OP-G（指示書の 3）: 移ってきた点検の、チェックした画面の登録・更新の 1 行の種類（実際に送った段と結果から。サーバが決める）。
      arrivalWrite: arrivedSiteJob?.inspectionWrite ?? null,
      displaySettings,
      crawlLimits,
      entryCheckJobs: entryCheckJobs.filter((job) => job.profileId === params.profileId && job.jobKind === WORKER_ENTRY_CHECK_JOB_KIND),
      arrival: arrivalJob === null || !isFinishedJobResult(arrivalJob.summary.result)
        ? null
        : {
          result: arrivalJob.summary.result,
          text: finishedJobResultTextOf(arrivalJob.summary.result, arrivalJob.summary.problemCount),
          fromAudit: arrivalJob === arrivedAudit,
        },
    };
  },
  component: ProfilePage,
});

const SAVED_TEXT: Readonly<Record<SavedNotice, string>> = Object.freeze({
  created: LOCAL_UI_TEXT.profileForm.created,
  updated: LOCAL_UI_TEXT.profileForm.updated,
  retired: LOCAL_UI_TEXT.retireDialog.done,
  retiredCredentialKept: LOCAL_UI_TEXT.retireDialog.done,
});

/**
 * MI-F3（独立レビュー MI-R の Minor 14b）: 作成の画面が入口の確かめの開始の応答を取れなかったときの、このプロファイルの入口の確かめのジョブ（新しい順。動いている
 * もの・終わったもの。ジョブの画面へのリンクと状態）。実際には始まっていることがあるので、「入口を確かめ直す」を押し直す前に見られるようにする。
 */
function EntryCheckJobsAfterLostResponse({ jobs }: Readonly<{ jobs: readonly AuditJobRowView[] }>) {
  const text = LOCAL_UI_TEXT.profileForm.entryCheckNotStarted;
  if (jobs.length === 0) {
    return <p data-testid="profile-entry-check-jobs-none">{text.noJobs}</p>;
  }
  return (
    <>
      <p>{text.jobsFound}</p>
      <ul data-testid="profile-entry-check-jobs">
        {jobs.map((job) => {
          const state = auditJobStateDisplay(job.state);
          return (
            <li key={job.jobId} data-job-id={job.jobId} data-state={job.state}>
              <Link to="/jobs/$jobId" params={{ jobId: job.jobId }}>{formatPlainDateTime(job.createdAt)}</Link>{' '}
              <span className={toneClass(state.tone)}>{state.label}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * 要点の段の文。OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12）: 点検から移ってきたときは、1 行目の点検の結果の 1 行と重ならない文
 * （`afterAuditArrival`）にする（「点検が終わりました」を 2 行続けない）。
 */
const stageTextOf = (stage: ProfileStageKind, fromAudit: boolean): string => {
  const afterArrival: Readonly<Partial<Record<ProfileStageKind, string>>> = LOCAL_UI_NEXT_STEP_TEXT.afterAuditArrival;
  return (fromAudit ? afterArrival[stage] : undefined) ?? LOCAL_UI_NEXT_STEP_TEXT.stages[stage];
};

/** 要点の、段の文の後に出す理由の文（入口の確かめの後の状態・始められない理由・始められる時刻）。 */
function StageReason({ onboarding }: Readonly<{ onboarding: ProfileOnboardingView }>) {
  const { stage, auditStartBlocker, authSetupProposal, nextAllowedAt, entryCheckStartBlocker } = onboarding;
  switch (stage.stage) {
    case 'ENTRY_NOT_CHECKED':
    case 'AUTH_SETUP_CREATE':
      return (
        <>
          {authSetupProposal === null || authSetupProposal === 'NOT_USED' || authSetupProposal === 'PRESENT' ? null : (
            <p data-testid="profile-stage-reason" data-reason={authSetupProposal}>{LOCAL_UI_AUTH_SETUP_PROPOSAL_TEXT.states[authSetupProposal]}</p>
          )}
          {stage.stage === 'ENTRY_NOT_CHECKED' && entryCheckStartBlocker !== null ? (
            <div data-testid="entry-check-start-reason" data-reason={entryCheckStartBlocker}>
              <p>{LOCAL_UI_ENTRY_CHECK_TEXT.panel.cannotStart}</p>
              <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[entryCheckStartBlocker].description}</p>
              <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[entryCheckStartBlocker].action}</p>
            </div>
          ) : null}
        </>
      );
    case 'AUTH_SETUP_FIX':
    case 'CREDENTIAL_FIX':
    case 'BLOCKED':
      return auditStartBlocker === null ? null : (
        <div data-testid="profile-stage-reason" data-reason={auditStartBlocker}>
          <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[auditStartBlocker].description}</p>
          <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[auditStartBlocker].action}</p>
        </div>
      );
    case 'AUTO_LOGIN_WAIT':
      // 4 章の 7: 押せないときは、ボタンの代わりに「◯時◯分から始められます」を出す（時刻の書式はカタログの部品）。
      return (
        <p data-testid="profile-next-allowed-at" data-next-allowed-at={nextAllowedAt ?? ''}>
          {nextAllowedAt === null ? LOCAL_UI_NEXT_STEP_TEXT.waitUnknown : LOCAL_UI_NEXT_STEP_TEXT.autoLoginWaitUntil(formatPlainDateTime(nextAllowedAt))}
        </p>
      );
    default:
      return null;
  }
}

/** 要点のパネルと詳しい内容の、1 つのボタン（行き先ごと）。入口を確かめ直すと書き込みも試すは、その場で動く部品。 */
function ProfileActionButton({ action, primary, profileId, revision, reportHref }: Readonly<{
  action: ProfileAction;
  primary: boolean;
  profileId: string;
  revision: number;
  /** PL-U: 最新の点検の報告の行き先（「結果を見る」。なければ `null`）。 */
  reportHref: string | null;
}>) {
  switch (action) {
    case 'RECHECK_ENTRY':
      return <EntryCheckStartButton profileId={profileId} revision={revision} primary={primary} />;
    case 'AUDIT_RESULT':
      // PL-U（14.1 の U2）: 作業の画面の「結果を見る」と同じく、報告を別のタブで開く。
      return reportHref === null ? null : (
        <a href={reportHref} target="_blank" rel="noopener noreferrer" className={primary ? 'button button--primary' : 'button'}
          data-testid="profile-action" data-action="AUDIT_RESULT">
          {LOCAL_UI_NEXT_STEP_TEXT.actions.AUDIT_RESULT}
        </a>
      );
    default:
      return <ProfileActionLink action={action satisfies ProfileLinkAction} profileId={profileId} primary={primary} />;
  }
}

/**
 * サイトの画面（設計書 4.7。PL-1 で設計書 `2026-10-26-beaksight-plain-ui-design.md` 3 章の形に作り直した）。上から: 要点のパネル（今の様子の文、理由、主のボタン
 * 1 つと同じ行の右の二次のボタン。保存の知らせと安全の印もここ）→ 詳しい内容 1 つ（`AdvancedSettings`。サイトの値、入口を確かめ直す、ほかの画面への入口、
 * 表示の設定、読む上限、サイトの設定の編集、取り消し）。主のボタンと二次のボタンは、サーバが選んだ段（`profileOnboardingFn` の `stage`）の値を描くだけ。
 */
function ProfilePage() {
  const { detail, candidates, onboarding, writeScreens, arrivalWrite, displaySettings, crawlLimits, entryCheckJobs, arrival } = Route.useLoaderData();
  const search = Route.useSearch();
  // DEF-137: 保存の知らせは、画面の改訂が保存した改訂に届いたときだけ出す（改訂のない知らせは今のまま）。MI-C（MI-1 の発見事項 1）: ルータは根の生の
  // search も子へ渡すので、`validateSearch` で外した値も残る。知らせと改訂も、描く前に閉じた一覧と形をもう一度確かめる（`?saved=foo` で空の枠を出さない）。
  const saved = isSavedNotice(search.saved) && isSavedNoticeCurrent(savedRevisionOf(search.savedRevision), detail.profile.revision)
    ? search.saved
    : undefined;
  // MI-2: ルータは根の生の search も子へ渡すので、閉じた一覧の値かを描く前にもう一度確かめる（一覧にない値では知らせを出さない）。
  const entryCheckNotStarted = isEntryCheckNotStarted(search.entryCheckNotStarted) ? search.entryCheckNotStarted : undefined;
  const update = useServerFn(updateProfileFn);
  const retire = useServerFn(retireProfileFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [retireRejection, setRetireRejection] = useState<Extract<ProfileChangeView, { ok: false }> | null>(null);
  const { profile } = detail;
  // PL-U（14.1 の U2）: 点検を終えたばかりで移ってきたときは、「結果を見る」を主のボタンにする（決め方は `next-steps.ts` の部品）。
  const stage = arrival?.fromAudit === true && onboarding.latestReportHref !== null
    ? profileStageAfterAuditArrivalOf(onboarding.stage)
    : onboarding.stage;
  const retired = detail.status === RETIRED_PROFILE_STATUS;
  const reload = (): void => {
    void router.invalidate();
  };
  const showSaved = (notice: SavedNotice, savedRevision?: number): void => {
    // 先に今の内容を読み直し（loader）、それから保存の知らせを出す（知らせと内容が食い違わないように）。DEF-137: 保存した改訂も載せ、画面の改訂がそれに
    // 届くまで知らせを出さない（ルータが読み直しを反映し終える前に、新しい search で一度描くことがあるため）。
    void router.invalidate().then(() => navigate({
      to: '/profiles/$profileId',
      params: { profileId: profile.profileId },
      search: { saved: notice, ...(savedRevision === undefined ? {} : { savedRevision }) },
      replace: true,
    }));
  };
  const actionProps = {
    profileId: profile.profileId,
    revision: profile.revision,
    reportHref: onboarding.latestReportHref,
  };
  /** 要点のパネルのボタン（詳しい内容に同じ行き先を重ねて出さない）。 */
  const summaryActions = new Set<ProfileAction>([stage.primary, stage.secondary].filter((action): action is ProfileAction => action !== null));
  /** 詳しい内容の、ほかの画面への入口（要点のパネルにない行き先だけ。取り消したサイトでは、記録を見る画面だけ）。 */
  const detailActions: readonly ProfileAction[] = retired ? [] : [
    // 入口を確かめ直す（今始められるときだけ。公開の画面だけのサイトでも、今までどおり確かめられる）。
    ...(onboarding.entryCheckStartBlocker === null ? ['RECHECK_ENTRY' as const] : []),
    ...(usesAuthSetup(profile.mode, profile.auth) ? ['AUTH_SETUP' as const] : []),
    // OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5）: ID とパスワードの画面は、詳しい内容の中の直す道としてだけ残す。手でログインするサイトでも
    // （1 回目の手でのログインの後に自動ログインへ切り替えられなかったとき、そこから自動ログインにできる。前の「次から自動でログインする」の入口の代わり）。
    ...(usesAutomatedLogin(profile.mode, profile.auth) || offersAutomatedLogin(profile.mode, profile.auth) ? ['CREDENTIAL' as const] : []),
    ...stage.laterOffers,
    ...(usesScenarios(profile.mode, profile.auth) ? ['SCENARIOS' as const] : []),
  ].filter((action) => !summaryActions.has(action));

  return (
    // PL-V（設計書 `2026-10-26-beaksight-plain-ui-design.md` 13 章の 4）: 題はサイトの名前。h1 の上の 1 行から一覧へ戻る。
    <PageFrame title={profile.profileId} trail={[{ kind: 'sites' }]}>
      {/* 3 章の 1: 要点のパネル（今の様子の文と理由、主のボタン 1 つ＋二次のボタン。知らせと安全の印もこの中。13 章の 6）。 */}
      <section className="panel" id={NEXT_STEPS_ANCHOR} data-testid="profile-summary" data-stage={stage.stage}>
        <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.summaryHeading}</h2>
        {/* PL-1（3 章の 5、13 章の最後の段落）: 作業の画面から自動で移ってきたときは、要点の 1 行目に何が起きたか（作業の結果の文）。 */}
        {/* PL-U（14.1 の U1・U2）: 点検から移ってきたときは、その点検の結果の 1 行（問題の数。一部のページを見られなかったこと）。 */}
        {arrival === null ? null : <p data-testid="profile-arrival" data-result={arrival.result}>{arrival.text}</p>}
        {/* OP-2（4.1.2）・OP-G（指示書の 3）: 点検の中の、チェックした画面の登録・更新の 1 行（実際に行ったこと。確かめられなかった・試せなかったときは、その事実）。 */}
        {arrival !== null && arrivalWrite !== null ? (
          <p data-testid="profile-arrival-wrote" data-outcome={arrivalWrite}>{LOCAL_UI_WRITE_SCREENS_TEXT.inspectionWrite[arrivalWrite]}</p>
        ) : null}
        {saved === undefined ? null : (
          <Notice kind="positive">
            <p>{SAVED_TEXT[saved]}</p>
          </Notice>
        )}
        {saved === 'retiredCredentialKept' ? (
          <Notice kind="caution">
            <p data-testid="profile-credential-not-removed">{LOCAL_UI_TEXT.retireDialog.credentialNotRemoved}</p>
            <p>
              <Link to="/credentials/$profileId" params={{ profileId: profile.profileId }}>{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.open}</Link>
            </p>
          </Notice>
        ) : null}
        {/* T26g-3: 自動ログインでないプロファイルでも、資格情報のファイルが残っていれば（判定はサーバ）、資格情報の画面へのリンクを出す（秘密が残るので要点に）。 */}
        {!usesAutomatedLogin(profile.mode, profile.auth) && detail.credentialRemains ? (
          <Notice kind="caution">
            <div data-testid="profile-credential-leftover">
              <p>{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.leftover}</p>
              <p>
                <Link to="/credentials/$profileId" params={{ profileId: profile.profileId }}>{LOCAL_UI_CREDENTIAL_TEXT.profileDetail.open}</Link>
              </p>
            </div>
          </Notice>
        ) : null}
        {/* MI-2: 作成の保存に続けて入口の確かめを始められなかったとき（プロファイルは保存したまま）。理由と、「入口を確かめ直す」への案内。 */}
        {retired || entryCheckNotStarted === undefined ? null : (
          <Notice kind="caution" heading={LOCAL_UI_TEXT.profileForm.entryCheckNotStarted.heading}>
            <div data-testid="profile-entry-check-not-started" data-reason={entryCheckNotStarted}>
              {entryCheckNotStarted === ENTRY_CHECK_REQUEST_FAILED ? (
                <>
                  <p>{LOCAL_UI_TEXT.profileForm.entryCheckNotStarted.requestFailed}</p>
                  <EntryCheckJobsAfterLostResponse jobs={entryCheckJobs} />
                </>
              ) : (
                <>
                  <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[entryCheckNotStarted].description}</p>
                  <p>{AUDIT_JOB_START_REJECTION_DESCRIPTIONS[entryCheckNotStarted].action}</p>
                </>
              )}
              {/* MI-F3: 応答を取れなかったときは、ジョブがないときだけ、もう一度始める案内を出す（始まっていたジョブを二重に始めさせない）。 */}
              {entryCheckNotStarted === ENTRY_CHECK_REQUEST_FAILED && entryCheckJobs.length > 0 ? null : (
                <p>{LOCAL_UI_TEXT.profileForm.entryCheckNotStarted.action}</p>
              )}
            </div>
          </Notice>
        )}
        {/* OP-G（指示書の 4）: 自動ログインの間隔の中で始められる時刻が分かるときは、段の文と時刻を 1 行にまとめる（`StageReason` の 1 行）。 */}
        {stage.stage === 'AUTO_LOGIN_WAIT' && onboarding.nextAllowedAt !== null ? null : (
          <p data-testid="profile-stage" data-stage={stage.stage}>{stageTextOf(stage.stage, arrival?.fromAudit === true)}</p>
        )}
        {/* OP-2（設計書 4.1 の D6）: 本番からの切り離しは、聞かない・出さない（前の「まだ確かめていない」の印は外した）。 */}
        <StageReason onboarding={onboarding} />
        {/* OP-I（I1。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: 「削除のほかを通す」はサイトの既定なので、要点に守りを緩めている印は出さない
            （切り替えと確認のダイアログは、詳しい内容の表示の設定に残す。作業の画面の知らせは残す）。 */}
        {stage.primary === null && stage.secondary === null ? null : (
          <div className="button-row" data-testid="profile-summary-actions">
            {stage.primary === null ? null : <ProfileActionButton action={stage.primary} primary {...actionProps} />}
            {stage.secondary === null ? null : <ProfileActionButton action={stage.secondary} primary={false} {...actionProps} />}
          </div>
        )}
      </section>

      {/* OP-2（D7'）: 「登録・更新を試せる画面」の一覧（チェックの欄。変えたら、その場で保存する）。 */}
      {retired || writeScreens === null ? null : <WriteScreenList view={writeScreens} />}

      {/* 3 章の 1: 詳しい内容 1 つ（開かなくても流れは進む）。 */}
      <section className="panel">
        <AdvancedSettings testId="profile-edit-advanced-settings">
          <dl className="facts" data-testid="profile-facts">
            <dt>{LOCAL_UI_TEXT.profileList.columns.mode}</dt>
            <dd>{auditModeDisplay(profile.mode).label}</dd>
            <dt>{LOCAL_UI_TEXT.profileList.columns.auth}</dt>
            <dd>{authStrategyDisplay(profile.auth).label}</dd>
          </dl>
          {detailActions.includes('RECHECK_ENTRY') ? <p className="muted">{LOCAL_UI_NEXT_STEP_TEXT.entryCheckNote}</p> : null}
          <h2 className="panel-heading">{LOCAL_UI_NEXT_STEP_TEXT.otherScreensHeading}</h2>
          <div className="button-row" data-testid="profile-detail-actions">
            {detailActions.map((action) => <ProfileActionButton key={action} action={action} primary={false} {...actionProps} />)}
            {/* T27f・T28b: 操作の候補と READ の確かめを使うプロファイルだけ（取り消したプロファイルでも、記録は見られる。始める・作るは、それぞれの画面が止める）。 */}
            {usesDiscovery(profile.mode, profile.auth) ? (
              <Link to="/discovery/$profileId" params={{ profileId: profile.profileId }} className="button" data-testid="profile-open-discovery">
                {LOCAL_UI_DISCOVERY_TEXT.profileDetail.openDiscovery}
              </Link>
            ) : null}
            {usesReadCheck(profile.mode, profile.auth) ? (
              <Link to="/read-checks/$profileId" params={{ profileId: profile.profileId }} className="button" data-testid="profile-open-read-checks">
                {LOCAL_UI_DISCOVERY_TEXT.profileDetail.openReadChecks}
              </Link>
            ) : null}
            {/* T28e・T32g: 書き込みのモードのプロファイルだけ、書き込みの手順（取り消したサイトでも記録は見られる）と、作ったデータの一覧（読むだけ）。 */}
            {retired && usesScenarios(profile.mode, profile.auth) ? <ProfileActionLink action="SCENARIOS" profileId={profile.profileId} primary={false} /> : null}
            {usesScenarios(profile.mode, profile.auth) ? (
              <Link to="/ledger/$profileId" params={{ profileId: profile.profileId }} className="button" data-testid="profile-open-ledger">
                {LOCAL_UI_LEDGER_TEXT.profileDetail.open}
              </Link>
            ) : null}
          </div>

          {/* FM-1（手動の操作を減らす設計書 2.2）: 表示の設定（ジョブのブラウザを表示する。「削除のほかを通す」の確認のダイアログもこの中）。 */}
          <DisplaySettingsPanel profileId={profile.profileId} settings={displaySettings} editable={!retired} />

          {/* T44d（Task 44 の設計書 P2-1）: 監査の負荷（取り消したプロファイルには出さない）。 */}
          {retired ? null : <CrawlLimitsPanel view={crawlLimits} />}

          {retired ? null : (
            <>
              {/* MI-1（設計書 4.2）: プロファイルの編集（今の全部の欄）。 */}
              <section className="panel">
                <h2 className="panel-heading">{LOCAL_UI_TEXT.pages.editProfile}</h2>
                <ProfileForm
                  key={`${profile.profileId}:${profile.revision}`}
                  kind="edit"
                  initialValues={formValuesOf(profile)}
                  targetConfigCandidates={candidates}
                  onSave={(values) => update({ data: { profile: profileDocumentOf(values, profile.revision + 1), expectedRevision: profile.revision } })}
                  onSaved={(result) => showSaved('updated', result.detail.profile.revision)}
                  onReload={reload}
                />
              </section>
              <section className="panel">
                {retireRejection === null ? null : (
                  <Notice kind="critical" heading={LOCAL_UI_TEXT.profileForm.rejectedHeading}>
                    <p>{PROFILE_STORE_REJECTION_DESCRIPTIONS[retireRejection.reason].description}</p>
                    <p>{PROFILE_STORE_REJECTION_DESCRIPTIONS[retireRejection.reason].action}</p>
                    <div className="button-row">
                      <button type="button" className="button" onClick={reload}>{LOCAL_UI_TEXT.reload}</button>
                    </div>
                  </Notice>
                )}
                <button type="button" className="button button--danger" onClick={() => setDialogOpen(true)}>
                  {LOCAL_UI_TEXT.retireDialog.open}
                </button>
              </section>
            </>
          )}
        </AdvancedSettings>
      </section>
      {retired ? null : (
        <ConfirmDialog
          open={dialogOpen}
          title={LOCAL_UI_TEXT.retireDialog.title}
          body={LOCAL_UI_TEXT.retireDialog.body}
          confirmLabel={LOCAL_UI_TEXT.retireDialog.confirm}
          cancelLabel={LOCAL_UI_TEXT.retireDialog.cancel}
          confirmTone="danger"
          busy={retiring}
          onCancel={() => setDialogOpen(false)}
          onConfirm={() => {
            setRetiring(true);
            void retire({ data: { profileId: profile.profileId, expectedRevision: profile.revision } })
              .then((result) => {
                setDialogOpen(false);
                if (result.ok) {
                  setRetireRejection(null);
                  // 取り消しは成功のまま。資格情報を消せなかったときだけ、資格情報の画面から消すよう案内する。
                  showSaved(result.credentialCleanup === 'FAILED' ? 'retiredCredentialKept' : 'retired');
                } else {
                  setRetireRejection(result);
                }
              })
              .finally(() => setRetiring(false));
          }}
        />
      )}
    </PageFrame>
  );
}
