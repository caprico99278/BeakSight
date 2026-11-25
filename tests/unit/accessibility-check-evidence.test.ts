// AUD-8（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-8。指摘書の項目 8・4-3）: axe の判定の根拠（確かめの data・測れない理由・
// 省略の欄・無効の事実）を Evidence に残すことを、axe の結果の偽物と偽のページで確かめる。ブラウザを使わない。
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccessibilityNodeEvidence } from '../../src/core/evidence-types.js';
import {
  ACCESSIBILITY_CHECK_DATA_ALLOWLIST,
  collectAccessibilityEvidence,
  disabledFactsEvidenceOf,
} from '../../src/evidence/accessibility-collector.js';

const axeControl = vi.hoisted(() => ({
  analyze: (): Promise<unknown> => Promise.resolve({ violations: [], incomplete: [] }),
}));

vi.mock('@axe-core/playwright', () => ({
  AxeBuilder: class {
    setLegacyMode(): this {
      return this;
    }

    analyze(): Promise<unknown> {
      return axeControl.analyze();
    }
  },
}));

afterEach(() => {
  axeControl.analyze = () => Promise.resolve({ violations: [], incomplete: [] });
});

interface RawCheck {
  readonly id: string;
  readonly data: unknown;
  readonly relatedNodes?: readonly unknown[];
  readonly message?: string;
}

const rawNode = (
  target: readonly (string | readonly string[])[],
  checks: { readonly any?: readonly RawCheck[]; readonly all?: readonly RawCheck[]; readonly none?: readonly RawCheck[] },
  overrides: Record<string, unknown> = {},
) => ({
  impact: 'serious',
  target,
  html: '<a id="t">text</a>',
  failureSummary: 'Fix any of the following: ...',
  any: checks.any ?? [],
  all: checks.all ?? [],
  none: checks.none ?? [],
  ...overrides,
});

const rawRule = (id: string, nodes: readonly unknown[]) => ({ id, impact: 'serious', help: `${id} help`, helpUrl: `https://rules.test/${id}`, tags: ['wcag2aa'], nodes });

/** 偽のページ: 1 回目はスクロール位置、2 回目（無効の事実の読み取り）は `facts` を返す。読み取りの引数を記録する。 */
const fakePage = (facts: unknown): { readonly page: Page; readonly reads: unknown[] } => {
  const reads: unknown[] = [];
  const page = {
    evaluate: async (_fn: unknown, argument?: unknown) => {
      if (argument === undefined) {
        return { scrollX: 0, scrollY: 0 };
      }
      reads.push(argument);
      return facts;
    },
  } as unknown as Page;
  return { page, reads };
};

const CONTRAST_DATA = {
  fgColor: '#777777',
  bgColor: '#ffffff',
  contrastRatio: 4.48,
  fontSize: '12.0pt (16px)',
  fontWeight: 'normal',
  messageKey: null,
  expectedContrastRatio: '4.5:1',
  shadowColor: undefined,
  // 許可の外の欄（残さない）。
  unexpectedField: 'should not be kept',
};

const readFacts = {
  matchesDisabled: false,
  disabledAttribute: null,
  ariaDisabled: null,
  inert: null,
  pointerEvents: 'auto',
  cursor: 'pointer',
  tabIndexNegative: false,
};

/** 呼ぶ側の段の見張りの口（偽のページは事象を出さないので、自分で見張らせない）。 */
const collect = async (page: Page) => collectAccessibilityEvidence(page, {
  watch: { progress: { signal: new AbortController().signal, mark: () => undefined, track: (call) => Promise.resolve(call) } },
});

const firstNode = (nodes: readonly AccessibilityNodeEvidence[] | undefined): AccessibilityNodeEvidence => {
  const [node] = nodes ?? [];
  expect(node).toBeDefined();
  return node as AccessibilityNodeEvidence;
};

