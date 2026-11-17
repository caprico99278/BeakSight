/**
 * EV-2（設計書 `doc/design/2026-11-16-beaksight-finding-evidence-design.md` 3.2）: 対象まで動かして、同じ状態で測り直して撮る共通の部品（`revealAndCapture`）。
 * - 1 つの対象ごとに: 対象を selector で引き直す → 文書とスクロールの祖先の今の位置を記録 → 祖先ごと（内から外）に、対象が箱の中に入るまで動かし、最後に文書を
 *   動かす → 落ち着きを待つ（呼ぶ側が渡す、今のスクロールの待ちの値）→ 測り直す（矩形・行ごとの矩形・祖先による切り取り・複数の点の hit-test）→ 先頭へ戻さずに
 *   viewport を撮る（呼ぶ側の口）→ 撮った画像の範囲に対象が入ったか（`TargetImageInclusion`）を機械で決める → 元の位置へ戻す。
 * - 対象が箱（viewport とスクロールの祖先の箱の小さい方）より大きいときは、箱の大きさに分けて、全部の部分を撮る（終わりは、部分の数という構造の事実）。
 * - 重なりは、同じ帯に入るほかの重なり（動かした位置で全部が画像に入るもの）を同じ 1 枚にまとめる。
 * - 固定の枠の覆いは、対象を動かした位置（`TARGET`）と、文書と祖先を末尾まで動かした位置（`END`）の両方で測って撮る（区分は Rule の側の 1 か所）。
 * - フォーカスの確かめは、動かさずに（フォーカスの後の位置のまま）測って撮る（`captureAsIs`）。
 * - EV-4（設計書 3.4）: 文字の見切れは、重なりと同じく帯ごとに撮る。横にスクロールする領域は、領域まで動かして撮った後に、Tab で届くか・矢印のキーで動くかを
 *   試し、前と後の位置を記録して、位置とフォーカスを元へ戻す（`checkScrollableRegions`）。
 * 読むのとスクロール（と EV-4 の Tab・矢印のキー）だけで、値を変えず、サイトへの読み込みと BeakSight の要求は足さない。例外は投げない（測れなかった対象は飛ばす）。
 */
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import type { EvidenceId } from '../core/contracts.js';
import type {
  AccessibilityTargetSelector,
  FocusCheckScrollEvidence,
  RectangleEvidence,
  RevealCaptureEvidence,
  RevealedTargetEvidence,
  RevealPosition,
  RevealTargetSpec,
  ScrollAncestorPositionEvidence,
  ScrollableRegionKeyboardEvidence,
  ScrollPosition,
  TargetImageInclusion,
} from '../core/evidence-types.js';
import { wait } from '../core/deadline.js';
import { MAX_SELECTOR_DEPTH } from '../core/limits.js';
import { inclusionOfVisiblePart, isUncoveredMeasurement } from '../core/target-image-inclusion.js';
import { LAYOUT_THRESHOLDS } from './layout-collector.js';

/** hit-test の点を内側へ寄せる量（px。layout の hit-test と同じ値）。 */
const HIT_TEST_POINT_INSET_PX = LAYOUT_THRESHOLDS.hitTestPointInsetPx;

/**
 * 押す部品（覆いの文の「押せません」の対象。layout の要素の種類のリンク・ボタン・入力欄に当たる）。リンクは `:any-link`（行き先は読まない。GATE-ARCH03）。
 */
const CONTROL_SELECTOR = ':any-link, button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]';

/**
 * ページの中で読む口（`evaluate` だけ。Playwright の page がそのまま当てはまる形。Playwright の import は adapter の所だけなので、ここでは形だけを書く）。
 */
export interface RevealPage {
  evaluate<R, Arg>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R>;
}

/** 分けて撮るときの、対象の矩形の中の部分（対象の矩形の左上からの位置と大きさ）。 */
interface SegmentBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface RawMeasure {
  readonly found: boolean;
  readonly rect: RectangleEvidence | null;
  readonly elementRects: readonly (RectangleEvidence | null)[];
  readonly lineRectCounts: readonly number[];
  readonly visibleRect: RectangleEvidence | null;
  /** 対象を入れる箱（viewport と、最初の要素のスクロールの祖先の箱）の、いちばん小さい幅と高さ。 */
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly hitTestPointCount: number;
  readonly hitPointCount: number;
  readonly coveredPointCount?: number;
  readonly overlayPresent?: boolean;
  readonly control?: { readonly interactive: boolean; readonly enabled: boolean };
}

interface RawState {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly document: ScrollPosition;
  readonly measures: readonly RawMeasure[];
}

interface MeasureArgument {
  readonly targets: readonly { readonly spec: RevealTargetSpec; readonly segment: SegmentBox | null }[];
  readonly insetPx: number;
  readonly controlSelector: string;
}

