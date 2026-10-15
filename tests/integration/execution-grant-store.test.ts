// T28d（Task 28 の設計書 3 章、4.4、8 章の G28）: 実行の許可と件数の予約の保存（`src/control/approval/scenario-store.ts` の許可と予約の節）の結合テスト。
// - G28: 承認なし・版の違い・撤回済み・期限切れ（承認）・許可の期限切れ・許可の再利用・偽造の id・別のジョブ・別のシナリオ・別のプロファイル・
//   入力の規則の未設定・書き込みのモードでないプロファイル・取り消したプロファイルで、発行か消費が拒まれる。正しい承認と規則の参照があれば、
//   1 回だけ発行・消費できる。
// - 予約: 1 回の Run の上限、累積の上限の境、`RELEASED` を数えない、`UNKNOWN` を数える、許可の期限切れで返す、撤回で返す。状態の遷移は閉じた表。
// - 入力の規則の参照を付けると、版が上がり `DRAFT` に戻る（再承認が要る）。
// - データベースを開き直した後も、消費の記録と予約の状態が残る。書き込みのロックを待ち切れなければ `DATABASE_LOCKED`（今の管理データの決め）。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLatestRuleSet, saveRuleSet, saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import {
  assertGrantStillValid,
  attachInputRuleReference,
  consumeExecutionGrant,
  issueExecutionGrant,
  readExecutionGrant,
  readScenarioApprovalStatus,
  readUsedCumulativeWrites,
  readWriteReservations,
  revokeScenarioApproval,
  settleWriteReservation,
  type ExecutionGrantResult,
  type GrantConsumption,
  type GrantIssue,
} from '../../src/control/approval/scenario-store.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, retireProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { ControlStoreError } from '../../src/control/store/store-errors.js';
import { resolveTestContext, testAuthProfile, testWriteProfile } from './control-profile-fixtures.js';
import {
  EMPTY_RULE_CONTENT,
  EXTERNAL,
  GRANT_EXPIRES_AT,
  GRANT_PROFILE_ID,
  INPUT_RULES,
  ISSUED_AT,
  prepareGrantProfile,
  prepareScenario,
  ruleSetIdOf,
  settleWriteForTest,
  writeSlotAt,
} from './execution-grant-fixtures.js';

const CONSUMED_AT = '20261012030100';
const LATER_AT = '20261012040000';
const AFTER_APPROVAL_TTL = '20261111020000';
const OTHER_PROFILE_ID = 'example-grant-other';
const LOCK_TEST_TIMEOUT_MS = 20_000;
const MINUTE_MS = 60_000;

let workDirectory = '';
let database: ControlDatabase;
let latest: ReturnType<typeof prepareGrantProfile>;

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-execution-grant-'));
  database = openControlDatabase(databasePath());
  latest = prepareGrantProfile(database);
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const issue = (overrides: Partial<GrantIssue> = {}, scenarioId = 'scenario-1'): ExecutionGrantResult => {
  const revision = overrides.expectedRevision ?? readScenarioApprovalStatus(database, scenarioId, EXTERNAL, new Date())?.scenario.revision ?? 1;
  return issueExecutionGrant(database, {
    scenarioId, expectedRevision: revision, grantId: 'grant-1', jobId: 'job-w1', count: 1, external: EXTERNAL, at: ISSUED_AT, ...overrides,
  });
};

const consumptionOf = (grant: ExecutionGrantResult, overrides: Partial<GrantConsumption> = {}): GrantConsumption => {
  if (!grant.ok) {
    throw new Error(`the grant was not issued: ${grant.reason}`);
  }
  return {
    grantId: grant.grant.grantId,
    scenarioId: grant.grant.scenarioId,
    scenarioRevision: grant.grant.scenarioRevision,
    jobId: grant.grant.jobId,
    profileId: grant.grant.profileId,
    external: EXTERNAL,
    at: CONSUMED_AT,
    ...overrides,
  };
};

const reasonOf = (result: ExecutionGrantResult): string | null => (result.ok ? null : result.reason);
const invalidityOf = (result: ExecutionGrantResult): readonly string[] => (result.ok ? [] : result.invalidityReasons);

