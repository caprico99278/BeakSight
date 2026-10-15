// T30d（Task 30 の設計書 3 章の「予約の締め」「`UNKNOWN` の後」「記録」）: 書き込みの結果の記録（管理データの版 8 の `write_results`）と予約の締め、
// 起動のときの回復、生成の履歴の読み出しの結合テスト。
// - 記録は 2 段: 送る前に、生成した値と seed の記録を書く（`recordWriteAttempt`。許可が消費済みで予約が `RESERVED` のときだけ）。送った後（または
//   止めた後）に、結果を締める（`settleWriteResult`）。締めは、`reservationSettlementOf` と `actionOutcomeOf` で決めた状態で、予約の締めと同じ
//   トランザクションで書く（呼び出し側の言う結果を信じない）。
// - 回復（`closeOrphanedWriteResults`）: 終わっていないジョブのものでない、消費済みで予約が `RESERVED` のままの許可を、`UNKNOWN` で締め、書き込みの
//   結果を `UNKNOWN` で記録する（記録がなければ値なしで足す）。二重に締めない。動いているジョブのものは残す。
// - 生成の履歴（CCX-28 から `readScenarioWriteGenerationHistory`。一意にする欄の組がなければ、シナリオの記録の鍵だけ）: シナリオの使った一意の組と、
//   プロファイルの使った電話番号（`UNKNOWN`・`BLOCKED` を含む）。
// - T31e（管理データの版 9）: UPDATE の書き込みの結果。書き込みの種類と対象の ID は許可から書き（ワーカーの報告を鵜呑みにしない）、UPDATE の証拠は
//   締めで 1 回だけ書く（UPDATE の `VERIFIED` は、すべての欄が一致した証拠と、対象と同じ ID が要る）。回復と、送らずに止めたときの締めも UPDATE で
//   同じに働く。生成の履歴は、同じ台帳の CREATE と UPDATE の使った値から、そのシナリオの一意にする欄の組で鍵を求め直す。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWriteResult, readWriteResults } from '../../src/control/actions/write-result-facts.js';
import type { WriteUpdateEvidence } from '../../src/control/actions/action-contracts.js';
import { uniqueKeyOf } from '../../src/control/data-rules/scenario-data.js';
import {
  WRITE_RESULT_REJECTION_REASONS,
  closeOrphanedWriteResults,
  closeWriteWithoutSending,
  consumeExecutionGrant,
  issueExecutionGrant,
  readExecutionGrant,
  readPlannedUpdateTarget,
  readScenario,
  readScenarioWriteGenerationHistory,
  recordWriteAttempt,
  settleWriteReservation,
  settleWriteResult,
  type WriteAttempt,
  type WriteOutcomeReport,
} from '../../src/control/approval/scenario-store.js';
import type { DataSeed } from '../../src/control/data-rules/deterministic-stream.js';
import type { SeedRecord } from '../../src/control/data-rules/scenario-data.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import {
  EXTERNAL,
  GRANT_PROFILE_ID,
  prepareGrantProfile,
  prepareScenario,
  prepareUpdateScenario,
  registerVerifiedForTest,
  writeSlotAt,
} from './execution-grant-fixtures.js';

const MINUTE_MS = 60_000;

let workDirectory = '';
let database: ControlDatabase;
let latest: ReturnType<typeof prepareGrantProfile>;

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-write-result-'));
  database = openControlDatabase(databasePath());
  latest = prepareGrantProfile(database);
  prepareScenario(database, latest, 'scenario-1');
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const seedRecordOf = (grantId: string): SeedRecord => ({
  seed: 'a'.repeat(64) as DataSeed,
  seedInput: { profileId: GRANT_PROFILE_ID, scenarioId: 'scenario-1', scenarioRevision: 2, ruleSetDigest: `sha256:${'b'.repeat(64)}`, executionGrantId: grantId },
  baseDate: '2026-10-12',
  attempt: 0,
});

/** `slot` 回目の許可を発行して消費する（ジョブの id は `job-w<slot>`）。 */
const consumedGrant = (slot: number, scenarioId = 'scenario-1'): { readonly grantId: string; readonly jobId: string } => {
  const revision = readScenario(database, scenarioId)?.revision ?? 0;
  const grantId = `grant-${slot}`;
  const jobId = `job-w${slot}`;
  const issued = issueExecutionGrant(database, {
    scenarioId, expectedRevision: revision, grantId, jobId, count: 1, external: EXTERNAL, at: writeSlotAt(slot),
  });
  if (!issued.ok) {
    throw new Error(`not issued: ${issued.reason}`);
  }
  const consumed = consumeExecutionGrant(database, {
    grantId, scenarioId, scenarioRevision: revision, jobId, profileId: GRANT_PROFILE_ID, external: EXTERNAL, at: writeSlotAt(slot, MINUTE_MS),
  });
  if (!consumed.ok) {
    throw new Error(`not consumed: ${consumed.reason}`);
  }
  return { grantId, jobId };
};

