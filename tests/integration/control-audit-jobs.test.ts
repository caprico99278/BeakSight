// 監査のジョブの管理（`src/control/job/`。Task 24 の設計書 4.4、7 章「ジョブ」。T24e）の結合テスト。偽のワーカー（`tests/helpers/fake-audit-worker.ts`）
// を本物の `fork` で起動する（本物のワーカーと Chromium での確かめは `control-audit-jobs-worker.test.ts`）。
// - 開始の直前の検証し直し（I08）: 依頼の形、プロファイルがない、取り消した、改訂の不一致、実行できないモード、受けないパス（ファイルを読まない）、
//   ターゲット設定を読めない、`validateSiteProfile` を通らない。どれも行を作らず、ワーカーを起動しない（起動の回数で確かめる）。
// - 同時に 1 つ: 同じ process の中で 2 つの開始をほぼ同時に送ると、片方だけが成功する。
// - IPC: `START` の値、`RUN_STARTED` → `RUNNING`、`PROGRESS`（最短の間隔で間引いた最後の値）と `NOTICE`、`FINISHED`、`FAILED`。
// - 信頼の境界: 形の違うメッセージ、順の違うメッセージ → `FAILED`（`PROTOCOL_VIOLATION`）とワーカーの停止。`READY` が来ない、`HEARTBEAT` が止まる。
// - 停止: `STOP` → `STOPPING` → 結果、強制 → 終了コード 5、強制の後も終わらない → kill（`STOP_TIMEOUT`）。
// - 起動と終わりのとき: `recoverInterruptedJobs`、`shutdownAuditJobs`、1 つの process に 1 つの管理。
// 管理データは一時のフォルダだけを使う（リポジトリの `local-data/` に触らない）。起動したワーカーは、すべて止まったことを確かめる。
import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wait as pause } from '../../src/core/deadline.js';
import { EXIT_CODES, INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  createAuditJobManager,
  type AuditJobContextResolver,
  type AuditJobManager,
  type AuditJobManagerOptions,
  type AuditJobTiming,
  type AuditWorkerForker,
} from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, retireProfile, saveProfileDisplaySettings } from '../../src/control/store/profile-store.js';
import { WORKER_PROTOCOL_VERSION, targetConfigDigestOf } from '../../src/control/worker-protocol.js';
import { isProcessRunning } from '../../src/core/process-lock.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode } from '../helpers/fake-audit-worker.js';
import { blockingAfterStartFork, createCountingFork } from '../helpers/worker-fork.js';
import {
  CONTROL_JOB_TEST_TIMING,
  JOB_WAIT_LIMIT_MS,
  awaitWorkersExit,
  createFakeWorkerJobManager,
  expectWorkersExited,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
} from '../helpers/job-test-support.js';
import {
  PUBLIC_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

const FAKE_RUN_ID = 'RUN-20261009000000';
/** このジョブの Run ではない、別の Run の ID（T24h-1 の M1）。 */
const OTHER_RUN_ID = 'RUN-20261009000999';
/** ターゲット JSON の内容（親は、開始の直前にこのファイルの SHA-256 を求める。T24h-1 の M3）。 */
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example' } });
const PROFILE_ID = 'example-job';
const TEST_TIMEOUT_MS = 60_000;
/** 違反を受けた後、親がワーカーを止める処理を終えるのに十分な時間（ms。偽のワーカーが違反を送ってから）。 */
const VIOLATION_SETTLE_MS = 1_000;

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
/** 起動したワーカー（後片付けで、残っていないことを確かめる）。 */
const forks = createCountingFork();
const children = forks.children;
let resolverCalls: string[] = [];

const countingFork: AuditWorkerForker = forks.fork;

const countingResolver = (resolver: AuditJobContextResolver = resolveTestContext): AuditJobContextResolver => (path) => {
  resolverCalls.push(path);
  return resolver(path);
};

const fakeWorker = (mode: FakeWorkerMode): FakeWorker =>
  writeFakeWorker(workDirectory, mode, fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }));

const managerWith = (
  worker: FakeWorker,
  options: {
    readonly resolver?: AuditJobContextResolver;
    readonly forkWorker?: AuditWorkerForker;
    readonly timing?: Partial<AuditJobTiming>;
    /** DEF-146: 結果の前に終わったワーカーの終わり方の受け手。 */
    readonly onUnexpectedWorkerExit?: AuditJobManagerOptions['onUnexpectedWorkerExit'];
  } = {},
): AuditJobManager => {
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: countingResolver(options.resolver),
    forkWorker: options.forkWorker ?? countingFork,
    ...(options.timing === undefined ? {} : { timing: options.timing }),
    ...(options.onUnexpectedWorkerExit === undefined ? {} : { onUnexpectedWorkerExit: options.onUnexpectedWorkerExit }),
  });
  return manager;
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-audit-jobs-'));
  mkdirSync(join(workDirectory, 'config', 'targets'), { recursive: true });
  writeFileSync(join(workDirectory, PUBLIC_TARGET_PATH), TARGET_CONFIG_TEXT, 'utf8');
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  forks.reset();
  resolverCalls = [];
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const START_REQUEST = Object.freeze({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });

/** 終わった process の ID（死んだ PID）。 */
const deadProcessId = (): number => {
  const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  const processId = Number(result.stdout);
  expect(isProcessRunning(processId)).toBe(false);
  return processId;
};

async function startedJob(jobManager: AuditJobManager): Promise<AuditJobView> {
  const result = await jobManager.startAuditJob(START_REQUEST);
  if (!result.ok) {
    throw new Error(`the job did not start: ${result.reason}`);
  }
  return result.job;
}

/** 保存したプロファイルの文書を、生の接続で書き換える（壊れた・古い値を模す）。 */
function tamperProfile(changes: Record<string, unknown>): void {
  const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
  try {
    raw.prepare('UPDATE profiles SET document = ? WHERE profile_id = ?')
      .run(JSON.stringify({ ...publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), ...changes }), PROFILE_ID);
  } finally {
    raw.close();
  }
}

