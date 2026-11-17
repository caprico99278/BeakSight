/**
 * AUD-9b（設計書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md`）: 同じ UI の繰り返しの「候補群」の唯一の owner。表示用モデルが 1 回だけ呼ぶ
 * （`ReportViewModel.findingGroups`）。HTML・CLI・バンドルは、組み直さない。
 * - 群の鍵は、ruleId と Finding の `groupingKeys`（AUD-9a。順はそのまま）。URL・ページ・ビューポートは鍵に入れない。
 * - 設計者の判断（2026-11-09。ユーザーの方針「数でなく、見えた違いで決める」）: 要素の作りの印（`FindingStructureView`。タグの名前と class の並び。axe の
 *   `htmlSnippet` の最初の開きタグから取る）が取れる Finding は、selector の番号（`:nth-of-type(n)`・`:nth-child(n)` の数）を丸めた鍵に、作りの印を足して
 *   群にする（同じ作りのカードがページの数だけ分かれない。作りの違う要素は混ざらない）。作りの印が取れない Finding は、番号を丸めない。作りの印には、文字の中身と
 *   class のほかの属性の値を入れない。
 * - `groupingKeys` が空か、ない（古い Run の Finding）Finding は、1 件だけの群にする（鍵に Finding の ID を入れる）。
 * - 確信度は `FINDING_GROUP_CONFIDENCE_BY_BASIS` と `findingGroupConfidenceOf` の 1 か所で決める。確信度は、並びに使わない（並びは severity の順のまま）。
 */
import { labelInNameLowersConfidence } from '../audit/label-in-name.js';
import type { RuleVerificationBasis } from '../audit/rule-verification-basis.js';
import {
  VIEWPORT_PROFILES,
  type EvidenceRecord,
  type Finding,
  type FindingCategory,
  type FindingGroupingKeyRecord,
  type FindingId,
  type PageId,
  type Severity,
  type ViewportProfile,
} from '../core/contracts.js';
import { sha256HexOfText } from '../core/ids.js';
import { isSecretLikeText } from '../core/secret-like-text.js';
import { SEVERITY_CATALOG, VIEWPORT_PROFILE_CATALOG, sortByDisplayOrder } from '../presentation/catalog.js';
import type { FindingView, FindingVerificationView } from './view-model.js';

/** 群の確信度の閉じた一覧（高い順）。 */
export const FINDING_GROUP_CONFIDENCES = Object.freeze(['HIGH', 'MEDIUM', 'LOW'] as const);
export type FindingGroupConfidence = (typeof FINDING_GROUP_CONFIDENCES)[number];

/**
 * 検証の根拠ごとの、もとの確信度（描いた画面・読み込みの結果・操作で確かめたものは高め、文書の構造から見た候補は中）。`Record` なので、根拠を足すと書き漏れが
 * 型のエラーになる。
 */
export const FINDING_GROUP_CONFIDENCE_BY_BASIS: Readonly<Record<RuleVerificationBasis, FindingGroupConfidence>> = Object.freeze({
  STATIC_CANDIDATE: 'MEDIUM',
  RENDERED: 'HIGH',
  NAVIGATION_OBSERVED: 'HIGH',
  INTERACTION_REPRODUCED: 'HIGH',
});

/** 発生がこの数より少ない、文書の構造から見た候補の群は、1 段下げる（同じ作りの所で繰り返し見えたことが、候補の裏づけになるため）。 */
export const FINDING_GROUP_REPEATED_OCCURRENCE_COUNT = 2;

const lower = (confidence: FindingGroupConfidence): FindingGroupConfidence =>
  FINDING_GROUP_CONFIDENCES[Math.min(FINDING_GROUP_CONFIDENCES.indexOf(confidence) + 1, FINDING_GROUP_CONFIDENCES.length - 1)] ?? 'LOW';

