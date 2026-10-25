# Task 34 設計書 — 認証の設定 v3 と、手動のログインのスクリプトの送信

状態: ユーザー承認済み（2026-10-16「Task 34の設計を承認する」）。G34 承認（2026-10-16「Task 34を承認する」）
作成: 2026-10-16（設計者）
ロードマップ: `2026-10-16-beaksight-task-33-42-roadmap.md` の Task 34（ユーザー承認済み）。Task 33 の結果（`2026-10-16-beaksight-task-33-observation-fixture-design.md`、作業記録の T33c の「今の作りで分かった事実」）。

## 1. 目的

本来の監査対象のサイトのテスト環境のように、画面の中のスクリプトが別のホストの認証のサービスへ token を取りに行くログインで、**手動のログイン**（利用者が BeakSight の開いたブラウザでログインする）を通せるようにする。ログインの後の監査は、今の監査の段のまま動かす（読み取りの手続きの呼び出しは Task 35）。自動ログインは Task 36。

## 2. ユーザーの判断と事実

- ロードマップ: B と C、token の送信先は別のホスト、ログインの状態はローカル ストレージ（2026-10-16）。
- D2・D7（2026-10-16）: ログインの段で、token の送信のほかの POST（ログインの前の手続きの呼び出し、ログインの直後のサーバの関数）は「利用者が登録したものだけ通す」。既定は空（すべて止める）。
- 観察（形だけ）: ログインの前に手続きの呼び出しの POST、ログインの前から API の GET、token の POST の前に事前確認、ログインの直後にサーバの関数の POST（事前確認つき）、ログインの後の画面は document の読み込み、鍵は「接頭辞・識別子・`-auth-token`」の形、ログアウトは全セッションを無効にする API の送信。
- 今の作り（調査の地図、2026-10-16）:
  - ログインの段の Guard は、`request-policy.ts` の `classifyPassiveRequest` の中の `isAllowedSubmissionPost` で「main frame のページの移動の POST」だけを通す。スクリプトの POST は `NON_READ_METHOD`。
  - Guard はどの段も設定の `site.allowedOrigins` で判定する。ログインの段は、その外の要求をすべて止める（`submissionStageBlockReason`）。
  - 回数は `SubmissionPostAdmission` の 1 つの数。`loginAttemptsExceeded` は Ledger の止めた POST を `isLoginEndpointPost` で照らし直すので、止めた送信が「試み」として数えられる（T33c の C1b）。
  - 事前確認は、どの段も Guard が 204 で満たし、サーバに送らない。
  - ローカル ストレージの引き継ぎは、今の作りのまま効く（`filterAuthenticatedState` は承認した Origin のローカル ストレージを残す）。
  - 監査の段は、許可 Origin の外への GET（API への Bearer つきの読み取りを含む）を通す。

## 3. 設計

### 3.1 プロファイル: 承認したサービスの Origin（I19）

- プロファイルに任意の項目 `approvedServiceOrigins`（HTTPS の Origin の閉じた一覧、上限 4、`TEST` の 2 つのモードだけ、既定は空）を足す。認証のサービスと API の Origin を入れる。
- 設定の `site.allowedOrigins` と重ねない（重なれば拒む）。クロールの対象、読み込みの数え方、サイトの情報の取得の対象は広げない。
- `profile.schema.json` は版を上げず、任意の項目として足す（書き込みの報告の前例）。項目がないプロファイルの digest は変わらない（承認は無効にならない）ことをテストで確かめる。

### 3.2 認証の設定 v3

- 新しい版 `beaksight-auth-setup/3`。保存してある v1・v2 は、**そのままの版で読み、そのままの版で digest を求める**（承認を無効にしない）。v3 は、新しく保存するときだけ。`validateAuthSetup` は v2 と v3 を受ける。
- 新しい項目:
  - `loginTransport`: `FORM_NAVIGATION`（今の形）か `SCRIPT_REQUEST`。v2 の設定は `FORM_NAVIGATION` とみなす。
  - `scriptLogin`（`SCRIPT_REQUEST` のときだけ。必須）: `origin`（`approvedServiceOrigins` のどれか）、`path`、`requiredQuery`（名前と値の完全な一致の組。上限 4。例 `grant_type=password`）。method は `POST` に固定。
  - `loginSideRequests`（任意。上限 8）: 利用者が登録した「ログインに伴う送信」。各項目は `origin`（許可 Origin か `approvedServiceOrigins`）、`path`（完全一致）、`method`（`POST` だけ）、`maxPerLoginStage`（1〜3）。query と本文は照らさない（利用者の判断で登録するもの。手順書に書く）。
  - `successStorageKey`（`SCRIPT_REQUEST` のとき必須）: 成功の条件に足す、ローカル ストレージの鍵の名前の形（`prefix` と `suffix`。例 接頭辞と `-auth-token`）と、その Origin（許可 Origin のどれか）。値は読まない。
