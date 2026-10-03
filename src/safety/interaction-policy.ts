import {
  INTERACTION_HREF_KINDS,
  type InteractionBoundingBoxEvidence,
  type InteractionCandidateEvidence,
  type InteractionHrefKindEvidence,
  type InteractionRejectionReasonEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { isSha256Fingerprint } from '../core/ids.js';
import { MAX_URL_LENGTH } from '../core/limits.js';

/** Interaction の候補の `href` の種類。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type InteractionHrefKind = InteractionHrefKindEvidence;

/** Interaction の候補の境界の矩形（ページ座標）。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type InteractionBoundingBox = InteractionBoundingBoxEvidence;

/** Interaction の候補の事実。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type InteractionCandidate = InteractionCandidateEvidence;

export const INTERACTION_CANDIDATE_LIMITS = Object.freeze({
  maxCandidates: 100,
  maxTextLength: 256,
  maxTextNodes: 512,
  maxAttributeLength: 512,
  /**
   * 対象自身の属性の記録で、class の値だけに使う上限（設計書 2026-09-23 4.4.1「長い class」、F20b）。
   * Tailwind などで組んだボタンは、class が `maxAttributeLength` を超えることがあるためである。
   * この上限でも切り詰められた可能性がある class の変化は、VERIFIED の根拠にしない（fail-closed）。
   */
  maxClassAttributeLength: 4_096,
  maxUrlLength: MAX_URL_LENGTH,
  maxOrdinal: 99,
  maxDomWork: 16_384,
});

/**
 * Interaction の候補を実行しない理由。閉じた一覧は `src/core/evidence-types.ts` の `INTERACTION_REJECTION_REASONS` に
 * 1か所だけ置く（Safety の Evidence の `excludedInteractionCandidates` の理由と同じ型）。
 */
export type InteractionRejectionReason = InteractionRejectionReasonEvidence;

export type InteractionAdmission =
  | { readonly action: 'ALLOW'; readonly reason: 'MECHANICALLY_SAFE' }
  | { readonly action: 'REJECT'; readonly reason: InteractionRejectionReason };

/** Interaction候補IDの接頭辞。IDは `interaction-candidate:` の後に `sha256:` の書式（`src/core/ids.ts`）が続く。 */
export const INTERACTION_CANDIDATE_ID_PREFIX = 'interaction-candidate:';

function isInteractionCandidateId(value: unknown): boolean {
  return typeof value === 'string'
    && value.startsWith(INTERACTION_CANDIDATE_ID_PREFIX)
    && isSha256Fingerprint(value.slice(INTERACTION_CANDIDATE_ID_PREFIX.length));
}

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
    && isInteractionCandidateId(candidate.candidateId)
    && isSha256Fingerprint(candidate.textFingerprint)
    && isNonNegativeSafeInteger(candidate.ordinal)
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
    && (INTERACTION_HREF_KINDS as readonly string[]).includes(candidate.hrefKind)
    && typeof candidate.formAssociated === 'boolean'
    && typeof candidate.download === 'boolean'
    && typeof candidate.disabled === 'boolean'
    && typeof candidate.visible === 'boolean'
    && finiteRectangle(candidate.boundingBox, candidate.visible)
    && (candidate.href === null) === (candidate.hrefKind === 'NONE')
    && validControlledState(candidate.ariaControls, candidate.controlledVisible, candidate.controlledHidden);
}

/** 例外を投げずに、候補が上限付きの契約を満たすかを判定する（null の boundingBox などの TypeError を契約違反として扱う）。 */
function candidateSatisfiesContract(candidate: InteractionCandidate): boolean {
  try {
    return candidateIsWellFormed(candidate);
  } catch {
    return false;
  }
}

export function freezeInteractionCandidate(candidate: InteractionCandidate): InteractionCandidate {
  if (!candidateSatisfiesContract(candidate)) {
    throw new Error('Interaction candidate is malformed or exceeds bounded contract');
  }
  return Object.freeze({
    ...candidate,
    boundingBox: Object.freeze({ ...candidate.boundingBox }),
  });
}

/**
 * 除外した候補を Safety Ledger のどの記録に残すか（設計書 2026-09-23 4.6）。
 * - `BLOCKED_EXTERNAL_ACTION`: 外部への作用（外部Origin、`tel:`・`mailto:` などの特殊scheme、ダウンロード）。
 *   `blockedExternalActions` に残す。
 * - `EXCLUDED_CANDIDATE`: 外部への作用ではないが、安全のため機械的に除外した候補（送信・リセット・フォーム関連・同一Originの遷移）。
 *   `excludedInteractionCandidates` に残す。
 * - `NONE`: 安全のための除外ではない（無効・不可視・不正な候補）。Ledger には残さない。
 */
export type InteractionRejectionLedgerRecord = 'BLOCKED_EXTERNAL_ACTION' | 'EXCLUDED_CANDIDATE' | 'NONE';

const INTERACTION_REJECTION_LEDGER_RECORDS: Readonly<Record<InteractionRejectionReason, InteractionRejectionLedgerRecord>> =
  Object.freeze({
    SUBMISSION_CONTROL: 'EXCLUDED_CANDIDATE',
    RESET_CONTROL: 'EXCLUDED_CANDIDATE',
    FORM_ASSOCIATED: 'EXCLUDED_CANDIDATE',
    NAVIGATION_HREF: 'EXCLUDED_CANDIDATE',
    EXTERNAL_ACTION: 'BLOCKED_EXTERNAL_ACTION',
    DOWNLOAD: 'BLOCKED_EXTERNAL_ACTION',
    DISABLED: 'NONE',
    NOT_VISIBLE: 'NONE',
    MALFORMED_CANDIDATE: 'NONE',
  });

/**
 * 除外理由の、Safety Ledger の記録先を返す。表にない理由（`constructor` などの、Object の既定のプロパティ名を含む）は、
 * 記録先を決めずに `TypeError` を投げる（fail-closed。DEF-003）。
 */
export function interactionRejectionLedgerRecord(reason: InteractionRejectionReason): InteractionRejectionLedgerRecord {
  if (typeof reason !== 'string' || !Object.hasOwn(INTERACTION_REJECTION_LEDGER_RECORDS, reason)) {
    throw new TypeError('Interaction rejection reason has no Safety Ledger record');
  }
  return INTERACTION_REJECTION_LEDGER_RECORDS[reason];
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
