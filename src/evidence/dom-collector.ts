import type { Page } from 'playwright';
import type { PageId } from '../core/contracts.js';
import { SUBMIT_CONTROL_TYPES } from '../core/evidence-types.js';
import type {
  DomEvidence,
  DomTruncationEvidence,
  DuplicateIdEvidence,
  FormDomEvidence,
  FormFieldEvidence,
  HeadingEvidence,
  ImageDomEvidence,
  ScrollPosition,
  SemanticRegionEvidence,
  SemanticRegionKind,
  SubmitControlEvidence,
  VisibleTextEvidence,
} from '../core/evidence-types.js';
import { MAX_URL_LENGTH } from '../core/limits.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';

/** DOM の Evidence の上限。超えた分は、件数（`omitted...Count`）か印（`truncated`）を Evidence に残す。 */
export const DOM_LIMITS = Object.freeze({
  /** 可視テキスト全体と、aria-hidden の中の可視テキストの最大長（UTF-16 のコード単位）。 */
  maxVisibleTextLength: 100_000,
  /** 1つの区分（landmark・その他）の可視テキストの最大長。 */
  maxRegionTextLength: 10_000,
  /** 記録する landmark の区分の最大件数（「その他」の区分は含めない）。 */
  maxRegions: 100,
  /** 可視テキストを集めるときにたどるノードの最大数。超えた場合は、そこで集めるのをやめる。 */
  maxTextWalkNodes: 100_000,
  maxHeadings: 500,
  maxHeadingTextLength: 1_024,
  /** title・meta description・lang の最大長。 */
  maxDocumentTextLength: 1_024,
  /** canonical・画像のURL・form の action の最大長。 */
  maxUrlLength: MAX_URL_LENGTH,
  maxImages: 500,
  maxAltLength: 1_024,
  maxForms: 100,
  maxFieldsPerForm: 200,
  /** 記録する、どの form にも属さない入力欄の最大件数。 */
  maxUnassociatedFields: 200,
  maxSubmitControlsPerForm: 50,
  maxLabelsPerField: 10,
  maxLabelTextLength: 1_024,
  /** 入力欄の type・name、送信ボタンの name・value・text、form の method の最大長。 */
  maxAttributeLength: 1_024,
  maxDuplicateIds: 100,
  maxIdLength: 256,
});

interface RawDomEvidence {
  readonly scrollPosition: ScrollPosition;
  readonly title: string | null;
  readonly metaDescription: string | null;
  readonly canonicalUrl: string | null;
  readonly lang: string | null;
  readonly headings: readonly HeadingEvidence[];
  readonly visibleText: VisibleTextEvidence;
  readonly images: readonly ImageDomEvidence[];
  readonly forms: readonly FormDomEvidence[];
  readonly unassociatedFields: readonly FormFieldEvidence[];
  readonly duplicateIds: readonly DuplicateIdEvidence[];
  readonly truncation: DomTruncationEvidence;
}

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
  assertBoundedText(field.type, DOM_LIMITS.maxAttributeLength, `${name}.type`);
  assertBoundedText(field.name, DOM_LIMITS.maxAttributeLength, `${name}.name`);
  if (typeof field.visible !== 'boolean') {
    throw new Error(`Invalid browser DOM flag: ${name}.visible`);
  }
  assertBoundedList(field.labels, DOM_LIMITS.maxLabelsPerField, `${name}.labels`);
  field.labels.forEach((label, labelIndex) => {
    assertBoundedText(label, DOM_LIMITS.maxLabelTextLength, `${name}.labels[${labelIndex}]`);
  });
}

function freezeField(field: FormFieldEvidence): FormFieldEvidence {
  return Object.freeze({ ...field, labels: Object.freeze([...field.labels]) });
}

