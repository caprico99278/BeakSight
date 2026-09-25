# R9 F20・F20b の確認と Task 11 のチェックポイントの判定の結果（2026-09-24）

総合判定: 修正が必要（Critical 0 / Important 1 / Minor 1）

## 前回の指摘の解消

- R8 の Important-1 と Important-2 は、解消した。
- R8 の Minor-1 も、解消した。
- 後退は、見つからなかった。確かめた部品は次のとおり。
  - アコーディオン
  - `<details>`
  - `aria-pressed`
  - スイッチ
  - モーダル
  - メニュー
  - `.active` のトグル
  - 長い class を持つ shadcn のボタン
- focus で開くコンボボックス型のボタンは、NOT_VERIFIABLE になった。レビュー担当は、これを妥当と評価した。
- 安全の性質は、後退していない。unhandledRejection は0件だった。型とスキーマは一致していた。

## 新しい指摘と、設計者の判断

- **Important-1**: `role="tab"` に focus をしないため、focus で変わる属性が、押した後の差に出る。その結果、偽の VERIFIED になる。
  - 差に出る属性の例:
    - roving tabindex による `tabindex`（Radix、shadcn）
    - Vaadin の `focused`
    - inline の style
  - すでに選ばれているタブを押すと、何も起きないのに VERIFIED になる。F20 で入った後退である。
  - **判断**: `role="tab"` を明示した要素では、対象の属性の変化（`attributes`）を根拠にしない。
    - 根拠にするのは、次のものに限る。
      - ARIA の状態
      - `aria-controls` の先の表示
      - 文字
      - disabled
      - visible
    - 本物のタブの切り替えでは、必ず `aria-selected` が変わるので、見落とさない。
    - 設計書 4.4.1 を更新する。F21 で実装する。
- **Minor-1**: focus の前後の比較が、hover の直後に始まる。そのため、hover で遅れて起きた変化が、focus による変化と取り違えられることがある（推測）。
  - **判断**: 取り違えても、結果はどちらも NOT_VERIFIABLE で、違うのは理由の文字列だけである。そのため、受け入れる。記録だけにとどめ、修正しない。

## 再実行の記録

- `isolated-interaction` を2回続けて実行し、2回とも406件が PASS した（1回あたり約280秒）。
- ほかの4ファイルでは、437件が PASS した。
- 独自に、20の形を2回ずつ、実機で確かめた。
