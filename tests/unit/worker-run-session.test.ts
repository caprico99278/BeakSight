// CCX-6（共通化の台帳の CC-070）: ワーカーの Run（発見 `DISCOVERY`、READ の確かめ `READ_CHECK`）の始め方（`startWorkerRun`）の振る舞いを固定する。
// 出力先の開始のロックと、動いている Run の確かめを、CLI の監査と同じ部品（`src/orchestration/output-start-lock.ts`）にまとめる前後で、
// 同じ結果になることを確かめる。
// - 開始のロックは、Run のロックを取るまでだけ持ち、終われば残さない。動いている持ち主の新しい開始のロックは尊重する（`RUN_ACTIVE`）。
// - 古い開始のロック（持ち主の process が終わった、中身が壊れた）は取り直す。取り直しの途中で出力先を作り直しても、Run を始めずに
//   終われば、作り直した出力先を残さない（DEF-081 で CLI をこちらに揃える）。
// - 出力先を作れなければ、開始のロックなしで進め、Run のディレクトリを作れずに `RUN_DIRECTORY_UNAVAILABLE`。
// - 別の起動が取り直した開始のロックは消さない。
// Browser は起動しない（Run の始め方と終わり方だけ）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { listRunDirectories, outputStartLockPath, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import { createRunId } from '../../src/core/ids.js';
import {
  createRunLock,
  currentProcessRunLockHost,
  isOwnRunLock,
  isProcessRunning,
  type RunLock,
} from '../../src/core/process-lock.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { endWorkerRun, startWorkerRun } from '../../src/worker/worker-run-session.js';

let workDirectory: string;
let caseNumber = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-worker-run-session-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

/** テストごとに別の出力先（まだない）。 */
function newOutputDirectory(): string {
  caseNumber += 1;
  return join(workDirectory, `case-${caseNumber}`);
}

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

const clock = (): Date => new Date();
const now = (): number => Date.now();

/** 出力先に、開始のロックのファイルを置く（`ArtifactWriter` で、`wx` で作る）。 */
async function placeStartLock(outputDirectory: string, lock: object): Promise<void> {
  await expect(new ArtifactWriter().acquireOutputStartLock(outputDirectory, lock)).resolves.toMatchObject({ acquired: true });
}

/** Run のロックを取る直前に、出力先の開始のロックの中身を記録する書き手（開始のロックを Run のロックまで持つことの確かめ）。 */
class RecordingWriter extends ArtifactWriter {
  readonly startLocksBeforeRunLock: unknown[] = [];
  readonly #outputDirectory: string;
  readonly #beforeRunLock: (() => Promise<void>) | undefined;

  constructor(outputDirectory: string, beforeRunLock?: () => Promise<void>) {
    super();
    this.#outputDirectory = outputDirectory;
    this.#beforeRunLock = beforeRunLock;
  }

