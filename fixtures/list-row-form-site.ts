/**
 * LU-11（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 3 章の B、4.0 の D5、5.4 の 4）: 一覧の行の「編集」を押すと、行の下に入力の欄が
 * 広がる形（形 B）の、仮のサイト。名前は一般の名前（`items`）だけを使う。このファイルは、ほかのファイルを import しない（`node:http` のほか）。
 *
 * - 一覧の画面 `LIST_ROW_FORM_PATHS.list`: 検索の form（GET）と、表。行ごとに「編集」と「削除」のボタン（`type="button"`）と、隠れたフォーム
 *   （`POST LIST_ROW_FORM_PATHS.list/<番号>`。題名・メールの欄と「保存」）。「編集」はフォームを見せる（送らない）。「削除」は何もしない。
 *   - 作り `IN_ROW`: フォームは「編集」と同じ `tr` の中。
 *   - 作り `ROW_BELOW`: フォームは「編集」の `tr` のすぐ下の、隠れた `tr` の中。
 * - 登録の画面 `LIST_ROW_FORM_PATHS.create`: 登録の form（`POST LIST_ROW_FORM_PATHS.list`。題名とメールは必須。メールは仮の値 `example.invalid` だけを使う前提）。
 * - POST は記録し、一覧の画面へ 303 で戻す（どのテストも送らないことを確かめるだけ）。届いた要求はすべて `requests` に記録する。
 * - LU-12b（設計書 5.5、8 章の「書き込みのジョブ」）: 書き込みの段の場面（`setWriteScene`。省けば、上の作りのまま変わらない）。場面では、一覧の行は場面の行
 *   （番号・題名・メール。メールも表の列に出し、行のフォームの欄に今の値を入れる）で、`POST LIST_ROW_FORM_PATHS.list/<番号>` の本文（urlencoded）で、その行の
 *   題名とメールを書き換える（照合の一覧に新しい値が出る）。場面で選べること:
 *   - 開き手（`opener`）: `NAMED`（「編集」の文字）・`UNNAMED`（名前のないアイコンだけ）・`NONE`（開き手がない）。
 *   - 対象の行のフォーム（`targetForms`）: `ONE`（今のまま）・`NONE`（対象の行にフォームがない）・`TWO`（対象の行に同じ送信先のフォームが 2 つ）。
 *   - 開き手を押した時にページが続けて送る要求（`openerSends`。`fetch`。path の `{id}` はその行の番号）。
 *   - LU-SFIX4（LU-REV の I-1・I-1b・I-2）: サーバが行の番号への POST を受けても状態を変えない（`ignorePost`。303 は返す）、一覧の画面の URL の `?q=` の値を
 *     対象の行の題名に描く（`echoQuery`）、開き手を押した後に、その行のフォームの送信ボタンの文字を変える（`relabelSubmitOnOpen`）、欄に値が入った時に変える
 *     （`relabelSubmitOnInput`）。
 *   - LU-SFIX5（LU-SREV4 の Important-1・Minor-1）: 一覧の画面のスクリプトが、最初に開かれた時刻を localStorage か HttpOnly でない `document.cookie` に記録し、
 *     `LIST_ROW_FORM_TIME_GATE_MS` より後に開かれたときだけ `?q=` の値を対象の行に描く（`timeGatedEcho`）。送信ボタンを押し始めた時（`pointerdown`）に文字を変える
 *     （`relabelSubmitOnPointerDown`）。登録の POST（`POST LIST_ROW_FORM_PATHS.list`）は、`createRecordId` があれば行を足して（`ignorePost` なら足さずに）
 *     `LIST_ROW_FORM_PATHS.list/<番号>` へ 303 で移し、その画面は 200 で返す。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 画面の path。 */
export const LIST_ROW_FORM_PATHS = Object.freeze({
  list: '/items',
  create: '/items/new',
} as const);

/** フォームの置き場所の作り。 */
export const LIST_ROW_FORM_LAYOUTS = Object.freeze(['IN_ROW', 'ROW_BELOW'] as const);
export type ListRowFormLayout = (typeof LIST_ROW_FORM_LAYOUTS)[number];

