# Task 37 設計書 — SPA の候補の発見と READ

状態: 離席中の指示（2026-10-16「長時間離席する。承認待ちの部分は後回しとし、開発を進めて」）により、ロードマップ上の作業として承認済みとみなして進める。この設計書の中の「設計者の既定（ユーザーの確認待ち）」は、戻られた後に確認を受ける。
作成: 2026-10-16（設計者）
ロードマップ: `2026-10-16-beaksight-task-33-42-roadmap.md` の Task 37（ユーザー承認済み）と 12 章の履歴（T35R3 の Minor-2）。Task 35 の設計書（監査の段の口と上限）。

## 1. 目的

スクリプトが API を呼んで書き込む SPA の管理画面で、次の 3 つをできるようにする。

1. **送らずに観察する probe**: 発見のジョブで、登録や更新のボタンを、通信を止めた Context で押し、ページが「送るはずだった要求」の型を記録する。サイトへは何も送らない。
2. **型の分類**: 記録した型を、API の登録（`API_CREATE`）、API の更新（`API_UPDATE`）、実行できないもの（I21）に分ける。Task 38 の承認は、この型を結ぶ。
3. **SPA の画面の READ**: データを後から API で描く画面を、画面そのものを読み込んで期待と照らす。Task 40・41 の照合の READ（D3・D4）の土台にする。

あわせて、ロードマップの 12 章で Task 37 に回した項目（発見・READ・書き込みのジョブで、上限に届いたこと、鍵の消失、401 を成果物とジョブの結果に残す）を決める。

## 2. 前提（読み取り専用の調査で確かめた事実）

- 候補は、form と送信ボタンの組（`FORM`）と、form の外のボタンや `role=button`（`BUTTON`）。`BUTTON` は送信先も欄も持たない。form のない画面のボタンは、listener があれば `NEEDS_BINDING`、なければ `DISPLAY_ONLY`、削除の語なら `NOT_EXECUTABLE`（`src/discovery/probe.ts`、`classify.ts`）。
- 実テスト環境の登録と更新の画面には form がない（Task 33 の観察）。fixture の `/admin/members/new`・`/edit` は form を持つので、form のない形の画面を fixture に足す必要がある。
- 凍結の段の Guard は、判定より前に `BLOCK_FROZEN` を返し、CORS の事前確認も止める（`passive-request-guard.ts` の `decideGuardRequest`）。そのため、別の Origin の JSON の API では、事前確認が止まった時点で本番の `POST`・`PATCH` をブラウザが出さず、型を観察できない。
- ページを操作してよいファイルは、閉じた一覧で決まっている（`tests/architecture/worker-login-hooks.test.ts` の (q)）。`src/discovery/` はページを操作しない（同 (w)）。
- Interaction の Context は REVISIT で、サービスの Origin へ送らない（T35R の判断）。SPA のデータが描けないので、probe には使えない。
- 発見・READ・書き込みのジョブは、`jobContextFactoryOptions`（`src/orchestration/audit-stage-run.ts`）で上限の部品を受けるが、状態を返さないので数を読めない。登録した読み取りの手続きの呼び出しは空にしている（Task 37 で決めるまで）。
- READ の確かめは GET の form の候補（`READ_GET_FORM`）だけを対象にし、文書の HTTP の状態だけを見る。API の 401 や上限で描けなかった画面が `NOT_MATCHED` と誤って出うる。
- 落ち着きの待ち（`settle.ts`）は API の GET を含むページのすべての要求を数える（静けさ 500ms、上限 5 秒）。

## 3. 設計

### 3.1 ジョブの監査の段の口（T35R3 の Minor-2 への答え）

- `jobContextFactoryOptions` は、作った監査の段の状態（上限の部品、記録、401 の数、鍵の消失）も返す。発見・READ・書き込みのジョブは、Run Coordinator と同じく、1 画面ごと（READ は 1 定義ごと）に「上限に届いたか」と「鍵が消えたか」を確かめる。
- **設計者の既定（ユーザーの確認待ち）**: 登録した読み取りの手続きの呼び出し（`auditReadRequests`）を、**発見と READ のジョブでは通す**（Run と同じ判定、PRIMARY だけ、1 回の読み込みあたりの上限、サービスの Origin の上限で数える）。テナントの手続きの呼び出しがないと、SPA の管理画面は一覧も更新の画面へのリンクも描けないため。**書き込みのジョブでは、Task 39 まで空のまま**にする。
- 終わり方:
  - 上限に届いたら、そのジョブは残りの画面（定義）を読まずに終わる。発見は `SERVICE_REQUEST_LIMIT_REACHED`（`DISCOVERY_END_REASONS` に足す）、READ は残りの定義を読まない理由（`UNREAD_REASONS`・`READ_CHECK_END_REASONS` に足す）。Run Status は PARTIAL。
  - 鍵が消えたら、今のセッションの切れ（`sessionLostUrlOf` の path による切れ）と同じ終わり方にし、詳しい理由を `session-key` にする（Task 35 と同じ）。
  - 上限で断った要求や 401 があった画面は、その画面の不完全の理由（新しく `SERVICE_READ_REFUSED`）を付け、`UNRELIABLE_INCOMPLETE_REASONS` に入れる（入れないと、発見の索引が候補を誤って `MISSING` にする）。
