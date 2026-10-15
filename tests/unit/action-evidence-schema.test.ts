// T32c（Task 32 の設計書 4.1 の成果物の表、人の値、報告の対象、5 章、7 章）: 書き込みの報告の証拠 `action-evidence.json` のスキーマ
// （`schemas/action-evidence.schema.json`）と、契約（`src/control/actions/action-contracts.ts`）の一致。
// - 成果物のスキーマの一覧（`src/core/schema-validator.ts`）に登録する。値の一覧・上限・形は、ほかのスキーマ（`action-run`・`read-evidence`・
//   `run`・`control/scenario`）の定義を `$ref` で使い、書き写さない（ここで `$ref` の先と、その先の上限が契約の定数と一致することを確かめる）。
// - 受ける形と拒む形。送らずに止めた回（`BLOCKED`）は、送った値・応答・登録の ID・照合の READ の証拠を持たない。人の値（UPDATE の変えた欄の前の
//   値、照合の READ の取れた値）があるときは `containsHumanEnteredValues` が真。
// - 資格情報・Cookie・CSRF のトークン・hidden の値・認証の状態の項目を置かない（項目の名前の走査）。enum の一致は
//   `schema-enum-consistency.test.ts` の対応表。
import { describe, expect, it } from 'vitest';
import {
  ACTION_EVIDENCE_SCHEMA_VERSION,
  MAX_SUBMITTED_VALUE_LENGTH,
  type ActionEvidenceDocument,
  type ActionGuardSummary,
} from '../../src/control/actions/action-contracts.js';
import { MAX_RECORD_ID_LENGTH, MAX_SCENARIO_FIELD_NAMES, SCENARIO_ID_PATTERN } from '../../src/control/approval/scenario-contracts.js';
import { PROFILE_ID_PATTERN } from '../../src/control/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { MAX_CANDIDATE_URL_PART_LENGTH, MAX_FIELD_NAME_LENGTH } from '../../src/discovery/candidate-contracts.js';
import { MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH } from '../../src/discovery/read-check-evaluation.js';
import type { WriteStageMonitorSnapshot } from '../../src/safety/passive-request-guard.js';
import { SUBMISSION_STAGE_BLOCK_REASONS } from '../../src/safety/request-policy.js';
import { WRITE_PAYLOAD_BLOCK_REASONS } from '../../src/safety/write-payload-policy.js';
import {
  blockedDocuments,
  sampleExecutedRead,
  verifiedCreateDocuments,
  verifiedUpdateDocuments,
} from '../helpers/action-report-samples.js';
import {
  absoluteRef,
  firstOf,
  prop,
  propertyNamesWithWords,
  readSchemaFile,
  resolveRef,
  schemaRefsOf,
  SECRET_PROPERTY_WORDS,
  type JsonSchema,
} from '../helpers/schema-test-support.js';

const schema = readSchemaFile('action-evidence.schema.json');
const defs = schema.$defs ?? {};

/** 照合の READ の証拠の全体（`action-report-samples.ts` の見本。行の数の期待だけで、人の値を持たない）。 */
const executedRead = sampleExecutedRead;

/** Guard の数の要約（止めた要求なし。すべての理由の鍵を 0 で持つ）。 */
const quietGuard = (): ActionGuardSummary => ({
  blockedByReason: Object.fromEntries(SUBMISSION_STAGE_BLOCK_REASONS.map((reason) => [reason, 0])),
  blockedByOtherRulesInWindow: 0,
  submissionWindowOpen: false,
  blockedByPayloadReason: Object.fromEntries(WRITE_PAYLOAD_BLOCK_REASONS.map((reason) => [reason, 0])),
  documentCharsetRead: true,
  responseDeliveryCanceled: false,
});

/** 照合まで済んだ CREATE の証拠（`VERIFIED`。`action-report-samples.ts` の見本）。 */
const verifiedCreate = (overrides: Partial<ActionEvidenceDocument> = {}): ActionEvidenceDocument => ({
  ...verifiedCreateDocuments().evidence,
  ...overrides,
});

