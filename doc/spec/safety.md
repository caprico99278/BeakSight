# 読み取り専用と安全

BeakSight が保証する読み取り専用の範囲と、保証できない範囲、headed で実行するときの注意、Safety Ledger（安全の記録）の読み方です。

[README に戻る](../../README.md)・[仕様の索引](README.md)

## 読み取り専用の保証の範囲

BeakSight は、サイトの状態を変える操作をしないように作っています。

- ページを観測する段階（Passive）では、ネットワークへのリクエストを `GET` と `HEAD` に限ります。ページの要求は、Guard が CDP の横取り（すべての要求）と Playwright の route の 2 段で判定し、`GET` と `HEAD` 以外は、送る前に止めて記録します。ページを離れるときの送信（`sendBeacon`、keepalive の `fetch`、`fetchLater()`）も、止めます（DEF-038、DEF-042）。
- CORS の事前確認（`OPTIONS`）は、Guard が代わりに応答し、サーバに送りません。
- ページ（文書）が開く WebSocket の接続は、止めます。Dedicated Worker の中で開く WebSocket の接続は、BeakSight が文書と Worker に加える通信の制限（CSP の `connect-src`）で止めます（DEF-040）。
- Shared Worker は、Chromium の起動の設定で無効にします（ページからは `SharedWorker` がない状態に見えます）。Shared Worker の中の通信は、Guard の判定を通らないためです。Shared Worker がないときに別の仕組み（Dedicated Worker など）に切り替えるページは、そのまま動きます。切り替えないページでは、Shared Worker に依存する機能が動かないので、監査の結果が、ふつうのブラウザで見た場合と変わることがあります。万一 Shared Worker が作られた場合は、安全の不変条件の違反（`SHARED_WORKER_OBSERVED`）として記録し、その時点のブラウザの環境を閉じて、Run を止めます（DEF-044）。
- Service Worker は登録させません。ブラウザの環境の Service Worker の遮断に加えて、BeakSight が、すべての文書（iframe を含む）で Service Worker の登録の入口を塞ぎます。遮断を迂回する書き方で登録しようとしても、例外になります（その例外は、ページのコンソールに出ます）。Service Worker の中の通信は、Guard の判定を通らないためです。万一 Service Worker が登録された場合は、安全の不変条件の違反（`SERVICE_WORKER_OBSERVED`）として記録し、その時点のブラウザの環境を直ちに閉じて、Run を止めます（DEF-049）。
- 許可 Origin の外へのページの移動は、遮断します。巡回でたどるのは、許可 Origin の中の通常のリンクだけです。
- Interaction（開閉のボタンなどの操作）は、ページを観測する環境とは別の、使い捨ての環境で行います。操作の前に通信を止め、操作の後の通信、ページの移動、ダウンロード、WebSocket を遮断します。さらに、この環境の通信は BeakSight 自前の中継（127.0.0.1 の proxy）を通り、通信を止めた（凍結した）後は、中継がすべての通信をネットワークの層で拒みます（DEF-039）。凍結の前の通信は、中継（BeakSight の Node.js のプロセス）が Chromium の代わりにサイトへ TCP の接続を開いて通します。接続は同じコンピュータから出るので、サイトから見える接続元は変わりません。ページが開いたポップアップは、記録して、その中の通信を止め、環境と一緒に閉じます（DEF-036）。
- 送信のボタン、フォームに属する要素、ほかのページへ移動するリンク、ダウンロード、外部の Origin や特殊なスキーム（`tel:`、`mailto:` など）へ作用する要素は、操作しません。
- フォームの送信、ダウンロード、外部のアプリの起動は行いません。ブラウザの環境は、ダウンロードを受け付けない設定で作ります。

保証できない範囲もあります。

