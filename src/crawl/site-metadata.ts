import type { BrowserContext, Page, Response } from 'playwright';
import type { BrowserContextFactory } from '../browser/context-factory.js';
import { isPlaywrightTimeoutError } from '../browser/playwright-errors.js';
import type { AuditConfig } from '../config/types.js';
import type { EvidenceRecordFor, PageId } from '../core/contracts.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import type {
  MetadataEvidence,
  SiteMetadataKind,
  SiteMetadataOutcome,
  SitemapEvidence,
  SitemapXmlMetadataEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../core/guards.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_ERROR_MESSAGE_LENGTH, MAX_SITE_METADATA_TEXT_LENGTH, MAX_SITEMAP_URLS } from '../core/limits.js';
import { truncateText } from '../core/text.js';
import { createEvidenceRecord, type EvidenceRecordContext } from '../orchestration/evidence-builder.js';
import { IdAllocator } from '../orchestration/id-allocator.js';
import {
  closePassivePageAndContext,
  closePassivePageBeforeDeadline,
  PassivePageCloseDeadlineError,
  type PassiveSessionCloseFailure,
} from '../orchestration/passive-session-close.js';
import {
  openPassiveContextBeforeDeadline,
  openPassivePageBeforeDeadline,
  passiveSessionOpenDeadlineAtMs,
  resolvePassiveSessionDeadlines,
  type PassiveSessionDeadlineOptions,
  type PassiveSessionOpenDeadlineError,
  type ResolvedPassiveSessionDeadlines,
} from '../orchestration/passive-session-open.js';
import type { SafetyLedger, SafetyLedgerSnapshot } from '../safety/safety-ledger.js';
import { classifyUrl } from './admission-policy.js';
import { normalizeUrl } from './normalize-url.js';
import { sitemapEvidenceFromMetadata } from './sitemap-evidence.js';

/** 本文の文字数と、sitemap の URL の件数の上限。 */
export interface SiteMetadataLimits {
  /** Evidence に残す本文の最大長（UTF-16 のコード単位）。 */
  readonly maxTextLength: number;
  /** Evidence に残す sitemap の URL の最大件数。 */
  readonly maxSitemapUrls: number;
}

/** 本番の上限（`src/core/limits.ts` の定数）。`SiteMetadataOptions.limits` で差し替えても、この値は変わらない。 */
export const SITE_METADATA_DEFAULT_LIMITS: SiteMetadataLimits = Object.freeze({
  maxTextLength: MAX_SITE_METADATA_TEXT_LENGTH,
  maxSitemapUrls: MAX_SITEMAP_URLS,
});

/** `collectSiteMetadata` の入力（Task 14〜17 の設計書 5.6.2）。 */
export interface SiteMetadataOptions {
  /** Guard の付いた Passive Context と page を作る factory。 */
  readonly contextFactory: BrowserContextFactory;
  /** 開始の URL の Origin（`new URL(startUrl).origin` の直列化）。`<Origin>/robots.txt` と `<Origin>/sitemap.xml` を取得する。 */
  readonly origin: string;
  /**
   * 確定した監査の設定のうち、使う項目。`AuditConfig` をそのまま渡せる。
   * - `site.allowedOrigins`: 取得する URL が許可 Origin の中かの判定
   * - `crawl.allowedQueryParameters`: sitemap の URL の正規化
   * - `crawl.navigationTimeoutMs`: 1つのファイルの取得（ナビゲーションと本文の読み取り）の期限
   * - `viewports.primaryDesktop`: Passive Context のビューポート
   */
  readonly config: {
    readonly site: Pick<AuditConfig['site'], 'allowedOrigins'>;
    readonly crawl: Pick<AuditConfig['crawl'], 'allowedQueryParameters' | 'navigationTimeoutMs'>;
    readonly viewports: Pick<AuditConfig['viewports'], 'primaryDesktop'>;
  };
  /** 開始の URL のページの ID（metadata の取得の前に採番したもの）。Evidence は、このページに置く。 */
  readonly pageId: PageId;
  /** Run で1つの採番器。 */
  readonly allocator: IdAllocator;
  /** Evidence の `observedAt` に使う時計。 */
  readonly clock: () => Date;
  /** 上限の差し替え口（テスト用）。省略した項目は `SITE_METADATA_DEFAULT_LIMITS`。 */
  readonly limits?: Partial<SiteMetadataLimits>;
  /**
   * Passive Context と page の作成・終了の期限の注入口（DEF-008、R15r-4）。省略した項目は、`limits.ts` の定数を使う。
   */
  readonly deadlines?: PassiveSessionDeadlineOptions | undefined;
}

