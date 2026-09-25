import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { BrowserContextFactory, type SafetyLedgerFactory } from '../browser/context-factory.js';
import type { AuditConfig } from '../config/types.js';
import type { IncompleteReason } from '../core/contracts.js';
import { awaitBeforeDeadline, resolveTimeoutMs } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import { isRecord } from '../core/guards.js';
import { BROWSER_CLOSE_TIMEOUT_MS, MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import { validateArtifact } from '../core/schema-validator.js';
import { classifyUrl } from '../crawl/admission-policy.js';
import { assertPassiveRequestGuardActive } from '../safety/passive-request-guard.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';
import { closePassivePageAndContext, type PassiveSessionCloseFailure } from './passive-session-close.js';
import {
  openPassiveSessionBeforeDeadline,
  passiveSessionOpenDeadlineAtMs,
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type ResolvedPassiveSessionDeadlines,
} from './passive-session-open.js';

/**
 * PREFLIGHT で確かめる項目（Task 14〜17 の設計書 5.6.7）。この順に確かめ、最初に失敗した項目で止まる。
 * 失敗した場合の `IncompleteReason.detail` は、この項目の名前。
 */
export const PREFLIGHT_CHECKS = Object.freeze([
  /** 出力先のディレクトリを作り、一時ファイルを書いて消せる。 */
  'OUTPUT_DIRECTORY',
  /** artifact のスキーマを読み込める（`validateArtifact` を小さな見本で呼ぶ）。 */
  'SCHEMA',
  /** 開始の URL が、`classifyUrl` で `INTERNAL_NAVIGABLE` になる。 */
  'START_URL',
  /** Chromium を起動できる。 */
  'BROWSER_LAUNCH',
  /** Guard の付いた Passive Context と page を作れて、Guard が有効である（作った Context と page は、すぐに閉じる）。 */
  'PASSIVE_GUARD',
] as const);
export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number];

/** Browser を閉じる処理が期限（`BROWSER_CLOSE_TIMEOUT_MS`）の中で終わらなかったときの、失敗のメッセージ（R15 の Minor-2）。 */
export const BROWSER_CLOSE_DEADLINE_MESSAGE = 'Browser close did not finish before its deadline';

/**
 * Browser を閉じる（R15 の Minor-2。Browser を期限付きで閉じる処理は、ここだけで行う）。終わりを待つのは `options.timeoutMs`
 * （既定は `BROWSER_CLOSE_TIMEOUT_MS`。R15r-4 で注入できるようにした）までである。
 * - 期限の中で終われば `null`、失敗すれば `{ error }`（閉じる処理が投げた値そのもの）を返す。
 * - 期限を過ぎた場合は、`BROWSER_CLOSE_DEADLINE_MESSAGE` の `Error` を `error` にして返す。期限を過ぎた後に遅れて返る結果と
 *   例外は、封じ込める（`awaitBeforeDeadline`）。
 * 例外を投げる（reject する）のは、`options.timeoutMs` が正の安全な整数でない場合（`RangeError`）だけで、そのときは閉じない。
 * 例外にするか、理由として記録するかは、呼び出し側（PREFLIGHT と Run Coordinator）が決める。
 */
export async function closeBrowserBeforeDeadline(
  browser: Pick<Browser, 'close'>,
  options: { readonly timeoutMs?: number | undefined } = {},
): Promise<{ readonly error: unknown } | null> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, BROWSER_CLOSE_TIMEOUT_MS);
  const outcome = await awaitBeforeDeadline(
    (async (): Promise<void> => browser.close())(),
    Date.now() + timeoutMs,
  );
  switch (outcome.status) {
    case 'FULFILLED':
      return null;
    case 'REJECTED':
      return Object.freeze({ error: outcome.reason });
    case 'DEADLINE_EXCEEDED':
      return Object.freeze({ error: new Error(BROWSER_CLOSE_DEADLINE_MESSAGE) });
  }
}

/** Chromium を起動する関数（注入する）。本番では `chromium.launch` を渡す。 */
export type BrowserLauncher = (options: { readonly headless: boolean }) => Promise<Browser>;

export interface PreflightOptions {
  /** `loadConfig` で検証済みの設定。 */
  readonly config: AuditConfig;
  readonly launchBrowser: BrowserLauncher;
  /** Context ごとに新しい `SafetyLedger` を作る関数。返す `BrowserContextFactory` も、この関数を使う。 */
  readonly createSafetyLedger: SafetyLedgerFactory;
  /** Run の artifact の出力先のディレクトリ。なければ作る。 */
  readonly outputDirectory: string;
  /**
   * Guard を確かめる Context と page の作成・終了と、失敗した場合に Browser を閉じる処理の期限の注入口（DEF-008、R15r-4）。
   * 省略した項目は、`limits.ts` の定数を使う。
   */
  readonly deadlines?: PreflightDeadlines | undefined;
}

