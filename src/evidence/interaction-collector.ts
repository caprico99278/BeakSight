import type { InteractionChangeEvidence } from '../core/evidence-types.js';
import { compareCodeUnits } from '../core/text.js';
import {
  freezeInteractionCandidate,
  type InteractionCandidate,
} from '../safety/interaction-policy.js';

/**
 * VERIFIED の根拠にする、候補の事実の変化（設計書 2026-09-23 4.4.1）。
 * 対象の位置と大きさ（`boundingBox`）の変化は、click の結果かどうかを区別できないので、ここに含めない。
 */
const observedFields = [
  'ariaExpanded',
  'ariaSelected',
  'controlledVisible',
  'controlledHidden',
  'disabled',
  'visible',
  'textFingerprint',
] as const;

/** 対象が `details` の子の `summary` のときの、親の `details` の開閉の状態の変化を表す、`changedFields` の値。 */
export const DETAILS_OPEN_CHANGED_FIELD = 'detailsOpen';

/** 対象自身の属性の変化を表す、`changedFields` の値。 */
export const TARGET_ATTRIBUTES_CHANGED_FIELD = 'attributes';

// L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4）: Evidence（`changedAttributes`）に残す、変わった属性の名前の件数の上限（前は 32。R5 の N-5）は
// 撤廃した（全部を残す。`changedAttributesTruncated` は常に偽）。定数は LZ-1 で消した。

/**
 * 押す前と押した後の 1 回ずつの観測で得た、対象の状態のうち、候補の事実の外にあるものの差（設計書 2026-09-23 4.4.1、SPEC-5）。
 */
export interface InteractionStateDifference {
  /**
   * 対象の要素そのものの、変わった属性の名前。属性の記録を比べられない場合は null（その場合は根拠にしない）。
   */
  readonly changedAttributeNames: readonly string[] | null;
  /** 対象の `class` の中で、増えた、または減った名前（R6 の M-2）。名前ごとに比べられない場合は null（class の変化は根拠にしない）。 */
  readonly changedClassNames: readonly string[] | null;
  /**
   * 2回の観測のそれぞれの、親の `details` の `open` の有無。対象が `details` の子の `summary` でない場合は、どちらも null。
   * 値が違う場合は、開閉の状態が変わったとする。
   */
  readonly detailsOpen: { readonly before: boolean | null; readonly after: boolean | null };
}

/** 観測していない場合の、親の `details` の開閉の状態。 */
const UNOBSERVED_DETAILS_OPEN: InteractionStateDifference['detailsOpen'] = Object.freeze({ before: null, after: null });

/**
 * 根拠にしない class の名前の決まり（設計書 2026-09-23 4.4.1「名前の決まり」、R8 の Important-1）。名前に `focus` か `hover` を含むかを、
 * 大文字と小文字を区別せずに判定する。当てはまる class の名前の増減は、根拠にしない（例: `Mui-focusVisible`、`is-focused`、`is-hovered`）。
 * `active` は含めない。`.active` や `is-active` は、トグルの状態を表すことが多いためである。
 * `g`・`y` のフラグを持たないので、`test` は `lastIndex` を読み書きしない（凍結しても使える）。
 */
export const INTERACTION_NON_EVIDENCE_NAME_PATTERN: RegExp = Object.freeze(/focus|hover/iu);

/**
 * SPEC-5（設計書 2026-11-14 5.1）: 変化を根拠にする、対象自身の属性の名前（ARIA の状態と `open`）。前はタブ（`role="tab"`）だけに当てた決まり
 * （R9 の Important-1）を、全部の候補に当てる。tooltip・入力の種類（hover、focus、pointer）・roving tabindex・inline の style のように、押したことで
 * 変わったまま残る属性を、一覧や名前の決まりで除かなくても根拠にしない。class は、別に名前ごとに判定する。
 */
const INTERACTION_EVIDENCE_ATTRIBUTES: ReadonlySet<string> = Object.freeze(new Set([
  'aria-expanded',
  'aria-pressed',
  'aria-checked',
  'aria-selected',
  'open',
]));

/** 中の名前ごとに比べる属性の名前（R6 の M-2。`src/interaction/discover-candidates.ts` も参照する）。 */
export const CLASS_ATTRIBUTE_NAME = 'class';

/**
 * AUD-2（設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 5.3）: 押す前になかったモーダルの小窓が、押した後に見えるようになったことを表す、
 * `changedFields` の値。
 */
export const MODAL_DIALOG_OPENED_CHANGED_FIELD = 'modalDialogOpened';

