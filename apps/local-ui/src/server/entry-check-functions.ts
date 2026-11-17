/**
 * 入口の確かめの Server Functions（Task 43 の設計書 4.3。T43c）。
 * - 読むだけのもの（プロファイルの入口の確かめの要点）は GET。開始は POST だけ。入力は、サーバで `schemas/control/` のスキーマ（`ui-profile-key`、
 *   `ui-entry-check-start`）で確かめてから使う（`requestOf`）。開始の判断（プロファイル、改訂、モード、ターゲット設定、同時に 1 つ）は、ジョブの管理の
 *   `startEntryCheck` が開始の直前に行う（I08）。画面の始められない理由の表示は補助だけ（`auditStartCheckOf`。ジョブの管理と同じ順。入口の確かめは
 *   認証の設定が要らない）。
 * - 結果は成果物 `entry-check.json` が正（管理データには結果を残さない）。最後の成功した入口の確かめ（終わったジョブで、Run の状態が `COMPLETE`）の
 *   成果物を、スキーマとジョブの ID を確かめる読み出し（`readJobResultDocument`）で読み、項目を選んで写す。欄の値は成果物にもない。
 * - MI-3（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.3）: 入口の確かめの後の認証の設定の状態（`entryCheckAuthSetupStateOf`）。ジョブの画面の
 *   「入口の確かめの結果」とプロファイルの詳細の「次にすること」が、この 1 か所を使う。判定と案の組み立ては、ジョブの管理が案で保存するときと同じ部品
 *   （`src/control/auth/auth-setup-proposal.ts`）、案の検証は保存と同じ部品（`validateAuthSetupForProfile`）。管理データには記録しない（設計者の判断）。
 */
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type { EntryCheckDocument } from '../../../../src/control/entry-check.js';
import { FINISHED_AUDIT_JOB_STATE } from '../../../../src/control/job/job-records.js';
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ定数を置かない）。
import { WORKER_ENTRY_CHECK_JOB_KIND } from '../../../../src/control/worker-protocol.js';
import { lastFinishedEntryCheckJobOf, type AuditJobView } from '../../../../src/control/job/job-store.js';
import type { RunStatus } from '../../../../src/core/contracts.js';
import { startUrlPathOf } from '../../../../src/config/target-config-draft.js';
import {
  authSetupProposalProfileOf,
  entryCheckAuthSetupDecisionOf,
  proposedAuthSetupOf,
  type EntryCheckAuthSetupState,
} from '../../../../src/control/auth/auth-setup-proposal.js';
import { validateSiteProfile } from '../../../../src/control/profile-policy.js';
import { getAuthSetup, validateAuthSetupForProfile } from '../../../../src/control/store/auth-setup-store.js';
import { getProfile } from '../../../../src/control/store/profile-store.js';
import { localUiStore } from './control-store';
import { loadTargetContext } from './target-config';
import type { AuditJobStartView, AuditStartCheckView } from './audit-job-functions';
import { auditStartCheckOf, startRejectionViewOf } from './audit-start-check';
import { localUiAuditJobs } from './audit-jobs';
import { readJobResultDocument } from './artifact-files';
import { requestOf } from './request-validation';
import { readProfileStart } from './start-check-inputs';
import { isoTimestampOrNull } from './timestamps';

/** 成功とみなす Run の状態（読んだ事実が分かった終わり方。ジョブの状態は owner の `FINISHED_AUDIT_JOB_STATE`。PRE42-CC 組 3 の N4-8b）。 */
const COMPLETE_RUN_STATUS = 'COMPLETE' satisfies RunStatus;

/** 入口の確かめの結果（成果物から、表示に要る項目だけを写したもの）。 */
export type EntryCheckResultView = Pick<EntryCheckDocument, 'runStatus' | 'endReason' | 'landing' | 'facts' | 'proposal' | 'blockedRequests'>;

