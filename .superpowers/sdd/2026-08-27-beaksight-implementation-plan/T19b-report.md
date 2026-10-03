# T19b 実装報告（README の書き直し）

## 結論
完了（ただし、`npm run verify` の PASS は、この環境では確かめられない）。
`README.md` を、設計書 第5章の13項目に沿って日本語で書き直しました。書いた事実は、すべてコードか指定の設計書で確かめました。
ブラウザを起動しない CLI のコマンド（`--help`、`validate-config` と、設定のエラーの各場合）は、実行して結果が README と一致することを確かめました。

## 変更したファイル
| パス | 変更の内容 |
| --- | --- |
| `README.md` | 全体を書き直した（下の章立て）。古い記述（「`run` コマンド: 未実装」、`npx playwright install`（全ブラウザ）、`validate-config --headed --output` の例）を削除した |

- ほかのファイルは変えていません。`npm run build` を実行したので、Git の管理の対象外の `dist/` は再生成されました。
- 確かめのための一時的な設定（例の値 `https://example.com/` だけ）は、スクラッチパッド（リポジトリの外）に置きました。リンクは作っていません。

## README の章立て
| 章 | 設計書 第5章の項目 |
| --- | --- |
| 冒頭（概要） | 1 |
| 必要なもの | 2 |
| 使い方（コマンド、オプション、同時に指定できない組と重複、例） | 3 |
| 監査の対象の設定（最小の例、既定値の表、`config/targets/` と `local/`、`--config` を省いたとき） | 4 |
| 終了コード | 5 |
| 出力の構成 | 6 |
| 結果の読み方（CLI の表示、HTML レポート、Run Status、Finding と Evidence、幅の走査の結果、ChatGPT 用のバンドル） | 7（と T19a の発見事項3） |
| 読み取り専用の保証の範囲（保証できない範囲を含む） | 8 |
| headed で実行するときの注意 | 9 |
| Safety Ledger の読み方 | 10 |
| パフォーマンスの値（RUM/APM）について | 11 |
| Windows PowerShell での日本語の表示 | 12 |
| 開発者向け（npm のスクリプト、ローカルでの検証の手順、アーカイブのスクリプト） | 13 |

載せないこと: 実在の監査対象のサイトの名前、URL、設定の中身は書いていません。例の値は `https://example.com/` と `local/targets/<対象名>.json` だけです。`config/targets/example.json` は、中身が例の値だけ（`example`、`https://example.com/`）であることを確かめてから、同じ形を書きました。

