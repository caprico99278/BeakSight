// ST-1: Claude Code の書く前のフック（`.claude/hooks/block-secret-terms.mjs`）の、書き換える道具（Edit・MultiEdit）と、当たらないとき。
// 架空の一覧で確かめる。調べるのは new_string だけ（old_string は調べない）。止めた理由に語そのものを出さない。
// ファイルは書かない（フックは判定だけをする）。
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  containsFakeTerm,
  createWorkDirectory,
  FAKE_ASCII_TERM,
  FAKE_JAPANESE_TERM,
  FAKE_JAPANESE_TERM_LINE,
  HOOK_PROBE_TRACKED_PATH,
  isolatedEnvironment,
  removeWorkDirectory,
  runClaudeHook,
  writeFakeList,
} from '../helpers/secret-terms-scan.js';

let workDirectory = '';
let env: NodeJS.ProcessEnv = {};

beforeAll(async () => {
  workDirectory = await createWorkDirectory('hook-edit');
  const listPath = await writeFakeList(workDirectory);
  const emptyConfig = join(workDirectory, 'empty-gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  env = isolatedEnvironment(listPath, emptyConfig);
});

afterAll(async () => {
  await removeWorkDirectory(workDirectory);
});

describe('block-secret-terms フック（書き換える道具）', () => {
  it('Edit の new_string（日本語の語）で止め、語そのものは出さない', () => {
    const blocked = runClaudeHook(env, 'Edit', { file_path: HOOK_PROBE_TRACKED_PATH, old_string: 'a', new_string: `前${FAKE_JAPANESE_TERM}後` });
    expect(blocked.denied).toBe(true);
    expect(blocked.reason).toContain(`伏せる語の一覧の ${FAKE_JAPANESE_TERM_LINE} 行目の語`);
    expect(containsFakeTerm(blocked.raw)).toBe(false);
  });

  it('old_string にだけ語があるとき（語を消す書き換え）は通す', () => {
    const result = runClaudeHook(env, 'Edit', { file_path: HOOK_PROBE_TRACKED_PATH, old_string: FAKE_ASCII_TERM, new_string: 'ふつうの文' });
    expect(result.denied).toBe(false);
    expect(result.raw).toBe('');
  });

  it('MultiEdit の全部の new_string を調べ、何番目の書き換えかを出す', () => {
    const multi = runClaudeHook(env, 'MultiEdit', {
      file_path: HOOK_PROBE_TRACKED_PATH,
      edits: [
        { old_string: 'a', new_string: 'ふつう' },
        { old_string: 'b', new_string: FAKE_ASCII_TERM },
      ],
    });
    expect(multi.denied).toBe(true);
    expect(multi.reason).toContain('2 番目の書き換えの 1 行目');
    expect(containsFakeTerm(multi.raw)).toBe(false);
  });
});
