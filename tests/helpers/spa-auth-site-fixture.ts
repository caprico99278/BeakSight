// T33b（Task 33 の設計書 `2026-10-16-beaksight-task-33-observation-fixture-design.md` 3.2）: スクリプトで送るログインの SPA と、別の Origin の
// 認証と API のサーバを持つ fixture（テストの補助）。127.0.0.1 だけで待ち受ける（`loopback-server.ts`）。
// - 4 つの Origin（どれも 127.0.0.1 で、ポートが違う）: アプリ（SPA の HTML と JS）、バックエンド（認証と API）、認証（`separateAuthOrigin` のとき、
//   認証の送り先をバックエンドから分ける第 3 の Origin）、ほか（`loginToThirdOrigin` のとき、ログインのスクリプトが送る、指定していない Origin）。
//   バックエンド・認証・ほかの 3 つは、同じ振る舞い（token、members、CORS）を持つ。どの Origin に届いたかは記録で分かる。
// - アプリの画面（ページの移動で開く。中の操作は `/app.js` のスクリプト）:
//   - `/auth`: `action` のないフォーム。スクリプトが `POST /auth/v1/token?grant_type=password`（JSON の本文 `{ email, password }`、API の鍵の
//     ヘッダ、`Content-Type: application/json`。事前確認が出る形）を送り、200 なら応答の JSON をローカル ストレージの名前つきの鍵
//     （`SPA_AUTH_STORAGE_KEY`）に保存して `/admin` へ移る。誤りなら画面に誤り（`#login-error`）を出す。
//   - `/admin`: ローカル ストレージになければ `/auth` へ移る。あれば Bearer と API の鍵で `GET /rest/v1/members` の一覧（`rpcReads` なら
//     `POST /rest/v1/rpc/list_members`）を読み、各行に更新の画面へのリンクと、登録の画面とログアウトへのリンクを出す。
//   - `/admin/members/new`: `action` のないフォーム。`POST /rest/v1/members`（JSON、`Prefer: return=representation`）。
//   - `/admin/members/<id>/edit`: `GET /rest/v1/members?id=eq.<id>` で前の値を読み、`PATCH /rest/v1/members?id=eq.<id>`。削除のボタン（`DELETE`）と、
//     論理削除の欄（`deleted`）を持つ。
//   - `/auth/logout`: ローカル ストレージを消して `/auth` へ移る。
// - バックエンドの振る舞い: token（`password` と `refresh_token`。有効期限は `tokenLifetimeMs`）、members の読み書き（メモリの中）、CORS（事前確認に
//   204 と CORS のヘッダ、本番の要求に `Access-Control-Allow-Origin`）。API の鍵と Bearer を確かめ、違えば 401。
// - 振る舞いの指定（`SpaAuthSiteOptions`）: `refreshAfterMs`、`refreshOnLoad`・`refreshRotation`（AS-c）、`rpcReads`、`websocket`、`separateAuthOrigin`、敵対的なログイン（`hostileLogin`。
//   `SPA_HOSTILE_LOGINS`）。T33c（実テスト環境の観察の形）: `preLoginRpc`（`/auth` と `/admin` を開いたときの、テナントを決める手続きの呼び出し。
//   結果がないときに画面を誤りにするかを選ぶ）、`postLoginFunction`（ログインの成功の直後の、サーバの関数の呼び出し。失敗のときに `/admin` へ移るかを
//   選ぶ）、`rumBeacon`（アプリの Origin への計測の送信）。
// - 記録: 4 つの Origin に届いた要求を順に記録する（Origin の別、method、path と query、要求のヘッダの名前、事前確認か、Bearer が正しかったか、JSON の
//   本文の最上位の鍵の名前）。値（ヘッダの値、本文の値、Cookie）は記録しない。
// - 秘密: メールとパスワード、API の鍵、発行した token は、起動のたびに作るランダムな仮の値（`randomSecretValue`）。`secretValues()` で、目印の検査に
//   だけ使う（テストは値を出力しない）。API の鍵は、本物の SPA と同じく、アプリの JS（`/app.js`）に入る（`apiKeyMarker`）。
// - T33c: アプリのスクリプトは、届かなかった要求（ネットワークの誤り。Guard が止めた場合を含む）を、状態 0 の失敗として扱い、画面に誤りを出す
//   （ログインの誤りの `data-reason` は `network`、応答の誤りは `status`）。
// - T37b: 任意の指定 `memberScreenLayout: 'formless'`（form のない登録と更新の画面。実テスト環境の観察の形）と `hostileMemberSave`（その画面の保存の
//   敵対的な送り方。`SPA_HOSTILE_MEMBER_SAVES`）。指定のないときの画面と振る舞いは変えない。
// - T37d: 任意の指定 `memberDetailPage`（会員の詳細の画面 `/admin/members/<id>`。項目を API で読んで後から `dl` に描く。画面の READ の確かめ用）。
//   指定のないときは、その path は今どおり 404。
// - T44c（Task 44 の設計書 P1-1〜P1-4 の測り。実テスト環境の形）: 任意の指定 `innerScrollList`（一覧の内側のスクロールの領域）、`serviceReadOnList`（一覧の後の
//   サービスへの読み取り）、`closingBeacon`（閉じるときの計測の送信）、`crowdedEditScreen`（押す候補の多い更新の画面）、`createSaveInDialog`（登録の画面だけ
//   ダイアログの中の保存）。指定のないときの画面と振る舞いは変えない。
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomSecretValue } from './authenticated-site-fixture.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from './loopback-server.js';

const STATUS_OK = 200;
/** DEF-138: セッションの切れの画面のリダイレクト（`sessionLossPage: 'server'`）。 */
const STATUS_FOUND = 302;
const STATUS_CREATED = 201;
const STATUS_NO_CONTENT = 204;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
/** T36b: `tokenResponse` の応答の状態（429 と 5xx）。 */
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_SERVER_ERROR = 500;
const STATUS_SERVICE_UNAVAILABLE = 503;
/** T36c: `tokenResponse` の `locked`（アカウントのロック）。 */
const STATUS_LOCKED = 423;
/** 受ける本文の上限（バイト）。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 既定の token の有効期限（ms）。 */
export const SPA_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
/** 1 秒（ms。`expires_in` の単位を秒にする）。 */
const SECOND_MS = 1_000;
/** `refreshLoop` のとき、ログインの後に続けて送る token の更新の回数。 */
export const SPA_REFRESH_LOOP_COUNT = 5;
/** WebSocket の受け入れの応答の鍵を作る、決まった GUID（RFC 6455）。 */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 最初の会員の ID。 */
const FIRST_MEMBER_ID = 1;

/** アプリの画面のパス。 */
export const SPA_APP_PATHS = Object.freeze({
  auth: '/auth',
  logout: '/auth/logout',
  admin: '/admin',
  memberNew: '/admin/members/new',
  script: '/app.js',
  /** `rumBeacon`: 配信の側の計測の送信（アプリと同じ Origin への POST。204）。 */
  rum: '/cdn-cgi/rum',
} as const);

/** アプリの更新の画面のパス（`/admin/members/<id>/edit`）。 */
export const spaMemberEditPathOf = (id: number | string): string => `/admin/members/${id}/edit`;

/** バックエンド（と認証・ほかの Origin）のパス。 */
export const SPA_BACKEND_PATHS = Object.freeze({
  token: '/auth/v1/token',
  members: '/rest/v1/members',
  rpcListMembers: '/rest/v1/rpc/list_members',
  /** `loginExtraPost`: ログインのスクリプトが token の後に送る、ログインの記録の POST。 */
  rpcLogLogin: '/rest/v1/rpc/log_login',
  /** `preLoginRpc`: `/auth` と `/admin` を開いたときに出す、テナントを決める手続きの呼び出し（API の鍵だけで答える）。 */
  rpcResolveTenant: '/rest/v1/rpc/resolve_tenant',
  /** `postLoginFunction`: ログインの成功の直後に出す、サーバの関数の呼び出し（状態を変える処理の形。Bearer が要る）。 */
  functionSyncAccess: '/functions/v1/sync_access',
  realtime: '/realtime/v1/websocket',
} as const);

/** token の `grant_type`。 */
export const SPA_GRANT_TYPES = Object.freeze({ password: 'password', refresh: 'refresh_token', other: 'pkce' } as const);
/** `preLoginRpc` の手続きの呼び出しが答えるテナントの ID（秘密ではない固定の値）。 */
export const SPA_TENANT_ID = 'tenant-1';
/** ログインの状態を保存する、ローカル ストレージの鍵の名前。 */
export const SPA_AUTH_STORAGE_KEY = 'fixture-auth-token';
/** API の鍵のヘッダの名前。 */
export const SPA_API_KEY_HEADER = 'apikey';
/** 書き込みで送る、応答の形の指定のヘッダ（名前と値）。 */
export const SPA_PREFER_HEADER = Object.freeze({ name: 'prefer', value: 'return=representation' } as const);
/** ログインのフォームの欄のセレクタ。 */
export const SPA_LOGIN_FIELDS = Object.freeze({ email: '#email', password: '#password', submit: '#login' } as const);
/** 会員のフォームの欄のセレクタ。 */
export const SPA_MEMBER_FIELDS = Object.freeze({
  name: '#name', email: '#member-email', note: '#note', deleted: '#deleted', submit: '#save', remove: '#remove',
} as const);
/** 画面の状態を `data-state` で出す要素の ID（テストが待つ）。 */
export const SPA_STATE_ELEMENTS = Object.freeze({
  loginError: 'login-error', members: 'members', member: 'member', refresh: 'refresh', websocket: 'ws', tenant: 'tenant',
} as const);
/** ログインの誤りの画面の文（日本語の短い文。値を持たない）。 */
export const SPA_LOGIN_ERROR_TEXT = 'メールアドレスかパスワードが違います。';

/**
 * `preLoginRpc` の扱い: `required` は、手続きの呼び出しの結果がなければ画面を誤りにする（`/auth` はログインを送らず、`/admin` は一覧を読まない）。
 * `optional` は、結果がなくても続ける。
 */
export const SPA_PRE_LOGIN_RPC_MODES = Object.freeze(['required', 'optional'] as const);
export type SpaPreLoginRpcMode = (typeof SPA_PRE_LOGIN_RPC_MODES)[number];

/**
 * `postLoginFunction` の扱い: `continueOnFailure` は、サーバの関数の呼び出しが失敗しても `/admin` へ移る。`stopOnFailure` は、失敗したら
 * ログインの画面に誤り（`data-reason` は `function`）を出して留まる。
 */
export const SPA_POST_LOGIN_FUNCTION_MODES = Object.freeze(['continueOnFailure', 'stopOnFailure'] as const);
export type SpaPostLoginFunctionMode = (typeof SPA_POST_LOGIN_FUNCTION_MODES)[number];

/** 敵対的なログイン（ログインのスクリプトの送り方）。 */
export const SPA_HOSTILE_LOGINS = Object.freeze([
  /** token の POST（password）を 2 回送る。 */
  'loginTwice',
  /** `grant_type` を password でない値（`SPA_GRANT_TYPES.other`）にして送る（バックエンドは 400）。 */
  'loginOtherGrant',
  /** token の POST を、指定していない別の Origin（`otherOrigin`）へ送る（その Origin も token を出す）。 */
  'loginToThirdOrigin',
  /** token の POST の後に、ログインの記録の POST（`SPA_BACKEND_PATHS.rpcLogLogin`）を送る。 */
  'loginExtraPost',
  /** token の POST の後に、token の更新（`refresh_token`）を `SPA_REFRESH_LOOP_COUNT` 回続けて送る。 */
  'refreshLoop',
] as const);
export type SpaHostileLogin = (typeof SPA_HOSTILE_LOGINS)[number];

/**
 * T36b: token の送信への応答の振る舞い（省略はふつうの応答。誤った資格情報は今どおり 400）。`rateLimited` は 429 と `Retry-After`
 * （`SPA_TOKEN_RETRY_AFTER`）、`serverError` は 503、`noResponse` は応答を返さずに接続を切る。T36c: `locked` は 423（アカウントのロック）。
 */
export const SPA_TOKEN_RESPONSE_MODES = Object.freeze(['rateLimited', 'serverError', 'noResponse', 'locked'] as const);
export type SpaTokenResponseMode = (typeof SPA_TOKEN_RESPONSE_MODES)[number];
/** T36b: `rateLimited` の `Retry-After` の値（秒）。 */
export const SPA_TOKEN_RETRY_AFTER = '120';

/**
 * T36R-fix（ユーザーの判断。form の要素のないログインの画面）: ログインの画面の形（省略は今の `/auth`。3 つの要素が 1 つの form の中）。セレクタは
 * どの形も `SPA_LOGIN_FIELDS`。ほかの形では、送信の要素を押したときにスクリプトが token を送る（form の送信の受け手は付けない）。
 * - `formless`: 3 つが form の外（送信は `button type="button"`）。`roleButton`: 3 つが form の外（送信は `div role="button"`）。
 * - `partialForm`: 2 つの欄は form の中、送信のボタンは form の外。`separateForms`: 3 つが別々の form の中。
 * - `linkSubmit`: 3 つが form の外で、送信の要素が `href` のある `a`。`duplicateFields`: `formless` に、同じ id のユーザー名の欄がもう 1 つ。
 * - T36R2-fix: `linkWrappedSubmit`: 3 つが form の外で、送信の要素（`role="button"` の `span`。`href` はない）が、`href` のある `a` の中。
 * - `hiddenPassword`: `formless` で、パスワードの欄が見えない。`readonlyUsername`: `formless` で、ユーザー名の欄が読み取りだけ。
 *   `disabledSubmit`: `formless` で、送信のボタンが押せない。
 */
export const SPA_LOGIN_LAYOUTS = Object.freeze([
  'formless',
  'roleButton',
  'partialForm',
  'separateForms',
  'linkSubmit',
  'linkWrappedSubmit',
  'duplicateFields',
  'hiddenPassword',
  'readonlyUsername',
  'disabledSubmit',
] as const);
export type SpaLoginLayout = (typeof SPA_LOGIN_LAYOUTS)[number];

/**
 * T36b: ログインのスクリプトが、token の送信の前に、ログインの記録の POST（`SPA_BACKEND_PATHS.rpcLogLogin`）を送る。本文と URL の形（資格情報を
 * 含まない `clean` と、資格情報を入れる 5 つの形）。
 * - `clean`: `{"event":"login"}`（資格情報なし）。
 * - `rawBody`: パスワードをそのまま入れた本文。`jsonBody`: パスワードを JSON の文字列にした本文。
 * - `urlEncodedBody`: メールアドレスを `encodeURIComponent` にした本文。`formBody`: `URLSearchParams` の形（メールアドレスとパスワード）。
 * - `query`: メールアドレスを `encodeURIComponent` にした query（本文は資格情報なし）。
 */
export const SPA_SIDE_REQUEST_BODIES = Object.freeze(['clean', 'rawBody', 'jsonBody', 'urlEncodedBody', 'formBody', 'query'] as const);
export type SpaSideRequestBody = (typeof SPA_SIDE_REQUEST_BODIES)[number];

/**
 * T37b（Task 37 の設計書 2 章・3.2・6 章の 1〜3）: 会員の登録と更新の画面の形（省略は今の form の画面）。`formless` は、実テスト環境の観察の形の
 * form のない画面（欄と `button type="button"` が form の外にあり、押すとスクリプト（`SPA_FORMLESS_MEMBER_PATHS.script`）が `fetch` で承認した API の
 * Origin（バックエンド）へ送る。JSON の本文と API の鍵・Bearer・`Prefer` のヘッダなので、事前確認が出る形）。登録は `POST /rest/v1/members`、更新は
 * 読み込みの時に `GET /rest/v1/members?id=eq.<id>` で前の値を読み、押すと `PATCH /rest/v1/members?id=eq.<id>`。path は今の画面と同じ
 * （`SPA_APP_PATHS.memberNew` と `spaMemberEditPathOf`）。セレクタは `SPA_MEMBER_FIELDS` の名前・メールアドレス・備考・保存。
 */
export const SPA_MEMBER_SCREEN_LAYOUTS = Object.freeze(['formless'] as const);
export type SpaMemberScreenLayout = (typeof SPA_MEMBER_SCREEN_LAYOUTS)[number];

/** T37b: form のない会員の画面のスクリプトの path と、画面の準備の状態を `data-state` に出す要素の ID（`ready`・`error`）。 */
export const SPA_FORMLESS_MEMBER_PATHS = Object.freeze({ script: '/member-screens.js' } as const);
export const SPA_FORMLESS_MEMBER_BOX = 'member-box';

/** T37b: 敵対的な保存が送る先のバックエンドの path（どれも fixture は答えない。Guard が止めるので届かないはず）。 */
export const SPA_HOSTILE_SAVE_PATHS = Object.freeze({
  /** `rpcCall`: 手続きの呼び出しで書く。 */
  rpcUpsertMember: '/rest/v1/rpc/upsert_member',
  /** `probeAware`: probe の目印に見える値を見分けたときに送る、別の表。 */
  membersShadow: '/rest/v1/members_shadow',
  /** T37R2-fix-A: `encodedRpcPath`: 二重に percent-encode した手続きの呼び出しの区切り（`%2572pc` は戻すと `rpc`）。 */
  encodedRpcUpsertMember: '/rest/v1/%2572pc/upsert_member',
  /** T37R2-fix-A: `paramRpcPath`: path の引数（`;v=1`）を付けた手続きの呼び出しの区切り。 */
  paramRpcUpsertMember: '/rest/v1/rpc;v=1/upsert_member',
} as const);

