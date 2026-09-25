# BeakSight Task 19 設計書: fixture の全体の監査と README

作成日: 2026-09-25
対象範囲: 上位の実装計画 `2026-08-27-beaksight-implementation-plan.md` の Task 19（Run full local verification and fixture full crawl）

## 1. 目的

- 本物の CLI（ビルドした `dist/cli/index.js`）で、わざと壊した fixture のサイトを最後まで監査し、次のことを確かめる。
  - Run Status が `COMPLETE` になる。
  - 壊した箇所ごとに、期待した Finding が出る。
  - 安全の不変条件の違反がない。
- その確かめ方を、繰り返し実行できる形で残す。
- 利用者向けの README を、今の実装に合わせて書き直す。

## 2. 根拠となる文書と優先順位

- 実装タスク指示 `2026-08-27-beaksight-implementation-tasks.md`（Safety Invariants、完了の意味）
- 上位の実装計画 `2026-08-27-beaksight-implementation-plan.md` の Task 19
- Task 14〜17 の設計書 `2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第7章（README での PowerShell の案内、`--help`、終了コード）
- Task 19 の前の整理の設計書 `2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2、4.2.1、4.3（headed の制約。README に書く）
- UI 追補設計書 `2026-09-23-beaksight-ui-ssot-design.md`（利用者向けの文は日本語）

この設計書は、上位の実装計画の Task 19 の手順を、次のとおり読み替える。

## 3. 上位の計画の手順の読み替え

| 上位の計画の手順 | 読み替え |
| --- | --- |
| Step 1: `npm run verify` | 設計者が実行する。各サブタスクの後にも実行する |
| Step 2: `npx playwright install chromium` | 行わない。この環境には、Chromium（`chromium-1234`）と headless shell がすでに入っている（2026-09-25 に確かめた）。ブラウザのダウンロードは、環境の変更になるので、しない |
| Step 3: fixture の全体の監査（一時的な設定と `node dist/cli/index.js run ... --headless`） | 結合テスト `tests/integration/fixture-full-crawl.test.ts` として残す（第4章）。一時的な設定を作り、一時ディレクトリにビルドした本物の CLI を、別のプロセスで動かす。設計者が実行し、結果を記録する |
| Step 4: README | 日本語で書き直す（第5章） |
| Step 5: commit | 行わない（コミットは禁止）。変更ファイルと検証の結果を記録する |

## 4. fixture の全体の監査

### 4.1 専用の fixture のサイト

- 置き場所: `fixtures/site/full-crawl/`（新規）。入口は `/full-crawl/index.html`。
- 理由: 設定には、巡回をパスで絞る仕組みがない。既存の fixture のページには、わざと危険な操作（外部スキーム、削除のリクエスト、ダウンロードなど）を試すページがあり、入口からそこへたどり着くと、Run が `COMPLETE` にならないか、安全の記録が意図と違うものになる。専用のサイトは、そのページにたどり着かないように作る。
- 中身:
  - 入口のページから、同じ Origin の数ページへリンクする。深さは2以上にする（巡回がリンクをたどることを確かめるため）。
  - 壊した箇所を、ページごとに置く。少なくとも次の種類を含める（どの Rule が何を検出するかは、`src/audit/rule-catalog.ts` と各 Rule のファイルで確かめる）。
    - 404 になるリンク
    - 読み込めない画像
    - JavaScript の例外
    - 横方向のはみ出し
    - コントラストの低い文字
    - アクセシビリティの問題（名前のないボタンなど、既存の Rule が検出するもの）
  - 壊した箇所を持たない対照のページを、1つ置く。
  - Interaction の候補（開閉の要素など、安全に確かめられるもの）を、少なくとも1つ置く。
  - 外部の Origin への読み込み、外部スキーム、フォーム、ダウンロード、変更系のリクエストを持たない。
- 既存の fixture のページを使ってよい。ただし、そのページから先のリンクで、入口から届くページの一覧が変わらないことを確かめる。
- robots.txt と sitemap.xml の扱いは、既存の fixture のサーバの振る舞いに従う。巡回で見つかるページの一覧が、期待どおりであることを確かめる。

### 4.2 結合テスト

- ファイル: `tests/integration/fixture-full-crawl.test.ts`（新規）
- 既存の部品を使う。
  - ビルド: `tests/helpers/temporary-build.ts` の `buildIntoTemporaryDirectory`
  - fixture のサーバ: `fixtures/server.ts` の `startFixtureServer`
  - CLI のプロセスの起動の形、artifact の読み取り、スキーマの確かめ: `tests/integration/cli.test.ts` と `tests/helpers/run-harness.ts` にあるもの。同じ処理が2つのテストのファイルに要る場合は、`tests/helpers/` に移して共有する（複製しない）。
