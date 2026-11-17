/**
 * LU-3（設計書 `doc/design/2026-11-02-beaksight-list-row-update-design.md` 5.5 の 2・3）: 作った行を一覧から探す読み取りと、行の中の開き手を押す部品を
 * 確かめる、仮の一覧の画面。名前は一般の名前（`rows`・`items`）だけを使う。このファイルは、ほかのファイルを import しない（`node:http` のほか）。
 *
 * - `LIST_ROW_PRESS_PATHS.table`: 表（`tbody tr`）の一覧。`main` の中の `nav` にも同じ値の一覧がある（数えない）。値を含む行が 0・1・2 の値がある。
 * - `LIST_ROW_PRESS_PATHS.list`: `ul li` の一覧。同じく `nav` の中にも同じ値がある。
 * - `LIST_ROW_PRESS_PATHS.openers`: 表の行ごとに、形の違う開き手がある（文字・`aria-label`・`title`・名前のないアイコン・同じ開き手が 2 つ・削除だけ）。
 *   開き手を押すと、文字の開き手は `<dialog>` を開き（`showModal`）、ほかは `role="dialog"` の窓を出す。どの行にも「削除」のボタンがあり、押すとページの
 *   数（`window.__listRowPressRemoved`）を増やす（テストが、押していないことを確かめる）。
 * - `LIST_ROW_PRESS_PATHS.swapping`（LU-SFIX2-A。LU-SREV2 の Critical-1 の再現）: 表の 1 行（値 `LIST_ROW_PRESS_OPENER_ROWS.swapping`）の「編集」を、名前のない
 *   アイコンのボタンと、タイマーで入れ替え続ける（本物 `LIST_ROW_PRESS_SWAP_MS.real`、偽物 `LIST_ROW_PRESS_SWAP_MS.fake`）。偽物を押すと
 *   `POST LIST_ROW_PRESS_PATHS.purge` を送る（サーバが数える）。本物を押すと窓を出し、`window.__listRowPressOpened` を増やす。query に `still=1` があれば
 *   入れ替えない（本物の開き手の識別の digest を読むため。画面の path は同じ）。
 * - `LIST_ROW_PRESS_PATHS.rewriting`（LU-SFIX3-A。LU-SREV3 の Critical-1 の再現）: 表の 1 行（値 `LIST_ROW_PRESS_OPENER_ROWS.rewriting`）の「編集」を、同じ要素の
 *   まま、名前のあるときと、名前のないアイコンだけのときとで、タイマーで書き換え続ける。query の `mode` は `content`（中身を「編集」とアイコンで書き換える）か
 *   `attr`（中身はアイコンのまま、`aria-label` の「編集」を付け外しする）、`ms` は書き換えの間隔（ms。`frame` なら `requestAnimationFrame` ごと）。名前のない
 *   ときに押されると、`POST LIST_ROW_PRESS_PATHS.purge` を送る（サーバが数える）。名前のあるときに押されると、窓を出し `window.__listRowPressOpened` を増やす。
 *   `still=1` があれば書き換えない（名前のあるときのまま）。
 * - `LIST_ROW_PRESS_PATHS.boundary`（LU-SFIX2-A。LU-SREV2 の Minor-3）: 区切りのある一致を確かめる表と一覧。値を部分に含むだけのセル（前後に文字・数字・
 *   `_`・`-`・`.`・`@` が続く）と、値と同じセル・区切りで値が現れるセルがある（`LIST_ROW_PRESS_BOUNDARY_VALUES`）。
 * サーバは要求を受けるだけで、何も送らない。127.0.0.1 だけで待つ。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 画面の path。 */
export const LIST_ROW_PRESS_PATHS = Object.freeze({
  table: '/rows/table',
  list: '/rows/list',
  openers: '/rows/openers',
  swapping: '/rows/swapping',
  boundary: '/rows/boundary',
  rewriting: '/rows/rewriting',
  /** 入れ替える偽物のボタンが送る先（POST。サーバは数えるだけ）。 */
  purge: '/rows/purge',
} as const);

/** LU-SFIX2-A: 入れ替えの時間（ms。本物を見せる時間と、偽物を見せる時間。LU-SREV2 の再現と同じ）。 */
export const LIST_ROW_PRESS_SWAP_MS = Object.freeze({ real: 4, fake: 70 } as const);

