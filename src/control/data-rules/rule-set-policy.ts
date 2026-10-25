// 規則の集まりの保存の前の確かめ直し（Task 29 の設計書 4.1、4.3。T29a）。純粋な関数。手本は `src/control/approval/scenario-policy.ts` の
// `assertStorableScenarioRevision`。
// - スキーマ（`data-rule-v2`）で形を確かめ、凍結した写しを返す（保存の部品（T29d）が書く前に使う。新しく保存するのは版 2 だけ。FM2c）。
// - スキーマで表せない、文書の中の整合も確かめる: 欄ごとの規則の欄の名前は重ならない。欄どうしの関係の欄と、一意にする欄の組の欄は、欄ごとの
//   規則の欄。FM2c: 基準日からの幅は、範囲と一緒に持たず、始まりが終わりの後でない。番号・コードの桁の数は、番号・コードの規則だけ（fix round 1）。
//   意味の種類と欄の型の整合、範囲の値の解釈、固定の値と欄の制約の
//   整合は、欄の判定（T29c）が確かめる（ここでは見ない）。
// - 読み方（FM2c。手動の操作を減らす設計書 3A.3）: 保存してある文書を読むのは `ruleSetRevisionOfStoredDocument` の 1 か所。版 2 のスキーマで確かめる。
//   LG-3（2026-10-24 のテストの組の設計 3.7.2）: 版 1 の文書の読み替え（人の規則として読む）は捨てた。版 1 の文書は、形の誤り（`RangeError`）になる。
// - 通らなければ `RangeError`（呼び出し側の誤り）。誤りの文には、欄の名前と項目の位置だけを書く（固定の値は書かない）。
// - T29R-fix-1（M-4）: 秘密に見える名前の欄に、人の固定の値を残さない（設計書 10 章の 4。READ の確かめの定義と同じ方針
//   `isSecretUrlQueryParameterName`）。判定はここだけに置き、保存の部品（`rule-store.ts`）が拒み、画面は表示に使う（同じ判定を 2 か所に書かない）。
import { isSecretUrlQueryParameterName } from '../../core/secret-query-names.js';
import type { ControlSchemaName } from '../control-schema-validator.js';
import { requireSchemaCheckedCopy } from '../schema-checked-copy.js';
import {
  relationFieldNamesOf,
  ruleBaseDateWindowOf,
  ruleDigitCountOf,
  type RuleSetContent,
  type RuleSetRevision,
  type SemanticKind,
} from './rule-contracts.js';

/** 桁の数を持てる意味の種類（FM2c fix round 1）。 */
const DIGIT_CODE_KIND = 'DIGIT_CODE' satisfies SemanticKind;

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
    // FM2c fix round 1: 番号・コードの桁の数は、番号・コードの規則だけが持つ。
    ...ruleSet.fieldRules.flatMap((rule, index) => (ruleDigitCountOf(rule) === null || rule.semanticKind === DIGIT_CODE_KIND
      ? []
      : [`/fieldRules/${index} has a digit count without the digit code kind`])),
    ...ruleSet.fieldRules.flatMap((rule, index) => {
      const window = ruleBaseDateWindowOf(rule);
      if (window === null) {
        return [];
      }
      return [
        ...(rule.range === null ? [] : [`/fieldRules/${index} has both a range and a base date window`]),
        ...(window.fromDays <= window.toDays ? [] : [`/fieldRules/${index}/baseDateWindow starts after its end`]),
      ];
    }),
    ...ruleSet.relations.flatMap((relation, index) => relationFieldNamesOf(relation)
      .filter((name) => !known.has(name))
      .map((name) => `/relations/${index} refers to ${JSON.stringify(name)}, which has no field rule`)),
    ...ruleSet.uniqueKeyFieldNames
      .filter((name) => !known.has(name))
      .map((name) => `/uniqueKeyFieldNames refers to ${JSON.stringify(name)}, which has no field rule`),
  ];
};

/** スキーマ（版ごと）と文書の中の整合を確かめた、凍結した写し。 */
const checkedRuleSetOf = (schemaName: ControlSchemaName, document: unknown): RuleSetRevision => {
  // CCX-17（CC-077）: JSON の写し → スキーマ → 凍結の手順は `schema-checked-copy.ts`。凍結した写しで、文書の中の整合を確かめる。
  const checked = requireSchemaCheckedCopy<RuleSetRevision>(schemaName, 'rule set revision', document);
  const errors = consistencyErrorsOf(checked);
  if (errors.length > 0) {
    throw new RangeError(`the rule set revision is not consistent: ${errors.join('; ')}`);
  }
  return checked;
};

/** 規則の集まりの版の文書のスキーマ（版 2。保存も読み出しも、これだけ）。 */
const RULE_SET_SCHEMA_NAME = 'data-rule-v2' satisfies ControlSchemaName;

/** 保存の前の確かめ直し（規則の集まりの版 1 つ）。スキーマと文書の中の整合を確かめた、凍結した写しを返す。 */
export const assertStorableRuleSet = (ruleSet: RuleSetRevision): RuleSetRevision => checkedRuleSetOf(RULE_SET_SCHEMA_NAME, ruleSet);

/**
 * 保存してある文書を読む（読み方の 1 か所）。版 2 のスキーマと文書の中の整合を確かめた、凍結した写しを返す。版 2 でない文書（LG-3 で捨てた版 1 を
 * 含む）、形の違う文書は `RangeError`（保存の部品は `DATABASE_INTEGRITY_FAILED`）。
 */
export const ruleSetRevisionOfStoredDocument = (document: unknown): RuleSetRevision => checkedRuleSetOf(RULE_SET_SCHEMA_NAME, document);
