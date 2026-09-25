import type { BrowserContext, Page } from 'playwright';
import { ContextConstructionError, type BrowserContextFactory } from '../browser/context-factory.js';
import type { Viewport } from '../config/types.js';
import { awaitBeforeDeadline, resolveTimeoutMs } from '../core/deadline.js';
import { CONTEXT_CLOSE_TIMEOUT_MS, PAGE_CLOSE_TIMEOUT_MS, SESSION_OPEN_TIMEOUT_MS } from '../core/limits.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';
import {
  closePassiveContextBeforeDeadline,
  type PassiveSessionCloseFailure,
  type PassiveSessionCloseTimeouts,
} from './passive-session-close.js';

// DEF-008（Task 18 の前の整理の設計書 4.2、4.3）: Guard の付いた Passive Context と page を、期限付きで作る部品。
// 期限は、呼び出す側（`src/orchestration/`）で付ける。Guard と factory の振る舞いは変えず、待つのをやめるだけである。

/** 作成のどの手順で失敗したか、期限を過ぎたか。`context` は Context の作成（Guard の取り付けを含む）、`page` は page の作成（Guard の準備を含む）。 */
export type PassiveSessionOpenStep = 'context' | 'page';

/** Context か page の作成が期限の中で終わらなかったときの、失敗のメッセージ（DEF-008）。 */
export const PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE = 'Passive session open did not finish before its deadline';

/**
 * Context か page の作成が期限の中で終わらなかったことを表す失敗（DEF-008）。メッセージは `PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE`。
 * `step` は、期限を過ぎた手順。違反ではなく、作成の失敗として扱う（Run は `COMPLETE` にならない。設計書 4.2）。
 */
export class PassiveSessionOpenDeadlineError extends Error {
  readonly step: PassiveSessionOpenStep;

  constructor(step: PassiveSessionOpenStep) {
    super(PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE);
    this.name = 'PassiveSessionOpenDeadlineError';
    this.step = step;
  }
}

/**
 * 作成の期限を過ぎた後に届いた Context を閉じた結果（設計書 4.2）。
 * - `ledger`: その Context の Safety Ledger（取り出せなかった場合は `null`）。
 * - `closeFailure`: `closePassiveContextBeforeDeadline` の結果（閉じる処理の失敗か、期限切れ）。閉じられた場合と、Guard がすでに
 *   閉じていた場合は `null`。
 */
export interface LatePassiveContextRelease {
  readonly ledger: SafetyLedger | null;
  readonly closeFailure: PassiveSessionCloseFailure | null;
}

/** 作成の部品の省略できる引数。 */
export interface PassiveSessionOpenOptions {
  /**
   * 部品が Context を閉じる処理（page の作成が期限を過ぎた場合と、遅れて届いた Context）を待つ上限（ms）。
   * 既定は `CONTEXT_CLOSE_TIMEOUT_MS`。
   */
  readonly contextCloseTimeoutMs?: number | undefined;
  /**
   * 作成の期限を過ぎた後に届いた Context を閉じた結果を受け取る口（記録の口）。省略すると、結果は捨てる。
   * 呼び出し元が戻った後に呼ばれることがある。口が投げた例外は封じ込める。
   */
  readonly onLateContextRelease?: ((release: LatePassiveContextRelease) => void) | undefined;
}

/**
 * 呼び出し元（PREFLIGHT、環境、サイトの metadata、幅の走査など）が受け取る、作成と終了の期限の注入口（R15r-4）。
 * 省略した項目は、`limits.ts` の定数（`SESSION_OPEN_TIMEOUT_MS`、`PAGE_CLOSE_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を使う。
 */
export interface PassiveSessionDeadlineOptions extends PassiveSessionCloseTimeouts, PassiveSessionOpenOptions {
  /** Context と page の作成を待つ上限（ms）。既定は `SESSION_OPEN_TIMEOUT_MS`。 */
  readonly sessionOpenTimeoutMs?: number | undefined;
}

/** 検証して既定値で埋めた、作成と終了の期限（`resolvePassiveSessionDeadlines` の結果）。 */
export interface ResolvedPassiveSessionDeadlines {
  readonly sessionOpenTimeoutMs: number;
  readonly pageCloseTimeoutMs: number;
  readonly contextCloseTimeoutMs: number;
  readonly onLateContextRelease: ((release: LatePassiveContextRelease) => void) | undefined;
}

