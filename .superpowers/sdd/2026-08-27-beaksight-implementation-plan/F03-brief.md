# F03 指示書: テスト補助の共通化（CC-011）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F03
- 目的: テストファイルごとに複製されている準備処理と後片付けを、`tests/helpers/` の共通のテスト補助にまとめる。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 第3章（CC-011）
- 方針: `.claude/skills/beaksight-dev/references/shared-components-policy.md` 第4章「テストの見通しが悪くなる場合」。準備と後片付けの手順だけをまとめ、検証の内容は各テストに残す。
- 重複の実例: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/commonization-candidates.md` の CC-011

## 変更してよいファイル

- 新規: `tests/helpers/` 配下のファイル
- 変更: `tests/**/*.test.ts`（準備処理と後片付けの置き換えだけ）
- `src/**`、`fixtures/**` は変更しない。

## 作るもの

1. **テスト用の設定の生成**: `DEFAULT_CONFIG` を元に、テスト用の `AuditConfig` を作る関数。部分的な上書きを受け取れる形にする。現在 `configFor()` として7ファイル（`context-factory`、`controlled-scroll`、`layout-accessibility`、`performance-evidence`、`technical-evidence`、`screenshot-collector`、`isolated-interaction`）に複製されている。`isolated-interaction` は全項目を直書きしているので、結果の設定が同じになることを確かめてから置き換える。
2. **Chromium の起動と終了**: `chromium.launch({ headless: true })` を `beforeAll` / `afterAll` で行う処理（9ファイル）。
3. **factory の後片付け**: `closePassivePage` / `closePassiveContext(...).catch` を使う `afterEach`（5ファイル）。
4. **`Deferred<T>`**（4ファイル: `context-factory`、`network-collector`、`isolated-interaction`、`passive-request-guard`）。
5. 固定時間の待機 `new Promise(r => setTimeout(r, N))` は、`src/core/deadline.ts` の待機関数に置き換えてよい（テストの時間の意味を変えないこと）。

## 受け入れ条件

- 置き換えの前後で、テストの件数が同じである（`npx vitest run` の件数を前後で比べ、報告する）。
- すべてのテストが PASS する（`npx vitest run`）。
- `npm run typecheck` が PASS する（`tsconfig.json` が `tests/` を含む場合）。
- 各テストファイルの検証内容（`expect` の内容）を変えていない。

## RED について

このサブタスクは振る舞いを変えない置き換えなので、新しい RED は不要です。置き換えの前にリポジトリ全体のテストを実行して件数を記録し、置き換えの後に同じ件数で PASS することを確かめてください。

## 報告

共通ルールの形式で報告してください。作ったテスト補助の一覧と、置き換えたテストファイルの一覧を示してください。
