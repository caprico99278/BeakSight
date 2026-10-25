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
import { AUTHENTICATED_STATE_READ_TIMEOUT_MS, MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
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
  type EgressUpstreamPolicy,
} from '../safety/egress-proxy.js';
import {
  announcePageLeave,
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  isAcceptableGuardWriteStage,
  isGuardApiWriteStage,
  isGuardAuditSend,
  isPassiveRequestGuardClosed,
  AuditStageMonitor,
  LoginStageMonitor,
  type EgressFreezeCause,
  type GuardAuditSend,
  type GuardAuditStage,
  type GuardLoginStage,
  type GuardResourceDelivery,
  type GuardApiWriteStage,
  type GuardFormWriteStage,
  type GuardScriptLogin,
  type GuardWriteStage,
  type PassiveRequestGuardOptions,
} from '../safety/passive-request-guard.js';
import {
  SUBMISSION_POST_METHOD,
  canonicalPassiveAllowedOrigins,
  classifyPassiveRequest,
  hasAllowedOrigin,
  isApiWriteCheckTarget,
  isApiWriteEndpointUrl,
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
import { isLoginCredentialGuard } from '../safety/login-credential-guard.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
import { SubmissionObservation } from '../safety/submission-observation.js';
import { ensureElementPathEngine } from './element-path-engine.js';
import { registerEgressUpstreamAddressSource } from './navigation-diagnostics.js';
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
   * 状態の受け継ぎは、世代つき（`#inheritedAuthenticatedState`、`#captureAuthenticatedState`）。
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
}

/**
 * スクリプトで送るログインの監査の段の口（T35a。Task 35 の設計書 3.2、3.4。平らなデータ。`src/control/` を読まない）。値は、ワーカーが認証の設定 v3 と
 * プロファイルから作る（`src/worker/audit-stage-requests.ts`）。
 * - `approvedServiceOrigins`: 承認したサービスの Origin（数える区分。上限の対象）。
 * - `auditReadRequests`: 監査の段で通す、読み取りのための手続きの呼び出し（`POST`。1 回の読み込みあたりの回数の上限つき。既定は空）。
 * - `scriptLogin`: token の送信先（更新などの token の送信を見分けて止める）。
 * - `serviceRequestLimits`: 承認したサービスの Origin への要求の上限（1 分あたり、1 回の Run あたり。項目がなければ上限の値）。
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
  readonly serviceRequestLimits: { readonly perMinute: number; readonly perRun: number };
}

/** 受け継ぐ状態と、その状態を取り出した Context の世代（最初の状態は 0）。 */
interface GenerationalAuthenticatedState {
  readonly state: AuthenticatedStorageState;
  readonly generation: number;
}

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
 * DEF-125: 中継の CONNECT の受け入れ（`tunnelAdmission`）の、知らせのない CONNECT が知らせを待つ時間（ms）。
 * 値の根拠（DEF-125-fix の実験。Chromium 151、Playwright 1.62.1）: CLI の `channel: 'chromium'` の `chrome.exe` は、ナビゲーションの宛先への CONNECT を、
 * Guard がその文書の要求を判定して進める約 2〜5 ms 前に始める（テストの既定の headless shell は、判定の後に始める）。待たずに拒むと（0 ms）、読み込みは
 * 新しい CONNECT で成功したが、拒んだ CONNECT が記録に残った（6 場面の 6 回）。1 秒待つと、記録は残らなかった。Guard が判定しないナビゲーション
 * （Guard が止めた、許可 Origin の外への main frame の移動）の先への CONNECT は、待った後に拒んで記録する。
 */
export const EGRESS_TUNNEL_ADMISSION_WAIT_MS = 1_000;
/** DEF-125: factory が作るすべての中継（Passive・ログインの段・書き込みの段・Interaction）に渡す CONNECT の受け入れ。 */
const EGRESS_TUNNEL_ADMISSION = Object.freeze({ waitMs: EGRESS_TUNNEL_ADMISSION_WAIT_MS });

