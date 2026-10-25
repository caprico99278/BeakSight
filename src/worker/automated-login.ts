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
import { SUCCESS_HTTP_STATUS_RANGE, isHttpStatusInRange } from '../core/http-status.js';
import {
  AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS,
  AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  SCRIPT_REQUEST_TRANSPORT,
  loginTransportOf,
  type AuthSetup,
  type AutomatedLoginFailureConditionKind,
  type AutomatedLoginSetup,
  type LoginResultCondition,
} from '../control/auth/auth-setup-contracts.js';
import type { AuthenticatedState, LoginStateNameRecord } from '../control/auth/authenticated-state.js';
import {
  AUTOMATED_LOGIN_RATE_LIMITED_RESULT,
  AUTOMATED_LOGIN_SUBMISSION_NONE,
  AUTOMATED_LOGIN_SUBMISSION_SENT,
  AUTOMATED_LOGIN_SUBMISSION_UNKNOWN,
  AUTOMATED_LOGIN_SUCCEEDED,
  AUTOMATED_LOGIN_UNKNOWN_RESULT,
  loginHttpStatusResultOf,
  loginOriginOf,
  type AutomatedLoginFailureResult,
  type AutomatedLoginSubmission,
} from '../control/auth/automated-login-results.js';
import { AUTO_LOGIN_RESULT_TIMEOUT_MS, retryAfterUntilDateOf } from '../control/auth/automated-login-timing.js';
import type { CredentialMetadata, DecryptedCredential } from '../control/credentials/credential-store.js';
import type {
  WorkerLoginFailureState,
  WorkerLoginObservation,
  WorkerLoginStageBlockedRequests,
  WorkerScriptLoginCounts,
} from '../control/worker-protocol.js';
import { resolveTimeoutMs, wait } from '../core/deadline.js';
import { createNavigationPacer, type NavigationPacer } from '../crawl/navigation-pacer.js';
import {
  armLoginCredentialGuard,
  carriesLoginCredentialInState,
  carriesLoginCredentialInTexts,
  createPendingLoginCredentialGuard,
} from '../safety/login-credential-guard.js';
import { RETRY_AFTER_HEADER } from '../safety/http-headers.js';
import { isPassiveRequestGuardClosed, type LoginStageMonitor } from '../safety/passive-request-guard.js';
import type { TokenResponseObservation } from '../safety/token-response-observation.js';
import { canonicalPassiveAllowedOrigins, isLoginEndpointPost, LOGIN_POST_METHOD } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import {
  closeLoginStage,
  createLoginStageResources,
  isLoginResultConditionPage,
  LOGIN_BROWSER_LAUNCH_REFUSED,
  loginAttemptsExceeded,
  loginBrowserLaunchRefusalOf,
  loginStageBlockedRequestsOf,
  type LoginBrowserLaunchRefusal,
  loginStageGuardOf,
  loginStageLocator,
  meetsSuccessStateCondition,
  openLoginStagePage,
  readAuthenticatedState,
  scriptLoginCountsOf,
  waitOrAbort,
} from './login-stage-checks.js';
import { observeLoginPageStart, observeLoginStageEnd } from './login-stage-observation.js';

/** 結果を確かめる間隔（ms）。ページの中の読み取り（URL と要素の有無）だけで、サイトへの要求を増やさない。 */
export const AUTOMATED_LOGIN_POLL_INTERVAL_MS = 250;

/**
 * 値を入れた後、押す前に待つ時間（ms。T26g-1）。ページの JS が値の入力の事象で出そうとした要求を、Guard が送信の窓の中で止めて数えるのを
 * 待つ（止めた要求があれば、押さずに終える）。
 */
export const SUBMISSION_WINDOW_SETTLE_MS = 300;

/** 送信の窓の中で要求を止めたときの結果（T26g-1）。 */
const UNEXPECTED_LOGIN_REQUEST_RESULT = 'UNEXPECTED_LOGIN_REQUEST' satisfies AutomatedLoginFailureResult;

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

