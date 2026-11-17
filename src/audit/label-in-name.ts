/**
 * AUD-4b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4b）: 名前の不一致（WCAG 2.5.3 Label in Name）の比べ方の唯一の所。
 * - 入力は、AX（ブラウザのアクセシビリティの木）で算出した名前と、見えるラベルの文字のかたまり（AX の木の文字の節。文字の節ごとに 1 つ）。
 * - 見えるラベルの全部が名前に含まれるか（大文字と小文字・空白の違いは見ない）で比べる。「主なラベルが含まれるだけで常に合格」にはしない。
 * - 区分（`LABEL_IN_NAME_CLASSES`）:
 *   - `MAIN_LABEL_MISSING`: 見えるラベルのどの部分も名前にない（規則違反。確信度を下げない）。
 *   - `SUPPLEMENT_ONLY_MISSING`: 名前にない部分が、名前に含まれるかたまりとは別のかたまり（バッジの数など）だけ（確信度を下げる。名前にないかたまりを補足として残す）。
 *   - `UNDETERMINED`: 主なラベルを見分けられない（1 つのかたまりの一部だけが名前にある・名前か見えるラベルがない）。指摘を残し、確信度を下げる。
 *   - `LABEL_IN_NAME`: 見えるラベルの全部が名前にある（axe の違反だが、AX の名前で見ると含まれる）。指摘を残し、確信度を下げる（設計者の判断 2026-11-10）。
 * 純粋な関数だけのファイル（表示用モデルも、指摘ごとの区分にこれを使う）。
 */
import type { EvidencePayloadByType } from '../core/contracts.js';
import { foldNfkcCase, normalizeWhitespace } from '../core/text.js';
export const LABEL_IN_NAME_CLASSES = Object.freeze(['MAIN_LABEL_MISSING', 'SUPPLEMENT_ONLY_MISSING', 'UNDETERMINED', 'LABEL_IN_NAME'] as const);
export type LabelInNameClass = (typeof LABEL_IN_NAME_CLASSES)[number];

/** 比べた結果（主なラベルと補足は、見えるラベルのかたまりの前後の空白を除いたもの）。 */
export interface LabelInNameJudgement {
  readonly labelClass: LabelInNameClass;
  /** 名前に含まれるかたまり（`SUPPLEMENT_ONLY_MISSING`・`LABEL_IN_NAME` のとき）。 */
  readonly mainLabel: readonly string[];
  /** 名前にないかたまり（`SUPPLEMENT_ONLY_MISSING` のとき）。 */
  readonly supplements: readonly string[];
  /** 確信度を下げるか（`MAIN_LABEL_MISSING` だけ下げない）。 */
  readonly lowersConfidence: boolean;
}

/** 確信度を下げる区分か（`MAIN_LABEL_MISSING` だけ下げない）。 */
export const labelInNameLowersConfidence = (labelClass: LabelInNameClass): boolean => labelClass !== 'MAIN_LABEL_MISSING';

/** 指摘ごとの名前の文脈（表示用モデルの `verification.labelInName`。バンドルに写す）。 */
export interface LabelInNameFindingView {
  readonly labelClass: LabelInNameClass;
  /** AX で算出した名前と命名元。 */
  readonly axName: string | null;
  readonly nameSource: { readonly type: string; readonly attribute: string | null } | null;
  /** 見えるラベルの文字のかたまりと、そのうちの主なラベル・補足。 */
  readonly labelSegments: readonly string[];
  readonly mainLabel: readonly string[];
  readonly supplements: readonly string[];
}

/** 名前の不一致の指摘の Rule の ID（axe の `label-content-name-mismatch` から作る）。 */
export const LABEL_IN_NAME_RULE_ID = 'A11Y_LABEL_CONTENT_NAME_MISMATCH';

/**
 * 指摘の名前の文脈（名前の不一致の指摘で、参照する axe の Evidence に AX の名前の文脈があるときだけ。ほかは `null`）。指摘の目印 `target` と同じ selector の並びの
 * 違反の要素から引く。
 */
export function labelInNameOfFinding(
  finding: { readonly ruleId: string; readonly keys: readonly { readonly name: string; readonly value: string }[] },
  payload: EvidencePayloadByType['accessibility'],
): LabelInNameFindingView | null {
  if (finding.ruleId !== LABEL_IN_NAME_RULE_ID) {
    return null;
  }
  const target = finding.keys.find(({ name }) => name === 'target')?.value;
  const node = target === undefined
    ? undefined
    : payload.violations.flatMap((rule) => rule.nodes).find((candidate) => JSON.stringify(candidate.targetSelectors) === target);
  const context = node?.nameContext;
  if (context === undefined || context.status !== 'READ') {
    return null;
  }
  const judged = labelInNameOf({ name: context.axName, segments: context.labelSegments });
  return {
    labelClass: judged.labelClass,
    axName: context.axName,
    nameSource: context.nameSource,
    labelSegments: context.labelSegments,
    mainLabel: judged.mainLabel,
    supplements: judged.supplements,
  };
}

/** 比べるための形（互換の字と大文字・小文字を畳み込む（`foldNfkcCase`。CCX-15 の 1 か所）、空白を 1 つにまとめる）。 */
const normalized = (text: string): string => normalizeWhitespace(foldNfkcCase(text));

/** 空白で分けた語。 */
const wordsOf = (text: string): readonly string[] => normalized(text).split(' ').filter((word) => word.length > 0);

/** 見えるラベルのかたまりと、AX の名前を比べる。 */
export function labelInNameOf({ name, segments }: { readonly name: string | null; readonly segments: readonly string[] }): LabelInNameJudgement {
  const pieces = segments.map((segment) => segment.trim()).filter((segment) => normalized(segment).length > 0);
  const undetermined: LabelInNameJudgement = { labelClass: 'UNDETERMINED', mainLabel: [], supplements: [], lowersConfidence: true };
  const target = name === null ? '' : normalized(name);
  if (target.length === 0 || pieces.length === 0) {
    return undetermined;
  }
  if (target.includes(normalized(pieces.join(' ')))) {
    return { labelClass: 'LABEL_IN_NAME', mainLabel: pieces, supplements: [], lowersConfidence: true };
  }
  const contained = pieces.filter((piece) => target.includes(normalized(piece)));
  const missing = pieces.filter((piece) => !target.includes(normalized(piece)));
  const partlyContained = missing.some((piece) => wordsOf(piece).some((word) => target.includes(word)));
  if (contained.length === 0 && !partlyContained) {
    return { labelClass: 'MAIN_LABEL_MISSING', mainLabel: [], supplements: [], lowersConfidence: false };
  }
  if (contained.length > 0 && !partlyContained) {
    return { labelClass: 'SUPPLEMENT_ONLY_MISSING', mainLabel: contained, supplements: missing, lowersConfidence: true };
  }
  return undetermined;
}
