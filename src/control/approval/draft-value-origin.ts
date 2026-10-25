// 自動で作る下書きの案の「出どころ」の印の唯一の owner（手を減らす段 2 の設計書 3A 章の共通の決まり「推測で決めた項目は、項目ごとに推測の印と根拠を
// 画面に出す」。FM2a）。純粋な部品（入出力を持たない。ほかの部品を import しない葉のファイル）。
// - 出どころ（`DraftValueOrigin`）: `DETERMINED`（発見の記録と契約から決まる）・`INFERRED`（推測。人が確かめる）・`HUMAN`（人が選ぶ・入れる）。
// - 根拠（`DraftValueGround`）は閉じた一覧で、根拠ごとに出どころは 1 つ（`DRAFT_VALUE_GROUND_ORIGINS`。同じ根拠に違う出どころを付けない）。案の値は
//   `draftValueOf` で、値と根拠と根拠の出どころを組にする。
// - 根拠と出どころの日本語の文言は `src/presentation/messages.ts` の `DRAFT_VALUE_TEXT`（書き漏れと余分は `tests/unit/api-scenario-draft.test.ts`）。
// - 印は承認に結ばない（設計書 3A 章: 表示のときに同じ純粋な部品で求め直す）。保存の形と承認の digest には入れない。
// - 使う部品: API のシナリオの下書き（FM2b）、入力の規則の自動の作成（FM2c）、自動ログインのセレクタの案（FM2e）。根拠を足すときは、この一覧と
//   文言の両方に足す。

/** 案の出どころ（閉じた一覧）。 */
export const DRAFT_VALUE_ORIGINS = Object.freeze(['DETERMINED', 'INFERRED', 'HUMAN'] as const);
export type DraftValueOrigin = (typeof DRAFT_VALUE_ORIGINS)[number];

/**
 * 根拠のコードと、その出どころ（設計書 3A.2 の項目の順）。
 * - `API_FIELDED_KEYS`: 送る鍵は、probe で欄に対応した鍵のすべて。
 * - `API_UNFIELDED_KEYS`: ページが決める鍵は、欄に対応しない鍵のうち、下書きの確かめが選べるとした鍵のすべて。
 * - `API_SHAPE_FILTER`: 更新の filter の名前は、probe の型の filter。
 * - `CONTRACT_DEFAULTS`: 上限と期限は、契約の既定。
 * - `SIDE_EFFECTS_UNCONFIRMED`: 副作用の確認の 4 項目は、必ず偽（人が確かめる）。
 * - `SINGLE_BOUND_LEDGER`: 更新の台帳は、結び付く登録がちょうど 1 つ。
 * - `ONLY_FORM_PATH_TEMPLATE`: 更新の画面の型は、保存で拒まれない型の案がちょうど 1 つ（FM2b）。
 * - `FIRST_FORM_PATH_TEMPLATE`: 更新の画面の型は、保存で拒まれない型の案（2 つ以上）の先頭（推測。FM2b で、案が 1 つのときの根拠と分けた）。
 * - `RECORD_ID_KEY_FROM_UPDATE_FILTER`: 登録の ID の応答の鍵は、同じ表の更新の filter の名前から推す。
 * - `READ_PAGE_TEMPLATE_FROM_READ_PATH`: 照合の READ の `{id}` の画面の型は、読めた画面の path から推す。
 * - `READ_EXPECTATION_FROM_VARYING_FIELD`: 照合の READ の期待（本文が含む）の欄は、入力の規則で実行のたびに値が変わる欄から推す（FM2b）。
 * - `DEFAULT_RANGE_WITHOUT_HINT`: 範囲の手がかりがない日付・数の欄に、推した規則が既定の幅を入れた（FM2c の既定の幅。FM2R の Minor 11 で印に足した）。
 * - `HUMAN_CHOICE`: 人が選んだ・入れた値（更新の変える鍵など）。
 * - `LOGIN_FIELD_SINGLE_CANDIDATE`: 自動ログインのセレクタは、手動のログインの段の始めに、ログインの画面でその欄の候補がちょうど 1 つだった要素の CSS
 *   （推測。FM2e。値は読まない）。
 */
export const DRAFT_VALUE_GROUND_ORIGINS = Object.freeze({
  API_FIELDED_KEYS: 'DETERMINED',
  API_UNFIELDED_KEYS: 'DETERMINED',
  API_SHAPE_FILTER: 'DETERMINED',
  CONTRACT_DEFAULTS: 'DETERMINED',
  SIDE_EFFECTS_UNCONFIRMED: 'DETERMINED',
  SINGLE_BOUND_LEDGER: 'DETERMINED',
  ONLY_FORM_PATH_TEMPLATE: 'DETERMINED',
  FIRST_FORM_PATH_TEMPLATE: 'INFERRED',
  RECORD_ID_KEY_FROM_UPDATE_FILTER: 'INFERRED',
  READ_PAGE_TEMPLATE_FROM_READ_PATH: 'INFERRED',
  READ_EXPECTATION_FROM_VARYING_FIELD: 'INFERRED',
  DEFAULT_RANGE_WITHOUT_HINT: 'INFERRED',
  HUMAN_CHOICE: 'HUMAN',
  LOGIN_FIELD_SINGLE_CANDIDATE: 'INFERRED',
} as const satisfies Readonly<Record<string, DraftValueOrigin>>);

export type DraftValueGround = keyof typeof DRAFT_VALUE_GROUND_ORIGINS;

/** 根拠の閉じた一覧（`DRAFT_VALUE_GROUND_ORIGINS` の順）。 */
export const DRAFT_VALUE_GROUNDS: readonly DraftValueGround[] = Object.freeze(Object.keys(DRAFT_VALUE_GROUND_ORIGINS) as DraftValueGround[]);

/** 出どころの印を付けた案の値。 */
export interface DraftValue<T> {
  readonly value: T;
  readonly origin: DraftValueOrigin;
  readonly ground: DraftValueGround;
}

/** 案の値に、根拠と根拠の出どころを付ける（凍結する。値そのものは凍結しない）。 */
export const draftValueOf = <T>(value: T, ground: DraftValueGround): DraftValue<T> =>
  Object.freeze({ value, origin: DRAFT_VALUE_GROUND_ORIGINS[ground], ground });
