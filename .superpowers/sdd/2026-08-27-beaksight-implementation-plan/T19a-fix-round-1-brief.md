# T19a 修正の回 1 の指示書: 全体の巡回のサイトに専用の robots.txt と sitemap.xml を置く

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T19a-fix-round-1
- 前のサブタスクの報告: 作業記録置き場の `T19a-report.md`（発見事項1・2）
- 設計書: `doc/design/2026-09-25-beaksight-task-19-fixture-full-crawl-readme-design.md` の 4.1、4.2
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（`startFixtureServer` の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。このサブタスクは、ほかの実装者と並行ではありません。

## 背景と設計者の判断

- fixture のサーバは、Origin 全体で1つの `/robots.txt` と `/sitemap.xml`（`fixtures/site/` の直下。`/crawl/` のページを載せたもの）しか返せない。
- そのため、全体の巡回で、`/full-crawl/` のすべてのページに `DISCOVERED_URL_NOT_IN_SITEMAP`（INFO）が出て、Run 全体にも `SITEMAP_URL_NOT_DISCOVERED` が4件出る。対照のページの確かめに、例外（`CONTROL_PAGE_ALLOWED_RULE_IDS`）を置く必要があった。
- 判断: サーバの起動の指定で、`/robots.txt` と `/sitemap.xml` を返すディレクトリを選べるようにする。全体の巡回のサイトには、専用の robots.txt と sitemap.xml を置く。対照のページの例外をなくす。

## 作業

1. **サーバの指定を加える**（`fixtures/server.ts`）
   - `FixtureServerOptions` に、サイトの metadata を返すディレクトリを選ぶ指定を加える（例: `siteMetadataDirectory?: string`。`fixtures/site/` からの相対のパス）。
   - 指定したときは、`/robots.txt` と `/sitemap.xml` の本文を、そのディレクトリのファイルから返す。Origin の置き換え（`{{FIXTURE_ORIGIN}}`）は、今と同じに行う。
   - 指定しないときは、今と同じ振る舞いにする。`siteMetadata: false` との組み合わせの扱い（false を優先して 404 にする、など）を決めて、先頭のコメントに書く。
   - パスの検証は、今のファイルの解決と同じ安全の確かめ（`fixtures/site/` の外に出ない）を通す。
   - `tests/integration/fixture-server.test.ts` に、この指定のテストを加える（指定したディレクトリのファイルが返る、Origin が置き換わる、指定しないときは今と同じ、`fixtures/site/` の外を指すと失敗する）。
2. **専用の robots.txt と sitemap.xml を置く**（`fixtures/site/full-crawl/`）
   - sitemap.xml には、実在する7ページを載せる。404 になる `missing.html` は載せない。
   - robots.txt は、既存の `fixtures/site/robots.txt` の形に合わせ、この sitemap を指す。
3. **結合テストを直す**（`tests/integration/fixture-full-crawl.test.ts`）
   - サーバを、専用の metadata のディレクトリを指定して起動する。
   - 対照のページの例外（`CONTROL_PAGE_ALLOWED_RULE_IDS`）をなくし、対照のページに Finding が1件もないことを確かめる。
   - sitemap に関する Finding を、期待どおりに確かめる。
     - `missing.html` に `DISCOVERED_URL_NOT_IN_SITEMAP` が出る（sitemap に載せていないため）。
     - ほかのページには出ない。
     - Run 全体の `SITEMAP_URL_NOT_DISCOVERED` は出ない。
   - サーバに届いたパスの確かめを、新しい metadata のパスに合わせる。
   - 空振りしないことを確かめる（例: sitemap から対照のページを一時的に外すと、対照のページの確かめが失敗する。確かめたら元に戻す）。

## 変えてよいファイル

- `fixtures/server.ts`
- `fixtures/site/full-crawl/robots.txt`、`fixtures/site/full-crawl/sitemap.xml`（新規）
- `tests/integration/fixture-full-crawl.test.ts`
- `tests/integration/fixture-server.test.ts`
- 上に無いファイルを変える必要が出たら、Blocker として止まる。

## 受け入れ条件

- 対照のページに、Finding が1件も出ないことを、例外なしで確かめている。
- sitemap に関する Finding が、上のとおりである。
- 指定しないときのサーバの振る舞いが、今と同じである（既存の fixture のサーバのテストと、sitemap を使う既存のテストが、そのまま PASS する）。
- 既存のテストのケースを消していない。確かめる内容を弱めていない。
- `npm run verify` が PASS する。

## 厳守事項

- **Chromium は headless だけで起動する。** CLI には必ず `--headless` を付ける。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。`config/targets/` と `local/` の実サイトの設定を使わない。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。
- Blocker に当たったら、回避策を自分で考えずに止まり、報告する。

## 報告

共通ルールの形式で、日本語で報告してください。`npm run verify` の結果（ファイル数、件数）を入れてください。