/** T37R2-fix-A: `methodOverrideHeader` が付ける、method を上書きするヘッダ（名前と値）。 */
export const SPA_METHOD_OVERRIDE_HEADER = Object.freeze({ name: 'X-HTTP-Method-Override', value: 'DELETE' } as const);

/** 型の digest v2: `extraPageHeader` が付ける、ページのヘッダ（名前と値。秘密ではない固定の値）。 */
export const SPA_EXTRA_PAGE_HEADER = Object.freeze({ name: 'x-client-info', value: 'fixture-client/1' } as const);

/** T37c fix round 1: 押す対象を増やすボタンの語（それぞれ別の分類の語なので、別の識別の候補になる）と、押したときの POST の path の頭。 */
export const SPA_EXTRA_PRESS_TARGET_WORDS = Object.freeze(['追加', '作成', '新規', '変更', '編集'] as const);
export const SPA_EXTRA_PRESS_PATH_PREFIX = '/rest/v1/extra_';
/** T38a: 保存と同じ要求を送る、もう 1 つのボタンの ID（`secondSaveButton`）。 */
export const SPA_SECOND_SAVE_BUTTON_ID = 'save-again';
/**
 * DEF-142（`pressPriorityTargets`）: 画面の先頭に置く、文字のないボタン（アイコンのボタン。押しても何も送らない）の数と、保存のボタンの前に置く見えない
 * ボタン（`display:none`）の語（どれも登録の語。それぞれ別の識別の候補）と、見えないボタンを押したときの POST の path の頭（押せないので届かないはず）。
 */
export const SPA_ICON_BUTTON_COUNT = 3;
export const SPA_HIDDEN_PRESS_TARGET_WORDS = Object.freeze(['追加', '作成', '登録'] as const);
export const SPA_HIDDEN_PRESS_PATH_PREFIX = '/rest/v1/hidden_';
/**
 * DEF-144（`externalSchemeButton`）: 保存のボタンの前に置く、押すとページの JS が外部スキーム（`mailto:`）へ移るボタンの ID と語（登録の語。押す前の読み取りでは
 * 見分けられない形）。
 */
export const SPA_EXTERNAL_SCHEME_BUTTON = Object.freeze({ id: 'mail-member', word: '追加', href: 'mailto:member@example.invalid' } as const);
/**
 * DEF-147（`publicationStatusField`）: 公開の状態の欄（select。ID と name と本文の鍵は `status`）と、選択肢（空の選択肢、下書き、公開）。probe は空でない最初の
 * 選択肢を選ぶ。
 */
export const SPA_PUBLICATION_STATUS_FIELD = Object.freeze({ id: 'status', options: ['', 'draft', 'published'] } as const);
/** DEF-145（`saveInDialog`）: 押すと、欄と保存のボタンの入った閉じたダイアログを開くボタンの ID と文言（登録の語を含む）と、ダイアログの ID。 */
export const SPA_DIALOG_OPEN_BUTTON = Object.freeze({ id: 'open-member-dialog', text: '新規作成', dialogId: 'member-dialog' } as const);

/**
 * T39d: form のない会員の画面の、入力と押下の部品（`src/browser/api-write-submitter.ts`）への敵対的な形。
 * - `duplicateName`: 名前の欄と同じ name の欄がもう 1 つある。`duplicateSubmit`: 保存のボタンと同じ形（同じ識別の候補）のボタンがもう 1 つある。
 * - `rewriteOnInput`: 名前の欄に入れた値を、ページの JS が入力のたびに書き換える（末尾に `SPA_REWRITE_SUFFIX` を足す）。
 * - `hiddenField`: 備考の欄が見えない。`linkWrappedSubmit`: 保存のボタンが `href` のあるリンクの中にある。
 */
export const SPA_HOSTILE_MEMBER_INPUTS = Object.freeze(['duplicateName', 'duplicateSubmit', 'rewriteOnInput', 'hiddenField', 'linkWrappedSubmit'] as const);
export type SpaHostileMemberInput = (typeof SPA_HOSTILE_MEMBER_INPUTS)[number];
/** T39d: `duplicateSubmit` のもう 1 つのボタンの ID。 */
export const SPA_DUPLICATE_SAVE_BUTTON_ID = 'save-copy';
/** T39d: `rewriteOnInput` で、ページの JS が値の末尾に足す文字。 */
export const SPA_REWRITE_SUFFIX = '!';

/**
 * T37b: form のない会員の画面の、保存のボタンの敵対的な送り方（省略はふつうの登録と更新。指定すると、画面の形は `formless` になる）。登録の画面では
 * ID の filter を持たない（`deleteOnSave` は filter のない `DELETE`）。
 * - `deleteOnSave`: `DELETE`。`upsert`: `POST ?on_conflict=id` と `Prefer: resolution=merge-duplicates`。`arrayBody`: 本文が array の `POST`。
 * - `unfilteredPatch`: filter のない `PATCH`。`rpcCall`: 手続きの呼び出し（`SPA_HOSTILE_SAVE_PATHS.rpcUpsertMember`）の `POST`。
 * - `doubleSend`: 1 回の押下で、ふつうの要求を 2 回送る。`softDeleteKey`: ふつうの要求の本文に論理削除の鍵（`deleted`）を足す。
 * - `unapprovedOrigin`: ふつうの要求を、承認していない Origin（`otherOrigin`）へ送る。
 * - `probeAware`: メールアドレスの欄の値が `.invalid` で終わる（probe の目印に見える）なら、別の表（`SPA_HOSTILE_SAVE_PATHS.membersShadow`）へ
 *   空の object の `POST` を送り、そうでなければふつうの要求を送る。
 * - `navigateOnSave`: 送らずに一覧（`SPA_APP_PATHS.admin`）へ移る。
 * - T37R2-fix-A: `methodOverrideHeader`: ふつうの要求に method を上書きするヘッダ（`SPA_METHOD_OVERRIDE_HEADER`）を付ける。`bodyMethodOverride`: ふつうの
 *   要求の本文に `_method: 'DELETE'` を足す。`encodedRpcPath`・`paramRpcPath`: 手続きの呼び出しを、二重の encode か path の引数で隠した path
 *   （`SPA_HOSTILE_SAVE_PATHS`）へ `POST` する。
 * - 型の digest v2（Task 38 の設計書 7 章の最後の行）: `extraPageHeader`: ふつうの要求に、ページが付けるヘッダ（`SPA_EXTRA_PAGE_HEADER`）を 1 つ足す
 *   （敵対的ではない。ページが付けるヘッダの名前が変われば型の digest が変わることを確かめる）。
 * - T41d（Task 41 の設計書 3.6）: `keptValueRewrite`: ふつうの要求の本文の備考（保つ欄）を `SPA_REWRITTEN_NOTE` に書き換える。`filterRewrite`: 更新の
 *   filter の ID を別の会員（ID + 1）に替えて送る。
 */
export const SPA_HOSTILE_MEMBER_SAVES = Object.freeze([
  'deleteOnSave',
  'upsert',
  'arrayBody',
  'unfilteredPatch',
  'rpcCall',
  'doubleSend',
  'softDeleteKey',
  'unapprovedOrigin',
  'probeAware',
  'navigateOnSave',
  'methodOverrideHeader',
  'bodyMethodOverride',
  'encodedRpcPath',
  'paramRpcPath',
  'extraPageHeader',
  'keptValueRewrite',
  'filterRewrite',
] as const);
export type SpaHostileMemberSave = (typeof SPA_HOSTILE_MEMBER_SAVES)[number];

/**
 * T40b-1（Task 40 の設計書 3.3・5 章の 3）: 会員の登録（`POST /rest/v1/members`）への応答の形（`setMemberSaveResponse` で替える。null はふつうの応答で、
 * 今の振る舞いのまま）。登録の要求そのものは、どの形でも記録に残る。
 * - `markedRepresentation`: 201 と、登録した行に目印の項目（`SPA_MEMBER_SAVE_RESPONSE_MARKER_KEY`。値は `memberSaveResponseMarker()`）を足した表現
 *   （応答の本文が記録・成果物に出ないことを確かめる）。会員を足す。
 * - `noRecordId`: 201 で本文なし（ID のない 2xx）。会員を足す。
 * - `clientError`: 400。`rateLimited`: 429。`serverError`: 503（どれも会員を足さない）。
 * - `noResponse`: 応答を返さずに接続を切る（会員を足さない）。
 * - `outOfRangeStatus`: 100〜599 の外の状態（`SPA_OUT_OF_RANGE_STATUS`）。会員を足さない。
 */
export const SPA_MEMBER_SAVE_RESPONSES = Object.freeze([
  'markedRepresentation',
  'noRecordId',
  'clientError',
  'rateLimited',
  'serverError',
  'noResponse',
  'outOfRangeStatus',
] as const);
export type SpaMemberSaveResponse = (typeof SPA_MEMBER_SAVE_RESPONSES)[number];
/** T40b-1: `markedRepresentation` の目印の項目の名前。 */
export const SPA_MEMBER_SAVE_RESPONSE_MARKER_KEY = 'server_note';
/** T40b-1: `outOfRangeStatus` の状態（HTTP の 3 桁の形だが、100〜599 の外）。 */
export const SPA_OUT_OF_RANGE_STATUS = 600;

/**
 * T40b-2（Task 40 の設計書 3.3、7 章の「T40b-2 の設計」）: 会員の詳細の画面（`memberDetailPage`）の読み取りの形（`setMemberDetailResponse` で替える。null は
 * ふつうの画面で、今の振る舞いのまま）。照合の READ が一致しない・判定できない場面を作る。
 * - `mismatch`: バックエンドの ID の絞り込みの読み取り（`GET /rest/v1/members?id=eq.<id>`）が、メールアドレスを `SPA_MISMATCH_EMAIL` に替えた行を返す。
 * - `serverError`: 詳細の画面の HTML が 500。
 * - `unauthorizedRead`: バックエンドの ID の絞り込みの読み取りが 401（サービスの Origin が断った読み取り）。
 */
export const SPA_MEMBER_DETAIL_RESPONSES = Object.freeze(['mismatch', 'serverError', 'unauthorizedRead'] as const);
export type SpaMemberDetailResponse = (typeof SPA_MEMBER_DETAIL_RESPONSES)[number];
/**
 * T40R-fix-A: `setMemberSaveAborted` のとき、ページが保存の要求を取り消すまでの時間（ms）と、サーバが登録の応答を遅らせる時間（ms。取り消しより十分長い。
 * 要求はサーバに届いて記録され、応答は取り消しの後に返る）。
 */
export const SPA_SAVE_ABORT_AFTER_MS = 300;
export const SPA_ABORTED_SAVE_RESPONSE_DELAY_MS = 1_500;
/**
 * T41d（Task 41 の設計書 3.6）: 会員の更新（`PATCH /rest/v1/members?id=eq.<id>`）への応答の形（`setMemberUpdateResponse` で替える。null はふつうの応答）。
 * - `emptyRows`: 200 と空の一覧 `[]`（更新した行がない。会員は変えない）。
 * - `noContent`: 会員を変え、`Prefer: return=representation` でも 204 で本文なし。
 * - `otherRecordId`: 会員を変え、表現の `id` を別の値（`SPA_OTHER_RECORD_ID_OFFSET` を足した番号）にして返す。
 * - `clientError`: 400。`serverError`: 503。`noResponse`: 応答を返さずに接続を切る（どれも会員を変えない）。
 * - `twoRows`（T41R-fix の I-2）: 会員を変え、表現の一覧に 2 行（変えた行と、`id` に `SPA_OTHER_RECORD_ID_OFFSET` を足した行）を入れて返す。
 * - `largeTwoRows`（T41R2-fix の M-1）: `twoRows` の 2 行に、`SPA_LARGE_BODY_PADDING_LENGTH` の長さの項目を足して返す（読む上限を超える本文）。
 * - `notJson`（T41R2-fix の M-1）: 会員を変え、200 と JSON でない本文を返す。
 */
export const SPA_MEMBER_UPDATE_RESPONSES = Object.freeze([
  'emptyRows', 'noContent', 'otherRecordId', 'clientError', 'serverError', 'noResponse', 'twoRows', 'largeTwoRows', 'notJson',
] as const);
/** T41R3-fix: `setMemberPlaceholderEmail` のとき、メールアドレスの欄にすぐ入れる仮の値。 */
export const SPA_PLACEHOLDER_TEXT = '読み込み中';
/** T41R2-fix: 開いたままにする読み取りの要求の query の名前（`setMemberHoldRequest`）。 */
export const SPA_HOLD_QUERY_NAME = 'bs_hold';
/** T41R2-fix: `largeTwoRows` の行ごとに足す項目の長さ（応答の本文を読む上限の 1 MiB を超えるように）。 */
export const SPA_LARGE_BODY_PADDING_LENGTH = 1_100_000;
/** T41d: `otherRecordId` で、表現の `id` に足す数。 */
export const SPA_OTHER_RECORD_ID_OFFSET = 1_000;
export type SpaMemberUpdateResponse = (typeof SPA_MEMBER_UPDATE_RESPONSES)[number];
/** T41d: `setMemberUpdateSideEffect` のとき、サーバが更新のたびに備考（保つ欄）に入れる値の頭（後に `-` と回の番号を付ける）。 */
export const SPA_SERVER_SIDE_EFFECT_NOTE = 'server-side-effect';
/** T41d: `keptValueRewrite` で、ページが備考（保つ欄）に入れる値。 */
export const SPA_REWRITTEN_NOTE = 'page-rewritten-note';
/** T41d: `setMemberValuesDelayed` のとき、更新の画面が準備の後に読んだ値を入れるまでの時間（ms）。 */
export const SPA_MEMBER_VALUES_DELAY_MS = 300;
/** T40b-2: `mismatch` で返すメールアドレス（生成した値と一致しない）。 */
export const SPA_MISMATCH_EMAIL = 'other-member@example.invalid';

/** 要求の届いた Origin。 */
export type SpaSiteOrigin = 'app' | 'backend' | 'auth' | 'other';

/** 届いた要求の記録（値は持たない）。 */
export interface SpaAuthSiteRequest {
  readonly origin: SpaSiteOrigin;
  /** method（WebSocket の upgrade は `UPGRADE`）。 */
  readonly method: string;
  /** path と query。 */
  readonly path: string;
  /** 要求のヘッダの名前（小文字。並べ替えた順）。 */
  readonly headerNames: readonly string[];
  /** CORS の事前確認（`OPTIONS` で `Access-Control-Request-Method` を持つ）か。 */
  readonly preflight: boolean;
  /** `Authorization: Bearer` の token が有効だったか（`Authorization` がなければ null）。 */
  readonly bearerValid: boolean | null;
  /** JSON の本文の最上位の鍵の名前（並べ替えた順。本文がない・JSON の object でなければ空）。 */
  readonly bodyKeys: readonly string[];
}

/** 会員（メモリの中の行）。 */
export interface SpaMember {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly note: string;
  readonly deleted: boolean;
}

