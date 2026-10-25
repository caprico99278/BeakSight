# Task 35 設計書 — ログインの後の SPA の読み取りの監査

状態: ユーザー承認済み（2026-10-16「Task 35の設計を承認する」）
作成: 2026-10-16（設計者）
ロードマップ: `2026-10-16-beaksight-task-33-42-roadmap.md` の Task 35（ユーザー承認済み）。Task 33（baseline の C2〜C8）と Task 34（G34 承認 2026-10-16）の結果。

## 1. 目的

スクリプトで送るログイン（Task 34）の後に、SPA の管理画面を、読み取りだけで監査できるようにする。画面が API から読むデータを読めるようにし、その負荷に上限を設け、秘密と個人の情報を成果物に出さず、ログインの状態が消えたことを見分ける。

## 2. ユーザーの判断と事実

**ユーザーの判断（2026-10-16）**

- D2（監査の段）: 読み取りのための手続きの呼び出し（POST）は「利用者が登録したものだけ通す」。
- token を見守らない。見るのは結果（鍵が消えた、401 の数、止めた token の更新の数）。
- D1: token の更新は止めて記録する（観察 O5 で 1 時間以上出なかった）。
- API の負荷: 「Desktop と Mobile だけで読む、上限つき」。承認したサービスの Origin への要求は 1 分あたり 120 件、1 回の Run で 600 件。超えた要求は止め、Run を一部の結果（PARTIAL）で終える。設定で小さくできるが大きくできない。幅の走査は今どおり別の Origin の要求を送らない（API のデータが空になりうる限界）。
- 読む範囲の外の SPA の資源: 「静的な資源だけ範囲を問わず読む」。
- 成果物の API の URL: 「サービスの Origin の query の値を伏せる」。

**今の作り（調査担当の地図、2026-10-16）**

- 監査の段の Guard は、許可 Origin の外への GET・HEAD のサブリソースをどこへでも通す。プロファイルの `approvedServiceOrigins` は監査の段で使っていない。読み取りでない要求はすべて `NON_READ_METHOD` で止める。WebSocket は止める。事前確認は Guard が満たす。
- 読む範囲（`auditPathPrefixes`）は、許可 Origin への要求のすべての形に当たる（範囲の外の SPA のスクリプトまで止まる）。中継は要求の種類が分からず、ナビゲーションでない要求を fetch の形で判定する。
- 負荷は `load-meter.ts` が数えるだけで、上限はない。1 画面は Desktop・Mobile・幅の走査 5 幅。幅の走査（`REVISIT`）は、許可 Origin の外の要求をキャッシュになければ送らない。
- セッションの切れは path だけ。factory は Node の側で `storageState` を読み直している。`requestfinished` で応答の状態が見られる。
- 成果物の `page.json` のネットワークの Evidence に API の URL（query の絞り込みの値を含む）が入る。伏せるのは秘密の名前の query だけ。
- 登録した送信の判定（Task 34 の `scriptLoginVerdict` のログインに伴う送信の部分）は、監査の段と共用できる。回数は `SubmissionPostAdmission` の仕組み（CDP の層で減らし、route の層へ印）が使える。

## 3. 設計

### 3.1 認証の設定 v3 に足すもの（任意の項目）

- `auditReadRequests`（任意、上限 8）: 監査の段で通す、読み取りのための手続きの呼び出し。各項目は `origin`（承認したサービスの Origin か許可 Origin）、`path`（完全一致）、`method`（`POST` だけ）、`maxPerPageLoad`（1〜10。1 回の読み込み（Context）あたりの回数）。読み取りであることは利用者の判断（手順書に書く）。
- `serviceRequestLimits`（任意）: `perMinute`（1〜120）、`perRun`（1〜600）。ないときは上限の値（120・600）。
- v3 のスキーマに任意の項目として足す（版は上げない。項目のない v3 の digest は変わらない）。検証、IPC、画面の入力。`SCRIPT_REQUEST` でないときは持てない。

### 3.2 監査の段の Guard

判定は今どおり `classifyPassiveRequest` の 1 か所。Guard と中継が使う。

