// 承認の digest の唯一の owner（Task 28 の設計書 3 章の「承認を縛るもの」、4.1。T28a）。純粋な関数。
// - 承認を縛るもの（どれかが変われば再承認）を、決まった順で並べた JSON の SHA-256（`createSha256Fingerprint`。`sha256:<16進64桁>`）。
//   先頭に文書の形の印（`APPROVAL_DIGEST_FORMAT`）を入れる。並べ方や項目を変えるときは、印の版を上げる。
// - 並び（この順）: 印、プロファイルの id、シナリオの id、シナリオの版、プロファイルの改訂、認証の設定の digest、ターゲットの設定の digest、
//   kind、候補の識別の digest、候補の規則の digest、要求の形（form の method、`_method` の上書き、Origin、path、enctype）、送る欄の名前の一覧、
//   副作用の確認（閉じた一覧の順の真偽）、上限（1 回の Run、累積）、期限の日数、入力の規則の参照（id、版、digest。なければ null）、照らす READ の
//   定義の参照（id と版）。
// - 並びの順に依らない所（送る欄の名前の集合、照らす READ の定義の参照の集合）は、UTF-16 のコード単位の順（`compareCodeUnits`）に並べてから
//   求める。作成と更新の時刻は入れない（承認の対象ではない）。
// - 承認の記録（receipt）に固定する、縛った事実の値（`approvalBoundFactsOf`）も、ここで作る（判定の owner `approval-validity.ts` が比べる値と
//   同じ項目）。
// - T28e: 並びを項目の閉じた一覧（`APPROVAL_DIGEST_ITEMS`）と項目ごとの値（`approvalDigestEntriesOf`）にし、digest と、画面の「最後の承認との
//   差分」（`approvalDigestDifferencesOf`）の両方がそれを使う（digest の値は変えない。`approval-digest-differences.test.ts` の固定の値）。
// - T30a（Task 30 の設計書 2 章のユーザーの判断 4、3 章の「検証の指定」）: 検証の指定の 4 項目（成功の条件、入力の誤りの条件、登録の ID の取り方、
//   照合の READ）を一覧の末尾に足し、印の版を `/2` に上げた（今までの承認は、digest が変わるので、すべて再承認になる。判定は
//   `approval-validity.ts` の「記録の書き換え」と同じ `SCENARIO_REVISION_CHANGED`）。照合の READ の結び付けと期待は、並びの順に依らない
//   （並べてから求める）。
// - T31b（Task 31 の設計書 4 章の「契約」）: UPDATE の指定の 5 項目（台帳の参照、更新の画面の path の型、送信先の path の型、保つ欄、型にした識別の
//   digest。CREATE と、UPDATE の指定の前に保存した版は、どれも null）を一覧の末尾に足し、印の版を `/3` に上げた（今までの承認はすべて再承認になる。
//   意図した変化）。保つ欄は、並びの順に依らない（並べてから求める）。UPDATE の承認は、型にした識別の digest に縛る（有効性の判定は
//   `approval-validity.ts`）。
import { createSha256Fingerprint } from '../../core/ids.js';
import { deepFreeze } from '../../core/immutable.js';
import { compareCodeUnits } from '../../core/text.js';
import {
  SIDE_EFFECT_CONFIRMATIONS,
  type ApprovalBoundFacts,
  type ReadCheckReference,
  type ScenarioRecordIdSpec,
  type ScenarioResultCondition,
  type ScenarioRevision,
  type VerificationExpectation,
} from './scenario-contracts.js';

/** 承認の digest の入力の形の印（版つき）。 */
export const APPROVAL_DIGEST_FORMAT = 'beaksight-approval/3';

/** 承認の digest が縛る、シナリオの外の事実（承認の時点の値）。 */
export interface ApprovalDigestFacts {
  readonly profileRevision: number;
  readonly authSetupDigest: string | null;
  readonly targetConfigDigest: string;
}

/** 承認の digest が見る、シナリオの版の項目（作成と更新の時刻は見ない）。 */
export type ApprovalDigestScenario = Pick<
  ScenarioRevision,
  | 'scenarioId'
  | 'profileId'
  | 'revision'
  | 'kind'
  | 'candidate'
  | 'request'
  | 'fieldNames'
  | 'readChecks'
  | 'sideEffectConfirmations'
  | 'limits'
  | 'approvalTtlDays'
  | 'inputRuleReference'
  | 'verification'
  | 'update'
>;

