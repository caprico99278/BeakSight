# R10 F21 の確認と Task 11 のチェックポイントの判定の結果（2026-09-24）

総合判定: 承認（Critical 0 / Important 0 / Minor 2）

Task 11 のチェックポイントを通過した。

## 前回の指摘の解消

- R9 の Important-1: 解消した。
  - 明示した tab で、すでに選ばれているものを押すと、NOT_VERIFIABLE になる。
  - 選ばれていないものを押すと、`ariaSelected` と `controlledVisible` で VERIFIED になる。
  - 実機で確かめた。確かめた形は、Radix（自動・手動）、`focused`、boxShadow、shadcn である。
  - F21 のフラグを外した版では、5件の偽の VERIFIED が再現した。これで、F21 が効いていることも確かめた。
- 副作用は、見つからなかった。
  - Bootstrap 5.3、MUI、Headless UI v2、jQuery UI の accordion、自作のタブは、期待どおりの結果になった。
  - `role` を持たない部品の結果も、変わらなかった。
- 安全の性質は、後退していない。遮断された通信は0件、unhandledRejection も0件だった。型とスキーマは一致していた。

## Minor と、設計者の判断

- **Minor-1**: `role="tab"` を持ち、`aria-selected` も `aria-controls` も持たず、`.active` の class だけを切り替える自作のタブは、NOT_VERIFIABLE になる。
  - 判断: 設計の方針どおりの結果である。設計書 4.4.4 に、制約として書き加えた。
- **Minor-2**: Bootstrap、MUI、Headless UI の形のタブの回帰テストがない。
  - 判断: F22 として登録した。Task 13 の後、Task 14 の前に行う。

## 再実行の記録

- `isolated-interaction` を2回続けて実行し、2回とも421件が PASS した（1回あたり約298秒）。
- 独自に、25のケースを2周、実機で確かめた。期待との不一致は0件だった。
