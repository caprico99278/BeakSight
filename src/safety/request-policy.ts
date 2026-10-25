import {
  PATH_NORMALIZATION_BASE,
  auditScopePathFormsOf,
  exclusionMatchPathFormsOf,
  fullyPercentDecoded,
  isInsideAuditScope,
} from '../core/audit-exclusion-forms.js';
import { hitsDangerousTermIn, hitsExcludedPathPrefix } from '../core/audit-exclusion-match.js';
import { API_METHOD_OVERRIDE_HEADER_NAMES, API_WRITE_METHODS } from '../core/api-request-shape.js';
import { headerValueOf } from './http-headers.js';
import { LOGIN_CREDENTIAL_BLOCK_REASON } from './login-credential-guard.js';
import type { BLOCKED_AUDIT_EXCLUSION_REASONS, BLOCKED_REQUEST_REASONS } from '../core/evidence-types.js';
import { foldNfkcCase } from '../core/text.js';
import { canonicalizeAllowedOrigins, hasUrlCredentials } from '../crawl/normalize-url.js';

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
   * AS-c fix round 1（I-2）: 要求の送る中身（ヘッダと本文）。使うのは、監査の段の送信の扱いの口（`auditSend`）の method の上書きの判定
   * （`isDeleteMethodOverride`）だけ。Guard の CDP の層・route の層・`requestfailed` の判定が渡す。省略は上書きなしと同じ（出口の中継は渡さない。Guard が先に止める）。
   */
  readonly sentContent?: RequestSentContent | undefined;
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
  /** AS-c: `AUDIT_SEND_OVER_LIMIT` は、監査の段の送信の扱いの口で通せる接続が、その読み込みの上限を超えたとき。 */
  | { readonly action: 'BLOCK'; readonly category: 'WEBSOCKET'; readonly reason: 'PASSIVE_WEBSOCKET' | 'AUDIT_SEND_OVER_LIMIT' }
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
 * 読む範囲（`auditPathPrefixes`）の外でも読む、静的な資源の要求の種類（T35b。Task 35 の設計書 3.3。閉じた一覧）。スクリプトで送るログインの監査の段
 * だけで、許可 Origin への GET のサブリソースに当てる。
 */
export const STATIC_SUBRESOURCE_TYPES = Object.freeze(
  ['script', 'stylesheet', 'image', 'font', 'media'] as const satisfies readonly RequestResourceType[],
);

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
   * （`manualLoginPassThrough`。`manualPassThroughOf`）。読み取りは今の決まりのまま。自動ログインの段は付けない（今の厳しさのまま）。監査の段・書き込みの段の口と
   * 一緒のときは働かない（fail-closed）。
   */
  readonly manualPassThrough?: true | undefined;
  /**
   * T44R（Task 44 のレビューの M-1）: 手動のログインの段で、スクリプトで送るログインの口（`scriptRequest`）がないとき（token の送信先がまだない設定）の、
   * プロファイルの承認したサービスの Origin。ナビゲーションでない GET と HEAD を `SERVICE_ORIGIN_READ` で通す（`scriptRequest` の口の読み取りと同じ）。
   * 働くのは、`manualPassThrough` があり、`scriptRequest` がなく、監査の段・書き込みの段の口と一緒でないときだけ（fail-closed）。読み取りでない要求の扱いは
   * 変えない（手動の段の口が通して記録する）。
   */
  readonly manualServiceReadOrigins?: readonly string[] | undefined;
}

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
}

/**
 * 監査の段の除外の口（Task 25 の設計書 4.1 の `excludedPaths`・`auditPathPrefixes`・既定の危険な語、4.2。平らなデータ）。一覧の値は
 * 呼び出し側（認証の設定の owner）から受ける。
 * - `excludedPathPrefixes`: 読まない path の前方一致（文字列の前方一致。大文字と小文字を区別しない）。
 * - `auditPathPrefixes`: 読む path の前方一致（文字列の前方一致。大文字と小文字を区別する）。空なら制限しない。
 * - `dangerousTerms`: path か query に含まれていたら読まない語（大文字と小文字を区別しない）。
 */
