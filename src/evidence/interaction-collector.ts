import type { InteractionChangeEvidence } from '../core/evidence-types.js';
import { GEOMETRY_EPSILON_PX } from '../core/limits.js';
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

/**
 * Evidence（`changedAttributes`）に残す、変わった属性の名前の最大件数（R5 の N-5）。
 * 名前は UTF-16 のコード単位の順に並べ、上限を超えた分は残さず、切り詰めたことを `changedAttributesTruncated` に残す（F17）。
 * 1つの名前の長さは、候補の属性の長さの上限で切り詰め済み。
 */
export const MAX_CHANGED_ATTRIBUTE_NAMES = 32;

/** 対象の位置か大きさ（`boundingBox`）が、許容誤差を超えて変わったか。 */
export function interactionGeometryChanged(before: InteractionCandidate, after: InteractionCandidate): boolean {
  const beforeRect = before.boundingBox;
  const afterRect = after.boundingBox;
  return Math.abs(beforeRect.x - afterRect.x) > GEOMETRY_EPSILON_PX
    || Math.abs(beforeRect.y - afterRect.y) > GEOMETRY_EPSILON_PX
    || Math.abs(beforeRect.width - afterRect.width) > GEOMETRY_EPSILON_PX
    || Math.abs(beforeRect.height - afterRect.height) > GEOMETRY_EPSILON_PX;
}

/**
 * 1回の観測で得た、対象の状態のうち、候補の事実の外にあるもの（設計書 2026-09-23 4.4.1）。
 * 観測の前後の比較と、安定性の確認の比較に使う。
 */
export interface InteractionStateDifference {
  /**
   * 対象の要素そのものの、変わった属性の名前。属性の記録を比べられない場合は null（その場合は根拠にしない）。
   */
  readonly changedAttributeNames: readonly string[] | null;
  /**
   * 対象の `class` の中で、増えた、または減った名前（R6 の M-2）。名前ごとに比べられない場合（属性の記録を比べられない場合、
   * class の値が class 専用の上限で切り詰められた可能性がある場合）は null。その場合、class は属性の単位で扱い、
   * class の変化は根拠にしない（設計書 2026-09-23 4.4.1「長い class」、F20b。fail-closed）。
   */
  readonly changedClassNames: readonly string[] | null;
  /**
   * 2回の観測のそれぞれの、親の `details` の `open` の有無。対象が `details` の子の `summary` でない場合は、どちらも null。
   * 値が違う場合は、開閉の状態が変わったとする。
   */
  readonly detailsOpen: { readonly before: boolean | null; readonly after: boolean | null };
}

/**
 * 安定性の確認（凍結の前の一定の時間の観測）の間に変わった項目（設計書 2026-09-23 4.4.1、R5 の N-1）。
 * `fields` の値は `changedFields` の値と同じ。`attributes` を含む場合は、対象自身の属性のすべてを不安定とみなす。
 * `attributeNames` は、不安定な属性の名前。`class` を含む場合は、class のすべてを不安定とみなす。
 * `classNames` は、class の中の不安定な名前（R6 の M-2。class を名前ごとに比べられた観測の間に、増えたか減った名前）。
 */
export interface InteractionInstability {
  readonly fields: ReadonlySet<string>;
  readonly attributeNames: ReadonlySet<string>;
  readonly classNames: ReadonlySet<string>;
}

/** 不安定な項目のない状態。 */
export const STABLE_INTERACTION_STATE: InteractionInstability = Object.freeze({
  fields: Object.freeze(new Set<string>()),
  attributeNames: Object.freeze(new Set<string>()),
  classNames: Object.freeze(new Set<string>()),
});

/** 観測していない場合の、親の `details` の開閉の状態。 */
const UNOBSERVED_DETAILS_OPEN: InteractionStateDifference['detailsOpen'] = Object.freeze({ before: null, after: null });

/**
 * 変化を VERIFIED の根拠にしない、対象自身の属性の名前（設計書 2026-09-23 4.4.1「根拠にしない属性」、R7 の Important-1）。
 * tooltip や入力の種類（hover、focus、pointer）を表す属性で、押したことで変わったまま残ることがあるためである。
 * 本物の開閉やタブの切り替えでは ARIA の状態も変わるので、これらを除いても見落とさない。
 * これらの変化は `changedAttributes` にも残さない（`changedAttributes` は根拠になった属性だけを持つ）。
 * `data-headlessui-state` は、Headless UI v2 が hover や focus の状態を1つの値にまとめて出す属性である（R8 の Important-1）。
 * 名前に `focus` か `hover` を含む `data-*` 属性は、この一覧に加えなくても、名前の決まり（`INTERACTION_NON_EVIDENCE_NAME_PATTERN`）で除く。
 */
