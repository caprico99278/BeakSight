// Run の実行（起動）の記録から「最後の実行」を選ぶ唯一の部品（PRE42-CC 組 UI-K。台帳の CC-048 の画面の側）。純粋な関数だけのファイル。
// - 最後の実行は、その Run を確定した実行である（`RunSummary.executions` の説明。中断した Run の再開の設計書 4.8）。
// - 使う所: 表示用モデルの実行の記録の表示（`src/report/view-model.ts` の `executionsView`。CLI と HTML レポート）、再開の判定（保存した
//   チェックポイントの記録を読む `src/orchestration/run-coordinator.ts`）、画面のサーバ（書き出し済みの `run.json` を読む
//   `apps/local-ui/src/server/audit-job-functions.ts`）。どれも表示用モデルを読めない段・置き場所なので、選び方だけをここに置く。
// - 選び方（`….executions.at(-1)` の形）を書くのはここだけ（`tests/architecture/core-small-parts-ownership.test.ts` の (h)）。

/** 実行の記録の最後の実行。記録が空（読み取った古い・壊れた文書）なら `undefined`。 */
export const lastRunExecutionOf = <TExecution>(executions: readonly TExecution[]): TExecution | undefined => executions.at(-1);