export interface AuditExclusionPolicy {
  readonly excludedPathPrefixes: readonly string[];
  readonly auditPathPrefixes: readonly string[];
  readonly dangerousTerms: readonly string[];
  /**
   * BN-0（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0。ユーザーの判断 2026-10-23）: ページが出す文書でない読み取り
   * （`isPageSubresourceRead`）にも、この除外を当てるか。真は Isolated Interaction Context（BeakSight が押した後の要求）だけが渡す（factory）。省略は、
   * 監査の段の Passive の Context の決まり（ページが出す文書でない GET・HEAD には当てない）。ログインの段・書き込みの段の口があれば、この印によらず当てる。
   */
  readonly applyToPageSubresourceReads?: true | undefined;
}

/**
 * BN-0・BN-R0 fix round 1: 文書の読み込みの先回り（次の移動の文書を取りに行く要求）の種類。ナビゲーションでなくても、ページの文書でない読み取りとして扱わず、
 * 監査の段の除外を当てる（`<link rel="prefetch">`・`as=document` の先読みが、読まないパス・危険な語の URL へ届かないように。M-2 と C-1 の確かめ）。
 * - `prefetch`: `<link rel="prefetch">` と speculation rules の prefetch の要求（Guard の記録の口の種類）。
 * - `signedexchange`: 署名つきの交換（文書を運ぶ形）。
 */
const DOCUMENT_PRELOAD_RESOURCE_TYPES: ReadonlySet<RequestResourceType> = new Set<RequestResourceType>(['prefetch', 'signedexchange']);

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

/** 要求が、先読みの要求か（`isSpeculativeRequestHeaders`）。 */
const isPreloadRequest = (facts: HttpRequestFacts): boolean => isSpeculativeRequestHeaders(facts.sentContent?.headers);

/**
 * BN-0: ページが出す文書でない読み取りか（唯一の判定。Guard の CDP の層・route の層と出口の中継が、同じ要求の事実で使う）。GET か HEAD で、ナビゲーションで
 * なく（main frame と子の frame の文書の読み込みでない）、要求の種類が `document` でも文書の先回り（`DOCUMENT_PRELOAD_RESOURCE_TYPES`）でもなく、先読みの印の
 * ヘッダ（`Sec-Purpose`・`Purpose` の `prefetch`）もない（script・stylesheet・image・font・media・fetch・xhr・other など）。
 * BN-R0 の M-2: Guard の記録の口は、知らない種類を `other` に直す（`requestResourceTypeOf`）ので、`other` は文書でない読み取りとして扱う（アイコンや計測の
 * GET を通すため）。種類を渡さない呼び出し（判定の口の事実に種類がない場合）だけが当たらない（除外を当てる側）。
 */
export function isPageSubresourceRead(facts: HttpRequestFacts): boolean {
  return isReadMethod(facts.method)
    && !facts.isNavigationRequest
    && facts.resourceType !== undefined
    && facts.resourceType !== 'document'
    && !DOCUMENT_PRELOAD_RESOURCE_TYPES.has(facts.resourceType)
    && !isPreloadRequest(facts);
}

/**
 * BN-0: 監査の段の除外（読まないパス・読む範囲・危険な語）を、この読み取りの要求に当てるか。監査の段の Passive の Context（ログインの段・書き込みの段の口がなく、
 * 除外の口が `applyToPageSubresourceReads` を持たない）では、ページが出す文書でない読み取りに当てない。ほか（BeakSight 自身の移動、文書の読み込み、
 * Interaction の Context、ログインの段・書き込みの段）は、今どおり当てる。読み取りでない要求の決まりは、この判定を通らない（呼び出し側の前の分岐）。
 */
