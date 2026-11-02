/**
 * 画面のサーバの関数（`getAuditJobFn`）を通して、ジョブが条件に当たるまで読み直して待つ、画面のテストの補助（PRE42-CC 組 UI-K。CC-112）。
 * - `audit-job-functions.test.ts`・`automated-login-setup-ui.test.ts`・`manual-login-confirm-ui.test.ts` が同じ形で書いていた待ち方を 1 つにした。
 *   1 回の読み取り（Server Function の呼び方。応答の本文を集めるか、状態の符号を確かめるか）はテストごとに違うので、`readJob` で受ける。
 * - 組 UI-K2（CC-112 の続き）: `waitForEnd`・`waitForJobEnd` などの名前で書いていた繰り返しも、ここに寄せた。待つ間の記録（画面のサーバの子孫の
 *   process の記録など）は `onPending` で受ける（条件に当たらず、上限の前のときに、次に読み直す前に呼ぶ）。
 * - `tests/helpers/job-test-support.ts` の `waitForJob`（ジョブの管理か管理データを読む口）とは読む口が違うので、名前を分ける
 *   （Gate `tests/architecture/control-test-helper-reuse.test.ts`。画面のテストは、`getAuditJobFn` を読み直す繰り返しを自分で書かない）。
 */
import { ACTIVE_AUDIT_JOB_STATES } from '../../../../src/control/job/job-records.js';
import { wait } from '../../../../src/core/deadline.js';

/** 待つ上限と、読み直しの間隔（ms）。 */
export interface ServerFunctionJobWaitTiming {
  readonly limitMs: number;
  readonly stepMs: number;
}

/** 待ち方（上限と間隔に、待つ間の記録を足したもの）。`onPending` は、最後に読んだ値（なければ `null`）を受ける。 */
export interface ServerFunctionJobWaitOptions<T> extends ServerFunctionJobWaitTiming {
  readonly onPending?: (job: T | null) => void | Promise<void>;
}

/**
 * `readJob(jobId)` を、値が `null` でなく `done` に当たるまで `stepMs` ごとに読み直し、当たった値を返す。上限を過ぎたら、最後に読んだ値を付けて
 * 誤りにする。
 */
export const waitForJobViaServerFunctions = async <T>(
  readJob: (jobId: string) => Promise<T | null>,
  jobId: string,
  done: (job: T) => boolean,
  { limitMs, stepMs, onPending }: ServerFunctionJobWaitOptions<T>,
): Promise<T> => {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const job = await readJob(jobId);
    if (job !== null && done(job)) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`ジョブが条件に当たらなかった: ${JSON.stringify(job)}`);
    }
    await onPending?.(job);
    await wait(stepMs);
  }
};

/** ジョブの一覧（`listAuditJobsFn`）の 1 行のうち、終わっていないジョブを数えるのに使う項目。 */
export interface ServerFunctionJobRow {
  readonly profileId: string;
  readonly state: string;
}

/**
 * PL-3（設計書 `2026-10-26-beaksight-plain-ui-design.md` 2 章の判断 3）: 開始の画面の「点検を始める」は、まとめて実行（点検 → 操作さがし → 見るだけの確かめ）を
 * 始める。最初の段のジョブが終わっても次の段のジョブが続くので、プロファイルの終わっていないジョブ（`ACTIVE_AUDIT_JOB_STATES`）がなくなるまで、ジョブの一覧を
 * `listJobs` で読み直して待つ（読み直し方は `waitForJobViaServerFunctions`）。
 */
export const waitForNoActiveJobViaServerFunctions = async (
  listJobs: () => Promise<readonly ServerFunctionJobRow[]>,
  profileId: string,
  timing: ServerFunctionJobWaitOptions<readonly ServerFunctionJobRow[]>,
): Promise<void> => {
  const activeStates: ReadonlySet<string> = new Set(ACTIVE_AUDIT_JOB_STATES);
  await waitForJobViaServerFunctions(
    async () => (await listJobs()).filter((job) => job.profileId === profileId && activeStates.has(job.state)),
    profileId,
    (activeJobs) => activeJobs.length === 0,
    timing,
  );
};

/** 作成の画面が始めた下調べの作業の、待つのに使う項目（`getAuditJobFn` の応答の一部）。 */
export interface ServerFunctionEntryCheckJob {
  readonly active: boolean;
  readonly entryCheckFollowUp: { readonly state: string; readonly jobId?: string } | null;
}

/**
 * OP-1（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.3 の 3）と、その修正の 2 回目（公開のサイトも同じ流れ）: 作成の画面の「点検を始める」は、下調べを
 * 始め、ジョブの管理が続けて点検を始める。作成のほかを確かめる画面のテストのために、下調べが終わり、続けて始めるかが決まるまで待ち、始めた点検は止めて、終わるまで
 * 待つ（次の場面の作業を始められるように。同時に 1 つの作業の決まり）。始めた点検の作業の ID（始めなければ `null`）を返す。読み直し方は `waitForJobViaServerFunctions`。
 */
export const settleJobsStartedByCreate = async (
  readJob: (jobId: string) => Promise<ServerFunctionEntryCheckJob | null>,
  stopJob: (jobId: string) => Promise<unknown>,
  entryJobId: string,
  timing: ServerFunctionJobWaitTiming,
): Promise<string | null> => {
  const entry = await waitForJobViaServerFunctions(readJob, entryJobId, (job) => !job.active && job.entryCheckFollowUp?.state !== 'WAITING', timing);
  const followUpJobId = entry.entryCheckFollowUp?.state === 'STARTED' ? (entry.entryCheckFollowUp.jobId ?? null) : null;
  if (followUpJobId !== null) {
    await stopJob(followUpJobId);
    await waitForJobViaServerFunctions(readJob, followUpJobId, (job) => !job.active, timing);
  }
  return followUpJobId;
};