/**
 * 承認の digest の項目（閉じた一覧。digest の JSON の、印の後の並びの順。T28e）。差分（`approvalDigestDifferencesOf`）も、この一覧と
 * `approvalDigestEntriesOf` の値を使う（項目と並びを書き写さない）。項目を足す・並びを変えるときは、`APPROVAL_DIGEST_FORMAT` の版を上げる。
 */
export const APPROVAL_DIGEST_ITEMS = Object.freeze([
  'profileId',
  'scenarioId',
  'scenarioRevision',
  'profileRevision',
  'authSetupDigest',
  'targetConfigDigest',
  'kind',
  'candidateIdentityDigest',
  'candidateRuleDigest',
  'request',
  'fieldNames',
  'sideEffectConfirmations',
  'limits',
  'approvalTtlDays',
  'inputRuleReference',
  'readChecks',
  // T30a: 検証の指定。
  'verificationSuccessCondition',
  'verificationInputErrorCondition',
  'verificationRecordId',
  'verificationRead',
  // T31b: UPDATE の指定。
  'updateTargetCreateScenarioId',
  'updateFormPathTemplate',
  'updateActionPathTemplate',
  'updateKeepFieldNames',
  'updateTemplatedIdentityDigest',
] as const);
export type ApprovalDigestItem = (typeof APPROVAL_DIGEST_ITEMS)[number];

/** 項目の値（JSON の値。digest の入力にそのまま入る）。 */
export type ApprovalDigestValue = string | number | boolean | null | readonly ApprovalDigestValue[];

/** 照らす READ の定義の参照の 1 件の形（`[id, 版]` の JSON）。 */
const readCheckEntryOf = (reference: ReadCheckReference): string => JSON.stringify([reference.readCheckId, reference.revision]);

/** 結果の条件の値（`[path の前方一致, セレクタ]`。未指定なら null）。 */
const resultConditionEntryOf = (condition: ScenarioResultCondition | null): ApprovalDigestValue =>
  condition === null ? null : [condition.pathPrefix, condition.selector];

/** 登録の ID の取り方の値（`[取り方, path の型かセレクタ]`。未指定なら null）。 */
const recordIdEntryOf = (spec: ScenarioRecordIdSpec | null): ApprovalDigestValue => {
  if (spec === null) {
    return null;
  }
  return spec.source === 'URL_PATH_PATTERN' ? [spec.source, spec.pathPattern] : [spec.source, spec.selector];
};

/** 照合の READ の期待 1 件の形（`[種類, …]` の JSON）。 */
const verificationExpectationEntryOf = (expectation: VerificationExpectation): string => {
  switch (expectation.kind) {
    case 'ROW_COUNT_EQUALS':
      return JSON.stringify([expectation.kind, expectation.count]);
    case 'TEXT_CONTAINS':
      return JSON.stringify([expectation.kind, expectation.fieldName]);
    case 'DETAIL_FIELD_EQUALS':
      return JSON.stringify([expectation.kind, expectation.field, expectation.fieldName]);
  }
};

/** 照合の READ の値（`[id, 版, 結び付け, 期待]`。結び付けと期待は並べ替えた JSON の一覧。未指定なら null）。 */
const verificationReadEntryOf = (scenario: ApprovalDigestScenario): ApprovalDigestValue => {
  const read = scenario.verification.readVerification;
  return read === null ? null : [
    read.readCheckId,
    read.revision,
    read.bindings.map(({ parameterName, fieldName }) => JSON.stringify([parameterName, fieldName])).sort(compareCodeUnits),
    read.expectations.map(verificationExpectationEntryOf).sort(compareCodeUnits),
  ];
};

/**
 * 承認の digest の項目ごとの値（純粋。入力を変えない。凍結。T28e で `computeApprovalDigest` から取り出した）。並びの順に依らない所は並べ替えた値。
 * 鍵の順は `APPROVAL_DIGEST_ITEMS` の順。
 */
