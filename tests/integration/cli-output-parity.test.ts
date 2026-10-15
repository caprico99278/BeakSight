// T24a（Task 24 の設計書 4.1、7 章の「中核の切り出し」）: `run` のコマンドを、型つきの中核と CLI の表示に分けても、CLI の標準出力・
// 標準エラー・終了コードが 1 文字も変わらないことを確かめる比べのテスト。
// - 基準（`cli-output-parity.golden.json`）は、切り出す前のコードで、この同じ場面を実行して記録したものである（RED と GREEN の順を守る
//   ため、切り出しの前に作った）。記録し直すのは、CLI の出力を意図して変えたときだけで、環境変数 `BEAKSIGHT_RECORD_CLI_PARITY_GOLDEN` を
//   `1` にして、このファイルだけを実行する（基準のファイルを書き直す）。ふだんは、基準のファイルを読んで比べるだけで、書かない。
// - fixture のサイトを 127.0.0.1 で起動し、同じプロセスの中の `runCli`（`run --config <ファイル> --output <出力先> --headless`）で監査する
//   （Chromium は headless だけ）。`index.ts` と同じく、止める印は `CliDependencies.stopSignal` で渡す。
// - 揺れる値（fixture のサーバの Origin、作業のディレクトリ、Run の ID、ChatGPT 用バンドルの名前の時刻、BeakSight の版、経過時間、
//   要求の直近 1 分の件数と 1 分あたりの最大（時刻の区切りに左右される）は、決まった印に置き換えてから比べる。Run の ID は、場面の中で現れた順に番号をつける（別の Run を取り違えていないことも比べる）。
// 場面: 新しく始める、途中で止める（PARTIAL）、再開する、実行中の Run がある、設定の違いで再開せずに新しく始める、版の違いで再開できない。
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { runCli, type CliDependencies } from '../../src/cli/main.js';
import type { RunCommandDependencies } from '../../src/cli/run-command.js';
import { artifactFilePath, checkpointArtifactRelativePath, isBundleFileName, runArtifactDirectory } from '../../src/core/artifact-layout.js';
import { createRunId } from '../../src/core/ids.js';
import { readToolVersion } from '../../src/orchestration/environment.js';
import { createRunLock, currentProcessRunLockHost } from '../../src/orchestration/run-checkpoint.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import { CLI_TEXT, countWithPeakPerMinuteText, countWithRecentAndPeakPerMinuteText } from '../../src/presentation/messages.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { captureCliOutput, cliTargetConfig, createRunLauncher, readJson } from '../helpers/run-harness.js';

const SUITE_TIMEOUT_MS = 600_000;
const START_PATH = '/crawl/index.html';
/** 設定の対象の ID。 */
const TARGET_ID = 'cli-output-parity';
/** 止める場面で、止める印を付ける前に監査を終えるページの数。 */
const PAGES_BEFORE_STOP = 2;
/** 設定の違いと版の違いの場面の、短い Run のページ数の上限。 */
const SHORT_RUN_MAX_PAGES = 2;
/** 設定の違いの場面で、2 回目に使うページ数の上限（1 回目と違う値）。 */
const DIFFERENT_MAX_PAGES = SHORT_RUN_MAX_PAGES + 1;
/** 版の違いの場面で、保存に書く BeakSight の版。 */
const SAVED_TOOL_VERSION = '0.0.0-saved-by-another-version';
/** 実行中の Run の場面の、ロックだけがある Run の ID の連番。 */
const ACTIVE_RUN_SEQUENCE = 20261001000000;
/** 基準のファイル。 */
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cli-output-parity.golden.json');
/** 基準のファイルを記録し直す環境変数（値が `1` のときだけ書く）。 */
const RECORD_ENVIRONMENT_VARIABLE = 'BEAKSIGHT_RECORD_CLI_PARITY_GOLDEN';
const RECORDING = process.env[RECORD_ENVIRONMENT_VARIABLE] === '1';

