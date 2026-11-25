/**
 * AUD-4d（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4d）: 画面の外に置いた、フォーカスできる要素（スキップリンクなど）に、
 * フォーカスを当てて、矩形・見えるか・押せるか（hit-test）を読む Collector。判定（現れるか・隠れたままか）はしない（Rule の側の `focusCheckOutcomeOf`）。
 * - 呼ぶ側は、ほかの証拠を集め終えた後に呼ぶ（フォーカスでページの JS が状態を変えても、後の証拠を汚さないため。設計者の判断 2026-11-10）。
 * - 対象: 文書の中の、フォーカスできる要素（`a[href]`・`button`・`input`（hidden を除く）・`select`・`textarea`・`[tabindex]`）で、無効でなく、`tabindex` が負でなく、
 *   描かれる箱があり（`getClientRects` が 1 つ以上）、フォーカスの前に画面の外にあるもの（全体がビューポートの左か右の外・文書の上の外、または幅か高さが 1px 以下）。
 *   数の上限は置かない。
 * - AUD-3（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 1）: 項目の種別（`GUARD`・`CONTROL`・`UNKNOWN`）と根拠を、対象を探す読み取りの
 *   中（1 か所）で決めて記録する。
 * - AUD-3（6.2 の 4）: 通常の Tab の確かめ（`checkSequentialTab`）も、ここに置く。呼ぶ側が、ほかの証拠を集め終えた後に、直の focus で隠れたままの項目がある
 *   画面だけで呼ぶ。
 * - 1 つずつ、フォーカスを当て（EV-1: `preventScroll` をやめ、ブラウザのフォーカスのスクロールに任せる。横のスクロールの中の要素が画面に出る）、前と後の位置（文書と
 *   スクロールの祖先）・矩形・見えるか・押せるか（複数の点の hit-test）を読み、呼ぶ側の口（`onFocused`。フォーカスを当てたままの画像を撮る）を呼び、元のフォーカスと
 *   前の位置に戻す（元がなければ blur）。読み込みと BeakSight の要求は足さない。フォーカスでページが出す送信は、Guard の決まりのまま扱う。
 * - 読み始める前に、文書の先頭へ戻す（主の画像と同じ位置で読む）。
 * - REV-SD2 の M-2・M-3: フォーカスの後と戻した後は、位置が落ち着く（続けて 2 回同じ）まで読んでから判定・確かめをする（smooth のスクロール）。祖先は、スクロールの
 *   祖先に限らず、位置が変わったものを全部記録して戻す（`overflow: hidden` の祖先を含む）。
 */
import type { Page } from 'playwright';
import { scrollDocumentToOrigin } from '../browser/controlled-scroll.js';
import { composeInPage, FRONT_WINDOW_MIN_VIEWPORT_RATIO, type StandardReaders } from '../browser/in-page-readers.js';
import type { EvidenceId } from '../core/contracts.js';
import type {
  FocusCheckEvidence,
  FocusCheckItemEvidence,
  FocusCheckItemKind,
  FocusCheckItemKindBasis,
  FocusCheckSequentialTabEvidence,
  FocusSequentialTabOutcome,
  RectangleEvidence,
  ScrollPosition,
} from '../core/evidence-types.js';
// AUD-3: Tab だけを押す（Enter・Space・Shift+Tab は押さない）。キーを押す部品は `reveal-and-capture.ts` の 1 か所。
import { EDITABLE_SELECTOR, pressSequentialTabKey, type ScrollKeyPressGuard } from './reveal-and-capture.js';
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

/** AUD-3: 押せる要素の型（項目の種別 `CONTROL` の根拠。行き先は読まない）。 */
const CONTROL_TYPE_SELECTOR = ':any-link, button, input, select, textarea';

/** AUD-3: 小窓（項目の種別の「小窓の始めか終わり」の入れ物。REV-AUD3 の M-1: 小窓の外の要素は、端と決めない）。 */
const DIALOG_SELECTOR = 'dialog, [role="dialog" i], [role="alertdialog" i], [aria-modal="true" i]';

interface ListArgument {
  readonly focusableSelector: string;
  readonly hiddenMaxDimensionPx: number;
  readonly maxSelectorDepth: number;
  readonly controlTypeSelector: string;
  readonly dialogSelector: string;
}

interface RawCandidate {
  readonly path: readonly number[];
  readonly selector: string;
  readonly tagName: string;
  readonly beforeRect: RectangleEvidence;
  readonly kind: FocusCheckItemKind;
  readonly kindBasis: FocusCheckItemKindBasis;
}

interface RawList {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly active: readonly number[] | null;
  readonly candidates: readonly RawCandidate[];
}

/**
 * ページの中で、対象の要素と、今フォーカスのある要素の位置を読む（読むだけ）。AUD-3: 項目の種別と根拠も、ここ（1 か所）で決める。
 */
