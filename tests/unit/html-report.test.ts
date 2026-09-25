/**
 * HTML レポート（`renderHtmlReport`。Task 14〜17 の設計書 6.1.4、6.1.6、6.1.9。実装計画 Task 16 の Step 3・4）のテスト。
 * 見本の Run は、`tests/helpers/audit-run-fixture.ts`（C16b）で作る。
 */
import { describe, expect, it } from 'vitest';
import { SEVERITIES, VIEWPORT_PROFILES, type AuditRunResult } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  INTERACTION_NOT_VERIFIABLE_KIND_CATALOG,
  INTERACTION_STATUS_CATALOG,
  REPORT_CATEGORY_SECTION_CATALOG,
  REPORT_CATEGORY_SECTIONS,
  REPORT_SECTION_CATALOG,
  REPORT_SECTIONS,
  RUN_STATUS_CATALOG,
  SAFETY_EVENT_KIND_CATALOG,
  SEVERITY_CATALOG,
  SEVERITY_GROUP_CATALOG,
  VIEWPORT_PROFILE_CATALOG,
  sortByDisplayOrder,
} from '../../src/presentation/catalog.js';
import { formatCount, formatInteger, formatNotObserved } from '../../src/presentation/format.js';
import {
  HTML_REPORT_TEXT,
  REPORT_COMPONENT_TEXT,
  RUN_SUMMARY_TEXT,
  describeInteractionReason,
  earlierAttemptRecordText,
  ruleVersionText,
} from '../../src/presentation/messages.js';
import { escapeHtml, renderCode, renderEvidenceRef, renderSeverityBadge } from '../../src/report/html-components.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { buildReportViewModel, type ReportViewModel } from '../../src/report/view-model.js';
import {
  HOSTILE_STRINGS,
  HOSTILE_TEXT,
  PAGE_1,
  PAGE_2,
  SPECIAL_SCHEME_URLS,
  auditRun,
  edgeCaseAuditRun,
  fixtureUrl,
  httpSafetyEventSamples,
  interaction,
  page,
  retry,
  runSummary,
  safety,
  safetyEventSamples,
} from '../helpers/audit-run-fixture.js';

const render = (result: AuditRunResult): string => renderHtmlReport(buildReportViewModel(result));

/** 項目と値の一覧（`renderKeyValueList`）の1項目。 */
const keyValue = (label: string, valueHtml: string): string => `<dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd>`;

/** `id="…"` の値の一覧（出現の順）。 */
const idsOf = (html: string): string[] => [...html.matchAll(/\sid="([^"]*)"/gu)].map((match) => match[1] ?? '');

/** 文書の中へのリンク（`href="#…"`）の先の一覧。 */
const fragmentTargetsOf = (html: string): string[] => [...html.matchAll(/\shref="#([^"]*)"/gu)].map((match) => match[1] ?? '');

/** `id` の属性を持つ要素の開始の位置（なければ -1）。 */
const positionOfId = (html: string, id: string): number => html.indexOf(` id="${id}"`);

/** `startId` の要素から、`endId` の要素（なければ文書の終わり）までの部分。 */
const sliceBetween = (html: string, startId: string, endId: string | null): string => {
  const start = positionOfId(html, startId);
  expect(start, startId).toBeGreaterThanOrEqual(0);
  const end = endId === null ? html.length : positionOfId(html, endId);
  expect(end, endId ?? 'end').toBeGreaterThan(start);
  return html.slice(start, end);
};

const sectionAnchors = sortByDisplayOrder(REPORT_SECTIONS, REPORT_SECTION_CATALOG).map((section) => REPORT_SECTION_CATALOG[section].anchor);

describe('renderHtmlReport: document', () => {
  it('is a Japanese static document with the single stylesheet and no style attribute or script', () => {
    const html = render(auditRun());
    expect(html.startsWith('<!DOCTYPE html>\n<html lang="ja">')).toBe(true);
    expect(html.match(/<style/gu)?.length).toBe(1);
    expect(html).not.toMatch(/\sstyle=/iu);
    expect(html).not.toContain('<script');
    expect(html).toContain(`<title>${escapeHtml(HTML_REPORT_TEXT.title)}</title>`);
  });

  it('is deterministic: the same input gives the same string', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    expect(renderHtmlReport(viewModel)).toBe(renderHtmlReport(viewModel));
    expect(render(edgeCaseAuditRun())).toBe(render(edgeCaseAuditRun()));
  });
});

