# R''1 スクロールと Interaction の最後の確認の結果（2026-09-23）

総合判定: 修正が必要（Critical 0 / Important 1 / Minor 3）

## 前回の指摘の解消

R'1 の N1'、R'2 の I-1・I-3・m1 は、すべて解消した。安全の判定の順序、BLOCKED を優先する判定、unhandledRejection がないことも、確かめた。

## 新しい指摘と、設計者の判断

- **Important**（`isolated-auditor.ts:503-510, 747-750`）
  - 指摘: 下準備でスクロールしたときに遅延読み込みが始まり、click の後に画像が届いてレイアウトがずれる。すると、何もしないボタンが `boundingBox` の変化だけで VERIFIED になる。4回実行して、4回とも起きた。
  - 判断: 位置の変化を根拠にして偽の VERIFIED が起きたのは、これで3回目である。場合を1つずつ塞ぐのをやめ、方針を改める。対象が平行移動しただけの変化は、VERIFIED の根拠にしない（設計書 4.4.1）。大きさの変化、ARIA、`aria-controls` の先の変化は、これまでどおり根拠にする。F14 で実装する。
- **Minor**: closed な shadow root の中の領域は、検出されない。
  - 判断: 制約として設計書 5.1 に明記した。
- **Minor**: 押すと自分でスクロールするボタンが、NOT_VERIFIABLE になる。
  - 判断: 制約として設計書 4.4.4 に明記した。
- **Minor**: 設計書 4.4 の構成が崩れている。
  - 判断: 設計者が 4.4 を整理し直した。
- **参考**: click が失敗したときの理由に、Playwright の Call log と ANSI の制御文字が、そのまま入る（`isolated-auditor.ts:190-199`）。
  - 判断: F14 で取り除く。

## 再実行の記録

- `controlled-scroll`: 2回続けて実行し、2回とも34件が PASS した。
- `isolated-interaction`: 2回続けて実行し、2回とも194件が PASS した。
- typecheck が PASS した。
- scroll の Evidence の実際の結果、18通りをスキーマで確かめた。
