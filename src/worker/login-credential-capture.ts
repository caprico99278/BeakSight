/**
 * 手動のログインの段で、人が入れた ID とパスワードを受け取る部品（OP-1。設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D1・D2。
 * 調べ FV-1 の案 L2）。**「欄の値は読まない」の決まりの、ログインの段だけの名前つきの例外**（`entry-check-page.ts` の決まり、Gate
 * `tests/architecture/worker-login-hooks.test.ts` の (aa)）。手動のログインの段（`authenticated-login.ts`）だけが、呼ぶ側が受け取りを頼んだとき
 * （`LoginStageRequest.captureCredential`）だけ使う。自動ログインの段は使わない。ページを操作しない（押さない・入れない）。読み込みも要求も足さない。
 *
 * 1. 読み方（`startLoginCredentialCapture`）: ログインの画面の page に CDP の session を開き、名前つきの isolated world（`CAPTURE_WORLD_NAME`）にだけ見える
 *    binding（`Runtime.addBinding` の `executionContextName`。ページの JS からは見えない）を足し、その world で読み取りの script（`CAPTURE_SCRIPT`）を
 *    動かす（今の文書には `Page.createIsolatedWorld`、移った先の文書には `Page.addScriptToEvaluateOnNewDocument` の `worldName`）。script は、人が送ろうと
 *    したとき（form の `submit`、押下、Enter）に、見えるパスワードの欄がちょうど 1 つで、その欄と同じ form（form の外なら form の外）に、空でない
 *    ユーザー名の欄（text・email・tel）がちょうど 1 つあるときだけ、2 つの値を binding で Node の側へ送る。ほかの欄の値は読まない。
 * 2. 送り先の記録: 同じ Context の読み取りでない要求の URL・ヘッダ・本文を、このメモリの中だけに、上限（`MAX_CAPTURE_REQUESTS`）まで写す。
 * 3. 確かめ（`settleLoginCredentialCapture`）: ログインに成功したときだけ呼ぶ。最後に送ろうとした値（`MIN_COMPARABLE_CREDENTIAL_LENGTH` から
 *    `MAX_CREDENTIAL_VALUE_LENGTH` までの長さ）が、観察した送り先（Guard が通して記録した読み取りでない要求の行 `passedRequests` の Origin と path）への要求の
 *    1 つの URL・ヘッダ・本文に、パスワードもユーザー名も入っていたとき（資格情報の守りの部品の比べ `carriesLoginCredential`）だけ、受け取った資格情報
 *    （`CapturedLoginCredential`）を返す。そのほかは `null`。
 * 4. 値は `CapturedLoginCredential` の private な項目の中だけに置く（JSON・文字列・console に出ない）。使うのは `withCapturedLoginCredential`（保存の口）だけ。
 *    記録・ログ・IPC・画面に、値も長さも残さない。どの終わり方でも `discard` で、写した要求と値を捨て、session を閉じる。
 * 限界: 値を base64 などで包んで送るサイト、パスワードの欄が 2 つ以上ある画面、iframe の中のログインは、受け取らない（`null`。人の確かめなしの保存はしない）。
 */
import type { BrowserContext, CDPSession, Page, Request } from 'playwright';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import { MAX_CREDENTIAL_VALUE_LENGTH } from '../control/credentials/credential-store.js';
import type { WorkerLoginStageBlockedRequests } from '../control/worker-protocol.js';
import { redactValueLikePathSegments } from '../core/url-path-redaction.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import {
  MIN_COMPARABLE_CREDENTIAL_LENGTH,
  NO_COOKIES,
  carriesLoginCredential,
  createLoginCredentialGuard,
  discardLoginCredentialGuard,
  requestBodyTextOfBuffer,
  type LoginCredentialGuard,
} from '../safety/login-credential-guard.js';
import { isReadMethod } from '../safety/request-policy.js';

