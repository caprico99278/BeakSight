// T27d（Task 27 の設計書 4.2、4.6、6 章）: 発見のジョブ（`DISCOVERY`）を、ログインの画面から管理画面の巡回まで確かめる fixture のサーバ（テストの
// 補助）。T27b の画面の fixture（`discovery-fixture.ts`）の画面の種類（一覧、詳細、GET の検索、POST の登録、`_method` の更新・削除、JS のボタン、
// SPA、ページ自身の beacon）を、ログインと、管理画面の下の巡回の形（リンクでつないだ画面）にしたもの。
// - 127.0.0.1 だけで待ち受ける。サーバに届いた要求を、すべて順に記録する（method、path と query、届いた時刻、管理画面の HTML か、有効な
//   セッションを持っていたか）。本文と Cookie の値は記録しない。
// - ログイン（`AUTH_SITE_LOGIN_FIELDS` と同じ欄の形。手動のログインはテストの口が、自動ログインは BeakSight が入力する）: GET `/login` は、CSRF の
//   hidden と資格情報の欄のフォーム。正しい資格情報と CSRF の POST なら、新しいセッションの Cookie を付けて `/admin` へ 303。誤りなら
//   `/login-error` の画面（`#invalid`）。管理画面は、読み込みのときに localStorage に秘密の目印を書く。
// - 管理画面（`/admin` の下）は、セッションがなければ `/login?expired=1` へ 303。ログアウト（読まないパス）と、危険な語のパス（削除）は、届いたら
//   セッションを壊す（テストは、届かないことを確かめる）。読む範囲の外（`/public`）も、届かないことを確かめる。
// - 変える口: `setVariant('changed')`（画面 `variant` の 1 つ目の form の欄を必須にし、2 つ目の form を消す。ドリフトの `CHANGED`・`MISSING`）、
//   `expireAfterAdminPages`（管理画面の HTML をこの数まで読んだら、セッションを切る。セッションの切れ）。
// - 秘密の目印（`secretValues()`）: セッションの値、localStorage の値、資格情報、CSRF の値、入力の値、hidden の値、選択肢の label。発見の結果・
//   索引・IPC・ワーカーの出力に出ないことを確かめる。値は出力しない。
// - T27e（READ の確かめ）: `readCheckPages` を真にすると、管理画面に READ の確かめの画面を足す（偽なら今までと同じ）: 注文の一覧と GET の検索
//   フォーム（`q` と `status` の select。CSRF のトークンと hidden の値つき。結果の行の数が値で変わる）、詳細（`dl`）を返す照会のフォーム、4xx・5xx を
//   返す検索、形を変えられる検索（`setShape`: 欄を足す・POST に変える・JS の結び付きを足す、CCX-10: 欄を見えなくする・readonly にする・
//   disabled にする）、秘密に見える名前の欄のある検索、読まないパス（`privateArea`。テストが認証の設定の読まないパスに入れる）へ送る検索。
// - T27R-fix-1（DEF-086、T27R の I2）: 注文の一覧の各行に、ボタンの文字・`aria-label`・`title` に行の目印（`markers.row`）を置いた form の外の
//   ボタンを足す（行の中身がボタンの文言として発見の結果と画面に出ないことを確かめる。どれも form の外のボタンなので、画面の FORM の候補は
//   検索フォームの 1 つのまま）。
// - T27R2 の I3: `markerShapes` を真にすると、画面 `DISCOVERY_SITE_EXTRA_PATHS.markerShapes`（`/admin` からリンク）を足す。行の目印
//   （`markers.row`）を、form の中の送信ボタンの `value`（`input type=submit`）、画像の送信ボタンの `alt`、`<label>`（`for` と、要素を包む形）、
//   `aria-labelledby`・`aria-describedby` の指す要素の文字に置いた GET の form 3 つ（`DISCOVERY_SITE_MARKER_SHAPE_IDS`）。目印は、probe が分類の語を
//   求めるために読む所（`value`・`alt`）と、読まない所（ラベルと ARIA の参照）の両方にあり、どれも欄の名前・送信先・制約には置かない（それらは
//   ページの書いた値として成果物に出る）。
// - T27R2 の C1: `pollingPages` を真にすると、ポーリングの画面（`DISCOVERY_SITE_POLLING_PAGES`。互いにリンクし、`/admin` からはリンクしない）を
//   足す。どの画面も、`DISCOVERY_SITE_POLLING_INTERVAL_MS` ごとに同じ Origin の `DISCOVERY_SITE_EXTRA_PATHS.pollApi` へ GET を送り、サーバは
//   `DISCOVERY_SITE_POLLING_RESPONSE_DELAY_MS` 待って応答する（閉じるときに進行中の要求がありうる形）。
// - DEF-136: `setPageFault(path, fault)` で、管理画面の 1 つの画面（セッションの確かめの後）を不調にする: 指定の状態（503・500・404 など）を返す
//   （本文に、ほかの画面へのリンクと GET の form を持つ。`times` の回数だけ。省略は毎回）、接続を切る（`REFUSE`。応答なしで socket を壊す）、応答しない
//   （`HANG`。閉じるまで応答しない）。届いた要求は管理画面の HTML の要求として記録する。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { startLoopbackHttpServer } from './loopback-server.js';

