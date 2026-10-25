# 設計書 — 監査の間に、ページが自分で出す送信を、削除のほかは通す（プロファイルの選択）

状態: ユーザーの判断（2026-10-19「削除だけ止め、ほかは通す」）。実装中。
作成: 2026-10-19（設計者）

## 1. 経緯と判断

実テスト環境の監査で、Guard は、ページが読み込みで自分で出す読み取りでない送信を、すべて止めていた。止めたのは、読み取りの名前の手続きの呼び出し（`get_…`・`resolve_…`）、サイトのサーバの関数（`/_serverFn/<ハッシュ>` の POST）、`sync-…` の関数、`DELETE` のセッションの削除、計測のビーコンである。読み取りの手続きを通すには、利用者が 1 件ずつ登録する必要があり（最大 8 件）、何も登録していなかった。

ユーザーの指摘: 「まだ過剰に通信遮断をしている気がする。サイトの自然な動作を勝手に止めないで」。設計者が、(1) 読み取りの名前だけ自動で通す、(2) 削除だけ止め、ほかは通す、(3) すべて通す、を示し、ユーザーは (2) を選んだ。

この設計は、実装タスク指示の Safety Invariants（第 7 章「Passive Context で実ネットワーク送信を許可する method は GET と HEAD のみ」）を、**この設定を選んだプロファイルの Passive Context の、ページが自分で出す副資源の要求に限って**置き換える。既定（選ばないプロファイル、CLI の既定）は今のまま読み取りだけとする。

## 2. 設計

### 2.1 設定

- 名前: 監査の段の送信の扱い `auditSendPolicy`。値は `READ_ONLY`（既定。今のまま）と `PASS_EXCEPT_DELETE`。
- 置き場所: 実効の設定（`effectiveConfig`）の安全の項目（CLI は設定ファイル、画面はプロファイルごとの設定から `START` で渡す）。画面の設定は、表示の設定と同じく承認に結ばれるプロファイルの改訂の外に置く（切り替えても承認・発見のやり直しを起こさない）。切り替えのときは、確認のダイアログで「ページが出す書き込みの送信がサイトに届く。削除と危険な語の送信は止める」を出す。
- 実効の値は `run.json` と報告と結果の記録に残す（どの扱いで監査した結果かを後から分かるようにする）。再開の比べでは比べる（扱いが違う Run を混ぜない）。

### 2.2 通す要求と止める要求（`PASS_EXCEPT_DELETE`）

> 2026-10-19 の AS-c（5 章）で、次の 3 点を改めた: 送り先の Origin の制限をなくす、WebSocket の接続を通す、token の更新を通し、更新した状態を次の Context へ引き継ぐ。以下の本文のうち、これと食い違う箇所は 5 章が優先する。

当てる段: 監査・発見・READ の確かめの Passive Context（スクリプトで送るログインの監査の段を含む）。当てない段: ログインの段（今の決まり）、書き込みの段（今の決まり）、Isolated Interaction Context（BeakSight が押す操作。今のまま読み取りだけ）。

通す（記録する）: ページが自分で出す副資源の要求（fetch、XHR、beacon、ping など。main frame と sub frame の文書のナビゲーションではないもの）で、次をすべて満たすもの。

- method が GET・HEAD でも `DELETE` でもない（POST、PUT、PATCH、OPTIONS など）。
- 送り先が許可 Origin か、プロファイルの承認したサービスの Origin。
- URL の path（手続きの名前を含む）に、危険な語（`DEFAULT_EXCLUDED_URL_WORDS`: logout、signout、delete、remove、destroy、cancel など。今の監査の段の除外と同じ比べ方）がない。
- その読み込み（Context）で通した数が上限（名前つきの定数。例 60）の内。

止める（今どおり記録する）: `DELETE`、危険な語の path、許可 Origin と承認したサービスの Origin のほかへの読み取りでない要求、文書のナビゲーションの POST（フォームの送信）、上限を超えた要求（新しい理由 `AUDIT_SEND_OVER_LIMIT`）、WebSocket（今のまま。限界として文書に書く）、ダウンロード、外部のアプリの起動、ポップアップの今の扱い。

