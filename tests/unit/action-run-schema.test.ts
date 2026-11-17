// T30a（Task 30 の設計書 3 章の「記録」、ロードマップ 5 章の `ActionResult`）: 書き込みのジョブの記録 `action-run.json` のスキーマ
// （`schemas/action-run.schema.json`）と、契約（`src/control/actions/action-contracts.ts`）の一致。
// - 成果物のスキーマの一覧（`src/core/schema-validator.ts`）に登録する。公開監査の `run.json` のスキーマは変えない（`runId` を参照するだけ）。
// - 受ける形と拒む形。送らずに止めた記録は `BLOCKED`・`RELEASED` で、応答・登録の ID・照合を持たない（送った記録は `BLOCKED` にならない）。
// - 資格情報・Cookie・CSRF のトークン・hidden の値・認証の状態の項目を置かない（項目の名前の走査）。送った値は合成のテストデータなので平文。
// - 上限・形・分岐の const は、契約の名前つきの定数と一致する（enum の一致は `schema-enum-consistency.test.ts` の対応表）。
import { describe, expect, it } from 'vitest';
import {
  ACTION_RUN_SCHEMA_VERSION,
  type ActionRunDocument,
} from '../../src/control/actions/action-contracts.js';
import { SCENARIO_ID_PATTERN } from '../../src/control/approval/scenario-contracts.js';
import { PROFILE_ID_PATTERN } from '../../src/control/contracts.js';
import { MAX_UNIQUE_RETRIES } from '../../src/control/data-rules/rule-contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { blockedDocuments, verifiedCreateDocuments } from '../helpers/action-report-samples.js';
import { prop, propertyNamesWithWords, readSchemaFile, SECRET_PROPERTY_WORDS, type JsonSchema } from '../helpers/schema-test-support.js';

const schema = readSchemaFile('action-run.schema.json');
const defs = schema.$defs ?? {};