const attemptOf = (slot: number, overrides: Partial<WriteAttempt> = {}): WriteAttempt => ({
  jobId: `job-w${slot}`,
  grantId: `grant-${slot}`,
  seedRecord: seedRecordOf(`grant-${slot}`),
  submittedValues: { name: `サンプル ${slot}` },
  uniqueKey: JSON.stringify({ name: `サンプル ${slot}` }),
  phoneNumbers: [`090-0000-000${slot}`],
  at: writeSlotAt(slot, MINUTE_MS),
  ...overrides,
});

const sentReport = (slot: number, overrides: Partial<WriteOutcomeReport> = {}): WriteOutcomeReport => ({
  jobId: `job-w${slot}`,
  submission: 'SENT',
  blockReason: null,
  httpStatus: 200,
  responseJudgement: 'SUCCESS',
  recordId: '42',
  readVerification: 'MATCHED',
  submittedAt: writeSlotAt(slot, 2 * MINUTE_MS),
  at: writeSlotAt(slot, 3 * MINUTE_MS),
  ...overrides,
});

const notSentReport = (slot: number): WriteOutcomeReport => ({
  jobId: `job-w${slot}`, submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', httpStatus: null, responseJudgement: null, recordId: null,
  readVerification: null, submittedAt: null, at: writeSlotAt(slot, 3 * MINUTE_MS),
});

const reasonOf = (result: { readonly ok: boolean; readonly reason?: string }): string | null => (result.ok ? null : result.reason ?? null);

