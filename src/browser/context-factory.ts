import type { Browser, BrowserContext, Page } from 'playwright';
import type { AuditConfig, Viewport } from '../config/types.js';
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

/** 構築に失敗した場合でも、そのContextをファクトリ既存のclose/join APIのために保持する。 */
export class ContextConstructionError extends Error {
  readonly context: BrowserContext;
  override readonly cause: unknown;

  constructor(context: BrowserContext, cause: unknown) {
    super('Guarded browser construction failed; Context ownership is retained', { cause });
    this.name = 'ContextConstructionError';
    this.context = context;
    this.cause = cause;
    Object.freeze(this);
  }
}

const issuedSafetyLedgers = new WeakSet<SafetyLedger>();

function viewportSnapshot(viewport: Viewport): Viewport {
  if (
    !Number.isFinite(viewport.width)
    || viewport.width <= 0
    || !Number.isFinite(viewport.height)
    || viewport.height <= 0
  ) {
    throw new Error('Passive browser viewport dimensions must be positive finite numbers');
  }
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

export class BrowserContextFactory {
  readonly #browser: Browser;
  readonly #locale: string;
  readonly #timezone: string;
  readonly #allowedOrigins: ReadonlySet<string>;
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
    });

    this.#contextLedgers.set(context, ledger);
    this.#activeContexts.add(context);
    try {
      await installPassiveRequestGuard(context, ledger, this.#allowedOrigins);
    } catch (error) {
      if (!isPassiveRequestGuardClosed(context)) {
        throw new ContextConstructionError(context, error);
      }
      this.#activeContexts.delete(context);
      this.#contextLedgers.delete(context);
      throw error;
    }
    return context;
  }

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
      if (!isPassiveRequestGuardClosed(context)) {
        throw new ContextConstructionError(context, error);
      }
      throw error;
    }
    const ledger = this.getSafetyLedger(context);
    let closed = false;
    let retainedNonTerminalFailure = false;
    return Object.freeze({
      page,
      ledger,
      activateInteractionFreeze: async (): Promise<void> => {
        this.#requireActiveGuardedContext(context);
        await activateInteractionFreeze(page);
      },
      isClosed: (): boolean => isPassiveRequestGuardClosed(context),
      close: async (): Promise<void> => {
        if (closed) {
          throw new Error('Interaction owner session was already closed');
        }
        try {
          await this.closePassiveContext(context);
        } catch (error) {
          const terminal = isPassiveRequestGuardClosed(context);
          if (terminal && retainedNonTerminalFailure) return;
          retainedNonTerminalFailure = !terminal;
          throw error;
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
      if (!isPassiveRequestGuardClosed(context)) {
        throw new ContextConstructionError(context, error);
      }
      this.#activeContexts.delete(context);
      throw error;
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
