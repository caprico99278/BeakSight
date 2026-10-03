# F14 実装報告（要約。設計者が保存）

## 結論

完了した。

- 対象の平行移動だけ（x・y だけ）の変化は、VERIFIED の根拠にしない。
  - 大きさの変化（`interactionSizeChanged`）がある場合だけ、`changedFields` に `boundingBox` を加える。
  - 平行移動は、Evidence の before・after には残す。
  - 平行移動だけのときの NOT_VERIFIABLE の理由は、`Only target position changed; a translation is not evidence of the interaction` とする。
- 検証の結果は次のとおり。
  - 遅れて差し込まれる要素で位置がずれる fixture: 修正前は VERIFIED（RED）、修正後は NOT_VERIFIABLE（GREEN）。
  - 大きさが変わるボタン: VERIFIED。
  - アコーディオン: VERIFIED。
- click の失敗の理由から、ANSI の制御文字と `Call log:` 以降を取り除いた（`clickFailureReason`）。
- 次のテストがすべて PASS した。
  - `isolated-interaction`: 2回続けて実行し、2回とも205件が PASS。
  - `passive-request-guard`: 120件が PASS。
  - unit と component: 938件が PASS。
  - typecheck も PASS。

## 仕様の是正

- F10 のテスト `keeps geometry as evidence when every recorded scroll position is unchanged` は、平行移動だけの変化に VERIFIED を期待しており、設計書 4.4.1 に反していた。
- そこで、大きさの変化を確かめるテストに直した。期待値は変えていない。
- 平行移動のテストは、新しく加えた。

## 発見事項と、設計者の判断

- 下準備のスクロールの失敗と、包括的な catch の理由には、まだ制御文字と Call log が入りうる。→ F14b で、同じ処理を使うようにする。
