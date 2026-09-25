import type { ElementHandle, JSHandle, Page } from 'playwright';
import { isNonNegativeSafeInteger, isRecord } from '../core/guards.js';
import { createSha256Fingerprint } from '../core/ids.js';
import { compareCodeUnits, truncateText } from '../core/text.js';
import { VISIBILITY_CHECK_OPTIONS } from '../core/visibility.js';
import { isHttpProtocol } from '../crawl/normalize-url.js';
import { CLASS_ATTRIBUTE_NAME } from '../evidence/interaction-collector.js';
import {
  freezeInteractionCandidate,
  INTERACTION_CANDIDATE_ID_PREFIX,
  INTERACTION_CANDIDATE_LIMITS,
  type InteractionBoundingBox,
  type InteractionCandidate,
  type InteractionHrefKind,
} from '../safety/interaction-policy.js';

export const INTERACTION_CANDIDATE_SELECTOR = [
  'button',
  '[role="button"]',
  '[role="tab"]',
  '[aria-expanded]',
  '[aria-controls]',
  'details > summary',
].join(',');

export type InteractionHandleResolution =
  | { readonly status: 'FOUND'; readonly handle: ElementHandle<Element>; readonly domWorkUsed: number }
  | { readonly status: 'MISSING'; readonly domWorkUsed: number }
  | { readonly status: 'DOM_WORK_BUDGET_REACHED'; readonly domWorkUsed: number };

/**
 * 探索がどこまで完全か。`TEXT_NODE_LIMIT_REACHED` は、テキストのノード上限（`maxTextNodes`）で走査を止めたことを表し、
 * DOM作業量の上限（`DOM_WORK_BUDGET_REACHED`）とは区別する（設計書 2026-09-23 4.5）。
 */
export type InteractionCandidateDiscoveryCompleteness =
  | 'COMPLETE'
  | 'CANDIDATE_LIMIT_REACHED'
  | 'DOM_WORK_BUDGET_REACHED'
  | 'TEXT_NODE_LIMIT_REACHED';

const DISCOVERY_COMPLETENESS_VALUES: readonly InteractionCandidateDiscoveryCompleteness[] = Object.freeze([
  'COMPLETE',
  'CANDIDATE_LIMIT_REACHED',
  'DOM_WORK_BUDGET_REACHED',
  'TEXT_NODE_LIMIT_REACHED',
]);

export interface InteractionCandidateDiscoveryResult {
  readonly candidates: readonly InteractionCandidate[];
  readonly completeness: InteractionCandidateDiscoveryCompleteness;
  readonly domWorkUsed: number;
}

function validatedDomWorkLimit(value: number): number {
  if (!isNonNegativeSafeInteger(value) || value > INTERACTION_CANDIDATE_LIMITS.maxDomWork) {
    throw new Error('Interaction DOM work limit is outside the bounded contract');
  }
  return value;
}

function isDiscoveryCompleteness(value: unknown): value is InteractionCandidateDiscoveryCompleteness {
  return (DISCOVERY_COMPLETENESS_VALUES as readonly unknown[]).includes(value);
}

function validDomWorkCount(value: unknown, maxDomWork: number = INTERACTION_CANDIDATE_LIMITS.maxDomWork): value is number {
  return isNonNegativeSafeInteger(value) && value <= maxDomWork;
}

