// AS-a・AS-c・AS-c fix round 1: 監査の段の送信の扱い（`PASS_EXCEPT_DELETE`）の結合テストの共通の部品（サイトと、ページから送る操作）。
// サイトは 127.0.0.1 のサーバで、受けた要求を `<method> <path>` で記録する（favicon と CORS の事前確認は除く）。WebSocket の握手は Node の標準だけで応え、
// `UPGRADE <path>` で記録する（接続の上の送受信は扱わない）。
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Frame, Page } from 'playwright';
import { wait } from '../../src/core/deadline.js';
import { BROWSER_DEFAULT_FAVICON_PATH } from '../../src/safety/request-policy.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from './loopback-server.js';

/** サイトのページと、その中の iframe の path。 */
export const PAGE_PATH = '/page';
export const FRAME_PATH = '/frame';
/** 通すべき要求がサーバに届くのを待つ時間の上限（ms）と、その間に記録を見直す間隔（ms）。 */
export const ARRIVAL_TIMEOUT_MS = 10_000;
export const ARRIVAL_POLL_MS = 50;

/** 待つ（`src/core/deadline.ts` の `wait` を読んで公開し直す。テストで自前の `wait` を書かない。PRE42-CC 組 G）。 */
export { wait };

/** サーバが受けた要求（`<method> <path>`。favicon と CORS の事前確認は除く）と、CORS の事前確認（path）。 */
export interface RecordingServer {
  readonly server: LoopbackHttpServer;
  readonly requests: string[];
  /** AS-c fix round 1（I-1）: 受けた CORS の事前確認の path。 */
  readonly preflights: string[];
}

/** AS-c fix round 1（I-1）: CORS を許さない path の始まり（事前確認に 403 を返し、CORS のヘッダを付けない）。 */
export const NO_CORS_PATH_PREFIX = '/nocors';
/** AS-c fix round 1（I-1）: 事前確認に応答しない path の始まり（本番の要求には CORS を許して応答する）。 */
export const SILENT_PREFLIGHT_PATH_PREFIX = '/silent-preflight';
/** AS-c fix round 2（I-D）: リダイレクトを返す path の始まり（`/redirect/<状態>/<名前>?to=<URL>`）。 */
export const REDIRECT_PATH_PREFIX = '/redirect/';

/** AS-c fix round 2（I-D）: `status` で `to` へリダイレクトする、サイトの URL。 */
export const redirectUrlOf = (origin: string, status: number, name: string, to: string): string =>
  `${origin}${REDIRECT_PATH_PREFIX}${String(status)}/${name}?to=${encodeURIComponent(to)}`;

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>p</title></head><body>
<form id="main-form" method="post" action="/form-target"><input name="field" value="v"></form>
<iframe id="child" src="${FRAME_PATH}"></iframe>
</body></html>`;
const FRAME_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>f</title></head><body>
<form id="frame-form" method="post" action="/frame-target"><input name="field" value="v"></form>
</body></html>`;

/** WebSocket の握手の GUID（RFC 6455）。 */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 記録するサイトを起動する（CORS はすべて許す）。 */
export const startRecordingServer = async (): Promise<RecordingServer> => {
  const requests: string[] = [];
  const preflights: string[] = [];
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    const isPreflight = method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
    if (path !== BROWSER_DEFAULT_FAVICON_PATH && !isPreflight) {
      requests.push(`${method} ${path}`);
    }
    if (isPreflight) {
      preflights.push(path);
    }
    request.resume();
    if (isPreflight && path.startsWith(SILENT_PREFLIGHT_PATH_PREFIX)) {
      // 応答しない（サーバを閉じるときに、接続ごと切られる）。
      return;
    }
    // AS-c fix round 2（I-D）: `/redirect/<状態>/<名前>?to=<URL>` は、その状態で `to` へリダイレクトする（CORS は許す）。
    if (path.startsWith(REDIRECT_PATH_PREFIX) && !isPreflight) {
      const status = Number(path.slice(REDIRECT_PATH_PREFIX.length).split('/')[0]);
      const to = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('to') ?? '/';
      response.writeHead(status, { location: to, 'access-control-allow-origin': '*' });
      response.end();
      return;
    }
    if (path.startsWith(NO_CORS_PATH_PREFIX)) {
      response.writeHead(isPreflight ? 403 : 200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('x');
      return;
    }
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS, DELETE',
      'access-control-allow-headers': 'content-type',
    };
    if (method === 'GET' && (path === PAGE_PATH || path === FRAME_PATH)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors });
      response.end(path === PAGE_PATH ? PAGE_HTML : FRAME_HTML);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...cors });
    response.end('ok');
  };
  const server = await startLoopbackHttpServer(listener);
  server.server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    requests.push(`UPGRADE ${new URL(request.url ?? '/', 'http://127.0.0.1').pathname}`);
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    socket.on('error', () => undefined);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  return { server, requests, preflights };
};

