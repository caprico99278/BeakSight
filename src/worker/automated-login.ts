/**
 * 自動ログインの段（Task 26 の設計書 3 章、4.4、4.5 の結果の閉じた一覧、4.7。T26d-1）。保存した資格情報で、BeakSight がログインのフォームに
 * 値を入れて送り、結果を閉じた一覧で区別する。ワーカーの流れ・IPC・ジョブへの組み込みは T26d-2。
 *
 * 流れ:
 * 1. 資格情報のファイルの秘密でない項目（`readCredentialMetadata`）で、改訂の番号が期待どおりで、ログインの Origin が認証の設定の
 *    `loginStartUrl` の Origin（`loginOriginOf`）と同じかを確かめる。違えば `CREDENTIAL_CHANGED`、読めない（ない）なら `CREDENTIAL_UNAVAILABLE`。
 * 2. ログイン用の Browser（呼ぶ側が渡す。本番は headless の CLI の起動の設定。このファイルは headed の起動を参照しない）を起動し、Context の
 *    作り方の owner の入口（`createLoginStageContext`）で、ログインの段の Guard（送信先と、回数の上限 `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS`）を
 *    付けた Context を作り、`loginStartUrl` を開く。画面そのものが 429 なら `RATE_LIMITED`、5xx なら `AUTH_RESULT_UNKNOWN`（どちらも送信なし）。
 * 3. フォームを読むだけで確かめる（入力の部品 `inspectLoginForm`。値はまだ受け取らない）。外れたら `LOGIN_FORM_INVALID`（T26d-2: 入力の部品の
 *    理由のコード `formInvalidReason` を添える。秘密でない閉じた一覧）。
 * 4. 復号する（`readCredential`。失敗は `CREDENTIAL_UNAVAILABLE`）。復号した改訂の番号が期待と違えば `CREDENTIAL_CHANGED`。
 * 5. 送信の窓を開き（T26g-1。値を入れ始める直前から、Guard が許した送信先への POST を通すまで。窓の中では、Guard がその POST のほかの
 *    すべての要求を止める）、入力の部品の `fill` で入れ（失敗は `LOGIN_FORM_INPUT_FAILED`）、値の参照を捨て、ページの JS が値で要求を出す
 *    時間を少し待ち（`SUBMISSION_WINDOW_SETTLE_MS`）、窓の中で止めた要求があれば押さずに `UNEXPECTED_LOGIN_REQUEST`。フォームを読み直して
 *    確かめ（ページの JS が入れた後にフォームを変えた場合。外れたら `LOGIN_FORM_INVALID`）、`click` で送る（失敗は `LOGIN_FORM_INPUT_FAILED`、
 *    送信は分からない）。送信先への main frame のナビゲーションの POST を観測したら、送信は `YES`（観測していなければ `UNKNOWN`）。
 *    窓を開いた後のどの終わり方でも、窓の中で止めた要求があれば、結果は `UNEXPECTED_LOGIN_REQUEST`（成功の条件に当たっていても成功に
 *    しない。送信は観測のとおり）。
 * 6. 結果を待つ（名前つきの間隔で、時間の上限 `AUTO_LOGIN_RESULT_TIMEOUT_MS` まで）。順に:
 *    - 止める印 → `STOPPED`。Context・Browser・page が閉じた → `AUTH_RESULT_UNKNOWN`。送信を観測した後に、送信先への POST を Guard が
 *      止めたことがある（`loginAttemptsExceeded`。2 回目の送信や、ページの JS のサブ frame からの送信）→ `AUTH_RESULT_UNKNOWN`。
 *    - 送信の後の main frame の最後の文書の応答が 429 → `RATE_LIMITED`（`Retry-After` を `retryAfterUntilDateOf` で読む）。5xx →
 *      `AUTH_RESULT_UNKNOWN`。
 *    - 送信の後に main frame が新しい文書を開き、その文書を読み終えたら（DOMContentLoaded。読みかけの文書で、片方の条件だけに当たらない
 *      ため）、成功の条件と `failureConditions` のうち当たる条件がちょうど 1 つのとき、その結果（成功の条件だけなら成功）。0 か 2 以上なら
 *      待ち続ける。時間の上限までに決まらなければ `AUTH_RESULT_UNKNOWN`。
 * 7. 成功なら、共通の部品（`readAuthenticatedState`）で状態を取り出して絞る。空なら `UNSUPPORTED_AUTH_STATE`。
 * 8. どの終わり方でも、ログイン用の Context と Browser を閉じてから返す。例外を投げない（予期しない失敗は `AUTH_RESULT_UNKNOWN`。送信の前なら
 *    `NO`、後なら観測に従って `YES` か `UNKNOWN`）。呼ぶ側の誤り（`automatedLogin` が null、時間の指定の誤り）だけは投げる。
 *
 * 秘密を出さない（設計書 4.7）: 資格情報の値は、入力の部品に渡すときだけ持ち、入れた後に参照を捨てる。ログインの段の Safety Ledger と、ページの
 * console は、返す値に入れず、記録もせず、どこにも渡さない（ページの JS が送ろうとした要求の URL に、ユーザー名が入りうる。調査 E2）。誤りの文を
 * 使わない（`fill` の誤りの文に値が入る。調査 E7）。このファイルは何も書かず、何も出力しない。
 */