/** LU-SFIX3-A: 書き換えの画面の形（`mode`）と、`requestAnimationFrame` ごとに書き換える `ms` の値。 */
export const LIST_ROW_PRESS_REWRITE_MODES = Object.freeze(['content', 'attr'] as const);
export type ListRowPressRewriteMode = (typeof LIST_ROW_PRESS_REWRITE_MODES)[number];
export const LIST_ROW_PRESS_REWRITE_EVERY_FRAME = 'frame';

/** LU-SFIX2-A: 入れ替えを止める query。 */
export const LIST_ROW_PRESS_STILL_QUERY = 'still=1';

/** 行の値（一覧の画面に出る、毎回違う欄の値の代わり）。 */
export const LIST_ROW_PRESS_VALUES = Object.freeze({
  /** ちょうど 1 つの行にある値（`nav` の中にもある）。 */
  unique: 'row-value-0001',
  /** 2 つの行にある値。 */
  twice: 'row-value-0002',
  /** どの行にもない値（`nav` の中にだけある）。 */
  navOnly: 'row-value-0003',
} as const);

/** LU-SFIX2-A: 区切りのある一致の画面の値（どれも、ちょうど 1 つの行に当たる。ほかの行には、値を部分に含むだけのセルがある）。 */
export const LIST_ROW_PRESS_BOUNDARY_VALUES = Object.freeze({
  /** 値と同じセルの行が 1 つ（`item-21@…`・`xitem-2@…`・`…com.jp` の行には当たらない）。 */
  mail: 'item-2@example.com',
  /** 区切り（空白・`:`・`(`）で値が現れるセルの行が 1 つ（`…-77`・`…_old` の行には当たらない）。 */
  code: 'row-code-7',
  /** 子の要素のない `li` の全体の行が 1 つ（`<span>…-99</span>` の行には当たらない）。 */
  item: 'row-code-9',
  /** fix round 1: 文字の節で直接書いた値と開き手のある `li` の行が 1 つ（`…-55` の行と、`item-21@…` の `li` には当たらない）。 */
  inline: 'row-code-5',
  /** LU-SFIX3-A: 描かれていないセル（`display: none`）にだけある値（どの行にも当たらない）。 */
  hidden: 'row-code-2',
  /** LU-SFIX3-A: 見えない書式の文字（ZWSP）を挟んだセルの行が 1 つ（除いて比べる）。 */
  zeroWidth: 'row-code-3',
  /** LU-SFIX3-A: 大文字で書いたセルの行が 1 つ（大文字と小文字を区別しない）。 */
  upper: 'row-code-4',
  /** LU-SFIX3-A: 全角で書いたセルの行が 1 つ（Unicode の互換の正規化で比べる）。 */
  wide: 'row-code-8',
  /** LU-SFIX3-A: 後ろに結合文字が続くセル（語の続き）にだけある値（どの行にも当たらない）。 */
  combining: 'row-code-6',
  /** LU-SFIX3-A: NBSP で区切ったセルの行が 1 つ。 */
  nbsp: 'row-code-1',
} as const);

/** 開き手の画面の行の値（行ごとに開き手の形が違う）。 */
export const LIST_ROW_PRESS_OPENER_ROWS = Object.freeze({
  text: 'opener-row-text',
  ariaLabel: 'opener-row-aria-label',
  title: 'opener-row-title',
  iconOnly: 'opener-row-icon-only',
  twin: 'opener-row-twin',
  removeOnly: 'opener-row-remove-only',
  swapping: 'opener-row-swapping',
  rewriting: 'opener-row-rewriting',
} as const);

/** ボタンの文言。 */
export const LIST_ROW_PRESS_WORDS = Object.freeze({ edit: '編集', remove: '削除' } as const);

export interface ListRowPressSite {
  readonly origin: string;
  /** 届いた要求の path（届いた順）。 */
  readonly requests: readonly string[];
  /** LU-SFIX2-A: 届いた要求の method と path（届いた順）。 */
  readonly records: readonly { readonly method: string; readonly path: string }[];
  close(): Promise<void>;
}

const W = LIST_ROW_PRESS_WORDS;
const V = LIST_ROW_PRESS_VALUES;
const O = LIST_ROW_PRESS_OPENER_ROWS;
const ICON = '<svg width="12" height="12" aria-hidden="true"><rect width="12" height="12"></rect></svg>';
const REMOVE_BUTTON = `<button type="button" class="row-remove">${W.remove}</button>`;

