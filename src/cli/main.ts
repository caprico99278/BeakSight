/**
 * CLI の本体（Task 14〜17 の設計書 第7章、6.1.5、実装計画 Task 17）。`index.ts` は、これを呼んで、返った終了コードで終えるだけにする。
 * - 引数を解析し、設定を読み（CLI の上書きを適用する）、コマンドを実行する。
 * - `--help` は、使い方（引数の誤りのときに示すものと同じ `usageLines`）を標準出力に示し、終了コード 0 にする。設定は読まず、
 *   Run も実行しない（C17a）。
 * - 設定のエラー（`ConfigError`）は、日本語の文言と技術的な詳細の一覧を標準エラーに示し、終了コード 4 にする。
 * - artifact の書き出しの入出力の失敗（`ArtifactWriteError`）と予期しない例外は、日本語の短い文言と1行の技術的な詳細を示し、
 *   終了コード 1（FAILED と同じ）にする。スタックトレースは出さない。
 * - Run のディレクトリを作れなかった Run（DEF-009）は、`run-command.ts` が、artifact を書かずに標準エラーに示し、その Run の
 *   Run Status（FAILED）の終了コード 1 を返す。
 * - `runCli` の外で起きた、扱われない例外と reject も、同じ形で示す（`reportUnhandledFailure`。`index.ts` が登録する。R17 の指摘1）。
 * - 止める印（`CliDependencies.stopSignal`。シグナルの1回目で付く）は、`run` のときだけ、Run Coordinator に届ける（中断した Run の再開の
 *   設計書 4.7 の「シグナル」）。2回目のシグナルで、すぐに終える処理は、`interrupt.ts` が行う。
 * - すべての書き込みが終わるのを待ってから、終了コードを返す。
 */
import { isConfigError } from '../config/config-error.js';
import { loadConfig } from '../config/load-config.js';
import { CLI_TEXT } from '../presentation/messages.js';
import { ArtifactWriteError } from '../report/artifact-writer.js';
import { parseCliArguments } from './arguments.js';
import { CONFIG_ERROR_EXIT_CODE, FAILURE_EXIT_CODE, SUCCESS_EXIT_CODE } from './exit-codes.js';
import { configErrorLines, failureLines, joinLines, usageLines, validConfigLines } from './output.js';
import type { CliOutput } from './output-stream.js';
import type { RunCommandDependencies } from './run-command.js';

/** CLI の出力先。 */
export interface CliStreams {
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
}

/** CLI に注入するもの（`run` はテスト用。省略すると本番のもの）。 */
export interface CliDependencies {
  readonly run?: RunCommandDependencies;
  /**
   * 止める印（中断した Run の再開の設計書 4.6.1、4.7 の「シグナル」）。`index.ts` が、シグナルの受け手（`interrupt.ts`）と一緒に作って渡す。
   * `run` のときだけ、`run` の依存（`dependencies.run`、省略すると本番の依存）に加えて、Run Coordinator に届ける
   * （`resolveRunCommandDependencies`）。`validate-config` と `--help` では使わない。省略すると、止めない。
   */
  readonly stopSignal?: AbortSignal;
}

/**
 * `run` に渡す依存を組み立てる。`dependencies.run`（省略すると `production`）に、止める印（`dependencies.stopSignal`）を加えた写しを返す。
 * 止める印がなければ、`dependencies.run`（省略すると `production`）をそのまま返す。渡された依存は変えない。
 * `production` は、呼び出し側が渡す（本番の依存は Playwright を読み込む `run-command.ts` にあり、`run` のときだけ読み込むため）。
 */
export function resolveRunCommandDependencies(
  dependencies: CliDependencies,
  production: RunCommandDependencies,
): RunCommandDependencies {
  const base = dependencies.run ?? production;
  return dependencies.stopSignal === undefined ? base : { ...base, stopSignal: dependencies.stopSignal };
}

/**
 * CLI を実行し、終了コードを返す（reject しない）。返すのは、`streams` へのすべての書き込みが終わった後である。
 * `argv` は、`process.argv.slice(2)` にあたる引数。
 */
export async function runCli(argv: readonly string[], streams: CliStreams, dependencies: CliDependencies = {}): Promise<number> {
  try {
    const invocation = parseCliArguments(argv);
    if (invocation.kind === 'help') {
      await streams.stdout.write(joinLines(usageLines()));
      return SUCCESS_EXIT_CODE;
    }
    const config = await loadConfig(invocation.configPath, invocation.overrides);
    if (invocation.command === 'validate-config') {
      await streams.stdout.write(joinLines(validConfigLines(config)));
      return SUCCESS_EXIT_CODE;
    }
    // Playwright を読み込むのは、`run` のときだけにする。`--new` は、そのまま渡す。止める印は、`run` の依存に加えて渡す
    // （中断した Run の再開の設計書 4.7）。
    const { PRODUCTION_RUN_DEPENDENCIES, runAuditCommand } = await import('./run-command.js');
    return await runAuditCommand(
      config,
      streams,
      resolveRunCommandDependencies(dependencies, PRODUCTION_RUN_DEPENDENCIES),
      { startNew: invocation.startNew },
    );
  } catch (error) {
    if (isConfigError(error)) {
      await streams.stderr.write(joinLines(configErrorLines(error)));
      return CONFIG_ERROR_EXIT_CODE;
    }
    const description = error instanceof ArtifactWriteError ? CLI_TEXT.failure.artifactWriteFailed : CLI_TEXT.failure.unexpected;
    return reportFailure(description, error, streams.stderr);
  }
}

/** Run の外の失敗を、日本語の短い文言と1行の技術的な詳細で示し、終了コード 1（FAILED と同じ）を返す（reject しない）。 */
async function reportFailure(description: string, error: unknown, stderr: CliOutput): Promise<number> {
  await stderr.write(joinLines(failureLines(description, error)));
  return FAILURE_EXIT_CODE;
}

/**
 * 扱われない例外と reject（`runCli` の外で起きたもの）を、日本語の短い文言と、例外のメッセージの1行で示し、終了コード 1 を返す
 * （設計書 第7章、R17 の指摘1）。スタックトレースは出さない。出力先が閉じていても、reject しない。
 */
export const reportUnhandledFailure = (error: unknown, stderr: CliOutput): Promise<number> =>
  reportFailure(CLI_TEXT.failure.unexpected, error, stderr);