/** 最後の成功した入口の確かめ。 */
export interface EntryCheckLatestView {
  readonly jobId: string;
  /** 終わった日時（ISO 8601。なければ `null`）。 */
  readonly finishedAt: string | null;
  /** 成果物を読めなければ `null`。 */
  readonly result: EntryCheckResultView | null;
}

/** プロファイルの入口の確かめの要点（プロファイルの詳細と認証の設定の画面）。 */
export interface EntryCheckSummaryView {
  readonly profileId: string;
  readonly revision: number;
  /** 入口の確かめを始められない理由（ジョブの管理と同じ順の確かめ）。 */
  readonly start: AuditStartCheckView;
  /** 対象の設定のファイルの誤りの種類（読めたか、読めなければその種類）。 */
  readonly configError: ConfigErrorKind | null;
  readonly latest: EntryCheckLatestView | null;
}

/** 成果物から、表示に要る項目だけを写す（ほかの項目は持たない）。 */
const entryCheckResultViewOf = (document: EntryCheckDocument): EntryCheckResultView => structuredClone({
  runStatus: document.runStatus,
  endReason: document.endReason,
  landing: document.landing,
  facts: document.facts,
  proposal: document.proposal,
  blockedRequests: document.blockedRequests,
});

/** 終わった入口の確かめのジョブの結果（成果物を読めない・ほかの種類・終わっていなければ `null`）。サーバだけで使う。 */
export const entryCheckResultOfJob = createServerOnlyFn(async (job: AuditJobView): Promise<EntryCheckResultView | null> => {
  if (job.jobKind !== WORKER_ENTRY_CHECK_JOB_KIND || job.state !== FINISHED_AUDIT_JOB_STATE) {
    return null;
  }
  const document = await readJobResultDocument(job, 'entry-check') as EntryCheckDocument | null;
  return document === null ? null : entryCheckResultViewOf(document);
});

/**
 * MI-3: 入口の確かめの後の、プロファイルの認証の設定の状態（プロファイルがなければ `null`）。`entryCheck` は入口の確かめの結果（なければ `null`）。案で保存する
 * 判定が `PROPOSE` のとき（認証の設定がなく、読んでいてログインの画面）だけ、今のプロファイルと対象の設定で案を作り、保存の検証にかける: 通らなければ
 * `PROPOSAL_INVALID`、通るのに設定がなければ `NOT_SAVED`（保存が改訂の衝突などで済まなかった）。サーバだけで使う。
 */
export const entryCheckAuthSetupStateOf = createServerOnlyFn(async (
  profileId: string,
  entryCheck: Pick<EntryCheckResultView, 'endReason' | 'facts' | 'proposal'> | null,
): Promise<EntryCheckAuthSetupState | null> => {
  const database = localUiStore();
  const stored = getProfile(database, profileId);
  if (stored === null) {
    return null;
  }
  const { profile } = stored;
  const { usesAuthSetup, automated } = authSetupProposalProfileOf(profile.mode, profile.auth);
  const decision = entryCheckAuthSetupDecisionOf({ usesAuthSetup, hasAuthSetup: getAuthSetup(database, profileId) !== null, entryCheck });
  if (decision !== 'PROPOSE' || entryCheck === null) {
    return decision === 'PROPOSE' ? 'NOT_CHECKED' : decision;
  }
  const { context } = await loadTargetContext(profile.targetConfigPath);
  const site = context === undefined ? null : validateSiteProfile(profile, context);
  if (context === undefined || site === null || !site.ok) {
    return 'PROPOSAL_INVALID';
  }
  const setup = proposedAuthSetupOf({
    profileId,
    profileRevision: profile.revision,
    automated,
    startUrlPath: startUrlPathOf(context.targetConfig.site.startUrl) ?? null,
    entryProposal: entryCheck.proposal,
  });
  return validateAuthSetupForProfile(setup, site.profile, context).ok ? 'NOT_SAVED' : 'PROPOSAL_INVALID';
});

