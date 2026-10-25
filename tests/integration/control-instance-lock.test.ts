// 管理のロック（画面のサーバを 1 つだけにする。独立レビュー T24R の C1、DEF-061。T24h-4）の結合テスト。
// - (a) レビュー担当の再現（scratch の `t24r/e1` の `driver.mjs`・`driver2.mjs`）と同じ流れを、2 つの子 process（それぞれ画面のサーバの代わりに
//   ジョブの管理を作る）で行う: 2 つ目は管理を作れず、1 つ目のジョブの行は変わらず、2 つの監査は同時に動かない。
// - (c) 古いロック（死んだ PID、ハートビートが古い）は取り直し、終わっていないジョブを中断に直す。
// - (d) 2 つの管理をほぼ同時に作ると、1 つだけが作れる（名前つきの回数）。
// - (e) `close()` の後に、もう一度作れる。他人のロックを消さない。ロックを失ったら、新しいジョブを始めない。
// - (f) SR-1-F（DEF-168 と同じ形）: ほかの管理がロックを書き換えている途中に別の管理を作っても、書き換えた管理だけが持つ。
// 一時のフォルダだけを使い、終わったら消す。起動した子 process と偽のワーカーは、すべて止める。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditJobTiming } from '../../src/control/job/audit-job-manager.js';
import {
  CONTROL_INSTANCE_ALREADY_RUNNING,
  ControlInstanceLockedError,
  readControlInstanceLock,
  releaseControlInstanceLock,
} from '../../src/control/job/instance-lock.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { RUN_LOCK_STALE_AFTER_MS, currentProcessRunLockHost, isProcessRunning } from '../../src/core/process-lock.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerValues } from '../helpers/fake-audit-worker.js';
import { fakeWorkerValuesOf } from '../helpers/job-test-support.js';
import { INSTANCE_CHILD_PROTOCOL, startInstanceChild, type InstanceChild } from './control-instance-fixtures.js';
import { PUBLIC_TARGET_PATH, SECOND_PUBLIC_TARGET_PATH, publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const PROFILE_ONE = 'p-one';
const PROFILE_TWO = 'p-two';
/** 管理をほぼ同時に作るのをくり返す回数。 */
const CONCURRENT_CREATION_ROUNDS = 3;
/** 1 つ目の管理の port（ロックの持ち主の表示に使う）。 */
const FIRST_SERVER_PORT = 4401;
const TEST_TIMEOUT_MS = 180_000;
/** 状態を待つ上限と、読み直す間隔（ms）。 */
const WAIT_LIMIT_MS = 30_000;
const WAIT_POLL_MS = 100;
/** テストのハートビートの間隔（ms。本番の名前つきの間隔の代わり）。 */
const TEST_INSTANCE_HEARTBEAT_INTERVAL_MS = 100;
/** ほかの管理がロックを書き換えている途中のまま待つ時間（ms。管理データの待ちの上限 `CONTROL_DB_BUSY_TIMEOUT_MS` の 5 秒より短い）。 */
const LOCK_WRITE_HOLD_MS = 3_000;

/** 偽のワーカーに埋め込む値。 */
const fakeWorkerValues = (): FakeWorkerValues => fakeWorkerValuesOf(
  { runId: 'RUN-20261009000000', otherRunId: 'RUN-20261009000999' },
  { heartbeatIntervalMs: TEST_INSTANCE_HEARTBEAT_INTERVAL_MS },
);

let workDirectory = '';
let databasePath = '';
let worker: FakeWorker;
const children: InstanceChild[] = [];
let inProcess: { manager: AuditJobManager | undefined; database: ControlDatabase | undefined } = { manager: undefined, database: undefined };

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-instance-lock-'));
  mkdirSync(join(workDirectory, 'config', 'targets'), { recursive: true });
  writeFileSync(join(workDirectory, PUBLIC_TARGET_PATH), JSON.stringify({ target: { id: 'example' } }), 'utf8');
  writeFileSync(join(workDirectory, SECOND_PUBLIC_TARGET_PATH), JSON.stringify({ target: { id: 'example-second' } }), 'utf8');
  databasePath = resolveControlDatabasePath(workDirectory);
  const database = openControlDatabase(databasePath);
  try {
    expect(createProfile(database, publicProfile(PROFILE_ONE, MIN_PROFILE_REVISION, PUBLIC_TARGET_PATH), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(createProfile(database, publicProfile(PROFILE_TWO, MIN_PROFILE_REVISION, SECOND_PUBLIC_TARGET_PATH), { resolveContext: resolveTestContext }).ok).toBe(true);
  } finally {
    closeControlDatabase(database);
  }
  worker = writeFakeWorker(workDirectory, 'hold', fakeWorkerValues());
});

afterEach(async () => {
  await inProcess.manager?.close();
  if (inProcess.database !== undefined) {
    closeControlDatabase(inProcess.database);
  }
  inProcess = { manager: undefined, database: undefined };
  await Promise.all(children.splice(0).map(async (child) => child.kill()));
  rmSync(workDirectory, { recursive: true, force: true });
});

const startChild = async (port?: number): Promise<InstanceChild> => {
  const child = await startInstanceChild({ databasePath, repositoryRoot: workDirectory, workerPath: worker.path, ...(port === undefined ? {} : { port }) });
  children.push(child);
  return child;
};

const request = async (child: InstanceChild, line: string): Promise<string> => {
  child.send(line);
  return child.nextLine();
};

const jobsOf = async (child: InstanceChild): Promise<readonly (readonly [string, string, string | null])[]> => {
  const line = await request(child, INSTANCE_CHILD_PROTOCOL.list);
  return JSON.parse(line.slice(INSTANCE_CHILD_PROTOCOL.jobs.length + 1)) as (readonly [string, string, string | null])[];
};

const waitForJobs = async (
  child: InstanceChild,
  predicate: (jobs: readonly (readonly [string, string, string | null])[]) => boolean,
): Promise<readonly (readonly [string, string, string | null])[]> => {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const jobs = await jobsOf(child);
    if (predicate(jobs) || Date.now() > deadline) {
      return jobs;
    }
    await wait(WAIT_POLL_MS);
  }
};

