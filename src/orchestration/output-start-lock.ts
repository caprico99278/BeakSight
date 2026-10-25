/**
 * 出力先の開始のロックと、出力先の動いている Run の確かめ（DEF-057。Task 24 の設計書 4.6、中断した Run の再開の設計書 4.7.1。CCX-6 で、
 * CLI の監査 `src/cli/audit-run.ts` と、ワーカーの Run `src/worker/worker-run-session.ts` の 2 か所から 1 つにした。共通化の台帳の CC-070）。
 * - 開始のロック（`holdOutputStartLock`）: 中身は Run のロックと同じ形（`createRunLock(currentProcessRunLockHost(nowMs))`）。
 *   1. 書き手の `acquireOutputStartLock`（`wx`）で作れたら `ACQUIRED`。
 *   2. すでにあれば、`acquireLockTakingOverStale`（判定は `judgeRunLock`、古ければ原子的な取り直し `takeOverStaleLock`。保存のセッションの
 *      Run のロックの取り直しと同じ部品。DEF-060）。取り直せたら `ACQUIRED`、動いている持ち主のもの（`HELD`）か、別の起動が同時に
 *      取り直した（`CONTENDED`）なら `HELD_BY_ANOTHER_START`。
 *   3. 入出力の失敗は `UNAVAILABLE`（型の説明）。
 *   開始のロックのために出力先を作った場合は、作れた `acquireOutputStartLock` の結果の `createdDirectory` を覚える。取り直しの途中の作り直し
 *   （`CHANGED` の後）で作れた場合も覚える（DEF-081。前の持ち主が空の出力先を消した後に作り直したものも、Run を始めずに終われば残さない）。
 *   離すときは、読み直して自分のもの（`isOwnRunLock`）であるときだけ消す（取り直された後に、相手のロックを消さない）。覚えた出力先は、
 *   空のときだけ消す（書き手の `releaseOutputStartLock`。Run のディレクトリができていれば残る）。
 *   DEF-170: 持てた結果の `confirm` で、Run のロックを作る直前に、開始のロックが今も自分のものかを読み直す（違えば呼び出し側は Run を始めない）。
 * - 動いている Run の確かめ（`findActiveRunInOutputDirectory`）: 出力先の Run のディレクトリ（`listRunDirectories`）のロックを、名前の順に読み、
 *   動いている Run のもの（`judgeRunLock` が `ACTIVE`）があれば、その Run の ID。なければ `null`。ロックには対象の ID がないので、対象を問わない。
 * 今の時刻（`nowMs`）は呼ぶ側が渡す（CLI は 1 つの値を使い回し、ワーカーは呼ぶたびに読み直す）。OS の起動の時刻は
 * `currentProcessRunLockHost`、プロセスが動いているかは `isProcessRunning` で判定する。
 * orchestration は report を import しないので、書き手（本番は `ArtifactWriter`）は口の形（`OutputStartLockStore`）で受け取る。ファイルの
 * 読み書きは、書き手だけが行う（ARCH08）。
 */
import { listRunDirectories } from '../core/artifact-layout.js';
import type { RunId } from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import {
  ACTIVE_RUN_LOCK_STATE,
  acquireLockTakingOverStale,
  createRunLock,
  currentProcessRunLockHost,
  isOwnRunLock,
  isProcessRunning,
  judgeRunLock,
  judgeRunLocksWithGrace,
  type RunLockGrace,
  type RunLockTakeover,
} from '../core/process-lock.js';

/**
 * 書き手の `acquireOutputStartLock` の結果（`ArtifactWriter` の `OutputStartLockAcquisition` と同じ形）。作れたときの `createdDirectory` は、
 * 出力先を作るために作った、いちばん上のディレクトリ（出力先がすでにあれば `null`）。
 */
export type OutputStartLockFileAcquisition =
  | { readonly acquired: true; readonly createdDirectory: string | null }
  | { readonly acquired: false; readonly existing: unknown };

/** 出力先の開始のロックと、Run のロックの読み取りの口（本番は `ArtifactWriter` が形の上で満たす）。どれも、書けなければ reject する。 */
export interface OutputStartLockStore {
  acquireOutputStartLock(outputDirectory: string, lock: object): Promise<OutputStartLockFileAcquisition>;
  takeOverOutputStartLock(outputDirectory: string, judged: unknown, lock: object): Promise<RunLockTakeover>;
  readOutputStartLock(outputDirectory: string): Promise<unknown>;
  releaseOutputStartLock(outputDirectory: string, createdDirectory: string | null): Promise<void>;
  readRunLock(runDirectory: string): Promise<unknown>;
}

/**
 * 出力先の開始のロックを取った結果。
 * - `ACQUIRED`: 持てた。開始の段の後に `release` で離す（何回呼んでもよい。reject しない）。
 * - `HELD_BY_ANOTHER_START`: 別の起動が開始の段にいる（動いている持ち主の、新しい開始のロックがある）。Run を始めない。
 * - `UNAVAILABLE`: 出力先や開始のロックのファイルを、入出力の失敗で作れなかった（または古いロックを書き換えられなかった）。開始のロックなしで、
 *   今までと同じに進める（同じ失敗で Run のディレクトリも作れないので、今までの結果（`RUN_DIRECTORY_UNAVAILABLE` など）と文を変えないため）。
 */