/** 1 回の CLI の実行の、揺れる値を印に置き換えた結果。 */
interface NormalizedCliOutcome {
  readonly code: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

/** 場面の名前と、その場面の CLI の実行の結果の一覧（実行の順）。 */
type ParityScenarios = Record<string, readonly NormalizedCliOutcome[]>;

let server: FixtureServer;
let workDirectory: string;
let toolVersion: string;
const runLauncher = createRunLauncher();
const observed: Record<string, NormalizedCliOutcome[]> = {};

beforeAll(async () => {
  server = await startFixtureServer();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-output-parity-'));
  toolVersion = await readToolVersion();
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = await runLauncher.closeAll();
  await server?.close();
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
  }
  expect(leftovers, 'Browsers left connected after the Runs').toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------
// 揺れる値の置き換え
// ---------------------------------------------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const RUN_ID_PATTERN = /RUN-[0-9]{6,}/gu;
/** パスの区切りを `/` にしたときの、ZIP のファイルの名前の候補（バンドルの名前かは `isBundleFileName` で確かめる）。 */
const ZIP_FILE_NAME_PATTERN = /[^/\s]+\.zip/gu;
/** 進み具合の行の、経過時間の項目（行の最後の項目）。 */
const ELAPSED_ITEM_PATTERN = new RegExp(`${escapeRegExp(`${CLI_TEXT.progress.elapsed} `)}[^・]*$`, 'u');

/** 文言の部品の、値を入れる場所の印（文言に現れない制御文字）。 */
const SLOTS = Object.freeze(['', '', ''] as const);

/**
 * 文言の部品（`build`）に印を入れて作った文字列から、値の場所を `(.+?)` にした正規表現を作る。`markers` の項目が `null` の場所は、
 * 値をそのまま残し、文字列の場所は、その印に置き換える置き換えの関数と組にして返す。
 */
function slotReplacement(
  build: (...values: string[]) => string,
  markers: readonly (string | null)[],
): { readonly pattern: RegExp; readonly replace: (match: string, ...groups: string[]) => string } {
  const template = build(...SLOTS.slice(0, markers.length));
  let source = escapeRegExp(template);
  for (const slot of SLOTS.slice(0, markers.length)) {
    source = source.replace(slot, '(.+?)');
  }
  return {
    pattern: new RegExp(source, 'gu'),
    replace: (_match, ...groups) => {
      let text = template;
      markers.forEach((marker, index) => {
        text = text.replace(SLOTS[index] ?? '', marker ?? groups[index] ?? '');
      });
      return text;
    },
  };
}

/** 要求の件数の、直近 1 分の件数と 1 分あたりの最大（進み具合の行）と、1 分あたりの最大（結果の行）の置き換え。 */
const REQUEST_RATE_REPLACEMENTS = [
  slotReplacement(countWithRecentAndPeakPerMinuteText, [null, '<RECENT>', '<PEAK>']),
  slotReplacement(countWithPeakPerMinuteText, [null, '<PEAK>']),
];

/**
 * 揺れる値を印に置き換える。Run の ID は、`runIds`（場面の中で共有する）に現れた順に番号をつける。
 * 置き換えの順: 作業のディレクトリ（区切りを `/` にする）→ Origin → Run の ID → バンドルの名前 → BeakSight の版 → 要求の直近 1 分の
 * 件数と 1 分あたりの最大 → 経過時間。
 */
function normalizeLine(line: string, runIds: Map<string, string>): string {
  let text = line;
  for (const directory of new Set([workDirectory, resolve(workDirectory)])) {
    text = text.split(directory).join('<WORK>');
  }
  text = text.split('\\').join('/');
  text = text.split(server.origin).join('<ORIGIN>');
  text = text.replace(RUN_ID_PATTERN, (runId) => {
    const known = runIds.get(runId);
    if (known !== undefined) {
      return known;
    }
    const marker = `<RUN_ID_${String(runIds.size + 1)}>`;
    runIds.set(runId, marker);
    return marker;
  });
  text = text.replace(ZIP_FILE_NAME_PATTERN, (name) => (isBundleFileName(name) ? '<BUNDLE>' : name));
  text = text.split(toolVersion).join('<TOOL_VERSION>');
  for (const { pattern, replace } of REQUEST_RATE_REPLACEMENTS) {
    text = text.replace(pattern, replace);
  }
  return text.replace(ELAPSED_ITEM_PATTERN, `${CLI_TEXT.progress.elapsed} <ELAPSED>`);
}

const normalizeText = (text: string, runIds: Map<string, string>): readonly string[] =>
  text.split('\n').map((line) => normalizeLine(line, runIds));

// ---------------------------------------------------------------------------------------------------------------
// CLI の実行
// ---------------------------------------------------------------------------------------------------------------

/** 場面ごとの、設定のファイルと出力先。 */
interface ScenarioPaths {
  readonly outputDirectory: string;
  readonly configPath: (variant: string) => string;
}

const pathsFor = (scenario: string): ScenarioPaths => ({
  outputDirectory: join(workDirectory, `${scenario}-output`),
  configPath: (variant) => join(workDirectory, `${scenario}-${variant}.json`),
});

/** 設定のファイルを書く（`/crawl/` の fixture。スクリーンショットはとらない）。`maxPages` を渡すと、ページ数の上限を変える。 */
async function writeConfig(path: string, maxPages?: number): Promise<void> {
  const crawl = maxPages === undefined ? { minNavigationIntervalMs: 0 } : { minNavigationIntervalMs: 0, maxPages };
  await writeFile(path, JSON.stringify(cliTargetConfig(TARGET_ID, server.origin, START_PATH, {
    crawl,
    audit: { screenshots: false },
  })), 'utf8');
}

/** `k` ページ目の監査が終わったときに、止める印を付ける Run Coordinator を作る関数（`cli-resume.test.ts` と同じ考え方）。 */
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

/** `runCli` で `run` を実行し、揺れる値を置き換えた結果を、場面の記録に加えて返す。 */
async function runScenarioStep(
  scenario: string,
  runIds: Map<string, string>,
  input: { readonly configPath: string; readonly outputDirectory: string; readonly stopAfterPages?: number },
): Promise<NormalizedCliOutcome> {
  const stdout = captureCliOutput();
  const stderr = captureCliOutput();
  const run: RunCommandDependencies = { launchBrowser: runLauncher.launcher, clock: () => new Date(), now: () => Date.now() };
  let dependencies: CliDependencies = { run };
  if (input.stopAfterPages !== undefined) {
    const controller = new AbortController();
    dependencies = { run: { ...run, createRunCoordinator: stoppingAfter(controller, input.stopAfterPages) }, stopSignal: controller.signal };
  }
  const code = await runCli(
    ['run', '--config', input.configPath, '--output', input.outputDirectory, '--headless'],
    { stdout: stdout.output, stderr: stderr.output },
    dependencies,
  );
  const outcome: NormalizedCliOutcome = {
    code,
    stdout: normalizeText(stdout.text(), runIds),
    stderr: normalizeText(stderr.text(), runIds),
  };
  (observed[scenario] ??= []).push(outcome);
  return outcome;
}

/** 出力先の直下の、ただ1つの Run のディレクトリ。 */
async function onlyRunDirectoryIn(outputDirectory: string): Promise<string> {
  const entries = (await readdir(outputDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  expect(entries).toHaveLength(1);
  return join(outputDirectory, entries[0]?.name ?? '');
}

// ---------------------------------------------------------------------------------------------------------------
// 場面
// ---------------------------------------------------------------------------------------------------------------

/** 基準のファイルの内容（記録し直すときは空）。 */
const readGolden = (): ParityScenarios => (RECORDING ? {} : JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as ParityScenarios);

describe('T24a: the CLI output of the run command is the same as before the core was split out (Task 24 design 4.1, 7)', () => {
  const golden = readGolden();

  const expectSameAsGolden = (scenario: string): void => {
    if (RECORDING) {
      return;
    }
    expect(golden[scenario], `the golden file has no scenario ${scenario}`).toBeDefined();
    expect(observed[scenario]).toEqual(golden[scenario]);
  };

  it('starts a new Run', async () => {
    const scenario = 'newRun';
    const paths = pathsFor(scenario);
    await writeConfig(paths.configPath('config'));
    await runScenarioStep(scenario, new Map(), { configPath: paths.configPath('config'), outputDirectory: paths.outputDirectory });
    expectSameAsGolden(scenario);
  }, SUITE_TIMEOUT_MS);

  it('stops a Run with the stop signal (PARTIAL), and resumes it with the same command', async () => {
    const scenario = 'stopAndResume';
    const paths = pathsFor(scenario);
    const runIds = new Map<string, string>();
    await writeConfig(paths.configPath('config'));
    const input = { configPath: paths.configPath('config'), outputDirectory: paths.outputDirectory };
    await runScenarioStep(scenario, runIds, { ...input, stopAfterPages: PAGES_BEFORE_STOP });
    await runScenarioStep(scenario, runIds, input);
    expectSameAsGolden(scenario);
  }, SUITE_TIMEOUT_MS);

  it('does not start a Run while another Run is running in the output directory', async () => {
    const scenario = 'activeRun';
    const paths = pathsFor(scenario);
    const runDirectory = runArtifactDirectory(paths.outputDirectory, createRunId(ACTIVE_RUN_SEQUENCE));
    await expect(new ArtifactWriter().acquireRunLock(runDirectory, createRunLock(currentProcessRunLockHost(Date.now()))))
      .resolves.toEqual({ acquired: true });
    await writeConfig(paths.configPath('config'));
    await runScenarioStep(scenario, new Map(), { configPath: paths.configPath('config'), outputDirectory: paths.outputDirectory });
    expectSameAsGolden(scenario);
  }, SUITE_TIMEOUT_MS);

  it('starts a new Run with a notice when the interrupted Run has a different configuration', async () => {
    const scenario = 'configDiffers';
    const paths = pathsFor(scenario);
    const runIds = new Map<string, string>();
    await writeConfig(paths.configPath('first'), SHORT_RUN_MAX_PAGES);
    await writeConfig(paths.configPath('second'), DIFFERENT_MAX_PAGES);
    await runScenarioStep(scenario, runIds, {
      configPath: paths.configPath('first'),
      outputDirectory: paths.outputDirectory,
      stopAfterPages: 1,
    });
    await runScenarioStep(scenario, runIds, { configPath: paths.configPath('second'), outputDirectory: paths.outputDirectory });
    expectSameAsGolden(scenario);
  }, SUITE_TIMEOUT_MS);

  it('does not resume the interrupted Run of another version', async () => {
    const scenario = 'versionDiffers';
    const paths = pathsFor(scenario);
    const runIds = new Map<string, string>();
    await writeConfig(paths.configPath('config'), SHORT_RUN_MAX_PAGES);
    const input = { configPath: paths.configPath('config'), outputDirectory: paths.outputDirectory };
    await runScenarioStep(scenario, runIds, { ...input, stopAfterPages: 1 });
    const runDirectory = await onlyRunDirectoryIn(paths.outputDirectory);
    const statePath = artifactFilePath(runDirectory, checkpointArtifactRelativePath('state'));
    const state = await readJson(statePath) as Record<string, unknown>;
    await writeFile(statePath, `${JSON.stringify({ ...state, toolVersion: SAVED_TOOL_VERSION }, null, 2)}\n`, 'utf8');
    await runScenarioStep(scenario, runIds, input);
    expectSameAsGolden(scenario);
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    if (RECORDING) {
      await writeFile(GOLDEN_PATH, `${JSON.stringify(observed, null, 2)}\n`, 'utf8');
    }
  });
});
