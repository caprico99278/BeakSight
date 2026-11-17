/**
 * LU-4（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 3 章の A_FILTER・A_PATH・A_DRAFT、5.1 の 1〜3）: 一覧の行の「編集」から窓を開き、
 * 窓の中の「保存」で 1 行を更新する形の、仮のサイト。名前は一般の名前（`items`）だけを使う。このファイルは、ほかのファイルを import しない（`node:http` のほか）。
 *
 * - アプリの Origin（127.0.0.1）: 形ごとの一覧の画面（`LIST_ROW_UPDATE_PATHS.screens`）。3 行の一覧で、行ごとに「編集」と「削除」のボタンがある（行は HTML に書く）。
 *   - A_FILTER: 閉じた窓（`<dialog>`）が文書にある。「編集」で窓を開き、名前の欄に行の名前を入れる。「保存」は `PATCH /api/items?id=eq.<番号>`。
 *   - A_PATH: 文書に窓はない。「編集」を押すと、`role="dialog"`・`aria-modal="true"` の窓を文書に足す（React などの作り）。「保存」は `PATCH /api/items/<番号>`
 *     で、送れても送れなくても窓を文書から除く。
 *   - A_DRAFT: A_FILTER の窓に加えて、「編集」で窓を開くと、サイトが下書きを `POST /api/item_drafts` する。「保存」は `PATCH /api/items?id=eq.<番号>`。
 *   - 「削除」: どの形も `DELETE /api/items?id=eq.<番号>`。
 * - LU-SFIX1（LU-SREV1 の Minor-3・4）: 形の一覧（`LIST_ROW_UPDATE_SHAPES`）に入れない、A_PATH の窓の作りの変わり形の画面（`LIST_ROW_UPDATE_VARIANT_SCREENS`）。
 *   - `chain`: 窓の中の「保存」は何も送らず、続けて、何も送らない「更新」の窓を足す（窓が続けて開く形）。
 *   - `frame`: 窓の中に iframe（`srcdoc`）があり、「保存」は A_PATH と同じく `PATCH /api/items/<番号>`。
 * - API の Origin（127.0.0.1 の別のポート）: 届いた要求をすべて記録する（`requests`）。CORS の事前確認に答え、ほかは空の JSON を返す。
 * - LU-10（設計書 5.5、8 章の「書き込みのジョブ」）: 書き込みの段の場面の画面（`LIST_ROW_UPDATE_WRITE_SCREENS`。上の形の画面の振る舞いは変えない）。行は
 *   サーバの今の状態（`setWriteItems` で入れる。番号・行を選ぶ欄の値 `tag`・名前）から描き、窓には `tag`（保つ欄）と名前（変える欄）の 2 つの欄がある。
 *   「保存」は `{ tag, name }` を A_FILTER・A_DRAFT は `PATCH /api/items?id=eq.<番号>`、A_PATH は `PATCH /api/items/<番号>` で送り、API の Origin は届いた
 *   PATCH の本文で状態を書き換える（照合の一覧に新しい値が出る）。開き手の形（`setWriteOpener`）: `NAMED`（「編集」の文字）・`UNNAMED`（名前のないアイコン
 *   だけ）・`NONE`（開き手がない）。どの行にも「削除」がある（`DELETE /api/items?id=eq.<番号>`）。
 * - LU-SFIX2-A（LU-SREV2 の S5）: 書き込みの段の場面で、開き手を押したときにページが続けて送る要求（`setWriteOpenerSends`。既定は送らない）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 窓の形（設計書 3 章）。 */
export const LIST_ROW_UPDATE_SHAPES = Object.freeze(['A_FILTER', 'A_PATH', 'A_DRAFT'] as const);
export type ListRowUpdateShape = (typeof LIST_ROW_UPDATE_SHAPES)[number];

/** 画面と API の path。 */
export const LIST_ROW_UPDATE_PATHS = Object.freeze({
  screens: Object.freeze({ A_FILTER: '/items/filter', A_PATH: '/items/path', A_DRAFT: '/items/draft' } as const),
  items: '/api/items',
  drafts: '/api/item_drafts',
} as const);

/** LU-SFIX1: A_PATH の窓の作りの変わり形の画面の path（形の一覧には入れない）。 */
export const LIST_ROW_UPDATE_VARIANT_SCREENS = Object.freeze({ chain: '/items/chain', frame: '/items/frame' } as const);
export type ListRowUpdateVariant = keyof typeof LIST_ROW_UPDATE_VARIANT_SCREENS;

