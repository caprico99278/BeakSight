/**
 * 入力の規則（補完）の画面の Server Functions（Task 29 の設計書 3 章の「補完の画面」、4.3、4.4。T29e）。
 * - 読むだけのもの（画面の値）は GET。保存は POST だけ。入力は、サーバで `schemas/control/` のスキーマ（`ui-scenario-key`、`ui-data-rule-save`）で
 *   確かめてから使う（`requestOf`）。保存は、画面の確認のダイアログの後にだけ呼ぶ（画面の側）。
 * - 入力の規則の部品は、画面向けの公開し直し（`src/control/data-rules-view.ts`）からだけ読む（`src/control/data-rules/` を直接 import しない。Gate
 *   `local-ui-boundary` の (k)）。シナリオの部品は `src/control/approval-view.ts` から読む。
 * - 判定: 規則の集まりの最新の版（なければ、人の規則のない空の中身）を、シナリオの今の版と発見の根拠の写しに照らして `evaluateRuleSet` にかける
 *   （判定の owner は `field-evaluation.ts`。ここではやり直さない）。
 * - データの例: 書き込みのモードのプロファイル（`eligible`）のときだけ（T29R-fix-1 の M-9）、名前つきの数（`EXAMPLE_COUNT`）の、画面の例のための決まった値（実行の許可の id ではない）で `generateScenarioData` を呼ぶ。サイトには
 *   送らない（この画面は要求を送る部品を持たない）。基準日は、サーバの今日（Asia/Tokyo）。
 * - 保存: `saveRuleSetAndAttach`（2 段）。秘密に見える名前の欄に人が入れた値は、保存の部品が拒む（`RULE_SET_SECRET_FIELD_FIXED_VALUE`。判定の
 *   owner は `src/control/data-rules/rule-set-policy.ts`。T29R-fix-1 の M-4 で、ここから移した。画面の `secretLike` の表示は、同じ owner の判定
 *   `isSecretUrlQueryParameterName`（`src/core/secret-query-names.ts`）を使う）。中身の形の誤り（`assertStorableRuleSet` の `RangeError`）は
 *   `DATA_RULE_CONTENT_INVALID`。1 段目の拒否は保存の部品の理由、2 段目の拒否はシナリオの保存の部品の理由を返す（規則の版は残る）。シナリオの版が
 *   上がり、下書きに戻る（再承認）。
 * - 返す値は、表示に要るものだけ（選択肢の値は返さない。人が入れた固定の値は、その画面を使う人が入れた値なので返す）。日時は ISO 8601。
 */
import { createServerFn } from '@tanstack/react-start';
import { readScenario, type InputRuleReference, type ScenarioKind, type ScenarioState, type ScenarioView } from '../../../../src/control/approval-view.js';
import {
  FIELD_RELATION_KINDS,
  FIELD_RELATION_ROLES,
  GENERATION_METHODS,
  MAX_FIXED_VALUE_LENGTH,
  MAX_FIXED_VALUES,
  SEMANTIC_KINDS,
  computeRuleSetDigest,
  generateScenarioData,
  isSemanticKindCompatible,
  isSyntheticEmailAddress,
  readLatestRuleSet,
  saveRuleSetAndAttach,
  syntheticPhoneFormatOf,
  type ExternalDeliveryKind,
  type FieldRelation,
  type FieldRelationKind,
  type FieldRule,
  type FieldRuleStatus,
  type GenerationMethod,
  type RuleProblem,
  type RuleSetContent,
  type RuleSetRevision,
  type RuleSetStoreRejectionReason,
  type RuleSource,
  type SemanticKind,
} from '../../../../src/control/data-rules-view.js';
import type { CandidateFieldType } from '../../../../src/control/discovery-view.js';
import { getProfile, type StoredProfile } from '../../../../src/control/store/profile-store.js';
import { baseDateOf } from '../../../../src/core/base-date.js';
import { isSecretUrlQueryParameterName } from '../../../../src/core/secret-query-names.js';
import { formatCompactUtcTimestamp } from '../../../../src/core/utc-timestamp.js';
import { usesScenarios } from '../display/labels';
import type { InputRuleState } from '../display/data-rules';
import { localUiStore } from './control-store';
import { EMPTY_RULE_CONTENT, dataRuleFactsOf, defaultRuleSetIdOf, ruleSetForEvaluationOf } from './data-rule-facts';
import { candidateFieldViewOf, discoveryProfileViewOf, type CandidateFieldConstraintView, type DiscoveryProfileView } from './discovery-documents';
import { requestOf } from './request-validation';
import { isoTimestampOf } from './timestamps';
import type { ScenarioStoreRejectionReason } from '../../../../src/control/approval-view.js';