/**
 * 群の確信度（決め方はここだけ）。
 * 1. もとの値は、検証の根拠の表（`FINDING_GROUP_CONFIDENCE_BY_BASIS`）。
 * 2. 証拠の参照に欠けのある指摘が 1 件でもあれば、1 段下げる。
 * 3. 文書の構造から見た候補（`STATIC_CANDIDATE`）で、発生が `FINDING_GROUP_REPEATED_OCCURRENCE_COUNT` より少なければ、1 段下げる。発生が多くても上げない。
 * 4. AUD-2d: 落ち着いた後の確かめ直しで消えた（`INITIAL_ONLY`）指摘が 1 件でもあれば、1 段下げる（初めの骨組みの時だけの見え方の候補）。
 * 5. AUD-3c: 固定の要素の重なりで、描画の遮蔽を決められない（`verification.overlap.renderDetermined` が偽）指摘が 1 件でもあれば、1 段下げる
 *    （設計者の判断 2026-11-10: 押下だけを捕まえる `POINTER_ONLY` は、hit-test で直接確かめた事実なので下げない）。AUD-4b: 名前の不一致で、主なラベルの欠けと
 *    言い切れない指摘（`labelInNameLowersConfidence`）も、この印で 1 段下げる（同じ「決めきれない」の印）。AUD-7: 4xx・5xx の区分が `UNDETERMINED` の指摘も同じ。
 */
export function findingGroupConfidenceOf(
  basis: RuleVerificationBasis,
  occurrenceCount: number,
  hasMissingEvidence: boolean,
  hasInitialOnly = false,
  hasUndeterminedRender = false,
): FindingGroupConfidence {
  let confidence = FINDING_GROUP_CONFIDENCE_BY_BASIS[basis];
  if (hasMissingEvidence) {
    confidence = lower(confidence);
  }
  if (hasInitialOnly) {
    confidence = lower(confidence);
  }
  if (hasUndeterminedRender) {
    confidence = lower(confidence);
  }
  if (basis === 'STATIC_CANDIDATE' && occurrenceCount < FINDING_GROUP_REPEATED_OCCURRENCE_COUNT) {
    confidence = lower(confidence);
  }
  return confidence;
}

/** 群の検証の状態の集まり（Rule の根拠と、指摘の `verification.status` の別の数。0 件の状態は持たない）。 */
export interface FindingGroupVerificationView {
  readonly basis: RuleVerificationBasis;
  readonly byStatus: Readonly<Partial<Record<FindingVerificationView['status'], number>>>;
}

/** 候補群の 1 つ。 */
export interface FindingGroupView {
  /** 鍵から決まる安定した値（`FG-` と、鍵の SHA-256 の先頭 16 桁）。 */
  readonly groupId: string;
  readonly ruleId: string;
  /** 群のいちばん重い severity（並びに使う）。 */
  readonly severity: Severity;
  readonly category: FindingCategory;
  /** 鍵（作りの印のある群は selector の番号を丸めた `groupingKeys`、ほかは最初の指摘の `groupingKeys` の写し。鍵のない指摘は空）。 */
  readonly groupingKeys: readonly FindingGroupingKeyRecord[];
  /** 要素の作りの印（タグの名前と class の並び）。取れなかった群は `null`（そのときは番号を丸めていない）。 */
  readonly structure: FindingStructureView | null;
  /** 群の指摘の ID の全部（`AuditRunResult.findings` の順）。 */
  readonly findingIds: readonly FindingId[];
  /** 影響したページの ID（最初に出た順。ページによらない指摘は数えない）と、その数。 */
  readonly pageIds: readonly PageId[];
  readonly pageCount: number;
  /** 発生の数（指摘の数）。 */
  readonly occurrenceCount: number;
  /** 出たビューポート（表示の順。ビューポートによらない指摘は数えない）。 */
  readonly viewports: readonly ViewportProfile[];
  readonly verification: FindingGroupVerificationView;
  readonly confidence: FindingGroupConfidence;
  /** 証拠の参照に欠けのある指摘（`verification.status` が `UNVERIFIED`）の数。 */
  readonly missingEvidenceFindingCount: number;
}

/** 要素の作りの印（タグの名前は小文字、class は書かれた順。値（文字の中身・ほかの属性の値）は持たない）。 */
export interface FindingStructureView {
  readonly tagName: string;
  readonly classNames: readonly string[];
}