describe('renderHtmlReport: sections (design 6.1.4)', () => {
  it('has the six sections in the order of the design, each as a level-2 heading', () => {
    const html = render(edgeCaseAuditRun());
    expect(sectionAnchors).toEqual(['summary', 'critical-findings', 'findings-by-category', 'interactions', 'safety', 'pages']);
    const positions = sectionAnchors.map((anchor) => html.indexOf(`<h2 id="${anchor}">`));
    for (const [index, position] of positions.entries()) {
      expect(position, sectionAnchors[index]).toBeGreaterThanOrEqual(0);
    }
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(html.match(/<h2 /gu)?.length).toBe(sectionAnchors.length);
    for (const section of REPORT_SECTIONS) {
      expect(html).toContain(`>${escapeHtml(REPORT_SECTION_CATALOG[section].label)}</h2>`);
    }
  });

  it('puts every category section, in the catalog order, inside the category section', () => {
    const html = render(edgeCaseAuditRun());
    const categoryPart = sliceBetween(html, 'findings-by-category', 'interactions');
    const anchors = sortByDisplayOrder(REPORT_CATEGORY_SECTIONS, REPORT_CATEGORY_SECTION_CATALOG).map(
      (section) => REPORT_CATEGORY_SECTION_CATALOG[section].anchor,
    );
    const positions = anchors.map((anchor) => categoryPart.indexOf(`<h3 id="${anchor}">`));
    for (const [index, position] of positions.entries()) {
      expect(position, anchors[index]).toBeGreaterThanOrEqual(0);
    }
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    for (const section of REPORT_CATEGORY_SECTIONS) {
      expect(categoryPart).toContain(`>${escapeHtml(REPORT_CATEGORY_SECTION_CATALOG[section].label)}</h3>`);
    }
  });

  it('lists only the critical findings (criticalSection) in the critical section', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const html = renderHtmlReport(viewModel);
    const criticalPart = sliceBetween(html, 'critical-findings', 'findings-by-category');
    expect(viewModel.criticalFindings.length).toBeGreaterThan(0);
    for (const view of viewModel.findings) {
      const expected = viewModel.criticalFindings.includes(view);
      expect(criticalPart.includes(escapeHtml(view.finding.message)), view.finding.findingId).toBe(expected);
    }
  });

  it('says that there is no finding in a section without findings', () => {
    const html = render(auditRun());
    const criticalPart = sliceBetween(html, 'critical-findings', 'findings-by-category');
    expect(criticalPart).toContain(escapeHtml(HTML_REPORT_TEXT.noFindings));
    expect(criticalPart).not.toContain('<table');
  });
});

