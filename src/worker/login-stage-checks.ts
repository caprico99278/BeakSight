/**
 * ログインの段の共通の部品（Task 25 の設計書 4.4、Task 26 の設計書 4.4 の「判定の部品の共通化」。T26d-1 で `authenticated-login.ts` から移した）。
 * 手動のログインの段（`authenticated-login.ts`）と自動ログインの段（`automated-login.ts`）の両方が使う（書き写さない）。
 * - ログインの段の Browser・factory・Context の開き方と閉じ方（`openLoginStagePage`、`closeLoginStage`）。Context は、Context の作り方の owner
 *   （`BrowserContextFactory.createLoginStageContext`）が、ログインの段の Guard を付けて作る。
 * - 回数の上限で止められたか（`loginAttemptsExceeded`）。送信先への POST かの判定（`isLoginEndpointPost`）と、その method
 *   （`LOGIN_POST_METHOD`）は、要求の判定の owner（`src/safety/request-policy.ts`）に置く（CCX-15。共通化の台帳の CC-064）。
 * - ログインの結果の条件（成功の条件と、自動ログインの失敗の条件。`{ pathPrefix, selector }`）に page が当たるか（`isLoginResultConditionPage`）。
 * - 状態の取り出しと絞り込み（`readAuthenticatedState`。空なら `null` で、呼ぶ側が `UNSUPPORTED_AUTH_STATE` にする）。
 * 秘密（Cookie と localStorage の値、資格情報）を、ログ・誤りの文・ファイルに出さない。ログインの段の Safety Ledger を、外に渡さない（ページの JS が
 * 送ろうとした要求の URL に、ユーザー名が入りうる。Task 26 の調査 E2）。
 */
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { BrowserContextFactory } from '../browser/context-factory.js';
import type { AuditConfig } from '../config/types.js';
import type { AuthSetup, LoginPostEndpoint, LoginResultCondition } from '../control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState, type AuthenticatedState } from '../control/auth/authenticated-state.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { LoginStageMonitor } from '../safety/passive-request-guard.js';
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

/** まだ何も開いていないログインの段。 */
export const createLoginStageResources = (): LoginStageResources => ({ browser: null, factory: null, context: null });

/** ログインの段を開く指定。 */
export interface LoginStageOpening {
  /** ログイン用の Browser を起動する（呼ぶ側が渡す）。 */
  readonly launchBrowser: () => Promise<Browser>;
  readonly config: AuditConfig;
  readonly ledger: SafetyLedger;
  readonly loginPostEndpoints: readonly LoginPostEndpoint[];
  /** この Context で許す送信先への POST の回数の上限。 */
  readonly maxLoginPosts: number;
  /** Context を作った直後、page を作る前に呼ぶ（要求の観察を付ける）。 */
  readonly onContextCreated?: (context: BrowserContext) => void;
  /**
   * 読み込みの間隔を守る部品（DEF-102 fix。自動ログインの段だけが渡す。ワーカーの流れで、ログインの後のジョブと同じもの）。渡すと、factory の
   * `navigationPacer` に渡し、ログインの段の Guard が、main frame の文書の要求を送った時刻と応答を受けた時刻を記録する。手動のログインの段は
   * 渡さない（人が操作する画面は対象の外）。
   */
  readonly navigationPacer?: NavigationPacer | undefined;
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

/** 送信先への POST が、回数の上限で止められたか（Guard は、上限を超えた送信先への POST を `blockedRequests` に残す）。 */
export const loginAttemptsExceeded = (ledger: SafetyLedger, allowedOrigins: ReadonlySet<string>, setup: AuthSetup): boolean =>
  ledger.snapshot().blockedRequests.some(({ method, url }) =>
    method === LOGIN_POST_METHOD && isLoginEndpointPost(url, allowedOrigins, setup.loginPostEndpoints));

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
 * ログインの Context の状態をメモリに取り、許可 Origin の Cookie と localStorage だけに絞る（ファイルに書かない）。絞った結果が空なら `null`
 * （呼ぶ側が `UNSUPPORTED_AUTH_STATE` にする）。読めなければ投げる。
 */
export async function readAuthenticatedState(
  context: BrowserContext,
  approvedTestOrigins: readonly string[],
): Promise<AuthenticatedState | null> {
  const state = filterAuthenticatedState(await context.storageState(), approvedTestOrigins);
  return hasAuthenticatedValues(state) ? state : null;
}
