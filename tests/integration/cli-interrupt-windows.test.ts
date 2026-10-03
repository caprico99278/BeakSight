// R7a（中断した Run の再開の設計書 4.7、4.7.1、4.10。RR の Critical-1）: Windows で、本物の Ctrl+C（コンソールの CTRL_C_EVENT）を、
// 一時的なビルドの CLI に送る（送り方は `tests/helpers/windows-console-ctrl.ts`）。CLI の本番の Chromium の起動
// （`PRODUCTION_RUN_DEPENDENCIES.launchBrowser`）を、そのまま確かめる。fixture のサイトは `fixtures/site/full-crawl/`（127.0.0.1）。
// - 1回目の Ctrl+C: 2ページ目の進み具合の行が出た後（3ページ目の監査の途中）に送る。CLI は、3ページ目の監査を最後まで行ってから止まり、
//   `PARTIAL` の出力と `STOPPED` の保存を書く。どのページも、`AUDITED` か、理由 `RUN_INTERRUPTED` の `SKIPPED` である。Chromium が
//   CTRL_C_EVENT を受けて終わると、3ページ目が失敗のまま「終わったページ」として保存され、再開しても監査し直されない（RR の Critical-1）。
// - 再開: 同じ設定で、Ctrl+C を送らずに動かすと、同じ Run のディレクトリで続きから監査し、中断しない Run（別の出力先で、同じ設定で動かす）と
//   同じページの一覧と状態になる。
// - 2回目の Ctrl+C: `--new` で新しい Run を始め、2ページ目の後に1回目を送り、1回目を受け付けた直後に2回目を送る。CLI は、最後の処理をせずに
//   終了コード 5 で終わり、保存の状態は `IN_PROGRESS` のまま残る。同じ設定で動かすと、再開して最後まで終える。
//
// Windows だけで動かす。ほかの OS では、Playwright が Chromium を別のプロセスのグループで起動する（`detached`）ので、端末の Ctrl+C の
// SIGINT は Chromium に届かず、この問題は起きない。また、CTRL_C_EVENT は、Windows のコンソールの仕組みである。
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { EXIT_CODES, INTERRUPTED_EXIT_CODE, SUCCESS_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath, checkpointArtifactRelativePath } from '../../src/core/artifact-layout.js';
import type { IncompleteReason, RunId, RunSummary } from '../../src/core/contracts.js';
import { isProcessRunning, type RunCheckpoint } from '../../src/orchestration/run-checkpoint.js';
import { formatCount } from '../../src/presentation/format.js';
import { CLI_TEXT, cliCountText, cliFieldText, resumingRunText } from '../../src/presentation/messages.js';
import {
  expectFinishedInTime,
  onlyRunDirectory,
  runCliProcess,
  STACK_TRACE_LINE,
  type CliProcessResult,
} from '../helpers/cli-process.js';
import { cliTargetConfig, readJson, readRunAudit } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import {
  startCliInWindowsConsole,
  stopOwnProcessTree,
  type WindowsConsoleCliResult,
  type WindowsConsoleCliRun,
  type WindowsProcessControl,
} from '../helpers/windows-console-ctrl.js';

/** ビルドと、CLI の1回か2回の Run を含む、`beforeAll` の上限（ほかの CLI の結合テストと同じ）。 */
const SUITE_TIMEOUT_MS = 300_000;
const TARGET_ID = 'cli-interrupt-windows';
/** 専用の fixture のサイトの入口（8ページ。`tests/integration/fixture-full-crawl.test.ts` と同じサイト）。 */
const START_PATH = '/full-crawl/index.html';
/** fixture のサーバが `/robots.txt` と `/sitemap.xml` を返すディレクトリ（`fixtures/site/` からの相対のパス）。 */
const SITE_METADATA_DIRECTORY = 'full-crawl';
/**
 * ページの読み込みの最小の間隔（ms。`crawl.minNavigationIntervalMs`）。Ctrl+C の合図は、2ページ目の進み具合の行を見た直後に置き、合図が
 * 届くまでの遅れは、合図のファイルを読み直す間隔（`CONSOLE_CTRL_POLL_INTERVAL_MS`）の数回分である。その時点で、3ページ目の読み込み
 * （Desktop と Mobile。どちらも、前の読み込みから、この間隔を空けて始まる）が、まだ残っているようにするための値である。3ページ目は、
 * Ctrl+C の後にも Chromium を使うので、Chromium が Ctrl+C で終わると失敗する。
 */