import type { Browser, BrowserContext, Page, Request, Response } from 'playwright';
import {
  LOGIN_FORM_STEP_TIMEOUT_MS,
  clickLoginSubmit,
  fillLoginForm,
  inspectLoginForm,
  type LoginFormInvalidReason,
  type LoginFormTarget,
} from '../browser/login-form-submitter.js';
import type { AuditConfig } from '../config/types.js';
import { SERVER_ERROR_HTTP_STATUS_RANGE, TOO_MANY_REQUESTS_HTTP_STATUS, isHttpStatusInRange } from '../core/http-status.js';
import {
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  type AuthSetup,
  type AutomatedLoginFailureConditionKind,
  type AutomatedLoginSetup,
  type LoginResultCondition,
} from '../control/auth/auth-setup-contracts.js';
import type { AuthenticatedState } from '../control/auth/authenticated-state.js';
import {
  AUTOMATED_LOGIN_RATE_LIMITED_RESULT,
  AUTOMATED_LOGIN_SUBMISSION_NONE,
  AUTOMATED_LOGIN_SUBMISSION_SENT,
  AUTOMATED_LOGIN_SUBMISSION_UNKNOWN,
  AUTOMATED_LOGIN_SUCCEEDED,
  AUTOMATED_LOGIN_UNKNOWN_RESULT,
  loginOriginOf,
  type AutomatedLoginFailureResult,
  type AutomatedLoginSubmission,
} from '../control/auth/automated-login-results.js';
import { AUTO_LOGIN_RESULT_TIMEOUT_MS, retryAfterUntilDateOf } from '../control/auth/automated-login-timing.js';
import type { CredentialMetadata, DecryptedCredential } from '../control/credentials/credential-store.js';
import type { WorkerLoginFailureState } from '../control/worker-protocol.js';
import { resolveTimeoutMs, wait } from '../core/deadline.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import { isPassiveRequestGuardClosed } from '../safety/passive-request-guard.js';
import { canonicalPassiveAllowedOrigins, isLoginEndpointPost, LOGIN_POST_METHOD } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import {
  closeLoginStage,
  createLoginStageResources,
  isLoginResultConditionPage,
  loginAttemptsExceeded,
  loginStageLocator,
  openLoginStagePage,
  readAuthenticatedState,
  waitOrAbort,
} from './login-stage-checks.js';

/** 結果を確かめる間隔（ms）。ページの中の読み取り（URL と要素の有無）だけで、サイトへの要求を増やさない。 */
export const AUTOMATED_LOGIN_POLL_INTERVAL_MS = 250;

/**
 * 値を入れた後、押す前に待つ時間（ms。T26g-1）。ページの JS が値の入力の事象で出そうとした要求を、Guard が送信の窓の中で止めて数えるのを
 * 待つ（止めた要求があれば、押さずに終える）。
 */
export const SUBMISSION_WINDOW_SETTLE_MS = 300;

/** 送信の窓の中で要求を止めたときの結果（T26g-1）。 */
const UNEXPECTED_LOGIN_REQUEST_RESULT = 'UNEXPECTED_LOGIN_REQUEST' satisfies AutomatedLoginFailureResult;

/** `Retry-After` のヘッダの名前。 */
const RETRY_AFTER_HEADER = 'retry-after';

