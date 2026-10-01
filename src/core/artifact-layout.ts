/**
 * artifact の配置（ディレクトリとファイルの名前、パスの組み立て）の唯一の owner（Task 14〜17 の設計書 6.1.2、6.1.8。CC-023）。
 * - Page Auditor（スクリーンショット）、Run Coordinator（Run のディレクトリ）、`ArtifactWriter`（書き出し）、表示用モデル（Evidence と
 *   ファイルの対応）は、どれもここから取る。ほかの場所で、配置の名前やパスを組み立てない。
 * - Run のディレクトリからの相対パスは、区切りを `/` にする（artifact の中に書く値。環境によらない）。
 *   ファイルのパス（`runArtifactDirectory`、`artifactFilePath`）は、実行している環境の区切りにする（`node:path` の `join`）。
 * - 配置:
 *   - `<出力先>/<runId>/`: `run.json`、`audit.json`、`report.html`、`beaksight-audit-bundle.zip`
 *   - `pages/<pageId>/`: `page.json`、`visible-text.txt`
 *   - `pages/<pageId>/<ビューポート>/`: `viewport.png`、`full-page.png`（Page Auditor が撮る。Task 14 の設計 4.5.5）
 *   - 再試行の前の試行のスクリーンショット: `pages/<pageId>/retry-<n>/<ビューポート>/`（DEF-007）
 * - Run のディレクトリからの相対パスが安全かどうかの検証（`isPortableRelativeArtifactPath`、`isPortableArtifactPathSegment`）も、
 *   ここだけで行う（CC-027）。スクリーンショットの収集、`ArtifactWriter`、ChatGPT 用バンドルは、どれもここを使う。
 * - 中断した Run の再開のための保存（チェックポイント）とロックの配置（中断した Run の再開の設計書 4.1、4.4）:
 *   - `checkpoint/`: `state.json`、`state.prev.json`、`run.lock`
 *   - `checkpoint/pages/<pageId>.json`: ページの保存
 *   保存のファイルを読み書きし、消すのは `ArtifactWriter` である。ここは、名前とパスだけを持つ。
 * - PREFLIGHT が Run のディレクトリの直下に作る一時ファイルの名前（接頭辞と接尾辞）も、ここに置く（PREFLIGHT が作り、再開のときの
 *   後始末で `ArtifactWriter` が消す。report の層は orchestration を import しないため）。
 * - Run のディレクトリを排他的に作る処理（`createRunArtifactDirectory`。DEF-009）と、Run のディレクトリの一覧の読み取り
 *   （`listRunDirectories` と、それから保存のあるものを選ぶ `listCheckpointRunDirectories`。読むだけ）も、ここに置く。このファイルで
 *   入出力を行うのは、これらだけである。
 */
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import type { PageId, RunId, ViewportProfile } from './contracts.js';
import type { ScreenshotCaptureType } from './evidence-types.js';
import { isPositiveSafeInteger, isRecord } from './guards.js';
import { isPageId, isRunId } from './ids.js';
import { compareCodeUnits } from './text.js';

/** Run のディレクトリの直下のファイルの名前。 */
export const RUN_ARTIFACT_FILE_NAMES = Object.freeze({
  run: 'run.json',
  audit: 'audit.json',
  report: 'report.html',
  bundle: 'beaksight-audit-bundle.zip',
} as const);

/** `pages/<pageId>/` の中のファイルの名前。 */
export const PAGE_ARTIFACT_FILE_NAMES = Object.freeze({
  page: 'page.json',
  visibleText: 'visible-text.txt',
} as const);
export type PageArtifactFile = keyof typeof PAGE_ARTIFACT_FILE_NAMES;

/** ページごとのディレクトリ（`<この名前>/<pageId>/`）を置く、Run のディレクトリの直下のディレクトリの名前。 */
export const PAGES_ARTIFACT_DIRECTORY = 'pages';

/** 再試行の前の試行のスクリーンショットを置くディレクトリの名前の接頭辞（`retry-<試行の番号>`。DEF-007）。 */
export const RETRY_ARTIFACT_DIRECTORY_PREFIX = 'retry-';

/** スクリーンショットのファイルの名前（撮り方ごと）。 */
export const SCREENSHOT_FILE_NAMES = Object.freeze({
  VIEWPORT: 'viewport.png',
  FULL_PAGE: 'full-page.png',
} as const satisfies Record<ScreenshotCaptureType, string>);

