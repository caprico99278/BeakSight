/**
 * サイトの画面の要点（段と主のボタン）とサイトの一覧の行の Server Function（T43a で作り、PL-1 で 3 章の形に置き換えた）。読むだけ（GET）。
 * - 読み方は、開始の画面と同じ `start-check-inputs.ts` の `readProfileStart`（プロファイル、ターゲット設定、保存した認証の設定、自動ログインの
 *   開始の前の確かめの値）。点検を始められない理由は、開始の画面と同じ `audit-start-check.ts` の `auditStartCheckOf`（ジョブの管理と同じ順）。入口の確かめを
 *   始められるかも、同じ確かめ（入口の確かめの種類。プロファイルの詳細の入口の確かめの要点 `entryCheckSummaryFn` と同じ）。
 * - PL-1（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 3 章の 1、4 章の 1・7、6 章）: 段と主のボタンは `display/next-steps.ts` の `profileStageOf` が、
 *   ここで読んだ事実（今の owner の判定の結果）から選ぶ。サイトの画面（`profileOnboardingFn`）とサイトの一覧（`profileStagesFn`）が、同じ `profileStageViewOf` を
 *   使う（一覧の行の判定を詳細とそろえる）。
 *   - 最後の点検のジョブ（ジョブの一覧は新しい順）: 終わったか、その点検が自動ログインでログインしたか（自動ログインの試しの記録があるか）。
 *   - MI-3: 入口の確かめの後の認証の設定の状態（`entryCheckAuthSetupStateOf`。最後の終わった入口の確かめの結果から。ジョブの画面と同じ 1 か所）。
 *   - OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D5）: 「次から自動でログインする」の段はなくした（前は MI-4 の切り替えの前の確かめを読んだ）。
 *   - MI-5: 「書き込みにも使う」の確認のダイアログの値（`writeModeSwitchProposalOf`。対象でなければ `null`。画面のダイアログもこの値を使う）。
 * - 返す値は、表示に要るものだけ（値と秘密を含まない）。
 */
import { manualLoginEveryTimeApplies } from '../../../../src/control/auth/automated-login-switch.js';
import { createServerFn } from '@tanstack/react-start';
import type { EntryCheckAuthSetupState } from '../../../../src/control/auth/auth-setup-proposal.js';
// PRE42-CC 組 3（N4-8b）: 終わったジョブの状態は、owner の `job-records.ts` の名前つきの定数から読む。
import { FINISHED_AUDIT_JOB_STATE } from '../../../../src/control/job/job-records.js';
import { listProfiles } from '../../../../src/control/store/profile-store.js';
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ定数を置かない）。
import { WORKER_AUDIT_JOB_KIND, WORKER_ENTRY_CHECK_JOB_KIND } from '../../../../src/control/worker-protocol.js';
import { profileStageOf, type ProfileStage } from '../display/next-steps';
import { auditStartCheckOf, type AuditStartBlocker } from './audit-start-check';
import { listJobArtifacts, type JobArtifactKind } from './artifact-files';
import { localUiAuditJobs } from './audit-jobs';
import { localUiStore } from './control-store';
import { entryCheckAuthSetupStateOf, lastFinishedEntryCheckOf } from './entry-check-functions';
import { requestOf } from './request-validation';
import { readProfileStart } from './start-check-inputs';
import { localUiWriteModeSwitchDependencies, writeModeSwitchProposalOf, type WriteModeSwitchProposalView } from './write-mode-switch';

/** サイトの画面の要点の値。 */
export interface ProfileOnboardingView {
  /** 段と、主のボタン・二次のボタン・詳しい内容に置く入口。 */
  readonly stage: ProfileStage;
  /** 点検を始められない理由（開始の画面と同じ確かめ。始められるなら `null`）。要点の理由の文に使う。 */
  readonly auditStartBlocker: AuditStartBlocker | null;
  /** 次に始められる日時（ISO 8601。自動ログインの間隔の中のときだけ。ほかは `null`）。 */
  readonly nextAllowedAt: string | null;
  /** 入口の確かめを始められない理由（始められるなら `null`）。 */
  readonly entryCheckStartBlocker: AuditStartBlocker | null;
  /** MI-3: 入口の確かめの後の認証の設定の状態（認証の設定がないときの理由の文に使う）。 */
  readonly authSetupProposal: EntryCheckAuthSetupState | null;
  /** MI-5: 「書き込みにも使う」の確認のダイアログの値（対象でなければ `null`）。 */
  readonly writeModeSwitch: WriteModeSwitchProposalView | null;
  /** PL-U（14.1 の U2）: 最新の点検のジョブの報告（HTML）の画面のサーバの行き先（「結果を見る」。報告がなければ `null`）。 */
  readonly latestReportHref: string | null;
}