/** 振る舞いの指定。 */
export interface SpaAuthSiteOptions {
  /** 画面が token の更新を送るまでの時間（ms。`/admin` を開いてから 1 回。null か省略は送らない）。 */
  readonly refreshAfterMs?: number | null;
  /**
   * AS-c: 管理画面と会員の画面を開くたびに、最初に token を更新してから画面を描く（更新に失敗したら、ログインの状態を消して、ログインの画面へ移る）。普通の
   * アプリが、読み込みのたびに token を入れ替える形の代わり。
   */
  readonly refreshOnLoad?: boolean;
  /**
   * AS-c: token の更新で、使った refresh token と組の access token を無効にする。使い終えた refresh token がもう一度使われたら、セッションを消す（すべての
   * token を無効にする）。更新した状態を次の読み込みへ引き継がないと、2 回目の読み込みで切れる形。
   */
  readonly refreshRotation?: boolean;
  /** 一覧を `POST /rest/v1/rpc/list_members` で読む。 */
  readonly rpcReads?: boolean;
  /** 管理画面が WebSocket（`SPA_BACKEND_PATHS.realtime`）をつなぐ。 */
  readonly websocket?: boolean;
  /** 認証（token）の送り先を、API のバックエンドと別の Origin（`authOrigin`）にする。 */
  readonly separateAuthOrigin?: boolean;
  /** token の有効期限（ms。既定は `SPA_DEFAULT_TOKEN_LIFETIME_MS`）。 */
  readonly tokenLifetimeMs?: number;
  /** 敵対的なログイン（省略はふつうのログイン）。 */
  readonly hostileLogin?: SpaHostileLogin;
  /** `/auth` と `/admin` を開いたときに、テナントを決める手続きの呼び出し（`SPA_BACKEND_PATHS.rpcResolveTenant`）を出す（省略は出さない）。 */
  readonly preLoginRpc?: SpaPreLoginRpcMode;
  /** ログインの成功の直後に、サーバの関数の呼び出し（`SPA_BACKEND_PATHS.functionSyncAccess`）を出す（省略は出さない）。 */
  readonly postLoginFunction?: SpaPostLoginFunctionMode;
  /** `/auth` と `/admin` を開いたときに、アプリの Origin への計測の送信（`SPA_APP_PATHS.rum`）を出す。 */
  readonly rumBeacon?: boolean;
  /**
   * T35c: 管理画面が一覧を読んだ後に、最初の会員のメールアドレスで絞り込んだ一覧の読み取り（`GET /rest/v1/members?select=id&email=eq.<メール>`）も送る
   * （成果物の、サービスの Origin の URL の query の値の伏せ方を確かめる）。
   */
  readonly emailFilterRead?: boolean;
  /**
   * T35c: 管理画面が一覧を読んだ（と絞り込みの読み取りの）後に、ローカル ストレージのログインの状態の鍵を消す（画面は移らない。ログインの状態が消えた
   * ことの見分けを確かめる。ログアウトや期限の代わり）。
   */
  readonly clearSessionAfterList?: boolean;
  /** T36b: token の送信への応答の振る舞い（`SPA_TOKEN_RESPONSE_MODES`。省略はふつうの応答）。 */
  readonly tokenResponse?: SpaTokenResponseMode;
  /** T36b: token の送信の前に、ログインの記録の POST を送る（`SPA_SIDE_REQUEST_BODIES`。省略は送らない）。 */
  readonly sideRequestBeforeToken?: SpaSideRequestBody;
  /**
   * T36b（T36a の懸念）: ログインの画面のスクリプトが、送信を止めない（送信の受け手を付けない）。送信のボタンを押すと、ブラウザがフォームを既定の
   * GET（`action` のない form なので `/auth?email=…&password=…`）で送る。
   */
  readonly nativeFormSubmit?: boolean;
  /** T36R-fix: ログインの画面の形（`SPA_LOGIN_LAYOUTS`。省略は今の `/auth`）。 */
  readonly loginLayout?: SpaLoginLayout;
  /** T37b: 会員の登録と更新の画面の形（`SPA_MEMBER_SCREEN_LAYOUTS`。省略は今の form の画面）。 */
  readonly memberScreenLayout?: SpaMemberScreenLayout;
  /** T37b: form のない会員の画面の、保存の敵対的な送り方（`SPA_HOSTILE_MEMBER_SAVES`。指定すると画面の形は `formless`）。 */
  readonly hostileMemberSave?: SpaHostileMemberSave;
  /**
   * T37c fix round 1: form のない会員の画面の保存のボタンの後に、押す対象（listener のあるボタン）を足す数（省略は 0。指定すると画面の形は `formless`）。
   * 語は `SPA_EXTRA_PRESS_TARGET_WORDS` の順で、押すと `SPA_EXTRA_PRESS_PATH_PREFIX` に番号を付けた path へ POST を送る。
   */
  readonly extraPressTargets?: number;
  /**
   * T38a: form のない会員の画面の保存のボタンの後に、保存と同じ要求を送るボタン（`SPA_SECOND_SAVE_BUTTON_ID`。文言「送信」）を足す（省略は足さない。指定すると
   * 画面の形は `formless`）。同じ画面で 2 回押したときの型の digest を確かめる。
   */
  readonly secondSaveButton?: boolean;
  /**
   * DEF-142: form のない会員の画面の先頭に、文字のないボタン（`SPA_ICON_BUTTON_COUNT` 個。listener はあるが何も送らない）を置き、保存のボタンの前に
   * 見えないボタン（`SPA_HIDDEN_PRESS_TARGET_WORDS`）を置く（省略は置かない。指定すると画面の形は `formless`）。probe の押す順を確かめる。
   */
  readonly pressPriorityTargets?: boolean;
  /**
   * DEF-144: form のない会員の画面の保存のボタンの前に、押すとページの JS が外部スキームへ移るボタン（`SPA_EXTERNAL_SCHEME_BUTTON`）を置く（省略は置かない。
   * 指定すると画面の形は `formless`）。
   */
  readonly externalSchemeButton?: boolean;
  /**
   * DEF-145: form のない会員の画面の欄と保存のボタンを、閉じたダイアログ（`<dialog>`）の中に置き、その後ろに、押すとダイアログを開くボタン
   * （`SPA_DIALOG_OPEN_BUTTON`。登録の語）を置く（省略は置かない。指定すると画面の形は `formless`）。
   */
  readonly saveInDialog?: boolean;
  /** DEF-147: form のない会員の画面に、公開の状態の欄（`SPA_PUBLICATION_STATUS_FIELD`）を置き、保存の本文に入れる（指定すると画面の形は `formless`）。 */
  readonly publicationStatusField?: boolean;
  /** T39d: form のない会員の画面の、入力と押下の部品への敵対的な形（`SPA_HOSTILE_MEMBER_INPUTS`。指定すると画面の形は `formless`）。 */
  readonly hostileMemberInput?: SpaHostileMemberInput;
  /**
   * T37d（Task 37 の設計書 3.5）: 会員の詳細の画面（`spaMemberDetailPathOf`。`/admin/members/<id>`）を出す（省略は出さない）。画面の骨組みは空の
   * `dl`（`SPA_MEMBER_DETAIL_ELEMENT`）で、スクリプトが `GET /rest/v1/members?id=eq.<id>` で読んだ値を、項目（`SPA_MEMBER_DETAIL_TERMS`）として後から
   * 描く（データを後から API で描く画面。読めなければ `data-state` を `error` にして何も描かない）。
   */
  readonly memberDetailPage?: boolean;
  /**
   * T37d fix round 1: 管理画面が、一覧を描いた後に、一覧の手続きの呼び出し（`SPA_BACKEND_PATHS.rpcListMembers`。`rpcReads` のときだけ）をもう 1 回出す
   * （結果は見ない。登録した読み取りの手続きの呼び出しの、1 回の読み込みあたりの回数の上限を確かめる）。省略は出さない。
   */
  readonly repeatedListRpc?: boolean;
  /**
   * T43d（Task 43 の設計書 4.4）: ログインの画面と管理画面の両方の先頭に、ログアウトの語を含む同じ見出しのリンク（`SPA_SHARED_HEADER_LINK`）を出す
   * （省略は出さない）。成功の画面のセレクタの案が、ログインの画面にもある要素を外すことを確かめる。
   */
  readonly sharedHeaderLink?: boolean;
  /**
   * T43R-fix の C-1: 管理画面に、利用者の名前（`SPA_HOSTILE_OBSERVATION_USER`）の入る見出しのリンク（id と href）と、名前を間に持つローカル ストレージの
   * 鍵（`SPA_HOSTILE_OBSERVATION_KEYS`）を足す（省略は足さない）。
   */
  readonly hostileObservation?: boolean;
  /**
   * DEF-138: 管理画面の最初のリンクに、セッションの切れの画面（`SPA_SESSION_LOSS_PATH`）を出し、その画面でログインの画面へ移る（`SPA_SESSION_LOSS_PAGES`。
   * 省略は出さない）。
   */
  readonly sessionLossPage?: SpaSessionLossPage;
  /**
   * T44c（Task 44 の設計書 P1-4。実テスト環境の形）: 管理画面の一覧の表を、高さを決めた内側のスクロールの領域（`SPA_INNER_SCROLL_CONTAINER`）に入れ、その中に
   * 背の高い余白を置く（文書は画面に収まり、内側の領域だけがスクロールできる。`INNER_SCROLL_CONTAINER_NOT_TRAVERSED` になる形）。省略は今の画面。
   */
  readonly innerScrollList?: boolean;
  /**
   * T44c（P1-1 の測り）: 管理画面が、一覧を読んだ後に、サービスへの読み取り（`GET /rest/v1/members?select=id`。`SPA_SERVICE_READ_QUERY`）を 1 回出す（幅の走査の
   * 読み込みでも出る）。省略は出さない。
   */
  readonly serviceReadOnList?: boolean;
  /**
   * T44c（P1-2 の測り）: 管理画面を閉じる（`pagehide`）ときに、アプリの Origin への計測の送信（`navigator.sendBeacon`。`SPA_APP_PATHS.rum` に query
   * `event=<SPA_CLOSING_BEACON_EVENT>`）を出す。届いた数は `closingBeacons`。省略は出さない。
   */
  readonly closingBeacon?: boolean;
  /**
   * T44c（P1-3。実テスト環境の形）: form のない更新の画面を、押す候補の多い画面にする（指定すると画面の形は `formless`）。先頭に文字のないボタン
   * （`SPA_CROWDED_ICON_BUTTON_COUNT` 個。何も送らない）、保存のボタンの後に登録・更新の語の道具のボタン（`SPA_TOOLBAR_PRESS_WORDS`。何も送らない）、
   * 最後に見えないボタン（`SPA_HIDDEN_PRESS_TARGET_WORDS`。押されたら `SPA_HIDDEN_PRESS_PATH_PREFIX` へ POST）を置く。登録の画面は変えない。
   */
  readonly crowdedEditScreen?: boolean;
  /**
   * T44c（実テスト環境の形）: form のない登録の画面だけ、欄と保存のボタンを閉じたダイアログの中に置き、その後ろに開くボタン（`SPA_DIALOG_OPEN_BUTTON`）を
   * 置く（`saveInDialog` と同じ形を、登録の画面だけに当てる。指定すると画面の形は `formless`）。
   */
  readonly createSaveInDialog?: boolean;
}

/** T44c: `innerScrollList` の内側のスクロールの領域の ID、高さ（px）、中の余白の高さ（px）。 */
export const SPA_INNER_SCROLL_CONTAINER = Object.freeze({ id: 'member-scroll', heightPx: 160, spacerPx: 3_000 } as const);
/** T44c: `serviceReadOnList` のサービスへの読み取りの query。 */
export const SPA_SERVICE_READ_QUERY = 'select=id';
/** T44c: `closingBeacon` の計測の送信の query の値（`event=<値>`）。 */
export const SPA_CLOSING_BEACON_EVENT = 'pagehide';
/** T44c: `crowdedEditScreen` の、先頭の文字のないボタンの数（1 画面の押す回数の上限より多い）。 */
export const SPA_CROWDED_ICON_BUTTON_COUNT = 6;
/** T44c: `crowdedEditScreen` の、保存のボタンの後の道具のボタンの語（どれも登録・更新の語。保存と見えないボタンの語と重ならない。押しても何も送らない）。 */
export const SPA_TOOLBAR_PRESS_WORDS = Object.freeze(['新規', '変更', '編集', '修正'] as const);

/** T37d: 会員の詳細の画面の path（`memberDetailPage` のときだけ出す）。 */
export const spaMemberDetailPathOf = (id: number | string): string => `/admin/members/${id}`;
/** T37d: 会員の詳細の画面の、項目を描く `dl` の ID。 */
export const SPA_MEMBER_DETAIL_ELEMENT = 'member-detail';
/** T37d: 会員の詳細の画面の項目の名前（`dt` の文字。この順）。 */
export const SPA_MEMBER_DETAIL_TERMS = Object.freeze({ name: '名前', email: 'メールアドレス', state: '状態' } as const);

export interface SpaAuthSite {
  readonly appOrigin: string;
  readonly backendOrigin: string;
  /** 認証の Origin（`separateAuthOrigin` のときにログインのスクリプトが送る先。ほかのときは使われない）。 */
  readonly authOrigin: string;
  /** 指定していない別の Origin（`loginToThirdOrigin` のときにログインのスクリプトが送る先）。 */
  readonly otherOrigin: string;
  /** ログインのスクリプトが token を送る Origin（`separateAuthOrigin` なら `authOrigin`、ほかは `backendOrigin`）。 */
  readonly tokenOrigin: string;
  /** 届いた要求（届いた順）。 */
  readonly requests: readonly SpaAuthSiteRequest[];
  /** 正しい資格情報で token を出した回数（password）。 */
  readonly successfulLogins: number;
  /** token の更新に成功した回数。 */
  readonly refreshes: number;
  /** AS-c: 使い終えた refresh token がもう一度使われた回数（`refreshRotation`。セッションを消した回数）。 */
  readonly reusedRefreshes: number;
  /** 会員の数。 */
  readonly memberCount: number;
  /** サーバの関数の呼び出し（`postLoginFunction`）に答えた回数。 */
  readonly functionCalls: number;
  /** 計測の送信（`rumBeacon`）を受けた回数。 */
  readonly rumBeacons: number;
  /** T44c: 閉じるときの計測の送信（`closingBeacon`）を受けた回数（`rumBeacons` には数えない）。 */
  readonly closingBeacons: number;
  /** ログインのフォームの欄に、正しい資格情報を入れる（値はテストに返さない）。 */
  fillCredentials(fill: (selector: string, value: string) => Promise<void>): Promise<void>;
  /** 有効な token を出し、ローカル ストレージ（`SPA_AUTH_STORAGE_KEY`）に入れる値（JSON の文字列）を返す（認証済みの状態の組み立てに使う。値を出力しない）。 */
  issueStoredSession(): string;
  /** 会員を直接足す（テストの準備。ID を返す）。T41R-fix: `values` でメールアドレスと備考を替えられる（省略は今までどおり）。 */
  addMember(name: string, values?: { readonly email?: string; readonly note?: string }): number;
  /** 会員の今の値（なければ undefined）。 */
  memberOf(id: number): SpaMember | undefined;
  /** 出てはならない秘密の目印（メール、パスワード、API の鍵、発行したすべての token）。 */
  secretValues(): readonly string[];
  /** DEF-138: セッションの切れの画面がログインの画面へ移るときの query の値の目印（`ticket` と `from` の値。値を出力しない）。 */
  sessionLossMarkers(): readonly string[];
  /**
   * T33c: API の鍵の値（`secretValues` に含む）。本物の SPA と同じくアプリのスクリプトに入る値なので、目印の検査で、出てよい場所を分けて数える
   * ために使う（値を出力しない）。
   */
  apiKeyMarker(): string;
  /**
   * T38c: form のない会員の画面の保存の送り方を、起動の後に替える（`hostileMemberSave` と同じ値。null はふつうの送り方）。次に読み込んだ画面の
   * スクリプトから効く。同じ画面（同じ識別の候補）のまま、本文の鍵などの型を変えるために使う（例 `softDeleteKey` は鍵 `deleted` を足す）。
   */
  setHostileMemberSave(save: SpaHostileMemberSave | null): void;
  /**
   * T38R2-fix（R2-I-1）: `hostileMemberInput: 'duplicateSubmit'` のもう 1 つのボタン（同じ識別の候補）だけが、保存の要求を 2 回送るようにする（false は
   * 保存と同じ 1 回。初めは false）。次に読み込んだ画面のスクリプトから効く。同じ識別の probe が 1 つの要求と 2 つの要求に分かれる形を作る。
   */
  setDuplicateSaveSendsTwice(twice: boolean): void;
  /** T40b-1: 会員の登録への応答の形を替える（`SPA_MEMBER_SAVE_RESPONSES`。null はふつうの応答。次に届いた登録から効く）。 */
  setMemberSaveResponse(response: SpaMemberSaveResponse | null): void;
  /** T40b-1: `markedRepresentation` の応答の本文に入れる目印（起動のたびに作るランダムな値。値を出力しない）。 */
  memberSaveResponseMarker(): string;
  /**
   * T40b-2: `markedRepresentation` の応答の本文の `id` を、この値に替える（null は登録した行の番号のまま。会員の行の番号は替えない）。取れた ID が読まない
   * パスや危険な語に当たる場面を作る。
   */
  setMemberSaveRecordId(id: string | null): void;
  /** T40b-2: 会員の詳細の画面の読み取りの形を替える（`SPA_MEMBER_DETAIL_RESPONSES`。null はふつうの画面）。 */
  setMemberDetailResponse(response: SpaMemberDetailResponse | null): void;
  /**
   * T40R-fix-A: form のない会員の画面のスクリプトが、3 つの欄がそろった入力の事象で、押されなくても保存の要求（承認どおりの形）を 1 回送るようにする
   * （初めは false。次に読み込んだ画面のスクリプトから効く）。
   */
  setMemberSaveOnInput(on: boolean): void;
  /**
   * T40R-fix-A: ふつうの保存の要求を、ページが送った後（`SPA_SAVE_ABORT_AFTER_MS`）に取り消し、サーバは `markedRepresentation` の応答を
   * `SPA_ABORTED_SAVE_RESPONSE_DELAY_MS` だけ遅らせる（初めは false。画面のスクリプトは次に読み込んだ画面から効く）。
   */
  setMemberSaveAborted(on: boolean): void;
  /** T41d: form のない更新の画面のスクリプトが、更新の本文に読んだ値から変わった鍵だけを入れる（初めは false。次に読み込んだ画面から効く）。 */
  setMemberUpdateChangedOnly(on: boolean): void;
  /** T41d: サーバが、更新のたびに備考（保つ欄）を `SPA_SERVER_SIDE_EFFECT_NOTE` で始まる回ごとに違う値に変える（初めは false）。 */
  setMemberUpdateSideEffect(on: boolean): void;
  /** T41d: 会員の更新への応答の形を替える（`SPA_MEMBER_UPDATE_RESPONSES`。null はふつうの応答）。 */
  setMemberUpdateResponse(response: SpaMemberUpdateResponse | null): void;
  /**
   * T41d: form のない更新の画面が、準備の後に `delayMs`（既定 `SPA_MEMBER_VALUES_DELAY_MS`）だけ遅れて値を入れる（初めは false。次に読み込んだ画面から効く）。
   * T41R-fix: 遅れを引数にした（値を読んだ応答の後は、ページのタイマーだけで遅れる形）。
   */
  setMemberValuesDelayed(on: boolean, delayMs?: number): void;
  /** T41R-fix: ID の絞り込みの読み取り（`GET /rest/v1/members?id=eq.<id>`）の応答を `delayMs` だけ遅らせる（null は遅らせない。初めは null）。 */
  setMemberDetailDelay(delayMs: number | null): void;
  /** T41R-fix: 更新の画面で、名前の欄の入力の事象のたびに、ページが備考（保つ欄）を `SPA_REWRITTEN_NOTE` に書き換える（初めは false。次に読み込んだ画面から効く）。 */
  setMemberKeptRewriteOnInput(on: boolean): void;
  /**
   * T41R-fix-2: 更新の画面で、保存のボタンを押したとき（保存の要求を組み立てる前）に、ページが備考（保つ欄）を `SPA_REWRITTEN_NOTE` に書き換える
   * （押す直前の読み直しの後に値が変わる形。初めは false。次に読み込んだ画面から効く）。
   */
  setMemberKeptRewriteOnPress(on: boolean): void;
  /** T41R2-fix: 更新の画面が、名前と備考はすぐ入れ、保つ欄のメールアドレスだけを `delayMs` 遅れて入れる（null は遅らせない。初めは null）。 */
  setMemberKeptEmailDelay(delayMs: number | null): void;
  /**
   * T41R2-fix: 更新の画面が、値を入れた後に、応答の来ない読み取りの要求（`GET /rest/v1/members?<SPA_HOLD_QUERY_NAME>=1`）を 1 つ開いたままにする
   * （realtime の SPA の形。サーバは閉じるまで応答しない。初めは false）。
   */
  setMemberHoldRequest(on: boolean): void;
  /**
   * T41R3-fix: 更新の画面が、名前と備考はすぐ入れ、メールアドレスにはすぐ仮の値（`SPA_PLACEHOLDER_TEXT`）を入れ、本当の値を `delayMs` 遅れて入れる
   * （null は仮の値を出さない。初めは null）。
   */
  setMemberPlaceholderEmail(delayMs: number | null): void;
  /** T41R3-fix: 会員の値を、画面と API を通さずに直接変える（BeakSight の外で値が変わったレコードの準備）。 */
  setMemberValues(id: number, values: { readonly name?: string; readonly email?: string; readonly note?: string }): void;
  close(): Promise<void>;
}