// ---------------------------------------------------------------------------------------------------------------
// 画面に返す値
// ---------------------------------------------------------------------------------------------------------------

/** 欄 1 つ（判定の結果と、欄の要点と、編集に要る値）。 */
export interface DataRuleFieldView {
  readonly fieldName: string;
  /** 送る欄か（送る欄でない必須の欄も、判定の理由とともに並ぶ）。 */
  readonly selected: boolean;
  /** 欄の型（候補にない欄は null）。 */
  readonly type: CandidateFieldType | null;
  readonly required: boolean;
  readonly constraints: readonly CandidateFieldConstraintView[];
  readonly status: FieldRuleStatus;
  readonly problem: RuleProblem | null;
  readonly source: RuleSource | null;
  /** 当てた規則（人の規則か、推した規則。決まらなければ null）。 */
  readonly rule: FieldRule | null;
  /** 保存した人の規則（なければ null）。 */
  readonly humanRule: FieldRule | null;
  readonly externalDeliveryKinds: readonly ExternalDeliveryKind[];
  /** 欄の型に合う意味の種類（候補にない欄は空）。 */
  readonly allowedKinds: readonly SemanticKind[];
  /** 秘密に見える名前の欄か（人が入れた値を残せない）。 */
  readonly secretLike: boolean;
}

/** 例の値 1 つ（null は送らない。合成の形は、メール・電話のとき）。 */
export interface DataRuleExampleValueView {
  readonly fieldName: string;
  readonly value: string | null;
  readonly synthetic: 'EMAIL' | 'PHONE' | null;
}

/** 例 1 つ。 */
export interface DataRuleExampleView {
  readonly index: number;
  readonly values: readonly DataRuleExampleValueView[];
}

/** 画面の選択肢と上限（契約の閉じた一覧と上限）。 */
export interface DataRuleChoicesView {
  readonly generationMethods: readonly GenerationMethod[];
  readonly relationKinds: readonly FieldRelationKind[];
  readonly relationRoles: Readonly<Record<FieldRelationKind, readonly string[]>>;
  readonly maxFixedValues: number;
  readonly maxFixedValueLength: number;
}

/** 入力の規則の画面の値。 */
export interface DataRulePageView {
  readonly profile: DiscoveryProfileView;
  /** シナリオを使うプロファイルか。 */
  readonly eligible: boolean;
  /** 保存できるか（使うプロファイルで、取り消していない）。 */
  readonly editable: boolean;
  readonly scenario: {
    readonly scenarioId: string;
    readonly revision: number;
    readonly state: ScenarioState;
    readonly kind: ScenarioKind;
    readonly fieldNames: readonly string[];
    readonly inputRuleReference: InputRuleReference | null;
  };
  /** 保存した最新の版（なければ null）。 */
  readonly ruleSet: { readonly ruleSetId: string; readonly revision: number; readonly createdAt: string; readonly reference: InputRuleReference } | null;
  readonly inputRuleState: InputRuleState;
  /** 保存した中身（なければ空の中身）。編集の初めの値。 */
  readonly content: RuleSetContent;
  readonly fields: readonly DataRuleFieldView[];
  /** 当てる関係（人の関係と、テンプレートの既定の関係）。 */
  readonly relations: readonly FieldRelation[];
  /** 当てる一意にする欄の組。 */
  readonly uniqueKeyFieldNames: readonly string[];
  /** データの例（送る欄すべてが決まらなければ null）。 */
  readonly examples: readonly DataRuleExampleView[] | null;
  readonly choices: DataRuleChoicesView;
}

/** 画面のサーバが、保存を拒む理由（保存の部品の理由のほか。閉じた一覧）。 */
export const DATA_RULE_REQUEST_LOCAL_REJECTION_REASONS = Object.freeze(['DATA_RULE_CONTENT_INVALID'] as const);
export type DataRuleRequestLocalRejectionReason = (typeof DATA_RULE_REQUEST_LOCAL_REJECTION_REASONS)[number];