const STATUS_OK = 200;
const STATUS_NO_CONTENT = 204;
const STATUS_SEE_OTHER = 303;
const STATUS_NOT_FOUND = 404;
const STATUS_SERVER_ERROR = 500;
const RANDOM_VALUE_BYTES = 12;
/** SPA の画面が読み込みの後に送る GET に、サーバが応答するまでの時間（ms）。 */
const SPA_API_DELAY_MS = 300;
/** 1 画素の透明な GIF（`data:` の URL。画像の送信ボタンの `src`。ネットワークを使わない）。 */
const PIXEL_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** T27R2 の C1: ポーリングの画面が GET を送る間隔（ms）。 */
export const DISCOVERY_SITE_POLLING_INTERVAL_MS = 100;
/** T27R2 の C1: ポーリングの GET に、サーバが応答するまでの時間（ms。間隔より短くし、要求が重ならないようにする）。 */
export const DISCOVERY_SITE_POLLING_RESPONSE_DELAY_MS = 60;

/** セッションの Cookie の名前。 */
export const DISCOVERY_SITE_SESSION_COOKIE = 'sid';
/** localStorage の項目の名前（値は秘密の目印）。 */
export const DISCOVERY_SITE_LOCAL_STORAGE_ITEM = 'ls_token';

/** ログインのフォームの欄のセレクタ（`authenticated-site-fixture.ts` の `AUTH_SITE_LOGIN_FIELDS` と同じ形）。 */
export const DISCOVERY_SITE_LOGIN_FIELDS = Object.freeze({ user: '#user', pass: '#pass', submit: '#go' } as const);

/** fixture のパス。 */
export const DISCOVERY_SITE_PATHS = Object.freeze({
  login: '/login',
  loginError: '/login-error',
  admin: '/admin',
  list: '/admin/list',
  detail: '/admin/detail/1',
  search: '/admin/search',
  create: '/admin/create',
  /**
   * 更新の form の画面（T31R2-fix-1: レコードの ID の区切りを持つ path。送信先 `/admin/items/1` と同じ `1` の区切りで、UPDATE の path の型が
   * 台帳の登録の ID の型 `/admin/items/{id}` に結び付く。前の `/admin/update` は ID の区切りがなく、`admin` の区切りを ID とみなす型しか作れなかった）。
   */
  update: '/admin/items/1/edit',
  /** 削除の form の画面（path は危険な語に当たらない名前。リンクの危険な語は `danger`）。 */
  remove: '/admin/erase',
  js: '/admin/js',
  spa: '/admin/spa',
  api: '/admin/api/items',
  variant: '/admin/variant',
  duplicate: '/admin/duplicate',
  beacon: '/admin/beacon',
  collect: '/admin/collect',
  logout: '/admin/logout',
  danger: '/admin/items/1/delete',
  outside: '/public',
} as const);

/** 巡回で読む管理画面（開始の `/admin` を含む。リンクでつながっている）。 */
export const DISCOVERY_SITE_READ_PAGES: readonly string[] = Object.freeze([
  DISCOVERY_SITE_PATHS.admin,
  DISCOVERY_SITE_PATHS.list,
  DISCOVERY_SITE_PATHS.search,
  DISCOVERY_SITE_PATHS.create,
  DISCOVERY_SITE_PATHS.update,
  DISCOVERY_SITE_PATHS.remove,
  DISCOVERY_SITE_PATHS.js,
  DISCOVERY_SITE_PATHS.spa,
  DISCOVERY_SITE_PATHS.variant,
  DISCOVERY_SITE_PATHS.duplicate,
  DISCOVERY_SITE_PATHS.beacon,
  DISCOVERY_SITE_PATHS.detail,
]);

/** 届いてはならないパス（読まないパス、危険な語、読む範囲の外）。 */
export const DISCOVERY_SITE_FORBIDDEN_PATHS: readonly string[] = Object.freeze([
  DISCOVERY_SITE_PATHS.logout,
  DISCOVERY_SITE_PATHS.danger,
  DISCOVERY_SITE_PATHS.outside,
]);

/** T27R2: 選んだときだけ足す画面のパス（`markerShapes`、`pollingPages`）。 */
export const DISCOVERY_SITE_EXTRA_PATHS = Object.freeze({
  /** 行の目印をボタンとラベルの形に置いた画面（`markerShapes`）。 */
  markerShapes: '/admin/labels',
  /** ポーリングの画面が GET を送る先（`pollingPages`。管理画面の HTML ではない）。 */
  pollApi: '/admin/api/poll',
} as const);