/** PREFLIGHT の期限の注入口。作成と終了の期限（`PassiveSessionDeadlineOptions`）に、Browser を閉じる処理の期限を加えたもの。 */
export interface PreflightDeadlines extends PassiveSessionDeadlineOptions {
  /** 失敗した場合に Browser を閉じる処理を待つ上限（ms）。既定は `BROWSER_CLOSE_TIMEOUT_MS`。 */
  readonly browserCloseTimeoutMs?: number | undefined;
}

export interface PreflightSuccess {
  readonly ok: true;
  /** 起動した Chromium。閉じるのは、呼び出し側（Run Coordinator）である。 */
  readonly browser: Browser;
  /** `browser` と `config` と `createSafetyLedger` で作った factory。Run の Context は、これで作る。 */
  readonly factory: BrowserContextFactory;
  /**
   * Guard を確かめるために作った Context の Ledger。Run Coordinator は、これを集計に使わない。Run の Safety は、Run の Ledger の登録
   * （Coordinator が包んだ `createSafetyLedger` で作った、すべての Ledger）から集計する（設計書 5.6.5、R15 の I2）。
   * この Ledger も、`createSafetyLedger` で作ったときに、その登録に入っている。
   */
  readonly safetyLedgers: readonly SafetyLedger[];
}

export interface PreflightFailure {
  readonly ok: false;
  /** 最初に失敗した項目。 */
  readonly failedCheck: PreflightCheck;
  /** 失敗の内容（`MAX_ERROR_MESSAGE_LENGTH` 以内）。 */
  readonly message: string;
  /** Run の未完了の理由。コードは `PREFLIGHT_FAILED`、`detail` は `failedCheck`。 */
  readonly reason: IncompleteReason;
  /**
   * Guard を確かめるために作った Context の Ledger（Guard の取り付けの失敗などの違反を含む）。作る前に失敗した場合は空。
   * Run Coordinator は、これを集計に使わず、Run の Ledger の登録から集計する（`PreflightSuccess.safetyLedgers` と同じ）。
   */
  readonly safetyLedgers: readonly SafetyLedger[];
}

export type PreflightResult = PreflightSuccess | PreflightFailure;

/** 確かめる処理が返す、失敗の内容。`undefined` は成功。 */
type CheckOutcome = string | undefined;

/** 確かめた結果。例外の値が `undefined` でも失敗と区別できるよう、成功と失敗を形で分ける。 */
type CheckResult = { readonly passed: true } | { readonly passed: false; readonly failure: unknown };

const PASSED: CheckResult = Object.freeze({ passed: true });
const failed = (failure: unknown): CheckResult => ({ passed: false, failure });

const PREFLIGHT_TEMPORARY_FILE_PREFIX = '.beaksight-preflight-';
const PREFLIGHT_TEMPORARY_FILE_SUFFIX = '.tmp';

/**
 * Run の前の確認（PREFLIGHT。Task 14〜17 の設計書 5.6.7）。`PREFLIGHT_CHECKS` の順に確かめる。
 *
 * - 対象のサイトには、アクセスしない（Guard の確認では、page を作るだけで、ナビゲーションしない）。
 * - 成功した場合は、起動した Browser と、Run で使う `BrowserContextFactory` を返す。
 * - 失敗した場合は、失敗した項目、上限付きのメッセージ、`PREFLIGHT_FAILED` の理由を返す。起動した Chromium は閉じる。
 * - Guard を確かめる Context と page の作成・終了は、期限付きで待つ（DEF-008）。期限を過ぎた場合は `PASSIVE_GUARD` の失敗にする。
 * - 例外を投げるのは、引数が不正な場合（`TypeError`。注入した期限が正の安全な整数でない場合は `RangeError`）だけである。
 */
