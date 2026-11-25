/**
 * AUD-4b（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-4b）: 名前の不一致（WCAG 2.5.3 Label in Name）の比べ方の唯一の所。
 * - 入力は、AX（ブラウザのアクセシビリティの木）で算出した名前と、見えるラベルの文字のかたまり（AX の木の文字の節。文字の節ごとに 1 つ）。
 * - APS-2（設計書 `2026-11-20-beaksight-audit-precision-and-scope-design.md` 2.3）: WCAG 2.5.3 の考え方（名前は見えるラベルを含み、先頭に置くのがよい。補足の
 *   文字は含まなくてよい）に合わせ、見えるラベルの先頭のかたまり（区切りの記号・記号だけのかたまりは除く）が名前にあるかで決める。指摘にする区分は
 *   `labelInNameIsFinding` の 1 か所（`MAIN_LABEL_MISSING` と `UNDETERMINED`）。ほかの区分の axe の違反は、証拠に残るだけで指摘にしない。
 * - 区分（`LABEL_IN_NAME_CLASSES`）:
 *   - `MAIN_LABEL_MISSING`: 見えるラベルの先頭のかたまりが、書き方をそろえても名前にない（規則違反。確信度を下げない）。
 *   - `SUPPLEMENT_ONLY_MISSING`: 先頭のかたまりは名前にあり、後のかたまり（役割・件数のバッジなど）だけが名前にない（指摘にしない）。
 *   - `UNDETERMINED`: かたまりを読めない（名前か見えるラベルがない）。指摘を残し、確信度を下げる。名前の文脈そのものがない・読めない指摘も、同じ区分の鍵を付ける。
 *   - `LABEL_IN_NAME`: 見えるラベルの全部が名前にある（axe が語に分けられない言葉の違反。指摘にしない）。
 *   - `NORMALIZED_MATCH`（AUD-5。設計書 `2026-11-19-beaksight-audit-result-review-fixes-design.md` 8.3）: 書き方をそろえる（`looseLabelFormOf`）と、見えるラベルの
 *     全部が名前に含まれる（表記の違い。指摘にしない）。
 * 純粋な関数だけのファイル（表示用モデルも、指摘ごとの区分にこれを使う）。
 */
import type { EvidencePayloadByType } from '../core/contracts.js';
import { foldNfkcCase, normalizeWhitespace } from '../core/text.js';
export const LABEL_IN_NAME_CLASSES = Object.freeze(['MAIN_LABEL_MISSING', 'SUPPLEMENT_ONLY_MISSING', 'UNDETERMINED', 'LABEL_IN_NAME', 'NORMALIZED_MATCH'] as const);
export type LabelInNameClass = (typeof LABEL_IN_NAME_CLASSES)[number];

/** 比べた結果（主なラベルと補足は、見えるラベルのかたまりの前後の空白を除いたもの）。 */
export interface LabelInNameJudgement {
  readonly labelClass: LabelInNameClass;
  /** 名前に含まれるかたまり（`SUPPLEMENT_ONLY_MISSING`・`LABEL_IN_NAME`・`NORMALIZED_MATCH` のとき）。 */
  readonly mainLabel: readonly string[];
  /** 名前にない、先頭より後のかたまり（`SUPPLEMENT_ONLY_MISSING` のとき）。 */
  readonly supplements: readonly string[];
  /** 確信度を下げるか（`MAIN_LABEL_MISSING` だけ下げない）。 */
  readonly lowersConfidence: boolean;
}

/** 確信度を下げる区分か（`MAIN_LABEL_MISSING` だけ下げない）。 */
export const labelInNameLowersConfidence = (labelClass: LabelInNameClass): boolean => labelClass !== 'MAIN_LABEL_MISSING';

/** APS-2: 指摘にする区分か（先頭のかたまりが名前にない・かたまりを読めない）。 */
export const labelInNameIsFinding = (labelClass: LabelInNameClass): boolean => labelClass === 'MAIN_LABEL_MISSING' || labelClass === 'UNDETERMINED';

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

/**
 * AUD-5（8.3）: 書き方をそろえた形（正規化の 1 か所）。全角と半角・大文字と小文字は畳み込み（`foldNfkcCase`）、数字の並びは前の 0 を除いた数の並びにし、
 * 数字のほかは、空白・区切りの記号・記号を除いた文字にする。
 */
export interface LooseLabelForm {
  readonly numbers: readonly string[];
  readonly letters: string;
}

/** 書き方をそろえた形を作る（純粋な関数）。 */
export function looseLabelFormOf(text: string): LooseLabelForm {
  const folded = foldNfkcCase(text);
  const numbers = [...folded.matchAll(/\p{Nd}+/gu)].map(([digits]) => digits.replace(/^0+(?=\d)/u, ''));
  const letters = folded.replace(/\p{Nd}+|[\s\p{P}\p{S}]+/gu, '');
  return { numbers, letters };
}

/** そろえた形で、見えるラベルが名前に含まれるか（数の並びが続きのまま含まれ、ほかの文字が続きのまま含まれる。どちらも空なら含まれない）。 */
const looselyContains = (name: LooseLabelForm, label: LooseLabelForm): boolean => {
  if (label.numbers.length === 0 && label.letters.length === 0) {
    return false;
  }
  const numbersContained = label.numbers.length === 0 || name.numbers.some((_number, start) =>
    label.numbers.every((number, offset) => name.numbers[start + offset] === number));
  return numbersContained && name.letters.includes(label.letters);
};

/** そろえた形が空でない（区切りの記号・記号・空白だけでない）かたまりか。 */
const hasLooseText = (piece: string): boolean => {
  const form = looseLabelFormOf(piece);
  return form.numbers.length > 0 || form.letters.length > 0;
};

/** 見えるラベルのかたまりと、AX の名前を比べる（かたまりの比べ方は、そのままの形か、そろえた形のどちらかで含まれるか）。 */
export function labelInNameOf({ name, segments }: { readonly name: string | null; readonly segments: readonly string[] }): LabelInNameJudgement {
  // APS-2: 区切りの記号・記号だけのかたまりは、比べるかたまりに入れない（先頭にもしない）。
  const pieces = segments.map((segment) => segment.trim()).filter(hasLooseText);
  const target = name === null ? '' : normalized(name);
  if (target.length === 0 || pieces.length === 0) {
    return { labelClass: 'UNDETERMINED', mainLabel: [], supplements: [], lowersConfidence: true };
  }
  if (target.includes(normalized(pieces.join(' ')))) {
    return { labelClass: 'LABEL_IN_NAME', mainLabel: pieces, supplements: [], lowersConfidence: true };
  }
  const looseName = looseLabelFormOf(name ?? '');
  // AUD-5（8.3）: 書き方をそろえると全部が含まれるなら、表記の違い。
  if (looselyContains(looseName, looseLabelFormOf(pieces.join(' ')))) {
    return { labelClass: 'NORMALIZED_MATCH', mainLabel: pieces, supplements: [], lowersConfidence: true };
  }
  const inName = (piece: string): boolean => target.includes(normalized(piece)) || looselyContains(looseName, looseLabelFormOf(piece));
  const [leading] = pieces;
  if (leading === undefined || !inName(leading)) {
    return { labelClass: 'MAIN_LABEL_MISSING', mainLabel: [], supplements: [], lowersConfidence: false };
  }
  return {
    labelClass: 'SUPPLEMENT_ONLY_MISSING',
    mainLabel: pieces.filter(inName),
    supplements: pieces.filter((piece) => !inName(piece)),
    lowersConfidence: true,
  };
}
