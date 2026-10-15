// T25b（Task 25 の設計書 6 章）: ログインのフォームの fixture のサーバ（テストの補助）。
// - 127.0.0.1 だけで待ち受ける。同じサーバを、2 つの名前で、別の Origin として使う。
//   - `originA`（`http://127.0.0.1:<port>`）: 監査の対象の Origin（ログインの画面と管理画面）。
//   - `originB`（`http://localhost:<port>`）: 別の Origin（IdP の代わり、別のサイトへの送信の先）。Chromium は `localhost` を
//     ループバックに解決する（既存の `crossSiteOriginOf` と同じ）。
// - 資格情報と CSRF の値は、起動のたびに作る仮の値（ランダム）。テストは、ページの入力の欄に入れるためだけに読み、出力しない。
// - サーバに届いた要求（Origin の別、method、path と query）を、順に記録する。WebSocket の upgrade も記録して、すぐに切る。
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

/** 仮の値の長さ（バイト）。 */
const RANDOM_VALUE_BYTES = 12;
/** HTTP の status。 */
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_TEMPORARY_REDIRECT = 307;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;

/** fixture のパス。 */
export const LOGIN_FIXTURE_PATHS = Object.freeze({
  /** ログインの画面（GET）と、その送信先（POST）。 */
  login: '/login',
  /** 307 で同じ送信先へ POST をやり直させる送信先（POST）。 */
  login307: '/login-307',
  /** `login307` へ送るフォームの画面（GET）。 */
  login307Form: '/login-307-form',
  /** ログインのフォームを iframe の中に持つ画面（GET）。 */
  framedLogin: '/framed-login',
  /** ログインの後の管理画面（GET）。 */
  admin: '/admin',
  /** 管理画面の更新の送信先（POST。許していない送信先）。 */
  adminUpdate: '/admin/update',
  /** 何もしない画面（GET）。 */
  blank: '/blank',
  /** Service Worker の script（GET）。 */
  serviceWorker: '/sw.js',
  /** ページを離れるときの送信の先（POST）。 */
  beacon: '/beacon-pagehide',
  keepalive: '/keepalive-pagehide',
  /** 別の Origin の、IdP の着地の画面（GET。管理画面へ 303 で戻す）と、送信の先（POST）。 */
  idpLanding: '/idp-landing',
  collect: '/collect',
  /** WebSocket の接続の先。 */
  webSocket: '/ws',
  /** T25b round 1: 監査の段の除外を確かめる画面（GET。セッションを問わない）。除外に当たる画像・iframe・fetch の GET と、当たらないものを持つ。 */
  adminResources: '/admin/resources',
  /** ログアウト（GET。除外のパス）。 */
  adminLogout: '/admin/logout',
  /** 除外に当たらない画像と iframe と fetch の先（GET）。 */
  adminOkImage: '/admin/ok.svg',
  adminOkFrame: '/admin/ok-frame',
  adminOkJson: '/admin/ok.json',
  /** 読む範囲（`/admin`）の外の画面（GET）。 */
  publicPage: '/public/page',
} as const);

/** ログインの後に、別の Origin（IdP の代わり）へ 303 で移すことを指定する、ログインの送信先の query。 */
export const LOGIN_NEXT_IDP_QUERY = '?next=idp';

/** サーバに届いた要求の記録。`site` は、要求の Host が `originA` か `originB` か。 */
export interface LoginFixtureRequest {
  readonly site: 'A' | 'B';
  readonly method: string;
  readonly path: string;
}

