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
| `--config <パス>` | 対象の設定のファイル。省略した場合の扱いは「[監査の対象の設定](#監査の対象の設定)」を参照してください。 |
| `--output <ディレクトリ>` | 出力先のディレクトリ。設定の `output.directory` を上書きします。 |
| `--headed` | ブラウザの画面を表示して実行します。設定の `browser.headed` を上書きします。使う前に「[headed で実行するときの注意](#headed-で実行するときの注意)」を読んでください。 |
| `--headless` | ブラウザの画面を表示せずに実行します。設定の `browser.headed` を上書きします。 |
| `--help` | 使い方を表示します。設定は読まず、監査も実行しません。終了コードは 0 です。 |

- `--headed` と `--headless` は、同時に指定できません。同時に指定すると、設定のエラー（終了コード 4）になります。
- 値を取るオプション（`--config`、`--output`）を2回以上指定すると、設定のエラー（終了コード 4）になります。後の値で上書きすることはしません。
- 知らないオプション、値のないオプション、余分な引数、知らないコマンドも、設定のエラー（終了コード 4）になります。このとき、使い方も表示します。
- `--help` は、ほかの引数を解析できれば、コマンドの有無によらず使い方を表示します。
- どちらのオプションも指定しない場合は、設定の `browser.headed` に従います。既定値は `false`（headless）です。

### 例

```bash
# 使い方を表示する
node dist/cli/index.js --help

# config/targets/ の中の、ただ1つの設定を確かめる
node dist/cli/index.js validate-config

# 設定のファイルを指定して確かめる
node dist/cli/index.js validate-config --config config/targets/example.json

# 監査を実行する（headless を勧めます）
node dist/cli/index.js run --config local/targets/<対象名>.json --headless --output artifacts
```

`validate-config` が成功すると、次のように表示します。

```text
設定に、誤りはありません。
対象: example
開始の URL: https://example.com/
```

## 監査の対象の設定

監査の対象は、JSON の設定のファイルで指定します。
必須の項目は、`target.id` と `site` の2つです。

```json
{
  "target": { "id": "example" },
  "site": {
    "startUrl": "https://example.com/",
    "allowedOrigins": ["https://example.com"]
  }
}
```

- `target.id`: 対象の ID。空でない文字列です。
- `site.startUrl`: 巡回を始める URL。`http:` か `https:` の URL で、認証情報（`user:pass@`）を含められません。
- `site.allowedOrigins`: 巡回を許す Origin の一覧。空にできません。`site.startUrl` の Origin を含める必要があります。
- 知らない項目があると、設定のエラーになります。

### 既定値

書かなかった項目には、次の既定値を使います。設定のファイルに書いた値が、既定値に優先します。

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `crawl.maxPages` | `500` | 監査するページの数の上限 |
| `crawl.maxDepth` | `20` | 開始の URL からのリンクの深さの上限 |
| `crawl.maxRuntimeMs` | `3600000`（60分） | 実行時間の上限。この時間を過ぎたら、新しいページの監査を始めません（監査中のページは続けます） |
| `crawl.navigationTimeoutMs` | `30000` | ページを開く処理の期限 |
| `crawl.overallPageTimeoutMs` | `60000` | 1つのページの監査の期限 |
| `crawl.resourceSettlingTimeoutMs` | `5000` | リソースの読み込みが落ち着くのを待つ期限 |
| `crawl.interactionTimeoutMs` | `3000` | Interaction の1つの候補を確かめる期限 |
| `crawl.allowedQueryParameters` | `[]` | URL の正規化で残すクエリの名前。一覧にないクエリは、URL から除きます |
| `browser.headed` | `false` | ブラウザの画面を表示するか |
| `browser.locale` | `"ja-JP"` | ブラウザのロケール |
| `browser.timezone` | `"Asia/Tokyo"` | ブラウザのタイムゾーン |
| `viewports.primaryDesktop` | `1440` × `900` | デスクトップのビューポート |
| `viewports.primaryMobile` | `390` × `844` | モバイルのビューポート |
| `viewports.stressWidths` | `[320, 390, 768, 1024, 1440]` | 幅の走査で調べる幅。デスクトップとモバイルの幅と同じものは、走査しません |
| `audit.performance` | `true` | パフォーマンスの Evidence を集めるか |
| `audit.accessibility` | `true` | アクセシビリティの Evidence を集めるか |
| `audit.interactions` | `true` | Interaction の段階を行うか |
| `audit.screenshots` | `true` | スクリーンショットを撮るか |
| `output.directory` | `"artifacts"` | 出力先のディレクトリ |

- 期限の値には、組み合わせの条件があります。たとえば、Interaction を行う場合は、`crawl.overallPageTimeoutMs` を `crawl.navigationTimeoutMs + 2 × crawl.interactionTimeoutMs` 以上にする必要があります。
- 条件に合わない値は、`validate-config` が英語の技術的な詳細で示します。

### `config/targets/` と `local/` の使い分け

- `config/targets/` には、Git で公開してもよい設定だけを置きます。`config/targets/example.json` は、例の値（`https://example.com/`）だけを持つ見本です。
- 顧客を特定できる実際の設定（実在のサイトの URL など）は、`config/targets/` に置かないでください。Git の管理の対象外の `local/` に置きます（例: `local/targets/<対象名>.json`）。
- `local/` の設定は、自動では選ばれません。必ず `--config` で指定します。

```bash
node dist/cli/index.js validate-config --config local/targets/<対象名>.json
```

### `--config` を省いたときの扱い

- 実行したときのカレントディレクトリの `config/targets/` の中（サブディレクトリを含む）から、`*.json` を探します。
- ちょうど1つだけ見つかった場合に、それを使います。0個か2つ以上の場合は、設定のエラー（終了コード 4）になります。
- `config/targets/` の中の設定は、`target.id` が互いに重なってはいけません。重なると、設定のエラーになります。この確かめは、`--config` で `config/targets/` の中のファイルを指定した場合にも行います。
- このとき、`config/targets/` の中のすべての `*.json` を読みます。どれか1つでも JSON として読めないか、`target.id` がない場合も、設定のエラーになります。選んだ設定に誤りがなくても、同じです。
- `--config` で `config/targets/` の外のファイルを指定した場合は、そのファイルだけを読みます。
- 設定のファイルの先頭の UTF-8 の BOM は、1つだけ取り除いてから読みます。UTF-8 の BOM 付きのファイル（例: Windows PowerShell 5.1 で `-Encoding UTF8` を付けて書いたファイル）も、そのまま使えます。
- UTF-16 などの、UTF-8 でないファイルは読めません。

## 終了コード

終了コードは、最終の Run Status と、設定のエラーだけで決まります。
サイトの Finding の件数（エラーが何件あるか）では決まりません。
エラーの Finding があっても、必要な確認をすべて終えていれば、終了コードは 0 です。

| 終了コード | 結果 | 意味 |
| --- | --- | --- |
| `0` | 完了（`COMPLETE`） | 必要な確認を、すべて終えました。`validate-config` の成功と、`--help` も 0 です。 |
| `1` | 失敗（`FAILED`） | 監査を実行できませんでした。結果のファイルを書き出せなかった場合と、想定していないエラーの場合も 1 です。 |
| `2` | 一部未完了（`PARTIAL`） | 一部の確認を終えられませんでした。結果は、確認できた範囲のものです。 |
| `3` | 安全のため中止（`ABORTED_BY_SAFETY`） | 安全の不変条件の違反を記録したため、監査を中止しました。 |
| `4` | 設定のエラー（`CONFIG_ERROR`） | 設定のファイル、または CLI の引数に誤りがあります。 |

## 出力の構成

`run` は、出力先のディレクトリの下に、Run ごとのディレクトリを作ります。
Run のディレクトリの名前は、Run の ID（`RUN-YYYYMMDDHHmmss`。開始の時刻の UTC）です。

```text
<出力先>/
  RUN-20260925010203/
    run.json                        Run の要約（Run Status、件数、Safety Ledger、実際に使った設定）
    audit.json                      全ページの結果と、すべての Finding
    report.html                     日本語の HTML レポート
    beaksight-audit-bundle.zip      ChatGPT 用のバンドル
    pages/
      PAGE-000001/
        page.json                   ページの結果（Evidence と Finding）
        visible-text.txt            ページの可視テキスト
        desktop/
          viewport.png              表示範囲のスクリーンショット
          full-page.png             ページ全体のスクリーンショット
        mobile/
          viewport.png
          full-page.png
        retry-1/                    再試行した場合の、前の試行のスクリーンショット
          desktop/
            ...
```

- JSON とテキストは、UTF-8（BOM なし）で、改行は LF です。
- JSON は、スキーマ（`schemas/`）で検証してから書きます。スキーマに合わない場合は、Run Status を `COMPLETE` にしません。
- `visible-text.txt` は、デスクトップの可視テキストから作ります。デスクトップにない場合はモバイルから作り、どちらにもない場合は書きません。
- 同じ名前の Run のディレクトリがすでにある場合は、別の Run の結果を書き換えないよう、監査を始めずに終えます（終了コード 1）。
- 出力先には、スクリーンショットや、サイトの可視テキストが入ります。`artifacts/` は、Git の管理の対象外です。

## 結果の読み方

### CLI の表示

`run` は、最後に次の項目を表示します。

- Run の状態（例: `完了（COMPLETE）`）
- 出力先（Run のディレクトリ）と、HTML レポートと ChatGPT 用のバンドルのパス
- ページの網羅（発見、監査、一部未完了、失敗、スキップのページの数）
- サイト品質の指摘の件数（エラー、警告、情報）と、安全の指摘の件数
- 未完了の理由がある場合は、その件数

### HTML レポート

`report.html` は、ブラウザで開く静的な HTML です。
`page.json` やスクリーンショットへの相対リンクを持つので、Run のディレクトリごと扱ってください。
レポートは、次の節からなります。

1. 要約: Run の状態、ページの網羅、指摘の件数、上限と未完了の理由、実行の環境
2. 重大な指摘: 重大度がエラーの指摘（カテゴリを問いません）
3. カテゴリ別の指摘: ネットワーク、JavaScript、リンク、DOM、フォーム、レイアウト、アクセシビリティ、パフォーマンス、ページ間、安全
4. インタラクション: 操作の候補ごとの結果
5. 安全: 安全のために止めた操作と、安全の不変条件の違反（「[Safety Ledger の読み方](#safety-ledger-の読み方)」）
6. ページの一覧: ページごとの状態、ビューポートごとの状態、スクリーンショット

`mailto:` や `tel:` などの URL と、安全のために止めた操作の URL は、リンクにせず、文字として示します。

### Run Status の意味

Run Status は、監査を最後まで行えたかを表します。サイトの品質の良し悪しを表すものではありません。

- `COMPLETE`: 必要な確認を、すべて終えました。サイトに問題があるかどうかは、Finding で確かめます。
- `PARTIAL`: 一部の確認を終えられませんでした。たとえば、上限（ページの数、深さ、実行時間）に達した場合や、期限を過ぎた場合です。理由は、レポートの要約の「未完了の理由」と、`run.json` の `incompleteReasons` にあります。
- `FAILED`: 監査を実行できませんでした。たとえば、実行の前の確認（PREFLIGHT）に失敗した場合や、Run のディレクトリを作れなかった場合です。
- `ABORTED_BY_SAFETY`: 安全の不変条件の違反を記録しました。違反を記録した後は、新しいページ、次のビューポート、次の Interaction の候補を始めません。残りのページは、理由 `SAFETY_VIOLATION_ABORT` のスキップになります。結果のファイルは、止めたことを含めて書き出します。

### Finding と Evidence

- Evidence は、ブラウザで観測した事実の記録です（ネットワーク、コンソール、DOM、レイアウト、色、パフォーマンス、アクセシビリティ、スクリーンショットなど）。各ページの `page.json` にあります。
- Finding は、Rule が Evidence から判定した指摘です。重大度（エラー、警告、情報、安全）、カテゴリ、Rule の ID（`ruleId`）、文言を持ちます。
- Finding は、根拠の Evidence を `evidenceRefs` で参照します。HTML レポートの指摘の表からは、Evidence（`page.json` の中の場所）とスクリーンショットへたどれます。
- 件数は、サイト品質（エラー、警告、情報）と安全を、分けて数えます。

### 幅の走査の結果

レイアウトは、デスクトップとモバイルのビューポートのほかに、`viewports.stressWidths` の幅でも調べます（幅の走査）。
既定値では、デスクトップ（1440）とモバイル（390）の幅を除いた、320、768、1024 の3つの幅を調べます。

- 幅の走査は、ページごとに、デスクトップのビューポートの監査の中で1回だけ行います。
- 走査の結果は、デスクトップのレイアウトの Evidence の中（`stressSweep`）に記録します。
- 走査で見つかったはみ出し（例: `DOCUMENT_HORIZONTAL_OVERFLOW`）の Finding は、ビューポートがデスクトップとして記録されます。
- そのため、HTML レポートの指摘の表では、ビューポートの欄が「デスクトップ」になります。どの幅で見つかったかは、文言の先頭（例: 「レスポンシブの幅 320 px の確認で、…」）で分かります。

### ChatGPT 用のバンドル

`beaksight-audit-bundle.zip` は、後段の意味監査のために、ChatGPT に手動でアップロードする ZIP です。次のファイルを含みます。

- `manifest.json`: 中のファイルの一覧（大きさと SHA-256）と、入れられなかったファイル（`omittedFiles`）
- `run.json`: 書き出した `run.json` そのもの
- `summary.json`、`findings.json`、`pages.json`、`evidence-index.json`: 要約、指摘、ページ、Evidence の索引
- `pages/<pageId>/page.json`: 各ページの結果（一次の Evidence）
- 指摘に関係するスクリーンショット（合計 64 MiB まで。超えた分は `omittedFiles` に書きます）

- 状態、理由、重大度などの値は、英数字のコードのままです。表示用の日本語のラベルは入れません。
- Finding の文言（日本語）は、そのまま入ります。
- ページの HTML などの、生の応答の本文は含めません。
- ただし、各ページの `page.json` には、ページの可視テキストと URL が入ります。

アップロードする前に、バンドルの中身が、ChatGPT に渡してよい内容かを確かめてください。

## 読み取り専用の保証の範囲

BeakSight は、サイトの状態を変える操作をしないように作っています。

- ページを観測する段階（Passive）では、ネットワークへのリクエストを `GET` と `HEAD` に限ります。ほかのメソッドのリクエストは、送る前に遮断し、記録します。
- WebSocket の接続は、遮断します。
- 許可 Origin の外へのページの移動は、遮断します。巡回でたどるのは、許可 Origin の中の通常のリンクだけです。
- Interaction（開閉のボタンなどの操作）は、ページを観測する環境とは別の、使い捨ての環境で行います。操作の前に通信を止め、操作の後の通信、ページの移動、ポップアップ、ダウンロード、WebSocket を遮断します。
- 送信のボタン、フォームに属する要素、ほかのページへ移動するリンク、ダウンロード、外部の Origin や特殊なスキーム（`tel:`、`mailto:` など）へ作用する要素は、操作しません。
- フォームの送信、ダウンロード、外部のアプリの起動は行いません。ブラウザの環境は、ダウンロードを受け付けない設定で作ります。

保証できない範囲もあります。

- サーバの側で副作用を持つ `GET` のエンドポイントがあっても、クライアントの側からは見分けられません。
- ページ自身が読み込む、ほかの Origin のリソース（画像、スクリプト、iframe など）への `GET` は、送られます。遮断するのは、許可 Origin の外へのページそのものの移動です。
- ページのスクリプトによる外部スキームへの移動は、止められません。headed で実行すると、外部のアプリが起動する可能性があります（次の節）。

## headed で実行するときの注意

**headless での実行を勧めます。** 既定値は headless です。

- ページのスクリプトが外部スキーム（`mailto:`、`tel:` など）へ移動しようとした場合、BeakSight はその移動を止められません。外部スキームへの移動は、ネットワークを通らないためです。
- headless のブラウザには、外部のアプリへ URL を渡す仕組みがありません。開発のときの実験でも、外部のアプリは起動しませんでした。そのため、headless では、移動の試みを Safety の記録（外部スキームへの移動の試み）に残すだけにします。違反にはしません。
- ただし、ページのスクリプトが新しいウィンドウ（`window.open` や `target="_blank"` のリンク）で外部スキームを開こうとした場合は、headless でも、安全の不変条件の違反（`FRAME_CLASSIFICATION_FAILED`）になります。このとき、そのブラウザの環境を閉じ、Run は `ABORTED_BY_SAFETY`（終了コード 3）になります。新しいウィンドウの移動は、どの frame の移動かを判定できないためです。
- headed（`--headed`、または `browser.headed: true`）では、メールのアプリや電話のアプリなどの、外部のアプリが起動する可能性があります。
- headed でこの移動の試みを検出した場合は、安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE`）として記録します。その時点で、そのブラウザの環境を閉じます。Run は `ABORTED_BY_SAFETY`（終了コード 3）になります。起動そのものは、防げません。
- サーバのリダイレクトによる外部スキームへの移動（3xx の `Location` が外部スキーム）は、ブラウザがたどる前に止めます。この経路は、headed でも違反にしません。記録の理由は `EXTERNAL_SCHEME_REDIRECT_BLOCKED` です。
- どうしても headed で実行する場合は、`mailto:` や `tel:` の既定のアプリがない、隔離した環境（仮想マシンなど）で実行してください。

## Safety Ledger の読み方

Safety Ledger は、Guard（安全の確認の仕組み）が止めた操作と、安全の不変条件の違反の記録です。
要約は `run.json` の `safety` に、事象の一つ一つは各ページの `page.json` の安全の記録（Evidence）にあります。
HTML レポートでは「安全」の節に示します。

| 項目（`run.json`） | レポートの表示 | 読み方 |
| --- | --- | --- |
| `guardEnabled` | 安全の確認: 有効 / 無効 | Guard が有効だったか。 |
| `blockedActions` | 遮断した操作 | リクエスト、ナビゲーション、外部への作用、ポップアップ、ダウンロード、WebSocket の、遮断した件数。 |
| `blockedRequestsByMethod` | メソッドごとの、遮断したリクエスト | 遮断したリクエストの、メソッドごとの件数。 |
| `excludedInteractionCandidateCount` | 安全のため除外した Interaction の候補 | 安全のため、機械的に操作の対象から外した候補の数。 |
| `invariantViolationCount`、`invariantViolations` | 安全の不変条件の違反 | 違反の件数と、各違反のコードと内容。1件でもあれば `ABORTED_BY_SAFETY` になります。 |
| `recordTruncated` | 安全の記録 | 記録が上限に達したか。達した場合、遮断した件数は下限です。Run は `COMPLETE` になりません（`PARTIAL`）。 |

- 遮断した操作があることは、失敗ではありません。Guard が正しく止めた証拠です。
- 問題になるのは、不変条件の違反です。違反があると、Run は `COMPLETE` になりません。

レポートの「Safety の事象の一覧」は、次の種類の記録を示します（名前は `page.json` の安全の記録の項目の名前です）。

| 記録の名前 | レポートの表示 |
| --- | --- |
| `blockedRequests` | 遮断したリクエスト |
| `blockedNavigations` | 遮断したナビゲーション |
| `blockedWebSockets` | 遮断した WebSocket |
| `blockedExternalActions` | 実行しなかった外部への作用 |
| `excludedInteractionCandidates` | 除外した Interaction の候補 |
| `blockedInteractionRequests` | 操作中に遮断したリクエスト |
| `blockedInteractionNavigations` | 操作中に遮断したナビゲーション |
| `blockedPopups` | 遮断したポップアップ |
| `blockedDownloads` | 遮断したダウンロード |
| `blockedInteractionWebSockets` | 操作中に遮断した WebSocket |
| `externalSchemeNavigations` | 外部スキームへの移動の試み |

外部スキームへの移動の試みは、理由で見分けます。

- `EXTERNAL_SCHEME_NAVIGATION`: ページが移動を試みた記録です。止められない経路です。headed では、外部のアプリが起動した可能性があります。
- `EXTERNAL_SCHEME_REDIRECT_BLOCKED`: サーバのリダイレクトを、ブラウザがたどる前に止めた記録です。

## パフォーマンスの値（RUM/APM）について

BeakSight のパフォーマンスの値は、監査の実行の中で、ブラウザがページを開いたときに測った、合成の計測（Synthetic）の値です。

- 実際の利用者の環境で測った値（RUM）ではありません。値は、実行した環境やネットワークに左右されます。
- APM の値でもありません。Navigation Timing、Resource Timing、`Server-Timing`、`traceparent` などは、ブラウザから見える範囲の記録です。サーバの内部の記録（データベースの処理の時間など）は含みません。
- パフォーマンスの Finding（例: `POOR_LCP`）の重大度は、警告です。
- 観測できなかった値は、0 などで埋めずに「未観測」と示します。

## Windows PowerShell での日本語の表示

CLI の出力は、UTF-8 の日本語です。

- コンソールに直接表示する場合は、Windows PowerShell 5.1 と cmd.exe のどちらでも読めます。
- Windows PowerShell 5.1 で、出力をパイプやリダイレクトに渡すと、`[Console]::OutputEncoding` が既定（コードページ 932）のままの場合に、文字化けします。パイプやリダイレクトの前に、次のコマンドを実行してください。

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

- BeakSight は、コンソールのコードページを変えません。
- 結果は、UTF-8 の `report.html` と JSON（`run.json`、`audit.json`）で見ることも勧めます。

## 開発者向け

### npm のスクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | TypeScript をビルドし、`schemas/` を `dist/schemas` に写します。 |
| `npm run typecheck` | 型チェックだけを行います（ファイルは出力しません）。 |
| `npm test` | すべてのテストを実行します。 |
| `npm run test:unit` | 単体のテストと、部品のテスト（`tests/unit`、`tests/component`）を実行します。 |
| `npm run test:integration` | 結合のテスト（`tests/integration`）を実行します。 |
| `npm run verify` | `typecheck`、`test`、`build` を順に実行します。 |

### ローカルでの検証の手順

1. Chromium を入れます（初回だけ）: `npx playwright install chromium`
2. 全体を確かめます: `npm run verify`
3. fixture の全体の監査を確かめます:

```bash
npx vitest run tests/integration/fixture-full-crawl.test.ts
```

fixture の全体の監査のテストは、次のことを行います。

- テスト用の fixture のサイト（`fixtures/site/full-crawl/`）を、ローカルのサーバで動かします。
- ビルドした CLI を別のプロセスで起動し、`--headless` で最後まで監査します。
- 既定の設定で、Run が `COMPLETE` になることを確かめます。わざと壊した箇所ごとに期待した Finding が出ること、安全の不変条件の違反がないこと、サーバに届いたリクエストが `GET` と `HEAD` だけであることも確かめます。

テストは、Chromium を headless だけで起動します。実在の外部のサイトにはアクセスしません。

### アーカイブのスクリプト

`tools/archive_beaksight.ps1` は、本番用のソースだけの ZIP を作ります。
依存パッケージ、生成物、テスト、fixture、ドキュメント、リポジトリのメタデータ、エージェントの作業ファイルは、含めません。

```powershell
powershell -ExecutionPolicy Bypass -File tools/archive_beaksight.ps1
```

出力先の既定は、環境変数 `BEAKSIGHT_ARCHIVE_OUTPUT_DIR` の値です。
設定していない場合は、リポジトリと同じ階層の `BeakSight-archive` フォルダです。
`-OutputDirectory` で指定することもできます。
