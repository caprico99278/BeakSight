/**
 * CLI の表示の組み立て（Task 14〜17 の設計書 第7章、UI追補設計書 第3章、`ui-ux-ssot.md` 第5章）。
 * - 日本語の文言は `src/presentation/messages.ts`、ラベルは `src/presentation/catalog.ts`、件数の書式は `src/presentation/format.ts`
 *   から取る。このファイルには、行の並べ方（字下げ、箇条書きの印）だけを置く。
 * - 実行の結果の件数は、表示用モデル（`ReportViewModel.summary`）から取る。数え直さない（UI追補設計書 4.1）。
 * - 実行中の進み具合の件数と時間は、Run Coordinator が渡す事実（`RunProgressReport`）から取る。計算しない（サイトへの負荷の制御の設計書 4.8）。
 * - 技術的な詳細（英語のエラーの文、パス）は、1行にして、そのまま示す。スタックトレースは示さない。
 */
import type { ConfigError, ConfigErrorKind } from '../config/config-error.js';
import type { AuditConfig } from '../config/types.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../core/artifact-layout.js';
import { RUN_STATUSES, type RunProgressReport, type RunStatus } from '../core/contracts.js';
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
import { formatCount, formatDuration, formatElapsedTime, formatRequestsWithPeak, formatTimes } from '../presentation/format.js';
import type { RunVersionDifference, RunVersionField } from '../orchestration/run-checkpoint.js';
import type { RunNotice, RunResumeUnavailableReason } from '../orchestration/run-coordinator.js';
import {
  CLI_COMMAND_DESCRIPTIONS,
  CLI_OPTION_DESCRIPTIONS,
  CLI_TEXT,
  HTML_REPORT_TEXT,
  RUN_SUMMARY_TEXT,
  activeRunInOutputDirectoryText,
  checkpointStoreFailedText,
  cliCountText,
  cliFieldText,
  countWithDetailsText,
  describeConfigError,
  differentConfigRunText,
  differentVersionRunText,
  finalizingRunText,
  findingGroupCountsLabelText,
  finishedCheckpointCleanupFailedText,
  labelWithCodeText,
  listText,
  progressItemsText,
  resumingRunText,
  runLockHeldText,
  runLockTakenOverText,
  siteUnavailableRecheckText,
  siteUnavailableSlowdownText,
  siteUnavailableStopText,
  truncatedListText,
  unreadableCheckpointText,
  versionDifferenceText,
} from '../presentation/messages.js';
import type { RunSummaryView } from '../report/view-model.js';
import { CLI_COMMANDS, CLI_OPTION_NAMES } from './arguments.js';
import {
  CONFIG_ERROR_EXIT_CODE,
  CONFIG_ERROR_OUTCOME,
  INTERRUPTED_EXIT_CODE,
  INTERRUPTED_OUTCOME,
  RUN_UNAVAILABLE_EXIT_CODE,
  RUN_UNAVAILABLE_OUTCOME,
  exitCodeForRunStatus,
} from './exit-codes.js';

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
    // 設定のエラーと同じ値（中断した Run の再開の設計書 4.7.1）。並べ替えは安定なので、設定のエラーの行の後に並ぶ。
    { code: RUN_UNAVAILABLE_EXIT_CODE, label: labelWithCodeText(CLI_TEXT.runUnavailableHeading, RUN_UNAVAILABLE_OUTCOME) },
    // 中断（2回目のシグナル。最後の処理をしていない。中断した Run の再開の設計書 4.7、4.7.1）。
    { code: INTERRUPTED_EXIT_CODE, label: labelWithCodeText(CLI_TEXT.interruptedHeading, INTERRUPTED_OUTCOME) },
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
 * `run` の実行中の進み具合の1行（サイトへの負荷の制御の設計書 4.8）。ページの監査が1つ終わるたびに、Run Coordinator が渡す事実
 * （`RunProgressReport`）から作る。値は、事実をそのまま書式にかけるだけで、計算しない（直近の1分の件数も、事実のもの）。
 * 項目の順: 監査を終えたページ（発見したページと、ページ数の上限を添える）、ページの読み込みの回数、許可 Origin への要求（直近の1分の
 * 件数と、1分あたりの最大を添える）、許可 Origin の外への要求、経過時間。
 */
