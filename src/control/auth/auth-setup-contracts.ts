// 認証の設定（`beaksight-auth-setup/1`）の契約の SSOT（Task 25 の設計書 4.1、5 章。T25a）。
// 版 2（`beaksight-auth-setup/2`。Task 26 の設計書 4.3。T26b）: 版 1 の項目に、自動ログインの設定（`automatedLogin`）を足した版。
// - 検証（`validateAuthSetup`）が受け、保存の部品が書くのは版 2 だけ。版 1 の型と定数は、管理データの版 1 の文書を読むために残す
//   （読むときに `automatedLogin: null` の版 2 に直すのは `src/control/store/auth-setup-store.ts`）。
// - 版 2 の JSON Schema は `schemas/control/auth-setup-v2.schema.json`。版 1 のスキーマ（`auth-setup.schema.json`）は公開済みの形のまま。
// - プロファイル（`beaksight-profile/1`）は変えず、別の文書を `profileId` と `profileRevision` に結びつける。
// - 値の一覧は `as const` の凍結した配列として 1 回だけ定義し、TypeScript の型はその配列から導く（`src/control/contracts.ts` と同じ方式）。
// - JSON Schema（`schemas/control/auth-setup.schema.json`）の上限は、ここの名前つきの定数と一致することをテストで固定する
//   （`tests/unit/control-auth-setup.test.ts`）。
// - 判定（検証）は `auth-setup-policy.ts` の 1 か所。既定で読まない危険な語の一覧は、ここに平らなデータとして置き、判定そのものは
//   要求の判定の owner（`src/safety/request-policy.ts`。T25b）が、この一覧を受け取って行う。
// Node 専用。Playwright と監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`）を import しない。
import { MAX_URL_LENGTH } from '../../core/limits.js';

/** 認証の設定の版 1。版 1 のスキーマの `schemaVersion` の const と一致する（管理データの版 1 の文書を読むためだけに使う）。 */
export const AUTH_SETUP_SCHEMA_VERSION = 'beaksight-auth-setup/1';

/** 認証の設定の版 2（Task 26 の設計書 4.3）。版 2 のスキーマの `schemaVersion` の const と一致する。検証と保存は、この版だけ。 */
export const AUTH_SETUP_SCHEMA_VERSION_2 = 'beaksight-auth-setup/2';

/** ログインの段で許す POST の回数の下限（設計書 4.1。スキーマの `maxLoginAttempts` の minimum）。 */
export const MIN_LOGIN_ATTEMPTS = 1;

/** ログインの段で許す POST の回数の上限（設計書 4.1。総当たりをしない。I05。スキーマの `maxLoginAttempts` の maximum）。 */
export const MAX_LOGIN_ATTEMPTS = 3;

/** URL と Origin と path の最大長（UTF-16 のコード単位）。監査の URL の上限（`MAX_URL_LENGTH`）と同じ。スキーマの maxLength。 */
export const MAX_AUTH_SETUP_URL_LENGTH = MAX_URL_LENGTH;

/** `loginPostEndpoints` の最大の件数（スキーマの maxItems。最小は 1 件）。 */
export const MAX_LOGIN_POST_ENDPOINTS = 5;

/** `excludedPaths` と `auditPathPrefixes` の、それぞれの最大の件数（スキーマの maxItems）。 */
export const MAX_AUTH_SETUP_PATH_LIST_ITEMS = 50;

/**
 * `allowedIdpOrigins` の形の上の最大の件数（スキーマの maxItems）。Stage 1 では空だけを受ける（`AUTH_SETUP_IDP_NOT_SUPPORTED`。
 * 別の Origin の IdP は Task 26 以降）。
 */
export const MAX_ALLOWED_IDP_ORIGINS = 5;

/**
 * `successCondition.selector`（CSS セレクタ）の最大長（UTF-16 のコード単位。スキーマの maxLength）。版 2 の自動ログインの 3 つのセレクタと、
 * 失敗の条件のセレクタも、同じ上限（Task 26 の設計書 4.3。成功の条件のセレクタと同じ決まり）。
 */
export const MAX_SUCCESS_SELECTOR_LENGTH = 256;

