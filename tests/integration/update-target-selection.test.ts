// T31e（Task 31 の設計書 2 章のユーザーの判断 4・5、3 章の「対象の選び方」「対象にできるレコード」「記録」）: UPDATE の対象の自動の選択と、実行の許可への
// 結び付けの結合テスト（管理データの版 9）。
// - 対象は、参照した CREATE のシナリオの `VERIFIED` の登録のうち、登録の時刻が最も新しい 1 件。`VERIFIED` でない登録は対象にしない。外すレコードは
//   なく、前の UPDATE の結果（`UNKNOWN` を含む）によらず、同じレコードを選ぶ。
// - 画面のための読むだけの口（`readPlannedUpdateTarget`）が予定の ID を返し、発行は同じトランザクションの中で選び直して照らす（違えば
//   `TARGET_SELECTION_CHANGED`、対象がなければ `TARGET_RECORD_UNAVAILABLE`。どちらも何も書かない）。選んだ ID は許可に結び、許可を読む口が返す。
// - T31R-fix-1 の I-2: 発行は、path の型の `{id}` の位置が、参照した CREATE のシナリオの今の登録の ID の取り方に結び付くかを確かめ直す（下書きの
//   保存の後に台帳の取り方が変わったら、`SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID` で拒み、何も書かない）。
// - 再起動（データベースを開き直す）の後も、許可の対象の ID は残る。2 つの process が同時に UPDATE の発行を争っても、許可は 1 つで、対象は最新の 1 件。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeExecutionGrant,
  issueExecutionGrant,
  readExecutionGrant,
  readPlannedUpdateTarget,
  readScenario,
  updateScenario,
  type ExecutionGrantResult,
} from '../../src/control/approval/scenario-store.js';
import type { ScenarioRecordIdSpec } from '../../src/control/approval/scenario-contracts.js';
import { readPlannedUpdateTarget as readPlannedUpdateTargetOfView } from '../../src/control/approval-view.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { spawnTypeScriptChild } from './control-profile-fixtures.js';
import { ALL_CONFIRMED, CREATE_CANDIDATE, UPDATE_CANDIDATE } from '../unit/approval-samples.js';
import {
  DISCOVERY_JOB_ID,
  EXTERNAL,
  GRANT_CHILD_PROTOCOL,
  GRANT_PROFILE_ID,
  prepareGrantProfile,
  prepareScenario,
  prepareUpdateScenario,
  recordUpdateWriteForTest,
  registerVerifiedForTest,
  settleWriteForTest,
  VERIFICATION_SPEC,
  discoveryDocumentOf,
  writeSlotAt,
} from './execution-grant-fixtures.js';

const CHILD_MODULE_URL = new URL('./execution-grant-child.ts', import.meta.url).href;
const PROCESS_TEST_TIMEOUT_MS = 60_000;
const CREATE_SCENARIO_ID = 'scenario-create';
const UPDATE_SCENARIO_ID = 'scenario-update';

let workDirectory = '';
let database: ControlDatabase;
const children: ChildProcessWithoutNullStreams[] = [];

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-update-target-'));
  database = openControlDatabase(databasePath());
  const latest = prepareGrantProfile(database);
  prepareScenario(database, latest, CREATE_SCENARIO_ID);
  prepareUpdateScenario(database, latest, UPDATE_SCENARIO_ID, CREATE_SCENARIO_ID);
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

/** CREATE のシナリオの照合まで済んだ登録を、`slot` 回目の時刻で 1 件作る。 */
const register = (slot: number, recordId: string): void => {
  expect(registerVerifiedForTest(database, {
    createScenarioId: CREATE_SCENARIO_ID, grantId: `grant-c${slot}`, jobId: `job-c${slot}`, recordId, at: writeSlotAt(slot),
  })).toBe(true);
};

/** UPDATE の発行（予定の ID と時刻）。 */
/** シナリオの今の版（入力の規則の参照を付けると版が進む）。 */
const revisionOf = (scenarioId: string): number => readScenario(database, scenarioId)?.revision ?? 0;

const issueUpdate = (grantId: string, expectedTargetRecordId: string | null, at: string): ExecutionGrantResult => issueExecutionGrant(database, {
  scenarioId: UPDATE_SCENARIO_ID, expectedRevision: revisionOf(UPDATE_SCENARIO_ID), grantId, jobId: `job-${grantId}`, count: 1, expectedTargetRecordId, external: EXTERNAL, at,
});

