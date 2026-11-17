/**
 * 偽の口（RB-1。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 2 章 1・3.1）: ブラウザに頼む口（`src/browser/port/browser-port.ts`）を、
 * メモリの中のページと、通信の記録と、偽の時計で満たす。判定と段の進め方のテストは、本物の Chromium の代わりにこれを渡す。
 * - サイトは、URL ごとの台本（`FakeSite`）で書く。移動すると、台本の要求を通信の記録に足し、台本の答えを読めるページになる。台本にない URL は
 *   繋がらない（`NET_ERROR`）。`hangs` の URL は、偽の時計で期限まで待ってから `TIMED_OUT` になる。
 * - 読み手は、`id` ごとの記録の答えを、本物と同じく読み手の `parse` に通して返す。DOM は持たない。記録の答えが本物の答えと同じであることは、
 *   ずれの確かめ（RB-3）が照らす。台本に答えのない読み手は、テストの書き誤りなので例外にする（黙って失敗にしない）。
 * - スクリーンショットは書かない（書いた先の記録だけ）。
 */
import type { AuthenticatedStorageState } from '../../../src/core/authenticated-storage-state.js';
import type {
  BrowserHandle,
  BrowserPort,
  ContextHandle,
  ContextSpec,
  ElementRef,
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
} from '../../../src/browser/port/browser-port.js';
import type { FakeClock } from './fake-clock.js';

/** 移動したときに出る、台本の要求（主の文書の要求の後に、この順で出る）。 */
export interface FakeRequestScript {
  readonly method?: string;
  readonly url: string;
  readonly resourceType?: string;
  /** 応答の status（`failedWith` のときは応答なし）。 */
  readonly status?: number;
  readonly failedWith?: string;
}

/** URL ごとの台本。 */
export interface FakePageScript {
  readonly httpStatus?: number;
  /** リダイレクトの後の URL（省くと移動の URL）。 */
  readonly finalUrl?: string;
  readonly body?: string;
  /** 繋がらない（`NET_ERROR` の code）。 */
  readonly netError?: string;
  /** 応答しない（期限まで待って `TIMED_OUT`）。 */
  readonly hangs?: boolean;
  /** 読み手の `id` → 生の答え。 */
  readonly answers?: Readonly<Record<string, unknown>>;
  /** 要素の読み手の `id` → 生の答えと要素の参照。 */
  readonly elementAnswers?: Readonly<Record<string, { readonly value: unknown; readonly elements: readonly ElementRef[] }>>;
  readonly requests?: readonly FakeRequestScript[];
  /** 主の frame の下の frame の URL（主の frame の子）。 */
  readonly childFrameUrls?: readonly string[];
  /** 移動の後にページが出す事象（主の frame の `framenavigated` と台本の要求の後に、この順で届く。console・pageerror など）。 */
  readonly events?: readonly PageEvent[];
}

export type FakeSite = Readonly<Record<string, FakePageScript>>;

/** 繋がらない宛先の code（台本にない URL）。 */
export const FAKE_UNREACHABLE_NET_ERROR = 'net::ERR_CONNECTION_REFUSED';
/** 偽の Browser の版。 */
export const FAKE_BROWSER_VERSION = 'fake-browser';
const EMPTY_STORAGE_STATE: AuthenticatedStorageState = Object.freeze({ cookies: Object.freeze([]), origins: Object.freeze([]) });
const BLANK_URL = 'about:blank';

/** 読んだ認証の状態（本物と同じく、Origin ごとに IndexedDB を持つ。渡した状態になければ空）。 */
const storageStateReadOf = (state: AuthenticatedStorageState): AuthenticatedStorageState => Object.freeze({
  cookies: state.cookies,
  origins: Object.freeze(state.origins.map((origin) => Object.freeze({ ...origin, indexedDB: origin.indexedDB ?? Object.freeze([]) }))),
});

interface FakePage {
  readonly handle: PageHandle;
  url: string;
  script: FakePageScript | null;
  closed: boolean;
  readonly listeners: Set<(event: PageEvent) => void>;
}

interface FakeContext {
  readonly handle: ContextHandle;
  readonly spec: ContextSpec;
  readonly pages: FakePage[];
  closed: boolean;
}

interface NetworkListener {
  readonly scope: ContextHandle | PageHandle;
  readonly listener: (event: NetworkEvent) => void;
}

/** 偽の口と、テストが動かす口。 */
export interface FakeBrowserPort extends BrowserPort {
  /** 偽の Browser を 1 つ起こす。 */
  launch(): BrowserHandle;
  /** 作った Context の指定（作った順）。 */
  contextSpecs(): readonly ContextSpec[];
  /** 通信の記録（起きた順）。 */
  networkLog(): readonly NetworkEvent[];
  /** スクリーンショットを書いた先（書いた順）。 */
  screenshotPaths(): readonly string[];
  /** ページの事象を起こす。 */
  emitPageEvent(page: PageHandle, event: PageEvent): void;
  /** ページを crash させる（`crash` を届け、閉じたページにする）。 */
  crashPage(page: PageHandle): void;
}

