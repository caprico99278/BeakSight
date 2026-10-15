// T27b（Task 27 の設計書 4.2、6 章）: 発見（`src/discovery/`）の probe・JS の結び付き・落ち着きの待ち・凍結を確かめる、管理画面の形の
// fixture のサーバ（テストの補助）。
// - 127.0.0.1 だけで待ち受ける。サーバに届いた要求を、すべて順に記録する（method、path と query、本文）。テストは、発見の間に届いた要求の数と、
//   GET 以外の要求が 1 件も届かないことを確かめる。
// - 画面（`DISCOVERY_FIXTURE_PATHS`）: 一覧、詳細、GET の検索フォーム、POST の登録フォーム、`_method=PATCH` の更新フォーム、削除のボタン、JS で
//   送るボタン（要素の listener、inline の onsubmit、form の外のボタン）、form の中の送信ボタンでないボタン（T27b round 1）、document の click の委譲、SPA（読み込みの後の GET の応答を待って描く）、
//   落ち着かない SPA、入力の欄のいろいろ（readonly・disabled の fieldset・hidden・select・checkbox・radio・file・送信ボタンの formmethod など）、
//   open な shadow root、closed な shadow root、iframe、DOM clobbering、ページ自身が beacon と fetch の POST を送る画面。
//   T27R-fix-1（DEF-086）: 表の各行のボタンの文字・`aria-label`・`title` に、行の目印（`markers.row`。行の中身の代わり）を置いた画面
//   （`rowButtons`。行ごとの POST の form の送信ボタンと、form の外のボタン）。
//   DEF-087: ページの JS が、標準の getter とメソッドの結果を偽る画面（`forgedCall`: `Function.prototype.call` の上書き（T27R の形）、
//   `forgedPrototype`: prototype の getter の書き換え、`forgedShadow`: open な shadow root の中の削除の form に call の上書き、
//   `forgedStructure`: 表 3 行・一覧 2 項目・dl の画面に、`HTMLCollection` の length と innerText を偽る call の上書き）と、prototype の
//   getter とメソッドに数える仕掛けを置いた画面（`countingHooks`。読み取りの間にページの JS が走った回数を `PAGE_HITS_GLOBAL` に数える）。
// - 値・トークン・選択肢の label には、サーバごとのランダムな目印（`markers`）を入れる。テストは、発見の結果に目印が出ないことを確かめる。
//   トークンは読み込みのたびに変わる（目印の接頭辞はそのまま）。
// - どの画面も、アイコンに `data:` の URL を指定する（ブラウザ自身のアイコンの要求を出さないため）。
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const STATUS_OK = 200;
const STATUS_NO_CONTENT = 204;
const STATUS_NOT_FOUND = 404;
/** 目印の乱数の長さ（バイト）。 */
const MARKER_BYTES = 8;
/** SPA の画面が読み込みの後に送る GET（`/api/items`）に、サーバが応答するまでの時間（ms）。 */
export const SPA_API_DELAY_MS = 600;
/** SPA の画面が、GET の応答を受けてから描くまでの時間（ms）。 */
export const SPA_RENDER_DELAY_MS = 200;
/** 落ち着かない SPA の画面が、候補を描き直す間隔（ms）。 */
export const UNSTABLE_RENDER_INTERVAL_MS = 150;
/** beacon の画面が、読み込みの後に、もう一度 beacon を送るまでの時間（ms。落ち着きの待ちの間に送る）。 */
export const BEACON_REPEAT_DELAY_MS = 700;
/** 入力の欄のいろいろの画面の、選択肢の多い select の選択肢の数（上限 50 を超える）。 */
export const MANY_OPTIONS_COUNT = 53;