export async function runPreflight(options: PreflightOptions): Promise<PreflightResult> {
  assertPreflightOptions(options);
  const { config, launchBrowser, createSafetyLedger, outputDirectory } = options;
  const sessionDeadlines = resolvePassiveSessionDeadlines(options.deadlines);
  const browserCloseTimeoutMs = resolveTimeoutMs(options.deadlines?.browserCloseTimeoutMs, BROWSER_CLOSE_TIMEOUT_MS);

  const earlyChecks: readonly (readonly [PreflightCheck, () => Promise<CheckOutcome>])[] = [
    ['OUTPUT_DIRECTORY', () => checkOutputDirectory(outputDirectory)],
    ['SCHEMA', checkSchemas],
    ['START_URL', async () => checkStartUrl(config)],
  ];
  for (const [check, run] of earlyChecks) {
    const result = await runCheck(run);
    if (!result.passed) {
      return preflightFailure(check, result.failure, []);
    }
  }

  let browser: Browser;
  try {
    browser = await launchBrowser({ headless: !config.browser.headed });
  } catch (error) {
    return preflightFailure('BROWSER_LAUNCH', error, []);
  }

  const safetyLedgers: SafetyLedger[] = [];
  let guardFailure: unknown;
  try {
    const factory = new BrowserContextFactory(browser, config, createSafetyLedger);
    const guard = await checkPassiveGuard(factory, config, safetyLedgers, sessionDeadlines);
    if (guard.passed) {
      // Browser、factory、Ledger は、呼び出し側が使い続けるので、凍結しない（結果の外側と一覧だけを凍結する）。
      return Object.freeze({ ok: true, browser, factory, safetyLedgers: Object.freeze([...safetyLedgers]) });
    }
    guardFailure = guard.failure;
  } catch (error) {
    guardFailure = error;
  }

  // 失敗した場合は、起動した Chromium を閉じる（Context も一緒に閉じる）。閉じるのに失敗した場合と、期限
  // （`BROWSER_CLOSE_TIMEOUT_MS`）を過ぎた場合は、メッセージに加える。
  let message = describe(guardFailure);
  const closeFailure = await closeBrowserBeforeDeadline(browser, { timeoutMs: browserCloseTimeoutMs });
  if (closeFailure !== null) {
    message = `${message}; browser close failed: ${describe(closeFailure.error)}`;
  }
  return preflightFailure('PASSIVE_GUARD', message, safetyLedgers);
}

function assertPreflightOptions(options: PreflightOptions): void {
  if (!isRecord(options)) {
    throw new TypeError('preflight options are required');
  }
  if (!isRecord(options.config) || !isRecord(options.config.site) || !isRecord(options.config.browser)) {
    throw new TypeError('preflight requires a validated audit configuration');
  }
  if (typeof options.launchBrowser !== 'function') {
    throw new TypeError('preflight requires a browser launcher function');
  }
  if (typeof options.createSafetyLedger !== 'function') {
    throw new TypeError('preflight requires a Safety Ledger factory function');
  }
  if (typeof options.outputDirectory !== 'string' || options.outputDirectory.length === 0) {
    throw new TypeError('preflight requires a non-empty output directory');
  }
  if (options.deadlines !== undefined && !isRecord(options.deadlines)) {
    throw new TypeError('preflight deadlines must be an object');
  }
}

/** 確かめる処理の例外も、失敗として扱う。 */
async function runCheck(run: () => Promise<CheckOutcome>): Promise<CheckResult> {
  try {
    const outcome = await run();
    return outcome === undefined ? PASSED : failed(outcome);
  } catch (error) {
    return failed(error);
  }
}

async function checkOutputDirectory(outputDirectory: string): Promise<CheckOutcome> {
  await mkdir(outputDirectory, { recursive: true });
  const temporaryFile = join(
    outputDirectory,
    `${PREFLIGHT_TEMPORARY_FILE_PREFIX}${randomUUID()}${PREFLIGHT_TEMPORARY_FILE_SUFFIX}`,
  );
  // 既存のファイルを上書きしないよう、新しく作る場合だけ書く（`wx`）。
  await writeFile(temporaryFile, '', { flag: 'wx' });
  await unlink(temporaryFile);
  return undefined;
}

/**
 * スキーマを読み込めるかを、`validateArtifact` を小さな見本（`null`）で呼んで確かめる。
 * 読み込みに失敗した場合は、`validateArtifact` が reject する。`null` は run のスキーマに合わないので、合うと判定された場合は、
 * 検証が働いていないとみなして失敗にする。
 */
async function checkSchemas(): Promise<CheckOutcome> {
  const result = await validateArtifact('run', null);
  return result.ok ? 'artifact schema validation accepted an empty sample' : undefined;
}

function checkStartUrl(config: AuditConfig): CheckOutcome {
  let startUrl: URL;
  try {
    startUrl = new URL(config.site.startUrl);
  } catch {
    return 'start URL is not a valid URL';
  }
  const admission = classifyUrl(startUrl, { allowedOrigins: new Set(config.site.allowedOrigins) });
  if (admission.kind === 'INTERNAL_NAVIGABLE') {
    return undefined;
  }
  const reason = admission.kind === 'REJECTED_INVALID' ? `: ${admission.reason}` : '';
  return `start URL is not INTERNAL_NAVIGABLE (${admission.kind}${reason})`;
}

