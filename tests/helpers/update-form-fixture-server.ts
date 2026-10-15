// T31g-1（Task 31 の設計書 3 章の「更新の前の読み取り」「欄の役割」「削除にあたる変更の遮断」「同じ名前の hidden と checkbox の組」）: 更新の
// 画面の fixture のサーバ（テストの補助。`tests/integration/write-form-update.test.ts` が使う）。127.0.0.1 だけで待ち受ける。
// - 更新の画面（GET。query の `variant` で形を、`enctype` で送り方を選ぶ）は Rails 型の形で、DOM の順に: `_method=PATCH` の hidden、CSRF の
//   hidden（起動のたびに作る目印の値）、変える欄（text の `customer_name`）、保つ欄（改行を含む textarea の `memo`、select の `plan`、radio の
//   組 `contact`、チェックした checkbox の `newsletter`、チェックしていない checkbox の `notify`）、状態の名前の hidden（`active=1`）、同じ名前の
//   hidden と checkbox の組（`published`。hidden は `0`、checkbox は `1` でチェックあり）、楽観的な排他の hidden（`lock_version`。起動のたびに
//   作る目印の値）、送信ボタン。
// - `variant` のうち `plain` のほかは、送信の前にページの JS が中身を変える形（保つ欄の値、状態の hidden、組の hidden、組の checkbox、`_method`
//   を `DELETE` にする、保つ select・radio を変える）か、組の hidden と checkbox の間に状態の hidden を挟む形（`pair-split`。欄の名前と型の
//   組は同じで、順だけが違う）。T31g-1 fix round 1: `secret-state` は、状態の語でもあり秘密に見える名前でもある hidden（`state`）を足し、送信の
//   前にページの JS がその値を変える形。
// - `setDrift(true)` の間は、更新の画面の保つ欄 `memo` の値が前と違う（前の読み取りと書き込みの段の読み込みの間に値が変わった形）。
// - 送信先（POST）は 303 で更新の後の画面へ。サーバに届いた要求（method、path と query、`Content-Type`）と POST の本文を順に記録する（本文は
//   テストが送った値を確かめるため。CSRF の目印を含みうるので、テストの外に出さない）。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startLoopbackHttpServer } from './loopback-server.js';

const RANDOM_VALUE_BYTES = 8;
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_NOT_FOUND = 404;

/** fixture のパス。 */
export const UPDATE_FORM_PATHS = Object.freeze({
  /** 更新の画面（GET）。 */
  edit: '/items/12/edit',
  /** 更新の送信先（POST。303 で更新の後の画面へ）と、更新の後の画面（GET）。 */
  record: '/items/12',
} as const);

/** 更新の画面の形（query の `variant`）。 */
export const UPDATE_FORM_FIXTURE_VARIANTS = Object.freeze([
  'plain',
  'js-kept',
  'js-state',
  'js-pair-hidden',
  'js-pair-uncheck',
  'js-method-delete',
  'js-select',
  'js-radio',
  'js-absent',
  'pair-split',
  'secret-state',
] as const);
export type UpdateFormFixtureVariant = (typeof UPDATE_FORM_FIXTURE_VARIANTS)[number];

/** 更新の画面の送り方（query の `enctype`）。 */
export type UpdateFormFixtureEnctype = 'urlencoded' | 'multipart';

/** 更新の画面の欄の前の値（期待を作るテストが比べる）。 */
export const UPDATE_FORM_VALUES = Object.freeze({
  customerName: '山田 太郎',
  memo: '一行目\n二行目',
  driftedMemo: '一行目\n書き換えた行',
  plan: 'premium',
  contact: 'mail',
  newsletter: 'yes',
  notify: 'on-request',
  active: '1',
  publishedOff: '0',
  publishedOn: '1',
} as const);

/** サーバに届いた要求の記録。 */
export interface UpdateFormFixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
}

export interface UpdateFormFixtureServer {
  readonly origin: string;
  readonly csrfMarker: string;
  readonly lockMarker: string;
  readonly requests: readonly UpdateFormFixtureRequest[];
  /** 届いた POST の本文（届いた順）。 */
  readonly postBodies: readonly Buffer[];
  /** 更新の画面の URL。 */
  formUrl(variant: UpdateFormFixtureVariant, enctype?: UpdateFormFixtureEnctype): string;
  /** 保つ欄 `memo` の値を、前の値と違う値にする（`true`）・戻す（`false`）。 */
  setDrift(drift: boolean): void;
  close(): Promise<void>;
}

