# U16c 実装報告（要約。設計者が保存）

## 結論

完了した。`renderHtmlReport(viewModel): string` を作った。

- 設計書 6.1.4 の6つの節を、決まった順で描く。
- 部品を5つ加えた。
  - `renderCode`、`renderMutedText`
  - `renderInternalLink`、`renderFileLink`
  - `renderReferenceList`
- 既存の部品2つ（`renderFindingRow`、`renderEvidenceRef`）に、省略できる入力を加えた。
- HTML の文言を、`messages.ts` に加えた（`HTML_REPORT_TEXT` など）。
- テスト: HTML レポートは23件、部品は12件を加えた。
- 担当の10ファイル（243件）と、typecheck が PASS した。
- UI Gate は、25ms で終わった。
- 並行作業のため、verify は実行していない。

## 実装者の判断と、設計者の判断

1. 既存の部品に、省略できる入力を加えた。→ 承認する。
   - 省略したときの出力は、前と同じである。既存のテストは、変えずに PASS している。
   - 別の部品を作るよりも、部品が2つにならない。
2. Finding のアンカーは、category の節の行にだけ付けた。重大な指摘の節の行には、付けない。→ 承認する。
   - 同じ `id` が2つできることを避ける。
   - どの Finding も、どれか1つの category の節に入るので、リンクの先はなくならない。
3. Interaction の Evidence の場所を、`html-report.ts` の中で ID から引いた。→ **直す**（C16d）。
   - 「先にあるほうを使う」という規則が、表示用モデルと HTML の2か所にある。
   - `InteractionView` に `location` を持たせる。
4. 整数を、`formatDecimal(値, 0)` で出した。→ **直す**（C16d）。
   - `format.ts` に `formatInteger` を加えて、それを使う。
   - 対象は、リンクの深さの上限と、HTTP ステータスなどである。
5. メソッドごとの遮断したリクエストは、入力の順のまま並べた。→ 承認する。

## 発見事項と、設計者の判断

1. Safety の節に、遮断した事象の一覧がない。表示用モデルが、事象ごとの記録を持っていないためである。→ **設計の漏れとして直す**（C16d。設計書 6.1.10）。
   - 表示用モデルに、Safety の Evidence から作った事象の一覧を持たせる。
   - HTML の Safety の節で示す。
2. ブラウザでの見た目は、確かめていない。→ Task 16 のレビューと、Task 19 の fixture の実行で確かめる。
