import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page, Request, Response } from 'playwright';
import type { AuditConfig, Viewport } from '../config/types.js';
import { awaitBeforeDeadline, wait } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import type { BlockedInteractionRequestEvent } from '../core/evidence-types.js';
import { isPositiveSafeInteger, isRecord } from '../core/guards.js';
import {
  AUTHENTICATED_STATE_SAME_SITE_VALUES,
  type AuthenticatedIndexedDBDatabase,
  type AuthenticatedStorageState,
} from '../core/authenticated-storage-state.js';
import { deepFreeze } from '../core/immutable.js';
import { AUTHENTICATED_STATE_READ_TIMEOUT_MS } from '../core/limits.js';
import { PRODUCTION_OBSERVATION_WINDOWS, observationWindowsOrProduction, type ObservationWindows } from '../core/observation-windows.js';
import type { LoadMeter } from '../crawl/load-meter.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
import type { ServiceRequestBudget } from '../crawl/service-request-budget.js';
import {
  ALLOW_ALL_EGRESS_UPSTREAMS,
  startEgressProxy,
  type EgressProxy,
  type EgressRejection,
  type EgressRequestBudget,
  type EgressRequestPolicy,
  type EgressTunnelAdmission,
  type EgressUpstreamPolicy,
} from '../safety/egress-proxy.js';
import {
  admitFrozenMainFrameDocument,
  announcePageLeave,
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  activateInteractionFreezeBeforeLoad,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  guardWriteStageCopyOf,
  isGuardApiWriteStage,
  isGuardAuditSend,
  isPassiveRequestGuardClosed,
  passiveRequestGuardStageOf,
  AuditStageMonitor,
  LoginStageMonitor,
  type EgressFreezeCause,
  type GuardAuditSend,
  type GuardAuditStage,
  type GuardLoginStage,
  type GuardRequestLayer,
  type GuardResourceDelivery,
  type GuardApiWriteStage,
  type GuardScriptLogin,
  type GuardWriteStage,
  type PassiveRequestGuardOptions,
} from '../safety/passive-request-guard.js';
import { apiWriteCheckPathOf } from '../safety/api-write-payload-policy.js';
import {
  SUBMISSION_POST_METHOD,
  canonicalPassiveAllowedOrigins,
  classifyPassiveRequest,
  hasAllowedOrigin,
  isApiWriteCheckTarget,
  isApiWriteEndpointUrl,
  isFrozenReadAdmissible,
  isFrozenTokenRefreshAdmissible,
  isTokenRefreshRequest,
  refreshQueryValuesOf,
  isReadMethod,
  isWriteEndpointUrl,
  type AuditExclusionPolicy,
  type AuditSendPolicy,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestPolicyOptions,
  type ScriptRequestLoginPolicy,
  type SubmissionEndpoint,
} from '../safety/request-policy.js';
// DEF-193: 自動ログインの段の通し方の印は、監査の段の送信の扱いの口の組み立ての唯一の場所（`auditSendOptionsOf`）で決める。
import { auditSendOptionsOf } from '../orchestration/audit-send-options.js';
import { isLoginCredentialGuard } from '../safety/login-credential-guard.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { SubmissionObservation, observationPressesAfterFreeze, valueCarriesObservedMarker } from '../safety/submission-observation.js';
import { SUCCESS_HTTP_STATUS_RANGE, isHttpStatusInRange } from '../core/http-status.js';
import {
  issuedSessionValuesOf,
  refreshBodyShapeOf,
  sessionKeyValueRebuiltFrom,
  stringLeavesOf,
  topLevelStringsOf,
  type FrozenRefreshReference,
  type IssuedSessionValues,
} from '../core/session-key-values.js';
import { ensureElementPathEngine } from './element-path-engine.js';
import {
  decideResourceDelivery,
  RESOURCE_DELIVERY_ROLES,
  ResourceCache,
  type ResourceCacheResponseFact,
  type ResourceDeliveryRequestFacts,
  type ResourceDeliveryRole,
} from './resource-delivery.js';

export type SafetyLedgerFactory = () => SafetyLedger;

/** `BrowserContextFactory` の省略可能な依存（サイトへの負荷の制御の設計書 4.5、4.6）。 */
export interface BrowserContextFactoryOptions {
  /**
   * 要求の実績を数える部品（Run で1つ。Run Coordinator が作る）。渡すと、factory が作るすべての Context の要求の終わりの事象
   * （`requestfinished` と `requestfailed`）を、要求、URL、失敗の理由とともに渡す。factory は数えない。省略すると、事象を受け取らない。
   * Run 全体のキャッシュ（`resourceCache`）もあれば、キャッシュから返した要求と、送らなかった要求も、ここに記録する（設計書 4.7）。
   */
  readonly loadMeter?: LoadMeter | undefined;
  /**
   * Run 全体のリソースのキャッシュ（Run で1つ。Run Coordinator が作る。設計書 4.6）。渡すと、factory が作るすべての Context
   * （役割によらない）の、要求が成功して終わった（`requestfinished`）応答の事実を、キャッシュに渡す（入れるかどうかは、キャッシュが
   * 決める。失敗した要求の応答は渡さない。設計書 4.10.3）。また、すべての Context の Guard に、その Context の役割の届け方の部品を
   * 渡す（設計書 4.7。`PRIMARY` にも渡すのは DEF-031 から。設計書 4.10.3）。省略すると、応答を受け取らず、届け方も変えない（今のまま）。
   */
  readonly resourceCache?: ResourceCache | undefined;
  /**
   * Guard の Context の出口の中継（`src/safety/egress-proxy.ts`）の上流の方針（DEF-039・DEF-040 の設計書 2.1.1、2.1.2）。
   * 省略すると production の方針（`ALLOW_ALL_EGRESS_UPSTREAMS`。すべての host を許す）。テストは、127.0.0.1 だけを許す方針を注入する
   * （実在の外部のサイトにアクセスしない決まり）。DEF-085 から、Interaction の Context だけでなく、Passive とログインの段の Context の中継にも
   * 同じ方針を渡す。
   */
  readonly egressUpstreamPolicy?: EgressUpstreamPolicy | undefined;
  /**
   * 認証つきの Run の指定（Task 25 の設計書 4.3、4.7。T25c）。省略すると、今と完全に同じ（公開監査。状態を持たず、Guard にも除外を渡さない）。
   * 渡すと、factory が作るすべての Context（Passive の役割によらない。Interaction の Context も）に、認証済みの状態を `newContext` の
   * `storageState` で渡し（ファイルに書かない）、Guard に監査の段の除外（`auditExclusions`）を渡す（ログインの段の指定は渡さない）。
   * 状態の受け継ぎ（`#inheritedAuthenticatedState`、`#captureAuthenticatedState`）。SFIX-1104（SREV-1104 の I-1）: 次へ渡すのは、サイトの応答（許可 Origin と
   * 承認したサービスの Origin から）を最後に受けた Context の状態（同じなら最後に閉じた方。DEF-191 の「最後に閉じた Context」を、重なる Context に広げた）。
   * Page Auditor は D を閉じてから幅の走査（DEF-191）。
   */
  readonly authentication?: AuthenticatedContextOptions | undefined;
  /**
   * テストだけ（DEF-099 fix）: 書き込みの送信の送り手が、TLS の確かめで信頼する証明書を足す（PEM。自前の証明書の https の fixture のため）。
   * 確かめは切らない（OS の証明書の置き場所と Node の同梱の証明書に足すだけ）。production は渡さない。
   */
  readonly writeSubmissionCertificates?: readonly string[] | undefined;
  /**
   * 読み込みの間隔を守る部品（Run で1つ。Run Coordinator と、発見・READ の確かめ・書き込みの流れが作る。DEF-100 fix）。渡すと、factory が作る
   * すべての Context の Guard に、main frame の文書の要求を送った時刻の記録の口（`PassiveRequestGuardOptions.onMainFrameDocumentSent`）として、
   * この部品の `recordDocumentRequestSent` を渡す（次の読み込みを、送った時刻からも間隔以上空ける）。省略すると、記録しない（今と同じ。間隔は
   * 読み込みの開始だけで数える）。`recordDocumentRequestSent` の関数を持たなければ `TypeError`。
   */
  readonly navigationPacer?: Pick<NavigationPacer, 'recordDocumentRequestSent'> | undefined;
  /**
   * DEF-245: L0 の見張りの反応なしの長さ（ms。正の安全な整数。Run Coordinator の `progressWatchQuietLimitMs` と同じ値）。渡すと、factory が作るすべての Context の
   * Guard の、閉じるときの作業の待ち（`PassiveRequestGuardOptions.drainQuietLimitMs`）に渡す。省略すると本番の `PROGRESS_WATCH_QUIET_LIMIT_MS`。
   */
  readonly progressWatchQuietLimitMs?: number | undefined;
  /**
   * RB-2（SLIM-2 の閉じる前の待ちを寄せた）: 観察の窓の一式（テストだけの口。Run Coordinator の `observationWindows` と同じもの）。factory は `beforeClose`
   * （ページの監査の読み込みの Context を持ち主が閉じる前に待つ時間）を読む。省略すると本番の値。ページを離れる手順と Guard の判定は変えない。
   */
  readonly observationWindows?: ObservationWindows | undefined;
  /**
   * T35b（Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限の部品（実行で 1 つ。`src/crawl/service-request-budget.ts`。作って渡すのは
   * T35c）。認証の指定の監査の段の口（`authentication.auditStage`）があるときだけ使い、T35R-fix（T35R の C-1）からは、どの役割の Context の Guard にも
   * 渡す（幅の走査と Interaction の `REVISIT` はサービスの Origin へ送らないが、数える側にも置いて守りを重ねる）。`tryConsume` の関数を持たなければ
   * `TypeError`。
   */
  readonly serviceRequestBudget?: Pick<ServiceRequestBudget, 'tryConsume'> | undefined;
  /**
   * T35b: スクリプトで送るログインの監査の段の記録（Run で 1 つ。`AuditStageMonitor`）。監査の段の口があるときだけ、すべての Context の Guard に渡す。
   */
  readonly auditStageMonitor?: AuditStageMonitor | undefined;
  /**
   * T35c（Task 35 の設計書 3.5）: 承認したサービスの Origin からの 401 の応答を受けた（監査の段の口があるときだけ。`requestfinished` の観察）。値・URL を
   * 渡さない。記録だけで、それだけでセッションが切れたとはみなさない。
   */
  readonly onServiceUnauthorizedResponse?: (() => void) | undefined;
  /** T35c: Context の状態を読み直したときに、ログインの状態の鍵がなくなっていた（`AuthenticatedContextOptions.sessionKeyPresent` が偽）。 */
  readonly onSessionKeyLost?: (() => void) | undefined;
  /**
   * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の指定（`GuardAuditSend`。設定から作って渡すのは
   * AS-b）。渡すと、Passive の Context（`createPassiveContext`。役割によらない）の Guard と中継の要求の方針に渡す（今の `auditStage` などと同じ道）。ログインの段・
   * 書き込みの段の Context と、Isolated Interaction Context（`createInteractionSession`）には渡さない（今のまま読み取りだけ）。形が違えば `TypeError`。
   * 省略すると、今と同じ（読み取りだけ。`READ_ONLY`）。
   */
  readonly auditSend?: GuardAuditSend | undefined;
  /**
   * OP-N（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）と OP-REV3（C-1。設計者の判断の案 a）: 書き込みの段の Context（`createWriteStageContext`）
   * だけに渡す、監査の段の送信の扱いの指定（形は `auditSend` と同じ）。送る前の確かめなどの Passive の Context には渡さない（`auditSend` は書き込みのジョブでは
   * 渡さない）。Guard は、値を入れる前の読み取りでない要求にだけ、書き込みの段の決まりを加えて当てる。形が違えば `TypeError`。省略は読み取りだけ。
   */
  readonly writeStageAuditSend?: GuardAuditSend | undefined;
  /**
   * OP-Q（設計書 4.1.8 の Q1）: 書き込みのジョブの Passive の Context（`createPassiveContext`。送る前の確かめと照合の READ）に渡す、監査の段の送信の扱いの指定（形は
   * `auditSend` と同じで、書き込みの作業の印 `writeJobEndpoint` を必ず持つ）。Guard と中継の判定は、書き込みの段の値を入れる前と同じ決まりを加える（承認した送信先と
   * その下の path、許可 Origin と承認したサービスの Origin のほか、WebSocket は通さない）。書き込みの段・ログインの段の Context と Isolated Interaction Context には
   * 渡さない。印がない、形が違う、`auditSend` と一緒、は `TypeError`。省略は読み取りだけ。
   */
  readonly writeJobPassiveAuditSend?: GuardAuditSend | undefined;
  /**
   * LU-SFIX5（LU-SREV4 の Important-1。設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.5 の「書き込みのジョブの間の状態の受け継ぎ」）: 書き込みのジョブ
   * （登録・更新）の factory の印（書き込みのジョブの流れ `write-create-run.ts` だけが渡す）。渡すと、書き込みの段の Context だけでなく、この factory のどの
   * Context の後でも、次の Context へ渡す状態を `writeStageCarriedStateOf` で決める（ページのスクリプトが書ける localStorage・sessionStorage・IndexedDB と、
   * HttpOnly でなくサーバの `Set-Cookie` で来たのでもない cookie は、その Context に渡した値のまま。各 Context は前の Context の渡した値を受けるので、ジョブの
   * 始まりの世代に固定される）。HttpOnly の cookie とサーバの `Set-Cookie` で来た cookie は、今のとおり後の値を受け継ぐ。省略は今のまま（監査・操作さがし）。
   */
  readonly writeJob?: true | undefined;
  /**
   * RB-4 fix（REV-RB4 の C-1）: 監査の Run（Run Coordinator）の factory の印。監査の PRIMARY は凍結しないので、渡すと PRIMARY の Passive の Context に送らずに
   * 観察する probe の口を付けない（凍結しうる発見の PRIMARY だけが口を持ち、Worker の中の WebSocket を止める。監査のページのリアルタイムの通信は止めない）。
   * 省略は今のまま（発見・点検・書き込みのジョブの PRIMARY は口を持つ）。
   */
  readonly pageAuditRun?: true | undefined;
  /**
   * DEF-276: 操作さがしの Run（`discovery-run.ts`）の factory の印。凍結の後に押すのは操作さがしだけなので、渡すと PRIMARY の観察の口が押す口になり、Guard が
   * Worker の中の WebSocket を止める。省略すると、観察の口は凍結の後に押さない口（`freezeOnlyForReading`）になり（READ の確かめ・入口の確かめ・書き込みのジョブ。
   * 凍結の前のリアルタイムの通信を止めない）、押す観察（`begin`）と最初から凍結の口（`openFrozenObservationContext`・`loadFrozenDocument`）が投げる。
   * `pageAuditRun` と一緒には受けない（`TypeError`）。
   */
  readonly submissionProbeRun?: true | undefined;
}

/**
 * 認証済みの状態（Playwright の `storageState` と同じ形。Cookie と、Origin ごとの localStorage と、DEF-139 からは IndexedDB）。秘密を含むので、値をログ、
 * 誤りの文、成果物、Evidence、保存に入れない（Task 25 の設計書 4.6）。形の定義は core の 1 か所（`src/core/authenticated-storage-state.ts`。CC-060 の B）で、
 * ここは同じ名前で公開し直す（呼ぶ側の import を変えない）。
 */
export type { AuthenticatedStorageState } from '../core/authenticated-storage-state.js';

/**
 * DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.2）: Context の状態を、IndexedDB を含めて読む唯一の口（ログインの段の終わり、
 * T25c の Context を閉じるときと受け継ぐとき、probe の前の読み出しが、どれもこれを使う）。値はメモリの中だけに置く（ファイルに書かない）。Playwright の
 * 型は IndexedDB の項目を持たないので、同じ形の型にして返す。
 */
export const readContextStorageState = async (context: BrowserContext): Promise<AuthenticatedStorageState> =>
  await context.storageState({ indexedDB: true }) as AuthenticatedStorageState;

/**
 * 認証済みの状態の、名前だけの写し（DEF-138。セッションの切れの証拠の鍵の名前の違いに使う）。Cookie はドメインと名前、localStorage は Origin と鍵の
 * 名前、DEF-139 からは IndexedDB の Origin とデータベースの名前だけを持ち、値と中身は持たない。
 */
export interface AuthenticatedStateNames {
  readonly cookies: readonly { readonly domain: string; readonly name: string }[];
  readonly origins: readonly { readonly origin: string; readonly names: readonly string[] }[];
  /** DEF-139: IndexedDB のデータベースの名前（Origin ごと。データベースのない Origin は持たない）。 */
  readonly indexedDB: readonly { readonly origin: string; readonly names: readonly string[] }[];
}

/**
 * Context の状態の名前（DEF-138）。`given` は Context を作るときに渡した状態、`read` はその Context の状態を最後に読んだとき（閉じるとき・受け継ぐとき・
 * probe の前。絞り込みの前の状態）の名前。読めなかったか、まだ読んでいなければ `null`。
 */
export interface AuthenticatedContextStateNames {
  readonly given: AuthenticatedStateNames;
  readonly read: AuthenticatedStateNames | null;
}

/** 状態から、名前だけの写しを作る（値は写さない。凍結する）。 */
const authenticatedStateNamesOf = (state: Pick<AuthenticatedStorageState, 'cookies' | 'origins'>): AuthenticatedStateNames => Object.freeze({
  cookies: Object.freeze(state.cookies.map(({ domain, name }) => Object.freeze({ domain, name }))),
  origins: Object.freeze(state.origins.map(({ origin, localStorage }) =>
    Object.freeze({ origin, names: Object.freeze(localStorage.map(({ name }) => name)) }))),
  indexedDB: Object.freeze(state.origins.flatMap(({ origin, indexedDB }) => (indexedDB === undefined || indexedDB.length === 0
    ? []
    : [Object.freeze({ origin, names: Object.freeze(indexedDB.map(({ name }) => name)) })]))),
});

/**
 * factory の認証の指定（T25c）。平らなデータと関数だけで、`src/control/` を読まない（Task 22 の Gate）。
 * - `initialState`: ログインの段で取り出した状態。factory は、作るときに `filterState` で絞ってから持つ。
 * - `filterState`: 状態を絞る関数（呼び出し側が、認証の設定の owner の絞り込み `filterAuthenticatedState` を、許可 Origin とともに包んで渡す）。
 *   最初の状態と、Context から取り出した状態のすべてを、持つ前にこれで絞る。投げたら、その状態は使わない（取り出しの失敗と同じ扱い）。
 * - `auditExclusions`: 監査の段の除外（Guard の `PassiveRequestGuardOptions.auditExclusions` に渡す）。
 */
export interface AuthenticatedContextOptions {
  readonly initialState: AuthenticatedStorageState;
  readonly filterState: (state: AuthenticatedStorageState) => AuthenticatedStorageState;
  readonly auditExclusions: AuditExclusionPolicy;
  /**
   * T35a（Task 35 の設計書 3.2）: スクリプトで送るログインの監査の段の口（`AuditStageServiceRequests`）。スクリプトで送るログインの Run だけが持つ。
   * T35a では型と受け渡しだけで、Guard への取り付けは T35b。
   */
  readonly auditStage?: AuditStageServiceRequests | undefined;
  /**
   * T35c（Task 35 の設計書 3.5）: ログインの状態の鍵があるかの判定（スクリプトで送るログインの Run だけ。ワーカーが、認証の設定の成功の鍵の形と
   * `hasSuccessStorageKey` で作る。factory は control を読まないので関数で受ける）。factory は、Context の状態を読み直したときに（`storageState`。
   * 絞り込みの後）、偽なら `BrowserContextFactoryOptions.onSessionKeyLost` を呼ぶ。値は読まない（判定の関数も鍵の名前だけを見る）。
   */
  readonly sessionKeyPresent?: ((state: AuthenticatedStorageState) => boolean) | undefined;
  /**
   * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.2）: ローカル ストレージの鍵（Origin と名前）が、ログインの成功の鍵の形に当たるか
   * （ワーカーが、認証の設定の成功の鍵の形と `isSuccessStorageKeyName` で作る。値は読まない）。factory は、probe を行った Context の次の画面へ渡す状態の、
   * この鍵の値だけを、凍結の段に通した最後の更新の応答の値で作り直す（`withSessionKeyValuesOf`。DEF-251）。省略すると作り直さない（今のまま）。
   */
  readonly sessionKeyName?: ((origin: string, name: string) => boolean) | undefined;
  /**
   * DEF-220（設計書 `2026-11-08-beaksight-same-origin-api-and-spa-routes-design.md` 3.1 の 2）: 承認したテストの Origin（認証つきの Run の指定の
   * `approvedTestOrigins`。ログインのある形とない形の両方）。factory は、送らずに観察する probe の口に、テスト用のサイト自身の API の区分（`APPROVED_TEST`）に
   * 当てる Origin として渡すだけ（許可 Origin の全体は渡さない）。省けば空（その区分を作らない）。
   */
  readonly approvedTestOrigins?: readonly string[] | undefined;
}

/**
 * スクリプトで送るログインの監査の段の口（T35a。Task 35 の設計書 3.2、3.4。平らなデータ。`src/control/` を読まない）。値は、ワーカーが認証の設定 v3 と
 * プロファイルから作る（`src/worker/audit-stage-requests.ts`）。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（数える区分。上限の対象）。
 * - `auditReadRequests`: 監査の段で通す、読み取りのための手続きの呼び出し（`POST`。1 回の読み込みあたりの回数の上限つき。既定は空）。
 * - `scriptLogin`: token の送信先（更新などの token の送信を見分けて止める）。
 * LZ-3c: 承認したサービスの Origin への要求の上限（前は `serviceRequestLimits`。L11 で使わなくなった）は持たない。
 */
export interface AuditStageServiceRequests {
  readonly approvedServiceOrigins: readonly string[];
  readonly auditReadRequests: readonly {
    readonly origin: string;
    readonly path: string;
    readonly method: string;
    readonly maxPerPageLoad: number;
  }[];
  readonly scriptLogin: {
    readonly origin: string;
    readonly path: string;
    readonly requiredQuery: readonly { readonly name: string; readonly value: string }[];
  };
}

/**
 * 受け継ぐ状態と、その状態を取り出した Context の世代（最初の状態は 0）。SFIX-1104 の I-1: `responseSequence` は、取り出したときの、その Context がサイトの応答を
 * 最後に受けた順番（`#lastSiteResponses`。最初の状態は 0）。
 */
interface GenerationalAuthenticatedState {
  readonly state: AuthenticatedStorageState;
  readonly generation: number;
  readonly responseSequence: number;
}

/** SFIX-1104 の I-1: サイトの応答を受けていない Context（と最初の状態）の順番。 */
const NO_SITE_RESPONSE_SEQUENCE = 0;

/** 最初の状態の世代（どの Context の世代よりも古い）。 */
const INITIAL_AUTHENTICATED_STATE_GENERATION = 0;

/**
 * Context ごとの、出口の中継を凍結した理由の記録（DEF-085 fix round 3）。`frozenByInteraction` は、中継を最初に凍結したのが、Guard の凍結の段
 * （`INTERACTION_FREEZE`。Interaction の Context の凍結と、Passive の Context の発見の凍結）か。偽のまま凍結したなら、Guard が Context を閉じる
 * 直前の凍結（`CONTEXT_CLOSE`）である。
 */
interface EgressFreezeRecord {
  frozenByInteraction: boolean;
}

/**
 * 出口の中継が拒んだ要求を、Safety Ledger の `blockedInteractionRequests` に写すときの理由（DEF-039・DEF-040 の設計書 2.1.3、DEF-085）。
 * `null` は記録しない。Passive、ログインの段、Interaction のどの Context も同じに扱う。
 * - `OPEN`（上流の方針の拒否）: `EGRESS_UPSTREAM_DENIED`。
 * - `REQUEST_POLICY`（Guard が許さない method と URL。Passive とログインの段の中継だけ）: Guard を通らずに出ようとした要求の証拠
 *   （`GUARD_BYPASS_EGRESS`）。
 * - `FROZEN`: Guard の凍結の段で凍結した後なら、Guard を通らずに出た要求の証拠（`INTERACTION_FROZEN_EGRESS`）。Guard が Context を閉じる直前に
 *   凍結した後なら、記録しない（fix round 3 の C1。閉じる途中の要求は、Guard が許した普通の要求か、横取りを外れた要求かを中継から区別できない。
 *   記録すると、Guard が何も止めていない公開監査の `blockedActions.requests` を増やす。DEF-085 の場面の証拠は、Guard の違反と遮断したポップアップの
 *   記録で残る）。
 */
function egressRejectionReason(
  phase: EgressRejection['phase'],
  freeze: EgressFreezeRecord,
): BlockedInteractionRequestEvent['reason'] | null {
  switch (phase) {
    case 'OPEN':
      return 'EGRESS_UPSTREAM_DENIED';
    case 'REQUEST_POLICY':
      return 'GUARD_BYPASS_EGRESS';
    // DEF-099 fix: 書き込みの段の、承認の送信先への 2 回目の POST（Guard は 1 回だけ送り手に送らせるので、Guard を迂回した要求）。
    case 'REQUEST_BUDGET':
      return 'GUARD_BYPASS_EGRESS';
    // DEF-125: Guard が通していない宛先への CONNECT（Guard を通らずに出ようとした接続。記録は CONNECT と `host:port` だけで、値は残らない）。
    case 'TUNNEL_NOT_ADMITTED':
      return 'GUARD_BYPASS_EGRESS';
    case 'FROZEN':
      return freeze.frozenByInteraction ? 'INTERACTION_FROZEN_EGRESS' : null;
  }
}

/**
 * 出口の中継の拒否を、Safety Ledger の `blockedInteractionRequests` の記録にする（理由は `egressRejectionReason`。`null` は記録しない）。どの Context の中継も、
 * ここを通して写す。DEF-215: CONNECT の受け入れで拒んだもの（`TUNNEL_NOT_ADMITTED`。Guard が通した要求がまだない宛先への、要求の前の接続）には、印
 * `preRequestConnection` を付ける（読み取り以外の送信の遮断と分けるため。拒否の動きと理由は変えない）。
 */