/** 送らずに止めた証拠（`BLOCKED`）。送った値・応答・登録の ID・照合の READ の証拠を持たない。送る中身の照合で止めた数を 1 にする。 */
const blockedCreate = (overrides: Partial<ActionEvidenceDocument> = {}): ActionEvidenceDocument => {
  const blocked = blockedDocuments().evidence;
  const guard = blocked.guard ?? quietGuard();
  return {
    ...blocked,
    guard: { ...guard, blockedByPayloadReason: { ...guard.blockedByPayloadReason, VALUE_MISMATCH: 1 } },
    ...overrides,
  };
};

/** 照合まで済んだ UPDATE の証拠（変えた欄の前の値と、照合の READ の取れた値は人の値でありうる。`action-report-samples.ts` の見本）。 */
const verifiedUpdate = (overrides: Partial<ActionEvidenceDocument> = {}): ActionEvidenceDocument => ({
  ...verifiedUpdateDocuments().evidence,
  ...overrides,
});

/** 秘密を持つ項目に見える名前の語（共通の語に、ロックの版を足した）。 */
const EVIDENCE_SECRET_PROPERTY_WORDS: readonly string[] = [...SECRET_PROPERTY_WORDS, 'lock_version', 'lockversion'];

/** Guard の書き込みの段の記録の写しは、そのまま証拠の Guard の要約にできる（型を書き写していないことの確かめ。typecheck で落ちる）。 */
const guardSummaryOf = (snapshot: WriteStageMonitorSnapshot): ActionGuardSummary => snapshot;

