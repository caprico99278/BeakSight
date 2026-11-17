// COV-2c（SREV-COV の実験の仮のサイトを写した。網羅の設計書 `2026-11-09-beaksight-coverage-by-state-design.md`）: 操作さがしの網羅の安全と終わり方を
// 確かめる仮のサイト（127.0.0.1、一般の文言）。場面ごとに入口 `/<場面>/` を持つ。届いた要求を全部記録する（時刻つき）。
// - endless: 押すたびに見出しが 1 つ増える（`/es/page`）、押すたびに同じ作りのボタンが増える（名前あり `/eb/named`・名前なし `/eb/plain`）、
//   押すと新しい作りの区画が出て、その中にボタンがある（`/esr/page`）。
// - many: 語の違うボタンがたくさんある（押すたびに GET の合図）。止める印と Run の時間の上限の確かめ。
// - stop: 押す時点の確かめが止める（押していない）画面を、番号だけ違う同じ作りで 2 つ（`/stop/items/1`・`/stop/items/2`）。
// - spaq: 押すと欄の値を query に入れて、同じ文書のまま URL を変える（pushState）。
// - resume: 押すと欄の値を query に入れて文書を移す（`/resume/results?q=`）画面と、番号だけ違う画面。checkpoint からの再開の確かめ。
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 届いた要求（時刻つき）。 */
export interface CoverageSafetyArrival {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly search: string;
  /** 要求の本文（目印の値が届いたかを数えるため）。 */
  readonly body: string;
  /** Referer と Cookie の header（目印の値が届いたかを数えるため。なければ空）。 */
  readonly referer: string;
  readonly cookie: string;
}

/** many の画面のボタンの数。 */
export const COVERAGE_SAFETY_MANY_BUTTONS = 20;

const page = (title: string, body: string): string => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title>`
  + `<link rel="icon" href="data:,"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

/** 押したときに出す書き込み（fetch の POST・PUT・PATCH・DELETE、method の上書き、beacon、XHR）。 */
const writes = (tag: string): string => `const v = Array.from(document.querySelectorAll('input,select,textarea')).map((e) => e.name + '=' + e.value).join('&');`
  + `fetch('/${tag}/api/post', { method: 'POST', body: v }).catch(() => {});`
  + `fetch('/${tag}/api/put', { method: 'PUT', body: v }).catch(() => {});`
  + `fetch('/${tag}/api/patch', { method: 'PATCH', body: v }).catch(() => {});`
  + `fetch('/${tag}/api/item/1', { method: 'DELETE' }).catch(() => {});`
  + `fetch('/${tag}/api/override?_method=PUT', { method: 'POST', headers: { 'x-http-method-override': 'PUT' }, body: v }).catch(() => {});`
  + `try { navigator.sendBeacon('/${tag}/api/beacon', v); } catch (e) {}`
  + `try { const x = new XMLHttpRequest(); x.open('POST', '/${tag}/api/xhr'); x.send(v); } catch (e) {}`;

/** op の一覧の画面（`k` ごとに、保存で入った値の覚え方と、開き手の出し方が違う）。 */
const opListOf = (k: string): string => {
  const base = `/op/${k}/items/1`;
  const save = `document.getElementById("sv").addEventListener("click", () => { fetch("/op/${k}/api/save", { method: "POST", body: document.getElementById("title").value }).catch(() => {});`;
  const go = `location.href = "${base}?t=" + encodeURIComponent(window.__saved || "");`;
  const remember = ' window.__saved = document.getElementById("title").value; localStorage.setItem("draft", window.__saved);'
    + ' document.cookie = "draft=" + encodeURIComponent(window.__saved) + "; path=/";';
  let script = '';
  let editButton = '<button type="button" id="ed">編集</button>';
  if (k === 'g') {
    script = `${save}${remember} }); document.getElementById("ed").addEventListener("click", () => { ${go} });`;
  } else if (k === 'h') {
    script = `${save} }); document.getElementById("title").addEventListener("input", (e) => { if (e.target.value) { window.__saved = e.target.value;`
      + ' localStorage.setItem("draft", e.target.value); } });'
      + ` document.getElementById("ed").addEventListener("click", () => { ${go} });`;
  } else {
    // k: 保存の後にだけ「編集」が出る。
    editButton = '';
    script = `${save}${remember} if (document.getElementById("ed") === null) { const b = document.createElement("button"); b.type = "button"; b.id = "ed";`
      + ` b.textContent = "編集"; document.getElementById("tools").appendChild(b); b.addEventListener("click", () => { ${go} }); } });`;
  }
  return page('一覧', '<div id="box"><label>件名 <input id="title" name="title"></label></div>'
    + `<div id="tools"><button type="button" id="sv">保存</button>${editButton}</div><script>${script}</script>`);
};