function listFocusCandidatesReader(R: StandardReaders, {
  focusableSelector, hiddenMaxDimensionPx, maxSelectorDepth, controlTypeSelector, dialogSelector,
}: ListArgument): RawList {
  const tagNameOf = R.standardGetter<string>(Element.prototype, 'tagName');
  const parentOf = R.standardGetter<Element | null>(Node.prototype, 'parentElement');
  const textOf = R.standardGetter<string | null>(Node.prototype, 'textContent');
  const rectOf = (element: Element): RectangleEvidence => {
    const box = Element.prototype.getBoundingClientRect.call(element);
    return { x: box.x, y: box.y, top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
  };
  // LZ-2: セレクタの長さの上限（前は `MAX_SELECTOR_LENGTH`）は置かない。切り詰めない。EV-1: 書き方は部品（`R.selectorOf`）の 1 か所。
  const selectorOf = (element: Element): string => R.selectorOf(element, maxSelectorDepth);
  // フォーカスできる要素か（無効でなく、tabindex が負でなく、描かれる箱がある）。
  const focusable = (element: Element): boolean => {
    const tabIndex = Element.prototype.getAttribute.call(element, 'tabindex');
    return !Element.prototype.matches.call(element, ':disabled') && !(tabIndex !== null && Number.parseInt(tabIndex, 10) < 0)
      && Element.prototype.getClientRects.call(element).length > 0;
  };
  const attributeOf = (element: Element, name: string): string => (Element.prototype.getAttribute.call(element, name) ?? '').trim();
  // 名前があるか（aria-label・aria-labelledby の先の文字・title・中の文字・中の画像の alt のどれか）。
  const namedOf = (element: Element): boolean => {
    if (attributeOf(element, 'aria-label') !== '' || attributeOf(element, 'title') !== '' || (textOf(element) ?? '').trim() !== '') {
      return true;
    }
    const labelledBy = attributeOf(element, 'aria-labelledby').split(/\s+/u).filter((id) => id !== '');
    if (labelledBy.some((id) => (textOf(Document.prototype.getElementById.call(document, id)) ?? '').trim() !== '')) {
      return true;
    }
    return Array.from(Element.prototype.querySelectorAll.call(element, 'img[alt]')).some((image) => attributeOf(image, 'alt') !== '');
  };
  // 小窓の中の、フォーカスできる要素の始めか終わりか（REV-AUD3 の M-1: 小窓の外は、端と決めない）。
  const trapEdgeOf = (element: Element): boolean => {
    const parent = parentOf(element);
    const container = parent === null ? null : Element.prototype.closest.call(parent, dialogSelector);
    if (container === null) {
      return false;
    }
    const inside = Array.from(Element.prototype.querySelectorAll.call(container, focusableSelector)).filter(focusable);
    return inside[0] === element || inside[inside.length - 1] === element;
  };
  // AUDR2: 開いた小窓（モーダルの判定の 1 か所 `R.openModalDialogs`）と、見えている小窓の形の要素（aria-modal・role=dialog など）。
  const modals = R.openModalDialogs().map(({ dialog }) => dialog);
  const visibleDialog = (candidate: Element): boolean => Element.prototype.matches.call(candidate, dialogSelector)
    && Element.prototype.checkVisibility.call(candidate, { visibilityProperty: true });
  const hasDialog = (sibling: Element): boolean => modals.some((modal) => sibling === modal || Node.prototype.contains.call(sibling, modal))
    || visibleDialog(sibling) || Array.from(Element.prototype.querySelectorAll.call(sibling, dialogSelector)).some(visibleDialog);
  // AUDR2: 小窓の外の、小窓（か、それを含む入れ物）の直前か直後の兄弟か（モーダルの部品が、小窓の外の兄弟に置く守りの部品の形）。
  const dialogSiblingEdgeOf = (element: Element): boolean => [
    R.standardGetter<Element | null>(Element.prototype, 'previousElementSibling')(element),
    R.standardGetter<Element | null>(Element.prototype, 'nextElementSibling')(element),
  ].some((sibling) => sibling !== null && hasDialog(sibling));
  const width = window.innerWidth;
  const height = window.innerHeight;
  const candidates: RawCandidate[] = [];
  for (const node of R.queryAllInRoots([document], focusableSelector)) {
    if (!(node instanceof HTMLElement || node instanceof SVGElement)) {
      continue;
    }
    const element = node as Element;
    if (!focusable(element)) {
      continue;
    }
    const box = rectOf(element);
    const outside = box.right <= 0 || box.left >= width || box.bottom + window.scrollY <= 0;
    const tiny = box.width <= hiddenMaxDimensionPx || box.height <= hiddenMaxDimensionPx;
    const path = R.elementPathOf(element);
    if (!(outside || tiny) || path === null) {
      continue;
    }
    const kindBasis: FocusCheckItemKindBasis = {
      tiny,
      named: namedOf(element),
      hasRole: attributeOf(element, 'role') !== '',
      controlType: Element.prototype.matches.call(element, controlTypeSelector),
      trapEdge: trapEdgeOf(element),
      dialogSiblingEdge: dialogSiblingEdgeOf(element),
    };
    const kind: FocusCheckItemKind = kindBasis.controlType || kindBasis.hasRole
      ? 'CONTROL'
      : kindBasis.tiny && !kindBasis.named && (kindBasis.trapEdge || kindBasis.dialogSiblingEdge === true) ? 'GUARD' : 'UNKNOWN';
    candidates.push({ path, selector: selectorOf(element), tagName: tagNameOf(element).toLowerCase(), beforeRect: box, kind, kindBasis });
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
  /** RVP-1: 押せる点が 0 で、どの点も最前面が前面の窓の中の要素で、要素はその窓の外。 */
  readonly frontWindowCovered: boolean;
  /** RVP-1: 前面の窓が開いていて、要素はどの窓の外にもある。 */
  readonly behindFrontWindow: boolean;
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
function readFocusedReader(R: StandardReaders, { path, before, maxSelectorDepth, insetPx, frontWindowRatio }: {
  readonly path: readonly number[];
  readonly before: RawChainPositions;
  readonly maxSelectorDepth: number;
  readonly insetPx: number;
  readonly frontWindowRatio: number;
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
  const tops: Element[] = [];
  for (const [x, y] of points) {
    const [first] = Document.prototype.elementsFromPoint.call(document, x, y);
    if (first !== undefined && (first === element || Node.prototype.contains.call(element, first))) {
      hitPointCount += 1;
    } else if (first !== undefined) {
      tops.push(first);
    }
  }
  // RVP-1: 前面の窓（判定の 1 か所 `R.frontWindows`）。要素を含む窓は、要素の窓（背後でない）。
  const windows = R.frontWindows(frontWindowRatio);
  const outsideOf = (front: Element): boolean => front !== element && !Node.prototype.contains.call(front, element);
  const behindFrontWindow = windows.length > 0 && windows.every(outsideOf);
  const frontWindowCovered = hitPointCount === 0 && tops.length === points.length && tops.length > 0
    && tops.every((top) => windows.some((front) => outsideOf(front) && (top === front || Node.prototype.contains.call(front, top))));
  return {
    focused, afterRect, visibleAfterFocus, hitAfterFocus: hitPointCount > 0, hitTestPointCount: points.length, hitPointCount, scroll,
    frontWindowCovered, behindFrontWindow,
  };
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

/** 確かめの期限が来たか（呼ぶたびに読み直す）。 */
const aborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

/** `intervalMs` だけ待つ（`signal` が abort したら、その時点で終える）。 */
const waitUnlessAborted = (intervalMs: number, signal: AbortSignal | undefined): Promise<void> => (signal === undefined
  ? wait(intervalMs)
  : new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      signal.removeEventListener('abort', done);
      resolve();
    };
    signal.addEventListener('abort', done, { once: true });
    void wait(intervalMs).then(done);
  }));

/** 落ち着きの待ちの結果（`settled` が偽なら、期限までに落ち着かず、`value` は最後に読んだ値）。 */
export interface SettledReading<T> {
  readonly value: T;
  readonly settled: boolean;
}

/**
 * REV-SD2 の M-2: 位置の読みが落ち着く（続けて 2 回同じ）まで、`intervalMs` ごとに読む（直の focus と、通常の Tab の確かめが共有する）。
 * - REV-AUD3 の M-4: 今の確かめの期限（`signal`）が来たら、読むのをやめて、最後に読んだ値を「落ち着かなかった」として返す（新しい秒の値は足さない）。
 * - REV-AUD3 の 2 回目の I-A: 同じ読み取りを繰り返すので、読み取りでは進みの見張りに印を付けない（`src/core/progress-watch.ts` の冒頭の決まり。動き続ける
 *   値で段が生き続けないようにする）。呼ぶ側は、`read` を見張りの口（`track`）で包まない。段は、見張りの反応なしの長さで終わる。
 * - FRET: 窓を開くボタンの確かめ（`src/interaction/dialog-focus-check.ts`）も、押した後と閉じた後の落ち着きの待ちに使う（新しい秒の値は足さない）。
 */
export async function settledReading<T>(read: () => Promise<T>, intervalMs: number, signal: AbortSignal | undefined): Promise<SettledReading<T>> {
  let last = await read();
  for (;;) {
    if (aborted(signal)) {
      return { value: last, settled: false };
    }
    await waitUnlessAborted(intervalMs, signal);
    if (aborted(signal)) {
      return { value: last, settled: false };
    }
    const next = await read();
    if (JSON.stringify(last) === JSON.stringify(next)) {
      return { value: next, settled: true };
    }
    last = next;
  }
}

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
  /** REV-AUD3 の M-4: 今の確かめの期限（見張りが段を終えたら abort）。abort したら、位置の落ち着きを待つのをやめる。省略すると期限なし。 */
  readonly signal?: AbortSignal | undefined;
}

/** 画面の外に置いた、フォーカスできる要素のフォーカスの確かめ（例外は投げない。途中で読めなくなったら、それまでの要素で `PARTIAL`）。 */
export async function collectFocusChecks(page: Page, options: FocusCheckOptions): Promise<FocusCheckEvidence> {
  const track = options.track ?? (<T>(work: Promise<T>): Promise<T> => work);
  const items: FocusCheckItemEvidence[] = [];
  let scrollPosition = { scrollX: 0, scrollY: 0 };
  let viewport = { width: 0, height: 0 };
  let status: FocusCheckEvidence['status'] = 'COMPLETE';
  let listedPaths: readonly (readonly number[])[] = [];
  try {
    scrollPosition = { ...(await track(scrollDocumentToOrigin(page))) };
    const listed = await track(page.evaluate(listFocusCandidatesInPage, {
      focusableSelector: FOCUSABLE_SELECTOR,
      hiddenMaxDimensionPx: HIDDEN_MAX_DIMENSION_PX,
      maxSelectorDepth: MAX_SELECTOR_DEPTH,
      controlTypeSelector: CONTROL_TYPE_SELECTOR,
      dialogSelector: DIALOG_SELECTOR,
    }));
    viewport = { width: listed.viewportWidth, height: listed.viewportHeight };
    listedPaths = listed.candidates.map(({ path }) => path);
    const settleIntervalMs = options.settleIntervalMs ?? observationWindowsOrProduction(undefined).scroll.stepWaitMs;
    const { signal } = options;
    for (const [position, candidate] of listed.candidates.entries()) {
      if (aborted(signal)) {
        // REV-AUD3 の 2 回目の I-A: 確かめの期限が来たら、残りの要素は確かめない（それまでの記録で `PARTIAL`）。
        status = 'PARTIAL';
        break;
      }
      // 2 回目の I-A: 落ち着きの待ちの読み取りは、見張りの口で包まない（印を付けない）。
      const readPositions = (): Promise<RawChainPositions | null> => page.evaluate(chainPositionsInPage, { path: candidate.path });
      let before: RawChainPositions | null = null;
      let unsettled = false;
      try {
        before = await track(page.evaluate(chainPositionsInPage, { path: candidate.path }));
        await track(page.evaluate(focusInPage, { path: candidate.path }));
        // REV-SD2 の M-2: smooth の指定でも、位置が落ち着く（続けて 2 回同じ）まで読んでから判定する。2 回目の I-A: 期限までに落ち着かなければ、最後に読んだ
        // 事実を、落ち着かなかった印つきで残す。
        const readFocused = (from: RawChainPositions): Promise<RawFocused | null> => page.evaluate(readFocusedInPage, {
          path: candidate.path,
          before: from,
          maxSelectorDepth: MAX_SELECTOR_DEPTH,
          insetPx: HIT_TEST_POINT_INSET_PX,
          frontWindowRatio: FRONT_WINDOW_MIN_VIEWPORT_RATIO,
        });
        const reading = before === null ? null : await settledReading(() => readFocused(before as RawChainPositions), settleIntervalMs, signal);
        unsettled = reading?.settled === false;
        const focused = reading?.value ?? null;
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
          kind: candidate.kind,
          kindBasis: Object.freeze({ ...candidate.kindBasis }),
          ...(unsettled ? { unsettled: true as const } : {}),
          ...(focused?.frontWindowCovered === true ? { frontWindowCovered: true as const } : {}),
        };
        // 期限が来た後は、画像を撮らずに、すぐに返す（見張りが、同じ回りのうちに途中の記録を受け取る）。
        const screenshotEvidenceId = options.onFocused === undefined || aborted(signal)
          ? null
          : await options.onFocused(item, viewport, position + 1).catch(() => null);
        items.push(Object.freeze({ ...item, screenshotEvidenceId }));
      } finally {
        // REV-SD2 の M-2: 戻した後も、位置が落ち着いてから前の位置と同じかを確かめ、違えば、もう一度戻す。期限が来た後は、戻すのを待たない。
        const restore = (): Promise<void> => track(page.evaluate(restoreFocusInPage, { path: listed.active, focusedPath: candidate.path, before }));
        if (aborted(signal)) {
          void restore().catch(() => undefined);
        } else {
          await restore().catch(() => undefined);
          const after = before === null ? null : await settledReading(readPositions, settleIntervalMs, signal).catch(() => null);
          if (before !== null && after !== null && !samePositions(before, after.value)) {
            await restore().catch(() => undefined);
          }
        }
      }
    }
    if (aborted(signal)) {
      status = 'PARTIAL';
    }
  } catch {
    status = 'PARTIAL';
  }
  const evidence: FocusCheckEvidence = Object.freeze({
    status,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scrollPosition: Object.freeze(scrollPosition),
    items: Object.freeze(items),
    ...(options.stressWidth === null ? {} : { stressWidth: options.stressWidth }),
  });
  // AUD-3: 通常の Tab の確かめが、項目の要素を引き直すための位置（記録には出さない）。
  itemPathsOf.set(evidence, Object.freeze(listedPaths.slice(0, items.length)));
  return evidence;
}

