# 出力と結果の読み方

Run のディレクトリに書き出すファイルの構成と、HTML レポート、Run Status、Finding と Evidence、幅の走査の結果、ChatGPT 用のバンドル、パフォーマンスの値の読み方です。
CLI の表示の読み方は「[CLI の表示](cli.md#cli-の表示)」にあります。

[README に戻る](../../README.md)・[仕様の索引](README.md)

## 出力の構成

`run` は、出力先のディレクトリの下に、Run ごとのディレクトリを作ります。
Run のディレクトリの名前は、Run の ID（`RUN-YYYYMMDDHHmmss`。開始の時刻の UTC）です。

```text
<出力先>/
  RUN-20260925010203/
    run.json                        Run の要約（Run Status、件数、Safety Ledger、実際に使った設定、起動の記録）
    audit.json                      全ページの結果と、すべての Finding
    report.html                     日本語の HTML レポート
    beaksight-audit-bundle_20260925023015.zip   ChatGPT 用のバンドル（名前の日時は、最後の実行の終わりの時刻の UTC。「ChatGPT 用のバンドル」）
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
    checkpoint/                     再開のための保存（「中断と再開」）
      state.json                    Run の状態の保存（最後に監査を終えたページまで）
      state.prev.json               1つ前の state.json
      pages/
        PAGE-000001.json            監査を終えたページの保存
      run.lock                      ロック（実行中の Run の印）
    diagnostics/                    サイトの不調で止めたときの診断の記録（「サイトが応答しないとき」）
      site-unavailable-PAGE-000003-1-1.json   不調だったページの監査の結果と、ページ本体の要求の観察（ページと起動と試行ごと）
```

- JSON とテキストは、UTF-8（BOM なし）で、改行は LF です。
- JSON は、スキーマ（`schemas/`）で検証してから書きます。スキーマに合わない場合は、Run Status を `COMPLETE` にしません。
- `visible-text.txt` は、デスクトップの可視テキストから作ります。デスクトップにない場合はモバイルから作り、どちらにもない場合は書きません。
- ChatGPT 用のバンドルの名前は、`beaksight-audit-bundle_YYYYMMDDHHmmss.zip` です。日時は、その Run の最後の実行の終わりの時刻で、Run の ID と同じ書式（UTC、24 時間制）です。Run のディレクトリには、最新のバンドルが1つだけあります（「[ChatGPT 用のバンドル](#chatgpt-用のバンドル)」）。
- 新しい Run を始めるときに、同じ名前の Run のディレクトリがすでにある場合は、別の Run の結果を書き換えないよう、監査を始めずに終えます（終了コード 1）。途中の Run を再開するときは、その Run のディレクトリを、そのまま使います。
- 出力先には、スクリーンショットや、サイトの可視テキストが入ります。`artifacts/` は、Git の管理の対象外です。

`checkpoint/` は、途中で止まった Run を、続きから再開するための保存です（「[中断と再開](resume.md#中断と再開)」）。

| ファイル | 中身 | 書く時期 |
| --- | --- | --- |
| `checkpoint/state.json` | Run の状態（巡回の記録、ID の採番、実効の設定、起動の記録、サイトへの負荷の記録など） | robots.txt と sitemap.xml の取得の後と、ページの監査が1つ終わるたびに、置き換えます。 |
| `checkpoint/state.prev.json` | 1つ前の `state.json` | `state.json` を置き換える前に、今の `state.json` をこの名前に移します。 |
| `checkpoint/pages/<pageId>.json` | 監査を終えたページの結果 | そのページの監査が終わったときに、1回だけ書きます。 |
| `checkpoint/run.lock` | ロック（プロセスの ID、OS の起動の時刻、ロックを取った時刻、最後に更新した時刻） | Run の開始と再開のときに作り、実行中は1分ごとに更新します。結果のファイルを書き出し、保存の終わりを書いた後に消します。 |

- 最後まで終えた Run では、`checkpoint/` に `state.json` だけが残ります。ページの保存（`checkpoint/pages/`。出力の `page.json` とほぼ同じ中身）と `state.prev.json` は、使わないので消します。
- 止まった Run（1回目の Ctrl+C、実行時間の上限）では、`run.lock` のほかのファイルが残ります。途中で終わった Run では、`run.lock` も残ります（次の起動で、古いロックと判定します）。
- 保存のファイルは、編集しないでください。

`diagnostics/` は、サイトの不調でページの監査を止めたときに書く、原因を調べるための記録です（「[サイトが応答しないとき](site-unavailability.md#サイトが応答しないとき)」）。結果のファイルではなく、`checkpoint/` の外にあるので、Run を最後まで終えた後も残ります。不調で止めたことがない Run には、ありません。

`run.json` の `executions` は、その Run の起動ごとの記録です。起動の順に、開始の時刻（`startedAt`）、終わりの時刻（`finishedAt`）、終わり方（`endReason`）を持ちます。中断せずに終えた Run では、1件です。

```json
"executions": [
  { "startedAt": "2026-10-01T00:00:00.000Z", "finishedAt": "2026-10-01T01:00:00.000Z", "endReason": "STOPPED_BY_RUNTIME_LIMIT" },
  { "startedAt": "2026-10-02T00:00:00.000Z", "finishedAt": "2026-10-02T00:30:00.000Z", "endReason": "INTERRUPTED_ABNORMALLY" },
  { "startedAt": "2026-10-02T09:00:00.000Z", "finishedAt": "2026-10-02T09:40:00.000Z", "endReason": "COMPLETED" }
]
```

| `endReason` | 意味 |
| --- | --- |
| `COMPLETED` | 下のどの止まり方でもなく、最後の処理まで行いました（Run の状態は問いません）。 |
| `STOPPED_BY_RUNTIME_LIMIT` | 実行時間の上限（1回の起動ごと）で、今のページを終えてから止まりました。 |
| `STOPPED_BY_SIGNAL` | 1回目の Ctrl+C などで、今のページを終えてから止まりました。 |
| `STOPPED_BY_SAFETY_VIOLATION` | 安全の不変条件の違反で止まりました。 |
| `STOPPED_BY_SITE_UNAVAILABLE` | サイトが応答しないため、残りのページを監査せずに止まりました。同じコマンドで再開できます（「[サイトが応答しないとき](site-unavailability.md#サイトが応答しないとき)」）。 |
| `INTERRUPTED_ABNORMALLY` | プロセスが途中で終わりました（強制終了、停電、2回目の Ctrl+C など）。終わりの時刻は、その起動の最後の保存の時刻です。 |

- `run.json` の `startedAt` は最初の起動の開始、`finishedAt` は最後の起動の終わりの時刻です。`environment`（実行の環境）は、最初の起動のものです。

## HTML レポート

`report.html` は、ブラウザで開く静的な HTML です。
`page.json` やスクリーンショットへの相対リンクを持つので、Run のディレクトリごと扱ってください。
レポートは、次の節からなります。

1. 要約: Run の状態、ページの網羅、指摘の件数、上限、サイトへの負荷、実行の記録、未完了の理由、実行の環境
2. 重大な指摘: 重大度がエラーの指摘（カテゴリを問いません）
3. カテゴリ別の指摘: ネットワーク、JavaScript、リンク、DOM、フォーム、レイアウト、アクセシビリティ、パフォーマンス、ページ間、安全
4. インタラクション: 操作の候補ごとの結果
5. 安全: 安全のために止めた操作と、安全の不変条件の違反（「[Safety Ledger の読み方](safety.md#safety-ledger-の読み方)」）
6. ページの一覧: ページごとの状態、ビューポートごとの状態、スクリーンショット

要約の「実行の記録」には、実行の回数と再開の回数（CLI の実行の行と同じ値）と、起動ごとの一覧を示します。一覧の各行は、何回目の実行か、開始の日時、終了の日時、終わり方です。終わり方は、日本語のラベル（例: 「実行時間の上限で停止」）、`run.json` の `endReason` のコード、説明で示します（コードの意味は「[中断と再開](resume.md#中断と再開)」の表を見てください）。

`mailto:` や `tel:` などの URL と、安全のために止めた操作の URL は、リンクにせず、文字として示します。

## Run Status の意味

Run Status は、監査を最後まで行えたかを表します。サイトの品質の良し悪しを表すものではありません。

- `COMPLETE`: 必要な確認を、すべて終えました。サイトに問題があるかどうかは、Finding で確かめます。
- `PARTIAL`: 一部の確認を終えられませんでした。たとえば、上限（ページの数、深さ、実行時間）に達した場合や、期限を過ぎた場合、Ctrl+C で止めた場合です。理由は、レポートの要約の「未完了の理由」と、`run.json` の `incompleteReasons` にあります。
- `FAILED`: 監査を実行できませんでした。たとえば、実行の前の確認（PREFLIGHT）に失敗した場合や、Run のディレクトリを作れなかった場合です。
- `ABORTED_BY_SAFETY`: 安全の不変条件の違反を記録しました。違反を記録した後は、新しいページ、次のビューポート、次の Interaction の候補を始めません。残りのページは、理由 `SAFETY_VIOLATION_ABORT` のスキップになります。結果のファイルは、止めたことを含めて書き出します。

## Finding と Evidence

- Evidence は、ブラウザで観測した事実の記録です（ネットワーク、コンソール、DOM、レイアウト、色、パフォーマンス、アクセシビリティ、スクリーンショットなど）。各ページの `page.json` にあります。
- Finding は、Rule が Evidence から判定した指摘です。重大度（エラー、警告、情報、安全）、カテゴリ、Rule の ID（`ruleId`）、文言を持ちます。
- Finding は、根拠の Evidence を `evidenceRefs` で参照します。HTML レポートの指摘の表からは、Evidence（`page.json` の中の場所）とスクリーンショットへたどれます。
- 件数は、サイト品質（エラー、警告、情報）と安全を、分けて数えます。

## 幅の走査の結果

レイアウトは、デスクトップとモバイルのビューポートのほかに、`viewports.stressWidths` の幅でも調べます（幅の走査）。
既定値では、デスクトップ（1440）とモバイル（390）の幅を除いた、320、768、1024 の3つの幅を調べます。

- 幅の走査は、ページごとに、デスクトップのビューポートの監査の中で1回だけ行います。
- 走査の結果は、デスクトップのレイアウトの Evidence の中（`stressSweep`）に記録します。
- 走査で見つかったはみ出し（例: `DOCUMENT_HORIZONTAL_OVERFLOW`）の Finding は、ビューポートがデスクトップとして記録されます。
- そのため、HTML レポートの指摘の表では、ビューポートの欄が「デスクトップ」になります。どの幅で見つかったかは、文言の先頭（例: 「レスポンシブの幅 320 px の確認で、…」）で分かります。

## ChatGPT 用のバンドル

`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`（例: `beaksight-audit-bundle_20260925023015.zip`）は、後段の意味監査のために、ChatGPT に手動でアップロードする ZIP です。

- 名前の日時は、その Run の最後の実行の終わりの時刻（`run.json` の `executions` の最後の `finishedAt`）です。どの時点の結果のバンドルかを、名前で見分けられます。
- 日時は UTC で、24 時間制です。書式は、Run の ID（`RUN-YYYYMMDDHHmmss`）と同じです。Run の ID は開始の時刻なので、バンドルの日時とは違います。
- 中断した Run を再開すると、終えたときに、再開した実行の終わりの時刻の名前で、バンドルを書き直します。前のバンドル（前の起動の日時の名前のものと、日時のない前の形の `beaksight-audit-bundle.zip`）は消します。Run のディレクトリには、最新のバンドルが1つだけ残ります。
- 消すのは、Run のディレクトリの直下にある、バンドルの名前の形のファイルだけです。リンクと、ほかのファイルには触れません。新しいバンドルを書けなかった場合は、前のバンドルを消しません。

バンドルは、次のファイルを含みます。

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

## パフォーマンスの値（RUM/APM）について

BeakSight のパフォーマンスの値は、監査の実行の中で、ブラウザがページを開いたときに測った、合成の計測（Synthetic）の値です。

- 実際の利用者の環境で測った値（RUM）ではありません。値は、実行した環境やネットワークに左右されます。
- APM の値でもありません。Navigation Timing、Resource Timing、`Server-Timing`、`traceparent` などは、ブラウザから見える範囲の記録です。サーバの内部の記録（データベースの処理の時間など）は含みません。
- パフォーマンスの Finding（例: `POOR_LCP`）の重大度は、警告です。
- 観測できなかった値は、0 などで埋めずに「未観測」と示します。
