// 実行の許可と件数の予約の競合のテストの子 process（T28d。`execution-grant-processes.test.ts` が起動する）。
// 引数: `<動き> <データベースの場所> <シナリオの id> <名札>`。動きは `GRANT_CHILD_PROTOCOL` の値。
// - 開いて `READY` を書き、標準入力の `GO` を待ってから動く。終わったら `DONE <JSON>`（結果の数え）を書いて閉じる。
// - write-loop: 発行 → 消費 → 送った記録（`COMMITTED`）を `GRANT_CHILD_ROUNDS` 回くり返す（許可の id とジョブの id は名札と回の番号）。T30d: 同じ
//   シナリオの連続の書き込みの間隔（5 分）を守るため、回ごとの時刻は `writeSlotAt(回)`（2 つの子で同じ時刻の並び。同じ時刻に書けるのは 1 つだけ）。
//   DEF-097 fix: 回ごとに親の `GO` を待ち、回の終わりに `ROUND <回>` を書く（親が 2 つの子の回をそろえる）。回がずれると、先の回の時刻で発行した
//   子が、もう片方の子の消費していない許可を期限切れとして無効にし、予約が返って（`RELEASED`）発行がもう 1 回通るため（発行の数が揺れる）。
//   回の中では、2 つの子が同じ時刻で同時に発行を争う（競合の確かめはそのまま）。
// - issue-loop: 発行だけを `GRANT_CHILD_ROUNDS` 回くり返す（消費しない）。
// - revoke: シナリオの最後の承認を撤回する。
// - update-issue（T31e）: `GO` の前に UPDATE の更新の予定のレコードの ID を読み、`GO` の後に、その ID を予定にして UPDATE の発行を 1 回だけ争う。
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import {
  consumeExecutionGrant,
  issueExecutionGrant,
  readPlannedUpdateTarget,
  readScenario,
  revokeScenarioApproval,
} from '../../src/control/approval/scenario-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { EXTERNAL, GRANT_CHILD_PROTOCOL, GRANT_CHILD_ROUNDS, ISSUED_AT, settleWriteForTest, writeSlotAt } from './execution-grant-fixtures.js';

const STANDARD_OUTPUT = 1;
const writeLine = (line: string): void => {
  writeSync(STANDARD_OUTPUT, `${line}\n`);
};

const [mode, databasePath, scenarioId, tag] = process.argv.slice(2);
if (mode === undefined || databasePath === undefined || scenarioId === undefined || tag === undefined) {
  throw new Error('usage: <mode> <database path> <scenario id> <tag>');
}
const database = openControlDatabase(databasePath);
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
/** 親の `GO` の行を待つ（ほかの行は読み飛ばす）。 */
const waitForGo = async (): Promise<void> => {
  for (;;) {
    const next = await input.next();
    if (next.done === true) {
      throw new Error('the standard input ended before GO');
    }
    if (next.value.trim() === GRANT_CHILD_PROTOCOL.go) {
      return;
    }
  }
};
// T31e: UPDATE の予定の ID は、始める前（画面が開始の確かめを見せたとき）に読む。
const plannedTarget = mode === GRANT_CHILD_PROTOCOL.updateIssueMode ? readPlannedUpdateTarget(database, scenarioId) : null;
writeLine(GRANT_CHILD_PROTOCOL.ready);
await waitForGo();

const outcomes: Record<string, number> = {};
/** write-loop の 1 回の終わりを親に知らせる（ほかの動きは書かない）。 */
const endRound = (round: number): void => {
  if (mode === GRANT_CHILD_PROTOCOL.writeLoopMode) {
    writeLine(`${GRANT_CHILD_PROTOCOL.round} ${String(round)}`);
  }
};
const count = (key: string): void => {
  outcomes[key] = (outcomes[key] ?? 0) + 1;
};

const revisionOf = (): number => {
  const scenario = readScenario(database, scenarioId);
  if (scenario === null) {
    throw new Error('the scenario does not exist');
  }
  return scenario.revision;
};

if (mode === GRANT_CHILD_PROTOCOL.updateIssueMode) {
  const issued = issueExecutionGrant(database, {
    scenarioId, expectedRevision: revisionOf(), grantId: `grant-${tag}-0`, jobId: `job-${tag}-0`, count: 1, expectedTargetRecordId: plannedTarget,
    external: EXTERNAL, at: ISSUED_AT,
  });
  count(issued.ok ? 'ISSUED' : issued.reason);
  if (issued.ok) {
    count(`TARGET:${issued.grant.targetRecordId ?? 'null'}`);
  }
} else if (mode === GRANT_CHILD_PROTOCOL.revokeMode) {
  const result = revokeScenarioApproval(database, { scenarioId, expectedRevision: revisionOf(), receiptId: `revoke-${tag}`, at: ISSUED_AT });
  count(result.ok ? 'REVOKED' : result.reason);
} else {
  const expectedRevision = revisionOf();
  for (let round = 0; round < GRANT_CHILD_ROUNDS; round += 1) {
    // DEF-097 fix: write-loop は、2 回目からの回の前に親の `GO` を待つ（1 回目の `GO` は上で受けた）。
    if (mode === GRANT_CHILD_PROTOCOL.writeLoopMode && round > 0) {
      await waitForGo();
    }
    const at = mode === GRANT_CHILD_PROTOCOL.writeLoopMode ? writeSlotAt(round) : ISSUED_AT;
    const issued = issueExecutionGrant(database, {
      scenarioId, expectedRevision, grantId: `grant-${tag}-${round}`, jobId: `job-${tag}-${round}`, count: 1, external: EXTERNAL, at,
    });
    if (!issued.ok) {
      count(issued.reason);
      endRound(round);
      continue;
    }
    count('ISSUED');
    if (mode === GRANT_CHILD_PROTOCOL.writeLoopMode) {
      const { grant } = issued;
      const consumed = consumeExecutionGrant(database, {
        grantId: grant.grantId, scenarioId, scenarioRevision: grant.scenarioRevision, jobId: grant.jobId, profileId: grant.profileId,
        external: EXTERNAL, at,
      });
      count(consumed.ok ? 'CONSUMED' : consumed.reason);
      // T30e: 送った（`COMMITTED`）の締めは、書き込みの結果の記録を伴う口だけ（テストだけの手順）。
      const settled = settleWriteForTest(database, {
        grantId: grant.grantId, jobId: grant.jobId, reservationId: grant.reservation.reservationId, to: 'COMMITTED', at,
      });
      count(settled ? 'COMMITTED' : 'NOT_SETTLED');
    }
    endRound(round);
  }
}
writeLine(`${GRANT_CHILD_PROTOCOL.done} ${JSON.stringify(outcomes)}`);
closeControlDatabase(database);
process.stdin.destroy();
