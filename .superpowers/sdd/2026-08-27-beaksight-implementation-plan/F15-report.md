# F15 実装報告（要約。設計者が保存）

## 結論

完了した。`npm run verify` は PASS した（41ファイル、1395件）。

- `boundingBox` は、VERIFIED の根拠にしなくなった。Evidence の before・after には、これまでどおり残す。
- 対象の要素そのものの属性の変化（`attributes`）を、根拠に加えた。
- 凍結の前の下準備で、期限を付けて hover するようにした。
- 理由の整形は、除去をしてから切り詰める順にした。`lifecycle.reason` と Ledger も、同じ関数で整形する。

## VERIFIED の根拠（`changedFields`）

| 値 | 根拠になる変化 |
| --- | --- |
| `ariaExpanded`、`ariaSelected` | 対象の ARIA の状態 |
| `controlledVisible`、`controlledHidden` | `aria-controls` の先の要素の表示 |
| `disabled` | 対象の無効の状態 |
| `visible` | 対象の表示 |
| `textFingerprint` | 対象の文字 |
| `attributes` | 対象の要素そのものの属性の追加・削除・値の変化（class、style、hidden、open、data-*、aria-pressed、aria-checked などを含む）。前後の記録がどちらも完全な場合に限る |

`boundingBox` は、根拠としては出さない。

## 検証

- 何もしないボタン6種類（hover の transform・font-weight・padding、mouseenter で class を付けるもの、ボタンの中の画像、flex の隣の要素）は、修正前は VERIFIED（RED）で、修正後は NOT_VERIFIABLE になった。
- アコーディオン、大きさが変わるボタン（`attributes`）、`aria-controls` の先の切り替え、文字の切り替えは、VERIFIED のままである。
- `isolated-interaction` は、2回続けて実行し、2回とも244件が PASS した。`passive-request-guard` は、120件が PASS した。

## 是正した既存のテスト

- 大きさや位置の変化で VERIFIED を期待していたテストを、設計書 4.4.1 に合わせた。
- 覆われたボタンの2件は、hover が凍結の前にスクロールを済ませるので、期待を変えた。
- 4.4.3 の判定を実際に確かめる場面として、`hover-overlay-inert-button.html` を加えた。

## 発見事項と、設計者の判断

- 共通部品台帳の更新。→ 設計者が行う。
- どのスクロール位置でも覆われたままの対象は、hover が期限切れになり、NOT_VERIFIABLE になる。→ 許容する。これは正直な結果である。
