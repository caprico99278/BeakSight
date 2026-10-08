import type { Browser, BrowserContext, BrowserContextOptions, CDPSession, Page, Request } from 'playwright';
import type { AuditConfig, Viewport } from '../config/types.js';
import { safeErrorMessage } from '../core/errors.js';
import type { BlockedInteractionRequestEvent } from '../core/evidence-types.js';
import { isPositiveSafeInteger, isRecord } from '../core/guards.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../core/limits.js';
import type { LoadMeter } from '../crawl/load-meter.js';
import {
  ALLOW_ALL_EGRESS_UPSTREAMS,
  startEgressProxy,
  type EgressRejection,
  type EgressUpstreamPolicy,
} from '../safety/egress-proxy.js';
import {
  assertPassiveRequestGuardActive,
  activateInteractionFreeze,
  awaitPassiveRequestGuardReady,
  closePassiveGuardedContext,
  closePassiveGuardedPage,
  installPassiveRequestGuard,
  isPassiveRequestGuardClosed,
  type GuardResourceDelivery,
  type PassiveRequestGuardOptions,
} from '../safety/passive-request-guard.js';
import { canonicalPassiveAllowedOrigins } from '../safety/request-policy.js';
import { SafetyLedger } from '../safety/safety-ledger.js';
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
   * Interaction の Context の出口の中継（`src/safety/egress-proxy.ts`）の上流の方針（DEF-039・DEF-040 の設計書 2.1.1、2.1.2）。
   * 省略すると production の方針（`ALLOW_ALL_EGRESS_UPSTREAMS`。すべての host を許す）。テストは、127.0.0.1 だけを許す方針を注入する
   * （実在の外部のサイトにアクセスしない決まり）。Passive の Context には中継を付けないので、関わらない。
   */
  readonly egressUpstreamPolicy?: EgressUpstreamPolicy | undefined;
}

/**
 * 出口の中継が拒んだ要求を、Safety Ledger の「操作中に遮断したリクエスト」に写すときの理由（設計書 2.1.3）。
 * `FROZEN` の拒否は、Guard を通らずに出た要求の証拠（`INTERACTION_FROZEN_EGRESS`）。`OPEN` の拒否は、上流の方針によるもの。
 */
const EGRESS_REJECTION_REASONS: Readonly<Record<EgressRejection['phase'], BlockedInteractionRequestEvent['reason']>> = Object.freeze({
  OPEN: 'EGRESS_UPSTREAM_DENIED',
  FROZEN: 'INTERACTION_FROZEN_EGRESS',
});

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