- 既存の制約（`maxLoginAttempts` 1〜3、成功の条件の path、読まないパス、読む範囲、セッションの切れの path）は、そのまま使う。`SCRIPT_REQUEST` のとき、`loginPostEndpoints`（フォームの送信先）は空でよい。
- スキーマ `auth-setup-v3.schema.json` を足し、検証器、IPC（`worker-message.schema.json` の認証の設定の参照）、`worker-protocol.ts` の確かめ（送信先の Origin が承認したものに入ること）を v3 に合わせる。

### 3.3 ログインの段の Guard（I17）

判定は `request-policy.ts` の `classifyPassiveRequest` の 1 か所で行い、Guard と中継（`passiveEgressRequestPolicy`）はそれを使う（第二の判定を作らない）。

- `LoginStagePolicy` に、`scriptLogin`、`loginSideRequests`、`approvedServiceOrigins` を渡す。
- 要求の事実（`HttpRequestFacts`）に、要求の種類（`resourceType`。CDP の事象と route の要求から）を足す。
- 段の決まり（ログインの段だけ）:
  1. 事前確認: 今どおり Guard が満たす（I18）。
  2. `approvedServiceOrigins` への GET・HEAD: 読み取りとして通す（クロールはしない）。数える。
  3. スクリプトの token の送信: `POST`、種類が fetch か xhr、Origin・path・`requiredQuery` が `scriptLogin` と完全に一致、残りの回数（`maxLoginAttempts`）が 1 以上、のときだけ通す。
  4. 登録したログインに伴う送信: `POST`、種類が fetch か xhr、Origin・path が一覧のどれかと完全に一致、その項目の残りの回数が 1 以上、のときだけ通す。
  5. それ以外の読み取りでない要求、`approvedServiceOrigins` と許可 Origin の外への要求: 今どおり止めて記録する。
- 回数は、送信先ごとに残りを持つ形に `SubmissionPostAdmission` を広げる（route の層への印の受け渡しは今の仕組み）。
- 送信の窓（今の作り）は、`SCRIPT_REQUEST` では token の送信を通した時点から、成功の確かめまでとする。窓の中で通すのは、上の 2・4 と、許可 Origin の中の読み取り。

### 3.4 試みの数え方と成功の確かめ

- `loginAttemptsExceeded` の Ledger からの読み直しをやめ、Guard の記録（ログインの段の monitor）が返す数を使う: 「token の送信を、上限を超えて送ろうとして止めた数」が 1 以上なら上限を超えた。上限の中で止めた送信（種類や query の違い）は、試みに数えない（別の理由で記録する）。
- `SCRIPT_REQUEST` の成功: 今の成功の条件（Origin、path、任意のセレクタ）に加え、Node の側で読む `storageState` に、`successStorageKey` の形の鍵が、その Origin のローカル ストレージにあること（ページの中では読まない）。
- 誤りの区分: token の送信が通らないまま時間切れ（`LOGIN_TIMEOUT`）、上限を超えた（`LOGIN_ATTEMPTS_EXCEEDED`）、成功の条件に当たらない、は今の区分のまま。

### 3.5 記録

- ログインの段の monitor に、種類ごとの数（通した token の送信、通したログインに伴う送信（項目ごと）、サービスの Origin への読み取り、止めた要求（理由ごと））を持たせる。URL・本文・値は持たない。
- 数だけを、ログインの段の結果として IPC の認証の状態に任意の項目で載せ、ジョブの画面に出す（`worker-message.schema.json` の版は上げない）。公開の監査の成果物（`page.json`）のスキーマは変えない。

### 3.6 画面と文書

- プロファイルの画面: 「承認したサービスの Origin」の欄（テスト環境だけ）。
- 認証の設定の画面: ログインの送り方の選択、スクリプトの送信先（Origin、path、必須の query）、ログインに伴う送信の一覧（追加と削除）、成功のローカル ストレージの鍵の形。文言はカタログ。
- 文書: `authenticated-audit.md`（スクリプトで送るログインの節）、`real-test-environment.md`（ログインの方式の確かめ方から登録の値へのつなぎ、ログインに伴う送信は「まず空で試し、止めた記録を見て、要るものだけを登録する」手順、全セッションを無効にするログアウトの注意: 監査の間は普段のブラウザで同じアカウントからログアウトしない）、`profiles.md`。