function resolutionFailure(
  primaryPresent: boolean,
  primary: unknown,
  cleanupErrors: readonly unknown[],
): never {
  if (primaryPresent && cleanupErrors.length === 0) throw primary;
  if (!primaryPresent && cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(
    primaryPresent ? [primary, ...cleanupErrors] : cleanupErrors,
    'Bounded interaction handle resolution failed with cleanup errors',
  );
}

/** ブラウザの中の処理に渡す上限。`maxDomWork` だけを、呼び出しごとの残りの作業量に置き換える。 */
type InteractionProbeLimits = { readonly [K in keyof typeof INTERACTION_CANDIDATE_LIMITS]: number };

/**
 * ブラウザの中の処理（`interactionCandidateProbe`）に渡す入力。`mode` で、何をするかを選ぶ（CC-008）。
 * - `DISCOVER`: 文書の先頭から候補を探し、候補の一覧を返す（`discoverInteractionCandidates`）。
 * - `RESOLVE`: 文書の先頭から数えて `targetOrdinal` 番目の候補の要素を返す（`resolveInteractionCandidateHandle`）。
 * - `INSPECT`: 保持した要素の、今の候補の値と、スクロール・属性・開閉の記録を返す（`inspectInteractionCandidateHandle`）。
 */
type InteractionProbeInput =
  | {
      readonly mode: 'DISCOVER';
      readonly selector: string;
      readonly limits: InteractionProbeLimits;
      readonly visibilityOptions: CheckVisibilityOptions;
    }
  | {
      readonly mode: 'RESOLVE';
      readonly selector: string;
      readonly limits: InteractionProbeLimits;
      readonly targetOrdinal: number;
    }
  | {
      readonly mode: 'INSPECT';
      readonly selector: string;
      readonly limits: InteractionProbeLimits;
      readonly visibilityOptions: CheckVisibilityOptions;
      readonly classAttributeName: string;
    };

/**
 * Interaction の候補を扱う、ブラウザの中の唯一の処理（CC-008）。作業量のカウンタ、要素の走査、テキストの切り詰め、可視判定、
 * アクセシブルネーム、候補の組み立てを、探索・handle の解決・保持した handle の読み取りで共有する。
 * `page.evaluate` などに関数の本体の文字列として渡るので、この関数の外の値（定数・関数）を参照してはいけない。必要な値は入力で渡す。
 * `page.evaluate`・`page.evaluateHandle` は（入力）で呼び、`ElementHandle.evaluate` は（保持した要素, 入力）で呼ぶ。
 */
const interactionCandidateProbe = (
  retainedOrInput: Element | InteractionProbeInput,
  handleInput?: InteractionProbeInput,
) => {
  const input = handleInput ?? (retainedOrInput as InteractionProbeInput);
  const { selector, limits } = input;
  const domWork = {
    used: 0,
    consume(): boolean {
      if (this.used >= limits.maxDomWork) {
        return false;
      }
      this.used += 1;
      return true;
    },
  };
  const textWork = { used: 0, limitReached: false };
  // 走査は、最初の要素を求めたときに始める（INSPECT は、保持した要素が文書にあることを確かめてから走査する）。
  let walker: TreeWalker | null = null;
  const nextElement = (): Element | null => {
    if (walker === null) {
      walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
      return document.documentElement;
    }
    return walker.nextNode() as Element | null;
  };
  // 文書の順に、次の候補の要素を返す。要素1つを調べるのに作業量1、候補に当たったらさらに作業量1を消費する。
  const nextCandidateElement = (): Element | 'END' | 'DOM_WORK_BUDGET_REACHED' => {
    while (true) {
      if (domWork.used >= limits.maxDomWork) {
        return 'DOM_WORK_BUDGET_REACHED';
      }
      const element = nextElement();
      if (element === null) return 'END';
      if (!domWork.consume()) return 'DOM_WORK_BUDGET_REACHED';
      if (!element.matches(selector)) continue;
      if (!domWork.consume()) return 'DOM_WORK_BUDGET_REACHED';
      return element;
    }
  };

  if (input.mode === 'RESOLVE') {
    let candidateOrdinal = 0;
    while (true) {
      const element = nextCandidateElement();
      if (element === 'DOM_WORK_BUDGET_REACHED') {
        return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
      }
      if (element === 'END') {
        return { status: 'MISSING' as const, domWorkUsed: domWork.used };
      }
      if (candidateOrdinal === input.targetOrdinal) {
        return { status: 'FOUND' as const, element, domWorkUsed: domWork.used };
      }
      candidateOrdinal += 1;
    }
  }

  const { visibilityOptions } = input;
  const bounded = (value: string | null, maxLength: number): string | null => (
    value === null ? null : value.slice(0, maxLength)
  );
  const normalizeBounded = (value: string, maxLength: number): string => value
    .slice(0, maxLength * 4)
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
  const boundedDescendantText = (roots: readonly Element[], maxCharacters: number): string | null => {
    let result = '';
    for (const root of roots) {
      if (result.length >= maxCharacters) break;
      if (domWork.used >= limits.maxDomWork) {
        return null;
      }
      const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
      while (result.length < maxCharacters) {
        if (textWork.used >= limits.maxTextNodes) {
          textWork.limitReached = true;
          return null;
        }
        if (domWork.used >= limits.maxDomWork) {
          return null;
        }
        const node = textWalker.nextNode();
        if (node === null) break;
        if (!domWork.consume()) return null;
        textWork.used += 1;
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const textNode = node as Text;
        const remainingCharacters = maxCharacters - result.length;
        result += textNode.substringData(0, Math.min(textNode.length, remainingCharacters));
      }
      if (result.length > 0 && result.length < maxCharacters) result += ' ';
    }
    return result.slice(0, maxCharacters);
  };
  // 可視判定は標準の checkVisibility に共通のオプションで任せる（設計書 2026-09-23 5.5）。
  // 祖先をたどらないので、呼び出し1回につき作業量1を消費する。大きさが0の要素は、見えないものとして扱う。
  const visibility = (subject: Element): boolean | null => {
    if (!domWork.consume()) return null;
    if (!subject.checkVisibility(visibilityOptions)) return false;
    if (domWork.used >= limits.maxDomWork) {
      return null;
    }
    const rect = subject.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const accessibleName = (subject: Element): string | null => {
    const ariaLabel = subject.getAttribute('aria-label');
    if (ariaLabel !== null) return normalizeBounded(ariaLabel, limits.maxTextLength);
    const labelledBy = subject.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const labelRoots: Element[] = [];
      for (const id of labelledBy.slice(0, limits.maxAttributeLength).split(/\s+/u).slice(0, 16)) {
        if (!domWork.consume()) return null;
        const labelRoot = document.getElementById(id);
        if (labelRoot !== null) labelRoots.push(labelRoot);
      }
      const labels = boundedDescendantText(labelRoots, limits.maxTextLength * 4);
      if (labels === null) return null;
      const normalized = normalizeBounded(labels, limits.maxTextLength);
      if (normalized.length > 0) return normalized;
    }
    const title = subject.getAttribute('title');
    if (title !== null) return normalizeBounded(title, limits.maxTextLength);
    const text = boundedDescendantText([subject], limits.maxTextLength * 4);
    return text === null ? null : normalizeBounded(text, limits.maxTextLength);
  };
  // 候補を組み立てられなかった（null）ときの理由。テキストのノードの上限に達したかで分ける（設計書 2026-09-23 4.5）。
  const incompleteStatus = (): 'TEXT_NODE_LIMIT_REACHED' | 'DOM_WORK_BUDGET_REACHED' => (
    textWork.limitReached ? 'TEXT_NODE_LIMIT_REACHED' : 'DOM_WORK_BUDGET_REACHED'
  );
  // 候補の値を組み立てる。作業量かテキストのノードの上限に達したら null を返す（理由は incompleteStatus で分かる）。
  const collectCandidate = (element: Element, ordinal: number): RawInteractionCandidate | null => {
    const htmlElement = element instanceof HTMLElement ? element : null;
    const formControl = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
      ? element
      : null;
    const form = formControl?.form ?? null;
    const ariaControls = bounded(element.getAttribute('aria-controls'), limits.maxAttributeLength);
    let controlled: Element | null = null;
    if (ariaControls !== null) {
      if (!domWork.consume()) return null;
      controlled = document.getElementById(ariaControls);
    }
    const controlledVisible = controlled === null ? null : visibility(controlled);
    if (controlledVisible === null && controlled !== null) return null;
    if (domWork.used >= limits.maxDomWork) {
      return null;
    }
    const name = accessibleName(element);
    if (name === null) return null;
    if (domWork.used >= limits.maxDomWork) {
      return null;
    }
    const text = boundedDescendantText([element], limits.maxTextLength * 4);
    if (text === null) return null;
    if (domWork.used >= limits.maxDomWork) {
      return null;
    }
    const visible = visibility(element);
    if (visible === null) return null;
    if (domWork.used >= limits.maxDomWork) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const pageOffsetX = window.scrollX;
    const pageOffsetY = window.scrollY;
    return {
      ordinal,
      tagName: element.tagName.toLowerCase().slice(0, limits.maxAttributeLength),
      role: bounded(element.getAttribute('role'), limits.maxAttributeLength),
      accessibleName: name,
      normalizedText: normalizeBounded(text, limits.maxTextLength),
      ariaExpanded: bounded(element.getAttribute('aria-expanded'), limits.maxAttributeLength),
      ariaControls,
      ariaSelected: bounded(element.getAttribute('aria-selected'), limits.maxAttributeLength),
      controlledVisible,
      controlledHidden: controlled === null ? null : !controlledVisible,
      formAssociated: form !== null,
      formMethod: form === null ? null : form.method.slice(0, limits.maxAttributeLength),
      formAction: form === null ? null : form.action.slice(0, limits.maxUrlLength),
      rawHref: bounded(element.getAttribute('href'), limits.maxUrlLength + 1),
      documentUrl: location.href.slice(0, limits.maxUrlLength),
      documentOrigin: location.origin.slice(0, limits.maxUrlLength),
      download: element.hasAttribute('download'),
      type: bounded(formControl?.type ?? htmlElement?.getAttribute('type') ?? null, limits.maxAttributeLength),
      disabled: (formControl?.disabled ?? false) || element.getAttribute('aria-disabled') === 'true',
      visible,
      boundingBox: {
        x: rect.x + pageOffsetX,
        y: rect.y + pageOffsetY,
        width: rect.width,
        height: rect.height,
        top: rect.top + pageOffsetY,
        right: rect.right + pageOffsetX,
        bottom: rect.bottom + pageOffsetY,
        left: rect.left + pageOffsetX,
      },
    };
  };

  if (input.mode === 'DISCOVER') {
    const selected: RawInteractionCandidate[] = [];
    let completeness: InteractionCandidateDiscoveryCompleteness = 'COMPLETE';
    while (selected.length < limits.maxCandidates) {
      const element = nextCandidateElement();
      if (element === 'END') break;
      if (element === 'DOM_WORK_BUDGET_REACHED') {
        completeness = 'DOM_WORK_BUDGET_REACHED';
        break;
      }
      const candidate = collectCandidate(element, selected.length);
      if (candidate === null) {
        completeness = incompleteStatus();
        break;
      }
      selected.push(candidate);
    }
    if (selected.length === limits.maxCandidates && completeness === 'COMPLETE') {
      completeness = 'CANDIDATE_LIMIT_REACHED';
    }
    return { candidates: selected, completeness, domWorkUsed: domWork.used };
  }

  // INSPECT: 保持した要素が、今の文書で何番目の候補かを数えてから、その要素の値を読む。
  const { classAttributeName } = input;
  const element = retainedOrInput as Element;
  if (!element.isConnected) return { status: 'DISCONNECTED' as const, domWorkUsed: domWork.used };
  let liveOrdinal = 0;
  let found = false;
  while (true) {
    const candidate = nextCandidateElement();
    if (candidate === 'DOM_WORK_BUDGET_REACHED') {
      return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    }
    if (candidate === 'END') break;
    if (candidate === element) {
      found = true;
      break;
    }
    liveOrdinal += 1;
  }
  if (!found) {
    return { status: 'DISCONNECTED' as const, domWorkUsed: domWork.used };
  }
  if (liveOrdinal > limits.maxOrdinal) {
    return { status: 'CANDIDATE_LIMIT_REACHED' as const, domWorkUsed: domWork.used };
  }
  if (!domWork.consume()) {
    return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
  }
  const raw = collectCandidate(element, liveOrdinal);
  if (raw === null) return { status: incompleteStatus(), domWorkUsed: domWork.used };
  // スクロールする祖先の位置を記録する（設計書 2026-09-23 4.4 の追記）。祖先1つにつき作業量1を消費し、
  // 上限に達したら、判定できない記録（complete: false）にする。open な shadow root と slot をまたいでたどる。
  const layoutParent = (node: Element): Element | null => {
    if (node.assignedSlot !== null) return node.assignedSlot;
    if (node.parentElement !== null) return node.parentElement;
    const parentNode = node.parentNode;
    return parentNode instanceof ShadowRoot ? parentNode.host : null;
  };
  const scrollsContent = (overflow: string): boolean => overflow !== 'visible' && overflow !== 'clip';
  const scrollOffsets: number[] = [];
  let scrollComplete = true;
  for (let ancestor = layoutParent(element); ancestor !== null; ancestor = layoutParent(ancestor)) {
    if (!domWork.consume()) {
      scrollComplete = false;
      break;
    }
    const style = window.getComputedStyle(ancestor);
    if (scrollsContent(style.overflowX) || scrollsContent(style.overflowY)) {
      scrollOffsets.push(ancestor.scrollLeft, ancestor.scrollTop);
    }
  }
  scrollOffsets.push(window.scrollX, window.scrollY);
  // 対象の要素そのものの属性（名前と値）を記録する（設計書 2026-09-23 4.4.1）。子孫の属性は含めない。
  // 属性1つにつき作業量1を消費し、上限に達したら、比べられない記録（complete: false）にする。
  // 値は、class だけを class 専用の上限まで、ほかの属性を maxAttributeLength まで記録する（4.4.1「長い class」、F20b。
  // Node 側の attributeValueLengthLimit と同じ決まり）。
  const attributeEntries: string[] = [];
  let attributesComplete = true;
  const ownAttributes = element.attributes;
  for (let index = 0; index < ownAttributes.length; index += 1) {
    if (!domWork.consume()) {
      attributesComplete = false;
      break;
    }
    const attribute = ownAttributes[index];
    if (attribute === undefined) break;
    const attributeName = attribute.name.slice(0, limits.maxAttributeLength);
    const valueLimit = attributeName === classAttributeName ? limits.maxClassAttributeLength : limits.maxAttributeLength;
    attributeEntries.push(attributeName, attribute.value.slice(0, valueLimit));
  }
  // 対象が details の子の summary なら、親の details の開閉の状態を記録する（設計書 2026-09-23 4.4.1）。
  const parentDetails = element.parentElement;
  const detailsOpen = element.tagName === 'SUMMARY' && parentDetails instanceof HTMLDetailsElement
    ? parentDetails.open
    : null;
  return {
    status: 'CONNECTED' as const,
    domWorkUsed: domWork.used,
    detailsOpen,
    scroll: { complete: scrollComplete, offsets: scrollComplete ? scrollOffsets : [] },
    attributes: { complete: attributesComplete, entries: attributesComplete ? attributeEntries : [] },
    raw,
  };
};

/**
 * `page.evaluate`・`page.evaluateHandle` で渡す入力（`DISCOVER` と `RESOLVE` だけ）。保持した要素がないので、`INSPECT` を受け取ると
 * 例外にならずに誤った結果を返す。そのため、型で受け取れなくする（RC18 の M3）。
 */
export type PageInteractionProbeInput = Extract<InteractionProbeInput, { readonly mode: 'DISCOVER' | 'RESOLVE' }>;
/** `ElementHandle.evaluate` で渡す入力（`INSPECT` だけ）。 */
export type HandleInteractionProbeInput = Extract<InteractionProbeInput, { readonly mode: 'INSPECT' }>;

/** `page.evaluate`・`page.evaluateHandle` に渡す形（入力だけを受け取る）。関数そのものは `interactionCandidateProbe` と同じ。 */
const pageInteractionCandidateProbe = interactionCandidateProbe as (input: PageInteractionProbeInput) => unknown;
/** `ElementHandle.evaluate` に渡す形（保持した要素と入力を受け取る）。関数そのものは `interactionCandidateProbe` と同じ。 */
const handleInteractionCandidateProbe = interactionCandidateProbe as (element: Element, input: HandleInteractionProbeInput) => unknown;

export async function resolveInteractionCandidateHandle(
  page: Page,
  ordinal: number,
  maxDomWork: number = INTERACTION_CANDIDATE_LIMITS.maxDomWork,
): Promise<InteractionHandleResolution> {
  if (!isNonNegativeSafeInteger(ordinal) || ordinal > INTERACTION_CANDIDATE_LIMITS.maxOrdinal) {
    throw new Error('Interaction candidate ordinal is outside the bounded contract');
  }
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 });
  }
  const envelope = await page.evaluateHandle<unknown, PageInteractionProbeInput>(pageInteractionCandidateProbe, {
    mode: 'RESOLVE',
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: { ...INTERACTION_CANDIDATE_LIMITS, maxDomWork: boundedMaxDomWork },
    targetOrdinal: ordinal,
  });

  let properties: Map<string, JSHandle> | undefined;
  let primaryErrorPresent = false;
  let primaryError: unknown;
  let status: InteractionHandleResolution['status'] | undefined;
  let domWorkUsed: number | undefined;
  let elementProperty: JSHandle | undefined;
  let elementHandle: ElementHandle<Element> | null = null;
  try {
    properties = await envelope.getProperties();
    if (!(properties instanceof Map)) {
      throw new Error('Invalid bounded interaction handle resolution envelope');
    }
    const statusHandle = properties.get('status');
    const domWorkHandle = properties.get('domWorkUsed');
    if (statusHandle === undefined || domWorkHandle === undefined) {
      throw new Error('Invalid bounded interaction handle resolution envelope');
    }
    const rawStatus = await statusHandle.jsonValue();
    const rawDomWorkUsed = await domWorkHandle.jsonValue();
    if (rawStatus !== 'FOUND' && rawStatus !== 'MISSING' && rawStatus !== 'DOM_WORK_BUDGET_REACHED') {
      throw new Error('Invalid bounded interaction handle resolution envelope');
    }
    if (!validDomWorkCount(rawDomWorkUsed, boundedMaxDomWork)) {
      throw new Error('Invalid bounded interaction handle resolution envelope');
    }
    status = rawStatus;
    domWorkUsed = rawDomWorkUsed;
    const hasElement = properties.has('element');
    elementProperty = properties.get('element');
    if (status === 'FOUND') {
      if (!hasElement || elementProperty === undefined) {
        throw new Error('Invalid bounded interaction handle resolution envelope');
      }
      elementHandle = elementProperty.asElement() as ElementHandle<Element> | null;
      if (elementHandle === null) {
        throw new Error('Invalid bounded interaction handle resolution envelope');
      }
    } else if (hasElement) {
      throw new Error('Invalid bounded interaction handle resolution envelope');
    }
  } catch (error) {
    primaryErrorPresent = true;
    primaryError = error;
  }

  const prospectiveTransfer = !primaryErrorPresent && status === 'FOUND' && elementHandle !== null;
  const cleanupErrors: unknown[] = [];
  if (properties !== undefined) {
    for (const propertyHandle of properties.values()) {
      if (prospectiveTransfer && propertyHandle === elementProperty) continue;
      try {
        await propertyHandle.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  try {
    await envelope.dispose();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryErrorPresent || cleanupErrors.length > 0) {
    if (prospectiveTransfer && elementProperty !== undefined) {
      try {
        await elementProperty.dispose();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    resolutionFailure(primaryErrorPresent, primaryError, cleanupErrors);
  }
  if (status === 'FOUND' && elementHandle !== null && domWorkUsed !== undefined) {
    return Object.freeze({ status, handle: elementHandle, domWorkUsed });
  }
  if ((status === 'MISSING' || status === 'DOM_WORK_BUDGET_REACHED') && domWorkUsed !== undefined) {
    return Object.freeze({ status, domWorkUsed });
  }
  throw new Error('Invalid bounded interaction handle resolution envelope');
}

interface RawInteractionCandidate {
  readonly ordinal: number;
  readonly tagName: string;
  readonly role: string | null;
  readonly accessibleName: string;
  readonly normalizedText: string;
  readonly ariaExpanded: string | null;
  readonly ariaControls: string | null;
  readonly ariaSelected: string | null;
  readonly controlledVisible: boolean | null;
  readonly controlledHidden: boolean | null;
  readonly formAssociated: boolean;
  readonly formMethod: string | null;
  readonly formAction: string | null;
  readonly rawHref: string | null;
  readonly documentUrl: string;
  readonly documentOrigin: string;
  readonly download: boolean;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly visible: boolean;
  /** ページ座標（ビューポート座標にスクロール量を足したもの）。スクロールだけによる位置の変化を、変化とみなさない。 */
  readonly boundingBox: InteractionBoundingBox;
}

const BOUNDING_BOX_FIELDS = Object.freeze(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'] as const);

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid browser interaction boolean: ${name}`);
  }
  return value;
}

function nullableBooleanField(value: unknown, name: string): boolean | null {
  return value === null ? null : booleanField(value, name);
}

function ordinalField(value: unknown, name: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`Invalid browser interaction ordinal: ${name}`);
  }
  return value;
}

function boundingBoxField(value: unknown, name: string): InteractionBoundingBox {
  if (!isRecord(value)) {
    throw new Error(`Invalid browser interaction bounding box: ${name}`);
  }
  const box: Record<(typeof BOUNDING_BOX_FIELDS)[number], number> = {
    x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
  };
  for (const field of BOUNDING_BOX_FIELDS) {
    const coordinate = value[field];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
      throw new Error(`Invalid browser interaction bounding box: ${name}`);
    }
    box[field] = coordinate;
  }
  return box;
}

function boundedString(value: unknown, maxLength: number, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid browser interaction string: ${name}`);
  }
  return truncateText(value, maxLength).text;
}

function boundedNullableString(value: unknown, maxLength: number, name: string): string | null {
  return value === null ? null : boundedString(value, maxLength, name);
}

function boundedUrl(value: string): string {
  return truncateText(value, INTERACTION_CANDIDATE_LIMITS.maxUrlLength).text;
}

function classifyHref(rawHref: unknown, documentUrlInput: unknown, documentOriginInput: unknown): {
  readonly href: string | null;
  readonly hrefKind: InteractionHrefKind;
} {
  if (rawHref === null) {
    return { href: null, hrefKind: 'NONE' };
  }
  if (typeof rawHref !== 'string') {
    return { href: '', hrefKind: 'MALFORMED' };
  }
  if (
    typeof documentUrlInput !== 'string'
    || typeof documentOriginInput !== 'string'
    || documentUrlInput.length > INTERACTION_CANDIDATE_LIMITS.maxUrlLength
    || documentOriginInput.length > INTERACTION_CANDIDATE_LIMITS.maxUrlLength
  ) {
    return { href: boundedUrl(rawHref), hrefKind: 'MALFORMED' };
  }
  const documentUrl = documentUrlInput;
  const documentOrigin = documentOriginInput;
  if (rawHref.length > INTERACTION_CANDIDATE_LIMITS.maxUrlLength) {
    return { href: boundedUrl(rawHref), hrefKind: 'MALFORMED' };
  }
  let url: URL;
  try {
    url = new URL(rawHref, documentUrl);
  } catch {
    return { href: rawHref, hrefKind: 'MALFORMED' };
  }
  if (!isHttpProtocol(url.protocol.toLowerCase())) {
    return { href: boundedUrl(url.href), hrefKind: 'SPECIAL_SCHEME' };
  }
  if (url.href.length > INTERACTION_CANDIDATE_LIMITS.maxUrlLength) {
    return { href: boundedUrl(url.href), hrefKind: 'MALFORMED' };
  }
  return {
    href: url.href,
    hrefKind: url.origin === documentOrigin ? 'SAME_ORIGIN_HTTP' : 'EXTERNAL_ORIGIN_HTTP',
  };
}

function identityFor(candidate: Omit<InteractionCandidate, 'candidateId'>): string {
  return JSON.stringify({
    tagName: candidate.tagName,
    role: candidate.role,
    accessibleName: candidate.accessibleName,
    textFingerprint: candidate.textFingerprint,
    ariaControls: candidate.ariaControls,
    formAssociated: candidate.formAssociated,
    formMethod: candidate.formMethod,
    formAction: candidate.formAction,
    href: candidate.href,
    hrefKind: candidate.hrefKind,
    download: candidate.download,
    type: candidate.type,
  });
}

/** ブラウザから受け取った値を、型を確かめながら候補にする。不正な値は、上限付きの名前だけを含むメッセージで拒否する。 */
function candidateFromRaw(candidate: unknown, label: string): InteractionCandidate {
  if (!isRecord(candidate)) {
    throw new Error(`Invalid browser interaction candidate: ${label}`);
  }
  const { href, hrefKind } = classifyHref(candidate.rawHref, candidate.documentUrl, candidate.documentOrigin);
  const withoutId: Omit<InteractionCandidate, 'candidateId'> = {
    ordinal: ordinalField(candidate.ordinal, `${label}.ordinal`),
    tagName: boundedString(candidate.tagName, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength, `${label}.tagName`),
    role: boundedNullableString(candidate.role, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength, `${label}.role`),
    accessibleName: boundedString(
      candidate.accessibleName,
      INTERACTION_CANDIDATE_LIMITS.maxTextLength,
      `${label}.accessibleName`,
    ),
    textFingerprint: createSha256Fingerprint(boundedString(
      candidate.normalizedText,
      INTERACTION_CANDIDATE_LIMITS.maxTextLength,
      `${label}.normalizedText`,
    )),
    ariaExpanded: boundedNullableString(
      candidate.ariaExpanded,
      INTERACTION_CANDIDATE_LIMITS.maxAttributeLength,
      `${label}.ariaExpanded`,
    ),
    ariaControls: boundedNullableString(
      candidate.ariaControls,
      INTERACTION_CANDIDATE_LIMITS.maxAttributeLength,
      `${label}.ariaControls`,
    ),
    ariaSelected: boundedNullableString(
      candidate.ariaSelected,
      INTERACTION_CANDIDATE_LIMITS.maxAttributeLength,
      `${label}.ariaSelected`,
    ),
    controlledVisible: nullableBooleanField(candidate.controlledVisible, `${label}.controlledVisible`),
    controlledHidden: nullableBooleanField(candidate.controlledHidden, `${label}.controlledHidden`),
    formAssociated: booleanField(candidate.formAssociated, `${label}.formAssociated`),
    formMethod: boundedNullableString(
      candidate.formMethod,
      INTERACTION_CANDIDATE_LIMITS.maxAttributeLength,
      `${label}.formMethod`,
    ),
    formAction: boundedNullableString(
      candidate.formAction,
      INTERACTION_CANDIDATE_LIMITS.maxUrlLength,
      `${label}.formAction`,
    ),
    href,
    hrefKind,
    download: booleanField(candidate.download, `${label}.download`),
    type: boundedNullableString(candidate.type, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength, `${label}.type`),
    disabled: booleanField(candidate.disabled, `${label}.disabled`),
    visible: booleanField(candidate.visible, `${label}.visible`),
    boundingBox: boundingBoxField(candidate.boundingBox, `${label}.boundingBox`),
  };
  return freezeInteractionCandidate({
    ...withoutId,
    candidateId: `${INTERACTION_CANDIDATE_ID_PREFIX}${createSha256Fingerprint(identityFor(withoutId))}`,
  });
}

/** 上限付きでDOMから切り離された汎用インタラクションのスナップショットを、単一の読み取り専用evaluationで探索する。 */
export async function discoverInteractionCandidates(
  page: Page,
  maxDomWork: number = INTERACTION_CANDIDATE_LIMITS.maxDomWork,
): Promise<InteractionCandidateDiscoveryResult> {
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({
      candidates: Object.freeze([]),
      completeness: 'DOM_WORK_BUDGET_REACHED',
      domWorkUsed: 0,
    });
  }
  const raw: unknown = await page.evaluate<unknown, PageInteractionProbeInput>(pageInteractionCandidateProbe, {
    mode: 'DISCOVER',
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: { ...INTERACTION_CANDIDATE_LIMITS, maxDomWork: boundedMaxDomWork },
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
  });

  if (!isRecord(raw) || !Array.isArray(raw.candidates)) {
    throw new Error('Invalid browser interaction candidate container');
  }
  if (!isDiscoveryCompleteness(raw.completeness)) {
    throw new Error('Invalid browser interaction completeness');
  }
  if (!validDomWorkCount(raw.domWorkUsed, boundedMaxDomWork)) {
    throw new Error('Invalid browser interaction DOM work count');
  }
  const candidates = raw.candidates.slice(0, INTERACTION_CANDIDATE_LIMITS.maxCandidates)
    .map((candidate, index) => candidateFromRaw(candidate, `[${index}]`));
  return Object.freeze({
    candidates: Object.freeze(candidates),
    completeness: raw.completeness,
    domWorkUsed: raw.domWorkUsed,
  });
}

/**
 * 保持した対象の、スクロールする祖先（文書を含む）のスクロール位置の記録（設計書 2026-09-23 4.4 の追記）。
 * auditor の内部の判定（click の前後でスクロールが起きたか）だけに使い、Evidence には含めない。
 * - `RECORDED`: `offsets` に、近い祖先から順に各祖先の `[scrollLeft, scrollTop]` を並べ、最後に文書の `[scrollX, scrollY]` を置く。
 *   祖先は、open な shadow root と slot をまたいでたどり、`overflow`（x・y のどちらか）が `visible`・`clip` 以外の要素に限る。
 * - `INCOMPLETE`: 祖先の走査が、共有の DOM の作業量の上限に達した。スクロールが起きたかを判定できない。
 * - `UNRECORDED`: ブラウザから記録を受け取らなかった。スクロールが起きたかを判定できない。
 */
export type InteractionScrollRecord =
  | { readonly status: 'RECORDED'; readonly offsets: readonly number[] }
  | { readonly status: 'INCOMPLETE' | 'UNRECORDED' };

/**
 * 2つのスクロールの記録を比べる。
 * - `UNCHANGED`: 同じ祖先の並びで、すべての位置が同じ。
 * - `SCROLLED`: 同じ祖先の並びで、1つでも位置が変わった。
 * - `UNCOMPARABLE`: どちらかが記録を持たない、または祖先の並びが変わった。
 */
export type InteractionScrollComparison = 'UNCHANGED' | 'SCROLLED' | 'UNCOMPARABLE';

export function compareInteractionScrollRecords(
  before: InteractionScrollRecord,
  after: InteractionScrollRecord,
): InteractionScrollComparison {
  if (before.status !== 'RECORDED' || after.status !== 'RECORDED' || before.offsets.length !== after.offsets.length) {
    return 'UNCOMPARABLE';
  }
  return before.offsets.every((offset, index) => offset === after.offsets[index]) ? 'UNCHANGED' : 'SCROLLED';
}

const UNRECORDED_SCROLL: InteractionScrollRecord = Object.freeze({ status: 'UNRECORDED' });
const INCOMPLETE_SCROLL: InteractionScrollRecord = Object.freeze({ status: 'INCOMPLETE' });
/** 記録できる位置の数の上限。祖先1つにつき作業量1を消費するので、祖先の数は DOM の作業量の上限を超えない。 */
const MAX_SCROLL_OFFSETS = (INTERACTION_CANDIDATE_LIMITS.maxDomWork + 1) * 2;

/** ブラウザから受け取ったスクロールの記録を確かめる。記録がない場合は `UNRECORDED`、不正な値は拒否する。 */
function scrollRecordFromRaw(snapshot: Record<string, unknown>): InteractionScrollRecord {
  if (!Object.hasOwn(snapshot, 'scroll')) {
    return UNRECORDED_SCROLL;
  }
  const raw = snapshot.scroll;
  if (!isRecord(raw) || typeof raw.complete !== 'boolean' || !Array.isArray(raw.offsets)) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const offsets: unknown[] = raw.offsets;
  if (offsets.length % 2 !== 0 || offsets.length > MAX_SCROLL_OFFSETS
    || !offsets.every((offset) => typeof offset === 'number' && Number.isFinite(offset))) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  if (!raw.complete) {
    return INCOMPLETE_SCROLL;
  }
  return Object.freeze({ status: 'RECORDED', offsets: Object.freeze([...offsets as number[]]) });
}

/**
 * 保持した対象の要素そのものの属性の記録（設計書 2026-09-23 4.4.1）。子孫の属性は含めない。
 * auditor の内部の判定（観測の前後で対象自身の属性が変わったか）に使う。記録そのものは Evidence に含めず、
 * 根拠になった場合に、変わった属性の名前だけを Evidence（`changedAttributes`）に残す（設計書 2026-09-23 4.4.1、R5 の N-5）。
 * - `RECORDED`: `entries` に、属性の順に `名前, 値` を並べる。名前は `maxAttributeLength` までに切り詰める。値は、class だけを
 *   class 専用の上限（`maxClassAttributeLength`）までに、ほかの属性を `maxAttributeLength` までに切り詰める（4.4.1「長い class」、F20b）。
 * - `INCOMPLETE`: 属性の走査が、共有の DOM の作業量の上限に達した。属性が変わったかを判定できない。
 * - `UNRECORDED`: ブラウザから記録を受け取らなかった。属性が変わったかを判定できない。
 */
export type InteractionAttributeRecord =
  | { readonly status: 'RECORDED'; readonly entries: readonly string[] }
  | { readonly status: 'INCOMPLETE' | 'UNRECORDED' };

/**
 * 2つの属性の記録を比べる。属性の順序の違いは変化とみなさない。値が空白だけの `class`・`style` は、ないものとみなす。
 * `class` は中の名前の集まりで、`style` は CSS のカスタムプロパティ以外の宣言で比べる（R6 の I-1・M-2）。
 * - `UNCHANGED`: 同じ名前と値の組の集まり（class・style は、意味の上で同じもの）。
 * - `CHANGED`: 属性が1つでも加わった、除かれた、または値が変わった。
 * - `UNCOMPARABLE`: どちらかが記録を持たない。
 */
export type InteractionAttributeComparison = 'UNCHANGED' | 'CHANGED' | 'UNCOMPARABLE';

/**
 * 値が空白だけのときに、属性がない場合と同じ意味になる属性の名前。`classList.remove` や `style.x = ''` の後に残る
 * 空の `class`・`style` を、属性の変化とみなさないために使う（R5 の N-3。押し下げたときの ripple の class を外した後など）。
 */
const EMPTY_EQUIVALENT_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([CLASS_ATTRIBUTE_NAME, 'style']);

/** 属性の記録の名前と値の組（JSON の文字列）を並べる。空と同じ意味の属性は除く。 */
function effectiveAttributePairs(entries: readonly string[]): { readonly name: string; readonly pair: string }[] {
  const pairs: { readonly name: string; readonly pair: string }[] = [];
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const name = entries[index] as string;
    const value = entries[index + 1] as string;
    if (EMPTY_EQUIVALENT_ATTRIBUTE_NAMES.has(name) && value.trim() === '') continue;
    pairs.push({ name, pair: JSON.stringify([name, value]) });
  }
  return pairs;
}

