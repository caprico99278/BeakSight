// DEF-193（設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 3.2・5 章）: スクリプトで token を取るログインの後に、ページのスクリプトが読み取りで
// ない要求を自動で送るサイトの fixture。127.0.0.1 の 2 つの Origin で待つ（アプリとサービス）。
// - アプリの Origin: `/auth`（ログインの画面。欄 `#email`・`#password`・`#submit`）、`/app.js`。
// - サービスの Origin: `POST /auth/v1/token?grant_type=password`（正しい資格情報なら token を返す）。ほかのどの要求にも 200 を返し、記録する。
// - ログインの画面のスクリプト: 押すと token を取り、ログインの後にサイトが自動で送る 3 種（サーバの関数の呼び出し、データの API への POST、手続きの呼び出し）を
//   2 回ずつ送る。続けて、守りが残ることを確かめる要求（資格情報を本文・query・ヘッダに含む要求、DELETE、DELETE の上書き、危険な語の path、2 回目のログインの
//   送信）と、token の更新（同じ送信先で query が違う）を送る。結果（各要求の応答の状態。届かなければ 0）を `#state` の `data-results` に置く。
// サーバの記録（`records`）で、届いた要求を数える（資格情報を含んで届いたかの印つき。値は記録しない）。
import type { IncomingMessage, RequestListener } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startLoopbackHttpServer } from './loopback-server.js';

export interface LoginPassSiteRecord {
  readonly method: string;
  /** path（query を含まない）。 */
  readonly path: string;
  readonly grantType: string | null;
  readonly preflight: boolean;
  readonly status: number;
  /** 本文・query・ヘッダのどれかに、パスワードかユーザー名が含まれていた。 */
  readonly carriesCredential: boolean;
}

export interface LoginPassSite {
  readonly appOrigin: string;
  readonly svcOrigin: string;
  readonly username: string;
  readonly password: string;
  readonly records: readonly LoginPassSiteRecord[];
  close(): Promise<void>;
}

