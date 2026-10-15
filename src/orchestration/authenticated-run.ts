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
//   その理由（`AUTH_SESSION_LOST_SKIP_REASON`、`authSessionLostReason`）。
// - 認証つきの Run の設定の確かめ（`secretAllowedQueryParameters`。T25f round 1）: `crawl.allowedQueryParameters` に、URL の伏せ字の一覧
//   （伏せ字の owner の `isSecretUrlQueryParameterName`）に当たる名前があれば、監査を始めない（`assertRunAuthentication` から呼ぶ）。
// 秘密（Cookie と localStorage の値）は、ここで読まず、誤りの文にも入れない。
import type { Page } from 'playwright';
import type { AuthenticatedContextOptions, AuthenticatedStorageState } from '../browser/context-factory.js';
import { ConfigError } from '../config/config-error.js';
import type { AuditConfig } from '../config/types.js';
import type { IncompleteReason, IncompleteReasonCode } from '../core/contracts.js';
import { BLOCKED_AUDIT_EXCLUSION_REASONS } from '../core/evidence-types.js';
import { isRecord } from '../core/guards.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { isOriginInAllowedOrigins } from '../crawl/normalize-url.js';
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
 * - `filterState`: 状態を絞る関数（認証の設定の owner の `filterAuthenticatedState`。2 つ目の引数に `approvedTestOrigins` を渡す）。
 */
export interface RunAuthentication {
  readonly initialState: AuthenticatedStorageState;
  readonly approvedTestOrigins: readonly string[];
  readonly auditExclusions: AuditExclusionPolicy;
  readonly sessionLostPathPrefix: string;
  readonly filterState: (state: AuthenticatedStorageState, approvedTestOrigins: readonly string[]) => AuthenticatedStorageState;
}

/**
 * 保存に記録する、認証つきの Run の種類の値を作る（T25g-2。独立レビュー T25R の Important I1）。認証の設定のうち、秘密を含まない値（許可
 * Origin、監査の段の除外、セッションの切れの path）を、決まった順の JSON にして SHA-256 にする。状態（Cookie と localStorage）は入れない
 * （ログインのたびに変わる値で、Run の種類ではなく、秘密でもあるため）。配列の順は変えない（順が違う設定は、違う設定として扱う。安全の側）。
 */
export function runCheckpointAuthenticationOf(
  authentication: Pick<RunAuthentication, 'approvedTestOrigins' | 'auditExclusions' | 'sessionLostPathPrefix'>,
): RunCheckpointAuthentication {
  const { approvedTestOrigins, auditExclusions, sessionLostPathPrefix } = authentication;
  const canonical = JSON.stringify([
    [...approvedTestOrigins],
    [...auditExclusions.excludedPathPrefixes],
    [...auditExclusions.auditPathPrefixes],
    [...auditExclusions.dangerousTerms],
    sessionLostPathPrefix,
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
  const secretNames = secretAllowedQueryParameters(config);
  if (secretNames.length > 0) {
    throw new ConfigError(
      'CONFIG_INVALID',
      'an authenticated Run cannot keep secret-like query parameters in crawl.allowedQueryParameters',
      secretNames.map((name) => `crawl.allowedQueryParameters must not contain ${JSON.stringify(name)} in an authenticated Run`),
    );
  }
}

/**
 * factory に渡す認証の指定（T25c）。絞り込みの関数に、許可 Origin を包む。状態と除外は、そのまま渡す（factory が写しを取る）。
 */
export function authenticatedContextOptions(authentication: RunAuthentication): AuthenticatedContextOptions {
  const approvedTestOrigins = Object.freeze([...authentication.approvedTestOrigins]);
  return Object.freeze({
    initialState: authentication.initialState,
    filterState: (state: AuthenticatedStorageState) => authentication.filterState(state, approvedTestOrigins),
    auditExclusions: authentication.auditExclusions,
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
  if (isSessionLostUrl(page.url(), prefix)) {
    return page.url();
  }
  const blocked = (ledger.snapshot().blockedAuditExclusions?.events ?? [])
    .find(({ mainFrameNavigation, url }) => mainFrameNavigation && isSessionLostUrl(url, prefix));
  return blocked === undefined ? null : blocked.url;
}