## 事実の出どころ
| README の記述 | 出どころ |
| --- | --- |
| 概要 | 旧 README の冒頭、`doc/design/2026-08-27-beaksight-web-audit-design.md` 第1章 |
| Node.js の版、npm のスクリプト、`bin` | `package.json`（`engines`、`scripts`、`bin`） |
| Chromium だけを使う | `src/cli/run-command.ts:241-245`（`chromium.launch`） |
| コマンドとオプションの一覧、説明 | `src/cli/arguments.ts:17,24-30`、`src/presentation/messages.ts` の `CLI_COMMAND_DESCRIPTIONS`、`CLI_OPTION_DESCRIPTIONS`、`--help` の実際の出力 |
| `--help` は解析できればコマンドによらず表示、終了コード 0 | `src/cli/arguments.ts:80-90`、`src/cli/main.ts:41-45` |
| 値を取るオプションの重複は設定のエラー | `src/cli/arguments.ts:58-77,91-98` |
| `--headed` と `--headless` の同時の指定は設定のエラー | `src/cli/arguments.ts:113-117` |
| 知らないオプション、余分な引数、知らないコマンド、使い方の添付 | `src/cli/arguments.ts:82-112`、`src/cli/output.ts:52-57,105-111` |
| `--headed`/`--headless` が `browser.headed` を上書き、`--output` が `output.directory` を上書き | `src/cli/arguments.ts:119-123` |
| 設定の必須の項目と検証（認証情報、許可 Origin、知らない項目） | `src/config/validate-config.ts:93-121,169,183-184`、`src/config/load-config.ts:123-126` |
| 期限の組み合わせの条件（2 × interactionTimeoutMs） | `src/config/validate-config.ts:143-144`、`src/core/limits.ts:149` |
| 既定値の表 | `src/config/defaults.ts:3-37` |
| `allowedQueryParameters` の意味 | `src/crawl/normalize-url.ts:70-72` |
| 幅の走査はデスクトップとモバイルの幅を除く | `src/orchestration/page-auditor.ts:1115-1118` |
| `--config` を省いたときの扱い、カレントディレクトリ、再帰、ちょうど1つ、`target.id` の重複、外のファイル | `src/config/load-config.ts:130-161,163-174,185-192` |
| BOM を1つ取り除く | `src/config/load-config.ts:98-106` |
| `local/` は Git の管理の対象外、`artifacts/` も対象外 | `.gitignore` |
| 終了コードの表、Finding の件数で決めない、`validate-config`・`--help` は 0、書き出しの失敗と想定外のエラーは 1 | `src/cli/exit-codes.ts:1-51`、`src/cli/main.ts:40-68`、`--help` の実際の出力 |
| Run のディレクトリの名前 `RUN-YYYYMMDDHHmmss`（UTC） | `src/orchestration/run-id.ts:11-37`、`src/core/artifact-layout.ts:51-53` |
| ファイルの名前と配置（`run.json` ほか、`pages/<pageId>/`、ビューポート、`retry-<n>`） | `src/core/artifact-layout.ts:7-11,24-48,55-76`、`src/core/ids.ts:55-68`（`PAGE-` と6桁） |
| スクリーンショットはビューポートごと | `src/orchestration/page-auditor.ts:637-638` |
| 書き出したファイルの一覧（fixture の全体の監査） | `tests/integration/fixture-full-crawl.test.ts:277-301`（`RUN_ARTIFACT_FILE_NAMES` のすべて、各 `page.json`、バンドルの中身） |
| UTF-8（BOM なし）と LF、スキーマの検証と `COMPLETE` にしないこと | `src/report/artifact-writer.ts:1-12` |
| `visible-text.txt` の作り方 | `src/report/artifact-writer.ts:65-80` |
| 同じ名前の Run のディレクトリがある場合、終了コード 1 | `src/core/artifact-layout.ts:88-112`、`src/cli/run-command.ts:301-315`、`src/presentation/messages.ts` の `CLI_TEXT.failure.runDirectoryExists` |
| CLI の結果の表示の項目 | `src/cli/output.ts:154-194` |
| HTML レポートの節と順、カテゴリの節 | `src/presentation/catalog.ts:354-432`、`src/report/html-report.ts:307`（実行の環境） |
| 危険な URL と Safety の事象の URL をリンクにしない | `src/report/html-components.ts:271-281`、設計書 Task 14〜17 の 6.1.6、6.1.11 |
| Run Status の意味と導き方 | `src/presentation/catalog.ts:113-138`、`src/core/status.ts:56-95` |
| 違反の後は監査を始めず、残りを `SAFETY_VIOLATION_ABORT` のスキップにする | `src/orchestration/run-coordinator.ts:328,515-517`、`src/orchestration/page-auditor.ts:150-172`、設計書（Task 19 の前の整理）4.5 |
| Finding と Evidence、`evidenceRefs`、件数の区分 | `src/presentation/catalog.ts:45-107,219-243`、設計書 Task 14〜17 の 6.1.3、6.1.9 |
| 幅の走査の結果の記録（下の「幅の走査の確かめ」） | `src/orchestration/page-auditor.ts:571-606`、`src/audit/layout-rules.ts:107-121,190-202`、`src/audit/rule-engine.ts:173`、`src/report/html-components.ts:404-418`、`src/presentation/format.ts:31` |
| ChatGPT 用のバンドルの中身、64 MiB、生の本文を入れない | `src/report/chatgpt-bundle.ts:51-57,93,304`、`src/core/limits.ts:204`、設計書 Task 14〜17 の 6.1.9、6.1.11 |
| Passive は `GET` と `HEAD` だけ、WebSocket の遮断、許可 Origin の外へのメインフレームの移動の遮断、それ以外の `GET` は許可 | `src/safety/request-policy.ts:28-31,47-72` |
| 巡回は `a[href]` のリンク | `src/crawl/discover-links.ts:130` |
| ダウンロードを受け付けない | `src/browser/context-factory.ts:97` |
| Interaction の隔離と凍結、操作しない要素 | 上位の設計書 6.2、7.2、`src/presentation/messages.ts:92-110`（`INTERACTION_REASON_DESCRIPTIONS`） |
| GET の副作用は保証の範囲外 | 上位の設計書 2.3 の注意 |
| headed の注意（止められない経路、headless は違反にしない、headed の違反と Context を閉じる、リダイレクトは止める） | `src/safety/passive-request-guard.ts:1856-1900`（`EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE`、`initiateInvalidation`）、`:1183,1301`（`EXTERNAL_SCHEME_REDIRECT_BLOCKED`）、`src/core/evidence-types.ts:1658`、設計書（Task 19 の前の整理）4.1、4.2、4.2.1、4.3 |
| 違反が1件でもあれば `ABORTED_BY_SAFETY` | `src/core/status.ts:56-62` |
| Safety Ledger の項目 | `src/core/contracts.ts:359-394`（`RunSafetySummary`）、`src/report/html-report.ts:417-459`、`src/presentation/messages.ts` の `HTML_REPORT_TEXT.safety`、上位の設計書 第35章 |
| Safety の記録の種類と表示の名前 | `src/core/evidence-types.ts:1813-1825`（`SAFETY_EVENT_KINDS`）、`src/presentation/catalog.ts:270-339`（`SAFETY_EVENT_KIND_CATALOG`） |
| 外部スキームの理由のコードの意味 | `src/presentation/catalog.ts:331-338`、`src/audit/safety-rules.ts:131-150` |
| RUM/APM の扱い、`traceparent` など、未観測 | 上位の設計書 14.11、14.12、`src/evidence/performance-collector.ts:62-66`、`src/presentation/messages.ts:15`（`NOT_OBSERVED_TEXT`） |
| パフォーマンスの Finding は警告 | `src/audit/performance-rules.ts:41,55,68-72` |
| Windows PowerShell の日本語の表示 | 設計書 Task 14〜17 の第7章 853〜861 行（Windows で確かめた結果） |
| fixture の全体の監査のテストの中身 | `tests/integration/fixture-full-crawl.test.ts:1-13,127-150,180-308` |
| アーカイブのスクリプト | `tools/archive_beaksight.ps1:5-13,116-120` |

