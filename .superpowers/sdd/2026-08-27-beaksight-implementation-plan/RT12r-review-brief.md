# RT12r 指示書: RT12 の修正の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `RT12-review-brief.md` を読んでください。厳守事項、対象、重大度の基準、報告の形式は、その指示書に従ってください。

## 担当

独立レビュー RT12（`RT12-review-result.md`）の指摘が解消したかを確かめてください。指摘は、Important の I1〜I5 と、Minor の M6〜M9 です。修正は、次の3つの報告にあります。

- `RT12a-report.md`
- `RT12b-report.md`
- `RT12c-report.md`

あわせて、修正によって、新しい誤検知や見逃しが入っていないかも確かめてください。

- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2（RT12a の判断と RT12c を反映したもの）と第7章

## とくに確かめること

1. **layout の誤検知の解消**
   - 次の形で、誤検知が出ないこと。実際の Chromium で、collector と Rule をつないで確かめてください。
     - カルーセル
     - 横にスクロールできる表
     - body の `overflow-x:hidden`
     - 画像を拡大するカード
     - float や absolute の子を包むリンク
   - 次の本当の問題は、見逃さないこと。
     - 固定の幅の画像
     - 切れたテキスト
     - 中身のない大きさ0のボタン
     - 本当に横へスクロールするページ
2. **新しい見逃し**
   - 新しい除外の条件によって、よくある本当の問題が見逃されていないこと。除外の条件は、次の4つです。
     - `horizontalClipAncestor`
     - 横にはみ出す祖先
     - `partiallyClippedText`
     - `hasRenderedDescendant`
   - 例を挙げます。
     - `overflow:hidden` の中で、テキストが1行だけ切れているカード
     - 文書の幅いっぱいに広がって横へはみ出す見出し
3. **Cross-page rule と Engine**
   - 1つの事実から、1つの Finding だけが作られること。
   - canonical の比較が正しいこと。
   - version と category の検査が働くこと。
   - `CROSS_PAGE_RULES` が検査されること。
4. **性能**
   - layout の collector の走査が増えた。それでも、規模のテスト（`tests/integration/layout-evidence-scale.test.ts`）の時間の目安に収まること。
5. **Evidence の一致**
   - 型、スキーマ、テストの見本が一致していること。

## 報告

`RT12-review-brief.md` の形式で、日本語で返してください。前回の指摘の ID ごとに、次のどれかと、その根拠を書いてください。

- 解消
- 一部解消
- 未解消
