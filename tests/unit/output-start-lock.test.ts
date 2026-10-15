// T24c（DEF-057。Task 24 の設計書 4.6）: 出力先の開始のロック。
// - 配置: 開始のロックのファイル（`OUTPUT_START_LOCK_FILE_NAME`）は、Run のディレクトリの一覧（`listRunDirectories`、
//   `listCheckpointRunDirectories`）に入らない。
// - 書き手: `ArtifactWriter` の開始のロックの作成（`wx`）・書き換え・読み取り・削除。
// - 中核（`executeAuditRun`）: 動いている持ち主の新しい開始のロックは尊重する（`RUN_ACTIVE`、終了コード 4、Run Coordinator を作らない）。古い開始の
//   ロック（持ち主の process が死んでいる、時間を過ぎた、OS の起動の時刻が違う）は取り直して始める。開始のロックは Run のロックができた後に離し、
//   開始の段で例外が起きても、Run を始めない結果で終わっても残らない。
// - CLI（`runAuditCommand`）: 別の起動が開始の段にいるときは、Run の ID のない文を標準エラーに出し、終了コード 4。
// 偽の Run Coordinator（`createRunCoordinator`）で確かめる（Browser を起動しない）。本物の Chromium での 2 つの起動の重なりは
// `tests/integration/output-start-lock.test.ts`。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { executeAuditRun, type AuditRunDependencies, type AuditRunObserver } from '../../src/cli/audit-run.js';
import { RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { joinLines } from '../../src/cli/output.js';
import { runAuditCommand } from '../../src/cli/run-command.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  OUTPUT_START_LOCK_FILE_NAME,
  listCheckpointRunDirectories,
  listRunDirectories,
  outputStartLockPath,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult } from '../../src/core/contracts.js';
import { createRunId } from '../../src/core/ids.js';
import { readPlaywrightVersion, readToolVersion } from '../../src/orchestration/environment.js';
import {
  RUN_LOCK_BOOT_TIME_TOLERANCE_MS,
  RUN_LOCK_STALE_AFTER_MS,
  createRunLock,
  currentProcessRunLockHost,
  isProcessRunning,
  type RunLock,
} from '../../src/orchestration/run-checkpoint.js';
import type { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import { RunDirectoryUnavailableError, type RunCoordinatorDependencies } from '../../src/orchestration/run-coordinator.js';
import { activeRunInOutputDirectoryText, startingRunInOutputDirectoryText } from '../../src/presentation/messages.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { auditRun, FIXTURE_ORIGIN, FIXTURE_RUN_ID } from '../helpers/audit-run-fixture.js';
import { sampleRunCheckpoint, sampleRunCheckpointPage } from '../helpers/run-checkpoint-samples.js';
import { captureCliOutput } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

let workDirectory: string;
let caseNumber = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-output-start-lock-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

/** テストごとに別の出力先に書く設定（見本の保存と同じ対象と開始の URL）。 */
function newConfig(): AuditConfig {
  caseNumber += 1;
  return createTestConfig(FIXTURE_ORIGIN, '/', { output: { directory: join(workDirectory, `case-${caseNumber}`) } });
}

const failingLaunch = async (): Promise<never> => {
  throw new Error('browser launch is not allowed in this test');
};

/** 今のプロセスの、今の時刻の Run のロックの形の値（動いている持ち主の新しいロック）。 */
const liveLock = (): RunLock => createRunLock(currentProcessRunLockHost(Date.now()));

/** 終わったプロセスの ID（子のプロセスを起動して、終わるのを待つ）。 */
function deadProcessId(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined || isProcessRunning(child.pid)) {
    throw new Error('could not get the ID of a finished process');
  }
  return child.pid;
}

/** 偽の Run Coordinator の `run()`（CLI が作った保存のセッションと、Run Coordinator に渡した依存を受け取る）。 */
type FakeRun = (input: { readonly session: RunCheckpointSession; readonly dependencies: RunCoordinatorDependencies }) => Promise<AuditRunResult>;

