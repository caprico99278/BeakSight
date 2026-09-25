# C18c 実装報告（要約。設計者が保存）

## 結論

完了した。6つの項目をすべて直した。Architecture と UI の Gate は、今の `src/` で PASS し、`npm run typecheck` も PASS した。並行作業のため、verify は実行していない。

1. ARCH04: `.has(` と `.includes(` の引数に `origin` を含む形を、検出するようにした。
   - 今の `src/` に違反はなく、除外の一覧には何も加えていない。
2. `safety-rules.ts` の `example` を、`sample` に変えた。
   - Finding の文言は、変えていない。
   - `src/` の中の `example` の語は、0件になった。
3. PREFLIGHT が失敗した場合も、閉じる処理の失敗を、メッセージに加えるようにした。
4. 幅の走査で閉じる処理が期限切れになった場合の理由を、`stress-layout:CLOSE_DEADLINE_EXCEEDED` にした。理由のコードは、`COLLECTOR_INCOMPLETE` のままである。
5. `tests/unit/text.test.ts:12` の見えない BOM の文字を、表記（`\uFEFF`）に直した。
6. CC-030: 走査に `wholeLiterals` を加え、UI Gate の文字列リテラルの取り出しを移した。
   - `STRING_LITERAL_PATTERN` は、消した。
   - 入れ子のテンプレートの取り違えは、なくなった。

Gate の各ファイルの所要時間（単独で実行した場合）:

| ファイル | 所要時間 |
| --- | --- |
| target-isolation | 331ms |
| semantic-ownership | 394ms |
| ui-ssot | 473ms |

## 実装者の判断と、設計者の判断

1. 範囲外（`semantic-ownership.test.ts` の、ARCH04 以外の1行）を、型に合わせて直した。→ 承認する。意味は同じである。
2. テンプレートの `${…}` の中の文字列リテラルも、1つのリテラルとして判定するようになった。→ 承認する。
   - 前は、見逃していた書き方である。
   - 今の `src/` に、違反はない。
3. ARCH04 は、大文字と小文字を区別せずに検出する。→ 承認する。前の規則に合わせた。
4. 幅の走査の理由は、page と Context のどちらの期限切れかを分けない。→ 承認する。

## 発見事項と、設計者の判断

1. PREFLIGHT で、作成の期限切れの後に遅れて届いた Context を閉じた結果は、メッセージに含められない。→ 承認済みの扱い（遅れて届いた Context の結果は捨てる。Task 18 の前の整理の設計書 4.2）のとおりである。
