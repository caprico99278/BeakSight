// T30b（Task 30 の設計書 6 章の「書き込みの段の Guard」）: 書き込みのフォームの fixture のサーバ（テストの補助）。
// - 127.0.0.1 だけで待ち受ける（`startLoopbackHttpServer`）。同じサーバを、2 つの名前で、別の Origin として使う。
//   - `originA`（`http://127.0.0.1:<port>`）: 監査の対象の Origin（登録の画面、登録の送信先、結果の画面）。
//   - `originB`（`http://localhost:<port>`）: 別の Origin（別のサイトへの送信の先）。
// - CSRF の hidden の値と readonly の値は、起動のたびに作る目印の値（ランダム）。テストは、届いた本文や記録に出ないかを確かめるために読む。
// - サーバに届いた要求（Origin の別、method、path と query、`Content-Type`）を、順に記録する。本文は記録しない。WebSocket の upgrade も記録して、
//   すぐに切る。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { startLoopbackHttpServer } from './loopback-server.js';

const RANDOM_VALUE_BYTES = 8;
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_TEMPORARY_REDIRECT = 307;
const STATUS_PERMANENT_REDIRECT = 308;
const STATUS_NOT_FOUND = 404;

/** fixture のパス。 */
export const WRITE_FIXTURE_PATHS = Object.freeze({
  /** 登録の画面（GET。query の `variant` で形を選ぶ）。 */
  form: '/items/new',
  /** 登録の送信先（POST。303 で結果の画面へ）。 */
  create: '/items',
  /** 307・308 で、query つきの同じ送信先へ POST をやり直させる送信先（POST）。 */
  create307: '/items-307',
  create308: '/items-308',
  /** 応答しない送信先（POST。サーバを閉じるまで応答しない）。 */
  createHang: '/items-hang',
  /** T30R-fix-1（M-1）: 遅れて応答する送信先（POST。`WRITE_FIXTURE_SLOW_RESPONSE_MS` の後に 303 で結果の画面へ）。 */
  createSlow: '/items-slow',
  /** 承認の送信先と違う path（POST）。 */
  otherPath: '/items/other',
  /** 登録の後の結果の画面（GET）。 */
  created: '/items/1',
  /** フォームを iframe の中に持つ画面（GET）。 */
  framed: '/items/framed',
  /** 何もしない画面（GET）と、画像（GET）。 */
  blank: '/blank',
  pixel: '/pixel',
  /** Worker と Service Worker の script（GET）。 */
  worker: '/worker.js',
  serviceWorker: '/sw.js',
  /** ページを離れるときの送信の先、別の Origin の送信の先（POST）。 */
  beacon: '/beacon',
  collect: '/collect',
  /** WebSocket の接続の先。 */
  webSocket: '/ws',
  /** T30c: いろいろな型の欄を持つ登録の画面（GET。query の `variant` で形を、`enctype` で送り方を選ぶ）。 */
  richForm: '/items/rich',
} as const);

/**
 * T30c: いろいろな型の欄を持つ登録の画面の形（query の `variant`）。`plain` は承認の形どおり。ほかは、送る前の確かめが止める（または通す）形。
 */
export const RICH_FORM_VARIANTS = Object.freeze([
  'plain',
  'checked',
  'action-upper',
  'action-encoded',
  'action-slash',
  'action-port',
  'action-dots',
  'formaction',
  'formmethod',
  'formenctype',
  'target-blank',
  'formtarget',
  'base-target',
  'accept-charset',
  'accept-charset-utf8',
  'form-attribute',
  'other-form-field',
  'type-mismatch',
  'clobber',
  'clobber-approved',
  'getter-override',
  'duplicate-form',
  'two-submitters',
  'extra-field',
  'no-form',
  'replace-on-input',
  'add-field-on-input',
] as const);
export type RichFormVariant = (typeof RICH_FORM_VARIANTS)[number];

/** T30c: いろいろな型の欄を持つ登録の画面の送り方（query の `enctype`）。 */
export type RichFormEnctype = 'urlencoded' | 'multipart';

/** サーバに届いた POST の本文（テストが値を確かめるため。CSRF の目印を含みうるので、テストの外に出さない）。 */
export interface WriteFixturePostBody {
  readonly path: string;
  readonly contentType: string | null;
  readonly body: Buffer;
}

