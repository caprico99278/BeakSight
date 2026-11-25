import type { Page } from 'playwright';
import {
  announceOwnMainFrameNavigation,
  observeMainFrameLoad,
  trackMainFrameDocument,
  type MainFrameLoadObservation,
  type MainFrameLoadSettlement,
} from '../browser/main-frame-load.js';
import { pageFailureReason } from '../browser/page-failure.js';
import type { Viewport } from '../config/types.js';
import { awaitBeforeDeadline } from '../core/deadline.js';
import { safeErrorMessage } from '../core/errors.js';
import {
  FIXED_ELEMENT_POSITIONS,
  HORIZONTAL_CLIP_ANCESTOR_KINDS,
  LAYOUT_ELEMENT_KINDS,
  VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  type ClippedTextEvidence,
  type ClippedTextStyleEvidence,
  type FixedElementEvidence,
  type FixedElementPosition,
  type FixedHeadingOverlapEvidence,
  type HorizontalClipAncestorKind,
  type IntendedClippingKind,
  type KeyActionElementEvidence,
  type LayoutCollectionResult,
  type LayoutDocumentEvidence,
  type LayoutElementEvidence,
  type LayoutElementKind,
  type LayoutEvidence,
  type LayoutIncompleteReason,
  type OverlapPlacementEvidence,
  type OverlapSidePlacementEvidence,
  type LayoutTruncationEvidence,
  type LineOverlapEvidence,
  OVERLAP_HIT_RELATIONS,
  OVERLAP_HIT_TARGETS,
  type OutsideViewportEvidence,
  type OverlapHitLayerEvidence,
  type OverlapHitPointEvidence,
  type OverlapHitTestEvidence,
  type RectangleEvidence,
  type ScrollContainerEvidence,
  type ScrollPosition,
  type StressLayoutEvidence,
  type StressLayoutFailureReason,
  type StressLayoutFailureStage,
  type VisibilityEvidence,
  type ZeroSizeInteractiveEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeFiniteNumber, isNonNegativeSafeInteger, isPositiveFiniteNumber } from '../core/guards.js';
import { KEY_ACTION_ELEMENT_SELECTOR, keyActionHrefTargetOf, keyActionKindOf, maskContactValues } from '../core/key-actions.js';
import {
  GEOMETRY_EPSILON_PX,
  MAX_SELECTOR_DEPTH,
} from '../core/limits.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { composeInPage, FRONT_WINDOW_MIN_VIEWPORT_RATIO, type StandardReaders } from '../browser/in-page-readers.js';
import { paintsOwnSurfaceOf, type OwnSurfaceFacts } from '../core/own-surface.js';
import { readInParts } from '../core/read-in-parts.js';
import { readStateMark, stateMarkTargetSelectorsOf } from './state-mark.js';

export const LAYOUT_THRESHOLDS = Object.freeze({
  stressViewportHeight: 900,
  minOcclusionAreaPx2: 1,
  maxZeroSizeDimensionPx: 0,
  geometryEpsilonPx: GEOMETRY_EPSILON_PX,
  // LZ-3b: 記録する見切れのテキストの長さの上限（前の `maxClippedTextLength` 256）は撤廃した。テキストを切り詰めずに記録する（見切れの候補の
  // `truncated` は前の記録の形のために残し、いつも偽。selector も切り詰めない）。
  /**
   * `partiallyClippedText` の判定で、箱と交わるテキストの行を、縦方向に「切り取られている」とみなす、箱の外に出た量の割合の下限（この値を含まない）。
   * 割合は、行の矩形の高さに対して計る。行の矩形はフォントの内容領域の高さを持ち、行の高さより大きいことがあるので、
   * 行の高さが小さい文章で、行の矩形が箱の上下にわずかに出るだけの場合を除くため、4分の1を超える場合に限る（設計書 5.1.2、RT12r の N1）。
   * 箱の上に出た量と下に出た量は、別々にこの割合と比べ、合計しない（RT12r2 の I1。合計すると、1行の箱で誤って報告するため）。
   */
  clippedTextLineMinOutsideRatio: 0.25,
  /**
   * `partiallyClippedText` の判定で、箱と交わるテキストの行を、横方向に「切り取られている」とみなさない、箱の外に出た量の上限（px。この値を含む）。
   * 横方向には、フォントの内容領域と行の高さのずれがないので、割合ではなく、文字の少しの張り出しだけを許す固定の値にする（設計書 5.1.2、RT12d の発見事項2）。
   * 縦方向と同じく、箱の左に出た量と右に出た量は、別々にこの値と比べる（RT12r2 の I1）。
   */
  clippedTextLineMaxIgnoredHorizontalOverflowPx: 2,
  /**
   * DEF-204（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.5）: 固定要素が自分の文字を持つか（描く面の事実）を調べる、子のノードの最大数。
   * 超えた場合は、文字があるもの（描く面があるもの）として扱う。
   */
  maxOwnTextNodeScan: 256,
  /** 描画された子孫とみなさない、子孫の幅か高さの上限（px。この値を含む）。visually hidden の要素を数えないため（RT12r の N5）。 */
  maxUnrenderedDescendantDimensionPx: VISUALLY_HIDDEN_MAX_DIMENSION_PX,
  maxSelectorDepth: MAX_SELECTOR_DEPTH,
  viewportMatchTolerancePx: 0,
  minViewportIntersectionDimensionPx: 0,
  /** ブラウザ内の走査を、期限のこの時間前に止める（部分結果を期限までに Node 側へ返すための時間。ミリ秒）。 */
  partialResultReserveMs: 250,
  /**
   * AUD-3b: hit-test の四隅の点を、交わりの矩形の内側へ寄せる量の上限（px）。寄せる量は、この値と各辺の 4 分の 1 の小さい方（境界の上の点は、どちらの要素に
   * 当たるかが描画の丸めで揺れるため）。点は、中心と四隅の 5 点（数の上限ではない。交わりの形から決まる）。
   */
  hitTestPointInsetPx: 4,
  /** AUD-3b: 要素そのものが中身を描く種類（hit-test の点の要素の、描く面の事実に使う）。 */
  replacedContentSelector: 'img, picture, video, canvas, svg, iframe, embed, object, input, textarea, select',
  /** RVP-2: 前面の窓（`R.frontWindows`）とみなす面積の割合の下限（値は部品の側の 1 か所）。 */
  frontWindowMinViewportRatio: FRONT_WINDOW_MIN_VIEWPORT_RATIO,
});


export const STRESS_VIEWPORT_HEIGHT = LAYOUT_THRESHOLDS.stressViewportHeight;

/**
 * COV-6: ページの中の 1 回の読み取りで返す、候補の一覧（はみ出し・大きさ0の操作要素・見切れ・固定要素と見出しの重なり・主要要素どうしの重なり・固定要素）
 * ごとの件数（自分の処理の上限 C。1 回の受け渡しの大きさを抑えるための分け方の単位で、記録の件数の上限ではない）。
 * 読み取りは毎回ページ全体を走査し直し、続きの位置からこの件数だけを返す（`readInParts`）。読み終えた一覧は、次の回から走査の作業を省く。
 */
export const LAYOUT_COLLECTION_PART_SIZE = 2_000;

/** COV-6: 候補の一覧の名前（続きの位置の項目と同じ）。 */
const LAYOUT_PART_LIST_NAMES = Object.freeze([
  'boxesOutsideViewport',
  'zeroSizeInteractive',
  'clippedText',
  'fixedHeadingOverlaps',
  'elementOverlaps',
  'fixedElements',
  // BS-2: 押せる要素（主要な行動の候補を選ぶ前の、全部）。
  'keyActionElements',
] as const);
type LayoutPartListName = (typeof LAYOUT_PART_LIST_NAMES)[number];

/**
 * COV-6: 一覧ごとの、この回に読み始める位置。`null` は読み終えた一覧（ブラウザは、その一覧の作業を省き、空の部分を返す）。
 * 位置は、はみ出し・大きさ0の操作要素・見切れ・固定要素では一覧の中の番号、重なりの 2 つの一覧では比べる組の番号（何番目の組から比べるか）。
 */
export type LayoutPartCursor = Readonly<Record<LayoutPartListName, number | null>>;

const FIRST_LAYOUT_PART_CURSOR: LayoutPartCursor = Object.freeze({
  boxesOutsideViewport: 0,
  zeroSizeInteractive: 0,
  clippedText: 0,
  fixedHeadingOverlaps: 0,
  elementOverlaps: 0,
  fixedElements: 0,
  keyActionElements: 0,
});

/**
 * AUD-4a: `-webkit-line-clamp` が効く `display` の計算値。いまの Chromium は、行数の省略が効く `-webkit-box`・`-webkit-inline-box` の計算値を
 * `flow-root`・`inline-flow-root` で返す（2026-11-09 にテストの Chromium で確かめた）ので、両方を入れる。
 */
const WEBKIT_LINE_CLAMP_DISPLAYS: readonly string[] = Object.freeze([
  '-webkit-box',
  '-webkit-inline-box',
  'flow-root',
  'inline-flow-root',
]);

/** AUD-4a: 折り返さない `white-space` の計算値（ellipsis で 1 行を省略する書き方）。 */
const NO_WRAP_WHITE_SPACES: readonly string[] = Object.freeze(['nowrap', 'pre']);

/**
 * 祖先の `overflow-x` の計算値ごとの、横方向の切り取りの種類（Task 12・13 の設計書 5.1.2）。ここにない値（`visible`）は切り取らない。
 * ブラウザ内の、祖先の overflow による切り取りの判定（重なりの候補、見切れの候補）も、このキーを切り取る overflow の一覧として使う。
 */
const HORIZONTAL_CLIP_BY_OVERFLOW = Object.freeze({
  hidden: 'CLIPPED',
  clip: 'CLIPPED',
  auto: 'SCROLLABLE',
  scroll: 'SCROLLABLE',
} as const satisfies Readonly<Record<string, Exclude<HorizontalClipAncestorKind, 'NONE'>>>);

/** 主要要素の種類を決める selector。上から順に当てはめる（`input[type=submit]` は `button` になる）。 */
const LAYOUT_ELEMENT_KIND_SELECTORS: readonly (readonly [Exclude<LayoutElementKind, 'other'>, string])[] = Object.freeze([
  ['heading', 'h1, h2, h3, h4, h5, h6, [role="heading"]'],
  ['paragraph', 'p'],
  ['image', 'img, svg, [role="img"]'],
  [
    'button',
    'button, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"], [role="button"]',
  ],
  ['link', 'a[href], [role="link"]'],
  ['input', 'input, select, textarea'],
  ['table', 'table'],
  ['media', 'iframe, video, embed, object, canvas'],
] as const);

export interface LayoutCollectionOptions {
  /**
   * 呼び出し側の期限（`Date.now()` の絶対時刻）。省略できる。COV-6（2026-11-09 のユーザーの判断）: layout の collector は自分の期限を持たず、
   * 省略すると時間で打ち切らない。渡したときだけ、この期限を守る（それまでの回の事実で `PARTIAL`）。
   * 呼び出し側が渡すのは、Page Auditor のページの期限（`crawl.overallPageTimeoutMs` から導く）と、幅の走査の期限。幅の走査は Page Auditor が
   * 見放さない段階なので、ページが応答しないときに戻る守りは、この期限だけである（外すかは、呼び出し側の設計で決める）。
   */
  readonly deadlineAtMs?: number;
}

type RawLayoutElementEvidence = Omit<LayoutElementEvidence, 'area'>;

/** AUD-3b: ブラウザが返す hit-test の点の要素の事実（描く面があるかは、Node の側で `paintsOwnSurfaceOf` が決める）。 */
interface RawOverlapHitLayer extends Omit<OverlapHitLayerEvidence, 'paintsOwnSurface'> {
  readonly surface: Omit<OwnSurfaceFacts, 'replacedContent'>;
  /** 要素そのものが中身を描く種類（画像・埋め込み・入力の欄など）か。 */
  readonly replaced: boolean;
}

interface RawOverlapHitPoint extends Omit<OverlapHitPointEvidence, 'layers'> {
  readonly layers: readonly RawOverlapHitLayer[];
}

/** AUD-3b: ブラウザが返す hit-test の事実。 */
interface RawOverlapHitTest extends Omit<OverlapHitTestEvidence, 'points' | 'overlay'> {
  readonly points: readonly RawOverlapHitPoint[];
  readonly overlay: RawOverlapHitLayer;
}

interface RawElementOverlapEvidence {
  readonly first: RawLayoutElementEvidence;
  readonly second: RawLayoutElementEvidence;
  readonly intersection: RectangleEvidence & { readonly area: number };
  readonly truncated: boolean;
  readonly hitTest?: RawOverlapHitTest;
  readonly coveredScrollContainer?: ScrollContainerEvidence;
  readonly lineOverlap?: LineOverlapEvidence;
  readonly placement?: OverlapPlacementEvidence;
}

type RawFixedHeadingOverlapEvidence = Omit<FixedHeadingOverlapEvidence, 'hitTest'> & { readonly hitTest?: RawOverlapHitTest };

interface RawFixedElementEvidence extends RawLayoutElementEvidence {
  readonly truncated: boolean;
  /** DEF-204: 描く面の判定に読む事実（判定は `src/core/own-surface.ts` の `paintsOwnSurfaceOf`）。 */
  readonly surface: OwnSurfaceFacts;
  readonly pointerEvents: string;
  readonly hitTest?: RawOverlapHitTest;
}

/**
 * BS-2: ブラウザが返す押せる要素の事実（行き先は絶対の URL のまま。Node の側で scheme とホストだけにし、主要な行動の候補だけを残し、文字の電話番号と
 * メールアドレスを伏せる）。
 */
type RawKeyActionElement = Omit<KeyActionElementEvidence, 'hrefScheme' | 'hrefHost'> & { readonly href: string | null };

/** AUD-4a: ブラウザが返す見切れの候補（区分と行数の省略の数は Node の側で導く）。 */
type RawClippedTextEvidence = Omit<ClippedTextEvidence, 'lineClampCount' | 'intendedClipping'>;

/** COV-6: ページの中の 1 回の読み取りで返す走査の印（`omitted*Count` は返さない。数は、この回に返した候補の分だけ）。 */
type RawLayoutTruncation = Pick<
  LayoutTruncationEvidence,
  'overlapComparisonLimitReached' | 'clippedTextNodeScanLimitReachedCount' | 'renderedDescendantScanLimitReachedCount'
>;

/**
 * COV-6: ページの中の 1 回の読み取りの結果。一覧は続きの位置からの部分で、`next` は一覧ごとの次に読む位置（読み終えたら `null`）。
 * 走査の印は、COV-6 の後は打ち切らないので、ブラウザは常に偽と 0 を返す（呼び出し側の形を変えないために残す）。
 */
interface RawLayoutPart {
  readonly scrollPosition: ScrollPosition;
  readonly document: LayoutDocumentEvidence;
  /** 一覧の中の祖先の番号（`nearestListedAncestorIndex`）は、ページの中のすべての候補の中の番号。 */
  readonly boxesOutsideViewport: readonly OutsideViewportEvidence[];
  readonly zeroSizeInteractive: readonly ZeroSizeInteractiveEvidence[];
  readonly clippedText: readonly RawClippedTextEvidence[];
  readonly fixedHeadingOverlaps: readonly RawFixedHeadingOverlapEvidence[];
  readonly elementOverlaps: readonly RawElementOverlapEvidence[];
  readonly fixedElements: readonly RawFixedElementEvidence[];
  readonly keyActionElements: readonly RawKeyActionElement[];
  readonly next: LayoutPartCursor;
  readonly truncation: RawLayoutTruncation;
  /** ブラウザ内の走査が止まった理由（期限だけ）。比べる組の上限は `truncation.overlapComparisonLimitReached` で返す。 */
  readonly incompleteReason: BrowserLayoutIncompleteReason | null;
}

type BrowserLayoutIncompleteReason = Extract<LayoutIncompleteReason, 'DEADLINE_EXCEEDED'>;

