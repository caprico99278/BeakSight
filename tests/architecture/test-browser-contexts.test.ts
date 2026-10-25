/**
 * Architecture Gate（EL-3。設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.5）: テストは、Browser の Context の一覧を
 * `browser.contexts()` で直接読まない。起動の部品（`src/browser/chromium-launch.ts`）で起動した CLI の Chromium は、persistent の既定の Context を
 * 1 つ持ち（Run の Context ではない）、それを数えると件数の確かめが合わず、閉じると Browser が終わる。テストは `tests/helpers/chromium.ts` の
 * `testContextsOf`・`closeTestContexts` を使う。
 * - 除外（件数つき）: 補助そのもの（`tests/helpers/chromium.ts`）と、既定の Context があることを確かめるテスト（`external-launch-block.test.ts`）。
 * - ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  judgeWithFileExceptions,
  MAX_GATE_MS,
  readLfTypeScriptFilesUnder,
  scanFile,
  startCpuStopwatch,
  TEST_SOURCE_DIRECTORIES,
  type FileExceptions,
  type ScannedSource,
} from './source-scan.js';

/** `.contexts()` の呼び出し（`bare` に当てる。定義 `contexts: () => …` は当たらない）。 */
const CONTEXTS_CALL = /\.\s*contexts\s*\(\s*\)/gu;

const EXCEPTIONS: FileExceptions = Object.freeze({
  'tests/helpers/chromium.ts': {
    count: 2,
    reason: '`testContextsOf`（既定の Context を除く）と、起動の直後の既定の Context の覚え（`launchCliChromiumWith`）',
  },
  'tests/integration/external-launch-block.test.ts': {
    count: 4,
    reason: '起動の部品の persistent の既定の Context が 1 つだけあり、頁を持たないこと、その Context から要求が出ないこと（EL-F の M2）を確かめる',
  },
});

const findContextsCalls = (source: Pick<ScannedSource, 'bare'>): readonly string[] =>
  [...source.bare.matchAll(CONTEXTS_CALL)].map((match) => match[0]);

const TEST_FILES = readLfTypeScriptFilesUnder(TEST_SOURCE_DIRECTORIES).map(scanFile);

describe('EL-3: tests read the Contexts of a browser only through testContextsOf', () => {
  it('detects a direct browser.contexts() call and ignores a fake definition', () => {
    expect(findContextsCalls({ bare: 'expect(browser.contexts()).toEqual([]);' })).toHaveLength(1);
    expect(findContextsCalls({ bare: 'for (const c of real\n  .contexts ()) {}' })).toHaveLength(1);
    expect(findContextsCalls({ bare: 'const fake = { contexts: () => [context] };' })).toEqual([]);
    expect(findContextsCalls({ bare: 'await closeTestContexts(browser);' })).toEqual([]);
  });

  it('has no direct browser.contexts() call in the tests outside the named exceptions', () => {
    const stopwatch = startCpuStopwatch();
    const judgement = judgeWithFileExceptions(TEST_FILES, findContextsCalls, EXCEPTIONS);
    expect(judgement.found).toEqual([]);
    expect(judgement.countMismatches).toEqual([]);
    expect(judgement.unusedExceptions).toEqual([]);
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
