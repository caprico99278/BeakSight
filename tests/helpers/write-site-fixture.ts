// T30f（Task 30 の設計書 3 章、6 章）: 書き込みのジョブの流れの fixture のサイト（テストの補助）。127.0.0.1 だけで待ち受ける。
// - セッション（Cookie `sid`）がなければ、どの画面もログインの画面へ 303 で移す（セッションの切れ）。テストは `issueSession` で作った値を、認証つきの
//   Run の状態として渡す。
// - 書き込みの画面（`/members/new`）: 登録の form（POST `/members`、urlencoded）。欄は CSRF の hidden（目印）、名前（text）、メール（email）、
//   お知らせ（checkbox。値 `yes`）、readonly の欄（目印）。`setMode` で、送信の前にページの JS が欄を足す・値を変える・form を差し替える・送信の先を
//   新しい窓にする、形を選べる。
// - T30f fix round 1（DEF-098）: 任意の欄のある書き込みの画面（`/members/new-optional`。同じ送信先）。欄は CSRF の hidden、名前（必須）、任意の
//   text（`nickname`）・textarea（`memo`）・checkbox（`agree`）・radio の組（`contact`）、同じ名前の hidden と checkbox の組（`notify`。外した値
//   `0`、チェックの値 `1`）、readonly の欄。`setMode` の `js-optional-text`・`js-optional-check` で、送信の前にページの JS が、選ばなかった text の
//   欄に値を入れる・checkbox をチェックする。
// - 登録の送信先（POST `/members`）: `setMode` の結果で応答する（成功は 303 で `/members/<id>`、入力の誤り、429、500、どの条件にも当たらない画面、
//   2 つの条件に当たる画面、ID の形の外、307、照合の READ で見つからない登録）。T30h-1: `connection-drop` は登録してから応答の前に接続を切り、
//   `hang` は登録してから応答しない（`releaseHeld` か `close` で接続を切る）。どちらも結果が分からない回（登録はある）。T30R2-fix-1（M-b）:
//   `js-navigate-slow` は、登録してから `WRITE_SITE_SLOW_RESPONSE_MS` 遅れて成功の 303 を返し、書き込みの画面のページの JS が、送信の 50ms 後に
//   登録の画面（`/members/<次の ID>`。成功の条件に当たる形）へ GET で移る（ブラウザが POST の要求を取り消す。その画面は POST の応答ではない）。
// - 一覧（`/members`）: 検索の form（GET。`q`）と、登録した会員の表（`q` を含む名前の行）と、書き込みの画面へのリンク（発見のジョブがたどる）。
//   照合の READ の対象。
// - 届いた要求（method、path と query、時刻）と、POST の本文（テストが値を確かめる。CSRF の目印を含みうるので、テストの外に出さない）を記録する。
//   ログインの POST の本文（資格情報を含む）は、POST の本文の記録に入れない（成功したログインの数だけ数える）。
// - T31g-2（Task 31 の設計書 3 章の「更新の前の読み取り」「更新の後の照合」）: 更新の画面（`enableUpdatePages` の後だけ。Task 30 のテストの発見の
//   結果を変えないため）。登録の画面（`/members/<id>`）に更新の画面（`/members/<id>/edit`）へのリンクを、一覧に登録の画面へのリンクを出す。更新の
//   画面は Rails 型の form（POST `/members/<id>`、`_method=PATCH`）で、DOM の順に `_method`、CSRF の hidden（目印）、名前（text。変える欄）、
//   メール（email。保つ欄）、備考（text。保つ欄。T31i: 値は起動のたびに作る目印 `keptMarker`。BeakSight が記録してはならない保つ欄の値）、
//   お知らせ（checkbox。保つ欄）、状態の名前の hidden（`active`）、同じ名前の hidden と checkbox の組（`published`）、楽観的な排他の hidden
//   （`lock_version`。目印）、送信ボタン。更新の POST は、送った値で会員を書き換え、303 で登録の画面へ。`setUpdateMode` で、サーバが保つ欄・
//   状態も変える、ID の違う画面へ移す、更新の後に更新の画面が開けない、前の読み取りの後に更新の画面の値が変わる、送信の前にページの JS が中身を
//   変える（保つ欄・状態の hidden・組の hidden・`_method` を `DELETE`・組の checkbox を外す・`deleted=1` の hidden を足す）、更新してから応答の
//   前に接続を切る、形を選べる。`addMember` は、テストが会員を直接足す（前の値の長さの上限の回など）。T31i: 登録の POST（CREATE）は、送った
//   メールを会員に持つ（送らなければ既定の値）。
// - T31R-fix-1（C-1。DEF-108）: 登録の画面に hidden の `owner_id` と readonly の `member_no`、更新の画面に hidden の `id`・`member[_destroy]` と
//   readonly の `member_no` を足した（秘密に見えない名前の、値を照らす欄）。`setMode` の `js-owner`・`js-member-no`・`js-csrf` と、`setUpdateMode` の
//   `js-id`・`js-destroy`・`js-member-no`・`js-lock`・`js-csrf` で、送信の前にページの JS がその値（と CSRF の hidden）を書き換える（T31R の E6 の形）。
// - T31R2-fix-1（C-1。DEF-108 の残り）: 登録と更新の画面に、見えない checkbox（入れ子の `_destroy`。チェックしていない）、見えない select（登録は
//   `group_id`、更新は `owner_id`。1 つ目を選んだ状態）、disabled の hidden（`parent_id`）を足した。`js-hidden-checkbox`・`js-hidden-select`・
//   `js-enable-disabled` で、送信の前にページの JS が、それぞれをチェックする・選び直す・有効にして値を入れる（T31R2 の E8 の形）。
//   `setSecretHiddenFields(true)` の間は、秘密に見える名前の一覧に当たる一般の名前の hidden（`code`・`key`）も出す。readonly の `code` は、秘密に
//   見える名前なので `serial` に変えた。
// - ログイン（本物のワーカーの手動のログインの段のため。T30f）: GET `/login` はログインの form（欄 `#user`・`#pass`、送るボタン `#go`）。POST `/login`
//   は、fixture が作った仮の資格情報（`fillCredentials` で入れる）に合えば、セッションの Cookie を付けて一覧（`/members`）へ 303。合わなければ
//   ログインの画面へ 303。
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startLoopbackHttpServer } from './loopback-server.js';
import { LOOPBACK_TEST_CERTIFICATE, LOOPBACK_TEST_KEY } from './tls-test-certificate.js';

