# R8 F19 の確認と Task 11 のチェックポイントの判定の結果（2026-09-24）

総合判定: 修正が必要（Critical 0 / Important 2 / Minor 1）

## 前回の指摘の解消

- R7 の Important-1 と Minor-3 は、解消した。実機でも確かめた。
- 安全の性質は、後退していない。
- unhandledRejection は、0件だった。
- 型とスキーマは、一致していた。

## 新しい指摘と、設計者の判断

- **Important-1**: Headless UI v2 の `data-headlessui-state` で、偽の VERIFIED になる。
  - この属性は、hover や focus の状態を、1つの値にまとめて出す。
  - 下準備の focus の後で押すと、値が `"hover focus"` から `"hover"` に変わったまま残る。
  - **判断**: 属性の名前を一覧に1つずつ加える方法では、同じ種類の指摘が続く。そこで、次の2つの決まりにする。
    - 一覧に `data-headlessui-state` を加える。
    - 名前に `focus` か `hover` を含む `data-*` 属性と class の名前を、根拠にしない。大文字と小文字は区別しない。例: MUI の `Mui-focusVisible`、`is-focused`、`is-hovered`。
    - `active` は、class の決まりには含めない。Bootstrap の `.active` のように、トグルの状態を表すことが多いためである。
  - 設計書 4.4.1 を更新する。F20 で実装する。
- **Important-2**: 自動で切り替わる形のタブで、偽の NOT_VERIFIABLE になる。
  - 対象は、Radix、shadcn の既定、Zag、Ark の形である。
  - 下準備の focus で、凍結の前にタブが切り替わってしまう。
  - **判断**: `role="tab"` を明示した要素には、下準備の focus をしない。
    - WAI-ARIA APG の「選択が focus に従う」の形に当たる。
    - focus をしなくても、click のときに focus が起き、`aria-selected` が変わるので、VERIFIED になる。
    - focus で付く class や属性は、Important-1 の決まりで根拠から外れる。
  - それ以外の要素で、下準備の focus によって、対象の ARIA の状態か `aria-controls` の先の表示が変わった場合は、NOT_VERIFIABLE にする。
    - 理由は、区別できる文字列にする。例: `Target state changed on focus during preparation`。
  - 設計書 4.4.1、4.4.2、4.4.4 を更新する。F20 で実装する。
- **Minor-1**: 対象の `data-state` だけを変え、`aria-controls` もない自作の部品は、NOT_VERIFIABLE になる。
  - **判断**: 設計書 4.4.4 に、制約として書き加える。

## 再実行の記録

- `isolated-interaction` を2回続けて実行し、2回とも357件が PASS した（1回あたり262秒）。
- 独自に、11の形を2回ずつ、実機で確かめた。
