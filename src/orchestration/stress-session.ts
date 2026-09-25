import type { BrowserContext, Page } from 'playwright';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import type { Viewport } from '../config/types.js';
import type { PassiveStressSession, PassiveStressSessionFactory } from '../evidence/layout-collector.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';
import { closePassivePageAndContext, type PassiveSessionCloseFailure } from './passive-session-close.js';
import {
  openPassiveSessionBeforeDeadline,
  passiveSessionOpenDeadlineAtMs,
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type ResolvedPassiveSessionDeadlines,
} from './passive-session-open.js';

/** 幅の走査のセッションを作る関数と、作ったセッションの Ledger の一覧。 */
export interface StressSessionFactory {
  /** `collectStressLayout` に渡す、セッションを作る関数。 */
  readonly createSession: PassiveStressSessionFactory;
  /**
   * これまでに作ったセッションの Safety Ledger を、作った順に返す（凍結した複製）。
   * Page Auditor は、これを Safety の Evidence（scope は `PASSIVE`、ビューポートは Desktop）と、違反の集計に含める。
   * セッションの作成の途中で失敗した場合も、Context ができていれば、その Ledger を含める。
   */
  readonly ledgers: () => readonly SafetyLedger[];
}

/** `createStressSessionFactory` の省略できる引数（DEF-008）。 */
export interface StressSessionOptions {
  /**
   * セッションの Context と page の作成・終了の期限の注入口（R15r-4）。省略した項目は、`limits.ts` の定数を使う。
   */
  readonly deadlines?: PassiveSessionDeadlineOptions | undefined;
  /**
   * セッションの作成の期限の上限（`Date.now()` の絶対時刻）。呼び出し元のより短い全体の期限（幅の走査の期限など）を渡す。
   * 作成の期限は、今から `sessionOpenTimeoutMs` 後と、この時刻の早い方である（設計書 4.2）。省略すると、上限を付けない。
   */
  readonly notAfterMs?: number | undefined;
}

/**
 * 幅の走査（stress sweep）のセッションを、`BrowserContextFactory` の Passive Context で作る（Task 14〜17 の設計書 4.5.6）。
 * 各セッションは、幅ごとに新しい Passive Context と page を持つので、Guard と Ledger が付く。
 * Context と page の作成は `openPassiveSessionBeforeDeadline` で、閉じる処理は `closePassivePageAndContext` で、期限付きで待つ
 * （DEF-008。Task 18 の前の整理の設計書 4.4）。
 *
 * 失敗の扱い（隠さない）:
 * - page を作れなかった場合は、Context を閉じてから、元の例外を投げる。閉じるのにも失敗した場合は、両方を
 *   `AggregateError` にまとめて投げる。
 * - Context の作成が `ContextConstructionError` で失敗した場合は、エラーが持つ Ledger を一覧に加える。Guard がまだ Context を
 *   閉じていなければ、その Context を閉じてから、元の例外を投げる（閉じるのにも失敗したら `AggregateError`）。
 *   呼び出し側は、その Context を閉じ直さない。
 * - Context を作った直後に、その Ledger を取り出せなかった（`getSafetyLedger` が投げた）場合も、Context を閉じてから、元の例外を
 *   投げる（閉じるのにも失敗したら `AggregateError`。RP18 の指摘3）。
 * - 作成が期限を過ぎた場合は、`PassiveSessionOpenDeadlineError` を投げる。page の作成が期限を過ぎた場合は、Context の Ledger を
 *   一覧に加え、部品が閉じた Context の閉じる処理の失敗があれば、`AggregateError` にまとめて投げる。
 * - `close()` は、page を閉じた後に Context を閉じる（`closePassivePageAndContext`）。page を閉じるのに失敗しても、Context を閉じる。
 *   Guard がすでに Context を閉じていれば、Context は閉じ直さない。失敗（期限切れを含む）は投げ、両方が失敗した場合は
 *   `AggregateError` にまとめる。2回目の `close()` は reject する。
 *
 * 例外を投げるのは、factory がない場合（`TypeError`）と、注入した期限が不正な場合（`RangeError`）だけである。
 */
