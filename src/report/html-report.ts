/**
 * HTML レポート（Task 14〜17 の設計書 6.1.4、6.1.5、6.1.6、6.1.9。UI追補設計書 第3章、第4章）。
 * - 入力は、表示用モデル（`buildReportViewModel` の結果）だけ。判定や集計はしない。件数は、表示用モデルの値をそのまま使う（GATE-UI04）。
 * - 節と順は、設計書 6.1.4 のとおり（要約、重大な指摘、category ごとの節、Interaction、Safety、ページの一覧）。節の名前と順と
 *   アンカーは、表示カタログ（`REPORT_SECTION_CATALOG`、`REPORT_CATEGORY_SECTION_CATALOG`）から取る。
 *   PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章）: 冒頭に「まとめ」の段（表示用モデルの `overview` を描くだけ）を置き、前の「要約」の
 *   節（Run の ID・許可 Origin・環境・版・送った要求の数などの技術の記録）は、中身を変えずに末尾の「記録」の段へ移した。
 * - HTML のタグを書かない。`html-components.ts` の部品を組み合わせるだけにする（GATE-UI03）。値は、部品がエスケープする。
 * - 日本語の文言は、文言カタログ（`src/presentation/messages.ts`）と表示カタログから取る（GATE-UI06）。色の値と、状態や severity の
 *   値の文字列は書かない（GATE-UI02、GATE-UI01）。
 * - 観測できなかった値は、書式（`src/presentation/format.ts`）で「未観測」と示す。0 や空文字にしない。
 * - URL は `renderUrl`（設計書 6.1.6）で示す。許可 Origin は、`summary.allowedOrigins` から取る。ただし、Safety の事象の URL は、
 *   リンクにせず、`renderUrlAsText` で文字として示す（設計書 6.1.11）。
 * - 行のない表は、見出しを残して「なし」を示す（設計書 6.1.11）。
 * - 整数（リンクの深さの上限、HTTP ステータスなど）は `formatInteger` で示す（設計書 6.1.10）。
 * - Evidence の場所は、表示用モデルの `location` をそのまま使う。ID から場所を引き直さない（設計書 6.1.10）。
 * - Safety の節には、表示用モデルの事象の一覧（`safety.events`）の表を置く（設計書 6.1.10）。
 * - Finding の文言は、Rule が作ったものをそのまま示す。理由（未完了の理由と Interaction の理由）は、同じ部品（`reasonParts`）で、
 *   コード、日本語の説明、詳細を示す。詳細は、技術的な詳細としてそのまま（エスケープして）示す。
 * - 同じ入力からは、同じ文字列を返す（時刻や乱数を使わない）。ファイルは書かない（書くのは `ArtifactWriter.writePresentation`）。
 */
import {
  INTERACTION_STATUSES,
  SEVERITIES,
  VIEWPORT_PROFILES,
  type EvidenceId,
  type PageId,
  type RunExecution,
  type RunLoad,
} from '../core/contracts.js';
import type { AuditSendPolicyName } from '../core/audit-send-policy.js';
import { BEAKSIGHT_BLOCK_RELATIONS } from '../core/beaksight-block-relation.js';
import { INTERACTION_NOT_VERIFIABLE_KINDS } from '../core/evidence-types.js';
import {
  AUDIT_SEND_POLICY_CATALOG,
  BEAKSIGHT_BLOCK_RELATION_CATALOG,
  EVIDENCE_TYPE_CATALOG,
  INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  INTERACTION_STATUS_CATALOG,
  REPORT_CATEGORY_SECTION_CATALOG,
  REPORT_SECTION_CATALOG,
  REPORT_SECTIONS,
  RUN_EXECUTION_END_REASON_CATALOG,
  RUN_STATUS_CATALOG,
  SAFETY_EVENT_KIND_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  SEVERITY_GROUPS,
  VIEWPORT_PROFILE_CATALOG,
  sortByDisplayOrder,
  type DisplaySpec,
  type ReportSection,
} from '../presentation/catalog.js';
import {
  formatCount,
  formatDateTime,
  formatDuration,
  formatElapsedTime,
  formatInteger,
  formatNotObserved,
  formatRequestsWithPeak,
  formatTimes,
} from '../presentation/format.js';
import {
  AUDIT_SEND_TEXT,
  HTML_REPORT_TEXT,
  PAGE_COVERAGE_ITEMS,
  REPORT_COMPONENT_TEXT,
  RUN_SUMMARY_TEXT,
  describeBlockedRequestReason,
  earlierAttemptRecordText,
  ordinalText,
  retryAttemptText,
  ruleVersionText,
  severityGroupTotalText,
  userAgentLabelText,
} from '../presentation/messages.js';
import {
  htmlText,
  joinHtml,
  renderBadge,
  renderCode,
  renderDocument,
  renderEvidenceRef,
  renderFileLink,
  renderFindingRow,
  renderFindingTable,
  renderInteractionStatusBadge,
  renderInternalLink,
  renderKeyValueList,
  renderMutedText,
  renderNotVerifiableKindBadge,
  renderPageAuditStatusBadge,
  renderParagraph,
  renderReferenceList,
  renderRunStatusBadge,
  renderScreenshotRef,
  renderSection,
  renderSeverityBadge,
  renderTable,
  renderTableRow,
  renderUrl,
  renderUrlAsText,
  toAnchorId,
  type SafeHtml,
  type SectionHeadingLevel,
} from './html-components.js';
import type {
  EvidenceLocationView,
  FindingSectionView,
  FindingView,
  InteractionView,
  OverviewProblemView,
  PageView,
  ReasonView,
  ReportOverviewView,
  ReportViewModel,
  RetryAttemptView,
  RunSummaryView,
  SafetyEventView,
  ViewportView,
} from './view-model.js';

type Fragment = SafeHtml<'fragment'>;

/** 描くときに共有する、表示用モデルから引いた対応（判定や集計はしない）。 */
interface RenderContext {
  readonly allowedOrigins: readonly string[];
  /** ページの一覧にあるページの、アンカー。 */
  readonly pageAnchors: ReadonlyMap<PageId, string>;
}

// ---------------------------------------------------------------------------------------------------------------
// アンカー
// ---------------------------------------------------------------------------------------------------------------

/** 記録の段（PL-R の前の「要約」の節）の小見出しのアンカー。 */
const SUMMARY_ANCHORS = Object.freeze({
  run: toAnchorId('record', 'run'),
  coverage: toAnchorId('record', 'coverage'),
  counts: toAnchorId('record', 'counts'),
  limits: toAnchorId('record', 'limits'),
  load: toAnchorId('record', 'load'),
  executions: toAnchorId('record', 'executions'),
  reasons: toAnchorId('record', 'reasons'),
  environment: toAnchorId('record', 'environment'),
  // OP-3: 本文から移した技術の記録。
  findings: toAnchorId('record', 'findings'),
  interactions: toAnchorId('record', 'interactions'),
  safety: toAnchorId('record', 'safety'),
  pages: toAnchorId('record', 'pages'),
});

