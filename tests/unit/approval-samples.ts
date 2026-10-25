// T28a（Task 28 の設計書 4.1、4.3）: シナリオの承認の部品（`src/control/approval/`）のテストが共用する例（テストのファイルではない）。
// - 候補は、発見の候補の例（`discovery-candidate-samples.ts`）から、分類と指紋の owner の関数で作る（書き写さない）。
// - 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import {
  APPROVAL_RECEIPT_SCHEMA_VERSION,
  APPROVER_LOCAL_OPERATOR,
  SCENARIO_SCHEMA_VERSION,
  SIDE_EFFECT_CONFIRMATIONS,
  type ApprovalReceipt,
  type InputRuleReference,
  type RevocationReceipt,
  type ScenarioReadCheckDefinitionFact,
  type ScenarioRevision,
  type ScenarioUpdateSpec,
  type ScenarioVerification,
  type SideEffectConfirmations,
} from '../../src/control/approval/scenario-contracts.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests, recordIdSegmentPairOfTemplates, templatedIdentityDigestOf } from '../../src/discovery/fingerprint.js';
import { SAMPLE_ALLOWED_ORIGINS, SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

/** 分類と指紋をかけた、成果物の候補。 */
export const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(discovered),
});

export const PROFILE_ID = 'test-profile';
export const OTHER_PROFILE_ID = 'other-profile';

/** 登録の POST の form（CREATE）。欄の種類をひととおり持つ。 */
export const CREATE_CANDIDATE = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/members/new' },
  action: sampleAction('/members'),
  submitterText: '登録',
  fields: [
    sampleField('name', 'text', { required: true }),
    sampleField('email', 'email'),
    sampleField('plan', 'select-one', { options: ['a', 'b'] }),
    sampleField('mode', 'hidden', { hasValue: true }),
    sampleField('kept', 'text', { readonly: true }),
    sampleField('locked', 'text', { disabled: true }),
    sampleField('invisible', 'text', { hidden: true }),
    sampleField('API-Key'),
    sampleField('delete_flag', 'checkbox'),
    sampleField('deleteFlag', 'checkbox'),
    sampleField('include_disabled', 'checkbox'),
    sampleField('_method'),
    sampleField(''),
  ],
}));

/** 更新の PATCH（`_method`）の form（UPDATE）。 */
export const UPDATE_CANDIDATE = candidateOf(sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: '/members/1/edit' },
  action: sampleAction('/members/1'),
  methodOverride: 'PATCH',
  submitterText: '更新',
  enctype: 'multipart/form-data',
  fields: [sampleField('name'), sampleField('_method', 'hidden', { hasValue: true })],
}));

/** 検索の GET の form（READ）。 */
export const READ_CANDIDATE = candidateOf(sampleForm({
  formMethod: 'GET',
  action: sampleAction('/members'),
  submitterText: '表示',
  fields: [sampleField('q')],
}));

/** JS の結び付きのある登録の form（NEEDS_BINDING）。 */
export const BOUND_CANDIDATE = candidateOf(sampleForm({
  submitterText: '登録',
  fields: [sampleField('name')],
  jsBinding: { form: ['submit'], submitter: [], ancestor: [], document: [], window: [], inlineHandler: false },
}));

/** 副作用の確認（すべて確かめた）。 */
export const ALL_CONFIRMED: SideEffectConfirmations = Object.freeze(
  Object.fromEntries(SIDE_EFFECT_CONFIRMATIONS.map((item) => [item, true])) as Record<(typeof SIDE_EFFECT_CONFIRMATIONS)[number], boolean>,
);

/**
 * READ の確かめの定義の今の事実（有効、取り消し済み、ほかのプロファイル）。T30a: 今の版の送る値の名前（照合の READ の結び付けの確かめに使う）を
 * 足した。
 */