/** ページの中で、対象を引き直して測る（動かさない）。 */
function measureReader(R: StandardReaders, { targets, insetPx, controlSelector }: MeasureArgument): RawState {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rectOf = (left: number, top: number, right: number, bottom: number): RectangleEvidence =>
    ({ x: left, y: top, top, right, bottom, left, width: right - left, height: bottom - top });
  const boxOf = (element: Element): RectangleEvidence => {
    const box = Element.prototype.getBoundingClientRect.call(element);
    return rectOf(box.left, box.top, box.right, box.bottom);
  };
  const clientBoxOf = (element: Element): RectangleEvidence => {
    const box = Element.prototype.getBoundingClientRect.call(element);
    const left = box.left + R.standardGetter<number>(Element.prototype, 'clientLeft')(element);
    const top = box.top + R.standardGetter<number>(Element.prototype, 'clientTop')(element);
    return rectOf(left, top, left + R.standardGetter<number>(Element.prototype, 'clientWidth')(element),
      top + R.standardGetter<number>(Element.prototype, 'clientHeight')(element));
  };
  const resolve = (selector: string): Element | null => {
    try {
      return Document.prototype.querySelector.call(document, selector);
    } catch {
      return null;
    }
  };
  const inside = (owner: Element, element: Element): boolean => element === owner || Node.prototype.contains.call(owner, element);
  const root = R.documentProperty<Element | null>('scrollingElement') ?? R.documentProperty<Element>('documentElement');
  const body = R.documentProperty<HTMLElement | null>('body');
  const separateBody = body !== null && body !== root ? body : null;
  const measures = targets.map(({ spec, segment }): RawMeasure => {
    const elements = spec.selectors.map(resolve);
    const elementRects = elements.map((element) => (element === null ? null : boxOf(element)));
    const lineRectCounts = elements.map((element) => (element === null ? 0 : Element.prototype.getClientRects.call(element).length));
    const present = elements.filter((element): element is Element => element !== null);
    const first = present[0];
    const empty: RawMeasure = {
      found: false, rect: null, elementRects, lineRectCounts, visibleRect: null, boxWidth: viewportWidth, boxHeight: viewportHeight,
      hitTestPointCount: 0, hitPointCount: 0,
    };
    if (first === undefined || present.length !== elements.length) {
      return empty;
    }
    const rects = elementRects.filter((rect): rect is RectangleEvidence => rect !== null);
    const left0 = Math.max(...rects.map((rect) => rect.left));
    const top0 = Math.max(...rects.map((rect) => rect.top));
    const whole = rectOf(left0, top0, Math.max(left0, Math.min(...rects.map((rect) => rect.right))), Math.max(top0, Math.min(...rects.map((rect) => rect.bottom))));
    const rect = segment === null
      ? whole
      : rectOf(whole.left + segment.x, whole.top + segment.y, whole.left + segment.x + segment.width, whole.top + segment.y + segment.height);
    let clip = rectOf(0, 0, viewportWidth, viewportHeight);
    let boxWidth = viewportWidth;
    let boxHeight = viewportHeight;
    for (const ancestor of R.scrollAncestorsOf(first)) {
      const box = clientBoxOf(ancestor);
      boxWidth = Math.min(boxWidth, box.width);
      boxHeight = Math.min(boxHeight, box.height);
    }
    // REV-EV12 の I-2: 内容を切り取る祖先（`overflow` が visible でない向き。hidden・clip・auto・scroll など）の箱で、見える部分を切る（文書の根と body は除く）。
    const parentOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
    for (let node = parentOf(first); node !== null && node !== root && node !== body; node = parentOf(node)) {
      const style = window.getComputedStyle(node);
      const clipX = style.overflowX !== 'visible';
      const clipY = style.overflowY !== 'visible';
      if (!clipX && !clipY) continue;
      const box = clientBoxOf(node);
      clip = rectOf(
        clipX ? Math.max(clip.left, box.left) : clip.left,
        clipY ? Math.max(clip.top, box.top) : clip.top,
        clipX ? Math.min(clip.right, box.right) : clip.right,
        clipY ? Math.min(clip.bottom, box.bottom) : clip.bottom,
      );
    }
    const visibleLeft = Math.max(rect.left, clip.left);
    const visibleTop = Math.max(rect.top, clip.top);
    const visibleRight = Math.min(rect.right, clip.right);
    const visibleBottom = Math.min(rect.bottom, clip.bottom);
    const visibleRect = visibleRight >= visibleLeft && visibleBottom >= visibleTop ? rectOf(visibleLeft, visibleTop, visibleRight, visibleBottom) : null;
    const overlay = spec.overlaySelector === undefined ? undefined : resolve(spec.overlaySelector);
    const points = visibleRect === null ? [] : R.hitPointsOf(visibleRect, viewportWidth, viewportHeight, insetPx);
    let hitPointCount = 0;
    let coveredPointCount = 0;
    for (const [x, y] of points) {
      const [top] = Document.prototype.elementsFromPoint.call(document, x, y);
      if (top === undefined) continue;
      if (present.some((element) => inside(element, top))) hitPointCount += 1;
      else if (overlay !== undefined && overlay !== null && inside(overlay, top)) coveredPointCount += 1;
    }
    const overlayBox = overlay === undefined || overlay === null ? null : boxOf(overlay);
    const overlayPresent = overlay === undefined
      ? undefined
      : overlay !== null && overlayBox !== null
        && Element.prototype.checkVisibility.call(overlay, { visibilityProperty: true, opacityProperty: true })
        && Math.min(overlayBox.right, viewportWidth) > Math.max(overlayBox.left, 0)
        && Math.min(overlayBox.bottom, viewportHeight) > Math.max(overlayBox.top, 0);
    return {
      found: true, rect, elementRects, lineRectCounts, visibleRect, boxWidth, boxHeight, hitTestPointCount: points.length, hitPointCount,
      ...(overlayPresent === undefined ? {} : {
        coveredPointCount,
        overlayPresent,
        control: { interactive: Element.prototype.matches.call(first, controlSelector), enabled: !Element.prototype.matches.call(first, ':disabled') },
      }),
    };
  });
  return {
    viewportWidth,
    viewportHeight,
    document: { scrollX: window.scrollX + (separateBody?.scrollLeft ?? 0), scrollY: window.scrollY + (separateBody?.scrollTop ?? 0) },
    measures,
  };
}
const measureInPage = composeInPage(measureReader);

interface MoveArgument {
  readonly spec: RevealTargetSpec;
  readonly segment: SegmentBox | null;
  /** `TARGET` は対象を箱の中へ、`ONE_SCREEN` は文書を 1 画面分、`END` は末尾まで動かす。 */
  readonly position: Extract<RevealPosition, 'TARGET' | 'ONE_SCREEN' | 'END'>;
  readonly maxSelectorDepth: number;
}

/**
 * ページの中で、文書と、対象の最初の要素のスクロールの祖先を動かし、前と後の位置を返す（要素がなければ `null`）。`TARGET` は、祖先ごと（内から外）に対象の
 * 部分が箱の中に入る（箱に入る大きさなら中央、入らなければ左上をそろえる）まで動かし、最後に文書を動かす。`END` は、祖先と文書を下の端まで動かす。
 * `ONE_SCREEN` は、祖先を動かさず、文書だけを、対象の上端が画面の上端に来るまで（少なくとも 1 px、多くても 1 画面分）下へ動かす。
 */
function moveReader(R: StandardReaders, { spec, segment, position, maxSelectorDepth }: MoveArgument): FocusCheckScrollEvidence | null {
  const resolve = (selector: string): Element | null => {
    try {
      return Document.prototype.querySelector.call(document, selector);
    } catch {
      return null;
    }
  };
  const elements = spec.selectors.map(resolve);
  const first = elements[0];
  if (first === undefined || first === null || elements.some((element) => element === null)) {
    return null;
  }
  const scrollLeftOf = R.standardGetter<number>(Element.prototype, 'scrollLeft');
  const scrollTopOf = R.standardGetter<number>(Element.prototype, 'scrollTop');
  const documentPosition = (): ScrollPosition => ({ scrollX: window.scrollX, scrollY: window.scrollY });
  const regionOf = (): { left: number; top: number; right: number; bottom: number } => {
    const boxes = (elements as Element[]).map((element) => Element.prototype.getBoundingClientRect.call(element));
    const left = Math.max(...boxes.map((box) => box.left));
    const top = Math.max(...boxes.map((box) => box.top));
    const right = Math.max(left, Math.min(...boxes.map((box) => box.right)));
    const bottom = Math.max(top, Math.min(...boxes.map((box) => box.bottom)));
    return segment === null
      ? { left, top, right, bottom }
      : { left: left + segment.x, top: top + segment.y, right: left + segment.x + segment.width, bottom: top + segment.y + segment.height };
  };
  /** 部分を箱の中へ入れる量（入る大きさなら中央、入らなければ始めの端をそろえる）。 */
  const deltaOf = (start: number, end: number, boxStart: number, boxEnd: number): number =>
    (end - start <= boxEnd - boxStart ? (start + end) / 2 - (boxStart + boxEnd) / 2 : start - boxStart);
  const ancestors = position === 'ONE_SCREEN' ? [] : R.scrollAncestorsOf(first);
  const documentBefore = documentPosition();
  const ancestorsBefore = ancestors.map((node) => ({ scrollLeft: scrollLeftOf(node), scrollTop: scrollTopOf(node) }));
  const scrollTo = Element.prototype.scrollTo as (this: Element, options: ScrollToOptions) => void;
  // 利用者が動かせる向き（`overflow-x`・`overflow-y` が auto・scroll・overlay）だけを動かす（REV-SD2 の M-1 と同じ決まり）。
  const movable = ['auto', 'scroll', 'overlay'];
  for (const node of ancestors) {
    const style = window.getComputedStyle(node);
    const horizontal = movable.includes(style.overflowX);
    const vertical = movable.includes(style.overflowY);
    if (position === 'END') {
      if (vertical) {
        scrollTo.call(node, { left: scrollLeftOf(node), top: R.standardGetter<number>(Element.prototype, 'scrollHeight')(node), behavior: 'instant' });
      }
      continue;
    }
    const box = Element.prototype.getBoundingClientRect.call(node);
    const boxLeft = box.left + R.standardGetter<number>(Element.prototype, 'clientLeft')(node);
    const boxTop = box.top + R.standardGetter<number>(Element.prototype, 'clientTop')(node);
    const region = regionOf();
    scrollTo.call(node, {
      left: scrollLeftOf(node) + (horizontal ? deltaOf(region.left, region.right, boxLeft, boxLeft + R.standardGetter<number>(Element.prototype, 'clientWidth')(node)) : 0),
      top: scrollTopOf(node) + (vertical ? deltaOf(region.top, region.bottom, boxTop, boxTop + R.standardGetter<number>(Element.prototype, 'clientHeight')(node)) : 0),
      behavior: 'instant',
    });
  }
  if (position === 'END') {
    const root = R.documentProperty<Element | null>('scrollingElement') ?? R.documentProperty<Element>('documentElement');
    window.scrollTo({ left: window.scrollX, top: R.standardGetter<number>(Element.prototype, 'scrollHeight')(root), behavior: 'instant' });
  } else if (position === 'ONE_SCREEN') {
    // REV-EV3 の M-1: 対象が画面に残る範囲で動かす（対象の上端を画面の上端まで。少なくとも 1 px、多くても 1 画面分）。覆う部品が消えたときに、対象が見えるかを測れる。
    const region = regionOf();
    window.scrollBy({ left: 0, top: Math.min(window.innerHeight, Math.max(1, region.top)), behavior: 'instant' });
  } else {
    const region = regionOf();
    window.scrollBy({
      left: deltaOf(region.left, region.right, 0, window.innerWidth),
      top: deltaOf(region.top, region.bottom, 0, window.innerHeight),
      behavior: 'instant',
    });
  }
  return {
    document: { before: documentBefore, after: documentPosition() },
    ancestors: ancestors.map((node, index) => ({
      selector: R.selectorOf(node, maxSelectorDepth),
      before: ancestorsBefore[index] ?? { scrollLeft: scrollLeftOf(node), scrollTop: scrollTopOf(node) },
      after: { scrollLeft: scrollLeftOf(node), scrollTop: scrollTopOf(node) },
    })),
  };
}
const moveInPage = composeInPage(moveReader);

