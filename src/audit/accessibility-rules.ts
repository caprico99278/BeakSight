import type { EvidenceId, Severity } from '../core/contracts.js';
import {
  ACCESSIBILITY_IMPACTS,
  type AccessibilityImpact,
  type AccessibilityNodeEvidence,
  type AccessibilityTargetSelector,
  type AccessibilityViolationEvidence,
} from '../core/evidence-types.js';
import type { FindingFingerprintIdentityField } from '../core/ids.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import { evidenceOfType } from './rule-helpers.js';

/** `COLOR_CONTRAST_VIOLATION` に対応づける axe のルールID。 */
const AXE_COLOR_CONTRAST_RULE_ID = 'color-contrast';

/** そのほかの axe の violation の ruleId の接頭辞（Task 12・13 の設計書 第6章の ruleId の決まり）。 */
const AXE_VIOLATION_RULE_ID_PREFIX = 'A11Y_';

/** axe の impact から severity への対応（Task 12・13 の設計書 5.3）。 */
const IMPACT_SEVERITIES: Readonly<Record<NonNullable<AccessibilityImpact>, Severity>> = Object.freeze({
  critical: 'ERROR',
  serious: 'ERROR',
  moderate: 'WARN',
  minor: 'INFO',
});

/** impact がない場合と、不明な値の場合の severity（設計書 5.3）。 */
const UNKNOWN_IMPACT_SEVERITY: Severity = 'WARN';

/** 文言で、shadow DOM や iframe の中の要素の selector の段をつなぐ記号。 */
const NESTED_SELECTOR_SEPARATOR = ' >>> ';

const RULE_VERSION = 1;

const severityForImpact = (impact: AccessibilityImpact): Severity =>
  impact !== null && (ACCESSIBILITY_IMPACTS as readonly string[]).includes(impact)
    ? IMPACT_SEVERITIES[impact]
    : UNKNOWN_IMPACT_SEVERITY;

/**
 * axe のルールIDを、大文字の snake case にする（例: `image-alt` → `IMAGE_ALT`）。英数字以外の連続を `_` にし、前後の `_` を除く。
 * 英数字を含まない場合は null。
 */
const toUpperSnakeCase = (axeRuleId: string): string | null => {
  const converted = axeRuleId.replace(/[^A-Za-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').toUpperCase();
  return converted.length > 0 ? converted : null;
};

const formatTarget = (targetSelectors: readonly AccessibilityTargetSelector[]): string =>
  targetSelectors
    .map((selector) => (typeof selector === 'string' ? selector : selector.join(NESTED_SELECTOR_SEPARATOR)))
    .join(', ');

interface ViolationDraftSpec {
  readonly ruleId: string;
  readonly violation: AccessibilityViolationEvidence;
  readonly evidenceId: EvidenceId;
}

const violationMessage = (
  violation: AccessibilityViolationEvidence,
  impact: AccessibilityImpact,
  target: string | null,
): string => {
  const facts = target === null
    ? `impact: ${impact ?? 'なし'}。対象の要素は記録されていません（件数の上限のため記録しなかった要素: `
      + `${violation.omittedNodeCount} 件）`
    : `impact: ${impact ?? 'なし'}、対象: ${target}`;
  const omitted = target !== null && violation.omittedNodeCount > 0
    ? `このルールには、件数の上限のため記録しなかった要素が、ほかに ${violation.omittedNodeCount} 件あります。`
    : '';
  const help = violation.help.length > 0 ? `axe の説明: ${violation.help}` : '';
  return `axe のルール「${violation.ruleId}」の違反を検出しました（${facts}）。${omitted}${help}`;
};

/**
 * 1つの violation から下書きを作る。記録された要素ごとに1件（同一性は axe の target）。要素の impact がなければ、ルールの impact を使う。
 * 記録された要素がない場合は、ルール単位の1件にする。
 */
const violationDrafts = ({ ruleId, violation, evidenceId }: ViolationDraftSpec): readonly FindingDraft[] => {
  const draft = (
    impact: AccessibilityImpact,
    target: string | null,
    identityFields: readonly FindingFingerprintIdentityField[],
  ): FindingDraft => ({
    ruleId,
    ruleVersion: RULE_VERSION,
    category: 'ACCESSIBILITY',
    severity: severityForImpact(impact),
    message: violationMessage(violation, impact, target),
    evidenceRefs: [evidenceId],
    identityFields,
  });
  if (violation.nodes.length === 0) {
    return [draft(violation.impact, null, [])];
  }
  return violation.nodes.map((node: AccessibilityNodeEvidence) =>
    draft(node.impact ?? violation.impact, formatTarget(node.targetSelectors), [
      { name: 'target', value: JSON.stringify(node.targetSelectors) },
    ]));
};

/**
 * axe の violation を対応づける Rule を作る。`ruleIdFor` が null を返す violation は、この Rule の対象外。
 * axe の `incomplete`（判定できなかったもの）は Finding にしない。収集が `PARTIAL` でも、記録された violation は Finding にする。
 */
const axeViolationRule = (
  rule: Pick<AuditRule, 'ruleId' | 'ruleIdPrefix' | 'severity'>,
  ruleIdFor: (axeRuleId: string) => string | null,
): AuditRule => ({
  ...rule,
  version: RULE_VERSION,
  category: 'ACCESSIBILITY',
  evaluate(input: PageRuleInput): readonly FindingDraft[] {
    const drafts: FindingDraft[] = [];
    for (const record of evidenceOfType(input, 'accessibility')) {
      for (const violation of record.payload.violations) {
        const ruleId = ruleIdFor(violation.ruleId);
        if (ruleId !== null) {
          drafts.push(...violationDrafts({ ruleId, violation, evidenceId: record.evidenceId }));
        }
      }
    }
    return drafts;
  },
});

/** アクセシビリティの page rule（axe の結果の対応づけ。T12c）の一覧。登録は `RULE_CATALOG`（`./rule-catalog.ts`）がまとめて行う。 */
export const ACCESSIBILITY_RULES: readonly AuditRule[] = Object.freeze([
  axeViolationRule(
    { ruleId: 'COLOR_CONTRAST_VIOLATION', severity: UNKNOWN_IMPACT_SEVERITY },
    (axeRuleId) => (axeRuleId === AXE_COLOR_CONTRAST_RULE_ID ? 'COLOR_CONTRAST_VIOLATION' : null),
  ),
  axeViolationRule(
    { ruleId: 'A11Y_AXE', ruleIdPrefix: AXE_VIOLATION_RULE_ID_PREFIX, severity: UNKNOWN_IMPACT_SEVERITY },
    (axeRuleId) => {
      if (axeRuleId === AXE_COLOR_CONTRAST_RULE_ID) {
        return null;
      }
      const suffix = toUpperSnakeCase(axeRuleId);
      return suffix === null ? null : `${AXE_VIOLATION_RULE_ID_PREFIX}${suffix}`;
    },
  ),
]);
