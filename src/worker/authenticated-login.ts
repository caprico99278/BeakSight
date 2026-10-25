/**
 * 認証つきの監査のログインの段（Task 25 の設計書 3 章、4.4。T25d）。ワーカーの流れ（`audit-worker-session.ts`）が、認証つきの `START` を受けて、
 * 監査の前に 1 回呼ぶ（再開のときも、もう一度呼ぶ。状態は保存しない）。
 *
 * 流れ:
 * 1. ログイン用の Browser を起動する（本番は headed。人が操作する。`launchLoginBrowser` は入口が渡す）。
 * 2. Context の作り方の owner（`BrowserContextFactory`）の入口 `createLoginStageContext` で、ログインの段の Guard（認証の設定の
 *    `loginPostEndpoints` と `maxLoginAttempts`。T34c: ログインの送り方ごとの口は `loginStageGuardOf`。スクリプトで送るログインでは、token の送信先、
 *    ログインに伴う送信、プロファイルの承認したサービスの Origin）を付けた Context を作り、Guard の準備を待った page で `loginStartUrl` を開く。開いたら
 *    `onAwaitingLogin` を呼ぶ（ワーカーが `AUTH_STATE`（`AWAITING_LOGIN`）を送る）。
 * 3. 人がログインするのを待つ。名前つきの間隔（`LOGIN_POLL_INTERVAL_MS`）で、次の順に確かめる。
 *    - 止める印（`STOP`・Ctrl+C）→ `STOPPED`。
 *    - Context が閉じた（Guard が閉じた、人が閉じた、Browser が切れた）か、page が 1 つもない → `AUTH_SETUP_REQUIRED`。
 *    - Safety Ledger の `blockedRequests` に、送信先への POST（回数の上限で Guard が止めたもの）がある → `LOGIN_ATTEMPTS_EXCEEDED`。送信先かは、
 *      要求の判定の owner（`classifyPassiveRequest`）に、残りの回数 1 の `authSetup` の口を渡して ALLOW になるかで調べる（判定を書き写さない）。
 *      T34c: スクリプトで送るログイン（`SCRIPT_REQUEST`）では、Ledger を読み直さず、Guard の記録の「上限を超えて止めた token の送信の数」が 1 以上
 *      なら `LOGIN_ATTEMPTS_EXCEEDED`（`loginStageAttemptsExceeded`）。
 *    - どれかの page の main frame が成功の条件（許可 Origin で、path が `successCondition.pathPrefix` の前方一致。セレクタがあれば、その要素が
 *      ある）に当たる → 成功。T34c: スクリプトで送るログインでは、加えて、Node の側で読んだ状態（許可 Origin に絞ったもの）に成功の鍵の形
 *      （`successStorageKey`）の鍵の名前があること（値は読まない）。なければ待ち続ける。成功を確かめたら、Guard の送信の窓を閉じる。
 *    - 名前つきの時間（`LOGIN_WAIT_TIMEOUT_MS`）を過ぎた → `LOGIN_TIMEOUT`。
 *    - ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md`）: 利用者が「ログインを終えた」を押した（`loginConfirmed`）→ 成功。
 *    ML-a: 手動のログインの段の Guard は、ページの読み取りでない送信（ログインの送信、手続きの呼び出し）を止めずに通し（読み取りは今のまま）、読み取りでない
 *    要求の形だけを記録する（`passedRequests`。終わり方によらず、記録があれば返す）。登録した送信先と回数の上限は、自動ログインの段だけに当てる。
 * 4. 成功したら、Context の `storageState()` をメモリに取り、`filterAuthenticatedState` で許可 Origin の Cookie と localStorage だけに絞る。
 *    絞った結果が空なら `UNSUPPORTED_AUTH_STATE`（別の Origin や sessionStorage に頼る認証。Task 26 以降）。DEF-139: IndexedDB を含めて読み、ブラウザが
 *    許可 Origin か承認したサービスの Origin へ送る Cookie（親ドメインの Cookie を含む）と、両方の Origin の IndexedDB も引き継ぐ。状態の名前の記録
 *    （`stateNames`。値を持たない）も返す。
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
import type { ChromiumLaunchRefusalReason } from '../browser/chromium-launch.js';
import { SCRIPT_REQUEST_TRANSPORT, loginTransportOf, type AuthSetup } from '../control/auth/auth-setup-contracts.js';
import type { AuthenticatedState, LoginStateNameRecord } from '../control/auth/authenticated-state.js';
import type {
  WorkerLoginFailureState,
  WorkerLoginObservation,
  WorkerLoginStageBlockedRequests,
  WorkerScriptLoginCounts,
} from '../control/worker-protocol.js';
import { isPassiveRequestGuardClosed } from '../safety/passive-request-guard.js';
import { canonicalPassiveAllowedOrigins } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import {
  closeLoginStage,
  createLoginStageResources,
  isSuccessPage,
  LOGIN_BROWSER_LAUNCH_REFUSED,
  loginBrowserLaunchRefusalOf,
  loginStageAttemptsExceeded,
  loginStageGuardOf,
  meetsSuccessStateCondition,
  openLoginStagePage,
  readAuthenticatedState,
  loginStageBlockedRequestsOf,
  loginStagePassedRequestsOf,
  scriptLoginCountsOf,
  waitOrAbort,
} from './login-stage-checks.js';
import { observeLoginPageStart, observeLoginStageEnd } from './login-stage-observation.js';

/** 人がログインするのを待つ時間の上限（ms。10 分。Task 25 の設計書 4.4）。過ぎたら `LOGIN_TIMEOUT`。 */
export const LOGIN_WAIT_TIMEOUT_MS = 600_000;