/**
 * 1 回の書き込み（発行 → 消費 → 送った記録）。T30d: 同じシナリオの連続の書き込みの間隔（5 分）を守るため、`index` 回目（1 から）の書き込みは
 * `writeSlotAt(index - 1)` に発行し、その 1 分後に消費して締める（意図した変化。数え方の確かめは今までと同じ）。
 */
const writeOnce = (index: number, settleTo: 'COMMITTED' | 'UNKNOWN' | 'RELEASED' = 'COMMITTED', scenarioId = 'scenario-1'): ExecutionGrantResult => {
  const slot = index - 1;
  const issued = issue({ grantId: `grant-${index}`, jobId: `job-w${index}`, at: writeSlotAt(slot) }, scenarioId);
  if (!issued.ok) {
    return issued;
  }
  const at = writeSlotAt(slot, MINUTE_MS);
  const consumed = consumeExecutionGrant(database, consumptionOf(issued, { at }));
  expect(consumed.ok).toBe(true);
  // T30e: 送った・分からないの締めは、書き込みの結果の記録を伴う口だけ（テストだけの手順）。
  expect(settleWriteForTest(database, {
    grantId: issued.grant.grantId, jobId: issued.grant.jobId, reservationId: issued.grant.reservation.reservationId, to: settleTo, at,
  })).toBe(true);
  return issued;
};