/** 読み取りの script を動かす isolated world の名前（ページの JS からは見えない）。 */
export const CAPTURE_WORLD_NAME = 'beaksight-login-capture';
/** isolated world にだけ見える binding の名前。 */
const CAPTURE_BINDING_NAME = 'beaksightLoginCapture';
/** 写す読み取りでない要求の数の上限（超えた要求は写さない）。 */
export const MAX_CAPTURE_REQUESTS = 50;

/** この部品が送る CDP の命令（閉じた一覧）。 */
export const LOGIN_CAPTURE_CDP_COMMANDS = Object.freeze([
  'Runtime.enable',
  'Runtime.addBinding',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Page.addScriptToEvaluateOnNewDocument',
  'Runtime.evaluate',
] as const);

/** 読み取りの script の入力（binding の名前と、ユーザー名の欄の type）。 */
interface CaptureInput {
  readonly binding: string;
  readonly usernameTypes: readonly string[];
}

/** ユーザー名の欄の type（入口の確かめのユーザー名の欄の候補と同じ。text・email・tel）。 */
const USERNAME_INPUT_TYPES: readonly string[] = Object.freeze(['text', 'email', 'tel']);

/**
 * isolated world で動く読み取りの script（ファイルの先頭の 1）。部品 `R` の標準の prototype の getter で読む（isolated world なので、ページの JS は書き換え
 * られない）。外の値を参照しない。送るのは、条件に当たったときの 2 つの値だけ。当たらなければ何も送らない。
 */
function installLoginCaptureReader(R: StandardReaders, input: CaptureInput): boolean {
  const binding = (globalThis as unknown as Record<string, unknown>)[input.binding];
  const send = (payload: { readonly username: string; readonly password: string }): void => {
    try {
      if (typeof binding === 'function') binding(JSON.stringify(payload));
    } catch {
      // 送れなければ受け取らない。
    }
  };
  const lengthOf = R.standardGetter<number>(NodeList.prototype, 'length');
  const inputs = (): HTMLInputElement[] => {
    const list = Document.prototype.querySelectorAll.call(document, 'input');
    const found: HTMLInputElement[] = [];
    for (let index = 0; index < lengthOf(list); index += 1) {
      const node = NodeList.prototype.item.call(list, index);
      if (node instanceof HTMLInputElement) found.push(node);
    }
    return found;
  };
  const typeOf = (element: HTMLInputElement): string => String(R.standardProperty(HTMLInputElement.prototype, 'type', element)).toLowerCase();
  const valueOf = (element: HTMLInputElement): string => String(R.standardProperty(HTMLInputElement.prototype, 'value', element));
  const formOf = (element: HTMLInputElement): unknown => R.standardProperty(HTMLInputElement.prototype, 'form', element);
  const snapshot = (): void => {
    const all = inputs();
    const passwords = all.filter((element) => typeOf(element) === 'password' && R.isVisible(element));
    const [password] = passwords;
    if (passwords.length !== 1 || password === undefined) return;
    const form = formOf(password);
    const users = all.filter((element) => input.usernameTypes.includes(typeOf(element)) && formOf(element) === form && valueOf(element).length > 0);
    const [user] = users;
    if (users.length !== 1 || user === undefined) return;
    send({ username: valueOf(user), password: valueOf(password) });
  };
  document.addEventListener('submit', snapshot, true);
  document.addEventListener('click', snapshot, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') snapshot();
  }, true);
  return true;
}
const installLoginCaptureInPage = composeInPage(installLoginCaptureReader);

/** isolated world で動かす式（組み立てた関数を、入力つきで呼ぶ）。 */
const CAPTURE_SCRIPT = `(${String(installLoginCaptureInPage)})(${JSON.stringify({ binding: CAPTURE_BINDING_NAME, usernameTypes: USERNAME_INPUT_TYPES } satisfies CaptureInput)})`;

/** 受け取った資格情報（値は private な項目の中だけ。JSON・文字列に出ない）。`carriedBy` は値を運んだ観察した送り先（秘密でない）。 */
export class CapturedLoginCredential {
  readonly #username: string;
  readonly #password: string;
  /** 値を運んだ、観察した送り先（Origin と、伏せた区切りの path）。 */
  readonly carriedBy: { readonly origin: string; readonly path: string };