export const READ_CHECK_FACTS: readonly ScenarioReadCheckDefinitionFact[] = Object.freeze([
  { readCheckId: 'rc-1', profileId: PROFILE_ID, revision: 2, canceledAt: null, parameterNames: ['q', 'status'] },
  { readCheckId: 'rc-2', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: ['q'] },
  { readCheckId: 'rc-canceled', profileId: PROFILE_ID, revision: 1, canceledAt: '20261011000000', parameterNames: ['q'] },
  { readCheckId: 'rc-other', profileId: OTHER_PROFILE_ID, revision: 1, canceledAt: null, parameterNames: ['q'] },
]);

/**
 * 検証の指定（T30a。すべての項目を指定した例）。照合の READ は `rc-1`（版 2。送る値 `q` を生成した氏名に結び付ける）。値は匿名の path と
 * セレクタだけ。
 */
export const FULL_VERIFICATION: ScenarioVerification = Object.freeze<ScenarioVerification>({
  successCondition: { pathPrefix: '/members/', selector: '.registered' },
  inputErrorCondition: { pathPrefix: '/members/new', selector: '.error' },
  recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' },
  readVerification: {
    readCheckId: 'rc-1',
    revision: 2,
    bindings: [{ parameterName: 'q', fieldName: 'name' }],
    expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }, { kind: 'TEXT_CONTAINS', fieldName: 'email' }],
  },
});

/** 下書きの入力（受ける形）。 */
export const sampleDraft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
  // T30f fix round 1（DEF-098）: CREATE の候補の見えていて編集できる select（`plan`）は、送る欄に選ぶ（選ばなければ下書きを受けない）。
  fieldNames: ['name', 'email', 'plan'],
  readChecks: [{ readCheckId: 'rc-1', revision: 2 }],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  ...overrides,
});

/** 入力の規則の参照の例。 */
export const INPUT_RULES: InputRuleReference = Object.freeze({
  ruleSetId: 'rules-1',
  revision: 1,
  digest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
});

/** 認証の設定の digest とターゲットの設定の digest の例。 */
export const AUTH_SETUP_DIGEST = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';
export const TARGET_CONFIG_DIGEST = '3333333333333333333333333333333333333333333333333333333333333333';

/** T38b: FORM のシナリオの版（form の要求の形を必ず持つ。API のシナリオは要求の形が null）。 */
export type FormScenarioRevision = ScenarioRevision & { readonly request: NonNullable<ScenarioRevision['request']> };

/**
 * シナリオの版 1 つ（CREATE の候補から。FORM のシナリオ）。T38b: 返す型は FORM のシナリオ（form の要求の形を持つ）。上書きで要求の形を null に
 * しない（FORM の見本だけ。API のシナリオの見本は `scenario-api-draft.test.ts` が下書きの確かめから作る）。
 */
export const sampleScenario = (overrides: Partial<ScenarioRevision> = {}): FormScenarioRevision => formScenarioOf({
  schemaVersion: SCENARIO_SCHEMA_VERSION,
  scenarioId: 'scenario-1',
  profileId: PROFILE_ID,
  revision: 3,
  kind: 'CREATE',
  candidate: { identityDigest: CREATE_CANDIDATE.identityDigest, ruleDigest: CREATE_CANDIDATE.ruleDigest },
  request: {
    formMethod: 'POST',
    methodOverride: null,
    origin: SAMPLE_ORIGIN,
    path: '/members',
    enctype: 'application/x-www-form-urlencoded',
  },
  fieldNames: ['email', 'name'],
  readChecks: [{ readCheckId: 'rc-1', revision: 2 }],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  verification: FULL_VERIFICATION,
  // T31b: CREATE は UPDATE の指定を持たない。
  update: null,
  inputRuleReference: INPUT_RULES,
  createdAt: '20261012000000',
  updatedAt: '20261012010000',
  ...overrides,
});

/** FORM のシナリオの版か（要求の形を持つ）を確かめて、その型で返す（持たなければ、見本の使い方の誤り）。 */
function formScenarioOf(scenario: ScenarioRevision): FormScenarioRevision {
  const { request } = scenario;
  if (request === null) {
    throw new Error('sampleScenario makes a FORM scenario; do not override the request with null');
  }
  return { ...scenario, request };
}