export interface PassiveStressSession {
  readonly page: Page;
  close(): Promise<void>;
}

export type PassiveStressSessionFactory = (viewport: Viewport) => Promise<PassiveStressSession>;

export interface StressLayoutOptions {
  /** すべての幅の収集の期限（`Date.now()` の絶対時刻）。 */
  readonly deadlineAtMs: number;
  /**
   * 各幅の読み込み（`page.goto`）の前、その幅のセッションを作る直前に呼ぶ（DEF-209: 待つ間に、空の page の窓を出さない）、ページの読み込みの間隔の待ち（サイトへの負荷の制御の設計書 4.1。Page Auditor は
   * `NavigationPacer` の `beforeNavigation` を渡す）。待った時間（ms）を返す。返った時間の分だけ、`deadlineAtMs` を延ばし、
   * 延ばした期限で、その幅と次の幅を判定する（設計書 4.4。待ち時間は期限を消費しない）。
   * 必須の引数である（渡し忘れると間隔を空けずに読み込む、という形を残さない。Page Auditor の pacer と同じ。RL の Minor-5）。
   * 待たない呼び出し側（テストなど）は、それを明示する関数（`async () => 0`）を渡す。
   */
  readonly beforeNavigation: () => Promise<number>;
  /**
   * T44 P1-5（Task 44 の設計書の履歴の「T44h の測りとユーザーの判断」。「待ってから測る」）: 各幅の読み込みが終わった後、形を測る前に呼ぶ、落ち着きの待ち
   * （Page Auditor は、最初の読み込み（Desktop・Mobile）と同じ部品 `waitForPageSettled` と待ち方 `PAGE_SETTLING_PACING`、上限
   * `crawl.resourceSettlingTimeoutMs` を渡す。部品は複製しない）。引数は、その幅の page と、その幅の読み込みの期限。待つだけで、読み込みの間隔と回数は
   * 変えない。落ち着かないまま上限が来ても、今までどおり測る（幅の結果の理由は足さない）。L1: 幅の期限と、形を測る時間の予備（前は 1,500ms）は撤廃した。
   * 必須の引数である（渡し忘れると、後から描く画面を見ずに測る、という形を残さない。`beforeNavigation` と同じ）。待たない呼び出し側（テストなど）は、
   * それを明示する関数（`async () => undefined`）を渡す。関数でない値は、セッションを作らずに例外を投げる。
   */
  readonly settleBeforeLayout: (page: Page, deadlineAtMs: number) => Promise<void>;
  /**
   * 各幅の読み込み（`page.goto`）の観測を受け取る口（サイトが応答しないときに Run を止める設計書 2.1）。読み込みを始めた幅ごとに1回、
   * 読み込みが終わった（期限の競争の結果が出た）直後に呼ぶ。読み込みを始めなかった幅（`NOT_STARTED`）では呼ばない。
   * 観測は `src/browser/main-frame-load.ts` の部品で作る。この collector は判定をしない（判定は、受け取った Page Auditor が行う）。
   * 省略できる。省略すると、観測を作らず、page の事象の受け口も付けない（今までの振る舞いのまま）。関数でない値は、
   * セッションを作らずに例外を投げる。
   */
  readonly afterNavigation?: ((observation: MainFrameLoadObservation) => void) | undefined;
  /**
   * AUD-3d: 各幅の layout を読んだ直後（その幅の page を閉じる前）に呼ぶ口（Page Auditor は、その幅の viewport の画像を撮る）。layout を読めた幅
   * （`COMPLETE`・`PARTIAL`）だけで呼ぶ。口の失敗は、その幅の layout の結果を変えない（口の中で受け止めること）。省略できる。EV-2: 読んだ layout も渡す
   * （その幅の指摘の対象まで動かして撮るため）。
   */
  readonly afterLayout?: ((page: Page, width: number, layout: LayoutEvidence) => Promise<void>) | undefined;
}

/** SWR: 1 つのセッションで大きさを変えて回す幅の走査（`collectResizedStressLayout`）の口。 */
export interface ResizedStressLayoutOptions extends StressLayoutOptions {
  /**
   * 各幅の段（最初の幅は読み込みと測り、後の幅は大きさを変えて測る）を包む口（Page Auditor は、幅ごとの進みの見張りを付ける）。`work` の結果を返す。
   * 省略すると、そのまま行う。
   */
  readonly aroundWidth?: ((width: number, work: () => Promise<StressLayoutEvidence>) => Promise<StressLayoutEvidence>) | undefined;
}

function positiveFiniteDimension(value: number, name: string): void {
  if (!isPositiveFiniteNumber(value)) {
    throw new Error(`${name} must be a positive finite number`);
  }
}

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid non-finite browser geometry: ${name}`);
  }
}

function nonnegative(value: number, name: string): void {
  if (isNonNegativeFiniteNumber(value)) {
    return;
  }
  finite(value, name);
  throw new Error(`Invalid negative browser geometry: ${name}`);
}

function count(value: number, name: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`Invalid browser layout count: ${name}`);
  }
  return value;
}

function flag(value: boolean, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid browser layout flag: ${name}`);
  }
  return value;
}

function freezeRect(rect: RectangleEvidence, name: string): RectangleEvidence {
  finite(rect.x, `${name}.x`);
  finite(rect.y, `${name}.y`);
  finite(rect.top, `${name}.top`);
  finite(rect.right, `${name}.right`);
  finite(rect.bottom, `${name}.bottom`);
  finite(rect.left, `${name}.left`);
  nonnegative(rect.width, `${name}.width`);
  nonnegative(rect.height, `${name}.height`);
  return Object.freeze({ ...rect });
}

function freezeIntersection(
  intersection: RectangleEvidence & { readonly area: number },
  name: string,
): RectangleEvidence & { readonly area: number } {
  nonnegative(intersection.area, `${name}.area`);
  return Object.freeze({ ...freezeRect(intersection, name), area: intersection.area });
}

function freezeVisibility(visibility: VisibilityEvidence, name: string): VisibilityEvidence {
  finite(visibility.opacity, `${name}.opacity`);
  nonnegative(visibility.clientRectCount, `${name}.clientRectCount`);
  if (visibility.clippedToZeroArea !== undefined) {
    flag(visibility.clippedToZeroArea, `${name}.clippedToZeroArea`);
  }
  return Object.freeze({ ...visibility });
}

function validateSelector(selector: string, name: string): string {
  if (selector.length === 0) {
    throw new Error(`Invalid browser selector: ${name}`);
  }
  return selector;
}

function validateKind(kind: LayoutElementKind, name: string): LayoutElementKind {
  if (!(LAYOUT_ELEMENT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid browser layout element kind: ${name}`);
  }
  return kind;
}

function validateHorizontalClipAncestor(kind: HorizontalClipAncestorKind, name: string): HorizontalClipAncestorKind {
  if (!(HORIZONTAL_CLIP_ANCESTOR_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid browser layout horizontalClipAncestor: ${name}`);
  }
  return kind;
}

/** 一覧の中の祖先の番号。null か、一覧の範囲の中の、自分以外の番号であること。 */
function validateListedAncestorIndex(index: number | null, ownIndex: number, listLength: number, name: string): number | null {
  if (index !== null && (!isNonNegativeSafeInteger(index) || index >= listLength || index === ownIndex)) {
    throw new Error(`Invalid browser layout nearestListedAncestorIndex: ${name}`);
  }
  return index;
}

function freezeElement(element: RawLayoutElementEvidence, name: string): LayoutElementEvidence {
  const rect = freezeRect(element.rect, `${name}.rect`);
  return Object.freeze({
    selector: validateSelector(element.selector, name),
    kind: validateKind(element.kind, `${name}.kind`),
    rect,
    area: rect.width * rect.height,
    visibility: freezeVisibility(element.visibility, `${name}.visibility`),
    position: element.position,
    zIndex: element.zIndex,
    overflowX: element.overflowX,
    overflowY: element.overflowY,
    fixedOrStickyAncestor: flag(element.fixedOrStickyAncestor, `${name}.fixedOrStickyAncestor`),
  });
}

