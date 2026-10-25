/**
 * Architecture Gate（EL-12。設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.1・4 章）: 本番の Chromium の起動の owner。
 * - (a) `src/` で Chromium を起動する Playwright の呼び出し（`launch`・`launchPersistentContext`・`launchServer`・`connect`・`connectOverCDP`）が
 *   あるのは、起動の部品（`src/browser/chromium-launch.ts`）だけ。ほかの本番のファイルは、外部のアプリの起動を止める設定と自己検査を通らない
 *   起動をしない。
 * - (b) 起動の部品の中の起動の呼び出しは、`launchPersistentContext` の 1 か所だけ（`chromium.launch` は使わない。`--user-data-dir` を使えないため）。
 * - (c) 本番の起動の所（CLI の Run の Browser、ワーカーのログインの段の 2 つの Browser）は、起動の部品の `launchChromium` を呼ぶ。
 * - ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import { findCallSites, loadSourceFiles, MAX_GATE_MS, sourceFileAt, startCpuStopwatch, violationsOf, type SourceFile } from './source-scan.js';

const LAUNCH_OWNER = 'src/browser/chromium-launch.ts';
/** (a) Chromium を起動する Playwright の呼び出し（`.name(` の形。`bare` に当てる）。 */
const BROWSER_START_CALL = /\.\s*(launch|launchPersistentContext|launchServer|connect|connectOverCDP)\s*\(/gu;
/** (c) 本番の起動の所と、`launchChromium` を呼ぶ数。 */
const PRODUCTION_LAUNCH_SITES: Readonly<Record<string, number>> = Object.freeze({
  'src/cli/audit-run.ts': 1,
  'src/worker/audit-worker-process.ts': 2,
});

/** (b) 起動の部品の中の、Playwright の `chromium` の起動の呼び出し（差し替えの口 `dependencies.launchPersistentContext(` は数えない）。 */
const PLAYWRIGHT_CHROMIUM_START_CALL = /\bchromium\s*\.\s*(launch|launchPersistentContext|launchServer|connect|connectOverCDP)\s*\(/gu;

const browserStartCalls = (file: Pick<SourceFile, 'bare'>): readonly string[] =>
  [...file.bare.matchAll(BROWSER_START_CALL)].map((match) => match[1] ?? '');

const SOURCE_FILES = loadSourceFiles();

describe('EL-12: only the launch component starts Chromium in src/', () => {
  it('(a) detects a direct launch outside the launch component', () => {
    const asFile = (bare: string): Pick<SourceFile, 'bare'> => ({ bare });
    expect(browserStartCalls(asFile('const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));'))).toEqual(['launch']);
    expect(browserStartCalls(asFile('await chromium\n  .launchPersistentContext(dir, options);'))).toEqual(['launchPersistentContext']);
    expect(browserStartCalls(asFile('await chromium.connectOverCDP(endpoint);'))).toEqual(['connectOverCDP']);
    expect(browserStartCalls(asFile('await launchChromium({ headless: true });'))).toEqual([]);
  });

  it('(a)(b)(c) keeps every Chromium start in the launch component, and the production launch sites call launchChromium', () => {
    const stopwatch = startCpuStopwatch();
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path !== LAUNCH_OWNER), browserStartCalls)).toEqual([]);
    expect([...sourceFileAt(SOURCE_FILES, LAUNCH_OWNER).bare.matchAll(PLAYWRIGHT_CHROMIUM_START_CALL)].map((match) => match[1])).toEqual(['launchPersistentContext']);
    for (const [path, count] of Object.entries(PRODUCTION_LAUNCH_SITES)) {
      expect(findCallSites(sourceFileAt(SOURCE_FILES, path).bare, 'launchChromium'), path).toHaveLength(count);
    }
    expect(stopwatch.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