describe('renderHtmlReport: contents (plan Task 16 Step 4)', () => {
  it('shows the Run Status with its Japanese label', () => {
    const html = render(edgeCaseAuditRun());
    const summary = sliceBetween(html, 'summary', 'critical-findings');
    expect(summary).toContain('data-value="PARTIAL"');
    expect(summary).toContain(escapeHtml(RUN_STATUS_CATALOG.PARTIAL.label));
  });

  it('shows the page coverage from the view model', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const summary = sliceBetween(renderHtmlReport(viewModel), 'summary', 'critical-findings');
    const { coverage } = viewModel.summary;
    const labels = RUN_SUMMARY_TEXT.coverage;
    expect(summary).toContain(keyValue(labels.discovered, formatCount(coverage.discovered)));
    expect(summary).toContain(keyValue(labels.audited, formatCount(coverage.audited)));
    expect(summary).toContain(keyValue(labels.partial, formatCount(coverage.partial)));
    expect(summary).toContain(keyValue(labels.failed, formatCount(coverage.failed)));
    expect(summary).toContain(keyValue(labels.skipped, formatCount(coverage.skipped)));
  });

  it('shows the ERROR, WARN, INFO and SAFETY counts with their group, and the group totals', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const summary = sliceBetween(renderHtmlReport(viewModel), 'summary', 'critical-findings');
    const counts = viewModel.summary.findingCounts;
    expect(counts.bySeverity).toEqual({ ERROR: 1, WARN: 2, INFO: 2, SAFETY: 1 });
    for (const severity of SEVERITIES) {
      const group = SEVERITY_GROUP_CATALOG[SEVERITY_CATALOG[severity].group].label;
      expect(summary, severity).toContain(
        `<tr><td>${escapeHtml(group)}</td><td>${renderSeverityBadge(severity).html}</td><td>${formatCount(counts.bySeverity[severity])}</td></tr>`,
      );
    }
    expect(summary).toContain(formatCount(counts.byGroup.SITE_QUALITY));
    expect(summary).toContain(keyValue(HTML_REPORT_TEXT.summary.totalFindings, formatCount(counts.total)));
  });

  it('uses the counts of the view model as they are (does not count again)', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const altered: ReportViewModel = {
      ...viewModel,
      summary: {
        ...viewModel.summary,
        findingCounts: { total: 9876, bySeverity: { ERROR: 4321, WARN: 0, INFO: 0, SAFETY: 0 }, byGroup: { SITE_QUALITY: 4321, SAFETY: 0 } },
        coverage: { ...viewModel.summary.coverage, discovered: 777 },
      },
    };
    const summary = sliceBetween(renderHtmlReport(altered), 'summary', 'critical-findings');
    expect(summary).toContain(formatCount(4321));
    expect(summary).toContain(keyValue(HTML_REPORT_TEXT.summary.totalFindings, formatCount(9876)));
    expect(summary).toContain(keyValue(RUN_SUMMARY_TEXT.coverage.discovered, formatCount(777)));
  });

  it('shows the limits and the incomplete reasons with their code, description and detail', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const summary = sliceBetween(renderHtmlReport(viewModel), 'summary', 'critical-findings');
    for (const label of Object.values(HTML_REPORT_TEXT.summary.limits)) {
      expect(summary).toContain(escapeHtml(label));
    }
    const [reason] = viewModel.summary.incompleteReasons;
    expect(reason).toBeDefined();
    expect(summary).toContain(reason!.code);
    expect(summary).toContain(escapeHtml(reason!.description));
    expect(summary).toContain(escapeHtml(reason!.detail!));
  });

  it('shows each finding with its message as written by the rule, rule ID and version, viewport, Evidence and screenshots', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const html = renderHtmlReport(viewModel);
    const categoryPart = sliceBetween(html, 'findings-by-category', 'interactions');
    for (const view of viewModel.findings) {
      const { finding } = view;
      expect(categoryPart).toContain(escapeHtml(finding.message));
      expect(categoryPart).toContain(escapeHtml(finding.ruleId));
      for (const reference of view.evidence) {
        expect(categoryPart).toContain(reference.evidenceId);
        expect(reference.location).not.toBeNull();
        expect(categoryPart).toContain(`href="${reference.location!.path}"`);
        expect(categoryPart).toContain(escapeHtml(reference.location!.pointer));
      }
      for (const screenshot of view.screenshots) {
        expect(categoryPart).toContain(`href="${screenshot.relativePath}"`);
      }
    }
    expect(categoryPart).toContain(escapeHtml(ruleVersionText(1)));
    expect(categoryPart).toContain(escapeHtml(VIEWPORT_PROFILE_CATALOG.desktop.label));
    // Finding が参照するスクリーンショット（直接と、同じページ・同じビューポート）へのリンクがある。
    expect(categoryPart).toContain('href="pages/PAGE-000001/desktop/viewport.png"');
    expect(categoryPart).toContain('href="pages/PAGE-000002/desktop/viewport.png"');
  });

  it('links each finding to its page in the page list', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const html = renderHtmlReport(viewModel);
    const findingRow = sliceBetween(html, 'finding-FIND-000005', null).split('</tr>')[0] ?? '';
    expect(findingRow).toContain('href="#page-PAGE-000002"');
  });

  it('shows the interactions with the Japanese status and not-verifiable kind, and the reason with its description and escaped detail', () => {
    const html = render(edgeCaseAuditRun());
    const interactions = sliceBetween(html, 'interactions', 'safety');
    expect(interactions).toContain(escapeHtml(INTERACTION_STATUS_CATALOG.NOT_VERIFIABLE.label));
    expect(interactions).toContain(escapeHtml(INTERACTION_NOT_VERIFIABLE_KIND_CATALOG.CHECK_NOT_COMPLETED.label));
    // C18o: 理由は、コード、日本語の説明、詳細で示す。見本の危険な文字列は、理由の詳細（`reasonDetail`）にある（C18n）。
    expect(interactions).toContain(renderCode('CANDIDATE_REDISCOVERY_INCOMPLETE').html);
    expect(interactions).toContain(escapeHtml(describeInteractionReason('CANDIDATE_REDISCOVERY_INCOMPLETE')));
    expect(interactions).toContain(escapeHtml(HOSTILE_TEXT));
    expect(interactions).not.toContain(HOSTILE_STRINGS.scriptTag);
    expect(interactions).toContain(escapeHtml(`メニュー ${HOSTILE_STRINGS.attributeBreak}`));
    expect(interactions).toContain('href="#page-PAGE-000001"');
  });

  /** Interaction の表の行（`<tr>` の中身）の一覧。 */
  const interactionRows = (html: string): string[] =>
    (sliceBetween(html, 'interactions', 'safety').split('<tbody>')[1]?.split('</table>')[0] ?? '')
      .split('</tr>')
      .filter((row) => row.startsWith('<tr'));

  /** 行の欄（`<td>` の中身）の一覧。 */
  const interactionCellsOf = (row: string): string[] =>
    row
      .split('<td>')
      .slice(1)
      .map((cell) => cell.split('</td>')[0] ?? '');

  // C18o（Task 19 の前の整理の設計書 5.1.2 の「表示」）: Interaction の理由は、ページの未完了の理由の一覧と同じ部品で、
  // コード、日本語の説明、詳細の順に示す。詳細のない理由は、コードと説明だけを示す。
  it('shows the reason of each interaction in the reason column the same way as the incomplete reasons of a page (C18o)', () => {
    const columns = HTML_REPORT_TEXT.interactions.columns;
    expect(columns).toEqual(['ページ', 'ビューポート', '対象', '状態', '確認できなかった区分', '理由', 'Evidence']);
    const reasonColumn = columns.indexOf('理由');
    const base = edgeCaseAuditRun();
    const withoutDetail = interaction(90, PAGE_1, 'EXECUTION_FAILED', null, { reason: 'CLICK_FAILED', reasonDetail: null });
    // 見本の PAGE-000001 に、詳細のない Interaction の理由と、ページの未完了の理由（比べるため）を加える。
    const result: AuditRunResult = {
      ...base,
      pages: base.pages.map((view) =>
        view.pageId === PAGE_1
          ? {
              ...view,
              evidence: [...view.evidence, withoutDetail],
              incompleteReasons: [{ code: 'REQUIRED_WORK_NOT_VERIFIED', detail: 'page reason detail' }],
            }
          : view),
    };
    const viewModel = buildReportViewModel(result);
    const html = renderHtmlReport(viewModel);
    const rows = interactionRows(html);
    expect(rows).toHaveLength(viewModel.interactions.items.length);
    expect(viewModel.interactions.items.some((item) => item.reason.detail === null)).toBe(true);
    expect(viewModel.interactions.items.some((item) => item.reason.detail === HOSTILE_TEXT)).toBe(true);
    for (const [index, item] of viewModel.interactions.items.entries()) {
      const cells = interactionCellsOf(rows[index] ?? '');
      expect(cells, `${index}`).toHaveLength(columns.length);
      const { code, description, detail } = item.reason;
      expect(description, `${index}`).toBe(describeInteractionReason(code));
      expect(cells[reasonColumn], `${index}`).toBe(
        [renderCode(code).html, escapeHtml(description), ...(detail === null ? [] : [renderCode(detail).html])].join(' '),
      );
    }
    // ページの未完了の理由の一覧も、同じ形（コード、説明、詳細を空白でつないだもの）で示す。
    const [pageReason] = viewModel.pages[0]?.incompleteReasons ?? [];
    expect(pageReason).toBeDefined();
    expect(sliceBetween(html, 'pages', null)).toContain(
      [renderCode(pageReason!.code).html, escapeHtml(pageReason!.description), renderCode(pageReason!.detail!).html].join(' '),
    );
    expect(html).not.toContain('<script');
  });

  it('shows the Safety summary: guard, blocked actions, excluded candidates, violations and truncation', () => {
    const base = runSummary();
    const html = render(
      auditRun({
        run: {
          safety: {
            ...base.safety,
            blockedRequestsByMethod: { POST: 2 },
            blockedActions: { ...base.safety.blockedActions, requests: 3, popups: 1 },
            excludedInteractionCandidateCount: 4,
            invariantViolationCount: 5,
            invariantViolations: [{ code: 'TEST_VIOLATION', message: HOSTILE_TEXT }],
            recordTruncated: true,
          },
        },
      }),
    );
    const safety = sliceBetween(html, 'safety', 'pages');
    const text = HTML_REPORT_TEXT.safety;
    expect(safety).toContain(keyValue(text.guard, escapeHtml(text.guardEnabled)));
    expect(safety).toContain(keyValue(text.blockedActions.requests, formatCount(3)));
    expect(safety).toContain(keyValue(text.blockedActions.popups, formatCount(1)));
    expect(safety).toContain(keyValue(text.excludedInteractionCandidates, formatCount(4)));
    expect(safety).toContain(keyValue(text.invariantViolationCount, formatCount(5)));
    expect(safety).toContain(escapeHtml(text.lowerBoundNote));
    expect(safety).toContain('POST');
    expect(safety).toContain('TEST_VIOLATION');
    expect(safety).toContain(escapeHtml(HOSTILE_TEXT));
  });

  it('keeps the caption and the column headers of the Safety tables without rows, so that each "なし" says what it is about (R16f)', () => {
    const viewModel = buildReportViewModel(auditRun());
    // 見本の前提: メソッドごとの遮断の件数も、違反もない。
    expect(Object.keys(viewModel.safety.blockedRequestsByMethod)).toEqual([]);
    expect(viewModel.safety.invariantViolations).toEqual([]);
    const safety = sliceBetween(renderHtmlReport(viewModel), 'safety', 'pages');
    const text = HTML_REPORT_TEXT.safety;
    const none = escapeHtml(REPORT_COMPONENT_TEXT.none);
    for (const [caption, columns] of [
      [text.methodsCaption, text.methodColumns],
      [text.violationsCaption, text.violationColumns],
    ] as const) {
      const table = safety.split(`<caption>${escapeHtml(caption)}</caption>`)[1]?.split('</table>')[0];
      expect(table, caption).toBeDefined();
      for (const column of columns) {
        expect(table, caption).toContain(`<th scope="col">${escapeHtml(column)}</th>`);
      }
      expect(table, caption).toContain(`<td colspan="${columns.length}">`);
      expect(table, caption).toContain(none);
    }
  });

  it('shows the page list: anchor, page and viewport states, reasons, page.json and screenshots', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const html = renderHtmlReport(viewModel);
    const pages = sliceBetween(html, 'pages', null);
    for (const pageView of viewModel.pages) {
      expect(pages).toContain(`<h3 id="page-${pageView.pageId}">`);
      expect(pages).toContain(`href="${pageView.pageJsonPath}"`);
      for (const screenshot of pageView.screenshots) {
        expect(pages).toContain(`href="${screenshot.relativePath}"`);
      }
    }
    for (const viewport of VIEWPORT_PROFILES) {
      expect(pages).toContain(escapeHtml(VIEWPORT_PROFILE_CATALOG[viewport].label));
    }
    expect(pages).toContain('data-value="AUDITED"');
    expect(pages).toContain('href="pages/PAGE-000001/visible-text.txt"');
  });

  it('shows the reasons of a page and of its viewports', () => {
    const html = render(
      auditRun({
        run: { skippedPageCount: 1, discoveredPageCount: 2 },
        pages: [...auditRun().pages, page(PAGE_2, '/skipped.html', 'SKIPPED')],
      }),
    );
    const skippedPage = sliceBetween(html, `page-${PAGE_2}`, null);
    expect(skippedPage).toContain('data-value="SKIPPED"');
    expect(skippedPage.match(/MAX_PAGES_REACHED/gu)?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('renderHtmlReport: the Safety events (design 6.1.10)', () => {
  /** PAGE-000001: 再試行の前の試行の Safety（popup 1件）と、最終の試行の Safety（すべての種類）。 */
  const safetyEventsRun = (): AuditRunResult => {
    const retried = safety(20, PAGE_1, 'desktop', {
      scope: 'INTERACTION',
      blockedPopups: [{ url: fixtureUrl('/retry-popup.html'), reason: 'INTERACTION_FROZEN' }],
    });
    const all = safety(21, PAGE_1, 'mobile', safetyEventSamples());
    return auditRun({
      run: { retries: [retry(fixtureUrl('/'), 1, [retried])] },
      pages: [page(PAGE_1, '/', 'AUDITED', [retried, all])],
    });
  };

  /** Safety の節の、事象の一覧の小見出しから節の終わりまで。 */
  const eventsPart = (html: string): string => sliceBetween(sliceBetween(html, 'safety', 'pages'), 'safety-events', null);

  /** 事象の表の行（`<tr>` の中身）の一覧。 */
  const eventRows = (html: string): string[] =>
    (eventsPart(html).split('</table>')[0] ?? '').split('<tbody>')[1]?.split('</tr>').filter((row) => row.startsWith('<tr')) ?? [];

  it('shows a table of the events with the columns of the design, one row per event', () => {
    const viewModel = buildReportViewModel(safetyEventsRun());
    const html = renderHtmlReport(viewModel);
    const part = eventsPart(html);
    expect(sliceBetween(html, 'safety', 'pages')).toContain(
      `<h3 id="safety-events">${escapeHtml(HTML_REPORT_TEXT.safety.eventsHeading)}</h3>`,
    );
    // C18a: 外部スキームへの移動の試みは、遮断したものではなく記録したものなので、見出しは遮断と記録の両方を含む意味にする。
    expect(HTML_REPORT_TEXT.safety.eventsHeading).toBe('Safety の事象の一覧');
    expect(HTML_REPORT_TEXT.safety.eventColumns).toEqual(['種類', 'ページ', 'ビューポート', 'メソッド', 'URL', '候補', '理由', 'Evidence']);
    for (const column of HTML_REPORT_TEXT.safety.eventColumns) {
      expect(part).toContain(`<th scope="col">${escapeHtml(column)}</th>`);
    }
    // 見本の記録（`safetyEventSamples` の13件。C18a で外部スキームへの移動の試みを1件加えた）と、再試行の前の試行の popup の1件。
    const sampleCount = Object.values(safetyEventSamples()).reduce((sum, events) => sum + events.length, 0);
    expect(sampleCount).toBe(13);
    expect(viewModel.safety.events.length).toBe(sampleCount + 1);
    const rows = eventRows(html);
    expect(rows).toHaveLength(viewModel.safety.events.length);
    for (const [index, event] of viewModel.safety.events.entries()) {
      const row = rows[index] ?? '';
      expect(row, `${index}`).toContain(escapeHtml(SAFETY_EVENT_KIND_CATALOG[event.kind].label));
      expect(row, `${index}`).toContain('href="#page-PAGE-000001"');
      expect(row, `${index}`).toContain(escapeHtml(VIEWPORT_PROFILE_CATALOG[event.viewport!].label));
      expect(row, `${index}`).toContain(renderCode(event.reason).html);
      expect(event.location?.path).toBe('pages/PAGE-000001/page.json');
      expect(row, `${index}`).toContain(renderEvidenceRef(event.evidenceId, event.location!.path, event.location!.pointer).html);
      if (event.method !== null) {
        expect(row, `${index}`).toContain(renderCode(event.method).html);
      }
      if (event.url === null) {
        expect(row, `${index}`).toContain(escapeHtml(REPORT_COMPONENT_TEXT.none));
      } else {
        expect(row, `${index}`).toContain(escapeHtml(event.url));
      }
    }
  });

  /** 行の欄（`<td>` の中身）の一覧。 */
  const cellsOf = (row: string): string[] =>
    row
      .split('<td>')
      .slice(1)
      .map((cell) => cell.split('</td>')[0] ?? '');

  it('shows the candidate ID in its own column, after the method and the URL (C16e)', () => {
    const viewModel = buildReportViewModel(safetyEventsRun());
    const rows = eventRows(renderHtmlReport(viewModel));
    const columns = HTML_REPORT_TEXT.safety.eventColumns;
    const candidateColumn = columns.indexOf('候補');
    expect(candidateColumn).toBe(columns.indexOf('URL') + 1);
    expect(viewModel.safety.events.some((event) => event.candidateId !== null)).toBe(true);
    expect(viewModel.safety.events.some((event) => event.candidateId === null)).toBe(true);
    for (const [index, event] of viewModel.safety.events.entries()) {
      const cells = cellsOf(rows[index] ?? '');
      expect(cells, `${index}`).toHaveLength(columns.length);
      const methodCell = cells[columns.indexOf('メソッド')] ?? '';
      const urlCell = cells[columns.indexOf('URL')] ?? '';
      const candidateCell = cells[candidateColumn] ?? '';
      // 値のない欄は、メソッドや URL の欄と同じく「なし」と示す。
      const noneCell = escapeHtml(REPORT_COMPONENT_TEXT.none);
      expect(methodCell, `${index}`).toContain(event.method === null ? noneCell : renderCode(event.method).html);
      expect(urlCell, `${index}`).toContain(event.url === null ? noneCell : escapeHtml(event.url));
      if (event.candidateId === null) {
        expect(candidateCell, `${index}`).toContain(noneCell);
      } else {
        expect(candidateCell, `${index}`).toContain(renderCode(event.candidateId).html);
      }
      expect(cells[columns.indexOf('理由')], `${index}`).toContain(renderCode(event.reason).html);
    }
    // 候補の ID の欄の「なし」は、メソッドの欄の「なし」と同じ書き方である。
    const withoutAnything = viewModel.safety.events.findIndex((event) => event.method === null && event.candidateId === null);
    expect(withoutAnything).toBeGreaterThanOrEqual(0);
    const cells = cellsOf(rows[withoutAnything] ?? '');
    expect(cells[candidateColumn]).toBe(cells[columns.indexOf('メソッド')]);
  });

  it('escapes the candidate ID of an event (C16e)', () => {
    const hostile = safety(22, PAGE_1, 'desktop', {
      scope: 'INTERACTION',
      excludedInteractionCandidates: [{ candidateId: HOSTILE_STRINGS.scriptTag, reason: 'SUBMISSION_CONTROL' }],
    });
    const html = render(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [hostile])] }));
    const rows = eventRows(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(escapeHtml(HOSTILE_STRINGS.scriptTag));
    expect(html).not.toContain('<script');
  });

  it('marks the events of an attempt before a retry', () => {
    const viewModel = buildReportViewModel(safetyEventsRun());
    const rows = eventRows(renderHtmlReport(viewModel));
    const marker = escapeHtml(earlierAttemptRecordText(1));
    expect(viewModel.safety.events[0]?.retryAttempt).toBe(1);
    expect(rows[0]).toContain(escapeHtml('/retry-popup.html'));
    expect(rows[0]).toContain(marker);
    expect(rows.slice(1).some((row) => row.includes(marker))).toBe(false);
  });

  it('escapes the URLs of the events and never links mailto:, tel: or javascript:', () => {
    const html = render(safetyEventsRun());
    const part = eventsPart(html);
    const samples = safetyEventSamples();
    expect(part).toContain(escapeHtml(samples.blockedNavigations[0]!.url));
    expect(part).toContain(escapeHtml(SPECIAL_SCHEME_URLS.mailto));
    expect(part).toContain(escapeHtml(SPECIAL_SCHEME_URLS.tel));
    expect(part).toContain(escapeHtml(HOSTILE_STRINGS.javascriptUrl));
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/href="\s*(?:mailto|tel|javascript):/iu);
    // R16f（設計書 6.1.11）: 許可 Origin の中の URL も、外部の URL も、リンクにしない（U16c の「リンクにする」を改めた）。
    expect(part).toContain(escapeHtml(fixtureUrl('/api/submit')));
    expect(part).not.toContain(`href="${fixtureUrl('/api/submit')}"`);
    expect(part).not.toMatch(/href="https?:/u);
  });

  /** http(s) の URL を持つ事象（遮断した POST、外部への作用、ダウンロード、ポップアップ）だけの Run（R16f）。 */
  const httpEventsRun = (): AuditRunResult =>
    auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [safety(30, PAGE_1, 'desktop', httpSafetyEventSamples())])] });

  it('uses a sample of http(s) events that matches the page schema (R16f)', async () => {
    const [value] = httpEventsRun().pages;
    await expect(validateArtifact('page', value)).resolves.toEqual({ ok: true });
  });

  it('never links the URL of an event, whatever its kind and whatever classifyUrl says (R16f, design 6.1.11)', () => {
    const viewModel = buildReportViewModel(httpEventsRun());
    const rows = eventRows(renderHtmlReport(viewModel));
    const columns = HTML_REPORT_TEXT.safety.eventColumns;
    const samples = httpSafetyEventSamples();
    // 見本の前提: 4種類に、許可 Origin の中の URL と外部の URL が1件ずつある。
    expect(new Set(viewModel.safety.events.map((event) => event.kind))).toEqual(new Set(Object.keys(samples)));
    expect(viewModel.safety.events).toHaveLength(8);
    expect(rows).toHaveLength(viewModel.safety.events.length);
    for (const [index, event] of viewModel.safety.events.entries()) {
      const cells = cellsOf(rows[index] ?? '');
      const urlCell = cells[columns.indexOf('URL')] ?? '';
      expect(event.url, `${index}`).toMatch(/^https?:\/\//u);
      expect(urlCell, `${index}`).toContain(escapeHtml(event.url!));
      expect(urlCell, `${index}`).not.toContain('<a');
      expect(urlCell, `${index}`).not.toContain('href=');
      // ページのアンカーと、Evidence の参照のリンクは残る。
      expect(cells[columns.indexOf('ページ')], `${index}`).toContain('href="#page-PAGE-000001"');
      expect(cells[columns.indexOf('Evidence')], `${index}`).toContain('href="pages/PAGE-000001/page.json"');
      // 行の中のリンクは、ページのアンカーと Evidence の参照の2つだけである。
      expect(rows[index]?.match(/<a\s/gu)?.length, `${index}`).toBe(2);
    }
    const part = eventsPart(renderHtmlReport(viewModel));
    expect(part).not.toMatch(/href="https?:/u);
  });

  it('says "なし" when there is no event', () => {
    const html = render(auditRun());
    const part = eventsPart(html);
    expect(part).toContain(escapeHtml(REPORT_COMPONENT_TEXT.none));
    expect(part).not.toContain('<table');
  });

  it('uses only safe anchors, each once, with the events table', () => {
    const html = render(safetyEventsRun());
    const ids = idsOf(html);
    expect(new Set(ids).size).toBe(ids.length);
    for (const target of fragmentTargetsOf(html)) {
      expect(ids, target).toContain(target);
    }
  });
});