/**
 * 呼び出し元が受け取った期限の注入口を検証し、省略した項目を `limits.ts` の定数で埋める。呼び出し元は、何かを作る前にこれを呼ぶ。
 * - 期限が正の安全な整数でなければ `RangeError`、受け取る口が関数でなければ `TypeError` を投げる。
 * - 結果は凍結する。そのまま `closePassivePageAndContext` と作成の部品の引数に渡せる。
 */
export function resolvePassiveSessionDeadlines(
  options: PassiveSessionDeadlineOptions | undefined = {},
): ResolvedPassiveSessionDeadlines {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('Passive session deadlines must be an object');
  }
  const { onLateContextRelease } = options;
  if (onLateContextRelease !== undefined && typeof onLateContextRelease !== 'function') {
    throw new TypeError('The receiver of late passive Contexts must be a function');
  }
  return Object.freeze({
    sessionOpenTimeoutMs: resolveTimeoutMs(options.sessionOpenTimeoutMs, SESSION_OPEN_TIMEOUT_MS),
    pageCloseTimeoutMs: resolveTimeoutMs(options.pageCloseTimeoutMs, PAGE_CLOSE_TIMEOUT_MS),
    contextCloseTimeoutMs: resolveTimeoutMs(options.contextCloseTimeoutMs, CONTEXT_CLOSE_TIMEOUT_MS),
    onLateContextRelease,
  });
}

/** 作成の部品が使う factory の機能。 */
export type PassiveSessionOpenFactory = Pick<
  BrowserContextFactory,
  'createPassiveContext' | 'createPassivePage' | 'getSafetyLedger' | 'closePassiveContext'
>;

/**
 * `openPassiveContextBeforeDeadline` の結果。
 * - `OPENED`: Context と、その Ledger。
 * - `FAILED`: 作成が失敗した（今の失敗。部品は Context を閉じない）。`error` は投げられた値そのもの。`ContextConstructionError` の場合は、
 *   `context` と `ledger` は、エラーが持つもの（Guard がまだ閉じていなければ、呼び出し側が閉じる）。それ以外は `undefined` と `null`。
 * - `DEADLINE_EXCEEDED`: 期限の中で終わらなかった。遅れて届いた Context は、部品が閉じる。
 */
export type PassiveContextOpenResult =
  | Readonly<{ status: 'OPENED'; context: BrowserContext; ledger: SafetyLedger }>
  | Readonly<{
    status: 'FAILED';
    step: 'context';
    error: unknown;
    context: BrowserContext | undefined;
    ledger: SafetyLedger | null;
  }>
  | Readonly<{
    status: 'DEADLINE_EXCEEDED';
    step: 'context';
    error: PassiveSessionOpenDeadlineError;
    ledger: null;
    closeFailures: readonly PassiveSessionCloseFailure[];
  }>;

/**
 * `openPassivePageBeforeDeadline` の結果。
 * - `OPENED`: page。
 * - `FAILED`: page の作成が失敗した（今の失敗。部品は Context を閉じない。閉じるのは呼び出し側）。`error` は投げられた値そのもの。
 * - `DEADLINE_EXCEEDED`: 期限の中で終わらなかった。部品が Context を閉じた（呼び出し側は、閉じ直さない）。
 *   `closeFailures` は、その閉じる処理の失敗（期限切れを含む）。
 */
export type PassivePageOpenResult =
  | Readonly<{ status: 'OPENED'; page: Page }>
  | Readonly<{ status: 'FAILED'; step: 'page'; error: unknown }>
  | Readonly<{
    status: 'DEADLINE_EXCEEDED';
    step: 'page';
    error: PassiveSessionOpenDeadlineError;
    closeFailures: readonly PassiveSessionCloseFailure[];
  }>;

/**
 * `openPassiveSessionBeforeDeadline` の結果。
 * - `OPENED`: Context、page、Context の Ledger。
 * - `FAILED`: 今の失敗（`step` は失敗した手順）。部品は Context を閉じない。`context` があれば、呼び出し側が
 *   `closePassivePageAndContext` で閉じる（Guard がすでに閉じていれば、閉じ直さない）。
 * - `DEADLINE_EXCEEDED`: 期限を過ぎた。Context は部品が閉じる（`step` が `page` なら戻る前に閉じ、その失敗を `closeFailures` に返す。
 *   `context` なら、遅れて届いたときに閉じる）。呼び出し側は、閉じ直さない。`ledger` は、Context を作れていればその Ledger。
 */
