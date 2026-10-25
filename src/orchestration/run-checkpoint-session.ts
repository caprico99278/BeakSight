import { clearInterval, setInterval } from 'node:timers';
import { isDeepStrictEqual } from 'node:util';
import type { PageId, RunId } from '../core/contracts.js';
import { wait } from '../core/deadline.js';
import { isRecord } from '../core/guards.js';
import { isPageId } from '../core/ids.js';
import {
  createRunLock,
  currentProcessRunLockHost,
  isOwnRunLock,
  isProcessRunning,
  renewRunLock,
  takeOverStaleLock,
  RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  type RunLock,
  type RunLockHost,
} from '../core/process-lock.js';
import {
  checkRunCheckpointConsistency,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunCheckpointPageWriteOptions,
  type RunCheckpointStore,
} from './run-checkpoint.js';

// 再開のための保存のセッション（中断した Run の再開の設計書 4.3.1。この意味の owner）。
// 保存、ロック、ハートビート、最後の状態の書き出しを、1つの部品にまとめる。
// - ファイルの読み書きは、注入された保存の書き手（`RunCheckpointStore`。本番は `ArtifactWriter`）に任せる（ARCH08）。
// - 保存とロックの中身は、R2 の関数（`createRunLock`、`renewRunLock`）と、呼び出し側が作った値（`createRunCheckpoint` などの値）である。
//   ロックの判定は、R2 の `judgeRunLock` が行う（設計書 4.4）。
// - 作るのは CLI か、テストである。Run Coordinator は、始める、ページの保存、状態の保存だけを頼む。最後の状態の書き出し（終える）と、
//   やめるは、CLI が呼ぶ（設計書 4.3.1）。

/**
 * ハートビートで読み直したロックが読めない（ない、JSON でない）ときに、もう 1 回読み直す前に置く間（ms。DEF-170。一時的な読み取りの失敗を、
 * ロックを失ったとみなさないため。2 回目も自分のものと分からなければ、失ったとする）。
 */
export const RUN_LOCK_REREAD_DELAY_MS = 200;

/**
 * ロックを失った（DEF-170）。ハートビートで読み直したロックが、ほかの起動のものだった（または読めなかった）。この起動は、すぐにサイトへの読み込みを
 * 止め、Run のディレクトリに何も書かずに終わる（最後の状態・成果物・保存を書かない。ロックのファイルにも触らない。今の持ち主のもの）。
 * 保存のセッションの保存と終える（`savePage`・`saveState`・`finish`）と、Run Coordinator が投げる。CLI とワーカーは、別の起動が Run を持つときと
 * 同じ終わり方（`RUN_ACTIVE`）にし、ロックを失ったことを知らせる。
 */
export class RunLockLostError extends Error {
  override readonly name = 'RunLockLostError';
  /** Run の ID（Run Coordinator が投げたとき。保存のセッションが投げたときは `null`）。 */
  readonly runId: RunId | null;
  readonly runDirectory: string;

  constructor(input: { readonly runId: RunId | null; readonly runDirectory: string }) {
    super('RUN_LOCK_LOST: another start holds the lock of this Run; this start stopped without writing into the run directory');
    this.runId = input.runId;
    this.runDirectory = input.runDirectory;
  }
}

/** ハートビートのタイマー（`setInterval` の戻り値）。`unref` で、プロセスの終わりを妨げないようにする。 */
export interface RunCheckpointHeartbeatTimer {
  unref(): unknown;
}

/** ハートビートに使うタイマー（`setInterval`・`clearInterval` に当たるもの。テストで注入するための口）。 */
export interface RunCheckpointSessionTimers {
  setInterval(callback: () => void, intervalMs: number): RunCheckpointHeartbeatTimer;
  clearInterval(timer: RunCheckpointHeartbeatTimer): void;
}

/** 既定のタイマー（Node の `node:timers`）。 */
const NODE_TIMERS: RunCheckpointSessionTimers = Object.freeze({
  setInterval: (callback: () => void, intervalMs: number): NodeJS.Timeout => setInterval(callback, intervalMs),
  // 渡されるのは、この既定の `setInterval` が返したタイマーだけである。
  clearInterval: (timer: RunCheckpointHeartbeatTimer): void => clearInterval(timer as NodeJS.Timeout),
});

/** `RunCheckpointSession` を作るときに受け取るもの。 */
export interface RunCheckpointSessionOptions {
  /** 保存とロックのファイルの書き手（本番は `ArtifactWriter`）。 */
  readonly store: RunCheckpointStore;
  /** 今の時刻（エポックからの ms。`Date.now()` と同じ基準）。ロックを取った時刻と、ハートビートの時刻に使う。 */
  readonly now: () => number;
  /**
   * 今のプロセスのロックの値を作る関数。省略すると `currentProcessRunLockHost`。ロックの中身と、再開のときのロックの判定の、今の時刻と
   * 今の OS の起動の時刻に使う。
   */
  readonly createLockHost?: ((nowMs: number) => RunLockHost) | undefined;
  /** ハートビートのタイマー。省略すると Node の `setInterval`・`clearInterval`。 */
  readonly timers?: RunCheckpointSessionTimers | undefined;
  /** 再開のときのロックの判定で、ロックのプロセスが動いているかを調べる関数。省略すると `isProcessRunning`。 */
  readonly isProcessRunning?: ((processId: number) => boolean) | undefined;
  /**
   * 待つ関数（DEF-170 の読み直しの間、DEF-172 の取り直す前の猶予）。省略すると `src/core/deadline.ts` の `wait`。テストは注入した待ちで、実際には
   * 待たずに進める。
   */
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  /** DEF-172: 再開のときに、動いている持ち主のロックを取り直す前に待つことの知らせ（待つ時間 ms）。省略は知らせない。 */
  readonly onLockGraceWait?: ((waitMs: number) => void) | undefined;
}

/**
 * セッションの始め方の閉じた一覧。
 * - `NEW_RUN`: 新しい Run。Run のディレクトリは、作ったばかりのもの（設計書 4.4 の DEF-009）。
 * - `RESUME`: 中断した Run の再開。Run のディレクトリは、前の回のもの。古いロックを作り直し、読み直し、後始末をしてから始める
 *   （設計書 4.4、4.5）。
 */
export const RUN_CHECKPOINT_SESSION_START_MODES = Object.freeze(['NEW_RUN', 'RESUME'] as const);
export type RunCheckpointSessionStartMode = (typeof RUN_CHECKPOINT_SESSION_START_MODES)[number];

/** 新しい Run の始め方（`NEW_RUN`）の指定。 */
export interface RunCheckpointSessionNewRunStartOptions {
  readonly mode: Extract<RunCheckpointSessionStartMode, 'NEW_RUN'>;
}

/** 再開の始め方（`RESUME`）の指定。 */
export interface RunCheckpointSessionResumeStartOptions {
  readonly mode: Extract<RunCheckpointSessionStartMode, 'RESUME'>;
  /** 再開に使う保存の、終わったページの ID（`state.json` の `completedPageIds`）。後始末で、これにないページのものを消す。 */
  readonly completedPageIds: readonly PageId[];
  /**
   * SR-1-F5（SR-1R3 の M3）: 再開を選んだときに読んだ状態の保存（省略できる）。渡すと、Run のロックを取った後（取り直す前の猶予の後を含む）、
   * 後始末の前に、状態の保存を読み直し（書き手の `readCheckpointState`）、これと違えば（読めない、持ち主が終えた、別のページまで進んだ）、
   * 取ったロックを外して、再開を始めない（`LOCK_HELD_BY_ACTIVE_RUN`。別の起動が、この Run を動かしていた）。
   */
  readonly expectedState?: RunCheckpoint | undefined;
}

/** `RunCheckpointSession.start` の指定。 */
export type RunCheckpointSessionStartOptions = RunCheckpointSessionNewRunStartOptions | RunCheckpointSessionResumeStartOptions;

/**
 * 再開の始め方で、始めなかった理由の閉じた一覧（設計書 4.4）。
 * - `LOCK_HELD_BY_ACTIVE_RUN`: ロックが、動いている Run のもの（`judgeRunLock` が `ACTIVE`）。別のプロセスが、この Run を実行している。
 * - `LOCK_TAKEN_OVER_CONCURRENTLY`: 古いロックを作り直した後に読み直すと、自分のもの（プロセスの ID とロックを取った時刻が同じ）で
 *   なかった。別のプロセスが、同時に作り直した。
 */