/** fixture の画面のパス。 */
export const DISCOVERY_FIXTURE_PATHS = Object.freeze({
  list: '/list',
  detail: '/detail/1',
  search: '/search',
  create: '/create',
  update: '/update',
  remove: '/remove',
  jsBound: '/js-bound',
  jsDelegated: '/js-delegated',
  formButtons: '/form-buttons',
  spa: '/spa',
  spaUnstable: '/spa-unstable',
  controls: '/controls',
  shadowOpen: '/shadow-open',
  shadowClosed: '/shadow-closed',
  iframe: '/iframe',
  frameContent: '/frame-content',
  clobber: '/clobber',
  beacon: '/beacon',
  sender: '/sender',
  rowButtons: '/row-buttons',
  forgedCall: '/forged-call',
  forgedPrototype: '/forged-prototype',
  forgedShadow: '/forged-shadow',
  forgedStructure: '/forged-structure',
  countingHooks: '/counting-hooks',
  apiItems: '/api/items',
  collect: '/collect',
} as const);

/** サーバに届いた要求。 */
export interface DiscoveryFixtureRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/** 目印（値・トークン・選択肢の label・hidden の値）。 */
export interface DiscoveryFixtureMarkers {
  readonly value: string;
  readonly token: string;
  readonly label: string;
  readonly hidden: string;
  /** T27R-fix-1: 表の行の中身の代わり（行のボタンの文字・`aria-label`・`title` に置く）。 */
  readonly row: string;
}

export interface DiscoveryFixture {
  readonly origin: string;
  readonly markers: DiscoveryFixtureMarkers;
  readonly requests: readonly DiscoveryFixtureRequest[];
  url(path: string): string;
  close(): Promise<void>;
}

const marker = (prefix: string): string => `${prefix}${randomBytes(MARKER_BYTES).toString('hex')}`;

const page = (title: string, body: string): string => '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
  + `<link rel="icon" href="data:,"><title>${title}</title></head><body>${body}</body></html>`;

/** DEF-087: 読み取りの間にページの JS が走った回数を数える、ページの global の名前（`countingHooks` と偽りの画面）。 */
export const PAGE_HITS_GLOBAL = '__pageHits';

/** DEF-087: 偽りの的になる削除の form（POST、`_method=DELETE`、ボタン「削除」）。 */
const FORGERY_TARGET_FORM = `
      <form id="del" method="post" action="/items/1">
        <input type="hidden" name="_method" value="DELETE">
        <input type="hidden" name="authenticity_token" value="tok-forgery">
        <button type="submit">削除</button>
      </form>`;

/** DEF-087: 構造の読み取りの的（表 3 行（見出しの行を除く）、一覧 2 項目、詳細 1 項目）。 */
const FORGERY_TARGET_STRUCTURE = `<main><table><tbody><tr><th>h</th></tr><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>3</td></tr></tbody></table>
      <ul><li>a</li><li>b</li></ul><dl><dt>状態</dt><dd>有効</dd></dl></main>`;

/**
 * DEF-087（T27R の形）: `Function.prototype.call` を上書きし、標準の getter（form の method・action、input の value、Node の textContent）を
 * `call` で呼ぶ読み取りに、偽の値（GET の検索の form）を返す。
 */
const FORGE_BY_CALL_SCRIPT = `window.${PAGE_HITS_GLOBAL} = 0;
      (() => {
        const getterOf = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
        const apply = Reflect.apply;
        const fakes = new Map([
          [getterOf(HTMLFormElement.prototype, 'method'), () => 'get'],
          [getterOf(HTMLFormElement.prototype, 'action'), () => location.origin + '${DISCOVERY_FIXTURE_PATHS.search}'],
          [getterOf(HTMLInputElement.prototype, 'value'), () => ''],
          [getterOf(Node.prototype, 'textContent'), () => '検索'],
        ]);
        Function.prototype.call = function (thisArg, ...args) {
          const fake = fakes.get(this);
          if (fake) { window.${PAGE_HITS_GLOBAL} += 1; return fake(); }
          return apply(this, thisArg, args);
        };
      })();`;

/** DEF-087: prototype の getter を、偽の値（GET の検索の form）を返す getter に書き換える。 */
const FORGE_BY_PROTOTYPE_SCRIPT = `window.${PAGE_HITS_GLOBAL} = 0;
      (() => {
        const define = (prototype, name, fake) => Object.defineProperty(prototype, name, {
          configurable: true, enumerable: true, get() { window.${PAGE_HITS_GLOBAL} += 1; return fake(); },
        });
        define(HTMLFormElement.prototype, 'method', () => 'get');
        define(HTMLFormElement.prototype, 'action', () => location.origin + '${DISCOVERY_FIXTURE_PATHS.search}');
        define(Node.prototype, 'textContent', () => '検索');
        define(HTMLInputElement.prototype, 'value', () => '');
      })();`;

