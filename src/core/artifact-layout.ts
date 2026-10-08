/**
 * artifact の配置（ディレクトリとファイルの名前、パスの組み立て）の唯一の owner（Task 14〜17 の設計書 6.1.2、6.1.8。CC-023）。
 * - Page Auditor（スクリーンショット）、Run Coordinator（Run のディレクトリ）、`ArtifactWriter`（書き出し）、表示用モデル（Evidence と
 *   ファイルの対応）は、どれもここから取る。ほかの場所で、配置の名前やパスを組み立てない。
 * - Run のディレクトリからの相対パスは、区切りを `/` にする（artifact の中に書く値。環境によらない）。
 *   ファイルのパス（`runArtifactDirectory`、`artifactFilePath`）は、実行している環境の区切りにする（`node:path` の `join`）。
 * - 配置:
 *   - `<出力先>/<runId>/`: `run.json`、`audit.json`、`report.html`、`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`（ChatGPT 用バンドル。
 *     日時は、その Run の最後の実行の終わりの時刻。UTC。Run の ID と同じ書式。名前は `bundleFileName` で作り、`isBundleFileName` で
 *     見分ける。ChatGPT 用バンドルのファイル名の設計書 2.1）
 *   - `pages/<pageId>/`: `page.json`、`visible-text.txt`
 *   - `pages/<pageId>/<ビューポート>/`: `viewport.png`、`full-page.png`（Page Auditor が撮る。Task 14 の設計 4.5.5）
 *   - 再試行の前の試行のスクリーンショット: `pages/<pageId>/retry-<n>/<ビューポート>/`（DEF-007）
 * - Run のディレクトリからの相対パスが安全かどうかの検証（`isPortableRelativeArtifactPath`、`isPortableArtifactPathSegment`）も、
 *   ここだけで行う（CC-027）。スクリーンショットの収集、`ArtifactWriter`、ChatGPT 用バンドルは、どれもここを使う。
 * - 中断した Run の再開のための保存（チェックポイント）とロックの配置（中断した Run の再開の設計書 4.1、4.4）:
 *   - `checkpoint/`: `state.json`、`state.prev.json`、`run.lock`
 *   - `checkpoint/pages/<pageId>.json`: ページの保存
 *   保存のファイルを読み書きし、消すのは `ArtifactWriter` である。ここは、名前とパスだけを持つ。
 * - サイトの不調で止めたときの診断の記録の配置（サイトの不調で止めたときの診断の記録の設計書 2.3）:
 *   - `diagnostics/site-unavailable-<pageId>-<実行の番号>-<試行の番号>.json`: そのページのその試行の監査の結果と、ページ本体の要求の観察の
 *     結果（試行の番号は、捨てた後に段階的に最大 4 回確かめ直す決まり（サイトが応答しないときに Run を止める設計書 3.5.2、3.6.2）による。1 回目が 1、確かめ直しが 2〜5）
 *   `checkpoint/` の外に置く（Run の終わりの片付けで消さない）。書くのは `ArtifactWriter` である。
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
import { formatCompactUtcTimestamp, isCompactUtcTimestamp } from './utc-timestamp.js';

/**
 * Run のディレクトリの直下のファイルの名前（ChatGPT 用バンドルを除く。バンドルの名前は日時を含むので、`bundleFileName` で作る）。
 */
export const RUN_ARTIFACT_FILE_NAMES = Object.freeze({
  run: 'run.json',
  audit: 'audit.json',
  report: 'report.html',
} as const);

/** ChatGPT 用バンドルのファイル名の部品（`<語幹><区切り><YYYYMMDDHHmmss><拡張子>`。ChatGPT 用バンドルのファイル名の設計書 2.1）。 */
const BUNDLE_FILE_NAME_STEM = 'beaksight-audit-bundle';
const BUNDLE_FILE_NAME_TIME_SEPARATOR = '_';
const BUNDLE_FILE_NAME_EXTENSION = '.zip';
/** 新しい形のバンドルの名前の、日時の前の部分（`beaksight-audit-bundle_`）。 */
const BUNDLE_FILE_NAME_PREFIX = `${BUNDLE_FILE_NAME_STEM}${BUNDLE_FILE_NAME_TIME_SEPARATOR}`;
/** `bundleFileName` の誤りの文で、時刻の名前として示す語。 */
const BUNDLE_TIME_SUBJECT = 'end time of the last execution for the bundle name';

/**
 * 前の形の ChatGPT 用バンドルの名前（`beaksight-audit-bundle.zip`。日時を含まない）。今は書かない。前の版が書いたものを、
 * `ArtifactWriter.writePresentation` が片付けるときに見分けるため（`isBundleFileName`）に残す。
 */
export const LEGACY_BUNDLE_FILE_NAME = `${BUNDLE_FILE_NAME_STEM}${BUNDLE_FILE_NAME_EXTENSION}`;

