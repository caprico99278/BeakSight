// T32c（Task 32 の設計書 4.1 の成果物の表と approver、5 章、7 章。ユーザーの判断 3）: 書き込みの報告の承認の要約 `approval-summary.json` の
// スキーマ（`schemas/approval-summary.schema.json`）と、契約（`src/control/actions/action-contracts.ts`）の一致。
// - 承認の記録の項目（`bound` を含む）と入力の規則の参照は `schemas/control/approval-receipt.schema.json` を、シナリオの種類・上限・期限の日数・
//   副作用の確認は `schemas/control/scenario.schema.json` を `$ref` で使い、書き写さない。
// - 値は「開始の時点」のもの（名前で分かる）。締めの後の確定の値（予約の最終の状態、締めた後の累計）の項目は持たない。
// - 「人が決めたこと」と「自動で行うこと」は閉じた一覧。CREATE は UPDATE だけの項目を持たず、それぞれの種類で当たる項目をすべて持つ。
// - 資格情報・Cookie・CSRF のトークン・hidden の値・認証の状態の項目、承認者の名前の項目を置かない。approver は `LOCAL_OPERATOR` だけ。
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_SUMMARY_SCHEMA_VERSION,
  AUTOMATED_ACTIONS,
  HUMAN_DECISIONS,
  UPDATE_ONLY_AUTOMATED_ACTIONS,
  UPDATE_ONLY_HUMAN_DECISIONS,
  type ApprovalSummaryDocument,
} from '../../src/control/actions/action-contracts.js';
import {
  APPROVER_LOCAL_OPERATOR,
  DEFAULT_MAX_CREATES_PER_RUN,
  DEFAULT_MAX_CUMULATIVE_CREATES,
  MIN_SCENARIO_LIMIT,
} from '../../src/control/approval/scenario-contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { sampleApprovalSummary } from '../helpers/approval-facts-sample.js';
import {
  absoluteRef,
  prop,
  propertyNamesWithWords,
  readSchemaFile,
  resolveRef,
  schemaRefsOf,
  SECRET_PROPERTY_WORDS,
  type JsonSchema,
} from '../helpers/schema-test-support.js';

const schema = readSchemaFile('approval-summary.schema.json');
/**
 * T32d: 事実の形（親が `START` の `write.approvalFacts` で渡す値と同じ形）は `$defs/facts` に 1 回だけ置き、文書はそれに `schemaVersion`・`jobId`・
 * `runId` を足すだけ。形と上限の確かめは `$defs/facts` を読む。
 */
const facts: JsonSchema = schema.$defs?.['facts'] ?? {};
const kindLists: JsonSchema = schema.$defs?.['kindLists'] ?? {};
/** 文書だけが持つ項目（ワーカーが足す）。 */
const DOCUMENT_ONLY_PROPERTIES: readonly string[] = ['schemaVersion', 'jobId', 'runId'];

/** CREATE のシナリオの、開始の時点の承認の要約（`approval-facts-sample.ts` の見本）。値は匿名の合成のテストデータだけ。 */
const createSummary = (overrides: Partial<ApprovalSummaryDocument> = {}): ApprovalSummaryDocument => ({
  ...sampleApprovalSummary(
    { kind: 'CREATE', profileId: 'test-profile', scenarioId: 'scenario-1', scenarioRevision: 3, grantId: 'grant-1' },
    { jobId: 'job-1', runId: 'RUN-000001' },
  ),
  ...overrides,
});

/** UPDATE のシナリオの、開始の時点の承認の要約（`approval-facts-sample.ts` の見本）。 */
const updateSummary = (overrides: Partial<ApprovalSummaryDocument> = {}): ApprovalSummaryDocument => ({
  ...sampleApprovalSummary(
    { kind: 'UPDATE', profileId: 'test-profile', scenarioId: 'scenario-2', scenarioRevision: 1, grantId: 'grant-1' },
    { jobId: 'job-1', runId: 'RUN-000001' },
  ),
  ...overrides,
});

