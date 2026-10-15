// T32g（Task 32 の設計書 4.1 の「監査済みデータの台帳」。ロードマップ 13.4）: 監査済みデータの台帳の読み出し（`readAuditedDataLedger`）の結合テスト。
// - 台帳の行は、プロファイルの CREATE の書き込みのうち、データを作ったかもしれないもの（送らずに止めた `NOT_SENT` を除く。結果が分からない回と、
//   締める前の回を含む）。新しい順。
// - 行ごとに、登録の ID、シナリオと版、seed の記録の ID と digest（実行の許可の ID と、入力の規則の集まりの digest。seed の値・基準日・試行の番号は
//   返さない）、ジョブと Run、照合の状態、その ID への UPDATE の回数と最後の結果。UPDATE は、UPDATE のシナリオの版が参照する CREATE のシナリオの
//   登録にだけ数える（ほかの CREATE のシナリオの同じ ID には数えない）。T32R M-1: UPDATE も、送らずに止めた `NOT_SENT` の回は回数と最後の結果に
//   入れない（送ったか分からない回は入れる）。
// - 別のプロファイルの書き込みは入らない。読むだけ（管理データを変えない）。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAuditedDataLedger } from '../../src/control/actions/write-result-facts.js';
import {
  consumeExecutionGrant,
  issueExecutionGrant,
  readPlannedUpdateTarget,
  readScenario,
} from '../../src/control/approval/scenario-store.js';
import { createStartingJob, recordRunStarted } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { RunId } from '../../src/core/contracts.js';
import { seedWriteResultForTest } from '../helpers/write-result-fixtures.js';
import {
  EXTERNAL,
  GRANT_PROFILE_ID,
  prepareGrantProfile,
  prepareScenario,
  prepareUpdateScenario,
  recordUpdateWriteForTest,
  registerVerifiedForTest,
  settleWriteForTest,
  writeSlotAt,
} from './execution-grant-fixtures.js';

const CREATE_SCENARIO_ID = 'scenario-create';
const OTHER_CREATE_SCENARIO_ID = 'scenario-create-2';
const UPDATE_SCENARIO_ID = 'scenario-update';
/** テストだけの Run の ID（ジョブの行の Run）。 */
const RUN_ID = 'RUN-20261012030000' as RunId;
/** テストだけの seed の記録の入力の規則の集まりの digest（`execution-grant-fixtures.ts` の値）。 */
const RULE_SET_DIGEST = `sha256:${'b'.repeat(64)}`;

let workDirectory = '';
let database: ControlDatabase;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-audited-ledger-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  const latest = prepareGrantProfile(database);
  prepareScenario(database, latest, CREATE_SCENARIO_ID);
  prepareScenario(database, latest, OTHER_CREATE_SCENARIO_ID, { receiptId: `receipt-${OTHER_CREATE_SCENARIO_ID}` });
  prepareUpdateScenario(database, latest, UPDATE_SCENARIO_ID, CREATE_SCENARIO_ID);
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

const revisionOf = (scenarioId: string): number => readScenario(database, scenarioId)?.revision ?? 0;

/** CREATE の照合まで済んだ登録を、`slot` 回目の時刻で 1 件作る。 */
const register = (scenarioId: string, slot: number, recordId: string): void => {
  expect(registerVerifiedForTest(database, { createScenarioId: scenarioId, grantId: `grant-c${slot}`, jobId: `job-c${slot}`, recordId, at: writeSlotAt(slot) }))
    .toBe(true);
};

