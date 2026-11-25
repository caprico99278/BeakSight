import {
  PATH_NORMALIZATION_BASE,
  auditScopePathFormsOf,
  exclusionMatchPathFormsOf,
  fullyPercentDecoded,
  isInsideAuditScope,
} from '../core/audit-exclusion-forms.js';
import { comparableExclusionValues, hitsDangerousTermIn, hitsExcludedPathPrefix } from '../core/audit-exclusion-match.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../core/record-id-path-pattern.js';
import { REDACTED_PATH_SEGMENT } from '../core/url-path-redaction.js';
import { API_METHOD_OVERRIDE_HEADER_NAMES, API_WRITE_METHODS, pathShapeEndsWithRecordId } from '../core/api-request-shape.js';
import { headerValueOf } from './http-headers.js';
import { LOGIN_CREDENTIAL_BLOCK_REASON, type RequestBodyText } from './login-credential-guard.js';
import { isReferencedRefreshBody, type FrozenRefreshReference } from '../core/session-key-values.js';
import type { BLOCKED_AUDIT_EXCLUSION_REASONS, BLOCKED_REQUEST_REASONS } from '../core/evidence-types.js';
import { foldNfkcCase } from '../core/text.js';
import { canonicalizeAllowedOrigins, hasUrlCredentials } from '../crawl/normalize-url.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../core/default-excluded-url-words.js';
import { isSecretUrlQueryParameterName } from '../core/secret-query-names.js';
import { urlHasDestructiveWord } from '../discovery/destructive-action.js';

/**
 * 要求の種類の閉じた一覧（T34b。Task 34 の設計書 3.3）。CDP の `Network.ResourceType` と、Playwright の `Request.resourceType()` の値を、
 * 小文字にした形。正規化は `requestResourceTypeOf` だけが行う（知らない値は `other`）。
 */
export const REQUEST_RESOURCE_TYPES = Object.freeze([
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'fedcm',
  'other',
] as const);
export type RequestResourceType = (typeof REQUEST_RESOURCE_TYPES)[number];

/** 正規化できない要求の種類（知らない値、文字列でない値、省略）。 */
const UNKNOWN_RESOURCE_TYPE: RequestResourceType = 'other';

/**
 * スクリプトの送信の種類（T34b）。ログインの段のスクリプトの token の送信と、ログインに伴う送信は、この種類の要求だけを通す（document・ping
 * （beacon）・other などの POST は、送信先が同じでも止める。設計書 4 章）。
 */
export const SCRIPT_REQUEST_RESOURCE_TYPES = Object.freeze(['fetch', 'xhr'] as const satisfies readonly RequestResourceType[]);

/** 要求の種類を閉じた一覧に正規化する（T34b。CDP の事象の値も route の要求の値も、小文字にして一覧と比べる。ない値は `other`）。 */
export function requestResourceTypeOf(value: unknown): RequestResourceType {
  if (typeof value !== 'string') {
    return UNKNOWN_RESOURCE_TYPE;
  }
  const lower = value.toLowerCase();
  return REQUEST_RESOURCE_TYPES.find((type) => type === lower) ?? UNKNOWN_RESOURCE_TYPE;
}

/**
 * 要求の種類を返す口（Playwright の `Request.resourceType()`）を持ちうる値から、閉じた一覧の種類を読む（DEF-120。Guard が要求の種類を読む唯一の口）。
 * 口が関数でない、呼ぶと投げる、文字列を返さない、のどれでも `other`（スクリプトの送信としては通さない。fail-closed）。投げない。
 */
export function requestResourceTypeOfRequest(request: unknown): RequestResourceType {
  if (typeof request !== 'object' || request === null) {
    return UNKNOWN_RESOURCE_TYPE;
  }
  try {
    const read: unknown = (request as { readonly resourceType?: unknown }).resourceType;
    return typeof read === 'function' ? requestResourceTypeOf(read.call(request)) : UNKNOWN_RESOURCE_TYPE;
  } catch {
    return UNKNOWN_RESOURCE_TYPE;
  }
}

/** スクリプトの送信の種類（fetch か xhr）か。省略は、スクリプトの送信ではない（fail-closed）。 */
const isScriptRequestResourceType = (type: RequestResourceType | undefined): boolean =>
  (SCRIPT_REQUEST_RESOURCE_TYPES as readonly (RequestResourceType | undefined)[]).includes(type);

export interface HttpRequestFacts {
  readonly kind: 'HTTP';
  readonly method: string;
  readonly url: string;
  readonly isNavigationRequest: boolean;
  readonly isMainFrame: boolean;
  /**
   * 要求の種類（T34b。`requestResourceTypeOf` で正規化した値）。Guard の CDP の層・route の層・`requestfailed` の判定と、出口の中継が渡す。
   * 使うのは、ログインの段のスクリプトで送るログインの口（`scriptRequest`）だけ。省略は `other` と同じ（スクリプトの送信としては通さない）。
   */
  readonly resourceType?: RequestResourceType | undefined;
  /**
   * T39b: 要求が、page の main frame のページのスクリプトが送ったものか（Guard の CDP の要求の層が、同じ session の `Network.requestWillBeSent` の
   * frame と開始の種類（`script`）で決めて渡す。Worker・iframe・ブラウザの送信は偽）。使うのは、API の書き込みの段の口（`WriteStagePolicy.apiOrigin`）
   * だけ。省略は偽と同じ。
   */
  readonly mainFrameScript?: boolean | undefined;
  /**
   * AS-c fix round 1（I-2）: 要求の送る中身（ヘッダと本文）。SD-2: 使うのは、凍結の段の読み取りと token の更新の判定の method の上書きの確かめ
   * （`isDeleteRequest`・`isDeleteHeaderOverride`。守り 2）だけ。Guard の CDP の層・route の層・`requestfailed` の判定が渡す。省略は上書きなしと同じ（出口の
   * 中継は渡さない。Guard が先に止める）。
   */
  readonly sentContent?: RequestSentContent | undefined;
  /**
   * L12b: リダイレクトの続きの要求か（Guard の CDP の層の文書の要求が渡す。307・308 は前の要求の本文を送り直す）。書き込みの段の押した後の扱い
   * （`writeStageAfterPressDecisionOf`）は、リダイレクトの続きの読み取りでない要求を通さない（承認した送信の本文の送り直しを、ページの送信として通さない）。
   * 省略は偽と同じ。
   */
  readonly redirectReplay?: boolean | undefined;
}

/**
 * AS-c fix round 1（I-2）: 要求の送る中身。`headers` は要求のヘッダ（名前の大文字と小文字は問わない）。`formMethodOverrides` は、form の本文（urlencoded と
 * multipart）の method の上書きの欄（`_method`）の値を読む関数（本文を読むのは owner の `formMethodOverrideValuesOf` だけ。Gate `write-stage-boundary` の
 * (b)。form でなければ空、form の本文が読めない・形が崩れていれば `null`）。判定のときだけ呼ぶ。
 */
export interface RequestSentContent {
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly formMethodOverrides: () => readonly string[] | null;
}

export interface WebSocketRequestFacts {
  readonly kind: 'WEBSOCKET';
  readonly url: string;
}

export type PassiveRequestFacts = HttpRequestFacts | WebSocketRequestFacts;

export type PassiveRequestDecision =
  | {
    readonly action: 'ALLOW';
    readonly delivery: 'DIRECT' | 'INSPECT_REDIRECTS';
    /**
     * T34b: スクリプトで送るログインの段の口が通した理由（token の送信、ログインに伴う送信の何番目か、サービスの Origin への読み取り）。Guard が
     * 回数を減らし、ログインの段の記録に数えるために使う。ほかの ALLOW には付けない（項目そのものがない）。
     */
    readonly loginStageAdmission?: LoginStageAdmission;
    /**
     * T35b: スクリプトで送るログインの監査の段の口が通した理由（登録した読み取りの手続きの呼び出しの何番目か、承認したサービスの Origin への読み取り）。
     * Guard が回数を減らし、サービスの Origin への要求を数えるために使う。ほかの ALLOW には付けない（項目そのものがない）。
     */
    readonly auditStageAdmission?: AuditStageAdmission;
    /**
     * T39b: API の書き込みの段の口が、照合にかける要求として通した（`isAllowedApiWrite`）。Guard が続けて `checkApiWritePayload` で照らし、一致した
     * 1 回だけを送り手の口に渡す（ブラウザには送らせない）。ほかの ALLOW には付けない（項目そのものがない）。
     */
    readonly writeStageApiWrite?: true;
    /**
     * ML-a: 手動のログインの段の口（`LoginStagePolicy.manualPassThrough`）が、今の決まりなら止める要求を通した。`reason` は、読み取りでない要求なら、通さなければ
     * 止めた理由（`NON_READ_METHOD` か、スクリプトで送るログインの詳しい理由）、読み取りなら `null`。Guard は、読み取りでない要求の形を、ログインの段で
     * 通した送信の一覧に記録し、回数に数えない。ほかの ALLOW には付けない（項目そのものがない）。
     */
    readonly manualLoginPassThrough?: { readonly reason: ManualLoginPassThroughReason | null };
    /**
     * DEF-193: 自動ログインの段の口（`LoginStagePolicy.automatedPassThrough`）が、今の決まりなら止める読み取りでない要求を通した。`reason` は、通さなければ止めた
     * 理由。Guard は、回数（`maxLoginPosts`）に数えず、要求の形を通した送信の一覧に記録し、中継へ通した要求の写しを渡す。ほかの ALLOW には付けない。
     */
    readonly automatedLoginPassThrough?: { readonly reason: AutomatedLoginPassThroughReason };
    /**
     * AS-a: 監査の段の送信の扱いの口（`PassiveRequestPolicyOptions.auditSend`）が、今の決まりなら止める読み取りでない要求を通した。Guard が、その読み込み
     * （Context）で通した数を数え、Safety Ledger の通した要求の記録に残すために使う。ほかの ALLOW には付けない（項目そのものがない）。
     */
    readonly auditSendAdmission?: true;
    /**
     * AS-c: 監査の段の送信の扱いの口が、今の決まりなら止める WebSocket の接続を通した。Guard が、その読み込みで通した接続の数を数え、Safety Ledger の通した
     * 接続の記録に残し、接続をサーバへつなぐために使う。WebSocket の判定のほかには付けない（項目そのものがない）。
     */
    readonly auditSendWebSocketAdmission?: true;
  }
  | {
    readonly action: 'BLOCK';
    readonly category: 'REQUEST';
    /**
     * Safety Ledger の止めた要求の理由（core の `BLOCKED_REQUEST_REASONS`）。この判定が返すのは `NON_READ_METHOD` と、監査の段の口で承認したサービスの
     * Origin への要求を送らない Context の `SERVICE_ORIGIN_REVISIT`（T35R-fix）。`SERVICE_REQUEST_LIMIT_REACHED`（T35b）は、この判定が通した要求を、
     * Guard が要求の上限の部品で断ったときに、Guard が作る。
     */
    readonly reason: (typeof BLOCKED_REQUEST_REASONS)[number];
    /**
     * T34b: スクリプトで送るログインの段で止めた、読み取りでない要求の詳しい理由（`SCRIPT_LOGIN_BLOCK_REASONS`）。Guard がログインの段の記録に
     * 数える（Safety Ledger には、今どおり `NON_READ_METHOD` だけを書く）。ほかの段には付けない（項目そのものがない）。
     */
    readonly scriptLoginBlock?: ScriptLoginBlockReason;
    /**
     * T36b（Task 36 の設計書 3.3）: 自動ログインのログインの段で、Guard が、判定の通した要求の URL か本文に、入れた資格情報が含まれていたので止めた
     * （この判定は返さない。Guard が作る。`reason` は閉じた一覧の値を置くだけで、Safety Ledger には書かない。値・URL を残さず、ログインの段の記録に
     * 数える）。ほかの止めた判定には付けない（項目そのものがない）。
     */
    readonly loginCredential?: true;
    /**
     * T35b: スクリプトで送るログインの監査の段で止めた、読み取りでない要求の詳しい理由（`AUDIT_STAGE_BLOCK_REASONS`）。Guard が監査の段の記録に
     * 数える（Safety Ledger には、今どおり `NON_READ_METHOD` だけを書く）。ほかの段には付けない（項目そのものがない）。
     */
    readonly auditStageBlock?: AuditStageBlockReason;
  }
  | {
    readonly action: 'BLOCK';
    readonly category: 'NAVIGATION';
    readonly reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION';
  }
  // FRETWS: 窓を開くボタンの押す期間に止めた接続は、押下の理由（`SCROLL_KEY_PRESS_RESTRICTED`）。
  | { readonly action: 'BLOCK'; readonly category: 'WEBSOCKET'; readonly reason: 'PASSIVE_WEBSOCKET' | 'SCROLL_KEY_PRESS_RESTRICTED' }
  | {
    readonly action: 'BLOCK';
    readonly category: 'AUDIT_EXCLUSION';
    /** 理由の値の一覧の owner は core（`BLOCKED_AUDIT_EXCLUSION_REASONS`。Safety Ledger の `blockedAuditExclusions` の中だけで使う）。 */
    readonly reason: (typeof BLOCKED_AUDIT_EXCLUSION_REASONS)[number];
  }
  | {
    readonly action: 'BLOCK';
    readonly category: 'LOGIN_STAGE';
    /** ログインの段だけで止める理由（`LOGIN_STAGE_BLOCK_REASONS`。Safety Ledger には書かず、Guard のログインの段の記録に数える）。 */
    readonly reason: LoginStageBlockReason;
  }
  | {
    readonly action: 'BLOCK';
    readonly category: 'WRITE_STAGE';
    /** 書き込みの段だけで止める理由（`WRITE_STAGE_BLOCK_REASONS`。Safety Ledger には書かず、Guard の書き込みの段の記録に数える。T30b）。 */
    readonly reason: WriteStageBlockReason;
  };

/**
 * 送信の段（ログインの段と書き込みの段）だけで止める理由（T26g-1。Task 26 の設計書の変更履歴の「T26R」の行の C1、「Blocker: T26g-1」の行。
 * T30b で書き込みの段と共用にした。閉じた一覧）。
 * - `OUTSIDE_ALLOWED_ORIGINS`: 許可 Origin の外への GET と HEAD のサブリソースとサブ frame のナビゲーション（手動と自動の両方）。
 * - `SUBMISSION_WINDOW`: 送信の窓の中の、許した POST のほかの読み取りの要求（同じ Origin を含む）。
 * - `SUBMISSION_WINDOW_BROWSER_FAVICON`: 送信の窓の中の、許可 Origin の `GET /favicon.ico`（query と fragment なし）。止めるが、値を運べない
 *   ブラウザ自身の要求として、予期しない要求の理由には数えない。
 * 記録は Safety Ledger ではなく、Guard の段の指定の中に持つ（core とスキーマの理由の一覧を変えない）。
 */
export const SUBMISSION_STAGE_BLOCK_REASONS = Object.freeze([
  'OUTSIDE_ALLOWED_ORIGINS',
  'SUBMISSION_WINDOW',
  'SUBMISSION_WINDOW_BROWSER_FAVICON',
] as const);
export type SubmissionStageBlockReason = (typeof SUBMISSION_STAGE_BLOCK_REASONS)[number];
/** ログインの段だけで止める理由（`SUBMISSION_STAGE_BLOCK_REASONS` と同じ一覧）。 */
export const LOGIN_STAGE_BLOCK_REASONS = SUBMISSION_STAGE_BLOCK_REASONS;
export type LoginStageBlockReason = SubmissionStageBlockReason;
/** 書き込みの段だけで止める理由（T30b。`SUBMISSION_STAGE_BLOCK_REASONS` と同じ一覧。窓の考え方はログインの段と同じ）。 */
export const WRITE_STAGE_BLOCK_REASONS = SUBMISSION_STAGE_BLOCK_REASONS;
export type WriteStageBlockReason = SubmissionStageBlockReason;

/** ブラウザ自身が、ページのアイコンを取りに行くときの既定の path（ページにアイコンの指定がない場合）。 */
export const BROWSER_DEFAULT_FAVICON_PATH = '/favicon.ico';

/**
 * ログインの段で、main frame のナビゲーションの POST を許す送信先（Task 25 の設計書 4.1 の `loginPostEndpoints`、4.2）。
 * - `origin`: 送信先の Origin。許可 Origin と同じ意味（`canonicalizeAllowedOrigins`）で比べる。
 * - `path`: 送信先の path。`/` で始まり、query と fragment を含まない値だけが当たりうる（それ以外は、どの要求にも当たらない。fail-closed）。
 */
