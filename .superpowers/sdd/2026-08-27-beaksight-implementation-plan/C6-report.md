# C6 実装報告（要約。設計者が保存）

## 結論

完了した。V8、V5（layout の分）、V9（layout の分）を修正した。

- 16,000要素のページで、layout の収集にかかる時間が 4,412ms から約110〜121ms に短縮した。
- テスト全体は37ファイル・851件が PASS し、typecheck も PASS した。

## 変更した Evidence の形（C8 で使う）

- `collectLayoutEvidence(page, viewport, options?)` の戻り値は、次のどちらかになる。
  - `{status:'COMPLETE', layout}`
  - `{status:'PARTIAL', reason:'DEADLINE_EXCEEDED', layout|null}`
- `collectStressLayout` は、幅ごとに `COMPLETE`、`PARTIAL`、`FAILED` のいずれかを返す。`FAILED` の場合は、`stage`、`reason`、`message`、`layout: null` を持つ。
- `LayoutEvidence` に、次の項目を追加した。
  - `elementOverlaps`（`first`、`second`、`intersection`、`truncated`）
  - `fixedElements`（`viewportAreaRatio` などを含む）
  - `truncation`
- 既存の4種類の記録に、`truncated` を追加した。
- 型 `LAYOUT_ELEMENT_KINDS` と `LayoutElementKind` を追加した。
- `LAYOUT_THRESHOLDS` に、次の値を追加した。
  - 重なりの候補の上限: 100
  - 固定要素の候補の上限: 100
  - 組の比較回数の上限: 200,000
  - 既定の期限: 10,000ms

## 発見事項と、設計者の判断

1. stress の途中でセッションの作成や close に失敗した場合、例外を投げるので、それまでの幅の結果が失われる。
   → 承認する。これは Context のライフサイクルの異常なので、例外として表に出す。ページは、Task 14 で FAILED として扱う。
2. 遷移の失敗を表す理由コードがない。
   → C8 で `NAVIGATION_FAILED` を追加する。
3. `pageFailureReason` と、controlled-scroll の `failureReason` が重複している。
   → F04 で1つにまとめる。
4. `<p>` を500段以上入れ子にしたページで、Chromium の描画プロセスが落ちる（`Target crashed`）。
   → Task 14 で、ページを FAILED とし、理由を記録する。
5. layout の候補の上限は、`LAYOUT_THRESHOLDS` に置いたまま。
   → 設計の文言を明確にした。複数の collector で共有する上限は `limits.ts` に置き、1つの collector だけが使う上限はその collector に置く。
6. 失敗を例外にしていた既存のテストを、新しい仕様に合わせて置き換えた。→ 承認する。
7. 一部のテストの RED は、戻り値の形の確認で先に失敗していた。→ 記録の限界として許容する。
8. 祖先の overflow による切り取りは、記録していない。→ 許容する。
