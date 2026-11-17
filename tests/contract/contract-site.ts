/**
 * ずれの確かめ（RB-3。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 2・3.3）の、ループバックの fixture のサーバ 1 つと、
 * 同じサイトを偽の口（`tests/helpers/fake-browser-port/`）に書いた台本。
 * - サーバは、確かめたい操作に 1 ページで届く最小のページだけを返す（2 章 7）。受けた要求は `<method> <path>` の行で残す（通り道の代表が、届いて
 *   いないことを確かめるため）。
 * - 台本（`fakeSiteOf`）は、本物の Chromium がこのサーバで返す答えの記録。ずれの確かめが落ちたら、本物の答えを見て、偽の口か台本を直す。
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { NamedElementReader, NamedPageReader } from '../../src/browser/port/browser-port.js';
import type { AuthenticatedStorageState } from '../../src/core/authenticated-storage-state.js';
import type { FakeSite } from '../helpers/fake-browser-port/fake-browser-port.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';

/** fixture のページの path。 */
export const CONTRACT_PATHS = Object.freeze({
  top: '/',
  redirect: '/redirect',
  robots: '/robots.txt',
  missing: '/missing.txt',
  hang: '/hang',
  frames: '/frames',
  child: '/child',
  forged: '/forged',
  events: '/events',
  network: '/network',
  data: '/api/data',
} as const);

const TOP_TITLE = 'Contract';
const GREETING = 'Hello';
const ITEMS = Object.freeze(['one', 'two']);
const ROBOTS_BODY = 'User-agent: *\nDisallow:';
const FORGED_TITLE = 'forged';
/** `events` のページが出す console の文言と、投げる例外の文言。 */
export const CONTRACT_CONSOLE_TEXT = 'contract-console';
export const CONTRACT_PAGE_ERROR = 'contract-error';

const html = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const TOP_HTML = html(TOP_TITLE, `<h1 id="greeting">${GREETING}</h1>${ITEMS.map((item) => `<p class="item">${item}</p>`).join('')}`);
/** ページの JS が `document.title` を偽る（隔離の world の読みは偽られない）。 */
const FORGED_HTML = html(TOP_TITLE, `<h1 id="greeting">${GREETING}</h1><script>
Object.defineProperty(Document.prototype, 'title', { get: () => '${FORGED_TITLE}' });
</script>`);
const FRAMES_HTML = html(TOP_TITLE, `<iframe src="${CONTRACT_PATHS.child}"></iframe>`);
const EVENTS_HTML = html(TOP_TITLE, `<script>
console.error('${CONTRACT_CONSOLE_TEXT}');
setTimeout(() => { throw new Error('${CONTRACT_PAGE_ERROR}'); }, 0);
</script>`);

/**
 * `network` のページは、読み込みの中で、届く fetch と繋がらない fetch を 1 つずつ順に出す。届く fetch は本文を読む（読まないと、Chromium は要求の
 * 終わり `finished` を出さない）。
 */
const networkHtml = (unreachableUrl: string): string => html(TOP_TITLE, `<script>
fetch('${CONTRACT_PATHS.data}').then((response) => response.text()).catch(() => undefined);
fetch('${unreachableUrl}', { mode: 'no-cors' }).catch(() => undefined);
</script>`);

// 通り道の代表（`pass-through-paths.test.ts`。RB-4b）のページ ----------------------------------------------------------------

/** 届いたかを数える宛先の path の始まり（204 で返す）。 */
export const PASS_THROUGH_HIT_PREFIX = '/pt/hit/';
/** 通り道の代表の WebSocket の path（Upgrade を受けたら記録して切る）。 */
export const PASS_THROUGH_SOCKET_PATH = '/pt/socket';
/** SD-2: `sends` のページが開く、危険な語（`delete`）を path に持つ WebSocket の path（Upgrade を受けたら記録して切る）。 */
export const PASS_THROUGH_DANGEROUS_SOCKET_PATH = '/pt/socket-delete';
/** RB-4 fix: Dedicated Worker の中の WebSocket の path（`frozenWorker` のページ）。 */
export const PASS_THROUGH_WORKER_SOCKET_PATH = '/pt/worker-socket';
/**
 * DEF-276-relay: 握手を受けて、届いた text の frame を `echo:` を付けて返す WebSocket の path（中継の代表）。Upgrade の行のほかに、握手の Origin と Cookie
 * （`UPGRADE-HEADERS <origin> <cookie>`）と、届いた frame（`FRAME <text>`）を記録する。
 */
