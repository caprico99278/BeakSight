# Task 33 設計書 — 観察と fixture の基盤（スクリプトで送るログインの SPA）

状態: ユーザー承認済み（2026-10-16「Task 33の設計を承認する」）
作成: 2026-10-16（設計者）
ロードマップ: `2026-10-16-beaksight-task-33-42-roadmap.md` の Task 33（ユーザー承認済み 2026-10-16）

## 1. 目的

Task 34〜41 の設計と、テストの土台を作る。次の 3 つを行う。

1. 実テスト環境の振る舞いを、ユーザーが普段のブラウザの開発者ツールで観察するための手順書を作る（ロードマップ 1.4 の推測を確かめる）。
2. 127.0.0.1 に、スクリプトで送るログインの SPA と、別のホストの認証と API のサーバを持つ fixture を作る。
3. その fixture に対して、**今の** BeakSight のログインの段と監査の段がどう振る舞うかを、テストで固定する（Task 34・35 の RED の材料と、ロードマップ 1.2 の事実の確かめ）。

製品のコード（`src/`）は変えない。

## 2. ユーザーの判断と前提

- ロードマップの範囲（B と C）、token の送信先は別のホスト、ログインの状態はローカル ストレージ（2026-10-16）。
- 実サイトへは接続しない。観察はユーザーが自分のブラウザで行い、設計者は形（ドメインと値を伏せたもの）だけを記録する。
- 外部の認証のサービスの名前を、Git に載るファイルに書かない。fixture の path（`/auth/v1/token` など）は、一般的な形として使ってよい。

## 3. 設計

### 3.1 観察の手順書（作業 A）

`doc/spec/script-login-observation.md` を作る。ユーザーが、普段のブラウザの開発者ツール（「ネットワーク」タブで「ログを保持」、「アプリケーション」タブ）で、テスト環境について次を確かめる手順と、記録の形（表。ドメイン・値・トークンは書かない）。

| 番号 | 確かめること | ロードマップの用途 |
| --- | --- | --- |
| O1 | ログインの送信: 種類（fetch・xhr）、送り先のホストがログインの画面と別か、method、query の名前、本文の形式（JSON か）、要求のヘッダの名前（値は見ない） | Task 34 の I17 |
| O2 | 事前確認（OPTIONS）が出るか | I18 の確かめ |
| O3 | ログインの後のローカル ストレージの鍵の名前の形（例 `…-auth-token`）。値は見ない | Task 34 の成功の条件 |
| O4 | 管理画面のデータの読み方: API への GET か、POST の手続きの呼び出し（path に `rpc` を含む、など）か。1 画面を開いたときの API の要求の数 | Task 35、D2、負荷の上限 |
| O5 | token の更新: 何分ほどで `grant_type=refresh_token` の POST が出るか（画面を開いたまま待つ） | D1 |
| O6 | WebSocket の接続があるか（「WS」で絞り込む） | D5 |
| O7 | 登録と更新の送り方（実際には送らない）: 画面の構造（フォームの欄の名前、送信のボタン）だけを見る。実際に登録・更新を押して観察するかは、ユーザーが判断する（テスト環境のデータが変わるため）。押す場合は、テスト用のデータだけに | Task 37〜41 |
| O8 | ログアウトの方法（画面の path、ローカル ストレージを消すだけか） | 読まないパス、セッションの切れ方 |

### 3.2 SPA の fixture（作業 B）

`tests/helpers/spa-auth-site-fixture.ts`（新規）。今の `authenticated-site-fixture.ts`・`loopback-server.ts` の作りに合わせ、テストの補助として置く。

- **2 つの Origin**: アプリの Origin（SPA の HTML と JS）と、バックエンドの Origin（認証と API）。どちらも 127.0.0.1 で、ポートが違う（別の Origin）。テストのために、認証と API を別の Origin に分ける指定も持つ（第 3 の Origin）。
- **アプリの画面**（ページの移動で開く。中の操作はスクリプト）:
  - `/auth`: `action` のないフォーム。スクリプトがバックエンドの `POST /auth/v1/token?grant_type=password`（JSON の本文 `{ email, password }`、API の鍵のヘッダ、`Content-Type: application/json`。事前確認が出る形）を送り、200 なら応答の JSON をローカル ストレージの名前つきの鍵に保存して `/admin` へ移る。誤りなら画面に誤りを出す。
  - `/admin`: ローカル ストレージになければ `/auth` へ移る。あれば `GET /rest/v1/members`（`Authorization: Bearer`、API の鍵のヘッダ）で一覧を読み、各行に `/admin/members/<id>/edit` へのリンク、`/admin/members/new` へのリンク。
  - `/admin/members/new`: `action` のないフォーム。押すと `POST /rest/v1/members`（JSON、`Prefer: return=representation`）。
  - `/admin/members/<id>/edit`: `GET /rest/v1/members?id=eq.<id>` で前の値を読み、押すと `PATCH /rest/v1/members?id=eq.<id>`。削除のボタン（`DELETE`）と、論理削除の欄（`deleted`）を持つ。
  - `/auth/logout`: ローカル ストレージを消して `/auth` へ移る。