const reasonOf = (result: ExecutionGrantResult): string | null => (result.ok ? null : result.reason);

describe('T31e: the automatic choice of the update target', () => {
  it('has no target and issues no grant before a verified registration (TARGET_RECORD_UNAVAILABLE)', () => {
    expect(readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID)).toBeNull();
    expect(reasonOf(issueUpdate('grant-u1', null, writeSlotAt(1)))).toBe('TARGET_RECORD_UNAVAILABLE');
    expect(readExecutionGrant(database, 'grant-u1')).toBeNull();
  });

  it('chooses the latest verified registration, binds it to the grant, and the grant reader returns it', () => {
    register(0, 'rec-1');
    register(1, 'rec-2');
    expect(readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID)).toBe('rec-2');
    // 画面のための口は、画面向けの公開し直し（`approval-view.ts`）からも同じ値を返す。
    expect(readPlannedUpdateTargetOfView(database, UPDATE_SCENARIO_ID)).toBe('rec-2');
    // CREATE のシナリオには予定の ID がない。
    expect(readPlannedUpdateTarget(database, CREATE_SCENARIO_ID)).toBeNull();
    const issued = issueUpdate('grant-u1', 'rec-2', writeSlotAt(2));
    expect(issued.ok ? issued.grant.targetRecordId : reasonOf(issued)).toBe('rec-2');
    expect(readExecutionGrant(database, 'grant-u1')?.targetRecordId).toBe('rec-2');
    // CREATE の許可は対象を持たない。
    expect(readExecutionGrant(database, 'grant-c0')?.targetRecordId).toBeNull();
  });

  it('stops when the choice differs from the planned id (TARGET_SELECTION_CHANGED), and writes nothing', () => {
    register(0, 'rec-1');
    const planned = readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID);
    expect(planned).toBe('rec-1');
    // 画面を開いた後に、新しい登録があった。
    register(1, 'rec-2');
    expect(reasonOf(issueUpdate('grant-u1', planned, writeSlotAt(2)))).toBe('TARGET_SELECTION_CHANGED');
    expect(reasonOf(issueUpdate('grant-u2', null, writeSlotAt(2)))).toBe('TARGET_SELECTION_CHANGED');
    expect(readExecutionGrant(database, 'grant-u1')).toBeNull();
    expect(readExecutionGrant(database, 'grant-u2')).toBeNull();
    expect(issueUpdate('grant-u3', 'rec-2', writeSlotAt(2)).ok).toBe(true);
  });

  it('does not choose a registration that is not VERIFIED', () => {
    register(0, 'rec-1');
    // 新しい登録が `FAILED`（入力の誤り。テストだけの締め）で終わった。
    const issued = issueExecutionGrant(database, {
      scenarioId: CREATE_SCENARIO_ID, expectedRevision: revisionOf(CREATE_SCENARIO_ID), grantId: 'grant-c1', jobId: 'job-c1', count: 1,
      external: EXTERNAL, at: writeSlotAt(1),
    });
    expect(issued.ok).toBe(true);
    if (issued.ok) {
      expect(consumeExecutionGrant(database, {
        grantId: 'grant-c1', scenarioId: CREATE_SCENARIO_ID, scenarioRevision: revisionOf(CREATE_SCENARIO_ID), jobId: 'job-c1', profileId: GRANT_PROFILE_ID, external: EXTERNAL,
        at: writeSlotAt(1),
      }).ok).toBe(true);
      expect(settleWriteForTest(database, {
        grantId: 'grant-c1', jobId: 'job-c1', reservationId: issued.grant.reservation.reservationId, to: 'COMMITTED', at: writeSlotAt(1),
      })).toBe(true);
    }
    expect(readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID)).toBe('rec-1');
  });

  it('chooses the same record again after an UNKNOWN update (no record is excluded)', () => {
    register(0, 'rec-1');
    const first = issueUpdate('grant-u1', 'rec-1', writeSlotAt(1));
    expect(first.ok).toBe(true);
    expect(consumeExecutionGrant(database, {
      grantId: 'grant-u1', scenarioId: UPDATE_SCENARIO_ID, scenarioRevision: revisionOf(UPDATE_SCENARIO_ID), jobId: 'job-grant-u1', profileId: GRANT_PROFILE_ID, external: EXTERNAL,
      at: writeSlotAt(1),
    }).ok).toBe(true);
    const settled = recordUpdateWriteForTest(database, {
      grantId: 'grant-u1', jobId: 'job-grant-u1', submittedValues: { name: 'サンプル 更新' }, at: writeSlotAt(1), outcome: 'UNKNOWN', recordId: null,
      updateEvidence: null,
    });
    expect(settled.ok ? settled.result.result : settled.reason).toBe('UNKNOWN');
    expect(readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID)).toBe('rec-1');
    const second = issueUpdate('grant-u2', 'rec-1', writeSlotAt(2));
    expect(second.ok ? second.grant.targetRecordId : reasonOf(second)).toBe('rec-1');
  });

  it('rejects a planned id for a CREATE scenario and a planned id that is not a usable record id, with RangeError', () => {
    register(0, 'rec-1');
    expect(() => issueExecutionGrant(database, {
      scenarioId: CREATE_SCENARIO_ID, expectedRevision: revisionOf(CREATE_SCENARIO_ID), grantId: 'grant-c9', jobId: 'job-c9', count: 1, expectedTargetRecordId: 'rec-1',
      external: EXTERNAL, at: writeSlotAt(1),
    })).toThrow(RangeError);
    expect(() => issueUpdate('grant-u1', '../rec-1', writeSlotAt(1))).toThrow(RangeError);
    expect(readExecutionGrant(database, 'grant-c9')).toBeNull();
  });

  it('keeps the target of the grant after a restart', () => {
    register(0, 'rec-1');
    expect(issueUpdate('grant-u1', 'rec-1', writeSlotAt(1)).ok).toBe(true);
    closeControlDatabase(database);
    database = openControlDatabase(databasePath());
    expect(readExecutionGrant(database, 'grant-u1')?.targetRecordId).toBe('rec-1');
    expect(readPlannedUpdateTarget(database, UPDATE_SCENARIO_ID)).toBe('rec-1');
  });
});

