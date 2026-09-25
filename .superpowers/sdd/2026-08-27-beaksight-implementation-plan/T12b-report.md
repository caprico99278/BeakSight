# T12b 実装報告（要約。設計者が保存）

## 結論

一部完了。担当の22個の Rule のうち20個を実装し、`TECHNICAL_RULES` に登録した。担当のテスト46件は PASS した。`NAVIGATION_TIMEOUT` と `UNEXPECTED_ORIGIN_REDIRECT` は Blocker のため、実装していない。

`npm run typecheck` は失敗した。エラーは、並行して作業中の T12c のテストファイルから出たもので、担当のファイルにはない。

## 実装した Rule（すべて version 1）

- HTTP: `HTTP_4XX`、`HTTP_5XX`、`REDIRECT_LOOP`、`EMPTY_HTTP_RESPONSE`
- LINK: `INVALID_INTERNAL_URL`（WARN）、`UNSUPPORTED_URL_SCHEME`（INFO）
- RESOURCE: `RESOURCE_4XX`、`RESOURCE_5XX`、`SCRIPT_LOAD_FAILED`、`STYLESHEET_LOAD_FAILED`、`IMAGE_LOAD_FAILED`
- JAVASCRIPT: `PAGE_ERROR`（name・message・stack が同じものを、1件にまとめる）
- DOM: `MISSING_TITLE`、`EMPTY_TITLE`、`MISSING_HTML_LANG`、`EMPTY_VISIBLE_CONTENT`、`DUPLICATE_ELEMENT_ID`、`INVALID_CANONICAL_URL`
- FORM: `FORM_WITHOUT_ACTION`（INFO）、`UNLABELED_REQUIRED_CONTROL`（WARN）

## Blocker と、設計者の判断

- `NAVIGATION_TIMEOUT`: ナビゲーションの期限切れを表す事実が、`PageRuleInput` にない。
- `UNEXPECTED_ORIGIN_REDIRECT`: 許可Originの一覧が、`PageRuleInput` にない。また、許可Originの外へのリダイレクトは、Passive Guard が遮断する。
- **判断**: 2つとも、Cross-page rule（第7章）に移す。
  - どちらも、ページの Evidence ではなく、ページの監査の結果（ナビゲーションの結果）と、設定の許可Originから判断するものである。これは、`TARGET_NAVIGATION_FAILED` を移したときと同じ理由である。
  - Rule の設計書 5.1 と第7章を更新した。
  - T13 の後に、T13b で実装する。
  - Task 14 の Page Auditor は、ページごとのナビゲーションの結果を、Cross-page rule の入力として記録する。

## 実装者の判断と、設計者の判断

1. `INVALID_INTERNAL_URL` では、Origin がページと違うと分かったリンクを外部とみなし、Origin が分からないリンクを内部とみなす。→ 承認する。誤る場合は見逃す側に倒れる。許可Originが入力にないので、この方法でよい。
2. `INVALID_CANONICAL_URL` では、残す query の一覧を空にして正規化する。切り詰めた canonical は、判定しない。→ 承認する。
3. `PAGE_ERROR` は、name・message・stack が同じものを1件にまとめ、この3つを同一性の要素にする。→ 承認する。
4. HTTP と RESOURCE の Rule は、URL ごとに1件にまとめる。form は、文書の中の順番で区別する。→ 承認する。form の id や selector の Evidence がないためである。

## 発見事項と、設計者の判断

- `FORM_WITHOUT_ACTION`: action 属性がない場合と、空の場合を区別できない。文言は「action 属性がないか空」とした。→ 受け入れる。
- `IMAGE_LOAD_FAILED`: 大きさの指定がない SVG 画像では、`naturalWidth` が 0 になるおそれがある（未確認）。→ Task 14 の統合テストで、Chromium の実際の振る舞いを fixture で確かめる。誤って Finding になる場合は、既存不具合として登録し、直す。
- Guard が遮断したリクエストは、script や stylesheet では起きない。→ 受け入れる。
