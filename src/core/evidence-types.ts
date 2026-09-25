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
  type EvidenceId,
  type IncompleteReasonCode,
  type InteractionStatus,
  type ObservationStatus,
  type PageId,
  type PartialFailureReason,
  type ViewportProfile,
} from './contracts.js';

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
 * なっていれば、1回だけ対象を切り替えてたどり直す。内側の領域が最も大きければ、その領域はたどらずに
 * `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` を返す。
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
 * - `INNER_SCROLL_CONTAINER_NOT_TRAVERSED`: 候補のうちスクロールできる量が最も大きいのが内側のスクロール領域である。
 *   controlled scroll は内側の領域をたどらない（文書も body もスクロールできない場合は、量0とみなして比べる）。
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
] as const satisfies readonly IncompleteReasonCode[]);
export type ScrollIncompleteReason = (typeof SCROLL_INCOMPLETE_REASONS)[number];

/** 終了時に文書の先頭（0, 0）へ戻せなかった理由の閉じた一覧。 */
export const SCROLL_RESTORATION_FAILURE_REASONS = Object.freeze([
  ...PARTIAL_FAILURE_REASONS,
  'POSITION_NOT_AT_ORIGIN',
] as const satisfies readonly IncompleteReasonCode[]);
export type ScrollRestorationFailureReason = (typeof SCROLL_RESTORATION_FAILURE_REASONS)[number];

/** 終了時に文書の先頭（0, 0）へ戻せたかどうか。 */
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
}

/**
 * controlled scroll の結果（scroll の Evidence の payload。`controlledScroll()` が返す値そのもの）。
 * たどった対象と到達した位置は `finalSnapshot`（最後の測定）の `scrollTarget`・`scrollY` にある。
 */
export type ScrollEvidence = Readonly<ScrollEvidenceFacts & {
  readonly status: 'COMPLETE';
  readonly reason: 'BOTTOM_AND_HEIGHT_STABLE';
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
  /** URL・メソッド・ヘッダの値のどれかを上限で切り詰めたか。 */
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
  /** URL・ヘッダの値のどれかを上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface NetworkFailureEvidence extends RequestOriginFlags {
  readonly requestId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly errorText: string;
  readonly timing: NetworkTimingEvidence;
  /** URL・メソッド・エラー文のどれかを上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface NetworkEvidence {
  readonly requests: readonly NetworkRequestEvidence[];
  readonly responses: readonly NetworkResponseEvidence[];
  readonly failures: readonly NetworkFailureEvidence[];
  /** 件数の上限（`MAX_NETWORK_REQUESTS`）を超えたため記録しなかったリクエストの件数。 */
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
 * - `URL_TOO_LONG`: 正規化した URL が `MAX_URL_LENGTH`（`src/core/limits.ts`）より長い。
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
 * 1つのアンカーの Evidence。文字列は、上限（`src/crawl/discover-links.ts` の `LINK_LIMITS`）までに切り詰める。
 * URL の文字列（`rawHref`、`normalized` と `admission` の `rawUrl`、`scheme`）の上限は `MAX_URL_LENGTH`。
 * 正規化済みの URL（`normalized.url`、`admission.url`）は、上限を超えるものを正規化で受け入れない（`URL_TOO_LONG`）ので、
 * 切り詰めない。
 */
export interface LinkEvidence {
  readonly sourcePageId: PageId;
  readonly anchorText: string;
  readonly ariaLabel: string | null;
  readonly title: string | null;
  readonly rawHref: string;
  readonly normalized: LinkNormalizationEvidence;
  readonly admission: LinkAdmissionEvidence;
  /** `anchorText`・`ariaLabel`・`title`・`rawHref`・`rawUrl`・`scheme` のどれかを上限で切り詰めたか。 */
  readonly truncated: boolean;
}

/** 1ページの `discoverLinks()` の結果（link の Evidence の payload）。 */
export interface LinkDiscoveryEvidence {
  /** 文書の順の、先頭から上限（`LINK_LIMITS.maxLinks`）までのリンク。 */
  readonly links: readonly LinkEvidence[];
  /** 件数の上限を超えたため記録しなかったリンク（`a[href]`）の件数。 */
  readonly omittedLinkCount: number;
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
  /** `text` を長さの上限で切り詰めたか、見出しの中をたどるノードの数が上限に達したか。 */
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
  /** `text` を長さの上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface VisibleTextEvidence {
  /** landmark の区分に可視テキストがあれば `SEMANTIC_LANDMARKS`、なければ `BODY_FALLBACK`（`regions` は空）。 */
  readonly source: VisibleTextSource;
  /** body の中の可視テキスト（`checkVisibility(VISIBILITY_CHECK_OPTIONS)` が真の要素のテキスト）を、文書の順に並べたもの。 */
  readonly text: string;
  /** `text` を長さの上限（`maxVisibleTextLength`）で切り詰めたか。ノード数の上限は `nodeLimitReached` に記録する。 */
  readonly truncated: boolean;
  /** たどるノードの数が上限（`maxTextWalkNodes`）に達し、残りのノードをたどらなかったか。 */
  readonly nodeLimitReached: boolean;
  /** `text` のうち、`aria-hidden="true"` の中にある部分。 */
  readonly ariaHiddenText: string;
  /** landmark の区分（文書の順）と、最後に `other` の区分。 */
  readonly regions: readonly SemanticRegionEvidence[];
  /** 件数の上限により記録しなかった、テキストのある landmark の区分の数。 */
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
  /** `src`・`resolvedUrl`・`alt` のいずれかを長さの上限で切り詰めたか。 */
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
  /** `type`・`name`・`labels` のいずれかを上限で切り詰めたか。 */
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
  /** `name`・`value`・`text` のいずれかを長さの上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface FormDomEvidence {
  readonly method: string;
  readonly action: string;
  readonly fields: readonly FormFieldEvidence[];
  readonly submitControls: readonly SubmitControlEvidence[];
  readonly omittedFieldCount: number;
  readonly omittedSubmitControlCount: number;
  /** `method`・`action` を長さの上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface DuplicateIdEvidence {
  readonly id: string;
  /** 同じ `id` を持つ要素の数（2以上）。 */
  readonly count: number;
  /** `id` を長さの上限で切り詰めたか。 */
  readonly truncated: boolean;
}

/**
 * 文書の項目ごとに、長さの上限で切り詰めたか（R''2 の m4）。キーは `DomEvidence` の項目の名前と同じ。
 * 上限は、`title`・`metaDescription`・`lang` が `maxDocumentTextLength`、`canonicalUrl` が `maxUrlLength`
 * （`src/evidence/dom-collector.ts` の `DOM_LIMITS`）。切り詰めた canonical の URL は、元の URL と異なるので、
 * Rule（例: `INVALID_CANONICAL_URL`）は `canonicalUrl` の印を見て判定する。
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
  readonly truncation: DomTruncationEvidence;
}

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
   * 子孫の走査が上限（`maxRenderedDescendantScan`）に達した場合は、判定できないものとして false にし、
   * `LayoutTruncationEvidence.renderedDescendantScanLimitReachedCount` に数える。
   */
  readonly hasRenderedDescendant: boolean;
  /** selector を上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface ClippedTextEvidence {
  readonly selector: string;
  readonly text: string;
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
   * テキストのノードの走査が上限（`maxClippedTextNodeScan`）に達した場合は、判定できないものとして false にし、
   * `LayoutTruncationEvidence.clippedTextNodeScanLimitReachedCount` に数える。
   */
  readonly partiallyClippedText: boolean;
  /** selector かテキストを上限で切り詰めたか。 */
  readonly truncated: boolean;
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
}