describe('T31e: the choice and the binding in one transaction between two processes', () => {
  /** 子 process 1 つ（標準出力の行を順に読む）。 */
  const startChild = (tag: string): { readonly child: ChildProcessWithoutNullStreams; readonly nextLine: () => Promise<string>; readonly exited: Promise<number | null> } => {
    const child = spawnTypeScriptChild(CHILD_MODULE_URL, [GRANT_CHILD_PROTOCOL.updateIssueMode, databasePath(), UPDATE_SCENARIO_ID, tag]);
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });
    return {
      child,
      exited,
      nextLine: async () => {
        const next = await lines.next();
        if (next.done === true) {
          throw new Error(`the child ended without a line: ${stderr}`);
        }
        return next.value;
      },
    };
  };

  it('issues one grant bound to the latest registration when two processes issue at the same time', async () => {
    register(0, 'rec-1');
    register(1, 'rec-2');
    const handles = [startChild('a'), startChild('b')];
    for (const handle of handles) {
      expect(await handle.nextLine()).toBe(GRANT_CHILD_PROTOCOL.ready);
    }
    for (const handle of handles) {
      handle.child.stdin.write(`${GRANT_CHILD_PROTOCOL.go}\n`);
    }
    const results: Record<string, number>[] = [];
    for (const handle of handles) {
      const line = await handle.nextLine();
      expect(line.startsWith(`${GRANT_CHILD_PROTOCOL.done} `)).toBe(true);
      results.push(JSON.parse(line.slice(GRANT_CHILD_PROTOCOL.done.length + 1)) as Record<string, number>);
      expect(await handle.exited).toBe(0);
    }
    expect(results.reduce((sum, result) => sum + (result['ISSUED'] ?? 0), 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + (result['TARGET:rec-2'] ?? 0), 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + (result['GRANT_ALREADY_OPEN'] ?? 0), 0)).toBe(1);
    const grants = ['grant-a-0', 'grant-b-0'].flatMap((grantId) => {
      const grant = readExecutionGrant(database, grantId);
      return grant === null ? [] : [grant];
    });
    expect(grants.map(({ targetRecordId }) => targetRecordId)).toEqual(['rec-2']);
  }, PROCESS_TEST_TIMEOUT_MS);
});

