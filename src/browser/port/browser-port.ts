// ブラウザに頼む口（port）の型の唯一の owner（RB-1。設計書 `2026-11-15-beaksight-test-rebuild-design.md` 2 章 1・3.1）。
// - 判定と段の進め方は、Playwright を直に呼ばず、この口を通してブラウザに頼む（移る途中。今は誰も使わない）。
// - 口の中身は 2 つ: 本物（`src/browser/playwright/`。Playwright を import してよい唯一の所）と、偽（`tests/helpers/fake-browser-port/`。メモリの
//   中のページと通信の記録と偽の時計）。どちらも、この型を満たす。本物と偽が同じ答えを返すことは、ずれの確かめ（RB-3）で照らす。
// - このファイルは Playwright を import しない（型も使わない）。値は plain な readonly の object で、Playwright の物を外に出さない。
//   handle（`BrowserHandle`・`ContextHandle`・`PageHandle`）は中身を持たない印で、本物は handle から Playwright の物を引く。
// - 口は判定しない。止める・通すの判定は、今の owner（`src/safety/request-policy.ts`・Guard）のまま。口は頼まれたことを行い、結果を返す。
// - 失敗は例外にせず、判別できる結果（`PortOutcome`）で返す。失敗の理由は閉じた一覧の code だけで、例外の文言（秘密を含みうる）を出さない。
// - 待ちの長さ（`timeoutMs`）は、呼ぶ側の名前つきの値から渡す（口は値を持たない）。
// - この段（RB-1）の操作は、起動のほかの B（Browser）・C（Context）・P（ページ）・R（読む）・N（通信を観る）の一部。押す・入れる（A）と、
//   止める・通す（I）は、それを使う段で足す。
import type { AuthenticatedStorageState } from '../../core/authenticated-storage-state.js';

/** Browser の印（中身を持たない）。 */
export interface BrowserHandle {
  readonly kind: 'browser';
  readonly id: string;
}

/** Context の印（中身を持たない）。 */
export interface ContextHandle {
  readonly kind: 'context';
  readonly id: string;
  readonly browserId: string;
}

/** ページの印（中身を持たない）。 */
export interface PageHandle {
  readonly kind: 'page';
  readonly id: string;
  readonly contextId: string;
}

/**
 * 要素の参照（隔離の world の読みが返す）。`backendNodeId` は CDP の要素の番号（文書が同じ間は変わらない）。`path` は文書の根からの位置
 * （`StandardReaders` の `elementPathOf`。shadow root の中と、文書につながっていない要素は null）。
 */
export interface ElementRef {
  readonly backendNodeId: number;
  readonly path: readonly number[] | null;
}

/** 失敗の理由の閉じた一覧。`ANSWER_SHAPE`: 答えの形が読み手の `parse` に合わない。`OPERATION_FAILED`: ブラウザの側の失敗。 */
export const PORT_FAILURE_REASONS = Object.freeze(['ANSWER_SHAPE', 'OPERATION_FAILED'] as const);
export type PortFailureReason = (typeof PORT_FAILURE_REASONS)[number];

/** 口の操作の結果。`PAGE_GONE` は、ページか Context が閉じた（crash を含む）。 */
export type PortOutcome<T> =
  | { readonly status: 'DONE'; readonly value: T }
  | { readonly status: 'TIMED_OUT' }
  | { readonly status: 'PAGE_GONE' }
  | { readonly status: 'FAILED'; readonly reason: PortFailureReason };

/** 待ちの長さ（ms。呼ぶ側の名前つきの値）。 */
export interface PortWait {
  readonly timeoutMs: number;
}

/** 受け手を外す関数。 */
export type Unsubscribe = () => void;

// B（Browser）-----------------------------------------------------------------------------------------------------

export interface BrowserOperations {
  /** Browser の版の文字列。 */
  browserVersion(browser: BrowserHandle): string;
  /** Browser がつながっているか。 */
  isBrowserConnected(browser: BrowserHandle): boolean;
  /** Browser を閉じる（期限の中に閉じなければ `TIMED_OUT`）。 */
  closeBrowser(browser: BrowserHandle, wait: PortWait): Promise<PortOutcome<void>>;
}

// C（Context）-----------------------------------------------------------------------------------------------------

/** Context を作るときの指定。Guard の取り付けは、本物の口に渡す開き手（今の factory）が受け持つ。 */
export interface ContextSpec {
  readonly viewport: { readonly width: number; readonly height: number };
  readonly storageState?: AuthenticatedStorageState;
}

export interface ContextOperations {
  createContext(browser: BrowserHandle, spec: ContextSpec, wait: PortWait): Promise<PortOutcome<ContextHandle>>;
  closeContext(context: ContextHandle, wait: PortWait): Promise<PortOutcome<void>>;
  /** 認証の状態（Cookie・localStorage・IndexedDB）を読む。 */
  readStorageState(context: ContextHandle, wait: PortWait): Promise<PortOutcome<AuthenticatedStorageState>>;
  /** Context の開いているページ（開いた順）。 */
  contextPages(context: ContextHandle): readonly PageHandle[];
}

// P（ページ）-----------------------------------------------------------------------------------------------------

/** 移動の待ちの終わり。 */
export type NavigationWaitUntil = 'commit' | 'domcontentloaded' | 'load';

export interface NavigationOptions extends PortWait {
  readonly waitUntil: NavigationWaitUntil;
  /** 応答の本文を読むか（robots.txt・sitemap など）。 */
  readonly readBody?: boolean;
}

/**
 * 移動の結果。`RESPONDED` は主の文書の応答（`body` は `readBody` のときだけ。読めなければ null）。`NO_RESPONSE` は応答のない移動
 * （同じ文書の中の移動など）。`NET_ERROR` の `code` は Chromium の `net::ERR_*`（なければ null）。
 */