/** 再開のための保存（チェックポイント）とロックを置く、Run のディレクトリの直下のディレクトリの名前（中断した Run の再開の設計書 4.1）。 */
export const CHECKPOINT_ARTIFACT_DIRECTORY = 'checkpoint';

/** `checkpoint/` の中のファイルの名前（状態の保存、1つ前の状態の保存、ロック。設計書 4.1、4.3、4.4）。 */
export const CHECKPOINT_ARTIFACT_FILE_NAMES = Object.freeze({
  state: 'state.json',
  previousState: 'state.prev.json',
  lock: 'run.lock',
} as const);
export type CheckpointArtifactFile = keyof typeof CHECKPOINT_ARTIFACT_FILE_NAMES;

/** ページの保存（`<pageId>.json`）を置くディレクトリの、Run のディレクトリからの相対パス（区切りは `/`。`checkpoint/pages`）。 */
export const CHECKPOINT_PAGES_ARTIFACT_DIRECTORY = `${CHECKPOINT_ARTIFACT_DIRECTORY}/${PAGES_ARTIFACT_DIRECTORY}`;

/** ページの保存のファイルの名前の接尾辞（`<pageId>.json`）。 */
const CHECKPOINT_PAGE_FILE_SUFFIX = '.json';

/** PREFLIGHT が出力先を確かめるために、Run のディレクトリの直下に作って消す一時ファイルの名前の接頭辞（`<接頭辞><UUID><接尾辞>`）。 */
export const PREFLIGHT_TEMPORARY_FILE_PREFIX = '.beaksight-preflight-';
/** PREFLIGHT の一時ファイルの名前の接尾辞。 */
export const PREFLIGHT_TEMPORARY_FILE_SUFFIX = '.tmp';

/** Run の artifact を置くディレクトリ（`<出力先の根>/<runId>`。区切りは実行している環境のもの）。 */
export function runArtifactDirectory(outputDirectory: string, runId: RunId): string {
  return join(outputDirectory, runId);
}

/** ページのファイルの、Run のディレクトリからの相対パス（区切りは `/`。例: `pages/PAGE-000001/page.json`）。 */
export const pageArtifactRelativePath = (pageId: PageId, file: PageArtifactFile): string =>
  `${PAGES_ARTIFACT_DIRECTORY}/${pageId}/${PAGE_ARTIFACT_FILE_NAMES[file]}`;

/** `checkpoint/` の中のファイルの、Run のディレクトリからの相対パス（区切りは `/`。例: `checkpoint/state.json`）。 */
export const checkpointArtifactRelativePath = (file: CheckpointArtifactFile): string =>
  `${CHECKPOINT_ARTIFACT_DIRECTORY}/${CHECKPOINT_ARTIFACT_FILE_NAMES[file]}`;

/** ページの保存の、Run のディレクトリからの相対パス（区切りは `/`。例: `checkpoint/pages/PAGE-000001.json`）。 */
export const checkpointPageArtifactRelativePath = (pageId: PageId): string =>
  `${CHECKPOINT_PAGES_ARTIFACT_DIRECTORY}/${pageId}${CHECKPOINT_PAGE_FILE_SUFFIX}`;

/**
 * `checkpoint/pages/` の中のファイルの名前が、ページの保存の名前（`<pageId>.json`。ページの ID は `isPageId` の形）なら、その
 * ページの ID を返す。そうでなければ `null`（再開のときの後始末で、ページの保存だけを見分けるために使う）。
 */
export function checkpointPageIdOfFileName(fileName: string): PageId | null {
  if (!fileName.endsWith(CHECKPOINT_PAGE_FILE_SUFFIX)) {
    return null;
  }
  const pageId = fileName.slice(0, -CHECKPOINT_PAGE_FILE_SUFFIX.length);
  return isPageId(pageId) ? pageId : null;
}

/** PREFLIGHT の一時ファイルの名前（接頭辞と接尾辞の間に1文字以上ある）か。 */
export const isPreflightTemporaryFileName = (fileName: string): boolean =>
  fileName.length > PREFLIGHT_TEMPORARY_FILE_PREFIX.length + PREFLIGHT_TEMPORARY_FILE_SUFFIX.length
  && fileName.startsWith(PREFLIGHT_TEMPORARY_FILE_PREFIX)
  && fileName.endsWith(PREFLIGHT_TEMPORARY_FILE_SUFFIX);