/**
 * Guard の付いた Passive Context と page を作り、Guard が有効であることを確かめてから、すぐに閉じる。
 * page は作るだけで、ナビゲーションしない（対象のサイトにアクセスしない）。作った Context の Ledger は `safetyLedgers` に加える。
 * 閉じるのに失敗した場合と、Ledger に違反が記録された場合も、失敗にする。
 * Context と page の作成と、閉じる処理は、期限付きで待つ（`openPassiveSessionBeforeDeadline`、`closePassivePageAndContext`。DEF-008）。
 * 作成が期限を過ぎた場合は、`PassiveSessionOpenDeadlineError` の失敗にする（Context は部品が閉じる）。
 * 失敗が決まっている場合（作成の失敗、期限切れ、Guard が無効）も、閉じる処理の失敗（期限切れを含む）を、その失敗のメッセージに
 * `; guarded <手順> close failed: <内容>` の形で加える（RP18r の Minor-1）。
 */
async function checkPassiveGuard(
  factory: BrowserContextFactory,
  config: AuditConfig,
  safetyLedgers: SafetyLedger[],
  deadlines: ResolvedPassiveSessionDeadlines,
): Promise<CheckResult> {
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let result = PASSED;
  const opened = await openPassiveSessionBeforeDeadline(
    factory,
    config.viewports.primaryDesktop,
    passiveSessionOpenDeadlineAtMs({ timeoutMs: deadlines.sessionOpenTimeoutMs }),
    deadlines,
  );
  if (opened.ledger !== null && !safetyLedgers.includes(opened.ledger)) {
    safetyLedgers.push(opened.ledger);
  }
  switch (opened.status) {
    case 'OPENED':
      ({ context, page } = opened);
      try {
        assertPassiveRequestGuardActive(context);
      } catch (error) {
        result = failed(error);
      }
      break;
    case 'FAILED':
      ({ context } = opened);
      result = failed(opened.error);
      break;
    case 'DEADLINE_EXCEEDED':
      // Context は、部品が閉じた（または、遅れて届いたときに閉じる）。部品が閉じた処理の失敗（期限切れを含む）は、
      // 作成の期限切れのメッセージに加える（RP18r の Minor-1）。
      return failedWithCloseFailures(opened.error, opened.closeFailures);
  }

  const closeFailures = await closePassivePageAndContext(factory, context, page, deadlines);
  if (!result.passed) {
    // すでに失敗が決まっている場合も、閉じる処理の失敗を、その失敗のメッセージに加える（RP18r の Minor-1）。
    return failedWithCloseFailures(result.failure, closeFailures);
  }
  const [firstCloseFailure] = closeFailures;
  if (firstCloseFailure !== undefined) {
    return failed(describeCloseFailure(firstCloseFailure));
  }
  const violations = safetyLedgers.reduce((count, ledger) => count + ledger.snapshot().invariantViolationCount, 0);
  if (violations > 0) {
    return failed(`passive request guard recorded ${violations} invariant violation(s)`);
  }
  return PASSED;
}

function describe(error: unknown): string {
  return safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH);
}

/** Guard を確かめる Context と page の、閉じる処理の失敗1つの文言（`guarded <手順> close failed: <内容>`）。 */
function describeCloseFailure(closeFailure: PassiveSessionCloseFailure): string {
  return `guarded ${closeFailure.step} close failed: ${describe(closeFailure.error)}`;
}

/**
 * すでに決まった失敗に、閉じる処理の失敗（期限切れを含む）を、起きた順に `; ` で加えた失敗（RP18r の Minor-1）。
 * 閉じる処理の失敗がなければ、元の失敗をそのまま返す。
 */
function failedWithCloseFailures(failure: unknown, closeFailures: readonly PassiveSessionCloseFailure[]): CheckResult {
  if (closeFailures.length === 0) {
    return failed(failure);
  }
  return failed([describe(failure), ...closeFailures.map(describeCloseFailure)].join('; '));
}

function preflightFailure(
  failedCheck: PreflightCheck,
  failure: unknown,
  safetyLedgers: readonly SafetyLedger[],
): PreflightFailure {
  // Ledger は、呼び出し側が集計に使い続けるので、凍結しない（結果の外側と、理由と、一覧だけを凍結する）。
  return Object.freeze({
    ok: false,
    failedCheck,
    message: describe(failure),
    reason: Object.freeze({ code: 'PREFLIGHT_FAILED', detail: failedCheck }),
    safetyLedgers: Object.freeze([...safetyLedgers]),
  });
}
