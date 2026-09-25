import type { Browser, BrowserContext, Page } from 'playwright';
import type { AuditConfig, Viewport } from '../config/types.js';
import { isPositiveSafeInteger } from '../core/guards.js';
import {
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
} from '../safety/passive-request-guard.js';
import { canonicalPassiveAllowedOrigins } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';

export type SafetyLedgerFactory = () => SafetyLedger;

export interface InteractionGuardedSession {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  readonly isClosed: () => boolean;
  activateInteractionFreeze(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Guard 付きの Context の構築（Guard の取り付け、または page の作成）に失敗したことを表す（Task 14〜17 の設計書 4.3、R14r の Important-1）。
 * Context が閉じられたかどうかに関係なく投げる。
 * - `context`: 構築に失敗した Context。Guard がまだ閉じていなければ（`isPassiveRequestGuardClosed` が偽）、factory が所有したままなので、
 *   呼び出し側が factory の close API で閉じる。
 * - `ledger`: その Context の Safety Ledger。Guard の取り付けの失敗などの違反が記録されているので、呼び出し側は、これを Safety の
 *   Evidence と違反の集計に含める。factory の `getSafetyLedger(context)` でも、同じ Ledger を取り出せる。
 */
export class ContextConstructionError extends Error {
  readonly context: BrowserContext;
  readonly ledger: SafetyLedger;
  override readonly cause: unknown;

  constructor(context: BrowserContext, ledger: SafetyLedger, cause: unknown) {
    super('Guarded browser construction failed; the Context and its Safety Ledger are retained', { cause });
    this.name = 'ContextConstructionError';
    this.context = context;
    this.ledger = ledger;
    this.cause = cause;
    Object.freeze(this);
  }
}

const issuedSafetyLedgers = new WeakSet<SafetyLedger>();

function viewportSnapshot(viewport: Viewport): Viewport {
  if (!isPositiveSafeInteger(viewport.width) || !isPositiveSafeInteger(viewport.height)) {
    throw new Error('Passive browser viewport dimensions must be positive safe integers');
  }
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

export class BrowserContextFactory {
  readonly #browser: Browser;
  readonly #locale: string;
  readonly #timezone: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  /** 画面を表示して実行するか。値の出どころは設定（`config.browser.headed`）の1つだけで、Guard の取り付けに渡す（C18a）。 */
  readonly #headed: boolean;
  readonly #ledgerFactory: SafetyLedgerFactory;
  readonly #contextLedgers = new WeakMap<BrowserContext, SafetyLedger>();
  readonly #activeContexts = new WeakSet<BrowserContext>();
  readonly #ownedPages = new WeakMap<Page, BrowserContext>();

  constructor(browser: Browser, config: AuditConfig, ledgerFactory: SafetyLedgerFactory) {
    if (typeof ledgerFactory !== 'function') {
      throw new Error('A Safety Ledger factory dependency is required');
    }
    this.#browser = browser;
    this.#locale = config.browser.locale;
    this.#timezone = config.browser.timezone;
    this.#allowedOrigins = canonicalPassiveAllowedOrigins(new Set(config.site.allowedOrigins));
    this.#headed = config.browser.headed;
    this.#ledgerFactory = ledgerFactory;
  }

  async createPassiveContext(viewport: Viewport): Promise<BrowserContext> {
    const ledger = this.#ledgerFactory();
    if (!(ledger instanceof SafetyLedger)) {
      throw new Error('Safety Ledger factory must create a SafetyLedger');
    }
    if (issuedSafetyLedgers.has(ledger)) {
      throw new Error('Safety Ledger factory reused a ledger; each Context requires isolated history');
    }
    issuedSafetyLedgers.add(ledger);
    const context = await this.#browser.newContext({
      locale: this.#locale,
      timezoneId: this.#timezone,
      viewport: viewportSnapshot(viewport),
      serviceWorkers: 'block',
      // Passive でも Interaction でも、ページが起こしたダウンロードを保存しない（設計書 4.7）。
      acceptDownloads: false,
    });

    // Context と Ledger の対応は、構築に失敗しても消さない（`getSafetyLedger` で後から取り出せるようにする。設計書 4.3）。
    this.#contextLedgers.set(context, ledger);
    this.#activeContexts.add(context);
    try {
      await installPassiveRequestGuard(context, ledger, this.#allowedOrigins, { headed: this.#headed });
    } catch (error) {
      throw this.#constructionFailure(context, error);
    }
    return context;
  }

  /**
   * Interaction の owner の session を作る（設計書 4.3）。失敗した場合に、誰が Context を閉じるかは次のとおり。
   * - Context の作成（`createPassiveContext`）で、Guard の取り付けに失敗した場合: `ContextConstructionError` をそのまま投げる。
   *   factory は Context を閉じない。Guard がまだ Context を閉じていなければ（`isPassiveRequestGuardClosed` が偽）、
   *   呼び出し側が `closePassiveContext` で閉じる。
   * - Context の作成で、それ以外に失敗した場合（Ledger の検査、`newContext` の失敗など）: その例外をそのまま投げる。
   *   閉じる Context はない（Ledger の検査の失敗では、Context を作らない）。
   * - page の作成で、Guard の準備（`awaitPassiveRequestGuardReady`）に失敗した場合: `createPassivePage` が投げた
   *   `ContextConstructionError` をそのまま投げる。factory は Context を閉じない。Guard がまだ閉じていなければ、呼び出し側が閉じる。
   * - page の作成で、それ以外に失敗した場合（`newPage` の失敗など）: factory が、まだ所有している Context を
   *   `closePassiveContext` で1回だけ閉じようとし（その失敗は投げない）、そのうえで `ContextConstructionError` を投げる。
   *   閉じるのに失敗して Guard がまだ閉じていなければ、Context は factory の所有のまま残るので、呼び出し側が閉じる。
   *
   * どの `ContextConstructionError` も、Context が閉じられたかどうかに関係なく、その Context と Ledger を持つ。
   * 成功した場合は、返した session の `close()` で Context を閉じる（session の持ち主が閉じる）。
   */
  async createInteractionSession(viewport: Viewport): Promise<InteractionGuardedSession> {
    const context = await this.createPassiveContext(viewport);
    let page: Page;
    try {
      page = await this.createPassivePage(context);
    } catch (error) {
      if (error instanceof ContextConstructionError) throw error;
      if (this.#activeContexts.has(context)) {
        await this.closePassiveContext(context).catch(() => undefined);
      }
      throw this.#constructionFailure(context, error);
    }
    const ledger = this.getSafetyLedger(context);
    let closed = false;
    return Object.freeze({
      page,
      ledger,
      activateInteractionFreeze: async (): Promise<void> => {
        this.#requireActiveGuardedContext(context);
        await activateInteractionFreeze(page);
      },
      isClosed: (): boolean => isPassiveRequestGuardClosed(context),
      // closePassiveContext() と同じ意味にする（設計書 4.1）。invalidation を経て CLOSED に達したら、
      // 前回の close が非終端で失敗していたかどうかにかかわらず reject する。所有は CLOSED の時点で解放する。
      close: async (): Promise<void> => {
        if (closed) {
          throw new Error('Interaction owner session was already closed');
        }
        try {
          await this.closePassiveContext(context);
        } finally {
          closed = isPassiveRequestGuardClosed(context);
        }
      },
    });
  }

  getSafetyLedger(context: BrowserContext): SafetyLedger {
    const ledger = this.#contextLedgers.get(context);
    if (ledger === undefined) {
      throw new Error('BrowserContext is not owned by this factory');
    }
    return ledger;
  }

  async createPassivePage(context: BrowserContext): Promise<Page> {
    this.#requireActiveGuardedContext(context);
    const page = await context.newPage();
    try {
      await awaitPassiveRequestGuardReady(page);
    } catch (error) {
      throw this.#constructionFailure(context, error);
    }
    this.#ownedPages.set(page, context);
    return page;
  }

  async closePassivePage(page: Page): Promise<void> {
    const context = this.#ownedPages.get(page);
    if (context === undefined || !this.#activeContexts.has(context)) {
      throw new Error('Page is not owned by this factory or its Context is no longer active');
    }
    try {
      await closePassiveGuardedPage(page);
    } catch (error) {
      this.#ownedPages.delete(page);
      if (isPassiveRequestGuardClosed(context)) this.#activeContexts.delete(context);
      throw error;
    }
    this.#ownedPages.delete(page);
  }

  async closePassiveContext(context: BrowserContext): Promise<void> {
    this.#requireActiveContext(context);
    try {
      await closePassiveGuardedContext(context);
    } finally {
      if (isPassiveRequestGuardClosed(context)) this.#activeContexts.delete(context);
    }
  }

  /**
   * 構築の失敗を、Context の Ledger を持つ `ContextConstructionError` にする。Guard がすでに Context を閉じていれば、
   * 所有（閉じる責任）だけを解放する。Ledger との対応は残す。
   */
  #constructionFailure(context: BrowserContext, cause: unknown): ContextConstructionError {
    if (isPassiveRequestGuardClosed(context)) {
      this.#activeContexts.delete(context);
    }
    return new ContextConstructionError(context, this.getSafetyLedger(context), cause);
  }

  #requireActiveContext(context: BrowserContext): void {
    if (!this.#activeContexts.has(context)) {
      throw new Error('BrowserContext is not owned by this factory or is no longer active');
    }
  }

  #requireActiveGuardedContext(context: BrowserContext): void {
    this.#requireActiveContext(context);
    assertPassiveRequestGuardActive(context);
  }
}