### 幅の走査の確かめ（実際の出力では未確認）
次のものを読み、README の説明と合うことを確かめました。実際の `report.html` では確かめていません（未確認）。
- `src/orchestration/page-auditor.ts:571-606`: 幅の走査は Desktop だけで行い、結果を Desktop の layout の Evidence の `stressSweep` に入れる（Mobile は `null`）。
- `src/orchestration/page-auditor.ts:1115-1118`: 調べる幅は `stressWidths` から主要な2つの幅を除いたもの。既定では 320、768、1024。T19a の報告の「幅の走査（320、768、1024）」と一致する。
- `src/audit/layout-rules.ts:107-121,190-202`: `stressSweep` の結果も判定し、文言の先頭に「レスポンシブの幅 <幅> の確認で、」を付ける。Evidence の参照は、同じ Desktop の layout の Evidence。
- `src/audit/rule-engine.ts:173`: Finding の `viewport` は、入力のビューポート（Desktop）。
- `src/report/html-components.ts:404-418`: 指摘の表のビューポートの欄は、`VIEWPORT_PROFILE_CATALOG` のラベル（「デスクトップ」）。
- `src/presentation/format.ts:31`: 幅の書式は `320 px`。
- T19a の報告の発見事項3と、設計者の判断（「設計どおり。README で説明する」）。

## コマンドの確かめの結果
ブラウザを起動しないコマンドだけを実行しました（リポジトリの直下で、`npm run build` の後）。

