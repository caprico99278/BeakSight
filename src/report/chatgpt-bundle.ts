/**
 * ChatGPT 用バンドル（`beaksight-audit-bundle_…YYYYMMDDHHmmss.zip`。名前は `src/core/artifact-layout.ts` の `bundleFileName` で作る。PRE42-BN）の
 * 中身の唯一の owner（Task 14〜17 の設計書 6.1.2、6.1.8、6.1.9、6.1.11。上位の設計書 第19章）。
 * - 表示用モデル（`buildReportViewModel` の結果）から、ZIP のバイト列を作って返す。ファイルは書かない。書くのは
 *   `ArtifactWriter.writePresentation` だけである（ARCH08）。
 * - T44i（Task 44 の設計書 6 章の 2026-10-22 の行。この行が 6.1.9 の「ZIP に入れるもの」に優先する）: 読み方の案内（`README.md`。日本語の Markdown）を
 *   `manifest.json` の次に、Rule ごとの要約（`findings-by-rule.json`。表示用モデルの `ruleDigests` の写し）を `summary.json` の次に入れる。どちらも、
 *   表示用モデルの値を描くだけで、数え直さない。
 * - ZIP に入れるものと順（REC-4: 第 1 部は入口だけ）: `manifest.json`、`README.md`、`run.json`、`summary.json`、`findings-by-rule.json`、`finding-files.json`、
 *   `finding-groups.json`、`pages.json`、`links.json`、指摘のファイル（`pages/<pageId>/findings.json` をページの順、最後に `run-findings.json`）、
 *   各ページの `page.json`（パスの順。設計書 6.1.11）、各ページの `visible-text.txt`（パスの順）、スクリーンショット（パスの順）。
 * - AUD-1（設計書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-1a・1b）と AUD-1d（ユーザーの判断 2026-11-09「徹底的に端から端まで監査できなければ
 *   価値が無い」。AUD-1b の予算で外す決まりに優先する）: 表示用モデルの参照の一覧（`artifactReferences`）の全部を入れる。
 *   - 最終の試行の画像（見える範囲・ページ全体）、再試行の前の試行の画像、`visible-text.txt` を、大きさにかかわらず全部入れる（BeakSight の都合で外さない）。
 *   - 入れられないのは、ファイルがないもの（`ARTIFACT_FILE_NOT_FOUND`）だけ。`manifest.json` の `omittedFiles`（パス・証拠 ID・理由）に書き、作る処理は止めない。
 *   - 1 つの ZIP に入りきらないときは、部（第 1 部・第 2 部…。`createChatGptBundleParts`）に分ける。第 1 部に `manifest.json`・README・`run.json` とバンドルが
 *     組み立てる JSON を入れ、各ページの `page.json`、`visible-text.txt`、画像を、この順に、第 1 部の残りと第 2 部以降に詰める（設計者の判断 (a) 2026-11-09:
 *     第 1 部が `page.json` で大きくならないため）。1 つのファイルだけで目安を超えるものは、そのファイル 1 つで 1 部にする（分けて欠かさない）。
 *     `manifest.json` の `files` は、ファイルごとの部の番号を持つ（どのページの `page.json` がどの部にあるかも、ここで分かる）。
 *     各部の README の冒頭に「全 N 部のうち第 k 部」と書く。
 *   - ZIP の中の JSON の画像のパスは、部のどれかに入れたものだけにする。`page.json` は一次の証拠なので書き換えない。
 *   - 作る時点で、全部の部の JSON の `pages/…` の参照が「どれかの部にある」か「欠けの一覧にある」ことを確かめ、違えば作るのを失敗させる（fail-closed）。
 * - AUD-1c: 表示用モデルが発表の前の確かめ（`missingArtifactCount` が `null` でない）を持つなら、欠けた参照は読まずに `ARTIFACT_FILE_NOT_FOUND` にする。欠けの数は
 *   `manifest.json` の `missingArtifactCount` に書く。
 * - `run.json`、`page.json`、`visible-text.txt`、スクリーンショットは、書き出し済みのファイルを `readArtifactFile` で読み、そのまま入れる（組み立て
 *   直さない）。パスは、Run のディレクトリの中と同じにする。読めなかった（`null`）ものは入れず、`manifest.json` の `omittedFiles`
 *   に書く。Run Status は変えない（決めるのは `deriveRunStatus` だけで、バンドルの前に確定している）。
 * - `page.json` を入れるのは、指摘の `evidence` の `path` と `pointer` を、ZIP の中だけでたどれるようにするためである（REC-4: Evidence の索引は置かない）
 *   （上位の設計書 第19章「`evidenceRef` で一次証跡へ追跡可能にする」。設計書 6.1.11）。
 * - 部に詰める順（AUD-1b の順に、page.json を先に足した）: 各ページの `page.json`（パスの順）、`visible-text.txt`（パスの順）、`VIEWPORT` の指摘に関係するもの、`VIEWPORT` の最終の試行の残り、`FULL_PAGE` の指摘に
 *   関係するもの、`FULL_PAGE` の最終の試行の残り、再試行の前の試行の残り（それぞれパスの順）。1 つの部の大きさの目安は `CHATGPT_BUNDLE_PART_SIZE_BYTES`（中身の
 *   バイト数の和。目安を超える 1 つのファイルは、1 つの部に入れる）。各部の中の並びは、種類の順、パスの順。部の大きさの目安は `manifest.json` の `partSizeBytes`。
 * - JSON は、字下げなし（T44f）、末尾に LF、UTF-8 にする（書式は `artifactJsonBytes` だけで組み立てる。CC-026）。値は、英数字の
 *   コードのままにし、日本語のラベル（理由の説明など）は入れない。
 *   Finding は指摘のファイルの 1 か所に置き、`pages.json` と `finding-groups.json` には件数だけを置く（REC-4）。
 * - 生のレスポンス本文は、入れない。このファイルが組み立てる JSON は、表示用モデルだけから作る。
 *   `page.json` は、記録した Evidence（一次の証拠）として、読んだバイト列のまま入れる（設計書 6.1.11）。
 * - 決定論: ZIP の組み立て（各項目の時刻の固定）と目録の 1 件（バイト数と sha256）は、共通の部品 `src/core/deterministic-zip.ts`（T32f。T32R2 M-2 で `src/core/` に移した）で行う。同じ入力
 *   からは、同じバイト列を作る（移す前と同じバイト列であることを `chatgpt-bundle.test.ts` の sha256 で固定）。
 * - ZIP の中のパスは、区切りを `/` にし、`..` や絶対パスを含めない。`page.json` とスクリーンショットのパスは、
 *   `assertPagesEntryPath` の1か所で確かめ（相対パスの規則は `isPortableRelativeArtifactPath`。CC-027）、不正なら、どのファイルも
 *   読む前に `RangeError` を投げる。
 */
import { distinctSorted } from '../audit/rule-helpers.js';
import {
  PAGES_ARTIFACT_DIRECTORY,
  PAGE_ARTIFACT_FILE_NAMES,
  RUN_ARTIFACT_FILE_NAMES,
  isPortableRelativeArtifactPath,
} from '../core/artifact-layout.js';
import { artifactJsonBytes } from '../core/artifact-json.js';
import { BEAKSIGHT_BLOCK_RELATIONS } from '../core/beaksight-block-relation.js';
import {
  SEVERITIES,
  type AuditRunResult,
  type EvidenceId,
  type FindingCategory,
  type FindingId,
  type IncompleteReasonCode,
  type PageId,
  type RunId,
  type RunStatus,
} from '../core/contracts.js';
import { deterministicZipOf, zipFileRecordsOf, type ZipFileRecord } from '../core/deterministic-zip.js';
import type { ScreenshotCaptureType } from '../core/evidence-types.js';
import { isPositiveSafeInteger } from '../core/guards.js';
import { createSha256FingerprintOfBytes } from '../core/ids.js';
import { CHATGPT_BUNDLE_PART_SIZE_BYTES } from '../core/limits.js';
import {
  AUDIT_SEND_POLICY_CATALOG,
  BEAKSIGHT_BLOCK_RELATION_CATALOG,
  CHATGPT_BUNDLE_OMISSION_REASON_CATALOG,
  FINDING_CATEGORY_CATALOG,
  RUN_STATUS_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  SEVERITY_GROUPS,
  sortByDisplayOrder,
  type DisplaySpec,
} from '../presentation/catalog.js';
import { formatCount, formatInteger } from '../presentation/format.js';
import {
  AUDIT_SEND_TEXT,
  CHATGPT_BUNDLE_GUIDE_TEXT,
  HTML_REPORT_TEXT,
  PAGE_COVERAGE_ITEMS,
  RUN_SUMMARY_TEXT,
  cliCountText,
  cliFieldText,
  countWithDetailsText,
  labelWithCodeText,
  listText,
} from '../presentation/messages.js';
import {
  measureArtifactFileOrNull,
  pageArtifactReferencePathsIn,
  readArtifactFileOrNull,
  type ArtifactReferenceView,
  type BundleArtifactFiles,
  type MeasuredArtifactFile,
  type ReadArtifactFile,
} from './artifact-references.js';
import type { FindingImageRegionView } from '../core/finding-image-regions.js';
import type { FindingView, ReasonView, ReportViewModel, RuleDigestView, ScreenshotView } from './view-model.js';

