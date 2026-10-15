// T28f（Task 28 の設計書 8 章の G28「承認の保存・再起動の後の再利用・撤回ができ、承認の記録は書き換えられない」）: 承認の保存 → 管理データを開き直す
// （画面のサーバの再起動に当たる）→ 承認が有効のまま読め、実行の許可を出せる → 開き直す → 撤回 → 開き直す → 許可の発行が拒まれ、撤回の前に出した
// 許可は無効で予約は返っている、を `src/control/approval/scenario-store.ts` の公開の口だけで、続けて確かめる。
// - 既存のテストとの分け方: `scenario-store.test.ts` の「開き直した後」は承認を読むまで、`execution-grant-store.test.ts` の撤回と発行の拒否は開き直しを
//   挟まない、「消費と予約の状態が残る」は許可だけ。ここでは、開き直しを挟んだ一続きの流れ（承認 → 再利用 → 撤回 → 拒否）だけを確かめる。
// - 承認の記録は追記だけ: 撤回の後も、承認の記録は開き直しの前と同じ内容のまま読め、撤回の記録が後ろに足される。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  issueExecutionGrant,
  readApprovalReceipts,
  readExecutionGrant,
  readScenarioApprovalStatus,
  readWriteReservations,
  revokeScenarioApproval,
} from '../../src/control/approval/scenario-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { APPROVED_AT, EXTERNAL, ISSUED_AT, prepareGrantProfile, prepareScenario } from './execution-grant-fixtures.js';

/** 撤回の時刻（許可の発行の後、許可の期限の前）。 */
const REVOKED_AT = '20261012030200';
/** 撤回の後に発行を試す時刻。 */
const AFTER_REVOCATION_AT = '20261012030300';
/** 承認の期限の中の、今の時刻（承認の状態を読むとき）。 */
const NOW_IN_TTL = new Date(Date.parse('2026-10-12T03:01:00Z'));
const SCENARIO_ID = 'scenario-reopen';
const RECEIPT_ID = 'receipt-reopen';

let workDirectory = '';
let database: ControlDatabase;

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

/** 管理データを閉じて開き直す（画面のサーバの再起動に当たる）。 */
const reopen = (): void => {
  closeControlDatabase(database);
  database = openControlDatabase(databasePath());
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-approval-reopen-'));
  database = openControlDatabase(databasePath());
});

afterEach(() => {
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('scenario approval (T28f): G28 across reopening the control data', () => {
  it('keeps the approval valid after reopening, issues a grant, and after a revocation and another reopening rejects the issue', () => {
    const latest = prepareGrantProfile(database);
    const scenario = prepareScenario(database, latest, SCENARIO_ID, { receiptId: RECEIPT_ID });
    expect(scenario.state).toBe('APPROVED');
    const receiptsBefore = readApprovalReceipts(database, SCENARIO_ID);
    expect(receiptsBefore).toEqual([expect.objectContaining({ kind: 'APPROVAL', receiptId: RECEIPT_ID, approvedAt: APPROVED_AT })]);

    // 開き直した後も、承認は有効のまま読める（同じ記録、同じ判定）。
    reopen();
    expect(readApprovalReceipts(database, SCENARIO_ID)).toEqual(receiptsBefore);
    const status = readScenarioApprovalStatus(database, SCENARIO_ID, EXTERNAL, NOW_IN_TTL);
    expect(status?.scenario).toMatchObject({ revision: scenario.revision, state: 'APPROVED', lastApprovalReceiptId: RECEIPT_ID });
    expect(status?.validity).toMatchObject({ approved: true, receiptId: RECEIPT_ID });

    // 開き直した後の承認で、実行の許可を出せる（承認の再利用）。
    const issued = issueExecutionGrant(database, {
      scenarioId: SCENARIO_ID, expectedRevision: scenario.revision, grantId: 'grant-reopen-1', jobId: 'job-reopen-1', count: 1, external: EXTERNAL, at: ISSUED_AT,
    });
    expect(issued.ok && issued.grant).toMatchObject({ approvalReceiptId: RECEIPT_ID, consumedAt: null, invalidatedAt: null, reservation: { state: 'RESERVED' } });

    // 開き直してから撤回する。
    reopen();
    expect(revokeScenarioApproval(database, { scenarioId: SCENARIO_ID, expectedRevision: scenario.revision, receiptId: 'revoke-reopen', at: REVOKED_AT }).ok)
      .toBe(true);

    // もう一度開き直しても、撤回は残り、許可の発行は拒まれる。撤回の前の許可は無効で、予約は返っている。
    reopen();
    const revoked = readScenarioApprovalStatus(database, SCENARIO_ID, EXTERNAL, NOW_IN_TTL);
    expect(revoked?.scenario.state).toBe('REVOKED');
    expect(revoked?.validity).toEqual({ approved: false, reasons: ['REVOKED'] });
    const rejected = issueExecutionGrant(database, {
      scenarioId: SCENARIO_ID, expectedRevision: scenario.revision, grantId: 'grant-reopen-2', jobId: 'job-reopen-2', count: 1, external: EXTERNAL,
      at: AFTER_REVOCATION_AT,
    });
    expect(rejected.ok ? null : [rejected.reason, rejected.invalidityReasons]).toEqual(['GRANT_APPROVAL_INVALID', ['REVOKED']]);
    expect(readExecutionGrant(database, 'grant-reopen-2')).toBeNull();
    expect(readExecutionGrant(database, 'grant-reopen-1')).toMatchObject({
      consumedAt: null, invalidatedAt: REVOKED_AT, reservation: { state: 'RELEASED', settledAt: REVOKED_AT },
    });
    expect(readWriteReservations(database, SCENARIO_ID).map(({ state }) => state)).toEqual(['RELEASED']);

    // 承認の記録は追記だけ（承認の記録は前と同じ内容のまま、撤回の記録が後ろに足される）。
    const receiptsAfter = readApprovalReceipts(database, SCENARIO_ID);
    expect(receiptsAfter.slice(0, receiptsBefore.length)).toEqual(receiptsBefore);
    expect(receiptsAfter.slice(receiptsBefore.length)).toEqual([
      expect.objectContaining({ kind: 'REVOCATION', receiptId: 'revoke-reopen', targetReceiptId: RECEIPT_ID, revokedAt: REVOKED_AT }),
    ]);
  });
});