export const PASS_THROUGH_RELAY_SOCKET_PATH = '/pt/relay-socket';
const hit = (name: string): string => `${PASS_THROUGH_HIT_PREFIX}${name}`;

/**
 * 通り道の代表のページ。`page` は読み込みで送信を出す。`frozen` は、関数 `afterFreeze` で、凍結の後の送信（移動・ポップアップ・POST・WebSocket）を出す。
 * `credential` は、関数 `sendCredential(value)` で、値を本文に入れた POST を出す。
 */
export const PASS_THROUGH_PAGES = Object.freeze({
  /**
   * SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1・2.4）と守り 7: ページ自身の送信（fetch の削除、ヘッダと本文の削除の上書き、普通の
   * POST、削除の語とログアウトの語の path への POST、beacon の本文の削除、Dedicated Worker の削除、危険な語の path の WebSocket）。最初の読み込みで 1 回だけ自分で
   * 読み込み直し、`pagehide` で後始末の DELETE を出す（読み込み直しの途中は `reloadDelete`、閉じる時は `closeDelete`）。
   */
  sends: '/pt/sends',
  /** SD-2: ページの script の form の本文の `_method=DELETE`。 */
  formDelete: '/pt/form-delete',
  /** 利用者に見える変わり目: ページの script の普通の form の POST。 */
  formPost: '/pt/form-post',
  frozen: '/pt/frozen',
  /** 守り 2（RB-4 fix）: Worker が読み込みで WebSocket を開き、関数 `afterFreeze` で Worker の新しい WebSocket と、凍結の読み取りの GET（画像）を出す。 */
  frozenWorker: '/pt/frozen-worker',
  credential: '/pt/credential',
  /**
   * DEF-276-relay: Cookie を置き、関数 `openRelay(url)` で WebSocket を開いて `hello` を送り、返った文を返す（開けなければ `close`）。開いた接続は `window.relay`
   * に残し、関数 `sendRelay(text)` で送る。
   */
  relay: '/pt/relay',
  /** DEF-276-relay（REV-DEF276 の I-1）: `relay` と同じ関数に、別の Origin（`localhost`）の iframe を足したページ。 */
  relayFramed: '/pt/relay-framed',
  /** RB-14b（守り 1）: サーバの 3xx を 2 回たどって、削除の語の path（`redirectDelete`）へ移る入口（どの hop の path にも危険な語を入れない）。 */
  redirectHops: '/pt/redirect-hop-1',
  /** RB-14b（守り 2）: 3xx の応答を `SLOW_REDIRECT_MS` 遅らせて返し、続き（`frozenRedirect`）へ移す入口（応答の前に凍結する）。 */
  slowRedirect: '/pt/slow-redirect',
  /**
   * REV-RB14 の I-1: 別の許可 Origin（`localhost` の名前の同じサーバ。`crossOriginOf`）へ、事前確認の要る PUT（`corsReject`）を出す。サーバは、その事前確認に
   * CORS のヘッダのない 204 を返す（拒む）。
   */
  cors: '/pt/cors',
  /**
   * SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4 の「main frame の文書の移動」）: ページの script が、読み込みで main frame を
   * `?to=` の行き先（`PASS_THROUGH_MOVE_TARGETS` の名前）へ移す入口と、サーバの 3xx で同じ行き先へ移す入口。
   */
  scriptMove: '/pt/script-move',
  redirectMove: '/pt/redirect-move',
} as const);

/** SD-2: main frame の移る先（削除の語の path、読まないパス、許可 Origin の外）。値は path（外は `crossOriginOf` の Origin に付ける）。 */
export const PASS_THROUGH_MOVE_TARGETS = Object.freeze({
  deleteWord: '/pt/hit/delete-page',
  excluded: '/pt/hit/private/page',
  external: '/pt/hit/external-page',
} as const);
export type PassThroughMoveTarget = keyof typeof PASS_THROUGH_MOVE_TARGETS;
/** SD-2: 移る先の URL（外は別の Origin）。 */
export const moveTargetUrlOf = (origin: string, target: PassThroughMoveTarget): string =>
  `${target === 'external' ? crossOriginOf(origin) : origin}${PASS_THROUGH_MOVE_TARGETS[target]}`;