describe('write results (T30d): the attempt and the settlement', () => {
  it('has the closed list of the rejection reasons', () => {
    expect(WRITE_RESULT_REJECTION_REASONS).toEqual([
      'WRITE_GRANT_NOT_FOUND',
      'WRITE_GRANT_MISMATCH',
      'WRITE_GRANT_NOT_CONSUMED',
      'WRITE_RESERVATION_SETTLED',
      'WRITE_ATTEMPT_ALREADY_RECORDED',
      'WRITE_VALUES_NOT_IN_SCENARIO',
      'WRITE_ATTEMPT_NOT_FOUND',
      'WRITE_RESULT_ALREADY_SETTLED',
    ]);
    expect(Object.isFrozen(WRITE_RESULT_REJECTION_REASONS)).toBe(true);
  });

  it('records the attempt, then settles the result and the reservation together (VERIFIED, COMMITTED)', () => {
    consumedGrant(0);
    const recorded = recordWriteAttempt(database, attemptOf(0));
    expect(recorded.ok && recorded.result).toMatchObject({
      jobId: 'job-w0', grantId: 'grant-0', profileId: GRANT_PROFILE_ID, scenarioId: 'scenario-1', scenarioRevision: 2,
      submittedValues: { name: 'サンプル 0' }, phoneNumbers: ['090-0000-0000'], submission: null, result: null, settledAt: null,
    });
    expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe('RESERVED');
    const settled = settleWriteResult(database, sentReport(0));
    expect(settled.ok && settled.result).toMatchObject({
      submission: 'SENT', httpStatus: 200, responseJudgement: 'SUCCESS', recordId: '42', readVerification: 'MATCHED',
      result: 'VERIFIED', reason: 'READ_VERIFICATION_MATCHED', reservationState: 'COMMITTED', settledAt: writeSlotAt(0, 3 * MINUTE_MS),
    });
    expect(readExecutionGrant(database, 'grant-0')?.reservation).toMatchObject({ state: 'COMMITTED', settledAt: writeSlotAt(0, 3 * MINUTE_MS) });
    expect(reasonOf(settleWriteResult(database, sentReport(0)))).toBe('WRITE_RESULT_ALREADY_SETTLED');
  });

  it.each<readonly [string, Partial<WriteOutcomeReport>, string, string, string]>([
    ['a sent write without a response', { httpStatus: null, responseJudgement: null, recordId: null, readVerification: null }, 'UNKNOWN', 'NO_RESPONSE',
      'UNKNOWN'],
    ['a 5xx', { httpStatus: 503, responseJudgement: 'SERVER_ERROR', recordId: null, readVerification: null }, 'UNKNOWN', 'SERVER_ERROR', 'COMMITTED'],
    ['an input error', { httpStatus: 200, responseJudgement: 'INPUT_ERROR', recordId: null, readVerification: null }, 'FAILED', 'INPUT_ERROR',
      'COMMITTED'],
    ['a success without a record id', { recordId: null }, 'PARTIAL', 'RECORD_ID_NOT_FOUND', 'COMMITTED'],
    ['a success with a READ that does not match', { readVerification: 'NOT_MATCHED' }, 'UNKNOWN', 'READ_VERIFICATION_NOT_MATCHED', 'COMMITTED'],
    ['a submission that is not known', { submission: 'UNKNOWN', httpStatus: null, responseJudgement: null, recordId: null, readVerification: null,
      submittedAt: null }, 'UNKNOWN', 'NO_RESPONSE', 'UNKNOWN'],
  ])('decides the result and the reservation with the pure rules: %s', (_label, change, result, reason, reservation) => {
    consumedGrant(0);
    expect(recordWriteAttempt(database, attemptOf(0)).ok).toBe(true);
    const settled = settleWriteResult(database, sentReport(0, change));
    expect(settled.ok && [settled.result.result, settled.result.reason, settled.result.reservationState]).toEqual([result, reason, reservation]);
    expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe(reservation);
  });

  it('settles a blocked write as BLOCKED and releases the reservation', () => {
    consumedGrant(0);
    expect(recordWriteAttempt(database, attemptOf(0)).ok).toBe(true);
    const settled = settleWriteResult(database, notSentReport(0));
    expect(settled.ok && settled.result).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH', result: 'BLOCKED',
      reservationState: 'RELEASED', submittedAt: null });
    expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe('RELEASED');
  });

  it('stores no unusable record id (an id with a line break is not found)', () => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    const settled = settleWriteResult(database, sentReport(0, { recordId: '4\n2' }));
    expect(settled.ok && [settled.result.recordId, settled.result.result]).toEqual([null, 'PARTIAL']);
  });

  it('rejects an attempt for an unknown, unconsumed, settled or other grant, a second attempt and values that the scenario does not send', () => {
    expect(reasonOf(recordWriteAttempt(database, attemptOf(0)))).toBe('WRITE_GRANT_NOT_FOUND');
    const revision = readScenario(database, 'scenario-1')?.revision ?? 0;
    expect(issueExecutionGrant(database, {
      scenarioId: 'scenario-1', expectedRevision: revision, grantId: 'grant-0', jobId: 'job-w0', count: 1, external: EXTERNAL, at: writeSlotAt(0),
    }).ok).toBe(true);
    expect(reasonOf(recordWriteAttempt(database, attemptOf(0)))).toBe('WRITE_GRANT_NOT_CONSUMED');
    expect(consumeExecutionGrant(database, {
      grantId: 'grant-0', scenarioId: 'scenario-1', scenarioRevision: revision, jobId: 'job-w0', profileId: GRANT_PROFILE_ID, external: EXTERNAL,
      at: writeSlotAt(0, MINUTE_MS),
    }).ok).toBe(true);
    expect(reasonOf(recordWriteAttempt(database, attemptOf(0, { jobId: 'job-other' })))).toBe('WRITE_GRANT_MISMATCH');
    expect(reasonOf(recordWriteAttempt(database, attemptOf(0, { submittedValues: { email: 'x@example.invalid' } })))).toBe('WRITE_VALUES_NOT_IN_SCENARIO');
    expect(recordWriteAttempt(database, attemptOf(0)).ok).toBe(true);
    expect(reasonOf(recordWriteAttempt(database, attemptOf(0)))).toBe('WRITE_ATTEMPT_ALREADY_RECORDED');
    expect(settleWriteResult(database, notSentReport(0)).ok).toBe(true);
    expect(readWriteResults(database, 'scenario-1')).toHaveLength(1);
  });

  it('rejects a settlement without an attempt, and writes nothing', () => {
    consumedGrant(0);
    expect(reasonOf(settleWriteResult(database, sentReport(0)))).toBe('WRITE_ATTEMPT_NOT_FOUND');
    expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe('RESERVED');
  });

  it.each<readonly [string, Partial<WriteOutcomeReport>]>([
    ['NOT_SENT without a block reason', { submission: 'NOT_SENT', blockReason: null, httpStatus: null, responseJudgement: null, recordId: null,
      readVerification: null, submittedAt: null }],
    ['NOT_SENT with a response', { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' }],
    ['SENT with a block reason', { blockReason: 'PAYLOAD_MISMATCH' }],
    ['SENT with a judgement and no response', { httpStatus: null }],
    ['a bad HTTP status', { httpStatus: 99 }],
    ['a bad time', { at: '2026-10-12' }],
  ])('rejects a contradicting report as a caller error (%s)', (_label, change) => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    expect(() => settleWriteResult(database, sentReport(0, change))).toThrow(RangeError);
    expect(readWriteResult(database, 'job-w0')?.settledAt).toBeNull();
  });
});

