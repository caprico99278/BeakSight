import type { Page } from 'playwright';
import type { PageId } from '../core/contracts.js';
import { SUBMIT_CONTROL_TYPES } from '../core/evidence-types.js';
import type {
  DomDocumentFieldTruncationEvidence,
  DomEvidence,
  DuplicateIdEvidence,
  FormDomEvidence,
  FormFieldEvidence,
  HeadingEvidence,
  ImageDomEvidence,
  LoadingIndicatorEvidence,
  ScrollPosition,
  SemanticRegionEvidence,
  SemanticRegionKind,
  SubmitControlEvidence,
  VisibleTextSource,
} from '../core/evidence-types.js';
import { readInParts } from '../core/read-in-parts.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { composeInPage, type StandardReaders } from '../browser/in-page-readers.js';
import { collectErrorDisplay } from './error-display-collector.js';

/*
 * COV-6: 件数の上限（見出し・画像・form・欄・送信のコントロール・label・重複の id・区分）と、可視テキストの長さとたどるノードの数の上限は持たない
 * （すべてを記録する。`omitted...Count` は常に 0、可視テキストの `truncated`・`nodeLimitReached` は常に false）。URL-LEN: URL の長さの上限（前は 2,048）は
 * 撤廃した。LZ-3b: 値の長さの上限（前の `DOM_LIMITS`。title・meta description・lang・見出し・alt・label・属性 1,024、id 256）も撤廃した。どの値も
 * 切り詰めない（項目ごとの `truncated` と `truncation.documentFields` は前の記録の形のために残し、いつも偽）。
 */

/**
 * COV-6: ページの中の 1 回の読み取りで返す、一覧（見出し・画像・form・form に属さない欄・重複の id・区分）ごとの件数（自分の処理の上限 C。1 回の
 * 受け渡しの大きさを抑えるための分け方の単位で、記録の件数の上限ではない）。
 */
export const DOM_COLLECTION_PART_SIZE = 500;

/** COV-6: ページの中の 1 回の読み取りで返す、可視テキストと aria-hidden の中の可視テキストの長さ（自分の処理の上限 C。UTF-16 のコード単位）。 */
export const DOM_TEXT_PART_LENGTH = 100_000;

/** 一覧ごと・テキストごとの、この回に読み始める位置（COV-6）。 */
export interface DomPartCursor {
  readonly headings: number;
  readonly images: number;
  readonly forms: number;
  readonly unassociatedFields: number;
  readonly duplicateIds: number;
  readonly regions: number;
  readonly text: number;
  readonly ariaHiddenText: number;
}

/** 一覧の部分（続きの位置からの項目と、ページの中の全体の件数）。 */
interface RawListPart<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** テキストの部分（続きの位置からの文字と、ページの中の全体の長さ）。 */
interface RawTextPart {
  readonly slice: string;
  readonly total: number;
}

/** ページの中の 1 回の読み取りの結果。文書の項目とスクロール位置は、どの回も同じものを返す（まとめるときは最初の回のものを使う）。 */
interface RawDomPart {
  readonly scrollPosition: ScrollPosition;
  /** EV-1: 見えている読み込み中の表示の数（文書の項目。どの回も同じものを返す）。 */
  readonly loadingIndicators: LoadingIndicatorEvidence;
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly canonicalUrl: string | null;
  readonly lang: string | null;
  readonly documentFields: DomDocumentFieldTruncationEvidence;
  readonly source: VisibleTextSource;
  readonly headings: RawListPart<HeadingEvidence>;
  readonly images: RawListPart<ImageDomEvidence>;
  readonly forms: RawListPart<FormDomEvidence>;
  readonly unassociatedFields: RawListPart<FormFieldEvidence>;
  readonly duplicateIds: RawListPart<DuplicateIdEvidence>;
  readonly regions: RawListPart<SemanticRegionEvidence>;
  readonly text: RawTextPart;
  readonly ariaHiddenText: RawTextPart;
}

/** 一覧とテキストの名前（続きの位置の項目と同じ）。 */
const LIST_PART_NAMES = Object.freeze(['headings', 'images', 'forms', 'unassociatedFields', 'duplicateIds', 'regions'] as const);
const TEXT_PART_NAMES = Object.freeze(['text', 'ariaHiddenText'] as const);

const FIRST_DOM_PART_CURSOR: DomPartCursor = Object.freeze({
  headings: 0, images: 0, forms: 0, unassociatedFields: 0, duplicateIds: 0, regions: 0, text: 0, ariaHiddenText: 0,
});

