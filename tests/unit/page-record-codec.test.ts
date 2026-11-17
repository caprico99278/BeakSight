// REC-3（設計書 `2026-11-14-beaksight-slim-and-simplify-design.md` 5.3）: page.json と保存のページのディスクの形（`page-schema/2.0`）。
// 符号化して JSON にし、読んで戻すと、メモリの形の page と同じ文字列になる（種類ごと）。符号化した形は、page の schema に合う。
import { describe, expect, it } from 'vitest';
import type { EvidenceCapture, EvidenceRecord, PageAuditResult } from '../../src/core/contracts.js';
import type { AccessibilityRuleEvidence, LayoutEvidence, LayoutElementEvidence } from '../../src/core/evidence-types.js';
import { decodePageRecord, encodePageRecord, type PageRecord } from '../../src/core/page-record-codec.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { PAGE_1, page, record } from '../helpers/audit-run-fixture.js';

const capture = (phase: EvidenceCapture['phase']): EvidenceCapture => ({
  stateId: `${PAGE_1}:desktop:1` as EvidenceCapture['stateId'],
  phase,
  startedAt: '2026-11-15T00:00:00.000Z',
  finishedAt: '2026-11-15T00:00:01.000Z',
  url: null,
  scrollPosition: null,
});

const rect = { x: 0, y: 0, top: 0, right: 500, bottom: 20, left: 0, width: 500, height: 20 };
const visibility = { visible: true, display: 'block', visibility: 'visible', opacity: 1, hiddenAttribute: false, ariaHidden: false, clientRectCount: 1 };

const element = (selector: string): LayoutElementEvidence => ({
  selector, kind: 'link', rect, area: 10_000, visibility, position: 'static', zIndex: 'auto', overflowX: 'visible', overflowY: 'visible', fixedOrStickyAncestor: false,
});

const box = (selector: string, right: number) => ({
  selector, kind: 'table' as const, rect: { ...rect, right, width: right }, visibility, position: 'static', zIndex: 'auto', overflowX: 'visible', overflowY: 'visible',
  horizontalClipAncestor: 'NONE' as const, nearestListedAncestorIndex: null, outside: { left: false, right: true, top: false, bottom: false }, truncated: false,
});

const layoutOf = (boxes: LayoutEvidence['boxesOutsideViewport']): LayoutEvidence => ({
  scrollPosition: { scrollX: 0, scrollY: 0 },
  document: {
    viewportWidth: 390, viewportHeight: 800, documentElementClientWidth: 390, documentElementClientHeight: 800, documentElementScrollWidth: 600,
    documentElementScrollHeight: 2_000, bodyScrollWidth: 600, bodyScrollHeight: 2_000, bodyClientWidth: 390, bodyClientHeight: 2_000, horizontalOverflowPx: 210,
    viewportHorizontalClip: 'NONE',
  },
  boxesOutsideViewport: boxes,
  zeroSizeInteractive: [],
  clippedText: [],
  fixedHeadingOverlaps: [],
  // 同じ要素（#a）が 2 つの組に出る。
  elementOverlaps: [
    { first: element('#a'), second: element('#b'), intersection: { ...rect, area: 100 }, truncated: false },
    { first: element('#a'), second: element('#c'), intersection: { ...rect, area: 100 }, truncated: false },
  ],
  fixedElements: [],
  truncation: {
    omittedOutsideViewportCount: 0, omittedZeroSizeInteractiveCount: 0, omittedClippedTextCount: 0, omittedFixedHeadingOverlapCount: 0,
    omittedElementOverlapCount: 0, omittedFixedElementCount: 0, overlapComparisonLimitReached: false, clippedTextNodeScanLimitReachedCount: 0,
    renderedDescendantScanLimitReachedCount: 0,
  },
});

const rule = (ruleId: string, selectors: readonly string[]): AccessibilityRuleEvidence => ({
  ruleId, impact: 'serious', help: `${ruleId} help`, helpUrl: `https://example.invalid/${ruleId}`, tags: ['wcag2aa'], omittedNodeCount: 0,
  nodes: selectors.map((selector) => ({
    impact: 'serious', targetSelectors: [selector], failureSummary: 'Fix the following: …', htmlSnippet: `<span id="${selector.slice(1)}">`, truncated: false,
  })),
});

