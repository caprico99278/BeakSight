// COV-1（INV-238 の仮のサイトを写した。網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md`、DEF-238 の設計書 3.1）: 何段もの操作で入力の枠を
// 開く登録の画面（一般の文言の仮のサイト）。COV-1 で、状態が繰り返す画面（`/app/toggle`）と、ボタンの多い画面（`/app/many?n=`）を足した。
// 1 段目: 拠点を選ぶ（押すと選択の保存の POST と、query の付いた URL への pushState）。
// 2 段目: 時間割（「＋新規予約」で右に入力の枠が開く。時間の枠は押すと印が付くだけ）。
// 3 段目: 入力の枠（利用者の検索（1 文字から GET）、「＋新しい利用者を入力」で開く欄（性別の radio・氏名・電話）、コースの select（必須）、詳細設定の開閉、
//         「予約を作成」（必須を満たすまで押せない。押すと POST /api/reservations））。
// 変え方は path で選ぶ: /app/booking（枠は section）、/app/booking-dialog（枠は role="dialog"）。query の付いた URL を直に開くと時間割から始まる。
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly search: string;
}

const htmlOf = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body>${body}</body></html>`;

const pageOf = (panelOpen: string, panelClose: string): string => htmlOf('予約', `
<nav><button type="button" class="menu">お知らせ</button></nav>
<main id="root"></main>
<script>
const state = { site: null, date: null, time: null, person: null, newPerson: false };
function q(id) { return document.getElementById(id); }
function renderChoice() {
  q('root').innerHTML = '<h1>予約の表</h1><p>どの拠点の予約を見るか選びます</p>'
    + '<button type="button" class="site" data-id="s1">東の拠点</button>'
    + '<button type="button" class="site" data-id="s2">西の拠点</button>'
    + '<p>次からは同じ拠点で開きます</p>';
  document.querySelectorAll('.site').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id;
    fetch('/api/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ site: id }) }).catch(() => {});
    history.pushState({}, '', location.pathname + '?date=2026-11-09&site=' + id);
    state.site = id; state.date = '2026-11-09';
    renderTable();
  }));
}
function renderTable() {
  q('root').innerHTML = '<h1>時間割</h1><button type="button" id="new">＋新規予約</button>'
    + '<div class="slots"><button type="button" class="slot">10:00</button><button type="button" class="slot">10:30</button>'
    + '<button type="button" class="slot">11:00</button></div><div id="panelHost"></div>';
  document.querySelectorAll('.slot').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.slot').forEach((o) => o.removeAttribute('aria-pressed'));
    b.setAttribute('aria-pressed', 'true'); state.time = b.textContent;
  }));
  q('new').addEventListener('click', openPanel);
}
function refresh() {
  const course = q('course').value !== '';
  const g = document.querySelector('input[name=gender]:checked');
  const personOk = state.person !== null || (state.newPerson && g !== null && q('pname').value !== '' && q('ptel').value !== '');
  q('create').disabled = !(course && personOk);
}
function openPanel() {
  q('panelHost').innerHTML = '${panelOpen}<h2>新規予約</h2>'
    + '<label>利用者を検索 <input id="find" type="text" autocomplete="off"></label><ul id="hits"></ul>'
    + '<button type="button" id="newPerson">＋新しい利用者を入力（性別・氏名・電話）</button>'
    + '<div id="person" hidden><label><input type="radio" name="gender" value="f" required>女性</label>'
    + '<label><input type="radio" name="gender" value="m">男性</label>'
    + '<label>氏名 <input id="pname" type="text"></label><label>電話 <input id="ptel" type="tel"></label></div>'
    + '<label>コース <select id="course" required><option value="">選んでください</option><option value="c1">短いコース</option>'
    + '<option value="c2">長いコース</option></select></label>'
    + '<button type="button" id="adv">詳細設定</button><div id="advBox" hidden><label>メモ <textarea id="memo"></textarea></label></div>'
    + '<button type="button" id="create" disabled>予約を作成</button>${panelClose}';
  state.person = null; state.newPerson = false;
  q('find').addEventListener('input', () => {
    const v = q('find').value;
    if (v.length < 1) return;
    fetch('/api/people?q=' + encodeURIComponent(v)).then((r) => r.json()).then((rows) => {
      q('hits').innerHTML = rows.map((r) => '<li><button type="button" class="hit" data-id="' + r.id + '">' + r.name + '</button></li>').join('');
      document.querySelectorAll('.hit').forEach((h) => h.addEventListener('click', () => { state.person = h.dataset.id; refresh(); }));
    }).catch(() => {});
  });
  q('newPerson').addEventListener('click', () => { q('person').hidden = false; state.newPerson = true; refresh(); });
  q('adv').addEventListener('click', () => { q('advBox').hidden = !q('advBox').hidden; });
  ['course', 'pname', 'ptel'].forEach((id) => { q(id).addEventListener('input', refresh); q(id).addEventListener('change', refresh); });
  document.querySelectorAll('input[name=gender]').forEach((r) => r.addEventListener('change', refresh));
  q('create').addEventListener('click', () => {
    const g = document.querySelector('input[name=gender]:checked');
    const person = state.person !== null ? { id: state.person } : { gender: g ? g.value : null, name: q('pname').value, tel: q('ptel').value };
    fetch('/api/reservations', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ site: state.site, date: state.date, time: state.time, course: q('course').value, person, memo: q('memo').value }) }).catch(() => {});
  });
}
const params = new URLSearchParams(location.search);
if (params.get('site') !== null) { state.site = params.get('site'); state.date = params.get('date'); renderTable(); } else { renderChoice(); }
document.querySelector('.menu').addEventListener('click', () => {});
</script>`);

/**
 * COV-1: 状態が繰り返す画面。「表示を切り替え」で 2 つの区画（欄の違う A と B）を行き来し、「次の日」は日付の文字だけを変える（構造は変わらない）。
 * 「保存」は今の区画の欄を POST する。押す数の上限がなくても終わること（同じ構造の鍵の同じ候補は押し直さない）を確かめる。
 */
const TOGGLE_PAGE = htmlOf('切り替え', `
<main><h1>記録</h1><p id="day">2026-11-09</p><button type="button" id="next">次の日</button><button type="button" id="toggle">表示を切り替え</button>
<div id="box"></div><button type="button" id="save">保存</button></main>
<script>
let mode = 'a';
function q(id) { return document.getElementById(id); }
function render() {
  q('box').innerHTML = mode === 'a' ? '<label>件名 <input name="title"></label>' : '<label>件名 <input name="title"></label><label>メモ <textarea name="memo"></textarea></label>';
}
q('toggle').addEventListener('click', () => { mode = mode === 'a' ? 'b' : 'a'; render(); });
q('next').addEventListener('click', () => { const d = new Date(q('day').textContent); d.setDate(d.getDate() + 1); q('day').textContent = d.toISOString().slice(0, 10); });
q('save').addEventListener('click', () => {
  const body = {}; document.querySelectorAll('#box [name]').forEach((f) => { body[f.name] = f.value; });
  fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
});
render();
</script>`);

/** COV-1: ボタンの多い画面（測る用）。`n` 個の何もしないボタン（文字あり）と、欄 1 つと「保存」。 */
const manyPageOf = (count: number): string => htmlOf('一覧', `<main><h1>一覧</h1><label>件名 <input name="title"></label>`
  + Array.from({ length: count }, (_, index) => `<button type="button" class="item">項目 ${String(index + 1)}</button>`).join('')
  + `<button type="button" id="save">保存</button></main>
