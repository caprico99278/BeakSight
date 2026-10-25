// 管理データの自動ログインの表（`auto_login_attempts`、`auto_login_holds`、`credential_events`）の結合テスト（T26c。Task 26 の設計書 4.5）。LG-2 で、
// `control-store-v4.test.ts` の今の形の確かめを、今の版の管理データの上に移した（前の版からの上げと前の版の文の固定は捨てた。CHECK の値の一覧が
// 名前つきの一覧と等しいことは `control-store-base-schema.test.ts`）。
// - STRICT、閉じた一覧と日時の形の CHECK、止めている行は 1 つのプロファイルで 1 つまで。値・値のハッシュ・ユーザー名の列を持たない。
// 一時のフォルダだけを使い、終わったら消す。
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_FAILURE_RESULTS, AUTOMATED_LOGIN_RESULTS, AUTOMATED_LOGIN_SUBMISSIONS } from '../../src/control/auth/automated-login-results.js';
import { CREDENTIAL_EVENT_KINDS } from '../../src/control/job/job-records.js';
import {
  checkListOf,
  columnNamesOf,
  countOf,
  insertRow,
  tableSqlOf,
  useControlStoreWorkspace,
  type SqlValue,
} from '../helpers/control-store-schema.js';

const PROFILE_ID = 'example-v4';
const OTHER_PROFILE_ID = 'example-v4-other';
const CREATED_AT = '20261010000000';
const FINISHED_AT = '20261010000100';

const workspace = useControlStoreWorkspace('beaksight-control-auto-login-');

/** 今の版の管理データ（プロファイルを 2 つ入れた）の生の接続。 */
const latestConnection = (): DatabaseSync => workspace.latestConnection([PROFILE_ID, OTHER_PROFILE_ID]);

const attemptRow = (row: Record<string, SqlValue> = {}): Record<string, SqlValue> =>
  ({ profile_id: PROFILE_ID, job_id: 'job-1', started_at: CREATED_AT, credential_revision: 1, ...row });