export type PassiveSessionOpenResult =
  | Readonly<{ status: 'OPENED'; context: BrowserContext; page: Page; ledger: SafetyLedger }>
  | Readonly<{
    status: 'FAILED';
    step: PassiveSessionOpenStep;
    error: unknown;
    context: BrowserContext | undefined;
    ledger: SafetyLedger | null;
  }>
  | Readonly<{
    status: 'DEADLINE_EXCEEDED';
    step: PassiveSessionOpenStep;
    error: PassiveSessionOpenDeadlineError;
    ledger: SafetyLedger | null;
    closeFailures: readonly PassiveSessionCloseFailure[];
  }>;

const NO_CLOSE_FAILURES: readonly PassiveSessionCloseFailure[] = Object.freeze([]);

/**
 * 作成の期限（`Date.now()` の絶対時刻）を決める（設計書 4.2）。今から `options.timeoutMs`（既定は `SESSION_OPEN_TIMEOUT_MS`）後と、
 * 呼び出し元のより短い全体の期限 `options.notAfterMs`（ページの期限など）の、早い方である。
 * `options.timeoutMs` が正の安全な整数でなければ `RangeError` を投げる。
 */
export function passiveSessionOpenDeadlineAtMs(
  options: { readonly timeoutMs?: number | undefined; readonly notAfterMs?: number | undefined } = {},
): number {
  const openDeadlineAtMs = Date.now() + resolveTimeoutMs(options.timeoutMs, SESSION_OPEN_TIMEOUT_MS);
  return options.notAfterMs === undefined ? openDeadlineAtMs : Math.min(openDeadlineAtMs, options.notAfterMs);
}

/**
 * Guard の付いた Passive Context と page を、`deadlineAtMs` までに作る（DEF-008。Context と page を期限付きで作る処理は、ここだけで行う）。
 * 手順は `openPassiveContextBeforeDeadline`、`openPassivePageBeforeDeadline` の順で、期限は両方で共有する。
 * 結果（成功、今の失敗、期限切れ）は `PassiveSessionOpenResult` を見る。
 * 例外を投げる（reject する）のは、`deadlineAtMs` が有限の数でない場合と、`options.contextCloseTimeoutMs` が正の安全な整数でない
 * 場合（`RangeError`）だけで、そのときは何も作らない。
 */
export async function openPassiveSessionBeforeDeadline(
  factory: PassiveSessionOpenFactory,
  viewport: Viewport,
  deadlineAtMs: number,
  options: PassiveSessionOpenOptions = {},
): Promise<PassiveSessionOpenResult> {
  assertOpenArguments(deadlineAtMs, options);
  const opened = await openPassiveContextBeforeDeadline(factory, viewport, deadlineAtMs, options);
  if (opened.status !== 'OPENED') {
    return opened;
  }
  const { context, ledger } = opened;
  const page = await openPassivePageBeforeDeadline(factory, context, deadlineAtMs, options);
  switch (page.status) {
    case 'OPENED':
      return Object.freeze({ status: 'OPENED', context, page: page.page, ledger });
    case 'FAILED':
      return Object.freeze({ status: 'FAILED', step: 'page' as const, error: page.error, context, ledger });
    case 'DEADLINE_EXCEEDED':
      return Object.freeze({
        status: 'DEADLINE_EXCEEDED',
        step: 'page',
        error: page.error,
        ledger,
        closeFailures: page.closeFailures,
      });
  }
}

/**
 * Guard の付いた Passive Context を、`deadlineAtMs` までに作る（factory の `createPassiveContext`。Guard の取り付けを含む）。
 * - 期限の中で作れれば、Context と Ledger（`getSafetyLedger`）を返す。Ledger を取り出せなかった場合は `FAILED`（`context` は作った
 *   Context。呼び出し側が閉じる）。
 * - 失敗した場合は、今の扱いのまま返す（`PassiveContextOpenResult` の `FAILED`）。部品は Context を閉じない。
 * - 呼び出した時点で期限を過ぎていれば、作らずに `DEADLINE_EXCEEDED` を返す。
 * - 期限の中で終わらなければ `DEADLINE_EXCEEDED` を返す。遅れて Context が届いた場合（`ContextConstructionError` の Context を含む）は、
 *   `closePassiveContextBeforeDeadline` で閉じ（Guard がすでに閉じていれば閉じ直さない）、その結果を `options.onLateContextRelease` に渡す。
 *   Context を持たない遅れた失敗は、封じ込める。
 * 例外を投げる（reject する）のは、引数が不正な場合（`RangeError`）だけである。
 */
