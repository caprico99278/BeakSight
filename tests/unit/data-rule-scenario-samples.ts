// T29c（Task 29 の設計書 4.2）: 欄の判定と生成のテストが共用する例（テストのファイルではない）。
// 候補は発見の候補の例から、分類と指紋の owner の関数で作る（`approval-samples.ts` の `candidateOf`）。例の値は匿名の値だけ。
import { computeRuleSetDigest } from '../../src/control/data-rules/rule-digest.js';
import type { FieldRule, RuleSetRevision } from '../../src/control/data-rules/rule-contracts.js';
import type { DataSeedInput } from '../../src/control/data-rules/deterministic-stream.js';
import type { ScenarioRevision, SideEffectConfirmations } from '../../src/control/approval/scenario-contracts.js';
import type { CandidateField, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { ALL_CONFIRMED, candidateOf, sampleScenario } from './approval-samples.js';
import { sampleAction, sampleForm, SAMPLE_ORIGIN } from './discovery-candidate-samples.js';
import { RULE_SET_SCHEMA_VERSION } from '../../src/control/data-rules/rule-contracts.js';

/** 登録の form の候補（欄は引数）。 */
export const candidateWith = (fields: readonly CandidateField[]): DiscoveryCandidate => candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/records/new' },
  action: sampleAction('/records'),
  submitterText: '登録',
  fields,
}));

/** 候補から作ったシナリオ（送る欄は引数）。 */
export const scenarioFor = (
  candidate: DiscoveryCandidate,
  fieldNames: readonly string[],
  overrides: Partial<ScenarioRevision> = {},
): ScenarioRevision => sampleScenario({
  candidate: { identityDigest: candidate.identityDigest, ruleDigest: candidate.ruleDigest },
  fieldNames: [...fieldNames].sort(),
  ...overrides,
});

/** `NO_EXTERNAL_NOTIFICATION` だけを確かめていない副作用の確認。 */
export const NOTIFICATION_UNCONFIRMED: SideEffectConfirmations = Object.freeze({ ...ALL_CONFIRMED, NO_EXTERNAL_NOTIFICATION: false });

/** シナリオの規則の集まり（規則は引数）。 */
export const ruleSetFor = (
  scenario: ScenarioRevision,
  fieldRules: readonly FieldRule[] = [],
  overrides: Partial<RuleSetRevision> = {},
): RuleSetRevision => ({
  schemaVersion: RULE_SET_SCHEMA_VERSION,
  ruleSetId: 'rules-1',
  scenarioId: scenario.scenarioId,
  revision: 1,
  fieldRules: [...fieldRules],
  relations: [],
  uniqueKeyFieldNames: [],
  createdAt: '20261013000000',
  ...overrides,
});

/** seed の入力（シナリオと規則の集まりに合う。実行の許可の id は引数）。 */
export const seedInputFor = (
  scenario: Pick<ScenarioRevision, 'profileId' | 'scenarioId' | 'revision'>,
  ruleSet: RuleSetRevision,
  executionGrantId = 'grant-1',
): DataSeedInput => ({
  profileId: scenario.profileId,
  scenarioId: scenario.scenarioId,
  scenarioRevision: scenario.revision,
  ruleSetDigest: computeRuleSetDigest(ruleSet),
  executionGrantId,
});

/** 基準日の例（Asia/Tokyo の日付）。 */
export const BASE_DATE = '2026-10-13';
