// T25c（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.3、4.7、6 章）: 認証つきの監査の段を確かめる
// fixture のサーバ（テストの補助）。ログインの段（T25b の `login-fixture-server.ts`）とは別に、監査の段で要る振る舞いだけを持つ。
// - 127.0.0.1 だけで待ち受ける。同じサーバを、2 つの名前で、別の Origin として使う（`originA` が監査の対象、`originB` が別の Origin。
//   Chromium は `localhost` をループバックに解決する）。
// - セッションは、テストが `issueSession()` で作る（ログインの段を通さずに、認証済みの状態を組み立てるため）。セッションの値は、ランダムな
//   仮の値で、秘密の目印にもなる（テストは値を出力しない。`secretValues()` で、目印の検査にだけ使う）。
// - 振る舞いの指定（`AuthenticatedSiteOptions`）:
//   - `rotate`: 管理画面の HTML を読むたびに、セッションの値を替え、古い値を無効にする（調査の E5）。
//   - `theftDetection`: 回転で無効にした古い値が届いたら、そのセッションの系列をまるごと無効にする（盗難とみなすサーバ）。
//   - `maxAdminPages`: 管理画面の HTML を、この回数まで読んだら、セッションを期限切れにする。
// - 管理画面（`/admin` の下）は、セッションがなければ `/login?expired=1` へ 303 で移す。ログアウトと、危険な語の GET（削除）は、セッションを
//   無効にする（届いたら、セッションが壊れる）。
// - サーバに届いた要求（Origin の別、method、path と query、受け取った Cookie の名前、認証済みだったか）を、順に記録する。Cookie の値は記録しない。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { startLoopbackHttpServer } from './loopback-server.js';

/** T25f（`expireFirstSessionAtPath`）: 最初のセッションの系列の番号。 */
const FIRST_SESSION_FAMILY = 1;
/** 仮の値の長さ（バイト）。 */
const RANDOM_VALUE_BYTES = 16;
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;

/** セッションの Cookie の名前。 */
export const AUTH_SITE_SESSION_COOKIE = 'sid';
/** 別の Origin（`originB`）の Cookie の名前（IdP の Cookie の代わり。絞り込みで落ちる）。 */
export const AUTH_SITE_OTHER_ORIGIN_COOKIE = 'idp';
/** localStorage の項目の名前（値は秘密の目印）。 */
export const AUTH_SITE_LOCAL_STORAGE_ITEM = 'ls_token';

/**
 * 1 つのページで、除外に当たる iframe の数（除外の記録の上限 256 件を超える数）。BN-0（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md`
 * 3.0）から、監査の段の除外はページの文書でない GET（画像など）に当てず、文書の読み込み（iframe を含む）に当てるので、iframe の文書で数を作る。
 */
export const AUTH_SITE_MANY_EXCLUDED_IMAGES = 300;
/** `adminPinging` の画面が `adminPing` を GET する間隔（ms）。 */
const ADMIN_PING_INTERVAL_MS = 100;

/** fixture のパス。 */
export const AUTH_SITE_PATHS = Object.freeze({
  login: '/login',
  admin: '/admin',
  adminSecond: '/admin/second',
  adminFrames: '/admin/frames',
  adminLogout: '/admin/logout',
  adminDelete: '/admin/items/1/delete',
  adminManyExcluded: '/admin/many-excluded',
  /** 読み込んだ後も、管理画面の下の JSON を一定の間隔で GET し続ける画面（回転で古い値になった Context が、古い値を送り続ける）。 */
  adminPinging: '/admin/pinging',
  adminPing: '/admin/ping.json',
  /** T25d（`loginForm`）: セッションを問わない、読む範囲の外の画面（ログインの段の成功の条件の確かめに使う。状態を作らない）。 */
  publicPage: '/public',
  /**
   * T32i（`adminReloginForm`）: 読み込みの後で、ログインの送信先（`/login`）へ main frame のナビゲーションの POST を送ろうとする管理画面
   * （ログインの段の許可が監査の段に引き継がれないことの確かめ）。
   */
  adminRelogin: '/admin/relogin',
  otherPixel: '/pixel',
  otherFrame: '/frame',
  otherExternal: '/external',
} as const);