/** 画面の要素の ID と、ボタンの文言と、欄の名前。 */
export const LIST_ROW_FORM_ELEMENTS = Object.freeze({
  table: 'item-list',
  editText: '編集',
  removeText: '削除',
  saveText: '保存',
  createText: '登録',
  searchText: '検索',
  titleField: 'title',
  emailField: 'email',
  searchField: 'q',
} as const);

/** 一覧の行（番号と題名）。 */
export const LIST_ROW_FORM_ITEMS = Object.freeze([
  Object.freeze({ id: 1, title: 'item one' }),
  Object.freeze({ id: 2, title: 'item two' }),
  Object.freeze({ id: 3, title: 'item three' }),
  Object.freeze({ id: 4, title: 'item four' }),
] as const);

/** LU-SFIX5: 時刻で区切って描く場面の、最初に開かれてから描き始めるまでの時間（ms）。 */
export const LIST_ROW_FORM_TIME_GATE_MS = 1_500;

/** LU-SFIX5: 時刻で区切って描く場面の、時刻の置き場所。 */
export const LIST_ROW_FORM_TIME_GATE_STORES = Object.freeze(['LOCAL_STORAGE', 'COOKIE'] as const);
export type ListRowFormTimeGateStore = (typeof LIST_ROW_FORM_TIME_GATE_STORES)[number];

/** LU-12b: 書き込みの段の場面の行（番号・題名・メール）。 */
export interface ListRowFormWriteItem {
  readonly id: number;
  readonly title: string;
  readonly email: string;
}

/** LU-12b: 書き込みの段の場面の開き手の形と、対象の行のフォームの数。 */
export const LIST_ROW_FORM_WRITE_OPENERS = Object.freeze(['NAMED', 'UNNAMED', 'NONE'] as const);
export type ListRowFormWriteOpener = (typeof LIST_ROW_FORM_WRITE_OPENERS)[number];
export const LIST_ROW_FORM_WRITE_TARGET_FORMS = Object.freeze(['ONE', 'NONE', 'TWO'] as const);
export type ListRowFormWriteTargetForms = (typeof LIST_ROW_FORM_WRITE_TARGET_FORMS)[number];

/** LU-12b: 開き手を押した時にページが送る要求（path の `{id}` は、押した行の番号）。 */
export interface ListRowFormOpenerSend {
  readonly method: string;
  readonly path: string;
}

/** LU-12b: 書き込みの段の場面。 */
export interface ListRowFormWriteScene {
  readonly items: readonly ListRowFormWriteItem[];
  /** 更新の対象の行の番号（`targetForms` を当てる行）。 */
  readonly targetId: number;
  readonly opener?: ListRowFormWriteOpener;
  readonly targetForms?: ListRowFormWriteTargetForms;
  readonly openerSends?: readonly ListRowFormOpenerSend[];
  /** LU-SFIX4: 行の番号への POST を受けても状態を変えない（303 は返す）。 */
  readonly ignorePost?: boolean;
  /** LU-SFIX4: 一覧の画面の URL の `?q=` の値を、対象の行の題名に描く（サーバの状態は変えない）。 */
  readonly echoQuery?: boolean;
  /** LU-SFIX4: 開き手を押した後に、その行のフォームの送信ボタンの文字をこの文字に変える。 */
  readonly relabelSubmitOnOpen?: string;
  /** LU-SFIX4: 行のフォームの欄に値が入った時（`input` の事象）に、そのフォームの送信ボタンの文字をこの文字に変える（押す時点の確かめの場面）。 */
  readonly relabelSubmitOnInput?: string;
  /** LU-SFIX5: 一覧の画面が最初に開かれた時刻をこの置き場所に記録し、`LIST_ROW_FORM_TIME_GATE_MS` より後だけ `?q=` の値を対象の行に描く。 */
  readonly timeGatedEcho?: ListRowFormTimeGateStore;
  /** LU-SFIX5: 送信ボタンを押し始めた時（送信ボタンの `pointerdown`）に、その文字をこの文字に変える。 */
  readonly relabelSubmitOnPointerDown?: string;
  /** LU-SFIX5: 登録の POST で足す行の番号（省けば、今のとおり一覧の画面へ戻すだけ）。 */
  readonly createRecordId?: number;
}