/** 偽の Run Coordinator を使う依存。`created` は、Run Coordinator を作った回数の記録。 */
function fakeDependencies(run: FakeRun = async () => auditRun()): {
  readonly dependencies: AuditRunDependencies;
  readonly created: RunCoordinatorDependencies[];
} {
  const created: RunCoordinatorDependencies[] = [];
  return {
    created,
    dependencies: {
      launchBrowser: failingLaunch,
      clock: () => new Date(),
      now: () => Date.now(),
      createRunCoordinator: (dependencies) => {
        created.push(dependencies);
        const session = dependencies.checkpointSession as RunCheckpointSession;
        return { run: async () => await run({ session, dependencies }), checkpointConclusion: () => ({ action: 'NONE' }) };
      },
    },
  };
}

/** 偽の `run()`: 開始のロックのファイルの有無を、保存のセッションを始める前と後で記録し、新しい Run として始めてから、見本の Run を返す。 */
function recordingStartingRun(outputDirectory: string, record: { before?: unknown; afterExists?: boolean }): FakeRun {
  return async ({ session }) => {
    record.before = JSON.parse(await readFile(outputStartLockPath(outputDirectory), 'utf8')) as unknown;
    const runDirectory = runArtifactDirectory(outputDirectory, createRunId(20261009000000));
    await mkdir(runDirectory, { recursive: true });
    await expect(session.start(runDirectory, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });
    record.afterExists = existsSync(outputStartLockPath(outputDirectory));
    return auditRun();
  };
}

/** 呼ばれた観測の口の名前の記録。 */
function recordingObserver(): { readonly observer: AuditRunObserver; readonly hooks: string[] } {
  const hooks: string[] = [];
  return {
    hooks,
    observer: {
      onRunStarting: () => hooks.push('onRunStarting'),
      onRunStarted: () => hooks.push('onRunStarted'),
      onProgress: () => hooks.push('onProgress'),
      onNotice: () => hooks.push('onNotice'),
    },
  };
}

/** 出力先に、開始のロックのファイルを置く（`ArtifactWriter` で、`wx` で作る）。 */
async function placeStartLock(outputDirectory: string, lock: object): Promise<void> {
  await expect(new ArtifactWriter().acquireOutputStartLock(outputDirectory, lock)).resolves.toMatchObject({ acquired: true });
}

describe('the layout of the output start lock', () => {
  it('is a dot file directly under the output directory', () => {
    expect(OUTPUT_START_LOCK_FILE_NAME.startsWith('.')).toBe(true);
    expect(outputStartLockPath(join('out', 'dir'))).toBe(join('out', 'dir', OUTPUT_START_LOCK_FILE_NAME));
  });

  it('is not listed as a run directory, as a file or even as a directory', async () => {
    const outputDirectory = newConfig().output.directory;
    const runDirectory = runArtifactDirectory(outputDirectory, FIXTURE_RUN_ID);
    await new ArtifactWriter().writeCheckpointState(runDirectory, sampleRunCheckpoint());
    await placeStartLock(outputDirectory, liveLock());

    expect(await listRunDirectories(outputDirectory)).toEqual([{ runId: FIXTURE_RUN_ID, runDirectory }]);
    expect(await listCheckpointRunDirectories(outputDirectory)).toEqual([{ runId: FIXTURE_RUN_ID, runDirectory }]);

    const otherOutput = newConfig().output.directory;
    await mkdir(join(otherOutput, OUTPUT_START_LOCK_FILE_NAME), { recursive: true });
    expect(await listRunDirectories(otherOutput)).toEqual([]);
  });
});

