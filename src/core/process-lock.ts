/**
 * process のロックの中身と判定、古いロックの原子的な取り直しの手順（中断した Run の再開の設計書 4.4。DEF-057、DEF-060。T24h-3 で
 * `src/orchestration/run-checkpoint.ts` から移した。意味の owner）。
 * - Run のロック（`checkpoint/run.lock`）、出力先の開始のロック、画面のサーバのロック（Task 24 の DEF-061）が、同じ部品を使う。
 * - ファイルは読み書きしない。ロックのファイルの作成・取り直しの口（`LockFilePort`）は、呼び出し側が渡す（本番は `ArtifactWriter`）。
 * - `src/orchestration/run-checkpoint.ts` が、今の名前で export し直す（利用者を変えないため）。
 */
import { uptime } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { errorCodeOf } from './errors.js';
import { isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from './guards.js';
import { MILLISECONDS_PER_SECOND } from './time-units.js';

/**
 * ロックのファイルを排他的に作った結果（設計書 4.4）。
 * - `acquired` が真: この呼び出しで、ロックのファイルを新しく作った。
 * - `acquired` が偽: ロックのファイルがすでにあった。`existing` は、その中身を JSON として読んだ値（読めなければ `null`。判定は
 *   `judgeRunLock`）。
 * `ArtifactWriter` の `RunLockAcquisition`、`run-checkpoint.ts` の `RunCheckpointLockAcquisition` と同じ形である。
 */
export type LockFileAcquisition =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly existing: unknown };

/**
 * ロックを「動いている Run のもの」とみなす、OS の起動の時刻の誤差の上限（ms。設計書 4.4 の 120秒）。端末を再起動した後は、
 * 起動の時刻がこれより大きく違うので、プロセスの ID が別のプロセスに使い回されていても、古いロックと分かる。
 */
export const RUN_LOCK_BOOT_TIME_TOLERANCE_MS = 120_000;
/** ロックを「動いている Run のもの」とみなす、最後の更新からの時間の上限（ms。設計書 4.4 の5分）。 */
export const RUN_LOCK_STALE_AFTER_MS = 300_000;
/**
 * Run の間に、ロックの最後の更新の時刻を書き換える間隔（ms。設計書 4.4 の1分）。タイマーは、保存のセッション
 * （`run-checkpoint-session.ts` の `RunCheckpointSession`）が持つ（設計書 4.3.1）。
 */
export const RUN_LOCK_HEARTBEAT_INTERVAL_MS = 60_000;

/** ロック（`checkpoint/run.lock`）の中身（設計書 4.4）。時刻は、エポックからの ms（0 以上の安全な整数）。 */
export interface RunLock {
  /** ロックを取ったプロセスの ID。 */
  readonly processId: number;
  /** ロックを取ったときの、OS の起動の時刻（`Date.now() - os.uptime() * 1000`）。 */
  readonly bootedAtMs: number;
  /** ロックを取った時刻。 */
  readonly acquiredAtMs: number;
  /** 最後に更新した時刻（ハートビート）。 */
  readonly heartbeatAtMs: number;
}

/** 今のプロセスの値（ロックを作るときと、ロックを判定するときに使う）。 */
export interface RunLockHost {
  readonly processId: number;
  /** 今の時刻（エポックからの ms）。 */
  readonly nowMs: number;
  /** 今の OS の起動の時刻（エポックからの ms）。 */
  readonly bootedAtMs: number;
}

const RUN_LOCK_KEYS: readonly (keyof RunLock)[] = Object.freeze(['processId', 'bootedAtMs', 'acquiredAtMs', 'heartbeatAtMs']);

/** ロックの中身の形か（ちょうど4つの項目。プロセスの ID は正、時刻は 0 以上の安全な整数）。 */
const isRunLock = (value: unknown): value is RunLock => {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === RUN_LOCK_KEYS.length
    && RUN_LOCK_KEYS.every((key) => Object.hasOwn(value, key))
    && isPositiveSafeInteger(value.processId)
    && isNonNegativeSafeInteger(value.bootedAtMs)
    && isNonNegativeSafeInteger(value.acquiredAtMs)
    && isNonNegativeSafeInteger(value.heartbeatAtMs);
};

const requireTimeMs = (name: string, value: number): void => {
  if (!isNonNegativeSafeInteger(value)) {
    throw new RangeError(`run lock ${name} must be a non-negative safe integer of milliseconds`);
  }
};

