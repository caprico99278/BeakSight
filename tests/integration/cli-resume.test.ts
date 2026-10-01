// R5a（中断した Run の再開の設計書 3.2、4.4、4.7、4.7.1）: `run` のコマンドの再開の流れ。fixture のサイトを 127.0.0.1 で起動し、
// `runAuditCommand` を同じプロセスで呼ぶ（Chromium は headless だけ）。
// - 止めて再開: 止める印で k ページ目の後に止めた Run を、同じ設定でもう一度実行すると、同じ Run のディレクトリで続きから監査し、
//   中断しない Run と同じ結果になる。終わった後の `checkpoint/` には `state.json` だけが残り、ロックがない。
// - 出力先の実行中の Run（動いている Run のロック）があれば、`--new` でもなくても、Run を始めない（終了コード 4）。
// - 古いロック（OS の起動の時刻が違う。端末の再起動を模す）の、プロセスが途中で終わった Run は、再開する。
// - 設定が違う途中の Run は、知らせて新しい Run を始める。版が違う途中の Run は、終了コード 4 で終え、`--new` なら新しい Run を始める。
//   保存が壊れた途中の Run は、知らせて新しい Run を始める。
// - Run の後の保存の終わり方（`FINISH`・`ABANDON`・`NONE`）、`finish` と片付けの失敗、出力の書き出しの失敗、Run Coordinator の例外、
//   再開を始められない3つの理由は、偽の Run Coordinator（`createRunCoordinator`）で確かめる（Browser を起動しない）。
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { EXIT_CODES, RUN_UNAVAILABLE_EXIT_CODE, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import { runAuditCommand, type RunCommandDependencies } from '../../src/cli/run-command.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  CHECKPOINT_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  checkpointArtifactRelativePath,
  checkpointPageArtifactRelativePath,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import type { AuditRunResult, Finding, PageAuditResult, PageId, RunId, RunSummary } from '../../src/core/contracts.js';
import { createRunId } from '../../src/core/ids.js';
import { readToolVersion } from '../../src/orchestration/environment.js';
import {
  createRunLock,
  currentProcessRunLockHost,
  decideRunResumption,
  isProcessRunning,
  judgeRunLock,
  RUN_LOCK_BOOT_TIME_TOLERANCE_MS,
  RUN_LOCK_HEARTBEAT_INTERVAL_MS,
  type RunCheckpoint,
  type RunCheckpointPage,
  type RunLock,
} from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import {
  RunCoordinator,
  RunResumeUnavailableError,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorCheckpointSession,
  type RunCoordinatorDependencies,
  type RunResumeUnavailableReason,
} from '../../src/orchestration/run-coordinator.js';
import { formatCount } from '../../src/presentation/format.js';
import {
  CLI_TEXT,
  HTML_REPORT_TEXT,
  activeRunInOutputDirectoryText,
  checkpointStoreFailedText,
  cliCountText,
  differentConfigRunText,
  differentVersionRunText,
  finalizingRunText,
  finishedCheckpointCleanupFailedText,
  resumingRunText,
  runLockHeldText,
  runLockTakenOverText,
  unreadableCheckpointText,
  versionDifferenceText,
} from '../../src/presentation/messages.js';
import { ArtifactWriteError, ArtifactWriter } from '../../src/report/artifact-writer.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { auditRun, FIXTURE_RUN_ID } from '../helpers/audit-run-fixture.js';
import { sampleRunCheckpoint, sampleRunCheckpointPage } from '../helpers/run-checkpoint-samples.js';
import { captureCliOutput, createRunLauncher, fastRunConfig, readJson, readRunAudit } from '../helpers/run-harness.js';
import type { TestConfigOverrides } from '../helpers/test-config.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/crawl/index.html';
/** 短い Run の設定のページ数の上限（設定の違い、版の違い、壊れた保存の確かめで使う）。 */
const SHORT_RUN_MAX_PAGES = 2;

let server: FixtureServer;
let workDirectory: string;
const runLauncher = createRunLauncher();

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-resume-'));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Runs').toBe(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------------
// 補助
// ---------------------------------------------------------------------------------------------------------------

/** 作業のディレクトリの下の、`name` の出力先に書く、実行時間を抑えた Run の設定（`/crawl/` の5ページ）。 */
const configFor = (name: string, overrides: TestConfigOverrides = {}): AuditConfig =>
  fastRunConfig(server.origin, START_PATH, {
    target: { id: 'cli-resume' },
    output: { directory: join(workDirectory, name) },
    ...overrides,
  });

/** ページ数の上限を `SHORT_RUN_MAX_PAGES` にした、短い Run の設定。 */
const shortConfigFor = (name: string, crawl: TestConfigOverrides['crawl'] = {}): AuditConfig =>
  configFor(name, { crawl: { maxPages: SHORT_RUN_MAX_PAGES, minNavigationIntervalMs: 0, ...crawl } });

/** 本物の headless Chromium で Run を行う、`run` の依存（時計は実際の時刻）。 */
const realDependencies = (overrides: Partial<RunCommandDependencies> = {}): RunCommandDependencies => ({
  launchBrowser: runLauncher.launcher,
  clock: () => new Date(),
  now: () => Date.now(),
  ...overrides,
});

interface CommandOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** `runAuditCommand` を実行し、終了コードと、標準出力・標準エラーに書いたものを返す。 */
async function runCommand(
  config: AuditConfig,
  dependencies: RunCommandDependencies,
  options?: { readonly startNew: boolean },
): Promise<CommandOutcome> {
  const stdout = captureCliOutput();
  const stderr = captureCliOutput();
  const code = await runAuditCommand(config, { stdout: stdout.output, stderr: stderr.output }, dependencies, options);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

/** `k` ページ目の監査が終わったときに、止める印を付ける Run Coordinator を作る関数（印は `controller` のもの）。 */
const stoppingAfter = (controller: AbortController, pages: number): NonNullable<RunCommandDependencies['createRunCoordinator']> =>
  (dependencies) => new RunCoordinator({
    ...dependencies,
    onProgress: (report) => {
      dependencies.onProgress?.(report);
      if (report.pagesFinished === pages) {
        controller.abort();
      }
    },
  });

/** 止める印で `pages` ページ目の後に止める Run を、`config` で行う。 */
async function runStoppedAfter(config: AuditConfig, pages: number): Promise<CommandOutcome> {
  const controller = new AbortController();
  return await runCommand(config, realDependencies({ stopSignal: controller.signal, createRunCoordinator: stoppingAfter(controller, pages) }));
}

/** 出力先の直下のディレクトリの名前（名前の順）。 */
async function directoriesIn(outputDirectory: string): Promise<string[]> {
  const entries = await readdir(outputDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
}

/** 出力先の直下の、ただ1つの Run のディレクトリ。 */
async function onlyRunDirectoryIn(outputDirectory: string): Promise<string> {
  const names = await directoriesIn(outputDirectory);
  expect(names).toHaveLength(1);
  return join(outputDirectory, names[0] ?? '');
}

/** Run のディレクトリの `checkpoint/` の下のファイルの、`checkpoint/` からの相対パス（区切りは `/`。名前の順）。 */
async function checkpointFilesIn(runDirectory: string): Promise<string[]> {
  const directory = artifactFilePath(runDirectory, CHECKPOINT_ARTIFACT_DIRECTORY);
  if (!existsSync(directory)) {
    return [];
  }
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort();
}

const readState = async (runDirectory: string): Promise<RunCheckpoint> =>
  await readJson(artifactFilePath(runDirectory, checkpointArtifactRelativePath('state'))) as RunCheckpoint;
const readRun = async (runDirectory: string): Promise<RunSummary> =>
  await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;
const lockPath = (runDirectory: string): string => artifactFilePath(runDirectory, checkpointArtifactRelativePath('lock'));

const findingKey = ({ findingId, ruleId, fingerprint }: Finding): readonly string[] => [findingId, ruleId, fingerprint];

/**
 * 中断しない Run と比べる項目（設計書 第7章）: Run Status、ページの一覧と ID と状態（SKIPPED の理由を含む）、ページと Run の Finding の
 * ID・ruleId・fingerprint、Run の理由。Run の ID、時刻、`load`、`executions`、`environment` は比べない（R4a2b と同じ）。
 */
async function comparableRunIn(runDirectory: string): Promise<unknown> {
  const run = await readRun(runDirectory);
  const audit = await readRunAudit(runDirectory);
  return {
    runStatus: run.runStatus,
    pages: audit.pages.map((page: PageAuditResult) => ({
      pageId: page.pageId,
      pageUrl: page.pageUrl,
      status: page.status,
      reasons: page.incompleteReasons,
      findings: page.findings.map(findingKey),
    })),
    findings: audit.findings.map(findingKey),
    incompleteReasons: run.incompleteReasons,
  };
}

/** 再開の知らせ（`RESUME`）の1行の期待値。ページの数は、実行中の進み具合の行と同じ書き方（`監査を終えたページ <件数>`）。 */
const expectedResumeLine = (runId: string, completedPages: number): string =>
  resumingRunText(runId, cliCountText(CLI_TEXT.progress.pagesFinished, formatCount(completedPages)));

/** 端末を再起動する前の OS で取ったロック（OS の起動の時刻が、許す誤差より前）。プロセスの ID と時刻は、元のロックのまま。 */
const lockBeforeOsRestart = (lock: RunLock): RunLock => ({
  ...lock,
  bootedAtMs: lock.bootedAtMs - RUN_LOCK_BOOT_TIME_TOLERANCE_MS - RUN_LOCK_HEARTBEAT_INTERVAL_MS,
});

const judgeNow = (lock: unknown): string => {
  const host = currentProcessRunLockHost(Date.now());
  return judgeRunLock(lock, { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning });
};

// ---------------------------------------------------------------------------------------------------------------
// 中断しない Run（比べる相手）
// ---------------------------------------------------------------------------------------------------------------

let uninterrupted: { readonly code: number; readonly comparable: unknown };

beforeAll(async () => {
  const outcome = await runCommand(configFor('uninterrupted'), realDependencies());
  const runDirectory = await onlyRunDirectoryIn(join(workDirectory, 'uninterrupted'));
  uninterrupted = { code: outcome.code, comparable: await comparableRunIn(runDirectory) };
  expect(outcome.code, outcome.stderr).toBe(exitCodeForRunStatus((await readRun(runDirectory)).runStatus));
  expect(outcome.stderr).toBe('');
  expect(await checkpointFilesIn(runDirectory)).toEqual(['state.json']);
}, SUITE_TIMEOUT_MS);

// ---------------------------------------------------------------------------------------------------------------
// 止めて再開
// ---------------------------------------------------------------------------------------------------------------

describe('R5a: a Run stopped by the stop signal is resumed by the same command (resumable run design 4.7, 4.7.1)', () => {
  /** 止める印を付ける前に監査を終えるページの数（k）。 */
  const PAGES_BEFORE_STOP = 2;

  let stopped: CommandOutcome;
  let stoppedRunDirectory: string;
  let stoppedState: RunCheckpoint;
  let resumed: CommandOutcome;
  let outputDirectory: string;

  beforeAll(async () => {
    const config = configFor('stop-and-resume');
    outputDirectory = join(workDirectory, 'stop-and-resume');
    stopped = await runStoppedAfter(config, PAGES_BEFORE_STOP);
    stoppedRunDirectory = await onlyRunDirectoryIn(outputDirectory);
    stoppedState = await readState(stoppedRunDirectory);
    // 2回目は、同じ設定で、止める印なしで実行する。
    resumed = await runCommand(config, realDependencies());
  }, SUITE_TIMEOUT_MS);

  it('stops the first execution after the k-th page with PARTIAL and leaves a STOPPED checkpoint without the lock', async () => {
    expect(stopped.code, stopped.stderr).toBe(EXIT_CODES.PARTIAL);
    expect(stoppedState.state).toBe('STOPPED');
    expect(stoppedState.completedPageIds).toHaveLength(PAGES_BEFORE_STOP);
    expect(existsSync(lockPath(stoppedRunDirectory))).toBe(false);
    // 最初の実行には、再開の知らせがない。
    expect(stopped.stdout).not.toContain(expectedResumeLine(stoppedState.runId, PAGES_BEFORE_STOP));
  });

  it('tells that it resumes the Run with the number of the finished pages and --new, before the start lines', () => {
    const lines = resumed.stdout.split('\n');
    const resumeLine = expectedResumeLine(stoppedState.runId, PAGES_BEFORE_STOP);

    expect(lines.filter((line) => line === resumeLine)).toHaveLength(1);
    expect(lines.indexOf(resumeLine)).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(resumed.stderr).toBe('');
  });

  it('writes into the same run directory, and exits with the same code as the Run without the stop', async () => {
    expect(await onlyRunDirectoryIn(outputDirectory)).toBe(stoppedRunDirectory);
    const run = await readRun(stoppedRunDirectory);
    expect(run.runId).toBe(stoppedState.runId);
    expect(resumed.code, resumed.stderr).toBe(uninterrupted.code);
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
  });

  it('gives the same pages, IDs, statuses, Findings and Run Status as the Run without the stop', async () => {
    expect(await comparableRunIn(stoppedRunDirectory)).toEqual(uninterrupted.comparable);
  });

  it('leaves only state.json (FINISHED) in checkpoint/, without the page checkpoints, state.prev.json and the lock', async () => {
    expect(await checkpointFilesIn(stoppedRunDirectory)).toEqual(['state.json']);
    expect((await readState(stoppedRunDirectory)).state).toBe('FINISHED');
    expect(existsSync(lockPath(stoppedRunDirectory))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 出力先の実行中の Run
// ---------------------------------------------------------------------------------------------------------------

describe('R5a: a running Run in the same output directory stops both the resume and a new Run (resumable run design 4.7.1)', () => {
  it.each([false, true])('exits with 4 with the Japanese message and creates no Run, with startNew %s', async (startNew) => {
    const outputDirectory = join(workDirectory, `active-${String(startNew)}`);
    const runId = createRunId(20261001000000);
    const runDirectory = runArtifactDirectory(outputDirectory, runId);
    // 動いている Run のロック（今のプロセスの ID と OS の起動の時刻で、今の時刻のハートビート）。ロックには対象の ID がないので、
    // 対象を問わない。
    const lock = createRunLock(currentProcessRunLockHost(Date.now()));
    await expect(new ArtifactWriter().acquireRunLock(runDirectory, lock)).resolves.toEqual({ acquired: true });
    expect(judgeNow(lock)).toBe('ACTIVE');
    let launches = 0;

    const outcome = await runCommand(configFor(`active-${String(startNew)}`), realDependencies({
      launchBrowser: async () => {
        launches += 1;
        throw new Error('the browser must not be launched while another Run is running');
      },
    }), { startNew });

    expect(outcome.code).toBe(RUN_UNAVAILABLE_EXIT_CODE);
    expect(outcome.stderr.split('\n')).toContain(activeRunInOutputDirectoryText(runId));
    // 開始の行も示さない。Run も出力も作らない。
    expect(outcome.stdout).toBe('');
    expect(launches).toBe(0);
    expect(await directoriesIn(outputDirectory)).toEqual([runId]);
    expect(await checkpointFilesIn(runDirectory)).toEqual(['run.lock']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 古いロック（端末の再起動）
// ---------------------------------------------------------------------------------------------------------------

describe('R5a: a Run whose process ended in the middle, with a stale lock from before an OS restart, is resumed (resumable run design 4.4)', () => {
  /** 保存を終えるページの数（k）。k+1 ページ目のページの保存の前に、保存を失敗させる（プロセスが途中で終わったことを模す）。 */
  const PAGES_BEFORE_INTERRUPTION = 3;

  let interrupted: CommandOutcome;
  let runDirectory: string;
  let savedState: RunCheckpoint;
  let liveLock: RunLock;
  let resumed: CommandOutcome;

  /** k+1 回目のページの保存を失敗させる、保存のセッションの包み（始め方と状態の保存は、そのまま CLI のセッションに任せる）。 */
  const failingPageSave = (session: RunCoordinatorCheckpointSession): RunCoordinatorCheckpointSession => {
    let pageSaves = 0;
    return {
      start: async (directory, options) => session.start(directory, options),
      saveState: async (state) => session.saveState(state),
      savePage: async (page) => {
        pageSaves += 1;
        if (pageSaves === PAGES_BEFORE_INTERRUPTION + 1) {
          throw new Error('simulated end of the process');
        }
        await session.savePage(page);
      },
    };
  };

  beforeAll(async () => {
    const config = configFor('stale-lock');
    const outputDirectory = join(workDirectory, 'stale-lock');
    interrupted = await runCommand(config, realDependencies({
      createRunCoordinator: (dependencies) => new RunCoordinator({
        ...dependencies,
        checkpointSession: failingPageSave(dependencies.checkpointSession as RunCoordinatorCheckpointSession),
      }),
    }));
    runDirectory = await onlyRunDirectoryIn(outputDirectory);
    savedState = await readState(runDirectory);
    liveLock = await readJson(lockPath(runDirectory)) as RunLock;
    // 端末を再起動したことを模す（ロックの OS の起動の時刻だけを、許す誤差より前にする）。
    await new ArtifactWriter().rewriteRunLock(runDirectory, lockBeforeOsRestart(liveLock));
    resumed = await runCommand(config, realDependencies());
  }, SUITE_TIMEOUT_MS);

  it('leaves an IN_PROGRESS checkpoint of k pages and the lock of this process (the session was abandoned)', () => {
    expect(interrupted.code, interrupted.stderr).toBe(EXIT_CODES.PARTIAL);
    expect(savedState.state).toBe('IN_PROGRESS');
    expect(savedState.completedPageIds).toHaveLength(PAGES_BEFORE_INTERRUPTION);
    // 元のロックは、このプロセスのもので、まだ動いている Run のもの。端末の再起動の後のロックは、OS の起動の時刻が違うので古い。
    expect(liveLock.processId).toBe(process.pid);
    expect(judgeNow(liveLock)).toBe('ACTIVE');
    expect(judgeNow(lockBeforeOsRestart(liveLock))).toBe('STALE');
  });

  it('resumes the Run in the same run directory, as the Run without the interruption', async () => {
    expect(resumed.stdout.split('\n')).toContain(expectedResumeLine(savedState.runId, PAGES_BEFORE_INTERRUPTION));
    expect(resumed.stderr).toBe('');
    expect(resumed.code).toBe(uninterrupted.code);
    expect((await readRun(runDirectory)).runId).toBe(savedState.runId);
    expect(await comparableRunIn(runDirectory)).toEqual(uninterrupted.comparable);
    expect((await readRun(runDirectory)).executions.map(({ endReason }) => endReason)).toEqual(['INTERRUPTED_ABNORMALLY', 'COMPLETED']);
  });

  it('removes the lock and leaves only state.json in checkpoint/', async () => {
    expect(existsSync(lockPath(runDirectory))).toBe(false);
    expect(await checkpointFilesIn(runDirectory)).toEqual(['state.json']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 設定が違う、版が違う、壊れた保存
// ---------------------------------------------------------------------------------------------------------------

describe('R5a: an interrupted Run with another configuration is not resumed (resumable run design 4.7.1)', () => {
  let stoppedRunId: RunId;
  let stoppedRunDirectory: string;
  let outcome: CommandOutcome;
  let outputDirectory: string;

  beforeAll(async () => {
    outputDirectory = join(workDirectory, 'other-config');
    expect((await runStoppedAfter(shortConfigFor('other-config'), 1)).code).toBe(EXIT_CODES.PARTIAL);
    stoppedRunDirectory = await onlyRunDirectoryIn(outputDirectory);
    stoppedRunId = (await readState(stoppedRunDirectory)).runId;
    // ページ数の上限だけを変える。
    outcome = await runCommand(shortConfigFor('other-config', { maxPages: 1 }), realDependencies());
  }, SUITE_TIMEOUT_MS);

  it('tells that the run is not resumed with the different item, and starts a new Run', async () => {
    const lines = outcome.stdout.split('\n');
    const notice = differentConfigRunText(stoppedRunId, 'crawl.maxPages');

    expect(lines).toContain(notice);
    expect(lines.indexOf(notice)).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(outcome.stdout).not.toContain(expectedResumeLine(stoppedRunId, 1));
    expect(outcome.stderr).toBe('');
    const names = await directoriesIn(outputDirectory);
    expect(names).toHaveLength(2);
    const newRunDirectory = join(outputDirectory, names.find((name) => name !== stoppedRunId) ?? '');
    expect(outcome.code).toBe(exitCodeForRunStatus((await readRun(newRunDirectory)).runStatus));
    // 設定が違う途中の Run は、そのまま残る。
    expect((await readState(stoppedRunDirectory)).state).toBe('STOPPED');
  });
});

// R5-fix-round-1（中断した Run の再開の設計書 4.7。R5b の報告）: 出力先（`output.directory`。`--output` の上書きを含む）は、再開の設定の
// 比べ方から外す。出力先は途中の Run を探す場所そのものなので、1回目を相対のパス（`--output` に相当する `config.output.directory`）で止め、
// 2回目を同じ場所の絶対のパスで実行すると、設定の違いを知らせずに、同じ Run のディレクトリで続きから再開する。
describe('R5-fix-round-1: an interrupted Run is resumed when the output directory is written as another path to the same place (resumable run design 4.7)', () => {
  const OUTPUT_NAME = 'output-spelling';

  let relativeOutputDirectory: string;
  let stoppedRunId: RunId;
  let stoppedRunDirectory: string;
  let stoppedState: RunCheckpoint;
  let resumed: CommandOutcome;
  let outputDirectory: string;

  beforeAll(async () => {
    // 2回目の設定（出力先は、作業のディレクトリの下の絶対のパス）。
    const absoluteConfig = shortConfigFor(OUTPUT_NAME);
    outputDirectory = absoluteConfig.output.directory;
    // 1回目の設定（出力先は、同じ場所を、今の作業のディレクトリからの相対のパスで書いたもの。ほかの項目は同じ）。
    relativeOutputDirectory = relative(process.cwd(), outputDirectory);
    const relativeConfig: AuditConfig = { ...absoluteConfig, output: { directory: relativeOutputDirectory } };

    expect((await runStoppedAfter(relativeConfig, 1)).code).toBe(EXIT_CODES.PARTIAL);
    stoppedRunDirectory = await onlyRunDirectoryIn(outputDirectory);
    stoppedState = await readState(stoppedRunDirectory);
    stoppedRunId = stoppedState.runId;
    resumed = await runCommand(absoluteConfig, realDependencies());
  }, SUITE_TIMEOUT_MS);

  it('stops the first execution with the output directory written as a relative path to the same place', () => {
    expect(isAbsolute(outputDirectory)).toBe(true);
    expect(isAbsolute(relativeOutputDirectory)).toBe(false);
    expect(resolve(relativeOutputDirectory)).toBe(outputDirectory);
    // 保存の実効の設定の出力先は、書いた文字のまま（相対のパス）。
    expect(stoppedState.effectiveConfig.output.directory).toBe(relativeOutputDirectory);
    expect(stoppedState.state).toBe('STOPPED');
    expect(stoppedState.completedPageIds).toHaveLength(1);
  });

  it('resumes the Run without the notice of a different configuration, before the start lines', () => {
    const lines = resumed.stdout.split('\n');
    const resumeLine = expectedResumeLine(stoppedRunId, 1);

    expect(lines).not.toContain(differentConfigRunText(stoppedRunId, 'output.directory'));
    expect(lines.filter((line) => line === resumeLine)).toHaveLength(1);
    expect(lines.indexOf(resumeLine)).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(resumed.stderr).toBe('');
  });

  it('writes into the same run directory without starting a new Run', async () => {
    expect(await directoriesIn(outputDirectory)).toEqual([stoppedRunId]);
    const run = await readRun(stoppedRunDirectory);
    expect(run.runId).toBe(stoppedRunId);
    expect(resumed.code).toBe(exitCodeForRunStatus(run.runStatus));
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
    expect((await readState(stoppedRunDirectory)).state).toBe('FINISHED');
  });
});

describe('R5a: an interrupted Run of another version is not resumed, and --new starts a new Run (resumable run design 4.7.1)', () => {
  const SAVED_TOOL_VERSION = '0.0.0-saved-by-another-version';

  let stoppedRunId: RunId;
  let stoppedRunDirectory: string;
  let refused: CommandOutcome;
  let launchesWhenRefused: number;
  let startedNew: CommandOutcome;
  let outputDirectory: string;

  beforeAll(async () => {
    const config = shortConfigFor('other-version');
    outputDirectory = join(workDirectory, 'other-version');
    expect((await runStoppedAfter(config, 1)).code).toBe(EXIT_CODES.PARTIAL);
    stoppedRunDirectory = await onlyRunDirectoryIn(outputDirectory);
    const state = await readState(stoppedRunDirectory);
    stoppedRunId = state.runId;
    // 保存の BeakSight の版を書き換える（スキーマと整合には合う）。
    await writeFile(
      artifactFilePath(stoppedRunDirectory, checkpointArtifactRelativePath('state')),
      `${JSON.stringify({ ...state, toolVersion: SAVED_TOOL_VERSION }, null, 2)}\n`,
      'utf8',
    );
    let launches = 0;
    refused = await runCommand(config, realDependencies({
      launchBrowser: async (options) => {
        launches += 1;
        return runLauncher.launcher(options);
      },
    }));
    launchesWhenRefused = launches;
    startedNew = await runCommand(config, realDependencies(), { startNew: true });
  }, SUITE_TIMEOUT_MS);

  it('exits with 4 and shows the saved and the current version, without starting a Run', async () => {
    const message = differentVersionRunText(
      stoppedRunId,
      versionDifferenceText(HTML_REPORT_TEXT.summary.toolVersion, SAVED_TOOL_VERSION, await readToolVersion()),
    );

    expect(refused.code).toBe(RUN_UNAVAILABLE_EXIT_CODE);
    expect(refused.stderr.split('\n')).toContain(message);
    expect(refused.stdout).toBe('');
    expect(launchesWhenRefused).toBe(0);
  });

  it('starts a new Run with --new, without the resume, and keeps the interrupted Run', async () => {
    expect(startedNew.stdout).not.toContain(expectedResumeLine(stoppedRunId, 1));
    expect(startedNew.stderr).toBe('');
    const names = await directoriesIn(outputDirectory);
    expect(names).toHaveLength(2);
    const newRunDirectory = join(outputDirectory, names.find((name) => name !== stoppedRunId) ?? '');
    expect(startedNew.code).toBe(exitCodeForRunStatus((await readRun(newRunDirectory)).runStatus));
    expect(await readState(stoppedRunDirectory)).toMatchObject({ state: 'STOPPED', toolVersion: SAVED_TOOL_VERSION });
  });
});

describe('R5a: an interrupted Run whose state.json and state.prev.json are both broken is not resumed (resumable run design 4.7)', () => {
  let stoppedRunId: RunId;
  let outcome: CommandOutcome;
  let outputDirectory: string;

  beforeAll(async () => {
    const config = shortConfigFor('broken');
    outputDirectory = join(workDirectory, 'broken');
    expect((await runStoppedAfter(config, 1)).code).toBe(EXIT_CODES.PARTIAL);
    const runDirectory = await onlyRunDirectoryIn(outputDirectory);
    stoppedRunId = (await readState(runDirectory)).runId;
    for (const file of ['state', 'previousState'] as const) {
      await writeFile(artifactFilePath(runDirectory, checkpointArtifactRelativePath(file)), '{"schemaVersion": "checkpoint-sch', 'utf8');
    }
    outcome = await runCommand(config, realDependencies());
  }, SUITE_TIMEOUT_MS);

  it('tells that the checkpoint cannot be read, and starts a new Run', async () => {
    const lines = outcome.stdout.split('\n');

    expect(lines).toContain(unreadableCheckpointText(stoppedRunId));
    expect(lines.indexOf(unreadableCheckpointText(stoppedRunId))).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(outcome.stdout).not.toContain(expectedResumeLine(stoppedRunId, 1));
    const names = await directoriesIn(outputDirectory);
    expect(names).toHaveLength(2);
    const newRunDirectory = join(outputDirectory, names.find((name) => name !== stoppedRunId) ?? '');
    expect(outcome.code).toBe(exitCodeForRunStatus((await readRun(newRunDirectory)).runStatus));
  });
});

// R5a-fix-round-1（中断した Run の再開の設計書 4.2。R5a の報告の発見事項1）: 保存の Run の ID が、Run のディレクトリの名前と違う途中の Run
// （ディレクトリを移した場合など）は、壊れた保存として知らせ、再開しない。再開すると、出力は `<出力先>/<保存の Run の ID>` に、保存は移した
// ディレクトリに書かれ、別のディレクトリに分かれるためである。
describe('R5a-fix-round-1: an interrupted Run whose run directory is not named by its run ID is not resumed (resumable run design 4.2)', () => {
  /** 途中の Run のディレクトリを移した先の名前（Run の ID の形。保存の Run の ID とは違う）。 */
  const RENAMED_RUN_ID = createRunId(20200101000000);

  let savedRunId: RunId;
  let renamedRunDirectory: string;
  let outcome: CommandOutcome;
  let outputDirectory: string;

  beforeAll(async () => {
    const config = shortConfigFor('renamed');
    outputDirectory = join(workDirectory, 'renamed');
    expect((await runStoppedAfter(config, 1)).code).toBe(EXIT_CODES.PARTIAL);
    const stoppedRunDirectory = await onlyRunDirectoryIn(outputDirectory);
    savedRunId = (await readState(stoppedRunDirectory)).runId;
    renamedRunDirectory = runArtifactDirectory(outputDirectory, RENAMED_RUN_ID);
    await rename(stoppedRunDirectory, renamedRunDirectory);
    outcome = await runCommand(config, realDependencies());
  }, SUITE_TIMEOUT_MS);

  it('tells that the checkpoint cannot be read, and starts a new Run', async () => {
    const lines = outcome.stdout.split('\n');
    const notice = unreadableCheckpointText(RENAMED_RUN_ID);

    expect(lines.filter((line) => line === notice)).toHaveLength(1);
    expect(lines.indexOf(notice)).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(outcome.stdout).not.toContain(expectedResumeLine(savedRunId, 1));
    expect(outcome.stderr).toBe('');
    const names = await directoriesIn(outputDirectory);
    expect(names).toHaveLength(2);
    const newRunDirectory = join(outputDirectory, names.find((name) => name !== RENAMED_RUN_ID) ?? '');
    expect(outcome.code).toBe(exitCodeForRunStatus((await readRun(newRunDirectory)).runStatus));
  });

  it('writes nothing into a directory named by the saved run ID, and keeps the moved Run as it was', async () => {
    // 新しい Run の ID は、保存の Run の ID と違う（出力と保存が、別のディレクトリに分かれない）。
    expect(await directoriesIn(outputDirectory)).not.toContain(savedRunId);
    expect(await readState(renamedRunDirectory)).toMatchObject({ state: 'STOPPED', runId: savedRunId });
    expect(existsSync(lockPath(renamedRunDirectory))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 違反の後の途中の Run（最後の処理だけ）
// ---------------------------------------------------------------------------------------------------------------

// R5a-fix-round-1（中断した Run の再開の設計書 3.2、4.3.1、4.7.1。R5a の報告の発見事項7）: 違反を検出した後の、保存の状態が `IN_PROGRESS`
// の途中の Run（`decideRunResumption` が `FINALIZE_ONLY`）を、同じ設定でもう一度実行すると、新しいページを監査せずに、最後の処理だけを行う。
// - 最初の実行: 違反を、`VIOLATION_PAGE` ページ目の Ledger に記録する（`tests/integration/resume-run.test.ts` の違反の後の再開と同じく、
//   `createSafetyLedger` で作る Ledger に記録し、ページの保存の Ledger の snapshot に入れる）。記録する Ledger は、次の2つの形とする。
//   - 最初の Ledger（Desktop）: Desktop の後には、ページの中の違反の確かめがあり、Mobile を始めない。そのページの後の状態の保存の、
//     検出と「止めた」ことのフラグは、どちらも真になる。
//   - 最後の Ledger（Mobile。R4a2b-fix-round-1。設計書 4.2 の最後の項目）: Mobile の後には、ページの中の違反の確かめがない。Run Coordinator
//     が、そのページの保存の前に、そのページの Ledger を調べるので、検出のフラグは真になる（「止めた」ことのフラグは偽のまま）。
//   Run は、次のページを始めずに終わる。最後の状態の保存（`finish`）を失敗させ、最後の状態を書く前にプロセスが終わったことを模す（CLI は
//   警告を示し、セッションをやめる。ロックは残る）。その後、ロックを端末の再起動の前のものにする（プロセスが終わった後と同じく、古いロックになる）。
// - 2回目: 最後の処理だけを行う（「続きから再開します」ではなく、「最後の処理だけを行います」と知らせる）。3回目: 終わった Run は再開せず、
//   新しい Run を始める（対象はローカルの fixture のサーバ）。
describe.each([
  { ledger: 'the first Ledger (Desktop)', violationLedgerOrdinal: 1, stoppedInPage: true, outputName: 'finalize-only' },
  { ledger: 'the last Ledger (Mobile)', violationLedgerOrdinal: 2, stoppedInPage: false, outputName: 'finalize-only-last-ledger' },
] as const)('R5a-fix-round-1: an interrupted Run after a safety invariant violation in $ledger of a page is only finalized by the same command (resumable run design 3.2, 4.2, 4.7.1)', ({
  violationLedgerOrdinal,
  stoppedInPage,
  outputName,
}) => {
  /** 違反を記録するページ（何番目に監査するページか。1から）。設定のページ数の上限（`SHORT_RUN_MAX_PAGES`）より前のページにする。 */
  const VIOLATION_PAGE = 1;
  /**
   * 違反のページで作る Ledger のうち、違反を記録するものの順番（1から）。Desktop、Mobile の順に作る（fixture のページには Interaction の
   * 候補がない）。
   */
  const VIOLATION_LEDGER_ORDINAL = violationLedgerOrdinal;
  /** 監査するページの文書のパスの接頭辞（`START_PATH` のディレクトリ。fixture のサイトの `/crawl/` のページ）。 */
  const PAGE_PATH_PREFIX = START_PATH.slice(0, START_PATH.lastIndexOf('/') + 1);

  let outputDirectory: string;
  let first: CommandOutcome;
  let runDirectory: string;
  let savedState: RunCheckpoint;
  let savedViolationPage: RunCheckpointPage;
  let firstLock: RunLock;
  let finalizing: CommandOutcome;
  let pathsObservedWhenFinalizing: string[];
  let directoriesAfterFinalizing: string[];
  let checkpointFilesAfterFinalizing: string[];
  let finalState: RunCheckpoint;
  let startedAgain: CommandOutcome;

  /**
   * 違反を記録する Run Coordinator を作る関数。`VIOLATION_PAGE - 1` ページを終えた状態の保存の後に作る Ledger を数え、
   * `VIOLATION_LEDGER_ORDINAL` 番目に違反を記録する。CLI の保存のセッションの `finish` は、実際には行わずに失敗させる。
   */
  const violatingRunCoordinator: NonNullable<RunCommandDependencies['createRunCoordinator']> = (dependencies) => {
    const session = dependencies.checkpointSession as RunCheckpointSession;
    vi.spyOn(session, 'finish').mockRejectedValueOnce(new Error('simulated end of the process before the final checkpoint'));
    let violationPageLedgers: number | null = null;
    const watchedSession: RunCoordinatorCheckpointSession = {
      start: async (directory, options) => session.start(directory, options),
      savePage: async (page) => session.savePage(page),
      saveState: async (state) => {
        await session.saveState(state);
        if (state.completedPageIds.length === VIOLATION_PAGE - 1 && violationPageLedgers === null) {
          violationPageLedgers = 0;
        }
      },
    };
    return new RunCoordinator({
      ...dependencies,
      checkpointSession: watchedSession,
      createSafetyLedger: () => {
        const ledger = new SafetyLedger();
        if (violationPageLedgers !== null) {
          violationPageLedgers += 1;
          if (violationPageLedgers === VIOLATION_LEDGER_ORDINAL) {
            ledger.recordInvariantViolation({ code: 'TEST_INJECTED_VIOLATION', message: 'injected by the CLI resume test' });
          }
        }
        return ledger;
      },
    });
  };

  beforeAll(async () => {
    const config = shortConfigFor(outputName);
    outputDirectory = join(workDirectory, outputName);

    // 1回目: 違反の後、最後の状態を書く前にプロセスが終わる。
    first = await runCommand(config, realDependencies({ createRunCoordinator: violatingRunCoordinator }));
    runDirectory = await onlyRunDirectoryIn(outputDirectory);
    savedState = await readState(runDirectory);
    const violationPageId = savedState.completedPageIds[VIOLATION_PAGE - 1];
    savedViolationPage = await readJson(artifactFilePath(runDirectory, checkpointPageArtifactRelativePath(violationPageId as PageId))) as RunCheckpointPage;
    // 端末を再起動したことを模す（ロックの OS の起動の時刻だけを、許す誤差より前にする）。
    firstLock = await readJson(lockPath(runDirectory)) as RunLock;
    await new ArtifactWriter().rewriteRunLock(runDirectory, lockBeforeOsRestart(firstLock));

    // 2回目: 同じ設定で、最後の処理だけを行う。
    server.resetRequestObservations();
    finalizing = await runCommand(config, realDependencies());
    pathsObservedWhenFinalizing = server.getRequestObservations().map(({ pathname }) => pathname);
    directoriesAfterFinalizing = await directoriesIn(outputDirectory);
    checkpointFilesAfterFinalizing = await checkpointFilesIn(runDirectory);
    finalState = await readState(runDirectory);

    // 3回目: 同じ設定で、新しい Run を始める。
    startedAgain = await runCommand(config, realDependencies());
  }, SUITE_TIMEOUT_MS);

  it('leaves an IN_PROGRESS checkpoint with the violation flag and the violation in the saved Ledger snapshot of the page', () => {
    expect(first.code, first.stderr).toBe(EXIT_CODES.ABORTED_BY_SAFETY);
    expect(first.stderr.split('\n')).toContain(CLI_TEXT.resume.finishFailed);
    expect(savedState.state).toBe('IN_PROGRESS');
    expect(savedState.completedPageIds).toHaveLength(VIOLATION_PAGE);
    expect(savedState.progress).toMatchObject({ safetyViolationDetected: true, stoppedBySafetyViolation: stoppedInPage });
    expect(decideRunResumption(savedState)).toBe('FINALIZE_ONLY');
    // 違反は、記録した順番の Ledger の snapshot にある。
    expect(savedViolationPage.safetyLedgerSnapshots[VIOLATION_LEDGER_ORDINAL - 1]?.invariantViolationCount).toBeGreaterThan(0);
    // 違反がなければ、続きの URL を監査する保存である（待ち行列に URL があり、ページ数の上限に達していない）。
    expect(savedState.frontier.entries.some(({ state }) => state === 'QUEUED')).toBe(true);
    expect(savedState.progress.pagesStarted).toBeLessThan(SHORT_RUN_MAX_PAGES);
    // 最後の状態を書く前に終わったので、このプロセスのロックが残った（端末の再起動の前のものにすると、古いロックになる）。
    expect(firstLock.processId).toBe(process.pid);
    expect(judgeNow(lockBeforeOsRestart(firstLock))).toBe('STALE');
  });

  it('tells that it only finalizes the Run, before the start lines, without the resume line', () => {
    const lines = finalizing.stdout.split('\n');
    const notice = finalizingRunText(savedState.runId);

    expect(lines.filter((line) => line === notice)).toHaveLength(1);
    expect(lines.indexOf(notice)).toBeLessThan(lines.indexOf(CLI_TEXT.run.started));
    expect(finalizing.stdout).not.toContain(expectedResumeLine(savedState.runId, VIOLATION_PAGE));
    expect(finalizing.stderr).toBe('');
  });

  it('audits no new page: the fixture server receives no request for a page document', () => {
    expect(pathsObservedWhenFinalizing.filter((path) => path.startsWith(PAGE_PATH_PREFIX))).toEqual([]);
  });

  it('exits with the code of ABORTED_BY_SAFETY, writing the output into the same run directory', async () => {
    expect(finalizing.code, finalizing.stderr).toBe(EXIT_CODES.ABORTED_BY_SAFETY);
    expect(directoriesAfterFinalizing).toEqual([savedState.runId]);
    const run = await readRun(runDirectory);
    expect(run).toMatchObject({ runId: savedState.runId, runStatus: 'ABORTED_BY_SAFETY' });
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['INTERRUPTED_ABNORMALLY', 'STOPPED_BY_SAFETY_VIOLATION']);
  });

  it('finishes the checkpoint as FINISHED, leaving only state.json in checkpoint/ without the lock', () => {
    expect(finalState.state).toBe('FINISHED');
    expect(checkpointFilesAfterFinalizing).toEqual(['state.json']);
  });

  it('starts a new Run by the same command afterwards, without the resume or the finalizing notice', async () => {
    expect(startedAgain.stdout).not.toContain(finalizingRunText(savedState.runId));
    expect(startedAgain.stdout).not.toContain(expectedResumeLine(savedState.runId, VIOLATION_PAGE));
    expect(startedAgain.stderr).toBe('');
    const names = await directoriesIn(outputDirectory);
    expect(names).toHaveLength(2);
    const newRunDirectory = join(outputDirectory, names.find((name) => name !== savedState.runId) ?? '');
    expect(startedAgain.code).toBe(exitCodeForRunStatus((await readRun(newRunDirectory)).runStatus));
    expect((await readState(runDirectory)).state).toBe('FINISHED');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Run の後（偽の Run Coordinator。Browser を起動しない）
// ---------------------------------------------------------------------------------------------------------------

describe('R5a: after the Run, the CLI follows the checkpoint conclusion of the Run Coordinator (resumable run design 4.7.1)', () => {
  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };

  interface FakeRun {
    readonly outcome: CommandOutcome | null;
    readonly rejection: unknown;
    readonly runDirectory: string;
    readonly finish: MockInstance<RunCheckpointSession['finish']>;
    readonly abandon: MockInstance<RunCheckpointSession['abandon']>;
  }

  interface FakeRunOptions {
    /** 偽の `run()` で、CLI の保存のセッションを始め、ページの保存と状態の保存を1回ずつ書く。 */
    readonly startSession: boolean;
    readonly conclusion: RunCoordinatorCheckpointConclusion;
    /** 偽の `run()` の終わり方（省略すると、見本の Run（COMPLETE）を返す）。 */
    readonly run?: (runDirectory: string) => Promise<AuditRunResult>;
    /** 保存のセッションの `finish` を、実際には行わずに失敗させる。 */
    readonly failFinish?: boolean;
  }

  /** 偽の Run Coordinator で `run` を行う。CLI が作った保存のセッションの `finish` と `abandon` を見張る。 */
  async function runWithFakeCoordinator(name: string, options: FakeRunOptions): Promise<FakeRun> {
    const config = configFor(name);
    const runDirectory = runArtifactDirectory(join(workDirectory, name), FIXTURE_RUN_ID);
    let finish: MockInstance<RunCheckpointSession['finish']> | undefined;
    let abandon: MockInstance<RunCheckpointSession['abandon']> | undefined;
    const dependencies: RunCommandDependencies = {
      launchBrowser: failingLaunch,
      clock: () => new Date(),
      now: () => Date.now(),
      createRunCoordinator: (coordinatorDependencies: RunCoordinatorDependencies) => {
        const session = coordinatorDependencies.checkpointSession as RunCheckpointSession;
        expect(session).toBeInstanceOf(RunCheckpointSession);
        finish = vi.spyOn(session, 'finish');
        if (options.failFinish === true) {
          finish.mockRejectedValueOnce(new Error('simulated failure of the final checkpoint'));
        }
        abandon = vi.spyOn(session, 'abandon');
        return {
          run: async () => {
            if (options.startSession) {
              await mkdir(runDirectory, { recursive: true });
              await expect(session.start(runDirectory, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });
              await session.savePage(sampleRunCheckpointPage());
              await session.saveState(sampleRunCheckpoint({ startPageFinished: true }));
            }
            return options.run === undefined ? auditRun() : options.run(runDirectory);
          },
          checkpointConclusion: () => options.conclusion,
        };
      },
    };
    let outcome: CommandOutcome | null = null;
    let rejection: unknown = null;
    try {
      outcome = await runCommand(config, dependencies);
    } catch (error) {
      rejection = error;
    }
    if (finish === undefined || abandon === undefined) {
      throw new Error('the fake Run Coordinator was not created');
    }
    return { outcome, rejection, runDirectory, finish, abandon };
  }

  const finishConclusion = (state: 'FINISHED' | 'STOPPED'): RunCoordinatorCheckpointConclusion =>
    ({ action: 'FINISH', checkpoint: sampleRunCheckpoint({ state }) });

  it('FINISH with FINISHED: finishes the session with the final checkpoint, then leaves only state.json', async () => {
    const finalCheckpoint = sampleRunCheckpoint({ state: 'FINISHED' });
    const fake = await runWithFakeCoordinator('after-finish-finished', {
      startSession: true,
      conclusion: { action: 'FINISH', checkpoint: finalCheckpoint },
    });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr).toBe('');
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.finish).toHaveBeenCalledWith(finalCheckpoint);
    expect(fake.abandon).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['state.json']);
    expect(await readState(fake.runDirectory)).toEqual(sampleRunCheckpoint({ state: 'FINISHED' }));
    // 出力は、保存の終わりの前に書いた。
    expect(existsSync(artifactFilePath(fake.runDirectory, RUN_ARTIFACT_FILE_NAMES.report))).toBe(true);
  });

  it('FINISH with STOPPED: finishes the session, and keeps the page checkpoints and state.prev.json for the resume', async () => {
    const fake = await runWithFakeCoordinator('after-finish-stopped', { startSession: true, conclusion: finishConclusion('STOPPED') });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.abandon).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['pages/PAGE-000001.json', 'state.json', 'state.prev.json']);
    expect((await readState(fake.runDirectory)).state).toBe('STOPPED');
  });

  it('ABANDON: abandons the session after writing the output, and keeps the checkpoint and the lock', async () => {
    const fake = await runWithFakeCoordinator('after-abandon', { startSession: true, conclusion: { action: 'ABANDON' } });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr).toBe('');
    expect(fake.abandon).toHaveBeenCalledTimes(1);
    expect(fake.finish).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['pages/PAGE-000001.json', 'run.lock', 'state.json']);
    expect((await readState(fake.runDirectory)).state).toBe('IN_PROGRESS');
  });

  it('NONE: neither finishes nor abandons the session', async () => {
    const fake = await runWithFakeCoordinator('after-none', { startSession: false, conclusion: { action: 'NONE' } });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr).toBe('');
    expect(fake.finish).not.toHaveBeenCalled();
    expect(fake.abandon).not.toHaveBeenCalled();
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual([]);
  });

  it('warns on stderr when the final checkpoint cannot be written, abandons the session, and keeps the exit code of the Run Status', async () => {
    const fake = await runWithFakeCoordinator('after-finish-failure', {
      startSession: true,
      conclusion: finishConclusion('FINISHED'),
      failFinish: true,
    });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(fake.outcome?.stderr.split('\n')).toContain(CLI_TEXT.resume.finishFailed);
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.abandon).toHaveBeenCalledTimes(1);
    expect(fake.abandon.mock.invocationCallOrder[0]).toBeGreaterThan(fake.finish.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    // 片付けもしない（保存の状態は、最後に書けた IN_PROGRESS のまま）。
    expect(await checkpointFilesIn(fake.runDirectory)).toEqual(['pages/PAGE-000001.json', 'run.lock', 'state.json']);
  });

  it('warns on stderr with the path when the checkpoint files of the finished Run cannot be removed, and keeps the exit code', async () => {
    const blockedPath = join(workDirectory, 'after-cleanup-failure', 'blocked-path');
    const cleanUp = vi.spyOn(ArtifactWriter.prototype, 'removeFinishedCheckpointFiles')
      .mockRejectedValueOnce(new ArtifactWriteError(blockedPath, new Error('EBUSY: resource busy or locked')));

    const fake = await runWithFakeCoordinator('after-cleanup-failure', { startSession: true, conclusion: finishConclusion('FINISHED') });

    expect(fake.outcome?.code).toBe(EXIT_CODES.COMPLETE);
    expect(cleanUp).toHaveBeenCalledWith(fake.runDirectory);
    expect(fake.outcome?.stderr.split('\n')).toContain(finishedCheckpointCleanupFailedText(blockedPath));
    expect(fake.finish).toHaveBeenCalledTimes(1);
    expect(fake.abandon).not.toHaveBeenCalled();
  });

  it('abandons the session and rejects when the output cannot be written, without finishing the session', async () => {
    const fake = await runWithFakeCoordinator('after-output-failure', {
      startSession: true,
      conclusion: finishConclusion('FINISHED'),
      run: async (runDirectory) => {
        // run.json の場所にディレクトリを置き、出力の書き出しを失敗させる。
        await mkdir(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), { recursive: true });
        return auditRun();
      },
    });

    expect(fake.outcome).toBeNull();
    expect(fake.rejection).toBeInstanceOf(ArtifactWriteError);
    expect(fake.abandon).toHaveBeenCalledTimes(1);
    expect(fake.finish).not.toHaveBeenCalled();
  });

  it.each([
    ['ABANDON', 1],
    ['NONE', 0],
  ] as const)('rejects with the unexpected error of the Run Coordinator, abandoning the session only for %s', async (action, abandons) => {
    const unexpected = new Error('unexpected failure of the Run Coordinator');
    const fake = await runWithFakeCoordinator(`after-unexpected-${action.toLowerCase()}`, {
      startSession: action === 'ABANDON',
      conclusion: { action },
      run: async () => {
        throw unexpected;
      },
    });

    expect(fake.rejection).toBe(unexpected);
    expect(fake.abandon).toHaveBeenCalledTimes(abandons);
    expect(fake.finish).not.toHaveBeenCalled();
  });

  it.each([
    ['LOCK_HELD_BY_ACTIVE_RUN', runLockHeldText],
    ['LOCK_TAKEN_OVER_CONCURRENTLY', runLockTakenOverText],
    ['CHECKPOINT_STORE_FAILED', checkpointStoreFailedText],
  ] as const satisfies readonly (readonly [RunResumeUnavailableReason, (runId: string) => string])[])(
    'exits with 4 with the message for %s when the resume cannot start, writing no output',
    async (reason, text) => {
      const name = `resume-unavailable-${reason.toLowerCase()}`;
      const cause = new Error('EACCES: permission denied, open checkpoint/run.lock');
      const fake = await runWithFakeCoordinator(name, {
        startSession: false,
        conclusion: { action: 'NONE' },
        run: async (runDirectory) => {
          throw new RunResumeUnavailableError({
            runId: FIXTURE_RUN_ID,
            runDirectory,
            reason,
            existingLock: null,
            ...(reason === 'CHECKPOINT_STORE_FAILED' ? { cause } : {}),
          });
        },
      });

      expect(fake.outcome?.code).toBe(RUN_UNAVAILABLE_EXIT_CODE);
      const lines = fake.outcome?.stderr.split('\n') ?? [];
      expect(lines[0]).toBe(text(FIXTURE_RUN_ID));
      if (reason === 'CHECKPOINT_STORE_FAILED') {
        expect(lines).toContain(`${CLI_TEXT.detailsHeading}:`);
        expect(lines.filter((line) => line.includes(cause.message))).toHaveLength(1);
      } else {
        expect(fake.outcome?.stderr).not.toContain(CLI_TEXT.detailsHeading);
      }
      // 出力を作らない（結果の要約も示さない）。
      expect(fake.outcome?.stdout).not.toContain(CLI_TEXT.run.resultHeading);
      expect(existsSync(join(workDirectory, name))).toBe(false);
      expect(fake.finish).not.toHaveBeenCalled();
      expect(fake.abandon).not.toHaveBeenCalled();
    },
  );
});
