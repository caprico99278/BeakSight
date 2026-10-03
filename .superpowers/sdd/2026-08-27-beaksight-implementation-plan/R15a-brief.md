# R15a 指示書: Task 15 の型・スキーマ・fixture の土台

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: R15a
- 目的: Run Coordinator（R15d）と、サイトの metadata（R15b）の前提になるものを作る。対象は、次のとおり。
  - 型とスキーマ
  - 監査しなかった URL の結果を作る部品
  - ナビゲーションの失敗の detail
  - fixture
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 5.6（とくに 5.6.1〜5.6.5、5.6.8）
- 実装計画: `doc/design/2026-09-24-beaksight-task-15-implementation-plan.md` の R15a
- 関連する設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の第7章（sitemap の切り詰め）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/evidence-types.ts`、`src/core/contracts.ts`
- `schemas/page.schema.json`、`schemas/run.schema.json`
- `src/audit/cross-page-rules.ts`（sitemap の切り詰めの扱いに限る）
- `src/orchestration/page-auditor.ts`（ナビゲーションの失敗の detail に限る）
- 新規: `src/orchestration/skipped-page.ts`
- `fixtures/server.ts`、`fixtures/site/`
- テスト:
  - `tests/unit/*`（contracts、schema-validator、schema-enum-consistency、新しい `skipped-page.test.ts`）
  - `tests/component/cross-page-rules.test.ts`、`tests/component/safety-rules.test.ts`（metadata の見本の更新に限る）
  - `tests/integration/page-auditor.test.ts`（detail の変更に伴うものに限る）
  - `tests/integration/fixture-server.test.ts`

## 作るもの

1. **`MetadataEvidence` を改める**（設計書 5.6.2）
   - 項目:
     - `kind`: `ROBOTS_TXT` か `SITEMAP_XML`
     - `url`
     - `outcome`: `OK`、`NOT_FOUND`、`FAILED` のいずれか
     - `httpStatus`（number か null）
     - `text`（上限付きの文字列か null）と、`textTruncated`
     - `sitemapUrls`（上限付きの配列か null。sitemap の場合だけ値を持つ）と、`sitemapUrlsTruncated`
   - 閉じた一覧は、core の `as const` の配列にする。
   - 上限は、名前を付けた定数にし、`src/core/limits.ts` に置く。値は、次を目安に決め、報告する。
     - 本文の文字数: 数十万文字程度
     - sitemap の URL の件数: 数万件程度
   - スキーマ、スキーマの見本、enum の一致のテストを直す。
2. **`SitemapEvidence` に `truncated` を加える**
   - Cross-page rule で、`truncated` が真の場合は、`DISCOVERED_URL_NOT_IN_SITEMAP` を判定しない。
   - テストで確かめる。修正前に RED、修正後に GREEN になること。
   - `MetadataEvidence` の record から `SitemapEvidence` を作る関数を、1つ置く。置き場所は、`src/crawl/` か core とする。
3. **`RunSummary` の追加**（設計書 5.6.5）
   - 次の3つを、型とスキーマに加える。
     - `partialPageCount`
     - `unverifiedInternalLinkCount`
     - `retries`
   - `retries` の各要素は、次の項目を持つ。
     - `url`
     - `attempt`（1から始まる整数）
     - `navigationOutcome`
     - `detail`
4. **`AuditRunResult` の型**（設計書 5.6.1）
   - `{ run: RunSummary; pages: readonly PageAuditResult[]; findings: readonly Finding[] }` を、core に置く。
   - `schemas/audit.schema.json` の最上位の形（`run`、`pages`、`findings`）と、合っていることを確かめる。
   - 合わない場合は、止まって報告する。
5. **ナビゲーションの失敗の detail**（設計書 5.6.4）
   - Page Auditor で、`NAVIGATION_FAILED` の理由の detail を、次の形にする。
     - `TIMEOUT`
     - `BLOCKED_EXTERNAL_REDIRECT`
     - `FAILED:<Chromium のエラーのコード>`
   - エラーのコード（例: `net::ERR_CONNECTION_REFUSED`）は、`navigatePage` の `failureDetail` から取り出す。
     - 取り出す関数は、1か所にまとめる。
     - コードがない場合は、`FAILED` とする。
   - 統合テストで、つながらないポートへのナビゲーションが `FAILED:net::ERR_CONNECTION_REFUSED` になることを確かめる。
     - Chromium が実際に返すコードを確かめ、報告する。
6. **`skippedPageResult(url, pageId, reason)`**（`src/orchestration/skipped-page.ts`。設計書 5.6.3）
   - 両方のビューポートを `SKIPPED` にする。
   - `navigationOutcome` を null にする。
   - `finalUrl` と `httpStatus` を null にする。
   - 理由を持たせる。
   - Evidence と Finding は空にする。
   - 結果が `page` のスキーマに合うことと、凍結されていることを、単体テストで確かめる。
   - ページの状態は、`derivePageAuditStatus` で `SKIPPED` になること。
7. **fixture**（設計書 5.6.8）
   - `fixtures/server.ts` の `contentTypeFor` に、次の3つを加える。
     - `.txt`: `text/plain; charset=utf-8`
     - `.xml`: `application/xml`
     - `.css`: `text/css; charset=utf-8`
   - `fixtures/site/robots.txt` と `fixtures/site/sitemap.xml` を置く。
     - sitemap には、クロールの fixture のページと、クロールでは発見されないページを載せる。
   - 404 の場合を確かめるため、`startFixtureServer` に、次のオプションを加える。
     - `robots.txt` と `sitemap.xml` を 404 にするオプション（例: `siteMetadata: false`）
   - クロールの fixture を、`fixtures/site/crawl/` の下に置く。
     - 開始のページ（例: `/crawl/index.html`）
     - 深さ3まで続くリンクの連なり
     - 404 になる内部リンク
     - 同じページへの重複したリンク
     - 外部のリンク
     - `mailto:`
   - 既存のテストの前提（ページの数、リンクの数など）を変えないこと。
   - `tests/integration/fixture-server.test.ts` で、応答の種類を確かめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。R15b〜R15d の実装者が使うので、新しく作った型と関数のシグネチャを一覧にしてください。
