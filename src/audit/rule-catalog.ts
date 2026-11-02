import { isPositiveSafeInteger } from '../core/guards.js';
import { ACCESSIBILITY_RULES } from './accessibility-rules.js';
import { LAYOUT_RULES } from './layout-rules.js';
import { PERFORMANCE_RULES } from './performance-rules.js';
import type { AuditRule } from './rule.js';
import { SAFETY_RULES } from './safety-rules.js';
import { TECHNICAL_RULES } from './technical-rules.js';

/**
 * `freezeCatalog` が検査する、Rule の定義のうちの識別の部分。page rule（`AuditRule`）と Cross-page rule（`CrossPageRule`）の
 * どちらも満たす。
 */
export type CatalogRuleIdentity = Pick<AuditRule, 'ruleId' | 'ruleIdPrefix' | 'version'>;

/**
 * Finding（下書き）の ruleId が、その Rule のものか（`AuditRule` の ruleId の決まり）。`ruleIdPrefix` を持たない Rule は ruleId が一致するもの、持つ Rule は
 * ruleId がその接頭辞で始まり、かつ接頭辞より長いもの。Rule Engine の下書きの検査と、Finding の ruleId から Rule の定義を引く処理（`ruleOfFindingRuleId`）が使う。
 */
export const isFindingRuleIdOf = (rule: Pick<CatalogRuleIdentity, 'ruleId' | 'ruleIdPrefix'>, ruleId: string): boolean => {
  const prefix = rule.ruleIdPrefix;
  return prefix === undefined ? ruleId === rule.ruleId : ruleId.startsWith(prefix) && ruleId.length > prefix.length;
};

/**
 * OP-R2: Finding の ruleId を持つ Rule の定義（`freezeCatalog` で検査した一覧から。どの Rule のものでもなければ `undefined`）。検査した一覧では、ruleId と接頭辞が
 * 重ならないので、当たる Rule は高々 1 つである。
 */
export const ruleOfFindingRuleId = <TRule extends CatalogRuleIdentity>(rules: readonly TRule[], ruleId: string): TRule | undefined =>
  rules.find((rule) => isFindingRuleIdOf(rule, ruleId));

/**
 * Rule の一覧を検査し、凍結した一覧を登録の順のまま返す。登録先ではなく、検査と凍結だけを行う。
 * page rule の一覧（`RULE_CATALOG`）と Cross-page rule の一覧（`CROSS_PAGE_RULES`）が、同じこの検査を使う。
 * - ruleId が空でない文字列でない場合は `TypeError` を投げる。
 * - version が正の整数でない場合は `RangeError` を投げる。
 * - 同じ ruleId が2回以上ある場合は `Error` を投げる。
 * - `ruleIdPrefix` があり、空でない文字列でない場合は `TypeError` を投げる。
 * - ほかの Rule の ruleId が、ある Rule の `ruleIdPrefix` で始まる場合は `Error` を投げる（Rule 自身の ruleId は対象外）。
 * - 2つの Rule の `ruleIdPrefix` が互いに接頭辞の関係にある（同じ場合を含む）場合は `Error` を投げる。
 * 各 Rule のオブジェクトも凍結する。
 * @param registeredRules 検査済みの別の一覧（例: Cross-page rule から見た `RULE_CATALOG`）。`rules` との ruleId の重複と、
 *   接頭辞の衝突（上の2つ）を、あわせて検査する。この一覧は返さず、凍結もしない。
 */
export const freezeCatalog = <TRule extends CatalogRuleIdentity>(
  rules: readonly TRule[],
  registeredRules: readonly CatalogRuleIdentity[] = [],
): readonly TRule[] => {
  const seenRuleIds = new Set<string>(registeredRules.map((rule) => rule.ruleId));
  for (const rule of rules) {
    if (typeof rule.ruleId !== 'string' || rule.ruleId.length === 0) {
      throw new TypeError('rule id must be a non-empty string');
    }
    if (!isPositiveSafeInteger(rule.version)) {
      throw new RangeError(`rule version must be a positive safe integer: ${rule.ruleId}`);
    }
    if (rule.ruleIdPrefix !== undefined && (typeof rule.ruleIdPrefix !== 'string' || rule.ruleIdPrefix.length === 0)) {
      throw new TypeError(`rule id prefix must be a non-empty string: ${rule.ruleId}`);
    }
    if (seenRuleIds.has(rule.ruleId)) {
      throw new Error(`rule id is registered more than once: ${rule.ruleId}`);
    }
    seenRuleIds.add(rule.ruleId);
  }
  assertRuleIdPrefixesAreExclusive([...registeredRules, ...rules]);
  return Object.freeze(rules.map((rule) => Object.freeze(rule)));
};

/** 接頭辞を持つ Rule について、ほかの Rule の ruleId と接頭辞が、その接頭辞と重ならないことを検査する。 */
const assertRuleIdPrefixesAreExclusive = (rules: readonly CatalogRuleIdentity[]): void => {
  for (const prefixed of rules) {
    const prefix = prefixed.ruleIdPrefix;
    if (prefix === undefined) {
      continue;
    }
    for (const other of rules) {
      if (other === prefixed) {
        continue;
      }
      if (other.ruleId.startsWith(prefix)) {
        throw new Error(`rule id ${other.ruleId} starts with the rule id prefix ${prefix} of ${prefixed.ruleId}`);
      }
      const otherPrefix = other.ruleIdPrefix;
      if (otherPrefix !== undefined && (otherPrefix.startsWith(prefix) || prefix.startsWith(otherPrefix))) {
        throw new Error(
          `rule id prefixes overlap: ${prefix} of ${prefixed.ruleId} and ${otherPrefix} of ${other.ruleId}`,
        );
      }
    }
  }
};

/** すべての page rule の唯一の登録先（実装タスク指示 ARCH07）。Rule を加えるときは、各 Rule のファイルの配列に加える。 */
export const RULE_CATALOG: readonly AuditRule[] = freezeCatalog([
  ...TECHNICAL_RULES,
  ...LAYOUT_RULES,
  ...ACCESSIBILITY_RULES,
  ...PERFORMANCE_RULES,
  ...SAFETY_RULES,
]);

/**
 * OP-R2: Finding の ruleId を持つ page rule の、やさしい文（`AuditRule.plainMessage`）。どの page rule のものでもなければ `null`。Rule を評価しない。
 * 報告は、Cross-page rule とあわせて引く `rulePlainMessageOf`（`./cross-page-rules.ts`）を使う。
 */
export const pageRulePlainMessageOf = (ruleId: string): string | null => ruleOfFindingRuleId(RULE_CATALOG, ruleId)?.plainMessage ?? null;