const closeChild = async (child: InstanceChild): Promise<void> => {
  expect(await request(child, INSTANCE_CHILD_PROTOCOL.exit)).toBe(INSTANCE_CHILD_PROTOCOL.closed);
  await child.exited;
};

/** 偽のワーカーが受けた `START` の数（同時に動いた監査の数の上限）。 */
const startsReceived = (): number => worker.received().filter(({ type }) => type === 'START').length;

/** 終わった process の ID（死んだ PID）。 */
const deadProcessId = (): number => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  const processId = Number(result.stdout);
  expect(isProcessRunning(processId)).toBe(false);
  return processId;
};

/** 管理のロックの行と、終わっていないジョブの行を、生の接続で書く（前のサーバが残したものを模す）。 */
const writeLeftovers = (lock: { readonly processId: number; readonly heartbeatAtMs: number }): void => {
  const host = currentProcessRunLockHost(Date.now());
  const raw = new DatabaseSync(databasePath);
  try {
    raw.prepare('INSERT INTO control_instance (slot, process_id, booted_at_ms, acquired_at_ms, heartbeat_at_ms, port) VALUES (1, ?, ?, ?, ?, NULL)')
      .run(lock.processId, host.bootedAtMs, lock.heartbeatAtMs, lock.heartbeatAtMs);
    // T26c: 版 4 のジョブの表は、種類（`job_kind`）を必ず書く。
    raw.prepare("INSERT INTO jobs (job_id, profile_id, profile_revision, state, start_new, created_at, job_kind) VALUES ('left-job', ?, ?, 'RUNNING', 0, '20261009000000', 'AUDIT')")
      .run(PROFILE_ONE, MIN_PROFILE_REVISION);
  } finally {
    raw.close();
  }
};

const openInProcess = (): ControlDatabase => {
  inProcess.database ??= openControlDatabase(databasePath);
  return inProcess.database;
};

