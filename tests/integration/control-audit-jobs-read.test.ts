// 監査のジョブの読み取り（`readJob`、`readAllJobs`）が、読むだけの入口（`withReadTransaction`）を通ることの結合テスト（T24e round 2）。
// - 別の接続が書き込みのロック（`BEGIN IMMEDIATE`）を持っている間も、待たずに読める（書き込みの入口なら busy の待ちになる）。
// - 読んだ後に、接続は `query_only` のままにならず、書き込みの入口で書ける。
// 一時のフォルダだけを使う。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createStartingJob, readAllJobs, readJob, recordHeartbeat } from '../../src/control/job/job-store.js';
import { CONTROL_DB_BUSY_TIMEOUT_MS, closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const PROFILE_ID = 'example-read-job';
const JOB_ID = 'job-read-1';
const CREATED_AT = '20261009000000';
const HEARTBEAT_AT = '20261009000001';
/** 書き込みのロックがある間の読み取りが、待たずに終わったとみなす上限（ms。busy の待ちの上限より十分に短い）。 */
const UNBLOCKED_READ_LIMIT_MS = CONTROL_DB_BUSY_TIMEOUT_MS / 5;

let workDirectory = '';
let database: ControlDatabase;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-audit-jobs-read-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(createStartingJob(database, {
    // T26c: ジョブの種類は必ず明示する（既定の値はない）。
    jobId: JOB_ID, jobKind: 'AUDIT', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: false, createdAt: CREATED_AT,
  }, () => null)).toEqual({ ok: true });
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('audit job reads through withReadTransaction (T24e round 2)', () => {
  it('reads without waiting while another connection holds the write lock', () => {
    const writer = new DatabaseSync(resolveControlDatabasePath(workDirectory), { timeout: 0 });
    try {
      writer.exec('BEGIN IMMEDIATE');
      const startedAt = performance.now();
      expect(readJob(database, JOB_ID)?.state).toBe('STARTING');
      expect(readAllJobs(database).map(({ jobId }) => jobId)).toEqual([JOB_ID]);
      expect(performance.now() - startedAt).toBeLessThan(UNBLOCKED_READ_LIMIT_MS);
      writer.exec('ROLLBACK');
    } finally {
      writer.close();
    }
  });

  it('leaves the connection writable after reading', () => {
    expect(readJob(database, 'missing-job')).toBeNull();
    expect(readAllJobs(database)).toHaveLength(1);
    // 読んだ後の書き込み（UPDATE）が通り、読み直すと書いた値がある。
    expect(recordHeartbeat(database, JOB_ID, HEARTBEAT_AT)).toBe(true);
    expect(readJob(database, JOB_ID)?.lastHeartbeatAt).toBe(HEARTBEAT_AT);
  });
});
