// AUD-2d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-2d）: 落ち着いた後の確かめ直しの印の決め方（`recheckStatesOf`）と、
// 表示用モデルの分け方（初めの表示だけの指摘を本体から分けて別に置く。検証の状態と候補群の確信度に効かせる）。ブラウザは使わない。
import { describe, expect, it } from 'vitest';
import type { AuditRunResult, Finding, ViewportRecheckRecord } from '../../src/core/contracts.js';
import { evidenceStateIdOf } from '../../src/core/contracts.js';
import { recheckStatesOf } from '../../src/core/recheck.js';
import { findingGroupConfidenceOf } from '../../src/report/finding-groups.js';
import { buildReportViewModel } from '../../src/report/view-model.js';
import { auditRun } from '../helpers/audit-run-fixture.js';

describe('AUD-2d: the marks of the recheck', () => {
  it('marks PERSISTENT, INITIAL_ONLY and LATE by the key, first items first and late items after', () => {
    const marked = recheckStatesOf(['a', 'b', 'c'], ['c', 'a', 'd', 'd'], (item) => item);
    expect(marked.map(({ item, state }) => [item, state])).toEqual([
      ['a', 'PERSISTENT'],
      ['b', 'INITIAL_ONLY'],
      ['c', 'PERSISTENT'],
      ['d', 'LATE'],
    ]);
  });

  it('lowers the confidence of a candidate group that has an initial-only finding', () => {
    expect(findingGroupConfidenceOf('RENDERED', 3, false, false)).toBe('HIGH');
    expect(findingGroupConfidenceOf('RENDERED', 3, false, true)).toBe('MEDIUM');
    expect(findingGroupConfidenceOf('STATIC_CANDIDATE', 3, false, true)).toBe('LOW');
  });
});

/** 見本の Run の、サイト品質の最初の指摘に、確かめ直しの印を付けた Run。 */
const withRecheck = (state: 'PERSISTENT' | 'INITIAL_ONLY' | 'LATE'): { readonly result: AuditRunResult; readonly target: Finding } => {
  const result = auditRun();
  const target = result.findings.find((finding) => finding.pageId !== null && finding.viewport !== null && finding.category !== 'SAFETY');
  if (target === undefined || target.pageId === null || target.viewport === null) {
    throw new Error('the sample run needs a site quality finding of a viewport');
  }
  const { pageId, viewport } = target;
  const recheck: ViewportRecheckRecord = {
    status: 'RECHECKED',
    reason: null,
    stateId: evidenceStateIdOf(pageId, viewport, 1),
    startedAt: '2026-11-10T00:00:00.000Z',
    finishedAt: '2026-11-10T00:00:01.000Z',
    settling: null,
    axeRuleIds: [],
    findings: [{ fingerprint: target.fingerprint, ruleId: target.ruleId, state }],
    headings: [],
  };
  const pages = result.pages.map((page) => (page.pageId !== pageId
    ? page
    : { ...page, viewports: { ...page.viewports, [viewport]: { ...page.viewports[viewport], recheck } } }));
  return { result: { ...result, pages }, target };
};

describe('AUD-2d: the view model separates the initial-only findings', () => {
  it('moves an INITIAL_ONLY finding out of the main findings, keeps it in its own list, and counts it', () => {
    const { result, target } = withRecheck('INITIAL_ONLY');
    const model = buildReportViewModel(result);

    const view = model.findings.find(({ finding }) => finding.findingId === target.findingId);
    expect(view?.verification.recheck).toBe('INITIAL_ONLY');
    expect(model.mainFindings.map(({ finding }) => finding.findingId)).not.toContain(target.findingId);
    expect(model.excludedFindings.map(({ finding }) => finding.findingId)).not.toContain(target.findingId);
    expect(model.initialOnlyFindings.map(({ finding }) => finding.findingId)).toEqual([target.findingId]);
    expect(model.summary.recheck.byMark.INITIAL_ONLY).toBe(1);
    expect(model.summary.recheck.initialOnlyFindingCounts.total).toBe(1);
    const page = model.pages.find(({ pageId }) => pageId === target.pageId);
    expect(page?.initialOnlyFindingIds).toEqual([target.findingId]);
    // 全部の指摘は消さない。
    expect(model.findings).toHaveLength(result.findings.length);
  });

  // AUD-2d の直し: 確かめ直しで新しく出た問題は、見落とさないために本体に入れ、印で分かるようにする。
  it('keeps a LATE finding in the main findings with its mark, and counts it', () => {
    const { result, target } = withRecheck('LATE');
    const model = buildReportViewModel(result);

    const view = model.mainFindings.find(({ finding }) => finding.findingId === target.findingId);
    expect(view?.verification.recheck).toBe('LATE');
    expect(model.initialOnlyFindings).toEqual([]);
    expect(model.summary.recheck.byMark.LATE).toBe(1);
  });

  it('keeps a PERSISTENT finding in the main findings, and marks the others NOT_RECHECKED', () => {
    const { result, target } = withRecheck('PERSISTENT');
    const model = buildReportViewModel(result);

    expect(model.mainFindings.map(({ finding }) => finding.findingId)).toContain(target.findingId);
    expect(model.initialOnlyFindings).toEqual([]);
    expect(model.summary.recheck.byMark.PERSISTENT).toBe(1);
    const others = model.findings.filter(({ finding }) => finding.findingId !== target.findingId);
    expect(others.every(({ verification }) => verification.recheck === 'NOT_RECHECKED')).toBe(true);
  });
});
