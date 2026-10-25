/**
 * ログインの段の共通の部品（Task 25 の設計書 4.4、Task 26 の設計書 4.4 の「判定の部品の共通化」。T26d-1 で `authenticated-login.ts` から移した）。
 * 手動のログインの段（`authenticated-login.ts`）と自動ログインの段（`automated-login.ts`）の両方が使う（書き写さない）。
 * - ログインの段の Browser・factory・Context の開き方と閉じ方（`openLoginStagePage`、`closeLoginStage`）。Context は、Context の作り方の owner
 *   （`BrowserContextFactory.createLoginStageContext`）が、ログインの段の Guard を付けて作る。
 * - 回数の上限で止められたか（`loginAttemptsExceeded`）。送信先への POST かの判定（`isLoginEndpointPost`）と、その method
 *   （`LOGIN_POST_METHOD`）は、要求の判定の owner（`src/safety/request-policy.ts`）に置く（CCX-15。共通化の台帳の CC-064）。
 * - ログインの結果の条件（成功の条件と、自動ログインの失敗の条件。`{ pathPrefix, selector }`）に page が当たるか（`isLoginResultConditionPage`）。
 * - 状態の取り出しと絞り込み（`readAuthenticatedState`。空なら `null` で、呼ぶ側が `UNSUPPORTED_AUTH_STATE` にする）。DEF-139: IndexedDB を含めて読み、
 *   状態の名前の記録も返す。
 * 秘密（Cookie と localStorage の値、資格情報）を、ログ・誤りの文・ファイルに出さない。ログインの段の Safety Ledger を、外に渡さない（ページの JS が
 * 送ろうとした要求の URL に、ユーザー名が入りうる。Task 26 の調査 E2）。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { isChromiumLaunchRefused, type ChromiumLaunchRefusalReason } from '../browser/chromium-launch.js';
import { BrowserContextFactory, readContextStorageState } from '../browser/context-factory.js';
import type { AuditConfig } from '../config/types.js';
import {
  SCRIPT_REQUEST_TRANSPORT,
  loginTransportOf,
  type AuthSetup,
  type LoginPostEndpoint,
  type LoginResultCondition,
  type SuccessStorageKey,
} from '../control/auth/auth-setup-contracts.js';
import {
  authenticatedStateNameRecordOf,
  filterAuthenticatedState,
  type AuthenticatedState,
  type LoginStateNameRecord,
} from '../control/auth/authenticated-state.js';
import type { WorkerLoginStageBlockedRequests, WorkerScriptLoginCounts } from '../control/worker-protocol.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { LoginStageMonitor, type GuardLoginStage } from '../safety/passive-request-guard.js';
import { isLoginEndpointPost, LOGIN_POST_METHOD } from '../safety/request-policy.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';

/** CSS のセレクタとして引く印（Playwright の独自のセレクタとして解釈させない）。 */
const CSS_SELECTOR_ENGINE = 'css=';

/** ログインの段の Browser・factory・Context（開いた順に入れる。途中で失敗しても、入れたものを `closeLoginStage` が閉じる）。 */
export interface LoginStageResources {
  browser: Browser | null;
  factory: BrowserContextFactory | null;
  context: BrowserContext | null;
}

/**
 * EL-3（設計書 `2026-10-24-beaksight-external-launch-block-design.md` 3.2。設計者の判断 2026-10-24）: ログインの段（手動と自動）のログイン用の Browser を、起動の部品が
 * 閉じた理由（`CHROMIUM_LAUNCH_REFUSAL_REASONS`。外部のアプリを開かせない設定が効かない）で断ったときの、ワーカーの中だけの終わり方。IPC と管理データの
 * 閉じた一覧には足さない（ワーカーは `FAILED` の今の理由 `UNEXPECTED_FAILURE` で終え、詳細の文に理由を書く）。ログインの画面は開いていない（送信もしない）。
 */
export const LOGIN_BROWSER_LAUNCH_REFUSED = 'LOGIN_BROWSER_LAUNCH_REFUSED';
/** 断った閉じた理由（自動ログインの段は起動の部品を参照しないので、ここの名前で読む。Gate `worker-login-hooks` の (y)）。 */
export type LoginBrowserLaunchRefusal = ChromiumLaunchRefusalReason;