export interface LoginFixtureServer {
  readonly originA: string;
  readonly originB: string;
  /** 届いた要求（届いた順）。 */
  readonly requests: readonly LoginFixtureRequest[];
  /** 正しい資格情報でログインした回数。 */
  readonly successfulLogins: number;
  /** ページの入力の欄に、正しい資格情報を入れる（値はテストに返さない）。 */
  fillCredentials(fill: (selector: string, value: string) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

const randomValue = (): string => randomBytes(RANDOM_VALUE_BYTES).toString('hex');

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendHtml(response: ServerResponse, body: string, status = STATUS_OK): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>${body}</body></html>`);
}

/** ログインの画面の本文（`action` へ POST するフォーム。CSRF の hidden を持つ）。 */
function loginFormHtml(action: string, csrf: string): string {
  return `<h1 id="login-title">LOGIN</h1><form id="login-form" method="post" action="${action}">`
    + `<input name="csrf" type="hidden" value="${csrf}"><input name="user" id="user">`
    + '<input name="pass" id="pass" type="password"><button id="go" type="submit">login</button></form>';
}

/**
 * T25b round 1: 監査の段の除外を確かめる画面の本文。除外に当たる画像（ログアウトのパス、危険な語の path、percent-encode した語、読む範囲の
 * 外）、iframe（ログアウトのパス、query の危険な語）、fetch の GET（ログアウトのパス、query の危険な語）と、当たらない画像・iframe・fetch を
 * 持つ。fetch の結果がそろったら、`documentElement` の `data-done` を `1` にする。
 */
function adminResourcesHtml(): string {
  const p = LOGIN_FIXTURE_PATHS;
  return `<a id="logout" href="${p.adminLogout}">logout</a>`
    + `<img src="${p.adminOkImage}" alt="">`
    + `<img src="${p.adminLogout}?via=img" alt="">`
    + '<img src="/admin/items/1/delete?via=img" alt="">'
    + '<img src="/admin/%72emove?via=img" alt="">'
    + `<img src="${p.publicPage}?via=img" alt="">`
    + `<iframe src="${p.adminOkFrame}"></iframe>`
    + `<iframe src="${p.adminLogout}?via=iframe"></iframe>`
    + '<iframe src="/admin/items?action=CANCEL&amp;via=iframe"></iframe>'
    + '<script>Promise.allSettled(['
    + `fetch('${p.adminLogout}?via=fetch'), fetch('/admin/items?op=destroy&via=fetch'), fetch('${p.adminOkJson}?via=fetch')`
    + ']).then((results) => { document.documentElement.dataset.fetches = results.map((r) => r.status).join(",");'
    + ' document.documentElement.dataset.done = "1"; });</script>';
}

export async function startLoginFixtureServer(): Promise<LoginFixtureServer> {
  const credentials = { user: `u${randomValue()}`, pass: `p${randomValue()}` };
  const csrf = randomValue();
  const sessions = new Set<string>();
  const requests: LoginFixtureRequest[] = [];
  const sockets = new Set<Duplex>();
  let successfulLogins = 0;
  let port = 0;
  const originA = (): string => `http://127.0.0.1:${port}`;
  const originB = (): string => `http://localhost:${port}`;
  const siteOf = (request: IncomingMessage): 'A' | 'B' => (request.headers.host?.startsWith('localhost:') === true ? 'B' : 'A');

  const hasSession = (request: IncomingMessage): boolean => {
    const sid = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('sid='))
      ?.slice('sid='.length);
    return sid !== undefined && sessions.has(sid);
  };

  /** 正しい資格情報と CSRF の値か（本文の値は記録しない）。 */
  const isValidLogin = (body: string): boolean => {
    const fields = new Map(body.split('&').map((pair) => {
      const [name = '', value = ''] = pair.split('=');
      return [decodeURIComponent(name), decodeURIComponent(value.split('+').join(' '))] as const;
    }));
    return fields.get('csrf') === csrf && fields.get('user') === credentials.user && fields.get('pass') === credentials.pass;
  };

