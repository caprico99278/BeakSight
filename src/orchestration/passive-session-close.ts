import type { BrowserContext, Page } from 'playwright';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { awaitBeforeDeadline, resolveTimeoutMs } from '../core/deadline.js';
import { CONTEXT_CLOSE_TIMEOUT_MS } from '../core/limits.js';
import { isPassiveRequestGuardClosed } from '../safety/passive-request-guard.js';

/**
 * 閉じる処理のどの手順で失敗したか。`context` は Context を閉じる処理。
 * page を個別に閉じる処理（以前の `page`）は、DEF-038 で Passive の page を個別に閉じなくなり、CCX-21・CCX-23（CC-049）で消した。
 */
export type PassiveSessionCloseStep = 'context';

/** Context を閉じる処理が期限（`CONTEXT_CLOSE_TIMEOUT_MS`）の中で終わらなかったときの、失敗のメッセージ（DEF-008）。 */
export const PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE = 'Passive Context close did not finish before its deadline';

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
 * 閉じる処理が期限を過ぎた場合は、`PassiveContextCloseDeadlineError` である。
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

/**
 * Context を閉じる処理を待つ時間の上限（ms）の注入口（R15r-4）。省略すると、既定の定数を使う。page を閉じる処理の期限は、DEF-038 で
 * 使わなくなり、CCX-21（CC-049）で消した（page は Context と一緒に閉じる）。
 */
export interface PassiveSessionCloseTimeouts {
  /** Context を閉じる処理を待つ上限。既定は `CONTEXT_CLOSE_TIMEOUT_MS`。 */
  readonly contextCloseTimeoutMs?: number | undefined;
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
 * - page を個別に閉じない。Context を `closePassiveContextBeforeDeadline` で閉じ、その Context の page は、Context と一緒に閉じる
 *   （DEF-038。page を個別に閉じると、ページを離れるとき（`pagehide`・`visibilitychange`）の送信が、Guard を通らずにサーバに届く。
 *   Playwright は、閉じ始めたページの要求で Context の route を呼ばないためである）。
 * - Context を閉じる処理の期限は `timeouts.contextCloseTimeoutMs`（既定は `CONTEXT_CLOSE_TIMEOUT_MS`。DEF-008）。Guard がすでに
 *   Context を閉じていれば、閉じ直さない。
 *
 * 失敗は投げずに、一覧で返す（Context を閉じる処理の失敗だけなので、0件か1件）。例外にするか、理由として記録するかは、
 * 呼び出し側が決める。例外を投げる（reject する）のは、注入した Context を閉じる処理の期限が正の安全な整数でない場合
 * （`RangeError`）だけで、そのときは閉じない。
 */
export async function closePassivePageAndContext(
  factory: Pick<BrowserContextFactory, 'closePassiveContext'>,
  context: BrowserContext | undefined,
  timeouts: PassiveSessionCloseTimeouts = {},
): Promise<readonly PassiveSessionCloseFailure[]> {
  const contextCloseTimeoutMs = resolveTimeoutMs(timeouts.contextCloseTimeoutMs, CONTEXT_CLOSE_TIMEOUT_MS);
  const failures: PassiveSessionCloseFailure[] = [];
  if (context === undefined) {
    return Object.freeze(failures);
  }
  const contextFailure = await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: contextCloseTimeoutMs });
  if (contextFailure !== null) {
    failures.push(contextFailure);
  }
  return Object.freeze(failures);
}