/** 同じサーバの、別の Origin（`127.0.0.1` を `localhost` にした名前）。 */
export const crossOriginOf = (origin: string): string => origin.replace('127.0.0.1', 'localhost');

/** `redirectHops` の 2 つ目の hop。 */
export const REDIRECT_SECOND_HOP = '/pt/redirect-hop-2';
/** `slowRedirect` の 3xx の応答を遅らせる時間（ms。テストが凍結するまでの余裕）。 */
export const SLOW_REDIRECT_MS = 500;

/** `sends` のページが出す送信の宛先（SD-2: READ_ONLY のほかは、どれも届く）。 */
export const PASS_THROUGH_HITS = Object.freeze({
  delete: hit('delete'),
  override: hit('override'),
  bodyOverride: hit('body-override'),
  plain: hit('plain'),
  deleteWord: hit('remove-item'),
  logoutWord: hit('logout-ping'),
  beaconDelete: hit('beacon-delete'),
  workerDelete: hit('worker-delete'),
  reloadDelete: hit('reload-delete'),
  closeDelete: hit('close-delete'),
  formDelete: hit('form-delete'),
  formPost: hit('form-post'),
  frozenPost: hit('frozen-post'),
  frozenPopup: hit('frozen-popup'),
  frozenNavigation: hit('frozen-navigation'),
  frozenRead: hit('frozen-read'),
  credential: hit('credential'),
  redirectDelete: hit('redirect-delete'),
  frozenRedirect: hit('frozen-redirect'),
  corsReject: hit('cors-reject'),
} as const);

const sendsHtml = (origin: string): string => html(TOP_TITLE, `<script>
const H = ${JSON.stringify(PASS_THROUGH_HITS)};
const first = sessionStorage.getItem('pt-reloaded') === null;
fetch(H.delete, { method: 'DELETE' }).catch(() => undefined);
fetch(H.override, { method: 'POST', headers: { 'X-HTTP-Method-Override': 'DELETE' }, body: 'x' }).catch(() => undefined);
fetch(H.bodyOverride, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_method=DELETE' }).catch(() => undefined);
const xhr = new XMLHttpRequest(); xhr.open('POST', H.plain); xhr.send('x');
fetch(H.deleteWord, { method: 'POST', body: 'x' }).catch(() => undefined);
fetch(H.logoutWord, { method: 'POST', body: 'x' }).catch(() => undefined);
navigator.sendBeacon(H.beaconDelete, new Blob(['_method=DELETE'], { type: 'application/x-www-form-urlencoded' }));
new Worker(URL.createObjectURL(new Blob([\`fetch('${origin}' + ${JSON.stringify(PASS_THROUGH_HITS.workerDelete)}, { method: 'DELETE' }).catch(() => undefined);\`])));
addEventListener('pagehide', () => { fetch(first ? H.reloadDelete : H.closeDelete, { method: 'DELETE', keepalive: true }).catch(() => undefined); });
try { new WebSocket('${origin.replace('http', 'ws')}${PASS_THROUGH_DANGEROUS_SOCKET_PATH}'); } catch {}
if (first) { sessionStorage.setItem('pt-reloaded', '1'); setTimeout(() => location.reload(), 200); }
</script>`);
const autoSubmitHtml = (action: string, fields: string): string => html(TOP_TITLE, `<form method="post" action="${action}">${fields}</form>
<script>setTimeout(() => document.forms[0].submit(), 0);</script>`);
const frozenHtml = (origin: string): string => html(TOP_TITLE, `<script>
const H = ${JSON.stringify(PASS_THROUGH_HITS)};
window.afterFreeze = () => {
  fetch(H.frozenPost, { method: 'POST', body: 'x' }).catch(() => undefined);
  window.open(H.frozenPopup);
  try { new WebSocket('${origin.replace('http', 'ws')}${PASS_THROUGH_SOCKET_PATH}'); } catch {}
  setTimeout(() => { location.href = H.frozenNavigation; }, 50);
  return true;
};
</script>`);
const frozenWorkerHtml = (origin: string): string => html(TOP_TITLE, `<script>
const socket = ${JSON.stringify(`${origin.replace('http', 'ws')}${PASS_THROUGH_WORKER_SOCKET_PATH}`)};
const worker = new Worker(URL.createObjectURL(new Blob([\`
const open = () => { try { new WebSocket(\${JSON.stringify(socket)}); } catch {} };
open();
onmessage = open;
\`])));
window.afterFreeze = () => {
  worker.postMessage('go');
  new Image().src = ${JSON.stringify(PASS_THROUGH_HITS.frozenRead)};
  return true;
};
</script>`);
const relayScript = `<script>
document.cookie = 'pt=relay; path=/';
window.openRelay = (url) => new Promise((resolve) => {
  const socket = new WebSocket(url);
  window.relay = socket;
  socket.onopen = () => socket.send('hello');
  socket.onmessage = (event) => resolve(String(event.data));
  socket.onclose = () => resolve('close');
});
window.sendRelay = (text) => { try { window.relay.send(text); return 'sent'; } catch { return 'failed'; } };
</script>`;
const relayHtml = html(TOP_TITLE, relayScript);
const relayFramedHtml = (origin: string): string => html(TOP_TITLE, `<iframe src="${origin.replace('127.0.0.1', 'localhost')}${CONTRACT_PATHS.child}"></iframe>${relayScript}`);

