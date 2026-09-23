import { createHash } from 'node:crypto';
import type { ElementHandle, JSHandle, Page } from 'playwright';
import {
  freezeInteractionCandidate,
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

export interface InteractionCandidateDiscoveryResult {
  readonly candidates: readonly InteractionCandidate[];
  readonly completeness: 'COMPLETE' | 'CANDIDATE_LIMIT_REACHED' | 'DOM_WORK_BUDGET_REACHED';
  readonly domWorkUsed: number;
}

function validatedDomWorkLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > INTERACTION_CANDIDATE_LIMITS.maxDomWork) {
    throw new Error('Interaction DOM work limit is outside the bounded contract');
  }
  return value;
}

function validDomWorkCount(value: unknown, maxDomWork: number = INTERACTION_CANDIDATE_LIMITS.maxDomWork): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= 0
    && (value as number) <= maxDomWork;
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

export async function resolveInteractionCandidateHandle(
  page: Page,
  ordinal: number,
  maxDomWork: number = INTERACTION_CANDIDATE_LIMITS.maxDomWork,
): Promise<InteractionHandleResolution> {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > INTERACTION_CANDIDATE_LIMITS.maxOrdinal) {
    throw new Error('Interaction candidate ordinal is outside the bounded contract');
  }
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 });
  }
  const envelope = await page.evaluateHandle(({ selector, limits, targetOrdinal }) => {
    const domWork = {
      used: 0,
      exhausted: false,
      consume(): boolean {
        if (this.used >= limits.maxDomWork) {
          this.exhausted = true;
          return false;
        }
        this.used += 1;
        return true;
      },
    };
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let rootPending = true;
    const nextElement = (): Element | null => {
      if (rootPending) {
        rootPending = false;
        return document.documentElement;
      }
      return walker.nextNode() as Element | null;
    };
    let candidateOrdinal = 0;
    while (true) {
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
      }
      const element = nextElement();
      if (element === null) {
        return { status: 'MISSING' as const, domWorkUsed: domWork.used };
      }
      if (!domWork.consume()) {
        return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
      }
      if (!element.matches(selector)) {
        continue;
      }
      if (!domWork.consume()) {
        return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
      }
      if (candidateOrdinal === targetOrdinal) {
        return { status: 'FOUND' as const, element, domWorkUsed: domWork.used };
      }
      candidateOrdinal += 1;
    }
  }, {
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
  readonly boundingBox: InteractionBoundingBox;
}