const randomValue = (): string => randomBytes(RANDOM_VALUE_BYTES).toString('hex');

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>${body}</body></html>`);
}

/** 送信の前にページの JS が中身を変える形の script（`submit` の事象の中で変える）。 */
const SUBMIT_SCRIPTS: Readonly<Partial<Record<UpdateFormFixtureVariant, string>>> = Object.freeze({
  'js-kept': "document.getElementById('memo').value = 'changed by the page';",
  'js-state': "document.getElementById('active').value = '0';",
  'js-pair-hidden': "document.getElementById('published-off').value = '1';",
  'js-pair-uncheck': "document.getElementById('published').checked = false;",
  'js-method-delete': "document.getElementById('method').value = 'DELETE';",
  'js-select': "document.getElementById('plan').value = 'basic';",
  'js-radio': "document.getElementById('contact-phone').checked = true;",
  'js-absent': "document.getElementById('notify').checked = true;",
  'secret-state': "document.getElementById('state').value = 'deleted';",
});

function formHtml(variant: UpdateFormFixtureVariant, enctype: UpdateFormFixtureEnctype, markers: { csrf: string; lock: string }, memo: string): string {
  const v = UPDATE_FORM_VALUES;
  const formEnctype = enctype === 'multipart' ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
  const submitScript = SUBMIT_SCRIPTS[variant];
  const script = submitScript === undefined
    ? ''
    : `<script>document.getElementById('f').addEventListener('submit', () => { ${submitScript} });</script>`;
  const active = `<input type="hidden" name="active" id="active" value="${v.active}">`;
  const pairHidden = `<input type="hidden" name="published" id="published-off" value="${v.publishedOff}">`;
  return `<h1 id="title">EDIT ITEM</h1><form id="f" method="post" action="${UPDATE_FORM_PATHS.record}" enctype="${formEnctype}">`
    + '<input type="hidden" name="_method" id="method" value="PATCH">'
    + `<input type="hidden" name="authenticity_token" value="${markers.csrf}">`
    + `<label>名前 <input name="customer_name" id="customer_name" value="${v.customerName}"></label>`
    + `<label>メモ <textarea name="memo" id="memo">${memo}</textarea></label>`
    + '<label>プラン <select name="plan" id="plan"><option value="basic">基本</option>'
    + `<option value="${v.plan}" selected>上位</option></select></label>`
    + '<label><input type="radio" name="contact" id="contact-phone" value="phone"> 電話</label>'
    + `<label><input type="radio" name="contact" id="contact-mail" value="${v.contact}" checked> メール</label>`
    + `<label><input type="checkbox" name="newsletter" id="newsletter" value="${v.newsletter}" checked> お知らせ</label>`
    + `<label><input type="checkbox" name="notify" id="notify" value="${v.notify}"> 通知</label>`
    + (variant === 'pair-split' ? `${pairHidden}${active}` : `${active}${pairHidden}`)
    + `<label><input type="checkbox" name="published" id="published" value="${v.publishedOn}" checked> 公開</label>`
    + `<input type="hidden" name="lock_version" value="${markers.lock}">`
    + (variant === 'secret-state' ? '<input type="hidden" name="state" id="state" value="open">' : '')
    + '<button id="go" type="submit">update</button></form>'
    + script;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

export async function startUpdateFormFixtureServer(): Promise<UpdateFormFixtureServer> {
  const markers = { csrf: `csrf${randomValue()}`, lock: `lock${randomValue()}` };
  const requests: UpdateFormFixtureRequest[] = [];
  const postBodies: Buffer[] = [];
  let drift = false;
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, contentType: request.headers['content-type'] ?? null });
    void readBody(request).then((body) => {
      if (request.method === 'GET' && url.pathname === UPDATE_FORM_PATHS.edit) {
        const variant = (url.searchParams.get('variant') ?? 'plain') as UpdateFormFixtureVariant;
        const enctype: UpdateFormFixtureEnctype = url.searchParams.get('enctype') === 'multipart' ? 'multipart' : 'urlencoded';
        sendHtml(response, formHtml(variant, enctype, markers, drift ? UPDATE_FORM_VALUES.driftedMemo : UPDATE_FORM_VALUES.memo));
        return;
      }
      if (request.method === 'POST' && url.pathname === UPDATE_FORM_PATHS.record) {
        postBodies.push(body);
        response.writeHead(STATUS_SEE_OTHER, { location: UPDATE_FORM_PATHS.record, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === UPDATE_FORM_PATHS.record) {
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
    csrfMarker: markers.csrf,
    lockMarker: markers.lock,
    requests,
    postBodies,
    formUrl: (variant, enctype = 'urlencoded') => `${server.origin}${UPDATE_FORM_PATHS.edit}?variant=${variant}&enctype=${enctype}`,
    setDrift: (value) => {
      drift = value;
    },
    close: () => server.close(),
  };
}
