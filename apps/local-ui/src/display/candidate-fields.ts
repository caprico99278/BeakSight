/**
 * 入力の欄の属性と制約の表示の文字（CCX-29。CC-080 の (b)）。操作の候補の画面（候補の詳しい内容）、シナリオの画面（作成・変更のフォーム、詳細、
 * 生成の規則）が共用する。ブラウザでも動く純粋な部品（型だけを `../server/discovery-documents` から読む）。
 * - 属性: 必須・読み取り専用・無効・見えない の順に、当たるものを一覧の区切り（`listText`）で並べる。当たるものがなければ「なし」。
 * - 制約: `名前="値"` を、欄の制約の順に一覧の区切りで並べる（値は `JSON.stringify` で引用符を付ける）。制約がなければ「なし」。
 * - 文言は `src/presentation/messages.ts` の `LOCAL_UI_DISCOVERY_TEXT`（`flags`・`noFlags`・`noConstraints`）。
 */
import { LOCAL_UI_DISCOVERY_TEXT, listText } from '../../../../src/presentation/messages.js';
import type { CandidateFieldConstraintView } from '../server/discovery-documents';

/** 属性の表示に使う、欄の 4 つの属性。 */
export interface CandidateFieldFlagsView {
  readonly required: boolean;
  readonly readonly: boolean;
  readonly disabled: boolean;
  readonly hidden: boolean;
}

/** 入力の欄の属性（必須・読み取り専用・無効・見えない）の表示。 */
export const candidateFieldFlagsText = (field: CandidateFieldFlagsView): string => {
  const flags = LOCAL_UI_DISCOVERY_TEXT.flags;
  const shown: readonly string[] = [
    ...(field.required ? [flags.required] : []),
    ...(field.readonly ? [flags.readonly] : []),
    ...(field.disabled ? [flags.disabled] : []),
    ...(field.hidden ? [flags.hidden] : []),
  ];
  return shown.length === 0 ? LOCAL_UI_DISCOVERY_TEXT.noFlags : listText(shown);
};

/** 入力の欄の制約の表示（`名前="値"` の並び）。 */
export const candidateFieldConstraintsText = (field: Readonly<{ constraints: readonly CandidateFieldConstraintView[] }>): string =>
  (field.constraints.length === 0
    ? LOCAL_UI_DISCOVERY_TEXT.noConstraints
    : listText(field.constraints.map((constraint) => `${constraint.name}=${JSON.stringify(constraint.value)}`)));
