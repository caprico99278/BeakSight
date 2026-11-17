/**
 * Architecture Gate（RB-1。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 3.1）: Playwright を import してよい所の正の一覧と、ブラウザに頼む口の
 * 型の owner。判定は `fs`、正規表現、文字列の走査だけ（`source-scan.ts` の共通の部品）。
 * - (a) `src/` で Playwright のパッケージ（`PLAYWRIGHT_PACKAGE_PATTERN`。型だけの import を含む）を参照してよいのは、本物の口の adapter の所
 *   （`src/browser/playwright/**`）だけ。移る途中の例外は、ファイル → 参照の数の閉じた一覧（`MIGRATING_FILES`）。数が変わったら（減らしたら、
 *   一覧も減らす）誤りにする。使われなくなった例外も誤りにする。段ごとに一覧を減らし、最後に空にする。
 * - (b) 口の型（印・結果・事象）を定義するのは `src/browser/port/browser-port.ts` だけ。口の型のファイルからは、実行時の import をたどっても
 *   Playwright に届かない。
 * - ファイル全体を 1 秒以内に終える。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_GATE_MS,
  PLAYWRIGHT_PACKAGE_PATTERN,
  findModuleSpecifiers,
  findTransitiveForbiddenReferences,
  isPathUnder,
  judgeWithFileExceptions,
  loadSourceFiles,
  scanSource,
  startCpuStopwatch,
  violationsOf,
  type FileExceptions,
  type ScannedSource,
} from './source-scan.js';

const GATE_STOPWATCH = startCpuStopwatch();
const SOURCE_FILES = loadSourceFiles();

/** Playwright を import してよい所（本物の口の adapter）。 */
const ADAPTER_DIRECTORY = 'src/browser/playwright/';
/** 口の型の owner。 */
const PORT_TYPES_FILE = 'src/browser/port/browser-port.ts';
/** 口の型の名前（定義は owner だけ）。 */
const PORT_TYPE_NAMES: readonly string[] = Object.freeze([
  'BrowserHandle',
  'ContextHandle',
  'PageHandle',
  'ElementRef',
  'PortOutcome',
  'NavigationOutcome',
  'PageEvent',
  'NetworkEvent',
  'NamedPageReader',
  'NamedElementReader',
  'BrowserPort',
  'ReadOnlyPagePort',
]);

const MIGRATING = '移る途中（口の操作へ移す段で外す）';
const migrating = (count: number): { readonly count: number; readonly reason: string } => Object.freeze({ count, reason: MIGRATING });

/** (a) 移る途中の例外（ファイル → Playwright のパッケージの参照の数。RB-1 の時点で 62 ファイル・63 の参照）。 */
const MIGRATING_FILES: FileExceptions = Object.freeze({
  'src/browser/api-write-submitter.ts': migrating(1),
  'src/browser/chromium-launch.ts': migrating(1),
  'src/browser/collector-watch.ts': migrating(1),
  'src/browser/context-factory.ts': migrating(1),
  'src/browser/controlled-scroll.ts': migrating(1),
  'src/browser/element-path-engine.ts': migrating(1),
  'src/browser/form-submission-common.ts': migrating(1),
  'src/browser/login-form-submitter.ts': migrating(1),
  'src/browser/main-frame-load.ts': migrating(1),
  'src/browser/page-failure.ts': migrating(1),
  'src/browser/page-progress-signals.ts': migrating(1),
  'src/browser/page-settling.ts': migrating(1),
  'src/browser/playwright-errors.ts': migrating(1),
  'src/browser/write-form-submitter.ts': migrating(1),
  'src/crawl/discover-links.ts': migrating(1),
  'src/crawl/site-metadata.ts': migrating(1),
  'src/discovery/cdp-session.ts': migrating(1),
  'src/discovery/discover-page.ts': migrating(1),
  'src/discovery/isolated-read.ts': migrating(1),
  'src/discovery/listeners.ts': migrating(1),
  'src/discovery/probe.ts': migrating(1),
  'src/discovery/read-executor.ts': migrating(1),
  'src/discovery/screen-watch.ts': migrating(1),
  'src/discovery/settle.ts': migrating(1),
  'src/evidence/accessibility-ax.ts': migrating(1),
  'src/evidence/accessibility-collector.ts': migrating(2),
  'src/evidence/console-collector.ts': migrating(1),
  'src/evidence/dom-collector.ts': migrating(1),
  'src/evidence/error-display-collector.ts': migrating(1),
  'src/evidence/focus-check-collector.ts': migrating(1),
  'src/evidence/layout-collector.ts': migrating(1),
  'src/evidence/media-query-widths.ts': migrating(1),
  'src/evidence/network-collector.ts': migrating(1),
  'src/evidence/performance-collector.ts': migrating(1),
  'src/evidence/screenshot-collector.ts': migrating(1),
  'src/interaction/discover-candidates.ts': migrating(1),
  'src/interaction/isolated-auditor.ts': migrating(1),
  'src/interaction/notification-overlay.ts': migrating(1),
  'src/interaction/submission-probe.ts': migrating(1),
  'src/orchestration/authenticated-run.ts': migrating(1),
  'src/orchestration/environment.ts': migrating(1),
  'src/orchestration/page-auditor.ts': migrating(1),
  'src/orchestration/page-navigation.ts': migrating(1),
  'src/orchestration/passive-session-close.ts': migrating(1),
  'src/orchestration/passive-session-open.ts': migrating(1),
  'src/orchestration/preflight.ts': migrating(1),
  'src/orchestration/run-coordinator.ts': migrating(1),
  'src/orchestration/stress-session.ts': migrating(1),
  'src/orchestration/stress-width-end.ts': migrating(1),
  'src/orchestration/visible-pacing-wait.ts': migrating(1),
  'src/safety/audit-send-websocket-observer.ts': migrating(1),
  // RB-14b（設計者の判断）: 止める道の adapter の本体（CDP の Fetch・route・OOPIF・ポップアップ・閉じる順）。判定の芯（`classifyPassiveRequest`・
  // `decideGuardRequest`）は Playwright に触れない。`src/browser/playwright/` へ移すかは、仕上げの段の口の置き場所の判断で決める。
  'src/safety/passive-request-guard.ts': Object.freeze({
    count: 1,
    reason: '止める道の adapter の本体（判定の芯は Playwright に触れない。置き場所は仕上げの段で決める）',
  }),
  'src/worker/authenticated-login.ts': migrating(1),
  'src/worker/automated-login.ts': migrating(1),
  'src/worker/entry-check-page.ts': migrating(1),
  'src/worker/login-credential-capture.ts': migrating(1),
  'src/worker/login-end-detection.ts': migrating(1),
  'src/worker/login-stage-checks.ts': migrating(1),
  'src/worker/login-stage-observation.ts': migrating(1),
  'src/worker/read-check-run.ts': migrating(1),
  'src/worker/worker-run-session.ts': migrating(1),
  'src/worker/write-create-run.ts': migrating(1),
});