/**
 * 自動ログインのプロファイル（`AUTOMATED_LOGIN`）で受ける `maxLoginAttempts` の値（Task 26 の設計書 4.3、4.5。1 回のジョブでログインの
 * POST は 1 回だけ。アカウントのロックを誘発しない）。`MIN_LOGIN_ATTEMPTS` から `MAX_LOGIN_ATTEMPTS` の範囲の中の値。
 */
export const AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS = 1;

/**
 * 自動ログインの失敗の条件の閉じた一覧（Task 26 の設計書 4.3、4.4 の結果の区別）。それぞれ、資格情報の誤り・アカウントのロック・MFA で人の
 * 操作が要る・資格情報の期限切れ。版 2 のスキーマの `failureConditions` の項目と、この順で一致する。
 */
export const AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS = Object.freeze([
  'invalidCredentials',
  'accountLocked',
  'mfaRequired',
  'credentialExpired',
] as const);
export type AutomatedLoginFailureConditionKind = (typeof AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS)[number];

/**
 * 既定で読まない URL の危険な語（設計書 4.1 の `excludedPaths`。閉じた一覧。設計者の判断。GET でも状態を変える管理画面のリンクに
 * 備える。I09）。path と query にこの語を含む URL は、監査の段で読まない。判定は `src/safety/request-policy.ts`（T25b）。
 */
export const DEFAULT_EXCLUDED_URL_WORDS = Object.freeze([
  'logout',
  'signout',
  'sign-out',
  'log-out',
  'delete',
  'remove',
  'destroy',
  'cancel',
] as const);
export type DefaultExcludedUrlWord = (typeof DEFAULT_EXCLUDED_URL_WORDS)[number];

/**
 * 秘密に見える query の名前の語（閉じた一覧）。`loginStartUrl` の query の名前を小文字にし、英数字以外を除いた文字列が、この語の
 * どれかを含めば拒む（`AUTH_SETUP_SECRET_LIKE_VALUE`。fail-closed なので、`author` のような語も拒む）。
 * CCX-4: 一覧と比べ方の owner は `src/core/secret-query-names.ts`（秘密に見える名前の方針を 1 か所に名前つきで並べる）。ここは今の名前のまま
 * 公開し直す（振る舞いは変えない）。
 */
export { SECRET_LIKE_QUERY_NAME_WORDS } from '../../core/secret-query-names.js';

/** ログインの段で、main frame のナビゲーションの POST を許す送信先（完全一致）。 */
export interface LoginPostEndpoint {
  /** HTTP(S) の Origin の正規の直列化。`approvedTestOrigins` に含まれる。 */
  readonly origin: string;
  /** `/` で始まる path。 */
  readonly path: string;
}

/** ログインが済んだと判定する条件。 */
export interface LoginSuccessCondition {
  /** URL の path の前方一致。 */
  readonly pathPrefix: string;
  /** その画面にある要素の CSS セレクタ（任意。ないときは null）。 */
  readonly selector: string | null;
}

/**
 * ログインの結果を判定する条件（成功の条件と、自動ログインの失敗の条件。Task 26 の設計書 4.3 の「成功の条件と同じ形」）。成功の条件と同じ型。
 */
export type LoginResultCondition = LoginSuccessCondition;

/** セッションが切れたと判定する条件。 */
export interface SessionLostCondition {
  /** ログインの画面の path の前方一致。null のときは `loginStartUrl` の path（`sessionLostPathPrefixOf`）。 */
  readonly pathPrefix: string | null;
}

/** 自動ログインの失敗の条件（Task 26 の設計書 4.3）。閉じた一覧の各項目が、null（使わない）か、成功の条件と同じ形の条件。 */
export type AutomatedLoginFailureConditions = {
  readonly [Kind in AutomatedLoginFailureConditionKind]: LoginResultCondition | null;
};

/** 自動ログインの設定（Task 26 の設計書 4.3）。セレクタは、成功の条件のセレクタと同じ決まりの CSS セレクタ。 */
export interface AutomatedLoginSetup {
  /** ユーザー名の欄。 */
  readonly usernameSelector: string;
  /** パスワードの欄（`type=password`。確かめはログインの段の入力の部品）。 */
  readonly passwordSelector: string;
  /** 送信のボタン。 */
  readonly submitSelector: string;
  readonly failureConditions: AutomatedLoginFailureConditions;
}

