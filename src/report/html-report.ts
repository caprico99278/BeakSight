/**
 * HTML レポート（Task 14〜17 の設計書 6.1.4、6.1.5、6.1.6、6.1.9。UI追補設計書 第3章、第4章）。
 * - 入力は、表示用モデル（`buildReportViewModel` の結果）だけ。判定や集計はしない。件数は、表示用モデルの値をそのまま使う（GATE-UI04）。
 * - 節と順は、設計書 6.1.4 のとおり（要約、重大な指摘、category ごとの節、Interaction、Safety、ページの一覧）。節の名前と順と
 *   アンカーは、表示カタログ（`REPORT_SECTION_CATALOG`、`REPORT_CATEGORY_SECTION_CATALOG`）から取る。
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
import { INTERACTION_STATUSES, SEVERITIES, VIEWPORT_PROFILES, type EvidenceId, type PageId } from '../core/contracts.js';
import { INTERACTION_NOT_VERIFIABLE_KINDS } from '../core/evidence-types.js';
import {
  EVIDENCE_TYPE_CATALOG,
  INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  INTERACTION_STATUS_CATALOG,
  REPORT_CATEGORY_SECTION_CATALOG,
  REPORT_SECTION_CATALOG,
  REPORT_SECTIONS,
  RUN_STATUS_CATALOG,
  SAFETY_EVENT_KIND_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  SEVERITY_GROUPS,
  VIEWPORT_PROFILE_CATALOG,
  sortByDisplayOrder,
  type ReportSection,
} from '../presentation/catalog.js';
import { formatCount, formatDateTime, formatDuration, formatInteger, formatNotObserved } from '../presentation/format.js';
import {
  HTML_REPORT_TEXT,
  REPORT_COMPONENT_TEXT,
  RUN_SUMMARY_TEXT,
  earlierAttemptRecordText,
  retryAttemptText,
  severityGroupTotalText,
  userAgentLabelText,
} from '../presentation/messages.js';
import {
  htmlText,
  joinHtml,
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
  PageView,
  ReasonView,
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

/** 要約の小見出しのアンカー。 */
const SUMMARY_ANCHORS = Object.freeze({
  run: toAnchorId('summary', 'run'),
  coverage: toAnchorId('summary', 'coverage'),
  counts: toAnchorId('summary', 'counts'),
  limits: toAnchorId('summary', 'limits'),
  reasons: toAnchorId('summary', 'reasons'),
  environment: toAnchorId('summary', 'environment'),
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
  htmlText(reason.description),
  reason.detail === null ? null : renderCode(reason.detail),
];

/** 1つの理由を、コード、説明、詳細の順に空白でつないだもの（詳細がなければ、コードと説明だけ）。 */
const reasonText = (reason: ReasonView<string>): Fragment => joinWithSpace(reasonParts(reason));

const reasonTable = (reasons: readonly ReasonView[]): Fragment =>
  tableOrNone(
    null,
    HTML_REPORT_TEXT.reasonColumns,
    reasons.map((reason) => {
      const [code, description, detail] = reasonParts(reason);
      return renderTableRow([code, description, detail ?? none()]);
    }),
  );

const reasonList = (reasons: readonly ReasonView[]): Fragment => renderReferenceList(reasons.map(reasonText));

// ---------------------------------------------------------------------------------------------------------------
// Finding
// ---------------------------------------------------------------------------------------------------------------

/**
 * Finding の行。`anchored` が偽の行には `id` を付けない（同じ Finding を2回示すため。アンカーは category の節の行に付ける。
 * すべての Finding は、どれか1つの category の節に入る）。
 */
const findingRow = (context: RenderContext, view: FindingView, anchored: boolean): SafeHtml<'row'> =>
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
    anchored,
  });

const findingTableOrNone = (context: RenderContext, findings: readonly FindingView[], anchored: boolean): Fragment =>
  findings.length === 0
    ? renderParagraph(HTML_REPORT_TEXT.noFindings)
    : renderFindingTable({ caption: null, rows: findings.map((view) => findingRow(context, view, anchored)) });

// ---------------------------------------------------------------------------------------------------------------
// 節1: 要約
// ---------------------------------------------------------------------------------------------------------------