describe('Control store: the auto login tables', () => {
  it('are STRICT and have no column for values, hashes or user names', () => {
    const connection = latestConnection();
    for (const table of ['auto_login_attempts', 'auto_login_holds', 'credential_events']) {
      expect(tableSqlOf(connection, table), table).toMatch(/\)\s*STRICT\s*$/u);
      expect(columnNamesOf(connection, table).filter((name) => /user|pass|hash|secret|value|cipher/iu.test(name)), table).toEqual([]);
    }
    expect(checkListOf(tableSqlOf(connection, 'auto_login_attempts'), 'result')).toEqual([...AUTOMATED_LOGIN_RESULTS]);
    expect(checkListOf(tableSqlOf(connection, 'auto_login_attempts'), 'submitted')).toEqual([...AUTOMATED_LOGIN_SUBMISSIONS]);
    expect(checkListOf(tableSqlOf(connection, 'auto_login_holds'), 'reason')).toEqual([...AUTOMATED_LOGIN_FAILURE_RESULTS]);
    expect(checkListOf(tableSqlOf(connection, 'credential_events'), 'kind')).toEqual([...CREDENTIAL_EVENT_KINDS]);
  });

  it('accepts attempts in the right shape and rejects the rows that break the CHECKs', () => {
    const connection = latestConnection();
    insertRow(connection, 'auto_login_attempts', attemptRow({ job_id: 'job-pending' }));
    insertRow(connection, 'auto_login_attempts', attemptRow({
      job_id: 'job-limited', result: 'RATE_LIMITED', submitted: 'YES', retry_after_until: FINISHED_AT, result_recorded_at: FINISHED_AT,
    }));
    insertRow(connection, 'auto_login_attempts', attemptRow({ job_id: 'job-ok', result: 'SUCCEEDED', submitted: 'YES', result_recorded_at: FINISHED_AT }));
    insertRow(connection, 'auto_login_attempts', attemptRow({ job_id: 'job-form', result: 'LOGIN_FORM_INVALID', submitted: 'NO', result_recorded_at: FINISHED_AT }));
    for (const [name, row] of [
      ['the same job twice', attemptRow({ job_id: 'job-pending' })],
      ['an unknown result', attemptRow({ job_id: 'j-1', result: 'LOCKED', submitted: 'YES', result_recorded_at: FINISHED_AT })],
      ['an unknown submission', attemptRow({ job_id: 'j-2', result: 'ACCOUNT_LOCKED', submitted: 'MAYBE', result_recorded_at: FINISHED_AT })],
      ['a result without the submission', attemptRow({ job_id: 'j-3', result: 'ACCOUNT_LOCKED', result_recorded_at: FINISHED_AT })],
      ['a submission without the result', attemptRow({ job_id: 'j-4', submitted: 'YES' })],
      ['a result without the recorded time', attemptRow({ job_id: 'j-5', result: 'ACCOUNT_LOCKED', submitted: 'YES' })],
      ['a recorded time without the result', attemptRow({ job_id: 'j-6', result_recorded_at: FINISHED_AT })],
      ['Retry-After for another result', attemptRow({
        job_id: 'j-7', result: 'ACCOUNT_LOCKED', submitted: 'YES', retry_after_until: FINISHED_AT, result_recorded_at: FINISHED_AT,
      })],
      ['a success that was not sent', attemptRow({ job_id: 'j-8', result: 'SUCCEEDED', submitted: 'NO', result_recorded_at: FINISHED_AT })],
      ['a start time that is not 14 digits', attemptRow({ job_id: 'j-9', started_at: '2026-10-10' })],
      ['a Retry-After deadline that is not 14 digits', attemptRow({
        job_id: 'j-10', result: 'RATE_LIMITED', submitted: 'YES', retry_after_until: 'tomorrow', result_recorded_at: FINISHED_AT,
      })],
      ['a credential revision of 0', attemptRow({ job_id: 'j-11', credential_revision: 0 })],
      ['a text revision (STRICT)', attemptRow({ job_id: 'j-12', credential_revision: 'one' })],
      ['an upper case job id', attemptRow({ job_id: 'Job-1' })],
      ['an unknown profile', attemptRow({ job_id: 'j-13', profile_id: 'missing-profile' })],
    ] as const) {
      expect(() => insertRow(connection, 'auto_login_attempts', row), name).toThrow();
    }
    expect(countOf(connection, 'auto_login_attempts')).toBe(4);
  });

  it('keeps at most one hold that is not cleared for each profile', () => {
    const connection = latestConnection();
    const hold = (row: Record<string, SqlValue>): Record<string, SqlValue> =>
      ({ profile_id: PROFILE_ID, reason: 'ACCOUNT_LOCKED', held_at: CREATED_AT, attempt_id: 1, ...row });
    insertRow(connection, 'auto_login_holds', hold({}));
    expect(() => insertRow(connection, 'auto_login_holds', hold({ attempt_id: 2 }))).toThrow(/UNIQUE/u);
    insertRow(connection, 'auto_login_holds', hold({ profile_id: OTHER_PROFILE_ID }));
    connection.prepare('UPDATE auto_login_holds SET cleared_at = ? WHERE profile_id = ?').run(FINISHED_AT, PROFILE_ID);
    insertRow(connection, 'auto_login_holds', hold({ attempt_id: 3, reason: 'AUTH_RESULT_UNKNOWN' }));
    for (const [name, row] of [
      ['SUCCEEDED as a reason', hold({ profile_id: OTHER_PROFILE_ID, reason: 'SUCCEEDED', cleared_at: FINISHED_AT })],
      ['an unknown reason', hold({ reason: 'LOCKED', cleared_at: FINISHED_AT })],
      ['a time that is not 14 digits', hold({ held_at: 'now', cleared_at: FINISHED_AT })],
      ['a cleared time that is not 14 digits', hold({ cleared_at: '2026' })],
      ['an unknown profile', hold({ profile_id: 'missing-profile', cleared_at: FINISHED_AT })],
    ] as const) {
      expect(() => insertRow(connection, 'auto_login_holds', row), name).toThrow();
    }
    expect(countOf(connection, 'auto_login_holds')).toBe(3);
  });

  it('accepts credential events of the closed list and rejects the others', () => {
    const connection = latestConnection();
    for (const kind of CREDENTIAL_EVENT_KINDS) {
      insertRow(connection, 'credential_events', { profile_id: PROFILE_ID, recorded_at: CREATED_AT, kind, credential_revision: kind === 'HOLD_CLEARED' ? null : 1 });
    }
    for (const [name, row] of [
      ['an unknown kind', { profile_id: PROFILE_ID, recorded_at: CREATED_AT, kind: 'RENAMED', credential_revision: 1 }],
      ['a revision of 0', { profile_id: PROFILE_ID, recorded_at: CREATED_AT, kind: 'CREATED', credential_revision: 0 }],
      ['a time that is not 14 digits', { profile_id: PROFILE_ID, recorded_at: '20261010', kind: 'CREATED', credential_revision: 1 }],
      ['an unknown profile', { profile_id: 'missing-profile', recorded_at: CREATED_AT, kind: 'CREATED', credential_revision: 1 }],
    ] as const) {
      expect(() => insertRow(connection, 'credential_events', row), name).toThrow();
    }
    expect(countOf(connection, 'credential_events')).toBe(CREDENTIAL_EVENT_KINDS.length);
  });
});