/** 自動ログインの失敗の条件と、その結果（閉じた一覧どうしの対応）。 */
const FAILURE_CONDITION_RESULTS = Object.freeze({
  invalidCredentials: 'INVALID_CREDENTIALS',
  accountLocked: 'ACCOUNT_LOCKED',
  mfaRequired: 'MFA_REQUIRED',
  credentialExpired: 'CREDENTIAL_EXPIRED',
} as const satisfies Readonly<Record<AutomatedLoginFailureConditionKind, AutomatedLoginFailureResult>>);

/** 成功のほかの終わり方（自動ログインの結果の一覧と、Task 25 の `UNSUPPORTED_AUTH_STATE`）。 */
export type AutomatedLoginStageFailureKind = AutomatedLoginFailureResult | Extract<WorkerLoginFailureState, 'UNSUPPORTED_AUTH_STATE'>;

/** フォームの確かめで止まった結果（T26d-2: 理由のコードを持つ）。 */
const LOGIN_FORM_INVALID_KIND = 'LOGIN_FORM_INVALID' satisfies AutomatedLoginFailureResult;

/** 自動ログインの段の終わり方。 */
export type AutomatedLoginStageResult =
  | { readonly kind: 'AUTHENTICATED'; readonly state: AuthenticatedState }
  | {
    readonly kind: Exclude<AutomatedLoginStageFailureKind, typeof LOGIN_FORM_INVALID_KIND>;
    readonly submitted: AutomatedLoginSubmission;
    /** 429（`RATE_LIMITED`）のときだけ、次に試してよい時刻。ほかは `null`。 */
    readonly retryAfterUntil: Date | null;
    /** DEF-099 fix round 1: ログインの POST を送った後に、main frame の文書の応答がなかった。応答があれば（送っていなければ）項目なし。 */
    readonly responseAfterSubmission?: false;
  }
  | {
    readonly kind: typeof LOGIN_FORM_INVALID_KIND;
    readonly submitted: AutomatedLoginSubmission;
    readonly retryAfterUntil: null;
    /** フォームの確かめの理由のコード（入力の部品の閉じた一覧。T26d-2）。 */
    readonly formInvalidReason: LoginFormInvalidReason;
    /** DEF-099 fix round 1: 送った後に応答がなかった（ほかの成功以外の結果と同じ）。 */
    readonly responseAfterSubmission?: false;
  }
  | { readonly kind: 'STOPPED'; readonly submitted: AutomatedLoginSubmission; readonly responseAfterSubmission?: false };

/** 資格情報のファイルの、秘密でない項目のうち、確かめに使うもの。 */
export type AutomatedLoginCredentialMetadata = Pick<CredentialMetadata, 'credentialRevision' | 'loginOrigin'>;

/** 自動ログインの段の入力（ワーカーの流れが渡す。T26d-2）。 */
export interface AutomatedLoginStageRequest {
  /** 監査の設定（許可 Origin、ロケール、Desktop の幅を使う）。 */
  readonly config: AuditConfig;
  /** 親が検証した認証の設定（版 2。`automatedLogin` が null なら呼ぶ側の誤り）。 */
  readonly setup: AuthSetup;
  /** 状態を絞る Origin（プロファイルの `approvedTestOrigins`）。 */
  readonly approvedTestOrigins: readonly string[];
  /** 期待する資格情報の改訂の番号（`START` が渡す。秘密でない）。 */
  readonly expectedCredentialRevision: number;
  /** 資格情報のファイルの秘密でない項目を読む（ファイルがなければ `null`）。 */
  readonly readCredentialMetadata: () => Promise<AutomatedLoginCredentialMetadata | null>;
  /** 資格情報を復号する（フォームに値を入れる直前に 1 回だけ呼ぶ）。 */
  readonly readCredential: () => Promise<DecryptedCredential>;
  /** 止める印（`STOP`・Ctrl+C）。 */
  readonly signal: AbortSignal;
  /**
   * 読み込みの間隔を守る部品（DEF-102 fix。サイトへの負荷の手順書の「ページの読み込みの間隔」）。ワーカーの流れは、ログインの後のジョブと同じ
   * ものを渡す（ログインの段の最後の要求から、ジョブの最初の読み込みまで、設定の間隔以上空ける）。省略すると、設定の
   * `crawl.minNavigationIntervalMs` で、この段だけの部品を作る（ログインの画面の GET とログインの POST の間隔は守る）。
   */
  readonly navigationPacer?: NavigationPacer | undefined;
}