### 2.3 記録

- Safety Ledger に、通した読み取りでない要求（method、Origin の区別、path、回数。止めた要求の記録と同じ形・同じ上限の部品）を足す。値（本文、query の値、ヘッダの値、Cookie）は記録しない。
- `run.json` の `safety` に、実効の扱いと、通した数（method ごと）を足す。報告とジョブの画面に「この監査では、ページが出す送信のうち削除のほかを通した（N 件）」を目立つ形で出す。文言はカタログ。
- 違反（invariant violation）の判定: 通した要求は違反にしない。止めるべき要求が届いたら今どおり違反。

### 2.4 負荷

- BeakSight が新しく送る要求はない。ページが自分で出す要求を止めないだけ。読み込みの間隔（pacer）と読み込み直しの回数は今のまま。
- 1 つの読み込みで通す数の上限を置く（ページが送信を繰り返す作りで、サイトに負荷をかけ続けないため）。

## 3. 受け入れ条件

1. 既定（`READ_ONLY`）の安全の回帰が、両方の Chromium（既定と `BEAKSIGHT_TEST_DEFAULT_CHROMIUM=cli`）で変わらず通る。
2. `PASS_EXCEPT_DELETE` で、fetch・XHR・beacon の POST（と PUT・PATCH・OPTIONS）が、送り先の Origin によらずサーバに届き、記録される（両方の Chromium。AS-c）。ページの WebSocket の接続も届き、記録される。CORS の事前確認はサーバへ送り、サーバの CORS の判断に任せる（AS-R の I-1）。
3. 同じ設定で、`DELETE`、method の上書き（`X-HTTP-Method-Override` などのヘッダ、form の本文の `_method`）で削除を指すもの、危険な語の path、文書のナビゲーションの POST、上限を超えた要求は、サーバに届かない（サーバの記録で数える。名前つきの時間だけ待ってからも確かめる）。違反 0。ページ自身が Playwright の内部の口を呼ぶ WebSocket と、Worker の中の WebSocket は限界（5 章の AS-R の行）で、届いた接続をブラウザの事実から記録する。
4. Isolated Interaction Context は、設定にかかわらず今のまま読み取りだけ。
5. 実効の扱いが `run.json`・報告・ジョブの画面に出る。値が記録・IPC・画面に出ない。
6. 独立レビューで Critical 0・Important 0（Critical の基準: 止めるべき要求、または記録されない要求がサーバへ届く経路）。

## 4. 実装の分け方

| サブタスク | 内容 | 主なファイル |
| --- | --- | --- |
| AS-a | Guard の判定（`classifyPassiveRequest` の口）、factory、Safety Ledger の通した要求の記録、上限、安全のテスト（両方の Chromium） | `src/safety/passive-request-guard.ts`、`src/browser/context-factory.ts`、Safety Ledger の型と記録 |
| AS-b | 設定（実効の設定、CLI の設定、画面のプロファイルごとの設定と保存、`START` の項目）、`run.json`・報告・ジョブの画面、再開の比べ、文書（`doc/spec/safety.md` ほか） | `src/config/`、`src/control/`、`src/worker/`、`apps/local-ui/`、`src/report/`・`src/presentation/`、`schemas/` |
| AS-R | 独立レビュー（127.0.0.1 の実機の実験を含む） | — |

AS-b は、DEF-138（IPC と管理データを触る）の後に始める。

