// 認証つきの Run の指定（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 3 章、4.3、4.7 と、変更履歴の
// 2026-10-10 の Blocker の行。T25c）。監査の本体の側の、平らなデータと関数だけで、`src/control/` を読まない（Task 22 の Gate）。
// - 指定の形と検査（`RunAuthentication`、`assertRunAuthentication`）。
// - factory に渡す指定（`authenticatedContextOptions`。絞り込みの関数に、許可 Origin を包む）。
// - 認証つきの Run の有効な設定（`authenticatedRunConfig`。Interaction を行わないことを `audit.interactions: false` で記録する。4.7）。
// - 読み込みの事前の判定（`isRunNavigationBlocked`。CCX-10）: main frame のナビゲーションの GET として、要求の判定の owner の
//   `classifyPassiveRequest` に、許可 Origin と `auditExclusions` の口を渡し、あわせてセッションの切れの path を見る。止める範囲は引数で選ぶ
//   （`AUDIT_EXCLUSION`: 監査の段の除外の BLOCK だけ。巡回の候補の除外。`ANY_BLOCK`: どの BLOCK でも。READ の確かめの事前の判定
//   `isReadUrlAllowed`）。巡回と READ の確かめの両方が、ここを使う（同じ意味の判定を書き写さない）。
// - 巡回の候補から外す URL の判定（`isExcludedCrawlCandidate`。上の判定を `AUDIT_EXCLUSION` で呼ぶ。新しく書かない）。
// - セッションの切れの判定（`isSessionLostUrl`。読み込みの後の判定 `sessionLostUrlOf` は Page Auditor とワーカーの流れが共用する。CCX-6）と、
//   その理由（`AUTH_SESSION_LOST_SKIP_REASON`、`authSessionLostReason`）。DF-3: 確かめる時機の一覧（`SESSION_LOSS_CHECK_POINTS`）と、時機を付けて
//   判定を呼ぶ補助（`sessionLostUrlAt`。Page Auditor とワーカーの 1 画面の読み込みは、これを通す）。
// - 認証つきの Run の設定の確かめ（`secretAllowedQueryParameters`。T25f round 1）: `crawl.allowedQueryParameters` に、URL の伏せ字の一覧
//   （伏せ字の owner の `isSecretUrlQueryParameterName`）に当たる名前があれば、監査を始めない（`assertRunAuthentication` から呼ぶ）。
// 秘密（Cookie と localStorage の値）は、ここで読まず、誤りの文にも入れない。
import type { Page, Request } from 'playwright';
import {
  isAuditStageServiceRequests,
  type AuditStageServiceRequests,
  type AuthenticatedContextOptions,
  type AuthenticatedContextStateNames,
  type AuthenticatedStateNames,
  type AuthenticatedStorageState,
} from '../browser/context-factory.js';
import { isMainFrameNavigationRequest } from '../browser/main-frame-load.js';
import { ConfigError } from '../config/config-error.js';
import type { AuditConfig } from '../config/types.js';
import type { IncompleteReason, IncompleteReasonCode } from '../core/contracts.js';
import {
  BLOCKED_AUDIT_EXCLUSION_REASONS,
  MAX_SESSION_LOSS_BLOCKED_REQUESTS,
  MAX_SESSION_LOSS_KEY_SHAPES,
  MAX_SESSION_LOSS_PATH_LENGTH,
  MAX_SESSION_LOSS_REDIRECT_PATHS,
  SESSION_LOSS_KEY_CHANGES,
  SESSION_LOSS_ORIGIN_KINDS,
  SESSION_LOSS_STORAGE_KINDS,
  type SessionLossBlockedRequest,
  type SessionLossBlockedRequestReason,
  type SessionLossEvidence,
  type SessionLossKeyShape,
  type SessionLossLandedBy,
  type SessionLossOriginKind,
  type SessionLossPathRecord,
  type SessionLossStorageKeyChange,
  type SessionLossStorageKind,
} from '../core/evidence-types.js';
import { isRecord } from '../core/guards.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { saturatingIncrement } from '../core/saturating-count.js';
import { sortedKeysJsonOf } from '../core/sorted-keys-json.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
import { loginObservedQueryOf, newStorageKeyShapesOf } from '../discovery/login-observation.js';
import { recordedRequestPathOf } from '../safety/login-stage-blocked-requests.js';
import { isSecretUrlQueryParameterName } from '../safety/redact.js';
import { classifyPassiveRequest, type AuditExclusionPolicy } from '../safety/request-policy.js';
import type { SafetyLedger } from '../safety/safety-ledger.js';
import type { RunCheckpointAuthentication } from './run-checkpoint.js';

