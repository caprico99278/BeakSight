# R15a 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` は PASS した（63ファイル、2316件）。

## R15b〜R15d が使う型と関数

```ts
// src/core/evidence-types.ts
SITE_METADATA_KINDS = ['ROBOTS_TXT', 'SITEMAP_XML']; SITE_METADATA_OUTCOMES = ['OK', 'NOT_FOUND', 'FAILED'];
type MetadataEvidence = RobotsTxtMetadataEvidence | SitemapXmlMetadataEvidence;
//   共通: kind, url, outcome, httpStatus: number|null, text: string|null, textTruncated: boolean
//   ROBOTS_TXT: sitemapUrls: null; sitemapUrlsTruncated: false
//   SITEMAP_XML: sitemapUrls: readonly string[]|null; sitemapUrlsTruncated: boolean
interface SitemapEvidence { evidenceId; urls: readonly string[]; truncated: boolean }
// src/core/limits.ts
MAX_SITE_METADATA_TEXT_LENGTH = 500_000; MAX_SITEMAP_URLS = 50_000;
// src/core/contracts.ts
RunSummary に partialPageCount、unverifiedInternalLinkCount、retries: readonly RunRetryRecord[] を追加した。
interface RunRetryRecord { url; attempt /* 1から */; navigationOutcome; detail: string | null }
interface AuditRunResult { run; pages; findings }   // audit.json の schemaVersion は Task 16 の書き出しで付ける
// src/crawl/sitemap-evidence.ts
sitemapEvidenceFromMetadata(record: EvidenceRecordFor<'metadata'>): SitemapEvidence | null
// src/orchestration/page-auditor.ts
chromiumNetErrorCode(failureDetail): string | null
navigationFailureDetail({ navigationOutcome, failureDetail }): 'TIMEOUT' | 'BLOCKED_EXTERNAL_REDIRECT' | 'FAILED:net::ERR_…' | 'FAILED'
// src/orchestration/skipped-page.ts
skippedPageResult(url, pageId, reason): PageAuditResult
// fixtures/server.ts
FixtureServerOptions.siteMetadata?: boolean   // false なら /robots.txt と /sitemap.xml が 404
```

- クロールの fixture は、`fixtures/site/crawl/` にある。
  - `index.html` から、`level-1`〜`level-3` の深さ3まで、リンクが続く。
  - 開始のページには、次のリンクがある。
    - `level-1` への重複したリンク
    - 404 の `/crawl/missing.html`
    - 外部のリンク
    - `mailto:`
  - `sitemap-only.html` がある。
- sitemap は、`{{FIXTURE_ORIGIN}}` を、サーバの Origin に置き換えて返す。
  - 載せているのは、`index`、`level-1`、`level-2`、`sitemap-only` である。
  - `level-3` は、あえて載せていない。

## 実装者の判断と、設計者の判断

1. `SitemapEvidence.truncated` は、`sitemapUrlsTruncated` だけから作る。→ 承認する。
   - R15b は、切り詰める前の本文から、`<loc>` を取り出す。
2. Cross-page rule の索引では、`truncated !== false` の場合を、切り詰めとして扱う。→ 承認する。「sitemap にない」と言いすぎないための、安全側の扱いである。
3. `retries[].navigationOutcome` の enum は、`NAVIGATION_OUTCOME_KINDS` の全体とする。→ 承認する。
4. スキーマの `metadataEvidence` に、項目どうしの整合の制約（`if`/`then`）を付けた。→ 承認する。
5. fixture のサーバで、robots.txt と sitemap.xml の Origin を置き換える。→ 承認する。
6. `src/core/limits.ts` の変更は、指示書の項目1が明示した場所である。→ 承認する。
7. 共通部品台帳への登録。→ 設計者が登録した。
8. ページ全体の理由をまとめる処理（`pageIncompleteReasons`）を公開していない。→ 必要になった時点で、共通化の候補にする。

## 発見事項と、設計者の判断

- **接続拒否のナビゲーションで、Guard が `HTTP_MAIN_FRAME_DELIVERY_FAILED` の違反を記録し、Context を無効にする。**
  - 判断: 既存不具合 DEF-004 として登録し、直す。
  - この違反の目的は、Guard 自身の不具合（配送の取りこぼし、予期しない中断）を fail-closed で検出することである。
  - 許可した GET と HEAD の、ネットワークの層の失敗（接続の拒否、名前解決の失敗、TLS の失敗など）は、安全の問題ではない。
  - これを違反にすると、一時的なネットワークの失敗でも、Run が `ABORTED_BY_SAFETY` になる。これは、設計書 5.2 の再試行と矛盾する。
