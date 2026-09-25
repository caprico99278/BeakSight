import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import type { Browser } from 'playwright';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import type { AuditConfig, Viewport } from '../config/types.js';
import { viewportSizeFor } from '../config/viewport-size.js';
import type { RunEnvironment } from '../core/contracts.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { isRecord } from '../core/guards.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';
import { closePassivePageAndContext, type PassiveSessionCloseFailure } from './passive-session-close.js';
import {
  openPassiveSessionBeforeDeadline,
  passiveSessionOpenDeadlineAtMs,
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type ResolvedPassiveSessionDeadlines,
} from './passive-session-open.js';

export interface CollectRunEnvironmentOptions {
  /** `loadConfig` で検証済みの設定。User-Agent を読むビューポートの大きさに使う。 */
  readonly config: AuditConfig;
  /** 起動した Chromium。起動できなかった場合（PREFLIGHT の失敗）は `null`。Chromium の版と User-Agent は `null` になる。 */
  readonly browser: Browser | null;
  /** User-Agent を読む Context を作る factory（PREFLIGHT が返したもの）。`null` なら、User-Agent は `null` になる。 */
  readonly factory: BrowserContextFactory | null;
  /**
   * User-Agent を読むために作った Context の Safety Ledger を受け取る。Context の構築に失敗した場合も、その Ledger を渡す。
   * Run Coordinator は、これを集計に使わない。Run の Safety は、Run の Ledger の登録（Coordinator が包んだ `createSafetyLedger` で
   * 作った、すべての Ledger）から集計する（設計書 5.6.5、R15 の I2）。この Ledger も、factory が作ったときに、その登録に入っている。
   */
  readonly onSafetyLedger: (ledger: SafetyLedger) => void;
  /**
   * User-Agent を読むために作った page と Context の、閉じる処理の失敗（期限切れを含む）を、起きた順に1件ずつ受け取る（RP18 の指摘1）。
   * page の作成が期限を過ぎて、作成の部品が Context を閉じた処理の失敗も含む。User-Agent の値は変えない。
   * 閉じる処理が期限を過ぎた場合は、Context が閉じたことを確かめられていない（後始末の未完了）ので、Run Coordinator は、これを
   * Run の理由にする（Run は `COMPLETE` にならない。Task 18 の前の整理の設計書 4.2）。失敗を捨てさせないため、省略できない。
   * 作成の期限を過ぎた後に遅れて届いた Context の後始末の結果は、ここに渡さない（設計書 4.2 のとおり捨てる）。
   */
  readonly onCloseFailure: (failure: PassiveSessionCloseFailure) => void;
  /**
   * User-Agent を読む Context と page の作成・終了の期限の注入口（DEF-008、R15r-4）。省略した項目は、`limits.ts` の定数を使う。
   */
  readonly deadlines?: PassiveSessionDeadlineOptions | undefined;
}

/** User-Agent を読むページ。Guard が許可する、ネットワークに出ないページである。 */
const USER_AGENT_PAGE_URL = 'about:blank';

/** Playwright の `package.json` の場所（Playwright の package の `exports` が公開している）。 */
const PLAYWRIGHT_PACKAGE_JSON = 'playwright/package.json';

/**
 * BeakSight の `package.json` の場所。`src/orchestration/` からも、ビルド後の `dist/orchestration/` からも、2つ上の
 * ディレクトリにある。
 */
const TOOL_PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);

/**
 * run.json に記録する環境の事実を集める（Task 14〜17 の設計書 5.5、5.6.7）。
 *
 * - Node の版、OS、CPU のアーキテクチャは、`process` と `os` から取る。
 * - Playwright の版は、Playwright の `package.json` から取る。
 * - Chromium の版は、`browser.version()` から取る。
 * - User-Agent は、ビューポート（Desktop、Mobile）ごとに、Guard の付いた Passive Context で `about:blank` を開き、
 *   `navigator.userAgent` を読む。対象のサイトにはアクセスしない。読めなかった場合は `null` にする。
 *
 *   Context と page の作成・終了は、期限付きで待つ（DEF-008）。作成が期限を過ぎた場合も、読めなかった場合と同じく `null` にする。
 *   閉じる処理の失敗（期限切れを含む）は、User-Agent の値を変えずに、`onCloseFailure` に渡す（RP18 の指摘1）。
 *
 * headed と headless、ビューポート、locale、timezone は、run.json の `effectiveConfig` が持つので、ここでは集めない。
 * 例外を投げるのは、引数が不正な場合（`TypeError`。注入した期限が正の安全な整数でない場合は `RangeError`）と、Playwright の
 * `package.json` が読めない場合だけである。
 */
export async function collectRunEnvironment(options: CollectRunEnvironmentOptions): Promise<RunEnvironment> {
  assertCollectRunEnvironmentOptions(options);
  const { config, browser, factory, onSafetyLedger, onCloseFailure } = options;
  const deadlines = resolvePassiveSessionDeadlines(options.deadlines);

  const chromiumVersion = browser === null ? null : browser.version();
  const readAgent = async (viewport: Viewport): Promise<string | null> => (
    browser === null || factory === null
      ? null
      : readUserAgent(factory, viewport, config, { onSafetyLedger, onCloseFailure }, deadlines)
  );
  // Desktop、Mobile の順に、1つずつ読む（同時に Context を開かない）。
  const desktop = await readAgent(viewportSizeFor(config, 'desktop'));
  const mobile = await readAgent(viewportSizeFor(config, 'mobile'));

  return Object.freeze({
    nodeVersion: process.version,
    platform: process.platform,
    osRelease: release(),
    arch: process.arch,
    playwrightVersion: readPlaywrightVersion(),
    chromiumVersion,
    userAgents: Object.freeze({ desktop, mobile }),
  });
}