/**
 * 上限により記録しなかった候補の件数と、走査を止めた印。
 * 収集が期限で止まった場合（`PARTIAL`）は、止まるまでに見つけた分だけを数える。
 * `overlapComparisonLimitReached` が true の場合、重なりの件数（`omittedFixedHeadingOverlapCount`、
 * `omittedElementOverlapCount`）は、比べた組の中で見つけた分だけを数える。
 */
export interface LayoutTruncationEvidence {
  readonly omittedOutsideViewportCount: number;
  readonly omittedZeroSizeInteractiveCount: number;
  readonly omittedClippedTextCount: number;
  readonly omittedFixedHeadingOverlapCount: number;
  readonly omittedElementOverlapCount: number;
  readonly omittedFixedElementCount: number;
  /** 重なりの走査のどれかが、比べる組の上限（`maxOverlapComparisons`）に達して止まったか。 */
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
  readonly boxesOutsideViewport: readonly OutsideViewportEvidence[];
  readonly zeroSizeInteractive: readonly ZeroSizeInteractiveEvidence[];
  readonly clippedText: readonly ClippedTextEvidence[];
  readonly fixedHeadingOverlaps: readonly FixedHeadingOverlapEvidence[];
  readonly elementOverlaps: readonly ElementOverlapEvidence[];
  readonly fixedElements: readonly FixedElementEvidence[];
  readonly truncation: LayoutTruncationEvidence;
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

export type StressLayoutEvidence =
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
  /** `text` か `selector` を長さの上限で切り詰めたか。 */
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
  /** 標本の件数の上限に達した後にも、標本にできる要素があったか（その要素は `textSamples` に含まれない）。 */
  readonly textSamplesTruncated: boolean;
  readonly foregroundDistribution: readonly ForegroundDistributionEvidence[];
  /** 件数の上限により `foregroundDistribution` に記録しなかった色の数。 */
  readonly omittedDistributionEntryCount: number;
  readonly observedArea: number;
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
}