/** PL-R: まとめの段の小見出しのアンカー。 */
const OVERVIEW_ANCHORS = Object.freeze({
  scope: toAnchorId('overview', 'scope'),
  counts: toAnchorId('overview', 'counts'),
  top: toAnchorId('overview', 'top'),
  notChecked: toAnchorId('overview', 'not-checked'),
});

/** Interaction と Safety の小見出しのアンカー。 */
const INTERACTION_ANCHORS = Object.freeze({
  counts: toAnchorId('interactions', 'counts'),
  notVerifiable: toAnchorId('interactions', 'not-verifiable'),
  list: toAnchorId('interactions', 'list'),
});
const SAFETY_ANCHORS = Object.freeze({
  blockedActions: toAnchorId('safety', 'blocked-actions'),
  events: toAnchorId('safety', 'events'),
});

const pageAnchorOf = (pageId: PageId): string => toAnchorId('page', pageId);

// ---------------------------------------------------------------------------------------------------------------
// 小さな組み立て
// ---------------------------------------------------------------------------------------------------------------

const none = (): Fragment => renderMutedText(REPORT_COMPONENT_TEXT.none);

/** 空でない断片を、空白でつなぐ。 */
const joinWithSpace = (parts: readonly (Fragment | null)[]): Fragment =>
  joinHtml(
    parts.filter((part): part is Fragment => part !== null),
    ' ',
  );

/** 観測できなかった値（`null`）を「未観測」とする文字。 */
const observedText = (value: string | null): string => value ?? formatNotObserved();

/** 観測できなかった値（`null`）を「未観測」とするコード。 */
const observedCode = (value: string | null): Fragment => (value === null ? htmlText(formatNotObserved()) : renderCode(value));

const subsection = (level: SectionHeadingLevel, label: string, anchorId: string, content: readonly Fragment[]): Fragment =>
  renderSection({ level, label, anchorId, content });

/**
 * 表。行がない場合（設計書 6.1.11）:
 * - 見出し（`caption`）のある表は、見出しと列の見出しを残し、すべての列にまたがる1行で「なし」を示す（何の表かが分かるように）。
 * - 見出しのない表は、「なし」を示す（小見出しの中に置く表なので、何の表かは小見出しで分かる）。
 */
const tableOrNone = (caption: string | null, columns: readonly string[], rows: readonly SafeHtml<'row'>[]): Fragment =>
  rows.length === 0 && caption === null
    ? renderParagraph(none())
    : renderTable({ caption, columns, rows, emptyText: REPORT_COMPONENT_TEXT.none });

/** ページのアンカーへのリンク（ページの一覧にないページは `null`）。 */
const pageLink = (context: RenderContext, pageId: PageId | null): Fragment | null => {
  const anchorId = pageId === null ? undefined : context.pageAnchors.get(pageId);
  return anchorId === undefined ? null : renderInternalLink(REPORT_COMPONENT_TEXT.pageDetailLink, anchorId);
};

/** Evidence の参照（`page.json` への相対リンクと JSON Pointer）。場所がわからない ID は、ID だけを示す。 */
const evidenceRef = (evidenceId: EvidenceId, location: EvidenceLocationView | null): Fragment =>
  renderEvidenceRef(evidenceId, location?.path ?? null, location?.pointer ?? null);

// ---------------------------------------------------------------------------------------------------------------
// 理由
// ---------------------------------------------------------------------------------------------------------------

/**
 * 1つの理由の部品（コード、日本語の説明、詳細の順）。詳細がなければ、詳細は `null`。未完了の理由と Interaction の理由の、
 * どちらの表示もこれを使う（C18o）。
 */
const reasonParts = (reason: ReasonView<string>): readonly [Fragment, Fragment, Fragment | null] => [
  renderCode(reason.code),
  // T44c（Task 44 の設計書 P1-4）: 次にできることのある理由は、説明の後に続ける。
  reason.nextStep === null
    ? htmlText(reason.description)
    : joinWithSpace([htmlText(reason.description), htmlText(HTML_REPORT_TEXT.reasonNextStep(reason.nextStep))]),
  reason.detail === null ? null : renderCode(reason.detail),
];

/** 1つの理由を、コード、説明、詳細の順に空白でつないだもの（詳細がなければ、コードと説明だけ）。 */
const reasonText = (reason: ReasonView<string>): Fragment => joinWithSpace(reasonParts(reason));

/** 理由の一覧（コード、説明、詳細。記録の段）。 */
const reasonList = (reasons: readonly ReasonView[]): Fragment => renderReferenceList(reasons.map(reasonText));

const reasonTable = (reasons: readonly ReasonView[]): Fragment =>
  tableOrNone(
    null,
    HTML_REPORT_TEXT.reasonColumns,
    reasons.map((reason) => {
      const [code, description, detail] = reasonParts(reason);
      return renderTableRow([code, description, detail ?? none()]);
    }),
  );

// ---------------------------------------------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------------------------------------------

/**
 * Finding の行（category の節だけが出す。アンカー `finding-<ID>` を付ける。すべての Finding は、どれか1つの category の節に入る）。T44f: 「重大な指摘」の
 * 節は行を出し直さず、この行へのリンクの一覧にした（`findingLinkList`）。
 */
const findingRow = (context: RenderContext, view: FindingView, technical: boolean): SafeHtml<'row'> =>
  renderFindingRow({
    finding: view.finding,
    allowedOrigins: context.allowedOrigins,
    evidence: view.evidence.map((reference) => ({
      evidenceId: reference.evidenceId,
      href: reference.location?.path ?? null,
      pointer: reference.location?.pointer ?? null,
    })),
    screenshots: view.screenshots,
    pageAnchorId: view.finding.pageId === null ? null : (context.pageAnchors.get(view.finding.pageId) ?? null),
    anchored: true,
    // BN-c・BN-d: BeakSight の遮断との関係の印（表示用モデルの判定のまま）と、BN-R0 の M-3: SAFETY の Finding の時点の印。
    blockRelation: view.beaksightBlockRelation,
    safetyBlockPhaseCounts: view.safetyBlockPhaseCounts,
    // OP-3（PL 14 章）: 本文の行は、やさしい語の行（規則と証拠は、記録の段の `findingRecordRow`）。
    technical,
    // OP-R2: やさしい語の行の内容は、Rule のやさしい文（表示用モデルの値のまま）。Rule の文は、記録の段に出す。
    ...(technical ? {} : { plainMessage: view.plainMessage }),
  });

const findingTableOrNone = (context: RenderContext, findings: readonly FindingView[]): Fragment =>
  findings.length === 0
    ? renderParagraph(HTML_REPORT_TEXT.noFindings)
    : renderFindingTable({ caption: null, rows: findings.map((view) => findingRow(context, view, false)), technical: false });

