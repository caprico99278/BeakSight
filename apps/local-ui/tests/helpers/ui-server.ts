/**
 * 画面のテストのサーバの準備の補助（TEST-SLIM の U3）。画面のテストのファイルごとに書き写していた準備（一時の root → Server Function の id の一覧 →
 * headless の Chromium → 起動の部品 → token の URL → Cookie の交換）と後始末、Server Function の呼び出し（`call`・`valueOf`）を、ここに 1 つにした。
 * - 状態（一時の root、サーバ、Chromium、Cookie、id の一覧）は、`createUiServerKit` が返す値の中だけに持つ（テストのファイルごとに 1 つ作る）。
 * - `setUp` を `beforeAll` で、`tearDown` を `afterAll` で呼ぶ。サーバの起動の前に一時の root に書くもの（ターゲット設定など）は、`setUp` の
 *   `prepare` で書く（`prepare` の戻り値を `setUp` が返す）。
 * - Chromium を使わないテスト（Server Function だけを HTTP で呼ぶ）は `browser: false` にする。
 */
import type { Browser, BrowserContext } from 'playwright';
import { expect } from 'vitest';
import { launchHeadlessChromium } from '../../../../tests/helpers/chromium.js';
import {
  BUILT_SERVER_ENTRY,
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './local-server.ts';
import { callServerFunction, readServerFunctionIds, type ServerFunctionCall } from './server-functions.ts';

/** HTTP の成功の状態。 */
const STATUS_OK = 200;
/** 失敗のときに出す、応答の本文の長さの上限（文字）。 */
const FAILURE_BODY_LENGTH = 300;

/** サーバの準備の補助の設定。 */
export interface UiServerKitOptions {
  /** headless の Chromium を起動し、token の URL を開いた context を作るか（既定は作る）。 */
  readonly browser?: boolean;
}

/** サーバの準備の補助が返す関数。 */
export interface UiServerKit {
  /** 起動したサーバ（起動していなければ誤り）。 */
  readonly started: () => StartedServer;
  /** 一時の root（作っていなければ誤り）。 */
  readonly rootOf: () => TemporaryUiRoot;
  /** 今の Chromium の context（ない間は `undefined`。`createUiPageKit` の `contextOf` に渡す）。 */
  readonly contextOf: () => BrowserContext | undefined;
  /** Server Function の名前から id への表（`isServerFunctionUrlOf` に渡す）。 */
  readonly idsOf: () => ReadonlyMap<string, string>;
  /** token の URL と交換した Cookie（`name=value`）。 */
  readonly cookieOf: () => string;
  /** Server Function を、同じ origin から呼ぶ。 */
  readonly call: (name: string, method: 'GET' | 'POST', data?: unknown) => Promise<ServerFunctionCall>;
  /** Server Function を呼び、200 であることを確かめて値を返す。 */
  readonly valueOf: <T>(name: string, method: 'GET' | 'POST', data?: unknown) => Promise<T>;
  /** 準備（`beforeAll` で呼ぶ）。`prepare` は、一時の root を作った後、サーバの起動の前に呼ぶ。 */
  readonly setUp: <T = void>(prepare?: (root: TemporaryUiRoot) => T) => Promise<T>;
  /** 後始末（`afterAll` で呼ぶ）: context → Chromium → サーバ → 一時の root。 */
  readonly tearDown: () => Promise<void>;
}

/** 画面のテストのサーバの準備の補助を作る（テストのファイルごとに 1 つ）。 */
export const createUiServerKit = (options: UiServerKitOptions = {}): UiServerKit => {
  let root: TemporaryUiRoot | undefined;
  let server: StartedServer | undefined;
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let cookie = '';
  let ids: ReadonlyMap<string, string> = new Map();

  const started = (): StartedServer => {
    if (server === undefined) {
      throw new Error('サーバが起動していない');
    }
    return server;
  };
  const rootOf = (): TemporaryUiRoot => {
    if (root === undefined) {
      throw new Error('一時の root がない');
    }
    return root;
  };
  const call = (name: string, method: 'GET' | 'POST', data?: unknown): Promise<ServerFunctionCall> =>
    callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);
  const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
    const result = await call(name, method, data);
    expect(result.response.status, `${name} ${result.response.body.slice(0, FAILURE_BODY_LENGTH)}`).toBe(STATUS_OK);
    return result.value as T;
  };

  const setUp = async <T = void>(prepare?: (created: TemporaryUiRoot) => T): Promise<T> => {
    const created = createTemporaryUiRoot('built');
    root = created;
    const prepared = prepare?.(created) as T;
    ids = readServerFunctionIds(BUILT_SERVER_ENTRY);
    if (options.browser !== false) {
      browser = await launchHeadlessChromium();
    }
    server = await startLauncher(created, await findFreePort());
    if (browser !== undefined) {
      context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(server.tokenUrl.href, { waitUntil: 'networkidle' });
      await page.close();
    }
    const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
    cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
    return prepared;
  };

  const tearDown = async (): Promise<void> => {
    await context?.close();
    await browser?.close();
    await stopServer(server);
    root?.remove();
  };

  return {
    started,
    rootOf,
    contextOf: () => context,
    idsOf: () => ids,
    cookieOf: () => cookie,
    call,
    valueOf,
    setUp,
    tearDown,
  };
};

/**
 * SLIM-GROUP の UI-2〜UI-5（束）: 1 つのサーバを、束のファイルの describe ごとに分けて使う形にする。束のファイルは、上の `createUiServerKit` の
 * `setUp`・`tearDown` を一番外の `beforeAll`・`afterAll` で 1 回だけ呼ぶ。describe ごとの `setUp(prepare)` は、起動した後の同じ一時の root に
 * `prepare` を書くだけ（起動の前に書くもの（ターゲット設定・偽のワーカーの入口）は、どれもジョブやプロファイルの作成のときに読むので、起動の後でよい）。
 * describe ごとの `tearDown` は何もしない（後始末は外の 1 回）。
 */
export const sharedUiServerKitOf = (kit: UiServerKit): UiServerKit => ({
  ...kit,
  setUp: <T = void>(prepare?: (root: TemporaryUiRoot) => T): Promise<T> => Promise.resolve(prepare?.(kit.rootOf()) as T),
  tearDown: (): Promise<void> => Promise.resolve(),
});