/**
 * T36c: スクリプトで送るログインの自動ログインの段の結果に添える、ログインの段の数（`scriptLogin`）と止めた読み取りでない要求の一覧
 * （`blockedRequests`）。フォームの送信の自動ログインでは、どちらもない。数と Origin・path だけで、値・本文・query を持たない。
 */
export interface AutomatedLoginStageCounts {
  readonly scriptLogin?: WorkerScriptLoginCounts;
  readonly blockedRequests?: WorkerLoginStageBlockedRequests;
  /** T43d: 結果を待った後の観察（`login-stage-observation.ts`。観察したことがあったときだけ）。 */
  readonly loginObservation?: WorkerLoginObservation;
  /**
   * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: ログインの後のブラウザの状態の名前の記録（値を持たない）。状態を読んだ
   * ときだけ（最後に読んだもの）。
   */
  readonly stateNames?: LoginStateNameRecord;
}

/** ログインの段の記録の受け取り（段の本体が書き、呼び出し側が結果に添える）。 */
interface AutomatedLoginRecorder {
  monitor: LoginStageMonitor | null;
  /** T43d: 結果を待った後の観察。 */
  observation: WorkerLoginObservation | undefined;
  /** DEF-139: 最後に読んだ状態の名前の記録。 */
  stateNames: LoginStateNameRecord | undefined;
}

/** 自動ログインの段の終わり方。 */
export type AutomatedLoginStageResult = AutomatedLoginStageCounts & AutomatedLoginStageOutcome;

/** 自動ログインの段の終わり方の本体（数を除く）。 */
type AutomatedLoginStageOutcome =
  | { readonly kind: 'AUTHENTICATED'; readonly state: AuthenticatedState }
  | {
    readonly kind: Exclude<AutomatedLoginStageFailureKind, typeof LOGIN_FORM_INVALID_KIND>;
    readonly submitted: AutomatedLoginSubmission;
    /** 429（`RATE_LIMITED`）のときだけ、次に試してよい時刻。ほかは `null`。 */
    readonly retryAfterUntil: Date | null;
    /** DEF-099 fix round 1: ログインの POST を送った後に、main frame の文書の応答がなかった。応答があれば（送っていなければ）項目なし。 */
    readonly responseAfterSubmission?: false;
  }
  // EL-3: ログイン用の Browser を、起動の部品が閉じた理由で断った（ワーカーの中だけ。ログインの画面を開いていない。送信していない）。
  | { readonly kind: typeof LOGIN_BROWSER_LAUNCH_REFUSED; readonly refusal: LoginBrowserLaunchRefusal }
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
  /** T36c: プロファイルの承認したサービスの Origin（スクリプトで送るログインの口に渡す。省略は空）。 */
  readonly approvedServiceOrigins?: readonly string[] | undefined;
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
): AutomatedLoginStageOutcome => ({ kind, submitted, retryAfterUntil });

/** フォームの確かめで止まった（値を入れていない、送信していない。T26d-2: 理由のコードを添える）。 */
const formInvalid = (formInvalidReason: LoginFormInvalidReason): AutomatedLoginStageOutcome =>
  ({ kind: LOGIN_FORM_INVALID_KIND, submitted: AUTOMATED_LOGIN_SUBMISSION_NONE, retryAfterUntil: null, formInvalidReason });

const stopped = (submitted: AutomatedLoginSubmission): AutomatedLoginStageOutcome => ({ kind: 'STOPPED', submitted });

/**
 * T36c（Task 36 の設計書 3.4 の表）: token の送信の応答の状態から決まる結果。2xx は `SUCCESS_STATUS`（成功の確かめに進む）、まだ応答がない（token の送信を
 * 通していないか、待っている）は `PENDING`。T36R-fix（T36R の M-5）: 400・401・423・429・5xx・ほかの状態の対応は、form の文書の応答と同じ 1 つの表
 * （`loginHttpStatusResultOf`。`automated-login-results.ts`）。
 */
