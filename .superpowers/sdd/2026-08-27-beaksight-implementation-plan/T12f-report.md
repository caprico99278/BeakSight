# T12f 実装報告（要約。設計者が保存）

## 結論

完了した。`npm run verify` は PASS した（50ファイル、1864件。build を含む）。

- `src/audit/rule-helpers.ts` を作った。中身は `evidenceOfType` と `distinctSorted`。
- `src/presentation/format.ts` を作った。中身は `formatDecimal`、`formatPixels`、`formatMilliseconds`、`formatPercent`。
- `compareRuleEvaluationFailures` を export し、Cross-page rule でも使うようにした。
- `INCONSISTENT_ORIGIN` を、canonical だけを判定するように絞った。
- 変更の前と後で、Rule の出力をすべて比べた。
  - `INCONSISTENT_ORIGIN` 以外は、バイト単位で同じだった。
  - Cross-page では、消えた Finding より後ろの Finding の番号が、1つずつ前にずれる。

## 実装者の判断と、設計者の判断

1. technical の Rule が、入力のビューポートの Evidence だけを読むようになった。→ 承認する。`PageRuleInput` の契約（1ページ・1ビューポート）のとおりである。
2. `INCONSISTENT_ORIGIN` の version は 1 のままにする。→ 承認する。
   - まだ公開していないので、過去の Run と比べる必要がない。
   - version を上げると、canonical の Finding の fingerprint が変わってしまう。
3. Rule Engine の下書きの検査にあった重複除去と並べ替えを、`distinctSorted` に置き換えた。→ 承認する。

## 発見事項と、設計者の判断

- 文言の中で値を並べる区切りの「、」が、Rule のファイルごとに文字列リテラルとして書かれている。
- `cross-page-rules.ts` の `formatList` と `formatStatuses` は、表示の書式にあたる。
- 判断: 上の2つを、CC-016 として登録する。Task 16 で、文言カタログ（`src/presentation/messages.ts`）か、書式の owner に移す。移し先は、GATE-UI06（日本語の文字列を置いてよいファイル）に合わせて決める。