- 成果物: `discovery.json` と `read-evidence.json` に、任意の項目 `authentication`（`RunAuthenticationSummary` と同じ形。`run.json` の書き方を使う）を足す。成果物の版を上げる。
- ジョブの結果: IPC の要約とジョブの管理の照らし合わせに、同じ要約を足す（今の任意の項目の作りに合わせる）。画面のジョブの詳細に、Task 34 のログインの段の要約と並べて出す。
- 書き込みのジョブ: 要約を記録するだけ（振る舞いは変えない。送信の前に上限や鍵の消失に当たった場合は、今の「送っていない」の終わり方になることをテストで確かめる）。

### 3.2 送らずに観察する probe

**どこで**: 発見のジョブの、1 画面の流れの中。今の順（凍結の条件の確かめ → 落ち着き → 凍結 → 候補の読み取り → listener の読み取り → 分類）の後、`discoverLinks` の後に行う（押すと SPA の router が URL を変えうるため）。PRIMARY の凍結した Context をそのまま使い、**読み込み直しはしない**。

**対象**（**設計者の既定（ユーザーの確認待ち）**）:

- その画面の候補のうち、分類が `NEEDS_BINDING`（JS の結び付き。`FORM` の `JS_BOUND`・`JS_DELEGATED` と、listener のある `BUTTON`）のもの。`DESTRUCTIVE` の語に当たるもの、外部 Origin のもの、ログインの画面（認証の設定のログインの path）の候補は押さない。
- 文書の順に、**1 画面あたり最大 3 回**押す。押した後に main frame の URL が変わったら、その画面の残りは押さない（`NOT_OBSERVED`、理由 `PAGE_CHANGED`）。

**入力**: 押す前に、その候補の範囲の欄に合成の値を入れる。範囲は、`FORM` ならその form の欄、`BUTTON` なら画面の form の外の欄。

- 入れるのは、見える・編集できる、text 系の `input`（text、email、number、tel、url、search、date など）と `textarea`。`select` は、空でない最初の選択肢を選ぶ（ユーザーの判断「select も選ぶ」2026-10-16。選ぶと画面の JS が読み取りを出しうるが、凍結の中なので止まる）。`password`・`file`・`hidden`、`checkbox`・`radio` は触らない（触らなかった欄の数を記録する）。
- 値は、欄ごとに違う乱数の目印。型に合わせる（email は `@example.invalid` の形、url は `https://example.invalid/` の形、number と tel は数字だけ、date は固定の日付）。目印は秘密でない。値そのものは記録しない。
- 画面の検証で送られなければ、結果は `NO_REQUEST`（限界として文書に書く）。

**押下**: Interaction の操作の部品（合図の事象つきの要素の取り出しと `click`）を使う新しいファイルを `src/interaction/` に置き、ページを操作してよいファイルの閉じた一覧 (q) に足す。`src/discovery/` は今どおり操作しない (w)。押した後は、要求が静まるまで（名前つきの時間。既定 2 秒）待つ。

**Guard の観察の形**（凍結の段の中の、probe の間だけの形）:

- 承認した API の Origin への CORS の事前確認は、凍結の段でも、監査の段と同じく Guard が `Fetch.fulfillRequest`（204 と CORS のヘッダ）で満たす。サーバへは送らない（I18）。ほかの Origin の事前確認は、今どおり止める。
- 続いてページが出す本番の要求は、CDP の Request の段で型を読み、今どおり `BLOCK_FROZEN` で止める（凍結の後の止めた記録 `blockedInteractionRequests` にも、今どおり入る）。
- 型を受ける受け手は、Ledger とは別に持つ（`src/safety/` の 1 か所。probe の間だけ有効にする口を factory が渡す）。本文は、型を作るため（JSON の鍵と値の型、目印と欄の対応）にだけ、メモリの中で読む。値は残さない。