describe('audit jobs: the checks right before the start (I08)', () => {
  it.each([
    ['a request in a wrong shape', { profileId: 'NOT VALID', expectedRevision: 1, startNew: true }, 'INVALID_REQUEST'],
    ['a revision that is not an integer', { profileId: PROFILE_ID, expectedRevision: 1.5, startNew: true }, 'INVALID_REQUEST'],
    ['a profile that does not exist', { profileId: 'missing-profile', expectedRevision: 1, startNew: true }, 'PROFILE_NOT_FOUND'],
    ['a revision that differs from the stored one', { profileId: PROFILE_ID, expectedRevision: 2, startNew: true }, 'PROFILE_REVISION_CONFLICT'],
  ] as const)('rejects %s, without a job row and without starting a worker', async (_name, request, reason) => {
    const jobManager = managerWith(fakeWorker('hold'));
    const result = await jobManager.startAuditJob(request as never);

    expect(result).toEqual({ ok: false, reason, errors: [] });
    expect(jobManager.listAuditJobs()).toEqual([]);
    expect(forks.count()).toBe(0);
  });

  it('rejects a retired profile', async () => {
    expect(retireProfile(database, { profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }).ok).toBe(true);
    const jobManager = managerWith(fakeWorker('hold'));

    expect(await jobManager.startAuditJob({ ...START_REQUEST, expectedRevision: MIN_PROFILE_REVISION + 1 }))
      .toMatchObject({ ok: false, reason: 'PROFILE_RETIRED' });
    expect(forks.count()).toBe(0);
    expect(jobManager.listAuditJobs()).toEqual([]);
  });

  // T25d: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）は実行できるモードになった（その開始の確かめは `control-audit-jobs-auth.test.ts`）。
  // まだ実行できないモードの例を、書き込みの監査（`TEST_APPROVED_WRITE`）に替えた。
  it('rejects a mode that cannot run yet (TEST_APPROVED_WRITE), without reading the target configuration', async () => {
    const testProfileId = 'example-test-write';
    const writeProfile = { ...testAuthProfile(testProfileId, MIN_PROFILE_REVISION), mode: 'TEST_APPROVED_WRITE' as const };
    expect(createProfile(database, writeProfile, { resolveContext: resolveTestContext }).ok).toBe(true);
    const jobManager = managerWith(fakeWorker('hold'));

    expect(await jobManager.startAuditJob({ ...START_REQUEST, profileId: testProfileId }))
      .toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });
    expect(resolverCalls).toEqual([]);
    expect(forks.count()).toBe(0);
  });

  it('rejects a stored target path that is not accepted, without asking for the file', async () => {
    tamperProfile({ targetConfigPath: '../outside.json' });
    const jobManager = managerWith(fakeWorker('hold'));

    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'TARGET_PATH_INVALID' });
    expect(resolverCalls).toEqual([]);
    expect(forks.count()).toBe(0);
  });

  it('rejects when the target configuration cannot be read again', async () => {
    const jobManager = managerWith(fakeWorker('hold'), { resolver: () => Promise.resolve(undefined) });

    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE' });
    expect(resolverCalls).toEqual([PUBLIC_TARGET_PATH]);
    expect(forks.count()).toBe(0);
  });

  it('rejects when reading the target configuration throws', async () => {
    const jobManager = managerWith(fakeWorker('hold'), { resolver: () => Promise.reject(new Error('unreadable')) });

    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE' });
    expect(forks.count()).toBe(0);
  });

  // T24h-1 の M3: 読み直しの前と後で、ターゲット JSON の内容が変わったら（SHA-256 が違えば）拒む。
  it('rejects when the target configuration file changes while it is read again', async () => {
    const jobManager = managerWith(fakeWorker('hold'), {
      resolver: (path) => {
        writeFileSync(join(workDirectory, PUBLIC_TARGET_PATH), JSON.stringify({ target: { id: 'changed' } }), 'utf8');
        return Promise.resolve(resolveTestContext(path));
      },
    });

    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE' });
    expect(forks.count()).toBe(0);
    expect(jobManager.listAuditJobs()).toEqual([]);
  });

  it('rejects when the target configuration file does not exist (the digest cannot be taken)', async () => {
    rmSync(join(workDirectory, PUBLIC_TARGET_PATH));
    const jobManager = managerWith(fakeWorker('hold'));

    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'TARGET_CONFIG_UNAVAILABLE' });
    expect(forks.count()).toBe(0);
  });

  it('rejects a profile that does not pass validateSiteProfile any more, with its errors', async () => {
    // 公開の環境なのに、環境の証拠の参照を持つ（形は正しいが、規則に合わない）。
    tamperProfile({ environmentEvidenceRef: 'evidence/example' });
    const jobManager = managerWith(fakeWorker('hold'));

    const result = await jobManager.startAuditJob(START_REQUEST);
    expect(result).toMatchObject({ ok: false, reason: 'PROFILE_INVALID' });
    expect(result.ok ? [] : result.errors.map(({ code }) => code)).toContain('PROFILE_MODE_ENVIRONMENT_MISMATCH');
    expect(forks.count()).toBe(0);
  });

  it('rejects when the profile changed while the target configuration was read again', async () => {
    const jobManager = managerWith(fakeWorker('hold'), {
      resolver: (path) => {
        // 読み直しを待つ間に、プロファイルが更新された（改訂が進んだ）。
        const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
        try {
          raw.prepare('UPDATE profiles SET revision = ?, document = ? WHERE profile_id = ?')
            .run(MIN_PROFILE_REVISION + 1, JSON.stringify(publicProfile(PROFILE_ID, MIN_PROFILE_REVISION + 1)), PROFILE_ID);
        } finally {
          raw.close();
        }
        return Promise.resolve(resolveTestContext(path));
      },
    });

    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'PROFILE_REVISION_CONFLICT' });
    expect(forks.count()).toBe(0);
    expect(jobManager.listAuditJobs()).toEqual([]);
  });
});

