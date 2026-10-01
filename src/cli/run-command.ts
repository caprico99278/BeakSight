/**
 * `run` のコマンド: Run Coordinator を組み立てて Run を実行し、artifact・HTML レポート・ChatGPT 用バンドルを書き出して、結果を表示する
 * （Task 14〜17 の設計書 第7章、6.1.8、6.1.9、実装計画 Task 17 の Step 2）。
 * Playwright を読み込むので、`main.ts` は、`run` のときだけ、このファイルを読み込む。
 * Run のディレクトリを作れなかった Run（`RunDirectoryUnavailableError`。DEF-009）は、`ArtifactWriter` を呼ばずに、日本語の文言と
 * Run のディレクトリのパスを標準エラーに示して終える。終了コードは、その Run の Run Status（`FAILED`）から、終了コードの表で決める。
 *
 * 中断した Run の再開（中断した Run の再開の設計書 3.2、4.4、4.7、4.7.1。R5a）:
 * - 初めに、出力先の実行中の Run（動いている Run のロック）を確かめ、あれば Run を始めない（終了コード 4）。
 * - `--new` がなければ、途中の Run を探して選び（`selectRunToResume`）、版を確かめてから、続きから再開する。
 * - 保存のセッション（`RunCheckpointSession`）を作って Run Coordinator に渡し、Run の後に、保存の終わり方（`checkpointConclusion()`）に従う。
 * 判定（ロック、再開できるか、設定、版、選び方、保存の終わり方）は、`run-checkpoint.ts` と Run Coordinator の関数を呼ぶだけで、ここには
 * 書かない。ファイルの読み書きと削除は、`ArtifactWriter` に任せる（ARCH08）。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { AuditConfig } from '../config/types.js';
import type { AuditRunResult, RunId, RunProgressReport } from '../core/contracts.js';
import {
  artifactFilePath,
  isPortableRelativeArtifactPath,
  listCheckpointRunDirectories,
  listRunDirectories,
  runArtifactDirectory,
} from '../core/artifact-layout.js';
import { isRecord } from '../core/guards.js';
import { readPlaywrightVersion, readToolVersion } from '../orchestration/environment.js';
import type { BrowserLauncher } from '../orchestration/preflight.js';
import {
  checkRunCheckpointConsistency,
  checkRunCheckpointPageConsistency,
  currentProcessRunLockHost,
  decideRunResumption,
  isProcessRunning,
  judgeRunLock,
  runVersionDifferences,
  selectRunToResume,
  type RunResumeCandidate,
} from '../orchestration/run-checkpoint.js';
import { RunCheckpointSession } from '../orchestration/run-checkpoint-session.js';
import {
  RunCoordinator,
  RunDirectoryUnavailableError,
  RunResumeUnavailableError,
  type RunCoordinatorCheckpointConclusion,
  type RunCoordinatorDependencies,
  type RunCoordinatorResumeInput,
} from '../orchestration/run-coordinator.js';
import { ArtifactWriteError, ArtifactWriter } from '../report/artifact-writer.js';
import { createChatGptBundle, type ReadArtifactFile } from '../report/chatgpt-bundle.js';
import { renderHtmlReport } from '../report/html-report.js';
import { buildReportViewModel } from '../report/view-model.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { RUN_UNAVAILABLE_EXIT_CODE, exitCodeForRunStatus } from './exit-codes.js';
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
  runProgressLines,
  runResumeUnavailableLines,
  runStartedLines,
  runSummaryLines,
  unreadableCheckpointLines,
} from './output.js';
import type { CliOutput } from './output-stream.js';

/** `run` に注入するもの（本番の既定値は `PRODUCTION_RUN_DEPENDENCIES`）。 */
export interface RunCommandDependencies {
  /** Chromium を起動する関数。 */
  readonly launchBrowser: BrowserLauncher;
  /** 時刻に使う時計。 */
  readonly clock: () => Date;
  /** 期限と実行時間に使う、現在の時刻（ミリ秒。`Date.now()` と同じ基準）。保存のセッションのロックの時刻と、ロックの判定にも使う。 */
  readonly now: () => number;
  /**
   * Run Coordinator を作る関数（テスト用の差し替え口。R17r の Minor-2）。省略すると `new RunCoordinator(dependencies)`。
   * 本番の `run` が、確定した Run を `finishAuditRun` に渡すことと、Run の後に保存の終わり方（`checkpointConclusion()`）に従うことを、
   * テストで確かめるために使う。
   */
  readonly createRunCoordinator?: (dependencies: RunCoordinatorDependencies) => Pick<RunCoordinator, 'run' | 'checkpointConclusion'>;
  /**
   * 止める印（中断した Run の再開の設計書 4.6.1）。省略すると、止めない。Run Coordinator に、そのまま渡す（R5b が、シグナルとつなぐ口）。
   */
  readonly stopSignal?: AbortSignal | undefined;
}