const pageOf = (main: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>rows</title></head><body>'
  + `<main><h1>一覧</h1>${main}</main>`
  + '<dialog id="row-dialog"><p>窓</p></dialog>'
  + '<div id="row-panel" role="dialog" hidden><p>窓</p></div>'
  + `<script>(() => {
  window.__listRowPressRemoved = 0;
  for (const button of document.querySelectorAll('.row-remove')) {
    button.addEventListener('click', () => { window.__listRowPressRemoved += 1; });
  }
  for (const button of document.querySelectorAll('.row-open-dialog')) {
    button.addEventListener('click', () => { document.getElementById('row-dialog').showModal(); });
  }
  for (const button of document.querySelectorAll('.row-open-panel')) {
    button.addEventListener('click', () => { document.getElementById('row-panel').hidden = false; });
  }
})();</script></body></html>`;

const navOf = (): string => `<nav><ul><li>${V.unique}</li><li>${V.navOnly}</li></ul></nav>`;
const textOpener = `<button type="button" class="row-open-dialog">${W.edit}</button>`;

const tablePage = (): string => pageOf(`${navOf()}<table><thead><tr><th>${V.unique}</th><th>操作</th></tr></thead><tbody>`
  + `<tr><td> ${V.unique} </td><td>${textOpener} ${REMOVE_BUTTON}</td></tr>`
  + `<tr><td>${V.twice}</td><td>${textOpener} ${REMOVE_BUTTON}</td></tr>`
  + `<tr><td>${V.twice} の写し</td><td>${textOpener} ${REMOVE_BUTTON}</td></tr>`
  + '</tbody></table>');

const listPage = (): string => pageOf(`${navOf()}<ul class="rows">`
  + `<li><span>${V.unique}</span> ${textOpener} ${REMOVE_BUTTON}</li>`
  + `<li><span>${V.twice}</span> ${textOpener} ${REMOVE_BUTTON}</li>`
  + `<li><span>${V.twice}</span> ${textOpener} ${REMOVE_BUTTON}</li>`
  + '</ul>');

const openerRowOf = (value: string, openers: string): string => `<tr><td>${value}</td><td>${openers} ${REMOVE_BUTTON}</td></tr>`;

const openersPage = (): string => pageOf('<table><tbody>'
  + openerRowOf(O.text, textOpener)
  + openerRowOf(O.ariaLabel, `<button type="button" class="row-open-panel" aria-label="${W.edit}">${ICON}</button>`)
  + openerRowOf(O.title, `<button type="button" class="row-open-panel" title="${W.edit}">${ICON}</button>`)
  + openerRowOf(O.iconOnly, `<button type="button" class="row-open-panel">${ICON}</button>`)
  + openerRowOf(O.twin, `${textOpener} ${textOpener}`)
  + `<tr><td>${O.removeOnly}</td><td>${REMOVE_BUTTON}</td></tr>`
  + '</tbody></table>');

const swappingPage = (): string => pageOf('<table><tbody>'
  + openerRowOf(O.text, textOpener)
  + `<tr><td>${O.swapping}</td><td><span><button type="button" class="row-open-panel row-swapping">${W.edit}</button></span> ${REMOVE_BUTTON}</td></tr>`
  + '</tbody></table>'
  + `<script>(() => {
  window.__listRowPressOpened = 0;
  const real = document.querySelector('.row-swapping');
  real.addEventListener('click', () => { window.__listRowPressOpened += 1; });
  if (new URLSearchParams(location.search).toString() === ${JSON.stringify(LIST_ROW_PRESS_STILL_QUERY)}) return;
  const fake = document.createElement('button');
  fake.type = 'button';
  fake.className = 'row-open-panel';
  fake.innerHTML = ${JSON.stringify(ICON)};
  fake.addEventListener('click', (event) => {
    event.stopImmediatePropagation();
    void fetch(${JSON.stringify(LIST_ROW_PRESS_PATHS.purge)}, { method: 'POST' }).catch(() => undefined);
  });
  let showingReal = true;
  const tick = () => {
    if (showingReal) { real.replaceWith(fake); showingReal = false; setTimeout(tick, ${String(LIST_ROW_PRESS_SWAP_MS.fake)}); }
    else { fake.replaceWith(real); showingReal = true; setTimeout(tick, ${String(LIST_ROW_PRESS_SWAP_MS.real)}); }
  };
  setTimeout(tick, ${String(LIST_ROW_PRESS_SWAP_MS.real)});
})();</script>`);

const rewritingPage = (): string => pageOf('<table><tbody>'
  + openerRowOf(O.text, textOpener)
  + `<tr><td>${O.rewriting}</td><td><button type="button" class="row-rewriting">${W.edit}</button> ${REMOVE_BUTTON}</td></tr>`
  + '</tbody></table>'
  + `<script>(() => {
  window.__listRowPressOpened = 0;
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'attr' ? 'attr' : 'content';
  const button = document.querySelector('.row-rewriting');
  const icon = ${JSON.stringify(ICON)};
  let named = true;
  const show = (asNamed) => {
    named = asNamed;
    if (mode === 'content') {
      if (asNamed) button.textContent = ${JSON.stringify(W.edit)}; else button.innerHTML = icon;
    } else if (asNamed) {
      button.setAttribute('aria-label', ${JSON.stringify(W.edit)});
    } else {
      button.removeAttribute('aria-label');
    }
  };
  if (mode === 'attr') { button.innerHTML = icon; show(true); }
  button.addEventListener('click', () => {
    if (named) { window.__listRowPressOpened += 1; document.getElementById('row-panel').hidden = false; return; }
    void fetch(${JSON.stringify(LIST_ROW_PRESS_PATHS.purge)}, { method: 'POST' }).catch(() => undefined);
  });
  if (params.get('still') === '1') return;
  const ms = params.get('ms');
  const later = (next) => { if (ms === ${JSON.stringify(LIST_ROW_PRESS_REWRITE_EVERY_FRAME)}) requestAnimationFrame(next); else setTimeout(next, Number(ms ?? '10')); };
  const tick = () => { show(!named); later(tick); };
  later(tick);
})();</script>`);

const B = LIST_ROW_PRESS_BOUNDARY_VALUES;
const boundaryPage = (): string => pageOf('<table><tbody>'
  + `<tr><td>item-21@example.com</td><td>${textOpener}</td></tr>`
  + `<tr><td>x${B.mail}</td><td>${textOpener}</td></tr>`
  + `<tr><td>${B.mail}.jp</td><td>${textOpener}</td></tr>`
  + `<tr><td>${B.mail}</td><td>${textOpener}</td></tr>`
  + `<tr><td>${B.code}7</td><td>${textOpener}</td></tr>`
  + `<tr><td>${B.code}_old</td><td>${textOpener}</td></tr>`
  + `<tr><td>メモ: ${B.code} (済)</td><td>${textOpener}</td></tr>`
  + `<tr><td style="display: none">${B.hidden}</td><td>${textOpener}</td></tr>`
  + `<tr><td>row-\u200Bcode-3</td><td>${textOpener}</td></tr>`
  + `<tr><td>ROW-CODE-4</td><td>${textOpener}</td></tr>`
  + `<tr><td>\uFF52\uFF4F\uFF57\uFF0D\uFF43\uFF4F\uFF44\uFF45\uFF0D\uFF18</td><td>${textOpener}</td></tr>`
  + `<tr><td>${B.combining}\u0301</td><td>${textOpener}</td></tr>`
  + `<tr><td>メモ\u00A0${B.nbsp}\u00A0済</td><td>${textOpener}</td></tr>`
  + '</tbody></table><ul class="rows">'
  + `<li><span>${B.item}9</span> ${textOpener}</li>`
  + `<li>${B.item}</li>`
  + `<li>${B.inline} ${textOpener}</li>`
  + `<li>${B.inline}5 ${textOpener}</li>`
  + `<li>item-21@example.com ${textOpener}</li>`
  + '</ul>');

const PAGES: Readonly<Record<string, () => string>> = Object.freeze({
  [LIST_ROW_PRESS_PATHS.table]: tablePage,
  [LIST_ROW_PRESS_PATHS.list]: listPage,
  [LIST_ROW_PRESS_PATHS.openers]: openersPage,
  [LIST_ROW_PRESS_PATHS.swapping]: swappingPage,
  [LIST_ROW_PRESS_PATHS.boundary]: boundaryPage,
  [LIST_ROW_PRESS_PATHS.rewriting]: rewritingPage,
});

/** 仮の一覧の画面を、127.0.0.1 の空いたポートで始める。 */
export async function startListRowPressSite(): Promise<ListRowPressSite> {
  const requests: string[] = [];
  const records: { readonly method: string; readonly path: string }[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requests.push(path);
    records.push({ method: request.method ?? 'GET', path });
    const page = PAGES[path];
    if (request.method !== 'GET' || page === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(page());
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the list row press site did not start');
  }
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    records,
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}