const NAVIGATION_INTERVAL_MS = 2_000;
/** 1回目の Ctrl+C を送る前に、監査を終えるページの数。 */
const PAGES_BEFORE_CTRL_C = 2;
/** 1回目の Ctrl+C の後に、止める印を付ける前に始めていたので、最後まで監査するページ（3ページ目）の数。 */
const PAGES_IN_PROGRESS_AT_CTRL_C = 1;
/** 止める印の後に始めなかったページ（`SKIPPED`）と、Run の理由（中断した Run の再開の設計書 4.6.1）。 */
const RUN_INTERRUPTED_REASON: IncompleteReason = Object.freeze({ code: 'RUN_INTERRUPTED', detail: null });

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;
let configPath: string;
/** 中断する Run の出力先（1回目の Ctrl+C の Run、その再開、`--new` の Run、その再開が、順に使う）。 */
let outputDirectory: string;
/** 起動した、自分のコンソールの CLI（後片付けで、残っていれば止める）。 */
const consoleRuns: WindowsConsoleCliRun[] = [];
/** 中断しない Run（別の出力先で、同じ設定で動かす）。 */
let uninterrupted: { readonly result: CliProcessResult; readonly comparable: ComparableRun };

/** 中断しない Run と比べる項目: Run Status と、ページの一覧（ID、URL、状態、理由）。 */
interface ComparableRun {
  readonly runStatus: RunSummary['runStatus'];
  readonly pages: readonly { readonly pageId: string; readonly pageUrl: string; readonly status: string; readonly incompleteReasons: unknown }[];
}

/** `run` の引数（同じ設定のファイルと出力先。Chromium は headless だけで起動する）。 */
const runArguments = (output: string, ...extra: string[]): string[] =>
  ['run', '--config', configPath, '--output', output, '--headless', ...extra];

const readRun = async (runDirectory: string): Promise<RunSummary> =>
  await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;
const readState = async (runDirectory: string): Promise<RunCheckpoint> =>
  await readJson(artifactFilePath(runDirectory, checkpointArtifactRelativePath('state'))) as RunCheckpoint;

async function comparableRunIn(runDirectory: string): Promise<ComparableRun> {
  const run = await readRun(runDirectory);
  const audit = await readRunAudit(runDirectory);
  return {
    runStatus: run.runStatus,
    pages: audit.pages.map(({ pageId, pageUrl, status, incompleteReasons }) => ({ pageId, pageUrl, status, incompleteReasons })),
  };
}

/** 出力先の直下のディレクトリの名前（名前の順）。 */
async function directoriesIn(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map(({ name }) => name).sort();
}

/** `pagesFinished` ページ目の監査を終えたときの、進み具合の行の書き出し（`監査の進み具合: 監査を終えたページ <件数>（`）。 */
const progressLinePrefix = (pagesFinished: number): string =>
  `${cliFieldText(CLI_TEXT.progress.heading, cliCountText(CLI_TEXT.progress.pagesFinished, formatCount(pagesFinished)))}（`;

/** 標準出力に、`pagesFinished` ページ目の進み具合の行がある。 */
const hasProgressLineOf = (pagesFinished: number) => (stdout: string): boolean =>
  stdout.split('\n').some((line) => line.startsWith(progressLinePrefix(pagesFinished)));

/** 再開の知らせ（`RESUME`）の1行の期待値（`tests/integration/cli-resume.test.ts` と同じ書き方）。 */
const expectedResumeLine = (runId: string, completedPages: number): string =>
  resumingRunText(runId, cliCountText(CLI_TEXT.progress.pagesFinished, formatCount(completedPages)));