/** DEF-276-relay: 中継の代表の WebSocket の握手を受け、text の frame に `echo:` を付けて返す（mask を外す。小さい frame だけ）。 */
export const acceptEchoWebSocket = (request: IncomingMessage, socket: Duplex, received: string[]): void => {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string') {
    socket.destroy();
    return;
  }
  received.push(`UPGRADE-HEADERS ${request.headers.origin ?? '-'} ${request.headers.cookie ?? '-'}`);
  socket.on('error', () => undefined);
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6) {
      const opcode = (buffer[0] ?? 0) & 0x0f;
      const length = (buffer[1] ?? 0) & 0x7f;
      if (length > 125 || buffer.length < 6 + length) return;
      const mask = buffer.subarray(2, 6);
      const payload = Buffer.from(buffer.subarray(6, 6 + length).map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
      buffer = buffer.subarray(6 + length);
      if (opcode !== 0x1) {
        socket.destroy();
        return;
      }
      received.push(`FRAME ${payload.toString('utf8')}`);
      const reply = Buffer.from(`echo:${payload.toString('utf8')}`, 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
    }
  });
};

const credentialHtml = html(TOP_TITLE, `<script>
window.sendCredential = (value) => fetch(${JSON.stringify(PASS_THROUGH_HITS.credential)}, { method: 'POST', body: 'p=' + encodeURIComponent(value) })
  .then(() => 'sent', () => 'failed');
</script>`);

export interface ContractSite {
  readonly origin: string;
  /** 繋がらない宛先（閉じたポート）の URL。 */
  readonly unreachableUrl: string;
  /** 受けた要求（`<method> <path>`。受けた順）。 */
  readonly received: () => readonly string[];
  /** 受けている途中の要求がなくなるまで待つ（閉じた後に遅れて届く分の数え直し。`LoopbackHttpServer.whenIdle`）。 */
  readonly whenIdle: (limitMs?: number) => Promise<void>;
  readonly close: () => Promise<void>;
}

