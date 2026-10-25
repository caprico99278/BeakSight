// 管理データの書き込みの結果の表（`write_results`）の結合テスト（T30d・T31e・T40c。Task 30 の設計書 3 章の「記録」、Task 31 の設計書 3 章、Task 40 の
// 設計書 3.4）。LG-2 で、版ごとのテスト（`control-store-v8`・`v9`・`v14`）の今の形の確かめを、今の版の管理データの上にまとめた（前の版からの上げ、
// 前の版の形と文の固定、開くときの列の確かめは捨てた。CHECK の値の一覧が名前つきの一覧と等しいことは `control-store-base-schema.test.ts`）。
// - STRICT、プロファイル・シナリオ・許可への外部キー。締める前と締めた行の形、送らずに止めた行の形、照合まで済んだ行の形。
// - 書き込みの種類（登録・更新）、更新の対象のレコードの ID（使える形）、更新の証拠（締めた更新の行だけ）。
// - 送り方（`FORM`・`API`。既定は `FORM`）と API の型の要約（API の行は 4 つの列をすべて持ち、FORM の行は持たない）。
// 一時のフォルダだけを使い、終わったら消す。
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MAX_SAFE_RECORD_ID_LENGTH } from '../../src/control/actions/action-outcome.js';
import { MAX_API_SHAPE_PATH_LENGTH } from '../../src/core/api-request-shape.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import {
  countOf,
  foreignTablesOf,
  indexNamesOf,
  insertRow,
  tableSqlOf,
  useControlStoreWorkspace,
  type SqlValue,
} from '../helpers/control-store-schema.js';

const PROFILE_ID = 'example-write-results';
const CREATED_AT = '20261014000000';
const LATER_AT = '20261014000100';
const SETTLED_AT = '20261014000200';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHAPE_DIGEST = `sha256:${'b'.repeat(64)}`;
const API_ORIGIN = 'http://127.0.0.2:4174';
const API_PATH = '/rest/v1/members';

const workspace = useControlStoreWorkspace('beaksight-control-write-results-');

/** 今の版の管理データに、プロファイル・シナリオ・承認の記録・許可 4 件（4 件目は更新の対象のレコードの ID つき）を入れた接続。 */
const latestConnection = (): DatabaseSync => {
  const connection = workspace.latestConnection([PROFILE_ID]);
  insertRow(connection, 'scenarios', {
    scenario_id: 'scenario-1', profile_id: PROFILE_ID, revision: 1, state: 'APPROVED', last_approval_receipt_id: 'receipt-1',
    created_at: CREATED_AT, updated_at: CREATED_AT,
  });
  insertRow(connection, 'approval_receipts', {
    receipt_id: 'receipt-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', kind: 'APPROVAL', scenario_revision: 1, approval_digest: DIGEST,
    target_receipt_id: null, recorded_at: CREATED_AT, expires_at: '20261113000000', document: '{}',
  });
  for (const suffix of ['1', '2', '3', '4']) {
    insertRow(connection, 'execution_grants', {
      grant_id: `grant-${suffix}`, profile_id: PROFILE_ID, scenario_id: 'scenario-1', scenario_revision: 1, approval_receipt_id: 'receipt-1',
      job_id: `job-w${suffix}`, issued_at: CREATED_AT, expires_at: '20261014000500', consumed_at: LATER_AT, invalidated_at: null,
      target_record_id: suffix === '4' ? '42' : null,
    });
  }
  return connection;
};

/** 書き込みの結果の、締める前の行（登録）。 */
const pendingRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => ({
  job_id: 'job-w1', grant_id: 'grant-1', profile_id: PROFILE_ID, scenario_id: 'scenario-1', scenario_revision: 1, write_kind: 'CREATE',
  seed_record: '{"seed":"x"}', submitted_values: '{"name":"サンプル 太郎"}', unique_key: '{"name":"サンプル 太郎"}', phone_numbers: '[]',
  recorded_at: CREATED_AT, ...row,
});

