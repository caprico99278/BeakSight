import type { PageSafetySummary, SafetyInvariantViolationSummary } from '../core/contracts.js';
import {
  BLOCKED_EXTERNAL_ACTION_REASONS,
  type BlockedDownloadEvent,
  type BlockedExternalActionEvent,
  type BlockedExternalActionReason,
  type BlockedInteractionNavigationEvent,
  type BlockedInteractionRequestEvent,
  type BlockedInteractionWebSocketEvent,
  type BlockedNavigationEvent,
  type BlockedPopupEvent,
  type BlockedRequestEvent,
  type BlockedWebSocketEvent,
  type ExcludedInteractionCandidateEvent,
  type ExternalSchemeNavigationEvent,
  type InteractionRejectionReasonEvidence,
  type SafetyEventKind,
  type SafetyEventsEvidence,
  type SafetyEvidenceScope,
} from '../core/evidence-types.js';
import { deepFreeze } from '../core/immutable.js';
import { MAX_HTTP_METHOD_LENGTH } from '../core/limits.js';
import { truncateText } from '../core/text.js';
import { redactUrlCredentials } from '../crawl/normalize-url.js';

// 事象の型と記録の上限の情報の型は、Safety の Evidence と同じ型なので、`src/core/evidence-types.ts` に1か所だけ置く
// （Task 12・13 の設計書 5.4.1）。既存の import 元を保つため、同じ名前で re-export する。
export type {
  BlockedDownloadEvent,
  BlockedExternalActionEvent,
  BlockedInteractionNavigationEvent,
  BlockedInteractionRequestEvent,
  BlockedInteractionWebSocketEvent,
  BlockedNavigationEvent,
  BlockedPopupEvent,
  BlockedRequestEvent,
  BlockedWebSocketEvent,
  ExcludedInteractionCandidateEvent,
  ExternalSchemeNavigationEvent,
  SafetyLedgerRecordLimits,
} from '../core/evidence-types.js';

/**
 * 不変条件の違反の1件（CC-015）。形の owner は core の `SafetyInvariantViolationSummary`（`src/core/contracts.ts`）で、
 * ここは既存の import 元を保つための別名にする（同じ形の型をもう一度書かない）。
 */
export type InvariantViolationEvent = SafetyInvariantViolationSummary;

/**
 * 事象と違反の記録の分類の名前（CC-028）。記録の上限に達したときに `recordLimits.reachedCategories` に残す。
 * 事象の一覧の名前は core の `SafetyEventKind` から取り、書き間違いを型のエラーにする。
 * `blockedRequestsByMethod` の上限の分類（`#recordUncountedBlockedRequest`）は、この型に含めない
 * （`SafetyLedgerUncountedBlockedRequestCategory`）。
 */
export type SafetyLedgerRecordCategory = SafetyEventKind | 'invariantViolations';

/**
 * 上限のために `blockedRequestsByMethod` で数えられなかった遮断の分類の名前（CC-028 の残り。P18e）。
 * - `'blockedRequestsByMethod'`: メソッドの種類の数の上限（`MAX_LEDGER_METHOD_KEYS`）に達した。
 * - `` `blockedRequestsByMethod.${method}.counter` ``: そのメソッドの件数が、安全な整数の上限に達した。
 * メソッドの名前は、観測した値そのものなので、`string` のままにする（値は変えない）。
 */
export type SafetyLedgerUncountedBlockedRequestCategory =
  | 'blockedRequestsByMethod'
  | `blockedRequestsByMethod.${string}.counter`;

/**
 * 記録の上限に達した分類の名前（`recordLimits.reachedCategories` に残すもの。CC-028）。JSON の型
 * （`SafetyLedgerRecordLimits.reachedCategories`）とスキーマは、`string` のままである。
 */
export type SafetyLedgerReachedCategory = SafetyLedgerRecordCategory | SafetyLedgerUncountedBlockedRequestCategory;

/**
 * Safety Ledger の snapshot。Safety の Evidence（`SafetyEventsEvidence`）の項目から `scope` を除き、
 * 不変条件の違反の項目を加えたもの。事象の項目は Evidence の型から導き、ここでは並べ直さない。
 */
