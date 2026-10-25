// BN-c・BN-d（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.3・3.5）: 表示用モデルの、指摘と BeakSight の遮断の関係
// （`beaksightBlockRelation`）と、本体の分（`NONE` のサイト品質）と外した分（`CAUSED`・`POSSIBLE`・SAFETY）の分け方と件数。数えるのは表示用モデルだけ。
import { describe, expect, it } from 'vitest';
import { createFindingId } from '../../src/core/ids.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { BLOCK_SAMPLE_SCRIPT_URL as SCRIPT_URL, PAGE_1, auditRun, beaksightBlockAuditRun as sampleRun } from '../helpers/audit-run-fixture.js';

const ids = (...sequences: readonly number[]): readonly string[] => sequences.map(createFindingId);

describe('buildReportViewModel: the relation of each Finding to the BeakSight blocks (BN-c)', () => {
  it('gives each site quality Finding its relation, reason and linked blocks, and no relation to a SAFETY Finding', () => {
    const model = buildReportViewModel(sampleRun());
    expect(model.findings.map((view) => view.beaksightBlockRelation?.relation ?? null)).toEqual(['CAUSED', 'POSSIBLE', 'NONE', 'NONE', null]);
    expect(model.findings.map((view) => view.beaksightBlockRelation?.reason ?? null)).toEqual([
      'TARGET_REQUEST_BLOCKED',
      'SENSITIVE_KIND_BLOCKED',
      'RULE_NOT_SENSITIVE',
      'NO_BLOCK_IN_LOAD',
      null,
    ]);
    expect(model.findings[0]?.beaksightBlockRelation?.blocks).toEqual([
      { pageId: PAGE_1, viewport: 'desktop', load: { kind: 'PAGE_AUDIT' }, requestKind: 'SCRIPT', phase: 'LOAD', method: 'GET', url: SCRIPT_URL, mainFrameNavigation: false },
    ]);
  });

  // BN-R0 の M-3: ページを離れた後に止めた送信の SAFETY の Finding に、閉じる途中の遮断であることが分かる印を付ける。
  it('counts the phases of the blocked events of a SAFETY Finding, and gives no phase counts to the site quality Findings', () => {
    const model = buildReportViewModel(sampleRun());
    expect(model.findings.map((view) => view.safetyBlockPhaseCounts)).toEqual([null, null, null, null, { LOAD: 0, CLOSING: 1 }]);
  });

  it('gives the same relation in the category sections, the critical section and the pages (one judgement)', () => {
    const model = buildReportViewModel(sampleRun());
    const sectionViews = model.categorySections.flatMap((section) => section.findings);
    for (const view of [...sectionViews, ...model.criticalFindings, ...model.pages.flatMap((pageView) => pageView.findings)]) {
      const same = model.findings.find((candidate) => candidate.finding.findingId === view.finding.findingId);
      expect(view.beaksightBlockRelation).toEqual(same?.beaksightBlockRelation);
    }
  });
});

describe('buildReportViewModel: the body and the excluded Findings (BN-d)', () => {
  it('splits the Findings into the body (NONE of the site quality) and the excluded ones (CAUSED, POSSIBLE and SAFETY), in the order of the Run', () => {
    const model = buildReportViewModel(sampleRun());
    expect(model.mainFindings.map((view) => view.finding.findingId)).toEqual(ids(3, 4));
    expect(model.excludedFindings.map((view) => view.finding.findingId)).toEqual(ids(1, 2, 5));
  });

  it('counts the body, the excluded Findings and the relations in the summary', () => {
    const { summary } = buildReportViewModel(sampleRun());
    expect(summary.beaksightBlockRelation.byRelation).toEqual({ CAUSED: 1, POSSIBLE: 1, NONE: 2 });
    expect(summary.beaksightBlockRelation.linkedFindingCount).toBe(2);
    expect(summary.beaksightBlockRelation.mainFindingCounts.total).toBe(2);
    expect(summary.beaksightBlockRelation.mainFindingCounts.bySeverity).toEqual({ ERROR: 1, WARN: 1, INFO: 0, SAFETY: 0 });
    expect(summary.beaksightBlockRelation.excludedFindingCounts.total).toBe(3);
    expect(summary.beaksightBlockRelation.excludedFindingCounts.byGroup).toEqual({ SITE_QUALITY: 2, SAFETY: 1 });
    // 全体の件数は、今までどおり全部の Finding。
    expect(summary.findingCounts.total).toBe(5);
  });

  it('splits the Finding IDs of each page into the body and the excluded ones', () => {
    const model = buildReportViewModel(sampleRun());
    expect(model.pages.map((pageView) => [pageView.mainFindingIds, pageView.excludedFindingIds])).toEqual([
      [ids(3), ids(1, 2, 5)],
      [ids(4), []],
    ]);
  });

  it('makes the digests by Rule of the body and of the excluded Findings, with the counts by relation', () => {
    const model = buildReportViewModel(sampleRun());
    expect(model.mainRuleDigests.map((digest) => [digest.ruleId, digest.count, digest.byBlockRelation])).toEqual([
      ['HTTP_4XX', 1, { CAUSED: 0, POSSIBLE: 0, NONE: 1 }],
      ['MISSING_TITLE', 1, { CAUSED: 0, POSSIBLE: 0, NONE: 1 }],
    ]);
    expect(model.excludedRuleDigests.map((digest) => [digest.ruleId, digest.count, digest.byBlockRelation])).toEqual([
      ['SCRIPT_LOAD_FAILED', 1, { CAUSED: 1, POSSIBLE: 0, NONE: 0 }],
      ['MISSING_TITLE', 1, { CAUSED: 0, POSSIBLE: 1, NONE: 0 }],
      ['SAFETY_NON_READ_REQUEST_BLOCKED', 1, { CAUSED: 0, POSSIBLE: 0, NONE: 0 }],
    ]);
    // 全部の Finding の要約にも、区分の別の件数がある。
    expect(model.ruleDigests.find((digest) => digest.ruleId === 'MISSING_TITLE')?.byBlockRelation).toEqual({ CAUSED: 0, POSSIBLE: 1, NONE: 1 });
  });

  it('puts every Finding in the body when no block was recorded', () => {
    const run = auditRun();
    const model = buildReportViewModel(run);
    expect(model.mainFindings.map((view) => view.finding.findingId)).toEqual(run.findings.map((value) => value.findingId));
    expect(model.excludedFindings).toEqual([]);
  });
});