function egressRejectionEvent(
  { method, url, phase }: EgressRejection,
  freeze: EgressFreezeRecord,
): BlockedInteractionRequestEvent | null {
  const reason = egressRejectionReason(phase, freeze);
  if (reason === null) {
    return null;
  }
  // RB-4b（設計書 3.2 の X13）: 凍結の後に拒んだ CONNECT も、トンネルには何も流れていない（要求の前の接続）。ブラウザ自身の外への接続を、止めた送信の指摘に
  // 数えないよう、同じ印を付ける。
  return phase === 'TUNNEL_NOT_ADMITTED' || method === 'CONNECT' ? { method, url, reason, preRequestConnection: true } : { method, url, reason };
}

/**
 * DEF-125: 中継の CONNECT の受け入れ（`tunnelAdmission`）の、知らせのない CONNECT が知らせを待つ時間（ms）。
 * 値の根拠（DEF-125-fix の実験。Chromium 151、Playwright 1.62.1）: CLI の `channel: 'chromium'` の `chrome.exe` は、ナビゲーションの宛先への CONNECT を、
 * Guard がその文書の要求を判定して進める約 2〜5 ms 前に始める（テストの既定の headless shell は、判定の後に始める）。待たずに拒むと（0 ms）、読み込みは
 * 新しい CONNECT で成功したが、拒んだ CONNECT が記録に残った（6 場面の 6 回）。1 秒待つと、記録は残らなかった。Guard が判定しないナビゲーション
 * （Guard が止めた、許可 Origin の外への main frame の移動）の先への CONNECT は、待った後に拒んで記録する。
 */
export const EGRESS_TUNNEL_ADMISSION_WAIT_MS = 1_000;

/**
 * L10 の後の安全の側の設計の変更（設計者の判断）: Guard に渡す、凍結の段の読み取りを通す印（唯一の決め所）。Isolated Interaction Context（`INTERACTION`）だけ
 * `admitFrozenReads` を渡す（押した後に fetch でデータが届いて開く部品を確かめるため）。Passive の Context は渡さない（PRIMARY は観察の口で通す。DEF-208-1）。
 */
export function guardFrozenReadOptionOf(contextKind: 'PASSIVE' | 'INTERACTION'): Pick<PassiveRequestGuardOptions, 'admitFrozenReads'> {
  return contextKind === 'INTERACTION' ? { admitFrozenReads: true } : {};
}
/**
 * DEF-125: factory が作るすべての中継（Passive・ログインの段・書き込みの段・Interaction）に渡す CONNECT の受け入れ。RB-4b: 監査するサイトの Origin（許可 Origin と
 * 承認したサービスの Origin、承認したテストの Origin）を渡し、サイトの外の宛先（ブラウザ自身の Google などへの接続を含む）は待たずに通す。
 */
const egressTunnelAdmissionOf = (siteOrigins: readonly string[]): EgressTunnelAdmission =>
  Object.freeze({ waitMs: EGRESS_TUNNEL_ADMISSION_WAIT_MS, siteOrigins: Object.freeze([...siteOrigins]) });

/**
 * T44b（Task 44 の設計書 3.1 の P1-2 と、設計の変更の履歴の「T44b の報告」の行）・SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md`
 * 2.4）: ページの読み取りでない送信を通す Context（監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口のある Context と、手動のログインの段・自動ログインの段の印の
 * ある Context。役割・種類によらない）を、持ち主が閉じる（`closePassiveContext`）ときの手順の、ページを離れた後に待つ時間（ms。1 回の閉じ方あたりの上限）。
 * 手順: 認証の状態を読む → ページを離れる（`AUDIT_SEND_PAGE_LEAVE_URL` へ移る。人がページを閉じるのと同じ自然な動き）→ この時間だけ待つ → 閉じる。
 * ページを離れるときに出る送信（`pagehide`・`visibilitychange`・`unload` の beacon、keepalive の fetch など。削除を含む）を、Guard の今の判定で通して自然に
 * 終えさせる。その間も Guard の段階は `PASSIVE_ACTIVE` のまま（閉じ方の段の順は変えない）。閉じ始めた後の送信は、今どおり止める。
 * 待たず、ページも離れないもの: `READ_ONLY`（口のない Context）、凍結の段の Context（守り 2）、factory が自分で閉じる（違反などの）Context。
 * ページを離れた後の要求は、そのページの読み取りの判定の数（DEF-130 の文書でない要求の数と上限）に入れない（Guard の `announcePageLeave`）。
 * RB-2: 値は観察の窓の一式の `beforeClose.auditSendCloseSettleMs`（factory は、差し込まれた一式 `BrowserContextFactoryOptions.observationWindows` を読む）。
 */
export const AUDIT_SEND_CLOSE_SETTLE_MS = PRODUCTION_OBSERVATION_WINDOWS.beforeClose.auditSendCloseSettleMs;

/**
 * T44b（設計者の判断の (1)）: `createPassiveContext` の省略できる指定。
 * - `pageAuditLoad`: ページの監査の読み込み（Desktop と Mobile）の印。付けるのは、ページの監査の読み込みの作り手（`page-auditor.ts`）だけ。SD-2: 閉じるときに
 *   ページを離れて待つかは、この印によらず Context の口で決める（`AUDIT_SEND_CLOSE_SETTLE_MS`）ので、閉じ方には効かない（ページの監査の読み込みの
 *   印として、呼ぶ側の受け渡しに残す）。
 */
export interface PassiveContextOptions {
  readonly pageAuditLoad?: true | undefined;
}

/** T44b: 閉じる前にページを離れる先（サイトへの要求ではない。読み込みの間隔とページの移動の上限（DEF-129）には数えない）。 */
export const AUDIT_SEND_PAGE_LEAVE_URL = 'about:blank';

/**
 * T44b: ページを離れる移動を待つ上限（ms）。過ぎたら離れずに進む（待ちと閉じる処理は続ける）。値の根拠: 閉じる処理を待つ上限
 * （`CONTEXT_CLOSE_TIMEOUT_MS` = 5 秒）の中に、認証の状態の読み出しの上限（2 秒）、この上限、待つ時間（1 秒）、閉じる処理（ふだん 1 秒程度）が収まる値。
 * 移動はふだん数十 ms で終わる。
 */
export const AUDIT_SEND_PAGE_LEAVE_TIMEOUT_MS = 500;

/** T44b: Context の Guard が、閉じる途中でも無効化の途中でもないか（投げない。確かめは Guard の `assertPassiveRequestGuardActive`）。 */
const isGuardActive = (context: BrowserContext): boolean => {
  try {
    assertPassiveRequestGuardActive(context);
    return true;
  } catch {
    return false;
  }
};

/** 中継を、凍結の理由を記録してから凍結する（DEF-085 fix round 3）。最初の凍結の理由だけを残す（凍結は一方向）。 */
function freezeEgressFor(egress: EgressProxy, freeze: EgressFreezeRecord, cause: EgressFreezeCause): void {
  if (egress.state === 'OPEN' && cause === 'INTERACTION_FREEZE') {
    freeze.frozenByInteraction = true;
  }
  egress.freeze();
}

/**
 * 中継から見た要求の形（DEF-085）。中継は、main frame のナビゲーションかどうかを区別できないので、Guard の判定（`classifyPassiveRequest`）を
 * main frame のナビゲーションの形と、それ以外の形の両方で行い、どちらかで許すなら通す（Guard が許すものを中継が拒まない。Guard より広くは
 * 通さない）。T34b: 中継は要求の種類も区別できないので、ナビゲーションの形は `document`、それ以外の形はスクリプトの送信の種類（`fetch`）とする
 * （Guard が許すスクリプトの送信を拒まない。種類で止める beacon などは、Guard が止める）。
 */
const EGRESS_REQUEST_SHAPES = Object.freeze([
  Object.freeze({ isNavigationRequest: true, isMainFrame: true, resourceType: 'document' }),
  Object.freeze({ isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch' }),
  // T35b（Task 35 の設計書 3.3）: 静的な資源の形。スクリプトで送るログインの監査の段では、読む範囲を「ナビゲーションの形」だけに当てる（範囲の確かめは
  // Guard が先に行う。読まないパスと危険な語は、この形でも当たる）。ほかの段では、fetch の形と同じ判定になる。
  Object.freeze({ isNavigationRequest: false, isMainFrame: false, resourceType: 'script' }),
] as const satisfies readonly Pick<HttpRequestFacts, 'isNavigationRequest' | 'isMainFrame' | 'resourceType'>[]);

/**
 * 中継の要求の方針の、送信の段（ログインの段と書き込みの段）の残りの回数（DEF-085。T30b で書き込みの段にも使う）。回数の上限は Guard が数える
 * （中継は数えない）ので、中継は、送信先への POST を Guard が許しうるものとして通す。
 */
const EGRESS_LOGIN_POST_REMAINING = 1;

/** Context の送信の段の指定（ログインの段か書き込みの段。どちらもなければ Passive の Context。T30b）。 */
type SubmissionStageOptions = Pick<PassiveRequestGuardOptions, 'loginStage' | 'writeStage'>;

/**
 * 中継から見た、その Context の Guard の許可の指定（`passiveEgressRequestPolicy` の基の方針）。DEF-233: 凍結の後の token の更新の受け入れ
 * （`frozenTokenRefreshAdmissionOf`）も、同じ方針で判定する（別の写しを作らない）。指定は作る時点の写し。
 */
function egressPolicyOptionsOf(
  stage: SubmissionStageOptions,
  auditExclusions: AuditExclusionPolicy | undefined,
  auditStage: AuditStageServiceRequests | undefined,
  role: ResourceDeliveryRole,
  auditSend: GuardAuditSend | undefined,
): PassiveRequestPolicyOptions {
  const copy = (values: readonly string[]): readonly string[] => Object.freeze(values.map((value) => String(value)));
  const { loginStage, writeStage } = stage;
  const options = {
    ...(loginStage === undefined
      ? {}
      : {
        authSetup: Object.freeze({
          loginPostEndpoints: Object.freeze(loginStage.loginPostEndpoints.map(({ origin, path }) => Object.freeze({ origin, path }))),
          remainingPosts: EGRESS_LOGIN_POST_REMAINING,
          // T34b: スクリプトで送るログインの口（token の送信先、ログインに伴う送信、承認したサービスの Origin）。回数は Guard が数える。
          ...(loginStage.scriptRequest === undefined ? {} : { scriptRequest: egressScriptRequestPolicy(loginStage.scriptRequest) }),
          // ML-a: 手動のログインの段は、中継も Guard と同じく、ページの送信を止めずに通す（Guard より広くは通さない）。
          ...(loginStage.manualPassThrough === true && loginStage.credentialGuard === undefined ? { manualPassThrough: true as const } : {}),
          // T44R の M-1: 手動のログインの段の、token の送信先がまだない設定の承認したサービスの Origin への読み取り（Guard と同じ口。スクリプトの口があれば使わない）。
          ...(loginStage.manualPassThrough === true && loginStage.credentialGuard === undefined
            && loginStage.scriptRequest === undefined && loginStage.manualServiceReadOrigins !== undefined
            ? { manualServiceReadOrigins: copy(loginStage.manualServiceReadOrigins) }
            : {}),
        }),
      }),
    ...(writeStage === undefined
      ? {}
      : {
        writeStage: isGuardApiWriteStage(writeStage)
          // T39b: API の書き込みの段。中継は、ページのスクリプトの要求かを知らないので、判定の API の分岐は通らない（送り手の 1 回は、下の T39c の口で通す）。
          ? Object.freeze({
            writeEndpoint: Object.freeze({ origin: writeStage.expectation.spec.request.origin, path: writeStage.expectation.spec.request.pathShape }),
            remainingPosts: EGRESS_LOGIN_POST_REMAINING,
            apiOrigin: writeStage.expectation.spec.request.origin,
            // LU-5（fix round 1 の案 A）: Guard と同じ、照合へ回す要求の path（窓の前の守りは、上の path の型のまま）。
            apiWritePath: apiWriteEndpointOf(writeStage).path,
          })
          : Object.freeze({
            writeEndpoint: Object.freeze({ origin: writeStage.expectation.request.origin, path: writeStage.expectation.request.path }),
            remainingPosts: EGRESS_LOGIN_POST_REMAINING,
            // LU-SFIX3-B: Guard と同じ、窓の前（N2）に守る送信先の path の型（中継の `writeStageSendPolicy` も同じ型で守る）。
            ...(writeStage.guardedPathShape === undefined ? {} : { guardedPathShape: writeStage.guardedPathShape }),
          }),
      }),
    ...(auditExclusions === undefined
      ? {}
      : {
        auditExclusions: Object.freeze({
          excludedPathPrefixes: copy(auditExclusions.excludedPathPrefixes),
          auditPathPrefixes: copy(auditExclusions.auditPathPrefixes),
          dangerousTerms: copy(auditExclusions.dangerousTerms),
        }),
      }),
    // T35b: スクリプトで送るログインの監査の段の口（登録した読み取りの手続きの呼び出しの回数は Guard が数える。中継はどの項目も残り 1 とする）。
    // T35R2-fix（T35R2 の M-3）: 最初の読み込みでない Context（幅の走査の `REVISIT`）では、中継でも承認したサービスの Origin へ送らない。
    // T44b（P1-1）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の Context は、役割によらず送る（Guard と同じ。`servesServiceOrigin`）。
    ...(auditStage === undefined ? {} : { auditStage: egressAuditStagePolicy(auditStage, servesServiceOrigin(role, auditSend)) }),
    // AS-a: 監査の段の送信の扱いの口（通す数は Guard が数える。中継は残り 1 とする。Guard より広くは通さない）。OP-N（N2）: 書き込みの段では、ここに入れない
    // （中継は送信の窓と目印を知らないので、Guard が通した要求の写し `sendAdmissions` に当たる要求だけを、下の口で通す）。
    ...(auditSend === undefined || writeStage !== undefined ? {} : { auditSend: egressAuditSendPolicy(auditSend) }),
  };
  // RB-14b（X1）: ログインの段の口は、書き込みの段・監査の段・送信の扱いの口と一緒に作らない（Guard の取り付けが拒む組み合わせ）。
  const { authSetup, ...others } = options;
  return Object.freeze(authSetup === undefined
    ? others
    : { authSetup, ...(options.auditExclusions === undefined ? {} : { auditExclusions: options.auditExclusions }) });
}

/**
 * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.1 の 2）: 中継の凍結の後の token の更新の受け入れ。Guard が凍結の段で通した
 * 更新の写し（`admissions`。1 回ずつ使う）に当たり、中継から見た方針で凍結の段の token の更新の判定（`isFrozenTokenRefreshAdmissible`。Guard と同じ部品）を
 * 満たす `POST` だけを通す（目印は Guard が本文で照らした。中継は本文を見ない）。
 */
function frozenTokenRefreshAdmissionOf(
  policy: PassiveRequestPolicyOptions,
  admissions: Pick<EgressFrozenSendAdmissions, 'take'>,
  learnedQueryValues: () => ReadonlyMap<string, ReadonlySet<string>>,
  allowedOrigins: ReadonlySet<string> = new Set(),
): EgressRequestPolicy {
  return (method: string, url: string): boolean => {
    const facts = { kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch' } as const;
    return (
      isFrozenTokenRefreshAdmissible(
        facts,
        policy,
        // 中継は本文と header を見ない（中身は Guard が照らした。写しに当たる要求だけを通す）。
        null,
        // fix round 2・3: 必須の query の値は、Guard と同じく、OAuth の標準の更新の値か、Run の中で凍結の前に通して確かめた更新の値だけ。
        learnedQueryValues(),
      )
      // SAFE-2 の 3: 凍結の段で Guard が通した、登録した読み取りの手続きの呼び出し（判定は Guard と同じ部品。目印の確かめは Guard が本文で行った）。
      || (!isReadMethod(method) && isFrozenReadAdmissible(facts, allowedOrigins, policy))
    ) && admissions.take(method, url);
  };
}

/**
 * Passive・ログインの段・書き込みの段の Context の中継の要求の方針（DEF-085。T30b で書き込みの段を足した）: その Context の Guard の許可
 * （許可 Origin、読み取りの方法、ログインの段の送信先、書き込みの段の承認の要求の形の送信先、監査の段の除外）を、中継から見た範囲にしたもの。
 * 判定は要求の判定の owner（`classifyPassiveRequest`）に任せる（第二の owner を置かない）。Guard の段階の状態（送信の窓、POST の回数）と、
 * 書き込みの段の送る中身は見ない（Guard が数えて照合して止める。中継は本文を見ない）。指定は作る時点の写しを使う。絶対形の HTTP の要求だけに
 * 当たる（https の CONNECT の中身は中継から見えないので、強制は Guard）。基の方針は `egressPolicyOptionsOf`（DEF-233 で切り出した。中身は変えない）。
 */
export function passiveEgressRequestPolicy(
  allowedOrigins: ReadonlySet<string>,
  stage: SubmissionStageOptions,
  auditExclusions: AuditExclusionPolicy | undefined,
  auditStage: AuditStageServiceRequests | undefined,
  role: ResourceDeliveryRole,
  auditSend: GuardAuditSend | undefined,
  readAdmissions: EgressReadAdmissions,
  sendAdmissions: EgressSendAdmissions | null = null,
  writeEndpointAdmissions: EgressSendAdmissions | null = null,
): EgressRequestPolicy {
  const { loginStage, writeStage } = stage;
  const policy = egressPolicyOptionsOf(stage, auditExclusions, auditStage, role, auditSend);
  // OP-N（N2）: 書き込みの段の、送信の扱いの口を足した方針（窓の外・値を入れる前の形。承認した送信の送信先は、ここでも通さない）。
  const writeStageSendPolicy: PassiveRequestPolicyOptions | null = writeStage !== undefined && auditSend !== undefined && sendAdmissions !== null
    && policy.authSetup === undefined
    ? Object.freeze({ ...policy, auditSend: egressAuditSendPolicy(auditSend) })
    : null;
  // L12a: 書き込みの段の、押した後の扱いを足した方針（Guard が通した要求の写しに当たる要求だけに使う。Guard より広くは通さない。中継は Guard の段の状態を
  // 知らないので、承認した送信の応答を受けた後の形で判定する）。
  const writeStageAfterPressPolicy: PassiveRequestPolicyOptions | null = writeStage !== undefined && auditSend !== undefined && sendAdmissions !== null
    && policy.writeStage !== undefined
    ? Object.freeze({ ...policy, writeStage: Object.freeze({ ...policy.writeStage, afterPress: Object.freeze({ approvedWriteResponded: true }) }) })
    : null;
  // DEF-193（設計書 3.2 の 5）: 自動ログインの段の通し方の印を足した方針（中継は本文とヘッダを見ないので、基の方針には入れない。Guard が通した要求の写し
  // `sendAdmissions` に当たる要求だけに使う。2 回目のログインの送信は、ここでも通さない）。
  const loginStagePassPolicy: PassiveRequestPolicyOptions | null = loginStage?.automatedPassThrough === true && policy.authSetup !== undefined && sendAdmissions !== null
    ? Object.freeze({ ...policy, authSetup: Object.freeze({ ...policy.authSetup, automatedPassThrough: true as const }) })
    : null;
  const origins: ReadonlySet<string> = new Set(allowedOrigins);
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 監査の段の除外は main frame の文書の読み込みだけに当てるので、中継の方針も
  // Guard と同じ方針で判定する（前の BN-R0 fix round 1 の、ページの文書でない読み取りにも当てる形 `strictPolicy` と、その形で通さない読み取りを Guard が通した
  // 写しで通す 2 段目は外した。写し `readAdmissions` は、書き込みの段の押した後の読み取りの照らしだけに使う）。
  const allowedBy = (target: PassiveRequestPolicyOptions, method: string, url: string): boolean => EGRESS_REQUEST_SHAPES.some((shape) =>
    classifyPassiveRequest({ kind: 'HTTP', method, url, ...shape }, origins, target).action === 'ALLOW');
  return (method: string, url: string): boolean => {
    // T39c・DEF-099 fix: 書き込みの段の、承認の送信先への書き込み（送り手が中継を通して送る 1 回。API は承認した API の Origin と path への `POST`・`PATCH`、
    // フォームは承認の送信先への `POST`。形は `writeStageEndpointRequestOf` の 1 か所）。LU-SFIX2-B（LU-SREV2 の Minor-2）: その形の要求は、Guard が通した
    // （照合に一致した）要求の写し `writeEndpointAdmissions` に当たるものだけを通す（Guard を通らずに中継へ直に送った要求は、窓の前でも後でも、予算の中でも
    // 通さない。写しがなければ通さない。fail-closed）。回数は今のとおり予算（`writeStageEgressBudget`）が 1 回に限る。
    if (writeEndpointAdmissions !== null && writeEndpointAdmissions.matches(method, url)) {
      return writeEndpointAdmissions.take(method, url);
    }
    // 読み取りの写しは、この要求で照らし合わせたら捨てる（どの決まりで通しても、通さなくても。写しは 1 つの要求に 1 回だけ使う）。要求を出し続ける画面で、
    // 使い終わった写しを Context の寿命まで持たないため。
    const readAdmitted = isReadMethod(method) && readAdmissions.take(method, url);
    return allowedBy(policy, method, url)
      // L12a: 書き込みの段の押した後に、Guard が通した読み取り（送り先の Origin を問わない）。
      || (writeStageAfterPressPolicy !== null && readAdmitted && allowedBy(writeStageAfterPressPolicy, method, url))
      // L12a: 書き込みの段の押した後に、Guard が通した読み取りでない要求（写しを 1 回ずつ使う）。
      || (writeStageAfterPressPolicy !== null && sendAdmissions !== null && !isReadMethod(method) && allowedBy(writeStageAfterPressPolicy, method, url)
        && sendAdmissions.take(method, url))
      // OP-N（N2）: 書き込みの段の、Guard が送信の扱いの口で通した読み取りでない要求（Guard が知らせた写しを 1 回ずつ使う。Guard より広くは通さない）。
      || (writeStageSendPolicy !== null && sendAdmissions !== null && !isReadMethod(method) && allowedBy(writeStageSendPolicy, method, url)
        && sendAdmissions.take(method, url))
      // DEF-193: 自動ログインの段の、Guard が通した読み取りでない要求（写しを 1 回ずつ使う。Guard より広くは通さない）。
      || (loginStagePassPolicy !== null && sendAdmissions !== null && !isReadMethod(method) && allowedBy(loginStagePassPolicy, method, url)
        && sendAdmissions.take(method, url));
  };
}


/**
 * OP-N（N2）: 書き込みの段の Context の Guard が通した、読み取りでない要求の写し（中継の要求の方針が使う。`passiveEgressRequestPolicy`）。Guard の口
 * （`onEgressDestinationAdmitted`）が、命令を送る前に同期で知らせる。中継は、当たった写しを使って消す。鍵は読み取りの写しと同じ形。
 * OP-REV3（I-2）: Guard は 1 つの要求を CDP の層と route の層の両方で知らせるので、写しは method と URL ごとに 1 つだけ持つ（重ねない。同じ method と URL の要求が
 * 同時に 2 つあれば、中継は 2 つ目を拒む。止める側）。受けてよいか（`accepting`。送信の窓を開く前だけ真）が偽になったら、残っている写しを捨て、以後は受けず、
 * 使わせない。
 */
export class EgressSendAdmissions {
  readonly #keys = new Set<string>();
  readonly #accepting: () => boolean;
  readonly #admits: (method: string, url: string) => boolean;

  /**
   * `admits`（省略はすべて）: 写しを持つ要求の形（LU-SFIX2-B。API の書き込みの段の、承認の送信先への書き込みの写しは、その送信先への要求だけを持つ）。
   */
  constructor(accepting: () => boolean, admits: (method: string, url: string) => boolean = () => true) {
    this.#accepting = accepting;
    this.#admits = admits;
  }

  /** fix round 2（SREV-233 の M-1）: 残っている写しをすべて捨てる（中継の凍結に入るとき。以後に知らせた写しは、今どおり受ける）。 */
  discard(): void {
    this.#keys.clear();
  }

  /** 写しを持つ要求の形か（中継の方針が、写しに当てる要求を見分けるのに使う。投げたら、偽）。 */
  matches(method: string, url: string): boolean {
    return this.#admitsSafely(method, url);
  }

  /** 写しを持つ要求の形か（投げたら、持たない）。 */
  #admitsSafely(method: string, url: string): boolean {
    try {
      return this.#admits(method, url) === true;
    } catch {
      return false;
    }
  }

  /** 受けてよいかを確かめる（偽なら、残っている写しを捨てる）。投げたら、偽とする。 */
  #open(): boolean {
    let open: boolean;
    try {
      open = this.#accepting() === true;
    } catch {
      open = false;
    }
    if (!open) {
      this.#keys.clear();
    }
    return open;
  }

  admit(method: string | undefined, url: string): void {
    if (method === undefined || isReadMethod(method) || !this.#open() || !this.#admitsSafely(method, url)) {
      return;
    }
    const key = egressReadAdmissionKeyOf(method, url);
    if (key === null) {
      return;
    }
    // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。N21）: 写しの数の上限（前は古いものから捨てた）は
    // 置かない（写しは中継が使うと消え、Context とともに捨てる）。
    this.#keys.delete(key);
    this.#keys.add(key);
  }

  take(method: string, url: string): boolean {
    if (!this.#open()) {
      return false;
    }
    const key = egressReadAdmissionKeyOf(method, url);
    return key !== null && this.#keys.delete(key);
  }

  /** 持っている写しの数（単体のテストのため）。 */
  get size(): number {
    return this.#keys.size;
  }
}

/**
 * SREV-SAFE の M-2: 凍結の段で Guard が通した読み取りでない要求（登録した読み取りの手続きの呼び出しと token の更新）の写し（中継の凍結の後の受け入れが使う）。
 * 同じ method と URL の要求が同時に複数あっても、Guard が通した数だけ中継も通す（数を持つ）。Guard は 1 つの要求を CDP の層と route の層の両方で知らせるので、
 * 数えるのは CDP の層の知らせだけ（route の層だけの知らせは数えない。中継は写しに当たらない要求を拒む側）。写しは中継が使うと 1 つ減り、凍結に入るときに捨てる。
 */
export class EgressFrozenSendAdmissions {
  readonly #counts = new Map<string, number>();

  /** 残っている写しをすべて捨てる（中継の凍結に入るとき）。 */
  discard(): void {
    this.#counts.clear();
  }

  admit(method: string | undefined, url: string, layer: GuardRequestLayer | undefined): void {
    if (method === undefined || isReadMethod(method) || layer === undefined || layer === 'ROUTE') {
      return;
    }
    const key = egressReadAdmissionKeyOf(method, url);
    if (key === null) {
      return;
    }
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1);
  }

  /** 中継が照らし合わせる: 写しがあれば 1 つ使って真。 */
  take(method: string, url: string): boolean {
    const key = egressReadAdmissionKeyOf(method, url);
    const count = key === null ? 0 : this.#counts.get(key) ?? 0;
    if (key === null || count === 0) {
      return false;
    }
    if (count === 1) this.#counts.delete(key);
    else this.#counts.set(key, count - 1);
    return true;
  }

  /** SREV-SAFE の N-1: CDP の層が数えた後に route の層が止めた要求の写しを 1 つ戻す（写しがなければ何もしない）。 */
  withdraw(method: string, url: string): void {
    void this.take(method, url);
  }
}

