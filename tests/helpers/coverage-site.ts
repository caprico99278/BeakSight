// COV-2（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2・3.3）: 操作さがしの再帰の待ち行列を確かめる仮のサイト（一般の文言。127.0.0.1）。
// - `/`: 入口。下の画面へのリンク。
// - `/list?page=N`（1〜3）: 一覧の続きのページ。1 は `/items/1`・`/items/2` と次へ、2 は `/items/3` と次へ、3 は `/items/4`（次はない）。
// - `/items/:id`: 番号だけ違う同じ作りの編集の画面（欄と「保存」。押すと fetch の PATCH）。
// - `/orders/1`・`/orders/2`: 同じ作りで、状態の語（「確定」と「取り消し済み」）とボタンの語のない押下の送り先だけが違う画面（押すと fetch の POST）。
// - `/cal?date=D`: 日付の「次へ」が終わりなく続く、空の日の画面。
// - `/many`: 4 つの何もしないボタン、画面の区画を入れ替えるボタン（区画の中の最後のボタンが消える）、最後のボタン。
// - `/app/*`・`/api/*`: 予約の画面（`staged-probe-site.ts` の `bookingSiteHandler`）。
// - `/invite?token=...`: 秘密に見える名前の query を持つ画面（`/hub` からだけリンクする）。
// - COV-2b: `/swap`（段をまたいで同じ深さ・同じ識別の文字のないボタンが入れ替わる）、`/find`（押すと欄の値を query に入れて `/results` へ移る）、
//   `/framed`（同じ Origin の子の frame `/frame-doc`）。
// 届いた要求（method・path・query）を記録する。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bookingSiteHandler, type SeenRequest } from './staged-probe-site.js';

/** 秘密に見える名前の query の値（`/invite?token=`。テストの値）。 */
export const COVERAGE_SITE_INVITE_TOKEN = 'invitevalue7f3a';

