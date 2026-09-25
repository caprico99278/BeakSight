# R7 F18 の確認と Task 11 のチェックポイントの判定の結果（2026-09-24）

総合判定: 修正が必要（Critical 0 / Important 1 / Minor 3）

## 前回の指摘の解消

R6 の I-1、I-2、M-2、M-3、M-4 は、すべて解消した。安全の性質は後退していない。

## 新しい指摘と、設計者の判断

- **Important-1**: 押したことで、対象の属性が変わったまま残る部品がある。そのため、何もしないボタンが VERIFIED になる。
  - 例1: Radix Tooltip の形。`data-state`、`aria-describedby` が変わる。
  - 例2: tippy.js の形。`aria-describedby` が変わる。
  - 例3: React Aria の形。`data-focus-visible` が変わる。
  - **判断**: tooltip や入力の種類を表す属性の変化は、根拠にしない。
    - 名前を付けた定数（例: `INTERACTION_NON_EVIDENCE_ATTRIBUTES`）で、1か所に定義する。
    - 対象の属性: `aria-describedby`、`data-state`、`data-focus-visible`、`data-focused`、`data-focus`、`data-focus-within`、`data-hovered`、`data-hover`、`data-pressed`、`data-active`
    - 本物の開閉やタブの切り替えでは、ARIA の状態も変わる。そのため、`data-state` を除いても見落とさない。
    - 設計書 4.4.1 を更新する。F19 で実装する。
- **Minor-1**: Vuetify の v-ripple の形では、押すと inline の style に `position` が残る。
  - **判断**: 起きるのは position が static の要素に限られる。制約として、設計書 4.4.4 に書く。
- **Minor-2**: 呼び出す側が `deadlineAtMs` をどう決めるかが、書かれていない。
  - **判断**: Task 14 の設計書 4.3.1 に書き加える。`deadlineAtMs` は、読み込みの期限、Interaction の期限、後片付けの時間の和以上にする。
- **Minor-3**: 持続の確認で `attributes` が根拠から外れても、`changedAttributesTruncated` が true のまま残ることがある。
  - **判断**: F19 で直す。
- **補足**: `type` のない `<button>` は、REJECTED_UNSAFE（`SUBMISSION_CONTROL`）になる。
  - **判断**: 仕様どおりの、安全側の判定である。網羅の限界として、設計書 4.4.4 に書く。

## 再実行の記録

- `isolated-interaction` を2回続けて実行し、2回とも339件が PASS した。
- ほかに7ファイル・597件が PASS した。
- 独自に28件を、実機で確かめた。
