import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page, Request } from 'playwright';
import type { AuditConfig, Viewport } from '../config/types.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import type { BlockedInteractionRequestEvent } from '../core/evidence-types.js';
import { isPositiveSafeInteger, isRecord } from '../core/guards.js';
import { AUTHENTICATED_STATE_READ_TIMEOUT_MS, MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import type { LoadMeter } from '../crawl/load-meter.js';
import type { NavigationPacer } from '../crawl/navigation-pacer.js';
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
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  isAcceptableGuardWriteStage,
  isPassiveRequestGuardClosed,
  LoginStageMonitor,
  type EgressFreezeCause,
  type GuardLoginStage,
  type GuardResourceDelivery,
  type GuardWriteStage,
  type PassiveRequestGuardOptions,
} from '../safety/passive-request-guard.js';
import {
  SUBMISSION_POST_METHOD,
  canonicalPassiveAllowedOrigins,
  classifyPassiveRequest,
  isWriteEndpointUrl,
  type AuditExclusionPolicy,
  type PassiveRequestPolicyOptions,
} from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
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
}

/**
 * 認証済みの状態（Playwright の `storageState` と同じ形。Cookie と、Origin ごとの localStorage）。秘密を含むので、値をログ、誤りの文、
 * 成果物、Evidence、保存に入れない（Task 25 の設計書 4.6）。
 */
export interface AuthenticatedStorageState {
  readonly cookies: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly expires: number;
    readonly httpOnly: boolean;
    readonly secure: boolean;
    readonly sameSite: 'Strict' | 'Lax' | 'None';
  }[];
  readonly origins: readonly {
    readonly origin: string;
    readonly localStorage: readonly { readonly name: string; readonly value: string }[];
  }[];
}

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
    case 'FROZEN':
      return freeze.frozenByInteraction ? 'INTERACTION_FROZEN_EGRESS' : null;
  }
}

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
 * 通さない）。
 */
const EGRESS_REQUEST_SHAPES = Object.freeze([
  Object.freeze({ isNavigationRequest: true, isMainFrame: true }),
  Object.freeze({ isNavigationRequest: false, isMainFrame: false }),
]);

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
        }),
      }),
    ...(writeStage === undefined
      ? {}
      : {
        writeStage: Object.freeze({
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
  });
  const origins: ReadonlySet<string> = new Set(allowedOrigins);
  return (method: string, url: string): boolean => EGRESS_REQUEST_SHAPES.some((shape) =>
    classifyPassiveRequest({ kind: 'HTTP', method, url, ...shape }, origins, policy).action === 'ALLOW');
}

/** DEF-099 fix: 書き込みの段の中継が通す、承認の送信先への POST の回数（承認された 1 回の CREATE）。 */
const WRITE_STAGE_EGRESS_POSTS = 1;

/** DEF-099 fix: 書き込みの段の中継の、承認の送信先への POST の数え方（絶対形の HTTP の要求だけ。送信先の比べ方は要求の判定の owner）。 */
const writeStageEgressBudget = (writeStage: GuardWriteStage): EgressRequestBudget => {
  const endpoint = Object.freeze({ origin: writeStage.expectation.request.origin, path: writeStage.expectation.request.path });
  return Object.freeze({
    matches: (method: string, url: string): boolean => method.toUpperCase() === SUBMISSION_POST_METHOD && isWriteEndpointUrl(url, endpoint),
    limit: WRITE_STAGE_EGRESS_POSTS,
  });
};

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

/** 認証の指定の形か（T25c。値の中身は見ない。最初の状態の形は、絞った後の写しで確かめる）。 */
function isAuthenticatedContextOptions(value: unknown): value is AuthenticatedContextOptions {
  if (!isRecord(value) || typeof value.filterState !== 'function' || !isRecord(value.initialState)) {
    return false;
  }
  const { auditExclusions } = value;
  return isRecord(auditExclusions)
    && isStringArray(auditExclusions.excludedPathPrefixes)
    && isStringArray(auditExclusions.auditPathPrefixes)
    && isStringArray(auditExclusions.dangerousTerms);
}

/**
 * ログインの段の指定の形か（T25d）: 送信先が 1 件以上の `{ origin, path }`（どちらも文字列）で、上限が 0 以上の安全な整数。値の意味（Origin の
 * 正規の形、path の形）は、要求の判定の owner（`classifyPassiveRequest` の `authSetup` の口）が判定する（合わない送信先には許さない）。
 * T26g-1: ログインの段の記録と送信の窓の口（`monitor`）は、省略するか `LoginStageMonitor` だけを受ける。
 */
function isGuardLoginStage(value: unknown): value is GuardLoginStage {
  if (!isRecord(value) || !Array.isArray(value.loginPostEndpoints) || value.loginPostEndpoints.length === 0) {
    return false;
  }
  const { maxLoginPosts } = value;
  return typeof maxLoginPosts === 'number'
    && Number.isSafeInteger(maxLoginPosts)
    && maxLoginPosts >= 0
    && (value.monitor === undefined || value.monitor instanceof LoginStageMonitor)
    && value.loginPostEndpoints.every((endpoint: unknown) => isRecord(endpoint) && isStringArray([endpoint['origin'], endpoint['path']]));
}

/** Cookie の `SameSite` の値（Playwright の `storageState` の形）。 */
const STORAGE_STATE_SAME_SITE_VALUES: readonly unknown[] = Object.freeze(['Strict', 'Lax', 'None']);

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
    return Object.freeze({ origin: entryOrigin, localStorage: Object.freeze(localStorage) });
  });
  return Object.freeze({ cookies: Object.freeze(cookies), origins: Object.freeze(origins) });
}

