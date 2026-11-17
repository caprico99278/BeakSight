// 認証の設定（`beaksight-auth-setup/3`）の契約の SSOT（Task 25 の設計書 4.1、5 章。T25a）。
// - 版の経緯: 版 1（T25a）、版 2（Task 26 の設計書 4.3。T26b）で自動ログインの設定（`automatedLogin`）を足し、版 3（Task 34 の設計書 3.2。T34a）で
//   ログインの送り方（`loginTransport`）、スクリプトの送信先（`scriptLogin`）、ログインに伴う送信（`loginSideRequests`）、成功のローカル ストレージの
//   鍵の形（`successStorageKey`）を足した。
// - LG-3b（2026-10-24 のテストの組の設計 3.7.2）: 版 1・版 2 の型・定数・スキーマ・読み替えは捨てた（利用者のデータは版 3 だけ）。検証
//   （`validateAuthSetup`）が受け、保存の部品が書いて読むのは版 3 だけ。前の版の文書は、形の誤り（保存の部品の読み出しでは `DATABASE_INTEGRITY_FAILED`）。
// - JSON Schema は `schemas/control/auth-setup-v3.schema.json`（検証の名前 `AUTH_SETUP_SCHEMA_NAME`）。
// - プロファイル（`beaksight-profile/1`）は変えず、別の文書を `profileId` と `profileRevision` に結びつける。
// - 値の一覧は `as const` の凍結した配列として 1 回だけ定義し、TypeScript の型はその配列から導く（`src/control/contracts.ts` と同じ方式）。
// - JSON Schema の上限は、ここの名前つきの定数と一致することをテストで固定する（`tests/unit/control-auth-setup.test.ts`）。
// - 判定（検証）は `auth-setup-policy.ts` の 1 か所。既定で読まない危険な語の一覧は、平らなデータとして `src/core/default-excluded-url-words.ts` に置き
//   （AS-b で移した。ここから同じ名前で公開し直す）、判定そのものは要求の判定の owner（`src/safety/request-policy.ts`。T25b）が、この一覧を受け取って行う。
// Node 専用。Playwright と監査エンジン（`src/browser/`、`src/safety/`、`src/orchestration/`）を import しない。

/** 認証の設定の版 3（Task 34 の設計書 3.2。T34a）。版 3 のスキーマの `schemaVersion` の const と一致する（受ける版はこれだけ。LG-3b）。 */
export const AUTH_SETUP_SCHEMA_VERSION_3 = 'beaksight-auth-setup/3';

/** 認証の設定の形を確かめるスキーマの名前（唯一の定義。検証・digest・保存の読み出しが使う。LG-3b）。 */
export const AUTH_SETUP_SCHEMA_NAME = 'auth-setup-v3';

/**
 * ログインの送り方（版 3。閉じた一覧）。`FORM_NAVIGATION` は今の形（フォームの送信のページの移動の POST を、`loginPostEndpoints` の送信先にだけ
 * 許す）。`SCRIPT_REQUEST` は、画面の中のスクリプトが、承認したサービスの Origin の送信先（`scriptLogin`）へ token を取りに行く形（Task 34）。
 * 版 3 のスキーマの `loginTransport` の enum と、この順で一致する。
 */
export const LOGIN_TRANSPORTS = Object.freeze(['FORM_NAVIGATION', 'SCRIPT_REQUEST'] as const);
export type LoginTransport = (typeof LOGIN_TRANSPORTS)[number];

/** フォームの送信のログイン（今の形）。 */
export const FORM_NAVIGATION_TRANSPORT = 'FORM_NAVIGATION' satisfies LoginTransport;

/** スクリプトで送るログイン（Task 34）。 */
export const SCRIPT_REQUEST_TRANSPORT = 'SCRIPT_REQUEST' satisfies LoginTransport;

/** スクリプトの token の送信の method（`POST` に固定。設定の項目には持たない）。 */
export const SCRIPT_LOGIN_METHOD = 'POST';

// LZ-2: 必須の query の名前と値の長さの上限（前は `MAX_SCRIPT_LOGIN_QUERY_PART_LENGTH` 256）は撤廃した。

