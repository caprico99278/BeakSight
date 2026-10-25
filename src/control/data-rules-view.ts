// 入力の規則の、画面（`apps/local-ui/`）に要る型と閉じた一覧と判定・生成・読み出し・保存の口を、`src/control/data-rules/` から公開し直す 1 か所
// （Task 29 の設計書 4.4。T29e）。手本は `src/control/approval-view.ts`。
// - 画面のコードは `src/control/data-rules/` を直接 import しない（`tests/architecture/local-ui-boundary.test.ts` の (k)）。意味の owner は、それぞれの
//   `src/control/data-rules/` のファイルのまま（ここは名前を公開し直すだけで、判断を持たない。`tests/architecture/data-rules-boundary.test.ts` の (f)）。
// - 値（関数と閉じた一覧）は、画面のサーバ（`apps/local-ui/src/server/`）だけが読む。ブラウザ側の画面のコードは、ここから型だけを import する。

export {
  EXTERNAL_DELIVERY_BLOCKED_DETAILS,
  FIELD_RELATION_KINDS,
  FIELD_RELATION_ROLES,
  FIELD_RULE_STATUSES,
  FIXED_LIST_GENERATION_METHOD,
  GENERATION_METHODS,
  MAX_FIELD_RELATIONS,
  MAX_FIXED_VALUE_LENGTH,
  MAX_FIXED_VALUES,
  MAX_RULE_RANGE_VALUE_LENGTH,
  NEEDS_RULE_INPUT_DETAILS,
  RULE_CONFLICT_DETAILS,
  RULE_ORIGINS,
  RULE_PROBLEM_CODES,
  RULE_SET_ID_PATTERN,
  RULE_SET_SCHEMA_VERSION,
  RULE_SOURCES,
  SEMANTIC_KINDS,
  SYNTHETIC_EMAIL_DOMAIN,
  isSyntheticEmailAddress,
  relationFieldNamesOf,
  syntheticPhoneFormatOf,
} from './data-rules/rule-contracts.js';
export type {
  BaseDateWindow,
  ExternalDeliveryBlockedDetail,
  FieldRelation,
  FieldRelationKind,
  FieldRule,
  FieldRuleProblem,
  FieldRuleStatus,
  GenerationMethod,
  NeedsRuleInputDetail,
  RuleConflictDetail,
  RuleOrigin,
  RuleProblem,
  RuleProblemCode,
  RuleRange,
  RuleSetContent,
  RuleSetRevision,
  RuleSource,
  SemanticKind,
} from './data-rules/rule-contracts.js';

export { EXTERNAL_DELIVERY_KINDS } from './data-rules/external-delivery-words.js';
export type { ExternalDeliveryKind } from './data-rules/external-delivery-words.js';

export { isSemanticKindCompatible } from './data-rules/business-templates.js';

export { evaluateRuleSet } from './data-rules/field-evaluation.js';
export type { FieldEvaluation, RuleSetEvaluation } from './data-rules/field-evaluation.js';

export { generateScenarioData } from './data-rules/scenario-data.js';

// T40R2-fix（M-1）: 照合の READ の期待が、実行のたびに変わる値と比べるか（開始の画面が、許可の発行と同じ判定で理由を出す）。
export { readVerificationVaryingRejectionOf } from './data-rules/varying-values.js';
// FM2b（手を減らす段 2 の設計書 3A.2）: 照合の READ の期待の欄を、実行のたびに値が変わる欄から推す（許可の発行と同じ値の作り方と判定）。
export { planRuleSet } from './data-rules/field-evaluation.js';
export { varyingFieldNamesOf } from './data-rules/varying-values.js';
export type { ScenarioDataResult } from './data-rules/scenario-data.js';

// FM2c（手動の操作を減らす設計書 3A.3）: 推した規則を保存できる規則の集まりの中身にする部品（下書きの自動の作成（FM2b）と画面が使う）。
export { defaultRangeFieldNamesOf, inferRuleSetContent } from './data-rules/rule-set-inference.js';
export type { InferredRuleSetContent } from './data-rules/rule-set-inference.js';

export { computeRuleSetDigest } from './data-rules/rule-digest.js';
export { assertStorableRuleSet } from './data-rules/rule-set-policy.js';

export {
  RULE_SET_STORE_REJECTION_REASONS,
  readLatestRuleSet,
  readRuleSetRevisions,
  saveRuleSetAndAttach,
} from './data-rules/rule-store.js';
export type { RuleSetSaveAndAttachResult, RuleSetStoreRejectionReason, RuleSetStoreResult } from './data-rules/rule-store.js';
export type { StoredRuleSet } from './data-rules/rule-set-facts.js';