<script>
document.querySelectorAll('.item').forEach((button) => button.addEventListener('click', () => {}));
document.getElementById('save').addEventListener('click', () => {
  fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: document.querySelector('[name=title]').value }) }).catch(() => {});
});
</script>`);

/** COV-1: ボタンの多い画面のボタンの数の上限（テストの値。読み込みを重くしない）。 */
const MAX_MANY_BUTTONS = 300;

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/app/booking': pageOf('<section id="panel">', '</section>'),
  '/app/booking-dialog': pageOf('<div id="panel" role="dialog" aria-label="新規予約">', '</div>'),
  '/app/toggle': TOGGLE_PAGE,
});

/** サーバの処理（記録を `seen` に足す）。検索は「や」で始まる語だけに当たる（目印では当たらない）。 */
export const bookingSiteHandler = (seen: SeenRequest[]) => (request: IncomingMessage, response: ServerResponse): void => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  seen.push({ method: request.method ?? '', path: url.pathname, search: url.search });
  request.resume();
  const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  const many = Number(url.searchParams.get('n') ?? '0');
  const page = url.pathname === '/app/many' && Number.isSafeInteger(many) && many > 0 && many <= MAX_MANY_BUTTONS ? manyPageOf(many) : PAGES[url.pathname];
  if (page !== undefined) {
    response.writeHead(200, html);
    response.end(page);
  } else if (url.pathname === '/api/people') {
    const term = url.searchParams.get('q') ?? '';
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(term.startsWith('や') ? [{ id: 'p1', name: 'やまだ' }] : []));
  } else if (url.pathname === '/' ) {
    response.writeHead(200, html);
    response.end(htmlOf('top', '<main><h1>top</h1><a href="/app/booking">予約</a></main>'));
  } else {
    response.writeHead(request.method === 'GET' ? 404 : 200, { 'content-type': 'application/json' });
    response.end('{}');
  }
};