- **バックエンドの振る舞い**: token（password と refresh。有効期限は指定できる）、members の読み書き（メモリの中）、CORS（事前確認に 204 と CORS のヘッダ、本番の要求に `Access-Control-Allow-Origin`）。API の鍵と Bearer を確かめ、違えば 401。
- **振る舞いの指定**（テストが選ぶ）: `refreshAfterMs`（画面が token の更新を送るまでの時間）、`rpcReads`（一覧を `POST /rest/v1/rpc/list_members` で読む）、`websocket`（管理画面が WebSocket をつなぐ）、敵対的なログイン（`loginTwice`、`loginOtherGrant`、`loginToThirdOrigin`、`loginExtraPost`、`refreshLoop`）。
- **記録**: バックエンドとアプリに届いた要求を順に記録する（Origin の別、method、path と query、要求のヘッダの名前、事前確認か、Bearer が正しかったか、JSON の本文の鍵の名前）。値は記録しない。
- **秘密**: パスワード、token、API の鍵はランダムな仮の値で、`secretValues()` で目印の検査にだけ使う。

### 3.3 今の BeakSight の振る舞いを固定するテスト（作業 C）

新しい結合のテスト `tests/integration/spa-script-login-baseline.test.ts`（両方の Chromium）。期待は「今の振る舞い」で、Task 34・35 で意図して変わるもの（`baseline` と名前に付ける）。

| 場面 | 今の振る舞いとして固定すること |
| --- | --- |
| C1 手動のログインの段（今のログインの段の Context と Guard。フォームの送信先を登録した認証の設定） | `/auth` は表示される。ログインのスクリプトの token の送信は Guard が止め、バックエンドに届かない（0 回）。事前確認もバックエンドに届かない（0 回）。止めた記録が残る。 |
| C2 監査の段（ログインの状態をローカル ストレージに入れた認証済みの状態から、今の監査の Context と Guard） | `/admin` が開き、`GET /rest/v1/members` がバックエンドに届く（Bearer つき）。事前確認はバックエンドに届かない（Guard が満たす）。画面に一覧が出る。 |
| C3 監査の段の token の更新（`refreshAfterMs` を短く） | 更新の POST は止められ、バックエンドに届かない。止めた記録が残る。 |
| C4 監査の段の RPC の読み取り（`rpcReads`） | RPC の POST は止められ、一覧は出ない（画面は誤り）。 |
| C5 監査の段の WebSocket（`websocket`） | 今の Guard の決まりどおり止める（届かない）。 |
| C6 秘密 | 成果物・記録に、パスワード、token、API の鍵の目印が出ない。 |

C2 の認証済みの状態の作り方は、今の `context-factory.ts` の形（Cookie と Origin ごとのローカル ストレージ）をテストが組み立てる。どの部品を通すか（`createAuthenticatedPassiveContext` など）は、実装者が今のコードで確かめて報告する。

## 4. 安全と負荷

- 製品のコードは変えないので、安全の振る舞いは変わらない。作業 C は、今の Guard が止めることを確かめる側のテスト。
- fixture は 127.0.0.1 だけ。テストの時間は、今の結合のテストの上限に収める。

## 5. 共通化

- 2 つの Origin の待ち受けは `loopback-server.ts` を使う。秘密の仮の値は `authenticated-site-fixture.ts` の `randomSecretValue` を使う。目印の検査は `tests/helpers/leak-places.ts` を使う。
- 新しい補助を台帳（`beaksight-shared-components.md`）に載せる。

## 6. 受け入れ条件（G33）

1. 観察の手順書が、O1〜O8 と記録の形を持ち、名前を書かない形になっている。
2. fixture の振る舞いのテスト（Guard なしのブラウザで、ログイン、一覧、登録、更新、削除、token の更新、事前確認がバックエンドに届くこと、敵対的な形の要求）が、両方の Chromium で PASS する。
3. 作業 C の C1〜C6 が、両方の Chromium で PASS する（今の振る舞いの固定）。
4. `npm run typecheck`、関係するテスト、`npx vitest run tests/unit tests/architecture` が PASS する。
5. 製品のコードの差分がない。

## 7. 実装計画

| サブタスク | 中身 | 担当 |
| --- | --- | --- |
| T33a | 観察の手順書（3.1） | 文書の担当 |
| T33b | SPA の fixture と、その振る舞いのテスト（3.2） | 実装者 |
| T33c | 今の振る舞いを固定するテスト（3.3） | 実装者（T33b の後） |

T33a と T33b は並行。T33c は T33b の後。独立レビューは Task 34 と合わせて行う（Task 33 は製品のコードを変えないため）。

## 8. 設計の変更の履歴

| 日付 | 理由 | 変更 | 影響 |
| --- | --- | --- | --- |
| 2026-10-16 | 初版 | ロードマップの Task 33 の「Guard の記録に要求の種類を足す」は、公開の監査の出力（スキーマと golden）を変えるため、Task 34 の設計（ログインの段の記録）に移した。 | Task 34 |
| 2026-10-16 | T33a・T33b・T33c の完了と観察の結果 | 観察の追加（ログインの前の手続きの呼び出し POST 2 回、ログインの直後のサーバの関数 OPTIONS と POST、計測の送信、form のない登録・更新の画面、全セッションを無効にするログアウト）を fixture の指定（`preLoginRpc`・`postLoginFunction`・`rumBeacon`）と baseline の C7・C8 に足した。G33 の条件を満たした（Task 33 完了）。 | Task 34・35・37 |