/** 自動ログインの段の依存（本番の値は T26d-2 の入口が渡す）。 */
export interface AutomatedLoginStageDependencies {
  /** ログイン用の Browser を起動する（本番は headless の CLI の起動の設定）。 */
  readonly launchAutomatedLoginBrowser: () => Promise<Browser>;
  /** 送信の後に結果を待つ時間（ms。省略すると `AUTO_LOGIN_RESULT_TIMEOUT_MS`）。 */
  readonly resultTimeoutMs?: number;
  /** 結果を確かめる間隔（ms。省略すると `AUTOMATED_LOGIN_POLL_INTERVAL_MS`）。 */
  readonly pollIntervalMs?: number;
  /** フォームを読む・値を入れる・送る、それぞれの時間の上限（ms。省略すると `LOGIN_FORM_STEP_TIMEOUT_MS`）。 */
  readonly formStepTimeoutMs?: number;
}

/** 送信の観測（要求と応答の事象から。値を持たない）。 */
interface SubmissionWatch {
  /** 送信先への main frame のナビゲーションの POST を見た。 */
  loginPostObserved: boolean;
  /** 送信の後に、main frame が新しい文書を開いた。 */
  documentCommittedAfterPost: boolean;
  /** 送信の後の、main frame のナビゲーションの最後の応答。 */
  lastDocumentResponse: Response | null;
}

const failed = (
  kind: Exclude<AutomatedLoginStageFailureKind, typeof LOGIN_FORM_INVALID_KIND>,
  submitted: AutomatedLoginSubmission,
  retryAfterUntil: Date | null = null,
): AutomatedLoginStageResult => ({ kind, submitted, retryAfterUntil });

/** フォームの確かめで止まった（値を入れていない、送信していない。T26d-2: 理由のコードを添える）。 */
const formInvalid = (formInvalidReason: LoginFormInvalidReason): AutomatedLoginStageResult =>
  ({ kind: LOGIN_FORM_INVALID_KIND, submitted: AUTOMATED_LOGIN_SUBMISSION_NONE, retryAfterUntil: null, formInvalidReason });

const stopped = (submitted: AutomatedLoginSubmission): AutomatedLoginStageResult => ({ kind: 'STOPPED', submitted });

/** main frame のナビゲーションの要求か（frame を読めない要求は、違うとみなす）。 */
const isMainFrameNavigation = (request: Request): boolean => {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false;
  }
};

/** 文書の応答の status から決まる結果（429 は `Retry-After` を読む）。決まらなければ `null`。 */
const statusOutcome = async (response: Response | null, submitted: AutomatedLoginSubmission): Promise<AutomatedLoginStageResult | null> => {
  if (response === null) {
    return null;
  }
  const status = response.status();
  if (status === TOO_MANY_REQUESTS_HTTP_STATUS) {
    const retryAfter = await response.headerValue(RETRY_AFTER_HEADER).catch(() => null);
    return failed(AUTOMATED_LOGIN_RATE_LIMITED_RESULT, submitted, retryAfterUntilDateOf(retryAfter, new Date()));
  }
  return isHttpStatusInRange(status, SERVER_ERROR_HTTP_STATUS_RANGE) ? failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submitted) : null;
};

/** 失敗の条件に当たったときの結果（T26d-2: 型を、条件の結果の 4 つに絞った）。 */
type FailureConditionResult = (typeof FAILURE_CONDITION_RESULTS)[AutomatedLoginFailureConditionKind];

/** 結果の条件の一覧（成功の条件と、null でない失敗の条件）。 */
const resultConditionsOf = (setup: AuthSetup, automated: AutomatedLoginSetup):
  readonly (readonly [typeof AUTOMATED_LOGIN_SUCCEEDED | FailureConditionResult, LoginResultCondition])[] => [
  [AUTOMATED_LOGIN_SUCCEEDED, setup.successCondition],
  ...AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS.flatMap((kind) => {
    const condition = automated.failureConditions[kind];
    return condition === null ? [] : [[FAILURE_CONDITION_RESULTS[kind], condition] as const];
  }),
];

/**
 * 自動ログインの段を行う（流れはファイルの先頭）。例外を投げない（呼ぶ側の誤りを除く）。どの終わり方でも、ログイン用の Context と Browser を
 * 閉じてから返す。DEF-099 fix round 1: ログインの POST を送った（観測した）後に main frame の文書の応答がなかった回は、成功以外の結果に
 * `responseAfterSubmission: false` を付ける（接続の断などで Chromium がログインの POST を自動で送り直しうるので、親が試しを 2 回と数える）。
 * 送り方は変えない。
 */