/** 発行した token の組（ローカル ストレージに保存する形）。 */
interface IssuedTokens {
  readonly access_token: string;
  readonly token_type: 'bearer';
  readonly expires_in: number;
  readonly expires_at: number;
  readonly refresh_token: string;
}

const escapeHtml = (value: string): string => value.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');

/** アプリの HTML（画面の骨組み。中の操作は `/app.js`）。 */
const pageHtml = (title: string, body: string): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><link rel="icon" href="data:,">`
  + `<script src="${SPA_APP_PATHS.script}" defer></script></head><body><main>${body}</main></body></html>`;

const AUTH_PAGE = pageHtml('ログイン', '<h1>ログイン</h1><form id="login-form">'
  + '<label>メールアドレス <input id="email" name="email" type="email" autocomplete="username"></label>'
  + '<label>パスワード <input id="password" name="password" type="password" autocomplete="current-password"></label>'
  + '<button id="login" type="submit">ログイン</button></form><p id="login-error" data-state="hidden" hidden></p><p id="tenant" data-state="none"></p>');

/** T36R-fix: ログインの画面の形ごとの HTML（セレクタは `SPA_LOGIN_FIELDS`）。 */
const LAYOUT_EMAIL = '<label>メールアドレス <input id="email" name="email" type="email" autocomplete="username"></label>';
const LAYOUT_PASSWORD = '<label>パスワード <input id="password" name="password" type="password" autocomplete="current-password"></label>';
const LAYOUT_BUTTON = '<button id="login" type="button">ログイン</button>';
const LAYOUT_TAIL = '<p id="login-error" data-state="hidden" hidden></p><p id="tenant" data-state="none"></p>';
const LOGIN_LAYOUT_BODIES: Readonly<Record<SpaLoginLayout, string>> = Object.freeze({
  formless: `<div id="login-box">${LAYOUT_EMAIL}${LAYOUT_PASSWORD}${LAYOUT_BUTTON}</div>`,
  roleButton: `<div id="login-box">${LAYOUT_EMAIL}${LAYOUT_PASSWORD}<div id="login" role="button" tabindex="0">ログイン</div></div>`,
  partialForm: `<form id="login-form">${LAYOUT_EMAIL}${LAYOUT_PASSWORD}</form>${LAYOUT_BUTTON}`,
  separateForms: `<form id="email-form">${LAYOUT_EMAIL}</form><form id="password-form">${LAYOUT_PASSWORD}</form>`
    + '<form id="button-form"><button id="login" type="submit">ログイン</button></form>',
  linkSubmit: `<div id="login-box">${LAYOUT_EMAIL}${LAYOUT_PASSWORD}<a id="login" href="/auth/go">ログイン</a></div>`,
  linkWrappedSubmit: `<div id="login-box">${LAYOUT_EMAIL}${LAYOUT_PASSWORD}<a href="/auth/go"><span id="login" role="button">ログイン</span></a></div>`,
  duplicateFields: `<div id="login-box">${LAYOUT_EMAIL}${LAYOUT_PASSWORD}${LAYOUT_BUTTON}</div><input id="email" name="email2" type="email">`,
  hiddenPassword: `<div id="login-box">${LAYOUT_EMAIL}<input id="password" name="password" type="password" hidden>${LAYOUT_BUTTON}</div>`,
  readonlyUsername: `<div id="login-box"><input id="email" name="email" type="email" readonly>${LAYOUT_PASSWORD}${LAYOUT_BUTTON}</div>`,
  disabledSubmit: `<div id="login-box">${LAYOUT_EMAIL}${LAYOUT_PASSWORD}<button id="login" type="button" disabled>ログイン</button></div>`,
});
const LOGIN_LAYOUT_PAGES: Readonly<Record<SpaLoginLayout, string>> = Object.freeze(Object.fromEntries(SPA_LOGIN_LAYOUTS.map((layout) => [
  layout, pageHtml('ログイン', `<h1>ログイン</h1>${LOGIN_LAYOUT_BODIES[layout]}${LAYOUT_TAIL}`),
])) as Record<SpaLoginLayout, string>);

const ADMIN_PAGE = pageHtml('管理画面', '<h1>会員</h1><p><a id="new-member" href="/admin/members/new">会員の登録</a> '
  + '<a id="logout" href="/auth/logout">ログアウト</a></p>'
  + '<table id="members" data-state="loading"><thead><tr><th>ID</th><th>名前</th><th>状態</th><th>操作</th></tr></thead><tbody></tbody></table>'
  + '<p id="refresh" data-state="waiting" data-count="0"></p><p id="ws" data-state="none"></p><p id="tenant" data-state="none"></p>');

const memberFormHtml = (title: string, edit: boolean): string => pageHtml(title, `<h1>${escapeHtml(title)}</h1>`
  + '<form id="member-form" data-state="loading">'
  + '<label>名前 <input id="name" name="name"></label>'
  + '<label>メールアドレス <input id="member-email" name="email" type="email"></label>'
  + '<label>備考 <input id="note" name="note"></label>'
  + (edit ? '<label><input id="deleted" name="deleted" type="checkbox"> 論理削除</label>' : '')
  + '<button id="save" type="submit">保存</button>'
  + (edit ? '<button id="remove" type="button">削除</button>' : '')
  + '</form><p id="member" data-state="idle"></p><p><a href="/admin">一覧へ</a></p>');

const MEMBER_NEW_PAGE = memberFormHtml('会員の登録', false);
const MEMBER_EDIT_PAGE = memberFormHtml('会員の更新', true);
/** T37d: 会員の詳細の画面（項目はスクリプトが後から描く）。 */
const MEMBER_DETAIL_PAGE = pageHtml('会員の詳細', `<h1>会員の詳細</h1><dl id="${SPA_MEMBER_DETAIL_ELEMENT}" data-state="loading"></dl>`
  + '<p><a href="/admin">一覧へ</a></p>');

const LOGOUT_PAGE = pageHtml('ログアウト', '<p>ログアウトしています…</p>');
/** DEF-138: クライアントの側でログインの画面へ移る画面（`sessionLossPage: 'client'`。移るのは `/app.js`）。 */
const SESSION_LOSS_PAGE = pageHtml('期限の確かめ', '<h1>期限の確かめ</h1>');

/**
 * T43d: `sharedHeaderLink` の見出しのリンク（ログインの画面と管理画面の両方にある、ログアウトの語を含むリンク。押さない。成功の画面のセレクタの案から
 * 外れることを確かめる）。
 */
// T43R-fix の C-1 (b): 案はログアウトの語を含む属性から作るので、見出しのリンクの id と href もログアウトの語と一般の語だけにした（外すことを確かめるため）。
export const SPA_SHARED_HEADER_LINK = Object.freeze({ id: 'logout-menu', href: '/account/logout' } as const);

/**
 * T43R-fix の C-1: `hostileObservation` の、利用者の名前に見立てた語（ログインの後の画面の要素の id・href と、ローカル ストレージの鍵の名前の間の部分に
 * 入れる。観察の記録・IPC・管理データ・下書きに出ないことを確かめる）。
 */
export const SPA_HOSTILE_OBSERVATION_USER = 'entry-user';
/** T43R2-fix: `hostileObservation` の、利用者の名前（`entryuser`・`alice`）が最初か最後の部分に入る鍵の名前。 */
export const SPA_HOSTILE_OBSERVATION_END_KEYS = Object.freeze([
  'entryuser.session.token',
  'app.session.entryuser',
  'alice@example.com:session:token',
  'alice/auth/token',
] as const);
/** T43R2-fix: 端の部分に入れた利用者の名前（どこにも出ないことを確かめる）。 */
export const SPA_HOSTILE_OBSERVATION_END_USERS = Object.freeze(['entryuser', 'alice'] as const);

/** `hostileObservation` の鍵の名前（間に利用者の名前が入る形と、端に入る形）。 */
export const SPA_HOSTILE_OBSERVATION_KEYS = Object.freeze([
  `LibAuth.clientid0123456789abc.${SPA_HOSTILE_OBSERVATION_USER}.idToken`,
  'LibAuth.clientid0123456789abc.LastAuthUser',
  // T43R2-fix: 利用者の名前が最初か最後の部分に入る形（再レビュー T43R2 の 3 つと `alice/auth/token`）。
  ...SPA_HOSTILE_OBSERVATION_END_KEYS,
] as const);

/** 管理画面に、利用者の名前の入る見出しのリンクと、名前の入る鍵を書く小さなスクリプトを足す（値は仮の値。名前は鍵の名前の間の部分）。 */
const withHostileObservation = (page: string): string => page.split('<body>').join(`<body><header><nav><a id="profile-${SPA_HOSTILE_OBSERVATION_USER}" `
  + `href="/users/${SPA_HOSTILE_OBSERVATION_USER}">${SPA_HOSTILE_OBSERVATION_USER}</a></nav></header>`
  + `<script>localStorage.setItem(${JSON.stringify(SPA_HOSTILE_OBSERVATION_KEYS[0])}, 'hostile-token-value');`
  + `localStorage.setItem(${JSON.stringify(SPA_HOSTILE_OBSERVATION_KEYS[1])}, ${JSON.stringify(SPA_HOSTILE_OBSERVATION_USER)});`
  + SPA_HOSTILE_OBSERVATION_END_KEYS.map((key) => `localStorage.setItem(${JSON.stringify(key)}, 'hostile-token-value');`).join('')
  + `</script><a id="logout-${SPA_HOSTILE_OBSERVATION_END_USERS[0]}" href="/users/${SPA_HOSTILE_OBSERVATION_END_USERS[0]}/logout">logout</a>`);

/**
 * DEF-138: セッションの切れの画面の振る舞い（`sessionLossPage`）。`client` は、画面のスクリプトがローカル ストレージのログインの状態の鍵を消してから
 * ログインの画面へ移る（クライアントの側の移動）。`server` は、サーバがログインの画面へリダイレクトする（302）。どちらも移る先の URL の query に、
 * 目印の値（`sessionLossMarkers()`）を入れる。
 * DF-3（DEF-167）: `client-late` は、画面の読み込み（`load` の事象）の後、`SPA_SESSION_LOSS_LATE_MOVE_MS` 待ってから、ログインの画面へ移る（ログインの状態の
 * 鍵は消さない。非同期で認証を確かめる SPA の形）。`client-late-other` は、同じ時機に、セッションの切れの path に当たらない画面（`SPA_LATE_MOVE_OTHER_PATH`）
 * へ移る（誤って止めないことの対照）。
 */
export const SPA_SESSION_LOSS_PAGES = Object.freeze(['client', 'server', 'client-late', 'client-late-other'] as const);
export type SpaSessionLossPage = (typeof SPA_SESSION_LOSS_PAGES)[number];
/** DEF-138: セッションの切れの画面の path（管理画面の最初のリンク。2 ページ目に読まれる）。 */
export const SPA_SESSION_LOSS_PATH = '/admin/expired';
/**
 * DF-3: `client-late` と `client-late-other` の画面が、読み込み（`load`）の後に移るまで待つ時間（ms）。BeakSight の読み込みは DOMContentLoaded で返るので、
 * 読み込みの直後の判定より後で、落ち着きの待ち（変化のない時間 `PAGE_SETTLING_PACING.stableWindowMs` は 500ms）の間に移る長さ。
 */
export const SPA_SESSION_LOSS_LATE_MOVE_MS = 200;
/** DF-3: `client-late-other` の画面が移る先（管理画面の外。セッションの切れの path `SPA_APP_PATHS.auth` に当たらない）。 */
export const SPA_LATE_MOVE_OTHER_PATH = '/elsewhere/late';
/** DEF-138: ログインの画面へ移るときの query の名前（`ticket` は伏せ字の一覧の名前、`from` は一覧にない名前）。 */
export const SPA_SESSION_LOSS_QUERY_NAMES = Object.freeze({ ticket: 'ticket', from: 'from' } as const);

/** DEF-138: 管理画面の見出しの直後に、セッションの切れの画面へのリンクを入れる（最初のリンクにする）。 */
const withSessionLossLink = (page: string): string => page.split('<h1>会員</h1>').join(
  `<h1>会員</h1><p><a id="expired" href="${SPA_SESSION_LOSS_PATH}">期限の確かめ</a></p>`);

/** T44c: 管理画面の一覧の表を、内側のスクロールの領域に入れる（`innerScrollList`。表の後に背の高い余白）。 */
const withInnerScrollList = (page: string): string => page
  .split('<table id="members"').join(`<div id="${SPA_INNER_SCROLL_CONTAINER.id}" style="height:${String(SPA_INNER_SCROLL_CONTAINER.heightPx)}px;overflow-y:auto">`
    + '<table id="members"')
  .split('</tbody></table>').join(`</tbody></table><div style="height:${String(SPA_INNER_SCROLL_CONTAINER.spacerPx)}px"></div></div>`);

/** 画面の body の先頭に、見出しのリンクを入れる。 */
const withSharedHeaderLink = (page: string): string => page.split('<body>').join(
  `<body><header><a id="${SPA_SHARED_HEADER_LINK.id}" href="${SPA_SHARED_HEADER_LINK.href}">ログアウトできないとき</a></header>`);

/** アプリのスクリプト（`/app.js`。パスごとの画面の操作）。設定は、起動のたびに作る値を JSON で先頭に入れる。 */
const appScriptOf = (config: Readonly<Record<string, unknown>>): string => `'use strict';
const C = ${JSON.stringify(config)};
const byId = (id) => document.getElementById(id);
// 届かなかった要求（ネットワークの誤り。Guard が止めた場合を含む）は、状態 0 の失敗として扱う（画面に誤りを出す）。
const NETWORK_FAILURE = { ok: false, status: 0, json: async () => [] };
const send = (url, init) => fetch(url, init).catch(() => NETWORK_FAILURE);
const setState = (id, value) => { const element = byId(id); if (element !== null) element.dataset.state = value; };
const stored = () => { const text = localStorage.getItem(C.storageKey); return text === null ? null : JSON.parse(text); };
const apiHeaders = (session, extra) => Object.assign({ [C.apiKeyHeader]: C.apiKey, authorization: 'Bearer ' + session.access_token }, extra || {});
const jsonHeaders = (session) => apiHeaders(session, { 'content-type': 'application/json' });
const tokenRequest = (origin, grant, body) => send(origin + C.tokenPath + '?grant_type=' + encodeURIComponent(grant), {
  method: 'POST', headers: { 'content-type': 'application/json', [C.apiKeyHeader]: C.apiKey }, body: JSON.stringify(body),
});
const refresh = async () => {
  const session = stored();
  if (session === null) return false;
  const response = await tokenRequest(C.tokenOrigin, C.grants.refresh, { refresh_token: session.refresh_token });
  if (!response.ok) return false;
  localStorage.setItem(C.storageKey, JSON.stringify(await response.json()));
  return true;
};
const membersUrl = (query) => C.backendOrigin + C.membersPath + (query === undefined ? '' : '?' + query);
const fillMember = (member) => {
  byId('name').value = member.name; byId('member-email').value = member.email; byId('note').value = member.note;
  const deleted = byId('deleted'); if (deleted !== null) deleted.checked = member.deleted;
};
const memberBody = () => {
  const body = { name: byId('name').value, email: byId('member-email').value, note: byId('note').value };
  const deleted = byId('deleted'); if (deleted !== null) body.deleted = deleted.checked;
  return body;
};
// 配信の側の計測の送信（アプリと同じ Origin。結果は見ない）。
const sendRum = () => {
  if (C.rumBeacon) void send(C.appOrigin + C.paths.rum, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'load' }) });
};
// テナントを決める手続きの呼び出し（API の鍵だけ。ログインの後は Bearer も付ける）。結果を \`tenant\` の状態に出す。結果がなくても続けてよいか（真）を返す。
const resolveTenant = async () => {
  if (C.preLoginRpc === null) return true;
  const session = stored();
  const headers = session === null ? { [C.apiKeyHeader]: C.apiKey, 'content-type': 'application/json' } : jsonHeaders(session);
  const response = await send(C.backendOrigin + C.rpcResolveTenantPath, { method: 'POST', headers, body: '{}' });
  setState(C.states.tenant, response.ok ? 'resolved' : 'error');
  return response.ok || C.preLoginRpc === 'optional';
};
// T36b: token の送信の前の、ログインの記録の POST（資格情報を入れる形を選ぶ。結果は見ない）。
const sendSideRequest = async (credentials) => {
  const mode = C.sideRequestBeforeToken;
  const clean = JSON.stringify({ event: 'login' });
  const bodies = {
    clean,
    rawBody: 'note ' + credentials.password,
    jsonBody: JSON.stringify({ password: credentials.password }),
    urlEncodedBody: 'u=' + encodeURIComponent(credentials.email),
    formBody: new URLSearchParams({ u: credentials.email, p: credentials.password }).toString(),
    query: clean,
  };
  const url = C.backendOrigin + C.logLoginPath + (mode === 'query' ? '?u=' + encodeURIComponent(credentials.email) : '');
  await send(url, { method: 'POST', headers: { 'content-type': 'text/plain', [C.apiKeyHeader]: C.apiKey }, body: bodies[mode] });
};
const showLoginError = (reason) => {
  const error = byId('login-error');
  error.textContent = C.loginErrorText; error.hidden = false; error.dataset.state = 'shown'; error.dataset.reason = reason;
};
const pages = {
  auth: async () => {
    sendRum();
    // T36b: 送信を止めない画面（ブラウザがフォームを既定の GET で送る）。
    if (C.nativeFormSubmit) return;
    // 送信の受け手を先に付ける（手続きの呼び出しを待つ間に押されても、フォームをそのまま送らない）。
    const tenantUsable = resolveTenant();
    // T36R-fix: form の要素のない画面の形では、送信の要素を押したときに送る（form の送信の受け手は付けない）。
    const formless = C.loginLayout !== null;
    (formless ? byId('login') : byId('login-form')).addEventListener(formless ? 'click' : 'submit', async (event) => {
      event.preventDefault();
      if (!(await tenantUsable)) { showLoginError('tenant'); return; }
      const body = { email: byId('email').value, password: byId('password').value };
      if (C.sideRequestBeforeToken !== null) await sendSideRequest(body);
      const origin = C.hostile === 'loginToThirdOrigin' ? C.otherOrigin : C.tokenOrigin;
      const grant = C.hostile === 'loginOtherGrant' ? C.grants.other : C.grants.password;
      let response = await tokenRequest(origin, grant, body);
      if (response.ok && C.hostile === 'loginTwice') response = await tokenRequest(origin, grant, body);
      if (!response.ok) {
        showLoginError(response.status === 0 ? 'network' : 'status');
        return;
      }
      localStorage.setItem(C.storageKey, JSON.stringify(await response.json()));
      if (C.postLoginFunction !== null) {
        const synced = await send(C.backendOrigin + C.functionSyncAccessPath, { method: 'POST', headers: jsonHeaders(stored()), body: JSON.stringify({ event: 'login' }) });
        if (!synced.ok && C.postLoginFunction === 'stopOnFailure') { showLoginError('function'); return; }
      }
      if (C.hostile === 'loginExtraPost') {
        await send(C.backendOrigin + C.logLoginPath, { method: 'POST', headers: jsonHeaders(stored()), body: JSON.stringify({ event: 'login' }) });
      }
      if (C.hostile === 'refreshLoop') {
        for (let count = 0; count < C.refreshLoopCount; count += 1) await refresh();
      }
      location.href = C.paths.admin;
    });
  },
  logout: () => { localStorage.removeItem(C.storageKey); location.replace(C.paths.auth); },
  admin: async () => {
    const session = stored();
    if (session === null) { location.replace(C.paths.auth); return; }
    sendRum();
    // T44c: 閉じるときの計測の送信（closingBeacon。結果は見ない）。
    if (C.closingBeacon) {
      addEventListener('pagehide', () => { navigator.sendBeacon(C.appOrigin + C.paths.rum + '?event=' + C.closingBeaconEvent, JSON.stringify({ event: C.closingBeaconEvent })); });
    }
    if (!(await resolveTenant())) { setState(C.states.members, 'error'); return; }
    const response = C.rpcReads
      ? await send(C.backendOrigin + C.rpcListPath, { method: 'POST', headers: jsonHeaders(session), body: '{}' })
      : await send(membersUrl('select=*'), { headers: apiHeaders(session) });
    if (!response.ok) { setState(C.states.members, 'error'); return; }
    const tbody = byId(C.states.members).querySelector('tbody');
    for (const member of await response.json()) {
      const row = document.createElement('tr');
      row.dataset.memberId = String(member.id);
      row.dataset.deleted = String(member.deleted);
      for (const text of [String(member.id), member.name, member.deleted ? '削除済み' : '有効']) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      const link = document.createElement('a'); link.href = C.editPrefix + member.id + '/edit'; link.textContent = '更新';
      const cell = document.createElement('td'); cell.append(link); row.append(cell);
      tbody.append(row);
    }
    // T35c: 最初の会員のメールアドレスで絞り込んだ読み取り（emailFilterRead）と、ログインの状態の鍵を消す（clearSessionAfterList）。
    const [firstMember] = Array.from(tbody.querySelectorAll('tr'));
    if (C.emailFilterRead && firstMember !== undefined) {
      const listed = await (await send(membersUrl('select=*'), { headers: apiHeaders(session) })).json();
      const email = listed.length > 0 ? listed[0].email : '';
      await send(membersUrl('select=id&email=eq.' + encodeURIComponent(email)), { headers: apiHeaders(session) });
    }
    // T37d fix round 1: 一覧の手続きの呼び出しを、もう 1 回出す（結果は見ない）。
    if (C.rpcReads && C.repeatedListRpc) await send(C.backendOrigin + C.rpcListPath, { method: 'POST', headers: jsonHeaders(session), body: '{}' });
    if (C.clearSessionAfterList) localStorage.removeItem(C.storageKey);
    // T44c: 一覧の後のサービスへの読み取り（serviceReadOnList。結果は見ない）。
    if (C.serviceReadOnList) await send(membersUrl(C.serviceReadQuery), { headers: apiHeaders(session) });
    setState(C.states.members, 'loaded');
    if (C.websocket) {
      setState(C.states.websocket, 'connecting');
      const socket = new WebSocket(C.realtimeUrl);
      socket.addEventListener('open', () => setState(C.states.websocket, 'open'));
      socket.addEventListener('error', () => setState(C.states.websocket, 'error'));
    }
    if (C.refreshAfterMs !== null) {
      setTimeout(async () => {
        const ok = await refresh();
        const element = byId(C.states.refresh);
        element.dataset.count = String(Number(element.dataset.count) + 1);
        element.dataset.state = ok ? 'refreshed' : 'error';
      }, C.refreshAfterMs);
    }
  },
  memberNew: () => {
    const session = stored();
    if (session === null) { location.replace(C.paths.auth); return; }
    setState('member-form', 'ready');
    byId('member-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const response = await send(membersUrl(), {
        method: 'POST', headers: apiHeaders(session, { 'content-type': 'application/json', [C.prefer.name]: C.prefer.value }), body: JSON.stringify(memberBody()),
      });
      if (!response.ok) { setState(C.states.member, 'error'); return; }
      const [created] = await response.json();
      byId(C.states.member).dataset.memberId = String(created.id);
      setState(C.states.member, 'created');
      location.href = C.paths.admin;
    });
  },
  memberEdit: async (id) => {
    const session = stored();
    if (session === null) { location.replace(C.paths.auth); return; }
    const response = await send(membersUrl('id=eq.' + id), { headers: apiHeaders(session) });
    const [member] = response.ok ? await response.json() : [];
    if (member === undefined) { setState('member-form', 'error'); return; }
    fillMember(member);
    setState('member-form', 'ready');
    byId('member-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const updated = await send(membersUrl('id=eq.' + id), {
        method: 'PATCH', headers: apiHeaders(session, { 'content-type': 'application/json', [C.prefer.name]: C.prefer.value }), body: JSON.stringify(memberBody()),
      });
      setState(C.states.member, updated.ok ? 'updated' : 'error');
    });
    byId('remove').addEventListener('click', async () => {
      const removed = await send(membersUrl('id=eq.' + id), { method: 'DELETE', headers: apiHeaders(session) });
      if (!removed.ok) { setState(C.states.member, 'error'); return; }
      setState(C.states.member, 'deleted');
      location.href = C.paths.admin;
    });
  },
  // T37d: 会員の詳細（読んだ値を、後から dl の項目として描く）。
  memberDetail: async (id) => {
    const session = stored();
    if (session === null) { location.replace(C.paths.auth); return; }
    const response = await send(membersUrl('id=eq.' + id), { headers: apiHeaders(session) });
    const [member] = response.ok ? await response.json() : [];
    if (member === undefined) { setState(C.detail.element, 'error'); return; }
    const list = byId(C.detail.element);
    for (const [term, value] of [[C.detail.terms.name, member.name], [C.detail.terms.email, member.email], [C.detail.terms.state, member.deleted ? '削除済み' : '有効']]) {
      const dt = document.createElement('dt'); dt.textContent = term;
      const dd = document.createElement('dd'); dd.textContent = value;
      list.append(dt, dd);
    }
    setState(C.detail.element, 'loaded');
  },
};
const path = location.pathname;
const edit = /^\\/admin\\/members\\/([0-9]+)\\/edit$/u.exec(path);
const detail = /^\\/admin\\/members\\/([0-9]+)$/u.exec(path);
const route = () => {
  if (detail !== null) void pages.memberDetail(detail[1]);
  else if (edit !== null) void pages.memberEdit(edit[1]);
  else if (path === C.paths.auth) void pages.auth();
  else if (path === C.paths.logout) pages.logout();
  else if (path === C.paths.admin) void pages.admin();
  else if (path === C.paths.memberNew) pages.memberNew();
  else if (C.sessionLossPath !== null && path === C.sessionLossPath) { localStorage.removeItem(C.storageKey); location.replace(C.sessionLossTarget); }
  else if (C.lateMove !== null && path === C.lateMove.path) {
    // DF-3: 読み込み（load）の後、決めた時間だけ待ってから移る（ログインの状態の鍵は消さない）。
    const move = () => { setTimeout(() => { location.replace(C.lateMove.target); }, C.lateMove.delayMs); };
    if (document.readyState === 'complete') move(); else window.addEventListener('load', move, { once: true });
  }
};
// AS-c: 読み込みのたびに token を更新してから描く（失敗したら、ログインの状態を消してログインの画面へ）。
if (C.refreshOnLoad && (detail !== null || edit !== null || path === C.paths.admin || path === C.paths.memberNew)) {
  void refresh().then((ok) => {
    if (ok) { route(); return; }
    localStorage.removeItem(C.storageKey);
    location.replace(C.paths.auth);
  });
} else {
  route();
}
`;

/**
 * T37b: form のない会員の画面の HTML（`/app.js` は読まず、`SPA_FORMLESS_MEMBER_PATHS.script` だけを読む）。T37c: 更新の画面は、form の画面と同じく
 * 削除のボタン（`SPA_MEMBER_FIELDS.remove`。押すと `DELETE`）を持つ（probe が削除の語のボタンを押さないことを確かめる）。
 */
const formlessMemberPageHtml = (
  title: string,
  edit: boolean,
  extraPressTargets = 0,
  secondSaveButton = false,
  hostileInput: SpaHostileMemberInput | null = null,
  pressPriorityTargets = false,
  externalSchemeButton = false,
  saveInDialog = false,
  publicationStatusField = false,
  crowded = false,
): string =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><link rel="icon" href="data:,">`
  + `<script src="${SPA_FORMLESS_MEMBER_PATHS.script}" defer></script></head><body><main><h1>${escapeHtml(title)}</h1>`
  + `<div id="${SPA_FORMLESS_MEMBER_BOX}" data-state="loading">`
  // DEF-142: 先頭の文字のないボタン（アイコンだけ。押しても何も送らない）。T44c: `crowdedEditScreen` は `SPA_CROWDED_ICON_BUTTON_COUNT` 個。
  + (pressPriorityTargets || crowded
    ? Array.from({ length: crowded ? SPA_CROWDED_ICON_BUTTON_COUNT : SPA_ICON_BUTTON_COUNT }, (_value, index) => `<button type="button" data-icon="${String(index + 1)}">`
      + '<svg width="16" height="16" aria-hidden="true"><rect width="16" height="16"></rect></svg></button>').join('')
    : '')
  // DEF-145: 欄と保存のボタンを閉じたダイアログの中に置き、その後ろに、ダイアログを開くボタン（登録の語）を置く（ダイアログが文書の先にある形。文書の順で
  // 押すと、保存は開く前に見えないまま飛ばされる）。
  + (saveInDialog ? `<dialog id="${SPA_DIALOG_OPEN_BUTTON.dialogId}">` : '')
  + '<label>名前 <input id="name" name="name"></label>'
  + '<label>メールアドレス <input id="member-email" name="email" type="email"></label>'
  // T39d: `hiddenField` は備考の欄を見えなくする。
  + (hostileInput === 'hiddenField' ? '<label style="display:none">備考 <input id="note" name="note"></label>' : '<label>備考 <input id="note" name="note"></label>')
  // T39d: `duplicateName` は名前の欄と同じ name の欄をもう 1 つ持つ。
  + (hostileInput === 'duplicateName' ? '<label>名前（控え） <input id="name-copy" name="name"></label>' : '')
  // DEF-147: 公開の状態の欄（select）。
  + (publicationStatusField
    ? `<label>公開の状態 <select id="${SPA_PUBLICATION_STATUS_FIELD.id}" name="${SPA_PUBLICATION_STATUS_FIELD.id}">`
      + SPA_PUBLICATION_STATUS_FIELD.options.map((value) => `<option value="${value}">${value === '' ? '選んでください' : escapeHtml(value)}</option>`).join('')
      + '</select></label>'
    : '')
  // DEF-142: 保存のボタンの前の、見えないボタン（登録の語）。
  + (pressPriorityTargets
    ? SPA_HIDDEN_PRESS_TARGET_WORDS.map((word, index) =>
      `<button type="button" style="display:none" data-hidden-target="${String(index + 1)}">${escapeHtml(word)}</button>`).join('')
    : '')
  // DEF-144: 保存のボタンの前の、押すとページの JS が外部スキームへ移るボタン（登録の語）。
  + (externalSchemeButton ? `<button id="${SPA_EXTERNAL_SCHEME_BUTTON.id}" type="button">${escapeHtml(SPA_EXTERNAL_SCHEME_BUTTON.word)}</button>` : '')
  // T39d: `linkWrappedSubmit` は保存のボタンを `href` のあるリンクで包む。
  + (hostileInput === 'linkWrappedSubmit'
    ? `<a href="${SPA_APP_PATHS.admin}"><button id="save" type="button">保存</button></a>`
    : '<button id="save" type="button">保存</button>')
  + (saveInDialog
    ? `</dialog><button id="${SPA_DIALOG_OPEN_BUTTON.id}" type="button">${escapeHtml(SPA_DIALOG_OPEN_BUTTON.text)}</button>`
    : '')
  // T39d: `duplicateSubmit` は保存のボタンと同じ形のボタン（同じ識別の候補）をもう 1 つ持つ。
  + (hostileInput === 'duplicateSubmit' ? `<button id="${SPA_DUPLICATE_SAVE_BUTTON_ID}" type="button">保存</button>` : '')
  + (secondSaveButton ? `<button id="${SPA_SECOND_SAVE_BUTTON_ID}" type="button">送信</button>` : '')
  + SPA_EXTRA_PRESS_TARGET_WORDS.slice(0, extraPressTargets)
    .map((word, index) => `<button id="extra-${String(index + 1)}" type="button" data-extra="${String(index + 1)}">${escapeHtml(word)}</button>`)
    .join('')
  // T44c: `crowdedEditScreen` の、保存の後の道具のボタン（登録・更新の語。押しても何も送らない）。
  + (crowded
    ? SPA_TOOLBAR_PRESS_WORDS.map((word, index) => `<button type="button" data-toolbar="${String(index + 1)}">${escapeHtml(word)}</button>`).join('')
    : '')
  + (edit ? '<button id="remove" type="button">削除</button>' : '')
  // T44c: `crowdedEditScreen` の、最後の見えないボタン（登録の語。押せないはず。押されたら別の path へ POST）。
  + (crowded
    ? SPA_HIDDEN_PRESS_TARGET_WORDS.map((word, index) =>
      `<button type="button" style="display:none" data-hidden-target="${String(index + 1)}">${escapeHtml(word)}</button>`).join('')
    : '')
  + '</div><p id="member" data-state="idle"></p><p><a href="/admin">一覧へ</a></p></main></body></html>';