describe('renderHtmlReport: the view model is used as it is (design 6.1.10)', () => {
  it('draws the Evidence reference of an Interaction from its location, without looking it up by ID', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const [item] = viewModel.interactions.items;
    expect(item?.location).not.toBeNull();
    const moved: ReportViewModel = {
      ...viewModel,
      interactions: {
        ...viewModel.interactions,
        items: [{ ...item!, location: { ...item!.location!, path: 'pages/PAGE-000002/page.json', pointer: '/evidence/99' } }],
      },
    };
    const interactions = sliceBetween(renderHtmlReport(moved), 'interactions', 'safety');
    expect(interactions).toContain(renderEvidenceRef(item!.evidenceId, 'pages/PAGE-000002/page.json', '/evidence/99').html);
    expect(interactions).not.toContain(renderEvidenceRef(item!.evidenceId, item!.location!.path, item!.location!.pointer).html);

    const unknown: ReportViewModel = { ...moved, interactions: { ...moved.interactions, items: [{ ...item!, location: null }] } };
    const withoutPlace = sliceBetween(renderHtmlReport(unknown), 'interactions', 'safety');
    expect(withoutPlace).toContain(renderEvidenceRef(item!.evidenceId, null).html);
    expect(withoutPlace).not.toContain(`${renderEvidenceRef(item!.evidenceId, null).html}</a>`);
    expect(withoutPlace).not.toContain('/evidence/99');
  });

  it('shows the integers (the link depth limit and the HTTP status) with formatInteger', () => {
    const viewModel = buildReportViewModel(auditRun());
    const html = renderHtmlReport(viewModel);
    const depthLabel = escapeHtml(HTML_REPORT_TEXT.summary.limits.maxDepth);
    expect(html).toContain(`<tr><td>${depthLabel}</td><td>${formatInteger(viewModel.summary.limits.maxDepth)}</td>`);
    expect(sliceBetween(html, `page-viewports-${PAGE_1}`, null)).toContain(`<td>${formatInteger(200)}</td>`);

    // 観測できなかった値は、ほかの書式と同じく「未観測」にする（`formatDecimal(値, 0)` のように `NaN` や `-1` と書かない）。
    const [firstPage] = viewModel.pages;
    const altered: ReportViewModel = {
      ...viewModel,
      summary: { ...viewModel.summary, limits: { ...viewModel.summary.limits, maxDepth: Number.NaN } },
      pages: [{ ...firstPage!, viewports: firstPage!.viewports.map((view) => ({ ...view, httpStatus: -1 })) }],
    };
    const alteredHtml = renderHtmlReport(altered);
    const notObserved = escapeHtml(formatNotObserved());
    expect(alteredHtml).toContain(`<tr><td>${depthLabel}</td><td>${notObserved}</td>`);
    expect(alteredHtml).not.toContain('<td>NaN</td>');
    expect(alteredHtml).not.toContain('<td>-1</td>');
  });
});

