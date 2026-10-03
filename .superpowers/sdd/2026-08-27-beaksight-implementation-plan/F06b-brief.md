# F06b 指示書: 変化を観測する前に、対象を画面内にスクロールしておく（R2-N1、R1-3）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F06b
- 目的: 内側の要素がスクロールするページや、`position: fixed` の要素で、何もしないボタンが VERIFIED にならないようにする。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.4（再改訂。選択肢 A）
- 背景: 作業記録置き場の `F06-report.md`（Blocker と、設計者の判断）、`R2-review-result.md`（N1）、`R1-review-result.md`（Minor 3）

同時に、ほかの実装者が F07（config・core の型・crawl・schemas）を変更しています。これらのファイルは変更しないでください。

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`
- `src/interaction/discover-candidates.ts`（下準備で使う関数の呼び出しに必要な、最小限の変更に限る）
- テスト: `tests/integration/isolated-interaction.test.ts`
- `fixtures/site/` への新しいページの追加

## 修正する内容

設計書 4.4 の選択肢 A のとおり、凍結の前に下準備を行う。

1. 凍結の前（初期描画の後）に、候補を探し直し、handle を解決する。
2. `scrollIntoViewIfNeeded` を期限付きで実行する（`awaitBrowserWork` など、既存の期限付きの待ち方を使う）。
3. handle を破棄する（期限付き。F06 の `disposeRetainedHandleUntil` を使う）。
4. ページが落ち着くのを待つ。
5. 凍結する。
6. その後は、これまでと同じ流れで進める。

条件は次のとおり。

- 下準備の探索で使う DOM の作業量は、共有の上限から差し引く。
- 下準備の途中で失敗した場合、期限を過ぎた場合、DOM の作業量の上限に達した場合は、`NOT_VERIFIABLE` にする。理由は、それぞれの原因を区別できる形にする。
- 下準備の間の通信は、Passive フェーズの通信として、これまでどおり Guard の判定を受ける（Guard は変更しない）。
- ページ座標への補正は残す（既存の `:4376` のテストは変えない）。

## 回帰テスト

何もしないボタンについて、次の3つの場合を確かめる。

- ページ全体がスクロールする場合（既存の `:4402` のテストが、引き続き PASS すること）
- 内側の要素がスクロールする場合（`html, body {overflow:hidden}` と、内側の要素の `overflow-y:auto`）。ボタンは内側の領域の画面外に置く。修正前は VERIFIED になる（RED）こと。
- `position: fixed` の要素の場合。スクロールが起きるページに置く。修正前に RED になるかどうかを確かめ、結果を報告する（RED にならない場合も、回帰テストとして残す）。

さらに、何かが起きるボタン（例: アコーディオン）を内側の領域の画面外に置き、VERIFIED になることを確かめる。偽の NOT_VERIFIABLE を防ぐためである。

## 受け入れ条件

- 上の回帰テストが、設計どおりに PASS する。
- `tests/integration/isolated-interaction.test.ts` のすべてのテストが PASS する。2回続けて実行し、2回とも PASS すること。
- `npm run typecheck` の担当範囲が PASS する。

## 報告

共通ルールの形式で報告してください。
