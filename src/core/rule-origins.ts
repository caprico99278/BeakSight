// 保存した入力の規則の出どころの印の値の一覧（PRE42-CC 組 UI-K3。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 入力の規則の契約（`src/control/data-rules/rule-contracts.ts`）が、ここを同じ名前で公開し直す（定義は 1 か所。読み替えの関数 `ruleOriginOf` は、そこのまま）。
//   画面のブラウザ側（`apps/local-ui/src/` の `server/` の外）は、管理データと Node の部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と
//   同じ置き方。Gate `tests/architecture/browser-list-values.test.ts`）。

/**
 * 保存した規則の出どころの印（閉じた一覧。FM2c。規則の集まりの版 2 の `origin`）。判定の出どころ（`RULE_SOURCES`）とは別の、保存した規則の印。
 * - `HUMAN`: 人が規則の画面で決めた規則。印のない規則（印を持たずに保存した規則）も人の規則。
 * - `INFERRED`: 入力の規則の自動の作成（`rule-set-inference.ts`）が、業務テンプレートか汎用の規則で推した規則を、そのまま保存したもの（人は
 *   確かめていない）。固定の値の一覧は持たない（スキーマが拒む）。判定は、人の規則と同じく保存した規則として当てる（出どころの判定は `HUMAN`）。
 * 印は digest に入る（推した規則も承認に結ぶ）。FM2c fix round 1: 欄どうしの関係（`FieldRelation` の `origin`）と一意にする欄の組
 * （`RuleSetContent` の `uniqueKeyOrigin`）も、同じ印を持つ。
 */
export const RULE_ORIGINS = Object.freeze(['HUMAN', 'INFERRED'] as const);
export type RuleOrigin = (typeof RULE_ORIGINS)[number];

/** 印のない規則の出どころ（人の規則）。 */
export const DEFAULT_RULE_ORIGIN = 'HUMAN' satisfies RuleOrigin;