// ---------------------------------------------------------------------------------------------------------------
// AUD-3（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 6.2 の 4 と「AUD-3 の Blocker の判断」）: 通常の Tab の確かめ
// ---------------------------------------------------------------------------------------------------------------

/** フォーカスの確かめの記録ごとの、項目の要素の位置（`items` の順。記録には出さない）。 */
const itemPathsOf = new WeakMap<FocusCheckEvidence, readonly (readonly number[])[]>();

/** 確かめの間だけページに置く物の名前（window の、列挙されないプロパティ。確かめた後に消す）。 */
const SEQUENTIAL_TAB_STATE_KEY = '__beaksightSequentialTab';

/** ページの中に置く、確かめの間の状態。 */
interface InPageTabState {
  readonly candidates: readonly (Element | null)[];
  seen: WeakSet<Element>;
  /** REV-AUD3 の I-4: 確かめ始めたときにあった要素（文書と open な影の木の中）。この外の要素にフォーカスが来たら、確かめられなかったとして終える。 */
  readonly present: WeakSet<Element>;
  readonly offsets: Map<Element, RawOffset>;
  readonly document: ScrollPosition;
  /**
   * AUDR2: 前の読みの後にフォーカスが来た要素が、守りの部品の形（`[tabindex]`・押せる要素の型でない・role なし・名前なし・幅か高さが 1px 以下）で、そこから
   * キーを押さずにほかの要素へ移ったか（守りの部品がフォーカスを移した）。
   */
  guardMoved: boolean;
  lastFocusInWasGuard: boolean;
  readonly onFocusIn: (event: FocusEvent) => void;
}