export type { BundleArtifactFiles, ReadArtifactFile } from './artifact-references.js';

// ---------------------------------------------------------------------------------------------------------------
// 定数と型
// ---------------------------------------------------------------------------------------------------------------

/**
 * `manifest.json` の `bundleSchemaVersion`。T44i（Task 44 の設計書 6 章の 2026-10-22 の行）: `README.md` と `findings-by-rule.json` を足し、`summary.json` に
 * category の別・Rule の別の件数が入ったので、1.1 にした。BN-d（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.5）: `findings.json` を
 * 本体の Finding（BeakSight の遮断と結び付かないサイト品質）だけにし、外した Finding の `beaksight-related-findings.json` を足し、`summary.json`・
 * `findings-by-rule.json`・`pages.json` の件数と ID を本体の分と外した分に分けたので、1.2 にした。AUD-1: 見える範囲の画像の全部・`visible-text.txt`・予算の
 * 中のページ全体の画像を入れ、`omittedFiles` に証拠 ID と理由 2 つ（`FULL_PAGE_OVER_BUDGET`・`ATTEMPT_NOT_BUNDLED`）を足し、`manifest.json` に
 * `missingArtifactCount` を足し、ZIP の中の JSON の画像のパスを入れたものだけにしたので、1.3 にした。AUD-6a・6c・9c: 指摘の `verification`、`summary.json` の
 * `webVitalsCoverage`、候補群の `finding-groups.json`、`findings-by-rule.json` の `groupCount`・`groupIds` を足したので、1.4 にした。AUD-8: `summary.json` に
 * 色差の「測定できない」の数（`contrastUnmeasured`）と、README.md にその読み方を足したので、1.5 にした。AUD-2d: 指摘の `verification.recheck`、初めの表示だけの
 * 指摘の `initial-only-findings.json`、`findings-by-rule.json` の `initialOnly`、`pages.json` の `initialOnlyFindingIds`、`summary.json` の `recheck` を足したので、
 * 1.6 にした。AUD-3c: 固定の要素の重なりの指摘の `verification.overlap`（区分と、描画を決められたか）、`summary.json` の `fixedOverlapsNotCounted`（Finding に
 * しなかった区分の数）と、README.md にその読み方を足したので、1.7 にした。AUD-3d: 指摘の `imageRegion`（画像の参照と対象の領域の矩形）、幅の走査の幅の画像
 * （`pages/<pageId>/desktop/stress-<幅>/viewport.png`）と、README.md にその読み方を足したので、1.8 にした。AUD-3d の続き: 確かめ直しの段の画像
 * （`…/<viewport>/recheck/viewport.png`）、`imageRegion` の `regionUnavailableReason`（axe の要素の矩形がない理由）を足し、`layoutScrollPosition` を
 * `regionScrollPosition`（axe の矩形を読んだ位置も入る）にしたので、1.9 にした。AUD-4b・4c・4d: 指摘の `verification.labelInName`、`summary.json` の
 * `focusChecks`・`specialSchemeLinks`、フォーカスの確かめの画像（`…/focus-<番号>/viewport.png`）と、README.md にその読み方を足したので、1.10 にした。
 * AUD-7・6b・6c: 指摘の `verification.httpError`（4xx・5xx の区分と応答の事実）・`verification.nextStep`（検証できなかった指摘の次の手順）、`summary.json` の
 * `httpErrorsNotCounted`・`performanceObservations`、リンクごとの確かめの状態の `links.json` と、README.md にその読み方を足したので、1.11 にした。
 * COV-4 の区切り 3: `summary.json` の `openedStates`（操作で開いた状態の数と、開く前の画面と同じで除いた指摘の数）、開いた状態の画像
 * （`…/<viewport>/state-<番号>/viewport.png`）と、README.md にその読み方を足したので、1.12 にした。
 * 設計者の判断 2026-11-11: network の記録の `repeatedReads`（同じ口の成功した読み取りのくり返しをまとめた記録）を数える `summary.json` の `repeatedReads` と、
 * README.md にその読み方を足したので、1.13 にした。
 * SAFE-2 の 4: `run.json` の `safety` の、違反にしない止めた記録の数（`frameClassificationFailureCount`・`readNavigationFailureCount`）と外部スキームへの移動の
 * 試みの数（`externalSchemeNavigationCount`）の読み方を README.md に足したので、1.14 にした。
 * REC-4（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.3）: 第 1 部を入口だけにし、指摘の一覧（`findings.json`・`beaksight-related-findings.json`・
 * `initial-only-findings.json`）をページごとの指摘のファイル（`pages/<pageId>/findings.json` と、ページに属さない指摘の `run-findings.json`）とその場所の一覧
 * （`finding-files.json`）に分け、Evidence の索引（`evidence-index.json`）・`pages.json` の指摘の ID の一覧・`finding-groups.json` の `findingIds` を外し
 * （指摘ごとの `groupId` で引く）、README.md に page.json 2.0 の短い形の読み方を足したので、2.0 にした。前の版を読む口は作らない（作り直さない）。
 */
export const CHATGPT_BUNDLE_SCHEMA_VERSION = 'chatgpt-bundle/2.0';

/**
 * ZIP の中で、このファイルが作るファイルの名前（`run.json` は、Run のディレクトリと同じ `RUN_ARTIFACT_FILE_NAMES.run`）。T44i: 読み方の案内（`readme`。
 * Markdown）と、Rule ごとの要約（`findingsByRule`）を足した。BN-d: 外した Finding（`relatedFindings`）を足した。
 */
export const CHATGPT_BUNDLE_FILE_NAMES = Object.freeze({
  manifest: 'manifest.json',
  readme: 'README.md',
  summary: 'summary.json',
  findingsByRule: 'findings-by-rule.json',
  // REC-4: 指摘のファイルの場所の一覧（第 1 部）。
  findingFiles: 'finding-files.json',
  // AUD-9c: 同じ UI の繰り返しの候補群（表示用モデルの `findingGroups` から、指摘の ID の一覧を除いたもの）。
  findingGroups: 'finding-groups.json',
  pages: 'pages.json',
  // AUD-6b: リンクごとの確かめの状態（表示用モデルの `linkChecks` の写し）。
  links: 'links.json',
  // REC-4: ページごとの指摘のファイルの名前（`pages/<pageId>/` の下）と、ページに属さない指摘のファイル。
  pageFindings: 'findings.json',
  runFindings: 'run-findings.json',
} as const);

/**
 * `manifest.json` の `omittedFiles[].reason`（閉じた一覧。説明は表示カタログの `CHATGPT_BUNDLE_OMISSION_REASON_CATALOG`）。
 * - `ARTIFACT_FILE_NOT_FOUND`: ファイルがなかった（`readArtifactFile` が `null` を返した。発表の前の確かめでなかったものを含む。AUD-1c）。
 * AUD-1d: 大きさの上限で外す理由（`BUNDLE_SIZE_LIMIT`・`FULL_PAGE_OVER_BUDGET`）と、再試行の前の画像を外す理由（`ATTEMPT_NOT_BUNDLED`）は、使わないので除いた。
 */