export interface SafetyLedgerSnapshot extends Omit<SafetyEventsEvidence, 'scope'> {
  /** 記録できた違反。違反の上限（ブロックの記録とは別）に達した後の違反は記録されないが、件数には数える。 */
  readonly invariantViolations: readonly InvariantViolationEvent[];
  /** 記録できなかった分も含む、違反の総数。`RunStatusInput.safetyInvariantViolations` に渡す。 */
  readonly invariantViolationCount: number;
}

/**
 * Safety Ledger の snapshot から、safety の Evidence の payload を作る（Task 12・13 の設計書 5.4.1）。
 * 不変条件の違反（`invariantViolations`、`invariantViolationCount`）は含めない。違反は Finding にせず、
 * snapshot のまま Run Status の入力にする。結果は深く凍結する（snapshot の中身は `SafetyLedger.snapshot()` で凍結済み）。
 */
export function safetyEventsEvidenceFromSnapshot(
  snapshot: SafetyLedgerSnapshot,
  scope: SafetyEvidenceScope,
): SafetyEventsEvidence {
  const { invariantViolations: _invariantViolations, invariantViolationCount: _invariantViolationCount, ...events } = snapshot;
  return deepFreeze({ scope, ...events });
}

/**
 * Interaction の候補を実行しない理由が、外部への作用（`blockedExternalActions` に記録する理由、CC-014）か。
 * どの理由をどの記録に残すかは `interactionRejectionLedgerRecord`（`src/safety/interaction-policy.ts`）が決める。
 * この関数は、その結果を `recordBlockedExternalAction` の閉じた型に絞り込むために使う（一致はテストで確かめる）。
 */
export function isBlockedExternalActionReason(
  reason: InteractionRejectionReasonEvidence,
): reason is BlockedExternalActionReason {
  return (BLOCKED_EXTERNAL_ACTION_REASONS as readonly string[]).includes(reason);
}

/**
 * 1ページで作ったすべての Safety Ledger の snapshot から、`PageSafetySummary` を作る（Task 14〜17 の設計書 4.5.1）。
 * 違反の総数は、記録できなかった分も含めて合計し、安全な整数の上限で止める。記録できた違反は、snapshot の順に並べる。
 * どれかの snapshot の記録が上限で不完全なら、`recordTruncated` を真にする。結果は深く凍結する。
 */
export function summarizePageSafety(snapshots: readonly SafetyLedgerSnapshot[]): PageSafetySummary {
  let invariantViolationCount = 0;
  const invariantViolations: InvariantViolationEvent[] = [];
  let recordTruncated = false;
  for (const snapshot of snapshots) {
    invariantViolationCount = saturatingAdd(invariantViolationCount, snapshot.invariantViolationCount);
    invariantViolations.push(...snapshot.invariantViolations.map(({ code, message }) => ({ code, message })));
    recordTruncated ||= snapshot.recordLimits.truncated;
  }
  return deepFreeze({ invariantViolationCount, invariantViolations, recordTruncated });
}

const MAX_LEDGER_EVENTS = 256;
const MAX_LEDGER_INVARIANT_VIOLATIONS = 256;
const MAX_LEDGER_TEXT_LENGTH = 2_048;
const MAX_LEDGER_METHOD_KEYS = 64;
const MAX_LEDGER_COUNTER = 65_535;

export class SafetyLedger {
  readonly #blockedRequestsByMethod: Record<string, number> = Object.create(null) as Record<string, number>;
  readonly #blockedRequests: BlockedRequestEvent[] = [];
  readonly #blockedNavigations: BlockedNavigationEvent[] = [];
  readonly #blockedWebSockets: BlockedWebSocketEvent[] = [];
  readonly #blockedExternalActions: BlockedExternalActionEvent[] = [];
  readonly #excludedInteractionCandidates: ExcludedInteractionCandidateEvent[] = [];
  readonly #blockedInteractionRequests: BlockedInteractionRequestEvent[] = [];
  readonly #blockedInteractionNavigations: BlockedInteractionNavigationEvent[] = [];
  readonly #blockedPopups: BlockedPopupEvent[] = [];
  readonly #blockedDownloads: BlockedDownloadEvent[] = [];
  readonly #blockedInteractionWebSockets: BlockedInteractionWebSocketEvent[] = [];
  readonly #externalSchemeNavigations: ExternalSchemeNavigationEvent[] = [];
  readonly #invariantViolations: InvariantViolationEvent[] = [];
  #invariantViolationCount = 0;
  #droppedEventCount = 0;
  #uncountedBlockedRequestCount = 0;
  #truncatedTextCount = 0;
  readonly #reachedCategories = new Set<SafetyLedgerReachedCategory>();

