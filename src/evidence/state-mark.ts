/**
 * AUD-4（設計書 `doc/design/2026-11-19-beaksight-audit-result-review-fixes-design.md` 7.2 の 1）: 状態の印を読む部品の 1 か所。layout の読み取り
 * （`src/evidence/layout-collector.ts`）と、状態の画像の撮影（`src/evidence/screenshot-collector.ts`）が、同じ部品で読む。
 * - 中身: 文書のスクロール、スクロールできる箱（`isScrollableBox`）ごとの selector と位置と見える範囲、DOM の構造の要約の digest（要素の名前と入れ子の深さだけ。
 *   値・文字・属性は入れない。描かない要素 `NON_RENDERED_TAGS` は、その下ごと除く。記録だけで、比べには使わない）。
 * - 対象（layout の Evidence の項目の selector。`stateMarkTargetSelectorsOf`。数の上限は置かない）: layout の印では、対象ごとの祖先の箱の番号。状態の画像の印では、
 *   設計者の判断（2026-11-19）で、対象ごとに当たった要素の数と矩形を読み直す（対象と関係のない所の変化で、指摘を保留にしないため）。
 * - 隠した通知の枠の数は、ページの中では読まない（呼ぶ側が記録から足す）。
 * - 読むだけ（ページの状態を変えない）。要求と読み込みを足さない。1 回の `page.evaluate`。
 */
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import type {
  EvidenceStateMark,
  LayoutEvidence,
  RectangleEvidence,
  StateMarkScrollBoxEvidence,
  StateMarkTargetRectEvidence,
  StateMarkTargetScrollBoxesEvidence,
} from '../core/evidence-types.js';
import { MAX_SELECTOR_DEPTH } from '../core/limits.js';

/** 状態の印の対象: layout の Evidence の項目の selector（重なりなし。読んだ順）。layout の印と、その layout の後の状態の画像の印が使う。 */
export function stateMarkTargetSelectorsOf(layout: LayoutEvidence): readonly string[] {
  return [...new Set([
    ...layout.boxesOutsideViewport.map(({ selector }) => selector),
    ...layout.zeroSizeInteractive.map(({ selector }) => selector),
    ...layout.clippedText.map(({ selector }) => selector),
    ...layout.fixedElements.map(({ selector }) => selector),
    ...layout.fixedHeadingOverlaps.flatMap(({ overlaySelector, headingSelector }) => [overlaySelector, headingSelector]),
    ...layout.elementOverlaps.flatMap(({ first, second }) => [first.selector, second.selector]),
  ])];
}

/** 対象について読むもの（layout の印は祖先の箱、状態の画像の印は当たった数と矩形）。 */
export type StateMarkTargetRead = 'SCROLL_BOXES' | 'RECTS';

/** 構造の要約に入れない、描かない要素の名前（その下ごと除く。ページが後から足す script などで、落ち着いた画面の要約を揺らさない）。 */
const NON_RENDERED_TAGS = Object.freeze(['script', 'style', 'link', 'meta', 'noscript', 'template', 'title', 'base']);

interface StateMarkArgument {
  readonly maxSelectorDepth: number;
  readonly nonRenderedTags: readonly string[];
  /** 対象の selector。 */
  readonly targetSelectors: readonly string[];
  readonly targetRead: StateMarkTargetRead;
}

interface RawStateMark {
  readonly documentScroll: { readonly scrollX: number; readonly scrollY: number };
  readonly scrollBoxes: readonly StateMarkScrollBoxEvidence[];
  readonly structureCount: number;
  readonly structureHashes: readonly [number, number];
  readonly targetScrollBoxes: readonly StateMarkTargetScrollBoxesEvidence[];
  readonly targetRects: readonly StateMarkTargetRectEvidence[];
}

