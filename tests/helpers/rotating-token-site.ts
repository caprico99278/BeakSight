// DEF-191（設計書 `doc/design/2026-11-04-beaksight-login-session-design.md` 5 章）: 更新の鍵（refresh token）を回すサービスと、SDK に似た自動の更新をする
// アプリの fixture。127.0.0.1 の 2 つの Origin で待つ。
// - アプリの Origin: `/admin/pK`（K=1..pages。互いにリンク）、`/auth`（ログインの画面）、`/app.js`。
// - サービスの Origin: `POST /auth/v1/token?grant_type=refresh_token`（鍵を回す）、`GET /rest/v1/items`（Bearer）。
// - アプリのスクリプト: localStorage の `fixture-auth-token` に session を持つ。読み込みの時と、`tickMs` ごとに、期限まで余裕（`marginMs`・`tickMarginMs`）を
//   切ったら更新する。更新が 4xx なら鍵を消して `/auth` へ移す（セッションの切れ）。ネットワークの誤りなら鍵を残す（SDK と同じ）。
// - 使い終えた鍵の再使用の扱い（`mode`）:
//   - `strict`: すぐ取り消す（系列ごと無効にする）。
//   - `lenient`: 今の鍵の親（1 つ前）の再使用は、今の鍵の access token を返す（親の鍵の再使用を許す）。それより古い鍵の再使用は取り消す。
// サーバの記録（`refreshRecords`・`requestLog`）で、届いた要求を数える。
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { READ_METHODS } from './leak-places.js';
import { startLoopbackHttpServer } from './loopback-server.js';

export type RotatingTokenReuseMode = 'strict' | 'lenient';

export interface RotatingTokenSiteOptions {
  readonly pages: number;
  readonly accessLifetimeMs: number;
  /** 読み込みの時に更新する、期限までの残り。 */
  readonly marginMs: number;
  /** 一定の間隔の確かめで更新する、期限までの残り（省略は `marginMs`）。 */
  readonly tickMarginMs?: number;
  readonly tickMs: number;
  readonly mode: RotatingTokenReuseMode;
}

export interface RotatingTokenRefreshRecord {
  readonly atMs: number;
  readonly vw: number | null;
  readonly page: string | null;
  readonly reason: string | null;
  /** 送られた更新の鍵の系列の番号（0 が最初）。知らない鍵は -1。 */
  readonly tokenIndex: number;
  /** その時の今の鍵の番号。 */
  readonly activeIndex: number;
  readonly outcome: 'ROTATED' | 'PARENT_RETRY' | 'REVOKED' | 'INVALID';
}

export interface RotatingTokenRequestRecord {
  readonly atMs: number;
  readonly origin: 'app' | 'svc';
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

export interface RotatingTokenSite {
  readonly appOrigin: string;
  readonly svcOrigin: string;
  readonly refreshRecords: readonly RotatingTokenRefreshRecord[];
  readonly requestLog: readonly RotatingTokenRequestRecord[];
  /** 系列を取り消した時刻（始めてからの ms）。取り消していなければ `null`。 */
  readonly revokedAtMs: number | null;
  /** 最初の session（localStorage に入れる値）を発行する。 */
  issueStoredSession(): string;
  /** TEST-TIME-B: 2 つのサーバの受けている途中の要求が 0 になるまで待つ（`loopback-server.ts` の `settleLateDeliveries` に渡す）。 */
  whenIdle(limitMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** アプリが session を置く localStorage の名前（BeakSight の鍵の判定は、前と後ろの部分 `fixture`・`-auth-token` で見る）。 */
export const ROTATING_TOKEN_STORAGE_KEY = 'fixture-auth-token';
export const ROTATING_TOKEN_PATHS = Object.freeze({
  auth: '/auth',
  token: '/auth/v1/token',
  items: '/rest/v1/items',
  pagePrefix: '/admin/p',
});

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

interface TokenEntry { readonly index: number; usedAtMs: number | null }
interface IssuedSession { readonly access_token: string; readonly refresh_token: string; readonly expires_at_ms: number; readonly expires_in: number }

export async function startRotatingTokenSite(options: RotatingTokenSiteOptions): Promise<RotatingTokenSite> {
  const startedAt = Date.now();
  const rel = (): number => Date.now() - startedAt;
  const apiKey = `k${randomBytes(6).toString('hex')}`;
  const refreshRecords: RotatingTokenRefreshRecord[] = [];
  const requestLog: RotatingTokenRequestRecord[] = [];
  const tokens = new Map<string, TokenEntry>();
  const chain: string[] = [];
  const access = new Map<string, number>();
  let revoked = false;
  let revokedAtMs: number | null = null;

  const accessFor = (refresh: string): IssuedSession => {
    const token = `a${randomBytes(8).toString('hex')}`;
    const expiresAt = Date.now() + options.accessLifetimeMs;
    access.set(token, expiresAt);
    return { access_token: token, refresh_token: refresh, expires_at_ms: expiresAt, expires_in: Math.floor(options.accessLifetimeMs / 1000) };
  };
  const issue = (): IssuedSession => {
    const refresh = `r${randomBytes(8).toString('hex')}`;
    tokens.set(refresh, { index: chain.length, usedAtMs: null });
    chain.push(refresh);
    return accessFor(refresh);
  };

  let appOrigin = '';
  let svcOrigin = '';
  const cors = (): Record<string, string> => ({
    'access-control-allow-origin': appOrigin,
    vary: 'Origin',
    'access-control-allow-headers': 'content-type, apikey, authorization',
    'access-control-allow-methods': 'GET, POST',
  });
  const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors() });
    response.end(JSON.stringify(value));
  };

