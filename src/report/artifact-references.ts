/**
 * AUD-1（設計書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-1a・1c）: ページの成果物のファイル（`pages/<pageId>/…`）への参照の一覧の
 * 唯一の owner。
 * - 参照の一覧（`buildArtifactReferences`）は、表示用モデルが 1 回だけ作る（`ReportViewModel.artifactReferences`）。HTML とバンドルは、これを使い、作り直さない。
 *   持つものは、パス・種類・撮り方・証拠 ID・ページ・ビューポート・試行・関係する Finding・欠けたか。
 * - 参照のパスの見分け（`isPageArtifactReferencePath`）は、配置の owner（`src/core/artifact-layout.ts`）の名前の形だけを認める（サイトのリンクの
 *   `pages/about.html` などを参照と取り違えないため）。JSON の中の参照を集めるのは `pageArtifactReferencePathsIn` の 1 か所（バンドルの作る時点の確かめが使う）。
 * - 発表の前の確かめ（`missingArtifactReferencePaths`）は、参照先を `ReadArtifactFile` で 1 回ずつ読み、ないものを返す（AUD-1c）。
 */
import {
  BEFORE_HIDE_SCREENSHOT_DIRECTORY,
  FOCUS_CHECK_SCREENSHOT_DIRECTORY_PREFIX,
  PAGES_ARTIFACT_DIRECTORY,
  PAGE_ARTIFACT_FILE_NAMES,
  RECHECK_SCREENSHOT_DIRECTORY,
  RETRY_ARTIFACT_DIRECTORY_PREFIX,
  REVEAL_SCREENSHOT_DIRECTORY_PREFIX,
  SCREENSHOT_FILE_NAMES,
  STRESS_WIDTH_SCREENSHOT_DIRECTORY_PREFIX,
  pageArtifactRelativePath,
  revisitIndexOfScreenshotPath,
} from '../core/artifact-layout.js';
import {
  VIEWPORT_PROFILES,
  type EvidenceId,
  type FindingId,
  type PageAuditResult,
  type PageId,
  type RunSummary,
  type ViewportProfile,
} from '../core/contracts.js';
import type { ScreenshotCaptureType } from '../core/evidence-types.js';
import { isPositiveSafeInteger } from '../core/guards.js';
import { isPageId } from '../core/ids.js';
import { earlierAttemptEvidenceIds, retryRecordsOf, visibleTextSourceOf } from './artifact-writer.js';

/**
 * 書き出し済みのファイルを、Run のディレクトリからの相対パス（区切りは `/`）で読む関数。ファイルがなければ `null` を返す。
 * CLI が、`artifactFilePath(runDirectory, relativePath)` と `readFile` で作って渡す（`src/cli/audit-run.ts` の `artifactFileReader`）。
 */
export type ReadArtifactFile = (relativePath: string) => Promise<Uint8Array | null>;

/**
 * MEM-1（DEF-266）: 書き出し済みのファイルが、Run のディレクトリからの相対パス（区切りは `/`）にあるかを、読まずに確かめる関数（なければ偽）。
 * CLI が、`artifactFilePath(runDirectory, relativePath)` と `stat` で作って渡す（`src/cli/audit-run.ts` の `artifactFileExistence`）。
 */
export type ArtifactFileExists = (relativePath: string) => Promise<boolean>;

/** MEM-2（DEF-266）: 測った書き出し済みのファイル（バイト数と、`createSha256FingerprintOfBytes` の形の sha256）。 */
export interface MeasuredArtifactFile {
  readonly byteLength: number;
  readonly sha256: string;
}

/**
 * MEM-2（DEF-266）: ChatGPT 用バンドルを部ごとに作るときの、書き出し済みのファイルの読み方（Run のディレクトリからの相対パス。区切りは `/`）。
 * - `measure`: 中身を持ち続けずに（少しずつ読んで）大きさと sha256 を測る。ないファイルは `null`（「ない」の決まりは `ArtifactFileExists` と同じ）。
 * - `read`: 中身をまるごと読む（ないファイルは `null`）。その部を作るときに、その部のファイルだけを読む。
 * CLI が `src/cli/audit-run.ts` の `artifactBundleFiles` で作って渡す。
 */
export interface BundleArtifactFiles {
  readonly measure: (relativePath: string) => Promise<MeasuredArtifactFile | null>;
  readonly read: ReadArtifactFile;
}