export const INTERACTION_NON_EVIDENCE_ATTRIBUTES: ReadonlySet<string> = Object.freeze(new Set([
  'aria-describedby',
  'data-state',
  'data-focus-visible',
  'data-focused',
  'data-focus',
  'data-focus-within',
  'data-hovered',
  'data-hover',
  'data-pressed',
  'data-active',
  'data-headlessui-state',
]));

/**
 * 根拠にしない名前の決まり（設計書 2026-09-23 4.4.1「名前の決まり」、R8 の Important-1）。名前に `focus` か `hover` を含むかを、
 * 大文字と小文字を区別せずに判定する。`data-*` 属性の名前と、class の中の名前に当てはめる。当てはまる `data-*` 属性の変化と、
 * 当てはまる class の名前の増減は、根拠にしない（例: `data-focus-ring`、`Mui-focusVisible`、`is-focused`、`is-hovered`）。
 * `active` は含めない。`.active` や `is-active` は、トグルの状態を表すことが多いためである。
 * `g`・`y` のフラグを持たないので、`test` は `lastIndex` を読み書きしない（凍結しても使える）。
 */
export const INTERACTION_NON_EVIDENCE_NAME_PATTERN: RegExp = Object.freeze(/focus|hover/iu);

/** `data-*` 属性の名前の接頭辞（大文字と小文字を区別しない）。 */
const DATA_ATTRIBUTE_PREFIX_PATTERN = /^data-/iu;

/** 変わった属性 `name` が、根拠にしない属性（一覧、または名前の決まりに当てはまる `data-*` 属性）か。 */
function isNonEvidenceAttributeName(name: string): boolean {
  return INTERACTION_NON_EVIDENCE_ATTRIBUTES.has(name)
    || (DATA_ATTRIBUTE_PREFIX_PATTERN.test(name) && INTERACTION_NON_EVIDENCE_NAME_PATTERN.test(name));
}

/**
 * focus の前後で比べる、対象の ARIA の状態の属性の名前（設計書 2026-09-23 4.4.1「focus をしない要素と、focus による状態の変化」、
 * R8 の Important-2）。4.4.1 が VERIFIED の根拠として挙げる ARIA の状態である。`role="tab"` を明示した要素で、属性の変化のうち
 * 根拠にするものでもある（`ariaStateAttributesOnly`、R9 の Important-1）。
 */
const INTERACTION_ARIA_STATE_ATTRIBUTES: ReadonlySet<string> = Object.freeze(new Set([
  'aria-expanded',
  'aria-pressed',
  'aria-checked',
  'aria-selected',
]));

/**
 * 下準備の focus の前後で、対象の ARIA の状態か `aria-controls` の先の表示の状態が変わったか（設計書 2026-09-23 4.4.1、4.4.2 手順4、
 * R8 の Important-2）。`changedAttributeNames` は、2回の観測の間に変わった対象自身の属性の名前で、属性の記録を比べられない場合は null。
 * 比べられない場合は null を返す（呼び出す側は fail-closed で NOT_VERIFIABLE にする）。
 */
export function interactionTargetStateChanged(
  before: InteractionCandidate,
  after: InteractionCandidate,
  changedAttributeNames: readonly string[] | null,
): boolean | null {
  if (changedAttributeNames === null) {
    return null;
  }
  return before.ariaExpanded !== after.ariaExpanded
    || before.ariaSelected !== after.ariaSelected
    || before.controlledVisible !== after.controlledVisible
    || before.controlledHidden !== after.controlledHidden
    || changedAttributeNames.some((name) => INTERACTION_ARIA_STATE_ATTRIBUTES.has(name));
}

/**
 * 中の名前ごとに比べる属性の名前（R6 の M-2）。属性の記録で、値を class 専用の上限で記録する属性の名前でもある
 * （設計書 2026-09-23 4.4.1「長い class」、F20b。`src/interaction/discover-candidates.ts` が参照する）。
 */
export const CLASS_ATTRIBUTE_NAME = 'class';

export interface InteractionChangeEvidenceOptions {
  /** 候補の事実の外にある状態の変化。既定は、変化なし。 */
  readonly difference?: InteractionStateDifference;
  /** 安定性の確認で不安定になった項目。これらの変化は根拠にしない。既定は、不安定な項目なし。 */
  readonly instability?: InteractionInstability;
  /**
   * true の場合、対象自身の属性の変化のうち、ARIA の状態の属性（`aria-expanded`、`aria-pressed`、`aria-checked`、`aria-selected`）の
   * 変化だけを根拠にし、ほかの属性の変化は根拠にせず `changedAttributes` にも残さない（設計書 2026-09-23 4.4.1「focus をしない要素と、
   * focus による状態の変化」、R9 の Important-1）。下準備で focus をしない `role="tab"` を明示した要素に使う。focus をしないので、
   * focus や mousedown で変わる属性（roving tabindex による `tabindex`、`data-` の付かない `focused`、inline の style など）が、
   * click の後の差に出るためである。呼び出す側が `hasExplicitTabRole` で判定して渡す。既定は false。
   */
  readonly ariaStateAttributesOnly?: boolean;
}

