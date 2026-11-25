import { evidenceOfType } from '../audit/rule-helpers.js';
import {
  INCOMPLETE_REASON_CODES,
  OUTSIDE_AUDIT_SCOPE_NAVIGATION_DETAIL,
  VIEWPORT_PROFILES,
  isOutsideAuditScopeNavigation,
  type EvidenceRecordFor,
  type EvidenceType,
  type IncompleteReasonCode,
  type PageAuditResult,
  type PageIncompleteReasonCount,
  type PageAuditStatus,
  type RunPageSamenessCounts,
  type RunSafetySummary,
  type SafetyBlockedActionCounts,
  type ViewportPageCounts,
  type ViewportProfile,
} from '../core/contracts.js';
import type { AuditSendPolicyName } from '../core/audit-send-policy.js';
import { deepFreeze } from '../core/immutable.js';
import { saturatingAdd } from '../core/saturating-count.js';
import { isSameContentSkipReason, isSameContentSkippedViewport } from '../core/status.js';
import { compareCodeUnits } from '../core/text.js';
import { summarizePageSafety, type SafetyLedgerSnapshot } from '../safety/safety-ledger.js';

// Run の要約（`RunSummary`）と Run Status の入力に使う件数を、確定したページの結果から数える（Task 14〜17 の設計書 5.6.5、5.6.6）。
// ここの関数は、入力を変えない純粋な関数である。件数の集計は、ここだけで行う。