/**
 * 認証つきの Run の指定（`RunCoordinatorDependencies.authentication`）。呼び出し側（ワーカー。T25d）が、ログインの段の後に作る。
 * - `initialState`: ログインの段で取り出した認証済みの状態（メモリだけ。ファイルに書かない）。
 * - `approvedTestOrigins`: 状態を渡してよい Origin（認証の設定の `approvedTestOrigins`）。設定の `site.allowedOrigins` に含まれなければならない。
 * - `auditExclusions`: 監査の段の除外（認証の設定の `excludedPaths`、`auditPathPrefixes`、既定の危険な語）。
 * - `sessionLostPathPrefix`: セッションの切れと判定する path の前方一致（認証の設定の `sessionLostCondition`。`/` で始まる）。
 * - `filterState`: 状態を絞る関数（認証の設定の owner の `filterAuthenticatedState`。2 つ目の引数に `approvedTestOrigins` を渡す。DEF-139: 3 つ目の
 *   引数に、監査の段の口の承認したサービスの Origin（口がなければ空）を渡す）。
 * - `auditStage`（T35a。Task 35 の設計書 3.2）: スクリプトで送るログインの監査の段の口（`AuditStageServiceRequests`）。スクリプトで送るログインの Run
 *   だけが持つ（フォームの送信のログインの Run は持たない。振る舞いを変えない）。factory の指定へ写し（`authenticatedContextOptions`）、Run の種類の値
 *   （`runCheckpointAuthenticationOf`）に入れる。
 */
export interface RunAuthentication {
  readonly initialState: AuthenticatedStorageState;
  readonly approvedTestOrigins: readonly string[];
  readonly auditExclusions: AuditExclusionPolicy;
  readonly sessionLostPathPrefix: string;
  readonly filterState: (
    state: AuthenticatedStorageState,
    approvedTestOrigins: readonly string[],
    approvedServiceOrigins?: readonly string[],
  ) => AuthenticatedStorageState;
  readonly auditStage?: AuditStageServiceRequests | undefined;
  /**
   * T35c（Task 35 の設計書 3.5）: ログインの状態の鍵があるかの判定（スクリプトで送るログインの Run だけ。ワーカーが、認証の設定の成功の鍵の形で作る）。
   * factory の指定へ写し（`authenticatedContextOptions`）、factory が Context の状態を読み直したときに使う（鍵がなければセッションの切れ）。
   */
  readonly sessionKeyPresent?: ((state: AuthenticatedStorageState) => boolean) | undefined;
}

/**
 * 保存に記録する、認証つきの Run の種類の値を作る（T25g-2。独立レビュー T25R の Important I1）。認証の設定のうち、秘密を含まない値（許可
 * Origin、監査の段の除外、セッションの切れの path）を、決まった順の JSON にして SHA-256 にする。状態（Cookie と localStorage）は入れない
 * （ログインのたびに変わる値で、Run の種類ではなく、秘密でもあるため）。配列の順は変えない（順が違う設定は、違う設定として扱う。安全の側）。
 * T35a（Task 35 の設計書 3.2）: 監査の段の口（`auditStage`）があれば、その値（承認したサービスの Origin、読み取りの手続きの呼び出し、token の送信先、
 * 要求の上限。鍵を並べた JSON）も入れる。口のない Run の値は、T35a の前と同じ（テストで固定）。
 */
export function runCheckpointAuthenticationOf(
  authentication: Pick<RunAuthentication, 'approvedTestOrigins' | 'auditExclusions' | 'sessionLostPathPrefix' | 'auditStage'>,
): RunCheckpointAuthentication {
  const { approvedTestOrigins, auditExclusions, sessionLostPathPrefix, auditStage } = authentication;
  const canonical = JSON.stringify([
    [...approvedTestOrigins],
    [...auditExclusions.excludedPathPrefixes],
    [...auditExclusions.auditPathPrefixes],
    [...auditExclusions.dangerousTerms],
    sessionLostPathPrefix,
    ...(auditStage === undefined ? [] : [sortedKeysJsonOf(auditStage)]),
  ]);
  return Object.freeze({ settingsDigest: createSha256Fingerprint(canonical) });
}

/** セッションの切れの path の前方一致の先頭（path の形）。 */
const PATH_PREFIX_START = '/';

/** 認証つきの Run で、セッションの切れを検知した理由のコード。 */
const AUTH_SESSION_LOST_CODE: Extract<IncompleteReasonCode, 'AUTH_SESSION_LOST'> = 'AUTH_SESSION_LOST';

/**
 * セッションの切れを検知した後に始めなかったページとビューポートの理由（`detail` は `null`）。Run の理由にも、これを1件残す。
 */
export const AUTH_SESSION_LOST_SKIP_REASON: IncompleteReason = Object.freeze({ code: AUTH_SESSION_LOST_CODE, detail: null });

/** セッションの切れを検知した理由（`detail` は当たった場所。例: `desktop:passive`。URL は入れない）。結果は凍結する。 */
export function authSessionLostReason(detail: string): IncompleteReason {
  return Object.freeze({ code: AUTH_SESSION_LOST_CODE, detail });
}

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * 設定の `crawl.allowedQueryParameters` のうち、URL の伏せ字の一覧に当たる名前（伏せ字の owner の `isSecretUrlQueryParameterName`。T25f round 1）。
 * 認証つきの Run では、成果物と保存に書く URL の、これらの値を伏せる。巡回の記録（ページの URL）に、これらの名前を残すと、伏せ字の後の保存から
 * 再開できず、伏せ字で別のページが同じに見えるので、認証つきの Run では受けない（`assertRunAuthentication`）。並びは設定のまま。
 */