export const CHATGPT_BUNDLE_OMISSION_REASONS = Object.freeze(['ARTIFACT_FILE_NOT_FOUND'] as const);
export type ChatGptBundleOmissionReason = (typeof CHATGPT_BUNDLE_OMISSION_REASONS)[number];

/** 表示カタログが、どの理由にも説明を持つこと（理由を足して説明を書き漏らすと、型のエラーになる）。読み方の案内は、これで理由を書く。 */
const OMISSION_REASON_DISPLAY: Readonly<Record<ChatGptBundleOmissionReason, DisplaySpec>> = CHATGPT_BUNDLE_OMISSION_REASON_CATALOG;

/** 入れなかったファイルの 1 件（`manifest.json` の `omittedFiles[]`）。`evidenceIds` は、そのファイルの元の Evidence（`run.json` と `page.json` は空）。 */
export interface ChatGptBundleOmittedFile {
  readonly path: string;
  readonly evidenceIds: readonly EvidenceId[];
  readonly reason: ChatGptBundleOmissionReason;
}

/** AUD-1d: `createChatGptBundleParts` の省略できる指定。 */
export interface ChatGptBundlePartsOptions {
  /**
   * 1 つの部の大きさの目安（バイト。中身のバイト数の和。1 以上の安全な整数）。既定は `CHATGPT_BUNDLE_PART_SIZE_BYTES`。テストで小さな値を注入するためにある。
   */
  readonly partSizeBytes?: number;
}

/** AUD-1d: バンドルの 1 つの部（ZIP のバイト列と、全 `partCount` 部のうちの番号 `partNumber`。1 から）。 */
export interface ChatGptBundlePart {
  readonly partNumber: number;
  readonly partCount: number;
  readonly bytes: Uint8Array;
}

/** `manifest.json` の `files` の 1 件（AUD-1d: 入っている部の番号を足した）。 */
export interface ChatGptBundleFileRecord extends ZipFileRecord {
  readonly part: number;
}

/** `manifest.json` の中身（第 1 部にだけ入る）。 */
export interface ChatGptBundleManifest {
  readonly bundleSchemaVersion: typeof CHATGPT_BUNDLE_SCHEMA_VERSION;
  readonly runId: RunId;
  readonly runStatus: RunStatus;
  readonly toolVersion: string;
  /** Run の `finishedAt`。 */
  readonly generatedAt: string | null;
  /** AUD-1d: 部の数と、1 つの部の大きさの目安（バイト。1 つの ZIP にまとめたときは `null`）。 */
  readonly partCount: number;
  readonly partSizeBytes: number | null;
  /** `manifest.json` を除く、全部の部のすべてのファイル（部の順、各部の ZIP の中の順。各部の `README.md` を含む）と、入っている部の番号。 */
  readonly files: readonly ChatGptBundleFileRecord[];
  /** ファイルがなかったもの（`run.json`、`page.json`、`visible-text.txt`、スクリーンショットの順。それぞれパスの順）。 */
  readonly omittedFiles: readonly ChatGptBundleOmittedFile[];
  /** AUD-1c: 発表の前の確かめで見つからなかったファイルの数（表示用モデルの `missingArtifactCount`。確かめていなければ `null`）。 */
  readonly missingArtifactCount: number | null;
}

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

/**
 * `summary.json`: 表示用モデルの `summary`（理由の説明を除く）。実行の記録からは、最後の実行の終わりの時刻（`lastFinishedAt`。CLI とバンドルの
 * 名前のための値。CCX-19）を除く（`items` に同じ値があり、`summary.json` の形を変えないため）。
 */
const summaryView = (model: ReportViewModel): object => {
  const { lastFinishedAt: _lastFinishedAt, ...executions } = model.summary.executions;
  return {
    ...model.summary,
    executions,
    incompleteReasons: reasonCodes(model.summary.incompleteReasons),
  };
};

/** ZIP に入れたファイルのパス（AUD-1a: ZIP の中の JSON の画像のパスは、これに入るものだけにする）。 */
type IncludedPaths = ReadonlySet<string>;

/** スクリーンショットのうち、ZIP に入れたもののパス（並びはそのまま）。 */
const includedScreenshotPaths = (screenshots: readonly ScreenshotView[], included: IncludedPaths): readonly string[] =>
  screenshots.map((screenshot) => screenshot.relativePath).filter((path) => included.has(path));

/** REC-4: 指摘の ID から、その指摘の入る候補群の ID（表示用モデルの `findingGroups` から引く。群に入らない指摘はない）。 */
type FindingGroupIds = ReadonlyMap<FindingId, string>;

/**
 * 1 つの Finding と、それが参照する Evidence の場所（どのページにもなければ `null`。`path` と `pointer` で ZIP の中の page.json をたどれる）と、関係する
 * スクリーンショットのパス（AUD-1a: ZIP に入れたものだけ）と、入る候補群の ID（REC-4）。
 */
const findingEntry = (
  { finding, evidence, screenshots, verification, imageRegion }: FindingView,
  included: IncludedPaths,
  groupIds: FindingGroupIds,
): object => ({
  finding,
  evidence: evidence.map(({ evidenceId, location }) => ({
    evidenceId,
    path: location === null ? null : location.path,
    pointer: location === null ? null : location.pointer,
  })),
  screenshotPaths: includedScreenshotPaths(screenshots, included),
  // AUD-6a: 検証の状態（表示用モデルの値の写し。数え直さない）。
  verification,
  // AUD-3d: 指摘の画像の参照と対象の領域の矩形（表示用モデルの値の写し）。画像のパスは、ZIP に入れたものだけ（入れなかった画像は `null`。欠けの一覧にある）。
  imageRegion: includedImageRegion(imageRegion, included),
  groupId: groupIds.get(finding.findingId) ?? null,
});

/** AUD-3d: 指摘の画像の参照の写し（画像のパスは ZIP に入れたものだけ。入れなかった画像は `null`）。 */
const includedImageRegion = (imageRegion: FindingImageRegionView | null, included: IncludedPaths): FindingImageRegionView | null =>
  (imageRegion === null
    ? null
    : { ...imageRegion, relativePath: imageRegion.relativePath !== null && included.has(imageRegion.relativePath) ? imageRegion.relativePath : null });

/** REC-4: 指摘のファイルの中の、3 つの一覧の名前（`findingFileView` の項目の名前と同じ）。 */
const FINDING_FILE_LISTS = Object.freeze({ main: 'main', excluded: 'excluded', initialOnly: 'initialOnly' } as const);

/** REC-4: 指摘のファイルの 1 つ（ページの ID。ページに属さない指摘は `null`）と、その場所と件数。 */
interface FindingFilePlan {
  readonly pageId: PageId | null;
  readonly path: string;
  readonly main: readonly FindingView[];
  readonly excluded: readonly FindingView[];
  readonly initialOnly: readonly FindingView[];
}

/**
 * REC-4: 指摘のファイルの並び（表示用モデルのページの順、ページに属さない指摘のファイルは最後。指摘のないページのファイルは作らない）。中の指摘は、
 * 表示用モデルの分け方のまま（BN-d: 本体 `mainFindings`、外した指摘 `excludedFindings`。AUD-2d: 初めの表示だけ `initialOnlyFindings`）。
 */
function findingFilePlansOf(model: ReportViewModel): readonly FindingFilePlan[] {
  const ofPage = (views: readonly FindingView[], pageId: PageId | null): readonly FindingView[] => views.filter((view) => view.finding.pageId === pageId);
  const plans = [...model.pages.map((page) => page.pageId), null].map((pageId): FindingFilePlan => ({
    pageId,
    path: pageId === null
      ? CHATGPT_BUNDLE_FILE_NAMES.runFindings
      : `${PAGES_ARTIFACT_DIRECTORY}/${pageId}/${CHATGPT_BUNDLE_FILE_NAMES.pageFindings}`,
    main: ofPage(model.mainFindings, pageId),
    excluded: ofPage(model.excludedFindings, pageId),
    initialOnly: ofPage(model.initialOnlyFindings, pageId),
  }));
  return plans.filter((plan) => plan.main.length + plan.excluded.length + plan.initialOnly.length > 0);
}

