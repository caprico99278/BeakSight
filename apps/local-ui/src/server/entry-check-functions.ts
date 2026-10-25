/**
 * 入口の確かめの Server Functions（Task 43 の設計書 4.3。T43c）。
 * - 読むだけのもの（プロファイルの入口の確かめの要点）は GET。開始は POST だけ。入力は、サーバで `schemas/control/` のスキーマ（`ui-profile-key`、
 *   `ui-entry-check-start`）で確かめてから使う（`requestOf`）。開始の判断（プロファイル、改訂、モード、ターゲット設定、同時に 1 つ）は、ジョブの管理の
 *   `startEntryCheck` が開始の直前に行う（I08）。画面の始められない理由の表示は補助だけ（`auditStartCheckOf`。ジョブの管理と同じ順。入口の確かめは
 *   認証の設定が要らない）。
 * - 結果は成果物 `entry-check.json` が正（管理データには結果を残さない）。最後の成功した入口の確かめ（終わったジョブで、Run の状態が `COMPLETE`）の
 *   成果物を、スキーマとジョブの ID を確かめる読み出し（`readJobResultDocument`）で読み、項目を選んで写す。欄の値は成果物にもない。
 */
import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import type { ConfigErrorKind } from '../../../../src/config/config-error.js';
import type { EntryCheckDocument } from '../../../../src/control/entry-check.js';
import { FINISHED_AUDIT_JOB_STATE } from '../../../../src/control/job/job-records.js';
// T44g（Task 44 の設計書 P4-8 の CC-105）: ジョブの種類の値は、IPC の契約の名前つきの定数から読む（画面のサーバに同じ定数を置かない）。
import { WORKER_ENTRY_CHECK_JOB_KIND } from '../../../../src/control/worker-protocol.js';
import type { AuditJobView } from '../../../../src/control/job/job-store.js';
import type { RunStatus } from '../../../../src/core/contracts.js';
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

/** 最後の成功した入口の確かめ（なければ `null`）。ジョブの一覧は新しい順。 */
const latestEntryCheckOf = async (profileId: string): Promise<EntryCheckLatestView | null> => {
  const job = localUiAuditJobs().listAuditJobs().find((candidate) =>
    candidate.profileId === profileId && candidate.jobKind === WORKER_ENTRY_CHECK_JOB_KIND && candidate.state === FINISHED_AUDIT_JOB_STATE
    && candidate.resultRunStatus === COMPLETE_RUN_STATUS);
  return job === undefined
    ? null
    : { jobId: job.jobId, finishedAt: isoTimestampOrNull(job.finishedAt), result: await entryCheckResultOfJob(job) };
};

interface ProfileKeyRequest {
  readonly profileId: string;
}
interface EntryCheckStartRequest {
  readonly profileId: string;
  readonly expectedRevision: number;
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
    const result = await localUiAuditJobs().startEntryCheck({ profileId: data.profileId, expectedRevision: data.expectedRevision });
    return result.ok
      ? { ok: true, jobId: result.job.jobId }
      : { ok: false, ...startRejectionViewOf(result) };
  });