const RANDOM_VALUE_BYTES = 8;
const STATUS_OK = 200;
const STATUS_SEE_OTHER = 303;
const STATUS_TEMPORARY_REDIRECT = 307;
const STATUS_TOO_MANY_REQUESTS = 429;
const STATUS_INTERNAL_SERVER_ERROR = 500;
const STATUS_NOT_FOUND = 404;
/** 最初の登録の ID。 */
const FIRST_MEMBER_ID = 1001;

/** fixture のパス。 */
export const WRITE_SITE_PATHS = Object.freeze({
  login: '/login',
  form: '/members/new',
  optionalForm: '/members/new-optional',
  create: '/members',
  list: '/members',
  done: '/members/done',
} as const);

/** セッションの Cookie の名前。 */
export const WRITE_SITE_SESSION_COOKIE = 'sid';

/** ログインの form の欄のセレクタ。 */
export const WRITE_SITE_LOGIN_FIELDS = Object.freeze({ user: '#user', pass: '#pass', submit: '#go' } as const);

/** 登録の送信先の応答と、書き込みの画面の形（`setMode`）。 */
export const WRITE_SITE_MODES = Object.freeze([
  'success',
  'input-error',
  'rate-limited',
  'server-error',
  'no-condition',
  'both-conditions',
  'no-record-id',
  'unsafe-record-id',
  'read-mismatch',
  'repost-307',
  'form-changed',
  'js-field',
  'js-value',
  'js-replace',
  'js-popup',
  'js-optional-text',
  'js-optional-check',
  'connection-drop',
  'hang',
  'js-navigate-slow',
  // T31R-fix-1（C-1）: 秘密に見えない hidden・readonly の値と、CSRF の hidden を書き換える形。
  'js-owner',
  'js-member-no',
  'js-csrf',
  // T31R2-fix-1（C-1）: 見えない checkbox・見えない select・disabled の hidden を書き換える形（T31R2 の E8）。
  'js-hidden-checkbox',
  'js-hidden-select',
  'js-enable-disabled',
] as const);

