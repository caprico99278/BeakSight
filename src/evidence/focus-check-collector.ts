/**
 * AUD-4d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4d）: 画面の外に置いた、フォーカスできる要素（スキップリンクなど）に、
 * フォーカスを当てて、矩形・見えるか・押せるか（hit-test）を読む Collector。判定（現れるか・隠れたままか）はしない（Rule の側の `focusCheckOutcomeOf`）。
 * - 呼ぶ側は、ほかの証拠を集め終えた後に呼ぶ（フォーカスでページの JS が状態を変えても、後の証拠を汚さないため。設計者の判断 2026-11-10）。
 * - 対象: 文書の中の、フォーカスできる要素（`a[href]`・`button`・`input`（hidden を除く）・`select`・`textarea`・`[tabindex]`）で、無効でなく、`tabindex` が負でなく、
 *   描かれる箱があり（`getClientRects` が 1 つ以上）、フォーカスの前に画面の外にあるもの（全体がビューポートの左か右の外・文書の上の外、または幅か高さが 1px 以下）。
 *   数の上限は置かない。
 * - 1 つずつ、フォーカスを当て（EV-1: `preventScroll` をやめ、ブラウザのフォーカスのスクロールに任せる。横のスクロールの中の要素が画面に出る）、前と後の位置（文書と
 *   スクロールの祖先）・矩形・見えるか・押せるか（複数の点の hit-test）を読み、呼ぶ側の口（`onFocused`。フォーカスを当てたままの画像を撮る）を呼び、元のフォーカスと
 *   前の位置に戻す（元がなければ blur）。読み込みと BeakSight の要求は足さない。フォーカスでページが出す送信は、Guard の決まりのまま扱う。
 * - 読み始める前に、文書の先頭へ戻す（主の画像と同じ位置で読む）。
 * - REV-SD2 の M-2・M-3: フォーカスの後と戻した後は、位置が落ち着く（続けて 2 回同じ）まで読んでから判定・確かめをする（smooth のスクロール）。祖先は、スクロールの
 *   祖先に限らず、位置が変わったものを全部記録して戻す（`overflow: hidden` の祖先を含む）。
 */
import type { Page } from 'playwright';
import { scrollDocumentToOrigin } from '../browser/controlled-scroll.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import type { EvidenceId } from '../core/contracts.js';
import type { FocusCheckEvidence, FocusCheckItemEvidence, RectangleEvidence, ScrollPosition } from '../core/evidence-types.js';
import { wait } from '../core/deadline.js';
import { MAX_SELECTOR_DEPTH } from '../core/limits.js';
import { observationWindowsOrProduction } from '../core/observation-windows.js';
import { LAYOUT_THRESHOLDS } from './layout-collector.js';

/**
 * フォーカスできる要素の selector（ページの中で探す）。リンクは `:any-link`（行き先のあるリンク。リンクの取り出しは `src/crawl/discover-links.ts` の 1 か所で、
 * ここは行き先を読まない。GATE-ARCH03）。
 */
const FOCUSABLE_SELECTOR = ':any-link, button, input:not([type="hidden"]), select, textarea, [tabindex]';

/** 大きさがこの値以下の要素は、画面から隠した要素とみなす（px。視覚的に隠す手法の 1px）。 */
const HIDDEN_MAX_DIMENSION_PX = 1;

/** EV-1: 押せるかを読む四隅の点を、矩形の内側へ寄せる量（px。layout の重なりの hit-test の点 `LAYOUT_THRESHOLDS.hitTestPointInsetPx` と同じ値）。 */
const HIT_TEST_POINT_INSET_PX = LAYOUT_THRESHOLDS.hitTestPointInsetPx;

interface ListArgument {
  readonly focusableSelector: string;
  readonly hiddenMaxDimensionPx: number;
  readonly maxSelectorDepth: number;
}

interface RawCandidate {
  readonly path: readonly number[];
  readonly selector: string;
  readonly tagName: string;
  readonly beforeRect: RectangleEvidence;
}

