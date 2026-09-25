# R15d 指示書: Run Coordinator

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: R15d
- 目的:
  - 開始の URL から BFS でクロールする `RunCoordinator` を作る。
  - 確定した Run（`AuditRunResult`）を返す。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第5章。とくに次の節。
  - 5.2（再試行の対象）
  - 5.3（内部リンク切れ）
  - 5.4 と 5.4.1（Run Status の入力）
  - 5.5（環境の事実）
  - 5.6（詳細の決定）
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 15
- 実装計画: `doc/design/2026-09-24-beaksight-task-15-implementation-plan.md` の R15d
- 前の報告（作業記録置き場）:
  - `R15a-report.md`、`R15b-report.md`、`R15c-report.md`、`DEF-004-report.md`、`I15a-report.md`
  - `P14c-report.md`、`P14d-report.md`（`PageAuditor` の入口）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 共通化候補の台帳: 作業記録置き場の `commonization-candidates.md` の CC-020

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- 新規: `src/orchestration/run-coordinator.ts`
  - 分けたい場合は、`src/orchestration/` の下に新しいファイルを作ってよい。例: 集計の関数、URL の状態の管理。分けた理由は、報告に書く。
- CC-020 のための変更:
  - 新しい共通の関数を置くファイル
  - `src/orchestration/page-auditor.ts`、`src/orchestration/environment.ts`（使う側の置き換えに限る）
- `src/crawl/site-metadata.ts`（sitemap の index の扱いに限る）
- `src/core/evidence-types.ts`、`src/crawl/sitemap-evidence.ts`（`sitemapUrls` のコメントの修正に限る）
- テスト:
  - 新規の `tests/unit/run-coordinator.test.ts` と `tests/integration/crawl-run.test.ts`
  - `tests/integration/site-metadata.test.ts`
  - CC-020 の単体テスト
- `fixtures/site/crawl/`（必要な場合に限る）

## 作るもの

### 1. 入口（設計書 5.6.1）

- `new RunCoordinator(deps)` と `run(): Promise<AuditRunResult>` を作る。
- 注入するもの:
  - 設定（`loadConfig` の検証済みのもの）
  - `BrowserLauncher`
  - `SafetyLedger` を作る関数
  - 時計（`() => Date`）と、現在の時刻（`() => number`。`Date.now` と同じ基準）
  - 出力先
  - `PageAuditor` を作る関数（テストで偽の Page Auditor を渡すため）
  - `collectSiteMetadata` の差し替え口（テスト用。本番は既定の関数）
- 流れ:
  1. 開始の時刻から、`runId` を作る。
  2. `runPreflight` を行う。
     - 失敗した場合は、対象のサイトにアクセスせずに、Run を `FAILED` で確定する。
     - 環境の事実は、browser が null のままでも集める。
  3. 環境の事実を集める（`collectRunEnvironment`、`readToolVersion`）。
  4. 採番器を作る。開始の URL のページの ID を採番する。
  5. `collectSiteMetadata` を行う。Evidence は、開始の URL のページに置く（設計書 5.6.2）。
  6. BFS でクロールする（設計書 5.6.3）。
  7. 再試行する（設計書 5.6.4）。
  8. Cross-page rule を評価する（`evaluateCrossPageRules`）。
     - 採番器の Finding の連番で評価し、評価の後に連番を進める。
     - 入力には、次のものを渡す。
       - すべてのページ（SKIPPED を含む）
       - sitemap
       - 許可 Origin
       - 許可する query
       - 評価の失敗
     - 評価の失敗は、Run の理由に加える。
  9. すべての `PageAuditResult` と Finding を、`validateArtifact` で確かめる（`requiredArtifactsValid`）。
  10. `RunSummary` を組み立てる（設計書 5.6.5）。
  11. Run Status を導く（設計書 5.6.6）。
  12. `finally` で、Browser を閉じる。閉じる処理の失敗は、理由に加える。
- 予期しない例外は、捕まえて `unhandledFailures` に数える。そのうえで、Run を確定して返す。`run()` は、引数と依存が不正な場合を除き、reject しない。

### 2. URL の状態、深さ、上限（設計書 5.6.3）

- 状態は、URL ごとに持つ。
- `CrawlQueue` は、FIFO と重複の排除だけに使う。
- 開始の URL を、深さ0とする。
- Link は、各ページの Desktop の `link` の Evidence から取る。`INTERNAL_NAVIGABLE` のものだけを使う（ARCH03）。
- 深さが `maxDepth` を超える URL は、キューに入れない。状態を `SKIPPED` にし、`skippedPageResult` の理由を `MAX_DEPTH_REACHED` とする。
- 次のページを始める前に、毎回、ページ数と実行時間を確かめる。上限に達した後の URL は、`SKIPPED` にする。理由は、`MAX_PAGES_REACHED` か `MAX_RUNTIME_REACHED` とする。
- 上限に達した事実は、`crawlLimits` と、Run の理由に記録する。
- `discoveredPageCount` は、発見した内部の URL の数とする。開始の URL を含む。

### 3. 再試行（設計書 5.2、5.6.4）