  const svc: RequestListener = (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      const log = (status: number): void => {
        requestLog.push({ atMs: rel(), origin: 'svc', method, path: url.pathname + url.search, status });
      };
      if (method === 'OPTIONS') {
        log(204);
        response.writeHead(204, cors());
        response.end();
        return;
      }
      if (url.pathname === ROTATING_TOKEN_PATHS.token && method === 'POST') {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch {
          // 形の違う本文は、知らない鍵として扱う。
        }
        if (url.searchParams.get('grant_type') !== 'refresh_token') {
          log(400);
          json(response, 400, { error: 'unsupported_grant_type' });
          return;
        }
        const presented = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
        const entry = tokens.get(presented);
        const activeIndex = chain.length - 1;
        const base = {
          atMs: rel(),
          vw: typeof body['vw'] === 'number' ? body['vw'] : null,
          page: typeof body['page'] === 'string' ? body['page'] : null,
          reason: typeof body['reason'] === 'string' ? body['reason'] : null,
          tokenIndex: entry?.index ?? -1,
          activeIndex,
        };
        if (revoked || entry === undefined) {
          refreshRecords.push({ ...base, outcome: 'INVALID' });
          log(400);
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        if (entry.usedAtMs === null) {
          entry.usedAtMs = Date.now();
          refreshRecords.push({ ...base, outcome: 'ROTATED' });
          log(200);
          json(response, 200, issue());
          return;
        }
        if (options.mode === 'lenient' && entry.index === activeIndex - 1) {
          refreshRecords.push({ ...base, outcome: 'PARENT_RETRY' });
          log(200);
          json(response, 200, accessFor(chain[activeIndex] ?? ''));
          return;
        }
        revoked = true;
        revokedAtMs = rel();
        access.clear();
        refreshRecords.push({ ...base, outcome: 'REVOKED' });
        log(400);
        json(response, 400, { error: 'invalid_grant', reused: true });
        return;
      }
      if (url.pathname === ROTATING_TOKEN_PATHS.items && method === 'GET') {
        const expiresAt = access.get((request.headers.authorization ?? '').replace(/^Bearer /u, ''));
        if (expiresAt === undefined || expiresAt < Date.now() || revoked) {
          log(401);
          json(response, 401, { error: 'jwt' });
          return;
        }
        log(200);
        json(response, 200, [{ id: 1, name: 'one' }]);
        return;
      }
      log(404);
      json(response, 404, {});
    })();
  };

  const pageHtml = (k: number): string => {
    const links = Array.from({ length: options.pages }, (_v, i) => `<li><a href="${ROTATING_TOKEN_PATHS.pagePrefix}${String(i + 1)}">画面 ${String(i + 1)}</a></li>`).join('');
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>画面 ${String(k)}</title><link rel="icon" href="data:,">`
      + '<script src="/app.js" defer></script></head><body><main>'
      + `<h1>画面 ${String(k)}</h1><p id="state" data-state="loading">読み込み中</p><ul>${links}</ul></main></body></html>`;
  };
  const authHtml = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ログイン</title><link rel="icon" href="data:,"></head>'
    + '<body><main><h1>ログイン</h1><form><label>メール <input name="email"></label><button type="button">ログイン</button></form></main></body></html>';
  const appJs = (): string => `'use strict';
const C = ${JSON.stringify({ svc: svcOrigin, key: ROTATING_TOKEN_STORAGE_KEY, apikey: apiKey, margin: options.marginMs, tickMargin: options.tickMarginMs ?? options.marginMs, tick: options.tickMs })};
const stored = () => { const t = localStorage.getItem(C.key); return t === null ? null : JSON.parse(t); };
let refreshing = null;
const lost = () => { localStorage.removeItem(C.key); location.replace('${ROTATING_TOKEN_PATHS.auth}'); };
const refreshNow = (reason) => {
  if (refreshing !== null) return refreshing;
  refreshing = (async () => {
    const s = stored(); if (s === null) return 'none';
    let r;
    try {
      r = await fetch(C.svc + '${ROTATING_TOKEN_PATHS.token}?grant_type=refresh_token', { method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey },
        body: JSON.stringify({ refresh_token: s.refresh_token, vw: innerWidth, page: location.pathname, reason }) });
    } catch { return 'network'; }
    if (r.ok) { localStorage.setItem(C.key, JSON.stringify(await r.json())); return 'ok'; }
    if (r.status >= 400 && r.status < 500) { lost(); return 'lost'; }
    return 'retry';
  })().finally(() => { refreshing = null; });
  return refreshing;
};
const tick = async (reason) => {
  const s = stored(); if (s === null) { location.replace('${ROTATING_TOKEN_PATHS.auth}'); return false; }
  const m = reason === 'load' ? C.margin : C.tickMargin;
  if (s.expires_at_ms - Date.now() < m) { const o = await refreshNow(reason); return o !== 'lost'; }
  return true;
};
void (async () => {
  if (!(await tick('load'))) return;
  const s = stored(); if (s === null) return;
  try {
    const r = await fetch(C.svc + '${ROTATING_TOKEN_PATHS.items}', { headers: { apikey: C.apikey, authorization: 'Bearer ' + s.access_token } });
    document.getElementById('state').dataset.state = r.ok ? 'loaded' : 'error-' + String(r.status);
  } catch { document.getElementById('state').dataset.state = 'network'; }
})();
void tick('tick0');
setInterval(() => { void tick('tick'); }, C.tick);
`;

  const app: RequestListener = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const method = request.method ?? 'GET';
    const send = (status: number, type: string, body: string): void => {
      requestLog.push({ atMs: rel(), origin: 'app', method, path: url.pathname, status });
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    if (!READ_METHODS.has(method)) {
      send(405, 'text/plain', '');
      return;
    }
    const matched = /^\/admin\/p([0-9]+)$/u.exec(url.pathname);
    const index = matched === null ? 0 : Number(matched[1]);
    if (index >= 1 && index <= options.pages) {
      send(200, 'text/html; charset=utf-8', pageHtml(index));
      return;
    }
    if (url.pathname === ROTATING_TOKEN_PATHS.auth) {
      send(200, 'text/html; charset=utf-8', authHtml);
      return;
    }
    if (url.pathname === '/app.js') {
      send(200, 'text/javascript; charset=utf-8', appJs());
      return;
    }
    if (url.pathname === '/robots.txt') {
      send(200, 'text/plain', 'User-agent: *\nAllow: /\n');
      return;
    }
    send(404, 'text/plain', 'not found');
  };

  const appServer = await startLoopbackHttpServer(app);
  const svcServer = await startLoopbackHttpServer(svc);
  appOrigin = appServer.origin;
  svcOrigin = svcServer.origin;
  return {
    appOrigin,
    svcOrigin,
    refreshRecords,
    requestLog,
    get revokedAtMs() {
      return revokedAtMs;
    },
    issueStoredSession: () => JSON.stringify(issue()),
    whenIdle: async (limitMs) => {
      await Promise.all([appServer.whenIdle(limitMs), svcServer.whenIdle(limitMs)]);
    },
    close: async () => {
      await Promise.all([appServer.close(), svcServer.close()]);
    },
  };
}
