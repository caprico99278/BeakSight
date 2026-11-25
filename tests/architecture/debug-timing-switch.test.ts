/**
 * DBG-1（設計書 `2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` 2.2。2026-11-21 の直し: 入切は環境変数でなく設定ファイル）: 測りの記録の入切を
 * 読むのは 1 か所だけ（速い fs の検査。本文の文字列だけを見る）。
 * - (a) src の中で設定ファイルの名前（`debug-settings.json`）を書くのは、部品（`src/core/debug-timing.ts`）だけ。
 * - (b) 入切を読む関数（`debugTimingSwitchOf`）を呼ぶのは、起動の入口（CLI とワーカー）だけ。下へは依存の注入で渡す（Run の始めに 1 回呼ぶ）。
 * - (c) 前の入切の環境変数の名前は、src にない。
 */
import { describe, expect, it } from 'vitest';
import { readTypeScriptFilesUnder } from './source-scan.js';

const OWNER_PATH = 'src/core/debug-timing.ts';
const ENTRY_PATHS: readonly string[] = ['src/cli/index.ts', 'src/worker/audit-worker-process.ts'];
const SOURCES = readTypeScriptFilesUnder('src');

describe('DBG-1: the debug timing switch is read in one place', () => {
  it('(a) names the settings file only in the debug timing part', () => {
    expect(SOURCES.filter(({ content }) => content.includes('debug-settings.json')).map(({ path }) => path)).toEqual([OWNER_PATH]);
  });

  it('(b) reads the switch only at the start entries', () => {
    const callers = SOURCES.filter(({ path, content }) => path !== OWNER_PATH && content.includes('debugTimingSwitchOf(')).map(({ path }) => path);
    expect([...callers].sort()).toEqual([...ENTRY_PATHS].sort());
  });

  it('(c) has no environment variable for the switch', () => {
    expect(SOURCES.filter(({ content }) => content.includes('BEAKSIGHT_DEBUG_TIMING')).map(({ path }) => path)).toEqual([]);
  });
});
