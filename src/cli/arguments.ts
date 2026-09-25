/**
 * CLI の引数の解析（Task 14〜17 の設計書 第7章、実装計画 Task 17 の Step 3）。
 * - 引数の誤り（知らないオプション、値のないオプション、余分な引数、値を取るオプションの2回以上の指定）、コマンドの誤り、
 *   `--headed` と `--headless` の同時の指定は、どれも `ConfigError` を投げる（終了コード 4）。
 * - 詳細は、英語の技術的な詳細とする（`node:util` の `parseArgs` の文も、そのまま詳細に入れる）。
 * - `--help` は、引数を解析できた場合、コマンドの有無やほかの引数によらず、使い方の表示の求め（`CliHelpRequest`）にする（C17a）。
 *   引数を解析できない場合（知らないオプション、値のないオプション）は、`--help` があっても、引数の誤りとする。
 */
import { parseArgs } from 'node:util';
import { ConfigError } from '../config/config-error.js';
import type { AuditConfigOverrides } from '../config/types.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { safeErrorMessage } from '../core/errors.js';
import { normalizeWhitespace } from '../core/text.js';

/** CLI のコマンドの一覧（使い方の表示の順）。説明は `messages.ts` の `CLI_COMMAND_DESCRIPTIONS`。 */
export const CLI_COMMANDS = Object.freeze(['run', 'validate-config'] as const);
export type CliCommand = (typeof CLI_COMMANDS)[number];

/**
 * CLI のオプション（使い方の表示の順）。説明は `messages.ts` の `CLI_OPTION_DESCRIPTIONS`。
 * 使い方を示す `--help` も、使い方の表示に載せるため、ここに置く（設計書 第7章。C17a の持ち越し）。
 */
export const CLI_OPTIONS = Object.freeze({
  config: Object.freeze({ type: 'string' }),
  output: Object.freeze({ type: 'string' }),
  headed: Object.freeze({ type: 'boolean' }),
  headless: Object.freeze({ type: 'boolean' }),
  help: Object.freeze({ type: 'boolean' }),
} as const);
export type CliOptionName = keyof typeof CLI_OPTIONS;
export const CLI_OPTION_NAMES = Object.freeze(Object.keys(CLI_OPTIONS) as CliOptionName[]);

/** 使い方の表示の求め（`--help`）。設定は読まず、Run も実行しない。 */
export interface CliHelpRequest {
  readonly kind: 'help';
}

/** 解析した CLI の呼び出し。 */
export interface CliInvocation {
  readonly kind: 'command';
  readonly command: CliCommand;
  /** `--config` の値（省略した場合は `undefined`。`loadConfig` が `config/targets/` から選ぶ）。 */
  readonly configPath: string | undefined;
  /** CLI の上書き（`--headed`、`--headless`、`--output`）。 */
  readonly overrides: AuditConfigOverrides;
}

const CLI_COMMAND_SET: ReadonlySet<string> = new Set(CLI_COMMANDS);
const isCliCommand = (value: string): value is CliCommand => CLI_COMMAND_SET.has(value);

/** 例外の文を、1行の技術的な詳細にする。 */
const oneLineDetail = (error: unknown): string => normalizeWhitespace(safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH));

const parseStrictly = (argv: readonly string[]) =>
  parseArgs({ args: [...argv], allowPositionals: true, strict: true, tokens: true, options: CLI_OPTIONS });

/** 値を取るオプションの名前（`--config`、`--output`）。 */
const VALUE_OPTION_NAMES: ReadonlySet<string> = new Set(
  Object.entries(CLI_OPTIONS)
    .filter(([, option]) => option.type === 'string')
    .map(([name]) => name),
);

/**
 * 2回以上指定された、値を取るオプションの名前（指定の順。R17 の指摘3）。`parseArgs` は後の値を黙って使うので、字句（`tokens`）で数える。
 * 理由は、上位の計画 Task 17 の Step 3 の「Reject ambiguous CLI flags」である。
 */
const duplicatedValueOptions = (tokens: ReturnType<typeof parseStrictly>['tokens']): readonly string[] => {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    if (token.kind === 'option' && VALUE_OPTION_NAMES.has(token.name)) {
      counts.set(token.name, (counts.get(token.name) ?? 0) + 1);
    }
  }
  return [...counts].filter(([, count]) => count > 1).map(([name]) => name);
};

/** CLI の引数（`process.argv.slice(2)`）を解析する。誤りは `ConfigError` を投げる。 */
export function parseCliArguments(argv: readonly string[]): CliInvocation | CliHelpRequest {
  let parsed: ReturnType<typeof parseStrictly>;
  try {
    parsed = parseStrictly(argv);
  } catch (error) {
    throw new ConfigError('INVALID_ARGUMENTS', 'invalid command-line arguments', [oneLineDetail(error)], { cause: error });
  }
  const { positionals, values, tokens } = parsed;
  if (values.help === true) {
    return { kind: 'help' };
  }
  const duplicated = duplicatedValueOptions(tokens);
  if (duplicated.length > 0) {
    throw new ConfigError(
      'INVALID_ARGUMENTS',
      'an option that takes a value was given more than once',
      duplicated.map((name) => `--${name} was given more than once`),
    );
  }
  const [command, ...extraArguments] = positionals;
  if (command === undefined) {
    throw new ConfigError('COMMAND_MISSING', 'no command was given');
  }
  if (!isCliCommand(command)) {
    throw new ConfigError('UNKNOWN_COMMAND', `unknown command: ${command}`, [`unknown command: ${command}`]);
  }
  if (extraArguments.length > 0) {
    throw new ConfigError(
      'INVALID_ARGUMENTS',
      'unexpected command-line arguments',
      extraArguments.map((argument) => `unexpected argument: ${argument}`),
    );
  }
  if (values.headed === true && values.headless === true) {
    throw new ConfigError('CONFLICTING_ARGUMENTS', '--headed and --headless cannot be given together', [
      'both --headed and --headless were given',
    ]);
  }

  const overrides: AuditConfigOverrides = {
    ...(values.headed === true ? { browser: { headed: true } } : values.headless === true ? { browser: { headed: false } } : {}),
    ...(values.output === undefined ? {} : { output: { directory: values.output } }),
  };
  return { kind: 'command', command, configPath: values.config, overrides };
}
