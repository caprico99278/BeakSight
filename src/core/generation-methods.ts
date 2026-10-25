// 入力の規則の値の作り方の値の一覧（PRE42-CC 組 UI-K3。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 入力の規則の契約（`src/control/data-rules/rule-contracts.ts`）が、ここを同じ名前で公開し直す（定義は 1 か所。推した規則が持てる作り方の一覧と判定は、
//   そこのまま）。画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、管理データと Node の部品に触れずに値を読めるように、ここから読む
//   （`audit-job-values.ts` と同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。

/**
 * 値の作り方（閉じた一覧。設計書 3 章の規則の優先順位: 汎用の規則 → 業務テンプレート → 人の上書き）。
 * - `FROM_TYPE`: 欄の型と制約から（汎用の規則）。
 * - `FROM_TEMPLATE`: 業務テンプレート（顧客・予約・商品）と辞書から。
 * - `FROM_FIXED_LIST`: 人が入れた固定の値の一覧から（最も強い）。固定の値の一覧は、この作り方のときだけ 1 件以上を持つ。
 */
export const GENERATION_METHODS = Object.freeze(['FROM_TYPE', 'FROM_TEMPLATE', 'FROM_FIXED_LIST'] as const);
export type GenerationMethod = (typeof GENERATION_METHODS)[number];

/** 固定の値の一覧を持つ作り方。 */
export const FIXED_LIST_GENERATION_METHOD = 'FROM_FIXED_LIST' satisfies GenerationMethod;

/** 業務テンプレートと辞書から作る作り方（画面の規則の入力で、意味の種類を選んだときの既定）。 */
export const TEMPLATE_GENERATION_METHOD = 'FROM_TEMPLATE' satisfies GenerationMethod;