export function createStressSessionFactory(
  factory: BrowserContextFactory,
  options: StressSessionOptions = {},
): StressSessionFactory {
  if (typeof factory !== 'object' || factory === null) {
    throw new TypeError('A BrowserContextFactory is required for the stress sweep sessions');
  }
  const deadlines = resolvePassiveSessionDeadlines(options.deadlines);
  const { notAfterMs } = options;
  if (notAfterMs !== undefined && !Number.isFinite(notAfterMs)) {
    throw new RangeError('The stress sweep session deadline must be a finite time in milliseconds');
  }
  const ledgers: SafetyLedger[] = [];

  const createSession = async (viewport: Viewport): Promise<PassiveStressSession> => {
    const opened = await openPassiveSessionBeforeDeadline(
      factory,
      viewport,
      passiveSessionOpenDeadlineAtMs({ timeoutMs: deadlines.sessionOpenTimeoutMs, notAfterMs }),
      deadlines,
    );
    // Guard が Context を閉じた場合も、エラーが持つ Ledger を含める（設計書 4.3、R14r の Important-1）。
    if (opened.ledger !== null) {
      ledgers.push(opened.ledger);
    }
    switch (opened.status) {
      case 'OPENED':
        return createSessionHandle(factory, opened.context, opened.page, deadlines);
      case 'FAILED':
        // Context があれば（page の作成の失敗、`ContextConstructionError`、Context を作った直後の Ledger の取り出しの失敗）、
        // 閉じてから投げる（RP18 の指摘3。ほかの呼び出し元と同じ）。Guard がすでに閉じていれば、閉じ直さない。
        if (opened.context === undefined) {
          throw opened.error;
        }
        return closeAfterFailure(factory, opened.context, opened.error, deadlines);
      case 'DEADLINE_EXCEEDED':
        // Context は、部品が閉じた（または、遅れて届いたときに閉じる）。閉じ直さない。
        throwWithCloseFailures(opened.error, opened.closeFailures);
    }
  };

  return Object.freeze({
    createSession,
    ledgers: (): readonly SafetyLedger[] => Object.freeze([...ledgers]),
  });
}

function createSessionHandle(
  factory: BrowserContextFactory,
  context: BrowserContext,
  page: Page,
  deadlines: ResolvedPassiveSessionDeadlines,
): PassiveStressSession {
  let closeStarted = false;
  return Object.freeze({
    page,
    close: async (): Promise<void> => {
      if (closeStarted) {
        throw new Error('Stress sweep session was already closed');
      }
      closeStarted = true;
      // Guard が Context を無効にして閉じた場合は、Context は閉じ直さず、page の失敗だけを投げる。
      const errors = (await closePassivePageAndContext(factory, context, page, deadlines)).map((failure) => failure.error);
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Stress sweep session page close and Context close both failed');
      }
      if (errors.length === 1) {
        throw errors[0];
      }
    },
  });
}

/** 作成の途中で失敗したセッションの Context を閉じ、元の失敗を投げる（閉じるのにも失敗したら両方をまとめる）。 */
async function closeAfterFailure(
  factory: BrowserContextFactory,
  context: BrowserContext,
  cause: unknown,
  deadlines: ResolvedPassiveSessionDeadlines,
): Promise<never> {
  throwWithCloseFailures(cause, await closePassivePageAndContext(factory, context, undefined, deadlines));
}

/** 作成の失敗を投げる。閉じる処理の失敗があれば、両方を `AggregateError` にまとめて投げる。 */
function throwWithCloseFailures(cause: unknown, closeFailures: readonly PassiveSessionCloseFailure[]): never {
  if (closeFailures.length > 0) {
    throw new AggregateError(
      [cause, ...closeFailures.map((failure) => failure.error)],
      'Stress sweep session creation and Context close both failed',
    );
  }
  throw cause;
}
