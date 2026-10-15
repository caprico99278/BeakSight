/**
 * `run` のコマンドの CLI の表示（Task 14〜17 の設計書 第7章、6.1.8、6.1.9、実装計画 Task 17 の Step 2。Task 24 の設計書 4.1。T24a）。
 * Run の実行、書き出し、保存の終わり方は、監査の中核（`audit-run.ts` の `executeAuditRun`）が行い、型つきの結果を返す。このファイルは、
 * 中核を呼び、結果と観測の口の値から、今と同じ日本語の行を、今と同じ順と内容で、標準出力と標準エラーに出すだけにする（行の組み立ては
 * `output.ts`）。CLI の標準出力・標準エラー・終了コードは、切り出す前と1文字も変えない（`tests/integration/cli-output-parity.test.ts`）。
 * Playwright を読み込むので（中核が読み込む）、`main.ts` は、`run` のときだけ、このファイルを読み込む。
 *
 * 出し方（中断した Run の再開の設計書 4.7、4.7.1。DEF-009）:
 * - 出力先の実行中の Run（`RUN_ACTIVE`）: 文言を標準エラーに示して終える（終了コード 4。`--new` でも同じ）。標準出力には何も書かない。
 *   別の起動が開始の段にいて、Run の ID がまだ決まっていない場合（DEF-057）は、Run の ID のない文言にする。
 * - 版の違い（`VERSION_MISMATCH`）: 文言を標準エラーに示して終える（終了コード 4）。標準出力には何も書かない。
 * - Run を始める前（観測の口 `onRunStarting`）: 開始の知らせ（壊れた保存、設定が違う）と、再開の知らせ（再開する、最後の処理だけを行う）を、
 *   この順に1回の書き込みで標準出力に示し、続けて開始の行を示す。
 * - 実行中（`onProgress`、`onNotice`）: 進み具合の1行と、知らせの1行を、受けた順に標準出力に書く。書き込みは待たず、結果を示す前に、
 *   すべての書き込みの終わりを待つ（サイトへの負荷の制御の設計書 4.8、サイトが応答しないときに Run を止める設計書 3.5.4）。
 * - Run のディレクトリを作れなかった Run（`RUN_DIRECTORY_UNAVAILABLE`）: artifact を書かず、日本語の文言と Run のディレクトリのパスを
 *   標準エラーに示す。終了コードは、その Run の Run Status（`FAILED`）のとおり。
 * - 再開を始められなかった Run（`RESUME_UNAVAILABLE`）: 理由ごとの文言を標準エラーに示す（終了コード 4）。
 * - Run を実行した（`RAN`）: 結果の行を標準出力に示し、保存の終わり方の警告があれば、標準エラーに示す。終了コードは、Run Status のとおり。
 * - 中核が reject した場合（出力の書き出しの失敗と予期しない例外）: それまでの書き込みの終わりを待ってから、例外を呼び出し側（`main.ts`）に返す。
 */
import type { AuditConfig } from '../config/types.js';
import type { AuditRunResult } from '../core/contracts.js';
import type { RunSummaryView } from '../report/view-model.js';
import {
  DEFAULT_AUDIT_RUN_OPTIONS,
  PRODUCTION_RUN_DEPENDENCIES,
  executeAuditRun,
  writeAuditRunOutputs,
  type AuditRunCheckpointWarning,
  type AuditRunDependencies,
  type AuditRunOptions,
  type AuditRunOutcome,
  type AuditRunResumeDecision,
  type AuditRunStart,
  type AuditRunStartNotice,
} from './audit-run.js';
import type { CliStreams } from './main.js';
import {
  activeRunLines,
  checkpointFinishFailedLines,
  differentConfigRunLines,
  differentVersionRunLines,
  finalizingRunLines,
  finishedCheckpointCleanupFailedLines,
  joinLines,
  resumingRunLines,
  runDirectoryUnavailableLines,
  runNoticeLines,
  runProgressLines,
  runResumeUnavailableLines,
  runStartedLines,
  runSummaryLines,
  unreadableCheckpointLines,
} from './output.js';
import type { CliOutput } from './output-stream.js';
import { startingRunInOutputDirectoryText } from '../presentation/messages.js';

export { PRODUCTION_RUN_DEPENDENCIES, artifactFileReader } from './audit-run.js';

/** `run` に注入するもの（本番の既定値は `PRODUCTION_RUN_DEPENDENCIES`）。監査の中核の依存と同じものである。 */
export type RunCommandDependencies = AuditRunDependencies;

/** `run` の指定（CLI の引数から決まるもの）。監査の中核の指定と同じものである。 */
export type RunAuditCommandOptions = AuditRunOptions;

/** 開始の知らせ（`AuditRunStartNotice`）の行。 */
function startNoticeLines(notice: AuditRunStartNotice): readonly string[] {
  switch (notice.kind) {
    case 'CHECKPOINT_UNREADABLE':
      return unreadableCheckpointLines(notice.runId);
    case 'CONFIG_DIFFERS':
      return differentConfigRunLines(notice.runId, notice.differences);
  }
}

/** 再開の判断（`AuditRunResumeDecision`）の行（新しい Run では、なし）。 */
function resumeDecisionLines(decision: AuditRunResumeDecision): readonly string[] {
  switch (decision.kind) {
    case 'NEW_RUN':
      return [];
    case 'RESUME':
      return resumingRunLines(decision.runId, decision.completedPages);
    case 'FINALIZE_ONLY':
      return finalizingRunLines(decision.runId);
  }
}

