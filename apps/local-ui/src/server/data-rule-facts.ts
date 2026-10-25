/**
 * シナリオの入力の規則の今の事実（Task 29 の設計書 4.4。T29e）。サーバだけで使う（ブラウザ側のコードは import しない。`data-rule-functions.ts` と
 * `scenario-functions.ts`、FM2b から `scenario-autodraft-functions.ts`（規則の集まりの id）だけが使う。Gate `local-ui-boundary` の (i)）。
 * - 規則の集まりの最新の版（なければ、人の規則のない空の版）を、シナリオの今の版と発見の根拠の写しに照らして `evaluateRuleSet` にかける（判定の owner は
 *   `src/control/data-rules/field-evaluation.ts`。ここではやり直さない）。状態は `display/data-rules.ts` の `inputRuleStateOf` が選ぶ。
 */
import type { ScenarioView } from '../../../../src/control/approval-view.js';
import {
  RULE_SET_SCHEMA_VERSION,
  evaluateRuleSet,
  readLatestRuleSet,
  type RuleSetContent,
  type RuleSetEvaluation,
  type RuleSetRevision,
} from '../../../../src/control/data-rules-view.js';
import { inputRuleStateOf, type InputRuleState } from '../display/data-rules';
import { localUiStore } from './control-store';

/** 規則の集まりの id の頭（シナリオごとに 1 つ。シナリオの id をつなぐ）。 */
const RULE_SET_ID_PREFIX = 'rules-';
/** 判定のための仮の版の番号（まだ保存していないとき。保存はしない）。 */
const UNSAVED_REVISION = 1;

/** 空の中身（人の規則なし）。 */
export const EMPTY_RULE_CONTENT: RuleSetContent = Object.freeze({ fieldRules: [], relations: [], uniqueKeyFieldNames: [] });

/** シナリオの規則の集まりの id（まだ保存していないとき）。 */
export const defaultRuleSetIdOf = (scenarioId: string): string => `${RULE_SET_ID_PREFIX}${scenarioId}`;

/** 判定に渡す規則の集まり（保存した最新の版か、まだなければ人の規則のない空の版）。 */
export const ruleSetForEvaluationOf = (scenario: ScenarioView, saved: RuleSetRevision | null): RuleSetRevision => saved ?? {
  schemaVersion: RULE_SET_SCHEMA_VERSION,
  ruleSetId: defaultRuleSetIdOf(scenario.scenarioId),
  scenarioId: scenario.scenarioId,
  revision: UNSAVED_REVISION,
  ...EMPTY_RULE_CONTENT,
  createdAt: scenario.updatedAt,
};

/** シナリオの入力の規則の今の事実（保存した最新の版、判定、状態）。 */
export const dataRuleFactsOf = (scenario: ScenarioView): {
  readonly saved: RuleSetRevision | null;
  readonly evaluation: RuleSetEvaluation;
  readonly state: InputRuleState;
} => {
  const saved = readLatestRuleSet(localUiStore(), scenario.scenarioId)?.ruleSet ?? null;
  const evaluation = evaluateRuleSet(ruleSetForEvaluationOf(scenario, saved), scenario.current, scenario.evidence);
  return { saved, evaluation, state: inputRuleStateOf(saved !== null, evaluation) };
};