/** ログインの段の起動の失敗（`error`）が、起動の部品の閉じた理由の誤りなら、その理由。ほかの失敗は `null`（今の終わり方のまま）。 */
export const loginBrowserLaunchRefusalOf = (error: unknown): ChromiumLaunchRefusalReason | null =>
  (isChromiumLaunchRefused(error) ? error.reason : null);

/** まだ何も開いていないログインの段。 */
export const createLoginStageResources = (): LoginStageResources => ({ browser: null, factory: null, context: null });

/** ログインの段を開く指定。 */
export interface LoginStageOpening {
  /** ログイン用の Browser を起動する（呼ぶ側が渡す）。 */
  readonly launchBrowser: () => Promise<Browser>;
  readonly config: AuditConfig;
  readonly ledger: SafetyLedger;
  readonly loginPostEndpoints: readonly LoginPostEndpoint[];
  /** この Context で許す送信先への POST の回数の上限（スクリプトで送るログインでは、token の送信の回数の上限）。 */
  readonly maxLoginPosts: number;
  /**
   * T34c: スクリプトで送るログインの Guard の口（`loginStageGuardOf` の `scriptRequest`。フォームの送信のログインでは省略）。ある場合は、ログインの段の
   * Guard が、登録した token の送信とログインに伴う送信と、承認したサービスの Origin への読み取りを通す（T34b）。
   */
  readonly scriptRequest?: GuardLoginStage['scriptRequest'];
  /**
   * T36c（Task 36 の設計書 3.3）: 自動ログインのスクリプトで送るログインの、資格情報の守りの部品（`scriptRequest` と一緒のときだけ。手動のログインと
   * フォームの送信の自動ログインでは省略）。値は、自動ログインの段が入れる直前に入れる（`armLoginCredentialGuard`）。
   */
  readonly credentialGuard?: GuardLoginStage['credentialGuard'];
  /** Context を作った直後、page を作る前に呼ぶ（要求の観察を付ける）。 */
  readonly onContextCreated?: (context: BrowserContext) => void;
  /**
   * 読み込みの間隔を守る部品（DEF-102 fix。自動ログインの段だけが渡す。ワーカーの流れで、ログインの後のジョブと同じもの）。渡すと、factory の
   * `navigationPacer` に渡し、ログインの段の Guard が、main frame の文書の要求を送った時刻と応答を受けた時刻を記録する。手動のログインの段は
   * 渡さない（人が操作する画面は対象の外）。
   */
  readonly navigationPacer?: NavigationPacer | undefined;
  /**
   * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1）: 手動のログインの段の印（手動のログインの段だけが `true` を渡す）。
   * ログインの段の Guard が、ページの送信を止めずに通し、形だけを記録する。自動ログインの段は渡さない（今の厳しさのまま）。
   */
  readonly manualPassThrough?: true | undefined;
  /**
   * T44R（Task 44 のレビューの M-1）: 手動のログインの段の、token の送信先がまだない設定の承認したサービスの Origin（`loginStageGuardOf` の
   * `manualServiceReadOrigins`）。手動のログインの段（`manualPassThrough`）のときだけ Guard に渡す。
   */
  readonly manualServiceReadOrigins?: GuardLoginStage['manualServiceReadOrigins'];
}

/** 開いたログインの段（`resources` と同じものを、null でない形で返す）。 */
export interface OpenedLoginStage {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  /**
   * T26g-1: ログインの段の記録（許可 Origin の外や送信の窓の中で止めた要求の、種類ごとの数）と、自動ログインの送信の窓の口。手動の段は
   * 窓を開かない。
   */
  readonly monitor: LoginStageMonitor;
}

/**
 * ログイン用の Browser を起動し、ログインの段の Guard を付けた Context と、Guard の準備を待った page を作る（`resources` に入れていく）。
 * Guard は、ログインの段では許可 Origin の外への要求をすべて止める（T26g-1。判定は要求の判定の owner のログインの段の口）。
 * 失敗は投げる（呼ぶ側が、終わり方を決めてから `closeLoginStage` で閉じる）。
 */
