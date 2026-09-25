/**
 * CLI の表示の組み立て（Task 14〜17 の設計書 第7章、UI追補設計書 第3章、`ui-ux-ssot.md` 第5章）。
 * - 日本語の文言は `src/presentation/messages.ts`、ラベルは `src/presentation/catalog.ts`、件数の書式は `src/presentation/format.ts`
 *   から取る。このファイルには、行の並べ方（字下げ、箇条書きの印）だけを置く。
 * - 実行の結果の件数は、表示用モデル（`ReportViewModel.summary`）から取る。数え直さない（UI追補設計書 4.1）。
 * - 技術的な詳細（英語のエラーの文、パス）は、1行にして、そのまま示す。スタックトレースは示さない。
 */
import type { ConfigError, ConfigErrorKind } from '../config/config-error.js';
import type { AuditConfig } from '../config/types.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../core/artifact-layout.js';
import { RUN_STATUSES, type RunStatus } from '../core/contracts.js';
import { safeErrorMessage } from '../core/errors.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { normalizeWhitespace } from '../core/text.js';
import {
  RUN_STATUS_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  SEVERITY_GROUPS,
  severitiesInGroup,
  sortByDisplayOrder,
} from '../presentation/catalog.js';
import { formatCount } from '../presentation/format.js';
import {
  CLI_COMMAND_DESCRIPTIONS,
  CLI_OPTION_DESCRIPTIONS,
  CLI_TEXT,
  RUN_SUMMARY_TEXT,
  cliCountText,
  cliFieldText,
  describeConfigError,
  findingGroupCountsLabelText,
  labelWithCodeText,
  listText,
} from '../presentation/messages.js';
import type { RunSummaryView } from '../report/view-model.js';
import { CLI_COMMANDS, CLI_OPTION_NAMES } from './arguments.js';
import { CONFIG_ERROR_EXIT_CODE, CONFIG_ERROR_OUTCOME, exitCodeForRunStatus } from './exit-codes.js';

/** 使い方の表示で使う、プログラムの名前（`package.json` の `bin`）。 */
const PROGRAM_NAME = 'beaksight';
/** 見出しの下の項目の字下げ。 */
const ITEM_INDENT = '  ';
/** 項目の説明の字下げ。 */
const DESCRIPTION_INDENT = '      ';
/** 詳細の一覧の、箇条書きの印。 */
const DETAIL_BULLET = '- ';
/** 見出しの後ろの区切り。 */
const HEADING_SUFFIX = ':';

/** 使い方の表示を添える、設定のエラーの種類（CLI の引数とコマンドの誤り）。 */
const USAGE_ERROR_KINDS: ReadonlySet<ConfigErrorKind> = new Set<ConfigErrorKind>([
  'COMMAND_MISSING',
  'UNKNOWN_COMMAND',
  'INVALID_ARGUMENTS',
  'CONFLICTING_ARGUMENTS',
]);

/** 制御文字（Unicode の一般カテゴリ Cc）。端末の表示を乱さないよう、空白にする。 */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/** 不明な値（例外、文字列）を、1行の技術的な詳細にする（上限付き。制御文字と改行は空白にする）。 */
export const technicalDetailText = (value: unknown): string =>
  normalizeWhitespace(safeErrorMessage(value, MAX_ERROR_MESSAGE_LENGTH).replace(CONTROL_CHARACTERS, ' '));

/** 行の一覧を、LF で終わる1つの文字列にする。 */
export const joinLines = (lines: readonly string[]): string => `${lines.join('\n')}\n`;

const heading = (text: string): string => `${text}${HEADING_SUFFIX}`;

/** 技術的な詳細の一覧の行（なければ空）。 */
const detailLines = (details: readonly unknown[]): readonly string[] =>
  details.length === 0
    ? []
    : [heading(CLI_TEXT.detailsHeading), ...details.map((detail) => `${ITEM_INDENT}${DETAIL_BULLET}${technicalDetailText(detail)}`)];

/** 使い方の行。コマンドとオプションは CLI の一覧の順、終了コードは終了コードの表の順（小さい順）。 */
export function usageLines(): readonly string[] {
  const exitCodeRows = [
    ...RUN_STATUSES.map((status) => ({
      code: exitCodeForRunStatus(status),
      label: labelWithCodeText(RUN_STATUS_CATALOG[status].label, status),
    })),
    { code: CONFIG_ERROR_EXIT_CODE, label: labelWithCodeText(CLI_TEXT.configErrorHeading, CONFIG_ERROR_OUTCOME) },
  ].sort((left, right) => left.code - right.code);
  return [
    cliFieldText(CLI_TEXT.usage.heading, [PROGRAM_NAME, CLI_TEXT.usage.commandPlaceholder, CLI_TEXT.usage.optionsPlaceholder].join(' ')),
    '',
    heading(CLI_TEXT.usage.commandsHeading),
    ...CLI_COMMANDS.flatMap((command) => [`${ITEM_INDENT}${command}`, `${DESCRIPTION_INDENT}${CLI_COMMAND_DESCRIPTIONS[command]}`]),
    '',
    heading(CLI_TEXT.usage.optionsHeading),
    ...CLI_OPTION_NAMES.flatMap((name) => {
      const { valueName, description } = CLI_OPTION_DESCRIPTIONS[name];
      const option = valueName === null ? `--${name}` : `--${name} <${valueName}>`;
      return [`${ITEM_INDENT}${option}`, `${DESCRIPTION_INDENT}${description}`];
    }),
    '',
    heading(CLI_TEXT.usage.exitCodesHeading),
    ...exitCodeRows.map(({ code, label }) => `${ITEM_INDENT}${code}${ITEM_INDENT}${label}`),
  ];
}