describe('execution grants (T28d): G28', () => {
  it('issues one grant with one reservation and consumes it once, for a valid approval with input rules', () => {
    prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    expect(issued.ok && issued.grant).toMatchObject({
      grantId: 'grant-1', profileId: GRANT_PROFILE_ID, scenarioId: 'scenario-1', scenarioRevision: 2, approvalReceiptId: 'receipt-scenario-1',
      jobId: 'job-w1', issuedAt: ISSUED_AT, expiresAt: GRANT_EXPIRES_AT, consumedAt: null, invalidatedAt: null,
      reservation: { grantId: 'grant-1', scenarioId: 'scenario-1', count: 1, state: 'RESERVED', reservedAt: ISSUED_AT, settledAt: null },
    });
    expect(reasonOf(issue({ grantId: 'grant-2', jobId: 'job-w2' }))).toBe('GRANT_ALREADY_OPEN');
    const consumed = consumeExecutionGrant(database, consumptionOf(issued));
    expect(consumed.ok && consumed.grant.consumedAt).toBe(CONSUMED_AT);
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued)))).toBe('GRANT_ALREADY_CONSUMED');
    expect(assertGrantStillValid(database, { ...consumptionOf(issued), now: new Date(Date.parse('2026-10-12T03:02:00Z')) }).ok).toBe(true);
  });

  it('rejects the issue without an approval, without input rules, with another revision or for a missing scenario', () => {
    prepareScenario(database, latest, 'scenario-1', { approve: false });
    const notApproved = issue();
    expect([reasonOf(notApproved), invalidityOf(notApproved)]).toEqual(['GRANT_APPROVAL_INVALID', ['NOT_APPROVED']]);
    prepareScenario(database, latest, 'scenario-2', { attach: false });
    expect(reasonOf(issue({}, 'scenario-2'))).toBe('NEEDS_RULE_INPUT');
    prepareScenario(database, latest, 'scenario-3');
    expect(reasonOf(issue({ expectedRevision: 1 }, 'scenario-3'))).toBe('GRANT_REVISION_CONFLICT');
    expect(reasonOf(issue({}, 'scenario-missing'))).toBe('GRANT_SCENARIO_NOT_FOUND');
    expect(readWriteReservations(database, 'scenario-1')).toEqual([]);
  });

  it('rejects the issue after a revocation, after the approval expired, and for a retired or passive profile', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1');
    expect(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: scenario.revision, receiptId: 'revoke-1', at: ISSUED_AT }).ok).toBe(true);
    expect(invalidityOf(issue({ at: LATER_AT }))).toEqual(['REVOKED']);
    prepareScenario(database, latest, 'scenario-2');
    expect(invalidityOf(issue({ at: AFTER_APPROVAL_TTL }, 'scenario-2'))).toEqual(['EXPIRED']);
    expect(updateProfile(database, { profile: testAuthProfile(GRANT_PROFILE_ID, MIN_PROFILE_REVISION + 1), expectedRevision: MIN_PROFILE_REVISION },
      { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(invalidityOf(issue({}, 'scenario-2'))).toEqual(['PROFILE_REVISION_CHANGED', 'MODE_NOT_WRITE']);
    expect(retireProfile(database, { profileId: GRANT_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION + 1 }).ok).toBe(true);
    expect(invalidityOf(issue({}, 'scenario-2'))).toContain('PROFILE_RETIRED');
  });

  it('rejects the consumption of a forged id, another job, scenario, profile or revision, and a second consumption', () => {
    prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { grantId: 'grant-forged' })))).toBe('GRANT_NOT_FOUND');
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { jobId: 'job-other' })))).toBe('GRANT_MISMATCH');
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { scenarioId: 'scenario-other' })))).toBe('GRANT_MISMATCH');
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { profileId: OTHER_PROFILE_ID })))).toBe('GRANT_MISMATCH');
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { scenarioRevision: 1 })))).toBe('GRANT_MISMATCH');
    expect(readExecutionGrant(database, 'grant-1')?.consumedAt).toBeNull();
    expect(consumeExecutionGrant(database, consumptionOf(issued)).ok).toBe(true);
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { at: LATER_AT })))).toBe('GRANT_ALREADY_CONSUMED');
  });

  it('rejects an expired grant, invalidates it and releases its reservation, and a new grant can then be issued', () => {
    prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { at: GRANT_EXPIRES_AT })))).toBe('GRANT_EXPIRED');
    expect(readExecutionGrant(database, 'grant-1')).toMatchObject({ consumedAt: null, invalidatedAt: GRANT_EXPIRES_AT, reservation: { state: 'RELEASED' } });
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { at: LATER_AT })))).toBe('GRANT_INVALIDATED');
    expect(issue({ grantId: 'grant-2', jobId: 'job-w2', at: LATER_AT }).ok).toBe(true);
  });

  it('lets an expired open grant not block the next issue (it is invalidated in the same transaction)', () => {
    prepareScenario(database, latest, 'scenario-1');
    issue();
    const next = issue({ grantId: 'grant-2', jobId: 'job-w2', at: LATER_AT });
    expect(next.ok).toBe(true);
    expect(readExecutionGrant(database, 'grant-1')).toMatchObject({ invalidatedAt: LATER_AT, reservation: { state: 'RELEASED' } });
  });

  it('rejects the consumption after the approval was revoked or the scenario changed', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    // T29d fix round 1: 参照は、規則の集まりの最新の版だけを付けられる（規則の新しい版を保存してから付ける）。
    const saved = saveRuleSetAndAttach(database, {
      ruleSetId: ruleSetIdOf('scenario-1'), scenarioId: 'scenario-1', expectedRevision: 1, content: EMPTY_RULE_CONTENT,
      expectedScenarioRevision: scenario.revision, at: CONSUMED_AT,
    });
    expect(saved.ruleSet.ok && saved.attachment?.ok).toBe(true);
    const changed = consumeExecutionGrant(database, consumptionOf(issued, { at: CONSUMED_AT }));
    expect([reasonOf(changed), invalidityOf(changed)]).toEqual(['GRANT_APPROVAL_INVALID', ['SCENARIO_REVISION_CHANGED', 'INPUT_RULES_CHANGED']]);
  });

  it('checks again before a write: consumed, approved, not revoked', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    const recheck = { ...consumptionOf(issued), now: new Date(Date.parse('2026-10-12T03:02:00Z')) };
    expect(reasonOf(assertGrantStillValid(database, recheck))).toBe('GRANT_NOT_CONSUMED');
    consumeExecutionGrant(database, consumptionOf(issued));
    expect(assertGrantStillValid(database, recheck).ok).toBe(true);
    expect(reasonOf(assertGrantStillValid(database, { ...recheck, grantId: 'grant-forged' }))).toBe('GRANT_NOT_FOUND');
    expect(reasonOf(assertGrantStillValid(database, { ...recheck, jobId: 'job-other' }))).toBe('GRANT_MISMATCH');
    revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: scenario.revision, receiptId: 'revoke-1', at: LATER_AT });
    const revoked = assertGrantStillValid(database, recheck);
    expect([reasonOf(revoked), invalidityOf(revoked)]).toEqual(['GRANT_APPROVAL_INVALID', ['REVOKED']]);
  });
});