/**
 * `run` の実行中の知らせの1行（Run Coordinator の `RunNotice`。サイトが応答しないときに Run を止める設計書 3.5.4、3.6.2）。知らせの事実
 * （種類と、その値）を、文言（`messages.ts`）と書式（`format.ts`）にかけるだけで、計算しない。
 * - `SITE_UNAVAILABLE_RECHECK`: サイトの不調でページを捨てた後、待ってから同じページを確かめ直す（待つ時間は `formatDuration`。何回目かと
 *   最大の回数は、そのまま）。
 * - `SITE_UNAVAILABLE_SLOWDOWN`: 確かめ直しで応答が戻ったので、ページの読み込みの間隔を延ばして続ける（新しい間隔は `formatDuration`）。
 */
export function runNoticeLines(notice: RunNotice): readonly string[] {
  switch (notice.kind) {
    case 'SITE_UNAVAILABLE_RECHECK':
      return [siteUnavailableRecheckText(notice.url, formatDuration(notice.delayMs), notice.attempt, notice.maxAttempts)];
    case 'SITE_UNAVAILABLE_SLOWDOWN':
      return [siteUnavailableSlowdownText(formatDuration(notice.minIntervalMs))];
  }
}

export function runProgressLines(report: RunProgressReport): readonly string[] {
  const text = CLI_TEXT.progress;
  return [
    cliFieldText(
      text.heading,
      progressItemsText([
        cliCountText(
          text.pagesFinished,
          countWithDetailsText(formatCount(report.pagesFinished), [
            cliCountText(RUN_SUMMARY_TEXT.coverage.discovered, formatCount(report.pagesDiscovered)),
            cliCountText(text.maxPages, formatCount(report.maxPages)),
          ]),
        ),
        cliCountText(CLI_TEXT.run.navigationCount, formatTimes(report.navigationCount)),
        cliCountText(
          RUN_SUMMARY_TEXT.allowedOriginRequests,
          formatRequestsWithPeak(report.requests.allowedOrigins, report.recentPerMinute.allowedOrigins),
        ),
        cliCountText(text.otherOriginRequests, formatCount(report.requests.otherOrigins.count)),
        cliCountText(text.elapsed, formatElapsedTime(report.elapsedMs)),
      ]),
    ),
  ];
}

/**
 * `run` の結果の行（設計書 第7章）。値は、表示用モデルの `summary` から取る。
 * - Run Status の日本語のラベル（値そのものを添える）
 * - 出力先（Run のディレクトリ）と、HTML レポートとバンドルのパス
 * - ページの網羅（発見、監査、一部未完了、失敗、スキップ）
 * - severity の区分（サイト品質、Safety）ごとの、severity ごとの件数
 * - サイトへの負荷（ページの読み込みの回数と、許可 Origin への要求の件数と1分あたりの最大。サイトへの負荷の制御の設計書 4.5）。
 *   指摘の件数の行の後に置く（HTML レポートの要約の小節の順と同じ）。回数は `formatTimes`、要求の件数と最大は
 *   HTML レポートと共通の `formatRequestsWithPeak` で示す（L7）
 * - 実行の記録（実行の回数と再開の回数。例: `実行: 3回、再開 2回`。中断した Run の再開の設計書 4.8 の「表示」。R6）。負荷の行の後、
 *   未完了の理由の行の前に置く（HTML レポートの要約の小節の順と同じ）。実行が1回でも示す。回数は、表示用モデルの値を `formatTimes` で示す
 * - サイトの不調で止めた場合は、止めたことと再開のしかたの1行（サイトが応答しないときに Run を止める設計書 3.4）。実行の記録の行の次、
 *   未完了の理由の行の前に置く。出すかどうかと詳細は、表示用モデルの `siteUnavailableStop` のまま（ここで判断し直さない）
 * - 未完了の理由がある場合は、その件数
 */