/** ページの中で状態の印を読む（部品 `R` を組み込んで渡すため、この関数の外にあるものを参照しない）。 */
function readStateMarkReader(R: StandardReaders, { maxSelectorDepth, nonRenderedTags, targetSelectors, targetRead }: StateMarkArgument): RawStateMark {
  const { standardGetter, documentProperty } = R;
  const parentOf = standardGetter<Element | null>(Node.prototype, 'parentElement');
  const localNameOf = standardGetter<string>(Element.prototype, 'localName');
  const root = documentProperty<Element>('documentElement');
  const body = documentProperty<HTMLElement | null>('body');
  const scrollingElement = documentProperty<Element | null>('scrollingElement');
  const scrollingRoot = scrollingElement ?? root;
  const separateBody = body !== null && body !== scrollingRoot ? body : null;
  // 文書のスクロール位置（`ScrollPosition` の定義。layout の読み取りと同じ）。
  const documentScroll = {
    scrollX: window.scrollX + (separateBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateBody?.scrollTop ?? 0),
  };
  // 構造の要約（FNV-1a の 2 つの種の 32 bit）と、スクロールできる箱を、1 回の走査で読む。
  let first = 0x811c9dc5;
  let second = 0x01000193;
  let count = 0;
  const mix = (token: string): void => {
    for (let index = 0; index < token.length; index += 1) {
      const code = token.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ code, 0x811c9dc5) >>> 0;
    }
  };
  const boxes: StateMarkScrollBoxEvidence[] = [];
  const boxIndexes = new Map<Element, number>();
  const walk = (element: Element, depth: number): void => {
    const name = localNameOf(element);
    if (nonRenderedTags.includes(name)) return;
    count += 1;
    mix(`${String(depth)}:${name};`);
    if (element !== root && element !== body && element !== scrollingElement && R.isScrollableBox(element)) {
      const box = Element.prototype.getBoundingClientRect.call(element);
      const clientLeft = standardGetter<number>(Element.prototype, 'clientLeft')(element);
      const clientTop = standardGetter<number>(Element.prototype, 'clientTop')(element);
      const width = standardGetter<number>(Element.prototype, 'clientWidth')(element);
      const height = standardGetter<number>(Element.prototype, 'clientHeight')(element);
      const left = box.left + clientLeft;
      const top = box.top + clientTop;
      boxIndexes.set(element, boxes.length);
      boxes.push({
        selector: R.selectorOf(element, maxSelectorDepth),
        scrollLeft: standardGetter<number>(Element.prototype, 'scrollLeft')(element),
        scrollTop: standardGetter<number>(Element.prototype, 'scrollTop')(element),
        clientRect: { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height },
      });
    }
    for (let child = standardGetter<Element | null>(Element.prototype, 'firstElementChild')(element); child !== null;
      child = standardGetter<Element | null>(Element.prototype, 'nextElementSibling')(child)) {
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  const targetScrollBoxes: StateMarkTargetScrollBoxesEvidence[] = [];
  const targetRects: StateMarkTargetRectEvidence[] = [];
  const nodeListLengthOf = standardGetter<number>(NodeList.prototype, 'length');
  for (const selector of targetSelectors) {
    let found: NodeList | null = null;
    try {
      found = Document.prototype.querySelectorAll.call(document, selector);
    } catch {
      found = null;
    }
    const matchCount = found === null ? 0 : nodeListLengthOf(found);
    const target = found === null || matchCount === 0 ? null : NodeList.prototype.item.call(found, 0);
    const element = target instanceof Element ? target : null;
    if (targetRead === 'RECTS') {
      const box = element === null ? null : Element.prototype.getBoundingClientRect.call(element);
      targetRects.push({
        selector,
        matchCount,
        rect: box === null
          ? null
          : { x: box.x, y: box.y, top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height },
      });
      continue;
    }
    const ancestors: number[] = [];
    for (let node = element === null ? null : parentOf(element); node !== null; node = parentOf(node)) {
      const index = boxIndexes.get(node);
      if (index !== undefined) ancestors.push(index);
    }
    if (ancestors.length > 0) targetScrollBoxes.push({ selector, boxes: ancestors });
  }
  return { documentScroll, scrollBoxes: boxes, structureCount: count, structureHashes: [first, second], targetScrollBoxes, targetRects };
}
const readStateMarkInPage = composeInPage(readStateMarkReader);

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 状態の印を読むページ（ページの中で関数を 1 回流す口だけを使う。Playwright の型は持たない。RB-1 の import の一覧を増やさない）。 */
export interface StateMarkPage {
  evaluate<R, A>(pageFunction: (argument: A) => R, argument: A): Promise<R>;
}

const rectValid = (rect: RectangleEvidence): boolean => Object.values(rect).every(finiteNumber);

/**
 * 今のページの状態の印を読む。`targets` は、対象の selector と読むもの（layout の印は祖先の箱 `SCROLL_BOXES`、状態の画像の印は当たった数と矩形 `RECTS`）。
 * 対象を渡さなければ、対象の項目を持たない。ブラウザが不正な値を返したら例外を投げる（呼ぶ側が受け止める）。
 */
export async function readStateMark(
  page: StateMarkPage,
  targets: { readonly selectors: readonly string[]; readonly read: StateMarkTargetRead } | null = null,
): Promise<EvidenceStateMark> {
  const raw = await page.evaluate<RawStateMark, StateMarkArgument>(readStateMarkInPage, {
    maxSelectorDepth: MAX_SELECTOR_DEPTH,
    nonRenderedTags: NON_RENDERED_TAGS,
    targetSelectors: [...new Set(targets?.selectors ?? [])],
    targetRead: targets?.read ?? 'SCROLL_BOXES',
  } satisfies StateMarkArgument);
  const boxesValid = Array.isArray(raw.scrollBoxes) && raw.scrollBoxes.every((box) => typeof box.selector === 'string'
    && finiteNumber(box.scrollLeft) && finiteNumber(box.scrollTop) && rectValid(box.clientRect));
  const targetRectsValid = Array.isArray(raw.targetRects) && raw.targetRects.every((entry) => typeof entry.selector === 'string'
    && finiteNumber(entry.matchCount) && (entry.rect === null || rectValid(entry.rect)));
  if (!finiteNumber(raw.documentScroll.scrollX) || !finiteNumber(raw.documentScroll.scrollY) || !boxesValid || !targetRectsValid
    || !finiteNumber(raw.structureCount) || !raw.structureHashes.every(finiteNumber)) {
    throw new Error('Browser returned an invalid state mark');
  }
  const hex = (value: number): string => value.toString(16).padStart(8, '0');
  return Object.freeze({
    documentScroll: Object.freeze({ scrollX: raw.documentScroll.scrollX, scrollY: raw.documentScroll.scrollY }),
    scrollBoxes: Object.freeze(raw.scrollBoxes.map((box) => Object.freeze({ ...box, clientRect: Object.freeze({ ...box.clientRect }) }))),
    structureDigest: `${String(raw.structureCount)}:${hex(raw.structureHashes[0])}${hex(raw.structureHashes[1])}`,
    ...(raw.targetScrollBoxes.length === 0
      ? {}
      : { targetScrollBoxes: Object.freeze(raw.targetScrollBoxes.map((entry) => Object.freeze({ selector: entry.selector, boxes: Object.freeze([...entry.boxes]) }))) }),
    ...(targets?.read === 'RECTS'
      ? {
        targetRects: Object.freeze(raw.targetRects.map((entry) => Object.freeze({
          selector: entry.selector, matchCount: entry.matchCount, rect: entry.rect === null ? null : Object.freeze({ ...entry.rect }),
        }))),
      }
      : {}),
  });
}
