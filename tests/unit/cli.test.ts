// U17a（Task 14〜17 の設計書 第7章、6.1.5、実装計画 Task 17 の Step 1・3）: 一時的なビルドの CLI を起動し、設定の誤りと引数の誤りが、
// 日本語の文言、スタックトレースなし、終了コード 4（CONFIG_ERROR）になることを確かめる。ブラウザは起動しない。
// 以前の期待値（英語の `configuration valid`、`usage: …`、`run` のスタブの終了コード 1）は、設計書 第7章の新しい仕様に合わせて直した。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { CLI_OPTION_NAMES, parseCliArguments } from '../../src/cli/arguments.js';
import {
  CONFIG_ERROR_EXIT_CODE,
  CONFIG_ERROR_OUTCOME,
  EXIT_CODES,
  FAILURE_EXIT_CODE,
  INTERRUPTED_EXIT_CODE,
  INTERRUPTED_OUTCOME,
  RUN_UNAVAILABLE_EXIT_CODE,
  RUN_UNAVAILABLE_OUTCOME,
  SUCCESS_EXIT_CODE,
} from '../../src/cli/exit-codes.js';
import { resolveRunCommandDependencies, runCli } from '../../src/cli/main.js';
import {
  MAX_LISTED_CONFIG_DIFFERENCES,
  activeRunLines,
  checkpointFinishFailedLines,
  differentConfigRunLines,
  differentVersionRunLines,
  finalizingRunLines,
  finishedCheckpointCleanupFailedLines,
  joinLines,
  resumingRunLines,
  runNoticeLines,
  runProgressLines,
  runSummaryLines,
  unreadableCheckpointLines,
  usageLines,
} from '../../src/cli/output.js';
import { streamOutput, type CliOutput } from '../../src/cli/output-stream.js';
import { PRODUCTION_RUN_DEPENDENCIES, type RunCommandDependencies } from '../../src/cli/run-command.js';
import { isConfigError } from '../../src/config/config-error.js';
import {
  RUN_ARTIFACT_FILE_NAMES,
  artifactFilePath,
  bundleFileName,
  checkpointArtifactRelativePath,
  checkpointPageArtifactRelativePath,
  isBundleFileName,
  runArtifactDirectory,
} from '../../src/core/artifact-layout.js';
import {
  RUN_EXECUTION_END_REASONS,
  type AuditRunResult,
  type RunExecutionEndReason,
  type RunLoad,
  type RunProgressReport,
  type RunSummary,
} from '../../src/core/contracts.js';
import type { RunCheckpoint } from '../../src/orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../../src/orchestration/run-checkpoint-session.js';
import {
  SITE_UNAVAILABLE_RECHECK_DELAYS_MS,
  type RunCoordinatorCheckpointConclusion,
  type RunNotice,
} from '../../src/orchestration/run-coordinator.js';
import {
  RUN_EXECUTION_END_REASON_CATALOG,
  RUN_STATUS_CATALOG,
  SEVERITY_GROUP_CATALOG,
  SEVERITY_GROUPS,
  sortByDisplayOrder,
} from '../../src/presentation/catalog.js';
import { formatCount, formatDuration, formatElapsedTime, formatRequestsWithPeak, formatTimes } from '../../src/presentation/format.js';
import {
  CLI_OPTION_DESCRIPTIONS,
  CLI_TEXT,
  RUN_SUMMARY_TEXT,
  activeRunInOutputDirectoryText,
  cliCountText,
  cliFieldText,
  countWithDetailsText,
  describeConfigError,
  differentConfigRunText,
  finalizingRunText,
  findingGroupCountsLabelText,
  finishedCheckpointCleanupFailedText,
  labelWithCodeText,
  listText,
  progressItemsText,
  resumingRunText,
  siteUnavailableRecheckText,
  siteUnavailableSlowdownText,
  siteUnavailableStopText,
  unreadableCheckpointText,
} from '../../src/presentation/messages.js';
import { ArtifactWriter } from '../../src/report/artifact-writer.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import {
  FIXTURE_RUN_ID,
  PAGE_1,
  auditRun,
  edgeCaseAuditRun,
  executionsDisplaySample,
  loadDisplaySample,
} from '../helpers/audit-run-fixture.js';
import { createDeferred } from '../helpers/deferred.js';
import { sampleRunCheckpoint, sampleRunCheckpointPage } from '../helpers/run-checkpoint-samples.js';
import { captureCliOutput } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, snapshotDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';

const rootDirectory = process.cwd();
const repositoryDistDirectory = resolve(rootDirectory, 'dist');
const JAPANESE_CHARACTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/** スタックトレースの行（`    at foo (file:1:2)`）。 */
const STACK_TRACE_LINE = /^\s+at\s/mu;
/** 設定の検証のテストの対象（ブラウザを起動しないので、アクセスはしない）。 */
const LOOPBACK_ORIGIN = 'http://127.0.0.1:9';

let build: TemporaryBuild | undefined;
let distBefore: Awaited<ReturnType<typeof snapshotDirectory>>;
let workDirectory: string;

const invokeCli = (...arguments_: string[]) => {
  if (build === undefined) {
    throw new Error('the temporary build is not ready');
  }
  return spawnSync(process.execPath, [join(build.distDirectory, 'cli', 'index.js'), ...arguments_], {
    cwd: rootDirectory,
    encoding: 'utf8',
  });
};