  constructor(username: string, password: string, carriedBy: { readonly origin: string; readonly path: string }) {
    this.#username = username;
    this.#password = password;
    this.carriedBy = Object.freeze({ ...carriedBy });
    Object.freeze(this);
  }

  /** 保存の口だけが使う（`withCapturedLoginCredential`）。 */
  static capturedLoginValuesOf(credential: CapturedLoginCredential): { readonly username: string; readonly password: string } {
    return { username: credential.#username, password: credential.#password };
  }

  toJSON(): { readonly carriedBy: { readonly origin: string; readonly path: string } } {
    return { carriedBy: this.carriedBy };
  }

  toString(): string {
    return 'CapturedLoginCredential';
  }
}

/** 受け取った値を、渡した関数の中だけで使う（保存の口。関数の後は値の参照を持たない）。 */
export async function withCapturedLoginCredential<T>(
  credential: CapturedLoginCredential,
  use: (values: { readonly username: string; readonly password: string }) => Promise<T>,
): Promise<T> {
  let values: { readonly username: string; readonly password: string } | null = CapturedLoginCredential.capturedLoginValuesOf(credential);
  try {
    return await use(values);
  } finally {
    values = null;
  }
}

/** 写した読み取りでない要求（メモリの中だけ）。 */
interface CopiedRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer | null;
}

/**
 * 観察した送り先: ログインの段の Guard が通して記録した読み取りでない要求の行（`passedRequests`）と、認証の設定のフォームの送信先（`loginPostEndpoints`。入口の
 * 確かめか手動のログインの観察が入れたもの。Guard は登録した送信先への POST を「通した要求」の行に入れない）。
 * OP-J（J2）: 認証の設定のスクリプトの送信先（`scriptLoginTarget`。前の手でのログインの観察から登録したもの。Guard は登録した token の送信も「通した要求」の
 * 行に入れない）も、観察した送り先に入れる。受け取る条件（成功、1 つの要求に 2 つの値、送り先が観察したもの）は変えない。
 */
export interface ObservedLoginDestinations {
  readonly passedRequests: WorkerLoginStageBlockedRequests | undefined;
  readonly loginPostEndpoints: readonly { readonly origin: string; readonly path: string }[];
  /** OP-J（J2）: 認証の設定のスクリプトの送信先（スクリプトで送るログインの設定でなければ `null`）。 */
  readonly scriptLoginTarget: { readonly origin: string; readonly path: string } | null;
}

/** 受け取りの途中の状態（`startLoginCredentialCapture` が返す）。 */
export interface LoginCredentialCapture {
  /** 成功の後に、受け取った資格情報を確かめて返す（ファイルの先頭の 3）。当たらなければ `null`。 */
  settle(destinations: ObservedLoginDestinations): CapturedLoginCredential | null;
  /** 写した要求と値を捨て、session を閉じる（例外を投げない）。 */
  discard(): Promise<void>;
}

/** 長さが、比べられて保存できる範囲か。 */
const storableLength = (value: string): boolean => value.length >= MIN_COMPARABLE_CREDENTIAL_LENGTH && value.length <= MAX_CREDENTIAL_VALUE_LENGTH;

/** binding の中身（2 つの文字列）を読む（形が違えば `null`）。 */
const valuesOfPayload = (payload: string): { readonly username: string; readonly password: string } | null => {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === 'object' && parsed !== null) {
      const { username, password } = parsed as Record<string, unknown>;
      if (typeof username === 'string' && typeof password === 'string') {
        return { username, password };
      }
    }
  } catch {
    // 形が違う。
  }
  return null;
};

/** 要求の URL の Origin と、伏せた区切りの path（読めなければ `null`）。 */
const destinationOf = (url: string): { readonly origin: string; readonly path: string } | null => {
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, path: redactValueLikePathSegments(parsed.pathname) };
  } catch {
    return null;
  }
};