/** サイトの一覧の 1 行の段（サイトの画面と同じ判定）。 */
export interface ProfileListStageView {
  readonly profileId: string;
  readonly stage: ProfileStage;
  /** 次に始められる日時（ISO 8601。自動ログインの間隔の中のときだけ）。 */
  readonly nextAllowedAt: string | null;
}

/** 点検の報告（HTML）の成果物の種類（作業の画面の「結果を見る」と同じ）。 */
const REPORT_ARTIFACT_KIND: JobArtifactKind = 'REPORT';

interface ProfileKeyRequest {
  readonly profileId: string;
}

/** サイトの画面の要点の値（読み方と選び方はファイルの先頭）。プロファイルがなければ `null`。サーバだけで使う。 */
const profileStageViewOf = async (profileId: string): Promise<ProfileOnboardingView | null> => {
  const reading = await readProfileStart(profileId);
  if (reading === null) {
    return null;
  }
  const { stored, storedSetup, context, checkInput } = reading;
  const { profile } = stored;
  const audit = auditStartCheckOf(checkInput);
  const entryCheck = auditStartCheckOf({ ...checkInput, jobKind: WORKER_ENTRY_CHECK_JOB_KIND });
  const lastAuditJob = localUiAuditJobs().listAuditJobs()
    .find((job) => job.profileId === profile.profileId && job.jobKind === WORKER_AUDIT_JOB_KIND) ?? null;
  // PL-U（14.1 の U2）: 最新の点検の報告（作業の画面の「結果を見る」と同じ成果物の一覧 `listJobArtifacts`）。
  const latestReportHref = lastAuditJob === null
    ? null
    : (await listJobArtifacts(lastAuditJob)).find(({ kind }) => kind === REPORT_ARTIFACT_KIND)?.href ?? null;
  const authSetupProposal = await entryCheckAuthSetupStateOf(profile.profileId, await lastFinishedEntryCheckOf(profile.profileId));
  // MI-5: 「書き込みにも使う」の確認のダイアログの値（`profile-functions.ts` の「書き込みにも使う」の Server Function と同じ部品。CC-118）。
  const writeModeSwitch = await writeModeSwitchProposalOf(localUiWriteModeSwitchDependencies(), profile.profileId);
  const stage = profileStageOf({
    status: stored.status,
    mode: profile.mode,
    auth: profile.auth,
    auditStartBlocker: audit.blocker,
    entryCheckStartable: entryCheck.blocker === null,
    authSetupProposal,
    lastAudit: lastAuditJob === null
      ? null
      : {
        finished: lastAuditJob.state === FINISHED_AUDIT_JOB_STATE,
        automatedLogin: lastAuditJob.autoLoginAttempt !== null,
        report: latestReportHref !== null,
      },
    writeModeSwitchOffered: writeModeSwitch !== null && writeModeSwitch.authSetupCurrent,
    // OP-1（4.1.3 の 2）: 点検に「毎回手でログインする」が効くか（判定はジョブの管理と同じ 1 か所）。
    manualLoginEveryTime: manualLoginEveryTimeApplies(stored.profile, WORKER_AUDIT_JOB_KIND),
  });
  return {
    stage,
    auditStartBlocker: audit.blocker,
    nextAllowedAt: audit.nextAllowedAt,
    entryCheckStartBlocker: entryCheck.blocker,
    authSetupProposal,
    writeModeSwitch,
    latestReportHref,
  };
};

/** サイトの画面の要点（段と主のボタン、始められない理由）。プロファイルがなければ `null`。 */
export const profileOnboardingFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(({ data }): Promise<ProfileOnboardingView | null> => profileStageViewOf(data.profileId));

/** サイトの一覧の行ごとの段（サイトの画面と同じ判定。一覧の順）。 */
export const profileStagesFn = createServerFn({ method: 'GET' }).handler(async (): Promise<readonly ProfileListStageView[]> => {
  const views: ProfileListStageView[] = [];
  for (const { profile } of listProfiles(localUiStore())) {
    const view = await profileStageViewOf(profile.profileId);
    if (view !== null) {
      views.push({ profileId: profile.profileId, stage: view.stage, nextAllowedAt: view.nextAllowedAt });
    }
  }
  return views;
});