describe('write results (T30d): the recovery', () => {
  it('settles an orphaned consumed grant as UNKNOWN, with and without an attempt, once', () => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    const recoveredAt = writeSlotAt(0, 4 * MINUTE_MS);
    expect(closeOrphanedWriteResults(database, recoveredAt)).toBe(1);
    expect(readWriteResult(database, 'job-w0')).toMatchObject({
      submission: 'UNKNOWN', result: 'UNKNOWN', reason: 'NO_RESPONSE', reservationState: 'UNKNOWN', settledAt: recoveredAt,
      submittedValues: { name: 'サンプル 0' },
    });
    expect(readExecutionGrant(database, 'grant-0')?.reservation).toMatchObject({ state: 'UNKNOWN', settledAt: recoveredAt });
    expect(closeOrphanedWriteResults(database, writeSlotAt(0, 5 * MINUTE_MS))).toBe(0);

    consumedGrant(1);
    expect(closeOrphanedWriteResults(database, writeSlotAt(1, 4 * MINUTE_MS))).toBe(1);
    expect(readWriteResult(database, 'job-w1')).toMatchObject({
      grantId: 'grant-1', seedRecord: null, submittedValues: {}, uniqueKey: null, phoneNumbers: [], submission: 'UNKNOWN', result: 'UNKNOWN',
      reservationState: 'UNKNOWN',
    });
  });

  it('keeps the write of a job that is still running, and closes it after the job ended', () => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    const raw = new DatabaseSync(databasePath());
    try {
      raw.prepare(`INSERT INTO jobs (job_id, profile_id, profile_revision, state, start_new, created_at, job_kind)
        VALUES (?, ?, 1, 'RUNNING', 1, ?, 'WRITE_CREATE')`).run('job-w0', GRANT_PROFILE_ID, writeSlotAt(0, MINUTE_MS));
      expect(closeOrphanedWriteResults(database, writeSlotAt(0, 4 * MINUTE_MS))).toBe(0);
      expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe('RESERVED');
      raw.prepare("UPDATE jobs SET state = 'INTERRUPTED', finished_at = ?, failure_reason = 'SERVER_RESTARTED' WHERE job_id = ?")
        .run(writeSlotAt(0, 4 * MINUTE_MS), 'job-w0');
    } finally {
      raw.close();
    }
    expect(closeOrphanedWriteResults(database, writeSlotAt(0, 5 * MINUTE_MS))).toBe(1);
    expect(readWriteResult(database, 'job-w0')?.result).toBe('UNKNOWN');
  });

  it('does not touch a settled write or an unconsumed grant', () => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    settleWriteResult(database, sentReport(0));
    const revision = readScenario(database, 'scenario-1')?.revision ?? 0;
    expect(issueExecutionGrant(database, {
      scenarioId: 'scenario-1', expectedRevision: revision, grantId: 'grant-1', jobId: 'job-w1', count: 1, external: EXTERNAL, at: writeSlotAt(1),
    }).ok).toBe(true);
    expect(closeOrphanedWriteResults(database, writeSlotAt(1, MINUTE_MS))).toBe(0);
    expect(readWriteResult(database, 'job-w0')?.result).toBe('VERIFIED');
    expect(readExecutionGrant(database, 'grant-1')?.reservation.state).toBe('RESERVED');
  });
});