  recordBlockedRequest(event: BlockedRequestEvent): void {
    const method = this.#boundedMethod(event.method);
    const currentCount = this.#blockedRequestsByMethod[method];
    if (currentCount === undefined) {
      if (Object.keys(this.#blockedRequestsByMethod).length >= MAX_LEDGER_METHOD_KEYS) {
        this.#recordUncountedBlockedRequest('blockedRequestsByMethod');
      } else {
        this.#blockedRequestsByMethod[method] = 1;
      }
    } else if (currentCount >= MAX_LEDGER_COUNTER) {
      this.#recordUncountedBlockedRequest(`blockedRequestsByMethod.${method}.counter`);
    } else {
      this.#blockedRequestsByMethod[method] = currentCount + 1;
    }
    this.#pushEvent(this.#blockedRequests, {
      ...event,
      method,
      url: this.#boundedText(event.url),
    }, 'blockedRequests');
  }

  recordBlockedNavigation(event: BlockedNavigationEvent): void {
    this.#pushEvent(this.#blockedNavigations, {
      ...event,
      method: this.#boundedMethod(event.method),
      url: this.#boundedText(event.url),
    }, 'blockedNavigations');
  }

  recordBlockedWebSocket(event: BlockedWebSocketEvent): void {
    this.#pushEvent(this.#blockedWebSockets, {
      ...event,
      url: this.#boundedText(event.url),
    }, 'blockedWebSockets');
  }

  recordBlockedExternalAction(event: BlockedExternalActionEvent): void {
    this.#pushEvent(this.#blockedExternalActions, {
      candidateId: this.#boundedText(event.candidateId),
      url: event.url === null ? null : this.#boundedText(event.url),
      // 理由は閉じた一覧（`BLOCKED_EXTERNAL_ACTION_REASONS`、CC-014）なので、切り詰めずに記録する。
      reason: event.reason,
    }, 'blockedExternalActions');
  }

  recordExcludedInteractionCandidate(event: ExcludedInteractionCandidateEvent): void {
    this.#pushEvent(this.#excludedInteractionCandidates, {
      candidateId: this.#boundedText(event.candidateId),
      reason: event.reason,
    }, 'excludedInteractionCandidates');
  }

  recordBlockedInteractionRequest(event: BlockedInteractionRequestEvent): void {
    this.#pushEvent(this.#blockedInteractionRequests, {
      ...event,
      method: this.#boundedMethod(event.method),
      url: this.#boundedText(event.url),
    }, 'blockedInteractionRequests');
  }

  recordBlockedInteractionNavigation(event: BlockedInteractionNavigationEvent): void {
    this.#pushEvent(this.#blockedInteractionNavigations, {
      ...event,
      method: this.#boundedMethod(event.method),
      url: this.#boundedText(event.url),
    }, 'blockedInteractionNavigations');
  }

  recordBlockedPopup(event: BlockedPopupEvent): void {
    this.#pushEvent(this.#blockedPopups, {
      ...event,
      url: this.#boundedText(event.url),
    }, 'blockedPopups');
  }

  recordBlockedDownload(event: BlockedDownloadEvent): void {
    this.#pushEvent(this.#blockedDownloads, {
      ...event,
      url: this.#boundedText(event.url),
      suggestedFilename: this.#boundedText(event.suggestedFilename),
    }, 'blockedDownloads');
  }

  recordBlockedInteractionWebSocket(event: BlockedInteractionWebSocketEvent): void {
    this.#pushEvent(this.#blockedInteractionWebSockets, {
      ...event,
      url: this.#boundedText(event.url),
    }, 'blockedInteractionWebSockets');
  }

  /**
   * 外部スキームへの移動の試みを記録する（C18a、DEF-012）。URL の認証情報は、URL の owner の規則（`redactUrlCredentials`）で
   * 伏せ字にしてから、上限の長さまで切り詰める。frame・段階・理由は閉じた一覧なので、切り詰めない。
   */
  recordExternalSchemeNavigation(event: ExternalSchemeNavigationEvent): void {
    this.#pushEvent(this.#externalSchemeNavigations, {
      url: this.#boundedText(redactUrlCredentials(event.url)),
      scheme: this.#boundedText(event.scheme),
      frame: event.frame,
      phase: event.phase,
      reason: event.reason,
    }, 'externalSchemeNavigations');
  }

  recordInvariantViolation(event: InvariantViolationEvent): void {
    this.#invariantViolationCount = saturatingIncrement(this.#invariantViolationCount);
    this.#pushEvent(this.#invariantViolations, {
      code: this.#boundedText(event.code),
      message: this.#boundedText(event.message),
    }, 'invariantViolations', MAX_LEDGER_INVARIANT_VIOLATIONS);
  }

  snapshot(): SafetyLedgerSnapshot {
    const immutableEvents = <Event extends object>(events: readonly Event[]): readonly Readonly<Event>[] => (
      Object.freeze(events.map((event) => Object.freeze({ ...event })))
    );
    return Object.freeze({
      blockedRequestsByMethod: Object.freeze(Object.assign(
        Object.create(null) as Record<string, number>,
        this.#blockedRequestsByMethod,
      )),
      blockedRequests: immutableEvents(this.#blockedRequests),
      blockedNavigations: immutableEvents(this.#blockedNavigations),
      blockedWebSockets: immutableEvents(this.#blockedWebSockets),
      blockedExternalActions: immutableEvents(this.#blockedExternalActions),
      excludedInteractionCandidates: immutableEvents(this.#excludedInteractionCandidates),
      blockedInteractionRequests: immutableEvents(this.#blockedInteractionRequests),
      blockedInteractionNavigations: immutableEvents(this.#blockedInteractionNavigations),
      blockedPopups: immutableEvents(this.#blockedPopups),
      blockedDownloads: immutableEvents(this.#blockedDownloads),
      blockedInteractionWebSockets: immutableEvents(this.#blockedInteractionWebSockets),
      externalSchemeNavigations: immutableEvents(this.#externalSchemeNavigations),
      invariantViolations: immutableEvents(this.#invariantViolations),
      invariantViolationCount: this.#invariantViolationCount,
      recordLimits: Object.freeze({
        truncated: this.#droppedEventCount > 0 || this.#uncountedBlockedRequestCount > 0,
        droppedEventCount: this.#droppedEventCount,
        uncountedBlockedRequestCount: this.#uncountedBlockedRequestCount,
        truncatedTextCount: this.#truncatedTextCount,
        reachedCategories: Object.freeze([...this.#reachedCategories]),
      }),
    });
  }

  #boundedMethod(value: string): string {
    return this.#bounded(value.toUpperCase(), MAX_HTTP_METHOD_LENGTH);
  }

  #boundedText(value: string): string {
    return this.#bounded(value, MAX_LEDGER_TEXT_LENGTH);
  }

  /** 上限を超えた文字列は、違反ではなく、切り詰めて記録する。 */
  #bounded(value: string, maxLength: number): string {
    const bounded = truncateText(value, maxLength);
    if (bounded.truncated) {
      this.#truncatedTextCount = saturatingIncrement(this.#truncatedTextCount);
    }
    return bounded.text;
  }

  /** 上限に達したら、既存の記録を上書きせずに新しいイベントを捨て、記録が不完全であることを残す。 */
  #pushEvent<Event extends object>(
    events: Event[],
    event: Event,
    category: SafetyLedgerRecordCategory,
    limit: number = MAX_LEDGER_EVENTS,
  ): void {
    if (events.length >= limit) {
      this.#droppedEventCount = saturatingIncrement(this.#droppedEventCount);
      this.#reachedCategories.add(category);
      return;
    }
    events.push(event);
  }

  #recordUncountedBlockedRequest(category: SafetyLedgerUncountedBlockedRequestCategory): void {
    this.#uncountedBlockedRequestCount = saturatingIncrement(this.#uncountedBlockedRequestCount);
    this.#reachedCategories.add(category);
  }
}

/** 件数を1増やす。安全な整数の上限で止め、`RunStatusInput` の検証を通る値に保つ。 */
function saturatingIncrement(count: number): number {
  return saturatingAdd(count, 1);
}

/** 件数を足す。安全な整数の上限で止め、`RunStatusInput` の検証を通る値に保つ。 */
function saturatingAdd(count: number, increment: number): number {
  return Math.min(count + increment, Number.MAX_SAFE_INTEGER);
}