const htmlOf = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body>${body}</body></html>`;

const NAV = '<nav><a href="/">トップ</a></nav>';

const TOP = htmlOf('top', `${NAV}<main><h1>トップ</h1><ul>`
  + '<li><a href="/list?page=1">一覧</a></li><li><a href="/cal?date=2026-11-01">予定</a></li>'
  + '<li><a href="/orders/1">注文 1</a></li><li><a href="/orders/2">注文 2</a></li>'
  + '<li><a href="/app/booking">予約</a></li><li><a href="/many">ボタン</a></li><li><a href="/hub">案内</a></li>'
  + '<li><a href="/swap">入れ替え</a></li><li><a href="/find">さがす</a></li><li><a href="/framed">枠</a></li></ul></main>');

/** COV-2b: 段をまたいで、同じ深さ・同じ識別の文字のないボタンが入れ替わる画面（1 つ目を押すと、区画の中身が見出しと 3 つのボタンに替わる）。 */
const SWAP = htmlOf('入れ替え', `${NAV}<main><h1>入れ替え</h1><div id="box">`
  + '<button type="button" class="first">左</button><button type="button" class="first">右</button></div></main>'
  + '<script>document.querySelectorAll(".first").forEach((b, i) => b.addEventListener("click", () => { if (i !== 0) return;'
  + ' document.getElementById("box").innerHTML = "<h2>選び直し</h2><button type=\\"button\\" class=\\"second\\">上</button>'
  + '<button type=\\"button\\" class=\\"second\\">中</button><button type=\\"button\\" class=\\"second\\">下</button>";'
  + ' document.querySelectorAll(".second").forEach((s) => s.addEventListener("click", () => {})); }));</script>');

/** COV-2b: 押すと欄の値を query に入れた結果の画面へ移る画面（GET の文書の移動）。 */
const FIND = htmlOf('さがす', `${NAV}<main><h1>さがす</h1><label>語 <input id="q" name="q"></label><button type="button" id="go">進む</button></main>`
  + '<script>document.getElementById("go").addEventListener("click", () => { location.href = "/results?q=" + encodeURIComponent(document.getElementById("q").value); });</script>');
const RESULTS = htmlOf('結果', `${NAV}<main><h1>結果</h1><p>見つかりませんでした</p></main>`);

/** COV-2b: 同じ Origin の子の frame を持つ画面と、frame の文書。 */
const FRAMED = htmlOf('枠', `${NAV}<main><h1>枠</h1><iframe src="/frame-doc" title="中身"></iframe></main>`);
const FRAME_DOC = htmlOf('中身', '<main><h1>中身</h1><p>frame の文書</p></main>');

const LIST_ITEMS: Readonly<Record<string, readonly number[]>> = Object.freeze({ '1': [1, 2], '2': [3], '3': [4] });

const listOf = (page: string): string | null => {
  const items = LIST_ITEMS[page];
  if (items === undefined) return null;
  const next = Number(page) < 3 ? `<a href="/list?page=${String(Number(page) + 1)}">次のページ</a>` : '';
  return htmlOf('一覧', `${NAV}<main><h1>一覧</h1><ul>${items.map((id) => `<li><a href="/items/${String(id)}">項目 ${String(id)}</a></li>`).join('')}</ul>${next}</main>`);
};

const itemOf = (id: string): string => htmlOf('項目', `${NAV}<main><h1>項目</h1>`
  + '<label>件名 <input name="title" id="title"></label><button type="button" id="save">保存</button></main>'
  + `<script>document.getElementById('save').addEventListener('click', () => { fetch('/api/items/${id}', { method: 'PATCH',`
  + ' headers: { "content-type": "application/json" }, body: JSON.stringify({ title: document.getElementById("title").value }) }).catch(() => {}); });</script>');

const orderOf = (id: string, state: string): string => htmlOf('注文', `${NAV}<main><h1>注文</h1><p>状態: ${state}</p>`
  + '<button type="button" id="act">申請する</button></main>'
  + `<script>document.getElementById('act').addEventListener('click', () => { fetch('/api/orders/${id}/requests', { method: 'POST',`
  + ' headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "x" }) }).catch(() => {}); });</script>');

const ORDER_STATES: Readonly<Record<string, string>> = Object.freeze({ '1': '確定', '2': '取り消し済み' });

const calOf = (date: string): string => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  const next = day.toISOString().slice(0, 10);
  return htmlOf('予定', `${NAV}<main><h1>予定</h1><p>${date}</p><p>予定はありません</p><a href="/cal?date=${next}">次へ</a></main>`);
};

const MANY = htmlOf('ボタン', `${NAV}<main><h1>ボタン</h1><div id="box">`
  + '<button type="button" class="noop">項目 1</button><button type="button" class="noop">項目 2</button>'
  + '<button type="button" class="noop">項目 3</button><button type="button" class="noop">項目 4</button>'
  + '<button type="button" id="swap">表示を切り替え</button><button type="button" id="last">最後のボタン</button></div></main>'
  + '<script>document.querySelectorAll(".noop").forEach((b) => b.addEventListener("click", () => {}));'
  + 'document.getElementById("last").addEventListener("click", () => {});'
  + 'document.getElementById("swap").addEventListener("click", () => { document.getElementById("box").innerHTML = "<h2>切り替えた表示</h2><label>メモ <input name=\\"memo\\"></label>"; });'
  + '</script>');

const HUB = htmlOf('案内', `${NAV}<main><h1>案内</h1><a href="/invite?token=${COVERAGE_SITE_INVITE_TOKEN}&step=1">招待</a></main>`);
const INVITE = htmlOf('招待', `${NAV}<main><h1>招待</h1><p>招待の画面</p></main>`);

/** 仮のサイトの処理（届いた要求を `seen` に足す）。 */
export const coverageSiteHandler = (seen: SeenRequest[]) => {
  const booking = bookingSiteHandler([]);
  return (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({ method: request.method ?? '', path: url.pathname, search: url.search });
    if (url.pathname.startsWith('/app/') || url.pathname.startsWith('/api/people') || url.pathname === '/api/preferences' || url.pathname === '/api/reservations') {
      booking(request, response);
      return;
    }
    request.resume();
    const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    const itemMatch = /^\/items\/([0-9]+)$/u.exec(url.pathname);
    const orderMatch = /^\/orders\/([0-9]+)$/u.exec(url.pathname);
    let page: string | null = null;
    if (request.method === 'GET' && url.pathname === '/') page = TOP;
    else if (request.method === 'GET' && url.pathname === '/list') page = listOf(url.searchParams.get('page') ?? '');
    else if (request.method === 'GET' && itemMatch !== null) page = itemOf(itemMatch[1] ?? '');
    else if (request.method === 'GET' && orderMatch !== null && ORDER_STATES[orderMatch[1] ?? ''] !== undefined) {
      page = orderOf(orderMatch[1] ?? '', ORDER_STATES[orderMatch[1] ?? ''] ?? '');
    } else if (request.method === 'GET' && url.pathname === '/cal' && /^\d{4}-\d{2}-\d{2}$/u.test(url.searchParams.get('date') ?? '')) {
      page = calOf(url.searchParams.get('date') ?? '');
    } else if (request.method === 'GET' && url.pathname === '/many') page = MANY;
    else if (request.method === 'GET' && url.pathname === '/hub') page = HUB;
    else if (request.method === 'GET' && url.pathname === '/invite') page = INVITE;
    else if (request.method === 'GET' && url.pathname === '/swap') page = SWAP;
    else if (request.method === 'GET' && url.pathname === '/find') page = FIND;
    else if (request.method === 'GET' && url.pathname === '/results') page = RESULTS;
    else if (request.method === 'GET' && url.pathname === '/framed') page = FRAMED;
    else if (request.method === 'GET' && url.pathname === '/frame-doc') page = FRAME_DOC;
    if (page !== null) {
      response.writeHead(200, html);
      response.end(page);
      return;
    }
    response.writeHead(request.method === 'GET' ? 404 : 200, { 'content-type': 'application/json' });
    response.end('{}');
  };
};
