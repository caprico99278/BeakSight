import type { PageSafetySummary, SafetyInvariantViolationSummary } from '../core/contracts.js';
import {
  BLOCKED_EXTERNAL_ACTION_REASONS,
  type BlockedAuditExclusionEvent,
  type BlockedAuditExclusionsRecord,
  type BlockedClosingRequestEvent,
  type BlockedClosingRequestsRecord,
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
  type DetachedTargetContinuesRecord,
  type ExcludedInteractionCandidateEvent,
  type ExternalSchemeNavigationEvent,
  type FrameClassificationFailureEvent,
  type FrameClassificationFailuresRecord,
  type InteractionRejectionReasonEvidence,
  type ReadNavigationFailureEvent,
  type ReadNavigationFailuresRecord,
  type PassedAuditSendRequestsRecord,
  type PassedAuditSendWebSocketsRecord,
  type SafetyEventKind,
  type SafetyEventsEvidence,
  type SafetyEvidenceLoad,
  type SafetyEvidenceScope,
} from '../core/evidence-types.js';
import { deepFreeze } from '../core/immutable.js';
import { saturatingAdd, saturatingIncrement } from '../core/saturating-count.js';
import { redactValueLikePathSegments } from '../core/url-path-redaction.js';
import { canonicalHttpOriginOf, redactUrlCredentials } from '../crawl/normalize-url.js';

// 事象の型と記録の上限の情報の型は、Safety の Evidence と同じ型なので、`src/core/evidence-types.ts` に1か所だけ置く
// （Task 12・13 の設計書 5.4.1）。既存の import 元を保つため、同じ名前で re-export する。
export type {
  BlockedAuditExclusionEvent,
  BlockedAuditExclusionsRecord,
  BlockedClosingRequestEvent,
  BlockedClosingRequestsRecord,
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
  FrameClassificationFailureEvent,
  FrameClassificationFailuresRecord,
  ReadNavigationFailureEvent,
  ReadNavigationFailuresRecord,
  SafetyLedgerRecordLimits,
} from '../core/evidence-types.js';

/**
 * 不変条件の違反の1件（CC-015）。形の owner は core の `SafetyInvariantViolationSummary`（`src/core/contracts.ts`）で、
 * ここは既存の import 元を保つための別名にする（同じ形の型をもう一度書かない）。
 */
export type InvariantViolationEvent = SafetyInvariantViolationSummary;

/**
 * DEF-144: 違反を記録するときの入力。`request` は、違反が結びつく要求の method と URL（Ledger が Origin と path だけを取り出して残す。URL は残さない）。
 */
export interface InvariantViolationInput {
  readonly code: string;
  readonly message: string;
  readonly request?: { readonly method: string; readonly url: string } | undefined;
}

/**
 * 事象と違反の記録の分類の名前（CC-028）。記録の上限に達したときに `recordLimits.reachedCategories` に残した（LZ-3a: 事象の数の上限は撤廃したので、
 * 今は残さない。前の記録を読むために型を残す）。
 * 事象の一覧の名前は core の `SafetyEventKind` から取り、書き間違いを型のエラーにする。
 * `blockedRequestsByMethod` の上限の分類は、この型に含めない（`SafetyLedgerUncountedBlockedRequestCategory`）。
 */
export type SafetyLedgerRecordCategory =
  | SafetyEventKind
  | 'blockedAuditExclusions'
  | 'blockedClosingRequests'
  | 'frameClassificationFailures'
  | 'readNavigationFailures'
  | 'invariantViolations';