/** ページの main world で WebSocket を開き、開いたか（`open`）、失敗したか（`error`・`close`）を返す（待つ上限を過ぎたら `timeout`）。 */
export const openWebSocketFromPage = (page: Page, url: string): Promise<string> => page.evaluate(
  ({ target, limitMs }) => new Promise<string>((resolveState) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(target);
    } catch {
      resolveState('error');
      return;
    }
    const timer = setTimeout(() => resolveState('timeout'), limitMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveState('open'); });
    socket.addEventListener('error', () => { clearTimeout(timer); resolveState('error'); });
    socket.addEventListener('close', () => { clearTimeout(timer); resolveState('close'); });
  }),
  { target: url, limitMs: ARRIVAL_TIMEOUT_MS },
);

/**
 * AS-c fix round 1（AS-R の M01〜M06）: ページのスクリプトが Playwright の WebSocket の模擬を迂回して、本物の接続を開く（`apiConnect`: 模擬の内部の接続の
 * 口を直に呼ぶ、`urlSwap`: Guard の判定の後に URL を差し替える）。開いたか（`open`）、失敗したか（`error`・`close`）を返す。
 */
export const bypassWebSocketMock = (target: Page | Frame, url: string, mode: 'apiConnect' | 'urlSwap', swapTo = ''): Promise<string> => target.evaluate(
  ({ address, how, swapped, limitMs }) => new Promise<string>((resolveState) => {
    let socket: WebSocket & { _apiConnect?: () => void };
    try {
      socket = new WebSocket(address) as WebSocket & { _apiConnect?: () => void };
    } catch {
      resolveState('error');
      return;
    }
    try {
      if (how === 'apiConnect') socket._apiConnect?.();
      if (how === 'urlSwap') Object.defineProperty(socket, 'url', { value: swapped, writable: true, configurable: true });
    } catch {
      resolveState('bypass-failed');
      return;
    }
    const timer = setTimeout(() => resolveState('timeout'), limitMs);
    socket.addEventListener('open', () => { clearTimeout(timer); resolveState('open'); });
    socket.addEventListener('error', () => { clearTimeout(timer); resolveState('error'); });
    socket.addEventListener('close', () => { clearTimeout(timer); resolveState('close'); });
  }),
  { address: url, how: mode, swapped: swapTo, limitMs: ARRIVAL_TIMEOUT_MS },
);

/**
 * AS-c fix round 1: Worker が動き始めてから WebSocket を開くまで待つ時間（ms）。観察の session が Worker の target に `Network` を有効にするのを待つ
 * （動き始めた直後に開く接続は、観察から漏れうる。`doc/spec/safety.md` の観察の限界）。
 */
export const WORKER_SETTLE_MS = 500;

/**
 * AS-c fix round 1（AS-R の D14・D16）: ページが作った blob の Worker の中で WebSocket を開き、開いたか（`open`）、失敗したか（`error`）を返す。Worker が
 * 動き始めた（`ready`）後、`WORKER_SETTLE_MS` 待ってから開く。
 */