const tokenResponseOutcome = (
  observation: TokenResponseObservation | undefined,
  submitted: AutomatedLoginSubmission,
): AutomatedLoginStageOutcome | 'SUCCESS_STATUS' | 'PENDING' => {
  if (observation === undefined || observation.state === 'PENDING') {
    return 'PENDING';
  }
  const { status } = observation;
  if (observation.state === 'FAILED' || status === null) {
    return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submitted);
  }
  if (isHttpStatusInRange(status, SUCCESS_HTTP_STATUS_RANGE)) {
    return 'SUCCESS_STATUS';
  }
  // 表にない状態と 5xx は、結果が分からない（止める）。
  const result = loginHttpStatusResultOf(status, 'TOKEN_RESPONSE') ?? AUTOMATED_LOGIN_UNKNOWN_RESULT;
  return result === AUTOMATED_LOGIN_RATE_LIMITED_RESULT
    ? failed(result, submitted, retryAfterUntilDateOf(observation.retryAfter, new Date()))
    : failed(result, submitted);
};

/** main frame のナビゲーションの要求か（frame を読めない要求は、違うとみなす）。 */
const isMainFrameNavigation = (request: Request): boolean => {
  try {
    return request.isNavigationRequest() && request.frame().parentFrame() === null;
  } catch {
    return false;
  }
};

/**
 * 文書の応答の status から決まる結果（429 は `Retry-After` を読む）。決まらなければ `null`。T36R-fix（T36R の M-5）: 対応は token の送信の応答と同じ
 * 1 つの表（`loginHttpStatusResultOf`。文書の応答では 429 と 5xx だけ）。
 */
const statusOutcome = async (response: Response | null, submitted: AutomatedLoginSubmission): Promise<AutomatedLoginStageOutcome | null> => {
  if (response === null) {
    return null;
  }
  const result = loginHttpStatusResultOf(response.status(), 'DOCUMENT_RESPONSE');
  if (result === AUTOMATED_LOGIN_RATE_LIMITED_RESULT) {
    // Playwright の `headerValue` は、名前の大文字と小文字を区別しない。
    const retryAfter = await response.headerValue(RETRY_AFTER_HEADER).catch(() => null);
    return failed(result, submitted, retryAfterUntilDateOf(retryAfter, new Date()));
  }
  return result === null ? null : failed(result, submitted);
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
  const recorder: AutomatedLoginRecorder = { monitor: null, observation: undefined, stateNames: undefined };
  const outcome = await runAutomatedLoginStageWith(request, dependencies, watch, recorder);
  // T36c: スクリプトで送るログインでは、ログインの段の数と止めた一覧を添える（ログインの段を開いた場合だけ）。
  const scriptLogin = recorder.monitor === null ? undefined : scriptLoginCountsOf(recorder.monitor, request.setup);
  const blockedRequests = recorder.monitor === null || scriptLogin === undefined ? undefined : loginStageBlockedRequestsOf(recorder.monitor);
  const result: AutomatedLoginStageResult = {
    ...outcome,
    ...(scriptLogin === undefined ? {} : { scriptLogin }),
    ...(blockedRequests === undefined ? {} : { blockedRequests }),
    // T43d: 結果を待った後の観察（成功の鍵の名前の案と、成功のときの成功の画面のセレクタの案。ログインの送り方によらない）。
    ...(recorder.observation === undefined ? {} : { loginObservation: recorder.observation }),
    // DEF-139: 状態の名前の記録（状態を読んだときだけ）。
    ...(recorder.stateNames === undefined ? {} : { stateNames: recorder.stateNames }),
  };
  // T36R-fix（T36R の M-4。DEF-099 の印）: スクリプトで送るログインで token を送り、その応答がなかった（`FAILED`）か、まだない（`PENDING`）回は、
  // 送った後に応答がなかった印を付ける（Chromium が送り直しうるので、親が試しを 2 回と数える）。
  const lastTokenResponse = recorder.monitor === null || scriptLogin === undefined ? undefined : recorder.monitor.tokenResponses().at(-1);
  const tokenUnanswered = lastTokenResponse !== undefined && lastTokenResponse.state !== 'RESPONDED';
  if (
    result.kind === 'AUTHENTICATED'
    || result.kind === LOGIN_BROWSER_LAUNCH_REFUSED
    || (!tokenUnanswered && (!watch.loginPostObserved || watch.lastDocumentResponse !== null))
  ) {
    return result;
  }
  return { ...result, responseAfterSubmission: false };
}