export function secretAllowedQueryParameters(config: Pick<AuditConfig, 'crawl'>): readonly string[] {
  return config.crawl.allowedQueryParameters.filter((name) => isSecretUrlQueryParameterName(name));
}

/**
 * 認証つきの Run の指定の形を確かめる（Run Coordinator のコンストラクタが呼ぶ）。形が正しくないか、`approvedTestOrigins` が空か、設定の
 * `site.allowedOrigins` に含まれない Origin があれば `TypeError`（fail-closed）。誤りの文に、状態の値を入れない。
 * 形が正しくても、設定の `crawl.allowedQueryParameters` に URL の伏せ字の一覧に当たる名前があれば（`secretAllowedQueryParameters`。T25f round 1）、
 * 設定のエラー（`ConfigError` の `CONFIG_INVALID`。詳細に名前を入れる。ワーカーは `FAILED` の `CONFIG_ERROR` で終える）を投げ、監査を始めない。
 */
export function assertRunAuthentication(value: unknown, config: AuditConfig): asserts value is RunAuthentication {
  if (!isRecord(value)) {
    throw new TypeError('RunCoordinator authentication must be an object when given');
  }
  const { initialState, approvedTestOrigins, auditExclusions, sessionLostPathPrefix, filterState } = value;
  if (!isRecord(initialState) || !Array.isArray(initialState.cookies) || !Array.isArray(initialState.origins)) {
    throw new TypeError('RunCoordinator authentication requires an initial state with cookies and origins');
  }
  if (typeof filterState !== 'function') {
    throw new TypeError('RunCoordinator authentication requires a filterState function');
  }
  if (
    !isRecord(auditExclusions)
    || !isStringArray(auditExclusions.excludedPathPrefixes)
    || !isStringArray(auditExclusions.auditPathPrefixes)
    || !isStringArray(auditExclusions.dangerousTerms)
  ) {
    throw new TypeError('RunCoordinator authentication requires audit exclusions');
  }
  if (typeof sessionLostPathPrefix !== 'string' || !sessionLostPathPrefix.startsWith(PATH_PREFIX_START)) {
    throw new TypeError('RunCoordinator authentication session lost path prefix must start with "/"');
  }
  if (!isStringArray(approvedTestOrigins) || approvedTestOrigins.length === 0) {
    throw new TypeError('RunCoordinator authentication requires approved test origins');
  }
  if (!approvedTestOrigins.every((approved) => isOriginInAllowedOrigins(config.site.allowedOrigins, approved))) {
    throw new TypeError('RunCoordinator authentication approved test origins must be included in site.allowedOrigins');
  }
  // T35c（T35a の設計者の判断）: 監査の段の口の形を確かめる（fail-closed。値の意味は Guard と認証の設定の契約が確かめる）。
  if (value.auditStage !== undefined && !isAuditStageServiceRequests(value.auditStage)) {
    throw new TypeError('RunCoordinator authentication audit stage must have service origins, read requests, a script login and limits');
  }
  if (value.sessionKeyPresent !== undefined && typeof value.sessionKeyPresent !== 'function') {
    throw new TypeError('RunCoordinator authentication session key check must be a function');
  }
  assertNoSecretAllowedQueryParameters(config);
}

/**
 * 設定の `crawl.allowedQueryParameters` に、URL の伏せ字の一覧に当たる名前（`secretAllowedQueryParameters`）があれば、設定のエラー（`ConfigError` の
 * `CONFIG_INVALID`。詳細に名前を入れる。ワーカーは `FAILED` の `CONFIG_ERROR` で終える）を投げ、監査を始めない（T25f round 1。この決まりの 1 か所）。
 * T44g（Task 44 の設計書 P4-1 の発見事項 4）: 公開監査の書き手も保存と成果物の URL の秘密に見える名前の値を伏せるので、公開監査にも当てる（Run Coordinator
 * のコンストラクタが、認証の指定の有無によらず呼ぶ。認証つきの Run は `assertRunAuthentication` からも呼ぶ）。
 */
export function assertNoSecretAllowedQueryParameters(config: Pick<AuditConfig, 'crawl'>): void {
  const secretNames = secretAllowedQueryParameters(config);
  if (secretNames.length > 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'a Run cannot keep secret-like query parameters in crawl.allowedQueryParameters',
      secretNames.map((name) => `crawl.allowedQueryParameters must not contain ${JSON.stringify(name)}`),
    );
  }
}

/**
 * factory に渡す認証の指定（T25c）。絞り込みの関数に、許可 Origin を包む。状態と除外は、そのまま渡す（factory が写しを取る）。
 */