| コマンド | 結果 |
| --- | --- |
| `npm run typecheck` | 終了コード 0 |
| `npm run build` | 終了コード 0 |
| `node dist/cli/index.js --help` | 終了コード 0。使い方、コマンド2つ、オプション5つ、終了コードの表（0〜4）が、README の表と一致 |
| `node dist/cli/index.js run --help` | 終了コード 0。使い方だけを表示（ブラウザは起動しない） |
| `node dist/cli/index.js validate-config` | 終了コード 0。「設定に、誤りはありません。」「対象: example」「開始の URL: https://example.com/」（README の表示の例と一致） |
| `node dist/cli/index.js validate-config --config config/targets/example.json` | 終了コード 0。同じ表示 |
| `... --output out1 --output out2` | 終了コード 4。「引数に、誤りがあります。」、詳細 `--output was given more than once`、使い方を表示 |
| `... --headed --headless` | 終了コード 4。「--headed と --headless は、同時に指定できません。」、使い方を表示 |
| `node dist/cli/index.js`（コマンドなし） | 終了コード 4。「コマンドを指定してください。」 |
| `node dist/cli/index.js unknown` | 終了コード 4。「知らないコマンドです。」 |
| `validate-config --nope` | 終了コード 4。「引数に、誤りがあります。」 |
| `validate-config --config does-not-exist.json` | 終了コード 4。「設定のファイルが見つかりません。」 |
| `validate-config --headed --headed` | 終了コード 0（値を取らないオプションの重複は誤りにしない。README は値を取るオプションだけを誤りと書いている） |
| スクラッチパッドの設定（`config/targets/` の外。例の値）を `--config` で指定 | 終了コード 0（そのファイルだけを読む） |
| 許可 Origin に開始の URL の Origin がない設定 | 終了コード 4。`site.startUrl origin must be included in site.allowedOrigins` |
| 知らない項目（`extra`）を持つ設定 | 終了コード 4。`unknown configuration key: extra` |
| 先頭に BOM を付けた設定 | 終了コード 0 |
| `crawl.overallPageTimeoutMs: 30000` の設定 | 終了コード 4。`... must be at least crawl.navigationTimeoutMs + 2 x crawl.interactionTimeoutMs (36000 ms) ...` |
| `npx vitest run tests/architecture` | 3ファイル、50件 PASS、終了コード 0 |
| `npx vitest run tests/unit` | 52ファイル中51ファイル PASS。1917件 PASS、2件 skip、終了コード 1。失敗の1ファイルは `tests/unit/schema-validator.test.ts` の `C8: real collector output from local fixtures` で、Chromium の実行ファイルがないことによる（`browserType.launch: Executable doesn't exist`）。README の変更とは関係しない |

## TDDの記録
- README だけの変更で、テストの対象になる振る舞いの変更はないため、RED と GREEN はありません。
- 関連する検証: 上の「コマンドの確かめの結果」のとおり。

## 受け入れ条件の確認
- [x] 設計書 第5章の13項目を、すべて含む。載せないことを守っている — 上の章立ての表で対応を確かめた。README に実在の監査対象の名前、URL、設定の中身がないことを、目で確かめた（URL は `https://example.com/` だけ）。
- [x] 書いた事実の出どころ（ファイル:行）を、一覧で示している — 上の「事実の出どころ」。
- [x] コマンドの例を実行して確かめた結果を示している — 上の「コマンドの確かめの結果」。`run` は、指示どおり実行せず、fixture の全体の監査のテスト（T19a の報告）と、コードで代えた。
- [ ] `npm run verify` が PASS する — この環境では確かめられない（未実行項目）。代わりに `npm run typecheck`、`npm run build`、`tests/architecture`、`tests/unit` を実行した。

## 発見事項
1. `tests/unit/schema-validator.test.ts` の `C8: real collector output from local fixtures` は、単体のテストの置き場所にありながら、Chromium を（headless で）起動します。追補の「ブラウザを使わないテスト（たとえば `npx vitest run tests/unit`）」の前提と違います。この環境では Chromium がないため起動に失敗し、ブラウザは動いていません。振る舞いの違いはありません。
2. `--help` の使い方の1行目は `beaksight <コマンド> [オプション]` です（`src/cli/output.ts:41`、`package.json` の `bin`）。ただし、`npm install` だけでは `beaksight` のコマンドは使えるようになりません。README は `node dist/cli/index.js` で書きました。食い違いではありませんが、利用者が戸惑うおそれがあります。
3. `--headless` の説明（`src/presentation/messages.ts` の `CLI_OPTION_DESCRIPTIONS.headless`）は、`browser.headed` を上書きすることを書いていません。コード（`src/cli/arguments.ts:120`）は上書きします。README はコードに合わせて「上書きします」と書きました。
4. コードと README の食い違いで、README を実装に合わせられないものは、ありませんでした。

## 未実行項目
- `npm run verify`: この環境には Playwright 1.62.1 用の Chromium がなく、ブラウザを使うテストが失敗するため、実行していません。受け入れ条件の1つですが、README の変更はテストに影響しません。設計者の環境での実行が必要です。
- `run` コマンド、`tests/integration/fixture-full-crawl.test.ts`: ブラウザを起動するため、実行していません。README の出力の構成と幅の走査の説明は、コードと T19a の報告で確かめました。実際の `report.html` での見え方は未確認です。
- Windows PowerShell での日本語の表示: この環境では確かめられません。設計書 Task 14〜17 の第7章（853〜861 行。Windows で確かめた結果）を出どころにしました。
- `npx playwright install chromium`: README に書いたコマンドですが、ブラウザを入れる操作なので実行していません。
