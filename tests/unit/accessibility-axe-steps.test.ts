/**
 * RB-10: axe の読みの手順（スクロール位置 → axe → 要素の事実）を、口の 4 操作（`AccessibilityAxePort`）で確かめる（ブラウザを使わない）。
 * 本物の axe の答え・legacy の方式（別の page を開かない。DEF-001）は、結合とずれの確かめが受け持つ。
 */
import { describe, expect, it } from 'vitest';
import { collectAccessibilityWith, type AccessibilityAxePort } from '../../src/evidence/accessibility-collector.js';
import type { ProgressSignals } from '../../src/core/progress-watch.js';

const SIGNALS: ProgressSignals = { signal: new AbortController().signal, mark: () => undefined, track: async (call) => call };
/** axe が何も見つけなかった答え（違反と要確認だけを読む）。 */
const NO_RESULTS = { violations: [], incomplete: [] } as unknown as Awaited<ReturnType<AccessibilityAxePort['analyze']>>;

/** 口の答え（省略は成功）と、呼ばれた操作の記録。 */
const portOf = (overrides: Partial<AccessibilityAxePort>, calls: string[]): AccessibilityAxePort => ({
  readScrollPosition: async () => { calls.push('scroll'); return { scrollX: 0, scrollY: 40 }; },
  analyze: async () => { calls.push('axe'); return NO_RESULTS; },
  readTargets: async () => { calls.push('targets'); return []; },
  readAxFacts: async () => { calls.push('ax'); return { contrastAxDisabled: [], nameContexts: [] }; },
  ...overrides,
});

describe('collectAccessibilityWith: the steps of the axe read through the port', () => {
  it('does not run axe when the scroll position cannot be read', async () => {
    const calls: string[] = [];
    const evidence = await collectAccessibilityWith(portOf({ readScrollPosition: async () => { throw new Error('closed'); } }, calls), SIGNALS);
    expect(evidence).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED', scrollPosition: null });
    expect(calls).toEqual([]);
  });

  it('keeps the scroll position when axe fails', async () => {
    const calls: string[] = [];
    const evidence = await collectAccessibilityWith(portOf({ analyze: async () => { throw new Error('axe failed'); } }, calls), SIGNALS);
    expect(evidence).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED', scrollPosition: { scrollX: 0, scrollY: 40 } });
    expect(calls).toEqual(['scroll']);
  });

  it('completes without reading the elements when axe finds nothing', async () => {
    const calls: string[] = [];
    const evidence = await collectAccessibilityWith(portOf({}, calls), SIGNALS);
    expect(evidence).toMatchObject({ status: 'COMPLETE', violations: [], incomplete: [] });
    expect(calls).toEqual(['scroll', 'axe']);
  });

  // AUD-6（S-10）: axe が切り詰めた抜粋の印、重複 ID の他の出現の目印（selector だけ）、名前の規則の違反の要素の名前の根拠を残す。
  it('keeps the truncation by axe, the selectors of the related nodes, and the name source of an element without a name', async () => {
    const analyzed = { incomplete: [], violations: [
      { id: 'duplicate-id', impact: 'minor', help: 'h', helpUrl: 'u', tags: [], nodes: [{
        impact: 'minor', target: ['#dup'], html: '<div id="dup" class="card" ...>', failureSummary: null,
        any: [{ id: 'duplicate-id', data: 'dup', relatedNodes: [{ target: ['main > #dup'], html: '<p id="dup">本文</p>' }] }], all: [], none: [],
      }] },
      { id: 'button-name', impact: 'critical', help: 'h', helpUrl: 'u', tags: [], nodes: [{
        impact: 'critical', target: ['#icon'], html: '<button id="icon"></button>', failureSummary: null, any: [], all: [], none: [],
      }] },
    ] } as unknown as Awaited<ReturnType<AccessibilityAxePort['analyze']>>;
    const context = { status: 'READ', axName: null, axRole: 'button', axDisabled: false, nameSource: { type: 'contents', attribute: null }, labelSegments: [] } as const;
    const evidence = await collectAccessibilityWith(portOf({
      analyze: async () => analyzed,
      readAxFacts: async () => ({ contrastAxDisabled: [], nameContexts: [context] }),
    }, []), SIGNALS);
    const [duplicate, button] = evidence.violations.map((rule) => rule.nodes[0]);
    expect(duplicate).toMatchObject({ truncated: true, truncationKind: 'SOURCE_TRUNCATED' });
    expect(JSON.stringify(duplicate?.checks)).toContain('main > #dup');
    expect(JSON.stringify(duplicate?.checks)).not.toContain('本文');
    expect(button).toMatchObject({ truncated: false, nameContext: { nameSource: { type: 'contents' } } });
  });
});
