# RT12a 実装報告（要約。設計者が保存）

## 結論

完了した。I1・I2・I3・M6 を直した。担当のテスト474件と `npm run typecheck` は PASS した。

## 主な変更

- layout の Evidence に、次の項目を加えた。
  - `OutsideViewportEvidence`: `kind`、`horizontalClipAncestor`（`HORIZONTAL_CLIP_ANCESTOR_KINDS`）、`nearestListedAncestorIndex`
  - `ClippedTextEvidence`: `partiallyClippedText`
  - `ZeroSizeInteractiveEvidence`: `hasRenderedDescendant`
  - 走査が上限に達した件数を記録する項目
- fixture で確かめた結果は、次のとおり。
  - 誤検知だった7件が、`#fixed-width-image` の1件だけになった。
  - テキストの見切れは、`#clipped-caption` だけが Finding になった。
  - 大きさ0の操作要素は、`#empty-button` だけが Finding になった。
- 16,000要素の規模のテストは、116ms で終わった。

## 実装者の判断と、設計者の判断

1. 「一覧に祖先がないこと」の読み方を変えた。一覧の中に、横にはみ出す祖先がある要素だけを除く。→ 承認する。
   - 理由: 一覧には、縦にだけはみ出す祖先（ページの下まで続く `main` など）も入る。文字どおりに読むと、長いページの中の本当のはみ出しが、ほとんど報告されなくなる。
   - Rule の設計書 5.1.2 を直した。
2. `OutsideViewportEvidence` に `kind` を加え、子孫の走査にも上限を設けた。→ 承認する。
3. ruleVersion は 1 のままにした。→ 承認する。公開の前であり、T12f の判断とそろえるため。
4. body に `overflow-x:hidden` を付けたページでも、`DOCUMENT_HORIZONTAL_OVERFLOW`（ERROR）ができる。→ 誤検知として直す（RT12c）。
   - このページでは、ビューポートが横にスクロールしない。そのため、利用者に横スクロールは生じない。
   - body に `overflow-x:hidden` を付ける形は、よく使われる。
5. `HORIZONTAL_CLIP_ANCESTOR_KINDS` を、共通部品台帳 2.2 に載せる必要がある。→ 設計者が更新した。