/** performance の収集が途中で止まった理由の閉じた一覧。 */
export const PERFORMANCE_INCOMPLETE_REASONS = Object.freeze([
  'DEADLINE_EXCEEDED',
  'EVALUATION_FAILED',
  'INVALID_BROWSER_DATA',
  'RESOURCE_LIMIT_REACHED',
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

/** accessibility の収集が途中で止まった理由の閉じた一覧。 */
export const ACCESSIBILITY_INCOMPLETE_REASONS = Object.freeze([
  'DEADLINE_EXCEEDED',
  'EVALUATION_FAILED',
] as const satisfies readonly PartialFailureReason[]);
export type AccessibilityIncompleteReason = (typeof ACCESSIBILITY_INCOMPLETE_REASONS)[number];
export type AccessibilityTargetSelector = string | readonly string[];

export interface AccessibilityNodeEvidence {
  readonly impact: AccessibilityImpact;
  readonly targetSelectors: readonly AccessibilityTargetSelector[];
  readonly failureSummary: string | null;
  readonly htmlSnippet: string;
  /** selector・`failureSummary`・HTML の抜粋のどれかを上限で切り詰めたか。 */
  readonly truncated: boolean;
}

export interface AccessibilityRuleEvidence {
  readonly ruleId: string;
  readonly impact: AccessibilityImpact;
  readonly help: string;
  readonly helpUrl: string;
  readonly tags: readonly string[];
  readonly nodes: readonly AccessibilityNodeEvidence[];
  /** 件数の上限（`maxNodesPerRule`）を超えたため記録しなかった要素の件数。 */
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

export type AccessibilityEvidence = Readonly<AccessibilityEvidenceFacts & {
  readonly status: 'COMPLETE';
  /** 収集した時点（axe を実行する直前）の文書のスクロール位置（定義は `ScrollPosition`）。 */
  readonly scrollPosition: ScrollPosition;
}> | Readonly<AccessibilityEvidenceFacts & {
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
   * `changedAttributes` を件数の上限で切り詰めたか（F17、F16 の発見事項7）。true の場合、`changedAttributes` にない、
   * 変わった属性の名前がある（持続の確認では、どちらかの観測で切り詰めていれば、ある可能性があるとして true にする）。
   * 切り詰めていない場合と、`attributes` が根拠でない場合は false。
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
  // 凍結の前の下準備（スクロール・hover・focus・落ち着くのを待つ）。
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
  // click の後の観測。
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
] as const);
export type InteractionNotVerifiableReasonCode = (typeof INTERACTION_NOT_VERIFIABLE_REASON_CODES)[number];

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
}

// ---------------------------------------------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------------------------------------------

/** スクリーンショットの撮り方の閉じた一覧。 */
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
 */
export const SITE_METADATA_OUTCOMES = Object.freeze(['OK', 'NOT_FOUND', 'FAILED'] as const);
export type SiteMetadataOutcome = (typeof SITE_METADATA_OUTCOMES)[number];

interface SiteMetadataEvidenceBase {
  /** 取得した URL。 */
  readonly url: string;
  readonly outcome: SiteMetadataOutcome;
  /** 応答の HTTP ステータス。応答を得られなかった場合は `null`。 */
  readonly httpStatus: number | null;
  /** 本文（`MAX_SITE_METADATA_TEXT_LENGTH` までで切り詰める）。本文がない場合は `null`。 */
  readonly text: string | null;
  /** 本文を上限で切り詰めたか。本文が `null` なら偽。 */
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
   * `<loc>` の値を `normalizeUrl` で正規化した値（`MAX_SITEMAP_URLS` 件までで切り詰める）。切り詰める前の本文から取り出す。
   * 正規化できない値は含めない。
   * 結果が `OK` でない場合と、本文から URL を取り出せなかった場合（根の要素が `<urlset>` でない。sitemap の index を含む）は `null`。
   */
  readonly sitemapUrls: readonly string[] | null;
  /**
   * `sitemapUrls` が、sitemap のすべての `<loc>` を含んでいないか（件数の上限で切り詰めた、など）。`sitemapUrls` が `null` なら偽。
   * 真の場合、Cross-page rule は `DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。
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

/** Passive の Guard が、読み取り以外のメソッドのリクエストを遮断した理由の閉じた一覧。 */
export const BLOCKED_REQUEST_REASONS = Object.freeze(['NON_READ_METHOD'] as const);

/** Passive の Guard が、許可Originの外へのメインフレームの遷移を遮断した理由の閉じた一覧。 */
export const BLOCKED_NAVIGATION_REASONS = Object.freeze(['EXTERNAL_MAIN_FRAME_NAVIGATION'] as const);

/** Passive の Guard が、WebSocket を遮断した理由の閉じた一覧。 */
export const BLOCKED_WEBSOCKET_REASONS = Object.freeze(['PASSIVE_WEBSOCKET'] as const);

/** Interaction の凍結中に、ページが起こした通信・遷移・popup・WebSocket を遮断した理由の閉じた一覧。 */
export const INTERACTION_FROZEN_REASONS = Object.freeze(['INTERACTION_FROZEN'] as const);

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
 * 外部スキームへの移動の試みを記録した理由の閉じた一覧（C18a、C18g）。
 * - `EXTERNAL_SCHEME_NAVIGATION`: ページのスクリプトなどによる移動の試み。外部スキームはネットワークを通らないので、Guard は
 *   止められない（記録だけ。headed では不変条件の違反も記録する）。
 * - `EXTERNAL_SCHEME_REDIRECT_BLOCKED`: サーバのリダイレクト（3xx の `Location` が外部スキーム）。Guard が Document の応答の
 *   段階で、リダイレクトをたどる前にリクエストを失敗させた（止めた）もの。止めて防げるので、headed でも違反にしない
 *   （Task 19 の前の整理の設計書 4.2、4.2.1）。
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

export interface BlockedRequestEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: (typeof BLOCKED_REQUEST_REASONS)[number];
}

export interface BlockedNavigationEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: (typeof BLOCKED_NAVIGATION_REASONS)[number];
}