const writeConfig = async (name: string, contents: unknown): Promise<string> => {
  const path = join(workDirectory, name);
  await writeFile(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return path;
};

// `run` にも使うので、ページの読み込みの最小の間隔は 0 にする（ループバックの Origin。サイトへの負荷の制御の設計書 4.2）。
const validTarget = {
  target: { id: 'cli-unit' },
  site: { startUrl: `${LOOPBACK_ORIGIN}/`, allowedOrigins: [LOOPBACK_ORIGIN] },
  crawl: { minNavigationIntervalMs: 0 },
};

/** 設定のエラーの共通の確かめ: 終了コード 4、標準出力は空、標準エラーは日本語の文言で、スタックトレースがない。 */
const expectConfigError = (result: ReturnType<typeof invokeCli>, description: string): void => {
  expect(result.status, result.stderr).toBe(CONFIG_ERROR_EXIT_CODE);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(description);
  expect(result.stderr).toMatch(JAPANESE_CHARACTER);
  expect(result.stderr).not.toMatch(STACK_TRACE_LINE);
};

/**
 * `run` の結果の、サイトへの負荷の1行の期待値（L6）。項目の名前は `messages.ts`、回数の書式は `formatTimes`、要求の件数と
 * 1分あたりの最大の書式は `formatRequestsWithPeak` のもの（L7）。値は、渡した記録のまま使う（テストの側でも数え直さない）。
 */
const expectedLoadLine = (load: RunLoad): string =>
  cliFieldText(
    RUN_SUMMARY_TEXT.loadHeading,
    listText([
      cliCountText(CLI_TEXT.run.navigationCount, formatTimes(load.navigationCount)),
      cliCountText(RUN_SUMMARY_TEXT.allowedOriginRequests, formatRequestsWithPeak(load.requests.allowedOrigins)),
    ]),
  );

/**
 * `run` の結果の、実行の記録の1行の期待値（R6。中断した Run の再開の設計書 4.8 の「表示」）。項目の名前は `messages.ts`、回数の書式は
 * `formatTimes` のもの。回数は、渡した値のまま使う（テストの側でも数え直さない）。
 */
const expectedExecutionsLine = (count: number, resumeCount: number): string =>
  cliFieldText(CLI_TEXT.run.executions, listText([formatTimes(count), cliCountText(CLI_TEXT.run.resumes, formatTimes(resumeCount))]));

/**
 * `run` の結果の、この起動の終わり方の1行の期待値（R9。中断した Run の再開の設計書 4.8 の 2026-10-08 の追補）。見出しは `messages.ts`、
 * ラベルは表示カタログ `RUN_EXECUTION_END_REASON_CATALOG`、書式は Run の状態の行と同じ `labelWithCodeText` と `cliFieldText` のもの。
 */
const expectedLastEndReasonLine = (endReason: RunExecutionEndReason): string =>
  cliFieldText(CLI_TEXT.run.lastEndReason, labelWithCodeText(RUN_EXECUTION_END_REASON_CATALOG[endReason].label, endReason));

/**
 * 実行中の進み具合の1行の期待値（L7。サイトへの負荷の制御の設計書 4.8）。項目の名前は `messages.ts`、書式は `format.ts` のもの。
 * 値は、渡した事実のまま使う（テストの側でも計算しない）。
 */
const expectedProgressLine = (report: RunProgressReport): string =>
  cliFieldText(
    CLI_TEXT.progress.heading,
    progressItemsText([
      cliCountText(
        CLI_TEXT.progress.pagesFinished,
        countWithDetailsText(formatCount(report.pagesFinished), [
          cliCountText(RUN_SUMMARY_TEXT.coverage.discovered, formatCount(report.pagesDiscovered)),
          cliCountText(CLI_TEXT.progress.maxPages, formatCount(report.maxPages)),
        ]),
      ),
      cliCountText(CLI_TEXT.run.navigationCount, formatTimes(report.navigationCount)),
      cliCountText(
        RUN_SUMMARY_TEXT.allowedOriginRequests,
        formatRequestsWithPeak(report.requests.allowedOrigins, report.recentPerMinute.allowedOrigins),
      ),
      cliCountText(CLI_TEXT.progress.otherOriginRequests, formatCount(report.requests.otherOrigins.count)),
      cliCountText(CLI_TEXT.progress.elapsed, formatElapsedTime(report.elapsedMs)),
    ]),
  );

/** 進み具合の事実の見本（L7）。項目ごとに異なる値にして、どの項目の値が行のどこに出たかを見分けられるようにする。 */
const progressSample: RunProgressReport = {
  pagesFinished: 12,
  pagesDiscovered: 85,
  maxPages: 50,
  elapsedMs: (24 * 60 + 10) * 1000,
  navigationCount: 284,
  pacingWaitMs: 98_765,
  requests: {
    allowedOrigins: { count: 1930, peakPerMinute: 61 },
    otherOrigins: { count: 12, peakPerMinute: 4 },
    servedFromCache: 700,
    withheldOtherOrigins: 9,
  },
  recentPerMinute: { allowedOrigins: 38, otherOrigins: 2 },
};

beforeAll(async () => {
  distBefore = await snapshotDirectory(repositoryDistDirectory);
  build = await buildIntoTemporaryDirectory();
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-cli-unit-'));
});

afterAll(async () => {
  const temporaryRoot = build?.rootDirectory;
  await build?.remove();
  build = undefined;
  if (temporaryRoot !== undefined) {
    expect(existsSync(temporaryRoot)).toBe(false);
  }
  await rm(workDirectory, { recursive: true, force: true });
});

describe('CLI: validate-config', () => {
  it('reports a valid configuration in Japanese and exits with 0', async () => {
    const path = await writeConfig('valid.json', validTarget);

    const result = invokeCli('validate-config', '--config', path);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(CLI_TEXT.validateConfig.succeeded);
    expect(result.stdout).toContain('cli-unit');
    expect(result.stdout).toMatch(JAPANESE_CHARACTER);
  });

  it('accepts the CLI overrides that are not in conflict', async () => {
    const path = await writeConfig('valid-overrides.json', validTarget);

    expect(invokeCli('validate-config', '--config', path, '--headed', '--output', 'elsewhere').status).toBe(0);
    expect(invokeCli('validate-config', '--config', path, '--headless').status).toBe(0);
  });

  it('reports validation errors as CONFIG_ERROR, with the English validation errors as technical details', async () => {
    const path = await writeConfig('invalid.json', { ...validTarget, crawl: { maxPages: 1.5 } });

    const result = invokeCli('validate-config', '--config', path);

    expectConfigError(result, describeConfigError('CONFIG_INVALID'));
    expect(result.stderr).toContain(CLI_TEXT.detailsHeading);
    expect(result.stderr).toContain('crawl.maxPages must be a positive integer');
  });

  it('reports a configuration file that does not exist as CONFIG_ERROR', () => {
    const path = join(workDirectory, 'does-not-exist.json');

    const result = invokeCli('validate-config', '--config', path);

    expectConfigError(result, describeConfigError('CONFIG_FILE_NOT_FOUND'));
    expect(result.stderr).toContain(path);
  });

  it('reports a configuration file that is not JSON as CONFIG_ERROR', async () => {
    const path = await writeConfig('broken.json', '{"target": ');

    const result = invokeCli('validate-config', '--config', path);

    expectConfigError(result, describeConfigError('CONFIG_JSON_INVALID'));
  });
});

describe('CLI: arguments', () => {
  it('rejects --headed together with --headless as CONFIG_ERROR, for both commands', async () => {
    const path = await writeConfig('conflict.json', validTarget);

    for (const command of ['validate-config', 'run']) {
      const result = invokeCli(command, '--config', path, '--headed', '--headless');
      expectConfigError(result, describeConfigError('CONFLICTING_ARGUMENTS'));
      expect(result.stderr).toContain('--headed');
      expect(result.stderr).toContain('--headless');
    }
  });

  it('rejects an unknown command as CONFIG_ERROR and shows the usage in Japanese', () => {
    const result = invokeCli('unexpected-command');

    expectConfigError(result, describeConfigError('UNKNOWN_COMMAND'));
    expect(result.stderr).toContain('unexpected-command');
    expect(result.stderr).toContain(CLI_TEXT.usage.heading);
  });

  it('rejects a missing command as CONFIG_ERROR and shows the usage', () => {
    const result = invokeCli();

    expectConfigError(result, describeConfigError('COMMAND_MISSING'));
    expect(result.stderr).toContain(CLI_TEXT.usage.heading);
  });

  it('rejects unknown options, a missing option value and extra arguments as CONFIG_ERROR and shows the usage', async () => {
    const path = await writeConfig('arguments.json', validTarget);

    for (const arguments_ of [
      ['validate-config', '--config', path, '--unknown-option'],
      ['run', '--config', path, '--verbose'],
      ['validate-config', '--config'],
      ['validate-config', '--config', path, 'extra-argument'],
    ]) {
      const result = invokeCli(...arguments_);
      expectConfigError(result, describeConfigError('INVALID_ARGUMENTS'));
      expect(result.stderr, arguments_.join(' ')).toContain(CLI_TEXT.usage.heading);
    }
  });

  // R17f（設計書 第7章、R17 の指摘3）: 値を取るオプションを2回以上指定した場合は、後の値を黙って使わずに、CONFIG_ERROR にする。
  it('rejects --config or --output given more than once as CONFIG_ERROR (INVALID_ARGUMENTS) and shows the usage', async () => {
    const path = await writeConfig('duplicated.json', validTarget);
    const other = await writeConfig('duplicated-other.json', validTarget);

    for (const [arguments_, option] of [
      [['validate-config', '--config', path, '--config', other], '--config'],
      [['validate-config', `--config=${path}`, '--config', other], '--config'],
      [['validate-config', '--config', path, '--output', 'first', '--output', 'second'], '--output'],
      [['validate-config', '--config', path, '--output', 'first', '--output=second'], '--output'],
    ] as const) {
      const result = invokeCli(...arguments_);
      expectConfigError(result, describeConfigError('INVALID_ARGUMENTS'));
      expect(result.stderr, arguments_.join(' ')).toContain(`${option} was given more than once`);
      expect(result.stderr, arguments_.join(' ')).toContain(CLI_TEXT.usage.heading);
    }
  });

  it('rejects a duplicated option of run as CONFIG_ERROR without starting the audit', async () => {
    const path = await writeConfig('duplicated-run.json', validTarget);
    const first = join(workDirectory, 'duplicated-run-first');
    const second = join(workDirectory, 'duplicated-run-second');
    const errors: string[] = [];
    let launched = 0;

    const code = await runCli(
      ['run', '--config', path, '--output', first, '--output', second],
      { stdout: { write: async () => undefined }, stderr: { write: async (text) => { errors.push(text); } } },
      {
        run: {
          launchBrowser: async () => {
            launched += 1;
            throw new Error('the browser must not be launched for a duplicated option');
          },
          clock: () => new Date(),
          now: () => Date.now(),
        },
      },
    );

    expect(code).toBe(CONFIG_ERROR_EXIT_CODE);
    expect(errors.join('')).toContain(describeConfigError('INVALID_ARGUMENTS'));
    expect(errors.join('')).toContain('--output was given more than once');
    expect(launched).toBe(0);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  it('shows every exit code of the table in the usage', () => {
    const result = invokeCli('unexpected-command');

    for (const code of Object.values(EXIT_CODES)) {
      expect(result.stderr).toMatch(new RegExp(`^\\s*${code}\\s`, 'mu'));
    }
  });

  // R5a（中断した Run の再開の設計書 4.7）: `--new` は値を取らない。付けると、途中の Run を探さずに、新しい Run を始める（run のときだけ）。
  it('parses --new of run as startNew, and leaves startNew false without it', () => {
    expect(parseCliArguments(['run', '--new'])).toMatchObject({ kind: 'command', command: 'run', startNew: true });
    expect(parseCliArguments(['run', '--config', 'target.json', '--new', '--headless'])).toEqual({
      kind: 'command',
      command: 'run',
      configPath: 'target.json',
      overrides: { browser: { headed: false } },
      startNew: true,
    });
    expect(parseCliArguments(['run'])).toMatchObject({ kind: 'command', command: 'run', startNew: false });
    expect(parseCliArguments(['validate-config'])).toMatchObject({ kind: 'command', command: 'validate-config', startNew: false });
  });

  it('rejects --new with a value as CONFIG_ERROR (INVALID_ARGUMENTS), because it takes no value', () => {
    let thrown: unknown;
    try {
      parseCliArguments(['run', '--new=yes']);
    } catch (error) {
      thrown = error;
    }
    expect(isConfigError(thrown) ? thrown.kind : thrown).toBe('INVALID_ARGUMENTS');
    // 知らないオプションではなく、値を取らないオプションとして拒む。
    expect(isConfigError(thrown) ? thrown.details : []).toEqual([expect.stringContaining("'--new' does not take an argument")]);
  });

  it('rejects --new of validate-config as CONFIG_ERROR (INVALID_ARGUMENTS) and shows the usage', async () => {
    const path = await writeConfig('validate-with-new.json', validTarget);

    let thrown: unknown;
    try {
      parseCliArguments(['validate-config', '--new']);
    } catch (error) {
      thrown = error;
    }
    expect(isConfigError(thrown) ? thrown.kind : thrown).toBe('INVALID_ARGUMENTS');
    // 知らないオプションではなく、run のときだけのオプションとして拒む。
    expect(isConfigError(thrown) ? thrown.details : []).toEqual(['--new can be given only with the run command']);

    const result = invokeCli('validate-config', '--config', path, '--new');
    expectConfigError(result, describeConfigError('INVALID_ARGUMENTS'));
    expect(result.stderr).toContain('--new can be given only with the run command');
    expect(result.stderr).toContain(CLI_TEXT.usage.heading);
  });
});

describe('CLI: run with a configuration error', () => {
  it('reports a configuration error of run as CONFIG_ERROR without starting the audit', async () => {
    const missing = join(workDirectory, 'run-missing.json');
    const invalid = await writeConfig('run-invalid.json', { ...validTarget, site: { startUrl: 'ftp://127.0.0.1/', allowedOrigins: [LOOPBACK_ORIGIN] } });
    const output = join(workDirectory, 'run-output');

    expectConfigError(invokeCli('run', '--config', missing, '--output', output), describeConfigError('CONFIG_FILE_NOT_FOUND'));
    expectConfigError(invokeCli('run', '--config', invalid, '--output', output), describeConfigError('CONFIG_INVALID'));
    expect(existsSync(output)).toBe(false);
  });
});

// C17a（設計書 第7章）: `--help` は、使い方（引数の誤りのときと同じもの）を標準出力に示し、終了コード 0 で終える。
// Run は実行せず、設定も読まない。
describe('CLI: --help', () => {
  const HELP_ARGUMENTS: readonly (readonly string[])[] = [['--help'], ['run', '--help'], ['validate-config', '--help']];

  it('shows the same usage as the argument errors on stdout and exits with 0, for the program and for each command', () => {
    const errorResult = invokeCli('unexpected-command');
    for (const arguments_ of HELP_ARGUMENTS) {
      const result = invokeCli(...arguments_);
      expect(result.status, `${arguments_.join(' ')}: ${result.stderr}`).toBe(SUCCESS_EXIT_CODE);
      expect(result.stderr, arguments_.join(' ')).toBe('');
      expect(result.stdout, arguments_.join(' ')).toBe(joinLines(usageLines()));
      expect(result.stdout, arguments_.join(' ')).toMatch(JAPANESE_CHARACTER);
      // 引数の誤りのときに示す使い方と、同じ行である（使い方を2つ持たない）。
      expect(errorResult.stderr.endsWith(result.stdout), arguments_.join(' ')).toBe(true);
    }
  });

  it('neither reads the configuration nor runs the audit', async () => {
    const missing = join(workDirectory, 'help-missing.json');
    const output = join(workDirectory, 'help-output');
    let launched = 0;
    for (const arguments_ of HELP_ARGUMENTS) {
      const texts: string[] = [];
      const errors: string[] = [];
      const code = await runCli(
        [...arguments_, '--config', missing, '--output', output],
        {
          stdout: { write: async (text) => { texts.push(text); } },
          stderr: { write: async (text) => { errors.push(text); } },
        },
        {
          run: {
            launchBrowser: async () => {
              launched += 1;
              throw new Error('the browser must not be launched for --help');
            },
            clock: () => new Date(),
            now: () => Date.now(),
          },
        },
      );
      expect(code, arguments_.join(' ')).toBe(SUCCESS_EXIT_CODE);
      expect(errors.join(''), arguments_.join(' ')).toBe('');
      expect(texts.join(''), arguments_.join(' ')).toBe(joinLines(usageLines()));
    }
    expect(launched).toBe(0);
    expect(existsSync(output)).toBe(false);
  });

  // R17f（C17a の持ち越し。設計書 第7章）: 使い方の表示に、`--help` も載せる。文言は `messages.ts` のもの。
  it('lists --help with its Japanese description among the options of the usage', () => {
    const lines = invokeCli('--help').stdout.split('\n');
    const optionsHeading = lines.indexOf(`${CLI_TEXT.usage.optionsHeading}:`);
    const exitCodesHeading = lines.indexOf(`${CLI_TEXT.usage.exitCodesHeading}:`);
    const helpLine = lines.indexOf('  --help');

    expect(helpLine).toBeGreaterThan(optionsHeading);
    expect(helpLine).toBeLessThan(exitCodesHeading);
    expect(lines[helpLine + 1]).toMatch(JAPANESE_CHARACTER);
    expect(lines[helpLine + 1]?.trim()).toBe(CLI_OPTION_DESCRIPTIONS.help.description);
  });

  // DEF-017（設計書 3.1、7章）: `--headed` と `--headless` の説明は、どちらも設定の browser.headed を上書きすることを書く。
  it('describes both --headed and --headless as overriding browser.headed of the configuration', () => {
    for (const option of ['headed', 'headless'] as const) {
      const { description } = CLI_OPTION_DESCRIPTIONS[option];

      expect(description, option).toContain('browser.headed');
      expect(description, option).toContain('上書き');
    }
  });

  it('lists --headless with its description among the options of the usage', () => {
    const lines = invokeCli('--help').stdout.split('\n');
    const optionsHeading = lines.indexOf(`${CLI_TEXT.usage.optionsHeading}:`);
    const exitCodesHeading = lines.indexOf(`${CLI_TEXT.usage.exitCodesHeading}:`);
    const headlessLine = lines.indexOf('  --headless');

    expect(headlessLine).toBeGreaterThan(optionsHeading);
    expect(headlessLine).toBeLessThan(exitCodesHeading);
    expect(lines[headlessLine + 1]).toMatch(JAPANESE_CHARACTER);
    expect(lines[headlessLine + 1]?.trim()).toBe(CLI_OPTION_DESCRIPTIONS.headless.description);
  });

  // R5a（中断した Run の再開の設計書 4.7）: 使い方の表示に、`--new` も載せる。文言は `messages.ts` のもの。
  it('lists --new with its Japanese description among the options of the usage, after --headless and before --help', () => {
    const lines = invokeCli('--help').stdout.split('\n');
    const optionsHeading = lines.indexOf(`${CLI_TEXT.usage.optionsHeading}:`);
    const exitCodesHeading = lines.indexOf(`${CLI_TEXT.usage.exitCodesHeading}:`);
    const newLine = lines.indexOf('  --new');

    expect(newLine).toBeGreaterThan(optionsHeading);
    expect(newLine).toBeLessThan(exitCodesHeading);
    expect(newLine).toBeGreaterThan(lines.indexOf('  --headless'));
    expect(newLine).toBeLessThan(lines.indexOf('  --help'));
    expect(lines[newLine + 1]?.trim()).toBe(CLI_OPTION_DESCRIPTIONS.new.description);
    expect(CLI_OPTION_DESCRIPTIONS.new).toEqual({
      valueName: null,
      description: '途中の Run があっても、続きから再開せずに、新しい Run を始めます（run のときだけ）。',
    });
    expect(CLI_OPTION_NAMES).toContain('new');
  });

  // R5a（中断した Run の再開の設計書 4.7.1）: 終了コード 4 の行は、設定のエラーと、Run を始められない場合の2つになる。
  it('shows two rows of the exit code 4 in the usage: the configuration error and the Run that cannot start', () => {
    const lines = usageLines();
    const exitCodesHeading = lines.indexOf(`${CLI_TEXT.usage.exitCodesHeading}:`);
    const rowsOfFour = lines.slice(exitCodesHeading + 1).filter((line) => line.startsWith(`  ${RUN_UNAVAILABLE_EXIT_CODE}  `));

    expect(RUN_UNAVAILABLE_EXIT_CODE).toBe(CONFIG_ERROR_EXIT_CODE);
    expect(rowsOfFour).toEqual([
      `  ${CONFIG_ERROR_EXIT_CODE}  ${labelWithCodeText(CLI_TEXT.configErrorHeading, CONFIG_ERROR_OUTCOME)}`,
      `  ${RUN_UNAVAILABLE_EXIT_CODE}  ${labelWithCodeText(CLI_TEXT.runUnavailableHeading, RUN_UNAVAILABLE_OUTCOME)}`,
    ]);
    expect(CLI_TEXT.runUnavailableHeading).toBe('Run を始められない');
    // 表の行は、終了コードの順（小さい順）で、すべての結果の行がある。
    const rows = lines.slice(exitCodesHeading + 1);
    expect(rows).toHaveLength(Object.keys(EXIT_CODES).length);
    const codes = rows.map((line) => Number(line.trim().split(' ')[0]));
    expect(codes).toEqual([...codes].sort((left, right) => left - right));
  });

  // R5b（中断した Run の再開の設計書 4.7、4.7.1）: 終了コードの表に、中断（2回目のシグナル。最後の処理をしていない）の行を加える。
  // 書き方は、Run を始められない場合の行と同じ（ラベルは `CLI_TEXT`、結果の名前を添える）。
  it('shows the row of the exit code 5 (interrupted) as the last row of the exit codes in the usage', () => {
    const lines = usageLines();
    const exitCodesHeading = lines.indexOf(`${CLI_TEXT.usage.exitCodesHeading}:`);
    const rows = lines.slice(exitCodesHeading + 1);

    expect(INTERRUPTED_EXIT_CODE).toBe(5);
    expect(CLI_TEXT.interruptedHeading).toBe('中断');
    expect(rows.filter((line) => line.startsWith(`  ${INTERRUPTED_EXIT_CODE}  `))).toEqual([
      `  ${INTERRUPTED_EXIT_CODE}  ${labelWithCodeText(CLI_TEXT.interruptedHeading, INTERRUPTED_OUTCOME)}`,
    ]);
    expect(rows.at(-1)).toBe('  5  中断（INTERRUPTED）');
  });

  it('still reports arguments that cannot be parsed as CONFIG_ERROR, even with --help', () => {
    const result = invokeCli('run', '--help', '--unknown-option');

    expectConfigError(result, describeConfigError('INVALID_ARGUMENTS'));
  });
});

describe('CLI: the build', () => {
  it('builds the CLI outside the repository dist/ and leaves dist/ untouched', async () => {
    expect(build?.distDirectory.startsWith(repositoryDistDirectory)).toBe(false);
    expect(await snapshotDirectory(repositoryDistDirectory)).toEqual(distBefore);
  });

  // C17a: 本番の配置（`dist/` の1つ上に `package.json`）に合わせ、一時ビルドの根にも `package.json` を写す。
  it('places package.json at the root of the temporary build, where the compiled readToolVersion reads it', async () => {
    if (build === undefined) {
      throw new Error('the temporary build is not ready');
    }
    const repositoryPackageJson = await readFile(resolve(rootDirectory, 'package.json'), 'utf8');
    expect(await readFile(join(build.rootDirectory, 'package.json'), 'utf8')).toBe(repositoryPackageJson);
    const environment = (await import(pathToFileURL(join(build.distDirectory, 'orchestration', 'environment.js')).href)) as typeof import('../../src/orchestration/environment.js');
    await expect(environment.readToolVersion()).resolves.toBe((JSON.parse(repositoryPackageJson) as { readonly version: string }).version);
  });
});

// 設計書 第7章・指示書の4: 標準出力と標準エラーへの書き込みが終わるのを待ってから、終了コードで終える。
describe('CLI: waiting for the output before exiting', () => {
  it('resolves a stream write only after the stream calls back', async () => {
    const callbacks: (() => void)[] = [];
    const written: string[] = [];
    const output = streamOutput({
      write: (text: string, callback: (error?: Error | null) => void) => {
        written.push(text);
        callbacks.push(() => callback());
        return false;
      },
    });
    let resolved = false;

    const pending = output.write('abc').then(() => {
      resolved = true;
    });
    await Promise.resolve();

    expect(written).toEqual(['abc']);
    expect(resolved).toBe(false);
    callbacks[0]?.();
    await pending;
    expect(resolved).toBe(true);
  });

  it('resolves a stream write even when the stream reports an error (for example, a closed pipe)', async () => {
    const output = streamOutput({
      write: (_text: string, callback: (error?: Error | null) => void) => {
        callback(new Error('EPIPE'));
        return false;
      },
    });

    await expect(output.write('abc')).resolves.toBeUndefined();
  });

  it('returns the exit code only after every write of the output has finished', async () => {
    const path = await writeConfig('in-process.json', validTarget);
    const gate = createDeferred<void>();
    const texts: string[] = [];
    const slow: CliOutput = {
      write: async (text) => {
        await gate.promise;
        texts.push(text);
      },
    };
    let code: number | undefined;

    const pending = runCli(['validate-config', '--config', path], { stdout: slow, stderr: slow }).then((value) => {
      code = value;
    });
    await new Promise((resolveLater) => setTimeout(resolveLater, 50));

    expect(code).toBeUndefined();
    gate.resolve();
    await pending;
    expect(code).toBe(0);
    expect(texts.join('')).toContain(CLI_TEXT.validateConfig.succeeded);
  });
});

// R17f（設計書 第7章、R17 の指摘1）: 出力先が閉じた場合（EPIPE など）は、そのエラーを無視し、終了コードを変えない。
// 扱われない例外と reject は、日本語の短い文言と、例外のメッセージの1行を示し、終了コード 1 で終える。スタックトレースは出さない。
// 実際の子プロセス（一時的なビルドの CLI）で確かめる。
describe('CLI: closed outputs and unhandled failures, in a child process', () => {
  /** Node の既定の、扱われない 'error' の事象の文。 */
  const UNHANDLED_ERROR_EVENT = "Unhandled 'error' event";

  interface ChildResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }

  interface ChildOptions {
    /** 起動の直後に、標準出力の読み口を閉じる。 */
    readonly closeStdout?: boolean;
    /** 起動の直後に、標準エラーの読み口を閉じる。 */
    readonly closeStderr?: boolean;
    /** CLI の前に読み込むモジュール（`--import`。失敗を起こすために使う）。 */
    readonly preload?: string;
  }

  /** 一時的なビルドの CLI を、非同期で起動する（読み口を閉じるため、`spawnSync` は使えない）。 */
  const spawnCli = (arguments_: readonly string[], options: ChildOptions = {}): Promise<ChildResult> => {
    if (build === undefined) {
      throw new Error('the temporary build is not ready');
    }
    const nodeArguments = options.preload === undefined ? [] : [`--import=${pathToFileURL(options.preload).href}`];
    const child = spawn(process.execPath, [...nodeArguments, join(build.distDirectory, 'cli', 'index.js'), ...arguments_], {
      cwd: rootDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (options.closeStdout === true) {
      child.stdout.destroy();
    } else {
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
    }
    if (options.closeStderr === true) {
      child.stderr.destroy();
    } else {
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
    }
    return new Promise((resolvePromise, rejectPromise) => {
      child.on('error', rejectPromise);
      child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
    });
  };

  /** 標準出力への書き込みを、書き込みの後に失敗を起こすものに置き換える、読み込み用のモジュールを書く。 */
  const writeFailurePreload = async (name: string, failure: 'exception' | 'rejection'): Promise<string> => {
    const raise =
      failure === 'exception'
        ? "throw new Error('injected failure for the test');"
        : "void Promise.reject(new Error('injected rejection for the test'));";
    const path = join(workDirectory, name);
    await writeFile(path, `process.stdout.write = () => { setImmediate(() => { ${raise} }); return true; };\n`, 'utf8');
    return path;
  };

  const expectNoStackTrace = (result: ChildResult): void => {
    expect(result.stderr).not.toMatch(STACK_TRACE_LINE);
    expect(result.stderr).not.toContain(UNHANDLED_ERROR_EVENT);
  };

  it('ignores the error of a closed stdout for --help: exits with 0, without a stack trace', async () => {
    const result = await spawnCli(['--help'], { closeStdout: true });

    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(SUCCESS_EXIT_CODE);
    expectNoStackTrace(result);
  });

  it('keeps the exit code of a configuration error when stdout and stderr are closed', async () => {
    const result = await spawnCli(['unexpected-command'], { closeStdout: true, closeStderr: true });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(CONFIG_ERROR_EXIT_CODE);
  });

  it('reports an unhandled exception in Japanese with the message on one line, and exits with 1 without a stack trace', async () => {
    const preload = await writeFailurePreload('uncaught-exception.mjs', 'exception');

    const result = await spawnCli(['--help'], { preload });

    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(FAILURE_EXIT_CODE);
    expect(result.stderr).toContain(CLI_TEXT.failure.unexpected);
    expect(result.stderr).toContain('injected failure for the test');
    expect(result.stderr.split('\n').filter((line) => line.includes('injected failure for the test'))).toHaveLength(1);
    expectNoStackTrace(result);
  });

  it('reports an unhandled rejection in Japanese with the message on one line, and exits with 1 without a stack trace', async () => {
    const preload = await writeFailurePreload('unhandled-rejection.mjs', 'rejection');

    const result = await spawnCli(['--help'], { preload });

    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(FAILURE_EXIT_CODE);
    expect(result.stderr).toContain(CLI_TEXT.failure.unexpected);
    expect(result.stderr).toContain('injected rejection for the test');
    expectNoStackTrace(result);
  });

  it('exits with 1 for an unhandled exception even when stderr is closed', async () => {
    const preload = await writeFailurePreload('uncaught-exception-closed.mjs', 'exception');

    const result = await spawnCli(['--help'], { preload, closeStderr: true });

    expect(result.signal).toBeNull();
    expect(result.status).toBe(FAILURE_EXIT_CODE);
  });

  // R5b（中断した Run の再開の設計書 4.7 の「シグナル」、7章）: `index.ts` が、子のプロセスの `process` に受け手を登録していることを確かめる。
  // Windows では、子のプロセスに SIGINT を送れない（`kill` は、受け手を呼ばずにプロセスを終える）ので、子のプロセスの中で `process.emit`
  // でシグナルの事象を起こす。標準出力の書き込みを終わらせない形にして（`--help` が終わらない）、2回目のシグナルで終えることを確かめる。
  // テストのプロセスの `process` には、受け手を登録しない。
  it('receives the signals on the process of the CLI: the first sets the stop signal, the second exits with 5 after the message', async () => {
    const path = join(workDirectory, 'signals-in-child.mjs');
    await writeFile(
      path,
      [
        // 標準出力の書き込みを終わらせない（`runCli` が返らないので、`index.ts` は、シグナルの受け手だけで終わる）。
        'process.stdout.write = () => true;',
        "setTimeout(() => { process.emit('SIGINT', 'SIGINT'); process.emit('SIGTERM', 'SIGTERM'); }, 0);",
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await spawnCli(['--help'], { preload: path });

    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(INTERRUPTED_EXIT_CODE);
    expect(result.stderr).toBe(joinLines([CLI_TEXT.interrupt.stopRequested]) + joinLines([CLI_TEXT.interrupt.exitingNow]));
    expectNoStackTrace(result);
  });
});

// 設計書 6.1.1・第7章: FAILED の Run は終了コード 1。書き出しの入出力の失敗と予期しない例外も、日本語の短い文言と、1行の技術的な詳細で、
// 終了コード 1（FAILED と同じ）。ブラウザは起動しない（起動の関数を、失敗する偽のものにする）。対象のサイトにはアクセスしない。
describe('CLI run: failures, in process without a browser', () => {
  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };

  it('exits with 1 for a FAILED Run (the browser does not start) and still writes the artifacts', async () => {
    const path = await writeConfig('failed-run.json', validTarget);
    const output = join(workDirectory, 'failed-run-output');
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const code = await runCli(['run', '--config', path, '--output', output], { stdout: stdout.output, stderr: stderr.output }, {
      run: { launchBrowser: failingLaunch, clock: () => new Date(), now: () => Date.now() },
    });

    expect(code).toBe(EXIT_CODES.FAILED);
    expect(stdout.text()).toContain(RUN_STATUS_CATALOG.FAILED.label);
    expect(stdout.text()).toContain(`${RUN_SUMMARY_TEXT.reasonsHeading}: `);
    expect(stderr.text()).toBe('');
    const [runDirectory] = await readdir(output);
    // BN1: バンドルの名前は、最後の実行の終わりの時刻を含む（バンドルのファイル名の設計書 2.1）。バンドルは1つだけ。
    const run = JSON.parse(await readFile(join(output, runDirectory ?? '', RUN_ARTIFACT_FILE_NAMES.run), 'utf8')) as RunSummary;
    const bundleName = bundleFileName(run.executions[run.executions.length - 1]?.finishedAt ?? '');
    const runDirectoryFiles = await readdir(join(output, runDirectory ?? ''));
    expect(runDirectoryFiles).toEqual(expect.arrayContaining(['run.json', 'audit.json', 'report.html', bundleName]));
    expect(runDirectoryFiles.filter(isBundleFileName)).toEqual([bundleName]);
    expect(stdout.text()).toContain(artifactFilePath(join(output, runDirectory ?? ''), bundleName));
  });

  // L6（サイトへの負荷の制御の設計書 4.5）: 実際の `run` の結果の表示にも、負荷の1行が、書き出した run.json の `load` の値で出る。
  it('shows the site load line with the values of the written run.json in the result of a FAILED Run', async () => {
    const path = await writeConfig('load-line-run.json', validTarget);
    const output = join(workDirectory, 'load-line-run-output');
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const code = await runCli(['run', '--config', path, '--output', output], { stdout: stdout.output, stderr: stderr.output }, {
      run: { launchBrowser: failingLaunch, clock: () => new Date(), now: () => Date.now() },
    });

    expect(code).toBe(EXIT_CODES.FAILED);
    const [runDirectory] = await readdir(output);
    const run = JSON.parse(await readFile(join(output, runDirectory ?? '', 'run.json'), 'utf8')) as RunSummary;
    expect(stdout.text().split('\n')).toContain(expectedLoadLine(run.load));
  });

  // R6（中断した Run の再開の設計書 4.8 の「表示」）: 実際の `run` の結果の表示にも、実行の記録の1行が、書き出した run.json の
  // `executions` の値で出る。再開していない Run なので、実行は1回、再開は0回である。
  it('shows the executions line with the values of the written run.json in the result of a FAILED Run', async () => {
    const path = await writeConfig('executions-line-run.json', validTarget);
    const output = join(workDirectory, 'executions-line-run-output');
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const code = await runCli(['run', '--config', path, '--output', output], { stdout: stdout.output, stderr: stderr.output }, {
      run: { launchBrowser: failingLaunch, clock: () => new Date(), now: () => Date.now() },
    });

    expect(code).toBe(EXIT_CODES.FAILED);
    const [runDirectory] = await readdir(output);
    const run = JSON.parse(await readFile(join(output, runDirectory ?? '', 'run.json'), 'utf8')) as RunSummary;
    expect(run.executions).toHaveLength(1);
    expect(stdout.text().split('\n')).toContain(expectedExecutionsLine(1, 0));
    expect(stdout.text().split('\n')).toContain('実行: 1回、再開 0回');
  });

  it('reports a failure to write the artifacts in Japanese and exits with 1', async () => {
    const path = await writeConfig('write-failure.json', validTarget);
    const output = join(workDirectory, 'write-failure-output');
    // Run のディレクトリは、Run Coordinator が Run の開始の時点で作る（DEF-009）。その後のブラウザの起動の時点で、run.json の場所に
    // ディレクトリを置き、書き出しを失敗させる。
    const blockingLaunch = async (): Promise<never> => {
      const [runId] = await readdir(output);
      await mkdir(join(output, runId ?? '', 'run.json'));
      throw new Error('browser launch is not allowed in this test');
    };
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const code = await runCli(['run', '--config', path, '--output', output], { stdout: stdout.output, stderr: stderr.output }, {
      run: { launchBrowser: blockingLaunch, clock: () => new Date(), now: () => Date.now() },
    });

    expect(code).toBe(FAILURE_EXIT_CODE);
    expect(stderr.text()).toContain(CLI_TEXT.failure.artifactWriteFailed);
    expect(stderr.text()).toContain(CLI_TEXT.detailsHeading);
    expect(stderr.text()).toContain('failed to write the artifact');
    expect(stderr.text()).not.toMatch(STACK_TRACE_LINE);
  });

  // P18d（DEF-009。Task 18 の前の整理の設計書 第6章）: 同じ runId の Run のディレクトリがすでにある場合は、ブラウザを起動せず、
  // artifact を書かずに、日本語の文言と Run のディレクトリのパスを示し、終了コード 1（FAILED）で終える。1つ目の Run の artifact は変わらない。
  it('refuses a Run whose run directory already exists: no browser, no artifacts, a Japanese message with the path, and exit code 1', async () => {
    const path = await writeConfig('same-run-id.json', validTarget);
    const output = join(workDirectory, 'same-run-id-output');
    const startedAt = new Date('2026-09-25T00:00:00.000Z');
    let launches = 0;
    const countingLaunch = async (): Promise<never> => {
      launches += 1;
      throw new Error('browser launch is not allowed in this test');
    };
    // 同じ時計なので、2つの Run は同じ runId になる。
    const dependencies = { run: { launchBrowser: countingLaunch, clock: () => startedAt, now: () => Date.now() } };
    const argv = ['run', '--config', path, '--output', output];

    const firstStdout = captureCliOutput();
    const firstStderr = captureCliOutput();
    expect(await runCli(argv, { stdout: firstStdout.output, stderr: firstStderr.output }, dependencies)).toBe(EXIT_CODES.FAILED);
    expect(launches).toBe(1);
    const [runId] = await readdir(output);
    const runDirectory = join(output, runId ?? '');
    const runJsonBefore = await readFile(join(runDirectory, 'run.json'), 'utf8');
    const before = await snapshotDirectory(runDirectory);

    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    const code = await runCli(argv, { stdout: stdout.output, stderr: stderr.output }, dependencies);

    expect(code).toBe(EXIT_CODES.FAILED);
    expect(launches).toBe(1);
    expect(stderr.text()).toContain(CLI_TEXT.failure.runDirectoryExists);
    expect(stderr.text()).toContain(cliFieldText(CLI_TEXT.failure.runDirectory, runDirectory));
    expect(stderr.text()).toContain(cliFieldText(RUN_SUMMARY_TEXT.runStatus, labelWithCodeText(RUN_STATUS_CATALOG.FAILED.label, 'FAILED')));
    expect(stderr.text()).toContain(CLI_TEXT.detailsHeading);
    expect(stderr.text()).toContain('EEXIST');
    expect(stderr.text()).toMatch(JAPANESE_CHARACTER);
    expect(stderr.text()).not.toMatch(STACK_TRACE_LINE);
    // 結果の要約（artifact の場所）は示さない。artifact を書かないためである。
    expect(stdout.text()).not.toContain(CLI_TEXT.run.resultHeading);
    // 1つ目の Run のディレクトリは、変わらない。
    expect(await snapshotDirectory(runDirectory)).toEqual(before);
    expect(await readFile(join(runDirectory, 'run.json'), 'utf8')).toBe(runJsonBefore);
    expect(await readdir(output)).toEqual([runId]);
  });

  it('reports a run directory that cannot be created in Japanese with the path, and exits with 1 without the browser', async () => {
    const path = await writeConfig('run-directory-unavailable.json', validTarget);
    const blockingFile = join(workDirectory, 'not-a-directory');
    await writeFile(blockingFile, 'a file where the output directory should be', 'utf8');
    let launches = 0;
    const countingLaunch = async (): Promise<never> => {
      launches += 1;
      throw new Error('browser launch is not allowed in this test');
    };
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const code = await runCli(['run', '--config', path, '--output', join(blockingFile, 'output')], { stdout: stdout.output, stderr: stderr.output }, {
      run: { launchBrowser: countingLaunch, clock: () => new Date(), now: () => Date.now() },
    });

    expect(code).toBe(EXIT_CODES.FAILED);
    expect(launches).toBe(0);
    expect(stderr.text()).toContain(CLI_TEXT.failure.runDirectoryUnavailable);
    expect(stderr.text()).not.toContain(CLI_TEXT.failure.runDirectoryExists);
    expect(stderr.text()).toContain(`${CLI_TEXT.failure.runDirectory}: ${join(blockingFile, 'output')}`);
    expect(stderr.text()).toContain(CLI_TEXT.detailsHeading);
    expect(stderr.text()).not.toMatch(STACK_TRACE_LINE);
    expect(stdout.text()).not.toContain(CLI_TEXT.run.resultHeading);
    expect(await readFile(blockingFile, 'utf8')).toBe('a file where the output directory should be');
  });

  it('reports an unexpected error in Japanese with a one-line technical detail and exits with 1', async () => {
    const path = await writeConfig('unexpected.json', validTarget);
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    // 不正な時刻を返す時計は、Run Coordinator が reject する（呼び出し側の誤り）。
    const code = await runCli(['run', '--config', path, '--output', join(workDirectory, 'unexpected-output')], { stdout: stdout.output, stderr: stderr.output }, {
      run: { launchBrowser: failingLaunch, clock: () => new Date(Number.NaN), now: () => Date.now() },
    });

    expect(code).toBe(FAILURE_EXIT_CODE);
    expect(stderr.text()).toContain(CLI_TEXT.failure.unexpected);
    expect(stderr.text()).not.toMatch(STACK_TRACE_LINE);
    const detailLines = stderr.text().split('\n').filter((line) => line.startsWith('  - '));
    expect(detailLines).toHaveLength(1);
  });
});

// R7c（中断した Run の再開の設計書 4.7.1 の「Run の後」、4.10 の Important-1 の (b)）: 出力の書き出し（`finishAuditRun`）に失敗したときの、
// 保存の終わり方。偽の Run Coordinator が、CLI の保存のセッションを始め、ページの保存と状態の保存（IN_PROGRESS）を1回ずつ書き、run.json の
// 場所にディレクトリを置いて、出力の書き出しを失敗させる。どの場合も、出力の失敗を日本語の文言で示し、終了コード 1 で終える。
// - `FINISH` で `finishEvenIfOutputFails` が真（違反を検出した Run）: `finish` を行う（保存は FINISHED になり、ロックは外れる）。出力がない
//   ので、終わった Run の保存の片付け（`removeFinishedCheckpointFiles`）はしない。`finish` も失敗したら、`abandon` を呼ぶ。
// - `FINISH` で偽と、`ABANDON`: `abandon` を呼ぶ（保存は IN_PROGRESS のまま、ロックも残る）。`NONE`: どちらもしない。
describe('CLI run: the checkpoint conclusion when the output cannot be written (resumable run design 4.10, R7c)', () => {
  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };
  /** 偽の Run Coordinator が `finish` に渡す、最後の状態の保存。 */
  const FINAL_CHECKPOINT: RunCheckpoint = sampleRunCheckpoint({ state: 'FINISHED' });
  /** 偽の Run Coordinator が書く、IN_PROGRESS の状態の保存。 */
  const SAVED_CHECKPOINT: RunCheckpoint = sampleRunCheckpoint({ startPageFinished: true });
  const finishConclusion = (finishEvenIfOutputFails: boolean): RunCoordinatorCheckpointConclusion =>
    ({ action: 'FINISH', checkpoint: FINAL_CHECKPOINT, finishEvenIfOutputFails });

  interface OutputFailureRun {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly runDirectory: string;
    readonly finish: MockInstance<RunCheckpointSession['finish']>;
    readonly abandon: MockInstance<RunCheckpointSession['abandon']>;
    readonly cleanUp: MockInstance<ArtifactWriter['removeFinishedCheckpointFiles']>;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 偽の Run Coordinator で、出力の書き出しに失敗する `run` を行う。CLI が作った保存のセッションの `finish` と `abandon` を見張る。 */
  async function runWithOutputFailure(
    name: string,
    conclusion: RunCoordinatorCheckpointConclusion,
    options: { readonly failFinish?: boolean } = {},
  ): Promise<OutputFailureRun> {
    const path = await writeConfig(`${name}.json`, validTarget);
    const output = join(workDirectory, `${name}-output`);
    const runDirectory = runArtifactDirectory(output, FIXTURE_RUN_ID);
    const cleanUp = vi.spyOn(ArtifactWriter.prototype, 'removeFinishedCheckpointFiles');
    let finish: MockInstance<RunCheckpointSession['finish']> | undefined;
    let abandon: MockInstance<RunCheckpointSession['abandon']> | undefined;
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const code = await runCli(['run', '--config', path, '--output', output], { stdout: stdout.output, stderr: stderr.output }, {
      run: {
        launchBrowser: failingLaunch,
        clock: () => new Date(),
        now: () => Date.now(),
        createRunCoordinator: (dependencies) => {
          const session = dependencies.checkpointSession as RunCheckpointSession;
          expect(session).toBeInstanceOf(RunCheckpointSession);
          finish = vi.spyOn(session, 'finish');
          if (options.failFinish === true) {
            finish.mockRejectedValueOnce(new Error('simulated failure of the final checkpoint'));
          }
          abandon = vi.spyOn(session, 'abandon');
          return {
            run: async () => {
              if (conclusion.action !== 'NONE') {
                await mkdir(runDirectory, { recursive: true });
                await expect(session.start(runDirectory, { mode: 'NEW_RUN' })).resolves.toEqual({ ok: true });
                await session.savePage(sampleRunCheckpointPage());
                await session.saveState(SAVED_CHECKPOINT);
              }
              // run.json の場所にディレクトリを置き、出力の書き出しを失敗させる。
              await mkdir(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run), { recursive: true });
              return auditRun();
            },
            checkpointConclusion: () => conclusion,
          };
        },
      },
    });

    if (finish === undefined || abandon === undefined) {
      throw new Error('the fake Run Coordinator was not created');
    }
    return { code, stdout: stdout.text(), stderr: stderr.text(), runDirectory, finish, abandon, cleanUp };
  }

  const checkpointPath = (runDirectory: string, file: 'state' | 'previousState' | 'lock'): string =>
    artifactFilePath(runDirectory, checkpointArtifactRelativePath(file));
  const readState = async (runDirectory: string): Promise<unknown> =>
    JSON.parse(await readFile(checkpointPath(runDirectory, 'state'), 'utf8')) as unknown;

  /** 出力の失敗を、日本語の文言と、出力の書き出しの失敗（`ArtifactWriteError`）の1行の詳細で示し、終了コード 1 で終えた。 */
  const expectOutputFailure = (run: OutputFailureRun): void => {
    expect(run.code, run.stderr).toBe(FAILURE_EXIT_CODE);
    expect(run.stderr).toContain(CLI_TEXT.failure.artifactWriteFailed);
    expect(run.stderr).toContain('failed to write the artifact');
    expect(run.stderr).not.toMatch(STACK_TRACE_LINE);
    expect(run.stdout).not.toContain(CLI_TEXT.run.resultHeading);
    // 出力がないので、終わった Run の保存の片付けはしない。
    expect(run.cleanUp).not.toHaveBeenCalled();
  };

  it('finishes the session with the final checkpoint for FINISH with finishEvenIfOutputFails true, without the cleanup, and exits with 1', async () => {
    const run = await runWithOutputFailure('output-failure-finish', finishConclusion(true));

    expectOutputFailure(run);
    expect(run.finish).toHaveBeenCalledTimes(1);
    expect(run.finish).toHaveBeenCalledWith(FINAL_CHECKPOINT);
    expect(run.abandon).not.toHaveBeenCalled();
    expect(run.stderr).not.toContain(CLI_TEXT.resume.finishFailed);
    // 保存は FINISHED（次の起動で再開しない）。ロックは外れる。ページの保存と state.prev.json は残る（片付けをしないため）。
    expect(await readState(run.runDirectory)).toEqual(FINAL_CHECKPOINT);
    expect(existsSync(checkpointPath(run.runDirectory, 'lock'))).toBe(false);
    expect(existsSync(checkpointPath(run.runDirectory, 'previousState'))).toBe(true);
    expect(existsSync(artifactFilePath(run.runDirectory, checkpointPageArtifactRelativePath(PAGE_1)))).toBe(true);
  });

  it('abandons the session after the final checkpoint also fails, and exits with 1 for the failure of the output', async () => {
    const run = await runWithOutputFailure('output-failure-finish-failure', finishConclusion(true), { failFinish: true });

    expectOutputFailure(run);
    expect(run.stderr).not.toContain('simulated failure of the final checkpoint');
    expect(run.finish).toHaveBeenCalledTimes(1);
    expect(run.abandon).toHaveBeenCalledTimes(1);
    expect(run.abandon.mock.invocationCallOrder[0]).toBeGreaterThan(run.finish.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
    // 保存は、最後に書けた IN_PROGRESS のまま。ロックも残る。
    expect(await readState(run.runDirectory)).toEqual(SAVED_CHECKPOINT);
    expect(existsSync(checkpointPath(run.runDirectory, 'lock'))).toBe(true);
  });

  it.each([
    ['FINISH with finishEvenIfOutputFails false', 'output-failure-finish-false', finishConclusion(false)],
    ['ABANDON', 'output-failure-abandon', { action: 'ABANDON' }],
  ] as const satisfies readonly (readonly [string, string, RunCoordinatorCheckpointConclusion])[])(
    'abandons the session without finishing it for %s, and exits with 1',
    async (_name, outputName, conclusion) => {
      const run = await runWithOutputFailure(outputName, conclusion);

      expectOutputFailure(run);
      expect(run.abandon).toHaveBeenCalledTimes(1);
      expect(run.finish).not.toHaveBeenCalled();
      // 保存の状態は変えない（出力をやり直せるよう、IN_PROGRESS のまま）。ロックも残る。
      expect(await readState(run.runDirectory)).toEqual(SAVED_CHECKPOINT);
      expect(existsSync(checkpointPath(run.runDirectory, 'lock'))).toBe(true);
    },
  );

  it('neither finishes nor abandons the session for NONE, and exits with 1', async () => {
    const run = await runWithOutputFailure('output-failure-none', { action: 'NONE' });

    expectOutputFailure(run);
    expect(run.finish).not.toHaveBeenCalled();
    expect(run.abandon).not.toHaveBeenCalled();
    expect(existsSync(checkpointPath(run.runDirectory, 'state'))).toBe(false);
  });
});

// L6（サイトへの負荷の制御の設計書 3.1 の7、4.5）: `run` の結果の行に、サイトへの負荷の1行を加える。置く位置は、ページの網羅と
// 指摘の件数の行の後、未完了の理由の行の前（HTML レポートの要約の小節の順と同じ）。値は、表示用モデルの `summary.load` から取る。
describe('CLI run: the site load line of the result', () => {
  /** 負荷の記録だけを、項目ごとに異なる値の見本にした Run（未完了の理由がある見本）。 */
  const loadRun = () => {
    const result = edgeCaseAuditRun();
    return { ...result, run: { ...result.run, load: loadDisplaySample() } };
  };

  it('shows one line of the site load after the page coverage and the finding counts, before the incomplete reasons', () => {
    const { summary } = buildReportViewModel(loadRun());
    const lines = runSummaryLines(summary, join('artifacts', 'RUN-20260924000000'));
    const coverageIndex = lines.findIndex((line) => line.startsWith(`${RUN_SUMMARY_TEXT.coverageHeading}: `));
    const groupIndexes = sortByDisplayOrder(SEVERITY_GROUPS, SEVERITY_GROUP_CATALOG).map((group) =>
      lines.findIndex((line) => line.startsWith(`${findingGroupCountsLabelText(SEVERITY_GROUP_CATALOG[group].label)}: `)),
    );
    const loadIndexes = lines.flatMap((line, index) => (line.startsWith(`${RUN_SUMMARY_TEXT.loadHeading}: `) ? [index] : []));
    const executionsIndex = lines.findIndex((line) => line.startsWith(`${CLI_TEXT.run.executions}: `));
    const reasonsIndex = lines.findIndex((line) => line.startsWith(`${RUN_SUMMARY_TEXT.reasonsHeading}: `));

    expect(summary.incompleteReasons.length).toBeGreaterThan(0);
    expect(coverageIndex).toBeGreaterThanOrEqual(0);
    expect(groupIndexes.every((index) => index > coverageIndex)).toBe(true);
    expect(loadIndexes).toEqual([Math.max(...groupIndexes) + 1]);
    // R6: 負荷の行と未完了の理由の行の間には、実行の記録の行と、この起動の終わり方の行（R9）だけがある（中断した Run の再開の設計書
    // 4.8 の「表示」と、その 2026-10-08 の追補）。
    expect(executionsIndex).toBe((loadIndexes[0] ?? -1) + 1);
    expect(lines[executionsIndex + 1]).toBe(expectedLastEndReasonLine(summary.executions.lastEndReason));
    expect(reasonsIndex).toBe(executionsIndex + 2);
  });

  it('shows the navigation count and the requests to the allowed origins with the peak per minute, from the view model', () => {
    const { summary } = buildReportViewModel(loadRun());
    const lines = runSummaryLines(summary, join('artifacts', 'RUN-20260924000000'));

    expect(lines).toContain(expectedLoadLine(summary.load));
    // 見本の値の書式の確かめ（桁区切りと単位、1分あたりの最大）。
    expect(lines).toContain('サイトへの負荷: ページの読み込み 1,234回、許可 Origin への要求 3,400件（1分あたり最大 210件）');
  });

  it('uses the site load of the view model as it is (does not count or compute again)', () => {
    const { summary } = buildReportViewModel(loadRun());
    const altered = {
      ...summary,
      load: { ...summary.load, navigationCount: 7, requests: { ...summary.load.requests, allowedOrigins: { count: 5, peakPerMinute: 3 } } },
    };

    expect(runSummaryLines(altered, 'out')).toContain(expectedLoadLine(altered.load));
    expect(runSummaryLines(altered, 'out')).toContain('サイトへの負荷: ページの読み込み 7回、許可 Origin への要求 5件（1分あたり最大 3件）');
  });
});

// R6（中断した Run の再開の設計書 4.8 の「表示」）: `run` の結果の行に、実行の記録の1行（実行の回数と再開の回数）を加える。置く位置は、
// サイトへの負荷の行の後（HTML レポートの要約の小節の順と同じ）。実行が1回でも示す。値は、表示用モデルの `summary.executions` から取る。
describe('CLI run: the executions line of the result', () => {
  /** 実行の記録だけを、3回の実行の見本にした Run。 */
  const executionsRun = () => {
    const result = edgeCaseAuditRun();
    return { ...result, run: { ...result.run, executions: executionsDisplaySample() } };
  };
  const executionLinesOf = (lines: readonly string[]): readonly string[] =>
    lines.filter((line) => line.startsWith(`${CLI_TEXT.run.executions}: `));

  it('shows one line of the number of executions and of resumes, right after the site load line', () => {
    const { summary } = buildReportViewModel(executionsRun());
    const lines = runSummaryLines(summary, join('artifacts', 'RUN-20260924000000'));
    const loadIndex = lines.findIndex((line) => line.startsWith(`${RUN_SUMMARY_TEXT.loadHeading}: `));

    expect(executionLinesOf(lines)).toEqual([expectedExecutionsLine(summary.executions.count, summary.executions.resumeCount)]);
    expect(lines[loadIndex + 1]).toBe(expectedExecutionsLine(summary.executions.count, summary.executions.resumeCount));
    // 見本の値の書式の確かめ（3回の実行、再開は2回）。
    expect(lines).toContain('実行: 3回、再開 2回');
  });

  it('shows the line also for a Run that was not interrupted (one execution, no resume)', () => {
    const { summary } = buildReportViewModel(auditRun());
    const lines = runSummaryLines(summary, 'out');

    expect(executionLinesOf(lines)).toEqual([expectedExecutionsLine(1, 0)]);
    expect(lines).toContain('実行: 1回、再開 0回');
  });

  it('uses the counts of the view model as they are (does not count again)', () => {
    const { summary } = buildReportViewModel(executionsRun());
    const altered = { ...summary, executions: { ...summary.executions, count: 1234, resumeCount: 7 } };

    expect(executionLinesOf(runSummaryLines(altered, 'out'))).toEqual(['実行: 1,234回、再開 7回']);
  });
});

// BN1（バンドルのファイル名の設計書 2.3）: `run` の結果の「ChatGPT 用のバンドル」の行は、最後の実行の終わりの時刻（表示用モデルの
// `summary.executions.items` の最後）から `bundleFileName` で作った名前のパスを示す。CLI で日時の書式を作り直さない。
describe('CLI run: the bundle line of the result', () => {
  const BUNDLE_PREFIX = `${CLI_TEXT.run.bundle}: `;
  const bundleLinesOf = (lines: readonly string[]): readonly string[] => lines.filter((line) => line.startsWith(BUNDLE_PREFIX));

  it('shows the path of the bundle named with the end of the last execution, for a resumed Run', () => {
    const result = edgeCaseAuditRun();
    const { summary } = buildReportViewModel({ ...result, run: { ...result.run, executions: executionsDisplaySample() } });
    const runDirectory = join('artifacts', 'RUN-20260924000000');

    expect(bundleLinesOf(runSummaryLines(summary, runDirectory))).toEqual([
      `${BUNDLE_PREFIX}${join(runDirectory, 'beaksight-audit-bundle_20261002094030.zip')}`,
    ]);
    expect(bundleLinesOf(runSummaryLines(summary, runDirectory))).toEqual([
      `${BUNDLE_PREFIX}${artifactFilePath(runDirectory, bundleFileName(executionsDisplaySample()[2]?.finishedAt ?? ''))}`,
    ]);
  });

  it('shows the path of the bundle named with the end of the only execution, for a Run that was not interrupted', () => {
    const { summary } = buildReportViewModel(auditRun());
    const [execution] = summary.executions.items;

    expect(bundleLinesOf(runSummaryLines(summary, 'out'))).toEqual([
      `${BUNDLE_PREFIX}${artifactFilePath('out', bundleFileName(execution.finishedAt))}`,
    ]);
    expect(runSummaryLines(summary, 'out')).not.toContain(`${BUNDLE_PREFIX}${join('out', 'beaksight-audit-bundle.zip')}`);
  });

  it('uses the last item of the executions of the view model as it is', () => {
    const { summary } = buildReportViewModel(auditRun());
    const [execution] = summary.executions.items;
    const altered = {
      ...summary,
      executions: {
        ...summary.executions,
        items: [execution, { ...execution, finishedAt: '2026-10-08T15:09:30.000Z' }] as const,
      },
    };

    expect(bundleLinesOf(runSummaryLines(altered, 'out'))).toEqual([
      `${BUNDLE_PREFIX}${join('out', 'beaksight-audit-bundle_20261008150930.zip')}`,
    ]);
  });
});

// R9（中断した Run の再開の設計書 4.8 の 2026-10-08 の追補）: `run` の結果の行に、この起動の終わり方の1行を、実行の記録の行の次に毎回
// 加える（`COMPLETED` でも出す）。終わり方は、表示用モデルの `summary.executions.lastEndReason`（最後の実行の終わり方）から取り、
// ラベルは表示カタログで引く。CLI の側で実行の記録から決め直さない。説明の文は付けない。
describe('CLI run: the line of how this execution ended', () => {
  const LAST_END_REASON_PREFIX = `${CLI_TEXT.run.lastEndReason}: `;
  /** 終わり方が、前から順に `endReasons` の実行の記録を持つ Run（見本の Run には未完了の理由がある）。 */
  const runEndedBy = (...endReasons: readonly [RunExecutionEndReason, ...RunExecutionEndReason[]]): AuditRunResult => {
    const result = edgeCaseAuditRun();
    const [first, ...rest] = endReasons.map((endReason, index) => ({
      startedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
      finishedAt: `2026-10-0${index + 1}T00:10:00.000Z`,
      endReason,
    }));
    if (first === undefined) {
      throw new Error('at least one execution is needed');
    }
    return { ...result, run: { ...result.run, executions: [first, ...rest] } };
  };
  const lastEndReasonLinesOf = (lines: readonly string[]): readonly string[] =>
    lines.filter((line) => line.startsWith(LAST_END_REASON_PREFIX));
  const indexOfLineStartingWith = (lines: readonly string[], label: string): number =>
    lines.findIndex((line) => line.startsWith(`${label}: `));

  it('shows one line of the label and the code of the end reason right after the executions line, for every end reason', () => {
    for (const endReason of RUN_EXECUTION_END_REASONS) {
      const { summary } = buildReportViewModel(runEndedBy(endReason));
      const lines = runSummaryLines(summary, 'out');
      const executionsIndex = indexOfLineStartingWith(lines, CLI_TEXT.run.executions);

      expect(executionsIndex, endReason).toBeGreaterThanOrEqual(0);
      expect(lastEndReasonLinesOf(lines), endReason).toEqual([expectedLastEndReasonLine(endReason)]);
      expect(lines[executionsIndex + 1], endReason).toBe(expectedLastEndReasonLine(endReason));
      // 説明の文は付けない。
      expect(lines.join('\n'), endReason).not.toContain(RUN_EXECUTION_END_REASON_CATALOG[endReason].description);
    }
  });

  it('shows the line also when the Run was completed in one execution', () => {
    const { summary } = buildReportViewModel(auditRun());
    const lines = runSummaryLines(summary, 'out');

    expect(lastEndReasonLinesOf(lines)).toEqual(['この起動の終わり方: 最後まで実行（COMPLETED）']);
  });

  it('uses the end reason of the last execution, not of an earlier one', () => {
    const { summary } = buildReportViewModel(runEndedBy('STOPPED_BY_SITE_UNAVAILABLE', 'STOPPED_BY_RUNTIME_LIMIT'));
    const lines = runSummaryLines(summary, 'out');

    expect(lastEndReasonLinesOf(lines)).toEqual(['この起動の終わり方: 実行時間の上限で停止（STOPPED_BY_RUNTIME_LIMIT）']);
    expect(lines.join('\n')).not.toContain(RUN_EXECUTION_END_REASON_CATALOG.STOPPED_BY_SITE_UNAVAILABLE.label);
  });

  it('puts the lines in the order: executions, the end reason, the stop by site unavailability, the incomplete reasons', () => {
    const base = runEndedBy('STOPPED_BY_RUNTIME_LIMIT', 'STOPPED_BY_SITE_UNAVAILABLE');
    const result: AuditRunResult = {
      ...base,
      run: { ...base.run, incompleteReasons: [...base.run.incompleteReasons, { code: 'SITE_UNAVAILABLE', detail: 'desktop:passive:TIMEOUT' }] },
    };
    const { summary } = buildReportViewModel(result);
    const lines = runSummaryLines(summary, 'out');
    const executionsIndex = indexOfLineStartingWith(lines, CLI_TEXT.run.executions);

    expect(lines.slice(executionsIndex, executionsIndex + 4)).toEqual([
      expectedExecutionsLine(2, 1),
      'この起動の終わり方: サイトの不調で停止（STOPPED_BY_SITE_UNAVAILABLE）',
      siteUnavailableStopText('desktop:passive:TIMEOUT'),
      cliFieldText(RUN_SUMMARY_TEXT.reasonsHeading, formatCount(summary.incompleteReasons.length)),
    ]);
  });

  it('uses the end reason of the view model as it is (does not decide again from the executions)', () => {
    const { summary } = buildReportViewModel(runEndedBy('COMPLETED'));
    const altered = { ...summary, executions: { ...summary.executions, lastEndReason: 'STOPPED_BY_SIGNAL' as const } };

    expect(lastEndReasonLinesOf(runSummaryLines(altered, 'out'))).toEqual(['この起動の終わり方: 中断の指示で停止（STOPPED_BY_SIGNAL）']);
  });
});

// SU4（サイトが応答しないときに Run を止める設計書 3.4）: 最後の実行がサイトの不調で止まった Run では、`run` の結果の行に、止めたことと
// 再開のしかたの1行を加える。置く位置は、実行の記録の行の次、未完了の理由の行の前。出すかどうかと詳細は、表示用モデルの
// `summary.siteUnavailableStop` から取る（CLI の側で判断し直さない）。文言は `messages.ts` の `siteUnavailableStopText`。
describe('CLI run: the line of the stop by site unavailability', () => {
  const DETAIL = 'desktop:passive:TIMEOUT';
  /**
   * 最後の実行の終わり方が `endReason` で、Run の理由に `SITE_UNAVAILABLE`（`detail` は `detail`。`null` なら理由を加えない）を加えた Run。
   * 見本の Run には、ほかの未完了の理由がある（未完了の理由の行が出る）。
   */
  const stoppedRun = (endReason: RunExecutionEndReason, detail: string | null): AuditRunResult => {
    const result = edgeCaseAuditRun();
    return {
      ...result,
      run: {
        ...result.run,
        executions: [
          { startedAt: '2026-10-04T00:00:00.000Z', finishedAt: '2026-10-04T00:10:00.000Z', endReason: 'STOPPED_BY_SITE_UNAVAILABLE' },
          { startedAt: '2026-10-05T00:00:00.000Z', finishedAt: '2026-10-05T00:10:00.000Z', endReason },
        ],
        incompleteReasons: [...result.run.incompleteReasons, ...(detail === null ? [] : [{ code: 'SITE_UNAVAILABLE' as const, detail }])],
      },
    };
  };
  const indexOfLineStartingWith = (lines: readonly string[], label: string): number =>
    lines.findIndex((line) => line.startsWith(`${label}: `));

  it('shows one line with the detail right after the executions line, before the incomplete reasons', () => {
    const { summary } = buildReportViewModel(stoppedRun('STOPPED_BY_SITE_UNAVAILABLE', DETAIL));
    const lines = runSummaryLines(summary, join('artifacts', 'RUN-20260924000000'));
    const executionsIndex = indexOfLineStartingWith(lines, CLI_TEXT.run.executions);
    const reasonsIndex = indexOfLineStartingWith(lines, RUN_SUMMARY_TEXT.reasonsHeading);

    expect(executionsIndex).toBeGreaterThanOrEqual(0);
    // R9: 実行の記録の行の次は、この起動の終わり方の行。その次に、サイトの不調で止めた1行がある。
    expect(lines[executionsIndex + 1]).toBe(expectedLastEndReasonLine('STOPPED_BY_SITE_UNAVAILABLE'));
    expect(lines[executionsIndex + 2]).toBe(siteUnavailableStopText(DETAIL));
    expect(reasonsIndex).toBe(executionsIndex + 3);
    expect(lines.filter((line) => line === siteUnavailableStopText(DETAIL))).toHaveLength(1);
    // 文言の確かめ（詳細は、技術的な詳細のまま括弧の中に示す）。
    expect(lines).toContain(
      'サイトが応答しないため、監査を止めました（desktop:passive:TIMEOUT）。サイトが戻ってから、同じコマンドで続きから再開してください。',
    );
  });

  it('shows the line without the parentheses when the Run has no SITE_UNAVAILABLE reason', () => {
    const { summary } = buildReportViewModel(stoppedRun('STOPPED_BY_SITE_UNAVAILABLE', null));
    const lines = runSummaryLines(summary, 'out');
    const executionsIndex = indexOfLineStartingWith(lines, CLI_TEXT.run.executions);

    // R9: 実行の記録の行の次の、この起動の終わり方の行の次にある。
    expect(lines[executionsIndex + 2]).toBe(siteUnavailableStopText(null));
    expect(lines).toContain('サイトが応答しないため、監査を止めました。サイトが戻ってから、同じコマンドで続きから再開してください。');
  });

  it('does not show the line when the last execution ended in another way, even after a stop by site unavailability', () => {
    for (const endReason of ['COMPLETED', 'STOPPED_BY_SIGNAL', 'STOPPED_BY_SAFETY_VIOLATION'] as const) {
      const { summary } = buildReportViewModel(stoppedRun(endReason, DETAIL));
      const lines = runSummaryLines(summary, 'out');
      const executionsIndex = indexOfLineStartingWith(lines, CLI_TEXT.run.executions);

      expect(lines, endReason).not.toContain(siteUnavailableStopText(DETAIL));
      expect(lines, endReason).not.toContain(siteUnavailableStopText(null));
      // 実行の記録の行の次は、この起動の終わり方の行（R9）で、その次は未完了の理由の行（間にほかの行がない）。
      expect(lines[executionsIndex + 1], endReason).toBe(expectedLastEndReasonLine(endReason));
      expect(indexOfLineStartingWith(lines, RUN_SUMMARY_TEXT.reasonsHeading), endReason).toBe(executionsIndex + 2);
    }
  });

  it('follows the view model as it is (does not decide again from the executions or the reasons)', () => {
    const stopped = buildReportViewModel(stoppedRun('STOPPED_BY_SITE_UNAVAILABLE', DETAIL)).summary;
    const completed = buildReportViewModel(stoppedRun('COMPLETED', DETAIL)).summary;

    expect(runSummaryLines({ ...stopped, siteUnavailableStop: null }, 'out')).not.toContain(siteUnavailableStopText(DETAIL));
    expect(runSummaryLines({ ...completed, siteUnavailableStop: { detail: 'mobile:stress-layout:HTTP 503' } }, 'out'))
      .toContain(siteUnavailableStopText('mobile:stress-layout:HTTP 503'));
  });
});

// L7（サイトへの負荷の制御の設計書 4.8）: `run` の実行中に、ページの監査が1つ終わるたびに、Run Coordinator から受け取った進み具合の
// 事実を、1行で標準出力に示す。文言は `messages.ts`、書式は `format.ts` のもの。表示の側で計算しない（直近の1分の件数も、事実のまま）。
describe('CLI run: the progress line during the Run', () => {
  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };

  it('shows the pages, the navigations, the requests with the latest minute and the peak, and the elapsed time in one line', () => {
    expect(runProgressLines(progressSample)).toEqual([expectedProgressLine(progressSample)]);
    // 見本の値の書式の確かめ（桁区切りと単位、回数、直近の1分と1分あたりの最大、経過時間）。
    expect(runProgressLines(progressSample)).toEqual([
      '進み具合: 監査を終えたページ 12件（発見したページ 85件、上限 50件）・ページの読み込み 284回・'
        + '許可 Origin への要求 1,930件（直近1分 38件、1分あたり最大 61件）・許可 Origin の外 12件・経過 24分10秒',
    ]);
  });

  it('shows the facts as they are given (does not count or compute again)', () => {
    // 互いに合わない値（上限より多い監査、最大より多い直近の1分）でも、そのまま示す。
    const altered: RunProgressReport = {
      ...progressSample,
      pagesFinished: 99,
      pagesDiscovered: 1,
      maxPages: 2,
      elapsedMs: (65 * 60 + 30) * 1000,
      navigationCount: 1234,
      requests: { ...progressSample.requests, allowedOrigins: { count: 5, peakPerMinute: 3 }, otherOrigins: { count: 0, peakPerMinute: 7 } },
      recentPerMinute: { allowedOrigins: 500, otherOrigins: 400 },
    };

    expect(runProgressLines(altered)).toEqual([expectedProgressLine(altered)]);
    expect(runProgressLines(altered)).toEqual([
      '進み具合: 監査を終えたページ 99件（発見したページ 1件、上限 2件）・ページの読み込み 1,234回・'
        + '許可 Origin への要求 5件（直近1分 500件、1分あたり最大 3件）・許可 Origin の外 0件・経過 1時間5分',
    ]);
  });

  it('prints one progress line for every report of the Run Coordinator, after the start lines and before the result', async () => {
    const path = await writeConfig('progress-run.json', validTarget);
    const output = join(workDirectory, 'progress-run-output');
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    const second: RunProgressReport = { ...progressSample, pagesFinished: 13, elapsedMs: 65 * 60 * 1000 };

    const code = await runCli(['run', '--config', path, '--output', output], { stdout: stdout.output, stderr: stderr.output }, {
      run: {
        launchBrowser: failingLaunch,
        clock: () => new Date(),
        now: () => Date.now(),
        createRunCoordinator: (dependencies) => ({
          run: async () => {
            dependencies.onProgress?.(progressSample);
            dependencies.onProgress?.(second);
            return auditRun();
          },
          // 保存のセッションを始めない偽の Run Coordinator なので、保存の終わり方は `NONE`（R5a）。
          checkpointConclusion: (): RunCoordinatorCheckpointConclusion => ({ action: 'NONE' }),
        }),
      },
    });

    expect(code, stderr.text()).toBe(EXIT_CODES.COMPLETE);
    expect(stderr.text()).toBe('');
    const lines = stdout.text().split('\n');
    const progressLines = lines.filter((line) => line.startsWith(`${CLI_TEXT.progress.heading}: `));
    expect(progressLines).toEqual([expectedProgressLine(progressSample), expectedProgressLine(second)]);
    const [first, last] = progressLines;
    expect(lines.indexOf(CLI_TEXT.run.started)).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(CLI_TEXT.run.started)).toBeLessThan(lines.indexOf(first ?? ''));
    expect(lines.indexOf(first ?? '')).toBeLessThan(lines.indexOf(last ?? ''));
    expect(lines.indexOf(last ?? '')).toBeLessThan(lines.indexOf(CLI_TEXT.run.resultHeading));
  });
});

// SU5、SU6（サイトが応答しないときに Run を止める設計書 3.5.4、3.6.2）: Run Coordinator の知らせ（`RunNotice`。事実だけ）を、1行の文言に
// する。文言は `messages.ts` の `siteUnavailableRecheckText` と `siteUnavailableSlowdownText`、時間の書式は `format.ts` の `formatDuration`
// （例: `60秒`）。表示の側で計算しない。
describe('CLI run: the notice lines of the site unavailability recheck and slowdown', () => {
  it('shows the recheck notice with the wait, the attempt of the maximum and the URL from the notice, in one line', () => {
    const [firstDelayMs, secondDelayMs] = SITE_UNAVAILABLE_RECHECK_DELAYS_MS as readonly [number, number, ...number[]];
    const maxAttempts = SITE_UNAVAILABLE_RECHECK_DELAYS_MS.length;
    const notice: RunNotice = { kind: 'SITE_UNAVAILABLE_RECHECK', url: 'http://127.0.0.1:4173/a.html', delayMs: firstDelayMs, attempt: 1, maxAttempts };

    expect(runNoticeLines(notice)).toEqual([siteUnavailableRecheckText(notice.url, formatDuration(firstDelayMs), 1, maxAttempts)]);
    expect(runNoticeLines(notice)).toEqual([
      'サイトが応答しないため、60秒待ってから同じページを確かめ直します（1/4 回目。http://127.0.0.1:4173/a.html）。',
    ]);
    expect(runNoticeLines({ ...notice, delayMs: secondDelayMs, attempt: 2 })).toEqual([
      'サイトが応答しないため、120秒待ってから同じページを確かめ直します（2/4 回目。http://127.0.0.1:4173/a.html）。',
    ]);
    // 待つ時間と回数は、知らせの事実のまま書式にかける（定数ではない）。
    expect(runNoticeLines({ ...notice, delayMs: 1_500, attempt: 3, maxAttempts: 7 }))
      .toEqual([siteUnavailableRecheckText(notice.url, formatDuration(1_500), 3, 7)]);
  });

  it('shows the slowdown notice with the new interval from the notice, in one line', () => {
    const notice: RunNotice = { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10_000 };

    expect(runNoticeLines(notice)).toEqual([siteUnavailableSlowdownText(formatDuration(10_000))]);
    expect(runNoticeLines(notice)).toEqual(['確かめ直しで応答が戻ったので、ページの読み込みの間隔を 10秒 に延ばして続けます。']);
    expect(runNoticeLines({ ...notice, minIntervalMs: 40_000 })).toEqual([siteUnavailableSlowdownText(formatDuration(40_000))]);
  });
});

// R5b（中断した Run の再開の設計書 4.6.1、4.7 の「シグナル」）: `index.ts` がシグナルの受け手と一緒に作る止める印（`stopSignal`）を、
// `runCli` が、`run` のときに Run Coordinator まで届ける。`dependencies.run` を省略した場合は、本番の依存に止める印を加える。
describe('CLI run: the stop signal', () => {
  const failingLaunch = async (): Promise<never> => {
    throw new Error('browser launch is not allowed in this test');
  };

  it('passes the stop signal given to runCli to the Run Coordinator of run', async () => {
    const path = await writeConfig('stop-signal-run.json', validTarget);
    const output = join(workDirectory, 'stop-signal-run-output');
    const controller = new AbortController();
    const received: (AbortSignal | undefined)[] = [];
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();

    const code = await runCli(['run', '--config', path, '--output', output], { stdout: stdout.output, stderr: stderr.output }, {
      run: {
        launchBrowser: failingLaunch,
        clock: () => new Date(),
        now: () => Date.now(),
        createRunCoordinator: (dependencies) => ({
          run: async () => {
            received.push(dependencies.stopSignal);
            return auditRun();
          },
          // 保存のセッションを始めない偽の Run Coordinator なので、保存の終わり方は `NONE`（R5a）。
          checkpointConclusion: (): RunCoordinatorCheckpointConclusion => ({ action: 'NONE' }),
        }),
      },
      stopSignal: controller.signal,
    });

    expect(code, stderr.text()).toBe(EXIT_CODES.COMPLETE);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(controller.signal);
  });

  it('adds the stop signal to the production dependencies when the dependencies of run are omitted', () => {
    const controller = new AbortController();

    const resolved = resolveRunCommandDependencies({ stopSignal: controller.signal }, PRODUCTION_RUN_DEPENDENCIES);

    expect(resolved).toEqual({ ...PRODUCTION_RUN_DEPENDENCIES, stopSignal: controller.signal });
    expect(resolved.launchBrowser).toBe(PRODUCTION_RUN_DEPENDENCIES.launchBrowser);
    expect(resolved.clock).toBe(PRODUCTION_RUN_DEPENDENCIES.clock);
    expect(resolved.now).toBe(PRODUCTION_RUN_DEPENDENCIES.now);
    expect(resolved.stopSignal).toBe(controller.signal);
    // 本番の依存そのものは変えない。
    expect(PRODUCTION_RUN_DEPENDENCIES.stopSignal).toBeUndefined();
  });

  it('adds the stop signal to the given dependencies of run, without changing them', () => {
    const controller = new AbortController();
    const given: RunCommandDependencies = { launchBrowser: failingLaunch, clock: () => new Date(), now: () => Date.now() };

    const resolved = resolveRunCommandDependencies({ run: given, stopSignal: controller.signal }, PRODUCTION_RUN_DEPENDENCIES);

    expect(resolved).toEqual({ ...given, stopSignal: controller.signal });
    expect(resolved.launchBrowser).toBe(failingLaunch);
    expect(given.stopSignal).toBeUndefined();
  });

  it('uses the dependencies of run as they are without a stop signal (the production ones when omitted)', () => {
    const given: RunCommandDependencies = { launchBrowser: failingLaunch, clock: () => new Date(), now: () => Date.now() };

    expect(resolveRunCommandDependencies({}, PRODUCTION_RUN_DEPENDENCIES)).toBe(PRODUCTION_RUN_DEPENDENCIES);
    expect(resolveRunCommandDependencies({ run: given }, PRODUCTION_RUN_DEPENDENCIES)).toBe(given);
  });
});

// R5a（中断した Run の再開の設計書 4.7.1 の「知らせ」）: 再開の流れの1行。文言は `messages.ts`、数の書式は `format.ts`、一覧を短くする
// 書式は `truncatedListText` のもの。
describe('CLI run: the notices of the resume', () => {
  const RUN_ID = 'RUN-20261001000000';

  it('lists at most MAX_LISTED_CONFIG_DIFFERENCES paths of the different items, and adds the number of the rest', () => {
    expect(MAX_LISTED_CONFIG_DIFFERENCES).toBe(5);
    expect(differentConfigRunLines(RUN_ID, ['crawl.maxPages'])).toEqual([differentConfigRunText(RUN_ID, 'crawl.maxPages')]);
    expect(differentConfigRunLines(RUN_ID, ['a', 'b', 'c', 'd', 'e'])).toEqual([differentConfigRunText(RUN_ID, 'a、b、c、d、e')]);
    expect(differentConfigRunLines(RUN_ID, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([
      '設定が違うため、途中の Run（RUN-20261001000000）は再開しません（違う項目: a、b、c、d、e、ほか 2 件）。新しい Run を始めます。',
    ]);
  });

  it('shows every different version with the label of the report, the saved and the current value', () => {
    expect(differentVersionRunLines(RUN_ID, [
      { field: 'toolVersion', saved: '0.1.0', current: '0.2.0' },
      { field: 'playwrightVersion', saved: '1.50.0', current: '1.51.0' },
    ])).toEqual([
      '途中の Run（RUN-20261001000000）は、版が違うため再開できません（BeakSight の版: 保存 0.1.0 → 今 0.2.0、'
        + 'Playwright: 保存 1.50.0 → 今 1.51.0）。最初から始めるには --new を付けてください。',
    ]);
  });

  it('shows the number of the finished pages in the resume notice as the progress line does', () => {
    expect(resumingRunLines(RUN_ID, 3)).toEqual([
      '途中の Run（RUN-20261001000000。監査を終えたページ 3件）を、続きから再開します。最初から始めるには --new を付けてください。',
    ]);
    expect(resumingRunLines(RUN_ID, 1234)).toEqual([
      resumingRunText(RUN_ID, cliCountText(CLI_TEXT.progress.pagesFinished, formatCount(1234))),
    ]);
    expect(resumingRunLines(RUN_ID, 1234)[0]).toContain('監査を終えたページ 1,234件');
  });

  it('shows one line for the other notices', () => {
    expect(activeRunLines(RUN_ID)).toEqual([activeRunInOutputDirectoryText(RUN_ID)]);
    expect(unreadableCheckpointLines(RUN_ID)).toEqual([unreadableCheckpointText(RUN_ID)]);
    expect(finalizingRunLines(RUN_ID)).toEqual([finalizingRunText(RUN_ID)]);
    expect(checkpointFinishFailedLines()).toEqual([CLI_TEXT.resume.finishFailed]);
    expect(finishedCheckpointCleanupFailedLines('C:\out\pages')).toEqual([finishedCheckpointCleanupFailedText('C:\out\pages')]);
  });
});