/** T27R2 の C1: ポーリングの画面（`pollingPages`。1 つ目から互いにリンクでつながる）。 */
export const DISCOVERY_SITE_POLLING_PAGES: readonly string[] = Object.freeze(['/admin/poll/1', '/admin/poll/2', '/admin/poll/3']);

/** T27R2 の I3: 行の目印を置いた所の要素の id（`markerShapes` の画面。main world の確かめに使う）。 */
export const DISCOVERY_SITE_MARKER_SHAPE_IDS = Object.freeze({
  /** `value` に目印のある `input type=submit`。 */
  submitValue: 'shape-submit-value',
  /** `alt` に目印のある `input type=image`。 */
  imageAlt: 'shape-image-alt',
  /** `<label for>` の指す欄（ラベルの文字に目印）。 */
  labelFor: 'shape-label-for',
  /** `<label>` が包む欄（ラベルの文字に目印）。 */
  labelWrapped: 'shape-label-wrapped',
  /** `aria-labelledby` と `aria-describedby` を持つ欄（指す要素の文字に目印）。 */
  ariaField: 'shape-aria-field',
  /** `aria-labelledby` と `aria-describedby` を持つ送信ボタン（指す要素の文字に目印。ボタンの文字には目印を置かない）。 */
  ariaButton: 'shape-aria-button',
} as const);

/** 画面 `variant` の形。 */
export type DiscoverySiteVariant = 'base' | 'changed';

/** T27e: READ の確かめの画面のパス（`readCheckPages` のときだけ）。 */
export const DISCOVERY_SITE_READ_CHECK_PATHS = Object.freeze({
  /** 注文の一覧と GET の検索フォーム（送信先は自分）。 */
  orders: '/admin/orders',
  /** 照会のフォーム（GET。送信先は `order`）。 */
  lookup: '/admin/lookup',
  /** 照会の結果（`dl`）。 */
  order: '/admin/order',
  /** 4xx・5xx を返す検索のフォーム（GET。送信先は `broken`）。 */
  brokenSearch: '/admin/broken-search',
  /** `kind=missing` で 404、`kind=error` で 500 を返す。 */
  broken: '/admin/broken',
  /** 形を変えられる検索のフォーム（GET。送信先は `orders`）。 */
  shape: '/admin/shape',
  /** 秘密に見える名前の欄（`api_key`）のある検索のフォーム（GET。送信先は `orders`）。 */
  secretSearch: '/admin/secret-search',
  /** 読まないパス（`privateArea`。テストが認証の設定の読まないパスに入れる）へ送る検索のフォーム（GET）。 */
  exitSearch: '/admin/exit-search',
  /** 読まないパスの前方一致（テストが認証の設定の `excludedPaths` に入れる。危険な語を含まないので、発見の分類は READ のまま）。 */
  privateArea: '/admin/private',
} as const);

/** T27e: 注文の一覧の行（テストの値。秘密ではない）。`q` は名前を含む、`status` は同じ値で絞る。 */
export const DISCOVERY_SITE_ORDERS = Object.freeze([
  Object.freeze({ id: 'A-1', name: 'りんご', status: 'open' }),
  Object.freeze({ id: 'A-2', name: 'みかん', status: 'open' }),
  Object.freeze({ id: 'A-3', name: 'りんごジュース', status: 'closed' }),
]);

/**
 * T27e: 形を変えられる検索の形（`base`: そのまま、`extra-field`: 欄を足す、`post`: POST に変える、`bound`: JS の submit の結び付きを足す）。
 * CCX-10: `hidden-field`（欄 `q` を CSS で見えなくする）、`readonly-field`（欄 `q` を readonly にする）、`disabled-field`（欄 `q` を disabled に
 * する）。どれも欄の名前・tag・type を変えないので、識別の digest は `base` と同じ（送れる欄かだけが変わる）。
 */
export type DiscoverySiteShape = 'base' | 'extra-field' | 'post' | 'bound' | 'hidden-field' | 'readonly-field' | 'disabled-field';

/** CCX-10: 欄 `q` に付ける属性（送れる欄でなくする形だけ）。 */
const SHAPE_QUERY_FIELD_ATTRIBUTES: Readonly<Partial<Record<DiscoverySiteShape, string>>> = Object.freeze({
  'hidden-field': ' style="display:none"',
  'readonly-field': ' readonly',
  'disabled-field': ' disabled',
});