/**
 * 応答を得られなかった取得（`FAILED` で、`httpStatus` が `null`）の詳細。Evidence には残らないので、呼び出し側が理由の記録に使う。
 * - `timedOut`: Playwright の期限切れ（`isPlaywrightTimeoutError`）か、本文の読み取りが期限を過ぎた。
 * - `detail`: 上限（`MAX_ERROR_MESSAGE_LENGTH`）付きのエラーのメッセージ。
 */
export interface SiteMetadataFetchFailure {
  readonly kind: SiteMetadataKind;
  readonly timedOut: boolean;
  readonly detail: string;
}

/** `collectSiteMetadata` の結果。深く凍結して返す。 */
export interface SiteMetadataResult {
  /** robots.txt、sitemap.xml の順の `metadata` の Evidence（`pageId` は入力のもの、ビューポートは `null`）。 */
  readonly records: readonly [EvidenceRecordFor<'metadata'>, EvidenceRecordFor<'metadata'>];
  /** Cross-page rule に渡す sitemap（`sitemapEvidenceFromMetadata` で作る）。判定に使える sitemap がない場合は `null`。 */
  readonly sitemap: SitemapEvidence | null;
  /**
   * sitemap の `<loc>` のうち、`normalizeUrl` で正規化できず、`sitemapUrls` に入れなかったものの件数。
   * URL の件数の上限に達して読むのをやめた場合は、それまでに読んだ分の件数。
   */
  readonly unnormalizableSitemapUrlCount: number;
  /** 応答を得られなかった取得の詳細（取得の順）。 */
  readonly failures: readonly SiteMetadataFetchFailure[];
  /** 取得に使った Passive Context の Safety Ledger の snapshot（Context を閉じた後に取る）。Context を作れなかった場合は `null`。 */
  readonly ledgerSnapshot: SafetyLedgerSnapshot | null;
  /**
   * page と Context を閉じる処理の失敗（期限切れを含む）。前の page を閉じる処理、page の作成が期限を過ぎた場合に部品が Context を
   * 閉じる処理、最後の `closePassivePageAndContext` の結果を、起きた順に並べる。
   */
  readonly closeFailures: readonly PassiveSessionCloseFailure[];
}

/** 取得する metadata の種類と、Origin からのパス。この順に取得する。 */
const SITE_METADATA_PATHS = Object.freeze([
  Object.freeze({ kind: 'ROBOTS_TXT', path: '/robots.txt' }),
  Object.freeze({ kind: 'SITEMAP_XML', path: '/sitemap.xml' }),
] as const satisfies readonly { readonly kind: SiteMetadataKind; readonly path: string }[]);

/** `NOT_FOUND` とする HTTP ステータス（ファイルがない）。 */
const NOT_FOUND_HTTP_STATUSES: ReadonlySet<number> = new Set([404, 410]);
const MIN_SUCCESS_HTTP_STATUS = 200;
const MAX_SUCCESS_HTTP_STATUS = 299;

/** 1つのファイルの取得の結果（Evidence の payload の共通の項目と、sitemap の場合の切り詰める前の本文）。 */
interface FetchOutcome {
  readonly outcome: SiteMetadataOutcome;
  readonly httpStatus: number | null;
  /** `OK` の場合の、切り詰める前の本文。 */
  readonly body: string | null;
  readonly failure: Omit<SiteMetadataFetchFailure, 'kind'> | null;
}