/** `measure` で測る（戻り値の形を確かめる。ないファイルは `null`）。形が違えば `TypeError`。 */
export async function measureArtifactFileOrNull(files: BundleArtifactFiles, relativePath: string): Promise<MeasuredArtifactFile | null> {
  const measured: unknown = await files.measure(relativePath);
  if (measured === null) {
    return null;
  }
  const { byteLength, sha256 } = (measured ?? {}) as Partial<MeasuredArtifactFile>;
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0 || typeof sha256 !== 'string') {
    throw new TypeError(`measure must return the size and the digest of the file, or null: ${relativePath}`);
  }
  return { byteLength, sha256 };
}

/** 参照の種類（ページの記録 `page.json`、見える文字 `visible-text.txt`、スクリーンショット）。 */
export const ARTIFACT_REFERENCE_KINDS = Object.freeze(['PAGE_JSON', 'VISIBLE_TEXT', 'SCREENSHOT'] as const);
export type ArtifactReferenceKind = (typeof ARTIFACT_REFERENCE_KINDS)[number];

/** ページの成果物のファイルへの参照の 1 件（パスごとに 1 件）。 */
export interface ArtifactReferenceView {
  /** Run のディレクトリからの相対パス（ZIP の中のパスと同じ）。 */
  readonly path: string;
  readonly kind: ArtifactReferenceKind;
  /** スクリーンショットの撮り方。ほかの種類は `null`。 */
  readonly captureType: ScreenshotCaptureType | null;
  /** このファイルの元の Evidence の ID（`page.json` は空。見える文字は元の DOM の Evidence。スクリーンショットはその Evidence）。 */
  readonly evidenceIds: readonly EvidenceId[];
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  /** 再試行の前の試行のものなら、その試行の番号。最終の試行のもの（と `page.json`）は `null`。 */
  readonly retryAttempt: number | null;
  /** このファイルに関係づく Finding の ID（スクリーンショットだけ。`ScreenshotView.relatedFindingIds` と同じ）。 */
  readonly relatedFindingIds: readonly FindingId[];
  /** 発表の前の確かめで、ファイルがなかったか（確かめていない表示用モデルでは、すべて偽）。 */
  readonly missing: boolean;
}

/** スクリーンショットのファイルの名前から撮り方（`SCREENSHOT_FILE_NAMES` の逆引き）。 */
const CAPTURE_TYPE_BY_FILE_NAME: ReadonlyMap<string, ScreenshotCaptureType> = new Map(
  (Object.entries(SCREENSHOT_FILE_NAMES) as [ScreenshotCaptureType, string][]).map(([captureType, name]) => [name, captureType]),
);
const PAGE_FILE_NAMES: ReadonlySet<string> = new Set(Object.values(PAGE_ARTIFACT_FILE_NAMES));
const VIEWPORT_NAMES: ReadonlySet<string> = new Set(VIEWPORT_PROFILES);

/** `retry-<正の整数>` のディレクトリの名前か。 */
const isRetryDirectoryName = (name: string): boolean => {
  if (!name.startsWith(RETRY_ARTIFACT_DIRECTORY_PREFIX)) {
    return false;
  }
  const digits = name.slice(RETRY_ARTIFACT_DIRECTORY_PREFIX.length);
  return /^[1-9][0-9]*$/u.test(digits) && isPositiveSafeInteger(Number(digits));
};

/** AUD-3d: `stress-<正の整数>` のディレクトリの名前か（幅の走査の幅の viewport の画像）。 */
const isStressWidthDirectoryName = (name: string): boolean => {
  if (!name.startsWith(STRESS_WIDTH_SCREENSHOT_DIRECTORY_PREFIX)) {
    return false;
  }
  const digits = name.slice(STRESS_WIDTH_SCREENSHOT_DIRECTORY_PREFIX.length);
  return /^[1-9][0-9]*$/u.test(digits) && isPositiveSafeInteger(Number(digits));
};

/**
 * ページの成果物のファイルのパスか（`pages/<pageId>/page.json`、`pages/<pageId>/visible-text.txt`、`pages/<pageId>/[retry-<n>/]<viewport>/<viewport.png|full-page.png>`、
 * AUD-3d: 幅の走査の幅の画像 `pages/<pageId>/[retry-<n>/]<viewport>/stress-<幅>/viewport.png`、確かめ直しの段の画像 `…/<viewport>/recheck/viewport.png`。
 * EV-5: 読み直したページの画像は、`pages/<pageId>/revisit-<n>/` の下に同じ並び）。
 * 配置の owner の名前の形だけを認める。
 */