const reachedText = (reached: boolean): string => (reached ? HTML_REPORT_TEXT.summary.reached : HTML_REPORT_TEXT.summary.notReached);

function renderSummary(summary: RunSummaryView, level: SectionHeadingLevel): readonly Fragment[] {
  const text = HTML_REPORT_TEXT.summary;
  const counts = summary.findingCounts;
  const { environment } = summary;
  const viewports = sortByDisplayOrder(VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG);
  return [
    subsection(level, text.runHeading, SUMMARY_ANCHORS.run, [
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
        { label: text.toolVersion, value: renderCode(summary.toolVersion) },
      ]),
    ]),
    subsection(level, RUN_SUMMARY_TEXT.coverageHeading, SUMMARY_ANCHORS.coverage, [
      renderKeyValueList([
        { label: RUN_SUMMARY_TEXT.coverage.discovered, value: formatCount(summary.coverage.discovered) },
        { label: RUN_SUMMARY_TEXT.coverage.audited, value: formatCount(summary.coverage.audited) },
        { label: RUN_SUMMARY_TEXT.coverage.partial, value: formatCount(summary.coverage.partial) },
        { label: RUN_SUMMARY_TEXT.coverage.failed, value: formatCount(summary.coverage.failed) },
        { label: RUN_SUMMARY_TEXT.coverage.skipped, value: formatCount(summary.coverage.skipped) },
      ]),
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
    subsection(level, RUN_SUMMARY_TEXT.reasonsHeading, SUMMARY_ANCHORS.reasons, [reasonTable(summary.incompleteReasons)]),
    subsection(level, text.environmentHeading, SUMMARY_ANCHORS.environment, [
      renderKeyValueList([
        { label: text.environment.nodeVersion, value: renderCode(environment.nodeVersion) },
        { label: text.environment.platform, value: renderCode(environment.platform) },
        { label: text.environment.osRelease, value: renderCode(environment.osRelease) },
        { label: text.environment.arch, value: renderCode(environment.arch) },
        { label: text.environment.playwrightVersion, value: renderCode(environment.playwrightVersion) },
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
// 節2・3: 重大な指摘、category ごとの節
// ---------------------------------------------------------------------------------------------------------------

function renderCategorySection(context: RenderContext, view: FindingSectionView, level: SectionHeadingLevel): Fragment {
  const spec = REPORT_CATEGORY_SECTION_CATALOG[view.section];
  return subsection(level, spec.label, spec.anchor, [
    ...(spec.description === null ? [] : [renderParagraph(spec.description)]),
    renderKeyValueList([{ label: HTML_REPORT_TEXT.findingCount, value: formatCount(view.counts.total) }]),
    findingTableOrNone(context, view.findings, true),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------
// 節4: Interaction
// ---------------------------------------------------------------------------------------------------------------

function interactionRow(context: RenderContext, item: InteractionView): SafeHtml<'row'> {
  const target =
    item.target === null
      ? htmlText(formatNotObserved())
      : joinWithSpace([
          renderCode(item.target.tagName),
          item.target.role === null ? null : renderCode(item.target.role),
          item.target.accessibleName === '' ? null : htmlText(item.target.accessibleName),
        ]);
  return renderTableRow([
    joinWithSpace([renderUrl(item.pageUrl, context.allowedOrigins), pageLink(context, item.pageId)]),
    item.viewport === null ? renderMutedText(REPORT_COMPONENT_TEXT.viewportIndependent) : VIEWPORT_PROFILE_CATALOG[item.viewport].label,
    target,
    renderInteractionStatusBadge(item.status),
    item.notVerifiableKind === null ? none() : renderNotVerifiableKindBadge(item.notVerifiableKind),
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
        : renderTable({ caption: null, columns: text.columns, rows: interactions.items.map((item) => interactionRow(context, item)) }),
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
    renderCode(event.reason),
    evidenceRef(event.evidenceId, event.location),
  ]);
}

function renderSafety(context: RenderContext, viewModel: ReportViewModel, level: SectionHeadingLevel): readonly Fragment[] {
  const text = HTML_REPORT_TEXT.safety;
  const { safety } = viewModel;
  const blocked = safety.blockedActions;
  return [
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
      tableOrNone(
        text.methodsCaption,
        text.methodColumns,
        Object.entries(safety.blockedRequestsByMethod).map(([method, count]) => renderTableRow([renderCode(method), formatCount(count)])),
      ),
    ]),
    tableOrNone(
      text.violationsCaption,
      text.violationColumns,
      safety.invariantViolations.map((violation) => renderTableRow([renderCode(violation.code), renderCode(violation.message)])),
    ),
    subsection(level, text.eventsHeading, SAFETY_ANCHORS.events, [
      renderParagraph(text.eventsNote),
      ...(safety.recordTruncated ? [renderParagraph(text.eventsTruncatedNote)] : []),
      tableOrNone(
        null,
        text.eventColumns,
        safety.events.map((event) => safetyEventRow(context, event)),
      ),
    ]),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// 節6: ページの一覧
// ---------------------------------------------------------------------------------------------------------------

function viewportRow(context: RenderContext, view: ViewportView): SafeHtml<'row'> {
  return renderTableRow([
    VIEWPORT_PROFILE_CATALOG[view.viewport].label,
    renderPageAuditStatusBadge(view.status),
    renderUrl(view.requestedUrl, context.allowedOrigins),
    view.finalUrl === null ? formatNotObserved() : renderUrl(view.finalUrl, context.allowedOrigins),
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

function renderPage(context: RenderContext, view: PageView, level: SectionHeadingLevel): Fragment {
  const text = HTML_REPORT_TEXT.pages;
  const subLevel = (level + 1) as SectionHeadingLevel;
  return subsection(level, view.pageId, pageAnchorOf(view.pageId), [
    renderKeyValueList([
      { label: text.url, value: renderUrl(view.pageUrl, context.allowedOrigins) },
      { label: text.status, value: renderPageAuditStatusBadge(view.status) },
      { label: text.pageJson, value: renderFileLink(view.pageJsonPath) },
      { label: text.visibleText, value: view.visibleTextPath === null ? none() : renderFileLink(view.visibleTextPath) },
      { label: HTML_REPORT_TEXT.findingCount, value: formatCount(view.findingCounts.total) },
      { label: text.reasons, value: view.incompleteReasons.length === 0 ? none() : reasonList(view.incompleteReasons) },
    ]),
    subsection(subLevel, text.viewportsHeading, toAnchorId('page-viewports', view.pageId), [
      renderTable({ caption: null, columns: text.viewportColumns, rows: view.viewports.map((viewport) => viewportRow(context, viewport)) }),
    ]),
    subsection(subLevel, text.screenshotsHeading, toAnchorId('page-screenshots', view.pageId), [
      renderReferenceList(view.screenshots.map((screenshot) => renderScreenshotRef(screenshot))),
    ]),
    subsection(subLevel, text.findingsHeading, toAnchorId('page-findings', view.pageId), [
      renderReferenceList(
        view.findings.map(({ finding }) =>
          joinWithSpace([
            renderSeverityBadge(finding.severity),
            renderInternalLink(finding.findingId, toAnchorId('finding', finding.findingId)),
            htmlText(finding.message),
          ]),
        ),
      ),
    ]),
    ...(view.retryAttempts.length === 0
      ? []
      : [
          subsection(subLevel, text.retriesHeading, toAnchorId('page-retries', view.pageId), [
            renderParagraph(text.retriesNote),
            renderTable({ caption: null, columns: text.retryColumns, rows: view.retryAttempts.map(retryRow) }),
          ]),
        ]),
  ]);
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
    SUMMARY: (_context, viewModel) => renderSummary(viewModel.summary, SUBSECTION_LEVEL),
    CRITICAL_FINDINGS: (context, viewModel) => [findingTableOrNone(context, viewModel.criticalFindings, false)],
    CATEGORY_FINDINGS: (context, viewModel) =>
      viewModel.categorySections.map((section) => renderCategorySection(context, section, SUBSECTION_LEVEL)),
    INTERACTIONS: (context, viewModel) => renderInteractions(context, viewModel, SUBSECTION_LEVEL),
    SAFETY: (context, viewModel) => renderSafety(context, viewModel, SUBSECTION_LEVEL),
    PAGES: (context, viewModel) =>
      viewModel.pages.length === 0
        ? [renderParagraph(HTML_REPORT_TEXT.pages.noPages)]
        : viewModel.pages.map((view) => renderPage(context, view, SUBSECTION_LEVEL)),
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
