// ST-1: Git に載せない語の検査の共通の部品（`tools/secret-terms/scan.mjs`）の `--text`（標準入力の文字列）と、一覧の読み方。
// 架空の一覧（BOM・CRLF・注釈の行・空の行・前後の空白を含む）で確かめる。当たったときの出力に語そのものを出さないこと。
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containsFakeTerm,
  createWorkDirectory,
  FAKE_ASCII_TERM,
  FAKE_ASCII_TERM_LINE,
  FAKE_COMMENT_ONLY_TERM,
  FAKE_JAPANESE_TERM,
  FAKE_JAPANESE_TERM_LINE,
  isolatedEnvironment,
  removeWorkDirectory,
  runNode,
  SCAN_SCRIPT,
  writeFakeList,
} from '../helpers/secret-terms-scan.js';

let workDirectory = '';
let listPath = '';

beforeAll(async () => {
  workDirectory = await createWorkDirectory('text');
  listPath = await writeFakeList(workDirectory);
  await writeFile(join(workDirectory, 'empty-gitconfig'), '', 'utf8');
});

afterAll(async () => {
  await removeWorkDirectory(workDirectory);
});

const scanText = (input: string, list = listPath) =>
  runNode(SCAN_SCRIPT, ['--text', 'doc/example.md'], {
    cwd: workDirectory,
    env: isolatedEnvironment(list, join(workDirectory, 'empty-gitconfig')),
    input,
  });

describe('secret-terms scan --text', () => {
  it('大文字と小文字を区別せずに、部分一致で当たる（終了コード 1、path・行・語の番号を出す）', () => {
    const result = scanText(`一行目\r\nprefix-${FAKE_ASCII_TERM.toUpperCase()}-suffix\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`doc/example.md:2: 伏せる語の一覧の ${FAKE_ASCII_TERM_LINE} 行目の語が含まれています`);
    expect(result.stderr).toContain('一般の形（登録の画面、/rest/v1/<x> など）');
    expect(containsFakeTerm(result.stdout + result.stderr)).toBe(false);
  });

  it('日本語の語に当たり、同じ行の 2 つの語の番号を並べる', () => {
    const result = scanText(`前${FAKE_JAPANESE_TERM}後 ${FAKE_ASCII_TERM.toLowerCase()}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`doc/example.md:1: 伏せる語の一覧の ${FAKE_ASCII_TERM_LINE} 行目・${FAKE_JAPANESE_TERM_LINE} 行目の語`);
    expect(containsFakeTerm(result.stdout + result.stderr)).toBe(false);
  });

  it('当たらなければ終了コード 0 で何も出さない（注釈の行の語・空の行は語にしない）', () => {
    const result = scanText(`ふつうの文\n${FAKE_COMMENT_ONLY_TERM}\n\n   \n`);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('一覧がないときは、1 行の注意を出して通す', () => {
    const result = scanText(`${FAKE_ASCII_TERM}\n`, join(workDirectory, 'no-such-list.txt'));
    expect(result.status).toBe(0);
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('一覧');
  });

  it('使い方が違うときは終了コード 2', () => {
    const result = runNode(SCAN_SCRIPT, ['--unknown'], { cwd: workDirectory, env: process.env });
    expect(result.status).toBe(2);
  });
});
