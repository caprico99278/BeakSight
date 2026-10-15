// T28a（Task 28 の設計書 4.1）: シナリオと承認の記録の JSON Schema（`schemas/control/scenario.schema.json`、`approval-receipt.schema.json`）と、
// 契約（`src/control/approval/scenario-contracts.ts`）の一致。閉じた一覧の enum の一致は `schema-enum-consistency.test.ts` の対応表。
// - 上限・既定値・形（pattern）・分岐の const は、契約の名前つきの定数と一致する。
// - 契約の例はスキーマに通り、値の項目、既定を超える上限と期限、閉じた一覧の外の値は拒まれる。
// - 保存の前の確かめ直し（`assertStorableScenarioRevision`、`assertStorableApprovalReceipt`）は、凍結した写しを返し、形が違えば `RangeError`。
// - T30a: シナリオの版の検証の指定（`verification`。必須。項目ごとに null を許す）。ID の取り方と期待の種類は分岐の const（閉じた一覧と一致）。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeApprovalDigest } from '../../src/control/approval/approval-digest.js';
import {
  APPROVAL_RECEIPT_KINDS,
  APPROVAL_RECEIPT_SCHEMA_VERSION,
  APPROVAL_TTL_DAYS,
  APPROVER_LOCAL_OPERATOR,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  MAX_SCENARIO_FIELD_NAMES,
  MAX_SCENARIO_READ_CHECKS,
  MIN_APPROVAL_TTL_DAYS,
  MIN_SCENARIO_LIMIT,
  MIN_SCENARIO_REVISION,
  MAX_RECORD_ID_PATH_PATTERN_LENGTH,
  MAX_RESULT_CONDITION_PATH_LENGTH,
  MAX_VERIFICATION_BINDINGS,
  MAX_VERIFICATION_EXPECTATIONS,
  MAX_VERIFICATION_ROW_COUNT,
  MAX_VERIFICATION_SELECTOR_LENGTH,
  MIN_VERIFICATION_ROW_COUNT,
  RECORD_ID_SOURCES,
  SCENARIO_FORM_METHOD,
  SCENARIO_ID_PATTERN,
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_VERIFICATION_ITEMS,
  SIDE_EFFECT_CONFIRMATIONS,
  UNSPECIFIED_VERIFICATION,
  VERIFICATION_EXPECTATION_KINDS,
} from '../../src/control/approval/scenario-contracts.js';
import {
  assertStorableApprovalReceipt,
  assertStorableScenarioRevision,
  validateScenarioDraft,
} from '../../src/control/approval/scenario-policy.js';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';
import { PROFILE_ID_PATTERN } from '../../src/control/contracts.js';
import { TARGET_CONFIG_SHA256_PATTERN } from '../../src/control/worker-protocol.js';
import { MAX_CANDIDATE_URL_PART_LENGTH, MAX_FIELD_NAME_LENGTH } from '../../src/discovery/candidate-contracts.js';
import { MAX_READ_CHECK_DETAIL_FIELD_LENGTH } from '../../src/discovery/read-check-contracts.js';
import {
  AUTH_SETUP_DIGEST,
  CREATE_CANDIDATE,
  FULL_VERIFICATION,
  READ_CHECK_FACTS,
  TARGET_CONFIG_DIGEST,
  sampleApproval,
  sampleDraft,
  sampleRevocation,
  sampleScenario,
} from './approval-samples.js';

type JsonSchema = Record<string, unknown> & {
  readonly properties?: Record<string, JsonSchema>;
  readonly $defs?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly required?: readonly string[];
};

const readSchema = (name: string): JsonSchema =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', `${name}.schema.json`), 'utf8')) as JsonSchema;

const scenarioSchema = readSchema('scenario');
const receiptSchema = readSchema('approval-receipt');
const scenarioDefs = scenarioSchema.$defs ?? {};
const receiptDefs = receiptSchema.$defs ?? {};
const prop = (node: JsonSchema | undefined, key: string): JsonSchema => node?.properties?.[key] ?? {};

const DIGEST = computeApprovalDigest(sampleScenario(), { profileRevision: 4, authSetupDigest: AUTH_SETUP_DIGEST, targetConfigDigest: TARGET_CONFIG_DIGEST });