## 5. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-19 | 作成 | ユーザーの指摘と判断による。 |
| 2026-10-19 | AS-a の報告（設計者の判断） | (1) 口は Guard の `auditSend`（`GuardAuditSend`: `policy`・`approvedServiceOrigins`・`dangerousTerms`・`maxPassedPerContext`）、判定は `request-policy.ts` の `auditSendDecisionOf`（`classifyPassiveRequest` の 1 か所）、上限 `AUDIT_SEND_MAX_PASSED_PER_CONTEXT = 60`、Ledger の任意の項目 `passedAuditSendRequests`。危険な語の一覧は AS-b が `DEFAULT_EXCLUDED_URL_WORDS` を渡す（`src/safety/` は `src/control/` を読まない）。(2) 監査の段の除外があるときは、読まないパスにも当てる（登録した読み取りの手続きと同じ）。(3) スクリプトで送るログインの監査の段では、token の更新（`TOKEN_REFRESH`）と、サービスの Origin へ送らない Context の要求は、今どおり止める。token の更新を通すと、更新の token が入れ替わり、次のページの Context に入れる保存した状態の token が使えなくなる（ページごとに保存した状態から始める作りのため）。止めても、保存した状態の token が有効な間は監査できる。限界として文書に書く。(4) Interaction の Context には factory が口を渡さない。 |
| 2026-10-19 | ユーザーの言葉と選択（AS-c） | ユーザー: 「ページが読み込みで自分で出す送信が、サイトに届くようになることは問題ない。むしろ不自然な遮断によりサイト側の検知機構が働く方が問題。BeakSight が入力したり押したりする時が要注意。ここは意図をもって制御できなければいけない」。選択: WebSocket を通す、ほかの Origin への送信を通す、token の更新も通す（DELETE と危険な語は止めたまま）。設計者の判断: `PASS_EXCEPT_DELETE` で次を変える（AS-c）。(1) 送り先の Origin の制限をなくす（DELETE・危険な語・文書のナビゲーションの POST・上限は今のまま止める）。(2) WebSocket の接続を通し、接続の形（Origin、path、数）を記録する（接続の上の送受信は記録しない。値も記録しない）。1 つの読み込みの接続の上限を名前つきの定数で置く。(3) token の更新（`TOKEN_REFRESH`）を通す。更新で token が入れ替わるので、Run の中で、Passive の Context を閉じるときに今の状態（Cookie とローカル ストレージ。今の絞り込み `filterAuthenticatedState` を通したもの）を読み、次の Context に入れる状態を置き換える（普通のブラウザが 1 つのプロファイルで状態を持ち続けるのと同じ）。状態はメモリの中だけに持ち、checkpoint・成果物・IPC・管理データに書かない。置き換えるのは、読んだ状態に成功の鍵（またはログインの状態の印）があるときだけ（切れた状態で上書きしない）。Interaction の Context、ログインの段、書き込みの段は変えない（BeakSight の操作は今のまま意図どおりに制御する）。 |
| 2026-10-19 | AS-c の Blocker（設計者の判断） | 設計者の前提の誤り: 認証つきの Run は、扱いによらず、すでに世代つきで状態を引き継いでいる（T25c。factory の `#authenticatedState`・`#captureAuthenticatedState`・`#inheritedAuthenticatedState`）。AS-a の行の (3) の「ページごとに保存した状態から始める作り」は誤りで、token の更新を止めていた理由は「更新の応答を受けずに入れ替わった refresh token が使えなくなる」ことではなく、今の決まり（T35a の監査の段）だった。判断: (A) 新しい引き継ぎの置き場所は作らず、今の T25c の引き継ぎを使う（`READ_ONLY` も今どおり）。(B) 鍵の判定（`sessionKeyPresent`）がある設定で、読んだ状態の鍵がないときは、次の Context に渡す状態を置き換えない（知らせは今どおり）。扱いによらず当てる（鍵が消えた Run は今も止まるので、既定の出力は変わらない見込み。今のテストで確かめる）。(C) 鍵の判定がない設定は今どおり置き換える（path のセッションの切れで止まる。限界として文書に書く）。(D) RED は、短い時間で切れる access token と使い回しを拒む refresh token の fixture で、token の更新を止めている間に 2 ページ目が切れることで見る。Dedicated Worker の中の WebSocket は CSP（DEF-040）で止めたまま（限界として書く）。 |
| 2026-10-19 | AS-c の WebSocket の Blocker（設計者の判断） | 文書の始まりに入れる CSP（DEF-040。`connect-src http: https: data: blob:`）が、ページの WebSocket も止める。判断: W1 を採る。`PASS_EXCEPT_DELETE` の Passive の Context だけ、この CSP の `connect-src` に `ws: wss:` を足す。ページの WebSocket は今の route（`routeWebSocket`）で判定・記録・上限を当てる。blob・data の URL から作る Dedicated Worker の WebSocket は、route を通らずに開き、記録も上限も効かない（ユーザーの方針「ページが自分で出す送信は問題ない」により受け入れる。限界として文書に書く）。http(s) の script から作る Worker の CSP のヘッダ（DEF-040）も同じ扱いにそろえる。`READ_ONLY` と Interaction の Context の CSP は今のまま。 |
| 2026-10-19 | AS-R（Critical 2、Important 3、Minor 4）とユーザーの判断 | READ_ONLY・Interaction・ログインの段・凍結の後は、どの経路でも届かなかった（両方の Chromium）。C-1（ページが Playwright の WebSocket の模擬の内部の口を呼ぶと、危険な語・上限を超えた接続が届き、記録は「止めた」か別の URL になる）と C-2（Worker の中の WebSocket が記録されずに届く）について、ユーザーの判断「限界として受け入れ、検知だけ足す」（ページ自身の通信であり、BeakSight の操作と READ_ONLY では起きないため）。設計者の判断（AS-c-fix）: (1) ブラウザが実際に開いた WebSocket を CDP の事象（page と OOPIF の session の `Network.webSocketCreated` など。Worker の target は今の付け方で付けられる範囲）で数え、Ledger の通した WebSocket の記録と数はこの事実から作る（route の判定の記録と食い違わないようにする）。route を通らずに開いた接続と、危険な語の接続は、印を付けて記録し、報告とジョブの画面に出す（Context は無効にしない）。Worker の target に付けられない Chromium の場合は、その限界を文書に書く。(2) I-1: `PASS_EXCEPT_DELETE` で通す見込みの要求の CORS の事前確認は、Guard が返さずサーバへ送る（`READ_ONLY` は今のまま）。(3) I-2: method の上書きのヘッダ（`X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override`）の値、form の本文（urlencoded と multipart）の `_method` が delete（大文字小文字を問わない）なら止める。(4) I-3: 受け入れ条件 2・3 を直した（設計者）。`request-policy.ts` の古い説明を直す。(5) M-1: 危険な語に `sign_out`・`log_out` を足す（一覧の digest が承認や保存に結ばれていれば、止まって報告する）。(6) M-3: 通した記録が実際の送信と食い違う場合（about:blank のポップアップの realm）は、直せる範囲で直し、無理なら限界として書く。M-2（GraphQL・JSON-RPC の本文の削除、独自の method）、M-4（閉じる途中の keepalive と beacon は届かず記録もない）、307・308 は段ごとに 1 件と数えることは、文書に書く。 |
| 2026-10-19 | AS-c fix round 1 の Blocker（設計者の判断） | (I-1) Playwright は、route のある Context では、横取りした事前確認（`OPTIONS`）を自分で許す応答で返すため、Guard が `Fetch.continueRequest` しても事前確認はサーバに届かない（実装者の実験。両方の Chromium）。判断: `PASS_EXCEPT_DELETE` で通す見込みの要求の事前確認のうち、送り先が許可 Origin でも承認したサービスの Origin でもないものは、Guard（Node）が同じ形の事前確認（`OPTIONS`、`Origin`・`Access-Control-Request-Method`・`Access-Control-Request-Headers`、資格情報なし、出口の中継を通す、名前つきの時間の上限）をサーバへ送り、その応答の CORS のヘッダと状態でブラウザの事前確認を満たす（サーバが拒めば、ブラウザは本番の要求を送らない）。送った事前確認は Ledger に記録し、読み込みの上限の数え方に入れる。応答がない・時間切れは拒む応答にする。許可 Origin と承認したサービスの Origin は今のまま Guard が返す（普通のブラウザでも通る送り先で、新しい送信を足さないため）。`READ_ONLY` は今のまま。(M-1) `DEFAULT_EXCLUDED_URL_WORDS` は checkpoint の digest・認証の設定の検証・READ の path の検証に結ばれているので変えない。`sign_out`・`log_out` は、`auditSendOptionsOf` が Guard に渡す送信の扱いの危険な語にだけ足す（保存・digest に結ばれない）。監査の段の除外の一覧に足すかは Task 44 の候補。(I-2 の付け足し) form の本文が読めない・multipart が崩れているときは止める（fail-closed）実装者の判断を受け入れる。 |
| 2026-10-19 | AS-R2（Critical 0、Important 5、Minor 2） | 止めるべき要求が届く経路はなかった（両方の Chromium）。設計者の判断（AS-c fix round 2。1 つの不具合に時間をかけすぎない決まりにより、検知は最善の努力の範囲と割り切る）: (I-A) Worker が起動の直後に開く WebSocket は観察がほぼ間に合わない（20 本中 0〜2 本）。ユーザーの方針（ページの自然な送信は止めない）により止めない。文書の限界を実態どおりに直す（Worker の中の接続は、記録されないことが多い）。(I-B) about:blank のポップアップの realm から、ページが内部の口を呼んで開く接続と、その realm の Worker の接続は観察されない。限界として文書に書く。(I-C) route が通した数との照らし合わせは、Guard が `connectToServer()` を呼んだ後の名前つきの短い時間に観察した接続とだけ行う。それより前・後の接続は route の外（`outsideGuard`）とする。(I-D) リダイレクトの先の要求（route が呼ばれない段）は、CDP の層で記録する（上限の数え方と記録の数をそろえる）。(I-E) method の上書きの判定に、Content-Type のない POST の本文（urlencoded として読む）と、JSON の本文の最上位の `_method` を足す（書き込みの段の API の照合の部品 `METHOD_OVERRIDE_PRESENT` の読み方を共用する）。(m-1) 中継が拒んで届かなかった接続・事前確認を「通した」と数えることがある（数えすぎの側）。文書に書く。(m-2) 設計どおり。 |
| 2026-10-19 | AS-R3（Critical 0、Important 2、Minor 1）と区切り | 止めるべき要求が届く経路はなかった。I-E は効いた。設計者の判断（1 つの不具合に時間をかけすぎない決まりにより、これを最後の直しとし、残りは既知の違いとして記録して先へ進む）: (I-D の残り) ほかの Origin への 307 の先の記録を、`redirectedRequestId` だけでなく `Network.requestWillBeSent` の `redirectResponse` か同じ `networkId` の既に進めた要求も手がかりにして CDP の層で記録する。1 回の直しで効かなければ、限界として文書に書く（上限は段ごとに使うので、記録が少ない側に倒れる）。(I-C の残り) ページが模擬の内部の口を呼んで先に開いた接続と、窓の内の Worker の同じ URL の接続は、`outsideGuard` の印が付かないことがある。ページ自身がわざと行う経路（C-1 でユーザーが限界と判断した範囲）なので、文書の限界に書き、83 行の記述を実態に合わせる。`dangerous` の印は URL で決まるので付く。(Minor) 上限（1 MiB）を超える本文は、方針（不自然に止めない）により、本文の `_method` を調べずに通す（ヘッダの上書きと method と語は今どおり調べる）。限界として文書に書く。 |
| 2026-10-19 | AS-b の Blocker（設計者の判断） | (1) 危険な語の一覧 `DEFAULT_EXCLUDED_URL_WORDS` の定義を `src/core/` の純粋なファイルに移し、`auth-setup-contracts.ts` は同じ名前で公開し直す（値は変えない）。口の組み立ては `src/orchestration/` の 1 つの部品（例 `auditSendOptionsOf`）にし、Run Coordinator・発見・READ の確かめが使う。CLI とワーカー、公開と認証つきが同じ道を通る（案 A）。(2) `audit.sendPolicy` を持たない古い保存・`run.json` は `READ_ONLY` と読む（その Run は読み取りだけで動いたため）。再開の比べはこの読み替えの後に行い、古い途中の Run も今の既定で再開できる。(3) 画面の設定は `profile_display_settings` に列 `audit_send_policy` を足す（版 16 の写しを固定してから版 17。行がなければ `READ_ONLY`）。表の名前は今のまま、文書と台帳に「プロファイルごとの改訂の外の設定」と書く。 |