export const startContractSite = async (unreachableUrl: string): Promise<ContractSite> => {
  const received: string[] = [];
  const send = (response: ServerResponse, status: number, type: string, body: string): void => {
    response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    response.end(body);
  };
  /** このサーバの Origin（起動の後に入れる。ページの中の絶対形の URL に使う）。 */
  let origin = '';
  const server: LoopbackHttpServer = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://contract.invalid').pathname;
    received.push(`${request.method ?? ''} ${path}`);
    switch (path) {
      case CONTRACT_PATHS.top:
        send(response, 200, 'text/html', TOP_HTML);
        return;
      case CONTRACT_PATHS.redirect:
        response.writeHead(302, { location: CONTRACT_PATHS.top });
        response.end();
        return;
      case CONTRACT_PATHS.robots:
        send(response, 200, 'text/plain', ROBOTS_BODY);
        return;
      case CONTRACT_PATHS.hang:
        return;
      case CONTRACT_PATHS.frames:
        send(response, 200, 'text/html', FRAMES_HTML);
        return;
      case CONTRACT_PATHS.child:
        send(response, 200, 'text/html', html('child', '<p>child</p>'));
        return;
      case CONTRACT_PATHS.forged:
        send(response, 200, 'text/html', FORGED_HTML);
        return;
      case CONTRACT_PATHS.events:
        send(response, 200, 'text/html', EVENTS_HTML);
        return;
      case CONTRACT_PATHS.network:
        send(response, 200, 'text/html', networkHtml(unreachableUrl));
        return;
      case CONTRACT_PATHS.data:
        send(response, 200, 'application/json', '{"ok":true}');
        return;
      case PASS_THROUGH_PAGES.sends:
        send(response, 200, 'text/html', sendsHtml(origin));
        return;
      case PASS_THROUGH_PAGES.formDelete:
        send(response, 200, 'text/html', autoSubmitHtml(PASS_THROUGH_HITS.formDelete, '<input type="hidden" name="_method" value="DELETE">'));
        return;
      case PASS_THROUGH_PAGES.formPost:
        send(response, 200, 'text/html', autoSubmitHtml(PASS_THROUGH_HITS.formPost, '<input type="hidden" name="memo" value="x">'));
        return;
      case PASS_THROUGH_PAGES.frozen:
        send(response, 200, 'text/html', frozenHtml(origin));
        return;
      case PASS_THROUGH_PAGES.frozenWorker:
        send(response, 200, 'text/html', frozenWorkerHtml(origin));
        return;
      case PASS_THROUGH_PAGES.credential:
        send(response, 200, 'text/html', credentialHtml);
        return;
      case PASS_THROUGH_PAGES.relay:
        send(response, 200, 'text/html', relayHtml);
        return;
      case PASS_THROUGH_PAGES.relayFramed:
        send(response, 200, 'text/html', relayFramedHtml(origin));
        return;
      case PASS_THROUGH_PAGES.redirectHops:
        response.writeHead(302, { location: REDIRECT_SECOND_HOP, 'cache-control': 'no-store' });
        response.end();
        return;
      case REDIRECT_SECOND_HOP:
        response.writeHead(302, { location: PASS_THROUGH_HITS.redirectDelete, 'cache-control': 'no-store' });
        response.end();
        return;
      case PASS_THROUGH_PAGES.cors:
        send(response, 200, 'text/html', html(TOP_TITLE, `<script>
fetch(${JSON.stringify(`${crossOriginOf(origin)}${PASS_THROUGH_HITS.corsReject}`)}, { method: 'PUT', headers: { 'X-Custom': '1' }, body: 'x' }).catch(() => undefined);
</script>`));
        return;
      case PASS_THROUGH_PAGES.scriptMove:
      case PASS_THROUGH_PAGES.redirectMove: {
        const target = new URL(request.url ?? '/', 'http://contract.invalid').searchParams.get('to') as PassThroughMoveTarget | null;
        const to = target !== null && target in PASS_THROUGH_MOVE_TARGETS ? moveTargetUrlOf(origin, target) : '/';
        if (path === PASS_THROUGH_PAGES.redirectMove) {
          response.writeHead(302, { location: to, 'cache-control': 'no-store' });
          response.end();
          return;
        }
        send(response, 200, 'text/html', html(TOP_TITLE, `<script>setTimeout(() => { location.href = ${JSON.stringify(to)}; }, 0);</script>`));
        return;
      }
      case PASS_THROUGH_PAGES.slowRedirect:
        setTimeout(() => {
          response.writeHead(302, { location: PASS_THROUGH_HITS.frozenRedirect, 'cache-control': 'no-store' });
          response.end();
        }, SLOW_REDIRECT_MS);
        return;
      default:
        // SD-2: main frame の移る先は、画面（文書）を返す（204 では移動が確かにならない）。
        if ((Object.values(PASS_THROUGH_MOVE_TARGETS) as readonly string[]).includes(path)) {
          send(response, 200, 'text/html', html('moved', '<p>moved</p>'));
          return;
        }
        if (path.startsWith(PASS_THROUGH_HIT_PREFIX)) {
          request.resume();
          response.writeHead(204, { 'cache-control': 'no-store' });
          response.end();
          return;
        }
        // `missing` と、ブラウザ自身の favicon などは、本文の空の 404（DEF-029: 本文の空の 4xx の本文の読み）。
        send(response, 404, 'text/plain', '');
    }
  });
  origin = server.origin;
  // 通り道の代表: WebSocket の Upgrade を受けたら記録して切る（届いたかだけを数える）。中継の代表の path は、握手を受けて返す。
  server.server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const path = new URL(request.url ?? '/', 'http://contract.invalid').pathname;
    received.push(`UPGRADE ${path}`);
    if (path === PASS_THROUGH_RELAY_SOCKET_PATH) {
      acceptEchoWebSocket(request, socket, received);
      return;
    }
    socket.destroy();
  });
  return {
    origin: server.origin,
    unreachableUrl,
    received: () => Object.freeze([...received]),
    whenIdle: (limitMs?: number) => server.whenIdle(limitMs),
    close: () => server.close(),
  };
};

