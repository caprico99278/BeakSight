# R15b 指示書: サイトの metadata（robots.txt と sitemap.xml）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: R15b
- 目的: robots.txt と sitemap.xml を、Guard の付いた Passive Context で取得する。取得した内容は、Evidence（`metadata`）にする。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 5.6.2
- 上位の設計書: `doc/design/2026-08-27-beaksight-web-audit-design.md` の 8.1（sitemap にだけある URL は巡回しない）
- 実装計画: `doc/design/2026-09-24-beaksight-task-15-implementation-plan.md` の R15b
- 前の報告: 作業記録置き場の `R15a-report.md`。`MetadataEvidence`、`SitemapEvidence`、fixture のシグネチャと構成は、ここにある。
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
  - 使う部品: `createEvidenceRecord`、`closePassivePageAndContext`、`normalizeUrl`、`classifyUrl`、`safeErrorMessage`、`isPlaywrightTimeoutError`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（R15c）が、`src/orchestration/preflight.ts` と `src/orchestration/environment.ts` を作っています。もう1人の実装者（DEF-004）が、`src/safety/passive-request-guard.ts` とそのテストを変えています。担当のファイル以外は変更しないでください。`npm run verify` は実行しないでください。

## 変更してよいファイル

- 新規: `src/crawl/site-metadata.ts`
- 新規のテスト: `tests/integration/site-metadata.test.ts`
- `fixtures/site/` への新しいファイルの追加（R15a で置いた robots.txt と sitemap.xml を変える必要がある場合は、報告してから変える）

## 作るもの

`collectSiteMetadata(options): Promise<SiteMetadataResult>` を作る。

- 入力:
  - `BrowserContextFactory`
  - 開始の URL の Origin
  - 設定（`allowedOrigins`、`allowedQueryParameters`、`navigationTimeoutMs`）
  - Evidence の組み立てに使う、次の3つ
    - `pageId`（開始の URL のページのもの）
    - `IdAllocator`
    - 時計
- 処理:
  1. Passive Context と page を作る。
  2. `<Origin>/robots.txt` と `<Origin>/sitemap.xml` を、この順に、`page.goto` の GET で開く。
     - 本文は、応答の `response.text()` から読む。
     - Node の `fetch` は使わない。
  3. 結果を、`MetadataEvidence` にする。`outcome` は、次の規則で決める。
     - 2xx の応答: `OK`
     - 404 と 410: `NOT_FOUND`
     - それ以外の応答と、ナビゲーションの失敗: `FAILED`
  4. sitemap の場合は、`<loc>` の値を取り出す。
     - 取り出した値は、`normalizeUrl` で正規化し、`sitemapUrls` にする。
     - 正規化できないものは、捨てずに件数を数える。数えた件数を返すか、Evidence に残すかは、実装者が決めて報告する。
     - 許可 Origin の外の URL も、事実として残す。
     - XML の解析は、新しい依存パッケージを使わずに行う。
       - 例えば、`<loc>` の要素を、上限付きで取り出す。
       - CDATA と、エンティティ（`&amp;` など）を扱う。
     - sitemap の index（`<sitemapindex>`）は、入れ子の sitemap をたどらない。
       - 事実として、`<loc>` を記録するだけにする。
       - これを制約とするかどうかを、報告に書く。
  5. 本文の文字数と、URL の件数には、上限を設ける。上限は、R15a の定数を使う。
     - 上限で切り詰めた場合は、印を残す。
  6. `finally` で、page と Context を閉じる（`closePassivePageAndContext`）。
- 出力（`SiteMetadataResult`）:
  - Evidence の record（2つ）
  - Cross-page rule に渡す `SitemapEvidence`（ない場合は null）
    - `SitemapEvidence` は、R15a の変換の関数で作る。
  - 使った Ledger の snapshot
  - 閉じる処理の失敗
- 例外は、引数が不正な場合だけにする。取得の失敗は、`FAILED` の Evidence として返す。

## テスト

`tests/integration/site-metadata.test.ts` を作り、fixture のサーバで確かめる。

1. robots.txt と sitemap.xml がある場合に、次のことを確かめる。
   - 両方の Evidence が `OK` になる。
   - sitemap の URL が、正規化されて取り出される。
2. 両方が 404 の場合（R15a のオプションを使う）に、`NOT_FOUND` になる。
3. 上限を小さくした場合に、切り詰めの印が付く。
   - 上限を差し替える口を作る場合は、本番の既定値を変えない形にする。
4. CDATA、エンティティ、sitemap の index、許可 Origin の外の URL、正規化できない URL を含む sitemap を扱える。
5. GET 以外が、サーバに送られない。
6. 監査の後に、Context が残らない。
7. Evidence が、`page` のスキーマの `metadata` の Evidence に合う。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 共通部品台帳の部品を使う。同じ意味の処理を、新しく書かない。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` は実行しない（並行作業のため）。全体の verify は、設計者が行う。

## 報告

共通ルールの形式で、日本語で報告してください。R15d の実装者が使うので、`collectSiteMetadata` のシグネチャを書いてください。