/** 照合まで済んだ記録（`VERIFIED`。`action-report-samples.ts` の見本）。値は匿名の合成のテストデータだけ。 */
const verifiedRun = (overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => ({
  ...verifiedCreateDocuments().actionRun,
  ...overrides,
});

/** 送らずに止めた記録（`BLOCKED`。`action-report-samples.ts` の見本）。 */
const blockedRun = (overrides: Partial<ActionRunDocument> = {}): ActionRunDocument => ({
  ...blockedDocuments().actionRun,
  ...overrides,
});

describe('action-run.json schema (T30a)', () => {
  it('has the artifact id and the named version', () => {
    expect(schema.$id).toBe('urn:beaksight:schema:action-run:1.0');
    // T40c: 書き手は 1.1 を書き、読み手は 1.0 と 1.1 を受ける（版の一覧とスキーマの enum の一致は `action-run-v11.test.ts`）。
    expect(prop(schema, 'schemaVersion').enum).toContain(ACTION_RUN_SCHEMA_VERSION);
    // PL-6a: 書き手は 1.2 を書き、読み手は 1.1 と 1.2 を受ける。
    expect(ACTION_RUN_SCHEMA_VERSION).toBe('action-run-schema/1.2');
    expect(prop(schema, 'schemaVersion').enum).toEqual(['action-run-schema/1.1', 'action-run-schema/1.2']);
  });

  it('matches the limits and the shapes with the named constants', () => {
    expect(defs.id?.pattern).toBe(SCENARIO_ID_PATTERN.source);
    expect(prop(schema, 'profileId').pattern).toBe(PROFILE_ID_PATTERN.source);
    const values = prop(schema, 'submittedValues');
    // L13（N28・N30）: 送った値の数と名前の長さの上限（前は 200・256）はない。
    expect(values.maxProperties).toBeUndefined();
    expect((values.propertyNames as JsonSchema).maxLength).toBeUndefined();
    // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S18）: 送った値の長さの上限（前は `MAX_SUBMITTED_VALUE_LENGTH`）を撤廃した。
    expect((values.additionalProperties as JsonSchema).maxLength).toBeUndefined();
    expect(prop(prop(schema, 'seedRecord'), 'attempt').maximum).toBe(MAX_UNIQUE_RETRIES);
    // URL-LEN: path の前方一致の長さの上限（前は 2,048）はない。
    expect(prop(defs.condition, 'pathPrefix').maxLength).toBeUndefined();
    // LZ-2: セレクタの長さの上限（前は 256）もない。
    expect((prop(defs.condition, 'selector').anyOf ?? [])[0]?.maxLength).toBeUndefined();
    // L12b（設計者の判断 2）: 登録の ID の長さの上限（前は `MAX_RECORD_ID_LENGTH` の 256）は撤廃した。
    expect((prop(schema, 'recordId').anyOf ?? [])[0]?.maxLength).toBeUndefined();
  });

  it('refers to the runId of run.json without changing the run schema', () => {
    expect(prop(schema, 'runId').$ref).toBe('urn:beaksight:schema:run:1.0#/properties/runId');
  });

  it('has no property for a credential, a cookie, a CSRF token, a hidden value or an authenticated state', () => {
    expect(propertyNamesWithWords(schema, SECRET_PROPERTY_WORDS)).toEqual([]);
    expect(schema.additionalProperties).toBe(false);
  });

  it.each<readonly [string, ActionRunDocument]>([
    ['a verified run', verifiedRun()],
    ['a partial run without a record id', verifiedRun({ recordId: null, readVerification: null, result: 'PARTIAL', reason: 'RECORD_ID_NOT_FOUND' })],
    ['an unknown run without a response', verifiedRun({
      submission: 'UNKNOWN', httpStatus: null, responseJudgement: null, recordId: null, readVerification: null,
      reservationState: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE',
    })],
    ['a failed run (input error)', verifiedRun({
      httpStatus: 422, responseJudgement: 'INPUT_ERROR', recordId: null, readVerification: null, result: 'FAILED', reason: 'INPUT_ERROR',
    })],
    ['a blocked run', blockedRun()],
    ['a blocked run by a check before sending', blockedRun({ blockReason: 'PRECHECK_FAILED', reason: 'PRECHECK_FAILED' })],
    // T44e（Task 44 の設計書 P2-4）: 送らずに止めた具体的な理由（任意の項目。`PRECHECK_FAILED` のときだけ）。
    ['a blocked run by a check before sending with its concrete reason', blockedRun({
      blockReason: 'PRECHECK_FAILED', reason: 'PRECHECK_FAILED', precheckDetail: 'KNOWN_KEPT_VALUE_MISMATCH',
    })],
    ['a run that sent no value (all values not sent)', verifiedRun({ submittedValues: {} })],
  ])('accepts %s', async (_label, document) => {
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
  });

  it.each<readonly [string, unknown]>([
    ['an unknown property', { ...verifiedRun(), note: 'x' }],
    // T44e: 具体的な理由は、閉じた一覧の値で、`PRECHECK_FAILED` のときだけ。
    ['an unknown concrete reason of a stop', blockedRun({ blockReason: 'PRECHECK_FAILED', reason: 'PRECHECK_FAILED', precheckDetail: 'MAYBE' as never })],
    ['a concrete reason with the payload mismatch', blockedRun({ precheckDetail: 'PRIOR_VALUE_CHANGED' })],
    ['a concrete reason on a sent run', verifiedRun({ precheckDetail: 'STOPPED' })],
    ['a cookie property', { ...verifiedRun(), cookies: [] }],
    ['a hidden value', { ...verifiedRun(), hiddenValues: { token: 'x' } }],
    ['a missing result', (({ result: _omitted, ...rest }) => rest)(verifiedRun())],
    ['an unknown result', verifiedRun({ result: 'COMPLETE' as never })],
    ['an unknown submission state', verifiedRun({ submission: 'MAYBE' as never })],
    ['a non-string submitted value', verifiedRun({ submittedValues: { name: 1 } as never })],
    ['an empty submitted field name', verifiedRun({ submittedValues: { '': 'x' } })],
    // L12b（S18）: 送った値の長さの上限を撤廃したので、長い値は拒まない（下の受ける場合の表）。
    ['an empty record id', verifiedRun({ recordId: '' })],
    ['a bad HTTP status', verifiedRun({ httpStatus: 99 })],
    ['a bad seed', verifiedRun({ seedRecord: { ...verifiedRun().seedRecord, seed: 'xyz' as never } })],
    ['a bad base date', verifiedRun({ seedRecord: { ...verifiedRun().seedRecord, baseDate: '20261013' } })],
    ['an attempt above the retries', verifiedRun({ seedRecord: { ...verifiedRun().seedRecord, attempt: MAX_UNIQUE_RETRIES + 1 } })],
    ['a bad run id', verifiedRun({ runId: 'run-1' })],
    ['a bad timestamp', verifiedRun({ finishedAt: '2026-10-13T00:00:00Z' })],
    ['a RESERVED reservation (not settled)', verifiedRun({ reservationState: 'RESERVED' as never })],
    // PL-6a: 版 1.2 の結果の判定のしかたの印は、閉じた一覧の値だけ（成否の条件の項目は持てない）。
    ['an unknown result judgement', verifiedRun({ resultJudgement: 'SUCCESS_CONDITION' as never })],
    ['a 1.2 run with the result conditions of 1.1', {
      ...verifiedRun(), resultConditions: { successCondition: { pathPrefix: '/members/', selector: null }, inputErrorCondition: { pathPrefix: '/members', selector: null } },
    }],
    ['a not sent run without a block reason', blockedRun({ blockReason: null })],
    ['a not sent run with a response', blockedRun({ httpStatus: 200 })],
    ['a not sent run with a response judgement', blockedRun({ responseJudgement: 'SUCCESS' })],
    ['a not sent run with a record id', blockedRun({ recordId: '42' })],
    ['a not sent run with a READ verification', blockedRun({ readVerification: { readCheckId: 'rc-1', readCheckRevision: 2, result: 'MATCHED' } })],
    ['a not sent run with a submission time', blockedRun({ submittedAt: '20261013000010' })],
    ['a not sent run with a consumed reservation', blockedRun({ reservationState: 'COMMITTED' })],
    ['a not sent run that is not BLOCKED', blockedRun({ result: 'FAILED' })],
    ['a sent run with a block reason', verifiedRun({ blockReason: 'PAYLOAD_MISMATCH' })],
    ['a sent run that is BLOCKED', verifiedRun({ result: 'BLOCKED' })],
    ['a sent run with a released reservation', verifiedRun({ reservationState: 'RELEASED' })],
  ])('rejects %s', async (_label, document) => {
    expect((await validateArtifact('action-run', document)).ok).toBe(false);
  });
});

// T31f（Task 31 の設計書 3 章の「証拠と記録」。T31g-2 が書く形をここで決める）: UPDATE の書き込みの記録。CREATE の記録と同じ形に、任意の `update`
// （許可から写した対象のレコードの ID と、更新の後の照合の証拠 `updateEvidence`）を足す。取れた ID は CREATE と同じ `recordId`。証拠の欄は、変える欄
// （前の値と新しい値を持つ）と保つ欄（値を持たない。一致の真偽だけ）。保つ欄の値・hidden の値・CSRF のトークンの項目はない。
describe('action-run.json schema: the update block (T31f)', () => {
  const evidence = Object.freeze({
    fields: [
      { fieldName: 'name', role: 'CHANGED', previousValue: 'サンプル 太郎', newValue: 'サンプル 次郎', matched: true },
      { fieldName: 'email', role: 'KEPT', previousValue: null, newValue: null, matched: true },
    ],
  });
  /** UPDATE の照合まで済んだ記録。 */
  const updatedRun = (update: unknown = { targetRecordId: '42', updateEvidence: evidence }, overrides: Partial<ActionRunDocument> = {}): unknown =>
    ({ ...verifiedRun({ submittedValues: { name: 'サンプル 次郎' }, ...overrides }), update });
  const fieldOf = (overrides: Record<string, unknown>): unknown => ({ fields: [{ ...evidence.fields[0], ...overrides }] });

  it('matches the limits of the update block with the named constants', () => {
    const update = prop(schema, 'update');
    expect(update.additionalProperties).toBe(false);
    expect(Object.keys(update.properties ?? {}).sort()).toEqual(['targetRecordId', 'updateEvidence']);
    // L12b（設計者の判断 2）: 対象のレコードの ID の長さの上限（前は `MAX_SAFE_RECORD_ID_LENGTH`）は撤廃した。
    expect(prop(update, 'targetRecordId').maxLength).toBeUndefined();
    // L13（N28・N30）: 欄の数と名前の長さの上限（前は 200・256）はない。
    expect(prop(defs.updateEvidence, 'fields').maxItems).toBeUndefined();
    expect(prop(defs.updateEvidenceField, 'fieldName').maxLength).toBeUndefined();
    // L12b（S18）: 前の値と新しい値の長さの上限を撤廃した。
    for (const key of ['previousValue', 'newValue']) {
      expect((prop(defs.updateEvidenceField, key).anyOf ?? [])[0]?.maxLength, key).toBeUndefined();
    }
    expect(schema.required).not.toContain('update');
  });

  it.each<readonly [string, unknown]>([
    ['a verified update', updatedRun()],
    ['an update without evidence of the check after the update', updatedRun({ targetRecordId: '42', updateEvidence: null },
      { result: 'PARTIAL', reason: 'UPDATE_POSTCHECK_UNDETERMINED' })],
    ['an update with a field that could not be checked', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ matched: null }) },
      { result: 'PARTIAL', reason: 'UPDATE_POSTCHECK_UNDETERMINED' })],
    ['an update with another record id', updatedRun(undefined, { recordId: '43', result: 'UNKNOWN', reason: 'RECORD_ID_MISMATCH' })],
    ['a blocked update', { ...blockedRun(), update: { targetRecordId: 'rec_42-a', updateEvidence: null } }],
    // L12b（設計者の判断 2）: 登録の ID と対象のレコードの ID の長さの上限は撤廃した。
    ['an update with a target and a record id of 300 characters', updatedRun({ targetRecordId: 'a'.repeat(300), updateEvidence: evidence },
      { recordId: 'a'.repeat(300) })],
  ])('accepts %s', async (_label, document) => {
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
  });

  it.each<readonly [string, unknown]>([
    ['a target that is not a record id', updatedRun({ targetRecordId: '4/2', updateEvidence: evidence })],
    ['an empty target', updatedRun({ targetRecordId: '', updateEvidence: evidence })],
    ['an update block without the evidence item', updatedRun({ targetRecordId: '42' })],
    ['an update block with the kept values', updatedRun({ targetRecordId: '42', updateEvidence: evidence, keptValues: { email: 'x' } })],
    ['evidence with another property', updatedRun({ targetRecordId: '42', updateEvidence: { ...evidence, note: 'x' } })],
    ['a field with an unknown role', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ role: 'HIDDEN' }) })],
    ['a changed field without the prior value', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ previousValue: null }) })],
    ['a changed field without the new value', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ newValue: null }) })],
    ['a kept field with a value', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ role: 'KEPT', previousValue: null, newValue: 'x' }) })],
    ['a kept field with a prior value', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ role: 'KEPT', previousValue: 'x', newValue: null }) })],
    ['a field whose match is not a boolean', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ matched: 'yes' }) })],
    ['a field with an empty name', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ fieldName: '' }) })],
    ['a field with a value of a hidden field', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ hiddenValue: 'x' }) })],
  ])('rejects %s', async (_label, document) => {
    expect((await validateArtifact('action-run', document)).ok).toBe(false);
  });

  // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。S18）: 値の長さの上限（前は `MAX_SUBMITTED_VALUE_LENGTH`）を撤廃した。長い値も書ける。
  it.each<[string, unknown]>([
    ['a submitted value longer than the former limit', verifiedRun({ submittedValues: { name: 'x'.repeat(8_193) } })],
    ['a new value longer than the former limit', updatedRun({ targetRecordId: '42', updateEvidence: fieldOf({ newValue: 'x'.repeat(8_193) }) })],
  ])('accepts %s (L12b)', async (_label, document) => {
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
  });
});