- サーバの側で副作用を持つ `GET` のエンドポイントがあっても、クライアントの側からは見分けられません。
- ページ自身が読み込む、ほかの Origin のリソース（画像、スクリプト、iframe など）への `GET` は、送られます。遮断するのは、許可 Origin の外へのページそのものの移動です。
- ページのスクリプトによる外部スキームへの移動は、止められません。headed でも headless でも、外部のアプリが起動する可能性があります。BeakSight は、この移動を検出したら、安全の不変条件の違反として Run を止めます（「[headed で実行するときの注意](#headed-で実行するときの注意)」）。
- SVG 文書の中のスクリプトが作る Worker が開く WebSocket の接続は、止められません。SVG 文書には、通信の制限（CSP）を入れられないためです。
- Worker の中の WebSocket を止めた記録（理由 `WORKER_CONNECT_POLICY`）は、観察によるもので、止めた接続のすべてが残るとは限りません。
- Interaction の中継の記録（`blockedInteractionRequests` の理由 `INTERACTION_FROZEN_EGRESS`）のうち、`CONNECT` の記録は `host:port` だけで、https か wss か、パスは分かりません。Chromium 自身の通信（例: Google への接続）が、凍結の後の中継の記録に載ることがあります。そのため、中継の記録（`INTERACTION_FROZEN_EGRESS`、`EGRESS_UPSTREAM_DENIED`）は、Interaction の結果の区分（操作の後の通信を遮断した `BLOCKED_BY_SAFETY`）には使いません。記録は Safety Ledger に残ります（DEF-046）。
- Guard が通信を止めてから、中継が通信を止めるまでの数ミリ秒の間に、Guard を通らずに出た要求は、止められません。
- 万一 Service Worker が登録された場合、BeakSight はそれを検出してブラウザの環境を閉じますが、閉じる前に、Service Worker の script の `GET` と、まれに Service Worker の最初の要求が、サーバに届く可能性があります（DEF-049。検出と停止であり、送信を止める保証ではありません）。
- ブラウザの環境を閉じる途中に出た通信は、試した範囲ではサーバに届いていません。ただし、ブラウザの仕組みとして保証されたものではありません（DEF-036、DEF-038 の残る制約）。
- headed で、利用者がブラウザの画面を閉じた場合は、ページを離れるときの通信（アクセス解析の送信など）が、止まらない可能性があります（DEF-038 の残る制約）。

## headed で実行するときの注意

**headless での実行を勧めます。** 既定値は headless です。
headed では、ブラウザの環境（Context）を作るたびに、ブラウザのウィンドウが開きます。そのため、実行中は、画面がほぼ使えません。
外部のアプリの扱い（下の項目）は、headed と headless で同じです。headless を勧めるのは、外部のアプリのためではありません。
実行中は、ブラウザの画面（タブやウィンドウ）を閉じたり、停止・再読み込みしたりしないでください。止めるときは、端末で Ctrl+C を使います（「[中断と再開](resume.md#中断と再開)」の「Ctrl+C で止める」）。

- ページのスクリプトが外部スキーム（`mailto:`、`tel:` など）へ移動しようとした場合、BeakSight はその移動を止められません。外部スキームへの移動は、ネットワークを通らないためです。
- BeakSight は、headless でも、headed と同じ通常の Chromium を使います。そのため、headed（`--headed`、または `browser.headed: true`）でも headless でも、メールのアプリや電話のアプリなどの、外部のアプリが起動する可能性があります。
- この移動の試みを検出した場合は、headed と headless を問わず、安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）として記録します。その時点で、そのブラウザの環境を閉じます。Run は `ABORTED_BY_SAFETY`（終了コード 3）になります。止められない経路なので、外部のアプリが起動した可能性を隠さずに、Run を止めます。起動そのものは、防げません。移動の試みは、Safety の記録（外部スキームへの移動の試み）にも残します。
- ページのスクリプトが新しいウィンドウ（`window.open` や `target="_blank"` のリンク）で外部スキームを開こうとした場合は、この違反に加えて、`FRAME_CLASSIFICATION_FAILED` の違反も記録します。新しいウィンドウの移動は、どの frame の移動かを判定できないためです。
- サーバのリダイレクトによる外部スキームへの移動（3xx の `Location` が外部スキーム）は、ブラウザがたどる前に止めます。この経路は、止めて防げるので、headed でも headless でも違反にしません。記録の理由は `EXTERNAL_SCHEME_REDIRECT_BLOCKED` です。
- 外部のアプリの起動を避けたい場合は、headed と headless を問わず、`mailto:` や `tel:` の既定のアプリがない、隔離した環境（仮想マシンなど）で実行してください。

## Safety Ledger の読み方

Safety Ledger は、Guard（安全の確認の仕組み）が止めた操作と、安全の不変条件の違反の記録です。
要約は `run.json` の `safety` に、事象の一つ一つは各ページの `page.json` の安全の記録（Evidence）にあります。
HTML レポートでは「安全」の節に示します。

| 項目（`run.json`） | レポートの表示 | 読み方 |
| --- | --- | --- |
| `guardEnabled` | 安全の確認: 有効 / 無効 | Guard が有効だったか。 |
| `blockedActions` | 遮断した操作 | リクエスト、ナビゲーション、外部への作用、ポップアップ、ダウンロード、WebSocket の、遮断した件数。リクエストの件数（`requests`）には、Guard が止めた記録のほかに、Interaction の中継が拒んだ記録（下の `INTERACTION_FROZEN_EGRESS`）も含みます。 |
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
| `blockedWebSockets` | 遮断した WebSocket。理由 `WORKER_CONNECT_POLICY` の記録は、Worker の中の WebSocket を止めた記録です（下の説明）。 |
| `blockedExternalActions` | 実行しなかった外部への作用 |
| `excludedInteractionCandidates` | 除外した Interaction の候補 |
| `blockedInteractionRequests` | 操作中に遮断したリクエスト。理由 `INTERACTION_FROZEN` は Guard が止めた記録、`INTERACTION_FROZEN_EGRESS` は中継が拒んだ記録、`EGRESS_UPSTREAM_DENIED` は中継の上流の方針で拒んだ記録です（下の説明）。 |
| `blockedInteractionNavigations` | 操作中に遮断したナビゲーション |
| `blockedPopups` | 遮断したポップアップ |
| `blockedDownloads` | 遮断したダウンロード |
| `blockedInteractionWebSockets` | 操作中に遮断した WebSocket。理由 `WORKER_CONNECT_POLICY` の記録は、Worker の中の WebSocket を止めた記録です（下の説明）。 |
| `externalSchemeNavigations` | 外部スキームへの移動の試み |

操作中に遮断したリクエスト（`blockedInteractionRequests`）は、理由で見分けます。`run.json` の `safety.blockedActions.requests` の件数には、Guard が止めた記録に加えて、中継が拒んだ記録も含みます。

- `INTERACTION_FROZEN`: Interaction の通信を止めた（凍結した）後に、Guard（CDP の横取りと route）が止めた記録です。
- `INTERACTION_FROZEN_EGRESS`: 凍結の後に、Interaction の環境の通信を通す BeakSight の中継（127.0.0.1 の proxy）が拒んだ記録です。Guard を通らずに出た要求の証拠です。`CONNECT` の記録の URL は `host:port` の形で、https か wss かは分かりません。Chromium 自身の通信が載ることもあります（「[読み取り専用の保証の範囲](#読み取り専用の保証の範囲)」）。
- `EGRESS_UPSTREAM_DENIED`: 中継の上流の方針で拒んだ記録です。通常は出ません。

遮断した WebSocket（`blockedWebSockets`）と、操作中に遮断した WebSocket（`blockedInteractionWebSockets`）には、理由 `WORKER_CONNECT_POLICY` の記録があります。Worker の中で開いた WebSocket を、BeakSight が文書と Worker に加える通信の制限（CSP の `connect-src`）が止めた記録です。この記録は観察によるもので、止めた接続のすべてが残るとは限りません（「[読み取り専用の保証の範囲](#読み取り専用の保証の範囲)」）。

外部スキームへの移動の試みは、理由で見分けます。

- `EXTERNAL_SCHEME_NAVIGATION`: ページが移動を試みた記録です。止められない経路です。headed でも headless でも、外部のアプリが起動した可能性があります。そのため、安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）も記録し、Run は `ABORTED_BY_SAFETY` になります。
- `EXTERNAL_SCHEME_REDIRECT_BLOCKED`: サーバのリダイレクトを、ブラウザがたどる前に止めた記録です。