/** HTML の抜粋の最初の開きタグ（タグの名前と、属性の部分）。 */
const OPENING_TAG = /^\s*<([A-Za-z][A-Za-z0-9-]*)(\s[^>]*)?\/?>?/u;
/** 開きタグの属性の部分の、class の値。 */
const CLASS_ATTRIBUTE = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/iu;

/**
 * axe の `htmlSnippet` の最初の開きタグから、要素の作りの印を取る（取れなければ `null`）。class の名前に秘密に見える文字（`isSecretLikeText`）があれば、取らない。
 */
export function structureOfHtmlSnippet(snippet: string): FindingStructureView | null {
  const tag = OPENING_TAG.exec(snippet);
  if (tag?.[1] === undefined) {
    return null;
  }
  const classMatch = CLASS_ATTRIBUTE.exec(tag[2] ?? '');
  const classNames = (classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? '').split(/\s+/u).filter((name) => name.length > 0);
  if (classNames.some((name) => isSecretLikeText(name))) {
    return null;
  }
  return { tagName: tag[1].toLowerCase(), classNames };
}

/** selector の番号（`:nth-of-type(<数>)`・`:nth-child(<数>)`）。 */
const SELECTOR_NUMBER = /:(nth-of-type|nth-child)\(\s*\d+\s*\)/gu;

/** selector の番号を `n` に丸める（作りの印のある Finding の鍵だけに使う）。 */
export const roundSelectorNumbers = (value: string): string => value.replace(SELECTOR_NUMBER, (_whole, kind: string) => `:${kind}(n)`);

/** Finding のまとめの鍵 `target`（作りの印を取る要素の selector の並び。なければ `undefined`）。 */
export const structureTargetOf = (finding: Pick<Finding, 'groupingKeys'>): string | undefined =>
  (finding.groupingKeys ?? []).find(({ name }) => name === 'target')?.value;

/**
 * accessibility の Evidence の、まとめの鍵 `target` と同じ selector の要素の作りの印（`htmlSnippet` から。違反と確認が必要なものの両方を見る）。要素が
 * 見つからなければ `undefined`、作りの印が取れなければ `null`。
 */
export function structureInAccessibilityRecord(record: EvidenceRecord, target: string): FindingStructureView | null | undefined {
  if (record.type !== 'accessibility') {
    return undefined;
  }
  for (const rule of [...record.payload.violations, ...record.payload.incomplete]) {
    const node = rule.nodes.find((candidate) => JSON.stringify(candidate.targetSelectors) === target);
    if (node !== undefined) {
      return structureOfHtmlSnippet(node.htmlSnippet);
    }
  }
  return undefined;
}

/**
 * Finding の要素の作りの印を引く関数（`AuditRunResult.findings` の添字から）。表示用モデルが、参照する accessibility の Evidence から先に引いておく
 * （Finding の参照の順で、要素が見つかった最初の Evidence の `structureInAccessibilityRecord`。`target` の鍵がない、要素が見つからない、作りの印が取れなければ
 * `null`）。
 */
export type FindingStructureOf = (findingIndex: number) => FindingStructureView | null;

/** 群の鍵（鍵の文字列と、群に出す鍵と作りの印）。 */
interface GroupKey {
  readonly key: string;
  readonly groupingKeys: readonly FindingGroupingKeyRecord[];
  readonly structure: FindingStructureView | null;
}

/**
 * 群の鍵（ruleId と groupingKeys。作りの印があれば、selector の番号を丸めた鍵と作りの印。鍵のない指摘は、その Finding の ID を入れて 1 件の群にする）。
 */