/** サーバに届いた要求の記録。 */
export interface DiscoverySiteRequest {
  readonly method: string;
  /** path と query。 */
  readonly path: string;
  /** 届いた時刻（`Date.now()`）。 */
  readonly at: number;
  /** 管理画面の HTML の要求（巡回の読み込み）か。 */
  readonly adminDocument: boolean;
  /** 有効なセッションを持っていたか（管理画面の要求だけ）。 */
  readonly authenticated: boolean;
}

/** DEF-136: 不調の画面（`STATUS`）の本文にだけあるリンク（ほかの画面からはリンクしない。発見がエラーの画面からリンクを拾わないことを確かめる）。 */
export const DISCOVERY_SITE_FAULT_LINK = '/admin/fault-only';

/**
 * DEF-136: 画面の不調（`setPageFault`）。`STATUS` は `status` の応答（`times` の回数だけ。省略は毎回。回数を使い切ったら、ふつうの画面に戻る）、
 * `REFUSE` は応答なしで接続を切る、`HANG` は閉じるまで応答しない。
 */
export type DiscoverySitePageFault =
  | { readonly kind: 'STATUS'; readonly status: number; readonly times?: number }
  | { readonly kind: 'REFUSE' }
  | { readonly kind: 'HANG' };

export interface DiscoverySiteOptions {
  /** 管理画面の HTML を、この数まで読んだら、セッションを期限切れにする（セッションの切れ）。 */
  readonly expireAfterAdminPages?: number;
  /** T27e: READ の確かめの画面を足す（省略・偽なら、今までと同じ画面だけ）。 */
  readonly readCheckPages?: boolean;
  /** T27R2 の I3: 行の目印をボタンとラベルの形に置いた画面を足す（`/admin` からリンク。省略・偽なら足さない）。 */
  readonly markerShapes?: boolean;
  /** T27R2 の C1: ポーリングの画面を足す（`/admin` からはリンクしない。省略・偽なら足さない）。 */
  readonly pollingPages?: boolean;
}

export interface DiscoverySite {
  readonly origin: string;
  readonly requests: readonly DiscoverySiteRequest[];
  /** 新しいセッションを作り、その値を返す（ログインの段を通さない結合テストの状態の組み立てに使う。値を出力しない）。 */
  issueSession(): string;
  /** 画面 `variant` の形を替える。 */
  setVariant(variant: DiscoverySiteVariant): void;
  /** T27e: 形を変えられる検索（`DISCOVERY_SITE_READ_CHECK_PATHS.shape`）の形を替える。 */
  setShape(shape: DiscoverySiteShape): void;
  /** T27e: 管理画面のセッションを、今すぐすべて期限切れにする（セッションの切れ）。 */
  expireSessions(): void;
  /** DEF-136: 管理画面の `path` の画面を不調にする（null で戻す）。 */
  setPageFault(path: string, fault: DiscoverySitePageFault | null): void;
  /** ページの欄に、正しい資格情報を入れる（値はテストに返さない）。 */
  fillCredentials(fill: (selector: string, value: string) => Promise<void>): Promise<void>;
  /** 正しい資格情報でログインした回数。 */
  readonly successfulLogins: number;
  /** 秘密の目印のすべて（目印の検査にだけ使う。値を出力しない）。 */
  secretValues(): readonly string[];
  /**
   * FM2d: 秘密の目印のうち、ログインの状態と資格情報のもの（セッションの値、資格情報、localStorage の値）だけ。監査の成果物（見えている文と form の値を残す）の
   * 検索に使う（値を出力しない）。
   */
  loginStateValues(): readonly string[];
  close(): Promise<void>;
}

const randomValue = (): string => randomBytes(RANDOM_VALUE_BYTES).toString('hex');

function cookiesOf(request: IncomingMessage): Map<string, string> {
  return new Map((request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as const));
}

function sendHtml(response: ServerResponse, title: string, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"></head>`
    + `<body><main>${body}</main></body></html>`);
}