/**
 * BN-R0 fix round 1（I-1）: その Context の Guard が通した（`decideGuardRequest` の `ALLOW`）、読み取り（GET・HEAD）の要求の method と URL の写し（中継の要求の
 * 方針が使う。`passiveEgressRequestPolicy`）。Guard の口（`onEgressDestinationAdmitted`）が、命令を送る前に同期で知らせる。URL は fragment を外した正規の形で比べる。
 * L12b（N21）: 数の上限（前は 4,096 で、超えたら古いものから捨てた）は置かない。
 */

export class EgressReadAdmissions {
  readonly #keys = new Set<string>();

  /**
   * Guard が通した読み取りの写しを持つ。L12b（設計書 6.2。N21）: 写しの数の上限（前は古いものから捨て、捨てた資源の 2 回目を
   * 中継が拒んだ）は置かない。写しは、中継が照らし合わせたら捨てる（`take`）。中継が照らさない写し（`http:` でない URL。https は CONNECT の
   * 中が中継から見えないので、要求の方針も凍結の後の受け入れも当たらない）は、持たない（要求を出し続ける画面で、使われない写しが増え続けないように）。
   * Guard の層（CDP と route）が同じ要求を 2 回知らせても、写しは 1 つ（同じ鍵）。
   */
  admit(method: string | undefined, url: string): void {
    if (method === undefined || !isReadMethod(method)) {
      return;
    }
    const key = egressReadAdmissionKeyOf(method, url);
    if (key === null || !key.includes(` ${HTTP_SCHEME_PREFIX}`)) {
      return;
    }
    this.#keys.add(key);
  }

  /** 中継が照らし合わせる: 写しがあれば捨てて真（1 回だけ使う）。 */
  take(method: string, url: string): boolean {
    const key = egressReadAdmissionKeyOf(method, url);
    return key !== null && this.#keys.delete(key);
  }

  /** 持っている写しの数（単体のテストのため）。 */
  get size(): number {
    return this.#keys.size;
  }
}

/** 中継が要求の行を見る（照らし合わせる）URL の scheme の頭（絶対形の HTTP の要求だけ）。 */
const HTTP_SCHEME_PREFIX = 'http://';

/** 読み取りの知らせの鍵（大文字の method と、fragment を外した正規の URL）。読めない URL は `null`（知らせにも、照らしにも使わない）。 */
function egressReadAdmissionKeyOf(method: string, url: string): string | null {
  try {
    // fragment はサーバに送られないので、`#` から後を外してから正規の形にする（Guard の URL と中継の要求の行を同じ形で比べる）。
    return `${method.toUpperCase()} ${new URL(url.split('#', 1)[0] ?? url).href}`;
  } catch {
    return null;
  }
}

/**
 * T44b（Task 44 の設計書 3.1 の P1-1）: その Context が、スクリプトで送るログインの監査の段で承認したサービスの Origin へ送るか（Guard の口の
 * `readRequestsAllowed` と、中継の口の写し）。最初の読み込み（`PRIMARY`）と、監査の段の送信の扱い `PASS_EXCEPT_DELETE` の Context（幅の走査の `REVISIT` を
 * 含む。`auditSend` を渡すのは Passive の Context だけ）。送る要求は、どの役割でも上限の部品（`service-request-budget`）で数える。`READ_ONLY` の幅の走査と、
 * Isolated Interaction Context（`auditSend` を渡さない）は、今どおり送らない（T35R-fix の C-1）。
 */
const servesServiceOrigin = (role: ResourceDeliveryRole, auditSend: GuardAuditSend | undefined): boolean =>
  role === 'PRIMARY' || auditSend !== undefined;

/**
 * 中継の要求の方針の、スクリプトで送るログインの監査の段の口（T35b。写しを取る。登録した読み取りの手続きの呼び出しは、サービスの Origin へ送る Context では
 * どの項目も残り 1）。T35R2-fix（T35R2 の M-3）: 送らない Context（`servesServiceOrigin` が偽）では、Guard と同じく承認したサービスの Origin へ送らず
 * （`serviceOriginRequestsWithheld`）、登録した呼び出しの残りも 0 にする。
 */
function egressAuditStagePolicy(stage: AuditStageServiceRequests, servesService: boolean): AuditStagePolicy {
  return Object.freeze({
    approvedServiceOrigins: Object.freeze([...stage.approvedServiceOrigins]),
    auditReadRequests: Object.freeze(stage.auditReadRequests.map(({ origin, path, method }) =>
      Object.freeze({ origin, path, method, remainingPosts: servesService ? EGRESS_LOGIN_POST_REMAINING : 0 }))),
    serviceOriginRequestsWithheld: !servesService,
    scriptLogin: Object.freeze({
      origin: stage.scriptLogin.origin,
      path: stage.scriptLogin.path,
      requiredQuery: Object.freeze(stage.scriptLogin.requiredQuery.map(({ name, value }) => Object.freeze({ name, value }))),
    }),
  });
}

/** 中継の要求の方針の、監査の段の送信の扱いの口（AS-a。写しを取る。通す数は Guard が数えるので、中継は残り 1 とする）。 */
/** AS-a: 監査の段の送信の扱いの指定の、凍結した写し（OP-REV3 の C-1 で、Passive の Context の指定と書き込みの段だけの指定に共通にした）。 */
function guardAuditSendCopyOf(send: GuardAuditSend): GuardAuditSend {
  return Object.freeze({
    policy: send.policy,
    approvedServiceOrigins: Object.freeze([...send.approvedServiceOrigins]),
    dangerousTerms: Object.freeze([...send.dangerousTerms]),
    // OP-Q（Q1）: 書き込みの作業の印（あるときだけ。落とすと、監査の段の決まりで通してしまうので、必ず写す）。
    ...writeJobEndpointCopyOf(send),
  });
}

/** OP-Q（Q1）: 書き込みの作業の印の写し（あるときだけ `{ writeJobEndpoint }`）。Guard の指定の写しと、中継の要求の方針の口の両方が使う。 */
const writeJobEndpointCopyOf = (send: GuardAuditSend): { readonly writeJobEndpoint?: SubmissionEndpoint } =>
  (send.writeJobEndpoint === undefined
    ? {}
    : { writeJobEndpoint: Object.freeze({ origin: String(send.writeJobEndpoint.origin), path: String(send.writeJobEndpoint.path) }) });

function egressAuditSendPolicy(send: GuardAuditSend): AuditSendPolicy {
  return Object.freeze({
    approvedServiceOrigins: Object.freeze([...send.approvedServiceOrigins]),
    dangerousTerms: Object.freeze([...send.dangerousTerms]),
    // OP-Q（Q1）: 中継も、Guard と同じ書き込みの作業の決まりで判定する（Guard より広くは通さない）。
    ...writeJobEndpointCopyOf(send),
  });
}

/**
 * 中継の要求の方針の、スクリプトで送るログインの口（T34b）。中継は回数を数えないので、token の送信とログインに伴う送信のどの項目も、Guard が
 * 許しうるものとして残りを 1 にする（Guard が数えて止める）。写しを取る。
 */
function egressScriptRequestPolicy(script: GuardScriptLogin): ScriptRequestLoginPolicy {
  const { scriptLogin } = script;
  return Object.freeze({
    scriptLogin: Object.freeze({
      origin: scriptLogin.origin,
      path: scriptLogin.path,
      requiredQuery: Object.freeze(scriptLogin.requiredQuery.map(({ name, value }) => Object.freeze({ name, value }))),
    }),
    loginSideRequests: Object.freeze(script.loginSideRequests.map(({ origin, path, method }) =>
      Object.freeze({ origin, path, method, remainingPosts: EGRESS_LOGIN_POST_REMAINING }))),
    approvedServiceOrigins: Object.freeze([...script.approvedServiceOrigins]),
  });
}

/** DEF-099 fix: 書き込みの段の中継が通す、承認の送信先への POST の回数（承認された 1 回の CREATE）。 */
const WRITE_STAGE_EGRESS_POSTS = 1;

/** DEF-099 fix: 書き込みの段の中継の、承認の送信先への POST の数え方（絶対形の HTTP の要求だけ。送信先の比べ方は要求の判定の owner）。 */
/**
 * T39R-fix（M-1）: API の書き込みの段の、承認の endpoint（承認した API の Origin と、照合へ回す要求の path）。LU-5（fix round 1 の案 A）: path は照合の
 * 側の唯一の部品 `apiWriteCheckPathOf`（path の形の更新は `{id}` を台帳の ID にした具体的な path、ほかは path の型のまま）。作れない期待は空の文字で、
 * どの要求にも当たらない（fail-closed）。
 */
const apiWriteEndpointOf = (writeStage: GuardApiWriteStage): SubmissionEndpoint =>
  Object.freeze({ origin: writeStage.expectation.spec.request.origin, path: apiWriteCheckPathOf(writeStage.expectation) ?? '' });

/**
 * T39R-fix（M-1）: 要求が、承認の endpoint への `POST`・`PATCH` か（query は問わない）。中継の方針（送り手の 1 回を通す）と予算（その回数を数える）が
 * 同じ形を使う（要求の判定の owner の部品 `isApiWriteCheckTarget`・`isApiWriteEndpointUrl`）。
 */
const isApiWriteEndpointRequest = (method: string, url: string, endpoint: SubmissionEndpoint): boolean =>
  isApiWriteCheckTarget(method, url, endpoint.origin) && isApiWriteEndpointUrl(url, endpoint);

/**
 * T39c（Task 39 の設計書 3.4）: API の書き込みの段の中継の、承認の endpoint への `POST`・`PATCH` の数え方（絶対形の HTTP の要求だけ。https の
 * CONNECT の中身は数えない。宛先は DEF-125 の受け入れで Guard が知らせたものだけ）。送り手の 1 回のほかは止めて記録する。T39R-fix（M-1）: 数えるのは
 * 承認の endpoint（Origin と path）への要求だけ（窓の外で通した登録した読み取りの手続きの呼び出しは数えない。方針の側と同じ形）。
 */
/**
 * LU-SFIX2-B: 書き込みの段の、承認の送信先への書き込みの形（唯一の組み立て）。API は承認の endpoint への `POST`・`PATCH`（query は問わない）、フォームは
 * 承認の送信先への `POST`（DEF-099 fix）。中継の予算（`writeStageEgressBudget`）と、Guard が通した写し（`EgressSendAdmissions` の `admits`）が同じ形を使う。
 */
const writeStageEndpointRequestOf = (writeStage: GuardWriteStage): ((method: string, url: string) => boolean) => {
  if (isGuardApiWriteStage(writeStage)) {
    const endpoint = apiWriteEndpointOf(writeStage);
    return (method, url) => isApiWriteEndpointRequest(method, url, endpoint);
  }
  const endpoint = Object.freeze({ origin: writeStage.expectation.request.origin, path: writeStage.expectation.request.path });
  return (method, url) => method.toUpperCase() === SUBMISSION_POST_METHOD && isWriteEndpointUrl(url, endpoint);
};

/** 書き込みの段の中継の予算（承認の送信先への書き込みは `WRITE_STAGE_EGRESS_POSTS` 回まで。形は `writeStageEndpointRequestOf`）。 */
const writeStageEgressBudget = (writeStage: GuardWriteStage): EgressRequestBudget =>
  Object.freeze({ matches: writeStageEndpointRequestOf(writeStage), limit: WRITE_STAGE_EGRESS_POSTS });

/** 承認したサービスの Origin からの、認証の失敗の応答の status（T35c。数えるだけ）。 */
const HTTP_UNAUTHORIZED_STATUS = 401;

/** Shared Worker の、CDP の target の種類（`Target.TargetInfo.type`。DEF-044）。 */
const SHARED_WORKER_TARGET_TYPE = 'shared_worker';
/** Service Worker の、CDP の target の種類（`Target.TargetInfo.type`。DEF-049）。 */
const SERVICE_WORKER_TARGET_TYPE = 'service_worker';

/** factory の自己検査（DEF-044、DEF-049）の違反のコードと文言。 */
interface WorkerSelfCheckViolation {
  readonly code: string;
  readonly message: string;
}

/** Shared Worker の自己検査の違反（DEF-044。設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 1.2）。 */
const SHARED_WORKER_OBSERVED: WorkerSelfCheckViolation = Object.freeze({
  code: 'SHARED_WORKER_OBSERVED',
  message: 'A Shared Worker target was observed although the launch arguments disable Shared Workers',
});
/** Service Worker の自己検査の違反（DEF-049。同じ設計書 5 と変更履歴の NP6 の Blocker の行）。 */
const SERVICE_WORKER_OBSERVED: WorkerSelfCheckViolation = Object.freeze({
  code: 'SERVICE_WORKER_OBSERVED',
  message: 'A Service Worker target was observed although the Guard blocks Service Worker registration',
});

/**
 * Service Worker の target に、Browser の CDP の session を自動で付ける指定（DEF-049）。付いた target は、再開の命令
 * （`Runtime.runIfWaitingForDebugger`）を factory からは送らない（Playwright 自身の session が再開させるので、止める保証はない。NP6 の実験）。
 * Browser の水準の auto-attach は、flatten の形だけを受け付ける。
 */
const SERVICE_WORKER_AUTO_ATTACH = Object.freeze({
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: SERVICE_WORKER_TARGET_TYPE, exclude: false }],
});

const isResourceDeliveryRole = (value: unknown): value is ResourceDeliveryRole =>
  (RESOURCE_DELIVERY_ROLES as readonly unknown[]).includes(value);