/** 登録の画面の形（query の `variant`）。 */
export const WRITE_FORM_VARIANTS = Object.freeze([
  'plain',
  'multipart',
  'file',
  'text-plain',
  'get',
  'other-path',
  'other-origin',
  'query',
  'create-307',
  'create-308',
  'hang',
  'sjis',
  'js-action',
  'js-field',
  'js-value',
  'window-request',
  'popup',
  // T30b fix round 1: method の上書きの hidden の欄（`_method=PUT`）を持つ form と、送信の前にページの JS がその値を `DELETE` に書き換える form。
  'method-override',
  'method-override-js',
  // T30R-fix-1（M-1）: 送信の事象で、ページの JS がもう一度 `form.submit()` を呼ぶ form（二重の送信。後の送信が前の送信を取り消す）。
  'double-submit',
  // T30R-fix-1（M-1）: 遅れて応答する送信先への、二重の送信（送り手が送っている間に、後の送信が前の送信を取り消す）。
  'double-submit-slow',
] as const);
export type WriteFormVariant = (typeof WRITE_FORM_VARIANTS)[number];

/** T30R-fix-1（M-1）: 遅れて応答する送信先の応答までの時間（ms。Guard の取り消しの証拠の保ち時間 5 秒と待ち 0.5 秒より長い）。 */
export const WRITE_FIXTURE_SLOW_RESPONSE_MS = 6_500;

/** サーバに届いた要求の記録。`site` は、要求の Host が `originA` か `originB` か。 */
export interface WriteFixtureRequest {
  readonly site: 'A' | 'B';
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
}

export interface WriteFixtureServer {
  readonly originA: string;
  readonly originB: string;
  /** CSRF の hidden の目印の値と、readonly の欄の目印の値。 */
  readonly csrfMarker: string;
  readonly readonlyMarker: string;
  /** 届いた要求（届いた順）。 */
  readonly requests: readonly WriteFixtureRequest[];
  /** 届いた本文に、CSRF の目印が含まれていた回数（本文は記録しない）。 */
  readonly csrfBodies: number;
  /** T30c: 届いた POST の本文（届いた順）。 */
  readonly postBodies: readonly WriteFixturePostBody[];
  /** 登録の画面の URL。 */
  formUrl(variant: WriteFormVariant): string;
  /** T30c: いろいろな型の欄を持つ登録の画面の URL。 */
  richFormUrl(variant: RichFormVariant, enctype?: RichFormEnctype): string;
  close(): Promise<void>;
}

const randomValue = (): string => randomBytes(RANDOM_VALUE_BYTES).toString('hex');

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function sendHtml(response: ServerResponse, body: string, charset = 'utf-8'): void {
  response.writeHead(STATUS_OK, { 'content-type': `text/html; charset=${charset}`, 'cache-control': 'no-store' });
  response.end(`<!doctype html><html><head><meta charset="${charset}"><link rel="icon" href="data:,"></head><body>${body}</body></html>`);
}