describe('renderHtmlReport: values that were not observed', () => {
  it('shows them as "未観測", never as 0, an empty string or null', () => {
    const base = runSummary();
    const html = render(
      auditRun({
        run: {
          finishedAt: null,
          environment: { ...base.environment, chromiumVersion: null, userAgents: { desktop: null, mobile: 'agent-mobile' } },
          skippedPageCount: 1,
          discoveredPageCount: 2,
        },
        pages: [...auditRun().pages, page(PAGE_2, '/skipped.html', 'SKIPPED')],
      }),
    );
    const notObserved = escapeHtml(formatNotObserved());
    expect(notObserved).toBe('未観測');
    expect(html).toContain(keyValue(HTML_REPORT_TEXT.summary.finishedAt, notObserved));
    expect(html).toContain(keyValue(HTML_REPORT_TEXT.summary.environment.chromiumVersion, notObserved));
    // SKIPPED のビューポートは、最終 URL、HTTP ステータス、ナビゲーションの結果を観測していない。
    const skippedViewports = sliceBetween(html, `page-viewports-${PAGE_2}`, null).split('</table>')[0] ?? '';
    expect(skippedViewports.match(/<td>未観測<\/td>/gu)?.length).toBe(VIEWPORT_PROFILES.length * 3);
    expect(html).not.toMatch(/>null</u);
    expect(html).not.toMatch(/<dd><\/dd>|<td><\/td>/u);
  });
});

