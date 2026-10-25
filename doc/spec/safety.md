# 読み取り専用と安全

BeakSight が保証する読み取り専用の範囲と、保証できない範囲、headed で実行するときの注意、Safety Ledger（安全の記録）の読み方です。

[README に戻る](../../README.md)・[仕様の索引](README.md)

## 読み取り専用の保証の範囲

BeakSight は、サイトの状態を変える操作をしないように作っています。

- この章の読み取りだけの保証は、監査の段の送信の扱いが既定（`READ_ONLY`）のときのものです。`PASS_EXCEPT_DELETE` を選んだ監査では、ページが自分で出す送信の一部をサイトに届けます（「[監査の段の送信の扱い](#監査の段の送信の扱い)」）。
- ページを観測する段階（Passive）では、ネットワークへのリクエストを `GET` と `HEAD` に限ります。ページの要求は、Guard が CDP の横取り（すべての要求）と Playwright の route の 2 段で判定し、`GET` と `HEAD` 以外は、送る前に止めて記録します。ページを離れるときの送信（`sendBeacon`、keepalive の `fetch`、`fetchLater()`）も、止めます（DEF-038、DEF-042）。
- CORS の事前確認（`OPTIONS`）は、Guard が代わりに応答し、サーバに送りません。通信を止めた（凍結した）段では、事前確認も今どおり止めます。例外は、操作の候補の発見の送らずに観察する押下（probe）の観察の口が有効なときの、承認した API の Origin への事前確認だけで、これも Guard が代わりに答え、サーバへは送りません（「[SPA の画面の発見と READ](discovery-and-read-check.md#spa-の画面の発見と-read)」）。
- 例外: 認証つきの監査で、認証の設定を「スクリプトの送信」にしたプロファイルだけは、利用者が登録した読み取りの手続きの呼び出し（`POST`。fetch か XHR、登録した送信先、1 回の読み込みでの回数の中）を、ページを観測する段階でも通します。読み取りかどうかは、利用者の判断です。承認したサービスの Origin への要求には上限があります（「[スクリプトで送るログインの後の監査](authenticated-audit.md#スクリプトで送るログインの後の監査)」）。
- ページ（文書）が開く WebSocket の接続は、止めます。Dedicated Worker の中で開く WebSocket の接続は、BeakSight が文書と Worker に加える通信の制限（CSP の `connect-src`）で止めます（DEF-040）。
- Shared Worker は、Chromium の起動の設定で無効にします（ページからは `SharedWorker` がない状態に見えます）。Shared Worker の中の通信は、Guard の判定を通らないためです。Shared Worker がないときに別の仕組み（Dedicated Worker など）に切り替えるページは、そのまま動きます。切り替えないページでは、Shared Worker に依存する機能が動かないので、監査の結果が、ふつうのブラウザで見た場合と変わることがあります。そのようなページが捕捉せずに `new SharedWorker(...)` を呼ぶと、Chromium が例外（`ReferenceError: SharedWorker is not defined`）を出します。この例外は、BeakSight の起動の設定が起こしたものなので、`PAGE_ERROR` の Finding にしません（page.json の Evidence には残ります）。`new window.SharedWorker(...)` の形で呼んだときの例外（`TypeError`）は、ページ自身の例外と見分けられないので、Finding に残ります。この Finding は指摘として残り、BeakSight の遮断と指摘の関係の区分では `POSSIBLE`（理由 `DISABLED_FEATURE`。BeakSight が無効にした機能）に分かれます（「[BeakSight の遮断と指摘の関係](output.md#beaksight-の遮断と指摘の関係)」）。万一 Shared Worker が作られた場合は、安全の不変条件の違反（`SHARED_WORKER_OBSERVED`）として記録し、その時点のブラウザの環境を閉じて、Run を止めます（DEF-044）。
- Service Worker は登録させません。ブラウザの環境の Service Worker の遮断に加えて、BeakSight が、すべての文書（iframe を含む）で Service Worker の登録の入口を塞ぎます。ページの登録（遮断を迂回する書き方を含む）は、Service Worker を使えないブラウザと同じく、登録の失敗（Promise の拒否）になります。失敗の形は、Chromium が自分で登録を断るとき（クッキーを止めたとき）と同じ `NotSupportedError: Failed to register a ServiceWorker for scope ('…') with script ('…'): The user denied permission to use Service Worker.` です（Chromium 156 の chrome.exe で確かめた）。ページのスクリプトは止まらず、その後の処理を続けます。ページが失敗を受けない場合は、捕捉されない拒否としてページのコンソールに出ます。失敗の文言は、ブラウザが返す文で、BeakSight の名前を含みません。この失敗は、BeakSight の守りが起こしたもので、サイトの欠陥ではないので、捕捉されない例外の Finding（`PAGE_ERROR`）にしません（page.json の Evidence には、そのまま残ります）。Service Worker の中の通信は、Guard の判定を通らないためです。万一 Service Worker が登録された場合は、安全の不変条件の違反（`SERVICE_WORKER_OBSERVED`）として記録し、その時点のブラウザの環境を直ちに閉じて、Run を止めます（DEF-049）。
- **WebRTC は使えません。** Guard の付いたすべてのブラウザの環境（Context）で、すべての文書（iframe、ポップアップ、`about:blank` などの文書を含む）の `RTCPeerConnection`（と `webkitRTCPeerConnection`）を、WebRTC を使えないブラウザと同じく、作ろうとすると例外（`NotSupportedError`）を投げる関数に置き換え、ページから定義し直せないようにします。例外の文言は、ブラウザが返すような一般の文で、BeakSight の名前を含みません。WebRTC の通信（STUN・TURN の UDP、ICE の接続の確かめ、TURN の TCP・TLS）は、Guard の判定も出口の中継の記録も通らず、TURN のユーザー名もそのままの形でサーバに届いたためです（DEF-124。テスト用のサイトで確かめた）。重ねて、Chromium の起動の引数で、中継を通らない UDP を WebRTC に使わせません。WebRTC を使うページは、監査で動きが変わることがあります（例外はページの console に出ます）。この例外も、BeakSight の守りが起こしたものなので、`PAGE_ERROR` の Finding にしません（page.json の Evidence には残ります）。
- 許可 Origin の外へのページの移動は、遮断します。巡回でたどるのは、許可 Origin の中の通常のリンクだけです。
- ページが始めた文書の読み込み（JS の読み込み直しや移動、meta の転送。iframe などの子の frame の中も）は、frame ごとに 2 回までです（main frame は BeakSight 自身の読み込みの後、子の frame はその最初の文書の後から数えます）。超えた読み込みは Guard が止めて、理由 `PAGE_NAVIGATION_LIMIT_REACHED` で記録し、その画面を読み切れていない扱いにします（DEF-129。「[ページ自身の読み込み直しの上限](site-load.md#ページ自身の読み込み直しの上限)」）。ログインの段と書き込みの段では、この上限を置きません。
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
- ページのスクリプトによる外部スキーム（`mailto:`、`tel:` など）への移動は、Chromium の設定で止めます。外部のアプリへは渡しません。BeakSight は、この移動を検出したら、安全の不変条件の違反として Run を止めます（「[headed で実行するときの注意](#headed-で実行するときの注意)」の外部スキームの項目）。
- WebRTC の守りの範囲: `RTCPeerConnection` は Worker の中にありません（両方の Chromium で確かめた）。起動の引数が効くことは、headless の 2 つの Chromium で確かめ、headed では確かめていません。起動の引数は UDP だけを止め、TCP（TURN の TCP、`turns:`、ICE の TCP）は文書の置き換えだけで止めます。WebRTC が使われたことを BeakSight が知る仕組みはありません（自己検査はありません）。
- SVG 文書の中のスクリプトが作る Worker が開く WebSocket の接続は、止められません。SVG 文書には、通信の制限（CSP）を入れられないためです。
- Worker の中の WebSocket を止めた記録（理由 `WORKER_CONNECT_POLICY`）は、観察によるもので、止めた接続のすべてが残るとは限りません。
- Interaction の中継の記録（`blockedInteractionRequests` の理由 `INTERACTION_FROZEN_EGRESS`）のうち、`CONNECT` の記録は `host:port` だけで、https か wss か、パスは分かりません。Chromium 自身の通信（例: Google への接続）が、凍結の後の中継の記録に載ることがあります。そのため、中継の記録（`INTERACTION_FROZEN_EGRESS`、`EGRESS_UPSTREAM_DENIED`）は、Interaction の結果の区分（操作の後の通信を遮断した `BLOCKED_BY_SAFETY`）には使いません。記録は Safety Ledger に残ります（DEF-046）。
- Guard が通信を止めてから、中継が通信を止めるまでの数ミリ秒の間に、Guard を通らずに出た要求は、止められません。
- 出口の中継の上流の判定は、どの host とポートへの `CONNECT` も通します（DEF-125。保留）。今わかっている、Guard を通らない TCP の経路（WebRTC の TURN の TCP など）は、WebRTC の入口を塞ぐことで止めていますが、それが迂回された場合に残る、記録されない送信の経路です（重ねの守りがありません）。
- 操作の的の要素（Interaction の対象、書き込みの段の入力の欄と送信のボタン）は、操作のたびに、確かめた時の要素と同じかを照らします。ページが同じ位置の要素を入れ替えても、別の要素を操作の的にはしません（独立レビュー T32R の I-1）。ただし、キーボードの入力（値を入れる操作）は、その時に focus のある要素に入り、ページのスクリプトは focus を別の要素へ移せます。そのため、生成した値が、ページの選んだ別の要素（form の外の要素を含む）に入ることがあります（T32R2 の I-1）。送る中身は、入れた後の値の読み直しと、Guard の照合（承認した送信先と値）が守ります。承認の外の送信は届きません。ほかに、次の点が残ります。照らした後に Playwright が送るクリックなどの事象は、ふつうの Playwright の操作と同じく、ページのスクリプトから見えます。hover の状態（`:hover`）は照らしません。照らすための目印の名前は、ページのスクリプトから読めない前提です（毎回変わる乱数で、ページに置きません）。目印を外すのに失敗しても、害はありません。
- Service Worker の登録の入口（`ServiceWorkerContainer.prototype.register`）は、迂回を防ぐため、書き換えも定義し直しもできない形（`writable: false`・`configurable: false`）に固定しています。そのため、ページのスクリプトが `register` を自分の関数で包み直そうとすると、ページの動きが変わることがあります。原型の `register` を定義し直すと `TypeError` になり、代入は strict mode のスクリプトでは `TypeError`、そうでなければ黙って無視されます（`navigator.serviceWorker` そのものに自分の `register` を定義する形は、通ります）。WebRTC の入口（`RTCPeerConnection`・`webkitRTCPeerConnection`）も同じです。引数の誤り（引数なし、悪い URL）と別の Origin の script も、同じ登録の失敗になります（本物の Chromium では、それぞれ `TypeError`・`SecurityError` です）。
- 守りの例外（Service Worker の登録の失敗、WebRTC の構築子の例外、Shared Worker がないときの例外）を `PAGE_ERROR` の Finding にしないための見分けは、例外の名前と文言の組で行います。ページが守りの失敗を受けて、自分の例外に包み直して投げた場合（ライブラリによくある形。名前か文言が変わる）は、ページの欠陥として `PAGE_ERROR` の Finding に残ります（正しい振る舞いです）。ページが同じ名前と文言の例外を自分で投げた場合は、見分けられず、Finding になりません。Service Worker の登録の失敗の文言が記録の上限（2,048 字）を超えて切り詰められた場合（文言の長さが上限に達している場合。stack だけが切り詰められた場合は含みません）は、上限の内に scope と script の区切りがあるときだけ守りの例外とみなします。scope がとても長く、区切りが上限の外にくる場合は、見分けられないので、Finding に残します。
- 万一 Service Worker が登録された場合、BeakSight はそれを検出してブラウザの環境を閉じますが、閉じる前に、Service Worker の script の `GET` と、まれに Service Worker の最初の要求が、サーバに届く可能性があります（DEF-049。検出と停止であり、送信を止める保証ではありません）。
- ブラウザの環境を閉じる途中に出た通信は、試した範囲では、閉じる前に凍結した中継が拒み、サーバに届いていません（DEF-085）。ただし、ブラウザの仕組みとして保証されたものではありません（DEF-036、DEF-038、DEF-085 の残る制約）。
- headed で、利用者がブラウザの画面を閉じた場合は、ページを離れるときの通信（アクセス解析の送信など）が、止まらない可能性があります（DEF-038 の残る制約）。

## 監査の段の送信の扱い

監査の段の送信の扱い（`audit.sendPolicy`）は、ページが読み込みで自分で出す読み取りでない送信を、どう扱うかの設定です。既定は `READ_ONLY`（今までどおり、すべて止める）です。CLI は設定のファイルで、画面はプロファイルの設定（表示の設定の欄。承認に結ばれるプロファイルの改訂の外）で選びます。画面で `PASS_EXCEPT_DELETE` に切り替えるときは、確認のダイアログを出します。

`PASS_EXCEPT_DELETE` を選ぶと、監査・操作の候補の発見・READ の確かめの、ページを観測する環境（Passive。スクリプトで送るログインの後の監査の段を含む）で、次をすべて満たす要求をサイトに届けます。

- ページが自分で出す副資源の要求（fetch、XHR、`sendBeacon`、ping など）で、main frame と子の frame の文書の読み込みではないもの。
- method が `GET`・`HEAD` でも `DELETE` でもない（`POST`、`PUT`、`PATCH`、`OPTIONS` など）。
- 送り先の Origin は問いません（http と https の URL）。許可 Origin と承認したサービスの Origin のほか（ほかの Origin）へ通した数は、別に数えて記録します。ページを観測する段の通信は、どの宛先も BeakSight 自前の中継を通ります。
- URL の path と query に、既定の危険な語（logout、signout、sign-out、log-out、delete、remove、destroy、cancel。監査の段の除外と同じ比べ方）と、送信の扱いだけの語（sign_out、log_out）がない。監査の段の除外の読まないパスにも当たらない。送信の扱いだけの語は、既定の一覧（保存・再開の確かめ・認証の設定の検証に結ばれる）には入れていません。
- その読み込み（ブラウザの環境 1 つ）で通した数が、上限（60 件）の内。

CORS の事前確認（`OPTIONS`。`PASS_EXCEPT_DELETE` のとき）:

- 通す見込みの要求の事前確認のうち、送り先が許可 Origin でも承認したサービスの Origin でもない（ほかの Origin）ものは、Guard（BeakSight の Node.js のプロセス）が同じ形の事前確認（`Origin`・`Access-Control-Request-Method`・`Access-Control-Request-Headers` など。Cookie と `Authorization` は付けない）を、中継を通してサーバへ 1 回送り、その応答の状態と CORS のヘッダ（`Access-Control-*` だけ）でブラウザの事前確認を満たします。サーバが CORS を許さなければ、ブラウザは本番の要求を送りません（素の Chromium と同じ）。
- 応答がない・時間切れ（10 秒）・送れないときは、拒む応答（403。CORS のヘッダなし）で満たします（本番の要求は送られません）。
- 送った事前確認は、通した要求（`OPTIONS`。ほかの Origin）として記録し、その読み込みの上限（60 件）を 1 つ使います。
- 許可 Origin と承認したサービスの Origin への事前確認と、通さない本番の要求の事前確認は、今のまま Guard が許す応答を返します（サーバに送りません）。そのため、許可 Origin と承認したサービスの Origin のサーバが CORS を許さなくても、通す本番の要求は届きます。`READ_ONLY` の扱いは変えません。

次は、今までどおり止めて記録します。

- `DELETE`、危険な語の path か query の要求（ほかの Origin へのものも）。
- method の上書きで削除を伝える要求（理由は `DELETE` と同じ `NON_READ_METHOD`）: ヘッダ `X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override` の値が `DELETE`（大文字と小文字を問わない）か、form の本文（urlencoded と multipart）の `_method` の値が `DELETE` のもの。`Content-Type` のない本文（型のない Blob など）は urlencoded として読みます。JSON の本文（`application/json` と `+json`）は、最上位の鍵 `_method` の値を見ます（書き込みの段の API の照合と同じ鍵の当て方。入れ子の鍵は見ません）。form・`Content-Type` のない本文・JSON の本文が読めないとき（multipart のファイルの部分など）は、止めます（fail-closed）。上限（1 MiB）を超える本文は、本文の `_method` を調べずに通します（ヘッダの上書き、method、URL の語は今どおり調べます）。そのため、1 MiB を超える本文の中の `_method=DELETE` は止まりません（限界）。
- 文書の読み込みの `POST`（フォームの送信）。
- 上限を超えた要求（理由 `AUDIT_SEND_OVER_LIMIT`）。
- 危険な語の path か query の WebSocket の接続と、1 つの読み込みで 10 本を超えた接続（理由 `AUDIT_SEND_OVER_LIMIT`）。ダウンロード、外部のアプリの起動、ポップアップの今の扱いも変えません。
- スクリプトで送るログインの後の監査の段の、サービスの Origin へ送らない環境（幅の走査の読み込み直し）のサービスの Origin への要求。

WebSocket の接続（`PASS_EXCEPT_DELETE` のとき）:

- ページ（文書）が開く WebSocket の接続を、送り先の Origin を問わず通します。Guard の `routeWebSocket` が判定し（危険な語と上限）、中継を通してサーバにつなぎます。
- 記録は、ブラウザが実際に開いた接続から作ります（CDP の `Network.webSocketCreated`。ページを観測する環境ごとに、Guard の横取りとは別の観察の session を page に付け、別のプロセスの iframe と Dedicated Worker の target にも自動で付きます）。接続の形（`ws:`・`wss:` の Origin、path、本数）を Safety Ledger に記録します。接続の上の送受信と、query・値は記録しません。ページの記録（`page.json` の Safety の Evidence の `passedAuditSendWebSockets`）と、`run.json` の `safety.auditSend.passedWebSockets` に出ます。
- Guard の route を通らずに開いた接続（下の限界の、模擬の迂回と Worker の中の接続）には印 `outsideGuard` を、危険な語（か監査の段の除外）に当たる接続には印 `dangerous` を付けて、別の行に数えます。その数を `run.json` の `safety.auditSend.passedWebSocketsOutsideGuard`・`passedDangerousWebSockets` に残し、1 本でもあれば HTML レポート・CLI の結果・ジョブの画面に知らせを出します。止めはしません（ブラウザの環境も無効にしません）。
- そのため、この扱いの環境だけ、文書と http(s) の script の Worker に入れる通信の制限（CSP の `connect-src`）に `ws:`・`wss:` を足します。`READ_ONLY` と Interaction の環境の制限は今のままです（WebSocket は届きません。観察も付けません）。
- 限界（ユーザーの判断。止めずに検知だけ）: Guard の route は、Playwright の WebSocket の模擬（ページの `WebSocket` を置き換えた物）で判定します。ページのスクリプトは、模擬の内部の口を直に呼ぶ、判定の後に URL を差し替える、などで模擬を迂回して、本物の接続を開けます（危険な語の path や、上限を超えた本数も開けます）。Dedicated Worker（blob・data の Worker と、http(s) の script の Worker）の中の WebSocket も、Guard の route を通りません。どちらも止められませんが、上の観察で数えて印を付けます（検知は最善の努力の範囲です。下の観察の限界）。中継は、Guard が一度通した接続の宛先（host と port）のほかへの接続を拒むので、迂回した接続が届くのは、その宛先だけです。
- route を通った接続かの照らし合わせ: Guard が route で通して本物の接続を始めさせた（`connectToServer()`）後、500 ms の内に観察した同じ URL の接続だけを、route を通った接続とします。その後に開いた接続は、route の外（`outsideGuard`）です。負荷が高く観察が遅れると、route を通った接続を route の外と数えることがあります（数えすぎの側）。限界: 観察の事象は Node に届いた順で照らすので、ページが模擬の内部の口を呼んで先に開いた接続でも、その事象が `connectToServer()` の後に届くと route を通った接続と数え、印 `outsideGuard` が付かないことがあります。窓の内に Worker が同じ URL へ開いた接続も同じです。危険な語の接続には、どちらの場合も印 `dangerous` が付きます。
- 止めた記録と通した記録が両方出る場合: ページのスクリプトが模擬を迂回して本物の接続を先に開き、その後に Guard の route が危険な語や上限で模擬の接続を止めると、`blockedWebSockets`（route が模擬を止めた記録）と、通した接続の記録（印 `outsideGuard`。ブラウザが本物の接続を開いた事実）の両方が残ります。どちらも事実で、本物の接続はサーバに届いています。
- 観察の限界: Shared Worker と Service Worker の中の接続は、page の子の target でないので観察しません（Service Worker の登録は塞いであります）。観察の session を付けられなかったページ（閉じる途中など）と、ポップアップの開いた直後（観察を付ける前）の接続は、記録から漏れます。Worker の中の接続は、記録されないことが多いです。Worker の target は、観察の session と Playwright のどちらが先に進めるかが決まっていないので、Worker が動き始めた直後に開いた接続は、観察の `Network` が有効になる前で、記録から漏れます（再レビューの試験では、起動の直後に開いた 20 本のうち、記録されたのは 0〜2 本）。動き始めてしばらく後に開いた接続は、記録されます。about:blank のポップアップの realm（開いたページのスクリプトが、ポップアップの内部の口を呼んで開く接続と、その realm の Worker の接続）は、観察されません。
- 数えすぎ: 中継が拒んで届かなかった接続や、中継が拒んだ事前確認も、ブラウザが開いた・Guard が送った事実から「通した」と数えることがあります。

token の更新と、更新した状態の引き継ぎ（`PASS_EXCEPT_DELETE` のとき）:

- スクリプトで送るログインの後の監査の段の、token の更新の要求（`TOKEN_REFRESH`）も通します（`READ_ONLY` では今どおり止めます）。
- 更新で入れ替わった状態（Cookie とローカル ストレージ。許可 Origin の分だけに絞ったもの）は、Run の中で、ページを観測する環境を閉じるときに読み、次の環境に渡します（普通のブラウザが 1 つのプロファイルで状態を持ち続けるのと同じ。どちらの扱いでも、今までどおり引き継ぎます）。状態はメモリの中だけに持ち、保存（`checkpoint/`）・成果物・IPC・管理データには書きません。
- 成功の鍵（スクリプトで送るログインの成功のローカル ストレージの鍵）の判定がある設定で、読んだ状態に鍵がないときは、扱いによらず、次の環境に渡す状態を置き換えません（切れた状態で上書きしない）。そのページは、今どおりセッションの切れとして止めます。
- 成功の鍵の判定がない設定（フォームのログインなど）は、状態でログインの切れを見分けられないので、今どおり読んだ状態で置き換えます。切れは、ログインの画面の path（セッションの切れの path）で見分けて止めます。

当てない段:

- ログインの段と書き込みの段（今の決まりのまま）。Interaction（BeakSight が押す操作。読み取りだけのまま）。
- 画面から始める書き込みのジョブ・ログインの確かめ・入口の確かめは、設定のファイルの値によらず `READ_ONLY` で動きます。

記録と表示:

- 通した要求は、Safety Ledger に method・Origin・path（値に見える区切りは伏せる）・回数だけを記録し、ページの記録（`page.json` の Safety の Evidence の `passedAuditSendRequests`）に出します。本文、query の値、ヘッダの値、Cookie は記録しません。
- 記録する時点は、ブラウザが要求を送る時点です（Playwright の route の層が要求を進める時点。route を通らない要求、たとえばページを離れるときの送信と、リダイレクトの先の要求（307・308 の段）は、Guard の CDP の層が進める時点）。そのため、Guard が通しても、ブラウザから出ない要求（開いた直後の about:blank のポップアップの realm の要求など）は記録しません。上限の数は、Guard が通した時点で数えます。
- `run.json` の `safety.auditSend` に、実効の扱いと、通した数（総数と method ごと）、ほかの Origin へ通した数（`passedOtherOriginRequests`）を残します。発見と READ の確かめの結果（`discovery.json`・`read-evidence.json`）には、実効の扱い（`auditSendPolicy`）を残します。
- `PASS_EXCEPT_DELETE` のときは、HTML レポート・CLI の結果・ChatGPT 用バンドル（`summary.json` の `auditSend`）・ジョブの画面に、「この監査では、ページが出す送信のうち削除のほかを通した（N 件）」と、その内訳（ほかの Origin への送信の数と、WebSocket の接続の数）を出します。
- 通した要求は、安全の不変条件の違反にしません。止めるべき要求が届いたときは、今どおり違反です。

限界:

- 通した要求が、サイトの状態を変えることがあります（ページの自然な動きのまま送るためです）。削除と危険な語の送信だけを止めます。何が書き込みかは、method と語（と、上の method の上書き）でしか見分けません。
- 本文の中で削除を伝える要求は、見分けません。たとえば GraphQL の mutation（`deleteItem` など）や JSON-RPC の method の名前（`item.delete` など）を本文に入れた `POST` は、URL に危険な語がなければ通ります。独自の method（`PURGE` など）も、method の名前が `DELETE` でなく、URL に危険な語がなければ通ります。
- 307・308 のリダイレクトは、ブラウザが同じ method と本文で次の宛先へ送り直します。Guard は段ごとに 1 件の要求として判定し、通した段ごとに上限の数を 1 つ使い、記録も段ごとに 1 件です（危険な語の宛先へのリダイレクトは、その段で止めます）。リダイレクトの先の段は、CDP の `redirectedRequestId` か、Guard が既に進めた要求と同じ Network の要求の ID で見分けて、その段で記録します（ほかの Origin への段を含め、試験した範囲では上限の数と記録の数がそろいます。見分けられない段があれば、上限には数えて記録から漏れます）。
- ページを離れるときの送信（Task 44 の P1-2）: 監査するページのデスクトップとモバイルの読み込みを閉じる前に、まず認証の状態を読み、次にページを離れ（about:blank へ移ります。人がページを閉じるのと同じ動きです）、1 秒（`AUDIT_SEND_CLOSE_SETTLE_MS`）待ってから閉じます。ページが `pagehide`・`visibilitychange`・`unload` で出す送信（`sendBeacon`、keepalive の fetch など）は、その間に Guard の今の判定で通り、通した要求として記録されます。削除と危険な語の送信は、今どおり止めて記録します。この間も Guard の段階は変えません（閉じ始めてはいません）。about:blank への移動はサイトへの要求ではないので、読み込みの間隔とページの移動の上限には数えません。ページを離れるときに通した送信は、そのページの読み取りの判定に使う数（文書でない要求の数と上限）にも入れません（読み取りの判定は、ページを離れる前に終わっています）。通した送信の記録と、承認したサービスの Origin への要求の上限の数には、今どおり数えます。代わりに、離れた後の要求は、1 回の離れ方あたり 30 件（`PAGE_LEAVE_REQUEST_LIMIT`）までにし、超えた要求は止めて記録します（理由 `PAGE_LEAVE_REQUEST_LIMIT_REACHED`。T44R の I-1）。離れた後のそのページの文書の読み込み（ページが始めた移動、ポップアップが元のページを戻す移動）も、同じ理由で止めます。
- ページを離れる手順を行わない環境（幅の走査の読み込み、robots.txt・sitemap.xml・準備などの読み込み、Interaction、ログインの段・書き込みの段、違反などで BeakSight が自分で閉じる環境）と、閉じ始めた後にページが出す送信は、Guard が閉じる途中の要求として止めるので、届きません。止めた記録も残りません（閉じる途中の要求は記録しない、今の決まり）。試した範囲（127.0.0.1 の fixture、両方の Chromium）では、幅の走査の環境を閉じても、ページを離れるときの送信はサーバに届きませんでした。
- 上限は 1 つの読み込みごとです。ページの数が多いと、Run 全体で通す数は増えます。BeakSight が自分で送るのは、ほかの Origin への CORS の事前確認だけです（素の Chromium が送る事前確認の代わり。上限に数えます）。読み込みの間隔と読み込み直しの回数は変わりません。
- ほかの Origin への送信は、計測や外部のサービスへの送信を含みます。送り先は記録に残りますが、BeakSight はその送り先の安全を確かめません。
- token の更新を通すと、サイトの側の token が入れ替わります。状態は Run の中だけで引き継ぐので、Run を中断して再開したときは、もう一度ログインします（今どおり）。

## ページが自分で読み込む読み取りと、読まないパス・危険な語

2026-10-23 から（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` の 3.0。ユーザーの判断）、ページを観測する環境（ページの監査・幅の走査・読み直し・発見・READ の確かめ）では、ページが自分で出す文書でない `GET`・`HEAD`（スクリプト、スタイルシート、画像、フォント、動画、fetch・XHR のデータなど）に、認証の設定の読まないパス・読む範囲と、既定の危険な語（理由 `AUDIT_EXCLUDED_URL`）を当てません。送信の扱い（`READ_ONLY`・`PASS_EXCEPT_DELETE`）と、公開・認証つきによらず同じです。

- 理由: 読まないパスと危険な語は、BeakSight 自身の移動と操作（ログアウトの画面を開く、など）を防ぐための決まりです。ページが自分で読み込む資源とデータまで止めると、画面の部品が動かず、偽の指摘（スクリプトの読み込みの失敗など）が出ます。
- 今どおり当てるもの: BeakSight 自身の移動（巡回の行き先）、文書の読み込み（main frame と子の frame の移動。ページの `location.href`、リンク、iframe）、読み取りでない送信（「[監査の段の送信の扱い](#監査の段の送信の扱い)」のとおり）、Interaction の読み込み（BeakSight が押した後の要求を含む、すべての要求）、ログインの段と書き込みの段。
- 変えないもの: 許可 Origin の決まり、承認したサービスの Origin への要求の上限、1 画面の読み込みあたりの要求の上限。
- 「文書でない」の見分けは、Guard が見た要求の事実（method、ナビゲーションか、要求の種類、先読みの印のヘッダ）で、1 か所（`src/safety/request-policy.ts` の `isPageSubresourceRead`）で決めます。Guard は知らない種類を `other` として扱うので、`other` は文書でない読み取りです（アイコンや計測の GET を通すため）。文書の先回り（種類 `prefetch`・`signedexchange` と、`Sec-Purpose`・`Purpose` の `prefetch` の印のある要求。`<link rel="prefetch">` など）は、文書の読み込みと同じく当てます。
- ページの先読み（`<link rel="prefetch">` など）は、読まないパスと危険な語（と読む範囲）に当たれば止めます（2026-10-23 の BN-R1。ユーザーの判断）。先読みは今の画面の描画に使われないので、止めても画面は壊れません。通すと、ログアウトなどの除外の URL への `GET` がサーバに届くためです。実機の Chromium（156）では、`<link rel="prefetch">` の要求は、`as` の指定（`document`・`script`・`style` など）によらず同じ形で Guard に来るので、先読みの中の文書と部品（スクリプトなど）を見分けられません。そのため、部品の先読み（例: 危険な語を含む名前のスクリプトの prefetch）も止まります。`modulepreload` と `<link rel="preload">` は先読みの印を持たないので、ページ自身の部品の読み取りとして通します。
- 止めた先読みの記録（止めた要求・監査の段の除外・閉じる途中に止めた要求の各行）には、先読みの印（`speculative: true`）が付きます。BeakSight の遮断と指摘の区分では、この記録を「影響の可能性」の元にしません（今の画面の描画に使われないため）。
- 出口の中継は、Guard が通した（知らせた）ページの読み取りだけを、除外の URL でも通します。Guard を通らずに来た除外の URL への要求は、拒んで `GUARD_BYPASS_EGRESS` で記録します（2026-10-23 の BN-R0 fix round 1）。
- ページの先読み（speculation rules の prerender・prefetch）は、起動の引数で止めます。prerender だけの指定で Chromium が代わりに行う prefetch（`Prerender2FallbackPrefetchSpecRules`）も、2026-10-23 から止めます（BN-R0 の C-1。それまでは、先読みの文書の要求が Guard を通らずにサイトに届き、その後の移動がその応答で画面を移していました）。
- 限界: ページが自分で出す `GET` が、ログアウトなどでセッションを切ることがあります（人がその画面を開いたときと同じです）。そのときは、セッションの切れとして記録して止まります（「[認証つきの監査](authenticated-audit.md)」）。

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
- component の更新の問い合わせ（DEF-158。2026-10-23）: Chromium 156（Playwright 1.64.1）では、起動しただけで、component の問い合わせ（`update.googleapis.com`）が出るようになりました（既定の component の更新の停止があっても、要求に応じた component の問い合わせが出ます）。この向け先も、使われない宛先（`http://127.0.0.1:9`）に変えます（`--component-updater=url-source=…`）。同じ 4 つの場面で、外部への接続の試みが 0 件に戻ったことを確かめました（headless）。

## headed で実行するときの注意

**headless での実行を勧めます。** 既定値は headless です。
headed では、ブラウザの環境（Context）を作るたびに、ブラウザのウィンドウが開きます。そのため、実行中は、画面がほぼ使えません。
外部のアプリの扱い（下の項目）は、headed と headless で同じです。headless を勧めるのは、外部のアプリのためではありません。
実行中は、ブラウザの画面（タブやウィンドウ）を閉じたり、停止・再読み込みしたりしないでください。止めるときは、端末で Ctrl+C を使います（「[中断と再開](resume.md#中断と再開)」の「Ctrl+C で止める」）。

- 外部スキーム（`mailto:`、`tel:` など）への移動は、Chromium の設定で止めます。BeakSight は、Chromium を起動するたびに、使い捨ての一時のプロファイルを作り、http・https と Chromium が内部で使う種類（`about:`・`data:`・`blob:`）のほかの URL を止める設定を、そのプロファイルの中だけに置きます。止めた移動は、Chromium が「ブロックされています」の頁にし、メールのアプリや電話のアプリなどの外部のアプリへ渡しません。headed（`--headed`、または `browser.headed: true`）でも headless でも同じです。PC の設定（既定のアプリ、レジストリ、ポリシー）は変えません。一時のプロファイルは、ブラウザを閉じた後に消します。BeakSight が強制的に終わったときなどに残った一時のプロファイルは、次に起動するときに、1 日より古く、使われていないものを消します。
- 起動するたびに、この設定が効いていることを確かめます（登録のない独自のスキームへの移動が止まるか。あわせて、許した種類の http・https・`data:` が止まっていないか。http・https は、この PC の使われない宛先で確かめ、どこへも接続しません）。効いていなければ、監査を始めません（実行の前の確認の失敗。理由の詳細は `EXTERNAL_LAUNCH_BLOCK`）。PC の管理の設定（会社のポリシーなど）がこの設定を上書きしている場合などに起きます。PC の管理者に確かめてください。
- ページのスクリプトによる移動の試みを検出した場合は、headed と headless を問わず、安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）として記録します。その時点で、そのブラウザの環境を閉じます。Run は `ABORTED_BY_SAFETY`（終了コード 3）になります。移動の試みは、Safety の記録（外部スキームへの移動の試み）にも残します。検出は、Chromium の開発者の口（CDP）の、移動の始まりと新しいウィンドウの事象で行います（Chromium が移動を止めるので、ふつうの要求の事象は来ません）。安全のために通信を止めた後（凍結の後）に開いたポップアップの中の移動も、同じく検出します。ポップアップを開いてすぐに外部スキームへ移す場合のように、BeakSight が見張りを付ける前に Chromium が止めた移動も、付けた時点で拾います。同じ移動は 1 回だけ記録します。違反の文は、ページが外部スキームへ移ろうとし、ブラウザが止めて外部のアプリへ渡さなかったことを表します。
- PDF の頁（頁そのもの、iframe と embed の中の PDF）で Chromium が作る、組み込みの PDF の表示の部品の枠（`chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/…`）は、外部スキームへの移動にしません。PDF の頁でも、監査を続けます。外すのは、PDF の頁の中に Chromium が作る枠だけです。ほかの `chrome-extension:` の URL への移動と、この部品の頁を新しいウィンドウ（`window.open` など）や頁そのものの移動で開くことは、外部スキームへの移動として扱います。
- ページのスクリプトが新しいウィンドウ（`window.open` や `target="_blank"` のリンクとフォーム）で外部スキームを開こうとした場合は、この違反に加えて、`FRAME_CLASSIFICATION_FAILED` の違反も記録します。新しいウィンドウの移動は、どの frame の移動かを判定できないためです。
- サーバのリダイレクトによる外部スキームへの移動（3xx の `Location` が外部スキーム）は、ブラウザがたどる前に止めます。この経路は、止めて防げるので、headed でも headless でも違反にしません。記録の理由は `EXTERNAL_SCHEME_REDIRECT_BLOCKED` です。
- 既知の残る経路:
  - BeakSight の守りのない iframe（ふつうは起きません。BeakSight のブラウザの環境には、どれも守りが付きます）がサーバのリダイレクトで外部スキームへ向くと、Chromium が落ちることがあります。守りのある環境では、守りが先にリダイレクトを止めます。守りが取りこぼした場合は、ブラウザが切れたことで Run が失敗します（外部のアプリは起動しない、止まる側の失敗です）。
  - PC の管理の設定が、この設定を上書きする場合は、上の確かめで監査を始めません。ただし、管理の設定が、ほかのスキーム（`mailto:` など）を許す一覧に足す形は、この確かめでは見分けられません。その場合も、BeakSight は移動の試みを検出して違反にし、ブラウザの環境を閉じますが、外部のアプリが開くことがあります。
  - headed では、「BeakSight の内部の窓」の頁を 1 つ持つブラウザのウィンドウを、最小化して残します（閉じるとブラウザが終わるためです）。この窓は、どこへも通信しません。実行中に、このウィンドウを閉じないでください。閉じると、ブラウザが終わり、Run が失敗します。
  - 一時のプロファイルの設定のファイルが壊れていると、headed の Chromium が起動の途中で止まったまま待つことがあります。BeakSight は、このファイルを毎回新しく作るので、ふつうは起きません。

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
- 記録の URL（Task 44 の P4-1）: 止めた要求・ナビゲーション・WebSocket・ポップアップ・ダウンロード・外部への作用・監査の段の除外の URL は、成果物に書く前に、query の名前を残して値をすべて `[REDACTED]` に伏せ、path の値に見える区切り・fragment の値・userinfo も伏せます。公開の監査も認証つきの Run も同じです。判定と止める動きは、伏せる前の値で行います。限界: Finding の本文と identity、ページの URL、リンクの URL には、秘密に見える名前でない query の値が残ります（「[成果物の URL の伏せ字](output.md#成果物の-url-の伏せ字)」）。

レポートの「Safety の事象の一覧」は、次の種類の記録を示します（名前は `page.json` の安全の記録の項目の名前です）。

| 記録の名前 | レポートの表示 |
| --- | --- |
| `blockedRequests` | 遮断したリクエスト。Guard が止めた要求で、読み取りでない送信（`NON_READ_METHOD`）のほか、上限を超えたもの（1 画面あたりの読み込みの上限 `PAGE_NAVIGATION_LIMIT_REACHED`・`PAGE_SUBRESOURCE_LIMIT_REACHED`、承認したサービスの Origin への要求の上限 `SERVICE_REQUEST_LIMIT_REACHED`、通す送信の数の上限 `AUDIT_SEND_OVER_LIMIT` など）と、閉じる前に画面を離れた後の上限を超えたもの（`PAGE_LEAVE_REQUEST_LIMIT_REACHED`。GET も止めます）を含みます。レポートの理由の欄には、理由の説明も示します（Task 44 の T44R2 の M-7）。 |
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

- `EXTERNAL_SCHEME_NAVIGATION`: ページが移動を試みた記録です。Chromium の設定が移動を止め、外部のアプリへは渡していません。ページが外部のアプリを開こうとしたことは安全の決まりに反するので、安全の不変条件の違反（`EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED`）も記録し、Run は `ABORTED_BY_SAFETY` になります。
- `EXTERNAL_SCHEME_REDIRECT_BLOCKED`: サーバのリダイレクトを、ブラウザがたどる前に止めた記録です。

### 止めた時点と読み込みの印

2026-10-23 から（設計書 `2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` の 3.1）、`page.json` の安全の記録と network の記録に、BeakSight が止めた要求を見分ける印が付きます。止める決まりと、サイトに届く要求は変わりません（記録を足しただけです）。

- 止めた時点（`phase`）: 止めた要求（`blockedRequests`）・ナビゲーション（`blockedNavigations`）・WebSocket（`blockedWebSockets`）・監査の段の除外（`blockedAuditExclusions.events`）の各行にあります。
  - `LOAD`: その画面の読み込みの間（ページの監査では、測りの前と最中）に止めたもの。
  - `CLOSING`: 閉じる途中か、閉じる前に画面を離れた後（監査の段の送信の扱い `PASS_EXCEPT_DELETE`）に止めたもの。測りの後のものなので、指摘の判断には使いません。
  - 外部スキームへの移動の記録の `phase`（`PASSIVE`・`INTERACTION`）は、凍結の前と後を表す別の値です。
- 要求の種類（`resourceType`）: 止めた要求と監査の段の除外の各行にあります。Guard が見た種類です。ページの `fetch` は、`xhr` として残ることがあります（network の記録の種類は `fetch` のまま）。
- 閉じる途中に止めた要求（`blockedClosingRequests`）: 環境を閉じる途中（閉じ始めた後）に Guard が止めた要求の数（`count`）と、method・URL・種類・時点（いつも `CLOSING`）の一覧（`events`）です。1 件でも止めたときだけあります。止めた要求の数（`blockedRequestsByMethod`・`run.json` の `blockedActions`）・止めた要求の一覧・安全の指摘には入れません。一覧の上限を超えても、数は正しく数えるので、記録を不完全（`recordTruncated`）にしません。閉じる途中の要求は、ふつうはほとんどありません（閉じ始めてから閉じ終わるまでが短いため）。
- 読み込みの種類（`load`）: 安全の記録ごとにあります。`PAGE_AUDIT`（ページの監査の読み込み）、`STRESS_WIDTH`（幅の走査の 1 つの幅。`width`）、`INTERACTION`（Interaction の 1 つの候補。`candidateIndex` は候補の発見の順の番号で 0 から）です。
- 安全の記録は、環境を閉じた後に作ります（閉じる途中・画面を離れた後に止めた要求も残すため）。そのため、`PASS_EXCEPT_DELETE` で画面を離れるときに止めた `DELETE` などが、`CLOSING` の行として残り、安全の指摘（`SAFETY_NON_READ_REQUEST_BLOCKED`）にも数えます。
- network の記録の失敗（`failures`）の各行の印: `blockedByBeakSight`（BeakSight が止めた要求の失敗か。失敗の理由が `net::ERR_BLOCKED_BY_CLIENT` か `net::ERR_BLOCKED_BY_CLIENT.Inspector` のとき真）と `phase`。ページの監査の network の記録は、閉じる前に取り終えるので、失敗の行の `phase` はいつも `LOAD` です（閉じる途中の失敗は、network の記録に入りません）。
- 印はどの行にも必ずあります。2026-10-24 から、印のない前の版（`page-schema/1.0`）の `page.json` は読みません。それを持つ再開の保存は読めない保存として扱い、新しい Run として最初から監査します（「[中断した Run の再開](resume.md)」）。
- 印の URL も、ほかの止めた記録と同じく、成果物に書く前に伏せます（「[成果物の URL の伏せ字](output.md#成果物の-url-の伏せ字)」）。