// T30e（T30d の発見事項 2 の判断）: 結果の記録を伴わない予約の締め（`settleWriteReservation`）は `RELEASED` だけ。送らずに止めたときの締めの口
// （`closeWriteWithoutSending`）: 消費済みの許可は `NOT_SENT`（`PRECHECK_FAILED`）・`BLOCKED`・`RELEASED` で締め（送る前の記録がなければ値なしの行を
// 足す）、消費していない、そのジョブの許可は無効にして予約を返す。ほかのジョブの許可と、締めた許可は変えない。
describe('write results (T30e): closing without sending and the reservation settlement', () => {
  it('settles a consumed grant as NOT_SENT, BLOCKED and RELEASED, with or without the attempt', () => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    expect(closeWriteWithoutSending(database, { grantId: 'grant-0', jobId: 'job-w0', at: writeSlotAt(0, 2 * MINUTE_MS) }))
      .toMatchObject({ kind: 'SETTLED_NOT_SENT', result: { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', result: 'BLOCKED',
        reservationState: 'RELEASED', submittedValues: { name: 'サンプル 0' } } });
    expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe('RELEASED');
    expect(closeWriteWithoutSending(database, { grantId: 'grant-0', jobId: 'job-w0', at: writeSlotAt(0, 3 * MINUTE_MS) }))
      .toEqual({ kind: 'UNCHANGED' });
    consumedGrant(1);
    expect(closeWriteWithoutSending(database, { grantId: 'grant-1', jobId: 'job-w1', at: writeSlotAt(1, 2 * MINUTE_MS) }))
      .toMatchObject({ kind: 'SETTLED_NOT_SENT', result: { seedRecord: null, submittedValues: {}, result: 'BLOCKED' } });
  });

  it('invalidates an unconsumed grant of the job and releases its reservation, and does not touch a grant of another job', () => {
    const revision = readScenario(database, 'scenario-1')?.revision ?? 0;
    expect(issueExecutionGrant(database, {
      scenarioId: 'scenario-1', expectedRevision: revision, grantId: 'grant-0', jobId: 'job-w0', count: 1, external: EXTERNAL, at: writeSlotAt(0),
    }).ok).toBe(true);
    expect(closeWriteWithoutSending(database, { grantId: 'grant-0', jobId: 'job-other', at: writeSlotAt(0, MINUTE_MS) })).toEqual({ kind: 'UNCHANGED' });
    expect(readExecutionGrant(database, 'grant-0')).toMatchObject({ invalidatedAt: null, reservation: { state: 'RESERVED' } });
    expect(closeWriteWithoutSending(database, { grantId: 'grant-0', jobId: 'job-w0', at: writeSlotAt(0, MINUTE_MS) })).toEqual({ kind: 'GRANT_RELEASED' });
    expect(readExecutionGrant(database, 'grant-0')).toMatchObject({ invalidatedAt: writeSlotAt(0, MINUTE_MS), reservation: { state: 'RELEASED' } });
    expect(closeWriteWithoutSending(database, { grantId: 'grant-missing', jobId: 'job-w0', at: writeSlotAt(0, MINUTE_MS) })).toEqual({ kind: 'UNCHANGED' });
  });

  it('settles a reservation without a write result only as RELEASED', () => {
    consumedGrant(0);
    const reservationId = readExecutionGrant(database, 'grant-0')?.reservation.reservationId ?? 0;
    expect(() => settleWriteReservation(database, { reservationId, to: 'COMMITTED', at: writeSlotAt(0, 2 * MINUTE_MS) })).toThrow(RangeError);
    expect(() => settleWriteReservation(database, { reservationId, to: 'UNKNOWN', at: writeSlotAt(0, 2 * MINUTE_MS) })).toThrow(RangeError);
    expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe('RESERVED');
    expect(settleWriteReservation(database, { reservationId, to: 'RELEASED', at: writeSlotAt(0, 2 * MINUTE_MS) }).ok).toBe(true);
  });
});

