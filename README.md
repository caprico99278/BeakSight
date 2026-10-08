# BeakSight

BeakSight は、公開 Web サイトを読み取り専用で自動巡回し、機械的に判定できる異常を検出するツールです。
検出した異常と、その根拠の証跡（Evidence）を、構造化したデータとして書き出します。
書き出したデータは、後段の意味監査（例: ChatGPT への手動アップロード）に使えます。

固定の URL の一覧や、固定の DOM の selector に依存した E2E テストは、サイトを改修するたびに直す必要があります。
BeakSight は、開始の URL から、許可した Origin（`site.allowedOrigins`）の中でたどれるページを自動で見つけます。
人が公開サイトを巡回して確かめる作業のうち、機械的に判定できる範囲を、Playwright で自動化します。
BeakSight は、文章の自然さや配色の美しさのような、意味や美的な判断はしません。
パフォーマンス、アクセシビリティ、レイアウト、インタラクションなどの証跡を出力することに専念します。

設計の詳細は [doc/design/](doc/design/) を参照してください。

## 必要なもの

- Node.js 24（`package.json` の `engines` は `>=24 <25`）
- 依存パッケージ
- Playwright の Chromium（Chromium だけを使います。ほかのブラウザは入れなくてかまいません）

```bash
npm install
npx playwright install chromium
npm run build
```

CLI は、ビルドした `dist/cli/index.js` を Node.js で実行します。

headless でも、`npx playwright install chromium` で入る通常の Chromium を使います（`chrome-headless-shell` を使わない理由は「[headless で使うブラウザ](doc/spec/cli.md#headless-で使うブラウザ)」）。

## 使い方

```bash
node dist/cli/index.js <コマンド> [オプション]
```

### コマンド

| コマンド | 内容 |
| --- | --- |
| `validate-config` | 設定を読み、誤りがないかを確かめます。監査は実行しません。ブラウザも起動しません。 |
| `run` | 設定を読み、監査を実行して、結果を出力先に書き出します。 |

### オプション

| オプション | 内容 |
| --- | --- |
| `--config <パス>` | 対象の設定のファイル。省略した場合の扱いは「[監査の対象の設定](doc/spec/configuration.md#監査の対象の設定)」を参照してください。 |
| `--output <ディレクトリ>` | 出力先のディレクトリ。設定の `output.directory` を上書きします。 |
| `--headed` | ブラウザの画面を表示して実行します。設定の `browser.headed` を上書きします。使う前に「[headed で実行するときの注意](doc/spec/safety.md#headed-で実行するときの注意)」を読んでください。 |
| `--headless` | ブラウザの画面を表示せずに実行します。設定の `browser.headed` を上書きします。 |
| `--new` | 途中の Run があっても、続きから再開せずに、新しい Run を始めます（`run` のときだけ）。「[中断と再開](doc/spec/resume.md#中断と再開)」を参照してください。 |
| `--help` | 使い方を表示します。設定は読まず、監査も実行しません。終了コードは 0 です。 |

オプションの組み合わせの決まり（`--headed` と `--headless` は同時に指定できない、など）は「[オプション](doc/spec/cli.md#オプション)」を、終了コードは「[終了コード](doc/spec/cli.md#終了コード)」を見てください。

### 例

```bash
# 使い方を表示する
node dist/cli/index.js --help

# config/targets/ の中の、ただ1つの設定を確かめる
node dist/cli/index.js validate-config

# 設定のファイルを指定して確かめる
node dist/cli/index.js validate-config --config config/targets/example.json

# 監査を実行する（headless を勧めます）。途中の Run があれば、続きから再開します
node dist/cli/index.js run --config local/targets/<対象名>.json --headless --output artifacts

# 途中の Run があっても、続きから再開せずに、新しい Run を始める
node dist/cli/index.js run --config local/targets/<対象名>.json --headless --output artifacts --new
```

`validate-config` が成功すると、次のように表示します。

```text
設定に、誤りはありません。
対象: example
開始の URL: https://example.com/
```

## 注意

- **headless での実行を勧めます。** headed では、実行中にブラウザの画面（タブやウィンドウ）を閉じたり、停止・再読み込みしたりしないでください（「[headed で実行するときの注意](doc/spec/safety.md#headed-で実行するときの注意)」）。
- 監査（Run）が途中で止まっても、同じコマンドをもう一度実行すると、続きから監査します。続きから再開せずに新しい Run を始めるには、`--new` を付けます（「[中断と再開](doc/spec/resume.md#中断と再開)」）。
- Ctrl+C を1回押すと、今のページの監査を終えてから止まります。もう一度押すと、すぐに止まります（「[Ctrl+C で止める](doc/spec/resume.md#ctrlc-で止める)」）。
- 監査は読み取り専用です。ページを観測する段階では、ネットワークへのリクエストを `GET` と `HEAD` に限ります（「[読み取り専用の保証の範囲](doc/spec/safety.md#読み取り専用の保証の範囲)」）。
- 結果は、出力先（既定は `artifacts`）の下の Run のディレクトリ（`RUN-YYYYMMDDHHmmss`）に書き出します。日本語の HTML レポート（`report.html`）と、ChatGPT 用のバンドル（`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`）も、このディレクトリにあります（「[出力の構成](doc/spec/output.md#出力の構成)」）。

## 仕様

細かい仕様は `doc/spec/` にあります。索引は [doc/spec/README.md](doc/spec/README.md) です。

- [CLI](doc/spec/cli.md): オプションの細かい決まり、headless で使うブラウザ、終了コード、CLI の表示、Windows PowerShell での日本語の表示
- [監査の対象の設定](doc/spec/configuration.md): 設定のファイルの書き方、既定値、`config/targets/` と `local/` の使い分け
- [中断と再開](doc/spec/resume.md): 続きからの再開、`--new`、Ctrl+C で止める、実行時間の上限、再開のための保存、タスク スケジューラ
- [サイトが応答しないとき](doc/spec/site-unavailability.md): サイトの不調を検知したときの止まり方、確かめ直し、診断の記録
- [出力と結果の読み方](doc/spec/output.md): 出力の構成、HTML レポート、Run Status、Finding と Evidence、ChatGPT 用のバンドル
- [読み取り専用と安全](doc/spec/safety.md): 読み取り専用の保証の範囲、headed で実行するときの注意、Safety Ledger の読み方
- [サイトへの負荷](doc/spec/site-load.md): 読み込みの間隔と回数、キャッシュ、full audit での上限の選び方、実績の確かめ方
- [開発者向け](doc/spec/development.md): npm のスクリプト、ローカルでの検証の手順、アーカイブのスクリプト
