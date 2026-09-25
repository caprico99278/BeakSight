import type { BrowserContext, Page } from 'playwright';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { awaitBeforeDeadline, resolveTimeoutMs } from '../core/deadline.js';
import { CONTEXT_CLOSE_TIMEOUT_MS, PAGE_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import { isPassiveRequestGuardClosed } from '../safety/passive-request-guard.js';

/** 閉じる処理のどの手順で失敗したか。`page` は page を閉じる処理、`context` は Context を閉じる処理。 */
export type PassiveSessionCloseStep = 'page' | 'context';

/** page を閉じる処理が期限（`PAGE_CLOSE_TIMEOUT_MS`）の中で終わらなかったときの、失敗のメッセージ（DEF-006）。 */
export const PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE = 'Passive page close did not finish before its deadline';

/** Context を閉じる処理が期限（`CONTEXT_CLOSE_TIMEOUT_MS`）の中で終わらなかったときの、失敗のメッセージ（DEF-008）。 */
export const PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE = 'Passive Context close did not finish before its deadline';

/**
 * page を閉じる処理が期限（`PAGE_CLOSE_TIMEOUT_MS`）の中で終わらなかったことを表す失敗（DEF-006）。
 * メッセージは `PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE`。呼び出し側は、閉じる処理が拒否された場合と区別するために使う。
 */
export class PassivePageCloseDeadlineError extends Error {
  constructor() {
    super(PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE);
    this.name = 'PassivePageCloseDeadlineError';
  }
}

/**
 * Context を閉じる処理が期限（`CONTEXT_CLOSE_TIMEOUT_MS`）の中で終わらなかったことを表す失敗（DEF-008。Task 18 の前の整理の設計書 4.2）。
 * メッセージは `PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE`。違反ではなく、閉じる処理の失敗として記録する（Run は `COMPLETE` にならない）。
 */
export class PassiveContextCloseDeadlineError extends Error {
  constructor() {
    super(PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE);
    this.name = 'PassiveContextCloseDeadlineError';
  }
}

/**
 * 閉じる処理の失敗1つ。`error` は、閉じる処理が投げた値そのもの（加工しない）。
 * 閉じる処理が期限を過ぎた場合は、`PassivePageCloseDeadlineError`（page）か `PassiveContextCloseDeadlineError`（Context）である。
 */
export interface PassiveSessionCloseFailure {
  readonly step: PassiveSessionCloseStep;
  readonly error: unknown;
}

/** 1つの閉じる処理を待つ時間の上限（ms）の注入口（R15r-4）。省略すると、既定の定数を使う。 */
export interface PassiveCloseDeadlineOptions {
  /** 待つ時間の上限（ms）。正の安全な整数。 */
  readonly timeoutMs?: number | undefined;
}

/** page と Context を閉じる処理を待つ時間の上限（ms）の注入口（R15r-4）。省略した項目は、既定の定数を使う。 */
export interface PassiveSessionCloseTimeouts {
  /** page を閉じる処理を待つ上限。既定は `PAGE_CLOSE_TIMEOUT_MS`。 */
  readonly pageCloseTimeoutMs?: number | undefined;
  /** Context を閉じる処理を待つ上限。既定は `CONTEXT_CLOSE_TIMEOUT_MS`。 */
  readonly contextCloseTimeoutMs?: number | undefined;
}

/**
 * Guard の付いた Passive の page を、factory の `closePassivePage` で閉じる。終わりを待つのは `options.timeoutMs`
 * （既定は `PAGE_CLOSE_TIMEOUT_MS`）までである（DEF-006。page を期限付きで閉じる処理は、ここだけで行う）。
 * - 期限の中で終われば `null`、失敗すれば、その失敗（`step` は `page`）を返す。
 * - 期限を過ぎた場合は、`PassivePageCloseDeadlineError` を失敗として返す。Chromium が page を閉じない場合があり
 *   （エラーページで次のナビゲーションも失敗した直後に閉じた場合。DEF-005 の調査）、そのときは終わらないためである。
 *   呼び出し側は、Context を閉じる処理に進む（Context を閉じると、止まった page も閉じる）。
 * - 期限を過ぎた後に遅れて返る結果と例外は、封じ込める（`awaitBeforeDeadline`）。
 * 例外を投げる（reject する）のは、`options.timeoutMs` が正の安全な整数でない場合（`RangeError`）だけで、そのときは閉じない。
 */
export async function closePassivePageBeforeDeadline(
  factory: Pick<BrowserContextFactory, 'closePassivePage'>,
  page: Page,
  options: PassiveCloseDeadlineOptions = {},
): Promise<PassiveSessionCloseFailure | null> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, PAGE_CLOSE_TIMEOUT_MS);
  const outcome = await awaitBeforeDeadline(
    (async (): Promise<void> => factory.closePassivePage(page))(),
    Date.now() + timeoutMs,
  );
  switch (outcome.status) {
    case 'FULFILLED':
      return null;
    case 'REJECTED':
      return Object.freeze({ step: 'page', error: outcome.reason });
    case 'DEADLINE_EXCEEDED':
      return Object.freeze({ step: 'page', error: new PassivePageCloseDeadlineError() });
  }
}

