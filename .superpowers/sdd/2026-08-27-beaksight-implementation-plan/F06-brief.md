# F06 指示書: 再レビューの Minor の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F06
- 目的: 基盤修正の後の独立レビュー（R1〜R4）で見つかった Minor の指摘を修正する。
- レビューの結果: 作業記録置き場の `R1-review-result.md`（ほかの R2〜R4 の結果は、設計者がこの指示書に追記する）

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`、`src/evidence/interaction-collector.ts`
- `fixtures/site/` への新しいページの追加
- テスト: `tests/integration/isolated-interaction.test.ts`
- （R2〜R4 の結果に応じて、設計者が追記する）

## 修正する内容

1. **R1-2**: `src/interaction/isolated-auditor.ts:57` 付近の、使われていない公開の型 `InteractionLifecycleOutcome`（NON_TERMINAL を含む）を削除する。ほかから参照されていないことを `grep` で確かめる。
2. **R2-N1 と R1-3**（設計書 4.4 の改訂）: 変化を観測する前に、対象の要素を画面内にスクロールしておく方式に改める。
   - Interaction の凍結（freeze）の前、Passive フェーズの間に、対象の要素を画面内にスクロールする。例えば、handle の `scrollIntoViewIfNeeded` を期限付きで待つ。
   - ページが落ち着くのを待ってから、凍結し、変化を観測する前の状態を取る。
   - スクロールに失敗した場合と、期限を過ぎた場合は、`NOT_VERIFIABLE` にする。
   - 回帰テストでは、何もしないボタンについて、次の3つの場合を確かめる。修正前に RED、修正後に GREEN になること。
     - ページ全体がスクロールする場合（既存の `:4402` のテスト）
     - 内側の要素がスクロールする場合（`html, body {overflow:hidden}` と、内側の要素の `overflow-y:auto`）
     - `position: fixed` の要素の場合
   - いまの実装で、凍結がどの時点で有効になるかを確かめる。凍結の前にスクロールする構成にできない場合（例: 凍結が handle の解決より前に有効になる場合）は、実装せずに止まって報告する。
3. **R2-N3**: `targetHandle.dispose()`（`isolated-auditor.ts:649` 付近）を、期限付きで待つ。期限を過ぎた場合の扱いは、既存の、期限を過ぎてから届いた handle の破棄の扱いにそろえる。
4. **R2-N4**:
   - `awaitBrowserWork`（`:316-321` 付近）は、期限がすでに過ぎている場合、ブラウザ内の評価を始めずに期限切れを返す。
   - `:538` 付近で重複している条件を1つにする。

## 受け入れ条件

- 各項目について、修正前に RED、修正後に GREEN になる（1 は型の削除なので、typecheck で確かめる）。
- 変更したファイルのテストと、`npm run typecheck` が PASS する。

## 報告

共通ルールの形式で報告してください。