/**
 * ページの中で、動かした祖先と文書を、前の位置へ戻す。REV-EV12 の M-1: 祖先は、対象から引き直さず、記録した祖先の selector で引く（仮想の一覧などで、動かした
 * 後に対象の行が消えても戻す）。
 */
function restoreReader(_R: StandardReaders, { scroll }: { readonly scroll: FocusCheckScrollEvidence }): void {
  for (const ancestor of scroll.ancestors) {
    let node: Element | null = null;
    try {
      node = Document.prototype.querySelector.call(document, ancestor.selector);
    } catch {
      node = null;
    }
    if (node !== null) {
      (Element.prototype.scrollTo as (this: Element, options: ScrollToOptions) => void)
        .call(node, { left: ancestor.before.scrollLeft, top: ancestor.before.scrollTop, behavior: 'instant' });
    }
  }
  window.scrollTo({ left: scroll.document.before.scrollX, top: scroll.document.before.scrollY, behavior: 'instant' });
}
const restoreInPage = composeInPage(restoreReader);

/**
 * 測った対象が画像の範囲に入ったか（決め方は `inclusionOfVisiblePart` の 1 か所。REV-EV12 の I-2: hit-test で、ほかの部品の下に隠れた対象は入らない）。
 * `geometryOnly` は、見える部分の形だけで決める（覆いの対象を同じ 1 枚にまとめるか。覆われていること自体は、まとめるのを妨げない）。
 */
const targetImageInclusionOf = (measure: RawMeasure, geometryOnly = false): TargetImageInclusion =>
  inclusionOfVisiblePart(measure.rect, measure.visibleRect, geometryOnly ? undefined : measure);

/** 対象の矩形を、箱の大きさ（幅・高さ）の部分に分ける（箱に入れば分けない。部分の数は、矩形と箱の大きさで決まる）。 */
export function revealSegmentsOf(rect: RectangleEvidence, boxWidth: number, boxHeight: number): readonly (SegmentBox | null)[] {
  if ((rect.width <= boxWidth && rect.height <= boxHeight) || !(boxWidth > 0) || !(boxHeight > 0)) {
    return [null];
  }
  const segments: SegmentBox[] = [];
  for (let y = 0; y < rect.height; y += boxHeight) {
    for (let x = 0; x < rect.width; x += boxWidth) {
      segments.push({ x, y, width: Math.min(boxWidth, rect.width - x), height: Math.min(boxHeight, rect.height - y) });
    }
  }
  return segments;
}

/** 撮る口（先頭へ戻さずに viewport を撮り、測り直しの記録を付けて残す）。撮れなかったら、例外か `null` を返す。 */
export type RevealCapturePort<T> = (reveal: RevealCaptureEvidence) => Promise<T | null>;

/** `revealAndCapture` の指定。 */
export interface RevealAndCaptureOptions {
  /** 動かした後の落ち着きの待ち（ms。今のスクロールの待ちの値を渡す）。 */
  readonly settleMs: number;
  readonly capture: RevealCapturePort<unknown>;
  /** 進みの見張りの口（ページの読み取りが返るたびに印を付ける）。 */
  readonly track?: (<T>(work: Promise<T>) => Promise<T>) | undefined;
}

const freezeMeasured = (
  spec: RevealTargetSpec,
  position: RevealPosition,
  scroll: FocusCheckScrollEvidence,
  measure: RawMeasure,
  segment: { readonly index: number; readonly count: number } | null,
): RevealedTargetEvidence => Object.freeze({
  purpose: spec.purpose,
  selectors: Object.freeze([...spec.selectors]),
  ...(spec.overlaySelector === undefined ? {} : { overlaySelector: spec.overlaySelector }),
  position,
  found: measure.found,
  scroll,
  rect: measure.rect,
  elementRects: Object.freeze([...measure.elementRects]),
  lineRectCounts: Object.freeze([...measure.lineRectCounts]),
  visibleRect: measure.visibleRect,
  hitTestPointCount: measure.hitTestPointCount,
  hitPointCount: measure.hitPointCount,
  ...(measure.coveredPointCount === undefined ? {} : { coveredPointCount: measure.coveredPointCount }),
  ...(measure.overlayPresent === undefined ? {} : { overlayPresent: measure.overlayPresent }),
  ...(measure.control === undefined ? {} : { control: Object.freeze({ ...measure.control }) }),
  inclusion: targetImageInclusionOf(measure),
  ...(segment === null ? {} : { segment: Object.freeze({ ...segment }) }),
});

/** 1 つの位置で撮った結果（その画像に写る対象ごとの測り。撮る前に読めなくなったら `null`）。 */
type Shot = readonly { readonly spec: RevealTargetSpec; readonly measured: RevealedTargetEvidence }[] | null;

/**
 * 対象まで動かして測り直し、撮る（重なりと固定の枠の覆い）。動かして撮った後に、毎回元の位置へ戻す。途中で読めなくなった対象は飛ばす（例外は投げない）。
 * - 重なり: 対象の順に動かし、同じ位置で全部が画像に入るほかの重なりを同じ 1 枚にまとめる（帯ごとに 1 枚）。箱より大きい対象は分けて撮る。
 * - 覆い（REV-EV12 の I-1。覆う部品ごと）: 覆われる要素を帯ごとにまとめて動かして撮る（`TARGET`）。そこで覆われたままの要素があれば、文書を 1 画面分だけ動かして
 *   覆う部品が残るかを見る（`ONE_SCREEN`。対象が画面に残る範囲。覆う部品が消えて対象が見えれば初めの位置だけの覆い）。そうでなければ、末尾まで動かして
 *   1 回だけ撮る（`END`。末尾でも隠れるかを確かめる）。
 *   末尾まで動かすのは覆う部品ごとに 1 回だけ（ページの続きの読み込みを増やしすぎない）。
 */
