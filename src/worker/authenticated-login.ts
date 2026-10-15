/**
 * 認証つきの監査のログインの段（Task 25 の設計書 3 章、4.4。T25d）。ワーカーの流れ（`audit-worker-session.ts`）が、認証つきの `START` を受けて、
 * 監査の前に 1 回呼ぶ（再開のときも、もう一度呼ぶ。状態は保存しない）。
 *
 * 流れ:
 * 1. ログイン用の Browser を起動する（本番は headed。人が操作する。`launchLoginBrowser` は入口が渡す）。
 * 2. Context の作り方の owner（`BrowserContextFactory`）の入口 `createLoginStageContext` で、ログインの段の Guard（認証の設定の
 *    `loginPostEndpoints` と `maxLoginAttempts`）を付けた Context を作り、Guard の準備を待った page で `loginStartUrl` を開く。開いたら
 *    `onAwaitingLogin` を呼ぶ（ワーカーが `AUTH_STATE`（`AWAITING_LOGIN`）を送る）。
 * 3. 人がログインするのを待つ。名前つきの間隔（`LOGIN_POLL_INTERVAL_MS`）で、次の順に確かめる。
 *    - 止める印（`STOP`・Ctrl+C）→ `STOPPED`。
 *    - Context が閉じた（Guard が閉じた、人が閉じた、Browser が切れた）か、page が 1 つもない → `AUTH_SETUP_REQUIRED`。
 *    - Safety Ledger の `blockedRequests` に、送信先への POST（回数の上限で Guard が止めたもの）がある → `LOGIN_ATTEMPTS_EXCEEDED`。送信先かは、
 *      要求の判定の owner（`classifyPassiveRequest`）に、残りの回数 1 の `authSetup` の口を渡して ALLOW になるかで調べる（判定を書き写さない）。
 *    - どれかの page の main frame が成功の条件（許可 Origin で、path が `successCondition.pathPrefix` の前方一致。セレクタがあれば、その要素が
 *      ある）に当たる → 成功。
 *    - 名前つきの時間（`LOGIN_WAIT_TIMEOUT_MS`）を過ぎた → `LOGIN_TIMEOUT`。
 * 4. 成功したら、Context の `storageState()` をメモリに取り、`filterAuthenticatedState` で許可 Origin の Cookie と localStorage だけに絞る。
 *    絞った結果が空なら `UNSUPPORTED_AUTH_STATE`（別の Origin や sessionStorage に頼る認証。Task 26 以降）。
 * 5. どの終わり方でも、ログイン用の Context と Browser を閉じてから返す（ワーカーは、閉じた後に `AUTHENTICATED` を送る）。
 *
 * 秘密（Cookie と localStorage の値）は、返す値の中だけに置く。ファイル、ログ、誤りの文、IPC に出さない。この部品は何も書かない。
 * ログインの段の Safety Ledger と、ページの console は、返す値に入れず、記録もせず、どこにも渡さない（ページの JS が送ろうとした要求の URL に、
 * 人が入れた値が入りうる。Task 26 の調査 E2。T26d-1 で確かめた）。
 * 判定と、開き方・閉じ方・状態の取り出しは、自動ログインの段と共通の部品（`login-stage-checks.ts`。T26d-1）を使う。
 * **資格情報を自動で入れる処理を持たない。** テストだけの口 `onLoginPageReady`（関数の引数の依存の注入）は、本番の入口（`audit-worker.ts`）が
 * 渡さない。IPC・設定・環境変数からは渡せない（`tests/architecture/worker-login-hooks.test.ts` で確かめる）。
 */
import type { Browser, Page } from 'playwright';
import type { AuditConfig } from '../config/types.js';
import type { AuthSetup } from '../control/auth/auth-setup-contracts.js';
import type { AuthenticatedState } from '../control/auth/authenticated-state.js';
import type { WorkerLoginFailureState } from '../control/worker-protocol.js';
import { isPassiveRequestGuardClosed } from '../safety/passive-request-guard.js';
import { canonicalPassiveAllowedOrigins } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import {
  closeLoginStage,
  createLoginStageResources,
  isSuccessPage,
  loginAttemptsExceeded,
  openLoginStagePage,
  readAuthenticatedState,
  waitOrAbort,
} from './login-stage-checks.js';

/** 人がログインするのを待つ時間の上限（ms。10 分。Task 25 の設計書 4.4）。過ぎたら `LOGIN_TIMEOUT`。 */
export const LOGIN_WAIT_TIMEOUT_MS = 600_000;

/** ログインの段の状態を確かめる間隔（ms）。ページの中の読み取り（URL と要素の有無）だけで、サイトへの要求を増やさない。 */
export const LOGIN_POLL_INTERVAL_MS = 500;

/**
 * 本番のログイン用の Browser を headless で起動するか（偽: headed。人が操作するため。Task 25 の設計書 4.4）。監査の Browser の headless
 * （`WORKER_CONFIG_OVERRIDES`）は、ログイン用の Browser には掛からない。テストは `launchLoginBrowser` を替えて headless で起動する。
 */
export const LOGIN_BROWSER_HEADLESS = false;

/** ログインの段の終わり方。 */
export type LoginStageResult =
  | { readonly kind: 'AUTHENTICATED'; readonly state: AuthenticatedState }
  | { readonly kind: WorkerLoginFailureState }
  | { readonly kind: 'STOPPED' };

