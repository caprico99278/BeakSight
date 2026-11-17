// COV-3（網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md` 3.2 の 1・3.3）: select・radio の選択肢ごとの段を確かめる仮のサイト（一般の文言）。
// - `/opt/kind`: 種別の select で「法人」を選ぶと、会社名の欄と別の「登録」（POST /opt/kind/api/corp）が出る。もとの form の「送信」は POST /opt/kind/api/person。
// - `/opt/radio`: 区分の radio で「その他」を選ぶと、自由記入の欄が同じ form に出る。「送信」は POST /opt/radio/api/apply。
// - `/opt/many?n=`: 選択肢が n ある select。値が `MANY_CHANGING_VALUE` の選択肢だけが、欄と「追加登録」（POST /opt/many/api/extra）を出す。
// - `/opt/change`: 選ぶと、読み取りの GET（/opt/change/api/cities）と POST（/opt/change/api/track）を出す select（画面の作りは変えない）。
// サーバは、届いた要求を順に記録する（method・path・query）。
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface OptionSiteRequest {
  readonly method: string;
  readonly path: string;
  readonly search: string;
}

/** `/opt/many` の、作りを変える選択肢の値（1 から数えた番号）。 */
export const MANY_CHANGING_VALUE = 200;
/** `/opt/many` の選択肢の数の上限（テストの値。読み込みを重くしない）。 */
const MAX_MANY_OPTIONS = 400;

const htmlOf = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body>${body}</body></html>`;

const post = (path: string, body: string): string =>
  `fetch('${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${body} }).catch(() => {});`;

const KIND_PAGE = htmlOf('申し込み', `<main><h1>申し込み</h1>
<form id="f" onsubmit="return false">
<label>種別 <select name="kind" id="kind"><option value="">選んでください</option><option value="person">個人</option><option value="corp">法人</option></select></label>
<label>氏名 <input name="pname" type="text"></label>
<button type="button" id="send">送信</button>
</form>
<div id="corpHost"></div>
</main>
<script>
const kind = document.getElementById('kind');
kind.addEventListener('change', () => {
  const host = document.getElementById('corpHost');
  if (kind.value !== 'corp') { host.innerHTML = ''; return; }
  host.innerHTML = '<h2>法人の情報</h2><form id="cf" onsubmit="return false"><label>会社名 <input name="company" type="text"></label>'
    + '<button type="button" id="reg">登録</button></form>';
  document.getElementById('reg').addEventListener('click', () => {
    ${post('/opt/kind/api/corp', "JSON.stringify({ company: document.querySelector('[name=company]').value })")}
  });
});
document.getElementById('send').addEventListener('click', () => {
  ${post('/opt/kind/api/person', "JSON.stringify({ kind: kind.value, name: document.querySelector('[name=pname]').value })")}
});
</script>`);

const RADIO_PAGE = htmlOf('参加の申し込み', `<main><h1>参加の申し込み</h1>
<form id="f" onsubmit="return false">
<fieldset><legend>区分</legend>
<label><input type="radio" name="kind" value="a">一般</label>
<label><input type="radio" name="kind" value="b">学生</label>
<label><input type="radio" name="kind" value="other">その他</label>
</fieldset>
<div id="noteHost"></div>
<label>氏名 <input name="pname" type="text"></label>
<button type="button" id="send">送信</button>
</form>
</main>
<script>
document.querySelectorAll('input[name=kind]').forEach((radio) => radio.addEventListener('change', () => {
  const chosen = document.querySelector('input[name=kind]:checked');
  document.getElementById('noteHost').innerHTML = chosen !== null && chosen.value === 'other'
    ? '<label>自由記入 <input name="note" type="text"></label>' : '';
}));
document.getElementById('send').addEventListener('click', () => {
  const chosen = document.querySelector('input[name=kind]:checked');
  const note = document.querySelector('[name=note]');
  ${post('/opt/radio/api/apply', "JSON.stringify({ kind: chosen === null ? '' : chosen.value, note: note === null ? '' : note.value, name: document.querySelector('[name=pname]').value })")}
});
</script>`);

const manyPageOf = (count: number): string => {
  const options = Array.from({ length: count }, (_value, at) => `<option value="${String(at + 1)}">品目 ${String(at + 1)}</option>`).join('');
  return htmlOf('品目の登録', `<main><h1>品目の登録</h1>
<form id="f" onsubmit="return false">
<label>品目 <select name="item" id="item">${options}</select></label>
<button type="button" id="save">保存</button>
</form>
<div id="extraHost"></div>
</main>
<script>
const item = document.getElementById('item');
item.addEventListener('change', () => {
  const host = document.getElementById('extraHost');
  if (item.value !== '${String(MANY_CHANGING_VALUE)}') { host.innerHTML = ''; return; }
  host.innerHTML = '<form id="xf" onsubmit="return false"><label>追加の説明 <input name="extra" type="text"></label>'
    + '<button type="button" id="extraSave">追加登録</button></form>';
  document.getElementById('extraSave').addEventListener('click', () => {
    ${post('/opt/many/api/extra', "JSON.stringify({ extra: document.querySelector('[name=extra]').value })")}
  });
});
document.getElementById('save').addEventListener('click', () => {
  ${post('/opt/many/api/items', 'JSON.stringify({ item: item.value })')}
});
</script>`);
};

const CHANGE_PAGE = htmlOf('地域', `<main><h1>地域</h1>
<form id="f" onsubmit="return false">
<label>地域 <select name="area" id="area"><option value="east">東</option><option value="west">西</option><option value="north">北</option></select></label>
<button type="button" id="save">保存</button>
</form>
</main>
<script>
const area = document.getElementById('area');
area.addEventListener('change', () => {
  fetch('/opt/change/api/cities?area=' + encodeURIComponent(area.value)).catch(() => {});
  ${post('/opt/change/api/track', 'JSON.stringify({ area: area.value })')}
});
document.getElementById('save').addEventListener('click', () => {
  ${post('/opt/change/api/areas', 'JSON.stringify({ area: area.value })')}
});
</script>`);

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/opt/kind': KIND_PAGE,
  '/opt/radio': RADIO_PAGE,
  '/opt/change': CHANGE_PAGE,
});

/** サーバの処理（届いた要求を `seen` に足す）。 */
export const optionSiteHandler = (seen: OptionSiteRequest[]) => (request: IncomingMessage, response: ServerResponse): void => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  seen.push({ method: request.method ?? '', path: url.pathname, search: url.search });
  request.resume();
  const html = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
  const many = Number(url.searchParams.get('n') ?? '0');
  const page = url.pathname === '/opt/many' && Number.isSafeInteger(many) && many > 0 && many <= MAX_MANY_OPTIONS ? manyPageOf(many) : PAGES[url.pathname];
  if (page !== undefined) {
    response.writeHead(200, html);
    response.end(page);
  } else if (url.pathname === '/opt/change/api/cities') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end('[]');
  } else {
    response.writeHead(request.method === 'GET' ? 404 : 200, { 'content-type': 'application/json' });
    response.end('{}');
  }
};