export function authenticatedContextOptions(authentication: RunAuthentication): AuthenticatedContextOptions {
  const approvedTestOrigins = Object.freeze([...authentication.approvedTestOrigins]);
  const { auditStage } = authentication;
  // DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.2）: 承認したサービスの Origin（監査の段の口があるときだけ）へ送る Cookie と、
  // その Origin の IndexedDB も引き継ぐ（絞り込みの owner の 3 つ目の引数）。
  const approvedServiceOrigins = Object.freeze([...(auditStage?.approvedServiceOrigins ?? [])]);
  return Object.freeze({
    initialState: authentication.initialState,
    filterState: (state: AuthenticatedStorageState) => authentication.filterState(state, approvedTestOrigins, approvedServiceOrigins),
    auditExclusions: authentication.auditExclusions,
    // T35a: スクリプトで送るログインの監査の段の口（あるときだけ。Guard への取り付けは T35b）。
    ...(auditStage === undefined ? {} : { auditStage }),
    // T35c: ログインの状態の鍵があるかの判定（あるときだけ）。
    ...(authentication.sessionKeyPresent === undefined ? {} : { sessionKeyPresent: authentication.sessionKeyPresent }),
  });
}

/**
 * 認証つきの Run の有効な設定（Task 25 の設計書 4.7 と、変更履歴の 2026-10-10 の Blocker の行の (1)）。Interaction（クリックによる操作の
 * 確かめ）を行わないことを、`audit.interactions: false` で記録する（`run.json` の `effectiveConfig`。ページの結果を PARTIAL にしない）。
 * ほかの項目（速さの上限を含む）は変えない。入力は変えない。
 */
export function authenticatedRunConfig(config: AuditConfig): AuditConfig {
  return { ...config, audit: { ...config.audit, interactions: false } };
}

/** 監査の段の除外の BLOCK の理由（要求の判定の結果が、除外によるものかを見分ける。一覧の owner は core）。 */
const AUDIT_EXCLUSION_REASONS: readonly string[] = BLOCKED_AUDIT_EXCLUSION_REASONS;

/** 読み込みの事前の判定に使う、main frame のナビゲーションの GET の事実（要求の判定の入力の形）。 */
const RUN_NAVIGATION_METHOD = 'GET';

/**
 * 読み込みの事前の判定で止める、要求の判定の BLOCK の範囲（閉じた一覧。CCX-10）。
 * - `AUDIT_EXCLUSION`: 監査の段の除外の理由（`BLOCKED_AUDIT_EXCLUSION_REASONS`）の BLOCK だけ（巡回の候補の除外。ほかの BLOCK は、読み込みの
 *   ときに Guard が止めて記録する）。
 * - `ANY_BLOCK`: どの BLOCK でも（READ の確かめの事前の判定。読まずに `READ_BLOCKED_BY_POLICY` にする。fail-closed）。
 */
export const RUN_NAVIGATION_BLOCK_SCOPES = Object.freeze(['AUDIT_EXCLUSION', 'ANY_BLOCK'] as const);
export type RunNavigationBlockScope = (typeof RUN_NAVIGATION_BLOCK_SCOPES)[number];

/**
 * 読み込みの事前の判定（CCX-10。巡回の候補の除外と、READ の確かめの事前の判定の共通の部品）。次のどちらかなら真（読み込まない）。
 * - 要求の判定の owner の `classifyPassiveRequest` に、main frame のナビゲーションの GET として、許可 Origin と `auditExclusions` の口を渡し、
 *   `scope` の範囲の BLOCK になる（Guard と同じ判定）。
 * - セッションの切れの path に当たる（ログインの画面。読むと、セッションの切れと取り違えて Run を止めるため）。
 */
export function isRunNavigationBlocked(
  url: string,
  allowedOrigins: ReadonlySet<string>,
  authentication: Pick<RunAuthentication, 'auditExclusions' | 'sessionLostPathPrefix'>,
  scope: RunNavigationBlockScope,
): boolean {
  const decision = classifyPassiveRequest(
    { kind: 'HTTP', method: RUN_NAVIGATION_METHOD, url, isNavigationRequest: true, isMainFrame: true },
    allowedOrigins,
    { auditExclusions: authentication.auditExclusions },
  );
  const blocked = decision.action === 'BLOCK' && (scope === 'ANY_BLOCK' || AUDIT_EXCLUSION_REASONS.includes(decision.reason));
  return blocked || isSessionLostUrl(url, authentication.sessionLostPathPrefix);
}

/**
 * 巡回の候補から外す URL か（Task 25 の設計書 4.2、4.7。T25c）。読み込みの事前の判定（`isRunNavigationBlocked`）を、監査の段の除外の範囲
 * （`AUDIT_EXCLUSION`）で呼ぶ。監査の段の除外に当たるか、セッションの切れの path に当たれば真。
 */
export function isExcludedCrawlCandidate(
  url: string,
  allowedOrigins: ReadonlySet<string>,
  authentication: Pick<RunAuthentication, 'auditExclusions' | 'sessionLostPathPrefix'>,
): boolean {
  return isRunNavigationBlocked(url, allowedOrigins, authentication, 'AUDIT_EXCLUSION');
}

/**
 * URL の path が、セッションの切れの path の前方一致（`prefix`）に当たるか（Task 25 の設計書 4.3）。解析できない URL は偽（ページの中の
 * `about:blank` などは、セッションの切れの印にしない）。
 */