/** 画面の要素の ID と、ボタンの文言。 */
export const LIST_ROW_UPDATE_ELEMENTS = Object.freeze({
  table: 'item-list',
  dialog: 'item-edit-dialog',
  nameField: 'item-edit-name',
  saveButton: 'item-edit-save',
  editText: '編集',
  removeText: '削除',
  saveText: '保存',
  /** LU-SFIX1: `chain` の 2 つ目の窓のボタンの文言。 */
  nextText: '更新',
} as const);

/** 一覧の行（番号と名前）。 */
export const LIST_ROW_UPDATE_ITEMS = Object.freeze([
  Object.freeze({ id: 1, name: 'item one' }),
  Object.freeze({ id: 2, name: 'item two' }),
  Object.freeze({ id: 3, name: 'item three' }),
] as const);

/** 届いた要求（どちらの Origin か、method、path）。 */
export interface ListRowUpdateRequest {
  readonly origin: 'app' | 'api';
  readonly method: string;
  readonly path: string;
  /** CORS の事前確認か（OPTIONS と `access-control-request-method`）。 */
  readonly preflight: boolean;
}

/** LU-10: 書き込みの段の場面の画面の path（形ごと）。 */
export const LIST_ROW_UPDATE_WRITE_SCREENS = Object.freeze({ A_FILTER: '/items/write/filter', A_PATH: '/items/write/path', A_DRAFT: '/items/write/draft' } as const);

/** LU-10: 書き込みの段の場面の、窓の保つ欄（行を選ぶ欄）の要素の ID。 */
export const LIST_ROW_UPDATE_WRITE_TAG_FIELD = 'item-edit-tag';

/** LU-SFIX2-B: `localEcho` の場面で、ページの JS が窓の値を保存する localStorage の鍵。 */
export const LIST_ROW_UPDATE_LOCAL_ECHO_KEY = 'item_draft';

/** LU-10: 書き込みの段の場面の開き手の形。 */
export const LIST_ROW_UPDATE_WRITE_OPENERS = Object.freeze(['NAMED', 'UNNAMED', 'NONE'] as const);
export type ListRowUpdateWriteOpener = (typeof LIST_ROW_UPDATE_WRITE_OPENERS)[number];

/**
 * LU-SFIX2-A（LU-SREV2 の S5）: 書き込みの段の場面で、開き手を押したときにページが続けて送る要求（method と path。path の `LIST_ROW_UPDATE_OPENER_SEND_ID` は
 * 行の番号に置き換える。本文は `{ name: LIST_ROW_UPDATE_OPENER_SEND_NAME }`）。既定は送らない。
 */
export interface ListRowUpdateOpenerSend {
  readonly method: string;
  readonly path: string;
}
/** LU-SFIX2-A: 開き手の側の要求の path の中の、行の番号に置き換える印。 */
export const LIST_ROW_UPDATE_OPENER_SEND_ID = '{row}';
/** LU-SFIX2-A: 開き手の側の要求の本文の名前（届いて状態が変われば、一覧に出る）。 */
export const LIST_ROW_UPDATE_OPENER_SEND_NAME = 'opener-side-name';

/** LU-10: 書き込みの段の場面の行（番号、行を選ぶ欄の値、名前）。 */
export interface ListRowUpdateWriteItem {
  readonly id: number;
  readonly tag: string;
  readonly name: string;
}

export interface ListRowUpdateSite {
  readonly appOrigin: string;
  readonly apiOrigin: string;
  /** 届いた要求（届いた順）。 */
  readonly requests: readonly ListRowUpdateRequest[];
  /** LU-10: 書き込みの段の場面の行を入れ替える。 */
  setWriteItems(items: readonly ListRowUpdateWriteItem[]): void;
  /** LU-10: 書き込みの段の場面の今の行（届いた PATCH で書き換えた後）。 */
  writeItems(): readonly ListRowUpdateWriteItem[];
  /** LU-10: 書き込みの段の場面の開き手の形を決める（既定は `NAMED`）。 */
  setWriteOpener(opener: ListRowUpdateWriteOpener): void;
  /**
   * LU-SFIX2-B（LU-SREV2 の Important-1 の S7・S8）: 書き込みの段の場面の形を決める（既定はどちらも偽）。`localEcho` なら、ページの JS が窓の名前の欄の値を
   * 行の番号とともに localStorage に保存し、一覧を開くと保存した名前をその行に描く（LU-SFIX3-B: `cookieEcho` なら document.cookie に保存する）。`ignorePatch` なら、サーバは PATCH に 200 を返すが状態を変えない。
   * LU-SFIX5（LU-SREV4 の Important-1）: `timeGateMs` があれば、一覧の画面が最初に開かれた時刻を、保存と同じ置き場所（localStorage か document.cookie）に記録し、
   * その時間より後に開かれたときだけ保存した名前を描く。
   */
  setWriteScene(scene: { readonly localEcho: boolean; readonly ignorePatch: boolean; readonly cookieEcho?: boolean; readonly timeGateMs?: number }): void;
  /** LU-SFIX2-A（LU-SREV2 の S5）: 開き手を押したときにページが続けて送る要求を決める（既定は空）。 */
  setWriteOpenerSends(sends: readonly ListRowUpdateOpenerSend[]): void;
  close(): Promise<void>;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (character) => `&#${String(character.codePointAt(0))};`);