// T28R-fix-1（独立レビュー T28R の I-2、M-2、M-6）。
describe('execution grants (T28R-fix-1): the recheck, the clock and the used count', () => {
  const RECHECK_NOW = new Date(Date.parse('2026-10-12T03:02:00Z'));

  it.each(['COMMITTED', 'UNKNOWN', 'RELEASED'] as const)('rejects the recheck after the reservation was settled as %s (I-2)', (settleTo) => {
    prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    consumeExecutionGrant(database, consumptionOf(issued));
    const recheck = { ...consumptionOf(issued), now: RECHECK_NOW };
    expect(assertGrantStillValid(database, recheck).ok).toBe(true);
    if (!issued.ok) throw new Error('not issued');
    expect(settleWriteForTest(database, {
      grantId: issued.grant.grantId, jobId: issued.grant.jobId, reservationId: issued.grant.reservation.reservationId, to: settleTo, at: CONSUMED_AT,
    })).toBe(true);
    expect(reasonOf(assertGrantStillValid(database, recheck))).toBe('GRANT_RESERVATION_SETTLED');
  });

  it('never lets two rechecks pass at the same time: a settled grant stays rejected while the next grant is valid (I-2)', () => {
    prepareScenario(database, latest, 'scenario-1');
    prepareScenario(database, latest, 'scenario-2');
    const first = writeOnce(1, 'COMMITTED');
    const second = issue({ grantId: 'grant-2', jobId: 'job-w2' }, 'scenario-2');
    expect(consumeExecutionGrant(database, consumptionOf(second)).ok).toBe(true);
    expect(assertGrantStillValid(database, { ...consumptionOf(second), now: RECHECK_NOW }).ok).toBe(true);
    expect(reasonOf(assertGrantStillValid(database, { ...consumptionOf(first), now: RECHECK_NOW }))).toBe('GRANT_RESERVATION_SETTLED');
  });

  it('rejects an issue before the approval time and a consumption before the issue time with reason codes (M-2)', () => {
    prepareScenario(database, latest, 'scenario-1');
    expect(reasonOf(issue({ at: '20261012015900' }))).toBe('GRANT_CLOCK_BEFORE_APPROVAL');
    const issued = issue();
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { at: '20261012025900' })))).toBe('GRANT_CLOCK_BEFORE_ISSUE');
    expect(readExecutionGrant(database, 'grant-1')).toMatchObject({ consumedAt: null, invalidatedAt: null, reservation: { state: 'RESERVED' } });
  });

  it('counts the used writes as the issue does: the reservation of an expired open grant is not counted (M-6)', () => {
    prepareScenario(database, latest, 'scenario-1');
    expect(readUsedCumulativeWrites(database, 'scenario-1', RECHECK_NOW)).toBe(0);
    issue();
    expect(readUsedCumulativeWrites(database, 'scenario-1', RECHECK_NOW)).toBe(1);
    expect(readUsedCumulativeWrites(database, 'scenario-1', new Date(Date.parse('2026-10-12T03:05:00Z')))).toBe(0);
    expect(readWriteReservations(database, 'scenario-1').map(({ state }) => state)).toEqual(['RESERVED']);
  });
});

