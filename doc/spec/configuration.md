# 監査の対象の設定

監査の対象の設定のファイル（JSON）の書き方、既定値、置き場所の決まりです。

[README に戻る](../../README.md)・[仕様の索引](README.md)

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

## 既定値

書かなかった項目には、次の既定値を使います。設定のファイルに書いた値が、既定値に優先します。

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `crawl.maxPages` | `500` | 監査するページの数の上限 |
| `crawl.maxDepth` | `20` | 開始の URL からのリンクの深さの上限 |
| `crawl.maxRuntimeMs` | `3600000`（60分） | 1回の起動ごとの実行時間の上限。この時間を過ぎたら、新しいページの監査を始めません（監査中のページは続けます）。再開した起動は、その起動の開始から数えます。上限で止まった Run は、同じコマンドで続きから再開できます（「[中断と再開](resume.md#中断と再開)」） |
| `crawl.navigationTimeoutMs` | `30000` | ページを開く処理の期限 |
| `crawl.overallPageTimeoutMs` | `60000` | 1つのページの監査の期限 |
| `crawl.resourceSettlingTimeoutMs` | `5000` | リソースの読み込みが落ち着くのを待つ期限 |
| `crawl.interactionTimeoutMs` | `3000` | Interaction の1つの候補を確かめる期限 |
| `crawl.minNavigationIntervalMs` | `5000`（5秒） | ページの読み込みの最小の間隔（ミリ秒）。前の読み込みの開始から、この時間以上空けて、次の読み込みを始めます。`1000` 以上にする必要があります。ただし、`site.allowedOrigins` がすべてループバックのアドレス（`127.0.0.1`、`[::1]`、`localhost`）の場合は、`0` 以上にできます。方針と、監査にかかる時間への影響は「[サイトへの負荷](site-load.md#サイトへの負荷)」を見てください |
| `crawl.maxInteractionsPerPage` | `20` | 1つのページで、Interaction で確かめる候補の数の上限。`1` 以上 `100` 以下にする必要があります（`100` は、1つのページで見つける候補の数の上限です）。上限を超えた候補の扱いは「[サイトへの負荷](site-load.md#サイトへの負荷)」を見てください |
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

## `config/targets/` と `local/` の使い分け

- `config/targets/` には、Git で公開してもよい設定だけを置きます。`config/targets/example.json` は、例の値（`https://example.com/`）だけを持つ見本です。
- 顧客を特定できる実際の設定（実在のサイトの URL など）は、`config/targets/` に置かないでください。Git の管理の対象外の `local/` に置きます（例: `local/targets/<対象名>.json`）。
- `local/` の設定は、自動では選ばれません。必ず `--config` で指定します。

```bash
node dist/cli/index.js validate-config --config local/targets/<対象名>.json
```

## `--config` を省いたときの扱い

- 実行したときのカレントディレクトリの `config/targets/` の中（サブディレクトリを含む）から、`*.json` を探します。
- ちょうど1つだけ見つかった場合に、それを使います。0個か2つ以上の場合は、設定のエラー（終了コード 4）になります。
- `config/targets/` の中の設定は、`target.id` が互いに重なってはいけません。重なると、設定のエラーになります。この確かめは、`--config` で `config/targets/` の中のファイルを指定した場合にも行います。
- このとき、`config/targets/` の中のすべての `*.json` を読みます。どれか1つでも JSON として読めないか、`target.id` がない場合も、設定のエラーになります。選んだ設定に誤りがなくても、同じです。
- `--config` で `config/targets/` の外のファイルを指定した場合は、そのファイルだけを読みます。
- 設定のファイルの先頭の UTF-8 の BOM は、1つだけ取り除いてから読みます。UTF-8 の BOM 付きのファイル（例: Windows PowerShell 5.1 で `-Encoding UTF8` を付けて書いたファイル）も、そのまま使えます。
- UTF-16 などの、UTF-8 でないファイルは読めません。