/** 属性の記録から、名前が `name` の属性の値を返す。属性がない場合は空文字列を返す（空と同じ意味の属性の扱いに合わせる）。 */
function recordedAttributeValue(entries: readonly string[], name: string): string {
  for (let index = 0; index + 1 < entries.length; index += 2) {
    if (entries[index] === name) return entries[index + 1] as string;
  }
  return '';
}

/**
 * 属性の記録で、名前が `name` の属性の値に使う長さの上限（設計書 2026-09-23 4.4.1「長い class」、F20b）。
 * class だけは class 専用の上限（`maxClassAttributeLength`）とし、ほかの属性は `maxAttributeLength` とする。
 * ブラウザの中の記録（`inspectInteractionCandidateHandle`）も、同じ決まりで切り詰める。
 */
function attributeValueLengthLimit(name: string): number {
  return name === CLASS_ATTRIBUTE_NAME
    ? INTERACTION_CANDIDATE_LIMITS.maxClassAttributeLength
    : INTERACTION_CANDIDATE_LIMITS.maxAttributeLength;
}

/**
 * 記録した属性 `name` の値が、その属性の値の長さの上限で切り詰められた可能性があるか。切り詰められた値は、末尾の名前や宣言が
 * 途中で切れているので、分解して比べない（R6 の I-1・M-2。これまでの値の比べ方を使う）。class は class 専用の上限で判定する（F20b）。
 */