/**
 * T44b（Task 44 の設計書 3.1 の P1-2 と、設計の変更の履歴の「T44b の報告」の行）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の、ページの監査の読み込みの
 * Context（`PRIMARY` で印 `pageAuditLoad` のあるもの。Desktop と Mobile）を、持ち主が閉じる（`closePassiveContext`）ときの手順の、ページを離れた後に待つ時間
 * （ms。1 回の閉じ方あたりの上限）。
 * 手順: 認証の状態を読む → ページを離れる（`AUDIT_SEND_PAGE_LEAVE_URL` へ移る。人がページを閉じるのと同じ自然な動き）→ この時間だけ待つ → 閉じる。
 * ページを離れるときに出る送信（`pagehide`・`visibilitychange`・`unload` の beacon、keepalive の fetch など）を、Guard の今の判定（`DELETE`・危険な語などは
 * 止める）で通して自然に終えさせる。その間も Guard の段階は `PASSIVE_ACTIVE` のまま（閉じ方の段の順は変えない）。閉じ始めた後の送信は、今どおり止める。
 * 待たず、ページも離れないもの: `READ_ONLY`（口のない Context）、印のない `PRIMARY` の Context（robots.txt・sitemap.xml・準備の読み込みなど）、幅の走査の
 * Context（`REVISIT`。同じページの送信の繰り返しのため）、Interaction・ログインの段・書き込みの段の Context、factory が自分で閉じる（違反などの）Context。
 * ページを離れた後の要求は、そのページの読み取りの判定の数（DEF-130 の文書でない要求の数と上限）に入れない（Guard の `announcePageLeave`）。
 */
export const AUDIT_SEND_CLOSE_SETTLE_MS = 1_000;

/**
 * T44b（設計者の判断の (1)）: `createPassiveContext` の省略できる指定。
 * - `pageAuditLoad`: ページの監査の読み込み（Desktop と Mobile）の印。付けるのは、ページの監査の読み込みの作り手（`page-auditor.ts`）だけ。役割が
 *   `PRIMARY` で、監査の段の送信の扱いの口がある factory のときだけ働く（持ち主が閉じるときに、ページを離れて `AUDIT_SEND_CLOSE_SETTLE_MS` だけ待つ）。
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
 * Passive・ログインの段・書き込みの段の Context の中継の要求の方針（DEF-085。T30b で書き込みの段を足した）: その Context の Guard の許可
 * （許可 Origin、読み取りの方法、ログインの段の送信先、書き込みの段の承認の要求の形の送信先、監査の段の除外）を、中継から見た範囲にしたもの。
 * 判定は要求の判定の owner（`classifyPassiveRequest`）に任せる（第二の owner を置かない）。Guard の段階の状態（送信の窓、POST の回数）と、
 * 書き込みの段の送る中身は見ない（Guard が数えて照合して止める。中継は本文を見ない）。指定は作る時点の写しを使う。絶対形の HTTP の要求だけに
 * 当たる（https の CONNECT の中身は中継から見えないので、強制は Guard）。
 */
