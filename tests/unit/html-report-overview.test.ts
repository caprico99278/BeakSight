// PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章。ユーザーの判断: 並べ替えと言葉の両方）: 点検の結果の報告（HTML）の並べ替え。
// - 冒頭は「まとめ」の段: 何を見たか（サイト、ページの数）、問題の件数（重さごと）、大事な 3 つ（文言は Rule のまま）、見なかったもの（やさしい言葉の理由）。
//   値は表示用モデルの `overview` と `summary` のまま（報告で判定・集計し直さない）。
// - Run の ID・許可 Origin・環境・版・送った要求の数などの技術の記録は、末尾の「記録」の段（消さない）。
// - 読みやすさ: 本文の最大幅 約 50rem、表の文字、見出しの段（報告のトークン `html-tokens.ts`）。
import { describe, expect, it } from 'vitest';
import type { AuditRunResult } from '../../src/core/contracts.js';
import {
  REPORT_SECTION_CATALOG,
  REPORT_SECTIONS,
  RUN_STATUS_CATALOG,
  SEVERITY_CATALOG,
  sortByDisplayOrder,
} from '../../src/presentation/catalog.js';
import { formatCount, formatInteger } from '../../src/presentation/format.js';
import { HTML_REPORT_TEXT, RUN_SUMMARY_TEXT, describeIncompleteReason } from '../../src/presentation/messages.js';
import { escapeHtml, renderSeverityBadge, toAnchorId } from '../../src/report/html-components.js';
import { renderHtmlReport } from '../../src/report/html-report.js';
import { REPORT_STYLESHEET } from '../../src/report/html-tokens.js';
import { buildReportViewModel, type ReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, PAGE_2, auditRun, dom, edgeCaseAuditRun, finding, idOf, interaction, page } from '../helpers/audit-run-fixture.js';

const render = (result: AuditRunResult): string => renderHtmlReport(buildReportViewModel(result));

const positionOfId = (html: string, id: string): number => html.indexOf(` id="${id}"`);

/** `startId` の要素から、`endId` の要素（なければ文書の終わり）までの部分。 */
const sliceBetween = (html: string, startId: string, endId: string | null): string => {
  const start = positionOfId(html, startId);
  expect(start, startId).toBeGreaterThanOrEqual(0);
  const end = endId === null ? html.length : positionOfId(html, endId);
  expect(end, endId ?? 'end').toBeGreaterThan(start);
  return html.slice(start, end);
};

const OVERVIEW = REPORT_SECTION_CATALOG.OVERVIEW.anchor;
const RECORD = REPORT_SECTION_CATALOG.RECORD.anchor;
const overviewOf = (html: string): string => sliceBetween(html, OVERVIEW, REPORT_SECTION_CATALOG.CRITICAL_FINDINGS.anchor);
const recordOf = (html: string): string => sliceBetween(html, RECORD, null);