/** 自動ログインの段の本体（送信の観測 `watch` と、ログインの段の記録の受け取り `recorder` を、呼び出し側と共有する）。 */
async function runAutomatedLoginStageWith(
  request: AutomatedLoginStageRequest,
  dependencies: AutomatedLoginStageDependencies,
  watch: SubmissionWatch,
  recorder: AutomatedLoginRecorder,
): Promise<AutomatedLoginStageOutcome> {
  const { config, setup, approvedTestOrigins, signal } = request;
  const approvedServiceOrigins = request.approvedServiceOrigins ?? [];
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
  // T36c: ログインの送り方ごとの Guard の口（唯一の対応 `loginStageGuardOf`）。スクリプトで送るログインでは、資格情報の守りの部品（待ちの形）も渡す。
  const guard = loginStageGuardOf(setup, request.approvedServiceOrigins ?? []);
  const script = loginTransportOf(setup) === SCRIPT_REQUEST_TRANSPORT && guard.scriptRequest !== undefined;
  const credentialGuard = script ? createPendingLoginCredentialGuard() : undefined;
  // T43R-fix の C-1 (c): 観察の案（鍵の名前の接頭辞と接尾辞、セレクタ）を入れた資格情報と照らす部品（スクリプトで送るログインは Guard と同じ部品。
  // フォームの送信は照らすだけの部品で、Guard には渡さない）。値を入れる前と捨てた後は、どの案も含むとみなす（案を出さない）。
  const observationGuard = credentialGuard ?? createPendingLoginCredentialGuard();
  /** click を呼んだか（呼んだ後は、送信を観測で決める）。 */
  let clicked = false;
  const submission = (): AutomatedLoginSubmission => {
    const { monitor } = recorder;
    if (script && monitor !== null) {
      // T36c: Guard が token の送信を通したかで決める。資格情報を含む要求を止めたら、送ったかは分からない（自動ログインを止める）。
      if (monitor.snapshot().scriptRequest.tokenRequestsAllowed >= 1) {
        return AUTOMATED_LOGIN_SUBMISSION_SENT;
      }
      return monitor.credentialRequestsBlocked() >= 1 ? AUTOMATED_LOGIN_SUBMISSION_UNKNOWN : AUTOMATED_LOGIN_SUBMISSION_NONE;
    }
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
      loginPostEndpoints: guard.loginPostEndpoints,
      maxLoginPosts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
      ...(guard.scriptRequest === undefined ? {} : { scriptRequest: guard.scriptRequest }),
      ...(credentialGuard === undefined ? {} : { credentialGuard }),
      onContextCreated: observeRequests,
      navigationPacer: pacer,
    });
    recorder.monitor = monitor;
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
    if (watch.loginPostObserved || (script && monitor.snapshot().scriptRequest.tokenRequestsAllowed >= 1)) {
      // ページが自分で送信先へ POST した（スクリプトで送るログインでは、token を送った）。値は入れていない。BeakSight の送信は Guard の回数の上限で
      // 止まるので、結果は分からない。
      return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
    }
    // T43d: ログインの画面の鍵の名前と、要素の候補の CSS を読む（値を読まない。値を入れる前）。結果を待った後に、終わりの観察をする（`observed`）。
    const baseline = await observeLoginPageStart(page, setup.loginStartUrl);
    const observed = async (result: AutomatedLoginStageOutcome): Promise<AutomatedLoginStageOutcome> => {
      // 止める要求ですぐに終えるため、止めたときは観察しない。
      if (!signal.aborted && result.kind !== 'STOPPED') {
        recorder.observation = await observeLoginStageEnd(page, baseline, result.kind === 'AUTHENTICATED',
          (texts) => carriesLoginCredentialInTexts(observationGuard, texts));
      }
      return result;
    };

    // 3. フォームを読むだけで確かめる（値はまだ受け取らない）。
    const target: LoginFormTarget = {
      username: loginStageLocator(page, automated.usernameSelector),
      password: loginStageLocator(page, automated.passwordSelector),
      submit: loginStageLocator(page, automated.submitSelector),
      // T32j-4: 事前の確かめは、同じセレクタで isolated world の中で探し直す（入力と送信は上の Locator のまま）。
      selectors: { username: automated.usernameSelector, password: automated.passwordSelector, submit: automated.submitSelector },
      isAllowedAction: (actionUrl) => isLoginEndpointPost(actionUrl, allowedOrigins, setup.loginPostEndpoints),
      // T36c: スクリプトで送るログインでは、form の method と action を確かめない（T36a）。
      submission: script ? SCRIPT_REQUEST_TRANSPORT : 'FORM_NAVIGATION',
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
    //    T36c: スクリプトで送るログインでは、窓を開かない（token の送信を通した時点で Guard が開く）。入れる直前に資格情報の守りの部品に値を入れ、
    //    資格情報を含む要求を止めたら、ほかの終わり方より先に `AUTH_RESULT_UNKNOWN` にする（設計者の判断 3）。
    const unexpectedOr = (otherwise: AutomatedLoginStageOutcome): AutomatedLoginStageOutcome => {
      if (script) {
        return monitor.credentialRequestsBlocked() > 0 ? failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission()) : otherwise;
      }
      return monitor.unexpectedRequestCount() > 0 ? failed(UNEXPECTED_LOGIN_REQUEST_RESULT, submission()) : otherwise;
    };
    if (credentialGuard === undefined) {
      monitor.openSubmissionWindow();
    } else {
      armLoginCredentialGuard(credentialGuard, credential);
    }
    // T43R-fix の C-1 (c): フォームの送信では、観察の案を照らすだけの部品にも値を入れる（Guard には渡さない。スクリプトで送るログインは同じ部品を使う）。
    if (observationGuard !== credentialGuard) {
      armLoginCredentialGuard(observationGuard, credential);
    }
    const filled = await fillLoginForm(target, credential, formStepTimeoutMs);
    credential = null;
    if (!filled.ok) {
      return unexpectedOr(failed('LOGIN_FORM_INPUT_FAILED', AUTOMATED_LOGIN_SUBMISSION_NONE));
    }
    await waitOrAbort(SUBMISSION_WINDOW_SETTLE_MS, signal);
    if (!script && monitor.unexpectedRequestCount() > 0) {
      return failed(UNEXPECTED_LOGIN_REQUEST_RESULT, submission());
    }
    if (script && monitor.credentialRequestsBlocked() > 0) {
      return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
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
    /** 成功の条件と失敗の条件のうち、今の画面に当たるもの。 */
    const matchedConditions = async (): Promise<readonly (typeof AUTOMATED_LOGIN_SUCCEEDED | FailureConditionResult)[]> => {
      const matched: (typeof AUTOMATED_LOGIN_SUCCEEDED | FailureConditionResult)[] = [];
      for (const [kind, condition] of conditions) {
        if (await isLoginResultConditionPage(page, condition, approvedTestOrigins)) {
          matched.push(kind);
        }
      }
      return matched;
    };
    /**
     * T36c: スクリプトで送るログインの結果の確かめ（ファイルの先頭の T36c の結果）。成功なら、取り出した状態を返す（成功の状態の側の条件
     * `meetsSuccessStateCondition` を満たすときだけ）。
     */
    const checkScript = async (): Promise<AutomatedLoginStageOutcome | null> => {
      if (signal.aborted) {
        return stopped(submission());
      }
      if (monitor.credentialRequestsBlocked() > 0) {
        return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
      }
      if (isPassiveRequestGuardClosed(context) || !browser.isConnected() || page.isClosed() || monitor.tokenRequestsBlockedOverLimit() > 0) {
        return failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission());
      }
      const byResponse = tokenResponseOutcome(monitor.tokenResponses().at(-1), submission());
      if (typeof byResponse === 'object') {
        return byResponse;
      }
      if (byResponse === 'SUCCESS_STATUS' && await isDocumentParsed(page, pollIntervalMs)) {
        const matched = await matchedConditions();
        const [only] = matched;
        if (matched.length === 1 && only !== undefined && only !== AUTOMATED_LOGIN_SUCCEEDED) {
          return failed(only, submission());
        }
        if (matched.length === 1 && only === AUTOMATED_LOGIN_SUCCEEDED) {
          const reading = await readAuthenticatedState(context, approvedTestOrigins, approvedServiceOrigins);
          // DEF-139: 最後に読んだ状態の名前の記録（値を持たない）を残す。
          recorder.stateNames = reading.names;
          const { state } = reading;
          if (state !== null && meetsSuccessStateCondition(state, setup, monitor)) {
            // 返す直前にも、資格情報を含む要求を止めていないことを確かめる（設計者の判断 3）。T36R-fix（T36R の C-4）: 引き継ぐ状態（Cookie の名前と値、
            // ローカル ストレージの鍵と値）にパスワードが含まれていれば、状態を返さずに止める（比べは資格情報の守りの部品の口。監査の段に持ち越さない）。
            const carried = credentialGuard === undefined || carriesLoginCredentialInState(credentialGuard, state);
            return monitor.credentialRequestsBlocked() > 0 || carried
              ? failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission())
              : { kind: 'AUTHENTICATED', state };
          }
        }
      }
      return performance.now() >= deadline ? failed(AUTOMATED_LOGIN_UNKNOWN_RESULT, submission()) : null;
    };
    if (script) {
      let scriptOutcome = await checkScript();
      while (scriptOutcome === null) {
        await waitOrAbort(Math.max(0, Math.min(pollIntervalMs, deadline - performance.now())), signal);
        scriptOutcome = await checkScript();
      }
      // `finally` で閉じる前に観察を終える（`await` してから返す）。
      return await observed(scriptOutcome);
    }
    const check = async (): Promise<AutomatedLoginStageOutcome | typeof AUTOMATED_LOGIN_SUCCEEDED | null> => {
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
        const matched = await matchedConditions();
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
      return await observed(outcome);
    }

    // 7. 成功: 状態をメモリに取り、許可 Origin だけに絞る（ファイルに書かない）。返す直前にも、窓の中で止めた要求がないことを確かめる。
    const reading = await readAuthenticatedState(context, approvedTestOrigins, approvedServiceOrigins);
    // DEF-139: 状態の名前の記録（値を持たない）を残す。
    recorder.stateNames = reading.names;
    const { state } = reading;
    return await observed(unexpectedOr(state === null ? failed('UNSUPPORTED_AUTH_STATE', submission()) : { kind: 'AUTHENTICATED', state }));
  } catch (error) {
    // 起動・Context の作成・Guard の準備・状態の取り出しの失敗など。誤りの文は使わない（値を含みうる）。
    // EL-3: 起動の部品が閉じた理由で断ったときは（ログインの画面を開く前なので、送信していない）、その理由で終える。
    const refusal = loginBrowserLaunchRefusalOf(error);
    if (refusal !== null && !signal.aborted) {
      return { kind: LOGIN_BROWSER_LAUNCH_REFUSED, refusal };
    }
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