/**
 * 準備の結果（元のフォーカスの位置と、そこが値を入れる所だったか＝外したか。判定は `R.isValueEntryFocus`）。
 */
interface RawTabPrepared {
  readonly activePath: readonly number[] | null;
  readonly editable: boolean;
}

/**
 * ページの中で、候補の要素を引き直し、確かめの前の位置（文書と、中身がはみ出してスクロールしうる要素の全部）と、今ある要素を控えて、状態をページに置く（読む
 * だけ。DOM は書き換えない）。今フォーカスのある要素の位置（body・なしは `null`）と、そこが値を入れる所か（REV-AUD3 の I-3）を返す。値を入れる所なら、
 * フォーカスを外す（2 回目の M-B。外した後の Tab は、欄に字を入れずに次の要素へ進む）。
 */
function prepareTabReader(R: StandardReaders, { paths, stateKey, editableSelector, controlTypeSelector, hiddenMaxDimensionPx }: {
  readonly paths: readonly (readonly number[])[];
  readonly stateKey: string;
  readonly editableSelector: string;
  readonly controlTypeSelector: string;
  readonly hiddenMaxDimensionPx: number;
}): RawTabPrepared {
  const attributeOf = (element: Element, name: string): string => (Element.prototype.getAttribute.call(element, name) ?? '').trim();
  // AUDR2: 守りの部品の形か（項目の種別の根拠と同じ形。名前は aria-label・title・中の文字）。
  const guardShaped = (element: Element): boolean => {
    const box = Element.prototype.getBoundingClientRect.call(element);
    return Element.prototype.hasAttribute.call(element, 'tabindex') && !Element.prototype.matches.call(element, controlTypeSelector)
      && attributeOf(element, 'role') === '' && attributeOf(element, 'aria-label') === '' && attributeOf(element, 'title') === ''
      && (R.standardGetter<string | null>(Node.prototype, 'textContent')(element) ?? '').trim() === ''
      && (box.width <= hiddenMaxDimensionPx || box.height <= hiddenMaxDimensionPx);
  };
  const number = (element: Element, name: string): number => R.standardGetter<number>(Element.prototype, name)(element);
  const root = R.documentProperty<Element | null>('documentElement');
  const scrollingElement = R.documentProperty<Element | null>('scrollingElement');
  const offsets = new Map<Element, RawOffset>();
  const present = new WeakSet<Element>();
  for (const node of R.queryAllInRoots(R.openRoots(), '*')) {
    if (node instanceof Element) {
      present.add(node);
    }
  }
  for (const element of Array.from(Document.prototype.querySelectorAll.call(document, '*'))) {
    if (element === root || element === scrollingElement) {
      continue;
    }
    const offset = { scrollLeft: number(element, 'scrollLeft'), scrollTop: number(element, 'scrollTop') };
    if (number(element, 'scrollWidth') > number(element, 'clientWidth') || number(element, 'scrollHeight') > number(element, 'clientHeight')
      || offset.scrollLeft !== 0 || offset.scrollTop !== 0) {
      offsets.set(element, offset);
    }
  }
  const state: InPageTabState = {
    candidates: paths.map((path) => R.elementAtPath(path)),
    seen: new WeakSet<Element>(),
    present,
    offsets,
    document: { scrollX: window.scrollX, scrollY: window.scrollY },
    guardMoved: false,
    lastFocusInWasGuard: false,
    onFocusIn: (event: FocusEvent): void => {
      const target = event.target;
      if (state.lastFocusInWasGuard && target !== null) {
        state.guardMoved = true;
      }
      state.lastFocusInWasGuard = target instanceof Element && guardShaped(target);
    },
  };
  Object.defineProperty(window, stateKey, { value: state, configurable: true, enumerable: false });
  // AUDR2: 読むだけの見張り（DOM は書き換えない）。ページの部品の focus の処理より先に読むため、捕捉の段の focus で見る。確かめを終えて状態を消すときに外す。
  document.addEventListener('focus', state.onFocusIn, true);
  const active = R.documentProperty<Element | null>('activeElement');
  const body = R.documentProperty<HTMLElement | null>('body');
  let deep: Element | null = active;
  for (let inner = deep?.shadowRoot?.activeElement ?? null; inner !== null; inner = inner.shadowRoot?.activeElement ?? null) {
    deep = inner;
  }
  // REV-AUD3 の 2 回目の M-B: 値を入れる所にフォーカスがあれば、外してから押す（両方の Chromium で、外した後の Tab は欄に字を入れず次の要素へ進むと測った）。
  const editable = deep !== null && R.isValueEntryFocus(deep, editableSelector);
  if (editable && active instanceof HTMLElement) {
    HTMLElement.prototype.blur.call(active);
  }
  return { activePath: active === null || active === body ? null : R.elementPathOf(active), editable };
}
const prepareTabInPage = composeInPage(prepareTabReader);