interface RawList {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly active: readonly number[] | null;
  readonly candidates: readonly RawCandidate[];
}

/** ページの中で、対象の要素と、今フォーカスのある要素の位置を読む（読むだけ）。 */
function listFocusCandidatesReader(R: StandardReaders, { focusableSelector, hiddenMaxDimensionPx, maxSelectorDepth }: ListArgument): RawList {
  const tagNameOf = R.standardGetter<string>(Element.prototype, 'tagName');
  const rectOf = (element: Element): RectangleEvidence => {
    const box = Element.prototype.getBoundingClientRect.call(element);
    return { x: box.x, y: box.y, top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
  };
  // LZ-2: セレクタの長さの上限（前は `MAX_SELECTOR_LENGTH`）は置かない。切り詰めない。EV-1: 書き方は部品（`R.selectorOf`）の 1 か所。
  const selectorOf = (element: Element): string => R.selectorOf(element, maxSelectorDepth);
  const width = window.innerWidth;
  const height = window.innerHeight;
  const candidates: RawCandidate[] = [];
  for (const node of R.queryAllInRoots([document], focusableSelector)) {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
      continue;
    }
    const element = node as Element;
    const tabIndex = Element.prototype.getAttribute.call(element, 'tabindex');
    if (Element.prototype.matches.call(element, ':disabled') || (tabIndex !== null && Number.parseInt(tabIndex, 10) < 0)) {
      continue;
    }
    if (Element.prototype.getClientRects.call(element).length === 0) {
      continue;
    }
    const box = rectOf(element);
    const outside = box.right <= 0 || box.left >= width || box.bottom + window.scrollY <= 0;
    const tiny = box.width <= hiddenMaxDimensionPx || box.height <= hiddenMaxDimensionPx;
    const path = R.elementPathOf(element);
    if (!(outside || tiny) || path === null) {
      continue;
    }
    candidates.push({ path, selector: selectorOf(element), tagName: tagNameOf(element).toLowerCase(), beforeRect: box });
  }
  const active = R.documentProperty<Element | null>('activeElement');
  const body = R.documentProperty<HTMLElement | null>('body');
  return {
    viewportWidth: width,
    viewportHeight: height,
    active: active === null || active === body ? null : R.elementPathOf(active),
    candidates,
  };
}
const listFocusCandidatesInPage = composeInPage(listFocusCandidatesReader);