/**
 * Passive Context を開いた結果。`failure` が `null` でなければ、Context は使えない（Context を作れた場合は、閉じるために持つ）。
 * Context を作れた場合は、その Ledger を持つ。
 */
interface OpenedContext {
  readonly context: BrowserContext | undefined;
  readonly ledger: SafetyLedger | null;
  readonly failure: Omit<SiteMetadataFetchFailure, 'kind'> | null;
}

/**
 * page を開いた結果。開けなかった場合は、`page` が `undefined` で、`failure` を持つ。
 * page の作成が期限を過ぎた場合は、部品が Context を閉じたので、`contextReleased` が真で、閉じる処理の失敗を `closeFailures` に持つ。
 */
type OpenedPage =
  | { readonly page: Page; readonly failure: null; readonly contextReleased: false }
  | {
    readonly page: undefined;
    readonly failure: Omit<SiteMetadataFetchFailure, 'kind'>;
    readonly contextReleased: boolean;
    readonly closeFailures: readonly PassiveSessionCloseFailure[];
  };

/**
 * robots.txt と sitemap.xml を、Guard の付いた Passive Context の GET のナビゲーションで取得し、`metadata` の Evidence にする
 * （Task 14〜17 の設計書 5.6.2）。本文は、ナビゲーションの応答（`response.text()`）から読む。Node の `fetch` は使わない。
 *
 * - `outcome`: 2xx は `OK`、404 と 410 は `NOT_FOUND`、それ以外の応答と、応答を得られなかった場合は `FAILED`。
 *   本文（`text`）は `OK` の場合だけ残し、上限で切り詰めた場合は `textTruncated` を真にする。
 * - sitemap の URL は、切り詰める前の本文の `<loc>` から取り出し（`extractSitemapLocations`）、`normalizeUrl` で正規化する。
 *   許可 Origin の外の URL も残す。正規化できないものは `sitemapUrls` に入れず、件数を `unnormalizableSitemapUrlCount` で返す。
 * - sitemap の index（`<sitemapindex>`）の入れ子の sitemap は、たどらない（制約）。入れ子の sitemap の URL はページの URL ではないので、
 *   `sitemapUrls` は `null` にする（入れ子の URL は、本文 `text` に事実として残る。Task 14〜17 の設計書 5.6.2）。
 * - Passive Context は1つで、ファイルごとに新しい page で開く（前の page は、`closePassivePageBeforeDeadline` で閉じる）。
 *   期限切れで終わらなかったナビゲーションを次のナビゲーションで中断すると、Guard が不変条件の違反にするためである。
 *   前の page を閉じる処理が期限（`PAGE_CLOSE_TIMEOUT_MS`）を過ぎた場合は、その失敗を `closeFailures` に記録し、残りのファイルは
 *   取得せずに `FAILED`（`failures` の `detail` は、期限切れのメッセージ）とする（DEF-006、R15 の Minor-1）。
 * - 最後の page と Context は、`finally` で `closePassivePageAndContext` で閉じる。
 * - Context と page の作成は、期限（`deadlines.sessionOpenTimeoutMs`、既定は `SESSION_OPEN_TIMEOUT_MS`）付きで待つ（DEF-008）。
 *   Context の作成が期限を過ぎた場合は、Context を作れなかった場合と同じく、すべてのファイルを `FAILED` にする。page の作成が
 *   期限を過ぎた場合は、部品が Context を閉じるので、その Context での取得をやめ、残りのファイルも `FAILED` にする。どちらも
 *   `failures` の `timedOut` は真、`detail` は期限切れのメッセージである。部品が Context を閉じる処理の失敗は `closeFailures` に記録する。
 * - 閉じる処理の期限（`PAGE_CLOSE_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）も注入できる。Context を閉じる処理の期限切れは、
 *   `closeFailures` に記録する。
 *
 * 例外を投げる（reject する）のは、引数が不正な場合だけで、そのときは Context を作らない。
 * - Origin が Origin の直列化でない、または取得する URL が許可 Origin の中（`classifyUrl` の `INTERNAL_NAVIGABLE`）でない: `RangeError`
 * - 上限が0以上の安全な整数でない、期限（`crawl.navigationTimeoutMs` と、注入した作成・終了の期限）が正の安全な整数でない: `RangeError`
 * - factory、採番器、時計、pageId、設定の形が不正: `TypeError`
 * 取得の失敗（Context を作れない場合を含む）は、`FAILED` の Evidence として返す。
 */
