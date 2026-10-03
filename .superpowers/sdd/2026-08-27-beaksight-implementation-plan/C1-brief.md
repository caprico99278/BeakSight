# C1 指示書: Task 1〜4 の修正（設定・クロール・fixture・テスト）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C1
- 目的: Task 1〜4 のレビュー指摘 R1、R2、R5、R7、R8、R9 を修正する。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 6.1、6.2、6.4、6.6、6.7、6.8
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C1
- レビュー記録（指摘の詳細と再現条件）: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/` の `task-01-05-review-2026-09-23.md`
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（F01 で新設した deadline・errors・guards・immutable・text・limits）

同時に、ほかの実装者が別の範囲の修正（C2: 安全まわり、C4: スクロールと収集位置、C7: performance・network・console・axe）を行っています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/config/load-config.ts`、`src/config/validate-config.ts`、`src/config/types.ts`、`src/config/defaults.ts`
- `src/crawl/discover-links.ts`、`src/crawl/normalize-url.ts`
- `fixtures/server.ts`（と、必要なら `fixtures/site/` への新しいページの追加）
- テスト: `tests/unit/config.test.ts`、`tests/unit/cli.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/normalize-url.test.ts`、`tests/component/discover-links.test.ts`、`tests/integration/fixture-server.test.ts`、および新規のテストファイル

`discoverLinks()` や `AuditConfig` の利用者が `src/**` のほかのファイルにあり、型の変更で修正が必要になった場合は、そのファイルを変更せずに止まって報告してください。

## 修正する内容

- **R1**（設計書 6.1）: `AuditConfig` に `target: { id: string }` を加え、`loadConfig()` の結果に含める。確定後の設定は不変であること。
- **R2**（6.2）: `--config` が `config/targets/` の外なら、そのファイルだけを読む。`target.id` の一意性の確認は `config/targets/` 配下だけ。再現条件: ほかの JSON（例: `schemas/audit.schema.json`）があるディレクトリのファイルを指定しても失敗しないこと。
- **R5**（6.4）: `allowedOrigins` と `startUrl` に認証情報が含まれる場合、`maxPages`・`maxDepth` などが正の整数でない場合を、設定エラーにする。URLの判定には `normalize-url.ts` の関数を使う。
- **R7**（6.6）: `discoverLinks()` の `policy` を必須にする。認証情報を含むURLは正規化で受け入れない（理由 `CREDENTIALS_NOT_ALLOWED`）。Evidence の生の href の認証情報は伏せ字にする（その関数は `normalize-url.ts` に置く）。
- **R8**（6.7）: fixture サーバの変更系カウンタが、GET・HEAD 以外のすべてのメソッド（OPTIONS と独自メソッドを含む）を数える。fixture サーバのテストで確かめる（ブラウザからそれらが届かないことの証明は、Task 18 の Safety Gate で行う）。
- **R9**（6.8）: `tests/unit/cli.test.ts` と `tests/unit/schema-validator.test.ts` が `tsc` を実行する場合、出力先を一時ディレクトリにし、`dist/` を読み書きしない。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。
- テストの実行後に、一時的な出力が `dist/` にもリポジトリ内にも残っていない。

## 報告

共通ルールの形式で報告してください。各項目（例: R1、V2）ごとに、RED・GREEN の結果を示してください。

## 追加の指示（F02c の報告を受けて）

- `tests/unit/normalize-url.test.ts:120-127` 付近の「passive request policy と同じ結果を返す」テストは、F02c で `canonicalPassiveAllowedOrigins` が委譲になったため、同じ関数どうしを比べる、必ず PASS するテストになっている。これを、代表的な入力に対して固定の期待値（正規化後の Origin の集合）と比べるテストに書き直す。

## 追加の指示（F03 の完了を受けて）

- 新しく書くテストでは、`tests/helpers/` のテスト補助（`createTestConfig`、`useHeadlessChromium`、`closePassiveResources`、`createDeferred`）を使う。
