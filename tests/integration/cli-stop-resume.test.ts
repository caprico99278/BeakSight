// R5a（中断した Run の再開の設計書 3.2、4.4、4.7、4.7.1）: `run` のコマンドの再開の流れ。fixture のサイトを 127.0.0.1 で起動し、`runAuditCommand` を
// 同じプロセスで呼ぶ（Chromium はテストの既定の headless だけ）。止める印で k ページ目の後に止めた Run を、同じ設定でもう一度実行すると、同じ Run の
// ディレクトリで続きから監査して終え、`checkpoint/` には `state.json` だけが残り、出力先の監査中の印も残らない。
// SLIM-GROUP（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.4）: 前の `cli-resume.test.ts` の主の場面だけを残した。ほかの場面の置き場:
// - 中断しない Run と同じ結果: `resume-run.test.ts`（R4a2b）。
// - 出力先の実行中の Run（終了コード 4）・process が途中で終わった Run の再開: `tests/unit/output-start-lock.test.ts`・`output-start-lock.test.ts`。
// - 再開しない理由（設定・版・壊れた保存・前の形）: `tests/unit/run-checkpoint*.test.ts`。違反の後の最後の処理（R7c）: `resume-run.test.ts`・単体。
// - Run の後の保存の終わり方（偽の Run Coordinator）: `tests/unit/run-command.test.ts`。
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { EXIT_CODES, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import { runAuditCommand, type RunCommandDependencies } from '../../src/cli/run-command.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  CHECKPOINT_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  checkpointArtifactRelativePath,
  isBundleFileName,
} from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { acquireRunExclusion } from '../../src/core/run-exclusion.js';
import type { RunCheckpoint } from '../../src/orchestration/run-checkpoint.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { formatCount } from '../../src/presentation/format.js';
import { CLI_TEXT, cliCountText, resumingRunText } from '../../src/presentation/messages.js';
import { captureCliOutput, createRunLauncher, fastRunConfig, readJson } from '../helpers/run-harness.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 止める印を付ける前に監査を終えるページの数（k）。 */
const PAGES_BEFORE_STOP = 2;

let server: FixtureServer;
let workDirectory: string;
const runLauncher = createRunLauncher();

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-stop-resume-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Runs').toBe(0);
});

interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(config: AuditConfig, dependencies: RunCommandDependencies): Promise<CommandOutcome> {
  const stdout = captureCliOutput();
  const stderr = captureCliOutput();
  const code = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, dependencies);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** 本物の headless Chromium で Run を行う、`run` の依存。`stopAfterPages` を渡すと、そのページ数を終えたときに止める印を付ける。 */
function realDependencies(stopAfterPages?: number): RunCommandDependencies {
  const base: RunCommandDependencies = { launchBrowser: runLauncher.launcher, clock: () => new Date(), now: () => Date.now() };
  if (stopAfterPages === undefined) {
    return base;
  }
  const controller = new AbortController();
  return {
    ...base,
    stopSignal: controller.signal,
    createRunCoordinator: (dependencies) => new RunCoordinator({
      ...dependencies,
      onProgress: (report) => {
        dependencies.onProgress?.(report);
        if (report.pagesFinished === stopAfterPages) {
          controller.abort();
        }
      },
    }),
  };
}

/** 出力先の直下の、ただ1つの Run のディレクトリ。 */
async function onlyRunDirectoryIn(outputDirectory: string): Promise<string> {
  const names = (await readdir(outputDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name);
  expect(names).toHaveLength(1);
  return join(outputDirectory, names[0] ?? '');
}

/** Run のディレクトリの下のファイルの、`base` からの相対パス（区切りは `/`。名前の順）。 */
async function filesIn(base: string): Promise<string[]> {
  if (!existsSync(base)) {
    return [];
  }
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(base, join(entry.parentPath, entry.name)).split('\\').join('/')).sort();
}

const readState = async (runDirectory: string): Promise<RunCheckpoint> =>
  await readJson(artifactFilePath(runDirectory, checkpointArtifactRelativePath('state'))) as RunCheckpoint;
const readRun = async (runDirectory: string): Promise<RunSummary> =>
  await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;

/** Run のディレクトリの出力先の監査中の印が、今は誰にも持たれていないか（SPEC-2。取れたら、すぐ離す）。 */
async function isExclusionFree(runDirectory: string): Promise<boolean> {
  const exclusion = await acquireRunExclusion(dirname(runDirectory));
  if (exclusion.kind === 'ACQUIRED') {
    await exclusion.release();
  }
  return exclusion.kind === 'ACQUIRED';
}

describe('R5a: a Run stopped by the stop signal is resumed by the same command (resumable run design 4.7, 4.7.1)', () => {
  let stopped: CommandOutcome;
  let stoppedRunDirectory: string;
  let stoppedState: RunCheckpoint;
  let stoppedExclusionFree: boolean;
  let resumed: CommandOutcome;
  let outputDirectory: string;

  beforeAll(async () => {
    outputDirectory = join(workDirectory, 'stop-and-resume');
    const config = fastRunConfig(server.origin, START_PATH, { target: { id: 'cli-stop-resume' }, output: { directory: outputDirectory } });
    stopped = await runCommand(config, realDependencies(PAGES_BEFORE_STOP));
    stoppedRunDirectory = await onlyRunDirectoryIn(outputDirectory);
    stoppedState = await readState(stoppedRunDirectory);
    stoppedExclusionFree = await isExclusionFree(stoppedRunDirectory);
    // 2回目は、同じ設定で、止める印なしで実行する。
    resumed = await runCommand(config, realDependencies());
  }, SUITE_TIMEOUT_MS);

  const resumeLine = (): string => resumingRunText(stoppedState.runId, cliCountText(CLI_TEXT.progress.pagesFinished, formatCount(PAGES_BEFORE_STOP)));

  it('stops the first execution after the k-th page with PARTIAL and leaves a STOPPED checkpoint, releasing the exclusion', () => {
    expect(stopped.code, stopped.stderr).toBe(EXIT_CODES.PARTIAL);
    expect(stoppedState.state).toBe('STOPPED');
    expect(stoppedState.completedPageIds).toHaveLength(PAGES_BEFORE_STOP);
    expect(stoppedExclusionFree).toBe(true);
    // 最初の実行には、再開の知らせがない。
    expect(stopped.stdout).not.toContain(resumeLine());
  });

  it('tells that it resumes the Run with the number of the finished pages before the start lines, and finishes it in the same run directory', async () => {
    const lines = resumed.stdout.split('\n');
    expect(lines.filter((line) => line === resumeLine())).toHaveLength(1);
    expect(lines.indexOf(resumeLine())).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(resumed.stderr).toBe('');
    expect(await onlyRunDirectoryIn(outputDirectory)).toBe(stoppedRunDirectory);
    const run = await readRun(stoppedRunDirectory);
    expect(run.runId).toBe(stoppedState.runId);
    expect(resumed.code).toBe(exitCodeForRunStatus(run.runStatus));
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
  });

  it('leaves only state.json (FINISHED) in checkpoint/ and one bundle, without the page checkpoints and the exclusion', async () => {
    expect(await filesIn(artifactFilePath(stoppedRunDirectory, CHECKPOINT_ARTIFACT_DIRECTORY))).toEqual(['state.json']);
    expect((await readState(stoppedRunDirectory)).state).toBe('FINISHED');
    expect((await filesIn(stoppedRunDirectory)).filter(isBundleFileName)).toHaveLength(1);
    expect(await isExclusionFree(stoppedRunDirectory)).toBe(true);
  });
});