/**
 * MI-3: プロファイルの最後の、終わった（`FINISHED`）入口の確かめの結果（Run の状態を問わない。「読んでいない」も理由として示すため）。なければ `null`。
 * サーバだけで使う。
 */
export const lastFinishedEntryCheckOf = createServerOnlyFn(async (profileId: string): Promise<EntryCheckResultView | null> => {
  // OP-K（共通化）: 選び方は、ジョブの管理と同じ 1 か所（`lastFinishedEntryCheckJobOf`）。
  const job = lastFinishedEntryCheckJobOf(localUiAuditJobs().listAuditJobs(), profileId);
  return job === null ? null : entryCheckResultOfJob(job);
});

/** 最後の成功した入口の確かめ（なければ `null`）。ジョブの一覧は新しい順。 */
const latestEntryCheckOf = async (profileId: string): Promise<EntryCheckLatestView | null> => {
  const job = localUiAuditJobs().listAuditJobs().find((candidate) =>
    candidate.profileId === profileId && candidate.jobKind === WORKER_ENTRY_CHECK_JOB_KIND && candidate.state === FINISHED_AUDIT_JOB_STATE
    && candidate.resultRunStatus === COMPLETE_RUN_STATUS);
  return job === undefined
    ? null
    : { jobId: job.jobId, finishedAt: isoTimestampOrNull(job.finishedAt), result: await entryCheckResultOfJob(job) };
};

/**
 * MI-F5（設計書 `2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 6）: プロファイルの最後の成功した入口の確かめの案（なければ `null`）。認証の設定の画面が
 * 新しい設定の欄に埋める案（`latestEntryCheckOf`。画面の `entryCheck.latest`）と同じもの。認証の設定がまだないときの最初の保存は、送信先の項目がこの案と同じとき
 * だけ受ける。サーバだけで使う。
 */
export const latestEntryCheckProposalOf = createServerOnlyFn(async (profileId: string): Promise<EntryCheckResultView['proposal']> =>
  (await latestEntryCheckOf(profileId))?.result?.proposal ?? null);

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface EntryCheckStartRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
  /** OP-1: 下調べの後に、続けて点検を始める（作成の画面の「点検を始める」）。 */
  readonly thenStartAudit?: boolean;
}

/** プロファイルの入口の確かめの要点（読むだけ）。プロファイルがなければ `null`。 */
export const entryCheckSummaryFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ProfileKeyRequest>('ui-profile-key'))
  .handler(async ({ data }): Promise<EntryCheckSummaryView | null> => {
    const reading = await readProfileStart(data.profileId);
    if (reading === null) {
      return null;
    }
    const check = auditStartCheckOf({ ...reading.checkInput, jobKind: WORKER_ENTRY_CHECK_JOB_KIND });
    return {
      profileId: reading.stored.profile.profileId,
      revision: reading.stored.profile.revision,
      start: { blocker: check.blocker, errorCodes: check.errorCodes, authSetupErrors: check.authSetupErrors, nextAllowedAt: check.nextAllowedAt },
      configError: reading.configError,
      latest: await latestEntryCheckOf(reading.stored.profile.profileId),
    };
  });

/** 入口の確かめを始める（開始の判断はジョブの管理が開始の直前に行う）。 */
export const startEntryCheckFn = createServerFn({ method: 'POST' })
  .validator(requestOf<EntryCheckStartRequest>('ui-entry-check-start'))
  .handler(async ({ data }): Promise<AuditJobStartView> => {
    // OP-1（4.1.3 の 3）: 作成の画面の「点検を始める」は、下調べの後に続けて点検を始める印を渡す（始めるかはジョブの管理が決める）。
    const result = await localUiAuditJobs().startEntryCheck({
      profileId: data.profileId, expectedRevision: data.expectedRevision, ...(data.thenStartAudit === true ? { thenStartAudit: true } : {}),
    });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });
