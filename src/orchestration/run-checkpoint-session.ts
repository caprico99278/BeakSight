import { clearInterval, setInterval } from 'node:timers';
import type { PageId } from '../core/contracts.js';
import { isRecord } from '../core/guards.js';
import { isPageId } from '../core/ids.js';
import {
  createRunLock,
  currentProcessRunLockHost,
  isProcessRunning,
  judgeRunLock,
  renewRunLock,
  RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunCheckpointStore,
  type RunLock,
  type RunLockHost,
} from './run-checkpoint.js';

// 再開のための保存のセッション（中断した Run の再開の設計書 4.3.1。この意味の owner）。
// 保存、ロック、ハートビート、最後の状態の書き出しを、1つの部品にまとめる。
// - ファイルの読み書きは、注入された保存の書き手（`RunCheckpointStore`。本番は `ArtifactWriter`）に任せる（ARCH08）。
// - 保存とロックの中身は、R2 の関数（`createRunLock`、`renewRunLock`）と、呼び出し側が作った値（`createRunCheckpoint` などの値）である。
//   ロックの判定は、R2 の `judgeRunLock` が行う（設計書 4.4）。
// - 作るのは CLI か、テストである。Run Coordinator は、始める、ページの保存、状態の保存だけを頼む。最後の状態の書き出し（終える）と、
//   やめるは、CLI が呼ぶ（設計書 4.3.1）。

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
  'releaseRunLock',
  'cleanUpForResume',
] as const satisfies readonly (keyof RunCheckpointStore)[]);
const TIMER_OPERATION_NAMES = Object.freeze(['setInterval', 'clearInterval'] as const satisfies readonly (keyof RunCheckpointSessionTimers)[]);

const hasFunctions = (value: unknown, names: readonly string[]): boolean =>
  isRecord(value) && names.every((name) => typeof value[name] === 'function');

/** 読み直したロックの中身が、`lock`（自分が書いたロック）と同じプロセスの ID とロックを取った時刻を持つか（設計書 4.4）。 */
const isOwnRunLock = (value: unknown, lock: RunLock): boolean =>
  isRecord(value) && value.processId === lock.processId && value.acquiredAtMs === lock.acquiredAtMs;

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
 * 飛ばす。`finish` と `abandon` は、書き出し中のハートビートの終わりを待つ（ロックを外した後に、ハートビートの書き出しがロックの
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
   *    を返す。`STALE` なら、自分のロックの中身で `rewriteRunLock` で作り直し、`readRunLock` で読み直す。読み直した中身が自分のもの
   *    （プロセスの ID とロックを取った時刻が同じ）でなければ、ロックに触れずに（相手のロックのまま）、
   *    `{ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY', existingLock: <読み直した中身> }` を返す。
   * 3. 書き手の `cleanUpForResume` で後始末を行う（ハートビートと保存の書き出しの前。書き出しの途中の一時ファイルを消すため）。
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
        removedPaths = Object.freeze([...await this.#store.cleanUpForResume(runDirectory, options.completedPageIds)]);
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

  /** ページの保存（R2 の `createRunCheckpointPage` の値）を、書き手の `writeCheckpointPage` で書く。失敗は reject する。 */
  async savePage(page: RunCheckpointPage): Promise<void> {
    this.#requireActive('savePage');
    await this.#store.writeCheckpointPage(this.#runDirectory, page);
  }

  /** 状態の保存（R2 の `createRunCheckpoint` の値）を、書き手の `writeCheckpointState` で書く。失敗は reject する。 */
  async saveState(state: RunCheckpoint): Promise<void> {
    this.#requireActive('saveState');
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
   * 再開のときに、すでにあったロック（`existing`）を判定し、古ければ自分のロック（`lock`）で作り直して読み直す（設計書 4.4）。
   * 作り直して自分のものになったら `null` を返す。始めない場合は、その結果（`ok` が偽）を返す。
   */
  async #takeOverStaleLock(
    runDirectory: string,
    host: RunLockHost,
    lock: RunLock,
    existing: unknown,
  ): Promise<RunCheckpointSessionResumeStart | null> {
    const state = judgeRunLock(existing, { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning: this.#isProcessRunning });
    if (state === 'ACTIVE') {
      return Object.freeze<RunCheckpointSessionResumeStart>({ ok: false, reason: 'LOCK_HELD_BY_ACTIVE_RUN', existingLock: existing });
    }
    await this.#store.rewriteRunLock(runDirectory, lock);
    const readBack = await this.#store.readRunLock(runDirectory);
    return isOwnRunLock(readBack, lock)
      ? null
      : Object.freeze<RunCheckpointSessionResumeStart>({ ok: false, reason: 'LOCK_TAKEN_OVER_CONCURRENTLY', existingLock: readBack });
  }

  #requireActive(operation: string): void {
    if (this.#phase !== 'ACTIVE') {
      throw new Error(`RunCheckpointSession.${operation} requires a started session, but the session is not active`);
    }
  }

  /** ハートビートの1回分。前の回の書き出しが終わっていなければ飛ばす。失敗は、外に投げない（次の回で書き直す）。 */
  #beat(): void {
    const lock = this.#lock;
    const beating = this.#phase === 'ACTIVE' || this.#phase === 'FINISHING';
    if (!beating || this.#heartbeatWrite !== null || lock === null) {
      return;
    }
    const runDirectory = this.#runDirectory;
    // 時刻の読み取り、ロックの値の作成、書き手の同期の例外も、Promise の reject として扱い、外に投げない。
    this.#heartbeatWrite = Promise.resolve()
      .then(async () => this.#store.rewriteRunLock(runDirectory, renewRunLock(lock, this.#now())))
      .catch(() => undefined)
      .finally(() => {
        this.#heartbeatWrite = null;
      });
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