export interface FakeBrowserPortOptions {
  readonly clock: FakeClock;
  readonly site: FakeSite;
}

const TIMED_OUT = Object.freeze({ status: 'TIMED_OUT' } as const);
const PAGE_GONE = Object.freeze({ status: 'PAGE_GONE' } as const);
const ANSWER_SHAPE = Object.freeze({ status: 'FAILED', reason: 'ANSWER_SHAPE' } as const);
const done = <T>(value: T): PortOutcome<T> => Object.freeze({ status: 'DONE', value });

export const createFakeBrowserPort = ({ clock, site }: FakeBrowserPortOptions): FakeBrowserPort => {
  let nextId = 0;
  const newId = (prefix: string): string => {
    nextId += 1;
    return `${prefix}${String(nextId)}`;
  };
  const browsers = new Map<string, { connected: boolean }>();
  const contexts = new Map<string, FakeContext>();
  const pages = new Map<string, FakePage>();
  const network: NetworkEvent[] = [];
  const networkListeners = new Set<NetworkListener>();
  const screenshots: string[] = [];

  const known = <T>(map: ReadonlyMap<string, T>, id: string): T => {
    const value = map.get(id);
    if (value === undefined) {
      throw new Error(`Unknown fake browser port handle: ${id}`);
    }
    return value;
  };
  const pageOf = (handle: PageHandle): FakePage => known(pages, handle.id);
  const contextOf = (handle: ContextHandle): FakeContext => known(contexts, handle.id);

  const emit = (page: FakePage, event: PageEvent): void => {
    for (const listener of [...page.listeners]) {
      listener(event);
    }
  };
  const record = (page: FakePage, event: NetworkEvent): void => {
    network.push(event);
    for (const { scope, listener } of [...networkListeners]) {
      if (scope.kind === 'page' ? scope.id === page.handle.id : scope.id === page.handle.contextId) {
        listener(event);
      }
    }
  };
  const recordRequest = (page: FakePage, request: FakeRequestScript, isNavigation: boolean): void => {
    const id = newId('r');
    record(page, Object.freeze({
      kind: 'request',
      id,
      pageId: page.handle.id,
      method: request.method ?? 'GET',
      url: request.url,
      resourceType: request.resourceType ?? (isNavigation ? 'document' : 'fetch'),
      isNavigation,
      isMainFrame: true,
      redirectedFromId: null,
    }));
    if (request.failedWith !== undefined) {
      record(page, Object.freeze({ kind: 'failed', id, errorText: request.failedWith }));
      return;
    }
    record(page, Object.freeze({ kind: 'response', id, status: request.status ?? 200 }));
    record(page, Object.freeze({ kind: 'finished', id }));
  };
  const closePageNow = (page: FakePage): void => {
    if (!page.closed) {
      page.closed = true;
      emit(page, { kind: 'close' });
    }
  };
  const openPageIn = (context: FakeContext): FakePage => {
    const page: FakePage = {
      handle: Object.freeze({ kind: 'page', id: newId('p'), contextId: context.handle.id }),
      url: BLANK_URL,
      script: null,
      closed: false,
      listeners: new Set(),
    };
    pages.set(page.handle.id, page);
    context.pages.push(page);
    return page;
  };
  /** 期限まで待つ（待つ間にページが閉じたら `PAGE_GONE`）。 */
  const waitUntilTimeout = async (page: FakePage, wait: PortWait): Promise<typeof TIMED_OUT | typeof PAGE_GONE> => {
    await clock.sleep(wait.timeoutMs);
    return page.closed ? PAGE_GONE : TIMED_OUT;
  };
  const answerOf = (page: FakePage, readerId: string): unknown => {
    const answers = page.script?.answers ?? {};
    if (!Object.hasOwn(answers, readerId)) {
      throw new Error(`The fake site has no answer for the reader ${readerId} at ${page.url}`);
    }
    return answers[readerId];
  };

  return {
    launch: () => {
      const handle: BrowserHandle = Object.freeze({ kind: 'browser', id: newId('b') });
      browsers.set(handle.id, { connected: true });
      return handle;
    },
    contextSpecs: () => Object.freeze([...contexts.values()].map((context) => context.spec)),
    networkLog: () => Object.freeze([...network]),
    screenshotPaths: () => Object.freeze([...screenshots]),
    emitPageEvent: (page, event) => emit(pageOf(page), event),
    crashPage: (handle) => {
      const page = pageOf(handle);
      emit(page, { kind: 'crash' });
      page.closed = true;
    },

    // B
    browserVersion: (browser) => {
      known(browsers, browser.id);
      return FAKE_BROWSER_VERSION;
    },
    isBrowserConnected: (browser) => known(browsers, browser.id).connected,
    closeBrowser: (browser) => {
      known(browsers, browser.id).connected = false;
      for (const context of contexts.values()) {
        if (context.handle.browserId === browser.id) {
          context.closed = true;
          context.pages.forEach(closePageNow);
        }
      }
      return Promise.resolve(done(undefined));
    },

    // C
    createContext: (browser, spec) => {
      if (!known(browsers, browser.id).connected) {
        return Promise.resolve(PAGE_GONE);
      }
      const handle: ContextHandle = Object.freeze({ kind: 'context', id: newId('c'), browserId: browser.id });
      contexts.set(handle.id, { handle, spec, pages: [], closed: false });
      return Promise.resolve(done(handle));
    },
    closeContext: (handle) => {
      const context = contextOf(handle);
      context.closed = true;
      context.pages.forEach(closePageNow);
      return Promise.resolve(done(undefined));
    },
    readStorageState: (handle) => {
      const context = contextOf(handle);
      return Promise.resolve(context.closed ? PAGE_GONE : done(storageStateReadOf(context.spec.storageState ?? EMPTY_STORAGE_STATE)));
    },
    contextPages: (handle) => Object.freeze(contextOf(handle).pages.filter((page) => !page.closed).map((page) => page.handle)),

    // P
    openPage: (handle) => {
      const context = contextOf(handle);
      return Promise.resolve(context.closed ? PAGE_GONE : done(openPageIn(context).handle));
    },
    closePage: (handle) => {
      closePageNow(pageOf(handle));
      return Promise.resolve(done(undefined));
    },
    isPageClosed: (handle) => pageOf(handle).closed,
    navigate: async (handle, url, options: NavigationOptions): Promise<NavigationOutcome> => {
      const page = pageOf(handle);
      if (page.closed) {
        return PAGE_GONE;
      }
      const script = site[url];
      if (script?.hangs === true) {
        return waitUntilTimeout(page, options);
      }
      if (script === undefined || script.netError !== undefined) {
        const code = script?.netError ?? FAKE_UNREACHABLE_NET_ERROR;
        recordRequest(page, { url, failedWith: code }, true);
        return Object.freeze({ status: 'NET_ERROR', code });
      }
      const httpStatus = script.httpStatus ?? 200;
      recordRequest(page, { url, status: httpStatus }, true);
      page.url = script.finalUrl ?? url;
      page.script = script;
      emit(page, { kind: 'framenavigated', url: page.url, isMainFrame: true });
      for (const request of script.requests ?? []) {
        recordRequest(page, request, false);
      }
      for (const event of script.events ?? []) {
        emit(page, event);
      }
      const body = options.readBody === true ? { body: script.body ?? null } : {};
      return Object.freeze({ status: 'RESPONDED', httpStatus, finalUrl: page.url, ...body });
    },
    waitForLoadState: async (handle, _state: LoadState, wait) => {
      const page = pageOf(handle);
      if (page.closed) {
        return PAGE_GONE;
      }
      return page.script?.hangs === true ? waitUntilTimeout(page, wait) : done(undefined);
    },
    pageUrl: (handle) => pageOf(handle).url,
    frames: (handle): readonly FrameSnapshot[] => {
      const page = pageOf(handle);
      return Object.freeze([
        Object.freeze({ index: 0, parentIndex: null, url: page.url }),
        ...(page.script?.childFrameUrls ?? []).map((url, index) => Object.freeze({ index: index + 1, parentIndex: 0, url })),
      ]);
    },
    onPageEvent: (handle, listener): Unsubscribe => {
      const page = pageOf(handle);
      page.listeners.add(listener);
      return () => page.listeners.delete(listener);
    },

    // R
    read: async <I, O>(handle: PageHandle, reader: NamedPageReader<I, O>, _input: I, _options: ReadOptions): Promise<PortOutcome<O>> => {
      const page = pageOf(handle);
      if (page.closed) {
        return PAGE_GONE;
      }
      const value = reader.parse(answerOf(page, reader.id));
      return value === null ? ANSWER_SHAPE : done(value);
    },
    readElements: async <I, O>(handle: PageHandle, reader: NamedElementReader<I, O>, _input: I, _wait: PortWait): Promise<PortOutcome<ElementsAnswer<O>>> => {
      const page = pageOf(handle);
      if (page.closed) {
        return PAGE_GONE;
      }
      const answers = page.script?.elementAnswers ?? {};
      const answer = Object.hasOwn(answers, reader.id) ? answers[reader.id] : undefined;
      if (answer === undefined) {
        throw new Error(`The fake site has no element answer for the reader ${reader.id} at ${page.url}`);
      }
      const value = reader.parse(answer.value);
      return value === null ? ANSWER_SHAPE : done(Object.freeze({ value, elements: Object.freeze([...answer.elements]) }));
    },
    screenshot: (handle, options: ScreenshotOptions) => {
      if (pageOf(handle).closed) {
        return Promise.resolve(PAGE_GONE);
      }
      screenshots.push(options.outputPath);
      return Promise.resolve(done(undefined));
    },

    // N
    onNetwork: (scope, listener): Unsubscribe => {
      const entry: NetworkListener = { scope, listener };
      networkListeners.add(entry);
      return () => networkListeners.delete(entry);
    },
  };
};