export type OutputStartLockAcquisition =
  | {
    readonly kind: 'ACQUIRED';
    readonly release: () => Promise<void>;
    /**
     * DEF-170: 開始のロックが今も自分のものかを読み直す（Run のロックを作る直前に呼ぶ）。自分のものなら真。ほかの起動に動かされた・読めない・
     * 離した後なら偽（呼び出し側は、別の起動が開始の段にいるときと同じに、Run を始めない）。reject しない。
     */
    readonly confirm: () => Promise<boolean>;
  }
  | { readonly kind: 'HELD_BY_ANOTHER_START' }
  | { readonly kind: 'UNAVAILABLE' };

const START_LOCK_HELD_BY_ANOTHER_START: OutputStartLockAcquisition = Object.freeze({ kind: 'HELD_BY_ANOTHER_START' });
const START_LOCK_UNAVAILABLE: OutputStartLockAcquisition = Object.freeze({ kind: 'UNAVAILABLE' });

/**
 * DEF-172: 動いている持ち主のロックが古く見えるときの、取り直す前の猶予の待ちと知らせ（`judgeRunLockWithGrace`）。省略すると、待ちは
 * `src/core/deadline.ts` の `wait`、知らせはなし。
 */
export interface OutputLockGraceOptions {
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  readonly onWait?: ((waitMs: number) => void) | undefined;
}

/** 猶予の口（読み直しは `reread`）。 */
const graceOf = (options: OutputLockGraceOptions, reread: () => Promise<unknown>): RunLockGrace =>
  Object.freeze({ reread, wait: options.wait ?? wait, onWait: options.onWait });

/** 出力先の開始のロックを取る（ファイルの先頭の説明）。DEF-172: 動いている持ち主の古く見えるロックは、猶予の後に読み直してから取り直す。 */
export async function holdOutputStartLock(
  store: OutputStartLockStore,
  outputDirectory: string,
  nowMs: number,
  graceOptions: OutputLockGraceOptions = {},
): Promise<OutputStartLockAcquisition> {
  const host = currentProcessRunLockHost(nowMs);
  const lock = createRunLock(host);
  let createdDirectory: string | null = null;
  try {
    const result = await acquireLockTakingOverStale({
      acquire: async (value) => {
        const acquisition = await store.acquireOutputStartLock(outputDirectory, value);
        if (acquisition.acquired) {
          createdDirectory = acquisition.createdDirectory;
        }
        return acquisition;
      },
      takeOver: async (judged, value) => await store.takeOverOutputStartLock(outputDirectory, judged, value),
    }, lock, { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning },
    graceOf(graceOptions, async () => await store.readOutputStartLock(outputDirectory)));
    if (result.kind !== 'ACQUIRED') {
      return START_LOCK_HELD_BY_ANOTHER_START;
    }
  } catch {
    return START_LOCK_UNAVAILABLE;
  }
  let released = false;
  return Object.freeze({
    kind: 'ACQUIRED',
    confirm: async () => {
      if (released) {
        return false;
      }
      try {
        return isOwnRunLock(await store.readOutputStartLock(outputDirectory), lock);
      } catch {
        return false;
      }
    },
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        if (isOwnRunLock(await store.readOutputStartLock(outputDirectory), lock)) {
          // 開始のロックのために出力先を作っていれば、空のときだけ消す（Run を始めずに終わったときに、出力先を残さない）。
          await store.releaseOutputStartLock(outputDirectory, createdDirectory);
        }
      } catch {
        // 離せなかった開始のロックは、持ち主の process が終わるか、`RUN_LOCK_STALE_AFTER_MS` が過ぎると古いとみなされる（Run は止めない）。
      }
    },
  });
}

/**
 * 出力先の動いている Run の ID（ファイルの先頭の説明）。なければ `null`。待たずに動いていると分かる Run があれば、それ（名前の順の最初）。
 * SR-1-F5: 猶予の要るロックがいくつあっても、まとめて 1 回だけ待つ（`judgeRunLocksWithGrace`。1 回の確かめで最大 `RUN_LOCK_TAKEOVER_GRACE_MS`）。
 * DEF-172: 判定は `judgeRunLockWithGrace` と同じ規則（動いている持ち主のロックが古く
 * 見えるときは、猶予の後に読み直し、ハートビートが進んでいれば動いている Run とする。開始のロックと、保存のセッションの再開と同じ部品）。
 * 猶予は、`graceOptions` を渡したときだけ（Run を始めるかを決める確かめ）。渡さない呼び出し（始めないと決めた後の、知らせの Run の ID を探す）は
 * 待たない。
 */
export async function findActiveRunInOutputDirectory(
  store: Pick<OutputStartLockStore, 'readRunLock'>,
  outputDirectory: string,
  nowMs: number,
  graceOptions?: OutputLockGraceOptions,
): Promise<RunId | null> {
  const host = currentProcessRunLockHost(nowMs);
  const judgement = { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning };
  const runs = await Promise.all((await listRunDirectories(outputDirectory)).map(async ({ runId, runDirectory }) => ({
    runId,
    existing: await store.readRunLock(runDirectory),
    reread: async () => await store.readRunLock(runDirectory),
  })));
  // 待たずに動いている Run と分かるものがあれば、それ（名前の順の最初）。
  const active = runs.find(({ existing }) => judgeRunLock(existing, judgement) === ACTIVE_RUN_LOCK_STATE);
  if (active !== undefined) {
    return active.runId;
  }
  // SR-1-F5（SR-1R3 の I1）: 猶予の要るロックがいくつあっても、まとめて 1 回だけ待つ（`judgeRunLocksWithGrace`）。
  const judged = await judgeRunLocksWithGrace(runs, judgement, graceOptions === undefined ? undefined : graceOf(graceOptions, async () => null));
  const index = judged.findIndex(({ state }) => state === ACTIVE_RUN_LOCK_STATE);
  return index < 0 ? null : runs[index]?.runId ?? null;
}