/** ブラウザが返した文字列の値を確かめる。 */
function text(value: string, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid browser layout text: ${name}`);
  }
  return value;
}

/** DEF-204: 要素そのものが中身を描く種類（画像・埋め込み・入力の欄）。描く面があるものとして扱う。 */
const SURFACE_REPLACED_KINDS = Object.freeze(['image', 'media', 'input'] as const satisfies readonly LayoutElementKind[]);

/** ブラウザが返した描く面の事実を確かめる（形が違えば例外）。 */
function surfaceFacts(surface: OwnSurfaceFacts, name: string): OwnSurfaceFacts {
  if (typeof surface !== 'object' || surface === null) {
    throw new Error(`Invalid browser layout surface: ${name}`);
  }
  const sides = (values: readonly string[], side: string): readonly string[] => {
    if (!Array.isArray(values) || values.length !== 4) {
      throw new Error(`Invalid browser layout surface sides: ${name}.${side}`);
    }
    return values.map((value, index) => text(value, `${name}.${side}[${String(index)}]`));
  };
  return {
    backgroundColor: text(surface.backgroundColor, `${name}.backgroundColor`),
    backgroundImage: text(surface.backgroundImage, `${name}.backgroundImage`),
    borderWidths: sides(surface.borderWidths, 'borderWidths'),
    borderStyles: sides(surface.borderStyles, 'borderStyles'),
    borderColors: sides(surface.borderColors, 'borderColors'),
    outlineWidth: text(surface.outlineWidth, `${name}.outlineWidth`),
    outlineStyle: text(surface.outlineStyle, `${name}.outlineStyle`),
    outlineColor: text(surface.outlineColor, `${name}.outlineColor`),
    boxShadow: text(surface.boxShadow, `${name}.boxShadow`),
    backdropFilter: text(surface.backdropFilter, `${name}.backdropFilter`),
    hasOwnText: flag(surface.hasOwnText, `${name}.hasOwnText`),
    hasPseudoContent: flag(surface.hasPseudoContent, `${name}.hasPseudoContent`),
    replacedContent: false,
  };
}

/** AUD-3b: ブラウザが返した hit-test の要素の関係を確かめる。 */
function hitRelation<T extends string | null>(relation: T, name: string): T {
  if (relation !== null && !(OVERLAP_HIT_RELATIONS as readonly string[]).includes(relation)) {
    throw new Error(`Invalid browser layout hit-test relation: ${name}`);
  }
  return relation;
}

/** AUD-3b: ブラウザが返した hit-test の点の要素の事実を確かめ、描く面があるか（`paintsOwnSurfaceOf`）を足して凍結する。 */
function freezeHitLayer(layer: RawOverlapHitLayer, name: string): OverlapHitLayerEvidence {
  finite(layer.effectiveOpacity, `${name}.effectiveOpacity`);
  return Object.freeze({
    selector: validateSelector(layer.selector, `${name}.selector`),
    relation: hitRelation(layer.relation, `${name}.relation`),
    position: text(layer.position, `${name}.position`),
    zIndex: text(layer.zIndex, `${name}.zIndex`),
    pointerEvents: text(layer.pointerEvents, `${name}.pointerEvents`),
    effectiveOpacity: layer.effectiveOpacity,
    visibility: text(layer.visibility, `${name}.visibility`),
    backgroundColor: text(layer.backgroundColor, `${name}.backgroundColor`),
    hasBackgroundImage: flag(layer.hasBackgroundImage, `${name}.hasBackgroundImage`),
    paintsOwnSurface: paintsOwnSurfaceOf({
      ...surfaceFacts({ ...layer.surface, replacedContent: false }, `${name}.surface`),
      replacedContent: flag(layer.replaced, `${name}.replaced`),
    }),
  });
}

/** AUD-3b: ブラウザが返した hit-test の事実を確かめて凍結する（ないときは `undefined`。前の形のまま）。 */
function freezeHitTest(hitTest: RawOverlapHitTest | undefined, name: string): OverlapHitTestEvidence | undefined {
  if (hitTest === undefined) {
    return undefined;
  }
  if (!(OVERLAP_HIT_TARGETS as readonly string[]).includes(hitTest.target)) {
    throw new Error(`Invalid browser layout hit-test target: ${name}`);
  }
  return Object.freeze({
    target: hitTest.target,
    points: Object.freeze(hitTest.points.map((point, index): OverlapHitPointEvidence => {
      const pointName = `${name}.points[${String(index)}]`;
      finite(point.x, `${pointName}.x`);
      finite(point.y, `${pointName}.y`);
      return Object.freeze({
        x: point.x,
        y: point.y,
        topRelation: hitRelation(point.topRelation, `${pointName}.topRelation`),
        layers: Object.freeze(point.layers.map((layer, layerIndex) => freezeHitLayer(layer, `${pointName}.layers[${String(layerIndex)}]`))),
        targetFound: flag(point.targetFound, `${pointName}.targetFound`),
        targetSelector: point.targetSelector === null ? null : validateSelector(point.targetSelector, `${pointName}.targetSelector`),
      });
    })),
    overlay: freezeHitLayer(hitTest.overlay, `${name}.overlay`),
    modal: Object.freeze({
      dialogModal: flag(hitTest.modal.dialogModal, `${name}.modal.dialogModal`),
      ariaModal: flag(hitTest.modal.ariaModal, `${name}.modal.ariaModal`),
      // AUD-2: 真のときだけ書く（前の Evidence の形のまま）。
      ...(hitTest.modal.openModal === true ? { openModal: true as const } : {}),
      ...(hitTest.modal.coveredInside === true ? { coveredInside: true as const } : {}),
      ...(hitTest.modal.frontWindow === true ? { frontWindow: true as const } : {}),
    }),
  });
}

/** AUD-3b: hit-test の事実があれば `{ hitTest }`、なければ空（前の Evidence の形のまま）。 */
const hitTestField = (hitTest: RawOverlapHitTest | undefined, name: string): { readonly hitTest?: OverlapHitTestEvidence } => {
  const frozen = freezeHitTest(hitTest, name);
  return frozen === undefined ? {} : { hitTest: frozen };
};

/** EV-1: 覆われる側のスクロールの祖先があれば `{ coveredScrollContainer }`、なければ空（前の Evidence の形のまま）。 */
const scrollContainerField = (
  container: ScrollContainerEvidence | undefined,
  name: string,
): { readonly coveredScrollContainer?: ScrollContainerEvidence } => {
  if (container === undefined) {
    return {};
  }
  finite(container.scrollTop, `${name}.scrollTop`);
  nonnegative(container.scrollRangeY, `${name}.scrollRangeY`);
  return {
    coveredScrollContainer: Object.freeze({
      selector: validateSelector(container.selector, `${name}.selector`),
      rect: freezeRect(container.rect, `${name}.rect`),
      scrollTop: container.scrollTop,
      scrollRangeY: container.scrollRangeY,
    }),
  };
};

/** EV-1: 行ごとの矩形の重なりがあれば `{ lineOverlap }`、なければ空。 */
const lineOverlapField = (lineOverlap: LineOverlapEvidence | undefined, name: string): { readonly lineOverlap?: LineOverlapEvidence } => {
  if (lineOverlap === undefined) {
    return {};
  }
  nonnegative(lineOverlap.area, `${name}.area`);
  return {
    lineOverlap: Object.freeze({
      area: lineOverlap.area,
      pointCount: count(lineOverlap.pointCount, `${name}.pointCount`),
      bothHitPointCount: count(lineOverlap.bothHitPointCount, `${name}.bothHitPointCount`),
    }),
  };
};

/** AUD-5（S-02）: 片方ごとの置き方の事実があれば `{ placement }`、なければ空。 */
const placementField = (placement: OverlapPlacementEvidence | undefined, name: string): { readonly placement?: OverlapPlacementEvidence } => {
  if (placement === undefined) {
    return {};
  }
  const side = (value: OverlapSidePlacementEvidence, sideName: string): OverlapSidePlacementEvidence => Object.freeze({
    positionedInSharedContainer: flag(value.positionedInSharedContainer, `${sideName}.positionedInSharedContainer`),
    controlAncestorSelector: value.controlAncestorSelector === null ? null : validateSelector(value.controlAncestorSelector, `${sideName}.controlAncestorSelector`),
  });
  return { placement: Object.freeze({ first: side(placement.first, `${name}.first`), second: side(placement.second, `${name}.second`) }) };
};

function freezeFixedElement(
  element: RawFixedElementEvidence,
  documentEvidence: LayoutDocumentEvidence,
  name: string,
): FixedElementEvidence {
  const position = FIXED_ELEMENT_POSITIONS.find((candidate) => candidate === element.position);
  if (position === undefined) {
    throw new Error(`Invalid browser fixed element position: ${name}`);
  }
  const facts = freezeElement(element, name);
  const { rect } = facts;
  const intersectionWidth = Math.max(0, Math.min(rect.right, documentEvidence.viewportWidth) - Math.max(rect.left, 0));
  const intersectionHeight = Math.max(
    0,
    Math.min(rect.bottom, documentEvidence.viewportHeight) - Math.max(rect.top, 0),
  );
  const viewportIntersectionArea = intersectionWidth * intersectionHeight;
  const viewportArea = documentEvidence.viewportWidth * documentEvidence.viewportHeight;
  return Object.freeze({
    ...facts,
    position,
    viewportIntersectionArea,
    viewportArea,
    viewportAreaRatio: viewportArea > 0 ? viewportIntersectionArea / viewportArea : 0,
    truncated: flag(element.truncated, `${name}.truncated`),
    paintsOwnSurface: paintsOwnSurfaceOf({
      ...surfaceFacts(element.surface, `${name}.surface`),
      replacedContent: (SURFACE_REPLACED_KINDS as readonly LayoutElementKind[]).includes(facts.kind),
    }),
    pointerEvents: text(element.pointerEvents, `${name}.pointerEvents`),
    ...hitTestField(element.hitTest, `${name}.hitTest`),
  });
}

function validateIncompleteReason(
  reason: BrowserLayoutIncompleteReason | null,
): BrowserLayoutIncompleteReason | null {
  if (reason !== null && reason !== 'DEADLINE_EXCEEDED') {
    throw new Error('Invalid browser layout incompleteReason');
  }
  return reason;
}

/** COV-6: ブラウザが返した部分の件数が、分け方の単位（`LAYOUT_COLLECTION_PART_SIZE`）を超えないことを確かめる（ブラウザ内の分け方と二重に守る）。 */
function assertBoundedPart(list: readonly unknown[], name: string): void {
  if (!Array.isArray(list) || list.length > LAYOUT_COLLECTION_PART_SIZE) {
    throw new Error(`Unbounded browser layout list: ${name}`);
  }
}

/** ブラウザが返した 0 以上の有限の値か null を確かめる（AUD-4a の行の高さと見える行の数）。 */
function optionalMeasure(value: number | null | undefined, name: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    throw new Error(`Invalid browser layout measure: ${name}`);
  }
  nonnegative(value, name);
  return value;
}

/** AUD-4a: 1 以上の整数を表す計算値の数（それ以外は null）。 */
function positiveIntegerOf(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** AUD-4a: 効いている行数の省略の行の数（`ClippedTextEvidence.lineClampCount` の定義）。 */
function lineClampCountOf(style: ClippedTextStyleEvidence): number | null {
  const webkit = WEBKIT_LINE_CLAMP_DISPLAYS.includes(style.display) && style.webkitBoxOrient === 'vertical'
    ? positiveIntegerOf(style.webkitLineClamp)
    : null;
  return webkit ?? positiveIntegerOf(style.lineClamp);
}

/** AUD-4a: 意図した省略の形の区分（`INTENDED_CLIPPING_KINDS` の当てはめる順。書き方の事実だけで決め、外すかは Rule が決める）。 */
function intendedClippingOf(
  style: ClippedTextStyleEvidence,
  lineClampCount: number | null,
  collapsedByControl: boolean,
): IntendedClippingKind | null {
  if (collapsedByControl) {
    return 'COLLAPSED';
  }
  if (lineClampCount !== null) {
    return 'LINE_CLAMP';
  }
  return style.textOverflow === 'ellipsis' && NO_WRAP_WHITE_SPACES.includes(style.whiteSpace) ? 'INTENDED_ELLIPSIS' : null;
}

/** AUD-4a: ブラウザが返した省略の書き方の計算値を確かめる。 */
function clippingStyleOf(style: ClippedTextStyleEvidence, name: string): ClippedTextStyleEvidence {
  if (typeof style !== 'object' || style === null) {
    throw new Error(`Invalid browser layout clipping style: ${name}`);
  }
  return Object.freeze({
    textOverflow: text(style.textOverflow, `${name}.textOverflow`),
    whiteSpace: text(style.whiteSpace, `${name}.whiteSpace`),
    webkitLineClamp: text(style.webkitLineClamp, `${name}.webkitLineClamp`),
    lineClamp: text(style.lineClamp, `${name}.lineClamp`),
    display: text(style.display, `${name}.display`),
    webkitBoxOrient: text(style.webkitBoxOrient, `${name}.webkitBoxOrient`),
    maxHeight: text(style.maxHeight, `${name}.maxHeight`),
  });
}

function freezeClippedText(candidate: RawClippedTextEvidence, name: string): ClippedTextEvidence {
  nonnegative(candidate.clientWidth, `${name}.clientWidth`);
  nonnegative(candidate.clientHeight, `${name}.clientHeight`);
  nonnegative(candidate.scrollWidth, `${name}.scrollWidth`);
  nonnegative(candidate.scrollHeight, `${name}.scrollHeight`);
  if (candidate.clippingStyle === undefined) {
    throw new Error(`Invalid browser layout clipping style: ${name}`);
  }
  const clippingStyle = clippingStyleOf(candidate.clippingStyle, `${name}.clippingStyle`);
  const collapsedByControl = flag(candidate.collapsedByControl as boolean, `${name}.collapsedByControl`);
  const lineClampCount = lineClampCountOf(clippingStyle);
  return Object.freeze({
    ...candidate,
    selector: validateSelector(candidate.selector, name),
    rect: freezeRect(candidate.rect, `${name}.rect`),
    visibility: freezeVisibility(candidate.visibility, `${name}.visibility`),
    partiallyClippedText: flag(candidate.partiallyClippedText, `${name}.partiallyClippedText`),
    // S-06: 端が箱で切れる、内側のスクロール領域（あるときだけ。前の Evidence の形のまま）。
    ...(candidate.cutScrollRegions === undefined ? {} : {
      cutScrollRegions: Object.freeze(candidate.cutScrollRegions.map((region, index) => Object.freeze({
        selector: validateSelector(region.selector, `${name}.cutScrollRegions[${index}].selector`),
        rect: freezeRect(region.rect, `${name}.cutScrollRegions[${index}].rect`),
      }))),
    }),
    truncated: flag(candidate.truncated, `${name}.truncated`),
    clippingStyle,
    lineHeightPx: optionalMeasure(candidate.lineHeightPx, `${name}.lineHeightPx`),
    visibleLineCount: optionalMeasure(candidate.visibleLineCount, `${name}.visibleLineCount`),
    lineClampCount,
    collapsedByControl,
    intendedClipping: intendedClippingOf(clippingStyle, lineClampCount, collapsedByControl),
  });
}

/**
 * COV-6: ブラウザが返した 1 回の部分の形を確かめる（一覧の件数、次の位置、読み終えた一覧が空であること）。
 * 次の位置は、今の位置より後でなければならない（同じ所を読み続けない。ページが組み込みの関数を書き換えた場合も止まる）。
 */
function validateRawLayoutPart(raw: RawLayoutPart, cursor: LayoutPartCursor): void {
  if (typeof raw !== 'object' || raw === null || typeof raw.next !== 'object' || raw.next === null) {
    throw new Error('Invalid browser layout part');
  }
  for (const name of LAYOUT_PART_LIST_NAMES) {
    assertBoundedPart(raw[name], name);
    const start = cursor[name];
    const next = raw.next[name];
    if (start === null && raw[name].length > 0) {
      throw new Error(`Unexpected browser layout list after it was read: ${name}`);
    }
    if (next !== null && (start === null || count(next, `next.${name}`) <= start)) {
      throw new Error(`Invalid browser layout part position: next.${name}`);
    }
  }
}

/** COV-6: 今の部分の次に読む位置（どの一覧も読み終えていれば `null`）。 */
function nextLayoutPartCursor(raw: RawLayoutPart): LayoutPartCursor | null {
  return LAYOUT_PART_LIST_NAMES.some((name) => raw.next[name] !== null)
    ? Object.freeze(Object.fromEntries(LAYOUT_PART_LIST_NAMES.map((name) => [name, raw.next[name]])) as LayoutPartCursor)
    : null;
}

/** COV-6: 部分ごとの読み取りを、1 つの layout の Evidence にまとめる（文書の項目とスクロール位置は最初の部分のもの）。 */
function assembleLayout(parts: readonly RawLayoutPart[]): LayoutEvidence {
  const [raw] = parts;
  if (raw === undefined) {
    throw new Error('Layout collection produced no part');
  }
  finite(raw.scrollPosition.scrollX, 'scrollPosition.scrollX');
  finite(raw.scrollPosition.scrollY, 'scrollPosition.scrollY');
  const scrollPosition = Object.freeze({
    scrollX: raw.scrollPosition.scrollX,
    scrollY: raw.scrollPosition.scrollY,
  });
  const { viewportHorizontalClip, ...documentSizes } = raw.document;
  for (const [name, value] of Object.entries(documentSizes)) {
    if (name === 'horizontalOverflowPx') {
      finite(value, `document.${name}`);
    } else {
      nonnegative(value, `document.${name}`);
    }
  }
  const horizontalOverflowPx = Math.max(
    0,
    raw.document.documentElementScrollWidth,
    raw.document.bodyScrollWidth,
  ) - raw.document.viewportWidth;
  const documentEvidence = Object.freeze({
    ...raw.document,
    horizontalOverflowPx: Math.max(0, horizontalOverflowPx),
    viewportHorizontalClip: validateHorizontalClipAncestor(viewportHorizontalClip, 'document.viewportHorizontalClip'),
  });
  const allOf = <T>(read: (part: RawLayoutPart) => readonly T[]): readonly T[] => parts.flatMap(read);
  const outsideCandidates = allOf((part) => part.boxesOutsideViewport);
  const boxesOutsideViewport = Object.freeze(outsideCandidates
    .map((candidate, index) => Object.freeze({
      ...candidate,
      selector: validateSelector(candidate.selector, `boxesOutsideViewport[${index}]`),
      kind: validateKind(candidate.kind, `boxesOutsideViewport[${index}].kind`),
      rect: freezeRect(candidate.rect, `boxesOutsideViewport[${index}].rect`),
      visibility: freezeVisibility(candidate.visibility, `boxesOutsideViewport[${index}].visibility`),
      horizontalClipAncestor: validateHorizontalClipAncestor(
        candidate.horizontalClipAncestor,
        `boxesOutsideViewport[${index}]`,
      ),
      nearestListedAncestorIndex: validateListedAncestorIndex(
        candidate.nearestListedAncestorIndex,
        index,
        outsideCandidates.length,
        `boxesOutsideViewport[${index}]`,
      ),
      outside: Object.freeze({ ...candidate.outside }),
      truncated: flag(candidate.truncated, `boxesOutsideViewport[${index}].truncated`),
    })));
  const zeroSizeInteractive = Object.freeze(allOf((part) => part.zeroSizeInteractive)
    .map((candidate, index) => Object.freeze({
      ...candidate,
      selector: validateSelector(candidate.selector, `zeroSizeInteractive[${index}]`),
      rect: freezeRect(candidate.rect, `zeroSizeInteractive[${index}].rect`),
      visibility: freezeVisibility(candidate.visibility, `zeroSizeInteractive[${index}].visibility`),
      hasRenderedDescendant: flag(candidate.hasRenderedDescendant, `zeroSizeInteractive[${index}].hasRenderedDescendant`),
      truncated: flag(candidate.truncated, `zeroSizeInteractive[${index}].truncated`),
    })));
  const clippedText = Object.freeze(allOf((part) => part.clippedText)
    .map((candidate, index) => freezeClippedText(candidate, `clippedText[${index}]`)));
  const fixedHeadingOverlaps = Object.freeze(allOf((part) => part.fixedHeadingOverlaps)
    .map(({ hitTest, coveredScrollContainer, ...candidate }, index) => Object.freeze({
      ...candidate,
      overlaySelector: validateSelector(candidate.overlaySelector, `fixedHeadingOverlaps[${index}].overlay`),
      headingSelector: validateSelector(candidate.headingSelector, `fixedHeadingOverlaps[${index}].heading`),
      overlayRect: freezeRect(candidate.overlayRect, `fixedHeadingOverlaps[${index}].overlayRect`),
      headingRect: freezeRect(candidate.headingRect, `fixedHeadingOverlaps[${index}].headingRect`),
      overlayVisibility: freezeVisibility(
        candidate.overlayVisibility,
        `fixedHeadingOverlaps[${index}].overlayVisibility`,
      ),
      headingVisibility: freezeVisibility(
        candidate.headingVisibility,
        `fixedHeadingOverlaps[${index}].headingVisibility`,
      ),
      intersection: freezeIntersection(candidate.intersection, `fixedHeadingOverlaps[${index}].intersection`),
      truncated: flag(candidate.truncated, `fixedHeadingOverlaps[${index}].truncated`),
      ...hitTestField(hitTest, `fixedHeadingOverlaps[${index}].hitTest`),
      ...scrollContainerField(coveredScrollContainer, `fixedHeadingOverlaps[${index}].coveredScrollContainer`),
    })));
  const elementOverlaps = Object.freeze(allOf((part) => part.elementOverlaps)
    .map((candidate, index) => Object.freeze({
      first: freezeElement(candidate.first, `elementOverlaps[${index}].first`),
      second: freezeElement(candidate.second, `elementOverlaps[${index}].second`),
      intersection: freezeIntersection(candidate.intersection, `elementOverlaps[${index}].intersection`),
      truncated: flag(candidate.truncated, `elementOverlaps[${index}].truncated`),
      ...hitTestField(candidate.hitTest, `elementOverlaps[${index}].hitTest`),
      ...scrollContainerField(candidate.coveredScrollContainer, `elementOverlaps[${index}].coveredScrollContainer`),
      ...lineOverlapField(candidate.lineOverlap, `elementOverlaps[${index}].lineOverlap`),
      ...placementField(candidate.placement, `elementOverlaps[${index}].placement`),
    })));
  const fixedElements = Object.freeze(allOf((part) => part.fixedElements)
    .map((candidate, index) => freezeFixedElement(candidate, documentEvidence, `fixedElements[${index}]`)));
  const keyActionElements = Object.freeze(allOf((part) => part.keyActionElements).flatMap((candidate, index) => freezeKeyActionElement(candidate, `keyActionElements[${index}]`)));
  const sumOf = (name: 'clippedTextNodeScanLimitReachedCount' | 'renderedDescendantScanLimitReachedCount'): number => parts
    .reduce((sum, part, index) => sum + count(part.truncation[name], `parts[${index}].truncation.${name}`), 0);

  return Object.freeze({
    scrollPosition,
    document: documentEvidence,
    boxesOutsideViewport,
    zeroSizeInteractive,
    clippedText,
    fixedHeadingOverlaps,
    elementOverlaps,
    fixedElements,
    // COV-6: 候補を件数の上限で打ち切らないので、`omitted*Count` は 0（古い記録を読むためだけに残す）。
    truncation: Object.freeze({
      omittedOutsideViewportCount: 0,
      omittedZeroSizeInteractiveCount: 0,
      omittedClippedTextCount: 0,
      omittedFixedHeadingOverlapCount: 0,
      omittedElementOverlapCount: 0,
      omittedFixedElementCount: 0,
      overlapComparisonLimitReached: parts.some((part, index) => flag(
        part.truncation.overlapComparisonLimitReached,
        `parts[${index}].truncation.overlapComparisonLimitReached`,
      )),
      clippedTextNodeScanLimitReachedCount: sumOf('clippedTextNodeScanLimitReachedCount'),
      renderedDescendantScanLimitReachedCount: sumOf('renderedDescendantScanLimitReachedCount'),
    }),
    collectedInParts: parts.length,
    keyActionElements,
  });
}

const nullableText = (value: string | null, name: string): string | null => (value === null ? null : maskContactValues(text(value, name)));

/**
 * BS-2: ブラウザが返した押せる要素のうち、主要な行動の候補（`keyActionKindOf` が種類を返すもの）だけを、記録の形にする（行き先は scheme とホストだけ。文字の
 * 電話番号とメールアドレスは伏せる）。候補でなければ空。
 */
function freezeKeyActionElement(raw: RawKeyActionElement, name: string): readonly KeyActionElementEvidence[] {
  const target = keyActionHrefTargetOf(raw.href === null ? null : text(raw.href, `${name}.href`));
  const facts = { text: text(raw.text, `${name}.text`), ariaLabel: nullableText(raw.ariaLabel, `${name}.ariaLabel`), title: nullableText(raw.title, `${name}.title`), ...target };
  if (keyActionKindOf(facts) === null) {
    return [];
  }
  return [Object.freeze({
    selector: validateSelector(raw.selector, name),
    tagName: text(raw.tagName, `${name}.tagName`),
    role: raw.role === null ? null : text(raw.role, `${name}.role`),
    ...facts,
    text: maskContactValues(facts.text),
    rect: freezeRect(raw.rect, `${name}.rect`),
    visible: flag(raw.visible, `${name}.visible`),
    fixedContainerSelector: raw.fixedContainerSelector === null ? null : validateSelector(raw.fixedContainerSelector, `${name}.fixedContainerSelector`),
  })];
}

interface LayoutEvaluationArgument {
  readonly thresholds: typeof LAYOUT_THRESHOLDS;
  readonly visibilityOptions: typeof VISIBILITY_CHECK_OPTIONS;
  readonly kindSelectors: typeof LAYOUT_ELEMENT_KIND_SELECTORS;
  /** 固定要素とみなす `position` の値（`FIXED_ELEMENT_POSITIONS`）。ブラウザ内では import できないため、引数で渡す。 */
  readonly fixedPositions: typeof FIXED_ELEMENT_POSITIONS;
  /** 祖先の `overflow-x` ごとの、横方向の切り取りの種類（`HORIZONTAL_CLIP_BY_OVERFLOW`）。 */
  readonly horizontalClipByOverflow: typeof HORIZONTAL_CLIP_BY_OVERFLOW;
  /** ブラウザ内の走査を止める時刻（`Date.now()` の絶対時刻）。呼び出し側の期限がなければ null（止めない）。 */
  readonly scanDeadlineAtMs: number | null;
  /** COV-6: 一覧ごとの、この回に読み始める位置（`null` は読み終えた一覧）。 */
  readonly cursor: LayoutPartCursor;
  /** COV-6: この回に一覧ごとに返す最大の件数（`LAYOUT_COLLECTION_PART_SIZE`）。 */
  readonly partSize: number;
  /** BS-2: 押せる要素の selector（`KEY_ACTION_ELEMENT_SELECTOR`）。 */
  readonly keyActionSelector: string;
}

/**
 * ブラウザ内で、ジオメトリの事実を1回の走査で集める。
 * COV-6: 候補は件数の上限で打ち切らない。一覧ごとに、続きの位置（`cursor`）から `partSize` 件だけの selector などを作って返し、次に読む位置を
 * `next` で返す（兄弟の順番は親ごとに1回だけ数える。要素数に比例する作業量）。重なりは、すべての組を比べる（比べる組の数で打ち切らない）。
 * 読み終えた一覧（`cursor` が `null`）は、その作業を省く。候補の中のテキストと子孫の走査も、数で打ち切らない。
 * 呼び出し側の期限があり、それを過ぎたら走査を止め、それまでに集めた事実と理由を返す（期限がなければ止めない）。
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function collectLayoutReader(R: StandardReaders, {
  thresholds,
  visibilityOptions,
  kindSelectors,
  fixedPositions,
  horizontalClipByOverflow,
  scanDeadlineAtMs,
  cursor,
  partSize,
  keyActionSelector,
}: LayoutEvaluationArgument): RawLayoutPart {
  // COV-6: 一覧を読むか（読み終えていないか）と、一覧の中の番号がこの回に返す範囲にあるか。
  const wants = (name: keyof LayoutPartCursor): boolean => cursor[name] !== null;
  const inPart = (name: keyof LayoutPartCursor, index: number): boolean => {
    const start = cursor[name];
    return start !== null && index >= start && index < start + partSize;
  };
  /** COV-6: 番号で数える一覧の、次に読む位置（この回に返した分の後に、まだ候補が残っていればその番号。なければ null）。 */
  const nextOf = (name: keyof LayoutPartCursor, total: number, returned: number): number | null => {
    const start = cursor[name];
    return start !== null && returned > 0 && start + returned < total ? start + returned : null;
  };
  const wantsObservedElements = wants('fixedHeadingOverlaps') || wants('elementOverlaps') || wants('fixedElements');
  // DOM clobbering（DEF-072・DEF-073）: form の中の名前つきの入力の欄は form の、名前つきの img・form などは `document` の、同じ名前の
  // プロパティとメソッドを隠す（`<input name="matches">`、`<img name="body">` など）。form になりうる要素（文書のすべての要素と、その祖先・子孫・
  // 兄弟）と `document` の標準のプロパティとメソッドは、標準の prototype の getter とメソッドで読む（`src/evidence/dom-collector.ts` の
  // `collectDomEvidence` と同じ読み方。getter は部品の `standardGetter`。`src/browser/in-page-readers.ts`。CC-068）。
  // html・body は、名前つきの子でプロパティが隠れないので、そのまま読む。
  const { standardGetter } = R;
  const parentElementOf = standardGetter<HTMLElement | null>(Node.prototype, 'parentElement');
  const childrenOf = standardGetter<HTMLCollection>(Element.prototype, 'children');
  const tagNameOf = standardGetter<string>(Element.prototype, 'tagName');
  const idOf = standardGetter<string>(Element.prototype, 'id');
  const clientLeftOf = standardGetter<number>(Element.prototype, 'clientLeft');
  const clientTopOf = standardGetter<number>(Element.prototype, 'clientTop');
  const clientWidthOf = standardGetter<number>(Element.prototype, 'clientWidth');
  const clientHeightOf = standardGetter<number>(Element.prototype, 'clientHeight');
  const scrollWidthOf = standardGetter<number>(Element.prototype, 'scrollWidth');
  const scrollHeightOf = standardGetter<number>(Element.prototype, 'scrollHeight');
  const hiddenOf = standardGetter<boolean | string>(HTMLElement.prototype, 'hidden');
  const innerTextOf = standardGetter<string>(HTMLElement.prototype, 'innerText');
  /**
   * EV-4: 見切れの候補の表示の値。閉じた選択の部品（`multiple` でなく `size` が 1 以下の `select`）は、選んだ選択肢の文字（innerText は全部の選択肢を
   * つなげた文字になるため）。ほかは innerText。
   */
  const displayedTextOf = (element: HTMLElement): string => {
    if (element instanceof HTMLSelectElement && !standardGetter<boolean>(HTMLSelectElement.prototype, 'multiple')(element)
      && standardGetter<number>(HTMLSelectElement.prototype, 'size')(element) <= 1) {
      const [selected] = Array.from(standardGetter<HTMLCollectionOf<HTMLOptionElement>>(HTMLSelectElement.prototype, 'selectedOptions')(element));
      return selected === undefined ? '' : standardGetter<string>(HTMLOptionElement.prototype, 'label')(selected);
    }
    return innerTextOf(element);
  };
  const getAttributeOf = (element: Element, name: string): string | null => Element.prototype.getAttribute.call(element, name);
  const matchesOf = (element: Element, selectors: string): boolean => Element.prototype.matches.call(element, selectors);
  const containsOf = (node: Node, other: Node): boolean => Node.prototype.contains.call(node, other);
  const checkVisibilityOf = (element: Element, options: CheckVisibilityOptions): boolean => (
    Element.prototype.checkVisibility.call(element, options)
  );
  const boundingClientRectOf = (element: Element): DOMRect => Element.prototype.getBoundingClientRect.call(element);
  const clientRectsOf = (element: Element): DOMRectList => Element.prototype.getClientRects.call(element);
  const documentElement = standardGetter<HTMLElement>(Document.prototype, 'documentElement')(document);
  const documentBody = standardGetter<HTMLElement | null>(Document.prototype, 'body')(document);
  const scrollingElement = standardGetter<Element | null>(Document.prototype, 'scrollingElement')(document);
  const createTreeWalker = (root: Node, whatToShow: number): TreeWalker => (
    Document.prototype.createTreeWalker.call(document, root, whatToShow)
  );
  const createRange = (): Range => Document.prototype.createRange.call(document);

  const actualViewport = { width: window.innerWidth, height: window.innerHeight };
  // 文書のスクロール位置（`ScrollPosition` の定義）。`scrollingElement` ではない body のスクロール量を含める。
  const scrollingRoot = scrollingElement ?? documentElement;
  const separateScrollBody = documentBody !== null && documentBody !== scrollingRoot ? documentBody : null;
  const scrollPosition = {
    scrollX: window.scrollX + (separateScrollBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateScrollBody?.scrollTop ?? 0),
  };
  let incompleteReason: 'DEADLINE_EXCEEDED' | null = null;
  const deadlinePassed = (): boolean => {
    if (incompleteReason === null && scanDeadlineAtMs !== null && Date.now() >= scanDeadlineAtMs) {
      incompleteReason = 'DEADLINE_EXCEEDED';
    }
    return incompleteReason !== null;
  };
  const normalize = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  // 同じ親の子の `nth-of-type` の番号を、親ごとに1回だけ数えて覚える。
  const nthOfTypeIndexes = new Map<Element, number>();
  const nthOfType = (element: Element): number => {
    const known = nthOfTypeIndexes.get(element);
    if (known !== undefined) {
      return known;
    }
    const parent = parentElementOf(element);
    if (parent === null) {
      return 1;
    }
    const counts = new Map<string, number>();
    for (const child of childrenOf(parent)) {
      const childTagName = tagNameOf(child);
      const next = (counts.get(childTagName) ?? 0) + 1;
      counts.set(childTagName, next);
      nthOfTypeIndexes.set(child, next);
    }
    return nthOfTypeIndexes.get(element) ?? 1;
  };
  const selectorFor = (element: Element): { selector: string; truncated: boolean } => {
    let selector: string;
    const id = idOf(element);
    if (id.length > 0) {
      selector = `#${CSS.escape(id)}`;
    } else {
      const segments: string[] = [];
      let current: Element | null = element;
      while (
        current !== null
        && current !== documentElement
        && segments.length < thresholds.maxSelectorDepth
      ) {
        segments.unshift(`${tagNameOf(current).toLowerCase()}:nth-of-type(${nthOfType(current)})`);
        current = parentElementOf(current);
      }
      selector = segments.join(' > ');
    }
    // LZ-2: セレクタの長さの上限（前は `MAX_SELECTOR_LENGTH`）は置かない。切り詰めない。
    return { selector, truncated: false };
  };
  const rectFor = (element: Element): RectangleEvidence => {
    const rect = boundingClientRectOf(element);
    return {
      x: rect.x,
      y: rect.y,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  };
  // 可視判定は checkVisibility だけで行う（設計書 foundation-corrections 5.5）。
  // 大きさが0であること（rect）と aria-hidden は、可視判定に含めず、別の項目として記録する。
  const visibilityFor = (
    element: Element,
    style: CSSStyleDeclaration,
    visible: boolean,
    clippedToZeroArea: boolean,
  ): VisibilityEvidence => ({
    visible,
    display: style.display,
    visibility: style.visibility,
    opacity: Number.parseFloat(style.opacity),
    hiddenAttribute: element instanceof HTMLElement ? hiddenOf(element) !== false : false,
    ariaHidden: getAttributeOf(element, 'aria-hidden') === 'true',
    clientRectCount: clientRectsOf(element).length,
    clippedToZeroArea,
  });
  // DEF-205: 要素自身の `clip`・`clip-path` で、描く面が 0 になるか（`VisibilityEvidence.clippedToZeroArea`）。読めない書き方は偽（今までどおり数える）。
  // 長さは px と %（% は箱の幅・高さに対する割合）だけを読む。
  const lengthPx = (token: string, reference: number): number | null => {
    const match = /^(-?\d*\.?\d+(?:e[+-]?\d+)?)(px|%)$/u.exec(token);
    if (match === null) {
      return token === '0' ? 0 : null;
    }
    const value = Number.parseFloat(match[1] ?? '');
    return match[2] === '%' ? (value * reference) / 100 : value;
  };
  const functionArguments = (value: string, name: string): string | null => {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed.startsWith(`${name}(`)) {
      return null;
    }
    const close = trimmed.indexOf(')');
    return close < 0 ? null : trimmed.slice(name.length + 1, close);
  };
  const ownClipLeavesNoArea = (element: Element, style: CSSStyleDeclaration): boolean => {
    const clip = style.clip.trim().toLowerCase();
    const clipPath = style.clipPath.trim().toLowerCase();
    const clipApplies = clip !== '' && clip !== 'auto' && (style.position === 'absolute' || style.position === 'fixed');
    if (!clipApplies && (clipPath === '' || clipPath === 'none')) {
      return false;
    }
    const box = boundingClientRectOf(element);
    if (clipApplies) {
      // `rect(上, 右, 下, 左)`。`auto` は、上と左は 0、右は幅、下は高さ。
      const parts = (functionArguments(clip, 'rect') ?? '').split(/[\s,]+/u).filter((part) => part.length > 0);
      if (parts.length === 4) {
        const edge = (index: number, auto: number): number | null => {
          const part = parts[index] ?? '';
          return part === 'auto' ? auto : lengthPx(part, 0);
        };
        const [top, right, bottom, left] = [edge(0, 0), edge(1, box.width), edge(2, box.height), edge(3, 0)];
        if (top !== null && right !== null && bottom !== null && left !== null && (right - left <= 0 || bottom - top <= 0)) {
          return true;
        }
      }
    }
    const inset = functionArguments(clipPath, 'inset');
    if (inset !== null) {
      const parts = (inset.split(' round ')[0] ?? '').split(/\s+/u).filter((part) => part.length > 0);
      if (parts.length < 1 || parts.length > 4) {
        return false;
      }
      // 1〜4 個の値を、上・右・下・左に広げる（CSS の margin と同じ）。
      const [a, b = a, c = a, d = b] = parts as [string, string?, string?, string?];
      const top = lengthPx(a, box.height);
      const right = lengthPx(b ?? '', box.width);
      const bottom = lengthPx(c ?? '', box.height);
      const left = lengthPx(d ?? '', box.width);
      return top !== null && right !== null && bottom !== null && left !== null
        && (top + bottom >= box.height || left + right >= box.width);
    }
    // 半径は、値が 0 のときだけ面が 0（% の基準を 1 にして、0 でない % を 0 にしない）。
    const circle = functionArguments(clipPath, 'circle');
    if (circle !== null) {
      const radius = (circle.split(' at ')[0] ?? '').trim();
      return radius !== '' && lengthPx(radius, 1) === 0;
    }
    const ellipse = functionArguments(clipPath, 'ellipse');
    if (ellipse !== null) {
      const radii = (ellipse.split(' at ')[0] ?? '').trim().split(/\s+/u).filter((part) => part.length > 0);
      return radii.length === 2 && radii.some((radius) => lengthPx(radius, 1) === 0);
    }
    return false;
  };
  const kindOf = (element: Element): LayoutElementKind => {
    for (const [kind, selector] of kindSelectors) {
      if (matchesOf(element, selector)) {
        return kind;
      }
    }
    return 'other';
  };
  const isFixedOrSticky = (position: string): boolean => (fixedPositions as readonly string[]).includes(position);
  const intersectsViewport = (rect: RectangleEvidence): boolean => (
    Math.min(rect.right, actualViewport.width) - Math.max(rect.left, 0)
      > thresholds.minViewportIntersectionDimensionPx
    && Math.min(rect.bottom, actualViewport.height) - Math.max(rect.top, 0)
      > thresholds.minViewportIntersectionDimensionPx
  );
  const intersectionOf = (
    first: RectangleEvidence,
    second: RectangleEvidence,
  ): (RectangleEvidence & { area: number }) | null => {
    const left = Math.max(first.left, second.left);
    const top = Math.max(first.top, second.top);
    const right = Math.min(first.right, second.right);
    const bottom = Math.min(first.bottom, second.bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    const area = width * height;
    return area >= thresholds.minOcclusionAreaPx2
      ? { x: left, y: top, top, right, bottom, left, width, height, area }
      : null;
  };

  // 祖先の overflow による切り取り（R4 の M3、RT12 の I1）。切り取りうる祖先の決まりは、部品 `R.clippingAncestorsOf` の 1 か所（TII: 対象まで動かして撮る
  // 部品と共有する。段数では打ち切らない）。
  const horizontalClipOf = (overflow: string): Exclude<HorizontalClipAncestorKind, 'NONE'> | undefined => (
    Object.hasOwn(horizontalClipByOverflow, overflow)
      ? horizontalClipByOverflow[overflow as keyof typeof horizontalClipByOverflow]
      : undefined
  );
  const clippingOverflows = new Set<string>(Object.keys(horizontalClipByOverflow));
  const clippingAncestorsOf = R.clippingAncestorsOf;
  // 重なりの候補を集めるときに、祖先で切り取った後に見える部分が残るかを確かめる（R4 の M3）。
  const hasVisibleAreaAfterAncestorClip = (element: Element, style: CSSStyleDeclaration, rect: RectangleEvidence): boolean => {
    let { left, top, right, bottom } = rect;
    const remains = (): boolean => (
      right - left > thresholds.maxZeroSizeDimensionPx && bottom - top > thresholds.maxZeroSizeDimensionPx
    );
    for (const [ancestor, ancestorStyle] of clippingAncestorsOf(element, style)) {
      const box = boundingClientRectOf(ancestor);
      const boxLeft = box.left + clientLeftOf(ancestor);
      const boxTop = box.top + clientTopOf(ancestor);
      if (clippingOverflows.has(ancestorStyle.overflowX)) {
        left = Math.max(left, boxLeft);
        right = Math.min(right, boxLeft + clientWidthOf(ancestor));
      }
      if (clippingOverflows.has(ancestorStyle.overflowY)) {
        top = Math.max(top, boxTop);
        bottom = Math.min(bottom, boxTop + clientHeightOf(ancestor));
      }
      if (!remains()) {
        return false;
      }
    }
    return remains();
  };
  // ビューポートの横方向の overflow（設計書 5.1.2、RT12c）。CSS Overflow の仕様に従い、html の `overflow` が両方向とも
  // `visible` なら body の値が、そうでなければ html の値が、ビューポートに伝わる。`visible` は `NONE` にする。
  const rootStyle = window.getComputedStyle(documentElement);
  const bodyStyle = documentBody instanceof HTMLBodyElement ? window.getComputedStyle(documentBody) : null;
  const bodyPropagatesToViewport = bodyStyle !== null
    && rootStyle.overflowX === 'visible'
    && rootStyle.overflowY === 'visible';
  const viewportHorizontalClip: HorizontalClipAncestorKind = horizontalClipOf(
    (bodyPropagatesToViewport ? bodyStyle : rootStyle).overflowX,
  ) ?? 'NONE';
  // 祖先としての html・body の横方向の切り取り。ビューポートが切り取るか、ビューポートに伝わらない body の
  // `overflow-x` が `hidden`・`clip` なら、はみ出した部分は切り取られる。
  // `auto`・`scroll` は、ビューポートのスクロールと同じなので、切り取りに数えない（文書の横のはみ出しとして扱う）。
  const documentRootHorizontalClip: HorizontalClipAncestorKind = viewportHorizontalClip === 'CLIPPED'
    || (bodyStyle !== null && !bodyPropagatesToViewport && horizontalClipOf(bodyStyle.overflowX) === 'CLIPPED')
    ? 'CLIPPED'
    : 'NONE';
  // 横方向に最も近い、overflow-x が visible 以外の祖先の種類（設計書 5.1.2）。
  const horizontalClipAncestorOf = (element: Element, style: CSSStyleDeclaration): HorizontalClipAncestorKind => {
    if (style.position === 'fixed') {
      return 'NONE';
    }
    for (const [, ancestorStyle] of clippingAncestorsOf(element, style)) {
      const kind = horizontalClipOf(ancestorStyle.overflowX);
      if (kind !== undefined) {
        return kind;
      }
      if (ancestorStyle.position === 'fixed') {
        return 'NONE';
      }
    }
    return documentRootHorizontalClip;
  };
  const hasText = (value: string | null): boolean => value !== null && /\S/u.test(value);
  // 子孫のテキストが、要素の箱（padding box）で切り取られているか（設計書 5.1.2、RT12 の I2、RT12r の N1）。
  // 縦方向: 行の矩形はフォントの内容領域の高さを持ち、行の高さと一致しないので、箱の外に出た量が行の高さの一定の割合を超える行だけを数える。
  // 横方向: このずれがないので、箱の外に出た量が、文字の少しの張り出しとして許す固定の値を超える行を数える（RT12d の発見事項2）。
  // どちらの方向も、箱の片側ずつに出た量を比べ、両側の量を合計しない（RT12r2 の I1）。
  // 見えない要素（`VISIBILITY_CHECK_OPTIONS` の `checkVisibility` が偽の要素）の中のテキストは、判定に使わない（RT12r2 の M1）。
  // S-06: 文字とこの箱の間にスクロールできる祖先があれば、文字の行ではなく、その祖先（いちばん外側）の箱で判定する。祖先の箱が箱に収まれば、内側のスクロールで
  // 見えるので数えない。はみ出せば、その祖先を「内側のスクロール領域の端が箱で切れる」領域として返す（`cutScrollRegions`）。
  const textLineClipOf = (
    element: HTMLElement,
    rect: RectangleEvidence,
    widthClipped: boolean,
    heightClipped: boolean,
  ): { readonly clipped: boolean; readonly cutScrollRegions: readonly Element[] } => {
    const left = rect.left + clientLeftOf(element);
    const top = rect.top + clientTopOf(element);
    const right = left + clientWidthOf(element);
    const bottom = top + clientHeightOf(element);
    const epsilon = thresholds.geometryEpsilonPx;
    const minOutsideRatio = thresholds.clippedTextLineMinOutsideRatio;
    const maxIgnoredHorizontalOverflow = thresholds.clippedTextLineMaxIgnoredHorizontalOverflowPx;
    /** 行の [start, end) が、箱の [boxStart, boxEnd) の始まりの側か終わりの側の外に、limit を超えて出ているか（片側ずつ比べる）。 */
    const sticksOutBeyond = (start: number, end: number, boxStart: number, boxEnd: number, limit: number): boolean => (
      boxStart - start > limit || end - boxEnd > limit
    );
    // 要素から箱までの間（箱は含まない）の、いちばん外側のスクロールできる祖先（なければ null）。祖先ごとに 1 回だけ調べる。
    const outermostScrollers = new Map<Element, Element | null>([[element, null]]);
    const outermostScrollerOf = (node: Element | null): Element | null => {
      if (node === null) {
        return null;
      }
      const known = outermostScrollers.get(node);
      if (known !== undefined) {
        return known;
      }
      const outer = outermostScrollerOf(parentElementOf(node));
      const found = outer ?? (R.isScrollableBox(node) ? node : null);
      outermostScrollers.set(node, found);
      return found;
    };
    // スクロールできる祖先ごとの判定（箱からはみ出すか）。はみ出す祖先は、見つけた順に `cutScrollRegions` に入れる。
    const scrollerVerdicts = new Map<Element, boolean>();
    const cutScrollRegions: Element[] = [];
    const scrollerSticksOut = (scroller: Element): boolean => {
      const known = scrollerVerdicts.get(scroller);
      if (known !== undefined) {
        return known;
      }
      const box = boundingClientRectOf(scroller);
      const overlapsHorizontally = Math.min(box.right, right) - Math.max(box.left, left) > epsilon;
      const sticksOut = overlapsHorizontally && (
        (heightClipped && sticksOutBeyond(box.top, box.bottom, top, bottom, epsilon))
        || (widthClipped && sticksOutBeyond(box.left, box.right, left, right, maxIgnoredHorizontalOverflow))
      );
      scrollerVerdicts.set(scroller, sticksOut);
      if (sticksOut) {
        cutScrollRegions.push(scroller);
      }
      return sticksOut;
    };
    const walker = createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = createRange();
    // 箱の中に見える行があったか。箱の上か下に丸ごと出た行があったか（見える行が見つかるまで、判定を保留する）。
    let visibleLineFound = false;
    let lineWhollyAboveOrBelow = false;
    let clipped = false;
    // COV-6: テキストのノードの数で打ち切らない（打ち切ると、見切れを見落とす）。期限を過ぎたら、この回の走査ごと止める（`PARTIAL`）。
    for (let node = walker.nextNode(); node !== null && !deadlinePassed(); node = walker.nextNode()) {
      const textParent = parentElementOf(node);
      if (!hasText(node.nodeValue) || (textParent !== null && !checkVisibilityOf(textParent, visibilityOptions))) {
        continue;
      }
      const scroller = outermostScrollerOf(textParent);
      if (scroller !== null) {
        scrollerSticksOut(scroller);
        continue;
      }
      // 箱の文字切れが決まった後は、はみ出すスクロールの領域だけを探し続ける（取りこぼさない）。
      if (clipped) {
        continue;
      }
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        const overlapsHorizontally = Math.min(line.right, right) - Math.max(line.left, left) > epsilon;
        const overlapsVertically = Math.min(line.bottom, bottom) - Math.max(line.top, top) > epsilon;
        if (overlapsHorizontally && overlapsVertically) {
          if (
            (widthClipped && sticksOutBeyond(line.left, line.right, left, right, maxIgnoredHorizontalOverflow))
            || (heightClipped
              && sticksOutBeyond(line.top, line.bottom, top, bottom, (line.bottom - line.top) * minOutsideRatio))
          ) {
            clipped = true;
            break;
          }
          visibleLineFound = true;
        } else if (heightClipped && overlapsHorizontally && !overlapsVertically) {
          lineWhollyAboveOrBelow = true;
        }
        if (visibleLineFound && lineWhollyAboveOrBelow) {
          clipped = true;
          break;
        }
      }
    }
    return { clipped, cutScrollRegions };
  };
  // 子孫に、可視で大きさのある要素があるか（設計書 5.1.2、RT12 の I3）。幅か高さが 1 px 以下の子孫（visually hidden）は数えない（RT12r の N5）。
  // 文書の左か上の外に丸ごと置かれた子孫（文書の座標で、右端か下端が 0 以下のもの。`left:-9999px` など）も数えない（RT12r2 の M2）。
  // ただし、候補自身が文書の外にある場合は、そうした子孫も数える（RT12r3 の m1）。`translate3d` で文書の外へ動かした
  // カルーセルのスライドの中のリンクを、誤って報告しないためである。候補が文書の外にあるとは、文書の座標で、
  // 「左端が負で、かつ右端が 0 以下」か「上端が負で、かつ下端が 0 以下」であることをいう（設計書 5.1.2）。
  // 幅か高さが 0 の候補が文書の端（0）にある場合は、文書の中とみなす。
  const renderedDescendantOf = (
    element: Element,
    style: CSSStyleDeclaration,
    rect: RectangleEvidence,
  ): { readonly rendered: boolean } => {
    // 大きさが0の方向を、要素自身が overflow で切り取るなら、子孫は見えない。
    if (
      (clippingOverflows.has(style.overflowX) && rect.width <= thresholds.maxZeroSizeDimensionPx)
      || (clippingOverflows.has(style.overflowY) && rect.height <= thresholds.maxZeroSizeDimensionPx)
    ) {
      return { rendered: false };
    }
    const candidateOutsideDocument = (
      rect.left + scrollPosition.scrollX < 0 && rect.right + scrollPosition.scrollX <= 0
    ) || (
      rect.top + scrollPosition.scrollY < 0 && rect.bottom + scrollPosition.scrollY <= 0
    );
    const walker = createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
    // COV-6: 子孫の数で打ち切らない（打ち切ると、描画された子孫のある操作要素を、大きさ0として誤って報告する）。期限を過ぎたら、この回の走査ごと止める。
    for (let node = walker.nextNode(); node !== null && !deadlinePassed(); node = walker.nextNode()) {
      const descendant = node as Element;
      if (!checkVisibilityOf(descendant, visibilityOptions)) {
        continue;
      }
      const box = boundingClientRectOf(descendant);
      if (
        box.width > thresholds.maxUnrenderedDescendantDimensionPx
        && box.height > thresholds.maxUnrenderedDescendantDimensionPx
        && (
          candidateOutsideDocument
          || (box.right + scrollPosition.scrollX > 0 && box.bottom + scrollPosition.scrollY > 0)
        )
      ) {
        return { rendered: true };
      }
    }
    return { rendered: false };
  };

  // AUD-4a: 閉じた折りたたみ。`aria-expanded="false"` の操作要素の `aria-controls` が指す id（空白で区切る）を、1回だけ集める。
  const collapsedControlledIds = new Set<string>();
  if (wants('clippedText')) {
    for (const control of Element.prototype.querySelectorAll.call(documentElement, '[aria-expanded="false"][aria-controls]')) {
      for (const id of (getAttributeOf(control, 'aria-controls') ?? '').split(/\s+/u)) {
        if (id.length > 0) {
          collapsedControlledIds.add(id);
        }
      }
    }
  }
  /** AUD-4a: 要素か祖先の id を、閉じた折りたたみの操作要素が指すか。 */
  const collapsedByControlOf = (element: Element): boolean => {
    if (collapsedControlledIds.size === 0) {
      return false;
    }
    for (let current: Element | null = element; current !== null && current !== documentElement; current = parentElementOf(current)) {
      const id = idOf(current);
      if (id.length > 0 && collapsedControlledIds.has(id)) {
        return true;
      }
    }
    return false;
  };
  /**
   * AUD-4a: 行の高さ（px）。`line-height` の計算値が px ならその値。`normal` などは、箱の中の最初のテキストの行の矩形の高さ
   * （`normal` の行の箱はフォントの内容領域の高さになる）。テキストのノードは、最初の文字のあるノードまで見る。求められなければ null。
   */
  const lineHeightOf = (element: HTMLElement, style: CSSStyleDeclaration): number | null => {
    const declared = /^(\d*\.?\d+)px$/u.exec(style.lineHeight);
    if (declared !== null) {
      return Number.parseFloat(declared[1] ?? '');
    }
    const walker = createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = createRange();
    for (let node = walker.nextNode(); node !== null && !deadlinePassed(); node = walker.nextNode()) {
      if (!hasText(node.nodeValue)) {
        continue;
      }
      range.selectNodeContents(node);
      const [firstLine] = range.getClientRects();
      if (firstLine !== undefined && firstLine.height > 0) {
        return firstLine.height;
      }
    }
    return null;
  };
  /** AUD-4a: 箱の中に見える行の数（内容の高さ ÷ 行の高さ。端数を残す）。 */
  const visibleLineCountOf = (element: HTMLElement, style: CSSStyleDeclaration, lineHeightPx: number | null): number | null => {
    if (lineHeightPx === null || lineHeightPx <= 0) {
      return null;
    }
    const contentHeight = clientHeightOf(element)
      - (Number.parseFloat(style.paddingTop) || 0)
      - (Number.parseFloat(style.paddingBottom) || 0);
    return Math.max(0, contentHeight) / lineHeightPx;
  };

  interface ObservedElement {
    readonly element: Element;
    readonly order: number;
    readonly rect: RectangleEvidence;
    readonly style: CSSStyleDeclaration;
    readonly visibility: VisibilityEvidence;
    readonly kind: LayoutElementKind;
    readonly fixed: boolean;
    readonly fixedOrStickyAncestor: boolean;
  }

  /** この回に返すはみ出しの候補と、その要素（一覧の中の祖先の番号を、最後に求めるため）。 */
  interface OutsideCandidate {
    readonly element: Element;
    readonly evidence: Omit<OutsideViewportEvidence, 'nearestListedAncestorIndex'>;
  }

  const allElements = documentBody === null ? [] : [...documentBody.querySelectorAll('*')];
  // COV-6: はみ出しの候補は、件数の上限で打ち切らず、文書の順にすべてを一覧にする（この回には続きの位置からの分だけを返す）。
  // 一覧の中の祖先の番号を求めるため、すべての候補の要素と、一覧の中の番号を覚える。
  const outsideIndexes = new Map<Element, number>();
  const outsideInPart: OutsideCandidate[] = [];
  const zeroSizeInteractive: ZeroSizeInteractiveEvidence[] = [];
  const clippedText: RawClippedTextEvidence[] = [];
  const headings: ObservedElement[] = [];
  const fixedCandidates: ObservedElement[] = [];
  const primaryElements: ObservedElement[] = [];
  let zeroSizeInteractiveCount = 0;
  let clippedTextCount = 0;
  // BS-2: 押せる要素（見えない要素も含む。主要な行動の候補を選ぶのは Node の側）と、いちばん近い固定の要素（自分を含む）。
  const keyActionElements: RawKeyActionElement[] = [];
  let keyActionElementCount = 0;
  const fixedContainerOf = new Map<Element, Element | null>();
  const anchorHrefOf = standardGetter<string>(HTMLAnchorElement.prototype, 'href');
  const inputValueOf = standardGetter<string>(HTMLInputElement.prototype, 'value');
  // 要素（とその祖先）に `position: fixed | sticky` があるか。親は子より先に走査されるので、親の値を引き継ぐ。
  const withinFixedOrSticky = new Map<Element, boolean>();
  // DEF-205: 要素（とその祖先）の `clip`・`clip-path` で、描く面が 0 になるか。親は子より先に走査されるので、親の値を引き継ぐ
  // （`position: fixed` の要素は、祖先の切り取りの外に出ることがあるので、引き継がない）。
  const clippedToZeroAreaOf = new Map<Element, boolean>();
  if (documentBody !== null) {
    const bodyStyleForScan = window.getComputedStyle(documentBody);
    withinFixedOrSticky.set(documentBody, isFixedOrSticky(bodyStyleForScan.position));
    clippedToZeroAreaOf.set(documentBody, ownClipLeavesNoArea(documentBody, bodyStyleForScan));
  }

  for (const [order, element] of allElements.entries()) {
    if (deadlinePassed()) {
      break;
    }
    const style = window.getComputedStyle(element);
    const fixed = isFixedOrSticky(style.position);
    const parent = parentElementOf(element);
    const fixedOrStickyAncestor = parent !== null && (withinFixedOrSticky.get(parent) ?? false);
    withinFixedOrSticky.set(element, fixed || fixedOrStickyAncestor);
    const clippedToZeroArea = (style.position !== 'fixed' && parent !== null && (clippedToZeroAreaOf.get(parent) ?? false))
      || ownClipLeavesNoArea(element, style);
    clippedToZeroAreaOf.set(element, clippedToZeroArea);
    const visible = checkVisibilityOf(element, visibilityOptions);
    if (wants('keyActionElements')) {
      const fixedContainer = fixed ? element : (parent === null ? null : fixedContainerOf.get(parent) ?? null);
      fixedContainerOf.set(element, fixedContainer);
      if (matchesOf(element, keyActionSelector)) {
        const index = keyActionElementCount;
        keyActionElementCount += 1;
        if (inPart('keyActionElements', index)) {
          const textOf = (): string => {
            if (element instanceof HTMLInputElement) {
              return inputValueOf(element);
            }
            return element instanceof HTMLElement ? innerTextOf(element) : '';
          };
          keyActionElements.push({
            selector: selectorFor(element).selector,
            tagName: tagNameOf(element).toLowerCase(),
            role: getAttributeOf(element, 'role'),
            text: normalize(textOf()),
            ariaLabel: getAttributeOf(element, 'aria-label'),
            title: getAttributeOf(element, 'title'),
            href: element instanceof HTMLAnchorElement && getAttributeOf(element, 'href') !== null ? anchorHrefOf(element) : null,
            rect: rectFor(element),
            visible,
            fixedContainerSelector: fixedContainer === null ? null : selectorFor(fixedContainer).selector,
          });
        }
      }
    }
    if (!visible) {
      continue;
    }
    const rect = rectFor(element);
    const visibility = visibilityFor(element, style, visible, clippedToZeroArea);
    const kind = kindOf(element);

    const outside = {
      left: rect.left < -thresholds.geometryEpsilonPx,
      right: rect.right > actualViewport.width + thresholds.geometryEpsilonPx,
      top: rect.top < -thresholds.geometryEpsilonPx,
      bottom: rect.bottom > actualViewport.height + thresholds.geometryEpsilonPx,
    };
    // REC-1: 一覧に入れるのは、横にはみ出す要素だけ（読む Rule は横のはみ出しだけを見る）。縦だけにはみ出す要素（画面の下に続く要素）は入れない。
    // 一覧の中の祖先の番号は、横にはみ出す祖先を指すので、Rule の「横にはみ出す祖先があるか」の結果は変わらない。
    if (wants('boxesOutsideViewport') && (outside.left || outside.right)) {
      const index = outsideIndexes.size;
      outsideIndexes.set(element, index);
      // selector と祖先をたどる処理は、この回に返す候補だけで行う。
      if (inPart('boxesOutsideViewport', index)) {
        const { selector, truncated } = selectorFor(element);
        outsideInPart.push({
          element,
          evidence: {
            selector,
            kind,
            rect,
            visibility,
            position: style.position,
            zIndex: style.zIndex,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            horizontalClipAncestor: horizontalClipAncestorOf(element, style),
            outside,
            truncated,
          },
        });
      }
    }

    if (
      wants('zeroSizeInteractive')
      && (rect.width <= thresholds.maxZeroSizeDimensionPx || rect.height <= thresholds.maxZeroSizeDimensionPx)
      && matchesOf(element, 'a[href], button, input, select, textarea, [role="button"], [role="link"]')
    ) {
      const index = zeroSizeInteractiveCount;
      zeroSizeInteractiveCount += 1;
      if (inPart('zeroSizeInteractive', index)) {
        const { selector, truncated } = selectorFor(element);
        const descendantScan = renderedDescendantOf(element, style, rect);
        zeroSizeInteractive.push({
          selector,
          tagName: tagNameOf(element).toLowerCase(),
          role: getAttributeOf(element, 'role'),
          rect,
          visibility,
          position: style.position,
          zIndex: style.zIndex,
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          hasRenderedDescendant: descendantScan.rendered,
          truncated,
        });
      }
    }

    if (wants('clippedText') && element instanceof HTMLElement) {
      const widthClipped = clippingOverflows.has(style.overflowX)
        && scrollWidthOf(element) > clientWidthOf(element) + thresholds.geometryEpsilonPx;
      const heightClipped = clippingOverflows.has(style.overflowY)
        && scrollHeightOf(element) > clientHeightOf(element) + thresholds.geometryEpsilonPx;
      if (widthClipped || heightClipped) {
        const text = normalize(displayedTextOf(element));
        if (text.length > 0) {
          const index = clippedTextCount;
          clippedTextCount += 1;
          if (inPart('clippedText', index)) {
            const { selector, truncated } = selectorFor(element);
            const lineCheck = textLineClipOf(element, rect, widthClipped, heightClipped);
            const lineHeightPx = lineHeightOf(element, style);
            clippedText.push({
              selector,
              text,
              tagName: tagNameOf(element).toLowerCase(),
              role: getAttributeOf(element, 'role'),
              rect,
              visibility,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
              position: style.position,
              zIndex: style.zIndex,
              clientWidth: clientWidthOf(element),
              clientHeight: clientHeightOf(element),
              scrollWidth: scrollWidthOf(element),
              scrollHeight: scrollHeightOf(element),
              widthClipped,
              heightClipped,
              partiallyClippedText: lineCheck.clipped,
              // S-06: 端が箱で切れる、内側のスクロール領域（あるときだけ）。
              ...(lineCheck.cutScrollRegions.length === 0 ? {} : {
                cutScrollRegions: lineCheck.cutScrollRegions.map((region) => ({ selector: selectorFor(region).selector, rect: rectFor(region) })),
              }),
              truncated,
              // AUD-4a: 意図した省略を見分けるための事実（区分は Node の側で導く）。
              clippingStyle: {
                textOverflow: style.textOverflow,
                whiteSpace: style.whiteSpace,
                webkitLineClamp: style.getPropertyValue('-webkit-line-clamp'),
                lineClamp: style.getPropertyValue('line-clamp'),
                display: style.display,
                webkitBoxOrient: style.getPropertyValue('-webkit-box-orient'),
                maxHeight: style.maxHeight,
              },
              lineHeightPx,
              visibleLineCount: visibleLineCountOf(element, style, lineHeightPx),
              collapsedByControl: collapsedByControlOf(element),
            });
          }
        }
      }
    }

    if (!wantsObservedElements) {
      continue;
    }
    const observed: ObservedElement = {
      element,
      order,
      rect,
      style,
      visibility,
      kind,
      fixed,
      fixedOrStickyAncestor,
    };
    const heading = matchesOf(element, 'h1, h2, h3, h4, h5, h6');
    const primary = (kind !== 'other' || fixed)
      && rect.width > thresholds.maxZeroSizeDimensionPx
      && rect.height > thresholds.maxZeroSizeDimensionPx;
    // 祖先の overflow で切り取られて見える部分が残らない要素は、重なりの候補にしない（R4 の M3）。
    if ((heading || primary) && !hasVisibleAreaAfterAncestorClip(element, style, rect)) {
      continue;
    }
    if (heading) {
      headings.push(observed);
    }
    if (fixed) {
      fixedCandidates.push(observed);
    }
    if (primary) {
      primaryElements.push(observed);
    }
  }

  // COV-6: 重なりの走査は、比べる組の数で打ち切らない（ユーザーの判断で上限を撤廃した）。すべての組を比べ、見つけた重なりに番号を振り、
  // この回は続きの位置（`cursor`）の番号から `partSize` 件だけを返す（受け渡しの大きさを抑える分け方だけ）。
  const related = (first: Element, second: Element): boolean => (
    first === second || containsOf(first, second) || containsOf(second, first)
  );

  // AUD-3b（整理の文書 `2026-11-09-beaksight-audit-precision-triage.md` の AUD-3b・3c）: 固定要素の重なりの hit-test の事実。ページの中を読むだけ（要求も
  // 読み込みも足さない）。区分は Node の側（`src/audit/fixed-overlap-classes.ts`）が決める。
  const elementsFromPointOf = (x: number, y: number): Element[] => Document.prototype.elementsFromPoint.call(document, x, y);
  /** 要素と祖先の `opacity` の積。 */
  const effectiveOpacityOf = (element: Element): number => {
    let opacity = 1;
    for (let current: Element | null = element; current !== null; current = parentElementOf(current)) {
      const value = Number.parseFloat(window.getComputedStyle(current).opacity);
      if (Number.isFinite(value)) {
        opacity *= value;
      }
    }
    return opacity;
  };
  /** 点の要素と、覆う要素・覆われる要素との関係（覆われる要素の側を先に見る）。 */
  const hitRelationOf = (element: Element, overlay: Element, covered: Element | null): RawOverlapHitLayer['relation'] => {
    if (covered !== null && element === covered) {
      return 'COVERED';
    }
    if (covered !== null && containsOf(covered, element)) {
      return 'COVERED_DESCENDANT';
    }
    if (element === overlay) {
      return 'OVERLAY';
    }
    return containsOf(overlay, element) ? 'OVERLAY_DESCENDANT' : 'OTHER';
  };
  const hitLayerOf = (element: Element, relation: RawOverlapHitLayer['relation']): RawOverlapHitLayer => {
    const style = window.getComputedStyle(element);
    return {
      selector: selectorFor(element).selector,
      relation,
      position: style.position,
      zIndex: style.zIndex,
      pointerEvents: style.pointerEvents,
      effectiveOpacity: effectiveOpacityOf(element),
      visibility: style.visibility,
      backgroundColor: style.backgroundColor,
      hasBackgroundImage: style.backgroundImage.trim().toLowerCase() !== 'none',
      surface: R.ownSurfaceFactsOf(element, style, thresholds.maxOwnTextNodeScan),
      replaced: matchesOf(element, thresholds.replacedContentSelector),
    };
  };
  /** 交わり（ビューポートの中の部分）の中心と、内側に寄せた四隅（EV-2: 点の作り方は部品 `R.hitPointsOf` の 1 か所）。 */
  const hitPointsOf = (area: RectangleEvidence): (readonly [number, number])[] =>
    R.hitPointsOf(area, actualViewport.width, actualViewport.height, thresholds.hitTestPointInsetPx);
  // AUD-2（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 5.1）: 見えているモーダルの小窓と暗転の要素（判定は部品の 1 か所。初めて要るときに 1 回読む）。
  let modalDialogs: { readonly dialog: Element; readonly backdrop: Element | null }[] | null = null;
  let frontWindows: Element[] | null = null;
  /**
   * 覆う要素か祖先が、開いたモーダル（`dialog` の showModal・`aria-modal="true"`）か。AUD-2: 覆う要素が、見えているモーダルの小窓か、その中か、その暗転の要素なら
   * `openModal`。覆われる要素が、その小窓の中にあれば `coveredInside`（小窓の中が塞がる形）。
   */
  const modalOf = (overlay: Element, covered: Element | null): RawOverlapHitTest['modal'] => {
    modalDialogs ??= R.openModalDialogs();
    const owner = modalDialogs.find(({ dialog, backdrop }) => overlay === backdrop || overlay === dialog || containsOf(dialog, overlay));
    // RVP-2: モーダルの小窓でないときは、前面の窓（判定は部品の 1 か所。初めて要るときに 1 回読む）か、その中の要素かを見る。
    frontWindows ??= R.frontWindows(thresholds.frontWindowMinViewportRatio);
    const front = owner === undefined ? frontWindows.find((candidate) => overlay === candidate || containsOf(candidate, overlay)) : undefined;
    const inside = owner?.dialog ?? front;
    const coveredInside = inside !== undefined && covered !== null && (covered === inside || containsOf(inside, covered));
    return {
      ...ancestorModalOf(overlay),
      ...(owner === undefined ? {} : { openModal: true as const }),
      ...(coveredInside ? { coveredInside: true as const } : {}),
      ...(front === undefined ? {} : { frontWindow: true as const }),
    };
  };
  /** 覆う要素か祖先が、開いたモーダル（`dialog` の showModal・`aria-modal="true"`）か。 */
  const ancestorModalOf = (overlay: Element): { dialogModal: boolean; ariaModal: boolean } => {
    let dialogModal = false;
    let ariaModal = false;
    for (let current: Element | null = overlay; current !== null; current = parentElementOf(current)) {
      if (tagNameOf(current) === 'DIALOG') {
        try {
          dialogModal ||= matchesOf(current, ':modal');
        } catch {
          // `:modal` を読めないブラウザでは、モーダルでないものとして扱う（覆いとして数える側）。
        }
      }
      ariaModal ||= getAttributeOf(current, 'aria-modal') === 'true';
    }
    return { dialogModal, ariaModal };
  };
  /**
   * 覆う要素（`overlay`）の hit-test。覆われる要素（`covered`）があれば、点ごとに、最前面から覆われる要素（かその子孫）の手前までの要素を読む。
   * なければ（固定要素だけ）、最前面から、覆う要素の層でも祖先でもない最初の要素（下にある内容）の手前までを読む。覆う要素の祖先は読まない。
   */
  const hitTestOf = (overlay: Element, covered: Element | null, area: RectangleEvidence): RawOverlapHitTest => ({
    target: covered === null ? 'BENEATH' : 'COVERED',
    points: hitPointsOf(area).map(([x, y]) => {
      const stack = elementsFromPointOf(x, y);
      const layers: RawOverlapHitLayer[] = [];
      let targetSelector: string | null = null;
      for (const element of stack) {
        const relation = hitRelationOf(element, overlay, covered);
        if (relation === 'COVERED' || relation === 'COVERED_DESCENDANT') {
          targetSelector = selectorFor(covered ?? element).selector;
          break;
        }
        if (relation === 'OTHER' && containsOf(element, overlay)) {
          continue;
        }
        if (covered === null && relation === 'OTHER') {
          targetSelector = selectorFor(element).selector;
          break;
        }
        layers.push(hitLayerOf(element, relation));
      }
      const top = stack[0];
      return {
        x,
        y,
        topRelation: top === undefined ? null : hitRelationOf(top, overlay, covered),
        layers,
        targetFound: targetSelector !== null,
        targetSelector,
      };
    }),
    overlay: hitLayerOf(overlay, 'OVERLAY'),
    modal: modalOf(overlay, covered),
  });

  // EV-1（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.1）: 覆われる側のいちばん近い、縦にスクロールできる祖先（祖先の見つけ方は部品
  // `R.scrollAncestorsOf`）。なければ `undefined`（Evidence に項目を足さない）。
  const scrollContainerFieldOf = (element: Element): { coveredScrollContainer?: ScrollContainerEvidence } => {
    // REV-SD2 の M-1: 縦に動かせる祖先は、`overflow-y` が auto・scroll・overlay のものだけ（横だけ auto で縦が hidden の祖先は、利用者が縦に動かせない）。
    const container = R.scrollAncestorsOf(element).find((node) => ['auto', 'scroll', 'overlay'].includes(window.getComputedStyle(node).overflowY)
      && scrollHeightOf(node) > clientHeightOf(node));
    if (container === undefined) {
      return {};
    }
    return {
      coveredScrollContainer: {
        selector: selectorFor(container).selector,
        rect: rectFor(container),
        scrollTop: standardGetter<number>(Element.prototype, 'scrollTop')(container),
        scrollRangeY: Math.max(0, scrollHeightOf(container) - clientHeightOf(container)),
      },
    };
  };
  // EV-1: どちらも固定要素でない組の、行ごとの矩形（`getClientRects`）の重なりと、ビューポートの中の交わりの中心の点で、両方が hit-test に出るか。
  const lineOverlapOf = (first: Element, second: Element): LineOverlapEvidence => {
    let area = 0;
    let pointCount = 0;
    let bothHitPointCount = 0;
    const isOrInside = (owner: Element, element: Element): boolean => element === owner || containsOf(owner, element);
    for (const firstLine of clientRectsOf(first)) {
      for (const secondLine of clientRectsOf(second)) {
        const left = Math.max(firstLine.left, secondLine.left);
        const right = Math.min(firstLine.right, secondLine.right);
        const top = Math.max(firstLine.top, secondLine.top);
        const bottom = Math.min(firstLine.bottom, secondLine.bottom);
        if (right <= left || bottom <= top) {
          continue;
        }
        area += (right - left) * (bottom - top);
        const x = (left + right) / 2;
        const y = (top + bottom) / 2;
        if (x < 0 || y < 0 || x >= actualViewport.width || y >= actualViewport.height) {
          continue;
        }
        pointCount += 1;
        const stack = elementsFromPointOf(x, y);
        if (stack.some((element) => isOrInside(first, element)) && stack.some((element) => isOrInside(second, element))) {
          bothHitPointCount += 1;
        }
      }
    }
    return { area, pointCount, bothHitPointCount };
  };

  const fixedHeadingOverlaps: RawFixedHeadingOverlapEvidence[] = [];
  let fixedHeadingOverlapCount = 0;
  if (wants('fixedHeadingOverlaps')) {
    fixedHeadingScan:
    for (const overlay of fixedCandidates) {
      for (const heading of headings) {
        if (deadlinePassed()) {
          break fixedHeadingScan;
        }
        if (
          related(overlay.element, heading.element)
          || !intersectsViewport(overlay.rect)
          || !intersectsViewport(heading.rect)
        ) {
          continue;
        }
        const intersection = intersectionOf(overlay.rect, heading.rect);
        if (intersection === null) {
          continue;
        }
        const index = fixedHeadingOverlapCount;
        fixedHeadingOverlapCount += 1;
        if (!inPart('fixedHeadingOverlaps', index)) {
          continue;
        }
        const overlaySelector = selectorFor(overlay.element);
        const headingSelector = selectorFor(heading.element);
        fixedHeadingOverlaps.push({
          overlaySelector: overlaySelector.selector,
          headingSelector: headingSelector.selector,
          overlayRect: overlay.rect,
          headingRect: heading.rect,
          overlayVisibility: overlay.visibility,
          headingVisibility: heading.visibility,
          overlayPosition: overlay.style.position as FixedElementPosition,
          overlayZIndex: overlay.style.zIndex,
          overlayOverflowX: overlay.style.overflowX,
          overlayOverflowY: overlay.style.overflowY,
          headingPosition: heading.style.position,
          headingZIndex: heading.style.zIndex,
          headingOverflowX: heading.style.overflowX,
          headingOverflowY: heading.style.overflowY,
          intersection,
          truncated: overlaySelector.truncated || headingSelector.truncated,
          hitTest: hitTestOf(overlay.element, heading.element, intersection),
          ...scrollContainerFieldOf(heading.element),
        });
      }
    }
  }

  const elementFacts = (
    observed: ObservedElement,
    selector: string,
  ): RawLayoutElementEvidence => ({
    selector,
    kind: observed.kind,
    rect: observed.rect,
    visibility: observed.visibility,
    position: observed.style.position,
    zIndex: observed.style.zIndex,
    overflowX: observed.style.overflowX,
    overflowY: observed.style.overflowY,
    fixedOrStickyAncestor: observed.fixedOrStickyAncestor,
  });
  // AUD-5（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 8.1）: 重なりの組の片方の置き方（読むだけ）。位置指定の要素は、自分から
  // もう片方と共通の祖先の手前までで探す。押せる祖先は、主要要素の種類の selector のボタンかリンク（自分を除く）。
  const isPositionedContainer = (style: CSSStyleDeclaration): boolean =>
    ['absolute', 'fixed', 'sticky'].includes(style.position) || (style.position === 'relative' && style.zIndex !== 'auto');
  const sidePlacementOf = (element: Element, other: Element): { side: OverlapSidePlacementEvidence; truncated: boolean } => {
    const otherChain = new Set<Element>();
    for (let current: Element | null = other; current !== null; current = parentElementOf(current)) {
      otherChain.add(current);
    }
    let positionedInSharedContainer = false;
    for (let current: Element | null = element; current !== null && !otherChain.has(current); current = parentElementOf(current)) {
      positionedInSharedContainer ||= isPositionedContainer(window.getComputedStyle(current));
    }
    for (let current = parentElementOf(element); current !== null; current = parentElementOf(current)) {
      const kind = kindOf(current);
      if (kind === 'button' || kind === 'link') {
        const { selector, truncated } = selectorFor(current);
        return { side: { positionedInSharedContainer, controlAncestorSelector: selector }, truncated };
      }
    }
    return { side: { positionedInSharedContainer, controlAncestorSelector: null }, truncated: false };
  };

  const elementOverlaps: RawElementOverlapEvidence[] = [];
  let elementOverlapCount = 0;
  const recordOverlap = (first: ObservedElement, second: ObservedElement): void => {
    if (related(first.element, second.element)) {
      return;
    }
    const intersection = intersectionOf(first.rect, second.rect);
    if (intersection === null) {
      return;
    }
    const index = elementOverlapCount;
    elementOverlapCount += 1;
    if (!inPart('elementOverlaps', index)) {
      return;
    }
    const [earlier, later] = first.order < second.order ? [first, second] : [second, first];
    const earlierSelector = selectorFor(earlier.element);
    const laterSelector = selectorFor(later.element);
    // AUD-3b: 片方だけが固定要素の組は、固定要素を覆う側として hit-test を読む。
    const fixedSide = first.fixed === second.fixed ? null : first.fixed ? first : second;
    const otherSide = fixedSide === first ? second : first;
    // AUD-5: どちらも固定要素でない組だけ、片方ごとの置き方を読む。
    const placement = fixedSide === null
      ? [sidePlacementOf(earlier.element, later.element), sidePlacementOf(later.element, earlier.element)] as const
      : null;
    elementOverlaps.push({
      first: elementFacts(earlier, earlierSelector.selector),
      second: elementFacts(later, laterSelector.selector),
      intersection,
      truncated: earlierSelector.truncated || laterSelector.truncated || (placement?.some(({ truncated }) => truncated) ?? false),
      ...(fixedSide === null
        ? {
          lineOverlap: lineOverlapOf(first.element, second.element),
          ...(placement === null ? {} : { placement: { first: placement[0].side, second: placement[1].side } }),
        }
        : { hitTest: hitTestOf(fixedSide.element, otherSide.element, intersection), ...scrollContainerFieldOf(otherSide.element) }),
    });
  };

  if (wants('elementOverlaps')) {
    // 固定要素を含む組を先に調べる。どちらもビューポートと交わる組に限る。
    const primaryInViewport = primaryElements.filter((observed) => intersectsViewport(observed.rect));
    const fixedPrimaryInViewport = primaryInViewport.filter((observed) => observed.fixed);
    let pairsStopped = false;
    fixedPairScan:
    for (const overlay of fixedPrimaryInViewport) {
      for (const other of primaryInViewport) {
        if (other.fixed && other.order <= overlay.order) {
          continue;
        }
        if (deadlinePassed()) {
          pairsStopped = true;
          break fixedPairScan;
        }
        recordOverlap(overlay, other);
      }
    }

    // 固定要素でない主要要素どうしは、上端の順に並べ、縦に重なる組だけを比べる。
    const staticPrimary = primaryElements
      .filter((observed) => !observed.fixed)
      .sort((first, second) => first.rect.top - second.rect.top || first.order - second.order);
    if (!pairsStopped) {
      staticPairScan:
      for (const [index, current] of staticPrimary.entries()) {
        for (let next = index + 1; next < staticPrimary.length; next += 1) {
          const candidate = staticPrimary[next];
          if (candidate === undefined || candidate.rect.top >= current.rect.bottom) {
            break;
          }
          if (deadlinePassed()) {
            break staticPairScan;
          }
          recordOverlap(current, candidate);
        }
      }
    }
  }

  // DEF-204（設計書 `2026-11-06-beaksight-notification-overlay-design.md` 3.5）: 固定要素そのものが描く面の事実（判定は Node の側の
  // `paintsOwnSurfaceOf`）。読む項目は `OwnSurfaceFacts`（`src/core/own-surface.ts`）。種類（画像など）は Node の側で足す。
  // CC-129: 読み方は部品（`R.ownSurfaceFactsOf`）。計算値は、走査で取った要素の `style` から読む。
  const surfaceOf = (element: Element, style: CSSStyleDeclaration): Omit<OwnSurfaceFacts, 'replacedContent'> =>
    R.ownSurfaceFactsOf(element, style, thresholds.maxOwnTextNodeScan);
  const fixedPrimary = wants('fixedElements') ? primaryElements.filter((observed) => observed.fixed) : [];
  const fixedStart = cursor.fixedElements ?? 0;
  const fixedElements: RawFixedElementEvidence[] = fixedPrimary
    .slice(fixedStart, fixedStart + partSize)
    .map((observed) => {
      const { selector, truncated } = selectorFor(observed.element);
      return {
        ...elementFacts(observed, selector),
        truncated,
        surface: { ...surfaceOf(observed.element, observed.style), replacedContent: false },
        pointerEvents: observed.style.pointerEvents,
        // AUD-3b: 要素の面（ビューポートの中の部分）の上の点で、下にある内容を描画と押下で妨げるかの事実。
        hitTest: hitTestOf(observed.element, null, observed.rect),
      };
    });

  // 一覧の中の、最も近い祖先の番号（設計書 5.1.2。番号は、ページの中のすべての候補の中の番号）。この回に返す要素ごとに、親の方向へたどって探す。
  const boxesOutsideViewport: OutsideViewportEvidence[] = outsideInPart.map(({ element, evidence }) => {
    let nearestListedAncestorIndex: number | null = null;
    for (
      let ancestor = parentElementOf(element);
      ancestor !== null && nearestListedAncestorIndex === null;
      ancestor = parentElementOf(ancestor)
    ) {
      nearestListedAncestorIndex = outsideIndexes.get(ancestor) ?? null;
    }
    return { ...evidence, nearestListedAncestorIndex };
  });
  const root = documentElement;
  const body = documentBody;
  const documentElementScrollWidth = root?.scrollWidth ?? 0;
  const bodyScrollWidth = body?.scrollWidth ?? 0;
  return {
    scrollPosition,
    document: {
      viewportWidth: actualViewport.width,
      viewportHeight: actualViewport.height,
      documentElementClientWidth: root?.clientWidth ?? 0,
      documentElementClientHeight: root?.clientHeight ?? 0,
      documentElementScrollWidth,
      documentElementScrollHeight: root?.scrollHeight ?? 0,
      bodyScrollWidth,
      bodyScrollHeight: body?.scrollHeight ?? 0,
      bodyClientWidth: body?.clientWidth ?? 0,
      bodyClientHeight: body?.clientHeight ?? 0,
      horizontalOverflowPx: Math.max(
        0,
        Math.max(documentElementScrollWidth, bodyScrollWidth) - actualViewport.width,
      ),
      viewportHorizontalClip,
    },
    boxesOutsideViewport,
    zeroSizeInteractive,
    clippedText,
    fixedHeadingOverlaps,
    elementOverlaps,
    fixedElements,
    keyActionElements,
    next: {
      boxesOutsideViewport: nextOf('boxesOutsideViewport', outsideIndexes.size, outsideInPart.length),
      zeroSizeInteractive: nextOf('zeroSizeInteractive', zeroSizeInteractiveCount, zeroSizeInteractive.length),
      clippedText: nextOf('clippedText', clippedTextCount, clippedText.length),
      fixedHeadingOverlaps: nextOf('fixedHeadingOverlaps', fixedHeadingOverlapCount, fixedHeadingOverlaps.length),
      elementOverlaps: nextOf('elementOverlaps', elementOverlapCount, elementOverlaps.length),
      fixedElements: nextOf('fixedElements', fixedPrimary.length, fixedElements.length),
      keyActionElements: nextOf('keyActionElements', keyActionElementCount, keyActionElements.length),
    },
    // COV-6: 比べる組・テキストのノード・子孫の要素の数で打ち切らないので、印は常に偽と 0（古い記録と同じ形を保つ）。
    truncation: {
      overlapComparisonLimitReached: false,
      clippedTextNodeScanLimitReachedCount: 0,
      renderedDescendantScanLimitReachedCount: 0,
    },
    incompleteReason,
  };
}
const collectLayoutInPage = composeInPage(collectLayoutReader);