/**
 * 今のプロセスの値を読む（設計書 4.4）。`nowMs` は `Date.now()` と同じ基準の今の時刻。OS の起動の時刻は
 * `nowMs - os.uptime() * 1000` を ms に丸めたもの（誤差は `RUN_LOCK_BOOT_TIME_TOLERANCE_MS` の中で許す）。
 */
export function currentProcessRunLockHost(nowMs: number): RunLockHost {
  requireTimeMs('current time', nowMs);
  return Object.freeze({
    processId: process.pid,
    nowMs,
    bootedAtMs: Math.max(0, Math.round(nowMs - uptime() * MILLISECONDS_PER_SECOND)),
  });
}

/**
 * 今のプロセスの値から、ロックの中身を作る（設計書 4.4）。ロックを取った時刻と最後に更新した時刻は、どちらも `host.nowMs`。
 * 凍結した、JSON にできる値を返す。プロセスの ID が正の安全な整数でない、時刻が 0 以上の安全な整数でないなら `RangeError`。
 */
export function createRunLock(host: RunLockHost): RunLock {
  if (!isPositiveSafeInteger(host.processId)) {
    throw new RangeError('run lock process ID must be a positive safe integer');
  }
  requireTimeMs('boot time', host.bootedAtMs);
  requireTimeMs('current time', host.nowMs);
  return Object.freeze({
    processId: host.processId,
    bootedAtMs: host.bootedAtMs,
    acquiredAtMs: host.nowMs,
    heartbeatAtMs: host.nowMs,
  });
}

/** ロックの最後に更新した時刻（ハートビート）だけを `nowMs` にした、新しいロックの中身を返す（設計書 4.4）。 */
export function renewRunLock(lock: RunLock, nowMs: number): RunLock {
  requireTimeMs('current time', nowMs);
  return Object.freeze({ ...lock, heartbeatAtMs: nowMs });
}

/**
 * ロックの判定の結果の閉じた一覧（設計書 4.4）。
 * - `ACTIVE`: 動いている Run のもの（再開も、新しい Run もしない）。
 * - `STALE`: 動いている Run のものではない（前の回が途中で終わった印とみなし、ロックを作り直す）。
 */
export const RUN_LOCK_STATES = Object.freeze(['ACTIVE', 'STALE'] as const);
export type RunLockState = (typeof RUN_LOCK_STATES)[number];
/** 動いている Run のロックの判定の結果（`RUN_LOCK_STATES` の `ACTIVE`）。使う側は文字列を書き写さず、これを読む（PRE42-CC 組 R。CC-110）。 */
export const ACTIVE_RUN_LOCK_STATE = 'ACTIVE' satisfies RunLockState;

/** ロックの判定の入力（今の時刻、今の OS の起動の時刻、プロセスが動いているかを調べる関数）。 */
export interface RunLockJudgementInput extends Pick<RunLockHost, 'nowMs' | 'bootedAtMs'> {
  /** プロセスが動いているか。本番では `isProcessRunning`。 */
  readonly isProcessRunning: (processId: number) => boolean;
}

/**
 * ロックの中身（ファイルから読んだ値）を判定する（設計書 4.4）。次のすべてを満たすときだけ `ACTIVE`、それ以外は `STALE` とする。
 * 1. ロックの中身の形が正しい（不正なロックは、動いている Run のものではないので、作り直す）。
 * 2. OS の起動の時刻の差が `RUN_LOCK_BOOT_TIME_TOLERANCE_MS` 以内である。
 * 3. ロックのプロセスが動いている（`current.isProcessRunning`）。
 * 4. 最後に更新した時刻から、`RUN_LOCK_STALE_AFTER_MS` 以内である。
 * この順に確かめ、満たさない条件があれば、後の条件は確かめない。今の時刻と起動の時刻が 0 以上の安全な整数でないなら `RangeError`、
 * `isProcessRunning` が関数でないなら `TypeError` を投げる。
 */
export function judgeRunLock(lock: unknown, current: RunLockJudgementInput): RunLockState {
  requireTimeMs('current time', current.nowMs);
  requireTimeMs('current boot time', current.bootedAtMs);
  if (typeof current.isProcessRunning !== 'function') {
    throw new TypeError('run lock judgement requires a function that tells whether a process is running');
  }
  if (!isRunLock(lock)) {
    return 'STALE';
  }
  if (Math.abs(lock.bootedAtMs - current.bootedAtMs) > RUN_LOCK_BOOT_TIME_TOLERANCE_MS) {
    return 'STALE';
  }
  if (!current.isProcessRunning(lock.processId)) {
    return 'STALE';
  }
  return current.nowMs - lock.heartbeatAtMs > RUN_LOCK_STALE_AFTER_MS ? 'STALE' : 'ACTIVE';
}