export interface LoginPostEndpoint {
  readonly origin: string;
  readonly path: string;
}

/**
 * 送信の段（ログインの段と書き込みの段）で、main frame のナビゲーションの POST を許す送信先（T30b。形は `LoginPostEndpoint` と同じ。
 * 比べ方も同じ。書き込みの段は query と fragment を許さない）。
 */
export type SubmissionEndpoint = LoginPostEndpoint;

/**
 * 送信の段の口の共通の項目（T30b。ログインの段の口と書き込みの段の口）。
 * - `remainingPosts`: あと何回の POST を許すか。1 以上の整数のときだけ許す。回数を数えて減らすのは、呼び出し側（Guard）である。
 * - `submissionWindowOpen`（T26g-1）: 送信の窓が開いている。開いている間は、許した POST のほかの読み取りの要求を止める。
 *   省略と `false` は閉じている。開け閉めは、呼び出し側（Guard）が決める。
 */
interface SubmissionStagePolicy {
  readonly remainingPosts: number;
  readonly submissionWindowOpen?: boolean | undefined;
}

/** スクリプトの token の送信先の必須の query の組（名前と値の完全な一致。T34b）。 */
export interface RequiredQueryParameter {
  readonly name: string;
  readonly value: string;
}

/**
 * スクリプトの token の送信先（T34b。Task 34 の設計書 3.2 の `scriptLogin`）。Origin と path の比べ方は `SubmissionEndpoint` と同じ。query は、
 * 要求の URL の query の組（decode した名前と値）が、`requiredQuery` の組とちょうど同じ（余分な組も重複もない。順は問わない）で、fragment が
 * ないときだけ当たる。method は `POST` に固定。
 */
export interface ScriptLoginEndpoint extends SubmissionEndpoint {
  readonly requiredQuery: readonly RequiredQueryParameter[];
}

/**
 * 利用者が登録した送信（T35b で、ログインの段のログインに伴う送信（T34b）と、監査の段の読み取りの手続きの呼び出し（Task 35 の設計書 3.2）に共通に
 * した）。Origin と path の比べ方は `SubmissionEndpoint` と同じ（query と本文は照らさない）。`method` は `POST` のときだけ当たる。`remainingPosts` は、
 * この項目で、あと何回許すか（1 以上の整数のときだけ許す。数えて減らすのは呼び出し側の Guard）。判定は `registeredSubmissionVerdict`。
 */
export interface RegisteredSubmissionEndpoint extends SubmissionEndpoint {
  readonly method: string;
  readonly remainingPosts: number;
}

/** 登録したログインに伴う送信（T34b。Task 34 の設計書 3.2 の `loginSideRequests`。形は `RegisteredSubmissionEndpoint`）。 */
export type LoginSideRequestEndpoint = RegisteredSubmissionEndpoint;

/**
 * 登録した送信の判定で止めた理由（T35b。段を問わない共通の閉じた一覧）。段の理由に写す（ログインの段は `SIDE_REQUEST_*`、監査の段は
 * `READ_REQUEST_*`）。
 * - `OVER_LIMIT`: 登録した送信に一致するが、一致するどの項目にも残りの回数がない。
 * - `NOT_SCRIPT`: 登録した送信の送信先への `POST` だが、種類が fetch でも xhr でもない（document・beacon など）。
 */
export const REGISTERED_SUBMISSION_BLOCK_REASONS = Object.freeze(['OVER_LIMIT', 'NOT_SCRIPT'] as const);
export type RegisteredSubmissionBlockReason = (typeof REGISTERED_SUBMISSION_BLOCK_REASONS)[number];

/** 登録した送信の判定の結果（T35b）: 通す（一致した項目の位置）、止める（共通の理由）、どの項目にも一致しない。 */
export type RegisteredSubmissionVerdict =
  | { readonly kind: 'ADMIT'; readonly index: number }
  | { readonly kind: 'BLOCK'; readonly reason: RegisteredSubmissionBlockReason }
  | { readonly kind: 'NO_MATCH' };

/**
 * スクリプトで送るログインの監査の段の口（T35b。Task 35 の設計書 3.2。平らなデータ）。この口があることが、スクリプトで送るログインの監査の段である
 * ことを表す（公開の監査とフォームの送信のログインの監査には渡さない）。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（数える区分。Guard が上限の部品で数える）。
 * - `auditReadRequests`: 登録した読み取りの手続きの呼び出し（項目ごとの、その読み込みの残りの回数つき）。
 * - `scriptLogin`: token の送信先（必須の query と違う POST（更新など）を見分けて止める）。
 * - `serviceOriginRequestsWithheld`（T35R-fix。T35R の C-1）: 真なら、承認したサービスの Origin への要求を送らない（幅の走査と Interaction の
 *   `REVISIT` の Context。読み取りは sub frame の文書を含め `SERVICE_ORIGIN_REVISIT` で止め、読み取りでない要求と main frame の移動は今の理由で止める）。
 *   ない・偽なら今どおり（最初の読み込み `PRIMARY`）。
 */
export interface AuditStagePolicy {
  readonly approvedServiceOrigins: readonly string[];
  readonly auditReadRequests: readonly RegisteredSubmissionEndpoint[];
  readonly scriptLogin: ScriptLoginEndpoint;
  readonly serviceOriginRequestsWithheld?: boolean;
}

/**
 * スクリプトで送るログインの監査の段の口が通した理由（T35b）: 登録した読み取りの手続きの呼び出し（`AUDIT_READ_REQUEST`。`index` は
 * `auditReadRequests` の位置、`serviceOrigin` は送信先が承認したサービスの Origin か）と、承認したサービスの Origin への読み取り
 * （`SERVICE_ORIGIN_READ`）。どちらも、送信先が承認したサービスの Origin なら、Guard が上限の部品で数える。
 */
export type AuditStageAdmission =
  | { readonly kind: 'AUDIT_READ_REQUEST'; readonly index: number; readonly serviceOrigin: boolean }
  | { readonly kind: 'SERVICE_ORIGIN_READ' };

/**
 * スクリプトで送るログインの監査の段で止めた、読み取りでない要求の詳しい理由（T35b。閉じた一覧。Safety Ledger には書かず、Guard の監査の段の記録に
 * 数える）。
 * - `READ_REQUEST_OVER_LIMIT`・`READ_REQUEST_NOT_SCRIPT`: 登録した読み取りの手続きの呼び出しの、共通の理由（`OVER_LIMIT`・`NOT_SCRIPT`）。
 * - `TOKEN_REFRESH`: token の送信先の Origin と path への `POST` で、query が必須の query と違う（token の更新など）。
 * - `UNREGISTERED_NON_READ`: ほかの読み取りでない要求（サーバの関数、計測の送信、`POST` でない method、許可 Origin とサービスの Origin の外）。
 */
export const AUDIT_STAGE_BLOCK_REASONS = Object.freeze([
  'READ_REQUEST_OVER_LIMIT',
  'READ_REQUEST_NOT_SCRIPT',
  'TOKEN_REFRESH',
  'UNREGISTERED_NON_READ',
] as const);
export type AuditStageBlockReason = (typeof AUDIT_STAGE_BLOCK_REASONS)[number];

/** 登録した送信の共通の理由の、監査の段の理由への写し（T35b）。 */
const AUDIT_STAGE_REGISTERED_REASONS: Readonly<Record<RegisteredSubmissionBlockReason, AuditStageBlockReason>> = Object.freeze({
  OVER_LIMIT: 'READ_REQUEST_OVER_LIMIT',
  NOT_SCRIPT: 'READ_REQUEST_NOT_SCRIPT',
});

/**
 * スクリプトで送るログイン（`SCRIPT_REQUEST`）の口（T34b。Task 34 の設計書 3.3。平らなデータ）。この口があることが、ログインの送り方が
 * `SCRIPT_REQUEST` であることを表す（ない場合は `FORM_NAVIGATION`。今のまま）。送り方の値の一覧の owner は認証の設定の契約
 * （`src/control/`。`src/safety/` からは読み込まない）なので、ここでは口の有無で表す。
 * - `scriptLogin`: token の送信先。残りの回数は、ログインの段の口の `remainingPosts`。
 * - `loginSideRequests`: 登録したログインに伴う送信（項目ごとの残りの回数つき）。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（認証と API。プロファイルの `approvedServiceOrigins`）。許可 Origin と同じ意味で比べる。
 */
export interface ScriptRequestLoginPolicy {
  readonly scriptLogin: ScriptLoginEndpoint;
  readonly loginSideRequests: readonly LoginSideRequestEndpoint[];
  readonly approvedServiceOrigins: readonly string[];
}

/**
 * ログインの段だけの口（Task 25 の設計書 4.2。平らなデータ）。この口があることが、ログインの段であることを表す。
 * - `loginPostEndpoints`: 許す送信先の一覧（フォームの送信のログイン。スクリプトで送るログインでは使わない）。
 * - `remainingPosts`・`submissionWindowOpen`: `SubmissionStagePolicy`（窓は自動ログインの送信の窓。スクリプトで送るログインでは、token の送信を
 *   通した時点から成功の確かめまで）。スクリプトで送るログインでは、`remainingPosts` は token の送信の残りの回数。
 * - `scriptRequest`（T34b）: スクリプトで送るログインの口（`ScriptRequestLoginPolicy`）。省略はフォームの送信のログイン（今のまま）。
 */
export interface LoginStagePolicy extends SubmissionStagePolicy {
  readonly loginPostEndpoints: readonly LoginPostEndpoint[];
  readonly scriptRequest?: ScriptRequestLoginPolicy | undefined;
  /**
   * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1）: 手動のログインの段（人が headed の Browser で操作する段）の印。ある場合は、
   * 今の決まりで止める要求のうち、読み取りでない要求（ログインの送信、手続きの呼び出し。許可 Origin の外への main frame の移動を除く）を、止めずに通す
   * （`manualLoginPassThrough`。`manualPassThroughOf`）。読み取りは今の決まりのまま。自動ログインの段は付けない（今の厳しさのまま）。
   */
  readonly manualPassThrough?: true | undefined;
  /**
   * T44R（Task 44 のレビューの M-1）: 手動のログインの段で、スクリプトで送るログインの口（`scriptRequest`）がないとき（token の送信先がまだない設定）の、
   * プロファイルの承認したサービスの Origin。ナビゲーションでない GET と HEAD を `SERVICE_ORIGIN_READ` で通す（`scriptRequest` の口の読み取りと同じ）。
   * 働くのは、`manualPassThrough` があり、`scriptRequest` がないときだけ。読み取りでない要求の扱いは
   * 変えない（手動の段の口が通して記録する）。
   */
  readonly manualServiceReadOrigins?: readonly string[] | undefined;
  /**
   * DEF-193（設計書 `2026-11-04-beaksight-login-session-design.md` 3.2）: 自動ログインの段（スクリプトで送るログイン。手動の段の印がない）で、監査の段の送信の扱い
   * `PASS_EXCEPT_DELETE` を当てる印（`automatedLoginPassThroughOf`）。ある場合は、今の決まりで止める登録のない読み取りでない要求（`UNREGISTERED_NON_READ`）と、
   * token の送信先への query の違う送信（`TOKEN_REQUEST_QUERY_MISMATCH`。サイトのスクリプトの token の更新）のうち、ナビゲーションでないものを通す
   * （`automatedLoginPassThrough`。回数に数えない）。SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 削除・削除の上書き・危険な語と
   * 読まないパスでは止めない（前の `AUTOMATED_LOGIN_RULE_BLOCKED`）。資格情報を含む要求は、Guard の守り（`credentialCheckedDecision`）が止める。手動の段の印と一緒なら
   * 働かない。
   */
  readonly automatedPassThrough?: true | undefined;
}

/**
 * DEF-193: 自動ログインの段の口が通す、今の決まりなら止める読み取りでない要求の理由（閉じた一覧）。登録のない読み取りでない要求と、token の送信先への query の
 * 違う送信（サイトのスクリプトの token の更新）。ほかの理由（2 回目のログインの送信、登録した送信の上限・送り方の違い）は止めたまま。
 */
export const AUTOMATED_LOGIN_PASS_THROUGH_REASONS = Object.freeze(['UNREGISTERED_NON_READ', 'TOKEN_REQUEST_QUERY_MISMATCH'] as const);
export type AutomatedLoginPassThroughReason = (typeof AUTOMATED_LOGIN_PASS_THROUGH_REASONS)[number];

/**
 * スクリプトで送るログインの段の口が通した理由（T34b）: token の送信（`SCRIPT_LOGIN_TOKEN`）、登録したログインに伴う送信（`LOGIN_SIDE_REQUEST`。
 * `index` は `loginSideRequests` の位置）、承認したサービスの Origin への読み取り（`SERVICE_ORIGIN_READ`）。
 */
export type LoginStageAdmission =
  | { readonly kind: 'SCRIPT_LOGIN_TOKEN' }
  | { readonly kind: 'LOGIN_SIDE_REQUEST'; readonly index: number }
  | { readonly kind: 'SERVICE_ORIGIN_READ' };

/**
 * スクリプトで送るログインの段で止めた、読み取りでない要求の詳しい理由（T34b。閉じた一覧。Safety Ledger には書かず、Guard のログインの段の
 * 記録に数える）。
 * - `TOKEN_REQUEST_OVER_LIMIT`: token の送信の形に完全に一致するが、残りの回数がない（上限を超えた試み。設計書 3.4）。
 * - `TOKEN_REQUEST_NOT_SCRIPT`: token の送信先（Origin・path・query）への `POST` だが、種類が fetch でも xhr でもない（document・beacon など）。
 * - `TOKEN_REQUEST_QUERY_MISMATCH`: token の送信先の Origin と path への `POST` だが、query が必須の query と違う（別の grant、token の更新など）。
 * - `SIDE_REQUEST_OVER_LIMIT`: 登録したログインに伴う送信に一致するが、その項目の残りの回数がない。
 * - `SIDE_REQUEST_NOT_SCRIPT`: 登録したログインに伴う送信の送信先への `POST` だが、種類が fetch でも xhr でもない。
 * - `UNREGISTERED_NON_READ`: ほかの読み取りでない要求（登録していない送信先、許可 Origin とサービスの Origin の外、`POST` でない method）。
 * - `LOGIN_CREDENTIAL_IN_REQUEST`（T36c。Task 36 の設計書 3.3。設計者の判断 1）: 自動ログインで、承認した token の送信のほかの要求の URL か本文に、
 *   入れた資格情報が含まれていた（`src/safety/login-credential-guard.ts`）。この判定は返さない（Guard が作り、数だけを数える。止めた一覧には載せない）。
 */
export const SCRIPT_LOGIN_BLOCK_REASONS = Object.freeze([
  'TOKEN_REQUEST_OVER_LIMIT',
  'TOKEN_REQUEST_NOT_SCRIPT',
  'TOKEN_REQUEST_QUERY_MISMATCH',
  'SIDE_REQUEST_OVER_LIMIT',
  'SIDE_REQUEST_NOT_SCRIPT',
  'UNREGISTERED_NON_READ',
  LOGIN_CREDENTIAL_BLOCK_REASON,
] as const);
export type ScriptLoginBlockReason = (typeof SCRIPT_LOGIN_BLOCK_REASONS)[number];

/** ML-a: 手動のログインの段で通した読み取りでない要求の、通さなければ止めた理由（スクリプトで送るログインの詳しい理由か、`NON_READ_METHOD`）。 */
export type ManualLoginPassThroughReason = ScriptLoginBlockReason | 'NON_READ_METHOD';

/**
 * 書き込みの段だけの口（T30b。Task 30 の設計書 3 章の「書き込みの段」、4 章。平らなデータ）。この口があることが、書き込みの段であることを
 * 表す。
 * - `writeEndpoint`: 承認の要求の形の送信先（Origin と path。method は `POST` だけ。query と fragment のある要求は許さない）。
 * - `remainingPosts`・`submissionWindowOpen`: `SubmissionStagePolicy`（窓は、値を入れ始める直前から、承認の POST を通すまで）。
 * 送る中身（enctype、欄の名前と値、文書の文字コード）の照合は、この判定の後に Guard が行う（`src/safety/write-payload-policy.ts`）。
 */