export function isSessionLostUrl(url: string, prefix: string): boolean {
  try {
    return new URL(url).pathname.startsWith(prefix);
  } catch {
    return false;
  }
}

/**
 * 読み込みの後に、セッションが切れたか（Task 25 の設計書 4.3。CCX-6 で、Page Auditor とワーカーの 1 画面の読み込みの 2 か所から 1 つにした）。
 * - main frame の最後の URL（`page.url()`）の path が、セッションの切れの path の前方一致（`prefix`）に当たれば、その URL。
 * - 当たらなければ、その Context の Guard が監査の段の除外で止めた main frame の移動の先（Safety Ledger の `blockedAuditExclusions` の、
 *   `mainFrameNavigation` が真の記録の URL）のうち、最初に当たるもの（ログインの画面が読む範囲の外で、Guard がリダイレクトを止めた場合）。
 * - どれも当たらなければ `null`。
 * 当たった URL は伏せ字の前の値なので、記録や知らせに使う側が伏せる。
 */
export function sessionLostUrlOf(page: Pick<Page, 'url'>, ledger: Pick<SafetyLedger, 'snapshot'>, prefix: string): string | null {
  return sessionLostLandingOf(page, ledger, prefix)?.url ?? null;
}

/**
 * セッションの切れを確かめる時機の一覧（DF-3。DEF-167。唯一の定義）。Page Auditor（監査）とワーカーの 1 画面の読み込み（発見・READ の確かめ）が読む。
 * 読み込みの後にスクリプトがログインの画面へ移すサイト（非同期で認証を確かめる SPA など）では、読み込みの直後には記録がまだないので、後の時機にも確かめる。
 * 判定は、どの時機でも同じ部品（`sessionLostUrlOf`）。値は、監査の Run の場所の印（理由 `AUTH_SESSION_LOST` の `detail` と証拠の `stage`）の時機の部分
 * （`sessionLossStageDetailOf`）にも使う。
 * - `navigation`: 読み込みが返った直後（Task 25 の設計書 4.3 の前からの時機）。
 * - `settled`: 落ち着きを待った後（DOM の準備・resource の落ち着きの後）。
 * - `beforeNextLoad`: 次の読み込み（次のビューポートと、幅の走査の各幅）の前。それまでに読み込んだ page を確かめ直す。
 * - `pageEnd`: ページの監査（1 画面の読み込み）の終わり。成果物にそのページを書く前。
 */
export const SESSION_LOSS_CHECK_POINTS = Object.freeze({
  navigation: 'navigation',
  settled: 'settled',
  beforeNextLoad: 'before-next-load',
  pageEnd: 'page-end',
} as const);

/** セッションの切れを確かめる時機（`SESSION_LOSS_CHECK_POINTS` の値）。 */
export type SessionLossCheckPoint = (typeof SESSION_LOSS_CHECK_POINTS)[keyof typeof SESSION_LOSS_CHECK_POINTS];

/** 決めた時機の確かめで、セッションの切れに当たった結果（URL は伏せ字の前の値なので、記録や知らせに使う側が伏せる）。 */
export interface SessionLossCheck {
  readonly point: SessionLossCheckPoint;
  readonly url: string;
}

/**
 * 決めた時機（`point`）に、セッションが切れたかを確かめる（DF-3。Page Auditor とワーカーの 1 画面の読み込みは、判定 `sessionLostUrlOf` を、この補助を
 * 通して呼ぶ）。判定の条件は `sessionLostUrlOf` のまま。当たらなければ `null`。結果は凍結する。
 */
export function sessionLostUrlAt(
  point: SessionLossCheckPoint,
  page: Pick<Page, 'url'>,
  ledger: Pick<SafetyLedger, 'snapshot'>,
  prefix: string,
): SessionLossCheck | null {
  const url = sessionLostUrlOf(page, ledger, prefix);
  return url === null ? null : Object.freeze({ point, url });
}

/**
 * 監査の Run の場所の印の段階の部分（DF-3）。読み込みの直後（`navigation`）は前からの形のまま段階だけ（例 `passive`）、後の時機は `<段階>:<時機>`
 * （例 `passive:settled`）。呼ぶ側が、先頭にビューポートを付ける（例 `desktop:passive:settled`）。
 */
export function sessionLossStageDetailOf(stage: string, point: SessionLossCheckPoint): string {
  return point === SESSION_LOSS_CHECK_POINTS.navigation ? stage : `${stage}:${point}`;
}

/** 行き着いた先と、どこで見たか（`sessionLostUrlOf` の判定の順。当たらなければ `null`）。 */
const sessionLostLandingOf = (
  page: Pick<Page, 'url'>,
  ledger: Pick<SafetyLedger, 'snapshot'>,
  prefix: string,
): { readonly url: string; readonly landedBy: SessionLossLandedBy } | null => {
  if (isSessionLostUrl(page.url(), prefix)) {
    return { url: page.url(), landedBy: 'PAGE_URL' };
  }
  const blocked = (ledger.snapshot().blockedAuditExclusions?.events ?? [])
    .find(({ mainFrameNavigation, url }) => mainFrameNavigation && isSessionLostUrl(url, prefix));
  return blocked === undefined ? null : { url: blocked.url, landedBy: 'BLOCKED_REDIRECT' };
};