- 監査の段の口に、`approvedServiceOrigins`、`auditReadRequests`、token の送信先（`scriptLogin`。更新を見分けるため）、`serviceRequestLimits` を渡す（`RunAuthentication` → `authenticatedContextOptions` → factory → Guard。再開の種類の digest にも入れる）。
- 登録した読み取りの手続きの呼び出し: `POST`、種類が fetch か xhr、Origin と path が一致、その読み込みの残りの回数が 1 以上、のときだけ通す。判定は Task 34 のログインに伴う送信の判定を**共通の関数**に切り出して共用する（第二の判定を作らない）。理由の一覧は、共通の部分と段の理由に分ける。
- token の送信先への POST（query が password でないもの。更新など）は止め、理由を分けて数える（止めた token の更新の数）。
- そのほかの読み取りでない要求（サーバの関数、計測の送信など）は、今どおり止めて記録する。
- 承認したサービスの Origin への要求（GET・HEAD と、通した登録の POST）は、数える（3.4）。上限を超えた要求は、新しい理由で止める。
- 凍結の段（発見の Interaction）と、幅の走査（`REVISIT`）では、登録の POST を通さない。幅の走査の別の Origin の要求は今どおり送らない（キャッシュから返す）。
- 中継（`passiveEgressRequestPolicy`）は、監査の段の口を写す（登録の POST は回数を Guard の印に任せる）。

### 3.3 読む範囲の外の静的な資源

- 許可 Origin への GET のうち、種類が script・stylesheet・image・font・media のサブリソースは、`auditPathPrefixes` の範囲の外でも通す。画面の移動（document）、fetch・xhr、そのほかの種類は、今どおり範囲で絞る。
- 読まないパス（`excludedPathPrefixes`）と危険な語は、今どおりすべての要求に当てる。
- 中継は種類が分からないので、範囲の確かめは Guard が行い、中継は「ナビゲーションの形」だけを範囲で絞る（中継は Guard より広く通さない、の決まりを、範囲については「Guard が先に絞る」と読み替える。手順書と設計の限界に書く）。読まないパスと危険な語は、中継でも今どおり当てる。

### 3.4 サービスの Origin への要求の上限と記録

- 数える部品を 1 つ作り、Run で 1 つを factory の指定で Guard に渡す（`navigationPacer` と同じ受け渡し）。Guard の CDP の層の ALLOW の所で、承認したサービスの Origin への要求を数える（送る前に数える）。
- 1 分あたりの上限（直近 60 秒の窓）か Run の上限を超える要求は、新しい理由（例 `SERVICE_REQUEST_LIMIT_REACHED`）で止めて記録する。上限に届いたら、Run は次のページを始めず、一部の結果（PARTIAL。未完了の理由を新しく足す）で終える（サイトの不調で止める前例の形）。
- `run.json` の `load` に、承認したサービスの Origin の区分（数、1 分あたりの最大）を任意の項目で足す（公開の監査の出力は変えない）。

### 3.5 ログインの状態が消えたことの見分け

- 鍵が消えた: factory が `storageState` を読み直す時に、成功のローカル ストレージの鍵の形（`hasSuccessStorageKey` と同じ判定。関数で渡す）の名前がなくなったら、セッションが切れたとみなす（今の `AUTH_SESSION_LOST` の流れに合わせる。理由の詳しさを区別できるなら区別する）。値は読まない。
- 401 の数: factory の `requestfinished` の観察で、承認したサービスの Origin からの 401 の応答を数える（値は読まない）。数は記録だけで、それだけでセッションが切れたとはみなさない。
- セッションの切れの path（今の作り）は、そのまま。

### 3.6 成果物の API の URL

- 承認したサービスの Origin の URL は、成果物（`page.json`・`run.json`・HTML・ZIP の中身）では、query の名前を残し、値をすべて伏せる。path の値に見える区切りも伏せる（`src/core/url-path-redaction.ts`）。伏せる部品は `src/core/` の 1 か所にし、成果物の書き手（`artifact-writer.ts` の URL の伏せ方）が使う。
- `Authorization`・API の鍵のヘッダが成果物に入らないことを、目印の検査で確かめる（今の作りで入らない見込み）。

### 3.7 記録

`run.json` の認証の項目（任意）に、数だけを足す: 通した登録の手続きの呼び出し、止めた token の更新、止めたそのほかの読み取りでない要求（Safety Ledger にもある）、サービスの Origin からの 401 の数、上限に届いたか。

## 4. 安全と負荷