/**
 * 2回の観測の間で変わった項目を、根拠の判定と同じ区切りで返す（安定性の確認に使う）。
 * 値は `changedFields` の値と同じ。属性は名前ごとに `attributeNames` に入れ、比べられない場合は `fields` に `attributes` を入れる。
 * class は、中の名前ごとに比べられた場合は、変わった名前を `classNames` に入れ、`attributeNames` には入れない（R6 の M-2）。
 * 名前ごとに比べられない場合は、`attributeNames` に `class` を入れる（class のすべてを不安定とみなす）。
 */
export function interactionStateChanges(
  before: InteractionCandidate,
  after: InteractionCandidate,
  difference: InteractionStateDifference,
): {
  readonly fields: readonly string[];
  readonly attributeNames: readonly string[];
  readonly classNames: readonly string[];
} {
  const fields: string[] = observedFields.filter((field) => before[field] !== after[field]);
  if (difference.detailsOpen.before !== difference.detailsOpen.after) {
    fields.push(DETAILS_OPEN_CHANGED_FIELD);
  }
  if (difference.changedAttributeNames === null) {
    fields.push(TARGET_ATTRIBUTES_CHANGED_FIELD);
  }
  const classComparedByName = difference.changedClassNames !== null;
  return Object.freeze({
    fields: Object.freeze(fields),
    attributeNames: Object.freeze((difference.changedAttributeNames ?? []).filter(
      (name) => !(classComparedByName && name === CLASS_ATTRIBUTE_NAME),
    )),
    classNames: Object.freeze([...difference.changedClassNames ?? []]),
  });
}

/**
 * 変わった属性 `name` を、根拠にするか（設計書 2026-09-23 4.4.1）。根拠にしない属性（`INTERACTION_NON_EVIDENCE_ATTRIBUTES` と、
 * 名前の決まり `INTERACTION_NON_EVIDENCE_NAME_PATTERN` に当てはまる `data-*` 属性）と、安定性の確認で不安定になった属性は、根拠にしない。
 * class は、名前ごとに比べられた場合は、安定していて、名前の決まりに当てはまらない名前が増えたか減った場合だけ根拠にする
 * （R6 の M-2、R8 の Important-1）。名前ごとに比べられない場合（class 専用の上限でも切り詰められた可能性がある場合）は、
 * 根拠にしない。どの名前が変わったかを見分けられず、安定性の確認も名前の決まりも当てはめられないためである
 * （設計書 2026-09-23 4.4.1「長い class」、F20b。fail-closed）。
 * `ariaStateAttributesOnly` が true の場合は、ARIA の状態の属性だけを根拠にする（4.4.1、R9 の Important-1）。
 */
function attributeChangeIsEvidence(
  name: string,
  changedClassNames: readonly string[] | null,
  instability: InteractionInstability,
  ariaStateAttributesOnly: boolean,
): boolean {
  if (isNonEvidenceAttributeName(name) || instability.attributeNames.has(name)) {
    return false;
  }
  if (ariaStateAttributesOnly) {
    return INTERACTION_ARIA_STATE_ATTRIBUTES.has(name);
  }
  if (name !== CLASS_ATTRIBUTE_NAME) {
    return true;
  }
  return changedClassNames !== null
    && changedClassNames.some((className) => (
      !instability.classNames.has(className) && !INTERACTION_NON_EVIDENCE_NAME_PATTERN.test(className)
    ));
}

/**
 * `changedAttributes` を上限まで残し、切り詰めたかを `changedAttributesTruncated` に残す。
 * `alreadyTruncated` は、元の観測の名前がすでに切り詰められていた場合に true にする（持続の確認）。
 * `detailsOpen` は、click の前後の親の `details` の `open` の有無で、そのまま Evidence に残す（R6 の M-4）。
 */
function evidenceOf(
  before: InteractionCandidate,
  after: InteractionCandidate,
  changedFields: readonly string[],
  changedAttributes: readonly string[],
  detailsOpen: InteractionStateDifference['detailsOpen'],
  alreadyTruncated = false,
): InteractionChangeEvidence {
  return Object.freeze({
    before,
    after,
    identityStatus: 'MATCHED',
    changedFields: Object.freeze([...changedFields]),
    changedAttributes: Object.freeze(
      [...changedAttributes].sort(compareCodeUnits).slice(0, MAX_CHANGED_ATTRIBUTE_NAMES),
    ),
    // `attributes` が根拠でない（名前が1つも残らない）場合は、切り詰めの印を残さない（R7 の Minor-3。型の説明のとおり）。
    changedAttributesTruncated: changedAttributes.length > 0
      && (alreadyTruncated || changedAttributes.length > MAX_CHANGED_ATTRIBUTE_NAMES),
    detailsOpenBefore: detailsOpen.before,
    detailsOpenAfter: detailsOpen.after,
  });
}