const listPageOf = (apiOrigin: string, shape: ListRowUpdateShape, variant: ListRowUpdateVariant | null = null): string => {
  const E = LIST_ROW_UPDATE_ELEMENTS;
  const rows = LIST_ROW_UPDATE_ITEMS.map(({ id, name }) => `<tr data-id="${String(id)}"><td>${String(id)}</td><td>${escapeHtml(name)}</td>`
    + `<td><button type="button" class="item-edit">${E.editText}</button> <button type="button" class="item-remove">${E.removeText}</button></td></tr>`)
    .join('');
  const staticDialog = shape === 'A_PATH'
    ? ''
    : `<dialog id="${E.dialog}"><h2>編集</h2><label>名前 <input id="${E.nameField}" type="text"></label>`
      + `<button id="${E.saveButton}" type="button">${E.saveText}</button></dialog>`;
  const config = JSON.stringify({ api: apiOrigin, shape, variant, paths: LIST_ROW_UPDATE_PATHS, elements: E, items: LIST_ROW_UPDATE_ITEMS });
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>items</title></head><body><main><h1>一覧</h1>'
    + `<table id="${E.table}"><thead><tr><th>番号</th><th>名前</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`
    + `${staticDialog}</main>`
    + `<script>(() => {
  const C = ${config};
  const byId = (id) => document.getElementById(id);
  const send = (method, path, body) => fetch(C.api + path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => undefined);
  const filterPathOf = (id) => C.paths.items + '?id=eq.' + String(id);
  let editing = null;
  if (C.shape !== 'A_PATH') {
    const dialog = byId(C.elements.dialog);
    byId(C.elements.saveButton).addEventListener('click', () => {
      void send('PATCH', filterPathOf(editing), { name: byId(C.elements.nameField).value }).finally(() => dialog.close());
    });
  }
  const openPathDialog = (item) => {
    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.id = C.elements.dialog;
    const heading = document.createElement('h2');
    heading.textContent = '編集';
    const label = document.createElement('label');
    label.textContent = '名前 ';
    const field = document.createElement('input');
    field.id = C.elements.nameField;
    field.type = 'text';
    field.value = item.name;
    label.append(field);
    const save = document.createElement('button');
    save.id = C.elements.saveButton;
    save.type = 'button';
    save.textContent = C.elements.saveText;
    if (C.variant === 'chain') {
      // LU-SFIX1: 何も送らず、続けて、何も送らない「更新」の窓を足す。
      save.addEventListener('click', () => {
        const next = document.createElement('div');
        next.setAttribute('role', 'dialog');
        next.setAttribute('aria-modal', 'true');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = C.elements.nextText;
        button.addEventListener('click', () => undefined);
        next.append(button);
        document.querySelector('main').append(next);
      });
    } else {
      save.addEventListener('click', () => {
        void send('PATCH', C.paths.items + '/' + String(item.id), { name: field.value }).finally(() => box.remove());
      });
    }
    box.append(heading, label, save);
    if (C.variant === 'frame') {
      // LU-SFIX1: 窓の中の別の文書（読み切れない）。
      const frame = document.createElement('iframe');
      frame.srcdoc = '<p>note</p>';
      box.append(frame);
    }
    document.querySelector('main').append(box);
  };
  for (const row of document.querySelectorAll('#' + C.elements.table + ' tbody tr')) {
    const id = Number(row.dataset.id);
    const item = C.items.find((candidate) => candidate.id === id);
    row.querySelector('.item-edit').addEventListener('click', () => {
      editing = id;
      if (C.shape === 'A_PATH') {
        if (byId(C.elements.dialog) === null) openPathDialog(item);
        return;
      }
      byId(C.elements.nameField).value = item ? item.name : '';
      byId(C.elements.dialog).showModal();
      if (C.shape === 'A_DRAFT') void send('POST', C.paths.drafts, { item_id: id });
    });
    row.querySelector('.item-remove').addEventListener('click', () => { void send('DELETE', filterPathOf(id)); });
  }
})();</script></body></html>`;
};

