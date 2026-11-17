// DEF-236（設計書 `doc/design/2026-11-09-beaksight-visible-pacing-wait-design.md` 7 章）: 読み込みの間隔の待ちを、前の画面を見せたまま行うことを確かめる
// fixture。127.0.0.1 の 2 つの Origin で待つ（INV-PACE の実験のサイトを、決まった数の要求を出す形に写したもの）。
// - アプリの Origin: `/admin/pK`（K=1..pages。互いにリンク）、`/auth`（ログインの画面）、`/app.js`、`/beacon`（POST。pagehide の sendBeacon）。
// - サービスの Origin: `POST /auth/v1/token?grant_type=refresh_token`（更新の鍵を回す。使い終えた鍵の再使用で系列を取り消す）、`GET /rest/v1/items`（Bearer）、
//   `DELETE /rest/v1/items`（届いたら記録する）、WebSocket の upgrade（`/realtime`。記録して断る）。
// - アプリのスクリプト: 読み込みの時に 1 回だけ、鍵を更新し、items を読み、WebSocket を 1 回だけ開く（繋ぎ直さない。読み込みの間の要求の数を決まった数にする）。
//   pagehide で `/beacon` へ sendBeacon する。
// - `window.__pacingWaitActivity()`: テストが、BeakSight の待ちの間に呼ぶ（画面が自然に出す通信の代わり）。鍵の更新・items の読み取り 3 回・DELETE 1 回・
//   WebSocket 1 回を出す。要求の URL に `wait=1` を付ける（サーバの記録で見分ける）。
// サーバの記録（`refreshRecords`・`requestLog`）で、届いた要求を数える。
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { READ_METHODS } from './leak-places.js';
import { startLoopbackHttpServer } from './loopback-server.js';

export interface PacingWaitSiteOptions {
  readonly pages: number;
  readonly accessLifetimeMs: number;
  /**
   * L11: 読み込みの時に、承認したサービスの Origin へ出す読み取りの数（`GET items?burst=1`。省略は 0）。全部を待ってから `#state` を `burst-done` にする。
   * 上限の撤廃（1 分あたり 600 件・1 回の Run の上限）を確かめるため。
   */
  readonly loadBurst?: number;
  /** L11: 読み込みの時に、DELETE 1 件も出す（止まることを確かめる）。 */
  readonly loadUnsafe?: boolean;
}

export interface PacingWaitRefreshRecord {
  readonly atMs: number;
  readonly reason: string | null;
  /** 送られた更新の鍵の系列の番号（0 が最初）。知らない鍵は -1。 */
  readonly tokenIndex: number;
  /** その時の今の鍵の番号。 */
  readonly activeIndex: number;
  readonly outcome: 'ROTATED' | 'REVOKED' | 'INVALID';
}

export interface PacingWaitRequestRecord {
  readonly atMs: number;
  readonly origin: 'app' | 'svc';
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** 待ちの間に出した要求（URL の `wait=1`）。 */
  readonly duringWait: boolean;
  /** L11: 読み込みの時にまとめて出した読み取り（URL の `burst=1`）。 */
  readonly burst: boolean;
  readonly kind: string;
}

export interface PacingWaitSite {
  readonly appOrigin: string;
  readonly svcOrigin: string;
  readonly refreshRecords: readonly PacingWaitRefreshRecord[];
  readonly requestLog: readonly PacingWaitRequestRecord[];
  /** 系列を取り消した時刻。取り消していなければ `null`。 */
  revokedAtMs(): number | null;
  /** 最初の session（localStorage に入れる値）を発行する。 */
  issueStoredSession(): string;
  close(): Promise<void>;
}

