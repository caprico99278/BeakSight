// T28R-fix-1（独立レビュー T28R の M-3）: 確かめの途中の発見の記録。シナリオの作成・承認と、実行の許可の発行・消費は、書くトランザクションの前に
// 最後の発見の索引を読み（`discoverySnapshotOf`）、トランザクションの中で「その後に発見のジョブが記録されていない」ことを確かめ直す。間に記録
// されたら、`SCENARIO_FACTS_CHANGED`・`GRANT_FACTS_CHANGED` で拒み、何も書かない。
// - テストだけの差し込み: `scenario-facts.ts` の `discoverySnapshotOf` を包み、読んだ直後に（トランザクションの前に）発見のジョブを 1 つ記録する
//   （本番のコードに差し込みの口は作らない）。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveScenario,
  consumeExecutionGrant,
  createScenario,
  issueExecutionGrant,
  readApprovalReceipts,
  readExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  type ScenarioStoreResult,
} from '../../src/control/approval/scenario-store.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { mergeDiscoveryCandidates } from '../../src/discovery/discovery-result.js';
import { ALL_CONFIRMED, CREATE_CANDIDATE, UPDATE_CANDIDATE } from '../unit/approval-samples.js';
import { EXTERNAL, GRANT_PROFILE_ID, ISSUED_AT, prepareGrantProfile, prepareScenario } from './execution-grant-fixtures.js';

/** 索引を読んだ直後に動かす差し込み（null なら何もしない）。 */
const hooks = vi.hoisted(() => ({ afterSnapshot: null as (() => void) | null }));

vi.mock('../../src/control/approval/scenario-facts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/control/approval/scenario-facts.js')>();
  return {
    ...actual,
    discoverySnapshotOf: (...args: Parameters<typeof actual.discoverySnapshotOf>) => {
      const snapshot = actual.discoverySnapshotOf(...args);
      const hook = hooks.afterSnapshot;
      hooks.afterSnapshot = null;
      hook?.();
      return snapshot;
    },
  };
});

let workDirectory = '';
let database: ControlDatabase;
let latest: ReturnType<typeof prepareGrantProfile>;

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-approval-facts-changed-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  latest = prepareGrantProfile(database);
  hooks.afterSnapshot = null;
});

afterEach(() => {
  hooks.afterSnapshot = null;
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

/** 次の索引の読み出しの直後に、発見のジョブを 1 つ記録する。 */
const recordDiscoveryAfterNextSnapshot = (jobId: string, at: string): void => {
  hooks.afterSnapshot = () => {
    recordDiscoveryCandidates(database, {
      profileId: GRANT_PROFILE_ID, jobId, at, entries: mergeDiscoveryCandidates([CREATE_CANDIDATE, UPDATE_CANDIDATE]).map(discoveryIndexEntryOf),
      readPagePaths: ['/members/new'],
    });
  };
};

const reasonOf = (result: ScenarioStoreResult): string | null => (result.ok ? null : result.reason);

describe('facts changed during the checks (T28R-fix-1, M-3)', () => {
  it('rejects the creation of a scenario with SCENARIO_FACTS_CHANGED and writes nothing', () => {
    recordDiscoveryAfterNextSnapshot('job-race-1', '20261012000500');
    const created = createScenario(database, {
      scenarioId: 'scenario-race',
      draft: {
        profileId: GRANT_PROFILE_ID, candidateIdentityDigest: CREATE_CANDIDATE.identityDigest, fieldNames: ['name', 'plan'], readChecks: [],
        sideEffectConfirmations: ALL_CONFIRMED, limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 }, approvalTtlDays: 30,
      },
      discovery: latest,
      at: '20261012010000',
    });
    expect(reasonOf(created)).toBe('SCENARIO_FACTS_CHANGED');
    expect(readScenario(database, 'scenario-race')).toBeNull();
  });

  it('rejects the approval with SCENARIO_FACTS_CHANGED and writes no receipt', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1', { approve: false });
    const status = readScenarioApprovalStatus(database, 'scenario-1', EXTERNAL, new Date(Date.parse('2026-10-12T02:00:00Z')));
    recordDiscoveryAfterNextSnapshot('job-race-2', '20261012015000');
    const approved = approveScenario(database, {
      scenarioId: 'scenario-1', expectedRevision: scenario.revision, expectedApprovalDigest: status?.approvalDigest ?? '', receiptId: 'receipt-1',
      external: EXTERNAL, at: '20261012020000',
    });
    expect(reasonOf(approved)).toBe('SCENARIO_FACTS_CHANGED');
    expect(readApprovalReceipts(database, 'scenario-1')).toEqual([]);
  });

  it('rejects the issue and the consumption of a grant with GRANT_FACTS_CHANGED and writes nothing', () => {
    const scenario = prepareScenario(database, latest, 'scenario-1');
    recordDiscoveryAfterNextSnapshot('job-race-3', '20261012025000');
    const rejected = issueExecutionGrant(database, {
      scenarioId: 'scenario-1', expectedRevision: scenario.revision, grantId: 'grant-1', jobId: 'job-w1', count: 1, external: EXTERNAL, at: ISSUED_AT,
    });
    expect(rejected.ok ? null : rejected.reason).toBe('GRANT_FACTS_CHANGED');
    expect(readExecutionGrant(database, 'grant-1')).toBeNull();

    const issued = issueExecutionGrant(database, {
      scenarioId: 'scenario-1', expectedRevision: scenario.revision, grantId: 'grant-2', jobId: 'job-w2', count: 1, external: EXTERNAL, at: ISSUED_AT,
    });
    expect(issued.ok).toBe(true);
    recordDiscoveryAfterNextSnapshot('job-race-4', '20261012030000');
    const consumed = consumeExecutionGrant(database, {
      grantId: 'grant-2', scenarioId: 'scenario-1', scenarioRevision: scenario.revision, jobId: 'job-w2', profileId: GRANT_PROFILE_ID,
      external: EXTERNAL, at: '20261012030100',
    });
    expect(consumed.ok ? null : consumed.reason).toBe('GRANT_FACTS_CHANGED');
    expect(readExecutionGrant(database, 'grant-2')?.consumedAt).toBeNull();
  });
});
