// DEF-233（設計書 `doc/design/2026-11-09-beaksight-discovery-token-refresh-design.md` 6 章）: スクリプトがタイマーで token を更新するサイトの fixture。
// INV-233 の仮のサイトを、一般の文言で写した。127.0.0.1 の 2 つの Origin で待つ。
// - アプリの Origin: `/admin/pK`（K=1..pages。互いにリンク。各画面に「保存」のフォーム = 操作さがしの候補）、`/auth`（ログインの画面）、`/app.js`、
//   `/beacon`（GET。スクリプトの動きの記録。値は送らない）。`POST /api/items`（押した送信。届いてはいけない）、`POST /api/session/logout`（401 を受けたときの
//   サイトの後始末。危険な語で止まる）。アプリの Origin は GET と HEAD のほかを 405 で返す（届いたことはサーバの記録に残る）。
// - サービスの Origin: `POST /auth/v1/token?grant_type=refresh_token`（鍵を回す。親の鍵の再使用は今の鍵を返し、それより古い鍵は取り消す）、
//   `GET /rest/v1/items`（Bearer。期限切れは 401）。
// - スクリプト: localStorage の `fixture-auth-token` に session を持つ。`tickMs` ごとに、期限まで `marginMs` を切ったら更新する（読み込みの時には更新しない。
//   タイマーだけ）。更新が 4xx なら鍵を消して `/auth` へ移す。ネットワークの誤りなら鍵を残す。読み込みの時に items を 1 回読み、401 なら後始末の POST を送る。
// - `decoys`（任意）: 確かめの送信を `tickMs` ごとに送る（サーバは鍵を回さず 204 で返し、記録する）。どれも token の送り先への要求で、凍結の段で通しては
//   いけない形: 欄の値を本文に入れた `POST`（押下の目印を運びうる）、危険な語の query の `POST`、`DELETE`。欄に値があるときは、値を送らない beacon
//   （`draft-filled`）も送る（目印を運ぶ送信を試したことの証拠）。
// サーバの記録（`refreshRecords`・`requestLog`・`decoyRecords`）で、届いた要求を数える。
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { READ_METHODS } from './leak-places.js';
import { startLoopbackHttpServer } from './loopback-server.js';

export interface TokenRefreshSiteOptions {
  readonly pages: number;
  readonly accessLifetimeMs: number;
  readonly marginMs: number;
  readonly tickMs: number;
  readonly decoys?: boolean;
  /**
   * DEF-233 fix round 3: 本物の SDK と同じく、読み込みの時にも、期限まで `marginMs` を切っていれば更新する（凍結の前の更新。BeakSight は、凍結の前に確かめた更新の
   * 形と同じ更新だけを凍結の段で通す）。省略は、タイマーだけ。
   */
  readonly refreshOnLoad?: boolean;
  /**
   * L6/L3-1 の後（M2 を時間に頼らない形にする）: items の読み取りの何回目（1 から）で、1 回だけ、示された access token を期限切れにして 401 を返すか。期限の長さ
   * （時間）でなく、読み取りの回数で決める。省略は、期限の時間だけで決める（今のまま）。
   */
  readonly expireOnceAtItemRead?: number;
}

export interface TokenRefreshRecord {
  readonly atMs: number;
  readonly page: string | null;
  /** 送られた更新の鍵の系列の番号（0 が最初）。知らない鍵は -1。 */
  readonly tokenIndex: number;
  readonly activeIndex: number;
  readonly outcome: 'ROTATED' | 'PARENT_RETRY' | 'REUSED_OLD' | 'INVALID';
}

export interface TokenRefreshRequestRecord {
  readonly atMs: number;
  readonly origin: 'app' | 'svc';
  readonly method: string;
  /** path（beacon は query も。ほかは query を持たない）。 */
  readonly path: string;
  readonly status: number;
}

/** 届いた確かめの送信（`kind` は `draft`・`danger`・`delete`。`draft` は本文の欄の値が空でなかったか）。 */
export interface TokenRefreshDecoyRecord {
  readonly kind: string;
  readonly method: string;
  readonly draftFilled: boolean;
}