/** ページの状態ごとの件数の項目（`ViewportPageCounts` のキー）。 */
const PAGE_COUNT_KEYS = Object.freeze({
  AUDITED: 'audited',
  PARTIAL: 'partial',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const satisfies Readonly<Record<PageAuditStatus, keyof ViewportPageCounts>>);

const emptyCounts = (): { -readonly [Key in keyof ViewportPageCounts]: number } => ({
  audited: 0,
  partial: 0,
  failed: 0,
  skipped: 0,
});

/** ページの状態ごとの、ページの数（`auditedPageCount` などの元）。 */
/**
 * MEM-3b: 数え上げが読むページの項目（本体か、要約 `RunPageSummary`。どちらも同じ数になる）。Interaction の結果は `evidence` の Interaction の Evidence だけを読む。
 */
type CountedPage = Pick<PageAuditResult, 'status' | 'viewports' | 'incompleteReasons' | 'evidence'>;

export function countPagesByStatus(pages: readonly Pick<CountedPage, 'status'>[]): ViewportPageCounts {
  const counts = emptyCounts();
  for (const page of pages) {
    counts[PAGE_COUNT_KEYS[page.status]] += 1;
  }
  return Object.freeze(counts);
}

/**
 * ビューポートごとの、ビューポートの状態ごとの数（`viewportPageCounts`）。DUP（REV-DUP の M-9）: 表示の中身が同じなので始めなかったビューポートは、どの数にも
 * 入れない（まだ見ていない `skipped` に数えない）。
 */
export function countViewportPages(pages: readonly Pick<CountedPage, 'viewports'>[]): Readonly<Record<ViewportProfile, ViewportPageCounts>> {
  const counts = Object.fromEntries(VIEWPORT_PROFILES.map((profile) => [profile, emptyCounts()])) as Record<
    ViewportProfile,
    ReturnType<typeof emptyCounts>
  >;
  for (const page of pages) {
    for (const profile of VIEWPORT_PROFILES) {
      if (isSameContentSkippedViewport(page.viewports[profile])) {
        continue;
      }
      counts[profile][PAGE_COUNT_KEYS[page.viewports[profile].status]] += 1;
    }
  }
  return deepFreeze(counts);
}

/**
 * T44c（Task 44 の設計書 P1-4）: ページの未完了の理由ごとの、その理由を持つページの数（`run.json` の `pageIncompleteReasonCounts`）。監査したページ（SKIPPED
 * でない）の、ページとビューポートの理由を、ページごとに理由 1 回で数える（SKIPPED のページの理由は Run の理由にある）。理由のコードの一覧
 * （`INCOMPLETE_REASON_CODES`）の順。理由を持つページがなければ空。
 * PIR: 各項目は、その理由を持つページの URL の全部（ページの順）を持つ。点検の範囲の外へ移った読み込みの失敗（`isOutsideAuditScopeNavigation`）は、同じコードの
 * ほかの失敗の後に、`detail` を持つ別の項目として数える。
 */
export function countPagesByIncompleteReason(
  pages: readonly Pick<PageAuditResult, 'pageUrl' | 'status' | 'viewports' | 'incompleteReasons'>[],
): readonly PageIncompleteReasonCount[] {
  /** 項目の鍵（コードと、範囲の外の印）ごとの、ページの URL。 */
  const urls = new Map<string, string[]>();
  const keyOf = (code: IncompleteReasonCode, outside: boolean): string => `${code}${outside ? OUTSIDE_KEY_SUFFIX : ''}`;
  for (const page of pages) {
    if (page.status === 'SKIPPED') continue;
    // DUP: 表示の中身が同じなので始めなかったビューポートの理由は、途中で止まった理由ではないので数えない。
    const keys = new Set([
      ...page.incompleteReasons,
      ...VIEWPORT_PROFILES.flatMap((profile) => page.viewports[profile].incompleteReasons),
    ].filter((reason) => !isSameContentSkipReason(reason)).map((reason) => keyOf(reason.code, isOutsideAuditScopeNavigation(reason))));
    for (const key of keys) {
      const list = urls.get(key) ?? [];
      list.push(page.pageUrl);
      urls.set(key, list);
    }
  }
  return deepFreeze(INCOMPLETE_REASON_CODES.flatMap((code) =>
    [false, true].flatMap((outside) => {
      const pageUrls = urls.get(keyOf(code, outside));
      return pageUrls === undefined
        ? []
        : [{ code, ...(outside ? { detail: OUTSIDE_AUDIT_SCOPE_NAVIGATION_DETAIL } : {}), pages: pageUrls.length, pageUrls }];
    })));
}

/** DUP: 軽い点検にしたページと、点検を省いたページの数（`run.json` の `pageSamenessCounts`。どちらも 0 なら `null`）。 */
export function countPagesBySameness(pages: readonly Pick<PageAuditResult, 'sameness'>[]): RunPageSamenessCounts | null {
  const lightPages = pages.filter(({ sameness }) => sameness?.depth === 'LIGHT').length;
  const samePages = pages.filter(({ sameness }) => sameness?.depth === 'SAME').length;
  return lightPages === 0 && samePages === 0 ? null : Object.freeze({ lightPages, samePages });
}

/** PIR: 範囲の外へ移った読み込みの失敗の項目の鍵の印（理由のコードに使わない文字）。 */
const OUTSIDE_KEY_SUFFIX = ':outside';

/** 状態が `PARTIAL` のビューポートの数（Run Status の入力 `incompleteCollectorCount`）。 */
export function countPartialViewports(pages: readonly Pick<CountedPage, 'viewports'>[]): number {
  return pages.reduce(
    (count, page) => count + VIEWPORT_PROFILES.filter((profile) => page.viewports[profile].status === 'PARTIAL').length,
    0,
  );
}

/** ページの Evidence のうち、指定した種類のもの（ビューポートの順。ビューポートによらない Evidence は含めない）。 */
export function viewportEvidenceOfType<TType extends EvidenceType>(
  page: Pick<PageAuditResult, 'evidence'>,
  type: TType,
  profiles: readonly ViewportProfile[] = VIEWPORT_PROFILES,
): readonly EvidenceRecordFor<TType>[] {
  return profiles.flatMap((viewport) => evidenceOfType({ viewport, evidence: page.evidence }, type));
}

/** Interaction の結果の件数（設計書 5.4.1、5.6.6）。 */
export interface InteractionOutcomeCounts {
  /** `EXECUTION_FAILED` の数（`failedRequiredWork` に入れる）。 */
  readonly executionFailed: number;
  /** `NOT_VERIFIABLE` のうち、区分が `CHECK_NOT_COMPLETED` の数（`notVerifiedRequiredWork`）。 */
  readonly checkNotCompleted: number;
  /** `NOT_VERIFIABLE` と `EXECUTION_FAILED` の数（`RunSummary.unverifiedInteractionCount`）。 */
  readonly unverified: number;
}

/** 各ページの `interaction` の Evidence から、Interaction の結果を数える。 */
export function countInteractionOutcomes(pages: readonly Pick<CountedPage, 'evidence'>[]): InteractionOutcomeCounts {
  let executionFailed = 0;
  let checkNotCompleted = 0;
  let notVerifiable = 0;
  for (const page of pages) {
    for (const { payload } of viewportEvidenceOfType(page, 'interaction')) {
      if (payload.status === 'EXECUTION_FAILED') {
        executionFailed += 1;
      } else if (payload.status === 'NOT_VERIFIABLE') {
        notVerifiable += 1;
        if (payload.notVerifiableKind === 'CHECK_NOT_COMPLETED') {
          checkNotCompleted += 1;
        }
      }
    }
  }
  return Object.freeze({ executionFailed, checkNotCompleted, unverified: executionFailed + notVerifiable });
}

/**
 * run.json の Safety の要約（`RunSafetySummary`。設計書 5.6.5）を作る。
 * - `snapshots` は、Run の間に作ったすべての Safety Ledger の snapshot である（Run Coordinator の Ledger の登録から取る）。
 *   Run の Safety の集計は、ここだけで、この snapshot からだけ行う（R15 の I2）。ページの `safety` の Evidence は使わない。
 * - `blockedRequestsByMethod`、`blockedActions`、`excludedInteractionCandidateCount` は、snapshot の記録を合計する。
 *   - `requests`: 読み取り以外のメソッドの件数（`blockedRequestsByMethod`。記録の上限を超えた分も数えた値）と、Interaction の
 *     遮断したリクエストの記録の数の和
 *   - `navigations`: Passive と Interaction の、遮断したナビゲーションの記録の数の和
 *   - `webSockets`: Passive と Interaction の、遮断した WebSocket の記録の数の和
 *   - `externalActions`、`popups`、`downloads`: それぞれの記録の数
 *   記録には上限があるので、件数は下限である（`recordTruncated` が真なら、実際はもっと多いことがある）。
 * - 違反と記録の切り詰めは、`summarizePageSafety` で、同じ snapshot から集計する。
 * - `guardEnabled` は、PREFLIGHT で Guard の有効を確かめたかどうか。
 * - `auditSend`（AS-b）: 実効の監査の段の送信の扱い（`auditSendPolicy`）と、snapshot の通した読み取りでない要求の記録（`passedAuditSendRequests`）の総数と
 *   method ごとの数の合計（method はコード単位の順。値は持たない）。扱いが `READ_ONLY` でも、0 件として必ず入れる。AS-c: ほかの Origin へ通した数
 *   （`otherOrigins` の合計）と、通した WebSocket の接続の数（`passedAuditSendWebSockets.count` の合計）も入れる。AS-c fix round 1: そのうち Guard の route を
 *   通らずに開いた数（`outsideGuard` の合計）と、危険な語に当たる数（`dangerous` の合計）も入れる。
 */
export function summarizeRunSafety(input: {
  readonly guardEnabled: boolean;
  readonly snapshots: readonly SafetyLedgerSnapshot[];
  readonly auditSendPolicy: AuditSendPolicyName;
}): RunSafetySummary {
  return new RunSafetyTotals().summary(input, input.snapshots);
}

/**
 * MEM-3c（DEF-266。D7）: Run の Safety の要約（`summarizeRunSafety`）の、snapshot を受け取った順に足し込む形。再開のときに、保存のページの snapshot を全部持たずに
 * 足し込むために使う。足し込んだ snapshot の順に `summarizeRunSafety` へ渡したときと、同じ要約になる（数の和と飽和の和は順によらない。違反の一覧は足した順）。
 * 違反と記録の切り詰めは、snapshot ごとに `summarizePageSafety` で集計してから足す。
 */
export class RunSafetyTotals {
  readonly #byMethod = new Map<string, number>();
  readonly #blocked: { -readonly [Key in keyof SafetyBlockedActionCounts]: number } = {
    requests: 0,
    navigations: 0,
    externalActions: 0,
    popups: 0,
    downloads: 0,
    webSockets: 0,
  };
  #excludedInteractionCandidateCount = 0;
  #externalSchemeNavigationCount = 0;
  #passedRequests = 0;
  #passedOtherOriginRequests = 0;
  #passedWebSockets = 0;
  #passedWebSocketsOutsideGuard = 0;
  #passedDangerousWebSockets = 0;
  readonly #passedByMethod = new Map<string, number>();
  #invariantViolationCount = 0;
  readonly #invariantViolations: ReturnType<typeof summarizePageSafety>['invariantViolations'][number][] = [];
  #recordTruncated = false;
  #frameClassificationFailureCount = 0;
  #readNavigationFailureCount = 0;
  #hasInvariantViolation = false;

  /** 足した snapshot のどれかが、不変条件の違反を持つか（`invariantViolationCount` が 0 より大きい）。 */
  get hasInvariantViolation(): boolean {
    return this.#hasInvariantViolation;
  }

  /** snapshot を 1 つ足す。 */
  add(snapshot: SafetyLedgerSnapshot): this {
    // AS-c: 通した WebSocket の接続の数。
    this.#passedWebSockets = saturatingAdd(this.#passedWebSockets, snapshot.passedAuditSendWebSockets?.count ?? 0);
    // AS-c fix round 1: そのうち Guard の route を通らずに開いた数と、危険な語に当たる数（記録がない snapshot は 0。LG-4: 記録は数を必ず持つ）。
    this.#passedWebSocketsOutsideGuard = saturatingAdd(this.#passedWebSocketsOutsideGuard, snapshot.passedAuditSendWebSockets?.outsideGuard ?? 0);
    this.#passedDangerousWebSockets = saturatingAdd(this.#passedDangerousWebSockets, snapshot.passedAuditSendWebSockets?.dangerous ?? 0);
    const passed = snapshot.passedAuditSendRequests;
    if (passed !== undefined) {
      this.#passedRequests = saturatingAdd(this.#passedRequests, passed.count);
      // AS-c: ほかの Origin へ通した数（LG-4: 記録は数を必ず持つ）。
      this.#passedOtherOriginRequests = saturatingAdd(this.#passedOtherOriginRequests, passed.otherOrigins);
      for (const [method, count] of Object.entries(passed.byMethod)) {
        this.#passedByMethod.set(method, saturatingAdd(this.#passedByMethod.get(method) ?? 0, count));
      }
    }
    const blocked = this.#blocked;
    for (const [method, count] of Object.entries(snapshot.blockedRequestsByMethod)) {
      this.#byMethod.set(method, (this.#byMethod.get(method) ?? 0) + count);
      blocked.requests += count;
    }
    blocked.requests += snapshot.blockedInteractionRequests.length;
    blocked.navigations += snapshot.blockedNavigations.length + snapshot.blockedInteractionNavigations.length;
    blocked.externalActions += snapshot.blockedExternalActions.length;
    blocked.popups += snapshot.blockedPopups.length;
    blocked.downloads += snapshot.blockedDownloads.length;
    blocked.webSockets += snapshot.blockedWebSockets.length + snapshot.blockedInteractionWebSockets.length;
    this.#excludedInteractionCandidateCount += snapshot.excludedInteractionCandidates.length;
    this.#externalSchemeNavigationCount += snapshot.externalSchemeNavigations.length;
    const safety = summarizePageSafety([snapshot]);
    this.#invariantViolationCount = saturatingAdd(this.#invariantViolationCount, safety.invariantViolationCount);
    this.#invariantViolations.push(...safety.invariantViolations);
    this.#recordTruncated ||= safety.recordTruncated;
    this.#frameClassificationFailureCount = saturatingAdd(this.#frameClassificationFailureCount, safety.frameClassificationFailureCount);
    this.#readNavigationFailureCount = saturatingAdd(this.#readNavigationFailureCount, safety.readNavigationFailureCount);
    this.#hasInvariantViolation ||= snapshot.invariantViolationCount > 0;
    return this;
  }

  /** ほかの足し込み（`other`）を、その順のまま、この後に足す（`other` は変えない）。 */
  addTotals(other: RunSafetyTotals): this {
    for (const [method, count] of other.#passedByMethod) {
      this.#passedByMethod.set(method, saturatingAdd(this.#passedByMethod.get(method) ?? 0, count));
    }
    for (const [method, count] of other.#byMethod) {
      this.#byMethod.set(method, (this.#byMethod.get(method) ?? 0) + count);
    }
    for (const key of Object.keys(this.#blocked) as (keyof SafetyBlockedActionCounts)[]) {
      this.#blocked[key] += other.#blocked[key];
    }
    this.#excludedInteractionCandidateCount += other.#excludedInteractionCandidateCount;
    this.#externalSchemeNavigationCount += other.#externalSchemeNavigationCount;
    this.#passedRequests = saturatingAdd(this.#passedRequests, other.#passedRequests);
    this.#passedOtherOriginRequests = saturatingAdd(this.#passedOtherOriginRequests, other.#passedOtherOriginRequests);
    this.#passedWebSockets = saturatingAdd(this.#passedWebSockets, other.#passedWebSockets);
    this.#passedWebSocketsOutsideGuard = saturatingAdd(this.#passedWebSocketsOutsideGuard, other.#passedWebSocketsOutsideGuard);
    this.#passedDangerousWebSockets = saturatingAdd(this.#passedDangerousWebSockets, other.#passedDangerousWebSockets);
    this.#invariantViolationCount = saturatingAdd(this.#invariantViolationCount, other.#invariantViolationCount);
    this.#invariantViolations.push(...other.#invariantViolations);
    this.#recordTruncated ||= other.#recordTruncated;
    this.#frameClassificationFailureCount = saturatingAdd(this.#frameClassificationFailureCount, other.#frameClassificationFailureCount);
    this.#readNavigationFailureCount = saturatingAdd(this.#readNavigationFailureCount, other.#readNavigationFailureCount);
    this.#hasInvariantViolation ||= other.#hasInvariantViolation;
    return this;
  }

  /**
   * 足したものの後に `extraSnapshots` を足したときの、Run の Safety の要約（この足し込みは変えない）。`guardEnabled` と `auditSendPolicy` は
   * `summarizeRunSafety` と同じ。
   */
  summary(
    input: { readonly guardEnabled: boolean; readonly auditSendPolicy: AuditSendPolicyName },
    extraSnapshots: readonly SafetyLedgerSnapshot[] = [],
  ): RunSafetySummary {
    const totals = new RunSafetyTotals().addTotals(this);
    for (const snapshot of extraSnapshots) {
      totals.add(snapshot);
    }
    return deepFreeze({
      guardEnabled: input.guardEnabled,
      blockedRequestsByMethod: Object.assign(
        Object.create(null) as Record<string, number>,
        Object.fromEntries([...totals.#byMethod].sort(([left], [right]) => compareCodeUnits(left, right))),
      ),
      blockedActions: { ...totals.#blocked },
      excludedInteractionCandidateCount: totals.#excludedInteractionCandidateCount,
      invariantViolationCount: totals.#invariantViolationCount,
      // DEF-144: 違反に結びつく要求（あるときだけ。method・Origin・path。値なし）も写す。
      invariantViolations: totals.#invariantViolations.map(({ code, message, request }) => ({
        code, message, ...(request === undefined ? {} : { request: { ...request } }),
      })),
      recordTruncated: totals.#recordTruncated,
      // SAFE-2 の 4: 違反にしない止めた記録の数と、外部スキームへの移動の試みの数（止めた記録として、報告に数で出す）。
      frameClassificationFailureCount: totals.#frameClassificationFailureCount,
      readNavigationFailureCount: totals.#readNavigationFailureCount,
      externalSchemeNavigationCount: totals.#externalSchemeNavigationCount,
      auditSend: {
        policy: input.auditSendPolicy,
        passedRequests: totals.#passedRequests,
        passedRequestsByMethod: Object.assign(
          Object.create(null) as Record<string, number>,
          Object.fromEntries([...totals.#passedByMethod].sort(([left], [right]) => compareCodeUnits(left, right))),
        ),
        passedOtherOriginRequests: totals.#passedOtherOriginRequests,
        passedWebSockets: totals.#passedWebSockets,
        passedWebSocketsOutsideGuard: totals.#passedWebSocketsOutsideGuard,
        passedDangerousWebSockets: totals.#passedDangerousWebSockets,
      },
    });
  }
}