function passiveEgressRequestPolicy(
  allowedOrigins: ReadonlySet<string>,
  stage: SubmissionStageOptions,
  auditExclusions: AuditExclusionPolicy | undefined,
  auditStage: AuditStageServiceRequests | undefined,
  role: ResourceDeliveryRole,
  auditSend: GuardAuditSend | undefined,
  readAdmissions: EgressReadAdmissions,
): EgressRequestPolicy {
  const copy = (values: readonly string[]): readonly string[] => Object.freeze(values.map((value) => String(value)));
  const { loginStage, writeStage } = stage;
  const policy: PassiveRequestPolicyOptions = Object.freeze({
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
          })
          : Object.freeze({
            writeEndpoint: Object.freeze({ origin: writeStage.expectation.request.origin, path: writeStage.expectation.request.path }),
            remainingPosts: EGRESS_LOGIN_POST_REMAINING,
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
    // AS-a: 監査の段の送信の扱いの口（通す数は Guard が数える。中継は残り 1 とする。Guard より広くは通さない）。
    ...(auditSend === undefined ? {} : { auditSend: egressAuditSendPolicy(auditSend) }),
  });
  const origins: ReadonlySet<string> = new Set(allowedOrigins);
  // T39c: API の書き込みの段では、送り手の 1 回の送信（承認した API の Origin と path の型への `POST`・`PATCH`。query は問わない）も通す。中継は、
  // ページのスクリプトの要求か・送信の窓・照合を知らないので、送信先の形だけを要求の判定の owner の部品で見て、回数は予算（`apiWriteStageEgressBudget`）が
  // 1 回に限る（Guard が照合して送り手に送らせる 1 回のほかは、Guard を迂回した要求）。
  const apiWrite = writeStage !== undefined && isGuardApiWriteStage(writeStage) ? apiWriteEndpointOf(writeStage) : null;
  // BN-R0 fix round 1（I-1）: 中継は、要求の種類も main frame の移動かも分からないので、監査の段の除外は、ページの文書でない読み取りにも当てる形（BN-0 の前と同じ。
  // `applyToPageSubresourceReads`）で判定する。その形で通さない GET・HEAD のうち、BN-0 の決まりの形（ページの文書でない読み取りには当てない）なら通すものは、
  // この Context の Guard が通した（`readAdmissions` に知らせた）要求だけを通す（Guard を迂回した要求の 2 段目の守り）。
  const strictPolicy: PassiveRequestPolicyOptions = policy.auditExclusions === undefined
    ? policy
    : Object.freeze({ ...policy, auditExclusions: Object.freeze({ ...policy.auditExclusions, applyToPageSubresourceReads: true as const }) });
  const allowedBy = (target: PassiveRequestPolicyOptions, method: string, url: string): boolean => EGRESS_REQUEST_SHAPES.some((shape) =>
    classifyPassiveRequest({ kind: 'HTTP', method, url, ...shape }, origins, target).action === 'ALLOW');
  return (method: string, url: string): boolean => allowedBy(strictPolicy, method, url)
    || (apiWrite !== null && isApiWriteEndpointRequest(method, url, apiWrite))
    || (isReadMethod(method) && readAdmissions.has(method, url) && allowedBy(policy, method, url));
}

/**
 * BN-R0 fix round 1（I-1）: その Context の Guard が通した（`decideGuardRequest` の `ALLOW`）、読み取り（GET・HEAD）の要求の method と URL の写し（中継の要求の
 * 方針が使う。`passiveEgressRequestPolicy`）。Guard の口（`onEgressDestinationAdmitted`）が、命令を送る前に同期で知らせる。URL は fragment を外した正規の形で比べる。
 * 数は上限（`MAX_EGRESS_READ_ADMISSIONS`）までで、超えたら古いものから捨てる（捨てた要求の 2 回目は、中継が拒んで記録する。fail-closed の側）。
 */
export const MAX_EGRESS_READ_ADMISSIONS = 4_096;

class EgressReadAdmissions {
  readonly #keys = new Set<string>();

  admit(method: string | undefined, url: string): void {
    if (method === undefined || !isReadMethod(method)) {
      return;
    }
    const key = egressReadAdmissionKeyOf(method, url);
    if (key === null) {
      return;
    }
    this.#keys.delete(key);
    this.#keys.add(key);
    while (this.#keys.size > MAX_EGRESS_READ_ADMISSIONS) {
      const oldest = this.#keys.values().next();
      if (oldest.done === true) {
        break;
      }
      this.#keys.delete(oldest.value);
    }
  }