- 新しく通すのは、登録した読み取りの手続きの呼び出し（読み込みごとの回数の中）と、範囲の外の静的な資源の GET だけ。そのほかの読み取りでない要求は今どおり止める。
- サービスの Origin への要求は、Desktop と Mobile の読み込みだけで出て、上限で止まる。ページの読み込みの間隔（実テスト環境では 10 秒）は変えない。
- 秘密（token、API の鍵、ローカル ストレージの値）と、サービスの Origin の URL の query の値は、成果物に出さない。
- 公開の監査（`PUBLIC_PASSIVE`）とフォームの送信のログインの監査の振る舞いと出力は変えない。

## 5. 受け入れ条件（G35）

1. fixture（`startSpaAuthSite`）で、本物のワーカーのスクリプトのログインの監査が、SPA の管理画面の一覧を Desktop と Mobile で読み、COMPLETE になる（両方の Chromium）。範囲を `/admin` に絞っても、範囲の外の `/app.js` は読める（baseline の C2b を意図して直す）。
2. 登録した手続きの呼び出し（`rpcReads`、`preLoginRpc: required`）は回数の中で通り、登録しないものは止まる（C4・C8 を意図して直す）。token の更新は止まり、数が残る（C3）。サーバの関数・計測の送信・WebSocket は止まる。
3. 上限: 小さな上限の設定で、上限に届くと止まり、Run が PARTIAL になる。届いた要求の数が上限を超えない（バックエンドの記録で数える。全部の後に待って数え直す）。
4. 鍵が消える fixture の指定（ログアウトの代わり）で、セッションの切れになる。401 の数が記録される。
5. 成果物に、サービスの Origin の URL の query の値、token、API の鍵、資格情報の目印が出ない。
6. 回帰: 公開の監査の golden、`cli-output-parity`、フォームの送信のログインの監査、Task 34 のテスト。
7. 独立レビュー（Critical 0、Important 0）と、`verify:all` を 1 回。

## 6. 実装計画

| サブタスク | 中身 | 変えるファイル（主） |
| --- | --- | --- |
| T35a | 契約: v3 の `auditReadRequests`・`serviceRequestLimits`、`run.json` の任意の項目、受け渡し（`RunAuthentication`、IPC、再開の digest） | `src/control/`、`schemas/`、`src/orchestration/`（受け渡しの型） |
| T35b | Guard: 登録した送信の判定の共通化、監査の段の口、範囲の外の静的な資源、数える部品と上限、中継 | `src/safety/`、`src/browser/context-factory.ts`、`src/crawl/` |
| T35c | Run とワーカー: 上限で止める流れ、鍵が消えた、401 の数、`run.json` の記録、成果物の URL の伏せ方、端から端のテスト、baseline の直し | `src/orchestration/`、`src/worker/`、`src/report/`、`src/core/`、`tests/` |
| T35d | 画面と文書（Task 34 と同じ担当） | `apps/local-ui/`、`src/presentation/`、`doc/spec/` |

順: T35a → T35b → T35c。T35d は T35a の後に並行。最後に独立レビュー（T35R）と `verify:all`（1 回）。CC-094（テストの偽の要求の補助）は T35b の中で片付ける。

## 7. 設計の変更の履歴

| 日付 | 理由 | 変更 | 影響 |
| --- | --- | --- | --- |
| 2026-10-16 | 初版 | ユーザーの判断 3 点（API の負荷、範囲の外の資源、成果物の URL）と、token を見守らない判断を入れた。 | Task 36〜41 |
| 2026-10-16 | T35R（Critical 1、Important 3） | (1) 幅の走査と Interaction の Context では、承認したサービスの Origin への要求を sub frame の文書を含めて送らない（C-1）。(2) 上限で止めた要求が 1 つでもあれば PARTIAL と `SERVICE_REQUEST_LIMIT_REACHED`（I-2。ユーザーの判断の言葉どおり）。(3) T35a で設計者が「上限は実行ごと」と判断したのは、ユーザーの判断「1 回の Run で 600 件」からずれていた。Run の上限の数を保存で再開をまたいで引き継ぐ形に直す（I-3。1 分あたりの窓は実行ごと）。(4) 文の中の URL の伏せ方、ws:// と fragment、登録した呼び出しへの読まないパスと危険な語（I-1・M-1〜M-3）。 | T35R-fix |