// ---------------------------------------------------------------------------------------------------------------
// セッションの切れの証拠（DEF-138。設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 2.1）
// ---------------------------------------------------------------------------------------------------------------
// 判定（`sessionLostUrlOf`）と同じ owner に置く唯一の部品。Page Auditor（監査）とワーカーの 1 画面の読み込み（発見・READ の確かめ）が共用する。
// - 経路の記録（`observeSessionLossNavigation`）: 読み込みの前に page に付け、main frame の文書の要求の URL を上限（`MAX_SESSION_LOSS_REDIRECT_PATHS`）まで
//   メモリに持つ（リダイレクトの各段と、クライアントの側の移動の文書の要求。要求を足さない）。
// - 証拠の組み立て（`sessionLossEvidenceOf`）: 値を持たない形にする。path は止めた一覧と同じ決まり（`recordedRequestPathOf`。値に見える区切りを伏せ、
//   上限の長さで切る）、query はログインの段の観察と同じ名前の記録（`loginObservedQueryOf` の名前だけ。値に見える名前は伏せる）。止めた要求は
//   Safety Ledger の記録の形ごとに数える（上限はログインの段の止めた一覧と同じ）。鍵の名前の違いは、factory が残した名前（`AuthenticatedContextStateNames`）
//   から、ログインの段の観察と同じ接頭辞と接尾辞の案（`storageKeyShapeOf`。秘密に見える名前の端は出さない）と数にする。
// - Origin の区別は、承認したサービスの Origin、許可 Origin（Origin の照合の owner `isOriginInAllowedOrigins`）、そのほかの順に決める。

/** 経路の記録の写し（URL は伏せ字の前の値なので、証拠の組み立てだけに渡す）。 */
export interface SessionLossNavigationRecord {
  readonly urls: readonly string[];
  /** 上限を超えて記録しなかった数。 */
  readonly omitted: number;
}

/** 経路の記録（`observeSessionLossNavigation` が返す）。 */
export interface SessionLossNavigationObserver {
  snapshot(): SessionLossNavigationRecord;
  /** 記録をやめる（何度呼んでもよい）。 */
  dispose(): void;
}

/**
 * 読み込みの前に `page` に付け、main frame のナビゲーションの要求の URL を、上限まで記録する（DEF-138。値は読まない。要求を出さない）。例外を投げない。
 */
export function observeSessionLossNavigation(page: Page): SessionLossNavigationObserver {
  const urls: string[] = [];
  let omitted = 0;
  let disposed = false;
  const onRequest = (request: Request): void => {
    if (!isMainFrameNavigationRequest(page, request)) {
      return;
    }
    if (urls.length < MAX_SESSION_LOSS_REDIRECT_PATHS) {
      urls.push(request.url());
    } else {
      omitted = saturatingIncrement(omitted);
    }
  };
  try {
    page.on('request', onRequest);
  } catch {
    disposed = true;
  }
  return Object.freeze({
    snapshot: (): SessionLossNavigationRecord => Object.freeze({ urls: Object.freeze([...urls]), omitted }),
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        page.off('request', onRequest);
      } catch {
        // 閉じた page などは、外せなくても記録を増やさない（下の印で止める）。
      }
    },
  });
}

/** 証拠の組み立ての入力。 */
export interface SessionLossEvidenceInput {
  /** 判定した段階（理由の `detail` と同じ値。ワーカーは `session-key` か `null`）。 */
  readonly stage: string | null;
  /** 頼んだ URL。 */
  readonly requestedUrl: string;
  /** 読み込んだ page（閉じた後でもよい。`url()` だけを読む）。 */
  readonly page: Pick<Page, 'url'>;
  /** その Context の Safety Ledger（閉じた後の記録を含めてよい）。 */
  readonly ledger: Pick<SafetyLedger, 'snapshot'>;
  readonly sessionLostPathPrefix: string;
  /** 経路の記録（記録しなかったなら `null`）。 */
  readonly navigation: SessionLossNavigationRecord | null;
  /** factory が残した、その Context の状態の名前（なければ `null`）。 */
  readonly stateNames: AuthenticatedContextStateNames | null;
  /** 許可 Origin（設定の `site.allowedOrigins`）。 */
  readonly allowedOrigins: readonly string[];
  /** 承認したサービスの Origin（監査の段の口がなければ空）。 */
  readonly serviceOrigins: readonly string[];
}

/** Origin の区別の部品（承認したサービスの Origin、許可 Origin、そのほかの順）。 */
interface OriginKindResolver {
  ofUrl(url: URL): SessionLossOriginKind;
  ofCookieDomain(domain: string): SessionLossOriginKind;
}

