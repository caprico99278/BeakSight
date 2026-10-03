# F13 実装報告（要約。設計者が保存）

## 結論

完了した。I-1、m2、m3、m4 を直し、`npm run verify` は PASS した（41ファイル・1334件）。

## 主な変更

- 設定の検証では、timezone が IANA の名前の形で、`Intl` が解決した名前と大文字・小文字まで一致することを確かめる。locale は、正規の形で、`und` でないことを確かめる。
- Evidence の12の分岐それぞれで、`evidenceId` の接頭辞を、その種類のものに限った。接頭辞は `ids.ts` の対応を実行時に読んで比べるので、ずれればテストが失敗する。
- DOM の Evidence の `documentFields` を、項目ごとの印（title、metaDescription、canonicalUrl、lang）に置き換えた。
- 実際の Chromium で、受け付けた設定の値を使って Context と page を作れることを確かめる component テストを加えた。

## 発見事項と、設計者の判断

1. 「大文字・小文字まで一致」の条件によって、`Asia/Kolkata`、`Etc/UTC`、`GMT`、`US/Pacific` など、Chromium では使える値が拒否されるようになった。Node の ICU が、別の表記に解決するためである。
   - 判断: 設計者の指示の条件が厳しすぎた。F13b で、判定を次の2つに改める。
     - IANA の名前の書き方（区切りごとに大文字で始まる形）であること
     - `Intl` が受け付けること
   - `asia/tokyo` とオフセットの形は、引き続き拒否する。
2. `finding.schema.json` の `evidenceRefs` の pattern は、種類を問わない。
   - 判断: 許容する。参照先の ID が本当にあるかは、Rule Engine が確かめる（T12a）。
3. 共通部品台帳の更新。→ 設計者が行う。