/** ログインの段の状態を確かめる間隔（ms）。ページの中の読み取り（URL と要素の有無）だけで、サイトへの要求を増やさない。 */
export const LOGIN_POLL_INTERVAL_MS = 500;

/**
 * 本番のログイン用の Browser を headless で起動するか（偽: headed。人が操作するため。Task 25 の設計書 4.4）。監査の Browser の headless
 * （`WORKER_CONFIG_OVERRIDES`）は、ログイン用の Browser には掛からない。テストは `launchLoginBrowser` を替えて headless で起動する。
 */
export const LOGIN_BROWSER_HEADLESS = false;

/**
 * ログインの段の終わり方。T34c: スクリプトで送るログインでは、Guard を付けた Context を作れた後の成功と失敗が、ログインの段の結果の数
 * （`scriptLogin`。数だけ。ワーカーが `AUTH_STATE` に載せる）を持つ。T34e: Guard を付けた Context を作れた後の成功と失敗は、ログインの送り方によらず、
 * 止めた読み取りでない要求の一覧（`blockedRequests`。止めた要求があったときだけ）も持つ。T34R-fix-a: 止める印で終わったとき（`STOPPED`）も、Context を
 * 作れた後なら、同じ数と一覧を持つ（ワーカーが親に渡してから終わる）。
 */
export type LoginStageResult = LoginStageRecords & (
  | { readonly kind: 'AUTHENTICATED'; readonly state: AuthenticatedState }
  | { readonly kind: WorkerLoginFailureState }
  | { readonly kind: 'STOPPED' }
  // EL-3: ログイン用の Browser を、起動の部品が閉じた理由で断った（ワーカーの中だけ。`LOGIN_BROWSER_LAUNCH_REFUSED`）。
  | { readonly kind: typeof LOGIN_BROWSER_LAUNCH_REFUSED; readonly refusal: ChromiumLaunchRefusalReason }
);

/**
 * ログインの段の結果に添える記録（数、止めた一覧、T43d の観察。どれも値・本文を持たない）。T43d（Task 43 の設計書 4.4）: 観察（`loginObservation`。
 * 成功の鍵の名前の案と、成功のときだけ成功の画面のセレクタの案）は、Context を作れた後の終わり方で、観察したことがあったときだけ持つ。
 */