describe('action-evidence.json schema (T32c)', () => {
  it('has the artifact id and the named version', () => {
    expect(schema.$id).toBe('urn:beaksight:schema:action-evidence:1.0');
    expect(prop(schema, 'schemaVersion').const).toBe(ACTION_EVIDENCE_SCHEMA_VERSION);
    expect(ACTION_EVIDENCE_SCHEMA_VERSION).toBe('action-evidence-schema/1.0');
    expect(schema.additionalProperties).toBe(false);
  });

  it('shares the value lists and the shapes with the other schemas by $ref (no copy)', () => {
    expect(prop(schema, 'runId').$ref).toBe('urn:beaksight:schema:run:1.0#/properties/runId');
    expect(prop(schema, 'jobId').$ref).toBe('urn:beaksight:schema:action-run:1.0#/$defs/id');
    expect(prop(schema, 'kind').$ref).toBe('urn:beaksight:schema:control:scenario:1#/properties/kind');
    expect(prop(schema, 'result').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/result');
    expect(prop(schema, 'reason').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/reason');
    expect(prop(schema, 'recordId').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/recordId');
    expect(firstOf(prop(schema, 'update')).$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/update');
    expect(firstOf(prop(schema, 'readVerification')).$ref).toBe('urn:beaksight:schema:read-evidence:1.0#/$defs/executed');
    expect(prop(defs.submission, 'state').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/submission');
    expect(prop(defs.submission, 'submittedValues').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/submittedValues');
    expect(firstOf(prop(defs.submission, 'actionPath')).$ref).toBe('urn:beaksight:schema:control:scenario:1#/$defs/request/properties/path');
    expect(prop(defs.precheck, 'blockReason').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/blockReason');
    expect(prop(defs.response, 'httpStatus').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/httpStatus');
    expect(prop(defs.response, 'judgement').$ref).toBe('urn:beaksight:schema:action-run:1.0#/properties/responseJudgement');
  });

  it('refers only to targets that exist, whose limits match the named constants', () => {
    const refs = schemaRefsOf(schema);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.filter((ref) => resolveRef(absoluteRef('urn:beaksight:schema:action-evidence:1.0', ref)) === undefined)).toEqual([]);

    expect(resolveRef(prop(schema, 'jobId').$ref ?? '')?.pattern).toBe(SCENARIO_ID_PATTERN.source);
    expect(resolveRef('urn:beaksight:schema:action-run:1.0#/properties/profileId')?.pattern).toBe(PROFILE_ID_PATTERN.source);
    const values = resolveRef(prop(defs.submission, 'submittedValues').$ref ?? '') ?? {};
    expect(values.maxProperties).toBe(MAX_SCENARIO_FIELD_NAMES);
    expect((values.propertyNames as JsonSchema).maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect((values.additionalProperties as JsonSchema).maxLength).toBe(MAX_SUBMITTED_VALUE_LENGTH);
    expect(resolveRef(firstOf(prop(defs.submission, 'actionPath')).$ref ?? '')?.maxLength).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    expect(firstOf(resolveRef(prop(schema, 'recordId').$ref ?? '') ?? {}).maxLength).toBe(MAX_RECORD_ID_LENGTH);
    const detail = resolveRef('urn:beaksight:schema:read-evidence:1.0#/$defs/detailEvidence/properties/observedValue') ?? {};
    expect(firstOf(detail).maxLength).toBe(MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH);
  });

  it('keeps the guard summary to counts and marks (the snapshot of the write stage fits without a copied type)', () => {
    const guard = defs.guardSummary ?? {};
    expect(guard.additionalProperties).toBe(false);
    expect(Object.keys(guard.properties ?? {}).sort()).toEqual([
      'blockedByOtherRulesInWindow', 'blockedByPayloadReason', 'blockedByReason', 'documentCharsetRead', 'responseDeliveryCanceled', 'submissionWindowOpen',
    ]);
    expect([...(guard.required ?? [])].sort()).toEqual(Object.keys(guard.properties ?? {}).sort());
    expect(typeof guardSummaryOf).toBe('function');
  });

  it('has no property for a credential, a cookie, a CSRF token, a hidden value, a lock version or an authenticated state', () => {
    expect(propertyNamesWithWords(schema, EVIDENCE_SECRET_PROPERTY_WORDS)).toEqual([]);
  });

  it.each<readonly [string, ActionEvidenceDocument]>([
    ['a verified CREATE', verifiedCreate()],
    ['a verified CREATE whose guard summary has every reason key at zero', verifiedCreate({ guard: quietGuard() })],
    ['a verified CREATE with a READ value read from the page', verifiedCreate({
      containsHumanEnteredValues: true,
      readVerification: executedRead({
        expectations: [
          { expectation: { kind: 'DETAIL_FIELD_EQUALS', field: '氏名', value: 'サンプル 太郎' }, result: 'MATCHED', undeterminedReason: null, observedValue: 'サンプル 太郎' },
        ],
      }),
    })],
    ['a verified UPDATE', verifiedUpdate()],
    ['an UPDATE whose check after the update was not reached', verifiedUpdate({
      containsHumanEnteredValues: false,
      update: { targetRecordId: '42', updateEvidence: null },
      readVerification: { readCheckId: 'rc-1', readCheckRevision: 2, state: 'NOT_EXECUTED' },
      result: 'PARTIAL',
      reason: 'UPDATE_POSTCHECK_UNDETERMINED',
    })],
    ['a partial run without a record id', verifiedCreate({
      recordId: null, readVerification: { readCheckId: 'rc-1', readCheckRevision: 2, state: 'NOT_EXECUTED' }, result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND',
    })],
    ['a run sent without a response', verifiedCreate({
      response: { httpStatus: null, judgement: null, judgedAt: null },
      recordId: null,
      readVerification: { readCheckId: 'rc-1', readCheckRevision: 2, state: 'NOT_EXECUTED' },
      result: 'UNKNOWN',
      reason: 'NO_RESPONSE',
    })],
    ['a failed run (input error)', verifiedCreate({
      response: { httpStatus: 422, judgement: 'INPUT_ERROR', judgedAt: '20261015000012' },
      recordId: null,
      readVerification: { readCheckId: 'rc-1', readCheckRevision: 2, state: 'NOT_EXECUTED' },
      result: 'FAILED',
      reason: 'INPUT_ERROR',
    })],
    ['a run whose READ verification did not match', verifiedCreate({
      readVerification: executedRead({ result: 'NOT_MATCHED' }), result: 'UNKNOWN', reason: 'READ_VERIFICATION_NOT_MATCHED',
    })],
    ['a blocked run (payload)', blockedCreate()],
    ['a blocked run by a check before sending, before the write stage', blockedCreate({
      precheck: { candidateDigestMatched: false, blockReason: 'PRECHECK_FAILED' }, guard: null, reason: 'PRECHECK_FAILED',
    })],
    ['a blocked run before the candidate check', blockedCreate({
      precheck: { candidateDigestMatched: null, blockReason: 'PRECHECK_FAILED' }, guard: null, reason: 'PRECHECK_FAILED',
    })],
    ['a blocked UPDATE', blockedCreate({ kind: 'UPDATE', update: { targetRecordId: 'rec_42-a', updateEvidence: null } })],
    ['a guard summary without every reason key', verifiedCreate({ guard: { ...quietGuard(), blockedByReason: {}, blockedByPayloadReason: {} } })],
  ])('accepts %s', async (_label, document) => {
    expect(await validateArtifact('action-evidence', document)).toEqual({ ok: true });
  });

  it.each<readonly [string, unknown]>([
    ['an unknown property', { ...verifiedCreate(), note: 'x' }],
    ['a cookie property', { ...verifiedCreate(), cookies: [] }],
    ['a hidden value', { ...verifiedCreate(), hiddenValues: { token: 'x' } }],
    ['a lock version', { ...verifiedCreate(), lock_version: '3' }],
    ['a submission with the request headers', verifiedCreate({ submission: { ...verifiedCreate().submission, headers: {} } as never })],
    ['a response with the body', verifiedCreate({ response: { httpStatus: 200, judgement: 'SUCCESS', judgedAt: '20261015000012', body: 'x' } as never })],
    ['a READ verification with the page text', verifiedCreate({ readVerification: { ...executedRead(), pageText: 'x' } as never })],
    ['a guard summary with a URL', verifiedCreate({ guard: { ...quietGuard(), blockedUrls: ['https://example.invalid/'] } as never })],
    ['a guard summary with an unknown reason', verifiedCreate({ guard: { ...quietGuard(), blockedByPayloadReason: { SOMETHING_ELSE: 1 } } })],
    ['a guard summary with an unknown stage reason', verifiedCreate({ guard: { ...quietGuard(), blockedByReason: { SOMETHING_ELSE: 1 } } })],
    ['a guard summary with a negative count', verifiedCreate({ guard: { ...quietGuard(), blockedByOtherRulesInWindow: -1 } })],
    ['a guard summary with a fractional count', verifiedCreate({ guard: { ...quietGuard(), blockedByReason: { SUBMISSION_WINDOW: 0.5 } } })],
    ['a missing result', (({ result: _omitted, ...rest }) => rest)(verifiedCreate())],
    ['a missing human value mark', (({ containsHumanEnteredValues: _omitted, ...rest }) => rest)(verifiedCreate())],
    ['an unknown result', verifiedCreate({ result: 'COMPLETE' as never })],
    ['an unknown kind', verifiedCreate({ kind: 'DELETE' as never })],
    ['an unknown submission state', verifiedCreate({ submission: { ...verifiedCreate().submission, state: 'MAYBE' as never } })],
    ['a too long submitted value', verifiedCreate({
      submission: { ...verifiedCreate().submission, submittedValues: { name: 'x'.repeat(MAX_SUBMITTED_VALUE_LENGTH + 1) } },
    })],
    ['an action path without "/"', verifiedCreate({ submission: { ...verifiedCreate().submission, actionPath: 'members' } })],
    ['a too long action path', verifiedCreate({
      submission: { ...verifiedCreate().submission, actionPath: `/${'x'.repeat(MAX_CANDIDATE_URL_PART_LENGTH)}` },
    })],
    ['a too long record id', verifiedCreate({ recordId: 'x'.repeat(MAX_RECORD_ID_LENGTH + 1) })],
    ['a bad HTTP status', verifiedCreate({ response: { httpStatus: 99, judgement: 'SUCCESS', judgedAt: '20261015000012' } })],
    ['a bad timestamp', verifiedCreate({ finishedAt: '2026-10-15T00:00:00Z' })],
    ['a bad run id', verifiedCreate({ runId: 'run-1' })],
    ['a too long READ value', verifiedCreate({
      containsHumanEnteredValues: true,
      readVerification: executedRead({
        expectations: [{
          expectation: { kind: 'DETAIL_FIELD_EQUALS', field: '氏名', value: 'x' }, result: 'NOT_MATCHED', undeterminedReason: null,
          observedValue: 'x'.repeat(MAX_READ_EVIDENCE_OBSERVED_TEXT_LENGTH + 1),
        }],
      }),
    })],
    ['a not executed READ with a result', verifiedCreate({
      readVerification: { readCheckId: 'rc-1', readCheckRevision: 2, state: 'NOT_EXECUTED', result: 'MATCHED' } as never,
    })],
    // 送らずに止めた回は、送った値・応答・登録の ID・照合の READ の証拠を持たない。
    ['a not sent run with submitted values', blockedCreate({
      submission: { state: 'NOT_SENT', submittedValues: { name: 'x' }, actionPath: null, submittedAt: null },
    })],
    ['a not sent run with an action path', blockedCreate({
      submission: { state: 'NOT_SENT', submittedValues: {}, actionPath: '/members', submittedAt: null },
    })],
    ['a not sent run with a submission time', blockedCreate({
      submission: { state: 'NOT_SENT', submittedValues: {}, actionPath: null, submittedAt: '20261015000010' },
    })],
    ['a not sent run with a response', blockedCreate({ response: { httpStatus: null, judgement: null, judgedAt: null } })],
    ['a not sent run with a record id', blockedCreate({ recordId: '42' })],
    ['a not sent run with an executed READ', blockedCreate({ readVerification: executedRead() })],
    ['a not sent run without a block reason', blockedCreate({ precheck: { candidateDigestMatched: true, blockReason: null } })],
    ['a not sent run that is not BLOCKED', blockedCreate({ result: 'FAILED', reason: 'INPUT_ERROR' })],
    // 送った回は、止めた理由を持たず、候補の digest が一致し、送信先と応答の項目を持つ。
    ['a sent run with a block reason', verifiedCreate({ precheck: { candidateDigestMatched: true, blockReason: 'PAYLOAD_MISMATCH' } })],
    ['a sent run whose candidate did not match', verifiedCreate({ precheck: { candidateDigestMatched: false, blockReason: null } })],
    ['a sent run without an action path', verifiedCreate({ submission: { ...verifiedCreate().submission, actionPath: null } })],
    ['a sent run without a response item', verifiedCreate({ response: null })],
    ['a sent run that is BLOCKED', verifiedCreate({ result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH' })],
    // CREATE は UPDATE の項目を持たず、UPDATE は持つ。
    ['a CREATE with an update block', verifiedCreate({ update: { targetRecordId: '42', updateEvidence: null } })],
    ['an UPDATE without an update block', verifiedUpdate({ update: null })],
    ['a kept field with a value', verifiedUpdate({
      update: { targetRecordId: '42', updateEvidence: { fields: [{ fieldName: 'email', role: 'KEPT', previousValue: 'x', newValue: null, matched: true }] } },
    })],
    // 人の値があるときに、注意の印を偽にしない。
    // 照合の READ は取れた値を持たない見本にして、変えた欄の前の値だけを人の値にする。
    ['an UPDATE with a prior value without the human value mark', verifiedUpdate({ containsHumanEnteredValues: false, readVerification: executedRead() })],    ['a READ value read from the page without the human value mark', verifiedCreate({
      readVerification: executedRead({
        expectations: [
          { expectation: { kind: 'DETAIL_FIELD_EQUALS', field: '氏名', value: 'サンプル 太郎' }, result: 'MATCHED', undeterminedReason: null, observedValue: 'サンプル 太郎' },
        ],
      }),
    })],
  ])('rejects %s', async (_label, document) => {
    expect((await validateArtifact('action-evidence', document)).ok).toBe(false);
  });
});