/**
 * スクリーンショットの、Run のディレクトリからの相対パス（区切りは `/`）。
 * 最終の試行（`retryAttempt` が `null`）は `pages/<pageId>/<ビューポート>/<ファイル名>`、再試行の前の試行は
 * `pages/<pageId>/retry-<retryAttempt>/<ビューポート>/<ファイル名>`（DEF-007）。
 * `retryAttempt` が正の安全な整数でも `null` でもない場合は、`RangeError` を投げる。
 */
export function screenshotRelativePath(
  pageId: PageId,
  viewport: ViewportProfile,
  captureType: ScreenshotCaptureType,
  retryAttempt: number | null,
): string {
  if (retryAttempt !== null && !isPositiveSafeInteger(retryAttempt)) {
    throw new RangeError(`retry attempt must be a positive safe integer: ${String(retryAttempt)}`);
  }
  const retryDirectory = retryAttempt === null ? [] : [`${RETRY_ARTIFACT_DIRECTORY_PREFIX}${retryAttempt}`];
  return [PAGES_ARTIFACT_DIRECTORY, pageId, ...retryDirectory, viewport, SCREENSHOT_FILE_NAMES[captureType]].join('/');
}

/**
 * `createRunArtifactDirectory` の結果。
 * - `ok` が真: Run のディレクトリを、この呼び出しで新しく作った。
 * - `ok` が偽: 作れなかった。`alreadyExists` は、Run のディレクトリ（同じ名前のもの）がすでにあった（`EEXIST`）場合だけ真。
 *   出力先を作れなかった場合などは偽。`error` は、失敗した `mkdir` が投げた値そのもの。
 */
export type RunArtifactDirectoryCreation =
  | { readonly ok: true; readonly runDirectory: string }
  | { readonly ok: false; readonly runDirectory: string; readonly alreadyExists: boolean; readonly error: unknown };

/**
 * Run のディレクトリ（`runArtifactDirectory(outputDirectory, runId)`）を、排他的に作る（DEF-009。Task 18 の前の整理の設計書 第6章）。
 * Run Coordinator が、Run の開始の時点（PREFLIGHT の前）で呼ぶ。同じ `runId` の2つの Run が、同じディレクトリに書かないためである。
 * - 親のディレクトリ（出力先）は、`recursive` で作る（すでにあってよい）。
 * - Run のディレクトリそのものは、`recursive` なしで作る。すでにあれば（ディレクトリでもファイルでも）失敗にする。
 * - 失敗は、例外にせず、結果（`ok` が偽）で返す。何を消すことも、書き換えることもしない。
 * 例外を投げる（reject する）のは、`runId` がパスの区切り1つとして安全でない場合（`RangeError`）だけで、そのときは何も作らない。
 */
export async function createRunArtifactDirectory(outputDirectory: string, runId: RunId): Promise<RunArtifactDirectoryCreation> {
  if (!isPortableArtifactPathSegment(runId)) {
    throw new RangeError(`run ID is not a portable path segment: ${JSON.stringify(runId)}`);
  }
  const runDirectory = runArtifactDirectory(outputDirectory, runId);
  try {
    await mkdir(outputDirectory, { recursive: true });
  } catch (error) {
    return Object.freeze({ ok: false, runDirectory, alreadyExists: false, error });
  }
  try {
    await mkdir(runDirectory);
  } catch (error) {
    return Object.freeze({ ok: false, runDirectory, alreadyExists: isRecord(error) && error.code === 'EEXIST', error });
  }
  return Object.freeze({ ok: true, runDirectory });
}

/** `listRunDirectories` の1件（Run の ID と、Run のディレクトリ）。 */
export interface RunArtifactDirectoryEntry {
  readonly runId: RunId;
  readonly runDirectory: string;
}

/** `listCheckpointRunDirectories` の1件（Run の ID と、Run のディレクトリ）。 */
export type CheckpointRunDirectory = RunArtifactDirectoryEntry;

/** 出力先がない（出力先そのものか、途中の区切りがない、またはディレクトリでない）ことを表す、読み取りの失敗の `code`。 */
const MISSING_OUTPUT_DIRECTORY_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * 出力先（`outputDirectory`）の直下の、名前が Run の ID の形（`isRunId`、`isPortableArtifactPathSegment`）のディレクトリの一覧を、名前の順
 * （コード単位の順）に返す（中断した Run の再開の設計書 4.7.1 の「実行中の Run の確かめ」。読むだけ）。保存の有無は問わない。
 * - 出力先がない場合（途中の区切りがファイルの場合を含む）は、空の一覧を返す（作らない）。出力先を読めないほかの失敗は、その例外で reject する。
 * - リンク（symlink、junction）は、たどらない（ディレクトリとして数えない）。
 */
