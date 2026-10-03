import { createHash } from 'node:crypto';
import type { ElementHandle, Page } from 'playwright';
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

/** Discovers a bounded, detached generic interaction snapshot in one read-only evaluation. */
export async function discoverInteractionCandidates(page: Page): Promise<readonly InteractionCandidate[]> {
  const raw = await page.evaluate(({ selector, limits }): RawInteractionCandidate[] => {
    const bounded = (value: string | null, maxLength: number): string | null => (
      value === null ? null : value.slice(0, maxLength)
    );
    const normalizeBounded = (value: string, maxLength: number): string => value
      .slice(0, maxLength * 4)
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, maxLength);
    const boundedDescendantText = (roots: readonly Element[], maxCharacters: number): string => {
      let result = '';
      let visitedTextNodes = 0;
      for (const root of roots) {
        if (result.length >= maxCharacters || visitedTextNodes >= limits.maxTextNodes) {
          break;
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (result.length < maxCharacters && visitedTextNodes < limits.maxTextNodes) {
          const node = walker.nextNode();
          if (node === null) {
            break;
          }
          visitedTextNodes += 1;
          const textNode = node as Text;
          const remainingCharacters = maxCharacters - result.length;
          result += textNode.substringData(0, Math.min(textNode.length, remainingCharacters));
        }
        if (result.length > 0 && result.length < maxCharacters) {
          result += ' ';
        }
      }
      return result.slice(0, maxCharacters);
    };
    const visibility = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || element.getClientRects().length === 0) {
        return false;
      }
      let current: Element | null = element;
      while (current !== null) {
        const style = window.getComputedStyle(current);
        if (
          (current instanceof HTMLElement && current.hidden)
          || style.display === 'none'
          || style.visibility === 'hidden'
          || style.visibility === 'collapse'
          || Number.parseFloat(style.opacity) <= 0
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const accessibleName = (element: Element): string => {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel !== null) {
        return normalizeBounded(ariaLabel, limits.maxTextLength);
      }
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy !== null) {
        const labelRoots: Element[] = [];
        for (const id of labelledBy.slice(0, limits.maxAttributeLength).split(/\s+/u).slice(0, 16)) {
          const labelRoot = document.getElementById(id);
          if (labelRoot !== null) {
            labelRoots.push(labelRoot);
          }
        }
        const labels = boundedDescendantText(labelRoots, limits.maxTextLength * 4);
        const normalized = normalizeBounded(labels, limits.maxTextLength);
        if (normalized.length > 0) {
          return normalized;
        }
      }
      const title = element.getAttribute('title');
      return normalizeBounded(
        title ?? boundedDescendantText([element], limits.maxTextLength * 4),
        limits.maxTextLength,
      );
    };
    const nodeList = document.querySelectorAll(selector);
    const selected: RawInteractionCandidate[] = [];
    const selectedCount = Math.min(nodeList.length, limits.maxCandidates);
    for (let ordinal = 0; ordinal < selectedCount; ordinal += 1) {
      const element = nodeList.item(ordinal);
      if (element === null) {
        continue;
      }
      const htmlElement = element instanceof HTMLElement ? element : null;
      const formControl = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
        ? element
        : null;
      const form = formControl?.form ?? null;
      const ariaControls = bounded(element.getAttribute('aria-controls'), limits.maxAttributeLength);
      const controlled = ariaControls === null ? null : document.getElementById(ariaControls);
      const rect = element.getBoundingClientRect();
      const controlledVisible = controlled === null ? null : visibility(controlled);
      selected.push({
        ordinal,
        tagName: element.tagName.toLowerCase().slice(0, limits.maxAttributeLength),
        role: bounded(element.getAttribute('role'), limits.maxAttributeLength),
        accessibleName: accessibleName(element),
        normalizedText: normalizeBounded(
          boundedDescendantText([element], limits.maxTextLength * 4),
          limits.maxTextLength,
        ),
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
        visible: visibility(element),
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
      });
    }
    return selected;
  }, { selector: INTERACTION_CANDIDATE_SELECTOR, limits: INTERACTION_CANDIDATE_LIMITS });

  if (!Array.isArray(raw)) {
    throw new Error('Invalid browser interaction candidate container');
  }
  const candidates = raw.slice(0, INTERACTION_CANDIDATE_LIMITS.maxCandidates)
    .map((candidate, index) => candidateFromRaw(candidate, `[${index}]`));
  return Object.freeze(candidates);
}

export type InteractionHandleSnapshot =
  | { readonly connected: false }
  | { readonly connected: true; readonly candidate: InteractionCandidate };

