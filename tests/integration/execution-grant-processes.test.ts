// T28d（Task 28 の設計書 4.4 の「競合」）: 実行の許可と件数の予約の競合の結合テスト。同じデータベースのファイルを、2 つの子 process が別々に開き、
// 同時に動く（`execution-grant-child.ts`）。
// - 2 つの子が発行・消費・送った記録をくり返しても、予約の合計（`RELEASED` を除く）は累積の上限を超えず、消費していない有効な許可は残らない。
//   DEF-097 fix: 親が 2 つの子の回をそろえる（回ごとに両方へ `GO` を送り、両方の `ROUND` を受けてから次へ）。回の中では、2 つの子が同じ時刻で
//   同時に発行を争う。回がずれると、先の回の時刻で発行した子が、もう片方の消費していない許可を期限切れとして無効にし（予約は `RELEASED`）、
//   発行がもう 1 回通るので、発行の数が揺れた（予約の上限は守られていた）。予約の数（`RELEASED` を除く）を先に確かめる。
// - 発行だけをくり返す子と、撤回する子を同時に動かしても、撤回の後に、消費していない有効な許可（消費も無効化もしていない許可）は残らない。
// 一時のフォルダだけを使い、終わったら消す。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readExecutionGrant, readWriteReservations } from '../../src/control/approval/scenario-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { spawnTypeScriptChild } from './control-profile-fixtures.js';
import { GRANT_CHILD_PROTOCOL, GRANT_CHILD_ROUNDS, prepareGrantProfile, prepareScenario } from './execution-grant-fixtures.js';

const CHILD_MODULE_URL = new URL('./execution-grant-child.ts', import.meta.url).href;
const PROCESS_TEST_TIMEOUT_MS = 60_000;
const CUMULATIVE_LIMIT = 5;

let workDirectory = '';
let database: ControlDatabase;
const children: ChildProcessWithoutNullStreams[] = [];

const databasePath = (): string => resolveControlDatabasePath(workDirectory);

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-execution-grant-processes-'));
  database = openControlDatabase(databasePath());
});

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

/** 子 process 1 つ（標準出力の行を順に読む）。 */
interface ChildHandle {
  readonly child: ChildProcessWithoutNullStreams;
  readonly nextLine: () => Promise<string>;
  readonly exited: Promise<number | null>;
}

const startChild = (mode: string, scenarioId: string, tag: string): ChildHandle => {
  const child = spawnTypeScriptChild(CHILD_MODULE_URL, [mode, databasePath(), scenarioId, tag]);
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

/** 2 つの子を準備させ、同時に始め、結果の数えを返す。 */
const runTogether = async (handles: readonly ChildHandle[]): Promise<readonly Record<string, number>[]> => {
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
  return results;
};

/**
 * DEF-097 fix: 2 つの子の write-loop の回をそろえて動かす。準備（`READY`）を待ち、回ごとに両方へ `GO` を送り、両方の `ROUND <回>` を受けてから
 * 次の回へ進む。最後に、結果の数え（`DONE`）を返す。
 */
const runInLockstep = async (handles: readonly ChildHandle[], rounds: number): Promise<readonly Record<string, number>[]> => {
  for (const handle of handles) {
    expect(await handle.nextLine()).toBe(GRANT_CHILD_PROTOCOL.ready);
  }
  for (let round = 0; round < rounds; round += 1) {
    for (const handle of handles) {
      handle.child.stdin.write(`${GRANT_CHILD_PROTOCOL.go}\n`);
    }
    for (const handle of handles) {
      expect(await handle.nextLine()).toBe(`${GRANT_CHILD_PROTOCOL.round} ${String(round)}`);
    }
  }
  const results: Record<string, number>[] = [];
  for (const handle of handles) {
    const line = await handle.nextLine();
    expect(line.startsWith(`${GRANT_CHILD_PROTOCOL.done} `)).toBe(true);
    results.push(JSON.parse(line.slice(GRANT_CHILD_PROTOCOL.done.length + 1)) as Record<string, number>);
    expect(await handle.exited).toBe(0);
  }
  return results;
};

/** シナリオの、消費も無効化もしていない許可の数（子の名札と回の番号から）。 */
const openGrantsOf = (tags: readonly string[]): number => tags
  .flatMap((tag) => Array.from({ length: GRANT_CHILD_ROUNDS }, (_value, round) => readExecutionGrant(database, `grant-${tag}-${round}`)))
  .filter((grant) => grant !== null && grant.consumedAt === null && grant.invalidatedAt === null).length;

describe('execution grants (T28d): races between two processes', () => {
  it('never reserves more than the cumulative limit when two processes issue, consume and commit at the same time', async () => {
    const latest = prepareGrantProfile(database);
    prepareScenario(database, latest, 'scenario-race', { limits: { maxCreatesPerRun: 1, maxCumulativeCreates: CUMULATIVE_LIMIT } });
    const results = await runInLockstep([
      startChild(GRANT_CHILD_PROTOCOL.writeLoopMode, 'scenario-race', 'a'),
      startChild(GRANT_CHILD_PROTOCOL.writeLoopMode, 'scenario-race', 'b'),
    ], GRANT_CHILD_ROUNDS);
    const reservations = readWriteReservations(database, 'scenario-race');
    // 安全の決まり（先に確かめる）: 予約の合計（`RELEASED` を除く）は、累積の上限を超えない（ちょうど上限まで使う）。
    const counted = reservations.filter(({ state }) => state !== 'RELEASED').reduce((sum, { count }) => sum + count, 0);
    expect(counted).toBe(CUMULATIVE_LIMIT);
    // 回をそろえたので、許可が期限切れで無効になって予約が返ることはない（返した予約 0。発行の数 = 予約の数）。
    expect(reservations.filter(({ state }) => state === 'RELEASED')).toEqual([]);
    const issued = results.reduce((sum, result) => sum + (result['ISSUED'] ?? 0), 0);
    expect(issued).toBe(CUMULATIVE_LIMIT);
    expect(results.reduce((sum, result) => sum + (result['COMMITTED'] ?? 0), 0)).toBe(CUMULATIVE_LIMIT);
    expect(results.reduce((sum, result) => sum + (result['CONSUMED'] ?? 0), 0)).toBe(CUMULATIVE_LIMIT);
    expect(results.reduce((sum, result) => sum + (result['GRANT_CUMULATIVE_LIMIT_REACHED'] ?? 0), 0)).toBeGreaterThan(0);
    expect(openGrantsOf(['a', 'b'])).toBe(0);
  }, PROCESS_TEST_TIMEOUT_MS);

  it('leaves no valid unconsumed grant after a revocation that races with issues', async () => {
    const latest = prepareGrantProfile(database);
    prepareScenario(database, latest, 'scenario-revoke');
    const results = await runTogether([
      startChild(GRANT_CHILD_PROTOCOL.issueLoopMode, 'scenario-revoke', 'i'),
      startChild(GRANT_CHILD_PROTOCOL.revokeMode, 'scenario-revoke', 'r'),
    ]);
    expect(results[1]).toEqual({ REVOKED: 1 });
    expect(openGrantsOf(['i'])).toBe(0);
    expect(readWriteReservations(database, 'scenario-revoke').every(({ state }) => state === 'RELEASED')).toBe(true);
  }, PROCESS_TEST_TIMEOUT_MS);
});