/**
 * L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。設計者の判断 (b)）: 次の件数と回数の上限は撤廃した（スキーマの maxItems・maximum を外し、検証と
 * Guard は使わない。下限は残す）。ログインに伴う送信の件数・ログインの段 1 回あたりの回数の最大・監査の段の読み取りの手続きの呼び出しの件数・1 回の
 * 読み込みあたりの回数の最大・承認したサービスへの要求の上限の最大・ログインの送信先の件数・IdP の Origin の件数・必須の query の件数。登録した送信先は
 * 何回でも通す。ログインの段の POST の回数（`MAX_LOGIN_ATTEMPTS`。自動ログインの回数）は残す。どこからも使われない定数は LZ-1 で消した。
 * LZ-3a（DEF-259）: ワーカーの報告の数の一覧（`worker-message.schema.json` の `scriptLoginCounts.sideRequestsAllowed`）に残っていた件数の上限（前は
 * `MAX_LOGIN_SIDE_REQUESTS` 8）も撤廃した（9 件以上を登録すると、ワーカーの報告を親が受けなかった）。
 */

/** ログインに伴う送信の method（閉じた一覧。`POST` だけ）。版 3 のスキーマの enum と一致する。 */
export const LOGIN_SIDE_REQUEST_METHODS = Object.freeze(['POST'] as const);
export type LoginSideRequestMethod = (typeof LOGIN_SIDE_REQUEST_METHODS)[number];

/**
 * ログインに伴う送信の、ログインの段 1 回あたりの回数の下限（スキーマの minimum）と、画面の手での登録が書き込む値（`MAX_…`。L11 で上限としては撤廃した。
 * `src/control/manual-login-registration.ts` が登録の値として使う）。
 */
export const MIN_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE = 1;
export const MAX_LOGIN_SIDE_REQUESTS_PER_LOGIN_STAGE = 3;

/** 監査の段の読み取りの手続きの呼び出しの method（閉じた一覧。`POST` だけ。T35a）。版 3 のスキーマの enum と一致する。 */
export const AUDIT_READ_REQUEST_METHODS = Object.freeze(['POST'] as const);
export type AuditReadRequestMethod = (typeof AUDIT_READ_REQUEST_METHODS)[number];

/** 監査の段の読み取りの手続きの呼び出しの、1 回の読み込み（Context）あたりの回数の下限（スキーマの minimum。T35a。上限は L11 で撤廃した）。 */
export const MIN_AUDIT_READ_REQUESTS_PER_PAGE_LOAD = 1;

/**
 * 承認したサービスの Origin への要求の上限（`serviceRequestLimits`。T35a）の値の下限（スキーマの minimum。前に保存した設定の形の確かめだけに使う）。
 * L11 で上限としては使わなくなり、LZ-3c で最大（前は `MAX_SERVICE_REQUESTS_PER_MINUTE` 600・`MAX_SERVICE_REQUESTS_PER_RUN` 10,000）と既定の値を捨てた。
 */
export const MIN_SERVICE_REQUESTS_PER_MINUTE = 1;
export const MIN_SERVICE_REQUESTS_PER_RUN = 1;

// LZ-2: 成功のローカル ストレージの鍵の形の接頭辞と接尾辞の長さの上限（前は `MAX_SUCCESS_STORAGE_KEY_PART_LENGTH` 256）は撤廃した。

/** ログインの段で許す POST の回数の下限（設計書 4.1。スキーマの `maxLoginAttempts` の minimum）。 */
export const MIN_LOGIN_ATTEMPTS = 1;

/** ログインの段で許す POST の回数の上限（設計書 4.1。総当たりをしない。I05。スキーマの `maxLoginAttempts` の maximum）。 */
export const MAX_LOGIN_ATTEMPTS = 3;

// URL-LEN: URL と Origin と path の長さの上限（前は 2,048）は撤廃した（スキーマにも `maxLength` を置かない）。

// LZ-3a: `excludedPaths` と `auditPathPrefixes` の件数の上限（前は `MAX_AUTH_SETUP_PATH_LIST_ITEMS` 50）は撤廃した（スキーマにも maxItems を置かない）。

// LZ-2: 成功の条件・自動ログインの 3 つの欄・失敗の条件のセレクタの長さの上限（前は `MAX_SUCCESS_SELECTOR_LENGTH` 256）は撤廃した。

/**
 * 自動ログインのプロファイル（`AUTOMATED_LOGIN`）で受ける `maxLoginAttempts` の値（Task 26 の設計書 4.3、4.5。1 回のジョブでログインの
 * POST は 1 回だけ。アカウントのロックを誘発しない）。`MIN_LOGIN_ATTEMPTS` から `MAX_LOGIN_ATTEMPTS` の範囲の中の値。
 */
export const AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS = 1;

/**
 * 自動ログインの失敗の条件の閉じた一覧（Task 26 の設計書 4.3、4.4 の結果の区別）。それぞれ、資格情報の誤り・アカウントのロック・MFA で人の
 * 操作が要る・資格情報の期限切れ。スキーマの `failureConditions` の項目と、この順で一致する。
 */