/** 届いた要求（method と path）。 */
export interface ListRowFormRequest {
  readonly method: string;
  readonly path: string;
}

export interface ListRowFormSite {
  readonly origin: string;
  /** 届いた要求（届いた順）。 */
  readonly requests: readonly ListRowFormRequest[];
  /** LU-12b: 書き込みの段の場面を選ぶ（null で今の作りに戻す）。 */
  setWriteScene(scene: ListRowFormWriteScene | null): void;
  /** LU-12b: 書き込みの段の場面の、今の行（POST で書き換えた後の値）。場面がなければ空。 */
  writeItems(): readonly ListRowFormWriteItem[];
  close(): Promise<void>;
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (character) => `&#${String(character.codePointAt(0))};`);

/** 行のフォーム（隠れている）。 */
const rowFormOf = (id: number, title: string): string => {
  const E = LIST_ROW_FORM_ELEMENTS;
  return `<form class="item-form" method="post" action="${LIST_ROW_FORM_PATHS.list}/${String(id)}" hidden>`
    + `<label>題名 <input name="${E.titleField}" type="text" value="${escapeHtml(title)}"></label>`
    + `<label>メール <input name="${E.emailField}" type="email"></label>`
    + `<button type="submit">${E.saveText}</button></form>`;
};

const buttonsOf = (): string => {
  const E = LIST_ROW_FORM_ELEMENTS;
  return `<button type="button" class="item-edit">${E.editText}</button> <button type="button" class="item-remove">${E.removeText}</button>`;
};

const rowsOf = (layout: ListRowFormLayout): string => LIST_ROW_FORM_ITEMS.map(({ id, title }) => (layout === 'IN_ROW'
  ? `<tr><td>${escapeHtml(title)}</td><td>${buttonsOf()}${rowFormOf(id, title)}</td></tr>`
  : `<tr><td>${escapeHtml(title)}</td><td>${buttonsOf()}</td></tr><tr class="item-form-row" hidden><td colspan="2">${rowFormOf(id, title)}</td></tr>`))
  .join('');

/** LU-12b: 書き込みの段の場面の行のフォーム（隠れている。欄に今の値を入れる）。 */
const writeRowFormOf = ({ id, title, email }: ListRowFormWriteItem): string => {
  const E = LIST_ROW_FORM_ELEMENTS;
  return `<form class="item-form" method="post" action="${LIST_ROW_FORM_PATHS.list}/${String(id)}" hidden>`
    + `<label>題名 <input name="${E.titleField}" type="text" value="${escapeHtml(title)}"></label>`
    + `<label>メール <input name="${E.emailField}" type="email" value="${escapeHtml(email)}"></label>`
    + `<button type="submit">${E.saveText}</button></form>`;
};