/**
 * T25f（`queryTokens`）: query に秘密の目印（ランダムな仮の値）を持つ URL のパス。管理画面（`/admin` の下の HTML）は、先頭に、これらへの
 * リンクと画像を持つ（`/admin/report?token=…&page=2`、`/admin/item?token=…`（2 つの値）、`/admin/jump`、`/admin/token-pixel.svg?access_token=…`）。
 * `/admin/jump` は、`/admin/landing?code=…&state=…` へ 303 で移す。`/public-tokens` は、セッションを問わない画面で、同じ形のリンクと画像を持つ
 * （公開監査で、伏せ字を通さないことの確かめに使う）。画像と移動の要求は、管理画面の数（`maxAdminPages`）に数えない。
 */
export const AUTH_SITE_TOKEN_PATHS = Object.freeze({
  report: '/admin/report',
  item: '/admin/item',
  jump: '/admin/jump',
  landing: '/admin/landing',
  pixel: '/admin/token-pixel.svg',
  publicTokens: '/public-tokens',
  publicPixel: '/public-token-pixel.svg',
} as const);

/** サーバに届いた要求の記録。 */
export interface AuthenticatedSiteRequest {
  readonly site: 'A' | 'B';
  readonly method: string;
  /** path と query。 */
  readonly path: string;
  /** 受け取った Cookie の名前（値は記録しない。並べ替えた順）。 */
  readonly cookieNames: readonly string[];
  /** `originA` の管理画面の要求で、有効なセッションを持っていたか（ほかの要求は `false`）。 */
  readonly authenticated: boolean;
}

export interface AuthenticatedSiteOptions {
  readonly rotate?: boolean;
  readonly theftDetection?: boolean;
  readonly maxAdminPages?: number;
  /**
   * T25d: ログインのフォームを本物にする（ログインの段から監査までを、1 つのサーバで確かめる）。`/login` の GET は、CSRF の hidden と資格情報の
   * 欄を持つフォーム（送信先は `/login` への POST）。正しい資格情報と CSRF の POST なら、新しいセッションを作り、Cookie を付けて `/admin` へ
   * 303 で移す。誤りなら 401 の画面。管理画面は、読み込みのときに localStorage に秘密の目印を書く。資格情報と CSRF の値は、起動のたびに作る
   * 仮の値（テストは `fillCredentials` で欄に入れるだけで、値を出力しない）。
   */
  readonly loginForm?: boolean;
  /** T25f: query に秘密の目印を持つリンク、画像、移動を足す（`AUTH_SITE_TOKEN_PATHS`）。目印は `queryTokenValues()`。 */
  readonly queryTokens?: boolean;
  /**
   * T25f: 最初のセッションの系列（最初のログイン、または最初の `issueSession()`）だけ、この path（query を除く）の管理画面の要求で、期限切れに
   * する（ログインの画面へ 303）。2 回目のログインの系列は切れない（セッションの切れで止まった Run を、再開で最後まで監査する確かめに使う）。
   */
  readonly expireFirstSessionAtPath?: string;
  /**
   * T32i: 管理画面（`/admin`）の先頭から、`AUTH_SITE_PATHS.adminRelogin` へリンクする。その画面は、読み込みの後（`load` の事象の後）で、ログインの
   * 送信先（`/login`）へ、フォームの送信（main frame のナビゲーションの POST。ログインの段の Guard が許す形と同じ）を試みる。本文は資格情報を
   * 持たない（`AUTH_SITE_RELOGIN_FIELD_VALUE`）。指定がなければ、画面もリンクもない（今のまま）。
   */
  readonly adminReloginForm?: boolean;
  /**
   * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 3 章の 1）: `loginForm` と一緒に使う。ログインの POST の後の画面
   * （`/admin?login=1`。`AUTH_SITE_INDEXED_DB.landingQuery`）が、IndexedDB（`AUTH_SITE_INDEXED_DB`）に秘密の目印を書き、書き終えてから成功の画面の
   * 要素（`#admin-ok`）を出す。2 ページ目（`AUTH_SITE_PATHS.adminSecond`）は、読み込みの後に IndexedDB を読み、その記録がなければ、ログインの画面
   * （`AUTH_SITE_INDEXED_DB.missingPath`）へ移す（クライアントの側の移動。Cookie は有効なまま）。指定がなければ、今のまま。
   */
  readonly indexedDbGate?: boolean;
}

