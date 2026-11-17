// T30d（Task 30 の設計書 2 章のユーザーの判断 3・4、3 章の「連続の上限」「検証の指定」「外部への通知」、10 章の 4）: 実行の許可の発行に足した確かめの
// 結合テスト（`src/control/approval/scenario-store.ts` の `issueExecutionGrant`）。
// - 検証の指定のどれかが未指定 → `VERIFICATION_SPEC_MISSING`（承認はできる）。
// - 連続の上限（前は 5 分の間隔と 24 時間に 5 件）は L12b で撤廃した（下の L12b の場面。時計は注入する）。
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

  // PL-5 の 9 の (4)（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1）: form の ID の取り方は求めない（決められなければ null のまま、結果は ID なしの
  // PARTIAL）。答え合わせ（照合の READ）は今どおり求める。
  it('rejects the issue when one required item of the verification spec is unspecified', () => {
    prepareScenario(database, latest, 'scenario-1', { verification: { ...VERIFICATION_SPEC, readVerification: null } });
    expect(reasonOf(issueAt(0))).toBe('VERIFICATION_SPEC_MISSING');
    prepareScenario(database, latest, 'scenario-2');
    expect(issueAt(0, 'scenario-2').ok).toBe(true);
  });

  it('issues the grant of a form scenario without a way to take the record id when the READ verification is there (PL-5 9 (4))', () => {
    prepareScenario(database, latest, 'scenario-1', { verification: { ...VERIFICATION_SPEC, recordId: null } });
    expect(issueAt(0).ok).toBe(true);
  });
});

// L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2、L12 の判断 3）: 書き込みの頻度の上限（前は 5 分の間隔・24 時間に 5 件・累積 20 件）と、承認と
// 許可の有効期間（前は承認 30 日・許可 5 分）を撤廃した。前の T30d の連続の上限のテストは、この期待に置き換えた（上限を前提にしていたため）。
describe('execution grant issue (L12b): no write rate limit, no cumulative limit and no approval or grant expiry', () => {
  beforeEach(() => {
    prepareScenario(database, latest, 'scenario-1');
  });

  it('issues the grants of the same approval one after another without an interval or a daily or cumulative limit', () => {
    // 前の上限: 5 分の間隔・24 時間に 5 件・累積 20 件。同じ承認で、続けて 25 回書く（UNKNOWN も含む）。
    for (let index = 0; index < 25; index += 1) {
      writeAt(index * SECOND_MS, index % 7 === 3 ? 'UNKNOWN' : 'COMMITTED');
    }
    expect(issueAt(25 * SECOND_MS).ok).toBe(true);
  });

  it('keeps the approval valid after the stored expiresAt has passed', () => {
    const later = 400 * 24 * 60 * MINUTE_MS;
    expect(readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, new Date(BASE_MS + later))?.validity.approved).toBe(true);
    writeAt(later, 'COMMITTED');
  });

  it('consumes a grant long after the issue (no grant expiry within the job)', () => {
    const issued = issueAt(0);
    if (!issued.ok) throw new Error(issued.reason);
    expect(consumeExecutionGrant(database, {
      grantId: issued.grant.grantId, scenarioId: 'scenario-1', scenarioRevision: issued.grant.scenarioRevision, jobId: issued.grant.jobId,
      profileId: GRANT_PROFILE_ID, external: EXTERNAL, at: timeAt(3 * 60 * MINUTE_MS),
    }).ok).toBe(true);
  });
});
