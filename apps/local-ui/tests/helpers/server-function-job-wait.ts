/**
 * 画面のサーバの関数（`getAuditJobFn`）を通して、ジョブが条件に当たるまで読み直して待つ、画面のテストの補助（PRE42-CC 組 UI-K。CC-112）。
 * - `audit-job-functions.test.ts`・`automated-login-setup-ui.test.ts`・`manual-login-confirm-ui.test.ts` が同じ形で書いていた待ち方を 1 つにした。
 *   1 回の読み取り（Server Function の呼び方。応答の本文を集めるか、状態の符号を確かめるか）はテストごとに違うので、`readJob` で受ける。
 * - 組 UI-K2（CC-112 の続き）: `waitForEnd`・`waitForJobEnd` などの名前で書いていた繰り返しも、ここに寄せた。待つ間の記録（画面のサーバの子孫の
 *   process の記録など）は `onPending` で受ける（条件に当たらず、上限の前のときに、次に読み直す前に呼ぶ）。
 * - `tests/helpers/job-test-support.ts` の `waitForJob`（ジョブの管理か管理データを読む口）とは読む口が違うので、名前を分ける
 *   （Gate `tests/architecture/control-test-helper-reuse.test.ts`。画面のテストは、`getAuditJobFn` を読み直す繰り返しを自分で書かない）。
 */
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