export const PACING_WAIT_STORAGE_KEY = 'fixture-auth-token';
export const PACING_WAIT_PATHS = Object.freeze({ pagePrefix: '/admin/p', auth: '/auth', token: '/auth/v1/token' });

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startPacingWaitSite(options: PacingWaitSiteOptions): Promise<PacingWaitSite> {
  const refreshRecords: PacingWaitRefreshRecord[] = [];
  const requestLog: PacingWaitRequestRecord[] = [];
  const tokens = new Map<string, { index: number; used: boolean }>();
  const chain: string[] = [];
  const access = new Map<string, number>();
  let revokedAt: number | null = null;
  const apiKey = `k${randomBytes(6).toString('hex')}`;
  const issue = (): Record<string, unknown> => {
    const refresh = `r${randomBytes(8).toString('hex')}`;
    tokens.set(refresh, { index: chain.length, used: false });
    chain.push(refresh);
    const token = `a${randomBytes(8).toString('hex')}`;
    const expiresAt = Date.now() + options.accessLifetimeMs;
    access.set(token, expiresAt);
    return { access_token: token, refresh_token: refresh, expires_at_ms: expiresAt };
  };
  let appOrigin = '';
  let svcOrigin = '';
  const cors = (): Record<string, string> => ({
    'access-control-allow-origin': appOrigin,
    vary: 'Origin',
    'access-control-allow-headers': 'content-type, apikey, authorization',
    'access-control-allow-methods': 'GET, POST, DELETE',
  });
  const log = (origin: 'app' | 'svc', request: IncomingMessage, url: URL, status: number, kind: string): void => {
    requestLog.push({
      atMs: Date.now(), origin, method: request.method ?? 'GET', path: url.pathname, status, duringWait: url.searchParams.get('wait') === '1',
      burst: url.searchParams.get('burst') === '1', kind,
    });
  };
  const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors() });
    response.end(JSON.stringify(value));
  };

  const svc: RequestListener = (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      if (method === 'OPTIONS') {
        log('svc', request, url, 204, 'preflight');
        response.writeHead(204, cors());
        response.end();
        return;
      }
      if (url.pathname === PACING_WAIT_PATHS.token && method === 'POST') {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const presented = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
        const entry = tokens.get(presented);
        const base = {
          atMs: Date.now(),
          reason: typeof body['reason'] === 'string' ? body['reason'] : null,
          tokenIndex: entry?.index ?? -1,
          activeIndex: chain.length - 1,
        };
        if (revokedAt !== null || entry === undefined) {
          refreshRecords.push({ ...base, outcome: 'INVALID' });
          log('svc', request, url, 400, 'refresh');
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        if (!entry.used) {
          entry.used = true;
          refreshRecords.push({ ...base, outcome: 'ROTATED' });
          log('svc', request, url, 200, 'refresh');
          json(response, 200, issue());
          return;
        }
        revokedAt = Date.now();
        access.clear();
        refreshRecords.push({ ...base, outcome: 'REVOKED' });
        log('svc', request, url, 400, 'refresh');
        json(response, 400, { error: 'invalid_grant', reused: true });
        return;
      }
      if (url.pathname === '/rest/v1/items' && method === 'DELETE') {
        log('svc', request, url, 204, 'delete');
        response.writeHead(204, cors());
        response.end();
        return;
      }
      if (url.pathname === '/rest/v1/items' && method === 'GET') {
        const expiresAt = access.get((request.headers.authorization ?? '').replace(/^Bearer /u, ''));
        if (expiresAt === undefined || expiresAt < Date.now() || revokedAt !== null) {
          log('svc', request, url, 401, 'items');
          json(response, 401, { error: 'jwt' });
          return;
        }
        log('svc', request, url, 200, 'items');
        json(response, 200, [{ id: 1, name: 'one' }]);
        return;
      }
      log('svc', request, url, 404, 'other');
      json(response, 404, {});
    })();
  };
  const onUpgrade = (request: IncomingMessage, socket: { end: (data: string) => void }): void => {
    const url = new URL(request.url ?? '/', 'http://x');
    log('svc', request, url, 403, 'websocket');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  };

  const pageHtml = (k: number): string => {
    const links = Array.from({ length: options.pages }, (_v, i) => `<li><a href="${PACING_WAIT_PATHS.pagePrefix}${String(i + 1)}">画面 ${String(i + 1)}</a></li>`).join('');
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>画面 ${String(k)}</title><link rel="icon" href="data:,">`
      + '<script src="/app.js" defer></script></head><body><main>'
      + `<h1>画面 ${String(k)}</h1><p id="state" data-state="loading">読み込み中</p><ul>${links}</ul></main></body></html>`;
  };
  const appJs = (): string => `'use strict';
const C = ${JSON.stringify({ svc: svcOrigin, key: PACING_WAIT_STORAGE_KEY, apikey: apiKey, burst: options.loadBurst ?? 0, unsafe: options.loadUnsafe === true })};
const stored = () => { const t = localStorage.getItem(C.key); return t === null ? null : JSON.parse(t); };
const show = (text, state) => { const e = document.getElementById('state'); e.textContent = text; e.dataset.state = state; };
const refresh = async (reason, q) => {
  const s = stored(); if (s === null) { location.replace('/auth'); return false; }
  let r;
  try {
    r = await fetch(C.svc + '/auth/v1/token?grant_type=refresh_token' + q, { method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey },
      body: JSON.stringify({ refresh_token: s.refresh_token, reason }) });
  } catch { return false; }
  if (r.ok) { localStorage.setItem(C.key, JSON.stringify(await r.json())); return true; }
  if (r.status >= 400 && r.status < 500) { localStorage.removeItem(C.key); location.replace('/auth'); }
  return false;
};
const read = async (q) => {
  const s = stored(); if (s === null) return;
  try {
    const r = await fetch(C.svc + '/rest/v1/items?x=1' + q, { headers: { apikey: C.apikey, authorization: 'Bearer ' + s.access_token } });
    show(r.ok ? '最新' : '読めない ' + String(r.status), r.ok ? 'loaded' : 'error-' + String(r.status));
  } catch { show('通信の誤り', 'network'); }
};
const socket = (q) => { try { new WebSocket(C.svc.replace('http', 'ws') + '/realtime?x=1' + q); } catch { /* */ } };
window.__pacingWaitActivity = async () => {
  socket('&wait=1');
  const s = stored();
  fetch(C.svc + '/rest/v1/items?id=1&wait=1', { method: 'DELETE', headers: { apikey: C.apikey, authorization: 'Bearer ' + (s === null ? '' : s.access_token) } }).catch(() => undefined);
  await refresh('wait', '&wait=1');
  await Promise.all([read('&wait=1'), read('&wait=1'), read('&wait=1')]);
  return true;
};
const burst = async () => {
  const s = stored(); if (s === null) return;
  const one = () => fetch(C.svc + '/rest/v1/items?burst=1', { headers: { apikey: C.apikey, authorization: 'Bearer ' + s.access_token } }).catch(() => undefined);
  await Promise.all(Array.from({ length: C.burst }, one));
  if (C.unsafe) {
    fetch(C.svc + '/rest/v1/items?id=1&unsafe=1', { method: 'DELETE', headers: { apikey: C.apikey, authorization: 'Bearer ' + s.access_token } }).catch(() => undefined);
  }
  show('全部読んだ', 'burst-done');
};
void (async () => { if (!(await refresh('load', ''))) return; await read(''); socket(''); if (C.burst > 0 || C.unsafe) await burst(); })();
addEventListener('pagehide', () => { navigator.sendBeacon('/beacon', 'bye'); });
`;
  const app: RequestListener = (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      const send = (status: number, type: string, body: string, kind: string): void => {
        log('app', request, url, status, kind);
        response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        response.end(body);
      };
      if (url.pathname === '/beacon') {
        await readBody(request);
        send(204, 'text/plain', '', 'beacon');
        return;
      }
      if (!READ_METHODS.has(method)) {
        send(405, 'text/plain', '', 'other');
        return;
      }
      const matched = /^\/admin\/p([0-9]+)$/u.exec(url.pathname);
      const index = matched === null ? 0 : Number(matched[1]);
      if (index >= 1 && index <= options.pages) {
        send(200, 'text/html; charset=utf-8', pageHtml(index), 'document');
        return;
      }
      if (url.pathname === PACING_WAIT_PATHS.auth) {
        send(200, 'text/html; charset=utf-8', '<!doctype html><title>ログイン</title><h1>ログイン</h1>', 'auth');
        return;
      }
      if (url.pathname === '/app.js') {
        send(200, 'text/javascript; charset=utf-8', appJs(), 'script');
        return;
      }
      if (url.pathname === '/robots.txt') {
        send(200, 'text/plain', 'User-agent: *\nAllow: /\n', 'robots');
        return;
      }
      send(404, 'text/plain', 'not found', 'other');
    })();
  };
  const appServer = await startLoopbackHttpServer(app);
  const svcServer = await startLoopbackHttpServer(svc);
  svcServer.server.on('upgrade', onUpgrade);
  appOrigin = appServer.origin;
  svcOrigin = svcServer.origin;
  return {
    appOrigin,
    svcOrigin,
    refreshRecords,
    requestLog,
    revokedAtMs: () => revokedAt,
    issueStoredSession: () => JSON.stringify(issue()),
    close: async () => {
      await Promise.all([appServer.close(), svcServer.close()]);
    },
  };
}