// 読み手 ---------------------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null;

/** 見出しの読み手（題と、見出しの文言）。 */
export const HEADING_READER: NamedPageReader<null, { readonly title: string; readonly greeting: string | null }> = Object.freeze({
  id: 'contract.heading',
  run: () => ({ title: document.title, greeting: document.getElementById('greeting')?.textContent ?? null }),
  parse: (raw: unknown) => (isRecord(raw) && typeof raw['title'] === 'string' && (typeof raw['greeting'] === 'string' || raw['greeting'] === null)
    ? { title: raw['title'], greeting: raw['greeting'] }
    : null),
});

/** 答えの形をいつも断る読み手（`ANSWER_SHAPE` の確かめ）。 */
export const REFUSING_READER: NamedPageReader<null, never> = Object.freeze({
  id: 'contract.refusing',
  run: () => document.title,
  parse: () => null,
});

/** 項目の要素の読み手（文言と、要素の参照）。 */
export const ITEMS_READER: NamedElementReader<null, readonly string[]> = Object.freeze({
  id: 'contract.items',
  run: () => {
    const elements = [...document.querySelectorAll('.item')];
    return { value: elements.map((element) => element.textContent ?? ''), elements };
  },
  parse: (raw: unknown) => (Array.isArray(raw) && raw.every((text) => typeof text === 'string') ? raw : null),
});

/** 認証の状態の往復に渡す状態（`origin` の Cookie と localStorage）。 */
export const contractStorageStateOf = (origin: string): AuthenticatedStorageState => Object.freeze({
  cookies: Object.freeze([Object.freeze({
    name: 'contract-session',
    value: 'contract-cookie-value',
    domain: new URL(origin).hostname,
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  })]),
  origins: Object.freeze([Object.freeze({ origin, localStorage: Object.freeze([Object.freeze({ name: 'contract-key', value: 'contract-local-value' })]) })]),
});

// 偽の口の台本（本物の答えの記録）------------------------------------------------------------------------------------

/** このサーバを、偽の口の台本に書いたもの。 */
export const fakeSiteOf = (site: Pick<ContractSite, 'origin' | 'unreachableUrl'>): FakeSite => {
  const url = (path: string): string => `${site.origin}${path}`;
  const heading = { [HEADING_READER.id]: { title: TOP_TITLE, greeting: GREETING }, [REFUSING_READER.id]: TOP_TITLE };
  return Object.freeze({
    [url(CONTRACT_PATHS.top)]: {
      answers: heading,
      elementAnswers: {
        [ITEMS_READER.id]: { value: ITEMS, elements: ITEMS.map((_item, index) => ({ backendNodeId: index + 1, path: [0, 1, index + 1] })) },
      },
    },
    [url(CONTRACT_PATHS.redirect)]: { finalUrl: url(CONTRACT_PATHS.top), answers: heading },
    [url(CONTRACT_PATHS.robots)]: { body: ROBOTS_BODY },
    [url(CONTRACT_PATHS.missing)]: { httpStatus: 404, body: '' },
    [url(CONTRACT_PATHS.hang)]: { hangs: true },
    [url(CONTRACT_PATHS.frames)]: { childFrameUrls: [url(CONTRACT_PATHS.child)] },
    [url(CONTRACT_PATHS.forged)]: { answers: { [HEADING_READER.id]: { title: TOP_TITLE, greeting: GREETING } } },
    [url(CONTRACT_PATHS.events)]: {
      events: [{ kind: 'console', level: 'error', text: CONTRACT_CONSOLE_TEXT }, { kind: 'pageerror', message: CONTRACT_PAGE_ERROR }],
    },
    [url(CONTRACT_PATHS.network)]: {
      requests: [{ url: url(CONTRACT_PATHS.data) }, { url: site.unreachableUrl, failedWith: 'net::ERR_CONNECTION_REFUSED' }],
    },
  });
};