/** DEF-087: `Function.prototype.call` を上書きし、`HTMLCollection` の length（1 までに減らす）と innerText（偽の文字）を偽る。 */
const FORGE_STRUCTURE_SCRIPT = `window.${PAGE_HITS_GLOBAL} = 0;
      (() => {
        const getterOf = (prototype, name) => Object.getOwnPropertyDescriptor(prototype, name).get;
        const apply = Reflect.apply;
        const length = getterOf(HTMLCollection.prototype, 'length');
        const innerText = getterOf(HTMLElement.prototype, 'innerText');
        Function.prototype.call = function (thisArg, ...args) {
          if (this === length) { window.${PAGE_HITS_GLOBAL} += 1; return Math.min(apply(length, thisArg, []), 1); }
          if (this === innerText) { window.${PAGE_HITS_GLOBAL} += 1; return '偽の文字'; }
          return apply(this, thisArg, args);
        };
      })();`;

/**
 * DEF-087: 数える仕掛け。prototype の getter とメソッド、`Function.prototype.call` を、元の振る舞いのまま、呼ばれた回数を数える形に包む
 * （読み取りの間にページの JS が走れば、数が増える）。
 */
const COUNTING_HOOKS_SCRIPT = `window.${PAGE_HITS_GLOBAL} = 0;
      (() => {
        const apply = Reflect.apply;
        for (const [prototype, name] of [
          [Element.prototype, 'localName'], [Element.prototype, 'shadowRoot'], [Node.prototype, 'textContent'], [Node.prototype, 'parentNode'],
          [HTMLFormElement.prototype, 'method'], [HTMLFormElement.prototype, 'action'], [HTMLElement.prototype, 'innerText'],
          [HTMLCollection.prototype, 'length'], [Document.prototype, 'documentElement'],
        ]) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
          Object.defineProperty(prototype, name, { ...descriptor, get() { window.${PAGE_HITS_GLOBAL} += 1; return apply(descriptor.get, this, []); } });
        }
        for (const [prototype, name] of [
          [Element.prototype, 'getAttribute'], [Element.prototype, 'hasAttribute'], [Element.prototype, 'checkVisibility'],
          [Element.prototype, 'getBoundingClientRect'], [Element.prototype, 'matches'], [Element.prototype, 'closest'],
          [Document.prototype, 'createTreeWalker'], [Document.prototype, 'querySelector'], [Document.prototype, 'querySelectorAll'],
        ]) {
          const original = prototype[name];
          prototype[name] = function (...args) { window.${PAGE_HITS_GLOBAL} += 1; return apply(original, this, args); };
        }
        const call = Function.prototype.call;
        Function.prototype.call = function (thisArg, ...args) { window.${PAGE_HITS_GLOBAL} += 1; return apply(call, this, [thisArg, ...args]); };
      })();`;

