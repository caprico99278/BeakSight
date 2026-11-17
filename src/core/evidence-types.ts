// Evidence の payload の型（collector が実際に返す形）。collector は、ここから型を import する。
// JSON Schema（`schemas/page.schema.json` の `$defs`）は、この型と一致させる。
// src/core は、ほかのディレクトリを import しない。そのため、ほかの owner の型（URL の正規化・受け入れ判定の結果、
// Interaction の候補、監査の設定）の定義は、ここに1か所だけ置く。元の owner（`src/crawl/normalize-url.ts`、
// `src/crawl/admission-policy.ts`、`src/safety/interaction-policy.ts`、`src/config/types.ts`）は、ここの型を
// 型の別名として公開し、同じ形をもう一度定義しない（`tests/unit/core-contracts.test.ts` で確かめる）。
// 値の一覧（閉じた集合）は、`as const` の凍結した配列に1回だけ書き、型はその配列から導く。collector などが値の一覧を
// 使う場合も、ここの配列を import し、同じ値の配列をもう一度書かない。JSON Schema の enum は、この配列と一致させる
// （`tests/unit/schema-enum-consistency.test.ts`）。
import {
  OBSERVATION_STATUSES,
  PARTIAL_FAILURE_REASONS,
  type EvidenceCapture,
  type EvidenceId,
  type IncompleteReasonCode,
  type InteractionStatus,
  type ObservationStatus,
  type PageId,
  type PartialFailureReason,
  type ViewportProfile,
  type ViewportRecheckRecord,
} from './contracts.js';
import type { AuditSendPolicyName } from './audit-send-policy.js';

// ---------------------------------------------------------------------------------------------------------------
// スクロール位置（controlled scroll、DOM、layout、color、accessibility、screenshot）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 文書のスクロール位置（CSSピクセル）。ビューポートのスクロール量（`window.scrollX`・`window.scrollY`）に、
 * `scrollingElement` ではない `body` のスクロール量（`scrollLeft`・`scrollTop`）を足した値。
 * collector が Evidence に記録する「収集した時点のスクロール位置」は、この定義に従う。
 */