describe('execution grants (T28d): reservations', () => {
  it('rejects a count above the per-run limit', () => {
    prepareScenario(database, latest, 'scenario-1');
    expect(reasonOf(issue({ count: 2 }))).toBe('GRANT_RUN_LIMIT_EXCEEDED');
  });

  it('stops at the cumulative limit, counts UNKNOWN, and does not count RELEASED', () => {
    prepareScenario(database, latest, 'scenario-1', { limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 3 } });
    expect(writeOnce(1, 'COMMITTED').ok).toBe(true);
    expect(writeOnce(2, 'RELEASED').ok).toBe(true);
    expect(writeOnce(3, 'UNKNOWN').ok).toBe(true);
    expect(writeOnce(4, 'COMMITTED').ok).toBe(true);
    expect(reasonOf(writeOnce(5))).toBe('GRANT_CUMULATIVE_LIMIT_REACHED');
    expect(readWriteReservations(database, 'scenario-1').map(({ state }) => state)).toEqual(['COMMITTED', 'RELEASED', 'UNKNOWN', 'COMMITTED']);
  });

  it('keeps one write at a time across scenarios (an open grant or a consumed grant whose reservation is not settled)', () => {
    prepareScenario(database, latest, 'scenario-1');
    prepareScenario(database, latest, 'scenario-2');
    const first = issue();
    expect(reasonOf(issue({ grantId: 'grant-2', jobId: 'job-w2' }, 'scenario-2'))).toBe('GRANT_WRITE_CONCURRENCY_EXCEEDED');
    consumeExecutionGrant(database, consumptionOf(first));
    expect(reasonOf(issue({ grantId: 'grant-2', jobId: 'job-w2' }, 'scenario-2'))).toBe('GRANT_WRITE_CONCURRENCY_EXCEEDED');
    if (first.ok) {
      settleWriteForTest(database, {
        grantId: first.grant.grantId, jobId: first.grant.jobId, reservationId: first.grant.reservation.reservationId, to: 'COMMITTED', at: CONSUMED_AT,
      });
    }
    expect(issue({ grantId: 'grant-2', jobId: 'job-w2' }, 'scenario-2').ok).toBe(true);
  });

  it('releases the reservations of the unconsumed grants on a revocation, and keeps the consumed ones', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1', { limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 5 } });
    const consumed = issue();
    consumeExecutionGrant(database, consumptionOf(consumed));
    if (consumed.ok) {
      settleWriteForTest(database, {
        grantId: consumed.grant.grantId, jobId: consumed.grant.jobId, reservationId: consumed.grant.reservation.reservationId, to: 'UNKNOWN', at: CONSUMED_AT,
      });
    }
    // T30d: 同じシナリオの連続の書き込みの間隔（5 分）の後に発行する（意図した変化）。
    const open = issue({ grantId: 'grant-2', jobId: 'job-w2', at: writeSlotAt(1) });
    expect(open.ok).toBe(true);
    expect(revokeScenarioApproval(database, { scenarioId: 'scenario-1', expectedRevision: scenario.revision, receiptId: 'revoke-1', at: LATER_AT }).ok)
      .toBe(true);
    expect(readExecutionGrant(database, 'grant-2')).toMatchObject({ consumedAt: null, invalidatedAt: LATER_AT, reservation: { state: 'RELEASED', settledAt: LATER_AT } });
    expect(readExecutionGrant(database, 'grant-1')).toMatchObject({ consumedAt: CONSUMED_AT, invalidatedAt: null, reservation: { state: 'UNKNOWN' } });
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(open, { at: LATER_AT })))).toBe('GRANT_INVALIDATED');
  });

  it('changes a reservation only along the closed table', () => {
    prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    if (!issued.ok) throw new Error('not issued');
    const { reservationId } = issued.grant.reservation;
    // 送った・分からないは、消費済みの許可の予約だけ（送る前に返すのは、消費の前でもよい）。T30e: 送った・分からないの締めは、書き込みの結果の
    // 記録を伴う口だけ（`settleWriteReservation` は `RELEASED` だけ。`COMMITTED` は `RangeError`）。消費の前は、送る前の記録も書けない。
    expect(() => settleWriteReservation(database, { reservationId, to: 'COMMITTED', at: CONSUMED_AT })).toThrow(RangeError);
    expect(settleWriteForTest(database, { grantId: issued.grant.grantId, jobId: issued.grant.jobId, reservationId, to: 'COMMITTED', at: CONSUMED_AT }))
      .toBe(false);
    expect(consumeExecutionGrant(database, consumptionOf(issued)).ok).toBe(true);
    expect(settleWriteForTest(database, { grantId: issued.grant.grantId, jobId: issued.grant.jobId, reservationId, to: 'COMMITTED', at: CONSUMED_AT }))
      .toBe(true);
    expect(readExecutionGrant(database, issued.grant.grantId)?.reservation).toMatchObject({ state: 'COMMITTED', settledAt: CONSUMED_AT });
    expect(settleWriteReservation(database, { reservationId, to: 'RELEASED', at: LATER_AT }))
      .toEqual({ ok: false, reason: 'RESERVATION_TRANSITION_NOT_ALLOWED' });
    expect(settleWriteReservation(database, { reservationId: 999, to: 'RELEASED', at: LATER_AT })).toEqual({ ok: false, reason: 'RESERVATION_NOT_FOUND' });
    expect(() => settleWriteReservation(database, { reservationId, to: 'RESERVED', at: LATER_AT })).toThrow(RangeError);
  });
});