- 再試行の対象の detail の一覧を、run-coordinator の中の1つの定数として置く。
  - 一覧は、`navigationFailureDetail` で作る。detail の形を、別の場所に書き直さない。
  - 対象は、`TIMEOUT` と、`FAILED:net::ERR_CONNECTION_RESET`、`ERR_CONNECTION_CLOSED`、`ERR_EMPTY_RESPONSE`、`ERR_NETWORK_CHANGED` である。
- Desktop のビューポートの `NAVIGATION_FAILED` の detail が、一覧に載る場合だけ、同じ `pageId` で1回だけ再試行する。
- 最初の試行を、`RunSummary.retries` に記録する。最終の試行の結果だけを、`pages` に入れる。

### 4. Run Status の入力（設計書 5.6.6）

設計書 5.6.6 の表のとおりにする。

- Interaction の件数は、各ページの `interaction` の Evidence から数える。
  - `EXECUTION_FAILED` は、`failedRequiredWork` に入れる。
  - `NOT_VERIFIABLE` で区分が `CHECK_NOT_COMPLETED` のものは、`notVerifiedRequiredWork` に入れる（I15a）。
- 違反と、記録の切り詰めは、次のものを合計する。
  - すべての `PageSafetySummary`
  - PREFLIGHT の Ledger
  - 環境の事実の Ledger
  - サイトの metadata の Ledger
  - 集計には、`summarizePageSafety` を使う。
- Safety の集計（`RunSafetySummary.blockedActions`、`blockedRequestsByMethod`）は、すべての `safety` の Evidence と、Coordinator が作った Ledger から集計する。
  - 同じ集計を、2か所に書かない。

### 5. CC-020

- ビューポートと、設定の大きさの対応づけを、1つの関数にする。
  - 例: `viewportSizeFor(config, profile)`
  - 置き場所は、`src/config/` か `src/core/` とする。
- Page Auditor、環境の事実、Run Coordinator は、この関数を使う。

### 6. sitemap の index と、コメントの修正（R15b の発見事項）

- `collectSiteMetadata` で、根の要素が `<sitemapindex>` の場合は、`sitemapUrls` を null にする（設計書 5.6.2）。
  - `site-metadata.test.ts` の、sitemap の index のテストを合わせる。
- `sitemapUrls` のコメントを、「正規化した値」に直す。
  - 対象: `src/core/evidence-types.ts` の該当の2か所と、`src/crawl/sitemap-evidence.ts`

## テスト

1. **単体テスト**（`tests/unit/run-coordinator.test.ts`）
   - 偽の Page Auditor と、偽の PREFLIGHT などを使ってよい。実装計画 Task 15 の Step 1 を確かめる。
     - ページ数、深さ、実行時間の上限に達した場合は、それぞれ `PARTIAL` と、具体的な理由になる。
     - 50/50 のページを監査し、Finding がある場合も、`COMPLETE` になれる。
     - 50 のうち 49 のページだけを監査した場合（1ページが SKIPPED）は、`COMPLETE` にならない。
   - 次のことも確かめる。
     - 再試行の対象の失敗では、1回だけ再試行し、`retries` に記録される。
     - 対象でない失敗では、再試行しない。
     - PREFLIGHT が失敗した場合は、Page Auditor が呼ばれず、`FAILED` になる。
     - 違反がある場合は、`ABORTED_BY_SAFETY` になる。
     - `CHECK_NOT_COMPLETED` の Interaction がある場合は、`PARTIAL` になる。
     - `OBSERVED_NO_CHANGE` だけの場合は、`COMPLETE` のままになる。
     - `EXECUTION_FAILED` がある場合は、`PARTIAL` になる。
     - 予期しない例外は、`unhandledFailures` に数えられ、Run が確定する。
     - URL の発見の順と、ID が、決定論的である。
2. **統合テスト**（`tests/integration/crawl-run.test.ts`）
   - fixture の `/crawl/index.html` から、実際の Chromium でクロールする。次のことを確かめる。
     - 深さ3まで監査する。
     - 404 のリンク先に、`BROKEN_INTERNAL_LINK` ができる。
     - 外部のリンクと `mailto:` は、巡回しない。
     - sitemap にだけある URL は、巡回しない。
     - `SITEMAP_URL_NOT_DISCOVERED` と `DISCOVERED_URL_NOT_IN_SITEMAP` が、事実どおりにできる。
     - robots と sitemap の Evidence が、開始のページにある。
     - `maxDepth` と `maxPages` を小さくした場合は、`PARTIAL` と具体的な理由になる。
     - すべてのページと Finding が、スキーマに合う。
     - GET 以外が、サーバに届かない。
     - 後に、Chromium と Context が残らない。
   - 統合テストの実行時間が長くなりすぎないよう、設定で Interaction の段階を調整してよい。調整した内容は、報告に書く。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 共通部品台帳の部品を使う。同じ意味の処理を、新しく書かない。
  - 例: 状態の集計、理由の書式、ID、正規化、Safety の集計、スキーマの検証、detail の形。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。Task 16 と Task 17 の実装者が使うので、`RunCoordinator` のシグネチャと、注入するものを書いてください。