/**
 * 上限のために `blockedRequestsByMethod` で数えられなかった遮断の分類の名前（CC-028 の残り。P18e）。LZ-3c: method の種類と数の上限は撤廃したので、
 * 今は残さない（前の記録を読むために型を残す）。
 * - `'blockedRequestsByMethod'`: メソッドの種類の数の上限（前は 64）に達した。
 * - `` `blockedRequestsByMethod.${method}.counter` ``: そのメソッドの件数が、数の上限（前は 65,535）に達した。
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
export interface SafetyLedgerSnapshot extends Omit<SafetyEventsEvidence, 'scope' | 'load'> {
  /** 記録できた違反。違反の上限（ブロックの記録とは別）に達した後の違反は記録されないが、件数には数える。 */
  readonly invariantViolations: readonly InvariantViolationEvent[];
  /** 記録できなかった分も含む、違反の総数。`RunStatusInput.safetyInvariantViolations` に渡す。 */
  readonly invariantViolationCount: number;
}

/**
 * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、Guard が通した読み取りでない要求の記録の形。
 * AS-b: 止めた要求と同じく Safety の Evidence の項目（`SafetyEventsEvidence.passedAuditSendRequests`）にしたので、型の定義は core の 1 か所（ここは別名）。
 * 1 件でも通したときだけ snapshot に入れる（今の出力は変えない）。
 */
export type {
  PassedAuditSendRequest,
  PassedAuditSendRequestsRecord,
  PassedAuditSendWebSocket,
  PassedAuditSendWebSocketsRecord,
} from '../core/evidence-types.js';

/**
 * Safety Ledger の snapshot から、safety の Evidence の payload を作る（Task 12・13 の設計書 5.4.1）。
 * 不変条件の違反（`invariantViolations`、`invariantViolationCount`）は含めない。違反は Finding にせず、
 * snapshot のまま Run Status の入力にする。結果は深く凍結する（snapshot の中身は `SafetyLedger.snapshot()` で凍結済み）。
 */
export function safetyEventsEvidenceFromSnapshot(
  snapshot: SafetyLedgerSnapshot,
  scope: SafetyEvidenceScope,
  load: SafetyEvidenceLoad,
): SafetyEventsEvidence {
  // AS-b: 通した読み取りでない要求の記録（あるときだけ）は、止めた要求の記録と同じく Evidence に入れる（値は持たない）。
  // BN-a（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1 の 4）: 読み込みの印（`load`）を、`scope` の次に付ける。LG-4: 印は必須
  // （page-schema/1.0 の印のない記録は捨てた）。
  const { invariantViolations: _invariantViolations, invariantViolationCount: _invariantViolationCount, ...events } = snapshot;
  return deepFreeze({ scope, load: { ...load }, ...events });
}

/**
 * BN-a: 閉じる途中に止めた要求の記録の入力（method と URL を読めなかった要求は `null`。数だけ数える）。
 * 止めた要求・移動・WebSocket・監査の段の除外の記録の時点（`phase`）と要求の種類（`resourceType`）は、記録の型の必須の項目として受け取る（Guard は、記録の口の
 * 型 `BlockedRequestFacts` で必ず渡す。LG-4 で省略できる形を捨てた）。
 */
export type BlockedClosingRequestInput = {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  /** BN-R1 の M-2: 先読みの要求なら真（記録に印 `speculative: true` を付ける）。 */
  readonly speculative?: boolean;
} | null;

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
  // SAFE-2 の 4: 違反でない記録の数（止めた記録として数に出す）。
  let frameClassificationFailureCount = 0;
  let readNavigationFailureCount = 0;
  for (const snapshot of snapshots) {
    frameClassificationFailureCount = saturatingAdd(frameClassificationFailureCount, snapshot.frameClassificationFailures?.count ?? 0);
    readNavigationFailureCount = saturatingAdd(readNavigationFailureCount, snapshot.readNavigationFailures?.count ?? 0);
    invariantViolationCount = saturatingAdd(invariantViolationCount, snapshot.invariantViolationCount);
    // DEF-144: 違反に結びつく要求（あるときだけ）も写す。
    invariantViolations.push(...snapshot.invariantViolations.map(({ code, message, request }) => ({
      code, message, ...(request === undefined ? {} : { request: { ...request } }),
    })));
    recordTruncated ||= snapshot.recordLimits.truncated;
  }
  return deepFreeze({ invariantViolationCount, invariantViolations, recordTruncated, frameClassificationFailureCount, readNavigationFailureCount });
}