/**
 * 読み直したロックの中身（ファイルから読んだ値）が、`lock`（自分が書いたロック）と同じ持ち主のものか（プロセスの ID とロックを取った時刻が
 * 同じ。設計書 4.4）。出力先の開始のロック（DEF-057。Task 24 の設計書 4.6）の、離す前の確かめなどに使う（CC-057。T24h-2 で 1 つにした。
 * LG-4: 保存のセッションの前の方式の取り直しは捨てた）。
 */
export function isOwnRunLock(value: unknown, lock: RunLock): boolean {
  return isRecord(value) && value.processId === lock.processId && value.acquiredAtMs === lock.acquiredAtMs;
}

/**
 * プロセスが動いているかを調べる（設計書 4.4 の `process.kill(pid, 0)`）。シグナル 0 は、送らずに、プロセスがあるかだけを確かめる。
 * 権限がなくて送れない（`EPERM`）場合は、プロセスはあるので、動いているとみなす。正の安全な整数でない ID（0 と負の値は、
 * プロセスのグループを表す）は、シグナルを送らずに、動いていないとみなす。
 */
export function isProcessRunning(processId: number): boolean {
  if (!isPositiveSafeInteger(processId)) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) === 'EPERM';
  }
}

/**
 * 古いロックの原子的な取り直し（`ArtifactWriter.takeOverRunLock`・`takeOverOutputStartLock`）の結果の閉じた一覧（DEF-060。独立レビュー
 * T24R の I1）。
 * - `ACQUIRED`: 判定した古いロックを一意の名前へ動かし（`rename`）、`wx` で新しいロックを作れた。
 * - `CHANGED`: ロックが、判定したものではなかった（ほかの起動が先に動かした、作り直した、ハートビートで書き換えた、なくなった）。動かして
 *   しまった他人のロックは、上書きせずに戻した。ロックを読み直して、判定し直す。
 * - `LOST`: 古いロックを動かした後の `wx` に負けた（ほかの起動が先に新しいロックを作った）。持てない。
 * `ArtifactWriter` の `LockTakeover` と同じ形である。orchestration は report を import しないので、ここにも置く。
 */
export const LOCK_TAKEOVER_OUTCOMES = Object.freeze(['ACQUIRED', 'CHANGED', 'LOST'] as const);
export type LockTakeoverOutcome = (typeof LOCK_TAKEOVER_OUTCOMES)[number];

/** 古いロックの原子的な取り直しの結果（`outcome` は `LOCK_TAKEOVER_OUTCOMES`）。 */
export interface RunLockTakeover {
  readonly outcome: LockTakeoverOutcome;
}

/**
 * 古いロックの取り直しを試みる最大の回数（DEF-060。最初の 1 回を含む）。取り直しが `CHANGED`（ほかの起動が先に動いた）になるたびに、ロックを
 * 読み直して判定し直す。ほかの起動が持てば、次の判定で `ACTIVE` になるので、数回で足りる。
 */
export const LOCK_TAKEOVER_MAX_ATTEMPTS = 3;

/** 1 つのロックのファイルの、作成（`wx`）と、古いロックの原子的な取り直しの口（`ArtifactWriter` の Run のロックか、出力先の開始のロック）。 */
export interface LockFilePort {
  /** ロックを排他的に作る（`wx`）。すでにあれば、その中身を返す。 */
  acquire(lock: RunLock): Promise<LockFileAcquisition>;
  /** 判定した古いロック（`judged`。読んだ中身）を、原子的に取り直す。 */
  takeOver(judged: unknown, lock: RunLock): Promise<RunLockTakeover>;
}

/**
 * すでにあるロックを判定して、古ければ取り直した結果の閉じた一覧（DEF-060）。
 * - `ACQUIRED`: 自分のロックを作れた（`wx`）。
 * - `HELD`: 動いている持ち主のロックがある（`judgeRunLock` が `ACTIVE`）。`existing` は、判定した中身。
 * - `CONTENDED`: ほかの起動が同時に取り直した（`wx` に負けた、または `LOCK_TAKEOVER_MAX_ATTEMPTS` 回の判定し直しの後も持てなかった）。
 */