describe('execution grants (T28d): input rules', () => {
  it('raises the revision and returns the scenario to DRAFT when the input rules are attached', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1');
    expect(scenario).toMatchObject({ revision: 2, state: 'APPROVED' });
    // T29d: 準備は、規則の集まりを保存してから、その最新の版の参照を付ける。
    expect(scenario.current.inputRuleReference).toEqual(readLatestRuleSet(database, 'scenario-1')?.reference);
    expect(scenario.current.inputRuleReference?.ruleSetId).toBe('rules-scenario-1');
    const saved = saveRuleSet(database, {
      ruleSetId: ruleSetIdOf('scenario-1'), scenarioId: 'scenario-1', expectedRevision: 1, content: EMPTY_RULE_CONTENT, at: LATER_AT,
    });
    if (!saved.ok) {
      throw new Error(`the rule set was not saved: ${saved.reason}`);
    }
    // T29d fix round 1: 形だけの参照は付けない（規則の集まりの最新の版と一致しない）。
    const fake = attachInputRuleReference(database, { scenarioId: 'scenario-1', expectedRevision: 2, reference: INPUT_RULES, at: LATER_AT });
    expect(fake.ok ? null : fake.reason).toBe('SCENARIO_INPUT_RULES_NOT_LATEST');
    const attached = attachInputRuleReference(database, {
      scenarioId: 'scenario-1', expectedRevision: 2, reference: saved.reference, at: LATER_AT,
    });
    expect(attached.ok && [attached.scenario.revision, attached.scenario.state, attached.scenario.current.inputRuleReference?.revision])
      .toEqual([3, 'DRAFT', 2]);
    expect(attached.ok && attached.scenario.evidence).toEqual(scenario.evidence);
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, new Date(Date.parse('2026-10-12T05:00:00Z')))?.validity)
      .toEqual({ approved: false, reasons: ['SCENARIO_REVISION_CHANGED', 'INPUT_RULES_CHANGED'] });
    const stale = attachInputRuleReference(database, { scenarioId: 'scenario-1', expectedRevision: 2, reference: INPUT_RULES, at: LATER_AT });
    expect(stale.ok ? null : stale.reason).toBe('SCENARIO_REVISION_CONFLICT');
    expect(() => attachInputRuleReference(database, {
      scenarioId: 'scenario-1', expectedRevision: 3, reference: { ...INPUT_RULES, digest: 'x' }, at: LATER_AT,
    })).toThrow(RangeError);
  });
});

describe('execution grants (T28d): persistence and locks', () => {
  it('keeps the consumption and the reservation states after reopening the database', () => {
    prepareScenario(database, latest, 'scenario-1');
    const issued = writeOnce(1, 'UNKNOWN');
    closeControlDatabase(database);
    database = openControlDatabase(databasePath());
    expect(readExecutionGrant(database, 'grant-1')).toMatchObject({ consumedAt: CONSUMED_AT, reservation: { state: 'UNKNOWN', settledAt: CONSUMED_AT } });
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { at: LATER_AT })))).toBe('GRANT_ALREADY_CONSUMED');
  });

  it('rejects a profile that is not the profile of the grant even when it exists', () => {
    expect(createProfile(database, testWriteProfile(OTHER_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    prepareScenario(database, latest, 'scenario-1');
    const issued = issue();
    expect(reasonOf(consumeExecutionGrant(database, consumptionOf(issued, { profileId: OTHER_PROFILE_ID })))).toBe('GRANT_MISMATCH');
  });

  it('stops with DATABASE_LOCKED when another writer keeps the write lock past the busy timeout', () => {
    prepareScenario(database, latest, 'scenario-1');
    const holder = new DatabaseSync(databasePath(), { timeout: 0 });
    try {
      holder.exec('BEGIN IMMEDIATE');
      let caught: unknown;
      try {
        issue();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ControlStoreError);
      expect((caught as ControlStoreError).reason).toBe('DATABASE_LOCKED');
      holder.exec('ROLLBACK');
    } finally {
      holder.close();
    }
    expect(readExecutionGrant(database, 'grant-1')).toBeNull();
  }, LOCK_TEST_TIMEOUT_MS);
});