/** 保存の結果（拒むときは、どの段で拒んだかと理由。2 段目の拒否では、規則の版は残る）。 */
export type DataRuleSaveView =
  | { readonly ok: true; readonly scenarioRevision: number; readonly ruleSetRevision: number }
  | { readonly ok: false; readonly stage: 'RULE_SET'; readonly reason: RuleSetStoreRejectionReason | DataRuleRequestLocalRejectionReason }
  | { readonly ok: false; readonly stage: 'ATTACHMENT'; readonly reason: ScenarioStoreRejectionReason };

// ---------------------------------------------------------------------------------------------------------------
// 値の組み立て
// ---------------------------------------------------------------------------------------------------------------

/** 保存できるプロファイルの状態。 */
const ACTIVE_PROFILE_STATUS = 'ACTIVE';
/** 画面の例の数。 */
export const EXAMPLE_COUNT = 3;
/** 画面の例の seed の、実行の許可の id の代わりの決まった値の頭（実行の許可の id ではない）。 */
const EXAMPLE_SEED_PREFIX = 'screen-example-';
/** 例の基準日（サーバの今日。Asia/Tokyo の `YYYY-MM-DD`。計算は基準日の owner の `baseDateOf`。CCX-20）。 */
const exampleBaseDate = (): string => baseDateOf(new Date());

/** データの例（決まった値の seed で作る。送らない）。 */
const examplesOf = (stored: StoredProfile, scenario: ScenarioView, ruleSet: RuleSetRevision): readonly DataRuleExampleView[] => {
  const baseDate = exampleBaseDate();
  const digest = computeRuleSetDigest(ruleSet);
  return Array.from({ length: EXAMPLE_COUNT }, (_unused, offset) => offset + 1).flatMap((index) => {
    const result = generateScenarioData({
      ruleSet,
      scenario: scenario.current,
      candidate: scenario.evidence,
      seedInput: {
        profileId: stored.profile.profileId,
        scenarioId: scenario.scenarioId,
        scenarioRevision: scenario.revision,
        ruleSetDigest: digest,
        executionGrantId: `${EXAMPLE_SEED_PREFIX}${String(index)}`,
      },
      usedUniqueKeys: [],
      usedPhoneNumbers: [],
      baseDate,
    });
    return result.ok
      ? [{
        index,
        values: Object.entries(result.values).map(([fieldName, value]) => ({
          fieldName,
          value,
          synthetic: value === null ? null : isSyntheticEmailAddress(value) ? 'EMAIL' as const : syntheticPhoneFormatOf(value) === null ? null : 'PHONE' as const,
        })),
      }]
      : [];
  });
};