/**
 * REC-4: 1 つの指摘のファイルの中身。`main` は本体の Finding、`excluded` は外した Finding と BeakSight の遮断との関係（区分・理由・結び付いた遮断。SAFETY の
 * Finding は `null`）と止めた事象の時点の別の件数（BN-R0 の M-3）、`initialOnly` は初めの表示だけの指摘。
 */
const findingFileView = (plan: FindingFilePlan, included: IncludedPaths, groupIds: FindingGroupIds): object => ({
  pageId: plan.pageId,
  [FINDING_FILE_LISTS.main]: plan.main.map((view) => findingEntry(view, included, groupIds)),
  [FINDING_FILE_LISTS.excluded]: plan.excluded.map((view) => ({
    ...findingEntry(view, included, groupIds),
    beaksightBlockRelation: view.beaksightBlockRelation,
    safetyBlockPhaseCounts: view.safetyBlockPhaseCounts,
  })),
  [FINDING_FILE_LISTS.initialOnly]: plan.initialOnly.map((view) => findingEntry(view, included, groupIds)),
});

/** REC-4: `finding-files.json`: 指摘のファイルの場所と件数（ファイルの順。どの部にあるかは `manifest.json` の `files`）。 */
const findingFilesView = (plans: readonly FindingFilePlan[]): object =>
  plans.map(({ pageId, path, main, excluded, initialOnly }) => ({
    pageId,
    path,
    [FINDING_FILE_LISTS.main]: main.length,
    [FINDING_FILE_LISTS.excluded]: excluded.length,
    [FINDING_FILE_LISTS.initialOnly]: initialOnly.length,
  }));

/** REC-4: `finding-groups.json`: 候補群から、指摘の ID の一覧を除いたもの（指摘は、指摘ごとの `groupId` で群に結び付く）。 */
const findingGroupsView = (model: ReportViewModel): object => model.findingGroups.map(({ findingIds: _findingIds, ...group }) => group);

/** Rule ごとの要約の写し（例のスクリーンショットは、ZIP に入れたもののパスだけ。`findings.json` の `screenshotPaths` と同じ決まり）。 */
const ruleDigestEntries = (digests: readonly RuleDigestView[], included: IncludedPaths): object =>
  digests.map(({ examples, ...digest }) => ({
    ...digest,
    examples: examples.map(({ screenshots, ...example }) => ({
      ...example,
      screenshotPaths: includedScreenshotPaths(screenshots, included),
    })),
  }));

/**
 * T44i: `findings-by-rule.json`: 表示用モデルの Rule ごとの要約（値はコードのまま。数え直さない）。BN-d: 本体の Finding の要約（`main`。`mainRuleDigests`）と、
 * 外した Finding の要約（`excluded`。`excludedRuleDigests`）に分ける。
 */
const findingsByRuleView = (model: ReportViewModel, included: IncludedPaths): object => ({
  main: ruleDigestEntries(model.mainRuleDigests, included),
  excluded: ruleDigestEntries(model.excludedRuleDigests, included),
  // AUD-2d: 初めの表示だけの指摘の要約。
  initialOnly: ruleDigestEntries(model.initialOnlyRuleDigests, included),
});

// ---------------------------------------------------------------------------------------------------------------
// 読み方の案内（README.md。T44i）
// ---------------------------------------------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();

/** Markdown のコード（例: `` `summary.json` ``）。値は ID・コード・ファイルの名前で、バッククォートを含まない。 */
const markdownCode = (value: string): string => `\`${value}\``;

/** 表の列の寄せ方。 */
type MarkdownAlignment = 'left' | 'right';

/** 表の見出しの下の行の、列の寄せ方の印。 */
const MARKDOWN_ALIGNMENT_MARKERS: Readonly<Record<MarkdownAlignment, string>> = Object.freeze({ left: '---', right: '---:' });

/** Markdown の表の 1 行（セルの中の `|` は、表の区切りにならないよう、エスケープする）。 */
const markdownRow = (cells: readonly string[]): string => `| ${cells.map((cell) => cell.replaceAll('|', '\\|')).join(' | ')} |`;

/** Markdown の表（見出し、寄せ方、行）。 */
const markdownTable = (
  columns: readonly string[],
  alignments: readonly MarkdownAlignment[],
  rows: readonly (readonly string[])[],
): readonly string[] => [
  markdownRow(columns),
  `| ${alignments.map((alignment) => MARKDOWN_ALIGNMENT_MARKERS[alignment]).join(' | ')} |`,
  ...rows.map(markdownRow),
];


const categoryLabel = (category: FindingCategory): string => FINDING_CATEGORY_CATALOG[category].label;

/** Rule ごとの要約の、件数のある severity の名前（表示の順。数え直さず、要約の件数を読むだけ）。 */
const digestSeverityLabels = (digest: RuleDigestView): string =>
  listText(
    sortByDisplayOrder(SEVERITIES, SEVERITY_CATALOG)
      .filter((severity) => digest.bySeverity[severity] > 0)
      .map((severity) => SEVERITY_CATALOG[severity].label),
  );

/**
 * BN-d: 本体の指摘と外した指摘の件数の行（本体、遮断と結び付く区分の別（表示カタログの順。`NONE` は本体なので除く）、安全の区分）。件数は表示用モデルの値のまま。
 */
function blockRelationLines(model: ReportViewModel): readonly string[] {
  const text = CHATGPT_BUNDLE_GUIDE_TEXT;
  const counts = model.summary.beaksightBlockRelation;
  return [
    `- ${cliFieldText(text.bodyCount, formatCount(counts.mainFindingCounts.total))}`,
    ...sortByDisplayOrder(BEAKSIGHT_BLOCK_RELATIONS, BEAKSIGHT_BLOCK_RELATION_CATALOG)
      .filter((relation) => relation !== 'NONE')
      .map((relation) => {
        const spec = BEAKSIGHT_BLOCK_RELATION_CATALOG[relation];
        return `- ${cliFieldText(
          labelWithCodeText(text.excludedCount(spec.label), markdownCode(relation)),
          text.excludedCountValue(formatCount(counts.byRelation[relation]), spec.description),
        )}`;
      }),
    `- ${cliFieldText(text.excludedCount(SEVERITY_GROUP_CATALOG.SAFETY.label), formatCount(counts.excludedFindingCounts.byGroup.SAFETY))}`,
  ];
}

/**
 * T44i（Task 44 の設計書 6 章の 2026-10-22 の行の C）: 読み方の案内（`README.md`。日本語の Markdown）。文言は `CHATGPT_BUNDLE_GUIDE_TEXT` の 1 か所、
 * 名前は表示カタログから取る。件数は、表示用モデルの値を書くだけ（数え直さない）。URL・`targetId`・`startUrl`・Finding の文は書かない。LF で区切り、末尾に
 * LF を 1 つ付ける。AUD-1d: 第 1 部の案内。冒頭（題の次）に「全 N 部のうち第 1 部」を書く。
 */