/** Playwright の `newContext` の `storageState` に渡す、書き換えのできる写し（T25c。メモリのまま渡す。ファイルに書かない）。 */
function playwrightStorageState(state: AuthenticatedStorageState): Exclude<BrowserContextOptions['storageState'], string | undefined> {
  return {
    cookies: state.cookies.map((cookie) => ({ ...cookie })),
    origins: state.origins.map((entry) => ({
      origin: entry.origin,
      localStorage: entry.localStorage.map((item) => ({ ...item })),
    })),
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
  readonly #authentication: Pick<AuthenticatedContextOptions, 'filterState' | 'auditExclusions'> | null;
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
    const { loadMeter, resourceCache, egressUpstreamPolicy, authentication, writeSubmissionCertificates, navigationPacer } = options;
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
      : Object.freeze({ filterState: authentication.filterState, auditExclusions: authentication.auditExclusions });
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
    const closing = this.closePassiveContext(context);
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
   * キャッシュがなければ、どちらの役割でも、Guard に届け方の部品を渡さない（すべてネットワーク。今のまま）。役割が閉じた一覧
   * （`RESOURCE_DELIVERY_ROLES`）になければ、何も作らずに `TypeError` を投げる。
   * DEF-085: 出口の中継を付ける（`#createPassiveGuardedContext`）。
   */
  async createPassiveContext(viewport: Viewport, role: ResourceDeliveryRole = 'PRIMARY'): Promise<BrowserContext> {
    if (!isResourceDeliveryRole(role)) {
      throw new TypeError('Passive browser Context role must be one of RESOURCE_DELIVERY_ROLES');
    }
    const ledger = this.#issueSafetyLedger();
    return this.#createPassiveGuardedContext(ledger, viewport, role);
  }

  /**
   * ログインの段の Context を作る（Task 25 の設計書 4.4 と、変更履歴の 2026-10-10 の T25d の Blocker の行の (3)。T25d）。Passive の Context と
   * 同じ作り方（`#createGuardedContext`。作成の指定、要求の終わりの事象、Worker の自己検査、Ledger の対応）で作り、Guard の取り付けの指定に、
   * ログインの段の指定（`loginStage`。許した送信先への main frame のナビゲーションの POST を、回数の上限まで許す）だけを加える。
   * - 認証つきの factory（監査の段。`authentication` あり）では作らない（`TypeError`。ログインの段の許可を、監査の段に持ち込まない）。
   * - 指定の形（送信先が 1 件以上の `{ origin, path }` の文字列の組、上限が 0 以上の安全な整数）が正しくなければ、何も作らずに `TypeError`。
   * - 役割は `PRIMARY`（キャッシュを渡した factory では、届け方の部品も渡す。ワーカーのログインの段の factory には、キャッシュを渡さない）。
   * page は `createPassivePage`、閉じるのは `closePassiveContext`（Passive の Context と同じ）。
   * DEF-085: 出口の中継を付ける（`#createPassiveGuardedContext`。中継の要求の方針は、ログインの段の送信先への POST も通す）。
   */
  async createLoginStageContext(viewport: Viewport, loginStage: GuardLoginStage): Promise<BrowserContext> {
    if (this.#authentication !== null) {
      throw new TypeError('An authenticated BrowserContextFactory (the audit stage) cannot create a login stage Context');
    }
    if (!isGuardLoginStage(loginStage)) {
      throw new TypeError('Login stage Context requires login POST endpoints ({ origin, path }) and a non-negative safe integer limit');
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
    const egress = await startEgressProxy({
      upstreamPolicy: this.#egressUpstreamPolicy,
      requestPolicy: passiveEgressRequestPolicy(this.#allowedOrigins, stage, this.#authentication?.auditExclusions),
      // DEF-099 fix: 書き込みの段の Context では、承認の送信先への POST を 1 回だけ通し、2 回目は止めて記録する（http の重ねの守り。送り手の
      // 1 回だけが通るはず。https はトンネルなので数えない）。
      ...(stage.writeStage === undefined ? {} : { requestBudget: writeStageEgressBudget(stage.writeStage) }),
      // DEF-085 fix round 1: 上流の失敗を、応答を作らずにそのまま伝える（接続できない相手と、本文の途中の切断の結果を、中継なしと同じに保つ）。
      upstreamFailureMode: 'PASS_THROUGH',
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
    try {
      context = await this.#createGuardedContext(ledger, viewport, role, egress, freeze, stage);
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
   */
  async #createGuardedContext(
    ledger: SafetyLedger,
    viewport: Viewport,
    role: ResourceDeliveryRole,
    egress: EgressProxy,
    freeze: EgressFreezeRecord,
    stage: SubmissionStageOptions = {},
  ): Promise<BrowserContext> {
    // DEF-044、DEF-049: Worker の自己検査が始まってから Context を作る。始められなければ、その例外のまま投げる（Context は作らない）。
    if (this.#closed) {
      throw new Error('BrowserContextFactory was closed');
    }
    await this.#workerWatch;
    if (this.#closed) {
      throw new Error('BrowserContextFactory was closed');
    }
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
    }
    // 要求の終わりの事象は、Guard の取り付けより前（最初の要求より前）に、meter に渡し始める（サイトへの負荷の制御の設計書 4.5）。
    this.#observeRequestEnds(context);
    // 成功して終わった要求の応答の事実も、同じく最初の要求より前から、Run 全体のキャッシュに渡し始める（設計書 4.6、4.10.3）。
    this.#observeResponses(context);

    // Context と Ledger の対応は、構築に失敗しても消さない（`getSafetyLedger` で後から取り出せるようにする。設計書 4.3）。
    this.#contextLedgers.set(context, ledger);
    this.#activeContexts.add(context);
    // 届け方の部品は、Run 全体のキャッシュがある場合に、役割によらず渡す（設計書 4.7、4.10.3）。
    const resourceDelivery = this.#createResourceDelivery(role);
    // T25c: 認証つきの Run の Guard には、監査の段の除外を渡す（ログインの段の指定は渡さない。監査の段では POST を許さない）。
    const navigationPacer = this.#navigationPacer;
    const guardOptions: PassiveRequestGuardOptions = Object.freeze({
      ...(resourceDelivery === undefined ? {} : { resourceDelivery }),
      ...(this.#authentication === null ? {} : { auditExclusions: this.#authentication.auditExclusions }),
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
      // DEF-100 fix: main frame の文書の要求を送った時刻を、Run の読み込みの間隔の部品に記録する（サイトに届く間隔を設定以上にする）。
      ...(navigationPacer === null ? {} : { onMainFrameDocumentSent: (): void => navigationPacer.recordDocumentRequestSent() }),
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
      context = await this.#createGuardedContext(ledger, viewport, 'REVISIT', proxy, freeze);
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

  getSafetyLedger(context: BrowserContext): SafetyLedger {
    const ledger = this.#contextLedgers.get(context);
    if (ledger === undefined) {
      throw new Error('BrowserContext is not owned by this factory');
    }
    return ledger;
  }

  async createPassivePage(context: BrowserContext): Promise<Page> {
    this.#requireActiveGuardedContext(context);
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

  async closePassiveContext(context: BrowserContext): Promise<void> {
    // DEF-044、DEF-049、DEF-085: factory が自分で閉じ始めた Context は、その閉じる処理に合流する。
    const factoryClose = this.#factoryInitiatedCloses.get(context);
    if (factoryClose !== undefined) {
      return factoryClose;
    }
    this.#requireActiveContext(context);
    // T25c: 認証つきの Context は、閉じる前に状態を取り出し、絞ってから、その世代が今の世代以上なら受け継ぐ状態にする（失敗は数えて進む）。
    const generation = this.#authenticatedGenerations.get(context);
    if (generation !== undefined && !isPassiveRequestGuardClosed(context)) {
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
    const outcome = await awaitBeforeDeadline(
      (async (): Promise<AuthenticatedStorageState> =>
        authenticatedStateCopy(authentication.filterState(await context.storageState())))(),
      Date.now() + AUTHENTICATED_STATE_READ_TIMEOUT_MS,
    );
    if (outcome.status !== 'FULFILLED') {
      this.#authenticatedStateReadFailures += 1;
      return;
    }
    if (generation >= this.#authenticatedState.generation) {
      this.#authenticatedState = Object.freeze({ state: outcome.value, generation });
    }
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
   */
  #createResourceDelivery(role: ResourceDeliveryRole): GuardResourceDelivery | undefined {
    const cache = this.#resourceCache;
    if (cache === null) {
      return undefined;
    }
    const allowedOrigins = this.#allowedOrigins;
    const servedFromRunCache = this.#servedFromRunCache;
    const loadMeter = this.#loadMeter;
    return Object.freeze({
      decide: (request: ResourceDeliveryRequestFacts) =>
        decideResourceDelivery({ role, cache, allowedOrigins, request }),
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
