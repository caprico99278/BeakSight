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
| `crawl.maxPages` | なし | 監査するページの数の上限。書いたときだけ効きます。書かなければ上限はなく、報告と画面には「指定なし」と出ます。`1` 以上の整数にします（上限はありません） |
| `crawl.maxDepth` | なし | 開始の URL からたどるリンクの深さの上限。書いたときだけ効きます（`1` 以上） |
| `crawl.maxRuntimeMs` | なし | 1回の起動の時間の上限（ミリ秒）。書いたときだけ効きます。書かなければ期限はなく、報告と画面には「指定なし」と出ます。この時間を過ぎたら、新しいページの監査を始めません（監査中のページは続けます）。再開した起動は、その起動の開始から数えます。上限で止まった Run は、同じコマンドで続きから再開できます（「[中断と再開](resume.md#中断と再開)」） |
| `crawl.navigationTimeoutMs` | なし | ページを開く処理の期限（ミリ秒）。書いたときだけ効きます。書かなければ、ページが反応している間は待ちます |
| `crawl.overallPageTimeoutMs` | なし | 前の版の項目です。ページの監査の期限には使いません。ただし、Interaction を行う設定で、この項目と `crawl.navigationTimeoutMs`・`crawl.interactionTimeoutMs` をすべて書いたときは、この値が `crawl.navigationTimeoutMs + 2 × crawl.interactionTimeoutMs` 以上でないと、設定の誤りになります |
| `crawl.resourceSettlingTimeoutMs` | なし | 前の版の項目です。書いても、今は使いません |
| `crawl.interactionTimeoutMs` | なし | Interaction の1つの候補を確かめる期限（ミリ秒）。書いたときだけ効きます（`1000` より大きい値） |
| `crawl.minNavigationIntervalMs` | `5000`（5秒） | ページの読み込みの最小の間隔（ミリ秒）。ページの読み込みの要求がサイトに届く間隔が、この時間以上になるように、次の読み込みを始めます（前の読み込みの開始、その要求をサイトに送った時刻、その応答を受けた時刻のうち、最も遅い時刻から数えます。自動ログインの読み込みも含みます）。`1000` 以上にする必要があります。ただし、`site.allowedOrigins` がすべてループバックのアドレス（`127.0.0.1`、`[::1]`、`localhost`）の場合は、`0` 以上にできます。方針と、監査にかかる時間への影響は「[サイトへの負荷](site-load.md#サイトへの負荷)」を見てください |
| `crawl.maxInteractionsPerPage` | なし | 1つのページで、Interaction で確かめる候補の数の上限。書いたときだけ効きます（`1` 以上）。書かなければ、見つけた候補をすべて確かめます |
| `crawl.allowedQueryParameters` | `[]`（指定なし） | URL の正規化で残すクエリの名前。名前を書いたときは、一覧にないクエリを URL から除きます。空（`[]`）か書かないときは、クエリを残します（追跡用の名前・秘密に見える名前・`#` の後ろは除きます）。空と書かないことは同じ意味です。秘密に見える名前（`token`、`session`、`code`、`state` など）を入れると、監査は設定の誤り（`CONFIG_ERROR`）で始まりません（公開の監査と認証つきの監査の両方。Task 44 の P4-1） |
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
| `audit.sendPolicy` | `"PASS_EXCEPT_DELETE"` | 監査の段の送信の扱い。`"READ_ONLY"`（ページが出す読み取りでない送信をすべて止める）か `"PASS_EXCEPT_DELETE"`（ページが自分で出す送信を止めずに通す。2026-11-16 から、削除と危険な語の送信も止めません。名前は前の設定を読むために残しています）。通すもの・止めるもの・限界は「[監査の段の送信の扱い](safety.md#監査の段の送信の扱い)」を見てください |
| `output.directory` | `"artifacts"` | 出力先のディレクトリ |

- 上限と期限の項目（既定値が「なし」のもの）に、前の版の既定と同じ値を書くと、選んでいない値とみなして使いません。たとえば `crawl.maxPages` の `500` と `3`、`crawl.maxRuntimeMs` の `3600000`、`crawl.maxDepth` の `20` です。前の版の画面が、選んでいない値も設定のファイルに書いていたためです。
- 条件に合わない値は、`validate-config` が英語の技術的な詳細で示します。
- `audit.sendPolicy` の実効の値は、`run.json` の `effectiveConfig.audit.sendPolicy` と `safety.auditSend` に残ります。中断した Run の再開では、設定の値をすべて比べます。違えば、続きからは再開せず、新しい Run を始めます。この項目を持たない古い Run の保存や、前の版の既定の上限を持つ古い Run の保存も、設定が違うので続きからは再開しません。
- 画面から始めるジョブは、設定のファイルの値ではなく、プロファイルの設定（「[ローカルの管理画面](local-ui.md)」の表示の設定の欄）を使います。画面のサイトの既定も `"PASS_EXCEPT_DELETE"` です。書き込みのジョブは、値を入れる前などの一部にだけ当てます（「[監査の段の送信の扱い](safety.md#監査の段の送信の扱い)」の「当てない段」の後）。ログインの確かめ・入口の確かめは、いつも `"READ_ONLY"` で読みます。

## `config/targets/` と `local/` の使い分け

- `config/targets/` には、Git で公開してもよい設定だけを置きます。`config/targets/example.json` は、例の値（`https://example.com/`）だけを持つ見本です。
- `config/targets/example-test-environment.json.example` は、テスト環境の監査と書き込みのための匿名の例です（予約された名前 `admin.example.test`）。設定のファイル（`targetConfig`）と、管理画面で入れるプロファイルと認証の設定の値の例を持ちます。拡張子が `.json` でないので、CLI と管理画面は読みません（下の「`--config` を省いたときの扱い」で選ばれません）。使い方は「[通しの使い方](end-to-end-usage.md)」にあります。
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