/**
 * ChatGPT 用バンドルのファイル名（`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`。ChatGPT 用バンドルのファイル名の設計書 2.1）。名前を作るのは、
 * ここだけである。`finishedAt` は、その Run の最後の実行の終わりの時刻（`RunSummary.executions` の最後の `finishedAt`。ISO 8601）。
 * 日時は UTC で、Run の ID と同じ書式（`formatCompactUtcTimestamp`）にする。同じ Run の結果からは、同じ名前になる（書き出しの時刻は
 * 使わない）。文字列でない値、時刻として読めない文字列、UTC の年が4桁でない時刻は、`RangeError` を投げる。
 */
export function bundleFileName(finishedAt: string): string {
  const given: unknown = finishedAt;
  if (typeof given !== 'string') {
    throw new RangeError(`${BUNDLE_TIME_SUBJECT} must be an ISO 8601 string`);
  }
  return `${BUNDLE_FILE_NAME_PREFIX}${formatCompactUtcTimestamp(new Date(given), BUNDLE_TIME_SUBJECT)}${BUNDLE_FILE_NAME_EXTENSION}`;
}

/**
 * ChatGPT 用バンドルの名前か。新しい形（`beaksight-audit-bundle_` と、ASCII の数字14桁と、`.zip`）と、前の形（`LEGACY_BUNDLE_FILE_NAME`）の
 * 両方を真にする。似た名前（拡張子の違い、桁の違い、前後に文字があるもの、大文字と小文字の違い）は偽にする。
 * `ArtifactWriter.writePresentation` が、Run のディレクトリの直下の古いバンドルを見分けるために使う。
 */
export function isBundleFileName(name: string): boolean {
  if (name === LEGACY_BUNDLE_FILE_NAME) {
    return true;
  }
  if (!name.startsWith(BUNDLE_FILE_NAME_PREFIX) || !name.endsWith(BUNDLE_FILE_NAME_EXTENSION)) {
    return false;
  }
  return isCompactUtcTimestamp(name.slice(BUNDLE_FILE_NAME_PREFIX.length, name.length - BUNDLE_FILE_NAME_EXTENSION.length));
}

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

/**
 * サイトの不調で止めたときの診断の記録を置く、Run のディレクトリの直下のディレクトリの名前（サイトの不調で止めたときの診断の記録の
 * 設計書 2.3）。`checkpoint/` の外なので、Run の終わりの片付け（`checkpoint/` の中だけを消す）で消えない。
 */
export const DIAGNOSTICS_ARTIFACT_DIRECTORY = 'diagnostics';

/**
 * 診断の記録のファイルの名前の接頭辞（`<接頭辞><pageId><区切り><実行の番号><区切り><試行の番号><接尾辞>`。
 * `site-unavailable-<pageId>-<実行の番号>-<試行の番号>.json`）。
 */
const SITE_UNAVAILABLE_DIAGNOSTIC_FILE_PREFIX = 'site-unavailable-';
/** 診断の記録のファイルの名前の、ページの ID と実行の番号と試行の番号の区切り。 */
const SITE_UNAVAILABLE_DIAGNOSTIC_FILE_SEPARATOR = '-';
/** 診断の記録のファイルの名前の接尾辞。 */
const SITE_UNAVAILABLE_DIAGNOSTIC_FILE_SUFFIX = '.json';

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
 * サイトの不調で止めたときの診断の記録の、Run のディレクトリからの相対パス（区切りは `/`。例:
 * `diagnostics/site-unavailable-PAGE-000003-1-1.json`。サイトの不調で止めたときの診断の記録の設計書 2.3）。`executionNumber` は、その記録を
 * 書いた実行の番号（1から。再開した実行は、前の回の実行の数 + 1）。`attemptNumber` は、その実行の中でそのページを監査した試行の番号
 * （1から。捨てた後の確かめ直しの試行は 2〜5。サイトが応答しないときに Run を止める設計書 3.5.2、3.6.2）。ページと実行と試行ごとに1つで、
 * 同じページが別の実行や試行でまた止まっても、前の記録を置き換えない。
 * `executionNumber` か `attemptNumber` が正の安全な整数でない場合は、`RangeError` を投げる。
 */
export function siteUnavailableDiagnosticRelativePath(pageId: PageId, executionNumber: number, attemptNumber: number): string {
  if (!isPositiveSafeInteger(executionNumber)) {
    throw new RangeError(`execution number must be a positive safe integer: ${String(executionNumber)}`);
  }
  if (!isPositiveSafeInteger(attemptNumber)) {
    throw new RangeError(`attempt number must be a positive safe integer: ${String(attemptNumber)}`);
  }
  const fileName = [SITE_UNAVAILABLE_DIAGNOSTIC_FILE_PREFIX + pageId, executionNumber, attemptNumber]
    .join(SITE_UNAVAILABLE_DIAGNOSTIC_FILE_SEPARATOR) + SITE_UNAVAILABLE_DIAGNOSTIC_FILE_SUFFIX;
  return `${DIAGNOSTICS_ARTIFACT_DIRECTORY}/${fileName}`;
}

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