export class BrowserContextFactory {
  readonly #browser: Browser;
  readonly #locale: string;
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
   * Worker の自己検査（Shared Worker は DEF-044、Service Worker は DEF-049）が始めた、Context の閉じる処理。持ち主の閉じる処理
   * （`closePassiveContext`）は、これに合流する。
   */
  readonly #workerSelfCheckCloses = new WeakMap<BrowserContext, Promise<void>>();
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
  /** Run 全体のリソースのキャッシュ。なければ、応答を受け取らず、届け方も変えない（サイトへの負荷の制御の設計書 4.6、4.7）。 */
  readonly #resourceCache: ResourceCache | null;
  /** Interaction の Context の出口の中継の上流の方針（既定は production の方針）。 */
  readonly #egressUpstreamPolicy: EgressUpstreamPolicy;
  /**
   * キャッシュから返した要求の印（設計書 4.6）。届け方の部品が、キャッシュから返す前に付ける。印の付いた要求の応答は、
   * キャッシュに入れ直さない（`ResourceCache.store` の `servedFromRunCache`）。
   */
  readonly #servedFromRunCache = new WeakSet<Request>();

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
    const { loadMeter, resourceCache, egressUpstreamPolicy } = options;
    if (loadMeter !== undefined && !recordsRequestEnds(loadMeter)) {
      throw new TypeError('BrowserContextFactory load meter must record request end events');
    }
    if (resourceCache !== undefined && !(resourceCache instanceof ResourceCache)) {
      throw new TypeError('BrowserContextFactory resource cache must be a ResourceCache');
    }
    if (egressUpstreamPolicy !== undefined && typeof egressUpstreamPolicy !== 'function') {
      throw new TypeError('BrowserContextFactory egress upstream policy must be a function');
    }
    this.#browser = browser;
    this.#locale = config.browser.locale;
    this.#timezone = config.browser.timezone;
    this.#allowedOrigins = canonicalPassiveAllowedOrigins(new Set(config.site.allowedOrigins));
    this.#ledgerFactory = ledgerFactory;
    this.#loadMeter = loadMeter ?? null;
    this.#resourceCache = resourceCache ?? null;
    this.#egressUpstreamPolicy = egressUpstreamPolicy ?? ALLOW_ALL_EGRESS_UPSTREAMS;
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
      if (this.#workerSelfCheckCloses.has(context)) {
        continue;
      }
      const closing = this.closePassiveContext(context);
      closing.catch(() => undefined);
      this.#workerSelfCheckCloses.set(context, closing);
    }
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
   */
  async createPassiveContext(viewport: Viewport, role: ResourceDeliveryRole = 'PRIMARY'): Promise<BrowserContext> {
    if (!isResourceDeliveryRole(role)) {
      throw new TypeError('Passive browser Context role must be one of RESOURCE_DELIVERY_ROLES');
    }
    const ledger = this.#issueSafetyLedger();
    return this.#createGuardedContext(ledger, viewport, role, {});
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
   * Guard の付いた Context を作る（`createPassiveContext` と `createInteractionSession` の共通の部分）。`extraOptions` は、
   * Context の作成の指定に加えるもの（Interaction の Context の出口の中継の `proxy`。Passive には加えない）。
   */
  async #createGuardedContext(
    ledger: SafetyLedger,
    viewport: Viewport,
    role: ResourceDeliveryRole,
    extraOptions: Pick<BrowserContextOptions, 'proxy'>,
  ): Promise<BrowserContext> {
    // DEF-044、DEF-049: Worker の自己検査が始まってから Context を作る。始められなければ、その例外のまま投げる（Context は作らない）。
    if (this.#closed) {
      throw new Error('BrowserContextFactory was closed');
    }
    await this.#workerWatch;
    if (this.#closed) {
      throw new Error('BrowserContextFactory was closed');
    }
    const context = await this.#browser.newContext({
      locale: this.#locale,
      timezoneId: this.#timezone,
      viewport: viewportSnapshot(viewport),
      serviceWorkers: 'block',
      // Passive でも Interaction でも、ページが起こしたダウンロードを保存しない（設計書 4.7）。
      acceptDownloads: false,
      ...extraOptions,
    });
    // 要求の終わりの事象は、Guard の取り付けより前（最初の要求より前）に、meter に渡し始める（サイトへの負荷の制御の設計書 4.5）。
    this.#observeRequestEnds(context);
    // 成功して終わった要求の応答の事実も、同じく最初の要求より前から、Run 全体のキャッシュに渡し始める（設計書 4.6、4.10.3）。
    this.#observeResponses(context);

    // Context と Ledger の対応は、構築に失敗しても消さない（`getSafetyLedger` で後から取り出せるようにする。設計書 4.3）。
    this.#contextLedgers.set(context, ledger);
    this.#activeContexts.add(context);
    // 届け方の部品は、Run 全体のキャッシュがある場合に、役割によらず渡す（設計書 4.7、4.10.3）。
    const resourceDelivery = this.#createResourceDelivery(role);
    const guardOptions: PassiveRequestGuardOptions = Object.freeze(resourceDelivery === undefined ? {} : { resourceDelivery });
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
   * 中継を通る）。Passive の Context には付けない。
   * - 中継を作れなければ、Context を作らずに、その例外をそのまま投げる（Ledger の検査の失敗と同じ扱い）。Context の作成や page の
   *   作成に失敗したら、中継を閉じてから、上の決まりどおりに投げる。
   * - 中継が拒んだ要求は、その Context の Ledger の `blockedInteractionRequests` に写す（`EGRESS_REJECTION_REASONS`）。
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
    const proxy = await startEgressProxy({
      upstreamPolicy: this.#egressUpstreamPolicy,
      onRejected: ({ method, url, phase }): void => {
        ledger.recordBlockedInteractionRequest({ method, url, reason: EGRESS_REJECTION_REASONS[phase] });
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
      context = await this.#createGuardedContext(ledger, viewport, 'REVISIT', { proxy: { server: proxy.server } });
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
          proxy.freeze();
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
    // DEF-044、DEF-049: Worker の自己検査が閉じ始めた Context は、その閉じる処理に合流する。
    const selfCheckClose = this.#workerSelfCheckCloses.get(context);
    if (selfCheckClose !== undefined) {
      return selfCheckClose;
    }
    this.#requireActiveContext(context);
    try {
      await closePassiveGuardedContext(context);
    } finally {
      if (isPassiveRequestGuardClosed(context)) this.#releaseContext(context);
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
