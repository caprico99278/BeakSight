// T36R-fix（Task 36 の独立レビュー T36R の C-1・C-2・C-4・I-1・M-8）: 自動ログインの資格情報の持ち出しの経路を試す、テストだけのサイト（テストのファイル
// ではない）。レビュー担当の実験のサイトを写して、要る経路だけに絞った。127.0.0.1 だけで待ち受ける 3 つの Origin: A（アプリ。許可 Origin）、
// T（token の送信先。承認したサービスの Origin）、B（登録したログインに伴う送信の送信先。承認したサービスの Origin）。
// - `/auth?s=<場面>`: ログインの画面。送信を押すと、ページのスクリプトが token を送り（場面によっては送らない）、場面の持ち出しの経路を動かす。
//   `&layout=formless`（`LEAK_SITE_FORMLESS_QUERY`）は、form の要素のない画面（3 つが form の外。送信は `button type="button"` を押したとき）。
//   token の応答が成功なら、ローカル ストレージに成功の鍵を置いて `/admin` へ移る。
// - `/admin`: 成功の画面（`#ok[data-state="loaded"]`）。`/auditpage`: 監査の段の画面（ローカル ストレージの `stash` を query に載せて読む）。
// - 記録: すべての要求の Origin、method、URL、ヘッダ、本文（値はテストの比べにだけ使い、出力しない）。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startLoopbackHttpServer, type LoopbackHttpServer } from './loopback-server.js';

/** 届いた要求 1 件。 */
export interface LeakSiteRecord {
  readonly origin: 'A' | 'T' | 'B';
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export interface CredentialLeakSite {
  readonly appOrigin: string;
  readonly tokenOrigin: string;
  readonly sideOrigin: string;
  readonly records: LeakSiteRecord[];
  close(): Promise<void>;
}

/** 成功の鍵（ローカル ストレージ）の名前の形。 */
export const LEAK_SITE_SUCCESS_KEY = Object.freeze({ prefix: 'fx', suffix: '-auth-token' });
/** 画面とパス。 */
export const LEAK_SITE_PATHS = Object.freeze({ auth: '/auth', admin: '/admin', audit: '/auditpage', token: '/token', side: '/rpc/log' } as const);
/** T36R-fix（form の要素のないログインの画面）: ログインの画面の URL に足す query（`&` から）。 */
export const LEAK_SITE_FORMLESS_QUERY = '&layout=formless';
/** form の要素のない画面を選ぶ query の名前と値。 */
const LAYOUT_QUERY_NAME = 'layout';
const FORMLESS_LAYOUT = 'formless';

/**
 * 持ち出しの経路（場面）。`u` はユーザー名、`p` はパスワード。
 * - C-1: `hdrGet`（同じ Origin の GET にヘッダ）、`hdrSide`（登録した送信にヘッダ）、`cookie`（`encodeURIComponent` の形の Cookie の後の GET）、
 *   `cookieRaw`（そのままの Cookie の後の GET）、`referer`（`pushState` で URL に値を入れた後の同じ Origin の GET。`Referer` が運ぶ）。
 * - C-2: `rawQuery`・`rawPath`（値をそのまま URL の query・path に連結。ブラウザが一部の文字だけを % の形にする）。
 *   T36R2-fix: `pctWrapped`（値の UTF-8 のバイトをすべて `%XX` にし、前後に UTF-8 として戻せないバイト `%FF`・`%FE` を付けて query に入れる）。
 * - I-1: `postPathA`（許可 Origin の path に値を入れた POST。方針で止まる）。
 * - M-8: `usernameRead`（ログインの後に、ユーザー名の query で読む）、`usernamePost`（ユーザー名を登録した送信の本文に入れる）。
 * - C-4: `localStash`（ローカル ストレージに値を置く。監査の段の画面が読む）、`cookieStash`（どの要求にも付かない path の Cookie に値を置く）。
 *   M-8: `usernameStash`（ローカル ストレージにユーザー名を置く。比べない）。
 */
export const LEAK_SITE_SCENARIOS = Object.freeze([
  'none', 'hdrGet', 'hdrSide', 'cookie', 'cookieRaw', 'referer', 'rawQuery', 'rawPath', 'postPathA', 'usernameRead', 'usernamePost', 'localStash', 'cookieStash', 'usernameStash',
  'pctWrapped',
] as const);
/** T36R2-fix: `pctWrapped` の送信先の path。 */
export const LEAK_SITE_PCT_WRAPPED_PATH = '/r/pct';
export type LeakSiteScenario = (typeof LEAK_SITE_SCENARIOS)[number];

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
/** token の応答の後、`/admin` へ移るまでの時間（ms）。 */
const NAVIGATE_AFTER_TOKEN_MS = 300;

const readBody = (request: IncomingMessage): Promise<Buffer> => new Promise((resolveBody) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => resolveBody(Buffer.concat(chunks)));
  request.on('error', () => resolveBody(Buffer.concat(chunks)));
});