function guideMarkdown(model: ReportViewModel, partCount: number): string {
  const text = CHATGPT_BUNDLE_GUIDE_TEXT;
  const names = CHATGPT_BUNDLE_FILE_NAMES;
  const { summary } = model;
  const pageJsonName = markdownCode(`${PAGES_ARTIFACT_DIRECTORY}/${text.pageIdPlaceholder}/${PAGE_ARTIFACT_FILE_NAMES.page}`);
  const pageFindingsName = markdownCode(`${PAGES_ARTIFACT_DIRECTORY}/${text.pageIdPlaceholder}/${names.pageFindings}`);
  const groupCounts = sortByDisplayOrder(SEVERITY_GROUPS, SEVERITY_GROUP_CATALOG).map((group) =>
    cliCountText(SEVERITY_GROUP_CATALOG[group].label, formatCount(summary.findingCounts.byGroup[group])),
  );
  // T44R2 の M-8: 項目の並びは `PAGE_COVERAGE_ITEMS`（1 か所）。
  const coverage = PAGE_COVERAGE_ITEMS.map((item) => cliCountText(RUN_SUMMARY_TEXT.coverage[item], formatCount(summary.coverage[item])));
  // BN-d: Rule の別の件数の表は、本体の指摘の要約（`mainRuleDigests`）。
  const ruleSection =
    model.mainRuleDigests.length === 0
      ? [text.noRules]
      : [
          text.ruleIntro,
          '',
          ...markdownTable(
            text.ruleColumns,
            ['left', 'left', 'left', 'right', 'right'],
            model.mainRuleDigests.map((digest) => [
              markdownCode(digest.ruleId),
              digestSeverityLabels(digest),
              categoryLabel(digest.category),
              formatInteger(digest.count),
              formatInteger(digest.pageCount),
            ]),
          ),
        ];
  const lines: readonly string[] = [
    `# ${text.title}`,
    '',
    text.partOf(formatInteger(partCount), formatInteger(1)),
    '',
    text.intro,
    '',
    `## ${text.runHeading}`,
    '',
    `- ${cliFieldText(RUN_SUMMARY_TEXT.runStatus, labelWithCodeText(RUN_STATUS_CATALOG[summary.runStatus].label, markdownCode(summary.runStatus)))}`,
    `- ${cliFieldText(text.runId, markdownCode(summary.runId))}`,
    `- ${cliFieldText(RUN_SUMMARY_TEXT.toolVersion, markdownCode(summary.toolVersion))}`,
    // T44R2 の I-5: 送信の扱い（表示用モデルの `auditSend.policy` を、カタログの名前で）。
    `- ${cliFieldText(AUDIT_SEND_TEXT.label, labelWithCodeText(AUDIT_SEND_POLICY_CATALOG[summary.auditSend.policy].label, markdownCode(summary.auditSend.policy)))}`,
    `- ${cliFieldText(text.findingCounts, countWithDetailsText(formatCount(summary.findingCounts.total), groupCounts))}`,
    `- ${cliFieldText(RUN_SUMMARY_TEXT.coverageHeading, listText(coverage))}`,
    '',
    // T44R2 の I-5: 送信の扱いの説明（カタログ）と、ログインの送信の一般の文（認証つきかどうかは、値で分けない。設計者の判断 (b)）。
    `${AUDIT_SEND_POLICY_CATALOG[summary.auditSend.policy].description}${text.loginNote}`,
    '',
    // WSO: 「チェックした画面だけ」の点検は、点検した範囲を言う（報告のまとめと同じ文。表示用モデルの `overview.pageScope` のまま）。
    ...(model.overview.pageScope === null ? [] : [HTML_REPORT_TEXT.overview.checkedScreensOnly(formatInteger(model.overview.pageScope.pageCount)), '']),
    text.incompletePagesNote(markdownCode(names.summary)),
    '',
    `## ${text.readingOrderHeading}`,
    '',
    text.readingOrderIntro,
    '',
    `1. ${text.readingOrder.summary(markdownCode(names.summary))}`,
    `2. ${text.readingOrder.findingsByRule(markdownCode(names.findingsByRule))}`,
    // REC-4: 指摘は、場所の一覧からページごとの指摘のファイルへたどる。ファイルの中の 3 つの一覧（本体・外した指摘・初めの表示だけ）を続けて説明する。
    `3. ${text.readingOrder.findingFiles(markdownCode(names.findingFiles), pageFindingsName, markdownCode(names.runFindings))}`,
    `   - ${text.readingOrder.findings(markdownCode(FINDING_FILE_LISTS.main))}`,
    `   - ${text.readingOrder.relatedFindings(markdownCode(FINDING_FILE_LISTS.excluded))}`,
    `   - ${text.readingOrder.initialOnlyFindings(markdownCode(FINDING_FILE_LISTS.initialOnly))}`,
    `4. ${text.readingOrder.pages(markdownCode(names.pages))}`,
    `5. ${text.readingOrder.evidence(pageJsonName)}`,
    '',
    text.otherFiles(markdownCode(names.manifest), markdownCode(RUN_ARTIFACT_FILE_NAMES.run)),
    '',
    // REC-4: page.json 2.0 の短い形の読み方。
    `## ${text.pageRecordHeading}`,
    '',
    text.pageRecordNote,
    '',
    // BN-d（設計書 3.5）: 本体の意味、外した件数と区分、page.json の中の BeakSight の遮断の記録、閉じる途中の遮断。
    `## ${text.blockHeading}`,
    '',
    text.bodyNote(markdownCode(FINDING_FILE_LISTS.main), markdownCode(FINDING_FILE_LISTS.excluded)),
    '',
    ...blockRelationLines(model),
    '',
    text.blockedByClientNote(pageJsonName),
    '',
    text.closingNote,
    '',
    `## ${text.repetitionHeading}`,
    '',
    text.repetitionNote(pageFindingsName, markdownCode(names.findingsByRule)),
    '',
    `## ${text.categoryHeading}`,
    '',
    ...markdownTable(
      text.categoryColumns,
      ['left', 'left', 'right'],
      summary.findingCountsByCategory.map((entry) => [categoryLabel(entry.category), markdownCode(entry.category), formatInteger(entry.count)]),
    ),
    '',
    `## ${text.ruleHeading}`,
    '',
    ...ruleSection,
    '',
    `## ${text.safetyHeading}`,
    '',
    text.safetyNote(SEVERITY_GROUP_CATALOG.SAFETY.label),
    '',
    // SAFE-2 の 4: 違反にしない止めた記録の数の読み方（値は run.json の safety にある）。
    text.stoppedRecordsNote,
    '',
    // AUD-1a・1b: どの画像を入れるかと、欠けの一覧の読み方（理由の説明は表示カタログ）。AUD-1c: 見つからなかったファイルの数（表示用モデルの値のまま）。
    `## ${text.artifactsHeading}`,
    '',
    text.artifactsNote(markdownCode(names.manifest)),
    '',
    ...sortByDisplayOrder(CHATGPT_BUNDLE_OMISSION_REASONS, OMISSION_REASON_DISPLAY).map((reason) => {
      const spec = OMISSION_REASON_DISPLAY[reason];
      return `- ${text.omissionReasonLine(markdownCode(reason), spec.label, spec.description ?? '')}`;
    }),
    '',
    `- ${cliFieldText(
      text.missingArtifactCount,
      model.missingArtifactCount === null ? text.missingArtifactCountNotChecked : formatCount(model.missingArtifactCount),
    )}`,
    '',
    // AUD-6a・6c: 指摘ごとの検証の状態と、Web Vitals の観測の範囲の読み方（値は findings.json と summary.json にある）。
    `## ${text.verificationHeading}`,
    '',
    text.verificationNote,
    '',
    text.webVitalsCoverageNote,
    '',
    // AUD-8: 色差の「測定できない」の読み方（値は summary.json にある）。
    text.contrastUnmeasuredNote,
    '',
    // AUD-3c: 固定の要素の重なりの区分の読み方（値は findings.json・summary.json・page.json にある）。
    text.fixedOverlapNote,
    '',
    // AUD-3d: 指摘の画像の参照と対象の領域の読み方（値は findings.json にある）。
    text.imageRegionNote,
    '',
    // AUD-4b: 名前の不一致の指摘の名前の文脈の読み方（値は findings.json にある）。
    text.labelInNameNote,
    '',
    // AUD-4d: フォーカスの確かめの数の読み方（値は summary.json にある）。
    text.focusChecksNote,
    '',
    // AUD-4c: http・https 以外の scheme のリンクの読み方（値は summary.json にある）。
    text.specialSchemeLinksNote,
    '',
    // AUD-7: 4xx・5xx の応答の区分の読み方（値は findings.json・summary.json・page.json にある）。
    text.httpErrorsNote,
    '',
    // AUD-6b: リンクごとの確かめの状態の読み方（値は links.json にある）。
    text.linkChecksNote,
    '',
    // AUD-6c: 性能の値の観測の範囲の読み方（値は summary.json にある）。
    text.performanceObservationsNote,
    '',
    // COV-4 の区切り 3: 操作で開いた状態の監査の読み方（値は summary.json・page.json にある）。
    text.openedStatesNote,
    '',
    // 設計者の判断 2026-11-11: 同じ口のくり返しをまとめた記録の読み方（値は summary.json・page.json にある）。
    text.repeatedReadsNote,
    '',
    // AUD-9c: 候補群の読み方。
    `## ${text.findingGroupsHeading}`,
    '',
    text.findingGroupsNote(markdownCode(names.findingGroups)),
  ];
  return `${lines.join('\n')}\n`;
}