export const AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS = Object.freeze([
  'invalidCredentials',
  'accountLocked',
  'mfaRequired',
  'credentialExpired',
] as const);
export type AutomatedLoginFailureConditionKind = (typeof AUTOMATED_LOGIN_FAILURE_CONDITION_KINDS)[number];

// 秘密に見える query の名前の語（`SECRET_LIKE_QUERY_NAME_WORDS`。`loginStartUrl` の query の名前を小文字にし、英数字以外を除いた文字列が、
// この語のどれかを含めば拒む。`AUTH_SETUP_SECRET_LIKE_VALUE`。fail-closed なので、`author` のような語も拒む）の一覧と比べ方の owner は
// `src/core/secret-query-names.ts`（CCX-4）。PRE42-CC 組 Z: ここでは公開し直さない（呼び出し側は core から読む）。

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

/** 必須の query の組 1 つ（名前と値の完全な一致。値は秘密でない決まった値。例 `grant_type=password`）。 */
export interface ScriptLoginQueryParameter {
  readonly name: string;
  readonly value: string;
}

/**
 * スクリプトの token の送信先（版 3。`SCRIPT_REQUEST` のとき必須）。method は `SCRIPT_LOGIN_METHOD` に固定（項目に持たない）。
 * - `origin`: プロファイルの承認したサービスの Origin（`approvedServiceOrigins`）のどれか。
 * - `path`: `/` で始まる path（query を持たない。query は `requiredQuery`）。
 * - `requiredQuery`: 要求の query に、この組がすべてあること（L11: 件数の上限なし。名前の重なりなし。秘密に見える名前は持てない）。
 */
export interface ScriptLoginTarget {
  readonly origin: string;
  readonly path: string;
  readonly requiredQuery: readonly ScriptLoginQueryParameter[];
}

/**
 * ログインに伴う送信 1 つ（版 3。利用者が登録したもの。ログインの段で、この送信先への `POST` を、決まった回数だけ通す。query と本文は照らさない）。
 * - `origin`: 承認したテストの Origin か、承認したサービスの Origin。`path`: `/` で始まる path（完全一致）。
 * - `method`: `LOGIN_SIDE_REQUEST_METHODS`（`POST` だけ）。`maxPerLoginStage`: ログインの段 1 回あたりの上限（1〜3）。
 */
export interface LoginSideRequest {
  readonly origin: string;
  readonly path: string;
  readonly method: LoginSideRequestMethod;
  readonly maxPerLoginStage: number;
}

/**
 * 監査の段で通す、読み取りのための手続きの呼び出し 1 つ（版 3 の任意の項目 `auditReadRequests` の 1 件。T35a。Task 35 の設計書 3.1）。監査の段で、この
 * 送信先への `POST`（fetch か xhr）を、1 回の読み込みあたり決まった回数だけ通す。読み取りであることは利用者の判断。query と本文は照らさない。
 * - `origin`: 承認したテストの Origin か、承認したサービスの Origin。`path`: `/` で始まる path（完全一致）。
 * - `method`: `AUDIT_READ_REQUEST_METHODS`（`POST` だけ）。`maxPerPageLoad`: 1 回の読み込みあたりの上限（1〜10）。
 * ログインに伴う送信・スクリプトの送信先と同じ Origin と path を持ってよい（段が違い、数え方も違う）。
 */
export interface AuditReadRequest {
  readonly origin: string;
  readonly path: string;
  readonly method: AuditReadRequestMethod;
  readonly maxPerPageLoad: number;
}

/**
 * 承認したサービスの Origin への要求の上限（版 3 の任意の項目 `serviceRequestLimits`。T35a）。LZ-3c: 前に保存した設定を読むために、項目は受けて形を確かめるが、
 * 使わない（監査の段の口にもワーカーへも写さない）。画面は書かない。既定の値（前の `DEFAULT_SERVICE_REQUEST_LIMITS`・`defaultServiceRequestLimitsFor`・
 * `SERVICE_REQUESTS_PER_PAGE_ALLOWANCE`）は捨てた。
 */
export interface ServiceRequestLimits {
  readonly perMinute: number;
  readonly perRun: number;
}

/**
 * 成功のローカル ストレージの鍵の形（版 3。`SCRIPT_REQUEST` のとき必須）。成功の条件に足す（その Origin のローカル ストレージに、接頭辞で始まり接尾辞で
 * 終わる名前の鍵があること）。値は読まない。`origin` は承認したテストの Origin のどれか。接頭辞と接尾辞の両方が空ではいけない。
 */
