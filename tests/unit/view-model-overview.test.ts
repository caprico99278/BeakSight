// PL-R（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 14 章）: 表示用モデルの「まとめ」（`overview`）。報告の冒頭のまとめの段と、作業の画面が
// 読む小さなまとめ（`report-summary.json`）は、これを描くだけにする（報告の側で判定・集計し直さない）。
// - 大事な 3 つ: Rule ごとの要約（`ruleDigests`。重さの順・件数の多い順）の先頭から、サイト品質の Rule を 3 つまで。文言は Rule の文のまま（例の最初の Finding）。
// - 見たページと、最後まで見られなかったページの数は、`RunSummary` の件数のまま（数え直さない）。
// - 見なかった理由: 点検の全体の理由（コードの重なりを除く。技術の詳細は持たない）と、ページの理由ごとのページの数（`run.json` の `pageIncompleteReasonCounts` の写し）。
import { describe, expect, it } from 'vitest';
import type { AuditRunResult, Finding } from '../../src/core/contracts.js';
import { createFindingId } from '../../src/core/ids.js';
import { describeIncompleteReason, nextStepOfIncompleteReason } from '../../src/presentation/messages.js';
import { REPORT_OVERVIEW_TOP_PROBLEM_COUNT, buildReportViewModel } from '../../src/report/view-model.js';
import { PAGE_1, PAGE_2, PAGE_3, auditRun, dom, finding, idOf, page, runSummary } from '../helpers/audit-run-fixture.js';

const P1 = dom(1, PAGE_1, 'desktop', 'p1');
const P2 = dom(2, PAGE_2, 'desktop', 'p2');
const P3 = dom(3, PAGE_3, 'desktop', 'p3');

/** 見本の Finding（`AuditRunResult.findings` の順）。 */
const FINDINGS: readonly Finding[] = [
  finding(1, 'WARN', 'LAYOUT', PAGE_1, [idOf(P1)], { ruleId: 'LAYOUT_FIXED', message: '固定の幅の要素が、画面の幅を超えています。' }),
  finding(2, 'WARN', 'LAYOUT', PAGE_2, [idOf(P2)], { ruleId: 'LAYOUT_FIXED', message: '固定の幅の要素が、画面の幅を超えています。' }),
  finding(3, 'WARN', 'LAYOUT', PAGE_3, [idOf(P3)], { ruleId: 'LAYOUT_FIXED', message: '固定の幅の要素が、画面の幅を超えています。' }),
  finding(4, 'ERROR', 'JAVASCRIPT', PAGE_1, [idOf(P1)], { ruleId: 'JS_ERROR', message: 'ページのプログラムでエラーが起きました。' }),
  finding(5, 'INFO', 'LINK', PAGE_2, [idOf(P2)], { ruleId: 'LINK_INFO' }),
  finding(6, 'INFO', 'DOM', PAGE_2, [idOf(P2)], { ruleId: 'MIXED', message: '見出しの順が飛んでいます（情報）。' }),
  finding(7, 'ERROR', 'DOM', PAGE_3, [idOf(P3)], { ruleId: 'MIXED', message: '見出しの順が飛んでいます。' }),
  // SAFETY の Rule は、重さの順では最後で、大事な 3 つ（サイト品質の問題）には入れない。
  finding(8, 'SAFETY', 'SAFETY', PAGE_1, [idOf(P1)], { ruleId: 'SAFETY_RULE' }),
];

const sampleRun = (overrides: Parameters<typeof runSummary>[0] = {}): AuditRunResult =>
  auditRun({
    run: {
      discoveredPageCount: 9,
      auditedPageCount: 3,
      partialPageCount: 2,
      failedPageCount: 1,
      skippedPageCount: 1,
      ...overrides,
    },
    pages: [
      page(PAGE_1, '/', 'AUDITED', [P1]),
      page(PAGE_2, '/second.html', 'AUDITED', [P2]),
      page(PAGE_3, '/third.html', 'AUDITED', [P3]),
    ],
    findings: FINDINGS,
  });