/**
 * Tab を 1 回押した後のフォーカス（`OUTSIDE` は文書の外・body、`SEEN` は前に見た要素に戻った、`NEW` は初めての要素。候補なら、その番号）。REV-AUD3: `STOP` は、
 * それ以上押すと確かめにならない・値を変えうる所（枠の中へ入った・値を入れる要素に来た・確かめ始めたときになかった要素に来た）。
 */
interface RawTabStep {
  readonly state: 'OUTSIDE' | 'SEEN' | 'NEW' | 'STOP';
  readonly candidate: number | null;
  /** AUDR2: 止めた理由（`STOP` のときだけ）。 */
  readonly stop?: Extract<FocusSequentialTabOutcome, 'FRAME' | 'VALUE_ENTRY' | 'NEW_ELEMENT' | 'NO_START'>;
}

/** ページの中で、今のフォーカスを読む（影の木の中まで深くたどって、前に見たかを決める）。`reset` なら、見た要素を忘れる（外から記録をやり直す）。 */
function tabStepReader(R: StandardReaders, { stateKey, reset, editableSelector }: {
  readonly stateKey: string;
  readonly reset: boolean;
  readonly editableSelector: string;
}): RawTabStep {
  const state = (window as unknown as Record<string, InPageTabState | undefined>)[stateKey];
  const active = R.documentProperty<Element | null>('activeElement');
  if (state === undefined) {
    throw new Error('the state of the sequential Tab check is gone');
  }
  if (reset) {
    state.seen = new WeakSet<Element>();
  }
  // AUDR2: 1 回の押下の間に、守りの部品がフォーカスをほかの要素へ移したら、文書の先頭からの並びにならないので、始めを作れないとして止める。
  const guardMoved = state.guardMoved;
  state.guardMoved = false;
  state.lastFocusInWasGuard = false;
  if (guardMoved) {
    return { state: 'STOP', candidate: null, stop: 'NO_START' };
  }
  if (active === null || active === R.documentProperty<HTMLElement | null>('body') || active === R.documentProperty<Element | null>('documentElement')) {
    return { state: 'OUTSIDE', candidate: null };
  }
  let deep: Element = active;
  for (let inner = deep.shadowRoot?.activeElement ?? null; inner !== null; inner = inner.shadowRoot?.activeElement ?? null) {
    deep = inner;
  }
  // REV-AUD3 の I-1・I-3・I-4: 枠の中（Tab で中を進んでも `activeElement` が変わらない）・値を入れる要素・確かめ始めたときになかった要素では止める。
  // 値を入れる所の判定は部品の 1 か所（`R.isValueEntryFocus`。EV-4 と共有。closed な影の木の host を含む）。
  if (Element.prototype.matches.call(deep, 'iframe, frame, object, embed')) {
    return { state: 'STOP', candidate: null, stop: 'FRAME' };
  }
  if (R.isValueEntryFocus(deep, editableSelector)) {
    return { state: 'STOP', candidate: null, stop: 'VALUE_ENTRY' };
  }
  if (!state.present.has(deep)) {
    return { state: 'STOP', candidate: null, stop: 'NEW_ELEMENT' };
  }
  if (state.seen.has(deep)) {
    return { state: 'SEEN', candidate: null };
  }
  state.seen.add(deep);
  const index = deep === active ? state.candidates.indexOf(active) : -1;
  return { state: 'NEW', candidate: index < 0 ? null : index };
}
const tabStepInPage = composeInPage(tabStepReader);

