// ブラウザに頼む口の、本物（Playwright の adapter）の骨組み（RB-1。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 3.1）。
// - `src/browser/playwright/` は、Playwright を import してよい唯一の所（Gate `playwright-import-allowlist`。移る途中は、ほかのファイルを件数つきの
//   例外に置く）。口の型は `src/browser/port/browser-port.ts` が持つ。
// - 今は誰も使わない（振る舞いを変えない）。本物と偽が同じ答えを返すことは、ずれの確かめ（RB-3）で照らす。
// - Browser は起こさない: 起動は今の起動の部品（`src/browser/chromium-launch.ts`）が持ち、起こした Browser を `adoptBrowser` で受ける。
// - Context は自分で作らない: 作るのは、渡された開き手（`openContext`。本番では Guard を取り付ける今の factory）。口が Guard のない Context を
//   作る道を持たないため。
// - 失敗の文言は外へ出さない（`PortOutcome` の閉じた理由だけ）。期限切れは `TIMED_OUT`、閉じたページ・Context・Browser への操作は `PAGE_GONE`
//   （偽の口と同じ答え。ずれの確かめ `tests/contract/port-operations.test.ts`）。
import type { Browser, BrowserContext, Page, Request } from 'playwright';
import type { AuthenticatedStorageState } from '../../core/authenticated-storage-state.js';
import { awaitBeforeDeadline, deadlineWithinTimeoutAtMs } from '../../core/deadline.js';
import { readElementsInIsolatedWorld, readInIsolatedWorld } from '../../discovery/isolated-read.js';
import { chromiumNetErrorCode } from '../../orchestration/page-navigation.js';
import { isResponseReceivedFailure, RESPONSE_RECEIVED_FAILURE_CODES } from '../../safety/network-layer-failure.js';
import { readContextStorageState } from '../context-factory.js';
import { trackMainFrameDocument } from '../main-frame-load.js';
import { isPlaywrightTimeoutError } from '../playwright-errors.js';
import type {
  BrowserHandle,
  BrowserPort,
  ContextHandle,
  ContextSpec,
  ElementsAnswer,
  FrameSnapshot,
  LoadState,
  NamedElementReader,
  NamedPageReader,
  NavigationOptions,
  NavigationOutcome,
  NetworkEvent,
  PageEvent,
  PageHandle,
  PortOutcome,
  PortWait,
  ReadOptions,
  ScreenshotOptions,
  Unsubscribe,
} from '../port/browser-port.js';

/** 本物の口の依存。 */
export interface PlaywrightBrowserPortDependencies {
  /** Context の開き手（Guard の取り付けを含む）。 */
  readonly openContext: (browser: Browser, spec: ContextSpec) => Promise<BrowserContext>;
}

const TIMED_OUT = Object.freeze({ status: 'TIMED_OUT' } as const);
const PAGE_GONE = Object.freeze({ status: 'PAGE_GONE' } as const);
const OPERATION_FAILED = Object.freeze({ status: 'FAILED', reason: 'OPERATION_FAILED' } as const);
const ANSWER_SHAPE = Object.freeze({ status: 'FAILED', reason: 'ANSWER_SHAPE' } as const);
const done = <T>(value: T): PortOutcome<T> => Object.freeze({ status: 'DONE', value });
/** 応答を受けた後の失敗のうち、本文のない 4xx・5xx の応答のもの（`RESPONSE_RECEIVED_FAILURE_CODES` の先頭）。 */
const BODYLESS_RESPONSE_FAILURE_CODE: string = RESPONSE_RECEIVED_FAILURE_CODES[0];

/** 本物の口（Playwright の adapter）。 */
export class PlaywrightBrowserPort implements BrowserPort {
  readonly #dependencies: PlaywrightBrowserPortDependencies;
  #nextId = 0;
  readonly #browsers = new Map<string, Browser>();
  readonly #contexts = new Map<string, BrowserContext>();
  readonly #contextHandles = new Map<string, ContextHandle>();
  readonly #closedContexts = new Set<string>();
  readonly #pages = new Map<string, Page>();
  readonly #pageHandles = new WeakMap<Page, PageHandle>();
  readonly #requestIds = new WeakMap<Request, string>();

  constructor(dependencies: PlaywrightBrowserPortDependencies) {
    this.#dependencies = dependencies;
  }

