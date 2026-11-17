// MEM-3b（DEF-266）: ページの要約（`src/audit/run-page-summary.ts`）。Run の終わりの数え上げと Run の Finding は、本体の代わりに要約から作っても同じになる。
import { describe, expect, it } from 'vitest';
import { crossPageFactsOfSummary, runPageSummaryOf } from '../../src/audit/run-page-summary.js';
import type { PageAuditResult } from '../../src/core/contracts.js';
import {
  countInteractionOutcomes,
  countPagesByIncompleteReason,
  countPagesByStatus,
  countPartialViewports,
  countViewportPages,
} from '../../src/orchestration/run-aggregation.js';
import { collectedInPartsAuditRun, edgeCaseAuditRun, interaction, PAGE_1 } from '../helpers/audit-run-fixture.js';

describe('MEM-3b: the page summaries give the same counts and Findings as the page results', () => {
  it('counts the pages, the viewports, the reasons and the Interaction outcomes the same from the summaries', () => {
    const edge = edgeCaseAuditRun();
    const pages: readonly PageAuditResult[] = [
      ...edge.pages,
      ...collectedInPartsAuditRun().pages.map((value) => ({ ...value, evidence: [...value.evidence, interaction(90, PAGE_1, 'NOT_VERIFIABLE', null)] })),
    ];
    const summaries = pages.map(runPageSummaryOf);

    expect(countPagesByStatus(summaries)).toEqual(countPagesByStatus(pages));
    expect(countViewportPages(summaries)).toEqual(countViewportPages(pages));
    expect(countPagesByIncompleteReason(summaries)).toEqual(countPagesByIncompleteReason(pages));
    expect(countPartialViewports(summaries)).toEqual(countPartialViewports(pages));
    expect(countInteractionOutcomes(summaries)).toEqual(countInteractionOutcomes(pages));
    expect(countInteractionOutcomes(summaries).unverified).toBeGreaterThan(0);
    expect(summaries.flatMap(({ findings }) => findings)).toEqual(pages.flatMap(({ findings }) => findings));
  });

  it('keeps no Evidence body in the summary but the Interaction records', () => {
    const [first] = edgeCaseAuditRun().pages;
    if (first === undefined) {
      throw new Error('the sample needs a page');
    }
    const summary = runPageSummaryOf(first);
    expect(summary.evidence.every(({ type }) => type === 'interaction')).toBe(true);
    expect(crossPageFactsOfSummary(summary).evidenceIds).toEqual(first.evidence.map(({ evidenceId }) => evidenceId));
  });
});