describe('AUD-8: 確かめの data', () => {
  it('色差の data（許可した欄だけ）が、確かめごとに残る', async () => {
    axeControl.analyze = async () => ({
      violations: [rawRule('color-contrast', [rawNode(['#t'], { any: [{ id: 'color-contrast', data: CONTRAST_DATA, relatedNodes: [{ html: '<div>' }] }] })])],
      incomplete: [],
    });
    const { page } = fakePage([readFacts]);
    const evidence = await collect(page);
    const node = firstNode(evidence.violations[0]?.nodes);
    expect(node.checks).toEqual([{
      id: 'color-contrast',
      group: 'any',
      result: 'FAILED',
      messageKey: null,
      data: {
        fgColor: '#777777',
        bgColor: '#ffffff',
        contrastRatio: 4.48,
        expectedContrastRatio: '4.5:1',
        fontSize: '12.0pt (16px)',
        fontWeight: 'normal',
      },
    }]);
    expect(JSON.stringify(node)).not.toContain('should not be kept');
  });

  it('許可の一覧にない Rule の確かめは、data を残さない（id と結果だけ）。名前の不一致は受け皿だけ', async () => {
    expect(ACCESSIBILITY_CHECK_DATA_ALLOWLIST['label-content-name-mismatch']).toEqual([]);
    axeControl.analyze = async () => ({
      violations: [rawRule('image-alt', [rawNode(['img'], { any: [{ id: 'has-alt', data: { secretish: 'value' } }], none: [{ id: 'alt-space-value', data: 'text' }] })])],
      incomplete: [],
    });
    const { page, reads } = fakePage([]);
    const evidence = await collect(page);
    const node = firstNode(evidence.violations[0]?.nodes);
    expect(node.checks).toEqual([
      { id: 'has-alt', group: 'any', result: 'FAILED', messageKey: null, data: {} },
      { id: 'alt-space-value', group: 'none', result: 'FAILED', messageKey: null, data: {} },
    ]);
    // 色差でない Rule の要素は、無効の事実を読まない。AUD-3d の続き: 違反の要素なので、矩形だけを読む（読み取りの形が違うので、矩形は `NOT_READ`）。
    // DEF-310（RVP-5）: 名前の規則（`NAME_CONTEXT_AXE_RULE_IDS`。`image-alt` を含む）の違反の要素は、`aria-labelledby` の参照先も読む。
    expect(reads).toEqual([{ targets: [{ target: ['img'], disabled: false, region: true, labelledBy: true }] }]);
    expect(node.disabledFacts).toBeNull();
    expect(node.region).toEqual({ status: 'UNREADABLE', reason: 'NOT_READ' });
  });
});

describe('AUD-8: 測れない理由', () => {
  it('incomplete の messageKey が残る（結果は UNDETERMINED）', async () => {
    axeControl.analyze = async () => ({
      violations: [],
      incomplete: [rawRule('color-contrast', [rawNode(['#bg'], { any: [{ id: 'color-contrast', data: { ...CONTRAST_DATA, messageKey: 'bgImage' } }] })])],
    });
    const { page } = fakePage([readFacts]);
    const evidence = await collect(page);
    const node = firstNode(evidence.incomplete[0]?.nodes);
    expect(node.checks?.[0]).toMatchObject({ id: 'color-contrast', result: 'UNDETERMINED', messageKey: 'bgImage' });
  });
});

describe('AUD-8: 省略の欄の明示', () => {
  it('LZ-2: 長い欄（要約・HTML の抜粋・確かめの data）も切らず、省略の一覧は空', async () => {
    const summary = 's'.repeat(2_049);
    const html = 'h'.repeat(513);
    const color = 'c'.repeat(257);
    axeControl.analyze = async () => ({
      violations: [rawRule('color-contrast', [rawNode(['#fg'], { any: [{ id: 'color-contrast', data: { ...CONTRAST_DATA, fgColor: color } }] }, { failureSummary: summary, html })])],
      incomplete: [],
    });
    const { page } = fakePage([readFacts]);
    const node = firstNode((await collect(page)).violations[0]?.nodes);
    expect(node).toMatchObject({ failureSummary: summary, htmlSnippet: html, truncated: false, truncations: [] });
    expect(node.checks?.[0]?.data).toMatchObject({ fgColor: color });
  });
});

