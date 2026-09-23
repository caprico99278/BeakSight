import {
  freezeInteractionCandidate,
  type InteractionCandidate,
} from '../safety/interaction-policy.js';

export interface InteractionChangeEvidence {
  readonly before: InteractionCandidate | null;
  readonly after: InteractionCandidate | null;
  readonly identityStatus: 'MATCHED' | 'MISSING' | 'AMBIGUOUS' | 'REPLACED' | 'UNESTABLISHED';
  readonly changedFields: readonly string[];
}

const observedFields = [
  'ariaExpanded',
  'ariaSelected',
  'controlledVisible',
  'controlledHidden',
  'disabled',
  'visible',
  'textFingerprint',
] as const;
const INTERACTION_GEOMETRY_EPSILON_PX = 0.5;

export function collectInteractionChangeEvidence(
  beforeInput: InteractionCandidate,
  afterInput: InteractionCandidate,
): InteractionChangeEvidence {
  const before = freezeInteractionCandidate(beforeInput);
  const after = freezeInteractionCandidate(afterInput);
  const changedFields: string[] = observedFields.filter((field) => before[field] !== after[field]);
  const beforeRect = before.boundingBox;
  const afterRect = after.boundingBox;
  if (
    Math.abs(beforeRect.x - afterRect.x) > INTERACTION_GEOMETRY_EPSILON_PX
    || Math.abs(beforeRect.y - afterRect.y) > INTERACTION_GEOMETRY_EPSILON_PX
    || Math.abs(beforeRect.width - afterRect.width) > INTERACTION_GEOMETRY_EPSILON_PX
    || Math.abs(beforeRect.height - afterRect.height) > INTERACTION_GEOMETRY_EPSILON_PX
  ) {
    changedFields.push('boundingBox');
  }
  return Object.freeze({
    before,
    after,
    identityStatus: 'MATCHED',
    changedFields: Object.freeze(changedFields),
  });
}

/** 保持していたノードが切断された後にのみ、実在する意味的な等価要素を分類する。 */
export function collectDisconnectedInteractionEvidence(
  beforeInput: InteractionCandidate,
  liveCandidates: readonly InteractionCandidate[],
): InteractionChangeEvidence {
  const before = freezeInteractionCandidate(beforeInput);
  const matching = liveCandidates.filter((candidate) => candidate.candidateId === before.candidateId);
  return Object.freeze({
    before,
    after: null,
    identityStatus: matching.length === 0 ? 'MISSING' : matching.length === 1 ? 'REPLACED' : 'AMBIGUOUS',
    changedFields: Object.freeze([]),
  });
}
