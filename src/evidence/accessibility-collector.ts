import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';
import { readDocumentScrollPosition } from '../browser/controlled-scroll.js';
import type { PartialFailureReason } from '../core/contracts.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import type {
  AccessibilityEvidence,
  AccessibilityNodeEvidence,
  AccessibilityRuleEvidence,
  AccessibilityTargetSelector,
  ScrollPosition,
} from '../core/evidence-types.js';
import { MAX_SELECTOR_LENGTH } from '../core/limits.js';
import { truncateText } from '../core/text.js';

export const ACCESSIBILITY_LIMITS = Object.freeze({
  maxHtmlSnippetLength: 512,
  /** `failureSummary` の最大長（UTF-16 のコード単位）。 */
  maxFailureSummaryLength: 2_048,
  /** 1つのルールについて記録する要素の最大件数。超えた分は件数だけを記録する。 */
  maxNodesPerRule: 100,
  /** 期限を指定されなかったときの、axe の実行の期限（ミリ秒）。 */
  defaultTimeoutMs: 30_000,
});

export interface AccessibilityCollectionOptions {
  /** axe の実行の期限（`Date.now()` の絶対時刻）。省略時は呼び出し時点から `defaultTimeoutMs` 後。 */
  readonly deadlineAtMs: number;
}

/**
 * 検査の範囲。レガシーの方式の axe は対象の page の中だけで実行するので、同じOriginの文書だけを検査する。
 * COMPLETE と PARTIAL のどちらの証跡にも、この値を記録する（DEF-001b）。
 */
const FRAME_SCOPE: AccessibilityEvidence['frameScope'] = 'SAME_ORIGIN_ONLY';

type AxeResults = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeRule = AxeResults['violations'][number];
type AxeNode = AxeRule['nodes'][number];

function boundedTarget(target: readonly (string | readonly string[])[]): {
  readonly selectors: readonly AccessibilityTargetSelector[];
  readonly truncated: boolean;
} {
  let truncated = false;
  const bound = (selector: string): string => {
    const bounded = truncateText(selector, MAX_SELECTOR_LENGTH);
    truncated ||= bounded.truncated;
    return bounded.text;
  };
  const selectors = Object.freeze(target.map((selector) => (
    typeof selector === 'string' ? bound(selector) : Object.freeze(selector.map(bound))
  )));
  return { selectors, truncated };
}

function nodeEvidence(node: AxeNode): AccessibilityNodeEvidence {
  const target = boundedTarget(node.target);
  const failureSummary = node.failureSummary === undefined
    ? null
    : truncateText(node.failureSummary, ACCESSIBILITY_LIMITS.maxFailureSummaryLength);
  const htmlSnippet = truncateText(node.html, ACCESSIBILITY_LIMITS.maxHtmlSnippetLength);
  return Object.freeze({
    impact: node.impact ?? null,
    targetSelectors: target.selectors,
    failureSummary: failureSummary?.text ?? null,
    htmlSnippet: htmlSnippet.text,
    truncated: target.truncated || (failureSummary?.truncated ?? false) || htmlSnippet.truncated,
  });
}

function ruleEvidence(rule: AxeRule): AccessibilityRuleEvidence {
  const retainedNodes = rule.nodes.slice(0, ACCESSIBILITY_LIMITS.maxNodesPerRule);
  return Object.freeze({
    ruleId: rule.id,
    impact: rule.impact ?? null,
    help: rule.help,
    helpUrl: rule.helpUrl,
    tags: Object.freeze([...rule.tags]),
    nodes: Object.freeze(retainedNodes.map(nodeEvidence)),
    omittedNodeCount: rule.nodes.length - retainedNodes.length,
  });
}

function partial(
  reason: Exclude<PartialFailureReason, 'PAGE_CLOSED'>,
  scrollPosition: Readonly<ScrollPosition> | null,
): AccessibilityEvidence {
  return Object.freeze({
    status: 'PARTIAL',
    reason,
    scrollPosition,
    frameScope: FRAME_SCOPE,
    violations: Object.freeze([]),
    incomplete: Object.freeze([]),
  });
}

/**
 * フィルタなしでaxeを期限付きで実行し、違反（`violations`）と要確認（`incomplete`）を別々に、
 * 上限付きのイミュータブルな証跡に変換する。期限切れと実行の失敗は、理由付きの `PARTIAL` で返す。
 *
 * axe はレガシーの方式（`setLegacyMode(true)`）で、対象の page の中だけで実行する。既定の方式は、
 * 結果をまとめるために同じ Context に別の page を開いて閉じるため、Passive Request Guard が
 * その page の CDP セッションの切り離しを不変条件の違反として記録し、Context を閉じてしまう（DEF-001）。
 * この方式では、axe は同じOriginの文書だけを検査し、別Originの iframe の中は検査しない
 * （別Originの iframe は Passive Context の許可Originの外なので、もともと監査の対象外である）。
 * この制約は、証跡の `frameScope` に記録する。
 *
 * axe を実行する直前に、文書のスクロール位置を読み、`scrollPosition` に記録する（R4 の M1）。位置を読む前に期限を過ぎた場合と、
 * 位置を読めなかった場合は、axe を実行せずに `scrollPosition: null` の `PARTIAL` を返す。
 */
export async function collectAccessibilityEvidence(
  page: Page,
  options: AccessibilityCollectionOptions = { deadlineAtMs: Date.now() + ACCESSIBILITY_LIMITS.defaultTimeoutMs },
): Promise<AccessibilityEvidence> {
  const { deadlineAtMs } = options;
  if (!Number.isFinite(deadlineAtMs)) {
    throw new Error('Accessibility collection deadline must be finite');
  }
  if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', null);

  const read = await awaitBeforeDeadline(readDocumentScrollPosition(page), deadlineAtMs);
  if (read.status === 'DEADLINE_EXCEEDED') return partial('DEADLINE_EXCEEDED', null);
  if (read.status === 'REJECTED') {
    return Date.now() >= deadlineAtMs ? partial('DEADLINE_EXCEEDED', null) : partial('EVALUATION_FAILED', null);
  }
  const scrollPosition = read.value;
  if (Date.now() >= deadlineAtMs) return partial('DEADLINE_EXCEEDED', scrollPosition);

  const analyzed = await awaitBeforeDeadline(new AxeBuilder({ page }).setLegacyMode(true).analyze(), deadlineAtMs);
  if (analyzed.status === 'DEADLINE_EXCEEDED') return partial('DEADLINE_EXCEEDED', scrollPosition);
  if (analyzed.status === 'REJECTED') {
    return Date.now() >= deadlineAtMs
      ? partial('DEADLINE_EXCEEDED', scrollPosition)
      : partial('EVALUATION_FAILED', scrollPosition);
  }
  return Object.freeze({
    status: 'COMPLETE',
    scrollPosition,
    frameScope: FRAME_SCOPE,
    violations: Object.freeze(analyzed.value.violations.map(ruleEvidence)),
    incomplete: Object.freeze(analyzed.value.incomplete.map(ruleEvidence)),
  });
}
