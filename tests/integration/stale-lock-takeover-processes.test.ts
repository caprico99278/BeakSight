// T24h-2（DEF-060。Task 24 の設計書 4.6。独立レビュー T24R の I1）: 古いロックが残っていても、2 つの CLI の process が同じ中断した Run を
// ほぼ同時に再開すると、1 つだけが再開する。
// - 中断した Run（止める印で止めた STOPPED の保存）を、同じ process の中の CLI（`runCli`、CLI の起動の設定の Chromium）で 1 回だけ作り、
//   回ごとに、その出力先を写してから、古いロックを置く。
//   - 場面 1: 死んだ process の古い開始のロックと、死んだ process の古い Run のロック（強制終了の後に残るもの。レビュー担当の `t24r/e2`）。
//   - 場面 2: 死んだ process の古い Run のロックだけ。
// - 回ごとに、一時ビルドの CLI（`dist/cli/index.js`。CLI の起動の設定の Chromium）を 2 つ同時に起動する。
// - 期待: どの回も、1 つだけが Run を再開し（終了コード 4 以外）、もう 1 つは終了コード 4。回の数は `ROUNDS_PER_SCENARIO`。
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { runCli } from '../../src/cli/main.js';
import {
  artifactFilePath,
  checkpointArtifactRelativePath,
  listRunDirectories,
  outputStartLockPath,
} from '../../src/core/artifact-layout.js';
import type { BrowserLauncher } from '../../src/orchestration/preflight.js';
import { createRunLock, currentProcessRunLockHost, isProcessRunning } from '../../src/core/process-lock.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { launchCliChromium } from '../helpers/chromium.js';
import { runCliProcess, type CliProcessResult } from '../helpers/cli-process.js';
import { captureCliOutput, cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { roundsOf } from '../helpers/test-rounds.js';

/** 場面ごとの回の数（レビュー担当の確かめでは、直す前に 4 回中 1 回、両方が再開した）。値は `test-rounds.ts`（TS-b。ふだんの組と全部の組）。 */
const ROUNDS_PER_SCENARIO = roundsOf('staleLockTakeoverPerScenario');
const SUITE_TIMEOUT_MS = 1_800_000;
const START_PATH = '/crawl/index.html';
/** 中断した Run を作るときに、止める印を付ける前に監査を終えるページの数。 */
const PAGES_BEFORE_STOP = 1;

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;
let configPath: string;
let templateOutput: string;
const launchedBrowsers: Browser[] = [];

const recordingCliLauncher: BrowserLauncher = async () => {
  const browser = await launchCliChromium();
  launchedBrowsers.push(browser);
  return browser;
};

/** 終わった process の ID（子の process を起動して、終わるのを待つ）。 */
function deadProcessId(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  if (child.pid === undefined || isProcessRunning(child.pid)) {
    throw new Error('could not get the ID of a finished process');
  }
  return child.pid;
}

/** 死んだ process の、今の時刻のロック（同じ OS の起動の時刻。持ち主の process が動いていないので古い）。 */
const deadProcessLock = (): object => createRunLock({ ...currentProcessRunLockHost(Date.now()), processId: deadProcessId() });

beforeAll(async () => {
  server = await startFixtureServer();
  build = await buildIntoTemporaryDirectory();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-stale-lock-takeover-'));
  configPath = join(workDirectory, 'target.json');
  templateOutput = join(workDirectory, 'template-output');
  await writeFile(configPath, JSON.stringify(cliTargetConfig('stale-lock-takeover', server.origin, START_PATH, {
    audit: { screenshots: false },
  })), 'utf8');
  // 中断した Run（止める印で止めた STOPPED の保存）を 1 回だけ作る。
  const controller = new AbortController();
  const code = await runCli(
    ['run', '--config', configPath, '--output', templateOutput, '--headless'],
    { stdout: captureCliOutput().output, stderr: captureCliOutput().output },
    {
      run: {
        launchBrowser: recordingCliLauncher,
        clock: () => new Date(),
        now: () => Date.now(),
        stopSignal: controller.signal,
        createRunCoordinator: (dependencies) => new RunCoordinator({
          ...dependencies,
          onProgress: (report) => {
            dependencies.onProgress?.(report);
            if (report.pagesFinished === PAGES_BEFORE_STOP) {
              controller.abort();
            }
          },
        }),
      },
    },
  );
  expect(code).not.toBe(RUN_UNAVAILABLE_EXIT_CODE);
  expect(await listRunDirectories(templateOutput)).toHaveLength(1);
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const connected = launchedBrowsers.filter((browser) => browser.isConnected());
  await Promise.all(connected.map(async (browser) => browser.close().catch(() => undefined)));
  await server?.close();
  await build?.remove();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(connected.length, 'Browsers left connected').toBe(0);
});

const SCENARIOS = [
  { name: 'a stale start lock and a stale run lock of dead processes', plantStartLock: true },
  { name: 'a stale run lock of a dead process', plantStartLock: false },
] as const;

/** 1 回分: 中断した Run を写し、古いロックを置き、2 つの CLI の process を同時に起動する。 */
async function runRound(name: string, round: number, plantStartLock: boolean): Promise<readonly CliProcessResult[]> {
  const output = join(workDirectory, `${name}-${round}`);
  cpSync(templateOutput, output, { recursive: true });
  const [run] = await listRunDirectories(output);
  if (run === undefined) {
    throw new Error('the interrupted Run was not copied');
  }
  await writeFile(artifactFilePath(run.runDirectory, checkpointArtifactRelativePath('lock')), JSON.stringify(deadProcessLock()), 'utf8');
  if (plantStartLock) {
    await writeFile(outputStartLockPath(output), JSON.stringify(deadProcessLock()), 'utf8');
  }
  const arguments_ = ['run', '--config', configPath, '--output', output, '--headless'];
  return await Promise.all([runCliProcess(build, workDirectory, arguments_), runCliProcess(build, workDirectory, arguments_)]);
}

describe.each(SCENARIOS)('DEF-060: two CLI processes resume the same interrupted Run with $name', ({ name, plantStartLock }) => {
  it(`resumes the Run in only one process in each of ${ROUNDS_PER_SCENARIO} rounds; the other exits with code 4`, async () => {
    const tag = plantStartLock ? 'both-locks' : 'run-lock';
    const rounds: { readonly round: number; readonly exitCodes: readonly (number | null)[] }[] = [];
    for (let round = 1; round <= ROUNDS_PER_SCENARIO; round += 1) {
      const results = await runRound(tag, round, plantStartLock);
      rounds.push({ round, exitCodes: results.map(({ status }) => status) });
    }
    const resumedTwice = rounds.filter(({ exitCodes }) => exitCodes.every((code) => code !== RUN_UNAVAILABLE_EXIT_CODE));
    const neitherResumed = rounds.filter(({ exitCodes }) => exitCodes.every((code) => code === RUN_UNAVAILABLE_EXIT_CODE));
    expect({ scenario: name, resumedTwice, neitherResumed }).toEqual({ scenario: name, resumedTwice: [], neitherResumed: [] });
  }, SUITE_TIMEOUT_MS);
});