function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function boundedString(value: unknown, maxLength: number, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid browser interaction string: ${name}`);
  }
  return value.slice(0, maxLength);
}

function boundedNullableString(value: unknown, maxLength: number, name: string): string | null {
  return value === null ? null : boundedString(value, maxLength, name);
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
    return { href: rawHref.slice(0, INTERACTION_CANDIDATE_LIMITS.maxUrlLength), hrefKind: 'MALFORMED' };
  }
  const documentUrl = documentUrlInput;
  const documentOrigin = documentOriginInput;
  if (rawHref.length > INTERACTION_CANDIDATE_LIMITS.maxUrlLength) {
    return { href: rawHref.slice(0, INTERACTION_CANDIDATE_LIMITS.maxUrlLength), hrefKind: 'MALFORMED' };
  }
  let url: URL;
  try {
    url = new URL(rawHref, documentUrl);
  } catch {
    return { href: rawHref, hrefKind: 'MALFORMED' };
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { href: url.href.slice(0, INTERACTION_CANDIDATE_LIMITS.maxUrlLength), hrefKind: 'SPECIAL_SCHEME' };
  }
  if (url.href.length > INTERACTION_CANDIDATE_LIMITS.maxUrlLength) {
    return { href: url.href.slice(0, INTERACTION_CANDIDATE_LIMITS.maxUrlLength), hrefKind: 'MALFORMED' };
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

function candidateFromRaw(candidate: RawInteractionCandidate, label: string): InteractionCandidate {
  const { href, hrefKind } = classifyHref(candidate.rawHref, candidate.documentUrl, candidate.documentOrigin);
  const withoutId: Omit<InteractionCandidate, 'candidateId'> = {
    ordinal: candidate.ordinal,
    tagName: boundedString(candidate.tagName, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength, `${label}.tagName`),
    role: boundedNullableString(candidate.role, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength, `${label}.role`),
    accessibleName: boundedString(
      candidate.accessibleName,
      INTERACTION_CANDIDATE_LIMITS.maxTextLength,
      `${label}.accessibleName`,
    ),
    textFingerprint: fingerprint(boundedString(
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
    controlledVisible: candidate.controlledVisible,
    controlledHidden: candidate.controlledHidden,
    formAssociated: candidate.formAssociated,
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
    download: candidate.download,
    type: boundedNullableString(candidate.type, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength, `${label}.type`),
    disabled: candidate.disabled,
    visible: candidate.visible,
    boundingBox: candidate.boundingBox,
  };
  return freezeInteractionCandidate({
    ...withoutId,
    candidateId: `interaction-candidate:${fingerprint(identityFor(withoutId))}`,
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
  const raw = await page.evaluate(({ selector, limits }) => {
    const domWork = {
      used: 0,
      exhausted: false,
      consume(): boolean {
        if (this.used >= limits.maxDomWork) {
          this.exhausted = true;
          return false;
        }
        this.used += 1;
        return true;
      },
    };
    const textWork = { used: 0 };
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
          domWork.exhausted = true;
          return null;
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
        while (result.length < maxCharacters) {
          if (textWork.used >= limits.maxTextNodes) return null;
          if (domWork.used >= limits.maxDomWork) {
            domWork.exhausted = true;
            return null;
          }
          const node = walker.nextNode();
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
    const visibility = (element: Element): boolean | null => {
      let current: Element | null = element;
      while (current !== null) {
        if (!domWork.consume()) return null;
        const inlineStyle = current.getAttribute('style') ?? '';
        if (
          (current instanceof HTMLElement && current.hidden)
          || /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/iu.test(inlineStyle)
          || /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)\s*(?:;|$)/iu.test(inlineStyle)
          || /(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:;|$)/iu.test(inlineStyle)
        ) return false;
        current = current.parentElement;
      }
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        return null;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
    };
    const accessibleName = (element: Element): string | null => {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel !== null) return normalizeBounded(ariaLabel, limits.maxTextLength);
      const labelledBy = element.getAttribute('aria-labelledby');
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
      const title = element.getAttribute('title');
      if (title !== null) return normalizeBounded(title, limits.maxTextLength);
      const text = boundedDescendantText([element], limits.maxTextLength * 4);
      return text === null ? null : normalizeBounded(text, limits.maxTextLength);
    };
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
        domWork.exhausted = true;
        return null;
      }
      const name = accessibleName(element);
      if (name === null) return null;
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        return null;
      }
      const text = boundedDescendantText([element], limits.maxTextLength * 4);
      if (text === null) return null;
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        return null;
      }
      const visible = visibility(element);
      if (visible === null) return null;
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        return null;
      }
      const rect = element.getBoundingClientRect();
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
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
      };
    };
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let rootPending = true;
    const nextElement = (): Element | null => {
      if (rootPending) {
        rootPending = false;
        return document.documentElement;
      }
      return walker.nextNode() as Element | null;
    };
    const selected: RawInteractionCandidate[] = [];
    let completeness: 'COMPLETE' | 'CANDIDATE_LIMIT_REACHED' | 'DOM_WORK_BUDGET_REACHED' = 'COMPLETE';
    while (selected.length < limits.maxCandidates) {
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        completeness = 'DOM_WORK_BUDGET_REACHED';
        break;
      }
      const element = nextElement();
      if (element === null) break;
      if (!domWork.consume()) {
        completeness = 'DOM_WORK_BUDGET_REACHED';
        break;
      }
      if (!element.matches(selector)) continue;
      if (!domWork.consume()) {
        completeness = 'DOM_WORK_BUDGET_REACHED';
        break;
      }
      const candidate = collectCandidate(element, selected.length);
      if (candidate === null) {
        completeness = 'DOM_WORK_BUDGET_REACHED';
        break;
      }
      selected.push(candidate);
    }
    if (selected.length === limits.maxCandidates && completeness === 'COMPLETE') {
      completeness = 'CANDIDATE_LIMIT_REACHED';
    }
    return { candidates: selected, completeness, domWorkUsed: domWork.used };
  }, {
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: { ...INTERACTION_CANDIDATE_LIMITS, maxDomWork: boundedMaxDomWork },
  });

  if (!raw || !Array.isArray(raw.candidates)) {
    throw new Error('Invalid browser interaction candidate container');
  }
  if (!['COMPLETE', 'CANDIDATE_LIMIT_REACHED', 'DOM_WORK_BUDGET_REACHED'].includes(raw.completeness)) {
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

export type InteractionHandleSnapshot =
  | { readonly status: 'CONNECTED'; readonly candidate: InteractionCandidate; readonly domWorkUsed: number }
  | { readonly status: 'DISCONNECTED'; readonly domWorkUsed: number }
  | { readonly status: 'CANDIDATE_LIMIT_REACHED'; readonly domWorkUsed: number }
  | { readonly status: 'DOM_WORK_BUDGET_REACHED'; readonly domWorkUsed: number };

/** 他のノードを解決することなく、保持している単一のブラウザノードから候補の情報を読み取る。 */
export async function inspectInteractionCandidateHandle(
  handle: ElementHandle<Element>,
  ordinalHint: number,
  maxDomWork: number = INTERACTION_CANDIDATE_LIMITS.maxDomWork,
): Promise<InteractionHandleSnapshot> {
  if (!Number.isSafeInteger(ordinalHint) || ordinalHint < 0 || ordinalHint > INTERACTION_CANDIDATE_LIMITS.maxOrdinal) {
    throw new Error('Interaction candidate ordinal hint is outside the bounded contract');
  }
  const boundedMaxDomWork = validatedDomWorkLimit(maxDomWork);
  if (boundedMaxDomWork === 0) {
    return Object.freeze({ status: 'DOM_WORK_BUDGET_REACHED', domWorkUsed: 0 });
  }
  const snapshot = await handle.evaluate((element, { selector, limits }) => {
    const domWork = {
      used: 0,
      exhausted: false,
      consume(): boolean {
        if (this.used >= limits.maxDomWork) {
          this.exhausted = true;
          return false;
        }
        this.used += 1;
        return true;
      },
    };
    const textWork = { used: 0 };
    if (!element.isConnected) return { status: 'DISCONNECTED' as const, domWorkUsed: domWork.used };
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let rootPending = true;
    const nextElement = (): Element | null => {
      if (rootPending) {
        rootPending = false;
        return document.documentElement;
      }
      return walker.nextNode() as Element | null;
    };
    let liveOrdinal = 0;
    let found = false;
    while (true) {
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
      }
      const candidate = nextElement();
      if (candidate === null) break;
      if (!domWork.consume()) return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
      if (!candidate.matches(selector)) continue;
      if (!domWork.consume()) return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
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
          domWork.exhausted = true;
          return null;
        }
        const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
        while (result.length < maxCharacters) {
          if (textWork.used >= limits.maxTextNodes) return null;
          if (domWork.used >= limits.maxDomWork) {
            domWork.exhausted = true;
            return null;
          }
          const node = textWalker.nextNode();
          if (node === null) break;
          if (!domWork.consume()) return null;
          textWork.used += 1;
          if (node.nodeType !== Node.TEXT_NODE) continue;
          const textNode = node as Text;
          result += textNode.substringData(0, Math.min(textNode.length, maxCharacters - result.length));
        }
        if (result.length > 0 && result.length < maxCharacters) result += ' ';
      }
      return result.slice(0, maxCharacters);
    };
    const visibility = (subject: Element): boolean | null => {
      let current: Element | null = subject;
      while (current !== null) {
        if (!domWork.consume()) return null;
        const inlineStyle = current.getAttribute('style') ?? '';
        if (
          (current instanceof HTMLElement && current.hidden)
          || /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/iu.test(inlineStyle)
          || /(?:^|;)\s*visibility\s*:\s*(?:hidden|collapse)\s*(?:;|$)/iu.test(inlineStyle)
          || /(?:^|;)\s*opacity\s*:\s*0(?:\.0*)?\s*(?:;|$)/iu.test(inlineStyle)
        ) return false;
        current = current.parentElement;
      }
      if (domWork.used >= limits.maxDomWork) {
        domWork.exhausted = true;
        return null;
      }
      const rect = subject.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && subject.getClientRects().length > 0;
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
    const htmlElement = element instanceof HTMLElement ? element : null;
    const formControl = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
      ? element
      : null;
    const form = formControl?.form ?? null;
    const ariaControls = bounded(element.getAttribute('aria-controls'), limits.maxAttributeLength);
    let controlled: Element | null = null;
    if (ariaControls !== null) {
      if (!domWork.consume()) return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
      controlled = document.getElementById(ariaControls);
    }
    const controlledVisible = controlled === null ? null : visibility(controlled);
    if (controlledVisible === null && controlled !== null) {
      return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    }
    if (domWork.used >= limits.maxDomWork) {
      return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    }
    const name = accessibleName(element);
    if (name === null) return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    if (domWork.used >= limits.maxDomWork) {
      return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    }
    const text = boundedDescendantText([element], limits.maxTextLength * 4);
    if (text === null) return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    if (domWork.used >= limits.maxDomWork) {
      return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    }
    const visible = visibility(element);
    if (visible === null) return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    if (domWork.used >= limits.maxDomWork) {
      return { status: 'DOM_WORK_BUDGET_REACHED' as const, domWorkUsed: domWork.used };
    }
    const rect = element.getBoundingClientRect();
    return {
      status: 'CONNECTED' as const,
      domWorkUsed: domWork.used,
      raw: {
        ordinal: liveOrdinal,
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
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left,
        },
      },
    };
  }, {
    selector: INTERACTION_CANDIDATE_SELECTOR,
    limits: { ...INTERACTION_CANDIDATE_LIMITS, maxDomWork: boundedMaxDomWork },
  });
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const status = (snapshot as { readonly status?: unknown }).status;
  const domWorkUsed = (snapshot as { readonly domWorkUsed?: unknown }).domWorkUsed;
  if (!validDomWorkCount(domWorkUsed, boundedMaxDomWork)
    || (status !== 'CONNECTED'
      && status !== 'DISCONNECTED'
      && status !== 'CANDIDATE_LIMIT_REACHED'
      && status !== 'DOM_WORK_BUDGET_REACHED')) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  const hasRaw = Object.hasOwn(snapshot, 'raw');
  if (status === 'CONNECTED') {
    const raw = (snapshot as { readonly raw?: unknown }).raw;
    if (!hasRaw || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid bounded interaction handle snapshot');
    }
    return Object.freeze({
      status: 'CONNECTED',
      candidate: candidateFromRaw(raw as RawInteractionCandidate, '[retained-handle]'),
      domWorkUsed,
    });
  }
  if (hasRaw) {
    throw new Error('Invalid bounded interaction handle snapshot');
  }
  return Object.freeze({ status, domWorkUsed });
}