/** 秘密と個人の情報に見える名前の語（共通の語に、承認者の名前と確定の値を足した）。 */
const FORBIDDEN_PROPERTY_WORDS: readonly string[] = [...SECRET_PROPERTY_WORDS, 'name', 'email', 'settled', 'final'];

describe('approval summary contract (T32c)', () => {
  it('lists what a person decided and what BeakSight does automatically, once, frozen', () => {
    expect(HUMAN_DECISIONS).toEqual(['SCENARIO_APPROVAL', 'INPUT_RULES', 'LIMITS', 'SIDE_EFFECT_CONFIRMATIONS', 'UPDATE_FIELD_ROLES']);
    expect(AUTOMATED_ACTIONS).toEqual(['VALUE_GENERATION', 'TARGET_RECORD_SELECTION', 'SUBMISSION', 'RESULT_JUDGEMENT', 'READ_VERIFICATION']);
    expect(UPDATE_ONLY_HUMAN_DECISIONS).toEqual(['UPDATE_FIELD_ROLES']);
    expect(UPDATE_ONLY_AUTOMATED_ACTIONS).toEqual(['TARGET_RECORD_SELECTION']);
    for (const list of [HUMAN_DECISIONS, AUTOMATED_ACTIONS, UPDATE_ONLY_HUMAN_DECISIONS, UPDATE_ONLY_AUTOMATED_ACTIONS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });
});

describe('approval-summary.json schema (T32c)', () => {
  it('has the artifact id and the named version', () => {
    expect(schema.$id).toBe('urn:beaksight:schema:approval-summary:1.0');
    expect(prop(schema, 'schemaVersion').const).toBe(APPROVAL_SUMMARY_SCHEMA_VERSION);
    expect(APPROVAL_SUMMARY_SCHEMA_VERSION).toBe('approval-summary-schema/1.0');
    expect(schema.additionalProperties).toBe(false);
  });

  it('defines the facts once in $defs/facts, and the document only adds the items of the worker (T32d)', () => {
    expect(facts.additionalProperties).toBe(false);
    const factKeys = Object.keys(facts.properties ?? {});
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...DOCUMENT_ONLY_PROPERTIES, ...factKeys].sort());
    expect([...(schema.required ?? [])].sort()).toEqual([...DOCUMENT_ONLY_PROPERTIES, ...(facts.required ?? [])].sort());
    expect([...(facts.required ?? [])].sort()).toEqual([...factKeys].sort());
    for (const key of factKeys) {
      expect(prop(schema, key), key).toEqual({ $ref: `#/$defs/facts/properties/${key}` });
    }
    expect(schema['allOf']).toEqual([{ $ref: '#/$defs/kindLists' }]);
    expect(facts['allOf']).toEqual([{ $ref: '#/$defs/kindLists' }]);
    expect(factKeys).not.toContain('jobId');
    expect(factKeys).not.toContain('runId');
  });

  it('shares the approval record, the bound facts and the input rule reference with the approval receipt schema by $ref', () => {
    const approval = prop(facts, 'approval');
    expect(approval.additionalProperties).toBe(false);
    expect(prop(approval, 'bound').$ref).toBe('urn:beaksight:schema:control:approval-receipt:1#/$defs/bound');
    for (const key of ['receiptId', 'approvalDigest', 'approvedAt', 'expiresAt', 'approver']) {
      expect(prop(approval, key).$ref, key).toBe(`urn:beaksight:schema:control:approval-receipt:1#/$defs/approval/properties/${key}`);
    }
    expect(resolveRef(prop(approval, 'approver').$ref ?? '')?.const).toBe(APPROVER_LOCAL_OPERATOR);
    expect(prop(facts, 'inputRuleReference').$ref).toBe('urn:beaksight:schema:control:approval-receipt:1#/$defs/bound/properties/inputRuleReference');
  });

  it('shares the scenario kind, the limits, the TTL and the side effect confirmations with the scenario schema by $ref', () => {
    expect(prop(prop(facts, 'scenario'), 'kind').$ref).toBe('urn:beaksight:schema:control:scenario:1#/properties/kind');
    expect(prop(facts, 'limits').$ref).toBe('urn:beaksight:schema:control:scenario:1#/properties/limits');
    expect(prop(facts, 'approvalTtlDays').$ref).toBe('urn:beaksight:schema:control:scenario:1#/properties/approvalTtlDays');
    expect(prop(facts, 'sideEffectConfirmations').$ref).toBe('urn:beaksight:schema:control:scenario:1#/properties/sideEffectConfirmations');
    expect(prop(prop(facts, 'cumulativeAtStart'), 'limit').$ref)
      .toBe('urn:beaksight:schema:control:scenario:1#/properties/limits/properties/maxCumulativeCreates');
  });

  it('refers only to targets that exist', () => {
    const refs = schemaRefsOf(schema);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => resolveRef(absoluteRef('urn:beaksight:schema:approval-summary:1.0', ref)) === undefined)).toEqual([]);
  });

  it('matches the limits of the values at the start with the named constants', () => {
    const count = prop(prop(facts, 'reservationAtStart'), 'count');
    expect(count.minimum).toBe(MIN_SCENARIO_LIMIT);
    expect(count.maximum).toBe(DEFAULT_MAX_CREATES_PER_RUN);
    const used = prop(prop(facts, 'cumulativeAtStart'), 'used');
    expect(used.minimum).toBe(0);
    expect(used.maximum).toBe(DEFAULT_MAX_CUMULATIVE_CREATES);
    expect(prop(facts, 'humanDecisions').maxItems).toBe(HUMAN_DECISIONS.length);
    expect(prop(facts, 'automatedActions').maxItems).toBe(AUTOMATED_ACTIONS.length);
    const then = (kindLists['then'] as JsonSchema | undefined) ?? {};
    const otherwise = (kindLists['else'] as JsonSchema | undefined) ?? {};
    expect(prop(then, 'humanDecisions').minItems).toBe(HUMAN_DECISIONS.length - UPDATE_ONLY_HUMAN_DECISIONS.length);
    expect(prop(then, 'automatedActions').minItems).toBe(AUTOMATED_ACTIONS.length - UPDATE_ONLY_AUTOMATED_ACTIONS.length);
    expect(prop(otherwise, 'humanDecisions').minItems).toBe(HUMAN_DECISIONS.length);
    expect(prop(otherwise, 'automatedActions').minItems).toBe(AUTOMATED_ACTIONS.length);
  });

  it('names every value of the run start as a value at the start, and keeps no settled value', () => {
    const keys = Object.keys(schema.properties ?? {});
    expect(keys.filter((key) => key.endsWith('AtStart')).sort()).toEqual(['cumulativeAtStart', 'grantAtStart', 'reservationAtStart', 'revokedAtStart']);
    expect(keys).not.toContain('reservationState');
    expect(Object.keys(prop(facts, 'reservationAtStart').properties ?? {}).sort()).toEqual(['count', 'reservedAt']);
  });

  it('has no property for a secret, a person name or a settled value', () => {
    expect(propertyNamesWithWords(schema, FORBIDDEN_PROPERTY_WORDS)).toEqual([]);
  });

  it.each<readonly [string, ApprovalSummaryDocument]>([
    ['a CREATE summary', createSummary()],
    ['an UPDATE summary', updateSummary()],
    ['a summary without an input rule reference', createSummary({
      inputRuleReference: null,
      approval: { ...createSummary().approval, bound: { ...createSummary().approval.bound, inputRuleReference: null } },
    })],
    // 見本は認証の設定の digest を持つ（上の 2 つの場面）ので、持たない形を確かめる。
    ['a summary without an auth setup digest', createSummary({
      approval: { ...createSummary().approval, bound: { ...createSummary().approval.bound, authSetupDigest: null } },
    })],
    ['a summary whose cumulative count is at the limit', createSummary({ cumulativeAtStart: { used: 20, limit: 20 } })],
  ])('accepts %s', async (_label, document) => {
    expect(await validateArtifact('approval-summary', document)).toEqual({ ok: true });
  });

  it.each<readonly [string, unknown]>([
    ['an unknown property', { ...createSummary(), note: 'x' }],
    ['a password property', { ...createSummary(), password: 'x' }],
    ['a settled reservation state', { ...createSummary(), reservationState: 'COMMITTED' }],
    ['a settled reservation', createSummary({ reservationAtStart: { ...createSummary().reservationAtStart, state: 'COMMITTED' } as never })],
    ['an approver other than the local operator', createSummary({ approval: { ...createSummary().approval, approver: 'someone' as never } })],
    ['an approver name', createSummary({ approval: { ...createSummary().approval, approverName: 'x' } as never })],
    ['bound facts with another property', createSummary({
      approval: { ...createSummary().approval, bound: { ...createSummary().approval.bound, cookies: [] } as never },
    })],
    ['bound facts without the profile revision', createSummary({
      approval: { ...createSummary().approval, bound: (({ profileRevision: _omitted, ...rest }) => rest)(createSummary().approval.bound) as never },
    })],
    ['a bad approval digest', createSummary({ approval: { ...createSummary().approval, approvalDigest: 'x' } })],
    ['a bad input rule digest', createSummary({ inputRuleReference: { ruleSetId: 'rules-1', revision: 2, digest: 'x' } })],
    ['limits above the defaults', createSummary({ limits: { maxCreatesPerRun: 2, maxCumulativeCreates: 20 } })],
    ['a TTL above the default', createSummary({ approvalTtlDays: 31 })],
    ['side effect confirmations without an item', createSummary({
      sideEffectConfirmations: (({ NOT_DESTRUCTIVE: _omitted, ...rest }) => rest)(createSummary().sideEffectConfirmations) as never,
    })],
    ['an unknown scenario kind', createSummary({ scenario: { scenarioId: 'scenario-1', revision: 3, kind: 'DELETE' as never } })],
    ['a grant without the consumption time', createSummary({ grantAtStart: { ...createSummary().grantAtStart, consumedAt: null as never } })],
    ['a bad grant time', createSummary({ grantAtStart: { ...createSummary().grantAtStart, issuedAt: '2026-10-15' } })],
    ['a reservation of two writes', createSummary({ reservationAtStart: { count: 2, reservedAt: '20261015000000' } })],
    ['a reservation of no write', createSummary({ reservationAtStart: { count: 0, reservedAt: '20261015000000' } })],
    ['a cumulative count above the limit default', createSummary({ cumulativeAtStart: { used: 21, limit: 20 } })],
    ['a negative cumulative count', createSummary({ cumulativeAtStart: { used: -1, limit: 20 } })],
    ['an unknown human decision', createSummary({ humanDecisions: [...createSummary().humanDecisions, 'TARGET' as never] })],
    ['a duplicated automated action', createSummary({ automatedActions: [...createSummary().automatedActions, 'SUBMISSION'] })],
    ['a CREATE with an UPDATE-only human decision', createSummary({ humanDecisions: [...HUMAN_DECISIONS] })],
    ['a CREATE with an UPDATE-only automated action', createSummary({ automatedActions: [...AUTOMATED_ACTIONS] })],
    ['a CREATE without one of its human decisions', createSummary({ humanDecisions: createSummary().humanDecisions.slice(1) })],
    ['an UPDATE without the field roles', updateSummary({ humanDecisions: createSummary().humanDecisions })],
    ['an UPDATE without the target selection', updateSummary({ automatedActions: createSummary().automatedActions })],
    ['a bad run id', createSummary({ runId: 'run-1' })],
  ])('rejects %s', async (_label, document) => {
    expect((await validateArtifact('approval-summary', document)).ok).toBe(false);
  });
});