  /** 起動の部品で起こした Browser を受ける。 */
  adoptBrowser(browser: Browser): BrowserHandle {
    const handle: BrowserHandle = Object.freeze({ kind: 'browser', id: this.#newId('b') });
    this.#browsers.set(handle.id, browser);
    return handle;
  }

  // B -----------------------------------------------------------------------------------------------------------

  browserVersion(browser: BrowserHandle): string {
    return this.#browser(browser).version();
  }

  isBrowserConnected(browser: BrowserHandle): boolean {
    return this.#browser(browser).isConnected();
  }

  closeBrowser(browser: BrowserHandle, wait: PortWait): Promise<PortOutcome<void>> {
    const target = this.#browser(browser);
    return this.#run(() => !target.isConnected(), wait, () => target.close());
  }

  // C -----------------------------------------------------------------------------------------------------------

  async createContext(browser: BrowserHandle, spec: ContextSpec, wait: PortWait): Promise<PortOutcome<ContextHandle>> {
    const target = this.#browser(browser);
    const opened = await this.#run(() => !target.isConnected(), wait, () => this.#dependencies.openContext(target, spec));
    if (opened.status !== 'DONE') {
      return opened;
    }
    const handle: ContextHandle = Object.freeze({ kind: 'context', id: this.#newId('c'), browserId: browser.id });
    this.#contexts.set(handle.id, opened.value);
    this.#contextHandles.set(handle.id, handle);
    opened.value.on('page', (page) => this.#adoptPage(handle, page));
    opened.value.once('close', () => this.#closedContexts.add(handle.id));
    return done(handle);
  }

  closeContext(context: ContextHandle, wait: PortWait): Promise<PortOutcome<void>> {
    return this.#run(this.#contextGone(context), wait, () => this.#context(context).close());
  }

  readStorageState(context: ContextHandle, wait: PortWait): Promise<PortOutcome<AuthenticatedStorageState>> {
    return this.#run(this.#contextGone(context), wait, () => readContextStorageState(this.#context(context)));
  }

  contextPages(context: ContextHandle): readonly PageHandle[] {
    return Object.freeze(this.#context(context).pages().map((page) => this.#adoptPage(context, page)));
  }

  // P -----------------------------------------------------------------------------------------------------------

  async openPage(context: ContextHandle, wait: PortWait): Promise<PortOutcome<PageHandle>> {
    const opened = await this.#run(this.#contextGone(context), wait, () => this.#context(context).newPage());
    return opened.status === 'DONE' ? done(this.#adoptPage(context, opened.value)) : opened;
  }

  closePage(page: PageHandle, wait: PortWait): Promise<PortOutcome<void>> {
    const target = this.#page(page);
    return this.#run(() => target.isClosed(), wait, () => target.close());
  }

  isPageClosed(page: PageHandle): boolean {
    return this.#page(page).isClosed();
  }

  async navigate(page: PageHandle, url: string, options: NavigationOptions): Promise<NavigationOutcome> {
    const target = this.#page(page);
    const tracker = trackMainFrameDocument(target);
    try {
      const response = await target.goto(url, { waitUntil: options.waitUntil, timeout: options.timeoutMs });
      if (response === null) {
        return Object.freeze({ status: 'NO_RESPONSE', finalUrl: target.url() });
      }
      const body = options.readBody === true ? { body: await response.text().catch(() => null) } : {};
      return Object.freeze({ status: 'RESPONDED', httpStatus: response.status(), finalUrl: target.url(), ...body });
    } catch (error) {
      if (target.isClosed()) {
        return PAGE_GONE;
      }
      if (isPlaywrightTimeoutError(error)) {
        return TIMED_OUT;
      }
      const code = chromiumNetErrorCode(error instanceof Error ? error.message : null);
      const httpStatus = tracker.latestResponseStatus();
      const finalUrl = tracker.latestResponseUrl();
      if (code !== null && isResponseReceivedFailure(code) && httpStatus !== null && finalUrl !== null) {
        // DEF-029・DEF-030: CLI の起動の設定の Chromium は、本文のない 4xx・5xx の応答を読み込みの失敗にする（テストの既定の Chromium は応答に
        // する）。応答（ヘッダ）は受けているので、どちらの Chromium でも応答として返す（本文のない応答の本文は空。認証の失敗の本文は読めない）。
        const body = options.readBody === true ? { body: code === BODYLESS_RESPONSE_FAILURE_CODE ? '' : null } : {};
        return Object.freeze({ status: 'RESPONDED', httpStatus, finalUrl, ...body });
      }
      return Object.freeze({ status: 'NET_ERROR', code });
    } finally {
      tracker.dispose();
    }
  }

  waitForLoadState(page: PageHandle, state: LoadState, wait: PortWait): Promise<PortOutcome<void>> {
    const target = this.#page(page);
    return this.#run(() => target.isClosed(), wait, () => target.waitForLoadState(state, { timeout: wait.timeoutMs }));
  }

  pageUrl(page: PageHandle): string {
    return this.#page(page).url();
  }

  frames(page: PageHandle): readonly FrameSnapshot[] {
    const frames = this.#page(page).frames();
    return Object.freeze(frames.map((frame, index) => {
      const parent = frame.parentFrame();
      return Object.freeze({ index, parentIndex: parent === null ? null : frames.indexOf(parent), url: frame.url() });
    }));
  }

  onPageEvent(page: PageHandle, listener: (event: PageEvent) => void): Unsubscribe {
    const context = lookup(this.#contextHandles, page.contextId);
    return subscribe(this.#page(page), [
      ['crash', () => listener({ kind: 'crash' })],
      ['close', () => listener({ kind: 'close' })],
      ['popup', (popup: Page) => listener({ kind: 'popup', page: this.#adoptPage(context, popup) })],
      ['download', (download: { url(): string }) => listener({ kind: 'download', url: download.url() })],
      ['framenavigated', (frame: { url(): string; parentFrame(): unknown }) =>
        listener({ kind: 'framenavigated', url: frame.url(), isMainFrame: frame.parentFrame() === null })],
      ['console', (message: { type(): string; text(): string }) => listener({ kind: 'console', level: message.type(), text: message.text() })],
      ['pageerror', (error: Error) => listener({ kind: 'pageerror', message: error.message })],
    ]);
  }

  // R -----------------------------------------------------------------------------------------------------------

  async read<I, O>(page: PageHandle, reader: NamedPageReader<I, O>, input: I, options: ReadOptions): Promise<PortOutcome<O>> {
    const target = this.#page(page);
    if (options.world === 'ISOLATED') {
      const outcome = await readInIsolatedWorld(target, reader.run, input, deadlineWithinTimeoutAtMs(undefined, options.timeoutMs));
      return outcome.status === 'READ' ? parsed(reader.parse(outcome.value)) : this.#failedOrGone(target);
    }
    // Playwright の `evaluate` の型は、引数の型を箱から出した形（`Unboxed`）で照らすので、型の引数のままでは合わない。値は JSON で渡せる入力。
    const run = reader.run as (input: unknown) => unknown;
    const raw = await this.#run(() => target.isClosed(), options, () => target.evaluate(run, input as unknown));
    return raw.status === 'DONE' ? parsed(reader.parse(raw.value)) : raw;
  }

  async readElements<I, O>(
    page: PageHandle,
    reader: NamedElementReader<I, O>,
    input: I,
    wait: PortWait,
  ): Promise<PortOutcome<ElementsAnswer<O>>> {
    const target = this.#page(page);
    const outcome = await readElementsInIsolatedWorld(target, reader.run, input, deadlineWithinTimeoutAtMs(undefined, wait.timeoutMs));
    if (outcome.status !== 'READ') {
      return this.#failedOrGone(target);
    }
    const value = reader.parse(outcome.value);
    return value === null ? ANSWER_SHAPE : done(Object.freeze({ value, elements: outcome.elements }));
  }

  screenshot(page: PageHandle, options: ScreenshotOptions): Promise<PortOutcome<void>> {
    const target = this.#page(page);
    return this.#run(() => target.isClosed(), options, async () => {
      await target.screenshot({ path: options.outputPath, type: 'png', fullPage: options.fullPage, timeout: options.timeoutMs });
    });
  }

  // N -----------------------------------------------------------------------------------------------------------

  onNetwork(scope: ContextHandle | PageHandle, listener: (event: NetworkEvent) => void): Unsubscribe {
    return subscribe(scope.kind === 'page' ? this.#page(scope) : this.#context(scope), [
      ['request', (request: Request) => listener(this.#requestEvent(request))],
      ['response', (response: { request(): Request; status(): number }) =>
        listener({ kind: 'response', id: this.#requestId(response.request()), status: response.status() })],
      ['requestfinished', (request: Request) => listener({ kind: 'finished', id: this.#requestId(request) })],
      ['requestfailed', (request: Request) =>
        listener({ kind: 'failed', id: this.#requestId(request), errorText: request.failure()?.errorText ?? '' })],
    ]);
  }

  // 内側 ---------------------------------------------------------------------------------------------------------

  #newId(prefix: string): string {
    this.#nextId += 1;
    return `${prefix}${String(this.#nextId)}`;
  }

  #browser(handle: BrowserHandle): Browser {
    return lookup(this.#browsers, handle.id);
  }

  #context(handle: ContextHandle): BrowserContext {
    return lookup(this.#contexts, handle.id);
  }

  #page(handle: PageHandle): Page {
    return lookup(this.#pages, handle.id);
  }

  #adoptPage(context: ContextHandle, page: Page): PageHandle {
    const known = this.#pageHandles.get(page);
    if (known !== undefined) {
      return known;
    }
    const handle: PageHandle = Object.freeze({ kind: 'page', id: this.#newId('p'), contextId: context.id });
    this.#pageHandles.set(page, handle);
    this.#pages.set(handle.id, page);
    return handle;
  }

  #requestId(request: Request): string {
    const known = this.#requestIds.get(request);
    if (known !== undefined) {
      return known;
    }
    const id = this.#newId('r');
    this.#requestIds.set(request, id);
    return id;
  }

  #requestEvent(request: Request): NetworkEvent {
    const frame = request.frame();
    const redirectedFrom = request.redirectedFrom();
    const page = frame.page();
    return Object.freeze({
      kind: 'request',
      id: this.#requestId(request),
      pageId: this.#pageHandles.get(page)?.id ?? null,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      isNavigation: request.isNavigationRequest(),
      isMainFrame: frame.parentFrame() === null,
      redirectedFromId: redirectedFrom === null ? null : this.#requestId(redirectedFrom),
    });
  }

  #failedOrGone(page: Page): PortOutcome<never> {
    return page.isClosed() ? PAGE_GONE : OPERATION_FAILED;
  }

  /** Context が閉じたか（閉じた事象を受けたか、Browser が切れた）。 */
  #contextGone(handle: ContextHandle): () => boolean {
    const browser = this.#browser({ kind: 'browser', id: handle.browserId });
    return () => this.#closedContexts.has(handle.id) || !browser.isConnected();
  }

  /** 期限つきで行い、例外を結果に替える（失敗のときに `gone` が真なら、閉じた物への操作として `PAGE_GONE` にする）。 */
  async #run<T>(gone: () => boolean, wait: PortWait, operation: () => Promise<T>): Promise<PortOutcome<T>> {
    const outcome = await awaitBeforeDeadline(operation(), deadlineWithinTimeoutAtMs(undefined, wait.timeoutMs));
    if (outcome.status === 'FULFILLED') {
      return done(outcome.value);
    }
    if (gone()) {
      return PAGE_GONE;
    }
    return outcome.status === 'DEADLINE_EXCEEDED' || isPlaywrightTimeoutError(outcome.reason) ? TIMED_OUT : OPERATION_FAILED;
  }
}

const parsed = <O>(value: O | null): PortOutcome<O> => (value === null ? ANSWER_SHAPE : done(value));

/** Playwright の事象の受け手の組（名前と受け手）を付け、外す関数を返す（Page と BrowserContext の `on`・`off` は名前ごとの多重の型なので、名前で付ける）。 */
type Subscription = readonly [string, (...args: never[]) => void];
const subscribe = (target: Page | BrowserContext, subscriptions: readonly Subscription[]): Unsubscribe => {
  const emitter = target as unknown as { on(name: string, handler: Subscription[1]): void; off(name: string, handler: Subscription[1]): void };
  for (const [name, handler] of subscriptions) {
    emitter.on(name, handler);
  }
  return () => {
    for (const [name, handler] of subscriptions) {
      emitter.off(name, handler);
    }
  };
};

const lookup = <T>(map: ReadonlyMap<string, T>, id: string): T => {
  const value = map.get(id);
  if (value === undefined) {
    throw new Error('Unknown browser port handle');
  }
  return value;
};