/** LU-12b: 書き込みの段の場面の一覧の画面。 */
const writeListPageOf = (layout: ListRowFormLayout, scene: ListRowFormWriteScene, items: readonly ListRowFormWriteItem[]): string => {
  const E = LIST_ROW_FORM_ELEMENTS;
  const opener = scene.opener ?? 'NAMED';
  const openerHtml = opener === 'NAMED'
    ? `<button type="button" class="item-edit">${E.editText}</button> `
    : opener === 'UNNAMED'
      ? '<button type="button" class="item-edit"><svg width="12" height="12" aria-hidden="true"><rect width="12" height="12"></rect></svg></button> '
      : '';
  const formsOf = (item: ListRowFormWriteItem): string => {
    if (item.id !== scene.targetId) {
      return writeRowFormOf(item);
    }
    const forms = scene.targetForms ?? 'ONE';
    return forms === 'NONE' ? '' : forms === 'TWO' ? `${writeRowFormOf(item)}${writeRowFormOf(item)}` : writeRowFormOf(item);
  };
  const cellsOf = (item: ListRowFormWriteItem): string => `<td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.email)}</td>`;
  const buttons = `${openerHtml}<button type="button" class="item-remove">${E.removeText}</button>`;
  const rows = items.map((item) => (layout === 'IN_ROW'
    ? `<tr data-id="${String(item.id)}">${cellsOf(item)}<td>${buttons}${formsOf(item)}</td></tr>`
    : `<tr data-id="${String(item.id)}">${cellsOf(item)}<td>${buttons}</td></tr><tr class="item-form-row" hidden><td colspan="3">${formsOf(item)}</td></tr>`))
    .join('');
  const config = JSON.stringify({
    sends: scene.openerSends ?? [], echoQuery: scene.echoQuery === true, targetId: String(scene.targetId), relabel: scene.relabelSubmitOnOpen ?? null,
    relabelOnInput: scene.relabelSubmitOnInput ?? null,
    timeGate: scene.timeGatedEcho ?? null, timeGateMs: LIST_ROW_FORM_TIME_GATE_MS, relabelOnPointerDown: scene.relabelSubmitOnPointerDown ?? null,
  }).split('<').join('\\u003c');
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>items</title></head><body><main><h1>一覧</h1>'
    + `<form method="get" action="${LIST_ROW_FORM_PATHS.list}"><label>検索 <input name="${E.searchField}" type="search"></label>`
    + `<button type="submit">${E.searchText}</button></form>`
    + `<table id="${E.table}"><thead><tr><th>題名</th><th>メール</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></main>`
    + `<script>(() => {
  const config = ${config};
  const query = new URLSearchParams(location.search).get('${E.searchField}');
  if (config.echoQuery && query) {
    const target = document.querySelector('tr[data-id="' + config.targetId + '"]');
    if (target !== null) { target.children[0].textContent = query; }
  }
  if (config.timeGate !== null) {
    let first = 0;
    try {
      if (config.timeGate === 'LOCAL_STORAGE') {
        first = Number(localStorage.getItem('first-open') || '0');
        if (!first) { localStorage.setItem('first-open', String(Date.now())); }
      } else {
        const found = document.cookie.split('; ').find((entry) => entry.startsWith('first-open='));
        first = found ? Number(found.slice('first-open='.length)) : 0;
        if (!first) { document.cookie = 'first-open=' + String(Date.now()) + '; path=/; max-age=600'; }
      }
    } catch (error) { first = 0; }
    const target = document.querySelector('tr[data-id="' + config.targetId + '"]');
    if (first && Date.now() - first > config.timeGateMs && query && target !== null) { target.children[0].textContent = query + ' old'; }
  }
  if (config.relabelOnPointerDown !== null) {
    // 送信ボタンそのものに付ける（document に付けると、検索の form が委譲の結び付きになり、送る前の READ を読めなくなるため）。
    for (const submit of document.querySelectorAll('.item-form button[type=submit]')) {
      submit.addEventListener('pointerdown', () => { submit.textContent = config.relabelOnPointerDown; });
    }
  }
  if (config.relabelOnInput !== null) {
    for (const form of document.querySelectorAll('.item-form')) {
      form.addEventListener('input', () => {
        for (const submit of form.querySelectorAll('button[type=submit]')) { submit.textContent = config.relabelOnInput; }
      });
    }
  }
  for (const button of document.querySelectorAll('.item-edit')) {
    button.addEventListener('click', () => {
      const row = button.closest('tr');
      const id = row.getAttribute('data-id');
      for (const send of config.sends) { void fetch(send.path.split('{id}').join(id), { method: send.method }).catch(() => undefined); }
      if (config.relabel !== null) {
        setTimeout(() => {
          const scope = [row, row.nextElementSibling].filter((element) => element !== null);
          for (const element of scope) { for (const submit of element.querySelectorAll('.item-form button[type=submit]')) { submit.textContent = config.relabel; } }
        }, 0);
      }
      const forms = row.querySelectorAll('.item-form');
      if (forms.length > 0) { for (const form of forms) { form.hidden = false; } return; }
      const below = row.nextElementSibling;
      if (below === null || !below.classList.contains('item-form-row')) { return; }
      below.hidden = false;
      for (const form of below.querySelectorAll('.item-form')) { form.hidden = false; }
    });
  }
  for (const button of document.querySelectorAll('.item-remove')) {
    button.addEventListener('click', () => undefined);
  }
})();</script></body></html>`;
};

