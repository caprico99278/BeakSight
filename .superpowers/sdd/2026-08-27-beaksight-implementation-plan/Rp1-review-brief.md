# R'1 指示書: Interaction の修正の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

## 担当

**前回の独立レビューの R1（Task 11 の仕様）と R2（Task 11 の品質）で出た指摘が、F06・F06b・F06c で解消されたか**を確かめてください。

- 前回の結果: `R1-review-result.md`、`R2-review-result.md`
- 修正の報告: `F06-report.md`、`F06b-report.md`、`F06c-report.md`（報告の末尾の「設計者の判断」は、設計者が承認した事項です）
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（再改訂版）、5.5

## とくに確かめること

- R2-N1: 内側の要素がスクロールするページで、何もしないボタンが VERIFIED にならないこと。できれば、テストとは別に、`setContent` か `127.0.0.1` で実際に確かめてください。
- 何かが起きるボタン（アコーディオンなど）が、画面外や内側の領域の中にあっても、偽の NOT_VERIFIABLE や偽の BLOCKED_BY_SAFETY にならないこと。
- 凍結の前の下準備（F06b）を加えたことで、次の4点が変わっていないこと。
  - 安全の判定の順序（凍結の後の受け入れの判定、click、観測）
  - Guard（`src/safety/passive-request-guard.ts`）
  - fail-closed の性質
  - 下準備の間の通信が、Passive の通信として Guard の判定を受けること
- 下準備の handle の後片付け（期限の後に届いた場合も含む）に漏れがないこと。unhandledRejection がないこと。
- R1 の Minor（使われていない型）、R2 の N3・N4 が直っていること。
- テストの安定性: `tests/integration/isolated-interaction.test.ts` を、2回続けて実行してください。

## 対象のファイル

- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`
- `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`
- `fixtures/site/inner-scroll-inert-button.html`、`fixed-inert-button.html`、`inner-scroll-accordion.html`