export async function openLoginStagePage(resources: LoginStageResources, opening: LoginStageOpening): Promise<OpenedLoginStage> {
  const browser = await opening.launchBrowser();
  resources.browser = browser;
  const { ledger } = opening;
  const factory = new BrowserContextFactory(
    browser,
    opening.config,
    () => ledger,
    opening.navigationPacer === undefined ? {} : { navigationPacer: opening.navigationPacer },
  );
  resources.factory = factory;
  const monitor = new LoginStageMonitor();
  const context = await factory.createLoginStageContext(opening.config.viewports.primaryDesktop, {
    loginPostEndpoints: opening.loginPostEndpoints,
    maxLoginPosts: opening.maxLoginPosts,
    monitor,
    ...(opening.scriptRequest === undefined ? {} : { scriptRequest: opening.scriptRequest }),
    ...(opening.credentialGuard === undefined ? {} : { credentialGuard: opening.credentialGuard }),
    ...(opening.manualPassThrough === true ? { manualPassThrough: true as const } : {}),
    ...(opening.manualPassThrough === true && opening.manualServiceReadOrigins !== undefined
      ? { manualServiceReadOrigins: opening.manualServiceReadOrigins }
      : {}),
  });
  resources.context = context;
  opening.onContextCreated?.(context);
  const page = await factory.createPassivePage(context);
  return { browser, context, page, monitor };
}

/** ログイン用の Context、factory、Browser を、この順に閉じる（失敗は投げない）。 */
export async function closeLoginStage(resources: LoginStageResources): Promise<void> {
  const { browser, factory, context } = resources;
  if (factory !== null && context !== null) {
    await factory.closePassiveContext(context).catch(() => undefined);
  }
  await factory?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}

/** 止める印が来るか、`ms` が過ぎるまで待つ。 */
export const waitOrAbort = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolvePromise) => {
  const timer = setTimeout(done, ms);
  function done(): void {
    clearTimeout(timer);
    signal.removeEventListener('abort', done);
    resolvePromise();
  }
  signal.addEventListener('abort', done, { once: true });
});

/** URL の解析（できなければ `null`）。 */
const parsedUrl = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/** 認証の設定の CSS のセレクタの要素を、page の main frame から引く（Playwright の独自のセレクタとして解釈させない）。 */
export const loginStageLocator = (page: Page, selector: string): Locator => page.locator(`${CSS_SELECTOR_ENGINE}${selector}`);

/**
 * ログインの段の Guard の口（T34c。Task 34 の設計書 3.3）。認証の設定のログインの送り方（`loginTransportOf`）から作る、唯一の対応。
 * - `FORM_NAVIGATION`（版 2 を含む）: フォームの送信先（`loginPostEndpoints`）だけ（今のまま）。
 * - `SCRIPT_REQUEST`: フォームの送信先は使わず（空）、スクリプトの口（token の送信先、ログインに伴う送信、プロファイルの承認したサービスの Origin）を
 *   渡す。token の送信先がない設定（手動のログインのプロファイルの、入口の確かめの案のまま保存した形。T44e）は、送信先を空にし、プロファイルの承認した
 *   サービスの Origin を `manualServiceReadOrigins` に渡す（T44R の M-1。手動のログインの段だけが Guard に渡し、Guard は読み取りだけを通す。自動ログインの段は
 *   渡さず、factory が Context を作らない。fail-closed）。
 */
export type LoginStageGuard = Pick<GuardLoginStage, 'loginPostEndpoints' | 'scriptRequest' | 'manualServiceReadOrigins'>;

export const loginStageGuardOf = (setup: AuthSetup, approvedServiceOrigins: readonly string[]): LoginStageGuard => {
  if (loginTransportOf(setup) !== SCRIPT_REQUEST_TRANSPORT) {
    return { loginPostEndpoints: setup.loginPostEndpoints };
  }
  const { scriptLogin } = setup;
  return scriptLogin === null
    ? { loginPostEndpoints: [], manualServiceReadOrigins: approvedServiceOrigins }
    : {
      loginPostEndpoints: [],
      scriptRequest: { scriptLogin, loginSideRequests: setup.loginSideRequests, approvedServiceOrigins },
    };
};

/**
 * フォームの送信のログインで、送信先への POST が、回数の上限で止められたか（Guard は、上限を超えた送信先への POST を `blockedRequests` に残す）。
 * 自動ログインの段（フォームの送信だけ）と、`loginStageAttemptsExceeded` の `FORM_NAVIGATION` が使う。
 */
export const loginAttemptsExceeded = (ledger: SafetyLedger, allowedOrigins: ReadonlySet<string>, setup: AuthSetup): boolean =>
  ledger.snapshot().blockedRequests.some(({ method, url }) =>
    method === LOGIN_POST_METHOD && isLoginEndpointPost(url, allowedOrigins, setup.loginPostEndpoints));