/** LU-10: 書き込みの段の場面の一覧の画面（行はサーバの今の状態。窓には保つ欄と名前の 2 つの欄）。 */
const writeListPageOf = (
  apiOrigin: string,
  shape: ListRowUpdateShape,
  opener: ListRowUpdateWriteOpener,
  items: readonly ListRowUpdateWriteItem[],
  localEcho = false,
  openerSends: readonly ListRowUpdateOpenerSend[] = [],
  cookieEcho = false,
  timeGateMs: number | null = null,
): string => {
  const E = LIST_ROW_UPDATE_ELEMENTS;
  const openerHtml = opener === 'NAMED'
    ? `<button type="button" class="item-edit">${E.editText}</button> `
    : opener === 'UNNAMED'
      ? '<button type="button" class="item-edit"><svg width="12" height="12" aria-hidden="true"><rect width="12" height="12"></rect></svg></button> '
      : '';
  const rows = items.map(({ id, tag, name }) => `<tr data-id="${String(id)}"><td>${String(id)}</td><td>${escapeHtml(tag)}</td><td>${escapeHtml(name)}</td>`
    + `<td>${openerHtml}<button type="button" class="item-remove">${E.removeText}</button></td></tr>`)
    .join('');
  const fieldsHtml = `<label>記号 <input id="${LIST_ROW_UPDATE_WRITE_TAG_FIELD}" type="text"></label><label>名前 <input id="${E.nameField}" type="text"></label>`;
  const staticDialog = shape === 'A_PATH'
    ? ''
    : `<dialog id="${E.dialog}"><h2>編集</h2>${fieldsHtml}<button id="${E.saveButton}" type="button">${E.saveText}</button></dialog>`;
  const config = JSON.stringify({
    api: apiOrigin, shape, paths: LIST_ROW_UPDATE_PATHS, elements: E, tagField: LIST_ROW_UPDATE_WRITE_TAG_FIELD, items, localEcho, cookieEcho, timeGateMs, echoKey: LIST_ROW_UPDATE_LOCAL_ECHO_KEY,
    openerSends, openerSendId: LIST_ROW_UPDATE_OPENER_SEND_ID, openerSendName: LIST_ROW_UPDATE_OPENER_SEND_NAME,
  });
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>items</title></head><body><main><h1>一覧</h1>'
    + `<table id="${E.table}"><thead><tr><th>番号</th><th>記号</th><th>名前</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`
    + `${staticDialog}</main>`
    + `<script>(() => {
  const C = ${config};
  const byId = (id) => document.getElementById(id);
  const send = (method, path, body) => fetch(C.api + path, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => undefined);
  const filterPathOf = (id) => C.paths.items + '?id=eq.' + String(id);
  let editing = null;
  if (C.localEcho || C.cookieEcho) {
    // LU-SFIX2-B: 窓の名前の欄の値を、行の番号とともに localStorage に保存し、一覧を開くと保存した名前をその行に描く（サーバの状態は見ない）。
    // LU-SFIX3-B（LU-SREV3 の Important-1 の S7c）: cookieEcho なら、localStorage の代わりに document.cookie に保存する（HttpOnly でない cookie）。
    const save = (text) => {
      if (C.cookieEcho) { document.cookie = C.echoKey + '=' + encodeURIComponent(text) + '; path=/; max-age=600'; return; }
      localStorage.setItem(C.echoKey, text);
    };
    const load = () => {
      if (!C.cookieEcho) return localStorage.getItem(C.echoKey);
      const hit = document.cookie.split('; ').find((part) => part.startsWith(C.echoKey + '='));
      return hit ? decodeURIComponent(hit.slice(C.echoKey.length + 1)) : null;
    };
    document.addEventListener('input', (ev) => {
      if (ev.target && ev.target.id === C.elements.nameField) {
        try { save(JSON.stringify({ id: editing, name: ev.target.value })); } catch (e) {}
      }
    }, true);
    // LU-SFIX5: 時刻で区切る場面は、最初に開かれた時刻を同じ置き場所に記録し、その時間より後だけ描く。
    let gateOpen = true;
    if (C.timeGateMs !== null) {
      const firstKey = C.echoKey + '_first';
      let first = 0;
      try {
        if (C.cookieEcho) {
          const hit = document.cookie.split('; ').find((part) => part.startsWith(firstKey + '='));
          first = hit ? Number(hit.slice(firstKey.length + 1)) : 0;
          if (!first) document.cookie = firstKey + '=' + String(Date.now()) + '; path=/; max-age=600';
        } else {
          first = Number(localStorage.getItem(firstKey) || '0');
          if (!first) localStorage.setItem(firstKey, String(Date.now()));
        }
      } catch (e) { first = 0; }
      gateOpen = first > 0 && Date.now() - first > C.timeGateMs;
    }
    try {
      const saved = JSON.parse(load() || 'null');
      const row = saved && document.querySelector('#' + C.elements.table + ' tbody tr[data-id="' + String(saved.id) + '"]');
      if (row && gateOpen) row.children[2].textContent = saved.name;
    } catch (e) {}
  }
  if (C.shape !== 'A_PATH') {
    const dialog = byId(C.elements.dialog);
    byId(C.elements.saveButton).addEventListener('click', () => {
      void send('PATCH', filterPathOf(editing), { tag: byId(C.tagField).value, name: byId(C.elements.nameField).value }).finally(() => dialog.close());
    });
  }
  const openPathDialog = (item) => {
    const box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.id = C.elements.dialog;
    const heading = document.createElement('h2');
    heading.textContent = '編集';
    const field = (id, label, value) => {
      const wrapper = document.createElement('label');
      wrapper.textContent = label + ' ';
      const input = document.createElement('input');
      input.id = id;
      input.type = 'text';
      input.value = value;
      wrapper.append(input);
      return { wrapper, input };
    };
    const tag = field(C.tagField, '記号', item.tag);
    const name = field(C.elements.nameField, '名前', item.name);
    const save = document.createElement('button');
    save.id = C.elements.saveButton;
    save.type = 'button';
    save.textContent = C.elements.saveText;
    save.addEventListener('click', () => {
      void send('PATCH', C.paths.items + '/' + String(item.id), { tag: tag.input.value, name: name.input.value }).finally(() => box.remove());
    });
    box.append(heading, tag.wrapper, name.wrapper, save);
    document.querySelector('main').append(box);
  };
  for (const row of document.querySelectorAll('#' + C.elements.table + ' tbody tr')) {
    const id = Number(row.dataset.id);
    const item = C.items.find((candidate) => candidate.id === id);
    const edit = row.querySelector('.item-edit');
    if (edit !== null) {
      edit.addEventListener('click', () => {
        editing = id;
        for (const extra of C.openerSends) void send(extra.method, extra.path.split(C.openerSendId).join(String(id)), { name: C.openerSendName });
        if (C.shape === 'A_PATH') {
          if (byId(C.elements.dialog) === null) openPathDialog(item);
          return;
        }
        byId(C.tagField).value = item ? item.tag : '';
        byId(C.elements.nameField).value = item ? item.name : '';
        byId(C.elements.dialog).showModal();
        if (C.shape === 'A_DRAFT') void send('POST', C.paths.drafts, { item_id: id });
      });
    }
    row.querySelector('.item-remove').addEventListener('click', () => { void send('DELETE', filterPathOf(id)); });
  }
})();</script></body></html>`;
};