const createInProcess = (options: {
  readonly heartbeatIntervalMs?: number;
  readonly workerPath?: string;
  readonly timing?: Partial<AuditJobTiming>;
} = {}): AuditJobManager => {
  inProcess.manager = createAuditJobManager({
    database: openInProcess(),
    repositoryRoot: workDirectory,
    workerPath: options.workerPath ?? worker.path,
    resolveContext: resolveTestContext,
    timing: {
      ...options.timing,
      ...(options.heartbeatIntervalMs === undefined ? {} : { instanceHeartbeatIntervalMs: options.heartbeatIntervalMs }),
    },
  });
  return inProcess.manager;
};

/** ジョブの行の、ワーカーの process の ID（生の接続で読む）。 */
const workerPidOf = (profileId: string): number => {
  const raw = new DatabaseSync(databasePath);
  try {
    const row = raw.prepare('SELECT worker_pid FROM jobs WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1').get(profileId) as
      { worker_pid: number | null } | undefined;
    return row?.worker_pid ?? 0;
  } finally {
    raw.close();
  }
};

/** 管理のロックのハートビートを、古いと判定される時刻に書き換える（レビュー担当 T24R2 の `stall` の場面。1 つ目の管理が止まって見える）。 */
const stallInstanceLock = (): void => {
  const raw = new DatabaseSync(databasePath);
  try {
    raw.prepare('UPDATE control_instance SET heartbeat_at_ms = ?').run(Date.now() - RUN_LOCK_STALE_AFTER_MS - WAIT_LIMIT_MS);
  } finally {
    raw.close();
  }
};

/** `predicate` が真になるまで待つ（上限の後は、そのときの値を返す）。 */
const waitUntil = async (predicate: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!predicate() && Date.now() < deadline) {
    await wait(WAIT_POLL_MS);
  }
  return predicate();
};