describe('scenario and approval receipt schemas (T28a)', () => {
  it('registers both schemas in the control schema names', () => {
    expect(CONTROL_SCHEMA_NAMES).toEqual(expect.arrayContaining(['scenario', 'approval-receipt']));
    expect(scenarioSchema.$id).toBe('urn:beaksight:schema:control:scenario:1');
    expect(receiptSchema.$id).toBe('urn:beaksight:schema:control:approval-receipt:1');
  });

  it('matches the scenario limits, defaults and shapes with the named constants', () => {
    expect(prop(scenarioSchema, 'schemaVersion').const).toBe(SCENARIO_SCHEMA_VERSION);
    expect(prop(scenarioSchema, 'scenarioId').pattern).toBe(SCENARIO_ID_PATTERN.source);
    expect(prop(scenarioSchema, 'profileId').pattern).toBe(PROFILE_ID_PATTERN.source);
    expect(prop(scenarioSchema, 'revision').minimum).toBe(MIN_SCENARIO_REVISION);
    const fieldNames = prop(scenarioSchema, 'fieldNames');
    expect(fieldNames.maxItems).toBe(MAX_SCENARIO_FIELD_NAMES);
    expect(fieldNames.items?.maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect(prop(scenarioSchema, 'readChecks').maxItems).toBe(MAX_SCENARIO_READ_CHECKS);
    expect(prop(scenarioDefs.readCheckReference, 'readCheckId').pattern).toBe(SCENARIO_ID_PATTERN.source);
    expect(prop(scenarioDefs.readCheckReference, 'revision').minimum).toBe(MIN_SCENARIO_REVISION);
    const request = scenarioDefs.request;
    expect(prop(request, 'formMethod').const).toBe(SCENARIO_FORM_METHOD);
    expect(prop(request, 'origin').maxLength).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    expect(prop(request, 'path').maxLength).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    const sideEffects = prop(scenarioSchema, 'sideEffectConfirmations');
    expect(sideEffects.required).toEqual(SIDE_EFFECT_CONFIRMATIONS);
    expect(Object.keys(sideEffects.properties ?? {})).toEqual(SIDE_EFFECT_CONFIRMATIONS);
    const limits = prop(scenarioSchema, 'limits');
    expect([prop(limits, 'maxCreatesPerRun').minimum, prop(limits, 'maxCreatesPerRun').maximum]).toEqual([MIN_SCENARIO_LIMIT, DEFAULT_MAX_CREATES_PER_RUN]);
    expect([prop(limits, 'maxCumulativeCreates').minimum, prop(limits, 'maxCumulativeCreates').maximum])
      .toEqual([MIN_SCENARIO_LIMIT, DEFAULT_MAX_CUMULATIVE_CREATES]);
    const ttl = prop(scenarioSchema, 'approvalTtlDays');
    expect([ttl.minimum, ttl.maximum]).toEqual([MIN_APPROVAL_TTL_DAYS, APPROVAL_TTL_DAYS]);
    expect(prop(scenarioDefs.inputRuleReference, 'ruleSetId').pattern).toBe(SCENARIO_ID_PATTERN.source);
  });

  it('matches the verification spec shapes and limits with the named constants (T30a)', () => {
    expect(scenarioSchema.required).toContain('verification');
    const verification = scenarioDefs.verification;
    expect(verification?.required).toEqual(SCENARIO_VERIFICATION_ITEMS);
    expect(Object.keys(verification?.properties ?? {})).toEqual(SCENARIO_VERIFICATION_ITEMS);
    const condition = scenarioDefs.resultCondition;
    expect(prop(condition, 'pathPrefix').maxLength).toBe(MAX_RESULT_CONDITION_PATH_LENGTH);
    expect((prop(condition, 'selector').anyOf ?? [])[0]?.maxLength).toBe(MAX_VERIFICATION_SELECTOR_LENGTH);
    const sources = (scenarioDefs.recordId?.oneOf ?? []).map((branch) => prop(branch, 'source').const);
    expect(sources).toEqual(RECORD_ID_SOURCES);
    const [pathBranch, elementBranch] = scenarioDefs.recordId?.oneOf ?? [];
    expect(prop(pathBranch, 'pathPattern').maxLength).toBe(MAX_RECORD_ID_PATH_PATTERN_LENGTH);
    expect(prop(elementBranch, 'selector').maxLength).toBe(MAX_VERIFICATION_SELECTOR_LENGTH);
    const read = scenarioDefs.readVerification;
    expect(prop(read, 'readCheckId').pattern).toBe(SCENARIO_ID_PATTERN.source);
    expect(prop(read, 'revision').minimum).toBe(MIN_SCENARIO_REVISION);
    expect([prop(read, 'bindings').minItems, prop(read, 'bindings').maxItems]).toEqual([1, MAX_VERIFICATION_BINDINGS]);
    expect([prop(read, 'expectations').minItems, prop(read, 'expectations').maxItems]).toEqual([1, MAX_VERIFICATION_EXPECTATIONS]);
    expect(prop(scenarioDefs.binding, 'parameterName').maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect(prop(scenarioDefs.binding, 'fieldName').maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    const expectationBranches = scenarioDefs.verificationExpectation?.oneOf ?? [];
    expect(expectationBranches.map((branch) => prop(branch, 'kind').const)).toEqual(VERIFICATION_EXPECTATION_KINDS);
    const count = prop(expectationBranches[0], 'count');
    expect([count.minimum, count.maximum]).toEqual([MIN_VERIFICATION_ROW_COUNT, MAX_VERIFICATION_ROW_COUNT]);
    expect(prop(expectationBranches[1], 'fieldName').maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect(prop(expectationBranches[2], 'field').maxLength).toBe(MAX_READ_CHECK_DETAIL_FIELD_LENGTH);
    expect(prop(expectationBranches[2], 'fieldName').maxLength).toBe(MAX_FIELD_NAME_LENGTH);
  });

  it('matches the receipt branches, the approver and the digest shapes with the named constants', () => {
    expect((receiptSchema.oneOf ?? []).map((branch) => branch.$ref)).toEqual(['#/$defs/approval', '#/$defs/revocation']);
    expect([prop(receiptDefs.approval, 'kind').const, prop(receiptDefs.revocation, 'kind').const]).toEqual(APPROVAL_RECEIPT_KINDS);
    expect(prop(receiptDefs.approval, 'schemaVersion').const).toBe(APPROVAL_RECEIPT_SCHEMA_VERSION);
    expect(prop(receiptDefs.revocation, 'schemaVersion').const).toBe(APPROVAL_RECEIPT_SCHEMA_VERSION);
    expect(prop(receiptDefs.approval, 'approver').const).toBe(APPROVER_LOCAL_OPERATOR);
    expect(prop(receiptDefs.bound, 'targetConfigDigest').pattern).toBe(TARGET_CONFIG_SHA256_PATTERN.source);
    for (const [definition, key] of [[receiptDefs.approval, 'receiptId'], [receiptDefs.approval, 'scenarioId'], [receiptDefs.revocation, 'receiptId'],
      [receiptDefs.revocation, 'scenarioId'], [receiptDefs.revocation, 'targetReceiptId']] as const) {
      expect(prop(definition, key).pattern).toBe(SCENARIO_ID_PATTERN.source);
    }
  });

  it('accepts the examples of the contract', () => {
    expect(validateControlDocument('scenario', sampleScenario())).toEqual({ ok: true });
    expect(validateControlDocument('scenario', sampleScenario({ inputRuleReference: null, readChecks: [], fieldNames: [] }))).toEqual({ ok: true });
    expect(validateControlDocument('scenario', sampleScenario({ verification: UNSPECIFIED_VERIFICATION }))).toEqual({ ok: true });
    expect(validateControlDocument('scenario', sampleScenario({
      verification: { ...FULL_VERIFICATION, recordId: { source: 'ELEMENT', selector: '#record-id' } },
    }))).toEqual({ ok: true });
    expect(validateControlDocument('approval-receipt', sampleApproval(DIGEST))).toEqual({ ok: true });
    expect(validateControlDocument('approval-receipt', sampleApproval(DIGEST, {
      bound: { ...sampleApproval(DIGEST).bound, authSetupDigest: null, inputRuleReference: null },
    }))).toEqual({ ok: true });
    expect(validateControlDocument('approval-receipt', sampleRevocation())).toEqual({ ok: true });
  });

  it('accepts a scenario built from a validated draft', () => {
    const result = validateScenarioDraft(sampleDraft(), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { createdAt, updatedAt, schemaVersion, scenarioId, revision, inputRuleReference } = sampleScenario();
      expect(validateControlDocument('scenario', {
        ...result.content, schemaVersion, scenarioId, revision, inputRuleReference, createdAt, updatedAt,
      })).toEqual({ ok: true });
    }
  });

  it.each<readonly [string, unknown]>([
    ['a value property', { ...sampleScenario(), values: { name: 'x' } }],
    ['a stored state', { ...sampleScenario(), state: 'APPROVED' }],
    ['a READ kind', sampleScenario({ kind: 'READ' as never })],
    ['a per-run limit above the default', sampleScenario({ limits: { maxCreatesPerRun: 2, maxCumulativeCreates: 20 } })],
    ['a cumulative limit above the default', sampleScenario({ limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 21 } })],
    ['a TTL above the default', sampleScenario({ approvalTtlDays: 31 })],
    ['a GET request', sampleScenario({ request: { ...sampleScenario().request, formMethod: 'GET' as never } })],
    ['a DELETE override', sampleScenario({ request: { ...sampleScenario().request, methodOverride: 'DELETE' as never } })],
    ['a duplicate field name', sampleScenario({ fieldNames: ['name', 'name'] })],
    ['a partial input rule reference', sampleScenario({ inputRuleReference: { ruleSetId: 'rules-1', revision: 1 } as never })],
    ['an unknown side effect item', sampleScenario({ sideEffectConfirmations: { ...sampleScenario().sideEffectConfirmations, OTHER: true } as never })],
    ['a bad timestamp', sampleScenario({ createdAt: '2026-10-12' })],
    // T30a: 検証の指定。
    ['no verification spec', (({ verification: _omitted, ...rest }) => rest)(sampleScenario())],
    ['a null verification spec', { ...sampleScenario(), verification: null }],
    ['a missing verification item', { ...sampleScenario(), verification: { successCondition: null, inputErrorCondition: null, recordId: null } }],
    ['a condition with a status code', { ...sampleScenario(), verification: { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/a', selector: null, status: 200 } } }],
    ['an unknown record id source', { ...sampleScenario(), verification: { ...FULL_VERIFICATION, recordId: { source: 'QUERY', name: 'id' } } }],
    ['an element source with a path pattern', { ...sampleScenario(), verification: { ...FULL_VERIFICATION, recordId: { source: 'ELEMENT', pathPattern: '/{id}' } } }],
    ['an expectation of at least rows', { ...sampleScenario(), verification: {
      ...FULL_VERIFICATION, readVerification: { ...FULL_VERIFICATION.readVerification, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    } }],
    ['a READ verification without a binding', { ...sampleScenario(), verification: {
      ...FULL_VERIFICATION, readVerification: { ...FULL_VERIFICATION.readVerification, bindings: [] },
    } }],
    ['a value in a binding', { ...sampleScenario(), verification: {
      ...FULL_VERIFICATION, readVerification: { ...FULL_VERIFICATION.readVerification, bindings: [{ parameterName: 'q', fieldName: 'name', value: 'x' }] },
    } }],
  ])('rejects a scenario with %s', (_label, document) => {
    expect(validateControlDocument('scenario', document).ok).toBe(false);
  });

  it.each<readonly [string, unknown]>([
    ['another approver', sampleApproval(DIGEST, { approver: 'someone' as never })],
    ['an unknown kind', { ...sampleRevocation(), kind: 'EXPIRY' }],
    ['an unknown revocation reason', sampleRevocation({ reason: 'TIMEOUT' as never })],
    ['a bad digest', sampleApproval('sha256:xyz')],
    ['a prefixed target config digest', sampleApproval(DIGEST, { bound: { ...sampleApproval(DIGEST).bound, targetConfigDigest: `sha256:${TARGET_CONFIG_DIGEST}` } })],
    ['a value property', { ...sampleApproval(DIGEST), values: {} }],
    ['an approval without an expiry', (({ expiresAt: _omitted, ...rest }) => rest)(sampleApproval(DIGEST))],
    ['a revocation with an approval digest', { ...sampleRevocation(), approvalDigest: DIGEST }],
  ])('rejects a receipt with %s', (_label, document) => {
    expect(validateControlDocument('approval-receipt', document).ok).toBe(false);
  });

  it('re-checks a scenario revision and a receipt before storing, and returns frozen copies', () => {
    const scenario = assertStorableScenarioRevision(sampleScenario());
    expect(scenario).toEqual(sampleScenario());
    expect(Object.isFrozen(scenario) && Object.isFrozen(scenario.request)).toBe(true);
    const receipt = assertStorableApprovalReceipt(sampleApproval(DIGEST));
    expect(receipt).toEqual(sampleApproval(DIGEST));
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(() => assertStorableScenarioRevision(sampleScenario({ approvalTtlDays: 31 }))).toThrow(RangeError);
    expect(() => assertStorableApprovalReceipt(sampleApproval('sha256:xyz'))).toThrow(RangeError);
  });
});