describe('audit jobs: one job at a time', () => {
  it('accepts only one of two starts sent at almost the same time in one process', async () => {
    const jobManager = managerWith(fakeWorker('hold'));
    const results = await Promise.all([jobManager.startAuditJob(START_REQUEST), jobManager.startAuditJob(START_REQUEST)]);

    expect(results.filter(({ ok }) => ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).map((result) => (result.ok ? null : result.reason))).toEqual(['JOB_ALREADY_ACTIVE']);
    expect(forks.count()).toBe(1);
    expect(jobManager.listAuditJobs()).toHaveLength(1);
    // 終わっていないジョブがある間は、次の開始も拒む。
    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });
  }, TEST_TIMEOUT_MS);

  it('accepts the next start after the job ended', async () => {
    const jobManager = managerWith(fakeWorker('finish'));
    const first = await startedJob(jobManager);
    await waitForJob(jobManager, first.jobId, isJobEnded);
    await expectWorkersExited(children, { requireExitEvent: true });

    const second = await jobManager.startAuditJob(START_REQUEST);
    expect(second.ok).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('allows only one job manager in a process', async () => {
    managerWith(fakeWorker('hold'));
    expect(() => createAuditJobManager({
      database,
      repositoryRoot: workDirectory,
      workerPath: join(workDirectory, 'fake-worker-hold.mjs'),
      resolveContext: resolveTestContext,
    })).toThrow(/only one audit job manager/u);
  });
});

