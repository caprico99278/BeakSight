# BeakSight

BeakSight は、Web サイトを自動で巡回し、機械的に判定できる異常を検出するツールです。
検出した異常と、その根拠の証跡（Evidence）を、構造化したデータとして書き出します。
書き出したデータは、後段の意味監査（例: ChatGPT への手動アップロード）に使えます。

BeakSight は、開始の URL から、許可した Origin（`site.allowedOrigins`）の中でたどれるページを自動で見つけます。
人がサイトを巡回して確かめる作業のうち、機械的に判定できる範囲を、Playwright で自動化します。
BeakSight は、文章の自然さや配色の美しさのような、意味や美的な判断はしません。

## 3 つのモード

| モード | 内容 | 使う場所 |
| --- | --- | --- |
| 公開サイトの読み取りだけの監査（`PUBLIC_PASSIVE`） | ログインせずに、`GET` と `HEAD` だけでページを観測します。 | CLI と管理画面 |
| テスト環境の認証つきの監査（`TEST_AUTH_PASSIVE`） | テスト環境にログインした後の画面を、読み取りだけで監査します。ログインは、人が開いたブラウザで行うか、Windows では BeakSight が保存した資格情報で行います。 | 管理画面だけ |
| 承認された書き込み（`TEST_APPROVED_WRITE`） | テスト環境の管理画面の操作の候補を見つけ、人が承認したシナリオに従って、登録（CREATE）か更新（UPDATE）を 1 回の Run で 1 件だけ送り、結果を照合します。 | 管理画面だけ |

- 認証つきの監査と書き込みは、テスト環境だけに使います。本番には使いません。書き込みは、本番から隔離されていることを確かめてから行います。隔離が未確認のテスト環境で読み取りだけを行う扱いは「[実テスト環境の手順](doc/spec/real-test-environment.md)」にあります。
- 認証つきの監査と書き込みは、テスト用の小さなサイトで確かめています。実際のテスト環境では、まだ確かめていません（「[実テスト環境の手順](doc/spec/real-test-environment.md)」）。
- 導入から最初の監査までは「[導入](doc/spec/getting-started.md)」に、3 つのモードの通しの使い方は「[通しの使い方](doc/spec/end-to-end-usage.md)」にあります。

設計の詳細は [doc/design/](doc/design/) を参照してください。

## 必要なもの

- Node.js 24.22.1 以上の 24 系（`package.json` の `engines` は `>=24.22.1 <25`。最新の 24 系を勧めます）。24.22.1 は、Node.js の 2026-10-21 のセキュリティリリースの修正版です。
- 依存パッケージ
- Playwright の Chromium（Chromium だけを使います。ほかのブラウザは入れなくてかまいません）

```bash
npm ci --ignore-scripts
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

## 管理画面（ローカル）

監査プロファイルを登録し、3 つのモードの監査と書き込みを動かす、このコンピュータの中だけで動く画面です。

```bash
npm run setup:local
npm run ui
```

コンソールに出た URL をブラウザで開きます。準備の手順は「[管理データの準備](doc/spec/local-setup.md)」、画面と守りは「[管理画面（ローカル）](doc/spec/local-ui.md)」にあります。

## 注意

- **headless での実行を勧めます。** headed では、実行中にブラウザの画面（タブやウィンドウ）を閉じたり、停止・再読み込みしたりしないでください（「[headed で実行するときの注意](doc/spec/safety.md#headed-で実行するときの注意)」）。
- 監査（Run）が途中で止まっても、同じコマンドをもう一度実行すると、続きから監査します。続きから再開せずに新しい Run を始めるには、`--new` を付けます（「[中断と再開](doc/spec/resume.md#中断と再開)」）。
- Ctrl+C を1回押すと、今のページの監査を終えてから止まります。もう一度押すと、すぐに止まります（「[Ctrl+C で止める](doc/spec/resume.md#ctrlc-で止める)」）。
- 監査は読み取り専用です。ページを観測する段階では、ネットワークへのリクエストを `GET` と `HEAD` に限ります（「[読み取り専用の保証の範囲](doc/spec/safety.md#読み取り専用の保証の範囲)」）。サイトへ書き込むのは、承認された書き込み（`TEST_APPROVED_WRITE`）の登録と更新だけです（「[承認された登録](doc/spec/approved-create.md)」）。
- 成果物を ChatGPT などの外へ渡す前に、「[成果物を外へ渡す前の確かめ](doc/spec/anonymization.md)」を読んでください。認証つきの監査と書き込みの成果物には、テスト環境の画面の文や、人が入れた値が入ります。
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
- [管理データの準備](doc/spec/local-setup.md): 管理画面が使う管理データ（SQLite）の準備の手順、止まったときの理由と取るべき手順
- [管理画面（ローカル）](doc/spec/local-ui.md): 管理画面の起動、画面と操作、守りの範囲、開発と検証のスクリプト
- [導入](doc/spec/getting-started.md)、[通しの使い方](doc/spec/end-to-end-usage.md): 必要なものと初期設定から最初の監査まで、3 つのモードを通して使う順
- [成果物を外へ渡す前の確かめ](doc/spec/anonymization.md)、[リスクと監査の記録](doc/spec/risks-and-audit-logs.md): 何を見て何を伏せるか、承認の履歴と台帳の読み方、未解決の不具合と受け入れた限界
- 認証つきの監査と書き込みの各段の手順は、[仕様の索引](doc/spec/README.md)にあります。
- [開発者向け](doc/spec/development.md): npm のスクリプト、ローカルでの検証の手順、アーカイブのスクリプト
