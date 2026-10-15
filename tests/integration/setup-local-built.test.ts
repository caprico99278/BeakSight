// ビルドした `npm run setup:local` の入口（`dist/control/setup-local.js`）を子 process で動かす結合テスト（Task 23 の設計書 4.5、4.6、
// 7 章の「環境の確かめ」。T23d）。
// - 一時のフォルダにビルドする（`buildIntoTemporaryDirectory`。リポジトリの `dist/` を読み書きしない）。入口はリポジトリの root を自分の場所
//   （`dist/control/` の 2 つ上）から決めるので、一時のビルドの root の下に `local-data/` ができる（リポジトリの `local-data/` を作らない）。
// - `node:sqlite` がない状態は、子 process を `--no-experimental-sqlite` で起動して再現する。
// - 監査の CLI（`validate-config`）が、`node:sqlite` がなくても今までどおり動くことも確かめる（`run` は動かさない）。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAILURE_EXIT_CODE, SUCCESS_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { CONTROL_DATA_DIRECTORY_NAME, resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { CONTROL_SCHEMA_VERSION } from '../../src/control/store/migrations.js';
import { CONTROL_STORE_FAILURE_DESCRIPTIONS, SETUP_LOCAL_TEXT } from '../../src/presentation/messages.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';

/** ビルドを待つ上限（ミリ秒）。 */
const BUILD_TIMEOUT_MS = 180_000;
/** 子 process の終わりを待つ上限（ミリ秒）。 */
const CHILD_TIMEOUT_MS = 30_000;
/** `node:sqlite` を止める Node の選択肢。 */
const NO_SQLITE_OPTION = '--no-experimental-sqlite';
/** 既存の例の設定のファイル（リポジトリの root から）。 */
const EXAMPLE_CONFIG_PATH = 'config/targets/example.json';
const REPOSITORY_ROOT = new URL('../../', import.meta.url);

let build: TemporaryBuild | undefined;

beforeAll(async () => {
  build = await buildIntoTemporaryDirectory();
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await build?.remove();
});

const built = (): TemporaryBuild => {
  if (build === undefined) {
    throw new Error('一時のビルドがない');
  }
  return build;
};

interface ChildResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const runNode = (args: readonly string[], cwd: string): ChildResult => {
  const result = spawnSync(process.execPath, [...args], {
    cwd,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

const setupEntry = (): string => join(built().distDirectory, 'control', 'setup-local.js');

describe('built setup:local entry (dist/control/setup-local.js)', () => {
  it('stops with an explanation when node:sqlite is not available, and creates neither the folder nor the file', () => {
    const { rootDirectory } = built();
    const result = runNode([NO_SQLITE_OPTION, setupEntry()], rootDirectory);
    expect(result.status).toBe(FAILURE_EXIT_CODE);
    expect(result.stderr).toContain(SETUP_LOCAL_TEXT.failedHeading);
    expect(result.stderr).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS.NODE_SQLITE_UNAVAILABLE.description);
    expect(result.stderr).toContain(CONTROL_STORE_FAILURE_DESCRIPTIONS.NODE_SQLITE_UNAVAILABLE.action);
    expect(result.stderr).not.toMatch(/\n\s+at /u);
    expect(existsSync(join(rootDirectory, CONTROL_DATA_DIRECTORY_NAME))).toBe(false);
  });

  it('prepares the database under its own repository root (two levels above dist/control/), then reports it as existing', () => {
    const { rootDirectory } = built();
    const first = runNode([setupEntry()], rootDirectory);
    expect(first.status, first.stderr).toBe(SUCCESS_EXIT_CODE);
    expect(first.stdout).toContain(SETUP_LOCAL_TEXT.createdText(CONTROL_SCHEMA_VERSION));
    expect(first.stdout).toContain(resolveControlDatabasePath(rootDirectory));
    expect(existsSync(resolveControlDatabasePath(rootDirectory))).toBe(true);
    // 作業のフォルダが違っても、場所は入口の場所から決まる（作業のフォルダに依存しない）。
    const second = runNode([setupEntry()], built().distDirectory);
    expect(second.status, second.stderr).toBe(SUCCESS_EXIT_CODE);
    expect(second.stdout).toContain(SETUP_LOCAL_TEXT.existingText(CONTROL_SCHEMA_VERSION));
    expect(existsSync(join(built().distDirectory, CONTROL_DATA_DIRECTORY_NAME))).toBe(false);
  });

  it('loads the control schemas from dist/schemas/control/ in the build', () => {
    const validatorUrl = pathToFileURL(join(built().distDirectory, 'control', 'control-schema-validator.js')).href;
    const script = `const { validateControlDocument } = await import(${JSON.stringify(validatorUrl)});
const result = validateControlDocument('profile', {});
process.stdout.write(JSON.stringify({ ok: result.ok, hasErrors: result.ok ? false : result.errors.length > 0 }));`;
    const result = runNode(['--input-type=module', '-e', script], built().rootDirectory);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, hasErrors: true });
  });
});

describe('the audit CLI does not depend on node:sqlite', () => {
  it('validate-config of the built CLI works with --no-experimental-sqlite', () => {
    const cli = join(built().distDirectory, 'cli', 'index.js');
    const result = runNode([NO_SQLITE_OPTION, cli, 'validate-config', '--config', EXAMPLE_CONFIG_PATH], fileURLToPath(REPOSITORY_ROOT));
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(SUCCESS_EXIT_CODE);
    expect(result.stderr).not.toMatch(/sqlite/iu);
  });
});
