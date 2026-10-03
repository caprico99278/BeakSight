# R15b 実装報告（要約。設計者が保存）

## 結論

完了した。`collectSiteMetadata` を `src/crawl/site-metadata.ts` に作った。統合テスト11件と `npm run typecheck` は PASS した。

## R15d が使うシグネチャ

```ts
collectSiteMetadata({ contextFactory, origin, config, pageId, allocator, clock, limits? }): Promise<{
  records: [robots, sitemap];            // EvidenceRecordFor<'metadata'>。viewport は null
  sitemap: SitemapEvidence | null;
  unnormalizableSitemapUrlCount: number;
  failures: { kind, timedOut, detail }[];
  ledgerSnapshot: SafetyLedgerSnapshot | null;
  closeFailures: PassiveSessionCloseFailure[];
}>
```

- `config` には、`AuditConfig` をそのまま渡せる。
- 例外を投げるのは、引数が不正な場合だけである。取得の失敗は、`FAILED` の Evidence として返す。
- 取得するのは `GET /robots.txt` と `GET /sitemap.xml` だけである。sitemap の URL には、アクセスしない。

## 実装者の判断と、設計者の判断

1. Context は1つのまま、ファイルごとに新しい page で開く。→ 承認する。
   - 期限切れのナビゲーションを、同じ page の次の `goto` が中断すると、`net::ERR_ABORTED` になる。
   - Guard は、これを違反として記録する。
   - page を閉じる経路なら、Guard は中断を予期する。
2. 正規化できない `<loc>` の件数は、結果の項目で返す。→ 承認する。
3. 2xx でも、根の要素が `urlset` か `sitemapindex` でない本文からは、URL を取り出さない（`sitemapUrls: null`）。→ 承認する。
4. 本文は、`OK` の場合だけ残す。→ 承認する。
5. `src/crawl` から、`src/orchestration` の部品を import する。→ 承認する。Architecture Gate に、import の向きの規則はない。設計書が決めた置き場所と部品に従った結果である。
6. 本文の URL の認証情報は、伏せ字にしない。→ 承認する。公開されているファイルである。

## 発見事項と、設計者の判断

1. `sitemapUrls` が「正規化した値」か「正規化の前の値」かで、コメントが食い違っている。
   - 判断: R15d でコメントを直す。実装（正規化した値）を正とする。
2. `<sitemapindex>` の入れ子の sitemap の URL を、`sitemapUrls` に記録している。そのため、`SITEMAP_URL_NOT_DISCOVERED` が、入れ子の sitemap の URL を「発見されなかったページ」として報告する。
   - 判断: R15d で直す。
     - sitemap の index の場合は、`sitemapUrls` を null にする。入れ子の URL は、ページの URL ではないためである。
     - その結果、`SitemapEvidence` も null になり、sitemap の2つの Rule は判定しない。
     - 入れ子の URL は、本文（`text`）に事実として残る。
     - 入れ子をたどらないことは、制約として、設計書 5.6.2 に書いた。