// T24h-6（再レビュー T24R2 の m1）: ハートビートが古く見えて（`stall`）、2 つ目の管理が管理のロックを取り直しても、1 つ目のワーカーが生きている間は、
// 2 つ目は 1 つ目のジョブを中断に直さず、新しいジョブを始めない。ロックを失った 1 つ目は、自分のワーカーを止める。2 つのワーカーは同時に生きない。
describe('the control instance lock: a stalled holder (T24R2 m1)', () => {
  it('never runs two workers at the same time when a second manager takes over the lock of a stalled first one', async () => {
    const first = await startChild();
    expect(await request(first, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_ONE} ${MIN_PROFILE_REVISION}`)).toMatch(/^RESULT OK /u);
    await waitForJobs(first, (jobs) => jobs[0]?.[1] === 'RUNNING');
    const firstWorker = workerPidOf(PROFILE_ONE);
    expect(isProcessRunning(firstWorker)).toBe(true);

    stallInstanceLock();
    const second = await startChild();
    const secondStart = await request(second, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_TWO} ${MIN_PROFILE_REVISION}`);
    const twoWorkersAlive = secondStart.startsWith('RESULT OK ') && isProcessRunning(firstWorker);
    expect(twoWorkersAlive, `two workers alive at the same time (${secondStart}, ${second.first})`).toBe(false);
    // 2 つ目は、生きているワーカーのジョブを中断に直さず、開始を拒む。
    expect(second.first).toBe(`${INSTANCE_CHILD_PROTOCOL.ready} 0`);
    expect(secondStart).toBe('RESULT JOB_ALREADY_ACTIVE -');
    expect((await jobsOf(second))[0]).toEqual([PROFILE_ONE, 'RUNNING', null]);

    // 1 つ目は、ロックを失ったと分かると（ここでは開始の確かめで）、自分のワーカーを止める。
    expect(await request(first, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_TWO} ${MIN_PROFILE_REVISION}`)).toBe('RESULT CONTROL_INSTANCE_LOCK_LOST -');
    expect(await waitUntil(() => !isProcessRunning(firstWorker)), 'the first worker still runs').toBe(true);
    expect((await waitForJobs(second, (jobs) => jobs[0]?.[1] !== 'RUNNING'))[0]?.[1]).not.toBe('RUNNING');

    // 1 つ目のワーカーが終わった後は、2 つ目が始められる。
    expect(await request(second, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_TWO} ${MIN_PROFILE_REVISION}`)).toMatch(/^RESULT OK /u);
    expect(isProcessRunning(firstWorker)).toBe(false);
    await closeChild(second);
    await closeChild(first);
  }, TEST_TIMEOUT_MS);

  it('stops its own worker when the heartbeat finds that the lock was taken over', async () => {
    const manager = createInProcess({ heartbeatIntervalMs: TEST_INSTANCE_HEARTBEAT_INTERVAL_MS });
    const started = await manager.startAuditJob({ profileId: PROFILE_ONE, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    expect(started.ok).toBe(true);
    const jobId = started.ok ? started.job.jobId : '';
    expect(await waitUntil(() => manager.getAuditJob(jobId)?.state === 'RUNNING')).toBe(true);

    takeOverByAnotherManager();
    expect(await waitUntil(() => manager.getAuditJob(jobId)?.finishedAt !== null), 'the job did not end').toBe(true);
    expect(manager.getAuditJob(jobId)).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL' });
    expect(worker.received().map(({ type }) => type)).toContain('STOP');
    expect(manager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('kills its own worker that does not end within the named time after losing the lock', async () => {
    const ignoring = writeFakeWorker(workDirectory, 'ignore-stop', fakeWorkerValues());
    const manager = createInProcess({
      heartbeatIntervalMs: TEST_INSTANCE_HEARTBEAT_INTERVAL_MS,
      workerPath: ignoring.path,
      timing: { lockLostKillAfterMs: TEST_INSTANCE_HEARTBEAT_INTERVAL_MS * 5 },
    });
    const started = await manager.startAuditJob({ profileId: PROFILE_ONE, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    const jobId = started.ok ? started.job.jobId : '';
    expect(await waitUntil(() => manager.getAuditJob(jobId)?.state === 'RUNNING')).toBe(true);

    takeOverByAnotherManager();
    expect(await waitUntil(() => manager.getAuditJob(jobId)?.finishedAt !== null), 'the job did not end').toBe(true);
    expect(manager.getAuditJob(jobId)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'STOP_TIMEOUT' });
    expect(manager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);
});

/** ほかの管理が、古いと判定して管理のロックを取り直した（模す。死んだ PID の、新しいロック）。 */
function takeOverByAnotherManager(): void {
  const raw = new DatabaseSync(databasePath);
  try {
    raw.prepare('UPDATE control_instance SET process_id = ?, acquired_at_ms = acquired_at_ms + 1').run(deadProcessId());
  } finally {
    raw.close();
  }
}

describe('the control instance lock: the flows of the review T24R (t24r/e1)', () => {
  it('flow 1 (driver.mjs): the second manager is not created, the job of the first is unchanged, and no second audit runs', async () => {
    const first = await startChild();
    expect(first.first).toBe(`${INSTANCE_CHILD_PROTOCOL.ready} 0`);
    expect(await request(first, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_ONE} ${MIN_PROFILE_REVISION}`)).toMatch(/^RESULT OK /u);
    expect(await waitForJobs(first, (jobs) => jobs[0]?.[1] === 'RUNNING')).toEqual([[PROFILE_ONE, 'RUNNING', null]]);

    const second = await startChild();
    expect(second.first).toBe(`${INSTANCE_CHILD_PROTOCOL.locked} ${String(first.process.pid)} -`);
    expect(await second.exited).toBe(0);

    expect(await jobsOf(first)).toEqual([[PROFILE_ONE, 'RUNNING', null]]);
    expect(await request(first, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_TWO} ${MIN_PROFILE_REVISION}`)).toBe('RESULT JOB_ALREADY_ACTIVE -');
    expect(startsReceived()).toBe(1);
    await closeChild(first);
  }, TEST_TIMEOUT_MS);

  it('flow 2 (driver2.mjs): the second manager that exits at once does not interrupt the job, and the first cannot start a second audit', async () => {
    const first = await startChild();
    expect(await request(first, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_ONE} ${MIN_PROFILE_REVISION}`)).toMatch(/^RESULT OK /u);
    await waitForJobs(first, (jobs) => jobs[0]?.[1] === 'RUNNING');

    const second = await startChild();
    expect(second.first.startsWith(`${INSTANCE_CHILD_PROTOCOL.locked} `)).toBe(true);
    await second.exited;

    expect(await request(first, `${INSTANCE_CHILD_PROTOCOL.start} ${PROFILE_TWO} ${MIN_PROFILE_REVISION}`)).toBe('RESULT JOB_ALREADY_ACTIVE -');
    expect(await jobsOf(first)).toEqual([[PROFILE_ONE, 'RUNNING', null]]);
    expect(startsReceived()).toBe(1);
    await closeChild(first);
  }, TEST_TIMEOUT_MS);
});

describe('the control instance lock: stale locks, concurrency, release', () => {
  it.each([
    ['a dead process', (): { processId: number; heartbeatAtMs: number } => ({ processId: deadProcessId(), heartbeatAtMs: Date.now() })],
    ['a running process whose heartbeat is too old', (): { processId: number; heartbeatAtMs: number } => ({
      processId: process.pid, heartbeatAtMs: Date.now() - RUN_LOCK_STALE_AFTER_MS - WAIT_LIMIT_MS,
    })],
  ] as const)('takes over a stale lock of %s, and marks the unfinished job INTERRUPTED', async (_name, lockOf) => {
    writeLeftovers(lockOf());
    const child = await startChild();

    expect(child.first).toBe(`${INSTANCE_CHILD_PROTOCOL.ready} 1`);
    expect(await jobsOf(child)).toEqual([[PROFILE_ONE, 'INTERRUPTED', 'SERVER_RESTARTED']]);
    await closeChild(child);
  }, TEST_TIMEOUT_MS);

  it('creates only one of two managers created at almost the same time by two processes', async () => {
    for (let round = 0; round < CONCURRENT_CREATION_ROUNDS; round += 1) {
      const pair = await Promise.all([startChild(), startChild()]);
      const ready = pair.filter(({ first }) => first.startsWith(`${INSTANCE_CHILD_PROTOCOL.ready} `));
      const locked = pair.filter(({ first }) => first.startsWith(`${INSTANCE_CHILD_PROTOCOL.locked} `));
      expect(ready, `round ${String(round)}: ${pair.map(({ first }) => first).join(' / ')}`).toHaveLength(1);
      expect(locked).toHaveLength(1);
      expect(locked[0]?.first).toBe(`${INSTANCE_CHILD_PROTOCOL.locked} ${String(ready[0]?.process.pid)} -`);
      await closeChild(ready[0] as InstanceChild);
      await locked[0]?.exited;
    }
  }, TEST_TIMEOUT_MS);

  // SR-1-F（DEF-168 と同じ形）: ほかの管理が古いロックを自分のものに書き換えている途中（書き込みのトランザクションを開いたまま、まだ確定して
  // いない）に、別の管理を作っても、取り直さない（ロックはファイルでなく、管理データの 1 行をトランザクションの中で書くので、作りかけの行は
  // 外から見えない）。確定の後は、書き換えた管理だけが持つ。
  it('lets only the manager that is writing its lock hold it when another manager is created during the write', async () => {
    writeLeftovers({ processId: deadProcessId(), heartbeatAtMs: Date.now() });
    const host = currentProcessRunLockHost(Date.now());
    const raw = new DatabaseSync(databasePath);
    let open = false;
    try {
      raw.exec('BEGIN IMMEDIATE');
      open = true;
      raw.prepare('INSERT OR REPLACE INTO control_instance (slot, process_id, booted_at_ms, acquired_at_ms, heartbeat_at_ms, port) VALUES (1, ?, ?, ?, ?, NULL)')
        .run(process.pid, host.bootedAtMs, host.nowMs, host.nowMs);
      const pending = startChild();
      // 子の管理が作られる間（管理データの待ちの上限 `CONTROL_DB_BUSY_TIMEOUT_MS` より短く）、書き換えを確定しない。
      await wait(LOCK_WRITE_HOLD_MS);
      raw.exec('COMMIT');
      open = false;
      const child = await pending;

      expect(child.first).toBe(`${INSTANCE_CHILD_PROTOCOL.locked} ${String(process.pid)} -`);
    } finally {
      if (open) {
        raw.exec('ROLLBACK');
      }
      raw.close();
    }
    expect(readControlInstanceLock(openInProcess())).toEqual({
      processId: process.pid, bootedAtMs: host.bootedAtMs, acquiredAtMs: host.nowMs, heartbeatAtMs: host.nowMs, port: null,
    });
  }, TEST_TIMEOUT_MS);

  it('can be created again after close(), and does not delete the lock of another manager', async () => {
    const first = createInProcess();
    await first.close();
    inProcess.manager = undefined;
    expect(readControlInstanceLock(openInProcess())).toBeNull();
    const again = createInProcess();
    await again.close();
    inProcess.manager = undefined;

    const other = await startChild(FIRST_SERVER_PORT);
    expect(other.first).toBe(`${INSTANCE_CHILD_PROTOCOL.ready} 0`);
    let caught: unknown;
    try {
      createInProcess();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ControlInstanceLockedError);
    expect(caught).toMatchObject({ reason: CONTROL_INSTANCE_ALREADY_RUNNING, holderProcessId: other.process.pid, holderPort: FIRST_SERVER_PORT });
    const held = readControlInstanceLock(openInProcess());
    expect(held?.processId).toBe(other.process.pid);
    // 他人のロックは、取った時刻が違えば消せない。
    expect(releaseControlInstanceLock(openInProcess(), { ...(held ?? { processId: 0, bootedAtMs: 0, acquiredAtMs: 0, heartbeatAtMs: 0 }), acquiredAtMs: (held?.acquiredAtMs ?? 0) + 1 })).toBe(false);
    expect(readControlInstanceLock(openInProcess())?.processId).toBe(other.process.pid);

    await closeChild(other);
    expect(readControlInstanceLock(openInProcess())).toBeNull();
    createInProcess();
    expect(readControlInstanceLock(openInProcess())?.processId).toBe(process.pid);
  }, TEST_TIMEOUT_MS);

  it('renews the heartbeat, and starts no new job after it lost the lock (without deleting the new holder)', async () => {
    const manager = createInProcess({ heartbeatIntervalMs: TEST_INSTANCE_HEARTBEAT_INTERVAL_MS });
    const acquired = readControlInstanceLock(openInProcess());
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while ((readControlInstanceLock(openInProcess())?.heartbeatAtMs ?? 0) <= (acquired?.heartbeatAtMs ?? 0) && Date.now() < deadline) {
      await wait(WAIT_POLL_MS);
    }
    expect(readControlInstanceLock(openInProcess())?.heartbeatAtMs).toBeGreaterThan(acquired?.heartbeatAtMs ?? 0);

    // ほかの管理が、古いと判定して取り直した（模す）。
    const raw = new DatabaseSync(databasePath);
    raw.prepare('UPDATE control_instance SET process_id = ?, acquired_at_ms = acquired_at_ms + 1').run(deadProcessId());
    raw.close();
    await wait(TEST_INSTANCE_HEARTBEAT_INTERVAL_MS * 5);

    expect(await manager.startAuditJob({ profileId: PROFILE_ONE, expectedRevision: MIN_PROFILE_REVISION, startNew: true }))
      .toMatchObject({ ok: false, reason: 'CONTROL_INSTANCE_LOCK_LOST' });
    const holder = readControlInstanceLock(openInProcess());
    await manager.close();
    inProcess.manager = undefined;
    expect(readControlInstanceLock(openInProcess())).toEqual(holder);
  }, TEST_TIMEOUT_MS);
});