export type NavigationOutcome =
  | { readonly status: 'RESPONDED'; readonly httpStatus: number; readonly finalUrl: string; readonly body?: string | null }
  | { readonly status: 'NO_RESPONSE'; readonly finalUrl: string }
  | { readonly status: 'NET_ERROR'; readonly code: string | null }
  | { readonly status: 'TIMED_OUT' }
  | { readonly status: 'PAGE_GONE' };

/** frame の写し（`frames` の順の番号で親を指す。主の frame の `parentIndex` は null）。 */
export interface FrameSnapshot {
  readonly index: number;
  readonly parentIndex: number | null;
  readonly url: string;
}

/** ページの事象。 */
export type PageEvent =
  | { readonly kind: 'crash' }
  | { readonly kind: 'close' }
  | { readonly kind: 'popup'; readonly page: PageHandle }
  | { readonly kind: 'download'; readonly url: string }
  | { readonly kind: 'framenavigated'; readonly url: string; readonly isMainFrame: boolean }
  | { readonly kind: 'console'; readonly level: string; readonly text: string }
  | { readonly kind: 'pageerror'; readonly message: string };

/** 読み込みの段階の待ち。 */
export type LoadState = 'domcontentloaded' | 'load';

export interface PageOperations {
  openPage(context: ContextHandle, wait: PortWait): Promise<PortOutcome<PageHandle>>;
  closePage(page: PageHandle, wait: PortWait): Promise<PortOutcome<void>>;
  isPageClosed(page: PageHandle): boolean;
  navigate(page: PageHandle, url: string, options: NavigationOptions): Promise<NavigationOutcome>;
  waitForLoadState(page: PageHandle, state: LoadState, wait: PortWait): Promise<PortOutcome<void>>;
  pageUrl(page: PageHandle): string;
  frames(page: PageHandle): readonly FrameSnapshot[];
  onPageEvent(page: PageHandle, listener: (event: PageEvent) => void): Unsubscribe;
}

// R（読む）---------------------------------------------------------------------------------------------------------

/**
 * 名前つきの読み手。`run` はページの中で動く関数（外の値を参照しない。文字列にして渡す。`composeInPage` で組み立てたものを含む）。
 * `parse` は生の答えを確かめて型つきの答えにする（形が違えば null）。本物は `run` を動かした答えを、偽は `id` ごとの記録の答えを、
 * どちらも `parse` に通す。
 */
export interface NamedPageReader<I, O> {
  readonly id: string;
  readonly run: (input: I) => unknown;
  readonly parse: (raw: unknown) => O | null;
}

/** 要素の参照も返す読み手（`run` は `{ value, elements }` を返す。`parse` は `value` に通す）。 */
export interface NamedElementReader<I, O> {
  readonly id: string;
  readonly run: (input: I) => { readonly value: unknown; readonly elements: readonly Element[] };
  readonly parse: (raw: unknown) => O | null;
}

/** 読む world。`ISOLATED` はページの JS が答えを偽れない world。 */
export type ReadWorld = 'MAIN' | 'ISOLATED';

export interface ReadOptions extends PortWait {
  readonly world: ReadWorld;
}

/** 要素の参照つきの答え。 */
export interface ElementsAnswer<O> {
  readonly value: O;
  readonly elements: readonly ElementRef[];
}

export interface ScreenshotOptions extends PortWait {
  readonly fullPage: boolean;
  readonly outputPath: string;
}

export interface ReadOperations {
  read<I, O>(page: PageHandle, reader: NamedPageReader<I, O>, input: I, options: ReadOptions): Promise<PortOutcome<O>>;
  /** 隔離の world で読み、答えと要素の参照を返す。 */
  readElements<I, O>(page: PageHandle, reader: NamedElementReader<I, O>, input: I, wait: PortWait): Promise<PortOutcome<ElementsAnswer<O>>>;
  /** PNG を `outputPath` に書く。 */
  screenshot(page: PageHandle, options: ScreenshotOptions): Promise<PortOutcome<void>>;
}

// N（通信を観る）---------------------------------------------------------------------------------------------------

/**
 * 通信の事象（plain な値。頭書きと本文は持たない。秘密を含みうるため、要る段で別の操作として足す）。`id` は口が要求ごとに付ける番号。
 * `failed` の `errorText` は Chromium の `net::ERR_*` の文言。
 */
export type NetworkEvent =
  | {
    readonly kind: 'request';
    readonly id: string;
    readonly pageId: string | null;
    readonly method: string;
    readonly url: string;
    readonly resourceType: string;
    readonly isNavigation: boolean;
    readonly isMainFrame: boolean;
    readonly redirectedFromId: string | null;
  }
  | { readonly kind: 'response'; readonly id: string; readonly status: number }
  | { readonly kind: 'finished'; readonly id: string }
  | { readonly kind: 'failed'; readonly id: string; readonly errorText: string };

export interface NetworkOperations {
  /** Context かページの通信の事象を受ける（ページを指せば、そのページの事象だけ）。 */
  onNetwork(scope: ContextHandle | PageHandle, listener: (event: NetworkEvent) => void): Unsubscribe;
}

// 組 ------------------------------------------------------------------------------------------------------------

/** 読むだけの口（発見に渡す。押す・入れるを持たない）。 */
export type ReadOnlyPagePort = PageOperations & ReadOperations & NetworkOperations;

/** ブラウザに頼む口（この段の操作の全部）。 */
export type BrowserPort = BrowserOperations & ContextOperations & ReadOnlyPagePort;
