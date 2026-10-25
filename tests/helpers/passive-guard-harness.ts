import type { BrowserContext, CDPSession, Page, Request, Route, WebSocketRoute } from 'playwright';
import {
  awaitPassiveRequestGuardReady,
  installPassiveRequestGuard,
  SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT,
  WEBRTC_BLOCK_INIT_SCRIPT,
  WORKER_CONNECT_POLICY_INIT_SCRIPT,
} from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';

/**
 * Guard のテストの偽の Context と page の session と page（CC-044）。Guard（`installPassiveRequestGuard`）を偽の Context に取り付け、
 * Guard が付けた listener を取り出して、CDP の事象や Playwright の事象を、テストが決めた順で Guard に送る。
 * Context と session の振る舞い（命令の失敗、応答の保留、閉じる処理の失敗など）は、`createGuardHarness` の指定で決める。
 */

/** 偽の page の session が `Page.getFrameTree` に返す、main frame の ID。 */
export const GUARD_HARNESS_ROOT_FRAME_ID = 'root-frame';

export interface GuardHarness {
  readonly context: BrowserContext;
  readonly calls: string[];
  readonly cdpCommands: string[];
  readonly cdpCommandLog: ReadonlyArray<{ readonly method: string; readonly params: unknown }>;
  readonly removedListeners: readonly string[];
  readonly closeCount: number;
  readonly httpHandler: ((route: Route) => Promise<unknown> | unknown) | undefined;
  readonly webSocketHandler: ((route: WebSocketRoute) => Promise<unknown> | unknown) | undefined;
  readonly requestFailedHandler: ((request: Request) => Promise<unknown> | unknown) | undefined;
  /** Guard の `request` の事象の listener（C18a。外部スキームへの移動の検出）。 */
  readonly requestHandler: ((request: Request) => unknown) | undefined;
  readonly pageHandler: ((page: Page) => void) | undefined;
  /** Guard の Context の `close` の事象の listener（DEF-110 fix。Context がもう存在しないことの証し）。 */
  readonly contextCloseHandler: (() => void) | undefined;
  readonly cdpRequestPausedHandler: ((event: FakeCdpPausedEvent) => void) | undefined;
  readonly cdpCloseHandler: (() => void) | undefined;
  /** Guard の page の session の `Network.loadingFailed` の listener（DEF-026。取り消しの証拠）。 */
  readonly cdpLoadingFailedHandler: ((event: FakeCdpLoadingFailedEvent) => void) | undefined;
  /** Guard の page の session の `Network.requestWillBeSent` の listener（DEF-027、DEF-042 の CORS の事前確認の判定）。 */
  readonly cdpRequestWillBeSentHandler: ((event: unknown) => void) | undefined;
  /** Guard の page の session の `Log.entryAdded` の listener（DEF-040。Worker の中の CSP の違反の観察）。 */
  readonly cdpLogEntryAddedHandler: ((event: unknown) => void) | undefined;
  registerPage(page: Page): void;
  /**
   * Guard が page の session に付けた、`event` のすべての listener に `value` を渡す（上の名前の付いた listener のない事象も送れる）。
   * 値はそのまま渡す（`cdpRequestPausedHandler` のような既定の項目は足さない）。listener がなければ何もしない。
   */
  emitCdp(event: string, value?: unknown): void;
}