export const openWebSocketFromWorker = (page: Page, url: string): Promise<string> => page.evaluate(
  ({ address, limitMs, settleMs }) => new Promise<string>((resolveState) => {
    const source = 'postMessage("ready");self.onmessage=(e)=>{try{const s=new WebSocket(e.data);s.onopen=()=>postMessage("open");s.onerror=()=>postMessage("error");}catch(x){postMessage("error")}};';
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    const timer = setTimeout(() => resolveState('timeout'), limitMs);
    worker.onmessage = (event) => {
      if (event.data === 'ready') {
        setTimeout(() => worker.postMessage(address), settleMs);
        return;
      }
      clearTimeout(timer);
      resolveState(String(event.data));
    };
    worker.onerror = () => { clearTimeout(timer); resolveState('worker-error'); };
  }),
  { address: url, limitMs: ARRIVAL_TIMEOUT_MS, settleMs: WORKER_SETTLE_MS },
);

/** `http://` の Origin を `ws://` にする。 */
export const webSocketOriginOf = (origin: string): string => origin.replace(/^http:/u, 'ws:');

/** サーバに `expected` の要求がすべて届くまで待つ（届かなければ、そのままの記録を返す）。 */
export const waitForArrivals = async (site: RecordingServer, expected: readonly string[]): Promise<readonly string[]> => {
  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  while (Date.now() < deadline && !expected.every((entry) => site.requests.includes(entry))) {
    await wait(ARRIVAL_POLL_MS);
  }
  return [...site.requests];
};

/** 読み取りでない要求（GET と HEAD のほか）。 */
export const nonReads = (site: RecordingServer): readonly string[] =>
  site.requests.filter((entry) => !entry.startsWith('GET ') && !entry.startsWith('HEAD '));

/** ページの main world の fetch（応答の状態。届かなければ 0）。 */
export const fetchFromPage = (page: Page, url: string, method: string, contentType = 'text/plain'): Promise<number> =>
  sendFromPage(page, url, method, { 'content-type': contentType }, 'payload');

/** AS-c fix round 1（AS-R の A07・A08）: ページの main world の fetch（ヘッダと本文を指定する。応答の状態。届かなければ 0）。 */
export const sendFromPage = (page: Page, url: string, method: string, headers: Record<string, string>, body: string): Promise<number> => page.evaluate(
  async ({ target, verb, sentHeaders, sentBody }) => {
    try {
      const response = await fetch(target, { method: verb, headers: sentHeaders, body: sentBody });
      return response.status;
    } catch {
      return 0;
    }
  },
  { target: url, verb: method, sentHeaders: headers, sentBody: body },
);

/** AS-c fix round 2（I-E。AS-R2 の A26）: 型のない Blob の本文の POST（`Content-Type` が付かない。応答の状態。届かなければ 0）。 */
export const postUntypedBlobFromPage = (page: Page, url: string, body: string): Promise<number> => page.evaluate(
  async ({ target, text }) => {
    try {
      return (await fetch(target, { method: 'POST', body: new Blob([text]) })).status;
    } catch {
      return 0;
    }
  },
  { target: url, text: body },
);

/** AS-c fix round 1（I-1。AS-R の P01・P02・P05）: CORS の事前確認が要る fetch（JSON の本文。応答の状態。届かない・CORS で失敗なら 0）。 */
export const corsFetchFromPage = (page: Page, url: string, method: string, credentials: RequestCredentials): Promise<number> => page.evaluate(
  async ({ target, verb, mode }) => {
    try {
      const response = await fetch(target, { method: verb, headers: { 'content-type': 'application/json' }, body: '{}', credentials: mode });
      return response.status;
    } catch {
      return 0;
    }
  },
  { target: url, verb: method, mode: credentials },
);

/** ページの main world の XHR（応答の状態。届かなければ 0）。 */
export const xhrFromPage = (page: Page, url: string, method: string): Promise<number> => page.evaluate(
  ({ target, verb }) => new Promise<number>((resolveStatus) => {
    const xhr = new XMLHttpRequest();
    xhr.open(verb, target);
    xhr.onload = () => resolveStatus(xhr.status);
    xhr.onerror = () => resolveStatus(0);
    xhr.send('payload');
  }),
  { target: url, verb: method },
);

/** ページの main world の `navigator.sendBeacon`（キューに入れたか）。 */
export const beaconFromPage = (page: Page, url: string): Promise<boolean> => page.evaluate(
  (target) => navigator.sendBeacon(target, 'payload'),
  url,
);