const DEADLINE_EXCEEDED_WITHOUT_LAYOUT: LayoutCollectionResult = Object.freeze({
  status: 'PARTIAL',
  reason: 'DEADLINE_EXCEEDED',
  layout: null,
});

/**
 * 読み取り専用のジオメトリ観測結果を、分けたブラウザ evaluation で収集する（COV-6）。
 * collector は自分の期限を持たない（時間で打ち切らない。2026-11-09 のユーザーの判断）。呼び出し側が期限を渡したときだけ、それを過ぎたら
 * 例外を投げずに、それまでの回の事実と `PARTIAL` を返す。
 * ブラウザ内の評価の失敗、不正なジオメトリ、実際のビューポートとの食い違いは、例外として呼び出し側に返す。
 */
export async function collectLayoutEvidence(
  page: Page,
  viewport: Viewport,
  options: LayoutCollectionOptions = {},
): Promise<LayoutCollectionResult> {
  positiveFiniteDimension(viewport.width, 'Layout viewport width');
  positiveFiniteDimension(viewport.height, 'Layout viewport height');
  const { deadlineAtMs } = options;
  if (deadlineAtMs !== undefined && !Number.isFinite(deadlineAtMs)) {
    throw new Error('Layout collection deadline must be finite');
  }
  const viewportSnapshot = Object.freeze({ width: viewport.width, height: viewport.height });
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    return DEADLINE_EXCEEDED_WITHOUT_LAYOUT;
  }
  // COV-6: 候補は件数の上限で打ち切らず、`LAYOUT_COLLECTION_PART_SIZE` 件ずつ、続きの位置から読み直す（`readInParts`）。進み続けている間は
  // 最後まで読む。呼び出し側の期限があり、ある回がそれを過ぎたら、それまでの回の事実で `PARTIAL` にする（最初の回なら、事実なし）。
  let incompleteReason: BrowserLayoutIncompleteReason | null = null;
  const parts = await readInParts<LayoutPartCursor, RawLayoutPart | null>(FIRST_LAYOUT_PART_CURSOR, async (cursor) => {
    if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
      incompleteReason = 'DEADLINE_EXCEEDED';
      return { part: null, next: null };
    }
    const reading = page.evaluate(collectLayoutInPage, {
      thresholds: LAYOUT_THRESHOLDS,
      visibilityOptions: VISIBILITY_CHECK_OPTIONS,
      kindSelectors: LAYOUT_ELEMENT_KIND_SELECTORS,
      fixedPositions: FIXED_ELEMENT_POSITIONS,
      horizontalClipByOverflow: HORIZONTAL_CLIP_BY_OVERFLOW,
      scanDeadlineAtMs: deadlineAtMs === undefined ? null : deadlineAtMs - LAYOUT_THRESHOLDS.partialResultReserveMs,
      cursor,
      partSize: LAYOUT_COLLECTION_PART_SIZE,
      keyActionSelector: KEY_ACTION_ELEMENT_SELECTOR,
    } satisfies LayoutEvaluationArgument);
    const evaluated = deadlineAtMs === undefined
      ? await reading.then(
        (value) => ({ status: 'FULFILLED', value }) as const,
        (reason: unknown) => ({ status: 'REJECTED', reason }) as const,
      )
      : await awaitBeforeDeadline(reading, deadlineAtMs);
    if (evaluated.status === 'DEADLINE_EXCEEDED') {
      incompleteReason = 'DEADLINE_EXCEEDED';
      return { part: null, next: null };
    }
    if (evaluated.status === 'REJECTED') {
      throw evaluated.reason;
    }
    const raw = evaluated.value;
    validateRawLayoutPart(raw, cursor);
    incompleteReason = validateIncompleteReason(raw.incompleteReason);
    return { part: raw, next: incompleteReason === null ? nextLayoutPartCursor(raw) : null };
  });
  const readParts = parts.filter((part): part is RawLayoutPart => part !== null);
  if (readParts.length === 0) {
    return DEADLINE_EXCEEDED_WITHOUT_LAYOUT;
  }
  const evidence = assembleLayout(readParts);
  if (
    Math.abs(evidence.document.viewportWidth - viewportSnapshot.width) > LAYOUT_THRESHOLDS.viewportMatchTolerancePx
    || Math.abs(evidence.document.viewportHeight - viewportSnapshot.height) > LAYOUT_THRESHOLDS.viewportMatchTolerancePx
  ) {
    throw new Error(
      `Caller viewport ${viewportSnapshot.width}x${viewportSnapshot.height} does not match actual browser viewport `
      + `${evidence.document.viewportWidth}x${evidence.document.viewportHeight}`,
    );
  }
  // 期限を優先する。比べる組の上限に達した場合も COMPLETE にしない（R4 の M2）。
  const reason: LayoutIncompleteReason | null = incompleteReason
    ?? (evidence.truncation.overlapComparisonLimitReached ? 'LAYOUT_COMPARISON_LIMIT_REACHED' : null);
  const marked = await withStateMark(page, evidence, deadlineAtMs);
  return reason === null
    ? Object.freeze({ status: 'COMPLETE', layout: marked })
    : Object.freeze({ status: 'PARTIAL', reason, layout: marked });
}