function mayBeTruncatedAttributeValue(name: string, value: string): boolean {
  return value.length >= attributeValueLengthLimit(name);
}

/**
 * 空白で区切った値（class の値、role の値）の中の名前を区切る、ASCII の空白（HTML の `classList` と同じ区切り）。
 */
const ASCII_WHITESPACE_SEPARATOR_PATTERN = /[\t\n\f\r ]+/u;

/**
 * class の値の中の名前の集まり。class 専用の上限で切り詰められた可能性がある値は、名前ごとに比べられないので null を返す
 * （設計書 2026-09-23 4.4.1「長い class」。呼び出す側は、class の変化を根拠にしない）。
 */
function classNamesOf(value: string): ReadonlySet<string> | null {
  if (mayBeTruncatedAttributeValue(CLASS_ATTRIBUTE_NAME, value)) {
    return null;
  }
  return new Set(value.split(ASCII_WHITESPACE_SEPARATOR_PATTERN).filter((name) => name !== ''));
}

/** 下準備の focus をしない role（設計書 2026-09-23 4.4.1「focus をしない要素と、focus による状態の変化」、R8 の Important-2）。 */
const NO_PREPARATORY_FOCUS_ROLE = 'tab';

/**
 * 候補が `role="tab"` を明示しているか（設計書 2026-09-23 4.4.1、4.4.2 手順4、R8 の Important-2）。
 * `role` は候補の `getAttribute('role')` の値で、空白で分けた名前のどれかが `tab` であれば、明示しているとする。
 * 自動で切り替わるタブは focus だけで切り替わるので、こうした要素には、凍結の前の下準備の focus をしない。
 */