- 設定:
  - 一時ディレクトリに、テスト用の設定を書く。`site.startUrl` は `/full-crawl/index.html`、`allowedOrigins` は fixture のサーバの Origin。
  - そのほかの値は、製品の既定値（`DEFAULT_CONFIG`）のままにする。実行の時間が長すぎる場合だけ、値を減らしてよい。その場合は、減らした値と理由を報告し、設計者の判断を受ける。
  - `maxPages` は、見つかるページの数より大きくする（上限で止まって `PARTIAL` にならないように）。
- 起動: `run --config <一時的な設定> --output <一時ディレクトリ> --headless`。**必ず `--headless` を付ける。**
- 確かめること:
  - 終了コードが 0、Run Status が `COMPLETE`。
  - 監査したページの一覧が、期待した一覧と完全に一致する。
  - 壊したページごとに、期待した Rule の Finding が出る（ruleId とページで確かめる）。
  - 対照のページに、Finding が出ない（もし出る Rule があれば、その理由を報告し、設計者の判断を受ける）。
  - Safety Ledger: Guard が有効、不変条件の違反が0件。
  - fixture のサーバに届いたリクエストが、GET と HEAD だけである（サーバの計数で確かめる）。
  - `run.json`、`audit.json`、`report.html`、各 `page.json`、ChatGPT 用のバンドルがあり、スキーマに合う。
  - プロセスが期限の中で終わり、スタックトレースを出さない。
- 実行の時間を記録する。Gate ではないので1秒の制約はないが、既存の CLI の結合テストと同じ程度の上限（プロセスごとに120秒）を目安にする。

### 4.3 見つかった不具合の扱い

- 全体の監査で、Task 1〜18 の部品の不具合が見つかった場合は、その場で直さない。実装者は発見事項として報告し、設計者が不具合台帳に登録して、別のサブタスクで直す（開発スキル 第5章）。
- `COMPLETE` にならない原因が、fixture の作り方（例: 確かめられない Interaction の候補）である場合は、fixture を直してよい。製品の判定を緩めてはいけない。

## 5. README

- 言語: 日本語（利用者向けの文。UI 追補設計書）。
- 事実の出どころ: 実装と設計書。書く前に、コードで確かめる（オプション、終了コード、出力の構成、ファイルの名前）。
- 載せること:
  1. BeakSight の概要（今の README の冒頭の説明を活かす）
  2. 必要なもの（Node.js の版、`npm install`、Playwright の Chromium。`npx playwright install chromium` で Chromium だけを入れる）
  3. 使い方: `validate-config`、`run`、オプション（`--config`、`--output`、`--headless`、`--headed`、`--help`）。同時に指定できない組と、重複の扱い
  4. 監査の対象の設定: `config/targets/` と `local/` の使い分け、`--config` を省いたときの扱い。実在のサイトの URL を例に書かない（`https://example.com/` のような例の値を使う）
  5. 終了コードの表（0 COMPLETE、1 FAILED、2 PARTIAL、3 ABORTED_BY_SAFETY、4 CONFIG_ERROR）。サイトの Finding の件数では決まらないこと
  6. 出力の構成: Run のディレクトリと、その中のファイル（`run.json`、`audit.json`、`report.html`、ページごとの JSON、スクリーンショット、ChatGPT 用のバンドル）。名前は `src/core/artifact-layout.ts` などで確かめる
  7. 結果の読み方: HTML レポート、Run Status の意味、Finding と Evidence の関係、ChatGPT 用のバンドルの使い方
  8. 読み取り専用の保証の範囲: Passive の段階は GET と HEAD だけ、Interaction は隔離した環境で行う、フォームの送信とダウンロードと外部のアプリの起動を行わない。保証できない範囲も書く
  9. **headed での実行の注意**: ページのスクリプトによる外部スキーム（`mailto:`、`tel:` など）への移動は止められない。headed では外部のアプリが起動しうる。その場合は違反として記録し、Run は `ABORTED_BY_SAFETY` になる。headless を勧める（設計書 4.2、4.2.1、4.3）
  10. Safety Ledger の読み方（Guard の有効、遮断した操作、外部スキームへの移動の試み、不変条件の違反）
  11. RUM/APM の値について: ブラウザで測った合成の値や計測の記録であり、サーバの内部の記録ではないこと
  12. Windows PowerShell での日本語の表示: パイプやリダイレクトの前に `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` を実行する。結果は UTF-8 の report.html と JSON で見ることも勧める
  13. 開発者向け: npm のスクリプト、ローカルでの検証の手順（`npm run verify`、fixture の全体の監査のテスト）
- 載せないこと: 実在の監査対象のサイトの名前、URL、設定の中身。

## 6. 完了条件

- [ ] fixture の全体の監査の結合テストが PASS する（`COMPLETE`、期待した Finding、違反0件、GET と HEAD だけ、スキーマに合う）。
- [ ] 設計者が `npm run verify` を実行し、PASS する。
- [ ] README が第5章の内容を満たし、実装と食い違わない（独立の確認を受ける）。
- [ ] 見つかった不具合が、不具合台帳に登録されている。

## 7. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | 初版 | - | Task 19 |