**記録する型**（値は記録しない）:

| 項目 | 内容 |
| --- | --- |
| method、要求の種類 | `fetch`・`xhr` など（`requestResourceTypeOfRequest`） |
| Origin | 承認した API の Origin のどれか（一覧の番号）、許可 Origin、そのほか |
| path | 値に見える区切りを伏せた型（`src/core/url-path-redaction.ts`） |
| query | 名前の一覧。filter の形（名前、演算子。今は `eq` の 1 つを読む）と、その値が画面の path の値に見える区切りと同じかの真偽 |
| ヘッダ | 名前の一覧（小文字、並べる）。`Content-Type` の媒体の型。`Prefer` は閉じた一覧の値だけ（`return=…`、`resolution=…`、そのほか） |
| 本文 | 最上位が object か array か、JSON でないか。鍵の名前と値の JSON の型の一覧。鍵と、目印を入れた欄の対応 |
| 数 | 1 回の押下で出た読み取りでない要求の数、止めた読み取りの数 |

### 3.3 型の分類（I21）

純粋な関数として `src/discovery/` に 1 か所で置く（ページを操作しない）。上から順に当てる。

| 結果 | 条件 |
| --- | --- |
| `NO_REQUEST` | 押した後に読み取りでない要求がない |
| `NOT_EXECUTABLE`（理由つき） | `DELETE`、`PUT`、承認した API の Origin でない、path が手続きの呼び出し（`/rpc/` の区切り）、`Prefer` の `resolution=` や `on_conflict` の query（upsert）、本文が array、JSON でない本文、1 回の押下で読み取りでない要求が 2 つ以上、論理削除にあたる鍵（状態の語の判定 `fieldNameHasStateWord` を使う。書き写さない）、`PATCH` の filter がない・2 つ以上・値が画面の path の値でない |
| `API_UPDATE` | `PATCH`、承認した API の Origin、filter がちょうど 1 つ（`eq`）で値が画面の path の値、ほかの query は閉じた一覧（`select`）だけ、本文が object |
| `API_CREATE` | `POST`、承認した API の Origin、filter がない、ほかの query は閉じた一覧（`select`）だけ、本文が object |
| `NOT_EXECUTABLE`（`UNRECOGNIZED`） | 上のどれでもない |

filter の書き方と閉じた一覧の query の名前は、プラットフォームの名前を書かない一般の形として、契約の 1 か所で持つ（Target Isolation）。

### 3.4 候補の識別と成果物

- 候補の識別（`identityDigest`）は**変えない**（`FORM`・`BUTTON` のまま）。今の承認と索引を壊さないため。
- 候補に、任意の項目 `submissionProbe` を足す: 結果（3.3 の表と `NOT_OBSERVED`）、理由、型（3.2 の表）、型の digest（`shapeDigest`。版の印 `beaksight:api-shape/1` つきの正規化した型の SHA-256）。Task 38 の承認の digest v4 は、`identityDigest` と `shapeDigest` を結ぶ。
- 同じ digest の候補をまとめる所（`mergeDiscoveryCandidates`）では、型が違えば別の行として残す（同じボタンで型が違うのは、画面の状態で送り方が変わる印）。
- `candidate.schema.json`、`discovery.schema.json`、`DISCOVERY_ARTIFACT_SCHEMA_VERSION` を上げる。管理データの索引に型を持たせる必要があれば、管理データの版を上げる（前の版の写しを固定してから）。要らないなら上げない（実装者が調べて報告する）。

### 3.5 SPA の画面の READ

- READ の定義の対象に、今の「READ の候補の識別の digest」に加えて、**画面の path**（`targetPagePath`）を足す（どちらか 1 つ）。画面の path の定義は、送る値を持たない。
- **設計者の既定（ユーザーの確認待ち）**: 画面の path は、プロファイルの開始の URL と同じ Origin の path だけ（query と fragment は持たない）。保存のときに、読まないパスと危険な語の判定（今の要求の判定）と、監査の除外を通す。
- 確かめ方: 新しい Context でその画面を読み込み（監査の段と同じく、承認した API の Origin への読み取り、登録した読み取りの手続きの呼び出しを、上限の中で通す）、落ち着きを待ち、今の `readSettledPageStructure` と期待の照らし（`read-check-evaluation.ts`）を使う。1 定義あたり読み込み 1 回。
- 判定できないとき: 読み込みの間に、上限で断った要求、サービスの Origin の 401、鍵の消失、止めた読み取りの手続きの呼び出しがあれば、照らした結果に関係なく `UNDETERMINED`（詳しい理由を新しく足す）。今の候補の READ にも同じ決まりを当てる。
- 管理データ: 定義の JSON の形が変わるので、定義の Schema を上げる。表の列が要るなら管理データの版を上げる（実装者が調べて報告）。
- 画面: READ の定義の作成で「画面を読む」を選べるようにする。path は、直近の発見の結果の画面から選ぶか、入力する。