/** 認証の設定の版 1（設計書 4.1 の表）。管理データの版 1 の文書を読むためだけに使う（検証と保存は版 2 の `AuthSetup`）。 */
export interface AuthSetupV1 extends AuthSetupFields {
  readonly schemaVersion: typeof AUTH_SETUP_SCHEMA_VERSION;
}

/**
 * 認証の設定（版 2。Task 26 の設計書 4.3）。版 1 の項目に `automatedLogin` を足したもの。`automatedLogin` は、自動ログインのプロファイル
 * （`AUTOMATED_LOGIN`）では必須、手動のログインのプロファイル（`MANUAL_SESSION`）では null（判定は `validateAuthSetup`）。
 */
export interface AuthSetup extends AuthSetupFields {
  readonly schemaVersion: typeof AUTH_SETUP_SCHEMA_VERSION_2;
  readonly automatedLogin: AutomatedLoginSetup | null;
}

/** 版 1 と版 2 に共通の項目（設計書 4.1 の表）。 */
interface AuthSetupFields {
  /** 結びつくプロファイルの `profileId`。 */
  readonly profileId: string;
  /** 結びつくプロファイルの改訂。改訂が変わったら、設定を検証し直す。 */
  readonly profileRevision: number;
  /** ログインの画面の URL（http(s)、userinfo なし、fragment なし、正規の形）。 */
  readonly loginStartUrl: string;
  readonly loginPostEndpoints: readonly LoginPostEndpoint[];
  readonly successCondition: LoginSuccessCondition;
  readonly sessionLostCondition: SessionLostCondition;
  /** 監査で読まないパス（前方一致）。 */
  readonly excludedPaths: readonly string[];
  /** 監査で読むパスの前方一致（空なら制限なし）。 */
  readonly auditPathPrefixes: readonly string[];
  /** ログインの段で許す POST の回数の上限（`MIN_LOGIN_ATTEMPTS`〜`MAX_LOGIN_ATTEMPTS`）。 */
  readonly maxLoginAttempts: number;
  /** Stage 1 では空だけ。 */
  readonly allowedIdpOrigins: readonly string[];
}