const linesOf = (text: string): string[] => text.split(/\r?\n/u);

/** 自分のコンソールで CLI を起動する（作業のディレクトリは `workDirectory`。起動用のファイルは `name` のディレクトリに置く）。 */
async function startConsoleRun(name: string, arguments_: readonly string[]): Promise<WindowsConsoleCliRun> {
  const run = await startCliInWindowsConsole(build, { directory: join(workDirectory, name), cwd: workDirectory, arguments: arguments_ });
  consoleRuns.push(run);
  return run;
}

/** 自分のコンソールの CLI が終わり、CLI のプロセスも残っていない。 */
function expectConsoleRunFinished(result: WindowsConsoleCliResult): void {
  expect(result.scriptStatus, result.scriptOutput).toBe(0);
  expectFinishedInTime(result);
  expect(result.cliProcessId).not.toBeNull();
  expect(isProcessRunning(result.cliProcessId ?? 0)).toBe(false);
  expect(result.stdout).not.toMatch(STACK_TRACE_LINE);
  expect(result.stderr).not.toMatch(STACK_TRACE_LINE);
}

/**
 * 偽のプロセスの操作（後片付けの確かめ。RR2 の指摘1）。どのプロセスの ID についても、動いているか（`running`）とコマンド行（`commandLine`）を
 * 同じに答え、コマンド行を尋ねられたプロセスの ID（`asked`）と、止めるよう頼まれたプロセスの ID（`killed`）を記録する。何も止めない。
 */
function fakeProcessControl(options: { readonly running: boolean; readonly commandLine: string | null }) {
  const asked: number[] = [];
  const killed: number[] = [];
  const control: WindowsProcessControl = {
    isRunning: () => options.running,
    commandLineOf: (processId) => {
      asked.push(processId);
      return options.commandLine;
    },
    killTree: (processId) => {
      killed.push(processId);
    },
  };
  return { control, asked, killed };
}

// RR2 の指摘1（R8）: 後片付けは、このテストが起動したものと確かめられたプロセスだけを、子孫ごと止める（`stopOwnProcessTree`）。Windows は
// プロセスの ID を使い回すので、終わったプロセスの ID で止めると、関係のないプロセスを、その子孫ごと止める恐れがある。止めるかどうかの判断を、
// 偽のプロセスの操作で確かめる（OS によらない）。
describe('the cleanup stops only the processes that this test started (RR2 finding 1)', () => {
  /** 尋ねるプロセスの ID（偽のプロセスの操作だけに渡す。実際のプロセスには使わない）。 */
  const PROCESS_ID = 4242;
  /** このテストが起動したプロセスのコマンド行に入る部分（一時ビルドの CLI のパスを模す）。 */
  const OWN_PART = join(tmpdir(), 'beaksight-temporary-build', 'dist', 'cli', 'index.js');
  const OWN_COMMAND_LINE = `node.exe ${OWN_PART} run --headless`;

  it('does not stop by the ID of a process known to have exited, even if a process with the ID now runs with the same command line', () => {
    const fake = fakeProcessControl({ running: true, commandLine: OWN_COMMAND_LINE });

    expect(stopOwnProcessTree(PROCESS_ID, { exited: true, ownCommandLinePart: OWN_PART }, fake.control)).toBe(false);
    expect(fake.asked).toEqual([]);
    expect(fake.killed).toEqual([]);
  });

  it('stops the process tree of a running process whose command line has the part of this test', () => {
    const fake = fakeProcessControl({ running: true, commandLine: OWN_COMMAND_LINE });

    expect(stopOwnProcessTree(PROCESS_ID, { exited: false, ownCommandLinePart: OWN_PART }, fake.control)).toBe(true);
    expect(fake.asked).toEqual([PROCESS_ID]);
    expect(fake.killed).toEqual([PROCESS_ID]);
  });

  it.each([
    ['another process uses the ID (its command line does not have the part of this test)', { running: true, commandLine: 'C:\\Windows\\System32\\notepad.exe' }],
    ['the command line cannot be read', { running: true, commandLine: null }],
    ['the process is not running', { running: false, commandLine: OWN_COMMAND_LINE }],
  ] as const)('does not stop a process whose exit is unknown when %s', (_name, options) => {
    const fake = fakeProcessControl(options);

    expect(stopOwnProcessTree(PROCESS_ID, { exited: false, ownCommandLinePart: OWN_PART }, fake.control)).toBe(false);
    expect(fake.killed).toEqual([]);
  });
});

