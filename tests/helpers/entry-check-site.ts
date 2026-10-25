// T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブの結合テストの fixture のサーバ（テストの補助）。
// - 127.0.0.1 だけで待ち受ける。同じサーバを、2 つの名前で、別の Origin として使う（`originA`（127.0.0.1）が許可 Origin、`originB`（`localhost`）が
//   許可 Origin の外。Chromium は `localhost` をループバックに解決する。`automated-login-fixture.ts` と同じ）。
// - サーバに届いた要求を、すべて順に記録する（Origin の別、method、path と query、届いた時刻）。
// - 画面（originA）:
//   - `/prefilled`: form（POST、action は `/session`）の中に、値の目印を入れたユーザー名・パスワード・hidden の欄と送信のボタン。form の外の見出しに、
//     検索の欄（form の外の text の欄。パスワードの欄と同じ form の中だけで探すことを確かめる）。
//   - `/two-passwords`: パスワードの欄が 2 つ（新しい登録の画面の形）。パスワードの欄の候補が 2 つなので、どの欄の案も一意にならない。
//   - `/redirect-out`: 302 で許可 Origin の外（originB の `/sso/login`）へ移す。
//   - `/script-out`: 読み込んだ後に、ページの JS が許可 Origin の外（originB の `/sso/login`）へ移ろうとする。
//   - `/invite/<値に見える区切り>/login`: 値に見える区切りを含む path のログインの画面（form の送信）。
// - originB の `/sso/login` は、外部の認証のサービスの代わり（届いてはいけない）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startLoopbackHttpServer } from './loopback-server.js';

const STATUS_OK = 200;
const STATUS_FOUND = 302;
const STATUS_NOT_FOUND = 404;

/** fixture のパス。 */
export const ENTRY_CHECK_SITE_PATHS = Object.freeze({
  prefilled: '/prefilled',
  twoPasswords: '/two-passwords',
  redirectOut: '/redirect-out',
  scriptOut: '/script-out',
  valueLikeLogin: '/invite/0123456789abcdef0123456789abcdef/login',
  session: '/session',
  sso: '/sso/login',
} as const);

/** 欄の値の目印（成果物・管理データ・IPC に出てはいけない）。 */
export const ENTRY_CHECK_VALUE_MARKERS = Object.freeze({
  username: 'entry-user-marker-7f3a',
  password: 'entry-pass-marker-9c1e',
  hidden: 'entry-hidden-marker-2b8d',
  search: 'entry-search-marker-5e6f',
} as const);

/** サーバに届いた要求の記録。 */
export interface EntryCheckSiteRequest {
  readonly site: 'A' | 'B';
  readonly method: string;
  /** path と query。 */
  readonly path: string;
  readonly atMs: number;
}

export interface EntryCheckSite {
  readonly originA: string;
  readonly originB: string;
  readonly requests: readonly EntryCheckSiteRequest[];
  close(): Promise<void>;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const m = ENTRY_CHECK_VALUE_MARKERS;
const PREFILLED_PAGE = page('ログイン', '<header><input id="site-search" name="q" type="search" value="' + m.search + '">'
  + '<input id="site-keyword" name="keyword" type="text" value="' + m.search + '"></header>'
  + `<form id="login-form" method="post" action="${ENTRY_CHECK_SITE_PATHS.session}">`
  + `<input type="hidden" name="csrf" value="${m.hidden}">`
  + `<label>ID <input id="login-id" name="login[id]" type="text" value="${m.username}"></label>`
  + `<label>パスワード <input id="login-password" name="login[password]" type="password" value="${m.password}"></label>`
  + '<button id="login-submit" type="submit">ログイン</button></form>');
const TWO_PASSWORDS_PAGE = page('登録', '<form id="signup" method="post" action="/signup">'
  + '<input id="mail" name="mail" type="email"><input id="pw1" name="pw1" type="password"><input id="pw2" name="pw2" type="password">'
  + '<button id="signup-submit" type="submit">登録</button></form>');
const VALUE_LIKE_LOGIN_PAGE = page('ログイン', `<form method="post" action="${ENTRY_CHECK_SITE_PATHS.session}">`
  + '<input id="u" name="u" type="email"><input id="p" name="p" type="password"><button id="s" type="submit">ログイン</button></form>');
const SSO_PAGE = page('SSO', '<form method="post" action="/sso/session"><input name="u"><input name="p" type="password"><button>login</button></form>');

export async function startEntryCheckSite(): Promise<EntryCheckSite> {
  const requests: EntryCheckSiteRequest[] = [];
  let port = 0;
  const originA = (): string => `http://127.0.0.1:${port}`;
  const originB = (): string => `http://localhost:${port}`;
  const siteOf = (request: IncomingMessage): 'A' | 'B' => (request.headers.host?.startsWith('localhost:') === true ? 'B' : 'A');
  const html = (response: ServerResponse, body: string): void => {
    response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(body);
  };
  const server = await startLoopbackHttpServer((request, response) => {
    const site = siteOf(request);
    const path = request.url ?? '/';
    requests.push({ site, method: request.method ?? '', path, atMs: Date.now() });
    request.resume();
    const pathname = new URL(path, originA()).pathname;
    const p = ENTRY_CHECK_SITE_PATHS;
    if (site === 'B') {
      if (pathname === p.sso) {
        html(response, SSO_PAGE);
        return;
      }
    } else {
      switch (pathname) {
        case p.prefilled:
          html(response, PREFILLED_PAGE);
          return;
        case p.twoPasswords:
          html(response, TWO_PASSWORDS_PAGE);
          return;
        case p.valueLikeLogin:
          html(response, VALUE_LIKE_LOGIN_PAGE);
          return;
        case p.redirectOut:
          response.writeHead(STATUS_FOUND, { location: `${originB()}${p.sso}?client=entry`, 'cache-control': 'no-store' });
          response.end();
          return;
        case p.scriptOut:
          html(response, page('移動', `<p id="moving">移動しています</p><script>setTimeout(() => { location.href = "${originB()}${p.sso}"; }, 50);</script>`));
          return;
        default:
          break;
      }
    }
    response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  port = server.port;
  return {
    originA: originA(),
    originB: originB(),
    requests,
    close: () => server.close(),
  };
}