export async function collectSiteMetadata(options: SiteMetadataOptions): Promise<SiteMetadataResult> {
  const validated = validateOptions(options);
  const { contextFactory, limits, timeoutMs, allowedQueryParameters, targets, deadlines } = validated;
  const evidenceContext: EvidenceRecordContext = { allocator: options.allocator, clock: options.clock };

  const session = await openContext(contextFactory, options.config.viewports.primaryDesktop, deadlines);
  const records: EvidenceRecordFor<'metadata'>[] = [];
  const failures: SiteMetadataFetchFailure[] = [];
  let unnormalizableSitemapUrlCount = 0;
  const closeFailures: PassiveSessionCloseFailure[] = [];
  let page: Page | undefined;
  // 前の page を閉じる処理か、page の作成が期限を過ぎた場合の、残りの取得の失敗。この Context では、それ以上取得しない。
  let abandonedFailure: Omit<SiteMetadataFetchFailure, 'kind'> | null = null;
  // page の作成が期限を過ぎて、部品が Context を閉じた場合は真。`finally` で Context を閉じ直さない。
  let contextReleased = false;
  try {
    for (const { kind, url } of targets) {
      let fetched: FetchOutcome;
      if (session.context === undefined || session.failure !== null) {
        fetched = { outcome: 'FAILED', httpStatus: null, body: null, failure: session.failure };
      } else {
        // ファイルごとに新しい page で開く。期限切れなどで終わらなかったナビゲーションを、次のナビゲーションで中断させないためである
        // （Guard は、メインフレームのナビゲーションの予期しない中断（`net::ERR_ABORTED`）を不変条件の違反にする）。
        // 前の page は、factory の page を閉じる処理（Guard が中断を予期する経路）で、期限付きで閉じる（DEF-006、R15 の Minor-1）。
        // 期限を過ぎた場合は、この Context での取得をやめ、`finally` で Context を閉じる（Context を閉じると、止まった page も閉じる）。
        if (page !== undefined && abandonedFailure === null) {
          const previous = page;
          page = undefined;
          const pageFailure = await closePassivePageBeforeDeadline(contextFactory, previous, {
            timeoutMs: deadlines.pageCloseTimeoutMs,
          });
          if (pageFailure !== null) {
            closeFailures.push(pageFailure);
            if (pageFailure.error instanceof PassivePageCloseDeadlineError) {
              abandonedFailure = { timedOut: false, detail: pageFailure.error.message };
            }
          }
        }
        if (abandonedFailure !== null) {
          fetched = { outcome: 'FAILED', httpStatus: null, body: null, failure: abandonedFailure };
        } else {
          const opened = await openPage(contextFactory, session.context, deadlines);
          page = opened.page;
          if (opened.page === undefined) {
            fetched = { outcome: 'FAILED', httpStatus: null, body: null, failure: opened.failure };
            closeFailures.push(...opened.closeFailures);
            if (opened.contextReleased) {
              contextReleased = true;
              abandonedFailure = opened.failure;
            }
          } else {
            fetched = await fetchMetadata(opened.page, url, timeoutMs);
          }
        }
      }
      if (fetched.failure !== null) {
        failures.push({ kind, ...fetched.failure });
      }
      const text = fetched.body === null ? null : truncateText(fetched.body, limits.maxTextLength);
      const base = {
        url,
        outcome: fetched.outcome,
        httpStatus: fetched.httpStatus,
        text: text === null ? null : text.text,
        textTruncated: text !== null && text.truncated,
      };
      let payload: MetadataEvidence;
      if (kind === 'ROBOTS_TXT') {
        payload = { kind, ...base, sitemapUrls: null, sitemapUrlsTruncated: false };
      } else {
        const sitemap = fetched.body === null
          ? null
          : sitemapUrlsFrom(fetched.body, allowedQueryParameters, limits.maxSitemapUrls);
        unnormalizableSitemapUrlCount = sitemap === null ? 0 : sitemap.unnormalizableCount;
        payload = {
          kind,
          ...base,
          sitemapUrls: sitemap === null ? null : sitemap.urls,
          sitemapUrlsTruncated: sitemap !== null && sitemap.truncated,
        } satisfies SitemapXmlMetadataEvidence;
      }
      records.push(
        createEvidenceRecord({ type: 'metadata', pageId: options.pageId, viewport: null, payload }, evidenceContext),
      );
    }
  } finally {
    closeFailures.push(
      ...(await closePassivePageAndContext(contextFactory, contextReleased ? undefined : session.context, page, deadlines)),
    );
  }

  const [robots, sitemap] = records;
  if (robots === undefined || sitemap === undefined) {
    throw new Error('site metadata records were not created');
  }
  return deepFreeze({
    records: [robots, sitemap] as const,
    sitemap: sitemapEvidenceFromMetadata(sitemap),
    unnormalizableSitemapUrlCount,
    failures,
    ledgerSnapshot: session.ledger === null ? null : session.ledger.snapshot(),
    closeFailures,
  });
}

