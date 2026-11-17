// DEF-233 fix round 2（SREV-233 の実験を一般の文言で写した）: 凍結の段で通すサイトの token の更新に、見せかけの送信と、押下の値を運ぶ送信を混ぜる fixture。
// `tests/helpers/token-refresh-site.ts` と同じ形のサイト（127.0.0.1 の 2 つの Origin。鍵を回す token の送り先、Bearer の items、タイマーの更新）に、次を足した。
// - `mode: 'disguise'`: 押下と、押下の後のタイマーで、token の送り先への見せかけの送信を送る（欄に値があるときだけ。どれも凍結の段の間）。
//   - `decoy` の query つき（query の名前の違い。M-2）: 任意の本文、header・base64・分割・逆順・文字の番号・本文そのもの・query で目印を運ぶもの、method の上書き、
//     PUT・DELETE、危険な語、text/plain、sendBeacon、Worker、form の送信、ほかの Origin・path、WebSocket、ポップアップ。
//   - 登録の更新と同じ query（C-1・C-2）: 鍵にない本文の名前・値、目印の値、数の値、目印を運ぶ header、押下の観察の間の本物の形の更新
//     （`grant_type` の値だけを変えて見分ける）。サーバは、これらを鍵を回さずに見せかけとして記録する。
// - `mode: 'carry'`: 押下で、ページが鍵の値に、数・真偽・押下の値の文字の番号・新しい鍵の名前（と任意で文字列）を書き足し、すぐ更新する（C-3。A2 の重ねで次の
//   画面へ渡ってはいけない）。次の画面は、渡った印を beacon で知らせる（値は送らない）。
// - `mode: 'none'`: 足さない。
// サーバの記録（`arrivals`）で数える。`kind` は、見せかけの送信の種類（`decoy` の query か、サーバが見分けた `exact-*`）。
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { READ_METHODS } from './leak-places.js';
import { startLoopbackHttpServer } from './loopback-server.js';

/**
 * - fix round 3（SREV-233 の確かめ直しの N-1〜N-3）:
 *   - `prime`: 凍結の前に、鍵に符号表を書き、読み取りの header に値を載せ、取り消しの query の値を覚えさせる。押下の後に、本文の名前と値・header・覚えさせた
 *     query・鍵の名前と値の組み替えで、押下の値を運ぶ（どれも届いてはいけない）。
 *   - `carry2`: 押下の値の符号を、鍵の配列に、更新の応答の 2 つの文字列（access と refresh）の選び方で書く（A2 で次の画面へ渡ってはいけない）。
 */
/**
 * - fix round 4（3 回目の確かめ直しの I-1）: `carry3`: 押下の後に 2 回続けて更新し、押下の値の 1 ビットで、鍵の access token に 1 回目と 2 回目のどちらの応答の値を
 *   置くかを選ぶ（A2 で次の画面へ渡ってはいけない）。1 回目の応答の access token を beacon `carry3-first-<値>` で、次の画面の access token を `nextaccess-<値>` で
 *   知らせる（テストの仮の値。比べるのに使う）。
 */
export type DisguiseSiteMode = 'disguise' | 'carry' | 'prime' | 'carry2' | 'carry3' | 'none';

export interface DisguiseSiteOptions {
  readonly pages: number;
  readonly accessLifetimeMs: number;
  readonly marginMs: number;
  readonly tickMs: number;
  readonly mode: DisguiseSiteMode;
  /** `carry` で、押下の文字列も書き足すか。 */
  readonly carryString?: boolean;
  /** 本物の SDK と同じく、読み込みの時にも、期限まで余裕がなければ更新するか（凍結の前の更新）。 */
  readonly refreshOnLoad?: boolean;
}

export interface DisguiseArrival {
  readonly origin: 'app' | 'svc';
  readonly method: string;
  readonly path: string;
  readonly query: string;
  /** 見せかけの送信の種類（なければ null）。アプリの Origin では beacon の `e`。 */
  readonly kind: string | null;
  /** 欄に値があった（押下の後）か。 */
  readonly filled: boolean;
}