/**
 * 手動のログインの段の試みが回数の上限を超えたか（T34c で、ログインの送り方ごとに分けた。Task 34 の設計書 3.4）。
 * - `SCRIPT_REQUEST`: Guard の記録（`monitor.tokenRequestsBlockedOverLimit()`）の、上限を超えて止めた token の送信が 1 以上。上限の中で止めた送信
 *   （種類や query の違い）は、試みに数えない（Safety Ledger は読み直さない）。
 * - `FORM_NAVIGATION`: 今どおり `loginAttemptsExceeded`（Safety Ledger の止めた送信先への POST）。
 */
export const loginStageAttemptsExceeded = (
  ledger: SafetyLedger,
  monitor: LoginStageMonitor,
  allowedOrigins: ReadonlySet<string>,
  setup: AuthSetup,
): boolean => (loginTransportOf(setup) === SCRIPT_REQUEST_TRANSPORT
  ? monitor.tokenRequestsBlockedOverLimit() >= 1
  : loginAttemptsExceeded(ledger, allowedOrigins, setup));

/**
 * 状態に、成功のローカル ストレージの鍵の形（`successStorageKey`。T34c）に当たる鍵の名前があるか。その Origin のローカル ストレージの鍵の名前が、
 * 接頭辞で始まり、接尾辞で終わり、接頭辞と接尾辞が重ならない（名前の長さが、接頭辞と接尾辞の長さの和以上）ときだけ真。値は見ない。Origin は、
 * 許可 Origin と同じ意味で比べる（`isOriginInAllowedOrigins`）。
 */
export const hasSuccessStorageKey = (state: AuthenticatedState, key: SuccessStorageKey): boolean =>
  state.origins.some(({ origin, localStorage }) => isOriginInAllowedOrigins([key.origin], origin) && localStorage.some(({ name }) =>
    name.length >= key.prefix.length + key.suffix.length && name.startsWith(key.prefix) && name.endsWith(key.suffix)));

/**
 * 成功の条件の、状態の側の確かめ（T34c。Task 34 の設計書 3.4）。`SCRIPT_REQUEST` では、次の 2 つをどちらも満たすこと。`FORM_NAVIGATION` には、
 * 状態の側の条件はない（真）。
 * - 状態（Node の側で読んだ `storageState` を許可 Origin に絞ったもの）に、成功の鍵の形の鍵の名前がある（ページの中では読まない）。
 * - T34R-fix-a（T34R の M-1）: Guard が、登録した token の送信を 1 回以上通した（`monitor` の `tokenRequestsAllowed`）。ページの JS が鍵の名前だけを
 *   作って成功の条件の画面へ移っても、成功にしない。
 */
export const meetsSuccessStateCondition = (state: AuthenticatedState, setup: AuthSetup, monitor: LoginStageMonitor): boolean => {
  if (loginTransportOf(setup) !== SCRIPT_REQUEST_TRANSPORT) {
    return true;
  }
  return monitor.snapshot().scriptRequest.tokenRequestsAllowed >= 1
    && setup.successStorageKey !== null
    && hasSuccessStorageKey(state, setup.successStorageKey);
};

/**
 * IPC に載せる、スクリプトで送るログインの段の結果の数（T34c。Task 34 の設計書 3.5）。`SCRIPT_REQUEST` だけ（`FORM_NAVIGATION` は `undefined`）。
 * Guard の記録の写し（`monitor.snapshot().scriptRequest`）の数だけで、URL・本文・値を持たない。
 */
export const scriptLoginCountsOf = (monitor: LoginStageMonitor, setup: AuthSetup): WorkerScriptLoginCounts | undefined => {
  if (loginTransportOf(setup) !== SCRIPT_REQUEST_TRANSPORT) {
    return undefined;
  }
  const counts = monitor.snapshot().scriptRequest;
  return {
    tokenRequestsAllowed: counts.tokenRequestsAllowed,
    sideRequestsAllowed: [...counts.sideRequestsAllowed],
    serviceOriginReads: counts.serviceOriginReads,
    blockedByReason: { ...counts.blockedByScriptReason },
  };
};