interface ValidatedOptions {
  readonly contextFactory: BrowserContextFactory;
  readonly limits: SiteMetadataLimits;
  readonly timeoutMs: number;
  readonly allowedQueryParameters: ReadonlySet<string>;
  readonly targets: readonly { readonly kind: SiteMetadataKind; readonly url: string }[];
  readonly deadlines: ResolvedPassiveSessionDeadlines;
}

function validateOptions(options: SiteMetadataOptions): ValidatedOptions {
  if (!isRecord(options)) {
    throw new TypeError('site metadata options must be an object');
  }
  const { contextFactory, origin, config, pageId, allocator, clock } = options;
  if (!isRecord(contextFactory)) {
    throw new TypeError('site metadata requires a BrowserContextFactory');
  }
  if (!(allocator instanceof IdAllocator)) {
    throw new TypeError('site metadata requires the IdAllocator of the Run');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('site metadata requires a clock');
  }
  if (typeof pageId !== 'string' || pageId.length === 0) {
    throw new TypeError('site metadata requires the page ID of the start URL');
  }
  if (!isRecord(config) || !isRecord(config.site) || !isRecord(config.crawl) || !isRecord(config.viewports)) {
    throw new TypeError('site metadata requires the audit config');
  }
  const { allowedOrigins } = config.site;
  const { allowedQueryParameters, navigationTimeoutMs } = config.crawl;
  if (!Array.isArray(allowedOrigins) || !Array.isArray(allowedQueryParameters)) {
    throw new TypeError('site metadata requires the allowed origins and the allowed query parameters');
  }
  if (!isPositiveSafeInteger(navigationTimeoutMs)) {
    throw new RangeError('site metadata navigation timeout must be a positive safe integer');
  }
  const limits = { ...SITE_METADATA_DEFAULT_LIMITS, ...options.limits };
  if (!isNonNegativeSafeInteger(limits.maxTextLength) || !isNonNegativeSafeInteger(limits.maxSitemapUrls)) {
    throw new RangeError('site metadata limits must be non-negative safe integers');
  }
  return {
    contextFactory,
    limits,
    timeoutMs: navigationTimeoutMs,
    allowedQueryParameters: new Set(allowedQueryParameters),
    targets: metadataTargets(origin, allowedOrigins),
    deadlines: resolvePassiveSessionDeadlines(options.deadlines),
  };
}