describe('renderHtmlReport: the overview first and the record last (PL-R)', () => {
  it('opens with the overview section right after the title and ends with the record section', () => {
    const html = render(edgeCaseAuditRun());
    const ordered = sortByDisplayOrder(REPORT_SECTIONS, REPORT_SECTION_CATALOG);
    expect(ordered[0]).toBe('OVERVIEW');
    expect(ordered[ordered.length - 1]).toBe('RECORD');
    const h1End = html.indexOf('</h1>');
    const firstH2 = html.indexOf('<h2 ');
    expect(firstH2).toBeGreaterThan(h1End);
    expect(html.slice(firstH2)).toMatch(new RegExp(`^<h2 id="${OVERVIEW}">`, 'u'));
    expect(html.lastIndexOf('<h2 ')).toBe(html.indexOf(`<h2 id="${RECORD}">`));
  });

  it('keeps the technical record in the record section and not in the overview', () => {
    const result = edgeCaseAuditRun();
    const model = buildReportViewModel(result);
    const html = renderHtmlReport(model);
    const overview = overviewOf(html);
    const record = recordOf(html);
    for (const technical of [model.summary.runId, model.summary.toolVersion, model.summary.environment.nodeVersion]) {
      expect(overview, technical).not.toContain(escapeHtml(technical));
      expect(record, technical).toContain(escapeHtml(technical));
    }
    // 許可 Origin の項目（サイトのアドレスは、まとめでは開始のページのアドレスとして出す）。
    for (const label of [HTML_REPORT_TEXT.summary.allowedOrigins, HTML_REPORT_TEXT.summary.runId]) {
      expect(overview, label).not.toContain(escapeHtml(label));
      expect(record, label).toContain(escapeHtml(label));
    }
    expect(record).toContain(escapeHtml(RUN_SUMMARY_TEXT.loadHeading));
    expect(overview).not.toContain(escapeHtml(RUN_SUMMARY_TEXT.loadHeading));
  });

  it('says what was checked: the site, the result of the check and the numbers of pages from the view model', () => {
    const model = buildReportViewModel(edgeCaseAuditRun());
    const overview = overviewOf(renderHtmlReport(model));
    const text = HTML_REPORT_TEXT.overview;
    expect(overview).toContain(escapeHtml(text.scopeHeading));
    expect(overview).toContain(escapeHtml(model.summary.startUrl));
    expect(overview).toContain(escapeHtml(RUN_STATUS_CATALOG[model.summary.runStatus].label));
    expect(overview).toContain(`<dt>${escapeHtml(text.discoveredPages)}</dt><dd>${formatCount(model.summary.coverage.discovered)}</dd>`);
    expect(overview).toContain(`<dt>${escapeHtml(text.checkedPages)}</dt><dd>${formatCount(model.overview.checkedPageCount)}</dd>`);
  });

  it('shows the number of problems and the counts of each severity from the view model, without counting again', () => {
    const model = buildReportViewModel(edgeCaseAuditRun());
    const altered: ReportViewModel = {
      ...model,
      summary: { ...model.summary, findingCounts: { ...model.summary.findingCounts, bySeverity: { ERROR: 41, WARN: 42, INFO: 43, SAFETY: 44 } } },
      overview: { ...model.overview, problemCount: 4321 },
    };
    const overview = overviewOf(renderHtmlReport(altered));
    expect(overview).toContain(escapeHtml(HTML_REPORT_TEXT.overview.problemsFound(formatCount(4321))));
    for (const [severity, count] of Object.entries({ ERROR: 41, WARN: 42, INFO: 43, SAFETY: 44 }) as [keyof typeof SEVERITY_CATALOG, number][]) {
      expect(overview, severity).toContain(`<dt>${escapeHtml(SEVERITY_CATALOG[severity].label)}</dt><dd>${formatCount(count)}</dd>`);
    }
  });

  it('says that no problem was found when there is none', () => {
    const p1 = dom(1, PAGE_1, 'desktop', 'p1');
    const overview = overviewOf(render(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [p1])], findings: [] })));
    expect(overview).toContain(escapeHtml(HTML_REPORT_TEXT.overview.noProblems));
  });

  it('lists the important problems with the severity, the message of the Rule and a link to the row', () => {
    const model = buildReportViewModel(edgeCaseAuditRun());
    const overview = overviewOf(renderHtmlReport(model));
    expect(model.overview.topProblems.length).toBeGreaterThan(0);
    for (const problem of model.overview.topProblems) {
      expect(overview, problem.ruleId).toContain(renderSeverityBadge(problem.severity).html);
      expect(overview, problem.ruleId).toContain(escapeHtml(problem.message));
      expect(overview, problem.ruleId).toContain(`href="#${toAnchorId('finding', problem.findingId)}"`);
      // ページによらない問題（いくつかのページを比べた問題）は、ページの数を書かない。
      const times = problem.pageCount === 0
        ? HTML_REPORT_TEXT.overview.problemTimesWithoutPages(formatCount(problem.count))
        : HTML_REPORT_TEXT.overview.problemTimes(formatCount(problem.count), formatInteger(problem.pageCount));
      expect(overview, problem.ruleId).toContain(escapeHtml(times));
    }
    // 見本の確かめ: ページによらない問題と、ページのある問題の両方を含む。
    expect(model.overview.topProblems.some(({ pageCount }) => pageCount === 0)).toBe(true);
    expect(model.overview.topProblems.some(({ pageCount }) => pageCount > 0)).toBe(true);
  });

  it('says what was not checked, with the reasons in plain words and the numbers of pages', () => {
    const result = edgeCaseAuditRun();
    const withReasons: AuditRunResult = {
      ...result,
      run: {
        ...result.run,
        partialPageCount: 1,
        pageIncompleteReasonCounts: [{ code: 'INNER_SCROLL_CONTAINER_NOT_TRAVERSED', pages: 1 }],
      },
    };
    const model = buildReportViewModel(withReasons);
    const overview = overviewOf(renderHtmlReport(model));
    const text = HTML_REPORT_TEXT.overview;
    expect(overview).toContain(escapeHtml(text.notCheckedHeading));
    expect(overview).toContain(escapeHtml(text.notFullyCheckedPages(formatInteger(model.overview.notFullyCheckedPageCount))));
    expect(overview).toContain(escapeHtml(describeIncompleteReason('REQUIRED_WORK_NOT_VERIFIED')));
    expect(overview).toContain(escapeHtml(text.pageReason(describeIncompleteReason('INNER_SCROLL_CONTAINER_NOT_TRAVERSED'), formatInteger(1))));
    // 技術の詳細（理由の detail）と、理由のコードは、まとめには出さない（記録の段に残る）。
    expect(overview).not.toContain('REQUIRED_WORK_NOT_VERIFIED');
    expect(recordOf(renderHtmlReport(model))).toContain('REQUIRED_WORK_NOT_VERIFIED');
  });

  it('says that everything was checked when nothing was left', () => {
    const p1 = dom(1, PAGE_1, 'desktop', 'p1');
    const overview = overviewOf(render(auditRun({
      pages: [page(PAGE_1, '/', 'AUDITED', [p1])],
      findings: [finding(1, 'WARN', 'LAYOUT', PAGE_1, [idOf(p1)])],
    })));
    expect(overview).toContain(escapeHtml(HTML_REPORT_TEXT.overview.nothingLeft));
  });
});

