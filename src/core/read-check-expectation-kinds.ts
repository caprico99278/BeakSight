// READ の確かめの期待の種類の値の一覧（PRE42-CC 組 UI-K2。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - READ の確かめの契約の SSOT（`src/discovery/read-check-contracts.ts`）が、ここを同じ名前で公開し直す（定義は 1 か所。定義の JSON Schema との一致も、
//   そこを通して確かめる）。画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、発見の部品と Node の部品に触れずに値を読めるように、ここから
//   読む（`audit-job-values.ts` と同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。

/**
 * 期待の種類（Task 27 の設計書 4.5。閉じた一覧）。
 * - `ROW_COUNT_EQUALS`・`ROW_COUNT_AT_LEAST`: 構造にした結果の行の数が、ちょうど・少なくとも `count`。
 * - `TEXT_CONTAINS`: ページの本文が `text` を含む。
 * - `DETAIL_FIELD_EQUALS`: 詳細（`dl` など）の項目 `field` の値が `value`。
 */
export const READ_CHECK_EXPECTATION_KINDS = Object.freeze([
  'ROW_COUNT_EQUALS',
  'ROW_COUNT_AT_LEAST',
  'TEXT_CONTAINS',
  'DETAIL_FIELD_EQUALS',
] as const);
export type ReadCheckExpectationKind = (typeof READ_CHECK_EXPECTATION_KINDS)[number];

/** 行の数を照らす期待の種類（入力は `count`）。 */
export const ROW_COUNT_EXPECTATION_KINDS = Object.freeze(['ROW_COUNT_EQUALS', 'ROW_COUNT_AT_LEAST'] as const satisfies readonly ReadCheckExpectationKind[]);

/**
 * 照合の READ で使える期待の種類（Task 27 の期待の種類のうち、1 件の登録を確かめられるもの）。`ROW_COUNT_AT_LEAST` は、二重の登録を見分け
 * られないので使わない。`TEXT_CONTAINS`・`DETAIL_FIELD_EQUALS` の比べる値は、生成した値（送る欄の名前で指す）。PRE42-CC 組 UI-K3（台帳の CC-113）:
 * シナリオの契約（`src/control/approval/scenario-contracts.ts`）から移した（そこは同じ名前で公開し直す。画面の検証の指定の入力が読む）。
 */
export const VERIFICATION_EXPECTATION_KINDS = Object.freeze(
  ['ROW_COUNT_EQUALS', 'TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS'] as const satisfies readonly ReadCheckExpectationKind[],
);
export type VerificationExpectationKind = (typeof VERIFICATION_EXPECTATION_KINDS)[number];

/** ちょうど `count` 行（照合の READ の行の数の期待）。 */
export const ROW_COUNT_EQUALS_EXPECTATION_KIND = 'ROW_COUNT_EQUALS' satisfies ReadCheckExpectationKind;

/** 少なくとも `count` 行（画面の READ の確かめの定義の入力の、最初の期待の既定）。 */
export const ROW_COUNT_AT_LEAST_EXPECTATION_KIND = 'ROW_COUNT_AT_LEAST' satisfies ReadCheckExpectationKind;

/** ページの本文が `text` を含む。 */
export const TEXT_CONTAINS_EXPECTATION_KIND = 'TEXT_CONTAINS' satisfies ReadCheckExpectationKind;

/** 詳細の項目 `field` の値が `value`。 */
export const DETAIL_FIELD_EQUALS_EXPECTATION_KIND = 'DETAIL_FIELD_EQUALS' satisfies ReadCheckExpectationKind;