export function isPageArtifactReferencePath(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const [directory, pageId, ...rest] = value.split('/');
  if (directory !== PAGES_ARTIFACT_DIRECTORY || !isPageId(pageId)) {
    return false;
  }
  if (rest.length === 1) {
    return PAGE_FILE_NAMES.has(rest[0] ?? '');
  }
  // EV-5: 読み直したページの画像（`revisit-<n>/` の下。その下はふだんと同じ並び）。
  const afterRevisit = rest.length >= 3 && revisitIndexOfScreenshotPath(value) !== null ? rest.slice(1) : rest;
  const afterRetry = afterRevisit.length >= 3 && isRetryDirectoryName(afterRevisit[0] ?? '') ? afterRevisit.slice(1) : afterRevisit;
  const [viewport, ...afterViewport] = afterRetry;
  if (!VIEWPORT_NAMES.has(viewport ?? '')) {
    return false;
  }
  if (afterViewport.length === 1) {
    return CAPTURE_TYPE_BY_FILE_NAME.has(afterViewport[0] ?? '');
  }
  // AUD-3d・4d: viewport の画像だけの段の印（`stress-<幅>` の後に、`recheck` か `focus-<番号>` が続いてよい）。
  const fileName = afterViewport.at(-1);
  const stages = afterViewport.slice(0, -1);
  const afterStress = stages.length > 0 && isStressWidthDirectoryName(stages[0] ?? '') ? stages.slice(1) : stages;
  const stageOk = afterStress.length === 0
    ? stages.length === 1
    : afterStress.length === 1 && (afterStress[0] === RECHECK_SCREENSHOT_DIRECTORY
      || afterStress[0] === BEFORE_HIDE_SCREENSHOT_DIRECTORY
      || isNumberedDirectoryName(afterStress[0] ?? '', FOCUS_CHECK_SCREENSHOT_DIRECTORY_PREFIX)
      || isNumberedDirectoryName(afterStress[0] ?? '', REVEAL_SCREENSHOT_DIRECTORY_PREFIX));
  return fileName === SCREENSHOT_FILE_NAMES.VIEWPORT && stageOk;
}

/** AUD-4d・EV-2: `<接頭辞><正の整数>` のディレクトリの名前か（フォーカスを当てたままの画像 `focus-`、対象まで動かして撮った画像 `reveal-`）。 */
const isNumberedDirectoryName = (name: string, prefix: string): boolean => {
  if (!name.startsWith(prefix)) {
    return false;
  }
  const digits = name.slice(prefix.length);
  return /^[1-9][0-9]*$/u.test(digits) && isPositiveSafeInteger(Number(digits));
};

/** JSON の値の中の、ページの成果物のファイルへの参照（重複なし、現れた順）。キーは見ず、文字列の値だけを見る。 */
export function pageArtifactReferencePathsIn(value: unknown): readonly string[] {
  const found = new Set<string>();
  const visit = (current: unknown): void => {
    if (isPageArtifactReferencePath(current)) {
      found.add(current);
    } else if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
    } else if (current !== null && typeof current === 'object') {
      for (const item of Object.values(current)) {
        visit(item);
      }
    }
  };
  visit(value);
  return [...found];
}

/** 関係する Finding と欠けを付ける前の参照（MEM-4: 表示用モデルが、ページを 1 つずつ足すときに作る）。 */
export type ArtifactReferenceDraft = Omit<ArtifactReferenceView, 'missing' | 'relatedFindingIds'>;

