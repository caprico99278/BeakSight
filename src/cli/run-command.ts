/**
 * `run` のコマンド: Run Coordinator を組み立てて Run を実行し、artifact・HTML レポート・ChatGPT 用バンドルを書き出して、結果を表示する
 * （Task 14〜17 の設計書 第7章、6.1.8、6.1.9、実装計画 Task 17 の Step 2）。
 * Playwright を読み込むので、`main.ts` は、`run` のときだけ、このファイルを読み込む。
 * Run のディレクトリを作れなかった Run（`RunDirectoryUnavailableError`。DEF-009）は、`ArtifactWriter` を呼ばずに、日本語の文言と
 * Run のディレクトリのパスを標準エラーに示して終える。終了コードは、その Run の Run Status（`FAILED`）から、終了コードの表で決める。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import type { AuditConfig } from '../config/types.js';
import type { AuditRunResult } from '../core/contracts.js';
import { artifactFilePath, isPortableRelativeArtifactPath } from '../core/artifact-layout.js';
import { isRecord } from '../core/guards.js';
import type { BrowserLauncher } from '../orchestration/preflight.js';
import {
  RunCoordinator,
  RunDirectoryUnavailableError,
  type RunCoordinatorDependencies,
} from '../orchestration/run-coordinator.js';
import { ArtifactWriter } from '../report/artifact-writer.js';
import { createChatGptBundle, type ReadArtifactFile } from '../report/chatgpt-bundle.js';
import { renderHtmlReport } from '../report/html-report.js';
import { buildReportViewModel } from '../report/view-model.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { exitCodeForRunStatus } from './exit-codes.js';
import type { CliStreams } from './main.js';
import { joinLines, runDirectoryUnavailableLines, runStartedLines, runSummaryLines } from './output.js';
import type { CliOutput } from './output-stream.js';

/** `run` に注入するもの（本番の既定値は `PRODUCTION_RUN_DEPENDENCIES`）。 */
export interface RunCommandDependencies {
  /** Chromium を起動する関数。 */
  readonly launchBrowser: BrowserLauncher;
  /** 時刻に使う時計。 */
  readonly clock: () => Date;
  /** 期限と実行時間に使う、現在の時刻（ミリ秒。`Date.now()` と同じ基準）。 */
  readonly now: () => number;
  /**
   * Run Coordinator を作る関数（テスト用の差し替え口。R17r の Minor-2）。省略すると `new RunCoordinator(dependencies)`。
   * 本番の `run` が、確定した Run を `finishAuditRun` に渡すことを、テストで確かめるために使う。
   */
  readonly createRunCoordinator?: (dependencies: RunCoordinatorDependencies) => Pick<RunCoordinator, 'run'>;
}

/** 本番の依存（Playwright の Chromium と、実際の時計）。 */
export const PRODUCTION_RUN_DEPENDENCIES: RunCommandDependencies = Object.freeze<RunCommandDependencies>({
  launchBrowser: (options) => chromium.launch({ headless: options.headless }),
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
 */
export async function runAuditCommand(
  config: AuditConfig,
  streams: CliStreams,
  dependencies: RunCommandDependencies = PRODUCTION_RUN_DEPENDENCIES,
): Promise<number> {
  const outputDirectory = resolve(config.output.directory);
  await streams.stdout.write(joinLines(runStartedLines(config)));

  const createRunCoordinator = dependencies.createRunCoordinator
    ?? ((coordinatorDependencies: RunCoordinatorDependencies) => new RunCoordinator(coordinatorDependencies));
  const coordinator = createRunCoordinator({
    config,
    launchBrowser: dependencies.launchBrowser,
    createSafetyLedger: () => new SafetyLedger(),
    clock: dependencies.clock,
    now: dependencies.now,
    outputDirectory,
  });
  let result: AuditRunResult;
  try {
    result = await coordinator.run();
  } catch (error) {
    if (error instanceof RunDirectoryUnavailableError) {
      return reportRunDirectoryUnavailable(error, streams.stderr);
    }
    throw error;
  }
  return finishAuditRun(result, outputDirectory, streams.stdout);
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