function assertBoundedList(list: readonly unknown[], max: number, name: string): void {
  if (list.length > max) {
    throw new Error(`Unbounded browser DOM list: ${name}`);
  }
}

function assertBoundedText(value: string | null, max: number, name: string): void {
  if (value !== null && value.length > max) {
    throw new Error(`Unbounded browser DOM text: ${name}`);
  }
}

function assertCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid browser DOM count: ${name}`);
  }
}

function validateField(field: FormFieldEvidence, name: string): void {
  if (typeof field.visible !== 'boolean') {
    throw new Error(`Invalid browser DOM flag: ${name}.visible`);
  }
}

function freezeField(field: FormFieldEvidence): FormFieldEvidence {
  return Object.freeze({ ...field, labels: Object.freeze([...field.labels]) });
}

/**
 * ブラウザから受け取った 1 回の部分の大きさ（部分の件数・テキストの部分の長さ。受け渡しの分け方の単位）と数・印の形を確かめる。ページが組み込みの関数を
 * 書き換えた場合に備える。LZ-3b: 値の長さは確かめない（値の長さの上限はない）。
 */
function validateRawDomPart(raw: RawDomPart): void {
  if (!Number.isFinite(raw.scrollPosition.scrollX) || !Number.isFinite(raw.scrollPosition.scrollY)) {
    throw new Error('Invalid browser DOM scroll position');
  }
  for (const [name, value] of Object.entries(raw.loadingIndicators)) {
    assertCount(value, `loadingIndicators.${name}`);
  }
  for (const name of LIST_PART_NAMES) {
    assertBoundedList(raw[name].items, DOM_COLLECTION_PART_SIZE, name);
    assertCount(raw[name].total, `${name}.total`);
  }
  for (const name of TEXT_PART_NAMES) {
    assertBoundedText(raw[name].slice, DOM_TEXT_PART_LENGTH, name);
    assertCount(raw[name].total, `${name}.total`);
  }
  raw.forms.items.forEach((form, formIndex) => {
    form.fields.forEach((field, index) => {
      validateField(field, `forms[${formIndex}].fields[${index}]`);
    });
  });
  raw.unassociatedFields.items.forEach((field, index) => {
    validateField(field, `unassociatedFields[${index}]`);
  });
  raw.duplicateIds.items.forEach((duplicate, index) => {
    if (!Number.isSafeInteger(duplicate.count) || duplicate.count < 2) {
      throw new Error(`Invalid browser DOM duplicate id count: ${index}`);
    }
  });
  for (const [field, truncated] of Object.entries(raw.documentFields)) {
    if (typeof truncated !== 'boolean') {
      throw new Error(`Invalid browser DOM flag: truncation.documentFields.${field}`);
    }
  }
}

/** 今の部分の次に読む位置（どの一覧もテキストも読み終えていれば `null`。ページが縮んで部分が空になった一覧は、そこで読み終えたとする）。 */
function nextDomPartCursor(cursor: DomPartCursor, raw: RawDomPart): DomPartCursor | null {
  let more = false;
  const next = { ...cursor };
  for (const name of LIST_PART_NAMES) {
    next[name] = cursor[name] + raw[name].items.length;
    more ||= raw[name].items.length > 0 && next[name] < raw[name].total;
  }
  for (const name of TEXT_PART_NAMES) {
    next[name] = cursor[name] + raw[name].slice.length;
    more ||= raw[name].slice.length > 0 && next[name] < raw[name].total;
  }
  return more ? next : null;
}

/** 部分ごとの読み取りを、1 つの DOM の Evidence にまとめる（文書の項目とスクロール位置は最初の部分のもの）。 */
function assembleDomEvidence(parts: readonly RawDomPart[], pageId: PageId): DomEvidence {
  const [first] = parts;
  if (first === undefined) {
    throw new Error('Missing browser DOM part');
  }
  const listOf = <T>(name: (typeof LIST_PART_NAMES)[number], freeze: (item: never) => T): readonly T[] =>
    Object.freeze(parts.flatMap((part) => (part[name].items as readonly never[]).map(freeze)));
  const headings = listOf('headings', (heading: HeadingEvidence) => Object.freeze({ ...heading }));
  const regions = listOf('regions', (region: SemanticRegionEvidence) => Object.freeze({ ...region }));
  const images = listOf('images', (image: ImageDomEvidence) => Object.freeze({ ...image }));
  const forms = listOf('forms', (form: FormDomEvidence) => Object.freeze({
    ...form,
    fields: Object.freeze(form.fields.map(freezeField)),
    submitControls: Object.freeze(form.submitControls.map((control) => Object.freeze({ ...control }))),
  }));
  const unassociatedFields = listOf('unassociatedFields', freezeField);
  const duplicateIds = listOf('duplicateIds', (duplicate: DuplicateIdEvidence) => Object.freeze({ ...duplicate }));
  const textOf = (name: (typeof TEXT_PART_NAMES)[number]): string => parts.map((part) => part[name].slice).join('');

  return Object.freeze({
    pageId,
    scrollPosition: Object.freeze({ scrollX: first.scrollPosition.scrollX, scrollY: first.scrollPosition.scrollY }),
    title: first.title,
    metaDescription: first.metaDescription,
    canonicalUrl: first.canonicalUrl,
    lang: first.lang,
    headings,
    visibleText: Object.freeze({
      source: first.source,
      text: textOf('text'),
      truncated: false,
      nodeLimitReached: false,
      ariaHiddenText: textOf('ariaHiddenText'),
      regions: first.source === 'SEMANTIC_LANDMARKS' ? regions : Object.freeze([]),
      omittedRegionCount: 0,
    }),
    images,
    forms,
    unassociatedFields,
    duplicateIds,
    truncation: Object.freeze({
      documentFields: Object.freeze({
        title: first.documentFields.title,
        metaDescription: first.documentFields.metaDescription,
        canonicalUrl: first.documentFields.canonicalUrl,
        lang: first.documentFields.lang,
      }),
      omittedHeadingCount: 0,
      omittedImageCount: 0,
      omittedFormCount: 0,
      omittedUnassociatedFieldCount: 0,
      omittedDuplicateIdCount: 0,
    }),
    collectedInParts: parts.length,
    loadingIndicators: Object.freeze({
      ariaBusyCount: first.loadingIndicators.ariaBusyCount,
      progressbarCount: first.loadingIndicators.progressbarCount,
      indeterminateProgressCount: first.loadingIndicators.indeterminateProgressCount,
    }),
  });
}

/** `collectDomEvidenceReader` の入力（ブラウザ内では import できないため、可視判定の指定と、送信のコントロールの `type` の一覧と、この回の位置と大きさを渡す）。 */
interface DomEvaluationArgument {
  readonly visibilityOptions: typeof VISIBILITY_CHECK_OPTIONS;
  readonly submitControlTypes: typeof SUBMIT_CONTROL_TYPES;
  readonly cursor: DomPartCursor;
  readonly partSize: number;
  readonly textPartLength: number;
}

/**
 * ブラウザ内で、DOM の Evidence（Link 以外）の事実を 1 回の走査で集め、一覧とテキストを、この回の位置（`cursor`）から部分の大きさまで切り出して返す
 * （集める内容は `collectDomEvidence` の説明のとおり。COV-6: 走査は毎回すべてを集め、返す部分だけを分ける）。
 * 部品（`R`）を `composeInPage` で組み込んで `page.evaluate` に渡すため、この関数の外にあるものを参照しない。
 */
function collectDomEvidenceReader(
  R: StandardReaders,
  { visibilityOptions, submitControlTypes, cursor, partSize, textPartLength }: DomEvaluationArgument,
): RawDomPart {
  // DOM clobbering（DEF-069）: form の中の名前つきの入力の欄は、form の同じ名前のプロパティとメソッドを隠す（`<input name="method">` で
  // `form.method` が入力の欄になる）。form になりうる要素（文書をたどる途中のすべての要素と、form そのもの）の標準のプロパティとメソッドは、
  // 標準の prototype の getter とメソッドで読む（`src/browser/login-form-submitter.ts` の `readLoginFormFactsInPage` と同じ読み方）。
  // 入力の欄・ボタン・ラベル・見出し・画像は、名前つきの子でプロパティが隠れないので、そのまま読む。
  // getter は部品の `standardGetter`（`src/browser/in-page-readers.ts`。CC-068。`discover-candidates.ts` の `interactionCandidateProbe` も
  // 同じ部品を使う）。
  const { standardGetter } = R;
  const nodeTypeOf = standardGetter<number>(Node.prototype, 'nodeType');
  const childNodesOf = standardGetter<NodeListOf<ChildNode>>(Node.prototype, 'childNodes');
  const parentElementOf = standardGetter<HTMLElement | null>(Node.prototype, 'parentElement');
  const parentNodeOf = standardGetter<ParentNode | null>(Node.prototype, 'parentNode');
  const tagNameOf = standardGetter<string>(Element.prototype, 'tagName');
  const idOf = standardGetter<string>(Element.prototype, 'id');
  const shadowRootOf = standardGetter<ShadowRoot | null>(Element.prototype, 'shadowRoot');
  const elementAssignedSlotOf = standardGetter<HTMLSlotElement | null>(Element.prototype, 'assignedSlot');
  const textAssignedSlotOf = standardGetter<HTMLSlotElement | null>(Text.prototype, 'assignedSlot');
  const formElementsOf = standardGetter<HTMLFormControlsCollection>(HTMLFormElement.prototype, 'elements');
  const formMethodOf = standardGetter<string>(HTMLFormElement.prototype, 'method');
  const getAttributeOf = (element: Element, name: string): string | null => Element.prototype.getAttribute.call(element, name);
  const checkVisibilityOf = (element: Element, options: CheckVisibilityOptions): boolean => (
    Element.prototype.checkVisibility.call(element, options)
  );
  const closestOf = (element: Element, selector: string): Element | null => Element.prototype.closest.call(element, selector);
  // DOM clobbering（DEF-073）: 名前つきの img・form など（`<img name="forms">`、`<form name="title">`）は、`document` の同じ名前のプロパティと
  // メソッドを隠す。`document` の標準のプロパティとメソッドも、`Document.prototype` の getter とメソッドで読む。
  const documentElementOf = standardGetter<HTMLElement>(Document.prototype, 'documentElement');
  const scrollingElementOf = standardGetter<Element | null>(Document.prototype, 'scrollingElement');
  const bodyOf = standardGetter<HTMLElement | null>(Document.prototype, 'body');
  const titleOf = standardGetter<string>(Document.prototype, 'title');
  const imagesOf = standardGetter<HTMLCollectionOf<HTMLImageElement>>(Document.prototype, 'images');
  const formsOf = standardGetter<HTMLCollectionOf<HTMLFormElement>>(Document.prototype, 'forms');
  const queryDocument = (selectors: string): Element | null => Document.prototype.querySelector.call(document, selectors);
  const queryDocumentAll = (selectors: string): NodeListOf<Element> => Document.prototype.querySelectorAll.call(document, selectors);

  // 文書のスクロール位置（`ScrollPosition` の定義）。`scrollingElement` ではない body のスクロール量を含める。
  const documentBody = bodyOf(document);
  const scrollingRoot = scrollingElementOf(document) ?? documentElementOf(document);
  const separateScrollBody = documentBody !== null && documentBody !== scrollingRoot ? documentBody : null;
  const scrollPosition = {
    scrollX: window.scrollX + (separateScrollBody?.scrollLeft ?? 0),
    scrollY: window.scrollY + (separateScrollBody?.scrollTop ?? 0),
  };
  const normalizeWhitespace = (value: string | null): string => value?.replace(/\s+/gu, ' ').trim() ?? '';
  /** URL-LEN・LZ-3b: 値は切り詰めない（空白の正規化だけ）。 */
  const wholeOf = (value: string | null): string | null => (value === null ? null : normalizeWhitespace(value));
  const hasNonBlankAttribute = (element: Element, name: string): boolean => (
    normalizeWhitespace(getAttributeOf(element, name)).length > 0
  );
  const isAriaHiddenElement = (element: Element): boolean => getAttributeOf(element, 'aria-hidden') === 'true';

  // 描画上の親（slot に割り当てられたノードは slot、shadow root の直下は host）。
  const flatTreeParent = (node: Node): Element | null => {
    const slot = node instanceof Element
      ? elementAssignedSlotOf(node)
      : node instanceof Text ? textAssignedSlotOf(node) : null;
    if (slot !== null) {
      return slot;
    }
    const parentElement = parentElementOf(node);
    if (parentElement !== null) {
      return parentElement;
    }
    const parentNode = parentNodeOf(node);
    return parentNode instanceof ShadowRoot ? parentNode.host : null;
  };
  // 可視判定は checkVisibility だけで行う（設計書 foundation-corrections 5.5）。結果は要素ごとに1回だけ求める。
  // `display: contents` の要素は箱を持たず checkVisibility が false を返すので、`display: contents` ではない最も近い
  // 祖先（自身を含む）に対して判定する。ただし visibility は継承され、`display: contents` の要素の値がその中身に効くので、
  // その場合の visibility は、箱を持つ祖先ではなく、判定する要素自身の計算値で判定する（祖先をたどって判定しない）。
  const boxlessVisibilityOptions = { ...visibilityOptions, visibilityProperty: false };
  const visibilityCache = new Map<Element, boolean>();
  const isVisible = (element: Element): boolean => {
    const cached = visibilityCache.get(element);
    if (cached !== undefined) {
      return cached;
    }
    const style = window.getComputedStyle(element);
    let visible: boolean;
    if (style.display === 'contents') {
      let boxed = flatTreeParent(element);
      while (boxed !== null && window.getComputedStyle(boxed).display === 'contents') {
        boxed = flatTreeParent(boxed);
      }
      visible = boxed !== null
        && checkVisibilityOf(boxed, boxlessVisibilityOptions)
        && (!visibilityOptions.visibilityProperty || style.visibility === 'visible');
    } else {
      visible = checkVisibilityOf(element, visibilityOptions);
    }
    visibilityCache.set(element, visible);
    return visible;
  };

  // テキストの蓄積。区切りの空白は重ねない。COV-6・LZ-3b: 長さでは切り詰めない。
  interface TextSink {
    readonly parts: string[];
    lastWasSeparator: boolean;
  }
  const createSink = (): TextSink => ({ parts: [], lastWasSeparator: true });
  const appendText = (sink: TextSink, text: string): void => {
    if (text.length === 0) {
      return;
    }
    sink.parts.push(text);
    sink.lastWasSeparator = text.endsWith(' ');
  };
  const appendSeparator = (sink: TextSink): void => {
    if (!sink.lastWasSeparator) {
      appendText(sink, ' ');
      sink.lastWasSeparator = true;
    }
  };
  const finishSink = (sink: TextSink): string => normalizeWhitespace(sink.parts.join(''));

  interface RegionAccumulator {
    readonly kind: SemanticRegionKind;
    readonly sink: TextSink;
    readonly ariaHidden: boolean;
  }
  interface WalkContext {
    readonly regions: readonly RegionAccumulator[];
    readonly insideLandmark: boolean;
    readonly ariaHidden: boolean;
  }
  type WalkItem =
    | { readonly kind: 'node'; readonly node: Node; readonly context: WalkContext }
    | { readonly kind: 'separator'; readonly context: WalkContext };

  const landmarkKinds: Readonly<Record<string, SemanticRegionKind>> = {
    HEADER: 'header',
    NAV: 'navigation',
    MAIN: 'main',
    ASIDE: 'aside',
    FOOTER: 'footer',
    FORM: 'form',
  };
  // 描画されない内容や、入力欄の値としてのテキストは、可視テキストとして扱わない（innerText と同じ）。
  const skippedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA']);
  const inlineDisplays = new Set(['inline', 'contents']);
  // 描画上の子（open な shadow root と、slot に割り当てられたノード）をたどる。
  const renderedChildren = (element: Element): readonly Node[] => {
    const shadowRoot = shadowRootOf(element);
    if (shadowRoot !== null) {
      return [...shadowRoot.childNodes];
    }
    if (element instanceof HTMLSlotElement) {
      const assigned = element.assignedNodes({ flatten: true });
      return assigned.length > 0 ? assigned : [...childNodesOf(element)];
    }
    return [...childNodesOf(element)];
  };

  interface WalkResult {
    readonly all: TextSink;
    readonly other: TextSink;
    readonly ariaHiddenSink: TextSink;
    readonly otherHasExposedText: boolean;
    readonly regions: readonly RegionAccumulator[];
  }
  // COV-6・LZ-3b: 可視テキスト（本文・区分・aria-hidden の中・見出し・label）は長さで切り詰めず、たどるノードの数でも止めない（本文は返すときに部分に分ける）。
  /** `root` の中の可視テキストを、文書の順に、区分ごとに集める。 */
  const walkVisibleText = (root: Element, trackRegions: boolean): WalkResult => {
    const all = createSink();
    const other = createSink();
    const ariaHiddenSink = createSink();
    const regions: RegionAccumulator[] = [];
    let otherHasExposedText = false;
    const sinksFor = (context: WalkContext): TextSink[] => {
      const sinks = [all, ...context.regions.map((region) => region.sink)];
      if (trackRegions && !context.insideLandmark) {
        sinks.push(other);
      }
      if (context.ariaHidden) {
        sinks.push(ariaHiddenSink);
      }
      return sinks;
    };
    const rootContext: WalkContext = {
      regions: [],
      insideLandmark: false,
      ariaHidden: closestOf(root, '[aria-hidden="true"]') !== null,
    };
    const stack: WalkItem[] = [{ kind: 'node', node: root, context: rootContext }];
    while (stack.length > 0) {
      const item = stack.pop() as WalkItem;
      if (item.kind === 'separator') {
        sinksFor(item.context).forEach(appendSeparator);
        continue;
      }
      const { node, context } = item;
      if (nodeTypeOf(node) === Node.TEXT_NODE) {
        const parentNode = parentNodeOf(node);
        const parent = parentElementOf(node) ?? (parentNode instanceof ShadowRoot ? parentNode.host : null);
        const renderedParent = flatTreeParent(node);
        if (
          parent === null
          || renderedParent === null
          || skippedTags.has(tagNameOf(parent))
          || !isVisible(renderedParent)
        ) {
          continue;
        }
        const text = (node.nodeValue ?? '').replace(/\s+/gu, ' ');
        if (text.length === 0) {
          continue;
        }
        for (const sink of sinksFor(context)) {
          if (text === ' ') {
            appendSeparator(sink);
          } else {
            appendText(sink, text);
          }
        }
        if (trackRegions && !context.insideLandmark && !context.ariaHidden && text.trim().length > 0) {
          otherHasExposedText = true;
        }
        continue;
      }
      if (!(node instanceof Element)) {
        continue;
      }
      const tagName = tagNameOf(node);
      if (skippedTags.has(tagName)) {
        continue;
      }
      const display = window.getComputedStyle(node).display;
      // display:none の子孫は描画されない（子で上書きできない）ので、たどらない。
      if (display === 'none') {
        continue;
      }
      const ariaHidden = context.ariaHidden || isAriaHiddenElement(node);
      const landmarkKind = node === root ? undefined : landmarkKinds[tagName];
      let childContext: WalkContext = context.ariaHidden === ariaHidden ? context : { ...context, ariaHidden };
      if (trackRegions && landmarkKind !== undefined) {
        const region: RegionAccumulator = {
          kind: landmarkKind,
          sink: createSink(),
          ariaHidden,
        };
        regions.push(region);
        childContext = { regions: [...context.regions, region], insideLandmark: true, ariaHidden };
      }
      const separated = tagName === 'BR' || !inlineDisplays.has(display);
      if (separated) {
        stack.push({ kind: 'separator', context });
      }
      const children = renderedChildren(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'node', node: children[index] as Node, context: childContext });
      }
      if (separated) {
        sinksFor(context).forEach(appendSeparator);
      }
    }
    return { all, other, ariaHiddenSink, otherHasExposedText, regions };
  };
  const visibleTextOf = (element: Element): string => finishSink(walkVisibleText(element, false).all);

  const titleElement = queryDocument('title');
  const metaDescription = queryDocument('meta[name="description" i]');
  const canonical = queryDocument('link[rel~="canonical" i]');
  const title = titleElement === null ? null : normalizeWhitespace(titleOf(document));
  const description = metaDescription === null ? null : wholeOf(metaDescription.getAttribute('content'));
  const canonicalUrl = canonical === null ? null : wholeOf(canonical.getAttribute('href'));
  const lang = wholeOf(documentElementOf(document).getAttribute('lang'));

  // COV-6: 一覧は、この回の位置（`cursor`）から部分の件数（`partSize`）までを返し、ページの中の全体の件数を添える。テキストも同じく長さで分ける。
  const listPart = <T>(items: readonly T[], offset: number) => ({ items: items.slice(offset, offset + partSize), total: items.length });
  const textPart = (text: string, offset: number) => ({ slice: text.slice(offset, offset + textPartLength), total: text.length });

  // 見出しは、可視テキストと同じ可視判定と走査で集め、見えるものだけを記録する。見出しの要素が可視であるか、
  // 可視テキストがあれば（visibility:hidden の見出しの中に visibility:visible の子がある場合）、見える見出しとする。
  // display:none の祖先の中の見出しは、どちらにも当たらない。
  const visibleHeadings: HeadingEvidence[] = [];
  for (const element of queryDocumentAll('h1, h2, h3, h4, h5, h6')) {
    const text = visibleTextOf(element);
    if (!isVisible(element) && text.length === 0) {
      continue;
    }
    visibleHeadings.push({ level: Number.parseInt(element.tagName.slice(1), 10), text, truncated: false });
  }

  const body = documentBody;
  const walk = body === null ? null : walkVisibleText(body, true);
  const allText = walk === null ? '' : finishSink(walk.all);
  const landmarkRegions = (walk?.regions ?? [])
    .map((region): SemanticRegionEvidence => ({ kind: region.kind, text: finishSink(region.sink), ariaHidden: region.ariaHidden, truncated: false }))
    .filter((region) => region.text.length > 0);
  const otherText = walk === null ? '' : finishSink(walk.other);
  const source: VisibleTextSource = landmarkRegions.length > 0 ? 'SEMANTIC_LANDMARKS' : 'BODY_FALLBACK';
  // landmark の区分（文書の順）と、最後に `other` の区分。landmark の区分がなければ区分は記録しない（`BODY_FALLBACK`）。
  const regions: SemanticRegionEvidence[] = source === 'BODY_FALLBACK'
    ? []
    : otherText.length > 0
      ? [...landmarkRegions, { kind: 'other', text: otherText, ariaHidden: !(walk?.otherHasExposedText ?? false), truncated: false }]
      : landmarkRegions;
  const ariaHiddenText = walk === null ? '' : finishSink(walk.ariaHiddenSink);

  const imageElements = [...imagesOf(document)];
  const images = imageElements.slice(cursor.images, cursor.images + partSize).map((image): ImageDomEvidence => {
    const resolved = image.currentSrc.length > 0 ? image.currentSrc : image.src;
    return {
      src: wholeOf(image.getAttribute('src')),
      resolvedUrl: resolved.length > 0 ? resolved : null,
      alt: wholeOf(image.getAttribute('alt')),
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      truncated: false,
    };
  });

  const submitControlCandidates = [...queryDocumentAll('button, input')]
    .filter((control): control is HTMLButtonElement | HTMLInputElement => (
      control instanceof HTMLButtonElement || control instanceof HTMLInputElement
    ))
    .filter((control) => (submitControlTypes as readonly string[]).includes(control.type));
  type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  // 入力欄（input・select・textarea）。値を入力しない input（submit・image・button・reset）は除く。
  const isField = (element: Element): element is FieldElement => (
    (element instanceof HTMLInputElement && !['submit', 'image', 'button', 'reset'].includes(element.type))
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
  );
  const fieldEvidence = (field: FieldElement): FormFieldEvidence => {
    const labels = [...(field.labels ?? [])]
      .map(visibleTextOf)
      .filter((label) => label.length > 0);
    return {
      type: field instanceof HTMLTextAreaElement ? 'textarea' : field.type,
      name: normalizeWhitespace(field.getAttribute('name')),
      required: field.required,
      visible: isVisible(field),
      labels,
      hasAriaLabel: hasNonBlankAttribute(field, 'aria-label'),
      hasAriaLabelledby: hasNonBlankAttribute(field, 'aria-labelledby'),
      hasTitle: hasNonBlankAttribute(field, 'title'),
      truncated: false,
    };
  };
  const formElements = [...formsOf(document)];
  const forms = formElements.slice(cursor.forms, cursor.forms + partSize).map((form): FormDomEvidence => {
    const fields = [...formElementsOf(form)].filter(isField).map(fieldEvidence);
    const submitControls = submitControlCandidates
      .filter((control) => control.form === form)
      .map((control): SubmitControlEvidence => {
        const rawText = control instanceof HTMLButtonElement ? control.innerText : control.value;
        return {
          type: control.type === 'image' ? 'image' : 'submit',
          name: normalizeWhitespace(control.getAttribute('name')),
          value: normalizeWhitespace(control.value),
          text: normalizeWhitespace(rawText),
          truncated: false,
        };
      });
    return {
      method: normalizeWhitespace(formMethodOf(form)).toLowerCase(),
      // URL-LEN: action は切り詰めない。
      action: normalizeWhitespace(getAttributeOf(form, 'action')),
      fields,
      submitControls,
      omittedFieldCount: 0,
      omittedSubmitControlCount: 0,
      truncated: false,
    };
  });

  // `forms` に記録されない入力欄（R4 の N2）。どの form にも属さない入力欄と、open な shadow root の中の入力欄（R'2 の m4。
  // shadow root の中の form は `document.forms` に含まれない）を、文書の順（shadow root の中は host の位置）で記録する。
  const unassociatedFieldElements: FieldElement[] = [];
  const collectUnassociatedFields = (root: Document | ShadowRoot, insideShadowRoot: boolean): void => {
    for (const element of root instanceof Document ? queryDocumentAll('*') : root.querySelectorAll('*')) {
      if (isField(element) && (insideShadowRoot || element.form === null)) {
        unassociatedFieldElements.push(element);
      }
      const shadowRoot = shadowRootOf(element);
      if (shadowRoot !== null) {
        collectUnassociatedFields(shadowRoot, true);
      }
    }
  };
  collectUnassociatedFields(document, false);
  const unassociatedFields = unassociatedFieldElements
    .slice(cursor.unassociatedFields, cursor.unassociatedFields + partSize)
    .map(fieldEvidence);

  // 重複している id。空の id は id として扱わない。
  const idCounts = new Map<string, number>();
  for (const element of queryDocumentAll('[id]')) {
    const id = idOf(element);
    if (id.length > 0) {
      idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
    }
  }
  const duplicatedIds = [...idCounts].filter(([, count]) => count > 1);
  const duplicateIds = duplicatedIds.map(([id, count]): DuplicateIdEvidence => ({ id, count, truncated: false }));

  // EV-1・EV-3: 見えている読み込み中の表示の数（読み方は部品の 1 か所。落ち着きの待ちと同じ）。
  const loadingIndicators: LoadingIndicatorEvidence = R.loadingIndicatorsIn(visibilityOptions);

  return {
    scrollPosition,
    loadingIndicators,
    title,
    metaDescription: description,
    canonicalUrl,
    lang,
    // LZ-3b: 文書の項目は切り詰めない（項目ごとの印は前の記録の形のために残し、いつも偽）。
    documentFields: { title: false, metaDescription: false, canonicalUrl: false, lang: false },
    source,
    headings: listPart(visibleHeadings, cursor.headings),
    images: { items: images, total: imageElements.length },
    forms: { items: forms, total: formElements.length },
    unassociatedFields: { items: unassociatedFields, total: unassociatedFieldElements.length },
    duplicateIds: listPart(duplicateIds, cursor.duplicateIds),
    regions: listPart(regions, cursor.regions),
    text: textPart(allText, cursor.text),
    ariaHiddenText: textPart(ariaHiddenText, cursor.ariaHiddenText),
  };
}
const collectDomEvidenceInPage = composeInPage(collectDomEvidenceReader);

/**
 * 読み取り専用のドキュメント観測結果（Link 以外）を収集する。
 * Link は link の Evidence（`discoverLinks()` の結果）の1か所だけに置き、DOM の Evidence には複製しない（R'2 の m3）。
 * 可視テキストと見出しの「目に見えるか」の判定は `checkVisibility(VISIBILITY_CHECK_OPTIONS)` だけで行う。テキストノードは、
 * `display: contents` ではない最も近い祖先の要素で判定する。
 * `aria-hidden` は可視判定に使わず、別の項目（`ariaHidden`、`ariaHiddenText`）として記録する。
 * COV-6: 件数と本文の長さで打ち切らない。ページの中の読み取りを、一覧ごとに `DOM_COLLECTION_PART_SIZE` 件、テキストごとに `DOM_TEXT_PART_LENGTH` 字に
 * 分け、続きの位置から読み直して（`readInParts`）全部を 1 つの記録にまとめる。分けた回数を `collectedInParts` に残す。
 */
export async function collectDomEvidence(page: Page, pageId: PageId): Promise<DomEvidence> {
  const parts = await readInParts(FIRST_DOM_PART_CURSOR, async (cursor: DomPartCursor) => {
    // ブラウザ内では import できないため、送信のコントロールの `type` の一覧（`SUBMIT_CONTROL_TYPES`）は引数で渡す。
    const part = await page.evaluate(collectDomEvidenceInPage, {
      visibilityOptions: VISIBILITY_CHECK_OPTIONS,
      submitControlTypes: SUBMIT_CONTROL_TYPES,
      cursor,
      partSize: DOM_COLLECTION_PART_SIZE,
      textPartLength: DOM_TEXT_PART_LENGTH,
    });
    validateRawDomPart(part);
    return { part, next: nextDomPartCursor(cursor, part) };
  });

  // AUD-7: 画面の誤りの表示の手がかりも、同じ時点で読む（読めなければ `FAILED`。DOM の記録は止めない）。
  return Object.freeze({ ...assembleDomEvidence(parts, pageId), errorDisplay: await collectErrorDisplay(page) });
}