  override async acquireRunLock(runDirectory: string, lock: object): ReturnType<ArtifactWriter['acquireRunLock']> {
    this.startLocksBeforeRunLock.push(await this.readOutputStartLock(this.#outputDirectory));
    await this.#beforeRunLock?.();
    return await super.acquireRunLock(runDirectory, lock);
  }
}

describe('startWorkerRun: the output start lock and the running Run (fixed before CCX-6)', () => {
  it('starts a Run holding its own start lock until the run lock is made, then releases it; endWorkerRun releases the run lock', async () => {
    const outputDirectory = newOutputDirectory();
    const writer = new RecordingWriter(outputDirectory);
    const before = Date.now();

    const run = await startWorkerRun(writer, outputDirectory, clock, now);

    expect(run.kind).toBe('STARTED');
    if (run.kind !== 'STARTED') {
      return;
    }
    expect(writer.startLocksBeforeRunLock).toHaveLength(1);
    expect(writer.startLocksBeforeRunLock[0]).toMatchObject({ processId: process.pid });
    expect((writer.startLocksBeforeRunLock[0] as RunLock).acquiredAtMs).toBeGreaterThanOrEqual(before);
    expect(existsSync(outputStartLockPath(outputDirectory))).toBe(false);
    expect(await listRunDirectories(outputDirectory)).toEqual([{ runId: run.runId, runDirectory: run.runDirectory }]);
    await expect(writer.readRunLock(run.runDirectory)).resolves.toMatchObject({ processId: process.pid });

    await endWorkerRun(writer, run);

    await expect(writer.readRunLock(run.runDirectory)).resolves.toBeNull();
  });

  it('respects a fresh start lock of a running process: RUN_ACTIVE without a run ID, exit code 4, lock kept, no Run', async () => {
    const outputDirectory = newOutputDirectory();
    const othersLock = liveLock();
    await placeStartLock(outputDirectory, othersLock);

    const run = await startWorkerRun(new ArtifactWriter(), outputDirectory, clock, now);

    expect(run).toEqual({ kind: 'RUN_ACTIVE', activeRunId: null, exitCode: RUN_UNAVAILABLE_EXIT_CODE });
    await expect(new ArtifactWriter().readOutputStartLock(outputDirectory)).resolves.toEqual(othersLock);
    expect(await listRunDirectories(outputDirectory)).toEqual([]);
  });

  it('reports the running Run when the start lock is held and a Run is running', async () => {
    const outputDirectory = newOutputDirectory();
    const activeRunId = createRunId(20261001000000);
    await new ArtifactWriter().acquireRunLock(runArtifactDirectory(outputDirectory, activeRunId), liveLock());
    await placeStartLock(outputDirectory, liveLock());

    const run = await startWorkerRun(new ArtifactWriter(), outputDirectory, clock, now);

    expect(run).toEqual({ kind: 'RUN_ACTIVE', activeRunId, exitCode: RUN_UNAVAILABLE_EXIT_CODE });
  });

  it('does not start when a Run is running, and does not leave the start lock', async () => {
    const outputDirectory = newOutputDirectory();
    const activeRunId = createRunId(20261001000000);
    await new ArtifactWriter().acquireRunLock(runArtifactDirectory(outputDirectory, activeRunId), liveLock());

    const run = await startWorkerRun(new ArtifactWriter(), outputDirectory, clock, now);

    expect(run).toEqual({ kind: 'RUN_ACTIVE', activeRunId, exitCode: RUN_UNAVAILABLE_EXIT_CODE });
    expect(existsSync(outputStartLockPath(outputDirectory))).toBe(false);
    expect((await listRunDirectories(outputDirectory)).map(({ runId }) => runId)).toEqual([activeRunId]);
  });

  it('ignores a stale run lock of a finished process and starts a new Run', async () => {
    const outputDirectory = newOutputDirectory();
    const staleRunId = createRunId(20261001000000);
    await new ArtifactWriter().acquireRunLock(runArtifactDirectory(outputDirectory, staleRunId), { ...liveLock(), processId: deadProcessId() });

    const run = await startWorkerRun(new ArtifactWriter(), outputDirectory, clock, now);

    expect(run.kind).toBe('STARTED');
    if (run.kind === 'STARTED') {
      await endWorkerRun(new ArtifactWriter(), run);
    }
  });

  const staleLocks: readonly { readonly name: string; readonly lock: () => object }[] = [
    { name: 'the owner process has finished', lock: () => ({ ...liveLock(), processId: deadProcessId() }) },
    { name: 'the lock is not JSON of a run lock', lock: () => ({ broken: true }) },
  ];

  it.each(staleLocks)('takes over a stale start lock when $name, starts the Run and releases the start lock', async ({ lock }) => {
    const outputDirectory = newOutputDirectory();
    await placeStartLock(outputDirectory, lock());
    const writer = new RecordingWriter(outputDirectory);

    const run = await startWorkerRun(writer, outputDirectory, clock, now);

    expect(run.kind).toBe('STARTED');
    expect(writer.startLocksBeforeRunLock[0]).toMatchObject({ processId: process.pid });
    expect(existsSync(outputStartLockPath(outputDirectory))).toBe(false);
    if (run.kind === 'STARTED') {
      await endWorkerRun(writer, run);
    }
  });

  it('runs without the start lock when the output directory cannot be created (RUN_DIRECTORY_UNAVAILABLE, FAILED)', async () => {
    const outputDirectory = newOutputDirectory();
    // 出力先のパスがファイル（出力先も開始のロックも作れない）。
    await writeFile(outputDirectory, 'not a directory');

    const run = await startWorkerRun(new ArtifactWriter(), outputDirectory, clock, now);

    expect(run).toMatchObject({ kind: 'RUN_DIRECTORY_UNAVAILABLE', runStatus: 'FAILED' });
  });

  it('does not release a start lock taken over by another start', async () => {
    const outputDirectory = newOutputDirectory();
    const othersLock: RunLock = { ...liveLock(), acquiredAtMs: 1, heartbeatAtMs: Date.now() };
    const writer = new RecordingWriter(outputDirectory, async () => {
      // 開始の段の途中で、別の起動が開始のロックを取り直した（自分のものでなくなった）。
      await new ArtifactWriter().rewriteOutputStartLock(outputDirectory, othersLock);
    });

    const run = await startWorkerRun(writer, outputDirectory, clock, now);

    expect(run.kind).toBe('STARTED');
    await expect(new ArtifactWriter().readOutputStartLock(outputDirectory)).resolves.toEqual(othersLock);
    expect(isOwnRunLock(await new ArtifactWriter().readOutputStartLock(outputDirectory), othersLock)).toBe(true);
    if (run.kind === 'STARTED') {
      await endWorkerRun(writer, run);
    }
  });

  it('does not leave the output directory that it created for the start lock when the start fails before the run directory', async () => {
    const outputDirectory = newOutputDirectory();
    // 不正な開始の時刻（Run の ID を作れずに `RangeError`。Run のディレクトリを作る前に終わる）。
    const invalidClock = (): Date => new Date(Number.NaN);

    await expect(startWorkerRun(new ArtifactWriter(), outputDirectory, invalidClock, now)).rejects.toBeInstanceOf(RangeError);

    expect(existsSync(outputDirectory)).toBe(false);
  });

  it('does not leave the output directory that it re-created while taking over a stale start lock when the start fails', async () => {
    const outputDirectory = newOutputDirectory();
    await placeStartLock(outputDirectory, { ...liveLock(), processId: deadProcessId() });
    const writer = new ArtifactWriter();
    const takeOver = vi.spyOn(writer, 'takeOverOutputStartLock').mockImplementation(async () => {
      // 前の持ち主が、開始のロックと、そのために作った空の出力先を消した（取り直しは、判定した古いロックを見つけられない）。
      await rm(outputDirectory, { recursive: true, force: true });
      return { outcome: 'CHANGED' };
    });
    // 不正な開始の時刻（Run の ID を作れずに `RangeError`。Run のディレクトリを作る前に終わる）。
    const invalidClock = (): Date => new Date(Number.NaN);

    await expect(startWorkerRun(writer, outputDirectory, invalidClock, now)).rejects.toBeInstanceOf(RangeError);

    expect(takeOver).toHaveBeenCalledTimes(1);
    expect(existsSync(outputDirectory)).toBe(false);
  });
});
