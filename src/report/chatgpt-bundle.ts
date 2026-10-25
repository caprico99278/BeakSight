/**
 * ChatGPT 用バンドル（`beaksight-audit-bundle_…YYYYMMDDHHmmss.zip`。名前は `src/core/artifact-layout.ts` の `bundleFileName` で作る。PRE42-BN）の
 * 中身の唯一の owner（Task 14〜17 の設計書 6.1.2、6.1.8、6.1.9、6.1.11。上位の設計書 第19章）。
 * - 表示用モデル（`buildReportViewModel` の結果）から、ZIP のバイト列を作って返す。ファイルは書かない。書くのは
 *   `ArtifactWriter.writePresentation` だけである（ARCH08）。
 * - T44i（Task 44 の設計書 6 章の 2026-10-22 の行。この行が 6.1.9 の「ZIP に入れるもの」に優先する）: 読み方の案内（`README.md`。日本語の Markdown）を
 *   `manifest.json` の次に、Rule ごとの要約（`findings-by-rule.json`。表示用モデルの `ruleDigests` の写し）を `summary.json` の次に入れる。どちらも、
 *   表示用モデルの値を描くだけで、数え直さない。
 * - ZIP に入れるものと順: `manifest.json`、`README.md`、`run.json`、`summary.json`、`findings-by-rule.json`、`findings.json`、`pages.json`、`evidence-index.json`、
 *   各ページの `page.json`（パスの順。設計書 6.1.11）、関係するスクリーンショット（`ScreenshotView.relatedFindingIds` が空でない
 *   もの。再試行の前の試行のものを含む。パスの順）。T44f（Task 44 の設計書 P3-1 の E。ユーザーの判断 2026-10-21）: スクリーンショットは、見える範囲のもの
 *   （`BUNDLED_SCREENSHOT_CAPTURE_TYPES`。`VIEWPORT`）だけを入れ、ページ全体のもの（`FULL_PAGE`）は読まず、入れない（成果物のフォルダには残る。
 *   `findings.json` の `screenshotPaths` も、入れる種類だけ）。
 * - `run.json`、`page.json`、スクリーンショットは、書き出し済みのファイルを `readArtifactFile` で読み、そのまま入れる（組み立て
 *   直さない）。パスは、Run のディレクトリの中と同じにする。読めなかった（`null`）ものは入れず、`manifest.json` の `omittedFiles`
 *   に書く。Run Status は変えない（決めるのは `deriveRunStatus` だけで、バンドルの前に確定している）。
 * - `page.json` を入れるのは、`evidence-index.json` の `path` と `pointer` を、ZIP の中だけでたどれるようにするためである
 *   （上位の設計書 第19章「`evidenceRef` で一次証跡へ追跡可能にする」。設計書 6.1.11）。
 * - スクリーンショットの合計の大きさには、上限（既定は `CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES`）がある（設計書 6.1.11）。
 *   `VIEWPORT` のもの（パスの順）、`FULL_PAGE` のもの（パスの順）の順に入れ、合計が上限を超えるものは入れない（`omittedFiles` に、
 *   理由 `BUNDLE_SIZE_LIMIT` で書く）。超えた後も、それより小さいものは入れる。ZIP の中の並びは、パスの順のままである。
 *   上限の値は、`manifest.json` の `screenshotBudgetBytes` に書く。
 * - JSON は、字下げなし（T44f）、末尾に LF、UTF-8 にする（書式は `artifactJsonBytes` だけで組み立てる。CC-026）。値は、英数字の
 *   コードのままにし、日本語のラベル（理由の説明など）は入れない。
 *   Finding と Evidence は、`findings.json` と `evidence-index.json` の1か所に置き、`pages.json` からは ID で参照する。
 * - 生のレスポンス本文は、入れない。`visible-text.txt` は読まない。このファイルが組み立てる JSON は、表示用モデルだけから作る。
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
  type RunId,
  type RunStatus,
} from '../core/contracts.js';
import { deterministicZipOf, zipFileRecordsOf, type ZipFileRecord } from '../core/deterministic-zip.js';
import type { ScreenshotCaptureType } from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES } from '../core/limits.js';
import {
  AUDIT_SEND_POLICY_CATALOG,
  BEAKSIGHT_BLOCK_RELATION_CATALOG,
  FINDING_CATEGORY_CATALOG,
  RUN_STATUS_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  SEVERITY_GROUPS,
  sortByDisplayOrder,
} from '../presentation/catalog.js';
import { formatCount, formatInteger } from '../presentation/format.js';
import {
  AUDIT_SEND_TEXT,
  CHATGPT_BUNDLE_GUIDE_TEXT,
  PAGE_COVERAGE_ITEMS,
  RUN_SUMMARY_TEXT,
  cliCountText,
  cliFieldText,
  countWithDetailsText,
  labelWithCodeText,
  listText,
} from '../presentation/messages.js';
import type { FindingView, ReasonView, ReportViewModel, RuleDigestView, ScreenshotView } from './view-model.js';

// ---------------------------------------------------------------------------------------------------------------
// 定数と型
// ---------------------------------------------------------------------------------------------------------------

/**
 * `manifest.json` の `bundleSchemaVersion`。T44i（Task 44 の設計書 6 章の 2026-10-22 の行）: `README.md` と `findings-by-rule.json` を足し、`summary.json` に
 * category の別・Rule の別の件数が入ったので、1.1 にした。BN-d（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.5）: `findings.json` を
 * 本体の Finding（BeakSight の遮断と結び付かないサイト品質）だけにし、外した Finding の `beaksight-related-findings.json` を足し、`summary.json`・
 * `findings-by-rule.json`・`pages.json` の件数と ID を本体の分と外した分に分けたので、1.2 にした。
 */