/** AUD-1d: 第 2 部以降の読み方の案内（題、「全 N 部のうち第 k 部」、この部の中身と、一覧のある所）。 */
function partGuideMarkdown(partNumber: number, partCount: number): string {
  const text = CHATGPT_BUNDLE_GUIDE_TEXT;
  const lines: readonly string[] = [
    `# ${text.title}`,
    '',
    text.partOf(formatInteger(partCount), formatInteger(partNumber)),
    '',
    text.laterPartNote(markdownCode(CHATGPT_BUNDLE_FILE_NAMES.readme), markdownCode(CHATGPT_BUNDLE_FILE_NAMES.manifest)),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * スクリーンショットの、ZIP の中の JSON に書く形（AUD-1c の `missing` は、入れたものでは常に偽なので書かない）。REC-4: 関係する指摘の ID の一覧も書かない
 * （第 1 部の大きさを指摘の数に比例させない。指摘の側の `screenshotPaths` から引く）。
 */
const screenshotEntries = (screenshots: readonly ScreenshotView[], included: IncludedPaths): object[] =>
  screenshots
    .filter((screenshot) => included.has(screenshot.relativePath))
    .map(({ missing: _missing, relatedFindingIds: _relatedFindingIds, ...screenshot }) => screenshot);

/**
 * `pages.json`: 表示用モデルの `pages`（理由の説明を除く）。REC-4: 指摘の ID の一覧は持たず、件数だけ（指摘は、ページごとの指摘のファイルにある）。再試行の前の
 * 試行の Evidence は ID で参照する（記録は、そのページの page.json にある）。AUD-1a: スクリーンショットは、ZIP に入れたものだけ（外したものは
 * `manifest.json` の `omittedFiles` にある）。
 */
const pagesView = (model: ReportViewModel, included: IncludedPaths): object =>
  model.pages.map(({
    findings: _findings,
    mainFindingIds: _mainFindingIds,
    excludedFindingIds: _excludedFindingIds,
    initialOnlyFindingIds: _initialOnlyFindingIds,
    retryAttempts,
    incompleteReasons,
    viewports,
    screenshots,
    ...page
  }) => ({
    ...page,
    incompleteReasons: reasonCodes(incompleteReasons),
    viewports: viewports.map((viewport) => ({ ...viewport, incompleteReasons: reasonCodes(viewport.incompleteReasons) })),
    screenshots: screenshotEntries(screenshots, included),
    retryAttempts: retryAttempts.map(({ evidence, screenshots: attemptScreenshots, ...attempt }) => ({
      ...attempt,
      evidenceIds: evidence.map((location): EvidenceId => location.evidenceId),
      screenshots: screenshotEntries(attemptScreenshots, included),
    })),
  }));

/**
 * 部に詰める順の、撮り方ごとの優先度（小さいほど先。AUD-1b の順）。`Record` なので、撮り方を加えると、ここの書き漏れが型のエラーになる。
 */
const SCREENSHOT_PACKING_PRIORITY: Readonly<Record<ScreenshotCaptureType, number>> = Object.freeze({
  VIEWPORT: 0,
  FULL_PAGE: 1,
});

/**
 * 部に詰める順の段（小さいほど先）: 各ページの `page.json`（設計者の判断 (a) 2026-11-09: 第 1 部が JSON だけで大きくならないよう、第 1 部の外にも詰める）、
 * `visible-text.txt`、撮り方の優先度の中で「指摘に関係するもの、最終の試行の残り」、最後に再試行の前の試行の残り（AUD-1d で入れるようにしたもの）。
 */
const packingTierOf = (reference: ArtifactReferenceView): number => {
  if (reference.kind === 'PAGE_JSON') {
    return 0;
  }
  if (reference.kind !== 'SCREENSHOT' || reference.captureType === null) {
    return 1;
  }
  if (reference.relatedFindingIds.length === 0 && reference.retryAttempt !== null) {
    return 2 + Object.keys(SCREENSHOT_PACKING_PRIORITY).length * 2;
  }
  return 2 + SCREENSHOT_PACKING_PRIORITY[reference.captureType] * 2 + (reference.relatedFindingIds.length > 0 ? 0 : 1);
};

/** 種類の順（ZIP の中と読む順: `page.json`、`visible-text.txt`、スクリーンショット）。 */
const REFERENCE_KIND_ORDER: Readonly<Record<ArtifactReferenceView['kind'], number>> = Object.freeze({
  PAGE_JSON: 0,
  VISIBLE_TEXT: 1,
  SCREENSHOT: 2,
});

/** 参照を、種類の順、パスの順に並べる（ZIP の中の順）。 */
const inZipOrder = (references: readonly ArtifactReferenceView[]): readonly ArtifactReferenceView[] => {
  const byPath = new Map(references.map((reference) => [reference.path, reference]));
  return distinctSorted(byPath.keys())
    .map((path) => byPath.get(path))
    .filter((reference): reference is ArtifactReferenceView => reference !== undefined)
    .sort((left, right) => REFERENCE_KIND_ORDER[left.kind] - REFERENCE_KIND_ORDER[right.kind]);
};

// ---------------------------------------------------------------------------------------------------------------
// バンドル
// ---------------------------------------------------------------------------------------------------------------

/** ファイルを測った結果（入れるか、入れなかった理由）。MEM-2: 中身は持たない。 */
type ArtifactOutcome =
  | { readonly kind: 'included'; readonly measured: MeasuredArtifactFile }
  | { readonly kind: 'omitted'; readonly reason: ChatGptBundleOmissionReason };

const utf8Decoder = new TextDecoder('utf-8');

/**
 * AUD-1a（fail-closed）: 部の JSON（`file`）の `pages/…` の参照が、どれかの部にあるか（`placed`）、欠けの一覧にあるか（`omitted`）を確かめる。説明のない参照が
 * あれば、そのパスを示して `Error` を投げる（作るのを失敗させる）。JSON として読めないファイル（書き出し済みの `page.json` などが壊れている）も、確かめられない
 * ので失敗させる。JSON でないファイルは確かめない。
 */
function assertReferencesExplained(file: BundleFile, placed: ReadonlySet<string>, omitted: ReadonlySet<string>): void {
  if (!file.path.endsWith('.json')) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(file.bytes)) as unknown;
  } catch {
    throw new Error(`a JSON file in the bundle cannot be read to check its references: ${file.path}`);
  }
  const unexplained = pageArtifactReferencePathsIn(parsed).filter((path) => !placed.has(path) && !omitted.has(path));
  if (unexplained.length > 0) {
    throw new Error(`${file.path} refers to files that are neither in the bundle nor in omittedFiles: ${unexplained.join(', ')}`);
  }
}

/** 部に入れる 1 つのファイル。 */
interface BundleFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * MEM-2: 部に入れる予定の 1 つのファイル（バンドルが組み立てた中身 `bytes` か、書き出し済みのファイルの測った結果 `measured`。後者は、その部を作るときに読む）。
 */
type PlannedBundleFile =
  | { readonly path: string; readonly bytes: Uint8Array }
  | { readonly path: string; readonly measured: MeasuredArtifactFile }
  // REC-4: バンドルが組み立てる、部に詰めるファイル（指摘のファイル）。中身は持たず、目録の 1 件だけを持ち、部を作るときに組み立て直す（同じ中身）。
  | { readonly path: string; readonly build: () => Uint8Array; readonly record: ZipFileRecord };

/**
 * MEM-2: 書き出し済みのファイルを読み、測った結果と同じ中身か（バイト数と sha256）を確かめる。ないか、測った後に変わっていれば `Error`（manifest と中身が
 * 食い違うバンドルを作らない）。
 */
async function readMeasuredFile(files: BundleArtifactFiles, path: string, measured: MeasuredArtifactFile): Promise<Uint8Array> {
  const bytes = await readArtifactFileOrNull(files.read, path);
  if (bytes === null || bytes.byteLength !== measured.byteLength || createSha256FingerprintOfBytes(bytes) !== measured.sha256) {
    throw new Error(`an artifact file changed after it was measured for the bundle: ${path}`);
  }
  return bytes;
}