/** 取得する URL。Origin の直列化でない場合と、許可 Origin の中（`INTERNAL_NAVIGABLE`）でない場合は `RangeError`。 */
function metadataTargets(
  origin: string,
  allowedOrigins: readonly string[],
): readonly { readonly kind: SiteMetadataKind; readonly url: string }[] {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new RangeError('site metadata origin must be a URL origin');
  }
  if (parsed.origin !== origin) {
    throw new RangeError('site metadata origin must be the serialization of a URL origin');
  }
  const policy = { allowedOrigins: new Set(allowedOrigins) };
  return SITE_METADATA_PATHS.map(({ kind, path }) => {
    const admission = classifyUrl(new URL(path, parsed), policy);
    if (admission.kind !== 'INTERNAL_NAVIGABLE') {
      throw new RangeError('site metadata URL must be within the allowed origins');
    }
    return { kind, url: admission.url };
  });
}

/**
 * Passive Context を、期限付きで開く（`openPassiveContextBeforeDeadline`。DEF-008）。失敗は投げずに返す。
 * Guard の取り付けに失敗した場合（`ContextConstructionError`）は、閉じるためにエラーが持つ Context と、その Ledger を返す。
 * 期限を過ぎた場合は、Context を返さない（遅れて届いた Context は、部品が閉じる）。
 */
async function openContext(
  factory: BrowserContextFactory,
  viewport: SiteMetadataOptions['config']['viewports']['primaryDesktop'],
  deadlines: ResolvedPassiveSessionDeadlines,
): Promise<OpenedContext> {
  const opened = await openPassiveContextBeforeDeadline(
    factory,
    viewport,
    passiveSessionOpenDeadlineAtMs({ timeoutMs: deadlines.sessionOpenTimeoutMs }),
    deadlines,
  );
  switch (opened.status) {
    case 'OPENED':
      return { context: opened.context, ledger: opened.ledger, failure: null };
    case 'FAILED':
      return { context: opened.context, ledger: opened.ledger, failure: failureOf(opened.error) };
    case 'DEADLINE_EXCEEDED':
      return { context: undefined, ledger: null, failure: openDeadlineFailureOf(opened.error) };
  }
}

/**
 * Context に page を、期限付きで開く（`openPassivePageBeforeDeadline`。DEF-008）。失敗は投げずに返す（Context は、最後に
 * `closePassivePageAndContext` で閉じる）。期限を過ぎた場合は、部品が Context を閉じたことと、その閉じる処理の失敗を返す。
 */
async function openPage(
  factory: BrowserContextFactory,
  context: BrowserContext,
  deadlines: ResolvedPassiveSessionDeadlines,
): Promise<OpenedPage> {
  const opened = await openPassivePageBeforeDeadline(
    factory,
    context,
    passiveSessionOpenDeadlineAtMs({ timeoutMs: deadlines.sessionOpenTimeoutMs }),
    deadlines,
  );
  switch (opened.status) {
    case 'OPENED':
      return { page: opened.page, failure: null, contextReleased: false };
    case 'FAILED':
      return { page: undefined, failure: failureOf(opened.error), contextReleased: false, closeFailures: [] };
    case 'DEADLINE_EXCEEDED':
      return {
        page: undefined,
        failure: openDeadlineFailureOf(opened.error),
        contextReleased: true,
        closeFailures: opened.closeFailures,
      };
  }
}

/** 作成の期限切れの失敗。期限を過ぎたので `timedOut` は真にする。 */
function openDeadlineFailureOf(error: PassiveSessionOpenDeadlineError): Omit<SiteMetadataFetchFailure, 'kind'> {
  return { timedOut: true, detail: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) };
}

/**
 * 1つのファイルを、`page.goto`（GET のナビゲーション）で取得する。ナビゲーションと本文の読み取りを合わせて `timeoutMs` までに終える。
 * 例外は投げない。
 */