/** T30R2-fix-1（M-b）: `js-navigate-slow` の応答の遅れ（ms。結果を待つ上限より短く、ページの JS の移動より十分長い）。 */
export const WRITE_SITE_SLOW_RESPONSE_MS = 1_500;
/** T30R2-fix-1（M-b）: `js-navigate-slow` で、送信からページの JS が移るまで（ms）。 */
const JS_NAVIGATE_DELAY_MS = 50;
export type WriteSiteMode = (typeof WRITE_SITE_MODES)[number];

/** T31g-2: 更新の送信先の応答と、更新の画面の形（`setUpdateMode`）。 */
export const WRITE_SITE_UPDATE_MODES = Object.freeze([
  'success',
  'server-changes-kept',
  'server-changes-state',
  'id-mismatch',
  'postcheck-missing',
  'drift',
  'js-kept',
  'js-state',
  'js-pair-hidden',
  'js-method',
  // T31i: 削除にあたる作用の形と、応答の前の切断。
  'js-pair-uncheck',
  'js-add-deleted',
  'connection-drop',
  // T31R-fix-1（C-1）: 秘密に見えない hidden・readonly の値と、CSRF の hidden を書き換える形（T31R の E6）。
  'js-id',
  'js-destroy',
  'js-member-no',
  'js-lock',
  'js-csrf',
  // T31R2-fix-1（C-1）: 見えない checkbox・見えない select・disabled の hidden を書き換える形（T31R2 の E8）。
  'js-hidden-checkbox',
  'js-hidden-select',
  'js-enable-disabled',
] as const);
export type WriteSiteUpdateMode = (typeof WRITE_SITE_UPDATE_MODES)[number];

/** T31g-2: 更新の画面の path（`/members/<id>/edit`）と、更新の送信先の path（`/members/<id>`）。 */
export const writeSiteEditPathOf = (id: number | string): string => `${WRITE_SITE_PATHS.create}/${id}/edit`;
export const writeSiteRecordPathOf = (id: number | string): string => `${WRITE_SITE_PATHS.create}/${id}`;

/** T31g-2: 会員の前の値（保つ欄・状態・組の既定）。 */
export const WRITE_SITE_MEMBER_DEFAULTS = Object.freeze({ email: 'kept0001@example.invalid', active: '1' } as const);

/** T31g-2: テストが読む会員の値（更新の後の確かめ）。 */
export interface WriteSiteMember {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly note: string;
  readonly newsletter: boolean;
  readonly active: string;
  readonly published: boolean;
}

/** 届いた要求。 */
export interface WriteSiteRequest {
  readonly method: string;
  readonly path: string;
  readonly at: number;
}

export interface WriteSite {
  readonly origin: string;
  readonly csrfMarker: string;
  readonly readonlyMarker: string;
  readonly requests: readonly WriteSiteRequest[];
  /** 届いた POST の本文（届いた順）。 */
  readonly postBodies: readonly string[];
  /** 登録した会員の数。 */
  readonly members: number;
  /** 成功したログインの数。 */
  readonly successfulLogins: number;
  issueSession(): string;
  /** `hang` で止めている応答の接続を切る（T30h-1）。切った数を返す。 */
  releaseHeld(): number;
  /** 仮の資格情報を、ログインの form の欄のセレクタごとに入れる（手動のログインの代わり）。 */
  fillCredentials(fill: (selector: string, value: string) => Promise<void>): Promise<void>;
  /** 出てはならない秘密の目印（セッションの値、資格情報、CSRF、readonly の値）。 */
  secretValues(): readonly string[];
  setMode(mode: WriteSiteMode): void;
  /** T31g-2: 更新の画面とリンクを出す（既定は出さない）。 */
  enableUpdatePages(): void;
  /** T31g-2: 更新の送信先の応答と、更新の画面の形。 */
  setUpdateMode(mode: WriteSiteUpdateMode): void;
  /** T31g-2: 会員を直接足す（ID を返す）。 */
  addMember(name: string): number;
  /** T31g-2: 会員の今の値（なければ undefined）。 */
  memberOf(id: number): WriteSiteMember | undefined;
  /** T31g-2: 更新の楽観的な排他の hidden の目印（出てはならない値）。 */
  readonly lockMarker: string;
  /** T31i: 保つ欄（備考）の値の目印（BeakSight が記録してはならない値。秘密ではない）。 */
  readonly keptMarker: string;
  /** T31R2-fix-1（C-1）: 秘密に見える名前の一覧に当たる一般の名前の hidden（`code`・`key`）を、登録と更新の画面に出す（`true`）・出さない（`false`）。 */
  setSecretHiddenFields(enabled: boolean): void;
  close(): Promise<void>;
}