export interface WriteStagePolicy extends SubmissionStagePolicy {
  readonly writeEndpoint: SubmissionEndpoint;
  /**
   * T39b（Task 39 の設計書 3.1、3.3）: API のシナリオの書き込みの段の、承認した API の Origin（ある場合だけ API の書き込みの段）。ある場合は、
   * form の送信（`writeEndpoint` への main frame のナビゲーションの POST）を通さず、送信の窓の中で残りの回数が 1 のとき、この Origin の承認の
   * endpoint（`writeEndpoint` の path。T39R-fix の M-2）への `POST`・`PATCH` のうち、main frame のページのスクリプトが送ったナビゲーションでない fetch・xhr（`isAllowedApiWrite`）だけを、照合にかける印
   * （`writeStageApiWrite`）つきで通す（照合 `checkApiWritePayload` は、この判定の後に Guard が行う）。監査の段の口があれば、登録した読み取りの手続きの
   * 呼び出しを窓の外で通す（`auditStageVerdict` の `admissible`）。
   */
  readonly apiOrigin?: string | undefined;
  /**
   * LU-5（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.3 の 1、fix round 1 の案 A）: API の書き込みの段の、照合へ回す要求の path
   * （照合の側の唯一の部品 `apiWriteCheckPathOf` が作る。path の形の更新は `{id}` を台帳の ID にした具体的な path）。ある場合は、`isAllowedApiWrite` が
   * `writeEndpoint` の path の代わりに、これと完全一致で比べる（Origin は `writeEndpoint` のまま）。省略は今のまま（`writeEndpoint` の path）。窓の前の
   * 「承認した送信先とその下」の守り（`isUnderWriteEndpoint`）は、これを使わず、`writeEndpoint` の path の型のまま。
   */
  readonly apiWritePath?: string | undefined;
  /**
   * LU-SFIX3-B（LU-SREV3 の Important-2）: フォームの書き込みの段の、窓の前（N2）に守る送信先の path の型（フォームの更新で、送信先の最後の区切りが対象の
   * 番号のとき。`recordPathShapeOf` の形）。ある場合は、窓の前の「承認した送信先とその下」の守り（`isUnderWriteEndpoint`）が、`writeEndpoint` の path の
   * 代わりにこれを使う（型と表の path を守る。`guardedWriteEndpointPathsOf`）。承認の POST の照らし（`isAllowedSubmissionPost`）は `writeEndpoint` の具体的な
   * path のまま。省略は今のまま。
   */
  readonly guardedPathShape?: string | undefined;
  /**
   * OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）: 送信の窓を一度でも開いたか（値を入れ始めた後。押した後を含む）。真なら、監査の段の
   * 送信の扱いの口を使わない（OP-REV3 の C-2。`writeStageAuditSendApplies`）。省略は偽（値を入れる前）。
   */
  readonly valuesEntered?: boolean | undefined;
  /**
   * L12a（設計書 `2026-11-09-beaksight-remove-limits-design.md` 2・3、L12 の判断 1〜6）: 押した後の扱い（`writeStageAfterPressDecisionOf`）。Guard が、送信の扱いが
   * `PASS_EXCEPT_DELETE` の書き込みの段で、送信の段（押す直前の確かめの後）を開いた後だけ渡す。省略は今のまま（押した後も書き込みの段の決まりで止める）。
   */
  readonly afterPress?: WriteStageAfterPress | undefined;
}

/**
 * L12a: 書き込みの段の、押した後の扱いの口（平らなデータ）。
 * - `approvedWriteResponded`: 承認した送信（BeakSight が押した 1 回）の応答を受けたか。受けるまでは、承認の送信先とその下への読み取りでない要求を通さない
 *   （照合が止めた後も、受けていないので通さない。押した結果の本文は照合だけが通す）。
 * SD-2: 危険な語の一覧（前の `dangerousTerms`）は外した（押した後のページの送信を、削除と危険な語で止めない）。
 */
export interface WriteStageAfterPress {
  readonly approvedWriteResponded: boolean;
}

/**
 * 監査の段の除外の口（Task 25 の設計書 4.1 の `excludedPaths`・`auditPathPrefixes`・既定の危険な語、4.2。平らなデータ）。一覧の値は
 * 呼び出し側（認証の設定の owner）から受ける。
 * - `excludedPathPrefixes`: 読まない path の前方一致（文字列の前方一致。大文字と小文字を区別しない）。
 * - `auditPathPrefixes`: 読む path の前方一致（文字列の前方一致。大文字と小文字を区別する）。空なら制限しない。
 * - `dangerousTerms`: path か query に含まれていたら読まない語（大文字と小文字を区別しない）。
 * SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 要求の判定（Guard と中継）は当てない（ページの読み取り・子の frame・先読み・
 * main frame の移動のどれにも。前の BN-0 の印 `applyToPageSubresourceReads` は外した）。使うのは、BeakSight 自身の移動の前の判定と、移った画面を点検しない
 * 読み込みの側（`isOutsideAuditScope`・`isAuditExcludedUrl`）だけ。
 */
export interface AuditExclusionPolicy {
  readonly excludedPathPrefixes: readonly string[];
  readonly auditPathPrefixes: readonly string[];
  readonly dangerousTerms: readonly string[];
}

/**
 * BN-R0 fix round 1: 先読みの要求の印のヘッダ（`Sec-Purpose`・古い形の `Purpose`）と、その値に含まれる語。Chromium は `<link rel="prefetch">` の要求を、種類
 * `other` で渡すことがある（C-1 の確かめ。Chromium 151）ので、要求のヘッダでも先読みを見分ける。
 */
const PRELOAD_PURPOSE_HEADER_NAMES = Object.freeze(['sec-purpose', 'purpose'] as const);
const PRELOAD_PURPOSE_TOKEN = 'prefetch';

/**
 * 要求のヘッダが、先読み（prefetch・prerender）の要求の印を持つか（印のヘッダの値に `prefetch` を含む。大文字と小文字を問わない）。唯一の見分け。BN-R1 の M-2:
 * Guard が止めた要求の記録の印（`speculative`）にも使う。
 */
export function isSpeculativeRequestHeaders(headers: unknown): boolean {
  return PRELOAD_PURPOSE_HEADER_NAMES.some((name) => (headerValueOf(headers, name) ?? '').toLowerCase().includes(PRELOAD_PURPOSE_TOKEN));
}

/**
 * SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4 の「main frame の文書の移動」）: URL が点検の範囲の外か（許可 Origin の外か、監査の段の
 * 除外の口があれば読まないパス・読む範囲の外・危険な語に当たる。読めない URL は外）。要求の判定（Guard）は使わない。使うのは、BeakSight 自身の移動の前の判定
 * （`isRunNavigationBlocked`）と、移った画面を点検しない読み込みの側（`navigatePage` の口）だけ。
 */
export function isOutsideAuditScope(url: string, allowedOrigins: ReadonlySet<string>, exclusions: AuditExclusionPolicy | undefined): boolean {
  return !hasAllowedOrigin(url, allowedOrigins) || (exclusions !== undefined && isAuditExcluded(url, allowedOrigins, exclusions));
}

/** SD-2: URL が、監査の段の除外（読まないパス・読む範囲の外・危険な語）に当たるか（`isRunNavigationBlocked` の除外の範囲の判定）。 */
export function isAuditExcludedUrl(url: string, allowedOrigins: ReadonlySet<string>, exclusions: AuditExclusionPolicy): boolean {
  return isAuditExcluded(url, allowedOrigins, exclusions);
}

/**
 * フォームの書き込みの段の送信の窓の中の、承認した送信先とその下への読み取りか（BeakSight が送る書き込みの照合の一部。押したフォームが GET に変えられた送信など）。
 */
function isWriteWindowReadUnderEndpoint(facts: HttpRequestFacts, policy: PassiveRequestPolicyOptions): boolean {
  return policy.writeStage !== undefined
    && policy.writeStage.apiOrigin === undefined
    && policy.writeStage.submissionWindowOpen === true
    && isUnderWriteEndpoint(facts.url, guardedWriteEndpointOf(policy.writeStage));
}

/** `classifyPassiveRequest` の口のうち、どの段でも渡せるもの。 */
interface PassiveRequestPolicyCommon {
  readonly auditExclusions?: AuditExclusionPolicy | undefined;
  /**
   * DEF-210（通知の枠の設計書 3.2.1。NO-2 fix round 2）: 通知の枠の閉じる押下の期間の印（Guard が、押す期間の間だけ渡す）。判定は
   * `notificationPressDecisionOf`。省略は押す期間でない（今の判定のまま）。
   */
  readonly notificationPress?: NotificationPressMode | undefined;
  /**
   * REV-EV4（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.4）: 横にスクロールする領域のキーの押下の期間の印（Guard が、押す期間の間だけ渡す）。
   * 判定は `scrollKeyPressDecisionOf`。省略は押す期間でない。FRET（設計書 `2026-11-24-beaksight-dialog-focus-return-design.md` の設計変更履歴の 2026-11-25）:
   * `DIALOG_PRESS` は、窓を開くボタンの押す期間（Enter を押してから、窓を閉じて落ち着くまで）。
   */
  readonly scrollKeyPress?: true | 'DIALOG_PRESS' | undefined;
}

/**
 * RB-14b（X1）: ログインの段の口。ログインの段は、書き込みの段・監査の段・送信の扱い・リアルタイムの通信の口と一緒には作れない（型で作れない。Guard の取り付けも
 * `TypeError` で拒む）。前の実行時の fail-closed の分岐は外した。
 */
export interface LoginStageRequestPolicy extends PassiveRequestPolicyCommon {
  readonly authSetup: LoginStagePolicy;
  readonly writeStage?: never;
  readonly auditStage?: never;
  readonly auditSend?: never;
  readonly realtimePassThrough?: never;
}

/** RB-14b（X1）: ログインの段でない口（公開監査・監査の段・書き込みの段）。 */
export interface NonLoginRequestPolicy extends PassiveRequestPolicyCommon {
  readonly authSetup?: never;
  readonly writeStage?: WriteStagePolicy | undefined;
  /** T35b: スクリプトで送るログインの監査の段の口（`AuditStagePolicy`）。フォームの書き込みの段とは一緒に作らない（Guard の取り付けが拒む）。 */
  readonly auditStage?: AuditStagePolicy | undefined;
  /**
   * AS-a: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口（`AuditSendPolicy`）。ない場合は人が選んだ READ_ONLY（読み取りでない HTTP の要求を止める）。OP-N:
   * 書き込みの段の口と一緒なら、書き込みの段の決まり（`writeStageAuditSendApplies`）に当たる読み取りでない要求だけに使う。
   */
  readonly auditSend?: AuditSendPolicy | undefined;
  /**
   * RB-4b（設計書 `2026-11-15-beaksight-test-rebuild-design.md` 3.2）: リアルタイムの通信（WebSocket）を止めない口の印。凍結しない Context（Passive と書き込みの段）
   * だけに Guard が渡す。READ_ONLY でも通す（READ_ONLY が止めるのは、読み取りでない HTTP の要求だけ）。SD-2: 危険な語と読まないパスの接続も止めない。
   */
  readonly realtimePassThrough?: true | undefined;
}

/** `classifyPassiveRequest` の省略できる口。どれもなければ、今の判定（公開監査）と同じ。 */
export type PassiveRequestPolicyOptions = LoginStageRequestPolicy | NonLoginRequestPolicy;

/**
 * DEF-210（通知の枠の設計書 3.2.1）: 閉じる押下の期間の扱いの閉じた一覧。
 * - `AUDIT`: 見るだけの点検。URL に資格情報（userinfo・資格情報の名前の query）がある読み取りでない送信だけを止める。ほかは今の判定のまま。RB-14a（X11）: 許可の
 *   外への送信の止めと、main frame の移動の止めは外した（移動は Guard が数え、移った画面は点検しない）。
 * - `DISCOVERY`: 操作さがし。凍結の読み取りの決まり（`isFrozenReadAdmissible`）に当たる読み取りだけを今の判定にかける（ほかは止める）。main frame の文書の
 *   移動は止める（届けずに記録する）。
 */
export const NOTIFICATION_PRESS_MODES = Object.freeze(['AUDIT', 'DISCOVERY'] as const);
export type NotificationPressMode = (typeof NOTIFICATION_PRESS_MODES)[number];

/** DEF-210: 閉じる押下の期間の決まりで止めた要求の理由（`BLOCKED_REQUEST_REASONS` の値）。 */
export const NOTIFICATION_DISMISSAL_BLOCK_REASON = 'NOTIFICATION_DISMISSAL_RESTRICTED' satisfies (typeof BLOCKED_REQUEST_REASONS)[number];

/** URL に資格情報（userinfo か、資格情報の名前の query）があるか。読めない URL は、ある（止める側）。 */
const urlCarriesCredential = (url: string): boolean => {
  const parsed = parseUrl(url);
  return parsed === null || hasUrlCredentials(parsed) || [...parsed.searchParams.keys()].some((name) => isSecretUrlQueryParameterName(name));
};

/**
 * DEF-210（通知の枠の設計書 3.2.1 の 2〜4）: 閉じる押下の期間の判定。押す期間でない、または今の判定にかけてよい要求は `null`（呼び出し側が今の判定を行う）。
 * - `AUDIT`: URL に資格情報がある読み取りでない要求: 止める（RB-14a）。
 * - `DISCOVERY`: main frame の文書の移動（フォームの送信、読み込み直しを含む）と、凍結の読み取りの決まりに当たらない要求（読み取りでない要求を含む）: 止める。
 * WebSocket は扱わない（今の判定のまま）。
 */
export function notificationPressDecisionOf(
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision | null {
  const mode = policy.notificationPress;
  if (mode === undefined || facts.kind !== 'HTTP') {
    return null;
  }
  const blocked: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: NOTIFICATION_DISMISSAL_BLOCK_REASON };
  if (mode === 'AUDIT') {
    return !isReadMethod(facts.method) && urlCarriesCredential(facts.url) ? blocked : null;
  }
  return (facts.isNavigationRequest && facts.isMainFrame) || !isFrozenReadAdmissible(facts, allowedOrigins, policy) ? blocked : null;
}

/** REV-EV4: キーの押下の期間の決まりで止めた要求の理由（`BLOCKED_REQUEST_REASONS` の値）。 */
export const SCROLL_KEY_PRESS_BLOCK_REASON = 'SCROLL_KEY_PRESS_RESTRICTED' satisfies (typeof BLOCKED_REQUEST_REASONS)[number];

/**
 * REV-EV4（設計書 3.4）: 横にスクロールする領域のキーの押下の期間の判定。その期間の main frame の文書の移動（フォームの送信を含む）は、BeakSight の操作が
 * 起こしたものとして止める（違反にしない）。ほか（期間でない・main frame の移動でない）は `null`（呼び出し側が今の判定を行う）。
 * FRET（2026-11-25）: 窓を開くボタンの押す期間（`DIALOG_PRESS`）は、BeakSight の押下が原因の送信とみなし、読み取りでない要求も、main frame と子の frame の
 * どちらでも止める（操作さがしの凍結と同じ考え方。押す期間の外の送信の扱いは変えない）。
 */
