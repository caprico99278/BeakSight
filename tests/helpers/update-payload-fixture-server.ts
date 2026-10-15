// T31c（Task 31 の設計書 3 章の「欄の役割」「削除にあたる変更の遮断」の送る中身の照合、「同じ名前の hidden と checkbox の組」）: 更新の画面の
// fixture のサーバ（テストの補助。`tests/integration/guard-update-payload.test.ts` が使う）。
// - 127.0.0.1 だけで待ち受ける（`startLoopbackHttpServer`）。
// - 更新の画面（GET。query の `variant` で形を、`enctype` で送り方を選ぶ）は、Rails 型の形: `_method=PATCH` の hidden、CSRF の hidden（起動の
//   たびに作る目印の値）、変える欄（`customer_name`）、保つ欄（`memo`。前の値は 2 行）、状態の名前の hidden（`active=1`）、同じ名前の hidden と
//   checkbox の組（`published`。hidden は `0`、checkbox は `1` でチェックあり）、チェックしていない checkbox（`notify`）、楽観的な排他の hidden
//   （`lock_version`）。
// - `variant` のうち `plain` のほかは、送信の前にページの JS が中身を変える形（保つ欄の値、状態の hidden、組の hidden、組の checkbox、ないはずの
//   checkbox）。
// - 送信先（POST）は 303 で更新の後の画面へ。サーバに届いた要求（method、path と query、`Content-Type`）を順に記録する。本文は記録しない。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startLoopbackHttpServer } from './loopback-server.js';

const RANDOM_VALUE_BYTES = 8;
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_NOT_FOUND = 404;

/** fixture のパス。 */
export const UPDATE_FIXTURE_PATHS = Object.freeze({
  /** 更新の画面（GET）。 */
  edit: '/records/7/edit',
  /** 更新の送信先（POST。303 で更新の後の画面へ）と、更新の後の画面（GET）。 */
  record: '/records/7',
} as const);

/** 更新の画面の形（query の `variant`）。 */
export const UPDATE_FORM_VARIANTS = Object.freeze([
  'plain',
  'js-kept',
  'js-state',
  'js-pair-hidden',
  'js-pair-uncheck',
  'js-absent',
] as const);
export type UpdateFormVariant = (typeof UPDATE_FORM_VARIANTS)[number];

/** 更新の画面の送り方（query の `enctype`）。 */
export type UpdateFormEnctype = 'urlencoded' | 'multipart';

/** 更新の画面の欄の前の値（期待を作るテストが使う）。 */
export const UPDATE_FIXTURE_VALUES = Object.freeze({
  customerName: '山田 太郎',
  memo: '一行目\n二行目',
  active: '1',
  publishedOff: '0',
  publishedOn: '1',
  notify: '1',
  lockVersion: '3',
} as const);

/** サーバに届いた要求の記録。 */
export interface UpdateFixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
}

export interface UpdateFixtureServer {
  readonly origin: string;
  readonly csrfMarker: string;
  readonly requests: readonly UpdateFixtureRequest[];
  /** 更新の画面の URL。 */
  formUrl(variant: UpdateFormVariant, enctype?: UpdateFormEnctype): string;
  close(): Promise<void>;
}

const randomValue = (): string => randomBytes(RANDOM_VALUE_BYTES).toString('hex');

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>${body}</body></html>`);
}

/** 送信の前にページの JS が中身を変える形の script（`submit` の事象の中で変える）。 */
const SUBMIT_SCRIPTS: Readonly<Record<Exclude<UpdateFormVariant, 'plain'>, string>> = Object.freeze({
  'js-kept': "document.getElementById('memo').value = 'changed by the page';",
  'js-state': "document.getElementById('active').value = '0';",
  'js-pair-hidden': "document.getElementById('published-off').value = '1';",
  'js-pair-uncheck': "document.getElementById('published').checked = false;",
  'js-absent': "document.getElementById('notify').checked = true;",
});

function formHtml(variant: UpdateFormVariant, enctype: UpdateFormEnctype, csrf: string): string {
  const v = UPDATE_FIXTURE_VALUES;
  const formEnctype = enctype === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
  const script = variant === 'plain' ? '' : `<script>document.getElementById('f').addEventListener('submit', () => { ${SUBMIT_SCRIPTS[variant]} });</script>`;
  return `<h1 id="title">EDIT RECORD</h1><form id="f" method="post" action="${UPDATE_FIXTURE_PATHS.record}" enctype="${formEnctype}">`
    + '<input type="hidden" name="_method" value="PATCH">'
    + `<input type="hidden" name="authenticity_token" value="${csrf}">`
    + `<input name="customer_name" id="customer_name" value="${v.customerName}">`
    + `<textarea name="memo" id="memo">${v.memo}</textarea>`
    + `<input type="hidden" name="active" id="active" value="${v.active}">`
    + `<input type="hidden" name="published" id="published-off" value="${v.publishedOff}">`
    + `<input type="checkbox" name="published" id="published" value="${v.publishedOn}" checked>`
    + `<input type="checkbox" name="notify" id="notify" value="${v.notify}">`
    + `<input type="hidden" name="lock_version" value="${v.lockVersion}">`
    + '<button id="go" type="submit">update</button></form>'
    + script;
}

async function drain(request: IncomingMessage): Promise<void> {
  for await (const _chunk of request) {
    // 本文は読まない（記録しない）。
  }
}

export async function startUpdatePayloadFixtureServer(): Promise<UpdateFixtureServer> {
  const csrfMarker = `csrf${randomValue()}`;
  const requests: UpdateFixtureRequest[] = [];
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, contentType: request.headers['content-type'] ?? null });
    void drain(request).then(() => {
      if (request.method === 'GET' && url.pathname === UPDATE_FIXTURE_PATHS.edit) {
        const variant = (url.searchParams.get('variant') ?? 'plain') as UpdateFormVariant;
        const enctype: UpdateFormEnctype = url.searchParams.get('enctype') === 'multipart' ? 'multipart' : 'urlencoded';
        sendHtml(response, formHtml(variant, enctype, csrfMarker));
        return;
      }
      if (request.method === 'POST' && url.pathname === UPDATE_FIXTURE_PATHS.record) {
        response.writeHead(STATUS_SEE_OTHER, { location: UPDATE_FIXTURE_PATHS.record, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === UPDATE_FIXTURE_PATHS.record) {
        sendHtml(response, '<h1 id="updated">UPDATED</h1>');
        return;
      }
      response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
      response.end();
    });
  };
  const server = await startLoopbackHttpServer(listener);
  return {
    origin: server.origin,
    csrfMarker,
    requests,
    formUrl: (variant, enctype = 'urlencoded') => `${server.origin}${UPDATE_FIXTURE_PATHS.edit}?variant=${variant}&enctype=${enctype}`,
    close: () => server.close(),
  };
}
