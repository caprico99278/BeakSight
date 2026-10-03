# T19a 実装報告（専用の fixture のサイトと、本物の CLI での全体の監査の結合テスト）

## 結論
完了。`fixtures/site/full-crawl/` の7ページ（と、存在しない404のページ1つ）と、本物の CLI を別のプロセスで動かす結合テスト（15件）を作った。既定の設定で Run は `COMPLETE`、終了コード 0。期待した Finding がすべて出た。実装者の `npm run verify`: 終了コード 0、101ファイル、3,647件 PASS、ビルド PASS。

## 変更したファイル
| パス | 変更の内容 |
| --- | --- |
| `fixtures/site/full-crawl/*.html`（新規7ページ） | 専用の fixture のサイト |
| `tests/integration/fixture-full-crawl.test.ts`（新規） | 全体の監査の結合テスト（15件） |
| `tests/helpers/cli-process.ts`（新規） | `cli.test.ts` から移した共通の部品（`runCliProcess`、`expectFinishedInTime`、`STACK_TRACE_LINE`、`onlyRunDirectory`、`CLI_PROCESS_LIMIT_MS`） |
| `tests/integration/cli.test.ts` | 共通の部品を使う形に。件数（8件）と名前は `vitest list` で前後同じ |

## fixture のページ
| ページ（深さ） | 壊した箇所 | 期待した ruleId |
| --- | --- | --- |
| `index.html`（0） | なし（入口） | — |
| `links.html`（1） | 404 のページへのリンク | `BROKEN_INTERNAL_LINK` |
| `technical.html`（1） | 読み込めない画像、捕まえられない例外 | `IMAGE_LOAD_FAILED`、`PAGE_ERROR` |
| `layout.html`（1） | 幅 1200px の要素 | `DOCUMENT_HORIZONTAL_OVERFLOW` |
| `control.html`（1） | なし（対照）。`aria-expanded` の開閉ボタン | 出ない（Interaction は `VERIFIED`） |
| `missing.html`（2） | ファイルがなく 404 | `HTTP_4XX` |
| `contrast.html`（2） | 低いコントラスト | `COLOR_CONTRAST_VIOLATION` |
| `accessibility.html`（2） | 名前のないボタン | `A11Y_BUTTON_NAME` |

- 外部の Origin、外部スキーム、フォーム、ダウンロード、変更系のリクエスト、既存の fixture のページへのリンクは置いていない。
- 設定は `target.id` と `site` だけ。ほかは製品の既定値（`maxPages` 500）。`--headless` を付ける。

## 監査の結果
- 監査したページ: 8ページすべて `AUDITED`。
- Finding（要点）: 期待した ruleId のほか、`technical.html` に `RESOURCE_4XX`、`layout.html` の幅の走査（320、768、1024）の `DOCUMENT_HORIZONTAL_OVERFLOW`、`missing.html`（text/plain の 404）に `MISSING_TITLE`・`MISSING_HTML_LANG`・axe の文書構造の Rule など7種類。全8ページに `DISCOVERED_URL_NOT_IN_SITEMAP`（INFO）、Run 全体に `SITEMAP_URL_NOT_DISCOVERED`（INFO）4件（`/crawl/` の URL）。
- Interaction: control.html は `VERIFIED`。accessibility.html の名前のないボタンは `NOT_VERIFIABLE`（`OBSERVED_NO_CHANGE`。`COMPLETE` を妨げない）。
- Safety: Guard 有効、不変条件の違反 0件、遮断した操作 0件。サーバに届いたのは GET だけ（`/robots.txt`、`/sitemap.xml`、`/full-crawl/` の下）。

## テスト（実装者）
- RED: fixture がない状態で15件中8件が失敗。対照のページの確かめが空振りしていたので、`AUDITED` の確かめを加えた。
- GREEN: 15件 PASS。`cli.test.ts` 8件 PASS。typecheck PASS。
- 空振りしないことの確かめ: fixture を一時的に直して、組A（8件）と組B（4件）が期待どおり失敗することを確かめ、元に戻して SHA-256 の一致を確かめた。「GET と HEAD だけ」「COMPLETE」「スキーマに合う」は、fixture の変更では失敗させられない（GET と HEAD の計数の検出力は、既存の `GATE-A08 (control)` で確かめられている）。
- 実行の時間: テストのファイル 34.5秒、CLI のプロセス 32.3秒（上限 120秒）。

## 発見事項
1. 対照のページに `DISCOVERED_URL_NOT_IN_SITEMAP` が出る（fixture のサーバの sitemap が `/crawl/` のものだけのため）。テストでは例外として許した（`CONTROL_PAGE_ALLOWED_RULE_IDS`）。
2. 同じ原因で、`SITEMAP_URL_NOT_DISCOVERED` が4件出る。
3. 幅の走査の `DOCUMENT_HORIZONTAL_OVERFLOW` は、`viewport` が `desktop` として記録される（`layout-rules.ts:108` の `layoutsOf` の作り。設計どおり）。
4. text/plain の 404 のページに、文書の構造の Finding が7種類出る。利用者には雑音になるおそれがある。
- Task 1〜18 の部品で、テストが通らなくなる不具合はなかった。
- 補足: verify の中のビルドが、リポジトリの `dist/` を書き換えた。

## 設計者の判断（2026-09-26）
1・2. 選択肢 (b) を採る。fixture のサーバで、robots.txt と sitemap.xml を返すディレクトリを選べるようにし、全体の巡回のサイトに専用のものを置く。対照のページの例外をなくす（T19a-fix-round-1）。
3. 設計どおり。README（T19b）で、幅の走査の結果が Desktop の Evidence に含まれることを説明する。
4. DEF-016 として登録した。直し方は、Task 20 の smoke で実際の 404 のページの出方を見てから決める。