/** 画面の値。 */
const pageOf = (stored: StoredProfile, scenario: ScenarioView): DataRulePageView => {
  const eligible = usesScenarios(stored.profile.mode, stored.profile.auth);
  const latest = readLatestRuleSet(localUiStore(), scenario.scenarioId);
  const { saved, evaluation, state } = dataRuleFactsOf(scenario);
  const ruleSet = ruleSetForEvaluationOf(scenario, saved);
  const humanRules = new Map(ruleSet.fieldRules.map((rule) => [rule.fieldName, rule]));
  const fieldsByName = new Map(scenario.evidence.fields.filter((field) => field.name.length > 0).map((field) => [field.name, field]));
  return {
    profile: discoveryProfileViewOf(stored),
    eligible,
    editable: eligible && stored.status === ACTIVE_PROFILE_STATUS,
    scenario: {
      scenarioId: scenario.scenarioId,
      revision: scenario.revision,
      state: scenario.state,
      kind: scenario.current.kind,
      fieldNames: [...scenario.current.fieldNames],
      inputRuleReference: scenario.current.inputRuleReference === null ? null : { ...scenario.current.inputRuleReference },
    },
    ruleSet: latest === null
      ? null
      : { ruleSetId: latest.ruleSet.ruleSetId, revision: latest.ruleSet.revision, createdAt: isoTimestampOf(latest.ruleSet.createdAt), reference: { ...latest.reference } },
    inputRuleState: state,
    content: saved === null ? EMPTY_RULE_CONTENT : { fieldRules: saved.fieldRules, relations: saved.relations, uniqueKeyFieldNames: saved.uniqueKeyFieldNames },
    fields: evaluation.fields.map((field) => {
      const candidateField = fieldsByName.get(field.fieldName);
      const view = candidateField === undefined ? null : candidateFieldViewOf(scenario.evidence, candidateField);
      return {
        fieldName: field.fieldName,
        selected: field.selected,
        type: candidateField?.type ?? null,
        required: candidateField?.required ?? false,
        constraints: view?.constraints ?? [],
        status: field.status,
        problem: field.problem,
        source: field.source,
        rule: field.rule,
        humanRule: humanRules.get(field.fieldName) ?? null,
        externalDeliveryKinds: [...field.externalDeliveryKinds],
        allowedKinds: candidateField === undefined ? [] : SEMANTIC_KINDS.filter((kind) => isSemanticKindCompatible(kind, candidateField.type)),
        secretLike: isSecretUrlQueryParameterName(field.fieldName),
      };
    }),
    relations: evaluation.relations.map((relation) => ({ ...relation })),
    uniqueKeyFieldNames: [...evaluation.uniqueKeyFieldNames],
    // T29R-fix-1（M-9）: データの例は、書き込みのモードのプロファイル（シナリオを使うプロファイル）のときだけ作って返す。
    examples: eligible && evaluation.executable ? examplesOf(stored, scenario, ruleSet) : null,
    choices: {
      generationMethods: GENERATION_METHODS,
      relationKinds: FIELD_RELATION_KINDS,
      relationRoles: FIELD_RELATION_ROLES,
      maxFixedValues: MAX_FIXED_VALUES,
      maxFixedValueLength: MAX_FIXED_VALUE_LENGTH,
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------
// 入力（形は `requestOf` でスキーマを使って確かめる）
// ---------------------------------------------------------------------------------------------------------------

interface ScenarioKeyRequest {
  readonly scenarioId: string;
}
interface DataRuleSaveRequest extends RuleSetContent {
  readonly scenarioId: string;
  readonly expectedScenarioRevision: number;
  readonly expectedRuleSetRevision: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Server Functions
// ---------------------------------------------------------------------------------------------------------------

/** 入力の規則の画面の値（読むだけ。データの例は作るが、送らない）。シナリオかプロファイルがなければ `null`。 */
export const dataRulePageFn = createServerFn({ method: 'GET' })
  .validator(requestOf<ScenarioKeyRequest>('ui-scenario-key'))
  .handler(({ data }): DataRulePageView | null => {
    const scenario = readScenario(localUiStore(), data.scenarioId);
    const stored = scenario === null ? null : getProfile(localUiStore(), scenario.profileId);
    return scenario === null || stored === null ? null : pageOf(stored, scenario);
  });

/** 入力の規則を保存し、シナリオに付け直す（確認のダイアログの後。2 段。シナリオの版が上がり、下書きに戻る）。 */
export const saveDataRulesFn = createServerFn({ method: 'POST' })
  .validator(requestOf<DataRuleSaveRequest>('ui-data-rule-save'))
  .handler(({ data }): DataRuleSaveView => {
    const scenario = readScenario(localUiStore(), data.scenarioId);
    if (scenario === null) {
      return { ok: false, stage: 'RULE_SET', reason: 'RULE_SET_SCENARIO_NOT_FOUND' };
    }
    const latest = readLatestRuleSet(localUiStore(), scenario.scenarioId);
    let saved: ReturnType<typeof saveRuleSetAndAttach>;
    try {
      saved = saveRuleSetAndAttach(localUiStore(), {
        ruleSetId: latest?.ruleSet.ruleSetId ?? defaultRuleSetIdOf(scenario.scenarioId),
        scenarioId: scenario.scenarioId,
        expectedRevision: data.expectedRuleSetRevision,
        content: { fieldRules: data.fieldRules, relations: data.relations, uniqueKeyFieldNames: data.uniqueKeyFieldNames },
        expectedScenarioRevision: data.expectedScenarioRevision,
        at: formatCompactUtcTimestamp(new Date(), 'data rule save time'),
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return { ok: false, stage: 'RULE_SET', reason: 'DATA_RULE_CONTENT_INVALID' };
      }
      throw error;
    }
    if (!saved.ruleSet.ok) {
      return { ok: false, stage: 'RULE_SET', reason: saved.ruleSet.reason };
    }
    if (saved.attachment === null || !saved.attachment.ok) {
      return { ok: false, stage: 'ATTACHMENT', reason: saved.attachment?.ok === false ? saved.attachment.reason : 'SCENARIO_NOT_FOUND' };
    }
    return { ok: true, scenarioRevision: saved.attachment.scenario.revision, ruleSetRevision: saved.ruleSet.reference.revision };
  });
