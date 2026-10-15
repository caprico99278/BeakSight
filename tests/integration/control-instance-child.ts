// 管理のロック（画面のサーバを 1 つだけにする。DEF-061。T24h-4）のテストの子 process。画面のサーバの代わりに、ジョブの管理を 1 つ作る。
// 独立レビュー T24R の再現（scratch の `t24r/e1` の `manager.ts`）と同じ動き: 管理を作り、`recoverInterruptedJobs` を呼び、命令ごとに開始と一覧を行う。
// 引数: `<データベースの場所> <リポジトリの root> <ワーカーのファイル> [port]`。
// 応答（1 行ずつ）:
// - 管理を作れたら `READY <中断に直した行の数>`。作れなければ（ほかの管理がロックを持つ）`LOCKED <持ち主の PID> <持ち主の port か ->` を書いて
//   終了コード 0 で終わる（何も書き換えない）。
// - `START <profileId> <改訂>` → `RESULT OK <jobId>`、拒まれたら `RESULT <理由> -`。
// - `LIST` → `JOBS <[profileId, 状態, 理由] の JSON>`。
// - `EXIT` → 管理を閉じ（ロックを離す）、管理データを閉じて `CLOSED` を書き、終わる。
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createAuditJobManager, type AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import { ControlInstanceLockedError } from '../../src/control/job/instance-lock.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveTestContext } from './control-profile-fixtures.js';
import { INSTANCE_CHILD_PROTOCOL } from './control-instance-fixtures.js';

const STANDARD_OUTPUT = 1;
const writeLine = (line: string): void => {
  writeSync(STANDARD_OUTPUT, `${line}\n`);
};

const [databasePath, repositoryRoot, workerPath, portText] = process.argv.slice(2);
if (databasePath === undefined || repositoryRoot === undefined || workerPath === undefined) {
  throw new Error('usage: <database path> <repository root> <worker path> [port]');
}

const database = openControlDatabase(databasePath);
let manager: AuditJobManager;
try {
  manager = createAuditJobManager({
    database,
    repositoryRoot,
    workerPath,
    resolveContext: resolveTestContext,
    ...(portText === undefined ? {} : { instancePort: Number(portText) }),
  });
} catch (error) {
  if (error instanceof ControlInstanceLockedError) {
    closeControlDatabase(database);
    writeLine(`${INSTANCE_CHILD_PROTOCOL.locked} ${String(error.holderProcessId)} ${error.holderPort === null ? '-' : String(error.holderPort)}`);
    process.exit(0);
  }
  throw error;
}

const recovered = manager.recoverInterruptedJobs();
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const [command, profileId, revision] = line.trim().split(' ');
  if (command === INSTANCE_CHILD_PROTOCOL.start && profileId !== undefined && revision !== undefined) {
    void manager.startAuditJob({ profileId, expectedRevision: Number(revision), startNew: true }).then((result) => {
      writeLine(`${INSTANCE_CHILD_PROTOCOL.result} ${result.ok ? `${INSTANCE_CHILD_PROTOCOL.ok} ${result.job.jobId}` : `${result.reason} -`}`);
    });
    return;
  }
  if (command === INSTANCE_CHILD_PROTOCOL.list) {
    writeLine(`${INSTANCE_CHILD_PROTOCOL.jobs} ${JSON.stringify(manager.listAuditJobs().map((job) => [job.profileId, job.state, job.failureReason]))}`);
    return;
  }
  if (command === INSTANCE_CHILD_PROTOCOL.exit) {
    lines.close();
    void manager.close().then(() => {
      closeControlDatabase(database);
      writeLine(INSTANCE_CHILD_PROTOCOL.closed);
      process.exit(0);
    });
  }
});
writeLine(`${INSTANCE_CHILD_PROTOCOL.ready} ${String(recovered)}`);
