// 保存してある認証の設定の新しさの値の一覧（PRE42-CC 組 UI-K2。台帳の CC-113）。純粋な定義だけのファイル（import を持たない）。
// - 認証の設定の保存の owner（`src/control/store/auth-setup-store.ts`）が、ここを同じ名前で公開し直す（定義は 1 か所）。画面のブラウザ側（`apps/local-ui/src/`
//   の `server/` の外）は、管理データと Node の部品に触れずに値を読めるように、ここから読む（`audit-job-values.ts` と同じ置き方。値を文字列で比べない。
//   Gate `tests/architecture/browser-list-values.test.ts`）。

/** 保存してある設定が、今のプロファイルの改訂に結びつくか（`CURRENT`）、古いか（`STALE`。改訂が変わった、取り消した）。 */
export const AUTH_SETUP_FRESHNESS_VALUES = Object.freeze(['CURRENT', 'STALE'] as const);
export type AuthSetupFreshness = (typeof AUTH_SETUP_FRESHNESS_VALUES)[number];

/** 今のプロファイルの改訂に結びつく設定（監査を始められる）。 */
export const CURRENT_AUTH_SETUP_FRESHNESS = 'CURRENT' satisfies AuthSetupFreshness;

/** 古い設定（改訂が変わった、取り消した。監査を始めない）。 */
export const STALE_AUTH_SETUP_FRESHNESS = 'STALE' satisfies AuthSetupFreshness;