export interface LoginStageRecords {
  readonly scriptLogin?: WorkerScriptLoginCounts;
  readonly blockedRequests?: WorkerLoginStageBlockedRequests;
  readonly loginObservation?: WorkerLoginObservation;
  /** ML-a: 手動のログインの段で通した読み取りでない要求の一覧（形だけ。通した要求があったときだけ）。 */
  readonly passedRequests?: WorkerLoginStageBlockedRequests;
  /**
   * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: ログインの後のブラウザの状態の名前の記録（Cookie・ローカル ストレージの鍵・
   * IndexedDB のデータベースの、名前の形と、引き継いだか外したか。値を持たない）。ログインの段の終わりに状態を読んだとき（成功と `UNSUPPORTED_AUTH_STATE`）
   * だけ持つ。
   */
  readonly stateNames?: LoginStateNameRecord;
}

/** ログインの段の入力（ワーカーの流れが渡す）。 */
export interface LoginStageRequest {
  /** 監査の設定（読み込んだターゲット設定。許可 Origin、ロケール、Desktop の幅を使う）。 */
  readonly config: AuditConfig;
  /** 親が検証し、SHA-256 を確かめた認証の設定。 */
  readonly setup: AuthSetup;
  /** 状態を絞る Origin（プロファイルの `approvedTestOrigins`）。 */
  readonly approvedTestOrigins: readonly string[];
  /**
   * T34c: プロファイルの承認したサービスの Origin（`START` の `approvedServiceOrigins`。省略は空）。スクリプトで送るログインの Guard の口に渡す。
   */
  readonly approvedServiceOrigins?: readonly string[] | undefined;
  /** 止める印（`STOP`・Ctrl+C）。 */
  readonly signal: AbortSignal;
  /** ログインの画面を開いた（ワーカーが `AWAITING_LOGIN` を送る）。 */
  readonly onAwaitingLogin: () => void;
  /**
   * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.2）: 利用者が「ログインを終えた」を押したか（親の `LOGIN_CONFIRMED` を受けたか）。
   * 真なら、成功の条件に当たらなくても成功として、今の成功の後の手順（状態の取り出しと絞り込み、空なら `UNSUPPORTED_AUTH_STATE`）に進む。省略は偽。
   */
  readonly loginConfirmed?: (() => boolean) | undefined;
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

/**
 * 待つ間の 1 回の確かめ（決まらなければ `null`）。成功（`SUCCEEDED`）は、状態の側の条件を確かめるために読んだ状態があれば持つ（スクリプトで送る
 * ログイン）。
 */
type LoginCheck =
  | { readonly kind: WorkerLoginFailureState | 'STOPPED' }
  | { readonly kind: 'SUCCEEDED'; readonly state: AuthenticatedState | null; readonly names: LoginStateNameRecord | null }
  | null;

/**
 * ログインの段を行う（流れはファイルの先頭）。例外を投げない（予期しない失敗は `AUTH_SETUP_REQUIRED`）。どの終わり方でも、ログイン用の
 * Context と Browser を閉じてから返す。
 */
export async function runLoginStage(request: LoginStageRequest, dependencies: LoginStageDependencies): Promise<LoginStageResult> {
  const { config, setup, approvedTestOrigins, signal } = request;
  const approvedServiceOrigins = request.approvedServiceOrigins ?? [];
  if (signal.aborted) {
    return { kind: 'STOPPED' };
  }
  const timeoutMs = dependencies.loginTimeoutMs ?? LOGIN_WAIT_TIMEOUT_MS;
  const pollIntervalMs = dependencies.pollIntervalMs ?? LOGIN_POLL_INTERVAL_MS;
  const deadline = performance.now() + timeoutMs;
  const allowedOrigins = canonicalPassiveAllowedOrigins(new Set(config.site.allowedOrigins));
  const resources = createLoginStageResources();
  // T34c: ログインの送り方ごとの Guard の口（唯一の対応は `loginStageGuardOf`）と、成功の状態の側の条件があるか（スクリプトで送るログイン）。
  const guard = loginStageGuardOf(setup, approvedServiceOrigins);
  // T44e（Task 44 の設計書 P2-8）: 成功の鍵がまだない（手動のログインのプロファイルで、入口の確かめの案のまま保存した）スクリプトで送るログインは、
  // フォームの送信と同じく成功の条件の画面だけで終える（鍵は、成功の後の自動の登録が観察から埋める）。鍵があれば今どおり状態の側も確かめる。
  const checksStoredState = loginTransportOf(setup) === SCRIPT_REQUEST_TRANSPORT && setup.successStorageKey !== null;
  try {
    const ledger = new SafetyLedger();
    const { page, context: loginContext, browser: loginBrowser, monitor } = await openLoginStagePage(resources, {
      launchBrowser: dependencies.launchLoginBrowser,
      config,
      ledger,
      loginPostEndpoints: guard.loginPostEndpoints,
      maxLoginPosts: setup.maxLoginAttempts,
      ...(guard.scriptRequest === undefined ? {} : { scriptRequest: guard.scriptRequest }),
      // T44R の M-1: token の送信先がまだない設定でも、承認したサービスの Origin への読み取りを通す（手動のログインの段だけ）。
      ...(guard.manualServiceReadOrigins === undefined ? {} : { manualServiceReadOrigins: guard.manualServiceReadOrigins }),
      // ML-a: 手動のログインの段は、ページの送信を止めずに通し、形だけを記録する（登録した送信先と回数の上限は、自動ログインの段だけに当てる）。
      manualPassThrough: true,
    });
    await page.goto(setup.loginStartUrl).catch(() => undefined);
    // T43d: ログインの画面の鍵の名前と、要素の候補の CSS を読む（値を読まない。ページを操作しない）。
    // FM2e: ログインの 3 つの欄の検出も頼む（自動ログインの設定の画面の案。値を読まない）。
    const baseline = await observeLoginPageStart(page, setup.loginStartUrl, { detectLoginFields: true });
    request.onAwaitingLogin();
    dependencies.onLoginPageReady?.(page).catch(() => undefined);

    // T43d: 成功の条件に当たった page（終わりの観察に使う）。
    let successPage: Page | undefined;
    const check = async (): Promise<LoginCheck> => {
      if (signal.aborted) {
        return { kind: 'STOPPED' };
      }
      if (isPassiveRequestGuardClosed(loginContext) || !loginBrowser.isConnected() || loginContext.pages().length === 0) {
        return { kind: 'AUTH_SETUP_REQUIRED' };
      }
      if (loginStageAttemptsExceeded(ledger, monitor, allowedOrigins, setup)) {
        return { kind: 'LOGIN_ATTEMPTS_EXCEEDED' };
      }
      for (const candidate of loginContext.pages()) {
        if (await isSuccessPage(candidate, setup, approvedTestOrigins)) {
          successPage = candidate;
          if (!checksStoredState) {
            return { kind: 'SUCCEEDED', state: null, names: null };
          }
          // T34c: スクリプトで送るログインは、Node の側で読んだ状態に成功の鍵の形の鍵の名前があるときだけ成功（値は読まない）。なければ待ち続ける。
          const stored = await readAuthenticatedState(loginContext, approvedTestOrigins, approvedServiceOrigins);
          if (stored.state !== null && meetsSuccessStateCondition(stored.state, setup, monitor)) {
            return { kind: 'SUCCEEDED', state: stored.state, names: stored.names };
          }
          break;
        }
      }
      // ML-a: 利用者が「ログインを終えた」を押したら、成功の条件に当たらなくても成功とする（状態は後で読む）。
      if (request.loginConfirmed?.() === true) {
        return { kind: 'SUCCEEDED', state: null, names: null };
      }
      return performance.now() >= deadline ? { kind: 'LOGIN_TIMEOUT' } : null;
    };
    let outcome = await check();
    while (outcome === null) {
      await waitOrAbort(Math.max(0, Math.min(pollIntervalMs, deadline - performance.now())), signal);
      outcome = await check();
    }
    // T34c: ログインの段の結果の数（スクリプトで送るログインだけ。数だけ）。T34e: 止めた読み取りでない要求の一覧（ログインの送り方によらない）。
    const scriptLogin = scriptLoginCountsOf(monitor, setup);
    const blockedRequests = loginStageBlockedRequestsOf(monitor);
    // ML-a: 通した読み取りでない要求の一覧（形だけ）。
    const passedRequests = loginStagePassedRequestsOf(monitor);
    const withCounts = {
      ...(scriptLogin === undefined ? {} : { scriptLogin }),
      ...(blockedRequests === undefined ? {} : { blockedRequests }),
      ...(passedRequests === undefined ? {} : { passedRequests }),
    };
    // T43d: 終わりの観察（鍵の名前の差分。成功のときだけ、凍結した後の成功の画面のセレクタの案）。止めた一覧の写しを取った後に読む。
    const observedWith = async (succeeded: boolean): Promise<LoginStageRecords> => {
      const observedPage = successPage ?? (loginContext.pages().find((candidate) => !candidate.isClosed()));
      const loginObservation = await observeLoginStageEnd(observedPage, baseline, succeeded);
      return { ...withCounts, ...(loginObservation === undefined ? {} : { loginObservation }) };
    };
    if (outcome.kind === 'STOPPED') {
      // T34R-fix-a（T34R の I-1）: 止めたときも、それまでの数と止めた送信の一覧を持って返す（ワーカーが親に渡してから終わる）。
      // T43d: 止める要求ですぐに終えるため、観察はしない。
      return { kind: 'STOPPED', ...withCounts };
    }
    if (outcome.kind !== 'SUCCEEDED') {
      return { kind: outcome.kind, ...(outcome.kind === 'AUTH_SETUP_REQUIRED' ? withCounts : await observedWith(false)) };
    }
    // 成功の確かめが済んだので、送信の窓を閉じる（スクリプトで送るログインは、token の送信を通した時点で Guard が開いた。T34b）。
    monitor.closeSubmissionWindow();
    // 成功: 状態をメモリに取り、許可 Origin だけに絞る（ファイルに書かない）。DEF-139: 同じ状態の名前の記録も取る（値を持たない）。
    const reading = outcome.state !== null && outcome.names !== null
      ? { state: outcome.state, names: outcome.names }
      : await readAuthenticatedState(loginContext, approvedTestOrigins, approvedServiceOrigins);
    const { state } = reading;
    // T43d: 状態を取った後に、凍結して読む（凍結の後は、この Context で読み込みも要求もしない。閉じるだけ）。
    const records = { ...await observedWith(state !== null), stateNames: reading.names };
    return state === null ? { kind: 'UNSUPPORTED_AUTH_STATE', ...records } : { kind: 'AUTHENTICATED', state, ...records };
  } catch (error) {
    // 起動・Context の作成・Guard の準備・状態の取り出しの失敗（閉じた Context を含む）。誤りの文は使わない（秘密を含みうる値を出さない）。
    // EL-3: 起動の部品が閉じた理由で断ったときは、設定の見直し（`AUTH_SETUP_REQUIRED`）ではなく、その理由で終える。
    const refusal = loginBrowserLaunchRefusalOf(error);
    if (refusal !== null && !signal.aborted) {
      return { kind: LOGIN_BROWSER_LAUNCH_REFUSED, refusal };
    }
    return signal.aborted ? { kind: 'STOPPED' } : { kind: 'AUTH_SETUP_REQUIRED' };
  } finally {
    await closeLoginStage(resources);
  }
}