export async function openPassiveContextBeforeDeadline(
  factory: PassiveSessionOpenFactory,
  viewport: Viewport,
  deadlineAtMs: number,
  options: PassiveSessionOpenOptions = {},
): Promise<PassiveContextOpenResult> {
  const { contextCloseTimeoutMs } = assertOpenArguments(deadlineAtMs, options);
  if (Date.now() >= deadlineAtMs) {
    return contextDeadlineExceeded();
  }
  const creation = (async (): Promise<BrowserContext> => factory.createPassiveContext(viewport))();
  const outcome = await awaitBeforeDeadline(creation, deadlineAtMs);
  switch (outcome.status) {
    case 'FULFILLED': {
      const context = outcome.value;
      let ledger: SafetyLedger;
      try {
        ledger = factory.getSafetyLedger(context);
      } catch (error) {
        return Object.freeze({ status: 'FAILED', step: 'context' as const, error, context, ledger: null });
      }
      return Object.freeze({ status: 'OPENED', context, ledger });
    }
    case 'REJECTED': {
      const { reason } = outcome;
      return reason instanceof ContextConstructionError
        ? Object.freeze({ status: 'FAILED', step: 'context' as const, error: reason, context: reason.context, ledger: reason.ledger })
        : Object.freeze({ status: 'FAILED', step: 'context' as const, error: reason, context: undefined, ledger: null });
    }
    case 'DEADLINE_EXCEEDED':
      // 期限の直前に届いた場合も、`awaitBeforeDeadline` は値を返さないので、同じく遅れて届いたものとして閉じる。
      releaseLateContext(factory, creation, contextCloseTimeoutMs, options.onLateContextRelease);
      return contextDeadlineExceeded();
  }
}

/**
 * 作った Passive Context に、Guard の付いた page を `deadlineAtMs` までに作る（factory の `createPassivePage`。Guard の準備を含む）。
 * - 失敗した場合は、今の扱いのまま返す（`FAILED`）。部品は Context を閉じない。
 * - 呼び出した時点で期限を過ぎていた場合と、期限の中で終わらなかった場合は、Context を `closePassiveContextBeforeDeadline` で閉じてから
 *   `DEADLINE_EXCEEDED` を返す（Context を閉じると、遅れて届く page も閉じる）。閉じる処理の失敗と期限切れは `closeFailures` に返す。
 *   遅れて返る page の作成の結果と例外は、封じ込める。
 * 例外を投げる（reject する）のは、引数が不正な場合（`RangeError`）だけである。
 */
export async function openPassivePageBeforeDeadline(
  factory: PassiveSessionOpenFactory,
  context: BrowserContext,
  deadlineAtMs: number,
  options: PassiveSessionOpenOptions = {},
): Promise<PassivePageOpenResult> {
  const { contextCloseTimeoutMs } = assertOpenArguments(deadlineAtMs, options);
  if (Date.now() < deadlineAtMs) {
    const outcome = await awaitBeforeDeadline(
      (async (): Promise<Page> => factory.createPassivePage(context))(),
      deadlineAtMs,
    );
    if (outcome.status === 'FULFILLED') {
      return Object.freeze({ status: 'OPENED', page: outcome.value });
    }
    if (outcome.status === 'REJECTED') {
      return Object.freeze({ status: 'FAILED', step: 'page' as const, error: outcome.reason });
    }
  }
  const closeFailure = await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: contextCloseTimeoutMs });
  return Object.freeze({
    status: 'DEADLINE_EXCEEDED',
    step: 'page',
    error: new PassiveSessionOpenDeadlineError('page'),
    closeFailures: closeFailure === null ? NO_CLOSE_FAILURES : Object.freeze([closeFailure]),
  });
}

function assertOpenArguments(
  deadlineAtMs: number,
  options: PassiveSessionOpenOptions,
): { readonly contextCloseTimeoutMs: number } {
  if (typeof deadlineAtMs !== 'number' || !Number.isFinite(deadlineAtMs)) {
    throw new RangeError('A passive session open deadline must be a finite time in milliseconds');
  }
  return { contextCloseTimeoutMs: resolveTimeoutMs(options.contextCloseTimeoutMs, CONTEXT_CLOSE_TIMEOUT_MS) };
}

