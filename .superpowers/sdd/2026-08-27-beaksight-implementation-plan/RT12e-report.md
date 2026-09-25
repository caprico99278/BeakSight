# RT12e 実装報告（要約。設計者が保存）

## 結論

完了した。横方向の見切れのしきい値を、固定の 2 px（`clippedTextLineMaxIgnoredHorizontalOverflowPx`）にした。縦方向は、これまでどおり行の高さの4分の1とする。実装者の報告では、`npm run verify` は PASS した（51ファイル、1939件）。

- 幅 300px の箱に、約 375px の1行を入れた場合は、Finding ができる。
- 文字が 2 px 以下だけ張り出す箱と、横に隠れたスライドでは、Finding ができない。

## 発見事項と、設計者の判断

- `src/core/evidence-types.ts:703-704` の `partiallyClippedText` の説明のコメントが、古い。→ P14a で直す。P14a は、同じファイルを変えるためである。
