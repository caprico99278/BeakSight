/**
 * DEF-186（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 3 章の A_DRAFT、5.1 の 4）: 一覧の行の「編集」を押すと窓（`<dialog>`）が開き、
 * サイトが自動で下書きを POST する形の、仮のサイト。名前は一般の名前（`items`）だけを使う。このファイルは、ほかのファイルを import しない（`node:http` のほか）。
 *
 * - アプリの Origin（127.0.0.1）: 一覧の画面 `LIST_ROW_OPENER_PATHS.list`。行ごとに「編集」と「削除」のボタンがある（行は HTML に書く）。閉じた窓の中に、名前の
 *   欄と「保存」のボタンがある。
 *   - 「編集」: 窓を開き、名前の欄に行の名前を入れ、API の Origin に下書きを POST する（`LIST_ROW_OPENER_PATHS.drafts`。本文は JSON の object）。
 *   - 「保存」: API の Origin に `PATCH LIST_ROW_OPENER_PATHS.items?id=eq.<番号>`（本文は名前）を送り、送れても送れなくても窓を閉じる。
 *   - 「削除」: API の Origin に `DELETE LIST_ROW_OPENER_PATHS.items?id=eq.<番号>` を送る。
 * - API の Origin（127.0.0.1 の別のポート）: 届いた要求をすべて記録する（`requests`）。CORS の事前確認に答え、ほかは空の JSON を返す。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 画面と API の path。 */
export const LIST_ROW_OPENER_PATHS = Object.freeze({
  list: '/items',
  drafts: '/rest/item_drafts',
  items: '/rest/items',
} as const);

/** 画面の要素の ID と、ボタンの文言。 */
export const LIST_ROW_OPENER_ELEMENTS = Object.freeze({
  table: 'item-list',
  dialog: 'item-edit-dialog',
  nameField: 'item-edit-name',
  saveButton: 'item-edit-save',
  editText: '編集',
  removeText: '削除',
  saveText: '保存',
} as const);

/** 一覧の行（番号と名前）。 */
export const LIST_ROW_OPENER_ITEMS = Object.freeze([
  Object.freeze({ id: 1, name: 'item one' }),
  Object.freeze({ id: 2, name: 'item two' }),
] as const);

/** 届いた要求（どちらの Origin か、method、path）。 */
export interface ListRowOpenerRequest {
  readonly origin: 'app' | 'api';
  readonly method: string;
  readonly path: string;
  /** CORS の事前確認か（OPTIONS と `access-control-request-method`）。 */
  readonly preflight: boolean;
}

export interface ListRowOpenerSite {
  readonly appOrigin: string;
  readonly apiOrigin: string;
  /** 届いた要求（届いた順）。 */
  readonly requests: readonly ListRowOpenerRequest[];
  close(): Promise<void>;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (character) => `&#${String(character.codePointAt(0))};`);

const listPageOf = (apiOrigin: string): string => {
  const E = LIST_ROW_OPENER_ELEMENTS;
  const rows = LIST_ROW_OPENER_ITEMS.map(({ id, name }) => `<tr data-id="${String(id)}"><td>${String(id)}</td><td>${escapeHtml(name)}</td>`
    + `<td><button type="button" class="item-edit">${E.editText}</button> <button type="button" class="item-remove">${E.removeText}</button></td></tr>`)
    .join('');
  const config = JSON.stringify({ api: apiOrigin, paths: LIST_ROW_OPENER_PATHS, elements: E, items: LIST_ROW_OPENER_ITEMS });
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>items</title></head><body><main><h1>一覧</h1>'
    + `<table id="${E.table}"><thead><tr><th>番号</th><th>名前</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`
    + `<dialog id="${E.dialog}"><h2>編集</h2><label>名前 <input id="${E.nameField}" type="text"></label>`
    + `<button id="${E.saveButton}" type="button">${E.saveText}</button></dialog></main>`
    + `<script>(() => {
  const C = ${config};
  const byId = (id) => document.getElementById(id);
  const dialog = byId(C.elements.dialog);
  let editing = null;
  const send = (method, path, body) => fetch(C.api + path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => undefined);
  for (const row of document.querySelectorAll('#' + C.elements.table + ' tbody tr')) {
    const id = Number(row.dataset.id);
    const item = C.items.find((candidate) => candidate.id === id);
    row.querySelector('.item-edit').addEventListener('click', () => {
      editing = id;
      byId(C.elements.nameField).value = item ? item.name : '';
      dialog.showModal();
      void send('POST', C.paths.drafts, { item_id: id });
    });
    row.querySelector('.item-remove').addEventListener('click', () => { void send('DELETE', C.paths.items + '?id=eq.' + String(id)); });
  }
  byId(C.elements.saveButton).addEventListener('click', () => {
    void send('PATCH', C.paths.items + '?id=eq.' + String(editing), { name: byId(C.elements.nameField).value }).finally(() => dialog.close());
  });
})();</script></body></html>`;
};

const listen = (server: Server): Promise<string> => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('the fixture server has no port'));
      return;
    }
    resolve(`http://127.0.0.1:${String(address.port)}`);
  });
});

const closeServer = (server: Server): Promise<void> => new Promise((resolve) => {
  server.closeAllConnections();
  server.close(() => resolve());
});

/** 仮のサイトを 127.0.0.1 で始める（アプリと API の 2 つのポート）。 */
export async function startListRowOpenerSite(): Promise<ListRowOpenerSite> {
  const requests: ListRowOpenerRequest[] = [];
  const record = (origin: ListRowOpenerRequest['origin'], request: IncomingMessage): string => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    requests.push({ origin, method, path, preflight: method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined });
    return path;
  };
  let apiOrigin = '';
  const app = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = record('app', request);
    if (request.method === 'GET' && path === LIST_ROW_OPENER_PATHS.list) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(listPageOf(apiOrigin));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  let appOrigin = '';
  const api = createServer((request: IncomingMessage, response: ServerResponse) => {
    record('api', request);
    const cors = {
      'access-control-allow-origin': appOrigin,
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
      'access-control-allow-headers': 'content-type',
    };
    request.resume();
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    response.writeHead(200, { ...cors, 'content-type': 'application/json' });
    response.end('{}');
  });
  appOrigin = await listen(app);
  apiOrigin = await listen(api);
  return {
    appOrigin,
    apiOrigin,
    requests,
    close: async () => {
      await Promise.all([closeServer(app), closeServer(api)]);
    },
  };
}
