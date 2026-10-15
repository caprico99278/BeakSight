// 規則の集まりの digest の唯一の owner（Task 29 の設計書 3 章、4.1。T29a）。純粋な関数。
// - Task 28 の入力の規則の参照（`InputRuleReference`）の digest。形は承認の digest と同じ `sha256:<16進64桁>`（`createSha256Fingerprint`）。
// - 入力は、鍵を並べた JSON（`sortedKeysJsonOf`）。先頭の項目に文書の形の印（`RULE_SET_DIGEST_FORMAT`）を入れる。項目や並べ方を変えるときは、
//   印の版を上げる。
// - 項目（`RULE_SET_DIGEST_ITEMS`）: 規則の集まりの id、シナリオの id、欄ごとの規則（欄の名前、意味の種類、作り方、範囲、固定の値の一覧）、
//   欄どうしの関係（種類と役割ごとの欄の名前）、一意にする欄の組。契約にない項目は読まない。
// - 版と作成の時刻は入れない（版は参照が別に持つ。同じ中身の版は同じ digest になる）。
// - 並びの順に依らない所は、UTF-16 のコード単位の順（`compareCodeUnits`）に並べてから求める: 欄ごとの規則（欄の名前の順）、関係（関係ごとの
//   鍵を並べた JSON の順）、一意にする欄の組。固定の値の一覧の並びは意味を持つので並べ替えない（並びが変われば digest も変わる）。
import { createSha256Fingerprint } from '../../core/ids.js';
import { deepFreeze } from '../../core/immutable.js';
import { sortedKeysJsonOf } from '../../core/sorted-keys-json.js';
import { compareCodeUnits } from '../../core/text.js';
import type { InputRuleReference } from '../approval/scenario-contracts.js';
import {
  FIELD_RELATION_ROLES,
  relationFieldNamesOf,
  type FieldRelation,
  type FieldRule,
  type RuleSetRevision,
} from './rule-contracts.js';

/** 規則の集まりの digest の入力の形の印（版つき）。 */
export const RULE_SET_DIGEST_FORMAT = 'beaksight-data-rule-digest/1';

/** 規則の集まりの digest の項目（閉じた一覧。印のほか）。項目を足す・変えるときは、`RULE_SET_DIGEST_FORMAT` の版を上げる。 */
export const RULE_SET_DIGEST_ITEMS = Object.freeze(['ruleSetId', 'scenarioId', 'fieldRules', 'relations', 'uniqueKeyFieldNames'] as const);
export type RuleSetDigestItem = (typeof RULE_SET_DIGEST_ITEMS)[number];

/** 規則の集まりの digest が見る、版の項目。 */
export type RuleSetDigestSubject = Pick<RuleSetRevision, RuleSetDigestItem>;

/** digest の入力（鍵を並べた JSON にする前の値）。 */
export interface RuleSetDigestInput {
  readonly format: typeof RULE_SET_DIGEST_FORMAT;
  readonly ruleSetId: string;
  readonly scenarioId: string;
  readonly fieldRules: readonly FieldRule[];
  readonly relations: readonly Readonly<Record<string, string>>[];
  readonly uniqueKeyFieldNames: readonly string[];
}

/** 欄の規則 1 件の、契約の項目だけの写し。 */
const fieldRuleEntryOf = (rule: FieldRule): FieldRule => ({
  fieldName: rule.fieldName,
  semanticKind: rule.semanticKind,
  method: rule.method,
  range: rule.range === null ? null : { min: rule.range.min, max: rule.range.max, step: rule.range.step },
  fixedValues: [...rule.fixedValues],
});

/** 関係 1 件の、種類と役割の項目だけの写し。 */
const relationEntryOf = (relation: FieldRelation): Readonly<Record<string, string>> => {
  const names = relationFieldNamesOf(relation);
  return Object.fromEntries([['kind', relation.kind], ...FIELD_RELATION_ROLES[relation.kind].map((role, index) => [role, names[index] ?? ''])]);
};

/** digest の入力（純粋。入力を変えない。凍結）。並びの順に依らない所は並べ替えた値。 */
export const ruleSetDigestInputOf = (ruleSet: RuleSetDigestSubject): RuleSetDigestInput => deepFreeze({
  format: RULE_SET_DIGEST_FORMAT,
  ruleSetId: ruleSet.ruleSetId,
  scenarioId: ruleSet.scenarioId,
  fieldRules: ruleSet.fieldRules.map(fieldRuleEntryOf).sort((left, right) => compareCodeUnits(left.fieldName, right.fieldName)),
  relations: ruleSet.relations.map(relationEntryOf).sort((left, right) => compareCodeUnits(sortedKeysJsonOf(left), sortedKeysJsonOf(right))),
  uniqueKeyFieldNames: [...ruleSet.uniqueKeyFieldNames].sort(compareCodeUnits),
});

/** 規則の集まりの digest を求める（純粋。入力を変えない）。 */
export const computeRuleSetDigest = (ruleSet: RuleSetDigestSubject): string =>
  createSha256Fingerprint(sortedKeysJsonOf(ruleSetDigestInputOf(ruleSet)));

/** シナリオに付ける入力の規則の参照（Task 28 の `InputRuleReference`。id、版、digest。凍結）。 */
export const inputRuleReferenceOf = (ruleSet: RuleSetDigestSubject & Pick<RuleSetRevision, 'revision'>): InputRuleReference => Object.freeze({
  ruleSetId: ruleSet.ruleSetId,
  revision: ruleSet.revision,
  digest: computeRuleSetDigest(ruleSet),
});