/** UPDATE を 1 回（発行 → 消費 → 記録 → 締め）。 */
const update = (slot: number, targetRecordId: string, outcome: 'VERIFIED' | 'UNKNOWN'): void => {
  const at = writeSlotAt(slot);
  const grantId = `grant-u${slot}`;
  const jobId = `job-u${slot}`;
  expect(issueExecutionGrant(database, {
    scenarioId: UPDATE_SCENARIO_ID, expectedRevision: revisionOf(UPDATE_SCENARIO_ID), grantId, jobId, count: 1, expectedTargetRecordId: targetRecordId,
    external: EXTERNAL, at,
  }).ok).toBe(true);
  expect(consumeExecutionGrant(database, {
    grantId, scenarioId: UPDATE_SCENARIO_ID, scenarioRevision: revisionOf(UPDATE_SCENARIO_ID), jobId, profileId: GRANT_PROFILE_ID, external: EXTERNAL, at,
  }).ok).toBe(true);
  const settled = recordUpdateWriteForTest(database, {
    grantId, jobId, submittedValues: { name: `更新 ${String(slot)}` }, at, outcome, recordId: outcome === 'VERIFIED' ? targetRecordId : null,
    updateEvidence: outcome === 'VERIFIED'
      ? { fields: [{ fieldName: 'name', role: 'CHANGED', previousValue: `サンプル ${targetRecordId}`, newValue: `更新 ${String(slot)}`, matched: true }] }
      : null,
  });
  expect(settled.ok ? settled.result.result : settled.reason).toBe(outcome);
};