export async function revealAndCapture(page: RevealPage, targets: readonly RevealTargetSpec[], options: RevealAndCaptureOptions): Promise<void> {
  const track = options.track ?? (<T>(work: Promise<T>): Promise<T> => work);
  const measure = (specs: readonly { readonly spec: RevealTargetSpec; readonly segment: SegmentBox | null }[]): Promise<RawState> =>
    track(page.evaluate(measureInPage, { targets: specs, insetPx: HIT_TEST_POINT_INSET_PX, controlSelector: CONTROL_SELECTOR }));
  /**
   * `lead` の位置へ動かし、落ち着きを待って、`lead`（とまとめる候補 `group`）を測って撮り、元へ戻す。`whole` が真なら、候補を全部その画像の測りに入れる
   * （1 画面分・末尾の位置）。偽なら、全部が画像に入る候補だけを入れる（帯ごとにまとめる）。
   */
  const shoot = async (
    lead: RevealTargetSpec,
    segment: { readonly box: SegmentBox; readonly index: number; readonly count: number } | null,
    position: Extract<RevealPosition, 'TARGET' | 'ONE_SCREEN' | 'END'>,
    group: readonly RevealTargetSpec[],
    whole: boolean,
  ): Promise<Shot> => {
    const scroll = await track(page.evaluate(moveInPage, { spec: lead, segment: segment?.box ?? null, position, maxSelectorDepth: MAX_SELECTOR_DEPTH }));
    if (scroll === null) {
      return null;
    }
    try {
      await track(wait(options.settleMs));
      const state = await measure([{ spec: lead, segment: segment?.box ?? null }, ...group.map((other) => ({ spec: other, segment: null }))]);
      const [own, ...others] = state.measures;
      if (own === undefined) {
        return null;
      }
      const shot = [{ spec: lead, measured: freezeMeasured(lead, position, scroll, own, segment === null ? null : { index: segment.index, count: segment.count }) }];
      others.forEach((measured, index) => {
        const other = group[index];
        if (other !== undefined && measured.found && (whole || targetImageInclusionOf(measured, true) === 'INSIDE')) {
          shot.push({ spec: other, measured: freezeMeasured(other, position, scroll, measured, null) });
        }
      });
      await options.capture(Object.freeze({
        viewportWidth: state.viewportWidth,
        viewportHeight: state.viewportHeight,
        targets: Object.freeze(shot.map(({ measured }) => measured)),
      })).catch(() => null);
      return shot;
    } finally {
      await track(page.evaluate(restoreInPage, { scroll })).catch(() => undefined);
    }
  };
  /** 先頭から順に動かして撮り、同じ帯の候補を同じ 1 枚にまとめる（撮った対象の測りを返す）。 */
  const shootBands = async (specs: readonly RevealTargetSpec[], split: boolean): Promise<RevealedTargetEvidence[]> => {
    const measuredAll: RevealedTargetEvidence[] = [];
    const pending = [...specs];
    for (let lead = pending.shift(); lead !== undefined; lead = pending.shift()) {
      const current = lead;
      try {
        const first = (await measure([{ spec: current, segment: null }])).measures[0];
        if (first === undefined || first.rect === null) {
          continue;
        }
        const segments = split ? revealSegmentsOf(first.rect, first.boxWidth, first.boxHeight) : [null];
        for (const [index, box] of segments.entries()) {
          const shot = await shoot(current, box === null ? null : { box, index, count: segments.length }, 'TARGET', box === null ? pending : [], false);
          for (const { spec, measured } of shot ?? []) {
            measuredAll.push(measured);
            if (spec !== current) {
              pending.splice(pending.indexOf(spec), 1);
            }
          }
        }
      } catch {
        // 読めなくなった対象は飛ばす（ほかの対象と、後の段の証拠には影響させない）。
      }
    }
    return measuredAll;
  };

  await shootBands(targets.filter((spec) => spec.purpose === 'ELEMENT_OVERLAP'), true);
  // EV-4: 見切れの要素も、重なりと同じく帯ごとにまとめて撮る（箱より大きい要素は分けて撮る）。
  await shootBands(targets.filter((spec) => spec.purpose === 'TEXT_CLIPPING'), true);
  const covers = targets.filter((spec) => spec.purpose === 'FIXED_ELEMENT_OCCLUSION');
  for (const overlaySelector of [...new Set(covers.map((spec) => spec.overlaySelector))]) {
    const group = covers.filter((spec) => spec.overlaySelector === overlaySelector);
    try {
      const atTarget = await shootBands(group, false);
      const stillCovered = group.filter((spec) => {
        const measured = atTarget.find((entry) => entry.selectors[0] === spec.selectors[0]);
        return measured === undefined || !isUncoveredMeasurement(measured);
      });
      const [lead, ...rest] = stillCovered;
      if (lead === undefined) {
        continue;
      }
      const shifted = await shoot(lead, null, 'ONE_SCREEN', rest, true);
      // REV-EV3 の M-1: 末尾まで動かさずに終えるのは、覆う部品が消えて、覆われたままだった対象が全部見えて覆われていないときだけ（初めの位置だけの覆い）。
      if (shifted === null
        || (shifted.length === stillCovered.length
          && shifted.every(({ measured }) => measured.overlayPresent === false && isUncoveredMeasurement(measured)))) {
        continue;
      }
      await shoot(lead, null, 'END', rest, true);
    } catch {
      // 読めなくなった覆いは飛ばす。
    }
  }
}

/**
 * フォーカスの確かめ: 動かさずに（フォーカスの後の位置のまま）対象を測り、撮る（口の結果を返す。測れなければ `null`）。前と後の位置は、フォーカスの確かめが
 * 記録した位置（`scroll`）を写す。
 */
