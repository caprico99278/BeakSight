// T26c（Task 26 の設計書 4.5、変更履歴の「Blocker: T26b」の行の (2)）: ジョブの記録の閉じた一覧に足した値と、その表示の文言。
// - ジョブの種類（`AUDIT_JOB_KINDS`）、失敗の理由に自動ログインの成功以外の結果、開始を拒む理由に資格情報と上限の 5 つ、
//   資格情報の変更・削除を拒む理由（`CREDENTIAL_IN_USE`）、資格情報の変更の記録の種類（`CREDENTIAL_EVENT_KINDS`）。
// - 失敗の理由の一覧に重複がない（ワーカーの理由と同じ値を後で足しても、重複しない組み立て方）。
// - 足した失敗の理由と開始を拒む理由のすべてに、表示の説明と手順がある（画面の書き漏れの検査は `catalog-coverage.ts` の型でも行う）。
import { describe, expect, it } from 'vitest';
import { AUTOMATED_LOGIN_FAILURE_RESULTS } from '../../src/control/auth/automated-login-results.js';
import { CREDENTIAL_CHANGE_KINDS } from '../../src/control/credentials/credential-store.js';
import {
  AUDIT_JOB_FAILURE_REASONS,
  AUDIT_JOB_KINDS,
  AUDIT_JOB_START_REJECTION_REASONS,
  CREDENTIAL_CHANGE_REJECTION_REASONS,
  CREDENTIAL_EVENT_KINDS,
} from '../../src/control/job/job-records.js';
import { WORKER_FAILURE_REASONS } from '../../src/control/worker-protocol.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  AUDIT_JOB_START_REJECTION_DESCRIPTIONS,
} from '../../src/presentation/messages.js';

const AUTO_LOGIN_START_REJECTIONS = [
  'CREDENTIAL_MISSING', 'CREDENTIAL_STALE', 'CREDENTIAL_PROTECTION_UNAVAILABLE', 'AUTO_LOGIN_HELD', 'AUTO_LOGIN_RATE_LIMITED',
] as const;

describe('job records for the automated login (T26c)', () => {
  // T27c: `DISCOVERY` と `READ_CHECK` を後ろに足した（Task 27 の設計書 4.6）。
  it('has the job kinds AUDIT and LOGIN_CHECK, then DISCOVERY and READ_CHECK (T27c)', () => {
    // T30d: 書き込みのジョブ（`WRITE_CREATE`。始める口と IPC の中身は T30e）。T31e: 更新の書き込みのジョブ（`WRITE_UPDATE`。始める口は T31f）。
    // T43c: 入口の確かめのジョブ（`ENTRY_CHECK`）を後ろに足した。
    expect(AUDIT_JOB_KINDS).toEqual(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK']);
    expect(Object.isFrozen(AUDIT_JOB_KINDS)).toBe(true);
  });

  // LG-2: 管理データの版 3 の並びを守る確かめは捨てた（一覧の並びと値が管理データの CHECK と等しいことは
  // `tests/integration/control-store-base-schema.test.ts` が確かめる）。
  it('adds every result but SUCCEEDED to the failure reasons, without duplicates', () => {
    expect(AUDIT_JOB_FAILURE_REASONS).toEqual(expect.arrayContaining([...AUTOMATED_LOGIN_FAILURE_RESULTS]));
    expect(AUDIT_JOB_FAILURE_REASONS).toEqual(expect.arrayContaining([
      'JOB_KIND_NOT_SUPPORTED', 'DISCOVERY_RESULT_INVALID', 'READ_CHECK_RESULT_INVALID', 'WRITE_GRANT_REJECTED', 'WRITE_RESULT_INVALID',
      'ENTRY_CHECK_RESULT_INVALID',
    ]));
    expect(AUDIT_JOB_FAILURE_REASONS).not.toContain('SUCCEEDED');
    expect(new Set(AUDIT_JOB_FAILURE_REASONS).size).toBe(AUDIT_JOB_FAILURE_REASONS.length);
    expect(AUDIT_JOB_FAILURE_REASONS).toEqual(expect.arrayContaining([...WORKER_FAILURE_REASONS]));
    expect(Object.isFrozen(AUDIT_JOB_FAILURE_REASONS)).toBe(true);
  });

  it('adds the credential and limit reasons to the start rejections, and places CREDENTIAL_IN_USE for credential changes', () => {
    expect(AUDIT_JOB_START_REJECTION_REASONS).toEqual(expect.arrayContaining([...AUTO_LOGIN_START_REJECTIONS]));
    expect(new Set(AUDIT_JOB_START_REJECTION_REASONS).size).toBe(AUDIT_JOB_START_REJECTION_REASONS.length);
    expect(CREDENTIAL_CHANGE_REJECTION_REASONS).toEqual(['CREDENTIAL_IN_USE']);
  });

  it('records the credential changes of T26a, the deletion and the clearing of the hold', () => {
    expect(CREDENTIAL_EVENT_KINDS).toEqual([...CREDENTIAL_CHANGE_KINDS, 'DELETED', 'HOLD_CLEARED']);
    expect(CREDENTIAL_EVENT_KINDS).toEqual(['CREATED', 'USERNAME_CHANGED', 'PASSWORD_CHANGED', 'BOTH_CHANGED', 'DELETED', 'HOLD_CLEARED']);
  });

  it('has a description and an action for every failure reason and start rejection (no omissions, nothing extra)', () => {
    expect(Object.keys(AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS).sort()).toEqual([...AUDIT_JOB_FAILURE_REASONS].sort());
    expect(Object.keys(AUDIT_JOB_START_REJECTION_DESCRIPTIONS).sort()).toEqual([...AUDIT_JOB_START_REJECTION_REASONS].sort());
    for (const reason of [...AUTOMATED_LOGIN_FAILURE_RESULTS]) {
      const text = AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS[reason as keyof typeof AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS];
      expect(text.description.length, reason).toBeGreaterThan(0);
      expect(text.action.length, reason).toBeGreaterThan(0);
    }
    for (const reason of AUTO_LOGIN_START_REJECTIONS) {
      const text = AUDIT_JOB_START_REJECTION_DESCRIPTIONS[reason as keyof typeof AUDIT_JOB_START_REJECTION_DESCRIPTIONS];
      expect(text.description.length, reason).toBeGreaterThan(0);
      expect(text.action.length, reason).toBeGreaterThan(0);
    }
  });
});
