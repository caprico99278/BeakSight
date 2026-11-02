// ST-1: Git に載せない語の検査の共通の部品（`tools/secret-terms/scan.mjs`）の `--push <local> <remote>`（送るコミット。pre-push が使う）。
// 一時のフォルダに `git init` した小さなリポジトリで、架空の一覧で確かめる。利用者の Git の設定（global・system）は読まない。
// - `<remote>..<local>` の各コミットで変わったファイルの中身を調べる。リモートが全部 0 なら、たどれる全部。ローカルが全部 0 なら通す。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containsFakeTerm,
  createWorkDirectory,
  FAKE_JAPANESE_TERM,
  FAKE_JAPANESE_TERM_LINE,
  importCommits,
  isolatedEnvironment,
  removeWorkDirectory,
  runGit,
  runNode,
  SCAN_SCRIPT,
  writeFakeList,
} from '../helpers/secret-terms-scan.js';

/** 全部 0 の sha。 */
const ZERO_SHA = '0'.repeat(40);

let workDirectory = '';
let repository = '';
let env: NodeJS.ProcessEnv = {};
let cleanCommit = '';
let leakCommit = '';
let fixCommit = '';

const scan = (local: string, remote: string) => runNode(SCAN_SCRIPT, ['--push', local, remote], { cwd: repository, env });

beforeAll(async () => {
  workDirectory = await createWorkDirectory('push');
  const listPath = await writeFakeList(workDirectory);
  const emptyConfig = join(workDirectory, 'empty-gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  env = isolatedEnvironment(listPath, emptyConfig);
  repository = join(workDirectory, 'repo');
  await mkdir(repository);
  runGit(repository, env, ['init', '-q', '-b', 'main']);
  [cleanCommit, leakCommit, fixCommit] = importCommits(repository, env, join(workDirectory, 'marks'), [
    { message: 'clean', files: { 'clean.md': 'ふつうの文\n' } },
    { message: 'leak', files: { 'leak.md': `一行目\n二行目 ${FAKE_JAPANESE_TERM}\n` } },
    { message: 'fix', files: { 'leak.md': null } },
  ]) as [string, string, string];
});

afterAll(async () => {
  await removeWorkDirectory(workDirectory);
});

describe('secret-terms scan --push', () => {
  it('送るコミットの中に語を足したコミットがあれば 1（後のコミットで消していても）。コミットと path・行・語の番号だけを出す', () => {
    const result = scan(fixCommit, cleanCommit);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `leak.md（コミット ${leakCommit.slice(0, 12)}）:2: 伏せる語の一覧の ${FAKE_JAPANESE_TERM_LINE} 行目の語が含まれています`,
    );
    expect(containsFakeTerm(result.stdout + result.stderr)).toBe(false);
  });

  it('送るコミットに語がなければ 0', () => {
    expect(scan(fixCommit, leakCommit).status).toBe(0);
  });

  it('リモートが全部 0 なら、たどれる全部を調べる。ローカルが全部 0（ブランチを消す）なら通す', () => {
    expect(scan(fixCommit, ZERO_SHA).status).toBe(1);
    expect(scan(ZERO_SHA, fixCommit).status).toBe(0);
  });
});