describe.runIf(process.platform === 'win32')('CLI run with a real Ctrl+C on Windows (resumable run design 4.7, 4.10. RR Critical-1)', () => {
  beforeAll(async () => {
    server = await startFixtureServer({ siteMetadataDirectory: SITE_METADATA_DIRECTORY });
    build = await buildIntoTemporaryDirectory();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-interrupt-windows-'));
    configPath = join(workDirectory, 'interrupt.json');
    outputDirectory = join(workDirectory, 'interrupted-output');
    // 幅の走査は行わない（`cliTargetConfig`）。ページの読み込みの最小の間隔だけを `NAVIGATION_INTERVAL_MS` にする。
    await writeFile(
      configPath,
      JSON.stringify(cliTargetConfig(TARGET_ID, server.origin, START_PATH, { crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS } })),
      'utf8',
    );
    const uninterruptedOutput = join(workDirectory, 'uninterrupted-output');
    const result = await runCliProcess(build, workDirectory, runArguments(uninterruptedOutput));
    uninterrupted = { result, comparable: await comparableRunIn(await onlyRunDirectory(uninterruptedOutput)) };
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    const leftovers = (await Promise.all(consoleRuns.map(async (run) => run.stop()))).filter(Boolean).length;
    await build?.remove();
    await server?.close();
    if (workDirectory !== undefined) {
      await rm(workDirectory, { recursive: true, force: true });
    }
    expect(leftovers, 'CLI processes left running after the tests').toBe(0);
  }, SUITE_TIMEOUT_MS);

  it('runs the Run without Ctrl+C to the end as COMPLETE (the Run to compare with)', () => {
    expectFinishedInTime(uninterrupted.result);
    expect(uninterrupted.comparable.runStatus).toBe('COMPLETE');
    expect(uninterrupted.result.status, uninterrupted.result.stderr).toBe(EXIT_CODES.COMPLETE);
    expect(uninterrupted.comparable.pages.length).toBeGreaterThan(PAGES_BEFORE_CTRL_C + PAGES_IN_PROGRESS_AT_CTRL_C);
  });

  // RR2 の指摘1（R8）: CLI が終わって終了コードのファイルがあり、起動用のスクリプトも終わっていれば、後片付け（終わりの確かめと `stop`）は、
  // プロセスの ID では何も止めない。偽のプロセスの操作は、どのプロセスの ID も動いていて、コマンド行に一時ビルドの CLI のパスがあると答える
  // （プロセスの ID が使い回された場合の、最も紛らわしい場合を模す）。CLI は、すぐに終わる `--help` で起動する。
  it('stops nothing by the process IDs after the CLI and the script have ended, even if the IDs look like those of this test (RR2 finding 1)', async () => {
    const fake = fakeProcessControl({ running: true, commandLine: join(build.distDirectory, 'cli', 'index.js') });
    const consoleRun = await startCliInWindowsConsole(build, {
      directory: join(workDirectory, 'console-help'),
      cwd: workDirectory,
      arguments: ['--help'],
      processControl: fake.control,
    });

    const result = await consoleRun.finished;

    expect(result.scriptStatus, result.scriptOutput).toBe(0);
    expect(result.status, result.stderr).toBe(SUCCESS_EXIT_CODE);
    expect(result.cliProcessId).not.toBeNull();
    expect(await consoleRun.stop()).toBe(false);
    expect(fake.asked).toEqual([]);
    expect(fake.killed).toEqual([]);
  });

  describe('the first Ctrl+C after the second page', () => {
    let first: WindowsConsoleCliResult;
    let runDirectory: string;
    let run: RunSummary;
    let state: RunCheckpoint;

    beforeAll(async () => {
      const consoleRun = await startConsoleRun('console-first', runArguments(outputDirectory));
      await consoleRun.waitForOutput('stdout', hasProgressLineOf(PAGES_BEFORE_CTRL_C));
      await consoleRun.sendCtrlC();
      first = await consoleRun.finished;
      runDirectory = await onlyRunDirectory(outputDirectory);
      run = await readRun(runDirectory);
      state = await readState(runDirectory);
    }, SUITE_TIMEOUT_MS);

    it('shows that the interruption is accepted, and exits with the code of PARTIAL', () => {
      expectConsoleRunFinished(first);
      expect(linesOf(first.stderr)).toContain(CLI_TEXT.interrupt.stopRequested);
      expect(first.stderr).not.toContain(CLI_TEXT.interrupt.exitingNow);
      expect(first.status, first.stderr).toBe(EXIT_CODES.PARTIAL);
    });

    it('writes a PARTIAL run.json whose last execution was stopped by the signal', () => {
      expect(run.runStatus).toBe('PARTIAL');
      expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL']);
      expect(run.incompleteReasons).toEqual([RUN_INTERRUPTED_REASON]);
      expect(run.safety.invariantViolationCount).toBe(0);
    });

    it('audits the page in the middle to the end: every page is AUDITED or SKIPPED by RUN_INTERRUPTED, without a failed page', async () => {
      const { pages } = await comparableRunIn(runDirectory);
      const auditedPages = PAGES_BEFORE_CTRL_C + PAGES_IN_PROGRESS_AT_CTRL_C;
      // ページの一覧（URL と ID）は、中断しない Run と同じ（止める印の後の URL も、SKIPPED として残る）。
      expect(pages.map(({ pageId, pageUrl }) => ({ pageId, pageUrl })))
        .toEqual(uninterrupted.comparable.pages.map(({ pageId, pageUrl }) => ({ pageId, pageUrl })));
      expect(pages.slice(0, auditedPages).map(({ status, incompleteReasons }) => ({ status, incompleteReasons })))
        .toEqual(Array.from({ length: auditedPages }, () => ({ status: 'AUDITED', incompleteReasons: [] })));
      expect(pages.slice(auditedPages).map(({ status, incompleteReasons }) => ({ status, incompleteReasons })))
        .toEqual(Array.from({ length: pages.length - auditedPages }, () => ({ status: 'SKIPPED', incompleteReasons: [RUN_INTERRUPTED_REASON] })));
      expect(run.failedPageCount).toBe(0);
      expect(run.partialPageCount).toBe(0);
    });

    it('leaves a STOPPED checkpoint with the audited pages', () => {
      expect(state.state).toBe('STOPPED');
      expect(state.runId).toBe(run.runId);
      expect(state.completedPageIds).toHaveLength(PAGES_BEFORE_CTRL_C + PAGES_IN_PROGRESS_AT_CTRL_C);
    });
  });

  describe('the resume after the first Ctrl+C', () => {
    let stoppedRunId: RunId;
    let stoppedRunDirectory: string;
    let resumed: CliProcessResult;

    beforeAll(async () => {
      stoppedRunDirectory = await onlyRunDirectory(outputDirectory);
      stoppedRunId = (await readState(stoppedRunDirectory)).runId;
      resumed = await runCliProcess(build, workDirectory, runArguments(outputDirectory));
    }, SUITE_TIMEOUT_MS);

    it('tells that it resumes the Run, and exits with the same code as the Run without Ctrl+C', () => {
      expectFinishedInTime(resumed);
      const lines = linesOf(resumed.stdout);
      expect(lines).toContain(expectedResumeLine(stoppedRunId, PAGES_BEFORE_CTRL_C + PAGES_IN_PROGRESS_AT_CTRL_C));
      expect(resumed.status, resumed.stderr).toBe(uninterrupted.result.status);
    });

    it('writes into the same run directory, with the same pages and statuses as the Run without Ctrl+C', async () => {
      expect(await onlyRunDirectory(outputDirectory)).toBe(stoppedRunDirectory);
      const run = await readRun(stoppedRunDirectory);
      expect(run.runId).toBe(stoppedRunId);
      expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL', 'COMPLETED']);
      expect(await comparableRunIn(stoppedRunDirectory)).toEqual(uninterrupted.comparable);
      expect((await readState(stoppedRunDirectory)).state).toBe('FINISHED');
    });
  });

  describe('the second Ctrl+C right after the first one, in a new Run started with --new', () => {
    let finishedRunId: string;
    let second: WindowsConsoleCliResult;
    let newRunDirectory: string;
    let interruptedState: RunCheckpoint;
    let runJsonWrittenBeforeResume: boolean;
    let resumed: CliProcessResult;

    beforeAll(async () => {
      // 出力先には、1回目の Ctrl+C の後に再開して終えた Run が1つだけある。
      const before = await directoriesIn(outputDirectory);
      expect(before).toHaveLength(1);
      finishedRunId = before[0] ?? '';
      const consoleRun = await startConsoleRun('console-second', runArguments(outputDirectory, '--new'));
      await consoleRun.waitForOutput('stdout', hasProgressLineOf(PAGES_BEFORE_CTRL_C));
      await consoleRun.sendCtrlC();
      // 1回目を受け付けた（文言を示した）直後に、2回目を送る。
      await consoleRun.waitForOutput('stderr', (stderr) => linesOf(stderr).includes(CLI_TEXT.interrupt.stopRequested));
      await consoleRun.sendCtrlC();
      second = await consoleRun.finished;
      const names = await directoriesIn(outputDirectory);
      expect(names).toHaveLength(2);
      newRunDirectory = join(outputDirectory, names.find((name) => name !== finishedRunId) ?? '');
      interruptedState = await readState(newRunDirectory);
      // 再開の前に、最後の処理の出力（run.json）があるかを調べる（再開の後には、再開した実行が書く）。
      runJsonWrittenBeforeResume = existsSync(artifactFilePath(newRunDirectory, RUN_ARTIFACT_FILE_NAMES.run));
      resumed = await runCliProcess(build, workDirectory, runArguments(outputDirectory));
    }, SUITE_TIMEOUT_MS);

    it('stops at once with the exit code 5 (INTERRUPTED) and the message of the second Ctrl+C', () => {
      expectConsoleRunFinished(second);
      expect(second.status, second.stderr).toBe(INTERRUPTED_EXIT_CODE);
      const lines = linesOf(second.stderr);
      expect(lines).toContain(CLI_TEXT.interrupt.stopRequested);
      expect(lines).toContain(CLI_TEXT.interrupt.exitingNow);
    });

    it('leaves the checkpoint IN_PROGRESS with the pages audited before the Ctrl+C, without the final output', () => {
      expect(interruptedState.state).toBe('IN_PROGRESS');
      expect(interruptedState.completedPageIds).toHaveLength(PAGES_BEFORE_CTRL_C);
      expect(runJsonWrittenBeforeResume).toBe(false);
    });

    it('resumes the new Run by the same command and finishes it, as the Run without Ctrl+C', async () => {
      expectFinishedInTime(resumed);
      expect(linesOf(resumed.stdout)).toContain(expectedResumeLine(interruptedState.runId, PAGES_BEFORE_CTRL_C));
      expect(resumed.status, resumed.stderr).toBe(uninterrupted.result.status);
      expect(await directoriesIn(outputDirectory)).toHaveLength(2);
      const run = await readRun(newRunDirectory);
      expect(run.runId).toBe(interruptedState.runId);
      expect(run.executions.map(({ endReason }) => endReason)).toEqual(['INTERRUPTED_ABNORMALLY', 'COMPLETED']);
      expect(await comparableRunIn(newRunDirectory)).toEqual(uninterrupted.comparable);
      expect((await readState(newRunDirectory)).state).toBe('FINISHED');
    });
  });
});