describe('the report stylesheet for reading (PL-R)', () => {
  it('limits the body to about 50rem, uses a readable table text and line height, and sets the heading sizes in order', () => {
    expect(REPORT_STYLESHEET).toMatch(/main \{[^}]*max-width: 50rem;/u);
    expect(REPORT_STYLESHEET).toMatch(/--bs-line-height: 1\.75;/u);
    expect(REPORT_STYLESHEET).toMatch(/--bs-font-size-table: 0\.9375rem;/u);
    expect(REPORT_STYLESHEET).toMatch(/\.data-table \{[^}]*font-size: var\(--bs-font-size-table\);/u);
    const sizes = ['h1', 'h2', 'h3', 'h4'].map((heading) => {
      const match = new RegExp(`(?:^|\\n)${heading} \\{[^}]*font-size: ([0-9.]+)rem;`, 'u').exec(REPORT_STYLESHEET);
      expect(match, heading).not.toBeNull();
      return Number(match?.[1]);
    });
    expect([...sizes].sort((left, right) => right - left)).toEqual(sizes);
    expect(new Set(sizes).size).toBe(sizes.length);
  });
});

// OP-3（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D12、`2026-10-26-beaksight-plain-ui-design.md` 14 章）: 技術の語（規則の ID と版、
// 証拠の ID、問題・ページ・点検の回の番号、ファイル名、返事の番号、開いた結果のコード、理由のコード、許可 Origin、送り方、GET・HEAD）は、末尾の「記録」の段
// だけに出す（まとめの段・種類ごとの問題・押して確かめた操作・安全・ページごとの結果の本文には出さない）。値は表示用モデルのまま（報告で判定しない）。
/** OP-G2: 撮り直しで報告に残っていた技術の語（本文に出さない）。 */
const REMAINING_TECHNICAL_WORDS: readonly RegExp[] = [
  /Origin/u, /送り方/u, /ID/u, /HTTP/u, /200/u, /JST/u, /GET/u, /HEAD/u, /URL/u, /RUN-/u, /page\.json/u, /run\.json/u, /FIND-/u, /EV-DOM-/u,
  /DOM/u, /scheme/u, /[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+/u,
];

describe('renderHtmlReport: the technical words only in the record section (OP-3)', () => {
  /** 要素の中の文字だけ（属性の値の、アンカーやリンクの先は数えない）。 */
  const textOf = (html: string): string => html.replace(/<[^>]*>/gu, ' ').replace(/&amp;/gu, '&').replace(/\s+/gu, ' ');
  const bodyOf = (html: string): string => sliceBetween(html, OVERVIEW, RECORD);

  it('keeps the ids, the rules, the files, the response numbers and the codes out of the body and in the record', () => {
    const model = buildReportViewModel(edgeCaseAuditRun());
    const html = renderHtmlReport(model);
    const body = textOf(bodyOf(html));
    const record = textOf(recordOf(html));
    const findings = model.categorySections.flatMap((section) => section.findings);
    expect(findings.length).toBeGreaterThan(0);
    const technical = [
      ...findings.flatMap(({ finding, evidence }) => [finding.findingId, finding.ruleId, ...evidence.map(({ evidenceId }) => evidenceId)]),
      ...model.pages.flatMap((view) => [view.pageId, view.pageJsonPath, ...view.retryAttempts.map(({ navigationOutcome }) => navigationOutcome)]),
      ...model.interactions.items.flatMap((item) => [item.reason.code, item.evidenceId]),
      model.summary.runId,
    ];
    for (const value of technical) {
      expect(body, value).not.toContain(value);
      expect(record, value).toContain(value);
    }
    for (const word of ['GET', 'HEAD', 'Origin', '送り方', '返事の番号', 'page.json', 'visible-text', 'EV-', 'FIND-', 'PAGE-0', 'RUN-']) {
      expect(body, word).not.toContain(word);
    }
  });

  // OP-G2（OP-G の指示書の 7。OP-3 の続き）: 撮り直しで本文に残った語（ページの返事の種類の名前、外へ移る部品の理由、記録のファイルの名前を書いた次にできること）
  // も、本文に出さない。種類の名前・理由の説明・次にできることは、表示のカタログの文のまま（報告の側で作り直さない）。
  it('keeps the remaining technical words of the walkthrough out of the body', () => {
    const top = dom(1, PAGE_1, 'desktop', 'トップ');
    const second = dom(3, PAGE_2, 'desktop', '二つめ');
    const result = auditRun({
      pages: [
        page(PAGE_1, '/', 'AUDITED', [top, interaction(2, PAGE_1, 'REJECTED_UNSAFE', null, { reason: 'EXTERNAL_ACTION' })], [
          finding(1, 'ERROR', 'HTTP', PAGE_1, [idOf(top)]),
          finding(2, 'WARN', 'DOM', PAGE_1, [idOf(top)]),
        ]),
        page(PAGE_2, '/second.html', 'PARTIAL', [second], [], {
          incompleteReasons: [{ code: 'RULE_EVALUATION_FAILED', detail: null }, { code: 'SAFETY_VIOLATION_ABORT', detail: null }],
        }),
      ],
    });
    const body = textOf(bodyOf(render(result)));
    for (const word of REMAINING_TECHNICAL_WORDS) {
      expect(body, String(word)).not.toMatch(word);
    }
  });

  it('still links the important problems and the pages in the body, and keeps the screenshots as plain links', () => {
    const model = buildReportViewModel(edgeCaseAuditRun());
    const body = bodyOf(renderHtmlReport(model));
    const [first] = model.criticalFindings;
    expect(first).toBeDefined();
    expect(body).toContain(`href="#${toAnchorId('finding', first?.finding.findingId ?? '')}"`);
    for (const view of model.pages) {
      expect(body, view.pageId).toContain(` id="${toAnchorId('page', view.pageId)}"`);
    }
    expect(body).toContain('class="screenshot-ref"');
  });
});

// OP-H（撮影 UI-W4 の 3。設計者の判断（案 (a)））: チェックした画面がある点検は、監査の段の後に書き込みの段で登録・更新する。監査の段の報告は「読み取りだけ」を
// 監査の段の事実として残し、まとめの段に、この後に登録・更新することを 1 行で言う。値は、親がジョブの開始で渡した事実（チェックした画面の数）から表示用モデルが
// 作る（報告で判定しない）。チェックがない点検は今のまま。
describe('renderHtmlReport: the planned writes after the audit stage (OP-H)', () => {
  const PLANNED = 'この点検では、この後に、チェックした画面でテスト用のデータを登録・更新します。結果はサイトの画面に出ます。';
  it('says in the overview that the checked screens will be written after this, keeping the read-only line of the audit stage', () => {
    const model = buildReportViewModel(auditRun(), { plannedWriteScreenCount: 2 });
    expect(model.overview.plannedWriteScreenCount).toBe(2);
    expect(HTML_REPORT_TEXT.overview.plannedWrites).toBe(PLANNED);
    const html = renderHtmlReport(model);
    expect(overviewOf(html)).toContain(escapeHtml(PLANNED));
    expect(html.split(escapeHtml(PLANNED))).toHaveLength(2);
    // 読み取りの段の事実（送信の扱い）は、そのまま。
    expect(html).toContain(escapeHtml(HTML_REPORT_TEXT.plainAuditSend.READ_ONLY));
  });

  it('says nothing about the writes without a checked screen', () => {
    for (const model of [buildReportViewModel(auditRun()), buildReportViewModel(auditRun(), {})]) {
      expect(model.overview.plannedWriteScreenCount).toBe(0);
      expect(renderHtmlReport(model)).not.toContain(escapeHtml(PLANNED));
    }
  });
});