describe('T32g: the audited data ledger reader', () => {
  it('is empty for a profile without writes', () => {
    expect(readAuditedDataLedger(database, GRANT_PROFILE_ID)).toEqual([]);
    expect(readAuditedDataLedger(database, 'no-such-profile')).toEqual([]);
  });

  it('lists the CREATE writes that may have made data, newest first, with the seed reference, the run and the updates of the same scenario', () => {
    // ジョブの行（Run の ID を持つ）は、1 件目の登録だけ。
    expect(createStartingJob(database, {
      jobId: 'job-c0', profileId: GRANT_PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: false, createdAt: writeSlotAt(0), jobKind: 'WRITE_CREATE',
    }, () => null).ok).toBe(true);
    expect(recordRunStarted(database, 'job-c0', { runId: RUN_ID, runDirectory: RUN_ID, startedAt: writeSlotAt(0) })).toBe(true);
    register(CREATE_SCENARIO_ID, 0, 'rec-2');
    register(CREATE_SCENARIO_ID, 1, 'rec-1');
    // ほかの CREATE のシナリオの、同じ ID の登録（UPDATE は数えない）。
    register(OTHER_CREATE_SCENARIO_ID, 2, 'rec-1');
    // 送らずに止めた回（入らない）と、送ったか分からない回（ID なしで入る）。
    seedWriteResultForTest(database, {
      profileId: GRANT_PROFILE_ID, scenarioId: CREATE_SCENARIO_ID, scenarioRevision: revisionOf(CREATE_SCENARIO_ID), grantId: 'grant-c3', jobId: 'job-c3',
      external: EXTERNAL, at: writeSlotAt(3), submittedValues: { name: 'サンプル 止めた' },
      report: { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', httpStatus: null, responseJudgement: null, recordId: null, readVerification: null,
        submittedAt: null },
    });
    const unknown = issueExecutionGrant(database, {
      scenarioId: CREATE_SCENARIO_ID, expectedRevision: revisionOf(CREATE_SCENARIO_ID), grantId: 'grant-c4', jobId: 'job-c4', count: 1, external: EXTERNAL,
      at: writeSlotAt(4),
    });
    expect(unknown.ok).toBe(true);
    expect(consumeExecutionGrant(database, {
      grantId: 'grant-c4', scenarioId: CREATE_SCENARIO_ID, scenarioRevision: revisionOf(CREATE_SCENARIO_ID), jobId: 'job-c4', profileId: GRANT_PROFILE_ID,
      external: EXTERNAL, at: writeSlotAt(4),
    }).ok).toBe(true);
    expect(unknown.ok && settleWriteForTest(database, {
      grantId: 'grant-c4', jobId: 'job-c4', reservationId: unknown.grant.reservation.reservationId, to: 'UNKNOWN', at: writeSlotAt(4),
    })).toBe(true);
    // UPDATE は、参照した CREATE のシナリオの最新の登録（rec-1）に 2 回。最後は結果が分からない。
    expect(readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID)).toBe('rec-1');
    update(5, 'rec-1', 'VERIFIED');
    update(6, 'rec-1', 'UNKNOWN');

    const ledger = readAuditedDataLedger(database, GRANT_PROFILE_ID);
    expect(ledger.map(({ jobId, scenarioId, recordId }) => [jobId, scenarioId, recordId])).toEqual([
      ['job-c4', CREATE_SCENARIO_ID, null],
      ['job-c2', OTHER_CREATE_SCENARIO_ID, 'rec-1'],
      ['job-c1', CREATE_SCENARIO_ID, 'rec-1'],
      ['job-c0', CREATE_SCENARIO_ID, 'rec-2'],
    ]);
    const byJob = new Map(ledger.map((entry) => [entry.jobId, entry]));
    expect(byJob.get('job-c1')).toEqual({
      jobId: 'job-c1',
      runId: null,
      grantId: 'grant-c1',
      scenarioId: CREATE_SCENARIO_ID,
      scenarioRevision: revisionOf(CREATE_SCENARIO_ID),
      recordId: 'rec-1',
      seed: { executionGrantId: 'grant-c1', ruleSetDigest: RULE_SET_DIGEST },
      submission: 'SENT',
      result: 'VERIFIED',
      readVerification: 'MATCHED',
      reservationState: 'COMMITTED',
      recordedAt: writeSlotAt(1),
      submittedAt: writeSlotAt(1),
      updates: { count: 2, last: { jobId: 'job-u6', result: 'UNKNOWN', recordedAt: writeSlotAt(6) } },
    });
    expect(byJob.get('job-c0')).toMatchObject({ runId: RUN_ID, recordId: 'rec-2', updates: { count: 0, last: null } });
    expect(byJob.get('job-c2')).toMatchObject({ recordId: 'rec-1', updates: { count: 0, last: null } });
    expect(byJob.get('job-c4')).toMatchObject({ submission: 'UNKNOWN', result: 'UNKNOWN', recordId: null, updates: { count: 0, last: null } });
    // seed の値・基準日・試行の番号は返さない。
    expect(JSON.stringify(ledger)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(ledger)).not.toContain('baseDate');
    // 凍結した値。読むだけ（2 回読んでも同じ）。
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(readAuditedDataLedger(database, GRANT_PROFILE_ID)).toEqual(ledger);
  });

  it('counts only the UPDATE writes that may have been sent (not NOT_SENT), as with the CREATE rows (T32R M-1)', () => {
    register(CREATE_SCENARIO_ID, 0, 'rec-1');
    expect(readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID)).toBe('rec-1');
    /** 送らずに止めた UPDATE を 1 回（結果は `BLOCKED`。回数にも最後の結果にも入らない）。 */
    const blockedUpdate = (slot: number): void => {
      seedWriteResultForTest(database, {
        profileId: GRANT_PROFILE_ID, scenarioId: UPDATE_SCENARIO_ID, scenarioRevision: revisionOf(UPDATE_SCENARIO_ID), grantId: `grant-u${String(slot)}`,
        jobId: `job-u${String(slot)}`, external: EXTERNAL, at: writeSlotAt(slot), submittedValues: { name: `止めた ${String(slot)}` },
        expectedTargetRecordId: 'rec-1',
        report: { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED', httpStatus: null, responseJudgement: null, recordId: null, readVerification: null,
          submittedAt: null, updateEvidence: null },
      });
    };
    update(1, 'rec-1', 'VERIFIED');
    blockedUpdate(2);
    // 送ったか分からない回は入る。
    update(3, 'rec-1', 'UNKNOWN');
    // 最後の回が送らずに止めた回でも、最後の結果は送ったかもしれない回のまま。
    blockedUpdate(4);

    const ledger = readAuditedDataLedger(database, GRANT_PROFILE_ID);
    expect(ledger.map(({ jobId }) => jobId)).toEqual(['job-c0']);
    expect(ledger[0]?.updates).toEqual({ count: 2, last: { jobId: 'job-u3', result: 'UNKNOWN', recordedAt: writeSlotAt(3) } });
  });
});
