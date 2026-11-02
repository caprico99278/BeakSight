// ST-1: Claude Code の書く前のフック（`.claude/hooks/block-secret-terms.mjs`）の、ファイルを丸ごと書く道具（Write・Desktop Commander の write_file）。
// 架空の一覧で確かめる。Git に載る path では止め、無視される path（`local/` の下）とリポジトリの外は通す。止めた理由に語そのものを出さない。
// ファイルは書かない（フックは判定だけをする）。
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containsFakeTerm,
  createWorkDirectory,
  FAKE_ASCII_TERM,
  FAKE_ASCII_TERM_LINE,
  HOOK_PROBE_TRACKED_PATH,
  isolatedEnvironment,
  REPOSITORY_ROOT,
  removeWorkDirectory,
  runClaudeHook,
  writeFakeList,
} from '../helpers/secret-terms-scan.js';

let workDirectory = '';
let env: NodeJS.ProcessEnv = {};

beforeAll(async () => {
  workDirectory = await createWorkDirectory('hook-write');
  const listPath = await writeFakeList(workDirectory);
  const emptyConfig = join(workDirectory, 'empty-gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  env = isolatedEnvironment(listPath, emptyConfig);
});

afterAll(async () => {
  await removeWorkDirectory(workDirectory);
});

describe('block-secret-terms フック（丸ごと書く道具）', () => {
  it('Git に載る path への Write の中身で止め、path と語の番号を出し、語そのものは出さない', () => {
    const result = runClaudeHook(env, 'Write', { file_path: HOOK_PROBE_TRACKED_PATH, content: `一行目\n${FAKE_ASCII_TERM.toLowerCase()}\n` });
    expect(result.denied).toBe(true);
    expect(result.reason).toContain('doc/spec/zz-secret-terms-hook-probe.md');
    expect(result.reason).toContain(`書く文字列の 2 行目（伏せる語の一覧の ${FAKE_ASCII_TERM_LINE} 行目の語）`);
    expect(result.reason).toContain('一般の形（登録の画面、/rest/v1/<x> など）で書き直してください');
    expect(containsFakeTerm(result.raw)).toBe(false);
  });

  it('無視される path（local/ の下）とリポジトリの外は通す', () => {
    const ignored = join(REPOSITORY_ROOT, 'local', 'zz-probe.txt');
    expect(runClaudeHook(env, 'Write', { file_path: ignored, content: FAKE_ASCII_TERM }).denied).toBe(false);
    expect(runClaudeHook(env, 'Write', { file_path: join(workDirectory, 'outside.md'), content: FAKE_ASCII_TERM }).denied).toBe(false);
  });

  it('Desktop Commander の write_file も調べる', () => {
    const tool = 'mcp__plugin_desktop-commander_desktop-commander__write_file';
    expect(runClaudeHook(env, tool, { path: HOOK_PROBE_TRACKED_PATH, content: FAKE_ASCII_TERM }).denied).toBe(true);
  });
});