/** BeakSight の版（run.json の `toolVersion`）を、BeakSight の `package.json` から読む。 */
export async function readToolVersion(): Promise<string> {
  return packageVersionOf(JSON.parse(await readFile(TOOL_PACKAGE_JSON_URL, 'utf8')) as unknown, 'BeakSight');
}

function assertCollectRunEnvironmentOptions(options: CollectRunEnvironmentOptions): void {
  if (!isRecord(options)) {
    throw new TypeError('run environment options are required');
  }
  if (!isRecord(options.config) || !isRecord(options.config.viewports)) {
    throw new TypeError('run environment requires a validated audit configuration');
  }
  if (typeof options.onSafetyLedger !== 'function') {
    throw new TypeError('run environment requires a Safety Ledger receiver function');
  }
  if (typeof options.onCloseFailure !== 'function') {
    throw new TypeError('run environment requires a close failure receiver function');
  }
  if (options.deadlines !== undefined && !isRecord(options.deadlines)) {
    throw new TypeError('run environment deadlines must be an object');
  }
}

function readPlaywrightVersion(): string {
  const manifest = createRequire(import.meta.url)(PLAYWRIGHT_PACKAGE_JSON) as unknown;
  return packageVersionOf(manifest, 'Playwright');
}

function packageVersionOf(manifest: unknown, packageLabel: string): string {
  const version = isRecord(manifest) ? manifest.version : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`${packageLabel} package.json does not have a version`);
  }
  return version;
}

/**
 * Guard の付いた Passive Context で `about:blank` を開き、`navigator.userAgent` を読む。作った Context と page は閉じる。
 * どこかで失敗した場合（Context の構築、ナビゲーション、評価）と、ナビゲーションと評価を合わせて `crawl.navigationTimeoutMs` までに
 * 終わらなかった場合は `null` を返す。Context と page の作成は `openPassiveSessionBeforeDeadline` で期限付きで待ち、期限を過ぎた場合も
 * `null` を返す（DEF-008。Context は部品が閉じる）。Context の Ledger は、構築に失敗した場合も含めて、Context ができていれば
 * `onSafetyLedger` に渡す。閉じる処理は `closePassivePageAndContext` で期限付きで待ち、その失敗は User-Agent の値を変えずに、
 * `onCloseFailure` に渡す（page の作成が期限を過ぎて、部品が Context を閉じた処理の失敗も渡す。RP18 の指摘1）。
 */
async function readUserAgent(
  factory: BrowserContextFactory,
  viewport: Viewport,
  config: AuditConfig,
  receivers: Pick<CollectRunEnvironmentOptions, 'onSafetyLedger' | 'onCloseFailure'>,
  deadlines: ResolvedPassiveSessionDeadlines,
): Promise<string | null> {
  const { onSafetyLedger, onCloseFailure } = receivers;
  const opened = await openPassiveSessionBeforeDeadline(
    factory,
    viewport,
    passiveSessionOpenDeadlineAtMs({ timeoutMs: deadlines.sessionOpenTimeoutMs }),
    deadlines,
  );
  // 期限を過ぎた場合は、Context は部品が閉じた（または、遅れて届いたときに閉じる）ので、閉じ直さない（`context` は `undefined`）。
  const context = opened.status === 'DEADLINE_EXCEEDED' ? undefined : opened.context;
  const page = opened.status === 'OPENED' ? opened.page : undefined;
  let userAgent: string | null = null;
  try {
    if (opened.ledger !== null) {
      onSafetyLedger(opened.ledger);
    }
    if (page !== undefined) {
      // ナビゲーションと読み取りを合わせて、`crawl.navigationTimeoutMs` までに終える（R15 の Minor-2）。読み取りが期限を過ぎた場合と、
      // 失敗した場合は `null` にする。期限を過ぎた後に遅れて返る結果と例外は、封じ込める（`awaitBeforeDeadline`）。
      const deadlineAtMs = Date.now() + config.crawl.navigationTimeoutMs;
      await page.goto(USER_AGENT_PAGE_URL, { timeout: config.crawl.navigationTimeoutMs });
      const read = await awaitBeforeDeadline(page.evaluate(() => navigator.userAgent), deadlineAtMs);
      const value: unknown = read.status === 'FULFILLED' ? read.value : null;
      userAgent = typeof value === 'string' && value.length > 0 ? value : null;
    }
  } catch {
    userAgent = null;
  }
  // 閉じるのに失敗した場合は、Guard がその Ledger に違反を記録する（Run の Safety の集計に入る）。User-Agent の値は変えない。
  // 閉じる処理の失敗と期限切れは、捨てずに呼び出し側に渡す（RP18 の指摘1）。page の作成が期限を過ぎた場合は、部品が Context を
  // 閉じた処理の失敗（`opened.closeFailures`）を先に渡す。
  const closeFailures = [
    ...(opened.status === 'DEADLINE_EXCEEDED' ? opened.closeFailures : []),
    ...(await closePassivePageAndContext(factory, context, page, deadlines)),
  ];
  for (const failure of closeFailures) {
    onCloseFailure(failure);
  }
  return userAgent;
}