describe('write results (T30d): the generation history and reopening', () => {
  it('reads the used unique keys of the scenario and the used phone numbers of the profile, including UNKNOWN and BLOCKED writes', () => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    settleWriteResult(database, sentReport(0));
    consumedGrant(1);
    recordWriteAttempt(database, attemptOf(1));
    settleWriteResult(database, sentReport(1, { submission: 'UNKNOWN', httpStatus: null, responseJudgement: null, recordId: null,
      readVerification: null, submittedAt: null }));
    consumedGrant(2);
    recordWriteAttempt(database, attemptOf(2, { uniqueKey: null, phoneNumbers: ['0900000002', '090-0000-0003'] }));
    settleWriteResult(database, notSentReport(2));
    // CCX-28: 一意にする欄の組を渡さなければ、シナリオの記録の鍵（記録したときの鍵）だけ。
    expect(readScenarioWriteGenerationHistory(database, 'scenario-1', [])).toEqual({
      usedUniqueKeys: [JSON.stringify({ name: 'サンプル 0' }), JSON.stringify({ name: 'サンプル 1' })],
      usedPhoneNumbers: ['090-0000-0000', '090-0000-0001', '0900000002', '090-0000-0003'],
    });
    expect(readScenarioWriteGenerationHistory(database, 'scenario-missing', [])).toEqual({ usedUniqueKeys: [], usedPhoneNumbers: [] });
  });

  it('keeps the results and the reservations after reopening the database', () => {
    consumedGrant(0);
    recordWriteAttempt(database, attemptOf(0));
    settleWriteResult(database, sentReport(0));
    const before = readWriteResults(database, 'scenario-1');
    closeControlDatabase(database);
    database = openControlDatabase(databasePath());
    expect(readWriteResults(database, 'scenario-1')).toEqual(before);
    expect(readExecutionGrant(database, 'grant-0')?.reservation.state).toBe('COMMITTED');
    expect(before[0]?.seedRecord).toEqual(seedRecordOf('grant-0'));
  });
});

