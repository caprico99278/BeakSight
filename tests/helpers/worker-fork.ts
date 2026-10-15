// ジョブの管理（`src/control/job/audit-job-manager.ts`）のテストで、ワーカーを起動する関数（`AuditWorkerForker`）。
// - `createCountingFork`: 本物の `fork` で起動し、起動の回数と起動した子を記録する（後片付けで、残っていないことを確かめるため）。起動の設定を
//   受け手（`onFork`）に渡せる（環境を記録するテストのため。CCX-18）。
// - `blockingAfterStartFork`（DEF-084）: 親が `START` を送った直後に、子の process が終わるまで（`process.kill(pid, 0)` が失敗するまで）親を同期に
//   ふさぎ、さらに名前つきの時間だけふさいでから戻す。子が最後のメッセージを送ってから終わる間に、親が事象を処理できないので、混雑の下と
//   同じく、`exit` が最後の `message` より先に届く形を、決まって作れる。
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import type { AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { isRecord } from '../../src/core/guards.js';
import { isProcessRunning } from '../../src/core/process-lock.js';

/** 子の process が終わるまで、親をふさぐ上限（ms）。偽のワーカーは `START` の後すぐに終わる。過ぎたら、ふさぐのをやめて戻す。 */
export const BLOCKED_PARENT_EXIT_WAIT_LIMIT_MS = 5_000;

/** 子の process が終わった後も、親をふさぎ続ける時間（ms。子の IPC の書き込みと、OS の終わりの通知が揃うまでの余裕。調査の形）。 */
export const BLOCKED_PARENT_EXTRA_MS = 100;

/** 起動の回数と、起動した子を記録する fork。 */
export interface CountingFork {
  /** ジョブの管理に渡す、ワーカーを起動する関数。 */
  readonly fork: AuditWorkerForker;
  /** 起動した子（後片付けで取り出す）。 */
  readonly children: ChildProcess[];
  /** 起動の回数。 */
  count(): number;
  /** 起動の回数を 0 に戻す（子の一覧は変えない）。 */
  reset(): void;
}

/** 起動の記録の設定。 */
export interface CountingForkOptions {
  /** 起動の前に、起動の設定を受け取る（環境の写しを記録するなど）。 */
  readonly onFork?: (options: ForkOptions) => void;
}

/** 本物の `fork` で起動し、起動の回数と起動した子を記録する。 */
export function createCountingFork(forkOptions: CountingForkOptions = {}): CountingFork {
  const children: ChildProcess[] = [];
  let count = 0;
  return {
    fork: (modulePath, args, options) => {
      count += 1;
      forkOptions.onFork?.(options);
      const child = fork(modulePath, [...args], options);
      children.push(child);
      return child;
    },
    children,
    count: () => count,
    reset: () => {
      count = 0;
    },
  };
}

/** 親から子への `START` のメッセージか。 */
const isStartMessage = (message: unknown): boolean => isRecord(message) && message['type'] === 'START';

/** 時計が `until`（`performance.now()` の値）を過ぎるか、`condition` が偽になるまで、事象の処理をせずに待つ。 */
function busyWait(until: number, condition: () => boolean = () => true): void {
  while (condition() && performance.now() < until) {
    // 同期にふさぐ（IPC の受け取りと子の終わりの通知を、親が処理できないようにする）。
  }
}

/**
 * `base` で起動した子の `send` を包み、`START` を送った直後に、子の process が終わるまで（上限 `BLOCKED_PARENT_EXIT_WAIT_LIMIT_MS`）と、
 * さらに `BLOCKED_PARENT_EXTRA_MS` だけ、親を同期にふさぐ（DEF-084）。ほかのメッセージは、そのまま送る。
 */
export const blockingAfterStartFork = (base: AuditWorkerForker): AuditWorkerForker => (modulePath, args, options) => {
  const child = base(modulePath, args, options);
  const send = child.send.bind(child) as (...sendArgs: unknown[]) => boolean;
  const blockingSend = (...sendArgs: unknown[]): boolean => {
    const result = send(...sendArgs);
    if (isStartMessage(sendArgs[0])) {
      const processId = child.pid ?? 0;
      busyWait(performance.now() + BLOCKED_PARENT_EXIT_WAIT_LIMIT_MS, () => isProcessRunning(processId));
      busyWait(performance.now() + BLOCKED_PARENT_EXTRA_MS);
    }
    return result;
  };
  child.send = blockingSend as ChildProcess['send'];
  return child;
};
