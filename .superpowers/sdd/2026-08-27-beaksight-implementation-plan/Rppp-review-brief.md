# R''' 指示書: 最後の確認のレビュー（F13〜F14b）

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

## 担当

直前の確認のレビュー R''1（`Rpp1-review-result.md`）と R''2（`Rpp2-review-result.md`）の指摘が、次の修正で解消したかを確かめてください。あわせて、これらの修正で新しい問題が入っていないかを確かめてください。

- 修正の報告: `F13-report.md`、`F13bc-report.md`、`F14-report.md`、F14b（報告は設計者の会話の中にあり、ファイルはない。`src/interaction/isolated-auditor.ts` の `interactionFailureReason` を見てください）
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（4.4.1〜4.4.4）

## とくに確かめること

1. **偽の VERIFIED がないこと**
   - 次の場合に、何もしないボタンが VERIFIED にならないことを確かめる。
     - 遅れた読み込みで位置がずれる場合
     - 覆われている場合
     - 内側の領域にある場合
     - 固定表示の場合
   - 次の場合に、何かが起きるボタンが VERIFIED になることを確かめる。
     - アコーディオン
     - 大きさが変わるボタン
     - `aria-controls` の先が変わるボタン
   - これらを、`127.0.0.1` か `setContent` で、テストとは別に実際に確かめてください。
2. **設計書 7.3 との関係**
   - 平行移動を根拠にしないことで、設計書 7.3（「ARIA または DOM の visibility・state・layout の検証可能な変化」）に照らして、本来 VERIFIED にすべきものを落としていないかを評価してください。
   - 例: 押すと別の要素の layout が変わるが、その要素が `aria-controls` で結ばれていない場合。
3. **設定の検証**
   - timezone と locale の検証が、実際の Chromium の受け付ける値とそろっていることを確かめる。
   - 受け付けた値で Context を作れること、拒否すべき値を拒否することを確かめる。
4. **スキーマ**
   - Evidence の ID の接頭辞が、スキーマの分岐ごとに正しく限られていることを確かめる。
   - DOM の文書の項目の切り詰めの印が、型とスキーマで一致していることを確かめる。
5. **失敗の理由**
   - 失敗の理由に、ANSI の制御文字と Call log が残る経路がないことを確かめる。
6. **安全の性質**
   - 安全の判定の順序、Guard、fail-closed が変わっていないことを確かめる。
7. **テストの安定性**
   - `tests/integration/isolated-interaction.test.ts` を2回続けて実行する。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`
- `src/evidence/interaction-collector.ts`
- `src/config/validate-config.ts`
- `src/core/evidence-types.ts`
- `src/evidence/dom-collector.ts`
- `schemas/page.schema.json`
- 対応するテストと fixture
