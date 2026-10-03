# R14r2 指示書: P14f の確認のレビュー（Task 14 のチェックポイントの判定）

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R14-review-brief.md` を読んでください。厳守事項、対象、重大度の基準、報告の形式は、その指示書に従ってください。

## 担当

確認のレビュー R14r（`R14r-review-result.md`）の Important-1 と Minor-1〜3 が、P14f（`P14f-report.md`）で解消したかを確かめてください。

あわせて、Task 14 の範囲に、Important 以上の問題が残っていないかを確かめてください。このレビューの結果で、Task 14 のチェックポイントを通過できるかを判断します。

- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 4.3、4.5.5、4.5.7

## とくに確かめること

1. **Important-1**
   - Guard の取り付けの失敗、page の準備の失敗、Context を閉じられた場合、閉じる処理も失敗した場合で、Ledger の違反が集計に含まれること。
   - 確かめる経路は、Passive、Interaction の session、幅の走査の session の3つである。
   - R14r の再現のスクリプト（`...\scratchpad\verify\i2.verify.ts`）を、一時ディレクトリで実行し直してかまいません。
   - `context-factory.ts` の変更で、Guard の安全の性質が後退していないこと。確かめる内容は、次のとおり。
     - Guard のない Context で処理が進まないこと。
     - fail-closed であること。
     - 所有の解放が正しいこと。
2. **Minor-1**
   - 期限が見積もりとちょうど等しい設定で、1件目の候補が監査されること。
   - 候補の発見が、Passive の期限を守ること。
3. **Minor-2**
   - 期限で止まった collector の途中までの結果が、記録されること。
   - 余裕を足しても、ページの期限の厳守（R14 の I1）が後退していないこと。
4. **全体**
   - 安全の不変条件、完了の正直さ、処理の順序、SSOT が、後退していないこと。

## 報告

`R14-review-brief.md` の形式で、日本語で返してください。前回の指摘の ID ごとに、次のどれかと、その根拠を書いてください。

- 解消
- 一部解消
- 未解消
