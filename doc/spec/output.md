# 出力と結果の読み方

Run のディレクトリに書き出すファイルの構成と、HTML レポート、Run Status、Finding と Evidence、幅の走査の結果、ChatGPT 用のバンドル、パフォーマンスの値の読み方です。
承認された書き込みの報告（4 つの成果物）と、報告を配らない場合、監査済みデータの台帳の画面も、ここに書きます。
CLI の表示の読み方は「[CLI の表示](cli.md#cli-の表示)」にあります。

[README に戻る](../../README.md)・[仕様の索引](README.md)

## 出力の構成

`run` は、出力先のディレクトリの下に、Run ごとのディレクトリを作ります。
Run のディレクトリの名前は、Run の ID（`RUN-YYYYMMDDHHmmss`。開始の時刻の UTC）です。

```text
<出力先>/
  RUN-20260925010203/
    run.json                        Run の要約（Run Status、件数、Safety Ledger、実際に使った設定、起動の記録）
    audit.json                      全ページの結果（ページの Finding を含む）と、ページに属さない Finding
    report.html                     日本語の HTML レポート
    beaksight-audit-bundle_20260925023015.zip   ChatGPT 用のバンドル（名前の日時は、最後の実行の終わりの時刻の UTC。画面のジョブは、日時の前にプロファイルの名前が入る。「ChatGPT 用のバンドル」）
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

- JSON とテキストは、UTF-8（BOM なし）で、改行は LF です。JSON は字下げなしの 1 行で書き、末尾に LF を 1 つ付けます（2026-10-21 から。前は字下げ 2 文字。読むときは JSON として読めば、中身は同じです）。
- `audit.json` の最上位の `findings` は、どのページの結果にも入っていない Finding（ページ間の規則の Finding）だけです（2026-10-21 から）。ページの Finding は、`pages` の各ページの `findings` にあります。Run のすべての Finding は、ページの Finding（ページの順）と最上位の `findings` を、この順につないだものです。前の形の `audit.json` は、最上位の `findings` にすべての Finding を持ちます。
- JSON は、スキーマ（`schemas/`）で検証してから書きます。スキーマに合わない場合は、Run Status を `COMPLETE` にしません。
- `visible-text.txt` は、デスクトップの可視テキストから作ります。デスクトップにない場合はモバイルから作り、どちらにもない場合は書きません。
- ChatGPT 用のバンドルの名前は、CLI の `run` では `beaksight-audit-bundle_YYYYMMDDHHmmss.zip`、画面のジョブでは `beaksight-audit-bundle_<プロファイルの名前>_YYYYMMDDHHmmss.zip` です（2026-10-24 から）。日時は、その Run の最後の実行の終わりの時刻で、Run の ID と同じ書式（UTC、24 時間制）です。Run のディレクトリには、最新のバンドルが1つだけあります（「[ChatGPT 用のバンドル](#chatgpt-用のバンドル)」）。
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
- 出力先は、hard link を作れるファイルシステム（NTFS など）に置いてください。`run.lock` と出力先の開始のロックは hard link で作るので、FAT32・exFAT などの出力先では Run を始めません（「[同時に実行できる Run](resume.md#同時に実行できる-run)」）。

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
| `STOPPED_BY_AUTH_SESSION_LOST` | 認証つきの監査で、ログインの状態が切れたため止まりました（「ログインの切れで停止」。「[セッションが切れたら](authenticated-audit.md#7-セッションが切れたら)」）。 |
| `STOPPED_BY_SERVICE_REQUEST_LIMIT` | スクリプトで送るログインの監査で、承認したサービスの Origin への要求の上限に届いたため、残りのページを監査せずに止まりました（「API の要求の上限で停止」）。1 分あたりの上限で止まったときは、再開すると続きを監査します。Run の全体の上限（再開をまたぐ）に届いた後は、再開してもすぐに止まります（「[スクリプトで送るログインの後の監査](authenticated-audit.md#スクリプトで送るログインの後の監査)」）。 |

- `run.json` の `startedAt` は最初の起動の開始、`finishedAt` は最後の起動の終わりの時刻です。`environment`（実行の環境）は、最初の起動のものです。

### スクリプトで送るログインの監査の記録

「スクリプトで送るログイン」の設定のプロファイルの監査の Run だけが、`run.json` に次の項目を持ちます（「[スクリプトで送るログインの後の監査](authenticated-audit.md#スクリプトで送るログインの後の監査)」）。公開の監査と、フォームの送信のログインの監査の出力は変わりません。

| 項目 | 中身 |
| --- | --- |
| `load.approvedServiceOrigins` | 承認したサービスの Origin への要求の数（`count`）と、1 分あたりの最大（`peakPerMinute`）。 |
| `authentication.registeredReadRequestsAllowed` | 通した、登録した読み取りの手続きの呼び出しの数。 |
| `authentication.tokenRefreshBlocked` | 止めた token の更新の数。 |
| `authentication.otherNonReadBlocked` | 止めた、ほかの読み取りでない要求の数（Safety Ledger にもあります）。 |
| `authentication.serviceUnauthorizedResponses` | 承認したサービスの Origin から返った 401 の応答の数。 |
| `authentication.serviceRequestLimitReached` | 承認したサービスの Origin への要求の上限に届いたか。 |
| `authentication.serviceRequestPacingWaits` | 承認したサービスの Origin への要求の 1 分あたりの上限で、次の読み込みの前に待った回数（任意）。前の書き手の成果物にはありません。再開のための保存（checkpoint）にも残ります。 |
| `authentication.serviceRequestPacingWaitMs` | その待ちの時間の合計（ミリ秒。任意）。間隔のための待ち（`load.pacingWaitMs`）には入りません。 |
| `authentication.allowedOriginDataRequestsBlocked` | 止めた、許可 Origin への fetch・XHR の読み取りでない要求の数（任意）。記録だけで、描けなかった画面の判定には使いません（「[描けなかった画面](discovery-and-read-check.md#描けなかった画面)」）。前の書き手の成果物にはありません。再開のための保存（checkpoint）にも残ります。 |

- 数だけを持ちます。URL や値は持ちません。数は、再開をまたいで積み上げます。
- 成果物（`page.json`・`run.json`・`report.html`・ChatGPT 用のバンドルの中身）の、承認したサービスの Origin の URL は、query の名前を残して値をすべて `[REDACTED]` に伏せ、path の値に見える区切りも伏せます（例: `grant_type=[REDACTED]`）。fragment の値、文の中で前置き（`url=` など）の後やほかの URL の中に入った URL、サービスのホストへの `ws://`・`wss://` の URL も伏せます。
- 未完了の理由に `SERVICE_REQUEST_LIMIT_REACHED` があります（上限で止めた要求が 1 つでもあれば残ります。Run は `PARTIAL`）。ページのスキップの理由にもあります（上限に届いた後に始めなかったページ）。安全の記録の止めた要求（`blockedRequests`）の理由には、`SERVICE_REQUEST_LIMIT_REACHED`（上限を超えて止めた要求）と `SERVICE_ORIGIN_REVISIT`（送信の扱いが `READ_ONLY` の幅の走査と、Interaction の読み込みで、承認したサービスの Origin へ送ろうとして止めた要求。`PASS_EXCEPT_DELETE` の幅の走査では送るので、この理由は残りません）があります。
- 限界: 負荷の数は、本文を読まない応答（401 など）を数えないことがあり、少なく出ることがあります（上限の数えは送る前に行うので、上限には影響しない見込み。推測）。

## 発見と READ の確かめの成果物

管理画面の操作の候補の発見と READ の確かめのジョブは、Run のディレクトリに `discovery.json` と `read-evidence.json` を書きます（「[操作の候補の発見と READ の確かめ](discovery-and-read-check.md)」）。

| 成果物 | 版 | この版で足した項目 |
| --- | --- | --- |
| `discovery.json` | `1.1` | 任意の `authentication`（スクリプトで送るログインのジョブの数。`run.json` の `authentication` と同じ形）、任意の `endReasonDetail`（終わり方の詳しい印。例 `session-key`）、候補の任意の `submissionProbe`（送らずに観察した型と分類）。 |
| `read-evidence.json` | `1.2` | 任意の `authentication`・`endReasonDetail`、定義の対象の種類（候補を読む・画面を読む）と画面の path。 |

- 版を変えずに足した任意の項目: `discovery.json` の読んだ画面ごとの `documentRequests`・`childFrameDocumentRequests` と、`read-evidence.json` の実行した定義ごとの `documentRequests`・`childFrameDocumentRequests`（DEF-129。下の「[ページの文書の要求の数](#ページの文書の要求の数)」）、両方の `authentication.allowedOriginDataRequestsBlocked`（`run.json` の `authentication` と同じ形）。前の書き手の成果物にはありません。
- 書くのは新しい版で、読み手（管理画面）も新しい版だけを受けます（2026-10-24 から）。前の版（`discovery.json` の `1.0`、`read-evidence.json` の `1.0`・`1.1`）の文書は、読めないものとして扱います（画面の候補の詳細、READ の確かめの対象の画面、シナリオの候補の探しに使いません。READ の確かめの対象の画面は「分からない」になります）。もう一度発見すると、新しい版の文書ができます。
- ジョブの結果を親に送るときの要約（数）は、成果物の `authentication` と照らし合わせます。ジョブの詳細の欄「ログインの後の読み取りの数」は、確かめた成果物から数を読みます。

## 入口の確かめの成果物

入口の確かめのジョブ（「[入口の確かめ](authenticated-audit.md#入口の確かめ)」）は、Run のディレクトリに `entry-check.json` を書きます。

- 中身: 終わり方、移った先（許可 Origin の中なら path、外なら Origin だけ）、ログインの画面に見えるか、3 つの欄の見える候補の数と一意な CSS、3 つの要素の置き方、form の method と action、認証の設定の案。
- 欄の値は読まず、書きません。URL は伏せる部品を通します。
- 管理画面は、この成果物を正として結果を出し、認証の設定の案に使います。

## ページの文書の要求の数

ページ自身の読み込み直しの上限（「[ページ自身の読み込み直しの上限](site-load.md#ページ自身の読み込み直しの上限)」）のために、Guard が送った文書の要求の数を、成果物に残します（DEF-129）。`documentRequests` は画面（main frame）の数で、BeakSight 自身の読み込み、サーバの転送の続き、ページが始めた読み込みの和です。`childFrameDocumentRequests` は、iframe などの子の frame の文書の要求の数（別の数）です。止めた読み込みは入りません。

| 成果物 | 項目 |
| --- | --- |
| `page.json` | ビューポートごと（`viewports.desktop`・`viewports.mobile`）の `documentRequests` と `childFrameDocumentRequests`。読み込まなかったビューポートにはありません。 |
| `discovery.json` | 読んだ画面ごとの `documentRequests` と `childFrameDocumentRequests`。 |
| `read-evidence.json` | 実行した定義ごとの `documentRequests` と `childFrameDocumentRequests`（READ の URL の読み込み）。 |
| `entry-check.json` | `documentRequests` と `childFrameDocumentRequests`。 |

- どれも任意の項目です。前の書き手の成果物にはありません。
- 上限を超えて止めた読み込みは、安全の記録の止めた要求（理由 `PAGE_NAVIGATION_LIMIT_REACHED`）に残ります。監査では、そのビューポートの未完了の理由にも `PAGE_NAVIGATION_LIMIT_REACHED` が入ります。

## HTML レポート

`report.html` は、ブラウザで開く静的な HTML です。
`page.json` やスクリーンショットへの相対リンクを持つので、Run のディレクトリごと扱ってください。
レポートは、次の節からなります。

1. 要約: Run の状態、ページの網羅、指摘の件数、上限、サイトへの負荷、実行の記録、未完了の理由、実行の環境
2. 重大な指摘: 重大度がエラーの指摘（カテゴリを問いません）の一覧。各行は、カテゴリ別の指摘の表のその指摘の行へのリンクと文言です（2026-10-21 から。表をもう一度出しません）
3. カテゴリ別の指摘: ネットワーク、JavaScript、リンク、DOM、フォーム、レイアウト、アクセシビリティ、パフォーマンス、ページ間、安全
4. インタラクション: 操作の候補ごとの結果
5. 安全: 安全のために止めた操作と、安全の不変条件の違反（「[Safety Ledger の読み方](safety.md#safety-ledger-の読み方)」）。節の中の「Safety の事象の一覧」は、止めた要求（`blockedRequests`）の行の理由の欄に、理由のコードの後に理由の説明を添えます（止め方が理由ごとに違うため。離れた後の上限は GET も止めます。Task 44 の T44R2 の M-7）
6. ページの一覧: ページごとの状態、ビューポートごとの状態、スクリーンショット

要約の「指摘の件数」には、サイト品質の指摘を、BeakSight が止めた要求との関係で分けた件数（「遮断が原因」「遮断の影響の可能性」「遮断と結び付かない」）と、ChatGPT 用のバンドルの本体（`findings.json`）に入る指摘の件数も示します（2026-10-23 から）。区分の決め方は「[BeakSight の遮断と指摘の関係](#beaksight-の遮断と指摘の関係)」にあります。カテゴリ別の指摘の表では、「遮断が原因」と「遮断の影響の可能性」の指摘の内容の欄に、区分の印と理由を添えます（結び付かない指摘には付けません）。安全の指摘のうち、閉じる途中とページを離れた後に止めた事象を数えたものには、「閉じる途中に止めた」の印と事象の件数を添えます（測りの後のもの）。

CLI の結果の行には、遮断が原因の指摘と遮断の影響の可能性の指摘が 1 件以上あるときだけ、その件数の 1 行（「BeakSight の遮断と結び付く指摘: …（ChatGPT 用バンドルの本体から外しました）」）を、指摘の件数の行の次に出します。

要約の「実行の記録」には、実行の回数と再開の回数（CLI の実行の行と同じ値）と、起動ごとの一覧を示します。一覧の各行は、何回目の実行か、開始の日時、終了の日時、終わり方です。終わり方は、日本語のラベル（例: 「実行時間の上限で停止」）、`run.json` の `endReason` のコード、説明で示します（コードの意味は「[中断と再開](resume.md#中断と再開)」の表を見てください）。

`mailto:` や `tel:` などの URL と、安全のために止めた操作の URL は、リンクにせず、文字として示します。

## Run Status の意味

Run Status は、監査を最後まで行えたかを表します。サイトの品質の良し悪しを表すものではありません。

- `COMPLETE`: 必要な確認を、すべて終えました。サイトに問題があるかどうかは、Finding で確かめます。
- `PARTIAL`: 一部の確認を終えられませんでした。たとえば、上限（ページの数、深さ、実行時間）に達した場合や、期限を過ぎた場合、Ctrl+C で止めた場合です。理由は、レポートの要約の「未完了の理由」と、`run.json` の `incompleteReasons` にあります。ページごとの理由は、レポートのページの欄にあります。理由ごとのページ数は、`run.json` の `pageIncompleteReasonCounts`（理由を持つページがあるときだけ。上限で監査しなかったページは数えません）と、監査のジョブの画面の「確かめきれなかったページの理由」にあります。どの理由にも、説明の後に次にできること（例: 内側のスクロールの領域を確かめきれなかった `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` → その領域を手で確かめる。想定していない失敗 `UNHANDLED_FAILURE` → もう一度監査し、続けて起きるときは詳しい内容を添えて知らせる）を出します（Task 44 の T44h の判断 (1)）。レポートの文は CLI でも作るので、画面の操作の名前は書きません。
- `FAILED`: 監査を実行できませんでした。たとえば、実行の前の確認（PREFLIGHT）に失敗した場合や、Run のディレクトリを作れなかった場合です。外部のアプリを開かせない Chromium の設定が効かなかった場合も、実行の前の確認の失敗です（理由の詳細 `EXTERNAL_LAUNCH_BLOCK`。「[安全](safety.md#headed-で実行するときの注意)」）。
- `ABORTED_BY_SAFETY`: 安全の不変条件の違反を記録しました。違反を記録した後は、新しいページ、次のビューポート、次の Interaction の候補を始めません。残りのページは、理由 `SAFETY_VIOLATION_ABORT` のスキップになります。結果のファイルは、止めたことを含めて書き出します。

## Finding と Evidence

- Evidence は、ブラウザで観測した事実の記録です（ネットワーク、コンソール、DOM、レイアウト、色、パフォーマンス、アクセシビリティ、スクリーンショットなど）。各ページの `page.json` にあります。
- Finding は、Rule が Evidence から判定した指摘です。重大度（エラー、警告、情報、安全）、カテゴリ、Rule の ID（`ruleId`）、文言を持ちます。
- Finding は、根拠の Evidence を `evidenceRefs` で参照します。HTML レポートの指摘の表からは、Evidence（`page.json` の中の場所）とスクリーンショットへたどれます。
- 件数は、サイト品質（エラー、警告、情報）と安全を、分けて数えます。
- `page.json` の版は `page-schema/1.1` です（2026-10-23 から）。安全の記録と network の記録に、BeakSight が止めた要求を見分ける印（止めた時点、要求の種類、閉じる途中に止めた要求、network の失敗の印、読み込みの種類）が付きます。前の版 `page-schema/1.0` は、2026-10-24 から読みません（それを持つ再開の保存は、新しい Run として始め直します）。読み方は「[止めた時点と読み込みの印](safety.md#止めた時点と読み込みの印)」にあります。

## 成果物の URL の伏せ字

公開の監査と認証つきの Run は、同じ決まりで、成果物（`page.json`・`audit.json`・`run.json`・`report.html`・ChatGPT 用のバンドルの中身・再開のための保存・診断の記録）に書く前に URL を伏せます（Task 44 の P4-1）。伏せるのは、書く前の 1 か所（成果物の書き手）だけです。判定（リンクの確かめ、リダイレクトの連鎖、Finding の identity）は、伏せる前の値で行います。

- 記録した要求の URL: network の Evidence の要求・応答・失敗、パフォーマンスの Evidence の資源（resource timing）と server timing（`serverTiming`）、計測の header と候補（`telemetryHeaders`・`telemetryCandidates`）、安全の記録の止めた要求・ナビゲーション・WebSocket・ポップアップ・ダウンロード・外部への作用・監査の段の除外・閉じる途中に止めた要求（`blockedClosingRequests`）の URL は、query の名前を残して値をすべて `[REDACTED]` に伏せます。path の値に見える区切り、fragment の値、userinfo も伏せます（例: `/api/data?marker=[REDACTED]&page=[REDACTED]`）。
- 同じ値を持つ項目（T44R の C-1）: 画像の記録の `src`・`resolvedUrl`、console の記録の位置の URL（`location.url`）、ページの誤りの `stack` の中の URL、header の `location`・`content-location`・`refresh` も、同じ決まりで伏せます。さらに、記録した要求の URL（と、その path と query の形）と同じ値は、ほかのどの文字列の中でも（Finding の本文と identity を含む）、同じ決まりで伏せた値に替えます。
- それ以外の文字列の中の URL: 秘密に見える名前（`token`・`access_token`・`code` など）の query の値と、userinfo を伏せます。
- 限界（秘密に見える名前でない query の値が残る項目）: ページの identity の URL と、それと同じ URL を含む Finding の本文と identity（例: HTTP の状態の Finding。ページの identity を変えないため）、リンクの URL と canonical などの DOM の Evidence の属性、記録した要求にない URL を含む文（console の本文、アクセシビリティの HTML の断片など）、再開の保存の状態（`checkpoint/state.json` の巡回の URL。値で照らす段を行わない）。ページの identity は、ページの URL（`pageUrl`・要求した URL・最終の URL）と設定の開始の URL（`startUrl`）と、許して読み込んだ main frame の文書の要求（応答のあるもの）とそのリダイレクトの連鎖です（T44R3・T44R4）。止めた main frame の要求（例: form の POST の送信）は identity でないので、その URL は Finding の本文と navigation timing（止めた後の誤りの文書の URL）でも伏せます。止めた記録の URL は、ページの URL に等しいときだけ残ります。再開の保存のページ（`checkpoint/pages/`）は、巡回が知っている URL（待ち行列と、監査したページの URL）も identity として残します（続けて終えた Run と同じ結果にするため）。そのため、待ち行列にあっても最後まで監査しなかった URL と同じ値は、再開した Run だけで残り、あとで監査するページのリダイレクトの後の最終の URL と同じ値は、再開した Run だけで伏せられます。また、あるページの要求の URL と同じ値が、それより前に保存したページの文やリンクに出る場合、続けて終えた Run では伏せますが、再開した Run では残ります（保存のページは、書いた時点の値の木で伏せ、伏せる前の値は保存しないため。T44R5 の m-3。揃えません）。
- 値で照らす段の形の限界: 文の中の字句（空白・引用符・`<`・`>`・backtick で区切ったもの）が、記録した要求の URL か、その path と query の形か、それらの `&` を `&amp;` にした形に、まるごと等しいときだけ替えます（T44R2）。記録した要求の URL は ASCII の形なので、字句の中の ASCII の連なり（非 ASCII の字で区切ったもの。例: Finding の文の「（例: POST URL）。」）も照らします。連なりの先頭の `(`・`url(` と、末尾の閉じ括弧・`,`・`.`・stack の行と列（`:1:15`）を外した形と、CSS の `url(…)` の中身も照らします（T44R3）。ただし、連なり（か、先頭を外した形）がページの identity の形か、外す途中で identity の形になるもの（例: ページの URL が `…?id=1.` のときの `(…?id=1.)`）は、外して引く形で替えません（T44R4。ページの URL が書き換わり、再開が壊れないため）。そのため、形を変えた写し（percent-encode を解いた形、空白の `+`、別の形の相対の URL、query の値だけ、JSON の `\/`、数値の文字参照 `&#38;`、scheme や host や path を大文字にした形など）と、ほかの ASCII の字と続けて書かれた URL（例: `x=URL`）は残ります。逆に、非 ASCII の字が続く IRI の形（例: `?q=1日本`）は、前の ASCII の部分が記録した要求の URL に等しければ、その部分を伏せます（多く伏せる向き）。公開の監査のページの URL は、巡回の正規化で、許した名前（`crawl.allowedQueryParameters`）のほかの query を落とします。
- 通した要求（`passedAuditSendRequests`）は、もともと method・Origin・path（値に見える区切りは伏せる）だけを記録します。
- セッションの切れの URL（ジョブの記録とワーカーの知らせの `sessionLostUrl`）は、記録した要求の URL と同じ決まりで、query の値をすべて伏せます。

## 幅の走査の結果

レイアウトは、デスクトップとモバイルのビューポートのほかに、`viewports.stressWidths` の幅でも調べます（幅の走査）。
既定値では、デスクトップ（1440）とモバイル（390）の幅を除いた、320、768、1024 の3つの幅を調べます。

- 幅の走査は、ページごとに、デスクトップのビューポートの監査の中で1回だけ行います。
- 各幅の読み込みの後、デスクトップとモバイルの最初の読み込みと同じく、画面が落ち着く（文書の高さが 500 ms 変わらない。上限は `crawl.resourceSettlingTimeoutMs`）まで待ってから、形を測ります（2026-10-22 から。読み込みの後にデータを読んで描く画面の形も見るため）。待つだけで、読み込みの間隔と回数は変わりません。上限までに落ち着かなくても、そのまま測ります。
- 走査の結果は、デスクトップのレイアウトの Evidence の中（`stressSweep`）に記録します。
- 走査で見つかったはみ出し（例: `DOCUMENT_HORIZONTAL_OVERFLOW`）の Finding は、ビューポートがデスクトップとして記録されます。
- そのため、HTML レポートの指摘の表では、ビューポートの欄が「デスクトップ」になります。どの幅で見つかったかは、文言の先頭（例: 「レスポンシブの幅 320 px の確認で、…」）で分かります。

## ChatGPT 用のバンドル

`beaksight-audit-bundle_YYYYMMDDHHmmss.zip`（例: `beaksight-audit-bundle_20260925023015.zip`）は、後段の意味監査のために、ChatGPT に手動でアップロードする ZIP です。画面のジョブのバンドルは、名前にプロファイルの名前が入り、`beaksight-audit-bundle_<プロファイルの名前>_YYYYMMDDHHmmss.zip`（例: `beaksight-audit-bundle_example-public_20260925023015.zip`）です（2026-10-24 から）。

- 名前の日時は、その Run の最後の実行の終わりの時刻（`run.json` の `executions` の最後の `finishedAt`）です。どの時点の結果のバンドルかを、名前で見分けられます。
- 日時は UTC で、24 時間制です。書式は、Run の ID（`RUN-YYYYMMDDHHmmss`）と同じです。Run の ID は開始の時刻なので、バンドルの日時とは違います。
- プロファイルの名前は、画面の「名前（profileId）」をそのまま使います。どのプロファイルの結果のバンドルかを、名前で見分けられます。名前はファイルの名前だけに使い、バンドルの中身、`run.json`、`audit.json`、`report.html` には入れません。CLI の `run`（プロファイルのない実行）は、名前の部分のない形のままです。
- ファイルの名前に使えない値にならないよう、プロファイルの名前は、次のように整えてから使います。日本語などの文字は、そのまま使います。
  - Windows で使えない文字（`<`、`>`、`:`、`"`、`/`、`\`、`|`、`?`、`*`）と、制御文字と、行と段落の区切りの文字は、`_` にします。表示の向きを変える文字と、対のないサロゲートは除きます。
  - 前後の空白と、末尾の `.` を外します。
  - 長さは 64 文字（コードポイントの数）までにします。超えた分は切ります。
  - Windows の予約の名前（`CON`、`NUL`、`COM1` など。拡張子つきも）は、前に `_` を付けます（例: `_CON`）。
  - 整えた後に名前が空になる場合は、名前の部分を省き、`beaksight-audit-bundle_YYYYMMDDHHmmss.zip` にします。
- 名前の部分に `_` があっても、日時は名前の末尾の 14 桁で読むので、取り違えません。
- 中断した Run を再開すると、終えたときに、再開した実行の終わりの時刻の名前で、バンドルを書き直します。前のバンドル（前の起動の日時の名前のもの、ほかのプロファイルの名前や名前の部分のない形のもの）は消します。Run のディレクトリには、最新のバンドルが1つだけ残ります。
- 日時のない前の形の名前（`beaksight-audit-bundle.zip`。古い版が書いたもの）は、バンドルとして扱いません。画面からは配らず、再開しても消しません（ファイルはそのまま残ります）。
- 消すのは、Run のディレクトリの直下にある、バンドルの名前の形のファイルだけです。リンクと、ほかのファイルには触れません。新しいバンドルを書けなかった場合は、前のバンドルを消しません。
- 画面のジョブの詳細から落とすときは、この名前のまま保存されます。名前に日本語などの ASCII の外の文字がある場合は、`Content-Disposition` の `filename*`（UTF-8）で名前を渡し、`filename` には、ASCII の外の文字を `_` にした代わりの名前を置きます。

バンドルは、次のファイルを、この順に含みます（`manifest.json` の `bundleSchemaVersion` は `chatgpt-bundle/1.2`。2026-10-23 から。前の版は `chatgpt-bundle/1.1`）。

- `manifest.json`: 中のファイルの一覧（大きさと SHA-256）と、入れられなかったファイル（`omittedFiles`）
- `README.md`: 読み方の案内（日本語の Markdown。2026-10-22 から）。読む順、各ファイルの意味、本体の指摘と外した指摘（本体の意味、外した件数と区分、`page.json` の中の BeakSight の遮断の記録、閉じる途中の遮断）、category の別の件数の表（本体と外した指摘を合わせた全部の件数。「指摘の件数」の行も同じ）、本体の指摘の Rule の別の件数の表、Run の状態とページの網羅、安全の区分の指摘の読み方を書きます。URL・対象の ID・開始の URL・指摘の文は書きません
- `run.json`: 書き出した `run.json` そのもの
- `summary.json`: 要約。重大度・区分の別の件数に加えて、category の別の件数（`findingCountsByCategory`。0 件の category も含む）と、Rule の別の件数（`findingCountsByRule`。件数の多い順）を含みます。これらは、外した指摘も含む全部の件数です。本体の指摘と外した指摘の件数は `beaksightBlockRelation` にあります（`byRelation`: サイト品質の指摘の区分の別の件数、`linkedFindingCount`: 遮断と結び付く指摘の件数、`mainFindingCounts`: 本体の件数、`excludedFindingCounts`: 外した件数。2026-10-23 から）
- `findings-by-rule.json`: Rule ごとの要約（2026-10-22 から）。本体の指摘の要約（`main`）と、外した指摘の要約（`excluded`）に分けてあります（2026-10-23 から）。Rule ごとに、件数、重大度の別の件数、出たページの数、ビューポートの別の件数、区分の別の件数（`byBlockRelation`）と、例を 3 件まで（ページの違うものが先）含みます。重大度の重い順、件数の多い順に並びます
- `findings.json`: 本体の指摘。BeakSight が止めた要求と結び付かない、サイト品質の指摘（区分 `NONE`）だけです（2026-10-23 から。サイトの欠陥の候補）
- `beaksight-related-findings.json`: 本体から外した指摘（2026-10-23 から）。遮断が原因の指摘（`CAUSED`）、遮断の影響の可能性がある指摘（`POSSIBLE`）、安全の区分の指摘です。指摘ごとに、BeakSight の遮断との関係（`beaksightBlockRelation`。区分 `relation`・理由 `reason`・結び付いた遮断の参照 `blocks`（5 件まで）・遮断の数 `blockCount`。安全の区分の指摘は `null`）と、安全の区分の指摘の止めた事象の時点の別の件数（`safetyBlockPhaseCounts`。`CLOSING` は閉じる途中とページを離れた後）を持ちます
- `pages.json`、`evidence-index.json`: ページと Evidence の索引。`pages.json` の `findingIds` は本体の指摘の ID、`excludedFindingIds` は外した指摘の ID です（2026-10-23 から）。ページごとの本体と外した指摘の件数（`mainFindingCounts`・`excludedFindingCounts`）もあります
- `pages/<pageId>/page.json`: 各ページの結果（一次の Evidence）
- 指摘に関係する、表示範囲のスクリーンショット（`viewport.png`。合計 64 MiB まで。超えた分は `omittedFiles` に書きます）。ページ全体のスクリーンショット（`full-page.png`）は、バンドルの大きさを抑えるため入れません（2026-10-21 から。Run のディレクトリには残ります。`findings.json` の `screenshotPaths` も、入れたものだけです）

読む順は、`summary.json` → `findings-by-rule.json` → `findings.json` → `beaksight-related-findings.json` → `pages.json` → `evidence-index.json`・`page.json`・スクリーンショットです。`findings.json` には、同じ Rule の指摘がページごとに繰り返し並ぶので、全体の傾向は `findings-by-rule.json` の `main` で見てください。

`page.json` の network の失敗のうち `ERR_BLOCKED_BY_CLIENT` のもの（`blockedByBeakSight` が真）と、console の「Failed to load resource」の文のうち `ERR_BLOCKED_BY_CLIENT` を含むものは、BeakSight が止めた要求の記録です。閉じる途中とページを離れた後に止めた要求（時点 `phase` が `CLOSING` の記録と、`blockedClosingRequests`）は、測りの後のものです。影響の可能性の元には使いません（遮断が原因の参照には入りえます。下の節）。

### BeakSight の遮断と指摘の関係

サイト品質の指摘は、BeakSight が止めた要求との関係で、次の 3 つに分けます（2026-10-23 から。安全の区分の指摘は、この区分の外です）。区分は、表示用モデルの 1 か所で決め、HTML レポート・CLI・バンドルは同じ値を描きます。

| 区分 | 意味 | 主な理由（`reason`） |
| --- | --- | --- |
| `CAUSED`（遮断が原因） | 指摘の対象の要求か、行き先の移動か、測った画面そのものを、BeakSight の遮断が決めた | `TARGET_REQUEST_BLOCKED`（読み込みに失敗した script・stylesheet・画像の URL を止めた）、`TARGET_NAVIGATION_BLOCKED`（行き先のページの移動の失敗が BeakSight の遮断）、`MAIN_FRAME_NAVIGATION_BLOCKED`（main frame の移動（ページ自身が始めた移動を含む）を止め、指摘の Evidence が測ったのは止めた後のエラーの画面だと、記録から分かる） |
| `POSSIBLE`（遮断の影響の可能性） | 同じ読み込みで、その Rule の結果を変えうる種類の要求を止めた | `SENSITIVE_KIND_BLOCKED`、`MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED`（main frame の移動を止めたが、測ったのがエラーの画面かは記録から分からない）、`TARGET_REQUEST_PARTLY_BLOCKED`（対象の失敗の一部だけが遮断）、`FETCH_FAILED_WITH_DATA_BLOCK`（`TypeError: Failed to fetch` で、同じ読み込みでデータの要求を止めた）、`DISABLED_FEATURE`（BeakSight が無効にした SharedWorker を `new window.SharedWorker(...)` で呼んだ例外） |
| `NONE`（遮断と結び付かない） | 上のどちらでもない | `NO_BLOCK_IN_LOAD`（結び付く読み込みで止めていない）、`RULE_NOT_SENSITIVE`（止めたが、その Rule の結果を変えうる種類ではない） |

- 結び付ける読み込みは、指摘が参照する Evidence のページとビューポートの、ページの監査の読み込みです。幅の走査の指摘（文の先頭が「レスポンシブの幅 … の確認で」）は、その幅の読み込みです。操作の確かめ（Interaction）の読み込みと、再試行の前の試行の記録は使いません。
- 影響の可能性の元にするのは、読み込みの間（時点 `LOAD`。Context を閉じ始める前で、測りの後に止めたものも含む）に止めた、ページの JS と測りから見える種類（script・stylesheet・font・image・データの要求（fetch・xhr）・文書・WebSocket）の要求だけです。`sendBeacon` と `<a ping>`（`ping`）、先読み（`<link rel=prefetch>` など。今の画面の描画に効かない。安全の記録の先読みの印 `speculative` か、要求の種類 `prefetch`）と、閉じる途中とページを離れた後に止めた要求は使いません。記録には止めた時刻がないので、読み込みの間の遮断が測りの前か後かは見分けません。
- 読み込みの間に main frame の移動を止めた記録（`blockedNavigations`、監査の段の除外の `mainFrameNavigation`、network の main frame の文書の要求の BeakSight の遮断）があるビューポートでは、測った画面で結果が変わりうる Rule の指摘を、次のとおりに分けます。そのビューポートの題などを使うページ間の Rule の指摘も同じです。main frame の文書の応答の状態など、測った画面によらない Rule は除きます。
  - 指摘の Evidence が、止めた後の Chromium のエラーの画面を測ったと記録から分かるときは、遮断が原因（`MAIN_FRAME_NAVIGATION_BLOCKED`）。分かるのは、パフォーマンスの Evidence の navigation timing の URL（測った時点の文書の読み込みの URL）が止めた移動の行き先と等しく、指摘の Evidence がそのパフォーマンスの Evidence と同じか後に記録されたものであるときです（エラーの画面から元の画面には戻らないため）。
  - 分からないときは、影響の可能性（`MAIN_FRAME_NAVIGATION_BLOCKED_UNCONFIRMED`）にとどめます。移動を止めたのが測った後のこともある（例: 読み込みの 1.5 秒後にページが自分で移動する画面で、DOM は元の画面を測っている）ためです。DOM・レイアウト・色・axe の Evidence はパフォーマンスの Evidence より先に記録するので、これらだけを参照する指摘は、エラーの画面を測っていても影響の可能性になります（測った文書の URL を持たないため。限界）。
- 閉じる途中とページを離れた後の遮断は、遮断が原因の参照には入りえます（指摘の対象の要求そのものを閉じる途中に止めた場合）。ただし、対象の URL に読み込みの最中の本当の失敗（BeakSight でない失敗か、DOM の画像の失敗）があるときは、閉じる途中の遮断を照らしません。
- 同じ要求の安全の記録（Guard の記録）と network の記録は、読み込み・時点・method・URL で 1 つにします。Guard の記録の要求の種類はページから見た種類とずれることがある（ページの fetch が `xhr`、`<link rel=prefetch>` が `fetch`、Worker の script が `other`）ので、種類は補助にします。種類が定まらないか合わないとき（参照の `requestKind` が `UNCERTAIN`）は、結果が変わりうる種類を持つ Rule では「影響の可能性」の側に倒します。
- Rule ごとの「結果が変わりうる種類」は、Rule の定義の表（`src/audit/rule-block-sensitivity.ts`）が持ちます（2026-10-23 の見直し）。
  - 欠けの指摘（題・本文・lang・canonical の欠け、ページ間の題と canonical、axe の欠けの Rule（`A11Y_DOCUMENT_TITLE`・`A11Y_HTML_HAS_LANG`・`A11Y_LANDMARK_ONE_MAIN`・`A11Y_PAGE_HAS_HEADING_ONE`・`A11Y_BYPASS`））と例外（`PAGE_ERROR`）は、script とデータ（fetch・xhr。読み取りでも読み取りでない送信でも）の遮断で変わりうるとします。同じ欠けが、Rule によって別の区分に分かれないようにするためです。
  - 表示された要素の欠陥（レイアウトの Rule、色のコントラスト、ほかの axe の Rule（`A11Y_*`）、重なった id、label のない必須の欄、action のない form、画像の読み込みの失敗）は、表示された部分の本当の欠陥とします。データの遮断では変わらず、script・stylesheet・font・image・子の文書（iframe）の遮断のときだけ変わりうるとします。
  - サーバが返した応答の事実（main frame の HTTP の状態、資源の応答の 4xx・5xx（`RESOURCE_4XX`・`5XX`））と移動の期限は、変わらないとします。パフォーマンスの Rule は描画の種類で変わりうる（main frame の応答の時間 TTFB は変わらない）とします。
- 限界: 読み込みの失敗の指摘の対象の URL は、指摘の文の中の URL と、記録の URL（どちらも伏せた後の値）を照らして見つけます。

- JSON の中の、状態、理由、重大度などの値は、英数字のコードのままです。表示用の日本語のラベルは入れません（日本語のラベルは `README.md` にだけ書きます）。
- Finding の文言（日本語）は、`findings.json` と、`findings-by-rule.json` の例に、そのまま入ります。
- ページの HTML などの、生の応答の本文は含めません。
- ただし、各ページの `page.json` には、ページの可視テキストと URL が入ります。

アップロードする前に、バンドルの中身が、ChatGPT に渡してよい内容かを確かめてください（「[成果物を外へ渡す前の確かめ](anonymization.md)」）。認証つきの監査のバンドルには、管理画面の可視テキストとスクリーンショットが入ります。

## 書き込みの報告

承認された登録（CREATE）と更新（UPDATE）のジョブ（「[承認された登録の手順](approved-create.md)」「[承認された更新の手順](approved-update.md)」）は、Run のディレクトリに、次のファイルを書きます。書くのは監査のワーカーで、Run の終わり（結果の判定と照合の READ の後）に書きます。

```text
<出力先>/
  RUN-20261015010203/
    action-run.json                          書き込みの記録（結果、送った値、応答、登録の ID、照合の READ の結果、予約の締めの判定、送らずに止めた具体的な理由 precheckDetail（任意））
    action-evidence.json                     書き込みの証拠（下の表）
    approval-summary.json                    承認の要約（下の表）
    action-report.html                       日本語の HTML の報告
    beaksight-action-bundle_20261015010530.zip   書き込みのバンドル（名前の日時は、action-run.json の終わりの時刻の UTC）
```

- JSON は、スキーマ（`schemas/action-run.schema.json`、`schemas/action-evidence.schema.json`、`schemas/approval-summary.schema.json`）で検証してから書きます。URL は伏せ字を通します。
- 報告を書くのは、ワーカーが Run の終わりまで進んだ回すべてです（照合済み、照合できていない、結果が分からない、登録されなかった、送らずに止めた）。送らずに止めた回は、止めた理由と送る前の確かめの結果を書き、送った値・応答・照合の READ は空にします。
- ワーカーが途中で異常終了した回は、報告のファイルがありません。結果は画面の書き込みの結果だけで示します。

| ファイル | 中身 |
| --- | --- |
| `action-evidence.json`（`action-evidence-schema/1.1`） | ジョブ・Run・プロファイル・シナリオと版、種類（登録か更新か）、人が入れた値が入りうるか（`containsHumanEnteredValues`）、送る前の確かめ（承認した候補の digest と同じだったか、止めた理由）、送信（状態、送った欄の名前と値、送信先の path、送った日時）、応答（HTTP の状態、判定、判定した日時）、登録の ID、更新の対象のレコードと欄ごとの前後の値と照合（更新だけ）、照合の READ の証拠（読んだ URL、期待ごとの結果と読んだ値）、Guard の数の要約（止めた要求の数を理由ごと、送信の窓が開いていたか、応答を画面に返せなかったか）、結果と理由、日時。 |
| `approval-summary.json`（`approval-summary-schema/1.0`） | シナリオの ID・版・種類、承認の記録（記録の ID、承認の digest、縛った事実、承認した日時、期限、承認者 `LOCAL_OPERATOR`）、開始の時点で撤回されていたか、入力の規則の参照、件数の上限、承認の期限の日数、副作用の確認、実行の許可（出した日時、期限、使った日時）、件数の予約（件数、予約した日時）、開始の時点の累積の件数、「人が決めたこと」と「BeakSight が自動で行ったこと」の一覧。値はすべて、書き込みを始めた時点のものです。予約の締めと累積の件数の確定の値は、画面（書き込みの結果と台帳）で確かめます。 |
| `action-report.html` | 結果、注意（結果が分からない・照合できていない、人が入れた値が入りうる）、送る前の確かめ、送信と送った値、応答、前後の差分（更新だけ）、照合の READ、送信の見張り（Guard）の記録、承認の要約、人が決めたことと BeakSight が自動で行ったこと。 |
| 書き込みのバンドル | 目録（`manifest.json`。各ファイルの大きさと SHA-256、人が入れた値が入りうるかとその注意）、`action-run.json`、`action-evidence.json`、`approval-summary.json`、`action-report.html`。中の JSON と HTML は、Run のディレクトリのファイルと同じバイト列です。同じ記録からは、同じバイト列の ZIP になります。 |

- **人が入れた値**: 更新の変えた欄の前の値と、照合の READ で画面から読んだ値は、BeakSight が作った値ではなく、テスト環境で人が入れた値かもしれません。この値があるときは、`containsHumanEnteredValues` が真になり、HTML の先頭とバンドルの目録に注意を出します。
- **送った値**: 送った値は、入力の規則で作った合成のテストデータで、平文で入ります。
- **入らないもの**: 資格情報、Cookie、CSRF のトークン、hidden・readonly の欄の値、保つ欄の値、`lock_version` は、どのファイルにも入りません（読むだけで記録しません）。

### 報告を配らない場合

画面のサーバ（親）は、書き込みの結果を締めるときに、報告のファイルを確かめます（報告の確かめ）。結果は、ジョブの画面の「書き込みの報告」に出ます。

| 報告の確かめ | 意味 |
| --- | --- |
| 確かめ済み | 報告のファイルが、結果と開始の時の承認に合い、バンドルが報告のファイルから組み立て直したものと 1 バイトも違わないことを確かめました。報告を配ります（「報告を開く」「報告の ZIP をダウンロードする」）。 |
| 報告のファイルがない | 報告のファイルの一部がありません。 |
| 報告の形が違う | 報告のファイルが、決まった形（スキーマ）に合いません。 |
| 報告がジョブと合わない | 報告のジョブ・Run・シナリオ・結果が、このジョブの結果と違います。 |
| 承認の要約が開始の時と違う | 報告の承認の要約が、書き込みを始めた時に確かめた承認の事実と違います。 |
| バンドルが報告と合わない | 親が Run のディレクトリの 4 つのファイル（`action-run.json`・`action-evidence.json`・`approval-summary.json`・`action-report.html`）からワーカーと同じ手順で組み立て直したバンドルと、ZIP のバイト列が違います（目録の値、項目の名前や順、余分なバイトを含め、1 バイトでも違えばここに入ります）。 |
| 結果のファイルが使えない | 書き込みの結果のファイル（`action-run.json`）が使えないため、報告を確かめられません。 |

- 確かめ済みでないジョブでは、報告を配りません。画面には「報告は配りません。書き込みの結果は、この画面の結果の欄で確かめてください。」と、確かめの結果を出します。
- 書き込みが終わっていないか、結果の前にワーカーが終わったジョブは、確かめていないので配りません。
- 確かめるのは締めのときです。締めた後に Run のディレクトリの `action-report.html` と ZIP を入れ替えると、入れ替えた後のファイルが配られます（配る直前に確かめ直すのは、2 つの JSON のスキーマとジョブの ID だけです）。Run のディレクトリのファイルを編集しないでください。
- 締めの前にディスクで書き換えた報告も、照らす項目（ジョブ・Run・シナリオ・結果・許可、承認の要約、4 つのファイルとバンドルのバイト列の一致）の外は見分けません（たとえば `action-evidence.json` の送った値や登録の ID が `action-run.json` と同じかは照らしません。4 つのファイルとバンドルを揃えて書き換えた場合も、照らす項目が合えば確かめ済みになります）。
- 配るときの守り（CSP、ダウンロードの形）は「[成果物の取り出し](local-ui.md#成果物の取り出し)」にあります。

## 監査済みデータの台帳

管理画面の「監査済みデータの台帳」（`/ledger/<profileId>`）は、BeakSight が登録したかもしれないデータの一覧です（承認した書き込みのモードのプロファイルだけ）。画面だけで、ファイルには書き出しません。列と読み方は「[監査済みデータの台帳](local-ui.md#監査済みデータの台帳)」と「[リスクと監査の記録](risks-and-audit-logs.md#監査済みデータの台帳の読み方)」にあります。

## パフォーマンスの値（RUM/APM）について

BeakSight のパフォーマンスの値は、監査の実行の中で、ブラウザがページを開いたときに測った、合成の計測（Synthetic）の値です。

- 実際の利用者の環境で測った値（RUM）ではありません。値は、実行した環境やネットワークに左右されます。
- 時間の値（TTFB、読み込みの完了、資源の応答の時刻など）は、BeakSight の出口の中継（127.0.0.1 の proxy）を通した値です。中継の分だけ遅く出ます（テスト用の小さなサイトで、TTFB は数 ms。「[出口の中継と計測値](safety.md#出口の中継と計測値)」）。
- 同じ測定で、時間の値のほかは、中継を通さない場合と同じでした。高い頻度でポーリングするページなど、既知の違いは「[中継を通さない場合との既知の違い](safety.md#中継を通さない場合との既知の違い)」にあります。
- APM の値でもありません。Navigation Timing、Resource Timing、`Server-Timing`、`traceparent` などは、ブラウザから見える範囲の記録です。サーバの内部の記録（データベースの処理の時間など）は含みません。
- パフォーマンスの Finding（例: `POOR_LCP`）の重大度は、警告です。
- 観測できなかった値は、0 などで埋めずに「未観測」と示します。
