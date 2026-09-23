import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from 'playwright';

export const ACCESSIBILITY_LIMITS = Object.freeze({
  maxHtmlSnippetLength: 512,
});

export type AccessibilityImpact = 'minor' | 'moderate' | 'serious' | 'critical' | null;
export type AccessibilityTargetSelector = string | readonly string[];

export interface AccessibilityNodeEvidence {
  readonly impact: AccessibilityImpact;
  readonly targetSelectors: readonly AccessibilityTargetSelector[];
  readonly failureSummary: string | null;
  readonly htmlSnippet: string;
}

export interface AccessibilityViolationEvidence {
  readonly ruleId: string;
  readonly impact: AccessibilityImpact;
  readonly help: string;
  readonly helpUrl: string;
  readonly tags: readonly string[];
  readonly nodes: readonly AccessibilityNodeEvidence[];
}

export interface AccessibilityEvidence {
  readonly violations: readonly AccessibilityViolationEvidence[];
}

function freezeTarget(target: readonly (string | readonly string[])[]): readonly AccessibilityTargetSelector[] {
  return Object.freeze(target.map((selector) => (
    typeof selector === 'string' ? selector : Object.freeze([...selector])
  )));
}

/** フィルタなしでaxeを実行し、検出された全違反をイミュータブルな証跡に変換する。 */
export async function collectAccessibilityEvidence(page: Page): Promise<AccessibilityEvidence> {
  const result = await new AxeBuilder({ page }).analyze();
  const violations = Object.freeze(result.violations.map((violation) => Object.freeze({
    ruleId: violation.id,
    impact: violation.impact ?? null,
    help: violation.help,
    helpUrl: violation.helpUrl,
    tags: Object.freeze([...violation.tags]),
    nodes: Object.freeze(violation.nodes.map((node) => Object.freeze({
      impact: node.impact ?? null,
      targetSelectors: freezeTarget(node.target),
      failureSummary: node.failureSummary ?? null,
      htmlSnippet: node.html.slice(0, ACCESSIBILITY_LIMITS.maxHtmlSnippetLength),
    }))),
  })));
  return Object.freeze({ violations });
}