describe('renderHtmlReport: retries (design 6.1.9)', () => {
  it('shows the records of the attempts before the retry under a separate sub-heading', () => {
    const viewModel = buildReportViewModel(edgeCaseAuditRun());
    const html = renderHtmlReport(viewModel);
    const firstPage = sliceBetween(html, `page-${PAGE_1}`, `page-${PAGE_2}`);
    const retryHeading = `<h4 id="page-retries-${PAGE_1}">${escapeHtml(HTML_REPORT_TEXT.pages.retriesHeading)}</h4>`;
    expect(firstPage).toContain(retryHeading);
    const [beforeRetries, retries] = firstPage.split(retryHeading);
    const [attempt] = viewModel.pages[0]!.retryAttempts;
    expect(attempt).toBeDefined();
    expect(attempt!.screenshots.length).toBeGreaterThan(0);
    for (const screenshot of attempt!.screenshots) {
      expect(retries).toContain(`href="${screenshot.relativePath}"`);
      expect(beforeRetries).not.toContain(screenshot.relativePath);
    }
    for (const evidence of attempt!.evidence) {
      expect(retries).toContain(evidence.evidenceId);
      expect(retries).toContain(escapeHtml(evidence.pointer));
    }
    expect(retries).toContain(attempt!.navigationOutcome);
    // 再試行のないページには、再試行の前の記録の小見出しがない。
    expect(sliceBetween(html, `page-${PAGE_2}`, null)).not.toContain(escapeHtml(HTML_REPORT_TEXT.pages.retriesHeading));
  });
});

