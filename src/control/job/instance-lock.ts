// 管理のロック（画面のサーバを 1 つだけにする。独立レビュー T24R の C1、DEF-061。T24h-4）の行の読み書きの唯一の owner。
// - 管理データの版 2 の `control_instance` の表の 1 行（`CONTROL_INSTANCE_SLOT`）。中身は Run のロックと同じ項目（`src/core/process-lock.ts` の
//   `RunLock`。持ち主の PID、OS の起動の時刻、取った時刻、ハートビートの時刻）と、分かれば持ち主の port。
// - 取る・取り直す: 1 つの `withWriteTransaction`（`BEGIN IMMEDIATE`）の中で、行を読み、`judgeRunLock` で判定し、動いている持ち主のもの
//   （`ACTIVE`）なら取らずに持ち主を返す。なければ、または古ければ（`STALE`）、自分のロックに置き換える（トランザクションなので、2 つの管理が
//   同時に取り直しても、片方だけが取る）。
// - ハートビート・離す: 自分の行（PID と取った時刻が同じ）だけを書き換える・消す。自分の行でなければ（ほかの管理が取り直した）何もせず、
//   偽を返す。
// - 判定の部品（`judgeRunLock`、`createRunLock`、`isProcessRunning`、`currentProcessRunLockHost`）は `src/core/process-lock.ts` のものを使い、
//   同じ意味の判定をここに書かない。ファイルは書かない（GATE-ARCH08）。
import {
  createRunLock,
  judgeRunLock,
  type RunLock,
  type RunLockHost,
} from '../../core/process-lock.js';
import { isNonNegativeSafeInteger, isPositiveSafeInteger } from '../../core/guards.js';
import { deepFreeze } from '../../core/immutable.js';
import type { ControlDatabase } from '../store/control-database.js';
import type { SqliteConnection } from '../store/sqlite-module.js';
import { ControlStoreError } from '../store/store-errors.js';
import { withReadTransaction, withWriteTransaction } from '../store/transaction.js';
import { CONTROL_INSTANCE_SLOT, MAX_CONTROL_INSTANCE_PORT, MIN_CONTROL_INSTANCE_PORT } from './job-records.js';

/** 管理を作れなかった理由の値（ほかの管理が、動いている持ち主のロックを持つ）。 */
export const CONTROL_INSTANCE_ALREADY_RUNNING = 'CONTROL_INSTANCE_ALREADY_RUNNING';

/** 管理のロックの持ち主（表示に使う）。 */
export interface ControlInstanceHolder {
  readonly processId: number;
  /** 持ち主の画面のサーバの port（分からなければ `null`）。 */
  readonly port: number | null;
}

/** ほかの管理が、動いている持ち主のロックを持つので、管理を作れなかった（何も書き換えていない）。 */
export class ControlInstanceLockedError extends Error {
  override readonly name = 'ControlInstanceLockedError';
  readonly reason = CONTROL_INSTANCE_ALREADY_RUNNING;
  readonly holderProcessId: number;
  readonly holderPort: number | null;

  constructor(holder: ControlInstanceHolder) {
    super(`${CONTROL_INSTANCE_ALREADY_RUNNING}: another audit job manager (process ${holder.processId}) holds the control instance lock`);
    this.holderProcessId = holder.processId;
    this.holderPort = holder.port;
  }
}

/** ロックを取った結果。 */
export type ControlInstanceAcquisition =
  | { readonly acquired: true; readonly lock: RunLock; /** 古いロックを取り直した。 */ readonly tookOver: boolean }
  | { readonly acquired: false; readonly holder: ControlInstanceHolder };

/** ロックを取るときに受け取るもの。 */
export interface ControlInstanceAcquireRequest {
  /** 今の process の値（`currentProcessRunLockHost`）。 */
  readonly host: RunLockHost;
  /** この画面のサーバの port（分からなければ `null`）。 */
  readonly port: number | null;
  /** process が動いているか（本番は `isProcessRunning`）。 */
  readonly isProcessRunning: (processId: number) => boolean;
}

/** `control_instance` の 1 行。 */
interface InstanceRow {
  readonly process_id: number;
  readonly booted_at_ms: number;
  readonly acquired_at_ms: number;
  readonly heartbeat_at_ms: number;
  readonly port: number | null;
}

const SELECT_INSTANCE_SQL = 'SELECT process_id, booted_at_ms, acquired_at_ms, heartbeat_at_ms, port FROM control_instance WHERE slot = ?';
const REPLACE_INSTANCE_SQL =
  'INSERT OR REPLACE INTO control_instance (slot, process_id, booted_at_ms, acquired_at_ms, heartbeat_at_ms, port) VALUES (?, ?, ?, ?, ?, ?)';