export const RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS = Object.freeze([
  'LOCK_HELD_BY_ACTIVE_RUN',
  'LOCK_TAKEN_OVER_CONCURRENTLY',
] as const);
export type RunCheckpointSessionResumeFailureReason = (typeof RUN_CHECKPOINT_SESSION_RESUME_FAILURE_REASONS)[number];

/**
 * 新しい Run の始め方（`NEW_RUN`）の結果。
 * - `ok` が真: ロックを作り、ハートビートを始めた。
 * - `ok` が偽: ロックのファイルがすでにあったので、始めなかった。`existingLock` は、その中身（読めなければ `null`）。
 */
export type RunCheckpointSessionNewRunStart =
  | { readonly ok: true }
  | { readonly ok: false; readonly existingLock: unknown };

/**
 * 再開の始め方（`RESUME`）の結果。
 * - `ok` が真: ロックを作る（または古いロックを作り直す）、後始末、ハートビートを、この順に行った。`removedPaths` は、後始末で消した
 *   ものの、Run のディレクトリからの相対パス（書き手の `cleanUpForResume` の結果）。
 * - `ok` が偽: 始めなかった（ハートビートも後始末もしていない）。`reason` は、その理由。`existingLock` は、判定したロックの中身
 *   （`LOCK_TAKEN_OVER_CONCURRENTLY` では、読み直した中身。読めなければ `null`）。
 */
export type RunCheckpointSessionResumeStart =
  | { readonly ok: true; readonly removedPaths: readonly string[] }
  | { readonly ok: false; readonly reason: RunCheckpointSessionResumeFailureReason; readonly existingLock: unknown };

/**
 * `RunCheckpointSession.start` の結果（`NEW_RUN` なら `RunCheckpointSessionNewRunStart`、`RESUME` なら `RunCheckpointSessionResumeStart`
 * の形）。書き手が書けなかった場合は、結果を返さずに reject する。
 */
export type RunCheckpointSessionStart = RunCheckpointSessionNewRunStart | RunCheckpointSessionResumeStart;

/**
 * セッションの段階。`IDLE`（始める前、または始められなかった）→ `STARTING` → `ACTIVE` → `FINISHING`（終える途中）→ `ENDED`
 * （終えた、またはやめた）。`ACTIVE` からやめると、`ENDED` になる。
 */
type SessionPhase = 'IDLE' | 'STARTING' | 'ACTIVE' | 'FINISHING' | 'ENDED';

const STORE_OPERATION_NAMES = Object.freeze([
  'writeCheckpointPage',
  'writeCheckpointState',
  'acquireRunLock',
  'rewriteRunLock',
  'readRunLock',
  'takeOverRunLock',
  'releaseRunLock',
  'cleanUpForResume',
] as const satisfies readonly (keyof RunCheckpointStore)[]);
const TIMER_OPERATION_NAMES = Object.freeze(['setInterval', 'clearInterval'] as const satisfies readonly (keyof RunCheckpointSessionTimers)[]);

const hasFunctions = (value: unknown, names: readonly string[]): boolean =>
  isRecord(value) && names.every((name) => typeof value[name] === 'function');

/** 再開の始め方の、終わったページの ID の一覧を確かめる（配列でなければ `TypeError`、ページの ID の形でない項目があれば `RangeError`）。 */
function assertCompletedPageIds(value: unknown): asserts value is readonly PageId[] {
  if (!Array.isArray(value)) {
    throw new TypeError('RunCheckpointSession.start with RESUME requires the list of completed page IDs');
  }
  for (const pageId of value as readonly unknown[]) {
    if (!isPageId(pageId)) {
      throw new RangeError(`RunCheckpointSession.start with RESUME requires page IDs: ${String(JSON.stringify(pageId))}`);
    }
  }
}