/** 開始の前の知らせの行（開始の知らせ、再開の知らせの順）。 */
const runStartingNoticeLines = (start: AuditRunStart): readonly string[] => [
  ...start.notices.flatMap(startNoticeLines),
  ...resumeDecisionLines(start.resumeDecision),
];

/** 保存の終わり方の警告（`AuditRunCheckpointWarning`）の行。 */
function checkpointWarningLines(warning: AuditRunCheckpointWarning): readonly string[] {
  switch (warning.kind) {
    case 'CHECKPOINT_FINISH_FAILED':
      return checkpointFinishFailedLines();
    case 'CHECKPOINT_CLEANUP_FAILED':
      return finishedCheckpointCleanupFailedLines(warning.path);
  }
}

/**
 * Run を実行し、書き出して、結果を表示する（中核は `executeAuditRun`。出し方は、ファイルの先頭の説明）。終了コードを返す。
 * 書き出しの入出力の失敗（`ArtifactWriteError`）と予期しない例外は、呼び出し側（`main.ts`）が扱う。
 */
export async function runAuditCommand(
  config: AuditConfig,
  streams: CliStreams,
  dependencies: RunCommandDependencies = PRODUCTION_RUN_DEPENDENCIES,
  options: RunAuditCommandOptions = DEFAULT_AUDIT_RUN_OPTIONS,
): Promise<number> {
  // 標準出力への書き込み。書き込みは、観測の口が呼ばれた順に始まる（出力先は、書いた順に出す）。終わりは、結果を示す前に待つ。
  let stdoutWritten: Promise<unknown> = Promise.resolve();
  const writeStdoutLines = (lines: readonly string[]): void => {
    const written = streams.stdout.write(joinLines(lines));
    stdoutWritten = stdoutWritten.then(() => written);
  };

  let outcome: AuditRunOutcome;
  try {
    outcome = await executeAuditRun(config, dependencies, options, {
      onRunStarting: (start) => {
        const notices = runStartingNoticeLines(start);
        if (notices.length > 0) {
          writeStdoutLines(notices);
        }
        writeStdoutLines(runStartedLines(config));
      },
      onProgress: (report) => {
        writeStdoutLines(runProgressLines(report));
      },
      // 知らせ（確かめ直しなど。サイトが応答しないときに Run を止める設計書 3.5.4）も、進み具合の行と同じ出し方で標準出力に書く。
      onNotice: (notice) => {
        writeStdoutLines(runNoticeLines(notice));
      },
    });
  } catch (error) {
    await stdoutWritten;
    throw error;
  }
  await stdoutWritten;

  switch (outcome.kind) {
    case 'RUN_ACTIVE':
      // 別の起動が開始の段にいて、Run の ID がまだ決まっていないとき（DEF-057）は、Run の ID のない文にする。
      await streams.stderr.write(joinLines(outcome.activeRunId === null
        ? [startingRunInOutputDirectoryText]
        : activeRunLines(outcome.activeRunId)));
      return outcome.exitCode;
    case 'VERSION_MISMATCH':
      await streams.stderr.write(joinLines(differentVersionRunLines(outcome.runId, outcome.differences)));
      return outcome.exitCode;
    case 'RUN_DIRECTORY_UNAVAILABLE':
      // artifact は書かない（書く場所が、別の Run のディレクトリだから。DEF-009）。
      await streams.stderr.write(joinLines(runDirectoryUnavailableLines({
        alreadyExists: outcome.alreadyExists,
        runStatus: outcome.runStatus,
        runDirectory: outcome.runDirectory,
        cause: outcome.cause,
      })));
      return outcome.exitCode;
    case 'RESUME_UNAVAILABLE':
      await streams.stderr.write(joinLines(runResumeUnavailableLines({ reason: outcome.reason, runId: outcome.runId, cause: outcome.cause })));
      return outcome.exitCode;
    case 'RAN':
      await writeRunSummary(outcome, streams.stdout);
      for (const warning of outcome.checkpointWarnings) {
        await streams.stderr.write(joinLines(checkpointWarningLines(warning)));
      }
      return outcome.exitCode;
  }
}

/** 結果の行（空行と、表示用モデルの要約の行）を標準出力に示す。 */
async function writeRunSummary(
  outputs: { readonly summary: RunSummaryView; readonly runDirectory: string },
  stdout: CliOutput,
): Promise<void> {
  await stdout.write(joinLines(['', ...runSummaryLines(outputs.summary, outputs.runDirectory)]));
}

/**
 * 確定した Run（`AuditRunResult`）を書き出し（`writeAuditRunOutputs`）、表示用モデルから結果を表示して、終了コードを返す（設計書 第7章、
 * R17 の指摘2）。終了コードは、書き出した後の Run Status（スキーマに合わない場合は、導き直した後のもの）から決める。
 */
export async function finishAuditRun(result: AuditRunResult, outputDirectory: string, stdout: CliOutput): Promise<number> {
  const outputs = await writeAuditRunOutputs(result, outputDirectory);
  await writeRunSummary(outputs, stdout);
  return outputs.exitCode;
}