  const handleSiteA = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const { pathname } = url;
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.login) {
      sendHtml(response, loginFormHtml(`${LOGIN_FIXTURE_PATHS.login}${url.search}`, csrf));
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.login307Form) {
      sendHtml(response, loginFormHtml(LOGIN_FIXTURE_PATHS.login307, csrf));
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.framedLogin) {
      sendHtml(response, `<iframe id="login-frame" src="${LOGIN_FIXTURE_PATHS.login}"></iframe>`);
      return;
    }
    if (request.method === 'POST' && pathname === LOGIN_FIXTURE_PATHS.login307) {
      await readBody(request);
      response.writeHead(STATUS_TEMPORARY_REDIRECT, { location: `${LOGIN_FIXTURE_PATHS.login307}?again=1` });
      response.end();
      return;
    }
    if (request.method === 'POST' && pathname === LOGIN_FIXTURE_PATHS.login) {
      if (!isValidLogin(await readBody(request))) {
        sendHtml(response, '<h1 id="login-failed">LOGIN-FAILED</h1>', STATUS_UNAUTHORIZED);
        return;
      }
      successfulLogins += 1;
      const sid = randomValue();
      sessions.add(sid);
      const next = url.search === LOGIN_NEXT_IDP_QUERY
        ? `${originB()}${LOGIN_FIXTURE_PATHS.idpLanding}`
        : LOGIN_FIXTURE_PATHS.admin;
      response.writeHead(STATUS_SEE_OTHER, {
        location: next,
        'set-cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`,
      });
      response.end();
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.admin) {
      if (!hasSession(request)) {
        response.writeHead(STATUS_SEE_OTHER, { location: LOGIN_FIXTURE_PATHS.login });
        response.end();
        return;
      }
      sendHtml(response, '<h1 id="admin-ok">ADMIN-OK</h1>'
        + `<form id="update-form" method="post" action="${LOGIN_FIXTURE_PATHS.adminUpdate}">`
        + '<input name="x" value="1"><button id="update" type="submit">save</button></form>');
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.adminResources) {
      sendHtml(response, adminResourcesHtml());
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.adminLogout) {
      response.writeHead(STATUS_SEE_OTHER, { location: LOGIN_FIXTURE_PATHS.login });
      response.end();
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.adminOkImage) {
      response.writeHead(STATUS_OK, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    if (request.method === 'GET' && (pathname === LOGIN_FIXTURE_PATHS.adminOkFrame || pathname === LOGIN_FIXTURE_PATHS.publicPage)) {
      sendHtml(response, '<p id="ok">OK</p>');
      return;
    }
    if (request.method === 'GET' && pathname.startsWith(`${LOGIN_FIXTURE_PATHS.admin}/`)) {
      response.writeHead(STATUS_OK, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      response.end('ADMIN-RESOURCE');
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.serviceWorker) {
      response.writeHead(STATUS_OK, { 'content-type': 'text/javascript' });
      response.end('self.addEventListener("fetch", () => {});');
      return;
    }
    if (request.method === 'GET' && pathname === LOGIN_FIXTURE_PATHS.blank) {
      sendHtml(response, '<p id="blank">blank</p>');
      return;
    }
    await readBody(request);
    response.writeHead(request.method === 'POST' ? STATUS_OK : STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
    response.end(request.method === 'POST' ? 'POST-RECEIVED' : '');
  };

  const handleSiteB = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (request.method === 'GET' && url.pathname === LOGIN_FIXTURE_PATHS.idpLanding) {
      response.writeHead(STATUS_SEE_OTHER, { location: `${originA()}${LOGIN_FIXTURE_PATHS.admin}` });
      response.end();
      return;
    }
    await readBody(request);
    response.writeHead(request.method === 'POST' ? STATUS_OK : STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
    response.end(request.method === 'POST' ? 'B-POST-RECEIVED' : '');
  };

  const server = createServer((request, response) => {
    const site = siteOf(request);
    const url = new URL(request.url ?? '/', site === 'A' ? originA() : originB());
    requests.push({ site, method: request.method ?? '', path: `${url.pathname}${url.search}` });
    const handled = site === 'A' ? handleSiteA(request, response, url) : handleSiteB(request, response, url);
    handled.catch(() => {
      if (!response.headersSent) response.writeHead(STATUS_NOT_FOUND);
      response.end();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const site = siteOf(request);
    const url = new URL(request.url ?? '/', site === 'A' ? originA() : originB());
    requests.push({ site, method: 'UPGRADE', path: `${url.pathname}${url.search}` });
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()));
  port = (server.address() as AddressInfo).port;

  return {
    originA: originA(),
    originB: originB(),
    requests,
    get successfulLogins() {
      return successfulLogins;
    },
    async fillCredentials(fill) {
      await fill('#user', credentials.user);
      await fill('#pass', credentials.pass);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