export function scrollKeyPressDecisionOf(facts: PassiveRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision | null {
  if (policy.scrollKeyPress === undefined) {
    return null;
  }
  const dialogPress = policy.scrollKeyPress === 'DIALOG_PRESS';
  if (facts.kind !== 'HTTP') {
    // FRET fix round 3（設計書の設計変更履歴の 2026-11-26）: 押す期間と押した後の止めの続きに新しく開く WebSocket の接続を止める（その接続の frame も届かない。
    // 前から開いていた接続は、判定に来ないので今どおり通る）。FRETWS（設計書 `2026-11-25-beaksight-discovery-sibling-press-design.md` 2.2）: 記録の理由は
    // HTTP と同じ押下の理由（普通の止め `PASSIVE_WEBSOCKET` と分ける）。
    return dialogPress ? { action: 'BLOCK', category: 'WEBSOCKET', reason: SCROLL_KEY_PRESS_BLOCK_REASON } : null;
  }
  const mainFrameMove = facts.isNavigationRequest && facts.isMainFrame;
  // FRET fix round 3・4（設計書の設計変更履歴の 2026-11-26）: 押す期間と止めの続きは、読み取りの method でも、SD-1 の操作の前の判定と同じ語（日本語・ログアウトの
  // 語を含む。1 か所 `urlHasDestructiveWord`。path と query の符号化を外してから当てる）の URL を止める。巡回の語の判定は変えない。
  return mainFrameMove || (dialogPress && (!isReadMethod(facts.method) || urlHasDestructiveWord(facts.url)))
    ? { action: 'BLOCK', category: 'REQUEST', reason: SCROLL_KEY_PRESS_BLOCK_REASON }
    : null;
}

/**
 * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口（平らなデータ）。この口があることが、
 * その扱いを選んだ Passive の段であることを表す（ない場合は今のまま読み取りだけ。`READ_ONLY`）。判定は `auditSendDecisionOf`。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（許可 Origin と同じ意味で比べる）。AS-c から、送り先の Origin の制限には使わない（許可 Origin と
 *   これらのほかへの要求も通す）。使うのは、ほかの Origin へ通した数の見分け（Guard の `isOtherOrigin`）と、サービスの Origin へ送らない Context
 *   （`serviceOriginRequestsWithheld`）の止め（`isWithheldServiceOriginRequest`）だけ。
 * - `dangerousTerms`: 危険な語（呼び出し側が既定の危険な語を渡す。比べ方は監査の段の除外と同じ `hitsDangerousTerm`）。SD-2（設計書
 *   `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1・2.4）: 送信を止めるのには使わない。使うのは、凍結の段の読み取りと token の更新から除く決まり
 *   （守り 2。`isFrozenReadAdmissible`・`isFrozenTokenRefreshAdmissible`）と、通した WebSocket の記録の印（`isAuditSendDangerousWebSocket`）だけ。
 * RB-4a（X2）: 数の上限の名残（残りの数 `remainingPasses`・`remainingWebSockets` と、上限で止める `AUDIT_SEND_OVER_LIMIT`）は外した。数えない。
 */
export interface AuditSendPolicy {
  readonly approvedServiceOrigins: readonly string[];
  readonly dangerousTerms: readonly string[];
  /**
   * AS-c: WebSocket の接続の判定の口の印（Guard の WebSocket の route が渡す）。省略は WebSocket を通さない（今どおり `PASSIVE_WEBSOCKET`。fail-closed）。
   */
  readonly webSockets?: true | undefined;
  /**
   * OP-Q（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.8 の Q1）: 書き込みの作業の中の Passive の Context（送る前の確かめと照合の READ）の印。値は、
   * その作業の承認した送信の送信先（Origin と path）。ある場合は、書き込みの段の値を入れる前と同じ決まり（`writeStageAuditSendApplies`）を加える（送り先は許可 Origin と
   * 承認したサービスの Origin だけ、承認した送信先とその下の path は通さない）。WebSocket には使わない。省略は監査の段の決まりのまま。
   */
  readonly writeJobEndpoint?: SubmissionEndpoint | undefined;
}

/** 削除の method（大文字と小文字を区別せずに比べる）。SD-2: 凍結の段の読み取りの確かめ（`isDeleteRequest`。守り 2）だけが使う。 */
const DELETE_METHOD = 'DELETE';

/**
 * 送信の段（ログインの段と書き込みの段）で許す method（HTTP の method は大文字と小文字を区別するので、この綴りだけ。T30b で共用にした）。
 */
export const SUBMISSION_POST_METHOD = 'POST';

/**
 * ログインの段で許す method（`SUBMISSION_POST_METHOD`）。認証の設定の送信先への POST かを調べるときの要求の事実（`isLoginEndpointPost`）と、
 * 回数の上限で止められたかの判定（`src/worker/login-stage-checks.ts`）も、この値を使う（CCX-15）。
 */
export const LOGIN_POST_METHOD = SUBMISSION_POST_METHOD;

/** 送信先かを調べるときの残りの回数（1 なら、送信先への POST は ALLOW になる。`isLoginEndpointPost`）。 */
const ONE_REMAINING_POST = 1;

// percent-encode を戻し直す回数の上限、比べる path の形の数の上限、dot segment の解決の仮の基準の Origin は、`src/core/audit-exclusion-forms.ts`
// が持つ（CC-100）。ログインの送信先の path の正規化（`canonicalEndpointPath`）も、同じ仮の基準の Origin を使う。

export function isReadMethod(method: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
}

/** Passive HTTP の許可Origin。正規化は URL の意味の owner（`canonicalizeAllowedOrigins`）に委譲する。 */
export function canonicalPassiveAllowedOrigins(allowedOrigins: ReadonlySet<string>): ReadonlySet<string> {
  return canonicalizeAllowedOrigins(allowedOrigins);
}

export function hasAllowedOrigin(url: string, allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const candidate = new URL(url);
    return canonicalPassiveAllowedOrigins(allowedOrigins).has(candidate.origin);
  } catch {
    return false;
  }
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * ログインの送信先の path を、URL の解析器の規則（dot segment の解決）で正規化した値。`/` で始まらない値、`//` で始まる値（別の
 * host を指しうる）、query か fragment を含む値は `null`（どの要求にも当たらない）。
 */
function canonicalEndpointPath(path: string): string | null {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    return null;
  }
  const parsed = parseUrl(`${PATH_NORMALIZATION_BASE}${path}`);
  return parsed === null ? null : parsed.pathname;
}

/**
 * 送信先の query の比べ方（T34b で、真偽の値から広げた）。
 * - `ANY`: query と fragment を問わない（フォームの送信のログイン、ログインに伴う送信）。
 * - `NONE`: URL の文字列に `?` も `#` もない（空の query と fragment を含めて止める。書き込みの段）。
 * - `EXACT`: fragment がなく、URL の query の組（decode した名前と値）が `parameters` とちょうど同じ（余分な組も重複もない。順は問わない。
 *   スクリプトの token の送信）。
 */
type EndpointQueryRule =
  | { readonly kind: 'ANY' }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'EXACT'; readonly parameters: readonly RequiredQueryParameter[] };

const ANY_QUERY: EndpointQueryRule = Object.freeze({ kind: 'ANY' });
const NO_QUERY: EndpointQueryRule = Object.freeze({ kind: 'NONE' });

/** URL の query の組が、`parameters` の組とちょうど同じか（`EXACT`。fragment があれば偽）。 */
function hasExactQuery(url: string, candidate: URL, parameters: readonly RequiredQueryParameter[]): boolean {
  if (url.includes('#')) {
    return false;
  }
  const actual = [...candidate.searchParams.entries()];
  if (actual.length !== parameters.length) {
    return false;
  }
  const unmatched = [...parameters];
  return actual.every(([name, value]) => {
    const index = unmatched.findIndex((parameter) => parameter.name === name && parameter.value === value);
    if (index < 0) {
      return false;
    }
    unmatched.splice(index, 1);
    return true;
  });
}

/**
 * URL が、送信の段の送信先に当たるか（T30b でログインの段から共通にした比べ方。T34b で query の比べ方を広げた）。次をすべて満たすときだけ真。
 * - URL が解析でき、認証情報を含まない。
 * - query と fragment が、`queryRule` に合う（`EndpointQueryRule`）。
 * - Origin（許可 Origin と同じ意味の正規化）と path（URL の解析器が正規化した値。percent-encode は decode しない）が、送信先と完全に一致する。
 */
function matchesSubmissionEndpoint(url: string, endpoint: SubmissionEndpoint, queryRule: EndpointQueryRule): boolean {
  const candidate = parseUrl(url);
  if (candidate === null || hasUrlCredentials(candidate)) {
    return false;
  }
  if (queryRule.kind === 'NONE' && (url.includes('?') || url.includes('#'))) {
    return false;
  }
  if (queryRule.kind === 'EXACT' && !hasExactQuery(url, candidate, queryRule.parameters)) {
    return false;
  }
  return canonicalEndpointPath(endpoint.path) === candidate.pathname && hasAllowedOrigin(url, new Set([endpoint.origin]));
}

/** 残りの回数が 1 以上の安全な整数か。 */
const hasRemainingPosts = (remainingPosts: number): boolean => Number.isSafeInteger(remainingPosts) && remainingPosts >= 1;

/**
 * 要求が、送信の段（ログインの段と書き込みの段）で許す POST の形か（T30b でログインの段から共通にした条件）。次をすべて満たすときだけ真。
 * - method が `POST`、main frame のナビゲーション。
 * - URL の Origin が許可 Origin に含まれる。
 * - 残りの回数が 1 以上の整数。
 * - 送信先のどれかに当たる（`matchesSubmissionEndpoint`）。
 */
function isAllowedSubmissionPost(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  remainingPosts: number,
  endpoints: readonly SubmissionEndpoint[],
  queryRule: EndpointQueryRule,
): boolean {
  if (
    facts.method !== SUBMISSION_POST_METHOD
    || !facts.isNavigationRequest
    || !facts.isMainFrame
    || !hasRemainingPosts(remainingPosts)
    || !hasAllowedOrigin(facts.url, allowedOrigins)
  ) {
    return false;
  }
  return endpoints.some((endpoint) => matchesSubmissionEndpoint(facts.url, endpoint, queryRule));
}

/**
 * 要求が、ログインの段で許す POST か（Task 25 の設計書 4.2）。`isAllowedSubmissionPost` の条件で、query は問わない（path までで比べる）。
 */
function isAllowedLoginPost(facts: HttpRequestFacts, allowedOrigins: ReadonlySet<string>, policy: LoginStagePolicy): boolean {
  return isAllowedSubmissionPost(facts, allowedOrigins, policy.remainingPosts, policy.loginPostEndpoints, ANY_QUERY);
}

/**
 * 要求が、書き込みの段で許す POST の形か（T30b。Task 30 の設計書 3 章）。`isAllowedSubmissionPost` の条件で、送信先は承認の要求の形の 1 つ
 * だけ、query と fragment は許さない。送る中身の照合は、この後に Guard が行う。
 */
function isAllowedWritePost(facts: HttpRequestFacts, allowedOrigins: ReadonlySet<string>, policy: WriteStagePolicy): boolean {
  return policy.apiOrigin === undefined && isAllowedSubmissionPost(facts, allowedOrigins, policy.remainingPosts, [policy.writeEndpoint], NO_QUERY);
}

/**
 * T39b（Task 39 の設計書 3.3）: 要求が、API の書き込みの段で照合にかける要求か。次をすべて満たすときだけ真。
 * - API の書き込みの段の口（`apiOrigin`）があり、送信の窓が開いていて、残りの回数が 1 以上。
 * - ナビゲーションでなく、main frame のページのスクリプトが送った（`mainFrameScript`）、種類が fetch か xhr（beacon・Worker・iframe は当たらない）。
 * - method が `POST`・`PATCH` で、URL の Origin が承認した API の Origin（`isApiWriteCheckTarget`）。
 * - T39R-fix（M-2）: URL の Origin と path が、承認の endpoint（`writeEndpoint`。承認した API の Origin と path の型）に当たる（`isApiWriteEndpointUrl`）。
 *   ほかの読み取りでない要求（別の path、手続きの呼び出し）は、照合にかけず、今の決まりで止めて記録する（書き込みの機会を使い切らない）。
 * query・ヘッダ・本文は、この後に Guard が照合（`checkApiWritePayload`）で照らす。
 */
function isAllowedApiWrite(facts: HttpRequestFacts, policy: WriteStagePolicy): boolean {
  return policy.apiOrigin !== undefined
    && policy.submissionWindowOpen === true
    && hasRemainingPosts(policy.remainingPosts)
    && !facts.isNavigationRequest
    && facts.mainFrameScript === true
    && isScriptRequestResourceType(facts.resourceType)
    && isApiWriteCheckTarget(facts.method, facts.url, policy.apiOrigin)
    && isApiWriteEndpointUrl(facts.url, apiWriteCheckEndpointOf(policy));
}

/**
 * LU-5（fix round 1 の案 A）: 照合へ回す要求の送信先（`apiWritePath` があれば Origin は `writeEndpoint` のまま、path はそれ。なければ `writeEndpoint`）。
 */
const apiWriteCheckEndpointOf = (policy: WriteStagePolicy): SubmissionEndpoint => (policy.apiWritePath === undefined
  ? policy.writeEndpoint
  : { origin: policy.writeEndpoint.origin, path: policy.apiWritePath });

/**
 * URL が、書き込みの段の送信先（承認の要求の形の Origin と path）に当たるか（T30b）。query と fragment のある URL、認証情報を含む URL、
 * 解析できない URL は偽。送る中身の照合（`src/safety/write-payload-policy.ts` の (a)）が、要求の判定と同じ比べ方で使う。
 */
export const isWriteEndpointUrl = (url: string, endpoint: SubmissionEndpoint): boolean =>
  matchesSubmissionEndpoint(url, endpoint, NO_QUERY);

/**
 * T39a（Task 39 の設計書 3.2、3.3）: 書き込みの段の要求を、承認した API の要求の照合（`src/safety/api-write-payload-policy.ts`）にかけるか。method が
 * `API_WRITE_METHODS`（`POST`・`PATCH`。大文字と小文字を問わない。照合は method を書かれたままの形で比べる）で、URL の Origin が承認した API の Origin
 * （`apiOrigin`。許可 Origin と同じ意味の正規化）のときだけ真。Guard の組み込み（窓の中の 1 回目だけを照合にかける）は T39b。
 */
export const isApiWriteCheckTarget = (method: string, url: string, apiOrigin: string): boolean =>
  typeof method === 'string'
  && (API_WRITE_METHODS as readonly string[]).includes(method.toUpperCase())
  && hasAllowedOrigin(url, new Set([apiOrigin]));

/**
 * T39a: URL の Origin と path が、承認した API の要求の型（`endpoint` の Origin と path）と完全に一致するか。query は問わない（名前の集合と filter は
 * 照合の部品が照らす）。認証情報を含む URL と、解析できない URL は偽。比べ方は、送信の段の送信先の比べ方（`matchesSubmissionEndpoint`）と同じ。
 */
export const isApiWriteEndpointUrl = (url: string, endpoint: SubmissionEndpoint): boolean =>
  matchesSubmissionEndpoint(url, endpoint, ANY_QUERY);

/** スクリプトで送るログインの段の、読み取りでない要求の判定の結果（T34b）。 */
type ScriptLoginVerdict =
  | { readonly kind: 'ADMIT'; readonly admission: LoginStageAdmission }
  | { readonly kind: 'BLOCK'; readonly reason: ScriptLoginBlockReason };

/** 許可 Origin と承認したサービスの Origin を合わせた一覧（スクリプトの送信が届いてよい Origin）。 */
const scriptReachableOrigins = (allowedOrigins: ReadonlySet<string>, script: ScriptRequestLoginPolicy): ReadonlySet<string> =>
  new Set([...allowedOrigins, ...script.approvedServiceOrigins]);

/**
 * スクリプトで送るログインの段の、読み取りでない要求の判定（T34b。Task 34 の設計書 3.3 の 3〜5）。送信先の比べ方は、送信の段の送信先の比べ方
 * （`matchesSubmissionEndpoint`）を使う（第二の比べ方を作らない）。
 * - method が `POST` でない、URL が許可 Origin とサービスの Origin の外: `UNREGISTERED_NON_READ`。
 * - token の送信先の Origin・path・必須の query に完全に一致: 種類が fetch か xhr で、残りの回数があれば通す。種類が違えば
 *   `TOKEN_REQUEST_NOT_SCRIPT`、回数がなければ `TOKEN_REQUEST_OVER_LIMIT`。
 * - token の送信先の Origin と path に一致するが query が違う: `TOKEN_REQUEST_QUERY_MISMATCH`。
 * - 登録したログインに伴う送信の Origin・path・method に一致: 一致する項目のうち、残りの回数がある最初の項目で通す（種類が fetch か xhr のとき）。
 *   種類が違えば `SIDE_REQUEST_NOT_SCRIPT`、どの項目にも回数がなければ `SIDE_REQUEST_OVER_LIMIT`。
 * - それ以外: `UNREGISTERED_NON_READ`。
 * RB-14b（X1）: ログインの段と書き込みの段の口を両方渡す誤りは、型で作れない（前の `admissible` の fail-closed は外した）。
 */
function scriptLoginVerdict(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: LoginStagePolicy,
  script: ScriptRequestLoginPolicy,
): ScriptLoginVerdict {
  const unregistered: ScriptLoginVerdict = { kind: 'BLOCK', reason: 'UNREGISTERED_NON_READ' };
  if (facts.method !== SUBMISSION_POST_METHOD || !hasAllowedOrigin(facts.url, scriptReachableOrigins(allowedOrigins, script))) {
    return unregistered;
  }
  const scriptType = isScriptRequestResourceType(facts.resourceType);
  const { scriptLogin } = script;
  if (matchesSubmissionEndpoint(facts.url, scriptLogin, { kind: 'EXACT', parameters: scriptLogin.requiredQuery })) {
    if (!scriptType) {
      return { kind: 'BLOCK', reason: 'TOKEN_REQUEST_NOT_SCRIPT' };
    }
    return hasRemainingPosts(policy.remainingPosts)
      ? { kind: 'ADMIT', admission: { kind: 'SCRIPT_LOGIN_TOKEN' } }
      : { kind: 'BLOCK', reason: 'TOKEN_REQUEST_OVER_LIMIT' };
  }
  if (matchesSubmissionEndpoint(facts.url, scriptLogin, ANY_QUERY)) {
    return { kind: 'BLOCK', reason: 'TOKEN_REQUEST_QUERY_MISMATCH' };
  }
  // T35b: 登録したログインに伴う送信は、段を問わない共通の判定（`registeredSubmissionVerdict`）で決め、理由をログインの段の理由に写す（値は今のまま）。
  const side = registeredSubmissionVerdict(facts, script.loginSideRequests, true);
  switch (side.kind) {
    case 'NO_MATCH':
      return unregistered;
    case 'ADMIT':
      return { kind: 'ADMIT', admission: { kind: 'LOGIN_SIDE_REQUEST', index: side.index } };
    case 'BLOCK':
      return { kind: 'BLOCK', reason: side.reason === 'NOT_SCRIPT' ? 'SIDE_REQUEST_NOT_SCRIPT' : 'SIDE_REQUEST_OVER_LIMIT' };
  }
}