/** 1 つの要求の URL・ヘッダ・本文に、部品の値が入っているか（読み取りでない要求として比べる）。 */
const carries = (guard: LoginCredentialGuard, request: CopiedRequest): boolean => carriesLoginCredential(guard, {
  url: request.url,
  readMethod: false,
  body: requestBodyTextOfBuffer(request.body),
  headers: request.headers,
  cookies: NO_COOKIES,
});

/**
 * 受け取りを始める（ファイルの先頭の 1 と 2）。ログインの画面を開いた page と、その Context を渡す。準備に失敗したら（CDP の命令が通らないなど）、受け取らない
 * 状態を返す（`settle` はいつも `null`。ログインの段は今どおり進む）。
 */
export async function startLoginCredentialCapture(page: Page, context: BrowserContext): Promise<LoginCredentialCapture> {
  let latest: { username: string; password: string } | null = null;
  const copied: CopiedRequest[] = [];
  let session: CDPSession | null = null;
  const onRequest = (request: Request): void => {
    if (isReadMethod(request.method()) || copied.length >= MAX_CAPTURE_REQUESTS) {
      return;
    }
    try {
      copied.push({ url: request.url(), headers: { ...request.headers() }, body: request.postDataBuffer() });
    } catch {
      // 写せない要求は比べない（受け取らない側に倒れる）。
    }
  };
  context.on('request', onRequest);
  try {
    session = await context.newCDPSession(page);
    session.on('Runtime.bindingCalled', (event: { readonly name: string; readonly payload: string }) => {
      if (event.name !== CAPTURE_BINDING_NAME) {
        return;
      }
      const values = valuesOfPayload(event.payload);
      latest = values === null ? latest : { ...values };
    });
    await session.send('Runtime.enable');
    await session.send('Runtime.addBinding', { name: CAPTURE_BINDING_NAME, executionContextName: CAPTURE_WORLD_NAME });
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SCRIPT, worldName: CAPTURE_WORLD_NAME });
    const tree = await session.send('Page.getFrameTree');
    const world = await session.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: CAPTURE_WORLD_NAME });
    await session.send('Runtime.evaluate', { expression: CAPTURE_SCRIPT, contextId: world.executionContextId });
  } catch {
    // 準備できなければ受け取らない（値を読まない）。
    latest = null;
    context.off('request', onRequest);
    copied.length = 0;
    const opened = session;
    session = null;
    await opened?.detach().catch(() => undefined);
    return { settle: () => null, discard: async () => undefined };
  }
  let discarded = false;
  return {
    settle({ passedRequests, loginPostEndpoints, scriptLoginTarget }) {
      const values = latest;
      if (discarded || values === null || !storableLength(values.username) || !storableLength(values.password)) {
        return null;
      }
      const observed = [...(passedRequests?.requests ?? []), ...loginPostEndpoints, ...(scriptLoginTarget === null ? [] : [scriptLoginTarget])];
      const isObserved = (destination: { readonly origin: string; readonly path: string }): boolean =>
        observed.some(({ origin, path }) => path === destination.path && isOriginInAllowedOrigins([origin], destination.origin));
      const passwordGuard = createLoginCredentialGuard({ username: '', password: values.password });
      const usernameGuard = createLoginCredentialGuard({ username: values.username, password: '' });
      try {
        for (const request of copied) {
          const destination = destinationOf(request.url);
          if (destination !== null && isObserved(destination)
            && carries(passwordGuard, request) && carries(usernameGuard, request)) {
            return new CapturedLoginCredential(values.username, values.password, destination);
          }
        }
        return null;
      } finally {
        discardLoginCredentialGuard(passwordGuard);
        discardLoginCredentialGuard(usernameGuard);
      }
    },
    async discard() {
      discarded = true;
      latest = null;
      copied.length = 0;
      context.off('request', onRequest);
      const opened = session;
      session = null;
      await opened?.detach().catch(() => undefined);
    },
  };
}
