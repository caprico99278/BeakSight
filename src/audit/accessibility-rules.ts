import type { EvidenceId, Severity } from '../core/contracts.js';
import {
  ACCESSIBILITY_IMPACTS,
  type AccessibilityImpact,
  type AccessibilityNodeEvidence,
  type AccessibilityTargetSelector,
  type AccessibilityViolationEvidence,
} from '../core/evidence-types.js';
import type { FindingFingerprintIdentityField } from '../core/ids.js';
import { formatRatioFloor } from '../presentation/format.js';
import { CONTRAST_RATIO_TEXT, DISABLED_STATE_TEXT } from '../presentation/messages.js';
import { labelClassKeyOf, roundedTargetKeyOf } from './finding-grouping-keys.js';
import { LABEL_IN_NAME_RULE_ID, labelInNameIsFinding, labelInNameOf, type LabelInNameClass } from './label-in-name.js';
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
  // COV-6: 新しい記録は要素を全部持つ（`omittedNodeCount` は 0）。記録しなかった要素の件数は、古い版の記録を読むときだけ、起きた事実として出す。
  const legacyOmitted = violation.omittedNodeCount > 0;
  const facts = target === null
    ? `impact: ${impact ?? 'なし'}。対象の要素は記録されていません`
      + (legacyOmitted ? `（以前の版の記録で、件数の上限のため記録しなかった要素: ${violation.omittedNodeCount} 件）` : '')
    : `impact: ${impact ?? 'なし'}、対象: ${target}`;
  const omitted = target !== null && legacyOmitted
    ? `このルールには、以前の版の記録で件数の上限のため記録しなかった要素が、ほかに ${violation.omittedNodeCount} 件あります。`
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
  // AUD-8（4-3）: 支援技術に無効と伝わるのに axe が数えた要素（対象外の印）は、主の件数に入れない（Finding にしない）。見た目だけ無効の要素は残し、
  // 「無効の状態を支援技術に伝えていない」の事実を文言に足す。
  // APS-2: 名前の不一致は、指摘にする区分（`labelInNameIsFinding`）の要素だけを Finding にする（axe の違反は証拠に残る）。
  return violation.nodes
    .filter((node: AccessibilityNodeEvidence) => (node.countExclusion ?? null) === null)
    .filter((node: AccessibilityNodeEvidence) => ruleId !== LABEL_IN_NAME_RULE_ID || labelInNameIsFinding(labelClassOfNode(node)))
    .map((node: AccessibilityNodeEvidence) => {
      const value = draft(node.impact ?? violation.impact, formatTarget(node.targetSelectors), [
        { name: 'target', value: JSON.stringify(node.targetSelectors) },
      ]);
      // DEF-297: 対象の selector を丸めた形の鍵（fingerprint に入れず、候補群の鍵に入れる）。共通の枠の同じ部品の指摘を、ページをまたいで 1 つの群にする。
      const withRatio = { ...value, message: `${value.message}${contrastRatioNoteOf(node)}`, linkKeys: [roundedTargetKeyOf(node.targetSelectors)] };
      const disabledNote = disabledStateNoteOf(node);
      const withDisabled = disabledNote === '' ? withRatio : { ...withRatio, message: `${withRatio.message}${disabledNote}` };
      return ruleId === LABEL_IN_NAME_RULE_ID ? withLabelInNameClass(withDisabled, node) : withDisabled;
    });
};

/**
 * 名前の不一致の要素の区分（表示用モデルと同じ `labelInNameOf`）。APS-2: 名前の文脈がない・読めない要素は、かたまりを読めない区分（`UNDETERMINED`）。
 */
const labelClassOfNode = (node: AccessibilityNodeEvidence): LabelInNameClass => {
  const context = node.nameContext;
  return context === undefined || context.status !== 'READ'
    ? 'UNDETERMINED'
    : labelInNameOf({ name: context.axName, segments: context.labelSegments }).labelClass;
};

/**
 * AUD-5（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 8.3）: 名前の不一致の指摘に、区分の鍵（`labelClass`。区分の違う指摘を同じ群にしない）を
 * 足す。DEF-297: 区分の鍵は、丸めた対象の鍵の後ろに足す（selector と区分の両方で群にする）。APS-2: 名前の文脈を読めない指摘にも `UNDETERMINED` の鍵を付ける
 * （群の確信度を下げる印）。
 */
const withLabelInNameClass = (draft: FindingDraft, node: AccessibilityNodeEvidence): FindingDraft =>
  ({ ...draft, linkKeys: [...(draft.linkKeys ?? []), labelClassKeyOf(labelClassOfNode(node))] });

