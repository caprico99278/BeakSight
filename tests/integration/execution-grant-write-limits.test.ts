// T30d（Task 30 の設計書 2 章のユーザーの判断 3・4、3 章の「連続の上限」「検証の指定」「外部への通知」、10 章の 4）: 実行の許可の発行に足した確かめの
// 結合テスト（`src/control/approval/scenario-store.ts` の `issueExecutionGrant`）。
// - 検証の指定のどれかが未指定 → `VERIFICATION_SPEC_MISSING`（承認はできる）。
// - 連続の上限: 同じシナリオの最後の書き込み（`COMMITTED`・`UNKNOWN` の予約を締めた時刻）から 5 分未満 → `GRANT_WRITE_INTERVAL_NOT_ELAPSED`、
//   24 時間の窓の中の書き込みが 5 件 → `GRANT_DAILY_WRITE_LIMIT_REACHED`。`UNKNOWN` は数え、`RELEASED` は数えない。時計は注入する。
// - 環境の証跡の参照が空のプロファイルは、プロファイルの確かめで保存できないので、判定は単体のテスト（`execution-grant-policy.test.ts`）で確かめる。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeExecutionGrant,
  issueExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  type ExecutionGrantResult,
} from '../../src/control/approval/scenario-store.js';
import { MAX_WRITES_PER_DAY, MIN_WRITE_INTERVAL_MS, WRITE_RATE_WINDOW_MS } from '../../src/control/approval/scenario-contracts.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { dateOfCompactUtcTimestamp, formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import {
  EXTERNAL,
  GRANT_PROFILE_ID,
  ISSUED_AT,
  prepareGrantProfile,
  prepareScenario,
  settleWriteForTest,
  VERIFICATION_SPEC,
} from './execution-grant-fixtures.js';

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const BASE_MS = dateOfCompactUtcTimestamp(ISSUED_AT).getTime();

let workDirectory = '';
let database: ControlDatabase;
let latest: ReturnType<typeof prepareGrantProfile>;
let counter = 0;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-grant-limits-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  latest = prepareGrantProfile(database);
  counter = 0;
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const timeAt = (offsetMs: number): string => formatCompactUtcTimestamp(new Date(BASE_MS + offsetMs), 'test time');

const issueAt = (offsetMs: number, scenarioId = 'scenario-1'): ExecutionGrantResult => {
  counter += 1;
  return issueExecutionGrant(database, {
    scenarioId, expectedRevision: readScenario(database, scenarioId)?.revision ?? 0, grantId: `grant-${counter}`, jobId: `job-w${counter}`, count: 1,
    external: EXTERNAL, at: timeAt(offsetMs),
  });
};

/** `offsetMs` に発行し、同じ時刻に消費して、`settleOffsetMs` に `state` で締める。 */
const writeAt = (offsetMs: number, state: 'COMMITTED' | 'UNKNOWN' | 'RELEASED', settleOffsetMs = offsetMs, scenarioId = 'scenario-1'): void => {
  const issued = issueAt(offsetMs, scenarioId);
  if (!issued.ok) {
    throw new Error(`not issued at ${offsetMs}: ${issued.reason}`);
  }
  const { grant } = issued;
  expect(consumeExecutionGrant(database, {
    grantId: grant.grantId, scenarioId, scenarioRevision: grant.scenarioRevision, jobId: grant.jobId, profileId: GRANT_PROFILE_ID, external: EXTERNAL,
    at: timeAt(offsetMs),
  }).ok).toBe(true);
  // T30e: 送った・分からないの締めは、書き込みの結果の記録を伴う口だけ（テストだけの手順）。
  expect(settleWriteForTest(database, {
    grantId: grant.grantId, jobId: grant.jobId, reservationId: grant.reservation.reservationId, to: state, at: timeAt(settleOffsetMs),
  })).toBe(true);
};

const reasonOf = (result: ExecutionGrantResult): string | null => (result.ok ? null : result.reason);

describe('execution grant issue (T30d): the verification spec', () => {
  it('approves a scenario without a verification spec, and rejects the issue with VERIFICATION_SPEC_MISSING', () => {
    prepareScenario(database, latest, 'scenario-1', { verification: null });
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, new Date(BASE_MS))?.validity.approved).toBe(true);
    expect(reasonOf(issueAt(0))).toBe('VERIFICATION_SPEC_MISSING');
  });

  it('rejects the issue when one item of the verification spec is unspecified', () => {
    prepareScenario(database, latest, 'scenario-1', { verification: { ...VERIFICATION_SPEC, recordId: null } });
    expect(reasonOf(issueAt(0))).toBe('VERIFICATION_SPEC_MISSING');
    prepareScenario(database, latest, 'scenario-2');
    expect(issueAt(0, 'scenario-2').ok).toBe(true);
  });
});

describe('execution grant issue (T30d): the write rate limits', () => {
  beforeEach(() => {
    prepareScenario(database, latest, 'scenario-1');
  });

  it('keeps 5 minutes after the last write (the boundary)', () => {
    writeAt(0, 'COMMITTED', MINUTE_MS);
    expect(reasonOf(issueAt(MINUTE_MS + MIN_WRITE_INTERVAL_MS - SECOND_MS))).toBe('GRANT_WRITE_INTERVAL_NOT_ELAPSED');
    expect(issueAt(MINUTE_MS + MIN_WRITE_INTERVAL_MS).ok).toBe(true);
  });

  it('counts an UNKNOWN write, and does not count a RELEASED reservation', () => {
    writeAt(0, 'UNKNOWN');
    expect(reasonOf(issueAt(MINUTE_MS))).toBe('GRANT_WRITE_INTERVAL_NOT_ELAPSED');
    prepareScenario(database, latest, 'scenario-2');
    writeAt(10 * MINUTE_MS, 'RELEASED', 10 * MINUTE_MS, 'scenario-2');
    expect(issueAt(11 * MINUTE_MS, 'scenario-2').ok).toBe(true);
  });

  it('allows 5 writes in 24 hours, rejects the 6th, and allows it again when the first leaves the window', () => {
    const slots = Array.from({ length: MAX_WRITES_PER_DAY }, (_value, index) => index * 10 * MINUTE_MS);
    slots.forEach((offset, index) => writeAt(offset, index === 2 ? 'UNKNOWN' : 'COMMITTED'));
    const lastSlot = slots.at(-1) ?? 0;
    expect(reasonOf(issueAt(lastSlot + 10 * MINUTE_MS))).toBe('GRANT_DAILY_WRITE_LIMIT_REACHED');
    expect(reasonOf(issueAt(WRITE_RATE_WINDOW_MS - SECOND_MS))).toBe('GRANT_DAILY_WRITE_LIMIT_REACHED');
    expect(issueAt(WRITE_RATE_WINDOW_MS).ok).toBe(true);
  });

  it('does not count a RELEASED reservation in the 24 hours', () => {
    const slots = Array.from({ length: MAX_WRITES_PER_DAY }, (_value, index) => index * 10 * MINUTE_MS);
    slots.forEach((offset, index) => writeAt(offset, index === 1 ? 'RELEASED' : 'COMMITTED'));
    expect(issueAt((slots.at(-1) ?? 0) + 10 * MINUTE_MS).ok).toBe(true);
  });
});