const sceneOf = (path: string): string | null => {
  // ---- endless ----
  if (path === '/endless/') {
    return page('入口', '<a href="/es/page">絞り込み</a> <a href="/eb/named">名前あり</a> <a href="/eb/plain">名前なし</a> <a href="/esr/page">区画</a>');
  }
  if (path === '/es/page') {
    return page('絞り込み', '<div id="box"></div><button type="button" id="f">絞り込み</button><script>'
      + 'let n = 0; document.getElementById("f").addEventListener("click", () => { n += 1; fetch("/es/ping?n=" + n).catch(() => {});'
      + ' const h = document.createElement("h3"); h.textContent = "結果"; document.getElementById("box").appendChild(h); });</script>');
  }
  if (path === '/eb/named') {
    return page('もっと', '<div id="box"><button type="button" class="m">もっと見る</button></div><script>'
      + 'let n = 0; const add = (b) => b.addEventListener("click", () => { n += 1; fetch("/eb/ping-named?n=" + n).catch(() => {});'
      + ' const x = document.createElement("button"); x.type = "button"; x.className = "m"; x.textContent = "もっと見る";'
      + ' document.getElementById("box").appendChild(x); add(x); });'
      + 'document.querySelectorAll(".m").forEach(add);</script>');
  }
  if (path === '/eb/plain') {
    return page('もっと', '<div id="box"><button type="button" class="m"><svg width="10" height="10"><rect width="10" height="10"/></svg></button></div><script>'
      + 'let n = 0; const add = (b) => b.addEventListener("click", () => { n += 1; fetch("/eb/ping-plain?n=" + n).catch(() => {});'
      + ' const x = document.createElement("button"); x.type = "button"; x.className = "m";'
      + ' x.innerHTML = "<svg width=\\"10\\" height=\\"10\\"><rect width=\\"10\\" height=\\"10\\"/></svg>";'
      + ' document.getElementById("box").appendChild(x); add(x); });'
      + 'document.querySelectorAll(".m").forEach(add);</script>');
  }
  if (path === '/esr/page') {
    return page('区画', '<div id="box"></div><button type="button" id="open">詳しく</button><script>'
      + 'document.getElementById("open").addEventListener("click", () => { fetch("/esr/ping-open").catch(() => {});'
      + ' if (document.getElementById("panel") !== null) return;'
      + ' document.getElementById("box").innerHTML = "<section id=\\"panel\\" class=\\"panel\\" aria-label=\\"詳しい欄\\"><h2>詳しい欄</h2>'
      + '<label>件名 <input name=\\"title\\"></label><button type=\\"button\\" id=\\"save\\" class=\\"save\\">登録する</button></section>";'
      + ' document.getElementById("save").addEventListener("click", () => {' + writes('esr') + ' fetch("/esr/ping-save").catch(() => {}); }); });</script>');
  }
  // ---- moved: 押した後の GET の移り先の画面が、読み込みのときに自分で書き込む（POST と beacon。値は query） ----
  if (path === '/moved/') return page('入口', '<a href="/moved/find">さがす</a> <a href="/moved/ovr">上書き</a>');
  if (path === '/moved/find') {
    return page('さがす', '<label>語 <input id="q" name="q"></label><button type="button" id="go">進む</button><script>'
      + 'document.getElementById("go").addEventListener("click", () => { location.href = "/moved/confirm?q=" + encodeURIComponent(document.getElementById("q").value); });</script>');
  }
  if (path === '/moved/ovr') {
    return page('上書き', '<label>件名 <input id="t" name="t"></label><button type="button" id="go">更新</button><script>'
      + 'document.getElementById("go").addEventListener("click", () => { location.href = "/moved/items/1?_method=PUT&title=" + encodeURIComponent(document.getElementById("t").value); });</script>');
  }
  if (path === '/moved/confirm' || path === '/moved/items/1') {
    return page('確認', '<p>確認しました</p><script>'
      + 'fetch("/moved/api/commit", { method: "POST", body: location.search }).catch(() => {});'
      + 'try { navigator.sendBeacon("/moved/api/beacon-onload", location.search); } catch (e) {}</script>');
  }
  // ---- pop: 押下で popup・Worker・frame から送る（DEF-036 の型）。popup・frame の子の画面は、読み込みのときに自分で書き込む ----
  if (path === '/pop/') return page('入口', '<a href="/pop/page">画面</a>');
  if (path === '/pop/page') {
    return page('窓', '<label>件名 <input id="t" name="t"></label><button type="button" id="w1">窓を開く</button>'
      + '<form id="tf" method="post" action="/pop/api/target-blank" target="_blank"><input type="hidden" name="h" value="1"></form>'
      + '<button type="button" id="w2">別の窓で送る</button><button type="button" id="w4">枠で送る</button><script>'
      + 'const v = () => document.getElementById("t").value;'
      + 'document.getElementById("w1").addEventListener("click", () => { window.open("/pop/child?t=" + encodeURIComponent(v())); });'
      + 'document.getElementById("w2").addEventListener("click", () => { document.getElementById("tf").submit(); });'
      + 'document.getElementById("w4").addEventListener("click", () => { const g = document.createElement("iframe"); g.src = "/pop/child?t=" + encodeURIComponent(v()); document.body.appendChild(g); });'
      + '</script>');
  }
  if (path === '/pop/child') {
    return page('子', '<form id="cf" method="post" action="/pop/api/child-form"><input name="c" value="1"></form><script>'
      + 'fetch("/pop/api/child-onload", { method: "POST", body: location.search }).catch(() => {});'
      + 'try { navigator.sendBeacon("/pop/api/child-beacon", location.search); } catch (e) {}'
      + 'setTimeout(() => { try { document.getElementById("cf").submit(); } catch (e) {} }, 50);</script>');
  }
  // ---- opener: 一覧の上に検索の欄。「表示」は欄の値を使わない。開き手「編集」は、欄の値を移り先の URL に乗せる。移り先の編集の画面は、読み込みのときに
  //      自分で URL の値を送り（POST）、件名の form の「保存」で PATCH を送る ----
  if (path === '/opener/') return page('入口', '<a href="/opener/list">一覧</a>');
  if (path === '/opener/list') {
    return page('一覧', '<label>語 <input id="q" name="q" value="初期"></label><button type="button" id="show">表示</button><p id="msg"></p>'
      + '<table><tr><td>行</td><td><button type="button" id="edit">編集</button></td></tr></table><script>'
      + 'document.getElementById("show").addEventListener("click", () => { document.getElementById("msg").textContent = "表示しました"; });'
      + 'document.getElementById("edit").addEventListener("click", () => { location.href = "/opener/list/7?q=" + encodeURIComponent(document.getElementById("q").value); });'
      + '</script>');
  }
  if (path === '/opener/list/7') {
    return page('編集', '<form id="f"><label>件名 <input id="title" name="title"></label><button type="submit">保存</button></form><script>'
      + 'fetch("/opener/api/autosave", { method: "POST", body: location.search }).catch(() => {});'
      + 'document.getElementById("f").addEventListener("submit", (e) => { e.preventDefault(); fetch("/opener/api/items/7", { method: "PATCH",'
      + ' headers: { "content-type": "application/json" }, body: JSON.stringify({ title: document.getElementById("title").value }) }).catch(() => {}); });</script>');
  }
  // ---- op（SREV-COV 再レビューの g・h を写した）: 「保存」の押下で欄に入った値を、ページの JS が覚え、開き手「編集」の移り先の URL に乗せる。
  //      g は保存の時点で覚える。h は input の事象で、空でない値を覚える。k は保存の後にだけ「編集」が出る（目印を入れた後にしか開き手が出ない）。
  //      移り先の編集の画面は、読み込みのときに URL・覚えた値・Cookie を POST と beacon で送り、「更新」で PUT を送る ----
  if (path === '/op/') return page('入口', '<a href="/op/g/items">g</a> <a href="/op/h/items">h</a> <a href="/op/k/items">k</a>');
  {
    const list = /^\/op\/([ghk])\/items$/u.exec(path);
    if (list !== null) return opListOf(list[1] ?? '');
    const edit = /^\/op\/([ghk])\/items\/1$/u.exec(path);
    if (edit !== null) {
      const k = edit[1] ?? '';
      return page('編集の画面', '<label>件名 <input name="title2"></label><button type="button" id="sv2">更新</button><script>'
        + 'const all = location.search + "|" + (localStorage.getItem("draft") || "") + "|" + document.cookie;'
        + `fetch("/op/${k}/api/autosave", { method: "POST", body: all }).catch(() => {}); try { navigator.sendBeacon("/op/${k}/api/autobeacon", all); } catch (x) {}`
        + `document.getElementById("sv2").addEventListener("click", () => { fetch("/op/${k}/api/update", { method: "PUT", body: all }).catch(() => {}); });`
        + '</script>');
    }
  }
  // ---- r3（SREV-COV 3 回目の two・kd を写した） ----
  //  two: 保存の後にだけ「編集」が出る。編集の画面（押下の移り先）にも開き手「詳細」があり、さらに先の画面へ URL の値を渡す。
  //  kd: 「編集」は最初から見えるが、保存の後まで押せない（disabled）。
  //  移り先の画面は、どれも読み込みのときに URL の値を POST と beacon で送る。
  if (path === '/r3/two/items' || path === '/r3/kd/items') {
    const k = path.split('/')[2] ?? '';
    const save = `document.getElementById("sv").addEventListener("click", () => { fetch("/r3/${k}/api/save", { method: "POST", body: document.getElementById("title").value }).catch(() => {});`
      + ' window.__saved = document.getElementById("title").value;';
    const go = `location.href = "/r3/${k}/items/1?t=" + encodeURIComponent(window.__saved || "");`;
    const field = '<label>件名 <input id="title" name="title"></label>';
    if (k === 'kd') {
      return page('一覧', `${field}<button type="button" id="sv">保存</button><button type="button" id="ed" disabled>編集</button><script>`
        + `${save} document.getElementById("ed").disabled = false; }); document.getElementById("ed").addEventListener("click", () => { ${go} });</script>`);
    }
    return page('一覧', `${field}<div id="tools"><button type="button" id="sv">保存</button></div><script>`
      + `${save} if (document.getElementById("ed") === null) { const b = document.createElement("button"); b.type = "button"; b.id = "ed"; b.textContent = "編集";`
      + ` document.getElementById("tools").appendChild(b); b.addEventListener("click", () => { ${go} }); } });</script>`);
  }
  {
    const edit = /^\/r3\/(two|kd)\/items\/1$/u.exec(path);
    if (edit !== null) {
      const k = edit[1] ?? '';
      const opener = k === 'two'
        ? '<button type="button" id="dt">詳細</button><script>document.getElementById("dt").addEventListener("click", () => { location.href = location.pathname + "/2" + location.search; });</script>'
        : '';
      return page('編集の画面', `<p>編集</p>${opener}<script>fetch("/r3/${k}/api/autosave", { method: "POST", body: location.search }).catch(() => {});`
        + ` try { navigator.sendBeacon("/r3/${k}/api/autobeacon", location.search); } catch (x) {}</script>`);
    }
    if (path === '/r3/two/items/1/2') {
      return page('詳細', '<p>詳細</p><script>fetch("/r3/two/api/deep-autosave", { method: "POST", body: location.search }).catch(() => {});'
        + ' try { navigator.sendBeacon("/r3/two/api/deep-beacon", location.search); } catch (x) {}</script>');
    }
  }
  // ---- r4（SREV-COV 4 回目の anc・hop を写した） ----
  //  anc: 入口の画面（読み込みのときに目印のない POST を送る）から、押下で r1?q=<値> へ移る。r1 は読み込みのときに値を POST し、値を別の名前（kw）に載せた
  //       リンク「詳しく」と、ふつうのリンクを作る。「次へ進む」で r2 へ移る。
  //  hop: r1 は読み込みの後に popup を開き、少し後に別の Origin へ移ろうとする。「次へ進む」で r2 へ移る。
  //  先の画面（r2・detail・plain・x・pop）は、読み込みのときに URL を POST と beacon で送る。
  {
    const find = /^\/r4\/(anc|hop)\/find$/u.exec(path);
    if (find !== null) {
      const k = find[1] ?? '';
      return page('さがす', '<label>語 <input id="q" name="q"></label><button type="button" id="go">進む</button><script>'
        + `fetch("/r4/${k}/api/hello", { method: "POST", body: "root-load" }).catch(() => {});`
        + `document.getElementById("go").addEventListener("click", () => { location.href = "/r4/${k}/r1?q=" + encodeURIComponent(document.getElementById("q").value); });</script>`);
    }
  }
  if (path === '/r4/anc/r1') {
    return page('結果', '<div id="links"></div><button type="button" id="nx">次へ進む</button><script>'
      + 'const q = new URLSearchParams(location.search).get("q") || ""; fetch("/r4/anc/api/r1-load", { method: "POST", body: q }).catch(() => {});'
      + 'document.getElementById("links").innerHTML = "<a href=\\"/r4/anc/detail?kw=" + encodeURIComponent(q) + "\\">詳しく</a> <a href=\\"/r4/anc/plain\\">ふつう</a>";'
      + 'document.getElementById("nx").addEventListener("click", () => { location.href = "/r4/anc/r2?p=2"; });</script>');
  }
  if (path === '/r4/hop/r1') {
    return page('結果', '<button type="button" id="nx">次へ進む</button><script>'
      + 'const q = new URLSearchParams(location.search).get("q") || "";'
      + 'try { window.open("/r4/hop/pop?q=" + encodeURIComponent(q)); } catch (e) {}'
      + 'setTimeout(() => { location.href = "http://localhost:" + location.port + "/r4/hop/x?q=" + encodeURIComponent(q); }, 400);'
      + 'document.getElementById("nx").addEventListener("click", () => { location.href = "/r4/hop/r2?p=2"; });</script>');
  }
  {
    const leaf = /^\/r4\/(anc|hop)\/(r2|detail|plain|x|pop)$/u.exec(path);
    if (leaf !== null) {
      const k = leaf[1] ?? '';
      return page('先', `<p>先</p><script>fetch("/r4/${k}/api/autosave", { method: "POST", body: location.pathname + location.search }).catch(() => {});`
        + ` try { navigator.sendBeacon("/r4/${k}/api/autobeacon", location.pathname + location.search); } catch (e) {}</script>`);
    }
  }
  // ---- chain（SREV-COV 3 回目の chain を 3 段にした）: 押下の移り先（目印つきの URL）が、さらに押下で移る。どの移り先も、読み込みのときに URL の値と、
  //      前の画面の URL（document.referrer）を POST で送る ----
  if (path === '/chain/') return page('入口', '<a href="/chain/find">さがす</a>');
  if (path === '/chain/find') {
    return page('さがす', '<label>語 <input id="q" name="q"></label><button type="button" id="go">進む</button><script>'
      + 'document.getElementById("go").addEventListener("click", () => { location.href = "/chain/r1?q=" + encodeURIComponent(document.getElementById("q").value); });</script>');
  }
  {
    const step = /^\/chain\/r([123])$/u.exec(path);
    if (step !== null) {
      const n = Number(step[1]);
      const next = n < 3 ? `<button type="button" id="nx">次へ進む</button><script>document.getElementById("nx").addEventListener("click", () => { location.href = "/chain/r${String(n + 1)}?p=${String(n + 1)}"; });</script>` : '';
      return page(`結果${String(n)}`, `<p>結果</p>${next}<script>fetch("/chain/api/commit${String(n)}", { method: "POST", body: location.search + "|" + document.referrer }).catch(() => {});`
        + ` try { navigator.sendBeacon("/chain/api/beacon${String(n)}", location.search); } catch (x) {}</script>`);
    }
  }
  // ---- single: リンクも押す候補もない 1 画面（最後の画面の後に間隔を待たないことの確かめ） ----
  if (path === '/single/') return page('ひとつ', '<p>この画面だけ</p>');
  // ---- many ----
  if (path === '/many/') return page('入口', '<a href="/many/page">画面</a>');
  if (path === '/many/page') {
    let body = '';
    for (let index = 1; index <= COVERAGE_SAFETY_MANY_BUTTONS; index += 1) {
      body += `<button type="button" class="b" data-i="${String(index)}">表示${String(index)}を見る</button>`;
    }
    return page('多い', `${body}<script>document.querySelectorAll(".b").forEach((b) => b.addEventListener("click", () => {`
      + ' fetch("/many/ping?i=" + b.dataset.i).catch(() => {}); }));</script>');
  }
  // ---- stop ----
  if (path === '/stop/') return page('入口', '<a href="/stop/items/1">項目 1</a> <a href="/stop/items/2">項目 2</a>');
  if (/^\/stop\/items\/\d+$/u.test(path)) {
    return page('登録', '<form id="a"><label>名前 <input id="name" name="name"></label><label>備考 <input id="memo" name="memo"></label>'
      + '<button id="save" type="submit">保存</button></form><form id="b" method="post" action="/stop/api/items"></form><script>'
      + 'document.getElementById("a").addEventListener("submit", (e) => { e.preventDefault(); void fetch("/stop/api/items", { method: "POST",'
      + ' headers: { "content-type": "application/json" }, body: JSON.stringify({ name: document.getElementById("name").value }) }); });'
      + 'window.addEventListener("click", () => { const b = document.getElementById("b"); for (const id of ["name", "memo"]) {'
      + ' const i = document.createElement("input"); i.name = id; i.value = document.getElementById(id).value; b.append(i); }'
      + ' b.append(document.getElementById("save")); }, { capture: true, once: true });</script>');
  }
  // ---- spaq ----
  if (path === '/spaq/') return page('入口', '<a href="/spaq/page">同じ path</a> <a href="/spaq/other">別の path</a>');
  if (path === '/spaq/page' || path === '/spaq/other') {
    const to = path === '/spaq/page' ? '/spaq/page' : '/spaq/results';
    return page('さがす', '<label>語 <input id="q" name="q"></label><button type="button" id="go">進む</button><p id="r"></p><script>'
      + `document.getElementById("go").addEventListener("click", () => { history.pushState(null, "", "${to}?q=" + encodeURIComponent(document.getElementById("q").value));`
      + ' document.getElementById("r").textContent = "済"; });</script>');
  }
  if (path === '/spaq/results') return page('結果', '<p>なし</p>');
  // ---- resume ----
  if (path === '/resume/') {
    return page('入口', '<a href="/resume/find">さがす</a> <a href="/resume/items/1">項目 1</a> <a href="/resume/items/2">項目 2</a> <a href="/resume/items/3">項目 3</a>');
  }
  if (path === '/resume/find') {
    return page('さがす', '<label>語 <input id="q" name="q"></label><button type="button" id="go">進む</button><script>'
      + 'document.getElementById("go").addEventListener("click", () => { location.href = "/resume/results?q=" + encodeURIComponent(document.getElementById("q").value); });</script>');
  }
  if (path === '/resume/results') return page('結果', '<p>なし</p>');
  if (/^\/resume\/items\/\d+$/u.test(path)) {
    return page('項目', '<label>件名 <input name="title"></label><button type="button" id="s">保存</button>'
      + '<script>document.getElementById("s").addEventListener("click", () => {' + writes('resume') + '});</script>');
  }
  return null;
};

/** 仮のサイトの受け手（届いた要求を `arrivals` に入れる）。 */
export const coverageSafetySiteHandler = (arrivals: CoverageSafetyArrival[]) => (request: IncomingMessage, response: ServerResponse): void => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    arrivals.push({
      at: Date.now(), method: request.method ?? '', path: url.pathname, search: url.search, body: Buffer.concat(chunks).toString('utf8'),
      referer: request.headers.referer ?? '', cookie: request.headers.cookie ?? '',
    });
    const html = request.method === 'GET' ? sceneOf(url.pathname) : null;
    if (html !== null) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
      return;
    }
    const known = url.pathname.includes('/ping') || url.pathname.includes('/api/');
    response.writeHead(request.method === 'GET' && !known ? 404 : 200, { 'content-type': 'application/json' });
    response.end('{}');
  });
};