/** ブラウザから受け取った値が上限の範囲にあることを確かめる。ページが組み込みの関数を書き換えた場合に備える。 */
function validateRawDomEvidence(raw: RawDomEvidence): void {
  if (!Number.isFinite(raw.scrollPosition.scrollX) || !Number.isFinite(raw.scrollPosition.scrollY)) {
    throw new Error('Invalid browser DOM scroll position');
  }
  assertBoundedText(raw.title, DOM_LIMITS.maxDocumentTextLength, 'title');
  assertBoundedText(raw.metaDescription, DOM_LIMITS.maxDocumentTextLength, 'metaDescription');
  assertBoundedText(raw.canonicalUrl, DOM_LIMITS.maxUrlLength, 'canonicalUrl');
  assertBoundedText(raw.lang, DOM_LIMITS.maxDocumentTextLength, 'lang');
  assertBoundedList(raw.headings, DOM_LIMITS.maxHeadings, 'headings');
  raw.headings.forEach((heading, index) => {
    assertBoundedText(heading.text, DOM_LIMITS.maxHeadingTextLength, `headings[${index}]`);
  });
  assertBoundedText(raw.visibleText.text, DOM_LIMITS.maxVisibleTextLength, 'visibleText.text');
  assertBoundedText(raw.visibleText.ariaHiddenText, DOM_LIMITS.maxVisibleTextLength, 'visibleText.ariaHiddenText');
  if (typeof raw.visibleText.nodeLimitReached !== 'boolean') {
    throw new Error('Invalid browser DOM flag: visibleText.nodeLimitReached');
  }
  // landmark の区分の上限に、`other` の区分の1件を加える。
  assertBoundedList(raw.visibleText.regions, DOM_LIMITS.maxRegions + 1, 'visibleText.regions');
  assertCount(raw.visibleText.omittedRegionCount, 'visibleText.omittedRegionCount');
  raw.visibleText.regions.forEach((region, index) => {
    assertBoundedText(region.text, DOM_LIMITS.maxRegionTextLength, `visibleText.regions[${index}]`);
  });
  assertBoundedList(raw.images, DOM_LIMITS.maxImages, 'images');
  raw.images.forEach((image, index) => {
    assertBoundedText(image.src, DOM_LIMITS.maxUrlLength, `images[${index}].src`);
    assertBoundedText(image.resolvedUrl, DOM_LIMITS.maxUrlLength, `images[${index}].resolvedUrl`);
    assertBoundedText(image.alt, DOM_LIMITS.maxAltLength, `images[${index}].alt`);
  });
  assertBoundedList(raw.forms, DOM_LIMITS.maxForms, 'forms');
  raw.forms.forEach((form, formIndex) => {
    assertBoundedText(form.method, DOM_LIMITS.maxAttributeLength, `forms[${formIndex}].method`);
    assertBoundedText(form.action, DOM_LIMITS.maxUrlLength, `forms[${formIndex}].action`);
    assertCount(form.omittedFieldCount, `forms[${formIndex}].omittedFieldCount`);
    assertCount(form.omittedSubmitControlCount, `forms[${formIndex}].omittedSubmitControlCount`);
    assertBoundedList(form.fields, DOM_LIMITS.maxFieldsPerForm, `forms[${formIndex}].fields`);
    form.fields.forEach((field, index) => {
      validateField(field, `forms[${formIndex}].fields[${index}]`);
    });
    assertBoundedList(form.submitControls, DOM_LIMITS.maxSubmitControlsPerForm, `forms[${formIndex}].submitControls`);
    form.submitControls.forEach((control, index) => {
      const name = `forms[${formIndex}].submitControls[${index}]`;
      assertBoundedText(control.name, DOM_LIMITS.maxAttributeLength, `${name}.name`);
      assertBoundedText(control.value, DOM_LIMITS.maxAttributeLength, `${name}.value`);
      assertBoundedText(control.text, DOM_LIMITS.maxAttributeLength, `${name}.text`);
    });
  });
  assertBoundedList(raw.unassociatedFields, DOM_LIMITS.maxUnassociatedFields, 'unassociatedFields');
  raw.unassociatedFields.forEach((field, index) => {
    validateField(field, `unassociatedFields[${index}]`);
  });
  assertBoundedList(raw.duplicateIds, DOM_LIMITS.maxDuplicateIds, 'duplicateIds');
  raw.duplicateIds.forEach((duplicate, index) => {
    assertBoundedText(duplicate.id, DOM_LIMITS.maxIdLength, `duplicateIds[${index}].id`);
    if (!Number.isSafeInteger(duplicate.count) || duplicate.count < 2) {
      throw new Error(`Invalid browser DOM duplicate id count: ${index}`);
    }
  });
  const { documentFields } = raw.truncation;
  for (const [field, truncated] of [
    ['title', documentFields.title],
    ['metaDescription', documentFields.metaDescription],
    ['canonicalUrl', documentFields.canonicalUrl],
    ['lang', documentFields.lang],
  ] as const) {
    if (typeof truncated !== 'boolean') {
      throw new Error(`Invalid browser DOM flag: truncation.documentFields.${field}`);
    }
  }
  assertCount(raw.truncation.omittedHeadingCount, 'truncation.omittedHeadingCount');
  assertCount(raw.truncation.omittedImageCount, 'truncation.omittedImageCount');
  assertCount(raw.truncation.omittedFormCount, 'truncation.omittedFormCount');
  assertCount(raw.truncation.omittedUnassociatedFieldCount, 'truncation.omittedUnassociatedFieldCount');
  assertCount(raw.truncation.omittedDuplicateIdCount, 'truncation.omittedDuplicateIdCount');
}