export const approvalDigestEntriesOf = (
  scenario: ApprovalDigestScenario,
  facts: ApprovalDigestFacts,
): Readonly<Record<ApprovalDigestItem, ApprovalDigestValue>> => {
  const { request, limits, inputRuleReference, update } = scenario;
  const entries: Record<ApprovalDigestItem, ApprovalDigestValue> = {
    profileId: scenario.profileId,
    scenarioId: scenario.scenarioId,
    scenarioRevision: scenario.revision,
    profileRevision: facts.profileRevision,
    authSetupDigest: facts.authSetupDigest,
    targetConfigDigest: facts.targetConfigDigest,
    kind: scenario.kind,
    candidateIdentityDigest: scenario.candidate.identityDigest,
    candidateRuleDigest: scenario.candidate.ruleDigest,
    request: [request.formMethod, request.methodOverride, request.origin, request.path, request.enctype],
    fieldNames: [...scenario.fieldNames].sort(compareCodeUnits),
    sideEffectConfirmations: SIDE_EFFECT_CONFIRMATIONS.map((item) => scenario.sideEffectConfirmations[item]),
    limits: [limits.maxCreatesPerRun, limits.maxCumulativeCreates],
    approvalTtlDays: scenario.approvalTtlDays,
    inputRuleReference: inputRuleReference === null ? null : [inputRuleReference.ruleSetId, inputRuleReference.revision, inputRuleReference.digest],
    readChecks: scenario.readChecks.map(readCheckEntryOf).sort(compareCodeUnits),
    verificationSuccessCondition: resultConditionEntryOf(scenario.verification.successCondition),
    verificationInputErrorCondition: resultConditionEntryOf(scenario.verification.inputErrorCondition),
    verificationRecordId: recordIdEntryOf(scenario.verification.recordId),
    verificationRead: verificationReadEntryOf(scenario),
    updateTargetCreateScenarioId: update?.targetCreateScenarioId ?? null,
    updateFormPathTemplate: update?.formPathTemplate ?? null,
    updateActionPathTemplate: update?.actionPathTemplate ?? null,
    updateKeepFieldNames: update === null ? null : [...update.keepFieldNames].sort(compareCodeUnits),
    updateTemplatedIdentityDigest: update?.templatedIdentityDigest ?? null,
  };
  return deepFreeze(entries);
};

/** 承認の digest を求める（純粋。入力を変えない）。印の後に、`APPROVAL_DIGEST_ITEMS` の順の値を並べた JSON の SHA-256。 */
export const computeApprovalDigest = (scenario: ApprovalDigestScenario, facts: ApprovalDigestFacts): string => {
  const entries = approvalDigestEntriesOf(scenario, facts);
  return createSha256Fingerprint(JSON.stringify([APPROVAL_DIGEST_FORMAT, ...APPROVAL_DIGEST_ITEMS.map((item) => entries[item])]));
};

/** 差分の片側（シナリオの版と、承認の digest が縛るシナリオの外の事実）。 */
export interface ApprovalDigestSubject {
  readonly scenario: ApprovalDigestScenario;
  readonly facts: ApprovalDigestFacts;
}

/** 差分の 1 項目（機械の読める形。前の値と今の値は `approvalDigestEntriesOf` の値）。 */
export interface ApprovalDigestDifference {
  readonly item: ApprovalDigestItem;
  readonly previous: ApprovalDigestValue;
  readonly current: ApprovalDigestValue;
}

/**
 * 承認の digest の項目ごとの差分（純粋。T28e。画面の「最後の承認との差分」）。前（最後の承認の版と、承認の記録に縛った事実）と今の値が違う
 * 項目だけを、`APPROVAL_DIGEST_ITEMS` の順に返す（凍結）。同じ内容なら空。
 */
export const approvalDigestDifferencesOf = (
  previous: ApprovalDigestSubject,
  current: ApprovalDigestSubject,
): readonly ApprovalDigestDifference[] => {
  const before = approvalDigestEntriesOf(previous.scenario, previous.facts);
  const after = approvalDigestEntriesOf(current.scenario, current.facts);
  return deepFreeze(APPROVAL_DIGEST_ITEMS.flatMap((item) => (JSON.stringify(before[item]) === JSON.stringify(after[item])
    ? []
    : [{ item, previous: before[item], current: after[item] }])));
};

/** 承認の記録に固定する、縛った事実の値（凍結）。 */
export const approvalBoundFactsOf = (
  scenario: Pick<ScenarioRevision, 'candidate' | 'inputRuleReference'>,
  facts: ApprovalDigestFacts,
): ApprovalBoundFacts => Object.freeze({
  profileRevision: facts.profileRevision,
  authSetupDigest: facts.authSetupDigest,
  targetConfigDigest: facts.targetConfigDigest,
  candidateIdentityDigest: scenario.candidate.identityDigest,
  candidateRuleDigest: scenario.candidate.ruleDigest,
  inputRuleReference: scenario.inputRuleReference === null ? null : Object.freeze({ ...scenario.inputRuleReference }),
});