/** fixture のサーバを 127.0.0.1 で起動する。 */
export async function startDiscoverySite(options: DiscoverySiteOptions = {}): Promise<DiscoverySite> {
  const sessions = new Map<string, { adminPages: number }>();
  const issued: string[] = [];
  const tokens: string[] = [];
  const requests: DiscoverySiteRequest[] = [];
  const credentials = { user: `u${randomValue()}`, pass: `p${randomValue()}` };
  const markers = {
    value: `val${randomValue()}`,
    hidden: `hid${randomValue()}`,
    label: `lbl${randomValue()}`,
    storage: `ls${randomValue()}`,
    // T27e: 注文の一覧の各行の備考（表の全体を成果物に写していないことを確かめる目印）。
    row: `row${randomValue()}`,
  };
  let csrf = randomValue();
  /** DEF-136: 不調にした画面（path → 不調）と、応答していない応答。 */
  const faults = new Map<string, DiscoverySitePageFault>();
  const hanging = new Set<ServerResponse>();
  let variant: DiscoverySiteVariant = 'base';
  let shape: DiscoverySiteShape = 'base';
  let successfulLogins = 0;
  let port = 0;
  const origin = (): string => `http://127.0.0.1:${port}`;
  const p = DISCOVERY_SITE_PATHS;

  const issueSession = (): string => {
    const value = randomValue();
    sessions.set(value, { adminPages: 0 });
    issued.push(value);
    return value;
  };
  /** 読み込みのたびに変わるトークン（目印。値は秘密）。 */
  const token = (): string => {
    const value = `tok${randomValue()}`;
    tokens.push(value);
    return value;
  };

  const r = DISCOVERY_SITE_READ_CHECK_PATHS;
  const readCheckLinks: readonly string[] = options.readCheckPages === true
    ? [r.orders, r.lookup, r.brokenSearch, r.shape, r.secretSearch, r.exitSearch]
    : [];
  const x = DISCOVERY_SITE_EXTRA_PATHS;
  const markerShapeLinks: readonly string[] = options.markerShapes === true ? [x.markerShapes] : [];
  const escapeHtml =(value: string): string => value.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');
  /** 注文の一覧の結果（`q` と `status` で絞る）。 */
  const ordersOf = (url: URL): readonly (typeof DISCOVERY_SITE_ORDERS)[number][] => {
    const q = url.searchParams.get('q') ?? '';
    const status = url.searchParams.get('status') ?? '';
    return DISCOVERY_SITE_ORDERS.filter((order) => order.name.includes(q) && (status === '' || order.status === status));
  };
  const readCheckBodies: Readonly<Record<string, (url: URL) => string>> = options.readCheckPages === true ? {
    [r.orders]: (url) => {
      const rows = ordersOf(url);
      return `<nav><ul><li><a href="${p.admin}">管理</a></li><li><a href="${p.list}">一覧</a></li></ul></nav>
        <h1>注文</h1>
        <form id="order-search" method="get" action="${r.orders}">
          <input type="hidden" name="authenticity_token" value="${token()}">
          <input type="hidden" name="scope" value="${markers.hidden}">
          <input type="search" name="q" value="${markers.value}">
          <select name="status"><option value="">${markers.label}すべて</option><option value="open">${markers.label}受付</option>`
        + `<option value="closed">${markers.label}完了</option></select>
          <button type="submit">検索</button>
        </form>
        <table><thead><tr><th>番号</th><th>名前</th><th>備考</th></tr></thead><tbody>`
        + rows.map((order) => `<tr><td><a href="${r.order}?id=${order.id}">${order.id}</a></td><td>${escapeHtml(order.name)}</td>`
          + `<td>${markers.row}</td><td><button type="button">${markers.row} を編集</button>`
          + `<button type="button" aria-label="${markers.row} を削除">×</button><button type="button" title="${markers.row} の詳細">…</button></td></tr>`)
          .join('')
        + `</tbody></table><p>該当 ${rows.length} 件</p>`;
    },
    [r.lookup]: () => `<h1>照会</h1>
      <form id="lookup" method="get" action="${r.order}">
        <input type="hidden" name="authenticity_token" value="${token()}">
        <input type="text" name="id" value="${markers.value}">
        <button type="submit">照会</button>
      </form>`,
    [r.order]: (url) => {
      const order = DISCOVERY_SITE_ORDERS.find(({ id }) => id === url.searchParams.get('id'));
      return order === undefined
        ? '<h1>注文の詳細</h1><p>見つかりません</p>'
        : `<h1>注文の詳細</h1><dl><dt>番号</dt><dd>${order.id}</dd><dt>名前</dt><dd>${escapeHtml(order.name)}</dd><dt>状態</dt><dd>${order.status}</dd></dl>`;
    },
    [r.brokenSearch]: () => `<h1>壊れた検索</h1>
      <form id="broken" method="get" action="${r.broken}"><input type="text" name="kind"><button type="submit">検索</button></form>`,
    [r.shape]: () => {
      const method = shape === 'post' ? 'post' : 'get';
      const extra = shape === 'extra-field' ? '<input type="text" name="extra">' : '';
      const bound = shape === 'bound'
        ? "<script>document.getElementById('shape').addEventListener('submit', (event) => { event.preventDefault(); });</script>"
        : '';
      return `<h1>形の変わる検索</h1>
        <form id="shape" method="${method}" action="${r.orders}"><input type="search" name="q"${SHAPE_QUERY_FIELD_ATTRIBUTES[shape] ?? ''}>${extra}`
        + `<button type="submit">絞り込み</button></form>${bound}`;
    },
    [r.secretSearch]: () => `<h1>秘密に見える欄</h1>
      <form id="secret-search" method="get" action="${r.orders}">
        <input type="text" name="api_key"><input type="search" name="q"><button type="submit">検索</button>
      </form>`,
    [r.exitSearch]: () => `<h1>ログアウトへ送る検索</h1>
      <form id="exit-search" method="get" action="${r.privateArea}/search"><input type="text" name="reason"><button type="submit">送る</button></form>`,
  } : {};

  // T27R2 の I3: 行の目印を、送信ボタンの `value`・画像の送信ボタンの `alt`・`<label>`（`for` と包む形）・`aria-labelledby`・`aria-describedby` に
  // 置く（欄の名前・送信先・制約には置かない）。
  const ids = DISCOVERY_SITE_MARKER_SHAPE_IDS;
  const markerShapeBodies: Readonly<Record<string, (url: URL) => string>> = options.markerShapes === true ? {
    [x.markerShapes]: () => `<h1>ラベルと送信ボタン</h1>
      <form id="shape-value-form" method="get" action="${p.list}">
        <label for="${ids.labelFor}">${markers.row} の番号</label><input type="search" id="${ids.labelFor}" name="sv">
        <input type="submit" id="${ids.submitValue}" value="${markers.row} を検索">
      </form>
      <form id="shape-image-form" method="get" action="${p.list}">
        <label>${markers.row} の名前 <input type="text" id="${ids.labelWrapped}" name="si"></label>
        <input type="image" id="${ids.imageAlt}" src="${PIXEL_GIF}" alt="${markers.row} を検索">
      </form>
      <form id="shape-aria-form" method="get" action="${p.list}">
        <span id="shape-field-labelledby">${markers.row} の区分</span><span id="shape-field-describedby">${markers.row} の説明</span>
        <input type="text" id="${ids.ariaField}" name="sa" aria-labelledby="shape-field-labelledby" aria-describedby="shape-field-describedby">
        <span id="shape-button-labelledby">${markers.row} を表示</span><span id="shape-button-describedby">${markers.row} の表示の説明</span>
        <button type="submit" id="${ids.ariaButton}" aria-labelledby="shape-button-labelledby" aria-describedby="shape-button-describedby">表示</button>
      </form>`,
  } : {};

  // T27R2 の C1: ポーリングの画面（互いにリンクする）。
  const pollingBodies: Readonly<Record<string, (url: URL) => string>> = options.pollingPages === true
    ? Object.fromEntries(DISCOVERY_SITE_POLLING_PAGES.map((path) => [path, () => `<h1>ポーリング</h1><ul>`
      + DISCOVERY_SITE_POLLING_PAGES.map((link) => `<li><a href="${link}">${link}</a></li>`).join('')
      + `</ul><form method="get" action="${p.list}"><input type="search" name="pq"><button type="submit">検索</button></form>
      <script>
        setInterval(() => { fetch('${x.pollApi}').then((response) => response.text()).catch(() => undefined); }, ${DISCOVERY_SITE_POLLING_INTERVAL_MS});
      </script>`]))
    : {};

  const adminBodies: Readonly<Record<string, (url: URL) => string>> = {
    ...readCheckBodies,
    ...markerShapeBodies,
    ...pollingBodies,
    [p.admin]: () => '<h1 id="admin-ok">管理</h1><ul>'
      + [p.list, p.search, p.create, p.update, p.remove, p.js, p.spa, p.variant, p.duplicate, p.beacon, ...readCheckLinks, ...markerShapeLinks]
        .map((path) => `<li><a href="${path}">${path}</a></li>`).join('')
      + `<li><a href="${p.logout}">ログアウト</a></li><li><a href="${p.danger}">項目を削除</a></li>`
      + `<li><a href="${p.outside}">公開の画面</a></li><li><a href="${p.login}">ログイン</a></li></ul>`,
    [p.list]: () => `<h1>一覧</h1><table><tr><td><a href="${p.detail}">項目 1</a></td></tr></table><p><a href="${p.admin}">戻る</a></p>`,
    [p.detail]: () => `<h1>詳細</h1><dl><dt>名前</dt><dd>${markers.value}</dd></dl>`,
    [p.search]: () => `<h1>検索</h1>
      <form id="search" method="get" action="${p.list}">
        <input type="search" name="q" value="${markers.value}" maxlength="50">
        <select name="category"><option value="">${markers.label}すべて</option><option value="a" selected>${markers.label}A</option></select>
        <button type="submit">検索</button>
      </form>`,
    [p.create]: () => `<h1>登録</h1>
      <form id="create" method="post" action="/admin/items">
        <input type="hidden" name="authenticity_token" value="${token()}">
        <input type="text" name="name" required value="${markers.value}">
        <input type="hidden" name="secret_hidden" value="${markers.hidden}">
        <button type="submit">登録</button>
      </form>`,
    [p.update]: () => `<h1>更新</h1>
      <form id="update" method="post" action="/admin/items/1">
        <input type="hidden" name="_method" value="patch">
        <input type="hidden" name="authenticity_token" value="${token()}">
        <input type="text" name="name" value="${markers.value}">
        <button type="submit">保存</button>
      </form>`,
    [p.remove]: () => `<h1>削除</h1>
      <form id="remove" method="post" action="/admin/items/1">
        <input type="hidden" name="_method" value="delete">
        <input type="hidden" name="authenticity_token" value="${token()}">
        <button type="submit">削除</button>
      </form>`,
    [p.js]: () => `<h1>JS</h1>
      <form id="bound" method="post" action="/admin/messages"><input type="text" name="body"><button type="submit">送る</button></form>
      <button type="button" id="outside-bound">実行</button>
      <script>
        document.getElementById('bound').addEventListener('submit', (event) => { event.preventDefault(); });
        document.getElementById('outside-bound').addEventListener('click', () => {});
      </script>`,
    [p.spa]: () => `<h1>SPA</h1><div id="app"></div>
      <script>
        fetch('${p.api}').then((response) => response.text()).then(() => {
          document.getElementById('app').innerHTML = '<form method="get" action="${p.list}"><input type="search" name="kw"><button type="submit">絞り込み</button></form>';
        });
      </script>`,
    [p.variant]: () => (variant === 'base'
      ? `<h1>変わる画面</h1>
        <form id="find" method="get" action="${p.list}"><input type="search" name="word"><button type="submit">表示</button></form>
        <form id="add" method="post" action="/admin/notes"><input type="text" name="note"><button type="submit">追加</button></form>`
      : `<h1>変わる画面</h1>
        <form id="find" method="get" action="${p.list}"><input type="search" name="word" required><button type="submit">表示</button></form>`),
    [p.duplicate]: () => `<h1>同じ形の form</h1>
      <form method="get" action="${p.list}"><input type="text" name="code"><button type="submit">照会</button></form>
      <form method="get" action="${p.list}"><input type="text" name="code" required pattern="[0-9]+"><button type="submit">照会</button></form>`,
    [p.beacon]: () => `<h1>beacon</h1>
      <form method="get" action="${p.list}"><input type="search" name="b"><button type="submit">検索</button></form>
      <script>navigator.sendBeacon('${p.collect}', 'load');</script>`,
  };

  const loginFormHtml = (): string => {
    csrf = randomValue();
    tokens.push(csrf);
    return `<h1 id="login-title">ログイン</h1><form id="login-form" method="post" action="${p.login}">`
      + `<input name="csrf" type="hidden" value="${csrf}"><input name="user" id="user"><input name="pass" id="pass" type="password">`
      + '<button id="go" type="submit">ログイン</button></form>';
  };

  const handleLoginPost = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const fields = new Map(Buffer.concat(chunks).toString('utf8').split('&').map((pair) => {
        const [name = '', value = ''] = pair.split('=');
        return [decodeURIComponent(name), decodeURIComponent(value.split('+').join(' '))] as const;
      }));
      if (fields.get('csrf') !== csrf || fields.get('user') !== credentials.user || fields.get('pass') !== credentials.pass) {
        response.writeHead(STATUS_SEE_OTHER, { location: p.loginError });
        response.end();
        return;
      }
      successfulLogins += 1;
      const sid = issueSession();
      response.writeHead(STATUS_SEE_OTHER, {
        location: p.admin,
        'set-cookie': `${DISCOVERY_SITE_SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`,
      });
      response.end();
    });
  };

  /** GET と HEAD の応答。管理画面の HTML を返したら真。 */
  const handleRead = (request: IncomingMessage, response: ServerResponse, url: URL): { adminDocument: boolean; authenticated: boolean } => {
    const { pathname } = url;
    if (pathname === p.login) {
      sendHtml(response, 'ログイン', loginFormHtml());
      return { adminDocument: false, authenticated: false };
    }
    if (pathname === p.loginError) {
      sendHtml(response, 'ログインの誤り', '<h1 id="invalid">ログインできません</h1>');
      return { adminDocument: false, authenticated: false };
    }
    if (pathname === p.outside) {
      sendHtml(response, '公開', '<h1>公開</h1>');
      return { adminDocument: false, authenticated: false };
    }
    if (!(pathname === p.admin || pathname.startsWith(`${p.admin}/`))) {
      response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
      response.end('');
      return { adminDocument: false, authenticated: false };
    }
    const presented = cookiesOf(request).get(DISCOVERY_SITE_SESSION_COOKIE);
    const session = presented === undefined ? undefined : sessions.get(presented);
    if (presented === undefined || session === undefined) {
      response.writeHead(STATUS_SEE_OTHER, { location: `${p.login}?expired=1` });
      response.end();
      return { adminDocument: false, authenticated: false };
    }
    if (pathname === p.logout || pathname === p.danger) {
      sessions.delete(presented);
      response.writeHead(STATUS_SEE_OTHER, { location: p.login });
      response.end();
      return { adminDocument: false, authenticated: true };
    }
    // DEF-136: 不調にした画面。
    const fault = faults.get(pathname);
    if (fault !== undefined) {
      if (fault.kind === 'REFUSE') {
        response.socket?.destroy();
        return { adminDocument: true, authenticated: true };
      }
      if (fault.kind === 'HANG') {
        hanging.add(response);
        response.once('close', () => hanging.delete(response));
        return { adminDocument: true, authenticated: true };
      }
      if (fault.times !== undefined) {
        if (fault.times <= 1) {
          faults.delete(pathname);
        } else {
          faults.set(pathname, { ...fault, times: fault.times - 1 });
        }
      }
      response.writeHead(fault.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>誤り</title></head><body><main><h1>誤り ${fault.status}</h1>`
        + `<p><a href="${DISCOVERY_SITE_FAULT_LINK}">誤りの画面のリンク</a></p>`
        + `<form method="get" action="${p.list}"><input type="search" name="fault"><button type="submit">検索</button></form></main></body></html>`);
      return { adminDocument: true, authenticated: true };
    }
    if (pathname === p.api) {
      setTimeout(() => {
        response.writeHead(STATUS_OK, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end('[]');
      }, SPA_API_DELAY_MS);
      return { adminDocument: false, authenticated: true };
    }
    if (options.pollingPages === true && pathname === x.pollApi) {
      setTimeout(() => {
        response.writeHead(STATUS_OK, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end('{}');
      }, DISCOVERY_SITE_POLLING_RESPONSE_DELAY_MS);
      return { adminDocument: false, authenticated: true };
    }
    if (options.readCheckPages === true && pathname === r.broken) {
      // T27e: 4xx・5xx を返す検索（管理画面の HTML の要求として数える）。
      session.adminPages += 1;
      response.writeHead(url.searchParams.get('kind') === 'error' ? STATUS_SERVER_ERROR : STATUS_NOT_FOUND, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>誤り</title><main><h1>誤り</h1><table><tbody><tr><td>x</td></tr></tbody></table></main>');
      return { adminDocument: true, authenticated: true };
    }
    const body = adminBodies[pathname];
    if (body === undefined) {
      response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
      response.end('');
      return { adminDocument: false, authenticated: true };
    }
    session.adminPages += 1;
    if (options.expireAfterAdminPages !== undefined && session.adminPages > options.expireAfterAdminPages) {
      sessions.delete(presented);
      response.writeHead(STATUS_SEE_OTHER, { location: `${p.login}?expired=1` });
      response.end();
      return { adminDocument: true, authenticated: false };
    }
    const storage = `<script>localStorage.setItem('${DISCOVERY_SITE_LOCAL_STORAGE_ITEM}', '${markers.storage}');</script>`;
    sendHtml(response, '管理', `${body(url)}${storage}`);
    return { adminDocument: true, authenticated: true };
  };

  const server = await startLoopbackHttpServer((request, response) => {
    const at = Date.now();
    const url = new URL(request.url ?? '/', origin());
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    let result = { adminDocument: false, authenticated: false };
    if (!isRead && request.method === 'POST' && url.pathname === p.login) {
      handleLoginPost(request, response);
    } else if (!isRead) {
      response.writeHead(STATUS_NO_CONTENT);
      response.end();
    } else {
      result = handleRead(request, response, url);
    }
    requests.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, at, ...result });
  });
  server.server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    requests.push({ method: 'UPGRADE', path: request.url ?? '/', at: Date.now(), adminDocument: false, authenticated: false });
    socket.destroy();
  });
  port = server.port;

  return {
    origin: origin(),
    requests,
    issueSession,
    setVariant: (next) => {
      variant = next;
    },
    setShape: (next) => {
      shape = next;
    },
    expireSessions: () => {
      sessions.clear();
    },
    setPageFault: (path, fault) => {
      if (fault === null) {
        faults.delete(path);
      } else {
        faults.set(path, fault);
      }
    },
    async fillCredentials(fill) {
      await fill(DISCOVERY_SITE_LOGIN_FIELDS.user, credentials.user);
      await fill(DISCOVERY_SITE_LOGIN_FIELDS.pass, credentials.pass);
    },
    get successfulLogins() {
      return successfulLogins;
    },
    secretValues: () => [
      ...issued, ...tokens, credentials.user, credentials.pass, markers.value, markers.hidden, markers.label, markers.storage,
      ...(options.readCheckPages === true || options.markerShapes === true ? [markers.row] : []),
    ],
    loginStateValues: () => [...issued, credentials.user, credentials.pass, markers.storage],
    close: () => server.close(),
  };
}
