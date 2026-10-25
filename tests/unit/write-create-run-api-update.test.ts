// T41d（Task 41 の設計書 3.4 の 3〜5）: ワーカーの API の更新の流れ（`src/worker/write-create-run.ts`）の純粋な部品。
// - 結果の判定（`apiUpdateResultOf`）: 状態の判定が成功でなければそのまま。成功で応答の本文が空の一覧（`[]`）なら、更新した行がないとして
//   `NO_CONDITION_MATCHED`（結果は `UNKNOWN`。今の閉じた一覧から選んだ）。T41R-fix（I-2）: 要素 2 つ以上の一覧なら、2 行以上を更新したとして
//   `MULTIPLE_CONDITIONS_MATCHED`（結果は `UNKNOWN`）。応答の本文の ID が対象の ID と違えば、その ID（判定は `actionOutcomeOf` の
//   `RECORD_ID_MISMATCH`）。ほかは対象の ID。
// - 後の照合の証拠（`apiUpdateEvidenceOf`）: 変えた欄は前の値と新しい値と一致の真偽、保つ欄とページが決める鍵は一致の真偽だけ（値を残さない）。読めなければ
//   一致は null。
// - 応答の本文の一覧の要素の数（`apiResponseListLength`。`src/control/actions/api-record-id.ts`）。
// - T41R-fix（C-1）: 前の読み取りが値の入った画面か（`apiUpdatePriorFilled`）と、押す直前の読み直しで押してよいか（`apiUpdateReadyToPress`）。
// - T41R3-fix（C-3）: 保つ鍵の値が台帳の値（`knownKeptValues`）と違うか（`apiUpdateKnownKeptMismatch`）と、後の照合での扱い。
import { describe, expect, it } from 'vitest';
import { actionRunRuleErrors } from '../../src/control/actions/action-api-summary.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { actionOutcomeOf, fieldsMatchedOf } from '../../src/control/actions/action-outcome.js';
import { MAX_API_RECORD_ID_BODY_BYTES, apiResponseListLength } from '../../src/control/actions/api-record-id.js';
import {
  apiUpdateEvidenceOf,
  apiUpdateKnownKeptMismatch,
  apiUpdatePriorFilled,
  isUnreadableApiResponseBody,
  apiUpdateReadyToPress,
  apiUpdateResultOf,
} from '../../src/worker/write-create-run.js';
import { sampleApiSummary, verifiedApiCreateDocuments } from '../helpers/action-report-samples.js';

