import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SELECTOR_LENGTH } from '../../src/core/limits.js';
import {
  ACCESSIBILITY_LIMITS,
  collectAccessibilityEvidence,
} from '../../src/evidence/accessibility-collector.js';

const axeControl = vi.hoisted(() => ({
  analyze: (): Promise<unknown> => Promise.resolve({ violations: [], incomplete: [] }),
  constructed: 0,
  /** `analyze()` を呼んだ時点の `setLegacyMode()` の値（呼ばれていなければ `false`）。 */
  legacyModeAtAnalyze: [] as boolean[],
}));

vi.mock('@axe-core/playwright', () => ({
  AxeBuilder: class {
    #legacyMode = false;

    constructor() {
      axeControl.constructed += 1;
    }

    setLegacyMode(legacyMode = true): this {
      this.#legacyMode = legacyMode;
      return this;
    }

    analyze(): Promise<unknown> {
      axeControl.legacyModeAtAnalyze.push(this.#legacyMode);
      return axeControl.analyze();
    }
  },
}));

interface RawNode {
  readonly impact?: string | null;
  readonly target: readonly (string | readonly string[])[];
  readonly failureSummary?: string;
  readonly html: string;
}

function rawRule(id: string, nodes: readonly RawNode[]): Record<string, unknown> {
  return {
    id,
    impact: 'serious',
    help: `${id} help`,
    helpUrl: `https://rules.test/${id}`,
    tags: ['wcag2aa'],
    nodes,
  };
}

function rawNode(overrides: Partial<RawNode> = {}): RawNode {
  return {
    impact: 'serious',
    target: ['#target'],
    failureSummary: 'Fix any of the following: short summary',
    html: '<p id="target">text</p>',
    ...overrides,
  };
}

/** 偽のページ。文書のスクロール位置の読み取り（`page.evaluate`）だけに応える。 */
const scrollControl = vi.hoisted(() => ({
  read: (): Promise<unknown> => Promise.resolve({ scrollX: 0, scrollY: 0 }),
  reads: 0,
}));
const fakePage = {
  evaluate: async () => {
    scrollControl.reads += 1;
    return scrollControl.read();
  },
} as unknown as Page;

afterEach(() => {
  axeControl.analyze = () => Promise.resolve({ violations: [], incomplete: [] });
  axeControl.constructed = 0;
  axeControl.legacyModeAtAnalyze = [];
  scrollControl.read = () => Promise.resolve({ scrollX: 0, scrollY: 0 });
  scrollControl.reads = 0;
  vi.useRealTimers();
});

describe('collectAccessibilityEvidence', () => {
  it('records axe incomplete results separately from violations', async () => {
    axeControl.analyze = async () => ({
      violations: [rawRule('image-alt', [rawNode()])],
      incomplete: [rawRule('color-contrast', [rawNode({ failureSummary: 'Background could not be determined' })])],
    });

    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });

    expect(evidence.status).toBe('COMPLETE');
    expect(evidence.violations.map((rule) => rule.ruleId)).toEqual(['image-alt']);
    expect(evidence.incomplete.map((rule) => rule.ruleId)).toEqual(['color-contrast']);
    expect(evidence.incomplete[0]?.nodes[0]).toMatchObject({
      failureSummary: 'Background could not be determined',
      targetSelectors: ['#target'],
      truncated: false,
    });
    expect(Object.isFrozen(evidence.incomplete)).toBe(true);
    expect(Object.isFrozen(evidence.incomplete[0]?.nodes[0])).toBe(true);
  });

  it('runs axe in legacy mode so that it never opens another page in the guarded Context', async () => {
    await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });

    expect(axeControl.legacyModeAtAnalyze).toEqual([true]);
  });

  it('records that the audit scope is limited to same-origin documents in COMPLETE evidence (DEF-001b)', async () => {
    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });

    expect(evidence).toEqual({
      status: 'COMPLETE',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      frameScope: 'SAME_ORIGIN_ONLY',
      violations: [],
      incomplete: [],
    });
  });

  it('records the same-origin audit scope in PARTIAL evidence even when axe never started (DEF-001b)', async () => {
    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() - 1 });

    expect(evidence).toMatchObject({ status: 'PARTIAL', frameScope: 'SAME_ORIGIN_ONLY' });
  });

  it('bounds failure summaries, selectors, and snippets and marks truncated nodes', async () => {
    const longSelector = `#${'s'.repeat(MAX_SELECTOR_LENGTH + 10)}`;
    axeControl.analyze = async () => ({
      violations: [rawRule('color-contrast', [
        rawNode({
          failureSummary: 'f'.repeat(ACCESSIBILITY_LIMITS.maxFailureSummaryLength + 10),
          target: [longSelector, ['#host', longSelector]],
        }),
        rawNode(),
      ])],
      incomplete: [],
    });

    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });
    const [truncatedNode, intactNode] = evidence.violations[0]?.nodes ?? [];

    expect(truncatedNode?.failureSummary).toBe('f'.repeat(ACCESSIBILITY_LIMITS.maxFailureSummaryLength));
    expect(truncatedNode?.targetSelectors).toEqual([
      longSelector.slice(0, MAX_SELECTOR_LENGTH),
      ['#host', longSelector.slice(0, MAX_SELECTOR_LENGTH)],
    ]);
    expect(truncatedNode?.truncated).toBe(true);
    expect(intactNode?.truncated).toBe(false);
  });

  it('bounds the number of nodes per rule and records how many were omitted', async () => {
    const extra = 7;
    axeControl.analyze = async () => ({
      violations: [rawRule('image-alt', Array.from(
        { length: ACCESSIBILITY_LIMITS.maxNodesPerRule + extra },
        (_value, index) => rawNode({ target: [`#image-${index}`] }),
      ))],
      incomplete: [rawRule('color-contrast', [rawNode()])],
    });

    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });

    expect(evidence.violations[0]?.nodes).toHaveLength(ACCESSIBILITY_LIMITS.maxNodesPerRule);
    expect(evidence.violations[0]?.omittedNodeCount).toBe(extra);
    expect(evidence.incomplete[0]?.omittedNodeCount).toBe(0);
  });

  it('returns explicit deadline PARTIAL evidence when axe does not finish before the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    let rejectLate: ((reason: unknown) => void) | undefined;
    axeControl.analyze = () => new Promise((_resolve, reject) => {
      rejectLate = reject;
    });

    const pending = collectAccessibilityEvidence(fakePage, { deadlineAtMs: 50_020 });
    await vi.advanceTimersByTimeAsync(20);
    const evidence = await pending;
    rejectLate?.(new Error('late axe failure'));
    await Promise.resolve();

    expect(evidence).toEqual({
      status: 'PARTIAL',
      reason: 'DEADLINE_EXCEEDED',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      frameScope: 'SAME_ORIGIN_ONLY',
      violations: [],
      incomplete: [],
    });
    expect(Object.isFrozen(evidence)).toBe(true);
  });

  it('does not start axe when the deadline has already passed', async () => {
    const analyze = vi.fn(async () => ({ violations: [], incomplete: [] }));
    axeControl.analyze = analyze;

    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() - 1 });

    expect(evidence).toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
    expect(analyze).not.toHaveBeenCalled();
    expect(axeControl.constructed).toBe(0);
    // 期限を過ぎていれば、スクロール位置も読まない（読めなかったことを null で記録する）。
    expect(evidence.scrollPosition).toBeNull();
    expect(scrollControl.reads).toBe(0);
  });

  it('records the document scroll position read just before axe runs (R4 M1)', async () => {
    const order: string[] = [];
    scrollControl.read = async () => {
      order.push('scroll');
      return { scrollX: 0, scrollY: 640 };
    };
    axeControl.analyze = async () => {
      order.push('axe');
      return { violations: [], incomplete: [] };
    };

    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });

    expect(evidence).toMatchObject({ status: 'COMPLETE', scrollPosition: { scrollX: 0, scrollY: 640 } });
    expect(order).toEqual(['scroll', 'axe']);
    expect(Object.isFrozen(evidence.scrollPosition)).toBe(true);
  });

  it('returns evaluation PARTIAL without running axe when the scroll position cannot be read (R4 M1)', async () => {
    scrollControl.read = async () => ({ scrollX: Number.NaN, scrollY: 0 });

    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });

    expect(evidence).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED', scrollPosition: null });
    expect(axeControl.constructed).toBe(0);
  });

  it('returns explicit evaluation PARTIAL evidence when axe fails before the deadline', async () => {
    axeControl.analyze = async () => {
      throw new Error('axe injection failed');
    };

    const evidence = await collectAccessibilityEvidence(fakePage, { deadlineAtMs: Date.now() + 1_000 });

    expect(evidence).toEqual({
      status: 'PARTIAL',
      reason: 'EVALUATION_FAILED',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      frameScope: 'SAME_ORIGIN_ONLY',
      violations: [],
      incomplete: [],
    });
  });

  it('applies the default deadline when the caller does not pass one', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    axeControl.analyze = () => new Promise(() => undefined);

    const pending = collectAccessibilityEvidence(fakePage);
    await vi.advanceTimersByTimeAsync(ACCESSIBILITY_LIMITS.defaultTimeoutMs);

    await expect(pending).resolves.toMatchObject({ status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' });
  });

  it('rejects a non-finite deadline as a caller error', async () => {
    await expect(collectAccessibilityEvidence(fakePage, { deadlineAtMs: Number.NaN }))
      .rejects.toThrow('Accessibility collection deadline must be finite');
    expect(axeControl.constructed).toBe(0);
  });
});
