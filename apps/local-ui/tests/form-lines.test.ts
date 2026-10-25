/**
 * T43b fix round 1（共通化）: 画面の「1 行に 1 つ」の欄の読み方と書き方（`src/display/form-lines.ts`）。プロファイルの作成・認証の設定・入力の
 * 規則の欄が共用する。振る舞いは、まとめる前の各画面の式と同じ（行の区切りは `\n` と `\r\n`、前後の空白を除き、空の行を除く。書くときは `\n` で
 * つなぐ）。
 */
import { describe, expect, it } from 'vitest';
import { linesOf, textOfLines } from '../src/display/form-lines';

describe('T43b fix round 1: the one-per-line fields', () => {
  it('reads the lines, trims them and drops the empty ones', () => {
    expect(linesOf('')).toEqual([]);
    expect(linesOf('  a  \n\nb\r\n  \r\nc\n')).toEqual(['a', 'b', 'c']);
    expect(linesOf('only')).toEqual(['only']);
  });

  it('writes the values one per line, and reads them back', () => {
    expect(textOfLines([])).toBe('');
    expect(textOfLines(['https://a.example.test', 'https://b.example.test'])).toBe('https://a.example.test\nhttps://b.example.test');
    expect(linesOf(textOfLines(['/a', '/b']))).toEqual(['/a', '/b']);
  });
});