const TARGET = '42';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('T41d: the result of an API update (apiUpdateResultOf)', () => {
  // `rowCount` は応答の本文の一覧の要素の数（一覧でなければ null。`apiResponseListLength`）。
  it.each([
    ['a success with the target id in the body', 'SUCCESS', TARGET, 1, { responseJudgement: 'SUCCESS', rawRecordId: TARGET }],
    ['a success with the target id in an object body', 'SUCCESS', TARGET, null, { responseJudgement: 'SUCCESS', rawRecordId: TARGET }],
    ['a success without an id in the body (204, or no id key)', 'SUCCESS', null, null, { responseJudgement: 'SUCCESS', rawRecordId: TARGET }],
    ['a success with another id in the body', 'SUCCESS', '43', 1, { responseJudgement: 'SUCCESS', rawRecordId: '43' }],
    ['a success with an empty list (no row updated)', 'SUCCESS', null, 0, { responseJudgement: 'NO_CONDITION_MATCHED', rawRecordId: null }],
    // T41R-fix（I-2）: 2 行以上を更新した（どの行が変わったか分からない）。成功と偽らない。
    ['a success with a list of two rows', 'SUCCESS', null, 2, { responseJudgement: 'MULTIPLE_CONDITIONS_MATCHED', rawRecordId: null }],
    ['a success with a list of three rows', 'SUCCESS', null, 3, { responseJudgement: 'MULTIPLE_CONDITIONS_MATCHED', rawRecordId: null }],
    ['an input error', 'INPUT_ERROR', null, null, { responseJudgement: 'INPUT_ERROR', rawRecordId: null }],
    ['a server error', 'SERVER_ERROR', null, 0, { responseJudgement: 'SERVER_ERROR', rawRecordId: null }],
    ['a rate limit', 'RATE_LIMITED', null, 2, { responseJudgement: 'RATE_LIMITED', rawRecordId: null }],
  ] as const)('judges %s', (_name, responseJudgement, bodyRecordId, rowCount, expected) => {
    expect(apiUpdateResultOf({ responseJudgement, targetRecordId: TARGET, bodyRecordId, rowCount })).toEqual(expected);
  });

  it('gives the closed results through actionOutcomeOf: another id is RECORD_ID_MISMATCH, an empty list and two rows are UNKNOWN', () => {
    const mismatch = apiUpdateResultOf({ responseJudgement: 'SUCCESS', targetRecordId: TARGET, bodyRecordId: '43', rowCount: 1 });
    expect(actionOutcomeOf({ submission: 'SENT', ...{ responseJudgement: mismatch.responseJudgement, recordId: mismatch.rawRecordId }, readVerification: 'MATCHED',
      update: { targetRecordId: TARGET, fieldsMatched: true } })).toEqual({ result: 'UNKNOWN', reason: 'RECORD_ID_MISMATCH' });
    const empty = apiUpdateResultOf({ responseJudgement: 'SUCCESS', targetRecordId: TARGET, bodyRecordId: null, rowCount: 0 });
    expect(actionOutcomeOf({ submission: 'SENT', responseJudgement: empty.responseJudgement, recordId: empty.rawRecordId, readVerification: null,
      update: { targetRecordId: TARGET, fieldsMatched: null } })).toEqual({ result: 'UNKNOWN', reason: 'NO_CONDITION_MATCHED' });
    const many = apiUpdateResultOf({ responseJudgement: 'SUCCESS', targetRecordId: TARGET, bodyRecordId: null, rowCount: 2 });
    expect(actionOutcomeOf({ submission: 'SENT', responseJudgement: many.responseJudgement, recordId: many.rawRecordId, readVerification: null,
      update: { targetRecordId: TARGET, fieldsMatched: null } })).toEqual({ result: 'UNKNOWN', reason: 'MULTIPLE_CONDITIONS_MATCHED' });
  });
});