/**
 * 利用者が登録した送信の判定（T35b。Task 34 のログインに伴う送信の判定を、段を問わない共通の関数にした。ログインの段のログインに伴う送信と、監査の段の
 * 読み取りの手続きの呼び出しが使う）。送信先の比べ方は、送信の段の送信先の比べ方（`matchesSubmissionEndpoint` の `ANY`）。
 * - `POST` で、Origin・path・method が一致する項目がなければ `NO_MATCH`（呼び出し側が段の理由で止める）。
 * - 種類が fetch か xhr でなければ `NOT_SCRIPT`。
 * - 一致する項目のうち、残りの回数がある最初の項目で通す（`admissible` のとき）。どの項目にも回数がないか、`admissible` が偽なら `OVER_LIMIT`。
 */
export function registeredSubmissionVerdict(
  facts: HttpRequestFacts,
  endpoints: readonly RegisteredSubmissionEndpoint[],
  admissible: boolean,
): RegisteredSubmissionVerdict {
  if (facts.method !== SUBMISSION_POST_METHOD) {
    return { kind: 'NO_MATCH' };
  }
  const matching = endpoints
    .map((endpoint, index) => ({ endpoint, index }))
    .filter(({ endpoint }) => endpoint.method === SUBMISSION_POST_METHOD && matchesSubmissionEndpoint(facts.url, endpoint, ANY_QUERY));
  if (matching.length === 0) {
    return { kind: 'NO_MATCH' };
  }
  if (!isScriptRequestResourceType(facts.resourceType)) {
    return { kind: 'BLOCK', reason: 'NOT_SCRIPT' };
  }
  const admitted = admissible ? matching.find(({ endpoint }) => hasRemainingPosts(endpoint.remainingPosts)) : undefined;
  return admitted === undefined ? { kind: 'BLOCK', reason: 'OVER_LIMIT' } : { kind: 'ADMIT', index: admitted.index };
}

/** 監査の段の、読み取りでない要求の判定の結果（T35b）。 */
type AuditStageVerdict =
  | { readonly kind: 'ADMIT'; readonly admission: AuditStageAdmission }
  | { readonly kind: 'BLOCK'; readonly reason: AuditStageBlockReason };

/**
 * スクリプトで送るログインの監査の段の、読み取りでない要求の判定（T35b。Task 35 の設計書 3.2）。
 * - token の送信先の Origin と path への `POST` で、query が必須の query と違う（更新など）: `TOKEN_REFRESH`（種類を問わない）。
 * - method が `POST` でない、URL が許可 Origin とサービスの Origin の外: `UNREGISTERED_NON_READ`。
 * - 登録した読み取りの手続きの呼び出し（`registeredSubmissionVerdict`）: 通す（送信先がサービスの Origin かを添える）か、共通の理由を写して止める。
 * - それ以外（token の送信先への必須の query の POST、サーバの関数、計測の送信など）: `UNREGISTERED_NON_READ`。
 * `admissible` が偽（API の書き込みの段の送信の窓の中）のときは、どれも通さない。
 */
/**
 * token の更新の形（監査の段の判定の `TOKEN_REFRESH`。唯一の比べ方）: token の送信先の Origin と path への `POST` で、query が必須の query と違う。
 * DEF-233: 凍結の段の判定（`isFrozenTokenRefreshAdmissible`）と、凍結で止めた更新の数え方（`isTokenRefreshRequest`）も、これを使う。
 */
function isTokenRefreshShape(facts: Pick<HttpRequestFacts, 'method' | 'url'>, stage: AuditStagePolicy): boolean {
  const { scriptLogin } = stage;
  return facts.method === SUBMISSION_POST_METHOD
    && matchesSubmissionEndpoint(facts.url, scriptLogin, ANY_QUERY)
    && !matchesSubmissionEndpoint(facts.url, scriptLogin, { kind: 'EXACT', parameters: scriptLogin.requiredQuery });
}

/**
 * 監査の段の口の判定（T35b）。登録した読み取りの手続きの ADMIT は、監査の段（`classifyStrictPassiveRequest`）と凍結の読み取り（`isRegisteredReadProcedureCall`）の
 * 両方が使う唯一の場所。SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 監査の段では、削除と危険な語と読まないパスでは止めない
 * （前の SREV-SAFE の C-1 と T35R-fix の M-1 の止めは外した）。凍結の読み取りは、`isFrozenReadAdmissible` が削除と危険な語を除く（守り 2）。
 */
function auditStageVerdict(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  stage: AuditStagePolicy,
  admissible: boolean,
): AuditStageVerdict {
  if (isTokenRefreshShape(facts, stage)) {
    return { kind: 'BLOCK', reason: 'TOKEN_REFRESH' };
  }
  const unregistered: AuditStageVerdict = { kind: 'BLOCK', reason: 'UNREGISTERED_NON_READ' };
  if (!hasAllowedOrigin(facts.url, new Set([...allowedOrigins, ...stage.approvedServiceOrigins]))) {
    return unregistered;
  }
  const read = registeredSubmissionVerdict(facts, stage.auditReadRequests, admissible);
  switch (read.kind) {
    case 'NO_MATCH':
      return unregistered;
    case 'ADMIT':
      return {
        kind: 'ADMIT',
        admission: { kind: 'AUDIT_READ_REQUEST', index: read.index, serviceOrigin: hasAllowedOrigin(facts.url, new Set(stage.approvedServiceOrigins)) },
      };
    case 'BLOCK':
      return { kind: 'BLOCK', reason: AUDIT_STAGE_REGISTERED_REASONS[read.reason] };
  }
}

/** 送信の段の口が、スクリプトで送るログインの段の口か（T34b）。 */
const isScriptLoginStagePolicy = (policy: SubmissionStagePolicy): boolean =>
  'scriptRequest' in policy && policy.scriptRequest !== undefined;

/**
 * 承認したサービスの Origin への、ナビゲーションでない読み取りか（T34b。Task 34 の設計書 3.3 の 2。クロールはしないので、main frame とサブ frame の
 * 移動は含めない）。
 */
const isServiceOriginRead = (facts: HttpRequestFacts, script: ScriptRequestLoginPolicy): boolean =>
  isReadMethod(facts.method) && !facts.isNavigationRequest && hasAllowedOrigin(facts.url, new Set(script.approvedServiceOrigins));

/**
 * T44R の M-1: 手動のログインの段の、token の送信先がまだない設定の、承認したサービスの Origin への読み取りか（`LoginStagePolicy.manualServiceReadOrigins`）。
 * 手動の段の印があり、スクリプトの口がないときだけ（RB-14b: ほかの段の口とは型で一緒に作れない）。
 */
const isManualServiceOriginRead = (facts: HttpRequestFacts, policy: PassiveRequestPolicyOptions): boolean => {
  const login = policy.authSetup;
  return login !== undefined
    && login.manualPassThrough === true
    && login.scriptRequest === undefined
    && login.manualServiceReadOrigins !== undefined
    && isReadMethod(facts.method)
    && !facts.isNavigationRequest
    && hasAllowedOrigin(facts.url, new Set(login.manualServiceReadOrigins));
};

/**
 * 送信の窓の中で、値を運べないブラウザ自身の favicon の要求か（T26g-1。「Blocker: T26g-1」の行）。GET で、許可 Origin の、path がちょうど
 * `BROWSER_DEFAULT_FAVICON_PATH` で、query と fragment がない（URL の文字列にも `?` と `#` がない）ときだけ真。
 */
function isPlainBrowserFavicon(facts: HttpRequestFacts, allowedOrigins: ReadonlySet<string>): boolean {
  const parsed = parseUrl(facts.url);
  return facts.method === 'GET'
    && parsed !== null
    && !facts.url.includes('?')
    && !facts.url.includes('#')
    && parsed.pathname === BROWSER_DEFAULT_FAVICON_PATH
    && hasAllowedOrigin(facts.url, allowedOrigins);
}

/**
 * 送信の段（ログインの段と書き込みの段）だけの制限（T26g-1。T30b で共通にした）。許した POST と、今の判定で止まる要求（GET と HEAD 以外、
 * 許可 Origin の外への main frame の移動）の後に、読み取りの要求に働く。送信の窓が開いていれば、すべて止める（favicon だけ理由を分ける）。
 * 閉じていれば、許可 Origin の外（解析できない URL を含む）を止める。止めなければ `null`。
 */
function submissionStageBlockReason(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: SubmissionStagePolicy,
): SubmissionStageBlockReason | null {
  // T34b: スクリプトで送るログインの送信の窓（token の送信を通した時点から成功の確かめまで）では、許可 Origin の中の読み取りを通す（token の
  // 送信、ログインに伴う送信、サービスの Origin への読み取りは、この前に通している）。窓の外への読み取りは、窓の中の要求として止める。
  if (policy.submissionWindowOpen === true && isScriptLoginStagePolicy(policy)) {
    return hasAllowedOrigin(facts.url, allowedOrigins) ? null : 'SUBMISSION_WINDOW';
  }
  if (policy.submissionWindowOpen === true) {
    return isPlainBrowserFavicon(facts, allowedOrigins) ? 'SUBMISSION_WINDOW_BROWSER_FAVICON' : 'SUBMISSION_WINDOW';
  }
  return hasAllowedOrigin(facts.url, allowedOrigins) ? null : 'OUTSIDE_ALLOWED_ORIGINS';
}

// 比べる path の形の作り方（percent-encode を戻す、連続した `/` をまとめる、各 segment の引数を外す、`.` と `..` の解決、除外の比べでは NFKC と
// 大文字・小文字の畳み込みも。T25g-1）は、core の `src/core/audit-exclusion-forms.ts` が唯一の owner（CC-100。保存の検証と同じ形を使う）。

/**
 * 監査の段の除外に当たるか（Task 25 の設計書 4.2）。許可 Origin への要求だけを調べる（許可 Origin の外の要求は、今の判定のまま）。
 * 解析できない URL は、当たるものとする（fail-closed）。
 * - path は、core の `auditScopePathFormsOf`・`exclusionMatchPathFormsOf`（CC-100）のすべての形で調べる（生の値、decode した値、連続した `/` をまとめた形、各 segment の `;` から後を外した
 *   形、`.` と `..` を解決した形と、それらの重ね。T25g-1）。サーバがどの形で読んでもよいように、除外のパスと危険な語は、どれか 1 つの
 *   形に当たれば止める。この 2 つの比べには、Unicode の正規化と大文字小文字の畳み込みの形も加える（T25g-1 round 1）。
 * - 読む範囲は、畳み込みの形を使わずに（大文字と小文字を区別して）、すべての形が当たらなければ止める（畳み込みで範囲を広げない）。
 * - 危険な語は、path のすべての形と、query の生の値と decode した値（と、その畳み込みの形）を、小文字にして調べる。fragment はサーバに
 *   送られないので調べない。
 * SD-2: 要求の判定では当てず、移る前の判定と移った画面の判定（文書の URL）だけが使うので、前の T35b の静的な資源の読み取りの例外（`STATIC_SUBRESOURCE_TYPES`）は外した。
 */
function isAuditExcluded(url: string, allowedOrigins: ReadonlySet<string>, policy: AuditExclusionPolicy): boolean {
  const forms = auditExclusionFormsOf(url);
  if (forms === null) {
    return true;
  }
  if (!hasAllowedOrigin(url, allowedOrigins)) {
    return false;
  }
  if (hitsExcludedPath(forms, policy)) {
    return true;
  }
  if (policy.auditPathPrefixes.length > 0 && !isInsideAuditScope(forms.scopePathForms, policy.auditPathPrefixes)) {
    return true;
  }
  return hitsDangerousTerm(forms, policy);
}

/**
 * 登録した読み取りの手続きの呼び出しが、読まないパスか危険な語に当たるか（T35R-fix。T35R の M-1）。Origin（許可 Origin かサービスの Origin）と読む範囲
 * （`auditPathPrefixes`。画面のパスの範囲）は見ない。比べ方は `isAuditExcluded` と同じ（URL として読めない、path の形を作れなければ当たる。fail-closed）。
 */
function isExcludedOrDangerous(url: string, policy: AuditExclusionPolicy): boolean {
  const forms = auditExclusionFormsOf(url);
  return forms === null || hitsExcludedPath(forms, policy) || hitsDangerousTerm(forms, policy);
}

/**
 * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口（`policy.auditSend`）で、今の決まりなら
 * 止める読み取りでない要求を、どう扱うか（口を使わない要求は `null`。呼び出し側が今の決まりで止める）。
 * - 口を使わない（`null`）: 口がない（人が選んだ READ_ONLY）、書き込みの段の口と一緒で書き込みの段の決まりに当たらない（OP-N。
 *   `writeStageAuditSendApplies`）、読み取り、許可 Origin の外への main frame のナビゲーション（RB-4b: ほかの文書のナビゲーションは通す）、http(s) の URL
 *   でない（読めない URL を含む）。スクリプトで送るログインの監査の段の口と一緒のときは、加えて、サービスの Origin へ送らない Context
 *   （`serviceOriginRequestsWithheld`）のサービスの Origin への要求。AS-c: 送り先の Origin の制限はなくした。token の更新（`TOKEN_REFRESH`）も通す。
 *   SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1・2.4）: method の `DELETE`、method の上書きの `DELETE`、危険な語と読まないパスの
 *   止めは外した（サイトのページが自分で出す通信は止めない。削除の守りは BeakSight の操作の前の判定）。
 * - 通す: `auditSendAdmission` の印を付けた ALLOW（Guard が記録する。RB-4a の X2: 数えない）。
 */
