# R15c 指示書: PREFLIGHT と環境の事実

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: R15c
- 目的: Run の前の確認（PREFLIGHT）と、環境の事実の収集と、`runId` の作り方を作る。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 5.5 と 5.6.7
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 15 Step 2
- 実装計画: `doc/design/2026-09-24-beaksight-task-15-implementation-plan.md` の R15c
- 前の報告: 作業記録置き場の `R15a-report.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
  - 使う部品: `BrowserContextFactory`、`closePassivePageAndContext`、`classifyUrl`、`validateArtifact`、`safeErrorMessage`、`createRunId`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（R15b）が `src/crawl/site-metadata.ts` を作っています。もう1人の実装者（DEF-004）が、`src/safety/passive-request-guard.ts` とそのテストを変えています。担当のファイル以外は変更しないでください。`npm run verify` は実行しないでください。

## 変更してよいファイル

- 新規: `src/orchestration/preflight.ts`、`src/orchestration/environment.ts`、`src/orchestration/run-id.ts`（`runId` の作り方を分ける場合）
- 新規のテスト: `tests/unit/run-id.test.ts`、`tests/integration/preflight.test.ts`、`tests/integration/environment.test.ts`

## 作るもの

1. **`runPreflight(options): Promise<PreflightResult>`**（設計書 5.6.7）
   - 入力:
     - 設定（`loadConfig` の検証済みのもの）
     - Chromium を起動する関数（注入する）
     - `SafetyLedger` を作る関数
     - 出力先
   - 確かめること（この順に行う）:
     1. 出力先に書けること。ディレクトリを作り、一時ファイルを書いて、消す。
     2. スキーマを読み込めること。`validateArtifact` を、小さな見本で呼ぶ。
     3. 開始の URL が、`classifyUrl` で `INTERNAL_NAVIGABLE` になること。
     4. Chromium を起動できること。
     5. Guard の付いた Passive Context を作れて、Guard が有効であること。
        - 作った Context と page は、すぐに閉じる。
        - 対象のサイトには、アクセスしない。
   - 結果:
     - 成功の場合は、起動した `Browser` と、`BrowserContextFactory` を返す。
     - 失敗の場合は、次の3つを返す。
       - 失敗した項目
       - 上限付きのメッセージ
       - `PREFLIGHT_FAILED` の理由
     - 失敗の場合に、起動した Chromium は閉じる。
   - 例外は、引数が不正な場合だけにする。
2. **`collectRunEnvironment(options): Promise<RunEnvironment>`**（設計書 5.5、5.6.7）
   - Node の版、OS、CPU のアーキテクチャは、`process` と `os` から取る。
   - Playwright の版は、Playwright の `package.json` から取る。
   - Chromium の版は、`browser.version()` から取る。
   - User-Agent は、ビューポートごとに、Guard の付いた Passive Context で `about:blank` を開き、`navigator.userAgent` を読む。
     - `about:blank` が Guard で遮断される場合は、止まって報告する。
     - 取れなかった場合は、null とする。
   - `toolVersion` は、BeakSight の `package.json` から取る。
     - `RunEnvironment` の外の項目なので、別の関数か、戻り値の別の項目にする。
   - 結果は、`RunEnvironment` の型と `run` のスキーマに合う。
3. **`createRunIdFromTime(date: Date): RunId`**
   - UTC の `YYYYMMDDHHmmss` から、`RUN-YYYYMMDDHHmmss` を作る。
   - 書式は、既存の `createRunId` と整合させる。
     - 既存の関数が連番の書式を持つ場合は、それを使えるか確かめる。
     - 使えない場合は、どうするかを報告する。
   - 同じ書式を、2か所に書かない。

## テスト

- `runId` の単体テスト: UTC で作ること、ゼロ埋め、スキーマの形に合うこと。
- PREFLIGHT の統合テスト:
  - 正常な場合に、Browser と factory が返る。
  - 各項目の失敗で、`PREFLIGHT_FAILED` になる。
    - 出力先に書けない場合
    - 開始の URL が外部の場合
    - Chromium の起動の失敗（注入した関数で起こす）
    - Guard の取り付けの失敗（`tests/helpers/browser-opening-page.ts` を使ってよい）
  - どの失敗の場合も、fixture のサーバにリクエストが届かない。
  - Chromium のプロセスと Context が残らない。
- 環境の事実の統合テスト:
  - 実際の Chromium で、各項目が得られる。
  - `run` のスキーマの `environment` に合う。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 共通部品台帳の部品を使う。同じ意味の処理を、新しく書かない。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` は実行しない（並行作業のため）。全体の verify は、設計者が行う。

## 報告

共通ルールの形式で、日本語で報告してください。R15d の実装者が使うので、作った関数のシグネチャを書いてください。
