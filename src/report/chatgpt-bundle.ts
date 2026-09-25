/**
 * ChatGPT 用バンドル（`beaksight-audit-bundle.zip`）の中身の唯一の owner（Task 14〜17 の設計書 6.1.2、6.1.8、6.1.9、6.1.11。
 * 上位の設計書 第19章）。
 * - 表示用モデル（`buildReportViewModel` の結果）から、ZIP のバイト列を作って返す。ファイルは書かない。書くのは
 *   `ArtifactWriter.writePresentation` だけである（ARCH08）。
 * - ZIP に入れるものと順: `manifest.json`、`run.json`、`summary.json`、`findings.json`、`pages.json`、`evidence-index.json`、
 *   各ページの `page.json`（パスの順。設計書 6.1.11）、関係するスクリーンショット（`ScreenshotView.relatedFindingIds` が空でない
 *   もの。再試行の前の試行のものを含む。パスの順）。
 * - `run.json`、`page.json`、スクリーンショットは、書き出し済みのファイルを `readArtifactFile` で読み、そのまま入れる（組み立て
 *   直さない）。パスは、Run のディレクトリの中と同じにする。読めなかった（`null`）ものは入れず、`manifest.json` の `omittedFiles`
 *   に書く。Run Status は変えない（決めるのは `deriveRunStatus` だけで、バンドルの前に確定している）。
 * - `page.json` を入れるのは、`evidence-index.json` の `path` と `pointer` を、ZIP の中だけでたどれるようにするためである
 *   （上位の設計書 第19章「`evidenceRef` で一次証跡へ追跡可能にする」。設計書 6.1.11）。
 * - スクリーンショットの合計の大きさには、上限（既定は `CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`）がある（設計書 6.1.11）。
 *   `VIEWPORT` のもの（パスの順）、`FULL_PAGE` のもの（パスの順）の順に入れ、合計が上限を超えるものは入れない（`omittedFiles` に、
 *   理由 `BUNDLE_SIZE_LIMIT` で書く）。超えた後も、それより小さいものは入れる。ZIP の中の並びは、パスの順のままである。
 *   上限の値は、`manifest.json` の `screenshotBudgetBytes` に書く。
 * - JSON は、字下げ2文字、末尾に LF、UTF-8 にする（書式は `artifactJsonBytes` だけで組み立てる。CC-026）。値は、英数字の
 *   コードのままにし、日本語のラベル（理由の説明など）は入れない。
 *   Finding と Evidence は、`findings.json` と `evidence-index.json` の1か所に置き、`pages.json` からは ID で参照する。
 * - 生のレスポンス本文は、入れない。`visible-text.txt` は読まない。このファイルが組み立てる JSON は、表示用モデルだけから作る。
 *   `page.json` は、記録した Evidence（一次の証拠）として、読んだバイト列のまま入れる（設計書 6.1.11）。
 * - 決定論: fflate の `zipSync` を使い、各項目の時刻を固定の値にする。同じ入力からは、同じバイト列を作る。
 * - ZIP の中のパスは、区切りを `/` にし、`..` や絶対パスを含めない。`page.json` とスクリーンショットのパスは、
 *   `assertPagesEntryPath` の1か所で確かめ（相対パスの規則は `isPortableRelativeArtifactPath`。CC-027）、不正なら、どのファイルも
 *   読む前に `RangeError` を投げる。
 */
import { zipSync, type Zippable } from 'fflate';
import { distinctSorted } from '../audit/rule-helpers.js';
import {
  PAGES_ARTIFACT_DIRECTORY,
  RUN_ARTIFACT_FILE_NAMES,
  isPortableRelativeArtifactPath,
} from '../core/artifact-layout.js';
import type { AuditRunResult, EvidenceId, FindingId, IncompleteReasonCode, RunId, RunStatus } from '../core/contracts.js';
import type { ScreenshotCaptureType } from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { createSha256FingerprintOfBytes } from '../core/ids.js';
import { CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES } from '../core/limits.js';
import { artifactJsonBytes } from './artifact-json.js';
import type { ReasonView, ReportViewModel, ScreenshotView } from './view-model.js';