/** UPDATE の候補（`UPDATE_CANDIDATE`）の、更新の画面と送信先の path の型（T31b）。 */
export const UPDATE_FORM_PATH_TEMPLATE = '/members/{id}/edit';
export const UPDATE_ACTION_PATH_TEMPLATE = '/members/{id}';

/** `UPDATE_CANDIDATE` の型にした識別の digest（T31b。`fingerprint.ts` の関数で求める。書き写さない）。 */
export const UPDATE_TEMPLATED_IDENTITY_DIGEST: string = (() => {
  const pair = recordIdSegmentPairOfTemplates(UPDATE_FORM_PATH_TEMPLATE, UPDATE_ACTION_PATH_TEMPLATE);
  const digest = pair === null ? null : templatedIdentityDigestOf(UPDATE_CANDIDATE, pair);
  if (digest === null) {
    throw new Error('the sample UPDATE candidate must have a templated identity digest');
  }
  return digest;
})();

/** UPDATE の指定の例（T31b。台帳の参照は `scenario-create`、保つ欄はなし）。 */
export const UPDATE_SPEC: ScenarioUpdateSpec = Object.freeze({
  targetCreateScenarioId: 'scenario-create',
  formPathTemplate: UPDATE_FORM_PATH_TEMPLATE,
  actionPathTemplate: UPDATE_ACTION_PATH_TEMPLATE,
  keepFieldNames: Object.freeze([]),
  templatedIdentityDigest: UPDATE_TEMPLATED_IDENTITY_DIGEST,
});

/** シナリオの版 1 つ（UPDATE の候補から。T31b）。 */
export const sampleUpdateScenario = (overrides: Partial<ScenarioRevision> = {}): ScenarioRevision => sampleScenario({
  kind: 'UPDATE',
  candidate: { identityDigest: UPDATE_CANDIDATE.identityDigest, ruleDigest: UPDATE_CANDIDATE.ruleDigest },
  request: {
    formMethod: 'POST',
    methodOverride: 'PATCH',
    origin: SAMPLE_ORIGIN,
    path: '/members/1',
    enctype: 'multipart/form-data',
  },
  fieldNames: ['name'],
  verification: { ...FULL_VERIFICATION, readVerification: null },
  update: UPDATE_SPEC,
  ...overrides,
});

/** 承認の記録の例（digest は呼び出し側が求めて渡す）。 */
export const sampleApproval = (approvalDigest: string, overrides: Partial<ApprovalReceipt> = {}): ApprovalReceipt => ({
  schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
  kind: 'APPROVAL',
  receiptId: 'receipt-1',
  profileId: PROFILE_ID,
  scenarioId: 'scenario-1',
  scenarioRevision: 3,
  approvalDigest,
  bound: {
    profileRevision: 4,
    authSetupDigest: AUTH_SETUP_DIGEST,
    targetConfigDigest: TARGET_CONFIG_DIGEST,
    candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
    candidateRuleDigest: CREATE_CANDIDATE.ruleDigest,
    inputRuleReference: INPUT_RULES,
  },
  approvedAt: '20261012020000',
  expiresAt: '20261111020000',
  approver: APPROVER_LOCAL_OPERATOR,
  ...overrides,
});

/** 撤回の記録の例。 */
export const sampleRevocation = (overrides: Partial<RevocationReceipt> = {}): RevocationReceipt => ({
  schemaVersion: APPROVAL_RECEIPT_SCHEMA_VERSION,
  kind: 'REVOCATION',
  receiptId: 'receipt-2',
  profileId: PROFILE_ID,
  scenarioId: 'scenario-1',
  targetReceiptId: 'receipt-1',
  revokedAt: '20261013000000',
  reason: 'OPERATOR_REQUEST',
  ...overrides,
});
