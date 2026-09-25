# C4 指示書: スクロールと収集位置の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C4
- 目的: レビュー指摘 V2（偽のCOMPLETE）と V3（収集時のスクロール位置）を修正する。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 5.1、5.2
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C4
- レビュー記録（指摘の詳細と再現条件）: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/` の `task-06-10-review-2026-09-23.md`（V2、V3）
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（F01 で新設した deadline・errors・guards・immutable・text・limits）

同時に、ほかの実装者が別の範囲の修正（C1: 設定・クロール、C2: 安全まわり、C7: performance・network・console・axe）を行っています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/browser/controlled-scroll.ts`
- `src/evidence/layout-collector.ts`（スクロール位置の記録の追加だけ）
- `src/evidence/color-collector.ts`（スクロール位置の記録と、標本の範囲の変更だけ）
- `src/evidence/screenshot-collector.ts`
- テスト: `tests/integration/controlled-scroll.test.ts`、`tests/component/layout-collector.test.ts`、`tests/integration/layout-accessibility.test.ts`、`tests/integration/screenshot-collector.test.ts`、および新規のテストファイル
- `fixtures/site/` への新しいページの追加（例: body がスクロールするページ）

## 修正する内容

- **V2**（設計書 5.1）: controlled scroll は、`document.scrollingElement`、`documentElement`、`body` のうち、実際にスクロールする要素を特定して追う。特定できない場合、または一度もスクロールできなかったのに内容の高さがビューポートより大きい場合は、`COMPLETE` ではなく `PARTIAL` と理由を返す。再現条件: `html{overflow:hidden} body{overflow:auto}` のページで、1pxもスクロールせずに `COMPLETE / BOTTOM_AND_HEIGHT_STABLE` を返す。
- **V3**（5.2）: controlled scroll は、終了時にスクロール位置を先頭（0, 0）に戻す（戻せなかった場合は、その事実を結果に記録する）。layout と配色の Evidence に、収集した時点の `scrollX` と `scrollY` を記録する。viewport のスクリーンショットは先頭の位置で撮り、撮影時のスクロール位置を metadata に記録する。配色の標本は、ビューポート内に限らず文書全体の可視要素から、既存の上限の範囲で取る。再現条件: 固定ヘッダと見出しの重なりが、先頭では0件、`scrollY=1050` では2件になる（収集位置が一定でないため）。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。

## 報告

共通ルールの形式で報告してください。各項目（例: R1、V2）ごとに、RED・GREEN の結果を示してください。

## 追加の指示（F03 の完了を受けて）

- 新しく書くテストでは、`tests/helpers/` のテスト補助（`createTestConfig`、`useHeadlessChromium`、`closePassiveResources`、`createDeferred`）を使う。