// LZ-3a: 事象の数の上限（前は `MAX_LEDGER_EVENTS` 256・`MAX_LEDGER_INVARIANT_VIOLATIONS` 256。超えた事象は捨て、記録を不完全にした）は撤廃した。
// 事象を残らず記録する（`recordLimits.droppedEventCount` は前の記録の形のために残し、いつも 0）。LZ-3c: method の種類 64 と数 65,535 の上限も撤廃した。
// LZ-2: 文の長さの上限（前は `MAX_LEDGER_TEXT_LENGTH` 2,048）は撤廃した。文・URL・Origin・path は切り詰めない。

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
  /** 監査の段の除外で遮断した要求（T25b round 1）。 */
  readonly #blockedAuditExclusions: BlockedAuditExclusionEvent[] = [];
  #blockedAuditExclusionCount = 0;
  /** BN-a: 閉じる途中に止めた要求（`blockedClosingRequests`）。件数は、method・URL を読めなかった分も数える。 */
  readonly #blockedClosingRequests: BlockedClosingRequestEvent[] = [];
  #blockedClosingRequestCount = 0;
  /** SAFE-2 の 4: frame の判定の失敗と、読み取りの main frame の移動の失敗の記録（違反でない）。 */
  readonly #frameClassificationFailures: FrameClassificationFailureEvent[] = [];
  #frameClassificationFailureCount = 0;
  readonly #readNavigationFailures: ReadNavigationFailureEvent[] = [];
  #readNavigationFailureCount = 0;
  /** CDPX: 許した要求を続ける命令が、OOPIF の target が先に外れたために送れなかった数（違反でない）。 */
  #detachedTargetContinueCount = 0;
  readonly #invariantViolations: InvariantViolationEvent[] = [];
  #invariantViolationCount = 0;
  /** AS-a: 監査の段の送信の扱いで通した読み取りでない要求（総数、method ごとの数、method・Origin・path ごとの行、一覧に入れなかった数）。 */
  #passedAuditSendCount = 0;
  readonly #passedAuditSendByMethod: Record<string, number> = Object.create(null) as Record<string, number>;
  readonly #passedAuditSendRows = new Map<string, { readonly method: string; readonly origin: string; readonly path: string; count: number }>();
  #passedAuditSendUnlisted = 0;
  /** AS-c: 通した要求のうち、ほかの Origin へのものの数。 */
  #passedAuditSendOtherOrigins = 0;
  /** FRET fix round 4: 通した要求のうち、窓を開くボタンの確かめが押した page の、閉じる前の離れる手順の間に通した数。 */
  #passedAuditSendAfterDialogPressLeave = 0;
  /** AS-c: 監査の段の送信の扱いで通した WebSocket の接続（総数、Origin・path ごとの行、一覧に入れなかった数）。 */
  #passedWebSocketCount = 0;
  readonly #passedWebSocketRows = new Map<string, {
    readonly origin: string;
    readonly path: string;
    count: number;
    readonly outsideGuard?: true;
    readonly dangerous?: true;
  }>();
  #passedWebSocketUnlisted = 0;
  /** AS-c fix round 1（C-1・C-2）: そのうち Guard の route を通らずに開いた接続の数と、危険な語に当たる接続の数。 */
  #passedWebSocketOutsideGuard = 0;
  #passedWebSocketDangerous = 0;
  /** FRET fix round 5: 押した page の、押す期間の後の止めの続きの間に、前から開いていた接続が送った frame の数。 */
  #passedWebSocketFramesAfterDialogPress = 0;

  /**
   * FRET fix round 5（設計者の判断 (A)）: 窓を開くボタンの確かめが押した page で、押す期間の後から page を閉じるまでに、前から開いていた WebSocket の接続が送った
   * frame を 1 つ数える（止めない。中身は持たない）。通した接続の記録（`passedAuditSendWebSockets`）の項目に出る。
   */
  recordWebSocketFrameAfterDialogPress(): void {
    this.#passedWebSocketFramesAfterDialogPress = saturatingIncrement(this.#passedWebSocketFramesAfterDialogPress);
  }

  recordBlockedRequest(event: BlockedRequestEvent): void {
    const method = this.#recordedMethod(event.method);
    this.#countByMethod(this.#blockedRequestsByMethod, method);
    this.#pushEvent(this.#blockedRequests, {
      ...event,
      method,
      url: event.url,
    });
  }

  /**
   * AS-a（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、Guard が通した読み取りでない要求を
   * 記録する。URL からは Origin と path だけを取り出す（query・fragment・本文・値は持たない。path の値に見える区切りは伏せる）。method ごとの数は、止めた要求の
   * method ごとの数と同じ部品（`#countByMethod`）で数える。同じ method・Origin・path は重ねて
   * 回数を足す。Origin を作れない URL は `unlisted` に数える（LZ-3a: 一覧の行の数の上限（前は 256）はない）。総数は一覧に入れなかった分も数える。
   */
  recordPassedAuditSendRequest(event: {
    readonly method: string;
    readonly url: string;
    readonly otherOrigin?: boolean;
    /** FRET fix round 4: 窓を開くボタンの確かめが押した page の、閉じる前の離れる手順の間に通したか（Guard が見分けて渡す）。 */
    readonly afterDialogPressLeave?: boolean;
  }): void {
    this.#passedAuditSendCount = saturatingIncrement(this.#passedAuditSendCount);
    if (event.afterDialogPressLeave === true) {
      this.#passedAuditSendAfterDialogPressLeave = saturatingIncrement(this.#passedAuditSendAfterDialogPressLeave);
    }
    // AS-c: ほかの Origin（許可 Origin と承認したサービスの Origin のほか）へ通した数（Guard が見分けて渡す）。
    if (event.otherOrigin === true) {
      this.#passedAuditSendOtherOrigins = saturatingIncrement(this.#passedAuditSendOtherOrigins);
    }
    const method = this.#recordedMethod(event.method);
    this.#countByMethod(this.#passedAuditSendByMethod, method);
    const facts = this.#originAndPathOf(event.url);
    if (facts === null) {
      this.#passedAuditSendUnlisted = saturatingIncrement(this.#passedAuditSendUnlisted);
      return;
    }
    const { origin, path } = facts;
    const key = JSON.stringify([method, origin, path]);
    const row = this.#passedAuditSendRows.get(key);
    if (row !== undefined) {
      row.count = saturatingIncrement(row.count);
      return;
    }
    this.#passedAuditSendRows.set(key, { method, origin, path, count: 1 });
  }

  /**
   * AS-c（設計書 5 章の「ユーザーの言葉と選択（AS-c）」の行）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、Guard が通した WebSocket の接続を記録する。URL からは
   * Origin（`ws:`・`wss:`）と path だけを取り出す（query・接続の上の送受信・値は持たない。path の値に見える区切りは伏せる）。同じ Origin・path は重ねて数を足す。
   * Origin を作れない URL は `unlisted` に数える（LZ-3a: 一覧の行の数の上限（前は 256）はない）。総数は一覧に入れなかった分も数えるので、この記録
   * だけでは記録を不完全（`truncated`）にしない。
   * AS-c fix round 1（C-1・C-2）: 記録するのは、ブラウザが実際に開いた接続（Guard の CDP の観察）。Guard の route を通らずに開いた接続（`outsideGuard`）と、
   * 危険な語に当たる接続（`dangerous`）は、印を付けて別の行に数え、それぞれの数も数える。
   */
  recordPassedAuditSendWebSocket(event: { readonly url: string; readonly outsideGuard?: boolean; readonly dangerous?: boolean }): void {
    this.#passedWebSocketCount = saturatingIncrement(this.#passedWebSocketCount);
    const outsideGuard = event.outsideGuard === true;
    const dangerous = event.dangerous === true;
    if (outsideGuard) {
      this.#passedWebSocketOutsideGuard = saturatingIncrement(this.#passedWebSocketOutsideGuard);
    }
    if (dangerous) {
      this.#passedWebSocketDangerous = saturatingIncrement(this.#passedWebSocketDangerous);
    }
    let parsed: URL;
    try {
      parsed = new URL(event.url);
    } catch {
      this.#passedWebSocketUnlisted = saturatingIncrement(this.#passedWebSocketUnlisted);
      return;
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      this.#passedWebSocketUnlisted = saturatingIncrement(this.#passedWebSocketUnlisted);
      return;
    }
    const origin = parsed.origin;
    const path = redactValueLikePathSegments(parsed.pathname);
    const key = JSON.stringify([origin, path, outsideGuard, dangerous]);
    const row = this.#passedWebSocketRows.get(key);
    if (row !== undefined) {
      row.count = saturatingIncrement(row.count);
      return;
    }
    this.#passedWebSocketRows.set(key, {
      origin,
      path,
      count: 1,
      ...(outsideGuard ? { outsideGuard: true } : {}),
      ...(dangerous ? { dangerous: true } : {}),
    });
  }

  recordBlockedNavigation(event: BlockedNavigationEvent): void {
    this.#pushEvent(this.#blockedNavigations, {
      ...event,
      method: this.#recordedMethod(event.method),
      url: event.url,
    });
  }

  recordBlockedWebSocket(event: BlockedWebSocketEvent): void {
    this.#pushEvent(this.#blockedWebSockets, {
      ...event,
      url: event.url,
    });
  }

  recordBlockedExternalAction(event: BlockedExternalActionEvent): void {
    this.#pushEvent(this.#blockedExternalActions, {
      candidateId: event.candidateId,
      url: event.url === null ? null : event.url,
      // 理由は閉じた一覧（`BLOCKED_EXTERNAL_ACTION_REASONS`、CC-014）なので、切り詰めずに記録する。
      reason: event.reason,
    });
  }

  recordExcludedInteractionCandidate(event: ExcludedInteractionCandidateEvent): void {
    this.#pushEvent(this.#excludedInteractionCandidates, {
      candidateId: event.candidateId,
      reason: event.reason,
    });
  }

  recordBlockedInteractionRequest(event: BlockedInteractionRequestEvent): void {
    this.#pushEvent(this.#blockedInteractionRequests, {
      ...event,
      method: this.#recordedMethod(event.method),
      url: event.url,
    });
  }

  recordBlockedInteractionNavigation(event: BlockedInteractionNavigationEvent): void {
    this.#pushEvent(this.#blockedInteractionNavigations, {
      ...event,
      method: this.#recordedMethod(event.method),
      url: event.url,
    });
  }

  recordBlockedPopup(event: BlockedPopupEvent): void {
    this.#pushEvent(this.#blockedPopups, {
      ...event,
      url: event.url,
    });
  }

  recordBlockedDownload(event: BlockedDownloadEvent): void {
    this.#pushEvent(this.#blockedDownloads, {
      ...event,
      url: event.url,
      suggestedFilename: event.suggestedFilename,
    });
  }

  recordBlockedInteractionWebSocket(event: BlockedInteractionWebSocketEvent): void {
    this.#pushEvent(this.#blockedInteractionWebSockets, {
      ...event,
      url: event.url,
    });
  }

  /**
   * 外部スキームへの移動の試みを記録する（C18a、DEF-012）。URL の認証情報は、URL の owner の規則（`redactUrlCredentials`）で
   * 伏せ字にしてから、上限の長さまで切り詰める。frame・段階・理由は閉じた一覧なので、切り詰めない。
   */
  recordExternalSchemeNavigation(event: ExternalSchemeNavigationEvent): void {
    this.#pushEvent(this.#externalSchemeNavigations, {
      url: redactUrlCredentials(event.url),
      scheme: event.scheme,
      frame: event.frame,
      phase: event.phase,
      reason: event.reason,
    });
  }

  /**
   * 監査の段の除外で遮断した要求を記録する（T25b round 1。Task 25 の設計書 4.2）。method と URL は、ほかの要求の記録
   * （`recordBlockedRequest`）と同じく、上限の長さまで切り詰める。値や本文は受け取らない。件数は、記録の上限を超えた分も数える。
   */
  recordBlockedAuditExclusion(event: BlockedAuditExclusionEvent): void {
    this.#blockedAuditExclusionCount = saturatingIncrement(this.#blockedAuditExclusionCount);
    this.#pushEvent(this.#blockedAuditExclusions, {
      method: this.#recordedMethod(event.method),
      url: event.url,
      mainFrameNavigation: event.mainFrameNavigation,
      reason: event.reason,
      // BN-a: 要求の種類と時点（閉じた一覧なので切り詰めない）。
      resourceType: event.resourceType,
      phase: event.phase,
      // BN-R1 の M-2: 先読みの要求の印（先読みのときだけ）。
      ...(event.speculative === true ? { speculative: true as const } : {}),
    });
  }

  /**
   * BN-a（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1 の 2）: Context を閉じる途中に Guard が止めた要求を記録する（止め方は変えない。
   * 止める命令が成功した後に呼ぶ）。method と URL は、ほかの要求の記録と同じく上限の長さまで切り詰める。値や本文は受け取らない。件数は、記録の上限を超えた分と、
   * method・URL を読めなかった要求（`null`）も数える。止めた要求の数（`blockedRequestsByMethod`）と一覧（`blockedRequests`）には入れない。
   */
  recordBlockedClosingRequest(event: BlockedClosingRequestInput): void {
    this.#blockedClosingRequestCount = saturatingIncrement(this.#blockedClosingRequestCount);
    if (event === null) {
      return;
    }
    this.#pushEvent(this.#blockedClosingRequests, {
      method: this.#recordedMethod(event.method),
      url: event.url,
      resourceType: event.resourceType,
      phase: 'CLOSING',
      ...(event.speculative === true ? { speculative: true as const } : {}),
    });
  }

  /**
   * SAFE-2 の 4（違反の区分の (3)）: Guard が移動の frame の種類を判定できなかった 1 件を記録する（前は違反 `FRAME_CLASSIFICATION_FAILED`。違反にしない）。URL の
   * 認証情報は伏せ字にしてから、上限の長さまで切り詰める。
   */
  recordFrameClassificationFailure(event: FrameClassificationFailureEvent): void {
    this.#frameClassificationFailureCount = saturatingIncrement(this.#frameClassificationFailureCount);
    this.#pushEvent(this.#frameClassificationFailures, {
      url: redactUrlCredentials(event.url),
      phase: event.phase,
    });
  }

  /**
   * SAFE-2 の 4（DEF-145）: 許した読み取り（GET・HEAD）の main frame の移動の配送の失敗を、読み取りの失敗として記録する（前は違反 `HTTP_MAIN_FRAME_DELIVERY_FAILED`。
   * 違反にしない）。URL は Origin と path だけを残す（違反の要求と同じ部品。query・fragment・値は持たない）。
   */
  recordReadNavigationFailure(event: ReadNavigationFailureEvent): void {
    this.#readNavigationFailureCount = saturatingIncrement(this.#readNavigationFailureCount);
    const facts = this.#originAndPathOf(event.url);
    this.#pushEvent(this.#readNavigationFailures, {
      method: this.#recordedMethod(event.method),
      url: facts === null ? '' : `${facts.origin}${facts.path}`,
      errorText: event.errorText,
      phase: event.phase,
    });
  }

  /** CDPX: Guard が許した要求を続ける命令が、OOPIF の target が先に外れたために送れなかったことを数える（違反にしない。要求の値は持たない）。 */
  recordDetachedTargetContinue(): void {
    this.#detachedTargetContinueCount = saturatingIncrement(this.#detachedTargetContinueCount);
  }

  /**
   * 不変条件の違反を記録する。DEF-144: 違反が 1 つの要求に結びつくとき（`request`）は、その method と、URL から取り出した Origin と path を残す（通した要求の
   * 記録と同じ部品 `#originAndPathOf`。query・fragment・本文・値は持たない。Origin を作れない URL は Origin を `null`、path を空にする）。
   */
  recordInvariantViolation(event: InvariantViolationInput): void {
    this.#invariantViolationCount = saturatingIncrement(this.#invariantViolationCount);
    const request = event.request === undefined
      ? undefined
      : { method: this.#recordedMethod(event.request.method), ...(this.#originAndPathOf(event.request.url) ?? { origin: null, path: '' }) };
    this.#pushEvent(this.#invariantViolations, {
      code: event.code,
      message: event.message,
      ...(request === undefined ? {} : { request }),
    });
  }

  snapshot(): SafetyLedgerSnapshot {
    const immutableEvents = <Event extends object>(events: readonly Event[]): readonly Readonly<Event>[] => (
      Object.freeze(events.map((event) => Object.freeze({ ...event })))
    );
    // T25b round 1: 監査の段の除外の記録は、1 件でも記録したときだけ snapshot に入れる（公開監査の出力は変えない）。
    const blockedAuditExclusions: { readonly blockedAuditExclusions?: BlockedAuditExclusionsRecord } =
      this.#blockedAuditExclusionCount === 0
        ? {}
        : {
          blockedAuditExclusions: Object.freeze({
            count: this.#blockedAuditExclusionCount,
            events: immutableEvents(this.#blockedAuditExclusions),
          }),
        };
    // AS-a: 通した読み取りでない要求の記録も、1 件でも通したときだけ snapshot に入れる（今の出力は変えない）。
    const passedAuditSendRequests: { readonly passedAuditSendRequests?: PassedAuditSendRequestsRecord } =
      this.#passedAuditSendCount === 0
        ? {}
        : {
          passedAuditSendRequests: Object.freeze({
            count: this.#passedAuditSendCount,
            byMethod: Object.freeze(Object.assign(Object.create(null) as Record<string, number>, this.#passedAuditSendByMethod)),
            requests: immutableEvents([...this.#passedAuditSendRows.values()]),
            unlisted: this.#passedAuditSendUnlisted,
            otherOrigins: this.#passedAuditSendOtherOrigins,
            ...(this.#passedAuditSendAfterDialogPressLeave === 0 ? {} : { afterDialogPressLeave: this.#passedAuditSendAfterDialogPressLeave }),
          }),
        };
    // AS-c: 通した WebSocket の接続の記録も、1 本でも通したときだけ snapshot に入れる。
    const passedAuditSendWebSockets: { readonly passedAuditSendWebSockets?: PassedAuditSendWebSocketsRecord } =
      this.#passedWebSocketCount === 0
        ? {}
        : {
          passedAuditSendWebSockets: Object.freeze({
            count: this.#passedWebSocketCount,
            connections: immutableEvents([...this.#passedWebSocketRows.values()]),
            unlisted: this.#passedWebSocketUnlisted,
            // AS-c fix round 1（C-1・C-2）: Guard の route を通らずに開いた数と、危険な語に当たる数。
            outsideGuard: this.#passedWebSocketOutsideGuard,
            dangerous: this.#passedWebSocketDangerous,
            ...(this.#passedWebSocketFramesAfterDialogPress === 0 ? {} : { framesAfterDialogPress: this.#passedWebSocketFramesAfterDialogPress }),
          }),
        };
    // BN-a: 閉じる途中に止めた要求の記録も、1 件でも止めたときだけ snapshot に入れる（止めなかった記録の形は変えない）。
    const blockedClosingRequests: { readonly blockedClosingRequests?: BlockedClosingRequestsRecord } =
      this.#blockedClosingRequestCount === 0
        ? {}
        : {
          blockedClosingRequests: Object.freeze({
            count: this.#blockedClosingRequestCount,
            events: immutableEvents(this.#blockedClosingRequests),
          }),
        };
    // SAFE-2 の 4: frame の判定の失敗と、読み取りの main frame の移動の失敗の記録も、1 件でもあったときだけ snapshot に入れる。
    const frameClassificationFailures: { readonly frameClassificationFailures?: FrameClassificationFailuresRecord } =
      this.#frameClassificationFailureCount === 0
        ? {}
        : {
          frameClassificationFailures: Object.freeze({
            count: this.#frameClassificationFailureCount,
            events: immutableEvents(this.#frameClassificationFailures),
          }),
        };
    const readNavigationFailures: { readonly readNavigationFailures?: ReadNavigationFailuresRecord } =
      this.#readNavigationFailureCount === 0
        ? {}
        : {
          readNavigationFailures: Object.freeze({
            count: this.#readNavigationFailureCount,
            events: immutableEvents(this.#readNavigationFailures),
          }),
        };
    // CDPX: target が外れて送れなかった続ける命令の数も、1 件でもあったときだけ入れる。
    const detachedTargetContinues: { readonly detachedTargetContinues?: DetachedTargetContinuesRecord } =
      this.#detachedTargetContinueCount === 0 ? {} : { detachedTargetContinues: Object.freeze({ count: this.#detachedTargetContinueCount }) };
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
        // LZ-3a・LZ-3c: 事象を捨てず、method ごとの数も残らず数えるので、記録はいつも完全（4 つの項目は前の記録の形のために残す）。
        truncated: false,
        droppedEventCount: 0,
        uncountedBlockedRequestCount: 0,
        // LZ-2: 文を切り詰めないので、いつも 0（前の記録の形のために残す）。
        truncatedTextCount: 0,
        reachedCategories: Object.freeze([]),
      }),
      ...blockedAuditExclusions,
      ...passedAuditSendRequests,
      ...passedAuditSendWebSockets,
      ...blockedClosingRequests,
      ...frameClassificationFailures,
      ...readNavigationFailures,
      ...detachedTargetContinues,
    });
  }

  /**
   * method ごとの数を 1 つ足す（止めた要求と、AS-a の通した要求の共通の部品）。LZ-3c: method の種類の数（前は 64）と数（前は 65,535）の上限は撤廃した
   * （数の型は JavaScript の数で、16 bit などの型には結び付かない。数え方は、ほかの数と同じ `saturatingIncrement`）。
   */
  #countByMethod(counts: Record<string, number>, method: string): void {
    counts[method] = saturatingIncrement(counts[method] ?? 0);
  }

  /**
   * URL の正規の Origin と path（AS-a の通した要求の記録と、DEF-144 の違反の要求が共有する）。伏せてから切り、切った後にもう一度伏せる（値の一部だけが
   * 残る形にしない。ログインの段の一覧と同じ順）。URL を読めない・http(s) の Origin を作れないときは `null`。
   */
  #originAndPathOf(url: string): { readonly origin: string; readonly path: string } | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const canonicalOrigin = canonicalHttpOriginOf(parsed.origin);
    if (canonicalOrigin === undefined) {
      return null;
    }
    return {
      origin: canonicalOrigin,
      path: redactValueLikePathSegments(parsed.pathname),
    };
  }

  /** LZ-2: method は大文字にするだけ（長さの上限（前は `MAX_HTTP_METHOD_LENGTH` 32）は置かない。切り詰めない）。 */
  #recordedMethod(value: string): string {
    return value.toUpperCase();
  }

  /** 事象を記録する（LZ-3a: 数の上限はない。捨てない）。 */
  #pushEvent<Event extends object>(events: Event[], event: Event): void {
    events.push(event);
  }
}
