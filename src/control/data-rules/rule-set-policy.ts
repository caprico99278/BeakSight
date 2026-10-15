// 規則の集まりの保存の前の確かめ直し（Task 29 の設計書 4.1、4.3。T29a）。純粋な関数。手本は `src/control/approval/scenario-policy.ts` の
// `assertStorableScenarioRevision`。
// - スキーマ（`data-rule`）で形を確かめ、凍結した写しを返す（保存の部品（T29d）が書く前と読んだ後に使う）。
// - スキーマで表せない、文書の中の整合も確かめる: 欄ごとの規則の欄の名前は重ならない。欄どうしの関係の欄と、一意にする欄の組の欄は、欄ごとの
//   規則の欄。意味の種類と欄の型の整合、範囲の値の解釈、固定の値と欄の制約の整合は、欄の判定（T29c）が確かめる（ここでは見ない）。
// - 通らなければ `RangeError`（呼び出し側の誤り）。誤りの文には、欄の名前と項目の位置だけを書く（固定の値は書かない）。
// - T29R-fix-1（M-4）: 秘密に見える名前の欄に、人の固定の値を残さない（設計書 10 章の 4。READ の確かめの定義と同じ方針
//   `isSecretUrlQueryParameterName`）。判定はここだけに置き、保存の部品（`rule-store.ts`）が拒み、画面は表示に使う（同じ判定を 2 か所に書かない）。
import { isSecretUrlQueryParameterName } from '../../core/secret-query-names.js';
import { requireSchemaCheckedCopy } from '../schema-checked-copy.js';
import { relationFieldNamesOf, type RuleSetContent, type RuleSetRevision } from './rule-contracts.js';

/** 欄の名前が、人の固定の値を残せない（秘密に見える）名前か。 */
export const ruleFieldNameRejectsFixedValues = (fieldName: string): boolean => isSecretUrlQueryParameterName(fieldName);

/** 規則の中身に、秘密に見える名前の欄の人の固定の値があるか（保存の部品が拒む）。 */
export const ruleSetHasSecretFieldFixedValues = (content: Pick<RuleSetContent, 'fieldRules'>): boolean =>
  content.fieldRules.some((rule) => rule.fixedValues.length > 0 && ruleFieldNameRejectsFixedValues(rule.fieldName));

/** 文書の中の整合の誤り（英語の診断の文）。 */
const consistencyErrorsOf = (ruleSet: RuleSetRevision): readonly string[] => {
  const names = ruleSet.fieldRules.map((rule) => rule.fieldName);
  const known = new Set(names);
  return [
    ...names.flatMap((name, index) => (names.indexOf(name) === index ? [] : [`/fieldRules/${index}/fieldName ${JSON.stringify(name)} is a duplicate`])),
    ...ruleSet.relations.flatMap((relation, index) => relationFieldNamesOf(relation)
      .filter((name) => !known.has(name))
      .map((name) => `/relations/${index} refers to ${JSON.stringify(name)}, which has no field rule`)),
    ...ruleSet.uniqueKeyFieldNames
      .filter((name) => !known.has(name))
      .map((name) => `/uniqueKeyFieldNames refers to ${JSON.stringify(name)}, which has no field rule`),
  ];
};

/** 保存の前の確かめ直し（規則の集まりの版 1 つ）。スキーマと文書の中の整合を確かめた、凍結した写しを返す。 */
export const assertStorableRuleSet = (ruleSet: RuleSetRevision): RuleSetRevision => {
  // CCX-17（CC-077）: JSON の写し → スキーマ → 凍結の手順は `schema-checked-copy.ts`。凍結した写しで、文書の中の整合を確かめる。
  const checked = requireSchemaCheckedCopy<RuleSetRevision>('data-rule', 'rule set revision', ruleSet);
  const errors = consistencyErrorsOf(checked);
  if (errors.length > 0) {
    throw new RangeError(`the rule set revision is not consistent: ${errors.join('; ')}`);
  }
  return checked;
};