describe('T41d: the evidence of the check after an API update (apiUpdateEvidenceOf)', () => {
  const prior = { changed: { name: '前の名前' }, kept: { email: 'kept@example.invalid', note: '備考' }, page: { tenant_id: 't-1' } };
  const values = { name: '新しい名前' };

  it('matches when the changed field has the new value and the kept fields keep the prior values, without the kept values', () => {
    const evidence = apiUpdateEvidenceOf(prior, { changed: { name: '新しい名前' }, kept: { email: 'kept@example.invalid', note: '備考' }, page: { tenant_id: 't-1' } }, values);
    expect(evidence).toEqual({
      fields: [
        { fieldName: 'name', role: 'CHANGED', previousValue: '前の名前', newValue: '新しい名前', matched: true },
        { fieldName: 'email', role: 'KEPT', previousValue: null, newValue: null, matched: true },
        { fieldName: 'note', role: 'KEPT', previousValue: null, newValue: null, matched: true },
        { fieldName: 'tenant_id', role: 'KEPT', previousValue: null, newValue: null, matched: true },
      ],
    });
    expect(fieldsMatchedOf(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('kept@example.invalid');
  });

  it('does not match when a kept field changed (a side effect) or the changed field did not take the new value', () => {
    expect(fieldsMatchedOf(apiUpdateEvidenceOf(prior, { ...prior, changed: { name: '新しい名前' }, kept: { email: 'kept@example.invalid', note: '変わった' } }, values)))
      .toBe(false);
    expect(fieldsMatchedOf(apiUpdateEvidenceOf(prior, prior, values))).toBe(false);
  });

  it('cannot match when the page after the update was not read', () => {
    const evidence = apiUpdateEvidenceOf(prior, null, values);
    expect(evidence.fields.map(({ matched }) => matched)).toEqual([null, null, null, null]);
    expect(fieldsMatchedOf(evidence)).toBeNull();
  });
});

describe('T41R-fix: the prior values before the page filled them, and the values just before the press', () => {
  const prior = { changed: { name: '前の名前' }, kept: { email: 'kept@example.invalid', note: '' }, page: { tenant_id: 't-1' } };
  const values = { name: '新しい名前' };

  it('treats a prior read whose marked fields (changed and kept) are all empty as read before the values were filled', () => {
    expect(apiUpdatePriorFilled(prior)).toBe(true);
    expect(apiUpdatePriorFilled({ changed: { name: '' }, kept: { email: '', note: '' }, page: { tenant_id: 't-1' } })).toBe(false);
    expect(apiUpdatePriorFilled({ changed: { name: '' }, kept: { email: '', note: 'x' }, page: {} })).toBe(true);
  });

  it('allows the press only when the kept and page key fields keep the prior values and the changed fields keep the generated values', () => {
    expect(apiUpdateReadyToPress(prior, { ...prior, changed: { name: '新しい名前' } }, values)).toBe(true);
    expect(apiUpdateReadyToPress(prior, { ...prior, changed: { name: '新しい名前' }, kept: { email: 'kept@example.invalid', note: '変わった' } }, values)).toBe(false);
    expect(apiUpdateReadyToPress(prior, { ...prior, changed: { name: '新しい名前' }, page: { tenant_id: 't-2' } }, values)).toBe(false);
    expect(apiUpdateReadyToPress(prior, prior, values)).toBe(false);
    expect(apiUpdateReadyToPress(prior, null, values)).toBe(false);
  });
});

describe('T41R3-fix: the kept values the ledger knows, and a body whose rows cannot be counted', () => {
  const prior = { changed: { name: '前の名前' }, kept: { email: 'kept@example.invalid', note: '' }, page: {} };
  const values = { name: '新しい名前' };
  const known = (entries: Readonly<Record<string, string>>) => Object.entries(entries).map(([key, value]) => ({ key, value }));

  // T41R3-fix（設計書 8 章の「T41R3」の (2)）: T41R2-fix の「空でないはずの保つ鍵」は、台帳の値と比べることに置き換えた（空の値は空と比べる）。
  it('finds a kept key of the list whose value differs from the ledger (a placeholder, an empty value, a change outside BeakSight)', () => {
    expect(apiUpdateKnownKeptMismatch(prior, known({ email: 'kept@example.invalid' }))).toBe(false);
    expect(apiUpdateKnownKeptMismatch(prior, known({ email: 'kept@example.invalid', note: '' }))).toBe(false);
    expect(apiUpdateKnownKeptMismatch({ ...prior, kept: { email: '読み込み中', note: '' } }, known({ email: 'kept@example.invalid' }))).toBe(true);
    expect(apiUpdateKnownKeptMismatch({ ...prior, kept: { email: '', note: '' } }, known({ email: 'kept@example.invalid' }))).toBe(true);
    expect(apiUpdateKnownKeptMismatch(prior, known({ note: '外で変えた' }))).toBe(true);
    expect(apiUpdateKnownKeptMismatch({ ...prior, kept: { email: '', note: '' } }, [])).toBe(false);
    // 一覧の鍵が読んだ値にない（保つ鍵でない）ときは、比べない（シナリオの保つ鍵だけを見る）。
    expect(apiUpdateKnownKeptMismatch(prior, known({ name: 'x', other: 'y' }))).toBe(false);
  });

  it('cannot match a kept key whose value after the update differs from the ledger (UPDATE_POSTCHECK_UNDETERMINED), and keeps the other fields', () => {
    const after = { changed: { name: '新しい名前' }, kept: { email: '読み込み中', note: '' }, page: {} };
    const evidence = apiUpdateEvidenceOf(prior, after, values, known({ email: 'kept@example.invalid' }));
    expect(evidence.fields.map(({ fieldName, matched }) => [fieldName, matched])).toEqual([['name', true], ['email', null], ['note', true]]);
    expect(fieldsMatchedOf(evidence)).toBeNull();
    expect(actionOutcomeOf({ submission: 'SENT', responseJudgement: 'SUCCESS', recordId: TARGET, readVerification: 'MATCHED',
      update: { targetRecordId: TARGET, fieldsMatched: fieldsMatchedOf(evidence) } })).toEqual({ result: 'PARTIAL', reason: 'UPDATE_POSTCHECK_UNDETERMINED' });
    // 一覧にない鍵は、今のまま前の値と照らす。
    expect(apiUpdateEvidenceOf(prior, after, values, []).fields.map(({ matched }) => matched)).toEqual([true, false, true]);
    // 台帳の値のままなら、今のまま照らす（一致）。
    expect(apiUpdateEvidenceOf(prior, { ...after, kept: prior.kept }, values, known({ email: 'kept@example.invalid' })).fields.map(({ matched }) => matched))
      .toEqual([true, true, true]);
  });

  it('does not judge a success when the body is not empty and cannot be read (over the limit, not JSON): NO_CONDITION_MATCHED', () => {
    expect(apiUpdateResultOf({ responseJudgement: 'SUCCESS', targetRecordId: TARGET, bodyRecordId: null, rowCount: null, bodyUnreadable: true }))
      .toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', rawRecordId: null });
    expect(apiUpdateResultOf({ responseJudgement: 'SUCCESS', targetRecordId: TARGET, bodyRecordId: null, rowCount: null, bodyUnreadable: false }))
      .toEqual({ responseJudgement: 'SUCCESS', rawRecordId: TARGET });
    expect(apiUpdateResultOf({ responseJudgement: 'SERVER_ERROR', targetRecordId: TARGET, bodyRecordId: null, rowCount: null, bodyUnreadable: true }))
      .toEqual({ responseJudgement: 'SERVER_ERROR', rawRecordId: null });
  });

  it('reads a body as unreadable only when it is not empty and over the limit or not JSON', () => {
    expect(isUnreadableApiResponseBody(bytes(''))).toBe(false);
    expect(isUnreadableApiResponseBody(bytes('[]'))).toBe(false);
    expect(isUnreadableApiResponseBody(bytes('{"id":1}'))).toBe(false);
    expect(isUnreadableApiResponseBody(bytes('updated'))).toBe(true);
    expect(isUnreadableApiResponseBody(bytes('  '))).toBe(true);
    expect(isUnreadableApiResponseBody(new Uint8Array([0x5b, 0xff, 0x5d]))).toBe(true);
    expect(isUnreadableApiResponseBody(new Uint8Array(MAX_API_RECORD_ID_BODY_BYTES + 1).fill(0x20))).toBe(true);
  });
});

describe('T41d: the record of an API update has no page key value (actionRunRuleErrors)', () => {
  // Task 41 の設計書 8 章の「T41a・T41c の報告と設計者の判断」の (3): UPDATE の `pageKeyValues` は空（前の値を記録に残さない）。親の照らし合わせ
  // （`actionRunMatchesWriteStart`）が使う手書きの確かめが、ページが決める鍵を持つ API の更新の記録を拒まないこと。
  const update = { targetRecordId: TARGET, updateEvidence: null };
  const apiRun = (pageKeyValues: Record<string, string | null> | null, withUpdate: boolean): ActionRunDocument => ({
    ...verifiedApiCreateDocuments().actionRun,
    api: sampleApiSummary({ pageKeyValues }),
    ...(withUpdate ? { update } : {}),
  });

  it('accepts an update run with the page keys and no page key value', () => {
    expect(actionRunRuleErrors(apiRun({}, true))).toEqual([]);
  });

  it('rejects an update run that keeps a page key value, and a create run without one (as before)', () => {
    expect(actionRunRuleErrors(apiRun({ tenant_id: '"t"' }, true)).length).toBeGreaterThan(0);
    expect(actionRunRuleErrors(apiRun({}, false)).length).toBeGreaterThan(0);
    expect(actionRunRuleErrors(apiRun({ tenant_id: '"t"' }, false))).toEqual([]);
  });
});

describe('T41d・T41R-fix: the number of the rows of a list as the response body (apiResponseListLength)', () => {
  it.each<readonly [string, number | null]>([
    ['[]', 0],
    [' [ ] ', 0],
    ['[{"id":1}]', 1],
    ['[{"id":12},{"id":13}]', 2],
    ['[1,2,3]', 3],
    ['{}', null],
    ['{"id":1}', null],
    ['', null],
    ['not json', null],
  ])('counts %j', (body, expected) => {
    expect(apiResponseListLength(bytes(body))).toBe(expected);
  });

  it('does not read a body that is not UTF-8 or over the limit', () => {
    expect(apiResponseListLength(new Uint8Array([0x5b, 0xff, 0x5d]))).toBeNull();
    expect(apiResponseListLength(new Uint8Array(MAX_API_RECORD_ID_BODY_BYTES + 1).fill(0x20))).toBeNull();
  });
});