describe('renderHtmlReport: safety of the output (plan Task 16 Step 3, design 6.1.6)', () => {
  it('shows mailto: and tel: URLs as text, never as links', () => {
    const html = render(edgeCaseAuditRun());
    expect(html).toContain(escapeHtml(SPECIAL_SCHEME_URLS.mailto));
    expect(html).toContain(escapeHtml(SPECIAL_SCHEME_URLS.tel));
    expect(html).not.toContain('href="mailto:');
    expect(html).not.toContain('href="tel:');
    expect(html).not.toMatch(/href="\s*(?:mailto|tel):/iu);
  });

  it('escapes <script>, "onerror= and javascript: taken from the Evidence and the Run', () => {
    const html = render(edgeCaseAuditRun());
    expect(html).not.toContain('<script');
    expect(html).not.toContain(HOSTILE_STRINGS.attributeBreak);
    expect(html).not.toMatch(/href="\s*javascript:/iu);
    expect(html).toContain(escapeHtml(HOSTILE_STRINGS.scriptTag));
    expect(html).toContain(escapeHtml(HOSTILE_STRINGS.attributeBreak));
    expect(html).toContain(escapeHtml(HOSTILE_STRINGS.javascriptUrl));
    // エスケープした文字列を除いた残りに、イベントハンドラの属性がない（属性を抜け出していない）。
    let rest = html;
    for (const hostile of [HOSTILE_TEXT, ...Object.values(HOSTILE_STRINGS)]) {
      rest = rest.replaceAll(escapeHtml(hostile), '');
    }
    expect(rest).not.toMatch(/\son[a-z]+=/iu);
  });

  it('uses only safe anchors, each once, and every in-document link points to an anchor of the document', () => {
    for (const result of [auditRun(), edgeCaseAuditRun()]) {
      const html = render(result);
      const ids = idsOf(html);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/u);
      }
      expect(new Set(ids).size).toBe(ids.length);
      const targets = fragmentTargetsOf(html);
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        expect(ids, target).toContain(target);
      }
    }
  });

  it('never links a relative path that leaves the Run directory', () => {
    const html = render(edgeCaseAuditRun());
    const hrefs = [...html.matchAll(/\shref="([^"]*)"/gu)].map((match) => match[1] ?? '');
    for (const href of hrefs) {
      expect(href).not.toMatch(/^\/|^\/\/|(?:^|\/)\.\.(?:\/|$)|^[a-z][a-z0-9+.-]*:(?!\/\/)/iu);
    }
    expect(hrefs.some((href) => href.startsWith(`pages/${PAGE_1}/`))).toBe(true);
  });
});