describe('AUD-8: 無効の事実（4-3）', () => {
  it('支援技術に無効と伝わるもの（aria-disabled の祖先など）は、主の件数から外す印を付ける', () => {
    const facts = disabledFactsEvidenceOf({ ...readFacts, ariaDisabled: 'ANCESTOR' });
    expect(facts).toMatchObject({ status: 'READ', ariaDisabled: 'ANCESTOR', axDisabled: null, disabledForAssistiveTech: true, disabledStateNotExposed: false });
  });

  it('見た目だけ無効（cursor: not-allowed・pointer-events: none）は外さず、「無効の状態を支援技術に伝えていない」の事実を付ける', () => {
    expect(disabledFactsEvidenceOf({ ...readFacts, cursor: 'not-allowed' })).toMatchObject({
      disabledForAssistiveTech: false,
      disabledStateNotExposed: true,
    });
    expect(disabledFactsEvidenceOf({ ...readFacts, pointerEvents: 'none' })).toMatchObject({ disabledStateNotExposed: true });
    // 薄い見た目だけ（無効の手がかりなし）では、どちらにもしない。
    expect(disabledFactsEvidenceOf(readFacts)).toMatchObject({ disabledForAssistiveTech: false, disabledStateNotExposed: false });
  });

  it('読めなかった・見つからなかった要素は、それと分かる状態にする', () => {
    expect(disabledFactsEvidenceOf(null)).toEqual({ status: 'NOT_FOUND' });
    expect(disabledFactsEvidenceOf({ unexpected: true })).toEqual({ status: 'NOT_READ' });
  });

  it('色差の要素ごとに無効の事実を読み、支援技術に無効と伝わる要素に対象外の印を付ける', async () => {
    axeControl.analyze = async () => ({
      violations: [rawRule('color-contrast', [
        rawNode(['#visual'], { any: [{ id: 'color-contrast', data: CONTRAST_DATA }] }),
        rawNode([['#host', '#inner']], { any: [{ id: 'color-contrast', data: CONTRAST_DATA }] }),
      ])],
      incomplete: [],
    });
    // AUD-3d の続き: 無効の手がかりと矩形を、1 回のページの中の読み取りで読む（読み取りの結果は、スクロール位置と、対象ごとの事実）。
    const box = { x: 1, y: 2, top: 2, right: 11, bottom: 22, left: 1, width: 10, height: 20 };
    const { page, reads } = fakePage({
      scrollPosition: { scrollX: 0, scrollY: 5 },
      items: [
        { disabled: { ...readFacts, cursor: 'not-allowed' }, region: { rect: box } },
        { disabled: { ...readFacts, matchesDisabled: true, disabledAttribute: 'ANCESTOR' }, region: { reason: 'NOT_FOUND' } },
      ],
    });
    const evidence = await collect(page);
    expect(reads).toEqual([expect.objectContaining({
      // DEF-310（RVP-5）: 色差の Rule は名前の規則でないので、参照先は読まない。
      targets: [
        { target: ['#visual'], disabled: true, region: true, labelledBy: false },
        { target: [['#host', '#inner']], disabled: true, region: true, labelledBy: false },
      ],
    })]);
    const [visual, disabled] = evidence.violations[0]?.nodes ?? [];
    expect(visual).toMatchObject({ countExclusion: null, disabledFacts: { status: 'READ', disabledStateNotExposed: true }, region: { status: 'READ', rect: box } });
    expect(disabled).toMatchObject({
      countExclusion: 'DISABLED_FOR_ASSISTIVE_TECH',
      disabledFacts: { disabledAttribute: 'ANCESTOR', disabledForAssistiveTech: true },
      region: { status: 'UNREADABLE', reason: 'NOT_FOUND' },
    });
    expect(evidence.regionScrollPosition).toEqual({ scrollX: 0, scrollY: 5 });
  });

  it('無効の事実の読み取りが失敗しても、axe の結果は残す（無効の事実は NOT_READ）', async () => {
    axeControl.analyze = async () => ({
      violations: [rawRule('color-contrast', [rawNode(['#t'], { any: [{ id: 'color-contrast', data: CONTRAST_DATA }] })])],
      incomplete: [],
    });
    const page = {
      evaluate: async (_fn: unknown, argument?: unknown) => {
        if (argument === undefined) return { scrollX: 0, scrollY: 0 };
        throw new Error('read failed');
      },
    } as unknown as Page;
    const evidence = await collect(page);
    expect(evidence.status).toBe('COMPLETE');
    expect(firstNode(evidence.violations[0]?.nodes)).toMatchObject({ disabledFacts: { status: 'NOT_READ' }, countExclusion: null });
  });
});
