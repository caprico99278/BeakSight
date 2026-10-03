# RT12r3 指示書: RT12f の確認のレビュー（Task 12・13 の最終確認）

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `RT12-review-brief.md` を読んでください。厳守事項、重大度の基準、報告の形式は、その指示書に従ってください。

## 担当

確認のレビュー RT12r2（`RT12r2-review-result.md`）の指摘 I1・M1・M2 が、RT12f（`RT12f-report.md`）で解消したかを確かめてください。M3 は、設計者が制約として受け入れたので、対象外です。このレビューで Critical と Important がなければ、Task 12・13 を完了とします。

- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2
  - `TEXT_CLIPPING` の判定の方法（片側ずつの比較、見えない子孫）
  - `ZERO_SIZE_INTERACTIVE_ELEMENT`（画面の外の子孫）
  - 制約の一覧
- 変更の対象: `src/evidence/layout-collector.ts`、対応するテストと fixture

同時に、別の実装者が、Task 14 の新しいファイル（`src/orchestration/` の下）を作っています。そのファイルは、レビューの対象外です。

## とくに確かめること

1. **I1**
   - 1行の見出しで、行の高さが小さい場合に、誤検知が出ないこと。複数のフォント（Meiryo、Noto Sans JP、Segoe UI など、この環境にあるもの）で確かめてください。
   - 片側ずつ比べるように変えたことで、2行以上の箱で本当に切れているテキストを、見逃していないこと。
2. **M1**
   - `opacity:0`、`visibility:hidden` のスライドや説明文で、誤検知が出ないこと。
   - 見えるテキストが本当に切れている箱では、報告されること。
   - 可視性の判定が、共通部品の設定（`VISIBILITY_CHECK_OPTIONS`）だけを使っていること。
3. **M2**
   - `left:-9999px` や `top:-9999px` のテキストだけを持つ、大きさ0のリンクが報告されること。
   - float の画像や absolute のアイコン、右にずれたアイコンを持つリンクが、誤って報告されないこと。
4. **性能**
   - 規模のテストの時間が、目安（1秒）に収まること。
5. **全体**
   - Task 12・13 の範囲に、Important 以上の問題が残っていないこと。

## 報告

`RT12-review-brief.md` の形式で、日本語で返してください。前回の指摘の ID ごとに、次のどれかと、その根拠を書いてください。

- 解消
- 一部解消
- 未解消
