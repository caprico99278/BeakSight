// `node:sqlite` がない Node の再現（Task 23 の設計書 4.5、7 章の「環境の確かめ」。T23a）。
// 子 process を `--no-experimental-sqlite` で起動し（調査の事実: `process.getBuiltinModule('node:sqlite')` が undefined になる）、
// 次を確かめる。
// - `checkControlEnvironment()` が `NODE_SQLITE_UNAVAILABLE` を返す。
// - `openControlDatabase()` が、同じ理由の `ControlStoreError` で止まり、フォルダもファイルも作らない（環境の確かめが最初の手順）。
// - 管理データの部品を import しただけでは落ちない（`node:sqlite` を静的に import していない）。
// 子 process は TypeScript のソースを直接読む（Node の型の除去）。`.js` の指定子は、同じ名前の `.ts` に読み替える
// （`module.registerHooks` の resolve。子 process の中だけで使う。本文は `tests/helpers/typescript-source-hook.ts`）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { TYPESCRIPT_SOURCE_RESOLVE_HOOK } from '../helpers/typescript-source-hook.js';

/** 子 process の終わりを待つ上限（ミリ秒）。超えたら止める。 */
const CHILD_TIMEOUT_MS = 20_000;

const ENVIRONMENT_MODULE_URL = new URL('../../src/control/environment/control-environment.ts', import.meta.url).href;
const DATABASE_MODULE_URL = new URL('../../src/control/store/control-database.ts', import.meta.url).href;

/** 子 process で動かす本文。結果を 1 行の JSON で標準出力に書く。 */
const CHILD_SCRIPT = `
${TYPESCRIPT_SOURCE_RESOLVE_HOOK}
const [environmentUrl, databaseUrl, databasePath] = process.argv.slice(1);
const { checkControlEnvironment } = await import(environmentUrl);
const { openControlDatabase } = await import(databaseUrl);
const environment = checkControlEnvironment();
let open;
try {
  openControlDatabase(databasePath);
  open = { opened: true };
} catch (error) {
  open = { opened: false, name: error?.name, reason: error?.reason };
}
process.stdout.write(JSON.stringify({
  builtin: process.getBuiltinModule('node:sqlite') === undefined ? 'undefined' : 'loaded',
  environment,
  open,
}) + '\\n');
`;

let workDirectory = '';

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-no-sqlite-'));
});

afterEach(() => {
  rmSync(workDirectory, { recursive: true, force: true });
});

const runChild = (nodeOptions: readonly string[], databasePath: string): unknown => {
  const result = spawnSync(
    process.execPath,
    [...nodeOptions, '--input-type=module', '-e', CHILD_SCRIPT, ENVIRONMENT_MODULE_URL, DATABASE_MODULE_URL, databasePath],
    { encoding: 'utf8', timeout: CHILD_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const lastLine = result.stdout.trim().split(/\r?\n/u).at(-1) ?? '';
  return JSON.parse(lastLine) as unknown;
};

describe('Control environment without node:sqlite (child process with --no-experimental-sqlite)', () => {
  it('reports NODE_SQLITE_UNAVAILABLE and creates neither the folder nor the file', () => {
    const databasePath = resolveControlDatabasePath(workDirectory);
    expect(runChild(['--no-experimental-sqlite'], databasePath)).toEqual({
      builtin: 'undefined',
      environment: { ok: false, nodeVersion: process.versions.node, reason: 'NODE_SQLITE_UNAVAILABLE' },
      open: { opened: false, name: 'ControlStoreError', reason: 'NODE_SQLITE_UNAVAILABLE' },
    });
    expect(existsSync(dirname(databasePath))).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  it('the same child script prepares the database when node:sqlite is available (the control case)', () => {
    const databasePath = resolveControlDatabasePath(workDirectory);
    expect(runChild([], databasePath)).toEqual({
      builtin: 'loaded',
      environment: { ok: true, nodeVersion: process.versions.node },
      open: { opened: true },
    });
    expect(existsSync(databasePath)).toBe(true);
  });
});