## 4. 安全

- 新しく通すのは、利用者が登録した送信先への fetch・xhr の POST の決まった回数と、承認したサービスの Origin への読み取りだけ。種類が document・beacon・ping・other の POST、別の送信先、別の query、上限を超えた送信は止める。
- 本文は照らさない（手動のログインは利用者が入力する。Task 36 の自動ログインで照らす）。
- token、API の鍵、ローカル ストレージの値を、管理データ、成果物、ログ、IPC、画面に出さない（I22）。目印の検査で確かめる。
- 公開の監査（`PUBLIC_PASSIVE`）と、フォームの送信のログイン（`FORM_NAVIGATION`）の振る舞いは変えない（golden、`guard-login-stage`、`automated-login*` の回帰）。

## 5. 受け入れ条件（G34）

1. fixture（`startSpaAuthSite`、`preLoginRpc: optional`）で、本物のワーカーの手動のログインの監査が、ログインから監査の終わりまで通る（両方の Chromium）。ローカル ストレージの状態が監査の段に引き継がれ、一覧が読める。
2. `preLoginRpc: required` と `postLoginFunction` は、登録したときだけ通り、登録しないときは止まって記録される（回数の上限も）。
3. 敵対的なログイン（`loginTwice`・`loginOtherGrant`・`loginToThirdOrigin`・`loginExtraPost`・`refreshLoop`）が、設計の回数と送信先のとおりに止まる（バックエンドの記録で数える。両方の Chromium。全部の後に待って数え直す）。種類が document の POST や beacon は、送信先が同じでも止まる。
4. baseline の C1a・C1b・C7 を、新しい期待に意図して直す（C2〜C6・C8 は変わらない）。
5. 秘密の目印が、管理データ（WAL を含む）、IPC、成果物、ログ、画面に出ない。
6. 回帰: 公開の監査の golden、`cli-output-parity`、フォームの送信のログイン（`guard-login-stage`、`audit-worker-auth`、`automated-login*`）、承認（v2 の設定の digest が変わらないこと）。
7. 独立レビュー（Critical 0、Important 0）。

## 6. 実装計画

| サブタスク | 中身 | 変えるファイル（主） |
| --- | --- | --- |
| T34a | 契約: プロファイルの `approvedServiceOrigins`、認証の設定 v3（型、スキーマ、検証、保存、digest は保存した版のまま）、IPC の確かめ | `src/control/`、`schemas/` |
| T34b | 判定と Guard: `LoginStagePolicy` の拡張、要求の種類、送信先ごとの回数、サービスの Origin の読み取り、中継、monitor の数 | `src/safety/`、`src/browser/context-factory.ts` |
| T34c | ワーカー: 試みの数え方、成功の鍵の確かめ、ログインの段の結果の数と IPC、端から端のテスト、baseline の直し | `src/worker/`、`tests/` |
| T34d | 画面と文書 | `apps/local-ui/`、`src/presentation/`、`doc/spec/` |

順: T34a → T34b → T34c。T34d は T34a の後、T34b・T34c と並行（ファイルが重ならない）。最後に独立レビュー（T34R）と、承認の後の `verify:all`（1 回）。

## 7. 決める必要があること

- なし（D2・D7 はユーザーの判断済み）。D1（監査の段の token の更新）と、監査の段の読み取りの手続きの呼び出しは Task 35。

## 8. 設計の変更の履歴

| 日付 | 理由 | 変更 | 影響 |
| --- | --- | --- | --- |
| 2026-10-16 | 初版 | ロードマップ 4 章の「プロファイル: 承認した API の Origin の一覧」を `approvedServiceOrigins`（認証と API の両方）とした。認証の設定 v3 は保存してある v2 を変換しない（digest を変えない）。 | Task 35〜41 |
| 2026-10-16 | T34c の報告（画面の数の表示には管理データの列が要る）と、利用者が登録の中身を決める材料 | 3.5 を広げた: ログインの段で止めた読み取りでない要求の Origin と path（query・本文・値なし、重ねない、上限 8）と理由を、数と一緒に IPC で渡し、管理データのジョブに残し（新しい版）、ジョブの画面に出す。成果物には入れない。サブタスク T34e を足した。 | `src/control/`、`apps/local-ui/` |