/** 登録のフォームの本文。 */
function formHtml(variant: WriteFormVariant, originB: string, csrf: string, readonlyValue: string): string {
  const p = WRITE_FIXTURE_PATHS;
  const action = ({
    'other-path': p.otherPath,
    'other-origin': `${originB}${p.create}`,
    query: `${p.create}?x=1`,
    'create-307': p.create307,
    'create-308': p.create308,
    hang: p.createHang,
    'double-submit-slow': p.createSlow,
  } as Partial<Record<WriteFormVariant, string>>)[variant] ?? p.create;
  const enctype = ({ multipart: 'multipart/form-data', file: 'multipart/form-data', 'text-plain': 'text/plain' } as Partial<Record<WriteFormVariant, string>>)[variant]
    ?? 'application/x-www-form-urlencoded';
  const method = variant === 'get' ? 'get' : 'post';
  const target = variant === 'popup' ? ' target="_blank"' : '';
  const file = variant === 'file' ? '<input type="file" name="att" id="att">' : '';
  const override = variant === 'method-override' || variant === 'method-override-js'
    ? '<input type="hidden" name="_method" id="method-override" value="PUT">'
    : '';
  const script = ({
    'js-action': `document.getElementById('f').addEventListener('submit', () => { document.getElementById('f').action = '${p.otherPath}'; });`,
    'js-field': "document.getElementById('f').addEventListener('submit', () => { const extra = document.createElement('input');"
      + " extra.type = 'hidden'; extra.name = 'extra'; extra.value = 'page-added'; document.getElementById('f').append(extra); });",
    'js-value': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('customer_name').value += '!'; });",
    'window-request': `document.getElementById('customer_name').addEventListener('input', (event) => { new Image().src = '${p.pixel}?v=' + encodeURIComponent(event.target.value); });`,
    'method-override-js': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('method-override').value = 'DELETE'; });",
    // T30R-fix-1（M-1）: 0ms（前の送信を、送り手が送っている間に取り消す）。30ms では、前の送信の 303 の移り先の GET を取り消すことがあり、
    // その回は DEF-027 の限界（許した移動の失敗 `HTTP_MAIN_FRAME_DELIVERY_FAILED`。止める側）になる（M-1 の対象の外）。
    'double-submit': "document.getElementById('f').addEventListener('submit', () => { setTimeout(() => document.getElementById('f').submit(), 0); });",
    'double-submit-slow': "document.getElementById('f').addEventListener('submit', () => { setTimeout(() => document.getElementById('f').submit(), 50); });",
  } as Partial<Record<WriteFormVariant, string>>)[variant] ?? '';
  return `<h1 id="title">NEW ITEM</h1><form id="f" method="${method}" action="${action}" enctype="${enctype}"${target}>`
    + `<input type="hidden" name="csrf_token" value="${csrf}">`
    + '<input name="customer_name" id="customer_name">'
    + '<textarea name="memo" id="memo"></textarea>'
    + `<input name="serial" id="serial" readonly value="${readonlyValue}">`
    + `${file}${override}<button id="go" type="submit">register</button></form>`
    + (script === '' ? '' : `<script>${script}</script>`);
}

/**
 * T30c: いろいろな型の欄を持つ登録のフォームの本文。欄は、CSRF の hidden（`csrf_token`）、text（`customer_name`）、textarea（`memo`）、readonly の
 * text（`serial`。T31R2-fix-1: 秘密に見える名前の `code` から変えた）、select（`plan`。a・b・c）、checkbox（`agree`。値 `yes`）、radio 2 つ（`contact`。`mail`・`phone`）、file（`att`）。送信ボタンは `#go`。
 */
