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
- Guard の付いたすべてのブラウザの環境（Context）の通信は、BeakSight 自前の中継（127.0.0.1 の proxy）を通ります（DEF-085）。ページを観測する環境（公開の監査、認証つきの監査、ログインの段、操作の候補の発見、READ の確かめ）も、Interaction の環境も同じです。Guard の判定は、これまでどおり行います。
- Guard は、環境を閉じる前に、中継を凍結します。凍結した中継は、すべての通信を拒みます。ページが同じタスクの中で 2 つ目のポップアップを開くと、環境を閉じる途中に、そのポップアップの要求が Guard の横取りを外れて、読まない URL や別の Origin へ届くことがありました（DEF-085）。その要求を、凍結した中継が拒みます。
- 閉じる直前に凍結した中継が拒んだ要求は、Safety Ledger に記録しません。閉じる途中の要求が、Guard の許した普通の要求（ポーリングなど）か、横取りを外れた要求かを、中継からは見分けられないためです。DEF-085 の場面の証拠は、Guard の違反（`PASSIVE_GUARD_PAGE_NOT_READY`）と、遮断したポップアップの記録に残ります。中継が閉じた後に出ようとした要求も、届きませんが、記録は残りません。
- Guard が横取りを付け終える前のページ（ポップアップの最初の要求など）のナビゲーションは、Playwright の route だけが見ます。Guard は、その要求を、frame の判定の成否に頼らずに止め、違反（`PASSIVE_GUARD_PAGE_NOT_READY`。URL つき）を記録して、その環境を無効にします（DEF-113）。
- ページを観測する環境とログインの段の中継は、Guard の許さない method や URL の要求を拒み、理由 `GUARD_BYPASS_EGRESS` で記録します（「[Safety Ledger の読み方](#safety-ledger-の読み方)」）。
- 操作の候補の発見の凍結（ページを観測する環境の凍結）では、Guard と一緒に中継も凍結します。その後に中継が拒んだ要求は、Interaction の凍結と同じく、理由 `INTERACTION_FROZEN_EGRESS` で記録します。
- 中継を通るので、時間の計測値は、中継の分だけ遅く出ます。接続できない相手の記録のされ方、名前の解決、診断の記録の接続先も変わります（「[出口の中継と計測値](#出口の中継と計測値)」）。
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
- 操作の的の要素（Interaction の対象、書き込みの段の入力の欄と送信のボタン）は、操作のたびに、確かめた時の要素と同じかを照らします。ページが同じ位置の要素を入れ替えても、別の要素を操作の的にはしません（独立レビュー T32R の I-1）。ただし、キーボードの入力（値を入れる操作）は、その時に focus のある要素に入り、ページのスクリプトは focus を別の要素へ移せます。そのため、生成した値が、ページの選んだ別の要素（form の外の要素を含む）に入ることがあります（T32R2 の I-1）。送る中身は、入れた後の値の読み直しと、Guard の照合（承認した送信先と値）が守ります。承認の外の送信は届きません。ほかに、次の点が残ります。照らした後に Playwright が送るクリックなどの事象は、ふつうの Playwright の操作と同じく、ページのスクリプトから見えます。hover の状態（`:hover`）は照らしません。照らすための目印の名前は、ページのスクリプトから読めない前提です（毎回変わる乱数で、ページに置きません）。目印を外すのに失敗しても、害はありません。
- 万一 Service Worker が登録された場合、BeakSight はそれを検出してブラウザの環境を閉じますが、閉じる前に、Service Worker の script の `GET` と、まれに Service Worker の最初の要求が、サーバに届く可能性があります（DEF-049。検出と停止であり、送信を止める保証ではありません）。
- ブラウザの環境を閉じる途中に出た通信は、試した範囲では、閉じる前に凍結した中継が拒み、サーバに届いていません（DEF-085）。ただし、ブラウザの仕組みとして保証されたものではありません（DEF-036、DEF-038、DEF-085 の残る制約）。
- headed で、利用者がブラウザの画面を閉じた場合は、ページを離れるときの通信（アクセス解析の送信など）が、止まらない可能性があります（DEF-038 の残る制約）。

## 出口の中継と計測値

Guard の付いたすべてのブラウザの環境の通信は、BeakSight 自前の中継を通ります（「[読み取り専用の保証の範囲](#読み取り専用の保証の範囲)」。ユーザーの判断 2026-10-12）。そのため、公開の監査と認証つきの監査の時間の計測値は、中継の分だけ遅く出ます。監査の結果（Finding、HTTP の状態、Run の結果）は、中継を通さない場合と同じになるように作っています。ただし、違いの残る場合があります（下の「[中継を通さない場合との既知の違い](#中継を通さない場合との既知の違い)」）。

- サイトへの TCP の接続は、Chromium の代わりに、中継（BeakSight の Node.js のプロセス）が開きます。中継は同じコンピュータの中にあるので、サイトから見える接続元（IP アドレス）は変わりません。

### 時間の計測値

- 遅く出る値: TTFB、読み込みの完了、資源の応答の時刻など、時間の計測値です。
- テスト用の小さなサイト（同じコンピュータの中）での測定では、TTFB が数 ms（2.9〜5.9 ms）遅く出ました。読み込みの完了と資源の応答の終わりは、10 ms 前後遅く出ました。どれも、同じ条件の 5 回の揺れの幅を超えた違いです。
- 同じ測定で、Finding、HTTP の状態、資源の数と大きさ、サーバに届いた要求、Safety Ledger、CLI の出力は、中継を通さない場合と同じでした。
- 中継の失敗の伝え方を直した後に、もう一度測りました（CLI の Chromium、テスト用のサイトの `full-crawl` の設定、中継なしと中継ありを交互に 3 回ずつ）。違ったのは、時間の値だけでした。Finding、HTTP の状態、資源の数と大きさ、サーバに届いた要求、Safety の記録は同じでした。
- 実際のサイトでは、HTTP/3 を使わなくなる見込みです（推測。Chromium は、中継の先に QUIC を使わないためです）。名前の解決も中継が行います（下の「名前の解決」）。実際のサイトでの遅れの大きさは、測っていません。

### 上流の失敗の伝え方

- ページを観測する環境（Passive）とログインの段の環境の中継は、サイトとの間の失敗を、そのまま Chromium に伝えます。中継が代わりの応答（502 など）を作ることはありません。
- 接続できない相手（接続の拒否、名前を解決できないなど）: 中継は、Chromium との接続を切ります。そのため、接続の拒否は、中継を通さない場合の `net::ERR_CONNECTION_REFUSED` ではなく、`net::ERR_CONNECTION_RESET` として記録されます。どちらも網の層の失敗として扱うので、サイトの不調の判定は同じです（「[サイトが応答しないとき](site-unavailability.md)」）。
- 接続の拒否は、中継を通さない場合より速く失敗として終わります。
- 応答の本文が途中で切れた場合（`Content-Length` より短い、chunked の途中の切断）: 中継も Chromium への応答を途中で切ります。中継を通さない場合と同じく、失敗として終わります。
- http のサイトの応答（ページを観測する環境とログインの段）: 中継は、サイトの応答を読み直さずに、受けた bytes をそのまま Chromium へ流します。応答を読むのは Chromium なので、応答の読み方（理由の文字列、ヘッダの並び、変わった形の応答の扱い）は、中継を通さない場合と同じです。https の通信は、中継は中身を見ずにそのまま通します。
- HTTP/1.1 のパイプライン（前の応答を待たずに、同じ接続で続けて送る要求）は、中継が扱いません。Chromium はパイプラインを使いません。
- 同じ中継は、Chromium の要求のヘッダを、`MAX_EGRESS_HTTP_HEADER_BYTES`＝256 KiB まで、寛容な読み方で読みます（Chromium が読む応答のヘッダの上限と同じ大きさです）。大きな Cookie のついた要求も、中継が拒まずに通します。
- Interaction の環境の中継は、今までどおりです。サイトに接続できないときは、中継が 502 を返します。

### 名前の解決

- サイトの名前の解決は、Chromium ではなく、中継が行います（OS の名前解決を使います）。
- `localhost` とその下の名前（例 `app.localhost`）は、OS に問い合わせずに、ループバックのアドレスへ接続します。中継を通さない Chromium と同じ扱いです。末尾に `.` のついた名前（`localhost.`、`app.localhost.`）も同じです。

### 診断の記録の接続先

- サイトの不調の診断の記録（「[サイトが応答しないとき](site-unavailability.md)」）の、接続先の IP アドレスと port（`remoteIpAddress`、`remotePort`）は、中継が覚えた、サイト（上流）の相手のアドレスです。中継が覚えていなければ、空（`null`）です。
- Interaction の環境の記録には、中継の待ち受けのアドレス（127.0.0.1 と、その port）が出ます。

### 中継を通さない場合との既知の違い

- 時間の計測値が、中継の分だけ遅く出ます（上の「時間の計測値」）。
- 接続の拒否のエラーの名前が `net::ERR_CONNECTION_RESET` になります（上の「上流の失敗の伝え方」。判定は同じです）。
- 2 つの Origin へ高い頻度でポーリングするページは、中継の負荷で監査が遅くなり、Run が `PARTIAL` になることがあります（DEF-091）。テスト用のサイトで、5 ms ごとに 2 つの Origin へ fetch するページでは、中継なしは約 6 秒で `COMPLETE`、中継ありは約 10 秒で `PARTIAL`（性能の記録の上限に達した）になりました。Finding、遮断の件数、違反は同じでした。同じ Origin だけのとき、https だけのときは、違いがありませんでした。中継が CLI と同じ Node.js のプロセスで多くの要求を処理するため、と推測しています。

## Chromium 自身の Google への接続

BeakSight が使う Chromium（`channel: 'chromium'`）は、何も設定しないと、監査と関係なく、自分で Google へ接続しようとします。監査対象のサイトへの要求ではありませんが、第三者への送信になるので、Chromium の起動の設定で止めます（DEF-070）。

- 止めるもの: 時刻の問い合わせ（`clients2.google.com`）、検索エンジンへの先回りの接続と AI Mode の可否の問い合わせ（`www.google.com`）、form のあるページのたびの autofill の問い合わせ（`content-autofill.googleapis.com`。form と欄の署名を含みます）、起動のときの Google のアカウントの一覧の問い合わせ（`accounts.google.com`）、プッシュの通知の仕組み（GCM）の checkin（`android.clients.google.com`）。
- 止め方: autofill などの機能を、Chromium の feature の指定（`--disable-features`）で止めます。この指定は、Playwright が既定で止めている feature も、すべて含みます（含めないと、Playwright の既定が上書きされ、`http://` のページを `https://` で開こうとするなど、監査の振る舞いが変わるためです）。アカウントの一覧と GCM の checkin は、向け先を、この PC の中の使われない宛先（`http://127.0.0.1:9`）に変えます。
- この PC の 9 番のポートで何かが待ち受けている場合は、Chromium 自身のアカウントの一覧や GCM の問い合わせが、そこへ届く可能性があります（試した範囲では、9 番のポートで待ち受けても、何も届きませんでした。Chromium が 9 番のポートを危ないポートとして扱い、接続しないためと推測しています）。
- 変わらないもの: ページ自身が読み込む Google のリソース（「Google でログイン」のボタンの script や iframe など）は、これまでどおり読み込みます（ほかの Origin のリソースへの `GET` と同じ扱いです）。スクリーンショット、DOM の Evidence、Guard の判定と記録は、止める前と同じであることを確かめました。
- 確かめた範囲: Chromium 151（Playwright 1.62.1）の headless で、起動しただけの場合、Passive の環境で form のあるページを開いた場合、Interaction の環境、ログインの段の環境のそれぞれで、Chromium 自身の外部への接続の試みが 0 件でした（インターネットへは出さず、記録用の中継で数えました）。headed では確かめていません。Chromium の版が変わると、新しい機能が別の宛先へ接続する可能性があります。

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
| `blockedActions` | 遮断した操作 | リクエスト、ナビゲーション、外部への作用、ポップアップ、ダウンロード、WebSocket の、遮断した件数。リクエストの件数（`requests`）には、Guard が止めた記録のほかに、中継が拒んだ記録（下の `INTERACTION_FROZEN_EGRESS`、`GUARD_BYPASS_EGRESS` など）も含みます。閉じる直前に凍結した中継の拒否は、記録しないので含みません。 |
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
| `blockedInteractionRequests` | 操作中に遮断したリクエスト。理由 `INTERACTION_FROZEN` は Guard が止めた記録、`INTERACTION_FROZEN_EGRESS` は中継が拒んだ記録、`EGRESS_UPSTREAM_DENIED` は中継の上流の方針で拒んだ記録、`GUARD_BYPASS_EGRESS` は Guard を通らずに出ようとした要求を中継が拒んだ記録です（下の説明）。`GUARD_BYPASS_EGRESS` の記録は、Interaction の操作に限らず、ページを観測する環境の記録にも出ます。 |
| `blockedInteractionNavigations` | 操作中に遮断したナビゲーション |
| `blockedPopups` | 遮断したポップアップ |
| `blockedDownloads` | 遮断したダウンロード |
| `blockedInteractionWebSockets` | 操作中に遮断した WebSocket。理由 `WORKER_CONNECT_POLICY` の記録は、Worker の中の WebSocket を止めた記録です（下の説明）。 |
| `externalSchemeNavigations` | 外部スキームへの移動の試み |

操作中に遮断したリクエスト（`blockedInteractionRequests`）は、理由で見分けます。`run.json` の `safety.blockedActions.requests` の件数には、Guard が止めた記録に加えて、中継が拒んだ記録も含みます。

- `INTERACTION_FROZEN`: Interaction の通信を止めた（凍結した）後に、Guard（CDP の横取りと route）が止めた記録です。
- `INTERACTION_FROZEN_EGRESS`: 凍結の後に、Interaction の環境の通信を通す BeakSight の中継（127.0.0.1 の proxy）が拒んだ記録です。Guard を通らずに出た要求の証拠になりえます。ただし、凍結の時点で進行中だった、Guard が許した普通の要求を含むことがあります（凍結で上流の接続が壊れ、Chromium が送り直すため。推測）。そのため、Guard を通らずに出た要求の証拠とは限りません。これは DEF-039・DEF-040 からの振る舞いです。`CONNECT` の記録の URL は `host:port` の形で、https か wss かは分かりません。Chromium 自身の通信が載ることもあります（「[読み取り専用の保証の範囲](#読み取り専用の保証の範囲)」）。
- `EGRESS_UPSTREAM_DENIED`: 中継の上流の方針で拒んだ記録です。通常は出ません。
- `INTERACTION_FROZEN_EGRESS` は、操作の候補の発見の凍結の後に、ページを観測する環境の中継が拒んだ記録にも使います。この記録も、Interaction の環境と同じく、凍結の時点で進行中だった普通の要求を含むことがあります（推測）。
- `GUARD_BYPASS_EGRESS`（DEF-085）: ページを観測する環境とログインの段の中継が、Guard の許さない method や URL として拒んだ記録です。Guard が許すはずのない要求が、Guard を通らずに出ようとした証拠です。Interaction の操作に限らず、ページを観測する環境の記録にも出ます。
  - `CONNECT` の記録の URL は `host:port` の形です。
  - Guard が環境を閉じる直前に凍結した中継の拒否は、どの理由でも記録しません（「[読み取り専用の保証の範囲](#読み取り専用の保証の範囲)」）。
  - 中継が閉じた後に出ようとした要求は、届きませんが、記録は残りません。

遮断した WebSocket（`blockedWebSockets`）と、操作中に遮断した WebSocket（`blockedInteractionWebSockets`）には、理由 `WORKER_CONNECT_POLICY` の記録があります。Worker の中で開いた WebSocket を、BeakSight が文書と Worker に加える通信の制限（CSP の `connect-src`）が止めた記録です。この記録は観察によるもので、止めた接続のすべてが残るとは限りません（「[読み取り専用の保証の範囲](#読み取り専用の保証の範囲)」）。

外部スキームへの移動の試みは、理由で見分けます。

- `EXTERNAL_SCHEME_NAVIGATION`: ページが移動を試みた記録です。止められない経路です。headed でも headless でも、外部のアプリが起動した可能性があります。そのため、安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）も記録し、Run は `ABORTED_BY_SAFETY` になります。
- `EXTERNAL_SCHEME_REDIRECT_BLOCKED`: サーバのリダイレクトを、ブラウザがたどる前に止めた記録です。