/**
 * Guard の付いた Passive Context を、factory の `closePassiveContext` で閉じる。終わりを待つのは `options.timeoutMs`
 * （既定は `CONTEXT_CLOSE_TIMEOUT_MS`）までである（DEF-008。Context を期限付きで閉じる処理は、ここだけで行う）。
 * - Guard がすでに Context を閉じていれば（`isPassiveRequestGuardClosed`）、閉じ直さずに `null` を返す。
 * - 期限の中で終われば `null`、失敗すれば、その失敗（`step` は `context`。`error` は投げられた値そのもの）を返す。
 * - 期限を過ぎた場合は、`PassiveContextCloseDeadlineError` を失敗として返す。待つのをやめるだけで、Guard の状態は変えない
 *   （閉じる処理が終わらない間も、Guard はリクエストを止め続ける。設計書 4.1、4.2）。
 * - 期限を過ぎた後に遅れて返る結果と例外は、封じ込める（`awaitBeforeDeadline`）。
 * 例外を投げる（reject する）のは、`options.timeoutMs` が正の安全な整数でない場合（`RangeError`）だけで、そのときは閉じない。
 */
export async function closePassiveContextBeforeDeadline(
  factory: Pick<BrowserContextFactory, 'closePassiveContext'>,
  context: BrowserContext,
  options: PassiveCloseDeadlineOptions = {},
): Promise<PassiveSessionCloseFailure | null> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs, CONTEXT_CLOSE_TIMEOUT_MS);
  if (isPassiveRequestGuardClosed(context)) {
    return null;
  }
  const outcome = await awaitBeforeDeadline(
    (async (): Promise<void> => factory.closePassiveContext(context))(),
    Date.now() + timeoutMs,
  );
  switch (outcome.status) {
    case 'FULFILLED':
      return null;
    case 'REJECTED':
      return Object.freeze({ step: 'context', error: outcome.reason });
    case 'DEADLINE_EXCEEDED':
      return Object.freeze({ step: 'context', error: new PassiveContextCloseDeadlineError() });
  }
}

/**
 * Guard の付いた Passive の page と Context を閉じる（CC-018。この手順は、ここだけで行う）。
 * - `context` が `undefined` なら、何もしない。
 * - `page` があれば、`closePassivePageBeforeDeadline` で先に閉じる（期限は `timeouts.pageCloseTimeoutMs`、既定は
 *   `PAGE_CLOSE_TIMEOUT_MS`）。失敗しても、期限を過ぎても、次の手順に進む。
 * - Context は `closePassiveContextBeforeDeadline` で閉じる（期限は `timeouts.contextCloseTimeoutMs`、既定は
 *   `CONTEXT_CLOSE_TIMEOUT_MS`。DEF-008）。Guard がすでに Context を閉じていれば、閉じ直さない。
 *
 * 失敗は投げずに、起きた順（page、Context の順）の一覧で返す。例外にするか、理由として記録するかは、呼び出し側が決める。
 * 例外を投げる（reject する）のは、注入した期限が正の安全な整数でない場合（`RangeError`）だけで、そのときは閉じない。
 */
export async function closePassivePageAndContext(
  factory: Pick<BrowserContextFactory, 'closePassivePage' | 'closePassiveContext'>,
  context: BrowserContext | undefined,
  page: Page | undefined,
  timeouts: PassiveSessionCloseTimeouts = {},
): Promise<readonly PassiveSessionCloseFailure[]> {
  const pageCloseTimeoutMs = resolveTimeoutMs(timeouts.pageCloseTimeoutMs, PAGE_CLOSE_TIMEOUT_MS);
  const contextCloseTimeoutMs = resolveTimeoutMs(timeouts.contextCloseTimeoutMs, CONTEXT_CLOSE_TIMEOUT_MS);
  const failures: PassiveSessionCloseFailure[] = [];
  if (context === undefined) {
    return Object.freeze(failures);
  }
  if (page !== undefined) {
    const pageFailure = await closePassivePageBeforeDeadline(factory, page, { timeoutMs: pageCloseTimeoutMs });
    if (pageFailure !== null) {
      failures.push(pageFailure);
    }
  }
  const contextFailure = await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: contextCloseTimeoutMs });
  if (contextFailure !== null) {
    failures.push(contextFailure);
  }
  return Object.freeze(failures);
}
