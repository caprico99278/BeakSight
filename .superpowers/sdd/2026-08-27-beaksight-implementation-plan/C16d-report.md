# C16d 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（84ファイル、2909件。todo 1件）。UI Gate のファイルは 304ms で終わった。

- Safety の事象の一覧を作った。
  - 表示用モデルの型: `SafetyView`（`RunSafetySummary` と `events`）、`SafetyEventView`
  - カタログ: `SAFETY_EVENT_KIND_CATALOG`
  - HTML: Safety の節の事象の表
- `InteractionView.location` を加えた。HTML は、ID から場所を引き直さなくなった。
- `formatInteger` を加えた。表示面の `formatDecimal(値, 0)` をなくした。
- `isRunId` と `isPageId` を、`src/core/ids.ts` に加えた。
  - `ArtifactWriter` は、この判定で確かめる。形の違う ID は、C16c の前と同じく `RangeError` になる。
- 既存のテスト2件の期待値を、モデルの形の変更に合わせて直した。条件は弱めていない。

## 実装者の判断と、設計者の判断

1. `SafetyEventKind` 型を `catalog.ts` に置き、実行時の種類の並びを `view-model.ts` の `SAFETY_EVENT_FIELDS` から作った。→ **承認しない。C16e で直す。**
   - 事象の種類は、値の意味である。表示のカタログではなく、core が持つ。
   - `src/core/evidence-types.ts` に、`SAFETY_EVENT_KINDS`（`as const` の配列）と `SafetyEventKind` を置く。
   - 書き漏れと余分は、`SafetyEventsEvidence` の項目と比べて、型のエラーにする。
   - カタログ、表示用モデル、テストの補助は、この一覧を使う。
2. `SafetyEventView` に `location` を加えた。→ 承認する。設計書 6.1.10 に加えた。
3. HTML の列を、指示書のとおり7列にした。→ **「候補」の列を加える（C16e）。**
   - 除外した Interaction の候補の行には、メソッドも URL もない。そのため、この列がないと、どの候補か分からない。
   - `suggestedFilename` は加えない。ダウンロードの URL で、どの事象か分かるためである。
4. HTML の細部（ページの列の文字、再試行の前の記録の印、一覧の説明、記録の上限の注意）。→ 承認する。
5. `ArtifactWriter` の `RangeError` の文言を、「ID の形でない」に変えた。→ 承認する。例外の種類は変わっていない。

## 発見事項と、設計者の判断

1. UI05 の対象（`tests/architecture/ui-ssot.test.ts` の `catalogs` の一覧）に、`SAFETY_EVENT_KIND_CATALOG` がない。`formatInteger(null)` の検査もない。→ C16e で加える。値の一覧は、core の `SAFETY_EVENT_KINDS` から取る。
2. `formatBytes` は、中で `formatDecimal(値, 0)` を使っている。→ そのままでよい。出力は同じで、表示面から直接呼ぶ箇所はなくなった。