const FORMLESS_MEMBER_NEW_PAGE = formlessMemberPageHtml('会員の登録', false);
const FORMLESS_MEMBER_EDIT_PAGE = formlessMemberPageHtml('会員の更新', true);

/** T37b: form のない会員の画面のスクリプト（押すと `fetch` で送る。敵対的な送り方は `C.hostile`）。設定は、起動のたびに作る値を JSON で先頭に入れる。 */
const formlessMemberScriptOf = (config: Readonly<Record<string, unknown>>): string => `'use strict';
const C = ${JSON.stringify(config)};
const byId = (id) => document.getElementById(id);
const NETWORK_FAILURE = { ok: false, status: 0, json: async () => [] };
const send = (url, init) => fetch(url, init).catch(() => NETWORK_FAILURE);
const setState = (id, value) => { const element = byId(id); if (element !== null) element.dataset.state = value; };
const stored = () => { const text = localStorage.getItem(C.storageKey); return text === null ? null : JSON.parse(text); };
const apiHeaders = (session, extra) => Object.assign({ [C.apiKeyHeader]: C.apiKey, authorization: 'Bearer ' + session.access_token }, extra || {});
const writeHeaders = (session, prefer) => apiHeaders(session, { 'content-type': 'application/json', [C.prefer.name]: prefer || C.prefer.value });
const urlOf = (origin, path, query) => origin + path + (query === undefined ? '' : '?' + query);
// DEF-147: 公開の状態の欄（画面にあるときだけ）も本文に入れる。
const memberBody = () => Object.assign({ name: byId('name').value, email: byId('member-email').value, note: byId('note').value },
  byId(C.publicationStatusFieldId) === null ? {} : { [C.publicationStatusFieldId]: byId(C.publicationStatusFieldId).value });
// T41d: 更新の画面で読んだ値（\`changedOnly\` の、変わった鍵だけを送る形に使う）。
let loadedValues = null;
const changedOnlyBody = (body) => (C.changedOnly && loadedValues !== null
  ? Object.fromEntries(Object.entries(body).filter(([key, value]) => loadedValues[key] !== value))
  : body);
// T40R-fix-A: \`abortSave\` は、ふつうの保存の要求を送った後（\`C.abortSaveAfterMs\`）にページが取り消す（サーバは応答を遅らせるので、応答をページに返せない形）。
const sendSave = (url, init) => {
  if (!C.abortSave) return send(url, init);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), C.abortSaveAfterMs);
  return fetch(url, Object.assign({}, init, { signal: controller.signal })).catch(() => NETWORK_FAILURE);
};
// ふつうの要求（登録は POST、更新は ID の filter の PATCH）。origin と本文を差し替えられる。
const ordinary = (session, id, origin, body) => sendSave(urlOf(origin, C.membersPath, id === null ? undefined : 'id=eq.' + id), {
  method: id === null ? 'POST' : 'PATCH', headers: writeHeaders(session), body: JSON.stringify(id === null ? body : changedOnlyBody(body)),
});
const save = async (session, id) => {
  const filter = id === null ? undefined : 'id=eq.' + id;
  switch (C.hostile) {
    case 'deleteOnSave': return send(urlOf(C.backendOrigin, C.membersPath, filter), { method: 'DELETE', headers: apiHeaders(session) });
    case 'upsert': return send(urlOf(C.backendOrigin, C.membersPath, 'on_conflict=id'), {
      method: 'POST', headers: writeHeaders(session, 'resolution=merge-duplicates,return=representation'), body: JSON.stringify(memberBody()),
    });
    case 'arrayBody': return send(urlOf(C.backendOrigin, C.membersPath), { method: 'POST', headers: writeHeaders(session), body: JSON.stringify([memberBody()]) });
    case 'unfilteredPatch': return send(urlOf(C.backendOrigin, C.membersPath), { method: 'PATCH', headers: writeHeaders(session), body: JSON.stringify(memberBody()) });
    case 'rpcCall': return send(urlOf(C.backendOrigin, C.rpcUpsertMemberPath), { method: 'POST', headers: writeHeaders(session), body: JSON.stringify(memberBody()) });
    case 'doubleSend': await ordinary(session, id, C.backendOrigin, memberBody()); return ordinary(session, id, C.backendOrigin, memberBody());
    case 'softDeleteKey': return ordinary(session, id, C.backendOrigin, Object.assign(memberBody(), { deleted: false }));
    case 'unapprovedOrigin': return ordinary(session, id, C.otherOrigin, memberBody());
    case 'probeAware':
      if (byId('member-email').value.endsWith('.invalid')) {
        return send(urlOf(C.backendOrigin, C.membersShadowPath), { method: 'POST', headers: writeHeaders(session), body: '{}' });
      }
      return ordinary(session, id, C.backendOrigin, memberBody());
    case 'navigateOnSave': location.href = C.adminPath; return NETWORK_FAILURE;
    case 'methodOverrideHeader': return send(urlOf(C.backendOrigin, C.membersPath, filter), {
      method: id === null ? 'POST' : 'PATCH', headers: Object.assign(writeHeaders(session), { [C.methodOverride.name]: C.methodOverride.value }), body: JSON.stringify(memberBody()),
    });
    case 'bodyMethodOverride': return ordinary(session, id, C.backendOrigin, Object.assign(memberBody(), { _method: 'DELETE' }));
    case 'encodedRpcPath': return send(urlOf(C.backendOrigin, C.encodedRpcPath), { method: 'POST', headers: writeHeaders(session), body: JSON.stringify(memberBody()) });
    case 'paramRpcPath': return send(urlOf(C.backendOrigin, C.paramRpcPath), { method: 'POST', headers: writeHeaders(session), body: JSON.stringify(memberBody()) });
    case 'extraPageHeader': return send(urlOf(C.backendOrigin, C.membersPath, filter), {
      method: id === null ? 'POST' : 'PATCH', headers: Object.assign(writeHeaders(session), { [C.extraPageHeader.name]: C.extraPageHeader.value }), body: JSON.stringify(memberBody()),
    });
    // T41d: 保つ欄（備考）の値を書き換えて送る。filter の ID を別の会員（ID + 1）に替えて送る。
    case 'keptValueRewrite': return ordinary(session, id, C.backendOrigin, Object.assign(memberBody(), { note: C.rewrittenNote }));
    case 'filterRewrite': return send(urlOf(C.backendOrigin, C.membersPath, id === null ? undefined : 'id=eq.' + String(Number(id) + 1)), {
      method: id === null ? 'POST' : 'PATCH', headers: writeHeaders(session), body: JSON.stringify(memberBody()),
    });
    default: return ordinary(session, id, C.backendOrigin, memberBody());
  }
};
const run = async () => {
  const session = stored();
  if (session === null) { location.replace(C.authPath); return; }
  const edit = /^\\/admin\\/members\\/([0-9]+)\\/edit$/u.exec(location.pathname);
  const id = edit === null ? null : edit[1];
  if (id !== null) {
    const response = await send(urlOf(C.backendOrigin, C.membersPath, 'id=eq.' + id), { headers: apiHeaders(session) });
    const [member] = response.ok ? await response.json() : [];
    if (member === undefined) { setState(C.box, 'error'); return; }
    const fill = () => {
      byId('name').value = member.name; byId('member-email').value = member.email; byId('note').value = member.note;
      loadedValues = memberBody();
    };
    // T41d: \`delayValues\` は、画面の準備の後に、読んだ値を遅れて入れる（SPA が値を後から入れる形）。
    // T41R2-fix: \`keptEmailDelayMs\` は、名前と備考はすぐ入れ、保つ欄のメールアドレスだけをタイマーで遅れて入れる。\`holdRequest\` は、値を入れた後に、
    // 応答の来ない読み取りの要求を 1 つ開いたままにする（realtime の SPA の形）。
    // T41R3-fix: \`placeholderEmailMs\` は、名前と備考はすぐ入れ、メールアドレスにはすぐ仮の値を入れ、本当の値を遅れて入れる。
    if (C.placeholderEmailMs !== null) {
      byId('name').value = member.name; byId('note').value = member.note; byId('member-email').value = C.placeholderText;
      setTimeout(() => { byId('member-email').value = member.email; loadedValues = memberBody(); }, C.placeholderEmailMs);
    } else if (C.keptEmailDelayMs !== null) {
      byId('name').value = member.name; byId('note').value = member.note;
      setTimeout(() => { byId('member-email').value = member.email; loadedValues = memberBody(); }, C.keptEmailDelayMs);
    } else if (C.delayValues) { setTimeout(fill, C.valuesDelayMs); } else { fill(); }
    if (C.holdRequest) { void fetch(urlOf(C.backendOrigin, C.membersPath, C.holdQuery), { headers: apiHeaders(session) }).catch(() => undefined); }
    // T41R-fix: \`keptRewriteOnInput\` は、名前の欄の入力の事象のたびに、備考（保つ欄）を書き換える（押す直前の読み直しで見つける形）。
    if (C.keptRewriteOnInput) { byId('name').addEventListener('input', () => { byId('note').value = C.rewrittenNote; }); }
  }
  setState(C.box, 'ready');
  byId('save').addEventListener('click', async () => {
    // T41R-fix-2: \`keptRewriteOnPress\` は、押したとき（保存の要求を組み立てる前）に備考（保つ欄）を書き換える。
    if (C.keptRewriteOnPress && id !== null) { byId('note').value = C.rewrittenNote; }
    const response = await save(session, id);
    setState(C.member, response.ok ? 'saved' : 'error');
  });
  // T40R-fix-A: \`saveOnInput\` は、3 つの欄（名前・メールアドレス・備考）がそろった入力の事象で、押されなくても保存の要求を 1 回送る（ページが値を入れる間に
  // 承認どおりの要求を出す形）。
  if (C.saveOnInput) {
    let autoSent = false;
    for (const fieldId of ['name', 'member-email', 'note']) {
      byId(fieldId).addEventListener('input', () => {
        if (!autoSent && byId('name').value !== '' && byId('member-email').value !== '' && byId('note').value !== '') { autoSent = true; void save(session, id); }
      });
    }
  }
  // T39d: 保存と同じ形のもう 1 つのボタン（\`duplicateSubmit\`）も、保存と同じ要求を送る。T38R2-fix: 指定があれば 2 回送る。
  // DEF-145: ダイアログを開くボタン（あるときだけ。押すと開くだけで、何も送らない）。
  const opener = byId(C.dialogOpenButton.id);
  if (opener !== null) {
    opener.addEventListener('click', () => { byId(C.dialogOpenButton.dialogId).showModal(); });
  }
  // DEF-144: 外部スキームへ移るボタン（あるときだけ）。
  const mail = byId(C.externalSchemeButton.id);
  if (mail !== null) {
    mail.addEventListener('click', () => { location.href = C.externalSchemeButton.href; });
  }
  const copy = byId(C.duplicateSaveButtonId);
  if (copy !== null) {
    copy.addEventListener('click', async () => {
      if (C.duplicateSendsTwice) { await save(session, id); }
      const response = await save(session, id);
      setState(C.member, response.ok ? 'saved' : 'error');
    });
  }
  // T39d: \`rewriteOnInput\` は、名前の欄に入れられた値を、ページの JS が入力のたびに書き換える。
  if (C.hostileInput === 'rewriteOnInput') {
    byId('name').addEventListener('input', (event) => { event.target.value = event.target.value + C.rewriteSuffix; });
  }
  // T38a: 保存と同じ要求を送る、もう 1 つのボタン（同じ画面で 2 回押したときの型の digest を確かめる）。
  const again = byId(C.secondSaveButtonId);
  if (again !== null) {
    again.addEventListener('click', async () => {
      const response = await save(session, id);
      setState(C.member, response.ok ? 'saved' : 'error');
    });
  }
  // T37c fix round 1: 押す対象を増やすボタン（それぞれ別の path へ POST。何回押されたかを止めた記録で数えられる）。
  for (const extra of Array.from(document.querySelectorAll('[data-extra]'))) {
    extra.addEventListener('click', () => {
      void send(urlOf(C.backendOrigin, C.extraPathPrefix + extra.dataset.extra), { method: 'POST', headers: writeHeaders(session), body: JSON.stringify(memberBody()) });
    });
  }
  // DEF-142: 文字のないボタン（押しても何も送らない）と、見えないボタン（押せないはず。押されたら別の path へ POST）。
  for (const icon of Array.from(document.querySelectorAll('[data-icon]'))) {
    icon.addEventListener('click', () => { icon.dataset.pressed = 'true'; });
  }
  // T44c: 道具のボタン（登録・更新の語。押しても何も送らない）。
  for (const tool of Array.from(document.querySelectorAll('[data-toolbar]'))) {
    tool.addEventListener('click', () => { tool.dataset.pressed = 'true'; });
  }
  for (const hidden of Array.from(document.querySelectorAll('[data-hidden-target]'))) {
    hidden.addEventListener('click', () => {
      void send(urlOf(C.backendOrigin, C.hiddenPathPrefix + hidden.dataset.hiddenTarget), { method: 'POST', headers: writeHeaders(session), body: JSON.stringify(memberBody()) });
    });
  }
  // T37c: 更新の画面の削除のボタン（ID の filter の DELETE）。
  const remove = byId('remove');
  if (remove !== null) {
    remove.addEventListener('click', async () => {
      const response = await send(urlOf(C.backendOrigin, C.membersPath, 'id=eq.' + id), { method: 'DELETE', headers: apiHeaders(session) });
      setState(C.member, response.ok ? 'deleted' : 'error');
    });
  }
};
void run();
`;