/** ログインの後にサイトが自動で送る 3 種（各 2 回）と、守りが残ることを確かめる要求の名前（`data-results` の鍵）。 */
export const LOGIN_PASS_SITE_PATHS = Object.freeze({
  token: '/auth/v1/token',
  functionCall: '/functions/v1/sync_access',
  dataApi: '/rest/v1/login_events',
  procedure: '/rest/v1/rpc/current_tenant',
  credentialBody: '/functions/v1/log',
  credentialQuery: '/rest/v1/rpc/audit',
  credentialHeader: '/rest/v1/rpc/trace',
  dangerous: '/rest/v1/rpc/delete_member',
});
/** 自動で送る 3 種の、各の回数。 */
export const LOGIN_PASS_SITE_REPEATS = 2;

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startLoginPassSite(): Promise<LoginPassSite> {
  const username = `u${randomBytes(5).toString('hex')}@example.test`;
  const password = `P${randomBytes(8).toString('hex')}`;
  const records: LoginPassSiteRecord[] = [];
  let appOrigin = '';
  let svcOrigin = '';
  const cors = (): Record<string, string> => ({
    'access-control-allow-origin': appOrigin,
    vary: 'Origin',
    'access-control-allow-headers': 'content-type, apikey, authorization, x-debug, x-http-method-override',
    'access-control-allow-methods': 'GET, POST, DELETE, PATCH',
  });
  const svc: RequestListener = (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      const preflight = method === 'OPTIONS';
      const body = preflight ? '' : await readBody(request);
      let decodedSearch = url.search;
      try {
        decodedSearch = decodeURIComponent(url.search);
      } catch {
        // 解けない query は、そのまま比べる。
      }
      const all = decodedSearch + body + JSON.stringify(request.headers);
      const send = (status: number, value: unknown): void => {
        records.push({
          method, path: url.pathname, grantType: url.searchParams.get('grant_type'), preflight, status,
          carriesCredential: all.includes(password) || all.includes(username),
        });
        response.writeHead(status, { 'content-type': 'application/json', ...cors() });
        response.end(preflight ? '' : JSON.stringify(value));
      };
      if (preflight) {
        send(204, null);
        return;
      }
      if (url.pathname === LOGIN_PASS_SITE_PATHS.token && method === 'POST' && url.searchParams.get('grant_type') === 'password') {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(body) as Record<string, unknown>;
        } catch {
          // 形の違う本文は、資格情報の誤りとして扱う。
        }
        if (parsed['email'] === username && parsed['password'] === password) {
          send(200, { access_token: `a${randomBytes(6).toString('hex')}`, refresh_token: `r${randomBytes(6).toString('hex')}`, expires_at_ms: Date.now() + 3_600_000 });
          return;
        }
        send(400, { error: 'invalid_grant' });
        return;
      }
      if (url.pathname === LOGIN_PASS_SITE_PATHS.token && method === 'POST') {
        // token の更新（同じ送信先で query が違う）。
        send(200, { access_token: `a${randomBytes(6).toString('hex')}`, refresh_token: `r${randomBytes(6).toString('hex')}`, expires_at_ms: Date.now() + 3_600_000 });
        return;
      }
      send(200, { ok: true });
    })();
  };
  const authHtml = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ログイン</title><link rel="icon" href="data:,">'
    + '<script src="/app.js" defer></script></head><body><main><h1>ログイン</h1><form id="f"><label>メール <input id="email" name="email"></label>'
    + '<label>パスワード <input id="password" name="password" type="password"></label><button id="submit" type="submit">ログイン</button></form>'
    + '<p id="state" data-state="idle"></p></main></body></html>';
  const p = LOGIN_PASS_SITE_PATHS;
  const appJs = (): string => `'use strict';
const S = ${JSON.stringify(svcOrigin)};
const H = (s, extra) => Object.assign({ 'content-type': 'application/json', apikey: 'k1', authorization: 'Bearer ' + s.access_token }, extra || {});
const send = (url, init) => fetch(url, init).then((r) => r.status).catch(() => 0);
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = { email: document.getElementById('email').value, password: document.getElementById('password').value };
  const r = await fetch(S + '${p.token}?grant_type=password', { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'k1' }, body: JSON.stringify(body) }).catch(() => null);
  if (r === null || !r.ok) { document.getElementById('state').dataset.state = 'login-failed'; return; }
  const s = await r.json();
  localStorage.setItem('fixture-auth-token', JSON.stringify(s));
  const results = {};
  const run = async (name, url, init) => { results[name] = await send(url, init); };
  for (let i = 0; i < ${String(LOGIN_PASS_SITE_REPEATS)}; i += 1) {
    await run('function' + i, S + '${p.functionCall}', { method: 'POST', headers: H(s), body: JSON.stringify({ event: 'login' }) });
    await run('api' + i, S + '${p.dataApi}', { method: 'POST', headers: H(s), body: JSON.stringify({ kind: 'login' }) });
    await run('rpc' + i, S + '${p.procedure}', { method: 'POST', headers: H(s), body: '{}' });
  }
  await run('credBody', S + '${p.credentialBody}', { method: 'POST', headers: H(s), body: JSON.stringify({ note: body.password }) });
  await run('credQuery', S + '${p.credentialQuery}?u=' + encodeURIComponent(body.email), { method: 'POST', headers: H(s), body: '{}' });
  await run('credHeader', S + '${p.credentialHeader}', { method: 'POST', headers: H(s, { 'x-debug': body.password }), body: '{}' });
  await run('deleteMethod', S + '${p.dataApi}?id=eq.1', { method: 'DELETE', headers: H(s) });
  await run('overrideDelete', S + '${p.dataApi}', { method: 'POST', headers: H(s, { 'x-http-method-override': 'DELETE' }), body: '{}' });
  await run('dangerPath', S + '${p.dangerous}', { method: 'POST', headers: H(s), body: '{}' });
  await run('secondLogin', S + '${p.token}?grant_type=password', { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'k1' }, body: JSON.stringify(body) });
  await run('tokenRefresh', S + '${p.token}?grant_type=refresh_token', { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'k1' }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
  document.getElementById('state').dataset.results = JSON.stringify(results);
  document.getElementById('state').dataset.state = 'done';
});
`;
  const app: RequestListener = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const send = (status: number, type: string, body: string): void => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    if (url.pathname === '/auth') {
      send(200, 'text/html; charset=utf-8', authHtml);
      return;
    }
    if (url.pathname === '/app.js') {
      send(200, 'text/javascript; charset=utf-8', appJs());
      return;
    }
    send(404, 'text/plain', '');
  };
  const appServer = await startLoopbackHttpServer(app);
  const svcServer = await startLoopbackHttpServer(svc);
  appOrigin = appServer.origin;
  svcOrigin = svcServer.origin;
  return {
    appOrigin,
    svcOrigin,
    username,
    password,
    records,
    close: async () => {
      await Promise.all([appServer.close(), svcServer.close()]);
    },
  };
}