function auditSendDecisionOf(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision | null {
  const { auditSend } = policy;
  if (
    // 人が選んだ READ_ONLY（送信の扱いの口がない）: 読み取りでない要求を止める。
    auditSend === undefined
    || isReadMethod(facts.method)
    // RB-4b（X1）・SD-2（設計書 2.4）: 文書のナビゲーション（ページの script の form の送信を含む。許可 Origin の外への main frame の移動も）も通す。
    // AS-c: 送り先の Origin の制限はなくした（http(s) の URL であることだけを求める）。token の更新（`TOKEN_REFRESH`）も通す。
    || !isHttpUrl(facts.url)
    || isWithheldServiceOriginRequest(facts.url, policy)
    // OP-N（N2）: 書き込みの段では、加えて書き込みの段の決まり（`writeStageAuditSendApplies`）を満たす要求だけに使う（本文を読みうるので最後に確かめる）。
    || (policy.writeStage !== undefined && !writeStageAuditSendApplies(facts, policy.writeStage))
    // OP-Q（Q1）: 書き込みの作業の中の Passive の Context（送る前の確かめと照合の READ）も、同じ決まり（値を入れる前の形）を満たす要求だけに使う。
    || (auditSend.writeJobEndpoint !== undefined
      && !writeStageAuditSendApplies(facts, { writeEndpoint: auditSend.writeJobEndpoint }))
  ) {
    return null;
  }
  return { action: 'ALLOW', delivery: facts.isNavigationRequest && facts.isMainFrame ? 'INSPECT_REDIRECTS' : 'DIRECT', auditSendAdmission: true };
}

/**
 * OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N1・N2）: 書き込みの段の口と一緒のときに、監査の段の送信の扱いの口を使ってよい要求か
 * （`auditSendDecisionOf` のほかの条件に加える。当たれば使わず、今の書き込みの段の決まりで止める）。RB-4b: 送信の窓・値を入れた後・許可の外の止め（前の N1 と
 * OP-REV3 の C-2）は外した。
 * - 承認した送信の送信先（`writeEndpoint`）の Origin で、その path とその下の path への要求: 使わない（数える書き込みは、承認した 1 件だけ）。OP-REV3（I-1）: path
 *   は、監査の段の除外の前方一致と同じ部品（`isExcludedOrDangerous`。末尾の `/`、`//`、大文字と小文字、`%XX`、`;` の引数、`.` と `..` を正規化した形のどれか）で
 *   比べる。読めない URL は当たる（fail-closed）。
 * OP-Q（4.1.8 の Q1）: 書き込みの作業の中の Passive の Context（送る前の確かめと照合の READ。送信の窓を持たない）も、この判定を使う（送信先は口の印
 * `writeJobEndpoint`。窓と値の印はない）。
 */
function writeStageAuditSendApplies(
  facts: HttpRequestFacts,
  writeStage: Pick<WriteStagePolicy, 'writeEndpoint' | 'guardedPathShape'>,
): boolean {
  // RB-4b（設計書 `2026-11-15-beaksight-test-rebuild-design.md` 3.2。ユーザーの判断「書き込みの最中も、サイトが出す予定にない送信を止めない」）: 送信の窓と
  // 値を入れた後の止め、許可の外への止めは外した。残すのは、BeakSight が送る書き込みの照合（承認した送信先とその下への、照合の外の書き込みを通さない）だけ。
  return !isUnderWriteEndpoint(facts.url, guardedWriteEndpointOf(writeStage));
}

/** LU-SFIX3-B: フォームの更新では、守る送信先の path を型（`guardedPathShape`）にする（型と表の path を守る。API の path の形と同じ比べ方）。 */
const guardedWriteEndpointOf = (writeStage: Pick<WriteStagePolicy, 'writeEndpoint' | 'guardedPathShape'>): SubmissionEndpoint =>
  (writeStage.guardedPathShape === undefined
    ? writeStage.writeEndpoint
    : { origin: writeStage.writeEndpoint.origin, path: writeStage.guardedPathShape });

/**
 * L12a（設計書 `2026-11-09-beaksight-remove-limits-design.md` 2・3、L12 の判断）: 書き込みの段の押した後（口 `writeStage.afterPress` があるとき）の要求の扱い
 * （扱わない要求は `null`。呼び出し側が今の書き込みの段の決まりで止める）。ユーザーの方針「削除以外は全て通す」を、押した後のページの送信に当てる。
 * - 承認した送信の照合（`isAllowedWritePost`・`isAllowedApiWrite`）は、この前に働く（BeakSight が押した 1 回の本文は、照合に一致したものだけを送る）。
 * - 扱わない: http(s) でない URL、承認した応答を受ける前の、承認の送信先とその下への読み取りでない要求、リダイレクトの続きの読み取りでない要求。SD-2（設計書
 *   `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: `DELETE`・DELETE の上書き・危険な語と読まないパス・許可 Origin の外への main frame の移動の
 *   止めは外した（押した後のページの送信も移動も止めない）。
 * - 通す: 読み取り（送信の窓の中も。送り先の Origin を問わない）と、読み取りでない要求（ナビゲーションの form の送信を含む。送り先の Origin を問わない。数えない）。
 *   読み取りでない要求には `auditSendAdmission` の印を付ける（Guard が、承認した送信のほかの送信として通した一覧に記録する。承認の回数には数えない）。
 * 入れた値が、ほかの Origin への要求で届きうる（設計者の判断 4。監査の段と同じ）。
 */
function writeStageAfterPressDecisionOf(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision | null {
  const afterPress = policy.writeStage?.afterPress;
  if (afterPress === undefined || policy.writeStage === undefined || !isHttpUrl(facts.url)) {
    return null;
  }
  const mainFrameNavigation = facts.isNavigationRequest && facts.isMainFrame;
  const delivery = mainFrameNavigation ? 'INSPECT_REDIRECTS' : 'DIRECT';
  if (isReadMethod(facts.method)) {
    return { action: 'ALLOW', delivery };
  }
  // L12b: リダイレクトの続き（307・308 の本文の送り直し）は、ページが自分で出す送信ではない（承認した送信の送り直しになりうる）ので通さない。
  if (facts.redirectReplay === true) {
    return null;
  }
  if (!afterPress.approvedWriteResponded) {
    const { writeStage } = policy;
    const guarded = guardedWriteEndpointOf(writeStage);
    // API の書き込みの段は、照合へ回す path（`apiWritePath`）も守る（path の形の更新の具体的な path）。
    if (isUnderWriteEndpoint(facts.url, guarded)
      || (writeStage.apiWritePath !== undefined && isUnderWriteEndpoint(facts.url, { origin: writeStage.writeEndpoint.origin, path: writeStage.apiWritePath }))) {
      return null;
    }
  }
  return { action: 'ALLOW', delivery, auditSendAdmission: true };
}

/**
 * RB-14b（X1）: WebSocket の接続を通すか（通さないなら `null`。呼び出し側が `PASSIVE_WEBSOCKET` で止める）。前の 3 つの判定（AS-c の送信の扱いの口・L12a の
 * 書き込みの段の押した後・RB-4b のリアルタイムの通信）を 1 つにした。どれかの口で通せば通す（答えは前の 3 つの「どれか」と同じ）。
 * - 送信の扱いの口（WebSocket の印 `webSockets` つき）: 書き込みの段と書き込みの作業の中の Context では使わない。
 * - 書き込みの段の押した後の口（`writeStage.afterPress`）。
 * - リアルタイムの通信を止めない口（`realtimePassThrough`）。
 * どの口も、`ws:`・`wss:` でない接続は通さない。送信の扱いの口とリアルタイムの口は、サービスの Origin へ送らない Context のサービスの Origin への接続も
 * 通さない。SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 危険な語と読まないパスの止めは外した（Worker の中の接続も同じ）。
 * ログインの段の口には、どの口もないので、ログインの段の接続は今どおり止める（守り 3）。
 */
function webSocketPassDecisionOf(facts: WebSocketRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision | null {
  if (!isWebSocketUrl(facts.url)) {
    return null;
  }
  const { auditSend } = policy;
  const withheld = isWithheldServiceOriginRequest(httpEquivalentOfWebSocketUrl(facts.url), policy);
  const passes = (auditSend?.webSockets === true && policy.writeStage === undefined && auditSend.writeJobEndpoint === undefined && !withheld)
    || policy.writeStage?.afterPress !== undefined
    || (policy.realtimePassThrough === true && !withheld);
  return passes ? { action: 'ALLOW', delivery: 'DIRECT', auditSendWebSocketAdmission: true } : null;
}

/**
 * LU-SFIX3-B（LU-SREV3 の Important-2）: フォームの更新の、窓の前（N2）に守る送信先の path の型の唯一の作り方。送信先の path の最後の区切りが対象の番号
 * （`recordId`。空でない）なら、その区切りを `{id}`（`PATH_TEMPLATE_ID_SEGMENT`）にした形。そうでなければ null（登録や、番号が途中にある形。今のまま）。
 */
export function recordPathShapeOf(path: string, recordId: string): string | null {
  const segments = path.split(WRITE_ENDPOINT_PATH_SEPARATOR);
  if (recordId.length === 0 || segments.length < 2 || segments.at(-1) !== recordId || path.includes(PATH_TEMPLATE_ID_SEGMENT)) {
    return null;
  }
  return [...segments.slice(0, -1), PATH_TEMPLATE_ID_SEGMENT].join(WRITE_ENDPOINT_PATH_SEPARATOR);
}

/**
 * OP-REV3（I-1）: URL が、承認した送信の送信先の Origin で、その path かその下の path に当たるか（比べ方は監査の段の除外の前方一致 `isExcludedOrDangerous`。送信先の
 * Origin か path が空なら、どの URL も当たる。fail-closed）。
 * OP-R（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.9 の R3。OP-REV5 の C-2）: 送信先の path の型に `{id}`・`[REDACTED]` の区切りがあるときも、区切りごとに
 * 比べる（`isUnderWriteEndpointShape`。前方一致の比べに加える。どちらかに当たれば当たる）。
 * LU-SFIX1（LU-SREV1 の Important-1）: 比べる path は、守る送信先の path の一覧（`guardedWriteEndpointPathsOf`。path の形の更新では表の一覧の path を含む）。
 */
const isUnderWriteEndpoint = (url: string, endpoint: SubmissionEndpoint): boolean => {
  if ([endpoint.origin, endpoint.path].includes('')) {
    return true;
  }
  const guardedPaths = guardedWriteEndpointPathsOf(endpoint.path);
  return hasAllowedOrigin(url, new Set([endpoint.origin]))
    && (isExcludedOrDangerous(url, { excludedPathPrefixes: guardedPaths, auditPathPrefixes: [], dangerousTerms: [] })
      || guardedPaths.some((path) => isUnderWriteEndpointShape(url, path)));
};

/**
 * LU-SFIX1（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.3 の 3。LU-SREV1 の Important-1）: 窓の前（N2）に守る送信先の path の一覧（唯一の
 * 組み立て）。送信先の path の型そのものに加え、path の形の更新（型の最後の区切りが `{id}`。`pathShapeEndsWithRecordId`）では、`{id}` の 1 つ上の path（表の
 * 一覧の path。台帳の登録の path と同じ）も守る（filter の形の期待が守る範囲と同じ強さ）。1 つ上の path が空なら `/`（その Origin のすべての path。fail-closed）。
 * 比べ方は、どの path も同じ（`isUnderWriteEndpoint` の前方一致と区切りごとの比べ）。
 */
const guardedWriteEndpointPathsOf = (endpointPath: string): readonly string[] => {
  if (!pathShapeEndsWithRecordId(endpointPath)) {
    return [endpointPath];
  }
  const parent = endpointPath.split(WRITE_ENDPOINT_PATH_SEPARATOR).slice(0, -1).join(WRITE_ENDPOINT_PATH_SEPARATOR);
  return [endpointPath, parent === '' ? WRITE_ENDPOINT_PATH_SEPARATOR : parent];
};

/** OP-R（R3）: 送信先の path の型の、どの 1 区切りにも当たる区切り（`{id}` と伏せ字。比べる形は、監査の段の除外の値と同じ小文字と畳み込みの形）。 */
const WRITE_ENDPOINT_WILDCARD_SEGMENTS: ReadonlySet<string> = new Set(
  [PATH_TEMPLATE_ID_SEGMENT, REDACTED_PATH_SEGMENT].flatMap((segment) => comparableExclusionValues(segment)),
);

/** path の区切り。 */
const WRITE_ENDPOINT_PATH_SEPARATOR = '/';

/**
 * OP-R（R3）: URL の path の形（監査の段の除外と同じ正規化の形 `auditExclusionFormsOf` のどれか）が、送信先の path の型に、区切りごとに当たるか（その path とその下の
 * path）。型の `{id}`・`[REDACTED]` の区切りは、どの 1 区切りにも当たる。ほかの区切りは同じ（最後の区切りは、前方一致の比べと同じく、その文字で始まれば当たる）。
 * 型の区切りがなければ偽（前方一致の比べだけで決める）。URL を読めない・形を作れないときは当たる（fail-closed）。
 */
const isUnderWriteEndpointShape = (url: string, endpointPath: string): boolean => {
  const shapes = comparableExclusionValues(endpointPath).map((shape) => {
    const segments = shape.split(WRITE_ENDPOINT_PATH_SEPARATOR);
    return segments.length > 1 && segments.at(-1) === '' ? segments.slice(0, -1) : segments;
  }).filter((segments) => segments.some((segment) => WRITE_ENDPOINT_WILDCARD_SEGMENTS.has(segment)));
  if (shapes.length === 0) {
    return false;
  }
  const forms = auditExclusionFormsOf(url);
  if (forms === null) {
    return true;
  }
  return forms.lowerPathVariants.some((path) => {
    const actual = path.split(WRITE_ENDPOINT_PATH_SEPARATOR);
    return shapes.some((shape) => actual.length >= shape.length && shape.every((segment, index) => {
      const value = actual[index] ?? '';
      if (WRITE_ENDPOINT_WILDCARD_SEGMENTS.has(segment)) {
        return true;
      }
      return index === shape.length - 1 ? value.startsWith(segment) : value === segment;
    }));
  });
};

/** URL が http(s) か（読めなければ偽）。 */
const isHttpUrl = (url: string): boolean => {
  const parsed = parseUrl(url);
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
};

/** URL が ws(s) か（読めなければ偽）。 */
const isWebSocketUrl = (url: string): boolean => {
  const parsed = parseUrl(url);
  return parsed !== null && (parsed.protocol === 'ws:' || parsed.protocol === 'wss:');
};

/** WebSocket の URL の Origin を、同じ host と port の http(s) の URL にする（サービスの Origin と比べるため。`ws:` → `http:`、`wss:` → `https:`）。 */
const httpEquivalentOfWebSocketUrl = (url: string): string => {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return url;
  }
  // Origin だけを比べるので、path は付けない（`hasAllowedOrigin` が Origin の正規の形で比べる）。
  const scheme = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${scheme}//${parsed.host}/`;
};

/**
 * 監査の段の送信の扱いの口で通さない、サービスの Origin へ送らない Context（`serviceOriginRequestsWithheld`）の、承認したサービスの Origin への要求か
 * （AS-a から。スクリプトで送るログインの監査の段の口と一緒のときだけ）。
 */
const isWithheldServiceOriginRequest = (url: string, policy: PassiveRequestPolicyOptions): boolean => {
  const { auditStage, auditSend } = policy;
  return auditStage?.serviceOriginRequestsWithheld === true
    && hasAllowedOrigin(url, new Set([...auditStage.approvedServiceOrigins, ...(auditSend?.approvedServiceOrigins ?? [])]));
};

/**
 * 監査の段の送信の扱いの口の危険な語（path と query）か、監査の段の除外の口の読まないパスか危険な語に当たるか（比べ方は監査の段の除外と同じ）。SD-2: 送信を
 * 止めるのには使わない。使うのは、凍結の段の読み取りと token の更新の判定（守り 2）と、通した WebSocket の記録の印（`isAuditSendDangerousWebSocket`）だけ。
 */
const isAuditSendDangerous = (url: string, policy: PassiveRequestPolicyOptions): boolean => {
  const dangerous: AuditExclusionPolicy = { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: policy.auditSend?.dangerousTerms ?? [] };
  return isExcludedOrDangerous(url, dangerous) || (policy.auditExclusions !== undefined && isExcludedOrDangerous(url, policy.auditExclusions));
};

/**
 * SAFE-2 の 3: 監査の段の口（`auditStage`）で ADMIT になる、登録した読み取りの手続きの呼び出しか（凍結の読み取りの判定 `isFrozenReadAdmissible` が使う）。ログインの段と
 * 書き込みの段の口と一緒のとき、ナビゲーションの要求、監査の段の口がないときは偽。回数の残り（`remainingPosts`）も、監査の段と同じく確かめる。
 */
const isRegisteredReadProcedureCall = (
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): boolean =>
  policy.auditStage !== undefined
  && policy.authSetup === undefined
  && policy.writeStage === undefined
  && !facts.isNavigationRequest
  && auditStageVerdict(facts, allowedOrigins, policy.auditStage, true).kind === 'ADMIT';

/**
 * DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1 と、Blocker の後の設計者の判断）: 操作さがしの凍結の段（`FROZEN_ACTIVE`）で、
 * Guard が監査の段と同じ判定（`classifyPassiveRequest` と資格情報の守り）にかけてよい読み取りか（凍結の読み取りの判定の唯一の場所）。偽なら、今どおり凍結で止める。
 * 真のときだけ、Guard が監査の段の判定にかけ、ALLOW なら通す（ほかは凍結で止める）。読み取りでない送信は、SAFE-2 の 3 から、監査の段で ADMIT になる登録した
 * 読み取りの手続きの呼び出し（`isRegisteredReadProcedureCall`）だけを同じ確かめにかける（ほかは凍結の間ずっと止める。押下の目印の確かめは Guard が行う）。
 * - 読み取り（GET・HEAD）か、登録した読み取りの手続きの呼び出しで、http(s) の URL。URL に認証情報を含まない。
 * - main frame の文書の移動でない（main frame の移動は probe の決まりのまま止める）。sub frame の文書の GET は、読み取りとして同じ判定にかける。
 * - 送り先が、許可 Origin か、承認したサービスの Origin（監査の段の送信の扱いの口と、スクリプトで送るログインの監査の段の口）。
 * - サービスの Origin へ送らない Context（`serviceOriginRequestsWithheld`）のサービスの Origin への要求でない。
 * - 危険な語と読まないパスに当たらない。ページの文書でない読み取りにも当てる（比べ方 `isExcludedOrDangerous`）。危険な語は、送信の扱いの口の一覧
 *   （`isAuditSendDangerous`）で、口がなければ既定の一覧（`DEFAULT_EXCLUDED_URL_WORDS`）。
 * - SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1。守り 2）: 削除の要求（`isDeleteRequest`。登録した読み取りの手続きの呼び出しの
 *   `DELETE` の上書きを含む）と、読み取りに付いたヘッダの `DELETE` の上書き（`isDeleteHeaderOverride`）は通さない（監査の段の判定から外した確かめを、凍結の段に残す）。
 */
export function isFrozenReadAdmissible(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions = {},
): boolean {
  if (!isHttpUrl(facts.url) || (facts.isNavigationRequest && facts.isMainFrame)) {
    return false;
  }
  // SAFE-2 の 3: 読み取りでない method は、監査の段で ADMIT になる登録した読み取りの手続きの呼び出しだけ（ログインの段・書き込みの段の口と一緒でないとき）。
  // 送り先・資格情報・危険な語の確かめは、読み取りと同じ（下）。
  if (!isReadMethod(facts.method) && !isRegisteredReadProcedureCall(facts, allowedOrigins, policy)) {
    return false;
  }
  if (isReadMethod(facts.method) ? isDeleteHeaderOverride(facts.sentContent) : isDeleteRequest(facts)) {
    return false;
  }
  // 資格情報の守り: URL に認証情報（`user:password@`）を含む要求は通さない（Guard の資格情報の守り `credentialCheckedDecision` は、判定の後に当たる）。
  const parsed = parseUrl(facts.url);
  if (parsed === null || hasUrlCredentials(parsed)) {
    return false;
  }
  const scope = new Set([
    ...allowedOrigins,
    ...(policy.auditSend?.approvedServiceOrigins ?? []),
    ...(policy.auditStage?.approvedServiceOrigins ?? []),
  ]);
  if (!hasAllowedOrigin(facts.url, scope) || isWithheldServiceOriginRequest(facts.url, policy)) {
    return false;
  }
  const defaultDangerous: AuditExclusionPolicy = { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS };
  return !isAuditSendDangerous(facts.url, policy)
    && !isExcludedOrDangerous(facts.url, defaultDangerous)
    && (policy.auditExclusions === undefined || !isExcludedOrDangerous(facts.url, policy.auditExclusions));
}

/**
 * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.1）: 操作さがしの凍結の段（`FROZEN_ACTIVE`）で、サイトのスクリプトの token の
 * 更新として通してよい要求か（凍結の段の token の更新の判定の唯一の部品。Guard の凍結の判定、凍結の段の CORS の事前確認、中継の凍結の受け入れが共用する）。
 * 真のときだけ、Guard が監査の段と同じ判定にかけ、ALLOW なら通す（ほかは今どおり凍結で止める）。次の全部を満たす要求だけ。
 * - 監査の段の判定で `TOKEN_REFRESH` になる形（`isTokenRefreshShape`。登録の token の送り先で、必須の query の値が違う `POST`）。ナビゲーションでない。
 * - 監査の段の送信の扱いが `PASS_EXCEPT_DELETE`（`auditSend` の口がある）。ログインの段と書き込みの段の口と一緒でない。
 * - http(s) の URL で、URL に認証情報（`user:password@`）を含まない（Guard の資格情報の守り `credentialCheckedDecision` は、判定の後に今どおり当たる）。
 * - 危険な語と読まないパスに当たらない（`isAuditSendDangerous`）。method の上書きが `DELETE` でない。サービスの Origin へ送らない Context の要求でない。
 * - fix round 2（SREV-233 の M-2）: query の名前の集合が、登録の token の送り先の必須の query の名前の集合と同じ（値が違ってよいのは必須の query の値だけ。
 *   余計な query・重なった名前は通さない）。
 * - 要求の中身（`content`。Guard が渡す。null は URL と方針だけを見る形で、中継の凍結の受け入れと、本文のない事前確認が使う）があれば、加えて次の全部。
 *   Blocker 1 の後の設計者の判断 (a): 押下の観察の間も、この条件で判定する（これらの条件では押下の値も任意の中身も運べず、届くのは鍵を回す本物の更新だけ）。
 *   - fix round 3（N-1）: 本文が、凍結の前に確かめた更新の本文と同じ形で、値は今の鍵の同じ名前の値だけ（`isReferencedRefreshBody`）。
 *   - fix round 3（N-1）: header が、凍結の前に確かめた更新の要求の header とちょうど同じ（`hasReferencedRefreshHeaders`）。
 *   - 本文と URL に、押すときに欄へ入れた目印を含まない（`carriesMarker`。ほかの条件を満たすときだけ呼ぶ。本文はそのときだけ読む）。
 */
export function isFrozenTokenRefreshAdmissible(
  facts: HttpRequestFacts,
  policy: PassiveRequestPolicyOptions,
  content: FrozenTokenRefreshContent | null,
  learnedQueryValues: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const stage = policy.auditStage;
  if (
    stage === undefined
    || policy.auditSend === undefined
    || policy.authSetup !== undefined
    || policy.writeStage !== undefined
    || facts.isNavigationRequest
    || !isTokenRefreshShape(facts, stage)
    || !isHttpUrl(facts.url)
  ) {
    return false;
  }
  const parsed = parseUrl(facts.url);
  if (
    parsed === null
    || hasUrlCredentials(parsed)
    || !hasExactRefreshQueryNames(parsed, stage.scriptLogin)
    || ![...parsed.searchParams.entries()].every(([name, value]) => isAdmittedRefreshQueryValue(name, value, learnedQueryValues))
  ) {
    return false;
  }
  if (isAuditSendDangerous(facts.url, policy) || isWithheldServiceOriginRequest(facts.url, policy) || isDeleteMethodOverride(facts.sentContent)) {
    return false;
  }
  if (content === null) {
    return true;
  }
  const { reference } = content;
  if (reference === null) {
    return false;
  }
  const body = content.body();
  return body.kind === 'TEXT'
    && isReferencedRefreshBody(body.text, reference)
    && hasReferencedRefreshHeaders(content.headers, reference)
    && !content.carriesMarker();
}

/**
 * fix round 2（SREV-233 の C-1・C-2）・fix round 3（N-1）: 凍結の段で通す token の更新の判定に、Guard が渡す要求の中身。
 * - `body`: 本文の読み取り（要るときだけ呼ぶ）。`headers`: 要求の header。
 * - `reference`: 比べの相手（凍結の前に通して確かめた更新の本文の形と header、今の鍵の値。factory が作る。Run の中で凍結の前に確かめた更新がなければ null で、
 *   通さない。B のログインし直しが受ける）。
 * - `carriesMarker`: 本文か URL が、押下の目印を運ぶか。
 */
export interface FrozenTokenRefreshContent {
  readonly body: () => RequestBodyText;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly reference: FrozenRefreshReference | null;
  readonly carriesMarker: () => boolean;
}

/**
 * fix round 3（SREV-233 の確かめ直しの N-1）: 凍結の段で通す token の更新の header が、凍結の前に通して確かめた更新の要求の header とちょうど同じか（小文字の
 * 名前の集合が同じで、どの値も同じ。読み取りの header は使わない。名前の有無や値で運ぶ形を通さない）。
 */
export function hasReferencedRefreshHeaders(headers: Readonly<Record<string, string>> | undefined, reference: FrozenRefreshReference): boolean {
  const entries = Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value] as const);
  return entries.length === reference.headers.size
    && new Set(entries.map(([name]) => name)).size === entries.length
    && entries.every(([name, value]) => reference.headers.get(name) === value);
}

