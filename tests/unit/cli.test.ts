// U17a（Task 14〜17 の設計書 第7章、6.1.5、実装計画 Task 17 の Step 1・3）: 一時的なビルドの CLI を起動し、設定の誤りと引数の誤りが、
// 日本語の文言、スタックトレースなし、終了コード 4（CONFIG_ERROR）になることを確かめる。ブラウザは起動しない。
// 以前の期待値（英語の `configuration valid`、`usage: …`、`run` のスタブの終了コード 1）は、設計書 第7章の新しい仕様に合わせて直した。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_ERROR_EXIT_CODE, EXIT_CODES, FAILURE_EXIT_CODE, SUCCESS_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { runCli } from '../../src/cli/main.js';
import { joinLines, usageLines } from '../../src/cli/output.js';
import { streamOutput, type CliOutput } from '../../src/cli/output-stream.js';
import { RUN_STATUS_CATALOG } from '../../src/presentation/catalog.js';
import {
  CLI_OPTION_DESCRIPTIONS,
  CLI_TEXT,
  RUN_SUMMARY_TEXT,
  cliFieldText,
  describeConfigError,
  labelWithCodeText,
} from '../../src/presentation/messages.js';
import { createDeferred } from '../helpers/deferred.js';
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

const validTarget = {
  target: { id: 'cli-unit' },
  site: { startUrl: `${LOOPBACK_ORIGIN}/`, allowedOrigins: [LOOPBACK_ORIGIN] },
};

/** 設定のエラーの共通の確かめ: 終了コード 4、標準出力は空、標準エラーは日本語の文言で、スタックトレースがない。 */
const expectConfigError = (result: ReturnType<typeof invokeCli>, description: string): void => {
  expect(result.status, result.stderr).toBe(CONFIG_ERROR_EXIT_CODE);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(description);
  expect(result.stderr).toMatch(JAPANESE_CHARACTER);
  expect(result.stderr).not.toMatch(STACK_TRACE_LINE);
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
    expect(await readdir(join(output, runDirectory ?? ''))).toEqual(
      expect.arrayContaining(['run.json', 'audit.json', 'report.html', 'beaksight-audit-bundle.zip']),
    );
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
