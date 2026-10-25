/**
 * 表示の側が Playwright を読み込まないことの Architecture Gate（BN-c の fix。発見事項 1。設計書 `2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`
 * 6.1.8 の「レポートは Playwright を読み込まない」）。
 * - `src/report/**` の各ファイルから、実行時に読み込む import（型だけの import はたどらない）を `src/` の中でたどった先に、Playwright のパッケージ
 *   （`playwright`、`playwright-core`、`@playwright/*`、`@axe-core/playwright`）が現れない。Playwright を読むモジュール（例: `src/browser/playwright-errors.ts`）を
 *   経由して届く場合も、たどった道（`<始まり> -> … -> playwright`）で違反にする。
 * - 判定は、`fs`、正規表現、文字列の走査だけ（`source-scan.ts` の共通の部品 `findTransitiveForbiddenReferences`）。`src/**` の読み込みは、このファイルの
 *   読み込み時に 1 回だけ。1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  PLAYWRIGHT_PACKAGE_PATTERN,
  findTransitiveForbiddenReferences,
  loadSourceFiles,
  scanSource,
  startCpuStopwatch,
  type ScannedSource,
} from './source-scan.js';

// 測りは、検査の本体（`src/**` の 1 回の読み込みと判定）の直前に始める（import の読み込みと変換は、この行の前に済む。CPU の時間。TS-d）。
const GATE_STOPWATCH = startCpuStopwatch();
const SOURCE_FILES = loadSourceFiles();
const REPORT_DIRECTORY = 'src/report/';
// 1 ファイルの検査の上限（ms。UI追補設計書 6 章・`beaksight-dev` の 6.3）は、`source-scan.ts` の `MAX_GATE_MS`（PRE42-CC 組 G）。

/** `starts` から実行時の import をたどって、Playwright のパッケージに届いた道。 */
const playwrightChainsFrom = (files: ReadonlyMap<string, ScannedSource>, starts: readonly string[]): readonly string[] =>
  findTransitiveForbiddenReferences(files, starts, () => false, (specifier) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier));

describe('report Playwright boundary detector (BN-c fix)', () => {
  it('reports a report file that reaches Playwright directly or through another module, and ignores type-only imports', () => {
    const files = new Map<string, ScannedSource>([
      ['src/report/direct.ts', scanSource("import { chromium } from 'playwright';")],
      ['src/report/indirect.ts', scanSource("import { isBlocked } from '../browser/errors.js';")],
      ['src/browser/errors.ts', scanSource("import { errors } from 'playwright-core';\nexport const isBlocked = () => errors;")],
      ['src/report/types-only.ts', scanSource("import type { Page } from 'playwright';\nimport type { X } from '../browser/errors.js';")],
      ['src/report/clean.ts', scanSource("import { isBlockedByClientFailure } from '../core/blocked-by-client-failures.js';")],
      ['src/core/blocked-by-client-failures.ts', scanSource('export const isBlockedByClientFailure = () => true;')],
    ]);
    expect(playwrightChainsFrom(files, ['src/report/direct.ts', 'src/report/indirect.ts', 'src/report/types-only.ts', 'src/report/clean.ts'])).toEqual([
      'src/report/direct.ts -> playwright',
      'src/report/indirect.ts -> src/browser/errors.ts -> playwright-core',
    ]);
  });
});

describe('report Playwright boundary (BN-c fix)', () => {
  it('src/report/** does not load Playwright at run time, directly or through the modules it imports', () => {
    const starts = SOURCE_FILES.filter((file) => file.path.startsWith(REPORT_DIRECTORY)).map((file) => file.path);
    for (const expected of ['src/report/view-model.ts', 'src/report/beaksight-block-relation.ts', 'src/report/chatgpt-bundle.ts']) {
      expect(starts, expected).toContain(expected);
    }
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(playwrightChainsFrom(files, starts)).toEqual([]);
  });

  it('finishes the gate within the time limit', () => {
    expect(GATE_STOPWATCH.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