/** LU-10: PATCH の送信先から、行の番号（filter の `id=eq.<番号>` か、path の最後の番号。どちらでもなければ null）。 */
const writeItemIdOf = (url: URL): number | null => {
  const filter = url.searchParams.get('id');
  const text = url.pathname === LIST_ROW_UPDATE_PATHS.items && filter !== null && filter.startsWith('eq.')
    ? filter.slice('eq.'.length)
    : url.pathname.startsWith(`${LIST_ROW_UPDATE_PATHS.items}/`) ? url.pathname.slice(LIST_ROW_UPDATE_PATHS.items.length + 1) : null;
  return text !== null && /^[0-9]+$/u.test(text) ? Number(text) : null;
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

/** 画面の path から、窓の形（一覧の画面でなければ null）。 */
const shapeOfScreen = (path: string): ListRowUpdateShape | null =>
  LIST_ROW_UPDATE_SHAPES.find((shape) => LIST_ROW_UPDATE_PATHS.screens[shape] === path) ?? null;

/** LU-SFIX1: 画面の path から、変わり形（変わり形の画面でなければ null）。 */
const variantOfScreen = (path: string): ListRowUpdateVariant | null =>
  (Object.keys(LIST_ROW_UPDATE_VARIANT_SCREENS) as ListRowUpdateVariant[]).find((variant) => LIST_ROW_UPDATE_VARIANT_SCREENS[variant] === path) ?? null;

/** 仮のサイトを 127.0.0.1 で始める（アプリと API の 2 つのポート）。 */
export async function startListRowUpdateSite(): Promise<ListRowUpdateSite> {
  const requests: ListRowUpdateRequest[] = [];
  const record = (origin: ListRowUpdateRequest['origin'], request: IncomingMessage): string => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    requests.push({ origin, method, path, preflight: method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined });
    return path;
  };
  let apiOrigin = '';
  // LU-10: 書き込みの段の場面の状態（行と開き手の形）。
  let writeItems: ListRowUpdateWriteItem[] = [];
  let writeOpener: ListRowUpdateWriteOpener = 'NAMED';
  // LU-SFIX2-B: 書き込みの段の場面の形（ページの localStorage の保存と、サーバが PATCH で状態を変えないか）。
  let writeScene: { localEcho: boolean; ignorePatch: boolean; cookieEcho: boolean; timeGateMs: number | null } = {
    localEcho: false, ignorePatch: false, cookieEcho: false, timeGateMs: null,
  };
  // LU-SFIX2-A: 開き手を押したときにページが続けて送る要求。
  let writeOpenerSends: readonly ListRowUpdateOpenerSend[] = [];
  const app = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = record('app', request);
    const writeShape = LIST_ROW_UPDATE_SHAPES.find((candidate) => LIST_ROW_UPDATE_WRITE_SCREENS[candidate] === path) ?? null;
    if (request.method === 'GET' && writeShape !== null) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(writeListPageOf(apiOrigin, writeShape, writeOpener, writeItems, writeScene.localEcho, writeOpenerSends, writeScene.cookieEcho, writeScene.timeGateMs));
      return;
    }
    const shape = shapeOfScreen(path);
    const variant = variantOfScreen(path);
    if (request.method === 'GET' && (shape !== null || variant !== null)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(listPageOf(apiOrigin, shape ?? 'A_PATH', variant));
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
    if (request.method === 'OPTIONS') {
      request.resume();
      response.writeHead(204, cors);
      response.end();
      return;
    }
    // LU-10: 書き込みの段の場面の行への PATCH は、本文の `tag`・`name` で状態を書き換える（ほかの要求と、ほかの行は今のまま。応答は空の JSON）。
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const id = request.method === 'PATCH' && !writeScene.ignorePatch ? writeItemIdOf(new URL(request.url ?? '/', 'http://127.0.0.1')) : null;
      const index = id === null ? -1 : writeItems.findIndex((item) => item.id === id);
      const current = writeItems[index];
      if (current !== undefined) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { readonly tag?: unknown; readonly name?: unknown };
          writeItems[index] = {
            id: current.id,
            tag: typeof body.tag === 'string' ? body.tag : current.tag,
            name: typeof body.name === 'string' ? body.name : current.name,
          };
        } catch {
          // 読めない本文は、状態を変えない。
        }
      }
      response.writeHead(200, { ...cors, 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  appOrigin = await listen(app);
  apiOrigin = await listen(api);
  return {
    appOrigin,
    apiOrigin,
    requests,
    setWriteItems: (items) => {
      writeItems = items.map((item) => ({ ...item }));
    },
    writeItems: () => writeItems.map((item) => ({ ...item })),
    setWriteScene: (scene) => {
      writeScene = { localEcho: scene.localEcho, ignorePatch: scene.ignorePatch, cookieEcho: scene.cookieEcho === true, timeGateMs: scene.timeGateMs ?? null };
    },
    setWriteOpenerSends: (sends) => {
      writeOpenerSends = sends.map((entry) => ({ method: entry.method, path: entry.path }));
    },
    setWriteOpener: (opener) => {
      writeOpener = opener;
    },
    close: async () => {
      await Promise.all([closeServer(app), closeServer(api)]);
    },
  };
}