/** スクロールの祖先 1 つの位置。 */
interface RawOffset {
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

/** フォーカスの前と後の、文書とスクロールの祖先の位置（祖先は内から外の順）。 */
interface RawScroll {
  readonly document: { readonly before: ScrollPosition; readonly after: ScrollPosition };
  readonly ancestors: readonly { readonly selector: string; readonly before: RawOffset; readonly after: RawOffset }[];
}

/**
 * REV-SD2 の M-2・M-3: 要素の祖先の全部（親から外へ。文書の根と `scrollingElement` は除く）と、文書の位置。`overflow: hidden` の祖先も、フォーカスで動けば
 * 戻すため、スクロールの祖先に限らず全部を読む（祖先は要素の位置から同じ順で引き直す）。
 */
interface RawChainPositions {
  readonly document: ScrollPosition;
  readonly chain: readonly RawOffset[];
}

/** フォーカスを当てた後の事実（要素がなければ `null`）。 */
interface RawFocused {
  readonly focused: boolean;
  readonly afterRect: RectangleEvidence | null;
  readonly visibleAfterFocus: boolean;
  readonly hitAfterFocus: boolean;
  readonly hitTestPointCount: number;
  readonly hitPointCount: number;
  readonly scroll: RawScroll;
}

/** ページの中で、位置の要素の祖先の全部と文書の位置を読む（要素がなければ `null`）。 */
function chainPositionsReader(R: StandardReaders, { path }: { readonly path: readonly number[] }): RawChainPositions | null {
  const element = R.elementAtPath(path);
  if (element === null) {
    return null;
  }
  const parentElementOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  const root = R.documentProperty<Element | null>('documentElement');
  const scrollingElement = R.documentProperty<Element | null>('scrollingElement');
  const chain: RawOffset[] = [];
  for (let node = parentElementOf(element); node !== null && node !== root && node !== scrollingElement; node = parentElementOf(node)) {
    chain.push({ scrollLeft: R.standardGetter<number>(Element.prototype, 'scrollLeft')(node), scrollTop: R.standardGetter<number>(Element.prototype, 'scrollTop')(node) });
  }
  return { document: { scrollX: window.scrollX, scrollY: window.scrollY }, chain };
}
const chainPositionsInPage = composeInPage(chainPositionsReader);

/** ページの中で、位置の要素にフォーカスを当てる（EV-1: スクロールを止めない。ブラウザのフォーカスのスクロールに任せる）。 */
function focusReader(R: StandardReaders, { path }: { readonly path: readonly number[] }): void {
  const element = R.elementAtPath(path);
  if (element !== null) {
    HTMLElement.prototype.focus.call(element);
  }
}
const focusInPage = composeInPage(focusReader);

/**
 * ページの中で、フォーカスの位置が落ち着いた後に、前と後の位置・矩形・見えるか・押せるかを読む。祖先は、スクロールの祖先（`R.scrollAncestorsOf`）と、位置が
 * 変わった祖先（REV-SD2 の M-3）。押せるかは、ビューポートの中の矩形の中心と、内側に寄せた四隅の点で読む（点の 1 つでも、最前面がその要素か子孫なら押せる）。
 */
function readFocusedReader(R: StandardReaders, { path, before, maxSelectorDepth, insetPx }: {
  readonly path: readonly number[];
  readonly before: RawChainPositions;
  readonly maxSelectorDepth: number;
  readonly insetPx: number;
}): RawFocused | null {
  const element = R.elementAtPath(path);
  if (element === null) {
    return null;
  }
  const scrollLeftOf = R.standardGetter<number>(Element.prototype, 'scrollLeft');
  const scrollTopOf = R.standardGetter<number>(Element.prototype, 'scrollTop');
  const parentOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  const scrollAncestors = R.scrollAncestorsOf(element);
  const ancestors: RawScroll['ancestors'][number][] = [];
  let index = 0;
  for (let node = parentOf(element); node !== null && index < before.chain.length; node = parentOf(node), index += 1) {
    const was = before.chain[index] ?? { scrollLeft: scrollLeftOf(node), scrollTop: scrollTopOf(node) };
    const now = { scrollLeft: scrollLeftOf(node), scrollTop: scrollTopOf(node) };
    if (scrollAncestors.includes(node) || was.scrollLeft !== now.scrollLeft || was.scrollTop !== now.scrollTop) {
      ancestors.push({ selector: R.selectorOf(node, maxSelectorDepth), before: was, after: now });
    }
  }
  const scroll: RawScroll = { document: { before: before.document, after: { scrollX: window.scrollX, scrollY: window.scrollY } }, ancestors };
  const focused = R.documentProperty<Element | null>('activeElement') === element;
  const box = Element.prototype.getBoundingClientRect.call(element);
  const afterRect = { x: box.x, y: box.y, top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
  const parentElementOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  let opacity = 1;
  for (let current: Element | null = element; current !== null; current = parentElementOf(current)) {
    const value = Number.parseFloat(window.getComputedStyle(current).opacity);
    if (Number.isFinite(value)) {
      opacity *= value;
    }
  }
  const visibleAfterFocus = Element.prototype.checkVisibility.call(element, { visibilityProperty: true, opacityProperty: true })
    && opacity > 0 && box.width > 0 && box.height > 0;
  // EV-2: 点の作り方は部品（`R.hitPointsOf`）の 1 か所。
  const points = R.hitPointsOf(box, window.innerWidth, window.innerHeight, insetPx);
  let hitPointCount = 0;
  for (const [x, y] of points) {
    const [first] = Document.prototype.elementsFromPoint.call(document, x, y);
    if (first !== undefined && (first === element || Node.prototype.contains.call(element, first))) {
      hitPointCount += 1;
    }
  }
  return { focused, afterRect, visibleAfterFocus, hitAfterFocus: hitPointCount > 0, hitTestPointCount: points.length, hitPointCount, scroll };
}
const readFocusedInPage = composeInPage(readFocusedReader);

/**
 * ページの中で、元のフォーカスに戻し（元がなければ、今のフォーカスを外す）、EV-1: 文書と祖先を、フォーカスの前の位置へ戻す。REV-SD2 の M-3: 祖先は、確かめた
 * 要素の位置から同じ順で引き直し、前と位置が違う祖先を全部戻す（`overflow: hidden` の祖先を含む。smooth の指定によらず、すぐに動かす）。
 */
function restoreFocusReader(R: StandardReaders, { path, focusedPath, before }: {
  readonly path: readonly number[] | null;
  readonly focusedPath: readonly number[];
  readonly before: RawChainPositions | null;
}): void {
  const previous = path === null ? null : R.elementAtPath(path);
  if (previous !== null) {
    HTMLElement.prototype.focus.call(previous, { preventScroll: true });
  } else {
    const active = R.documentProperty<Element | null>('activeElement');
    if (active instanceof HTMLElement) {
      HTMLElement.prototype.blur.call(active);
    }
  }
  if (before === null) {
    return;
  }
  const focused = R.elementAtPath(focusedPath);
  const parentOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  let index = 0;
  for (let node = focused === null ? null : parentOf(focused); node !== null && index < before.chain.length; node = parentOf(node), index += 1) {
    const was = before.chain[index];
    if (was !== undefined && (R.standardGetter<number>(Element.prototype, 'scrollLeft')(node) !== was.scrollLeft
      || R.standardGetter<number>(Element.prototype, 'scrollTop')(node) !== was.scrollTop)) {
      (Element.prototype.scrollTo as (options: ScrollToOptions) => void).call(node, { left: was.scrollLeft, top: was.scrollTop, behavior: 'instant' });
    }
  }
  window.scrollTo({ left: before.document.scrollX, top: before.document.scrollY, behavior: 'instant' });
}
const restoreFocusInPage = composeInPage(restoreFocusReader);

/** 2 つの位置の読みが同じか。 */
const samePositions = (first: RawChainPositions | null, second: RawChainPositions | null): boolean => JSON.stringify(first) === JSON.stringify(second);

/** `collectFocusChecks` の指定。 */
export interface FocusCheckOptions {
  /** 幅の走査の幅なら、その幅（Evidence に残す）。主の読み込みは `null`。 */
  readonly stressWidth: number | null;
  /**
   * フォーカスを当てたままの間に呼ぶ口（呼ぶ側が、隠れたままの要素で画像を撮る。撮った画像の Evidence の ID か `null` を返す）。`index` は、この確かめの中の
   * 1 から始まる番号。口の失敗は `null` として扱う。
   */
  readonly onFocused?: (item: FocusCheckItemEvidence, viewport: { readonly width: number; readonly height: number }, index: number) => Promise<EvidenceId | null>;
  /** 進みの見張りの口（ページの読み取りが返るたびに印を付ける）。 */
  readonly track?: <T>(work: Promise<T>) => Promise<T>;
  /**
   * REV-SD2 の M-2: 位置が落ち着いたかを読む間隔（ms。フォーカスの後と、戻した後に、続けて 2 回同じ位置になるまで読む）。Page Auditor は観察の窓の一式の
   * スクロールの待ち（`scroll.stepWaitMs`）を渡す。省略すると本番の値。
   */
  readonly settleIntervalMs?: number | undefined;
}

/** 画面の外に置いた、フォーカスできる要素のフォーカスの確かめ（例外は投げない。途中で読めなくなったら、それまでの要素で `PARTIAL`）。 */
export async function collectFocusChecks(page: Page, options: FocusCheckOptions): Promise<FocusCheckEvidence> {
  const track = options.track ?? (<T>(work: Promise<T>): Promise<T> => work);
  const items: FocusCheckItemEvidence[] = [];
  let scrollPosition = { scrollX: 0, scrollY: 0 };
  let viewport = { width: 0, height: 0 };
  let status: FocusCheckEvidence['status'] = 'COMPLETE';
  try {
    scrollPosition = { ...(await track(scrollDocumentToOrigin(page))) };
    const listed = await track(page.evaluate(listFocusCandidatesInPage, {
      focusableSelector: FOCUSABLE_SELECTOR,
      hiddenMaxDimensionPx: HIDDEN_MAX_DIMENSION_PX,
      maxSelectorDepth: MAX_SELECTOR_DEPTH,
    }));
    viewport = { width: listed.viewportWidth, height: listed.viewportHeight };
    const settleIntervalMs = options.settleIntervalMs ?? observationWindowsOrProduction(undefined).scroll.stepWaitMs;
    for (const [position, candidate] of listed.candidates.entries()) {
      const readPositions = (): Promise<RawChainPositions | null> => track(page.evaluate(chainPositionsInPage, { path: candidate.path }));
      // REV-SD2 の M-2: smooth の指定でも、位置が落ち着く（続けて 2 回同じ）まで読んでから判定する。
      const settled = async (): Promise<RawChainPositions | null> => {
        let last = await readPositions();
        for (;;) {
          await track(wait(settleIntervalMs));
          const next = await readPositions();
          if (samePositions(last, next)) {
            return next;
          }
          last = next;
        }
      };
      let before: RawChainPositions | null = null;
      try {
        before = await readPositions();
        await track(page.evaluate(focusInPage, { path: candidate.path }));
        await settled();
        const focused = before === null ? null : await track(page.evaluate(readFocusedInPage, {
          path: candidate.path,
          before,
          maxSelectorDepth: MAX_SELECTOR_DEPTH,
          insetPx: HIT_TEST_POINT_INSET_PX,
        }));
        const item: FocusCheckItemEvidence = {
          selector: candidate.selector,
          tagName: candidate.tagName,
          beforeRect: candidate.beforeRect,
          focused: focused?.focused ?? false,
          afterRect: focused?.afterRect ?? null,
          visibleAfterFocus: focused?.visibleAfterFocus ?? false,
          hitAfterFocus: focused?.hitAfterFocus ?? false,
          screenshotEvidenceId: null,
          operation: 'DIRECT_FOCUS',
          ...(focused === null ? {} : { hitTestPointCount: focused.hitTestPointCount, hitPointCount: focused.hitPointCount, scroll: focused.scroll }),
        };
        const screenshotEvidenceId = options.onFocused === undefined
          ? null
          : await options.onFocused(item, viewport, position + 1).catch(() => null);
        items.push(Object.freeze({ ...item, screenshotEvidenceId }));
      } finally {
        // REV-SD2 の M-2: 戻した後も、位置が落ち着いてから前の位置と同じかを確かめ、違えば、もう一度戻す。
        const restore = (): Promise<void> => track(page.evaluate(restoreFocusInPage, { path: listed.active, focusedPath: candidate.path, before }));
        await restore().catch(() => undefined);
        if (before !== null && !samePositions(before, await settled().catch(() => before))) {
          await restore().catch(() => undefined);
        }
      }
    }
  } catch {
    status = 'PARTIAL';
  }
  return Object.freeze({
    status,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scrollPosition: Object.freeze(scrollPosition),
    items: Object.freeze(items),
    ...(options.stressWidth === null ? {} : { stressWidth: options.stressWidth }),
  });
}