export interface FakeCdpPausedEvent {
  readonly requestId: string;
  readonly redirectedRequestId?: string;
  /** Network の domain の要求の ID（DEF-026。取り消しの証拠の `Network.loadingFailed` の `requestId` と対応付ける）。 */
  readonly networkId?: string;
  readonly frameId: string;
  readonly request: { readonly method: string; readonly url: string; readonly headers?: Readonly<Record<string, string>> };
  /**
   * 要求の種類（DEF-042）。偽の harness の `cdpRequestPausedHandler` は、指定のない事象を `Document` の事象として Guard に渡す
   * （DEF-042 より前のテストは、Document の事象だけを送っていた）。Document でない要求のテストは、明示して渡す。
   */
  readonly resourceType?: string;
  /** 応答の段階（Response stage）の事象だけが持つ項目（C18g）。 */
  readonly responseStatusCode?: number;
  /** 応答の status の文言（DEF-040。`Fetch.continueResponse` の `responsePhrase` に使う）。 */
  readonly responseStatusText?: string;
  readonly responseErrorReason?: string;
  readonly responseHeaders?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** 偽の `Network.loadingFailed` の事象（DEF-026）。 */
export interface FakeCdpLoadingFailedEvent {
  readonly requestId: string;
  readonly canceled?: boolean;
  /** 要求の種類（Network の domain の ResourceType。取り消しの証拠になるのは `Document` だけ）。 */
  readonly type?: string;
  readonly errorText?: string;
}

/** 偽の harness の `calls` に残す、Context の `on` の呼び出しの印の頭（`ON:<事象の名前>`）。 */
const CONTEXT_ON_CALL_PREFIX = 'ON:';

/** `guardContextListenerEvents` で偽の Context に取り付ける Guard の許可 Origin。 */
const LISTENER_PROBE_ORIGIN = 'https://example.test';

/**
 * Guard（`installPassiveRequestGuard`）が Context に付ける listener の事象の名前の一覧（付ける順。DEF-110-fix round 1）。偽の Context に Guard を
 * 取り付け、その `on` の呼び出しから導く（listener の数や名前を、テストに書き写さない）。Guard は、閉じるときに同じ順で外す。
 */
export async function guardContextListenerEvents(): Promise<readonly string[]> {
  const harness = createGuardHarness();
  await installPassiveRequestGuard(harness.context, new SafetyLedger(), new Set([LISTENER_PROBE_ORIGIN]));
  return Object.freeze(harness.calls
    .filter((call) => call.startsWith(CONTEXT_ON_CALL_PREFIX))
    .map((call) => call.slice(CONTEXT_ON_CALL_PREFIX.length)));
}

/** 偽の harness の `calls` に残す、Guard の初期化のスクリプトの名前（DEF-040、DEF-049、DEF-124）。 */
function initScriptName(content: string | undefined): string {
  if (content === WORKER_CONNECT_POLICY_INIT_SCRIPT) return 'WORKER_CONNECT_POLICY';
  if (content === SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT) return 'SERVICE_WORKER_REGISTRATION_BLOCK';
  if (content === WEBRTC_BLOCK_INIT_SCRIPT) return 'WEBRTC_BLOCK';
  return 'UNKNOWN';
}

export function createGuardHarness(options: {
  readonly hasPage?: boolean;
  readonly webSocketInstallError?: Error;
  readonly httpInstallError?: Error;
  readonly httpInstallGate?: Promise<void>;
  readonly newCdpSessionError?: Error;
  readonly cdpOnErrorEvent?: string;
  readonly cdpSendErrorMethod?: string;
  readonly cdpSendGate?: { readonly method: string; readonly promise: Promise<void> };
  /**
   * 偽の page の session の `send` の差し替え（DEF-026）。Promise を返した命令は、その Promise を応答にする（失敗の注入、応答の保留）。
   * `undefined` を返した命令は、ほかの指定のとおりに扱う。
   */
  readonly cdpSendOverride?: (method: string, params: unknown) => Promise<unknown> | undefined;
  readonly contextCloseError?: Error;
  readonly contextCloseRejection?: { readonly value: unknown };
  readonly contextCloseAttempts?: readonly (
    | { readonly outcome: 'RESOLVE' }
    | { readonly outcome: 'REJECT'; readonly error: unknown }
  )[];
  readonly contextCloseGate?: Promise<void>;
  readonly onContextClose?: () => void;
} = {}): GuardHarness {
  const calls: string[] = [];
  const cdpCommands: string[] = [];
  const cdpCommandLog: Array<{ readonly method: string; readonly params: unknown }> = [];
  const removedListeners: string[] = [];
  let closeCount = 0;
  let httpHandler: GuardHarness['httpHandler'];
  let webSocketHandler: GuardHarness['webSocketHandler'];
  let requestFailedHandler: GuardHarness['requestFailedHandler'];
  let requestHandler: GuardHarness['requestHandler'];
  let pageHandler: GuardHarness['pageHandler'];
  let contextCloseHandler: GuardHarness['contextCloseHandler'];
  let cdpRequestPausedHandler: GuardHarness['cdpRequestPausedHandler'];
  let cdpCloseHandler: GuardHarness['cdpCloseHandler'];
  let cdpLoadingFailedHandler: GuardHarness['cdpLoadingFailedHandler'];
  let cdpRequestWillBeSentHandler: GuardHarness['cdpRequestWillBeSentHandler'];
  let cdpLogEntryAddedHandler: GuardHarness['cdpLogEntryAddedHandler'];
  /** page の session に付いた、すべての事象の listener（`emitCdp`。session を作り直しても共有する）。 */
  const cdpListeners = new Map<string, Set<(value?: unknown) => void>>();
  const registeredPages: Page[] = [];
  const rawContext = {
    pages(): object[] {
      return options.hasPage === true ? [{}] : registeredPages;
    },
    // DEF-040: Guard は、ページを作る前に、Worker の中の WebSocket を止める CSP の初期化のスクリプトを Context に付ける。
    // DEF-049: Service Worker の登録の入口を塞ぐ初期化のスクリプトも付ける。どのスクリプトかを `calls` に残す。
    async addInitScript(script?: { readonly content?: string }): Promise<void> {
      calls.push(`INIT_SCRIPT:${initScriptName(script?.content)}`);
    },
    on(event: string, handler: (value: unknown) => void): void {
      calls.push(`${CONTEXT_ON_CALL_PREFIX}${event}`);
      if (event === 'requestfailed') {
        requestFailedHandler = handler as GuardHarness['requestFailedHandler'];
      } else if (event === 'request') {
        requestHandler = handler as GuardHarness['requestHandler'];
      } else if (event === 'page') {
        pageHandler = handler as (page: Page) => void;
      } else if (event === 'close') {
        contextCloseHandler = handler as () => void;
      }
    },
    off(event: string, handler: (value: unknown) => void): void {
      removedListeners.push(`CONTEXT:${event}`);
      if (event === 'page' && pageHandler === handler) pageHandler = undefined;
      if (event === 'requestfailed' && requestFailedHandler === handler) requestFailedHandler = undefined;
      if (event === 'request' && requestHandler === handler) requestHandler = undefined;
      if (event === 'close' && contextCloseHandler === handler) contextCloseHandler = undefined;
    },
    async newCDPSession(): Promise<CDPSession> {
      calls.push('CDP');
      if (options.newCdpSessionError !== undefined) {
        throw options.newCdpSessionError;
      }
      const session = {
        on(event: string, handler: (value?: FakeCdpPausedEvent) => void): void {
          if (event === options.cdpOnErrorEvent) {
            throw new Error(`${event} listener setup failed`);
          }
          const listeners = cdpListeners.get(event) ?? new Set<(value?: unknown) => void>();
          listeners.add(handler as (value?: unknown) => void);
          cdpListeners.set(event, listeners);
          if (event === 'Fetch.requestPaused') {
            cdpRequestPausedHandler = handler as (event: FakeCdpPausedEvent) => void;
          } else if (event === 'close') {
            cdpCloseHandler = handler;
          } else if (event === 'Network.loadingFailed') {
            cdpLoadingFailedHandler = handler as (event: FakeCdpLoadingFailedEvent) => void;
          } else if (event === 'Network.requestWillBeSent') {
            cdpRequestWillBeSentHandler = handler as (event: unknown) => void;
          } else if (event === 'Log.entryAdded') {
            cdpLogEntryAddedHandler = handler as (event: unknown) => void;
          }
        },
        off(event: string, handler: (value?: FakeCdpPausedEvent) => void): void {
          removedListeners.push(`CDP:${event}`);
          cdpListeners.get(event)?.delete(handler as (value?: unknown) => void);
          if (event === 'Fetch.requestPaused' && cdpRequestPausedHandler === handler) {
            cdpRequestPausedHandler = undefined;
          }
          if (event === 'close' && cdpCloseHandler === handler) cdpCloseHandler = undefined;
          if (event === 'Network.loadingFailed' && cdpLoadingFailedHandler === handler) cdpLoadingFailedHandler = undefined;
          if (event === 'Log.entryAdded' && cdpLogEntryAddedHandler === handler) cdpLogEntryAddedHandler = undefined;
        },
        async send(method: string, params?: unknown): Promise<unknown> {
          cdpCommands.push(method);
          cdpCommandLog.push({ method, params });
          const overridden = options.cdpSendOverride?.(method, params);
          if (overridden !== undefined) {
            return overridden;
          }
          if (method === options.cdpSendErrorMethod) {
            throw new Error(`${method} failed`);
          }
          if (method === options.cdpSendGate?.method) {
            await options.cdpSendGate.promise;
          }
          if (method === 'Page.getFrameTree') {
            return { frameTree: { frame: { id: GUARD_HARNESS_ROOT_FRAME_ID } } };
          }
          // EL-F2（N1）: Guard は page の準備の終わりに、今の項目の URL を読む（外部スキームのエラーの頁でない、ふつうの頁）。
          if (method === 'Page.getNavigationHistory') {
            return { currentIndex: 0, entries: [{ id: 1, url: 'about:blank', userTypedURL: 'about:blank', title: '', transitionType: 'typed' }] };
          }
          return undefined;
        },
        // DEF-118: 本物の Playwright の CDPSession は `detach` を持つ（発見の CDP の session の部品 `cdp-session.ts` は、読み終わった session を
        // 切る）。偽の session も持つ（切っても何も起きない。Guard 自身は、この session を切らない）。
        async detach(): Promise<void> {
          return undefined;
        },
      };
      return session as unknown as CDPSession;
    },
    async routeWebSocket(
      _pattern: unknown,
      handler: (route: WebSocketRoute) => Promise<unknown> | unknown,
    ): Promise<void> {
      calls.push('WEBSOCKET');
      if (options.webSocketInstallError !== undefined) {
        throw options.webSocketInstallError;
      }
      webSocketHandler = handler;
    },
    async route(_pattern: unknown, handler: (route: Route) => Promise<unknown> | unknown): Promise<void> {
      calls.push('HTTP');
      if (options.httpInstallError !== undefined) {
        throw options.httpInstallError;
      }
      httpHandler = handler;
      await options.httpInstallGate;
    },
    async close(): Promise<void> {
      calls.push('CLOSE');
      const attemptIndex = closeCount;
      closeCount += 1;
      options.onContextClose?.();
      const attempt = options.contextCloseAttempts?.[attemptIndex];
      if (attempt?.outcome === 'REJECT') return Promise.reject(attempt.error);
      await options.contextCloseGate;
      if (attempt?.outcome === 'RESOLVE') return;
      if (options.contextCloseRejection !== undefined) {
        return Promise.reject(options.contextCloseRejection.value);
      }
      if (options.contextCloseError !== undefined) {
        throw options.contextCloseError;
      }
    },
  };
  return {
    context: rawContext as unknown as BrowserContext,
    calls,
    cdpCommands,
    cdpCommandLog,
    removedListeners,
    get closeCount(): number {
      return closeCount;
    },
    get httpHandler(): GuardHarness['httpHandler'] {
      return httpHandler;
    },
    get webSocketHandler(): GuardHarness['webSocketHandler'] {
      return webSocketHandler;
    },
    get requestFailedHandler(): GuardHarness['requestFailedHandler'] {
      return requestFailedHandler;
    },
    get requestHandler(): GuardHarness['requestHandler'] {
      return requestHandler;
    },
    get pageHandler(): GuardHarness['pageHandler'] {
      return pageHandler;
    },
    get contextCloseHandler(): GuardHarness['contextCloseHandler'] {
      return contextCloseHandler;
    },
    get cdpRequestPausedHandler(): GuardHarness['cdpRequestPausedHandler'] {
      // DEF-042: `resourceType` の指定のない偽の事象は、Document の事象として渡す（`FakeCdpPausedEvent.resourceType`）。
      const handler = cdpRequestPausedHandler;
      return handler === undefined ? undefined : (event) => handler({ resourceType: 'Document', ...event });
    },
    get cdpCloseHandler(): GuardHarness['cdpCloseHandler'] {
      return cdpCloseHandler;
    },
    get cdpLoadingFailedHandler(): GuardHarness['cdpLoadingFailedHandler'] {
      return cdpLoadingFailedHandler;
    },
    get cdpRequestWillBeSentHandler(): GuardHarness['cdpRequestWillBeSentHandler'] {
      return cdpRequestWillBeSentHandler;
    },
    get cdpLogEntryAddedHandler(): GuardHarness['cdpLogEntryAddedHandler'] {
      return cdpLogEntryAddedHandler;
    },
    registerPage(page: Page): void {
      registeredPages.push(page);
    },
    emitCdp(event: string, value?: unknown): void {
      for (const listener of [...(cdpListeners.get(event) ?? [])]) listener(value);
    },
  };
}

export function createHarnessPage(harness: GuardHarness, options: {
  readonly closeError?: Error;
  readonly closeGate?: Promise<void>;
  readonly url?: string;
  readonly onEvent?: (event: string, handler: (...arguments_: unknown[]) => void) => void;
  readonly onOffEvent?: (event: string, handler: (...arguments_: unknown[]) => void) => void;
} = {}): Page {
  let closed = false;
  const closeHandlers = new Set<() => void>();
  const page = {
    context: () => harness.context,
    isClosed: () => closed,
    url: () => options.url ?? 'about:blank',
    on(event: string, handler: (...arguments_: unknown[]) => void): Page {
      options.onEvent?.(event, handler);
      return page as unknown as Page;
    },
    once(event: string, handler: () => void): Page {
      if (event === 'close') {
        closeHandlers.add(handler);
      }
      return page as unknown as Page;
    },
    off(event: string, handler: (...arguments_: unknown[]) => void): Page {
      options.onOffEvent?.(event, handler);
      if (event === 'close') {
        closeHandlers.delete(handler as () => void);
      }
      return page as unknown as Page;
    },
    async close(): Promise<void> {
      await options.closeGate;
      if (options.closeError !== undefined) {
        throw options.closeError;
      }
      closed = true;
      for (const handler of closeHandlers) {
        handler();
      }
      closeHandlers.clear();
    },
  } as unknown as Page;
  harness.registerPage(page);
  harness.pageHandler?.(page);
  return page;
}

export async function readyHarnessPage(harness: GuardHarness): Promise<Page> {
  const page = createHarnessPage(harness);
  await awaitPassiveRequestGuardReady(page);
  return page;
}