const axe = (violations: readonly AccessibilityRuleEvidence[]) => ({
  status: 'COMPLETE' as const, frameScope: 'SAME_ORIGIN_ONLY' as const, scrollPosition: { scrollX: 0, scrollY: 0 }, violations, incomplete: [],
});

/** 1 回目の layout・axe と、落ち着いた後の確かめ直し（1 つだけ違う）を持つページ。 */
function samplePage(): PageAuditResult {
  const firstBoxes = [box('#t1', 600), box('#t2', 600), box('#t3', 600)];
  const evidence: EvidenceRecord[] = [
    { ...record('layout', 1, PAGE_1, 'desktop', { primary: { status: 'COMPLETE', layout: layoutOf(firstBoxes) }, stressSweep: null }), capture: capture('layout') },
    { ...record('accessibility', 2, PAGE_1, 'desktop', axe([rule('color-contrast', ['#x1', '#x2', '#x3'])])), capture: capture('accessibility') },
    { ...record('accessibility', 3, PAGE_1, 'desktop', axe([rule('color-contrast', ['#x1', '#x2', '#x3']), rule('label', ['#i1', '#i2'])])), capture: capture('recheck') },
    {
      ...record('layout', 4, PAGE_1, 'desktop', { primary: { status: 'COMPLETE', layout: layoutOf([...firstBoxes.slice(0, 2), box('#t3', 650)]) }, stressSweep: null }),
      capture: capture('recheck'),
    },
  ];
  return page(PAGE_1, '/', 'AUDITED', evidence);
}

/** ディスクに書いて読んだ形（JSON の往復）。 */
const throughDisk = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('REC-3: the form of a page on the disk', () => {
  it('shortens the layout (the same fields, the table of the overlap elements, the recheck) and decodes it back to the same page', async () => {
    const memory = throughDisk(samplePage());
    const encoded = throughDisk(encodePageRecord(memory)) as PageRecord & { readonly evidence: readonly Record<string, any>[] };

    expect(JSON.stringify(decodePageRecord(encoded))).toBe(JSON.stringify(memory));
    expect(encoded.schemaVersion).toBe('page-schema/2.0');
    await expect(validateArtifact('page', encoded)).resolves.toEqual({ ok: true });
    const first = encoded.evidence[0]?.payload.primary.layout;
    expect(first.boxesOutsideViewport.common).toMatchObject({ kind: 'table', outside: { right: true } });
    expect(first.elementOverlaps.map(({ first: a, second: b }: { first: number; second: number }) => [a, b])).toEqual([[0, 1], [0, 2]]);
    expect(first.overlapElements.map(({ selector }: { selector: string }) => selector)).toEqual(['#a', '#b', '#c']);
    const recheck = encoded.evidence[3];
    expect(recheck?.recheckBase).toBe(encoded.evidence[0]?.evidenceId);
    expect(recheck?.payload.primary.layout.boxesOutsideViewport).toEqual([{ sameAs: 0 }, { sameAs: 1 }, expect.objectContaining({ selector: '#t3' })]);
    expect(recheck?.payload.primary.layout.elementOverlaps).toEqual([{ sameAs: 0 }, { sameAs: 1 }]);
  });

  it('shortens the axe Evidence (the same fields of the nodes, the recheck) and decodes it back to the same page', async () => {
    const memory = throughDisk(samplePage());
    const encoded = throughDisk(encodePageRecord(memory)) as PageRecord & { readonly evidence: readonly Record<string, any>[] };

    expect(JSON.stringify(decodePageRecord(encoded))).toBe(JSON.stringify(memory));
    await expect(validateArtifact('page', encoded)).resolves.toEqual({ ok: true });
    expect(encoded.evidence[1]?.payload.violations[0].nodes.common).toEqual({ impact: 'serious', failureSummary: 'Fix the following: …', truncated: false });
    const recheck = encoded.evidence[2];
    expect(recheck?.recheckBase).toBe(encoded.evidence[1]?.evidenceId);
    expect(recheck?.payload.violations).toEqual([{ sameAs: 0 }, expect.objectContaining({ ruleId: 'label' })]);
  });

  it('refuses a rechecked Evidence whose first Evidence is missing', () => {
    const encoded = throughDisk(encodePageRecord(throughDisk(samplePage())));
    const broken = { ...encoded, evidence: encoded.evidence.slice(2) };

    expect(() => decodePageRecord(broken)).toThrow(RangeError);
  });
});