export interface InteractionGuardedSession {
  readonly page: Page;
  readonly ledger: SafetyLedger;
  readonly isClosed: () => boolean;
  activateInteractionFreeze(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Guard 付きの Context の構築（Guard の取り付け、または page の作成）に失敗したことを表す（Task 14〜17 の設計書 4.3、R14r の Important-1）。
 * Context が閉じられたかどうかに関係なく投げる。
 * - `context`: 構築に失敗した Context。Guard がまだ閉じていなければ（`isPassiveRequestGuardClosed` が偽）、factory が所有したままなので、
 *   呼び出し側が factory の close API で閉じる。
 * - `ledger`: その Context の Safety Ledger。Guard の取り付けの失敗などの違反が記録されているので、呼び出し側は、これを Safety の
 *   Evidence と違反の集計に含める。factory の `getSafetyLedger(context)` でも、同じ Ledger を取り出せる。
 */
export class ContextConstructionError extends Error {
  readonly context: BrowserContext;
  readonly ledger: SafetyLedger;
  override readonly cause: unknown;

  constructor(context: BrowserContext, ledger: SafetyLedger, cause: unknown) {
    super('Guarded browser construction failed; the Context and its Safety Ledger are retained', { cause });
    this.name = 'ContextConstructionError';
    this.context = context;
    this.ledger = ledger;
    this.cause = cause;
    Object.freeze(this);
  }
}

const issuedSafetyLedgers = new WeakSet<SafetyLedger>();

/** 要求の終わりの事象を受け取れる meter か（`recordRequestFinished`・`recordRequestFailed`・`recordResponseReceived`（DEF-241）の関数を持つ）。 */
function recordsRequestEnds(value: unknown): boolean {
  return isRecord(value)
    && typeof value.recordRequestFinished === 'function'
    && typeof value.recordRequestFailed === 'function'
    && typeof value.recordResponseReceived === 'function';
}

function viewportSnapshot(viewport: Viewport): Viewport {
  if (!isPositiveSafeInteger(viewport.width) || !isPositiveSafeInteger(viewport.height)) {
    throw new Error('Passive browser viewport dimensions must be positive safe integers');
  }
  return Object.freeze({ width: viewport.width, height: viewport.height });
}

/** 文字列の配列か。 */
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');


/**
 * 監査の段の口の形か（T35c。`assertRunAuthentication` と factory の `isAuthenticatedContextOptions` が使う唯一の確かめ）: 承認したサービスの Origin が
 * 文字列の配列、読み取りの手続きの呼び出しが `{ origin, path, method, maxPerPageLoad }`（文字列と正の整数）の配列、token の送信先が
 * `{ origin, path, requiredQuery: { name, value }[] }`（LZ-3c: 要求の上限の形は確かめない。口は上限を持たない）。
 */
export function isAuditStageServiceRequests(value: unknown): value is AuditStageServiceRequests {
  if (!isRecord(value) || !isStringArray(value.approvedServiceOrigins) || !Array.isArray(value.auditReadRequests)) {
    return false;
  }
  const { scriptLogin } = value;
  return value.auditReadRequests.every((request: unknown) => isRecord(request)
      && isStringArray([request['origin'], request['path'], request['method']])
      && isPositiveSafeInteger(request['maxPerPageLoad']))
    && isRecord(scriptLogin)
    && isStringArray([scriptLogin['origin'], scriptLogin['path']])
    && Array.isArray(scriptLogin['requiredQuery'])
    && (scriptLogin['requiredQuery'] as readonly unknown[]).every((parameter) =>
      isRecord(parameter) && isStringArray([parameter['name'], parameter['value']]));
}

/** 認証の指定の形か（T25c。値の中身は見ない。最初の状態の形は、絞った後の写しで確かめる）。 */
function isAuthenticatedContextOptions(value: unknown): value is AuthenticatedContextOptions {
  if (!isRecord(value) || typeof value.filterState !== 'function' || !isRecord(value.initialState)) {
    return false;
  }
  const { auditExclusions } = value;
  return isRecord(auditExclusions)
    && isStringArray(auditExclusions.excludedPathPrefixes)
    && isStringArray(auditExclusions.auditPathPrefixes)
    && isStringArray(auditExclusions.dangerousTerms)
    // T35c: 監査の段の口（省略か、形の正しい口）と、ログインの状態の鍵の判定（省略か、関数）。
    && (value.auditStage === undefined || isAuditStageServiceRequests(value.auditStage))
    && (value.sessionKeyPresent === undefined || typeof value.sessionKeyPresent === 'function')
    // DEF-233: 成功の鍵の名前の判定（省略か、関数）。
    && (value.sessionKeyName === undefined || typeof value.sessionKeyName === 'function')
    // DEF-220: 承認したテストの Origin（省略か、文字列の配列）。
    && (value.approvedTestOrigins === undefined || isStringArray(value.approvedTestOrigins));
}

/**
 * ログインの段の指定の形か（T25d）: 送信先が 1 件以上の `{ origin, path }`（どちらも文字列）で、上限が 0 以上の安全な整数。値の意味（Origin の
 * 正規の形、path の形）は、要求の判定の owner（`classifyPassiveRequest` の `authSetup` の口）が判定する（合わない送信先には許さない）。
 * T26g-1: ログインの段の記録と送信の窓の口（`monitor`）は、省略するか `LoginStageMonitor` だけを受ける。
 * T34b: スクリプトで送るログインの指定（`scriptRequest`）は、省略するか `isGuardScriptLogin` の形だけを受ける。ある場合は、フォームの送信先
 * （`loginPostEndpoints`）は空でよい（使わない）。
 */
function isGuardLoginStage(value: unknown): value is GuardLoginStage {
  if (!isRecord(value) || !Array.isArray(value.loginPostEndpoints)) {
    return false;
  }
  const { maxLoginPosts, scriptRequest } = value;
  // T44e（Task 44 の設計書 P2-8）: 手動のログインの段（`manualPassThrough`）だけは、送信先もスクリプトの指定もない口を受ける（スクリプトで送るログインの設定の
  // token の送信先がまだない形。今の決まりでは止める送信を、手動の段の口が通して記録する。通し方は変えない）。自動ログインの段は今どおり拒む。
  const manualWithoutTargets = value.manualPassThrough === true && value.credentialGuard === undefined && value.loginPostEndpoints.length === 0;
  if (scriptRequest === undefined ? value.loginPostEndpoints.length === 0 && !manualWithoutTargets : !isGuardScriptLogin(scriptRequest)) {
    return false;
  }
  // T36b（Task 36 の設計書 3.3）: 自動ログインの資格情報の部品は、スクリプトで送るログインの指定と一緒にだけ受ける（部品の作り方で作ったものだけ）。
  const { credentialGuard } = value;
  if (credentialGuard !== undefined && (scriptRequest === undefined || !isLoginCredentialGuard(credentialGuard))) {
    return false;
  }
  // ML-a: 手動のログインの段の印は `true` だけを受け、自動ログインの資格情報の部品とは一緒に受けない（自動ログインの段は今の厳しさのまま）。
  const { manualPassThrough } = value;
  if (manualPassThrough !== undefined && (manualPassThrough !== true || credentialGuard !== undefined)) {
    return false;
  }
  // T44R（Task 44 のレビューの M-1）: 手動のログインの段の、token の送信先がまだない設定の承認したサービスの Origin は、文字列の配列だけを、手動の段の印と
  // 一緒に、スクリプトの指定がないときだけ受ける（自動ログインの段は受けない）。
  const { manualServiceReadOrigins } = value;
  if (
    manualServiceReadOrigins !== undefined
    && (!isStringArray(manualServiceReadOrigins) || manualPassThrough !== true || scriptRequest !== undefined)
  ) {
    return false;
  }
  return isNonNegativeSafeInteger(maxLoginPosts)
    && (value.monitor === undefined || value.monitor instanceof LoginStageMonitor)
    && value.loginPostEndpoints.every((endpoint: unknown) => isRecord(endpoint) && isStringArray([endpoint['origin'], endpoint['path']]));
}

/** 0 以上の安全な整数か。 */
const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * スクリプトで送るログインの指定の形か（T34b）: token の送信先が `{ origin, path, requiredQuery: { name, value }[] }`（どれも文字列）、ログインに伴う
 * 送信が `{ origin, path, method, maxPerLoginStage }`（文字列と、0 以上の安全な整数）の配列、承認したサービスの Origin が文字列の配列。値の意味
 * （Origin の正規の形、path の形、method）は、要求の判定の owner（`classifyPassiveRequest` の `authSetup.scriptRequest` の口）が判定する（合わない
 * 送信先には許さない）。
 */
function isGuardScriptLogin(value: unknown): value is GuardScriptLogin {
  if (!isRecord(value) || !isRecord(value.scriptLogin) || !Array.isArray(value.loginSideRequests)) {
    return false;
  }
  const { scriptLogin } = value;
  return isStringArray([scriptLogin['origin'], scriptLogin['path']])
    && Array.isArray(scriptLogin['requiredQuery'])
    && (scriptLogin['requiredQuery'] as readonly unknown[]).every((parameter) =>
      isRecord(parameter) && isStringArray([parameter['name'], parameter['value']]))
    && value.loginSideRequests.every((side: unknown) =>
      isRecord(side) && isStringArray([side['origin'], side['path'], side['method']]) && isNonNegativeSafeInteger(side['maxPerLoginStage']))
    && isStringArray(value.approvedServiceOrigins);
}

/** Cookie の `SameSite` の値（Playwright の `storageState` の形。一覧は core の 1 か所。CC-060 の B）。 */
const STORAGE_STATE_SAME_SITE_VALUES: readonly unknown[] = AUTHENTICATED_STATE_SAME_SITE_VALUES;

/**
 * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.2）・DEF-251（案 1）: 押す前に読んだ状態（`pinned`）を基にし、ログインの成功の鍵
 * （`isSessionKey`。Origin と名前で判定する）に当たるローカル ストレージの値だけを、作り直した値（`rebuild`。押す前の値を受け、作り直せなければ null）で置き換える。
 * ページが閉じる前に書いた状態は使わない（鍵を足さない・消さない）。Cookie・IndexedDB・ほかの鍵は、基のまま。判定がなければ基のまま。工場の作り直しは
 * `sessionKeyValueRebuiltFrom` と目印の照らし。値は読むだけで、記録しない。
 */
export function withSessionKeyValuesOf(
  pinned: AuthenticatedStorageState,
  isSessionKey: ((origin: string, name: string) => boolean) | undefined,
  rebuild: (before: string) => string | null,
): AuthenticatedStorageState {
  if (isSessionKey === undefined) {
    return pinned;
  }
  return {
    ...pinned,
    origins: pinned.origins.map((base) => ({
      ...base,
      localStorage: base.localStorage.map((item) => {
        const rebuilt = isSessionKey(base.origin, item.name) ? rebuild(item.value) : null;
        return rebuilt === null ? item : { ...item, value: rebuilt };
      }),
    })),
  };
}

/** fix round 3: Guard が通した token の更新の要求（凍結の段か、と、要求の header と本文の文字列）。 */
interface AdmittedTokenRefresh {
  readonly frozen: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

/** fix round 3: 凍結の前に通し、2xx の応答を受けた更新（成功の鍵が実際に更新されたと確かめたら、Run の中で覚える）。 */
interface RefreshCandidate {
  readonly url: string;
  readonly request: AdmittedTokenRefresh;
  readonly responseText: string;
}

/**
 * DEF-233 fix round 2・3: Context ごとの token の更新の記録（メモリの中だけ。値を記録しない）。
 * - `admittedTexts`: Guard が通した更新（凍結の前と、凍結の段に A1 で通したもの）の応答の本文（A1 の本文の今の鍵の値）。
 * - `frozenTexts`: そのうち、凍結の段に A1 で通した更新の応答の本文（A2 の重ねの比べの相手。M-3）。
 * - `admissions`: Guard の通した知らせ（URL ごとの順の列）。応答を受けたら 1 つ使う。
 * - `candidates`: 凍結の前に通して 2xx を受けた更新（確かめを待つ）。
 * - `pending`: 読み途中の本文。
 */
interface TokenRefreshResponseRecord {
  readonly admittedTexts: string[];
  readonly frozenTexts: string[];
  readonly admissions: Map<string, AdmittedTokenRefresh[]>;
  readonly candidates: RefreshCandidate[];
  readonly pending: Set<Promise<void>>;
}

/**
 * fix round 3（SREV-233 の確かめ直しの N-1・N-2）: Run の中で、凍結の前に通し、応答で成功の鍵が実際に更新されたと確かめた更新から覚えたもの（凍結の段で通す更新の
 * 比べの相手）。どれも 1 つの名前に値 1 つまで。違う値が来たら、その名前を消し、以後は覚えない（通さない側）。
 * - `query`・`poisonedQuery`: 必須の query の値。`headers`・`poisonedHeaders`: 要求の header（小文字の名前）。
 * - `bodyShape`: 本文の形（違う形が来たか、形にできない本文なら `bodyConflict`）。`verified`: 1 つ以上確かめたか。
 */
interface LearnedTokenRefresh {
  readonly query: Map<string, string>;
  readonly poisonedQuery: Set<string>;
  readonly headers: Map<string, string>;
  readonly poisonedHeaders: Set<string>;
  bodyShape: readonly string[] | null;
  bodyConflict: boolean;
  verified: boolean;
}

/** fix round 3: 1 つの名前に値 1 つだけを覚える（違う値が来たら消して、以後は覚えない）。 */
const learnSingleValue = (values: Map<string, string>, poisoned: Set<string>, name: string, value: string): void => {
  if (poisoned.has(name)) return;
  const known = values.get(name);
  if (known === undefined) {
    values.set(name, value);
  } else if (known !== value) {
    values.delete(name);
    poisoned.add(name);
  }
};

/**
 * 認証済みの状態の、知っている項目だけを写した、凍結した写し（T25c）。形が正しくなければ投げる（誤りの文に値を入れない）。絞り込みの関数が
 * 返した値を、そのまま持たない（後から書き換えられないように）。
 */
function authenticatedStateCopy(value: unknown): AuthenticatedStorageState {
  if (!isRecord(value) || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new TypeError('Authenticated state must have cookies and origins');
  }
  const cookies = (value.cookies as readonly unknown[]).map((cookie) => {
    if (
      !isRecord(cookie)
      || typeof cookie.name !== 'string'
      || typeof cookie.value !== 'string'
      || typeof cookie.domain !== 'string'
      || typeof cookie.path !== 'string'
      || typeof cookie.expires !== 'number'
      || typeof cookie.httpOnly !== 'boolean'
      || typeof cookie.secure !== 'boolean'
      || !STORAGE_STATE_SAME_SITE_VALUES.includes(cookie.sameSite)
    ) {
      throw new TypeError('Authenticated state has a malformed cookie');
    }
    return Object.freeze({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite as AuthenticatedStorageState['cookies'][number]['sameSite'],
    });
  });
  const origins = (value.origins as readonly unknown[]).map((entry) => {
    const entryOrigin: unknown = isRecord(entry) ? entry['origin'] : undefined;
    if (!isRecord(entry) || typeof entryOrigin !== 'string' || !Array.isArray(entry.localStorage)) {
      throw new TypeError('Authenticated state has a malformed origin');
    }
    const localStorage = (entry.localStorage as readonly unknown[]).map((item) => {
      if (!isRecord(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
        throw new TypeError('Authenticated state has a malformed storage item');
      }
      return Object.freeze({ name: item.name, value: item.value });
    });
    const indexedDB = indexedDBCopyOf(entry['indexedDB']);
    return Object.freeze({ origin: entryOrigin, localStorage: Object.freeze(localStorage), ...(indexedDB === undefined ? {} : { indexedDB }) });
  });
  return Object.freeze({ cookies: Object.freeze(cookies), origins: Object.freeze(origins) });
}

/**
 * DEF-139: IndexedDB のデータベースの、凍結した深い写し（なければ `undefined`）。形が正しくなければ投げる（誤りの文に値を入れない）。中身は読まない。
 */
function indexedDBCopyOf(value: unknown): readonly AuthenticatedIndexedDBDatabase[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new TypeError('Authenticated state has a malformed IndexedDB');
  }
  const databases = (value as readonly unknown[]).map((database) => {
    if (!isRecord(database) || typeof database['name'] !== 'string' || typeof database['version'] !== 'number' || !Array.isArray(database['stores'])) {
      throw new TypeError('Authenticated state has a malformed IndexedDB database');
    }
    return { name: database['name'], version: database['version'], stores: structuredClone(database['stores'] as readonly unknown[]) };
  });
  return databases.length === 0 ? undefined : deepFreeze(databases);
}

/** LU-SFIX3-B: 応答の `Set-Cookie` のヘッダの名前。 */
const SET_COOKIE_HEADER = 'set-cookie';

/** LU-SFIX3-B: サーバの応答の `Set-Cookie` で来た cookie（名前・値と、cookie の Domain の属性か、なければ応答の host）。 */
interface ServerSetCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
}

/** LU-SFIX3-B: `Set-Cookie` のヘッダ 1 つを読む（名前のない形は `null`。値は最初の `;` までの、最初の `=` の後）。 */
function serverSetCookieOf(header: string, host: string): ServerSetCookie | null {
  const [pair = '', ...attributes] = header.split(';');
  const separator = pair.indexOf('=');
  const name = (separator < 0 ? '' : pair.slice(0, separator)).trim();
  if (name === '') {
    return null;
  }
  const domainAttribute = attributes.map((attribute) => attribute.trim()).find((attribute) => attribute.toLowerCase().startsWith('domain='));
  const domain = domainAttribute === undefined ? host : domainAttribute.slice('domain='.length).trim();
  return Object.freeze({ name, value: pair.slice(separator + 1).trim(), domain: cookieDomainOf(domain) });
}

/** cookie の domain の比べる形（前の `.` を外した小文字）。 */
const cookieDomainOf = (domain: string): string => domain.replace(/^\./u, '').toLowerCase();

/** cookie の同じものの鍵（名前・domain・path）。 */
const cookieKeyOf = (cookie: AuthenticatedStorageState['cookies'][number]): string =>
  JSON.stringify([cookie.name, cookieDomainOf(cookie.domain), cookie.path]);

/**
 * LU-SFIX2-B・LU-SFIX3-B（LU-SREV2・LU-SREV3 の Important-1）: 書き込みの段の Context の後に、次の Context（照合の READ など）へ渡す状態（唯一の決め方）。
 * - localStorage と IndexedDB（`origins`）: 書き込みの段の前の世代（`given`）のまま（ページのスクリプトが書けるので）。
 * - cookie: 書き込みの段の後に読んだ cookie（`read`）のうち、HttpOnly のもの（ページのスクリプトは作れず、変えられない）と、書き込みの段の間にサーバの
 *   `Set-Cookie` で来た値（`serverCookies`。名前・domain が同じで、最後に来た値と同じ値）のものだけを、後の値にする。ほか（ページのスクリプトが書けたもの）は、
 *   前の世代の同じ cookie（名前・domain・path）の値に戻し、前の世代になければ渡さない。前の世代にあって後にない cookie は、HttpOnly でなく、サーバの
 *   `Set-Cookie` で来ていなければ（ページが消せたもの）、前の世代の値で渡す。
 * HttpOnly でないログインの cookie を、ページのスクリプトが回す形のサイトでは、前の世代の値に戻すので、照合が「確かめられない」になりうる（止める側）。
 */
function writeStageCarriedStateOf(
  given: AuthenticatedStorageState,
  read: AuthenticatedStorageState,
  serverCookies: readonly ServerSetCookie[],
): AuthenticatedStorageState {
  const lastServerValueOf = (cookie: AuthenticatedStorageState['cookies'][number]): string | undefined => {
    const domain = cookieDomainOf(cookie.domain);
    return serverCookies.filter((entry) => entry.name === cookie.name && entry.domain === domain).at(-1)?.value;
  };
  const givenByKey = new Map(given.cookies.map((cookie) => [cookieKeyOf(cookie), cookie] as const));
  const readKeys = new Set(read.cookies.map(cookieKeyOf));
  const carried = read.cookies.flatMap((cookie) => {
    if (cookie.httpOnly || (lastServerValueOf(cookie) !== undefined && lastServerValueOf(cookie) === cookie.value)) {
      return [cookie];
    }
    const before = givenByKey.get(cookieKeyOf(cookie));
    return before === undefined ? [] : [before];
  });
  const restored = given.cookies.filter((cookie) => !readKeys.has(cookieKeyOf(cookie)) && !cookie.httpOnly && lastServerValueOf(cookie) === undefined);
  return Object.freeze({ cookies: Object.freeze([...carried, ...restored]), origins: given.origins });
}

/** Playwright の `newContext` の `storageState` に渡す、書き換えのできる写し（T25c。メモリのまま渡す。ファイルに書かない）。 */
function playwrightStorageState(state: AuthenticatedStorageState): Exclude<BrowserContextOptions['storageState'], string | undefined> {
  return {
    cookies: state.cookies.map((cookie) => ({ ...cookie })),
    origins: state.origins.map((entry) => {
      // DEF-139: IndexedDB も渡す（Playwright の型は持たないが、`newContext` の `storageState` は受ける）。
      const origin: { origin: string; localStorage: { name: string; value: string }[]; indexedDB?: unknown[] } = {
        origin: entry.origin,
        localStorage: entry.localStorage.map((item) => ({ ...item })),
      };
      if (entry.indexedDB !== undefined && entry.indexedDB.length > 0) {
        origin.indexedDB = structuredClone(entry.indexedDB) as unknown[];
      }
      return origin;
    }),
  };
}

export class BrowserContextFactory {
  readonly #browser: Browser;
  readonly #locale: string;
  /** DEF-099 fix: テストだけの、送り手が信頼する証明書（production は undefined）。 */
  readonly #writeSubmissionCertificates: readonly string[] | undefined;
  readonly #timezone: string;
  readonly #allowedOrigins: ReadonlySet<string>;
  /** RB-4b: 中継の CONNECT の受け入れ（監査するサイトの Origin つき。`egressTunnelAdmissionOf`）。 */
  readonly #egressTunnelAdmission: EgressTunnelAdmission;
  readonly #ledgerFactory: SafetyLedgerFactory;
  readonly #contextLedgers = new WeakMap<BrowserContext, SafetyLedger>();
  /** T37b: Context ごとの送らずに観察する probe の口（PRIMARY の Passive の Context だけ。`submissionObservationOf`）。 */
  readonly #submissionObservations = new WeakMap<BrowserContext, SubmissionObservation>();
  /**
   * T37R-fix-B（T37R の I-1）: probe を行う Context の、押す前に読んだ状態（`pinAuthenticatedStateBeforeProbe`）。閉じるときに次の Context へ渡す状態と、
   * 鍵の消失の判定は、Context を読み直さずにこの状態を使う（押下でページが書き換えた localStorage・Cookie を受け継がない）。読めなかったら `null`
   * （閉じるときも受け継がず、失敗に数える。fail-closed）。
   */
  readonly #pinnedAuthenticatedStates = new WeakMap<BrowserContext, AuthenticatedStorageState | null>();
  /**
   * LU-SFIX2-B（LU-SREV2 の Important-1）: 書き込みの段の Context に渡した（Context を作る直前に受け継いでいた）状態。その Context の状態を読んで次の
   * Context（照合の READ など）へ渡すときは、`writeStageCarriedStateOf` で、ページのスクリプトが書けるものをこの写しに戻す（書き込みの段でページが書いた値を
   * 受け継がない。ページのスクリプトが、サーバの状態を偽って照合を一致させる道を閉じる）。受け継ぎの owner は factory のこの 1 か所。
   */
  readonly #writeStageGivenStates = new WeakMap<BrowserContext, AuthenticatedStorageState>();
  /** LU-SFIX5: 書き込みのジョブの factory か（`BrowserContextFactoryOptions.writeJob`）。真なら、どの Context の後も `writeStageCarriedStateOf` で受け継ぐ。 */
  readonly #writeJob: boolean;
  /** RB-4 fix: 監査の Run の factory か（`BrowserContextFactoryOptions.pageAuditRun`）。真なら、PRIMARY に観察の口を付けない（凍結しない）。 */
  readonly #pageAuditRun: boolean;
  /** DEF-276: 操作さがしの Run の factory か（`BrowserContextFactoryOptions.submissionProbeRun`）。真なら、PRIMARY の観察の口が凍結の後に押す口になる。 */
  readonly #submissionProbeRun: boolean;
  /**
   * LU-SFIX3-B（LU-SREV3 の Important-1）: 書き込みの段の Context で、サーバの応答の `Set-Cookie` で来たことを見た cookie（名前・値・応答の host。来た順）と、
   * まだ読み終えていない応答のヘッダの読み取り。メモリの中だけ（記録しない）。
   */
  readonly #writeStageServerCookies = new WeakMap<BrowserContext, { readonly seen: ServerSetCookie[]; readonly pending: Set<Promise<void>> }>();
  /**
   * DEF-138:Context ごとの、渡した状態と最後に読んだ状態の名前（値を持たない。`authenticatedStateNamesOf`）。認証つきの Context だけ。Context と一緒に
   * 捨てる（WeakMap）。
   */
  readonly #contextStateNames = new WeakMap<BrowserContext, { given: AuthenticatedStateNames; read: AuthenticatedStateNames | null }>();
  /**
   * factory が所有する（閉じる責任を持つ）Context。Worker の自己検査（DEF-044、DEF-049）が、所有するすべての Context をたどるので、
   * `Set` にする（以前は `WeakSet`）。所有を解放するとき（`#releaseContext`）に外すので、閉じた Context を持ち続けない（漏れない）。
   */
  readonly #activeContexts = new Set<BrowserContext>();
  /**
   * factory が自分で始めた、Context の閉じる処理（`#beginFactoryClose`）。Worker の自己検査（Shared Worker は DEF-044、Service Worker は
   * DEF-049）と、Passive の Context の出口の中継の失敗（DEF-085）が始める。持ち主の閉じる処理（`closePassiveContext`）は、これに合流する。
   */
  readonly #factoryInitiatedCloses = new WeakMap<BrowserContext, Promise<void>>();
  /**
   * Context ごとの出口の中継（DEF-085。Interaction の Context の中継も含む）。Guard が Context を閉じる直前に凍結し（Guard の取り付けの指定の
   * `egressFreeze`）、Context が閉じたら閉じる（`close` の事象と `closePassiveContext`）。
   */
  readonly #contextEgress = new WeakMap<BrowserContext, EgressProxy>();
  /** BN-R0 fix round 1（I-1）: Passive の Context の中継ごとの、Guard が通した読み取りの写し（`EgressReadAdmissions`）。 */
  readonly #egressReadAdmissions = new WeakMap<EgressProxy, EgressReadAdmissions>();
  /**
   * DEF-208-1（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.1 の設計者の判断 (b)）: Passive の Context の中継ごとの、Guard が凍結の段で通した
   * 読み取りの写し（同じ部品 `EgressReadAdmissions`。中継は、凍結の後には、この写しに当たる読み取りだけを通す）。
   */
  readonly #egressFrozenReadAdmissions = new WeakMap<EgressProxy, EgressReadAdmissions>();
  /** DEF-233: Guard が凍結の段で通したサイトの token の更新の写し（中継は、凍結の後には、この写しに当たる `POST` だけを 1 回ずつ通す）。 */
  readonly #egressFrozenTokenRefreshAdmissions = new WeakMap<EgressProxy, EgressFrozenSendAdmissions>();
  /** DEF-233 fix round 1: Context ごとの、受けた token の更新の応答の文字列の値と、読み途中の本文（`#observeTokenRefreshResponses`）。 */
  readonly #tokenRefreshResponses = new WeakMap<BrowserContext, TokenRefreshResponseRecord>();
  /**
   * fix round 3（SREV-233 の確かめ直しの N-1・N-2）: この Run の中で、凍結の前に（どの Context でも）Guard が通し、応答で成功の鍵が実際に更新されたと確かめた更新から
   * 覚えたもの（凍結の段で通す更新の本文の形・header・必須の query の値）。
   */
  readonly #learnedRefresh: LearnedTokenRefresh = {
    query: new Map(), poisonedQuery: new Set(), headers: new Map(), poisonedHeaders: new Set(), bodyShape: null, bodyConflict: false, verified: false,
  };
  /** fix round 3（N-1）: 認証つきの Context に渡した状態（凍結の段で通す更新の、今の鍵の値の比べの相手。ページが書いた状態は使わない）。 */
  readonly #givenAuthenticatedStates = new WeakMap<BrowserContext, AuthenticatedStorageState>();
  /** OP-N（N2）: 書き込みの段の中継の、Guard が通した読み取りでない要求の写し（送信の扱いの口のある書き込みの段の Context だけ）。 */
  readonly #egressSendAdmissions = new WeakMap<EgressProxy, EgressSendAdmissions>();
  /** LU-SFIX2-B（Minor-2）: 書き込みの段（API とフォーム）の中継の、Guard が通した承認の送信先への書き込みの写し（書き込みの段の Context だけ）。 */
  readonly #egressWriteEndpointAdmissions = new WeakMap<EgressProxy, EgressSendAdmissions>();
  /**
   * T44b（P1-2）・SD-2: ページの読み取りでない送信を通す Context（`#createGuardedContext` が、Guard の取り付けの後に決める）。持ち主が閉じるときに、凍結して
   * いなければ、ページを離れてから `AUDIT_SEND_CLOSE_SETTLE_MS` だけ待つ。
   */
  readonly #pageLeaveContexts = new WeakSet<BrowserContext>();
  /**
   * Worker の自己検査の Browser の CDP の session（DEF-044、DEF-049）。constructor で開き始め、Context を作る前に完了を待つ
   * （`#createGuardedContext`）。開けなければ、その例外のまま reject する（Context を作らない）。
   */
  readonly #workerWatch: Promise<CDPSession>;
  /** `close()` を呼んだか。呼んだ後は、Context を作らない（自己検査のない Context を作らないため）。 */
  #closed = false;
  readonly #ownedPages = new WeakMap<Page, BrowserContext>();
  /**
   * Context ごとの、factory が作った page（DEF-038）。Context の所有を解放するとき（Guard が Context を閉じたとき）に、その Context の
   * page を `#ownedPages` から外すために持つ。page は個別に閉じず、Context と一緒に閉じるためである。
   */
  readonly #contextPages = new WeakMap<BrowserContext, Set<Page>>();
  /** 要求の実績を数える部品。なければ、要求の終わりの事象を受け取らない（サイトへの負荷の制御の設計書 4.5）。 */
  readonly #loadMeter: LoadMeter | null;
  /** 読み込みの間隔を守る部品（DEF-100 fix。`BrowserContextFactoryOptions.navigationPacer`）。なければ `null`。 */
  readonly #navigationPacer: Pick<NavigationPacer, 'recordDocumentRequestSent'> | null;
  /** DEF-245: Guard が閉じるときの作業の待ちの見張りの反応なしの長さ（`BrowserContextFactoryOptions.progressWatchQuietLimitMs`）。なければ本番の長さ。 */
  readonly #progressWatchQuietLimitMs: number | undefined;
  /** SLIM-2（X5b）・RB-2: 閉じる前に待つ時間（差し込まれた一式の `beforeClose`。なければ本番の `AUDIT_SEND_CLOSE_SETTLE_MS`）。 */
  readonly #auditSendCloseSettleMs: number;
  /** Run 全体のリソースのキャッシュ。なければ、応答を受け取らず、届け方も変えない（サイトへの負荷の制御の設計書 4.6、4.7）。 */
  readonly #resourceCache: ResourceCache | null;
  /** Interaction の Context の出口の中継の上流の方針（既定は production の方針）。 */
  readonly #egressUpstreamPolicy: EgressUpstreamPolicy;
  /**
   * キャッシュから返した要求の印（設計書 4.6）。届け方の部品が、キャッシュから返す前に付ける。印の付いた要求の応答は、
   * キャッシュに入れ直さない（`ResourceCache.store` の `servedFromRunCache`）。
   */
  readonly #servedFromRunCache = new WeakSet<Request>();
  /** 認証つきの Run の指定（T25c）。なければ `null`（公開監査。今のまま）。 */
  readonly #authentication: Pick<
    AuthenticatedContextOptions,
    'filterState' | 'auditExclusions' | 'auditStage' | 'sessionKeyPresent' | 'sessionKeyName' | 'approvedTestOrigins'
  > | null;
  /** T35b: 承認したサービスの Origin への要求の上限の部品（`BrowserContextFactoryOptions.serviceRequestBudget`）。なければ `null`。 */
  readonly #serviceRequestBudget: Pick<ServiceRequestBudget, 'tryConsume'> | null;
  /** T35b: スクリプトで送るログインの監査の段の記録（`BrowserContextFactoryOptions.auditStageMonitor`）。なければ `null`。 */
  readonly #auditStageMonitor: AuditStageMonitor | null;
  /** T35c: 承認したサービスの Origin からの 401 の応答の知らせ（`BrowserContextFactoryOptions.onServiceUnauthorizedResponse`）。なければ `null`。 */
  readonly #onServiceUnauthorizedResponse: (() => void) | null;
  /** T35c: ログインの状態の鍵がなくなったことの知らせ（`BrowserContextFactoryOptions.onSessionKeyLost`）。なければ `null`。 */
  readonly #onSessionKeyLost: (() => void) | null;
  /** AS-a: 監査の段の送信の扱いの指定（`BrowserContextFactoryOptions.auditSend` の写し）。なければ `null`（読み取りだけ）。 */
  readonly #auditSend: GuardAuditSend | null;
  /** OP-REV3（C-1）: 書き込みの段の Context だけに渡す、監査の段の送信の扱いの指定の写し。なければ `null`。 */
  readonly #writeStageAuditSend: GuardAuditSend | null;
  /** OP-Q（Q1）: 書き込みのジョブの Passive の Context に渡す、監査の段の送信の扱いの指定の写し（書き込みの作業の印つき）。なければ `null`。 */
  readonly #writeJobPassiveAuditSend: GuardAuditSend | null;
  /**
   * DEF-193（設計書 `2026-11-04-beaksight-login-session-design.md` 3.2）: 自動ログインの段の指定の印を付けるか（設定の監査の段の送信の扱いが `PASS_EXCEPT_DELETE`
   * のときだけ真）。`createLoginStageContext` が、資格情報の部品のあるスクリプトで送るログインの段（手動の段でない）に付ける。
   */
  readonly #automatedLoginPassThrough: boolean;
  /**
   * 受け継ぐ認証済みの状態と、その世代（T25c。Task 25 の設計書 4.3 の 2026-10-10 の Blocker の行）。Run の中で 1 つだけ持ち、Context を作る
   * とき（生きている、より後にサイトの応答を受けた Context から読む）と、閉じるとき（SFIX-1104 の I-1: サイトの応答を最後に受けた Context の状態。同じなら
   * 最後に閉じた方）に更新する。認証の指定がなければ `null`。
   */
  #authenticatedState: GenerationalAuthenticatedState | null;
  /** 認証の指定のある factory が作った Context のうち、まだ所有している（閉じていない）ものの世代（作った順に 1 から振る）。 */
  readonly #authenticatedGenerations = new Map<BrowserContext, number>();
  /** 最後に振った世代。 */
  #lastAuthenticatedGeneration = INITIAL_AUTHENTICATED_STATE_GENERATION;
  /**
   * SFIX-1104（SREV-1104 の I-1）: Context ごとの、サイトの応答（許可 Origin と承認したサービスの Origin から。Run のキャッシュから返したものは除く）を最後に
   * 受けた順番（factory の中で 1 から振る。`#observeResponses`）。受け継ぐ状態を、応答を最後に受けた Context の状態にするために使う（時刻ではなく順番で比べる）。
   */
  readonly #lastSiteResponses = new WeakMap<BrowserContext, number>();
  /** SFIX-1104 の I-1: 最後に振った、サイトの応答の順番。 */
  #lastSiteResponseSequence = NO_SITE_RESPONSE_SEQUENCE;
  /** 状態を取り出せなかった回数（Context がすでに閉じた、期限切れ、絞り込みの失敗など。値は記録しない）。 */
  #authenticatedStateReadFailures = 0;

  constructor(
    browser: Browser,
    config: AuditConfig,
    ledgerFactory: SafetyLedgerFactory,
    options: BrowserContextFactoryOptions = {},
  ) {
    if (typeof ledgerFactory !== 'function') {
      throw new Error('A Safety Ledger factory dependency is required');
    }
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('BrowserContextFactory options must be an object');
    }
    const {
      loadMeter, resourceCache, egressUpstreamPolicy, authentication, writeSubmissionCertificates, navigationPacer, progressWatchQuietLimitMs, serviceRequestBudget, auditStageMonitor,
      observationWindows, onServiceUnauthorizedResponse, onSessionKeyLost, auditSend, writeStageAuditSend, writeJobPassiveAuditSend, writeJob, pageAuditRun,
      submissionProbeRun,
    } = options;
    if (writeJob !== undefined && writeJob !== true) {
      throw new TypeError('BrowserContextFactory write job mark must be true or omitted');
    }
    if (pageAuditRun !== undefined && pageAuditRun !== true) {
      throw new TypeError('BrowserContextFactory page audit run mark must be true or omitted');
    }
    if ((submissionProbeRun !== undefined && submissionProbeRun !== true) || (submissionProbeRun === true && pageAuditRun === true)) {
      throw new TypeError('BrowserContextFactory submission probe run mark must be true or omitted, and not with the page audit run mark');
    }
    // AS-a: 監査の段の送信の扱いの指定は、Guard と同じ確かめ（`isGuardAuditSend`）で受ける。OP-REV3（C-1）: 書き込みの段だけの指定も同じ。
    if ((auditSend !== undefined && !isGuardAuditSend(auditSend)) || (writeStageAuditSend !== undefined && !isGuardAuditSend(writeStageAuditSend))) {
      throw new TypeError('BrowserContextFactory audit send policy is malformed');
    }
    // OP-Q（Q1）: 書き込みのジョブの Passive の Context の指定は、同じ確かめに加えて、書き込みの作業の印を必ず持ち、監査の段の指定（`auditSend`）とは一緒に受けない。
    // 監査の段の指定は、書き込みの作業の印を持たない（印は、この口だけが持つ）。
    if (writeJobPassiveAuditSend !== undefined
      && (!isGuardAuditSend(writeJobPassiveAuditSend) || writeJobPassiveAuditSend.writeJobEndpoint === undefined || auditSend !== undefined)) {
      throw new TypeError('BrowserContextFactory write job audit send policy must have the write endpoint and cannot be combined with the audit send policy');
    }
    if (auditSend?.writeJobEndpoint !== undefined) {
      throw new TypeError('BrowserContextFactory audit send policy cannot have the write job endpoint');
    }
    if (onServiceUnauthorizedResponse !== undefined && typeof onServiceUnauthorizedResponse !== 'function') {
      throw new TypeError('BrowserContextFactory service unauthorized response observer must be a function');
    }
    if (onSessionKeyLost !== undefined && typeof onSessionKeyLost !== 'function') {
      throw new TypeError('BrowserContextFactory session key lost observer must be a function');
    }
    if (serviceRequestBudget !== undefined && (!isRecord(serviceRequestBudget) || typeof serviceRequestBudget.tryConsume !== 'function')) {
      throw new TypeError('BrowserContextFactory service request budget must count a request');
    }
    if (auditStageMonitor !== undefined && !(auditStageMonitor instanceof AuditStageMonitor)) {
      throw new TypeError('BrowserContextFactory audit stage monitor must be an AuditStageMonitor');
    }
    if (loadMeter !== undefined && !recordsRequestEnds(loadMeter)) {
      throw new TypeError('BrowserContextFactory load meter must record request end events');
    }
    if (navigationPacer !== undefined && (!isRecord(navigationPacer) || typeof navigationPacer.recordDocumentRequestSent !== 'function')) {
      throw new TypeError('BrowserContextFactory navigation pacer must record the time a document request was sent');
    }
    if (progressWatchQuietLimitMs !== undefined && (!Number.isSafeInteger(progressWatchQuietLimitMs) || progressWatchQuietLimitMs <= 0)) {
      throw new TypeError('BrowserContextFactory progress watch quiet limit must be a positive safe integer');
    }
    if (resourceCache !== undefined && !(resourceCache instanceof ResourceCache)) {
      throw new TypeError('BrowserContextFactory resource cache must be a ResourceCache');
    }
    if (egressUpstreamPolicy !== undefined && typeof egressUpstreamPolicy !== 'function') {
      throw new TypeError('BrowserContextFactory egress upstream policy must be a function');
    }
    if (writeSubmissionCertificates !== undefined
      && (!Array.isArray(writeSubmissionCertificates) || !writeSubmissionCertificates.every((certificate) => typeof certificate === 'string'))) {
      throw new TypeError('BrowserContextFactory write submission certificates must be strings');
    }
    if (authentication !== undefined && !isAuthenticatedContextOptions(authentication)) {
      throw new TypeError('BrowserContextFactory authentication must have an initial state, a filter function and audit exclusions');
    }
    // 最初の状態は、持つ前に絞る。絞れなければ、factory を作らない（fail-closed。誤りの文に値を入れない）。
    let initialState: AuthenticatedStorageState | null = null;
    if (authentication !== undefined) {
      try {
        initialState = authenticatedStateCopy(authentication.filterState(authentication.initialState));
      } catch {
        throw new TypeError('BrowserContextFactory authentication initial state could not be filtered');
      }
    }
    this.#browser = browser;
    this.#locale = config.browser.locale;
    this.#timezone = config.browser.timezone;
    this.#allowedOrigins = canonicalPassiveAllowedOrigins(new Set(config.site.allowedOrigins));
    this.#ledgerFactory = ledgerFactory;
    this.#loadMeter = loadMeter ?? null;
    this.#navigationPacer = navigationPacer ?? null;
    this.#progressWatchQuietLimitMs = progressWatchQuietLimitMs;
    this.#auditSendCloseSettleMs = observationWindowsOrProduction(observationWindows).beforeClose.auditSendCloseSettleMs;
    this.#resourceCache = resourceCache ?? null;
    this.#egressUpstreamPolicy = egressUpstreamPolicy ?? ALLOW_ALL_EGRESS_UPSTREAMS;
    this.#writeSubmissionCertificates = writeSubmissionCertificates === undefined ? undefined : Object.freeze([...writeSubmissionCertificates]);
    this.#writeJob = writeJob === true;
    this.#pageAuditRun = pageAuditRun === true;
    this.#submissionProbeRun = submissionProbeRun === true;
    this.#authentication = authentication === undefined
      ? null
      : Object.freeze({
        filterState: authentication.filterState,
        auditExclusions: authentication.auditExclusions,
        // T35b: スクリプトで送るログインの監査の段の口（ある場合だけ。Guard と中継が写しを取る）。
        ...(authentication.auditStage === undefined ? {} : { auditStage: authentication.auditStage }),
        // T35c: ログインの状態の鍵があるかの判定（ある場合だけ）。
        ...(authentication.sessionKeyPresent === undefined ? {} : { sessionKeyPresent: authentication.sessionKeyPresent }),
        // DEF-233: 成功の鍵の名前の判定（ある場合だけ）。
        ...(authentication.sessionKeyName === undefined ? {} : { sessionKeyName: authentication.sessionKeyName }),
        // DEF-220: 承認したテストの Origin（ある場合だけ。写しを凍結する）。
        ...(authentication.approvedTestOrigins === undefined ? {} : { approvedTestOrigins: Object.freeze([...authentication.approvedTestOrigins]) }),
      });
    this.#serviceRequestBudget = serviceRequestBudget ?? null;
    this.#auditStageMonitor = auditStageMonitor ?? null;
    this.#onServiceUnauthorizedResponse = onServiceUnauthorizedResponse ?? null;
    this.#onSessionKeyLost = onSessionKeyLost ?? null;
    this.#auditSend = auditSend === undefined ? null : guardAuditSendCopyOf(auditSend);
    this.#writeStageAuditSend = writeStageAuditSend === undefined ? null : guardAuditSendCopyOf(writeStageAuditSend);
    this.#writeJobPassiveAuditSend = writeJobPassiveAuditSend === undefined ? null : guardAuditSendCopyOf(writeJobPassiveAuditSend);
    // RB-4b: 中継が待たずに通すかを分ける、監査するサイトの Origin。
    this.#egressTunnelAdmission = egressTunnelAdmissionOf([
      ...this.#allowedOrigins,
      ...(this.#authentication?.auditStage?.approvedServiceOrigins ?? []),
      ...(this.#authentication?.approvedTestOrigins ?? []),
      ...(this.#auditSend?.approvedServiceOrigins ?? []),
      ...(this.#writeStageAuditSend?.approvedServiceOrigins ?? []),
      ...(this.#writeJobPassiveAuditSend?.approvedServiceOrigins ?? []),
    ]);
    this.#automatedLoginPassThrough = auditSendOptionsOf(config, []).auditSend !== undefined;
    this.#authenticatedState = initialState === null
      ? null
      : Object.freeze({ state: initialState, generation: INITIAL_AUTHENTICATED_STATE_GENERATION, responseSequence: NO_SITE_RESPONSE_SEQUENCE });
    // 引数の検査の後に開き始める（引数の誤りで投げる場合に、session を残さない）。失敗は、Context の作成で投げる。
    this.#workerWatch = this.#watchWorkers();
    this.#workerWatch.catch(() => undefined);
  }

  /**
   * Worker の自己検査を始める（設計書 `2026-10-08-beaksight-def-044-046-review-fixes-design.md` 1.2、5 と変更履歴の NP6 の Blocker の行）。
   * Browser の CDP の session で、次の 2 つを見張る。どちらも、listener を付けてから命令を送る。
   * - Shared Worker（DEF-044）: Chromium の起動の引数（`CHROMIUM_SHARED_WORKERS_DISABLED_ARGS`）で無効にしている。`Target.setDiscoverTargets`
   *   の `Target.targetCreated` で `shared_worker` の target を見たら、引数が効いていないとみなす。
   * - Service Worker（DEF-049）: Guard の初期化のスクリプト（`SERVICE_WORKER_REGISTRATION_BLOCK_INIT_SCRIPT`）で登録の入口を塞いでいる。
   *   `Target.setAutoAttach`（`SERVICE_WORKER_AUTO_ATTACH`）の `Target.attachedToTarget` で `service_worker` の target を見たら、入口が
   *   塞がっていないとみなす。target は、Service Worker の script の GET より前に付く（NP6 の実験）。
   * どちらも `#onWorkerObserved` で、所有するすべての Context を閉じる。session を開けない、または見張りを始められない場合は、その例外の
   * まま reject する（見張りを始められなかった session は、外す）。
   */
  async #watchWorkers(): Promise<CDPSession> {
    const session = await this.#browser.newBrowserCDPSession();
    try {
      session.on('Target.targetCreated', ({ targetInfo }): void => {
        if (targetInfo.type === SHARED_WORKER_TARGET_TYPE) {
          this.#onWorkerObserved(SHARED_WORKER_OBSERVED);
        }
      });
      session.on('Target.attachedToTarget', ({ targetInfo }): void => {
        if (targetInfo.type === SERVICE_WORKER_TARGET_TYPE) {
          this.#onWorkerObserved(SERVICE_WORKER_OBSERVED);
        }
      });
      await session.send('Target.setDiscoverTargets', { discover: true });
      await session.send('Target.setAutoAttach', SERVICE_WORKER_AUTO_ATTACH);
    } catch (error) {
      await session.detach().catch(() => undefined);
      throw error;
    }
    return session;
  }

  /**
   * 無効にしたはずの Worker の target を見た（DEF-044 の Shared Worker、DEF-049 の Service Worker）。その時点で factory が所有するすべての
   * Context の Ledger に、違反 `violation` を記録し、その Context を直ちに閉じる（fail-closed。Run は `ABORTED_BY_SAFETY` になる）。target と
   * Context の対応づけ（`browserContextId`）はしない（同時に動く Context は 1 つなので、すべてを閉じる側に倒す）。閉じる処理は持ち主の閉じる
   * 処理と同じ（`closePassiveContext`）で、持ち主の閉じる処理は、これに合流する。すでに閉じ始めた Context には、違反だけを記録する。
   * 閉じる処理の失敗は、ここでは投げない（違反は記録済み）。
   */
  #onWorkerObserved(violation: WorkerSelfCheckViolation): void {
    for (const context of [...this.#activeContexts]) {
      this.getSafetyLedger(context).recordInvariantViolation({ code: violation.code, message: violation.message });
      this.#beginFactoryClose(context);
    }
  }

  /**
   * factory が自分で Context を閉じ始める（Worker の自己検査の DEF-044・DEF-049 と、Passive の Context の出口の中継の失敗の DEF-085）。すでに
   * 閉じ始めたか、所有していない Context には、何もしない。閉じる処理は持ち主の閉じる処理と同じ（`closePassiveContext`）で、持ち主の閉じる処理は、
   * これに合流する（`#factoryInitiatedCloses`）。閉じる処理の失敗は、ここでは投げない（呼び出し側が違反を記録する）。
   */
  #beginFactoryClose(context: BrowserContext): void {
    if (this.#factoryInitiatedCloses.has(context) || !this.#activeContexts.has(context)) {
      return;
    }
    // T44b: factory が自分で閉じる処理は、送信の扱いの待ち（`AUDIT_SEND_CLOSE_SETTLE_MS`）をしない（fail-closed の閉じ方を遅らせない）。
    const closing = this.#closeContextNow(context, false);
    closing.catch(() => undefined);
    this.#factoryInitiatedCloses.set(context, closing);
  }

  /**
   * Worker の自己検査の Browser の CDP の session を外す（DEF-044、DEF-049）。何度呼んでもよく、失敗は投げない（閉じた Browser など）。
   * 呼んだ後は、Context を作らない。production の呼び出し側（Run の終わり）は、これを呼ばない。`browser.close()` で session も終わる
   * ためである。テストは、Browser を閉じずに factory を捨てる場合の後片付けで呼ぶ。
   */
  async close(): Promise<void> {
    this.#closed = true;
    try {
      const session = await this.#workerWatch;
      await session.detach();
    } catch {
      // 開けなかった session、外し済みの session、閉じた Browser の session は、外すものがない。
    }
  }

  /**
   * Guard の付いた Passive Context を作る。`role` は Context の役割（サイトへの負荷の制御の設計書 4.7。既定は `PRIMARY`）。
   * Run 全体のキャッシュがあれば、役割によらず、Guard に、その役割の届け方の部品を渡し、応答の事実をキャッシュに渡す。届け方は、
   * 役割ごとに `decideResourceDelivery` が決める。
   * - `PRIMARY`: Passive の Desktop と Mobile、robots.txt と sitemap.xml、PREFLIGHT、環境の記録。キャッシュにあるものはキャッシュから
   *   返し、キャッシュにないものは、許可 Origin の外でもネットワークから取る（DEF-031。設計書 4.10.3）。
   * - `REVISIT`: 幅の走査と Interaction。キャッシュにあるものはキャッシュから返し、許可 Origin の外へは、キャッシュになければ送らない。
   *   T44b（P1-1）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の factory では、幅の走査でも、ページが出す送信と、承認したサービスの Origin への要求
   *   （上限の部品で数える）を送る（`servesServiceOrigin`・`revisitSends`）。
   * キャッシュがなければ、どちらの役割でも、Guard に届け方の部品を渡さない（すべてネットワーク。今のまま）。役割が閉じた一覧
   * （`RESOURCE_DELIVERY_ROLES`）になければ、何も作らずに `TypeError` を投げる。
   * DEF-085: 出口の中継を付ける（`#createPassiveGuardedContext`）。
   */
  async createPassiveContext(viewport: Viewport, role: ResourceDeliveryRole = 'PRIMARY', _options: PassiveContextOptions = {}): Promise<BrowserContext> {
    if (!isResourceDeliveryRole(role)) {
      throw new TypeError('Passive browser Context role must be one of RESOURCE_DELIVERY_ROLES');
    }
    const ledger = this.#issueSafetyLedger();
    // SD-2: 持ち主が閉じるときにページを離れて待つ Context は、Guard の取り付けの後に決める（`#createGuardedContext`。印 `pageAuditLoad` によらない）。
    return this.#createPassiveGuardedContext(ledger, viewport, role);
  }

  /**
   * ログインの段の Context を作る（Task 25 の設計書 4.4 と、変更履歴の 2026-10-10 の T25d の Blocker の行の (3)。T25d）。Passive の Context と
   * 同じ作り方（`#createGuardedContext`。作成の指定、要求の終わりの事象、Worker の自己検査、Ledger の対応）で作り、Guard の取り付けの指定に、
   * ログインの段の指定（`loginStage`。許した送信先への main frame のナビゲーションの POST を、回数の上限まで許す）だけを加える。
   * - 認証つきの factory（監査の段。`authentication` あり）では作らない（`TypeError`。ログインの段の許可を、監査の段に持ち込まない）。
   * - 指定の形（送信先が 1 件以上の `{ origin, path }` の文字列の組、上限が 0 以上の安全な整数）が正しくなければ、何も作らずに `TypeError`。
   * - T34b（Task 34 の設計書 3.3）: 認証の設定 v3 のスクリプトで送るログイン（`SCRIPT_REQUEST`）では、`loginStage.scriptRequest` に、token の
   *   送信先（`scriptLogin`）、登録したログインに伴う送信（`loginSideRequests`）、承認したサービスの Origin（`approvedServiceOrigins`）を渡す
   *   （このとき送信先 `loginPostEndpoints` は空でよい）。Guard と中継は、それらだけを通す（判定は `classifyPassiveRequest`）。監査の段の Context
   *   の振る舞いは変えない。
   * - 役割は `PRIMARY`（キャッシュを渡した factory では、届け方の部品も渡す。ワーカーのログインの段の factory には、キャッシュを渡さない）。
   * page は `createPassivePage`、閉じるのは `closePassiveContext`（Passive の Context と同じ）。
   * DEF-085: 出口の中継を付ける（`#createPassiveGuardedContext`。中継の要求の方針は、ログインの段の送信先への POST も通す）。
   */
  async createLoginStageContext(viewport: Viewport, loginStage: GuardLoginStage): Promise<BrowserContext> {
    if (this.#authentication !== null) {
      throw new TypeError('An authenticated BrowserContextFactory (the audit stage) cannot create a login stage Context');
    }
    if (!isGuardLoginStage(loginStage)) {
      throw new TypeError('Login stage Context requires login POST endpoints ({ origin, path }) or a script login, and a non-negative safe integer limit');
    }
    const ledger = this.#issueSafetyLedger();
    return this.#createPassiveGuardedContext(ledger, viewport, 'PRIMARY', { loginStage: this.#loginStageWithAutomatedMark(loginStage) });
  }

  /**
   * DEF-193（設計書 3.2 の 1・5）: ログインの段の指定に、自動ログインの段の印（`automatedPassThrough`）を付けた写し。印の owner は factory（呼ぶ側が渡した印は捨て、
   * 設定の監査の段の送信の扱いから決め直す）。付けるのは、扱いが `PASS_EXCEPT_DELETE` で、スクリプトで送るログインの段（`scriptRequest`）に資格情報の部品
   * （`credentialGuard`）があり、手動の段の印がないときだけ。部品（monitor・credentialGuard）は、そのまま渡す（写しにしない）。
   */
  #loginStageWithAutomatedMark(loginStage: GuardLoginStage): GuardLoginStage {
    const { automatedPassThrough: _given, ...rest } = loginStage;
    return this.#automatedLoginPassThrough && rest.scriptRequest !== undefined && rest.credentialGuard !== undefined && rest.manualPassThrough !== true
      ? { ...rest, automatedPassThrough: true }
      : rest;
  }