/** DEF-139（`indexedDbGate`）: IndexedDB のデータベースと object store と鍵の名前、ログインの後の画面の query、記録がないときに移す先。 */
export const AUTH_SITE_INDEXED_DB = Object.freeze({
  database: 'beak-session',
  store: 'kv',
  key: 'auth-token',
  landingQuery: '?login=1',
  missingPath: '/login?expired=idb',
  /**
   * 2 ページ目の、parser を止めるスクリプト（応答を `INDEXED_DB_GATE_WAIT_MS` 遅らせ、DOMContentLoaded の前に IndexedDB の確かめと移動を終えさせる）。
   * DEF-165: BeakSight の読み込みは DOMContentLoaded で返り、セッションの切れはその直後に確かめる。前は画像（`load` だけを遅らせる）だったので、CLI の
   * Chromium では IndexedDB の確かめが読み込みの戻りより後になり、記録がなくてもセッションの切れと判定されなかった（fixture の競争）。
   */
  waitPath: '/admin/gate-wait.js',
} as const);

/**
 * DEF-139（`indexedDbGate`）: 2 ページ目の parser を止めるスクリプトの応答を遅らせる時間（ms。IndexedDB の確かめと移動が、DOMContentLoaded より先に
 * 済む長さ。DEF-165 の観察では、移動は読み込みの開始から CLI の Chromium で約 70ms、既定の Chromium で約 20ms。混雑の下の余裕を見る）。
 */
const INDEXED_DB_GATE_WAIT_MS = 1_000;

/** T32i（`adminReloginForm`）: 監査の段の画面が送ろうとするフォームの欄の値（資格情報ではない、固定の目印）。 */
export const AUTH_SITE_RELOGIN_FIELD_VALUE = 'relogin-attempt';

export interface AuthenticatedSite {
  readonly originA: string;
  readonly originB: string;
  readonly requests: readonly AuthenticatedSiteRequest[];
  /** 新しいセッションを作り、その値を返す（認証済みの状態の組み立てに使う。値を出力しない）。 */
  issueSession(): string;
  /** 作ったすべてのセッションの値（回転で替えた値を含む。秘密の目印の検査にだけ使う）。 */
  secretValues(): readonly string[];
  /** T25d（`loginForm`）: ページの入力の欄に、正しい資格情報を入れる（値はテストに返さない）。 */
  fillCredentials(fill: (selector: string, value: string) => Promise<void>): Promise<void>;
  /** T25d（`loginForm`）: 正しい資格情報でログインした回数。 */
  readonly successfulLogins: number;
  /** T25f（`queryTokens`）: URL の query に入れた秘密の目印（目印の検査にだけ使う。値を出力しない）。`queryTokens` がなければ空。 */
  queryTokenValues(): readonly string[];
  close(): Promise<void>;
}

/** T25d: ログインのフォームの欄のセレクタ。 */
export const AUTH_SITE_LOGIN_FIELDS = Object.freeze({ user: '#user', pass: '#pass', submit: '#go' } as const);

/** ランダムな仮の値。 */
export const randomSecretValue = (): string => randomBytes(RANDOM_VALUE_BYTES).toString('hex');