export async function runAutomatedLoginStage(
  request: AutomatedLoginStageRequest,
  dependencies: AutomatedLoginStageDependencies,
): Promise<AutomatedLoginStageResult> {
  const watch: SubmissionWatch = { loginPostObserved: false, documentCommittedAfterPost: false, lastDocumentResponse: null };
  const result = await runAutomatedLoginStageWith(request, dependencies, watch);
  if (result.kind === 'AUTHENTICATED' || !watch.loginPostObserved || watch.lastDocumentResponse !== null) {
    return result;
  }
  return { ...result, responseAfterSubmission: false };
}

/** 自動ログインの段の本体（送信の観測 `watch` を、呼び出し側と共有する）。 */
async function runAutomatedLoginStageWith(
  request: AutomatedLoginStageRequest,
  dependencies: AutomatedLoginStageDependencies,
  watch: SubmissionWatch,
): Promise<AutomatedLoginStageResult> {
  const { config, setup, approvedTestOrigins, signal } = request;
  const automated = setup.automatedLogin;
  if (automated === null) {
    throw new TypeError('The automated login stage requires the automatedLogin setting');
  }
  const resultTimeoutMs = resolveTimeoutMs(dependencies.resultTimeoutMs, AUTO_LOGIN_RESULT_TIMEOUT_MS);
  const pollIntervalMs = resolveTimeoutMs(dependencies.pollIntervalMs, AUTOMATED_LOGIN_POLL_INTERVAL_MS);
  const formStepTimeoutMs = resolveTimeoutMs(dependencies.formStepTimeoutMs, LOGIN_FORM_STEP_TIMEOUT_MS);
  if (signal.aborted) {
    return stopped(AUTOMATED_LOGIN_SUBMISSION_NONE);
  }

  // 1. 資格情報のファイルの、秘密でない項目の確かめ。
  let metadata: AutomatedLoginCredentialMetadata | null;
  try {
    metadata = await request.readCredentialMetadata();
  } catch {
    return failed('CREDENTIAL_UNAVAILABLE', AUTOMATED_LOGIN_SUBMISSION_NONE);
  }
  if (metadata === null) {
    return failed('CREDENTIAL_UNAVAILABLE', AUTOMATED_LOGIN_SUBMISSION_NONE);
  }
  const expectedLoginOrigin = loginOriginOf(setup.loginStartUrl);
  if (
    metadata.credentialRevision !== request.expectedCredentialRevision
    || expectedLoginOrigin === undefined
    || metadata.loginOrigin !== expectedLoginOrigin
  ) {
    return failed('CREDENTIAL_CHANGED', AUTOMATED_LOGIN_SUBMISSION_NONE);
  }
  if (signal.aborted) {
    return stopped(AUTOMATED_LOGIN_SUBMISSION_NONE);
  }

  const allowedOrigins = canonicalPassiveAllowedOrigins(new Set(config.site.allowedOrigins));
  /** click を呼んだか（呼んだ後は、送信を観測で決める）。 */
  let clicked = false;
  const submission = (): AutomatedLoginSubmission => {
    if (watch.loginPostObserved) {
      return AUTOMATED_LOGIN_SUBMISSION_SENT;
    }
    return clicked ? AUTOMATED_LOGIN_SUBMISSION_UNKNOWN : AUTOMATED_LOGIN_SUBMISSION_NONE;
  };
  // DEF-102 fix: ログインの画面の GET とログインの POST の前に、読み込みの間隔の待ちを通す。ログインの段の Guard は、送った時刻と応答を受けた
  // 時刻をこの部品に記録する（ワーカーの流れでは、ログインの後のジョブと同じ部品）。
  const pacer = request.navigationPacer
    ?? createNavigationPacer({ minIntervalMs: config.crawl.minNavigationIntervalMs, now: () => Date.now(), sleep: wait });
  const resources = createLoginStageResources();
  try {
    // 2. ログインの段の Context（回数の上限 1）で、ログインの画面を開く。
    const ledger = new SafetyLedger();
    const observeRequests = (context: BrowserContext): void => {
      context.on('request', (candidate: Request) => {
        if (
          candidate.method() === LOGIN_POST_METHOD
          && isMainFrameNavigation(candidate)
          && isLoginEndpointPost(candidate.url(), allowedOrigins, setup.loginPostEndpoints)
        ) {
          watch.loginPostObserved = true;
        }
      });
    };
    const { browser, context, page, monitor } = await openLoginStagePage(resources, {
      launchBrowser: dependencies.launchAutomatedLoginBrowser,
      config,
      ledger,
      loginPostEndpoints: setup.loginPostEndpoints,
      maxLoginPosts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
      onContextCreated: observeRequests,
      navigationPacer: pacer,
    });
    observeDocuments(page, watch);
    await pacer.beforeNavigation();
    if (signal.aborted) {
      return stopped(AUTOMATED_LOGIN_SUBMISSION_NONE);
    }
    const opened = await page.goto(setup.loginStartUrl).catch(() => null);
    const openedOutcome = await statusOutcome(opened, AUTOMATED_LOGIN_SUBMISSION_NONE);
    if (openedOutcome !== null) {
      return openedOutcome;
    }
    if (signal.aborted) {
      return stopped(submission());
    }
    if (watch.loginPostObserved) {
      // ページが自分で送信先へ POST した（値は入れていない）。BeakSight の送信は Guard の回数の上限で止まるので、結果は分からない。
      return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
    }

    // 3. フォームを読むだけで確かめる（値はまだ受け取らない）。
    const target: LoginFormTarget = {
      username: loginStageLocator(page, automated.usernameSelector),
      password: loginStageLocator(page, automated.passwordSelector),
      submit: loginStageLocator(page, automated.submitSelector),
      // T32j-4: 事前の確かめは、同じセレクタで isolated world の中で探し直す（入力と送信は上の Locator のまま）。
      selectors: { username: automated.usernameSelector, password: automated.passwordSelector, submit: automated.submitSelector },
      isAllowedAction: (actionUrl) => isLoginEndpointPost(actionUrl, allowedOrigins, setup.loginPostEndpoints),
    };
    const inspected = await inspectLoginForm(target, formStepTimeoutMs);
    if (!inspected.ok) {
      return formInvalid(inspected.reason);
    }

    // 4. ログインの POST の前の読み込みの間隔の待ち（DEF-102 fix。復号の前に待ち、資格情報の値を持つ時間を延ばさない。送信の窓も延ばさない）。
    //    復号し、改訂の番号を確かめ直す。
    await pacer.beforeNavigation();
    if (signal.aborted) {
      return stopped(AUTOMATED_LOGIN_SUBMISSION_NONE);
    }
    let credential: DecryptedCredential | null;
    try {
      credential = await request.readCredential();
    } catch {
      return failed('CREDENTIAL_UNAVAILABLE', AUTOMATED_LOGIN_SUBMISSION_NONE);
    }
    if (credential.credentialRevision !== request.expectedCredentialRevision) {
      credential = null;
      return failed('CREDENTIAL_CHANGED', AUTOMATED_LOGIN_SUBMISSION_NONE);
    }
    if (signal.aborted) {
      credential = null;
      return stopped(AUTOMATED_LOGIN_SUBMISSION_NONE);
    }

    // 5. 送信の窓を開いて入れ、参照を捨て、窓の中で止めた要求がないことと、フォームを確かめ直してから送る。窓を開いた後は、窓の中で止めた
    //    要求があれば、ほかの終わり方より先に `UNEXPECTED_LOGIN_REQUEST` にする（`unexpectedOr`）。
    const unexpectedOr = (otherwise: AutomatedLoginStageResult): AutomatedLoginStageResult =>
      (monitor.unexpectedRequestCount() > 0 ? failed(UNEXPECTED_LOGIN_REQUEST_RESULT, submission()) : otherwise);
    monitor.openSubmissionWindow();
    const filled = await fillLoginForm(target, credential, formStepTimeoutMs);
    credential = null;
    if (!filled.ok) {
      return unexpectedOr(failed('LOGIN_FORM_INPUT_FAILED', AUTOMATED_LOGIN_SUBMISSION_NONE));
    }
    await waitOrAbort(SUBMISSION_WINDOW_SETTLE_MS, signal);
    if (monitor.unexpectedRequestCount() > 0) {
      return failed(UNEXPECTED_LOGIN_REQUEST_RESULT, submission());
    }
    const reinspected = await inspectLoginForm(target, formStepTimeoutMs);
    if (!reinspected.ok) {
      return unexpectedOr(formInvalid(reinspected.reason));
    }
    if (signal.aborted) {
      return stopped(AUTOMATED_LOGIN_SUBMISSION_NONE);
    }
    clicked = true;
    const deadline = performance.now() + resultTimeoutMs;
    if (!(await clickLoginSubmit(target, formStepTimeoutMs)).ok) {
      return signal.aborted ? stopped(submission()) : unexpectedOr(failed('LOGIN_FORM_INPUT_FAILED', submission()));
    }

    // 6. 結果を待つ。
    const conditions = resultConditionsOf(setup, automated);
    const check = async (): Promise<AutomatedLoginStageResult | typeof AUTOMATED_LOGIN_SUCCEEDED | null> => {
      if (signal.aborted) {
        return stopped(submission());
      }
      // T26g-1: 送信の窓の中で、許した POST のほかの要求を止めた（ページが入力の値を別の要求で送ろうとした）。成功の条件より先に決める。
      if (monitor.unexpectedRequestCount() > 0) {
        return failed(UNEXPECTED_LOGIN_REQUEST_RESULT, submission());
      }
      if (isPassiveRequestGuardClosed(context) || !browser.isConnected() || page.isClosed()) {
        return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
      }
      // 送信先への POST を、BeakSight の送信のほかに Guard が止めた（2 回目の送信、サブ frame からの送信など）。BeakSight の送信を観測してから
      // 数える（観測の前に決めると、送信が分からないまま終わるため）。
      if (watch.loginPostObserved && loginAttemptsExceeded(ledger, allowedOrigins, setup)) {
        return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
      }
      const byStatus = await statusOutcome(watch.lastDocumentResponse, submission());
      if (byStatus !== null) {
        return byStatus;
      }
      if (watch.loginPostObserved && watch.documentCommittedAfterPost && await isDocumentParsed(page, pollIntervalMs)) {
        const matched: (typeof AUTOMATED_LOGIN_SUCCEEDED | FailureConditionResult)[] = [];
        for (const [kind, condition] of conditions) {
          if (await isLoginResultConditionPage(page, condition, approvedTestOrigins)) {
            matched.push(kind);
          }
        }
        const [only] = matched;
        if (matched.length === 1 && only !== undefined) {
          return only === AUTOMATED_LOGIN_SUCCEEDED ? only : failed(only, submission());
        }
      }
      return performance.now() >= deadline ? failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission()) : null;
    };
    let outcome = await check();
    while (outcome === null) {
      await waitOrAbort(Math.max(0, Math.min(pollIntervalMs, deadline - performance.now())), signal);
      outcome = await check();
    }
    if (outcome !== AUTOMATED_LOGIN_SUCCEEDED) {
      return outcome;
    }

    // 7. 成功: 状態をメモリに取り、許可 Origin だけに絞る（ファイルに書かない）。返す直前にも、窓の中で止めた要求がないことを確かめる。
    const state = await readAuthenticatedState(context, approvedTestOrigins);
    return unexpectedOr(state === null ? failed('UNSUPPORTED_AUTH_STATE', submission()) : { kind: 'AUTHENTICATED', state });
  } catch {
    // 起動・Context の作成・Guard の準備・状態の取り出しの失敗など。誤りの文は使わない（値を含みうる）。
    return signal.aborted ? stopped(submission()) : failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
  } finally {
    await closeLoginStage(resources);
  }
}

/** main frame の今の文書を読み終えたか（DOMContentLoaded。`waitMs` まで待つ。失敗は「まだ」）。 */
const isDocumentParsed = (page: Page, waitMs: number): Promise<boolean> =>
  page.waitForLoadState('domcontentloaded', { timeout: waitMs }).then(() => true, () => false);

/** 送信の後の、main frame の文書の応答と、新しい文書を開いたことを観測する（送信の前の事象は数えない）。 */
function observeDocuments(page: Page, watch: SubmissionWatch): void {
  page.on('response', (response: Response) => {
    if (watch.loginPostObserved && isMainFrameNavigation(response.request())) {
      watch.lastDocumentResponse = response;
    }
  });
  page.on('framenavigated', (frame) => {
    if (watch.loginPostObserved && frame === page.mainFrame()) {
      watch.documentCommittedAfterPost = true;
    }
  });
}
