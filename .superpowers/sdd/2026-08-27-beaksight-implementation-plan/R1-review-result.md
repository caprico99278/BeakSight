# R1 Task 11 の仕様の再レビューの結果（2026-09-23）

総合判定: 承認（Critical 0 / Important 0 / Minor 3）

## 前回の指摘の解消

I1、I2、I3（記録の逸脱として扱う）、M1、M2、M3 は、すべて解消した。

## 新しい指摘と、設計者の判断

1. **Minor**（`discover-candidates.ts:487-496, 762-772`、テスト `:4341`）: 可視判定の DOM作業量を、祖先の深さにかかわらず1回あたり1単位と数えている。9-20設計 §5.1・§5.6 は、祖先1つごとに1単位を消費すると定めている。
   → 承認する。`checkVisibility` は、祖先をたどる処理をブラウザの内部で行うので、BeakSight の走査の作業量ではない。作業フェーズには期限（4.3）がある。基盤修正の設計書 5.5 に、9-20設計 §5.1・§5.6 の該当箇所を置き換えたことを明記する。
2. **Minor**（`isolated-auditor.ts:57`）: 使われていない公開の型 `InteractionLifecycleOutcome`（NON_TERMINAL を含む）が残っている。
   → F06 で削除する。
3. **Minor**（推測）: `position: fixed` の要素は、ページ座標で記録すると、スクロールによって値が変わる。スクロールが続くページでは、固定位置の無反応なボタンが VERIFIED になるおそれがある。
   → F06 で直す。固定位置の要素（自身または祖先が `position: fixed`）は、ビューポート座標で比べる。
4. **Task 14 への申し送り**: 除外した候補が Ledger に記録されるのは、`auditInteraction()` にその候補を渡した場合だけである。
   → Task 14 の設計書に追記する。発見した候補は、除外されるものも含めて、`auditInteraction()` の受け入れの判定に渡す。

## 再実行の記録

- 5ファイル・358件が PASS した。
- `accessibility-guard-safety` が PASS した。
- typecheck が PASS した。