function contextDeadlineExceeded(): PassiveContextOpenResult {
  return Object.freeze({
    status: 'DEADLINE_EXCEEDED',
    step: 'context',
    error: new PassiveSessionOpenDeadlineError('context'),
    ledger: null,
    closeFailures: NO_CLOSE_FAILURES,
  });
}

/**
 * 期限を過ぎた後に届いた Context を閉じ、結果を受け取る口に渡す（設計書 4.2。`isolated-auditor.ts` の `releaseLateValue` と同じ考え方）。
 * 待たない。閉じる処理も期限（`contextCloseTimeoutMs`）付きで待つので、後始末が止まり続けることはない。後始末と口の例外は、封じ込める。
 */
function releaseLateContext(
  factory: PassiveSessionOpenFactory,
  creation: Promise<BrowserContext>,
  contextCloseTimeoutMs: number,
  onLateContextRelease: ((release: LatePassiveContextRelease) => void) | undefined,
): void {
  creation
    .then(
      async (context) => releaseLatePassiveContext(
        factory,
        context,
        ledgerOrNull(factory, context),
        contextCloseTimeoutMs,
        onLateContextRelease,
      ),
      async (error: unknown) => releaseLateFailureContext(factory, error, contextCloseTimeoutMs, onLateContextRelease),
    )
    .catch(() => undefined);
}

/**
 * この部品の外で期限を付けた Context の作成（Interaction の session の作成など。P18c）で、期限を過ぎた後に届いた失敗の後始末をする
 * （設計書 4.2。`openPassiveContextBeforeDeadline` の遅れて届いた失敗と、同じ扱い）。
 * - `ContextConstructionError` なら、その Context を `closePassiveContextBeforeDeadline` で閉じ（Guard がすでに閉じていれば閉じ直さない。
 *   期限は `options.contextCloseTimeoutMs`、既定は `CONTEXT_CLOSE_TIMEOUT_MS`）、結果を `options.onLateContextRelease` に渡す
 *   （省略すると捨てる）。
 * - Context を持たない失敗は、閉じるものがないので、何もしない。
 * 待たない。後始末と口の例外は、封じ込める。例外を投げるのは、`options.contextCloseTimeoutMs` が正の安全な整数でない場合
 * （`RangeError`）だけで、そのときは何もしない。
 */
export function releaseLatePassiveContextFailure(
  factory: Pick<BrowserContextFactory, 'closePassiveContext'>,
  error: unknown,
  options: PassiveSessionOpenOptions = {},
): void {
  const contextCloseTimeoutMs = resolveTimeoutMs(options.contextCloseTimeoutMs, CONTEXT_CLOSE_TIMEOUT_MS);
  releaseLateFailureContext(factory, error, contextCloseTimeoutMs, options.onLateContextRelease).catch(() => undefined);
}

/** 遅れて届いた失敗が Context を持つ（`ContextConstructionError`）なら、その Context を閉じる。持たなければ何もしない。 */
async function releaseLateFailureContext(
  factory: Pick<BrowserContextFactory, 'closePassiveContext'>,
  error: unknown,
  contextCloseTimeoutMs: number,
  onLateContextRelease: ((release: LatePassiveContextRelease) => void) | undefined,
): Promise<void> {
  if (error instanceof ContextConstructionError) {
    await releaseLatePassiveContext(factory, error.context, error.ledger, contextCloseTimeoutMs, onLateContextRelease);
  }
}

/** 遅れて届いた Context を期限付きで閉じ、結果を受け取る口に渡す。 */
async function releaseLatePassiveContext(
  factory: Pick<BrowserContextFactory, 'closePassiveContext'>,
  context: BrowserContext,
  ledger: SafetyLedger | null,
  contextCloseTimeoutMs: number,
  onLateContextRelease: ((release: LatePassiveContextRelease) => void) | undefined,
): Promise<void> {
  const closeFailure = await closePassiveContextBeforeDeadline(factory, context, { timeoutMs: contextCloseTimeoutMs });
  onLateContextRelease?.(Object.freeze({ ledger, closeFailure }));
}

function ledgerOrNull(factory: PassiveSessionOpenFactory, context: BrowserContext): SafetyLedger | null {
  try {
    return factory.getSafetyLedger(context);
  } catch {
    return null;
  }
}
