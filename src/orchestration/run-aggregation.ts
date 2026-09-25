import { evidenceOfType } from '../audit/rule-helpers.js';
import {
  VIEWPORT_PROFILES,
  type EvidenceRecordFor,
  type EvidenceType,
  type PageAuditResult,
  type PageAuditStatus,
  type RunSafetySummary,
  type SafetyBlockedActionCounts,
  type ViewportPageCounts,
  type ViewportProfile,
} from '../core/contracts.js';
import { deepFreeze } from '../core/immutable.js';
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
export function countPagesByStatus(pages: readonly PageAuditResult[]): ViewportPageCounts {
  const counts = emptyCounts();
  for (const page of pages) {
    counts[PAGE_COUNT_KEYS[page.status]] += 1;
  }
  return Object.freeze(counts);
}

/** ビューポートごとの、ビューポートの状態ごとの数（`viewportPageCounts`）。 */
export function countViewportPages(pages: readonly PageAuditResult[]): Readonly<Record<ViewportProfile, ViewportPageCounts>> {
  const counts = Object.fromEntries(VIEWPORT_PROFILES.map((profile) => [profile, emptyCounts()])) as Record<
    ViewportProfile,
    ReturnType<typeof emptyCounts>
  >;
  for (const page of pages) {
    for (const profile of VIEWPORT_PROFILES) {
      counts[profile][PAGE_COUNT_KEYS[page.viewports[profile].status]] += 1;
    }
  }
  return deepFreeze(counts);
}

/** 状態が `PARTIAL` のビューポートの数（Run Status の入力 `incompleteCollectorCount`）。 */
export function countPartialViewports(pages: readonly PageAuditResult[]): number {
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
export function countInteractionOutcomes(pages: readonly PageAuditResult[]): InteractionOutcomeCounts {
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
 */
export function summarizeRunSafety(input: {
  readonly guardEnabled: boolean;
  readonly snapshots: readonly SafetyLedgerSnapshot[];
}): RunSafetySummary {
  const byMethod = new Map<string, number>();
  const blocked: { -readonly [Key in keyof SafetyBlockedActionCounts]: number } = {
    requests: 0,
    navigations: 0,
    externalActions: 0,
    popups: 0,
    downloads: 0,
    webSockets: 0,
  };
  let excludedInteractionCandidateCount = 0;
  for (const snapshot of input.snapshots) {
    for (const [method, count] of Object.entries(snapshot.blockedRequestsByMethod)) {
      byMethod.set(method, (byMethod.get(method) ?? 0) + count);
      blocked.requests += count;
    }
    blocked.requests += snapshot.blockedInteractionRequests.length;
    blocked.navigations += snapshot.blockedNavigations.length + snapshot.blockedInteractionNavigations.length;
    blocked.externalActions += snapshot.blockedExternalActions.length;
    blocked.popups += snapshot.blockedPopups.length;
    blocked.downloads += snapshot.blockedDownloads.length;
    blocked.webSockets += snapshot.blockedWebSockets.length + snapshot.blockedInteractionWebSockets.length;
    excludedInteractionCandidateCount += snapshot.excludedInteractionCandidates.length;
  }
  const blockedRequestsByMethod = Object.assign(
    Object.create(null) as Record<string, number>,
    Object.fromEntries([...byMethod].sort(([left], [right]) => compareCodeUnits(left, right))),
  );
  const safety = summarizePageSafety(input.snapshots);
  return deepFreeze({
    guardEnabled: input.guardEnabled,
    blockedRequestsByMethod,
    blockedActions: blocked,
    excludedInteractionCandidateCount,
    invariantViolationCount: safety.invariantViolationCount,
    invariantViolations: safety.invariantViolations.map(({ code, message }) => ({ code, message })),
    recordTruncated: safety.recordTruncated,
  });
}