/** ページの中で、押せなかった要素の hit-test の点の最前面にあった、ほかの要素の selector を読む（なければ `null`）。 */
function coverReader(R: StandardReaders, { path, insetPx, maxSelectorDepth }: {
  readonly path: readonly number[];
  readonly insetPx: number;
  readonly maxSelectorDepth: number;
}): string | null {
  const element = R.elementAtPath(path);
  if (element === null) {
    return null;
  }
  const box = Element.prototype.getBoundingClientRect.call(element);
  for (const [x, y] of R.hitPointsOf(box, window.innerWidth, window.innerHeight, insetPx)) {
    const [first] = Document.prototype.elementsFromPoint.call(document, x, y);
    if (first !== undefined && first !== element && !Node.prototype.contains.call(element, first)) {
      return R.selectorOf(first, maxSelectorDepth);
    }
  }
  return null;
}
const coverInPage = composeInPage(coverReader);

/** ページの中で、文書の位置を読む。 */
function documentPositionReader(): ScrollPosition {
  return { scrollX: window.scrollX, scrollY: window.scrollY };
}
const documentPositionInPage = composeInPage(documentPositionReader);

/**
 * ページの中で、元のフォーカスへ戻し（元がなければ、今のフォーカスを外す）、控えた位置へ戻す（すぐに動かす）。`release` なら、置いた状態を消す。控えた文書の
 * 位置を返す（状態がなければ `null`）。
 */
function restoreTabReader(R: StandardReaders, { stateKey, activePath, release }: {
  readonly stateKey: string;
  readonly activePath: readonly number[] | null;
  readonly release: boolean;
}): ScrollPosition | null {
  const state = (window as unknown as Record<string, InPageTabState | undefined>)[stateKey];
  const previous = activePath === null ? null : R.elementAtPath(activePath);
  if (previous instanceof HTMLElement) {
    HTMLElement.prototype.focus.call(previous, { preventScroll: true });
  } else {
    const active = R.documentProperty<Element | null>('activeElement');
    if (active instanceof HTMLElement) {
      HTMLElement.prototype.blur.call(active);
    }
  }
  if (state === undefined) {
    return null;
  }
  for (const [element, offset] of state.offsets) {
    if (R.standardGetter<number>(Element.prototype, 'scrollLeft')(element) !== offset.scrollLeft
      || R.standardGetter<number>(Element.prototype, 'scrollTop')(element) !== offset.scrollTop) {
      (Element.prototype.scrollTo as (options: ScrollToOptions) => void).call(element, { left: offset.scrollLeft, top: offset.scrollTop, behavior: 'instant' });
    }
  }
  window.scrollTo({ left: state.document.scrollX, top: state.document.scrollY, behavior: 'instant' });
  if (release) {
    document.removeEventListener('focus', state.onFocusIn, true);
    Reflect.deleteProperty(window, stateKey);
  }
  return state.document;
}
const restoreTabInPage = composeInPage(restoreTabReader);

