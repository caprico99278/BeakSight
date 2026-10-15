// 監査のジョブの、複数の process の結合テスト（Task 24 の設計書 4.4 の「同時に 1 つ」、7 章「ジョブ」。T24e。T24h-4 で改めた）。
// - T24h-4（DEF-061）で、ジョブの管理は管理のロックで全体で 1 つだけになった（2 つ目の管理は作れない。`control-instance-lock.test.ts`）。
//   そのため、このテストは、ジョブの管理を作らずに、2 つの子 process からジョブの行の部品（`createStartingJob`）で同じ管理データへ、ほぼ同時に
//   行を作り、片方だけが作れることを確かめる（管理のロックの下の、表の守り。名前つきの回数くり返す）。
// - 2 つの子 process でジョブの管理を作ろうとすると、1 つだけが作れる（`control-instance-lock.test.ts` の (d)）。
// 一時のフォルダだけを使い、終わったら消す。起動した子 process は、すべて止める。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { ACTIVE_AUDIT_JOB_STATES } from '../../src/control/job/job-records.js';
import { readAllJobs } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { JOB_CHILD_PROTOCOL, startJobChild, type JobChild } from './control-audit-jobs-fixtures.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

/** 同時の作成をくり返す回数。 */
const CONCURRENT_START_ROUNDS = 3;
const PROFILE_ID = 'example-shared-job';
const PROCESS_TEST_TIMEOUT_MS = 180_000;
/** 1 回ごとに、作れたジョブを終わりにする時刻（次の回で、また 1 つだけ作れるように）。 */
const FINISHED_AT = '20261009000100';

let workDirectory = '';
let databasePath = '';
const children: JobChild[] = [];

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-audit-jobs-processes-'));
  databasePath = resolveControlDatabasePath(workDirectory);
  const database = openControlDatabase(databasePath);
  try {
    expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => child.kill()));
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('audit job rows from two processes (Task 24 design 4.4)', () => {
  it('creates only one of two job rows created at almost the same time from two processes in the same database', async () => {
    for (let round = 0; round < CONCURRENT_START_ROUNDS; round += 1) {
      const pair = await Promise.all([0, 1].map(async () => startJobChild({
        databasePath,
        repositoryRoot: workDirectory,
        workerPath: join(workDirectory, 'no-worker.mjs'),
        contextKind: JOB_CHILD_PROTOCOL.storeOnly,
      })));
      children.push(...pair);
      const results = await Promise.all(pair.map(async (child) => child.start(PROFILE_ID, MIN_PROFILE_REVISION)));

      expect(results.filter(({ ok }) => ok), `round ${String(round)}`).toHaveLength(1);
      expect(results.filter(({ ok }) => !ok).map(({ reason }) => reason), `round ${String(round)}`).toEqual(['JOB_ALREADY_ACTIVE']);
      await Promise.all(pair.map(async (child) => child.close()));

      const database = openControlDatabase(databasePath);
      try {
        const jobs = readAllJobs(database);
        expect(jobs).toHaveLength(round + 1);
        expect(jobs.filter(({ state }) => (ACTIVE_AUDIT_JOB_STATES as readonly string[]).includes(state))).toHaveLength(1);
      } finally {
        closeControlDatabase(database);
      }
      // 次の回のために、作れたジョブを終わりにする（生の接続で。ワーカーはない）。
      const raw = new DatabaseSync(databasePath);
      try {
        raw.prepare("UPDATE jobs SET state = 'INTERRUPTED', failure_reason = 'WORKER_EXITED', finished_at = ? WHERE state = 'STARTING'").run(FINISHED_AT);
      } finally {
        raw.close();
      }
    }
  }, PROCESS_TEST_TIMEOUT_MS);
});