const originKindResolverOf = (allowedOrigins: readonly string[], serviceOrigins: readonly string[]): OriginKindResolver => {
  // Cookie のドメインと比べる host（`URL.hostname` は小文字の形。Cookie は port と scheme で分かれないので host だけを見る）。
  const hostsOf = (origins: readonly string[]): ReadonlySet<string> => new Set(origins.flatMap((origin) => {
    const parsed = parsedUrlOf(origin);
    return parsed === null ? [] : [parsed.hostname];
  }));
  const serviceHosts = hostsOf(serviceOrigins);
  const allowedHosts = hostsOf(allowedOrigins);
  return {
    ofUrl: (url) => {
      if (isOriginInAllowedOrigins(serviceOrigins, url.origin)) {
        return 'SERVICE';
      }
      return isOriginInAllowedOrigins(allowedOrigins, url.origin) ? 'ALLOWED' : 'OTHER';
    },
    ofCookieDomain: (domain) => {
      const host = (domain.startsWith(COOKIE_DOMAIN_DOT) ? domain.slice(COOKIE_DOMAIN_DOT.length) : domain).toLowerCase();
      if (serviceHosts.has(host)) {
        return 'SERVICE';
      }
      return allowedHosts.has(host) ? 'ALLOWED' : 'OTHER';
    },
  };
};

/** Cookie のドメインの先頭の印（Domain 属性つきの Cookie）。 */
const COOKIE_DOMAIN_DOT = '.';
/** path の表記の query の始まりと、名前の区切り。 */
const PATH_QUERY_START = '?';
const PATH_QUERY_SEPARATOR = '&';

const parsedUrlOf = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** path の表記（path と query の名前だけ。値は持たない）。 */
const pathNotationOf = (url: URL): string => {
  const names = loginObservedQueryOf(url.searchParams)?.names ?? [];
  const notation = names.length === 0
    ? recordedRequestPathOf(url.pathname)
    : `${recordedRequestPathOf(url.pathname)}${PATH_QUERY_START}${names.join(PATH_QUERY_SEPARATOR)}`;
  return notation.slice(0, MAX_SESSION_LOSS_PATH_LENGTH);
};

/** http(s) の URL の path の表記（読めない URL と、http(s) でない URL は `null`）。 */
const httpPathNotationOf = (url: string): string | null => {
  const parsed = parsedUrlOf(url);
  return parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ? null : pathNotationOf(parsed);
};

/** 止めた要求の形の行（上限つき。超えた行の回数は数だけ）。 */
const blockedRequestRowsOf = (
  ledger: Pick<SafetyLedger, 'snapshot'>,
  resolver: OriginKindResolver,
): { readonly rows: readonly SessionLossBlockedRequest[]; readonly unlisted: number } => {
  const snapshot = ledger.snapshot();
  const exclusions = snapshot.blockedAuditExclusions;
  // main frame の移動を止めた記録と監査の段の除外を先に、ページが出した要求を後に並べる（行き着いた先に近い記録を、上限で落とさない）。
  const events: readonly { readonly method: string; readonly url: string; readonly reason: SessionLossBlockedRequestReason }[] = [
    ...snapshot.blockedNavigations,
    ...(exclusions?.events ?? []),
    ...snapshot.blockedRequests,
  ];
  const rows = new Map<string, { -readonly [K in keyof SessionLossBlockedRequest]: SessionLossBlockedRequest[K] }>();
  // 監査の段の除外のうち、Ledger の記録の上限で記録しなかった回数も数える。
  let unlisted = exclusions === undefined ? 0 : Math.max(0, exclusions.count - exclusions.events.length);
  for (const { method, url, reason } of events) {
    const parsed = parsedUrlOf(url);
    if (parsed === null) {
      unlisted = saturatingIncrement(unlisted);
      continue;
    }
    const row = { method, originKind: resolver.ofUrl(parsed), path: recordedRequestPathOf(parsed.pathname), reason };
    const key = JSON.stringify([row.method, row.originKind, row.path, row.reason]);
    const existing = rows.get(key);
    if (existing !== undefined) {
      existing.count = saturatingIncrement(existing.count);
    } else if (rows.size < MAX_SESSION_LOSS_BLOCKED_REQUESTS) {
      rows.set(key, { ...row, count: 1 });
    } else {
      unlisted = saturatingIncrement(unlisted);
    }
  }
  return { rows: Object.freeze([...rows.values()].map((row) => Object.freeze({ ...row }))), unlisted };
};

/** 置き場所と Origin の区別ごとの、名前の集まり（`OTHER` は入れない）。 */
const namesByGroupOf = (names: AuthenticatedStateNames, resolver: OriginKindResolver): ReadonlyMap<string, ReadonlySet<string>> => {
  const groups = new Map<string, Set<string>>();
  const add = (storage: SessionLossStorageKind, originKind: SessionLossOriginKind, name: string): void => {
    if (originKind === 'OTHER') {
      return;
    }
    const key = JSON.stringify([storage, originKind]);
    const group = groups.get(key) ?? new Set<string>();
    group.add(name);
    groups.set(key, group);
  };
  for (const { origin, names: keys } of names.origins) {
    const parsed = parsedUrlOf(origin);
    if (parsed !== null) {
      for (const name of keys) {
        add('LOCAL_STORAGE', resolver.ofUrl(parsed), name);
      }
    }
  }
  for (const { domain, name } of names.cookies) {
    add('COOKIE', resolver.ofCookieDomain(domain), name);
  }
  // DEF-139: IndexedDB のデータベースの名前（Origin ごと）。
  for (const { origin, names: databases } of names.indexedDB) {
    const parsed = parsedUrlOf(origin);
    if (parsed !== null) {
      for (const name of databases) {
        add('INDEXED_DB', resolver.ofUrl(parsed), name);
      }
    }
  }
  return groups;
};