/**
 * 再開のための保存のセッション（設計書 4.3.1）。1つの Run の1回の実行で、1つだけ使う。
 *
 * - `start`: ロックを排他的に作り、`RUN_LOCK_HEARTBEAT_INTERVAL_MS` ごとのハートビートを始める。タイマーは `unref` する。
 *   再開（`RESUME`）では、古いロックを作り直して読み直し、後始末をしてから、ハートビートを始める（設計書 4.4、4.5）。
 * - `savePage`・`saveState`: 保存を書き手に渡す。失敗は、呼び出し側に reject として返す。
 * - `finish`: 最後の状態を書き、ハートビートを止め、ロックを外す（CLI が、最後の出力を書き終えた後に呼ぶ）。
 * - `abandon`: ハートビートを止める。ロックは外さない（保存の状態は `IN_PROGRESS` のまま残り、後で再開できる。ロックは、
 *   ハートビートが止まるので、`RUN_LOCK_STALE_AFTER_MS` の後に古いとみなされる）。
 *
 * ハートビートの書き出しの失敗は、外に投げず、Run を止めない（次の回で書き直す）。前の回の書き出しが終わっていなければ、その回は
 * 飛ばす。DEF-170: ハートビートは、読み直したロックが自分のものときだけ書き換える。違えば書き換えず、ハートビートを止め、`lockLost` を真にする。`finish` と `abandon` は、書き出し中のハートビートの終わりを待つ（ロックを外した後に、ハートビートの書き出しがロックの
 * ファイルを作り直さないようにするため）。
 */
export class RunCheckpointSession {
  readonly #store: RunCheckpointStore;
  readonly #now: () => number;
  readonly #createLockHost: (nowMs: number) => RunLockHost;
  readonly #timers: RunCheckpointSessionTimers;
  readonly #isProcessRunning: (processId: number) => boolean;
  #phase: SessionPhase = 'IDLE';
  #runDirectory = '';
  #lock: RunLock | null = null;
  #heartbeatTimer: RunCheckpointHeartbeatTimer | null = null;
  #heartbeatWrite: Promise<void> | null = null;
  #lockLost = false;
  readonly #lockLostController = new AbortController();
  readonly #wait: (ms: number) => Promise<void>;
  readonly #onLockGraceWait: ((waitMs: number) => void) | undefined;

  /**
   * 不正な指定（書き手の7つの操作、時刻、ロックの値を作る関数、タイマー、プロセスが動いているかを調べる関数が関数でない）は
   * `TypeError` を投げる。
   */
  constructor(options: RunCheckpointSessionOptions) {
    const given: unknown = options;
    if (!isRecord(given)) {
      throw new TypeError('RunCheckpointSession options must be an object');
    }
    if (!hasFunctions(given.store, STORE_OPERATION_NAMES)) {
      throw new TypeError(`RunCheckpointSession store must have ${STORE_OPERATION_NAMES.join(', ')}`);
    }
    if (typeof given.now !== 'function') {
      throw new TypeError('RunCheckpointSession requires a now function');
    }
    if (given.createLockHost !== undefined && typeof given.createLockHost !== 'function') {
      throw new TypeError('RunCheckpointSession createLockHost must be a function when given');
    }
    if (given.timers !== undefined && !hasFunctions(given.timers, TIMER_OPERATION_NAMES)) {
      throw new TypeError(`RunCheckpointSession timers must have ${TIMER_OPERATION_NAMES.join(', ')} when given`);
    }
    if (given.isProcessRunning !== undefined && typeof given.isProcessRunning !== 'function') {
      throw new TypeError('RunCheckpointSession isProcessRunning must be a function when given');
    }
    this.#store = options.store;
    this.#now = options.now;
    this.#createLockHost = options.createLockHost ?? currentProcessRunLockHost;
    this.#timers = options.timers ?? NODE_TIMERS;
    this.#isProcessRunning = options.isProcessRunning ?? isProcessRunning;
    if (given.wait !== undefined && typeof given.wait !== 'function') {
      throw new TypeError('RunCheckpointSession wait must be a function when given');
    }
    if (given.onLockGraceWait !== undefined && typeof given.onLockGraceWait !== 'function') {
      throw new TypeError('RunCheckpointSession onLockGraceWait must be a function when given');
    }
    this.#wait = options.wait ?? wait;
    this.#onLockGraceWait = options.onLockGraceWait;
  }