const listPageOf = (layout: ListRowFormLayout): string => {
  const E = LIST_ROW_FORM_ELEMENTS;
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>items</title></head><body><main><h1>一覧</h1>'
    + `<form method="get" action="${LIST_ROW_FORM_PATHS.list}"><label>検索 <input name="${E.searchField}" type="search"></label>`
    + `<button type="submit">${E.searchText}</button></form>`
    + `<table id="${E.table}"><thead><tr><th>題名</th><th>操作</th></tr></thead><tbody>${rowsOf(layout)}</tbody></table></main>`
    + `<script>(() => {
  for (const button of document.querySelectorAll('.item-edit')) {
    button.addEventListener('click', () => {
      const row = button.closest('tr');
      const form = row.querySelector('.item-form');
      if (form !== null) { form.hidden = false; return; }
      const below = row.nextElementSibling;
      below.hidden = false;
      below.querySelector('.item-form').hidden = false;
    });
  }
  for (const button of document.querySelectorAll('.item-remove')) {
    button.addEventListener('click', () => undefined);
  }
})();</script></body></html>`;
};

const createPageOf = (): string => {
  const E = LIST_ROW_FORM_ELEMENTS;
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>new item</title></head><body><main><h1>登録</h1>'
    + `<form method="post" action="${LIST_ROW_FORM_PATHS.list}"><label>題名 <input name="${E.titleField}" type="text" required></label>`
    + `<label>メール <input name="${E.emailField}" type="email" required></label><button type="submit">${E.createText}</button></form></main></body></html>`;
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

/** 仮のサイトを 127.0.0.1 で始める（フォームの置き場所の作りを選ぶ）。 */
export async function startListRowFormSite(layout: ListRowFormLayout): Promise<ListRowFormSite> {
  const requests: ListRowFormRequest[] = [];
  let scene: ListRowFormWriteScene | null = null;
  let items: ListRowFormWriteItem[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    requests.push({ method, path });
    // LU-12b: 書き込みの段の場面の、行の番号への POST は、本文で題名とメールを書き換えてから一覧の画面へ戻す。
    const target = scene === null || method !== 'POST' ? undefined : items.find(({ id }) => path === `${LIST_ROW_FORM_PATHS.list}/${String(id)}`);
    const applies = scene?.ignorePost !== true;
    if (target !== undefined) {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const E = LIST_ROW_FORM_ELEMENTS;
        items = !applies ? items : items.map((item) => (item.id === target.id
          ? { id: item.id, title: body.get(E.titleField) ?? item.title, email: body.get(E.emailField) ?? item.email }
          : item));
        response.writeHead(303, { location: LIST_ROW_FORM_PATHS.list });
        response.end();
      });
      return;
    }
    // LU-SFIX5: 登録の POST（場面の `createRecordId` があるときだけ）。行を足して（`ignorePost` なら足さずに）、足した行の番号の画面へ移す。
    const createId = scene?.createRecordId;
    if (scene !== null && createId !== undefined && method === 'POST' && path === LIST_ROW_FORM_PATHS.list) {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const E = LIST_ROW_FORM_ELEMENTS;
        if (scene?.ignorePost !== true) {
          items = [...items, { id: createId, title: body.get(E.titleField) ?? '', email: body.get(E.emailField) ?? '' }];
        }
        response.writeHead(303, { location: `${LIST_ROW_FORM_PATHS.list}/${String(createId)}` });
        response.end();
      });
      return;
    }
    request.resume();
    if (scene !== null && createId !== undefined && method === 'GET' && path === `${LIST_ROW_FORM_PATHS.list}/${String(createId)}`) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>item</title></head><body><main><h1>登録しました</h1></main></body></html>');
      return;
    }
    if (method === 'GET' && path === LIST_ROW_FORM_PATHS.list) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(scene === null ? listPageOf(layout) : writeListPageOf(layout, scene, items));
      return;
    }
    if (method === 'GET' && path === LIST_ROW_FORM_PATHS.create) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(createPageOf());
      return;
    }
    if (method === 'POST') {
      response.writeHead(303, { location: LIST_ROW_FORM_PATHS.list });
      response.end();
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  const origin = await listen(server);
  return {
    origin,
    requests,
    setWriteScene: (next) => {
      scene = next;
      items = next === null ? [] : next.items.map((item) => ({ ...item }));
    },
    writeItems: () => items.map((item) => ({ ...item })),
    close: () => closeServer(server),
  };
}