/**
 * AUD-4（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 7.2 の 1）: 読み終えた layout に、状態の印（`readStateMark`）を足す。layout の対象の
 * selector ごとの祖先のスクロールできる箱も読む。読めなかったとき・期限を過ぎたときは、印なしの layout のまま（layout の結果は変えない）。
 */
async function withStateMark(page: Page, layout: LayoutEvidence, deadlineAtMs: number | undefined): Promise<LayoutEvidence> {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    return layout;
  }
  const read = await awaitBeforeDeadline(readStateMark(page, { selectors: stateMarkTargetSelectorsOf(layout), read: 'SCROLL_BOXES' }), deadlineAtMs);
  return read.status === 'FULFILLED' ? Object.freeze({ ...layout, stateMark: read.value }) : layout;
}

function failedWidth(
  width: number,
  stage: StressLayoutFailureStage,
  reason: StressLayoutFailureReason,
  error: unknown,
): StressLayoutEvidence {
  return Object.freeze({
    width,
    height: STRESS_VIEWPORT_HEIGHT,
    status: 'FAILED',
    stage,
    reason,
    message: error === undefined ? null : safeErrorMessage(error),
    layout: null,
  });
}

/**
 * レスポンシブの各幅を、その都度新規に保護されたowner管理下のセッションでサンプリングする。
 * ある幅の遷移や収集が失敗しても、それまでの幅の結果を保持し、失敗した幅を理由付きで記録して次の幅へ進む。
 * 期限を過ぎた後の幅は、セッションを作らずに `NOT_STARTED` として記録する。
 * 各幅のセッションを作る直前（遷移の前）に `options.beforeNavigation` を呼び、待った時間の分だけ期限を延ばす（サイトへの負荷の制御の設計書 4.1、4.4。
 * DEF-209: 待ってからセッションを作る）。
 * `options.afterNavigation` を渡した場合は、各幅の遷移の前に main frame の文書の追跡を付け、遷移の結果から観測を作って渡し、追跡を外す
 * （サイトが応答しないときに Run を止める設計書 2.1）。
 * `options`（期限と間隔の待ち）は省略できない。省略した場合と、`beforeNavigation` が関数でない場合、`afterNavigation` が関数でも
 * `undefined` でもない場合は、セッションを作らずに例外を投げる。
 * セッションの作成と close の失敗は、owner のライフサイクルの失敗として例外で返す。
 */