### 3.6 画面と文書

- 発見の結果の画面: 候補ごとに probe の結果（日本語のラベル）、型（method、path の型、本文の鍵の名前、ヘッダの名前）、実行できない理由を出す。表示のカタログに足す（新しい分類で表示面のコードを変えない）。
- 文書: `doc/spec/discovery-and-read-check.md`（probe、型の分類、画面の READ、限界）、`authenticated-audit.md`（ジョブの監査の段の口）、`output.md`（成果物の項目）、`site-load.md`（probe の押下の数、読み込み直しなし）、`safety.md`（凍結の段の事前確認の扱い）。

## 4. 安全

- probe で新しくサーバへ送るものはない。CORS の事前確認は Guard が満たし、本番の要求は止める（I18 と凍結の決まりを保つ）。止めた要求は今どおり記録する。
- 型はネットワークの要求（CDP）から読み、DOM からは読まない。ページは probe の間だけ別の型を出すことができるので、probe の型は「承認の材料」にとどめる。実行の時の照合は Task 39 の Guard が行う（I20）。
- 本文はメモリの中だけで読む。目印、本文の値、`Authorization`、API の鍵、query の値は、記録・成果物・管理データ・IPC・画面に出さない（I22）。目印の検査で確かめる。
- 押すのは、削除の語に当たらない `NEEDS_BINDING` の候補だけ。password の欄には何も入れない。
- 発見と READ で読み取りの手続きの呼び出しを通すのは、利用者が登録したものだけ（D2 のユーザーの判断）。凍結の後はすべて止まる。

## 5. サイトへの負荷

- probe は読み込みを増やさない（1 画面 1 読み込みのまま）。押下は 1 画面あたり最大 3 回で、その間にサーバへ届く要求は 0。
- 発見と READ で通す読み取りの手続きの呼び出しは、Run と同じ上限（1 回の読み込みあたりの回数、サービスの Origin の 1 分あたり 120 件、1 回のジョブで 600 件）で数える。
- 画面の READ は 1 定義あたり読み込み 1 回、1 回のジョブで最大 20 定義（今の上限）。

## 6. 受け入れ条件（G37）

1. fixture に form のない登録と更新の画面を足し（実環境の観察の形）、発見のジョブの probe で、登録が `API_CREATE`、更新が `API_UPDATE` に分かれる。サーバへ届いた読み取りでない要求は 0（サーバの記録で数え、全部の後に待って数え直す。両方の Chromium）。
2. 分類の表の単体のテスト（3.3 のすべての行）と、敵対的な画面（削除の `DELETE`、upsert、array、filter のない `PATCH`、手続きの呼び出し、2 回送る、論理削除の鍵、承認していない Origin）が `NOT_EXECUTABLE` になる結合のテスト。
3. DOM clobbering とページの偽り（ボタンの語の偽り、probe を見分けて別の要求を出す、押下で別の画面へ移る）で、送られるものが 0 のまま、記録が偽らない（`PAGE_CHANGED` など）。
4. 発見と READ のジョブで、上限に届いたこと、鍵の消失、401 が成果物とジョブの結果に残り、Run Status が PARTIAL になる。上限で断った画面の候補が `MISSING` にならない。
5. 画面の READ で、データが後から描かれる画面が `MATCHED` になり、上限や 401 で描けなかった画面が `UNDETERMINED` になる（`NOT_MATCHED` にならない）。
6. 目印、本文の値、秘密が、管理データ（WAL を含む）、成果物、IPC、画面に出ない。
7. 回帰: 今の form の発見と READ、Task 34〜36 のテスト。
8. 独立レビュー（Critical 0、Important 0）と `verify:all` を 1 回。

## 7. 実装計画

Task 36（T36c）の実装者が `src/safety/`・`src/browser/`・`src/control/`・`worker-protocol.ts` を変えているので、T37a は T36c の確かめの後に始める。以降は順に行う（変えるファイルが重なるため）。