export const CHATGPT_BUNDLE_SCHEMA_VERSION = 'chatgpt-bundle/1.2';

/**
 * ZIP の中で、このファイルが作るファイルの名前（`run.json` は、Run のディレクトリと同じ `RUN_ARTIFACT_FILE_NAMES.run`）。T44i: 読み方の案内（`readme`。
 * Markdown）と、Rule ごとの要約（`findingsByRule`）を足した。BN-d: 外した Finding（`relatedFindings`）を足した。
 */
export const CHATGPT_BUNDLE_FILE_NAMES = Object.freeze({
  manifest: 'manifest.json',
  readme: 'README.md',
  summary: 'summary.json',
  findingsByRule: 'findings-by-rule.json',
  findings: 'findings.json',
  relatedFindings: 'beaksight-related-findings.json',
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
  readonly files: readonly ZipFileRecord[];
  /** 入れられなかったファイル（ZIP の中の順）。 */
  readonly omittedFiles: readonly { readonly path: string; readonly reason: ChatGptBundleOmissionReason }[];
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

/**
 * T44f（Task 44 の設計書 P3-1 の E）: バンドルに入れるスクリーンショットの撮り方（見える範囲だけ。ページ全体のものは入れない）。`Record` なので、撮り方を
 * 加えると、ここの書き漏れが型のエラーになる。
 */
const BUNDLED_SCREENSHOT_CAPTURE_TYPES: Readonly<Record<ScreenshotCaptureType, boolean>> = Object.freeze({
  VIEWPORT: true,
  FULL_PAGE: false,
});

/** T44f: バンドルに入れる撮り方のスクリーンショットか。 */
const isBundledScreenshot = (screenshot: Pick<ScreenshotView, 'captureType'>): boolean => BUNDLED_SCREENSHOT_CAPTURE_TYPES[screenshot.captureType];

/**
 * 1 つの Finding と、それが参照する Evidence の場所（どのページにもなければ `null`）と、関係するスクリーンショットのパス（T44f: バンドルに入れる撮り方のものだけ）。
 */
const findingEntry = ({ finding, evidence, screenshots }: FindingView): object => ({
  finding,
  evidence: evidence.map(({ evidenceId, location }) => ({
    evidenceId,
    path: location === null ? null : location.path,
    pointer: location === null ? null : location.pointer,
  })),
  screenshotPaths: screenshots.filter(isBundledScreenshot).map((screenshot) => screenshot.relativePath),
});

/** `findings.json`: BN-d: 本体の Finding（表示用モデルの `mainFindings`。BeakSight の遮断と結び付かないサイト品質）だけ。 */
const findingsView = (model: ReportViewModel): object => model.mainFindings.map(findingEntry);

/**
 * BN-d: `beaksight-related-findings.json`: 外した Finding（表示用モデルの `excludedFindings`。`CAUSED`・`POSSIBLE`・SAFETY）と、BeakSight の遮断との関係
 * （区分・理由・結び付いた遮断。SAFETY の Finding は `null`）。
 */
const relatedFindingsView = (model: ReportViewModel): object =>
  model.excludedFindings.map((view) => ({
    ...findingEntry(view),
    beaksightBlockRelation: view.beaksightBlockRelation,
    // BN-R0 の M-3: SAFETY の Finding の止めた事象の、時点の別の件数（`CLOSING` は閉じる途中とページを離れた後。サイト品質の Finding は `null`）。
    safetyBlockPhaseCounts: view.safetyBlockPhaseCounts,
  }));

/** Rule ごとの要約の写し（例のスクリーンショットは、バンドルに入れる撮り方のもののパスだけ。`findings.json` の `screenshotPaths` と同じ決まり）。 */
const ruleDigestEntries = (digests: readonly RuleDigestView[]): object =>
  digests.map(({ examples, ...digest }) => ({
    ...digest,
    examples: examples.map(({ screenshots, ...example }) => ({
      ...example,
      screenshotPaths: screenshots.filter(isBundledScreenshot).map((screenshot) => screenshot.relativePath),
    })),
  }));

/**
 * T44i: `findings-by-rule.json`: 表示用モデルの Rule ごとの要約（値はコードのまま。数え直さない）。BN-d: 本体の Finding の要約（`main`。`mainRuleDigests`）と、
 * 外した Finding の要約（`excluded`。`excludedRuleDigests`）に分ける。
 */
const findingsByRuleView = (model: ReportViewModel): object => ({
  main: ruleDigestEntries(model.mainRuleDigests),
  excluded: ruleDigestEntries(model.excludedRuleDigests),
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
 * LF を 1 つ付ける。
 */
function guideMarkdown(model: ReportViewModel): string {
  const text = CHATGPT_BUNDLE_GUIDE_TEXT;
  const names = CHATGPT_BUNDLE_FILE_NAMES;
  const { summary } = model;
  const pageJsonName = markdownCode(`${PAGES_ARTIFACT_DIRECTORY}/${text.pageIdPlaceholder}/${PAGE_ARTIFACT_FILE_NAMES.page}`);
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
    text.incompletePagesNote(markdownCode(names.summary)),
    '',
    `## ${text.readingOrderHeading}`,
    '',
    text.readingOrderIntro,
    '',
    `1. ${text.readingOrder.summary(markdownCode(names.summary))}`,
    `2. ${text.readingOrder.findingsByRule(markdownCode(names.findingsByRule))}`,
    `3. ${text.readingOrder.findings(markdownCode(names.findings))}`,
    // BN-d: 外した指摘のファイルは、本体の次に読む。
    `4. ${text.readingOrder.relatedFindings(markdownCode(names.relatedFindings))}`,
    `5. ${text.readingOrder.pages(markdownCode(names.pages))}`,
    `6. ${text.readingOrder.evidence(markdownCode(names.evidenceIndex), pageJsonName)}`,
    '',
    text.otherFiles(markdownCode(names.manifest), markdownCode(RUN_ARTIFACT_FILE_NAMES.run)),
    '',
    // BN-d（設計書 3.5）: 本体の意味、外した件数と区分、page.json の中の BeakSight の遮断の記録、閉じる途中の遮断。
    `## ${text.blockHeading}`,
    '',
    text.bodyNote(markdownCode(names.findings), markdownCode(names.relatedFindings)),
    '',
    ...blockRelationLines(model),
    '',
    text.blockedByClientNote(pageJsonName),
    '',
    text.closingNote,
    '',
    `## ${text.repetitionHeading}`,
    '',
    text.repetitionNote(markdownCode(names.findings), markdownCode(names.findingsByRule)),
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
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * `pages.json`: 表示用モデルの `pages`（理由の説明を除く）。Finding と、再試行の前の試行の Evidence は、`findings.json` と
 * `evidence-index.json` にあるので、ID で参照する（同じ内容を ZIP の中に2つ持たない）。
 */
const pagesView = (model: ReportViewModel): object =>
  model.pages.map(({ findings: _findings, mainFindingIds, excludedFindingIds, retryAttempts, incompleteReasons, viewports, ...page }) => ({
    ...page,
    incompleteReasons: reasonCodes(incompleteReasons),
    viewports: viewports.map((viewport) => ({ ...viewport, incompleteReasons: reasonCodes(viewport.incompleteReasons) })),
    // BN-d: 本体の Finding の ID と、外した Finding の ID（表示用モデルの分け方のまま）。
    findingIds: mainFindingIds,
    excludedFindingIds,
    retryAttempts: retryAttempts.map(({ evidence, ...attempt }) => ({
      ...attempt,
      evidenceIds: evidence.map((location): EvidenceId => location.evidenceId),
    })),
  }));

/** 各ページの `page.json` のパス（重複なし、パスの順。設計書 6.1.11）。 */
const pageJsonPaths = (model: ReportViewModel): readonly string[] => distinctSorted(model.pages.map((page) => page.pageJsonPath));

/** 関係するスクリーンショット（`relatedFindingIds` が空でないもの。再試行の前の試行のものを含む。T44f: バンドルに入れる撮り方のものだけ）。 */
const relatedScreenshots = (model: ReportViewModel): readonly ScreenshotView[] =>
  model.pages
    .flatMap((page) => [...page.screenshots, ...page.retryAttempts.flatMap((attempt) => attempt.screenshots)])
    .filter((screenshot) => screenshot.relatedFindingIds.length > 0 && isBundledScreenshot(screenshot));

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
  // T44i: 読み方の案内を、manifest の次（ZIP の中の 2 番目）に入れる。
  files.push({ path: CHATGPT_BUNDLE_FILE_NAMES.readme, bytes: utf8Encoder.encode(guideMarkdown(viewModel)) });
  place(RUN_ARTIFACT_FILE_NAMES.run, runOutcome);
  files.push(
    { path: CHATGPT_BUNDLE_FILE_NAMES.summary, bytes: artifactJsonBytes(summaryView(viewModel)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.findingsByRule, bytes: artifactJsonBytes(findingsByRuleView(viewModel)) },
    { path: CHATGPT_BUNDLE_FILE_NAMES.findings, bytes: artifactJsonBytes(findingsView(viewModel)) },
    // BN-d: 外した Finding を、本体の次に入れる。
    { path: CHATGPT_BUNDLE_FILE_NAMES.relatedFindings, bytes: artifactJsonBytes(relatedFindingsView(viewModel)) },
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

  // 3. manifest と ZIP（読み終えた後に、同期で作る。T32f: ZIP の組み立てと目録の 1 件は、共通の部品 `src/core/deterministic-zip.ts`）。
  const manifest: ChatGptBundleManifest = {
    bundleSchemaVersion: CHATGPT_BUNDLE_SCHEMA_VERSION,
    runId: run.runId,
    runStatus: run.runStatus,
    toolVersion: run.toolVersion,
    generatedAt: run.finishedAt,
    screenshotBudgetBytes,
    files: zipFileRecordsOf(files),
    omittedFiles,
  };
  return deterministicZipOf([{ path: CHATGPT_BUNDLE_FILE_NAMES.manifest, bytes: artifactJsonBytes(manifest) }, ...files]);
}