export async function collectStressLayout(
  pageFactory: PassiveStressSessionFactory,
  url: string,
  widths: readonly number[],
  options: StressLayoutOptions,
): Promise<readonly StressLayoutEvidence[]> {
  validateStressLayoutInput(pageFactory, widths, options);
  let { deadlineAtMs } = options;
  const results: StressLayoutEvidence[] = [];
  for (const width of widths) {
    if (Date.now() >= deadlineAtMs) {
      results.push(failedWidth(width, 'NOT_STARTED', 'DEADLINE_EXCEEDED', undefined));
      continue;
    }
    const viewport = Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT });
    // DEF-209: 読み込みの間隔を待ってから、その幅のセッション（Context と空の page）を作る（ビューポートの監査と同じ順。待つ間に、空の page の窓を
    // 出さない）。待った時間は、期限を消費しない（サイトへの負荷の制御の設計書 4.4）。待ちの失敗は、セッションを作る前の失敗なので、セッションの作成の
    // 失敗と同じく例外で返す。
    deadlineAtMs += await options.beforeNavigation();
    const session = await pageFactory(viewport);
    const work: StressWidthWork = { error: undefined };
    let closeError: unknown;
    let result: StressLayoutEvidence | undefined;
    try {
      result = await loadStressWidth(session.page, url, width, deadlineAtMs, options, work)
        ?? await measureStressWidth(session.page, viewport, deadlineAtMs, options);
    } catch (error) {
      work.error = error;
      result = failedWidth(width, 'COLLECTION', pageFailureReason(session.page), error);
    } finally {
      closeError = await closeStressSession(session);
    }
    throwStressCloseError(work.error, closeError);
    if (result === undefined) {
      throw new Error('Responsive stress collection produced no result');
    }
    results.push(result);
  }
  return Object.freeze(results);
}