/**
 * EV-1: 色差の要素の、色から計算した丸める前の比と基準の文（比か基準がない要素・ほかの Rule の要素は空）。比は切り捨てて書く（基準に届かない値を、基準の値に
 * 丸めて見せない）。基準は確かめの data の `expectedContrastRatio`（`4.5:1` の形）。
 */
const contrastRatioNoteOf = (node: AccessibilityNodeEvidence): string => {
  const ratio = node.computedContrastRatio;
  const expected = node.checks?.map((check) => check.data['expectedContrastRatio']).find((value) => typeof value === 'string');
  const criterion = typeof expected === 'string' ? /^\s*([\d.]+)\s*:\s*1\s*$/u.exec(expected)?.[1] : undefined;
  return ratio === undefined || criterion === undefined ? '' : CONTRAST_RATIO_TEXT.message(formatRatioFloor(ratio), criterion);
};

/**
 * AUD-8（4-3）: 見た目だけ無効な要素の文言に足す事実（`DISABLED_STATE_TEXT`）。AUD-6（S-09）: `pointer-events: none` がなく `cursor: not-allowed` だけの要素は、
 * 見た目の指定の事実だけを書く（実際に押せないかは確かめていない）。判定と重さは変えない。見た目だけ無効でなければ空。
 */
const disabledStateNoteOf = (node: AccessibilityNodeEvidence): string => {
  // RVP-4: 名前の規則の対象（AX の名前の文脈を読んだ要素）が無効の状態なら、その事実を書く（読めないときは足さない）。
  if (node.nameContext?.status === 'READ' && node.nameContext.axDisabled) {
    return DISABLED_STATE_TEXT.nameRuleDisabledNote;
  }
  const facts = node.disabledFacts;
  if (facts?.status !== 'READ' || !facts.disabledStateNotExposed) {
    return '';
  }
  return facts.pointerEvents === 'none' ? DISABLED_STATE_TEXT.notExposedNote : DISABLED_STATE_TEXT.cursorOnlyNote;
};

/**
 * axe の violation を対応づける Rule を作る。`ruleIdFor` が null を返す violation は、この Rule の対象外。
 * axe の `incomplete`（判定できなかったもの）は Finding にしない。収集が `PARTIAL` でも、記録された violation は Finding にする。
 */
const axeViolationRule = (
  rule: Pick<AuditRule, 'ruleId' | 'ruleIdPrefix' | 'severity' | 'plainMessage'>,
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
    {
      ruleId: 'COLOR_CONTRAST_VIOLATION',
      severity: UNKNOWN_IMPACT_SEVERITY,
      plainMessage: '文字の色と後ろの色の差が小さく、文字が読みにくいところがあります。',
    },
    (axeRuleId) => (axeRuleId === AXE_COLOR_CONTRAST_RULE_ID ? 'COLOR_CONTRAST_VIOLATION' : null),
  ),
  axeViolationRule(
    {
      ruleId: 'A11Y_AXE',
      ruleIdPrefix: AXE_VIOLATION_RULE_ID_PREFIX,
      severity: UNKNOWN_IMPACT_SEVERITY,
      // OP-R2: 評価のたびに ruleId を作る Rule なので、種類（アクセシビリティ）の 1 つの文で、この群のすべての ruleId を受ける。
      plainMessage: '体の不自由な人や、読み上げのソフトを使う人にとって、使いにくいところがあります。',
    },
    (axeRuleId) => axeViolationFindingRuleIdOf(axeRuleId),
  ),
]);

/**
 * 接頭辞の Rule（`A11Y_AXE`）が、axe のルールの ID から作る Finding の ruleId（例: `document-title` → `A11Y_DOCUMENT_TITLE`）。色のコントラストは別の Rule が扱うので
 * `null`、英数字を含まない ID も `null`。BN-c の fix: Rule の性質の表（`src/audit/rule-block-sensitivity.ts`）の名前つきの行の元の ID を確かめるテストも、この
 * 変換を使う（変換を写さない）。
 */
export function axeViolationFindingRuleIdOf(axeRuleId: string): string | null {
  if (axeRuleId === AXE_COLOR_CONTRAST_RULE_ID) {
    return null;
  }
  const suffix = toUpperSnakeCase(axeRuleId);
  return suffix === null ? null : `${AXE_VIOLATION_RULE_ID_PREFIX}${suffix}`;
}