describe('ArtifactWriter: the output start lock', () => {
  it('creates the lock exclusively (creating the output directory), reads, rewrites and releases it', async () => {
    const writer = new ArtifactWriter();
    const outputDirectory = join(newConfig().output.directory, 'nested');
    const first = liveLock();
    const second: RunLock = { ...first, acquiredAtMs: first.acquiredAtMs + 1, heartbeatAtMs: first.heartbeatAtMs + 1 };

    await expect(writer.acquireOutputStartLock(outputDirectory, first)).resolves.toEqual({ acquired: true, createdDirectory: expect.any(String) });
    await expect(writer.acquireOutputStartLock(outputDirectory, second)).resolves.toEqual({ acquired: false, existing: first });
    await expect(writer.readOutputStartLock(outputDirectory)).resolves.toEqual(first);
    await writer.rewriteOutputStartLock(outputDirectory, second);
    await expect(writer.readOutputStartLock(outputDirectory)).resolves.toEqual(second);
    await writer.releaseOutputStartLock(outputDirectory);
    expect(existsSync(outputStartLockPath(outputDirectory))).toBe(false);
    await expect(writer.readOutputStartLock(outputDirectory)).resolves.toBeNull();
    await expect(writer.releaseOutputStartLock(outputDirectory)).resolves.toBeUndefined();
  });

  it('returns the first directory it created for the output directory, or null when the output directory exists', async () => {
    const writer = new ArtifactWriter();
    const parent = newConfig().output.directory;
    const outputDirectory = join(parent, 'a', 'b');

    const created = await writer.acquireOutputStartLock(outputDirectory, liveLock());
    expect(created).toEqual({ acquired: true, createdDirectory: parent });
    await writer.releaseOutputStartLock(outputDirectory);
    await expect(writer.acquireOutputStartLock(outputDirectory, liveLock())).resolves.toEqual({ acquired: true, createdDirectory: null });
  });

  it('removes the directories it created only while they are empty, from the output directory up to the created one', async () => {
    const writer = new ArtifactWriter();
    const emptyParent = newConfig().output.directory;
    const emptyOutput = join(emptyParent, 'a', 'b');
    await writer.acquireOutputStartLock(emptyOutput, liveLock());
    await writer.releaseOutputStartLock(emptyOutput, emptyParent);
    expect(existsSync(emptyParent)).toBe(false);
    expect(existsSync(workDirectory)).toBe(true);

    const usedParent = newConfig().output.directory;
    const usedOutput = join(usedParent, 'a', 'b');
    await writer.acquireOutputStartLock(usedOutput, liveLock());
    const runDirectory = runArtifactDirectory(usedOutput, FIXTURE_RUN_ID);
    await mkdir(runDirectory);
    await writer.releaseOutputStartLock(usedOutput, usedParent);
    expect(existsSync(outputStartLockPath(usedOutput))).toBe(false);
    expect(existsSync(runDirectory)).toBe(true);
  });

  it('rejects an empty output directory without touching any file', async () => {
    const writer = new ArtifactWriter();
    await expect(writer.acquireOutputStartLock('', liveLock())).rejects.toBeInstanceOf(TypeError);
    await expect(writer.rewriteOutputStartLock('', liveLock())).rejects.toBeInstanceOf(TypeError);
    await expect(writer.readOutputStartLock('')).rejects.toBeInstanceOf(TypeError);
    await expect(writer.releaseOutputStartLock('')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('executeAuditRun: the output start lock held by another start', () => {
  it('respects a fresh start lock of a running process: RUN_ACTIVE without a run ID, exit code 4, no Run Coordinator, lock kept', async () => {
    const config = newConfig();
    const othersLock = liveLock();
    await placeStartLock(config.output.directory, othersLock);
    const { dependencies, created } = fakeDependencies();
    const { observer, hooks } = recordingObserver();

    const outcome = await executeAuditRun(config, dependencies, { startNew: false }, observer);

    expect(outcome).toEqual({ kind: 'RUN_ACTIVE', activeRunId: null, exitCode: RUN_UNAVAILABLE_EXIT_CODE });
    expect(created).toHaveLength(0);
    expect(hooks).toEqual([]);
    await expect(new ArtifactWriter().readOutputStartLock(config.output.directory)).resolves.toEqual(othersLock);
  });

  it('reports the running Run when there is also one (the same RUN_ACTIVE as without the start lock)', async () => {
    const config = newConfig();
    const activeRunId = createRunId(20261001000000);
    await new ArtifactWriter().acquireRunLock(runArtifactDirectory(config.output.directory, activeRunId), liveLock());
    await placeStartLock(config.output.directory, liveLock());
    const { dependencies, created } = fakeDependencies();

    const outcome = await executeAuditRun(config, dependencies, { startNew: true });

    expect(outcome).toEqual({ kind: 'RUN_ACTIVE', activeRunId, exitCode: RUN_UNAVAILABLE_EXIT_CODE });
    expect(created).toHaveLength(0);
  });

  it('prints the text without a run ID to stderr and exits with code 4 in the CLI', async () => {
    const config = newConfig();
    await placeStartLock(config.output.directory, liveLock());
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const exitCode = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, fakeDependencies().dependencies);

    expect(exitCode).toBe(RUN_UNAVAILABLE_EXIT_CODE);
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe(joinLines([startingRunInOutputDirectoryText]));
  });

  it('keeps the existing text with the run ID when a Run is running', async () => {
    const config = newConfig();
    const activeRunId = createRunId(20261001000000);
    await new ArtifactWriter().acquireRunLock(runArtifactDirectory(config.output.directory, activeRunId), liveLock());
    const stderr = captureCliOutput();

    const exitCode = await runAuditCommand(config, { stdout: captureCliOutput().output, stderr: stderr.output }, fakeDependencies().dependencies);

    expect(exitCode).toBe(RUN_UNAVAILABLE_EXIT_CODE);
    expect(stderr.text()).toBe(joinLines([activeRunInOutputDirectoryText(activeRunId)]));
  });
});

describe('executeAuditRun: a stale output start lock is taken over', () => {
  const nowMs = Date.now();
  const host = currentProcessRunLockHost(nowMs);
  const staleLocks: readonly { readonly name: string; readonly lock: () => RunLock }[] = [
    { name: 'the owner process has finished', lock: () => ({ ...createRunLock(host), processId: deadProcessId() }) },
    {
      name: 'the lock is older than RUN_LOCK_STALE_AFTER_MS',
      lock: () => createRunLock({ ...host, nowMs: nowMs - RUN_LOCK_STALE_AFTER_MS - 1 }),
    },
    {
      name: 'the boot time differs by more than RUN_LOCK_BOOT_TIME_TOLERANCE_MS',
      // OS の起動の時刻は `os.uptime()` から求めるので、読むたびに秒の単位でずれうる。許す差の 2 倍ずらす。
      lock: () => createRunLock({ ...host, bootedAtMs: host.bootedAtMs - 2 * RUN_LOCK_BOOT_TIME_TOLERANCE_MS }),
    },
    { name: 'the lock is not JSON of a run lock', lock: () => ({ broken: true }) as unknown as RunLock },
  ];

  it.each(staleLocks)('when $name: starts the Run with its own lock, and releases it after the run lock is made', async ({ lock }) => {
    const config = newConfig();
    const outputDirectory = config.output.directory;
    await placeStartLock(outputDirectory, lock());
    const record: { before?: unknown; afterExists?: boolean } = {};
    const { dependencies, created } = fakeDependencies(recordingStartingRun(outputDirectory, record));

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(outcome.kind).toBe('RAN');
    expect(created).toHaveLength(1);
    expect(record.before).toMatchObject({ processId: process.pid });
    expect(record.afterExists).toBe(false);
    expect(existsSync(outputStartLockPath(outputDirectory))).toBe(false);
  });
});

describe('executeAuditRun: the output start lock is held only during the start phase and never remains', () => {
  it('holds its own lock until the checkpoint session makes the run lock, then releases it', async () => {
    const config = newConfig();
    const record: { before?: unknown; afterExists?: boolean } = {};
    const { dependencies } = fakeDependencies(recordingStartingRun(config.output.directory, record));
    const before = Date.now();

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(outcome.kind).toBe('RAN');
    expect(record.before).toMatchObject({ processId: process.pid });
    expect((record.before as RunLock).acquiredAtMs).toBeGreaterThanOrEqual(before);
    expect(record.afterExists).toBe(false);
    expect(existsSync(outputStartLockPath(config.output.directory))).toBe(false);
  });

  const failures: readonly { readonly name: string; readonly dependencies: () => AuditRunDependencies }[] = [
    {
      name: 'creating the Run Coordinator throws',
      dependencies: () => ({
        ...fakeDependencies().dependencies,
        createRunCoordinator: () => {
          throw new Error('the Run Coordinator could not be created');
        },
      }),
    },
    {
      name: 'the Run rejects before the checkpoint session starts',
      dependencies: () => fakeDependencies(async () => {
        throw new Error('the Run failed before the run lock');
      }).dependencies,
    },
    {
      name: 'the checkpoint session start rejects',
      dependencies: () => fakeDependencies(async ({ session }) => {
        await session.start('', { mode: 'NEW_RUN' });
        return auditRun();
      }).dependencies,
    },
  ];

  it.each(failures)('does not leave the start lock when $name', async ({ dependencies }) => {
    const config = newConfig();

    await expect(executeAuditRun(config, dependencies(), { startNew: false })).rejects.toBeInstanceOf(Error);

    expect(existsSync(outputStartLockPath(config.output.directory))).toBe(false);
  });

  it('does not leave the start lock when the Run does not start (a running Run, RUN_DIRECTORY_UNAVAILABLE, VERSION_MISMATCH)', async () => {
    const active = newConfig();
    await new ArtifactWriter().acquireRunLock(runArtifactDirectory(active.output.directory, createRunId(20261001000000)), liveLock());
    expect((await executeAuditRun(active, fakeDependencies().dependencies, { startNew: false })).kind).toBe('RUN_ACTIVE');
    expect(existsSync(outputStartLockPath(active.output.directory))).toBe(false);

    const unavailable = newConfig();
    const result = auditRun();
    const runDirectory = runArtifactDirectory(unavailable.output.directory, result.run.runId);
    const directoryUnavailable = fakeDependencies(async () => {
      throw new RunDirectoryUnavailableError({ result, runDirectory, alreadyExists: true, cause: new Error('EEXIST') });
    });
    expect((await executeAuditRun(unavailable, directoryUnavailable.dependencies, { startNew: false })).kind).toBe('RUN_DIRECTORY_UNAVAILABLE');
    expect(existsSync(outputStartLockPath(unavailable.output.directory))).toBe(false);

    const versionDiffers = newConfig();
    const writer = new ArtifactWriter();
    const checkpointRunDirectory = runArtifactDirectory(versionDiffers.output.directory, FIXTURE_RUN_ID);
    const checkpoint = sampleRunCheckpoint({ startPageFinished: true });
    const executions = checkpoint.executions.map((execution) => ({
      ...execution,
      environment: { ...execution.environment, playwrightVersion: readPlaywrightVersion() },
    }));
    await writer.writeCheckpointPage(checkpointRunDirectory, sampleRunCheckpointPage());
    await writer.writeCheckpointState(checkpointRunDirectory, { ...checkpoint, executions, toolVersion: `${await readToolVersion()}-other` });
    expect((await executeAuditRun(versionDiffers, fakeDependencies().dependencies, { startNew: false })).kind).toBe('VERSION_MISMATCH');
    expect(existsSync(outputStartLockPath(versionDiffers.output.directory))).toBe(false);
  });

  it('does not release a start lock taken over by another start', async () => {
    const config = newConfig();
    const othersLock: RunLock = { ...liveLock(), acquiredAtMs: 1, heartbeatAtMs: Date.now() };
    const { dependencies } = fakeDependencies(async () => {
      // 開始の段の途中で、別の起動が開始のロックを取り直した（自分のものでなくなった）。
      await new ArtifactWriter().rewriteOutputStartLock(config.output.directory, othersLock);
      return auditRun();
    });

    expect((await executeAuditRun(config, dependencies, { startNew: false })).kind).toBe('RAN');

    await expect(new ArtifactWriter().readOutputStartLock(config.output.directory)).resolves.toEqual(othersLock);
  });

  it('does not leave the output directory that it created for the start lock when the Run does not start', async () => {
    const config = newConfig();
    const { dependencies } = fakeDependencies(async () => {
      throw new Error('the Run failed before the run directory');
    });

    await expect(executeAuditRun(config, dependencies, { startNew: false })).rejects.toBeInstanceOf(Error);

    expect(existsSync(config.output.directory)).toBe(false);
  });

  // DEF-081（CCX-6）: 古い開始のロックの取り直しが `CHANGED`（前の持ち主が、ロックと、自分で作った空の出力先を消した）になった後の
  // 作り直しで、出力先を作り直した場合も、Run を始めずに終われば、作り直した出力先を残さない（ワーカーの Run と同じ）。
  it('does not leave the output directory that it re-created while taking over a stale start lock when the Run does not start', async () => {
    const config = newConfig();
    const outputDirectory = config.output.directory;
    await placeStartLock(outputDirectory, { ...createRunLock(currentProcessRunLockHost(Date.now())), processId: deadProcessId() });
    const takeOver = vi.spyOn(ArtifactWriter.prototype, 'takeOverOutputStartLock').mockImplementation(async () => {
      // 前の持ち主が、開始のロックと、そのために作った空の出力先を消した（取り直しは、判定した古いロックを見つけられない）。
      await rm(outputDirectory, { recursive: true, force: true });
      return { outcome: 'CHANGED' };
    });
    const { dependencies } = fakeDependencies(async () => {
      throw new Error('the Run failed before the run directory');
    });

    let takeOverCalls: number;
    try {
      await expect(executeAuditRun(config, dependencies, { startNew: false })).rejects.toBeInstanceOf(Error);
    } finally {
      takeOverCalls = takeOver.mock.calls.length;
      takeOver.mockRestore();
    }

    expect(takeOverCalls).toBe(1);
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it('keeps the output directory that it created when the Run made its run directory', async () => {
    const config = newConfig();
    const record: { before?: unknown; afterExists?: boolean } = {};
    const { dependencies } = fakeDependencies(recordingStartingRun(config.output.directory, record));

    expect((await executeAuditRun(config, dependencies, { startNew: false })).kind).toBe('RAN');

    expect((await listRunDirectories(config.output.directory)).length).toBeGreaterThan(0);
  });

  it('runs as before without the start lock when the output directory cannot be created (the same RUN_DIRECTORY_UNAVAILABLE)', async () => {
    const config = newConfig();
    // 出力先のパスがファイル（出力先も開始のロックも作れない）。
    await mkdir(workDirectory, { recursive: true });
    await writeFile(config.output.directory, 'not a directory');
    const result = auditRun();
    const runDirectory = runArtifactDirectory(config.output.directory, result.run.runId);
    const { dependencies, created } = fakeDependencies(async () => {
      throw new RunDirectoryUnavailableError({ result, runDirectory, alreadyExists: false, cause: new Error('ENOTDIR') });
    });

    const outcome = await executeAuditRun(config, dependencies, { startNew: false });

    expect(outcome.kind).toBe('RUN_DIRECTORY_UNAVAILABLE');
    expect(created).toHaveLength(1);
  });
});