export interface ScrollPosition {
  readonly scrollX: number;
  readonly scrollY: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Scroll（controlled scroll の結果。`src/browser/controlled-scroll.ts` の型は、ここの型の別名）
// ---------------------------------------------------------------------------------------------------------------

/**
 * 文書をスクロールする要素。
 *
 * - `SCROLLING_ELEMENT`: `document.scrollingElement`（ない場合は `documentElement`）。ビューポートのスクロールを表す。
 * - `BODY`: `scrollingElement` ではない `body` が、自身のスクロール領域を持つ場合（例: `html{overflow:hidden}` と
 *   `body{overflow:auto}` を、どちらも高さ100%で指定したページ）。
 *
 * 候補（文書、body、内側のスクロール領域）のうち、スクロールできる量（`scrollHeight - clientHeight`）が最も大きいものを
 * たどる（2026-09-23 R4 の N1）。文書と body は、最初にどちらかがスクロールできると分かった時点で、量の大きいほうに決める
 * （同じなら文書）。完了と判定する前に、候補の量を測り直す（R'2 の I-1）。文書と body のうち、たどっていないほうが大きく
 * なっていれば、1回だけ対象を切り替えてたどり直す。内側の領域が最も大きければ、文書（か body）をたどった後に、その領域
 * （最も大きい1つ）を文書と同じ決まり（1回の動きの量、落ち着きの待ち、期限）でたどり、元の位置へ戻す（DEF-207）。たどりきれな
 * かった場合（期限、位置が進まない、領域が文書から外れた）は `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` を返す。内側の領域の測定は
 * `observations` に記録しない（`scrollTarget` は文書か body だけ）。COMPLETE で、`innerScrollScan.representative` のスクロール
 * できる量が `finalSnapshot` の量より大きければ、その領域をたどったことを表す。2つ目以降の内側の領域はたどらない。
 */
export const SCROLL_TARGETS = Object.freeze(['SCROLLING_ELEMENT', 'BODY'] as const);
export type ScrollTargetEvidence = (typeof SCROLL_TARGETS)[number];

/** controlled scroll の1回の測定。 */
export interface ScrollObservationEvidence {
  /** 測定した時刻（エポックからのミリ秒）。 */
  readonly observedAtMs: number;
  /** 追っているスクロール要素。特定できない場合は `null`。 */
  readonly scrollTarget: ScrollTargetEvidence | null;
  /** スクロール要素の `scrollTop`。 */
  readonly scrollY: number;
  /** スクロール要素の表示領域の高さ（`clientHeight`）。 */
  readonly viewportHeight: number;
  /** スクロール要素の `scrollHeight`。 */
  readonly scrollHeight: number;
  /** `scrollingElement`・`documentElement`・`body` の `scrollHeight` の最大値。 */
  readonly contentHeight: number;
  /** 候補の文書（`scrollingElement`）のスクロールできる量（`scrollHeight - clientHeight`）。 */
  readonly documentScrollRange: number;
  /**
   * 候補の body のスクロールできる量。`scrollingElement` ではない body が自身のスクロール領域を持つ（計算値の
   * `overflow-y` が `visible` と `clip` 以外）場合の `scrollHeight - clientHeight`。それ以外は 0。
   */
  readonly bodyScrollRange: number;
  readonly heightGrew: boolean;
  readonly atBottom: boolean;
}

/**
 * たどった要素（文書か body）の最下部に達した後に、内側のスクロール領域を探した結果。
 *
 * 内側のスクロール領域とは、html・`scrollingElement`・body 以外の要素（open な shadow root の中の要素を含む。R'2 の I-3）で、
 * 次をすべて満たすもの。
 * - `checkVisibility(VISIBILITY_CHECK_OPTIONS)` が真（可視）
 * - 計算値の `overflow-y` が `auto` または `scroll`
 * - `clientHeight > 0` かつ `scrollHeight > clientHeight`
 */
export interface InnerScrollScanEvidence {
  /** 調べた要素の数（open な shadow root の中の要素を含む）。走査の上限（`MAX_INNER_SCROLL_SCAN_ELEMENTS`）を超えない。 */
  readonly scannedElementCount: number;
  /** 上限に達し、残りの要素を調べなかった場合は `true`。 */
  readonly scanLimitReached: boolean;
  /** 見つかった内側のスクロール領域の数（調べた範囲のみ）。 */
  readonly containerCount: number;
  /**
   * 代表の領域（スクロールできる量 `scrollHeight - clientHeight` が最大のもの。同じなら先に調べたもの）の大きさ。
   * 見つからなければ `null`。
   */
  readonly representative: Readonly<{ clientHeight: number; scrollHeight: number }> | null;
}

/**
 * controlled scroll が `PARTIAL` を返す理由の閉じた一覧（コードの意味は `INCOMPLETE_REASON_CODES`）。
 * JSON Schema（`scrollEvidence` の `PARTIAL` の `reason`）は、この一覧と一致させる（`tests/unit/schema-validator.test.ts`、
 * `tests/unit/schema-enum-consistency.test.ts`）。
 * - `SCROLL_TARGET_UNRESOLVED`: 内容の高さがビューポートより大きいのに、スクロールする要素を特定できない。
 * - `SCROLL_NOT_ADVANCED`: スクロールを要求しても位置が進まない、または一度もスクロールせずに内容がビューポートより大きい。
 * - `INNER_SCROLL_CONTAINER_NOT_TRAVERSED`: 候補のうちスクロールできる量が最も大きいのが内側のスクロール領域で、その領域を
 *   たどりきれなかった（期限に当たった、位置が進まない、領域が見つからない・文書から外れた。DEF-207）。文書も body も
 *   スクロールできない場合は、量0とみなして比べる。
 * - `INNER_SCROLL_SCAN_LIMIT_REACHED`: 文書も body もスクロールできず、内側のスクロール領域を探す走査が上限に達したため、
 *   領域がないと確かめられない（文書か body をたどった場合は、走査が上限に達しても、その事実を `innerScrollScan` に
 *   記録するだけで、この理由にはしない）。
 * - `SCROLL_TARGET_UNSTABLE`: 対象を1回切り替えてたどり直した後の測り直しでも、スクロールできる量が最も大きい候補が
 *   変わった。
 */
export const SCROLL_INCOMPLETE_REASONS = Object.freeze([
  ...PARTIAL_FAILURE_REASONS,
  'SCROLL_TARGET_UNRESOLVED',
  'SCROLL_NOT_ADVANCED',
  'INNER_SCROLL_CONTAINER_NOT_TRAVERSED',
  'INNER_SCROLL_SCAN_LIMIT_REACHED',
  'SCROLL_TARGET_UNSTABLE',
  // L9（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 期限を受けないときは、進みの見張りが段を終えた理由になる。
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
] as const satisfies readonly IncompleteReasonCode[]);
export type ScrollIncompleteReason = (typeof SCROLL_INCOMPLETE_REASONS)[number];

/**
 * L9: controlled scroll が `COMPLETE` で終えた理由の閉じた一覧。
 * - `BOTTOM_AND_HEIGHT_STABLE`: 最下部で、高さが落ち着いた。
 * - `NO_NEW_STRUCTURE`: 最下部の近くで読み込まれた内容が、新しい作り（`scrollStructureSignaturesOf` の印）を出さなくなった（伸び続ける画面の止め方）。
 */
export const SCROLL_COMPLETE_REASONS = Object.freeze(['BOTTOM_AND_HEIGHT_STABLE', 'NO_NEW_STRUCTURE'] as const);
export type ScrollCompleteReason = (typeof SCROLL_COMPLETE_REASONS)[number];

/**
 * L9（COV-5・AUD-5）: 内側のスクロール領域 1 つをたどるのを止めた理由の閉じた一覧。
 * - `BOTTOM_AND_HEIGHT_STABLE`・`NO_NEW_STRUCTURE`: 文書と同じ決まりで、たどり終えた。
 * - `NOT_ADVANCED`: 動かすよう求めても位置が進まない。`DISCONNECTED`: 領域が文書から外れた。`NOT_FOUND`: 探したときの領域を、たどる前に見失った。
 * - `STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`: 進みの見張りが段を終えた。`DEADLINE_EXCEEDED`: 呼ぶ側の期限か Run の時間の上限。
 * - `EVALUATION_FAILED`・`PAGE_CLOSED`: 読み取りが失敗した、ページが閉じた。
 */
export const INNER_SCROLL_STOP_REASONS = Object.freeze([
  'BOTTOM_AND_HEIGHT_STABLE',
  'NO_NEW_STRUCTURE',
  'NOT_ADVANCED',
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
  'DEADLINE_EXCEEDED',
  'DISCONNECTED',
  'NOT_FOUND',
  'EVALUATION_FAILED',
  'PAGE_CLOSED',
] as const);
export type InnerScrollStopReason = (typeof INNER_SCROLL_STOP_REASONS)[number];

/** L9（COV-5・AUD-5）: 内側のスクロール領域 1 つをたどった記録（見つけた全部の領域の、文書の順）。 */
export interface InnerScrollContainerEvidence {
  /** 領域の CSS の selector（文書の根からの位置。open な shadow root の中など、位置で表せない領域は `null`）。 */
  readonly selector: string | null;
  /** たどる前の位置（`scrollTop`）。測る前に止まった場合は `null`。 */
  readonly originTop: number | null;
  readonly clientHeight: number | null;
  readonly initialScrollHeight: number | null;
  readonly finalScrollHeight: number | null;
  /** 到達した最大の位置（`scrollTop`）。 */
  readonly maxScrollTop: number | null;
  /** 最下部まで届いたか。 */
  readonly reachedBottom: boolean;
  /** 動かした回数。 */
  readonly stepCount: number;
  /** 高さが増えた回数。 */
  readonly heightGrowthCount: number;
  readonly stopReason: InnerScrollStopReason;
  /** 元の位置に戻せたか（測る前に止まった、戻せたか確かめられなかった場合は `null`）。 */
  readonly restored: boolean | null;
}

/** 終了時に文書の先頭（0, 0）へ戻せなかった理由の閉じた一覧。L9: 見張りが段を終えたときは、戻すのを待たないので、その理由になる。 */
export const SCROLL_RESTORATION_FAILURE_REASONS = Object.freeze([
  ...PARTIAL_FAILURE_REASONS,
  'POSITION_NOT_AT_ORIGIN',
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
] as const satisfies readonly IncompleteReasonCode[]);
export type ScrollRestorationFailureReason = (typeof SCROLL_RESTORATION_FAILURE_REASONS)[number];

/**
 * 終了時に文書の先頭（0, 0）へ戻せたかどうか。内側のスクロール領域をたどった場合（DEF-207）は、その領域を元の位置へ戻せた
 * かどうかも含める。文書を戻せて内側の領域を戻せなかったときは、内側の理由（`POSITION_NOT_AT_ORIGIN` など）を記録し、
 * `position`（文書の位置の欄）は `null` にする。
 */
export type ScrollRestorationEvidence =
  | Readonly<{ status: 'RESTORED'; position: Readonly<ScrollPosition> }>
  | Readonly<{
      status: 'NOT_RESTORED';
      reason: ScrollRestorationFailureReason;
      position: Readonly<ScrollPosition> | null;
    }>;

interface ScrollEvidenceFacts {
  /** 高さが増えた測定の回数（`observations` から切り捨てた測定も数える）。 */
  readonly heightGrowthCount: number;
  /**
   * 測定の記録（測った順。対象を切り替えた場合は、切り替える前の測定も含む）。件数には上限
   * （`src/browser/controlled-scroll.ts` の `MAX_SCROLL_OBSERVATIONS`）がある。超えた場合は、最初の測定と最後の測定を残し、
   * その間を切り捨てる。最後の測定（`finalSnapshot`）は切り捨てない。
   */
  readonly observations: readonly Readonly<ScrollObservationEvidence>[];
  /** 上限を超えたために `observations` から切り捨てた測定の件数。切り捨てていなければ 0。 */
  readonly omittedObservationCount: number;
  /**
   * 完了と判定する前の測り直しで、たどる対象（文書か body）を切り替えた回数。上限は
   * `src/browser/controlled-scroll.ts` の `MAX_SCROLL_TARGET_SWITCHES`。切り替えていなければ 0。
   */
  readonly targetSwitchCount: number;
  readonly restoration: ScrollRestorationEvidence;
  /** 内側のスクロール領域を探した結果（最後に探したもの）。探す前に終わった場合は `null`。 */
  readonly innerScrollScan: Readonly<InnerScrollScanEvidence> | null;
  /**
   * L9（COV-5・AUD-5）: 見つけた全部の内側のスクロール領域をたどった記録（文書の順）。任意の欄（この欄のない古い記録は、最も大きい 1 つだけを
   * たどった版）。
   */
  readonly innerScrollContainers?: readonly Readonly<InnerScrollContainerEvidence>[] | undefined;
}

/**
 * controlled scroll の結果（scroll の Evidence の payload。`controlledScroll()` が返す値そのもの）。
 * たどった対象と到達した位置は `finalSnapshot`（最後の測定）の `scrollTarget`・`scrollY` にある。
 */
export type ScrollEvidence = Readonly<ScrollEvidenceFacts & {
  readonly status: 'COMPLETE';
  readonly reason: ScrollCompleteReason;
  readonly finalSnapshot: Readonly<ScrollObservationEvidence>;
}> | Readonly<ScrollEvidenceFacts & {
  readonly status: 'PARTIAL';
  readonly reason: ScrollIncompleteReason;
  /** 最後の測定。1回も測定できなかった場合は `null`。 */
  readonly finalSnapshot: Readonly<ScrollObservationEvidence> | null;
}>;

// ---------------------------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------------------------

export type HeaderEvidence =
  | {
      readonly status: 'OBSERVED';
      readonly values: Readonly<Record<string, string>>;
    }
  | {
      readonly status: 'FAILED';
      readonly errorText: string;
    };

/** レスポンスの転送量（ヘッダとエンコード済みの本文のバイト数）。リクエストが完了する前は `NOT_OBSERVED`。 */
export type ResponseTransferSizeEvidence =
  | {
      readonly status: 'OBSERVED';
      readonly headersBytes: number;
      readonly bodyBytes: number;
      readonly totalBytes: number;
    }
  | { readonly status: 'NOT_OBSERVED' }
  | {
      readonly status: 'FAILED';
      readonly errorText: string;
    };

/** リクエストの時間の内訳（Playwright の `Request.timing()` の値。ミリ秒。観測できない項目は -1）。 */
export interface NetworkTimingEvidence {
  readonly startTime: number;
  readonly domainLookupStart: number;
  readonly domainLookupEnd: number;
  readonly connectStart: number;
  readonly secureConnectionStart: number;
  readonly connectEnd: number;
  readonly requestStart: number;
  readonly responseStart: number;
  readonly responseEnd: number;
}

/** どのフレームの、どの種類のリクエストか。`isMainFrame` はフレームが分からない場合（Service Worker など）に `null`。 */
export interface RequestOriginFlags {
  readonly isNavigationRequest: boolean;
  readonly isMainFrame: boolean | null;
}

export interface NetworkRequestEvidence extends RequestOriginFlags {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly headers: HeaderEvidence;
  readonly timing: NetworkTimingEvidence;
  readonly redirectFromRequestId: string | null;
  readonly redirectToRequestId: string | null;
  readonly redirectChainRequestIds: readonly string[];
  /** メソッド・ヘッダの値のどれかを上限で切り詰めたか（設計者の判断 2026-11-11 から、URL は切り詰めない。前の版の記録では URL の切り詰めも含む）。 */
  readonly truncated: boolean;
}

export interface NetworkResponseEvidence extends RequestOriginFlags {
  readonly requestId: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: HeaderEvidence;
  readonly contentLengthHeader: string | null;
  readonly timing: NetworkTimingEvidence;
  readonly transferSize: ResponseTransferSizeEvidence;
  /** ヘッダの値を上限で切り詰めたか（設計者の判断 2026-11-11 から、URL は切り詰めない。前の版の記録では URL の切り詰めも含む）。 */
  readonly truncated: boolean;
  /** AUD-7: 4xx・5xx の応答の文脈（本文の要旨と、承認したサービスの Origin か）。2xx・3xx の応答と、前の版の記録にはない。 */
  readonly errorContext?: ResponseErrorContextEvidence;
}

/**
 * AUD-7: 誤りの応答の本文の要旨の形の閉じた一覧。`JSON` は許した最上位の鍵だけ、`TEXT`（text/plain）は先頭だけ、`HTML` は `<title>` だけ。
 * 要旨の値は、記録とバンドルにだけ出す（画面と HTML の本文には出さない）。
 */
export const RESPONSE_BODY_SUMMARY_FORMATS = Object.freeze(['JSON', 'TEXT', 'HTML'] as const);
export type ResponseBodySummaryFormat = (typeof RESPONSE_BODY_SUMMARY_FORMATS)[number];

/** AUD-7: 要旨を作らなかった理由の閉じた一覧（空の本文・扱わない種類・解析できない JSON・本文を読めない）。 */
export const RESPONSE_BODY_SUMMARY_NONE_REASONS = Object.freeze(['EMPTY_BODY', 'UNSUPPORTED_CONTENT_TYPE', 'UNPARSABLE_JSON', 'UNREADABLE'] as const);
export type ResponseBodySummaryNoneReason = (typeof RESPONSE_BODY_SUMMARY_NONE_REASONS)[number];

/** AUD-7: 要旨の値の型の閉じた一覧（JSON の値の型。text と title は `string`）。 */
export const RESPONSE_SUMMARY_VALUE_TYPES = Object.freeze(['string', 'number', 'boolean', 'null', 'object', 'array'] as const);
export type ResponseSummaryValueType = (typeof RESPONSE_SUMMARY_VALUE_TYPES)[number];

/** AUD-7: 要旨の 1 つの値。秘密に見える値（`isSecretLikeText`）は `value` を `null` にし、印（`secretLike`）だけを残す。 */
export interface ResponseSummaryFieldEvidence {
  readonly key: string;
  readonly valueType: ResponseSummaryValueType;
  readonly value: string | null;
  readonly secretLike: boolean;
  /** 値を長さで切ったか（本文を保存しないための守り）。 */
  readonly truncated: boolean;
}

export type ResponseBodySummaryEvidence =
  | {
      readonly status: 'OBSERVED';
      readonly format: ResponseBodySummaryFormat;
      readonly fields: readonly ResponseSummaryFieldEvidence[];
    }
  | {
      readonly status: 'NONE';
      readonly reason: ResponseBodySummaryNoneReason;
      /** 本文を読めなかったときの理由の文（`UNREADABLE` だけ）。 */
      readonly errorText: string | null;
    };

/** AUD-7: 4xx・5xx の応答の文脈（Collector が記録する事実。区分は Rule の側が決める）。 */
export interface ResponseErrorContextEvidence {
  readonly bodySummary: ResponseBodySummaryEvidence;
  /** 承認したサービスの Origin への要求の応答か（スクリプトで送るログインの監査の段の Origin。ほかの Run では常に false）。 */
  readonly approvedService: boolean;
}

export interface NetworkFailureEvidence extends RequestOriginFlags {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly errorText: string;
  readonly timing: NetworkTimingEvidence;
  /** メソッド・エラー文のどれかを上限で切り詰めたか（設計者の判断 2026-11-11 から、URL は切り詰めない。前の版の記録では URL の切り詰めも含む）。 */
  readonly truncated: boolean;
  /**
   * BN-a（設計書 3.1 の 3）: BeakSight が止めた要求の失敗か（切り詰める前の `errorText` を、`src/core/blocked-by-client-failures.ts` の
   * `isBlockedByClientFailure` で判定した値）。
   */
  readonly blockedByBeakSight: boolean;
  /** BN-a: 失敗を記録した時点（`BLOCKED_EVENT_PHASES`）。 */
  readonly phase: BlockedEventPhase;
}

/** 同じ口のくり返しの記録の、代表の 1 件（URL と時間の内訳）。 */
export interface NetworkRepeatedReadSampleEvidence {
  readonly url: string;
  readonly timing: NetworkTimingEvidence;
}

/**
 * 同じ口への、成功した読み取りのくり返しを数でまとめた記録（設計者の判断 2026-11-11。要求を出し続ける画面で、要求ごとの記録がメモリを使い続けないため）。
 * - まとめる鍵は、口（method・Origin・path。`requestEndpointKeyOf` と同じ。query と fragment は見ない）・資源の種類・status・main frame の要求か。失敗か・
 *   失敗の理由も鍵の一部だが、まとめるのは成功した読み取りだけなので、いつも「失敗でない」（記録に欄を持たない）。
 * - まとめるのは、読み取り（GET・HEAD）で、文書の読み込みでなく、リダイレクトに関わらず、status が 4xx・5xx でない要求だけ。HTTP の誤り・失敗・止めた要求は、
 *   今までどおり 1 件ずつ `requests`・`responses`・`failures` に残す（Rule が指摘を作る元）。
 * - 最初の 1 件は、`requests`・`responses` に 1 件の記録として残る（`firstRequestId`）。2 件目からは、ここに数えるだけで、1 件ずつの記録は残さない。
 */
export interface NetworkRepeatedReadEvidence {
  readonly method: string;
  readonly origin: string;
  readonly path: string;
  readonly resourceType: string;
  readonly status: number;
  readonly isMainFrame: boolean | null;
  /** まとめた要求の数（最初の 1 件を含む。2 以上）。 */
  readonly count: number;
  /** 最初の 1 件の要求の ID（`requests`・`responses` に残る記録）。 */
  readonly firstRequestId: string;
  /** 最初の 1 件の URL と時間の内訳。 */
  readonly first: NetworkRepeatedReadSampleEvidence;
  /** いちばん遅かった 1 件（`timing.responseEnd` が最も大きいもの。同じなら先のもの）の URL と時間の内訳。 */
  readonly slowest: NetworkRepeatedReadSampleEvidence;
  /** 最初と最後の要求の始まりの時刻（`timing.startTime`。エポックからの ms）。 */
  readonly firstStartTime: number;
  readonly lastStartTime: number;
  /** 転送量の合計（読めた要求の数と、その合計のバイト数）。 */
  readonly transfer: { readonly observedCount: number; readonly totalBytes: number };
  /** query の値の違いの数（違う query の文字列がいくつあったか。query のない要求も 1 つの値として数える）。 */
  readonly distinctQueryCount: number;
}

export interface NetworkEvidence {
  readonly requests: readonly NetworkRequestEvidence[];
  readonly responses: readonly NetworkResponseEvidence[];
  readonly failures: readonly NetworkFailureEvidence[];
  /** 同じ口の成功した読み取りのくり返しをまとめた記録（2 件以上のものだけ）。なければ欄を持たない（前の版の記録にもない）。 */
  readonly repeatedReads?: readonly NetworkRepeatedReadEvidence[];
  /** 件数の上限（前は 2,000）を超えたため記録しなかったリクエストの件数。L2: 上限を置かないので、新しい記録では常に 0（古い記録を読むために残す）。 */
  readonly omittedRequestCount: number;
  /** 記録しなかったリクエストに対する response の件数。 */
  readonly omittedResponseCount: number;
  /** 記録しなかったリクエストに対する失敗の件数。 */
  readonly omittedFailureCount: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------------------------------------------

export interface ConsoleLocationEvidence {
  readonly url: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

/** 記録する console メッセージの種類の閉じた一覧。 */
export const CONSOLE_MESSAGE_TYPES = Object.freeze(['error', 'warning'] as const);
export type ConsoleMessageType = (typeof CONSOLE_MESSAGE_TYPES)[number];

export interface ConsoleMessageEvidence {
  readonly type: ConsoleMessageType;
  readonly text: string;
  readonly location: ConsoleLocationEvidence;
  /** 本文か URL を上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface PageErrorEvidence {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  /** 名前・メッセージ・stack のどれかを上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface ConsoleEvidence {
  readonly consoleMessages: readonly ConsoleMessageEvidence[];
  readonly pageErrors: readonly PageErrorEvidence[];
  /** 件数の上限を超えたため記録しなかった console メッセージ（error・warning）の件数。 */
  readonly omittedConsoleMessageCount: number;
  /** 件数の上限を超えたため記録しなかった pageerror の件数。 */
  readonly omittedPageErrorCount: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Link
// ---------------------------------------------------------------------------------------------------------------

/**
 * 正規化済みの http(s) URL。`src/crawl/normalize-url.ts` の `NormalizedHttpUrl` は、この型の別名。
 * 同じ型なので、クロールのキューにそのまま渡せる（Link は1回だけ抽出し、その結果を再利用する。ARCH03）。
 */
export type NormalizedHttpUrlEvidence = string & { readonly __brand: 'NormalizedHttpUrl' };

/**
 * URL を受け入れない理由のコード（正規化と受け入れ判定で共通の閉じた一覧）。
 * - `INVALID_URL`: URL として解析できない、または http(s) なのに Origin やホストがない。
 * - `UNSUPPORTED_SCHEME`: http(s) 以外の scheme（正規化で使う。受け入れ判定では `SPECIAL_SCHEME_RECORD_ONLY` として記録する）。
 * - `CREDENTIALS_NOT_ALLOWED`: 認証情報（ユーザー名・パスワード）を含む。基準URLから引き継いだ場合を含む。
 * - `URL_TOO_LONG`: 前の記録の読み方のためだけに残す（L14・URL-LEN: 長さでは拒まないので、今は使わない。成果物の schema の enum にあるので、LZ-1 でも消さない）。
 */
export const URL_REJECTION_REASONS = Object.freeze([
  'INVALID_URL',
  'UNSUPPORTED_SCHEME',
  'CREDENTIALS_NOT_ALLOWED',
  'URL_TOO_LONG',
] as const);
export type UrlRejectionReason = (typeof URL_REJECTION_REASONS)[number];

/**
 * URL の正規化の結果。`src/crawl/normalize-url.ts` の `NormalizedUrlResult` は、この型の別名。
 * 受け入れない場合の `rawUrl` は、認証情報を伏せ字にした生の値。
 */
export type LinkNormalizationEvidence =
  | { readonly ok: true; readonly url: NormalizedHttpUrlEvidence }
  | { readonly ok: false; readonly rawUrl: string; readonly reason: UrlRejectionReason };

/**
 * URL の受け入れ判定の結果。`src/crawl/admission-policy.ts` の `UrlAdmission` は、この型の別名。
 * `rawUrl` は、認証情報を伏せ字にした値。
 */
export type LinkAdmissionEvidence =
  | { readonly kind: 'INTERNAL_NAVIGABLE'; readonly url: string }
  | { readonly kind: 'EXTERNAL_RECORD_ONLY'; readonly url: string }
  | { readonly kind: 'SPECIAL_SCHEME_RECORD_ONLY'; readonly rawUrl: string; readonly scheme: string }
  | { readonly kind: 'REJECTED_INVALID'; readonly rawUrl: string; readonly reason: UrlRejectionReason };

/**
 * 1つのアンカーの Evidence。文字（`anchorText`・`ariaLabel`・`title`）は切り詰めない（LZ-3b。前は 1,024 まで）。
 * URL の文字列（`rawHref`、`normalized` と `admission` の値）も切り詰めない（URL-LEN）。
 */
export interface LinkEvidence {
  readonly sourcePageId: PageId;
  readonly anchorText: string;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  /**
   * REV-SD の M-1: リンクの中の画像の `alt`（空でないもの。文書の順）。巡回の移動の操作の前の判定（`linkTextHasDestructiveWord`）がリンクの文字と合わせて見る。
   * 画像の `alt` のないリンクと、前の版の記録にはない。
   */
  readonly imageAlts?: readonly string[];
  readonly rawHref: string;
  readonly normalized: LinkNormalizationEvidence;
  readonly admission: LinkAdmissionEvidence;
  /** 古い版の記録を読むためだけに残す: 文字を上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

/** 1ページの `discoverLinks()` の結果（link の Evidence の payload）。 */
export interface LinkDiscoveryEvidence {
  /** 文書の順のすべてのリンク（COV-6: 件数の上限で打ち切らない。古い版の記録は先頭から 2,000 件まで）。 */
  readonly links: readonly LinkEvidence[];
  /** 古い版の記録を読むためだけに残す: 件数の上限を超えたため記録しなかったリンク（`a[href]`）の件数（COV-6 の後の記録では常に 0）。 */
  readonly omittedLinkCount: number;
  /** COV-6: ページの中の読み取りを分けた回数（1 以上。古い版の記録にはない）。 */
  readonly collectedInParts?: number;
  /**
   * COV-4（網羅の設計書 3.3 の iframe の行）: 許可 Origin の中の子の frame の文書の URL（正規化したもの。frame の木の順。重なりなし）。巡回が、その文書を
   * ページとして読む。前の版の記録にはない。
   */
  readonly frames?: readonly NormalizedHttpUrlEvidence[];
}

// ---------------------------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------------------------

/**
 * 見える見出し（見出しの要素が可視であるか、可視テキストを持つもの）。`text` は可視テキストと同じ判定と走査で集める。
 */
export interface HeadingEvidence {
  readonly level: number;
  readonly text: string;
  /** 古い版の記録を読むためだけに残す: `text` を長さの上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

/** landmark の区分。`other` は、どの landmark にも属さない可視テキストの区分。 */
export const SEMANTIC_REGION_KINDS = Object.freeze(
  ['header', 'navigation', 'main', 'aside', 'footer', 'form', 'other'] as const,
);
export type SemanticRegionKind = (typeof SEMANTIC_REGION_KINDS)[number];

/** 可視テキストの出どころの閉じた一覧（意味は `VisibleTextEvidence.source`）。 */
export const VISIBLE_TEXT_SOURCES = Object.freeze(['SEMANTIC_LANDMARKS', 'BODY_FALLBACK'] as const);
export type VisibleTextSource = (typeof VISIBLE_TEXT_SOURCES)[number];

export interface SemanticRegionEvidence {
  readonly kind: SemanticRegionKind;
  readonly text: string;
  /**
   * 区分全体が `aria-hidden="true"` の中にあるか（支援技術に公開されないか）。可視かどうかとは別の事実。
   * landmark の区分では、その要素か祖先が `aria-hidden="true"` であること。`other` の区分では、その区分のテキストがすべて
   * `aria-hidden="true"` の中にあること。
   */
  readonly ariaHidden: boolean;
  /** 古い版の記録を読むためだけに残す: `text` を長さの上限で切り詰めたか（COV-6 の後の記録では常に false）。 */
  readonly truncated: boolean;
}

export interface VisibleTextEvidence {
  /** landmark の区分に可視テキストがあれば `SEMANTIC_LANDMARKS`、なければ `BODY_FALLBACK`（`regions` は空）。 */
  readonly source: VisibleTextSource;
  /** body の中の可視テキスト（`checkVisibility(VISIBILITY_CHECK_OPTIONS)` が真の要素のテキスト）を、文書の順に並べたもの。 */
  readonly text: string;
  /** 古い版の記録を読むためだけに残す: `text` を長さの上限で切り詰めたか（COV-6 の後の記録では常に false）。 */
  readonly truncated: boolean;
  /** 古い版の記録を読むためだけに残す: たどるノードの数が上限に達し、残りをたどらなかったか（COV-6 の後の記録では常に false）。 */
  readonly nodeLimitReached: boolean;
  /** `text` のうち、`aria-hidden="true"` の中にある部分。 */
  readonly ariaHiddenText: string;
  /** landmark の区分（文書の順）と、最後に `other` の区分。 */
  readonly regions: readonly SemanticRegionEvidence[];
  /** 古い版の記録を読むためだけに残す: 件数の上限により記録しなかった、テキストのある landmark の区分の数（COV-6 の後の記録では常に 0）。 */
  readonly omittedRegionCount: number;
}

export interface ImageDomEvidence {
  /** `src` 属性の値。 */
  readonly src: string | null;
  /** 解決済みのURL（`img.currentSrc`、なければ `img.src`）。どちらも空なら `null`。 */
  readonly resolvedUrl: string | null;
  readonly alt: string | null;
  readonly complete: boolean;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  /** 古い版の記録を読むためだけに残す: `alt` を長さの上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

/** 入力欄（`input`、`select`、`textarea`。`input` の submit・image・button・reset は除く）の事実。 */
export interface FormFieldEvidence {
  readonly type: string;
  readonly name: string;
  readonly required: boolean;
  /** 入力欄の要素の `checkVisibility(VISIBILITY_CHECK_OPTIONS)` の結果（可視判定の定義は設計書 foundation-corrections 5.5）。 */
  readonly visible: boolean;
  /** 関連付けられた label（`field.labels`）のうち、可視テキストがあるもののテキスト。 */
  readonly labels: readonly string[];
  /** 空白以外の値を持つ `aria-label` 属性があるか。 */
  readonly hasAriaLabel: boolean;
  /** 空白以外の値を持つ `aria-labelledby` 属性があるか（参照先があるかどうかは確かめない）。 */
  readonly hasAriaLabelledby: boolean;
  /** 空白以外の値を持つ `title` 属性があるか。 */
  readonly hasTitle: boolean;
  /** 古い版の記録を読むためだけに残す: `type`・`name`・`labels` のいずれかを上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

/** 記録する送信のコントロールの `type` の閉じた一覧。 */
export const SUBMIT_CONTROL_TYPES = Object.freeze(['submit', 'image'] as const);
export type SubmitControlType = (typeof SUBMIT_CONTROL_TYPES)[number];

export interface SubmitControlEvidence {
  readonly type: SubmitControlType;
  readonly name: string;
  readonly value: string;
  readonly text: string;
  /** 古い版の記録を読むためだけに残す: `name`・`value`・`text` のいずれかを長さの上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

export interface FormDomEvidence {
  readonly method: string;
  readonly action: string;
  readonly fields: readonly FormFieldEvidence[];
  readonly submitControls: readonly SubmitControlEvidence[];
  /** 古い版の記録を読むためだけに残す（この 2 つの件数は、COV-6 の後の記録では常に 0）。 */
  readonly omittedFieldCount: number;
  readonly omittedSubmitControlCount: number;
  /** 古い版の記録を読むためだけに残す: `method`・`action` を長さの上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

export interface DuplicateIdEvidence {
  readonly id: string;
  /** 同じ `id` を持つ要素の数（2以上）。 */
  readonly count: number;
  /** 古い版の記録を読むためだけに残す: `id` を長さの上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

/**
 * 文書の項目ごとに、長さの上限で切り詰めたか（R''2 の m4）。キーは `DomEvidence` の項目の名前と同じ。
 * LZ-3b: どの項目も切り詰めない（印は常に false。前の記録の読み方のために項目は残す。前の上限は `title`・`metaDescription`・`lang` が 1,024）。
 * URL-LEN: `canonicalUrl` も切り詰めない。前の記録で切り詰めた canonical の URL は、
 * 元の URL と異なるので、Rule（例: `INVALID_CANONICAL_URL`）は `canonicalUrl` の印を見て判定する。
 */
export interface DomDocumentFieldTruncationEvidence {
  readonly title: boolean;
  readonly metaDescription: boolean;
  readonly canonicalUrl: boolean;
  readonly lang: boolean;
}

export interface DomTruncationEvidence {
  /** 文書の項目（`title`・`metaDescription`・`canonicalUrl`・`lang`）ごとの、切り詰めの印。 */
  readonly documentFields: DomDocumentFieldTruncationEvidence;
  /** 件数の上限により記録しなかった、見える見出しの数。 */
  readonly omittedHeadingCount: number;
  readonly omittedImageCount: number;
  readonly omittedFormCount: number;
  /** 件数の上限（`maxUnassociatedFields`）により記録しなかった、form に属さない入力欄の数。 */
  readonly omittedUnassociatedFieldCount: number;
  readonly omittedDuplicateIdCount: number;
}

/**
 * DOM の Evidence。Link（アンカーとその正規化・受け入れ判定の結果、記録しなかったリンクの件数）は、link の Evidence
 * （`LinkDiscoveryEvidence`）の1か所だけに置き、ここには持たない（R'2 の m3）。リンクの件数も、link の Evidence の
 * `links.length + omittedLinkCount` で分かるので、ここには持たない。
 */
export interface DomEvidence {
  readonly pageId: PageId;
  /** 収集した時点の文書のスクロール位置（定義は `ScrollPosition`）。 */
  readonly scrollPosition: ScrollPosition;
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly canonicalUrl: string | null;
  readonly lang: string | null;
  readonly headings: readonly HeadingEvidence[];
  readonly visibleText: VisibleTextEvidence;
  readonly images: readonly ImageDomEvidence[];
  readonly forms: readonly FormDomEvidence[];
  /**
   * `forms` に記録されない入力欄（文書の順。上限は `maxUnassociatedFields`）。どの form にも属さない（`field.form === null`）
   * 入力欄と、open な shadow root の中の入力欄（R'2 の m4。shadow root の中の form は `document.forms` に含まれないので、
   * その form に属する入力欄もここに記録する）。shadow root の中は、その host の位置の順に並べる。closed な shadow root の中は
   * 調べられない。
   */
  readonly unassociatedFields: readonly FormFieldEvidence[];
  /** 重複している `id` の値と件数（最初に現れた順）。 */
  readonly duplicateIds: readonly DuplicateIdEvidence[];
  /** COV-6 の後の記録では、件数（`omitted*Count`）は常に 0。文書の項目ごとの長さの切り詰めの印は今までどおり。 */
  readonly truncation: DomTruncationEvidence;
  /** COV-6: ページの中の読み取りを分けた回数（1 以上。古い版の記録にはない）。 */
  readonly collectedInParts?: number;
  /** AUD-7: 画面の誤りの表示の手がかり（前の版の記録にはない）。 */
  readonly errorDisplay?: ErrorDisplayEvidence;
  /** EV-1: 見えている読み込み中の表示の数（前の版の記録にはない。EV-3 が準備の状態に使う）。 */
  readonly loadingIndicators?: LoadingIndicatorEvidence;
}

/**
 * EV-1: 見えている読み込み中の表示の数。`ariaBusyCount` は `aria-busy="true"` の要素、`progressbarCount` は `role="progressbar"` と `progress` の要素、
 * `indeterminateProgressCount` は、そのうち値のないもの（値のない `progress` と、EV-3 から `aria-valuenow` のない `role="progressbar"`）。どれも、見える
 * （`checkVisibility`）ものだけ。読み方はページの中の部品 `loadingIndicatorsIn` の 1 か所、準備の決め方は `src/core/page-readiness.ts`。
 */
export interface LoadingIndicatorEvidence {
  readonly ariaBusyCount: number;
  readonly progressbarCount: number;
  readonly indeterminateProgressCount: number;
}

/**
 * AUD-7: 誤りの語（`ERROR_DISPLAY_WORDS`）を探す所の閉じた一覧。role=alert・aria-live=assertive・見出し・aria-invalid の欄の近くの文字。
 * 本文のどこかに語があるだけでは、誤りの表示としない。
 */
export const ERROR_DISPLAY_SOURCES = Object.freeze(['ALERT', 'ASSERTIVE_LIVE', 'HEADING', 'INVALID_FIELD'] as const);
export type ErrorDisplaySource = (typeof ERROR_DISPLAY_SOURCES)[number];

/** AUD-7: 誤りの語が見つかった所と、見つかった語（文そのものは残さない）。 */
export interface ErrorDisplayMatchEvidence {
  readonly source: ErrorDisplaySource;
  readonly words: readonly string[];
}

/** AUD-7: 画面の誤りの表示の手がかり（`OBSERVED` の `matches` は語が見つかった所だけ。空なら、誤りの表示はなかった）。 */
export type ErrorDisplayEvidence =
  | { readonly status: 'OBSERVED'; readonly matches: readonly ErrorDisplayMatchEvidence[] }
  | { readonly status: 'FAILED'; readonly errorText: string };

// ---------------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------------

/**
 * 重なりの候補にする主要要素の種類。固定要素は、種類に当てはまらなければ `other` になる。
 * `table` は表、`media` は埋め込み（iframe、video、embed、object、canvas）である（Task 12・13 の設計書 5.1.2、RT12r の N3）。
 */
export const LAYOUT_ELEMENT_KINDS = Object.freeze(
  ['heading', 'paragraph', 'image', 'button', 'link', 'input', 'table', 'media', 'other'] as const,
);
export type LayoutElementKind = (typeof LAYOUT_ELEMENT_KINDS)[number];

/**
 * 幅か高さがこの値以下の箱は、スクリーンリーダー向けに画面から隠す手法（visually hidden: 1 × 1 px と overflow: hidden）とみなす（px）。
 * - layout の collector は、この大きさ以下の子孫を、描画された子孫（`ZeroSizeInteractiveEvidence.hasRenderedDescendant`）に数えない
 *   （Task 12・13 の設計書 5.1.2、RT12r の N5）。
 * - `TEXT_CLIPPING` の Rule は、この大きさ以下の箱を、見切れにしない。
 */
export const VISUALLY_HIDDEN_MAX_DIMENSION_PX = 1;

/**
 * 横方向に最も近い、`overflow-x` が `visible` 以外の祖先の種類（Task 12・13 の設計書 5.1.2）。
 * - `NONE`: そのような祖先がない（ビューポートのスクロールだけで見る）。
 * - `CLIPPED`: `overflow-x` が `hidden`・`clip` の祖先で、切り取られる。
 * - `SCROLLABLE`: `overflow-x` が `auto`・`scroll` の祖先で、スクロールして見られる。
 */
export const HORIZONTAL_CLIP_ANCESTOR_KINDS = Object.freeze(['NONE', 'CLIPPED', 'SCROLLABLE'] as const);
export type HorizontalClipAncestorKind = (typeof HORIZONTAL_CLIP_ANCESTOR_KINDS)[number];

/** 固定要素とみなす `position` の計算値の閉じた一覧。 */
export const FIXED_ELEMENT_POSITIONS = Object.freeze(['fixed', 'sticky'] as const);
export type FixedElementPosition = (typeof FIXED_ELEMENT_POSITIONS)[number];

export interface RectangleEvidence {
  readonly x: number;
  readonly y: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface VisibilityEvidence {
  readonly visible: boolean;
  readonly display: string;
  readonly visibility: string;
  readonly opacity: number;
  readonly hiddenAttribute: boolean;
  readonly ariaHidden: boolean;
  readonly clientRectCount: number;
  /**
   * DEF-205: 要素自身か祖先の `clip`（絶対配置の要素の `rect(...)`）・`clip-path`（`inset(...)`・`circle(...)`・`ellipse(...)`）で、描く面が 0 になるか
   * （視覚的に隠す手法。`clip: rect(0 0 0 0)`・`clip-path: inset(50%)` など）。事実だけで、判定に使うかは Rule が決める（`TEXT_CLIPPING`・
   * `ELEMENT_OUTSIDE_VIEWPORT` が外す）。読めない書き方（`calc()`・`polygon()` など）は偽。`position: fixed` の要素は、祖先の値を引き継がない。
   * 記録するのは layout の collector だけ。記録のない前の版の Evidence は、偽と同じに扱う（今までどおり数える）。
   */
  readonly clippedToZeroArea?: boolean;
}

export interface LayoutDocumentEvidence {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentElementClientWidth: number;
  readonly documentElementClientHeight: number;
  readonly documentElementScrollWidth: number;
  readonly documentElementScrollHeight: number;
  readonly bodyScrollWidth: number;
  readonly bodyScrollHeight: number;
  readonly bodyClientWidth: number;
  readonly bodyClientHeight: number;
  readonly horizontalOverflowPx: number;
  /**
   * ビューポートの横方向の overflow（Task 12・13 の設計書 5.1.2）。html と body から伝わる計算値で、
   * html の `overflow` が両方向とも `visible` なら body の値、そうでなければ html の値を使う（CSS Overflow の仕様）。
   * 値の対応は `horizontalClipAncestor` と同じ（`visible` は `NONE`、`hidden`・`clip` は `CLIPPED`、`auto`・`scroll` は `SCROLLABLE`）。
   * `CLIPPED` なら、利用者に横スクロールは生じない。
   */
  readonly viewportHorizontalClip: HorizontalClipAncestorKind;
}

export interface OutsideViewportEvidence {
  readonly selector: string;
  /** 主要要素の種類（重なりの候補と同じ分類）。当てはまらなければ `other`。 */
  readonly kind: LayoutElementKind;
  readonly rect: RectangleEvidence;
  readonly visibility: VisibilityEvidence;
  readonly position: string;
  readonly zIndex: string;
  readonly overflowX: string;
  readonly overflowY: string;
  /**
   * 横方向に最も近い、`overflow-x` が `visible` 以外の祖先の種類。
   * - 祖先は、親から `maxSelectorDepth` 個までと、body・html に限る。`absolute` の要素は包含ブロックとその祖先だけ、
   *   `fixed` の要素と、`fixed` の祖先より外の祖先は、切り取らないものとして扱う。
   * - body・html は、ビューポートの切り取りとして扱う（`hidden`・`clip` は `CLIPPED`、`auto`・`scroll` は `NONE`）。
   */
  readonly horizontalClipAncestor: HorizontalClipAncestorKind;
  /** この一覧（`boxesOutsideViewport`）の中の、最も近い祖先の番号。一覧に祖先がなければ null。 */
  readonly nearestListedAncestorIndex: number | null;
  readonly outside: {
    readonly left: boolean;
    readonly right: boolean;
    readonly top: boolean;
    readonly bottom: boolean;
  };
  /** selector を上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface ZeroSizeInteractiveEvidence {
  readonly selector: string;
  readonly tagName: string;
  readonly role: string | null;
  readonly rect: RectangleEvidence;
  readonly visibility: VisibilityEvidence;
  readonly position: string;
  readonly zIndex: string;
  readonly overflowX: string;
  readonly overflowY: string;
  /**
   * 子孫に、可視で大きさのある（幅と高さが `VISUALLY_HIDDEN_MAX_DIMENSION_PX` より大きい）要素があるか（float の画像や absolute の子など）。
   * 1 px 以下の子孫（visually hidden のテキストなど）は、数えない。
   * 要素自身が、大きさが0の方向を overflow で切り取る場合は、子孫が見えないので false。
   * COV-6 の後は、子孫の数で打ち切らずにすべてを見る（古い記録では、上限 256 に達したものを false にし、
   * `LayoutTruncationEvidence.renderedDescendantScanLimitReachedCount` に数えた）。
   */
  readonly hasRenderedDescendant: boolean;
  /** selector を上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface ClippedTextEvidence {
  readonly selector: string;
  /**
   * 表示の値（空白を整えた `innerText`）。EV-4: 閉じた選択の部品（`select` で `multiple` でなく `size` が 1 以下）は、選んだ選択肢の文字（全部の選択肢を
   * つなげない。選んだものがなければ空）。
   */
  readonly text: string;
  /** EV-4: 要素の名前（小文字）と `role` の属性（なければ `null`）。この項目より前の記録にはない。 */
  readonly tagName?: string;
  readonly role?: string | null;
  readonly rect: RectangleEvidence;
  readonly visibility: VisibilityEvidence;
  readonly overflowX: string;
  readonly overflowY: string;
  readonly position: string;
  readonly zIndex: string;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
  readonly widthClipped: boolean;
  readonly heightClipped: boolean;
  /**
   * 子孫のテキストが、要素の箱（padding box）で切り取られているか（Task 12・13 の設計書 5.1.2）。
   * テキストの行の矩形（`Range.getClientRects`）は、フォントの内容領域の高さを持ち、行の高さとは一致しないので、わずかなまたぎは数えない。
   * 次のどちらかに当たる行があれば、true とする。
   * 1. 箱と交わる行で、内容がはみ出す方向（`widthClipped` なら左右、`heightClipped` なら上下）の箱の外に出た量が、しきい値を超える。
   *    - 縦方向: その行の高さの4分の1（layout の collector の `LAYOUT_THRESHOLDS.clippedTextLineMinOutsideRatio`）。
   *      フォントの内容領域と行の高さのずれを吸収するためである。
   *    - 横方向: 2 px（`LAYOUT_THRESHOLDS.clippedTextLineMaxIgnoredHorizontalOverflowPx`）。横方向にはこのずれがないので、
   *      文字の少しの張り出しだけを許す（RT12e）。
   *    - 箱の上と下（左と右）に出た量は、合計せず、片側ずつしきい値と比べる（RT12r2 の I1）。
   * 2. `heightClipped` の箱で、箱の上か下に丸ごと出ていて、横方向に箱と重なる。
   * ただし、箱の中に見える（箱と交わる）行が1つもない場合（閉じたアコーディオンなど）は、false とする。
   * 横方向に箱と重ならず、箱の外に丸ごと出ている行（カルーセルの隠れたスライドなど）は、数えない。
   * 見えない子孫のテキスト（`VISIBILITY_CHECK_OPTIONS` の可視判定で見えない要素の中のもの。`visibility:hidden` や `opacity:0`）は、
   * 判定に使わない（RT12r2 の M1）。
   * COV-6 の後は、テキストのノードの数で打ち切らずにすべてを見る（古い記録では、上限 256 に達したものを false にし、
   * `LayoutTruncationEvidence.clippedTextNodeScanLimitReachedCount` に数えた）。
   */
  readonly partiallyClippedText: boolean;
  /** 古い版の記録を読むためだけに残す: selector かテキストを上限で切り詰めたか（LZ-2・LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
  /** AUD-4a: 省略の書き方の計算値（この項目より前に記録した Evidence にはない）。 */
  readonly clippingStyle?: ClippedTextStyleEvidence;
  /**
   * AUD-4a: 行の高さ（px）。`line-height` の計算値が px ならその値、`normal` などは箱の中の最初のテキストの行の矩形の高さ。求められなければ null。
   * この項目より前に記録した Evidence にはない。
   */
  readonly lineHeightPx?: number | null;
  /** AUD-4a: 箱の中に見える行の数（内容の高さ（`clientHeight` から上下の padding を引いた値）÷ `lineHeightPx`。端数を残す）。求められなければ null。 */
  readonly visibleLineCount?: number | null;
  /**
   * AUD-4a: 効いている行数の省略の行の数（`-webkit-line-clamp` は `display` が `-webkit-box`・`-webkit-inline-box`（Chromium の計算値では
   * `flow-root`・`inline-flow-root`）で `-webkit-box-orient` が `vertical` のとき、`line-clamp` は正の整数のとき）。効いていなければ null。
   */
  readonly lineClampCount?: number | null;
  /** AUD-4a: `aria-expanded="false"` で、`aria-controls` がこの要素か祖先の id を指す操作要素があるか（閉じた折りたたみ）。 */
  readonly collapsedByControl?: boolean;
  /**
   * AUD-4a: 意図した省略の形の区分（`INTENDED_CLIPPING_KINDS`。当たらなければ null）。書き方の事実だけで決める区分で、Finding から外すかは
   * Rule（`TEXT_CLIPPING`）が見切れの方向と見える行の数で決める。外したものは、この区分で Evidence に残る（画面には出さない）。
   */
  readonly intendedClipping?: IntendedClippingKind | null;
}

/**
 * AUD-4a: 意図した省略の形の区分（閉じた一覧。当てはめる順に並べる）。
 * - `COLLAPSED`: 閉じた折りたたみの中（`collapsedByControl`）。
 * - `LINE_CLAMP`: 行数の省略が効いている（`lineClampCount` が null でない）。
 * - `INTENDED_ELLIPSIS`: `text-overflow: ellipsis` で、折り返さない（`white-space` が `nowrap`・`pre`）。
 */
export const INTENDED_CLIPPING_KINDS = Object.freeze(['INTENDED_ELLIPSIS', 'LINE_CLAMP', 'COLLAPSED'] as const);
export type IntendedClippingKind = (typeof INTENDED_CLIPPING_KINDS)[number];

/** AUD-4a: 見切れの候補の、省略の書き方の計算値（ブラウザの値のまま。対応しない性質は空の文字列）。 */
export interface ClippedTextStyleEvidence {
  readonly textOverflow: string;
  readonly whiteSpace: string;
  readonly webkitLineClamp: string;
  readonly lineClamp: string;
  readonly display: string;
  readonly webkitBoxOrient: string;
  readonly maxHeight: string;
}

/**
 * AUD-3b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-3b・3c）: hit-test の点の要素と、覆う要素・覆われる要素との関係の閉じた一覧。
 * 覆われる要素の側を先に見る（覆われる要素が覆う要素の子孫でも `COVERED`・`COVERED_DESCENDANT` にする）。
 */
export const OVERLAP_HIT_RELATIONS = Object.freeze(['COVERED', 'COVERED_DESCENDANT', 'OVERLAY', 'OVERLAY_DESCENDANT', 'OTHER'] as const);
export type OverlapHitRelation = (typeof OVERLAP_HIT_RELATIONS)[number];

/**
 * AUD-3b: hit-test の対象の閉じた一覧。`COVERED` は重なりの組（覆われる要素がある）、`BENEATH` は固定要素だけの事実（下にある、祖先でない要素を見る）。
 */
export const OVERLAP_HIT_TARGETS = Object.freeze(['COVERED', 'BENEATH'] as const);
export type OverlapHitTarget = (typeof OVERLAP_HIT_TARGETS)[number];

/** AUD-3b: hit-test の点の要素の 1 つの事実（描画と押下の事実。値はページの中の計算値の文字列のまま）。 */
export interface OverlapHitLayerEvidence {
  readonly selector: string;
  readonly relation: OverlapHitRelation;
  readonly position: string;
  readonly zIndex: string;
  readonly pointerEvents: string;
  /** 要素と祖先の `opacity` の積。 */
  readonly effectiveOpacity: number;
  readonly visibility: string;
  readonly backgroundColor: string;
  readonly hasBackgroundImage: boolean;
  /** 要素そのものが描く面があるか（DEF-204 の `paintsOwnSurfaceOf`）。 */
  readonly paintsOwnSurface: boolean;
}

/** AUD-3b: hit-test の 1 つの点（ビューポートの座標）の事実。 */
export interface OverlapHitPointEvidence {
  readonly x: number;
  readonly y: number;
  /** 最前面の要素の関係（点に要素がなければ `null`）。 */
  readonly topRelation: OverlapHitRelation | null;
  /** 最前面から、対象（覆われる要素か、固定要素の下の要素）の手前までの要素（上から順。覆う要素の祖先は除く）。 */
  readonly layers: readonly OverlapHitLayerEvidence[];
  /** 対象が、その点の要素の並び（`elementsFromPoint`）にあったか。 */
  readonly targetFound: boolean;
  /** 対象の要素の selector（なければ `null`）。 */
  readonly targetSelector: string | null;
}

/**
 * AUD-3b: 固定要素の重なりの hit-test の事実（Collector は区分を決めない。区分は `src/audit/fixed-overlap-classes.ts`）。点は、交わり（固定要素だけなら、要素と
 * ビューポートの交わり）の中心と、内側に寄せた四隅。この項目より前に記録した Evidence にはない。
 */
export interface OverlapHitTestEvidence {
  readonly target: OverlapHitTarget;
  readonly points: readonly OverlapHitPointEvidence[];
  /** 覆う要素そのものの事実（`pointer-events: none` で hit-test に出ないときも、描画の事実を読むため）。`relation` は `OVERLAY`。 */
  readonly overlay: OverlapHitLayerEvidence;
  /** モーダルの印（覆う要素か祖先の、開いたモーダルの `dialog`・`aria-modal="true"`）。 */
  readonly modal: { readonly dialogModal: boolean; readonly ariaModal: boolean };
}

export interface FixedHeadingOverlapEvidence {
  readonly overlaySelector: string;
  readonly headingSelector: string;
  readonly overlayRect: RectangleEvidence;
  readonly headingRect: RectangleEvidence;
  readonly overlayVisibility: VisibilityEvidence;
  readonly headingVisibility: VisibilityEvidence;
  readonly overlayPosition: FixedElementPosition;
  readonly overlayZIndex: string;
  readonly overlayOverflowX: string;
  readonly overlayOverflowY: string;
  readonly headingPosition: string;
  readonly headingZIndex: string;
  readonly headingOverflowX: string;
  readonly headingOverflowY: string;
  readonly intersection: RectangleEvidence & { readonly area: number };
  /** どちらかの selector を上限で切り詰めたか。 */
  readonly truncated: boolean;
  /** AUD-3b: hit-test の事実（覆う要素は `overlaySelector`、覆われる要素は見出し）。この項目より前の Evidence にはない。 */
  readonly hitTest?: OverlapHitTestEvidence;
  /** EV-1: 覆われる要素（見出し）のいちばん近い、縦にスクロールできる祖先（なければ、前の版の記録と同じく、ない）。 */
  readonly coveredScrollContainer?: ScrollContainerEvidence;
}

/**
 * EV-1: 要素のいちばん近い、縦にスクロールできる祖先（文書の根と body を除く。`overflow-y` が `auto`・`scroll`・`overlay` で、内容が箱より高い）。
 * 固定の枠の覆いの「スクロールすれば見える」の判定が、文書の量に加えて使う。
 */
export interface ScrollContainerEvidence {
  readonly selector: string;
  /** 祖先の矩形（ビューポートの座標）。 */
  readonly rect: RectangleEvidence;
  readonly scrollTop: number;
  /** 縦に動かせる量の全体（`scrollHeight - clientHeight`）。 */
  readonly scrollRangeY: number;
}

/**
 * EV-1: 重なりの組の、行ごとの矩形（`getClientRects`）の重なりの事実。`area` は行の矩形どうしの交わりの面積の和。`pointCount` は、ビューポートの中の交わりの
 * 中心の点の数、`bothHitPointCount` は、そのうち両方の要素（か子孫）が hit-test に出た点の数。
 */
export interface LineOverlapEvidence {
  readonly area: number;
  readonly pointCount: number;
  readonly bothHitPointCount: number;
}

/** 重なりの候補の片方の要素の事実。 */
export interface LayoutElementEvidence {
  readonly selector: string;
  readonly kind: LayoutElementKind;
  readonly rect: RectangleEvidence;
  /** 境界の矩形の面積（`rect.width * rect.height`）。 */
  readonly area: number;
  readonly visibility: VisibilityEvidence;
  readonly position: string;
  readonly zIndex: string;
  readonly overflowX: string;
  readonly overflowY: string;
  /** 祖先（body を含む）に `position: fixed | sticky` の要素があるか。 */
  readonly fixedOrStickyAncestor: boolean;
}

/**
 * 可視で大きさのある主要要素（見出し、段落、画像、ボタン、リンク、入力欄、表、埋め込み、固定要素）どうしの重なりの候補。
 * 同じ要素の組と、一方が他方を含む組は除く。固定要素を含む組は、どちらもビューポートと交わるものに限る。
 * Finding にするかどうかは Rule が決める。
 */
export interface ElementOverlapEvidence {
  /** 文書の順で先にある要素。 */
  readonly first: LayoutElementEvidence;
  readonly second: LayoutElementEvidence;
  readonly intersection: RectangleEvidence & { readonly area: number };
  /** どちらかの selector を上限で切り詰めたか。 */
  readonly truncated: boolean;
  /** AUD-3b: 片方だけが固定要素の組の hit-test の事実（覆う要素は固定要素の側）。ほかの組と、この項目より前の Evidence にはない。 */
  readonly hitTest?: OverlapHitTestEvidence;
  /** EV-1: 片方だけが固定要素の組の、覆われる側のいちばん近い縦のスクロールの祖先（なければ、ない）。 */
  readonly coveredScrollContainer?: ScrollContainerEvidence;
  /** EV-1: どちらも固定要素でない組の、行ごとの矩形の重なり（前の版の記録にはない）。 */
  readonly lineOverlap?: LineOverlapEvidence;
}

/** 可視で大きさのある固定要素（`position: fixed | sticky`）と、ビューポートに対する面積の比。 */
export interface FixedElementEvidence extends LayoutElementEvidence {
  readonly position: FixedElementPosition;
  /** ビューポートと交わる部分の面積。 */
  readonly viewportIntersectionArea: number;
  /** ビューポートの面積（`viewportWidth * viewportHeight`）。 */
  readonly viewportArea: number;
  /** `viewportIntersectionArea / viewportArea`。 */
  readonly viewportAreaRatio: number;
  /** selector を上限で切り詰めたか。 */
  readonly truncated: boolean;
  /**
   * DEF-204（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.5）: 要素そのものが描く面があるか（背景の色が透明でない、背景の画像、
   * 枠線、輪郭、影、背後のぼかし、自分の文字、疑似要素の内容、画像・埋め込み・入力の欄のどれか。判定は `paintsOwnSurfaceOf`）。
   * この項目より前に記録した Evidence にはない（ないときは、描く面があるものとして扱う）。
   */
  readonly paintsOwnSurface?: boolean;
  /** DEF-204: `pointer-events` の計算値（この項目より前に記録した Evidence にはない）。 */
  readonly pointerEvents?: string;
  /** AUD-3b: 要素の面の上の点の hit-test の事実（対象は `BENEATH`）。この項目より前に記録した Evidence にはない。 */
  readonly hitTest?: OverlapHitTestEvidence;
}

/**
 * 上限により記録しなかった候補の件数と、走査を止めた印。
 * COV-6 の後の記録では、候補を件数の上限で打ち切らないので、`omitted*Count` は常に 0（古い記録を読むためだけに残す）。
 * 収集が期限で止まった場合（`PARTIAL`）は、止まるまでに見つけた分だけを数える。
 * 古い記録で `overlapComparisonLimitReached` が true の場合、重なりの件数（`omittedFixedHeadingOverlapCount`、
 * `omittedElementOverlapCount`）は、比べた組の中で見つけた分だけを数える。COV-6 の後は、走査の印も常に偽と 0。
 */
export interface LayoutTruncationEvidence {
  readonly omittedOutsideViewportCount: number;
  readonly omittedZeroSizeInteractiveCount: number;
  readonly omittedClippedTextCount: number;
  readonly omittedFixedHeadingOverlapCount: number;
  readonly omittedElementOverlapCount: number;
  readonly omittedFixedElementCount: number;
  /** 重なりの走査のどれかが、比べる組の上限（200,000）に達して止まったか。COV-6 の後は上限を撤廃したので常に偽（古い記録を読むために残す）。 */
  readonly overlapComparisonLimitReached: boolean;
  /** 記録した見切れの候補のうち、テキストのノードの走査が上限に達し、`partiallyClippedText` を判定できなかったものの件数。 */
  readonly clippedTextNodeScanLimitReachedCount: number;
  /** 記録した大きさ0の操作要素のうち、子孫の走査が上限に達し、`hasRenderedDescendant` を判定できなかったものの件数。 */
  readonly renderedDescendantScanLimitReachedCount: number;
}

export interface LayoutEvidence {
  /** 収集した時点の文書のスクロール位置（定義は `ScrollPosition`）。 */
  readonly scrollPosition: ScrollPosition;
  readonly document: LayoutDocumentEvidence;
  /** 横にはみ出す要素の一覧（REC-1 の後。前の記録は、縦だけにはみ出す要素も持つ）。 */
  readonly boxesOutsideViewport: readonly OutsideViewportEvidence[];
  readonly zeroSizeInteractive: readonly ZeroSizeInteractiveEvidence[];
  readonly clippedText: readonly ClippedTextEvidence[];
  readonly fixedHeadingOverlaps: readonly FixedHeadingOverlapEvidence[];
  readonly elementOverlaps: readonly ElementOverlapEvidence[];
  readonly fixedElements: readonly FixedElementEvidence[];
  readonly truncation: LayoutTruncationEvidence;
  /**
   * COV-6: ページの中の読み取りを分けた回数（1 以上。古い版の記録にはない）。候補の一覧（はみ出し・大きさ0の操作要素・見切れ・固定要素と見出しの重なり・
   * 主要要素どうしの重なり・固定要素）は、件数の上限で打ち切らずに、`LAYOUT_COLLECTION_PART_SIZE` 件ずつ分けて全部を集める。
   */
  readonly collectedInParts?: number;
}

/**
 * layout の収集が完全でない理由。
 * - `DEADLINE_EXCEEDED`: 期限を過ぎて、収集が途中で止まった。
 * - `LAYOUT_COMPARISON_LIMIT_REACHED`: 重なりの走査が、比べる組の上限に達して止まった（`truncation.overlapComparisonLimitReached`）。
 *   両方に当たる場合は `DEADLINE_EXCEEDED` にする。
 */
export const LAYOUT_INCOMPLETE_REASONS = Object.freeze([
  'DEADLINE_EXCEEDED',
  'LAYOUT_COMPARISON_LIMIT_REACHED',
] as const satisfies readonly IncompleteReasonCode[]);
export type LayoutIncompleteReason = (typeof LAYOUT_INCOMPLETE_REASONS)[number];

/**
 * layout の収集の結果。期限を過ぎた場合と、重なりの走査が比べる組の上限に達した場合は、`PARTIAL` と理由を返す。
 * ブラウザ内の走査が期限や上限で止まった場合は、それまでに集めた事実を `layout` に持つ。
 * ブラウザから結果が返らなかった場合と、収集を始める前に期限を過ぎていた場合は、`layout` が null になる。
 */
export type LayoutCollectionResult =
  | Readonly<{ status: 'COMPLETE'; layout: LayoutEvidence }>
  | Readonly<{ status: 'PARTIAL'; reason: LayoutIncompleteReason; layout: LayoutEvidence | null }>;

/** 幅の収集が失敗した段階。`NOT_STARTED` は、期限を過ぎていたため、セッションを作らなかったことを表す。 */
export const STRESS_LAYOUT_FAILURE_STAGES = Object.freeze(['NOT_STARTED', 'NAVIGATION', 'COLLECTION'] as const);
export type StressLayoutFailureStage = (typeof STRESS_LAYOUT_FAILURE_STAGES)[number];

/** 幅の収集が失敗した理由。遷移（`page.goto`）の失敗は `NAVIGATION_FAILED`。 */
export const STRESS_LAYOUT_FAILURE_REASONS = Object.freeze([
  ...PARTIAL_FAILURE_REASONS,
  'NAVIGATION_FAILED',
] as const satisfies readonly IncompleteReasonCode[]);
export type StressLayoutFailureReason = (typeof STRESS_LAYOUT_FAILURE_REASONS)[number];

/**
 * AUD-2a の限界の直し（AUD-2b・2d の指示書の 3）: 幅の走査の 1 つの幅の結果。`capture` は、その幅を集めた状態と時刻（段は `stress-layout`、状態 ID は
 * Desktop の読み込みのもの、時刻はその幅の範囲）。前の Run の記録にはない。
 */
export type StressLayoutEvidence = StressLayoutResultEvidence & Readonly<{ capture?: EvidenceCapture }>;

/** 幅の走査の 1 つの幅の結果（集めた状態と時刻を除いた形）。 */
export type StressLayoutResultEvidence =
  | Readonly<{ width: number; height: number; status: 'COMPLETE'; layout: LayoutEvidence }>
  | Readonly<{
    width: number;
    height: number;
    status: 'PARTIAL';
    reason: LayoutIncompleteReason;
    layout: LayoutEvidence | null;
  }>
  | Readonly<{
    width: number;
    height: number;
    status: 'FAILED';
    stage: StressLayoutFailureStage;
    reason: StressLayoutFailureReason;
    /** 失敗の内容（上限付き）。期限切れで理由だけが分かっている場合は null。 */
    message: string | null;
    layout: null;
  }>;

/**
 * layout の Evidence の payload。1つのビューポートの layout の収集の結果（`primary`）と、
 * レスポンシブの幅ごとの結果（`stressSweep`。そのビューポートで幅の走査をしなかった場合は `null`）。
 */
export interface LayoutEvidencePayload {
  readonly primary: LayoutCollectionResult;
  readonly stressSweep: readonly StressLayoutEvidence[] | null;
  /**
   * DEF-210（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.3）: 通知の枠が Run の中で初めて出たビューポートで、枠を閉じる（隠す）前に測った
   * layout。覆いの規則（`FIXED_ELEMENT_OCCLUSION`）だけが、1 回だけ評価する。初めてでない枠だけのとき、枠がないときと、この項目より前の Evidence にはない。
   */
  readonly beforeNotificationDismissal?: LayoutCollectionResult;
  /** DEF-210（設計書 3.6）: 主のビューポートの読み込みで見つけた通知の枠と、閉じた・隠した事実。この項目より前の Evidence にはない。 */
  readonly notificationOverlay?: NotificationOverlayEvidence;
  /** DEF-210: 幅の走査の各幅で見つけた通知の枠と、閉じた・隠した事実（幅の順）。走査をしなかったときと、この項目より前の Evidence にはない。 */
  readonly stressNotificationOverlays?: readonly StressNotificationOverlayEvidence[];
}

/**
 * 通知の枠の見分けの状態（設計書 3.1。見分けは `src/interaction/notification-overlay.ts` の `classifyNotificationFrames`）。
 * - `DISMISSIBLE`: 閉じるボタンがあり、描く面がビューポートの閾値以下（閉じる対象）。
 * - `TOO_LARGE`: 閉じるボタンはあり、描く面がビューポートの閾値を超える（全面のモーダル）。NO-2 fix round 1（設計書 3.1 の 4 の改訂）: ほかの枠と同じく閉じるボタンを押す。
 * - `CLOSE_BUTTON_DISABLED`: 閉じるボタンが、どれも押せない。
 * - `NO_CLOSE_BUTTON`: 閉じるボタンがない。
 */
export const NOTIFICATION_FRAME_STATUSES = Object.freeze(['DISMISSIBLE', 'TOO_LARGE', 'CLOSE_BUTTON_DISABLED', 'NO_CLOSE_BUTTON'] as const);
export type NotificationFrameStatus = (typeof NOTIFICATION_FRAME_STATUSES)[number];

/**
 * 通知の枠を CSS で隠した理由（設計書 3.4。閉じられない枠）。
 * - `NOT_DISMISSED`: 閉じるボタンを押しても、待つ時間の後に残っていた。
 * - `CLOSE_BUTTON_DISABLED`: 閉じるボタンが押せない。
 * - `NO_CLOSE_BUTTON`: 閉じるボタンがなく、描く面がビューポートの閾値の面積を超えて覆う。
 */
export const NOTIFICATION_FRAME_HIDDEN_REASONS = Object.freeze(['NOT_DISMISSED', 'CLOSE_BUTTON_DISABLED', 'NO_CLOSE_BUTTON'] as const);
export type NotificationFrameHiddenReason = (typeof NOTIFICATION_FRAME_HIDDEN_REASONS)[number];

/** 見つけた通知の枠 1 つの事実（識別は digest だけ。値・URL・画面の path を持たない）。 */
export interface NotificationFrameEvidence {
  readonly digest: string;
  readonly status: NotificationFrameStatus;
  /** 閉じるボタンを押したか。 */
  readonly pressed: boolean;
  /** 押した後、待つ時間までに閉じるボタンが見えなくなったか。 */
  readonly dismissed: boolean;
  /** CSS で隠したか。隠そうとして隠せなかったときは false で、`hiddenReason` は残す。 */
  readonly hidden: boolean;
  /** 閉じられない枠の理由（閉じられない枠でなければ null）。 */
  readonly hiddenReason: NotificationFrameHiddenReason | null;
  /** この Run（このビューポートの種類）で初めて見た枠か（設計書 3.3）。 */
  readonly firstSeen: boolean;
}

/** 通知の枠を読めたかの状態。 */
export const NOTIFICATION_OVERLAY_READ_STATUSES = Object.freeze(['READ', 'FAILED'] as const);
export type NotificationOverlayReadStatus = (typeof NOTIFICATION_OVERLAY_READ_STATUSES)[number];

/** 1 回の読み込みで見つけた通知の枠と、閉じた・隠した事実（設計書 3.6）。 */
export interface NotificationOverlayEvidence {
  /** 枠を読めたか（読めなかったときは、押さず、隠さない）。 */
  readonly readStatus: NotificationOverlayReadStatus;
  readonly frames: readonly NotificationFrameEvidence[];
  /** 押した閉じるボタンの数（上限は `NOTIFICATION_DISMISSAL_LIMITS.maxPressesPerPage`）。 */
  readonly pressCount: number;
  /** 押したことで画面（main frame）が移ったか（移った後は、ほかの枠を押さず、隠さない）。 */
  readonly navigated: boolean;
  /** 読み取りを上限で止めたか。 */
  readonly truncated: boolean;
}

/** 幅の走査の 1 つの幅の、通知の枠の事実。 */
export interface StressNotificationOverlayEvidence {
  readonly width: number;
  readonly overlay: NotificationOverlayEvidence;
}

// ---------------------------------------------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------------------------------------------

export interface CssColorEvidence {
  readonly css: string;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export const COLOR_UNAVAILABLE_REASONS = Object.freeze([
  'BACKGROUND_IMAGE',
  'TRANSPARENT_CHAIN',
  'INVALID_COLOR',
  'PARTIAL_OPACITY',
] as const);
export type ColorUnavailableReason = (typeof COLOR_UNAVAILABLE_REASONS)[number];

export type BackgroundColorEvidence =
  | { readonly status: 'OBSERVED'; readonly color: CssColorEvidence }
  | { readonly status: 'UNAVAILABLE'; readonly reason: ColorUnavailableReason };

export type ContrastPairEvidence =
  | {
      readonly status: 'OBSERVED';
      readonly ratio: number;
      readonly effectiveForeground: CssColorEvidence;
    }
  | { readonly status: 'UNAVAILABLE'; readonly reason: ColorUnavailableReason };

export type ForegroundColorEvidence =
  | { readonly status: 'OBSERVED'; readonly color: CssColorEvidence }
  | { readonly status: 'UNAVAILABLE'; readonly reason: 'INVALID_COLOR'; readonly serialized: string };

export interface TextColorSampleEvidence {
  readonly selector: string;
  readonly text: string;
  readonly foreground: ForegroundColorEvidence;
  readonly background: BackgroundColorEvidence;
  readonly contrast: ContrastPairEvidence;
  readonly boundingArea: number;
  readonly visibleArea: number;
  /** 古い版の記録を読むためだけに残す: `text` か `selector` を長さの上限で切り詰めたか（LZ-3b の後の記録では常に false）。 */
  readonly truncated: boolean;
}

export interface ForegroundDistributionEvidence {
  readonly color: CssColorEvidence;
  readonly area: number;
  readonly proportion: number;
  readonly sampleCount: number;
}

export interface ColorEvidence {
  /** 収集した時点の文書のスクロール位置（定義は `ScrollPosition`）。 */
  readonly scrollPosition: ScrollPosition;
  /**
   * 文書全体（ビューポートの外を含む）の可視要素から取った標本。`visibleArea` は、文書のスクロール領域と、
   * overflow で切り取る祖先の範囲に収まる面積。固定配置（`position: fixed`）の要素と、その子孫は、ビューポートの範囲に収まる面積。
   * 可視要素は `checkVisibility(VISIBILITY_CHECK_OPTIONS)` が真の要素。`aria-hidden` は判定に使わない。
   */
  readonly textSamples: readonly TextColorSampleEvidence[];
  /** 古い版の記録を読むためだけに残す: 標本の件数の上限に達し、記録しなかった標本があったか（COV-6 の後の記録では常に false）。 */
  readonly textSamplesTruncated: boolean;
  readonly foregroundDistribution: readonly ForegroundDistributionEvidence[];
  /** 古い版の記録を読むためだけに残す: 件数の上限により `foregroundDistribution` に記録しなかった色の数（COV-6 の後の記録では常に 0）。 */
  readonly omittedDistributionEntryCount: number;
  readonly observedArea: number;
  /** COV-6: ページの中の読み取りを分けた回数（1 以上。古い版の記録にはない）。 */
  readonly collectedInParts?: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------------------------------------------

export type WebVitalStatus = ObservationStatus;

/** 値を観測していない Web Vital の状態の閉じた一覧（`OBSERVATION_STATUSES` から `OBSERVED` を除いたもの）。 */
export type UnobservedWebVitalStatus = Exclude<WebVitalStatus, 'OBSERVED'>;
export const UNOBSERVED_WEB_VITAL_STATUSES: readonly UnobservedWebVitalStatus[] = Object.freeze(
  OBSERVATION_STATUSES.filter((status): status is UnobservedWebVitalStatus => status !== 'OBSERVED'),
);

/** web-vitals が報告する `navigationType` の閉じた一覧。 */
export const WEB_VITAL_NAVIGATION_TYPES = Object.freeze([
  'navigate',
  'reload',
  'back-forward',
  'back-forward-cache',
  'prerender',
  'restore',
  'soft-navigation',
] as const);
export type WebVitalNavigationType = (typeof WEB_VITAL_NAVIGATION_TYPES)[number];

/** INP の attribution の `interactionType` の閉じた一覧。 */
export const INP_INTERACTION_TYPES = Object.freeze(['pointer', 'keyboard'] as const);
export type InpInteractionType = (typeof INP_INTERACTION_TYPES)[number];

export interface CLSAttributionEvidence {
  readonly largestShiftTarget?: string;
  readonly largestShiftTime?: number;
  readonly largestShiftValue?: number;
  readonly loadState?: string;
}

export interface LCPAttributionEvidence {
  readonly target?: string;
  readonly url?: string;
  readonly timeToFirstByte?: number;
  readonly resourceLoadDelay?: number;
  readonly resourceLoadDuration?: number;
  readonly elementRenderDelay?: number;
}

export interface INPAttributionEvidence {
  readonly interactionTarget?: string;
  readonly interactionTime?: number;
  readonly interactionType?: InpInteractionType;
  readonly nextPaintTime?: number;
  readonly inputDelay?: number;
  readonly processingDuration?: number;
  readonly presentationDelay?: number;
  readonly loadState?: string;
}

// web-vitals の `rating` は保存しない。しきい値に照らした評価は Rule Catalog が行う。
export type WebVitalEvidence<TAttribution> = Readonly<{
  readonly status: 'OBSERVED';
  readonly value: number;
  readonly id: string | null;
  readonly navigationType: WebVitalNavigationType | null;
  readonly attribution: Readonly<TAttribution> | null;
}> | Readonly<{
  readonly status: UnobservedWebVitalStatus;
  readonly value: null;
  readonly id: null;
  readonly navigationType: null;
  readonly attribution: null;
}>;

export interface WebVitalsEvidence {
  readonly CLS: WebVitalEvidence<CLSAttributionEvidence>;
  readonly FCP: WebVitalEvidence<never>;
  readonly INP: WebVitalEvidence<INPAttributionEvidence>;
  readonly LCP: WebVitalEvidence<LCPAttributionEvidence>;
  readonly TTFB: WebVitalEvidence<never>;
}

/** Server-Timing を読んだ Timing の種類の閉じた一覧。 */
export const SERVER_TIMING_SOURCES = Object.freeze(['NAVIGATION', 'RESOURCE'] as const);
export type ServerTimingSource = (typeof SERVER_TIMING_SOURCES)[number];

export interface ServerTimingEvidence {
  readonly source: ServerTimingSource;
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly duration: number;
}

export interface NavigationTimingEvidence {
  readonly url: string;
  readonly navigationType: string;
  readonly startTime: number;
  readonly duration: number;
  readonly responseStart: number;
  readonly responseEnd: number;
  readonly domContentLoadedEventStart: number;
  readonly domContentLoadedEventEnd: number;
  readonly loadEventStart: number;
  readonly loadEventEnd: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
  readonly serverTiming: readonly Readonly<ServerTimingEvidence>[];
}

export const RESOURCE_CATEGORIES = Object.freeze(['script', 'stylesheet', 'image', 'fetch-xhr'] as const);
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];
export const RESOURCE_CATEGORY_BASES = Object.freeze(['NETWORK_EVIDENCE', 'INITIATOR_TYPE', 'UNKNOWN'] as const);
export type ResourceCategoryBasis = (typeof RESOURCE_CATEGORY_BASES)[number];

/**
 * 転送量を観測できたか。`CROSS_ORIGIN_RESTRICTED` は、文書と別Originの資源（または文書のOriginが分からない資源）で、
 * ブラウザが転送量と本文の大きさをすべて0と報告したもの（Timing-Allow-Origin がない場合など）。大きさは不明として扱う。
 */
export type ResourceSizeStatus = 'OBSERVED' | 'CROSS_ORIGIN_RESTRICTED';

export type ResourceSizeEvidence = Readonly<{
  readonly sizeStatus: 'OBSERVED';
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
}> | Readonly<{
  readonly sizeStatus: 'CROSS_ORIGIN_RESTRICTED';
  readonly transferSize: null;
  readonly encodedBodySize: null;
  readonly decodedBodySize: null;
}>;

export interface ResourceTimingBase {
  readonly url: string;
  readonly initiatorType: string;
  readonly startTime: number;
  readonly duration: number;
  readonly responseStart: number;
  readonly responseEnd: number;
  readonly requestId: string | null;
  readonly networkResourceType: string | null;
  readonly category: ResourceCategory | null;
  readonly categoryBasis: ResourceCategoryBasis;
  readonly serverTiming: readonly Readonly<ServerTimingEvidence>[];
}

export type ResourceTimingEvidence = Readonly<ResourceTimingBase> & ResourceSizeEvidence;

/**
 * カテゴリごとの資源の集計。`count` は資源の件数、`sizeUnknownCount` はそのうち大きさが不明な件数。
 * 大きさの合計は、大きさを観測できた `count - sizeUnknownCount` 件だけの合計で、不明な資源を0として含めない。
 */
export interface ResourceSummaryEvidence {
  readonly count: number;
  readonly sizeUnknownCount: number;
  readonly transferSize: number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
}

export interface ResourceSummariesEvidence {
  readonly script: Readonly<ResourceSummaryEvidence>;
  readonly stylesheet: Readonly<ResourceSummaryEvidence>;
  readonly image: Readonly<ResourceSummaryEvidence>;
  readonly 'fetch-xhr': Readonly<ResourceSummaryEvidence>;
}

/** テレメトリのヘッダを読んだ向き（リクエストか response か）の閉じた一覧。 */
export const TELEMETRY_HEADER_DIRECTIONS = Object.freeze(['REQUEST', 'RESPONSE'] as const);
export type TelemetryHeaderDirection = (typeof TELEMETRY_HEADER_DIRECTIONS)[number];

export type TelemetryHeaderEvidence = Readonly<{
  readonly direction: TelemetryHeaderDirection;
  readonly requestId: string;
  readonly url: string;
  readonly status: 'OBSERVED';
  readonly values: Readonly<Record<string, string>>;
}> | Readonly<{
  readonly direction: TelemetryHeaderDirection;
  readonly requestId: string;
  readonly url: string;
  readonly status: 'FAILED';
  readonly errorText: string;
}>;

/** テレメトリの候補とみなした根拠の閉じた一覧。 */
export const TELEMETRY_MATCHING_BASES = Object.freeze(['TRACE_OR_CORRELATION_HEADER', 'GENERIC_URL_HINT'] as const);
export type TelemetryMatchingBasis = (typeof TELEMETRY_MATCHING_BASES)[number];

export interface TelemetryCandidateEvidence {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly matchingBasis: readonly TelemetryMatchingBasis[];
  readonly matchedHeaderNames: readonly string[];
  readonly matchedHints: readonly string[];
}

/** Resource Timing をどこまで観測できたか。 */
export interface ResourceCoverageEvidence {
  /** 設定した Resource Timing のバッファの大きさ。ブラウザが設定の API を持たない場合は `null`。 */
  readonly bufferSize: number | null;
  /** バッファが満杯になった（`resourcetimingbufferfull`）か。満杯の後の資源は、件数も分からないまま記録されない。 */
  readonly bufferFull: boolean;
  /** `resources` に記録した件数。 */
  readonly retainedEntryCount: number;
  /** バッファにはあったが、件数の上限のため記録しなかった件数。 */
  readonly omittedEntryCount: number;
}

/** 上限により切り捨てたものの件数と印。 */
export interface PerformanceTruncationEvidence {
  /** 1件あたりと全体の上限のため記録しなかった Server-Timing の件数。ブラウザの値を観測できなかった場合は `null`。 */
  readonly omittedServerTimingCount: number | null;
  readonly omittedTelemetryHeaderCount: number;
  readonly omittedTelemetryCandidateCount: number;
  /** 照合のために読んだ Network Evidence のうち、上限のため読まなかったリクエストと response の件数。 */
  readonly omittedNetworkRequestCount: number;
  readonly omittedNetworkResponseCount: number;
  /** 記録した文字列のどれかを上限で切り詰めたか。 */
  readonly textTruncated: boolean;
}

export interface PerformanceEvidenceFacts {
  readonly webVitals: Readonly<WebVitalsEvidence> | null;
  readonly navigationTiming: Readonly<NavigationTimingEvidence> | null;
  readonly resources: readonly Readonly<ResourceTimingEvidence>[];
  /** 資源を観測できなかった場合は `null`（0件の集計にしない）。 */
  readonly resourceSummaries: Readonly<ResourceSummariesEvidence> | null;
  /** 資源を観測できなかった場合は `null`。 */
  readonly resourceCoverage: Readonly<ResourceCoverageEvidence> | null;
  readonly serverTiming: readonly Readonly<ServerTimingEvidence>[];
  readonly telemetryHeaders: readonly TelemetryHeaderEvidence[];
  readonly telemetryCandidates: readonly Readonly<TelemetryCandidateEvidence>[];
  /** Network Evidence の照合の前に期限を過ぎた場合は `null`。 */
  readonly truncation: Readonly<PerformanceTruncationEvidence> | null;
  /**
   * AUD-6c: 観測の時間（文書の読み込みの始まりから、値を読んだ時までの ms。ページの中の `performance.now()`）。読めなかったときは `null`。前の版の記録にはない。
   */
  readonly observedForMs?: number | null;
  /** AUD-6c: 測る前に BeakSight がページにした操作（Page Auditor が渡す。前の版の記録と、渡されない読み取りにはない）。 */
  readonly operationsBeforeMeasurement?: PerformanceOperationsEvidence;
  /**
   * EV-1: scroll の段の前に読んだ LCP（Page Auditor が渡す。`POOR_LCP` は、あればこの値で判定する。スクロールで後から描かれた塊を LCP に数えないため）。
   * 前の版の記録と、scroll の段の前に読まなかった読み取りにはない。
   */
  readonly lcpBeforeScroll?: Readonly<WebVitalEvidence<LCPAttributionEvidence>>;
}

/** AUD-6c: 性能の値を測る前に、BeakSight がページにした操作。 */
export interface PerformanceOperationsEvidence {
  /** 縦に動かして確かめた（scroll の段を行った）か。 */
  readonly scrolled: boolean;
  /** 通知の枠の閉じるボタンを押したか。 */
  readonly notificationFramePressed: boolean;
}

/**
 * performance の収集が途中で止まった理由の閉じた一覧。L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 期限を受けないときは、
 * 進みの見張りが読み取りを終えた理由（`STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`）になる。
 */
export const PERFORMANCE_INCOMPLETE_REASONS = Object.freeze([
  'DEADLINE_EXCEEDED',
  'EVALUATION_FAILED',
  'INVALID_BROWSER_DATA',
  'RESOURCE_LIMIT_REACHED',
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
] as const satisfies readonly IncompleteReasonCode[]);
export type PerformanceIncompleteReason = (typeof PERFORMANCE_INCOMPLETE_REASONS)[number];

export type PerformanceEvidence = Readonly<PerformanceEvidenceFacts & {
  readonly status: 'COMPLETE';
  readonly reason: 'COLLECTED';
}> | Readonly<PerformanceEvidenceFacts & {
  readonly status: 'PARTIAL';
  readonly reason: PerformanceIncompleteReason;
}>;

// ---------------------------------------------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------------------------------------------

/** axe の impact の閉じた一覧。axe が impact を返さない場合は `null`（配列には含めない）。 */
export const ACCESSIBILITY_IMPACTS = Object.freeze(['minor', 'moderate', 'serious', 'critical'] as const);
export type AccessibilityImpact = (typeof ACCESSIBILITY_IMPACTS)[number] | null;

/**
 * accessibility の収集が途中で止まった理由の閉じた一覧。L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 期限を受けないときは、
 * 進みの見張りが読み取りを終えた理由（`STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`）になる。
 */
export const ACCESSIBILITY_INCOMPLETE_REASONS = Object.freeze([
  'DEADLINE_EXCEEDED',
  'EVALUATION_FAILED',
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
] as const satisfies readonly IncompleteReasonCode[]);
export type AccessibilityIncompleteReason = (typeof ACCESSIBILITY_INCOMPLETE_REASONS)[number];
export type AccessibilityTargetSelector = string | readonly string[];

/** AUD-8: axe の確かめが入っていた一覧（`any`・`all`・`none`）の閉じた一覧。 */
export const ACCESSIBILITY_CHECK_GROUPS = Object.freeze(['any', 'all', 'none'] as const);
export type AccessibilityCheckGroup = (typeof ACCESSIBILITY_CHECK_GROUPS)[number];

/** AUD-8: 確かめを axe が報告した結果（違反の要素の確かめは `FAILED`、要確認の要素の確かめは `UNDETERMINED`）の閉じた一覧。 */
export const ACCESSIBILITY_CHECK_RESULTS = Object.freeze(['FAILED', 'UNDETERMINED'] as const);
export type AccessibilityCheckResult = (typeof ACCESSIBILITY_CHECK_RESULTS)[number];

/** AUD-8: 確かめの data の 1 つの値（許可した欄だけ。文字列・数・真偽・null だけを残す）。 */
export type AccessibilityCheckDataValue = string | number | boolean | null;

/** AUD-8: axe の対象ごとの確かめ 1 つ（`data` は、Rule ごとの許可の一覧 `ACCESSIBILITY_CHECK_DATA_ALLOWLIST` の欄だけ）。 */
export interface AccessibilityCheckEvidence {
  readonly id: string;
  readonly group: AccessibilityCheckGroup;
  readonly result: AccessibilityCheckResult;
  /** 測れない理由など、axe の文言の鍵（例: `bgImage`・`bgGradient`・`bgOverlap`・`fgAlpha`・`pseudoContent`・`complexTextShadows`）。なければ `null`。 */
  readonly messageKey: string | null;
  readonly data: Readonly<Record<string, AccessibilityCheckDataValue>>;
}

/** AUD-8: 1 つの値の長さで切った欄（`field` は要素の Evidence の中の JSON Pointer。例: `/failureSummary`、`/targetSelectors/0`、`/checks/0/data/fgColor`）。 */
export interface AccessibilityValueTruncationEvidence {
  readonly field: string;
  readonly originalLength: number;
  readonly keptLength: number;
}

/** AUD-8（4-3）: 無効の手がかりがどこにあったか（要素そのもの・祖先）の閉じた一覧。手がかりがなければ、欄は `null`。 */
export const ACCESSIBILITY_DISABLED_PLACES = Object.freeze(['SELF', 'ANCESTOR'] as const);
export type AccessibilityDisabledPlace = (typeof ACCESSIBILITY_DISABLED_PLACES)[number];

/** AUD-8（4-3）: 無効の事実を読まなかった理由の閉じた一覧（要素が見つからなかった・読めなかった）。 */
export const ACCESSIBILITY_DISABLED_FACTS_UNREAD_STATUSES = Object.freeze(['NOT_FOUND', 'NOT_READ'] as const);
export type AccessibilityDisabledFactsUnreadStatus = (typeof ACCESSIBILITY_DISABLED_FACTS_UNREAD_STATUSES)[number];

/**
 * AUD-8（4-3）: 色差の対象の、無効の事実。`READ` のほかは、要素が見つからなかった（`NOT_FOUND`）・読めなかった（`NOT_READ`）。
 * - `disabledForAssistiveTech`: 支援技術に無効と伝わる（`:disabled` に当たる、`aria-disabled="true"`（祖先を含む）、`inert`（祖先を含む））。主の件数から外す。
 * - `disabledStateNotExposed`: 見た目だけ無効（`pointer-events: none` か `cursor: not-allowed`）なのに、支援技術に無効と伝わらない。Finding は残す。
 * - `axDisabled`: アクセシビリティの木の disabled（AUD-4b: CDP の Accessibility で読む。読めなければ `null`）。真なら、支援技術に無効と伝わる。
 */
export type AccessibilityDisabledFactsEvidence =
  | {
    readonly status: 'READ';
    readonly matchesDisabled: boolean;
    readonly disabledAttribute: AccessibilityDisabledPlace | null;
    readonly ariaDisabled: AccessibilityDisabledPlace | null;
    readonly inert: AccessibilityDisabledPlace | null;
    readonly axDisabled: boolean | null;
    readonly pointerEvents: string;
    readonly cursor: string;
    readonly tabIndexNegative: boolean;
    readonly disabledForAssistiveTech: boolean;
    readonly disabledStateNotExposed: boolean;
  }
  | { readonly status: AccessibilityDisabledFactsUnreadStatus };

/** AUD-8（4-3）: 主の件数から外す印の閉じた一覧（支援技術に無効と伝わるのに axe が数えた要素）。 */
export const ACCESSIBILITY_COUNT_EXCLUSIONS = Object.freeze(['DISABLED_FOR_ASSISTIVE_TECH'] as const);
export type AccessibilityCountExclusion = (typeof ACCESSIBILITY_COUNT_EXCLUSIONS)[number];

export interface AccessibilityNodeEvidence {
  readonly impact: AccessibilityImpact;
  readonly targetSelectors: readonly AccessibilityTargetSelector[];
  readonly failureSummary: string | null;
  readonly htmlSnippet: string;
  /** selector・`failureSummary`・HTML の抜粋・確かめの data のどれかを上限で切り詰めたか（どの欄かは `truncations`）。 */
  readonly truncated: boolean;
  /** AUD-8: 確かめ（`any`・`all`・`none` の順）。古い版の記録にはない。 */
  readonly checks?: readonly AccessibilityCheckEvidence[];
  /** AUD-8: 値の長さで切った欄（切らなければ空）。古い版の記録にはない。 */
  readonly truncations?: readonly AccessibilityValueTruncationEvidence[];
  /** AUD-8: 色差の Rule の要素の無効の事実（ほかの Rule の要素は `null`）。古い版の記録にはない。 */
  readonly disabledFacts?: AccessibilityDisabledFactsEvidence | null;
  /** AUD-8: 主の件数から外す印（外さなければ `null`）。古い版の記録にはない。 */
  readonly countExclusion?: AccessibilityCountExclusion | null;
  /**
   * AUD-3d の続き: 違反の要素（axe の target）の矩形（ビューポートの座標。読んだ位置は `AccessibilityEvidence.regionScrollPosition`）。読めなかった要素は理由。
   * 要確認（incomplete）の要素と、古い版の記録にはない。
   */
  readonly region?: AccessibilityTargetRegionEvidence;
  /**
   * AUD-4b: 名前の不一致（`label-content-name-mismatch`）の違反の要素の、AX（ブラウザのアクセシビリティの木）の名前の文脈。ほかの Rule の要素と、古い版の記録には
   * ない。
   */
  readonly nameContext?: AccessibilityNameContextEvidence;
  /**
   * EV-1: 色差の Rule の要素の、確かめの data の前景と背景の色（`fgColor`・`bgColor`）から計算した、丸める前のコントラスト比。色を読めない要素・ほかの Rule の
   * 要素・古い版の記録にはない。
   */
  readonly computedContrastRatio?: number;
}

/**
 * AUD-4b: AX を読めなかった理由の閉じた一覧。
 * - `NOT_FOUND`: target の selector で要素が見つからなかった。
 * - `IN_FRAME`: iframe の中の要素（読まない）。
 * - `IN_SHADOW`: shadow root の中の要素（CDP の DOM の selector では引けないので読まない）。
 * - `NOT_READ`: 読み取りが使えなかった（session を開けない・命令の失敗・形の違い）。
 */
export const ACCESSIBILITY_AX_UNREADABLE_REASONS = Object.freeze(['NOT_FOUND', 'IN_FRAME', 'IN_SHADOW', 'NOT_READ'] as const);
export type AccessibilityAxUnreadableReason = (typeof ACCESSIBILITY_AX_UNREADABLE_REASONS)[number];

/** AUD-4b: AX の名前の命名元（CDP の `AXValueSource` の `type` と、属性なら属性の名前）。 */
export interface AccessibilityAxNameSource {
  /** `attribute`・`contents`・`relatedElement`・`placeholder`・`implicit`・`style` など（CDP の値のまま）。 */
  readonly type: string;
  readonly attribute: string | null;
}

/**
 * AUD-4b: AX で読んだ、要素の名前の文脈（算出した名前・役割・無効の状態・命名元・見えるラベルの文字のかたまり）。読めなければ理由。
 * `labelSegments` は、要素の下の AX の文字の節（無視されない `StaticText`）の名前を、木の順に並べたもの（見えるラベルの文字。補足の文字の区分は Rule の側が決める）。
 */
export type AccessibilityNameContextEvidence =
  | Readonly<{
    status: 'READ';
    axName: string | null;
    axRole: string | null;
    axDisabled: boolean;
    nameSource: AccessibilityAxNameSource | null;
    labelSegments: readonly string[];
  }>
  | Readonly<{ status: 'UNREADABLE'; reason: AccessibilityAxUnreadableReason }>;

/**
 * AUD-3d の続き: axe の target の矩形を読めなかった理由の閉じた一覧。
 * - `NOT_FOUND`: target の selector で要素が見つからなかった（axe の後に消えた・変わったなど）。
 * - `IN_FRAME`: iframe の中の要素（ビューポートの座標に直せないので読まない）。
 * - `NO_BOX`: 要素の箱がない（大きさが 0、または描かれていない）。
 * - `NOT_READ`: 読み取りが使えなかった（失敗・見張りの終わり）。
 */
export const ACCESSIBILITY_TARGET_REGION_REASONS = Object.freeze(['NOT_FOUND', 'IN_FRAME', 'NO_BOX', 'NOT_READ'] as const);
export type AccessibilityTargetRegionReason = (typeof ACCESSIBILITY_TARGET_REGION_REASONS)[number];

/** AUD-3d の続き: axe の target の矩形（読めた）か、読めなかった理由。 */
export type AccessibilityTargetRegionEvidence =
  | Readonly<{ status: 'READ'; rect: RectangleEvidence }>
  | Readonly<{ status: 'UNREADABLE'; reason: AccessibilityTargetRegionReason }>;

export interface AccessibilityRuleEvidence {
  readonly ruleId: string;
  readonly impact: AccessibilityImpact;
  readonly help: string;
  readonly helpUrl: string;
  readonly tags: readonly string[];
  readonly nodes: readonly AccessibilityNodeEvidence[];
  /** 古い版の記録を読むためだけに残す: 件数の上限を超えたため記録しなかった要素の件数（COV-6 の後の記録では常に 0）。 */
  readonly omittedNodeCount: number;
}

/** axe が違反と判定したルール。 */
export type AccessibilityViolationEvidence = AccessibilityRuleEvidence;

/** axe が自動では判定できず、確認が必要とした（`incomplete`）ルール。違反とは別に記録する。 */
export type AccessibilityIncompleteEvidence = AccessibilityRuleEvidence;

interface AccessibilityEvidenceFacts {
  /**
   * 検査の範囲。axe はレガシーの方式で対象の page の中だけで実行するため、検査の範囲は同じOriginの文書に限られ、
   * 別Originの iframe の中は検査しない（DEF-001）。
   */
  readonly frameScope: 'SAME_ORIGIN_ONLY';
  readonly violations: readonly AccessibilityViolationEvidence[];
  readonly incomplete: readonly AccessibilityIncompleteEvidence[];
}

/** AUD-3d の続き: 違反の要素の矩形を読んだときの、文書のスクロール位置（読まなかった記録と古い版の記録にはない）。 */
interface AccessibilityRegionFacts {
  readonly regionScrollPosition?: ScrollPosition | null;
  /** EV-1: 判定した axe の版（axe の結果の `testEngine.version`。読めなかった記録と古い版の記録にはない）。 */
  readonly axeVersion?: string;
}

export type AccessibilityEvidence = Readonly<AccessibilityEvidenceFacts & AccessibilityRegionFacts & {
  readonly status: 'COMPLETE';
  /** 収集した時点（axe を実行する直前）の文書のスクロール位置（定義は `ScrollPosition`）。 */
  readonly scrollPosition: ScrollPosition;
}> | Readonly<AccessibilityEvidenceFacts & AccessibilityRegionFacts & {
  readonly status: 'PARTIAL';
  readonly reason: AccessibilityIncompleteReason;
  /** 収集した時点の文書のスクロール位置。位置を読む前に止まった場合と、読めなかった場合は `null`。 */
  readonly scrollPosition: ScrollPosition | null;
}>;

// ---------------------------------------------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------------------------------------------

/** Interaction の候補の `href` の種類の閉じた一覧。 */
export const INTERACTION_HREF_KINDS = Object.freeze(
  ['NONE', 'SAME_ORIGIN_HTTP', 'EXTERNAL_ORIGIN_HTTP', 'SPECIAL_SCHEME', 'MALFORMED'] as const,
);

/** Interaction の候補の `href` の種類。`src/safety/interaction-policy.ts` の `InteractionHrefKind` は、この型の別名。 */
export type InteractionHrefKindEvidence = (typeof INTERACTION_HREF_KINDS)[number];

/**
 * Interaction の候補の境界の矩形（ページ座標）。`src/safety/interaction-policy.ts` の `InteractionBoundingBox` は、
 * この型の別名。項目は Layout の矩形と同じなので、`RectangleEvidence` の別名にする（CC-033。RC18 の M6）。スキーマは別々に持つ。
 */
export type InteractionBoundingBoxEvidence = RectangleEvidence;

/** Interaction の候補の事実。`src/safety/interaction-policy.ts` の `InteractionCandidate` は、この型の別名。 */
export interface InteractionCandidateEvidence {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly tagName: string;
  readonly role: string | null;
  readonly accessibleName: string;
  readonly textFingerprint: string;
  readonly ariaExpanded: string | null;
  readonly ariaControls: string | null;
  readonly ariaSelected: string | null;
  readonly controlledVisible: boolean | null;
  readonly controlledHidden: boolean | null;
  readonly formAssociated: boolean;
  readonly formMethod: string | null;
  readonly formAction: string | null;
  readonly href: string | null;
  readonly hrefKind: InteractionHrefKindEvidence;
  readonly download: boolean;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly visible: boolean;
  /**
   * SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.2）: 削除に関する操作か（操作の前の判定 `src/discovery/destructive-action.ts` の
   * `isDestructiveAction` の結果）。真の候補は押さない（`DESTRUCTIVE_ACTION_SKIPPED`）。前の版の記録にはない（スキーマでは任意）。
   */
  readonly destructiveAction: boolean;
  readonly boundingBox: InteractionBoundingBoxEvidence;
}

/**
 * Interaction の候補を実行しない理由（`classifyInteractionCandidate` の REJECT の理由）の閉じた一覧。
 * `src/safety/interaction-policy.ts` の `InteractionRejectionReason` は、ここから導く型の別名。
 * どの理由を Safety Ledger のどの記録に残すかは、`interactionRejectionLedgerRecord` が決める。
 */
export const INTERACTION_REJECTION_REASONS = Object.freeze([
  'SUBMISSION_CONTROL',
  'RESET_CONTROL',
  'FORM_ASSOCIATED',
  'NAVIGATION_HREF',
  'EXTERNAL_ACTION',
  'DOWNLOAD',
  'DISABLED',
  'NOT_VISIBLE',
  'MALFORMED_CANDIDATE',
  // SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 削除に関する操作（消す・取り消すなど）なので押さない。
  'DESTRUCTIVE_ACTION_SKIPPED',
] as const);

/** Interaction の候補を実行しない理由。`src/safety/interaction-policy.ts` の `InteractionRejectionReason` は、この型の別名。 */
export type InteractionRejectionReasonEvidence = (typeof INTERACTION_REJECTION_REASONS)[number];

/** Interaction の前後で、候補が同じ要素かを確かめた結果の閉じた一覧。 */
export const INTERACTION_IDENTITY_STATUSES = Object.freeze(
  ['MATCHED', 'MISSING', 'AMBIGUOUS', 'REPLACED', 'UNESTABLISHED'] as const,
);
export type InteractionIdentityStatus = (typeof INTERACTION_IDENTITY_STATUSES)[number];

export interface InteractionChangeEvidence {
  readonly before: InteractionCandidateEvidence | null;
  readonly after: InteractionCandidateEvidence | null;
  readonly identityStatus: InteractionIdentityStatus;
  readonly changedFields: readonly string[];
  /**
   * 対象自身の属性の変化（`changedFields` の `attributes`）が根拠になった場合の、変わった属性の名前
   * （UTF-16 のコード単位の順。件数は `src/evidence/interaction-collector.ts` の上限まで）。
   * `attributes` が根拠でない場合は空（設計書 2026-09-23 4.4.1、R5 の N-5）。
   */
  readonly changedAttributes: readonly string[];
  /**
   * `changedAttributes` を件数の上限で切り詰めたか（F17）。L2 で上限を撤廃し、SPEC-5 で持続の確認もやめたので、今の版はいつも false を書く。
   * 前の版の記録を読むために、スキーマの必須の欄として残す（消すのは記録の形の版を上げる段）。
   */
  readonly changedAttributesTruncated: boolean;
  /**
   * 対象が `details` の子の `summary` の場合の、click の前の親の `details` の `open` の有無（R6 の M-4）。
   * 開いたのか閉じたのかを、`detailsOpenAfter` と合わせて残す。対象が `details` の子の `summary` でない場合と、
   * click の前後を観測していない場合（`after` が null の場合）は null。
   */
  readonly detailsOpenBefore: boolean | null;
  /** click の後の親の `details` の `open` の有無。null になる場合は `detailsOpenBefore` と同じ（R6 の M-4）。 */
  readonly detailsOpenAfter: boolean | null;
}

/**
 * Interaction の NOT_VERIFIABLE の区分の閉じた一覧（Task 14〜17 の設計書 5.4.1、I15a）。Run Status への反映に使う。
 * - `OBSERVED_NO_CHANGE`: 確かめる手順を最後まで行った。そのうえで、変化が見えなかったか、サイトの振る舞いのために確かめられないと結論した。
 *   サイトの振る舞いの結果として扱い、Run の完了を妨げない。
 * - `CHECK_NOT_COMPLETED`: 確かめる手順を終えられなかった（期限切れ、下準備の失敗、作業量の上限、比べられないなど）。未確認の作業として扱う。
 * 理由ごとの区分は、`src/interaction/isolated-auditor.ts` の `INTERACTION_NOT_VERIFIABLE_REASONS` が1か所で決める。
 */
export const INTERACTION_NOT_VERIFIABLE_KINDS = Object.freeze(['OBSERVED_NO_CHANGE', 'CHECK_NOT_COMPLETED'] as const);
export type InteractionNotVerifiableKind = (typeof INTERACTION_NOT_VERIFIABLE_KINDS)[number];

/**
 * Interaction の NOT_VERIFIABLE の理由のコードの閉じた一覧（Task 19 の前の整理の設計書 5.1.2）。
 * コードごとの区分（`InteractionNotVerifiableKind`）は、`src/interaction/isolated-auditor.ts` の
 * `INTERACTION_NOT_VERIFIABLE_REASONS` が1か所で決める。技術的な詳細は、Evidence の `reasonDetail` に入れる。
 */
export const INTERACTION_NOT_VERIFIABLE_REASON_CODES = Object.freeze([
  // 隔離した session の作成の期限切れ（DEF-008）。
  'SESSION_OPEN_DEADLINE',
  // 読み込みと初期描画の期限切れ（R6 の I-2）。
  'INITIAL_LOAD_BEFORE_LOAD',
  'INITIAL_LOAD_DURING_LOAD',
  'INITIAL_LOAD_AFTER_LOAD',
  'INITIAL_LOAD_BEFORE_RENDER',
  // 凍結の前の下準備（SPEC-5: 書くのは `SCROLL_PREPARATION_DEADLINE`・`SCROLL_PREPARATION_FAILED` だけ。focus・安定の確認・作業量・期限の
  // 細かい区別のコードは、前の版の記録を読むため。`INTERACTION_LEGACY_NOT_VERIFIABLE_REASON_CODES`）。
  'SCROLL_PREPARATION_DEADLINE',
  'SCROLL_PREPARATION_DOM_WORK_EXHAUSTED',
  /** 詳細は、整えたエラーの文言（残らなければ null）。HOVER・FOCUS の `_FAILED` も同じ。 */
  'SCROLL_PREPARATION_FAILED',
  'SCROLL_PREPARATION_SETTLE_DEADLINE',
  'HOVER_PREPARATION_DEADLINE',
  'HOVER_PREPARATION_FAILED',
  'FOCUS_PREPARATION_DEADLINE',
  'FOCUS_PREPARATION_FAILED',
  'FOCUS_PREPARATION_DOM_WORK_EXHAUSTED',
  'FOCUS_PREPARATION_TARGET_DISCONNECTED',
  'FOCUS_PREPARATION_CANDIDATE_LIMIT_REACHED',
  'FOCUS_PREPARATION_TEXT_NODE_LIMIT_REACHED',
  'FOCUS_PREPARATION_STATE_CHANGED',
  'FOCUS_PREPARATION_STATE_UNCOMPARABLE',
  // 凍結の前の安定性の確認（同じ要素かの確認を含む）。
  'STABILITY_CHECK_DEADLINE',
  'STABILITY_CHECK_DOM_WORK_EXHAUSTED',
  'STABILITY_CHECK_TARGET_DISCONNECTED',
  'STABILITY_CHECK_CANDIDATE_LIMIT_REACHED',
  'STABILITY_CHECK_TEXT_NODE_LIMIT_REACHED',
  // 凍結の後の、探し直し・handle の解決・受け入れの判定・click。
  'DEADLINE_AFTER_SAFETY_FREEZE',
  'DEADLINE_DURING_CANDIDATE_REDISCOVERY',
  'DOM_WORK_EXHAUSTED',
  /** 詳細は、探し直しの completeness の値。 */
  'CANDIDATE_REDISCOVERY_INCOMPLETE',
  'CANDIDATE_IDENTITY_NOT_REDISCOVERED',
  'CANDIDATE_IDENTITY_AMBIGUOUS',
  'DEADLINE_BEFORE_TARGET_HANDLE_ACQUISITION',
  'DEADLINE_DURING_TARGET_HANDLE_ACQUISITION',
  'TARGET_HANDLE_NOT_RESOLVED',
  'TARGET_HANDLE_RESOLUTION_DOM_WORK_EXHAUSTED',
  'DEADLINE_DURING_TARGET_FACT_COLLECTION',
  'TARGET_INSPECTION_DOM_WORK_EXHAUSTED',
  'TARGET_INSPECTION_CANDIDATE_LIMIT_REACHED',
  'TARGET_INSPECTION_TEXT_NODE_LIMIT_REACHED',
  'TARGET_DISCONNECTED_BEFORE_ADMISSION',
  'TARGET_CHANGED_DURING_EXACT_NODE_RESOLUTION',
  'DEADLINE_DURING_EXACT_NODE_ADMISSION',
  'TARGET_NOT_SCROLL_PREPARED',
  'DEADLINE_BEFORE_EXACT_NODE_CLICK',
  /** click の期限切れ。詳細は、整えた click のエラーの文言（残らなければ null）。ほかの click の失敗は `CLICK_FAILED`。 */
  'CLICK_TIMED_OUT',
  // click の後の観測（SPEC-5: 書くのは `DEADLINE_DURING_POST_CONDITION_OBSERVATION`（押した後の期限切れ）・`NO_OBSERVABLE_CHANGE`・
  // `RETAINED_IDENTITY_LOST` だけ。ほかは前の版の記録を読むため）。
  'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
  'DEADLINE_DURING_POST_CONDITION_OBSERVATION',
  'PERSISTENCE_CHECK_DEADLINE',
  'NO_OBSERVABLE_CHANGE',
  'GEOMETRY_ONLY_CHANGED_WHILE_SCROLLED',
  'GEOMETRY_ONLY_CHANGED_SCROLL_UNCOMPARABLE',
  'GEOMETRY_ONLY_CHANGED',
  'RETAINED_INSPECTION_DOM_WORK_EXHAUSTED',
  'RETAINED_INSPECTION_CANDIDATE_LIMIT_REACHED',
  'RETAINED_INSPECTION_TEXT_NODE_LIMIT_REACHED',
  /** 詳細は、切断の後の identityStatus の値。 */
  'RETAINED_IDENTITY_LOST',
  // L5（INV-LIMITS の表 A の T11・T21。設計者の判断 2026-11-10）: 利用者が期限を指定していない操作を、L0 の進みの見張りが終えた（全く反応がない・静まらない）。
  'STAGE_UNRESPONSIVE',
  'STAGE_NEVER_QUIET',
  // COV-4 の区切り 3（入れ子の開いた状態。設計者の判断 2026-11-10）: 開いた状態まで押し直す並びを、同じ構造の鍵の状態まで再現できなかった。
  'TRAIL_NOT_REPRODUCED',
] as const);
/** NOT_VERIFIABLE の理由のコード（読めるコードの全部。前の版の記録のコードを含む）。 */
export type InteractionNotVerifiableReasonCode = (typeof INTERACTION_NOT_VERIFIABLE_REASON_CODES)[number];

/**
 * SPEC-5（設計書 2026-11-14 5.1）: 前の版だけが書いた NOT_VERIFIABLE の理由のコード（読むだけ）。押した後の確かめを 1 回の観察で決めるようにしたので、
 * 今の版は書かない。中断した Run の再開（`checkpoint-page` は page の schema で読む）と、前の Run の記録を読むために、閉じた一覧とスキーマに残す。
 * 説明は 1 つにまとめる（`src/presentation/messages.ts`）。区分は、記録の `notVerifiableKind` をそのまま使う。
 */
export const INTERACTION_LEGACY_NOT_VERIFIABLE_REASON_CODES = Object.freeze([
  'SCROLL_PREPARATION_DOM_WORK_EXHAUSTED',
  'SCROLL_PREPARATION_SETTLE_DEADLINE',
  'HOVER_PREPARATION_DEADLINE',
  'HOVER_PREPARATION_FAILED',
  'FOCUS_PREPARATION_DEADLINE',
  'FOCUS_PREPARATION_FAILED',
  'FOCUS_PREPARATION_DOM_WORK_EXHAUSTED',
  'FOCUS_PREPARATION_TARGET_DISCONNECTED',
  'FOCUS_PREPARATION_CANDIDATE_LIMIT_REACHED',
  'FOCUS_PREPARATION_TEXT_NODE_LIMIT_REACHED',
  'FOCUS_PREPARATION_STATE_CHANGED',
  'FOCUS_PREPARATION_STATE_UNCOMPARABLE',
  'STABILITY_CHECK_DEADLINE',
  'STABILITY_CHECK_DOM_WORK_EXHAUSTED',
  'STABILITY_CHECK_TARGET_DISCONNECTED',
  'STABILITY_CHECK_CANDIDATE_LIMIT_REACHED',
  'STABILITY_CHECK_TEXT_NODE_LIMIT_REACHED',
  'DEADLINE_AFTER_SAFETY_FREEZE',
  'DEADLINE_DURING_CANDIDATE_REDISCOVERY',
  'DOM_WORK_EXHAUSTED',
  'CANDIDATE_REDISCOVERY_INCOMPLETE',
  'DEADLINE_BEFORE_TARGET_HANDLE_ACQUISITION',
  'DEADLINE_DURING_TARGET_HANDLE_ACQUISITION',
  'TARGET_HANDLE_RESOLUTION_DOM_WORK_EXHAUSTED',
  'DEADLINE_DURING_TARGET_FACT_COLLECTION',
  'TARGET_INSPECTION_DOM_WORK_EXHAUSTED',
  'TARGET_INSPECTION_CANDIDATE_LIMIT_REACHED',
  'TARGET_INSPECTION_TEXT_NODE_LIMIT_REACHED',
  'DEADLINE_DURING_EXACT_NODE_ADMISSION',
  'DEADLINE_BEFORE_POST_CONDITION_OBSERVATION',
  'PERSISTENCE_CHECK_DEADLINE',
  'GEOMETRY_ONLY_CHANGED_WHILE_SCROLLED',
  'GEOMETRY_ONLY_CHANGED_SCROLL_UNCOMPARABLE',
  'GEOMETRY_ONLY_CHANGED',
  'RETAINED_INSPECTION_DOM_WORK_EXHAUSTED',
  'RETAINED_INSPECTION_CANDIDATE_LIMIT_REACHED',
  'RETAINED_INSPECTION_TEXT_NODE_LIMIT_REACHED',
] as const satisfies readonly InteractionNotVerifiableReasonCode[]);
export type InteractionLegacyNotVerifiableReasonCode = (typeof INTERACTION_LEGACY_NOT_VERIFIABLE_REASON_CODES)[number];
/** 今の版が書く NOT_VERIFIABLE の理由のコード。区分は `src/interaction/isolated-auditor.ts` の `INTERACTION_NOT_VERIFIABLE_REASONS` が決める。 */
export type InteractionWrittenNotVerifiableReasonCode = Exclude<InteractionNotVerifiableReasonCode, InteractionLegacyNotVerifiableReasonCode>;

/** VERIFIED の理由のコード。 */
export const INTERACTION_VERIFIED_REASON_CODES = Object.freeze(['OBSERVABLE_STATE_CHANGED'] as const);
/** BLOCKED_BY_SAFETY の理由のコード（凍結の後の作用の遮断と、owner の close の安全の失敗）。 */
export const INTERACTION_BLOCKED_BY_SAFETY_REASON_CODES = Object.freeze(
  ['SAFETY_FREEZE_BLOCKED', 'OWNER_CLOSE_SAFETY_FAILURE'] as const,
);
/**
 * EXECUTION_FAILED の理由のコード。`CLICK_FAILED` は click の期限切れ以外の失敗、`EXECUTION_FAILED` はそのほかの作業の失敗。
 * どちらも詳細は、整えたエラーの文言（残らなければ null）。
 */
export const INTERACTION_EXECUTION_FAILED_REASON_CODES = Object.freeze(['EXECUTION_FAILED', 'CLICK_FAILED'] as const);

/**
 * Interaction の status ごとの、理由のコードの閉じた一覧（設計書 5.1.2）。どの status にどのコードが入りうるかを表す。
 * スキーマ（`schemas/page.schema.json` の `$defs/interactionStatusReason`）は、この対応と一致させる。
 */
export const INTERACTION_REASON_CODES_BY_STATUS = Object.freeze({
  VERIFIED: INTERACTION_VERIFIED_REASON_CODES,
  REJECTED_UNSAFE: INTERACTION_REJECTION_REASONS,
  BLOCKED_BY_SAFETY: INTERACTION_BLOCKED_BY_SAFETY_REASON_CODES,
  NOT_VERIFIABLE: INTERACTION_NOT_VERIFIABLE_REASON_CODES,
  EXECUTION_FAILED: INTERACTION_EXECUTION_FAILED_REASON_CODES,
} as const satisfies Readonly<Record<InteractionStatus, readonly string[]>>);

/** status ごとの、理由のコードの型。 */
export type InteractionReasonCodeFor<S extends InteractionStatus> = (typeof INTERACTION_REASON_CODES_BY_STATUS)[S][number];

/** Interaction の理由のコードの閉じた一覧（すべての status の分）。Evidence の `reason` と `work.reason` は、この一覧の値。 */
export const INTERACTION_REASON_CODES = Object.freeze([
  ...INTERACTION_VERIFIED_REASON_CODES,
  ...INTERACTION_REJECTION_REASONS,
  ...INTERACTION_BLOCKED_BY_SAFETY_REASON_CODES,
  ...INTERACTION_NOT_VERIFIABLE_REASON_CODES,
  ...INTERACTION_EXECUTION_FAILED_REASON_CODES,
] as const);
export type InteractionReasonCode = (typeof INTERACTION_REASON_CODES)[number];

/**
 * Interaction の lifecycle（隔離した session を閉じる処理）の理由のコードの閉じた一覧（設計書 5.1.2）。
 * - `SESSION_NOT_OPENED`: session の作成が期限を過ぎた。遅れて届いた session は、待たずに閉じる。
 * - `OWNER_CLOSE_TIMED_OUT`: owner の close が、Guard の終端の前に期限を過ぎた。
 * - `OWNER_CLOSE_FAILED`: owner の close が失敗した。詳細は、整えたエラーの文言（残らなければ null）。
 * - `OWNER_CLOSE_NON_TERMINAL`: owner の close は終わったが、Guard が終端に達していない。
 */
export const INTERACTION_LIFECYCLE_REASON_CODES = Object.freeze([
  'SESSION_NOT_OPENED',
  'OWNER_CLOSE_TIMED_OUT',
  'OWNER_CLOSE_FAILED',
  'OWNER_CLOSE_NON_TERMINAL',
] as const);
export type InteractionLifecycleReasonCode = (typeof INTERACTION_LIFECYCLE_REASON_CODES)[number];

export interface InteractionWorkOutcome {
  readonly status: InteractionStatus;
  /** 理由のコード。status と合うコードだけが入る（`INTERACTION_REASON_CODES_BY_STATUS`）。 */
  readonly reason: InteractionReasonCode;
  /** 技術的な詳細（completeness の値、identityStatus の値、整えたエラーの文言）。詳細がなければ null。 */
  readonly reasonDetail: string | null;
  readonly evidence: InteractionChangeEvidence;
}

/** 終端（`CLOSED`）に達した lifecycle。理由がないときは、`reason` と `reasonDetail` がどちらも null。 */
export interface InteractionClosedLifecycle {
  readonly status: 'CLOSED';
  readonly reason: InteractionLifecycleReasonCode | null;
  readonly reasonDetail: string | null;
}

/**
 * 1つの Interaction の候補の監査の結果（interaction の Evidence の payload）。`auditInteraction()` の結果から、
 * Safety Ledger の記録（ページの Safety の Evidence として別に扱う）を除いたもの。
 */
export interface InteractionEvidence {
  readonly candidateId: string;
  readonly status: InteractionStatus;
  /** 理由のコード。status と合うコードだけが入る（`INTERACTION_REASON_CODES_BY_STATUS`）。 */
  readonly reason: InteractionReasonCode;
  /** 技術的な詳細。詳細がなければ null。最終の status を BLOCKED_BY_SAFETY にした場合は null。 */
  readonly reasonDetail: string | null;
  readonly evidence: InteractionChangeEvidence;
  readonly work: InteractionWorkOutcome;
  /**
   * 結果を返すのは Guard が終端（`CLOSED`）に達したときだけ。終端に達しない場合は、結果を返さずに
   * `InteractionOwnerCleanupError` を投げる（設計書 2026-09-23 4.2）。
   */
  readonly lifecycle: InteractionClosedLifecycle;
  /**
   * `status` が `NOT_VERIFIABLE` の場合の区分（I15a）。ほかの状態では null。`work.status` が `NOT_VERIFIABLE` でも、
   * 最終の `status` が `BLOCKED_BY_SAFETY` になった場合は null。
   */
  readonly notVerifiableKind: InteractionNotVerifiableKind | null;
  /**
   * COV-4 の区切り 3: 操作の後の文書の URL（正規化していない。文書が替わらずに URL が変わったら、巡回の辺にする）。前の版の記録と、読めなかったときはない。
   */
  readonly postInteractionUrl?: string;
  /** COV-4 の区切り 3: 操作で開いた状態の監査（`VERIFIED` の操作だけ。前の版の記録にはない）。 */
  readonly openedState?: OpenedStateEvidence;
  /**
   * COV-4 の区切り 3（入れ子の開いた状態）: この候補を押す前に、開いた状態まで押し直した押下の並び（候補の ID と、同じ ID の中の順番）。主の画面の候補にはない。
   */
  readonly pressTrail?: readonly { readonly candidateId: string; readonly ordinal: number }[];
}

/**
 * COV-4 の区切り 3: 開いた状態の監査の結果の閉じた一覧（監査した・同じ構造の鍵の状態を前に監査したので監査しなかった・見張りに終えられて途中まで）。
 */
export const OPENED_STATE_STATUSES = Object.freeze(['AUDITED', 'SAME_STRUCTURE_SEEN', 'PARTIAL'] as const);
export type OpenedStateStatus = (typeof OPENED_STATE_STATUSES)[number];

/** COV-4 の区切り 3: 操作で開いた状態の監査の事実。 */
export interface OpenedStateEvidence {
  /** 開いた状態の状態 ID（`evidenceStateIdOf` の `:state-<番号>` の形）。 */
  readonly stateId: string;
  /** 開いた状態の構造の鍵（`openedStateStructureKeyOf`）。 */
  readonly structureKey: string;
  readonly status: OpenedStateStatus;
  /** 開いた状態の記録で評価した指摘のうち、開く前の画面と fingerprint が同じで除いた数。 */
  readonly duplicateFindingCount: number;
  /**
   * 開いた状態の、落ち着いた後の確かめ直し（AUD-2d・2e。読み込み直さない。形はビューポートの記録の `recheck` と同じ。指摘の印はこの表から引く）。確かめ直しを
   * 当てなかった（同じ構造で監査しなかった・前の版の記録）ときはない。
   */
  readonly recheck?: ViewportRecheckRecord;
}

// ---------------------------------------------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------------------------------------------

/** スクリーンショットの撮り方の閉じた一覧。 */
// ---------------------------------------------------------------------------------------------------------------
// Focus（AUD-4d: 画面の外の、フォーカスできる要素のフォーカスの確かめ）
// ---------------------------------------------------------------------------------------------------------------

/**
 * AUD-4d: 1 つの要素のフォーカスの確かめの事実（矩形はビューポートの座標）。フォーカスを当てる前に画面の外にあった（全体がビューポートの左か上か右の外、または
 * 大きさが 1px 以下の）、フォーカスできる要素だけ。判定（現れるか・隠れたままか）は Rule の側（`src/audit/focus-check.ts`）が決める。
 */
export interface FocusCheckItemEvidence {
  readonly selector: string;
  /** 要素の名前（小文字）。 */
  readonly tagName: string;
  /** フォーカスを当てる前の矩形。 */
  readonly beforeRect: RectangleEvidence;
  /** フォーカスが当たったか（`document.activeElement` がその要素になったか）。 */
  readonly focused: boolean;
  /** フォーカスを当てた後の矩形（読めなければ `null`）。 */
  readonly afterRect: RectangleEvidence | null;
  /** フォーカスを当てた後に描かれて見えるか（`checkVisibility` と、実効の不透明度が 0 より大きい）。 */
  readonly visibleAfterFocus: boolean;
  /**
   * フォーカスを当てた後に押せるか（ビューポートの中の矩形の点のどれかで、最前面がその要素か子孫）。EV-1 より前の記録は、中心の 1 点だけで読んだ。
   */
  readonly hitAfterFocus: boolean;
  /** フォーカスしても隠れたままの要素で撮った、フォーカスを当てたままの viewport の画像の Evidence の ID（撮らなかったら `null`）。 */
  readonly screenshotEvidenceId: EvidenceId | null;
  /** EV-1: 操作の方法（`DIRECT_FOCUS` は、要素に直に、スクロールを止めずにフォーカスを当てた）。前の版の記録にはない。 */
  readonly operation?: FocusCheckOperation;
  /** EV-1: hit-test の点の数と、最前面がその要素か子孫だった点の数。前の版の記録にはない。 */
  readonly hitTestPointCount?: number;
  readonly hitPointCount?: number;
  /**
   * EV-1: フォーカスの前と後の、文書とスクロールの祖先（内から外の順）の位置。`afterRect` と画像は、後の位置で読んだ。確かめの後に、前の位置へ戻す。
   * 前の版の記録にはない（そのときは、文書を動かさずに読んだ）。
   */
  readonly scroll?: FocusCheckScrollEvidence;
}

/** EV-1: フォーカスの確かめの操作の方法の閉じた一覧。 */
export const FOCUS_CHECK_OPERATIONS = Object.freeze(['DIRECT_FOCUS'] as const);
export type FocusCheckOperation = (typeof FOCUS_CHECK_OPERATIONS)[number];

/** EV-1: スクロールの祖先 1 つの、前と後の位置。 */
export interface ScrollAncestorPositionEvidence {
  readonly selector: string;
  readonly before: { readonly scrollLeft: number; readonly scrollTop: number };
  readonly after: { readonly scrollLeft: number; readonly scrollTop: number };
}

/** EV-1: フォーカスの前と後の、文書とスクロールの祖先の位置。 */
export interface FocusCheckScrollEvidence {
  readonly document: { readonly before: ScrollPosition; readonly after: ScrollPosition };
  readonly ancestors: readonly ScrollAncestorPositionEvidence[];
}

/** AUD-4d: フォーカスの確かめの状態の閉じた一覧（`PARTIAL` は、途中で読めなくなった。それまでの要素だけ）。 */
export const FOCUS_CHECK_STATUSES = Object.freeze(['COMPLETE', 'PARTIAL'] as const);
export type FocusCheckStatus = (typeof FOCUS_CHECK_STATUSES)[number];

/** AUD-4d: 1 つの時点（主の読み込みの最後、幅の走査の幅）のフォーカスの確かめ。 */
export interface FocusCheckEvidence {
  readonly status: FocusCheckStatus;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** 読んだときの文書のスクロール位置。 */
  readonly scrollPosition: ScrollPosition;
  readonly items: readonly FocusCheckItemEvidence[];
  /** 幅の走査の幅なら、その幅（px）。主の読み込みにはない。 */
  readonly stressWidth?: number;
  /**
   * EV-4（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.4）: 主の読み込みの、axe の `scrollable-region-focusable` の要素ごとの、キーボードの
   * 実操作の結果（axe の静的な判定とは別の記録）。axe の要素の順。主の読み込みのほか（幅の走査・開いた状態）と、この項目より前の記録にはない。
   */
  readonly scrollableRegions?: readonly ScrollableRegionKeyboardEvidence[];
}

/**
 * EV-4: 横にスクロールする領域のキーボードの実操作の結果の閉じた一覧。
 * - `REACHED_AND_MOVED`: Tab で届き、矢印のキーで位置が動いた。
 * - `REACHED_NOT_MOVED`: Tab で届いたが、矢印のキーで位置が動かなかった。
 * - `NOT_REACHED`: Tab で届かなかった（前のフォーカスできる要素から Tab を押していき、領域を越えた・ほかへ移った）。
 * - `NOT_TRIED`: 試せなかった（文書の selector で引けない要素・見つからない・スクロールの余地がない・前にも後にも起点にできる要素がない・操作の失敗）。
 *   値が変わりうる所でキーを止めたときも含む（起点と領域の間の、値を入れる要素にフォーカスが来た・領域の子孫にフォーカスが来た・同じ要素に戻った）。
 *   REV-EV4: 影の木の中のフォーカスも深くたどって見る。フォーカスが枠（iframe）に入った・起点と領域の間に準備の時点でなかった要素へ移ったときも含む。
 * - `KEY_TRIGGERED_NAVIGATION`（REV-EV4）: キーを押した間に、ページが画面を移そうとした（main frame の文書の移動か、ポップアップ）。Guard が止めて記録し、
 *   画面は移らない（その画面の点検は続ける）。
 */
export const SCROLLABLE_REGION_KEYBOARD_OUTCOMES = Object.freeze([
  'REACHED_AND_MOVED', 'REACHED_NOT_MOVED', 'NOT_REACHED', 'NOT_TRIED', 'KEY_TRIGGERED_NAVIGATION',
] as const);

/** EV-4: キーボードの実操作を試す領域を見つける axe のルールの ID（その指摘の ruleId は `A11Y_SCROLLABLE_REGION_FOCUSABLE`）。 */
export const SCROLLABLE_REGION_AXE_RULE_ID = 'scrollable-region-focusable';
export type ScrollableRegionKeyboardOutcome = (typeof SCROLLABLE_REGION_KEYBOARD_OUTCOMES)[number];

/** EV-4: 1 つの領域のキーボードの実操作の記録（値を変えず、確かめた後に位置とフォーカスを元へ戻した）。 */
export interface ScrollableRegionKeyboardEvidence {
  /** axe の要素の selector の並び（`AccessibilityNodeEvidence.targetSelectors` と同じ値。指摘の目印 `target` と照らす）。 */
  readonly targetSelectors: readonly AccessibilityTargetSelector[];
  readonly outcome: ScrollableRegionKeyboardOutcome;
  /** 押したキーの順（例: `Tab`・`ArrowRight`。前にフォーカスできる要素がなく、後の要素から戻ったら `Shift+Tab`）。試せなかったら、それまでに押したキー。 */
  readonly keys: readonly string[];
  /** 矢印のキーを押す前と後の、領域の位置（押さなかったら `null`）。 */
  readonly region: ScrollAncestorPositionEvidence | null;
  /** 領域まで動かした前と後の、文書とスクロールの祖先の位置（動かせなかったら `null`）。 */
  readonly scroll: FocusCheckScrollEvidence | null;
  /** 領域まで動かして撮った画像（撮らない設定・撮れなかったら `null`）。 */
  readonly screenshotEvidenceId: EvidenceId | null;
}

export const SCREENSHOT_CAPTURE_TYPES = Object.freeze(['VIEWPORT', 'FULL_PAGE'] as const);
export type ScreenshotCaptureType = (typeof SCREENSHOT_CAPTURE_TYPES)[number];

export interface ScreenshotEvidence {
  readonly pageId: PageId;
  /** 撮影したビューポート（`VIEWPORT_PROFILES` のどれか）。 */
  readonly viewport: ViewportProfile;
  readonly relativePath: string;
  readonly captureType: ScreenshotCaptureType;
  /** 撮影の直前に読んだ文書のスクロール位置（定義は `ScrollPosition`）。先頭へ戻せなかった場合は、その位置。 */
  readonly scrollPosition: ScrollPosition;
  /**
   * AUD-3d: 幅の走査の幅の viewport の画像なら、その幅（px）。layout を読んだ直後に、その幅の page で撮る（状態 ID は Desktop の読み込みのもの）。主の画像と、
   * この項目より前の Evidence にはない。
   */
  readonly stressWidth?: number;
  /**
   * EV-2（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 対象まで動かして（フォーカスの確かめは、フォーカスの後の位置のまま）撮った画像なら、
   * 撮ったときに測り直した対象の記録（部品 `revealAndCapture`）。先頭へ戻さずに撮るので、`scrollPosition` は撮った位置。ほかの画像と、前の版の記録にはない。
   */
  readonly reveal?: RevealCaptureEvidence;
}

/** EV-2: 撮った画像の範囲に、対象が入ったかの閉じた一覧（全部・一部・入らない。機械で決める）。 */
export const TARGET_IMAGE_INCLUSIONS = Object.freeze(['INSIDE', 'PARTIAL', 'OUTSIDE'] as const);
export type TargetImageInclusion = (typeof TARGET_IMAGE_INCLUSIONS)[number];

/** EV-2: 対象まで動かして撮る所（重なり・固定の枠の覆い・フォーカス）の閉じた一覧。EV-4: 文字の見切れと、横にスクロールする領域を足した。 */
export const REVEAL_PURPOSES = Object.freeze(['ELEMENT_OVERLAP', 'FIXED_ELEMENT_OCCLUSION', 'FOCUS', 'TEXT_CLIPPING', 'SCROLLABLE_REGION'] as const);
export type RevealPurpose = (typeof REVEAL_PURPOSES)[number];

/**
 * EV-2: 測った位置の閉じた一覧。`TARGET` は対象が画面の中に入るまで動かした位置、`END` は文書と覆われる要素のスクロールの祖先を末尾まで動かした位置（覆いだけ）、
 * `AS_IS` は動かさない位置（フォーカスの後の位置）。REV-EV12 の I-1: `ONE_SCREEN` は、文書を初めの位置から、対象が画面に残る範囲（対象の上端が画面の上端に
 * 来るまで。多くても 1 画面分）だけ動かした位置（覆いだけ。初めの位置だけの覆いを見分ける）。
 */
export const REVEAL_POSITIONS = Object.freeze(['TARGET', 'END', 'AS_IS', 'ONE_SCREEN'] as const);
export type RevealPosition = (typeof REVEAL_POSITIONS)[number];

/** EV-2: 対象まで動かして撮る対象の指定（ページの中で selector で引き直す）。 */
export interface RevealTargetSpec {
  readonly purpose: RevealPurpose;
  /** 対象の要素の selector（重なりは 2 つの要素、覆いは覆われる要素、フォーカスは要素）。 */
  readonly selectors: readonly string[];
  /** 覆いだけ: 覆う固定の要素の selector。 */
  readonly overlaySelector?: string;
}

/** EV-2: 1 つの対象を、1 つの位置で測り直した記録。 */
export interface RevealedTargetEvidence extends RevealTargetSpec {
  readonly position: RevealPosition;
  /** 対象の要素を、全部ページの中で引き直せたか。 */
  readonly found: boolean;
  /** 動かす前と後の、文書と、動かした要素のスクロールの祖先（内から外の順）の位置（後の位置で測って撮り、撮った後に前の位置へ戻した）。 */
  readonly scroll: FocusCheckScrollEvidence;
  /** 測り直した対象の矩形（viewport の座標。重なりは 2 つの要素の交わり。分けて撮った回は、その回の部分）。引き直せなければ `null`。 */
  readonly rect: RectangleEvidence | null;
  /** 対象の要素ごとの矩形（`selectors` の順。引き直せなかった要素は `null`）。 */
  readonly elementRects: readonly (RectangleEvidence | null)[];
  /** 要素ごとの行ごとの矩形（`getClientRects`）の数（`selectors` の順）。 */
  readonly lineRectCounts: readonly number[];
  /** `rect` のうち、viewport とスクロールの祖先の箱で切り取った後に見える部分（なければ `null`）。 */
  readonly visibleRect: RectangleEvidence | null;
  /** hit-test の点の数と、最前面が対象の要素（重なりはどちらか）か子孫だった点の数。 */
  readonly hitTestPointCount: number;
  readonly hitPointCount: number;
  /** 覆いだけ: 最前面が覆う要素か子孫だった点の数と、覆う要素が描かれて画面と交わるか。 */
  readonly coveredPointCount?: number;
  readonly overlayPresent?: boolean;
  /** 覆いだけ: 覆われる要素が押す部品（リンク・ボタン・入力欄）か、無効でないか。 */
  readonly control?: { readonly interactive: boolean; readonly enabled: boolean };
  /** 撮った画像の範囲（viewport）に、`rect` が入ったか。 */
  readonly inclusion: TargetImageInclusion;
  /** 対象が viewport より大きく、分けて撮った回なら、その番号（0 から）と回の数。 */
  readonly segment?: { readonly index: number; readonly count: number };
}

/** EV-2: 対象まで動かして撮った 1 枚の画像の、測り直しの記録。 */
export interface RevealCaptureEvidence {
  /** 撮った viewport の大きさ（画像の大きさ）。 */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** この画像に写る対象（同じ帯に入る複数の対象は 1 枚にまとめる）。 */
  readonly targets: readonly RevealedTargetEvidence[];
}

// ---------------------------------------------------------------------------------------------------------------
// Metadata（robots.txt と sitemap.xml。Task 14〜17 の設計書 5.6.2）
// ---------------------------------------------------------------------------------------------------------------
// 取得は `src/crawl/site-metadata.ts`（R15b）が、Guard の付いた Passive Context の GET のナビゲーションで行う。
// Evidence は、開始の URL のページの `PageAuditResult.evidence` に、ビューポートを null として置く。

/** サイトの metadata の種類の閉じた一覧。 */
export const SITE_METADATA_KINDS = Object.freeze(['ROBOTS_TXT', 'SITEMAP_XML'] as const);
export type SiteMetadataKind = (typeof SITE_METADATA_KINDS)[number];

/**
 * サイトの metadata の取得の結果の閉じた一覧。
 * - `OK`: 本文を得た。
 * - `NOT_FOUND`: ファイルがなかった（例: 404）。
 * - `FAILED`: そのほかの理由で取得できなかった。
 * - `EXCLUDED`: 認証つきの Run で、監査の段の除外に当たるので、取りに行かなかった（Task 25 の設計書 4.2、4.7。T25c round 3）。応答も本文も
 *   ない。公開監査（認証の指定のない Run）では現れない。sitemap の判定には使わない（`sitemapEvidenceFromMetadata` が `null` を返す）。
 */
export const SITE_METADATA_OUTCOMES = Object.freeze(['OK', 'NOT_FOUND', 'FAILED', 'EXCLUDED'] as const);
export type SiteMetadataOutcome = (typeof SITE_METADATA_OUTCOMES)[number];

interface SiteMetadataEvidenceBase {
  /** 取得した URL。 */
  readonly url: string;
  readonly outcome: SiteMetadataOutcome;
  /** 応答の HTTP ステータス。応答を得られなかった場合は `null`。 */
  readonly httpStatus: number | null;
  /** 本文（LZ-2: 切り詰めない）。本文がない場合は `null`。 */
  readonly text: string | null;
  /** 前は、本文を上限で切り詰めたか。LZ-2 で上限を撤廃したので、今はいつも偽（前の記録の形のために残す）。 */
  readonly textTruncated: boolean;
}

/** robots.txt の Evidence。sitemap の URL は持たない。 */
export interface RobotsTxtMetadataEvidence extends SiteMetadataEvidenceBase {
  readonly kind: Extract<SiteMetadataKind, 'ROBOTS_TXT'>;
  readonly sitemapUrls: null;
  readonly sitemapUrlsTruncated: false;
}

/** sitemap.xml の Evidence。 */
export interface SitemapXmlMetadataEvidence extends SiteMetadataEvidenceBase {
  readonly kind: Extract<SiteMetadataKind, 'SITEMAP_XML'>;
  /**
   * `<loc>` の値を `normalizeUrl` で正規化した値（LZ-3a: 件数で切り詰めない）。
   * 正規化できない値は含めない。
   * 結果が `OK` でない場合と、本文から URL を取り出せなかった場合（根の要素が `<urlset>` でない。sitemap の index を含む）は `null`。
   */
  readonly sitemapUrls: readonly string[] | null;
  /**
   * `sitemapUrls` が、sitemap のすべての `<loc>` を含んでいないか。真の場合、Cross-page rule は `DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。
   * LZ-3a: 件数で切り詰めないので、今はいつも偽（前の記録を読むために残す）。
   */
  readonly sitemapUrlsTruncated: boolean;
}

/** `metadata` の Evidence の payload（Task 14〜17 の設計書 5.6.2）。 */
export type MetadataEvidence = RobotsTxtMetadataEvidence | SitemapXmlMetadataEvidence;

// ---------------------------------------------------------------------------------------------------------------
// Safety（Safety Ledger の事象の記録。Task 12・13 の設計書 5.4.1）
// ---------------------------------------------------------------------------------------------------------------
// 事象の型は、`src/safety/safety-ledger.ts` の `SafetyLedger` が記録する形そのもの。Ledger は、ここの型を import して使い、
// 同じ名前で re-export する。文字列は、Ledger の上限まで切り詰めて記録される。

/**
 * Passive の Guard が、リクエストを遮断した理由の閉じた一覧。
 * - `NON_READ_METHOD`: 読み取り以外のメソッドのリクエスト。
 * - `SERVICE_REQUEST_LIMIT_REACHED`（T35a。Task 35 の設計書 3.4）: 承認したサービスの Origin への要求の上限（1 分あたりか、1 回の Run あたり）を超える
 *   リクエスト（スクリプトで送るログインの監査の段だけ。公開監査とフォームの送信のログインの監査では現れない）。
 * - `SERVICE_ORIGIN_REVISIT`（T35R-fix。Task 35 の設計書の履歴の T35R の行、C-1）: 幅の走査と Interaction の読み込み（`REVISIT` の Context）で、
 *   承認したサービスの Origin へ送ろうとした読み取りのリクエスト（sub frame の文書を含む。API の読み取りは Desktop と Mobile の最初の読み込みだけ）。
 *   スクリプトで送るログインの監査の段だけで現れる。
 * - `PAGE_NAVIGATION_LIMIT_REACHED`（DEF-129）: ページが始めた文書の読み込み（JS の読み込み直しや移動、meta の転送）が、frame ごとの上限
 *   （`src/safety/passive-request-guard.ts` の `PAGE_INITIATED_NAVIGATION_LIMIT_PER_FRAME`）を超えた（Passive の段だけ）。main frame は BeakSight 自身の
 *   読み込みの後から、子の frame（T37R2-fix）はその frame の最初の文書の後から数える。
 * - `PAGE_SUBRESOURCE_LIMIT_REACHED`（DEF-130-fix）: 1 画面の読み込みあたりの、ページが出す文書でない要求（画像・`fetch`・`xhr` など）が、上限
 *   （前は 1,000。L10 で撤廃したので今は止めない）を超えた（Passive の段だけ。数え始めは BeakSight 自身の読み込みか、
 *   その Context の最初の文書）。
 * - `AUDIT_SEND_OVER_LIMIT`（AS-a。設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.2）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、通せる
 *   読み取りでない要求が、その読み込み（Context）で通す数の上限（前は 60。L10 で撤廃したので今は止めない。前の記録を読むために値を残す）を超えた
 *   （その扱いを選んだ Passive の段だけ）。
 * - `PAGE_LEAVE_REQUEST_LIMIT_REACHED`（T44R の I-1。Task 44 の設計書の履歴の「T44R …と設計者の判断」の行）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、
 *   閉じる前にページを離れ始めた後に、ページが出す文書でない要求が 1 回の離れ方あたりの上限（前は 30。L10 で
 *   撤廃した）を超えたか、そのページの文書の読み込み（ページが始めた移動、ポップアップが opener を戻す移動）だった。そのページの読み取りの
 *   判定は、離れる前に終わっている（読み切れない画面にはしない）。
 * - `NOTIFICATION_DISMISSAL_RESTRICTED`（DEF-210。通知の枠の設計書 3.2.1）: 通知の枠の閉じる押下の期間の決まりで止めた（main frame の移動、見るだけの点検の
 *   許可の外の Origin への送信と資格情報つきの送信、操作さがしの凍結の読み取りの決まりに当たらない要求）。判定は `src/safety/request-policy.ts` の
 *   `notificationPressDecisionOf`。
 * - `SCROLL_KEY_PRESS_RESTRICTED`（REV-EV4。設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.4）: 横にスクロールする領域のキーの押下の期間に、
 *   ページが始めた main frame の移動（BeakSight の操作が起こしたものとして止めた。違反にしない）。判定は `scrollKeyPressDecisionOf`。
 */
export const BLOCKED_REQUEST_REASONS = Object.freeze([
  'NON_READ_METHOD',
  'SERVICE_REQUEST_LIMIT_REACHED',
  'SERVICE_ORIGIN_REVISIT',
  'PAGE_NAVIGATION_LIMIT_REACHED',
  'PAGE_SUBRESOURCE_LIMIT_REACHED',
  'AUDIT_SEND_OVER_LIMIT',
  'PAGE_LEAVE_REQUEST_LIMIT_REACHED',
  'NOTIFICATION_DISMISSAL_RESTRICTED',
  'SCROLL_KEY_PRESS_RESTRICTED',
] as const);

/** Passive の Guard が、許可Originの外へのメインフレームの遷移を遮断した理由の閉じた一覧。 */
export const BLOCKED_NAVIGATION_REASONS = Object.freeze(['EXTERNAL_MAIN_FRAME_NAVIGATION'] as const);

/**
 * Passive の Guard が、監査の段の除外（Task 25 の設計書 4.2。除外のパス、読む範囲の外、危険な語）に当たる読み取りの要求を遮断した
 * 理由の閉じた一覧（T25b round 1）。`blockedAuditExclusions` の記録の中だけで使う（ほかの理由の一覧には足さない）。
 */
export const BLOCKED_AUDIT_EXCLUSION_REASONS = Object.freeze(['AUDIT_EXCLUDED_URL'] as const);

/**
 * Worker（Dedicated、Shared）の中で開く WebSocket の接続を、Guard が文書と Worker の script に加える CSP（`connect-src`。
 * `src/safety/passive-request-guard.ts` の `WORKER_CONNECT_POLICY`）で止めたときの理由（DEF-040。DEF-039・DEF-040 の設計書 2.2）。
 * Passive の段階は `blockedWebSockets`、Interaction の凍結の後は `blockedInteractionWebSockets` に残す。止めるのは CSP で決定的だが、
 * 記録は Guard の page の session の `Log.entryAdded`（source `worker`）の観察で、取りこぼしうる（best-effort。Shared Worker の違反は
 * page の session に出ないので、記録されない）。
 */
export const WORKER_CONNECT_POLICY_REASON = 'WORKER_CONNECT_POLICY';

/**
 * Passive の Guard が、WebSocket を遮断した理由の閉じた一覧。
 * - `PASSIVE_WEBSOCKET`: ページの中の WebSocket（Context の `routeWebSocket`）。
 * - `WORKER_CONNECT_POLICY`: Worker の中の WebSocket（CSP。`WORKER_CONNECT_POLICY_REASON`）。
 * - `AUDIT_SEND_OVER_LIMIT`（AS-c）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で通せる接続が、その読み込み（Context）の上限
 *   （前は 10。L10 で撤廃したので今は止めない。前の記録を読むために値を残す）を超えた。
 * - `WEBSOCKET_SEND_QUEUE_FULL`（DEF-276-relay。REV-DEF276 の M-2）: 操作さがしの画面の文書の WebSocket の中継で、ページの送りがサーバへ書き出せずに
 *   たまる量の上限（`WEBSOCKET_RELAY_MAX_SEND_QUEUE_BYTES`）を超えたので、その接続を閉じた。
 */
export const BLOCKED_WEBSOCKET_REASONS = Object.freeze([
  'PASSIVE_WEBSOCKET',
  WORKER_CONNECT_POLICY_REASON,
  'AUDIT_SEND_OVER_LIMIT',
  'WEBSOCKET_SEND_QUEUE_FULL',
] as const);

/** Interaction の凍結中に、ページが起こした通信・遷移・popup・WebSocket を遮断した理由の閉じた一覧。 */
export const INTERACTION_FROZEN_REASONS = Object.freeze(['INTERACTION_FROZEN'] as const);

/**
 * Interaction の Context で、凍結の後に遮断した WebSocket（`blockedInteractionWebSockets`）の理由の閉じた一覧（DEF-040）。
 * - `INTERACTION_FROZEN`: ページの中の WebSocket（Context の `routeWebSocket`）。
 * - `WORKER_CONNECT_POLICY`: Worker の中の WebSocket（CSP。`WORKER_CONNECT_POLICY_REASON`）。
 * popup とナビゲーションの理由は、`INTERACTION_FROZEN_REASONS` のままである。
 */
export const BLOCKED_INTERACTION_WEBSOCKET_REASONS = Object.freeze([
  ...INTERACTION_FROZEN_REASONS,
  WORKER_CONNECT_POLICY_REASON,
] as const);

/**
 * Interaction の Context で、操作中に遮断したリクエスト（`blockedInteractionRequests`）の理由の閉じた一覧
 * （DEF-039・DEF-040 の設計書 2.1.3）。
 * - `INTERACTION_FROZEN`: 凍結の後に、Guard の route と CDP が止めたもの。
 * - `INTERACTION_FROZEN_EGRESS`: 凍結の後に、Interaction の Context の出口の中継（`src/safety/egress-proxy.ts`）が拒んだもの。
 *   Guard を通らずに出た要求の証拠である（ページ自身が閉じるポップアップの送信、Worker の中の WebSocket など）。
 *   CONNECT の `url` は `host:port` の形で、https か wss かは分からない。
 * - `EGRESS_UPSTREAM_DENIED`: 凍結の前に、中継の上流の方針で拒んだもの（production の方針はすべて許すので起きない。テストの方針で起きる）。
 * - `GUARD_BYPASS_EGRESS`（DEF-085）: Passive とログインの段の Context の出口の中継が、要求の方針（Guard の許可を中継から見た範囲。method と
 *   URL）で拒んだもの。Guard が許すはずのない要求が、Guard を通らずに出ようとした証拠である。Passive の Context の記録も、この一覧に置く。
 *   DEF-125 から、中継が CONNECT の受け入れ（Guard が通した要求の宛先だけ）で拒んだ CONNECT も、この理由で記録する（`method` は `CONNECT`、`url` は
 *   `host:port`。Guard の知らせを待った後に拒む。Interaction の Context の中継も同じ）。
 *   Guard が Context を閉じる直前に中継を凍結した後の拒否は、どの理由でも記録しない（DEF-085 fix round 3。閉じる途中の要求は、Guard が許した
 *   普通の要求か、横取りを外れた要求かを中継から区別できないため）。Passive の Context でも、Guard の凍結の段（発見の凍結）の後の中継の拒否は
 *   `INTERACTION_FROZEN_EGRESS` で記録する。
 * 操作中に遮断したナビゲーション（`blockedInteractionNavigations`）の理由は、`INTERACTION_FROZEN_REASONS` のままである。
 */
export const BLOCKED_INTERACTION_REQUEST_REASONS = Object.freeze([
  ...INTERACTION_FROZEN_REASONS,
  'INTERACTION_FROZEN_EGRESS',
  'EGRESS_UPSTREAM_DENIED',
  'GUARD_BYPASS_EGRESS',
] as const);

/**
 * ダウンロードを遮断した理由の閉じた一覧。フェーズを区別する。
 * `PASSIVE_DOWNLOAD` は Passive フェーズ、`INTERACTION_FROZEN` は Interaction の凍結中にページが起こしたもの。
 */
export const BLOCKED_DOWNLOAD_REASONS = Object.freeze(['PASSIVE_DOWNLOAD', ...INTERACTION_FROZEN_REASONS] as const);

/**
 * 外部への作用（外部Origin、`tel:`・`mailto:` などの特殊scheme、ダウンロード）のため、Interaction の候補を実行しなかった理由の
 * 閉じた一覧（CC-014）。Interaction の候補を実行しない理由（`INTERACTION_REJECTION_REASONS`）のうち、
 * `interactionRejectionLedgerRecord` が `BLOCKED_EXTERNAL_ACTION`（`blockedExternalActions` に記録する）とするもの。
 * この一致は `tests/unit/safety-ledger.test.ts` で確かめる。
 */
export const BLOCKED_EXTERNAL_ACTION_REASONS = Object.freeze(
  ['EXTERNAL_ACTION', 'DOWNLOAD'] as const satisfies readonly InteractionRejectionReasonEvidence[],
);
export type BlockedExternalActionReason = (typeof BLOCKED_EXTERNAL_ACTION_REASONS)[number];

/**
 * ページの移動（navigation）のうち、外部スキームへの移動とみなさない URL のスキーム（`URL.protocol` の形。C18a、DEF-012。
 * Task 19 の前の整理の設計書 4.2）。この一覧にないスキームへの navigation のリクエストを、Guard（`passive-request-guard.ts`）が
 * 外部スキームへの移動の試み（`externalSchemeNavigations`）として記録する。記録の事象の意味を決める一覧なので、事象の型と同じ
 * ここに1か所だけ置く。Passive HTTP の許可Originの判定（`request-policy.ts`）とは別の判断である。
 */
export const NON_EXTERNAL_NAVIGATION_SCHEMES = Object.freeze(['http:', 'https:', 'about:', 'data:', 'blob:'] as const);

/**
 * EL-F（EL-R の I2。設計書 `2026-10-24-beaksight-external-launch-block-design.md`）: 外部スキームとみなさない、Chromium に組み込みの拡張の ID の閉じた一覧。
 * PDF の頁（main frame・iframe・embed）を開くと、Chromium は組み込みの PDF の表示の拡張の frame（`chrome-extension://<この ID>/index.html`）を作る。これは
 * OS の外部のアプリへ渡らない、Chromium の中の頁なので、外部スキームへの移動の試みにしない（前は違反になり、PDF の頁で Run が止まった）。ほかの
 * `chrome-extension:` の URL は、今どおり外部スキームとする。
 */
export const CHROMIUM_PDF_VIEWER_EXTENSION_ID = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';
export const NON_EXTERNAL_CHROMIUM_EXTENSION_IDS = Object.freeze([CHROMIUM_PDF_VIEWER_EXTENSION_ID] as const);
/** Chromium の拡張の URL のスキーム（`URL.protocol` の形）。 */
export const CHROMIUM_EXTENSION_PROTOCOL = 'chrome-extension:';

/**
 * 外部スキームへの移動の試みを記録した理由の閉じた一覧（C18a、C18g）。
 * - `EXTERNAL_SCHEME_NAVIGATION`: ページのスクリプトなどによる移動の試み。外部スキームはネットワークを通らないので、Guard は
 *   止められない。headed と headless を問わず、記録し、不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）も記録する。
 * - `EXTERNAL_SCHEME_REDIRECT_BLOCKED`: サーバのリダイレクト（3xx の `Location` が外部スキーム）。Guard が Document の応答の
 *   段階で、リダイレクトをたどる前にリクエストを失敗させた（止めた）もの。止めて防げるので、headed と headless を問わず
 *   違反にしない（Task 19 の前の整理の設計書 4.2、4.2.1。中断した Run の再開の設計書 4.10）。
 */
export const EXTERNAL_SCHEME_NAVIGATION_REASONS = Object.freeze([
  'EXTERNAL_SCHEME_NAVIGATION',
  'EXTERNAL_SCHEME_REDIRECT_BLOCKED',
] as const);

/** 外部スキームへの移動を試みた frame の種類の閉じた一覧（`MAIN` は main frame、`SUB` は subframe。C18a）。 */
export const EXTERNAL_SCHEME_NAVIGATION_FRAMES = Object.freeze(['MAIN', 'SUB'] as const);

/**
 * 外部スキームへの移動を観測した Guard の段階の閉じた一覧（C18a）。`PASSIVE` は Interaction の凍結の前、`INTERACTION` は凍結の後。
 * Evidence の `scope`（Safety Ledger の種類）とは別の値である。Interaction の Context でも、凍結の前（読み込みの間）は `PASSIVE` になる。
 */
export const EXTERNAL_SCHEME_NAVIGATION_PHASES = Object.freeze(['PASSIVE', 'INTERACTION'] as const);

/** Safety の Evidence のもとになった Safety Ledger の種類（Passive の Context か、Isolated Interaction Context か）の閉じた一覧。 */
export const SAFETY_EVIDENCE_SCOPES = Object.freeze(['PASSIVE', 'INTERACTION'] as const);
export type SafetyEvidenceScope = (typeof SAFETY_EVIDENCE_SCOPES)[number];

/**
 * BN-a（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1）: Guard が止めた事象の時点の閉じた一覧。
 * - `LOAD`: その Context の読み込みの間（ページの監査では、測りの前と最中）。
 * - `CLOSING`: 閉じる途中（Guard の段階が閉じる途中・無効化・閉じた後）か、BeakSight が閉じる前にページを離れ始めた後（`announcePageLeave`）。
 * 外部スキームへの移動の記録の `phase`（`EXTERNAL_SCHEME_NAVIGATION_PHASES`。凍結の前と後）とは別の値である。
 */
export const BLOCKED_EVENT_PHASES = Object.freeze(['LOAD', 'CLOSING'] as const);
export type BlockedEventPhase = (typeof BLOCKED_EVENT_PHASES)[number];

/**
 * BN-a: page.json（`schemas/page.schema.json`）の版。`page-schema/1.1` から、止めた事象の時点（`phase`）と要求の種類（`resourceType`）、閉じる途中に止めた
 * 要求（`blockedClosingRequests`）、network の失敗の印（`blockedByBeakSight`・`phase`）、safety の Evidence の読み込みの印（`load`）を持つ。書くのは、いつも最新の版。
 * LG-4（テストの組の設計書 3.7.3、3.7.5）: 印のない `page-schema/1.0` と、その読み替えの口は捨てた（前の版の page.json を持つ保存は読まない）。
 */
export const PAGE_SCHEMA_VERSION = 'page-schema/1.1';
/**
 * REC-3: ディスクに書く page.json（と保存のページの `result`）の版。メモリの形（`page-schema/1.1`）の、同じ形の繰り返しを短くした形
 * （`src/core/page-record-codec.ts`）。書くときに 2.0 にし、読むときに 1.1 の形に戻す。
 */
export const PAGE_RECORD_SCHEMA_VERSION = 'page-schema/2.0';
/** BN-a: スキーマが受ける page の版（スキーマの `schemaVersion` の値と同じ。メモリの形の 1.1 と、ディスクの形の 2.0）。 */
export const PAGE_READABLE_SCHEMA_VERSIONS = Object.freeze([PAGE_SCHEMA_VERSION, PAGE_RECORD_SCHEMA_VERSION] as const);
/** メモリの形（`PageAuditResult`）の版。 */
export type PageSchemaVersion = typeof PAGE_SCHEMA_VERSION;

/**
 * BN-a: 要求を止めた事象（止めた要求・止めた移動・止めた WebSocket・監査の段の除外）が持つ時点（`phase`）。必須（LG-4: 時点のない前の版の記録は読まない）。
 */
export interface BlockedEventPhaseFact {
  readonly phase: BlockedEventPhase;
}

/**
 * Guard が止めた要求。BN-a: `resourceType` は、Guard の記録の口の要求の種類（`src/safety/request-policy.ts` の `requestResourceTypeOf` で正規化した値。
 * 閉じた一覧 `REQUEST_RESOURCE_TYPES` の値）。必須。
 */
export interface BlockedRequestEvent extends BlockedEventPhaseFact {
  readonly method: string;
  readonly url: string;
  readonly reason: (typeof BLOCKED_REQUEST_REASONS)[number];
  readonly resourceType: string;
  /**
   * BN-R1 の M-2: 先読み（prefetch・prerender）の要求の印（要求の `Sec-Purpose`・`Purpose` に `prefetch` を含む。`src/safety/request-policy.ts` の
   * `isSpeculativeRequestHeaders`）。先読みの要求のときだけ `true` を持つ（ない項目は、先読みでない要求か、前の版の記録）。区分の側は、この印の記録を
   * 見えない種類として扱う（影響の可能性の元にしない）。
   */
  readonly speculative?: true;
}

export interface BlockedNavigationEvent extends BlockedEventPhaseFact {
  readonly method: string;
  readonly url: string;
  readonly reason: (typeof BLOCKED_NAVIGATION_REASONS)[number];
}

export interface BlockedWebSocketEvent extends BlockedEventPhaseFact {
  readonly url: string;
  readonly reason: (typeof BLOCKED_WEBSOCKET_REASONS)[number];
}

/**
 * BN-a（設計書 3.1 の 2）: Guard が、Context を閉じる途中（段階が閉じる途中・無効化・閉じた後か、持ち主が閉じ始めた page）に止めた要求の 1 件。止め方は今までどおり
 * （記録を足しただけ）。判定の理由はない（閉じる途中の要求は、判定せずに止める）。時点は、いつも `CLOSING`。
 */
export interface BlockedClosingRequestEvent {
  readonly method: string;
  readonly url: string;
  readonly resourceType: string;
  readonly phase: Extract<BlockedEventPhase, 'CLOSING'>;
  /** BN-R1 の M-2: 先読みの要求の印（`BlockedRequestEvent.speculative` と同じ。先読みのときだけ）。 */
  readonly speculative?: true;
}

/**
 * BN-a: 閉じる途中に止めた要求の記録（`SafetyEventsEvidence.blockedClosingRequests`）。1 件でも止めた Ledger の記録にだけ現れる。
 * - `count`: 止めた要求の数（`events` の上限を超えた分と、要求の method・URL を読めなかった分も数える。飽和）。
 * - `events`: 記録できた要求（上限は Ledger の事象の上限。超えた分は `recordLimits.droppedEventCount` に数え、`reachedCategories` に分類を残す）。
 * `count` は正しく数えるので、この記録だけが上限を超えても `recordLimits.truncated` にしない（監査の段の除外の記録と同じ。Run を PARTIAL にしない）。
 * 止めた要求の数（`blockedRequestsByMethod`）・止めた要求の一覧（`blockedRequests`）・SAFETY の Finding には入れない（閉じる途中の要求は、測りの後のもの）。
 */
export interface BlockedClosingRequestsRecord {
  readonly count: number;
  readonly events: readonly BlockedClosingRequestEvent[];
}

/**
 * SAFE-2 の 4（違反の区分の (3)。設計者の判断）: Guard が移動の frame の種類（main frame か、子の frame か）を判定できなかった 1 件（前は違反
 * `FRAME_CLASSIFICATION_FAILED`）。ブラウザが止めていて、外へは何も渡っていないので、違反にせず、Context も閉じない。
 * - `url`: 移動の先の URL（認証情報は伏せ字にし、Ledger の上限の長さまで切り詰める。外部スキームの URL のこともある）。
 * - `phase`: Interaction の凍結の前（`PASSIVE`）か後（`INTERACTION`）か（`EXTERNAL_SCHEME_NAVIGATION_PHASES` と同じ値）。
 */
export interface FrameClassificationFailureEvent {
  readonly url: string;
  readonly phase: (typeof EXTERNAL_SCHEME_NAVIGATION_PHASES)[number];
}

/**
 * SAFE-2 の 4: frame の判定の失敗の記録（`SafetyEventsEvidence.frameClassificationFailures`）。1 件でもあった Ledger の記録にだけ現れる。`count` は、記録の上限を
 * 超えた分も数える（飽和）。`events` の上限は Ledger の事象の上限（超えた分は `recordLimits.droppedEventCount` に数えるが、`truncated` にはしない）。SAFETY の
 * Finding（違反の指摘）にはしない（止めた記録として数に出す）。
 */
export interface FrameClassificationFailuresRecord {
  readonly count: number;
  readonly events: readonly FrameClassificationFailureEvent[];
}

/**
 * SAFE-2 の 4（DEF-145 のとおり、届いたか分からない読み取り）: 許した読み取り（GET・HEAD）の main frame の移動の配送が失敗した 1 件（前は違反
 * `HTTP_MAIN_FRAME_DELIVERY_FAILED`。読み取りでない method の失敗は、今どおり違反）。読み取りなので、届いても届かなくても安全の決まりに反しない。
 * - `method`: 要求の method（`GET`・`HEAD`）。
 * - `url`: 要求の URL の Origin と path（query・fragment・値は持たない。Origin を作れない URL は空）。
 * - `errorText`: 失敗の理由（Chromium のエラーの文。上限の長さまで切り詰める）。
 * - `phase`: Interaction の凍結の前（`PASSIVE`）か後（`INTERACTION`）か。
 */
export interface ReadNavigationFailureEvent {
  readonly method: string;
  readonly url: string;
  readonly errorText: string;
  readonly phase: (typeof EXTERNAL_SCHEME_NAVIGATION_PHASES)[number];
}

/** SAFE-2 の 4: 読み取りの main frame の移動の失敗の記録（`SafetyEventsEvidence.readNavigationFailures`。形と数え方は `FrameClassificationFailuresRecord` と同じ）。 */
export interface ReadNavigationFailuresRecord {
  readonly count: number;
  readonly events: readonly ReadNavigationFailureEvent[];
}

/**
 * 監査の段の除外で遮断した読み取りの要求（T25b round 1。Task 25 の設計書 4.2）。値や本文は持たない。
 * - `method`、`url`: 要求の method と URL（ほかの要求の記録と同じく、Ledger の上限の長さまで切り詰める）。
 * - `mainFrameNavigation`: main frame のナビゲーションか（偽は、サブの frame の要求と、ナビゲーションでない要求）。
 */
export interface BlockedAuditExclusionEvent extends BlockedEventPhaseFact {
  readonly method: string;
  readonly url: string;
  readonly mainFrameNavigation: boolean;
  readonly reason: (typeof BLOCKED_AUDIT_EXCLUSION_REASONS)[number];
  /** BN-a: 要求の種類（`BlockedRequestEvent.resourceType` と同じ）。 */
  readonly resourceType: string;
  /** BN-R1 の M-2: 先読みの要求の印（`BlockedRequestEvent.speculative` と同じ）。 */
  readonly speculative?: true;
}

/**
 * 監査の段の除外の記録（`SafetyEventsEvidence.blockedAuditExclusions`。T25b round 1）。
 * - `count`: 遮断した要求の件数。`events` の記録の上限を超えた分も数える（安全な整数の上限で止める）。
 * - `events`: 記録できた事象（上限を超えた分は、`recordLimits` の `droppedEventCount` に数え、`reachedCategories` に分類を残す）。
 * この記録は、設定どおりに止めた記録で、`count` は正しく数えるので、この記録だけが上限を超えても、`recordLimits.truncated` にしない
 * （Run を PARTIAL にしない。T25c）。
 */
export interface BlockedAuditExclusionsRecord {
  readonly count: number;
  readonly events: readonly BlockedAuditExclusionEvent[];
}

/** 外部への作用（外部Origin、`tel:`・`mailto:` などの特殊scheme、ダウンロード）のため実行しなかった Interaction の候補。 */
export interface BlockedExternalActionEvent {
  readonly candidateId: string;
  readonly url: string | null;
  readonly reason: BlockedExternalActionReason;
}

/**
 * 安全のため機械的に除外した Interaction 候補（設計書 2026-09-23 4.6）。外部への作用ではないので、
 * `blockedExternalActions` とは別に記録する。どの除外理由をここに残すかは `interactionRejectionLedgerRecord` が決める。
 */
export interface ExcludedInteractionCandidateEvent {
  readonly candidateId: string;
  readonly reason: InteractionRejectionReasonEvidence;
}

/**
 * 操作中に遮断したリクエスト。理由は `BLOCKED_INTERACTION_REQUEST_REASONS`（Guard が止めたものと、出口の中継が拒んだものを区別する）。
 * DEF-085 から、中継の要求の方針で拒んだ要求（`GUARD_BYPASS_EGRESS`）と、凍結の段の後の中継の拒否（`INTERACTION_FROZEN_EGRESS`）は、Passive の
 * Context の Ledger にも残る。
 */
export interface BlockedInteractionRequestEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: (typeof BLOCKED_INTERACTION_REQUEST_REASONS)[number];
  /**
   * DEF-215: 中継が CONNECT の受け入れ（DEF-125）で拒んだ、要求の前の接続（Guard が通した要求がまだない宛先へ、Chromium が先に張ろうとした接続）の印。
   * 拒んだトンネルには何も流れていない（要求は送られていない）ので、読み取り以外の送信の遮断（`SAFETY_NON_READ_REQUEST_BLOCKED`）には数えない。拒否の動き
   * そのものと、記録（`method` は `CONNECT`、`url` は `host:port`、理由は `GUARD_BYPASS_EGRESS`）は変えない。ほかの記録には付けない（任意の項目）。
   */
  readonly preRequestConnection?: true;
}

/** 操作中に遮断したナビゲーション。理由は `INTERACTION_FROZEN_REASONS` のまま（リクエストとは別の型。DEF-039・DEF-040 の設計書 2.1.3）。 */
export interface BlockedInteractionNavigationEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: (typeof INTERACTION_FROZEN_REASONS)[number];
}

/**
 * ポップアップを止めた理由の閉じた一覧。
 * - `INTERACTION_FROZEN`: Interaction の凍結中に開いたポップアップ。
 * - `NOTIFICATION_DISMISSAL_RESTRICTED`（fix round 3。通知の枠の設計書 3.2.2 の 4）: 通知の枠の閉じる押下の期間に開いたポップアップ（Guard が閉じる）。
 * - `SCROLL_KEY_PRESS_RESTRICTED`（REV-EV4）: 横にスクロールする領域のキーの押下の期間に開いたポップアップ（Guard が閉じる。違反にしない）。
 */
export const BLOCKED_POPUP_REASONS = Object.freeze([
  ...INTERACTION_FROZEN_REASONS, 'NOTIFICATION_DISMISSAL_RESTRICTED', 'SCROLL_KEY_PRESS_RESTRICTED',
] as const);

export interface BlockedPopupEvent {
  readonly url: string;
  readonly reason: (typeof BLOCKED_POPUP_REASONS)[number];
}

/** ブロックしたダウンロード。`reason` でフェーズを区別する（`BLOCKED_DOWNLOAD_REASONS`）。 */
export interface BlockedDownloadEvent {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly reason: (typeof BLOCKED_DOWNLOAD_REASONS)[number];
}

/** 凍結の後に遮断した WebSocket。理由は `BLOCKED_INTERACTION_WEBSOCKET_REASONS`（ページの中のものと、Worker の中のものを区別する）。 */
export interface BlockedInteractionWebSocketEvent {
  readonly url: string;
  readonly reason: (typeof BLOCKED_INTERACTION_WEBSOCKET_REASONS)[number];
}

/**
 * 外部スキーム（`NON_EXTERNAL_NAVIGATION_SCHEMES` にないスキーム）への移動の試み（C18a、DEF-012。中断した Run の再開の設計書
 * 4.10）。どの経路かは `reason` で区別する（`EXTERNAL_SCHEME_NAVIGATION_REASONS`）。
 * - ページのスクリプトなどによる移動（`EXTERNAL_SCHEME_NAVIGATION`）: 外部スキームはネットワークを通らないので、Guard は
 *   止められない。headed と headless を問わず、起きたことを記録し、不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）も
 *   記録する。
 * - サーバのリダイレクト（`EXTERNAL_SCHEME_REDIRECT_BLOCKED`。C18g）: Guard が、リダイレクトをたどる前に止めた。止めて防げるので、
 *   headed と headless を問わず違反にしない。
 * - `url`: 移動の先の URL（リダイレクトでは、`Location` を元のリクエストの URL を基準に解決した URL）。認証情報は伏せ字にし
 *   （`redactUrlCredentials`）、Ledger の上限の長さまで切り詰める。
 * - `scheme`: URL のスキーム（末尾の `:` を除いた形。例: `tel`、`mailto`）。
 */
export interface ExternalSchemeNavigationEvent {
  readonly url: string;
  readonly scheme: string;
  readonly frame: (typeof EXTERNAL_SCHEME_NAVIGATION_FRAMES)[number];
  readonly phase: (typeof EXTERNAL_SCHEME_NAVIGATION_PHASES)[number];
  readonly reason: (typeof EXTERNAL_SCHEME_NAVIGATION_REASONS)[number];
}

/**
 * Safety Ledger の記録が上限でどれだけ不完全になったか。安全不変条件の違反ではない。
 * `truncated` の Run は `PARTIAL` にする（`RunStatusInput.safetyLedgerTruncated`）。
 */
export interface SafetyLedgerRecordLimits {
  /**
   * 上限のために、記録しなかったイベントか、数えられなかったブロックがあるか。監査の段の除外の記録（`blockedAuditExclusions`）だけが上限を
   * 超えた場合は、件数が正しく残るので、真にしない（T25c）。
   */
  readonly truncated: boolean;
  /** 上限のために記録しなかったイベントの件数（違反と、監査の段の除外の記録を含む）。 */
  readonly droppedEventCount: number;
  /** 上限のために `blockedRequestsByMethod` で数えられなかったブロックの件数。 */
  readonly uncountedBlockedRequestCount: number;
  /** 前は、上限の長さまで切り詰めて記録した文字列の件数。LZ-2 で切り詰めなくなったので、いつも 0（前の記録の形のために残す）。 */
  readonly truncatedTextCount: number;
  /** 上限に達した記録の分類（各1回、到達順）。 */
  readonly reachedCategories: readonly string[];
}

/**
 * safety の Evidence の payload（Task 12・13 の設計書 5.4.1）。Safety Ledger 1つの snapshot のうち、ページの事象の記録と
 * 記録の上限の情報を持つ。不変条件の違反は持たない（違反は Finding にせず、Run Status で扱う）。
 * `src/safety/safety-ledger.ts` の `SafetyLedgerSnapshot` は、この型から `scope` を除き、違反の項目を加えた型。
 * snapshot から作るには `safetyEventsEvidenceFromSnapshot`（`src/safety/safety-ledger.ts`）を使う。
 */
export interface SafetyEventsEvidence {
  readonly scope: SafetyEvidenceScope;
  /**
   * BN-a（設計書 3.1 の 4）: この Ledger の読み込みの種類（ページの監査、幅の走査の幅、Interaction の候補の番号）。Safety Ledger の snapshot には持たない。
   */
  readonly load: SafetyEvidenceLoad;
  /**
   * メソッドごとの、遮断した読み取り以外のリクエストの件数。`blockedRequests` の記録の上限を超えた分も数える
   * （メソッドの種類や件数の上限で数えられなかった分は `recordLimits.uncountedBlockedRequestCount`）。
   */
  readonly blockedRequestsByMethod: Readonly<Record<string, number>>;
  readonly blockedRequests: readonly BlockedRequestEvent[];
  readonly blockedNavigations: readonly BlockedNavigationEvent[];
  readonly blockedWebSockets: readonly BlockedWebSocketEvent[];
  readonly blockedExternalActions: readonly BlockedExternalActionEvent[];
  readonly excludedInteractionCandidates: readonly ExcludedInteractionCandidateEvent[];
  readonly blockedInteractionRequests: readonly BlockedInteractionRequestEvent[];
  readonly blockedInteractionNavigations: readonly BlockedInteractionNavigationEvent[];
  readonly blockedPopups: readonly BlockedPopupEvent[];
  readonly blockedDownloads: readonly BlockedDownloadEvent[];
  readonly blockedInteractionWebSockets: readonly BlockedInteractionWebSocketEvent[];
  /** 外部スキームへの移動の試み（C18a）。 */
  readonly externalSchemeNavigations: readonly ExternalSchemeNavigationEvent[];
  readonly recordLimits: SafetyLedgerRecordLimits;
  /**
   * 監査の段の除外で遮断した要求（T25b round 1。Task 25 の設計書 4.2）。省略できる項目で、1 件でも記録した Ledger の記録にだけ現れる
   * （除外の口を渡さない公開監査の出力には現れない）。事象の一覧（配列）ではないので、`SAFETY_EVENT_KINDS` には含めない
   * （表示は、この Task では変えない）。
   */
  readonly blockedAuditExclusions?: BlockedAuditExclusionsRecord;
  /**
   * AS-a・AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.3）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、Guard が通した読み取りでない要求の
   * 記録（method・Origin・path・回数だけ。値は持たない）。1 件でも通した Ledger の記録にだけ現れる（今の出力は変えない）。事象の一覧（配列）ではないので、
   * `SAFETY_EVENT_KINDS` には含めない。
   */
  readonly passedAuditSendRequests?: PassedAuditSendRequestsRecord;
  /**
   * AS-c（設計書 5 章の「ユーザーの言葉と選択（AS-c）」の行）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` で、Guard が通した WebSocket の接続の記録（Origin・
   * path・数だけ。query・接続の上の送受信・値は持たない）。1 本でも通した Ledger の記録にだけ現れる。
   */
  readonly passedAuditSendWebSockets?: PassedAuditSendWebSocketsRecord;
  /**
   * BN-a（設計書 3.1 の 2）: Context を閉じる途中に Guard が止めた要求の記録（`BlockedClosingRequestsRecord`）。1 件でも止めた Ledger の記録にだけ現れる。
   * 事象の一覧（配列）ではないので、`SAFETY_EVENT_KINDS` には含めない（SAFETY の Finding にしない）。
   */
  readonly blockedClosingRequests?: BlockedClosingRequestsRecord;
  /** SAFE-2 の 4: frame の判定の失敗の記録（1 件でもあった Ledger の記録にだけ現れる。SAFETY の Finding にしない）。 */
  readonly frameClassificationFailures?: FrameClassificationFailuresRecord;
  /** SAFE-2 の 4: 読み取りの main frame の移動の失敗の記録（1 件でもあった Ledger の記録にだけ現れる。SAFETY の Finding にしない）。 */
  readonly readNavigationFailures?: ReadNavigationFailuresRecord;
}

/**
 * BN-a（設計書 3.1 の 4）: safety の Evidence のもとになった読み込みの種類の閉じた一覧。
 * - `PAGE_AUDIT`: ページの監査の読み込み（Desktop と Mobile の Passive の Context）。
 * - `STRESS_WIDTH`: 幅の走査の 1 つの幅の読み込み（`width` は、その幅の CSS px）。
 * - `INTERACTION`: Interaction の 1 つの候補の隔離した読み込み（`candidateIndex` は、候補の発見の順の番号で 0 から）。
 */
export const SAFETY_EVIDENCE_LOAD_KINDS = Object.freeze(['PAGE_AUDIT', 'STRESS_WIDTH', 'INTERACTION'] as const);
export type SafetyEvidenceLoadKind = (typeof SAFETY_EVIDENCE_LOAD_KINDS)[number];

/** BN-a: safety の Evidence の読み込みの印。 */
export type SafetyEvidenceLoad =
  | { readonly kind: Extract<SafetyEvidenceLoadKind, 'PAGE_AUDIT'> }
  | { readonly kind: Extract<SafetyEvidenceLoadKind, 'STRESS_WIDTH'>; readonly width: number }
  | { readonly kind: Extract<SafetyEvidenceLoadKind, 'INTERACTION'>; readonly candidateIndex: number };

/** AS-c: 通した WebSocket の接続の 1 行（Origin・path・数）。 */
export interface PassedAuditSendWebSocket {
  /** `ws:`・`wss:` の Origin（`URL.origin`）。 */
  readonly origin: string;
  /** `/` で始まる path（値に見える区切りは伏せ、上限の長さで切ってある）。 */
  readonly path: string;
  /** 通した数（1 以上。飽和）。 */
  readonly count: number;
  /**
   * AS-c fix round 1（C-1・C-2）: Guard の route を通らずに開いた接続（ページのスクリプトが Playwright の WebSocket の模擬を迂回した接続、Worker の中の接続）の
   * 行の印。印のない行と別の行に数える。
   */
  readonly outsideGuard?: true;
  /** AS-c fix round 1: 危険な語（か監査の段の除外）に当たる接続の行の印（Guard の route なら止めた接続）。印のない行と別の行に数える。 */
  readonly dangerous?: true;
}

/**
 * AS-c: 通した WebSocket の接続の記録（数は、一覧に入れなかった分も数える）。AS-c fix round 1 から、ブラウザが実際に開いた接続（CDP の事象）から作る
 * （Guard の route が通した数ではない）。
 */
export interface PassedAuditSendWebSocketsRecord {
  /** 開いた接続の総数（飽和）。 */
  readonly count: number;
  /** 同じ Origin・path・印を重ねた一覧（上限は Ledger の事象の上限。記録した順）。 */
  readonly connections: readonly PassedAuditSendWebSocket[];
  /** 一覧に入れなかった接続の数（上限を超えた新しい行と、Origin を作れない URL。飽和）。 */
  readonly unlisted: number;
  /** AS-c fix round 1: そのうち Guard の route を通らずに開いた接続の数（飽和。一覧に入れなかった分も数える）。 */
  readonly outsideGuard: number;
  /** AS-c fix round 1: そのうち危険な語に当たる接続の数（飽和。一覧に入れなかった分も数える）。 */
  readonly dangerous: number;
}

/** AS-a: 通した読み取りでない要求の 1 行（method・Origin・path・回数。query・fragment・本文・値は持たない）。 */
export interface PassedAuditSendRequest {
  readonly method: string;
  /** HTTP(S) の Origin の正規の直列化。 */
  readonly origin: string;
  /** `/` で始まる path（値に見える区切りは伏せ、上限の長さで切ってある）。 */
  readonly path: string;
  /** 通した回数（1 以上。飽和）。 */
  readonly count: number;
}

/** AS-a: 通した読み取りでない要求の記録（件数は、一覧に入れなかった分も数える）。 */
export interface PassedAuditSendRequestsRecord {
  /** 通した要求の総数（飽和）。 */
  readonly count: number;
  /** method ごとの通した数（`blockedRequestsByMethod` と同じ上限の部品で数える）。 */
  readonly byMethod: Readonly<Record<string, number>>;
  /** 同じ method・Origin・path を重ねた一覧（上限は Ledger の事象の上限。記録した順）。 */
  readonly requests: readonly PassedAuditSendRequest[];
  /** 一覧に入れなかった、通した要求の数（上限を超えた新しい行と、Origin を作れない URL。飽和）。 */
  readonly unlisted: number;
  /**
   * AS-c: 通した要求のうち、許可 Origin と承認したサービスの Origin のほか（ほかの Origin）へのものの数（飽和）。
   */
  readonly otherOrigins: number;
}

/**
 * Safety の事象の記録の種類の閉じた一覧（Task 14〜17 の設計書 6.1.10）。`SafetyEventsEvidence` の、事象の一覧（配列）の項目の名前で、
 * 並びは `SafetyEventsEvidence` の項目の順と同じにする（順は `tests/unit/core-contracts.test.ts` で、空の Safety Ledger から作った
 * 記録と比べて確かめる）。表示のラベルと順は、表示カタログ（`SAFETY_EVENT_KIND_CATALOG`）が持つ。
 * 書き漏れと余分は、下の `SafetyEventKindsMatchEvidence` が型のエラーにする。
 */
export const SAFETY_EVENT_KINDS = Object.freeze([
  'blockedRequests',
  'blockedNavigations',
  'blockedWebSockets',
  'blockedExternalActions',
  'excludedInteractionCandidates',
  'blockedInteractionRequests',
  'blockedInteractionNavigations',
  'blockedPopups',
  'blockedDownloads',
  'blockedInteractionWebSockets',
  'externalSchemeNavigations',
] as const);
export type SafetyEventKind = (typeof SAFETY_EVENT_KINDS)[number];

/** `SafetyEventsEvidence` の、事象の一覧（配列）の項目の鍵（型の上で導いたもの。`SAFETY_EVENT_KINDS` の検査だけに使う）。 */
type SafetyEventListKey = {
  readonly [TKey in keyof SafetyEventsEvidence]-?: SafetyEventsEvidence[TKey] extends readonly unknown[] ? TKey : never;
}[keyof SafetyEventsEvidence];

/** 2つの型が互いに等しいときだけ `true` になる型。 */
type IsSameType<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2 ? true : false;

/** 型の引数が `true` でなければ、型のエラーになる。 */
type AssertTrue<TCondition extends true> = TCondition;

/**
 * `SAFETY_EVENT_KINDS` の要素の型と、`SafetyEventsEvidence` の事象の一覧の項目の鍵の型が、互いに等しいことの検査。
 * core の Evidence に事象の一覧を加えたり消したりして、`SAFETY_EVENT_KINDS` を直し忘れると、ここが型のエラーになる
 * （検査のためだけの型なので、export しない）。
 */
type SafetyEventKindsMatchEvidence = AssertTrue<IsSameType<SafetyEventKind, SafetyEventListKey>>;

// ---------------------------------------------------------------------------------------------------------------
// ナビゲーションの結果と sitemap（Cross-page rule の入力。Task 12・13 の設計書 第7章、Task 14〜17 の設計書 4.3.0）
// ---------------------------------------------------------------------------------------------------------------

/**
 * ページとビューポートごとの、ナビゲーションの結果の種類の閉じた一覧（Task 14〜17 の設計書 4.3.0）。
 * `BLOCKED_EXTERNAL_REDIRECT` は、メインフレームのナビゲーションが Guard の `EXTERNAL_MAIN_FRAME_NAVIGATION` で遮断され、
 * その遮断によってナビゲーションが失敗したことを表す。
 */
export const NAVIGATION_OUTCOME_KINDS = Object.freeze(['OK', 'TIMEOUT', 'FAILED', 'BLOCKED_EXTERNAL_REDIRECT'] as const);
export type NavigationOutcomeKind = (typeof NAVIGATION_OUTCOME_KINDS)[number];

/**
 * Cross-page rule に渡す sitemap の Evidence。`urls` は sitemap の `<loc>` の値を正規化した値（`sitemapUrls` の写し）。
 * sitemap.xml の `metadata` の Evidence から、`sitemapEvidenceFromMetadata`（`src/crawl/sitemap-evidence.ts`）で作る。
 */
export interface SitemapEvidence {
  /** sitemap を記録した Evidence の ID。sitemap の Finding は、これを参照する。 */
  readonly evidenceId: EvidenceId;
  readonly urls: readonly string[];
  /**
   * `urls` を上限で切り詰めたか（Task 12・13 の設計書 第7章、Task 14〜17 の設計書 5.6.2）。真の場合、sitemap にないとは言えないので、
   * `DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。
   */
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------------------------------------------
// 実効の設定（run.json）
// ---------------------------------------------------------------------------------------------------------------

/** ビューポートの大きさ（CSSピクセル）。`src/config/types.ts` の `Viewport` は、この型の別名。 */
export interface ViewportSizeEvidence {
  /** 正の整数（設定の検証で確かめる）。 */
  readonly width: number;
  /** 正の整数（設定の検証で確かめる）。 */
  readonly height: number;
}

/** 実行に使った、確定後の設定。`src/config/types.ts` の `AuditConfig` は、この型の別名。 */
export interface EffectiveAuditConfig {
  /** 監査対象の設定の識別子。`config/targets/` 配下で一意（Finding の fingerprint や報告に使う）。 */
  readonly target: {
    readonly id: string;
  };
  readonly site: {
    readonly startUrl: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly crawl: {
    /** L14 の後の段: ページの数の上限。利用者が指定したときだけ持つ（ないときは上限なし）。 */
    readonly maxPages?: number;
    /**
     * L14（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L14）: リンクをたどる深さの上限。利用者が指定したときだけ持つ（ないときは上限なし）。
     * 以下の `?` の項目も同じく、利用者が指定したときだけ効く（既定の値を持たない）。
     */
    readonly maxDepth?: number;
    /**
     * 1 回の起動の時間の上限。正の整数（ミリ秒。Task 14〜17 の設計書 4.5.7）。L14 の後の段: 利用者が指定したときだけ持つ（ないときは期限なし。
     * 進みの見張りで待つ）。
     */
    readonly maxRuntimeMs?: number;
    /** 正の整数（ミリ秒）。L14: ないときは期限なし（進みの見張りで待つ）。 */
    readonly navigationTimeoutMs?: number;
    /** 正の整数（ミリ秒）。L1 から使わない（前の記録・設定の読み方のために残す）。 */
    readonly overallPageTimeoutMs?: number;
    /** 正の整数（ミリ秒）。L1 から使わない（前の記録・設定の読み方のために残す）。 */
    readonly resourceSettlingTimeoutMs?: number;
    /** 正の整数（ミリ秒）。L14: ないときは Interaction の部品の中の期限（L5 で撤廃）。 */
    readonly interactionTimeoutMs?: number;
    /**
     * ページの読み込みの最小の間隔。0 以上の整数（ミリ秒。サイトへの負荷の制御の設計書 3.2、4.2）。
     * 許可 Origin にループバックでないものがあれば、`src/config/validate-config.ts` の下限以上でなければならない。
     */
    readonly minNavigationIntervalMs: number;
    /**
     * 1つのページで Interaction で監査する候補の数の上限（利用者が指定したときだけ）。1 以上の整数（サイトへの負荷の制御の設計書 3.2、4.2）。
     * L14: ないときは上限なし。L10: 候補の数の上限（前は 100）と比べる確かめは撤廃した。
     */
    readonly maxInteractionsPerPage?: number;
    readonly allowedQueryParameters: readonly string[];
  };
  readonly browser: {
    readonly headed: boolean;
    readonly locale: string;
    readonly timezone: string;
  };
  readonly viewports: {
    readonly primaryDesktop: ViewportSizeEvidence;
    readonly primaryMobile: ViewportSizeEvidence;
    /** 負荷を確かめる幅（CSSピクセル）。それぞれ正の整数。 */
    readonly stressWidths: readonly number[];
  };
  readonly audit: {
    readonly performance: boolean;
    readonly accessibility: boolean;
    readonly interactions: boolean;
    readonly screenshots: boolean;
    /**
     * AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: 監査の段の送信の扱い（値の一覧は `src/core/audit-send-policy.ts`）。設定を読んだ
     * 値（`loadConfig`）は既定を合わせて必ず持つ。項目のない値（AS-b の前の保存・`run.json`）は `READ_ONLY` と読む（`auditSendPolicyOf`）。
     */
    readonly sendPolicy?: AuditSendPolicyName;
  };
  readonly output: {
    readonly directory: string;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// セッションの切れの証拠（DEF-138。設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 2.1）
// ---------------------------------------------------------------------------------------------------------------
// セッションの切れを判定した読み込み 1 回の記録の形の唯一の定義。作るのは `src/orchestration/authenticated-run.ts` の `sessionLossEvidenceOf` だけ。
// `run.json` の `authentication.sessionLoss`、発見・READ の確かめの成果物、IPC の `AUTH_STATE`、管理データのジョブの行、ジョブの画面が同じ形を使う。
// 値（token、Cookie の値、query の値、本文、ヘッダの値）は持たない。path は値に見える区切りを伏せ、query は名前だけ（値に見える名前は伏せる）。

/** 証拠の Origin の区別（許可 Origin・承認したサービスの Origin・そのほか。Origin そのものは持たない）。 */
export const SESSION_LOSS_ORIGIN_KINDS = Object.freeze(['ALLOWED', 'SERVICE', 'OTHER'] as const);
export type SessionLossOriginKind = (typeof SESSION_LOSS_ORIGIN_KINDS)[number];

/**
 * 行き着いた先をどこで見たか。`PAGE_URL` は main frame の最後の URL、`BLOCKED_REDIRECT` は Guard が止めた main frame の移動の先（セッションの切れの
 * 判定 `sessionLostUrlOf` と同じ順）。
 */
export const SESSION_LOSS_LANDED_BY = Object.freeze(['PAGE_URL', 'BLOCKED_REDIRECT'] as const);
export type SessionLossLandedBy = (typeof SESSION_LOSS_LANDED_BY)[number];

/** 止めた要求の理由（Safety Ledger の止めた要求・止めた main frame の移動・監査の段の除外の理由の和。一覧の owner はそれぞれの一覧）。 */
export const SESSION_LOSS_BLOCKED_REQUEST_REASONS = Object.freeze([
  ...BLOCKED_REQUEST_REASONS,
  ...BLOCKED_NAVIGATION_REASONS,
  ...BLOCKED_AUDIT_EXCLUSION_REASONS,
] as const);
export type SessionLossBlockedRequestReason = (typeof SESSION_LOSS_BLOCKED_REQUEST_REASONS)[number];

/**
 * 鍵の名前の置き場所（ローカル ストレージの鍵か、Cookie の名前か、DEF-139 からは IndexedDB のデータベースの名前か。DEF-139 で末尾に足した。前の値の順は
 * 変えない）。
 */
export const SESSION_LOSS_STORAGE_KINDS = Object.freeze(['LOCAL_STORAGE', 'COOKIE', 'INDEXED_DB'] as const);
export type SessionLossStorageKind = (typeof SESSION_LOSS_STORAGE_KINDS)[number];

/** 鍵の名前の違いの向き（読み込みの前にあって後にない `REMOVED`、後にだけある `ADDED`）。 */
export const SESSION_LOSS_KEY_CHANGES = Object.freeze(['REMOVED', 'ADDED'] as const);
export type SessionLossKeyChange = (typeof SESSION_LOSS_KEY_CHANGES)[number];

// LZ-3a: 経路の段（前は `MAX_SESSION_LOSS_REDIRECT_PATHS` 10）・止めた要求の形の行（前は `MAX_SESSION_LOSS_BLOCKED_REQUESTS` 8）・鍵の名前の違いの 1 行の案
// （前は `MAX_SESSION_LOSS_KEY_SHAPES` 4）の数の上限は撤廃した（スキーマにも maxItems を置かない）。`redirectPathsOmitted`・`blockedRequestsUnlisted` は前の記録の
// 形のために残す（止めた要求の Origin を作れない URL は今も数だけ）。
// LZ-2: 段階の名前と method の文の長さの上限（前は `MAX_SESSION_LOSS_PATH_LENGTH` 2,048）は撤廃した。
/** 鍵の名前の違いの行の上限（置き場所 3（DEF-139 から）× Origin の区別 3 × 向き 2）。 */
export const MAX_SESSION_LOSS_STORAGE_KEY_CHANGES = SESSION_LOSS_STORAGE_KINDS.length * SESSION_LOSS_ORIGIN_KINDS.length * SESSION_LOSS_KEY_CHANGES.length;

/** 経路の 1 段（Origin の区別と、path の表記）。 */
export interface SessionLossPathRecord {
  readonly originKind: SessionLossOriginKind;
  readonly path: string;
}

/** 止めた要求の形の 1 行（method、Origin の区別、path（query なし）、理由、回数）。 */
export interface SessionLossBlockedRequest {
  readonly method: string;
  readonly originKind: SessionLossOriginKind;
  readonly path: string;
  readonly reason: SessionLossBlockedRequestReason;
  /** 止めた回数（1 以上。飽和）。 */
  readonly count: number;
}

/** 接頭辞と接尾辞の案 1 つ（ログインの段の観察の `storageKeyShapeOf` の形。名前の全体と間の部分は持たない）。 */
export interface SessionLossKeyShape {
  readonly prefix: string;
  readonly suffix: string;
}

/** 鍵の名前の違いの 1 行（置き場所・Origin の区別・向きごと）。`count` は違った名前の数、`shapes` はそのうち案にできた名前の案（上限つき）。 */
export interface SessionLossStorageKeyChange {
  readonly storage: SessionLossStorageKind;
  readonly originKind: SessionLossOriginKind;
  readonly change: SessionLossKeyChange;
  readonly count: number;
  readonly shapes: readonly SessionLossKeyShape[];
}

/**
 * セッションの切れの証拠（設計書 2.1）。
 * - `stage`: 判定した段階（理由 `AUTH_SESSION_LOST` の `detail` と同じ値。例 `desktop:passive`。ワーカーの 1 画面の読み込みは、鍵の消失なら
 *   `session-key`、path の切れなら `null`）。
 * - `requestedPath`・`landedPath`: 頼んだ URL と行き着いた先の path の表記（読めない URL は `null`）。`landedBy` はどこで見たか。
 * - `redirectPaths`: main frame の文書の要求の経路（読み込みの順。上限つき。超えた数は `redirectPathsOmitted`）。
 * - `blockedRequests`: この読み込みの間に Guard が止めた要求の形（上限つき。一覧に入れなかった回数は `blockedRequestsUnlisted`）。
 * - `storageKeyChange`: 読み込みの前（Context に入れた状態）と後（閉じるときに読んだ状態）の鍵の名前の違い。どちらかを読めなければ `null`。
 */
export interface SessionLossEvidence {
  readonly stage: string | null;
  readonly requestedPath: string | null;
  readonly landedPath: string | null;
  readonly landedBy: SessionLossLandedBy;
  readonly redirectPaths: readonly SessionLossPathRecord[];
  readonly redirectPathsOmitted: number;
  readonly blockedRequests: readonly SessionLossBlockedRequest[];
  readonly blockedRequestsUnlisted: number;
  readonly storageKeyChange: readonly SessionLossStorageKeyChange[] | null;
}
