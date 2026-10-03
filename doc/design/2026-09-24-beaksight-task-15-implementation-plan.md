# BeakSight Task 15 Run Coordinator 実装計画

作成日: 2026-09-24
状態: ユーザー承認済みの範囲内で、設計者が確定した（2026-09-23 のユーザーの開発指示に基づく）
設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第5章（とくに 5.6）
上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` Task 15

## 1. 目的

開始の URL から BFS でクロールする `RunCoordinator` を作る。1ページずつ `PageAuditor` で監査し、次のことを行う。

- 上限と再試行を守る。
- Cross-page rule を評価する。
- Run Status を導く。
- 確定した Run（`AuditRunResult`）を返す。

## 2. サブタスクの分け方と順序

| ID | 内容 | 主に変更するファイル | 前提 |
| --- | --- | --- | --- |
| I15a | Interaction の `NOT_VERIFIABLE` の区分 | `src/interaction/isolated-auditor.ts`、`src/core/evidence-types.ts`、`schemas/page.schema.json` | C14x |
| R15a | 型とスキーマと fixture の土台 | `src/core/*`、`schemas/*`、`src/orchestration/page-auditor.ts`（ナビゲーションの失敗の detail）、`src/orchestration/skipped-page.ts`、`src/audit/cross-page-rules.ts`（sitemap の切り詰め）、`fixtures/*` | I15a |
| R15b | サイトの metadata | `src/crawl/site-metadata.ts` | R15a |
| R15c | PREFLIGHT と環境の事実 | `src/orchestration/preflight.ts`、`src/orchestration/environment.ts` | R15a |
| R15d | Run Coordinator | `src/orchestration/run-coordinator.ts`、`tests/unit/run-coordinator.test.ts`、`tests/integration/crawl-run.test.ts` | R15b、R15c |

- I15a と R15a は、どちらも `evidence-types.ts` と `page.schema.json` を変える。そのため、順に行う。
- R15b と R15c は、変更するファイルが重ならない。そのため、並行で行ってよい。両方の指示書に、並行であることを書く。
- R15d の後に、Task 15 のチェックポイントの独立レビューを行う（実装タスク指示 第12章）。

## 3. 各サブタスクの要点

### R15a 型とスキーマと fixture の土台

- `MetadataEvidence` を、設計書 5.6.2 の形に改める。
- `SitemapEvidence` に `truncated` を加える。`truncated` が真なら、Cross-page rule は `DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。
- `RunSummary` とスキーマに、次の3つを加える（設計書 5.6.5）。
  - `partialPageCount`
  - `unverifiedInternalLinkCount`
  - `retries`
- `AuditRunResult` の型を、core に置く（設計書 5.6.1）。
- Page Auditor で、ナビゲーションが失敗したときの理由の detail を、`FAILED:<エラーのコード>` の形にする（設計書 5.6.4）。
- 監査しなかった URL の `PageAuditResult` を作る関数を、`src/orchestration/skipped-page.ts` に置く（設計書 5.6.3）。
- fixture のサーバの応答の種類を直す。クロール用の fixture を加える（設計書 5.6.8）。

### R15b サイトの metadata

- `collectSiteMetadata` を作る（設計書 5.6.2）。
- 統合テストで、次のことを確かめる。
  - robots.txt と sitemap.xml がある場合と、ない場合（404）
  - 上限での切り詰め
  - 外部の URL の扱い
  - GET 以外が送られないこと

### R15c PREFLIGHT と環境の事実

- PREFLIGHT と、環境の事実の収集を作る（設計書 5.6.7）。
- テストで、次のことを確かめる。
  - 各項目が失敗した場合に、対象のサイトにアクセスしないこと
  - `runId` の形

### R15d Run Coordinator

- BFS、URL の状態、深さ、上限、再試行を作る（設計書 5.6.3、5.6.4）。
- Cross-page rule を評価する。
- `RunSummary` を組み立てる（設計書 5.6.5）。
- Run Status の入力を組み立てる（設計書 5.6.6）。
- 実装計画 Task 15 の Step 1 のテストを書く。偽の Page Auditor を使った単体テストでよい。
  - ページ数、深さ、実行時間の上限に達した場合に、`PARTIAL` と具体的な理由になる。
  - 50/50 のページを監査した場合は、Finding があっても `COMPLETE` になれる。
  - 50 のうち 49 のページだけを監査した場合は、`COMPLETE` にならない。
- fixture のクロールの統合テストを書く（`tests/integration/crawl-run.test.ts`）。

## 4. 各サブタスクの共通の受け入れ条件

- TDD（RED → GREEN → 関連する検証）で進める。
- `npm run verify` が PASS する。並行作業の場合は、設計者が実行する。
- 共通部品台帳の部品を使う。同じ意味の処理を、新しく書かない。
- 変更したファイルの一覧と SHA-256 を、報告に書く。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-24 | 初版 | - | Task 15 |