function richFormHtml(variant: RichFormVariant, enctype: RichFormEnctype, port: number, csrf: string, readonlyValue: string): string {
  const p = WRITE_FIXTURE_PATHS;
  const action = ({
    'action-upper': '/ITEMS',
    'action-encoded': '/it%65ms',
    'action-slash': `${p.create}/`,
    'action-port': `http://127.0.0.1:${port + 1}${p.create}`,
    'action-dots': `/x/..${p.create}`,
    clobber: p.otherPath,
    'getter-override': p.otherPath,
  } as Partial<Record<RichFormVariant, string>>)[variant] ?? p.create;
  const formEnctype = enctype === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
  const target = variant === 'target-blank' ? ' target="_blank"' : '';
  const acceptCharset = ({ 'accept-charset': ' accept-charset="Shift_JIS"', 'accept-charset-utf8': ' accept-charset="UTF-8"' } as Partial<Record<RichFormVariant, string>>)[variant] ?? '';
  const submitterAttributes = ({
    formaction: ` formaction="${p.otherPath}"`,
    formmethod: ' formmethod="get"',
    formenctype: ' formenctype="text/plain"',
    formtarget: ' formtarget="_blank"',
  } as Partial<Record<RichFormVariant, string>>)[variant] ?? '';
  const customerType = variant === 'type-mismatch' ? 'email' : 'text';
  const customerInside = variant === 'form-attribute' ? '' : variant === 'other-form-field'
    ? '<input name="customer_name" id="customer_name" form="g">'
    : `<input type="${customerType}" name="customer_name" id="customer_name">`;
  const customerOutside = variant === 'form-attribute' ? '<input name="customer_name" id="customer_name" form="f">' : '';
  const clobberInput = variant === 'clobber' ? `<input type="hidden" name="action" value="${p.create}">`
    : variant === 'clobber-approved' ? `<input type="hidden" name="action" value="${p.otherPath}">` : '';
  const extra = variant === 'extra-field' ? '<input type="hidden" name="extra" value="1">' : '';
  const secondSubmitter = variant === 'two-submitters' ? '<button id="go2" type="submit">again</button>' : '';
  const form = (id: string): string => `<form id="${id}" method="post" action="${action}" enctype="${formEnctype}"${target}${acceptCharset}>`
    + `<input type="hidden" name="csrf_token" value="${csrf}">`
    + `${clobberInput}${customerInside}`
    + '<textarea name="memo" id="memo"></textarea>'
    + `<input name="serial" id="serial" readonly value="${readonlyValue}">`
    + '<select name="plan" id="plan"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>'
    + `<input type="checkbox" name="agree" id="agree" value="yes"${variant === 'checked' ? ' checked' : ''}>`
    + `<input type="radio" name="contact" id="contact-mail" value="mail"${variant === 'checked' ? ' checked' : ''}>`
    + '<input type="radio" name="contact" id="contact-phone" value="phone">'
    + `<input type="file" name="att" id="att">${extra}`
    + `<button id="go" type="submit"${submitterAttributes}>register</button>${secondSubmitter}</form>`;
  const script = ({
    'getter-override': `Object.defineProperty(HTMLFormElement.prototype, 'action', { configurable: true, get() { return location.origin + '${p.create}'; } });`
      + "Object.defineProperty(HTMLFormElement.prototype, 'target', { configurable: true, get() { return ''; } });",
    'replace-on-input': "document.getElementById('customer_name').addEventListener('input', () => {"
      + " const form = document.getElementById('f'); form.replaceWith(form.cloneNode(true)); }, { once: true });",
    'add-field-on-input': "document.getElementById('customer_name').addEventListener('input', () => {"
      + " const extra = document.createElement('input'); extra.type = 'hidden'; extra.name = 'extra'; extra.value = 'page-added';"
      + " document.getElementById('f').append(extra); }, { once: true });",
  } as Partial<Record<RichFormVariant, string>>)[variant] ?? '';
  const base = variant === 'base-target' ? '<base target="_blank">' : '';
  const forms = variant === 'no-form' ? '<p>no form</p>' : variant === 'duplicate-form' ? `${form('f')}${form('f2')}` : form('f');
  const other = variant === 'other-form-field' ? `<form id="g" method="post" action="${p.otherPath}"></form>` : '';
  return `${base}<h1 id="title">NEW ITEM</h1>${forms}${customerOutside}${other}`
    + (script === '' ? '' : `<script>${script}</script>`);
}

/** Worker の script（読み込まれたら、承認の送信先へ fetch の POST を送る）。 */
const WORKER_SCRIPT = `fetch('${WRITE_FIXTURE_PATHS.create}', { method: 'POST', body: 'customer_name=w' }).then(() => postMessage('sent'), () => postMessage('blocked'));`;