/**
 * fix round 2（SREV-233 の M-2 の後の設計者の判断）: 凍結の段で通す更新の、必須の query の値として認める OAuth の標準の更新の値（一般の規格の語。target に固有の値で
 * ない）。
 */
export const OAUTH_REFRESH_GRANT_VALUE = 'refresh_token';

/**
 * fix round 2: 必須の query の値として認めるか。OAuth の標準の更新の値（`OAUTH_REFRESH_GRANT_VALUE`）か、同じ Run の中で凍結の前に通した更新の同じ名前の値
 * （`learnedQueryValues`。factory が Run の中で覚える）だけ。値が違うと、サーバでは更新とは別の処理（取り消し・別の付与など）になりうるため。
 */
const isAdmittedRefreshQueryValue = (name: string, value: string, learnedQueryValues: ReadonlyMap<string, ReadonlySet<string>>): boolean => {
  const learned = learnedQueryValues.get(name);
  // fix round 4（3 回目の確かめ直しの M-1）: 覚えた値があれば、その値だけ（標準の値も通さない。2 つの値の選び方で運ばせない）。
  return learned !== undefined && learned.size > 0 ? learned.has(value) : value === OAUTH_REFRESH_GRANT_VALUE;
};

/**
 * fix round 2: 凍結の前に通した token の更新の形の要求の、必須の query の名前と値（factory が Run の中で覚えるための取り出し。URL が読めない・名前が必須の query の
 * 名前とちょうど同じでない、は空）。
 */
export function refreshQueryValuesOf(url: string, policy: PassiveRequestPolicyOptions): readonly (readonly [string, string])[] {
  const parsed = parseUrl(url);
  const stage = policy.auditStage;
  if (parsed === null || stage === undefined || !hasExactRefreshQueryNames(parsed, stage.scriptLogin)) {
    return [];
  }
  return [...parsed.searchParams.entries()];
}

/** fix round 2（SREV-233 の M-2）: URL の query の名前（重なりを含む）が、必須の query の名前とちょうど同じか（順は問わない）。 */
const hasExactRefreshQueryNames = (url: URL, scriptLogin: ScriptLoginEndpoint): boolean => {
  const actual = [...url.searchParams.keys()].sort();
  const expected = scriptLogin.requiredQuery.map(({ name }) => name).sort();
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
};

/**
 * DEF-233（設計書 2.1 の 3）: 監査の段の判定で `TOKEN_REFRESH` になる形の要求か（監査の段の口がなければ偽）。Guard が、凍結で止めた更新を
 * `tokenRefreshBlocked` に数えるのに使う（形の比べ方は `isTokenRefreshShape` の 1 か所）。
 */
export function isTokenRefreshRequest(facts: Pick<HttpRequestFacts, 'method' | 'url'>, policy: PassiveRequestPolicyOptions): boolean {
  return policy.auditStage !== undefined && isTokenRefreshShape(facts, policy.auditStage);
}

/**
 * AS-c fix round 1（C-1・C-2）: ブラウザが実際に開いた WebSocket の接続（Guard の route を通らなかったものを含む）の URL が、監査の段の送信の扱いの口なら
 * 通さない危険な語か除外に当たるか（Guard が記録に印を付けるため。比べ方は `auditSendWebSocketDecisionOf` と同じ `isAuditSendDangerous`。読めない URL は当たる）。
 */
export const isAuditSendDangerousWebSocket = (url: string, policy: PassiveRequestPolicyOptions): boolean =>
  !isWebSocketUrl(url) || isAuditSendDangerous(url, policy);


/** method の上書きの値が `DELETE` か（前後の空白を除き、大文字と小文字を問わない。`,` で区切った並びは、どれか 1 つでも当たれば当たる）。 */
const isDeleteOverrideValue = (value: string): boolean =>
  value.split(',').some((part) => part.trim().toUpperCase() === DELETE_METHOD);

/**
 * AS-c fix round 1（I-2。設計書 5 章の「AS-R … とユーザーの判断」の行）: 要求の送る中身が、method の上書きで `DELETE` を伝えるか。SD-2: 使うのは、凍結の段の
 * 読み取りと token の更新の判定（守り 2）だけ（監査の段の送信の扱いでは止めない）。
 * - ヘッダ `X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override` の値が `DELETE`。
 * - form の本文（urlencoded と multipart）の `_method` の欄の値が `DELETE`。本文の欄は owner（`formMethodOverrideValuesOf`）が読む。form の本文が読めない・
 *   形が崩れている（`null`）なら当たる（fail-closed）。
 * - 中身がなければ（出口の中継の判定）、当たらない。JSON などの本文の中の削除（GraphQL・JSON-RPC）は見ない（`doc/spec/safety.md` の限界）。
 */
function isDeleteMethodOverride(content: RequestSentContent | undefined): boolean {
  if (content === undefined) {
    return false;
  }
  if (isDeleteHeaderOverride(content)) {
    return true;
  }
  const formValues = content.formMethodOverrides();
  return formValues === null || formValues.some(isDeleteOverrideValue);
}

/**
 * RB-14a（X1）: 削除の要求か（method が `DELETE`、または method の上書きが `DELETE`）。SD-2: 凍結の段の読み取りの判定（`isFrozenReadAdmissible`。登録した読み取りの
 * 手続きの呼び出し。守り 2）だけが使う。
 */
const isDeleteRequest = (facts: Pick<HttpRequestFacts, 'method' | 'sentContent'>): boolean =>
  facts.method.toUpperCase() === DELETE_METHOD || isDeleteMethodOverride(facts.sentContent);

/**
 * ヘッダの method の上書きが `DELETE` か（SREV-SAFE の I-2: 読み取りに当てる確かめ。読み取りの本文は意味を持たないので、本文の `_method` は見ない）。SD-2: 凍結の段の
 * 読み取りの判定（守り 2）だけが使う（監査の段の GET・HEAD の止めは外した）。
 * AS-c fix round 2: ヘッダの名前は、API の書き込みの照合（`METHOD_OVERRIDE_PRESENT`）と同じ一覧（`API_METHOD_OVERRIDE_HEADER_NAMES`）を共用する。
 */
function isDeleteHeaderOverride(content: RequestSentContent | undefined): boolean {
  return content !== undefined
    && API_METHOD_OVERRIDE_HEADER_NAMES.some((name) => isDeleteOverrideValue(headerValueOf(content.headers, name) ?? ''));
}

/** 除外の判定に使う、URL の形（読む範囲の path の形、照合の path の小文字の形、query とその解いた形）。 */
interface AuditExclusionForms {
  readonly scopePathForms: readonly string[];
  readonly lowerPathVariants: readonly string[];
  readonly search: string;
  readonly decodedQuery: string;
}

/** URL から、除外の判定に使う形を作る（URL として読めない、path の形を作れない、query を解けなければ `null`）。 */
function auditExclusionFormsOf(url: string): AuditExclusionForms | null {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return null;
  }
  const scopePathForms = auditScopePathFormsOf(parsed.pathname);
  const lowerPathVariants = exclusionMatchPathFormsOf(parsed.pathname);
  const decodedQuery = fullyPercentDecoded(parsed.search);
  if (scopePathForms === null || lowerPathVariants === null || decodedQuery === null) {
    return null;
  }
  return { scopePathForms, lowerPathVariants, search: parsed.search, decodedQuery };
}

/** 読まないパス（前方一致）に当たるか（比べ方の owner は core の `hitsExcludedPathPrefix`。T35R2-fix）。 */
const hitsExcludedPath = (forms: AuditExclusionForms, policy: AuditExclusionPolicy): boolean =>
  hitsExcludedPathPrefix(forms.lowerPathVariants, policy.excludedPathPrefixes);

/** 危険な語（path と query のどこか）に当たるか（比べ方の owner は core の `hitsDangerousTermIn`。T35R2-fix）。 */
const hitsDangerousTerm = (forms: AuditExclusionForms, policy: AuditExclusionPolicy): boolean =>
  hitsDangerousTermIn([
    ...forms.lowerPathVariants,
    forms.search.toLowerCase(),
    forms.decodedQuery.toLowerCase(),
    foldNfkcCase(forms.decodedQuery),
  ], policy.dangerousTerms);

