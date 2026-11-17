/**
 * process のロックの共通の部品（意味の owner）。
 * - 画面のサーバの管理のロック（`src/control/job/instance-lock.ts`）が使う、今の process の値（`currentProcessRunLockHost`）と OS の起動の
 *   時刻の誤差の上限、process が動いているかの判定（`isProcessRunning`）。
 * - 監査中の印（出力先ごとの排他）は `src/core/run-exclusion.ts`（OS が持ち主の終わりと同時に放す排他。古さを推し量らない）。
 */
import { uptime } from 'node:os';
import { errorCodeOf } from './errors.js';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from './guards.js';
import { MILLISECONDS_PER_SECOND } from './time-units.js';

/**
 * ロックを「動いている持ち主のもの」とみなす、OS の起動の時刻の誤差の上限（ms。120秒）。端末を再起動した後は、起動の時刻がこれより大きく
 * 違うので、プロセスの ID が別のプロセスに使い回されていても、古いロックと分かる（画面のサーバの管理のロックが使う）。
 */
export const RUN_LOCK_BOOT_TIME_TOLERANCE_MS = 120_000;

/** 今のプロセスの値（画面のサーバの管理のロックを作るときと、判定するときに使う）。 */
export interface RunLockHost {
  readonly processId: number;
  /** 今の時刻（エポックからの ms）。 */
  readonly nowMs: number;
  /** 今の OS の起動の時刻（エポックからの ms）。 */
  readonly bootedAtMs: number;
}

/**
 * 今のプロセスの値を読む。`nowMs` は `Date.now()` と同じ基準の今の時刻（0 以上の安全な整数でなければ `RangeError`）。OS の起動の時刻は
 * `nowMs - os.uptime() * 1000` を ms に丸めたもの（誤差は `RUN_LOCK_BOOT_TIME_TOLERANCE_MS` の中で許す）。
 */
export function currentProcessRunLockHost(nowMs: number): RunLockHost {
  if (!isNonNegativeSafeInteger(nowMs)) {
    throw new RangeError('run lock current time must be a non-negative safe integer of milliseconds');
  }
  return Object.freeze({
    processId: process.pid,
    nowMs,
    bootedAtMs: Math.max(0, Math.round(nowMs - uptime() * MILLISECONDS_PER_SECOND)),
  });
}

/**
 * プロセスが動いているかを調べる（`process.kill(pid, 0)`）。シグナル 0 は、送らずに、プロセスがあるかだけを確かめる。
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