/**
 * 観測の前後の候補の事実と状態の変化から、VERIFIED の根拠（`changedFields`）を作る。
 * `boundingBox` の変化（平行移動も大きさの変化も）は根拠にしない。変化は `before`・`after` の `boundingBox` に記録として残る。
 * 安定性の確認で不安定になった項目と属性は、根拠にしない（設計書 2026-09-23 4.4.1）。class は、中の名前ごとに判定する（R6 の M-2）。
 * 根拠にしない属性（`INTERACTION_NON_EVIDENCE_ATTRIBUTES`）の変化も根拠にせず、`changedAttributes` にも残さない（R7 の Important-1）。
 * 対象自身の属性が根拠になった場合は、変わった属性の名前を、上限まで `changedAttributes` に残す。
 * `ariaStateAttributesOnly` が true の場合は、ARIA の状態の属性の変化だけを根拠にする（R9 の Important-1）。根拠になる属性がなければ、
 * これまでの決まりどおり `changedAttributes` は空、`changedAttributesTruncated` は false になる。
 * click の前後の親の `details` の `open` の有無は、根拠かどうかに関わらず Evidence に残す（R6 の M-4）。
 */
export function collectInteractionChangeEvidence(
  beforeInput: InteractionCandidate,
  afterInput: InteractionCandidate,
  options: InteractionChangeEvidenceOptions = {},
): InteractionChangeEvidence {
  const before = freezeInteractionCandidate(beforeInput);
  const after = freezeInteractionCandidate(afterInput);
  const instability = options.instability ?? STABLE_INTERACTION_STATE;
  const stable = (field: string): boolean => !instability.fields.has(field);
  const changedFields: string[] = observedFields.filter((field) => before[field] !== after[field] && stable(field));
  const detailsOpen = options.difference?.detailsOpen ?? UNOBSERVED_DETAILS_OPEN;
  if (detailsOpen.before !== detailsOpen.after && stable(DETAILS_OPEN_CHANGED_FIELD)) {
    changedFields.push(DETAILS_OPEN_CHANGED_FIELD);
  }
  const changedClassNames = options.difference?.changedClassNames ?? null;
  const ariaStateAttributesOnly = options.ariaStateAttributesOnly ?? false;
  const changedAttributes = stable(TARGET_ATTRIBUTES_CHANGED_FIELD)
    ? (options.difference?.changedAttributeNames ?? []).filter(
      (name) => attributeChangeIsEvidence(name, changedClassNames, instability, ariaStateAttributesOnly),
    )
    : [];
  if (changedAttributes.length > 0) {
    changedFields.push(TARGET_ATTRIBUTES_CHANGED_FIELD);
  }
  return evidenceOf(before, after, changedFields, changedAttributes, detailsOpen);
}

/**
 * 持続の確認（設計書 2026-09-23 4.4.1、R5 の N-3）。持続の確認の時間の終わりの観測（`latest`）の根拠のうち、
 * その時間の初めの観測（`earlier`）でも根拠だった項目と属性だけを残す。元に戻った変化は根拠から除く。
 * 比べるのは、Evidence に残した（上限で切り詰めた後の）名前どうしである。どちらかの観測で切り詰めていた場合は、
 * 残らなかった名前にも持続した変化がありうるので、`changedAttributesTruncated` を true にする（F17）。
 * ただし、残る名前がなく `attributes` が根拠から外れた場合は false にする（R7 の Minor-3）。
 */
export function retainPersistentInteractionChanges(
  latest: InteractionChangeEvidence,
  earlier: InteractionChangeEvidence,
): InteractionChangeEvidence {
  if (latest.before === null || latest.after === null || latest.identityStatus !== 'MATCHED') {
    return latest;
  }
  const changedAttributes = latest.changedAttributes.filter((name) => earlier.changedAttributes.includes(name));
  const changedFields = latest.changedFields.filter((field) => (
    field === TARGET_ATTRIBUTES_CHANGED_FIELD
      ? changedAttributes.length > 0
      : earlier.changedFields.includes(field)
  ));
  return evidenceOf(
    latest.before,
    latest.after,
    changedFields,
    changedAttributes,
    { before: latest.detailsOpenBefore, after: latest.detailsOpenAfter },
    latest.changedAttributesTruncated || earlier.changedAttributesTruncated,
  );
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