/** ログインの画面（場面の経路を、送信の受け手で動かす）。 */
const authPageHtml = (origins: { readonly A: string; readonly T: string; readonly B: string }, scenario: string, formless: boolean): string => {
  const config = JSON.stringify({
    ...origins, scenario, formless, successKey: `${LEAK_SITE_SUCCESS_KEY.prefix}${LEAK_SITE_SUCCESS_KEY.suffix}`, paths: LEAK_SITE_PATHS,
  });
  const fields = '<input id="u" name="u" type="text"><input id="p" name="p" type="password">';
  const loginBox = formless
    ? `<div id="f">${fields}<button id="b" type="button">login</button></div>`
    : `<form id="f">${fields}<button id="b" type="submit">login</button></form>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>login</title></head><body>
${loginBox}
<div id="err" data-state="hidden"></div>
<script>
const C = ${config};
const enc = encodeURIComponent;
const sendToken = (u, p) => fetch(C.T + C.paths.token + '?grant_type=password', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ u, p }),
}).then((r) => {
  if (r.ok) { localStorage.setItem(C.successKey, 'tok-' + Date.now()); setTimeout(() => { location.href = C.paths.admin; }, ${NAVIGATE_AFTER_TOKEN_MS}); }
  else { document.getElementById('err').dataset.state = 'shown'; }
}).catch(() => { document.getElementById('err').dataset.state = 'shown'; });
const leaks = {
  none() {},
  hdrGet(u, p) { fetch(C.A + '/r/hdr', { headers: { 'x-leak': p } }).catch(() => 0); },
  hdrSide(u, p) { fetch(C.B + C.paths.side, { method: 'POST', headers: { 'x-leak': p, 'content-type': 'text/plain' }, body: 'clean' }).catch(() => 0); },
  cookie(u, p) { document.cookie = 'lk=' + enc(p) + '; path=/'; fetch(C.A + '/r/cookie').catch(() => 0); },
  cookieRaw(u, p) { document.cookie = 'lk=' + p + '; path=/'; fetch(C.A + '/r/cookieraw').catch(() => 0); },
  referer(u, p) { history.pushState(null, '', '/auth/state?x=' + p); fetch(C.A + '/r/referer').catch(() => 0); },
  rawQuery(u, p) { fetch(C.A + '/r/rawq?x=' + p).catch(() => 0); },
  rawPath(u, p) { fetch(C.A + '/r/rawp/' + p).catch(() => 0); },
  pctWrapped(u, p) {
    const all = Array.from(new TextEncoder().encode(p), (byte) => '%' + byte.toString(16).toUpperCase().padStart(2, '0')).join('');
    fetch(C.A + '${LEAK_SITE_PCT_WRAPPED_PATH}?x=%FF' + all + '%FE').catch(() => 0);
  },
  postPathA(u, p) { fetch(C.A + '/x/' + p + '/save', { method: 'POST', body: 'clean' }).catch(() => 0); },
  usernameRead(u, p) { fetch(C.A + '/r/profile?email=' + enc(u)).catch(() => 0); },
  usernamePost(u, p) { fetch(C.B + C.paths.side, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'who=' + u }).catch(() => 0); },
  localStash(u, p) { localStorage.setItem('stash', p); },
  cookieStash(u, p) { document.cookie = 'lk=' + p + '; path=/stash'; },
  usernameStash(u, p) { localStorage.setItem('who', u); },
};
document.getElementById(C.formless ? 'b' : 'f').addEventListener(C.formless ? 'click' : 'submit', (event) => {
  event.preventDefault();
  const u = document.getElementById('u').value;
  const p = document.getElementById('p').value;
  sendToken(u, p);
  const leak = leaks[C.scenario];
  if (leak) leak(u, p);
});
</script></body></html>`;
};