/** `run` の指定（CLI の引数から決まるもの）。 */
export interface RunAuditCommandOptions {
  /** `--new` を付けた（途中の Run を探さずに、新しい Run を始める。中断した Run の再開の設計書 4.7）。 */
  readonly startNew: boolean;
}

/** `run` の指定の既定値（`--new` なし）。 */
const DEFAULT_RUN_AUDIT_COMMAND_OPTIONS: RunAuditCommandOptions = Object.freeze({ startNew: false });

/**
 * 本番の依存（Playwright の Chromium と、実際の時計）。Chromium は、Playwright の既定のシグナルの処理（SIGINT・SIGTERM・SIGHUP で
 * Browser を閉じてプロセスを終える）を止めて起動する（中断した Run の再開の設計書 4.7）。Playwright がプロセスを終えると、最後の処理
 * （出力の書き出し）が行われないためである。シグナルは、BeakSight が受ける（R5b）。
 */
export const PRODUCTION_RUN_DEPENDENCIES: RunCommandDependencies = Object.freeze<RunCommandDependencies>({
  launchBrowser: (options) => chromium.launch({ headless: options.headless, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }),
  clock: () => new Date(),
  now: () => Date.now(),
});

/**
 * 書き出し済みのファイルを、Run のディレクトリからの相対パスで読む関数を作る（設計書 6.1.9、U16d の報告）。
 * ファイルがない（`ENOENT`）場合は `null` を返し、ほかの入出力の失敗は、そのまま投げる。
 * 相対パスが安全でない場合は、読まずに `RangeError` を投げる（検証は `isPortableRelativeArtifactPath` の1か所。CC-027）。
 */