/**
 * OP-3: 記録の段の、Finding の技術の記録の行（番号は本文の行へのリンク、Rule の ID と版、Rule の文（OP-R2。本文はやさしい文なので、Rule の文はここに出す）、
 * Evidence の参照、スクリーンショットの Evidence の ID）。
 */
const findingRecordRow = (view: FindingView): SafeHtml<'row'> =>
  renderTableRow([
    renderInternalLink(view.finding.findingId, toAnchorId('finding', view.finding.findingId)),
    joinWithSpace([renderCode(view.finding.ruleId), renderMutedText(ruleVersionText(view.finding.ruleVersion))]),
    htmlText(view.finding.message),
    renderReferenceList(view.evidence.map((reference) => evidenceRef(reference.evidenceId, reference.location))),
    renderReferenceList(view.screenshots.map((screenshot) => renderCode(screenshot.evidenceId))),
  ]);

/**
 * T44f（Task 44 の設計書 P3-1 の D）: Finding へのリンクの一覧（severity の印、分類ごとの節の行へのリンク（Finding の ID）、文言）。「重大な指摘」の節と、
 * ページの節の Finding の一覧が使う（行を出し直さない）。空なら「なし」。
 */
const findingLinkList = (findings: readonly FindingView[]): Fragment =>
  renderReferenceList(
    findings.map(({ finding, plainMessage }) =>
      joinWithSpace([
        renderSeverityBadge(finding.severity),
        // OP-R2: 本文は、Rule のやさしい文（表示用モデルの値のまま）。
        htmlText(plainMessage),
        // OP-3（PL 14 章）: リンクの語は、問題の番号でなく「くわしく見る」（番号は記録の段）。
        renderInternalLink(HTML_REPORT_TEXT.overview.problemLink, toAnchorId('finding', finding.findingId)),
      ]),
    ),
  );

/** T44f: 「重大な指摘」の節（分類ごとの節の行へのリンクの一覧。なければ、指摘のない節の文）。 */
const findingLinksOrNone = (findings: readonly FindingView[]): Fragment =>
  findings.length === 0 ? renderParagraph(HTML_REPORT_TEXT.noFindings) : findingLinkList(findings);

// ---------------------------------------------------------------------------------------------------------------
// 節1: 要約
// ---------------------------------------------------------------------------------------------------------------

const reachedText = (reached: boolean): string => (reached ? HTML_REPORT_TEXT.summary.reached : HTML_REPORT_TEXT.summary.notReached);

/**
 * 「サイトへの負荷」の小節の中身（サイトへの負荷の制御の設計書 3.1 の7、4.5）。値は、表示用モデルの `summary.load` をそのまま
 * 書式にかける（数え直さない）。最小の間隔は、上限の「実行時間」と同じ `formatDuration`、待った時間の合計は、長くなるので時間・分・秒の
 * `formatElapsedTime`（L7）、件数は `formatCount`、ページの読み込みの回数は `formatTimes`、要求の件数と1分あたりの最大は
 * `formatRequestsWithPeak`（CLI と共通の組み立て。L7）で示す。
 */
const loadEntries = (load: RunLoad): readonly { readonly label: string; readonly value: string }[] => {
  const labels = HTML_REPORT_TEXT.summary.load;
  return [
    { label: labels.minNavigationInterval, value: formatDuration(load.minNavigationIntervalMs) },
    { label: labels.maxInteractionsPerPage, value: formatCount(load.maxInteractionsPerPage) },
    { label: labels.navigationCount, value: formatTimes(load.navigationCount) },
    { label: labels.pacingWait, value: formatElapsedTime(load.pacingWaitMs) },
    { label: RUN_SUMMARY_TEXT.allowedOriginRequests, value: formatRequestsWithPeak(load.requests.allowedOrigins) },
    { label: labels.otherOriginRequests, value: formatRequestsWithPeak(load.requests.otherOrigins) },
    { label: labels.servedFromCache, value: formatCount(load.requests.servedFromCache) },
    { label: labels.withheldOtherOrigins, value: formatCount(load.requests.withheldOtherOrigins) },
  ];
};

/**
 * 「実行の記録」の小節の、1つの実行の行（中断した Run の再開の設計書 4.8 の「表示」。R6）。欄は、何回目（一覧の中の位置）、開始の日時、
 * 終了の日時（`formatDateTime`）、終わり方。終わり方は、表示カタログ（`RUN_EXECUTION_END_REASON_CATALOG`）のラベルのバッジ、コード、
 * カタログの説明を、空白でつないで示す（Run の状態の、バッジと説明の示し方に合わせる）。終わり方の値そのものは書かない（カタログで引く）。
 */
const executionRow = (execution: RunExecution, index: number): SafeHtml<'row'> => {
  const spec: DisplaySpec = RUN_EXECUTION_END_REASON_CATALOG[execution.endReason];
  return renderTableRow([
    ordinalText(index + 1),
    formatDateTime(execution.startedAt),
    formatDateTime(execution.finishedAt),
    joinWithSpace([
      renderBadge(spec, execution.endReason),
      renderCode(execution.endReason),
      spec.description === null ? null : htmlText(spec.description),
    ]),
  ]);
};

/**
 * AS-b: 監査の段の送信の扱いのバッジと説明（ラベル・色・説明は表示カタログ）。値は表示用モデルの `summary.auditSend` のまま（数え直さない）。
 */
const auditSendPolicyValue = (auditSend: RunSummaryView['auditSend']): Fragment => {
  const spec = AUDIT_SEND_POLICY_CATALOG[auditSend.policy];
  return joinWithSpace([renderBadge(spec, auditSend.policy), spec.description === null ? null : htmlText(spec.description)]);
};

/** OP-3: 本文の送信の扱いの、やさしい説明（鍵は送信の扱いの一覧と同じ。書き漏れは型のエラー）。 */
const PLAIN_AUDIT_SEND: Readonly<Record<AuditSendPolicyName, string>> = HTML_REPORT_TEXT.plainAuditSend;

/** OP-3: 本文の送信の扱い（印と、送り方の名前を書かないやさしい説明。表示カタログの説明は記録の段）。 */
const auditSendPlainValue = (auditSend: RunSummaryView['auditSend']): Fragment =>
  joinWithSpace([renderBadge(AUDIT_SEND_POLICY_CATALOG[auditSend.policy], auditSend.policy), htmlText(PLAIN_AUDIT_SEND[auditSend.policy])]);

/**
 * AS-b: 通したことの知らせ（目立つ形。表示用モデルの `prominent` が真のときだけ）。Run の小節の最初と、Safety の節に置く。件数は `formatCount`。
 */