/** 画面の HTML（トークンは呼ぶたびに変わる）。 */
const pageBodies = (markers: DiscoveryFixtureMarkers): Readonly<Record<string, () => string>> => {
  const token = (): string => `${markers.token}${randomBytes(MARKER_BYTES).toString('hex')}`;
  const manyOptions = Array.from({ length: MANY_OPTIONS_COUNT }, (_value, index) => `<option value="o${index}">${markers.label}${index}</option>`).join('');
  return {
    [DISCOVERY_FIXTURE_PATHS.list]: () => page('一覧', '<h1>一覧</h1><table><tr><td><a href="/detail/1">項目 1</a></td></tr></table>'),
    [DISCOVERY_FIXTURE_PATHS.detail]: () => page('詳細', '<h1>詳細</h1><dl><dt>名前</dt><dd>項目 1</dd></dl>'),
    [DISCOVERY_FIXTURE_PATHS.search]: () => page('検索', `
      <form id="search" method="get" action="/items">
        <input type="search" name="q" value="${markers.value}" required maxlength="50" pattern="[^&lt;&gt;]*">
        <select name="category"><option value="">${markers.label}すべて</option><option value="a" selected>${markers.label}A</option><option>${markers.label}NoValue</option></select>
        <label><input type="checkbox" name="in_stock" value="1" checked>${markers.label}</label>
        <label><input type="radio" name="sort" value="new">${markers.label}</label><label><input type="radio" name="sort">${markers.label}</label>
        <button type="submit">検索</button>
      </form>`),
    [DISCOVERY_FIXTURE_PATHS.create]: () => page('登録', `
      <form id="create" method="post" action="/items">
        <input type="hidden" name="authenticity_token" value="${token()}">
        <input type="text" name="name" required value="${markers.value}">
        <input type="email" name="email">
        <textarea name="note">${markers.value}</textarea>
        <button type="submit">登録</button>
      </form>`),
    [DISCOVERY_FIXTURE_PATHS.update]: () => page('更新', `
      <form id="update" method="post" action="/items/1">
        <input type="hidden" name="_method" value=" patch ">
        <input type="hidden" name="authenticity_token" value="${token()}">
        <input type="text" name="name" value="${markers.value}">
        <button type="submit">保存</button>
      </form>`),
    [DISCOVERY_FIXTURE_PATHS.remove]: () => page('削除', `
      <form id="remove" method="post" action="/items/1">
        <input type="hidden" name="_method" value="delete">
        <input type="hidden" name="authenticity_token" value="${token()}">
        <button type="submit">削除</button>
      </form>`),
    [DISCOVERY_FIXTURE_PATHS.jsBound]: () => page('JS', `
      <form id="element" method="post" action="/messages"><input type="text" name="body"><button type="submit">送る</button></form>
      <form id="inline" method="post" action="/notes" onsubmit="return false"><input type="text" name="memo"><button type="submit">メモ</button></form>
      <button type="button" id="outside-bound">実行</button>
      <button type="button" id="outside-plain">閉じる</button>
      <div role="button" id="role-button">開く</div>
      <script>
        document.getElementById('element').addEventListener('submit', (event) => { event.preventDefault(); });
        document.getElementById('outside-bound').addEventListener('click', () => {});
      </script>`),
    [DISCOVERY_FIXTURE_PATHS.formButtons]: () => page('form の中のボタン', `
      <form id="draft" method="post" action="/drafts">
        <input type="text" name="title" value="${markers.value}">
        <button type="submit">登録</button>
        <button type="button" id="send-by-script">下書きを送る</button>
        <button type="button">プレビュー</button>
        <input type="button" value="計算">
        <button type="reset">クリア</button>
        <input type="reset">
        <div role="button">開く</div>
        <button type="button">削除</button>
      </form>
      <script>
        document.getElementById('send-by-script').addEventListener('click', () => {
          void fetch('${DISCOVERY_FIXTURE_PATHS.collect}', { method: 'POST', body: 'draft' }).catch(() => {});
        });
      </script>`),
    [DISCOVERY_FIXTURE_PATHS.jsDelegated]: () => page('委譲', `
      <form id="find" method="get" action="/items"><input type="search" name="q"><button type="submit">検索</button></form>
      <form id="add" method="post" action="/items"><input type="text" name="name"><button type="submit">追加</button></form>
      <script>document.addEventListener('click', () => {});</script>`),
    [DISCOVERY_FIXTURE_PATHS.spa]: () => page('SPA', `
      <div id="app"></div>
      <script>
        fetch('${DISCOVERY_FIXTURE_PATHS.apiItems}').then((response) => response.text()).then(() => {
          setTimeout(() => {
            document.getElementById('app').innerHTML = '<form method="get" action="/items"><input type="search" name="q"><button type="submit">検索</button></form>';
          }, ${SPA_RENDER_DELAY_MS});
        });
      </script>`),
    [DISCOVERY_FIXTURE_PATHS.spaUnstable]: () => page('SPA', `
      <div id="app"></div>
      <script>
        let round = 0;
        setInterval(() => {
          round += 1;
          document.getElementById('app').innerHTML = '<form method="get" action="/items"><input type="search" name="q' + round + '"><button type="submit">検索</button></form>';
        }, ${UNSTABLE_RENDER_INTERVAL_MS});
      </script>`),
    [DISCOVERY_FIXTURE_PATHS.controls]: () => page('入力', `
      <form id="settings" method="post" action="/settings" enctype="multipart/form-data" target="_self">
        <input type="hidden" name="csrf" value="${token()}">
        <input type="hidden" name="secret_hidden" value="${markers.hidden}">
        <input type="text" name="title" value="${markers.value}" readonly>
        <fieldset disabled><input type="text" name="locked" value="${markers.value}"></fieldset>
        <input type="text" name="invisible" style="display:none">
        <input type="number" name="count" min="1" max="10" step="1">
        <input type="email" name="mail" autocomplete="email" minlength="3">
        <input type="file" name="upload">
        <select name="many">${manyOptions}</select>
        <select name="multi" multiple><option value="x" selected>${markers.label}</option></select>
        <input type="checkbox" name="active" value="yes">
        <textarea name="body">${markers.value}</textarea>
        <input type="unknowntype" name="weird">
        <input type="text">
        <button type="submit" name="op" value="${markers.hidden}" formmethod="get" formaction="/preview?mode=1&amp;lang=ja" formenctype="text/plain" formtarget="preview">プレビュー</button>
        <input type="submit" value="保存">
        <button type="reset">戻す</button>
        <button type="button">ボタン</button>
      </form>`),
    [DISCOVERY_FIXTURE_PATHS.shadowOpen]: () => page('open', `
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
          '<form method="get" action="/items"><input type="search" name="q"><button type="submit">検索</button></form>';
      </script>`),
    [DISCOVERY_FIXTURE_PATHS.shadowClosed]: () => page('closed', `
      <form method="get" action="/items"><input type="search" name="q"><button type="submit">検索</button></form>
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({ mode: 'closed' }).innerHTML =
          '<form method="post" action="/hidden"><input type="text" name="z"><button type="submit">登録</button></form>';
      </script>`),
    [DISCOVERY_FIXTURE_PATHS.iframe]: () => page('iframe', `
      <form method="get" action="/items"><input type="search" name="q"><button type="submit">検索</button></form>
      <iframe src="${DISCOVERY_FIXTURE_PATHS.frameContent}"></iframe>`),
    [DISCOVERY_FIXTURE_PATHS.frameContent]: () => page('frame', '<form method="post" action="/framed"><input type="text" name="f"><button type="submit">登録</button></form>'),
    [DISCOVERY_FIXTURE_PATHS.clobber]: () => page('clobber', `
      <img name="createTreeWalker" alt=""><img name="querySelector" alt=""><img name="documentElement" alt=""><img name="getElementById" alt="">
      <form name="readyState"></form>
      <form id="clobbered" method="post" action="/clobbered">
        <input name="action" value="/evil"><input name="method" value="get"><input name="elements"><input name="attributes">
        <input name="getAttribute"><input name="hasAttribute"><input name="enctype" value="text/plain"><input name="target" value="_blank">
        <input name="children"><input name="localName"><input name="nodeType"><input name="parentNode"><input name="submit"><input name="id">
        <button type="submit">登録</button>
      </form>`),
    [DISCOVERY_FIXTURE_PATHS.beacon]: () => page('beacon', `
      <form method="get" action="/items"><input type="search" name="q"><button type="submit">検索</button></form>
      <script>
        navigator.sendBeacon('${DISCOVERY_FIXTURE_PATHS.collect}', 'load');
        fetch('${DISCOVERY_FIXTURE_PATHS.collect}', { method: 'POST', body: 'load-fetch', keepalive: true }).catch(() => {});
        setTimeout(() => { navigator.sendBeacon('${DISCOVERY_FIXTURE_PATHS.collect}', 'repeat'); }, ${BEACON_REPEAT_DELAY_MS});
      </script>`),
    // T27R-fix-1（DEF-086）: 行ごとに、文字に目印を置いた送信ボタン（更新の語）、`aria-label` に目印を置いた送信ボタン（危険な語）、`title` に
    // 目印を置いた form の外のボタン（検索の語）。語は、probe がそれぞれの所の文言を読んだ証拠になる。
    [DISCOVERY_FIXTURE_PATHS.rowButtons]: () => page('行のボタン', `<table><tbody>${[1, 2, 3].map((index) => `<tr><td>${markers.row}-${index}</td><td>
      <form method="post" action="/rows/edit"><button type="submit">${markers.row}-${index} を編集</button></form>
      <form method="post" action="/rows/remove"><button type="submit" aria-label="${markers.row}-${index} を削除">×</button></form>
      <button type="button" title="${markers.row}-${index} を検索">…</button></td></tr>`).join('')}</tbody></table>`),
    // DEF-087: どの偽りの画面も、修正の前は、削除の form を GET の検索の form（`READ_GET_FORM`）と読ませる。
    [DISCOVERY_FIXTURE_PATHS.forgedCall]: () => page('偽り call', `${FORGERY_TARGET_FORM}
      <input type="file" form="del" name="up"><script>${FORGE_BY_CALL_SCRIPT}</script>`),
    [DISCOVERY_FIXTURE_PATHS.forgedPrototype]: () => page('偽り prototype', `${FORGERY_TARGET_FORM}
      <input type="file" form="del" name="up"><script>${FORGE_BY_PROTOTYPE_SCRIPT}</script>`),
    [DISCOVERY_FIXTURE_PATHS.forgedShadow]: () => page('偽り shadow', `<div id="host"></div>
      <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(FORGERY_TARGET_FORM)};</script>
      <script>${FORGE_BY_CALL_SCRIPT}</script>`),
    [DISCOVERY_FIXTURE_PATHS.forgedStructure]: () => page('偽り 構造', `${FORGERY_TARGET_STRUCTURE}<script>${FORGE_STRUCTURE_SCRIPT}</script>`),
    [DISCOVERY_FIXTURE_PATHS.countingHooks]: () => page('数える仕掛け', `${FORGERY_TARGET_FORM}<div id="host"></div>${FORGERY_TARGET_STRUCTURE}
      <script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button type="button">開く</button>';</script>
      <script>${COUNTING_HOOKS_SCRIPT}</script>`),
    [DISCOVERY_FIXTURE_PATHS.sender]: () => page('sender', `
      <form id="send" method="post" action="${DISCOVERY_FIXTURE_PATHS.collect}"><input type="text" name="m" value="form"><button type="submit">送る</button></form>`),
  };
};