function freezeDomEvidence(raw: RawDomEvidence, pageId: PageId): DomEvidence {
  validateRawDomEvidence(raw);
  const headings = Object.freeze(raw.headings.map((heading) => Object.freeze({ ...heading })));
  const regions = Object.freeze(raw.visibleText.regions.map((region) => Object.freeze({ ...region })));
  const images = Object.freeze(raw.images.map((image) => Object.freeze({ ...image })));
  const forms = Object.freeze(raw.forms.map((form) => Object.freeze({
    ...form,
    fields: Object.freeze(form.fields.map(freezeField)),
    submitControls: Object.freeze(form.submitControls.map((control) => Object.freeze({ ...control }))),
  })));
  const unassociatedFields = Object.freeze(raw.unassociatedFields.map(freezeField));
  const duplicateIds = Object.freeze(raw.duplicateIds.map((duplicate) => Object.freeze({ ...duplicate })));

  return Object.freeze({
    pageId,
    scrollPosition: Object.freeze({ scrollX: raw.scrollPosition.scrollX, scrollY: raw.scrollPosition.scrollY }),
    title: raw.title,
    metaDescription: raw.metaDescription,
    canonicalUrl: raw.canonicalUrl,
    lang: raw.lang,
    headings,
    visibleText: Object.freeze({ ...raw.visibleText, regions }),
    images,
    forms,
    unassociatedFields,
    duplicateIds,
    truncation: Object.freeze({
      ...raw.truncation,
      documentFields: Object.freeze({
        title: raw.truncation.documentFields.title,
        metaDescription: raw.truncation.documentFields.metaDescription,
        canonicalUrl: raw.truncation.documentFields.canonicalUrl,
        lang: raw.truncation.documentFields.lang,
      }),
    }),
  });
}

/**
 * 読み取り専用のドキュメント観測結果（Link 以外）を収集する。
 * Link は link の Evidence（`discoverLinks()` の結果）の1か所だけに置き、DOM の Evidence には複製しない（R'2 の m3）。
 * 可視テキストと見出しの「目に見えるか」の判定は `checkVisibility(VISIBILITY_CHECK_OPTIONS)` だけで行う。テキストノードは、
 * `display: contents` ではない最も近い祖先の要素で判定する。
 * `aria-hidden` は可視判定に使わず、別の項目（`ariaHidden`、`ariaHiddenText`）として記録する。
 */