/** 設定のエラーの行（日本語の説明、技術的な詳細の一覧、引数の誤りなら使い方）。 */
export function configErrorLines(error: ConfigError): readonly string[] {
  return [
    cliFieldText(CLI_TEXT.configErrorHeading, describeConfigError(error.kind)),
    ...detailLines(error.details),
    ...(USAGE_ERROR_KINDS.has(error.kind) ? ['', ...usageLines()] : []),
  ];
}

/** Run の外の失敗（artifact の書き出しの失敗、予期しない例外）の行。例外の文を、技術的な詳細として1行で示す。 */
export function failureLines(description: string, error: unknown): readonly string[] {
  return [description, ...detailLines([error])];
}

/**
 * Run のディレクトリを作れなかった Run の行（DEF-009）。artifact は書かないので、結果の要約（artifact の場所）の代わりに示す。
 * 日本語の説明、Run Status（値そのものを添える）、作れなかった Run のディレクトリのパス、技術的な詳細（作成の失敗の1行）の順。
 */
export function runDirectoryUnavailableLines(input: {
  readonly alreadyExists: boolean;
  readonly runStatus: RunStatus;
  readonly runDirectory: string;
  readonly cause: unknown;
}): readonly string[] {
  return [
    input.alreadyExists ? CLI_TEXT.failure.runDirectoryExists : CLI_TEXT.failure.runDirectoryUnavailable,
    cliFieldText(RUN_SUMMARY_TEXT.runStatus, labelWithCodeText(RUN_STATUS_CATALOG[input.runStatus].label, input.runStatus)),
    cliFieldText(CLI_TEXT.failure.runDirectory, input.runDirectory),
    ...detailLines([input.cause]),
  ];
}

/** `validate-config` の成功の行。 */
export function validConfigLines(config: AuditConfig): readonly string[] {
  return [
    CLI_TEXT.validateConfig.succeeded,
    cliFieldText(RUN_SUMMARY_TEXT.target, config.target.id),
    cliFieldText(RUN_SUMMARY_TEXT.startUrl, config.site.startUrl),
  ];
}

/** `run` の開始の行（出力先の Run のディレクトリは、Run の ID が決まった後の、結果の行で示す）。 */
export function runStartedLines(config: AuditConfig): readonly string[] {
  return [
    CLI_TEXT.run.started,
    cliFieldText(RUN_SUMMARY_TEXT.target, config.target.id),
    cliFieldText(RUN_SUMMARY_TEXT.startUrl, config.site.startUrl),
  ];
}

/**
 * `run` の結果の行（設計書 第7章）。値は、表示用モデルの `summary` から取る。
 * - Run Status の日本語のラベル（値そのものを添える）
 * - 出力先（Run のディレクトリ）と、HTML レポートとバンドルのパス
 * - ページの網羅（発見、監査、一部未完了、失敗、スキップ）
 * - severity の区分（サイト品質、Safety）ごとの、severity ごとの件数
 * - 未完了の理由がある場合は、その件数
 */
export function runSummaryLines(summary: RunSummaryView, runDirectory: string): readonly string[] {
  const coverage = RUN_SUMMARY_TEXT.coverage;
  const counts = summary.findingCounts;
  const groupLines = sortByDisplayOrder(SEVERITY_GROUPS, SEVERITY_GROUP_CATALOG).map((group) =>
    cliFieldText(
      findingGroupCountsLabelText(SEVERITY_GROUP_CATALOG[group].label),
      listText(
        severitiesInGroup(group).map((severity) => cliCountText(SEVERITY_CATALOG[severity].label, formatCount(counts.bySeverity[severity]))),
      ),
    ),
  );
  return [
    CLI_TEXT.run.resultHeading,
    cliFieldText(RUN_SUMMARY_TEXT.runStatus, labelWithCodeText(RUN_STATUS_CATALOG[summary.runStatus].label, summary.runStatus)),
    cliFieldText(CLI_TEXT.run.outputDirectory, runDirectory),
    cliFieldText(CLI_TEXT.run.report, artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.report)),
    cliFieldText(CLI_TEXT.run.bundle, artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.bundle)),
    cliFieldText(
      RUN_SUMMARY_TEXT.coverageHeading,
      listText([
        cliCountText(coverage.discovered, formatCount(summary.coverage.discovered)),
        cliCountText(coverage.audited, formatCount(summary.coverage.audited)),
        cliCountText(coverage.partial, formatCount(summary.coverage.partial)),
        cliCountText(coverage.failed, formatCount(summary.coverage.failed)),
        cliCountText(coverage.skipped, formatCount(summary.coverage.skipped)),
      ]),
    ),
    ...groupLines,
    ...(summary.incompleteReasons.length > 0
      ? [cliFieldText(RUN_SUMMARY_TEXT.reasonsHeading, formatCount(summary.incompleteReasons.length))]
      : []),
  ];
}