export function hasExplicitTabRole(role: string | null): boolean {
  return role !== null && role.split(ASCII_WHITESPACE_SEPARATOR_PATTERN).includes(NO_PREPARATORY_FOCUS_ROLE);
}

/**
 * 2つの属性の記録で、class の中で増えた、または減った名前を、UTF-16 のコード単位の順に重複なく返す（設計書 2026-09-23 4.4.1、R6 の M-2）。
 * class がない場合と、値が空白だけの場合は、名前のない class とみなす。
 * どちらかが記録を持たない場合と、どちらかの class の値が class 専用の上限で切り詰められた可能性がある場合は、名前ごとに比べられないので
 * null を返す（4.4.1「長い class」）。
 */
export function changedInteractionClassNames(
  before: InteractionAttributeRecord,
  after: InteractionAttributeRecord,
): readonly string[] | null {
  if (before.status !== 'RECORDED' || after.status !== 'RECORDED') {
    return null;
  }
  const beforeNames = classNamesOf(recordedAttributeValue(before.entries, CLASS_ATTRIBUTE_NAME));
  const afterNames = classNamesOf(recordedAttributeValue(after.entries, CLASS_ATTRIBUTE_NAME));
  if (beforeNames === null || afterNames === null) {
    return null;
  }
  const changed = [
    ...[...beforeNames].filter((name) => !afterNames.has(name)),
    ...[...afterNames].filter((name) => !beforeNames.has(name)),
  ];
  return Object.freeze(changed.sort(compareCodeUnits));
}

