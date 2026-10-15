// プロファイルの保存のテストの子 process（Task 23 の T23c。`control-profile-processes.test.ts` が起動する）。
// 引数: `<動き> <データベースの場所>`。動きは `CHILD_PROTOCOL` の `serveMode`・`holdMode`・`loopMode`。
// - serve: 開いて `READY` を書き、標準入力の `UPDATE <期待する改訂> <パス>` ごとに `updateProfile` を 1 回行い、結果を 1 行で書く。
// - hold: 書き込みのトランザクション（`withWriteTransaction`）の中で、プロファイルの行と履歴を書き換えた後、`IN_TRANSACTION` を書いて
//   止まったままになる（親が強制終了する）。
// - loop: `updateProfile` を繰り返し、1 回ごとに `DONE <改訂>` を書く（親が任意の時に強制終了する）。
import { writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { getProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { withWriteTransaction } from '../../src/control/store/transaction.js';
import {
  CHILD_PROFILE_ID,
  CHILD_PROTOCOL,
  PUBLIC_TARGET_PATH,
  SECOND_PUBLIC_TARGET_PATH,
  publicProfile,
  resolveTestContext,
} from './control-profile-fixtures.js';

const STANDARD_OUTPUT = 1;
/** 止まったままにするための待ち（`Atomics.wait` の値が変わらないので、強制終了まで戻らない）。 */
const BLOCKED_FOREVER = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** hold で書きかける履歴の値（落ちた後に残っていてはいけない）。 */
const HELD_REVISION = 999;
const HELD_CHANGE_KIND = 'UPDATED';
const HELD_RECORDED_AT = '20261009000000';

const writeLine = (line: string): void => {
  writeSync(STANDARD_OUTPUT, `${line}\n`);
};

const [mode, databasePath] = process.argv.slice(2);
if (mode === undefined || databasePath === undefined) {
  throw new Error('usage: <mode> <database path>');
}
const database = openControlDatabase(databasePath);

if (mode === CHILD_PROTOCOL.serveMode) {
  writeLine(CHILD_PROTOCOL.ready);
  for await (const line of createInterface({ input: process.stdin })) {
    const [command, expected, targetConfigPath] = line.trim().split(' ');
    if (command === CHILD_PROTOCOL.exit) {
      break;
    }
    if (command !== CHILD_PROTOCOL.update || expected === undefined || targetConfigPath === undefined) {
      throw new Error(`unknown command: ${line}`);
    }
    const expectedRevision = Number(expected);
    const result = updateProfile(
      database,
      { profile: publicProfile(CHILD_PROFILE_ID, expectedRevision + 1, targetConfigPath), expectedRevision },
      { resolveContext: resolveTestContext },
    );
    writeLine(result.ok ? CHILD_PROTOCOL.updated : result.reason);
  }
  closeControlDatabase(database);
  // 標準入力のパイプが開いたままだと process が終わらないので、閉じてから終わる。
  process.stdin.destroy();
} else if (mode === CHILD_PROTOCOL.holdMode) {
  withWriteTransaction(database, (connection) => {
    // テストの子 process だけの直接の書き込み（途中で落ちたときに、書きかけが残らないことを確かめるため）。
    connection.prepare('UPDATE profiles SET revision = revision + 1 WHERE profile_id = ?').run(CHILD_PROFILE_ID);
    connection.prepare(
      'INSERT INTO profile_revisions (profile_id, revision, document, change_kind, recorded_at) VALUES (?, ?, ?, ?, ?)',
    ).run(CHILD_PROFILE_ID, HELD_REVISION, JSON.stringify(publicProfile(CHILD_PROFILE_ID, HELD_REVISION)), HELD_CHANGE_KIND, HELD_RECORDED_AT);
    writeLine(CHILD_PROTOCOL.inTransaction);
    Atomics.wait(BLOCKED_FOREVER, 0, 0);
  });
} else if (mode === CHILD_PROTOCOL.loopMode) {
  for (let round = 0; ; round += 1) {
    const current = getProfile(database, CHILD_PROFILE_ID);
    if (current === null) {
      throw new Error('the shared profile does not exist');
    }
    const expectedRevision = current.profile.revision;
    const targetConfigPath = round % 2 === 0 ? SECOND_PUBLIC_TARGET_PATH : PUBLIC_TARGET_PATH;
    const result = updateProfile(
      database,
      { profile: publicProfile(CHILD_PROFILE_ID, expectedRevision + 1, targetConfigPath), expectedRevision },
      { resolveContext: resolveTestContext },
    );
    if (!result.ok) {
      throw new Error(`update failed: ${result.reason}`);
    }
    writeLine(`${CHILD_PROTOCOL.done} ${result.stored.profile.revision}`);
  }
} else {
  throw new Error(`unknown mode: ${mode}`);
}