export const artifactFileReader = (runDirectory: string): ReadArtifactFile => async (relativePath) => {
  if (!isPortableRelativeArtifactPath(relativePath)) {
    throw new RangeError(`not a portable relative artifact path: ${JSON.stringify(relativePath)}`);
  }
  try {
    return await readFile(artifactFilePath(runDirectory, relativePath));
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/**
 * Run を実行し、書き出して、結果を表示する。Run の実行（Run Coordinator）の後は、`finishAuditRun` に任せる。
 * Run のディレクトリを作れなかった Run は、書き出さずに、`reportRunDirectoryUnavailable` で示して終える（DEF-009）。
 * 書き出しの入出力の失敗（`ArtifactWriteError`）と予期しない例外は、呼び出し側（`main.ts`）が扱う。
 *
 * 実行中は、Run Coordinator に進み具合の受け手（`onProgress`）を渡し、ページの監査が1つ終わるたびに、進み具合の1行
 * （`runProgressLines`）を標準出力に書く（サイトへの負荷の制御の設計書 4.8）。出し方は、開始の行と結果の行と同じ（`streams.stdout`。
 * 書き込みの失敗は、出力先が無視する）。受け手は Run を待たせないよう書き込みを待たず、Run の後、結果を書く前に、すべての書き込みの
 * 終わりを待つ。
 *
 * 再開の流れ（中断した Run の再開の設計書 4.7、4.7.1）:
 * 1. 開始の行を示す前に、出力先の実行中の Run を確かめる（`findActiveRun`）。あれば、文言を標準エラーに示して終える（終了コード 4。
 *    `--new` でも同じ）。Run も、出力も作らない。
 * 2. `--new` がなければ、途中の Run を選ぶ（`chooseRunToResume`）。版が違えば、文言を標準エラーに示して終える（終了コード 4）。知らせ
 *    （再開する、最後の処理だけを行う、設定が違う、壊れた保存）は、開始の行の前に、標準出力に示す。
 * 3. 保存のセッションを作り、Run Coordinator に、保存のセッションと、再開のときは再開の入力（`resumeFrom`）を渡す。止める印も渡す。
 * 4. Run の後の順:
 *    1. `RunDirectoryUnavailableError` なら、今のとおり示して終える（保存の終わり方は `NONE`）。
 *    2. `RunResumeUnavailableError` なら、理由ごとの文言を標準エラーに示して終える（終了コード 4。出力を作らない）。
 *    3. ほかの例外なら、保存の終わり方が `ABANDON` のときに `abandon()` を呼んでから、例外を呼び出し側に返す。
 *    4. 出力を書く（`finishAuditRun`）。失敗したら、保存の終わり方が `NONE` でなければ `abandon()` を呼んでから、例外を返す。
 *    5. 保存の終わり方に従う（`concludeCheckpoint`）。終了コードは、Run Status のとおり。
 */
export async function runAuditCommand(
  config: AuditConfig,
  streams: CliStreams,
  dependencies: RunCommandDependencies = PRODUCTION_RUN_DEPENDENCIES,
  options: RunAuditCommandOptions = DEFAULT_RUN_AUDIT_COMMAND_OPTIONS,
): Promise<number> {
  const outputDirectory = resolve(config.output.directory);
  const writer = new ArtifactWriter();

  // 1. 出力先の実行中の Run（設計書 4.7.1）。
  const activeRunId = await findActiveRun(writer, outputDirectory, dependencies.now());
  if (activeRunId !== null) {
    await streams.stderr.write(joinLines(activeRunLines(activeRunId)));
    return RUN_UNAVAILABLE_EXIT_CODE;
  }

  // 2. 途中の Run を選ぶ（`--new` のときは探さない）。
  const choice: RunResumeChoice = options.startNew ? NEW_RUN_CHOICE : await chooseRunToResume(writer, outputDirectory, config);
  if (choice.kind === 'VERSION_DIFFERS') {
    await streams.stderr.write(joinLines(choice.lines));
    return RUN_UNAVAILABLE_EXIT_CODE;
  }
  if (choice.notices.length > 0) {
    await streams.stdout.write(joinLines(choice.notices));
  }
  await streams.stdout.write(joinLines(runStartedLines(config)));

  // 進み具合の行の書き込み。書き込みは、受け手が呼ばれた順に始まる（出力先は、書いた順に出す）。
  let progressWritten: Promise<unknown> = Promise.resolve();
  const onProgress = (report: RunProgressReport): void => {
    const written = streams.stdout.write(joinLines(runProgressLines(report)));
    progressWritten = progressWritten.then(() => written);
  };

  // 3. 保存のセッションと Run Coordinator。
  const session = new RunCheckpointSession({ store: writer, now: dependencies.now });
  const resumeFrom = choice.kind === 'RESUME' ? choice.resumeFrom : undefined;
  const createRunCoordinator = dependencies.createRunCoordinator
    ?? ((coordinatorDependencies: RunCoordinatorDependencies) => new RunCoordinator(coordinatorDependencies));
  const coordinator = createRunCoordinator({
    config,
    launchBrowser: dependencies.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    clock: dependencies.clock,
    now: dependencies.now,
    outputDirectory,
    onProgress,
    checkpointSession: session,
    ...(resumeFrom === undefined ? {} : { resumeFrom }),
    ...(dependencies.stopSignal === undefined ? {} : { stopSignal: dependencies.stopSignal }),
  });

  // 4. Run の後。
  let result: AuditRunResult;
  try {
    result = await coordinator.run();
  } catch (error) {
    await progressWritten;
    if (error instanceof RunDirectoryUnavailableError) {
      return reportRunDirectoryUnavailable(error, streams.stderr);
    }
    if (error instanceof RunResumeUnavailableError) {
      return reportRunResumeUnavailable(error, streams.stderr);
    }
    if (coordinator.checkpointConclusion().action === 'ABANDON') {
      await session.abandon();
    }
    throw error;
  }
  await progressWritten;
  const conclusion = coordinator.checkpointConclusion();
  let exitCode: number;
  try {
    exitCode = await finishAuditRun(result, outputDirectory, streams.stdout);
  } catch (error) {
    if (conclusion.action !== 'NONE') {
      await session.abandon();
    }
    throw error;
  }
  const runDirectory = resumeFrom?.runDirectory ?? runArtifactDirectory(outputDirectory, result.run.runId);
  await concludeCheckpoint({ conclusion, session, writer, runDirectory, stderr: streams.stderr });
  return exitCode;
}

/**
 * 出力先（`outputDirectory`）の Run のディレクトリ（`listRunDirectories`）のロックを、名前の順に読み、動いている Run のもの（`judgeRunLock`
 * が `ACTIVE`）があれば、その Run の ID を返す（中断した Run の再開の設計書 4.7.1）。なければ `null`。今の時刻と OS の起動の時刻は
 * `currentProcessRunLockHost`、プロセスが動いているかは `isProcessRunning` で判定する。ロックには対象の ID がないので、対象を問わない。
 */
async function findActiveRun(writer: ArtifactWriter, outputDirectory: string, nowMs: number): Promise<RunId | null> {
  const host = currentProcessRunLockHost(nowMs);
  for (const { runId, runDirectory } of await listRunDirectories(outputDirectory)) {
    const lock = await writer.readRunLock(runDirectory);
    if (judgeRunLock(lock, { nowMs: host.nowMs, bootedAtMs: host.bootedAtMs, isProcessRunning }) === 'ACTIVE') {
      return runId;
    }
  }
  return null;
}

/**
 * 途中の Run の選び方の、CLI の結果。
 * - `NEW_RUN`: 新しい Run を始める。`notices` は、開始の前に示す知らせ（設定が違う、壊れた保存）。
 * - `RESUME`: `resumeFrom` で再開する。`notices` は、再開する（または最後の処理だけを行う）知らせと、ほかの知らせ。
 * - `VERSION_DIFFERS`: 版が違うので、Run を始めずに終える。`lines` は、標準エラーに示す行。
 */
type RunResumeChoice =
  | { readonly kind: 'NEW_RUN'; readonly notices: readonly string[] }
  | { readonly kind: 'RESUME'; readonly resumeFrom: RunCoordinatorResumeInput; readonly notices: readonly string[] }
  | { readonly kind: 'VERSION_DIFFERS'; readonly lines: readonly string[] };

const NEW_RUN_CHOICE: RunResumeChoice = Object.freeze({ kind: 'NEW_RUN', notices: Object.freeze([]) });

/**
 * 途中の Run を探して選ぶ（中断した Run の再開の設計書 4.7.1 の「途中の Run を探す読み方」「選び方」「版の確かめ」）。
 * 1. 保存のある Run のディレクトリ（`listCheckpointRunDirectories`）の `state.json`（使えなければ `state.prev.json`）だけを読む
 *    （`readCheckpointState`）。読めなかった Run は、壊れた保存として知らせる。
 * 2. 読めた Run から、`selectRunToResume` で選ぶ。設定が違えば知らせて、新しい Run を始める。
 * 3. 再開するなら、今の BeakSight と Playwright の版を、`runVersionDifferences` で保存の版と比べる。違えば `VERSION_DIFFERS`。
 * 4. 版が同じなら、ページの保存まで読む（`readCheckpoint`）。読めなければ、壊れた保存として知らせ、新しい Run を始める。読めた保存の
 *    `decideRunResumption` が `NOT_RESUMABLE` なら（`state.prev.json` に戻った場合などに起こりうる）、知らせずに新しい Run を始める。
 * 5. 再開するなら、`RESUME` なら監査を終えたページの数を添えて、`FINALIZE_ONLY` なら最後の処理だけを行うことを、知らせる。
 */
async function chooseRunToResume(writer: ArtifactWriter, outputDirectory: string, config: AuditConfig): Promise<RunResumeChoice> {
  const notices: string[] = [];
  const readable: RunResumeCandidate[] = [];
  for (const { runId, runDirectory } of await listCheckpointRunDirectories(outputDirectory)) {
    const read = await writer.readCheckpointState(runDirectory, checkRunCheckpointConsistency);
    if (read.ok) {
      readable.push({ runId, runDirectory, checkpoint: read.state });
    } else {
      notices.push(...unreadableCheckpointLines(runId));
    }
  }
  const selection = selectRunToResume(readable, config);
  if (selection.kind === 'START_NEW') {
    return { kind: 'NEW_RUN', notices };
  }
  const { candidate } = selection;
  if (selection.kind === 'CONFIG_DIFFERS') {
    return { kind: 'NEW_RUN', notices: [...notices, ...differentConfigRunLines(candidate.runId, selection.differences)] };
  }
  const versionDifferences = runVersionDifferences(candidate.checkpoint, {
    toolVersion: await readToolVersion(),
    playwrightVersion: readPlaywrightVersion(),
  });
  if (versionDifferences.length > 0) {
    return { kind: 'VERSION_DIFFERS', lines: differentVersionRunLines(candidate.runId, versionDifferences) };
  }
  const full = await writer.readCheckpoint(candidate.runDirectory, {
    checkState: checkRunCheckpointConsistency,
    checkPage: checkRunCheckpointPageConsistency,
  });
  if (!full.ok) {
    return { kind: 'NEW_RUN', notices: [...notices, ...unreadableCheckpointLines(candidate.runId)] };
  }
  const decision = decideRunResumption(full.state);
  if (decision === 'NOT_RESUMABLE') {
    return { kind: 'NEW_RUN', notices };
  }
  return {
    kind: 'RESUME',
    resumeFrom: { runDirectory: candidate.runDirectory, checkpoint: full.state, pages: full.pages },
    notices: [
      ...notices,
      ...(decision === 'RESUME'
        ? resumingRunLines(candidate.runId, full.state.completedPageIds.length)
        : finalizingRunLines(candidate.runId)),
    ],
  };
}

/**
 * 出力を書き終えた後に、保存の終わり方（Run Coordinator の `checkpointConclusion()`）に従う（中断した Run の再開の設計書 4.7.1 の「Run の後」）。
 * - `FINISH`: セッションの `finish` に最後の状態の保存を渡す。失敗したら、警告の1行を標準エラーに示し、`abandon()` を呼ぶ。最後の状態が
 *   `FINISHED` で、`finish` が成功したら、`ArtifactWriter.removeFinishedCheckpointFiles` で、使わない保存を片付ける。失敗したら、警告の
 *   1行（消せなかったパス）を示す。
 * - `ABANDON`: `abandon()` を呼ぶ。
 * - `NONE`: 何もしない。
 * どれも、終了コードを変えない（Run Status のとおり）。
 */
async function concludeCheckpoint(input: {
  readonly conclusion: RunCoordinatorCheckpointConclusion;
  readonly session: RunCheckpointSession;
  readonly writer: ArtifactWriter;
  readonly runDirectory: string;
  readonly stderr: CliOutput;
}): Promise<void> {
  const { conclusion, session, writer, runDirectory, stderr } = input;
  if (conclusion.action === 'ABANDON') {
    await session.abandon();
    return;
  }
  if (conclusion.action !== 'FINISH') {
    return;
  }
  try {
    await session.finish(conclusion.checkpoint);
  } catch {
    await stderr.write(joinLines(checkpointFinishFailedLines()));
    await session.abandon();
    return;
  }
  if (conclusion.checkpoint.state !== 'FINISHED') {
    return;
  }
  try {
    await writer.removeFinishedCheckpointFiles(runDirectory);
  } catch (error) {
    const path = error instanceof ArtifactWriteError ? error.path : runDirectory;
    await stderr.write(joinLines(finishedCheckpointCleanupFailedLines(path)));
  }
}

/**
 * Run のディレクトリを作れなかった Run を、日本語の文言、Run Status、Run のディレクトリのパス、1行の技術的な詳細で示し、終了コードを
 * 返す（DEF-009）。artifact は書かない（`ArtifactWriter` を呼ばない）。書く場所が、別の Run のディレクトリだからである。
 * 終了コードは、確定した Run の Run Status（`deriveRunStatus` が導いた `FAILED`）から、`exit-codes.ts` の表で決める。
 */
async function reportRunDirectoryUnavailable(error: RunDirectoryUnavailableError, stderr: CliOutput): Promise<number> {
  const { runStatus } = error.result.run;
  await stderr.write(joinLines(runDirectoryUnavailableLines({
    alreadyExists: error.alreadyExists,
    runStatus,
    runDirectory: error.runDirectory,
    cause: error.cause,
  })));
  return exitCodeForRunStatus(runStatus);
}

/**
 * 再開のときに、保存のセッションを始められなかった Run（`RunResumeUnavailableError`。中断した Run の再開の設計書 4.4、4.7.1）を、理由ごとの
 * 文言で示し、終了コード 4 を返す。Run Coordinator は Run を確定していないので、出力を書かない。
 */
async function reportRunResumeUnavailable(error: RunResumeUnavailableError, stderr: CliOutput): Promise<number> {
  await stderr.write(joinLines(runResumeUnavailableLines({ reason: error.reason, runId: error.runId, cause: error.cause })));
  return RUN_UNAVAILABLE_EXIT_CODE;
}

/**
 * 確定した Run（`AuditRunResult`）を書き出し、表示用モデルから結果を表示して、終了コードを返す（設計書 第7章、R17 の指摘2）。
 * Run Coordinator の実行とは分ける。書き出しの順（設計書 6.1.8）:
 * 1. `ArtifactWriter.writeRun`（スキーマに合わない場合は、ここで Run Status が導き直される）
 * 2. `buildReportViewModel(written.result)`
 * 3. `renderHtmlReport(viewModel)`
 * 4. `createChatGptBundle(viewModel, written.result, readArtifactFile)`
 * 5. `ArtifactWriter.writePresentation(written, { reportHtml, bundle })`
 * 終了コードは、`writeRun` が返した最終の Run（導き直した後の Run Status）から、`exit-codes.ts` の表で決める。
 * 渡された `result` の Run Status（導き直しの前）は使わない。
 */
export async function finishAuditRun(result: AuditRunResult, outputDirectory: string, stdout: CliOutput): Promise<number> {
  const writer = new ArtifactWriter();
  const written = await writer.writeRun(result, { outputDirectory });
  const viewModel = buildReportViewModel(written.result);
  const reportHtml = renderHtmlReport(viewModel);
  const bundle = await createChatGptBundle(viewModel, written.result, artifactFileReader(written.runDirectory));
  await writer.writePresentation(written, { reportHtml, bundle });

  await stdout.write(joinLines(['', ...runSummaryLines(viewModel.summary, written.runDirectory)]));
  return exitCodeForRunStatus(written.result.run.runStatus);
}