export interface SuccessStorageKey {
  readonly origin: string;
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * 認証の設定の版 3（Task 34 の設計書 3.2）。設計書 4.1 の表の項目、自動ログインの設定（`automatedLogin`。自動ログインのプロファイル（`AUTOMATED_LOGIN`）
 * では必須、手動のログインのプロファイル（`MANUAL_SESSION`）では null。判定は `validateAuthSetup`）、ログインの送り方と、スクリプトで送るログインの項目。
 * - `FORM_NAVIGATION`: `scriptLogin` と `successStorageKey` は null、`loginSideRequests` は空、`loginPostEndpoints` は 1 つ以上（今の形）。
 * - `SCRIPT_REQUEST`: `scriptLogin` と `successStorageKey` が必須、`loginPostEndpoints` は空でよい。
 * - T35a（Task 35 の設計書 3.1）: 任意の項目 `auditReadRequests`（監査の段の読み取りの手続きの呼び出し）と `serviceRequestLimits`（承認したサービスの
 *   Origin への要求の上限。LZ-3c: 受けて使わない）。`SCRIPT_REQUEST` のときだけ持てる。項目のない文書は、版 3 の今の文書のまま（digest も変わらない）。
 */
export interface AuthSetupV3 extends AuthSetupFields {
  readonly schemaVersion: typeof AUTH_SETUP_SCHEMA_VERSION_3;
  readonly automatedLogin: AutomatedLoginSetup | null;
  readonly loginTransport: LoginTransport;
  readonly scriptLogin: ScriptLoginTarget | null;
  readonly loginSideRequests: readonly LoginSideRequest[];
  readonly successStorageKey: SuccessStorageKey | null;
  readonly auditReadRequests?: readonly AuditReadRequest[];
  readonly serviceRequestLimits?: ServiceRequestLimits;
}

/** 認証の設定（検証を通る版。LG-3b から版 3 だけ）。 */
export type AuthSetup = AuthSetupV3;

/** ログインの送り方（LG-3b: 版 3 の項目そのまま。前の版を `FORM_NAVIGATION` とみなす読み替えは捨てた）。 */
export const loginTransportOf = (setup: AuthSetup): LoginTransport => setup.loginTransport;

/** 設計書 4.1 の表の項目。 */
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
  // T34a（Task 34 の設計書 3.2）: 版 3（スクリプトで送るログイン）の誤り。
  /** `SCRIPT_REQUEST` なのに、スクリプトの送信先（`scriptLogin`）か成功のローカル ストレージの鍵（`successStorageKey`）がない。 */
  'AUTH_SETUP_SCRIPT_LOGIN_REQUIRED',
  /** `FORM_NAVIGATION` なのに、スクリプトの送信先、成功のローカル ストレージの鍵、ログインに伴う送信のどれかを持つ。 */
  'AUTH_SETUP_SCRIPT_LOGIN_NOT_ALLOWED',
  /** 版 3 の `FORM_NAVIGATION` なのに、フォームの送信先（`loginPostEndpoints`）がない。 */
  'AUTH_SETUP_LOGIN_POST_ENDPOINTS_REQUIRED',
  /** スクリプトの送信先の Origin が、プロファイルの承認したサービスの Origin（`approvedServiceOrigins`）に含まれない。 */
  'AUTH_SETUP_SERVICE_ORIGIN_NOT_APPROVED',
  /** 必須の query の組が正しくない（名前が空、名前の重なり、空白だけでない値の中の制御文字や行の区切り）。 */
  'AUTH_SETUP_REQUIRED_QUERY_INVALID',
  /** ログインに伴う送信の送信先（Origin と path）が、ほかのログインに伴う送信かスクリプトの送信先と同じ。 */
  'AUTH_SETUP_LOGIN_SIDE_REQUEST_DUPLICATED',
  /** 成功のローカル ストレージの鍵の形が正しくない（接頭辞と接尾辞の両方が空、制御文字や行の区切りを含む）。 */
  'AUTH_SETUP_STORAGE_KEY_INVALID',
  // T36a（Task 36 の設計書 3.1）: T34R-fix-b（M-3）の `AUTH_SETUP_SCRIPT_LOGIN_AUTOMATED_NOT_SUPPORTED`（自動ログインのプロファイルの `SCRIPT_REQUEST` を
  // 拒む）は、自動ログインのスクリプトの送信を受けるようにしたので外した（検証の誤りのコードは保存せず、読み手がないので一覧に残さない）。
  /** T35a（Task 35 の設計書 3.1）: 監査の段の読み取りの手続きの呼び出し（Origin と path）が、ほかの読み取りの手続きの呼び出しと同じ。 */
  'AUTH_SETUP_AUDIT_READ_REQUEST_DUPLICATED',
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