  /**
   * セッションを始める（設計書 4.3.1、4.4、4.5）。`runDirectory` は、Run のディレクトリ（新しい Run では作ったばかりのもの、再開では
   * 前の回のもの）。今のプロセスの値（`createLockHost(now())`）からロックの中身を作り（`createRunLock`）、書き手の `acquireRunLock` で
   * 排他的に作る。
   *
   * 新しい Run（`NEW_RUN`）:
   * - ロックのファイルがすでにあれば、`{ ok: false, existingLock }` を返す（新しい Run のディレクトリなので、ふつうは起きない）。
   * - 作れたら、ハートビートのタイマーを始めて `unref` し、`{ ok: true }` を返す。
   *
   * 再開（`RESUME`。`completedPageIds` は、再開に使う保存の終わったページの ID）:
   * 1. ロックを作れたら、3 へ。
   * 2. ロックのファイルがすでにあれば、その中身を `judgeRunLock` で判定する（今の時刻と今の OS の起動の時刻は `createLockHost` の値、
   *    プロセスが動いているかは `isProcessRunning`）。`ACTIVE` なら、`{ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN', existingLock }`
   *    を返す。`STALE` なら、書き手の `takeOverRunLock` で原子的に取り直す（DEF-060。`#takeOverStaleLock`。判定し直しを含む）。ほかの起動が
   *    同時に取り直したら、ロックに触れずに（相手のロックのまま）、`{ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY', existingLock: <読み直した
   *    中身> }` を返す（LG-4: 書き手は `takeOverRunLock` を必ず持つ。書き換えて読み直す前の方式は捨てた）。
   * 3. 書き手の `cleanUpForResume` で後始末を行う（ハートビートと保存の書き出しの前。書き出しの途中の一時ファイルを消すため）。
   *    DEF-170: その後にロックを読み直し、自分のもの（`isOwnRunLock`）でなければ、`{ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY', existingLock:
   *    <読み直した中身> }` を返す（ハートビートを始めない）。
   * 4. ハートビートのタイマーを始めて `unref` し、`{ ok: true, removedPaths }`（後始末で消したもの）を返す。
   *
   * 始めなかった場合（`ok` が偽）は、ハートビートを始めない。書き手が失敗した場合と、ロックの値が不正な場合は reject する（作った、
   * または作り直したロックのファイルは残る。プロセスが終われば古いとみなされる）。始められなかったセッションは、始める前と同じ段階に
   * 戻る。始めた後のセッションでもう一度呼ぶと reject する。`runDirectory` が空なら `TypeError`、`mode` が閉じた一覧にないなら
   * `RangeError`、`RESUME` の `completedPageIds` が配列でなければ `TypeError`、ページの ID の形でない項目があれば `RangeError`
   * （どれも、書き手に何も頼まずに投げる）。
   */
  async start(runDirectory: string, options: RunCheckpointSessionStartOptions): Promise<RunCheckpointSessionStart> {
    if (typeof runDirectory !== 'string' || runDirectory.length === 0) {
      throw new TypeError('RunCheckpointSession.start requires a non-empty run directory');
    }
    const mode: unknown = isRecord(options) ? options.mode : undefined;
    if (!(RUN_CHECKPOINT_SESSION_START_MODES as readonly unknown[]).includes(mode)) {
      throw new RangeError(`RunCheckpointSession.start mode must be one of ${RUN_CHECKPOINT_SESSION_START_MODES.join(', ')}`);
    }
    if (options.mode === 'RESUME') {
      assertCompletedPageIds(options.completedPageIds);
    }
    if (this.#phase !== 'IDLE') {
      throw new Error('RunCheckpointSession has already been started');
    }
    this.#phase = 'STARTING';
    try {
      const host = this.#createLockHost(this.#now());
      const lock = createRunLock(host);
      const acquisition = await this.#store.acquireRunLock(runDirectory, lock);
      let removedPaths: readonly string[] | null = null;
      if (options.mode === 'NEW_RUN') {
        if (!acquisition.acquired) {
          this.#phase = 'IDLE';
          return Object.freeze<RunCheckpointSessionNewRunStart>({ ok: false, existingLock: acquisition.existing });
        }
      } else {
        if (!acquisition.acquired) {
          const refusal = await this.#takeOverStaleLock(runDirectory, host, lock, acquisition.existing);
          if (refusal !== null) {
            this.#phase = 'IDLE';
            return refusal;
          }
        }
        // SR-1-F5（SR-1R3 の M3）: ロックを取った後、後始末の前に、状態の保存が再開を選んだときと同じかを確かめる。違えば、取ったロックを外して
        // 始めない（猶予の間に持ち主が終えた、進めた。古い判断で再開しない）。
        if (options.expectedState !== undefined && !(await this.#stateUnchanged(runDirectory, options.expectedState))) {
          await this.#store.releaseRunLock(runDirectory);
          this.#phase = 'IDLE';
          return Object.freeze<RunCheckpointSessionResumeStart>({ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN', existingLock: null });
        }
        removedPaths = Object.freeze([...await this.#store.cleanUpForResume(runDirectory, options.completedPageIds)]);
        // DEF-170: 後始末の後に、ロックが今も自分のものかを読み直す（ほかの起動に動かされ、空いた名前に別のロックが作られていれば、始めない）。
        const current = await this.#store.readRunLock(runDirectory);
        if (!isOwnRunLock(current, lock)) {
          this.#phase = 'IDLE';
          return Object.freeze<RunCheckpointSessionResumeStart>({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY', existingLock: current });
        }
      }
      this.#runDirectory = runDirectory;
      this.#lock = lock;
      this.#heartbeatTimer = this.#timers.setInterval(() => {
        this.#beat();
      }, RUN_LOCK_HEARTBEAT_INTERVAL_MS);
      this.#heartbeatTimer.unref();
      this.#phase = 'ACTIVE';
      return removedPaths === null
        ? Object.freeze<RunCheckpointSessionNewRunStart>({ ok: true })
        : Object.freeze<RunCheckpointSessionResumeStart>({ ok: true, removedPaths });
    } catch (error) {
      // 始められなかった。作ったタイマーは止める（ロックのファイルは、作れていれば残る。プロセスが終われば古いとみなされる）。
      const timer = this.#heartbeatTimer;
      this.#heartbeatTimer = null;
      if (timer !== null) {
        this.#timers.clearInterval(timer);
      }
      this.#phase = 'IDLE';
      throw error;
    }
  }

  /**
   * ページの保存（R2 の `createRunCheckpointPage` の値）を、書き手の `writeCheckpointPage` で書く。失敗は reject する。T44R3 の M-2: `options` は、
   * そのまま書き手に渡す（巡回が知っている URL）。
   */
  async savePage(page: RunCheckpointPage, options?: RunCheckpointPageWriteOptions): Promise<void> {
    this.#requireActive('savePage');
    await this.#requireLockHeld();
    await (options === undefined
      ? this.#store.writeCheckpointPage(this.#runDirectory, page)
      : this.#store.writeCheckpointPage(this.#runDirectory, page, options));
  }

  /** 状態の保存（R2 の `createRunCheckpoint` の値）を、書き手の `writeCheckpointState` で書く。失敗は reject する。 */
  async saveState(state: RunCheckpoint): Promise<void> {
    this.#requireActive('saveState');
    await this.#requireLockHeld();
    await this.#store.writeCheckpointState(this.#runDirectory, state);
  }

  /**
   * セッションを終える（設計書 4.3.1。CLI が、最後の出力を書き終えた後に呼ぶ）。最後の状態の保存の値（`state` が `FINISHED` か
   * `STOPPED`。作るのは呼び出し側）を `writeCheckpointState` で書き、ハートビートを止め（書き出し中のものは終わりを待つ）、
   * `releaseRunLock` でロックを外す。
   * 最後の状態を書けなかった場合は、ハートビートを止め、ロックは外さずに reject する（保存の状態は `IN_PROGRESS` のまま残る）。
   * ロックを外せなかった場合も reject する。どちらの場合も、セッションは終わった段階になる。始めていないセッションでは reject する。
   */
  async finish(finalState: RunCheckpoint): Promise<void> {
    this.#requireActive('finish');
    await this.#requireLockHeld();
    this.#phase = 'FINISHING';
    try {
      await this.#store.writeCheckpointState(this.#runDirectory, finalState);
    } finally {
      await this.#stopHeartbeat();
    }
    await this.#store.releaseRunLock(this.#runDirectory);
  }

  /**
   * セッションをやめる（Run が例外で終わった場合などに、CLI が呼ぶ）。ハートビートを止め（書き出し中のものは終わりを待つ）、ロックは
   * 外さない。reject しない。始めていない、またはすでに終えたセッションでは、何もしない。
   */
  async abandon(): Promise<void> {
    if (this.#phase !== 'ACTIVE') {
      return;
    }
    await this.#stopHeartbeat();
  }

  /**
   * 再開のときに、すでにあったロック（`existing`）を判定し、古ければ自分のロック（`lock`）で取り直す（設計書 4.4）。取り直して自分のものに
   * なったら `null` を返す。始めない場合は、その結果（`ok` が偽）を返す。
   * 書き手の `takeOverRunLock` で、原子的に取り直す（`takeOverStaleLock`。古いファイルを一意の名前へ動かしてから `wx` で作る。DEF-060）。動いている
   * Run のロックなら `LOCK_HELD_BY_ACTIVE_RUN`、ほかの起動が同時に取り直したら `LOCK_TAKEN_OVER_CONCURRENTLY`（`existingLock` は、読み直した今の
   * 中身）。
   */
  async #takeOverStaleLock(
    runDirectory: string,
    host: RunLockHost,
    lock: RunLock,
    existing: unknown,
  ): Promise<RunCheckpointSessionResumeStart | null> {
    const judgement = { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning: this.#isProcessRunning };
    const store = this.#store;
    // DEF-172: 動いている持ち主のロックが古く見えるときは、取り直す前に猶予を置いて読み直す（`judgeRunLockWithGrace`）。
    const result = await takeOverStaleLock({
      acquire: async (value) => await store.acquireRunLock(runDirectory, value),
      takeOver: async (judged, value) => await store.takeOverRunLock(runDirectory, judged, value),
    }, existing, lock, judgement, {
      reread: async () => await store.readRunLock(runDirectory),
      wait: this.#wait,
      onWait: this.#onLockGraceWait,
    });
    switch (result.kind) {
      case 'ACQUIRED':
        return null;
      case 'HELD':
        return Object.freeze<RunCheckpointSessionResumeStart>({ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN', existingLock: result.existing });
      case 'CONTENDED':
        return Object.freeze<RunCheckpointSessionResumeStart>({
          ok: false,
          reason: 'LOCK_TAKEN_OVER_CONCURRENTLY',
          existingLock: await store.readRunLock(runDirectory),
        });
    }
  }

  /**
   * DEF-170・DEF-172: Run のディレクトリに書く前に、ロックが今も自分のものかを読んで確かめる（`confirmLockHeld`）。違えば何も書かずに
   * `RunLockLostError` を投げる（今の持ち主の保存を壊さない）。
   */
  async #requireLockHeld(): Promise<void> {
    if (!(await this.confirmLockHeld())) {
      throw new RunLockLostError({ runId: null, runDirectory: this.#runDirectory });
    }
  }

  /**
   * DEF-172: ロックのファイルを読んで、今も自分のものかを確かめる（読み込みの直前と、Run のディレクトリへの書き込みの直前に呼ぶ）。自分のものなら
   * 真。読めないときは、ハートビートと同じく `RUN_LOCK_REREAD_DELAY_MS` を置いて 1 回だけ読み直す。違えば（読めないままを含む）、ロックを失った
   * （`lockLost`・`lockLostSignal`。ハートビートを止める）として偽。すでに失っていれば、読まずに偽。始めていないセッションでは偽。読み取りの失敗
   * （reject）は、そのまま reject する。
   */
  async confirmLockHeld(): Promise<boolean> {
    const lock = this.#lock;
    if (this.#lockLost || lock === null) {
      return false;
    }
    if (await this.#readsOwnLock(lock)) {
      return true;
    }
    this.#loseLock();
    return false;
  }

  /**
   * SR-1-F5: 状態の保存を読み直し、`expected`（再開を選んだときの保存）と同じか。書き手が読み方を持たなければ、確かめずに真（今までどおり）。
   * 読めなければ偽。
   */
  async #stateUnchanged(runDirectory: string, expected: RunCheckpoint): Promise<boolean> {
    const read = this.#store.readCheckpointState;
    if (read === undefined) {
      return true;
    }
    const current = await read.call(this.#store, runDirectory, checkRunCheckpointConsistency);
    return current.ok && isDeepStrictEqual(current.state, expected);
  }

  /** ロックを読み、自分のもの（`isOwnRunLock`）か。読めない（ない、JSON でない）ときは、間を置いて 1 回だけ読み直す（DEF-170、DEF-172）。 */
  async #readsOwnLock(lock: RunLock): Promise<boolean> {
    const runDirectory = this.#runDirectory;
    let current = await this.#store.readRunLock(runDirectory);
    if (current === null) {
      await this.#wait(RUN_LOCK_REREAD_DELAY_MS);
      current = await this.#store.readRunLock(runDirectory);
    }
    return isOwnRunLock(current, lock);
  }

  #requireActive(operation: string): void {
    if (this.#phase !== 'ACTIVE') {
      throw new Error(`RunCheckpointSession.${operation} requires a started session, but the session is not active`);
    }
  }

  /**
   * ハートビートで、ロックが自分のものでなくなったと分かったか（DEF-170。読み直したロックが、ほかの起動のものだった）。真になったら、ハートビートは
   * 止まり、ロックを書き換えない。
   */
  get lockLost(): boolean {
    return this.#lockLost;
  }

  /** ロックを失ったときに付く印（DEF-170。Run Coordinator が読み、すぐに読み込みを止めて、Run のディレクトリに書かずに終える）。 */
  get lockLostSignal(): AbortSignal {
    return this.#lockLostController.signal;
  }

  /**
   * ハートビートの1回分。前の回の書き出しが終わっていなければ飛ばす。失敗は、外に投げない（次の回で書き直す）。
   * DEF-170: ロックを読み直し、自分のもの（`isOwnRunLock`）のときだけ書き換える。読めなかった（ない、読めない）か、ほかの起動のものなら、書き換えず
   * （ほかの起動のロックを上書きしない）、`lockLost` を真にして、ハートビートを止める。
   */
  #beat(): void {
    const lock = this.#lock;
    const beating = this.#phase === 'ACTIVE' || this.#phase === 'FINISHING';
    if (!beating || this.#heartbeatWrite !== null || lock === null || this.#lockLost) {
      return;
    }
    const runDirectory = this.#runDirectory;
    // 時刻の読み取り、ロックの値の作成、書き手の同期の例外も、Promise の reject として扱い、外に投げない。
    this.#heartbeatWrite = Promise.resolve()
      .then(async () => {
        // 読めない（ない、JSON でない）ときは、一時的な失敗を考え、少し置いて 1 回だけ読み直す（それでも自分のものと分からなければ失った）。
        if (!(await this.#readsOwnLock(lock))) {
          this.#loseLock();
          return;
        }
        await this.#store.rewriteRunLock(runDirectory, renewRunLock(lock, this.#now()));
      })
      .catch(() => undefined)
      .finally(() => {
        this.#heartbeatWrite = null;
      });
  }

  /**
   * ロックを失った（DEF-170）。ハートビートのタイマーを止め、`lockLostSignal` を付ける（Run Coordinator が読み込みを止める）。セッションの段階は
   * 変えない（やめるは呼び出し側。保存と終えるは、この後 `RunLockLostError` で拒む）。
   */
  #loseLock(): void {
    this.#lockLost = true;
    this.#lockLostController.abort();
    const timer = this.#heartbeatTimer;
    this.#heartbeatTimer = null;
    if (timer !== null) {
      this.#timers.clearInterval(timer);
    }
  }

  /** ハートビートのタイマーを止め、書き出し中のハートビートの終わりを待つ。セッションは終わった段階になる。 */
  async #stopHeartbeat(): Promise<void> {
    this.#phase = 'ENDED';
    const timer = this.#heartbeatTimer;
    this.#heartbeatTimer = null;
    if (timer !== null) {
      this.#timers.clearInterval(timer);
    }
    await this.#heartbeatWrite;
  }
}