/**
 * IPC に載せる、ログインの段で止めた読み取りでない要求の一覧（T34e。Task 34 の設計書 3.5 と 8 章の T34e の行）。ログインの送り方によらない。止めた要求が
 * なければ `undefined`（`AUTH_STATE` に項目を付けない）。Guard の記録の写し（`monitor.snapshot().blockedRequests`）の Origin と path と種類と理由と
 * 回数だけで、query・本文・値を持たない。
 */
export const loginStageBlockedRequestsOf = (monitor: LoginStageMonitor): WorkerLoginStageBlockedRequests | undefined => {
  const { requests, unlisted } = monitor.snapshot().blockedRequests;
  if (requests.length === 0 && unlisted === 0) {
    return undefined;
  }
  return { requests: requests.map((request) => ({ ...request })), unlisted };
};

/**
 * ML-a: IPC に載せる、手動のログインの段で通した読み取りでない要求の一覧（止めた一覧と同じ形。Guard の記録の写しの Origin と path と種類と、通さなければ
 * 止めた理由と回数と query の名前と閉じた一覧の値だけ）。通した要求がなければ `undefined`（`AUTH_STATE` に項目を付けない）。
 */
export const loginStagePassedRequestsOf = (monitor: LoginStageMonitor): WorkerLoginStageBlockedRequests | undefined => {
  const { requests, unlisted } = monitor.snapshot().passedRequests;
  if (requests.length === 0 && unlisted === 0) {
    return undefined;
  }
  return { requests: requests.map((request) => ({ ...request })), unlisted };
};

/**
 * page の main frame が、ログインの結果の条件（許可 Origin で、path が `pathPrefix` の前方一致。セレクタがあれば、その要素がある）に当たるか
 * （読み取りだけ。失敗は「当たらない」）。成功の条件と、自動ログインの失敗の条件の判定に使う。
 */
export const isLoginResultConditionPage = async (
  page: Page,
  condition: LoginResultCondition,
  approvedTestOrigins: readonly string[],
): Promise<boolean> => {
  const url = parsedUrl(page.url());
  if (url === null || !isOriginInAllowedOrigins(approvedTestOrigins, url.origin) || !url.pathname.startsWith(condition.pathPrefix)) {
    return false;
  }
  const { selector } = condition;
  if (selector === null) {
    return true;
  }
  try {
    return (await loginStageLocator(page, selector).count()) > 0;
  } catch {
    return false;
  }
};

/** page の main frame が成功の条件に当たるか。 */
export const isSuccessPage = (page: Page, setup: AuthSetup, approvedTestOrigins: readonly string[]): Promise<boolean> =>
  isLoginResultConditionPage(page, setup.successCondition, approvedTestOrigins);

/** 絞った状態に、許可 Origin の Cookie か localStorage の項目があるか。 */
const hasAuthenticatedValues = (state: AuthenticatedState): boolean =>
  state.cookies.length > 0 || state.origins.some(({ localStorage }) => localStorage.length > 0);

/**
 * ログインの Context の状態を読んだ結果（DEF-139）。`state` は絞った状態（空なら `null`）、`names` はその状態の名前の記録（値を持たない。設計書 2.1）。
 */
export interface LoginStageStateReading {
  readonly state: AuthenticatedState | null;
  readonly names: LoginStateNameRecord;
}

/**
 * ログインの Context の状態をメモリに取り（DEF-139: IndexedDB を含めて、factory の唯一の読み口 `readContextStorageState` で読む）、ブラウザが許可 Origin
 * か承認したサービスの Origin へ送る Cookie と、許可 Origin の localStorage と、両方の Origin の IndexedDB だけに絞る（ファイルに書かない。絞り込みの owner
 * は `filterAuthenticatedState`）。絞った結果に Cookie も localStorage もなければ `state` は `null`（呼ぶ側が `UNSUPPORTED_AUTH_STATE` にする）。
 * 同じ状態から、名前の記録も作る。読めなければ投げる。
 */
export async function readAuthenticatedState(
  context: BrowserContext,
  approvedTestOrigins: readonly string[],
  approvedServiceOrigins: readonly string[] = [],
): Promise<LoginStageStateReading> {
  const raw = await readContextStorageState(context);
  const state = filterAuthenticatedState(raw, approvedTestOrigins, approvedServiceOrigins);
  return { state: hasAuthenticatedValues(state) ? state : null, names: authenticatedStateNameRecordOf(raw, approvedTestOrigins, approvedServiceOrigins) };
}