| サブタスク | 内容 | 主なファイル |
| --- | --- | --- |
| T37a | ジョブの監査の段の口（3.1）: 状態を返す、1 画面ごとの確かめ、終わり方と理由、成果物の `authentication`、IPC とジョブの結果、発見と READ で読み取りの手続きの呼び出しを通す | `src/orchestration/audit-stage-run.ts`、`src/worker/discovery-run.ts`・`read-check-run.ts`・`write-create-run.ts`、`src/discovery/` の契約、`schemas/`、`src/control/worker-protocol.ts`、ジョブの管理 |
| T37b | Guard の観察の形（3.2）: 凍結の段の事前確認の満たし、本番の要求の型の受け手、型の作り手（値を残さない） | `src/safety/`、`src/browser/context-factory.ts`、`tests/helpers/spa-auth-site-fixture.ts`（form のない画面と敵対的な画面） |
| T37c | probe の操作と分類（3.2〜3.4）: `src/interaction/` の新しいファイル、分類の純粋な関数、発見の流れへの組み込み、`submissionProbe` と Schema | `src/interaction/`、`src/discovery/`、`src/worker/discovery-run.ts`、`schemas/` |
| T37d | 画面の READ（3.5）: 定義の契約と Schema、保存の検証、ワーカーの実行、`UNDETERMINED` の決まり、画面の定義の作成 | `src/discovery/read-check-*`、`src/control/`、`src/worker/read-check-run.ts`、`apps/local-ui/` |
| T37e | 発見の結果の画面（3.6）と文書（文書の担当） | `apps/local-ui/`、`src/presentation/`、`doc/spec/` |
| T37R | 独立レビュー（実機の実験つき）と修正 | — |

## 8. 設計の変更の履歴