export interface TokenRefreshSite {
  readonly appOrigin: string;
  readonly svcOrigin: string;
  readonly refreshRecords: readonly TokenRefreshRecord[];
  readonly requestLog: readonly TokenRefreshRequestRecord[];
  readonly decoyRecords: readonly TokenRefreshDecoyRecord[];
  /** 最初の session（localStorage に入れる値）を発行する。ログインし直しの代わりにも使う。 */
  issueStoredSession(): string;
  /** TEST-TIME-B: 2 つのサーバの受けている途中の要求が 0 になるまで待つ（`loopback-server.ts` の `settleLateDeliveries` に渡す）。 */
  whenIdle(limitMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** アプリが session を置く localStorage の名前（BeakSight の鍵の判定は、前と後ろの部分 `fixture`・`-auth-token` で見る）。 */
export const TOKEN_REFRESH_STORAGE_KEY = 'fixture-auth-token';
export const TOKEN_REFRESH_KEY_SHAPE = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
export const TOKEN_REFRESH_PATHS = Object.freeze({
  auth: '/auth',
  token: '/auth/v1/token',
  items: '/rest/v1/items',
  pagePrefix: '/admin/p',
  pressed: '/api/items',
});

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startTokenRefreshSite(options: TokenRefreshSiteOptions): Promise<TokenRefreshSite> {
  const startedAt = Date.now();
  const rel = (): number => Date.now() - startedAt;
  const apiKey = `k${randomBytes(6).toString('hex')}`;
  const refreshRecords: TokenRefreshRecord[] = [];
  const requestLog: TokenRefreshRequestRecord[] = [];
  const decoyRecords: TokenRefreshDecoyRecord[] = [];
  const tokens = new Map<string, { readonly index: number; used: boolean }>();
  const chain: string[] = [];
  const access = new Map<string, number>();
  /** items の読み取りの回数（`expireOnceAtItemRead`）。 */
  let itemReads = 0;
  const accessFor = (refresh: string): Record<string, unknown> => {
    const token = `a${randomBytes(8).toString('hex')}`;
    const expiresAt = Date.now() + options.accessLifetimeMs;
    access.set(token, expiresAt);
    return { access_token: token, refresh_token: refresh, expires_at_ms: expiresAt };
  };
  const issue = (): Record<string, unknown> => {
    const refresh = `r${randomBytes(8).toString('hex')}`;
    tokens.set(refresh, { index: chain.length, used: false });
    chain.push(refresh);
    return accessFor(refresh);
  };
  let appOrigin = '';
  let svcOrigin = '';
  const cors = (): Record<string, string> => ({
    'access-control-allow-origin': appOrigin,
    vary: 'Origin',
    'access-control-allow-headers': 'content-type, apikey, authorization',
    'access-control-allow-methods': 'GET, POST, DELETE',
  });
  const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors() });
    response.end(JSON.stringify(value));
  };
  const svc: RequestListener = (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      const log = (status: number): void => { requestLog.push({ atMs: rel(), origin: 'svc', method, path: url.pathname, status }); };
      if (method === 'OPTIONS') {
        log(204);
        response.writeHead(204, cors());
        response.end();
        return;
      }
      const decoy = url.searchParams.get('decoy');
      if (url.pathname === TOKEN_REFRESH_PATHS.token && decoy !== null) {
        const body = await readBody(request);
        let draft = '';
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          draft = typeof parsed['draft'] === 'string' ? parsed['draft'] : '';
        } catch {
          // 本文のない確かめの送信。
        }
        decoyRecords.push({ kind: decoy, method, draftFilled: draft.length > 0 });
        log(204);
        response.writeHead(204, cors());
        response.end();
        return;
      }
      if (url.pathname === TOKEN_REFRESH_PATHS.token && method === 'POST') {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        } catch {
          // 知らない鍵として扱う。
        }
        const presented = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
        const entry = tokens.get(presented);
        const activeIndex = chain.length - 1;
        const base = { atMs: rel(), page: typeof body['page'] === 'string' ? body['page'] : null, tokenIndex: entry?.index ?? -1, activeIndex };
        if (url.searchParams.get('grant_type') !== 'refresh_token' || entry === undefined) {
          refreshRecords.push({ ...base, outcome: 'INVALID' });
          log(400);
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        if (!entry.used) {
          entry.used = true;
          refreshRecords.push({ ...base, outcome: 'ROTATED' });
          log(200);
          json(response, 200, issue());
          return;
        }
        if (entry.index === activeIndex - 1) {
          refreshRecords.push({ ...base, outcome: 'PARENT_RETRY' });
          log(200);
          json(response, 200, accessFor(chain[activeIndex] ?? ''));
          return;
        }
        refreshRecords.push({ ...base, outcome: 'REUSED_OLD' });
        log(400);
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      if (url.pathname === TOKEN_REFRESH_PATHS.items && method === 'GET') {
        const presented = (request.headers.authorization ?? '').replace(/^Bearer /u, '');
        itemReads += 1;
        // 決めた回数目の読み取りで、1 回だけ、その access token を期限切れにする（`expireOnceAtItemRead`）。
        if (options.expireOnceAtItemRead === itemReads && access.has(presented)) access.set(presented, 0);
        const expiresAt = access.get(presented);
        if (expiresAt === undefined || expiresAt < Date.now()) {
          log(401);
          json(response, 401, { error: 'jwt expired' });
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
    const links = Array.from({ length: options.pages }, (_v, i) => `<li><a href="${TOKEN_REFRESH_PATHS.pagePrefix}${String(i + 1)}">画面 ${String(i + 1)}</a></li>`).join('');
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>画面 ${String(k)}</title><link rel="icon" href="data:,">`
      + '<script src="/app.js" defer></script></head><body><main>'
      + `<h1>画面 ${String(k)}</h1><p id="state" data-state="loading">読み込み中</p>`
      + `<form id="f${String(k)}"><label>題 <input name="title${String(k)}"></label><button type="submit">保存 ${String(k)}</button></form>`
      + `<ul>${links}</ul></main></body></html>`;
  };
  const authHtml = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ログイン</title><link rel="icon" href="data:,"></head>'
    + '<body><main><h1>ログイン</h1></main></body></html>';
  const appJs = (): string => `'use strict';
const C = ${JSON.stringify({ svc: svcOrigin, key: TOKEN_REFRESH_STORAGE_KEY, apikey: apiKey, margin: options.marginMs, tick: options.tickMs, decoys: options.decoys === true, refreshOnLoad: options.refreshOnLoad === true })};
const tokenUrl = C.svc + '${TOKEN_REFRESH_PATHS.token}?grant_type=refresh_token';
const beacon = (e) => { try { const i = new Image(); i.src = '/beacon?e=' + e + '&p=' + encodeURIComponent(location.pathname); } catch {} };
const stored = () => { const t = localStorage.getItem(C.key); return t === null ? null : JSON.parse(t); };
let refreshing = null;
const refreshNow = () => {
  if (refreshing !== null) return refreshing;
  refreshing = (async () => {
    const s = stored(); if (s === null) return 'none';
    let r;
    try {
      r = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey },
        body: JSON.stringify({ refresh_token: s.refresh_token }) });
    } catch { beacon('refresh-neterr'); return 'network'; }
    if (r.ok) { localStorage.setItem(C.key, JSON.stringify(await r.json())); beacon('refresh-ok'); return 'ok'; }
    if (r.status >= 400 && r.status < 500) { localStorage.removeItem(C.key); location.replace('${TOKEN_REFRESH_PATHS.auth}'); return 'lost'; }
    return 'retry';
  })().finally(() => { refreshing = null; });
  return refreshing;
};
const sendDecoys = () => {
  const input = document.querySelector('form input');
  const draft = input === null ? '' : input.value;
  if (draft.length > 0) beacon('draft-filled');
  const headers = { 'content-type': 'application/json', apikey: C.apikey };
  void fetch(tokenUrl + '&decoy=draft', { method: 'POST', headers, body: JSON.stringify({ draft }) }).catch(() => undefined);
  void fetch(tokenUrl + '&decoy=danger&next=logout', { method: 'POST', headers, body: '{}' }).catch(() => undefined);
  void fetch(tokenUrl + '&decoy=delete', { method: 'DELETE', headers }).catch(() => undefined);
};
const tick = async () => {
  const s = stored(); if (s === null) { location.replace('${TOKEN_REFRESH_PATHS.auth}'); return; }
  if (s.expires_at_ms - Date.now() < C.margin) await refreshNow();
  if (C.decoys) sendDecoys();
};
document.querySelectorAll('form').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault();
  void fetch('${TOKEN_REFRESH_PATHS.pressed}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: f.querySelector('input').value }) }); }));
void (async () => {
  if (C.refreshOnLoad) { const s0 = stored(); if (s0 !== null && s0.expires_at_ms - Date.now() < C.margin) await refreshNow(); }
  const s = stored(); if (s === null) return;
  try {
    const r = await fetch(C.svc + '${TOKEN_REFRESH_PATHS.items}', { headers: { apikey: C.apikey, authorization: 'Bearer ' + s.access_token } });
    document.getElementById('state').dataset.state = r.ok ? 'loaded' : 'error-' + String(r.status);
    if (r.status === 401) { void fetch('/api/session/logout', { method: 'POST' }).catch(() => undefined); }
  } catch { document.getElementById('state').dataset.state = 'network'; }
})();
setInterval(() => { void tick(); }, C.tick);
`;
  const app: RequestListener = (request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    const method = request.method ?? 'GET';
    request.resume();
    const send = (status: number, type: string, body: string): void => {
      requestLog.push({ atMs: rel(), origin: 'app', method, path: url.pathname + (url.pathname === '/beacon' ? url.search : ''), status });
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
    if (url.pathname === TOKEN_REFRESH_PATHS.auth) {
      send(200, 'text/html; charset=utf-8', authHtml);
      return;
    }
    if (url.pathname === '/app.js') {
      send(200, 'text/javascript; charset=utf-8', appJs());
      return;
    }
    if (url.pathname === '/beacon') {
      send(204, 'image/gif', '');
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
    decoyRecords,
    issueStoredSession: () => JSON.stringify(issue()),
    whenIdle: async (limitMs) => {
      await Promise.all([appServer.whenIdle(limitMs), svcServer.whenIdle(limitMs)]);
    },
    close: async () => {
      await Promise.all([appServer.close(), svcServer.close()]);
    },
  };
}
