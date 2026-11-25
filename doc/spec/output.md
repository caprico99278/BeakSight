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
    audit.json                      目録（run.json と各ページの page.json のパス）と、ページに属さない Finding
    report.html                     日本語の HTML レポート
    report-summary.json             報告の小さなまとめ（問題の数など。report.html と同じ表示用モデルから書く）
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
```

- 前の版が Run のディレクトリに作った `diagnostics/`（サイトの不調で止めたときの診断の記録）は、もう使いません。手で消してかまいません。

- JSON とテキストは、UTF-8（BOM なし）で、改行は LF です。JSON は字下げなしの 1 行で書き、末尾に LF を 1 つ付けます（2026-10-21 から。前は字下げ 2 文字。読むときは JSON として読めば、中身は同じです）。
- `audit.json`（`audit-schema/2.0`）は目録です（2026-11-15 から）。`run` は `run.json` のパス、`pages` は各ページの `page.json` のパス（Run のディレクトリからの相対パス。ページの順）です。Run の要約とページの結果は写さないので、`run.json` と各ページの `page.json` を読みます。前の版（`audit-schema/1.0`）の `audit.json` は、Run の要約と全ページの結果の写しを持ちます。
- `page.json`（`page-schema/2.0`。2026-11-15 から）は、同じ形の繰り返しを短く書きます。レイアウトとアクセシビリティの Evidence だけが対象で、Finding と Evidence の並びは変えません。
  - 一覧の全部の項目で同じ値の欄は、`{ "keys", "common", "items" }` の形で、`common` に 1 回だけ書きます。各項目は `common` の欄を足すと元に戻り、欄の並びは `keys` のとおりです。
  - 要素の重なり（`elementOverlaps`）の `first`・`second` は、同じレイアウトの `overlapElements` の番号です。
  - 落ち着いた後の確かめ直しの Evidence は、`recheckBase` の Evidence（1 回目）と同じ項目を `{ "sameAs": <番号> }` で指します。番号は、1 回目の同じ一覧の中の位置です。
  - 再開のための保存のページ（`checkpoint-page-schema/1.1`）も同じ形です。前の版（`checkpoint-page-schema/1.0`）の保存からは再開せず、新しく始めます。
- `audit.json` の最上位の `findings` は、どのページの結果にも入っていない Finding（ページ間の規則の Finding）だけです（2026-10-21 から）。ページの Finding は、各ページの `page.json` の `findings` にあります。Run のすべての Finding は、ページの Finding（ページの順）と最上位の `findings` を、この順につないだものです。
- JSON は、スキーマ（`schemas/`）で検証してから書きます。スキーマに合わない場合は、Run Status を `COMPLETE` にしません。
- `visible-text.txt` は、デスクトップの可視テキストから作ります。デスクトップにない場合はモバイルから作り、どちらにもない場合は書きません。
- ChatGPT 用のバンドルの名前は、CLI の `run` では `beaksight-audit-bundle_YYYYMMDDHHmmss.zip`、画面のジョブでは `beaksight-audit-bundle_<プロファイルの名前>_YYYYMMDDHHmmss.zip` です（2026-10-24 から）。日時は、その Run の最後の実行の終わりの時刻で、Run の ID と同じ書式（UTC、24 時間制）です。Run のディレクトリには、最新のバンドルが1つだけあります（「[ChatGPT 用のバンドル](#chatgpt-用のバンドル)」）。
- 新しい Run を始めるときに、同じ名前の Run のディレクトリがすでにある場合は、別の Run の結果を書き換えないよう、監査を始めずに終えます（終了コード 1）。途中の Run を再開するときは、その Run のディレクトリを、そのまま使います。
- 出力先には、スクリーンショットや、サイトの可視テキストが入ります。`artifacts/` は、Git の管理の対象外です。

`report-summary.json`（`schemas/report-summary.schema.json`、`report-summary-schema/1.0`）は、報告の小さなまとめです（2026-10-26 から）。`report.html` を書くときに、同じ表示用モデルから書きます（CLI の `run` と画面のジョブの両方。報告の中で数え直しません）。

- 中身は、Run の ID、Run Status、問題の数（`problemCount`。サイト品質の指摘のエラー・警告・情報の合計で、安全の指摘は入れません）、重さごとの数（`findingCounts`。`ERROR`・`WARN`・`INFO`・`SAFETY`）、最後まで見られなかったページの数（`notFullyCheckedPageCount`。一部未完了・失敗・飛ばしたページ）だけです。URL、文言、サイトの値は入れません。
- 管理画面の作業の画面は、大きな `audit.json` を読まずに、このファイルだけを読んで、点検が最後まで終わったとき（Run Status が `COMPLETE`）の結果の 1 行に問題の数を出します（「点検が終わりました。問題が N 件見つかりました。」）。ファイルがない・読めないときは、数を出さずに「点検が終わりました。最後まで見ました。」と出します。
- 必ず書く成果物（`run.json`・`audit.json`・`report.html`）には入れません。この版より前に書いた Run にはありません。ChatGPT 用のバンドルにも入りません。

`checkpoint/` は、途中で止まった Run を、続きから再開するための保存です（「[中断と再開](resume.md#中断と再開)」）。

| ファイル | 中身 | 書く時期 |
| --- | --- | --- |
| `checkpoint/state.json` | Run の状態（巡回の記録、ID の採番、実効の設定、起動の記録、サイトへの負荷の記録など） | robots.txt と sitemap.xml の取得の後と、ページの監査が1つ終わるたびに、置き換えます。 |
| `checkpoint/state.prev.json` | 1つ前の `state.json` | `state.json` を置き換える前に、今の `state.json` をこの名前に移します。 |
| `checkpoint/pages/<pageId>.json` | 監査を終えたページの結果 | そのページの監査が終わったときに、1回だけ書きます。 |

- 最後まで終えた Run では、`checkpoint/` に `state.json` だけが残ります。ページの保存（`checkpoint/pages/`。出力の `page.json` とほぼ同じ中身）と `state.prev.json` は、使わないので消します。
- 止まった Run（1回目の Ctrl+C、実行時間の上限）では、上のファイルが残ります。
- 保存のファイルは、編集しないでください。
- 実行中の Run の印（監査中の印）は、出力先にファイルを作りません。OS が、Run を動かしているプロセスの終わりと同時に放すもの（Windows では名前つきのパイプ）を使うので、途中で終わった起動の印は残りません（「[同時に実行できる Run](resume.md#同時に実行できる-run)」）。
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
| `STOPPED_BY_SERVICE_REQUEST_LIMIT` | （前の記録だけ）スクリプトで送るログインの監査で、承認したサービスの Origin への要求の上限に届いたため、残りのページを監査せずに止まりました（「API の要求の上限で停止」）。上限は 2026-11 に撤廃したので、今は出ません（「[スクリプトで送るログインの後の監査](authenticated-audit.md#スクリプトで送るログインの後の監査)」）。 |

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
| `authentication.serviceRequestLimitReached` | 承認したサービスの Origin への要求の上限に届いたか（前の記録のため。上限は撤廃したので、今はいつも偽）。 |
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
| `read-evidence.json` | `1.3` | 任意の `authentication`・`endReasonDetail`、定義の対象の種類（候補を読む・画面を読む）と画面の path。検索の確かめの組の結果 `searchChecks`（2026-11-18 から。前の番号ごとの結果 `records` と理由 `RECORD_ID_NOT_AVAILABLE` は外しました）と、任意の `sessionLostSearchCheckKey`（ログインが切れたときに確かめていた組の鍵。ログインし直した後のジョブがその組を最初にやり直すため）。 |

- 版を変えずに足した任意の項目: `discovery.json` の読んだ画面ごとの `documentRequests`・`childFrameDocumentRequests` と、`read-evidence.json` の実行した定義ごとの `documentRequests`・`childFrameDocumentRequests`（DEF-129。下の「[ページの文書の要求の数](#ページの文書の要求の数)」）、両方の `authentication.allowedOriginDataRequestsBlocked`（`run.json` の `authentication` と同じ形）。前の書き手の成果物にはありません。
- `discovery.json` の画面ごとの任意の項目 `searchTriggers`（2026-11-18 から。版は `1.1` のまま）: 操作さがしの押下・選択肢の選択・form に属さない欄への入力のうち、データの読み取り（GET・HEAD の fetch・xhr）を出したきっかけと、その読み取りの形（path の型・query の名前・目印を運んだ query の名前）と状態の番号。URL・値・本文は残しません。
- `discovery.json` の候補の欄の任意の項目 `destructiveOptionIndexes`（2026-11-18 から。版は `1.1` のまま。識別の digest に入れません）: 値か表示の文字が削除の語に当たる選択肢の位置（当たるものがある欄だけ）。表示の文字は残しません。検索の確かめは、その選択肢を送る組を作りません。
- 書くのは新しい版で、読み手（管理画面）も新しい版だけを受けます（2026-10-24 から）。`read-evidence.json` の `1.2`（2026-11-18 より前の見るだけの確かめの結果）も読みません。前の見るだけの確かめの結果は、画面に出なくなります。前の版（`discovery.json` の `1.0`、`read-evidence.json` の `1.0`・`1.1`・`1.2`）の文書は、読めないものとして扱います（シナリオの下書きと候補の探し、READ の確かめの対象の画面に使いません。READ の確かめの対象の画面は「分からない」になります）。もう一度発見すると、新しい版の文書ができます。
- ジョブの結果を親に送るときの要約（数）は、成果物の `authentication` と照らし合わせます。ジョブの詳細の欄「ログインの後の読み取りの数」は、確かめた成果物から数を読みます。

## 測りの記録（開発者向け）

- 開発者が時間の内訳を測るときだけ、リポジトリの根の Git の管理の外のフォルダに設定ファイル `local/debug-settings.json` を置き、中身を `{ "debugTiming": true }` にします（CLI・管理画面のサーバ・ワーカーのどれから起動しても、同じファイルを Run（段）の始めに 1 回読みます）。ファイルがない・JSON として読めない・`debugTiming` が `true` でないときは切です（既定は切。画面に入切の口はありません。止めるときはファイルを消すか `false` にします）。入のときだけ、Run のディレクトリに `debug-timing.jsonl`（段の終わりにまとめて書く。URL・入力した値・秘密を持たない）と、`discovery.json` の読んだ画面ごとの `timeBreakdown` を書きます。ChatGPT 用のバンドルと報告には入れません（設計書 `doc/design/2026-11-20-beaksight-discovery-skip-and-debug-timing-design.md` の 2.2）。

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
レポートは、次の節からなります（2026-10-26 から。設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` の 14 章）。節の名前と文は、画面と同じやさしい言葉です（監査は「点検」、Finding は「問題」など。2026-10-28 から、本文の技術の語をさらに減らし、やさしい文にしました。技術の記録は、末尾の記録の段にあります。対応は「[画面の語と文書の語](local-ui.md#画面の語と文書の語)」）。カッコの中は、レポートの節の名前です。

1. まとめ（「まとめ」）: 冒頭の段です。何を見たか（点検したサイトのはじめのページ、点検の結果、見つけたページと開いて見たページの数）、見つかった問題の数（重さごと。安全は問題の数に入れません）、大事な問題（重い順に 3 つまで。種類ごとの問題の表の行へのリンクつき）、見られなかったところ（最後まで見られなかったページの数と、点検の全体とページで見られなかった理由をやさしい言葉で）。表示用モデル（`overview`）から作り、レポートの中では判定しません。点検（まとめて実行）で、プロファイルの詳細の一覧「登録・更新を試せる画面」でチェックした画面があるときは、監査の報告のまとめに「この点検では、この後に、チェックした画面でテスト用のデータを登録・更新します。結果はサイトの画面に出ます。」の 1 行が出ます（2026-10-28 から。監査の段そのものは読み取りだけで、書き込みの結果は書き込みの段の報告と、サイトの画面に出ます。下の「[書き込みの報告](#書き込みの報告)」）。
2. 重大な指摘（「重い問題（エラー）」）: 重大度がエラーの指摘（カテゴリを問いません）の一覧。各行は、カテゴリ別の指摘の表のその指摘の行へのリンクと文言です（2026-10-21 から。表をもう一度出しません）
3. カテゴリ別の指摘（「種類ごとの問題」）: ネットワーク、JavaScript、リンク、DOM、フォーム、レイアウト、アクセシビリティ、パフォーマンス、ページ間、安全
4. インタラクション（「押して確かめた操作」）: 操作の候補ごとの結果
5. 安全（「安全のために止めたこと」）: 安全のために止めた操作と、安全の不変条件の違反（「[Safety Ledger の読み方](safety.md#safety-ledger-の読み方)」）。節の中の事象の一覧（「安全のために止めたことの一覧」）は、止めた要求（`blockedRequests`）の行の理由の欄に、理由のコードの後に理由の説明を添えます（止め方が理由ごとに違うため。離れた後の上限は GET も止めます。Task 44 の T44R2 の M-7）
6. ページの一覧（「ページごとの結果」）: ページごとの状態、ビューポートごとの状態、スクリーンショット
7. 記録（「記録」）: 末尾の段です。前の「要約」の中身を、消さずにここへ移しました。Run の ID と状態・許可 Origin・日時（「点検の回」）、ページの網羅、指摘の件数（「問題の数（くわしく）」）、上限、サイトへの負荷、計測のタグ（「計測のタグ（読み込みを観測したもの）」。観測したときだけ）、主要な行動の候補の位置（「主要な行動の候補の位置」。候補を見つけたときだけ）、実行の記録（「起動の記録」）、未完了の理由、実行の環境（「動かした環境」）

記録の段の「計測のタグ（読み込みを観測したもの）」（2026-11-19 から。BS-1）は、ChatGPT 用のバンドルの `measurement-tags.json` と同じ一覧を、種類・識別子・ページの数・デスクトップとモバイルの観測の有無で示し、種類ごとの数と、限界の文（いつも付ける「読み込みを観測した事実です。設置した人・設定の中身・成果の計上（重なり・漏れ）は確かめていません。」、監査の送信の扱いごとの文、見られなかったページがあればその数、BeakSight が止めた計測の要求があればその数）を添えます。タグを観測しなかった Run では、この節を出しません。CLI の結果には、観測したときだけ「計測のタグ: N 種類（読み込みを観測。詳しくはレポート）」の 1 行を出します。ローカルの画面には出しません。

記録の段の「主要な行動の候補の位置」（2026-11-20 から。BS-2）は、ChatGPT 用のバンドルの `key-actions.json` と同じ表示用モデルの値から、種類ごとの候補を持つページの数（2026-11-20 から、本文と、ページに共通の部分（メニューなど）に分けた数も）、画面に止まって動かない表示の中に候補があるページの数、最初の画面に見える候補がないページの数（ビューポートごと）と、いつも付ける限界の文を示します。候補を 1 つも見つけなかった Run では、この節を出しません（「なし」とは書きません）。CLI の結果とローカルの画面には出しません。

- 本文の最大幅は約 50rem、行の高さは 1.75 です。配色は、OS の設定（明るい・暗い）に従います。

記録の段の「指摘の件数」（「問題の数（くわしく）」）には、サイト品質の指摘を、BeakSight が止めた要求との関係で分けた件数（「遮断が原因」「遮断の影響の可能性」「遮断と結び付かない」）と、ChatGPT 用のバンドルの本体（`findings.json`）に入る指摘の件数も示します（2026-10-23 から）。区分の決め方は「[BeakSight の遮断と指摘の関係](#beaksight-の遮断と指摘の関係)」にあります。カテゴリ別の指摘の表では、「遮断が原因」と「遮断の影響の可能性」の指摘の内容の欄に、区分の印と理由を添えます（結び付かない指摘には付けません）。安全の指摘のうち、閉じる途中とページを離れた後に止めた事象を数えたものには、「閉じる途中に止めた」の印と事象の件数を添えます（測りの後のもの）。

指摘の画像の欄（2026-11-19 から。AUD-4）: 形の記録を読んだときと画像を撮ったときに、画面の状態の印（文書と内側のスクロールの位置、画面の作りの要約、隠した通知の枠の数）を記録し、画像を撮る直前には形の記録の対象の要素の位置も読み直して、画像に矩形を重ねる前に比べます。内側のスクロールの位置の差だけなら、矩形をその差で動かして重ねます（その領域の見える範囲に入るときだけ）。対象と関係のない所の変化（後から差し込まれる窓・広告の枠・回るカルーセルなど）では保留にしません（画面の作りの要約は記録だけで、比べに使いません）。対象そのものが動いた・消えた・複数に当たる、隠した通知の枠の数が違う、などの指摘は、指摘を消さずに「確かめを待つ問題」（`holdReason` の `EVIDENCE_MISMATCH`。報告の文は「記録と画像の状態がずれたため、確かめ直しを待っています。」）にし、時間切れの後の再開では、そのページを先に読み直します。対象まで動かして撮る指摘（重なり・覆い・フォーカス・見切れ・横にスクロールする領域）は、今までどおりです。限界: 色の差の指摘の後ろの色と、画像の画素の色は照らし合わせていません。

指摘の分け方（2026-11-19 から。AUD-6）: 画面が落ち着くのを待ちきれなかった状態（落ち着きの待ちが終わらない・一部だけ・記録がない）の、見出しや本文の欠けなど内容の指摘は、指摘を消さずに「確かめを待つ問題」（`holdReason` の `PAGE_READINESS_UNKNOWN`。報告の文は「画面の準備ができたかが分からなかったため、確かめを待っています。」）にし、時間切れの後の再開では、そのページを先に読み直します。落ち着いた後の確かめ直しで同じ指摘が出たなら、今までどおりです。送り先の指定のない入力の欄のまとまり（`FORM_WITHOUT_ACTION`）と、押せない形の見た目の指定（`cursor: not-allowed`）だけの要素の文は、事実の記録の文です（送れるか・押せるかは確かめていません）。性能の指摘（`POOR_LCP` など）は 1 回だけの測りなので、文で「1 回の測りです」と書き、確信度を 1 段下げます（測り直しはしません。重さは変えません）。page.json の axe の要素の記録には、axe 自身が HTML の抜粋を切り詰めたときの印（`truncated` と `truncationKind` の `SOURCE_TRUNCATED`）、確かめに関わる別の要素の目印（`checks` の `relatedNodes`。selector だけ）、名前の規則（ボタン・リンク・入力欄・画像の名前など）の違反の要素の名前の根拠（`nameContext` の `nameSource`）があります。

前面の窓（2026-11-24 から。RVP）: 開いた大きな小窓（`role="dialog"`・`aria-modal` など、画面の 3 割以上を覆うもの）が背後の部品を覆うのは作りどおりとし、フォーカスの確かめ（Tab で窓の背後へ移るときだけ指摘）・固定要素の覆い・通知の枠（自分の閉じるボタンの見つからない窓は枠にしない）で指摘にしません。Tab で確かめていないフォーカスの指摘は「押せません」と言い切らず確信度を 1 段下げ、覆いの対象が画像の外なら計った数だけを書きます。通知の枠を隠した指摘には隠した画面の幅とその隠す前の画像を、名前の規則の対象が無効なら「無効の状態で見つけました」を足し、参照する要素のない同じ id の指摘は確信度を 1 段下げます。

CLI の結果の行には、遮断が原因の指摘と遮断の影響の可能性の指摘が 1 件以上あるときだけ、その件数の 1 行（「BeakSight の遮断と結び付く指摘: …（ChatGPT 用バンドルの本体から外しました）」）を、指摘の件数の行の次に出します。

記録の段の「実行の記録」（「起動の記録」）には、実行の回数と再開の回数（CLI の実行の行と同じ値）と、起動ごとの一覧を示します。一覧の各行は、何回目の実行か、開始の日時、終了の日時、終わり方です。終わり方は、日本語のラベル（例: 「実行時間の上限で停止」）、`run.json` の `endReason` のコード、説明で示します（コードの意味は「[中断と再開](resume.md#中断と再開)」の表を見てください）。

`mailto:` や `tel:` などの URL と、安全のために止めた操作の URL は、リンクにせず、文字として示します。

## Run Status の意味

Run Status は、監査を最後まで行えたかを表します。サイトの品質の良し悪しを表すものではありません。

- `COMPLETE`: 必要な確認を、すべて終えました。サイトに問題があるかどうかは、Finding で確かめます。
- `PARTIAL`: 一部の確認を終えられませんでした。たとえば、上限（ページの数、深さ、実行時間）に達した場合や、期限を過ぎた場合、Ctrl+C で止めた場合です。理由は、レポートの要約の「未完了の理由」と、`run.json` の `incompleteReasons` にあります。ページごとの理由は、レポートのページの欄にあります。理由ごとのページ数は、`run.json` の `pageIncompleteReasonCounts`（理由を持つページがあるときだけ。上限で監査しなかったページは数えません）と、監査のジョブの画面の「確かめきれなかったページの理由」にあります。どの理由にも、説明の後に次にできること（例: 内側のスクロールの領域を確かめきれなかった `INNER_SCROLL_CONTAINER_NOT_TRAVERSED` → その領域を手で確かめる。想定していない失敗 `UNHANDLED_FAILURE` → もう一度監査し、続けて起きるときは詳しい内容を添えて知らせる）を出します（Task 44 の T44h の判断 (1)）。レポートの文は CLI でも作るので、画面の操作の名前は書きません。`pageIncompleteReasonCounts` の各項目は、その理由を持つページのアドレスの全部（`pageUrls`）も持ちます。点検の範囲の外へ移ったので点検しなかったページ（`NAVIGATION_FAILED` の詳細が `BLOCKED_EXTERNAL_REDIRECT`）は、ほかの読み込みの失敗と分けて、`detail` を持つ別の項目で数え、別の説明（「点検の範囲の外へ移るページなので、点検しませんでした。」）と次にできることを出します。どちらも任意の項目で、前の版の `run.json` にはありません（版は `run-schema/1.0` のままです）。
- `FAILED`: 監査を実行できませんでした。たとえば、実行の前の確認（PREFLIGHT）に失敗した場合や、Run のディレクトリを作れなかった場合です。外部のアプリを開かせない Chromium の設定が効かなかった場合も、実行の前の確認の失敗です（理由の詳細 `EXTERNAL_LAUNCH_BLOCK`。「[安全](safety.md#headed-で実行するときの注意)」）。
- `ABORTED_BY_SAFETY`: 安全の不変条件の違反を記録しました。違反を記録した後は、新しいページ、次のビューポート、次の Interaction の候補を始めません。残りのページは、理由 `SAFETY_VIOLATION_ABORT` のスキップになります。結果のファイルは、止めたことを含めて書き出します。

## Finding と Evidence

- Evidence は、ブラウザで観測した事実の記録です（ネットワーク、コンソール、DOM、レイアウト、パフォーマンス、アクセシビリティ、スクリーンショットなど）。各ページの `page.json` にあります。
- Finding は、Rule が Evidence から判定した指摘です。重大度（エラー、警告、情報、安全）、カテゴリ、Rule の ID（`ruleId`）、文言を持ちます。
- Finding は、根拠の Evidence を `evidenceRefs` で参照します。HTML レポートの指摘の表からは、Evidence（`page.json` の中の場所）とスクリーンショットへたどれます。
- 件数は、サイト品質（エラー、警告、情報）と安全を、分けて数えます。
- `page.json` の版は `page-schema/1.1` です（2026-10-23 から）。安全の記録と network の記録に、BeakSight が止めた要求を見分ける印（止めた時点、要求の種類、閉じる途中に止めた要求、network の失敗の印、読み込みの種類）が付きます。前の版 `page-schema/1.0` は、2026-10-24 から読みません（それを持つ再開の保存は、新しい Run として始め直します）。読み方は「[止めた時点と読み込みの印](safety.md#止めた時点と読み込みの印)」にあります。

## 成果物の URL の伏せ字

公開の監査と認証つきの Run は、同じ決まりで、成果物（`page.json`・`audit.json`・`run.json`・`report.html`・ChatGPT 用のバンドルの中身・再開のための保存・診断の記録）に書く前に URL を伏せます（Task 44 の P4-1）。伏せるのは、書く前の 1 か所（成果物の書き手）だけです。判定（リンクの確かめ、リダイレクトの連鎖、Finding の identity）は、伏せる前の値で行います。

- 記録した要求の URL: network の Evidence の要求・応答・失敗と、同じ口のくり返しをまとめた記録（`repeatedReads`）の最初といちばん遅かった 1 件の URL（`first.url`・`slowest.url`。2026-11-19 から。DEF-298）、パフォーマンスの Evidence の資源（resource timing）と server timing（`serverTiming`）と LCP の帰属の資源の URL（`webVitals.LCP`・`lcpBeforeScroll` の `attribution.url`。2026-11-19 から。network に同じ URL がなくても伏せます）、計測の header と候補（`telemetryHeaders`・`telemetryCandidates`）、安全の記録の止めた要求・ナビゲーション・WebSocket・ポップアップ・ダウンロード・外部への作用・監査の段の除外・閉じる途中に止めた要求（`blockedClosingRequests`）・frame を判定できずに止めた移動（`frameClassificationFailures`。2026-11-19 から）の URL は、query の名前を残して値をすべて `[REDACTED]` に伏せます。path の値に見える区切り、fragment の値、userinfo も伏せます（例: `/api/data?marker=[REDACTED]&page=[REDACTED]`）。
- 同じ値を持つ項目（T44R の C-1）: 画像の記録の `src`・`resolvedUrl`、console の記録の位置の URL（`location.url`）、ページの誤りの `stack` の中の URL、header の `location`・`content-location`・`refresh` も、同じ決まりで伏せます。さらに、記録した要求の URL（と、その path と query の形）と同じ値は、ほかのどの文字列の中でも（Finding の本文と identity を含む）、同じ決まりで伏せた値に替えます。
- それ以外の文字列の中の URL: 秘密に見える名前（`token`・`access_token`・`code` など）の query の値と、userinfo を伏せます。
- 限界（秘密に見える名前でない query の値が残る項目）: ページの identity の URL と、それと同じ URL を含む Finding の本文と identity（例: HTTP の状態の Finding。ページの identity を変えないため）、リンクの URL と canonical などの DOM の Evidence の属性、記録した要求にない URL を含む文（console の本文、アクセシビリティの HTML の断片など）、再開の保存の状態（`checkpoint/state.json` の巡回の URL。値で照らす段を行わない）。ページの identity は、ページの URL（`pageUrl`・要求した URL・最終の URL）と設定の開始の URL（`startUrl`）と、許して読み込んだ main frame の文書の要求（応答のあるもの）とそのリダイレクトの連鎖です（T44R3・T44R4）。止めた main frame の要求（例: form の POST の送信）は identity でないので、その URL は Finding の本文と navigation timing（止めた後の誤りの文書の URL）でも伏せます。止めた記録の URL は、ページの URL に等しいときだけ残ります。再開の保存のページ（`checkpoint/pages/`）は、巡回が知っている URL（待ち行列と、監査したページの URL）も identity として残します（続けて終えた Run と同じ結果にするため）。そのため、待ち行列にあっても最後まで監査しなかった URL と同じ値は、再開した Run だけで残り、あとで監査するページのリダイレクトの後の最終の URL と同じ値は、再開した Run だけで伏せられます。また、あるページの要求の URL と同じ値が、それより前に保存したページの文やリンクに出る場合、続けて終えた Run では伏せますが、再開した Run では残ります（保存のページは、書いた時点の値の木で伏せ、伏せる前の値は保存しないため。T44R5 の m-3。揃えません）。
- 値で照らす段の形の限界: 文の中の字句（空白・引用符・`<`・`>`・backtick で区切ったもの）が、記録した要求の URL か、その path と query の形か、それらの `&` を `&amp;` にした形に、まるごと等しいときだけ替えます（T44R2）。記録した要求の URL は ASCII の形なので、字句の中の ASCII の連なり（非 ASCII の字で区切ったもの。例: Finding の文の「（例: POST URL）。」）も照らします。連なりの先頭の `(`・`url(` と、末尾の閉じ括弧・`,`・`.`・stack の行と列（`:1:15`）を外した形と、CSS の `url(…)` の中身も照らします（T44R3）。ただし、連なり（か、先頭を外した形）がページの identity の形か、外す途中で identity の形になるもの（例: ページの URL が `…?id=1.` のときの `(…?id=1.)`）は、外して引く形で替えません（T44R4。ページの URL が書き換わり、再開が壊れないため）。そのため、形を変えた写し（percent-encode を解いた形、空白の `+`、別の形の相対の URL、query の値だけ、JSON の `\/`、数値の文字参照 `&#38;`、scheme や host や path を大文字にした形など）と、ほかの ASCII の字と続けて書かれた URL（例: `x=URL`）は残ります。逆に、非 ASCII の字が続く IRI の形（例: `?q=1日本`）は、前の ASCII の部分が記録した要求の URL に等しければ、その部分を伏せます（多く伏せる向き）。公開の監査のページの URL は、巡回の正規化で、許した名前（`crawl.allowedQueryParameters`）のほかの query を落とします。
- 計測のタグの識別子の例外（2026-11-19 から。BS-1）: 記録した要求の URL が、計測のサービスの閉じた一覧の行（ホスト・path・識別子の欄の名前・識別子の形）に全部合うときだけ、その識別子の query の値（例: `gtm.js?id=` の `GTM-` で始まる英数字）を伏せずに残します。識別子はページに公開で書かれる値です。同じ URL のほかの query の値・path の値に見える区切り・fragment は今どおり伏せます。同じ名前の組が 2 つある、値の形が合わない（長すぎる・記号や空白・percent-encode を含む）、userinfo がある、既定でない port の指定がある（`https` の `:443` のような既定の port は URL の決まりで消えるので、例外が効きます）、`;` か 2 つ目の `?` を含む URL では、例外を効かせません。承認したサービスの Origin の URL は、例外を効かせず全部伏せます。
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
- 限界（2026-11-20 に明記）: スマホの幅の点検は、パソコンのブラウザの幅を狭めて行います。スマホのブラウザだと名乗らず、指で触る操作も真似しません。スマホかどうかで見せ方を変えるサイトでは、スマホで見える画面と違うことがあります。

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

バンドルは、次のファイルを、この順に含みます（`manifest.json` の `bundleSchemaVersion` は `chatgpt-bundle/2.4`。2026-11-15 の 2.0 で、指摘の一覧をページごとのファイルに分け、Evidence の索引を外しました。2026-11-19 の 2.1 で、計測のタグの一覧 `measurement-tags.json` を足しました。2026-11-20 の 2.2 で、主要な行動の候補の位置 `key-actions.json` と、固定の表示の覆いの指摘の `verification.keyActions` を足しました。2026-11-24 の 2.3 で、`summary.json` の `focusChecks` に前面の窓の背後で指摘にしなかった数（`FRONT_WINDOW_COVERED`）と Tab の確かめのない指摘の数（`findingsWithoutSequentialTab`）を足しました。2026-11-24 の 2.4 で、`summary.json` の `focusChecks` に窓を開くボタンの確かめの数（`dialogFocus`。押す物のなかった画面の数を含む）を足しました。前の版の形のバンドルは作り直しません）。

- `manifest.json`: 中のファイルの一覧（大きさと SHA-256 と、入っている部の番号 `part`）と、部の数（`partCount`）と、撮影・保存できなかったファイルの一覧（`omittedFiles`）と、その数（`missingArtifactCount`）
- `README.md`: 読み方の案内（日本語の Markdown。2026-10-22 から）。読む順、各ファイルの意味、本体の指摘と外した指摘（本体の意味、外した件数と区分、`page.json` の中の BeakSight の遮断の記録、閉じる途中の遮断）、category の別の件数の表（本体と外した指摘を合わせた全部の件数。「指摘の件数」の行も同じ）、本体の指摘の Rule の別の件数の表、Run の状態とページの網羅、安全の区分の指摘の読み方を書きます。URL・対象の ID・開始の URL・指摘の文は書きません
- `run.json`: 書き出した `run.json` そのもの
- `summary.json`: 要約。重大度・区分の別の件数に加えて、category の別の件数（`findingCountsByCategory`。0 件の category も含む）と、Rule の別の件数（`findingCountsByRule`。件数の多い順）を含みます。これらは、外した指摘も含む全部の件数です。本体の指摘と外した指摘の件数は `beaksightBlockRelation` にあります（`byRelation`: サイト品質の指摘の区分の別の件数、`linkedFindingCount`: 遮断と結び付く指摘の件数、`mainFindingCounts`: 本体の件数、`excludedFindingCounts`: 外した件数。2026-10-23 から）。性能の指標の観測の範囲（`webVitalsCoverage`。2026-11-09 から。下の「性能の観測の範囲」）と、色の差を測れなかった所の数（`contrastUnmeasured`。2026-11-09 から。下の「色の差を測れなかった所」）もあります
- `findings-by-rule.json`: Rule ごとの要約（2026-10-22 から）。本体の指摘の要約（`main`）と、外した指摘の要約（`excluded`）に分けてあります（2026-10-23 から）。Rule ごとに、件数、重大度の別の件数、出たページの数、ビューポートの別の件数、区分の別の件数（`byBlockRelation`）と、例を 3 件まで（ページの違うものが先）含みます。その Rule の指摘が入る候補群の数（`groupCount`）と ID（`groupIds`）もあります（2026-11-09 から）。重大度の重い順、件数の多い順に並びます
- `finding-files.json`: 指摘のファイルの場所の一覧（2026-11-15 から）。ファイルごとに、ページの ID（`pageId`。ページに属さない指摘のファイルは `null`）、場所（`path`）、下の 3 つの一覧の件数（`main`・`excluded`・`initialOnly`）があります。指摘のないページのファイルはありません
- `finding-groups.json`: 同じ作りの所の候補群（2026-11-09 から。下の「同じ作りの所の候補群」）
- `pages.json`: ページの一覧。ページごとの状態と、本体と外した指摘の件数（`mainFindingCounts`・`excludedFindingCounts`）があります。指摘の ID の一覧は持ちません（2026-11-15 から）
- `links.json`: リンクごとの確かめの状態。行き先を読んでいないサイトの中のリンク（`UNVERIFIED`）には理由があり、行き先が点検の範囲の外（読む範囲の外・読まないパス・危険な語で、巡回で読まないと決めた行き先）のものは `OUTSIDE_READ_SCOPE` です（2026-11-19 から）。これは確かめていないリンクの数（`counts.unverified` と `summary.json`・HTML の報告の数）に入れず、`counts.outsideReadScope` に数えます。点検の範囲の中で、まだ読んでいない行き先は、これまでどおり `TARGET_NOT_AUDITED` です
- `measurement-tags.json`: 計測のタグの一覧（2026-11-19 から。BS-1）。記録した要求の中に、決まった計測のサービス（タグの管理の入れ物・まとめて読み込むタグ・アクセスの分析の送信・画面の操作の分析・広告の成果の計測・SNS の広告の計測）の読み込みを観測した事実です。指摘ではありません。行は種類（`service`）と識別子（`tagId`）の組ごとで、サイト全体で同じ構成が繰り返されても 1 行です。行ごとに、観測したページ（`pageIds`・`pageCount`）、ビューポートごとの観測の有無（`viewports`）、要求の数（`requestCount`。同じ宛先のくり返しをまとめた記録の分を含む）と種類（`requestKinds`）、結果の数（`results`: 応答の状態の番号の範囲・`REQUEST_FAILED`・`BLOCKED`（BeakSight が止めた。安全の記録と照らします）・`NO_RESPONSE`）、根拠の参照（`evidence` の `path` と `pointer`）、検出元（`source`。`NETWORK_REQUEST` だけ）があります。`countsByGroup` は分け方（タグの管理・分析・広告）ごとの行の数、`limits` は限界の事実（Run の状態、読み込めなかったページ・まだ見ていないページ・理由の数、監査の送信の扱い、計測のサービスのホストへの BeakSight が止めた要求の数）です。タグを観測しなかった Run では、空の一覧（`tags` が `[]`）です。`summary.json` には重ねて書きません。限界: 一覧にないサービスと、ページの中の記述（埋め込みの設定）からの検出は数えません。タグの管理の入れ物から読み込まれたか、直接の埋め込みかは区別しません。設置した人・設定の中身・送り先で受け付けられたか・成果の計上（重なり・漏れ）は分かりません。同じ宛先のくり返しをまとめた記録は、最初の 1 件の URL の識別子に数えます
- `key-actions.json`: 主要な行動の候補の位置（2026-11-20 から。BS-2）。押せる要素（リンク・ボタン・`role=button|link`）のうち、決まった行き先の型（`tel`・`mailto`）、メッセージのサービスのホスト、汎用の語（予約・問い合わせ・購入・申し込みなど）に当たったものの位置の事実です。指摘ではなく、どれが大事かは決めません。`pages` はページとビューポートごとの行で、候補ごとに種類（`kind`: `PHONE`・`EMAIL`・`MESSAGE`・`BOOKING`・`CONTACT`・`PURCHASE`・`OTHER`）、名前（`name`。電話番号とメールアドレスに見える文字は伏せます）、文書の中の位置と高さ（`top`・`height`）、最初の画面に入るか（`inFirstView`）、固定の表示の中か（`fixed`）、見えるか（`visible`）、ページの高さ（`pageHeight`。scroll の記録の最大の高さ）に対する位置の割合（`positionRatio`。固定の表示は `null`）と、根拠の layout の Evidence の場所（`evidence`）があります。2026-11-20 から（AUDR2）: 文書がスクロールせず、内側の入れ物がスクロールする画面は、ページの高さを scroll の記録のいちばん大きな内側の入れ物の高さにし（`pageHeightBasis` が `INNER_SCROLL_CONTAINER`）、入れ物の中の候補（`inScrollContainer`）だけ、入れ物の中の位置と割合を出します。内側の入れ物の記録がなければ、高さは分からないとし（`pageHeight` は `null`、`pageHeightBasis` は `UNKNOWN`）、割合を出しません。文書の高さのときは `DOCUMENT` です。候補ごとの `sharedFrame` は、データを除いた path の違う 2 つ以上のページに、同じ要素（番号と表示の順で替わる id をまとめた目印・名前・種類が同じ）として同じビューポートで出る、ページに共通の部分（メニューなど）の候補かです。`summary` は、候補を読んだページの数、種類ごとの候補を持つページの数（`pagesWithKind`。本文の候補 `pagesWithKindInBody` と、共通の部分の候補 `pagesWithKindInSharedFrame` に分けた数も）、固定の表示の候補のあるページの数、最初の画面に候補がないページの数（ビューポートごと）、ページの高さの分布（最小・中央・最大）です。`scope` は探した範囲（要素の selector・行き先の型・ホスト・語の一覧）です。`actions` が空の行は、この範囲で見つからなかったという意味で、「ない」とは限りません。行き先の番号・宛先は記録しません（layout の Evidence の `keyActionElements` も、行き先は scheme とホストだけです）。固定の表示の覆いの指摘（`FIXED_ELEMENT_OCCLUSION`・`OVERSIZED_FIXED_ELEMENT`）の `verification.keyActions` は、覆う側（`overlayKinds`）と覆われる側（`coveredKinds`）の候補の種類と、押せないかを確かめた証拠の有無（`pressCheck`: `PRESS_BLOCKED_OBSERVED` は動かして測り直して押下を覆いが受けると分かったもの、`NOT_CHECKED` は操作の支障を確かめていないもの）です。`summary.json` には重ねて書きません。README には、いつも限界の文（「見つけた候補の位置の事実です。どれが大事か、利用者が見つけやすいか、実際に押せるかは確かめていません。見つからなかった候補が『ない』とは限りません。」）と読み方を書きます。限界: 画像の中の文字・名前のないアイコン（行き先の型で拾えるものを除く）と、業種に固有の言い回しは拾えないことがあります
- `pages/<pageId>/findings.json`・`run-findings.json`: 指摘のファイル（2026-11-15 から）。ページごとの指摘と、ページに属さない指摘（ページ間の規則の指摘など）です。どれも、次の 3 つの一覧を持ちます。指摘ごとに、参照する Evidence の場所（`evidence` の `path` と `pointer`）、関係する画像のパス、確かめ方（`verification`。下の「指摘の確かめ方」）、入る候補群の ID（`groupId`）があります
  - `main`: 本体の指摘。BeakSight が止めた要求と結び付かない、サイト品質の指摘（区分 `NONE`）だけです（サイトの欠陥の候補）
  - `excluded`: 本体から外した指摘。遮断が原因の指摘（`CAUSED`）、遮断の影響の可能性がある指摘（`POSSIBLE`）、安全の区分の指摘です。指摘ごとに、BeakSight の遮断との関係（`beaksightBlockRelation`。区分 `relation`・理由 `reason`・結び付いた遮断の参照 `blocks`（5 件まで）・遮断の数 `blockCount`。安全の区分の指摘は `null`）と、安全の区分の指摘の止めた事象の時点の別の件数（`safetyBlockPhaseCounts`。`CLOSING` は閉じる途中とページを離れた後）を持ちます
  - `initialOnly`: 初めの表示だけの指摘（落ち着いた後に確かめ直したら消えた指摘）
- `pages/<pageId>/page.json`: 各ページの結果（一次の Evidence。短い形の読み方は「出力の構成」の節と `README.md` にあります）
- `pages/<pageId>/visible-text.txt`: 各ページの見える文字（2026-11-09 から）
- スクリーンショット（2026-11-09 から。下の「入れる画像」）

入れる画像（2026-11-09 から）:

- 点検で集めた画像を、大きさにかかわらず全部入れます。見える範囲の画像（`viewport.png`）、ページ全体の画像（`full-page.png`）、やり直す前の試行の画像（`retry-<番号>/` の下）です。指摘のない画面の画像も入れます。
- 各ページの見える文字（`visible-text.txt`）も入れます。
- 1 つの ZIP の大きさは 64 MiB を目安にし、入りきらないときは第 1 部・第 2 部…に分けます。第 1 部は入口だけで、`manifest.json`・`README.md`・`run.json` と、要約・ページの一覧・指摘のファイルの場所の一覧などのバンドルが作る JSON を入れます。指摘のファイル、各ページの `page.json`、見える文字、画像は、この順に（画像は指摘に関係するものを先にして）、第 2 部以降に入れます（全部が 1 つの ZIP に入るときは、1 部だけです）。1 つのファイルだけで 64 MiB を超えるものは、そのファイルだけで 1 つの部にします（分けたり、外したりしません）。どのページの `page.json` が何部にあるかは、`manifest.json` の `files` で分かります。
- 1 部だけのときのファイルの名前は、これまでどおり `beaksight-audit-bundle_…YYYYMMDDHHmmss.zip` です。2 部以上のときは、`beaksight-audit-bundle_…YYYYMMDDHHmmss_part1.zip`・`…_part2.zip` のように、日時の後に部の番号が付きます。画面の「できたファイル」とサイトの画面には、全部の部のダウンロードのリンクが出ます（「全 N 個のうち k 個目」）。CLI の結果の行には、全部の部のパスが出ます。
- `manifest.json`（第 1 部にあります）の `partCount` は部の数、`partSizeBytes` は 1 つの部の大きさの目安です。`files` の `part` は、そのファイルが入っている部の番号です。
- `README.md` の冒頭に「全 N 部のうち第 k 部です。」と書いてあります。
- `page.json` は記録そのものなので、書き換えません。

撮影・保存できなかったファイルの一覧の読み方（2026-11-09 から）:

- 撮影・保存できず、成果物のフォルダになかったファイルは、`manifest.json` の `omittedFiles` にあります。1 件ごとに、場所（`path`）、そのファイルの元の記録の ID（`evidenceIds`）、起きたこと（`reason`）があります。そのときも、バンドルは作ります。
- バンドルの中の JSON に書かれた `pages/` の場所は、必ず「バンドルの中にある」か「`omittedFiles` にある」かのどちらかです。どちらでもない場所があるときは、BeakSight はバンドルを作りません（作り方の誤りを見つけるための決まりです）。
- `missingArtifactCount` は、報告を作る前に確かめて、成果物のフォルダになかったファイルの数です。HTML の報告にも同じ数が出ます（1 件以上のとき）。HTML の報告では、なかった画像に「画像がありません」と出ます。

`reason` の値は、次の 1 つです。

| 値 | 意味 |
| --- | --- |
| `ARTIFACT_FILE_NOT_FOUND` | このファイルは、撮影・保存できず、成果物のフォルダにありませんでした。 |

指摘の確かめ方（`verification`。2026-11-09 から）:

- 指摘ごとに、その指摘を何で確かめたかがあります。`basis` は Rule ごとに決まっていて、次の 4 つのどれかです。
  - `STATIC_CANDIDATE`: ページの作り（HTML の構造）から見つけました。
  - `RENDERED`: 表示した画面で確かめました（配置や色の差など）。
  - `NAVIGATION_OBSERVED`: ページを開いた結果や、移動の結果で確かめました（返事の番号、読み込み、リンクの行き先など）。
  - `INTERACTION_REPRODUCED`: 操作して確かめました（今は、ほとんどありません）。
- `status` は、ふつうは `basis` と同じです。指摘が指す記録やファイルが成果物になかったときは `UNVERIFIED` になり、`reason` に起きたことがあります。`EVIDENCE_NOT_FOUND` は、指摘が指す記録が、どのページの記録にもなかったことです。`EVIDENCE_FILE_MISSING` は、指摘の画像などのファイルを、撮影・保存できなかったことです。指摘そのものは、`basis` の方法で見つけたものです。

性能の観測の範囲（`summary.json` の `webVitalsCoverage`。2026-11-09 から）:

- 性能の指標（LCP・FCP・CLS・TTFB・INP）ごとに、測れた数（`observed`）、測れなかった数（`notObserved`）、ブラウザが対応していない数（`unsupported`）、集められなかった数（`notCollected`）があります。数える単位は、ページと画面の幅ごとの性能の記録です。
- 測れなかったことは、良いという意味ではありません。とくに INP は、ボタンなどを押したときの指標なので、見て回るだけの点検では、ほとんど測れません。性能の指摘がないことは、測れた指標が境目を超えなかったことだけを意味します。

色の差を測れなかった所（`summary.json` の `contrastUnmeasured`。2026-11-09 から）:

- 文字の色と後ろの色の差を、axe（色の差などを調べる道具）が測れなかった所の数（`nodeCount`）と、理由ごとの数（`byReason`）です。理由は `messageKey` に入っています。例えば、`bgImage` は後ろが画像、`bgGradient` は後ろが色の移り変わり（グラデーション）、`bgOverlap` は別のものが重なっている、`fgAlpha` は文字の色が透けている、です。理由が分からないものは `null` です。
- 測れなかった所は、指摘にしていません。差が足りない（境目より下）とも、足りているとも言えません。差が足りない所は、これまでどおり指摘（`COLOR_CONTRAST_VIOLATION`）になります。
- HTML の報告には出しません。

確かめの中身（`page.json` の accessibility の記録。2026-11-09 から）:

- axe が見つけた要素ごとに、確かめの一覧（`checks`）があります。1 つの確かめには、名前（`id`）、axe の結果（`result`。`FAILED` は問題あり、`UNDETERMINED` は測れなかった）、測れなかった理由（`messageKey`）、測った値（`data`）があります。
- `data` には、決めた値だけを残します。色の差では、文字の色（`fgColor`）、後ろの色（`bgColor`。どちらも透け具合を合わせた後の色）、測った差（`contrastRatio`）、必要な差（`expectedContrastRatio`）、文字の大きさ（`fontSize`）と太さ（`fontWeight`）、文字の影の色（`shadowColor`）です。ほかの確かめでは、`data` は空です。
- 長い値を途中で切ったときは、`truncations` に、切った所（`field`）、元の長さ（`originalLength`）、残した長さ（`keptLength`）があります。
- 色の差の要素には、押せない状態かどうかの事実（`disabledFacts`）があります。`disabledForAssistiveTech` が真のものは、読み上げのソフトなどにも押せないと伝わっている要素で、指摘の数に入れません（`countExclusion` が `DISABLED_FOR_ASSISTIVE_TECH`）。`disabledStateNotExposed` が真のものは、見た目は押せない形なのに、読み上げのソフトなどに押せないと伝わっていない要素で、指摘はそのまま残し、そのことを指摘の文に書きます。色が薄いだけのものは、どちらにもしません。

同じ作りの所の候補群（`finding-groups.json`。2026-11-09 から）:

- 同じ Rule で、同じ要素の目印（selector など）を持つ指摘を、1 つの群にまとめたものです。ページや画面の幅が違っても、同じ作りの所なら同じ群になります。
- 群ごとに、群の ID（`groupId`）、影響したページ（`pageIds`・`pageCount`）、出た数（`occurrenceCount`）、画面の幅（`viewports`）、確かめ方の数（`verification`）、画像などのファイルを撮影・保存できなかった指摘の数（`missingEvidenceFindingCount`）、確からしさ（`confidence`: `HIGH`・`MEDIUM`・`LOW`）があります。
- 要素の作り（タグの名前と class の並び。`structure`）が分かる指摘は、目印の番号（`:nth-of-type(2)` など）を `n` にまとめ、作りが同じものだけを同じ群にします。例えば、ページごとに番号の違う同じカードは 1 つの群です。作りの違う要素は、別の群です。作りの印には、文字の中身や、class のほかの属性の値は入れません。
- 群の指摘は、指摘のファイルの指摘ごとの `groupId` で分かります（2026-11-15 から。前は群ごとに指摘の ID の全部 `findingIds` を持っていました）。
- 作りが分からない指摘は、番号をまとめないので、番号だけ違う所は別の群です（`structure` は `null`）。目印のない指摘は、1 件だけの群です。
- axe（色の差などを調べる道具）の指摘は、対象の目印の番号と、表示の順で替わる id（`:r1:` の形など）をまとめた形で群にします（2026-11-19 から）。共通の枠の同じ部品の指摘は、全部のページで 1 つの群です。この鍵は `groupingKeys` の `roundedTarget` で、値は目印をまとめた形の digest です（属性の値を書いた目印も入るため）。名前の不一致の指摘は、目印と区分（`labelClass`）の両方で群にします（区分が違えば別の群、区分が同じでも違う部品なら別の群）。指摘の `fingerprint` は変わりません。
- 名前の不一致の指摘（`A11Y_LABEL_CONTENT_NAME_MISMATCH`）は、見える文字の先頭のかたまり（区切りの記号だけのかたまりは除く）が、書き方（全角と半角、空白、区切りの記号、日付の書き方）をそろえても読み上げの名前にないとき（区分 `MAIN_LABEL_MISSING`）と、名前か見える文字を読めず比べられないとき（区分 `UNDETERMINED`。確からしさを 1 段下げます）だけ作ります（2026-11-20 から）。見える文字の全部が名前にあるもの、書き方の違いだけのもの、先頭は名前にあり後の補足の文字（役割・件数など）だけがないものは、指摘にしません。axe の違反そのものは、`page.json` の axe の記録に残ります。
- 同じ題名のページの指摘（`DUPLICATE_PAGE_TITLE`）は、違う画面どうしだけを指摘にします（2026-11-20 から）。データ（番号・日付・ID など）を除いた path が同じページ（query だけ違う画面・記録の番号だけ違う画面）は、重なりの相手にしません。相手が残らなければ指摘しません。違う画面どうしの同じ題名の指摘は、題名ごとに 1 つの群にまとめます（群の鍵は `groupingKeys` の `sameTitle`。値は題名の digest）。相手の全部と画面の作りの鍵が同じときは、「同じ画面の別のデータ」として 1 つの群にまとめ、確からしさを 1 段下げ、文で分けます（区分は `findingClass` の `SAME_TEMPLATE`、群の鍵は `sameTemplate`。値は digest）。指摘の `fingerprint` は変わりません。
- HTML の報告のまとめの段には、問題を同じ作りの所でまとめた数を「同じ作りの所でまとめると N か所です。」と出します。
- 群は重さの順に並びます。数や確からしさでは並べ替えていません。確からしさは目安で、直す順番の優先度ではありません。

読む順は、`summary.json` → `findings-by-rule.json` → `finding-files.json` と指摘のファイル → `finding-groups.json` → `pages.json` → `page.json`・`visible-text.txt`・スクリーンショットです。指摘の Evidence は、指摘の `evidence` の `path` と `pointer` で `page.json` の中をたどります。指摘のファイルには、同じ Rule の指摘がページごとに繰り返し並ぶので、全体の傾向は `findings-by-rule.json` の `main` と `finding-groups.json` で見てください。

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
- Finding の文言（日本語）は、指摘のファイルと、`findings-by-rule.json` の例に、そのまま入ります。
- ページの HTML などの、生の応答の本文は含めません。
- ただし、各ページの `page.json` には、ページの可視テキストと URL が入ります。

アップロードする前に、バンドルの中身が、ChatGPT に渡してよい内容かを確かめてください（「[成果物を外へ渡す前の確かめ](anonymization.md)」）。認証つきの監査のバンドルには、管理画面の可視テキストとスクリーンショットが入ります。

## 書き込みの報告

承認された登録（CREATE）と更新（UPDATE）のジョブ（「[承認された登録の手順](approved-create.md)」「[承認された更新の手順](approved-update.md)」。点検のまとめて実行の書き込みの段も、段ごとに 1 つのジョブです）は、Run のディレクトリに、次のファイルを書きます。書くのは監査のワーカーで、Run の終わり（結果の判定と照合の READ の後）に書きます。

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
| `approval-summary.json`（`approval-summary-schema/1.0`） | シナリオの ID・版・種類、承認の記録（記録の ID、承認の digest、縛った事実、承認した日時、期限、承認者 `LOCAL_OPERATOR`）、開始の時点で撤回されていたか、入力の規則の参照、件数の上限と承認の期限の日数（2026-11 からは判定に使わない名残の値。HTML の報告には 1 回の件数だけを出します）、副作用の確認、実行の許可（出した日時、期限、使った日時）、件数の予約（件数、予約した日時）、開始の時点の累積の件数、「人が決めたこと」と「BeakSight が自動で行ったこと」の一覧。値はすべて、書き込みを始めた時点のものです。予約の締めと累積の件数の確定の値は、画面（書き込みの結果と台帳）で確かめます。 |
| `action-report.html` | 結果、注意（結果が分からない・照合できていない、人が入れた値が入りうる）、送る前の確かめ、送信と送った値、応答、前後の差分（更新だけ）、照合の READ、送信の見張り（Guard）の記録、承認の要約、人が決めたことと BeakSight が自動で行ったこと。 |
| 書き込みのバンドル | 目録（`manifest.json`。各ファイルの大きさと SHA-256、人が入れた値が入りうるかとその注意）、`action-run.json`、`action-evidence.json`、`approval-summary.json`、`action-report.html`。中の JSON と HTML は、Run のディレクトリのファイルと同じバイト列です。同じ記録からは、同じバイト列の ZIP になります。 |

- **人が入れた値**: 更新の変えた欄の前の値と、照合の READ で画面から読んだ値は、BeakSight が作った値ではなく、テスト環境で人が入れた値かもしれません。この値があるときは、`containsHumanEnteredValues` が真になり、HTML の先頭とバンドルの目録に注意を出します。
- **送った値**: 送った値は、入力の規則で作った合成のテストデータで、平文で入ります。
- **入らないもの**: 資格情報、Cookie、CSRF のトークン、hidden・readonly の欄の値、保つ欄の値、`lock_version` は、どのファイルにも入りません（読むだけで記録しません）。

### 報告を配らない場合

画面のサーバ（親）は、書き込みの結果を締めるときに、報告のファイルを確かめます（報告の確かめ）。結果は、ジョブの画面の「書き込みの報告」に出ます（たたんだ「詳しい内容」の中）。確かめ済みの報告は、作業の画面の主のボタン「結果を見る」でも開きます。

| 報告の確かめ | 意味 |
| --- | --- |
| 確かめ済み | 報告のファイルが、結果と開始の時の承認に合い、バンドルが報告のファイルから組み立て直したものと 1 バイトも違わないことを確かめました。報告を配ります（「報告を開く」「報告のまとめファイル（ZIP）をダウンロードする」）。 |
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

管理画面の「監査済みデータの台帳」（`/ledger/<profileId>`。画面では「作ったデータの一覧」）は、BeakSight が登録したかもしれないデータの一覧です（承認した書き込みのモードのプロファイルだけ）。画面だけで、ファイルには書き出しません。列と読み方は「[監査済みデータの台帳](local-ui.md#監査済みデータの台帳)」と「[リスクと監査の記録](risks-and-audit-logs.md#監査済みデータの台帳の読み方)」にあります。

## パフォーマンスの値（RUM/APM）について

BeakSight のパフォーマンスの値は、監査の実行の中で、ブラウザがページを開いたときに測った、合成の計測（Synthetic）の値です。

- 実際の利用者の環境で測った値（RUM）ではありません。値は、実行した環境やネットワークに左右されます。
- 時間の値（TTFB、読み込みの完了、資源の応答の時刻など）は、BeakSight の出口の中継（127.0.0.1 の proxy）を通した値です。中継の分だけ遅く出ます（テスト用の小さなサイトで、TTFB は数 ms。「[出口の中継と計測値](safety.md#出口の中継と計測値)」）。
- 同じ測定で、時間の値のほかは、中継を通さない場合と同じでした。高い頻度でポーリングするページなど、既知の違いは「[中継を通さない場合との既知の違い](safety.md#中継を通さない場合との既知の違い)」にあります。
- APM の値でもありません。Navigation Timing、Resource Timing、`Server-Timing`、`traceparent` などは、ブラウザから見える範囲の記録です。サーバの内部の記録（データベースの処理の時間など）は含みません。
- パフォーマンスの Finding（例: `POOR_LCP`）の重大度は、警告です。
- 観測できなかった値は、0 などで埋めずに「未観測」と示します。