describe('buildReportViewModel: the overview of the report (PL-R)', () => {
  it('picks the three most important problems from the Rule digests, the most severe first, with the message of the Rule', () => {
    const model = buildReportViewModel(sampleRun());
    expect(REPORT_OVERVIEW_TOP_PROBLEM_COUNT).toBe(3);
    expect(model.overview.topProblems).toEqual([
      // MIXED（いちばん重いのは ERROR。2 件、2 ページ）。文言と行へのリンクは、例の最初の Finding（`AuditRunResult.findings` の順）。
      // OP-R2: やさしい文（`plainMessage`）は、その Finding の値。見本の ruleId はどの Rule のものでもないので、Rule の文のまま。
      { ruleId: 'MIXED', severity: 'ERROR', count: 2, pageCount: 2, findingId: createFindingId(6), message: '見出しの順が飛んでいます（情報）。', plainMessage: '見出しの順が飛んでいます（情報）。' },
      { ruleId: 'JS_ERROR', severity: 'ERROR', count: 1, pageCount: 1, findingId: createFindingId(4), message: 'ページのプログラムでエラーが起きました。', plainMessage: 'ページのプログラムでエラーが起きました。' },
      { ruleId: 'LAYOUT_FIXED', severity: 'WARN', count: 3, pageCount: 3, findingId: createFindingId(1), message: '固定の幅の要素が、画面の幅を超えています。', plainMessage: '固定の幅の要素が、画面の幅を超えています。' },
    ]);
    // 並びと件数は Rule ごとの要約のまま（作り直さない）。
    expect(model.overview.topProblems.map(({ ruleId }) => ruleId)).toEqual(model.ruleDigests.slice(0, 3).map(({ ruleId }) => ruleId));
  });

  it('leaves the Safety Rules out of the important problems, and lists fewer than three when there are fewer site quality Rules', () => {
    const model = buildReportViewModel(auditRun({
      pages: [page(PAGE_1, '/', 'AUDITED', [P1])],
      findings: [FINDINGS[0]!, FINDINGS[7]!],
    }));
    expect(model.overview.topProblems.map(({ ruleId }) => ruleId)).toEqual(['LAYOUT_FIXED']);
    expect(buildReportViewModel(auditRun({ pages: [page(PAGE_1, '/', 'AUDITED', [P1])], findings: [] })).overview.topProblems).toEqual([]);
  });

  it('counts the problems as the site quality findings of the summary, and keeps the page counts of the Run', () => {
    const model = buildReportViewModel(sampleRun());
    // 問題の件数は、サイト品質（エラー・警告・情報）の合計（安全は分けて数える）。
    expect(model.overview.problemCount).toBe(7);
    expect(model.overview.problemCount).toBe(model.summary.findingCounts.byGroup.SITE_QUALITY);
    // 見たページ（最後まで見た 3 と、一部だけ見た 2）と、最後まで見られなかったページ（一部だけ 2、開けなかった 1、見なかった 1）。
    expect(model.overview.checkedPageCount).toBe(5);
    expect(model.overview.notFullyCheckedPageCount).toBe(4);
  });

  it('lists the reasons of the whole check once per code without the technical detail, and the pages of each page reason', () => {
    const model = buildReportViewModel(sampleRun({
      incompleteReasons: [
        { code: 'MAX_PAGES_REACHED', detail: 'maxPages=3' },
        { code: 'REQUIRED_WORK_NOT_VERIFIED', detail: 'a' },
        { code: 'REQUIRED_WORK_NOT_VERIFIED', detail: 'b' },
      ],
      pageIncompleteReasonCounts: [
        { code: 'INNER_SCROLL_CONTAINER_NOT_TRAVERSED', pages: 2 },
        { code: 'DEADLINE_EXCEEDED', pages: 1 },
      ],
    }));
    const reasonOf = (code: Parameters<typeof describeIncompleteReason>[0]) => ({
      code,
      detail: null,
      description: describeIncompleteReason(code),
      nextStep: nextStepOfIncompleteReason(code),
    });
    expect(model.overview.runReasons).toEqual([reasonOf('MAX_PAGES_REACHED'), reasonOf('REQUIRED_WORK_NOT_VERIFIED')]);
    expect(model.overview.pageReasons).toEqual([
      { reason: reasonOf('INNER_SCROLL_CONTAINER_NOT_TRAVERSED'), pages: 2 },
      { reason: reasonOf('DEADLINE_EXCEEDED'), pages: 1 },
    ]);
  });

  it('has no page reasons for a Run without the page reason counts (an earlier writer)', () => {
    const model = buildReportViewModel(sampleRun());
    expect(model.overview.pageReasons).toEqual([]);
    expect(model.overview.runReasons).toEqual([]);
  });

  it('is deeply frozen with the rest of the model', () => {
    const model = buildReportViewModel(sampleRun());
    expect(Object.isFrozen(model.overview)).toBe(true);
    expect(Object.isFrozen(model.overview.topProblems[0])).toBe(true);
  });
});