function appliesAuditExclusionTo(facts: HttpRequestFacts, policy: PassiveRequestPolicyOptions, exclusions: AuditExclusionPolicy): boolean {
  if (policy.authSetup !== undefined || policy.writeStage !== undefined || exclusions.applyToPageSubresourceReads === true) {
    return true;
  }
  return !isPageSubresourceRead(facts);
}

/**
 * `classifyPassiveRequest` の省略できる口。どれもなければ、今の判定（公開監査）と同じ。
 * T30b: ログインの段の口（`authSetup`）と書き込みの段の口（`writeStage`）を両方渡した場合は、どちらの POST も許さない（fail-closed。
 * factory はどちらか 1 つだけを渡す）。
 */
export interface PassiveRequestPolicyOptions {
  readonly authSetup?: LoginStagePolicy | undefined;
  readonly auditExclusions?: AuditExclusionPolicy | undefined;
  readonly writeStage?: WriteStagePolicy | undefined;
  /** T35b: スクリプトで送るログインの監査の段の口（`AuditStagePolicy`）。 */
  readonly auditStage?: AuditStagePolicy | undefined;
  /** AS-a: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口（`AuditSendPolicy`）。ログインの段・書き込みの段の口と一緒なら使わない（fail-closed）。 */
  readonly auditSend?: AuditSendPolicy | undefined;
}

/**
 * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口（平らなデータ）。この口があることが、
 * その扱いを選んだ Passive の段であることを表す（ない場合は今のまま読み取りだけ。`READ_ONLY`）。判定は `auditSendDecisionOf`。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（許可 Origin と同じ意味で比べる）。AS-c から、送り先の Origin の制限には使わない（許可 Origin と
 *   これらのほかへの要求も通す）。使うのは、ほかの Origin へ通した数の見分け（Guard の `isOtherOrigin`）と、サービスの Origin へ送らない Context
 *   （`serviceOriginRequestsWithheld`）の止め（`isWithheldServiceOriginRequest`）だけ。
 * - `dangerousTerms`: path か query に含まれていたら通さない語（呼び出し側が既定の危険な語を渡す。比べ方は監査の段の除外と同じ `hitsDangerousTerm`）。
 * - `remainingPasses`: その読み込み（Context）で、あと何件を通すか。1 以上の安全な整数のときだけ通す（数えて減らすのは Guard）。
 */
export interface AuditSendPolicy {
  readonly approvedServiceOrigins: readonly string[];
  readonly dangerousTerms: readonly string[];
  readonly remainingPasses: number;
  /**
   * AS-c: その読み込み（Context）で、あと何本の WebSocket の接続を通すか（HTTP の残りとは別に数える）。1 以上の安全な整数のときだけ通す。省略は WebSocket を
   * 通さない（今どおり `PASSIVE_WEBSOCKET`。fail-closed）。
   */
  readonly remainingWebSockets?: number | undefined;
}

/** AS-a: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` でも通さない method（大文字と小文字を区別せずに比べる。fail-closed）。 */
export const AUDIT_SEND_BLOCKED_METHOD = 'DELETE';

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
    && isApiWriteEndpointUrl(facts.url, policy.writeEndpoint);
}

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
 * - token の送信先の Origin・path・必須の query に完全に一致: 種類が fetch か xhr で、残りの回数があり、`admissible` なら通す。種類が違えば
 *   `TOKEN_REQUEST_NOT_SCRIPT`、回数がなければ `TOKEN_REQUEST_OVER_LIMIT`。
 * - token の送信先の Origin と path に一致するが query が違う: `TOKEN_REQUEST_QUERY_MISMATCH`。
 * - 登録したログインに伴う送信の Origin・path・method に一致: 一致する項目のうち、残りの回数がある最初の項目で通す（種類が fetch か xhr で、
 *   `admissible` のとき）。種類が違えば `SIDE_REQUEST_NOT_SCRIPT`、どの項目にも回数がなければ `SIDE_REQUEST_OVER_LIMIT`。
 * - それ以外: `UNREGISTERED_NON_READ`。
 * `admissible` が偽（ログインの段と書き込みの段の口を両方渡した誤り）のときは、どれも通さない（回数がないものとして扱う。fail-closed）。
 */
