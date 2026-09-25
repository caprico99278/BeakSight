# R16f 実装報告（要約。設計者が保存）

## 結論

完了した。R16 の指摘の1、2、3、5、6 を、TDD で直した。実装者の報告では、`npm run verify` は PASS した（84ファイル、2950件。todo 1件）。UI Gate は、305〜337ms で終わった。

1. Safety の事象の URL
   - `classifyUrl` の結果によらず、`renderUrlAsText` で文字として示す。
   - 見本（`httpSafetyEventSamples`）で確かめた。遮断した POST、外部への作用、ダウンロード、ポップアップの、許可 Origin の中と外の URL である。
2. UI04
   - 分割代入の形と、添字の文字列の形を、検出するようにした。
   - `layout-rules.ts` の `layoutDraft` の1件は、Rule の定義の severity を写すだけなので、理由を付けて除外した。
3. 相対リンク
   - `SAFE_RELATIVE_HREF_PATTERN` を廃止した。安全かどうかは、`isPortableRelativeArtifactPath` だけで判断する。
   - href は、区切りごとに `encodeURIComponent` で符号化する。日本語のパスも、リンクになる。
4. 空の表: 見出し（caption）のある表は、行がなくても、見出しと列の見出しを残し、「なし」の1行を示す。
5. バンドル
   - 各ページの `page.json` を、読んだバイト列のまま入れる。
   - スクリーンショットの合計の大きさに、上限（`CHATGPT_BUNDLE_SCREENSHOT_BUDGET_BYTES` = 64 MiB）を設けた。VIEWPORT、FULL_PAGE の順に入れる。
   - `manifest.json` に、`screenshotBudgetBytes` を書く。
   - 上限は、4番目の引数で注入できる。

新しい仕様に合わせて、既存のテストの期待値を直した。直したのは、事象の URL、`'a b'` のリンク、バンドルの中身と読む順、Evidence のたどり方、生の本文のテストの確かめ方である。

## 実装者の判断と、設計者の判断

1. 見出しのない表（理由の表、事象の表）は、今までどおり「なし」の段落にした。→ 承認する。小見出しの中にあるので、何の表かは分かる。
2. スクリーンショットは入れる順に読み、上限を超えたものは、読んだ直後に捨てる。→ 承認する。持つメモリを抑えられる。
3. Evidence の参照の `パス#アンカー` の形を残した。→ 承認する。
4. 撮り方の優先度を、`SCREENSHOT_BUDGET_PRIORITY`（`Record`）として、バンドルの中に明示した。→ 承認する。

## 発見事項と、設計者の判断

1. `page.json` に、robots.txt と sitemap.xml の本文（metadata の Evidence の `text`）が入っている。設計書 6.1.11 の「page.json には、生のレスポンス本文は入っていない」は、事実と違う。→ **受け入れる。設計書の記述を直した。**
   - robots.txt と sitemap の本文は、設計書 5.6.2 で意図して集める Evidence である。1つの文書あたり、`MAX_SITE_METADATA_TEXT_LENGTH`（500,000文字）の上限がある。
   - 上位の計画が「含めない」とする生の本文は、ページの HTML などの、制御していない応答の本文である。ページの HTML の本文は、Evidence に記録しない。
   - sitemap が大きいと、ZIP も大きくなる。これは、上限の範囲の中の大きさとして受け入れる。
2. 共通部品台帳が未更新である。→ 設計者が更新した。