| 日付 | 理由 | 変更 |
| --- | --- | --- |
| 2026-10-16 | 作成 | 読み取り専用の調査（候補の発見と READ の確かめの地図）に基づいて書いた。設計者の既定（ユーザーの確認待ち）: 発見と READ で読み取りの手続きの呼び出しを通す、probe の対象と回数（`NEEDS_BINDING`、1 画面 3 回、読み込み直しなし）、入れる欄の範囲、画面の READ の path の範囲。 |
| 2026-10-16 | ユーザーの確認（戻られた後） | 設計者の既定の確認: 発見と READ で登録した読み取りの手続きの呼び出しを通す（「発見と READ では通す（推奨）」）、probe は 1 画面 3 回まで読み込み直しなし（推奨のとおり）、入れる欄に `select` を足す（「select も選ぶ」。空でない最初の選択肢）、画面の READ の path は開始の URL と同じ Origin の path だけ（推奨のとおり）。 |
| 2026-10-17 | T37b の報告（設計の解釈） | (1) 3.2・3.3 の「filter の値が画面の path の値に見える区切りと同じか」の「値に見える区切り」を、「画面の path の ID に見える区切り」と読み替える: 値に見える区切り（`isValueLikePathSegment`）か、UUID の形か、数字だけ（`isRecordIdLikePathSegment`。`src/core/api-request-shape.ts` の 1 か所）。値に見える区切りの判定は UUID と短い数字を伏せないため、書いたままでは `/admin/members/1/edit` と `PATCH ?id=eq.1` が `API_UPDATE` にならない。分類（承認の材料）だけで、送信は増えない。(2) 型の digest（`shapeDigest`）に入れる項目: method、Origin の区分と番号、path の型、query の名前、filter の形、`Content-Type` の媒体の型、`Prefer` の値、本文の最上位の形、鍵の名前と JSON の型、鍵と欄の対応。要求の種類（`fetch` と `xhr` が Chromium の都合で入れ替わる）とヘッダの名前（Chromium が足す名前がある）は、型に記録して画面に出すが digest には入れない（Chromium の更新で digest が変わらないように）。ヘッダの名前を承認に結ぶかは Task 38 の設計で決める。(3) `select` と `on_conflict` のほかの query は、すべて filter として数える（`limit` も。安全側）。 |
| 2026-10-17 | T37d の Blocker（管理データ）と、止めた読み取りの扱い | (1) 画面の path の定義を保存するため、未公開の管理データの版 12 に `read_checks` と `read_check_results` の作り直しを足す（`target_identity_digest` は NULL を許し、`target_page_path` を足し、ちょうど 1 つ、画面の定義の送る値は `{}`）。(2) 3.5 の「判定できないとき」の「止めた読み取りの手続きの呼び出し」を、次に絞る: 断ったサービスの Origin への要求とサービスの Origin の 401、鍵の消失、登録した読み取りの手続きの呼び出しを回数や送り方で止めたこと、承認したサービスの Origin への読み取りでない要求を止めたこと。許可 Origin への計測の送信などは数えない（実テスト環境の画面に計測の送信があり、数えるとほぼすべてが UNDETERMINED になるため）。token の更新を止めたことだけでは数えない。(3) `read-evidence` を 1.2 にし、読み手は 1.0〜1.2 を受ける。(4) 画面の定義は、書き込みの照合の READ には使えない（拒む）。 |
| 2026-10-17 | T37c の報告 | (1) probe で押さない画面は、ログインの画面（セッションの切れの path）に加え、監査の段の除外の画面も含める（`isExcludedCrawlCandidate`。安全側の読み替え）。(2) 発見のジョブには必ず観察の口があるので、form のログインのサイトでも `NEEDS_BINDING` の候補を凍結の中で押す（送るものは 0。承認した API の Origin がなければ結果は `UNAPPROVED_ORIGIN` など）。(3) 成果物の版は 1.1 のまま `submissionProbe` を任意の項目として足し、1.0 の文書は持てない。 |
| 2026-10-17 | T37R（Critical 0、Important 3、Minor 5。送信の安全の問題なし） | (I-1) probe を行った Context は、閉じるときに渡す状態と鍵の消失の判定に、凍結の直前に読んだ状態を使う（押下の書き換えを受け継がない）。(I-2) 落ち着きの待ちは、応答を受けた後に本文が終わっていない要求を、応答から名前つきの猶予（既定 2 秒）まで進行中に数える（DEF-127 と遅い本文の両立。猶予を超える遅い本文は限界）。(I-3) 手続きの呼び出しの path は decode して大文字と小文字を畳んで比べる、切り詰めや伏せた鍵のある型は `NOT_EXECUTABLE`（`SHAPE_TRUNCATED`）、論理削除の判定は伏せる前の名前で。(M-1) `API_UPDATE` の filter の値は画面の path の最後の ID に見える区切りと照らす（列の名前は見ない限界）。(M-2) 「描けなかった画面」の判定を `audit-stage-run.ts` の 1 か所に寄せ、発見と READ で共有。(M-3) 書き込みのジョブの照合の READ にも UNDETERMINED の決まりを当てる。(M-4) probe の凍結の確かめは Guard の段階を直接読む。(M-5) **設計者の既定（ユーザーの確認待ち）**: 許可 Origin への読み取りでない要求のうち、要求の種類が `fetch`・`xhr` のものを止めたら「描けなかった画面」に数える（`ping`・`beacon` の計測は数えない）。 |
| 2026-10-17 | T37R-fix-B の Blocker（M-5 と計測の送信） | M-5 の設計者の既定（許可 Origin への `fetch`・`xhr` の読み取りでない要求を止めたら「描けなかった画面」に数える）を取り下げる。fixture の計測の送信が `fetch` の POST で、要求の種類ではデータを取る `fetch` と計測を見分けられず、実テスト環境の計測の送り方も未確認のため（数えるとほぼすべての READ が UNDETERMINED になりうる）。数（`allowedOriginDataRequestsBlocked`）は記録して成果物に残すが、判定には使わない。同じ Origin の POST でデータを取る画面が描けずに NOT_MATCHED になりうることは限界として文書に書く。実テスト環境の観察の後に、ユーザーと決め直す。 |
| 2026-10-17 | T37R2（I-1・M-1・M-2） | (I-1) 子の frame の読み込み直しと移動にも上限を当てる: ページが始めた文書の読み込みを、frame ごとに 2 回まで（main frame と同じ数え方）、子の frame の文書の要求の数を成果物に別の数として残す。サブリソースの連続の要求（`setInterval(fetch)` など）の上限は DEF-130 として記録し、ユーザーの判断を待つ（通常のブラウザの閲覧と同じ振る舞いのため）。(M-1) 手続きの呼び出しの path の判定は `exclusionMatchPathFormsOf` の形のどれかで行う（二重の encode、`;` の引数）。(M-2) path が上限を超えて伏せた型は `SHAPE_TRUNCATED`、method を上書きするヘッダ名と本文の鍵（閉じた一覧: `X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override`、`_method`）がある型は `NOT_EXECUTABLE`（新しい理由）、入れ子の本文の論理削除は限界。 |