/**
 * SWR（設計者の判断 2026-11-17）: 幅の走査を、1 つのセッションで 1 回だけ読み込み、幅ごとに viewport の大きさだけを変えて行う。
 * - 最初の幅の前に 1 回だけ `beforeNavigation` を待ち、最初の幅の大きさでセッションを作って読み込む（読み込みの観測は `afterNavigation`）。
 * - 後の幅は、同じ page の大きさを変えてから、落ち着きを待って測る（`collectStressLayout` と同じ測りと `afterLayout`）。
 * - 幅が `FAILED` になるか、page が閉じたら、残りの幅を測らずに、それまでの結果を返す（残りの扱いは呼ぶ側が決める）。
 * - 最後に 1 回だけセッションを閉じる。セッションの作成と close の失敗は、`collectStressLayout` と同じく例外で返す。
 */
export async function collectResizedStressLayout(
  pageFactory: PassiveStressSessionFactory,
  url: string,
  widths: readonly number[],
  options: ResizedStressLayoutOptions,
): Promise<readonly StressLayoutEvidence[]> {
  validateStressLayoutInput(pageFactory, widths, options);
  const around = options.aroundWidth ?? ((_width: number, run: () => Promise<StressLayoutEvidence>) => run());
  let { deadlineAtMs } = options;
  let session: PassiveStressSession | null = null;
  const work: StressWidthWork = { error: undefined };
  const results: StressLayoutEvidence[] = [];
  let closeError: unknown;
  try {
    for (const [index, width] of widths.entries()) {
      const viewport = Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT });
      const result = await around(width, async () => {
        if (index === 0) {
          deadlineAtMs += await options.beforeNavigation();
          session = await pageFactory(viewport);
        }
        const page = (session as PassiveStressSession | null)?.page;
        if (page === undefined) {
          throw new Error('Responsive stress resize sweep has no session');
        }
        try {
          if (index === 0) {
            const failed = await loadStressWidth(page, url, width, deadlineAtMs, options, work);
            if (failed !== null) {
              return failed;
            }
          } else {
            await page.setViewportSize(viewport);
          }
          return await measureStressWidth(page, viewport, deadlineAtMs, options);
        } catch (error) {
          work.error = error;
          return failedWidth(width, 'COLLECTION', pageFailureReason(page), error);
        }
      });
      results.push(result);
      const current = session as PassiveStressSession | null;
      if (result.status === 'FAILED' || current === null || current.page.isClosed()) {
        break;
      }
    }
  } finally {
    const opened = session as PassiveStressSession | null;
    if (opened !== null) {
      closeError = await closeStressSession(opened);
    }
  }
  throwStressCloseError(work.error, closeError);
  return Object.freeze(results);
}

