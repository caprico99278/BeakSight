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
 * - Run のディレクトリを排他的に作る処理（`createRunArtifactDirectory`。DEF-009）も、ここに置く。このファイルで入出力を行うのは、
 *   これだけである。
 */
import { mkdir } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import type { PageId, RunId, ViewportProfile } from './contracts.js';
import type { ScreenshotCaptureType } from './evidence-types.js';
import { isPositiveSafeInteger, isRecord } from './guards.js';

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

/** Run の artifact を置くディレクトリ（`<出力先の根>/<runId>`。区切りは実行している環境のもの）。 */
export function runArtifactDirectory(outputDirectory: string, runId: RunId): string {
  return join(outputDirectory, runId);
}

/** ページのファイルの、Run のディレクトリからの相対パス（区切りは `/`。例: `pages/PAGE-000001/page.json`）。 */
export const pageArtifactRelativePath = (pageId: PageId, file: PageArtifactFile): string =>
  `${PAGES_ARTIFACT_DIRECTORY}/${pageId}/${PAGE_ARTIFACT_FILE_NAMES[file]}`;

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