async function fetchMetadata(page: Page, url: string, timeoutMs: number): Promise<FetchOutcome> {
  const deadlineAtMs = Date.now() + timeoutMs;
  let response: Response | null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (error) {
    return { outcome: 'FAILED', httpStatus: null, body: null, failure: failureOf(error) };
  }
  if (response === null) {
    return {
      outcome: 'FAILED',
      httpStatus: null,
      body: null,
      failure: { timedOut: false, detail: 'navigation finished without a response' },
    };
  }
  const httpStatus = response.status();
  const outcome = outcomeOf(httpStatus);
  if (outcome !== 'OK') {
    return { outcome, httpStatus, body: null, failure: null };
  }
  const body = await awaitBeforeDeadline(response.text(), deadlineAtMs);
  switch (body.status) {
    case 'FULFILLED':
      return { outcome, httpStatus, body: body.value, failure: null };
    case 'REJECTED':
      return { outcome: 'FAILED', httpStatus, body: null, failure: failureOf(body.reason) };
    case 'DEADLINE_EXCEEDED':
      return {
        outcome: 'FAILED',
        httpStatus,
        body: null,
        failure: { timedOut: true, detail: 'reading the response body exceeded the navigation timeout' },
      };
  }
}

function outcomeOf(httpStatus: number): SiteMetadataOutcome {
  if (httpStatus >= MIN_SUCCESS_HTTP_STATUS && httpStatus <= MAX_SUCCESS_HTTP_STATUS) {
    return 'OK';
  }
  return NOT_FOUND_HTTP_STATUSES.has(httpStatus) ? 'NOT_FOUND' : 'FAILED';
}

function failureOf(error: unknown): Omit<SiteMetadataFetchFailure, 'kind'> {
  return { timedOut: isPlaywrightTimeoutError(error), detail: safeErrorMessage(error, MAX_ERROR_MESSAGE_LENGTH) };
}

/** sitemap の本文から取り出した URL。 */
interface SitemapUrls {
  /** 正規化した URL（文書の順。重複を含む）。 */
  readonly urls: readonly string[];
  /** ページの URL の一覧として不完全か（件数の上限で切り詰めた）。 */
  readonly truncated: boolean;
  readonly unnormalizableCount: number;
}

/**
 * sitemap の本文から、正規化した URL を取り出す。
 * - 根の要素が `<urlset>` でない本文からは取り出さず、`null` を返す。
 *   - `<urlset>` でも `<sitemapindex>` でもない本文（例: 2xx で返った HTML）: URL の一覧を空にすると、Cross-page rule が
 *     「sitemap にない」と言いすぎるためである。
 *   - `<sitemapindex>`: `<loc>` は入れ子の sitemap の URL で、ページの URL ではない。入れ子はたどらないので、ページの URL の一覧は
 *     得られない（Task 14〜17 の設計書 5.6.2。R15b の発見事項）。
 * - `maxUrls` 件を超える URL があれば、そこで読むのをやめ、`truncated` を真にする。
 */
function sitemapUrlsFrom(
  body: string,
  allowedQueryParameters: ReadonlySet<string>,
  maxUrls: number,
): SitemapUrls | null {
  const extracted = extractSitemapLocations(body);
  if (extracted.root !== 'urlset') {
    return null;
  }
  const urls: string[] = [];
  let unnormalizableCount = 0;
  let truncated = false;
  for (const location of extracted.locations) {
    // 正規化の基準の URL は値そのもの（相対の URL は受け入れない。Cross-page rule の正規化と同じ）。
    const normalized = location === null ? null : normalizeUrl(location, location, allowedQueryParameters);
    if (normalized === null || !normalized.ok) {
      unnormalizableCount += 1;
      continue;
    }
    if (urls.length >= maxUrls) {
      truncated = true;
      break;
    }
    urls.push(normalized.url);
  }
  return { urls, truncated, unnormalizableCount };
}

/** sitemap の根の要素の名前。 */
type SitemapRoot = 'urlset' | 'sitemapindex';

/** 本文から取り出した `<loc>` の値（文書の順）。値を取り出せない `<loc>`（閉じていない、中に要素がある）は `null`。 */
interface ExtractedSitemapLocations {
  readonly root: SitemapRoot | null;
  readonly locations: Iterable<string | null>;
}