// ---------------------------------------------------------------------------------------------------------------
// 定数と型
// ---------------------------------------------------------------------------------------------------------------

/** `manifest.json` の `bundleSchemaVersion`。 */
export const CHATGPT_BUNDLE_SCHEMA_VERSION = 'chatgpt-bundle/1.0';

/** ZIP の中で、このファイルが作る JSON の名前（`run.json` は、Run のディレクトリと同じ `RUN_ARTIFACT_FILE_NAMES.run`）。 */
export const CHATGPT_BUNDLE_FILE_NAMES = Object.freeze({
  manifest: 'manifest.json',
  summary: 'summary.json',
  findings: 'findings.json',
  pages: 'pages.json',
  evidenceIndex: 'evidence-index.json',
} as const);

/**
 * `manifest.json` の `omittedFiles[].reason`。
 * - `ARTIFACT_FILE_NOT_FOUND`: `readArtifactFile` が `null` を返した。
 * - `BUNDLE_SIZE_LIMIT`: スクリーンショットの合計の大きさの上限を超えるので、入れなかった（設計書 6.1.11）。
 */
export const CHATGPT_BUNDLE_OMISSION_REASONS = Object.freeze(['ARTIFACT_FILE_NOT_FOUND', 'BUNDLE_SIZE_LIMIT'] as const);
export type ChatGptBundleOmissionReason = (typeof CHATGPT_BUNDLE_OMISSION_REASONS)[number];

/** `createChatGptBundle` の省略できる指定。 */
export interface ChatGptBundleOptions {
  /**
   * スクリーンショットの合計の大きさの上限（バイト。0 以上の安全な整数）。既定は `CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`
   * （設計書 6.1.11）。テストで小さな上限を注入するためにある。
   */
  readonly screenshotBudgetBytes?: number;
}

/**
 * 書き出し済みのファイルを、Run のディレクトリからの相対パス（区切りは `/`）で読む関数。ファイルがなければ `null` を返す。
 * CLI が、`artifactFilePath(runDirectory, relativePath)` と `readFile` で作って渡す。
 */
export type ReadArtifactFile = (relativePath: string) => Promise<Uint8Array | null>;

/** `manifest.json` の中身。 */
export interface ChatGptBundleManifest {
  readonly bundleSchemaVersion: typeof CHATGPT_BUNDLE_SCHEMA_VERSION;
  readonly runId: RunId;
  readonly runStatus: RunStatus;
  readonly toolVersion: string;
  /** Run の `finishedAt`。 */
  readonly generatedAt: string | null;
  /** スクリーンショットの合計の大きさの上限（バイト。設計書 6.1.11）。 */
  readonly screenshotBudgetBytes: number;
  /** `manifest.json` を除く、ZIP の中のすべてのファイル（ZIP の中の順）。 */
  readonly files: readonly { readonly path: string; readonly byteLength: number; readonly sha256: string }[];
  /** 入れられなかったファイル（ZIP の中の順）。 */
  readonly omittedFiles: readonly { readonly path: string; readonly reason: ChatGptBundleOmissionReason }[];
}

/**
 * ZIP の各項目の時刻（固定）。fflate は、時刻を実行環境の地方時で DOS の日時に変えるので、時差の表記のない日時の文字列
 * （地方時として解釈される）にして、どの時間帯でも同じバイト列にする。DOS の日時で表せる最も早い日時である。
 */
const ZIP_ENTRY_MODIFIED_AT = '1980-01-01T00:00:00';

// ---------------------------------------------------------------------------------------------------------------
// パスの検証
// ---------------------------------------------------------------------------------------------------------------