/** 照合まで済んだ、締めた行。 */
const verifiedRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => pendingRow({
  submission: 'SENT', block_reason: null, http_status: 200, response_judgement: 'SUCCESS', record_id: '42', read_verification: 'MATCHED',
  result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservation_state: 'COMMITTED', submitted_at: LATER_AT, settled_at: SETTLED_AT, ...row,
});

/** 送らずに止めた、締めた行。 */
const blockedRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> => pendingRow({
  submission: 'NOT_SENT', block_reason: 'PAYLOAD_MISMATCH', result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH', reservation_state: 'RELEASED',
  settled_at: SETTLED_AT, ...row,
});

/** UPDATE の証拠（変えた欄の前と新しい値、保つ欄の一致の真偽）。 */
const EVIDENCE = JSON.stringify({ fields: [
  { fieldName: 'name', role: 'CHANGED', previousValue: 'サンプル 太郎', newValue: 'サンプル 花子', matched: true },
  { fieldName: 'email', role: 'KEPT', previousValue: null, newValue: null, matched: true },
] });

/** API の型の要約の列。 */
const API_COLUMNS: Record<string, SqlValue> = Object.freeze({
  transport: 'API', api_shape_digest: SHAPE_DIGEST, api_method: 'POST', api_origin: API_ORIGIN, api_path_shape: API_PATH,
});

describe('Control store: the write result table', () => {
  it('makes a STRICT table with foreign keys to the profiles, the scenarios and the grants', () => {
    const connection = latestConnection();
    expect(tableSqlOf(connection, 'write_results')).toMatch(/\)\s*STRICT$/u);
    expect(foreignTablesOf(connection, 'write_results')).toEqual(['execution_grants', 'profiles', 'scenarios']);
    expect(indexNamesOf(connection, 'write_results')).toEqual(['write_results_profile', 'write_results_scenario_recorded']);
  });
});