/** 要素の名前の前に付く、名前空間の接頭辞（例: `sm:`）。 */
const XML_PREFIX = String.raw`(?:[A-Za-z_][\w.-]*:)?`;
/** 注釈と CDATA の区間を飛ばしながら、`urlset`・`sitemapindex`・`loc` の開始タグを見つける。 */
const SITEMAP_TOKEN_PATTERN = new RegExp(
  String.raw`<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<${XML_PREFIX}(urlset|sitemapindex|loc)(?=[\s/>])[^>]*>`,
  'gu',
);
/** `<loc>` の開始タグの直後から、閉じるタグまで。中身は、文字、CDATA の区間、注釈だけを受け付ける。 */
const LOC_CONTENT_PATTERN = new RegExp(
  String.raw`((?:<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|[^<])*)<\/${XML_PREFIX}loc\s*>`,
  'uy',
);
/** `<loc>` の中身の区間（CDATA の区間、注釈、文字の並び）。 */
const LOC_SEGMENT_PATTERN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|([^<]+)/gu;
/** XML の定義済みの実体参照と、文字参照。 */
const XML_REFERENCE_PATTERN = /&(?:(amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9A-Fa-f]+));/gu;
const XML_PREDEFINED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
});
/** XML の空白（空白、タブ、改行、復帰）の前後の並び。 */
const XML_SURROUNDING_WHITESPACE_PATTERN = /^[ \t\r\n]+|[ \t\r\n]+$/gu;
const MAX_CODE_POINT = 0x10_ffff;

/**
 * sitemap の本文から、根の要素の名前と `<loc>` の値を、文書の順で取り出す（新しい依存パッケージを使わない、上限付きの読み取り）。
 * - 注釈（`<!-- -->`）と、要素の外の CDATA の区間の中は読まない。
 * - `<loc>` の値は、CDATA の区間をそのまま、ほかの文字は実体参照と文字参照を戻して連結し、前後の XML の空白を除く。
 * - 値は、呼び出し側が読む分だけ、順に取り出す（件数の上限で止めた後は読まない）。
 */
function extractSitemapLocations(body: string): ExtractedSitemapLocations {
  let root: SitemapRoot | null = null;
  for (const match of body.matchAll(SITEMAP_TOKEN_PATTERN)) {
    const name = match[1];
    if (name === 'urlset' || name === 'sitemapindex') {
      root = name;
      break;
    }
  }
  return { root, locations: locationsOf(body) };
}

function* locationsOf(body: string): Generator<string | null> {
  const tokens = new RegExp(SITEMAP_TOKEN_PATTERN.source, SITEMAP_TOKEN_PATTERN.flags);
  for (let match = tokens.exec(body); match !== null; match = tokens.exec(body)) {
    if (match[1] !== 'loc') {
      continue;
    }
    if (match[0].endsWith('/>')) {
      yield '';
      continue;
    }
    const content = new RegExp(LOC_CONTENT_PATTERN.source, LOC_CONTENT_PATTERN.flags);
    content.lastIndex = tokens.lastIndex;
    const closed = content.exec(body);
    if (closed === null) {
      yield null;
      continue;
    }
    tokens.lastIndex = content.lastIndex;
    yield locationValue(closed[1] ?? '');
  }
}

function locationValue(content: string): string {
  let value = '';
  for (const segment of content.matchAll(LOC_SEGMENT_PATTERN)) {
    if (segment[1] !== undefined) {
      value += segment[1];
    } else if (segment[2] !== undefined) {
      value += decodeXmlReferences(segment[2]);
    }
  }
  return value.replace(XML_SURROUNDING_WHITESPACE_PATTERN, '');
}

/** 定義済みの実体参照と文字参照を戻す。表せない文字参照は、そのまま残す。 */
function decodeXmlReferences(text: string): string {
  return text.replace(
    XML_REFERENCE_PATTERN,
    (reference: string, entity: string | undefined, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (entity !== undefined) {
        return XML_PREDEFINED_ENTITIES[entity] ?? reference;
      }
      const codePoint = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hexadecimal ?? '', 16);
      return Number.isSafeInteger(codePoint) && codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : reference;
    },
  );
}
