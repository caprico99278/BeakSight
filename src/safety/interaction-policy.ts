import {
  INTERACTION_HREF_KINDS,
  type InteractionBoundingBoxEvidence,
  type InteractionCandidateEvidence,
  type InteractionHrefKindEvidence,
  type InteractionRejectionReasonEvidence,
} from '../core/evidence-types.js';
import { isNonNegativeSafeInteger } from '../core/guards.js';
import { isSha256Fingerprint } from '../core/ids.js';

/** Interaction の候補の `href` の種類。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type InteractionHrefKind = InteractionHrefKindEvidence;

/** Interaction の候補の境界の矩形（ページ座標）。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type InteractionBoundingBox = InteractionBoundingBoxEvidence;

/** Interaction の候補の事実。定義は `src/core/evidence-types.ts` に1か所だけ置く。 */
export type InteractionCandidate = InteractionCandidateEvidence;

// L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の N3・N4）: Interaction の候補の数と長さの上限（前の
// `INTERACTION_CANDIDATE_LIMITS`。候補 100・文字 256・テキストのノード 512・属性 512・class 4,096・URL 2,048・順番 99・DOM の作業量 16,384）は撤廃した
// （定数は LZ-1 で消した）。

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

/** null か文字列か（L10: 長さは見ない）。 */
function nullableString(value: string | null): boolean {
  return value === null || typeof value === 'string';
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

/**
 * 候補が形の契約を満たすか。L10（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4。INV-LIMITS の N3・N4）: 数と長さの上限（前は順番が `maxOrdinal` 99
 * 以下、属性の長さが `maxAttributeLength`・`maxTextLength`・`maxUrlLength` 以下）は撤廃した。数と長さでは拒まず、形（種類・印の形・矩形など）だけを見る。
 */
function candidateIsWellFormed(candidate: InteractionCandidate): boolean {
  return candidate !== null
    && typeof candidate === 'object'
    && isInteractionCandidateId(candidate.candidateId)
    && isSha256Fingerprint(candidate.textFingerprint)
    && isNonNegativeSafeInteger(candidate.ordinal)
    && typeof candidate.tagName === 'string'
    && candidate.tagName.length > 0
    && nullableString(candidate.role)
    && typeof candidate.accessibleName === 'string'
    && nullableString(candidate.ariaExpanded)
    && nullableString(candidate.ariaControls)
    && nullableString(candidate.ariaSelected)
    && validAriaBoolean(candidate.ariaExpanded)
    && validAriaBoolean(candidate.ariaSelected)
    && nullableString(candidate.formMethod)
    && nullableString(candidate.formAction)
    && nullableString(candidate.href)
    && nullableString(candidate.type)
    && (INTERACTION_HREF_KINDS as readonly string[]).includes(candidate.hrefKind)
    && typeof candidate.formAssociated === 'boolean'
    && typeof candidate.download === 'boolean'
    && typeof candidate.disabled === 'boolean'
    && typeof candidate.visible === 'boolean'
    && typeof candidate.destructiveAction === 'boolean'
    && (candidate.aiAction === undefined || typeof candidate.aiAction === 'boolean')
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
 * - `EXCLUDED_CANDIDATE`: 外部への作用ではないが、安全のため機械的に除外した候補（送信・リセット・フォーム関連・同一Originの遷移・削除に関する操作）。
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
    DESTRUCTIVE_ACTION_SKIPPED: 'EXCLUDED_CANDIDATE',
    AI_ACTION_SKIPPED: 'EXCLUDED_CANDIDATE',
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
    // SD-1（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.3）: 削除に関する操作は押さない（判定は候補を作るときの `isDestructiveAction`）。
    if (candidate.destructiveAction) {
      return reject('DESTRUCTIVE_ACTION_SKIPPED');
    }
    // AIW（ユーザーの判断 2026-11-20）: AI の操作は押さない（判定は候補を作るときの `isAiAction`）。
    if (candidate.aiAction === true) {
      return reject('AI_ACTION_SKIPPED');
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