export async function collectDomEvidence(page: Page, pageId: PageId): Promise<DomEvidence> {
  // ブラウザ内では import できないため、送信のコントロールの `type` の一覧（`SUBMIT_CONTROL_TYPES`）は引数で渡す。
  const raw = await page.evaluate(({ limits, visibilityOptions, submitControlTypes }): RawDomEvidence => {
    // 文書のスクロール位置（`ScrollPosition` の定義）。`scrollingElement` ではない body のスクロール量を含める。
    const scrollingRoot = document.scrollingElement ?? document.documentElement;
    const separateScrollBody = document.body !== null && document.body !== scrollingRoot ? document.body : null;
    const scrollPosition = {
      scrollX: window.scrollX + (separateScrollBody?.scrollLeft ?? 0),
      scrollY: window.scrollY + (separateScrollBody?.scrollTop ?? 0),
    };
    interface Bounded {
      readonly text: string;
      readonly truncated: boolean;
    }
    const normalizeWhitespace = (value: string | null): string => value?.replace(/\s+/gu, ' ').trim() ?? '';
    const bound = (value: string, max: number): Bounded => (
      value.length > max ? { text: value.slice(0, max), truncated: true } : { text: value, truncated: false }
    );
    const boundNullable = (value: string | null, max: number): { readonly text: string | null; readonly truncated: boolean } => (
      value === null ? { text: null, truncated: false } : bound(normalizeWhitespace(value), max)
    );
    const hasNonBlankAttribute = (element: Element, name: string): boolean => (
      normalizeWhitespace(element.getAttribute(name)).length > 0
    );
    const isAriaHiddenElement = (element: Element): boolean => element.getAttribute('aria-hidden') === 'true';

    // 描画上の親（slot に割り当てられたノードは slot、shadow root の直下は host）。
    const flatTreeParent = (node: Node): Element | null => {
      const slot = (node as Element | Text).assignedSlot ?? null;
      if (slot !== null) {
        return slot;
      }
      if (node.parentElement !== null) {
        return node.parentElement;
      }
      return node.parentNode instanceof ShadowRoot ? node.parentNode.host : null;
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
          && boxed.checkVisibility(boxlessVisibilityOptions)
          && (!visibilityOptions.visibilityProperty || style.visibility === 'visible');
      } else {
        visible = element.checkVisibility(visibilityOptions);
      }
      visibilityCache.set(element, visible);
      return visible;
    };

    // テキストの蓄積。区切りの空白は重ねず、長さの上限で切り詰めて印を付ける。
    interface TextSink {
      readonly parts: string[];
      length: number;
      readonly max: number;
      truncated: boolean;
      lastWasSeparator: boolean;
    }
    const createSink = (max: number): TextSink => ({ parts: [], length: 0, max, truncated: false, lastWasSeparator: true });
    const appendText = (sink: TextSink, text: string): void => {
      if (sink.truncated || text.length === 0) {
        return;
      }
      const remaining = sink.max - sink.length;
      if (text.length > remaining) {
        sink.parts.push(text.slice(0, remaining));
        sink.length = sink.max;
        sink.truncated = true;
        return;
      }
      sink.parts.push(text);
      sink.length += text.length;
      sink.lastWasSeparator = text.endsWith(' ');
    };
    const appendSeparator = (sink: TextSink): void => {
      if (!sink.lastWasSeparator) {
        appendText(sink, ' ');
        sink.lastWasSeparator = true;
      }
    };
    const finishSink = (sink: TextSink): Bounded => {
      const text = normalizeWhitespace(sink.parts.join(''));
      return { text: text.slice(0, sink.max), truncated: sink.truncated };
    };

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
      if (element.shadowRoot !== null) {
        return [...element.shadowRoot.childNodes];
      }
      if (element instanceof HTMLSlotElement) {
        const assigned = element.assignedNodes({ flatten: true });
        return assigned.length > 0 ? assigned : [...element.childNodes];
      }
      return [...element.childNodes];
    };

    interface WalkResult {
      readonly all: TextSink;
      readonly other: TextSink;
      readonly ariaHiddenSink: TextSink;
      readonly otherHasExposedText: boolean;
      readonly regions: readonly RegionAccumulator[];
      readonly budgetExceeded: boolean;
    }
    /** `root` の中の可視テキストを、文書の順に、区分ごとに集める。 */
    const walkVisibleText = (root: Element, trackRegions: boolean, maxLength: number): WalkResult => {
      const all = createSink(maxLength);
      const other = createSink(limits.maxRegionTextLength);
      const ariaHiddenSink = createSink(limits.maxVisibleTextLength);
      const regions: RegionAccumulator[] = [];
      let otherHasExposedText = false;
      let visited = 0;
      let budgetExceeded = false;
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
        ariaHidden: root.closest('[aria-hidden="true"]') !== null,
      };
      const stack: WalkItem[] = [{ kind: 'node', node: root, context: rootContext }];
      while (stack.length > 0 && !all.truncated) {
        const item = stack.pop() as WalkItem;
        if (item.kind === 'separator') {
          sinksFor(item.context).forEach(appendSeparator);
          continue;
        }
        visited += 1;
        if (visited > limits.maxTextWalkNodes) {
          budgetExceeded = true;
          break;
        }
        const { node, context } = item;
        if (node.nodeType === Node.TEXT_NODE) {
          const parent = node.parentElement ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
          const renderedParent = flatTreeParent(node);
          if (
            parent === null
            || renderedParent === null
            || skippedTags.has(parent.tagName)
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
        if (!(node instanceof Element) || skippedTags.has(node.tagName)) {
          continue;
        }
        const display = window.getComputedStyle(node).display;
        // display:none の子孫は描画されない（子で上書きできない）ので、たどらない。
        if (display === 'none') {
          continue;
        }
        const ariaHidden = context.ariaHidden || isAriaHiddenElement(node);
        const landmarkKind = node === root ? undefined : landmarkKinds[node.tagName];
        let childContext: WalkContext = context.ariaHidden === ariaHidden ? context : { ...context, ariaHidden };
        if (trackRegions && landmarkKind !== undefined) {
          const region: RegionAccumulator = {
            kind: landmarkKind,
            sink: createSink(limits.maxRegionTextLength),
            ariaHidden,
          };
          regions.push(region);
          childContext = { regions: [...context.regions, region], insideLandmark: true, ariaHidden };
        }
        const separated = node.tagName === 'BR' || !inlineDisplays.has(display);
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
      return { all, other, ariaHiddenSink, otherHasExposedText, regions, budgetExceeded };
    };
    const visibleTextOf = (element: Element, maxLength: number): Bounded => {
      const result = walkVisibleText(element, false, maxLength);
      const text = finishSink(result.all);
      return { text: text.text, truncated: text.truncated || result.budgetExceeded };
    };

    const titleElement = document.querySelector('title');
    const metaDescription = document.querySelector('meta[name="description" i]');
    const canonical = document.querySelector('link[rel~="canonical" i]');
    const title = titleElement === null
      ? { text: null, truncated: false }
      : bound(normalizeWhitespace(document.title), limits.maxDocumentTextLength);
    const description = metaDescription === null
      ? { text: null, truncated: false }
      : boundNullable(metaDescription.getAttribute('content'), limits.maxDocumentTextLength);
    const canonicalUrl = canonical === null
      ? { text: null, truncated: false }
      : boundNullable(canonical.getAttribute('href'), limits.maxUrlLength);
    const lang = boundNullable(document.documentElement.getAttribute('lang'), limits.maxDocumentTextLength);

    // 見出しは、可視テキストと同じ可視判定と走査で集め、見えるものだけを記録する。見出しの要素が可視であるか、
    // 可視テキストがあれば（visibility:hidden の見出しの中に visibility:visible の子がある場合）、見える見出しとする。
    // display:none の祖先の中の見出しは、どちらにも当たらない。
    const visibleHeadings: HeadingEvidence[] = [];
    let visibleHeadingCount = 0;
    for (const element of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const text = visibleTextOf(element, limits.maxHeadingTextLength);
      if (!isVisible(element) && text.text.length === 0) {
        continue;
      }
      visibleHeadingCount += 1;
      if (visibleHeadings.length < limits.maxHeadings) {
        visibleHeadings.push({ level: Number.parseInt(element.tagName.slice(1), 10), text: text.text, truncated: text.truncated });
      }
    }
    const headings = visibleHeadings;

    const body = document.body;
    const walk = body === null ? null : walkVisibleText(body, true, limits.maxVisibleTextLength);
    const allText = walk === null ? { text: '', truncated: false } : finishSink(walk.all);
    const landmarkRegions = (walk?.regions ?? [])
      .map((region): SemanticRegionEvidence => {
        const text = finishSink(region.sink);
        return { kind: region.kind, text: text.text, ariaHidden: region.ariaHidden, truncated: text.truncated };
      })
      .filter((region) => region.text.length > 0);
    const otherText = walk === null ? { text: '', truncated: false } : finishSink(walk.other);
    const retainedLandmarkRegions = landmarkRegions.slice(0, limits.maxRegions);
    const regions: SemanticRegionEvidence[] = otherText.text.length > 0
      ? [
          ...retainedLandmarkRegions,
          {
            kind: 'other',
            text: otherText.text,
            ariaHidden: !(walk?.otherHasExposedText ?? false),
            truncated: otherText.truncated,
          },
        ]
      : retainedLandmarkRegions;
    const ariaHiddenText = walk === null ? { text: '', truncated: false } : finishSink(walk.ariaHiddenSink);
    // 文字数による切り詰め（`truncated`）と、ノード数の上限（`nodeLimitReached`）は、別の印で記録する（R4 の M2）。
    const nodeLimitReached = walk?.budgetExceeded ?? false;
    const visibleText: VisibleTextEvidence = landmarkRegions.length > 0
      ? {
          source: 'SEMANTIC_LANDMARKS',
          text: allText.text,
          truncated: allText.truncated,
          nodeLimitReached,
          ariaHiddenText: ariaHiddenText.text,
          regions,
          omittedRegionCount: landmarkRegions.length - retainedLandmarkRegions.length,
        }
      : {
          source: 'BODY_FALLBACK',
          text: allText.text,
          truncated: allText.truncated,
          nodeLimitReached,
          ariaHiddenText: ariaHiddenText.text,
          regions: [],
          omittedRegionCount: 0,
        };

    const imageElements = [...document.images];
    const images = imageElements.slice(0, limits.maxImages).map((image): ImageDomEvidence => {
      const src = boundNullable(image.getAttribute('src'), limits.maxUrlLength);
      const resolved = image.currentSrc.length > 0 ? image.currentSrc : image.src;
      const resolvedUrl = resolved.length > 0 ? bound(resolved, limits.maxUrlLength) : { text: null, truncated: false };
      const alt = boundNullable(image.getAttribute('alt'), limits.maxAltLength);
      return {
        src: src.text,
        resolvedUrl: resolvedUrl.text,
        alt: alt.text,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        truncated: src.truncated || resolvedUrl.truncated || alt.truncated,
      };
    });

    const submitControlCandidates = [...document.querySelectorAll('button, input')]
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
      const type = bound(field instanceof HTMLTextAreaElement ? 'textarea' : field.type, limits.maxAttributeLength);
      const name = bound(normalizeWhitespace(field.getAttribute('name')), limits.maxAttributeLength);
      const labelElements = [...(field.labels ?? [])];
      let labelsTruncated = labelElements.length > limits.maxLabelsPerField;
      const labels = labelElements
        .slice(0, limits.maxLabelsPerField)
        .map((label) => {
          const text = visibleTextOf(label, limits.maxLabelTextLength);
          labelsTruncated ||= text.truncated;
          return text.text;
        })
        .filter((label) => label.length > 0);
      return {
        type: type.text,
        name: name.text,
        required: field.required,
        visible: isVisible(field),
        labels,
        hasAriaLabel: hasNonBlankAttribute(field, 'aria-label'),
        hasAriaLabelledby: hasNonBlankAttribute(field, 'aria-labelledby'),
        hasTitle: hasNonBlankAttribute(field, 'title'),
        truncated: type.truncated || name.truncated || labelsTruncated,
      };
    };
    const formElements = [...document.forms];
    const forms = formElements.slice(0, limits.maxForms).map((form): FormDomEvidence => {
      const fieldElements = [...form.elements].filter(isField);
      const fields = fieldElements.slice(0, limits.maxFieldsPerForm).map(fieldEvidence);
      const ownedSubmitControls = submitControlCandidates.filter((control) => control.form === form);
      const submitControls = ownedSubmitControls
        .slice(0, limits.maxSubmitControlsPerForm)
        .map((control): SubmitControlEvidence => {
          const rawText = control instanceof HTMLButtonElement ? control.innerText : control.value;
          const name = bound(normalizeWhitespace(control.getAttribute('name')), limits.maxAttributeLength);
          const value = bound(normalizeWhitespace(control.value), limits.maxAttributeLength);
          const text = bound(normalizeWhitespace(rawText), limits.maxAttributeLength);
          return {
            type: control.type === 'image' ? 'image' : 'submit',
            name: name.text,
            value: value.text,
            text: text.text,
            truncated: name.truncated || value.truncated || text.truncated,
          };
        });
      const method = bound(normalizeWhitespace(form.method).toLowerCase(), limits.maxAttributeLength);
      const action = bound(normalizeWhitespace(form.getAttribute('action')), limits.maxUrlLength);
      return {
        method: method.text,
        action: action.text,
        fields,
        submitControls,
        omittedFieldCount: fieldElements.length - fields.length,
        omittedSubmitControlCount: ownedSubmitControls.length - submitControls.length,
        truncated: method.truncated || action.truncated,
      };
    });

    // `forms` に記録されない入力欄（R4 の N2）。どの form にも属さない入力欄と、open な shadow root の中の入力欄（R'2 の m4。
    // shadow root の中の form は `document.forms` に含まれない）を、文書の順（shadow root の中は host の位置）で、上限までを記録する。
    const unassociatedFieldElements: FieldElement[] = [];
    const collectUnassociatedFields = (root: Document | ShadowRoot, insideShadowRoot: boolean): void => {
      for (const element of root.querySelectorAll('*')) {
        if (isField(element) && (insideShadowRoot || element.form === null)) {
          unassociatedFieldElements.push(element);
        }
        if (element.shadowRoot !== null) {
          collectUnassociatedFields(element.shadowRoot, true);
        }
      }
    };
    collectUnassociatedFields(document, false);
    const unassociatedFields = unassociatedFieldElements.slice(0, limits.maxUnassociatedFields).map(fieldEvidence);

    // 重複している id。空の id は id として扱わない。
    const idCounts = new Map<string, number>();
    for (const element of document.querySelectorAll('[id]')) {
      const id = element.id;
      if (id.length > 0) {
        idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
      }
    }
    const duplicatedIds = [...idCounts].filter(([, count]) => count > 1);
    const duplicateIds = duplicatedIds.slice(0, limits.maxDuplicateIds).map(([id, count]): DuplicateIdEvidence => {
      const bounded = bound(id, limits.maxIdLength);
      return { id: bounded.text, count, truncated: bounded.truncated };
    });

    return {
      scrollPosition,
      title: title.text,
      metaDescription: description.text,
      canonicalUrl: canonicalUrl.text,
      lang: lang.text,
      headings,
      visibleText,
      images,
      forms,
      unassociatedFields,
      duplicateIds,
      truncation: {
        // 項目ごとに記録する（R''2 の m4）。切り詰めた canonical の URL を、Rule が元の URL と取り違えないようにする。
        documentFields: {
          title: title.truncated,
          metaDescription: description.truncated,
          canonicalUrl: canonicalUrl.truncated,
          lang: lang.truncated,
        },
        omittedHeadingCount: visibleHeadingCount - headings.length,
        omittedImageCount: imageElements.length - images.length,
        omittedFormCount: formElements.length - forms.length,
        omittedUnassociatedFieldCount: unassociatedFieldElements.length - unassociatedFields.length,
        omittedDuplicateIdCount: duplicatedIds.length - duplicateIds.length,
      },
    };
  }, { limits: DOM_LIMITS, visibilityOptions: VISIBILITY_CHECK_OPTIONS, submitControlTypes: SUBMIT_CONTROL_TYPES });

  return freezeDomEvidence(raw, pageId);
}
