// CCX-6（共通化の台帳の CC-070）・SPEC-2: ワーカーの Run（発見 `DISCOVERY`、READ の確かめ `READ_CHECK` など）の始め方（`startWorkerRun`）と
// 終わり方（`endWorkerRun`）。出力先の監査中の印は、CLI の監査と同じ部品（`src/core/run-exclusion.ts`）で取る。
// - 印は Run の終わり（`endWorkerRun`）まで持ち、終われば離す。ほかの起動が持っていれば `RUN_ACTIVE`。
// - 出力先を作れなければ、Run のディレクトリを作れずに `RUN_DIRECTORY_UNAVAILABLE`。印を持てたかを決められなければ、Run を始めない（止まる側。
//   差し替えで作る）。
// - Run を始めずに終われば、印を離す。
// Browser は起動しない（Run の始め方と終わり方だけ）。本物のパイプを使うので、sandbox の外で流す。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { listRunDirectories } from '../../src/core/artifact-layout.js';
import { acquireRunExclusion, type RunExclusion } from '../../src/core/run-exclusion.js';
import { endWorkerRun, startWorkerRun } from '../../src/worker/worker-run-session.js';

/** 印を持てたかを決められない場面（`UNAVAILABLE`）を作る差し替え。`cause` が `undefined` なら本物の `acquireRunExclusion` のまま。 */
const exclusionFailure = vi.hoisted(() => ({ cause: undefined as Error | undefined }));
vi.mock('../../src/core/run-exclusion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/run-exclusion.js')>();
  return {
    ...actual,
    acquireRunExclusion: async (outputDirectory: string, targetId: string): Promise<RunExclusion> => exclusionFailure.cause === undefined
      ? await actual.acquireRunExclusion(outputDirectory, targetId)
      : Object.freeze<RunExclusion>({ kind: 'UNAVAILABLE', cause: exclusionFailure.cause }),
  };
});

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

const clock = (): Date => new Date();

/** 印の対象の ID（設定の `target.id`。PAR-a）。 */
const TARGET_ID = 'test-target';

/** 取った排他を離す（取れたときだけ）。 */
async function releaseIfAcquired(exclusion: RunExclusion): Promise<void> {
  if (exclusion.kind === 'ACQUIRED') {
    await exclusion.release();
  }
}

/** 出力先の印が、今は誰にも持たれていないか（取れたら、すぐ離す）。 */
async function isFree(outputDirectory: string): Promise<boolean> {
  const exclusion = await acquireRunExclusion(outputDirectory, TARGET_ID);
  await releaseIfAcquired(exclusion);
  return exclusion.kind === 'ACQUIRED';
}

describe('startWorkerRun and endWorkerRun: the exclusion of the output directory (SPEC-2)', () => {
  it('starts a Run holding the exclusion until endWorkerRun releases it', async () => {
    const outputDirectory = newOutputDirectory();

    const run = await startWorkerRun(outputDirectory, TARGET_ID,clock);

    expect(run.kind).toBe('STARTED');
    if (run.kind !== 'STARTED') {
      return;
    }
    expect(await isFree(outputDirectory)).toBe(false);
    expect(await listRunDirectories(outputDirectory)).toEqual([{ runId: run.runId, runDirectory: run.runDirectory }]);

    await endWorkerRun(run);

    expect(await isFree(outputDirectory)).toBe(true);
  });

  it('respects the exclusion held by another start: RUN_ACTIVE, exit code 4, no Run', async () => {
    const outputDirectory = newOutputDirectory();
    const other = await acquireRunExclusion(outputDirectory, TARGET_ID);
    try {
      const run = await startWorkerRun(outputDirectory, TARGET_ID,clock);

      expect(run).toEqual({ kind: 'RUN_ACTIVE', exitCode: RUN_UNAVAILABLE_EXIT_CODE });
      expect(await listRunDirectories(outputDirectory)).toEqual([]);
    } finally {
      await releaseIfAcquired(other);
    }
  });

  // DEF-281: 同じ出力先で同じ秒に始めた 2 つ目の Run は、2 桁の連番を足した別の Run の ID で始まる（前の Run のディレクトリは変えない）。
  it('starts a second Run in the same second under the run ID with a two-digit suffix', async () => {
    const outputDirectory = newOutputDirectory();
    const sameSecond = (): Date => new Date('2026-11-17T01:02:03.000Z');
    const first = await startWorkerRun(outputDirectory, TARGET_ID,sameSecond);
    if (first.kind !== 'STARTED') throw new Error(`the first Run did not start: ${first.kind}`);
    await endWorkerRun(first);

    const second = await startWorkerRun(outputDirectory, TARGET_ID,sameSecond);

    expect(second).toMatchObject({ kind: 'STARTED', runId: `${first.runId}01` });
    if (second.kind === 'STARTED') await endWorkerRun(second);
    expect((await listRunDirectories(outputDirectory)).map(({ runId }) => runId)).toEqual([first.runId, `${first.runId}01`]);
  });

  it('returns RUN_DIRECTORY_UNAVAILABLE (FAILED) when the output directory cannot be created', async () => {
    const outputDirectory = newOutputDirectory();
    // 出力先のパスがファイル（出力先を作れない）。
    await writeFile(outputDirectory, 'not a directory');

    const run = await startWorkerRun(outputDirectory, TARGET_ID,clock);

    expect(run).toMatchObject({ kind: 'RUN_DIRECTORY_UNAVAILABLE', runStatus: 'FAILED' });
  });

  it('does not start the Run when it cannot tell whether it holds the exclusion (fail-closed)', async () => {
    const outputDirectory = newOutputDirectory();
    const failure = new Error('the exclusion cannot be made');
    exclusionFailure.cause = failure;
    try {
      await expect(startWorkerRun(outputDirectory, TARGET_ID,clock)).rejects.toBe(failure);
    } finally {
      exclusionFailure.cause = undefined;
    }
  });

  it('releases the exclusion when the start fails before the run directory', async () => {
    const outputDirectory = newOutputDirectory();
    // 不正な開始の時刻（Run の ID を作れずに `RangeError`。Run のディレクトリを作る前に終わる）。
    const invalidClock = (): Date => new Date(Number.NaN);

    await expect(startWorkerRun(outputDirectory, TARGET_ID,invalidClock)).rejects.toBeInstanceOf(RangeError);

    expect(await isFree(outputDirectory)).toBe(true);
  });
});
