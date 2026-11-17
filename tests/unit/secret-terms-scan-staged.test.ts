// ST-1: Git に載せない語の検査の共通の部品（`tools/secret-terms/scan.mjs`）の `--staged`（コミットする中身。pre-commit が使う）。
// 一時のフォルダに `git init` した小さなリポジトリで、架空の一覧で確かめる。利用者の Git の設定（global・system）は読まない。
// - index の中の、追加・変更されたファイルの中身を調べる。消すファイルとバイナリは調べない。語そのものは出さない。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containsFakeTerm,
  createWorkDirectory,
  FAKE_ASCII_TERM,
  FAKE_ASCII_TERM_LINE,
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

let workDirectory = '';
let repository = '';
let env: NodeJS.ProcessEnv = {};

const git = (...args: string[]) => runGit(repository, env, args);
const scan = () => runNode(SCAN_SCRIPT, ['--staged'], { cwd: repository, env });
const write = (path: string, content: string | Buffer) => writeFile(join(repository, path), content);

beforeAll(async () => {
  workDirectory = await createWorkDirectory('staged');
  const listPath = await writeFakeList(workDirectory);
  const emptyConfig = join(workDirectory, 'empty-gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  env = isolatedEnvironment(listPath, emptyConfig);
  repository = join(workDirectory, 'repo');
  await mkdir(repository);
  git('init', '-q', '-b', 'main');
  // 前のコミットに、語を含むファイル（old-leak.md）がある。
  importCommits(repository, env, join(workDirectory, 'marks'), [
    { message: 'base', files: { 'clean.md': 'ふつうの文\n', 'old-leak.md': `${FAKE_ASCII_TERM}\n` } },
  ]);
  git('read-tree', 'HEAD');
});

afterAll(async () => {
  await removeWorkDirectory(workDirectory);
});

describe('secret-terms scan --staged', () => {
  it('語を含むファイルを消すことと、語を含むバイナリを足すことは止めない（終了コード 0）', async () => {
    await write('binary.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(FAKE_ASCII_TERM)]));
    git('add', 'binary.bin');
    git('rm', '-q', '--cached', 'old-leak.md');
    const result = scan();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('追加したファイル（日本語の語）と変更したファイル（大文字の語）に当たる（終了コード 1。path・行・語の番号だけを出す）', async () => {
    await write('leak.md', `一行目\n二行目 ${FAKE_JAPANESE_TERM}\n`);
    await write('clean.md', `ふつうの文\r\n${FAKE_ASCII_TERM.toUpperCase()}\r\n`);
    git('add', 'leak.md', 'clean.md');
    const result = scan();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`leak.md:2: 伏せる語の一覧の ${FAKE_JAPANESE_TERM_LINE} 行目の語が含まれています`);
    expect(result.stderr).toContain(`clean.md:2: 伏せる語の一覧の ${FAKE_ASCII_TERM_LINE} 行目の語が含まれています`);
    expect(result.stderr).toContain('一般の形（登録の画面、/rest/v1/<x> など）');
    expect(containsFakeTerm(result.stdout + result.stderr)).toBe(false);
  });
});