const auditSendNotice = (auditSend: RunSummaryView['auditSend']): readonly Fragment[] =>
  auditSend.prominent
    ? [
      renderParagraph(joinWithSpace([
        renderBadge(AUDIT_SEND_POLICY_CATALOG[auditSend.policy], auditSend.policy),
        htmlText(AUDIT_SEND_TEXT.passedNotice(formatCount(auditSend.passedRequests))),
      ])),
      // AS-c: 内訳（ほかの Origin への送信と、WebSocket の接続）。
      renderParagraph(AUDIT_SEND_TEXT.passedDetail(formatCount(auditSend.passedOtherOriginRequests), formatCount(auditSend.passedWebSockets))),
      // AS-c fix round 1: Guard の判定を通らずに開いた接続と、危険な語の接続（出すかは表示用モデルの `webSocketCaution`）。
      ...(auditSend.webSocketCaution
        ? [renderParagraph(AUDIT_SEND_TEXT.webSocketCaution(formatCount(auditSend.passedWebSocketsOutsideGuard), formatCount(auditSend.passedDangerousWebSockets)))]
        : []),
    ]
    : [];

function renderSummary(summary: RunSummaryView, level: SectionHeadingLevel): readonly Fragment[] {
  const text = HTML_REPORT_TEXT.summary;
  const counts = summary.findingCounts;
  const { environment } = summary;
  const viewports = sortByDisplayOrder(VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG);
  return [
    subsection(level, text.runHeading, SUMMARY_ANCHORS.run, [
      ...auditSendNotice(summary.auditSend),
      renderKeyValueList([
        {
          label: RUN_SUMMARY_TEXT.runStatus,
          value: joinWithSpace([renderRunStatusBadge(summary.runStatus), htmlText(RUN_STATUS_CATALOG[summary.runStatus].description)]),
        },
        { label: text.runId, value: renderCode(summary.runId) },
        { label: RUN_SUMMARY_TEXT.target, value: renderCode(summary.targetId) },
        { label: RUN_SUMMARY_TEXT.startUrl, value: renderUrl(summary.startUrl, summary.allowedOrigins) },
        { label: text.allowedOrigins, value: renderReferenceList(summary.allowedOrigins.map((origin) => renderCode(origin))) },
        { label: text.startedAt, value: formatDateTime(summary.startedAt) },
        { label: text.finishedAt, value: formatDateTime(summary.finishedAt) },
        { label: RUN_SUMMARY_TEXT.toolVersion, value: renderCode(summary.toolVersion) },
        // AS-b: 監査の段の送信の扱い（どの扱いで監査した結果か）。
        { label: AUDIT_SEND_TEXT.label, value: auditSendPolicyValue(summary.auditSend) },
      ]),
    ]),
    subsection(level, RUN_SUMMARY_TEXT.coverageHeading, SUMMARY_ANCHORS.coverage, [
      // T44R2 の M-8: 項目の並びは `PAGE_COVERAGE_ITEMS`（1 か所）。
      renderKeyValueList(PAGE_COVERAGE_ITEMS.map((item) => ({ label: RUN_SUMMARY_TEXT.coverage[item], value: formatCount(summary.coverage[item]) }))),
    ]),
    subsection(level, text.countsHeading, SUMMARY_ANCHORS.counts, [
      renderParagraph(text.countsNote),
      renderTable({
        caption: null,
        columns: text.countColumns,
        rows: sortByDisplayOrder(SEVERITIES, SEVERITY_CATALOG).map((severity) =>
          renderTableRow([
            SEVERITY_GROUP_CATALOG[SEVERITY_CATALOG[severity].group].label,
            renderSeverityBadge(severity),
            formatCount(counts.bySeverity[severity]),
          ]),
        ),
      }),
      renderKeyValueList([
        ...sortByDisplayOrder(SEVERITY_GROUPS, SEVERITY_GROUP_CATALOG).map((group) => ({
          label: severityGroupTotalText(SEVERITY_GROUP_CATALOG[group].label),
          value: formatCount(counts.byGroup[group]),
        })),
        { label: text.totalFindings, value: formatCount(counts.total) },
        { label: text.safetyInvariantViolations, value: formatCount(summary.safetyInvariantViolationCount) },
      ]),
      // BN-d: BeakSight の遮断と指摘の関係の区分の別の件数（区分の名前と順は表示カタログ）と、ChatGPT 用バンドルの本体の件数（表示用モデルの値のまま）。
      renderParagraph(text.blockRelationNote),
      renderKeyValueList([
        ...sortByDisplayOrder(BEAKSIGHT_BLOCK_RELATIONS, BEAKSIGHT_BLOCK_RELATION_CATALOG).map((relation) => ({
          label: text.blockRelationCount(BEAKSIGHT_BLOCK_RELATION_CATALOG[relation].label),
          value: formatCount(summary.beaksightBlockRelation.byRelation[relation]),
        })),
        { label: text.bundleMainFindings, value: formatCount(summary.beaksightBlockRelation.mainFindingCounts.total) },
      ]),
    ]),
    subsection(level, text.limitsHeading, SUMMARY_ANCHORS.limits, [
      renderTable({
        caption: null,
        columns: text.limitColumns,
        rows: [
          renderTableRow([text.limits.maxPages, formatCount(summary.limits.maxPages), reachedText(summary.limits.reached.maxPagesReached)]),
          renderTableRow([
            text.limits.maxDepth,
            formatInteger(summary.limits.maxDepth),
            reachedText(summary.limits.reached.maxDepthReached),
          ]),
          renderTableRow([
            text.limits.maxRuntime,
            formatDuration(summary.limits.maxRuntimeMs),
            reachedText(summary.limits.reached.maxRuntimeReached),
          ]),
        ],
      }),
      renderKeyValueList([
        { label: text.unverifiedInteractions, value: formatCount(summary.unverifiedInteractionCount) },
        { label: text.unverifiedInternalLinks, value: formatCount(summary.unverifiedInternalLinkCount) },
      ]),
    ]),
    subsection(level, RUN_SUMMARY_TEXT.loadHeading, SUMMARY_ANCHORS.load, [
      renderParagraph(text.loadNote),
      renderKeyValueList(loadEntries(summary.load)),
    ]),
    // 実行の記録（R6）。回数は、表示用モデルの値をそのまま書式にかける（数え直さない）。CLI の結果の行の順と同じく、負荷の後に置く。
    subsection(level, text.executionsHeading, SUMMARY_ANCHORS.executions, [
      renderParagraph(text.executionsNote),
      renderKeyValueList([
        { label: text.executions.count, value: formatTimes(summary.executions.count) },
        { label: text.executions.resumeCount, value: formatTimes(summary.executions.resumeCount) },
      ]),
      renderTable({ caption: null, columns: text.executionColumns, rows: summary.executions.items.map(executionRow) }),
    ]),
    subsection(level, RUN_SUMMARY_TEXT.reasonsHeading, SUMMARY_ANCHORS.reasons, [reasonTable(summary.incompleteReasons)]),
    subsection(level, text.environmentHeading, SUMMARY_ANCHORS.environment, [
      renderKeyValueList([
        { label: text.environment.nodeVersion, value: renderCode(environment.nodeVersion) },
        { label: text.environment.platform, value: renderCode(environment.platform) },
        { label: text.environment.osRelease, value: renderCode(environment.osRelease) },
        { label: text.environment.arch, value: renderCode(environment.arch) },
        { label: RUN_SUMMARY_TEXT.playwrightVersion, value: renderCode(environment.playwrightVersion) },
        { label: text.environment.chromiumVersion, value: observedCode(environment.chromiumVersion) },
        ...viewports.map((viewport) => ({
          label: userAgentLabelText(VIEWPORT_PROFILE_CATALOG[viewport].label),
          value: observedText(environment.userAgents[viewport]),
        })),
      ]),
    ]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// PL-R: 冒頭のまとめの段（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章）
// ---------------------------------------------------------------------------------------------------------------

/** 大事な問題の 1 行（重さの印、Rule のやさしい文（OP-R2）、出た回数とページの数、種類ごとの問題の表の行へのリンク）。 */
const overviewProblemItem = (problem: OverviewProblemView): Fragment =>
  joinWithSpace([
    renderSeverityBadge(problem.severity),
    htmlText(problem.plainMessage),
    renderMutedText(problem.pageCount === 0
      ? HTML_REPORT_TEXT.overview.problemTimesWithoutPages(formatCount(problem.count))
      : HTML_REPORT_TEXT.overview.problemTimes(formatCount(problem.count), formatInteger(problem.pageCount))),
    renderInternalLink(HTML_REPORT_TEXT.overview.problemLink, toAnchorId('finding', problem.findingId)),
  ]);

/** 見なかった理由の 1 行（説明と、あれば次にできること。理由のコードと技術の詳細は、記録の段にだけ出す）。 */
const overviewReasonText = (reason: ReasonView<string>): Fragment =>
  reason.nextStep === null
    ? htmlText(reason.description)
    : joinWithSpace([htmlText(reason.description), htmlText(HTML_REPORT_TEXT.reasonNextStep(reason.nextStep))]);

/** 「見られなかったところ」の中身（最後まで見られなかったページの数、点検の全体の理由、ページの理由ごとのページの数。何もなければ、ないことの文）。 */
const overviewNotChecked = (overview: ReportOverviewView): readonly Fragment[] => {
  const text = HTML_REPORT_TEXT.overview;
  const parts: Fragment[] = [
    ...(overview.notFullyCheckedPageCount > 0 ? [renderParagraph(text.notFullyCheckedPages(formatInteger(overview.notFullyCheckedPageCount)))] : []),
    ...(overview.runReasons.length > 0
      ? [renderKeyValueList([{ label: text.runReasonsCaption, value: renderReferenceList(overview.runReasons.map(overviewReasonText)) }])]
      : []),
    ...(overview.pageReasons.length > 0
      ? [renderKeyValueList([{
        label: text.pageReasonsCaption,
        value: renderReferenceList(overview.pageReasons.map(({ reason, pages }) =>
          reason.nextStep === null
            ? htmlText(text.pageReason(reason.description, formatInteger(pages)))
            : joinWithSpace([htmlText(text.pageReason(reason.description, formatInteger(pages))), htmlText(HTML_REPORT_TEXT.reasonNextStep(reason.nextStep))]))),
      }])]
      : []),
  ];
  return parts.length === 0 ? [renderParagraph(text.nothingLeft)] : parts;
};

/**
 * まとめの段（何を見たか、見つかった問題の数、大事な問題、見られなかったところ）。値は表示用モデルの `overview` と `summary` のまま（数え直さない）。Run の ID・
 * 許可 Origin・版などの技術の記録は出さない（末尾の記録の段にある）。
 */
function renderOverview(context: RenderContext, viewModel: ReportViewModel, level: SectionHeadingLevel): readonly Fragment[] {
  const text = HTML_REPORT_TEXT.overview;
  const { summary, overview } = viewModel;
  return [
    // 安全のために必ず見せるもの（設計書 7 章）: ページが出す送信を通した点検の知らせは、技術の記録を末尾へ移しても、冒頭に残す（目立つ形。表示用モデルの
    // `summary.auditSend.prominent` が真のときだけ）。
    ...auditSendNotice(summary.auditSend),
    // OP-H: チェックした画面がある点検は、この後に登録・更新することを言う（表示用モデルの `overview.plannedWriteScreenCount` のまま。報告で判定しない）。
    ...(overview.plannedWriteScreenCount > 0 ? [renderParagraph(text.plannedWrites)] : []),
    subsection(level, text.scopeHeading, OVERVIEW_ANCHORS.scope, [
      renderKeyValueList([
        { label: text.site, value: renderUrl(summary.startUrl, context.allowedOrigins) },
        { label: text.result, value: joinWithSpace([renderRunStatusBadge(summary.runStatus), htmlText(RUN_STATUS_CATALOG[summary.runStatus].description)]) },
        { label: text.discoveredPages, value: formatCount(summary.coverage.discovered) },
        { label: text.checkedPages, value: formatCount(overview.checkedPageCount) },
      ]),
    ]),
    subsection(level, text.countsHeading, OVERVIEW_ANCHORS.counts, [
      renderParagraph(overview.problemCount === 0 ? text.noProblems : text.problemsFound(formatCount(overview.problemCount))),
      renderParagraph(renderMutedText(text.countsNote)),
      renderKeyValueList(
        sortByDisplayOrder(SEVERITIES, SEVERITY_CATALOG).map((severity) => ({
          label: SEVERITY_CATALOG[severity].label,
          value: formatCount(summary.findingCounts.bySeverity[severity]),
        })),
      ),
    ]),
    subsection(level, text.topHeading, OVERVIEW_ANCHORS.top, [
      overview.topProblems.length === 0 ? renderParagraph(text.noProblems) : renderReferenceList(overview.topProblems.map(overviewProblemItem)),
    ]),
    subsection(level, text.notCheckedHeading, OVERVIEW_ANCHORS.notChecked, overviewNotChecked(overview)),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 節2・3: 重大な指摘、category ごとの節
// ---------------------------------------------------------------------------------------------------------------

function renderCategorySection(context: RenderContext, view: FindingSectionView, level: SectionHeadingLevel): Fragment {
  const spec = REPORT_CATEGORY_SECTION_CATALOG[view.section];
  return subsection(level, spec.label, spec.anchor, [
    ...(spec.description === null ? [] : [renderParagraph(spec.description)]),
    renderKeyValueList([{ label: HTML_REPORT_TEXT.findingCount, value: formatCount(view.counts.total) }]),
    findingTableOrNone(context, view.findings),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// 節4: Interaction
// ---------------------------------------------------------------------------------------------------------------

/** 押したもの（要素の名前、役割、読み上げの名前。記録の段）。 */
const interactionTargetCode = (item: InteractionView): Fragment =>
  item.target === null
    ? htmlText(formatNotObserved())
    : joinWithSpace([
        renderCode(item.target.tagName),
        item.target.role === null ? null : renderCode(item.target.role),
        item.target.accessibleName === '' ? null : htmlText(item.target.accessibleName),
      ]);

/** OP-3: 本文の押したもの（読み上げの名前だけ。名前がなければ、名前のない部品）。 */
const interactionTargetPlain = (item: InteractionView): Fragment =>
  item.target === null
    ? htmlText(formatNotObserved())
    : htmlText(item.target.accessibleName === '' ? HTML_REPORT_TEXT.interactions.unnamedTarget : item.target.accessibleName);

function interactionRow(context: RenderContext, item: InteractionView): SafeHtml<'row'> {
  return renderTableRow([
    joinWithSpace([renderUrl(item.pageUrl, context.allowedOrigins), pageLink(context, item.pageId)]),
    item.viewport === null ? renderMutedText(REPORT_COMPONENT_TEXT.viewportIndependent) : VIEWPORT_PROFILE_CATALOG[item.viewport].label,
    interactionTargetPlain(item),
    renderInteractionStatusBadge(item.status),
    item.notVerifiableKind === null ? none() : renderNotVerifiableKindBadge(item.notVerifiableKind),
    // OP-3（PL 14 章）: 理由はやさしい説明だけ（コード・詳細・証拠は記録の段の `interactionRecordRow`）。
    overviewReasonText(item.reason),
  ]);
}

/**
 * OP-3: 記録の段の、押して確かめた操作の技術の記録の行（ページ、押したもの、理由のコードと説明と詳細、Evidence の参照）。OP-G2（WCAG 2.2 の 2.5.8。axe の
 * target-size）: ページの欄のアドレスは文字で示し、押す所はページへのリンクの 1 つにする（列の少ない表で、行が並ぶと、アドレスのリンクとページへのリンクと
 * 隣の行のリンクが近づきすぎた。アドレスへのリンクは本文の表にある）。
 */
function interactionRecordRow(context: RenderContext, item: InteractionView): SafeHtml<'row'> {
  return renderTableRow([
    joinWithSpace([renderUrlAsText(item.pageUrl), pageLink(context, item.pageId)]),
    interactionTargetCode(item),
    reasonText(item.reason),
    evidenceRef(item.evidenceId, item.location),
  ]);
}

function renderInteractions(context: RenderContext, viewModel: ReportViewModel, level: SectionHeadingLevel): readonly Fragment[] {
  const text = HTML_REPORT_TEXT.interactions;
  const { interactions } = viewModel;
  return [
    subsection(level, text.countsHeading, INTERACTION_ANCHORS.counts, [
      renderKeyValueList(
        sortByDisplayOrder(INTERACTION_STATUSES, INTERACTION_STATUS_CATALOG).map((status) => ({
          label: INTERACTION_STATUS_CATALOG[status].label,
          value: formatCount(interactions.byStatus[status]),
        })),
      ),
    ]),
    subsection(level, text.notVerifiableHeading, INTERACTION_ANCHORS.notVerifiable, [
      renderKeyValueList(
        sortByDisplayOrder(INTERACTION_NOT_VERIFIABLE_KINDS, INTERACTION_NOT_VERIFIABLE_KIND_CATALOG).map((kind) => ({
          label: INTERACTION_NOT_VERIFIABLE_KIND_CATALOG[kind].label,
          value: formatCount(interactions.notVerifiableByKind[kind]),
        })),
      ),
    ]),
    subsection(level, text.listHeading, INTERACTION_ANCHORS.list, [
      interactions.items.length === 0
        ? renderParagraph(text.noInteractions)
        : renderTable({ caption: null, columns: text.plainColumns, rows: interactions.items.map((item) => interactionRow(context, item)) }),
    ]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 節5: Safety
// ---------------------------------------------------------------------------------------------------------------

/**
 * Safety の事象の行（設計書 6.1.10、6.1.11）。列は、種類、ページ（アンカーへのリンク）、ビューポート、メソッド、URL、
 * 候補（Interaction の候補の ID）、理由、Evidence の参照。値のない欄は「なし」と示す。再試行の前の試行の記録は、種類の欄に、
 * そのことを示す。
 * URL は、種類と `classifyUrl` の結果によらず、リンクにせず文字で示す（`renderUrlAsText`。設計書 6.1.11）。安全のために
 * 実行しなかった操作を、レポートから1回のクリックで実行できないようにするためである。
 */
function safetyEventRow(context: RenderContext, event: SafetyEventView): SafeHtml<'row'> {
  const anchorId = context.pageAnchors.get(event.pageId);
  return renderTableRow([
    joinWithSpace([
      htmlText(SAFETY_EVENT_KIND_CATALOG[event.kind].label),
      event.retryAttempt === null ? null : renderMutedText(earlierAttemptRecordText(event.retryAttempt)),
    ]),
    anchorId === undefined ? renderCode(event.pageId) : renderInternalLink(event.pageId, anchorId),
    event.viewport === null ? renderMutedText(REPORT_COMPONENT_TEXT.viewportIndependent) : VIEWPORT_PROFILE_CATALOG[event.viewport].label,
    event.method === null ? none() : renderCode(event.method),
    event.url === null ? none() : renderUrlAsText(event.url),
    event.candidateId === null ? none() : renderCode(event.candidateId),
    safetyEventReasonCell(event),
    evidenceRef(event.evidenceId, event.location),
  ]);
}

/**
 * T44R2 の M-7: Safety の事象の理由の欄（コード）。止めた要求の行は、止め方が理由ごとに違う（読み取りでない送信、上限、離れた後の上限は GET も止める）ので、
 * 理由の説明（`describeBlockedRequestReason`）を添える。
 */
function safetyEventReasonCell(event: SafetyEventView): Fragment {
  const description = event.kind === 'blockedRequests' ? describeBlockedRequestReason(event.reason) : null;
  return description === null ? renderCode(event.reason) : joinWithSpace([renderCode(event.reason), htmlText(description)]);
}

function renderSafety(context: RenderContext, viewModel: ReportViewModel, level: SectionHeadingLevel): readonly Fragment[] {
  const text = HTML_REPORT_TEXT.safety;
  const { safety } = viewModel;
  const blocked = safety.blockedActions;
  const { auditSend } = viewModel.summary;
  return [
    // AS-b: 通したことの知らせ（目立つ形）と、扱い・通した数。値は表示用モデルの `summary.auditSend` のまま。OP-3: method ごとの数は記録の段。
    ...auditSendNotice(auditSend),
    renderKeyValueList([
      { label: AUDIT_SEND_TEXT.label, value: auditSendPlainValue(auditSend) },
      ...(auditSend.prominent
        ? [
          { label: AUDIT_SEND_TEXT.passedCount, value: formatCount(auditSend.passedRequests) },
          // AS-c: ほかの Origin へ通した送信と、通した WebSocket の接続。
          { label: AUDIT_SEND_TEXT.passedOtherOrigins, value: formatCount(auditSend.passedOtherOriginRequests) },
          { label: AUDIT_SEND_TEXT.passedWebSockets, value: formatCount(auditSend.passedWebSockets) },
          // AS-c fix round 1: そのうち Guard の判定を通らずに開いた接続と、危険な語の接続。
          { label: AUDIT_SEND_TEXT.passedWebSocketsOutsideGuard, value: formatCount(auditSend.passedWebSocketsOutsideGuard) },
          { label: AUDIT_SEND_TEXT.passedDangerousWebSockets, value: formatCount(auditSend.passedDangerousWebSockets) },
        ]
        : []),
    ]),
    renderKeyValueList([
      { label: text.guard, value: safety.guardEnabled ? text.guardEnabled : text.guardDisabled },
      { label: text.excludedInteractionCandidates, value: formatCount(safety.excludedInteractionCandidateCount) },
      { label: text.invariantViolationCount, value: formatCount(safety.invariantViolationCount) },
      { label: text.record, value: safety.recordTruncated ? text.recordTruncated : text.recordComplete },
    ]),
    subsection(level, text.blockedActionsHeading, SAFETY_ANCHORS.blockedActions, [
      ...(safety.recordTruncated ? [renderParagraph(text.lowerBoundNote)] : []),
      renderKeyValueList([
        { label: text.blockedActions.requests, value: formatCount(blocked.requests) },
        { label: text.blockedActions.navigations, value: formatCount(blocked.navigations) },
        { label: text.blockedActions.externalActions, value: formatCount(blocked.externalActions) },
        { label: text.blockedActions.popups, value: formatCount(blocked.popups) },
        { label: text.blockedActions.downloads, value: formatCount(blocked.downloads) },
        { label: text.blockedActions.webSockets, value: formatCount(blocked.webSockets) },
      ]),
    ]),
  ];
}

/**
 * OP-3（PL 14 章）: 記録の段の、安全の技術の記録（通した送信と止めた要求の送り方ごとの数、安全の決まりに反したことの記号、安全のために止めたことの一覧）。
 * 本文の安全の節から移した（中身は変えない）。
 */
function renderSafetyRecord(context: RenderContext, viewModel: ReportViewModel, level: SectionHeadingLevel): Fragment {
  const text = HTML_REPORT_TEXT.safety;
  const { safety } = viewModel;
  const { auditSend } = viewModel.summary;
  const subLevel = (level + 1) as SectionHeadingLevel;
  return subsection(level, HTML_REPORT_TEXT.record.safetyHeading, SUMMARY_ANCHORS.safety, [
    ...(auditSend.prominent
      ? [tableOrNone(
        AUDIT_SEND_TEXT.methodsCaption,
        AUDIT_SEND_TEXT.methodColumns,
        Object.entries(auditSend.passedRequestsByMethod).map(([method, count]) => renderTableRow([renderCode(method), formatCount(count)])),
      )]
      : []),
    tableOrNone(
      text.methodsCaption,
      text.methodColumns,
      Object.entries(safety.blockedRequestsByMethod).map(([method, count]) => renderTableRow([renderCode(method), formatCount(count)])),
    ),
    tableOrNone(
      text.violationsCaption,
      text.violationColumns,
      safety.invariantViolations.map((violation) => renderTableRow([renderCode(violation.code), renderCode(violation.message)])),
    ),
    subsection(subLevel, text.eventsHeading, SAFETY_ANCHORS.events, [
      renderParagraph(text.eventsNote),
      ...(safety.recordTruncated ? [renderParagraph(text.eventsTruncatedNote)] : []),
      tableOrNone(
        null,
        text.eventColumns,
        safety.events.map((event) => safetyEventRow(context, event)),
      ),
    ]),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// 節6: ページの一覧
// ---------------------------------------------------------------------------------------------------------------

/** OP-3: やさしい語の理由の一覧（説明と次にできることだけ。コードと詳細は記録の段）。 */
const plainReasonList = (reasons: readonly ReasonView[]): Fragment => renderReferenceList(reasons.map(overviewReasonText));

/** 本文の、画面の幅ごとの状態の行（OP-3: 返事の番号と開いた結果のコードは、記録の段の `viewportRecordRow`）。 */
function viewportRow(context: RenderContext, view: ViewportView): SafeHtml<'row'> {
  return renderTableRow([
    VIEWPORT_PROFILE_CATALOG[view.viewport].label,
    renderPageAuditStatusBadge(view.status),
    renderUrl(view.requestedUrl, context.allowedOrigins),
    view.finalUrl === null ? formatNotObserved() : renderUrl(view.finalUrl, context.allowedOrigins),
    view.incompleteReasons.length === 0 ? none() : plainReasonList(view.incompleteReasons),
  ]);
}

/** OP-3: 記録の段の、画面の幅ごとの技術の記録の行（ページの番号、画面の幅、返事の番号、開いた結果のコード）。 */
function viewportRecordRow(page: PageView, view: ViewportView): SafeHtml<'row'> {
  return renderTableRow([
    renderCode(page.pageId),
    VIEWPORT_PROFILE_CATALOG[view.viewport].label,
    formatInteger(view.httpStatus),
    observedCode(view.navigationOutcome),
    view.incompleteReasons.length === 0 ? none() : reasonList(view.incompleteReasons),
  ]);
}

function retryRow(attempt: RetryAttemptView): SafeHtml<'row'> {
  return renderTableRow([
    retryAttemptText(attempt.attempt),
    renderCode(attempt.navigationOutcome),
    attempt.detail === null ? none() : renderCode(attempt.detail),
    renderReferenceList(
      attempt.evidence.map((location) =>
        joinWithSpace([
          evidenceRef(location.evidenceId, location),
          htmlText(EVIDENCE_TYPE_CATALOG[location.type].label),
          location.viewport === null ? null : htmlText(VIEWPORT_PROFILE_CATALOG[location.viewport].label),
        ]),
      ),
    ),
    renderReferenceList(attempt.screenshots.map((screenshot) => renderScreenshotRef(screenshot))),
  ]);
}

/**
 * 本文のページの節（OP-3: 見出しは何番目のページか。ページの番号、ファイル、返事の番号、開いた結果のコード、やり直す前の記録は、記録の段の
 * `renderPagesRecord`）。アンカーは今どおりページの番号から作る（本文と記録の段のリンクの先）。
 */
function renderPage(context: RenderContext, view: PageView, index: number, level: SectionHeadingLevel): Fragment {
  const text = HTML_REPORT_TEXT.pages;
  const subLevel = (level + 1) as SectionHeadingLevel;
  return subsection(level, text.heading(formatInteger(index + 1)), pageAnchorOf(view.pageId), [
    renderKeyValueList([
      { label: text.url, value: renderUrl(view.pageUrl, context.allowedOrigins) },
      { label: text.status, value: renderPageAuditStatusBadge(view.status) },
      { label: HTML_REPORT_TEXT.findingCount, value: formatCount(view.findingCounts.total) },
      { label: text.reasons, value: view.incompleteReasons.length === 0 ? none() : plainReasonList(view.incompleteReasons) },
    ]),
    subsection(subLevel, text.viewportsHeading, toAnchorId('page-viewports', view.pageId), [
      renderTable({ caption: null, columns: text.plainViewportColumns, rows: view.viewports.map((viewport) => viewportRow(context, viewport)) }),
    ]),
    subsection(subLevel, text.screenshotsHeading, toAnchorId('page-screenshots', view.pageId), [
      renderReferenceList(view.screenshots.map((screenshot) => renderScreenshotRef(screenshot, { withEvidenceId: false }))),
    ]),
    subsection(subLevel, text.findingsHeading, toAnchorId('page-findings', view.pageId), [findingLinkList(view.findings)]),
  ]);
}

/**
 * OP-3: 記録の段の、ページの技術の記録（ページごとの番号とファイル、画面の幅ごとの返事の番号と開いた結果、やり直す前の記録）。本文のページの節から移した
 * （値は表示用モデルのまま）。
 */
function renderPagesRecord(context: RenderContext, viewModel: ReportViewModel, level: SectionHeadingLevel): Fragment {
  const text = HTML_REPORT_TEXT.record;
  const subLevel = (level + 1) as SectionHeadingLevel;
  return subsection(level, text.pagesHeading, SUMMARY_ANCHORS.pages, [
    tableOrNone(null, text.pageColumns, viewModel.pages.map((view) => renderTableRow([
      joinWithSpace([renderUrl(view.pageUrl, context.allowedOrigins), pageLink(context, view.pageId)]),
      renderCode(view.pageId),
      renderFileLink(view.pageJsonPath),
      view.visibleTextPath === null ? none() : renderFileLink(view.visibleTextPath),
      view.incompleteReasons.length === 0 ? none() : reasonList(view.incompleteReasons),
    ]))),
    tableOrNone(null, text.viewportColumns, viewModel.pages.flatMap((view) => view.viewports.map((viewport) => viewportRecordRow(view, viewport)))),
    ...viewModel.pages.flatMap((view) => (view.retryAttempts.length === 0
      ? []
      : [
          subsection(subLevel, text.retriesCaption(view.pageId), toAnchorId('page-retries', view.pageId), [
            renderParagraph(HTML_REPORT_TEXT.pages.retriesNote),
            renderTable({ caption: null, columns: HTML_REPORT_TEXT.pages.retryColumns, rows: view.retryAttempts.map(retryRow) }),
          ]),
        ])),
  ]);
}

/** OP-3: 記録の段の、Finding と押して確かめた操作の技術の記録（本文の表から移した、規則と証拠、理由のコードと証拠）。 */
function renderFindingsRecord(context: RenderContext, viewModel: ReportViewModel, level: SectionHeadingLevel): readonly Fragment[] {
  const text = HTML_REPORT_TEXT.record;
  const findings = viewModel.categorySections.flatMap((section) => section.findings);
  return [
    subsection(level, text.findingsHeading, SUMMARY_ANCHORS.findings, [
      renderParagraph(text.findingsNote),
      tableOrNone(null, text.findingColumns, findings.map(findingRecordRow)),
    ]),
    subsection(level, text.interactionsHeading, SUMMARY_ANCHORS.interactions, [
      tableOrNone(null, text.interactionColumns, viewModel.interactions.items.map((item) => interactionRecordRow(context, item))),
    ]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 文書
// ---------------------------------------------------------------------------------------------------------------

/** 節の見出しの階層（`<h1>` は文書の題）。 */
const SECTION_LEVEL: SectionHeadingLevel = 2;
const SUBSECTION_LEVEL: SectionHeadingLevel = 3;

/** 節ごとの中身（`Record` なので、節を1つ加えると、ここの書き漏れが型のエラーになる）。 */
const SECTION_RENDERERS: Readonly<Record<ReportSection, (context: RenderContext, viewModel: ReportViewModel) => readonly Fragment[]>> =
  Object.freeze({
    // PL-R: 冒頭のまとめの段と、末尾の記録の段（前の要約の節。中身は変えずに移した）。
    OVERVIEW: (context, viewModel) => renderOverview(context, viewModel, SUBSECTION_LEVEL),
    // OP-3（PL 14 章）: 本文から移した技術の記録（問題、押して確かめた操作、安全、ページ）も、記録の段の終わりに置く。
    RECORD: (context, viewModel) => [
      ...renderSummary(viewModel.summary, SUBSECTION_LEVEL),
      ...renderFindingsRecord(context, viewModel, SUBSECTION_LEVEL),
      renderSafetyRecord(context, viewModel, SUBSECTION_LEVEL),
      renderPagesRecord(context, viewModel, SUBSECTION_LEVEL),
    ],
    // T44f（Task 44 の設計書 P3-1 の D）: 行を出し直さず、分類ごとの節の行へのリンクの一覧にする。
    CRITICAL_FINDINGS: (_context, viewModel) => [findingLinksOrNone(viewModel.criticalFindings)],
    CATEGORY_FINDINGS: (context, viewModel) =>
      viewModel.categorySections.map((section) => renderCategorySection(context, section, SUBSECTION_LEVEL)),
    INTERACTIONS: (context, viewModel) => renderInteractions(context, viewModel, SUBSECTION_LEVEL),
    SAFETY: (context, viewModel) => renderSafety(context, viewModel, SUBSECTION_LEVEL),
    PAGES: (context, viewModel) =>
      viewModel.pages.length === 0
        ? [renderParagraph(HTML_REPORT_TEXT.pages.noPages)]
        : viewModel.pages.map((view, index) => renderPage(context, view, index, SUBSECTION_LEVEL)),
  });

function createContext(viewModel: ReportViewModel): RenderContext {
  const pageAnchors = new Map<PageId, string>();
  for (const view of viewModel.pages) {
    if (!pageAnchors.has(view.pageId)) {
      pageAnchors.set(view.pageId, pageAnchorOf(view.pageId));
    }
  }
  return { allowedOrigins: viewModel.summary.allowedOrigins, pageAnchors };
}

/**
 * 表示用モデルから、日本語の静的な HTML レポート（`report.html` の中身）を描く。改行は LF。ファイルは書かない。
 * 節は、設計書 6.1.4 の順（`REPORT_SECTION_CATALOG` の表示の順）に並べる。
 */
export function renderHtmlReport(viewModel: ReportViewModel): string {
  const context = createContext(viewModel);
  const sections = sortByDisplayOrder(REPORT_SECTIONS, REPORT_SECTION_CATALOG).map((section) => {
    const spec = REPORT_SECTION_CATALOG[section];
    return renderSection({
      level: SECTION_LEVEL,
      label: spec.label,
      anchorId: spec.anchor,
      content: [...(spec.description === null ? [] : [renderParagraph(spec.description)]), ...SECTION_RENDERERS[section](context, viewModel)],
    });
  });
  return renderDocument({ title: HTML_REPORT_TEXT.title, content: sections });
}
