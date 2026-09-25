# RT12r2 指示書: RT12d・RT12e の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `RT12-review-brief.md` を読んでください。厳守事項、重大度の基準、報告の形式は、その指示書に従ってください。

## 担当

確認のレビュー RT12r（`RT12r-review-result.md`）の指摘 N1・N3・N4・N5 が、RT12d と RT12e で解消したかを確かめてください。修正の内容は、`RT12d-report.md` と `RT12e-report.md` にあります。N2 は、設計者が制約として受け入れたので、対象外です。

あわせて、この修正によって、新しい誤検知や見逃しが入っていないかも確かめてください。このレビューで Critical と Important がなければ、Task 12・13 を完了とします。

- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.1.2
  - `TEXT_CLIPPING` の判定の方法（縦と横のしきい値）
  - 主要要素の種類
  - 候補の優先
  - 1 px 以下の子孫
  - 制約
- 変更の対象:
  - `src/evidence/layout-collector.ts`
  - `src/audit/layout-rules.ts`
  - `src/core/evidence-types.ts` の layout の部分
  - `schemas/page.schema.json` の layout の部分
  - 対応するテストと fixture

## とくに確かめること

1. **N1（見切れ）**
   - 実際の Chromium で、よくある形を確かめる。確かめる形は、次のとおり。
     - 行の高さが小さい見出し
     - 高さが auto の clearfix
     - 行の途中で切れる箱
     - 1行が横に切れる箱
     - 隠れたスライド
     - 閉じたアコーディオン
     - 「続きを読む」の箱
   - 可能なら、複数のフォントで確かめる。
   - 誤検知も見逃しも、許容の範囲にあること。
2. **N3（表と埋め込み）**
   - 表や iframe、video がはみ出す場合に、報告されること。
   - 次の Rule の結果が、表や埋め込みを加えたことで、よくある形の誤検知を生んでいないこと。
     - `ELEMENT_OVERLAP`
     - `CONTENT_COLLISION`
     - `FIXED_ELEMENT_OCCLUSION`
3. **N4（候補の優先）**
   - 候補の上限の中で、切り取られていない候補が優先されること。
   - 結果が、決定論的であること。
4. **N5（1 px 以下の子孫）**
   - visually hidden の子だけを含むリンクが、報告されること。
   - 小さなアイコン（例: 16px の svg）を含むリンクが、誤って報告されないこと。
5. **性能**
   - 規模のテストの時間が、目安（1秒）に収まること。
6. **Evidence の一致**
   - 型、スキーマ、テストの見本が、一致していること。

## 報告

`RT12-review-brief.md` の形式で、日本語で返してください。前回の指摘の ID ごとに、次のどれかと、その根拠を書いてください。

- 解消
- 一部解消
- 未解消