  /**
   * 書き込みの段の Context を作る（T30b。Task 30 の設計書 3 章の「書き込みの段」、4 章）。認証つきの Run の Context と同じ作り方
   * （`#createPassiveGuardedContext`。ログインの後の状態、監査の段の除外、出口の中継、Worker の自己検査、Ledger の対応）で作り、Guard の取り付けの
   * 指定に、書き込みの段の指定（`writeStage`。承認の要求の形の POST を、送る中身の照合が `ALLOW` のときに 1 回だけ許す）を加える。
   * - 認証のない factory では作らない（`TypeError`。書き込みは、ログインの後の状態を持つ Run だけが送る）。
   * - 指定の形が正しくない、部品（`WriteStageMonitor`）がすでに別の Guard に付いている、は何も作らずに `TypeError`（`guardWriteStageCopyOf`。受けた写しを Guard と中継に渡す）。
   * - 中継の要求の方針には、承認の要求の形の送信先を渡す（http の二重の守り。https の CONNECT の中身は見えないので、強制は Guard）。
   * - 役割は `PRIMARY`。page は `createPassivePage`、閉じるのは `closePassiveContext`（Passive の Context と同じ）。
   * - T39b（Task 39 の設計書 3.1）: 送り方は指定の `transport` で受ける（省略は `FORM`）。API のシナリオ（`transport: 'API'`）の書き込みの段の Context には、
   *   認証の指定の監査の段の口（承認したサービスの Origin への読み取りと、登録した読み取りの手続きの呼び出し。今の監査の段と同じ判定と上限）も渡す
   *   （SPA の画面を描くため。送信の窓の中のサービスの Origin への読み取りも、上限の中で通す。ユーザーの判断）。FORM の書き込みの段は今のまま（サービスの
   *   Origin へ送らない）。
   * 呼ぶのは、ワーカーの書き込みの流れだけ（Gate `write-stage-boundary` の (c)）。
   */
  async createWriteStageContext(viewport: Viewport, writeStage: GuardWriteStage): Promise<BrowserContext> {
    if (this.#authentication === null) {
      throw new TypeError('Only an authenticated BrowserContextFactory can create a write stage Context');
    }
    // LU-SFIX1（LU-SREV1 の Minor-5）: Guard の取り付けと同じ確かめで写した 1 つの写しを、Guard と中継（送信先・予算の path）の両方に渡す（呼び手の生の
    // 期待から中継の path を作らない）。
    const accepted = guardWriteStageCopyOf(writeStage);
    if (accepted === null) {
      throw new TypeError('Write stage Context requires an expectation and a WriteStageMonitor that is not attached to another Guard');
    }
    const ledger = this.#issueSafetyLedger();
    return this.#createPassiveGuardedContext(ledger, viewport, 'PRIMARY', { writeStage: accepted });
  }