// T31e（Task 31 の設計書 3 章の「証拠と記録」「記録」、4 章の「台帳の読み出し」。管理データの版 9）: UPDATE の書き込みの結果。
describe('write results (T31e): the UPDATE writes', () => {
  const UPDATE_ID = 'scenario-update';
  const TARGET = 'rec-1';

  /** CREATE のシナリオ（`scenario-1`）の照合まで済んだ登録（`slot` 回目）と、それを参照する UPDATE のシナリオを作る。 */
  const prepareUpdate = (slot = 0, recordId = TARGET): void => {
    prepareUpdateScenario(database, latest, UPDATE_ID, 'scenario-1');
    expect(registerVerifiedForTest(database, {
      createScenarioId: 'scenario-1', grantId: `grant-r${slot}`, jobId: `job-r${slot}`, recordId, at: writeSlotAt(slot),
      submittedValues: { name: `登録 ${recordId}` },
    })).toBe(true);
  };

  /** `slot` 回目の UPDATE の許可を発行して消費する（予定の ID は今の選び方の値）。 */
  const consumedUpdate = (slot: number): { readonly grantId: string; readonly jobId: string } => {
    const revision = readScenario(database, UPDATE_ID)?.revision ?? 0;
    const grantId = `grant-u${slot}`;
    const jobId = `job-u${slot}`;
    const issued = issueExecutionGrant(database, {
      scenarioId: UPDATE_ID, expectedRevision: revision, grantId, jobId, count: 1, expectedTargetRecordId: readPlannedUpdateTarget(database, UPDATE_ID),
      external: EXTERNAL, at: writeSlotAt(slot),
    });
    if (!issued.ok) {
      throw new Error(`not issued: ${issued.reason}`);
    }
    const consumed = consumeExecutionGrant(database, {
      grantId, scenarioId: UPDATE_ID, scenarioRevision: revision, jobId, profileId: GRANT_PROFILE_ID, external: EXTERNAL, at: writeSlotAt(slot, MINUTE_MS),
    });
    if (!consumed.ok) {
      throw new Error(`not consumed: ${consumed.reason}`);
    }
    return { grantId, jobId };
  };

  const updateAttempt = (slot: number, overrides: Partial<WriteAttempt> = {}): WriteAttempt => ({
    jobId: `job-u${slot}`, grantId: `grant-u${slot}`, seedRecord: seedRecordOf(`grant-u${slot}`), submittedValues: { name: `更新 ${slot}` },
    uniqueKey: JSON.stringify({ name: `更新 ${slot}` }), phoneNumbers: [], at: writeSlotAt(slot, MINUTE_MS), ...overrides,
  });

  /** すべての欄が一致した証拠（変えた欄 `name`）。 */
  const evidenceOf = (slot: number, overrides: Partial<WriteUpdateEvidence['fields'][number]> = {}): WriteUpdateEvidence => ({
    fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: `登録 ${TARGET}`, newValue: `更新 ${slot}`, matched: true, ...overrides }],
  });

  const verifiedUpdateReport = (slot: number, overrides: Partial<WriteOutcomeReport> = {}): WriteOutcomeReport => sentReport(slot, {
    jobId: `job-u${slot}`, recordId: TARGET, updateEvidence: evidenceOf(slot), ...overrides,
  });

  it('records the kind and the target from the grant, and settles a VERIFIED update with its evidence', () => {
    prepareUpdate();
    consumedUpdate(1);
    const recorded = recordWriteAttempt(database, updateAttempt(1));
    expect(recorded.ok ? [recorded.result.writeKind, recorded.result.targetRecordId, recorded.result.updateEvidence] : reasonOf(recorded))
      .toEqual(['UPDATE', TARGET, null]);
    const settled = settleWriteResult(database, verifiedUpdateReport(1));
    expect(settled.ok ? [settled.result.result, settled.result.reservationState, settled.result.updateEvidence] : reasonOf(settled))
      .toEqual(['VERIFIED', 'COMMITTED', evidenceOf(1)]);
    expect(readWriteResult(database, 'job-u1')?.updateEvidence).toEqual(evidenceOf(1));
    // CREATE の登録は CREATE として記録されている（対象の ID と証拠を持たない）。
    expect(readWriteResult(database, 'job-r0')).toMatchObject({ writeKind: 'CREATE', targetRecordId: null, updateEvidence: null });
  });

  // T31e fix round 1: 取れた ID の違い・一致しない欄・照合できない欄は、拒まずに結果の判定で決めて記録する（`UNKNOWN`・`PARTIAL`）。
  it.each<readonly [string, Partial<WriteOutcomeReport>, string, string]>([
    // T31f: 更新の後の照合を判定できないときの理由は `UPDATE_POSTCHECK_UNDETERMINED`（READ の判定できないとは分けた）。
    ['a success without evidence', { updateEvidence: null }, 'PARTIAL', 'UPDATE_POSTCHECK_UNDETERMINED'],
    ['a success with a field that did not match', { updateEvidence: evidenceOf(1, { matched: false }) }, 'UNKNOWN', 'UNEXPECTED_FIELD_CHANGE'],
    ['a success with a field that was not checked', { updateEvidence: evidenceOf(1, { matched: null }) }, 'PARTIAL', 'UPDATE_POSTCHECK_UNDETERMINED'],
    ['a success with another record id', { recordId: 'rec-9' }, 'UNKNOWN', 'RECORD_ID_MISMATCH'],
  ])('records %s of an update as the outcome decides', (_label, overrides, result, reason) => {
    prepareUpdate();
    consumedUpdate(1);
    expect(recordWriteAttempt(database, updateAttempt(1)).ok).toBe(true);
    const settled = settleWriteResult(database, verifiedUpdateReport(1, overrides));
    expect(settled.ok ? [settled.result.result, settled.result.reason, settled.result.reservationState] : reasonOf(settled))
      .toEqual([result, reason, 'COMMITTED']);
    expect(readWriteResult(database, 'job-u1')?.updateEvidence).toEqual(overrides.updateEvidence === undefined ? evidenceOf(1) : overrides.updateEvidence);
  });

  it.each<readonly [string, Partial<WriteOutcomeReport>]>([
    ['evidence whose new value is not the recorded value', { updateEvidence: evidenceOf(1, { newValue: 'ほかの値' }) }],
    ['evidence of a field that the scenario does not change', { updateEvidence: { fields: [{ fieldName: 'email', role: 'CHANGED', previousValue: 'a',
      newValue: 'b', matched: true }] } }],
    ['evidence that keeps a field that the scenario changes', { updateEvidence: { fields: [{ fieldName: 'name', role: 'KEPT', previousValue: null,
      newValue: null, matched: true }] } }],
    ['evidence with a field twice', { updateEvidence: { fields: [...evidenceOf(1).fields, ...evidenceOf(1).fields] } }],
    ['evidence with a value of a kept field', { updateEvidence: { fields: [...evidenceOf(1).fields, { fieldName: 'email', role: 'KEPT',
      previousValue: 'kept@example.invalid', newValue: null, matched: true }] } }],
  ])('rejects %s with RangeError, and writes nothing', (_label, overrides) => {
    prepareUpdate();
    consumedUpdate(1);
    expect(recordWriteAttempt(database, updateAttempt(1)).ok).toBe(true);
    expect(() => settleWriteResult(database, verifiedUpdateReport(1, overrides))).toThrow(RangeError);
    expect(readWriteResult(database, 'job-u1')).toMatchObject({ result: null, updateEvidence: null });
    expect(readExecutionGrant(database, 'grant-u1')?.reservation.state).toBe('RESERVED');
  });

  it('settles an UNKNOWN update without evidence, and rejects evidence for a CREATE write', () => {
    prepareUpdate();
    consumedUpdate(1);
    expect(recordWriteAttempt(database, updateAttempt(1)).ok).toBe(true);
    const unknown = settleWriteResult(database, verifiedUpdateReport(1, {
      submission: 'UNKNOWN', httpStatus: null, responseJudgement: null, recordId: null, readVerification: null, submittedAt: null, updateEvidence: null,
    }));
    expect(unknown.ok ? [unknown.result.result, unknown.result.targetRecordId] : reasonOf(unknown)).toEqual(['UNKNOWN', TARGET]);
    consumedGrant(2);
    expect(recordWriteAttempt(database, attemptOf(2)).ok).toBe(true);
    expect(() => settleWriteResult(database, sentReport(2, { updateEvidence: evidenceOf(2) }))).toThrow(RangeError);
  });

  it('closes an orphaned UPDATE grant and an UPDATE grant without sending with the kind and the target of the grant', () => {
    prepareUpdate();
    consumedUpdate(1);
    expect(closeOrphanedWriteResults(database, writeSlotAt(1, 2 * MINUTE_MS))).toBe(1);
    expect(readWriteResult(database, 'job-u1')).toMatchObject({ writeKind: 'UPDATE', targetRecordId: TARGET, result: 'UNKNOWN', reason: 'NO_RESPONSE' });
    const { grantId, jobId } = consumedUpdate(2);
    const closed = closeWriteWithoutSending(database, { grantId, jobId, at: writeSlotAt(2, 2 * MINUTE_MS) });
    expect(closed.kind === 'SETTLED_NOT_SENT' ? [closed.result.writeKind, closed.result.targetRecordId, closed.result.result] : closed.kind)
      .toEqual(['UPDATE', TARGET, 'BLOCKED']);
  });

  it('recomputes the unique keys of the history from the values of the CREATE registrations and of the UPDATE writes', () => {
    prepareUpdate();
    consumedUpdate(1);
    expect(recordWriteAttempt(database, updateAttempt(1)).ok).toBe(true);
    expect(settleWriteResult(database, verifiedUpdateReport(1)).ok).toBe(true);
    const registered = uniqueKeyOf({ name: `登録 ${TARGET}` }, ['name']);
    const updated = uniqueKeyOf({ name: '更新 1' }, ['name']);
    // UPDATE のシナリオ: 使った値（CREATE の登録と UPDATE で送った値）から、UPDATE の一意にする欄の組（`name`）で求め直す。
    expect(readScenarioWriteGenerationHistory(database, UPDATE_ID, ['name']).usedUniqueKeys).toEqual(expect.arrayContaining([registered, updated]));
    // CREATE のシナリオ: 同じ台帳の UPDATE で送った値も含める（鍵は CREATE の一意にする欄の組で求め直す）。
    expect(readScenarioWriteGenerationHistory(database, 'scenario-1', ['name']).usedUniqueKeys).toEqual(expect.arrayContaining([registered, updated]));
    // CREATE の記録の鍵の文字列（ほかの欄の組で記録した鍵）を、UPDATE の履歴にそのまま渡さない。
    const createKeyOfOtherFields = uniqueKeyOf({ name: `登録 ${TARGET}`, plan: 'basic' }, ['name', 'plan']);
    expect(readScenarioWriteGenerationHistory(database, UPDATE_ID, ['name']).usedUniqueKeys).not.toContain(createKeyOfOtherFields);
    // 一意にする欄の組を渡さなければ、同じシナリオの記録の鍵だけ（ほかのシナリオの値から求め直さない。CCX-28 で消した口と同じ読み方）。
    expect(readScenarioWriteGenerationHistory(database, UPDATE_ID, []).usedUniqueKeys).toEqual([JSON.stringify({ name: '更新 1' })]);
  });

  it('keeps the UPDATE result, its target and its evidence after reopening the database', () => {
    prepareUpdate();
    consumedUpdate(1);
    expect(recordWriteAttempt(database, updateAttempt(1)).ok).toBe(true);
    expect(settleWriteResult(database, verifiedUpdateReport(1)).ok).toBe(true);
    const before = readWriteResult(database, 'job-u1');
    closeControlDatabase(database);
    database = openControlDatabase(databasePath());
    expect(readWriteResult(database, 'job-u1')).toEqual(before);
    expect(readExecutionGrant(database, 'grant-u1')?.targetRecordId).toBe(TARGET);
  });
});