export async function startWriteFixtureServer(): Promise<WriteFixtureServer> {
  const csrfMarker = `csrf${randomValue()}`;
  const readonlyMarker = `ro${randomValue()}`;
  const requests: WriteFixtureRequest[] = [];
  const postBodies: WriteFixturePostBody[] = [];
  let csrfBodies = 0;
  let port = 0;
  const originA = (): string => `http://127.0.0.1:${port}`;
  const originB = (): string => `http://localhost:${port}`;
  const siteOf = (request: IncomingMessage): 'A' | 'B' => (request.headers.host?.startsWith('localhost:') === true ? 'B' : 'A');

  const handle = async (request: IncomingMessage, response: ServerResponse, url: URL, site: 'A' | 'B'): Promise<void> => {
    const p = WRITE_FIXTURE_PATHS;
    const { pathname } = url;
    const body = await readBody(request);
    if (body.includes(csrfMarker)) {
      csrfBodies += 1;
    }
    if (request.method === 'POST') {
      postBodies.push({ path: `${url.pathname}${url.search}`, contentType: request.headers['content-type'] ?? null, body });
    }
    if (site === 'B') {
      response.writeHead(request.method === 'POST' ? STATUS_OK : STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
      response.end(request.method === 'POST' ? 'B-POST-RECEIVED' : '');
      return;
    }
    if (request.method === 'GET' && pathname === p.form) {
      const variant = (url.searchParams.get('variant') ?? 'plain') as WriteFormVariant;
      sendHtml(response, formHtml(variant, originB(), csrfMarker, readonlyMarker), variant === 'sjis' ? 'shift_jis' : 'utf-8');
      return;
    }
    if (request.method === 'GET' && pathname === p.richForm) {
      const variant = (url.searchParams.get('variant') ?? 'plain') as RichFormVariant;
      const enctype: RichFormEnctype = url.searchParams.get('enctype') === 'multipart' ? 'multipart' : 'urlencoded';
      sendHtml(response, richFormHtml(variant, enctype, port, csrfMarker, readonlyMarker));
      return;
    }
    if (request.method === 'GET' && pathname === p.framed) {
      sendHtml(response, `<iframe id="form-frame" src="${p.form}?variant=plain"></iframe>`);
      return;
    }
    if (request.method === 'POST' && pathname === p.create) {
      response.writeHead(STATUS_SEE_OTHER, { location: p.created });
      response.end();
      return;
    }
    if (request.method === 'POST' && (pathname === p.create307 || pathname === p.create308)) {
      response.writeHead(pathname === p.create307 ? STATUS_TEMPORARY_REDIRECT : STATUS_PERMANENT_REDIRECT, { location: `${pathname}?again=1` });
      response.end();
      return;
    }
    if (request.method === 'POST' && pathname === p.createSlow) {
      setTimeout(() => {
        response.writeHead(STATUS_SEE_OTHER, { location: p.created });
        response.end();
      }, WRITE_FIXTURE_SLOW_RESPONSE_MS);
      return;
    }
    if (request.method === 'POST' && pathname === p.createHang) {
      // 応答しない（サーバを閉じるときに接続を切る）。
      return;
    }
    if (request.method === 'GET' && pathname === p.created) {
      sendHtml(response, '<h1 id="created">CREATED</h1>');
      return;
    }
    if (request.method === 'GET' && pathname === p.worker) {
      response.writeHead(STATUS_OK, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      response.end(WORKER_SCRIPT);
      return;
    }
    if (request.method === 'GET' && pathname === p.serviceWorker) {
      response.writeHead(STATUS_OK, { 'content-type': 'text/javascript' });
      response.end('self.addEventListener("fetch", () => {});');
      return;
    }
    if (request.method === 'GET' && (pathname === p.blank || pathname === p.pixel)) {
      sendHtml(response, '<p id="blank">blank</p>');
      return;
    }
    response.writeHead(request.method === 'POST' ? STATUS_OK : STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
    response.end(request.method === 'POST' ? 'POST-RECEIVED' : '');
  };

  const loopback = await startLoopbackHttpServer((request, response) => {
    const site = siteOf(request);
    const url = new URL(request.url ?? '/', site === 'A' ? originA() : originB());
    const contentType = request.headers['content-type'] ?? null;
    requests.push({ site, method: request.method ?? '', path: `${url.pathname}${url.search}`, contentType });
    handle(request, response, url, site).catch(() => {
      if (!response.headersSent) response.writeHead(STATUS_NOT_FOUND);
      response.end();
    });
  });
  port = loopback.port;
  loopback.server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const site = siteOf(request);
    const url = new URL(request.url ?? '/', site === 'A' ? originA() : originB());
    requests.push({ site, method: 'UPGRADE', path: `${url.pathname}${url.search}`, contentType: null });
    socket.destroy();
  });

  return {
    originA: originA(),
    originB: originB(),
    csrfMarker,
    readonlyMarker,
    requests,
    get csrfBodies() {
      return csrfBodies;
    },
    postBodies,
    formUrl: (variant) => `${originA()}${WRITE_FIXTURE_PATHS.form}?variant=${variant}`,
    richFormUrl: (variant, enctype = 'urlencoded') => `${originA()}${WRITE_FIXTURE_PATHS.richForm}?variant=${variant}&enctype=${enctype}`,
    close: () => loopback.close(),
  };
}
