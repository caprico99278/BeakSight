# T18c 実装報告（要約。設計者が保存）

## 結論

完了した。`tests/integration/auditor-gates.test.ts` を作った。

- GATE-A01〜A10 の16件が、すべて PASS した（3回実行して、52〜54秒）。
- 今のコードで FAIL した Gate は、ない。監査の誤りは、見つからなかった。
- `npm run typecheck` も PASS した。
- `src/`、`fixtures/`、`tests/helpers/` は、変えていない。

## Gate ごとの確認（要点）

| Gate | 確かめたこと | 対照 |
| --- | --- | --- |
| A01 | `/crawl/missing.html` に `HTTP_4XX`（ERROR） | 200 の4ページには出ない |
| A02 | 開始のページに `BROKEN_INTERNAL_LINK` が1件 | level-1 へのリンクは Finding にならない |
| A03 | CLI の Run で、`/js-error.html` に `PAGE_ERROR` | 別の Run のページには出ない |
| A04 | `/__broken-image.png` に `IMAGE_LOAD_FAILED` | data: の画像などには出ない |
| A05 | overflow で、Mobile だけに `DOCUMENT_HORIZONTAL_OVERFLOW` | 同じページの Desktop には出ない |
| A06 | bad-contrast に `COLOR_CONTRAST_VIOLATION` | ほかのページには出ない |
| A07 | accordion が `VERIFIED`。GET と HEAD しか届かない | mutation と postForm は `VERIFIED` にならない |
| A08 | mutation-button が `BLOCKED_BY_SAFETY`。`/__mutation` は0件。post-form は `REJECTED_UNSAFE` | Guard のない Context では POST が1件届く |
| A09 | `maxPages: 2` で `PARTIAL` と `MAX_PAGES_REACHED` | 上限なしでは `COMPLETE` |
| A10 | スキーマに合わない Run を `finishAuditRun` に渡すと、`PARTIAL`、`REQUIRED_ARTIFACT_INVALID`、終了コード 2 | 余分な項目がなければ `COMPLETE`、終了コード 0 |

完了の意味の確認: ERROR の Finding があっても、ほかに未完了の理由がなければ、Run Status は `COMPLETE` になる。crawl の Run と CLI の Run で確かめた。

## 実装者の判断と、設計者の判断

1. Run を8つに分けた（今の fixture に、共通のハブのページがないため）。→ 承認する。
   - 共通のハブのページを fixture に加えて、Run の数と時間を減らす改善は、Task 18 の後の整理で検討する。
2. A03〜A06 の対照は、同じ設定の別の Run のページである。→ 承認する。
3. 所要時間は約53秒で、T18b と合わせると、設計書 4.5 の「合わせて1分程度」を超える見込みである。→ 受け入れる。
   - 設計書 4.5 の目安を、「ファイルごとに1分程度」に直した。
4. A09 は、ページ数の上限だけを確かめる。→ 承認する。深さの上限は、既存の `crawl-run.test.ts` で確かめられている。
5. 確認の補助（`launcher`、`findingsOf`、`expectSchemaValid`、読み取りだけのリクエストの確認、`capture`）を、テストのファイルの中に置いた。`crawl-run.test.ts` と `run-command.test.ts` と、ほぼ同じである。
   - → 共通化候補 CC-029 として登録した。
   - T18b の `tests/helpers/gate-harness.ts` と合わせて、Task 18 の後の整理でまとめる。

## 発見事項と、設計者の判断

1. 監査の誤りは、見つからなかった。
2. Cross-page の Finding は、Run の `findings` にだけ入り、`page.findings` には入らない。→ 設計どおりである（設計書 6.1.3 と、Run Coordinator の実装）。
   - 実装者は、自分の確認を直した。
   - 直した後の確認は、Cross-page の Finding が `page.findings` に入らないことも確かめる。条件を弱めたものではない。