export function runSummaryLines(summary: RunSummaryView, runDirectory: string): readonly string[] {
  const coverage = RUN_SUMMARY_TEXT.coverage;
  const counts = summary.findingCounts;
  const { load, executions } = summary;
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
    cliFieldText(
      RUN_SUMMARY_TEXT.loadHeading,
      listText([
        cliCountText(CLI_TEXT.run.navigationCount, formatTimes(load.navigationCount)),
        cliCountText(RUN_SUMMARY_TEXT.allowedOriginRequests, formatRequestsWithPeak(load.requests.allowedOrigins)),
      ]),
    ),
    cliFieldText(
      CLI_TEXT.run.executions,
      listText([formatTimes(executions.count), cliCountText(CLI_TEXT.run.resumes, formatTimes(executions.resumeCount))]),
    ),
    ...(summary.siteUnavailableStop === null ? [] : [siteUnavailableStopText(summary.siteUnavailableStop.detail)]),
    ...(summary.incompleteReasons.length > 0
      ? [cliFieldText(RUN_SUMMARY_TEXT.reasonsHeading, formatCount(summary.incompleteReasons.length))]
      : []),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 中断した Run の再開の流れの行（中断した Run の再開の設計書 4.7、4.7.1。R5a）。文言は `messages.ts`、数の書式は `format.ts`、一覧を短くする
// 書式は `truncatedListText` のもの。ここには、値の並べ方だけを置く。
// ---------------------------------------------------------------------------------------------------------------

/** 設定が違う途中の Run の知らせで、違う項目のパスを並べる上限（設計書 4.7.1。残りは、件数だけを示す）。 */
export const MAX_LISTED_CONFIG_DIFFERENCES = 5;

/** 違う版の項目の、表示の名前（HTML レポートの要約の、BeakSight の版と Playwright の版のラベル）。 */
const RUN_VERSION_FIELD_LABELS = Object.freeze({
  toolVersion: HTML_REPORT_TEXT.summary.toolVersion,
  playwrightVersion: HTML_REPORT_TEXT.summary.environment.playwrightVersion,
} as const satisfies Record<RunVersionField, string>);

/** 再開を始められなかった理由（`RunResumeUnavailableError.reason`）ごとの文言。書き漏れは、型のエラーになる。 */
const RUN_RESUME_UNAVAILABLE_TEXTS = Object.freeze({
  LOCK_HELD_BY_ACTIVE_RUN: runLockHeldText,
  LOCK_TAKEN_OVER_CONCURRENTLY: runLockTakenOverText,
  CHECKPOINT_STORE_FAILED: checkpointStoreFailedText,
} as const satisfies Record<RunResumeUnavailableReason, (runId: string) => string>);

/** 同じ出力先で、別の Run が実行中なので、Run を始めずに終える行。 */
export function activeRunLines(runId: string): readonly string[] {
  return [activeRunInOutputDirectoryText(runId)];
}

/** 途中の Run の再開のための保存を読めないので、再開の対象にしない行（壊れた保存）。 */
export function unreadableCheckpointLines(runId: string): readonly string[] {
  return [unreadableCheckpointText(runId)];
}

/**
 * 設定が違うので、途中の Run を再開せずに、新しい Run を始める行。違う項目のパスは、`MAX_LISTED_CONFIG_DIFFERENCES` 件まで並べ、残りは
 * 件数だけを示す（`truncatedListText`）。
 */
export function differentConfigRunLines(runId: string, differences: readonly string[]): readonly string[] {
  return [differentConfigRunText(runId, truncatedListText(differences, MAX_LISTED_CONFIG_DIFFERENCES))];
}

/** 版が違うので、途中の Run を再開できずに終える行。違う版の項目を、表示の名前、保存の値、今の値で、項目の順に並べる。 */
export function differentVersionRunLines(runId: string, differences: readonly RunVersionDifference[]): readonly string[] {
  return [differentVersionRunText(
    runId,
    listText(differences.map(({ field, saved, current }) => versionDifferenceText(RUN_VERSION_FIELD_LABELS[field], saved, current))),
  )];
}

/**
 * 途中の Run を、続きから再開する行。監査を終えたページの数は、実行中の進み具合の行と同じ書き方（`監査を終えたページ <件数>`）にする。
 */
export function resumingRunLines(runId: string, completedPages: number): readonly string[] {
  return [resumingRunText(runId, cliCountText(CLI_TEXT.progress.pagesFinished, formatCount(completedPages)))];
}

/** 違反を検出した後の途中の Run なので、新しいページを監査せずに、最後の処理だけを行う行。 */
export function finalizingRunLines(runId: string): readonly string[] {
  return [finalizingRunText(runId)];
}

/**
 * 再開を始められなかった（`RunResumeUnavailableError`）行。理由ごとの文言と、保存を読み書きできなかった場合は、1行の技術的な詳細
 * （`cause`）を示す。
 */
export function runResumeUnavailableLines(input: {
  readonly reason: RunResumeUnavailableReason;
  readonly runId: string;
  readonly cause: unknown;
}): readonly string[] {
  return [
    RUN_RESUME_UNAVAILABLE_TEXTS[input.reason](input.runId),
    ...(input.reason === 'CHECKPOINT_STORE_FAILED' ? detailLines([input.cause]) : []),
  ];
}

/** 最後の出力を書いた後に、保存の終わりを書けなかった警告の行。 */
export function checkpointFinishFailedLines(): readonly string[] {
  return [CLI_TEXT.resume.finishFailed];
}

/** 終わった Run の、使わない再開のための保存を消せなかった警告の行（`path` は、消せなかったもの）。 */
export function finishedCheckpointCleanupFailedLines(path: string): readonly string[] {
  return [finishedCheckpointCleanupFailedText(technicalDetailText(path))];
}