/** ログインの段の入力（ワーカーの流れが渡す）。 */
export interface LoginStageRequest {
  /** 監査の設定（読み込んだターゲット設定。許可 Origin、ロケール、Desktop の幅を使う）。 */
  readonly config: AuditConfig;
  /** 親が検証し、SHA-256 を確かめた認証の設定。 */
  readonly setup: AuthSetup;
  /** 状態を絞る Origin（プロファイルの `approvedTestOrigins`）。 */
  readonly approvedTestOrigins: readonly string[];
  /** 止める印（`STOP`・Ctrl+C）。 */
  readonly signal: AbortSignal;
  /** ログインの画面を開いた（ワーカーが `AWAITING_LOGIN` を送る）。 */
  readonly onAwaitingLogin: () => void;
}

/** ログインの段の依存（本番の値は入口 `audit-worker.ts` が渡す）。 */
export interface LoginStageDependencies {
  /** ログイン用の Browser を起動する（本番は CLI の起動の設定の headed。`LOGIN_BROWSER_HEADLESS`）。 */
  readonly launchLoginBrowser: () => Promise<Browser>;
  /** 待つ時間の上限（ms。省略すると `LOGIN_WAIT_TIMEOUT_MS`。テストは短くする）。 */
  readonly loginTimeoutMs?: number;
  /** 確かめる間隔（ms。省略すると `LOGIN_POLL_INTERVAL_MS`）。 */
  readonly pollIntervalMs?: number;
  /**
   * テストだけの口: ログインの画面を開いた page を渡す（テストが、人の操作の代わりに入力する）。本番の入口は渡さない。返した Promise は待たない
   * （待つ間も、時間切れと回数の上限を確かめる）。reject は握りつぶす。
   */
  readonly onLoginPageReady?: (page: Page) => Promise<void>;
}

/** 待つ間の 1 回の確かめ（決まらなければ `null`）。 */
type LoginCheck = Exclude<LoginStageResult, { readonly kind: 'AUTHENTICATED' }> | { readonly kind: 'SUCCEEDED' } | null;

/**
 * ログインの段を行う（流れはファイルの先頭）。例外を投げない（予期しない失敗は `AUTH_SETUP_REQUIRED`）。どの終わり方でも、ログイン用の
 * Context と Browser を閉じてから返す。
 */
export async function runLoginStage(request: LoginStageRequest, dependencies: LoginStageDependencies): Promise<LoginStageResult> {
  const { config, setup, approvedTestOrigins, signal } = request;
  if (signal.aborted) {
    return { kind: 'STOPPED' };
  }
  const timeoutMs = dependencies.loginTimeoutMs ?? LOGIN_WAIT_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS;
  const deadline = performance.now() + timeoutMs;
  const allowedOrigins = canonicalPassiveAllowedOrigins(new Set(config.site.allowedOrigins));
  const resources = createLoginStageResources();
  try {
    const ledger = new SafetyLedger();
    const { page, context: loginContext, browser: loginBrowser } = await openLoginStagePage(resources, {
      launchBrowser: dependencies.launchLoginBrowser,
      config,
      ledger,
      loginPostEndpoints: setup.loginPostEndpoints,
      maxLoginPosts: setup.maxLoginAttempts,
    });
    await page.goto(setup.loginStartUrl).catch(() => undefined);
    request.onAwaitingLogin();
    dependencies.onLoginPageReady?.(page).catch(() => undefined);

    const check = async (): Promise<LoginCheck> => {
      if (signal.aborted) {
        return { kind: 'STOPPED' };
      }
      if (isPassiveRequestGuardClosed(loginContext) || !loginBrowser.isConnected() || loginContext.pages().length === 0) {
        return { kind: 'AUTH_SETUP_REQUIRED' };
      }
      if (loginAttemptsExceeded(ledger, allowedOrigins, setup)) {
        return { kind: 'LOGIN_ATTEMPTS_EXCEEDED' };
      }
      for (const candidate of loginContext.pages()) {
        if (await isSuccessPage(candidate, setup, approvedTestOrigins)) {
          return { kind: 'SUCCEEDED' };
        }
      }
      return performance.now() >= deadline ? { kind: 'LOGIN_TIMEOUT' } : null;
    };
    let outcome = await check();
    while (outcome === null) {
      await waitOrAbort(Math.max(0, Math.min(pollIntervalMs, deadline - performance.now())), signal);
      outcome = await check();
    }
    if (outcome.kind !== 'SUCCEEDED') {
      return outcome;
    }
    // 成功: 状態をメモリに取り、許可 Origin だけに絞る（ファイルに書かない）。
    const state = await readAuthenticatedState(loginContext, approvedTestOrigins);
    return state === null ? { kind: 'UNSUPPORTED_AUTH_STATE' } : { kind: 'AUTHENTICATED', state };
  } catch {
    // 起動・Context の作成・Guard の準備・状態の取り出しの失敗（閉じた Context を含む）。誤りの文は使わない（秘密を含みうる値を出さない）。
    return signal.aborted ? { kind: 'STOPPED' } : { kind: 'AUTH_SETUP_REQUIRED' };
  } finally {
    await closeLoginStage(resources);
  }
}
