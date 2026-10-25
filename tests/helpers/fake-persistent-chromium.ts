/**
 * EL-12: 起動の部品（`src/browser/chromium-launch.ts` の `launchChromiumWith`）の差し替えのテストの、偽の persistent の Chromium（本物の Browser は
 * 起動しない。TS-g: headed の起動は、窓を開かずに、起動の部品の差し替えで確かめる）。
 * - 既定の頁の `goto` は、自己検査の URL には `selfCheckError` で失敗し（`null` なら成功する）、許した種類の確かめの移動には `allowedProbeError`
 *   （既定は `net::ERR_UNSAFE_PORT`）で失敗し、内部の窓とほかの URL には成功する（EL-F）。既定の Context の `route`・`setOffline` も記録する。
 * - 呼ばれた操作を `calls` に順に残す（`goto:<url>`、`waitForURL`、`page.close`、`cdp:<method>`、`cdp.detach`、`browser.close` など）。
 * - `browser.close()` は `disconnected` を出す。
 */
import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import {
  BEAKSIGHT_INTERNAL_WINDOW_URL,
  EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS,
  EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT,
  EXTERNAL_LAUNCH_SELF_CHECK_URL,
} from '../../src/browser/chromium-launch.js';

/** 設定が効いているときの、自己検査の移動の誤り（本物の Playwright の文の形）。 */
export const FAKE_SELF_CHECK_BLOCKED_ERROR = `page.goto: ${EXTERNAL_LAUNCH_BLOCKED_ERROR_TEXT} at ${EXTERNAL_LAUNCH_SELF_CHECK_URL}`;
/** 設定が効いていないときの、自己検査の移動の誤り。 */
export const FAKE_SELF_CHECK_ABORTED_ERROR = `page.goto: net::ERR_ABORTED at ${EXTERNAL_LAUNCH_SELF_CHECK_URL}`;

export interface FakePersistentChromiumOptions {
  /** 自己検査の移動の誤りの文（`null` は、移動が成り立つ）。既定は `FAKE_SELF_CHECK_BLOCKED_ERROR`。 */
  readonly selfCheckError?: string | null;
  /** 既定の Context の頁の数（既定は 1）。 */
  readonly pageCount?: number;
  /** `browser()` が null を返す。 */
  readonly noBrowser?: boolean;
  /** CDP の命令を失敗させる（最小化の失敗）。 */
  readonly cdpFails?: boolean;
  /** EL-F（M1）: 許した種類の確かめの移動（`EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS`）の誤りの文。既定は、危ないポートの `net::ERR_UNSAFE_PORT`（設定が許している）。 */
  readonly allowedProbeError?: (url: string) => string;
  /** EL-F（M1）: 内部の窓（`BEAKSIGHT_INTERNAL_WINDOW_URL`）の移動の誤りの文。既定は成功。 */
  readonly internalWindowError?: string;
  /** EL-F（M2）: 既定の Context の `route` を失敗させる。 */
  readonly routeFails?: boolean;
}

/** 内部の窓への移動の、`calls` の中の書き方（`data:` の URL は長いので）。 */
export const FAKE_INTERNAL_WINDOW_CALL = 'internal-window';

export interface FakePersistentChromium {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly pages: readonly Page[];
  readonly calls: string[];
  /** 予期しない切断（`close` を呼ばずに `disconnected` を出す）。 */
  disconnect(): void;
}

export function fakePersistentChromium(options: FakePersistentChromiumOptions = {}): FakePersistentChromium {
  const calls: string[] = [];
  const browserEvents = new EventEmitter();
  let connected = true;
  const browser = {
    on: (event: string, listener: () => void) => {
      browserEvents.on(event, listener);
      return browser;
    },
    isConnected: () => connected,
    close: async () => {
      calls.push('browser.close');
      if (connected) {
        connected = false;
        browserEvents.emit('disconnected');
      }
    },
    contexts: () => [context],
  } as unknown as Browser;
  const selfCheckError = options.selfCheckError === undefined ? FAKE_SELF_CHECK_BLOCKED_ERROR : options.selfCheckError;
  const allowedProbeErrorOf = options.allowedProbeError ?? ((url: string) => `page.goto: net::ERR_UNSAFE_PORT at ${url}`);
  const pageOf = (index: number): Page => {
    let url = 'about:blank';
    const fail = (message: string): never => {
      url = 'chrome-error://chromewebdata/';
      throw new Error(message);
    };
    const page = {
      url: () => url,
      goto: async (target: string) => {
        calls.push(`goto[${index}]:${target === BEAKSIGHT_INTERNAL_WINDOW_URL ? FAKE_INTERNAL_WINDOW_CALL : target}`);
        if (target === EXTERNAL_LAUNCH_SELF_CHECK_URL && selfCheckError !== null) {
          return fail(selfCheckError);
        }
        if ((EXTERNAL_LAUNCH_ALLOWED_PROBE_URLS as readonly string[]).includes(target)) {
          return fail(allowedProbeErrorOf(target));
        }
        if (target === BEAKSIGHT_INTERNAL_WINDOW_URL && options.internalWindowError !== undefined) {
          return fail(options.internalWindowError);
        }
        url = target;
        return null;
      },
      waitForURL: async () => {
        calls.push(`waitForURL[${index}]`);
      },
      close: async () => {
        calls.push(`page.close[${index}]`);
      },
    } as unknown as Page;
    return page;
  };
  const pages = Array.from({ length: options.pageCount ?? 1 }, (_, index) => pageOf(index));
  const context = {
    browser: () => (options.noBrowser === true ? null : browser),
    pages: () => [...pages],
    newPage: async () => {
      calls.push('context.newPage');
      const page = pageOf(pages.length);
      pages.push(page);
      return page;
    },
    close: async () => {
      calls.push('context.close');
    },
    route: async (pattern: string) => {
      calls.push(`context.route:${pattern}`);
      if (options.routeFails === true) {
        throw new Error('route failed');
      }
    },
    setOffline: async (offline: boolean) => {
      calls.push(`context.setOffline:${String(offline)}`);
    },
    newCDPSession: async (page: Page) => {
      calls.push(`cdp.open[${pages.indexOf(page)}]`);
      return {
        send: async (method: string, params?: { readonly bounds?: { readonly windowState?: string } }) => {
          calls.push(`cdp:${method}${params?.bounds?.windowState === undefined ? '' : `:${params.bounds.windowState}`}`);
          if (options.cdpFails === true) {
            throw new Error(`${method} failed`);
          }
          return method === 'Browser.getWindowForTarget' ? { windowId: 7 } : {};
        },
        detach: async () => {
          calls.push('cdp.detach');
        },
      } as unknown as CDPSession;
    },
  } as unknown as BrowserContext;
  const disconnect = (): void => {
    if (connected) {
      connected = false;
      browserEvents.emit('disconnected');
    }
  };
  return { browser, context, pages, calls, disconnect };
}