/** 1 つのページの参照（`page.json`、見える文字、スクリーンショット（`page.json` の中の順））。 */
export function artifactReferenceDraftsOfPage(run: Pick<RunSummary, 'retries'>, page: PageAuditResult): readonly ArtifactReferenceDraft[] {
  const drafts: ArtifactReferenceDraft[] = [{
    path: pageArtifactRelativePath(page.pageId, 'page'),
    kind: 'PAGE_JSON',
    captureType: null,
    evidenceIds: [],
    pageId: page.pageId,
    viewport: null,
    retryAttempt: null,
  }];
  const visibleText = visibleTextSourceOf(run, page);
  if (visibleText !== null) {
    drafts.push({
      path: pageArtifactRelativePath(page.pageId, 'visibleText'),
      kind: 'VISIBLE_TEXT',
      captureType: null,
      evidenceIds: [visibleText.evidenceId],
      pageId: page.pageId,
      viewport: visibleText.viewport,
      retryAttempt: null,
    });
  }
  const earlier = earlierAttemptEvidenceIds(run, page);
  const attemptOf = new Map<EvidenceId, number>();
  for (const retry of retryRecordsOf(run, page)) {
    for (const evidenceId of retry.evidenceIds) {
      attemptOf.set(evidenceId, retry.attempt);
    }
  }
  for (const record of page.evidence) {
    if (record.type !== 'screenshot') {
      continue;
    }
    drafts.push({
      path: record.payload.relativePath,
      kind: 'SCREENSHOT',
      captureType: record.payload.captureType,
      evidenceIds: [record.evidenceId],
      pageId: record.payload.pageId,
      viewport: record.payload.viewport,
      retryAttempt: earlier.has(record.evidenceId) ? (attemptOf.get(record.evidenceId) ?? null) : null,
    });
  }
  return drafts;
}

/**
 * Run の参照の一覧を作る（ページの順の、各ページの参照（`artifactReferenceDraftsOfPage`）から）。同じパスが 2 か所にある（不正な Run）場合は 1 件にまとめ、
 * 証拠 ID と関係する Finding を足す。
 * - `screenshotFindingIds` は、スクリーンショットの Evidence に関係づく Finding（表示用モデルの `relateScreenshotsToFindings` の結果）。
 * - `missingPaths` は、発表の前の確かめでなかったパス。参照にないパスがあれば、`RangeError` を投げる。
 */
export function buildArtifactReferences(
  drafts: readonly ArtifactReferenceDraft[],
  screenshotFindingIds: (evidenceId: EvidenceId) => readonly FindingId[],
  missingPaths: ReadonlySet<string>,
): readonly ArtifactReferenceView[] {
  const byPath = new Map<string, ArtifactReferenceView>();
  for (const draft of drafts) {
    const relatedFindingIds = draft.kind === 'SCREENSHOT' ? draft.evidenceIds.flatMap((evidenceId) => [...screenshotFindingIds(evidenceId)]) : [];
    const known = byPath.get(draft.path);
    byPath.set(
      draft.path,
      known === undefined
        ? { ...draft, relatedFindingIds, missing: missingPaths.has(draft.path) }
        : {
            ...known,
            evidenceIds: [...new Set([...known.evidenceIds, ...draft.evidenceIds])],
            relatedFindingIds: [...new Set([...known.relatedFindingIds, ...relatedFindingIds])],
          },
    );
  }
  for (const path of missingPaths) {
    if (!byPath.has(path)) {
      throw new RangeError(`a missing artifact path is not one of the references: ${JSON.stringify(path)}`);
    }
  }
  return [...byPath.values()];
}

/**
 * AUD-1c: 発表の前に、参照先のファイルがあるかを確かめる。参照の順に 1 回ずつ、読まずに確かめ（MEM-1: `artifactFileExists`）、なかったパスを返す
 * （参照の順）。例外は、そのまま伝える。`artifactFileExists` が真偽以外を返したら、`TypeError` を投げる。
 */
export async function missingArtifactReferencePaths(
  references: readonly Pick<ArtifactReferenceView, 'path'>[],
  artifactFileExists: ArtifactFileExists,
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const path of new Set(references.map((reference) => reference.path))) {
    const exists: unknown = await artifactFileExists(path);
    if (typeof exists !== 'boolean') {
      throw new TypeError(`artifactFileExists must return a boolean: ${path}`);
    }
    if (!exists) {
      missing.push(path);
    }
  }
  return missing;
}

/** `readArtifactFile` で読む（戻り値の型を確かめる。バンドルと発表の前の確かめの共通の読み方）。 */
export async function readArtifactFileOrNull(readArtifactFile: ReadArtifactFile, relativePath: string): Promise<Uint8Array | null> {
  const bytes: unknown = await readArtifactFile(relativePath);
  if (bytes !== null && !(bytes instanceof Uint8Array)) {
    throw new TypeError(`readArtifactFile must return a Uint8Array or null: ${relativePath}`);
  }
  return bytes;
}