/**
 * `page.json` とスクリーンショットの、ZIP の中のパス（Run のディレクトリからの相対パスと同じ）を確かめる。
 * 相対パスとしての安全さ（区切りは `/`、空・`.`・`..` の区切りがない、絶対パス・ドライブ・URL・バックスラッシュ・制御文字を
 * 含まない）は、`isPortableRelativeArtifactPath` で確かめる（CC-027）。バンドルの追加の条件として、`pages/` の下にあること
 * （設計書 6.1.9: `pages/<pageId>/.../*.png`、6.1.11: `pages/<pageId>/page.json`）を確かめる。日本語などの文字は、そのまま認める。
 * 不正なら `RangeError` を投げる。
 */
function assertPagesEntryPath(path: string): void {
  if (!isPortableRelativeArtifactPath(path) || !path.startsWith(`${PAGES_ARTIFACT_DIRECTORY}/`)) {
    throw new RangeError(`bundle entry path is not a portable relative path under the pages directory: ${JSON.stringify(path)}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 論理ビュー
// ---------------------------------------------------------------------------------------------------------------

/** 理由から、日本語の説明を除いたもの（コードと、技術的な詳細だけ）。 */
const reasonCodes = (
  reasons: readonly ReasonView[],
): readonly { readonly code: IncompleteReasonCode; readonly detail: string | null }[] =>
  reasons.map(({ code, detail }) => ({ code, detail }));

/** `summary.json`: 表示用モデルの `summary`（理由の説明を除く）。 */
const summaryView = (model: ReportViewModel): object => ({
  ...model.summary,
  incompleteReasons: reasonCodes(model.summary.incompleteReasons),
});

/** `findings.json`: 各 Finding と、それが参照する Evidence の場所（どのページにもなければ `null`）と、関係するスクリーンショットのパス。 */
const findingsView = (model: ReportViewModel): object =>
  model.findings.map(({ finding, evidence, screenshots }) => ({
    finding,
    evidence: evidence.map(({ evidenceId, location }) => ({
      evidenceId,
      path: location === null ? null : location.path,
      pointer: location === null ? null : location.pointer,
    })),
    screenshotPaths: screenshots.map((screenshot) => screenshot.relativePath),
  }));

/**
 * `pages.json`: 表示用モデルの `pages`（理由の説明を除く）。Finding と、再試行の前の試行の Evidence は、`findings.json` と
 * `evidence-index.json` にあるので、ID で参照する（同じ内容を ZIP の中に2つ持たない）。
 */
const pagesView = (model: ReportViewModel): object =>
  model.pages.map(({ findings, retryAttempts, incompleteReasons, viewports, ...page }) => ({
    ...page,
    incompleteReasons: reasonCodes(incompleteReasons),
    viewports: viewports.map((viewport) => ({ ...viewport, incompleteReasons: reasonCodes(viewport.incompleteReasons) })),
    findingIds: findings.map(({ finding }): FindingId => finding.findingId),
    retryAttempts: retryAttempts.map(({ evidence, ...attempt }) => ({
      ...attempt,
      evidenceIds: evidence.map((location): EvidenceId => location.evidenceId),
    })),
  }));

/** 各ページの `page.json` のパス（重複なし、パスの順。設計書 6.1.11）。 */
const pageJsonPaths = (model: ReportViewModel): readonly string[] => distinctSorted(model.pages.map((page) => page.pageJsonPath));

/** 関係するスクリーンショット（`relatedFindingIds` が空でないもの。再試行の前の試行のものを含む）。 */
const relatedScreenshots = (model: ReportViewModel): readonly ScreenshotView[] =>
  model.pages
    .flatMap((page) => [...page.screenshots, ...page.retryAttempts.flatMap((attempt) => attempt.screenshots)])
    .filter((screenshot) => screenshot.relatedFindingIds.length > 0);

/**
 * スクリーンショットを入れる順の、撮り方の優先度（小さいほど先。設計書 6.1.11: `VIEWPORT`、`FULL_PAGE` の順）。
 * `Record` なので、撮り方を加えると、ここの書き漏れが型のエラーになる。
 */
const SCREENSHOT_BUDGET_PRIORITY: Readonly<Record<ScreenshotCaptureType, number>> = Object.freeze({
  VIEWPORT: 0,
  FULL_PAGE: 1,
});

/**
 * 関係するスクリーンショットのパスを、入れる順に並べる（重複なし。設計書 6.1.11）。撮り方の優先度
 * （`SCREENSHOT_BUDGET_PRIORITY`）の順に分け、それぞれをパスの順に並べる。同じパスが2つの撮り方で現れた場合は、優先度の高い方に入れる。
 */
function screenshotPathsInBudgetOrder(screenshots: readonly ScreenshotView[]): readonly string[] {
  const priorities = new Map<string, number>();
  for (const { relativePath, captureType } of screenshots) {
    const priority = SCREENSHOT_BUDGET_PRIORITY[captureType];
    priorities.set(relativePath, Math.min(priority, priorities.get(relativePath) ?? priority));
  }
  // パスの順に並べてから、優先度で安定に並べ直す（同じ優先度の中は、パスの順のまま）。
  return distinctSorted(priorities.keys()).sort(
    (left, right) => (priorities.get(left) ?? 0) - (priorities.get(right) ?? 0),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// バンドル
// ---------------------------------------------------------------------------------------------------------------

async function readOptionalArtifact(readArtifactFile: ReadArtifactFile, relativePath: string): Promise<Uint8Array | null> {
  const bytes: unknown = await readArtifactFile(relativePath);
  if (bytes !== null && !(bytes instanceof Uint8Array)) {
    throw new TypeError(`readArtifactFile must return a Uint8Array or null: ${relativePath}`);
  }
  return bytes;
}

/** ファイルを読んだ結果（入れるか、入れなかった理由）。 */
type ArtifactOutcome =
  | { readonly kind: 'included'; readonly bytes: Uint8Array }
  | { readonly kind: 'omitted'; readonly reason: ChatGptBundleOmissionReason };

/**
 * ChatGPT 用バンドルの ZIP のバイト列を作る（設計書 6.1.9、6.1.11）。ファイルは書かない。
 * - `viewModel` は、`result`（`ArtifactWriter.writeRun` の戻り値の `result`）から組み立てたものでなければならない。`runId` か
 *   Run Status が違う場合は、何も読まずに `RangeError` を投げる。
 * - `readArtifactFile` は、`run.json`、各ページの `page.json`（パスの順）、関係するスクリーンショット（入れる順: `VIEWPORT` の
 *   パスの順、`FULL_PAGE` のパスの順）を、この順に1回ずつ読む。例外は、そのまま伝える。上限を超えたスクリーンショットの
 *   バイト列は、読んだ後に捨てる（持ち続けるのは、上限の中に入れたものだけである）。
 * - `page.json` かスクリーンショットのパスが不正な場合と、上限が 0 以上の安全な整数でない場合は、何も読まずに `RangeError` を投げる。
 * @param options.screenshotBudgetBytes スクリーンショットの合計の大きさの上限。既定は `CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`。
 */
export async function createChatGptBundle(
  viewModel: ReportViewModel,
  result: AuditRunResult,
  readArtifactFile: ReadArtifactFile,
  options: ChatGptBundleOptions = {},
): Promise<Uint8Array> {
  const { run } = result;
  if (viewModel.summary.runId !== run.runId || viewModel.summary.runStatus !== run.runStatus) {
    throw new RangeError(`the view model was not built from this Run: ${viewModel.summary.runId} and ${run.runId}`);
  }
  const screenshotBudgetBytes = options.screenshotBudgetBytes ?? CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES;
  if (!isNonNegativeSafeInteger(screenshotBudgetBytes)) {
    throw new RangeError(`the screenshot budget must be a non-negative safe integer: ${String(screenshotBudgetBytes)}`);
  }
  const pagePaths = pageJsonPaths(viewModel);
  const screenshotPaths = screenshotPathsInBudgetOrder(relatedScreenshots(viewModel));
  for (const path of [...pagePaths, ...screenshotPaths]) {
    assertPagesEntryPath(path);
  }

  // 1. 読む（run.json、page.json、スクリーンショットを入れる順）。
  const [notFound, sizeLimit] = CHATGPT_BUNDLE_OMISSION_REASONS;
  const readOutcome = async (path: string): Promise<ArtifactOutcome> => {
    const bytes = await readOptionalArtifact(readArtifactFile, path);
    return bytes === null ? { kind: 'omitted', reason: notFound } : { kind: 'included', bytes };
  };
  const runOutcome = await readOutcome(RUN_ARTIFACT_FILE_NAMES.run);
  const pageOutcomes = new Map<string, ArtifactOutcome>();
  for (const path of pagePaths) {
    pageOutcomes.set(path, await readOutcome(path));
  }
  const screenshotOutcomes = new Map<string, ArtifactOutcome>();
  let screenshotBytes = 0;
  for (const path of screenshotPaths) {
    const outcome = await readOutcome(path);
    if (outcome.kind === 'included' && screenshotBytes + outcome.bytes.byteLength > screenshotBudgetBytes) {
      screenshotOutcomes.set(path, { kind: 'omitted', reason: sizeLimit });
    } else {
      screenshotOutcomes.set(path, outcome);
      screenshotBytes += outcome.kind === 'included' ? outcome.bytes.byteLength : 0;
    }
  }

  // 2. ZIP の中の順に並べる（スクリーンショットは、パスの順）。
  const files: { readonly path: string; readonly bytes: Uint8Array }[] = [];
  const omittedFiles: { readonly path: string; readonly reason: ChatGptBundleOmissionReason }[] = [];
  const place = (path: string, outcome: ArtifactOutcome): void => {
    if (outcome.kind === 'included') {
      files.push({ path, bytes: outcome.bytes });
    } else {
      omittedFiles.push({ path, reason: outcome.reason });
    }
  };
  place(RUN_ARTIFACT_FILE_NAMES.run, runOutcome);
  files.push(
    { path: CHATGPT_BUNDLE_FILE_NAMES.summary, bytes: artifactJsonBytes(summaryView(viewModel)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.findings, bytes: artifactJsonBytes(findingsView(viewModel)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.pages, bytes: artifactJsonBytes(pagesView(viewModel)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.evidenceIndex, bytes: artifactJsonBytes(viewModel.evidence) },
  );
  for (const [path, outcome] of pageOutcomes) {
    place(path, outcome);
  }
  for (const path of distinctSorted(screenshotPaths)) {
    const outcome = screenshotOutcomes.get(path);
    if (outcome !== undefined) {
      place(path, outcome);
    }
  }

  // 3. manifest と ZIP（読み終えた後に、同期で作る）。
  const manifest: ChatGptBundleManifest = {
    bundleSchemaVersion: CHATGPT_BUNDLE_SCHEMA_VERSION,
    runId: run.runId,
    runStatus: run.runStatus,
    toolVersion: run.toolVersion,
    generatedAt: run.finishedAt,
    screenshotBudgetBytes,
    files: files.map(({ path, bytes }) => ({ path, byteLength: bytes.byteLength, sha256: createSha256FingerprintOfBytes(bytes) })),
    omittedFiles,
  };
  // fflate は、項目をオブジェクトの鍵の順に並べる。鍵は、固定の名前と `pages/` で始まるパスだけなので、挿入の順のままである。
  const zippable: Zippable = { [CHATGPT_BUNDLE_FILE_NAMES.manifest]: artifactJsonBytes(manifest) };
  for (const { path, bytes } of files) {
    zippable[path] = bytes;
  }
  return zipSync(zippable, { mtime: ZIP_ENTRY_MODIFIED_AT });
}