/** Reads candidate facts from one retained browser node without resolving another node. */
export async function inspectInteractionCandidateHandle(
  handle: ElementHandle<Element>,
  ordinalHint: number,
): Promise<InteractionHandleSnapshot> {
  const snapshot = await handle.evaluate((element, { selector, limits, ordinal }): {
    readonly connected: false;
  } | {
    readonly connected: true;
    readonly raw: RawInteractionCandidate;
  } => {
    if (!element.isConnected) {
      return { connected: false };
    }
    const bounded = (value: string | null, maxLength: number): string | null => (
      value === null ? null : value.slice(0, maxLength)
    );
    const normalizeBounded = (value: string, maxLength: number): string => value
      .slice(0, maxLength * 4)
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, maxLength);
    const boundedDescendantText = (roots: readonly Element[], maxCharacters: number): string => {
      let result = '';
      let visitedTextNodes = 0;
      for (const root of roots) {
        if (result.length >= maxCharacters || visitedTextNodes >= limits.maxTextNodes) {
          break;
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (result.length < maxCharacters && visitedTextNodes < limits.maxTextNodes) {
          const node = walker.nextNode();
          if (node === null) {
            break;
          }
          visitedTextNodes += 1;
          const textNode = node as Text;
          const remainingCharacters = maxCharacters - result.length;
          result += textNode.substringData(0, Math.min(textNode.length, remainingCharacters));
        }
        if (result.length > 0 && result.length < maxCharacters) {
          result += ' ';
        }
      }
      return result.slice(0, maxCharacters);
    };
    const visibility = (subject: Element): boolean => {
      const subjectRect = subject.getBoundingClientRect();
      if (subjectRect.width <= 0 || subjectRect.height <= 0 || subject.getClientRects().length === 0) {
        return false;
      }
      let current: Element | null = subject;
      while (current !== null) {
        const style = window.getComputedStyle(current);
        if (
          (current instanceof HTMLElement && current.hidden)
          || style.display === 'none'
          || style.visibility === 'hidden'
          || style.visibility === 'collapse'
          || Number.parseFloat(style.opacity) <= 0
        ) {
          return false;
        }
        current = current.parentElement;
      }
      return true;
    };
    const accessibleName = (subject: Element): string => {
      const ariaLabel = subject.getAttribute('aria-label');
      if (ariaLabel !== null) {
        return normalizeBounded(ariaLabel, limits.maxTextLength);
      }
      const labelledBy = subject.getAttribute('aria-labelledby');
      if (labelledBy !== null) {
        const labelRoots: Element[] = [];
        for (const id of labelledBy.slice(0, limits.maxAttributeLength).split(/\s+/u).slice(0, 16)) {
          const labelRoot = document.getElementById(id);
          if (labelRoot !== null) {
            labelRoots.push(labelRoot);
          }
        }
        const labels = boundedDescendantText(labelRoots, limits.maxTextLength * 4);
        const normalized = normalizeBounded(labels, limits.maxTextLength);
        if (normalized.length > 0) {
          return normalized;
        }
      }
      const title = subject.getAttribute('title');
      return normalizeBounded(
        title ?? boundedDescendantText([subject], limits.maxTextLength * 4),
        limits.maxTextLength,
      );
    };
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= limits.maxCandidates) {
      return { connected: false };
    }
    const candidates = document.querySelectorAll(selector);
    let liveOrdinal = -1;
    const candidateCount = Math.min(candidates.length, limits.maxCandidates);
    for (let index = 0; index < candidateCount; index += 1) {
      if (candidates.item(index) === element) {
        liveOrdinal = index;
        break;
      }
    }
    if (liveOrdinal < 0) {
      return { connected: false };
    }
    const htmlElement = element instanceof HTMLElement ? element : null;
    const formControl = element instanceof HTMLButtonElement || element instanceof HTMLInputElement
      ? element
      : null;
    const form = formControl?.form ?? null;
    const ariaControls = bounded(element.getAttribute('aria-controls'), limits.maxAttributeLength);
    const controlled = ariaControls === null ? null : document.getElementById(ariaControls);
    const rect = element.getBoundingClientRect();
    const controlledVisible = controlled === null ? null : visibility(controlled);
    return {
      connected: true,
      raw: {
        ordinal: liveOrdinal,
        tagName: element.tagName.toLowerCase().slice(0, limits.maxAttributeLength),
        role: bounded(element.getAttribute('role'), limits.maxAttributeLength),
        accessibleName: accessibleName(element),
        normalizedText: normalizeBounded(
          boundedDescendantText([element], limits.maxTextLength * 4),
          limits.maxTextLength,
        ),
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
        visible: visibility(element),
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
    limits: INTERACTION_CANDIDATE_LIMITS,
    ordinal: ordinalHint,
  });
  if (!snapshot.connected) {
    return Object.freeze({ connected: false });
  }
  return Object.freeze({
    connected: true,
    candidate: candidateFromRaw(snapshot.raw, '[retained-handle]'),
  });
}
