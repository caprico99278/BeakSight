// 監査のジョブの管理のテストの子 process（T24e。`control-audit-jobs-processes.test.ts` と `control-audit-jobs-worker.test.ts` が起動する）。
// 画面のサーバの process の代わりに、ジョブの管理を 1 つ作り、標準入力の命令ごとに動く。
// 引数: `<データベースの場所> <リポジトリの root> <ワーカーのファイル> <文脈の読み方>`。文脈の読み方は `JOB_CHILD_PROTOCOL` の値:
// - `fixture`: テストの決まった文脈（`resolveTestContext`）。
// - `load-config`: リポジトリの root の下のターゲット JSON を `loadConfig` で読む（画面のサーバと同じ形）。
// - `store-only`: ジョブの管理を作らずに、ジョブの行の部品（`createStartingJob`）だけで行を作る（T24h-4。管理は管理のロックで 1 つだけに
//   なったので、2 つの process から同じデータベースへの、行の作成の競争そのものを確かめるため）。
// 命令（1 行ずつ）と応答:
// - 起動したら `READY`。
// - `START <profileId> <改訂>` → `RESULT OK <jobId> <ワーカーの process の ID か ->`、拒まれたら `RESULT <理由> - -`。
// - `EXIT` → ジョブの管理を閉じ（残ったワーカーを止める）、管理データを閉じて `CLOSED` を書き、終わる。
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { loadConfig } from '../../src/config/load-config.js';
import { createAuditJobManager, type AuditJobContextResolver, type AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import { createStartingJob } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { JOB_CHILD_PROTOCOL } from './control-audit-jobs-fixtures.js';
import { resolveTestContext } from './control-profile-fixtures.js';

const STANDARD_OUTPUT = 1;
const writeLine = (line: string): void => {
  writeSync(STANDARD_OUTPUT, `${line}\n`);
};

const [databasePath, repositoryRoot, workerPath, contextKind] = process.argv.slice(2);
if (databasePath === undefined || repositoryRoot === undefined || workerPath === undefined || contextKind === undefined) {
  throw new Error('usage: <database path> <repository root> <worker path> <context kind>');
}

const loadConfigContext: AuditJobContextResolver = async (targetConfigPath) => ({
  targetConfig: await loadConfig(join(repositoryRoot, targetConfigPath)),
});

const database = openControlDatabase(databasePath);
const workers: ChildProcess[] = [];
const storeOnly = contextKind === JOB_CHILD_PROTOCOL.storeOnly;
const manager: AuditJobManager | null = storeOnly ? null : createAuditJobManager({
  database,
  repositoryRoot,
  workerPath,
  resolveContext: contextKind === JOB_CHILD_PROTOCOL.loadConfigContext ? loadConfigContext : resolveTestContext,
  forkWorker: (modulePath, args, options) => {
    const child = fork(modulePath, [...args], options);
    workers.push(child);
    return child;
  },
});

/** 管理を作らずに、ジョブの行だけを作る（`store-only`）。 */
const startInStoreOnly = (profileId: string, revision: number): string => {
  const jobId = randomUUID();
  const created = createStartingJob(database, {
    jobId,
    // T26c: ジョブの種類は必ず明示する（既定の値はない）。
    jobKind: 'AUDIT',
    profileId,
    profileRevision: revision,
    startNew: true,
    createdAt: formatCompactUtcTimestamp(new Date(), 'test job time'),
  }, () => null);
  return created.ok
    ? `${JOB_CHILD_PROTOCOL.result} ${JOB_CHILD_PROTOCOL.ok} ${jobId} -`
    : `${JOB_CHILD_PROTOCOL.result} ${created.reason} - -`;
};

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const [command, profileId, revision] = line.trim().split(' ');
  if (command === JOB_CHILD_PROTOCOL.start && profileId !== undefined && revision !== undefined) {
    if (manager === null) {
      writeLine(startInStoreOnly(profileId, Number(revision)));
      return;
    }
    void manager.startAuditJob({ profileId, expectedRevision: Number(revision), startNew: true }).then((result) => {
      writeLine(result.ok
        ? `${JOB_CHILD_PROTOCOL.result} ${JOB_CHILD_PROTOCOL.ok} ${result.job.jobId} ${String(workers.at(-1)?.pid ?? '-')}`
        : `${JOB_CHILD_PROTOCOL.result} ${result.reason} - -`);
    });
    return;
  }
  if (command === JOB_CHILD_PROTOCOL.exit) {
    lines.close();
    void (manager?.close() ?? Promise.resolve()).then(() => {
      closeControlDatabase(database);
      writeLine(JOB_CHILD_PROTOCOL.closed);
      process.exit(0);
    });
  }
});
writeLine(JOB_CHILD_PROTOCOL.ready);