const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolveBody) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  request.on('error', () => resolveBody(''));
});

/** fixture のサーバを 127.0.0.1 で起動する。 */
export async function startDiscoveryFixture(): Promise<DiscoveryFixture> {
  const markers: DiscoveryFixtureMarkers = Object.freeze({
    value: marker('val'),
    token: marker('tok'),
    label: marker('lbl'),
    hidden: marker('hid'),
    row: marker('row'),
  });
  const bodies = pageBodies(markers);
  const requests: DiscoveryFixtureRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async (): Promise<void> => {
      const path = request.url ?? '/';
      const body = await readBody(request);
      requests.push({ method: request.method ?? '', path, body });
      const pathname = path.split('?')[0] ?? path;
      if (pathname === DISCOVERY_FIXTURE_PATHS.apiItems) {
        setTimeout(() => {
          response.writeHead(STATUS_OK, { 'content-type': 'application/json' });
          response.end('[]');
        }, SPA_API_DELAY_MS);
        return;
      }
      if (pathname === DISCOVERY_FIXTURE_PATHS.collect) {
        response.writeHead(STATUS_NO_CONTENT);
        response.end();
        return;
      }
      const render = bodies[pathname];
      if (render === undefined) {
        response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page('404', 'not found'));
        return;
      }
      response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(render());
    })();
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    markers,
    requests,
    url: (path: string): string => `${origin}${path}`,
    close: () => new Promise<void>((resolveClose) => {
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}
