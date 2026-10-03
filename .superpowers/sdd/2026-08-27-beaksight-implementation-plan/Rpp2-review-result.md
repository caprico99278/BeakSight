# R''2 型・スキーマ・DOM・設定の最後の確認の結果（2026-09-23）

総合判定: 修正が必要（Critical 0 / Important 1 / Minor 4）

## 前回の指摘の解消

- I-2、m2、m3、m4 は解消した。
- m5 は一部解消にとどまる。`startUrl` の検証は、実行時と一致した。locale と timezone は、実行時と一致していない（下の I-1）。

## 新しい指摘と、設計者の判断

- **I-1 / Important**（`validate-config.ts:36-43, 149-155`）
  - 指摘: Node の `Intl.DateTimeFormat` だけで判定しているため、Chromium が拒否する値を受け入れてしまう。該当する値は、timezone の `+09:00`・`-0530`・`asia/tokyo` と、locale の `und` である。
  - 判断: F13 で直す。Chromium と同じ範囲の値だけを受け付けるようにする。
- **m1**（`schema-enum-consistency.test.ts`）
  - 指摘: 次の2つが検査の範囲に入っていない。
    - `oneOf` の `const` で表した、閉じた集合
    - TypeScript の型が配列から導かれていること
  - 判断: 検査の範囲の限界として、台帳 2.2 に明記する（設計者が行う）。
- **m2**（`page.schema.json:57`）
  - 指摘: `evidenceId` の接頭辞と、Evidence の種類の組み合わせを、スキーマで確かめていない。
  - 判断: F13 で直す。
- **m3**（台帳）
  - 指摘: 次の3つの記述が正確でない。
    - `ScrollPosition` の置き場所
    - 2.2 の一覧の参照先
    - `evidence-types.ts:105` のテストの参照先
  - 判断: 台帳は設計者が直す。コメントは F13 で直す。
- **m4**（`dom-collector.ts:659`）
  - 指摘: canonical の URL を切り詰めたかどうかが、DOM の Evidence に項目ごとには残らない。
  - 判断: F13 で、項目ごとの印を加える。Task 12 の `INVALID_CANONICAL_URL` が正しく判定するために必要である。

## 再実行の記録

- 5ファイル・372件が PASS した。
- typecheck が PASS した。
- Chromium の locale と timezone の判定を、実際に確かめた。
