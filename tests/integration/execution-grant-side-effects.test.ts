// MI-F1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.7.1 の 5。独立レビュー MI-R の Minor 7）: 実行の許可の発行と、書き込みの
// 開始（許可の消費）と、書き込みの要求の前の確かめ直しは、承認の不変条件に頼らず、シナリオの今の版の副作用の確認を直接見る。確認の済んでいない版なら、
// 承認が有効に見えても許可を出さない・始めない（`SCENARIO_SIDE_EFFECTS_UNCONFIRMED`）。
// 承認の口は確認のない版を承認しないので、ここでは、承認した後の版の文書と承認の記録の digest を、テストだけの操作で書き換えて、確認のない版が承認済みに見える
// 管理データを作る（多重の守りの確かめ）。一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertGrantStillValid,
  consumeExecutionGrant,
  issueExecutionGrant,
  readScenarioApprovalStatus,
} from '../../src/control/approval/scenario-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { EXTERNAL, ISSUED_AT, prepareGrantProfile, prepareScenario } from './execution-grant-fixtures.js';

const SCENARIO_ID = 'scenario-1';
const CONSUMED_AT = '20261012030100';
const STATUS_AT = new Date(Date.parse('2026-10-12T03:00:00Z'));
const UNCONFIRMED = 'SCENARIO_SIDE_EFFECTS_UNCONFIRMED';

let workDirectory = '';
let database: ControlDatabase;

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-grant-side-effects-'));
  database = openControlDatabase(databasePath());
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

/**
 * テストだけの操作: 承認した版の副作用の確認を 1 つ外し、承認の記録の digest を、その版の今の digest に書き換える（承認の判定からは、確認のない版が
 * 承認済みに見える）。
 */
const forgeUnconfirmedApprovedRevision = (): void => {
  const revision = readScenarioApprovalStatus(database, SCENARIO_ID, EXTERNAL, STATUS_AT)?.scenario.revision ?? 0;
  closeControlDatabase(database);
  const raw = new DatabaseSync(databasePath());
  try {
    const row = raw.prepare('SELECT document FROM scenario_revisions WHERE scenario_id = ? AND revision = ?').get(SCENARIO_ID, revision) as { readonly document: string };
    const document = JSON.parse(row.document) as { sideEffectConfirmations: Record<string, boolean> };
    document.sideEffectConfirmations = { ...document.sideEffectConfirmations, NO_EXTERNAL_NOTIFICATION: false };
    raw.prepare('UPDATE scenario_revisions SET document = ? WHERE scenario_id = ? AND revision = ?').run(JSON.stringify(document), SCENARIO_ID, revision);
  } finally {
    raw.close();
  }
  database = openControlDatabase(databasePath());
  const digest = readScenarioApprovalStatus(database, SCENARIO_ID, EXTERNAL, STATUS_AT)?.approvalDigest ?? '';
  closeControlDatabase(database);
  const again = new DatabaseSync(databasePath());
  try {
    const receipt = again.prepare("SELECT receipt_id, document FROM approval_receipts WHERE scenario_id = ? AND kind = 'APPROVAL'").get(SCENARIO_ID) as {
      readonly receipt_id: string;
      readonly document: string;
    };
    const document = { ...(JSON.parse(receipt.document) as Record<string, unknown>), approvalDigest: digest };
    again.prepare('UPDATE approval_receipts SET approval_digest = ?, document = ? WHERE receipt_id = ?').run(digest, JSON.stringify(document), receipt.receipt_id);
  } finally {
    again.close();
  }
  database = openControlDatabase(databasePath());
};

const issue = () => {
  const revision = readScenarioApprovalStatus(database, SCENARIO_ID, EXTERNAL, STATUS_AT)?.scenario.revision ?? 1;
  return issueExecutionGrant(database, {
    scenarioId: SCENARIO_ID, expectedRevision: revision, grantId: 'grant-1', jobId: 'job-w1', count: 1, external: EXTERNAL, at: ISSUED_AT,
  });
};

describe('MI-F1: the grant issue and the write start look at the side effect confirmations directly', () => {
  it('the forged revision looks approved to the approval check (the premise of the test)', () => {
    prepareScenario(database, prepareGrantProfile(database), SCENARIO_ID);
    forgeUnconfirmedApprovedRevision();
    const status = readScenarioApprovalStatus(database, SCENARIO_ID, EXTERNAL, STATUS_AT);
    expect(status?.validity.approved).toBe(true);
    expect(status?.scenario.current.sideEffectConfirmations.NO_EXTERNAL_NOTIFICATION).toBe(false);
  });

  it('does not issue a grant for an approved revision whose side effects are not confirmed', () => {
    prepareScenario(database, prepareGrantProfile(database), SCENARIO_ID);
    forgeUnconfirmedApprovedRevision();
    expect(issue()).toMatchObject({ ok: false, reason: UNCONFIRMED });
  });

  it('does not start the write (consume) nor pass the recheck for a grant whose revision lost the side effect confirmations', () => {
    prepareScenario(database, prepareGrantProfile(database), SCENARIO_ID);
    const issued = issue();
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const consumption = {
      grantId: issued.grant.grantId,
      scenarioId: issued.grant.scenarioId,
      scenarioRevision: issued.grant.scenarioRevision,
      jobId: issued.grant.jobId,
      profileId: issued.grant.profileId,
      external: EXTERNAL,
    };
    forgeUnconfirmedApprovedRevision();
    expect(consumeExecutionGrant(database, { ...consumption, at: CONSUMED_AT })).toMatchObject({ ok: false, reason: UNCONFIRMED });
    expect(assertGrantStillValid(database, { ...consumption, now: new Date(Date.parse('2026-10-12T03:02:00Z')) }))
      .toMatchObject({ ok: false });
  });
});