/** `from` にあって `to` にない名前の数と、その接頭辞と接尾辞の案（ログインの段の観察と同じ決まり。上限つき）。 */
const changedNamesOf = (from: ReadonlySet<string>, to: ReadonlySet<string>): { readonly count: number; readonly shapes: readonly SessionLossKeyShape[] } => {
  const count = [...from].filter((name) => !to.has(name)).length;
  const shapes = count === 0 ? [] : newStorageKeyShapesOf([...to], [...from])?.shapes ?? [];
  return { count, shapes: Object.freeze(shapes.slice(0, MAX_SESSION_LOSS_KEY_SHAPES).map(({ prefix, suffix }) => Object.freeze({ prefix, suffix }))) };
};

/** 鍵の名前の違いの行（置き場所・Origin の区別・向きの順。違いのない組は入れない）。 */
const storageKeyChangesOf = (names: AuthenticatedContextStateNames | null, resolver: OriginKindResolver): readonly SessionLossStorageKeyChange[] | null => {
  if (names === null || names.read === null) {
    return null;
  }
  const before = namesByGroupOf(names.given, resolver);
  const after = namesByGroupOf(names.read, resolver);
  const empty: ReadonlySet<string> = new Set<string>();
  const rows: SessionLossStorageKeyChange[] = [];
  for (const storage of SESSION_LOSS_STORAGE_KINDS) {
    for (const originKind of SESSION_LOSS_ORIGIN_KINDS) {
      const key = JSON.stringify([storage, originKind]);
      const given = before.get(key) ?? empty;
      const read = after.get(key) ?? empty;
      for (const change of SESSION_LOSS_KEY_CHANGES) {
        const { count, shapes } = change === 'REMOVED' ? changedNamesOf(given, read) : changedNamesOf(read, given);
        if (count > 0) {
          rows.push(Object.freeze({ storage, originKind, change, count, shapes }));
        }
      }
    }
  }
  return Object.freeze(rows);
};

/**
 * セッションの切れを判定した読み込み 1 回の証拠を組み立てる（DEF-138。設計書 2.1）。値を持たない、凍結した値を返す。投げない（読めない値は `null` か数に
 * する）。行き着いた先は判定（`sessionLostUrlOf`）と同じ順で見つけ、当たらなければ（鍵の消失）main frame の最後の URL にする。
 */
export function sessionLossEvidenceOf(input: SessionLossEvidenceInput): SessionLossEvidence {
  const resolver = originKindResolverOf(input.allowedOrigins, input.serviceOrigins);
  const landing = sessionLostLandingOf(input.page, input.ledger, input.sessionLostPathPrefix)
    ?? { url: input.page.url(), landedBy: 'PAGE_URL' as const };
  // 経路は、page で見た main frame の文書の要求に、Guard が止めた main frame の移動の先（page の事象に出ない。Ledger の記録の順）を続ける（同じ URL は
  // 重ねない）。
  const observed = input.navigation?.urls ?? [];
  const snapshot = input.ledger.snapshot();
  const blockedMainFrame = [
    ...(snapshot.blockedAuditExclusions?.events ?? []).filter(({ mainFrameNavigation }) => mainFrameNavigation).map(({ url }) => url),
    ...snapshot.blockedNavigations.map(({ url }) => url),
  ].filter((url, index, all) => !observed.includes(url) && all.indexOf(url) === index);
  const redirectPaths = [...observed, ...blockedMainFrame].flatMap((url): SessionLossPathRecord[] => {
    const parsed = parsedUrlOf(url);
    return parsed === null ? [] : [Object.freeze({ originKind: resolver.ofUrl(parsed), path: pathNotationOf(parsed) })];
  });
  const blocked = blockedRequestRowsOf(input.ledger, resolver);
  return Object.freeze({
    stage: input.stage,
    requestedPath: httpPathNotationOf(input.requestedUrl),
    landedPath: httpPathNotationOf(landing.url),
    landedBy: landing.landedBy,
    redirectPaths: Object.freeze(redirectPaths.slice(0, MAX_SESSION_LOSS_REDIRECT_PATHS)),
    redirectPathsOmitted: (input.navigation?.omitted ?? 0) + Math.max(0, redirectPaths.length - MAX_SESSION_LOSS_REDIRECT_PATHS),
    blockedRequests: blocked.rows,
    blockedRequestsUnlisted: blocked.unlisted,
    storageKeyChange: storageKeyChangesOf(input.stateNames, resolver),
  });
}