/** 要求の本文を読む（上限まで）。 */
const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolveBody, reject) => {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.byteLength;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  });
  request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
});

/** JSON の object の本文（JSON でない・object でなければ null）。 */
const jsonObjectOf = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** スクリプトで送るログインの SPA の fixture を起動する。 */
export async function startSpaAuthSite(options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> {
  const credentials = { email: `u${randomSecretValue()}@example.invalid`, password: `p${randomSecretValue()}` };
  const apiKey = `k${randomSecretValue()}`;
  // DEF-138: セッションの切れの画面が移る先の query の値の目印。
  const sessionLossTicket = `t${randomSecretValue()}`;
  const sessionLossFrom = `f${randomSecretValue()}`;
  const sessionLossTarget = `${SPA_APP_PATHS.auth}?${SPA_SESSION_LOSS_QUERY_NAMES.ticket}=${sessionLossTicket}`
    + `&${SPA_SESSION_LOSS_QUERY_NAMES.from}=${sessionLossFrom}`;
  const lifetimeMs = options.tokenLifetimeMs ?? SPA_DEFAULT_TOKEN_LIFETIME_MS;
  const requests: SpaAuthSiteRequest[] = [];
  /** 有効な access token と、その期限（ms）。 */
  const accessTokens = new Map<string, number>();
  /** 使える refresh token（使ったら消す）。 */
  const refreshTokens = new Set<string>();
  /** AS-c（`refreshRotation`）: refresh token と組の access token、使い終えた refresh token。 */
  const refreshPairs = new Map<string, string>();
  const usedRefreshTokens = new Set<string>();
  /** 発行したすべての token（目印）。 */
  const issued: string[] = [];
  const members: SpaMember[] = [];
  let nextMemberId = FIRST_MEMBER_ID;
  let successfulLogins = 0;
  let refreshes = 0;
  /** AS-c: 使い終えた refresh token がもう一度使われた回数（`refreshRotation`）。 */
  let reusedRefreshes = 0;
  /** サーバの関数の呼び出し（`postLoginFunction`）と、計測の送信（`rumBeacon`）が届いた回数。 */
  let functionCalls = 0;
  let rumBeacons = 0;
  /** T44c: 閉じるときの計測の送信（`closingBeacon`）が届いた回数。 */
  let closingBeacons = 0;
  const origins: Partial<Record<SpaSiteOrigin, string>> = {};
  const originOf = (origin: SpaSiteOrigin): string => origins[origin] ?? '';
  /** T37b: form のない会員の画面を出すか（敵対的な保存の指定も、この形にする）。 */
  const formlessMemberScreens = options.memberScreenLayout === 'formless' || options.hostileMemberSave !== undefined
    || (options.extraPressTargets ?? 0) > 0 || options.secondSaveButton === true || options.hostileMemberInput !== undefined
    || options.pressPriorityTargets === true || options.externalSchemeButton === true || options.saveInDialog === true
    || options.publicationStatusField === true || options.crowdedEditScreen === true || options.createSaveInDialog === true;
  /** T38c: 今の保存の送り方（起動の指定が初め。`setHostileMemberSave` で替える）。 */
  let hostileMemberSave: SpaHostileMemberSave | null = options.hostileMemberSave ?? null;
  /** T38R2-fix: `duplicateSubmit` のもう 1 つのボタンが保存の要求を 2 回送るか（`setDuplicateSaveSendsTwice` で替える）。 */
  let duplicateSaveSendsTwice = false;
  /** T40b-1: 会員の登録への応答の形（`setMemberSaveResponse` で替える。null はふつうの応答）と、`markedRepresentation` の目印。 */
  let memberSaveResponse: SpaMemberSaveResponse | null = null;
  const memberSaveResponseMarker = `m${randomSecretValue()}`;
  /** T40b-2: 応答の本文の `id` の差し替え（`setMemberSaveRecordId`）と、詳細の画面の読み取りの形（`setMemberDetailResponse`）。 */
  let memberSaveRecordId: string | null = null;
  let memberDetailResponse: SpaMemberDetailResponse | null = null;
  /** T40R-fix-A: 入力の事象で保存の要求を出すか（`setMemberSaveOnInput`）。 */
  let memberSaveOnInput = false;
  /** T40R-fix-A: ふつうの保存の要求をページが送った直後に取り消すか（`setMemberSaveAborted`）。 */
  let memberSaveAborted = false;
  /** T41d: 更新の切り替え（本文を変えた鍵だけにする、サーバの副作用、応答の形、値を遅れて入れる）。 */
  let memberUpdateChangedOnly = false;
  let memberUpdateSideEffect = false;
  /** T41d: サーバの副作用の回数（備考を毎回違う値に変える。前の回の副作用の値が残っていても、変わったと分かるように）。 */
  let memberUpdateSideEffects = 0;
  let memberUpdateResponse: SpaMemberUpdateResponse | null = null;
  let memberValuesDelayed = false;
  /** T41R-fix: 値を遅れて入れるときの遅れ（ms。`setMemberValuesDelayed` の 2 つ目の引数。既定は `SPA_MEMBER_VALUES_DELAY_MS`）。 */
  let memberValuesDelayMs = SPA_MEMBER_VALUES_DELAY_MS;
  /** T41R-fix: ID の絞り込みの読み取りの応答の遅れ（ms。null は遅らせない）。 */
  let memberDetailDelayMs: number | null = null;
  /** T41R-fix: 更新の画面で、名前の欄の入力の事象のたびに、ページが備考（保つ欄）を書き換えるか。 */
  let memberKeptRewriteOnInput = false;
  /** T41R-fix-2: 更新の画面で、押したときにページが備考（保つ欄）を書き換えるか。 */
  let memberKeptRewriteOnPress = false;
  /** T41R2-fix: 保つ欄のメールアドレスだけを遅れて入れる時間（ms。null は遅らせない）。 */
  let memberKeptEmailDelayMs: number | null = null;
  /** T41R3-fix: メールアドレスに仮の値を出してから本当の値を入れるまでの時間（ms。null は仮の値を出さない）。 */
  let memberPlaceholderEmailMs: number | null = null;
  /** T41R2-fix: 更新の画面が、応答の来ない読み取りの要求を開いたままにするか。 */
  let memberHoldRequest = false;
  /** T41R2-fix: 開いたままにしている応答（閉じるときに終える）。 */
  const heldResponses = new Set<ServerResponse>();
  /** T37c fix round 1: 押す対象を増やすボタンの数（`SPA_EXTRA_PRESS_TARGET_WORDS` の数まで）。 */
  const extraPressTargets = Math.min(Math.max(0, options.extraPressTargets ?? 0), SPA_EXTRA_PRESS_TARGET_WORDS.length);

  const issueTokens = (): IssuedTokens => {
    const access = `a${randomSecretValue()}`;
    const refreshToken = `r${randomSecretValue()}`;
    const expiresAt = Date.now() + lifetimeMs;
    accessTokens.set(access, expiresAt);
    refreshTokens.add(refreshToken);
    refreshPairs.set(refreshToken, access);
    issued.push(access, refreshToken);
    return {
      access_token: access, token_type: 'bearer', expires_in: Math.floor(lifetimeMs / SECOND_MS), expires_at: Math.floor(expiresAt / SECOND_MS),
      refresh_token: refreshToken,
    };
  };

  /** `Authorization: Bearer` の token が有効か（ヘッダがなければ null）。 */
  const bearerValidOf = (request: IncomingMessage): boolean | null => {
    const header = request.headers.authorization;
    if (header === undefined) return null;
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const expiresAt = accessTokens.get(token);
    return expiresAt !== undefined && expiresAt > Date.now();
  };

  const corsHeaders = (): Record<string, string> => ({ 'access-control-allow-origin': originOf('app'), vary: 'Origin' });

  const sendJson = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(), ...headers });
    response.end(JSON.stringify(value));
  };
  const sendEmpty = (response: ServerResponse, status: number): void => {
    response.writeHead(status, { 'cache-control': 'no-store', ...corsHeaders() });
    response.end();
  };

  /** `id=eq.<id>` の指定の ID（なければ null）。 */
  const idFilterOf = (url: URL): number | null => {
    const value = url.searchParams.get('id');
    return value !== null && /^eq\.[0-9]+$/u.test(value) ? Number(value.slice('eq.'.length)) : null;
  };

  const memberFrom = (id: number, body: Record<string, unknown>, base: SpaMember | null): SpaMember => ({
    id,
    name: typeof body['name'] === 'string' ? body['name'] : base?.name ?? '',
    email: typeof body['email'] === 'string' ? body['email'] : base?.email ?? '',
    note: typeof body['note'] === 'string' ? body['note'] : base?.note ?? '',
    deleted: typeof body['deleted'] === 'boolean' ? body['deleted'] : base?.deleted ?? false,
  });

  /** token の要求（`grant_type` ごと）。 */
  const handleToken = (response: ServerResponse, url: URL, body: Record<string, unknown> | null): void => {
    const grant = url.searchParams.get('grant_type');
    if (grant === SPA_GRANT_TYPES.password) {
      // T36b: token の送信への応答の振る舞い（429 と `Retry-After`、503、応答なし）。
      if (options.tokenResponse === 'rateLimited') {
        sendJson(response, STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' }, { 'retry-after': SPA_TOKEN_RETRY_AFTER });
        return;
      }
      if (options.tokenResponse === 'serverError') {
        sendJson(response, STATUS_SERVICE_UNAVAILABLE, { error: 'unavailable' });
        return;
      }
      if (options.tokenResponse === 'noResponse') {
        response.socket?.destroy();
        return;
      }
      if (options.tokenResponse === 'locked') {
        sendJson(response, STATUS_LOCKED, { error: 'locked' });
        return;
      }
      if (body?.['email'] === credentials.email && body['password'] === credentials.password) {
        successfulLogins += 1;
        sendJson(response, STATUS_OK, issueTokens());
      } else {
        sendJson(response, STATUS_BAD_REQUEST, { error: 'invalid_grant' });
      }
      return;
    }
    if (grant === SPA_GRANT_TYPES.refresh) {
      const token = body?.['refresh_token'];
      if (typeof token === 'string' && refreshTokens.delete(token)) {
        refreshes += 1;
        // AS-c: 更新の後は、使った refresh token と組の access token を無効にする。
        if (options.refreshRotation === true) {
          accessTokens.delete(refreshPairs.get(token) ?? '');
          usedRefreshTokens.add(token);
        }
        sendJson(response, STATUS_OK, issueTokens());
      } else {
        // AS-c: 使い終えた refresh token がもう一度使われたら、セッションを消す（すべての token を無効にする）。
        if (options.refreshRotation === true && typeof token === 'string' && usedRefreshTokens.has(token)) {
          reusedRefreshes += 1;
          accessTokens.clear();
          refreshTokens.clear();
        }
        sendJson(response, STATUS_BAD_REQUEST, { error: 'invalid_grant' });
      }
      return;
    }
    sendJson(response, STATUS_BAD_REQUEST, { error: 'unsupported_grant_type' });
  };

  /** members の読み書き（Bearer が有効なときだけ。呼ぶ前に確かめる）。 */
  const handleMembers = (request: IncomingMessage, response: ServerResponse, url: URL, body: Record<string, unknown> | null): void => {
    const id = idFilterOf(url);
    const representation = request.headers[SPA_PREFER_HEADER.name] === SPA_PREFER_HEADER.value;
    switch (request.method) {
      case 'GET':
        // T41R2-fix: 開いたままにする読み取りの要求は、閉じるまで応答しない。
        if (url.searchParams.has(SPA_HOLD_QUERY_NAME)) {
          heldResponses.add(response);
          response.on('close', () => heldResponses.delete(response));
          return;
        }
        // T40b-2: 詳細の画面の読み取りの形（ID の絞り込みの読み取りだけ）。
        if (id !== null && memberDetailResponse === 'unauthorizedRead') {
          sendJson(response, STATUS_UNAUTHORIZED, { error: 'invalid_token' });
          return;
        }
        {
          const rows = members.filter((member) => id === null || member.id === id)
            .map((member) => (id !== null && memberDetailResponse === 'mismatch' ? { ...member, email: SPA_MISMATCH_EMAIL } : member));
          // T41R-fix: ID の絞り込みの読み取りの応答を遅らせる（要求の後に遅れて値が入る形）。行は要求を受けた時点の値。
          if (id !== null && memberDetailDelayMs !== null) {
            setTimeout(() => sendJson(response, STATUS_OK, rows), memberDetailDelayMs);
          } else {
            sendJson(response, STATUS_OK, rows);
          }
        }
        return;
      case 'POST': {
        // T40b-1: 応答の形の切り替え（省略はふつうの応答）。
        switch (memberSaveResponse) {
          case 'clientError':
            sendJson(response, STATUS_BAD_REQUEST, { error: 'invalid_member' });
            return;
          case 'rateLimited':
            sendJson(response, STATUS_TOO_MANY_REQUESTS, { error: 'rate_limited' });
            return;
          case 'serverError':
            sendJson(response, STATUS_SERVICE_UNAVAILABLE, { error: 'unavailable' });
            return;
          case 'noResponse':
            response.socket?.destroy();
            return;
          case 'outOfRangeStatus':
            sendJson(response, SPA_OUT_OF_RANGE_STATUS, [{ note: 'out of range' }]);
            return;
          default:
            break;
        }
        const created = memberFrom(nextMemberId, body ?? {}, null);
        if (memberSaveResponse === 'noRecordId') {
          nextMemberId += 1;
          members.push(created);
          sendEmpty(response, STATUS_CREATED);
          return;
        }
        if (memberSaveResponse === 'markedRepresentation') {
          nextMemberId += 1;
          members.push(created);
          const answer = (): void => sendJson(response, STATUS_CREATED, [{
            ...created, ...(memberSaveRecordId === null ? {} : { id: memberSaveRecordId }), [SPA_MEMBER_SAVE_RESPONSE_MARKER_KEY]: memberSaveResponseMarker,
          }]);
          // T40R-fix-A: ページが保存の要求を取り消す形では、応答を取り消しの後まで遅らせる。
          if (memberSaveAborted) {
            setTimeout(answer, SPA_ABORTED_SAVE_RESPONSE_DELAY_MS);
          } else {
            answer();
          }
          return;
        }
        nextMemberId += 1;
        members.push(created);
        if (representation) sendJson(response, STATUS_CREATED, [created]);
        else sendEmpty(response, STATUS_CREATED);
        return;
      }
      case 'PATCH': {
        const index = members.findIndex((member) => member.id === id);
        const current = members[index];
        // T41d: `emptyRows` は、会員を変えずに空の一覧を返す（更新した行がない）。誤りの応答と応答なしも、会員を変えない。
        if (current === undefined || memberUpdateResponse === 'emptyRows') {
          sendJson(response, STATUS_OK, []);
          return;
        }
        if (memberUpdateResponse === 'clientError') {
          sendJson(response, STATUS_BAD_REQUEST, { error: 'invalid_member' });
          return;
        }
        if (memberUpdateResponse === 'serverError') {
          sendJson(response, STATUS_SERVICE_UNAVAILABLE, { error: 'unavailable' });
          return;
        }
        if (memberUpdateResponse === 'noResponse') {
          response.socket?.destroy();
          return;
        }
        const changed = memberFrom(current.id, body ?? {}, current);
        // T41d: サーバの副作用は、更新のたびに備考（保つ欄）を、回ごとに違う値に変える。
        if (memberUpdateSideEffect) {
          memberUpdateSideEffects += 1;
        }
        const updated = memberUpdateSideEffect ? { ...changed, note: `${SPA_SERVER_SIDE_EFFECT_NOTE}-${String(memberUpdateSideEffects)}` } : changed;
        members[index] = updated;
        if (representation && memberUpdateResponse === 'twoRows') {
          sendJson(response, STATUS_OK, [updated, { ...updated, id: updated.id + SPA_OTHER_RECORD_ID_OFFSET }]);
        } else if (representation && memberUpdateResponse === 'largeTwoRows') {
          // T41R2-fix（M-1）: 2 行の一覧に、読む上限を超える長さの項目を足す（行の数を数えられない大きさ）。
          const padding = 'x'.repeat(SPA_LARGE_BODY_PADDING_LENGTH);
          sendJson(response, STATUS_OK, [{ ...updated, padding }, { ...updated, id: updated.id + SPA_OTHER_RECORD_ID_OFFSET, padding }]);
        } else if (representation && memberUpdateResponse === 'notJson') {
          // T41R2-fix（M-1）: 200 と、JSON でない本文。
          response.writeHead(STATUS_OK, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders() });
          response.end('updated');
        } else if (representation && memberUpdateResponse !== 'noContent') {
          sendJson(response, STATUS_OK, [memberUpdateResponse === 'otherRecordId' ? { ...updated, id: updated.id + SPA_OTHER_RECORD_ID_OFFSET } : updated]);
        } else {
          sendEmpty(response, STATUS_NO_CONTENT);
        }
        return;
      }
      case 'DELETE': {
        const index = members.findIndex((member) => member.id === id);
        if (index >= 0) members.splice(index, 1);
        sendEmpty(response, STATUS_NO_CONTENT);
        return;
      }
      default:
        sendEmpty(response, STATUS_NOT_FOUND);
    }
  };

  /** バックエンド（と認証・ほかの Origin）の振る舞い。 */
  const backendListener = (origin: SpaSiteOrigin) => (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', originOf(origin));
    const preflight = request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
    void readBody(request).then((text) => {
      const body = jsonObjectOf(text);
      const bearerValid = bearerValidOf(request);
      requests.push({
        origin, method: request.method ?? '', path: `${url.pathname}${url.search}`, headerNames: Object.keys(request.headers).sort(), preflight,
        bearerValid, bodyKeys: body === null ? [] : Object.keys(body).sort(),
      });
      if (preflight) {
        response.writeHead(STATUS_NO_CONTENT, {
          ...corsHeaders(),
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': [SPA_API_KEY_HEADER, 'authorization', 'content-type', SPA_PREFER_HEADER.name].join(', '),
          'access-control-max-age': '0',
        });
        response.end();
        return;
      }
      if (request.headers[SPA_API_KEY_HEADER] !== apiKey) {
        sendJson(response, STATUS_UNAUTHORIZED, { error: 'invalid_api_key' });
        return;
      }
      if (request.method === 'POST' && url.pathname === SPA_BACKEND_PATHS.token) {
        handleToken(response, url, body);
        return;
      }
      // `preLoginRpc`: テナントを決める手続きの呼び出しは、ログインの前にも答える（API の鍵だけ）。
      if (request.method === 'POST' && url.pathname === SPA_BACKEND_PATHS.rpcResolveTenant) {
        sendJson(response, STATUS_OK, { tenant_id: SPA_TENANT_ID });
        return;
      }
      if (bearerValid !== true) {
        sendJson(response, STATUS_UNAUTHORIZED, { error: 'invalid_token' });
        return;
      }
      if (url.pathname === SPA_BACKEND_PATHS.members) {
        handleMembers(request, response, url, body);
        return;
      }
      if (request.method === 'POST' && url.pathname === SPA_BACKEND_PATHS.rpcListMembers) {
        sendJson(response, STATUS_OK, members);
        return;
      }
      if (request.method === 'POST' && url.pathname === SPA_BACKEND_PATHS.rpcLogLogin) {
        sendEmpty(response, STATUS_NO_CONTENT);
        return;
      }
      if (request.method === 'POST' && url.pathname === SPA_BACKEND_PATHS.functionSyncAccess) {
        functionCalls += 1;
        sendJson(response, STATUS_OK, { synced: true });
        return;
      }
      sendEmpty(response, STATUS_NOT_FOUND);
    }, () => sendEmpty(response, STATUS_BAD_REQUEST));
  };

  /** アプリの Origin の振る舞い（画面の HTML と、設定を入れたスクリプト）。 */
  const appListener = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', originOf('app'));
    const record = (bodyKeys: readonly string[]): void => {
      requests.push({
        origin: 'app', method: request.method ?? '', path: `${url.pathname}${url.search}`, headerNames: Object.keys(request.headers).sort(),
        preflight: false, bearerValid: null, bodyKeys,
      });
    };
    // `rumBeacon`: 計測の送信（POST）。本文の鍵の名前だけを記録して、204 で答える。
    if (request.method === 'POST' && url.pathname === SPA_APP_PATHS.rum) {
      void readBody(request).then((text) => {
        const body = jsonObjectOf(text);
        record(body === null ? [] : Object.keys(body).sort());
        // T44c: 閉じるときの計測の送信（`closingBeacon`）は、別に数える。
        if (url.searchParams.get('event') === SPA_CLOSING_BEACON_EVENT) closingBeacons += 1;
        else rumBeacons += 1;
        response.writeHead(STATUS_NO_CONTENT, { 'cache-control': 'no-store' });
        response.end();
      }, () => {
        record([]);
        response.writeHead(STATUS_BAD_REQUEST);
        response.end();
      });
      return;
    }
    record([]);
    const html = (body: string): void => {
      response.writeHead(STATUS_OK, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
    };
    if (request.method !== 'GET') {
      response.writeHead(STATUS_NOT_FOUND);
      response.end();
      return;
    }
    if (url.pathname === SPA_APP_PATHS.script) {
      response.writeHead(STATUS_OK, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(appScriptOf({
        storageKey: SPA_AUTH_STORAGE_KEY,
        apiKeyHeader: SPA_API_KEY_HEADER,
        apiKey,
        tokenPath: SPA_BACKEND_PATHS.token,
        membersPath: SPA_BACKEND_PATHS.members,
        rpcListPath: SPA_BACKEND_PATHS.rpcListMembers,
        logLoginPath: SPA_BACKEND_PATHS.rpcLogLogin,
        rpcResolveTenantPath: SPA_BACKEND_PATHS.rpcResolveTenant,
        functionSyncAccessPath: SPA_BACKEND_PATHS.functionSyncAccess,
        appOrigin: originOf('app'),
        realtimeUrl: `ws://${new URL(originOf('backend')).host}${SPA_BACKEND_PATHS.realtime}`,
        backendOrigin: originOf('backend'),
        tokenOrigin: tokenOrigin(),
        otherOrigin: originOf('other'),
        grants: SPA_GRANT_TYPES,
        prefer: SPA_PREFER_HEADER,
        paths: SPA_APP_PATHS,
        editPrefix: '/admin/members/',
        states: SPA_STATE_ELEMENTS,
        loginErrorText: SPA_LOGIN_ERROR_TEXT,
        rpcReads: options.rpcReads === true,
        websocket: options.websocket === true,
        refreshAfterMs: options.refreshAfterMs ?? null,
        refreshOnLoad: options.refreshOnLoad === true,
        refreshLoopCount: SPA_REFRESH_LOOP_COUNT,
        hostile: options.hostileLogin ?? null,
        preLoginRpc: options.preLoginRpc ?? null,
        postLoginFunction: options.postLoginFunction ?? null,
        rumBeacon: options.rumBeacon === true,
        emailFilterRead: options.emailFilterRead === true,
        clearSessionAfterList: options.clearSessionAfterList === true,
        repeatedListRpc: options.repeatedListRpc === true,
        sideRequestBeforeToken: options.sideRequestBeforeToken ?? null,
        nativeFormSubmit: options.nativeFormSubmit === true,
        loginLayout: options.loginLayout ?? null,
        detail: { element: SPA_MEMBER_DETAIL_ELEMENT, terms: SPA_MEMBER_DETAIL_TERMS },
        // DEF-138: クライアントの側でログインの画面へ移る画面（`client` のときだけ）。
        sessionLossPath: options.sessionLossPage === 'client' ? SPA_SESSION_LOSS_PATH : null,
        sessionLossTarget,
        // DF-3: 読み込みの後に遅れて移る画面（`client-late` はログインの画面へ、`client-late-other` はセッションの切れの path に当たらない画面へ）。
        lateMove: options.sessionLossPage === 'client-late' || options.sessionLossPage === 'client-late-other'
          ? {
            path: SPA_SESSION_LOSS_PATH,
            target: options.sessionLossPage === 'client-late' ? sessionLossTarget : SPA_LATE_MOVE_OTHER_PATH,
            delayMs: SPA_SESSION_LOSS_LATE_MOVE_MS,
          }
          : null,
        // T44c: 一覧の後のサービスへの読み取りと、閉じるときの計測の送信。
        serviceReadOnList: options.serviceReadOnList === true,
        serviceReadQuery: SPA_SERVICE_READ_QUERY,
        closingBeacon: options.closingBeacon === true,
        closingBeaconEvent: SPA_CLOSING_BEACON_EVENT,
      }));
      return;
    }
    // T37b: form のない会員の画面（指定のあるときだけ。スクリプトと、今の画面と同じ path の HTML）。
    if (formlessMemberScreens && url.pathname === SPA_FORMLESS_MEMBER_PATHS.script) {
      response.writeHead(STATUS_OK, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      response.end(formlessMemberScriptOf({
        storageKey: SPA_AUTH_STORAGE_KEY,
        apiKeyHeader: SPA_API_KEY_HEADER,
        apiKey,
        backendOrigin: originOf('backend'),
        otherOrigin: originOf('other'),
        membersPath: SPA_BACKEND_PATHS.members,
        rpcUpsertMemberPath: SPA_HOSTILE_SAVE_PATHS.rpcUpsertMember,
        // T37R2-fix-A: 手続きの呼び出しを隠した path と、method を上書きするヘッダ。
        encodedRpcPath: SPA_HOSTILE_SAVE_PATHS.encodedRpcUpsertMember,
        paramRpcPath: SPA_HOSTILE_SAVE_PATHS.paramRpcUpsertMember,
        methodOverride: SPA_METHOD_OVERRIDE_HEADER,
        // 型の digest v2: ページが付けるヘッダ（`extraPageHeader`）。
        extraPageHeader: SPA_EXTRA_PAGE_HEADER,
        membersShadowPath: SPA_HOSTILE_SAVE_PATHS.membersShadow,
        extraPathPrefix: SPA_EXTRA_PRESS_PATH_PREFIX,
        hiddenPathPrefix: SPA_HIDDEN_PRESS_PATH_PREFIX,
        secondSaveButtonId: SPA_SECOND_SAVE_BUTTON_ID,
        duplicateSaveButtonId: SPA_DUPLICATE_SAVE_BUTTON_ID,
        duplicateSendsTwice: duplicateSaveSendsTwice,
        saveOnInput: memberSaveOnInput,
        abortSave: memberSaveAborted,
        abortSaveAfterMs: SPA_SAVE_ABORT_AFTER_MS,
        changedOnly: memberUpdateChangedOnly,
        delayValues: memberValuesDelayed,
        valuesDelayMs: memberValuesDelayMs,
        keptRewriteOnInput: memberKeptRewriteOnInput,
        keptRewriteOnPress: memberKeptRewriteOnPress,
        keptEmailDelayMs: memberKeptEmailDelayMs,
        placeholderEmailMs: memberPlaceholderEmailMs,
        placeholderText: SPA_PLACEHOLDER_TEXT,
        holdRequest: memberHoldRequest,
        holdQuery: `select=id&${SPA_HOLD_QUERY_NAME}=1`,
        rewrittenNote: SPA_REWRITTEN_NOTE,
        hostileInput: options.hostileMemberInput ?? null,
        rewriteSuffix: SPA_REWRITE_SUFFIX,
        prefer: SPA_PREFER_HEADER,
        authPath: SPA_APP_PATHS.auth,
        adminPath: SPA_APP_PATHS.admin,
        box: SPA_FORMLESS_MEMBER_BOX,
        member: SPA_STATE_ELEMENTS.member,
        hostile: hostileMemberSave,
        // DEF-144: 外部スキームへ移るボタン（画面にあるときだけ使う）。
        externalSchemeButton: { id: SPA_EXTERNAL_SCHEME_BUTTON.id, href: SPA_EXTERNAL_SCHEME_BUTTON.href },
        // DEF-145: ダイアログを開くボタン（画面にあるときだけ使う）。
        dialogOpenButton: { id: SPA_DIALOG_OPEN_BUTTON.id, dialogId: SPA_DIALOG_OPEN_BUTTON.dialogId },
        // DEF-147: 公開の状態の欄の ID（本文の鍵の名前と同じ。画面にあるときだけ使う）。
        publicationStatusFieldId: SPA_PUBLICATION_STATUS_FIELD.id,
      }));
      return;
    }
    const secondSaveButton = options.secondSaveButton === true;
    const hostileInput = options.hostileMemberInput ?? null;
    const pressPriorityTargets = options.pressPriorityTargets === true;
    const externalSchemeButton = options.externalSchemeButton === true;
    const saveInDialog = options.saveInDialog === true;
    const publicationStatusField = options.publicationStatusField === true;
    // T44c: 押す候補の多い更新の画面と、登録の画面だけのダイアログ。
    const crowdedEditScreen = options.crowdedEditScreen === true;
    const createSaveInDialog = options.createSaveInDialog === true;
    const plainFormless = extraPressTargets === 0 && !secondSaveButton && hostileInput === null && !pressPriorityTargets && !externalSchemeButton
      && !saveInDialog && !publicationStatusField && !crowdedEditScreen && !createSaveInDialog;
    if (formlessMemberScreens && url.pathname === SPA_APP_PATHS.memberNew) {
      return html(plainFormless
        ? FORMLESS_MEMBER_NEW_PAGE
        : formlessMemberPageHtml('会員の登録', false, extraPressTargets, secondSaveButton, hostileInput, pressPriorityTargets, externalSchemeButton,
          saveInDialog || createSaveInDialog, publicationStatusField));
    }
    if (formlessMemberScreens && /^\/admin\/members\/[0-9]+\/edit$/u.test(url.pathname)) {
      return html(plainFormless
        ? FORMLESS_MEMBER_EDIT_PAGE
        : formlessMemberPageHtml('会員の更新', true, extraPressTargets, secondSaveButton, hostileInput, pressPriorityTargets, externalSchemeButton,
          saveInDialog, publicationStatusField, crowdedEditScreen));
    }
    // T43d: `sharedHeaderLink` のときは、ログインの画面と管理画面の両方に、同じ見出しのリンク（`SPA_SHARED_HEADER_LINK`）を出す。
    const shared = (page: string): string => (options.sharedHeaderLink === true ? withSharedHeaderLink(page) : page);
    if (url.pathname === SPA_APP_PATHS.auth) return html(shared(options.loginLayout === undefined ? AUTH_PAGE : LOGIN_LAYOUT_PAGES[options.loginLayout]));
    if (url.pathname === SPA_APP_PATHS.logout) return html(LOGOUT_PAGE);
    // DEF-138: セッションの切れの画面へのリンクを、管理画面の最初のリンクにする（指定のあるときだけ）。
    const lossLinked = (page: string): string => (options.sessionLossPage === undefined ? page : withSessionLossLink(page));
    if (url.pathname === SPA_APP_PATHS.admin) {
      // T44c: `innerScrollList` は、一覧の表を内側のスクロールの領域に入れる。
      const adminPage = options.innerScrollList === true ? withInnerScrollList(ADMIN_PAGE) : ADMIN_PAGE;
      return html(lossLinked(options.hostileObservation === true ? withHostileObservation(shared(adminPage)) : shared(adminPage)));
    }
    // DEF-138: セッションの切れの画面。`server` はログインの画面へリダイレクトし、`client` は画面のスクリプトが移る。DF-3: `client-late` と
    // `client-late-other` も、画面のスクリプトが（読み込みの後に）移る。
    if (options.sessionLossPage !== undefined && url.pathname === SPA_SESSION_LOSS_PATH) {
      if (options.sessionLossPage === 'server') {
        response.writeHead(STATUS_FOUND, { location: sessionLossTarget, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      return html(SESSION_LOSS_PAGE);
    }
    if (url.pathname === SPA_APP_PATHS.memberNew) return html(MEMBER_NEW_PAGE);
    if (/^\/admin\/members\/[0-9]+\/edit$/u.test(url.pathname)) return html(MEMBER_EDIT_PAGE);
    // T37d: 会員の詳細の画面（指定のあるときだけ）。T40b-2: `serverError` は 500。
    if (options.memberDetailPage === true && /^\/admin\/members\/[0-9]+$/u.test(url.pathname)) {
      if (memberDetailResponse === 'serverError') {
        response.writeHead(STATUS_INTERNAL_SERVER_ERROR, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        response.end('');
        return;
      }
      return html(MEMBER_DETAIL_PAGE);
    }
    response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
    response.end('');
  };

  const servers: LoopbackHttpServer[] = [];
  const start = async (origin: SpaSiteOrigin): Promise<LoopbackHttpServer> => {
    const server = await startLoopbackHttpServer(origin === 'app' ? appListener : backendListener(origin));
    origins[origin] = server.origin;
    servers.push(server);
    return server;
  };
  await start('app');
  const backend = await start('backend');
  await start('auth');
  await start('other');
  const tokenOrigin = (): string => originOf(options.separateAuthOrigin === true ? 'auth' : 'backend');

  // WebSocket（バックエンドの `SPA_BACKEND_PATHS.realtime` だけ受け入れる。ほかの path は切る）。
  backend.server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    const url = new URL(request.url ?? '/', originOf('backend'));
    requests.push({
      origin: 'backend', method: 'UPGRADE', path: `${url.pathname}${url.search}`, headerNames: Object.keys(request.headers).sort(), preflight: false,
      bearerValid: null, bodyKeys: [],
    });
    const key = request.headers['sec-websocket-key'];
    if (url.pathname !== SPA_BACKEND_PATHS.realtime || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    socket.on('error', () => undefined);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });

  return {
    appOrigin: originOf('app'),
    backendOrigin: originOf('backend'),
    authOrigin: originOf('auth'),
    otherOrigin: originOf('other'),
    tokenOrigin: tokenOrigin(),
    requests,
    get successfulLogins() {
      return successfulLogins;
    },
    get refreshes() {
      return refreshes;
    },
    get reusedRefreshes() {
      return reusedRefreshes;
    },
    get memberCount() {
      return members.length;
    },
    get functionCalls() {
      return functionCalls;
    },
    get rumBeacons() {
      return rumBeacons;
    },
    get closingBeacons() {
      return closingBeacons;
    },
    fillCredentials: async (fill) => {
      await fill(SPA_LOGIN_FIELDS.email, credentials.email);
      await fill(SPA_LOGIN_FIELDS.password, credentials.password);
    },
    issueStoredSession: () => JSON.stringify(issueTokens()),
    addMember: (name, values) => {
      const member = memberFrom(nextMemberId, { name, email: `m${String(nextMemberId)}@example.invalid`, note: '', ...values, deleted: false }, null);
      nextMemberId += 1;
      members.push(member);
      return member.id;
    },
    memberOf: (id) => members.find((member) => member.id === id),
    secretValues: () => [credentials.email, credentials.password, apiKey, ...issued],
    sessionLossMarkers: () => [sessionLossTicket, sessionLossFrom],
    apiKeyMarker: () => apiKey,
    setHostileMemberSave: (save) => {
      hostileMemberSave = save;
    },
    setDuplicateSaveSendsTwice: (twice) => {
      duplicateSaveSendsTwice = twice;
    },
    setMemberSaveResponse: (mode) => {
      memberSaveResponse = mode;
    },
    memberSaveResponseMarker: () => memberSaveResponseMarker,
    setMemberSaveRecordId: (id) => {
      memberSaveRecordId = id;
    },
    setMemberDetailResponse: (mode) => {
      memberDetailResponse = mode;
    },
    setMemberSaveOnInput: (on) => {
      memberSaveOnInput = on;
    },
    setMemberSaveAborted: (on) => {
      memberSaveAborted = on;
    },
    setMemberUpdateChangedOnly: (on) => {
      memberUpdateChangedOnly = on;
    },
    setMemberUpdateSideEffect: (on) => {
      memberUpdateSideEffect = on;
    },
    setMemberUpdateResponse: (mode) => {
      memberUpdateResponse = mode;
    },
    setMemberValuesDelayed: (on, delayMs = SPA_MEMBER_VALUES_DELAY_MS) => {
      memberValuesDelayed = on;
      memberValuesDelayMs = delayMs;
    },
    setMemberDetailDelay: (delayMs) => {
      memberDetailDelayMs = delayMs;
    },
    setMemberKeptRewriteOnInput: (on) => {
      memberKeptRewriteOnInput = on;
    },
    setMemberKeptRewriteOnPress: (on) => {
      memberKeptRewriteOnPress = on;
    },
    setMemberKeptEmailDelay: (delayMs) => {
      memberKeptEmailDelayMs = delayMs;
    },
    setMemberHoldRequest: (on) => {
      memberHoldRequest = on;
    },
    setMemberPlaceholderEmail: (delayMs) => {
      memberPlaceholderEmailMs = delayMs;
    },
    setMemberValues: (id, values) => {
      const index = members.findIndex((member) => member.id === id);
      const current = members[index];
      if (current === undefined) throw new Error(`no member ${String(id)}`);
      members[index] = memberFrom(id, { ...values }, current);
    },
    close: async () => {
      // T41R2-fix: 開いたままの応答を終えてから閉じる。
      for (const held of heldResponses) {
        held.destroy();
      }
      heldResponses.clear();
      await Promise.all(servers.map((server) => server.close()));
    },
  };
}
