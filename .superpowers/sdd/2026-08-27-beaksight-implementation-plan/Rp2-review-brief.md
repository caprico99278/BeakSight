# R'2 指示書: 型・設定・collector の修正の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

## 担当

**前回の独立レビューの R3（Task 1〜5 と型・スキーマ）と R4（Task 6〜10）で出た指摘が、F07・F08 で解消されたか**を確かめてください。

- 前回の結果: `R3-review-result.md`、`R4-review-result.md`（R4 の V13 も含む）
- 修正の報告: `F07-report.md`、`F08-report.md`（報告の末尾の「設計者の判断」は、設計者が承認した事項です）
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 5.1〜5.5、6.4、6.6、第7章

## とくに確かめること

- R4-N1: 偽の COMPLETE がないこと。body の余白が既定のままのページ、内側の領域があるページ、body がスクロールするページ、スクロールできないページを確かめる。できれば、テストとは別に、`setContent` で実際に確かめてください。
- R4-N2: form の外の入力欄と、入力欄ごとの可視性が記録されること。
- Link の入口が `discoverLinks()` の1つだけであること（実装タスク指示 4.2、ARCH03）。
- ページの identity（`requestedUrl`、`finalUrl`、`httpStatus`）と `viewport` の型が、型とスキーマの両方で一致していること。
- 設定の検証が、実行時の判定と一致していること（整数、認証情報）。
- 切り捨てと上限への到達が、すべての collector で記録されること。上限に達したときの状態（PARTIAL か COMPLETE か）の扱いが、設計書の方針（5.1 の追記を含む）とそろっていること。
- V13 のテストが、実ブラウザで Service Worker の遮断と locale・timezone を確かめていること。

## 対象のファイル

- `src/browser/controlled-scroll.ts`、`src/browser/context-factory.ts`
- `src/evidence/dom-collector.ts`、`accessibility-collector.ts`、`layout-collector.ts`、`screenshot-collector.ts`
- `src/crawl/discover-links.ts`、`normalize-url.ts`、`admission-policy.ts`
- `src/config/validate-config.ts`
- `src/core/contracts.ts`、`src/core/evidence-types.ts`
- `schemas/*.json`
- 対応するテストと fixture