/** 予定のファイルの中身（書き出し済みのファイルは、ここで読む）。 */
async function bundleFileOf(files: BundleArtifactFiles, planned: PlannedBundleFile): Promise<BundleFile> {
  if ('bytes' in planned) {
    return planned;
  }
  if ('build' in planned) {
    return { path: planned.path, bytes: planned.build() };
  }
  return { path: planned.path, bytes: await readMeasuredFile(files, planned.path, planned.measured) };
}

/** 予定のファイルの、manifest の一覧（渡した順。組み立てた中身は `zipFileRecordsOf` で、書き出し済みのファイルは測った結果で。同じ形）。 */
const plannedFileRecordsOf = (planned: readonly PlannedBundleFile[]): readonly ZipFileRecord[] =>
  planned.flatMap((file) => {
    if ('bytes' in file) {
      return zipFileRecordsOf([file]);
    }
    return 'build' in file ? [file.record] : [{ path: file.path, byteLength: file.measured.byteLength, sha256: file.measured.sha256 }];
  });

/** 予定のファイルの大きさ（バイト）。 */
const plannedByteLength = (file: PlannedBundleFile): number => {
  if ('bytes' in file) {
    return file.bytes.byteLength;
  }
  return 'build' in file ? file.record.byteLength : file.measured.byteLength;
};

/**
 * 読む関数だけから作る、書き出し済みのファイルの読み方（`createChatGptBundleParts`・`createChatGptBundle` の形。MEM-2 の前と同じく、各ファイルを `read` で
 * 1 回ずつ、測る順に読み、中身をメモリに持つ。テストと、部を 1 つずつ書かない呼び出しのため）。
 */
const inMemoryBundleArtifactFiles = (read: ReadArtifactFile): BundleArtifactFiles => {
  const held = new Map<string, Uint8Array>();
  return {
    measure: async (path) => {
      const bytes = await readArtifactFileOrNull(read, path);
      if (bytes === null) {
        return null;
      }
      held.set(path, bytes);
      return { byteLength: bytes.byteLength, sha256: createSha256FingerprintOfBytes(bytes) };
    },
    read: async (path) => held.get(path) ?? null,
  };
};

/**
 * AUD-1d: ChatGPT 用バンドルを、部（第 1 部・第 2 部…）に分けて作る（設計書 6.1.9、6.1.11。AUD-1）。ファイルは書かない。
 * - `viewModel` は、`result`（`ArtifactWriter.writeRun` の戻り値の `result`）から組み立てたものでなければならない。`runId` か
 *   Run Status が違う場合は、何も読まずに `RangeError` を投げる。MEM-4: `result` は `run` だけを読む（ページは読まない。ページの置き場所の Run でもよい）。
 * - `readArtifactFile` は、`run.json`、各ページの `page.json`（パスの順）、`visible-text.txt` とスクリーンショット（部に詰める順）を、この順に 1 回ずつ読む。
 *   発表の前の確かめでなかったものは読まない。例外は、そのまま伝える。
 * - 集めた証拠は、大きさにかかわらず全部入れる。ファイルがないもの（`ARTIFACT_FILE_NOT_FOUND`）だけを欠けの一覧に書き、作る処理は止めない。
 * - 参照のパスが不正な場合と、部の大きさの目安が 1 以上の安全な整数でない場合は、何も読まずに `RangeError` を投げる。
 * - 部の JSON に説明のない参照がある場合は、`Error` を投げる（fail-closed）。
 * @param options.partSizeBytes 1 つの部の大きさの目安。既定は `CHATGPT_BUNDLE_PART_SIZE_BYTES`。
 */
export async function createChatGptBundleParts(
  viewModel: ReportViewModel,
  result: Pick<AuditRunResult, 'run'>,
  readArtifactFile: ReadArtifactFile,
  options: ChatGptBundlePartsOptions = {},
): Promise<readonly ChatGptBundlePart[]> {
  const prepared = await prepareChatGptBundleParts(viewModel, result, inMemoryBundleArtifactFiles(readArtifactFile), options);
  return collectParts(prepared);
}

/** MEM-2: 用意した ChatGPT 用バンドル（部の数と、部を 1 つずつ作る関数）。 */
export interface PreparedChatGptBundle {
  readonly partCount: number;
  /**
   * 部を、第 1 部から順に 1 つずつ作って返す（その部のファイルだけを読み、ZIP を作る。前の部は持たない）。ファイルが測った後に変わっていれば `Error`。
   * 1 回だけ回す。
   */
  readonly parts: () => AsyncGenerator<ChatGptBundlePart, void, undefined>;
}

/**
 * MEM-2（DEF-266）: `createChatGptBundleParts` と同じバンドルを、部ごとに作れるように用意する（中身とバイト列は同じ）。
 * - 用意の段: 書き出し済みのファイルを `files.measure` で測り（`createChatGptBundleParts` の読む順。中身は持たない）、大きさで部を割り当て、manifest の
 *   sha256 を決める。部の JSON の参照の確かめ（fail-closed）も、ここで終える（`page.json` などは `files.read` で 1 つずつ読んで捨てる）。何も書く前に失敗する。
 * - 部を作る段（`parts`）: 部ごとに、その部のファイルだけを `files.read` で読み、ZIP を作って返す。
 * 確かめと例外は `createChatGptBundleParts` と同じ。
 */
export async function prepareChatGptBundleParts(
  viewModel: ReportViewModel,
  result: Pick<AuditRunResult, 'run'>,
  files: BundleArtifactFiles,
  options: ChatGptBundlePartsOptions = {},
): Promise<PreparedChatGptBundle> {
  const partSizeBytes = options.partSizeBytes ?? CHATGPT_BUNDLE_PART_SIZE_BYTES;
  if (!isPositiveSafeInteger(partSizeBytes)) {
    throw new RangeError(`the part size must be a positive safe integer: ${String(partSizeBytes)}`);
  }
  return prepareBundleParts(viewModel, result, files, partSizeBytes);
}

/** 用意したバンドルの全部の部（部の順）。 */
async function collectParts(prepared: PreparedChatGptBundle): Promise<readonly ChatGptBundlePart[]> {
  const parts: ChatGptBundlePart[] = [];
  for await (const part of prepared.parts()) {
    parts.push(part);
  }
  return parts;
}

/**
 * ChatGPT 用バンドルを、部に分けずに 1 つの ZIP で作る（AUD-1d: 集めた証拠を全部入れる。部の名前を書き分けられるまでの、本番の書き出しの形）。中身は
 * `createChatGptBundleParts` の 1 部だけのときと同じ（`manifest.json` の `partSizeBytes` は `null`）。
 */
export async function createChatGptBundle(
  viewModel: ReportViewModel,
  result: Pick<AuditRunResult, 'run'>,
  readArtifactFile: ReadArtifactFile,
): Promise<Uint8Array> {
  const [single] = await collectParts(await prepareBundleParts(viewModel, result, inMemoryBundleArtifactFiles(readArtifactFile), null));
  if (single === undefined) {
    throw new Error('the bundle has no part');
  }
  return single.bytes;
}