export async function listRunDirectories(outputDirectory: string): Promise<readonly RunArtifactDirectoryEntry[]> {
  let entries;
  try {
    entries = await readdir(outputDirectory, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && typeof error.code === 'string' && MISSING_OUTPUT_DIRECTORY_CODES.has(error.code)) {
      return Object.freeze([]);
    }
    throw error;
  }
  const runIds: RunId[] = [];
  for (const entry of entries) {
    const { name } = entry;
    if (entry.isDirectory() && isRunId(name) && isPortableArtifactPathSegment(name)) {
      runIds.push(name);
    }
  }
  return Object.freeze(runIds.sort(compareCodeUnits).map((runId) => Object.freeze({
    runId,
    runDirectory: runArtifactDirectory(outputDirectory, runId),
  })));
}

/** `path` が、ファイルとしてあるか（ないか、ファイルでないか、調べられない場合は偽）。 */
const isExistingFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

/**
 * 出力先（`outputDirectory`）の直下の Run のディレクトリ（`listRunDirectories` の一覧）のうち、`checkpoint/state.json` か
 * `checkpoint/state.prev.json` があるものの一覧を、名前の順（コード単位の順）に返す（中断した Run の再開の設計書 4.7。読むだけ）。
 * - 出力先がない場合は、空の一覧を返す（作らない）。出力先を読めないほかの失敗は、その例外で reject する。
 * - リンク（symlink、junction）は、たどらない（ディレクトリとして数えない）。名前とリンクの判定は、`listRunDirectories` の1か所で行う。
 * - 保存が使えるかどうか（JSON、スキーマ、整合）は確かめない。読んで確かめるのは `ArtifactWriter.readCheckpoint` である。
 */
export async function listCheckpointRunDirectories(outputDirectory: string): Promise<readonly CheckpointRunDirectory[]> {
  const listed: CheckpointRunDirectory[] = [];
  for (const run of await listRunDirectories(outputDirectory)) {
    const hasCheckpoint = await isExistingFile(artifactFilePath(run.runDirectory, checkpointArtifactRelativePath('state')))
      || await isExistingFile(artifactFilePath(run.runDirectory, checkpointArtifactRelativePath('previousState')));
    if (hasCheckpoint) {
      listed.push(run);
    }
  }
  return Object.freeze(listed);
}

/** Run のディレクトリからの相対パス（区切りは `/`）を、Run のディレクトリの下のファイルのパス（環境の区切り）にする。 */
export const artifactFilePath = (runDirectory: string, relativePath: string): string =>
  join(runDirectory, ...relativePath.split('/'));

/** URL のスキームか、Windows のドライブ（`C:`）で始まる文字列。 */
const SCHEME_OR_DRIVE_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
/** 制御文字（Unicode の一般カテゴリ Cc。C0、DEL、C1。NUL を含む）。 */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * Run のディレクトリからの相対パス（区切りは `/`）として安全か（CC-027。検証の唯一の owner）。
 * 区切りは `/` で、空・`.`・`..` の区切りがなく（先頭と末尾の `/` も認めない）、絶対パス・ドライブ・URL のスキーム・
 * バックスラッシュ・制御文字（Cc のすべて）を含まないとき、真を返す。日本語などの文字は、そのまま認める。
 * 文字列でない値は、偽を返す。不正な場合に、どの例外を投げるかは、呼び出す側が決める。
 */
export function isPortableRelativeArtifactPath(path: unknown): path is string {
  return (
    typeof path === 'string'
    && path.length > 0
    && !path.includes('\\')
    && !CONTROL_CHARACTER.test(path)
    && !posix.isAbsolute(path)
    && !win32.isAbsolute(path)
    && !SCHEME_OR_DRIVE_PREFIX.test(path)
    && path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  );
}

/**
 * Run のディレクトリからの相対パスの、区切り1つとして安全か（`runId`、`pageId` など。CC-027）。
 * `isPortableRelativeArtifactPath` の規則に合い、`/` を含まないとき、真を返す。
 */
export const isPortableArtifactPathSegment = (segment: unknown): segment is string =>
  isPortableRelativeArtifactPath(segment) && !segment.includes('/');