/** 幅の段の失敗（close の失敗と合わせて投げるため）。 */
interface StressWidthWork {
  error: unknown;
}

/** 幅の走査の入力を確かめる（`collectStressLayout`・`collectResizedStressLayout` の共通）。 */
function validateStressLayoutInput(pageFactory: PassiveStressSessionFactory, widths: readonly number[], options: StressLayoutOptions): void {
  if (typeof pageFactory !== 'function') {
    throw new Error('A passive stress session factory is required');
  }
  if (widths.some((width) => !Number.isFinite(width) || !Number.isInteger(width) || width <= 0)) {
    throw new Error('Responsive stress widths must be positive finite integers');
  }
  if (typeof options !== 'object' || options === null) {
    throw new Error('Responsive stress requires options with a deadline and a beforeNavigation function');
  }
  const { beforeNavigation, afterNavigation, settleBeforeLayout } = options;
  if (!Number.isFinite(options.deadlineAtMs)) {
    throw new Error('Responsive stress deadline must be finite');
  }
  if (typeof beforeNavigation !== 'function') {
    throw new Error('Responsive stress requires a beforeNavigation function');
  }
  if (typeof settleBeforeLayout !== 'function') {
    throw new Error('Responsive stress requires a settleBeforeLayout function');
  }
  if (afterNavigation !== undefined && typeof afterNavigation !== 'function') {
    throw new Error('Responsive stress afterNavigation must be a function when given');
  }
}

/** 幅の page を読み込む。読み込めたら `null`、読み込めなければ、その幅の失敗の結果。 */
async function loadStressWidth(
  page: Page,
  url: string,
  width: number,
  deadlineAtMs: number,
  options: StressLayoutOptions,
  work: StressWidthWork,
): Promise<StressLayoutEvidence | null> {
  const { afterNavigation } = options;
  // 受け口があれば、読み込みの観測を渡す（サイトが応答しないときに Run を止める設計書 2.1）。追跡は読み込みの前に付け、観測を渡した後に
  // 外す。判定はしない。
  const tracker = afterNavigation === undefined ? null : trackMainFrameDocument(page);
  let navigated: MainFrameLoadSettlement;
  try {
    // DEF-129: BeakSight 自身の読み込みであることを Guard に知らせる（ページが始めた読み込みの数を数え直す）。
    announceOwnMainFrameNavigation(page);
    navigated = await awaitBeforeDeadline(page.goto(url, { waitUntil: 'load' }), deadlineAtMs);
    if (tracker !== null && afterNavigation !== undefined) {
      afterNavigation(observeMainFrameLoad(tracker, navigated));
    }
  } finally {
    tracker?.dispose();
  }
  if (navigated.status === 'DEADLINE_EXCEEDED') {
    return failedWidth(width, 'NAVIGATION', 'DEADLINE_EXCEEDED', undefined);
  }
  if (navigated.status === 'REJECTED') {
    work.error = navigated.reason;
    return failedWidth(width, 'NAVIGATION', 'NAVIGATION_FAILED', navigated.reason);
  }
  return null;
}

/** 読み込んだ（大きさを変えた）幅の page で、落ち着きを待って形を測り、`afterLayout` を呼ぶ。 */
async function measureStressWidth(page: Page, viewport: Viewport, deadlineAtMs: number, options: StressLayoutOptions): Promise<StressLayoutEvidence> {
  const { width } = viewport;
  // T44 P1-5: 最初の読み込みと同じ落ち着きの待ちの後に測る（後から描く画面のデータを見る）。
  await options.settleBeforeLayout(page, deadlineAtMs);
  const collected = await collectLayoutEvidence(page, viewport, { deadlineAtMs });
  // AUD-3d: layout を読んだ直後に、その幅の画像を撮る口を呼ぶ（読めなかった幅では呼ばない）。
  if (collected.layout !== null && options.afterLayout !== undefined) {
    await options.afterLayout(page, width, collected.layout);
  }
  return collected.status === 'COMPLETE'
    ? Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT, status: 'COMPLETE', layout: collected.layout })
    : Object.freeze({ width, height: STRESS_VIEWPORT_HEIGHT, status: 'PARTIAL', reason: collected.reason, layout: collected.layout });
}

/** 幅のセッションを閉じる（失敗は返す）。 */
async function closeStressSession(session: PassiveStressSession): Promise<unknown> {
  try {
    await session.close();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** close の失敗を、段の失敗と合わせて投げる（close の失敗がなければ投げない）。 */
function throwStressCloseError(workError: unknown, closeError: unknown): void {
  if (closeError !== undefined) {
    if (workError !== undefined) {
      throw new AggregateError([workError, closeError], 'Responsive stress work and owner close both failed');
    }
    throw closeError;
  }
}