/** `checkSequentialTab` の指定。 */
export interface SequentialTabOptions {
  /** 確かめる項目（記録の `items` の中の位置。直の focus で隠れたままの項目。呼ぶ側が判定の 1 か所で選ぶ）。空なら押さない。 */
  readonly candidates: readonly number[];
  /** キーの押下の期間の Guard の口（なければ、始められなければ押さない）。 */
  readonly keyPressGuard?: ScrollKeyPressGuard | undefined;
  /** 位置が落ち着いたかを読む間隔（ms。`FocusCheckOptions.settleIntervalMs` と同じ。省略すると本番の値）。 */
  readonly settleIntervalMs?: number | undefined;
  /** 進みの見張りの口。 */
  readonly track?: (<T>(work: Promise<T>) => Promise<T>) | undefined;
  /** REV-AUD3 の M-4: 今の確かめの期限（見張りが段を終えたら abort）。abort したら、押すのと位置の落ち着きを待つのをやめる。 */
  readonly signal?: AbortSignal | undefined;
}

/**
 * AUD-3: 通常の Tab の確かめ。直の focus の確かめ（`collectFocusChecks`）の記録の、候補の項目について、Tab で届くか・届いたときに見えるかを読み、項目の
 * `sequentialTab` に足した記録を返す。
 * - 始まり（Blocker の判断の回り込み）: Chromium は直の focus の位置を Tab の始まりとして残すので、文書の外（body）へ出るまで Tab を押し、外から記録を始める。
 * - 終わり（構造の事実）: 外から後に、もう一度外へ出た・前に見た要素へ戻った（罠）・候補を全部確かめた。数の上限は置かない（押下はフォーカスできる要素の数の
 *   およそ 2 倍まで）。終えたら、記録のない候補は「届かない」。
 * - REV-AUD3 の後の判断: 外へ出る前に前に見た要素へ戻った・枠の中へ入った・値を入れる要素に来た（押す前に止める）・確かめ始めたときになかった要素に来た・
 *   今の確かめの期限が来たときは、確かめられなかったとして記録を変えずに返す（残りの候補を「届かない」と決めない）。
 * - 届いた候補は、位置が落ち着く（続けて 2 回同じ）まで読んでから、直の focus と同じ読みで矩形・見えるか・押せるかを読む。新しい秒の値は足さない。
 * - Tab だけを押す。読み込みと BeakSight の要求は足さない。キーを押す期間は Guard の口で、ページが始めた画面の移動とポップアップを止める（フォーカスでページが
 *   出す送信は Guard の決まりのまま）。DOM は書き換えない。終えたら、元のフォーカスと位置へ戻す。
 * - Guard の口がない・始められない・途中で読めなくなったときは、記録を変えずに返す（例外は投げない）。
 * - AUDR2: 結果（確かめ終えた・候補がなく走らなかった・確かめられなかった理由）を、記録の `sequentialTabOutcome` に残す（項目の記録は、確かめ終えたときだけ
 *   変える）。
 */