/** 部を用意する本体（`partSizeBytes` が `null` なら、分けない）。 */
async function prepareBundleParts(
  viewModel: ReportViewModel,
  result: Pick<AuditRunResult, 'run'>,
  files: BundleArtifactFiles,
  partSizeBytes: number | null,
): Promise<PreparedChatGptBundle> {
  const { run } = result;
  if (viewModel.summary.runId !== run.runId || viewModel.summary.runStatus !== run.runStatus) {
    throw new RangeError(`the view model was not built from this Run: ${viewModel.summary.runId} and ${run.runId}`);
  }
  const references = inZipOrder(viewModel.artifactReferences);
  for (const reference of references) {
    assertPagesEntryPath(reference.path);
  }

  // 1. 測る（run.json、page.json、部に詰める順の visible-text.txt とスクリーンショット。MEM-2: 中身は持たない）。
  const notFound: ChatGptBundleOmissionReason = 'ARTIFACT_FILE_NOT_FOUND';
  const measureOutcome = async (path: string, missing: boolean): Promise<ArtifactOutcome> => {
    // AUD-1c: 発表の前の確かめでなかったものは読まない（HTML と同じ欠けの数にする）。
    const measured = missing ? null : await measureArtifactFileOrNull(files, path);
    return measured === null ? { kind: 'omitted', reason: notFound } : { kind: 'included', measured };
  };
  const runOutcome = await measureOutcome(RUN_ARTIFACT_FILE_NAMES.run, false);
  const outcomes = new Map<string, ArtifactOutcome>();
  // 詰める順（段の順に、それぞれパスの順。`references` は種類とパスの順に並んでいて、並べ替えは安定）。page.json も詰める（第 1 部には入れきらない）。
  const packed = [...references].sort((left, right) => packingTierOf(left) - packingTierOf(right));
  for (const reference of packed) {
    outcomes.set(reference.path, await measureOutcome(reference.path, reference.missing));
  }
  const included: IncludedPaths = new Set([...outcomes].filter(([, outcome]) => outcome.kind === 'included').map(([path]) => path));
  const omittedFiles: ChatGptBundleOmittedFile[] = [];
  if (runOutcome.kind === 'omitted') {
    omittedFiles.push({ path: RUN_ARTIFACT_FILE_NAMES.run, evidenceIds: [], reason: runOutcome.reason });
  }
  for (const reference of references) {
    const outcome = outcomes.get(reference.path);
    if (outcome?.kind === 'omitted') {
      omittedFiles.push({ path: reference.path, evidenceIds: [...reference.evidenceIds], reason: outcome.reason });
    }
  }

  // 2. 第 1 部（入口）の、バンドルが組み立てる JSON と run.json（manifest と README を除く。REC-4: 指摘のファイルと page.json は 3. で詰める）。
  const findingFilePlans = findingFilePlansOf(viewModel);
  const jsonFiles: PlannedBundleFile[] = [
    ...(runOutcome.kind === 'included' ? [{ path: RUN_ARTIFACT_FILE_NAMES.run, measured: runOutcome.measured }] : []),
    { path: CHATGPT_BUNDLE_FILE_NAMES.summary, bytes: artifactJsonBytes(summaryView(viewModel)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.findingsByRule, bytes: artifactJsonBytes(findingsByRuleView(viewModel, included)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.findingFiles, bytes: artifactJsonBytes(findingFilesView(findingFilePlans)) },
    // AUD-9c: 候補群（表示用モデルの値。数え直さない。REC-4: 指摘の ID の一覧は除く）。
    { path: CHATGPT_BUNDLE_FILE_NAMES.findingGroups, bytes: artifactJsonBytes(findingGroupsView(viewModel)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.pages, bytes: artifactJsonBytes(pagesView(viewModel, included)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.links, bytes: artifactJsonBytes(viewModel.linkChecks) },
  ];

  // REC-4: 指摘のファイル（ページの順、ページに属さない指摘は最後）。MEM-2: 中身は持たず、目録の 1 件だけを決め、部を作るときに組み立て直す。
  const groupIds: FindingGroupIds = new Map(viewModel.findingGroups.flatMap((group) => group.findingIds.map((findingId) => [findingId, group.groupId] as const)));
  const findingFiles = findingFilePlans.map((plan): PlannedBundleFile & { readonly record: ZipFileRecord } => {
    const build = (): Uint8Array => artifactJsonBytes(findingFileView(plan, included, groupIds));
    const [record] = zipFileRecordsOf([{ path: plan.path, bytes: build() }]);
    if (record === undefined) {
      throw new Error(`the record of a Finding file could not be made: ${plan.path}`);
    }
    return { path: plan.path, build, record };
  });

  // 3. 指摘のファイル・page.json・visible-text.txt・画像を、この順に部へ割り当てる（目安を超えるなら次の部。部が空なら、目安を超えても入れる。1 つのファイル
  //    だけで目安を超えるものは、そのファイル 1 つで 1 部になる）。
  //    REC-4: 全部が 1 つの部に入りきらないときは、第 1 部を入口（2. の JSON）だけにし、指摘のファイルから第 2 部に詰める。
  const partOfPath = new Map<string, number>();
  let partNumber = 1;
  let used = jsonFiles.reduce((sum, file) => sum + plannedByteLength(file), 0);
  const packedSizes = [
    ...findingFiles.map((file) => file.record.byteLength),
    ...packed.flatMap((reference) => {
      const outcome = outcomes.get(reference.path);
      return outcome?.kind === 'included' ? [outcome.measured.byteLength] : [];
    }),
  ];
  if (partSizeBytes !== null && packedSizes.length > 0 && packedSizes.reduce((sum, size) => sum + size, used) > partSizeBytes) {
    partNumber = 2;
    used = 0;
  }
  const place = (path: string, size: number): void => {
    if (partSizeBytes !== null && used > 0 && used + size > partSizeBytes) {
      partNumber += 1;
      used = 0;
    }
    partOfPath.set(path, partNumber);
    used += size;
  };
  for (const file of findingFiles) {
    place(file.path, file.record.byteLength);
  }
  for (const reference of packed) {
    const outcome = outcomes.get(reference.path);
    if (outcome?.kind === 'included') {
      place(reference.path, outcome.measured.byteLength);
    }
  }
  const partCount = partNumber;

  // 4. 各部のファイル（README、第 1 部は JSON、各部の指摘のファイル、page.json・visible-text.txt・画像は種類の順・パスの順）。
  const partFiles: PlannedBundleFile[][] = Array.from({ length: partCount }, (_, index) => [
    {
      path: CHATGPT_BUNDLE_FILE_NAMES.readme,
      bytes: utf8Encoder.encode(index === 0 ? guideMarkdown(viewModel, partCount) : partGuideMarkdown(index + 1, partCount)),
    },
    ...(index === 0 ? jsonFiles : []),
  ]);
  for (const file of findingFiles) {
    const part = partOfPath.get(file.path);
    if (part !== undefined) {
      partFiles[part - 1]?.push(file);
    }
  }
  for (const reference of references) {
    const part = partOfPath.get(reference.path);
    const outcome = outcomes.get(reference.path);
    if (part !== undefined && outcome?.kind === 'included') {
      partFiles[part - 1]?.push({ path: reference.path, measured: outcome.measured });
    }
  }

  // 5. 説明のない参照がないことを、部の順に確かめる（AUD-1a。書き出し済みの JSON は 1 つずつ読んで捨てる。MEM-2: 部を作る前に終える）。
  const placed = new Set(partFiles.flat().map(({ path }) => path));
  const omitted = new Set(omittedFiles.map(({ path }) => path));
  for (const planned of partFiles.flat()) {
    if (planned.path.endsWith('.json')) {
      assertReferencesExplained(await bundleFileOf(files, planned), placed, omitted);
    }
  }

  // 6. manifest を作り、部を 1 つずつ作る関数を返す（T32f: ZIP の組み立てと目録の 1 件は、共通の部品 `src/core/deterministic-zip.ts`）。
  const manifest: ChatGptBundleManifest = {
    bundleSchemaVersion: CHATGPT_BUNDLE_SCHEMA_VERSION,
    runId: run.runId,
    runStatus: run.runStatus,
    toolVersion: run.toolVersion,
    generatedAt: run.finishedAt,
    partCount,
    partSizeBytes,
    files: partFiles.flatMap((planned, index) => plannedFileRecordsOf(planned).map((record) => ({ ...record, part: index + 1 }))),
    omittedFiles,
    missingArtifactCount: viewModel.missingArtifactCount,
  };
  async function* parts(): AsyncGenerator<ChatGptBundlePart, void, undefined> {
    for (const [index, planned] of partFiles.entries()) {
      const entries: BundleFile[] = index === 0 ? [{ path: CHATGPT_BUNDLE_FILE_NAMES.manifest, bytes: artifactJsonBytes(manifest) }] : [];
      for (const file of planned) {
        entries.push(await bundleFileOf(files, file));
      }
      yield { partNumber: index + 1, partCount, bytes: deterministicZipOf(entries) };
    }
  }
  return { partCount, parts };
}