function sendHtml(response: ServerResponse, body: string, headers: Record<string, string> = {}): void {
  response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Admin</title><link rel="icon" href="data:,"></head>`
    + `<body><main>${body}</main></body></html>`);
}

/** T25f: 1 画素の SVG（`queryTokens` の画像）。 */
function sendPixel(response: ServerResponse): void {
  response.writeHead(STATUS_OK, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
  response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
}

function cookiesOf(request: IncomingMessage): Map<string, string> {
  return new Map((request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.includes('='))
    .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)] as const));
}

export async function startAuthenticatedSite(options: AuthenticatedSiteOptions = {}): Promise<AuthenticatedSite> {
  /** 有効なセッションの値 → 系列の番号と、読んだ管理画面の数。 */
  const sessions = new Map<string, { readonly family: number; adminPages: number }>();
  /** 回転で無効にした値 → 系列の番号。 */
  const rotatedAway = new Map<string, number>();
  const issued: string[] = [];
  const requests: AuthenticatedSiteRequest[] = [];
  let families = 0;
  let port = 0;
  // T25d（`loginForm`）: 仮の資格情報と CSRF の値、管理画面が localStorage に書く秘密の目印。
  const credentials = { user: `u${randomSecretValue()}`, pass: `p${randomSecretValue()}` };
  const csrf = randomSecretValue();
  const localStorageMarker = randomSecretValue();
  // DEF-139（`indexedDbGate`）: ログインの後の画面が IndexedDB に書く秘密の目印。
  const indexedDbMarker = randomSecretValue();
  let successfulLogins = 0;
  // T25f（`queryTokens`）: URL の query に入れる秘密の目印。
  const queryTokens = {
    report: randomSecretValue(),
    itemA: randomSecretValue(),
    itemB: randomSecretValue(),
    pixel: randomSecretValue(),
    code: randomSecretValue(),
    state: randomSecretValue(),
    publicLink: randomSecretValue(),
    publicPixel: randomSecretValue(),
  };
  const originA = (): string => `http://127.0.0.1:${port}`;
  const originB = (): string => `http://localhost:${port}`;
  const siteOf = (request: IncomingMessage): 'A' | 'B' => (request.headers.host?.startsWith('localhost:') === true ? 'B' : 'A');

  const issueSession = (family = (families += 1)): string => {
    const value = randomSecretValue();
    sessions.set(value, { family, adminPages: 0 });
    issued.push(value);
    return value;
  };
  const invalidateFamily = (family: number): void => {
    for (const [value, session] of sessions) {
      if (session.family === family) sessions.delete(value);
    }
  };

  /** T25f（`queryTokens`）: 管理画面の先頭の、query に秘密の目印を持つリンクと画像。 */
  const tokenLinksHtml = (): string => {
    const t = AUTH_SITE_TOKEN_PATHS;
    return options.queryTokens === true
      ? `<p><a href="${t.report}?token=${queryTokens.report}&amp;page=2">report</a> `
        + `<a href="${t.item}?token=${queryTokens.itemA}">item-a</a> <a href="${t.item}?token=${queryTokens.itemB}">item-b</a> `
        + `<a href="${t.jump}">jump</a> <img src="${t.pixel}?access_token=${queryTokens.pixel}" alt=""></p>`
      : '';
  };

  const adminHtml = (path: string): string => {
    const p = AUTH_SITE_PATHS;
    if (path === p.adminManyExcluded) {
      return '<h1 id="admin-ok">MANY</h1>'
        + Array.from({ length: AUTH_SITE_MANY_EXCLUDED_IMAGES }, (_, index) =>
          `<iframe title="f${String(index)}" src="${p.adminLogout}?frame=${String(index)}" style="width:1px;height:1px"></iframe>`).join('');
    }
    if (path === p.adminFrames) {
      return '<h1 id="admin-ok">FRAMES</h1>'
        + `<img src="${originB()}${p.otherPixel}" alt="">`
        + `<iframe title="other" src="${originB()}${p.otherFrame}"></iframe>`
        + `<p><a href="${p.admin}">admin</a></p>`;
    }
    if (path === p.adminPinging) {
      return '<h1 id="admin-ok">PINGING</h1>'
        + `<script>setInterval(() => { fetch('${p.adminPing}').catch(() => undefined); }, ${ADMIN_PING_INTERVAL_MS});</script>`;
    }
    if (path === p.adminSecond) {
      return `<h1 id="admin-ok">SECOND</h1><p><a href="${p.admin}">admin</a></p>`
        + (options.indexedDbGate === true ? `${indexedDbGateScript()}<script src="${AUTH_SITE_INDEXED_DB.waitPath}"></script>` : '');
    }
    if (options.adminReloginForm === true && path === p.adminRelogin) {
      return '<h1 id="admin-ok">RELOGIN</h1>'
        + `<form id="relogin-form" method="post" action="${p.login}"><input name="user" value="${AUTH_SITE_RELOGIN_FIELD_VALUE}"></form>`
        + '<script>addEventListener("load", () => { setTimeout(() => document.getElementById("relogin-form").submit(), 0); });</script>';
    }
    return `<h1 id="admin-ok">ADMIN</h1>${tokenLinksHtml()}<ul>`
      + (options.adminReloginForm === true ? `<li><a href="${p.adminRelogin}">relogin</a></li>` : '')
      + `<li><a href="${p.adminSecond}">second</a></li>`
      + `<li><a href="${p.adminFrames}">frames</a></li>`
      + `<li><a href="${p.adminLogout}">logout</a></li>`
      + `<li><a href="${p.adminDelete}">delete</a></li>`
      + `<li><a href="${p.login}">login</a></li>`
      + `<li><a href="${originB()}${p.otherExternal}">external</a></li>`
      + '</ul>';
  };

  /**
   * DEF-139（`indexedDbGate`）: 2 ページ目の、IndexedDB の記録を確かめるスクリプト（データベースか記録がなければ、ログインの画面へ移す）。データベースが
   * ないときに `open` で作らないよう、先に `indexedDB.databases()` で名前を確かめる。値は比べない（記録があるかだけ）。
   */
  const indexedDbGateScript = (): string => {
    const d = AUTH_SITE_INDEXED_DB;
    return '<script>(async () => {'
      + `const toLogin = () => location.replace(${JSON.stringify(d.missingPath)});`
      + `const names = (await indexedDB.databases()).map((info) => info.name);`
      + `if (!names.includes(${JSON.stringify(d.database)})) { toLogin(); return; }`
      + `const db = await new Promise((resolve, reject) => { const r = indexedDB.open(${JSON.stringify(d.database)}); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });`
      + `if (!db.objectStoreNames.contains(${JSON.stringify(d.store)})) { db.close(); toLogin(); return; }`
      + `const value = await new Promise((resolve, reject) => { const r = db.transaction(${JSON.stringify(d.store)}, 'readonly').objectStore(${JSON.stringify(d.store)}).get(${JSON.stringify(d.key)}); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });`
      + 'db.close();'
      + 'if (typeof value !== "string" || value.length === 0) toLogin();'
      + '})().catch(() => location.replace(' + JSON.stringify(d.missingPath) + '));</script>';
  };

  /** DEF-139（`indexedDbGate`）: ログインの後の画面。IndexedDB に目印を書き終えてから、成功の画面の要素を出す。 */
  const indexedDbLandingHtml = (): string => {
    const d = AUTH_SITE_INDEXED_DB;
    return '<h1 id="admin-pending">ADMIN</h1><script>(async () => {'
      + `const db = await new Promise((resolve, reject) => { const r = indexedDB.open(${JSON.stringify(d.database)}, 1);`
      + ` r.onupgradeneeded = () => r.result.createObjectStore(${JSON.stringify(d.store)}); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });`
      + `await new Promise((resolve, reject) => { const tx = db.transaction(${JSON.stringify(d.store)}, 'readwrite');`
      + ` tx.objectStore(${JSON.stringify(d.store)}).put(${JSON.stringify(indexedDbMarker)}, ${JSON.stringify(d.key)}); tx.oncomplete = () => resolve(undefined); tx.onerror = () => reject(tx.error); });`
      + 'db.close();'
      + 'document.getElementById("admin-pending").id = "admin-ok";'
      + '})();</script>';
  };

  const loginFormHtml = (): string => '<h1 id="login-title">LOGIN</h1>'
    + `<form id="login-form" method="post" action="${AUTH_SITE_PATHS.login}"><input name="csrf" type="hidden" value="${csrf}">`
    + '<input name="user" id="user"><input name="pass" id="pass" type="password"><button id="go" type="submit">login</button></form>';

  /** T25d（`loginForm`）: ログインの POST（正しい資格情報と CSRF なら、新しいセッションの Cookie を付けて管理画面へ 303）。値は記録しない。 */
  const handleLoginPost = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const fields = new Map(Buffer.concat(chunks).toString('utf8').split('&').map((pair) => {
        const [name = '', value = ''] = pair.split('=');
        return [decodeURIComponent(name), decodeURIComponent(value.split('+').join(' '))] as const;
      }));
      if (fields.get('csrf') !== csrf || fields.get('user') !== credentials.user || fields.get('pass') !== credentials.pass) {
        response.writeHead(STATUS_UNAUTHORIZED, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><h1 id="login-failed">LOGIN-FAILED</h1></body></html>');
        return;
      }
      successfulLogins += 1;
      const sid = issueSession();
      response.writeHead(STATUS_SEE_OTHER, {
        // DEF-139（`indexedDbGate`）: ログインの後の画面（IndexedDB に書く）へ移す。
        location: options.indexedDbGate === true ? `${AUTH_SITE_PATHS.admin}${AUTH_SITE_INDEXED_DB.landingQuery}` : AUTH_SITE_PATHS.admin,
        'set-cookie': `${AUTH_SITE_SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/`,
      });
      response.end();
    });
  };

  const handleSiteA = (request: IncomingMessage, response: ServerResponse, url: URL): boolean => {
    const { pathname } = url;
    const p = AUTH_SITE_PATHS;
    if (pathname === p.login) {
      sendHtml(response, options.loginForm === true
        ? loginFormHtml()
        : '<h1 id="login-title">LOGIN</h1><form method="post" action="/login"><input name="user"></form>');
      return false;
    }
    if (options.loginForm === true && pathname === p.publicPage) {
      sendHtml(response, '<h1 id="public">PUBLIC</h1>');
      return false;
    }
    if (options.queryTokens === true && pathname === AUTH_SITE_TOKEN_PATHS.publicTokens) {
      sendHtml(response, '<h1 id="public-tokens">PUBLIC-TOKENS</h1>'
        + `<p><a href="${AUTH_SITE_TOKEN_PATHS.publicTokens}?token=${queryTokens.publicLink}">self</a>`
        + ` <img src="${AUTH_SITE_TOKEN_PATHS.publicPixel}?access_token=${queryTokens.publicPixel}" alt=""></p>`);
      return false;
    }
    if (options.queryTokens === true && pathname === AUTH_SITE_TOKEN_PATHS.publicPixel) {
      sendPixel(response);
      return false;
    }
    if (!(pathname === p.admin || pathname.startsWith(`${p.admin}/`))) {
      response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
      response.end('');
      return false;
    }
    const presented = cookiesOf(request).get(AUTH_SITE_SESSION_COOKIE);
    if (presented !== undefined && options.theftDetection === true) {
      const family = rotatedAway.get(presented);
      if (family !== undefined) invalidateFamily(family);
    }
    const session = presented === undefined ? undefined : sessions.get(presented);
    if (presented === undefined || session === undefined) {
      response.writeHead(STATUS_SEE_OTHER, { location: `${p.login}?expired=1` });
      response.end();
      return false;
    }
    if (options.expireFirstSessionAtPath === pathname && session.family === FIRST_SESSION_FAMILY) {
      invalidateFamily(session.family);
      response.writeHead(STATUS_SEE_OTHER, { location: `${p.login}?expired=1` });
      response.end();
      return false;
    }
    if (options.queryTokens === true && pathname === AUTH_SITE_TOKEN_PATHS.pixel) {
      sendPixel(response);
      return true;
    }
    if (options.queryTokens === true && pathname === AUTH_SITE_TOKEN_PATHS.jump) {
      response.writeHead(STATUS_SEE_OTHER, { location: `${AUTH_SITE_TOKEN_PATHS.landing}?code=${queryTokens.code}&state=${queryTokens.state}` });
      response.end();
      return true;
    }
    if (pathname === p.adminLogout || pathname === p.adminDelete) {
      invalidateFamily(session.family);
      response.writeHead(STATUS_SEE_OTHER, { location: p.login });
      response.end();
      return true;
    }
    if (options.indexedDbGate === true && pathname === AUTH_SITE_INDEXED_DB.waitPath) {
      setTimeout(() => {
        response.writeHead(STATUS_OK, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end('');
      }, INDEXED_DB_GATE_WAIT_MS);
      return true;
    }
    if (pathname === p.adminPing) {
      response.writeHead(STATUS_OK, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end('{"ok":true}');
      return true;
    }
    session.adminPages += 1;
    if (options.maxAdminPages !== undefined && session.adminPages > options.maxAdminPages) {
      invalidateFamily(session.family);
      response.writeHead(STATUS_SEE_OTHER, { location: `${p.login}?expired=1` });
      response.end();
      return false;
    }
    const headers: Record<string, string> = {};
    if (options.rotate === true) {
      const next = issueSession(session.family);
      const nextSession = sessions.get(next);
      if (nextSession !== undefined) nextSession.adminPages = session.adminPages;
      sessions.delete(presented);
      rotatedAway.set(presented, session.family);
      headers['set-cookie'] = `${AUTH_SITE_SESSION_COOKIE}=${next}; HttpOnly; SameSite=Lax; Path=/`;
    }
    const storageScript = options.loginForm === true
      ? `<script>localStorage.setItem('${AUTH_SITE_LOCAL_STORAGE_ITEM}', '${localStorageMarker}');</script>`
      : '';
    // DEF-139（`indexedDbGate`）: ログインの後の画面だけ、IndexedDB に書く画面にする。
    const landing = options.indexedDbGate === true && pathname === p.admin && url.search === AUTH_SITE_INDEXED_DB.landingQuery;
    sendHtml(response, `${landing ? indexedDbLandingHtml() : adminHtml(pathname)}${storageScript}`, headers);
    return true;
  };

  const handleSiteB = (response: ServerResponse, url: URL): void => {
    if (url.pathname === AUTH_SITE_PATHS.otherPixel) {
      response.writeHead(STATUS_OK, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      return;
    }
    if (url.pathname === AUTH_SITE_PATHS.otherFrame || url.pathname === AUTH_SITE_PATHS.otherExternal) {
      sendHtml(response, '<p>OTHER</p>');
      return;
    }
    response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
    response.end('');
  };

  const loopback = await startLoopbackHttpServer((request, response) => {
    const site = siteOf(request);
    const url = new URL(request.url ?? '/', site === 'A' ? originA() : originB());
    const cookieNames = [...cookiesOf(request).keys()].sort();
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    let authenticated = false;
    if (!isRead && options.loginForm === true && site === 'A' && request.method === 'POST' && url.pathname === AUTH_SITE_PATHS.login) {
      handleLoginPost(request, response);
    } else if (!isRead) {
      response.writeHead(STATUS_OK, { 'content-type': 'text/plain' });
      response.end('NON-READ-RECEIVED');
    } else if (site === 'A') {
      authenticated = handleSiteA(request, response, url);
    } else {
      handleSiteB(response, url);
    }
    requests.push({ site, method: request.method ?? '', path: `${url.pathname}${url.search}`, cookieNames, authenticated });
  });
  loopback.server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const site = siteOf(request);
    requests.push({ site, method: 'UPGRADE', path: request.url ?? '/', cookieNames: [], authenticated: false });
    socket.destroy();
  });
  port = loopback.port;

  return {
    originA: originA(),
    originB: originB(),
    requests,
    issueSession: () => issueSession(),
    // T25d: `loginForm` の管理画面が localStorage に書く目印も、秘密の値に含める。
    // DEF-139: `indexedDbGate` の画面が IndexedDB に書く目印も、秘密の値に含める。
    secretValues: () => [
      ...issued,
      ...(options.loginForm === true ? [localStorageMarker] : []),
      ...(options.indexedDbGate === true ? [indexedDbMarker] : []),
    ],
    async fillCredentials(fill) {
      await fill(AUTH_SITE_LOGIN_FIELDS.user, credentials.user);
      await fill(AUTH_SITE_LOGIN_FIELDS.pass, credentials.pass);
    },
    get successfulLogins() {
      return successfulLogins;
    },
    queryTokenValues: () => (options.queryTokens === true ? Object.values(queryTokens) : []),
    close: () => loopback.close(),
  };
}