const randomValue = (): string => randomBytes(RANDOM_VALUE_BYTES).toString('hex');
const escapeHtml = (value: string): string => value.split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolvePromise(Buffer.concat(chunks).toString('latin1')));
    request.on('error', reject);
  });
}

function sendHtml(response: ServerResponse, body: string, status = STATUS_OK): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>members</title></head><body><main>${body}</main></body></html>`);
}

/** `startWriteSite` の指定（DEF-099 fix: `tls` なら https で待つ。テストだけの自前の証明書）。 */
export interface WriteSiteOptions {
  readonly tls?: boolean | undefined;
}

export async function startWriteSite(options: WriteSiteOptions = {}): Promise<WriteSite> {
  const csrfMarker = `csrf${randomValue()}`;
  const readonlyMarker = `ro${randomValue()}`;
  const sessions = new Set<string>();
  const credentials = { user: `user${randomValue()}`, pass: `pass${randomValue()}` };
  let successfulLogins = 0;
  const requests: WriteSiteRequest[] = [];
  const postBodies: string[] = [];
  const members: {
    id: number; name: string; email: string; note: string; newsletter: boolean; active: string; published: boolean; updates: number; editGets: number;
  }[] = [];
  const lockMarker = `lock${randomValue()}`;
  const keptMarker = `kept${randomValue()}`;
  let updatePages = false;
  let secretHiddenFields = false;
  /** T31R2-fix-1（C-1）: 秘密に見える名前の一覧に当たる一般の名前の hidden（`setSecretHiddenFields`）。 */
  const secretHiddenHtml = (): string => (secretHiddenFields ? '<input type="hidden" name="code" value="c-1"><input type="hidden" name="key" value="k-1">' : '');
  let updateMode: WriteSiteUpdateMode = 'success';
  const memberNamed = (id: string): (typeof members)[number] | undefined => members.find((member) => String(member.id) === id);
  /** `hang` で止めている応答。 */
  const held: ServerResponse[] = [];
  let mode: WriteSiteMode = 'success';
  let nextId = FIRST_MEMBER_ID;
  const p = WRITE_SITE_PATHS;

  const hasSession = (request: IncomingMessage): boolean => {
    const sid = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${WRITE_SITE_SESSION_COOKIE}=`))?.slice(WRITE_SITE_SESSION_COOKIE.length + 1);
    return sid !== undefined && sessions.has(sid);
  };

  const formHtml = (optional: boolean): string => {
    const extra = mode === 'form-changed' ? '<input name="nickname">' : '';
    const script = ({
      'js-field': "document.getElementById('f').addEventListener('submit', () => { const x = document.createElement('input'); x.type = 'hidden';"
        + " x.name = 'extra'; x.value = 'page-added'; document.getElementById('f').append(x); });",
      'js-value': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('name').value += '!'; });",
      'js-replace': "document.getElementById('name').addEventListener('input', () => { const f = document.getElementById('f');"
        + ' f.replaceWith(f.cloneNode(true)); }, { once: true });',
      'js-popup': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('f').target = '_blank'; });",
      'js-optional-text': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('nickname').value = 'page'; });",
      'js-optional-check': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('agree').checked = true; });",
      'js-owner': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('owner_id').value = 'owner-2'; });",
      'js-member-no': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('member_no').value = 'M-OTHER'; });",
      'js-csrf': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('csrf_token').value = 'page-token'; });",
      'js-hidden-checkbox': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('c-destroy').checked = true; });",
      'js-hidden-select': "document.getElementById('f').addEventListener('submit', () => { document.getElementById('c-group').value = 'g-2'; });",
      'js-enable-disabled': "document.getElementById('f').addEventListener('submit', () => { const x = document.getElementById('c-parent'); x.disabled = false; x.value = 'p-9'; });",
      'js-navigate-slow': "document.getElementById('f').addEventListener('submit', () => { setTimeout(() => { "
        + `location.href = '${p.create}/${nextId}'; }, ${JS_NAVIGATE_DELAY_MS}); });`,
    } as Partial<Record<WriteSiteMode, string>>)[mode] ?? '';
    if (optional) {
      return `<h1>会員の登録</h1><form id="f" method="post" action="${p.create}">`
        + `<input type="hidden" name="csrf_token" value="${csrfMarker}">`
        + '<label>名前 <input name="name" id="name" required></label>'
        + '<label>呼び名 <input name="nickname" id="nickname"></label>'
        + '<label>メモ <textarea name="memo" id="memo"></textarea></label>'
        + '<label><input type="checkbox" name="agree" id="agree" value="yes"> 同意</label>'
        + '<label><input type="radio" name="contact" value="phone"> 電話</label><label><input type="radio" name="contact" value="mail"> メール</label>'
        + '<input type="hidden" name="notify" value="0"><label><input type="checkbox" name="notify" id="notify" value="1"> 通知</label>'
        + `<label>番号 <input name="serial" id="serial" readonly value="${readonlyMarker}"></label>`
        + '<button id="register" type="submit">登録</button></form>'
        + (script === '' ? '' : `<script>${script}</script>`);
    }
    return `<h1>会員の登録</h1><form id="f" method="post" action="${p.create}">`
      + `<input type="hidden" name="csrf_token" id="csrf_token" value="${csrfMarker}">`
      + '<input type="hidden" name="owner_id" id="owner_id" value="owner-1">'
      + '<label>名前 <input name="name" id="name" required></label>'
      + '<label>メール <input type="email" name="email" id="email"></label>'
      + '<label><input type="checkbox" name="newsletter" id="newsletter" value="yes"> お知らせ</label>'
      + '<label>会員番号 <input name="member_no" id="member_no" readonly value="M-NEW"></label>'
      + `<label>番号 <input name="serial" id="serial" readonly value="${readonlyMarker}"></label>${extra}`
      + '<input type="checkbox" name="member[_destroy]" id="c-destroy" value="1" style="display:none">'
      + '<select name="group_id" id="c-group" style="display:none"><option value="g-1" selected>一</option><option value="g-2">二</option></select>'
      + '<input type="hidden" name="parent_id" id="c-parent" value="" disabled>'
      + secretHiddenHtml()
      + '<button id="register" type="submit">登録</button></form>'
      + (script === '' ? '' : `<script>${script}</script>`);
  };

  const newMember = (id: number, name: string, email: string | null = null): (typeof members)[number] => ({
    id, name, email: email === null || email.length === 0 ? WRITE_SITE_MEMBER_DEFAULTS.email : email, note: keptMarker, newsletter: true,
    active: WRITE_SITE_MEMBER_DEFAULTS.active, published: true, updates: 0, editGets: 0,
  });

  /** T31g-2: 送信の前にページの JS が中身を変える形の script（更新の画面）。 */
  const updateScripts: Readonly<Partial<Record<WriteSiteUpdateMode, string>>> = {
    'js-kept': "document.getElementById('email').value = 'page@example.invalid';",
    'js-state': "document.getElementById('active').value = '0';",
    'js-pair-hidden': "document.getElementById('published-off').value = '1';",
    'js-method': "document.getElementById('method').value = 'DELETE';",
    'js-pair-uncheck': "document.getElementById('published').checked = false;",
    'js-add-deleted': "const x = document.createElement('input'); x.type = 'hidden'; x.name = 'deleted'; x.value = '1'; document.getElementById('f').append(x);",
    'js-id': "document.getElementById('record-id').value = '999';",
    'js-destroy': "document.getElementById('destroy').value = '1';",
    'js-member-no': "document.getElementById('member_no').value = 'M-OTHER';",
    'js-lock': "document.getElementById('lock_version').value = '0';",
    'js-csrf': "document.getElementById('authenticity_token').value = 'page-token';",
    'js-hidden-checkbox': "document.getElementById('u-addr-destroy').checked = true;",
    'js-hidden-select': "document.getElementById('u-owner').value = 'o-2';",
    'js-enable-disabled': "const x = document.getElementById('u-parent'); x.disabled = false; x.value = 'p-9';",
  };

  /** T31g-2: 更新の画面（ファイルの先頭の説明）。 */
  const updateFormHtml = (member: (typeof members)[number]): string => {
    member.editGets += 1;
    const email = updateMode === 'drift' && member.editGets > 1 ? `drift-${member.email}` : member.email;
    const script = updateScripts[updateMode];
    return `<h1>会員の更新</h1><form id="f" method="post" action="${writeSiteRecordPathOf(member.id)}">`
      + '<input type="hidden" name="_method" id="method" value="PATCH">'
      + `<input type="hidden" name="authenticity_token" id="authenticity_token" value="${csrfMarker}">`
      + `<label>名前 <input name="name" id="name" value="${escapeHtml(member.name)}"></label>`
      + `<label>メール <input type="email" name="email" id="email" value="${escapeHtml(email)}"></label>`
      + `<label>備考 <input name="note" id="note" value="${escapeHtml(member.note)}"></label>`
      + `<label><input type="checkbox" name="newsletter" id="newsletter" value="yes"${member.newsletter ? ' checked' : ''}> お知らせ</label>`
      + `<input type="hidden" name="active" id="active" value="${escapeHtml(member.active)}">`
      + '<input type="hidden" name="published" id="published-off" value="0">'
      + `<label><input type="checkbox" name="published" id="published" value="1"${member.published ? ' checked' : ''}> 公開</label>`
      + `<input type="hidden" name="lock_version" id="lock_version" value="${lockMarker}">`
      + `<input type="hidden" name="id" id="record-id" value="${member.id}">`
      + '<input type="hidden" name="member[_destroy]" id="destroy" value="0">'
      + `<label>会員番号 <input name="member_no" id="member_no" readonly value="M-${member.id}"></label>`
      + '<input type="checkbox" name="member[addresses_attributes][0][_destroy]" id="u-addr-destroy" value="1" style="display:none">'
      + '<select name="owner_id" id="u-owner" style="display:none"><option value="o-1" selected>一</option><option value="o-2">二</option></select>'
      + '<input type="hidden" name="parent_id" id="u-parent" value="" disabled>'
      + secretHiddenHtml()
      + '<button id="update" type="submit">更新</button></form>'
      + (script === undefined ? '' : `<script>document.getElementById('f').addEventListener('submit', () => { ${script} });</script>`);
  };

  /** T31g-2: 更新の送信先の応答（送った値で会員を書き換え、形に応じてサーバが別の欄も変える）。 */
  const update = (response: ServerResponse, member: (typeof members)[number], body: string): void => {
    const fields = new URLSearchParams(body);
    member.name = fields.get('name') ?? member.name;
    member.email = fields.get('email') ?? member.email;
    member.note = fields.get('note') ?? member.note;
    member.newsletter = fields.getAll('newsletter').includes('yes');
    member.active = fields.get('active') ?? member.active;
    member.published = fields.getAll('published').at(-1) === '1';
    member.updates += 1;
    if (updateMode === 'server-changes-kept') {
      member.email = 'server@example.invalid';
    } else if (updateMode === 'server-changes-state') {
      member.active = '0';
    } else if (updateMode === 'connection-drop') {
      // T31i: 更新してから、応答の前に接続を切る（結果が分からない回。BeakSight の送り手は送り直さない）。
      response.socket?.destroy();
      return;
    }
    response.writeHead(STATUS_SEE_OTHER, { location: writeSiteRecordPathOf(updateMode === 'id-mismatch' ? `${member.id}9` : member.id) });
    response.end();
  };

  const listHtml = (url: URL): string => {
    const q = url.searchParams.get('q') ?? '';
    const rows = members.filter((member) => q.length > 0 && member.name.includes(q));
    return `<h1>会員</h1><form id="search" method="get" action="${p.list}"><input type="search" name="q"><button type="submit">検索</button></form>`
      + '<table><thead><tr><th>番号</th><th>名前</th></tr></thead><tbody>'
      + rows.map((member) => `<tr><td>${member.id}</td><td>${escapeHtml(member.name)}</td></tr>`).join('')
      + `</tbody></table><p>該当 ${rows.length} 件</p><p><a href="${p.form}">会員の登録へ</a></p>`
      + (updatePages ? `<p>${members.map((member) => `<a href="${writeSiteRecordPathOf(member.id)}">会員 ${member.id}</a>`).join(' ')}</p>` : '');
  };

  /** 登録の送信先の応答（ファイルの先頭の説明）。 */
  const create = (response: ServerResponse, body: string): void => {
    const name = new URLSearchParams(body).get('name') ?? '';
    const register = (): number => {
      const id = nextId;
      nextId += 1;
      if (mode !== 'read-mismatch') {
        members.push(newMember(id, name, new URLSearchParams(body).get('email')));
      }
      return id;
    };
    switch (mode) {
      case 'input-error':
        sendHtml(response, '<h1>会員の登録</h1><p class="error">入力に誤りがあります</p>');
        return;
      case 'rate-limited':
        sendHtml(response, '<p>too many requests</p>', STATUS_TOO_MANY_REQUESTS);
        return;
      case 'server-error':
        sendHtml(response, '<p>server error</p>', STATUS_INTERNAL_SERVER_ERROR);
        return;
      case 'no-condition':
        register();
        response.writeHead(STATUS_SEE_OTHER, { location: p.done });
        response.end();
        return;
      case 'both-conditions': {
        const id = register();
        response.writeHead(STATUS_SEE_OTHER, { location: `${p.create}/${id}?both=1` });
        response.end();
        return;
      }
      case 'no-record-id':
        register();
        response.writeHead(STATUS_SEE_OTHER, { location: `${p.create}/x/registered` });
        response.end();
        return;
      case 'unsafe-record-id':
        register();
        response.writeHead(STATUS_SEE_OTHER, { location: `${p.create}/a.b` });
        response.end();
        return;
      case 'connection-drop':
        register();
        response.socket?.destroy();
        return;
      case 'hang':
        register();
        held.push(response);
        return;
      case 'js-navigate-slow': {
        const id = register();
        setTimeout(() => {
          response.writeHead(STATUS_SEE_OTHER, { location: `${p.create}/${id}` });
          response.end();
        }, WRITE_SITE_SLOW_RESPONSE_MS);
        return;
      }
      case 'repost-307':
        response.writeHead(STATUS_TEMPORARY_REDIRECT, { location: `${p.create}?again=1` });
        response.end();
        return;
      default: {
        const id = register();
        response.writeHead(STATUS_SEE_OTHER, { location: `${p.create}/${id}` });
        response.end();
      }
    }
  };

  const issueSession = (): string => {
    const sid = randomValue();
    sessions.add(sid);
    return sid;
  };

  const login = (response: ServerResponse, body: string): void => {
    const fields = new URLSearchParams(body);
    if (fields.get('user') !== credentials.user || fields.get('pass') !== credentials.pass) {
      response.writeHead(STATUS_SEE_OTHER, { location: p.login });
      response.end();
      return;
    }
    successfulLogins += 1;
    response.writeHead(STATUS_SEE_OTHER, {
      location: p.list,
      'set-cookie': `${WRITE_SITE_SESSION_COOKIE}=${issueSession()}; HttpOnly; SameSite=Lax; Path=/`,
    });
    response.end();
  };

  const handle = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const body = await readBody(request);
    if (url.pathname === p.login) {
      if (request.method === 'POST') {
        login(response, body);
        return;
      }
      sendHtml(response, `<h1 id="login">LOGIN</h1><form id="login-form" method="post" action="${p.login}">`
        + '<input name="user" id="user"><input name="pass" id="pass" type="password"><button id="go" type="submit">ログイン</button></form>');
      return;
    }
    if (request.method === 'POST') {
      postBodies.push(body);
    }
    if (!hasSession(request)) {
      response.writeHead(STATUS_SEE_OTHER, { location: p.login });
      response.end();
      return;
    }
    if (request.method === 'GET' && (url.pathname === p.form || url.pathname === p.optionalForm)) {
      sendHtml(response, formHtml(url.pathname === p.optionalForm));
      return;
    }
    if (request.method === 'POST' && url.pathname === p.create) {
      create(response, body);
      return;
    }
    // T31g-2: 更新の画面と更新の送信先（`enableUpdatePages` の後だけ）。
    const editMatch = /^\/members\/([A-Za-z0-9_-]+)\/edit$/u.exec(url.pathname);
    const recordMatch = /^\/members\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
    if (updatePages && request.method === 'GET' && editMatch !== null) {
      const member = memberNamed(editMatch[1] ?? '');
      if (member === undefined || (updateMode === 'postcheck-missing' && member.updates > 0)) {
        response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
        response.end('');
        return;
      }
      sendHtml(response, updateFormHtml(member));
      return;
    }
    if (updatePages && request.method === 'POST' && recordMatch !== null) {
      const member = memberNamed(recordMatch[1] ?? '');
      if (member !== undefined) {
        update(response, member, body);
        return;
      }
    }
    if (request.method === 'GET' && url.pathname === p.list) {
      sendHtml(response, listHtml(url));
      return;
    }
    if (request.method === 'GET' && url.pathname === p.done) {
      sendHtml(response, '<h1>受け付けました</h1>');
      return;
    }
    if (request.method === 'GET' && url.pathname.startsWith(`${p.create}/`)) {
      const id = url.pathname.slice(p.create.length + 1);
      const both = url.searchParams.has('both') ? '<p class="error">確認してください</p>' : '';
      const edit = updatePages ? `<p><a href="${writeSiteEditPathOf(id)}">編集</a></p>` : '';
      sendHtml(response, `<h1 class="registered">登録しました</h1><p>番号 <span id="record-id">${escapeHtml(id)}</span></p>${both}${edit}`);
      return;
    }
    response.writeHead(STATUS_NOT_FOUND, { 'content-type': 'text/plain' });
    response.end('');
  };

  let origin = '';
  const loopback = await startLoopbackHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    requests.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, at: Date.now() });
    handle(request, response, url).catch(() => {
      if (!response.headersSent) response.writeHead(STATUS_NOT_FOUND);
      response.end();
    });
  }, options.tls === true ? { tls: { cert: LOOPBACK_TEST_CERTIFICATE, key: LOOPBACK_TEST_KEY } } : {});
  origin = loopback.origin;

  return {
    origin,
    csrfMarker,
    readonlyMarker,
    requests,
    postBodies,
    get members() {
      return members.length;
    },
    get successfulLogins() {
      return successfulLogins;
    },
    issueSession,
    releaseHeld: () => {
      const responses = held.splice(0);
      responses.forEach((response) => response.socket?.destroy());
      return responses.length;
    },
    async fillCredentials(fill) {
      await fill(WRITE_SITE_LOGIN_FIELDS.user, credentials.user);
      await fill(WRITE_SITE_LOGIN_FIELDS.pass, credentials.pass);
    },
    // T31i: 保つ欄の人の値の目印も、出てはならない値として数える（秘密ではないが、BeakSight は記録しない）。
    secretValues: () => [...sessions, credentials.user, credentials.pass, csrfMarker, readonlyMarker, lockMarker, keptMarker],
    setMode: (next) => {
      mode = next;
    },
    lockMarker,
    keptMarker,
    setSecretHiddenFields: (enabled) => {
      secretHiddenFields = enabled;
    },
    enableUpdatePages: () => {
      updatePages = true;
    },
    setUpdateMode: (next) => {
      updateMode = next;
      members.forEach((member) => {
        member.editGets = 0;
      });
    },
    addMember: (name) => {
      const id = nextId;
      nextId += 1;
      members.push(newMember(id, name));
      return id;
    },
    memberOf: (id) => {
      const member = members.find((candidate) => candidate.id === id);
      return member === undefined ? undefined : {
        id: member.id, name: member.name, email: member.email, note: member.note, newsletter: member.newsletter, active: member.active,
        published: member.published,
      };
    },
    close: () => loopback.close(),
  };
}