  /**
   * 出口の中継を付けた、Passive とログインの段の Context を作る（DEF-085。Task 27 の設計書 11 章の 2026-10-12 の行の (2)）。
   * - 中継（`startEgressProxy`。127.0.0.1 だけで待つ）を Context より先に作る。作れなければ、Context を作らずに、その例外をそのまま投げる
   *   （fail-closed。Run の失敗になる）。
   * - 中継の方針: 上流は factory の方針（`egressUpstreamPolicy`）。要求（絶対形の HTTP）は、その Context の Guard の許可を中継から見た範囲
   *   （`passiveEgressRequestPolicy`）。Guard が許すものは拒まず、Guard より広くは通さない。CONNECT の中身は見えないので、上流の方針だけを当てる。
   * - 中継が拒んだ要求は、その Context の Ledger の `blockedInteractionRequests` に写す（`egressRejectionReason`。閉じる直前の凍結の後の拒否は
   *   記録しない。fix round 3）。
   * - 中継の待ち受けの後の失敗（`onError`）は、違反 `EGRESS_PROXY_FAILED` を記録して、factory が Context を閉じ始める（`#beginFactoryClose`）。
   * - Guard には、閉じる直前に中継を凍結する口を渡す（`#createGuardedContext`）。中継は Context が閉じたら閉じる。
   * - 上流の失敗は、応答を作らずにそのまま伝える（`upstreamFailureMode: 'PASS_THROUGH'`。fix round 1）。Interaction の Context の中継は、
   *   今のまま（`502` を返す）。
   * - Context の作成（`newContext` まで）に失敗したら、中継を閉じてから投げる。Guard の取り付けに失敗した場合（`ContextConstructionError`）は、
   *   Context が残りうるので、中継は Context と一緒に閉じる（Context の `close` の事象と `closePassiveContext`）。
   */
  async #createPassiveGuardedContext(
    ledger: SafetyLedger,
    viewport: Viewport,
    role: ResourceDeliveryRole,
    stage: SubmissionStageOptions = {},
  ): Promise<BrowserContext> {
    let context: BrowserContext | undefined;
    const freeze: EgressFreezeRecord = { frozenByInteraction: false };
    // AS-a: 監査の段の送信の扱いは、Passive の Context（ログインの段と書き込みの段でない）だけに渡す（Guard と中継の両方）。OP-N（設計書 4.1.7 の N2）・OP-REV3（C-1）:
    // 書き込みの段の Context には、書き込みの段だけの指定（`writeStageAuditSend`）を渡す（Guard の判定は、書き込みの段の決まりを加えた要求の判定の owner。中継は、
    // Guard が通した要求の写しだけを通す）。
    // OP-Q（設計書 4.1.8 の Q1）: 書き込みのジョブの Passive の Context（送る前の確かめと照合の READ）には、書き込みの作業の印つきの指定（`writeJobPassiveAuditSend`）を
    // 渡す（`auditSend` とは一緒に受けない）。
    const auditSend = stage.loginStage !== undefined
      ? undefined
      : stage.writeStage !== undefined
        ? this.#writeStageAuditSend ?? undefined
        : this.#auditSend ?? this.#writeJobPassiveAuditSend ?? undefined;
    // BN-R0 fix round 1（I-1）: この Context の Guard が通した読み取りの写し（中継の要求の方針が使う。Guard の口が知らせる）。
    const readAdmissions = new EgressReadAdmissions();
    // DEF-208-1: この Context の Guard が凍結の段で通した読み取りの写し（中継の凍結の後の受け入れが使う）。
    const frozenReadAdmissions = new EgressReadAdmissions();
    // DEF-233: この Context の Guard が凍結の段で通したサイトの token の更新の写し（中継の凍結の後の受け入れが 1 回ずつ使う）。
    // SREV-SAFE の M-2: 登録した読み取りの手続きの呼び出しも、この写しに当たる（同じ method と URL の同時の呼び出しも、Guard が通した数だけ通す）。
    const frozenTokenRefreshAdmissions = new EgressFrozenSendAdmissions();
    // T39b: API の書き込みの段も、監査の段の口を渡す（承認したサービスの Origin への読み取り）。
    const egressAuditStage = stage.writeStage === undefined || isGuardApiWriteStage(stage.writeStage) ? this.#authentication?.auditStage : undefined;
    // OP-N（N2）: 書き込みの段で送信の扱いの口があるときだけ、Guard が通した読み取りでない要求の写しを持つ。OP-REV3（I-2）: 送信の窓を開いたら（値を入れ始めたら）、
    // 写しを捨て、以後は受けない。
    const writeMonitor = stage.writeStage?.monitor;
    // DEF-193（設計書 3.2 の 5）: 自動ログインの段の印のあるログインの段でも、Guard が通した読み取りでない要求の写しを持つ（中継は、写しに当たる要求だけを、
    // 自動ログインの段の通し方で通す。書き込みの段と同じ部品。別の比べ方を作らない）。
    // L12a: 押した後（送信の段を開いた後）も受ける（Guard が押した後の扱いで通した要求の写し）。
    const sendAdmissions = writeMonitor !== undefined && auditSend !== undefined
      ? new EgressSendAdmissions(() => !writeMonitor.hasSubmissionWindowOpened() || writeMonitor.isSubmissionPhaseOpen())
      : stage.loginStage?.automatedPassThrough !== undefined
        ? new EgressSendAdmissions(() => true)
        : null;
    // LU-SFIX2-B（LU-SREV2 の Minor-2）: 書き込みの段（API とフォーム）では、Guard が通した、承認の送信先への書き込みの写しを持つ（中継は、この写しに
    // 当たる要求だけを送り手の 1 回として通す）。写しを持つのは、その送信先への要求だけ（形は `writeStageEndpointRequestOf`）。
    const writeEndpointAdmissions = stage.writeStage === undefined
      ? null
      : new EgressSendAdmissions(() => true, writeStageEndpointRequestOf(stage.writeStage));
    const egress = await startEgressProxy({
      upstreamPolicy: this.#egressUpstreamPolicy,
      requestPolicy: passiveEgressRequestPolicy(
        this.#allowedOrigins,
        stage,
        this.#authentication?.auditExclusions,
        egressAuditStage,
        role,
        auditSend,
        readAdmissions,
        sendAdmissions,
        writeEndpointAdmissions,
      ),
      // DEF-099 fix: 書き込みの段の Context では、承認の送信先への POST を 1 回だけ通し、2 回目は止めて記録する（http の重ねの守り。送り手の
      // 1 回だけが通るはず。https はトンネルなので数えない）。T39c: API の書き込みの段は、承認した API の Origin への `POST`・`PATCH` を 1 回。
      // L12a（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4 の S11）: 書き込みの段の、承認の送信先への書き込みの回数の上限（`requestBudget`）は渡さない。
      // 承認の送信先への書き込みは、Guard が通した写し（`writeEndpointAdmissions`。1 回ずつ使う）に当たるものだけを通す（Guard を迂回した要求は今どおり拒む）。
      // 承認した送信の応答の後に、ページの手続きが同じ送信先へ出す送信（下書き→確定など）を、Guard が通せば届ける。
      // DEF-085 fix round 1: 上流の失敗を、応答を作らずにそのまま伝える（接続できない相手と、本文の途中の切断の結果を、中継なしと同じに保つ）。
      upstreamFailureMode: 'PASS_THROUGH',
      // DEF-125: サイトの宛先への CONNECT は、この Context の Guard が通した要求の宛先だけを通す（Guard が `admitTunnelDestinationOf` で知らせる）。
      // RB-4b: サイトの外の宛先は待たずに通す。
      tunnelAdmission: this.#egressTunnelAdmission,
      // DEF-208-1: 凍結の後は、Guard が凍結の段で通した読み取りの写しに当たる読み取りだけを通す（ほかの要求と CONNECT は今のとおり拒む）。
      // 写しは、照らし合わせたら捨てる（1 回だけ使う）。
      frozenReadAdmission: (method: string, url: string): boolean => frozenReadAdmissions.take(method, url),
      // DEF-233: 凍結の後は、Guard が凍結の段で通したサイトの token の更新の写しに当たり、同じ部品の判定を満たす `POST` だけも通す。
      frozenTokenRefreshAdmission: frozenTokenRefreshAdmissionOf(
        egressPolicyOptionsOf(stage, this.#authentication?.auditExclusions, egressAuditStage, role, auditSend),
        frozenTokenRefreshAdmissions,
        () => this.#learnedRefreshQueryValuesOf(),
        // SAFE-2 の 3: 登録した読み取りの手続きの呼び出しの判定に使う許可 Origin。
        this.#allowedOrigins,
      ),
      onRejected: (rejection): void => {
        const event = egressRejectionEvent(rejection, freeze);
        if (event !== null) {
          ledger.recordBlockedInteractionRequest(event);
        }
      },
      onError: (error): void => {
        ledger.recordInvariantViolation({ code: 'EGRESS_PROXY_FAILED', message: safeErrorMessage(error) });
        if (context !== undefined) {
          this.#beginFactoryClose(context);
        }
      },
    });
    // BN-R0 fix round 1（I-1）: Guard の知らせの口（`#createGuardedContext`）が、この中継の読み取りの写しに書く。
    this.#egressReadAdmissions.set(egress, readAdmissions);
    this.#egressFrozenReadAdmissions.set(egress, frozenReadAdmissions);
    this.#egressFrozenTokenRefreshAdmissions.set(egress, frozenTokenRefreshAdmissions);
    if (sendAdmissions !== null) {
      this.#egressSendAdmissions.set(egress, sendAdmissions);
    }
    if (writeEndpointAdmissions !== null) {
      this.#egressWriteEndpointAdmissions.set(egress, writeEndpointAdmissions);
    }
    try {
      context = await this.#createGuardedContext(ledger, viewport, role, egress, freeze, stage, auditSend);
    } catch (error) {
      if (!(error instanceof ContextConstructionError)) {
        await egress.close();
      }
      throw error;
    }
    return context;
  }

  /**
   * Guard の取り付けの指定の、スクリプトで送るログインの監査の段（T35b。Task 35 の設計書 3.2、3.4）。認証の指定に監査の段の口があり、書き込みの段の
   * Context でないときだけ持つ。登録した読み取りの手続きの呼び出しは、最初の読み込み（`PRIMARY`）だけ。T35R-fix（T35R の C-1）: 幅の走査と Interaction
   * の `REVISIT` は、承認したサービスの Origin へ送らない（Guard の口の `readRequestsAllowed` が偽）。上限の部品は、どの役割の Context にも渡す（数える側
   * にも置いて、守りを重ねる）。T35R2-fix（T35R2 の C-1 の (a)）: 監査の段の口があって上限の部品がなければ、数えずに通さず、投げる（呼び出し側は、
   * Context を作る前にこれを呼ぶ。fail-closed）。
   * T39b（Task 39 の設計書 3.1）: API のシナリオの書き込みの段の Context にも渡す（FORM の書き込みの段とログインの段には渡さない）。
   * T44b（Task 44 の設計書 3.1 の P1-1）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の Context（`auditSend` あり。幅の走査の `REVISIT` を含む）は、最初の
   * 読み込みと同じく送る（`servesServiceOrigin`。上限の部品で数える）。
   */
  #guardAuditStageOf(
    role: ResourceDeliveryRole,
    stage: SubmissionStageOptions,
    auditSend: GuardAuditSend | undefined,
  ): { readonly auditStage?: GuardAuditStage } {
    const auditStage = this.#authentication?.auditStage;
    if (auditStage === undefined || (stage.writeStage !== undefined && !isGuardApiWriteStage(stage.writeStage)) || stage.loginStage !== undefined) {
      return {};
    }
    const budget = this.#serviceRequestBudget;
    if (budget === null) {
      throw new Error('BrowserContextFactory requires a service request budget for the audit stage of a script login audit');
    }
    const monitor = this.#auditStageMonitor;
    return {
      auditStage: Object.freeze({
        approvedServiceOrigins: auditStage.approvedServiceOrigins,
        auditReadRequests: auditStage.auditReadRequests,
        scriptLogin: auditStage.scriptLogin,
        readRequestsAllowed: servesServiceOrigin(role, auditSend),
        serviceRequestBudget: budget,
        ...(monitor === null ? {} : { monitor }),
      }),
    };
  }

  /** Context ごとの Safety Ledger を、factory の依存から作る。作れないか、使い回しなら投げる（Context は作らない）。 */
  #issueSafetyLedger(): SafetyLedger {
    const ledger = this.#ledgerFactory();
    if (!(ledger instanceof SafetyLedger)) {
      throw new Error('Safety Ledger factory must create a SafetyLedger');
    }
    if (issuedSafetyLedgers.has(ledger)) {
      throw new Error('Safety Ledger factory reused a ledger; each Context requires isolated history');
    }
    issuedSafetyLedgers.add(ledger);
    return ledger;
  }

  /**
   * Guard の付いた Context を作る（`createPassiveContext`、`createLoginStageContext`、`createInteractionSession` の共通の部分）。
   * `egress` は、その Context の出口の中継（DEF-085 から、すべての Guard の Context に付ける）。Context の作成の指定に `proxy: { server }` を
   * 渡し（Playwright は Context ごとの proxy を `<-loopback>` の bypass と一緒に付けるので、127.0.0.1 への通信も中継を通る）、Guard の取り付けの
   * 指定に、中継を凍結する口（`egressFreeze`。閉じる直前と、凍結の段に入った直後。`freeze` に最初の凍結の理由を残す）を渡す。中継は、Context の `close` の事象で閉じる（何度閉じてもよい）。
   * `stage` は、ログインの段の Context（`createLoginStageContext`。T25d）の Guard のログインの段の指定（`loginStage`）か、書き込みの段の Context
   * （`createWriteStageContext`。T30b）の Guard の書き込みの段の指定（`writeStage`）。どちらか 1 つだけ。
   * `auditSend`（AS-a）は、Passive の Context（`#createPassiveGuardedContext` の、送信の段でない Context）だけが渡す監査の段の送信の扱いの指定。
   * Isolated Interaction Context（`createInteractionSession`）は渡さない。送信の段の指定と一緒なら、何も作らずに `TypeError`（Guard も同じに拒む）。
   */
  async #createGuardedContext(
    ledger: SafetyLedger,
    viewport: Viewport,
    role: ResourceDeliveryRole,
    egress: EgressProxy,
    freeze: EgressFreezeRecord,
    stage: SubmissionStageOptions = {},
    auditSend: GuardAuditSend | undefined = undefined,
    /** BN-0: Context の種類（Isolated Interaction Context は `INTERACTION`。監査の段の除外の当て方が違う）。 */
    contextKind: 'PASSIVE' | 'INTERACTION' = 'PASSIVE',
  ): Promise<BrowserContext> {
    // OP-N（N2）: 書き込みの段の Context にも渡す（ログインの段には渡さない）。
    if (auditSend !== undefined && stage.loginStage !== undefined) {
      throw new TypeError('The audit send policy is only for a Passive Context or a write stage Context');
    }
    // RB-4b（設計者の判断 2026-11-15）: Isolated Interaction Context の押す前の段も、既定（`PASS_EXCEPT_DELETE`）なら通す形にする。Guard に送信の扱いの口だけを
    // 渡す（サービスの Origin へ送るか・届け方の部品・監査の段の口は、今どおり `auditSend` の引数で決める。押した後は、今どおり凍結する）。
    const guardAuditSend = auditSend ?? (contextKind === 'INTERACTION' ? this.#auditSend ?? undefined : undefined);
    // DEF-044、DEF-049: Worker の自己検査が始まってから Context を作る。始められなければ、その例外のまま投げる（Context は作らない）。
    if (this.#closed) {
      throw new Error('BrowserContextFactory was closed');
    }
    await this.#workerWatch;
    if (this.#closed) {
      throw new Error('BrowserContextFactory was closed');
    }
    // T35R2-fix（T35R2 の C-1 の (a)）: 監査の段の Guard の指定は、Context を作る前に組み立てる（上限の部品がなければ、Context を作らずに投げる）。
    const guardAuditStage = this.#guardAuditStageOf(role, stage, auditSend);
    // T25c: 認証の指定があれば、受け継ぐ状態（世代の最も新しいもの）を、メモリのまま `storageState` で渡す（ファイルに書かない）。
    const storageState = await this.#inheritedAuthenticatedState();
    const context = await this.#browser.newContext({
      locale: this.#locale,
      timezoneId: this.#timezone,
      viewport: viewportSnapshot(viewport),
      serviceWorkers: 'block',
      // Passive でも Interaction でも、ページが起こしたダウンロードを保存しない（設計書 4.7）。
      acceptDownloads: false,
      ...(storageState === undefined ? {} : { storageState: playwrightStorageState(storageState) }),
      proxy: { server: egress.server },
    });
    // DEF-085: 中継は Context と一緒に閉じる（Guard の無効化で閉じた場合も）。
    this.#contextEgress.set(context, egress);
    context.on('close', (): void => {
      void egress.close();
    });
    if (this.#authentication !== null) {
      this.#lastAuthenticatedGeneration += 1;
      this.#authenticatedGenerations.set(context, this.#lastAuthenticatedGeneration);
      // DEF-138: 渡した状態の名前を残す（値は残さない）。
      if (storageState !== undefined) {
        this.#contextStateNames.set(context, { given: authenticatedStateNamesOf(storageState), read: null });
        // fix round 2（SREV-233 の C-1 の 2）: 渡した状態（凍結の段で通す更新の比べの相手。押す前の状態を読むまで）。
        this.#givenAuthenticatedStates.set(context, storageState);
        // LU-SFIX2-B: 書き込みの段の Context は、渡した状態を控える（閉じるときに次へ渡す状態は、ページが書けるものをこの写しに戻す）。
        // LU-SFIX3-B: サーバの `Set-Cookie` で来た cookie も見張る（最初の要求より前から）。
        // LU-SFIX5（LU-SREV4 の Important-1）: 書き込みのジョブの factory は、どの Context も同じに控える（送る前の READ などでページが書いた値を、照合へ渡さない）。
        if (stage.writeStage !== undefined || this.#writeJob) {
          this.#writeStageGivenStates.set(context, storageState);
          this.#observeServerSetCookies(context);
        }
      }
    }
    // 要求の終わりの事象は、Guard の取り付けより前（最初の要求より前）に、meter に渡し始める（サイトへの負荷の制御の設計書 4.5）。
    this.#observeRequestEnds(context);
    // T35c: 承認したサービスの Origin からの 401 の応答を数えさせる（監査の段の口があるときだけ。最初の要求より前から）。
    this.#observeServiceUnauthorizedResponses(context);
    // DEF-233 fix round 1: サイトの token の更新の応答の値を覚える（次の画面へ渡す鍵の値の確かめ。最初の要求より前から）。
    this.#observeTokenRefreshResponses(context);
    // 成功して終わった要求の応答の事実も、同じく最初の要求より前から、Run 全体のキャッシュに渡し始める（設計書 4.6、4.10.3）。
    this.#observeResponses(context);

    // Context と Ledger の対応は、構築に失敗しても消さない（`getSafetyLedger` で後から取り出せるようにする。設計書 4.3）。
    this.#contextLedgers.set(context, ledger);
    this.#activeContexts.add(context);
    // 届け方の部品は、Run 全体のキャッシュがある場合に、役割によらず渡す（設計書 4.7、4.10.3）。T44b（P1-1）: 監査の段の送信の扱いの口があれば、読み込み
    // 直しの Context でも、承認したサービスの Origin への要求とページが出す送信を送る（`revisitSends`）。
    const resourceDelivery = this.#createResourceDelivery(role, auditSend);
    // T25c: 認証つきの Run の Guard には、監査の段の除外を渡す（ログインの段の指定は渡さない。監査の段では POST を許さない）。
    const navigationPacer = this.#navigationPacer;
    // T37b: PRIMARY の Passive の Context（ログインの段と書き込みの段を除く）だけに、送らずに観察する probe の口（既定は無効）を渡す。承認した API の
    // Origin は、認証の指定の監査の段の口の承認したサービスの Origin（なければ空）。DEF-220: 承認したテストの Origin は、認証の指定の承認したテストの Origin
    // （ログインのある形とない形の両方。なければ空）を明示して渡す（許可 Origin の全体は使わない）。RB-4 fix: 監査の Run の PRIMARY（凍結しない）には渡さない。
    const submissionObservation = role === 'PRIMARY' && !this.#pageAuditRun && stage.loginStage === undefined && stage.writeStage === undefined
      ? new SubmissionObservation({
        approvedApiOrigins: this.#authentication?.auditStage?.approvedServiceOrigins ?? [],
        approvedTestOrigins: this.#authentication?.approvedTestOrigins ?? [],
        allowedOrigins: [...this.#allowedOrigins],
        // DEF-276: 操作さがしの Run のほかは、凍結の後に押さない口（印を付け損ねたら、押せない側に倒れる）。
        ...(this.#submissionProbeRun ? {} : { freezeOnlyForReading: true as const }),
      })
      : undefined;
    if (submissionObservation !== undefined) {
      this.#submissionObservations.set(context, submissionObservation);
    }
    const guardOptions: PassiveRequestGuardOptions = Object.freeze({
      ...(resourceDelivery === undefined ? {} : { resourceDelivery }),
      // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: 監査の段の除外は、どの Context でも main frame の文書の読み込みだけに当てる
      // （前の BN-0 の Isolated Interaction Context の印 `applyToPageSubresourceReads` は外した）。
      ...(this.#authentication === null ? {} : { auditExclusions: this.#authentication.auditExclusions }),
      // T35b: スクリプトで送るログインの監査の段（認証つきの factory の、書き込みの段でない Context だけ）。
      ...guardAuditStage,
      // L10 の後の安全の側の設計の変更: Isolated Interaction Context の Guard は、凍結の段でも、凍結の読み取りの判定に当たる読み取りを通す。
      ...guardFrozenReadOptionOf(contextKind),
      // AS-a: 監査の段の送信の扱い。RB-4b: Isolated Interaction Context の押す前の段にも渡す（`guardAuditSend`。WebSocket は Guard が今どおり止める）。
      ...(guardAuditSend === undefined ? {} : { auditSend: guardAuditSend }),
      // RB-4b: リアルタイムの通信を止めない（Isolated Interaction Context とログインの段には渡さない）。RB-4 fix: 観察の口のある発見の PRIMARY（凍結しうる）では、
      // Guard が Worker の中の WebSocket を止める（`admitsFrozenReads`）。
      ...(contextKind === 'PASSIVE' && stage.loginStage === undefined ? { realtimePassThrough: true as const } : {}),
      // DEF-276-relay: 凍結の後に押す観察の口のある Context（操作さがしの PRIMARY。ws を止める CSP）だけ、文書の WebSocket を Node の側でこの Context の中継を通して
      // つなぐ（凍結の前だけ）。
      ...(submissionObservation !== undefined && this.#submissionProbeRun
        ? {
          webSocketRelay: Object.freeze({
            proxy: Object.freeze({ host: new URL(egress.server).hostname, port: egress.port }),
            ...(this.#writeSubmissionCertificates === undefined ? {} : { additionalTrustedCertificates: this.#writeSubmissionCertificates }),
          }),
        }
        : {}),
      // AS-c fix round 1（I-1）: ほかの Origin への CORS の事前確認を、Guard がこの Context の中継を通してサーバへ送る送り手（送信の扱いの口と一緒だけ）。OP-N:
      // 書き込みの段には渡さない（書き込みの段は、許可 Origin と承認したサービスの Origin のほかへ送らない）。
      // OP-Q（Q1）: 書き込みのジョブの Passive の Context（書き込みの作業の印）にも渡さない。
      ...(guardAuditSend === undefined || stage.writeStage !== undefined || guardAuditSend.writeJobEndpoint !== undefined
        ? {}
        : {
          auditSendPreflight: Object.freeze({
            proxy: Object.freeze({ host: new URL(egress.server).hostname, port: egress.port }),
            acceptLanguage: this.#locale,
            ...(this.#writeSubmissionCertificates === undefined ? {} : { additionalTrustedCertificates: this.#writeSubmissionCertificates }),
          }),
        }),
      // T25d: ログインの段の Context だけ（認証つきの factory では作らない）。
      ...(stage.loginStage === undefined ? {} : { loginStage: stage.loginStage }),
      // T30b: 書き込みの段の Context だけ（認証つきの factory だけが作る）。
      ...(stage.writeStage === undefined ? {} : { writeStage: stage.writeStage }),
      // DEF-099 fix: 書き込みの段の承認の POST は、Guard が送り手に送らせる（この Context の中継を通して 1 回だけ）。
      ...(stage.writeStage === undefined
        ? {}
        : {
          writeSubmission: Object.freeze({
            proxy: Object.freeze({ host: new URL(egress.server).hostname, port: egress.port }),
            acceptLanguage: this.#locale,
            ...(this.#writeSubmissionCertificates === undefined ? {} : { additionalTrustedCertificates: this.#writeSubmissionCertificates }),
          }),
        }),
      // DEF-085: Guard が Context を閉じる直前（無効化と持ち主の close）に、中継を凍結する。
      egressFreeze: (cause: EgressFreezeCause): void => {
        // fix round 2（SREV-233 の M-1）: 凍結に入るときに、残っている読み取りでない要求の写しを捨てる（凍結の前に通した要求の写しを、凍結の後に使わせない）。
        this.#egressSendAdmissions.get(egress)?.discard();
        this.#egressFrozenTokenRefreshAdmissions.get(egress)?.discard();
        freezeEgressFor(egress, freeze, cause);
      },
      // DEF-125: Guard が通した要求の宛先を、この Context の中継に知らせる（中継は、知らせた宛先への CONNECT だけを通す）。
      onEgressDestinationAdmitted: (url: string, method?: string, frozenRead?: boolean, layer?: GuardRequestLayer): void => {
        // DEF-208-1 の (e): 凍結の読み取りとして通した宛先は、凍結の後の CONNECT の受け入れにも知らせる（https の宛先）。
        egress.admitTunnelDestinationOf(url, frozenRead === true);
        // BN-R0 fix round 1（I-1）: Guard が通した読み取りを、中継の要求の方針に知らせる（Passive の Context の中継だけが写しを持つ）。
        this.#egressReadAdmissions.get(egress)?.admit(method, url);
        // DEF-208-1: Guard が凍結の段で通した読み取りは、凍結の後の写しにも書く（中継が凍結の後に通すのは、この写しに当たる読み取りだけ）。
        if (frozenRead === true) {
          this.#egressFrozenReadAdmissions.get(egress)?.admit(method, url);
          // DEF-233: 凍結の段で通したサイトの token の更新（読み取りでない）は、凍結の後の更新の写しに書く。
          // SREV-SAFE の M-2: 数えるのは CDP の層の知らせだけ（1 つの要求を 2 つの層が知らせるので）。
          this.#egressFrozenTokenRefreshAdmissions.get(egress)?.admit(method, url, layer);
        }
        // OP-N（N2）: 書き込みの段の Guard が通した読み取りでない要求も知らせる（送信の扱いの口のある書き込みの段の中継だけが写しを持つ）。
        this.#egressSendAdmissions.get(egress)?.admit(method, url);
        // LU-SFIX2-B（Minor-2）: 書き込みの段の Guard が通した、承認の送信先への書き込み（送り手が中継を通して送る 1 回）も知らせる。
        this.#egressWriteEndpointAdmissions.get(egress)?.admit(method, url);
      },
      // SREV-SAFE の N-1: route の層が止めた要求は、CDP の層の知らせで数えた凍結の段の写しを 1 つ戻す（写しを残さない）。
      onEgressDestinationWithdrawn: (url: string, method: string): void => {
        this.#egressFrozenTokenRefreshAdmissions.get(egress)?.withdraw(method, url);
      },
      // DEF-100 fix: main frame の文書の要求を送った時刻を、Run の読み込みの間隔の部品に記録する（サイトに届く間隔を設定以上にする）。
      ...(navigationPacer === null ? {} : { onMainFrameDocumentSent: (): void => navigationPacer.recordDocumentRequestSent() }),
      // T37b: 送らずに観察する probe の口（PRIMARY の Passive の Context だけ）。
      ...(submissionObservation === undefined ? {} : {
        submissionObservation,
        // fix round 3（N-1）: 凍結の段で通す更新の比べの相手（凍結の前に確かめた更新の形と header、今の鍵の値）。
        frozenTokenRefreshReference: (): FrozenRefreshReference | null => this.#tokenRefreshReferenceOf(context),
      }),
      // fix round 2・3: Passive の Context（ログインの段と書き込みの段を除く）では、Guard が更新を通した知らせを受け（応答と、凍結の前の更新の確かめの候補を覚える）、
      // Run の中で覚えた必須の query の値を凍結の段の判定に渡す。
      ...(stage.loginStage === undefined && stage.writeStage === undefined ? {
        onTokenRefreshAdmitted: (url: string, frozen: boolean, request: { readonly headers: Readonly<Record<string, string>>; readonly body: string | null }): void =>
          this.#admitTokenRefresh(context, url, { frozen, headers: request.headers, body: request.body }),
        frozenTokenRefreshQueryValues: (): ReadonlyMap<string, ReadonlySet<string>> => this.#learnedRefreshQueryValuesOf(),
      } : {}),
      // DEF-129: Passive の Context（ログインの段と書き込みの段を除く）では、ページが始めた main frame の読み込みの回数に上限を置く。
      ...(stage.loginStage === undefined && stage.writeStage === undefined ? { pageNavigationLimit: true } : {}),
      // DEF-245: 閉じるときの作業の待ちの見張りの長さ（テストが短くする口。省略は本番の長さ）。
      ...(this.#progressWatchQuietLimitMs === undefined ? {} : { drainQuietLimitMs: this.#progressWatchQuietLimitMs }),
    });
    try {
      await installPassiveRequestGuard(context, ledger, this.#allowedOrigins, guardOptions);
    } catch (error) {
      throw this.#constructionFailure(context, error);
    }
    // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: ページの読み取りでない送信を通す Context（監査の段の送信の扱いの口、手動の
    // ログインの段、自動ログインの段の印のあるもの。役割・種類によらない）は、持ち主が閉じるときに、ページを離れてから待つ（閉じる時の後始末の送信を届ける）。
    // 人が選んだ READ_ONLY の Context は、離れても送信を通さないので当てない。
    if (guardOptions.auditSend !== undefined || stage.loginStage?.manualPassThrough === true || stage.loginStage?.automatedPassThrough === true) {
      this.#pageLeaveContexts.add(context);
    }
    return context;
  }

  /**
   * Interaction の owner の session を作る（設計書 4.3）。失敗した場合に、誰が Context を閉じるかは次のとおり。
   * - Context の作成（`createPassiveContext`）で、Guard の取り付けに失敗した場合: `ContextConstructionError` をそのまま投げる。
   *   factory は Context を閉じない。Guard がまだ Context を閉じていなければ（`isPassiveRequestGuardClosed` が偽）、
   *   呼び出し側が `closePassiveContext` で閉じる。
   * - Context の作成で、それ以外に失敗した場合（Ledger の検査、`newContext` の失敗など）: その例外をそのまま投げる。
   *   閉じる Context はない（Ledger の検査の失敗では、Context を作らない）。
   * - page の作成で、Guard の準備（`awaitPassiveRequestGuardReady`）に失敗した場合: `createPassivePage` が投げた
   *   `ContextConstructionError` をそのまま投げる。factory は Context を閉じない。Guard がまだ閉じていなければ、呼び出し側が閉じる。
   * - page の作成で、それ以外に失敗した場合（`newPage` の失敗など）: factory が、まだ所有している Context を
   *   `closePassiveContext` で1回だけ閉じようとし（その失敗は投げない）、そのうえで `ContextConstructionError` を投げる。
   *   閉じるのに失敗して Guard がまだ閉じていなければ、Context は factory の所有のまま残るので、呼び出し側が閉じる。
   *
   * どの `ContextConstructionError` も、Context が閉じられたかどうかに関係なく、その Context と Ledger を持つ。
   * 成功した場合は、返した session の `close()` で Context を閉じる（session の持ち主が閉じる）。
   * Interaction の Context は、ページの読み込み直しなので、役割は `REVISIT` である（サイトへの負荷の制御の設計書 4.7）。
   *
   * 出口の中継（DEF-039・DEF-040 の設計書 2.1.2）: Context を作る前に中継（`startEgressProxy`）を作り、Context の作成の指定に
   * `proxy: { server }` を渡す（Playwright は Context ごとの proxy を `<-loopback>` の bypass と一緒に付けるので、127.0.0.1 への通信も
   * 中継を通る）。DEF-085 から、Passive とログインの段の Context にも中継を付ける（`#createPassiveGuardedContext`）。
   * - 中継を作れなければ、Context を作らずに、その例外をそのまま投げる（Ledger の検査の失敗と同じ扱い）。Context の作成や page の
   *   作成に失敗したら、中継を閉じてから、上の決まりどおりに投げる。
   * - 中継が拒んだ要求は、その Context の Ledger の `blockedInteractionRequests` に写す（`egressRejectionReason`）。
   *   DEF-085: Guard は、Context を閉じる直前と、凍結の段に入った直後にも中継を凍結する（`#createGuardedContext` の `egressFreeze`）。
   *   Interaction の凍結の前に、閉じる直前の凍結が起きた後の拒否は、記録しない（fix round 3。Interaction の凍結の後の拒否は、今のまま
   *   `INTERACTION_FROZEN_EGRESS`）。
   * - 中継の待ち受けの後の失敗（`onError`）は、違反 `EGRESS_PROXY_FAILED` を記録して Context を無効にする（fail-closed。Guard の
   *   無効化の関数は公開されていないので、factory の所有の閉じる処理（`closePassiveContext`）を 1 回だけ始め、session の `close()` は
   *   その処理に合流する）。
   * - `activateInteractionFreeze` は、Guard の凍結の後に中継を凍結する（Guard の凍結が失敗しても凍結する）。Guard の凍結の前に
   *   中継を凍結すると、まだ正当な要求（読み込みの残り）を中継が拒み、「Guard を通らずに出た要求」の記録と区別できなくなるためである。
   * - `close()` は、Context を閉じた後（失敗しても）に中継を閉じる。中継を閉じた後に Context が残っても、通信の先がないので届かない。
   */
  async createInteractionSession(viewport: Viewport): Promise<InteractionGuardedSession> {
    const ledger = this.#issueSafetyLedger();
    let egressFailure: Promise<void> | null = null;
    let context: BrowserContext | undefined;
    // DEF-085: 中継を凍結したのが Interaction の凍結（`activateInteractionFreeze`）か。偽のまま凍結の後の拒否が来たら、Guard が閉じる直前に
    // 凍結した後の拒否である。
    const freeze: EgressFreezeRecord = { frozenByInteraction: false };
    // L10 の後の安全の側の設計の変更: この Context の Guard が凍結の段で通した読み取りの写し（中継の凍結の後の受け入れが使う。Passive の Context と同じ部品）。
    const frozenReadAdmissions = new EgressReadAdmissions();
    const proxy = await startEgressProxy({
      upstreamPolicy: this.#egressUpstreamPolicy,
      // DEF-125: CONNECT は、この Context の Guard が通した要求の宛先だけを通す（Passive の Context と同じ。サイトの外の宛先は待たずに通す）。
      tunnelAdmission: this.#egressTunnelAdmission,
      // 凍結の後は、Guard が凍結の段で通した読み取りの写しに当たる読み取りだけを通す（写しは 1 回だけ使う。ほかの要求と、知らせのない CONNECT は今のとおり拒む）。
      frozenReadAdmission: (method: string, url: string): boolean => frozenReadAdmissions.take(method, url),
      onRejected: (rejection): void => {
        const event = egressRejectionEvent(rejection, freeze);
        if (event !== null) {
          ledger.recordBlockedInteractionRequest(event);
        }
      },
      onError: (error): void => {
        ledger.recordInvariantViolation({ code: 'EGRESS_PROXY_FAILED', message: safeErrorMessage(error) });
        if (egressFailure === null && context !== undefined && this.#activeContexts.has(context)) {
          egressFailure = this.closePassiveContext(context);
          egressFailure.catch(() => undefined);
        }
      },
    });
    // Guard の知らせの口（`#createGuardedContext` の `onEgressDestinationAdmitted`）が、凍結の段で通した読み取りを、この写しに書く。
    this.#egressFrozenReadAdmissions.set(proxy, frozenReadAdmissions);
    let page: Page;
    try {
      // BN-0: Interaction の Context は、ページが出す文書でない読み取りにも監査の段の除外を当てる。
      context = await this.#createGuardedContext(ledger, viewport, 'REVISIT', proxy, freeze, {}, undefined, 'INTERACTION');
      try {
        page = await this.createPassivePage(context);
      } catch (error) {
        if (error instanceof ContextConstructionError) throw error;
        if (this.#activeContexts.has(context)) {
          await this.closePassiveContext(context).catch(() => undefined);
        }
        throw this.#constructionFailure(context, error);
      }
    } catch (error) {
      await proxy.close();
      throw error;
    }
    const ownedContext = context;
    let closed = false;
    return Object.freeze({
      page,
      ledger,
      activateInteractionFreeze: async (): Promise<void> => {
        try {
          this.#requireActiveGuardedContext(ownedContext);
          // SREV-SAFE-2 の C-2: 凍結の直前に、閉じるときに次の Context へ渡す状態を控える（操作さがしの probe と同じ口 T37R-fix-B。閉じるときは
          // `#pinnedOutcomeWithSessionKeysOf` を通り、押下でページが書いた localStorage・cookie を受け継がない。控えられなければ受け継がない側）。
          await this.pinAuthenticatedStateBeforeProbe(ownedContext);
          await activateInteractionFreeze(page);
        } finally {
          // Guard の凍結が成功していれば、Guard の口ですでに凍結した（何もしない）。Guard の凍結の前に失敗した場合も、凍結する。
          freezeEgressFor(proxy, freeze, 'INTERACTION_FREEZE');
        }
      },
      isClosed: (): boolean => isPassiveRequestGuardClosed(ownedContext),
      // closePassiveContext() と同じ意味にする（設計書 4.1）。invalidation を経て CLOSED に達したら、
      // 前回の close が非終端で失敗していたかどうかにかかわらず reject する。所有は CLOSED の時点で解放する。
      close: async (): Promise<void> => {
        if (closed) {
          throw new Error('Interaction owner session was already closed');
        }
        try {
          await (egressFailure ?? this.closePassiveContext(ownedContext));
        } finally {
          closed = isPassiveRequestGuardClosed(ownedContext);
          await proxy.close();
        }
      },
    });
  }

  /**
   * T37b（Task 37 の設計書 3.2 の「Guard の観察の形」）: その Context の送らずに観察する probe の口（既定は無効）。PRIMARY の Passive の Context
   * （ログインの段と書き込みの段の Context を除く）だけが持ち、ほかの Context と、この factory が作っていない Context は `null`。
   */
  submissionObservationOf(context: BrowserContext): SubmissionObservation | null {
    return this.#submissionObservations.get(context) ?? null;
  }

  /**
   * COV-2c（SREV-COV の C-1。網羅の設計書）: 凍結した Context の page で、操作さがしの押下から生まれた移り先（文書の移動・popup・SPA の辺の URL）を、凍結を
   * 解かずに読み込む（凍結を始めない読み取りの入口）。Guard の口（`admitFrozenMainFrameDocument`）で、その行き先への main frame の GET だけを、凍結の読み取りと
   * 同じ判定で 1 回の読み込みの間だけ通す（読み込みの後に閉じる）。移り先の文書の JS の読み取りでない送信は、凍結の決まりのまま止める（観察の口が型を受ける。
   * token の更新は今どおり通す）。読み込みそのものは、呼ぶ側が Passive の読み込みと同じ部品（`navigatePage`）で `load` の中で行う（口は、`load` が終わったら
   * 閉じる）。この factory の観察の口のある Context でない・凍結の段でない・page がただ 1 つでない・URL が http(s) でないときは、読み込まずに投げる。読み込みの
   * 間隔は、呼ぶ側が先に守る。
   */
  async loadFrozenDocument<T>(page: Page, url: string, load: () => Promise<T>): Promise<T> {
    this.#requireActiveGuardedContext(page.context());
    // DEF-276: 押す観察の口（操作さがしの Run）の Context だけ。
    const observation = this.#submissionObservations.get(page.context());
    if (observation === undefined || !observationPressesAfterFreeze(observation)) {
      throw new Error('A frozen document load requires a Context with the submission observation');
    }
    const revoke = admitFrozenMainFrameDocument(page, url);
    try {
      return await load();
    } finally {
      revoke();
    }
  }

  /**
   * SAFE-2 の 1（COV-2c の M-1）: 最初から凍結した Context を開く（操作さがしの祖先の画面を、読み込みの最初から凍結して読むため。祖先の画面が読み込みで出す自動の
   * 書き込みを、作り直すたびに届けない）。観察の口のある `PRIMARY` の Passive の Context と page を作り、page がまだ何も読み込んでいない（`about:blank`）うちに Guard を
   * 凍結の段にする（`activateInteractionFreezeBeforeLoad`。出口の中継も同じ順で凍結する）。読み込みは、呼ぶ側が `loadFrozenDocument` で行う。凍結の決まりで止める範囲と、
   * 凍結の後の読み取りの決まりは、読み込んだ後に凍結した Context と同じ。凍結に失敗したら、Context を閉じて投げる。閉じるのは `closePassiveContext`。
   */
  async openFrozenObservationContext(viewport: Viewport): Promise<{ readonly context: BrowserContext; readonly page: Page }> {
    const context = await this.createPassiveContext(viewport, 'PRIMARY');
    try {
      // DEF-276: 押す観察の口（操作さがしの Run）の Context だけ。
      const observation = this.#submissionObservations.get(context);
      if (observation === undefined || !observationPressesAfterFreeze(observation)) {
        throw new Error('A frozen observation Context requires the submission observation');
      }
      const page = await this.createPassivePage(context);
      await activateInteractionFreezeBeforeLoad(page);
      return Object.freeze({ context, page });
    } catch (error) {
      if (this.#activeContexts.has(context)) {
        await this.closePassiveContext(context).catch(() => undefined);
      }
      throw error;
    }
  }

  getSafetyLedger(context: BrowserContext): SafetyLedger {
    const ledger = this.#contextLedgers.get(context);
    if (ledger === undefined) {
      throw new Error('BrowserContext is not owned by this factory');
    }
    return ledger;
  }

  async createPassivePage(context: BrowserContext): Promise<Page> {
    this.#requireActiveGuardedContext(context);
    // DEF-134: 要素の位置の engine（合図つきの Locator）は、page で Playwright のセレクタを最初に使う前に登録しておく必要がある（後から登録すると、
    // その page の Playwright の読み取りの部品が engine を知らない）。page を作る唯一の口で、作る前に登録する（1 回だけ。2 回目からは同じ約束を返す）。
    try {
      await ensureElementPathEngine();
    } catch (error) {
      throw this.#constructionFailure(context, error);
    }
    const page = await context.newPage();
    try {
      await awaitPassiveRequestGuardReady(page);
    } catch (error) {
      throw this.#constructionFailure(context, error);
    }
    this.#ownedPages.set(page, context);
    const pages = this.#contextPages.get(context) ?? new Set<Page>();
    pages.add(page);
    this.#contextPages.set(context, pages);
    return page;
  }

  /**
   * Guard の付いたページを個別に閉じると、ページを離れるときの送信が Guard を通らずに出る（DEF-038）。production では使わない。
   * テストの後片付けだけで使う（production の page は、`closePassiveContext` で Context と一緒に閉じる）。
   */
  async closePassivePage(page: Page): Promise<void> {
    const context = this.#ownedPages.get(page);
    if (context === undefined || !this.#activeContexts.has(context)) {
      throw new Error('Page is not owned by this factory or its Context is no longer active');
    }
    try {
      await closePassiveGuardedPage(page);
    } catch (error) {
      this.#releasePage(page, context);
      if (isPassiveRequestGuardClosed(context)) this.#releaseContext(context);
      throw error;
    }
    this.#releasePage(page, context);
  }

  /**
   * 持ち主が Context を閉じる。T44b（Task 44 の設計書 3.1 の P1-2 と、設計の変更の履歴の「T44b の報告」の行）・SD-2: ページの読み取りでない送信を通す
   * Context（`#pageLeaveContexts`。役割・種類によらない）で、Guard がまだ有効で凍結していない（`#leavablePagesOf`）なら、閉じ始める前に次を行う（1 回の閉じ方あたり、待つのは
   * `AUDIT_SEND_CLOSE_SETTLE_MS` まで。移動は `AUDIT_SEND_PAGE_LEAVE_TIMEOUT_MS` まで）。
   * 1. 認証つきの Context は、認証の状態を読む（ページを離れる前。離れた後のページには、サイトの Origin の状態がない）。
   * 2. その Context の page を、about:blank へ移す（`#leavePagesBeforeClose`。ページを離れるときの送信を、Guard の今の判定で通す）。
   * 3. 名前つきの時間だけ待つ（送信を自然に終えさせる）。
   * 待つ間に factory が閉じ始めた（違反など）なら、その閉じる処理に合流する。factory が自分で閉じる処理（`#beginFactoryClose`）は、待たずページも離れない
   * （`#closeContextNow`）。
   */
  async closePassiveContext(context: BrowserContext): Promise<void> {
    // DEF-044、DEF-049、DEF-085: factory が自分で閉じ始めた Context は、その閉じる処理に合流する。
    const factoryClose = this.#factoryInitiatedCloses.get(context);
    if (factoryClose !== undefined) {
      return factoryClose;
    }
    this.#requireActiveContext(context);
    if (!this.#pageLeaveContexts.has(context) || !this.#leavablePagesOf(context)) {
      return this.#closeContextNow(context, false);
    }
    const generation = this.#authenticatedGenerations.get(context);
    if (generation !== undefined) {
      await this.#captureAuthenticatedState(context, generation);
    }
    await this.#leavePagesBeforeClose(context);
    await wait(this.#auditSendCloseSettleMs);
    const closingByFactory = this.#factoryInitiatedCloses.get(context);
    if (closingByFactory !== undefined) {
      return closingByFactory;
    }
    return this.#closeContextNow(context, true);
  }

  /**
   * SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: Context に、閉じる前に離れられる page があるか。Guard が有効で凍結していない
   * （`PASSIVE_ACTIVE`）ときだけ真。凍結の段（`FROZEN_ACTIVE`。操作さがしの押した後と最初から凍結した Context、Interaction の押した後）は、離れても後始末の送信が
   * 凍結で止まる（守り 2）ので離れない（3 章の限界）。page のない Context も離れない。
   */
  #leavablePagesOf(context: BrowserContext): boolean {
    const pages = [...(this.#contextPages.get(context) ?? [])].filter((page) => !page.isClosed());
    return isGuardActive(context) && pages.length > 0 && pages.every((page) => passiveRequestGuardStageOf(page) === 'PASSIVE_ACTIVE');
  }

  /**
   * T44b: Context の page（factory が作ったもの）を、閉じる前に about:blank（`AUDIT_SEND_PAGE_LEAVE_URL`）へ移す（人がページを閉じるのと同じく、ページの
   * `pagehide`・`visibilitychange`・`unload` を起こす）。サイトへの要求ではないので、Guard は判定せず、読み込みの間隔とページの移動の上限（DEF-129）にも
   * 数えない（BeakSight 自身の読み込みの知らせ `announceOwnMainFrameNavigation` も呼ばない）。移動の失敗と期限切れは投げない（離れずに閉じる側へ進む）。
   */
  async #leavePagesBeforeClose(context: BrowserContext): Promise<void> {
    const pages = [...(this.#contextPages.get(context) ?? [])].filter((page) => !page.isClosed());
    await Promise.all(pages.map(async (page): Promise<void> => {
      // 設計者の判断の (2): ページを離れた後の要求は、そのページの読み取りの判定の数（DEF-130）に入れない（移動の前に知らせる）。
      announcePageLeave(page);
      try {
        await page.goto(AUDIT_SEND_PAGE_LEAVE_URL, { timeout: AUDIT_SEND_PAGE_LEAVE_TIMEOUT_MS, waitUntil: 'commit' });
      } catch {
        // 離れられなくても、待ってから閉じる（閉じた後の送信は、今どおり Guard が止める）。
      }
    }));
  }

  /**
   * Context を、待たずに閉じる（持ち主の閉じ方の手順の後と、factory が自分で閉じる処理。`closePassiveContext` の今までの中身）。`stateCaptured` が真なら、
   * 認証の状態はページを離れる前に読んだので、読み直さない（T44b）。
   */
  async #closeContextNow(context: BrowserContext, stateCaptured: boolean): Promise<void> {
    this.#requireActiveContext(context);
    // T25c: 認証つきの Context は、閉じる前に状態を取り出し、絞ってから、その世代が今の世代以上なら受け継ぐ状態にする（失敗は数えて進む）。
    const generation = this.#authenticatedGenerations.get(context);
    if (!stateCaptured && generation !== undefined && !isPassiveRequestGuardClosed(context)) {
      await this.#captureAuthenticatedState(context, generation);
    }
    try {
      await closePassiveGuardedContext(context);
    } finally {
      if (isPassiveRequestGuardClosed(context)) {
        this.#releaseContext(context);
        // DEF-085: Context を閉じたら、出口の中継も閉じる（Guard が閉じる直前に凍結済み。閉じられなければ凍結したまま残る）。
        await this.#contextEgress.get(context)?.close();
      }
    }
  }

  /**
   * 認証済みの状態を取り出せなかった回数（T25c。Task 25 の設計書 4.3）。認証の指定のない factory では、いつも 0。値は記録しない。
   */
  authenticatedStateReadFailureCount(): number {
    return this.#authenticatedStateReadFailures;
  }

  /**
   * FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: 今持っている、受け継ぐ認証済みの状態（絞り込んで凍結した写し。世代の最も
   * 新しいもの）を読むだけの口。まとめて実行のワーカーが、段の終わりに次の段の factory へ渡すためだけに使う（メモリの中だけ。成果物・管理データ・
   * ログ・IPC に出さない）。生きている Context を読み直さない（サイトへの要求を出さない。閉じた Context までの状態）。認証の指定がなければ `null`。
   */
  latestAuthenticatedState(): AuthenticatedStorageState | null {
    return this.#authenticatedState?.state ?? null;
  }

  /**
   * 新しい Context に渡す、受け継ぐ状態を決める（T25c。Task 25 の設計書 4.3 の 2026-10-10 の Blocker の行。世代つき）。認証の指定がなければ
   * `undefined`。SFIX-1104 の I-1: 今の状態より後にサイトの応答を受けた、生きている（Guard が閉じていない）認証つきの Context があれば、そのうち応答を
   * 最後に受けた Context の状態を読み、今の状態にしてから返す（Desktop の Context を開いたまま、ほかの Context を作る場合に、Desktop が読み込みで受けた
   * 最新の状態を渡すため）。読めなければ、数えて、今の状態のまま返す。
   */
  async #inheritedAuthenticatedState(): Promise<AuthenticatedStorageState | undefined> {
    if (this.#authenticatedState === null) {
      return undefined;
    }
    let newest: { readonly context: BrowserContext; readonly generation: number; readonly responseSequence: number } | undefined;
    for (const [context, generation] of this.#authenticatedGenerations) {
      const responseSequence = this.#lastSiteResponses.get(context) ?? NO_SITE_RESPONSE_SEQUENCE;
      if (
        responseSequence > this.#authenticatedState.responseSequence
        && (newest === undefined || responseSequence > newest.responseSequence)
        && !isPassiveRequestGuardClosed(context)
      ) {
        newest = { context, generation, responseSequence };
      }
    }
    if (newest !== undefined) {
      await this.#captureAuthenticatedState(newest.context, newest.generation);
    }
    return this.#authenticatedState.state;
  }

  /** `context` の状態を、期限（`AUTHENTICATED_STATE_READ_TIMEOUT_MS`）までに取り出し、絞り込み、形を確かめた写しにする（投げない）。 */
  async #readAuthenticatedState(
    context: BrowserContext,
  ): Promise<{ readonly status: 'FULFILLED'; readonly value: AuthenticatedStorageState } | { readonly status: 'FAILED' }> {
    const authentication = this.#authentication;
    if (authentication === null) {
      return { status: 'FAILED' };
    }
    const names = this.#contextStateNames.get(context);
    const outcome = await awaitBeforeDeadline(
      (async (): Promise<AuthenticatedStorageState> => {
        // DEF-139: IndexedDB を含めて読む（唯一の読み口）。
        const raw = await readContextStorageState(context);
        // DEF-138: 絞り込みの前の状態の名前を残す（承認したサービスの Origin の名前も見るため。値は残さない）。
        if (names !== undefined) {
          names.read = authenticatedStateNamesOf(raw);
        }
        return authenticatedStateCopy(authentication.filterState(raw));
      })(),
      Date.now() + AUTHENTICATED_STATE_READ_TIMEOUT_MS,
    );
    if (outcome.status !== 'FULFILLED') {
      return { status: 'FAILED' };
    }
    // fix round 3（N-2）: 読んだ状態で、凍結の前の更新の候補を確かめる（読み途中の応答の本文は、同じ期限まで待つ）。
    const record = this.#tokenRefreshResponses.get(context);
    if (record !== undefined && record.pending.size > 0) {
      await awaitBeforeDeadline(Promise.allSettled([...record.pending]), Date.now() + AUTHENTICATED_STATE_READ_TIMEOUT_MS);
    }
    this.#verifyTokenRefreshCandidates(context, outcome.value);
    return { status: 'FULFILLED', value: outcome.value };
  }

  /**
   * DEF-138: Context の状態の名前（渡した状態と、最後に読んだ状態。値は持たない）。認証の指定のない factory と、この factory の認証つきの Context でない
   * ものは `null`。サイトへの要求を出さない（読み直さない。閉じるときなどに factory が読んだ名前を返すだけ）。
   */
  authenticatedStateNamesOf(context: BrowserContext): AuthenticatedContextStateNames | null {
    const names = this.#contextStateNames.get(context);
    return names === undefined ? null : Object.freeze({ given: names.given, read: names.read });
  }

  /** 押す前に読んだ状態（読めなかったなら失敗）。 */
  #pinnedOutcomeOf(context: BrowserContext): { readonly status: 'FULFILLED'; readonly value: AuthenticatedStorageState } | { readonly status: 'FAILED' } {
    const pinned = this.#pinnedAuthenticatedStates.get(context) ?? null;
    return pinned === null ? { status: 'FAILED' } : { status: 'FULFILLED', value: pinned };
  }

  /**
   * DEF-233（設計書 `2026-11-09-beaksight-discovery-token-refresh-design.md` 2.2）・DEF-251（案 1）: 押す前に読んだ状態（T37R-fix-B）の、ログインの成功の鍵
   * （`sessionKeyName`）の値だけを、凍結の段に通した最後の更新の応答の値で作り直す（`withSessionKeyValuesOf`・`sessionKeyValueRebuiltFrom`。ページが閉じる前に
   * 書いた値は使わない）。押す前の状態を読めなかったら失敗（今のまま）。鍵の判定がないか、閉じる前の状態を読めなければ、押す前の状態のまま。投げない。
   */
  async #pinnedOutcomeWithSessionKeysOf(
    context: BrowserContext,
  ): Promise<{ readonly status: 'FULFILLED'; readonly value: AuthenticatedStorageState } | { readonly status: 'FAILED' }> {
    const pinned = this.#pinnedOutcomeOf(context);
    const sessionKeyName = this.#authentication?.sessionKeyName;
    if (pinned.status !== 'FULFILLED' || sessionKeyName === undefined) {
      return pinned;
    }
    // 閉じる前の状態は、値を使わずに読む（状態の名前の記録 DEF-138 と、凍結の前の更新の候補の確かめ fix round 3 の N-2 のため。読めなければ今のまま）。
    const fresh = await this.#readAuthenticatedState(context);
    if (fresh.status !== 'FULFILLED') {
      return pinned;
    }
    // DEF-251: 作り直すのは、凍結の段に通した最後の更新の応答の値を当てはめられ、押下の目印を含まない値だけ（ほかは押す前の値のまま）。
    const issued = await this.#tokenRefreshIssuedValuesOf(context);
    const observation = this.#submissionObservations.get(context);
    const rebuild = (before: string): string | null => {
      const rebuilt = sessionKeyValueRebuiltFrom(before, issued);
      return rebuilt !== null && (observation === undefined || !valueCarriesObservedMarker(observation, rebuilt)) ? rebuilt : null;
    };
    try {
      return { status: 'FULFILLED', value: authenticatedStateCopy(withSessionKeyValuesOf(pinned.value, sessionKeyName, rebuild)) };
    } catch {
      return pinned;
    }
  }

  /**
   * T37R-fix-B（T37R の I-1。Task 37 の設計書 8 章の T37R の行）: 送らずに観察する probe を行う Context で、押す前に、閉じるときに次の Context へ渡す
   * 状態を読んでおく（発見の流れが、probe の直前に呼ぶ）。以後、その Context を閉じるとき（と、生きている Context から受け継ぐとき）は、この状態を使い、
   * 押下でページが書き換えた localStorage・Cookie（token を消す、下書きを保存するなど）を受け継がない。鍵の消失の判定も、この状態で行う。認証の指定の
   * ない factory と、この factory の Context でないものでは、何もしない。読めなければ、閉じるときに受け継がず、失敗に数える（fail-closed）。投げない。
   */
  async pinAuthenticatedStateBeforeProbe(context: BrowserContext): Promise<void> {
    if (this.#authentication === null || !this.#authenticatedGenerations.has(context) || isPassiveRequestGuardClosed(context)) {
      return;
    }
    const outcome = await this.#readAuthenticatedState(context);
    this.#pinnedAuthenticatedStates.set(context, outcome.status === 'FULFILLED' ? outcome.value : null);
  }

  /**
   * `context`（世代 `generation`）の状態を、期限（`AUTHENTICATED_STATE_READ_TIMEOUT_MS`）までに取り出し、絞り込み（`filterState`）、形を
   * 確かめた写しにする。SFIX-1104 の I-1: 今の状態より前にサイトの応答を最後に受けた Context（重なって開き、後で応答を受けた Context が先に閉じた場合
   * など）の状態では置き換えない（DEF-218: 状態の名前の記録のためにだけ読む）。応答の順番が同じか後なら置き換える（同じなら最後に閉じた方。DEF-191）。取り出し・絞り込み・写しのどれかに
   * 失敗するか、期限を過ぎたら、今の状態のまま、失敗の回数を数える（値や誤りの文は記録しない）。投げない。
   */
  async #captureAuthenticatedState(context: BrowserContext, generation: number): Promise<void> {
    const authentication = this.#authentication;
    if (authentication === null || this.#authenticatedState === null) {
      return;
    }
    // SFIX-1104 の I-1: 読む前の順番で比べる（読む間に受けた応答は、状態の側に含まれうる）。
    const responseSequence = this.#lastSiteResponses.get(context) ?? NO_SITE_RESPONSE_SEQUENCE;
    if (responseSequence < this.#authenticatedState.responseSequence) {
      // DEF-218: 受け継がない Context でも、セッションの切れの証拠（DEF-138 の鍵の名前の違い）のために、閉じる前の状態の名前は読む（値は受け継がず、
      // 鍵の消失の知らせにも、読めなかった回数にも使わない）。サイトへの要求は出さない。
      if (this.#contextStateNames.has(context) && !this.#pinnedAuthenticatedStates.has(context)) {
        await this.#readAuthenticatedState(context);
      }
      return;
    }
    // T37R-fix-B（T37R の I-1）: probe を行った Context は、押す前に読んだ状態を使う（読み直さない）。
    // DEF-233（設計書 2.2）: その上に、閉じる前の状態の、ログインの成功の鍵の値だけを重ねる（凍結の間に更新した token を次の画面へ渡す）。
    const outcome = this.#pinnedAuthenticatedStates.has(context)
      ? await this.#pinnedOutcomeWithSessionKeysOf(context)
      : await this.#readAuthenticatedState(context);
    if (outcome.status !== 'FULFILLED') {
      this.#authenticatedStateReadFailures += 1;
      return;
    }
    // LU-SFIX2-B（LU-SREV2 の Important-1）・LU-SFIX3-B（LU-SREV3 の Important-1）: 書き込みの段の Context は、localStorage と IndexedDB を書き込みの段の前の
    // 世代（その Context に渡した写し）に戻し、cookie は、ページのスクリプトが書けない（HttpOnly）か、サーバの `Set-Cookie` で来たものだけを書き込みの段の後の
    // 値にする（`writeStageCarriedStateOf`）。
    const given = this.#writeStageGivenStates.get(context);
    const value: AuthenticatedStorageState = given === undefined
      ? outcome.value
      : writeStageCarriedStateOf(given, outcome.value, await this.#serverSetCookiesOf(context));
    // T35c（Task 35 の設計書 3.5）: 読み直した状態に、ログインの状態の鍵がなければ、知らせる（値は読まない。判定は渡された関数）。
    // AS-c の Blocker の判断 B2（監査の段の送信の扱いの設計書 5 章）: そのときは、監査の段の送信の扱いによらず、次の Context に渡す状態を置き換えない（切れた
    // 状態で上書きしない）。鍵の判定のない設定は、今どおり置き換える（状態で切れを見分けられない。path によるセッションの切れで止まる）。
    const { sessionKeyPresent } = authentication;
    if (sessionKeyPresent !== undefined && !sessionKeyPresent(value)) {
      this.#onSessionKeyLost?.();
      return;
    }
    // DEF-191（設計書 `2026-11-04-beaksight-login-session-design.md` 3.1 の 2）: 作った順の世代で捨てない（先に作って後で閉じた Context が、その間に token を
    // 更新したもの）。SFIX-1104 の I-1: 読む間に、ほかの Context がより後の応答の状態を置いていたら、置き換えない（await の後に比べ直す）。
    if (responseSequence < this.#authenticatedState.responseSequence) {
      return;
    }
    this.#authenticatedState = Object.freeze({ state: value, generation, responseSequence });
  }

  /**
   * LU-SFIX3-B（LU-SREV3 の Important-1）: 書き込みの段の Context の応答（`response`）の `Set-Cookie` を見て、名前・値・応答の host を覚える（L12b: 数の
   * 上限なし）。ヘッダの読み取りの失敗は覚えない。投げない。
   */
  #observeServerSetCookies(context: BrowserContext): void {
    const record = { seen: [] as ServerSetCookie[], pending: new Set<Promise<void>>() };
    this.#writeStageServerCookies.set(context, record);
    context.on('response', (response: Response): void => {
      const read = (async (): Promise<void> => {
        try {
          const host = new URL(response.url()).hostname;
          for (const header of await response.headerValues(SET_COOKIE_HEADER)) {
            const cookie = serverSetCookieOf(header, host);
            // L12b（設計書 6.2。N21）: 覚える数の上限（前は 256。超えた分は前の世代の値に戻った）は置かない。
            if (cookie !== null) {
              record.seen.push(cookie);
            }
          }
        } catch {
          // 読めない応答（閉じた Context など）は、覚えない。
        }
      })();
      record.pending.add(read);
      void read.finally(() => record.pending.delete(read));
    });
  }

  /** LU-SFIX3-B: 書き込みの段の Context で見た `Set-Cookie`（読み途中のヘッダは、状態の読み取りと同じ期限まで待つ。過ぎたら、それまでに見た分）。 */
  async #serverSetCookiesOf(context: BrowserContext): Promise<readonly ServerSetCookie[]> {
    const record = this.#writeStageServerCookies.get(context);
    if (record === undefined) {
      return [];
    }
    await awaitBeforeDeadline(Promise.allSettled([...record.pending]), Date.now() + AUTHENTICATED_STATE_READ_TIMEOUT_MS);
    return [...record.seen];
  }

  /**
   * DEF-233 fix round 1（設計書 2.2）: `context` で受けた、サイトの token の更新の応答（登録の token の送り先への `POST` で query が違うもの。形は要求の判定の
   * owner の `isTokenRefreshRequest`。2xx だけ）の本文の文字列の値を覚える（次の画面へ渡す鍵の値の作り直し `sessionKeyValueRebuiltFrom` に
   * 使う。値はメモリの中だけで、記録しない。数は `MAX_TOKEN_REFRESH_ISSUED_VALUES` まで）。成功の鍵の名前の判定と監査の段の口がなければ、何もしない。投げない。
   */
  #observeTokenRefreshResponses(context: BrowserContext): void {
    const auditStage = this.#authentication?.auditStage;
    if (auditStage === undefined || this.#authentication?.sessionKeyName === undefined) {
      return;
    }
    const policy: PassiveRequestPolicyOptions = { auditStage: egressAuditStagePolicy(auditStage, true) };
    const record: TokenRefreshResponseRecord = { admittedTexts: [], frozenTexts: [], admissions: new Map(), candidates: [], pending: new Set() };
    this.#tokenRefreshResponses.set(context, record);
    context.on('response', (response: Response): void => {
      let refresh: boolean;
      try {
        const request = response.request();
        const status = response.status();
        refresh = isHttpStatusInRange(status, SUCCESS_HTTP_STATUS_RANGE)
          && isTokenRefreshRequest({ method: request.method(), url: response.url() }, policy);
      } catch {
        return;
      }
      // fix round 2（SREV-233 の M-3）: Guard が通した更新（`onTokenRefreshAdmitted` の知らせ）の応答だけを覚える（知らせのない応答は覚えない）。
      const url = response.url();
      const admitted = refresh ? record.admissions.get(url)?.shift() : undefined;
      if (admitted === undefined) {
        return;
      }
      const read = (async (): Promise<void> => {
        try {
          const text = await response.text();
          // L12b（設計書 6.2。N21）: 覚える数の上限（前は 64。超えた分は覚えなかった）は置かない。
          record.admittedTexts.push(text);
          if (admitted.frozen) record.frozenTexts.push(text);
          // fix round 3（N-2）: 凍結の前の更新は、応答で成功の鍵が実際に更新されたと確かめるまで、候補として置く（状態を読むときに確かめる）。
          if (!admitted.frozen) record.candidates.push({ url, request: admitted, responseText: text });
        } catch {
          // 読めない本文（閉じた Context など）は、覚えない（渡さない側）。
        }
      })();
      record.pending.add(read);
      void read.finally(() => record.pending.delete(read));
    });
  }

  /**
   * fix round 2（SREV-233 の M-3）: Guard が token の更新を通した（CDP の層。`frozen` は凍結の段に A1 で通したもの）。応答を覚える知らせとして、URL ごとに順に
   * 置く（L12b: 数の上限なし）。
   */
  #admitTokenRefresh(context: BrowserContext, url: string, admitted: AdmittedTokenRefresh): void {
    const record = this.#tokenRefreshResponses.get(context);
    if (record === undefined) {
      return;
    }
    const queue = record.admissions.get(url) ?? [];
    // L12b（N21）: 覚える数の上限は置かない（応答と対にして使うと消える）。
    queue.push(admitted);
    record.admissions.set(url, queue);
  }

  /** `state` の成功の鍵の値（成功の鍵の名前の判定がなければ空）。 */
  #sessionKeyValuesOf(state: AuthenticatedStorageState): readonly string[] {
    const sessionKeyName = this.#authentication?.sessionKeyName;
    return sessionKeyName === undefined
      ? []
      : state.origins.flatMap(({ origin, localStorage }) => localStorage.filter(({ name }) => sessionKeyName(origin, name)).map(({ value }) => value));
  }

  /**
   * fix round 3（SREV-233 の確かめ直しの N-1・N-2）: 状態を読んだときに、凍結の前に通して 2xx を受けた更新の候補を確かめる。読んだ状態の成功の鍵の値に、応答の文字列の
   * 値のうち、その Context に渡した状態の鍵になかったものが 1 つ以上あれば、応答で成功の鍵が実際に更新されたとして、Run の中で本文の形・header・必須の query の値を
   * 覚える（どれも 1 つの名前に値 1 つ。違う値が来たら消す）。
   */
  #verifyTokenRefreshCandidates(context: BrowserContext, state: AuthenticatedStorageState): void {
    const record = this.#tokenRefreshResponses.get(context);
    const auditStage = this.#authentication?.auditStage;
    if (record === undefined || auditStage === undefined || record.candidates.length === 0) {
      return;
    }
    const given = this.#givenAuthenticatedStates.get(context);
    const old = new Set((given === undefined ? [] : this.#sessionKeyValuesOf(given)).flatMap((value) => stringLeavesOf(value)));
    const now = new Set(this.#sessionKeyValuesOf(state).flatMap((value) => stringLeavesOf(value)));
    const policy: PassiveRequestPolicyOptions = { auditStage: egressAuditStagePolicy(auditStage, true) };
    const learned = this.#learnedRefresh;
    for (const candidate of record.candidates.splice(0)) {
      const updated = stringLeavesOf(candidate.responseText).some((leaf) => !old.has(leaf) && now.has(leaf));
      if (!updated) {
        continue;
      }
      learned.verified = true;
      for (const [name, value] of refreshQueryValuesOf(candidate.url, policy)) learnSingleValue(learned.query, learned.poisonedQuery, name, value);
      for (const [name, value] of Object.entries(candidate.request.headers)) learnSingleValue(learned.headers, learned.poisonedHeaders, name.toLowerCase(), value);
      const shape = candidate.request.body === null ? null : refreshBodyShapeOf(candidate.request.body);
      if (shape === null || (learned.bodyShape !== null && shape.join('\u0000') !== learned.bodyShape.join('\u0000'))) {
        learned.bodyConflict = true;
      } else {
        learned.bodyShape = shape;
      }
    }
  }

  /** fix round 3（N-2）: Run の中で覚えた必須の query の値（名前ごとに 1 つ）。 */
  #learnedRefreshQueryValuesOf(): ReadonlyMap<string, ReadonlySet<string>> {
    return new Map([...this.#learnedRefresh.query.entries()].map(([name, value]) => [name, new Set([value])]));
  }

  /**
   * fix round 3（SREV-233 の確かめ直しの N-1）: 凍結の段で通す更新の比べの相手。Run の中で凍結の前に確かめた更新がない・本文の形が決まらないなら null（通さない。
   * B のログインし直しが受ける）。今の鍵の値は、その Context で Guard が通した最も新しい更新の応答か、なければ BeakSight が渡した状態の成功の鍵（ページが書いた
   * 状態は使わない）。同期（Guard の判定の中で呼ぶ）。
   */
  #tokenRefreshReferenceOf(context: BrowserContext): FrozenRefreshReference | null {
    const learned = this.#learnedRefresh;
    const given = this.#givenAuthenticatedStates.get(context);
    if (!learned.verified || learned.bodyConflict || learned.bodyShape === null || given === undefined) {
      return null;
    }
    const latest = this.#tokenRefreshResponses.get(context)?.admittedTexts.at(-1);
    const current = new Map<string, string>();
    for (const text of latest === undefined ? this.#sessionKeyValuesOf(given) : [latest]) {
      for (const [name, value] of topLevelStringsOf(text)) current.set(name, value);
    }
    return Object.freeze({ bodyShape: learned.bodyShape, current, headers: new Map(learned.headers) });
  }

  /** DEF-233 fix round 2（M-3）: 凍結の段に A1 で通した更新の応答の文字列の値（読み途中の本文は、状態の読み取りと同じ期限まで待つ）。 */
  async #tokenRefreshIssuedValuesOf(context: BrowserContext): Promise<IssuedSessionValues> {
    const record = this.#tokenRefreshResponses.get(context);
    if (record === undefined) {
      return issuedSessionValuesOf([]);
    }
    await awaitBeforeDeadline(Promise.allSettled([...record.pending]), Date.now() + AUTHENTICATED_STATE_READ_TIMEOUT_MS);
    // fix round 4（3 回目の確かめ直しの I-1）: 最後の 1 つの応答だけ（全部の道を同じ応答にそろえる。2 回以上の更新の、どちらの応答の値を置くかで運ばせない）。
    return issuedSessionValuesOf(record.frozenTexts.slice(-1));
  }

  /**
   * T35c（Task 35 の設計書 3.5）: `context` の応答の事象（`response`。応答のヘッダを受けた時点）で、承認したサービスの Origin からの 401 の応答を
   * 知らせる（`onServiceUnauthorizedResponse`。値・URL は渡さない）。監査の段の口と知らせの口がなければ、何もしない。`requestfinished` は、画面が
   * 失敗の応答の本文を読まないと来ない（読まないまま Context を閉じる）ので使わない。例外は外に出さない。
   */
  #observeServiceUnauthorizedResponses(context: BrowserContext): void {
    const notify = this.#onServiceUnauthorizedResponse;
    const serviceOrigins = this.#authentication?.auditStage?.approvedServiceOrigins;
    if (notify === null || serviceOrigins === undefined) {
      return;
    }
    const origins = canonicalPassiveAllowedOrigins(new Set(serviceOrigins));
    context.on('response', (response: Response): void => {
      try {
        if (response.status() === HTTP_UNAUTHORIZED_STATUS && hasAllowedOrigin(response.url(), origins)) {
          notify();
        }
      } catch {
        // 閉じた Context の応答などは、数えない。
      }
    });
  }

  /**
   * `context` の要求の終わりの事象（`requestfinished` と `requestfailed`）を、要求、URL、失敗の理由とともに meter に渡す
   * （サイトへの負荷の制御の設計書 4.5）。観察だけで、Guard の判定には関わらず、数えるかどうかも meter が決める。
   * meter がなければ、何もしない。Playwright は、閉じた Context の事象を出さないので、閉じた後に listener を外す必要はない。
   */
  #observeRequestEnds(context: BrowserContext): void {
    const loadMeter = this.#loadMeter;
    if (loadMeter === null) {
      return;
    }
    context.on('requestfinished', (request: Request): void => {
      loadMeter.recordRequestFinished(request, request.url());
    });
    context.on('requestfailed', (request: Request): void => {
      loadMeter.recordRequestFailed(request, request.url(), request.failure()?.errorText ?? null);
    });
    // DEF-241（L11）: Guard が CDP の層で通した要求は `requestfinished` が出ず `response` だけが出るので、応答でも数える（同じ要求は meter が 1 回だけ数える）。
    context.on('response', (response: Response): void => {
      try {
        loadMeter.recordResponseReceived(response.request(), response.url());
      } catch {
        // 閉じた Context の応答などは、数えない。
      }
    });
  }

  /**
   * `context` の、要求が成功して終わった事象（`requestfinished`）で、要求と応答の事実を Run 全体のキャッシュに渡す（サイトへの負荷の
   * 制御の設計書 4.6）。観察だけで、Guard の判定には関わらず、入れるかどうかもキャッシュが決める。キャッシュがなければ、何もしない。
   * - 失敗した要求（`requestfailed`）の応答は、渡さない（設計書 4.10.3 の 2026-10-06 の追補。PCR-DR の Important-1）。本文の途中で
   *   切れた応答（`net::ERR_CONTENT_LENGTH_MISMATCH` など）でも、Playwright の `response.body()` は途中までの本文で解決するので、
   *   応答の事象（`response`）で入れると、壊れた本文をキャッシュから返してしまうためである。読み込みの途中で Context を閉じた要求も、
   *   成功して終わらないので渡さない。
   * - 本文を除いた事実で、キャッシュに入れる見込みがあるか（`ResourceCache.mayStore`）を先に尋ね、見込みがある場合だけ、本文を
   *   `response.body()`（非同期）で取る（不要な読み込みを避ける。L5b-fix-round-1）。文書、XHR、fetch、リダイレクトの応答、
   *   キャッシュから返した要求（印の付いた要求）、`content-length` でそのキャッシュの1件の上限を超えると分かる応答は、本文を取らない。
   * - 応答は、待たずに返す `request.existingResponse()` で取り、本文の取得（`response.body()`）は、事象を受けた同じ処理の中で
   *   （`await` の前に）始める。`await request.response()` の後に始めると、読み込みの直後に page を閉じた場合に、閉じる処理が先に
   *   Playwright に届き、本文を取れなくなる（成功した応答がキャッシュに入らない）ためである（PC-D-fix-round-1 の実験で確かめた）。
   * - 応答や本文を取れなかった場合（閉じた Context など）は、入れない。例外は外に出さず、未処理の拒否にもしない。
   * Playwright は、閉じた Context の事象を出さないので、閉じた後に listener を外す必要はない。
   */
  #observeResponses(context: BrowserContext): void {
    this.#observeSiteResponseOrder(context);
    const cache = this.#resourceCache;
    if (cache === null) {
      return;
    }
    const servedFromRunCache = this.#servedFromRunCache;
    const store = async (request: Request): Promise<void> => {
      try {
        // 要求が成功して終わった時点では、応答を受けている（受けていなければ、入れない）。
        const response = request.existingResponse();
        if (response === null) {
          return;
        }
        const fact: ResourceCacheResponseFact = {
          method: request.method(),
          resourceType: request.resourceType(),
          url: request.url(),
          requestHeaders: request.headers(),
          status: response.status(),
          responseHeaders: response.headers(),
          servedFromRunCache: servedFromRunCache.has(request),
        };
        if (!cache.mayStore(fact)) {
          return;
        }
        const body = await response.body();
        cache.store({ ...fact, body, servedFromRunCache: servedFromRunCache.has(request) });
      } catch {
        // 応答や本文を取れなかった要求は、入れない（観察の失敗は、監査の失敗ではない）。
      }
    };
    context.on('requestfinished', (request: Request): void => {
      void store(request);
    });
  }

  /**
   * SFIX-1104（SREV-1104 の I-1）: 認証の指定のある factory で、`context` がサイトの応答（許可 Origin と承認したサービスの Origin から。応答のヘッダを受けた
   * 時点。Run のキャッシュから返したものは除く）を受けるたびに、その順番を覚える（`#lastSiteResponses`）。値・URL は覚えない。例外は外に出さない。
   */
  #observeSiteResponseOrder(context: BrowserContext): void {
    if (this.#authentication === null) {
      return;
    }
    const origins = canonicalPassiveAllowedOrigins(new Set([
      ...this.#allowedOrigins,
      ...(this.#authentication.auditStage?.approvedServiceOrigins ?? []),
    ]));
    const servedFromRunCache = this.#servedFromRunCache;
    context.on('response', (response: Response): void => {
      try {
        if (!servedFromRunCache.has(response.request()) && hasAllowedOrigin(response.url(), origins)) {
          this.#lastSiteResponseSequence += 1;
          this.#lastSiteResponses.set(context, this.#lastSiteResponseSequence);
        }
      } catch {
        // 応答の事実を読めなければ、覚えない（受け継ぎは、前に覚えた順番で決める）。
      }
    });
  }

  /**
   * 役割 `role` の Context の Guard に渡す、届け方の部品を作る（サイトへの負荷の制御の設計書 4.7、4.10.3）。Run 全体のキャッシュが
   * なければ作らない（`undefined`。Guard は今のまま）。判断は `decideResourceDelivery` だけが `role` で行い、許可 Origin は Guard に
   * 渡すものと同じ値を使う。キャッシュから返した要求の印と、負荷の記録は、役割によらず同じに扱う。どの口も例外を投げない
   * （meter の例外も、ここで封じ込める）。
   * T44b（Task 44 の設計書 3.1 の P1-1）: 監査の段の送信の扱いの口（`auditSend`）がある Context は、読み込み直しの役割でも、ページが出す送信と、スクリプトで
   * 送るログインの監査の段の承認したサービスの Origin への要求を送る（`revisitSends`。サービスの Origin の要求は Guard が上限の部品で数える。監査の段の口が
   * なければ、サービスの Origin の区別はない）。
   */
  #createResourceDelivery(role: ResourceDeliveryRole, auditSend: GuardAuditSend | undefined): GuardResourceDelivery | undefined {
    const cache = this.#resourceCache;
    if (cache === null) {
      return undefined;
    }
    const allowedOrigins = this.#allowedOrigins;
    const servedFromRunCache = this.#servedFromRunCache;
    const loadMeter = this.#loadMeter;
    const revisitSends = auditSend === undefined
      ? undefined
      : Object.freeze({ serviceOrigins: new Set(this.#authentication?.auditStage?.approvedServiceOrigins ?? []) as ReadonlySet<string> });
    return Object.freeze({
      decide: (request: ResourceDeliveryRequestFacts) =>
        decideResourceDelivery({ role, cache, allowedOrigins, request, ...(revisitSends === undefined ? {} : { revisitSends }) }),
      beforeServeFromRunCache: (request: Request): void => {
        servedFromRunCache.add(request);
        try {
          loadMeter?.recordServedFromRunCache(request);
        } catch {
          // 数えるのに失敗しても、キャッシュから返す（負荷の記録の失敗は、安全には関わらない）。
        }
      },
      afterWithhold: (): void => {
        try {
          loadMeter?.recordWithheld();
        } catch {
          // 数えるのに失敗しても、外に投げない。
        }
      },
    });
  }

  /**
   * 構築の失敗を、Context の Ledger を持つ `ContextConstructionError` にする。Guard がすでに Context を閉じていれば、
   * 所有（閉じる責任）だけを解放する。Ledger との対応は残す。
   */
  #constructionFailure(context: BrowserContext, cause: unknown): ContextConstructionError {
    if (isPassiveRequestGuardClosed(context)) {
      this.#releaseContext(context);
    }
    return new ContextConstructionError(context, this.getSafetyLedger(context), cause);
  }

  /** page の所有の記録を外す。 */
  #releasePage(page: Page, context: BrowserContext): void {
    this.#ownedPages.delete(page);
    this.#contextPages.get(context)?.delete(page);
  }

  /**
   * Context の所有（閉じる責任）を解放し、その Context の page を、所有の記録（`#ownedPages`）から外す（DEF-038。page は Context と
   * 一緒に閉じた）。Context と Ledger の対応は残す。
   */
  #releaseContext(context: BrowserContext): void {
    this.#activeContexts.delete(context);
    this.#authenticatedGenerations.delete(context);
    for (const page of this.#contextPages.get(context) ?? []) {
      this.#ownedPages.delete(page);
    }
    this.#contextPages.delete(context);
  }

  #requireActiveContext(context: BrowserContext): void {
    if (!this.#activeContexts.has(context)) {
      throw new Error('BrowserContext is not owned by this factory or is no longer active');
    }
  }

  #requireActiveGuardedContext(context: BrowserContext): void {
    this.#requireActiveContext(context);
    assertPassiveRequestGuardActive(context);
  }
}