export interface InteractionChangeEvidenceOptions {
  /** 候補の事実の外にある状態の変化。既定は、変化なし。 */
  readonly difference?: InteractionStateDifference;
  /**
   * AUD-2（5.3）: 押す前と押した後に見えていたモーダルの小窓の鍵（要素の位置。読み方は `readOpenModalDialogKeys`）。どちらかを読めなかったときは渡さない
   * （根拠にしない）。
   */
  readonly modalDialogs?: { readonly before: readonly string[]; readonly after: readonly string[] };
}

/**
 * 変わった属性 `name` を、根拠にするか（SPEC-5）。ARIA の状態の属性と `open` は根拠にする。class は、名前ごとに比べられて、名前の決まり
 * （`INTERACTION_NON_EVIDENCE_NAME_PATTERN`）に当てはまらない名前が増えたか減った場合だけ根拠にする（R6 の M-2、R8 の Important-1）。
 * ほかの属性（style・data-*・tabindex など）は根拠にしない。
 */
function attributeChangeIsEvidence(name: string, changedClassNames: readonly string[] | null): boolean {
  if (INTERACTION_EVIDENCE_ATTRIBUTES.has(name)) {
    return true;
  }
  return name === CLASS_ATTRIBUTE_NAME
    && changedClassNames !== null
    && changedClassNames.some((className) => !INTERACTION_NON_EVIDENCE_NAME_PATTERN.test(className));
}

/**
 * 変化の Evidence を作る。`detailsOpen` は、click の前後の親の `details` の `open` の有無で、そのまま Evidence に残す（R6 の M-4）。
 * `changedAttributesTruncated` は、いつも false（L2 で上限を撤廃し、SPEC-5 で持続の確認もやめた。前の版の記録のために欄だけ残す）。
 */
function evidenceOf(
  before: InteractionCandidate,
  after: InteractionCandidate,
  changedFields: readonly string[],
  changedAttributes: readonly string[],
  detailsOpen: InteractionStateDifference['detailsOpen'],
): InteractionChangeEvidence {
  return Object.freeze({
    before,
    after,
    identityStatus: 'MATCHED',
    changedFields: Object.freeze([...changedFields]),
    // L2（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4、INV-LIMITS の表 A の N13）: 名前の数の上限を置かず、全部を残す。
    changedAttributes: Object.freeze([...changedAttributes].sort(compareCodeUnits)),
    changedAttributesTruncated: false,
    detailsOpenBefore: detailsOpen.before,
    detailsOpenAfter: detailsOpen.after,
  });
}

/**
 * 押す前と押した後の 1 回ずつの観測の、候補の事実と状態の変化から、VERIFIED の根拠（`changedFields`）を作る（SPEC-5）。
 * `boundingBox` の変化（平行移動も大きさの変化も）は根拠にしない。変化は `before`・`after` の `boundingBox` に記録として残る。
 * 対象自身の属性は、`attributeChangeIsEvidence` が根拠にするものだけを `changedAttributes` に残す（名前だけ。値は残さない）。
 * click の前後の親の `details` の `open` の有無は、根拠かどうかに関わらず Evidence に残す（R6 の M-4）。
 */
export function collectInteractionChangeEvidence(
  beforeInput: InteractionCandidate,
  afterInput: InteractionCandidate,
  options: InteractionChangeEvidenceOptions = {},
): InteractionChangeEvidence {
  const before = freezeInteractionCandidate(beforeInput);
  const after = freezeInteractionCandidate(afterInput);
  const changedFields: string[] = observedFields.filter((field) => before[field] !== after[field]);
  const detailsOpen = options.difference?.detailsOpen ?? UNOBSERVED_DETAILS_OPEN;
  if (detailsOpen.before !== detailsOpen.after) {
    changedFields.push(DETAILS_OPEN_CHANGED_FIELD);
  }
  const changedClassNames = options.difference?.changedClassNames ?? null;
  const changedAttributes = (options.difference?.changedAttributeNames ?? []).filter(
    (name) => attributeChangeIsEvidence(name, changedClassNames),
  );
  if (changedAttributes.length > 0) {
    changedFields.push(TARGET_ATTRIBUTES_CHANGED_FIELD);
  }
  const modalDialogs = options.modalDialogs;
  if (modalDialogs !== undefined && modalDialogs.after.some((key) => !modalDialogs.before.includes(key))) {
    changedFields.push(MODAL_DIALOG_OPENED_CHANGED_FIELD);
  }
  return evidenceOf(before, after, changedFields, changedAttributes, detailsOpen);
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
    changedAttributes: Object.freeze([]),
    changedAttributesTruncated: false,
    detailsOpenBefore: null,
    detailsOpenAfter: null,
  });
}