const groupKeyOf = (view: FindingView, structure: FindingStructureView | null): GroupKey => {
  const keys = (view.finding.groupingKeys ?? []).map(({ name, value }) => ({ name, value }));
  if (keys.length === 0) {
    return { key: JSON.stringify(['SINGLE', view.finding.ruleId, view.finding.findingId]), groupingKeys: [], structure: null };
  }
  if (structure === null) {
    return { key: JSON.stringify(['KEYS', view.finding.ruleId, keys.map(({ name, value }) => [name, value])]), groupingKeys: keys, structure: null };
  }
  const rounded = keys.map(({ name, value }) => ({ name, value: roundSelectorNumbers(value) }));
  return {
    key: JSON.stringify(['STRUCTURE', view.finding.ruleId, rounded.map(({ name, value }) => [name, value]), structure.tagName, structure.classNames]),
    groupingKeys: rounded,
    structure,
  };
};

const severityOrder = (severity: Severity): number => SEVERITY_CATALOG[severity].order;

/**
 * 候補群を組む（`AuditRunResult.findings` の順の Finding から）。並びは、群のいちばん重い severity の表示の順、同じなら最初の指摘が出た順（数・確信度では並べない）。
 * `structureOf` は、Finding の要素の作りの印（`FindingStructureOf`。MEM-4: 表示用モデルが、Evidence の記録を持たずに先に引いておく）。
 */
export function buildFindingGroups(
  findings: readonly FindingView[],
  structureOf: FindingStructureOf,
): readonly FindingGroupView[] {
  const members = new Map<string, { readonly first: number; readonly groupKey: GroupKey; readonly views: FindingView[] }>();
  findings.forEach((view, index) => {
    const groupKey = groupKeyOf(view, structureOf(index));
    const known = members.get(groupKey.key);
    if (known === undefined) {
      members.set(groupKey.key, { first: index, groupKey, views: [view] });
    } else {
      known.views.push(view);
    }
  });
  const viewportOrder = sortByDisplayOrder(VIEWPORT_PROFILES, VIEWPORT_PROFILE_CATALOG);
  return [...members]
    .map(([key, { first, groupKey, views }]) => {
      const [head] = views as [FindingView, ...FindingView[]];
      const severity = views.map(({ finding }) => finding.severity).sort((left, right) => severityOrder(left) - severityOrder(right))[0] ?? head.finding.severity;
      const pageIds = [...new Set(views.flatMap(({ finding }) => (finding.pageId === null ? [] : [finding.pageId])))];
      const viewports = new Set(views.flatMap(({ finding }) => (finding.viewport === null ? [] : [finding.viewport])));
      const byStatus: Partial<Record<FindingVerificationView['status'], number>> = {};
      for (const { verification } of views) {
        byStatus[verification.status] = (byStatus[verification.status] ?? 0) + 1;
      }
      const missingEvidenceFindingCount = byStatus.UNVERIFIED ?? 0;
      const basis = head.verification.basis;
      const group: FindingGroupView = {
        groupId: `FG-${sha256HexOfText(key).slice(0, 16)}`,
        ruleId: head.finding.ruleId,
        severity,
        category: head.finding.category,
        groupingKeys: groupKey.groupingKeys,
        structure: groupKey.structure,
        findingIds: views.map(({ finding }) => finding.findingId),
        pageIds,
        pageCount: pageIds.length,
        occurrenceCount: views.length,
        viewports: viewportOrder.filter((viewport) => viewports.has(viewport)),
        verification: { basis, byStatus },
        confidence: findingGroupConfidenceOf(
          basis,
          views.length,
          missingEvidenceFindingCount > 0,
          views.some(({ verification }) => verification.recheck === 'INITIAL_ONLY'),
          // AUD-4b: 名前の不一致で、主なラベルの欠けと言い切れない指摘（補足だけ・見分けられない・AX の名前には含まれる）も、同じく 1 段下げる。
          // AUD-7: 4xx・5xx の区分を決められない（`UNDETERMINED`）指摘も、同じく 1 段下げる。
          views.some(({ verification }) => verification.overlap?.renderDetermined === false
            || (verification.labelInName !== undefined && labelInNameLowersConfidence(verification.labelInName.labelClass))
            || verification.httpError?.errorClass === 'UNDETERMINED'),
        ),
        missingEvidenceFindingCount,
      };
      return { first, group };
    })
    .sort((left, right) => severityOrder(left.group.severity) - severityOrder(right.group.severity) || left.first - right.first)
    .map(({ group }) => group);
}