export interface BlockedWebSocketEvent {
  readonly url: string;
  readonly reason: (typeof BLOCKED_WEBSOCKET_REASONS)[number];
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

export interface BlockedInteractionRequestEvent {
  readonly method: string;
  readonly url: string;
  readonly reason: (typeof INTERACTION_FROZEN_REASONS)[number];
}

export interface BlockedInteractionNavigationEvent extends BlockedInteractionRequestEvent {}

export interface BlockedPopupEvent {
  readonly url: string;
  readonly reason: (typeof INTERACTION_FROZEN_REASONS)[number];
}

/** ブロックしたダウンロード。`reason` でフェーズを区別する（`BLOCKED_DOWNLOAD_REASONS`）。 */
export interface BlockedDownloadEvent {
  readonly url: string;
  readonly suggestedFilename: string;
  readonly reason: (typeof BLOCKED_DOWNLOAD_REASONS)[number];
}

export interface BlockedInteractionWebSocketEvent {
  readonly url: string;
  readonly reason: (typeof INTERACTION_FROZEN_REASONS)[number];
}

/**
 * 外部スキーム（`NON_EXTERNAL_NAVIGATION_SCHEMES` にないスキーム）への移動の試み（C18a、DEF-012）。どの経路かは `reason` で
 * 区別する（`EXTERNAL_SCHEME_NAVIGATION_REASONS`）。
 * - ページのスクリプトなどによる移動（`EXTERNAL_SCHEME_NAVIGATION`）: 外部スキームはネットワークを通らないので、Guard は
 *   止められない。起きたことを記録する（headless では記録だけ、headed では不変条件の違反も記録する）。
 * - サーバのリダイレクト（`EXTERNAL_SCHEME_REDIRECT_BLOCKED`。C18g）: Guard が、リダイレクトをたどる前に止めた。
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
  /** 上限のために、記録しなかったイベントか、数えられなかったブロックがあるか。 */
  readonly truncated: boolean;
  /** 上限のために記録しなかったイベントの件数（違反を含む）。 */
  readonly droppedEventCount: number;
  /** 上限のために `blockedRequestsByMethod` で数えられなかったブロックの件数。 */
  readonly uncountedBlockedRequestCount: number;
  /** 上限の長さまで切り詰めて記録した文字列の件数。イベント自体は記録されるので `truncated` にはしない。 */
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
    readonly maxPages: number;
    readonly maxDepth: number;
    /** 正の整数（ミリ秒。Task 14〜17 の設計書 4.5.7）。 */
    readonly maxRuntimeMs: number;
    /** 正の整数（ミリ秒。Task 14〜17 の設計書 4.5.7）。 */
    readonly navigationTimeoutMs: number;
    /** 正の整数（ミリ秒。Task 14〜17 の設計書 4.5.7）。 */
    readonly overallPageTimeoutMs: number;
    /** 正の整数（ミリ秒。Task 14〜17 の設計書 4.5.7）。 */
    readonly resourceSettlingTimeoutMs: number;
    /** 正の整数（ミリ秒）。 */
    readonly interactionTimeoutMs: number;
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
  };
  readonly output: {
    readonly directory: string;
  };
}