export const LOCK_TAKEOVER_RESULT_KINDS = Object.freeze(['ACQUIRED', 'HELD', 'CONTENDED'] as const);
export type LockTakeoverResultKind = (typeof LOCK_TAKEOVER_RESULT_KINDS)[number];
export type LockTakeoverResult =
  | { readonly kind: Extract<LockTakeoverResultKind, 'ACQUIRED'> }
  | { readonly kind: Extract<LockTakeoverResultKind, 'HELD'>; readonly existing: unknown }
  | { readonly kind: Extract<LockTakeoverResultKind, 'CONTENDED'> };

const LOCK_TAKEOVER_ACQUIRED: LockTakeoverResult = Object.freeze({ kind: 'ACQUIRED' });
const LOCK_TAKEOVER_CONTENDED: LockTakeoverResult = Object.freeze({ kind: 'CONTENDED' });

/**
 * すでにあったロック（`existing`。`acquire` が返した中身）を判定し、古ければ原子的に取り直す（DEF-060。Run のロックの再開の始め方と、出力先の
 * 開始のロックで共用する。設計書 4.4、Task 24 の設計書 4.6）。
 * 1. `judgeRunLock(existing, judgement)` が `ACTIVE` なら `HELD`。
 * 2. `STALE` なら `port.takeOver(existing, lock)`。`ACQUIRED` なら `ACQUIRED`、`LOST` なら `CONTENDED`。
 * 3. `CHANGED` なら、`port.acquire(lock)` で作り直しを試み、作れたら `ACQUIRED`。すでにあれば、その中身で 1 から（最大
 *    `LOCK_TAKEOVER_MAX_ATTEMPTS` 回）。回数を使い切ったら `CONTENDED`。
 * 書き手の失敗は、そのまま reject する。
 */
export async function takeOverStaleLock(
  port: LockFilePort,
  existing: unknown,
  lock: RunLock,
  judgement: RunLockJudgementInput,
  grace?: RunLockGrace,
): Promise<LockTakeoverResult> {
  let current = existing;
  for (let attempt = 1; attempt <= LOCK_TAKEOVER_MAX_ATTEMPTS; attempt += 1) {
    // DEF-172: 猶予（`judgeRunLockWithGrace`）は、最初の判定だけ（判定し直しのたびに待たない）。
    const judged = await judgeRunLockWithGrace(current, judgement, attempt === 1 ? grace : undefined);
    current = judged.existing;
    if (judged.state === ACTIVE_RUN_LOCK_STATE) {
      return Object.freeze<LockTakeoverResult>({ kind: 'HELD', existing: current });
    }
    const takeover = await port.takeOver(current, lock);
    if (takeover.outcome === 'ACQUIRED') {
      return LOCK_TAKEOVER_ACQUIRED;
    }
    if (takeover.outcome === 'LOST') {
      return LOCK_TAKEOVER_CONTENDED;
    }
    const again = await port.acquire(lock);
    if (again.acquired) {
      return LOCK_TAKEOVER_ACQUIRED;
    }
    current = again.existing;
  }
  return LOCK_TAKEOVER_CONTENDED;
}

/** ロックを排他的に作り（`port.acquire`）、すでにあれば `takeOverStaleLock` で判定して、古ければ取り直す（DEF-060）。 */
export async function acquireLockTakingOverStale(
  port: LockFilePort,
  lock: RunLock,
  judgement: RunLockJudgementInput,
  grace?: RunLockGrace,
): Promise<LockTakeoverResult> {
  const acquisition = await port.acquire(lock);
  return acquisition.acquired ? LOCK_TAKEOVER_ACQUIRED : await takeOverStaleLock(port, acquisition.existing, lock, judgement, grace);
}

/** DEF-172: 動いている持ち主のロックが古く見えるときに、取り直す前に待つ時間の、ハートビートの間隔に足す分（ms）。 */
export const RUN_LOCK_TAKEOVER_GRACE_MARGIN_MS = 15_000;

/**
 * DEF-172: 動いている持ち主（process が動いている）のロックが古く見える（ハートビートが古い、起動の時刻がずれる）ときに、取り直す前に待つ時間
 * （ms。ハートビートの間隔より長い）。待った後に読み直し、ハートビートが進んでいれば（中身が変わっていれば）動いている Run のものとし、進んで
 * いなければ取り直す。持ち主が止まっていた（スリープ、時計の跳び、出力の止まった端末）間に、動いている Run を取り直さないため。
 */
export const RUN_LOCK_TAKEOVER_GRACE_MS = RUN_LOCK_HEARTBEAT_INTERVAL_MS + RUN_LOCK_TAKEOVER_GRACE_MARGIN_MS;