  has(method: string, url: string): boolean {
    const key = egressReadAdmissionKeyOf(method, url);
    return key !== null && this.#keys.has(key);
  }
}

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
function egressAuditSendPolicy(send: GuardAuditSend): AuditSendPolicy {
  return Object.freeze({
    approvedServiceOrigins: Object.freeze([...send.approvedServiceOrigins]),
    dangerousTerms: Object.freeze([...send.dangerousTerms]),
    remainingPasses: EGRESS_LOGIN_POST_REMAINING,
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
/** T39R-fix（M-1）: API の書き込みの段の、承認の endpoint（承認した API の Origin と path の型）。 */
const apiWriteEndpointOf = (writeStage: GuardApiWriteStage): SubmissionEndpoint =>
  Object.freeze({ origin: writeStage.expectation.spec.request.origin, path: writeStage.expectation.spec.request.pathShape });

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
const apiWriteStageEgressBudget = (writeStage: GuardApiWriteStage): EgressRequestBudget => {
  const endpoint = apiWriteEndpointOf(writeStage);
  return Object.freeze({
    matches: (method: string, url: string): boolean => isApiWriteEndpointRequest(method, url, endpoint),
    limit: WRITE_STAGE_EGRESS_POSTS,
  });
};

const writeStageEgressBudget = (writeStage: GuardFormWriteStage): EgressRequestBudget => {
  const endpoint = Object.freeze({ origin: writeStage.expectation.request.origin, path: writeStage.expectation.request.path });
  return Object.freeze({
    matches: (method: string, url: string): boolean => method.toUpperCase() === SUBMISSION_POST_METHOD && isWriteEndpointUrl(url, endpoint),
    limit: WRITE_STAGE_EGRESS_POSTS,
  });
};

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

/** 要求の終わりの事象を受け取れる meter か（`recordRequestFinished` と `recordRequestFailed` の関数を持つ）。 */
function recordsRequestEnds(value: unknown): boolean {
  return isRecord(value)
    && typeof value.recordRequestFinished === 'function'
    && typeof value.recordRequestFailed === 'function';
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
 * `{ origin, path, requiredQuery: { name, value }[] }`、上限が `{ perMinute, perRun }`（正の整数）。
 */
export function isAuditStageServiceRequests(value: unknown): value is AuditStageServiceRequests {
  if (!isRecord(value) || !isStringArray(value.approvedServiceOrigins) || !Array.isArray(value.auditReadRequests)) {
    return false;
  }
  const { scriptLogin, serviceRequestLimits } = value;
  return value.auditReadRequests.every((request: unknown) => isRecord(request)
      && isStringArray([request['origin'], request['path'], request['method']])
      && isPositiveSafeInteger(request['maxPerPageLoad']))
    && isRecord(scriptLogin)
    && isStringArray([scriptLogin['origin'], scriptLogin['path']])
    && Array.isArray(scriptLogin['requiredQuery'])
    && (scriptLogin['requiredQuery'] as readonly unknown[]).every((parameter) =>
      isRecord(parameter) && isStringArray([parameter['name'], parameter['value']]))
    && isRecord(serviceRequestLimits)
    && isPositiveSafeInteger(serviceRequestLimits['perMinute'])
    && isPositiveSafeInteger(serviceRequestLimits['perRun']);
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
    && (value.sessionKeyPresent === undefined || typeof value.sessionKeyPresent === 'function');
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
   * DEF-138: Context ごとの、渡した状態と最後に読んだ状態の名前（値を持たない。`authenticatedStateNamesOf`）。認証つきの Context だけ。Context と一緒に
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
   * T44b（P1-2）: 監査の段の送信の扱いの口（`auditSend`）を Guard に渡した、ページの監査の読み込みの Context（`PRIMARY` で、`createPassiveContext` の印
   * `pageAuditLoad` のあるもの。Desktop と Mobile）。持ち主が閉じるときに、ページを離れてから `AUDIT_SEND_CLOSE_SETTLE_MS` だけ待つ。
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
  readonly #authentication: Pick<AuthenticatedContextOptions, 'filterState' | 'auditExclusions' | 'auditStage' | 'sessionKeyPresent'> | null;
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
  /**
   * 受け継ぐ認証済みの状態と、その世代（T25c。Task 25 の設計書 4.3 の 2026-10-10 の Blocker の行）。Run の中で 1 つだけ持ち、Context を作る
   * とき（生きている、より新しい世代の Context から読む）と、閉じるとき（その世代が今の世代以上なら置き換える）に更新する。認証の指定が
   * なければ `null`。
   */
  #authenticatedState: GenerationalAuthenticatedState | null;
  /** 認証の指定のある factory が作った Context のうち、まだ所有している（閉じていない）ものの世代（作った順に 1 から振る）。 */
  readonly #authenticatedGenerations = new Map<BrowserContext, number>();
  /** 最後に振った世代。 */
  #lastAuthenticatedGeneration = INITIAL_AUTHENTICATED_STATE_GENERATION;
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
      loadMeter, resourceCache, egressUpstreamPolicy, authentication, writeSubmissionCertificates, navigationPacer, serviceRequestBudget, auditStageMonitor,
      onServiceUnauthorizedResponse, onSessionKeyLost, auditSend,
    } = options;
    // AS-a: 監査の段の送信の扱いの指定は、Guard と同じ確かめ（`isGuardAuditSend`）で受ける。
    if (auditSend !== undefined && !isGuardAuditSend(auditSend)) {
      throw new TypeError('BrowserContextFactory audit send policy is malformed');
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
    this.#resourceCache = resourceCache ?? null;
    this.#egressUpstreamPolicy = egressUpstreamPolicy ?? ALLOW_ALL_EGRESS_UPSTREAMS;
    this.#writeSubmissionCertificates = writeSubmissionCertificates === undefined ? undefined : Object.freeze([...writeSubmissionCertificates]);
    this.#authentication = authentication === undefined
      ? null
      : Object.freeze({
        filterState: authentication.filterState,
        auditExclusions: authentication.auditExclusions,
        // T35b: スクリプトで送るログインの監査の段の口（ある場合だけ。Guard と中継が写しを取る）。
        ...(authentication.auditStage === undefined ? {} : { auditStage: authentication.auditStage }),
        // T35c: ログインの状態の鍵があるかの判定（ある場合だけ）。
        ...(authentication.sessionKeyPresent === undefined ? {} : { sessionKeyPresent: authentication.sessionKeyPresent }),
      });
    this.#serviceRequestBudget = serviceRequestBudget ?? null;
    this.#auditStageMonitor = auditStageMonitor ?? null;
    this.#onServiceUnauthorizedResponse = onServiceUnauthorizedResponse ?? null;
    this.#onSessionKeyLost = onSessionKeyLost ?? null;
    this.#auditSend = auditSend === undefined
      ? null
      : Object.freeze({
        policy: auditSend.policy,
        approvedServiceOrigins: Object.freeze([...auditSend.approvedServiceOrigins]),
        dangerousTerms: Object.freeze([...auditSend.dangerousTerms]),
        ...(auditSend.maxPassedPerContext === undefined ? {} : { maxPassedPerContext: auditSend.maxPassedPerContext }),
        // AS-c: WebSocket の接続の上限（あるときだけ）。
        ...(auditSend.maxWebSocketsPerContext === undefined ? {} : { maxWebSocketsPerContext: auditSend.maxWebSocketsPerContext }),
      });
    this.#authenticatedState = initialState === null
      ? null
      : Object.freeze({ state: initialState, generation: INITIAL_AUTHENTICATED_STATE_GENERATION });
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
  async createPassiveContext(viewport: Viewport, role: ResourceDeliveryRole = 'PRIMARY', options: PassiveContextOptions = {}): Promise<BrowserContext> {
    if (!isResourceDeliveryRole(role)) {
      throw new TypeError('Passive browser Context role must be one of RESOURCE_DELIVERY_ROLES');
    }
    const ledger = this.#issueSafetyLedger();
    const context = await this.#createPassiveGuardedContext(ledger, viewport, role);
    // T44b（設計者の判断の (1)）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の、ページの監査の読み込み（`PRIMARY` で印 `pageAuditLoad` のある Context）だけ、
    // 持ち主が閉じるときにページを離れて待つ。robots.txt・sitemap.xml・準備の読み込みなどの `PRIMARY` の Context（印なし）と、幅の走査（`REVISIT`）は当てない。
    if (options.pageAuditLoad === true && role === 'PRIMARY' && this.#auditSend !== null) {
      this.#pageLeaveContexts.add(context);
    }
    return context;
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
    return this.#createPassiveGuardedContext(ledger, viewport, 'PRIMARY', { loginStage });
  }

  /**
   * 書き込みの段の Context を作る（T30b。Task 30 の設計書 3 章の「書き込みの段」、4 章）。認証つきの Run の Context と同じ作り方
   * （`#createPassiveGuardedContext`。ログインの後の状態、監査の段の除外、出口の中継、Worker の自己検査、Ledger の対応）で作り、Guard の取り付けの
   * 指定に、書き込みの段の指定（`writeStage`。承認の要求の形の POST を、送る中身の照合が `ALLOW` のときに 1 回だけ許す）を加える。
   * - 認証のない factory では作らない（`TypeError`。書き込みは、ログインの後の状態を持つ Run だけが送る）。
   * - 指定の形が正しくない、部品（`WriteStageMonitor`）がすでに別の Guard に付いている、は何も作らずに `TypeError`（`isAcceptableGuardWriteStage`）。
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
    if (!isAcceptableGuardWriteStage(writeStage)) {
      throw new TypeError('Write stage Context requires an expectation and a WriteStageMonitor that is not attached to another Guard');
    }
    const ledger = this.#issueSafetyLedger();
    return this.#createPassiveGuardedContext(ledger, viewport, 'PRIMARY', { writeStage });
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
    // AS-a: 監査の段の送信の扱いは、Passive の Context（ログインの段と書き込みの段でない）だけに渡す（Guard と中継の両方）。
    const auditSend = stage.loginStage === undefined && stage.writeStage === undefined ? this.#auditSend ?? undefined : undefined;
    // BN-R0 fix round 1（I-1）: この Context の Guard が通した読み取りの写し（中継の要求の方針が使う。Guard の口が知らせる）。
    const readAdmissions = new EgressReadAdmissions();
    const egress = await startEgressProxy({
      upstreamPolicy: this.#egressUpstreamPolicy,
      requestPolicy: passiveEgressRequestPolicy(
        this.#allowedOrigins,
        stage,
        this.#authentication?.auditExclusions,
        // T39b: API の書き込みの段も、監査の段の口を渡す（承認したサービスの Origin への読み取り）。
        stage.writeStage === undefined || isGuardApiWriteStage(stage.writeStage) ? this.#authentication?.auditStage : undefined,
        role,
        auditSend,
        readAdmissions,
      ),
      // DEF-099 fix: 書き込みの段の Context では、承認の送信先への POST を 1 回だけ通し、2 回目は止めて記録する（http の重ねの守り。送り手の
      // 1 回だけが通るはず。https はトンネルなので数えない）。T39c: API の書き込みの段は、承認した API の Origin への `POST`・`PATCH` を 1 回。
      ...(stage.writeStage === undefined
        ? {}
        : { requestBudget: isGuardApiWriteStage(stage.writeStage) ? apiWriteStageEgressBudget(stage.writeStage) : writeStageEgressBudget(stage.writeStage) }),
      // DEF-085 fix round 1: 上流の失敗を、応答を作らずにそのまま伝える（接続できない相手と、本文の途中の切断の結果を、中継なしと同じに保つ）。
      upstreamFailureMode: 'PASS_THROUGH',
      // DEF-125: CONNECT は、この Context の Guard が通した要求の宛先だけを通す（Guard が `admitTunnelDestinationOf` で知らせる）。
      tunnelAdmission: EGRESS_TUNNEL_ADMISSION,
      onRejected: ({ method, url, phase }): void => {
        const reason = egressRejectionReason(phase, freeze);
        if (reason !== null) {
          ledger.recordBlockedInteractionRequest({ method, url, reason });
        }
      },
      onError: (error): void => {
        ledger.recordInvariantViolation({ code: 'EGRESS_PROXY_FAILED', message: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) });
        if (context !== undefined) {
          this.#beginFactoryClose(context);
        }
      },
    });
    // BN-R0 fix round 1（I-1）: Guard の知らせの口（`#createGuardedContext`）が、この中継の読み取りの写しに書く。
    this.#egressReadAdmissions.set(egress, readAdmissions);
    try {
      context = await this.#createGuardedContext(ledger, viewport, role, egress, freeze, stage, auditSend);
    } catch (error) {
      if (!(error instanceof ContextConstructionError)) {
        await egress.close();
      }
      throw error;
    }
    // DEF-085 fix round 2: 診断の記録が、中継の待ち受けのアドレスの代わりに、上流の相手のアドレスを記録できるようにする（page を作る前）。
    registerEgressUpstreamAddressSource(context, Object.freeze({
      listenAddress: new URL(egress.server).hostname,
      listenPort: egress.port,
      upstreamAddressOf: (host: string, port: number) => egress.upstreamAddressOf(host, port),
    }));
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
    if (auditSend !== undefined && (stage.loginStage !== undefined || stage.writeStage !== undefined)) {
      throw new TypeError('The audit send policy is only for a Passive Context');
    }
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
      }
    }
    // 要求の終わりの事象は、Guard の取り付けより前（最初の要求より前）に、meter に渡し始める（サイトへの負荷の制御の設計書 4.5）。
    this.#observeRequestEnds(context);
    // T35c: 承認したサービスの Origin からの 401 の応答を数えさせる（監査の段の口があるときだけ。最初の要求より前から）。
    this.#observeServiceUnauthorizedResponses(context);
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
    // Origin は、認証の指定の監査の段の口の承認したサービスの Origin（なければ空）。
    const submissionObservation = role === 'PRIMARY' && stage.loginStage === undefined && stage.writeStage === undefined
      ? new SubmissionObservation({
        approvedApiOrigins: this.#authentication?.auditStage?.approvedServiceOrigins ?? [],
        allowedOrigins: [...this.#allowedOrigins],
      })
      : undefined;
    if (submissionObservation !== undefined) {
      this.#submissionObservations.set(context, submissionObservation);
    }
    const guardOptions: PassiveRequestGuardOptions = Object.freeze({
      ...(resourceDelivery === undefined ? {} : { resourceDelivery }),
      // BN-0（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.0）: Isolated Interaction Context だけは、ページが出す文書でない読み取りにも
      // 監査の段の除外を当てる（印 `applyToPageSubresourceReads`）。監査の段の Passive の Context は当てない（ログインの段・書き込みの段は判定の口が当てる）。
      ...(this.#authentication === null
        ? {}
        : {
          auditExclusions: contextKind === 'INTERACTION'
            ? Object.freeze({ ...this.#authentication.auditExclusions, applyToPageSubresourceReads: true as const })
            : this.#authentication.auditExclusions,
        }),
      // T35b: スクリプトで送るログインの監査の段（認証つきの factory の、書き込みの段でない Context だけ）。
      ...guardAuditStage,
      // AS-a: 監査の段の送信の扱い（Passive の Context だけ。Isolated Interaction Context には渡さない）。
      ...(auditSend === undefined ? {} : { auditSend }),
      // AS-c fix round 1（I-1）: ほかの Origin への CORS の事前確認を、Guard がこの Context の中継を通してサーバへ送る送り手（送信の扱いの口と一緒だけ）。
      ...(auditSend === undefined
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
        freezeEgressFor(egress, freeze, cause);
      },
      // DEF-125: Guard が通した要求の宛先を、この Context の中継に知らせる（中継は、知らせた宛先への CONNECT だけを通す）。
      onEgressDestinationAdmitted: (url: string, method?: string): void => {
        egress.admitTunnelDestinationOf(url);
        // BN-R0 fix round 1（I-1）: Guard が通した読み取りを、中継の要求の方針に知らせる（Passive の Context の中継だけが写しを持つ）。
        this.#egressReadAdmissions.get(egress)?.admit(method, url);
      },
      // DEF-100 fix: main frame の文書の要求を送った時刻を、Run の読み込みの間隔の部品に記録する（サイトに届く間隔を設定以上にする）。
      ...(navigationPacer === null ? {} : { onMainFrameDocumentSent: (): void => navigationPacer.recordDocumentRequestSent() }),
      // T37b: 送らずに観察する probe の口（PRIMARY の Passive の Context だけ）。
      ...(submissionObservation === undefined ? {} : { submissionObservation }),
      // DEF-129: Passive の Context（ログインの段と書き込みの段を除く）では、ページが始めた main frame の読み込みの回数に上限を置く。
      ...(stage.loginStage === undefined && stage.writeStage === undefined ? { pageNavigationLimit: true } : {}),
    });
    try {
      await installPassiveRequestGuard(context, ledger, this.#allowedOrigins, guardOptions);
    } catch (error) {
      throw this.#constructionFailure(context, error);
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
    const proxy = await startEgressProxy({
      upstreamPolicy: this.#egressUpstreamPolicy,
      // DEF-125: CONNECT は、この Context の Guard が通した要求の宛先だけを通す（Passive の Context と同じ）。
      tunnelAdmission: EGRESS_TUNNEL_ADMISSION,
      onRejected: ({ method, url, phase }): void => {
        const reason = egressRejectionReason(phase, freeze);
        if (reason !== null) {
          ledger.recordBlockedInteractionRequest({ method, url, reason });
        }
      },
      onError: (error): void => {
        ledger.recordInvariantViolation({ code: 'EGRESS_PROXY_FAILED', message: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) });
        if (egressFailure === null && context !== undefined && this.#activeContexts.has(context)) {
          egressFailure = this.closePassiveContext(context);
          egressFailure.catch(() => undefined);
        }
      },
    });
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
   * 持ち主が Context を閉じる。T44b（Task 44 の設計書 3.1 の P1-2 と、設計の変更の履歴の「T44b の報告」の行）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の
   * 最初の読み込みの Context（`#pageLeaveContexts`）で、Guard がまだ有効（`PASSIVE_ACTIVE`）なら、閉じ始める前に次を行う（1 回の閉じ方あたり、待つのは
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
    if (!this.#pageLeaveContexts.has(context) || !isGuardActive(context)) {
      return this.#closeContextNow(context, false);
    }
    const generation = this.#authenticatedGenerations.get(context);
    if (generation !== undefined) {
      await this.#captureAuthenticatedState(context, generation);
    }
    await this.#leavePagesBeforeClose(context);
    await wait(AUDIT_SEND_CLOSE_SETTLE_MS);
    const closingByFactory = this.#factoryInitiatedCloses.get(context);
    if (closingByFactory !== undefined) {
      return closingByFactory;
    }
    return this.#closeContextNow(context, true);
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
   * `undefined`。今の状態より新しい世代の、生きている（Guard が閉じていない）認証つきの Context があれば、そのうち最も新しい世代の Context の
   * 状態を読み、今の状態にしてから返す（Desktop の Context を開いたまま、幅の走査の Context を作る場合に、Desktop が読み込みで受けた最新の状態を
   * 渡すため）。読めなければ、数えて、今の状態のまま返す。
   */
  async #inheritedAuthenticatedState(): Promise<AuthenticatedStorageState | undefined> {
    if (this.#authenticatedState === null) {
      return undefined;
    }
    let newest: { readonly context: BrowserContext; readonly generation: number } | undefined;
    for (const [context, generation] of this.#authenticatedGenerations) {
      if (
        generation > this.#authenticatedState.generation
        && (newest === undefined || generation > newest.generation)
        && !isPassiveRequestGuardClosed(context)
      ) {
        newest = { context, generation };
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
    return outcome.status === 'FULFILLED' ? { status: 'FULFILLED', value: outcome.value } : { status: 'FAILED' };
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
   * 確かめた写しにする。世代が今の状態の世代以上なら、今の状態を置き換える（古い世代の状態で、新しい状態を上書きしない）。取り出し・絞り込み・
   * 写しのどれかに失敗するか、期限を過ぎたら、今の状態のまま、失敗の回数を数える（値や誤りの文は記録しない）。投げない。
   */
  async #captureAuthenticatedState(context: BrowserContext, generation: number): Promise<void> {
    const authentication = this.#authentication;
    if (authentication === null || this.#authenticatedState === null) {
      return;
    }
    // T37R-fix-B（T37R の I-1）: probe を行った Context は、押す前に読んだ状態を使う（読み直さない）。
    const outcome = this.#pinnedAuthenticatedStates.has(context)
      ? this.#pinnedOutcomeOf(context)
      : await this.#readAuthenticatedState(context);
    if (outcome.status !== 'FULFILLED') {
      this.#authenticatedStateReadFailures += 1;
      return;
    }
    // T35c（Task 35 の設計書 3.5）: 読み直した状態に、ログインの状態の鍵がなければ、知らせる（値は読まない。判定は渡された関数）。
    // AS-c の Blocker の判断 B2（監査の段の送信の扱いの設計書 5 章）: そのときは、監査の段の送信の扱いによらず、次の Context に渡す状態を置き換えない（切れた
    // 状態で上書きしない）。鍵の判定のない設定は、今どおり置き換える（状態で切れを見分けられない。path によるセッションの切れで止まる）。
    const { sessionKeyPresent } = authentication;
    if (sessionKeyPresent !== undefined && !sessionKeyPresent(outcome.value)) {
      this.#onSessionKeyLost?.();
      return;
    }
    if (generation >= this.#authenticatedState.generation) {
      this.#authenticatedState = Object.freeze({ state: outcome.value, generation });
    }
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