describe('audit jobs: the messages of the worker', () => {
  it('sends START with the checked values, and records RUNNING, the last progress, the notice and FINISHED', async () => {
    const worker = fakeWorker('finish');
    const jobManager = managerWith(worker);
    const job = await startedJob(jobManager);
    expect(job).toMatchObject({ state: 'STARTING', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: true });

    const finished = await waitForJob(jobManager, job.jobId, isJobEnded);
    expect(finished).toMatchObject({
      state: 'FINISHED',
      runId: FAKE_RUN_ID,
      runDirectory: FAKE_RUN_ID,
      exitCode: EXIT_CODES.COMPLETE,
      resultRunStatus: 'COMPLETE',
      endKind: 'RAN',
      failureReason: null,
      lastNotice: { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10 },
    });
    // 進み具合は、間引いた後の最後の値。
    expect(finished.lastProgress?.pagesFinished).toBe(2);
    expect(finished.startedAt).not.toBeNull();
    expect(finished.lastHeartbeatAt).not.toBeNull();
    // FM-2: 表示の設定（既定は表示）を、ジョブの開始のときに読んで `START` に入れる。
    expect(worker.received()).toEqual([{
      protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: job.jobId, jobKind: 'AUDIT', targetConfigPath: PUBLIC_TARGET_PATH, startNew: true,
      targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode(TARGET_CONFIG_TEXT)), showJobBrowser: true,
      // AS-b: 監査の段の送信の扱い（既定は読み取りだけ）も、ジョブの開始のときに読んで入れる。
      auditSendPolicy: 'READ_ONLY',
      // PRE42-BN: 監査のジョブは、プロファイルの名前（画面の「名前（profileId）」）を入れる（ChatGPT 用バンドルのファイル名だけに使う）。
      profileName: PROFILE_ID,
    }]);
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  // FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: 表示の設定を切ったプロファイルのジョブは、`START` で表示しないと渡す。
  it('sends START with the display setting of the profile (not shown)', async () => {
    expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: false }).ok).toBe(true);
    const worker = fakeWorker('finish');
    const jobManager = managerWith(worker);
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, isJobEnded);
    expect(worker.received().find((message) => message['type'] === 'START')?.['showJobBrowser']).toBe(false);
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  // AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: 監査の段の送信の扱いを切り替えたプロファイルの監査のジョブは、`START` でその扱いを渡す。
  it('sends START with the audit send policy of the profile (PASS_EXCEPT_DELETE)', async () => {
    expect(saveProfileDisplaySettings(database, PROFILE_ID, { showJobBrowser: false, auditSendPolicy: 'PASS_EXCEPT_DELETE' }).ok).toBe(true);
    const worker = fakeWorker('finish');
    const jobManager = managerWith(worker);
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, isJobEnded);
    const start = worker.received().find((message) => message['type'] === 'START');
    expect(start?.['auditSendPolicy']).toBe('PASS_EXCEPT_DELETE');
    expect(start?.['showJobBrowser']).toBe(false);
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  // DEF-084: 子が最後のメッセージを送ってから終わると、混雑の下で、親の `exit` が最後の `message`（`FINISHED`）より先に来ることがある。
  // `START` の直後に親をふさいで、その形を決まって作る。
  it('records FINISHED even when the exit of the worker arrives before its last messages (DEF-084)', async () => {
    const jobManager = managerWith(fakeWorker('finish'), { forkWorker: blockingAfterStartFork(countingFork) });
    const job = await startedJob(jobManager);

    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({
      state: 'FINISHED',
      runId: FAKE_RUN_ID,
      exitCode: EXIT_CODES.COMPLETE,
      resultRunStatus: 'COMPLETE',
      endKind: 'RAN',
      failureReason: null,
    });
    await expectWorkersExited(children, { requireExitEvent: true });
    expect(jobManager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('records FAILED with the reason the worker sent, and its exit code', async () => {
    const jobManager = managerWith(fakeWorker('fail'));
    const job = await startedJob(jobManager);
    await expectWorkersExited(children, { requireExitEvent: true });

    expect(await waitForJob(jobManager, job.jobId, (current) => current.exitCode !== null))
      .toMatchObject({ state: 'FAILED', failureReason: 'CONFIG_ERROR', exitCode: EXIT_CODES.CONFIG_ERROR });
  }, TEST_TIMEOUT_MS);

  it.each([
    ['a message in a wrong shape', 'malformed'],
    ['RUN_STARTED before START', 'out-of-order'],
  ] as const)('stops the worker and records FAILED PROTOCOL_VIOLATION on %s', async (_name, mode) => {
    const jobManager = managerWith(fakeWorker(mode));
    const job = await startedJob(jobManager);

    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
    await expectWorkersExited(children, { requireExitEvent: true });
    expect(jobManager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  // T24h-1 の M1: Run のディレクトリと Run の ID を結びつける。
  it.each([
    ['a run directory that is not the name of the run id', 'mismatched-directory'],
    ['FINISHED for another run', 'finished-other-run'],
  ] as const)('stops the worker and records FAILED PROTOCOL_VIOLATION on %s, keeping the run of RUN_STARTED', async (_name, mode) => {
    const jobManager = managerWith(fakeWorker(mode));
    const job = await startedJob(jobManager);

    const ended = await waitForJob(jobManager, job.jobId, isJobEnded);
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
    expect(ended.runId).not.toBe(OTHER_RUN_ID);
    expect(ended.runDirectory).not.toBe(OTHER_RUN_ID);
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  // T24h-1 の M2: 違反の後も、ワーカーが終わるまでは同時に 1 つの枠を空けない。
  it('keeps the job active until the worker exits after a protocol violation', async () => {
    let releaseKill: () => void = () => undefined;
    const killReleased = new Promise<void>((resolvePromise) => {
      releaseKill = resolvePromise;
    });
    const slowKillFork: AuditWorkerForker = (modulePath, args, options) => {
      const child = countingFork(modulePath, args, options);
      const kill = child.kill.bind(child);
      // 止める要求を受けても、テストが許すまで終わらない（違反の後も動き続けるワーカーを模す）。
      child.kill = (signal?: NodeJS.Signals | number): boolean => {
        void killReleased.then(() => kill(signal));
        return true;
      };
      return child;
    };
    const jobManager = managerWith(fakeWorker('malformed'), { forkWorker: slowKillFork });
    const job = await startedJob(jobManager);
    await pause(VIOLATION_SETTLE_MS);

    expect(jobManager.getAuditJob(job.jobId)?.finishedAt).toBeNull();
    expect(jobManager.runningWorkerCount()).toBe(1);
    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });
    expect(children.every((child) => child.exitCode === null && child.signalCode === null)).toBe(true);

    releaseKill();
    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
    await expectWorkersExited(children, { requireExitEvent: true });
    expect(jobManager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('stops the worker and records FAILED WORKER_NOT_READY when READY does not come', async () => {
    const jobManager = managerWith(fakeWorker('silent'));
    const job = await startedJob(jobManager);

    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'FAILED', failureReason: 'WORKER_NOT_READY' });
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  it('stops the worker and records INTERRUPTED WORKER_UNRESPONSIVE when HEARTBEAT stops', async () => {
    const jobManager = managerWith(fakeWorker('no-heartbeat'));
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, (current) => current.state === 'RUNNING');

    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_UNRESPONSIVE' });
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  it('records FAILED WORKER_START_FAILED when the worker file does not exist', async () => {
    const jobManager = managerWith({ path: join(workDirectory, 'missing-worker.mjs'), received: () => [] });
    const job = await startedJob(jobManager);

    expect(job).toMatchObject({ state: 'FAILED', failureReason: 'WORKER_START_FAILED' });
    expect(forks.count()).toBe(0);
  });
});

/** IPC の終わりを待つ上限（ms。DEF-084 のテスト。偽の子の `disconnect` が来ないとき）。 */
const DRAIN_TEST_WAIT_MS = 1_000;
/** 見張り・`READY`・強制の止め方の時間（ms。DEF-084 のテスト。IPC の終わりを待つ上限より十分に短い）。 */
const DRAIN_TEST_TIMER_LIMIT_MS = 200;
/** `exit` から、まだ終わっていないことを確かめるまでの時間（ms。上の時間と見張りの間隔を過ぎ、IPC の終わりを待つ上限より前）。 */
const DRAIN_TEST_EARLY_CHECK_MS = 600;
/** `disconnect` で待つのをやめることを確かめるときの、IPC の終わりを待つ上限（ms。テストの時間の上限よりも長い）。 */
const DRAIN_TEST_LONG_WAIT_MS = 120_000;

/**
 * テストが `message`・`exit`・`disconnect` を出す偽の子（DEF-084）。`connected` は、`disconnect()` を呼ぶまで真のまま（`exit` だけでは
 * 変わらない）。送られたメッセージを記録し、止める要求（`kill`）では何もしない。
 */
class ScriptedChild extends EventEmitter {
  readonly pid: number;
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly sent: unknown[] = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }

  kill(): boolean {
    return true;
  }

  /** ワーカーからのメッセージを届ける。 */
  deliver(message: Readonly<Record<string, unknown>>): void {
    this.emit('message', { protocol: WORKER_PROTOCOL_VERSION, ...message });
  }

  /** process が終わった（IPC は切らない）。DEF-146: シグナルで終わった形も出せる。 */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  /** IPC が切れた。 */
  disconnect(): void {
    this.connected = false;
    this.emit('disconnect');
  }
}

const SCRIPTED_READY = Object.freeze({ type: 'READY' });
const SCRIPTED_RUN_STARTED = Object.freeze({
  type: 'RUN_STARTED', runId: FAKE_RUN_ID, runDirectory: FAKE_RUN_ID, resumeDecision: { kind: 'NEW_RUN', completedPages: null },
});
const SCRIPTED_FINISHED = Object.freeze({
  type: 'FINISHED',
  outcome: { kind: 'RAN', exitCode: EXIT_CODES.COMPLETE, runId: FAKE_RUN_ID, runDirectory: FAKE_RUN_ID, runStatus: 'COMPLETE' },
});

/** 偽の子でジョブを始める（DEF-084）。起動のたびに、新しい偽の子を `scripted` に足す。 */
async function startScriptedJob(
  timing: Partial<AuditJobTiming>,
  onUnexpectedWorkerExit?: AuditJobManagerOptions['onUnexpectedWorkerExit'],
): Promise<{
  readonly jobManager: AuditJobManager;
  readonly job: AuditJobView;
  readonly scripted: readonly ScriptedChild[];
}> {
  const scripted: ScriptedChild[] = [];
  const processId = deadProcessId();
  const jobManager = managerWith(fakeWorker('finish'), {
    forkWorker: () => {
      const child = new ScriptedChild(processId);
      scripted.push(child);
      return child as unknown as ChildProcess;
    },
    timing,
    ...(onUnexpectedWorkerExit === undefined ? {} : { onUnexpectedWorkerExit }),
  });
  const job = await startedJob(jobManager);
  return { jobManager, job, scripted };
}

/** 偽の子を、IPC を切ってから終わらせる（後片付け）。 */
const endScripted = (child: ScriptedChild | undefined): void => {
  child?.disconnect();
  child?.exit(EXIT_CODES.COMPLETE);
};

describe('audit jobs: waiting for the last messages after the worker exits (DEF-084)', () => {
  it('records INTERRUPTED WORKER_EXITED after the limit when IPC stays connected, and then frees the slot', async () => {
    const { jobManager, job, scripted } = await startScriptedJob({ ipcDrainWaitMs: DRAIN_TEST_WAIT_MS });
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.exit(EXIT_CODES.COMPLETE);
    await pause(DRAIN_TEST_EARLY_CHECK_MS);

    expect(jobManager.getAuditJob(job.jobId)?.finishedAt).toBeNull();
    expect(jobManager.runningWorkerCount()).toBe(1);
    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });

    expect(await waitForJob(jobManager, job.jobId, isJobEnded))
      .toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED', exitCode: EXIT_CODES.COMPLETE });
    expect(jobManager.runningWorkerCount()).toBe(0);
    const next = await jobManager.startAuditJob(START_REQUEST);
    expect(next.ok).toBe(true);
    endScripted(scripted[1]);
    if (next.ok) {
      await waitForJob(jobManager, next.job.jobId, isJobEnded);
    }
  }, TEST_TIMEOUT_MS);

  it('records FINISHED when it arrives after the exit and before the limit', async () => {
    const { jobManager, job, scripted } = await startScriptedJob({ ipcDrainWaitMs: DRAIN_TEST_WAIT_MS });
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    child?.exit(EXIT_CODES.COMPLETE);
    await pause(DRAIN_TEST_TIMER_LIMIT_MS);
    child?.deliver(SCRIPTED_FINISHED);

    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({
      state: 'FINISHED', runId: FAKE_RUN_ID, resultRunStatus: 'COMPLETE', exitCode: EXIT_CODES.COMPLETE, endKind: 'RAN', failureReason: null,
    });
    expect(jobManager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['the heartbeat limit', true, false],
    ['the READY limit', false, false],
    ['the kill limit of a forced stop', true, true],
  ] as const)('does not end the job by %s while it waits, and records WORKER_EXITED after the limit', async (_name, ready, forceStop) => {
    const { jobManager, job, scripted } = await startScriptedJob({
      ipcDrainWaitMs: DRAIN_TEST_WAIT_MS,
      heartbeatTimeoutMs: DRAIN_TEST_TIMER_LIMIT_MS,
      readyTimeoutMs: DRAIN_TEST_TIMER_LIMIT_MS,
      forceStopKillAfterMs: DRAIN_TEST_TIMER_LIMIT_MS,
    });
    const child = scripted[0];
    if (ready) {
      child?.deliver(SCRIPTED_READY);
    }
    child?.exit(EXIT_CODES.COMPLETE);
    if (forceStop) {
      expect(jobManager.stopAuditJob(job.jobId, { force: true }).ok).toBe(true);
    }
    await pause(DRAIN_TEST_EARLY_CHECK_MS);

    expect(jobManager.getAuditJob(job.jobId)?.finishedAt).toBeNull();
    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    // 終わった process には、止める要求を送らない。
    expect(child?.sent.some((message) => (message as Readonly<Record<string, unknown>>)['type'] === 'STOP')).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('stops waiting when IPC is disconnected, and does not wait when it was already disconnected at the exit', async () => {
    const { jobManager, job, scripted } = await startScriptedJob({ ipcDrainWaitMs: DRAIN_TEST_LONG_WAIT_MS });
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    child?.exit(EXIT_CODES.COMPLETE);
    child?.deliver(SCRIPTED_FINISHED);
    child?.disconnect();
    await pause(DRAIN_TEST_TIMER_LIMIT_MS);
    expect(jobManager.getAuditJob(job.jobId)).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE' });

    const next = await startedJob(jobManager);
    const second = scripted[1];
    second?.deliver(SCRIPTED_READY);
    endScripted(second);
    await pause(DRAIN_TEST_TIMER_LIMIT_MS);
    expect(jobManager.getAuditJob(next.jobId)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    expect(jobManager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);
});

/** DEF-143 のテストの時間（ms）。途絶えの上限は短く、見張りの間隔はさらに短くする。 */
const FINALIZING_TEST_HEARTBEAT_TIMEOUT_MS = 300;
const FINALIZING_TEST_WATCHDOG_INTERVAL_MS = 50;
/** 段の知らせの後の、途絶えの上限（テストの値。途絶えの時間より十分に長い）。 */
const FINALIZING_TEST_LONG_TIMEOUT_MS = 60_000;
/** 段の知らせの後の、途絶えの上限（上限を過ぎることを確かめるテストの値）。 */
const FINALIZING_TEST_SHORT_TIMEOUT_MS = 600;
/** 合図が途絶える時間（ms。ふだんの上限の 3 倍以上）。 */
const FINALIZING_TEST_SILENCE_MS = 1_000;
/** 段の知らせの後の上限を過ぎるまで待つ時間（ms）。 */
const FINALIZING_TEST_LONG_SILENCE_MS = 1_500;
/** process の終わりを見つけるまでの上限（ms。段の知らせの後の上限より、ずっと短い）。 */
const FINALIZING_TEST_EXIT_LIMIT_MS = 5_000;

const SCRIPTED_HEARTBEAT = Object.freeze({ type: 'HEARTBEAT' });
const SCRIPTED_RUN_FINALIZING = Object.freeze({ type: 'RUN_FINALIZING' });

/** 見張りが、ワーカーを応答しないとして止めると決めたか（止める要求の kill の後、終わりの記録はワーカーが終わった後）。 */
const endedWith = async (jobManager: AuditJobManager, jobId: string, child: ScriptedChild | undefined): Promise<AuditJobView> => {
  endScripted(child);
  return await waitForJob(jobManager, jobId, isJobEnded);
};

// DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: ワーカーが「Run の終わり」の段の知らせ（`RUN_FINALIZING`）を
// 送った後は、その段の間だけ、途絶えの上限を名前つきの長い時間にする。段の外の途絶えは、今どおりの上限で止める。process の終わりは、今どおりすぐ見つける。
describe('audit jobs (DEF-143): the longer heartbeat limit of the finalizing stage', () => {
  const finalizingTiming = (finalizingHeartbeatTimeoutMs: number): Partial<AuditJobTiming> => ({
    heartbeatTimeoutMs: FINALIZING_TEST_HEARTBEAT_TIMEOUT_MS,
    watchdogIntervalMs: FINALIZING_TEST_WATCHDOG_INTERVAL_MS,
    watchdogLagLimitMs: FINALIZING_TEST_HEARTBEAT_TIMEOUT_MS / 2,
    finalizingHeartbeatTimeoutMs,
  });

  it('does not stop the worker whose heartbeats stop after RUN_FINALIZING, and records the result', async () => {
    const { jobManager, job, scripted } = await startScriptedJob(finalizingTiming(FINALIZING_TEST_LONG_TIMEOUT_MS));
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    child?.deliver(SCRIPTED_RUN_FINALIZING);
    await pause(FINALIZING_TEST_SILENCE_MS);

    expect(jobManager.getAuditJob(job.jobId)).toMatchObject({ state: 'RUNNING', finishedAt: null });
    child?.deliver(SCRIPTED_FINISHED);
    expect(await endedWith(jobManager, job.jobId, child)).toMatchObject({
      state: 'FINISHED', runId: FAKE_RUN_ID, resultRunStatus: 'COMPLETE', exitCode: EXIT_CODES.COMPLETE, failureReason: null,
    });
  }, TEST_TIMEOUT_MS);

  it('stops the worker as before when the heartbeats stop outside the finalizing stage', async () => {
    const { jobManager, job, scripted } = await startScriptedJob(finalizingTiming(FINALIZING_TEST_LONG_TIMEOUT_MS));
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    await pause(FINALIZING_TEST_SILENCE_MS);

    child?.deliver(SCRIPTED_FINISHED);
    expect(await endedWith(jobManager, job.jobId, child)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_UNRESPONSIVE' });
  }, TEST_TIMEOUT_MS);

  it('stops the worker when the heartbeats stop longer than the limit of the finalizing stage', async () => {
    const { jobManager, job, scripted } = await startScriptedJob(finalizingTiming(FINALIZING_TEST_SHORT_TIMEOUT_MS));
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    child?.deliver(SCRIPTED_RUN_FINALIZING);
    await pause(FINALIZING_TEST_LONG_SILENCE_MS);

    child?.deliver(SCRIPTED_FINISHED);
    expect(await endedWith(jobManager, job.jobId, child)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_UNRESPONSIVE' });
  }, TEST_TIMEOUT_MS);

  it('finds the end of the worker process in the finalizing stage as before', async () => {
    const { jobManager, job, scripted } = await startScriptedJob(finalizingTiming(FINALIZING_TEST_LONG_TIMEOUT_MS));
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    child?.deliver(SCRIPTED_RUN_FINALIZING);
    endScripted(child);

    expect(await waitForJob(jobManager, job.jobId, isJobEnded, { limitMs: FINALIZING_TEST_EXIT_LIMIT_MS }))
      .toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    expect(jobManager.runningWorkerCount()).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('does not trust RUN_FINALIZING before READY', async () => {
    const { jobManager, job, scripted } = await startScriptedJob(finalizingTiming(FINALIZING_TEST_LONG_TIMEOUT_MS));
    const child = scripted[0];
    child?.deliver(SCRIPTED_RUN_FINALIZING);

    expect(await endedWith(jobManager, job.jobId, child)).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
  }, TEST_TIMEOUT_MS);
});

/** DEF-143 の見張りの遅れのテストの時間（ms）。 */
const LAG_TEST_HEARTBEAT_TIMEOUT_MS = 1_500;
const LAG_TEST_WATCHDOG_INTERVAL_MS = 100;
const LAG_TEST_LAG_LIMIT_MS = 750;
/** 親（このテストの process）が main thread を止める時間（ms。途絶えの上限より長い）。 */
const LAG_TEST_PARENT_BLOCK_MS = 2_000;
/** 合図を届ける間隔（ms。偽の子の代わり）。 */
const LAG_TEST_HEARTBEAT_INTERVAL_MS = 100;
/** 親が止まった後に、見張りが何回か回るのを待つ時間（ms）。 */
const LAG_TEST_SETTLE_MS = 500;

/** main thread を `ms` の間止める（親自身が重い処理で止まった場面）。 */
const blockMainThread = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // 止める。
  }
};

// DEF-143（設計書 4 章の判断）: 親自身の main thread が止まっていた後は、見張りの回が、溜まった `HEARTBEAT` を受ける前に来ることがある（timers の段は、
// IPC を読む段より先）。見張りの間隔が名前つきの量より大きく遅れた回は、判定しない（溜まった合図を受けてから、次の回で判定する）。
describe('audit jobs (DEF-143): the watchdog after the parent itself was blocked', () => {
  it('does not stop the worker when the watchdog runs late before the heartbeat that arrived during the block', async () => {
    const { jobManager, job, scripted } = await startScriptedJob({
      heartbeatTimeoutMs: LAG_TEST_HEARTBEAT_TIMEOUT_MS,
      watchdogIntervalMs: LAG_TEST_WATCHDOG_INTERVAL_MS,
      watchdogLagLimitMs: LAG_TEST_LAG_LIMIT_MS,
    });
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    let heartbeats = setInterval(() => child?.deliver(SCRIPTED_HEARTBEAT), LAG_TEST_HEARTBEAT_INTERVAL_MS);
    await pause(LAG_TEST_SETTLE_MS);

    // 止まる直前に合図を受け、その後の合図は、止まっている間に届いて溜まったものとして、次の check の段（見張りの timers の段の後）で届ける。
    clearInterval(heartbeats);
    await new Promise<void>((resolvePromise) => {
      setImmediate(() => {
        child?.deliver(SCRIPTED_HEARTBEAT);
        blockMainThread(LAG_TEST_PARENT_BLOCK_MS);
        setImmediate(() => {
          child?.deliver(SCRIPTED_HEARTBEAT);
          resolvePromise();
        });
      });
    });
    heartbeats = setInterval(() => child?.deliver(SCRIPTED_HEARTBEAT), LAG_TEST_HEARTBEAT_INTERVAL_MS);
    await pause(LAG_TEST_SETTLE_MS);
    clearInterval(heartbeats);

    expect(jobManager.getAuditJob(job.jobId)).toMatchObject({ state: 'RUNNING', finishedAt: null });
    child?.deliver(SCRIPTED_FINISHED);
    expect(await endedWith(jobManager, job.jobId, child)).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE' });
  }, TEST_TIMEOUT_MS);
});

describe('audit jobs: stopping', () => {
  it('sends STOP, records STOPPING, and then the result of the worker', async () => {
    const worker = fakeWorker('hold');
    const jobManager = managerWith(worker);
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, (current) => current.state === 'RUNNING');

    const stopped = jobManager.stopAuditJob(job.jobId);
    expect(stopped).toMatchObject({ ok: true, job: { state: 'STOPPING' } });
    expect(stopped.ok ? stopped.job.stopRequestedAt : null).not.toBeNull();
    expect(await waitForJob(jobManager, job.jobId, isJobEnded))
      .toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL', exitCode: EXIT_CODES.PARTIAL });
    expect(worker.received().map(({ type, force }) => [type, force])).toEqual([['START', undefined], ['STOP', false]]);
    await expectWorkersExited(children, { requireExitEvent: true });
    expect(jobManager.stopAuditJob(job.jobId)).toEqual({ ok: false, reason: 'JOB_NOT_ACTIVE' });
    expect(jobManager.stopAuditJob('missing-job')).toEqual({ ok: false, reason: 'JOB_NOT_FOUND' });
  }, TEST_TIMEOUT_MS);

  it('records INTERRUPTED WORKER_EXITED with the exit code 5 on a STOP with force', async () => {
    const jobManager = managerWith(fakeWorker('hold'));
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, (current) => current.state === 'RUNNING');

    jobManager.stopAuditJob(job.jobId, { force: true });
    expect(await waitForJob(jobManager, job.jobId, isJobEnded))
      .toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED', exitCode: INTERRUPTED_EXIT_CODE });
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  it('kills the worker and records INTERRUPTED STOP_TIMEOUT when it does not end after a STOP with force', async () => {
    const jobManager = managerWith(fakeWorker('ignore-stop'));
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, (current) => current.state === 'RUNNING');

    jobManager.stopAuditJob(job.jobId, { force: true });
    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'STOP_TIMEOUT' });
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);

  it('does not start the Run when STOP comes before READY: it sends STOP instead of START', async () => {
    const worker = fakeWorker('hold');
    const jobManager = managerWith(worker);
    const job = await startedJob(jobManager);
    jobManager.stopAuditJob(job.jobId);

    expect(isJobEnded(await waitForJob(jobManager, job.jobId, isJobEnded))).toBe(true);
    expect(worker.received().map(({ type }) => type)).toEqual(['STOP']);
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);
});

describe('audit jobs: the start and the end of the UI server', () => {
  // T24h-6（再レビュー T24R2 の m1）: ほかの管理のジョブのワーカーがまだ動いている（process が動いていて、合図の記録が新しい）なら、中断に直さず、
  // 新しい開始を拒む。process が終わっているか、合図の記録が名前つきの時間より古い（process の ID の使い回しを含む）なら、中断に直す。
  it.each([
    ['a running worker with a fresh heartbeat', (): number => process.pid, 0, 'RUNNING'],
    ['a running process with a stale heartbeat (a reused process id)', (): number => process.pid, CONTROL_JOB_TEST_TIMING.unownedWorkerStaleAfterMs * 4, 'INTERRUPTED'],
    ['a dead worker with a fresh heartbeat', (): number => deadProcessId(), 0, 'INTERRUPTED'],
  ] as const)('handles a job of another manager with %s', async (_name, pidOf, ageMs, expectedState) => {
    const heartbeatAt = formatCompactUtcTimestamp(new Date(Date.now() - ageMs), 'test heartbeat');
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
    // T26c: 版 4 のジョブの表は、種類（`job_kind`）を必ず書く。
    raw.prepare("INSERT INTO jobs (job_id, profile_id, profile_revision, state, start_new, created_at, worker_pid, last_heartbeat_at, job_kind) VALUES ('other-job', ?, ?, 'RUNNING', 0, ?, ?, ?, 'AUDIT')")
      .run(PROFILE_ID, MIN_PROFILE_REVISION, heartbeatAt, pidOf(), heartbeatAt);
    raw.close();
    const jobManager = managerWith(fakeWorker('hold'));

    jobManager.recoverInterruptedJobs();
    expect(jobManager.getAuditJob('other-job')?.state).toBe(expectedState);
    const started = await jobManager.startAuditJob(START_REQUEST);
    if (expectedState === 'RUNNING') {
      expect(started).toMatchObject({ ok: false, reason: 'JOB_ALREADY_ACTIVE' });
      expect(forks.count()).toBe(0);
    } else {
      expect(started.ok).toBe(true);
    }
  }, TEST_TIMEOUT_MS);

  it('marks the jobs that a previous server left unfinished as INTERRUPTED SERVER_RESTARTED, and keeps its own', async () => {
    const raw = new DatabaseSync(resolveControlDatabasePath(workDirectory));
    // T26c: 版 4 のジョブの表は、種類（`job_kind`）を必ず書く。
    raw.prepare("INSERT INTO jobs (job_id, profile_id, profile_revision, state, start_new, created_at, job_kind) VALUES ('left-job', ?, ?, 'RUNNING', 0, '20261009000000', 'AUDIT')")
      .run(PROFILE_ID, MIN_PROFILE_REVISION);
    raw.close();
    const jobManager = managerWith(fakeWorker('hold'));

    expect(jobManager.recoverInterruptedJobs()).toBe(1);
    expect(jobManager.getAuditJob('left-job')).toMatchObject({ state: 'INTERRUPTED', failureReason: 'SERVER_RESTARTED' });
    expect(jobManager.recoverInterruptedJobs()).toBe(0);
    const job = await startedJob(jobManager);
    expect(jobManager.recoverInterruptedJobs()).toBe(0);
    expect(jobManager.getAuditJob(job.jobId)?.state).not.toBe('INTERRUPTED');
  }, TEST_TIMEOUT_MS);

  it('sends STOP to the running job on shutdown, waits for its end, and refuses new starts', async () => {
    const jobManager = managerWith(fakeWorker('hold'));
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, (current) => current.state === 'RUNNING');

    expect(await jobManager.shutdownAuditJobs({ waitMs: JOB_WAIT_LIMIT_MS })).toEqual({ stopRequested: 1, killed: 0 });
    expect(jobManager.getAuditJob(job.jobId)).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL' });
    await expectWorkersExited(children, { requireExitEvent: true });
    expect(await jobManager.startAuditJob(START_REQUEST)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
  }, TEST_TIMEOUT_MS);

  it('kills the worker that does not end within the wait on shutdown, and records INTERRUPTED SERVER_SHUTDOWN', async () => {
    const jobManager = managerWith(fakeWorker('ignore-stop'));
    const job = await startedJob(jobManager);
    await waitForJob(jobManager, job.jobId, (current) => current.state === 'RUNNING');

    expect(await jobManager.shutdownAuditJobs({ waitMs: CONTROL_JOB_TEST_TIMING.watchdogIntervalMs })).toEqual({ stopRequested: 1, killed: 1 });
    expect(jobManager.getAuditJob(job.jobId)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'SERVER_SHUTDOWN' });
    await expectWorkersExited(children, { requireExitEvent: true });
  }, TEST_TIMEOUT_MS);
});

// DEF-146: ワーカーが結果の前に終わった（落ちた）ときは、親が分かる終わり方（終了コード・シグナル）を受け手に 1 回だけ渡す（画面のサーバが記録のファイルに
// 書く）。結果を受けた後の、ふつうの終わりでは渡さない。
describe('audit jobs (DEF-146): the end of a worker that exited before its result', () => {
  it('passes the exit code of a worker that exited without its result, once', async () => {
    const exits: unknown[] = [];
    const { jobManager, job, scripted } = await startScriptedJob({ ipcDrainWaitMs: DRAIN_TEST_WAIT_MS }, (event) => exits.push(event));
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    child?.disconnect();
    child?.exit(3);
    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    expect(exits).toEqual([{ jobId: job.jobId, jobKind: 'AUDIT', exitCode: 3, signal: null }]);
  }, TEST_TIMEOUT_MS);

  it('passes the signal of a worker that was ended by a signal', async () => {
    const exits: unknown[] = [];
    const { jobManager, job, scripted } = await startScriptedJob({ ipcDrainWaitMs: DRAIN_TEST_WAIT_MS }, (event) => exits.push(event));
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.disconnect();
    child?.exit(null, 'SIGKILL');
    await waitForJob(jobManager, job.jobId, isJobEnded);
    expect(exits).toEqual([{ jobId: job.jobId, jobKind: 'AUDIT', exitCode: null, signal: 'SIGKILL' }]);
  }, TEST_TIMEOUT_MS);

  it('does not pass the end of a worker that sent its result', async () => {
    const exits: unknown[] = [];
    const { jobManager, job, scripted } = await startScriptedJob({ ipcDrainWaitMs: DRAIN_TEST_WAIT_MS }, (event) => exits.push(event));
    const child = scripted[0];
    child?.deliver(SCRIPTED_READY);
    child?.deliver(SCRIPTED_RUN_STARTED);
    child?.deliver(SCRIPTED_FINISHED);
    endScripted(child);
    expect(await waitForJob(jobManager, job.jobId, isJobEnded)).toMatchObject({ state: 'FINISHED' });
    expect(exits).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