/** `authenticatedStateFor` の結果。`state` は Playwright の `storageState` と同じ形。`secrets` は、状態に入れた秘密の値（目印の検査用）。 */
export interface AuthenticatedSiteState {
  readonly state: {
    readonly cookies: readonly {
      readonly name: string;
      readonly value: string;
      readonly domain: string;
      readonly path: string;
      readonly expires: number;
      readonly httpOnly: boolean;
      readonly secure: boolean;
      readonly sameSite: 'Strict' | 'Lax' | 'None';
    }[];
    readonly origins: readonly { readonly origin: string; readonly localStorage: readonly { readonly name: string; readonly value: string }[] }[];
  };
  readonly secrets: readonly string[];
}

/** 認証済みの状態の、セッションの Cookie の項目（Playwright の `storageState` の形。値以外）。 */
const SESSION_COOKIE_ATTRIBUTES = Object.freeze({ path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' } as const);
/** 別の Origin の Cookie の項目（別のサイトの部品の要求にも付く形。`localhost` は http でも Secure を受ける）。 */
const OTHER_ORIGIN_COOKIE_ATTRIBUTES = Object.freeze({ path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' } as const);

/**
 * 認証済みの状態を組み立てる（ログインの段を通さない）。`originA` のセッションの Cookie と localStorage に加えて、絞り込みで落ちるべき
 * 別の Origin（`originB`）の Cookie と localStorage を入れる。値は、どれもランダムな仮の値（秘密の目印）。
 */
export function authenticatedStateFor(site: AuthenticatedSite): AuthenticatedSiteState {
  const sid = site.issueSession();
  const otherCookie = randomSecretValue();
  const localValue = randomSecretValue();
  const otherLocalValue = randomSecretValue();
  return {
    state: {
      cookies: [
        { name: AUTH_SITE_SESSION_COOKIE, value: sid, domain: new URL(site.originA).hostname, ...SESSION_COOKIE_ATTRIBUTES },
        { name: AUTH_SITE_OTHER_ORIGIN_COOKIE, value: otherCookie, domain: new URL(site.originB).hostname, ...OTHER_ORIGIN_COOKIE_ATTRIBUTES },
      ],
      origins: [
        { origin: site.originA, localStorage: [{ name: AUTH_SITE_LOCAL_STORAGE_ITEM, value: localValue }] },
        { origin: site.originB, localStorage: [{ name: AUTH_SITE_LOCAL_STORAGE_ITEM, value: otherLocalValue }] },
      ],
    },
    secrets: [sid, otherCookie, localValue, otherLocalValue],
  };
}