/** (a) ファイルが参照する Playwright のパッケージ（指定子。型だけの import を含む）。 */
const playwrightReferencesOf = (source: Pick<ScannedSource, 'code'>): readonly string[] =>
  findModuleSpecifiers(source.code).filter((specifier) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier));

/** (b) 口の型の名前の定義（`interface X`・`type X =`・`class X`）。 */
const portTypeDefinitionsOf = (source: Pick<ScannedSource, 'bare'>): readonly string[] =>
  PORT_TYPE_NAMES.filter((name) => new RegExp(`\\b(?:interface|class)\\s+${name}\\b|\\btype\\s+${name}\\b\\s*(?:<[^=]*>)?\\s*=`, 'u').test(source.bare));

describe('RB-1: Playwright import allowlist detector', () => {
  it('(a) counts value and type-only references to the Playwright packages', () => {
    expect(playwrightReferencesOf(scanSource([
      "import { chromium } from 'playwright';",
      "import type { Page } from 'playwright-core';",
      "import { AxeBuilder } from '@axe-core/playwright';",
      "import { wait } from '../core/deadline.js';",
      "// import { x } from 'playwright';",
    ].join('\n')))).toEqual(['playwright', 'playwright-core', '@axe-core/playwright']);
  });

  it('(b) finds a definition of a port type and ignores its use', () => {
    expect(portTypeDefinitionsOf(scanSource('export interface PageHandle { readonly id: string }\ntype PortOutcome<T> = T;'))).toEqual(['PageHandle', 'PortOutcome']);
    expect(portTypeDefinitionsOf(scanSource("import type { PageHandle } from './port.js';\nconst f = (p: PageHandle): void => undefined;"))).toEqual([]);
  });
});

describe('RB-1: Playwright import allowlist and the port type owner', () => {
  it('(a) only the adapter imports Playwright in src/, apart from the counted migrating files', () => {
    const judgement = judgeWithFileExceptions(
      SOURCE_FILES.filter((file) => !isPathUnder(file.path, ADAPTER_DIRECTORY)),
      playwrightReferencesOf,
      MIGRATING_FILES,
    );
    expect(judgement.found).toEqual([]);
    expect(judgement.countMismatches).toEqual([]);
    expect(judgement.unusedExceptions).toEqual([]);
  });

  it('(b) defines the port types only in the owner, which does not reach Playwright at run time', () => {
    expect(violationsOf(SOURCE_FILES.filter((file) => file.path !== PORT_TYPES_FILE), portTypeDefinitionsOf)).toEqual([]);
    const owner = SOURCE_FILES.find((file) => file.path === PORT_TYPES_FILE);
    expect(owner === undefined ? [] : portTypeDefinitionsOf(owner)).toEqual(PORT_TYPE_NAMES);
    const files = new Map<string, ScannedSource>(SOURCE_FILES.map((file) => [file.path, file]));
    expect(findTransitiveForbiddenReferences(files, [PORT_TYPES_FILE], () => false, (specifier) => PLAYWRIGHT_PACKAGE_PATTERN.test(specifier))).toEqual([]);
  });

  it('finishes the gate within the time limit', () => {
    expect(GATE_STOPWATCH.elapsedMs()).toBeLessThan(MAX_GATE_MS);
  });
});
