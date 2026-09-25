# R2 Task 11 の品質の再レビューの結果（2026-09-23）

総合判定: 修正が必要（Critical 0 / Important 1 / Minor 3）

## 前回の指摘の解消

- 解消: Q1、Q3、Q4、Q6。
- 一部解消: Q2。ページ全体がスクロールする場合は直ったが、内側の要素がスクロールする場合が残っている（N1）。
- 見送り: Q5。設計書 4.9 のとおり、CC-008 で扱う。

## 新しい指摘と、設計者の判断

- **N1 / Important**（`discover-candidates.ts:554-587, 830-866`、`interaction-collector.ts:27-34`、`isolated-auditor.ts:640`）
  - 問題: 内側の要素がスクロールするページ（`html, body {overflow:hidden}` と `#shell {overflow-y:auto}` の構成）で、何もしないボタンが VERIFIED になる。レビュー担当が、y が 2002 から 578 に変わり、`changedFields` が `['boundingBox']` になることを再現した。
  - 設計者の判断: 座標を補正する方式をやめる。変化を観測する前に、対象を画面内にスクロールしておく方式に改める（設計書 4.4 を改訂する）。この方式なら、Playwright は click のときにスクロールしないので、座標はスクロールによって変わらない。R1 の Minor 3（`position: fixed` の要素）もこれで解決するので、F06 の該当項目は、この方式で置き換える。
- **N2 / Minor**: Passive の間にページが大量のダウンロードを起こすと、Chromium が約10件で自動のダウンロードを止める。そのため、click で起きたダウンロードが Ledger に残らない。
  - 設計者の判断: Chromium の制約として許容し、記録の限界として設計書に書く。ダウンロードそのものは起きていない。
- **N3 / Minor**: `targetHandle.dispose()` に時間の上限がない。
  - 設計者の判断: F06 で、期限付きで待つようにする。
- **N4 / Minor**: 期限を過ぎていても、ブラウザ内の評価を始めてしまう（`:316-321`）。`:538` に、重複した条件がある。
  - 設計者の判断: F06 で直す。

## 再実行の記録

- `isolated-interaction.test.ts` を2回続けて実行し、2回とも163件が PASS した。
- ほかの4ファイル（195件）が PASS した。
- typecheck が PASS した。