function scriptLoginVerdict(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: LoginStagePolicy,
  script: ScriptRequestLoginPolicy,
  admissible: boolean,
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
    return admissible && hasRemainingPosts(policy.remainingPosts)
      ? { kind: 'ADMIT', admission: { kind: 'SCRIPT_LOGIN_TOKEN' } }
      : { kind: 'BLOCK', reason: 'TOKEN_REQUEST_OVER_LIMIT' };
  }
  if (matchesSubmissionEndpoint(facts.url, scriptLogin, ANY_QUERY)) {
    return { kind: 'BLOCK', reason: 'TOKEN_REQUEST_QUERY_MISMATCH' };
  }
  // T35b: 登録したログインに伴う送信は、段を問わない共通の判定（`registeredSubmissionVerdict`）で決め、理由をログインの段の理由に写す（値は今のまま）。
  const side = registeredSubmissionVerdict(facts, script.loginSideRequests, admissible);
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
 * `admissible` が偽（送信の段の口と一緒に渡した誤り）のときは、どれも通さない（fail-closed）。
 */
function auditStageVerdict(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  stage: AuditStagePolicy,
  admissible: boolean,
): AuditStageVerdict {
  const { scriptLogin } = stage;
  if (
    facts.method === SUBMISSION_POST_METHOD
    && matchesSubmissionEndpoint(facts.url, scriptLogin, ANY_QUERY)
    && !matchesSubmissionEndpoint(facts.url, scriptLogin, { kind: 'EXACT', parameters: scriptLogin.requiredQuery })
  ) {
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

/**
 * 読む範囲の外でも読む、静的な資源の要求か（T35b。Task 35 の設計書 3.3）: GET の、ナビゲーションでない要求で、種類が `STATIC_SUBRESOURCE_TYPES`。
 * 省略した種類は当たらない（fail-closed）。
 */
const isStaticSubresourceRead = (facts: HttpRequestFacts): boolean =>
  facts.method === 'GET'
  && !facts.isNavigationRequest
  && (STATIC_SUBRESOURCE_TYPES as readonly (RequestResourceType | undefined)[]).includes(facts.resourceType);

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
 * 手動の段の印があり、スクリプトの口がなく、監査の段・書き込みの段の口と一緒でないときだけ（fail-closed）。
 */
const isManualServiceOriginRead = (facts: HttpRequestFacts, policy: PassiveRequestPolicyOptions): boolean => {
  const login = policy.authSetup;
  return login !== undefined
    && login.manualPassThrough === true
    && login.scriptRequest === undefined
    && login.manualServiceReadOrigins !== undefined
    && policy.writeStage === undefined
    && policy.auditStage === undefined
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
 * - T35b（Task 35 の設計書 3.3）: 要求の事実（`facts`）を受ける。`staticResourcesOutsideScope` が真（スクリプトで送るログインの監査の段）なら、
 *   静的な資源の要求（`isStaticSubresourceRead`）には読む範囲を当てない。読まないパスと危険な語は、すべての要求に当てる。
 */
function isAuditExcluded(
  facts: HttpRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: AuditExclusionPolicy,
  staticResourcesOutsideScope: boolean,
): boolean {
  const { url } = facts;
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
  if (
    policy.auditPathPrefixes.length > 0
    && !(staticResourcesOutsideScope && isStaticSubresourceRead(facts))
    && !isInsideAuditScope(forms.scopePathForms, policy.auditPathPrefixes)
  ) {
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
 * - 口を使わない（`null`）: 口がない、ログインの段・書き込みの段の口と一緒（fail-closed）、読み取り、method が `DELETE`（大文字と小文字を問わない）、
 *   method の上書きが `DELETE`（AS-c fix round 1 の I-2。`isDeleteMethodOverride`）、文書の
 *   ナビゲーション（main frame と sub frame。フォームの送信を含む）、http(s) の URL でない（読めない URL を含む）、path か query が危険な語
 *   （`auditSend.dangerousTerms`）に当たる、監査の段の除外の口があれば読まないパスか危険な語に当たる（比べ方は監査の段の除外と同じ
 *   `isExcludedOrDangerous`。読む範囲は当てない）。スクリプトで送るログインの監査の段の口と一緒のときは、加えて、サービスの Origin へ送らない Context
 *   （`serviceOriginRequestsWithheld`）のサービスの Origin への要求。AS-c: 送り先の Origin の制限はなくした。token の更新（`TOKEN_REFRESH`）も通す。
 * - 上限で止める: ほかの条件をすべて満たすが、残りの数（`remainingPasses`）がない。理由 `AUDIT_SEND_OVER_LIMIT`（監査の段の詳しい理由があれば添える）。
 * - 通す: `auditSendAdmission` の印を付けた ALLOW（Guard が数えて記録する）。
 */
function auditSendDecisionOf(
  facts: HttpRequestFacts,
  policy: PassiveRequestPolicyOptions,
  auditStageBlock?: AuditStageBlockReason,
): PassiveRequestDecision | null {
  const { auditSend } = policy;
  if (
    auditSend === undefined
    || policy.authSetup !== undefined
    || policy.writeStage !== undefined
    || isReadMethod(facts.method)
    || facts.method.toUpperCase() === AUDIT_SEND_BLOCKED_METHOD
    || facts.isNavigationRequest
    // AS-c: 送り先の Origin の制限はなくした（http(s) の URL であることだけを求める）。token の更新（`TOKEN_REFRESH`）も通す。
    || !isHttpUrl(facts.url)
    || isWithheldServiceOriginRequest(facts.url, policy)
    || isAuditSendDangerous(facts.url, policy)
    // AS-c fix round 1（I-2）: method の上書きが `DELETE` の要求も、`DELETE` と同じく通さない。
    || isDeleteMethodOverride(facts.sentContent)
  ) {
    return null;
  }
  if (!hasRemainingPosts(auditSend.remainingPasses)) {
    return { action: 'BLOCK', category: 'REQUEST', reason: 'AUDIT_SEND_OVER_LIMIT', ...(auditStageBlock === undefined ? {} : { auditStageBlock }) };
  }
  return { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };
}

/**
 * AS-c（設計書 5 章の「ユーザーの言葉と選択（AS-c）」の行）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口で、WebSocket の接続を、どう扱うか（口を使わない
 * 接続は `null`。呼び出し側が今の決まり `PASSIVE_WEBSOCKET` で止める）。
 * - 口を使わない（`null`）: 口がない、口に WebSocket の残りの数がない、ログインの段・書き込みの段の口と一緒（fail-closed）、`ws:`・`wss:` の URL でない、
 *   サービスの Origin へ送らない Context のサービスの Origin への接続、path か query が危険な語に当たる、監査の段の除外の口があれば読まないパスか危険な語に
 *   当たる（HTTP の要求と同じ比べ方）。
 * - 上限で止める: 残りの数（`remainingWebSockets`）がない。理由 `AUDIT_SEND_OVER_LIMIT`。
 * - 通す: `auditSendWebSocketAdmission` の印を付けた ALLOW（Guard が数えて記録し、サーバへつなぐ）。送り先の Origin は問わない。
 */
function auditSendWebSocketDecisionOf(facts: WebSocketRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision | null {
  const { auditSend } = policy;
  if (
    auditSend?.remainingWebSockets === undefined
    || policy.authSetup !== undefined
    || policy.writeStage !== undefined
    || !isWebSocketUrl(facts.url)
    || isWithheldServiceOriginRequest(httpEquivalentOfWebSocketUrl(facts.url), policy)
    || isAuditSendDangerous(facts.url, policy)
  ) {
    return null;
  }
  if (!hasRemainingPosts(auditSend.remainingWebSockets)) {
    return { action: 'BLOCK', category: 'WEBSOCKET', reason: 'AUDIT_SEND_OVER_LIMIT' };
  }
  return { action: 'ALLOW', delivery: 'DIRECT', auditSendWebSocketAdmission: true };
}

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

/** 監査の段の送信の扱いの口の危険な語（path と query）か、監査の段の除外の口の読まないパスか危険な語に当たるか（比べ方は監査の段の除外と同じ）。 */
const isAuditSendDangerous = (url: string, policy: PassiveRequestPolicyOptions): boolean => {
  const dangerous: AuditExclusionPolicy = { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: policy.auditSend?.dangerousTerms ?? [] };
  return isExcludedOrDangerous(url, dangerous) || (policy.auditExclusions !== undefined && isExcludedOrDangerous(url, policy.auditExclusions));
};

/**
 * AS-c fix round 1（C-1・C-2）: ブラウザが実際に開いた WebSocket の接続（Guard の route を通らなかったものを含む）の URL が、監査の段の送信の扱いの口なら
 * 通さない危険な語か除外に当たるか（Guard が記録に印を付けるため。比べ方は `auditSendWebSocketDecisionOf` と同じ `isAuditSendDangerous`。読めない URL は当たる）。
 */
export const isAuditSendDangerousWebSocket = (url: string, policy: PassiveRequestPolicyOptions): boolean =>
  !isWebSocketUrl(url) || isAuditSendDangerous(url, policy);


/** method の上書きの値が `DELETE` か（前後の空白を除き、大文字と小文字を問わない。`,` で区切った並びは、どれか 1 つでも当たれば当たる）。 */
const isDeleteOverrideValue = (value: string): boolean =>
  value.split(',').some((part) => part.trim().toUpperCase() === AUDIT_SEND_BLOCKED_METHOD);

/**
 * AS-c fix round 1（I-2。設計書 5 章の「AS-R … とユーザーの判断」の行）: 要求の送る中身が、method の上書きで `DELETE` を伝えるか（当たれば、監査の段の送信の扱い
 * `PASS_EXCEPT_DELETE` でも通さない）。
 * - ヘッダ `X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override` の値が `DELETE`。
 * - form の本文（urlencoded と multipart）の `_method` の欄の値が `DELETE`。本文の欄は owner（`formMethodOverrideValuesOf`）が読む。form の本文が読めない・
 *   形が崩れている（`null`）なら当たる（fail-closed）。
 * - 中身がなければ（出口の中継の判定）、当たらない。JSON などの本文の中の削除（GraphQL・JSON-RPC）は見ない（`doc/spec/safety.md` の限界）。
 */
function isDeleteMethodOverride(content: RequestSentContent | undefined): boolean {
  if (content === undefined) {
    return false;
  }
  // AS-c fix round 2: ヘッダの名前は、API の書き込みの照合（`METHOD_OVERRIDE_PRESENT`）と同じ一覧（`API_METHOD_OVERRIDE_HEADER_NAMES`）を共用する。
  if (API_METHOD_OVERRIDE_HEADER_NAMES.some((name) => isDeleteOverrideValue(headerValueOf(content.headers, name) ?? ''))) {
    return true;
  }
  const formValues = content.formMethodOverrides();
  return formValues === null || formValues.some(isDeleteOverrideValue);
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
 * - `policy.auditExclusions`（監査の段の除外の口）: 許可 Origin への GET と HEAD でも、除外に当たる URL を BLOCK する
 *   （`isAuditExcluded`。main frame でもサブの要求でも）。GET と HEAD 以外の拒否、WebSocket、許可 Origin の外への main frame の移動の
 *   判定が先に働く。
 * - `policy.writeStage`（書き込みの段の口。T30b）: 承認の要求の形に完全に一致する（query と fragment なし）、main frame のナビゲーションの
 *   POST だけを、残りの回数が 1 以上のときに ALLOW する（`isAllowedWritePost`。送る中身の照合は、その後に Guard が行う）。ほかの要求は、
 *   ログインの段と同じく、許可 Origin の外と、送信の窓の中のすべてを `WRITE_STAGE` で止める（`submissionStageBlockReason`）。
 * - `authSetup` と `writeStage` を両方渡した場合は、どちらの POST も ALLOW しない（fail-closed）。窓と許可 Origin の制限は、両方の口で働く。
 * - `policy.authSetup.scriptRequest`（スクリプトで送るログインの口。T34b。Task 34 の設計書 3.3）: フォームの送信先への POST は許さず、読み取りで
 *   ない要求は `scriptLoginVerdict` で判定する（登録した token の送信とログインに伴う送信だけを、`loginStageAdmission` つきで ALLOW。ほかは
 *   `NON_READ_METHOD` に `scriptLoginBlock` を添えて BLOCK）。承認したサービスの Origin への、ナビゲーションでない GET と HEAD を ALLOW する
 *   （`SERVICE_ORIGIN_READ`）。CORS の事前確認は、今どおり Guard が判定の前に満たす。
 * - `policy.auditStage`（スクリプトで送るログインの監査の段の口。T35b。Task 35 の設計書 3.2、3.3）: 読み取りでない要求は `auditStageVerdict` で
 *   判定する（登録した読み取りの手続きの呼び出しだけを、`auditStageAdmission` つきで ALLOW。ほかは `NON_READ_METHOD` に `auditStageBlock` を添えて
 *   BLOCK）。承認したサービスの Origin への読み取りに `SERVICE_ORIGIN_READ` の印を付ける（通すかは今どおり）。読む範囲の外の静的な資源の GET を
 *   通す（`isAuditExcluded`）。
 * - `policy.auditSend`（監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口。AS-a）: 今の決まりなら止める読み取りでない要求のうち、`auditSendDecisionOf` の
 *   条件を満たすものを、`auditSendAdmission` つきで ALLOW（残りの数がなければ `AUDIT_SEND_OVER_LIMIT` で BLOCK）。ほかは今どおり。
 */
export function classifyPassiveRequest(
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions = {},
): PassiveRequestDecision {
  const decision = classifyStrictPassiveRequest(facts, allowedOrigins, policy);
  return manualPassThroughOf(decision, facts, allowedOrigins, policy) ?? decision;
}

/**
 * ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1）: 手動のログインの段の口（`authSetup.manualPassThrough`）で、今の決まりの
 * 判定（`decision`）が止める要求のうち、通すものの判定（通さないなら `null`）。
 * - 働くのは、ログインの段の口だけのとき（監査の段・書き込みの段の口と一緒なら働かない。fail-closed）。
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
    || policy.writeStage !== undefined
    || policy.auditStage !== undefined
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

/** 今の決まりの判定（手動のログインの段の通す決まりの前。`classifyPassiveRequest` の説明のとおり）。 */
function classifyStrictPassiveRequest(
  facts: PassiveRequestFacts,
  allowedOrigins: ReadonlySet<string>,
  policy: PassiveRequestPolicyOptions,
): PassiveRequestDecision {
  if (facts.kind === 'WEBSOCKET') {
    // AS-c: 監査の段の送信の扱いの口（WebSocket の残りの数つき）があれば、その決まりで通す（通さない接続は今どおり止める）。
    return auditSendWebSocketDecisionOf(facts, policy) ?? { action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' };
  }
  const singleSubmissionStage = policy.authSetup === undefined || policy.writeStage === undefined;
  const script = policy.authSetup?.scriptRequest;
  const { auditStage } = policy;
  if (
    singleSubmissionStage
    && policy.authSetup !== undefined
    && script === undefined
    && isAllowedLoginPost(facts, allowedOrigins, policy.authSetup)
  ) {
    return { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
  }
  if (singleSubmissionStage && policy.writeStage !== undefined && isAllowedWritePost(facts, allowedOrigins, policy.writeStage)) {
    return { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
  }
  // T39b: API の書き込みの段の、照合にかける要求（窓の中の 1 回目だけ。照合は Guard が続けて行う）。
  if (singleSubmissionStage && policy.writeStage !== undefined && isAllowedApiWrite(facts, policy.writeStage)) {
    return { action: 'ALLOW', delivery: 'DIRECT', writeStageApiWrite: true };
  }
  if (policy.authSetup !== undefined && script !== undefined && !isReadMethod(facts.method)) {
    const verdict = scriptLoginVerdict(facts, allowedOrigins, policy.authSetup, script, singleSubmissionStage);
    return verdict.kind === 'ADMIT'
      ? { action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: verdict.admission }
      : { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock: verdict.reason };
  }
  if (auditStage !== undefined && !isReadMethod(facts.method)) {
    // T35b: 監査の段の口と送信の段の口を一緒に渡した誤りでは、どれも通さない（fail-closed）。T39b: API の書き込みの段の口とは一緒に受け、登録した
    // 読み取りの手続きの呼び出しを、送信の窓の外でだけ通す（窓の中は、承認した 1 回の書き込みのほかの読み取りでない要求を止める）。
    const admissible = policy.authSetup === undefined
      && (policy.writeStage === undefined || (policy.writeStage.apiOrigin !== undefined && policy.writeStage.submissionWindowOpen !== true));
    const verdict = auditStageVerdict(facts, allowedOrigins, auditStage, admissible);
    if (verdict.kind !== 'ADMIT') {
      // AS-a: 監査の段の送信の扱いの口があれば、登録していない読み取りでない要求も、その決まりで通す（AS-c から token の更新も通す。サービスの Origin へ
      // 送らない Context の要求は今どおり止める）。
      return auditSendDecisionOf(facts, policy, verdict.reason)
        ?? { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', auditStageBlock: verdict.reason };
    }
    // T35R-fix（T35R の M-1）: 登録した読み取りの手続きの呼び出しにも、読まないパスと危険な語を当てる（読む範囲は当てない）。
    if (policy.auditExclusions !== undefined && isExcludedOrDangerous(facts.url, policy.auditExclusions)) {
      return { action: 'BLOCK', category: 'AUDIT_EXCLUSION', reason: 'AUDIT_EXCLUDED_URL' };
    }
    return { action: 'ALLOW', delivery: 'DIRECT', auditStageAdmission: verdict.admission };
  }
  if (!isReadMethod(facts.method)) {
    // AS-a: 監査の段の送信の扱いの口があれば、その決まりで通す（通さない要求は今どおり止める）。
    return auditSendDecisionOf(facts, policy) ?? { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
  }
  if (
    facts.isNavigationRequest
    && facts.isMainFrame
    && !hasAllowedOrigin(facts.url, allowedOrigins)
  ) {
    return {
      action: 'BLOCK',
      category: 'NAVIGATION',
      reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
    };
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
  if (policy.writeStage !== undefined) {
    const writeStageReason = submissionStageBlockReason(facts, allowedOrigins, policy.writeStage);
    if (writeStageReason !== null) {
      return { action: 'BLOCK', category: 'WRITE_STAGE', reason: writeStageReason };
    }
  }
  // BN-0（設計書 3.0）: 監査の段の Passive の Context では、ページが出す文書でない GET・HEAD に除外を当てない（`appliesAuditExclusionTo`）。
  if (
    policy.auditExclusions !== undefined
    && appliesAuditExclusionTo(facts, policy, policy.auditExclusions)
    && isAuditExcluded(facts, allowedOrigins, policy.auditExclusions, auditStage !== undefined)
  ) {
    return { action: 'BLOCK', category: 'AUDIT_EXCLUSION', reason: 'AUDIT_EXCLUDED_URL' };
  }
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