const RENEW_INSTANCE_SQL = 'UPDATE control_instance SET heartbeat_at_ms = ? WHERE slot = ? AND process_id = ? AND acquired_at_ms = ?';
const DELETE_INSTANCE_SQL = 'DELETE FROM control_instance WHERE slot = ? AND process_id = ? AND acquired_at_ms = ?';
/** 1 回の変更で書き換える行の数。 */
const ONE_ROW = 1;

const readRow = (connection: SqliteConnection): InstanceRow | undefined =>
  connection.prepare(SELECT_INSTANCE_SQL).get(CONTROL_INSTANCE_SLOT) as InstanceRow | undefined;

/** 行を、判定に渡すロックの中身にする（形は `judgeRunLock` が確かめる）。 */
const lockOfRow = (row: InstanceRow): RunLock => ({
  processId: row.process_id,
  bootedAtMs: row.booted_at_ms,
  acquiredAtMs: row.acquired_at_ms,
  heartbeatAtMs: row.heartbeat_at_ms,
});

const isRecordablePort = (port: number | null): boolean =>
  port === null || (Number.isSafeInteger(port) && port >= MIN_CONTROL_INSTANCE_PORT && port <= MAX_CONTROL_INSTANCE_PORT);

/**
 * 管理のロックを取る（古ければ取り直す）。動いている持ち主のロックがあれば、取らずに持ち主を返す（何も書き換えない）。
 * `port` が範囲の外なら `RangeError`。
 */
export const acquireControlInstanceLock = (database: ControlDatabase, request: ControlInstanceAcquireRequest): ControlInstanceAcquisition => {
  if (!isRecordablePort(request.port)) {
    throw new RangeError('the port of the control instance lock must be a TCP port number or null');
  }
  return withWriteTransaction(database, (connection): ControlInstanceAcquisition => {
    const row = readRow(connection);
    if (row !== undefined) {
      const state = judgeRunLock(lockOfRow(row), {
        nowMs: request.host.nowMs,
        bootedAtMs: request.host.bootedAtMs,
        isProcessRunning: request.isProcessRunning,
      });
      if (state === 'ACTIVE') {
        return deepFreeze({ acquired: false, holder: { processId: row.process_id, port: row.port } });
      }
    }
    const lock = createRunLock(request.host);
    connection.prepare(REPLACE_INSTANCE_SQL)
      .run(CONTROL_INSTANCE_SLOT, lock.processId, lock.bootedAtMs, lock.acquiredAtMs, lock.heartbeatAtMs, request.port);
    return deepFreeze({ acquired: true, lock, tookOver: row !== undefined });
  });
};

/**
 * 開いているトランザクションの接続（`withWriteTransaction` の関数が受けたもの）で、自分のロックをまだ持っているかを読む（読むだけ）。
 * ジョブを作る・中断に直すトランザクションの中で、管理のロックを確かめ直すために使う（T24h-4）。
 */
export const holdsControlInstanceLock = (connection: SqliteConnection, lock: RunLock): boolean => {
  const row = readRow(connection);
  return row !== undefined && row.process_id === lock.processId && row.acquired_at_ms === lock.acquiredAtMs;
};

/** 自分のロックのハートビートの時刻を `nowMs` にする。自分の行でなければ（失った）何もせず偽。 */
export const renewControlInstanceLock = (database: ControlDatabase, lock: RunLock, nowMs: number): boolean => {
  if (!isNonNegativeSafeInteger(nowMs)) {
    throw new RangeError('the heartbeat time of the control instance lock must be a non-negative safe integer');
  }
  return withWriteTransaction(database, (connection) =>
    Number(connection.prepare(RENEW_INSTANCE_SQL).run(nowMs, CONTROL_INSTANCE_SLOT, lock.processId, lock.acquiredAtMs).changes) === ONE_ROW);
};

/** 自分のロックを消す。自分の行でなければ（ほかの管理のもの）消さずに偽。 */
export const releaseControlInstanceLock = (database: ControlDatabase, lock: RunLock): boolean =>
  withWriteTransaction(database, (connection) =>
    Number(connection.prepare(DELETE_INSTANCE_SQL).run(CONTROL_INSTANCE_SLOT, lock.processId, lock.acquiredAtMs).changes) === ONE_ROW);

/** 今の管理のロック（なければ `null`。診断とテスト用。読むだけ）。行の値が壊れていれば `ControlStoreError`。 */
export const readControlInstanceLock = (database: ControlDatabase): (RunLock & { readonly port: number | null }) | null =>
  withReadTransaction(database, (connection) => {
    const row = readRow(connection);
    if (row === undefined) {
      return null;
    }
    const lock = lockOfRow(row);
    if (!isPositiveSafeInteger(lock.processId) || !isRecordablePort(row.port)) {
      throw new ControlStoreError('DATABASE_INTEGRITY_FAILED', 'the control instance lock row is broken');
    }
    return deepFreeze({ ...lock, port: row.port });
  });