/** 認証の設定の検証で拒否するときのコード（閉じた一覧）。表示の文言は表示カタログ（T25e）に置く。 */
export const AUTH_SETUP_VALIDATION_ERROR_CODES = Object.freeze([
  /** 形がスキーマに合わない（写せない値を含む）。 */
  'AUTH_SETUP_SCHEMA_INVALID',
  /**
   * 長さ・件数・回数の上限を超える（回数の下限を含む）。自動ログインのプロファイルで `maxLoginAttempts` が
   * `AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS` でないときも、回数の上限の誤りとしてこのコードにする（T26b）。
   */
  'AUTH_SETUP_LIMIT_EXCEEDED',
  /** 渡されたプロファイルが、渡された文脈で `validateSiteProfile` を通らない。 */
  'AUTH_SETUP_PROFILE_INVALID',
  /** `profileId` がプロファイルと違う。 */
  'AUTH_SETUP_PROFILE_MISMATCH',
  /** `profileRevision` がプロファイルの改訂と違う（古い改訂の設定）。 */
  'AUTH_SETUP_PROFILE_REVISION_MISMATCH',
  /**
   * プロファイルが、認証の設定を受けるモードと方式でない（T26b で自動ログインを足した。T28b で書き込みのモードを足した。受けるのは
   * `TEST_AUTH_PASSIVE` か `TEST_APPROVED_WRITE` で、`MANUAL_SESSION` か `AUTOMATED_LOGIN`。判定は `execution-policy.ts` の `AUTH_SETUP` の行）。
   */
  'AUTH_SETUP_MODE_UNSUPPORTED',
  /** URL か Origin の形が正しくない（http(s) でない、userinfo、fragment、正規の形でない）。 */
  'AUTH_SETUP_URL_INVALID',
  /** path の形が正しくない（`/` で始まらない、`..`、制御文字、使えない文字など）。 */
  'AUTH_SETUP_PATH_INVALID',
  /** Origin が、プロファイルの `approvedTestOrigins` に含まれない。 */
  'AUTH_SETUP_ORIGIN_NOT_APPROVED',
  /** プロファイルの `approvedTestOrigins` が、ターゲット設定の `allowedOrigins` に含まれない。 */
  'AUTH_SETUP_ORIGIN_OUTSIDE_TARGET',
  /** 秘密に見える値を持つ（`loginStartUrl` の query の名前が `SECRET_LIKE_QUERY_NAME_WORDS` の語を含む）。 */
  'AUTH_SETUP_SECRET_LIKE_VALUE',
  /** 別の Origin の IdP（Stage 1 では受けない）。 */
  'AUTH_SETUP_IDP_NOT_SUPPORTED',
  /** CSS セレクタ（成功の条件、自動ログインの 3 つのセレクタ、失敗の条件）が空・空白だけ・制御文字や行の区切りを含む。 */
  'AUTH_SETUP_SELECTOR_INVALID',
  /**
   * 自動ログインの 3 つのセレクタに、標準の CSS として読めない Playwright 独自の書き方（エンジンの前置き、`>>`、`:has-text()`、`:visible`
   * など。`auth-setup-policy.ts` の `PLAYWRIGHT_ONLY_SELECTOR_MARKS`）がある（T32j-4。ログインの form の事前の確かめは isolated world の中で
   * 標準の CSS として探し直す）。
   */
  'AUTH_SETUP_SELECTOR_NOT_STANDARD_CSS',
  /**
   * 成功の条件の path の前方一致が、ログインの画面の path（`loginStartUrl` の path）か、セッションが切れたと判定する path にも当たる
   * （ログインの画面で直ちに成功と判定されうる。セレクタがあっても拒む。T25a round 1）。
   */
  'AUTH_SETUP_SUCCESS_CONDITION_AMBIGUOUS',
  /** 自動ログインのプロファイル（`AUTOMATED_LOGIN`）なのに、`automatedLogin` が null（T26b）。 */
  'AUTH_SETUP_AUTOMATED_LOGIN_REQUIRED',
  /** 手動のログインのプロファイル（`MANUAL_SESSION`）なのに、`automatedLogin` がある（T26b）。 */
  'AUTH_SETUP_AUTOMATED_LOGIN_NOT_ALLOWED',
  /** 自動ログインの 3 つのセレクタ（ユーザー名、パスワード、送信）のうち、同じ文字列のものがある（T26b）。 */
  'AUTH_SETUP_AUTOMATED_LOGIN_SELECTOR_DUPLICATED',
  /**
   * ログインの結果の条件が同時に当たりうる（T26b。T26e で失敗の条件どうしにも広げた）: 失敗の条件と成功の条件の組、または失敗の条件どうしの組
   * で、`pathPrefix` が同じで、`selector` も同じか、どちらかに `selector` がない（`auth-setup-policy.ts` の `mayMatchTogether`）。
   */
  'AUTH_SETUP_RESULT_CONDITION_AMBIGUOUS',
] as const);
export type AuthSetupValidationErrorCode = (typeof AUTH_SETUP_VALIDATION_ERROR_CODES)[number];

/** 認証の設定の検証の誤り 1 件（閉じた一覧のコードと、英語の技術的な詳細。詳細には設定の値を入れない）。 */
export interface AuthSetupValidationError {
  readonly code: AuthSetupValidationErrorCode;
  readonly detail: string;
  /**
   * 誤りのある項目の、設定の文書の中の位置（JSON Pointer。RFC 6901。CCX-23。CC-061）。画面は、英語の詳細を読まず、この位置で項目と行を決める。
   * - なくなった項目の誤りは、その項目の位置（例: `/loginStartUrl`）。文書の全体についての誤り（余分な項目など）は空文字列（`''`）。
   * - 設定の文書の外（プロファイルとの結びつき、モード）についての誤りと、写せない値の誤りは `null`。
   * - 位置に入るのは、スキーマの項目の名前と配列の位置だけ（設定の値を入れない）。管理データにも成果物にも保存しない（返すだけ）。
   */
  readonly pointer: string | null;
}

/** 認証の設定の検証の結果。受けるときは凍結した写し、拒むときは当たった誤りのすべて（1 件以上）。 */
export type AuthSetupValidationResult =
  | { readonly ok: true; readonly setup: AuthSetup }
  | { readonly ok: false; readonly errors: readonly AuthSetupValidationError[] };