/** DEF-172: 取り直す前の猶予の口（読み直し、待ち、待つことの知らせ）。 */
export interface RunLockGrace {
  /** ロックを読み直す（ない、読めないなら `null`）。 */
  readonly reread: () => Promise<unknown>;
  /** `ms` だけ待つ（本番は `src/core/deadline.ts` の `wait`。テストは注入した待ち）。 */
  readonly wait: (ms: number) => Promise<void>;
  /** 待つ前に 1 回だけ知らせる（待つ時間 ms）。省略は知らせない。 */
  readonly onWait?: ((waitMs: number) => void) | undefined;
}

/** `judgeRunLockWithGrace` の結果（`existing` は、判定した中身。猶予の後に変わっていれば、読み直した中身）。 */
export interface RunLockGraceJudgement {
  readonly state: RunLockState;
  readonly existing: unknown;
}

/**
 * DEF-172: ロックを判定する（判定の部品はここだけ。保存のセッションの再開、出力先の開始のロック、出力先の動いている Run の確かめが使う）。
 * 1. `judgeRunLock` が `ACTIVE` なら `ACTIVE`。
 * 2. `STALE` で、形が正しくない、またはロックの process が動いていなければ、すぐに `STALE`（今までと同じ）。
 * 3. process が動いているのに古く見えるときは、`grace` があれば `RUN_LOCK_TAKEOVER_GRACE_MS` だけ待って読み直す（`grace` がなければ `STALE`）。
 *    中身が同じか、なくなっていれば `STALE`（判定した中身は前のもの）。変わっていれば（ハートビートが進んだ、ほかの起動が作った）`ACTIVE`
 *    （判定した中身は読み直したもの）。
 */
export async function judgeRunLockWithGrace(
  existing: unknown,
  judgement: RunLockJudgementInput,
  grace: RunLockGrace | undefined,
): Promise<RunLockGraceJudgement> {
  const [judged] = await judgeRunLocksWithGrace(
    [{ existing, reread: grace?.reread ?? (async () => existing) }],
    judgement,
    grace,
  );
  return judged ?? Object.freeze({ state: judgeRunLock(existing, judgement), existing });
}

/** `judgeRunLocksWithGrace` の 1 つのロック（判定した中身と、その読み直し）。 */
export interface RunLockGraceCandidate {
  readonly existing: unknown;
  readonly reread: () => Promise<unknown>;
}

/**
 * DEF-172・SR-1-F5（SR-1R3 の I1）: いくつものロックを、`judgeRunLockWithGrace` と同じ規則でまとめて判定する（判定の部品は、ここの 1 つ）。
 * 猶予の要るロック（process が動いているのに古く見える）がいくつあっても、待つのは全部まとめて 1 回だけ（1 回の判定で最大
 * `RUN_LOCK_TAKEOVER_GRACE_MS`）。待った後に、猶予の要るロックだけを読み直す。結果は、`candidates` と同じ順。`grace` の `reread` は使わない
 * （それぞれの `reread` を使う。待ちと知らせだけを使う）。
 */
export async function judgeRunLocksWithGrace(
  candidates: readonly RunLockGraceCandidate[],
  judgement: RunLockJudgementInput,
  grace: Pick<RunLockGrace, 'wait' | 'onWait'> | undefined,
): Promise<readonly RunLockGraceJudgement[]> {
  const first = candidates.map(({ existing }) => Object.freeze({ state: judgeRunLock(existing, judgement), existing }));
  const needsGrace = (index: number): boolean => {
    const existing = candidates[index]?.existing;
    return grace !== undefined
      && first[index]?.state !== ACTIVE_RUN_LOCK_STATE
      && isRunLock(existing)
      && judgement.isProcessRunning(existing.processId);
  };
  const graced = first.map((_judged, index) => index).filter(needsGrace);
  if (grace === undefined || graced.length === 0) {
    return Object.freeze(first);
  }
  grace.onWait?.(RUN_LOCK_TAKEOVER_GRACE_MS);
  await grace.wait(RUN_LOCK_TAKEOVER_GRACE_MS);
  const results: RunLockGraceJudgement[] = [...first];
  for (const index of graced) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    const again = await candidate.reread();
    results[index] = again === null || isDeepStrictEqual(again, candidate.existing)
      ? Object.freeze({ state: 'STALE' as const, existing: candidate.existing })
      : Object.freeze({ state: ACTIVE_RUN_LOCK_STATE, existing: again });
  }
  return Object.freeze(results);
}
