// 既定で読まない URL の危険な語の閉じた一覧の唯一の定義（Task 25 の設計書 4.1 の `excludedPaths`。AS-b で `src/control/auth/auth-setup-contracts.ts` から
// 移した。値は変えない。設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 5 章の AS-b の Blocker の行）。
// - 認証の設定の契約（`auth-setup-contracts.ts`）は、同じ名前で公開し直す（認証つきの Run の設定の digest は変わらない）。
// - 監査の段の送信の扱いの口の組み立て（`src/orchestration/audit-send-options.ts`）が、CLI とワーカーの両方から使う（`src/control/` の外から読めるように
//   `src/core/` に置いた）。
// 純粋な定義だけのファイル（import なし）。

/**
 * 既定で読まない URL の危険な語（設計書 4.1 の `excludedPaths`。閉じた一覧。設計者の判断。GET でも状態を変える管理画面のリンクに
 * 備える。I09）。path と query にこの語を含む URL は、監査の段で読まない。判定は `src/safety/request-policy.ts`（T25b）。
 */
export const DEFAULT_EXCLUDED_URL_WORDS = Object.freeze([
  'logout',
  'signout',
  'sign-out',
  'log-out',
  'delete',
  'remove',
  'destroy',
  'cancel',
] as const);
export type DefaultExcludedUrlWord = (typeof DEFAULT_EXCLUDED_URL_WORDS)[number];