/**
 * Passive の要求の判定（SSOT Owner Matrix の Passive HTTP authority の唯一の owner）。
 * - `policy` を省略した場合（と、空の場合）は、公開監査の判定（Task 22 の golden）と同じ。
 * - `policy.authSetup`（ログインの段の口）: 許した Origin と path への、main frame のナビゲーションの POST だけを ALLOW する
 *   （`isAllowedLoginPost`）。T26g-1: 加えて、今の判定で止まらない読み取りの要求のうち、許可 Origin の外へのもの（サブリソース、サブ frame の
 *   ナビゲーション）と、送信の窓の中のすべてを、`LOGIN_STAGE` で止める（`loginStageBlockReason`）。今の判定で止まる要求の判定と記録は
 *   変えない。
 * - `policy.auditExclusions`（監査の段の除外の口）: 許可 Origin への main frame の文書の GET と HEAD でも、除外に当たる URL を BLOCK する
 *   （`isAuditExcluded`。SD-2: サブの要求・子の frame・先読みには当てない）。GET と HEAD 以外の決まり、WebSocket、許可 Origin の外への main frame の
 *   移動の判定が先に働く。
 * - `policy.writeStage`（書き込みの段の口。T30b）: 承認の要求の形に完全に一致する（query と fragment なし）、main frame のナビゲーションの
 *   POST だけを、残りの回数が 1 以上のときに ALLOW する（`isAllowedWritePost`。送る中身の照合は、その後に Guard が行う）。ほかの要求は、
 *   ログインの段と同じく、許可 Origin の外と、送信の窓の中のすべてを `WRITE_STAGE` で止める（`submissionStageBlockReason`）。
 * - RB-14b: `authSetup` と、`writeStage`・`auditStage`・`auditSend`・`realtimePassThrough` は、型で一緒に作れない（`LoginStageRequestPolicy`）。
 * - `policy.authSetup.scriptRequest`（スクリプトで送るログインの口。T34b。Task 34 の設計書 3.3）: フォームの送信先への POST は許さず、読み取りで
 *   ない要求は `scriptLoginVerdict` で判定する（登録した token の送信とログインに伴う送信だけを、`loginStageAdmission` つきで ALLOW。ほかは
 *   `NON_READ_METHOD` に `scriptLoginBlock` を添えて BLOCK）。承認したサービスの Origin への、ナビゲーションでない GET と HEAD を ALLOW する
 *   （`SERVICE_ORIGIN_READ`）。CORS の事前確認は、今どおり Guard が判定の前に満たす。
 * - `policy.auditStage`（スクリプトで送るログインの監査の段の口。T35b。Task 35 の設計書 3.2、3.3）: 読み取りでない要求は `auditStageVerdict` で
 *   判定する（登録した読み取りの手続きの呼び出しだけを、`auditStageAdmission` つきで ALLOW。ほかは `NON_READ_METHOD` に `auditStageBlock` を添えて
 *   BLOCK）。承認したサービスの Origin への読み取りに `SERVICE_ORIGIN_READ` の印を付ける（通すかは今どおり）。
 * - `policy.auditSend`（監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口。AS-a）: 今の決まりなら止める読み取りでない要求のうち、`auditSendDecisionOf` の
 *   条件を満たすものを、`auditSendAdmission` つきで ALLOW。ほかは今どおり。
 */
export function classifyPassiveRequest(
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions = {},
): PassiveRequestDecision {
  // DEF-210（通知の枠の設計書 3.2.1）: 閉じる押下の期間は、その決まりを先に当てる（止めるものは、ほかの口で通さない）。
  // REV-EV4: 領域のキーの押下の期間も、その決まりを先に当てる。
  const pressed = scrollKeyPressDecisionOf(facts, policy) ?? notificationPressDecisionOf(facts, allowedOrigins, policy);
  if (pressed !== null) {
    return pressed;
  }
  const decision = classifyStrictPassiveRequest(facts, allowedOrigins, policy);
  return manualPassThroughOf(decision, facts, allowedOrigins, policy) ?? automatedLoginPassThroughOf(decision, facts, policy) ?? decision;
}

/**
 * SFIX-1104 の C-1 の 2: URL の query に、必須の query の名前のどれかがあり、その値のどれも登録の値と違うか（読めない URL は偽。止める側）。
 */
function requiredQueryValueDiffers(url: string, requiredQuery: readonly RequiredQueryParameter[]): boolean {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return false;
  }
  return requiredQuery.some(({ name, value }) => {
    const values = parsed.searchParams.getAll(name);
    return values.length > 0 && values.every((given) => given !== value);
  });
}

/**
 * DEF-193（設計書 `2026-11-04-beaksight-login-session-design.md` 3.2）: 自動ログインの段の口（`authSetup.automatedPassThrough`）で、今の決まりの判定（`decision`）が
 * 止める要求のうち、通すものの判定（通さないなら `null`。止めたまま）。ログインの段でも「サイトが自動で送る通信は、削除のほかは止めない」を当てる。
 * - 働くのは、スクリプトで送るログインの段の口だけのとき（手動の段の印と一緒なら働かない）。
 * - 通す: 判定が `NON_READ_METHOD` で、詳しい理由が `AUTOMATED_LOGIN_PASS_THROUGH_REASONS` の、ナビゲーションでない http(s) の読み取りでない要求。
 * - SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: `DELETE`・DELETE の上書き・危険な語と読まないパスでも止めない（前の DEF-194 の
 *   決まりで止めた印 `AUTOMATED_LOGIN_RULE_BLOCKED` は作らない。理由の値と文は、前の記録を読むために一覧に残す）。
 * 資格情報を含む要求は、通した後に Guard の守り（`credentialCheckedDecision`）が止める。送り先の Origin の制限は、監査の段の送信の扱いと同じく置かない。
 */
function automatedLoginPassThroughOf(
  decision: PassiveRequestDecision,
  facts: PassiveRequestFacts,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision | null {
  const login = policy.authSetup;
  // 詳しい理由（`scriptLoginBlock`）を持つのは、要求の止めた判定（`REQUEST`）だけ。
  if (
    decision.action !== 'BLOCK'
    || !('scriptLoginBlock' in decision)
    || decision.reason !== 'NON_READ_METHOD'
    || facts.kind !== 'HTTP'
    || login?.automatedPassThrough !== true
    || login.scriptRequest === undefined
    || login.manualPassThrough === true
  ) {
    return null;
  }
  const reason = decision.scriptLoginBlock;
  if (reason === undefined || !(AUTOMATED_LOGIN_PASS_THROUGH_REASONS as readonly string[]).includes(reason)) {
    return null;
  }
  // SFIX-1104（SREV-1104 の C-1 の 2）: token の送信先への query の違う送信を通すのは、登録したログインの送信の必須の query の値が違うとき（`grant_type` が
  // 登録の値でない、など。サイトの token の更新）だけ。必須の query をそのまま持ち、ほかの query を足しただけの送信は、今のとおり止める（BeakSight 自身の
  // ログインの送信の数の上限を守る）。必須の query の名前がない送信も止める。
  if (reason === 'TOKEN_REQUEST_QUERY_MISMATCH' && !requiredQueryValueDiffers(facts.url, login.scriptRequest.scriptLogin.requiredQuery)) {
    return null;
  }
  if (facts.isNavigationRequest || isReadMethod(facts.method) || !isHttpUrl(facts.url)) {
    return null;
  }
  return { action: 'ALLOW', delivery: 'DIRECT', automatedLoginPassThrough: { reason: reason as AutomatedLoginPassThroughReason } };
}

/**
 * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1）: 手動のログインの段の口（`authSetup.manualPassThrough`）で、今の決まりの
 * 判定（`decision`）が止める要求のうち、通すものの判定（通さないなら `null`）。
 * - 働くのは、手動のログインの段の口のとき。
 * - 通す: 読み取りでない要求（`NON_READ_METHOD`。スクリプトで送るログインの詳しい理由を含む）。届け方は、main frame の移動なら今どおり `INSPECT_REDIRECTS`。
 * - 通さない（今のまま）: 読み取り（許可 Origin の外への読み取りは止める。T26g-1）、許可 Origin の外への main frame の移動、WebSocket、ほかの理由。
 */
function manualPassThroughOf(
  decision: PassiveRequestDecision,
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision | null {
  if (
    decision.action !== 'BLOCK'
    || facts.kind !== 'HTTP'
    || policy.authSetup?.manualPassThrough !== true
  ) {
    return null;
  }
  const mainFrameNavigation = facts.isNavigationRequest && facts.isMainFrame;
  if (mainFrameNavigation && !hasAllowedOrigin(facts.url, allowedOrigins)) {
    return null;
  }
  // 読み取りは今の決まりのまま（許可 Origin の外への読み取りは止める。T26g-1 の、人が入れた値を別の Origin の読み込みで運ばせない守り）。
  if (isReadMethod(facts.method)) {
    return null;
  }
  // 止めた理由で見分ける（この口の段では、読み取りでない要求の `NON_READ_METHOD` は要求の止め方だけ）。
  const scriptReason = 'scriptLoginBlock' in decision ? decision.scriptLoginBlock : undefined;
  return decision.reason === 'NON_READ_METHOD'
    ? { action: 'ALLOW', delivery: mainFrameNavigation ? 'INSPECT_REDIRECTS' : 'DIRECT', manualLoginPassThrough: { reason: scriptReason ?? 'NON_READ_METHOD' } }
    : null;
}

/**
 * RB-14b（X1）: 読み取りでない HTTP の要求の判定（承認した送信の判定の後）。
 * - スクリプトで送るログインの段: 登録した送信だけを通す（`scriptLoginVerdict`）。
 * - 監査の段の登録した読み取りの手続きの呼び出し: 通す（SD-2: 読まないパスと危険な語でも止めない）。API の書き込みの段の送信の窓の中は、登録した呼び出しも
 *   通さない。
 * - ほか: 既定は通す（`PASS_EXCEPT_DELETE`。`auditSendDecisionOf`）。人が選んだ READ_ONLY は止める。
 */
function nonReadDecisionOf(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision {
  const script = policy.authSetup?.scriptRequest;
  if (policy.authSetup !== undefined && script !== undefined) {
    const verdict = scriptLoginVerdict(facts, allowedOrigins, policy.authSetup, script);
    return verdict.kind === 'ADMIT'
      ? { action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: verdict.admission }
      : { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock: verdict.reason };
  }
  const { auditStage, writeStage } = policy;
  let auditStageBlock: AuditStageBlockReason | undefined;
  if (auditStage !== undefined) {
    const admissible = writeStage === undefined || (writeStage.apiOrigin !== undefined && writeStage.submissionWindowOpen !== true);
    const verdict = auditStageVerdict(facts, allowedOrigins, auditStage, admissible);
    if (verdict.kind === 'ADMIT') {
      return { action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: verdict.admission };
    }
    auditStageBlock = verdict.reason;
  }
  return auditSendDecisionOf(facts, allowedOrigins, policy)
    ?? { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', ...(auditStageBlock === undefined ? {} : { auditStageBlock }) };
}

/** 今の決まりの判定（手動のログインの段の通す決まりの前。`classifyPassiveRequest` の説明のとおり）。 */
function classifyStrictPassiveRequest(
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision {
  if (facts.kind === 'WEBSOCKET') {
    return webSocketPassDecisionOf(facts, policy) ?? { action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' };
  }
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 読み取り（GET・HEAD）に付いたヘッダの `DELETE` の上書きの止め（前の SREV-SAFE の
  // I-2）は外した。凍結の段の読み取りは、`isFrozenReadAdmissible` が除く（守り 2）。
  const script = policy.authSetup?.scriptRequest;
  const { auditStage } = policy;
  // 承認した送信（BeakSight 自身の送信）: ログインの POST、書き込みの POST、API の書き込みの照合にかける要求。
  if (policy.authSetup !== undefined && script === undefined && isAllowedLoginPost(facts, allowedOrigins, policy.authSetup)) {
    return { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
  }
  if (policy.writeStage !== undefined && isAllowedWritePost(facts, allowedOrigins, policy.writeStage)) {
    return { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
  }
  // T39b: API の書き込みの段の、照合にかける要求（窓の中の 1 回目だけ。照合は Guard が続けて行う）。
  if (policy.writeStage !== undefined && isAllowedApiWrite(facts, policy.writeStage)) {
    return { action: 'ALLOW', delivery: 'DIRECT', writeStageApiWrite: true };
  }
  // L12a: 書き込みの段の押した後は、承認した送信の照合（上の 2 つ）のほか、ページの送信を通す（監査の段の `PASS_EXCEPT_DELETE` と同じ扱い。数えない）。
  const afterPress = writeStageAfterPressDecisionOf(facts, allowedOrigins, policy);
  if (afterPress !== null) {
    return afterPress;
  }
  if (!isReadMethod(facts.method)) {
    return nonReadDecisionOf(facts, allowedOrigins, policy);
  }
  const mainFrameNavigation = facts.isNavigationRequest && facts.isMainFrame;
  // ログインの段は、許可 Origin の外への main frame の移動を今どおり止める（人と自動ログインが入れた値を、別の Origin の画面へ運ばせない）。
  if (mainFrameNavigation && policy.authSetup !== undefined && !hasAllowedOrigin(facts.url, allowedOrigins)) {
    return {
      action: 'BLOCK',
      category: 'NAVIGATION',
      reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
    };
  }
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4 の「main frame の文書の移動」）: ログインの段のほかでは、main frame の移動を、
  // 危険な語・読まないパス・読む範囲・許可 Origin の外を理由に止めない（BeakSight 自身の移動とページの script の移動を見分けない。BeakSight 自身の移動は、移る前に
  // 判定してある `isOutsideAuditScope`。サーバのリダイレクトも通す）。移った先が点検の範囲の外なら、読み込みの側がその画面を点検しない（`navigatePage`）。
  // 残すのは、フォームの書き込みの段の送信の窓の中の、承認した送信先とその下への読み取り（BeakSight が送る書き込みの照合。下の `WRITE_STAGE`）。
  if (mainFrameNavigation && policy.authSetup === undefined && !isWriteWindowReadUnderEndpoint(facts, policy)) {
    return { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
  }
  if ((script !== undefined && isServiceOriginRead(facts, script)) || isManualServiceOriginRead(facts, policy)) {
    return { action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } };
  }
  if (auditStage !== undefined && hasAllowedOrigin(facts.url, new Set(auditStage.approvedServiceOrigins))) {
    // T35R-fix（T35R の C-1）: 幅の走査と Interaction の Context では、サービスの Origin への読み取りを送らない（sub frame の文書を含む）。
    if (auditStage.serviceOriginRequestsWithheld === true) {
      return { action: 'BLOCK', category: 'REQUEST', reason: 'SERVICE_ORIGIN_REVISIT' };
    }
    // T35b: 監査の段の承認したサービスの Origin への読み取り（main frame の移動はこの前で止まる）。Guard が上限の部品で数えるための印を付ける。
    return { action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } };
  }
  if (policy.authSetup !== undefined) {
    const loginStageReason = submissionStageBlockReason(facts, allowedOrigins, policy.authSetup);
    if (loginStageReason !== null) {
      return { action: 'BLOCK', category: 'LOGIN_STAGE', reason: loginStageReason };
    }
  }
  // RB-4b（設計書 3.2）: 書き込みの段の、送信の窓の中の読み取りと許可 Origin の外の読み取りの止め（前の T30b の `WRITE_STAGE`）は外した（書き込みの最中も、
  // サイトの通信は止めない）。読み取りは、監査の段と同じ決まりで通す。残すのは、BeakSight が送る書き込みの照合の一部だけ: フォームの書き込みの段で、送信の窓の中の、
  // 承認した送信先とその下への読み取り（押したフォームが GET に変えられた送信など。承認していない形の書き込みになりうる）を止める。
  if (isWriteWindowReadUnderEndpoint(facts, policy)) {
    return { action: 'BLOCK', category: 'WRITE_STAGE', reason: 'SUBMISSION_WINDOW' };
  }
  // SD-2（設計書 2.4）: 監査の段の除外（読まないパス・読む範囲・危険な語）は、要求の判定では当てない（ページの読み取り・子の frame・先読み・main frame の移動の
  // どれにも）。BeakSight 自身の移動の前の判定（`isOutsideAuditScope`）と、移った画面を点検しない読み込みの側だけが使う。
  return {
    action: 'ALLOW',
    delivery: facts.isNavigationRequest && facts.isMainFrame ? 'INSPECT_REDIRECTS' : 'DIRECT',
  };
}

/**
 * 認証の設定の送信先への POST か（CCX-15。共通化の台帳の CC-064。T26d-1 で `src/worker/login-stage-checks.ts` に置いたものを、要求の判定の
 * owner に移した）。`url` への main frame のナビゲーションの POST を、残りの回数 1 のログインの段の口で判定して ALLOW になるか
 * （`isAllowedLoginPost` の条件）。自動ログインの段の送信先の確かめ（入力の部品に渡す `isAllowedAction`、送信の観察）と、回数の上限で
 * 止められたかの判定（`loginAttemptsExceeded`）が使う。
 */
export const isLoginEndpointPost = (
  url: string,
  allowedOrigins: ReadonlySet<string>,
  loginPostEndpoints: readonly LoginPostEndpoint[],
): boolean =>
  classifyPassiveRequest(
    { kind: 'HTTP', method: LOGIN_POST_METHOD, url, isNavigationRequest: true, isMainFrame: true },
    allowedOrigins,
    { authSetup: { loginPostEndpoints, remainingPosts: ONE_REMAINING_POST } },
  ).action === 'ALLOW';
