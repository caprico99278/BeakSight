# R''1 指示書: スクロールと Interaction の修正の最後の確認

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

## 担当

確認のレビュー R'1（`Rp1-review-result.md`）の N1' と、R'2（`Rp2-review-result.md`）の I-1・I-3・m1 について、次の修正で解消したかを確かめてください。あわせて、これらの修正で新しい問題が入っていないかを確かめてください。

- 修正の報告: `F09-report.md`（スクロールの部分）、`F10-report.md`、`F11-report.md`、`F12-report.md`（`targetSwitchCount` の部分）
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（追記を含む）、5.1（追記を含む）

## とくに確かめること

- 偽の COMPLETE がないこと
  - 後から body のほうが大きくなるページ、shadow root の中の領域、余白が既定のページ、内側の領域があるページ、body がスクロールするページを確かめる。
  - できれば `setContent` で、テストとは別に実際に確かめてください。
- 偽の VERIFIED がないこと
  - 覆われたボタン、画面外のボタン、内側の領域のボタン、固定表示のボタンを確かめる。
  - 何かが起きるボタンが、偽の NOT_VERIFIABLE にならないことも確かめる。
  - `127.0.0.1` か `setContent` で、実際に確かめてください。
- 安全の判定の順序、Guard、fail-closed が変わっていないこと。unhandledRejection がないこと。
- scroll の Evidence（`observations` の上限、`omittedObservationCount`、`targetSwitchCount`、`innerScrollScan`）が、型とスキーマで一致し、実際の結果を表していること。
- テストの安定性
  - `tests/integration/isolated-interaction.test.ts` を2回続けて実行する。
  - `tests/integration/controlled-scroll.test.ts` を2回続けて実行する。

## 対象のファイル

- `src/browser/controlled-scroll.ts`
- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- 対応するテストと fixture