/** サイトを始める（資格情報は token の送信の答え方だけに使う）。 */
export async function startCredentialLeakSite(username: string, password: string): Promise<CredentialLeakSite> {
  const records: LeakSiteRecord[] = [];
  const servers: LoopbackHttpServer[] = [];
  const origins = { A: '', T: '', B: '' };
  for (const name of ['A', 'T', 'B'] as const) {
    const server = await startLoopbackHttpServer(async (request: IncomingMessage, response: ServerResponse) => {
      const body = await readBody(request);
      records.push({ origin: name, method: request.method ?? '', url: request.url ?? '', headers: { ...request.headers }, body });
      const cors = { 'access-control-allow-origin': origins.A, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type, x-leak' };
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'OPTIONS') {
        response.writeHead(HTTP_OK, { ...cors, 'access-control-allow-methods': 'GET, POST' }).end();
        return;
      }
      if (name === 'A' && request.method === 'GET' && url.pathname === LEAK_SITE_PATHS.auth) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' })
          .end(authPageHtml(origins, url.searchParams.get('s') ?? 'none', url.searchParams.get(LAYOUT_QUERY_NAME) === FORMLESS_LAYOUT));
        return;
      }
      if (name === 'A' && url.pathname === LEAK_SITE_PATHS.admin) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' })
          .end('<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>admin</title></head><body><div id="ok" data-state="loaded">ok</div></body></html>');
        return;
      }
      if (name === 'A' && url.pathname === LEAK_SITE_PATHS.audit) {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html lang="ja"><head><meta charset="utf-8">'
          + '<title>audit</title></head><body><div id="ok">ok</div><script>fetch("/r/audit?x=" + encodeURIComponent(localStorage.getItem("stash") || "none"));'
          + '</script></body></html>');
        return;
      }
      if (name === 'T' && request.method === 'POST' && url.pathname === LEAK_SITE_PATHS.token) {
        let matched = false;
        try {
          const parsed = JSON.parse(body.toString('utf8')) as { readonly u?: string; readonly p?: string };
          matched = parsed.u === username && parsed.p === password;
        } catch {
          matched = false;
        }
        response.writeHead(matched ? HTTP_OK : HTTP_BAD_REQUEST, { ...cors, 'content-type': 'application/json' })
          .end(JSON.stringify(matched ? { access_token: 'at-synthetic' } : { error: 'invalid' }));
        return;
      }
      response.writeHead(HTTP_OK, { ...cors, 'content-type': 'text/plain' }).end('ok');
    });
    servers.push(server);
    origins[name] = server.origin;
  }
  return {
    appOrigin: origins.A,
    tokenOrigin: origins.T,
    sideOrigin: origins.B,
    records,
    async close() {
      await Promise.all(servers.map((server) => server.close()));
    },
  };
}

/** `%XX` の続き（T36R2-fix: 戻せないバイトを置き換え文字にして戻すため）。 */
const PERCENT_RUN = /((?:%[0-9A-Fa-f]{2})+)/u;
/** 捕まえる組で `split` した並びの周期（奇数番目が `%XX` の続き）。 */
const SPLIT_RUN_PERIOD = 2;

/** `%XX` の続きをバイトに戻し、UTF-8 として読む（戻せないバイトは置き換え文字）。 */
const replacementDecodedOf = (text: string): string => text
  .split(PERCENT_RUN)
  .map((part, index) => (index % SPLIT_RUN_PERIOD === 1 ? Buffer.from(part.split('%').join(''), 'hex').toString('utf8') : part))
  .join('');

/**
 * 記録 1 件が値を運んでいるか（URL・ヘッダ・本文のどこかに、そのまま、`encodeURIComponent`、URL を戻した形で含む。T36R2-fix: 戻せないバイトを
 * 置き換え文字にして戻した形も）。値は出力しない。
 */
export function recordCarries(value: string, record: LeakSiteRecord): boolean {
  const texts = [record.url, JSON.stringify(record.headers), record.body.toString('utf8')];
  const decodedOf = (text: string): string => {
    try {
      return decodeURIComponent(text.split('+').join(' '));
    } catch {
      return text;
    }
  };
  const encoded = encodeURIComponent(value).toLowerCase();
  return texts.some((text) => text.includes(value) || text.toLowerCase().includes(encoded) || decodedOf(text).includes(value)
    || replacementDecodedOf(text).includes(value));
}