export async function captureAsIs<T>(
  page: RevealPage,
  spec: RevealTargetSpec,
  scroll: FocusCheckScrollEvidence,
  capture: RevealCapturePort<T>,
): Promise<T | null> {
  const state = await page.evaluate(measureInPage, { targets: [{ spec, segment: null }], insetPx: HIT_TEST_POINT_INSET_PX, controlSelector: CONTROL_SELECTOR });
  const measured = state.measures[0];
  if (measured === undefined) {
    return null;
  }
  return capture(Object.freeze({
    viewportWidth: state.viewportWidth,
    viewportHeight: state.viewportHeight,
    targets: Object.freeze([freezeMeasured(spec, 'AS_IS', scroll, measured, null)]),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// EV-4: 横にスクロールする領域の、キーボードの実操作
// ---------------------------------------------------------------------------------------------------------------

/** EV-4: キーを押す口も持つ page（Playwright の page がそのまま当てはまる形）。 */
export interface KeyboardRevealPage extends RevealPage {
  readonly keyboard: { press(key: string): Promise<unknown> };
}

/**
 * EV-4: 押してよいキーの閉じた一覧（Tab・Shift+Tab・矢印。文字・Enter・Space は押さない）。キーを押すのは `pressRegionKey` の 1 か所だけ（Architecture Gate
 * `tests/architecture/worker-login-hooks.test.ts` の (q) が、この一覧と押す所を確かめる）。
 */
export const SCROLLABLE_REGION_KEYS = Object.freeze(['Tab', 'Shift+Tab', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'] as const);
type ScrollableRegionKey = (typeof SCROLLABLE_REGION_KEYS)[number];
type ScrollableRegionArrowKey = Exclude<ScrollableRegionKey, 'Tab' | 'Shift+Tab'>;

/** 一覧のキーだけを押す（一覧の外は押さずに投げる）。 */
const pressRegionKey = (page: KeyboardRevealPage, key: ScrollableRegionKey): Promise<unknown> => {
  if (!(SCROLLABLE_REGION_KEYS as readonly string[]).includes(key)) {
    throw new RangeError(`a key outside the scrollable region keys: ${String(key)}`);
  }
  return page.keyboard.press(key);
};

/**
 * Tab の起点にする、フォーカスできる要素（リンクは `:any-link`。行き先は読まない。GATE-ARCH03）。値を入れる要素（入力欄・選択の部品・編集できる要素）は、
 * Tab をサイトが文字として扱うことがあるので、起点にしない。Chromium が Tab で止めるスクロールの領域も含まない（起点から Tab を押していく間に通る）。
 */
const TAB_START_SELECTOR = ':any-link, button, [tabindex]';

/** 値を入れる要素（ここにフォーカスが来たら、Tab も矢印のキーも押さない）。 */
const EDITABLE_SELECTOR = 'input, select, textarea, [contenteditable]:not([contenteditable="false" i])';

/**
 * REV-EV4: ページの中に、確かめの間だけ置く物の名前（window の、列挙されないプロパティ。確かめた後に消す）。`between` は準備の時点の起点と領域の間の要素の
 * 集合（M-1。Tab の終わりを構造で決める）、`arrowStop` はキーを押す間の止め（C-1。`holdPageReader`）、`scrollEnd` は矢印のキーの後のスクロールの終わりの待ち。
 */
const IN_PAGE_KEYS = Object.freeze({
  between: '__beaksightScrollRegionBetween', arrowStop: '__beaksightScrollRegionArrowStop', scrollEnd: '__beaksightScrollRegionScrollEnd',
});

/** 要素のスクロールの位置。 */
interface RawOffset {
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

/** 領域を確かめる前の事実（ページの中で読み、Tab の起点にフォーカスを当てた後）。 */
interface RawRegionPrepared {
  /** 領域を引けたか。 */
  readonly found: boolean;
  /** 押す矢印のキー（スクロールの余地がなければ `null`）。 */
  readonly arrowKey: ScrollableRegionArrowKey | null;
  /** 起点から押すキー（前の要素なら `Tab`、前になく後の要素なら `Shift+Tab`。起点にフォーカスを当てられなければ `null`）。 */
  readonly tabKey: 'Tab' | 'Shift+Tab' | null;
  readonly startPath: readonly number[] | null;
  /** 確かめる前にフォーカスのあった要素の位置（body・なしは `null`）。 */
  readonly activePath: readonly number[] | null;
  readonly offset: RawOffset | null;
}

/**
 * ページの中で、領域のスクロールの余地から押す矢印のキーを決め、Tab の起点（領域の前の、いちばん近いフォーカスできる要素。なければ後のいちばん近い要素）に、
 * スクロールさせずにフォーカスを当てる。REV-EV4 の M-1: 起点と領域の間の要素（文書の順。領域を含む祖先も入る。領域の子孫は入らない）の集合を、今の時点で
 * ページの中に置く（`betweenKey`。Tab の途中で集合の外へ移ったら止める）。
 */
function prepareRegionReader(R: StandardReaders, { selector, startSelector, editableSelector, betweenKey }: {
  readonly selector: string;
  readonly startSelector: string;
  readonly editableSelector: string;
  readonly betweenKey: string;
}): RawRegionPrepared {
  const active = R.documentProperty<Element | null>('activeElement');
  const body = R.documentProperty<HTMLElement | null>('body');
  const activePath = active === null || active === body ? null : R.elementPathOf(active);
  const region = ((): Element | null => {
    try {
      return Document.prototype.querySelector.call(document, selector);
    } catch {
      return null;
    }
  })();
  if (region === null) {
    return { found: false, arrowKey: null, tabKey: null, startPath: null, activePath, offset: null };
  }
  const number = (name: string): number => R.standardGetter<number>(Element.prototype, name)(region);
  const offset = { scrollLeft: number('scrollLeft'), scrollTop: number('scrollTop') };
  const style = window.getComputedStyle(region);
  const movable = ['auto', 'scroll', 'overlay'];
  const roomX = movable.includes(style.overflowX) ? number('scrollWidth') - number('clientWidth') : 0;
  const roomY = movable.includes(style.overflowY) ? number('scrollHeight') - number('clientHeight') : 0;
  // 右から左の書字では、始めの端が右（scrollLeft は 0 から負へ）なので、左の矢印で動かす。
  const [forward, backward]: readonly [ScrollableRegionArrowKey, ScrollableRegionArrowKey] = style.direction === 'rtl'
    ? ['ArrowLeft', 'ArrowRight']
    : ['ArrowRight', 'ArrowLeft'];
  const arrowKey: ScrollableRegionArrowKey | null = roomX > 0
    ? (Math.abs(offset.scrollLeft) < roomX ? forward : backward)
    : roomY > 0 ? (offset.scrollTop < roomY ? 'ArrowDown' : 'ArrowUp') : null;
  const contains = (owner: Node, other: Node): boolean => Node.prototype.contains.call(owner, other);
  const candidates = Array.from(Document.prototype.querySelectorAll.call(document, startSelector)).filter((element): element is HTMLElement => {
    const tabIndex = Element.prototype.getAttribute.call(element, 'tabindex');
    return element instanceof HTMLElement && !contains(region, element) && !contains(element, region)
      && !Element.prototype.matches.call(element, `:disabled, ${editableSelector}`) && !R.standardGetter<boolean>(HTMLElement.prototype, 'isContentEditable')(element)
      && !(tabIndex !== null && Number.parseInt(tabIndex, 10) < 0) && Element.prototype.checkVisibility.call(element, { visibilityProperty: true });
  });
  const position = (element: Element): number => Node.prototype.compareDocumentPosition.call(region, element);
  const before = candidates.filter((element) => (position(element) & Node.DOCUMENT_POSITION_PRECEDING) !== 0);
  const after = candidates.filter((element) => (position(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const start = before[before.length - 1] ?? after[0];
  if (start === undefined || arrowKey === null) {
    return { found: true, arrowKey, tabKey: null, startPath: null, activePath, offset };
  }
  const forwardTab = before.length > 0;
  const between = new WeakSet<Element>();
  const walker = Document.prototype.createTreeWalker.call(document, document.documentElement, NodeFilter.SHOW_ELEMENT);
  const [from, to] = forwardTab ? [start, region] : [region, start];
  walker.currentNode = from;
  for (let node = walker.nextNode(); node !== null && node !== to; node = walker.nextNode()) {
    if (!contains(region, node)) between.add(node as Element);
  }
  Object.defineProperty(window, betweenKey, { value: between, configurable: true, enumerable: false });
  HTMLElement.prototype.focus.call(start, { preventScroll: true });
  const focused = R.documentProperty<Element | null>('activeElement') === start;
  return { found: true, arrowKey, tabKey: focused ? (forwardTab ? 'Tab' : 'Shift+Tab') : null, startPath: R.elementPathOf(start), activePath, offset };
}
const prepareRegionInPage = composeInPage(prepareRegionReader);

/**
 * Tab を 1 回押した後のフォーカスの位置。`REACHED` は領域、`BETWEEN` は準備の時点の起点と領域の間の要素（領域を含む祖先を含む）、`PASSED` は越えた・ほかへ
 * 移った。キーを押し続けると値が変わりうる所・確かめられない所は、そこで止める（`INSIDE` は領域の子孫で、矢印のキーを押さない。`EDITABLE` は間の、値を入れる
 * 要素。`FRAME` は枠の中。`CHANGED` は起点と領域の間の、準備の時点になかった要素）。REV-EV4 の I-2: 値を入れる要素と枠は、影の木の中まで深くたどった
 * フォーカスで見る。
 */
interface RawTabStep {
  readonly state: 'REACHED' | 'INSIDE' | 'BETWEEN' | 'EDITABLE' | 'FRAME' | 'CHANGED' | 'PASSED';
  readonly activePath: readonly number[] | null;
}

/** ページの中で、今のフォーカスが、領域に届いたか・起点と領域の間にあるか（押した向きの順で）を読む。 */
function tabStepReader(R: StandardReaders, { selector, startPath, forward, editableSelector, betweenKey }: {
  readonly selector: string;
  readonly startPath: readonly number[];
  readonly forward: boolean;
  readonly editableSelector: string;
  readonly betweenKey: string;
}): RawTabStep {
  const region = ((): Element | null => {
    try {
      return Document.prototype.querySelector.call(document, selector);
    } catch {
      return null;
    }
  })();
  const start = R.elementAtPath(startPath);
  const active = R.documentProperty<Element | null>('activeElement');
  const activePath = active === null ? null : R.elementPathOf(active);
  if (region === null || start === null || active === null) {
    return { state: 'PASSED', activePath };
  }
  // 影の木の中のフォーカスを深くたどる。
  let deep: Element = active;
  for (let inner = deep.shadowRoot?.activeElement ?? null; inner !== null; inner = inner.shadowRoot?.activeElement ?? null) {
    deep = inner;
  }
  if (active === region || Node.prototype.contains.call(region, active)) {
    return { state: active === region && deep === region ? 'REACHED' : 'INSIDE', activePath };
  }
  if (Element.prototype.matches.call(deep, 'iframe, frame, object, embed')) {
    return { state: 'FRAME', activePath };
  }
  const between = (window as unknown as Record<string, WeakSet<Element> | undefined>)[betweenKey];
  if (between?.has(active) === true) {
    const editable = Element.prototype.matches.call(deep, editableSelector)
      || (deep instanceof HTMLElement && R.standardGetter<boolean>(HTMLElement.prototype, 'isContentEditable')(deep));
    return { state: editable ? 'EDITABLE' : 'BETWEEN', activePath };
  }
  const [toward, away] = forward
    ? [Node.DOCUMENT_POSITION_FOLLOWING, Node.DOCUMENT_POSITION_PRECEDING]
    : [Node.DOCUMENT_POSITION_PRECEDING, Node.DOCUMENT_POSITION_FOLLOWING];
  const inRange = (Node.prototype.compareDocumentPosition.call(start, active) & toward) !== 0
    && (Node.prototype.compareDocumentPosition.call(region, active) & away) !== 0;
  return { state: inRange ? 'CHANGED' : 'PASSED', activePath };
}
const tabStepInPage = composeInPage(tabStepReader);

/** ページの中に置く、キーを押す間の止め（外す口・ページの window.open・止めた数）。 */
interface InPageHold {
  readonly controller: AbortController;
  readonly open: typeof window.open;
  blocked: number;
}

/**
 * REV-EV4 の C-1: ページの中で、キーを押す間の止めを付ける（外すのは `restoreRegionReader`）。
 * - （b）矢印のキーの keydown・keyup・keypress を、window の capture の段で止める（伝わりだけを止め、既定の動き＝ブラウザのスクロールは止めない）。
 * - ページが始めた画面の移動（Navigation API の `navigate`）を取り消し、`window.open` を開かない形に替えて、止めた数を数える。
 * BeakSight より先に window の capture の段に付いたページの handler と、前に控えた `window.open` には届く（Guard が網になる）。
 */
function holdPageReader(_R: StandardReaders, { stopKey }: { readonly stopKey: string }): void {
  const hold: InPageHold = { controller: new AbortController(), open: window.open, blocked: 0 };
  const { signal } = hold.controller;
  const stop = (event: Event): void => {
    if (typeof (event as KeyboardEvent).key === 'string' && (event as KeyboardEvent).key.startsWith('Arrow')) {
      event.stopImmediatePropagation();
    }
  };
  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, stop, { capture: true, signal });
  }
  const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigate', (event) => {
    if (event.cancelable) {
      event.preventDefault();
      hold.blocked += 1;
    }
  }, { signal });
  window.open = () => {
    hold.blocked += 1;
    return null;
  };
  Object.defineProperty(window, stopKey, { value: hold, configurable: true, enumerable: false });
}
const holdPageInPage = composeInPage(holdPageReader);

/**
 * ページの中で、描画の 2 回分（`requestAnimationFrame` を 2 回）を待つ（描画が止まっている page では、`fallbackMs` で終える）。EV-4 の調べ: headless の
 * Chromium は、スクロールした後に描画を 1 回も作らないまま矢印のキーを押すと、領域を動かさないことがある（描画を待てば動く）。
 */
function framesReader(_R: StandardReaders, { fallbackMs }: { readonly fallbackMs: number }): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, fallbackMs);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
const framesInPage = composeInPage(framesReader);

/** ページの中で、領域の今のスクロールの位置を読む（引けなければ `null`）。 */
function regionOffsetReader(R: StandardReaders, { selector }: { readonly selector: string }): RawOffset | null {
  const region = ((): Element | null => {
    try {
      return Document.prototype.querySelector.call(document, selector);
    } catch {
      return null;
    }
  })();
  return region === null ? null : {
    scrollLeft: R.standardGetter<number>(Element.prototype, 'scrollLeft')(region),
    scrollTop: R.standardGetter<number>(Element.prototype, 'scrollTop')(region),
  };
}
const regionOffsetInPage = composeInPage(regionOffsetReader);

/**
 * ページの中で、確かめの間だけ置いた物（キーを押す間の止め・間の要素の集合）を外し、領域の位置を前へ戻し（すぐに動かす）、元のフォーカスへ戻す（元がなければ、
 * 今のフォーカスを外す）。止めの間に、ページの中で止めた移動とポップアップの数を返す。
 */
function restoreRegionReader(R: StandardReaders, { selector, offset, activePath, stopKey, betweenKey }: {
  readonly selector: string;
  readonly offset: RawOffset | null;
  readonly activePath: readonly number[] | null;
  readonly stopKey: string;
  readonly betweenKey: string;
}): number {
  const hold = (window as unknown as Record<string, InPageHold | undefined>)[stopKey];
  if (hold !== undefined) {
    hold.controller.abort();
    window.open = hold.open;
  }
  for (const key of [stopKey, betweenKey]) {
    Reflect.deleteProperty(window, key);
  }
  const blockedInPage = hold?.blocked ?? 0;
  const region = ((): Element | null => {
    try {
      return Document.prototype.querySelector.call(document, selector);
    } catch {
      return null;
    }
  })();
  if (region !== null && offset !== null) {
    (Element.prototype.scrollTo as (this: Element, options: ScrollToOptions) => void)
      .call(region, { left: offset.scrollLeft, top: offset.scrollTop, behavior: 'instant' });
  }
  const previous = activePath === null ? null : R.elementAtPath(activePath);
  if (previous instanceof HTMLElement) {
    HTMLElement.prototype.focus.call(previous, { preventScroll: true });
    return blockedInPage;
  }
  const active = R.documentProperty<Element | null>('activeElement');
  if (active instanceof HTMLElement) {
    HTMLElement.prototype.blur.call(active);
  }
  return blockedInPage;
}
const restoreRegionInPage = composeInPage(restoreRegionReader);

/**
 * REV-EV4 の M-4: ページの中で、矢印のキーで始まる領域のスクロールが終わるのを待つ口を置く（`scrollend`。動かなければ `fallbackMs` で終える）。押す前に置き、
 * 押した後に `awaitScrollEndReader` で待つ（領域ごとの待ちは、この 1 つ）。
 */
function watchScrollEndReader(_R: StandardReaders, { selector, endKey, fallbackMs }: {
  readonly selector: string;
  readonly endKey: string;
  readonly fallbackMs: number;
}): void {
  let region: Element | null = null;
  try {
    region = Document.prototype.querySelector.call(document, selector);
  } catch {
    region = null;
  }
  const target = region;
  const ended = new Promise<void>((resolve) => {
    setTimeout(resolve, fallbackMs);
    target?.addEventListener('scrollend', () => resolve(), { once: true });
  });
  Object.defineProperty(window, endKey, { value: ended, configurable: true, enumerable: false });
}
const watchScrollEndInPage = composeInPage(watchScrollEndReader);

/** ページの中で、`watchScrollEndReader` の口を待って外す。 */
async function awaitScrollEndReader(_R: StandardReaders, { endKey }: { readonly endKey: string }): Promise<void> {
  const ended = (window as unknown as Record<string, Promise<void> | undefined>)[endKey];
  Reflect.deleteProperty(window, endKey);
  await ended;
}
const awaitScrollEndInPage = composeInPage(awaitScrollEndReader);

/** ページの中で、文書と動かした祖先を、動かした後の位置（同じ帯の次の領域を確かめる位置）へ戻す（Tab のフォーカスのスクロールを打ち消す）。 */
function returnToBandReader(_R: StandardReaders, { scroll }: { readonly scroll: FocusCheckScrollEvidence }): void {
  for (const ancestor of scroll.ancestors) {
    let node: Element | null = null;
    try {
      node = Document.prototype.querySelector.call(document, ancestor.selector);
    } catch {
      node = null;
    }
    if (node !== null) {
      (Element.prototype.scrollTo as (this: Element, options: ScrollToOptions) => void)
        .call(node, { left: ancestor.after.scrollLeft, top: ancestor.after.scrollTop, behavior: 'instant' });
    }
  }
  window.scrollTo({ left: scroll.document.after.scrollX, top: scroll.document.after.scrollY, behavior: 'instant' });
}
const returnToBandInPage = composeInPage(returnToBandReader);

/** EV-4: 確かめる領域（axe の要素の selector の並び）。 */
export interface ScrollableRegionTarget {
  readonly targetSelectors: readonly AccessibilityTargetSelector[];
}

/**
 * REV-EV4 の C-1（a）: キーの押下の期間の Guard の口（`scrollKeyPressGuardOf`。`begin` が偽なら押さない。`blocked` は、その期間に Guard が止めた main frame の
 * 移動とポップアップの数）。
 */
export interface ScrollKeyPressGuard {
  readonly begin: () => boolean;
  readonly end: () => void;
  readonly blocked: () => number;
}

/** `checkScrollableRegions` の指定。 */
export interface ScrollableRegionCheckOptions {
  /** 動かした後の落ち着きの待ち（ms。今のスクロールの待ちの値を渡す。帯ごとに 1 回）。描画が止まった page の描画の待ちの終わりにも使う。 */
  readonly settleMs: number;
  /** キーの押下の期間の Guard の口（なければ、キーを押さずに `NOT_TRIED`）。 */
  readonly keyPressGuard?: ScrollKeyPressGuard | undefined;
  /** 領域まで動かして撮る口（撮らない設定は省く）。 */
  readonly capture?: RevealCapturePort<EvidenceId> | undefined;
  /** 進みの見張りの口（ページの読み取りが返るたびに印を付ける）。 */
  readonly track?: (<T>(work: Promise<T>) => Promise<T>) | undefined;
}

/**
 * EV-4（設計書 3.4）: 横にスクロールする領域（axe の `scrollable-region-focusable` の要素）ごとに、領域まで動かして撮り、Tab で届くか（前のフォーカスできる
 * 要素から Tab を押していき、領域に届くか・越えるか。前になければ後の要素から Shift+Tab）、届いたら矢印のキーで位置が動くかを試し、前と後の位置を記録して、
 * 領域・フォーカス・文書とスクロールの祖先を元へ戻す。Tab を押す数は、起点と領域の間にある要素の数で決まる（同じ要素に戻ったら止める）。値は変えない
 * （値を入れる要素は起点にせず、そこへフォーカスが来たら Tab を止める。矢印のキーは、フォーカスが領域そのものにあるときだけ押す）。
 * 文書の selector で引けない要素（枠・影の木の中）と、読めなくなった領域は `NOT_TRIED`（例外は投げない）。結果は `targets` の順。
 * REV-EV4:
 * - C-1: 矢印のキーは、押す間だけ window の capture の段でページの handler へ伝えない（b）。キーを押す期間（起点にフォーカスを当ててから戻すまで）は、Guard の
 *   口で main frame の移動とポップアップを止め、止めたら `KEY_TRIGGERED_NAVIGATION`（a）。Guard の口がない・始められないときは押さない。
 * - M-4: 同じ帯（動かした位置で画像に全部入る）の領域は 1 枚にまとめて撮り、帯ごとに 1 回だけ落ち着きを待つ。領域ごとの待ちは描画の待ち（矢印のキーの前と後）。
 */
export async function checkScrollableRegions(
  page: KeyboardRevealPage,
  targets: readonly ScrollableRegionTarget[],
  options: ScrollableRegionCheckOptions,
): Promise<readonly ScrollableRegionKeyboardEvidence[]> {
  const track = options.track ?? (<T>(work: Promise<T>): Promise<T> => work);
  const results = new Map<number, ScrollableRegionKeyboardEvidence>();
  const resultOf = (
    index: number,
    fields: Partial<Pick<ScrollableRegionKeyboardEvidence, 'outcome' | 'keys' | 'region' | 'scroll' | 'screenshotEvidenceId'>>,
  ): void => {
    results.set(index, Object.freeze({
      targetSelectors: Object.freeze([...(targets[index]?.targetSelectors ?? [])]),
      outcome: fields.outcome ?? 'NOT_TRIED',
      keys: Object.freeze([...(fields.keys ?? [])]),
      region: fields.region === undefined || fields.region === null ? null : Object.freeze(fields.region),
      scroll: fields.scroll ?? null,
      screenshotEvidenceId: fields.screenshotEvidenceId ?? null,
    }));
  };
  const frames = (): Promise<void> => track(page.evaluate(framesInPage, { fallbackMs: options.settleMs }));
  const cleanupKeys = { stopKey: IN_PAGE_KEYS.arrowStop, betweenKey: IN_PAGE_KEYS.between };

  /** 1 つの領域の Tab と矢印のキーの確かめ（領域は帯の位置で画面に入っている）。確かめた後に、領域・フォーカス・文書を帯の位置へ戻す。 */
  const tryKeys = async (index: number, selector: string, scroll: FocusCheckScrollEvidence, screenshotEvidenceId: EvidenceId | null): Promise<void> => {
    const guard = options.keyPressGuard;
    if (guard === undefined || !guard.begin()) {
      resultOf(index, { scroll, screenshotEvidenceId });
      return;
    }
    const blockedBefore = guard.blocked();
    const keys: string[] = [];
    let outcome: ScrollableRegionKeyboardEvidence['outcome'] = 'NOT_TRIED';
    let region: ScrollAncestorPositionEvidence | null = null;
    let prepared: RawRegionPrepared | null = null;
    let blockedInPage = 0;
    try {
      await track(page.evaluate(holdPageInPage, { stopKey: IN_PAGE_KEYS.arrowStop }));
      prepared = await track(page.evaluate(prepareRegionInPage, {
        selector, startSelector: TAB_START_SELECTOR, editableSelector: EDITABLE_SELECTOR, betweenKey: IN_PAGE_KEYS.between,
      }));
      const { tabKey, startPath, arrowKey } = prepared;
      if (tabKey !== null && startPath !== null && arrowKey !== null) {
        // 準備の時点の起点と領域の間の要素を 1 つずつ進む（集合の外へ移ったら止める。同じ要素に戻ったら、試せなかったとして止める）。
        const seen = new Set<string>();
        let step: RawTabStep = { state: 'BETWEEN', activePath: startPath };
        while (step.state === 'BETWEEN' && !seen.has(JSON.stringify(step.activePath))) {
          seen.add(JSON.stringify(step.activePath));
          await track(pressRegionKey(page, tabKey));
          keys.push(tabKey);
          step = await track(page.evaluate(tabStepInPage, {
            selector, startPath, forward: tabKey === 'Tab', editableSelector: EDITABLE_SELECTOR, betweenKey: IN_PAGE_KEYS.between,
          }));
        }
        if (step.state === 'REACHED') {
          // 描画を待ってから押す（headless の Chromium は、描画の前の矢印のキーで動かないことがある）。押した後も描画を待って読む。
          await frames();
          const before = await track(page.evaluate(regionOffsetInPage, { selector }));
          // 押した後は、領域のスクロールが終わる（`scrollend`。動かなければスクロールの待ちの値）まで待って読む（終わる前に戻すと、残りの動きが戻しを打ち消す）。
          const pressArrow = async (): Promise<RawOffset | null> => {
            await track(page.evaluate(watchScrollEndInPage, { selector, endKey: IN_PAGE_KEYS.scrollEnd, fallbackMs: options.settleMs }));
            await track(pressRegionKey(page, arrowKey));
            keys.push(arrowKey);
            await track(page.evaluate(awaitScrollEndInPage, { endKey: IN_PAGE_KEYS.scrollEnd }));
            return track(page.evaluate(regionOffsetInPage, { selector }));
          };
          const moved = (offset: RawOffset | null): boolean =>
            before !== null && offset !== null && (before.scrollLeft !== offset.scrollLeft || before.scrollTop !== offset.scrollTop);
          let after = await pressArrow();
          if (!moved(after)) {
            // テストの既定の headless shell は、起こしたばかりの最初の描画のころの矢印のキーを取りこぼすことがある（REV-EV4 の調べ。CLI の Chromium では起きない）。
            // 動かなければ、描画を待ってもう一度だけ押して確かめる（止めるページでは 2 回とも動かない）。
            await frames();
            after = await pressArrow();
          }
          if (before !== null && after !== null) {
            region = { selector, before, after };
            outcome = before.scrollLeft !== after.scrollLeft || before.scrollTop !== after.scrollTop ? 'REACHED_AND_MOVED' : 'REACHED_NOT_MOVED';
          }
        } else if (step.state === 'PASSED') {
          outcome = 'NOT_REACHED';
        }
      }
    } catch {
      // 読めなくなった領域は、試せなかったとして残す（ほかの領域と、後の段の証拠には影響させない）。
      outcome = 'NOT_TRIED';
      region = null;
    } finally {
      const restore = async (): Promise<void> => {
        blockedInPage += await track(page.evaluate(restoreRegionInPage, {
          selector, offset: prepared?.offset ?? null, activePath: prepared?.activePath ?? null, ...cleanupKeys,
        }));
        await track(page.evaluate(returnToBandInPage, { scroll }));
      };
      await restore().catch(() => undefined);
      // 矢印のキーの smooth のスクロールが残って戻し損ねたら、もう一度だけ戻す。
      const now = await track(page.evaluate(regionOffsetInPage, { selector })).catch(() => null);
      if (prepared?.offset !== undefined && prepared.offset !== null && now !== null
        && (now.scrollLeft !== prepared.offset.scrollLeft || now.scrollTop !== prepared.offset.scrollTop)) {
        await restore().catch(() => undefined);
      }
      guard.end();
    }
    // C-1: キーを押した期間に、ページが画面を移そうとした（ページの中の止めか、Guard が止めた）。
    if (blockedInPage > 0 || guard.blocked() > blockedBefore) {
      outcome = 'KEY_TRIGGERED_NAVIGATION';
    }
    resultOf(index, { outcome, keys, region, scroll, screenshotEvidenceId });
  };

  // 文書の selector 1 つで引ける領域だけを、帯ごとに動かして撮り、確かめる（ほかは試せなかった）。
  const pending: { readonly index: number; readonly spec: RevealTargetSpec }[] = [];
  targets.forEach(({ targetSelectors }, index) => {
    const [selector] = targetSelectors;
    if (targetSelectors.length === 1 && typeof selector === 'string') {
      pending.push({ index, spec: { purpose: 'SCROLLABLE_REGION', selectors: [selector] } });
    } else {
      resultOf(index, {});
    }
  });
  for (let lead = pending.shift(); lead !== undefined; lead = pending.shift()) {
    let scroll: FocusCheckScrollEvidence | null = null;
    const band = [lead];
    try {
      scroll = await track(page.evaluate(moveInPage, { spec: lead.spec, segment: null, position: 'TARGET', maxSelectorDepth: MAX_SELECTOR_DEPTH }));
      if (scroll === null) {
        resultOf(lead.index, {});
        continue;
      }
      await track(wait(options.settleMs));
      const state = await track(page.evaluate(measureInPage, {
        targets: [lead, ...pending].map(({ spec }) => ({ spec, segment: null })), insetPx: HIT_TEST_POINT_INSET_PX, controlSelector: CONTROL_SELECTOR,
      }));
      const [own, ...others] = state.measures;
      const measured: RevealedTargetEvidence[] = own === undefined ? [] : [freezeMeasured(lead.spec, 'TARGET', scroll, own, null)];
      const bandScroll = scroll;
      others.forEach((measure, position) => {
        const other = pending[position];
        if (other !== undefined && measure.found && targetImageInclusionOf(measure, true) === 'INSIDE') {
          band.push(other);
          measured.push(freezeMeasured(other.spec, 'TARGET', bandScroll, measure, null));
        }
      });
      for (const member of band.slice(1)) {
        pending.splice(pending.indexOf(member), 1);
      }
      const screenshotEvidenceId = options.capture === undefined || measured.length === 0
        ? null
        : await options.capture(Object.freeze({ viewportWidth: state.viewportWidth, viewportHeight: state.viewportHeight, targets: Object.freeze(measured) }))
          .catch(() => null);
      for (const member of band) {
        await tryKeys(member.index, member.spec.selectors[0] ?? '', bandScroll, screenshotEvidenceId);
      }
    } catch {
      // 読めなくなった帯は、まだ結果のない領域を試せなかったとして残す。
      for (const member of band) {
        if (!results.has(member.index)) resultOf(member.index, { scroll });
      }
    } finally {
      if (scroll !== null) {
        await track(page.evaluate(restoreInPage, { scroll })).catch(() => undefined);
      }
    }
  }
  return Object.freeze(targets.map((_target, index) => results.get(index) ?? Object.freeze({
    targetSelectors: Object.freeze([...(targets[index]?.targetSelectors ?? [])]),
    outcome: 'NOT_TRIED' as const, keys: Object.freeze([]), region: null, scroll: null, screenshotEvidenceId: null,
  })));
}