export async function checkSequentialTab(page: Page, evidence: FocusCheckEvidence, options: SequentialTabOptions): Promise<FocusCheckEvidence> {
  const track = options.track ?? (<T>(work: Promise<T>): Promise<T> => work);
  const paths = itemPathsOf.get(evidence) ?? [];
  const candidates = options.candidates.filter((index) => paths[index] !== undefined && evidence.items[index] !== undefined);
  const guard = options.keyPressGuard;
  // AUDR2: 走らなかった・確かめられなかったときは、項目の記録を変えずに、その理由を残す。
  const withOutcome = (sequentialTabOutcome: FocusSequentialTabOutcome): FocusCheckEvidence => {
    const result: FocusCheckEvidence = Object.freeze({ ...evidence, sequentialTabOutcome });
    itemPathsOf.set(result, paths);
    return result;
  };
  if (candidates.length === 0) {
    return withOutcome('NO_CANDIDATES');
  }
  if (guard === undefined || !guard.begin()) {
    return withOutcome('KEY_GUARD_UNAVAILABLE');
  }
  const settleIntervalMs = options.settleIntervalMs ?? observationWindowsOrProduction(undefined).scroll.stepWaitMs;
  const { signal } = options;
  const candidatePaths = candidates.map((index) => paths[index] ?? []);
  const records = new Map<number, FocusCheckSequentialTabEvidence>();
  let ended = false;
  let unchecked: FocusSequentialTabOutcome = 'READ_FAILED';
  const hasGuardItem = evidence.items.some(({ kind }) => kind === 'GUARD');
  let activePath: readonly number[] | null = null;
  try {
    const befores = await Promise.all(candidatePaths.map((path) => track(page.evaluate(chainPositionsInPage, { path }))));
    const prepared = await track(page.evaluate(prepareTabInPage, {
      paths: candidatePaths, stateKey: SEQUENTIAL_TAB_STATE_KEY, editableSelector: EDITABLE_SELECTOR,
      controlTypeSelector: CONTROL_TYPE_SELECTOR, hiddenMaxDimensionPx: HIDDEN_MAX_DIMENSION_PX,
    }));
    activePath = prepared.activePath;
    // REV-AUD3 の 2 回目の M-B: 値を入れる要素にフォーカスがあったときは、準備の読み取りが外した（外した後の Tab は欄に字を入れない）。
    let outside = false;
    let reset = false;
    for (let stopped = false; !stopped;) {
      signal?.throwIfAborted();
      await track(pressSequentialTabKey(page));
      const step = await track(page.evaluate(tabStepInPage, { stateKey: SEQUENTIAL_TAB_STATE_KEY, reset, editableSelector: EDITABLE_SELECTOR }));
      reset = false;
      if (step.state === 'OUTSIDE') {
        if (outside) {
          ended = true;
          break;
        }
        // 外から記録をやり直す（外へ出る前の記録は、文書の先頭からの並びでない）。
        outside = true;
        reset = true;
        records.clear();
        continue;
      }
      // REV-AUD3 の I-1: 外へ出る前に前に見た要素へ戻ったときは、文書の先頭から確かめられない。外から後に戻ったときは、罠で終わる（構造の事実）。
      // `STOP`（枠の中・値を入れる要素・確かめ始めたときになかった要素）も、確かめられなかったとして終える。
      if (step.state === 'SEEN' || step.state === 'STOP') {
        // AUDR2: 守りの部品（`GUARD`）の項目がある画面では、前に見た要素へ戻ったのを罠と決めない（守りの部品が戻した形。始めを作れないとする）。
        ended = step.state === 'SEEN' && outside && !hasGuardItem;
        unchecked = step.state === 'SEEN' ? 'NO_START' : step.stop ?? 'READ_FAILED';
        stopped = true;
        continue;
      }
      const path = step.candidate === null ? undefined : candidatePaths[step.candidate];
      const before = step.candidate === null ? null : befores[step.candidate] ?? null;
      if (step.candidate !== null && path !== undefined && before !== null && !records.has(step.candidate)) {
        // 2 回目の I-A: 落ち着きの待ちの読み取りは印を付けない。期限までに落ち着かなければ、確かめられなかったとして記録を変えない。
        if (!(await settledReading(() => page.evaluate(chainPositionsInPage, { path }), settleIntervalMs, signal)).settled) {
          unchecked = 'UNSETTLED';
          throw new Error('the position did not settle before the end of the check');
        }
        const focused = await track(page.evaluate(readFocusedInPage, {
          path, before, maxSelectorDepth: MAX_SELECTOR_DEPTH, insetPx: HIT_TEST_POINT_INSET_PX, frontWindowRatio: FRONT_WINDOW_MIN_VIEWPORT_RATIO,
        }));
        const coveredBySelector = focused === null || focused.hitAfterFocus
          ? null
          : await track(page.evaluate(coverInPage, { path, insetPx: HIT_TEST_POINT_INSET_PX, maxSelectorDepth: MAX_SELECTOR_DEPTH }));
        records.set(step.candidate, Object.freeze({
          operation: 'SEQUENTIAL_TAB',
          reached: focused?.focused ?? false,
          afterRect: focused?.afterRect ?? null,
          visibleAfterFocus: focused?.visibleAfterFocus ?? false,
          hitAfterFocus: focused?.hitAfterFocus ?? false,
          hitTestPointCount: focused?.hitTestPointCount ?? 0,
          hitPointCount: focused?.hitPointCount ?? 0,
          coveredBySelector,
          // RVP-1: 前面の窓を開いたまま、Tab で背後の要素へ移ったか。
          ...(focused?.focused === true && focused.behindFrontWindow ? { behindFrontWindow: true as const } : {}),
        }));
        if (outside && records.size === candidates.length) {
          ended = true;
          break;
        }
      }
    }
  } catch {
    // 途中で読めなくなった画面は、記録を変えない（ほかの証拠には影響させない）。
    ended = false;
  } finally {
    // AUDR2: 期限が来たら、ほかの理由より先に期限とする（落ち着きの待ちは期限で終わる）。
    if (!ended && aborted(signal)) {
      unchecked = 'DEADLINE';
    }
    const restore = (release: boolean): Promise<ScrollPosition | null> =>
      track(page.evaluate(restoreTabInPage, { stateKey: SEQUENTIAL_TAB_STATE_KEY, activePath, release }));
    const restoreAll = async (): Promise<void> => {
      const expected = await restore(false).catch(() => null);
      const now = await settledReading(() => page.evaluate(documentPositionInPage), settleIntervalMs, signal).catch(() => null);
      if (expected !== null && now !== null && JSON.stringify(now.value) !== JSON.stringify(expected)) {
        await restore(false).catch(() => null);
      }
      await restore(true).catch(() => null);
    };
    // 期限が来た後は、戻すのを待たない（見張りが段を終えた後に、処理を残さずに返す）。
    // Guard の押下の期間は、戻し終えてから閉じる。
    if (aborted(signal)) {
      void restoreAll().catch(() => undefined).finally(() => guard.end());
    } else {
      await restoreAll();
      guard.end();
    }
  }
  if (!ended) {
    return withOutcome(unchecked);
  }
  const unreached: FocusCheckSequentialTabEvidence = Object.freeze({
    operation: 'SEQUENTIAL_TAB', reached: false, afterRect: null, visibleAfterFocus: false, hitAfterFocus: false, hitTestPointCount: 0, hitPointCount: 0,
    coveredBySelector: null,
  });
  const byItem = new Map(candidates.map((index, position) => [index, records.get(position) ?? unreached]));
  const result: FocusCheckEvidence = Object.freeze({
    ...evidence,
    sequentialTabOutcome: 'CHECKED',
    items: Object.freeze(evidence.items.map((item, index) => {
      const sequentialTab = byItem.get(index);
      return sequentialTab === undefined ? item : Object.freeze({ ...item, sequentialTab });
    })),
  });
  itemPathsOf.set(result, paths);
  return result;
}