// T31R-fix-1 の I-2（Task 31 の設計書 11 章の T31R の行）: 下書きの保存の後に、台帳（参照した CREATE のシナリオ）の登録の ID の取り方が変わった場面。
describe('T31R-fix-1 I-2: the issue checks the record id segment of the templates against the current ledger', () => {
  /** 台帳の登録の ID の取り方を変えて保存し直す（テストだけ。版が進む。UPDATE の発行は台帳の承認を求めない）。 */
  const changeLedgerRecordId = (recordId: ScenarioRecordIdSpec, at: string): void => {
    const ledger = readScenario(database, CREATE_SCENARIO_ID);
    if (ledger === null) {
      throw new Error('the ledger scenario is missing');
    }
    const changed = updateScenario(database, {
      scenarioId: CREATE_SCENARIO_ID,
      expectedRevision: ledger.revision,
      draft: {
        profileId: GRANT_PROFILE_ID,
        candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
        fieldNames: [...ledger.current.fieldNames],
        readChecks: [],
        sideEffectConfirmations: ALL_CONFIRMED,
        limits: { ...ledger.current.limits },
        approvalTtlDays: ledger.current.approvalTtlDays,
        verification: { ...VERIFICATION_SPEC, recordId },
      },
      discovery: discoveryDocumentOf(DISCOVERY_JOB_ID, [CREATE_CANDIDATE, UPDATE_CANDIDATE]),
      at,
    });
    expect(changed.ok).toBe(true);
  };

  it('rejects the issue after the ledger takes the record id from another segment, writes nothing, and issues again when it is bound', () => {
    register(0, 'rec-1');
    // 台帳の型 `/items/{id}` の `{id}` の前の区切り（`items`）は、UPDATE の送信先の型 `/members/{id}` の前の区切り（`members`）と違う。
    changeLedgerRecordId({ source: 'URL_PATH_PATTERN', pathPattern: '/items/{id}' }, writeSlotAt(1));
    expect(reasonOf(issueUpdate('grant-u1', 'rec-1', writeSlotAt(1)))).toBe('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
    expect(readExecutionGrant(database, 'grant-u1')).toBeNull();
    // 要素から取る取り方は、送信先の型の `{id}` が最後の区切りなら結び付く。
    changeLedgerRecordId({ source: 'ELEMENT', selector: '#record-id' }, writeSlotAt(2));
    const issued = issueUpdate('grant-u2', 'rec-1', writeSlotAt(2));
    expect(issued.ok ? issued.grant.targetRecordId : reasonOf(issued)).toBe('rec-1');
  });
});

// T31R2-fix-1 の I-1: 台帳の取り方を後で変えた後の発行の拒否を、`{id}` の後ろの並びと、前の並び全体の比べでも確かめる（T31R2 の例と同じ形）。
describe('T31R2-fix-1 I-1: the issue checks the segments after {id} and all the segments before {id} against the current ledger', () => {
  /** 台帳の登録の ID の取り方を変えて保存し直す（テストだけ。版が進む）。 */
  const changeLedgerPattern = (pathPattern: string): void => {
    const ledger = readScenario(database, CREATE_SCENARIO_ID);
    if (ledger === null) {
      throw new Error('the ledger scenario is missing');
    }
    expect(updateScenario(database, {
      scenarioId: CREATE_SCENARIO_ID,
      expectedRevision: ledger.revision,
      draft: {
        profileId: GRANT_PROFILE_ID,
        candidateIdentityDigest: CREATE_CANDIDATE.identityDigest,
        fieldNames: [...ledger.current.fieldNames],
        readChecks: [],
        sideEffectConfirmations: ALL_CONFIRMED,
        limits: { ...ledger.current.limits },
        approvalTtlDays: ledger.current.approvalTtlDays,
        verification: { ...VERIFICATION_SPEC, recordId: { source: 'URL_PATH_PATTERN', pathPattern } },
      },
      discovery: discoveryDocumentOf(DISCOVERY_JOB_ID, [CREATE_CANDIDATE, UPDATE_CANDIDATE]),
      at: writeSlotAt(1),
    }).ok).toBe(true);
  };

  it.each([
    // 台帳の型の `{id}` の後ろに区切りがある（送信先の型 `/members/{id}` は後ろがない）。
    '/members/{id}/show',
    // 台帳の型の `{id}` の前の並び（`a`・`members`）が、送信先の型の前の並び（`members`）より長い。
    '/a/members/{id}',
  ])('rejects the issue after the ledger pattern becomes %s, and writes nothing', (pathPattern) => {
    register(0, 'rec-1');
    changeLedgerPattern(pathPattern);
    expect(reasonOf(issueUpdate('grant-u1', 'rec-1', writeSlotAt(1)))).toBe('SCENARIO_UPDATE_PATH_NOT_BOUND_TO_LEDGER_ID');
    expect(readExecutionGrant(database, 'grant-u1')).toBeNull();
  });
});