export interface DisguiseSite {
  readonly appOrigin: string;
  readonly svcOrigin: string;
  readonly arrivals: readonly DisguiseArrival[];
  /** 本物の更新の結果（`ROTATED`・`PARENT_RETRY`・`REUSED_OLD`・`INVALID`）。 */
  readonly refreshes: readonly string[];
  /** 承認したサービスの Origin の items の 401 の数。 */
  readonly unauthorized: () => number;
  issueStoredSession(): string;
  /** TEST-TIME-B: 2 つのサーバの受けている途中の要求が 0 になるまで待つ（`loopback-server.ts` の `settleLateDeliveries` に渡す）。 */
  whenIdle(limitMs?: number): Promise<void>;
  close(): Promise<void>;
}

export const DISGUISE_STORAGE_KEY = 'fixture-auth-token';
export const DISGUISE_KEY_SHAPE = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
export const DISGUISE_PATHS = Object.freeze({ auth: '/auth', token: '/auth/v1/token', items: '/rest/v1/items', pagePrefix: '/admin/p', pressed: '/api/items' });
/** 押下の観察の間の、本物の形の更新を見分ける `grant_type` の値（名前は同じで、値だけが違う）。 */
const PRESS_GRANT = 'refresh_token_press';
/** fix round 3（N-2）: 凍結の前に覚えさせる、取り消しの `grant_type` の値。 */
const PRIME_GRANT = 'revoke';

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startDisguiseSite(options: DisguiseSiteOptions): Promise<DisguiseSite> {
  const apiKey = `k${randomBytes(6).toString('hex')}`;
  const arrivals: DisguiseArrival[] = [];
  const refreshes: string[] = [];
  let unauthorized = 0;
  const tokens = new Map<string, { readonly index: number; used: boolean }>();
  const chain: string[] = [];
  const access = new Map<string, number>();
  const accessFor = (refresh: string): Record<string, unknown> => {
    const token = `a${randomBytes(8).toString('hex')}`;
    const expiresAt = Date.now() + options.accessLifetimeMs;
    access.set(token, expiresAt);
    return { access_token: token, refresh_token: refresh, expires_at_ms: expiresAt, token_type: 'bearer' };
  };
  const issue = (): Record<string, unknown> => {
    const refresh = `r${randomBytes(8).toString('hex')}`;
    tokens.set(refresh, { index: chain.length, used: false });
    chain.push(refresh);
    return accessFor(refresh);
  };
  let appOrigin = '';
  let svcOrigin = '';
  /** 事前確認で求められた header の名前（`prime` の形は、名前の多い header を使う。求められたものを返す）。 */
  let allowedHeaders = 'content-type, apikey, authorization, x-draft, x-http-method-override';
  const cors = (): Record<string, string> => ({
    'access-control-allow-origin': appOrigin,
    vary: 'Origin',
    'access-control-allow-headers': allowedHeaders,
    'access-control-allow-methods': 'GET, POST, DELETE, PUT, PATCH',
  });
  const json = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors() });
    response.end(JSON.stringify(value));
  };
  /** 登録の更新と同じ query の見せかけを見分ける（本物の形は、本文が `refresh_token` の文字列 1 つで、目印の header がなく、`grant_type` が更新の値のもの）。 */
  const exactKindOf = (url: URL, request: IncomingMessage, body: string): string | null => {
    if (url.searchParams.get('grant_type') === PRESS_GRANT) return 'exact-press';
    if (typeof request.headers['x-draft'] === 'string') return 'exact-header';
    // fix round 3（N-1）: 凍結の前に覚えさせた header の名前で、押下の値を運ぶ形。
    if (typeof request.headers['x-n0'] === 'string') return 'prime-header';
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return 'exact-nonjson';
    }
    const keys = typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : [];
    // fix round 3（N-2）: 凍結の前に覚えさせた query の値（取り消し）。読み込みの時の仕込み（本文に鍵がない）は、押下の前なので数えない。
    if (url.searchParams.get('grant_type') === PRIME_GRANT) return keys.includes('refresh_token') ? 'prime-revoke' : 'prime-load';
    const presented = keys.length === 1 && keys[0] === 'refresh_token' ? (parsed as Record<string, unknown>)['refresh_token'] : undefined;
    // 発行した鍵でない値（押下の値など）は、見せかけ。
    return typeof presented === 'string' && tokens.has(presented) ? null : 'exact-body';
  };
  const svc: RequestListener = (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      const body = READ_METHODS.has(method) ? '' : await readBody(request);
      const requested = request.headers['access-control-request-headers'];
      if (typeof requested === 'string' && requested.length > 0) allowedHeaders = requested;
      if (method === 'OPTIONS') {
        response.writeHead(204, cors());
        response.end();
        return;
      }
      const decoy = url.searchParams.get('decoy');
      const exact = decoy === null && url.pathname === DISGUISE_PATHS.token && method === 'POST' ? exactKindOf(url, request, body) : null;
      const kind = decoy ?? exact;
      arrivals.push({
        origin: 'svc', method, path: url.pathname, query: url.search, kind,
        filled: url.searchParams.get('f') === '1' || (exact !== null && exact !== 'prime-load'),
      });
      if (kind !== null) {
        // 仕込みの取り消しは、本物のサーバと同じく 2xx を返す（覚えさせようとする形）。
        json(response, 200, {});
        return;
      }
      if (url.pathname === DISGUISE_PATHS.token && method === 'POST') {
        const presented = (JSON.parse(body) as Record<string, unknown>)['refresh_token'];
        const entry = typeof presented === 'string' ? tokens.get(presented) : undefined;
        const activeIndex = chain.length - 1;
        if (url.searchParams.get('grant_type') !== 'refresh_token' || entry === undefined) {
          refreshes.push('INVALID');
          json(response, 400, { error: 'invalid_grant' });
          return;
        }
        if (!entry.used) {
          entry.used = true;
          refreshes.push('ROTATED');
          json(response, 200, issue());
          return;
        }
        if (entry.index === activeIndex - 1) {
          refreshes.push('PARENT_RETRY');
          json(response, 200, accessFor(chain[activeIndex] ?? ''));
          return;
        }
        refreshes.push('REUSED_OLD');
        json(response, 400, { error: 'invalid_grant' });
        return;
      }
      if (url.pathname === DISGUISE_PATHS.items && method === 'GET') {
        const expiresAt = access.get((request.headers.authorization ?? '').replace(/^Bearer /u, ''));
        if (expiresAt === undefined || expiresAt < Date.now()) {
          unauthorized += 1;
          json(response, 401, { error: 'jwt expired' });
          return;
        }
        json(response, 200, [{ id: 1, name: 'one' }]);
        return;
      }
      json(response, 404, {});
    })();
  };
  const pageHtml = (k: number): string => {
    const links = Array.from({ length: options.pages }, (_v, i) => `<li><a href="${DISGUISE_PATHS.pagePrefix}${String(i + 1)}">画面 ${String(i + 1)}</a></li>`).join('');
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>画面 ${String(k)}</title><link rel="icon" href="data:,">`
      + '<script src="/app.js" defer></script></head><body><main>'
      + `<h1>画面 ${String(k)}</h1><p id="state" data-state="loading">読み込み中</p>`
      + `<form id="f${String(k)}"><label>題 <input name="title${String(k)}"></label><button type="submit">保存 ${String(k)}</button></form>`
      + '<iframe name="sink" style="display:none"></iframe>'
      + `<ul>${links}</ul></main></body></html>`;
  };
  const authHtml = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ログイン</title></head><body><main><h1>ログイン</h1></main></body></html>';
  const appJs = (): string => `'use strict';
const C = ${JSON.stringify({ svc: svcOrigin, app: appOrigin, key: DISGUISE_STORAGE_KEY, apikey: apiKey, margin: options.marginMs, tick: options.tickMs,
    mode: options.mode, carryStr: options.carryString === true, pressGrant: PRESS_GRANT, refreshOnLoad: options.refreshOnLoad === true })};
const tokenUrl = C.svc + '${DISGUISE_PATHS.token}?grant_type=refresh_token';
const beacon = (e) => { try { const i = new Image(); i.src = '/beacon?e=' + encodeURIComponent(e) + '&p=' + encodeURIComponent(location.pathname); } catch {} };
const stored = () => { const t = localStorage.getItem(C.key); return t === null ? null : JSON.parse(t); };
let extra = null;
let bitsOf = null;
let refreshing = null;
const refreshNow = () => {
  if (refreshing !== null) return refreshing;
  refreshing = (async () => {
    const s = stored(); if (s === null) return 'none';
    let r;
    try {
      r = await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
    } catch { beacon('refresh-neterr'); return 'network'; }
    if (r.ok) {
      const n = await r.json(); if (extra !== null) Object.assign(n, extra);
      // carry2: 鍵の配列に、押下の値の符号を、更新の応答の 2 つの文字列の選び方で書く。
      if (C.mode === 'carry2') { const old = stored(); if (old !== null && old.bits !== undefined) n.bits = bitsOf === null ? old.bits : bitsOf.map((b) => (b ? n.access_token : n.refresh_token)); }
      localStorage.setItem(C.key, JSON.stringify(n)); beacon('refresh-ok'); return 'ok';
    }
    if (r.status >= 400 && r.status < 500) { localStorage.removeItem(C.key); location.replace('${DISGUISE_PATHS.auth}'); return 'lost'; }
    return 'retry';
  })().finally(() => { refreshing = null; });
  return refreshing;
};
const draftOf = () => { const input = document.querySelector('form input'); return input === null ? '' : input.value; };
const H = { 'content-type': 'application/json', apikey: C.apikey };
const send = (kind, filled, init, extraQuery) => { void fetch(tokenUrl + '&decoy=' + kind + '&f=' + (filled ? '1' : '0') + (extraQuery || ''), init).catch(() => undefined); };
const exact = (init, url) => { void fetch(url || tokenUrl, init).catch(() => undefined); };
const sendDisguises = (draft, origin) => {
  const f = draft.length > 0;
  if (f) beacon('draft-filled-' + origin);
  const half = Math.floor(draft.length / 2);
  const s = stored();
  const current = s === null ? '' : s.refresh_token;
  send(origin + '-arb', f, { method: 'POST', headers: H, body: JSON.stringify({ op: 'wipe', all: true }) });
  send(origin + '-hdr', f, { method: 'POST', headers: { ...H, 'x-draft': draft }, body: '{}' });
  send(origin + '-b64', f, { method: 'POST', headers: H, body: JSON.stringify({ d: btoa(unescape(encodeURIComponent(draft))) }) });
  send(origin + '-split', f, { method: 'POST', headers: H, body: JSON.stringify({ a: draft.slice(0, half), b: draft.slice(half) }) });
  send(origin + '-rev', f, { method: 'POST', headers: H, body: JSON.stringify({ d: draft.split('').reverse().join('') }) });
  send(origin + '-codes', f, { method: 'POST', headers: H, body: JSON.stringify({ d: Array.from(draft).map((c) => c.charCodeAt(0)) }) });
  send(origin + '-plain', f, { method: 'POST', headers: H, body: JSON.stringify({ d: draft }) });
  send(origin + '-query', f, { method: 'POST', headers: H, body: '{}' }, '&d=' + encodeURIComponent(draft));
  send(origin + '-ovrh', f, { method: 'POST', headers: { ...H, 'x-http-method-override': 'DELETE' }, body: '{}' });
  send(origin + '-ovrf', f, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '_method=DELETE' });
  send(origin + '-put', f, { method: 'PUT', headers: H, body: '{}' });
  send(origin + '-del', f, { method: 'DELETE', headers: H });
  send(origin + '-danger', f, { method: 'POST', headers: H, body: '{}' }, '&next=delete');
  send(origin + '-textplain', f, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  try { navigator.sendBeacon(tokenUrl + '&decoy=' + origin + '-beacon&f=' + (f ? '1' : '0'), 'x'); } catch {}
  try { navigator.sendBeacon(tokenUrl + '&decoy=' + origin + '-beaconm&f=' + (f ? '1' : '0'), JSON.stringify({ d: draft })); } catch {}
  try {
    const src = 'onmessage = (e) => { fetch(e.data.u + "&decoy=' + origin + '-worker&f=" + e.data.f, { method: "POST", headers: { "content-type": "text/plain" }, body: e.data.d }).catch(() => undefined); };';
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.postMessage({ u: tokenUrl, f: f ? '1' : '0', d: draft });
  } catch { beacon('worker-failed'); }
  try {
    const form = document.createElement('form'); form.method = 'POST'; form.target = 'sink';
    form.action = tokenUrl + '&decoy=' + origin + '-form&f=' + (f ? '1' : '0');
    const i = document.createElement('input'); i.name = 'd'; i.value = draft; form.appendChild(i); document.body.appendChild(form); form.submit(); form.remove();
  } catch {}
  void fetch(C.app + '${DISGUISE_PATHS.token}?grant_type=refresh_token&decoy=' + origin + '-xorig&f=' + (f ? '1' : '0'), { method: 'POST', body: '{}' }).catch(() => undefined);
  void fetch(C.svc + '${DISGUISE_PATHS.token}/x?grant_type=refresh_token&decoy=' + origin + '-subpath&f=' + (f ? '1' : '0'), { method: 'POST', headers: H, body: '{}' }).catch(() => undefined);
  void fetch(C.svc + '${DISGUISE_PATHS.token}?grant_type=password&decoy=' + origin + '-reqq&f=' + (f ? '1' : '0'), { method: 'POST', headers: H, body: '{}' }).catch(() => undefined);
  try { const ws = new WebSocket(C.svc.replace('http', 'ws') + '${DISGUISE_PATHS.token}?decoy=' + origin + '-ws'); ws.onopen = () => ws.close(); } catch {}
  try { const p = window.open(tokenUrl + '&decoy=' + origin + '-popup&f=' + (f ? '1' : '0')); if (p) setTimeout(() => p.close(), 500); } catch {}
  // 登録の更新と同じ query（C-1・C-2）。サーバは本文と header で見せかけを見分ける。
  exact({ method: 'POST', headers: H, body: JSON.stringify({ op: 'wipe' }) });
  exact({ method: 'POST', headers: H, body: JSON.stringify({ refresh_token: draft }) });
  exact({ method: 'POST', headers: H, body: JSON.stringify({ refresh_token: current, d: draft }) });
  exact({ method: 'POST', headers: H, body: JSON.stringify({ refresh_token: current, n: Array.from(draft).map((c) => c.charCodeAt(0)) }) });
  exact({ method: 'POST', headers: H, body: JSON.stringify({ refresh_token: current, n: draft.length }) });
  exact({ method: 'POST', headers: { ...H, 'x-draft': draft }, body: JSON.stringify({ refresh_token: current }) });
  exact({ method: 'POST', headers: { 'content-type': 'text/plain', apikey: C.apikey }, body: current });
};
const tick = async () => {
  if (C.mode === 'carry3' && window.__pressed === true) return;
  const s = stored(); if (s === null) { location.replace('${DISGUISE_PATHS.auth}'); return; }
  if (s.expires_at_ms - Date.now() < C.margin) await refreshNow();
  if (C.mode === 'disguise' && draftOf().length > 0) sendDisguises(draftOf(), 'timer');
  if (C.mode === 'prime' && draftOf().length > 0) sendPrimed(draftOf());
};
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
// prime: 押下の後に、凍結の前に仕込んだものを使って、押下の値を運ぶ。
const sendPrimed = (draft) => {
  const s = stored(); if (s === null || draft.length === 0) return;
  beacon('draft-filled-prime');
  // (a) 本文: 位置の名前（a..）に押下の値の文字を値として置く（どちらも鍵の符号表の中の文字列）。
  const body = {}; Array.from(draft).forEach((c, i) => { body[ALPHA[i]] = c; });
  exact({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // (b) header: 押下の値の文字の番号を 16 進の桁にして x-nK に入れる。本文は今の鍵の値だけ。
  const h = { 'content-type': 'application/json', apikey: C.apikey };
  Array.from(draft).forEach((c, i) => { const code = c.charCodeAt(0); h['x-n' + String(2 * i)] = HEX[code >> 4]; h['x-n' + String(2 * i + 1)] = HEX[code & 15]; });
  exact({ method: 'POST', headers: h, body: JSON.stringify({ refresh_token: s.refresh_token }) });
  // (c) 覚えさせた query の値（取り消し）で、今の鍵の値だけの本文。
  exact({ method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey }, body: JSON.stringify({ refresh_token: s.refresh_token }) },
    C.svc + '${DISGUISE_PATHS.token}?grant_type=${PRIME_GRANT}');
  // (e) 鍵の名前と値の組み替え（access と refresh の入れ替え）で 1 ビットを運ぶ。
  const bit = draft.charCodeAt(draft.length - 1) & 1;
  exact({ method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey }, body: JSON.stringify({ refresh_token: bit === 1 ? s.access_token : s.refresh_token }) });
};
document.querySelectorAll('form').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault();
  const draft = f.querySelector('input').value;
  if (C.mode === 'disguise') {
    send('press-nomark', draft.length > 0, { method: 'POST', headers: H, body: JSON.stringify({ action: 'save' }) });
    send('press-mark', draft.length > 0, { method: 'POST', headers: H, body: JSON.stringify({ title: draft }) });
    // 押下の観察の間の、本物の形の更新（本文と header は本物と同じ。grant_type の値だけで見分ける）。
    const s = stored();
    if (s !== null) exact({ method: 'POST', headers: H, body: JSON.stringify({ refresh_token: s.refresh_token }) },
      C.svc + '${DISGUISE_PATHS.token}?grant_type=' + C.pressGrant);
    sendDisguises(draft, 'press');
  }
  if (C.mode === 'prime') sendPrimed(draft);
  if (C.mode === 'carry3') {
    window.__pressed = true;
    const bit = draft.charCodeAt(draft.length - 1) & 1;
    void (async () => {
      const s0 = stored(); if (s0 === null) return;
      const r1 = await (await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey }, body: JSON.stringify({ refresh_token: s0.refresh_token }) })).json();
      const r2 = await (await fetch(tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json', apikey: C.apikey }, body: JSON.stringify({ refresh_token: r1.refresh_token }) })).json();
      beacon('carry3-first-' + r1.access_token);
      const n = { ...s0, ...r2 };
      if (bit === 1) { n.access_token = r1.access_token; n.expires_at_ms = r1.expires_at_ms; }
      // 押下の値のビットが 0 でも、渡るかを確かめるため、1 回目の値を置く形を必ず試す。
      if (bit === 0) { n.access_token = r1.access_token; }
      localStorage.setItem(C.key, JSON.stringify(n));
    })().catch(() => beacon('carry3-failed'));
  }
  if (C.mode === 'carry2') {
    const tail = draft.slice(-6);
    bitsOf = Array.from(tail).flatMap((c) => Array.from({ length: 8 }, (_v, i) => (c.charCodeAt(0) >> (7 - i)) & 1));
    void refreshNow();
  }
  if (C.mode === 'carry') {
    const codes = Array.from(draft).map((c) => c.charCodeAt(0));
    extra = { extra_num: 4242, extra_bool: true, extra_codes: codes };
    if (C.carryStr) extra.extra_str = 'pressed-string';
    extra['k_' + String(Date.now())] = 7;
    const s = stored(); if (s !== null) { Object.assign(s, extra); localStorage.setItem(C.key, JSON.stringify(s)); }
    void refreshNow();
  }
  void fetch('${DISGUISE_PATHS.pressed}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: draft }) }); }));
if (C.mode === 'prime') {
  // 凍結の前: 鍵に符号表を書き、読み取りの header に値を載せ、取り消しの query の値を覚えさせる。
  const s0 = stored();
  if (s0 !== null && s0.cb === undefined) { s0.cb = Object.fromEntries(Array.from(ALPHA).map((c) => [c, c])); localStorage.setItem(C.key, JSON.stringify(s0)); }
  for (let v = 0; v < 16; v += 1) {
    const h = { apikey: C.apikey, authorization: 'Bearer ' + (s0 === null ? '' : s0.access_token) };
    for (let k = 0; k < 40; k += 1) h['x-n' + String(k)] = HEX[v];
    void fetch(C.svc + '${DISGUISE_PATHS.items}?prime=' + String(v), { headers: h }).catch(() => undefined);
  }
  exact({ method: 'POST', headers: H, body: '{}' }, C.svc + '${DISGUISE_PATHS.token}?grant_type=${PRIME_GRANT}');
}
if (C.mode === 'carry3') { const s3 = stored(); if (s3 !== null) beacon('nextaccess-' + s3.access_token); }
if (C.mode === 'carry2') {
  const s1 = stored();
  if (s1 !== null && s1.bits !== undefined && s1.bits.every((v) => v === s1.access_token || v === s1.refresh_token) && s1.bits[0] !== 'x') beacon('carried-bits');
  if (s1 !== null && s1.bits === undefined) { s1.bits = Array(48).fill('x'); localStorage.setItem(C.key, JSON.stringify(s1)); }
}
void (async () => {
  const s = stored(); if (s === null) return;
  // 本物の SDK と同じく、読み込みの時にも、期限まで余裕がなければ更新する（凍結の前の更新）。
  if (C.refreshOnLoad && s.expires_at_ms - Date.now() < C.margin) { if ((await refreshNow()) === 'lost') return; }
  if (s.extra_num !== undefined) beacon('carried-num');
  if (s.extra_bool !== undefined) beacon('carried-bool');
  if (s.extra_codes !== undefined) beacon('carried-codes');
  if (s.extra_str !== undefined) beacon('carried-str');
  if (Object.keys(s).some((k) => k.startsWith('k_'))) beacon('carried-keyname');
  try {
    const r = await fetch(C.svc + '${DISGUISE_PATHS.items}', { headers: { apikey: C.apikey, authorization: 'Bearer ' + s.access_token } });
    document.getElementById('state').dataset.state = r.ok ? 'loaded' : 'error-' + String(r.status);
  } catch { document.getElementById('state').dataset.state = 'network'; }
})();
setInterval(() => { void tick(); }, C.tick);
`;
  const app: RequestListener = (request, response) => {
    void (async (): Promise<void> => {
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      if (!READ_METHODS.has(method)) await readBody(request);
      arrivals.push({
        origin: 'app', method, path: url.pathname, query: url.search,
        kind: url.searchParams.get('decoy') ?? url.searchParams.get('e'), filled: url.searchParams.get('f') === '1',
      });
      const sendText = (status: number, type: string, text: string): void => {
        response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        response.end(text);
      };
      if (!READ_METHODS.has(method)) {
        sendText(405, 'text/plain', '');
        return;
      }
      const matched = /^\/admin\/p([0-9]+)$/u.exec(url.pathname);
      const index = matched === null ? 0 : Number(matched[1]);
      if (index >= 1 && index <= options.pages) {
        sendText(200, 'text/html; charset=utf-8', pageHtml(index));
        return;
      }
      if (url.pathname === DISGUISE_PATHS.auth) {
        sendText(200, 'text/html; charset=utf-8', authHtml);
        return;
      }
      if (url.pathname === '/app.js') {
        sendText(200, 'text/javascript; charset=utf-8', appJs());
        return;
      }
      if (url.pathname === '/beacon') {
        sendText(204, 'image/gif', '');
        return;
      }
      if (url.pathname === '/robots.txt') {
        sendText(200, 'text/plain', 'User-agent: *\nAllow: /\n');
        return;
      }
      sendText(404, 'text/plain', 'not found');
    })();
  };
  const appServer = await startLoopbackHttpServer(app);
  const svcServer = await startLoopbackHttpServer(svc);
  appOrigin = appServer.origin;
  svcOrigin = svcServer.origin;
  return {
    appOrigin,
    svcOrigin,
    arrivals,
    refreshes,
    unauthorized: () => unauthorized,
    issueStoredSession: () => JSON.stringify(issue()),
    whenIdle: async (limitMs) => {
      await Promise.all([appServer.whenIdle(limitMs), svcServer.whenIdle(limitMs)]);
    },
    close: async () => {
      await Promise.all([appServer.close(), svcServer.close()]);
    },
  };
}