// T30d: 締める前と締めた行の形（前は版 8 の管理データで確かめていた。今の版の行で同じ形を確かめる）。
describe('Control store: the rows of a write result (T30d)', () => {
  it.each<readonly [string, Record<string, SqlValue>]>([
    ['a pending row', pendingRow()],
    ['a pending row without a seed record and values (closed by the recovery)', pendingRow({ seed_record: null, submitted_values: '{}', unique_key: null })],
    ['a verified row', verifiedRow()],
    ['a blocked row', blockedRow()],
    ['an unknown row without a response', pendingRow({
      submission: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE', reservation_state: 'UNKNOWN', settled_at: SETTLED_AT,
    })],
    ['a failed row (input error)', verifiedRow({ http_status: 422, response_judgement: 'INPUT_ERROR', record_id: null, read_verification: null,
      result: 'FAILED', reason: 'INPUT_ERROR' })],
  ])('accepts %s', (_label, row) => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', row);
    expect(countOf(connection, 'write_results')).toBe(1);
  });

  it.each<readonly [string, Record<string, SqlValue>]>([
    ['a second result of the grant', pendingRow({ job_id: 'job-w9' })],
    ['a second result of the job', pendingRow({ grant_id: 'grant-2' })],
    ['a missing grant', pendingRow({ job_id: 'job-w3', grant_id: 'grant-missing' })],
    ['a bad job id', pendingRow({ job_id: 'Job W3', grant_id: 'grant-2' })],
    ['values that are not an object', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', submitted_values: '[]' })],
    ['phone numbers that are not an array', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', phone_numbers: '{}' })],
    ['a result without a settlement time', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', submission: 'UNKNOWN', result: 'UNKNOWN',
      reason: 'NO_RESPONSE', reservation_state: 'UNKNOWN' })],
    ['a settlement time without a result', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', settled_at: SETTLED_AT })],
    ['a pending row with a response', pendingRow({ job_id: 'job-w2', grant_id: 'grant-2', http_status: 200 })],
    ['an unknown submission state', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', submission: 'MAYBE' })],
    ['an unknown result', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', result: 'COMPLETE' })],
    ['a RESERVED settlement', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', reservation_state: 'RESERVED' })],
    ['a NOT_SENT row that is not BLOCKED', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', result: 'FAILED', reason: 'INPUT_ERROR' })],
    ['a NOT_SENT row with a consumed reservation', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', reservation_state: 'COMMITTED' })],
    ['a NOT_SENT row with a response', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', http_status: 200 })],
    ['a NOT_SENT row with a submission time', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', submitted_at: LATER_AT })],
    ['a NOT_SENT row without a block reason', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2', block_reason: null })],
    ['a SENT row with a block reason', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', block_reason: 'PAYLOAD_MISMATCH' })],
    ['a SENT row that is BLOCKED', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', result: 'BLOCKED', reason: 'PAYLOAD_MISMATCH' })],
    ['a SENT row with a released reservation', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', reservation_state: 'RELEASED' })],
    ['a VERIFIED row without a matched READ', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', read_verification: 'UNDETERMINED' })],
    ['a VERIFIED row without a record id', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', record_id: null })],
    ['an empty record id', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', record_id: '' })],
    ['a bad HTTP status', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', http_status: 99 })],
    ['a settlement before the record', verifiedRow({ job_id: 'job-w2', grant_id: 'grant-2', settled_at: '20261012000000' })],
  ])('rejects %s', (_label, row) => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', pendingRow());
    expect(() => insertRow(connection, 'write_results', row)).toThrow();
    expect(countOf(connection, 'write_results')).toBe(1);
  });

  it('accepts a second write result for another grant', () => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', pendingRow());
    insertRow(connection, 'write_results', blockedRow({ job_id: 'job-w2', grant_id: 'grant-2' }));
    expect(countOf(connection, 'write_results')).toBe(2);
  });
});

// T31e: 書き込みの種類、更新の対象のレコードの ID、更新の証拠。
describe('Control store: the write kind, the target and the update evidence of a write result (T31e)', () => {
  it.each<readonly [string, Record<string, SqlValue>]>([
    ['a pending create row', pendingRow()],
    ['a verified create row', verifiedRow()],
    ['a blocked create row', blockedRow()],
    ['a pending update row', pendingRow({ write_kind: 'UPDATE', target_record_id: 'rec_42-A' })],
    ['a verified update row with its evidence', verifiedRow({ write_kind: 'UPDATE', target_record_id: '42', update_evidence: EVIDENCE })],
    ['an unknown update row without evidence', pendingRow({ write_kind: 'UPDATE', target_record_id: '42', submission: 'UNKNOWN', result: 'UNKNOWN',
      reason: 'NO_RESPONSE', reservation_state: 'UNKNOWN', settled_at: SETTLED_AT })],
    ['a blocked update row', blockedRow({ write_kind: 'UPDATE', target_record_id: '42' })],
    ['a target id of the maximum length', pendingRow({ write_kind: 'UPDATE', target_record_id: 'x'.repeat(MAX_SAFE_RECORD_ID_LENGTH) })],
  ])('accepts %s', (_label, row) => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', row);
    expect(countOf(connection, 'write_results')).toBe(1);
  });

  it.each<readonly [string, Record<string, SqlValue>]>([
    ['an unknown write kind', pendingRow({ write_kind: 'DELETE' })],
    ['a missing write kind', pendingRow({ write_kind: null })],
    ['a create row with a target', pendingRow({ target_record_id: '42' })],
    ['an update row without a target', pendingRow({ write_kind: 'UPDATE' })],
    ['a target with a slash', pendingRow({ write_kind: 'UPDATE', target_record_id: '4/2' })],
    ['a target with a dot', pendingRow({ write_kind: 'UPDATE', target_record_id: '4.2' })],
    ['a target with a space', pendingRow({ write_kind: 'UPDATE', target_record_id: '4 2' })],
    ['a non-ASCII target', pendingRow({ write_kind: 'UPDATE', target_record_id: 'レコード' })],
    ['an empty target', pendingRow({ write_kind: 'UPDATE', target_record_id: '' })],
    ['a too long target', pendingRow({ write_kind: 'UPDATE', target_record_id: 'x'.repeat(MAX_SAFE_RECORD_ID_LENGTH + 1) })],
    ['evidence of a create row', verifiedRow({ update_evidence: EVIDENCE })],
    ['evidence of a pending update row', pendingRow({ write_kind: 'UPDATE', target_record_id: '42', update_evidence: EVIDENCE })],
    ['evidence that is not an object', verifiedRow({ write_kind: 'UPDATE', target_record_id: '42', update_evidence: '[]' })],
    ['a verified update row without evidence', verifiedRow({ write_kind: 'UPDATE', target_record_id: '42' })],
  ])('rejects %s', (_label, row) => {
    const connection = latestConnection();
    expect(() => insertRow(connection, 'write_results', row)).toThrow();
    expect(countOf(connection, 'write_results')).toBe(0);
  });
});

// T40c: 送り方と API の型の要約。
describe('Control store: the transport and the API summary of a write result (T40c)', () => {
  it.each<readonly [string, Record<string, SqlValue>]>([
    ['a FORM row written without the transport (the default FORM)', verifiedRow()],
    ['a FORM row with the transport', verifiedRow({ transport: 'FORM' })],
    ['a pending API row', pendingRow(API_COLUMNS)],
    ['a verified API row', verifiedRow(API_COLUMNS)],
    ['a blocked API row', blockedRow(API_COLUMNS)],
    ['an API row of the longest origin and path', pendingRow({
      ...API_COLUMNS, api_origin: `http://${'a'.repeat(MAX_URL_LENGTH - 7)}`, api_path_shape: `/${'p'.repeat(MAX_API_SHAPE_PATH_LENGTH - 1)}`,
    })],
  ])('accepts %s', (_label, row) => {
    const connection = latestConnection();
    insertRow(connection, 'write_results', row);
    expect(countOf(connection, 'write_results')).toBe(1);
    expect(connection.prepare('SELECT transport FROM write_results').get()).toEqual({ transport: row['transport'] ?? 'FORM' });
  });

  it.each<readonly [string, Record<string, SqlValue>]>([
    ['an unknown transport', pendingRow({ transport: 'GRAPHQL' })],
    ['a null transport', pendingRow({ transport: null })],
    ['an API row without the summary', pendingRow({ transport: 'API' })],
    ['an API row without the shape digest', pendingRow({ ...API_COLUMNS, api_shape_digest: null })],
    ['an API row without the method', pendingRow({ ...API_COLUMNS, api_method: null })],
    ['an API row without the origin', pendingRow({ ...API_COLUMNS, api_origin: null })],
    ['an API row without the path shape', pendingRow({ ...API_COLUMNS, api_path_shape: null })],
    ['a FORM row with an API summary', pendingRow({ ...API_COLUMNS, transport: 'FORM' })],
    ['a FORM row with a shape digest only', pendingRow({ api_shape_digest: SHAPE_DIGEST })],
    ['a bad shape digest', pendingRow({ ...API_COLUMNS, api_shape_digest: 'sha256:x' })],
    ['an unknown method', pendingRow({ ...API_COLUMNS, api_method: 'GET' })],
    ['an empty origin', pendingRow({ ...API_COLUMNS, api_origin: '' })],
    ['a too long origin', pendingRow({ ...API_COLUMNS, api_origin: `http://${'a'.repeat(MAX_URL_LENGTH - 6)}` })],
    ['a path shape without "/"', pendingRow({ ...API_COLUMNS, api_path_shape: 'rest/v1/members' })],
    ['a too long path shape', pendingRow({ ...API_COLUMNS, api_path_shape: `/${'p'.repeat(MAX_API_SHAPE_PATH_LENGTH)}` })],
    ['a VERIFIED API row without a matched READ', verifiedRow({ ...API_COLUMNS, read_verification: 'UNDETERMINED' })],
    ['a NOT_SENT API row with a response', blockedRow({ ...API_COLUMNS, http_status: 200 })],
  ])('rejects %s', (_label, row) => {
    const connection = latestConnection();
    expect(() => insertRow(connection, 'write_results', row)).toThrow();
    expect(countOf(connection, 'write_results')).toBe(0);
  });
});