/**
 * style の値を、分解して比べられるかの判定に使う文字。コメント（`/*`）、エスケープ（`\`）、ブロック（`{`・`}`）を含む値は、
 * 宣言の区切りを正しく見分けられないので、分解しない。
 */
const UNPARSED_STYLE_PATTERN = /\/\*|[\\{}]/u;

/**
 * style の値を宣言に分解し、CSS のカスタムプロパティ（`--` で始まる名前）を除いた宣言を、比べられる形で返す（R6 の I-1）。
 * 宣言は、引用符と括弧の外の `;` で区切り、最初の `:` で名前と値に分ける。名前は、カスタムプロパティ以外は ASCII の大文字と小文字を区別しない。
 * 宣言の順序は比べない。分解できない値（切り詰められた可能性がある値、コメント・エスケープ・ブロックを含む値、
 * 閉じていない引用符や括弧、`:` のない宣言、名前のない宣言）は null を返す。
 */
function regularStyleDeclarationsOf(value: string): readonly string[] | null {
  if (mayBeTruncatedAttributeValue('style', value) || UNPARSED_STYLE_PATTERN.test(value)) {
    return null;
  }
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (quote !== null) {
      if (character === quote) quote = null;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (character === ';' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (quote !== null || depth !== 0) {
    return null;
  }
  parts.push(current);
  const declarations: string[] = [];
  for (const part of parts) {
    if (part.trim() === '') continue;
    const colonAt = part.indexOf(':');
    if (colonAt === -1) return null;
    const name = part.slice(0, colonAt).trim();
    if (name === '') return null;
    if (name.startsWith('--')) continue;
    declarations.push(JSON.stringify([name.toLowerCase(), part.slice(colonAt + 1).trim()]));
  }
  return Object.freeze(declarations.sort(compareCodeUnits));
}

/**
 * 値の組が変わった属性が、意味の上でも変わったか。class は中の名前の集まりで、style はカスタムプロパティ以外の宣言で比べる
 * （設計書 2026-09-23 4.4.1、R6 の I-1・M-2）。分解して比べられない場合と、ほかの属性は、変わったとみなす（これまでの値の比べ方）。
 */
function attributeChangedInMeaning(name: string, beforeEntries: readonly string[], afterEntries: readonly string[]): boolean {
  if (name === CLASS_ATTRIBUTE_NAME) {
    const beforeNames = classNamesOf(recordedAttributeValue(beforeEntries, name));
    const afterNames = classNamesOf(recordedAttributeValue(afterEntries, name));
    return beforeNames === null || afterNames === null
      || beforeNames.size !== afterNames.size
      || [...beforeNames].some((className) => !afterNames.has(className));
  }
  if (name === 'style') {
    const beforeDeclarations = regularStyleDeclarationsOf(recordedAttributeValue(beforeEntries, name));
    const afterDeclarations = regularStyleDeclarationsOf(recordedAttributeValue(afterEntries, name));
    return beforeDeclarations === null || afterDeclarations === null
      || beforeDeclarations.length !== afterDeclarations.length
      || beforeDeclarations.some((declaration, index) => declaration !== afterDeclarations[index]);
  }
  return true;
}

/**
 * 2つの属性の記録で、加わった、除かれた、または値が変わった属性の名前を、UTF-16 のコード単位の順に重複なく返す。
 * どちらかが記録を持たない（比べられない）場合は null を返す。値が空白だけの `class`・`style` は、ないものとみなす。
 * class は中の名前の集まりが変わった場合だけ、style は CSS のカスタムプロパティ以外の宣言が変わった場合だけ、変わったとする
 * （R6 の I-1・M-2）。分解して比べられない場合は、値の比べ方で判定する。
 */
export function changedInteractionAttributeNames(
  before: InteractionAttributeRecord,
  after: InteractionAttributeRecord,
): readonly string[] | null {
  if (before.status !== 'RECORDED' || after.status !== 'RECORDED') {
    return null;
  }
  const beforePairs = effectiveAttributePairs(before.entries);
  const afterPairs = effectiveAttributePairs(after.entries);
  const names = new Set<string>();
  const collect = (
    pairs: readonly { readonly name: string; readonly pair: string }[],
    counterpart: ReadonlySet<string>,
  ): void => {
    for (const { name, pair } of pairs) {
      if (!counterpart.has(pair)) names.add(name);
    }
  };
  collect(beforePairs, new Set(afterPairs.map(({ pair }) => pair)));
  collect(afterPairs, new Set(beforePairs.map(({ pair }) => pair)));
  return Object.freeze(
    [...names]
      .filter((name) => attributeChangedInMeaning(name, before.entries, after.entries))
      .sort(compareCodeUnits),
  );
}

/** 2つの属性の記録を比べる。変わったかの判定は `changedInteractionAttributeNames` と同じ。 */
export function compareInteractionAttributeRecords(
  before: InteractionAttributeRecord,
  after: InteractionAttributeRecord,
): InteractionAttributeComparison {
  const changedNames = changedInteractionAttributeNames(before, after);
  if (changedNames === null) {
    return 'UNCOMPARABLE';
  }
  return changedNames.length === 0 ? 'UNCHANGED' : 'CHANGED';
}

const UNRECORDED_ATTRIBUTES: InteractionAttributeRecord = Object.freeze({ status: 'UNRECORDED' });
const INCOMPLETE_ATTRIBUTES: InteractionAttributeRecord = Object.freeze({ status: 'INCOMPLETE' });
/** 記録できる名前と値の数の上限。属性1つにつき作業量1を消費するので、属性の数は DOM の作業量の上限を超えない。 */
const MAX_ATTRIBUTE_ENTRIES = INTERACTION_CANDIDATE_LIMITS.maxDomWork * 2;

/**
 * 属性の記録の名前と値の組が、長さの上限を守っているか。名前は `maxAttributeLength` まで、値は属性ごとの上限
 * （class は class 専用の上限。4.4.1「長い class」、F20b）までとする。
 */
function boundedAttributeEntries(entries: readonly string[]): boolean {
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const name = entries[index] as string;
    const value = entries[index + 1] as string;
    if (name.length > INTERACTION_CANDIDATE_LIMITS.maxAttributeLength || value.length > attributeValueLengthLimit(name)) {
      return false;
    }
  }
  return true;
}

/** ブラウザから受け取った属性の記録を確かめる。記録がない場合は `UNRECORDED`、不正な値は拒否する。 */
function attributeRecordFromRaw(snapshot: Record<string, unknown>): InteractionAttributeRecord {
  if (!Object.hasOwn(snapshot, 'attributes')) {
    return UNRECORDED_ATTRIBUTES;
  }
  const raw = snapshot.attributes;
  if (!isRecord(raw) || typeof raw.complete !== 'boolean' || !Array.isArray(raw.entries)) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const entries: unknown[] = raw.entries;
  if (entries.length % 2 !== 0 || entries.length > MAX_ATTRIBUTE_ENTRIES
    || !entries.every((entry) => typeof entry === 'string')
    || !boundedAttributeEntries(entries as string[])) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  if (!raw.complete) {
    return INCOMPLETE_ATTRIBUTES;
  }
  return Object.freeze({ status: 'RECORDED', entries: Object.freeze([...entries as string[]]) });
}

/**
 * ブラウザから受け取った、親の `details` の開閉の状態を確かめる（設計書 2026-09-23 4.4.1）。
 * 記録がない場合は null（対象が `details` の子の `summary` でない場合と同じ）とし、不正な値は拒否する。
 */
function detailsOpenFromRaw(snapshot: Record<string, unknown>): boolean | null {
  if (!Object.hasOwn(snapshot, 'detailsOpen')) {
    return null;
  }
  const raw = snapshot.detailsOpen;
  if (raw !== null && typeof raw !== 'boolean') {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  return raw;
}

export type InteractionHandleSnapshot =
  | {
      readonly status: 'CONNECTED';
      readonly candidate: InteractionCandidate;
      readonly scroll: InteractionScrollRecord;
      readonly attributes: InteractionAttributeRecord;
      /**
       * 対象が `details` の子の `summary` の場合は、親の `details` の `open` の有無（開閉の状態）。それ以外は null。
       * auditor の内部の判定（観測の前後で開閉の状態が変わったか）だけに使う（設計書 2026-09-23 4.4.1）。
       */
      readonly detailsOpen: boolean | null;
      readonly domWorkUsed: number;
    }
  | { readonly status: 'DISCONNECTED'; readonly domWorkUsed: number }
  | { readonly status: 'CANDIDATE_LIMIT_REACHED'; readonly domWorkUsed: number }
  | { readonly status: 'DOM_WORK_BUDGET_REACHED'; readonly domWorkUsed: number }
  | { readonly status: 'TEXT_NODE_LIMIT_REACHED'; readonly domWorkUsed: number };

/** 他のノードを解決することなく、保持している単一のブラウザノードから候補の情報を読み取る。 */
export async function inspectInteractionCandidateHandle(
  handle: ElementHandle<Element>,
  ordinalHint: number,
  maxDomWork: number = INTERACTION_CANDIDATE_LIMITS.maxDomWork,
): Promise<InteractionHandleSnapshot> {
  if (!isNonNegativeSafeInteger(ordinalHint) || ordinalHint > INTERACTION_CANDIDATE_LIMITS.maxOrdinal) {
    throw new Error('Interaction candidate ordinal hint is outside the bounded contract');
  }
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 });
  }
  const snapshot: unknown = await handle.evaluate<unknown, HandleInteractionProbeInput>(handleInteractionCandidateProbe, {
    mode: 'INSPECT',
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: { ...INTERACTION_CANDIDATE_LIMITS, maxDomWork: boundedMaxDomWork },
    visibilityOptions: VISIBILITY_CHECK_OPTIONS,
    classAttributeName: CLASS_ATTRIBUTE_NAME,
  });
  if (!isRecord(snapshot)) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const status = (snapshot as { readonly status?: unknown }).status;
  const domWorkUsed = (snapshot as { readonly domWorkUsed?: unknown }).domWorkUsed;
  if (!validDomWorkCount(domWorkUsed, boundedMaxDomWork)
    || (status !== 'CONNECTED'
      && status !== 'DISCONNECTED'
      && status !== 'CANDIDATE_LIMIT_REACHED'
      && status !== 'DOM_WORK_BUDGET_REACHED'
      && status !== 'TEXT_NODE_LIMIT_REACHED')) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const hasRaw = Object.hasOwn(snapshot, 'raw');
  if (status === 'CONNECTED') {
    const raw = (snapshot as { readonly raw?: unknown }).raw;
    if (!hasRaw || !isRecord(raw)) {
      throw new Error('Invalid bounded interaction handle snapshot');
    }
    return Object.freeze({
      status: 'CONNECTED',
      candidate: candidateFromRaw(raw, '[retained-handle]'),
      scroll: scrollRecordFromRaw(snapshot),
      attributes: attributeRecordFromRaw(snapshot),
      detailsOpen: detailsOpenFromRaw(snapshot),
      domWorkUsed,
    });
  }
  if (hasRaw || Object.hasOwn(snapshot, 'scroll') || Object.hasOwn(snapshot, 'attributes')
    || Object.hasOwn(snapshot, 'detailsOpen')) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  return Object.freeze({ status, domWorkUsed });
}
