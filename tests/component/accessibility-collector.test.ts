import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProgressSignalKind, ProgressSignals } from '../../src/core/progress-watch.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';

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
// L2: 期限を受けないときは、進みの見張り（ページの自発の変化の印の受け口 `on`・`off`・`isClosed`）を付ける。偽のページは事象を出さず、
// 画面の変化の読み取り（CDP）もできないので、ページの自発の変化の印は付かない。
const fakePage = {
  evaluate: async () => {
    scrollControl.reads += 1;
    return scrollControl.read();
  },
  on: () => undefined,
  off: () => undefined,
  isClosed: () => false,
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

    const evidence = await collectAccessibilityEvidence(fakePage);

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
    await collectAccessibilityEvidence(fakePage);

    expect(axeControl.legacyModeAtAnalyze).toEqual([true]);
  });

  it('records that the audit scope is limited to same-origin documents in COMPLETE evidence (DEF-001b)', async () => {
    const evidence = await collectAccessibilityEvidence(fakePage);

    expect(evidence).toEqual({
      status: 'COMPLETE',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      frameScope: 'SAME_ORIGIN_ONLY',
      violations: [],
      incomplete: [],
    });
  });

  it('LZ-2: keeps long failure summaries and selectors whole', async () => {
    const longSelector = `#${'s'.repeat(513)}`;
    const longSummary = 'f'.repeat(2_049);
    axeControl.analyze = async () => ({
      violations: [rawRule('color-contrast', [rawNode({ failureSummary: longSummary, target: [longSelector, ['#host', longSelector]] })])],
      incomplete: [],
    });

    const evidence = await collectAccessibilityEvidence(fakePage);
    expect(evidence.violations[0]?.nodes[0]).toMatchObject({
      failureSummary: longSummary,
      targetSelectors: [longSelector, ['#host', longSelector]],
      truncated: false,
    });
  });

  it('COV-6: records every node of a rule (no count limit) and keeps omittedNodeCount at 0', async () => {
    const extra = 7;
    axeControl.analyze = async () => ({
      violations: [rawRule('image-alt', Array.from(
        { length: 100 + extra },
        (_value, index) => rawNode({ target: [`#image-${index}`] }),
      ))],
      incomplete: [rawRule('color-contrast', [rawNode()])],
    });

    const evidence = await collectAccessibilityEvidence(fakePage);

    expect(evidence.violations[0]?.nodes).toHaveLength(100 + extra);
    expect(evidence.violations[0]?.nodes.at(-1)?.targetSelectors).toEqual([`#image-${100 + extra - 1}`]);
    expect(evidence.violations[0]?.omittedNodeCount).toBe(0);
    expect(evidence.incomplete[0]?.omittedNodeCount).toBe(0);
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

    const evidence = await collectAccessibilityEvidence(fakePage);

    expect(evidence).toMatchObject({ status: 'COMPLETE', scrollPosition: { scrollX: 0, scrollY: 640 } });
    expect(order).toEqual(['scroll', 'axe']);
    expect(Object.isFrozen(evidence.scrollPosition)).toBe(true);
  });

  it('returns evaluation PARTIAL without running axe when the scroll position cannot be read, with the same-origin scope (R4 M1, DEF-001b)', async () => {
    scrollControl.read = async () => ({ scrollX: Number.NaN, scrollY: 0 });

    const evidence = await collectAccessibilityEvidence(fakePage);

    expect(evidence).toMatchObject({ status: 'PARTIAL', reason: 'EVALUATION_FAILED', scrollPosition: null, frameScope: 'SAME_ORIGIN_ONLY' });
    expect(axeControl.constructed).toBe(0);
  });

  it('returns explicit evaluation PARTIAL evidence when axe fails', async () => {
    axeControl.analyze = async () => {
      throw new Error('axe injection failed');
    };

    const evidence = await collectAccessibilityEvidence(fakePage);

    expect(evidence).toEqual({
      status: 'PARTIAL',
      reason: 'EVALUATION_FAILED',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      frameScope: 'SAME_ORIGIN_ONLY',
      violations: [],
      incomplete: [],
    });
  });

  it('L2: without a deadline, waits for an axe run longer than 30 seconds and keeps its results', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    axeControl.analyze = () => new Promise((resolve) => {
      setTimeout(() => resolve({ violations: [rawRule('image-alt', [rawNode()])], incomplete: [] }), 120_000);
    });

    let settled = false;
    const pending = collectAccessibilityEvidence(fakePage).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);

    const evidence = await pending;
    expect(evidence.status).toBe('COMPLETE');
    expect(evidence.violations.map((rule) => rule.ruleId)).toEqual(['image-alt']);
  });

  it('L2: without a deadline, ends as unresponsive only after the quiet limit and keeps the scroll position read before it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    axeControl.analyze = () => new Promise(() => undefined);
    const quietLimitMs = 5_000;

    let settled = false;
    const pending = collectAccessibilityEvidence(fakePage, { watch: { quietLimitMs } }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(quietLimitMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual({
      status: 'PARTIAL',
      reason: 'STAGE_UNRESPONSIVE',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      frameScope: 'SAME_ORIGIN_ONLY',
      violations: [],
      incomplete: [],
    });
  });

  it('L2: without a deadline, keeps the axe results when the reading of the disabled facts stops responding', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_000);
    axeControl.analyze = async () => ({ violations: [rawRule('color-contrast', [rawNode()])], incomplete: [] });
    let reads = 0;
    scrollControl.read = () => {
      reads += 1;
      // 1 回目はスクロール位置、2 回目（無効の事実）は返らない。
      return reads === 1 ? Promise.resolve({ scrollX: 0, scrollY: 0 }) : new Promise(() => undefined);
    };
    const quietLimitMs = 5_000;

    const pending = collectAccessibilityEvidence(fakePage, { watch: { quietLimitMs } });
    await vi.advanceTimersByTimeAsync(quietLimitMs);

    const evidence = await pending;
    expect(evidence).toMatchObject({ status: 'PARTIAL', reason: 'STAGE_UNRESPONSIVE' });
    expect(evidence.violations[0]?.nodes[0]?.disabledFacts).toEqual({ status: 'NOT_READ' });
  });

  it('L1b: uses only the caller progress port and marks the progress of each browser call on it', async () => {
    const marks: string[] = [];
    const mark = (kind: ProgressSignalKind): void => {
      marks.push(kind);
    };
    const progress: ProgressSignals = {
      signal: new AbortController().signal,
      mark,
      track: (call) => Promise.resolve(call).finally(() => mark('BROWSER_RESPONSE')),
    };

    const evidence = await collectAccessibilityEvidence(fakePage, { watch: { progress } });

    expect(evidence.status).toBe('COMPLETE');
    // スクロール位置と axe の 2 回の呼び出し。
    expect(marks.filter((kind) => kind === 'BROWSER_RESPONSE')).toHaveLength(2);
  });

  it('L1b: returns the records collected so far in the same turn when the caller watch ends the stage', async () => {
    axeControl.analyze = () => new Promise(() => undefined);
    const controller = new AbortController();
    const progress: ProgressSignals = { signal: controller.signal, mark: () => undefined, track: (call) => Promise.resolve(call) };

    const pending = collectAccessibilityEvidence(fakePage, { watch: { progress } });
    await vi.waitFor(() => expect(axeControl.constructed).toBe(1));
    controller.abort('STAGE_UNRESPONSIVE');
    const inThisTurn = await Promise.race([pending, new Promise<null>((resolve) => {
      setImmediate(() => resolve(null));
    })]);

    expect(inThisTurn).toEqual({
      status: 'PARTIAL',
      reason: 'STAGE_UNRESPONSIVE',
      scrollPosition: { scrollX: 0, scrollY: 0 },
      frameScope: 'SAME_ORIGIN_ONLY',
      violations: [],
      incomplete: [],
    });
  });
});
