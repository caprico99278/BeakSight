# R5 指示書: F15（VERIFIED の根拠の是正と hover）の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

## 担当

直前の確認のレビュー R'''（`Rppp-review-result.md`）の I-1・I-2・M-3 が、F15（`F15-report.md`）で解消したかを確かめてください。あわせて、この変更で新しい問題が入っていないかも確かめてください。

- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（4.4.1〜4.4.4）

## とくに確かめること

1. **偽の VERIFIED がないこと**
   - 何もしないボタンが NOT_VERIFIABLE になることを確かめる。対象は、hover のスタイル、JavaScript の hover の処理、遅延読み込み、隣の要素の変化、覆われたボタン、内側の領域、固定表示、アニメーションやタイマーで属性が変わり続ける要素の場合。
   - 最後の場合について、一定の間隔で自分の class を切り替える要素は、click と関係なく属性が変わる。この場合をどう扱うべきかを評価する。
2. **偽の NOT_VERIFIABLE が多すぎないこと**
   - 次のような、実際のサイトによくある部品が VERIFIED になることを確かめる。
     - タブ（`aria-selected` や class の切り替え）
     - ハンバーガーメニュー（`aria-expanded` や、body・親に class を付けるもの）
     - `<details><summary>`（`open` 属性）
     - class を切り替えるトグル
     - `aria-pressed` のボタン
     - モーダルを開くボタン（`aria-controls` があるもの、ないもの）
   - とくに、「対象の外の要素（親や body）に class を付けるだけ」の部品が NOT_VERIFIABLE になるかどうかを確かめ、それが設計書 4.4.4 の制約として許容できる範囲かを評価する。
   - これらを、`127.0.0.1` か `setContent` で、実際に確かめてください。
3. **hover の扱い**
   - hover が凍結の前に行われ、hover で始まる通信が Passive の通信として Guard の判定を受けることを確かめる。
   - hover の失敗と期限切れが、fail-closed であることを確かめる。
4. **属性の記録**
   - 対象の要素の属性の記録が、上限・切り詰め・不完全な場合の扱いを含めて、正しく働くことを確かめる。
5. **理由の整形（M-3）**
   - すべての経路で、理由の文字列に制御文字や ANSI の断片が残らないことを確かめる。
6. **安全の性質**
   - 安全の判定の順序、Guard、fail-closed が変わっていないことを確かめる。
7. **テストの安定性**
   - `tests/integration/isolated-interaction.test.ts` を2回続けて実行する。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`
- `src/evidence/interaction-collector.ts`
- 対応するテストと fixture
