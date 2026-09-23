export type InteractionHrefKind =
  | 'NONE'
  | 'SAME_ORIGIN_HTTP'
  | 'EXTERNAL_ORIGIN_HTTP'
  | 'SPECIAL_SCHEME'
  | 'MALFORMED';

export interface InteractionBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface InteractionCandidate {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly tagName: string;
  readonly role: string | null;
  readonly accessibleName: string;
  readonly textFingerprint: string;
  readonly ariaExpanded: string | null;
  readonly ariaControls: string | null;
  readonly ariaSelected: string | null;
  readonly controlledVisible: boolean | null;
  readonly controlledHidden: boolean | null;
  readonly formAssociated: boolean;
  readonly formMethod: string | null;
  readonly formAction: string | null;
  readonly href: string | null;
  readonly hrefKind: InteractionHrefKind;
  readonly download: boolean;
  readonly type: string | null;
  readonly disabled: boolean;
  readonly visible: boolean;
  readonly boundingBox: InteractionBoundingBox;
}

export const INTERACTION_CANDIDATE_LIMITS = Object.freeze({
  maxCandidates: 100,
  maxTextLength: 256,
  maxTextNodes: 512,
  maxAttributeLength: 512,
  maxUrlLength: 2_048,
  maxOrdinal: 99,
  maxDomWork: 16_384,
});

export type InteractionRejectionReason =
  | 'SUBMISSION_CONTROL'
  | 'RESET_CONTROL'
  | 'FORM_ASSOCIATED'
  | 'NAVIGATION_HREF'
  | 'EXTERNAL_ACTION'
  | 'DOWNLOAD'
  | 'DISABLED'
  | 'NOT_VISIBLE'
  | 'MALFORMED_CANDIDATE';

export type InteractionAdmission =
  | { readonly action: 'ALLOW'; readonly reason: 'MECHANICALLY_SAFE' }
  | { readonly action: 'REJECT'; readonly reason: InteractionRejectionReason };

const candidateIdPattern = /^interaction-candidate:sha256:[a-f0-9]{64}$/u;
const fingerprintPattern = /^sha256:[a-f0-9]{64}$/u;

function boundedNullable(value: string | null, maxLength: number): boolean {
  return value === null || (typeof value === 'string' && value.length <= maxLength);
}

function finiteRectangle(rect: InteractionBoundingBox, visible: boolean): boolean {
  return [rect.x, rect.y, rect.width, rect.height, rect.top, rect.right, rect.bottom, rect.left]
    .every(Number.isFinite)
    && rect.width >= 0
    && rect.height >= 0
    && (!visible || (rect.width > 0 && rect.height > 0))
    && Math.abs(rect.x - rect.left) < 0.01
    && Math.abs(rect.y - rect.top) < 0.01
    && Math.abs(rect.right - rect.left - rect.width) < 0.01
    && Math.abs(rect.bottom - rect.top - rect.height) < 0.01;
}

function validAriaBoolean(value: string | null): boolean {
  return value === null || value === 'true' || value === 'false';
}

function validControlledState(
  ariaControls: string | null,
  controlledVisible: boolean | null,
  controlledHidden: boolean | null,
): boolean {
  if (ariaControls === null) {
    return controlledVisible === null && controlledHidden === null;
  }
  if (controlledVisible === null || controlledHidden === null) {
    return controlledVisible === null && controlledHidden === null;
  }
  return typeof controlledVisible === 'boolean'
    && typeof controlledHidden === 'boolean'
    && controlledVisible !== controlledHidden;
}

function candidateIsWellFormed(candidate: InteractionCandidate): boolean {
  return candidate !== null
    && typeof candidate === 'object'
    && candidateIdPattern.test(candidate.candidateId)
    && fingerprintPattern.test(candidate.textFingerprint)
    && Number.isSafeInteger(candidate.ordinal)
    && candidate.ordinal >= 0
    && candidate.ordinal <= INTERACTION_CANDIDATE_LIMITS.maxOrdinal
    && candidate.tagName.length > 0
    && candidate.tagName.length <= INTERACTION_CANDIDATE_LIMITS.maxAttributeLength
    && boundedNullable(candidate.role, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength)
    && candidate.accessibleName.length <= INTERACTION_CANDIDATE_LIMITS.maxTextLength
    && boundedNullable(candidate.ariaExpanded, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength)
    && boundedNullable(candidate.ariaControls, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength)
    && boundedNullable(candidate.ariaSelected, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength)
    && validAriaBoolean(candidate.ariaExpanded)
    && validAriaBoolean(candidate.ariaSelected)
    && boundedNullable(candidate.formMethod, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength)
    && boundedNullable(candidate.formAction, INTERACTION_CANDIDATE_LIMITS.maxUrlLength)
    && boundedNullable(candidate.href, INTERACTION_CANDIDATE_LIMITS.maxUrlLength)
    && boundedNullable(candidate.type, INTERACTION_CANDIDATE_LIMITS.maxAttributeLength)
    && ['NONE', 'SAME_ORIGIN_HTTP', 'EXTERNAL_ORIGIN_HTTP', 'SPECIAL_SCHEME', 'MALFORMED']
      .includes(candidate.hrefKind)
    && typeof candidate.formAssociated === 'boolean'
    && typeof candidate.download === 'boolean'
    && typeof candidate.disabled === 'boolean'
    && typeof candidate.visible === 'boolean'
    && finiteRectangle(candidate.boundingBox, candidate.visible)
    && (candidate.href === null) === (candidate.hrefKind === 'NONE')
    && validControlledState(candidate.ariaControls, candidate.controlledVisible, candidate.controlledHidden);
}

export function freezeInteractionCandidate(candidate: InteractionCandidate): InteractionCandidate {
  if (!candidateIsWellFormed(candidate)) {
    throw new Error('Interaction candidate is malformed or exceeds bounded contract');
  }
  return Object.freeze({
    ...candidate,
    boundingBox: Object.freeze({ ...candidate.boundingBox }),
  });
}

function reject(reason: InteractionRejectionReason): InteractionAdmission {
  return Object.freeze({ action: 'REJECT', reason });
}

export function classifyInteractionCandidate(candidate: InteractionCandidate): InteractionAdmission {
  try {
    if (!candidateIsWellFormed(candidate) || candidate.hrefKind === 'MALFORMED') {
      return reject('MALFORMED_CANDIDATE');
    }
    const type = candidate.type?.toLowerCase() ?? null;
    if (type === 'submit') {
      return reject('SUBMISSION_CONTROL');
    }
    if (type === 'reset') {
      return reject('RESET_CONTROL');
    }
    if (candidate.formAssociated) {
      return reject('FORM_ASSOCIATED');
    }
    if (candidate.download) {
      return reject('DOWNLOAD');
    }
    if (candidate.hrefKind === 'SPECIAL_SCHEME' || candidate.hrefKind === 'EXTERNAL_ORIGIN_HTTP') {
      return reject('EXTERNAL_ACTION');
    }
    if (candidate.href !== null) {
      return reject('NAVIGATION_HREF');
    }
    if (candidate.disabled) {
      return reject('DISABLED');
    }
    if (!candidate.visible) {
      return reject('NOT_VISIBLE');
    }
    return Object.freeze({ action: 'ALLOW', reason: 'MECHANICALLY_SAFE' });
  } catch {
    return reject('MALFORMED_CANDIDATE');
  }
}
