# BeakSight Task 26 テスト環境の自動ログイン 設計書

作成日: 2026-10-10
状態: ユーザー承認済み（2026-10-10。10 章の 4 点を含む）。G26 承認（2026-10-11。全体の検証の通しの PASS は、単独で通る揺らぎを記録したうえで、Task 26 だけの例外として承認）
対象範囲: テスト環境（`TEST_AUTH_PASSIVE`）のプロファイルで、画面で一度だけ入力して Windows の DPAPI で暗号化して保存したテスト用の資格情報を使い、BeakSight が自動でログインする。ログインだけを試して結果を区別する「ログインの検証」と、自動ログインの後に Task 25 と同じ読み取りだけの監査を行うことの両方を作る。保存した資格情報の変更と削除も扱う

## 1. 目的

Task 25 では、人が BeakSight の開いたブラウザで手でログインし、その状態を監査へ渡した。Task 26 では、テスト用のアカウントの資格情報を BeakSight が使ってログインする。目的は次の 2 つ。

1. **ログインの検証**: 正規のログインが通るかを確かめ、成功・資格情報の誤り・アカウントのロック・MFA で人の操作が要る・資格情報の期限切れ・回数の制限（429）・分からない、を区別して報告する。監査は行わない。
2. **自動ログインの後の監査**: 自動ログインが成功したら、Task 25 と同じく、状態をメモリの中だけで新しい Guard つきの監査の Context へ渡し、読み取りだけで監査する。

どちらも、ログインに要る 1 回の POST のほかに、読み取りでない要求を送らない。資格情報は、DB・URL・ログ・成果物・IPC・画面に平文で出さない。アカウントのロックを誘発する連続の試行をしない。

## 2. 根拠となる文書と、ロードマップからの読み替え

- 従う文書: ロードマップ `2026-10-09-beaksight-task-22-32-roadmap.md` の Task 26、3 章（I03〜I05、I09、I11、I14、I16）、6.2、9 章（認証秘密）、11 章（RF2）、12 章、ADR-003、ADR-013。Task 25 の設計書（`2026-10-10-beaksight-task-25-manual-login-session-design.md`）の 4.1〜4.7 と変更履歴。
- 調査: 作業記録 `progress.md` の「T26 調査」「T26 追加調査」の行（scratchpad の実験。2 つの Chromium、DPAPI、icacls、置き換え）。
- ユーザーの判断（2026-10-10）:
  - 資格情報は、画面で一度だけ入力し、Windows の暗号化（DPAPI の CurrentUser）をかけたファイルとして `local/secrets/`（Git の対象外）に保存する。ファイルの権限は今の Windows の利用者だけに絞る。npm の依存は足さない。
  - 範囲は、ログインの検証と、自動ログインの後の監査の両方。
  - 保存した資格情報を変更する場合の設計も含める。
- 読み替え:
  - ロードマップ 6.2 の「OS 側の安全な入力経路／秘匿ストア」は、「管理画面（127.0.0.1）での入力」と「DPAPI で暗号化したファイル」と読む。
  - ロードマップの「`src/control/auth/automated-login.ts`」は置き場所の例と読み、4 章の置き場所に従う。
  - ロードマップの「セッション失効」の区別は、ログインの検証では「資格情報の期限切れ（パスワードの期限切れの画面）」、監査の途中では Task 25 の `AUTH_SESSION_LOST` と読む。
- 引き続き守る不変条件: 公開監査の不変（I02）、Guard の Read-Only（I08、I09）、ログインの段の送信は送信先と完全一致する main frame のナビゲーションの POST だけ（RF2、I05）、秘密を出さない（I11）、Task 25 の Gate（`worker-boundary`、`worker-login-hooks`、`control-boundary`、`control-store-boundary`、`local-ui-boundary`、`semantic-ownership`）。

## 3. 採用する設計

- **資格情報の保存**: 画面のサーバが、保存の要求のときだけ平文を受け取り、DPAPI で暗号化してファイルに書き、すぐに捨てる。ユーザー名とパスワードは別々に暗号化する。追加の entropy にプロファイルの ID・ログインの Origin・項目の名前を入れ、ほかのプロファイルへの付け替えや、ユーザー名とパスワードの入れ替えでは戻せないようにする。
- **復号はワーカーだけ**: `START` に入れるのは、資格情報の改訂の番号（秘密でない）だけ。ワーカーが、フォームに値を入れる直前に復号し、入れた後に捨てる。IPC に秘密を含めない（Task 25 の原則を保つ）。
- **値を入れる部品を 1 つにする**: `fill` と `click` を使ってよいのは、新しい 1 ファイルだけ。値を入れる前に、フォームを読むだけで確かめる（POST であること、送信先が許した送信先と完全に一致すること、password 型の欄があること、3 つの要素が同じフォームにあること）。送信は Task 25 のログインの段の Guard の上で行い、回数の上限は 1 に固定する。
- **結果の区別**: 認証の設定にある閉じた一覧の条件に、ちょうど 1 つ当たったときだけ結果を決める。0 か 2 以上なら「分からない」で止める。成功の条件に当たらないことから、資格情報の誤りと推し量らない。
- **ロックを誘発しない上限**: 1 回のジョブで POST は 1 回だけ。成功以外で終わったら、人が画面で確かめるまで、そのプロファイルの自動ログインを止める。自動ログインどうしの最小の間隔と、24 時間の上限を設ける。429 の `Retry-After` を守る。
- **手動の方式へ切り替えない**: 自動ログインが失敗しても、headed のブラウザを開かない。手動に変えるのは、人がプロファイルを変えたときだけ。
- **Windows だけ**: Windows 以外では、自動ログインを実行できる方式にせず、資格情報の画面も出さない。

採らなかった案:
- 毎回画面で入力してメモリだけに置く案（調査の推奨）。ユーザーの判断により、一度だけの入力と保存を採った。
- 環境変数の名前を保存する案。シェルの履歴やレジストリに平文で残るおそれがあり、任意の環境変数を指すと別の秘密を送ってしまうため。
- Windows の資格情報マネージャー。Node の標準で読めず、子プロセスの範囲が広がるため。
- 平文のファイル（権限を絞るだけ）。バックアップや同期で平文のまま写るため。

## 4. 詳細設計

### 4.1 資格情報の保存の部品（`src/control/credentials/`）

- **暗号化の部品** `dpapi-protector.ts`: `CredentialProtector`（`protect(plain, entropy)`、`unprotect(cipher, entropy)`）。
  - 本番の入口は引数なしで、`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` を絶対パスで、`-NoLogo -NoProfile -NonInteractive -EncodedCommand <固定の文>` で起動する。
  - 平文と entropy は stdin で base64 の行として渡す。結果は stdout の base64 で受ける。平文を、スクリプトの本文・起動の引数・環境変数・cmdlet の引数に入れない（.NET のメソッドだけで扱う）。
  - 子プロセスの stderr は読まず、記録もしない。終了コードだけで成否を決める。時間の上限（名前つきの定数。例 10 秒）を過ぎたら止める。
  - `Add-Type -AssemblyName System.Security` を使う。実行のポリシーは指定しない。
  - テストでは、本番の入口ではなく、関数の引数で偽の部品を渡す（Task 25 の `worker-login-hooks` と同じ形。本番の入口は引数なし。偽物の名前が `src/` に出ない）。
- **ファイルの部品** `credential-store.ts`: 置き場所、ファイルの形、権限、置き換え、削除、読み出し。
  - 置き場所: `<リポジトリの根>/local/secrets/<profileId>.credential.json`。場所の決め方は `resolveControlDatabasePath` と同じく、根を引数で受ける 1 つの関数にする（テストは一時のフォルダ）。`profileId` は今の形の決まり（`[a-z0-9-]`）を確かめてから使い、外れたら拒む。
  - ファイルの形（`beaksight-credential/1`）: `format`、`profileId`、`loginOrigin`、`credentialRevision`（1 から）、`createdAt`、`updatedAt`、`lastChangeKind`、`protection: "DPAPI_CURRENT_USER"`、`username`（暗号文）、`password`（暗号文）。暗号文のほかに秘密を持たない。JSON Schema を `schemas/control/` に置く。
  - entropy: `beaksight-credential/1|<profileId>|<loginOrigin>|<username か password>`。
  - 権限: フォルダがなければ作り、中に書く前に `icacls`（絶対パス）で継承を外し、今の利用者の SID だけに読み書きを与える。書く前に毎回、所有者が今の利用者で、許可が今の利用者だけであることを読んで確かめ、違えば書かない（`CREDENTIAL_STORAGE_UNSAFE`）。
  - 置き換え: 同じフォルダに一時のファイルを `wx` で作り、書いて fsync して閉じてから、本体へ rename する。rename が `EPERM` などで失敗したら、短く待って決まった回数だけやり直し、だめなら一時のファイルを消して、古いファイルを残したまま「置き換えられなかった」で終える。読む側は `readFile` で開いてすぐ閉じる。
  - 起動のとき（`setup:local` と `npm run ui` の準備）: `local/secrets/` に残った一時のファイルを消す。目印でない仮の値で暗号化の往復を 1 回確かめ、結果（使える、使えない）を環境の状態に出す（値は出さない）。
  - 削除: `unlink`。プロファイルを取り消したときも消す。
- **Gate**（`tests/architecture/`）:
  - `child_process` を import してよいのは、今のワーカーの起動の箇所と、`dpapi-protector.ts` と、権限の部品（`credential-store.ts` か、その中の 1 つの関数）だけ。
  - `powershell`、`icacls`、`ProtectedData` の文字列は、その 2 ファイルだけ。
  - `local/secrets` の場所を作るのは `credential-store.ts` だけ。

### 4.2 資格情報の画面と変更（`apps/local-ui/`）

- プロファイルの詳細から開く「資格情報」の画面。プロファイルが `TEST_AUTH_PASSIVE` で `AUTOMATED_LOGIN`、かつ Windows のときだけ出す。
- **値は画面に一度も出さない。** 出すのは、保存の有無、作った時刻、最後に変えた時刻と種類、ログインの Origin、保存した Origin が今の認証の設定と合うか（合わなければ「入れ直しが必要」）、暗号化が使えるか。
- **新しく登録**: ユーザー名とパスワードの両方が必須。パスワードは 2 回入力して、一致を確かめる（打ち間違いによる失敗とロックを減らす）。
- **変更**: 「ユーザー名を変える」「パスワードを変える」を選び、選んだ方だけの入力の欄を出す。
  - 選ばなかった方は、暗号文をそのまま写す（復号しない）。
  - 空の欄は「消す」の意味にせず、拒む。どちらも選ばなければ拒む。
  - 変更の種類は `USERNAME_CHANGED`、`PASSWORD_CHANGED`、`BOTH_CHANGED`。
- **削除**: 確かめの後に削除する。それ以降、自動ログインは始められない（`CREDENTIAL_MISSING`）。
- **ジョブが動いているとき**: そのプロファイルのジョブが終わっていない間は、変更も削除も拒む（`CREDENTIAL_IN_USE`）。それでも食い違った場合は、ワーカーが改訂の番号の違いで止める（`CREDENTIAL_CHANGED`）。
- **止めた状態との関係**: 資格情報の変更を、自動では人の確かめとみなさない（ロック・429・分からない場合は、サーバの側の状態が変わっていないかもしれないため）。変更の画面に「自動ログインの停止も解く」の明示の選択を置き、選んだときは、変更と解除の 2 つを記録する。最小の間隔と `Retry-After` は、解いても守る。
- **入力の守り**: Server Function の POST だけで受ける（Task 23・24 の Host、`localAddress`、cookie、CSRF、CSP をそのまま通す）。入力はサーバで JSON Schema と長さの上限（名前つきの定数）で確かめる。誤りの応答と記録に値を入れない（誤りのコードと項目の名前だけ）。応答に値を返さない。入力の欄は `autocomplete="off"`（パスワードは `new-password`）にする。ただし、人のブラウザがパスワードの保存を勧めることは止められない（手順書に書く）。
- **画面のサーバが平文を持つ時間**: 保存の要求の処理の間だけ。暗号化の後に参照を捨てる。

### 4.3 認証の設定の拡張（`beaksight-auth-setup/2`）

- Task 25 の `beaksight-auth-setup/1` に、`automatedLogin` を足した版 2 を作る。版 1 の文書は、`automatedLogin: null` として読む（保存し直すまで書き換えない）。新しく保存するときは版 2 で書く。
- `automatedLogin`（`AUTOMATED_LOGIN` のプロファイルでは必須、`MANUAL_SESSION` では null）:
  - `usernameSelector`、`passwordSelector`、`submitSelector`（CSS セレクタ。Task 25 の成功の条件のセレクタと同じ決まり）。
  - `failureConditions`: `invalidCredentials`、`accountLocked`、`mfaRequired`、`credentialExpired`。それぞれ null か `{ pathPrefix, selector }`（成功の条件と同じ形）。
- `AUTOMATED_LOGIN` のとき、`maxLoginAttempts` は 1 だけを受ける。
- 検証（`auth-setup-policy.ts`）に足す誤り: 自動ログインの項目がない・余分、セレクタの形、条件どうしの重なり（同じ path とセレクタの組の重複、成功の条件と同じ条件）、回数が 1 でない。`AUTH_SETUP_MODE_UNSUPPORTED` の判定を「`TEST_AUTH_PASSIVE` で、`MANUAL_SESSION` か `AUTOMATED_LOGIN`」に改める。
- 実行できる方式（`src/control/execution-policy.ts`）: `TEST_AUTH_PASSIVE` に `AUTOMATED_LOGIN` を足す。Windows 以外では足さない（判定の owner はこのファイル）。

### 4.4 自動ログインの段（`src/worker/`、`src/browser/`）

- ログイン用の Context は、Task 25 と同じく `context-factory.ts` のログインの段の入口で作る。**headless で起動する**（自動ログインのファイルは、headed の起動の値を参照しない。Gate で確かめる）。Guard はログインの段（`loginStage`）、回数の上限 1。
- 流れ:
  1. 開始の前の確かめ（ワーカー）: `START` の資格情報の改訂の番号とファイルの番号が同じこと、ファイルの `loginOrigin` が認証の設定のログインの Origin と同じこと。違えば `CREDENTIAL_CHANGED`。
  2. `loginStartUrl` を開く（GET）。
  3. **フォームを読むだけで確かめる**（入力の部品の中。値はまだ入れない）: 3 つのセレクタがそれぞれちょうど 1 つの要素に当たる。ユーザー名とパスワードの欄と送信のボタンが同じ `form` の中にある。`form` の method が POST。action を解決した URL の Origin と path が、`loginPostEndpoints` のどれかと完全に一致する。パスワードの欄が `type=password`。どれかが外れたら、値を入れずに `LOGIN_FORM_INVALID`（理由のコードつき）で止める。GET のフォームに値を入れると資格情報が URL の query で届くので、この確かめは必須（調査 E5）。
  4. 復号して、Playwright の `fill` でユーザー名とパスワードを入れ、`click` で送る。`page.evaluate` で値を書かない。入れた後に平文の参照を捨てる。`fill` や `click` の誤りの文には値が入ることがある（調査 E7）ので、誤りは固定のコード（`LOGIN_FORM_INPUT_FAILED`）に置き換え、誤りの文を IPC・ログ・画面に出さない。
  5. 結果を待つ（時間の上限は名前つきの定数。例 30 秒）。main frame の応答が 429 なら `RATE_LIMITED`（`Retry-After` を読む）。5xx なら `AUTH_RESULT_UNKNOWN`。それ以外は、成功の条件と `failureConditions` のうち、当たる条件がちょうど 1 つになったときに結果を決める。上限までに 1 つに決まらなければ `AUTH_RESULT_UNKNOWN`。
  6. 成功なら、Task 25 と同じく状態を読み、絞り（`filterAuthenticatedState`）、空なら `UNSUPPORTED_AUTH_STATE`。ログイン用の Context を閉じる。
- 判定の部品の共通化: Task 25 の `isSuccessPage` と `loginAttemptsExceeded` を共通の部品に出し、手動と自動の両方で使う（書き写さない）。
- **ログインの段の Ledger と console は、保存も表示も IPC もしない**（ページの JS が送ろうとした要求の URL にユーザー名が入りうる。調査 E2）。Task 25 の手動のログインの段でも同じ扱いであることを確かめ、違えば合わせる。
- **ワーカーの環境**: ワーカーを起動するときの環境から、Playwright のデバッグの出力を有効にする変数（`DEBUG`、`PWDEBUG` など。名前つきの閉じた一覧）を外す。`DEBUG=pw:api` で標準エラーに値が出るため（調査 E8）。公開監査の出力は変わらない。
- **入力の部品** `src/browser/login-form-submitter.ts`: `fill`、`click`、`type`、`press`、`keyboard`、`insertText` を使ってよいのは、このファイルだけ。呼べるのは自動ログインのファイルだけ。手動のログインの段（`authenticated-login.ts`）は import しない。Gate（Task 25 の (q)）の範囲を `src/worker/` から `src/` 全体に広げ、例外をこの 1 ファイルにする（Gate を強める）。

### 4.5 ジョブ（`src/control/job/`、`src/control/worker-protocol.ts`、管理データの版 4）

- **ジョブの種類**: `AUDIT`（今までの監査）と `LOGIN_CHECK`（ログインの検証）。どちらも、画面全体で同時に 1 つだけ（今の一意の索引とロックをそのまま使う）。
  - `LOGIN_CHECK` は、自動ログインの段だけを行い、結果を記録して終わる（Run を作らない。成果物を書かない）。成功しても監査を始めない。
  - `AUDIT` で `AUTOMATED_LOGIN` のプロファイルは、自動ログインの段の後に、Task 25 と同じ監査へ進む。セッションが切れて止まった Run を再開するときは、もう一度自動ログインを行う（上限に数える）。
- **開始の前の確かめ**（ジョブの管理。開始の直前）: Task 25 の確かめに加えて、
  - 資格情報のファイルがある（`CREDENTIAL_MISSING`）。保存した Origin が今の認証の設定と合う（`CREDENTIAL_STALE`）。暗号化が使える（`CREDENTIAL_PROTECTION_UNAVAILABLE`）。
  - 自動ログインが止められていない（`AUTO_LOGIN_HELD`）。
  - 最小の間隔、24 時間の上限、`Retry-After` の待ちの中でない（`AUTO_LOGIN_RATE_LIMITED`。次に始められる時刻を返す）。
  - 通ったら、ジョブを作るのと同じトランザクションで、試しの記録（「試し始めた」）を書く。
- **上限の値**（名前つきの定数。ユーザーの承認が要る）:
  - 1 回のジョブで、ログインの POST は 1 回だけ。
  - 自動ログインどうしの最小の間隔: 5 分（プロファイルごと）。
  - 24 時間の上限: 10 回（プロファイルごと。成功を含む。試し始めた記録で数える）。
  - `Retry-After` は守る。上限は 24 時間（それより長い値や読めない値は 24 時間とみなす）。
- **止める**: 成功以外で終わったら（ログインの POST を送った後の結果、またはワーカーが途中で落ちて結果が分からない場合）、そのプロファイルの自動ログインを止める。POST を送る前に終わった場合（`LOGIN_FORM_INVALID`、`CREDENTIAL_*` など）は止めない（ロックの心配がないため）。解くのは、画面の明示の操作だけ。
- **IPC**: `START` に `authentication.automatedLogin: { credentialRevision }`（秘密でない）と、資格情報のファイルの場所（親が決める。管理データの場所と同じ扱い）を足す。結果は `AUTH_STATE` に、閉じた一覧の値（下）で返す。値・誤りの文・URL の query を入れない。
- **結果の閉じた一覧**（`AUTH_STATE` とジョブの失敗の理由）: `SUCCEEDED`、`INVALID_CREDENTIALS`、`ACCOUNT_LOCKED`、`MFA_REQUIRED`、`CREDENTIAL_EXPIRED`、`RATE_LIMITED`、`AUTH_RESULT_UNKNOWN`、`LOGIN_FORM_INVALID`、`LOGIN_FORM_INPUT_FAILED`、`CREDENTIAL_CHANGED`、`CREDENTIAL_UNAVAILABLE`（復号できない）、Task 25 の `UNSUPPORTED_AUTH_STATE`、`STOPPED`。表示の文言はカタログと `messages.ts` に置く。
- **管理データの版 4**（版 3 は公開済みとして中身を変えない）:
  - ジョブの表を作り直し、`job_kind` の列と、新しい失敗の理由の CHECK を入れる（版 3 の CHECK は、公開した時点の一覧の写しで固定する。版 3 と同じやり方）。
  - `auto_login_attempts`（プロファイルの ID、ジョブの ID、試し始めた時刻、結果、資格情報の改訂の番号、`Retry-After` の期限）。
  - `auto_login_holds`（プロファイルの ID、理由、止めた時刻、解いた時刻）。
  - `credential_events`（プロファイルの ID、時刻、種類 `CREATED`・`USERNAME_CHANGED`・`PASSWORD_CHANGED`・`BOTH_CHANGED`・`DELETED`・`HOLD_CLEARED`、改訂の番号）。
  - どの表も、値も値のハッシュも持たない。資格情報の有無と改訂の番号の正は、ファイルとする（管理データには写さない）。

### 4.6 画面（ログインの検証と監査）

- プロファイルの一覧と詳細に「ログインを確かめる」（`LOGIN_CHECK` を始める）を足す。開始の画面と同じく、始められない理由（上の確かめ）を日本語で出し、開始のボタンを出さない。止めているときは、理由と「確かめたので自動ログインを再び許す」の操作を出す。最小の間隔や `Retry-After` の待ちのときは、次に始められる時刻を出す。
- ジョブの画面に、ジョブの種類と自動ログインの結果を出す。結果ごとに、人がすること（資格情報の変更、アカウントのロックの解除をテスト環境の管理者に頼む、MFA のあるアカウントは使えない、など）を出す。
- 監査の開始の画面（`AUTOMATED_LOGIN`）: 「BeakSight が保存した資格情報で自動でログインします。ブラウザは開きません」の案内と、上限の状態を出す。

### 4.7 秘密を出さないこと（I11）

- Task 25 の目印の検査（T25f）を広げ、ユーザー名とパスワードの目印が、次のどこにも出ないことをバイトで確かめる: Run のディレクトリのすべてのファイル（ZIP の中身を含む）、管理データのファイルと WAL、資格情報のファイル（暗号文の中に平文の目印がないこと）、画面のサーバとワーカーの標準出力と標準エラー、IPC の記録、画面の HTML と Server Function の応答（保存・変更・削除の応答と誤りの応答を含む）、ジョブの行と新しい表、PowerShell の子プロセスの起動の引数。
- 確かめられない場所（手順書に書く）: Windows のイベントログ（PowerShell が、ProtectedData を使うスクリプトの本文を自動で記録する。平文は入らないことを調査で確かめた）、人のブラウザのパスワードの保存、管理者や SYSTEM の権限での読み出し、同じ Windows の利用者で動くほかのプログラム。

## 5. SSOT と安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| 資格情報の暗号化 | `src/control/credentials/dpapi-protector.ts` | 新設 |
| 資格情報のファイル（場所、形、権限、置き換え） | `src/control/credentials/credential-store.ts` | 新設 |
| フォームへの入力 | `src/browser/login-form-submitter.ts` | 新設（`fill`・`click` の唯一の owner） |
| 実行できるモードと認証の方式 | `src/control/execution-policy.ts` | 拡張（`AUTOMATED_LOGIN`。Windows だけ） |
| 認証の設定の契約と検証 | `src/control/auth/` | 拡張（版 2） |
| ログインの段の要求の判定 | `src/safety/request-policy.ts`、Guard | 利用のみ（変更なし） |
| 状態の絞り込みと受け継ぎ | `src/control/auth/authenticated-state.ts`、`context-factory.ts` | 利用のみ |
| ログインの成功の判定 | Task 25 の `authenticated-login.ts` | 共通の部品に出す（手動と自動で使う） |
| 自動ログインの上限と止める | `src/control/job/` と管理データの版 4 | 新設 |
| 表示の文言 | `src/presentation/catalog.ts`・`messages.ts` | 拡張 |

- 公開監査の判定、出力、golden、CLI と画面の比べは変えない。
- `src/**` に対象のサイトの名前・ドメイン・セレクタを書かない（セレクタは認証の設定の中だけ）。

## 6. テスト設計（fixture。127.0.0.1 だけ）

- fixture のサーバ: フォームのログイン（成功、資格情報の誤り、ロックの画面、MFA の画面、パスワードの期限切れの画面、429 と `Retry-After`、500、どの条件にも当たらない画面、2 つの条件に当たる画面）、GET のフォーム、別の Origin を送信先にするフォーム、送信の時にページの JS が beacon と fetch で送るページ、ログインの後の管理画面（Task 25 の fixture を使う）。
- 単体: 暗号化の部品（偽の子プロセスで、引数と stdin の形、stderr を読まないこと、時間の上限）、ファイルの部品（形、entropy、置き換えの失敗、権限の確かめの失敗、一時のファイルの片付け）、認証の設定の版 2 の検証、上限の判定（間隔、24 時間、`Retry-After`、止める・解く）、結果の分類。
- 結合（Windows だけ。Windows でなければ理由を出して飛ばす）: 本物の DPAPI と icacls で、往復、entropy の違いで戻せない、権限が今の利用者だけ、置き換えの途中の失敗で古い値が残る。
- 結合（2 つの Chromium）: 自動ログインの各結果、サーバに届く GET と HEAD 以外の要求が POST 1 回だけ、フォームの確かめで止まる場合はサーバへの POST 0、ページの JS の送信が届かない、ログインの後の監査が Task 25 と同じく読み取りだけで COMPLETE、セッションが切れた後の再開で自動ログインし直す。
- 画面: 資格情報の登録・変更（ユーザー名だけ・パスワードだけ・両方）・削除、値が HTML と応答に出ない、CSRF、ジョブが動いている間の変更の拒否、止めた状態の表示と解除、上限の表示。
- 目印の検査（4.7）。
- Gate: 4.1 と 4.4 の Gate が、現実的な書き方の違反を捕まえる。各 1 秒以内。
- 公開監査の不変: golden、`cli-output-parity`、`cli-ui-parity`、Safety Gate。

## 7. 対象外

- Windows 以外での自動ログイン。
- 別の Origin の IdP、MFA の突破、CAPTCHA、JavaScript の fetch で送るログイン、IndexedDB に頼る認証。
- 無人の定期実行（予定の機能はない。人が画面から始める）。
- 環境変数・資格情報マネージャー・平文のファイルによる資格情報の受け渡し。
- 監査の途中での自動の再ログイン（セッションが切れたら Task 25 と同じく止め、再開で自動ログインし直す）。
- CLI からの自動ログイン。
- 実テスト環境での確かめ（ADR-013。ロードマップの終わりの方）。

## 8. 完了条件（G26）

- [ ] fixture で、自動ログインの各結果の区別、ログインの POST 1 回のほかに読み取りでない要求の到達 0、フォームの確かめで止まる場合の POST 0、ログインの後の監査が読み取りだけで PASS（2 つの Chromium）。
- [ ] 上限（1 回、間隔、24 時間、`Retry-After`、止める・解く）と、資格情報の登録・変更・削除の流れが PASS。
- [ ] 目印の検査で、資格情報の出力 0。
- [ ] 公開監査が変わらない（golden、CLI と画面の比べ、Safety Gate）。
- [ ] `npm run verify:all` が通しで PASS。独立レビューで Critical 0、Important 0。

## 9. 実装計画の分け方（概要。承認の後に実装計画を書く）

T26a 暗号化とファイルの部品（DPAPI、icacls、置き換え、Gate）→ T26b 認証の設定の版 2 と実行できる方式 → T26c 管理データの版 4（ジョブの種類、上限、止める、記録）と開始の確かめ → T26d 入力の部品と自動ログインの段（ワーカー、IPC、環境の変数）→ T26e 画面（資格情報、ログインの検証、止めた状態）→ T26f 目印の検査と手順書 → T26R 独立レビュー。

## 10. ユーザーの承認が要る点

1. PowerShell（DPAPI）と icacls を、本番で子プロセスとして使うこと。Windows だけの機能にすること。
2. PowerShell が、ProtectedData を使うスクリプトの本文を Windows のイベントログに自動で記録すること（平文と暗号文は記録されない）。
3. 資格情報の変更を、自動では「人の確かめ」とみなさないこと（明示の選択で解く）。
4. 上限の値: 1 回のジョブで POST 1 回、最小の間隔 5 分、24 時間で 10 回、`Retry-After` の上限 24 時間、結果を待つ時間 30 秒。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-10 | 初版（T26 調査、T26 追加調査、ユーザーの判断） | 資格情報は画面で一度だけ入力し DPAPI で暗号化して `local/secrets/` に保存、復号はワーカーだけ、入力の部品を 1 つに、結果は閉じた一覧の条件のちょうど 1 つ、ロックを誘発しない上限、変更と削除、ログインの検証と自動ログインの後の監査 | Task 26 |
| 2026-10-10 | Blocker: T26b（ワーカーの IPC のスキーマが認証の設定の版 1 を直接参照する、画面が版 1 の文書を作る、誤りのコードの文言の書き漏れを画面の型とテストで確かめている） | (1) 認証の設定の版 2 への切り替えは、1 つのサブタスク（T26b）の中で、保存・読み込み・検証・IPC のスキーマ（`worker-message.schema.json` の `START` の `setup` は版 2 だけ。親と子は同じビルドなので版 1 との互換は要らない）・画面の文書の組み立て（`automatedLogin: null` の版 2。自動ログインの項目の入力の欄は T26e）・画面の入力のスキーマを、まとめて版 2 に切り替える。`validateAuthSetup` が受けるのは版 2 だけ。版 1 は管理データから読むときだけ版 2 に直す。(2) 足した誤りのコードの表示の文言は、書き漏れの検査を常に通すため、コードを足すサブタスク（T26b）で足す（T26e で見直す）。`AUTH_SETUP_MODE_UNSUPPORTED` の説明も、改めた判定に合わせて T26b で直す | T26b、T26e |
| 2026-10-10 | Blocker: T26c（試し始めた記録をジョブを作るのと同じトランザクションで書く公開の関数は Gate (g) に反する、版 4 で既存の版と表の一覧を固定したテストが失敗する、`job_kind` の既定の値） | (1) 試し始めた記録は、ジョブの行を作る部品（`job-store.ts` の `createStartingJob`）が同じ `withWriteTransaction` の中で書く（Gate は弱めない）。ジョブの種類は既定の値を持たせず、作る側が必ず明示する（型で必須。SQL の列にも DEFAULT を付けない。黙って `AUDIT` にならないため）。(2) 公開済みの版 1〜3 の CHECK が参照する値の一覧は、すべて公開した時点の写しで固定する（後から足す値で、公開済みの版の中身を変えないため）。(3) 自動ログインの結果の閉じた一覧は `src/control/auth/automated-login-results.ts` に置く（ワーカーから読めるファイルの単位の許可に足せるため。足すのは T26d）。(4) ログインの Origin は、`loginStartUrl` の Origin を既存の Origin の正規化で求める | T26c、T26d |
| 2026-10-10 | T26d-1 の報告 | (1) T26d を T26d-1（入力の部品と自動ログインの段）と T26d-2（IPC、ワーカーの流れ、ジョブの管理、環境の変数、実行できる方式）に分けた。(2) 実装者の追加を受け入れる: ログインの画面そのものが 429 なら `RATE_LIMITED`（送信 `NO`）・5xx なら `AUTH_RESULT_UNKNOWN`（`NO`）、値を入れた後にフォームを読み直して確かめる、値を入れる前にページが自分で送信先へ POST したら `AUTH_RESULT_UNKNOWN`（`YES`）、フォームの確かめに送信のボタン・`target` が自分の frame であること・読めないことの理由を足す、Gate (q) の `type` は引数のある呼び出しだけを数える（console の種類を読む `message.type()` を除くため）。(3) `LOGIN_FORM_INVALID` の理由のコード（閉じた一覧。秘密でない）は、IPC の結果に載せ、`auto_login_attempts` に省略できる列で記録し、画面に出す（版 4 は未公開なので変えてよい。T26d-2）。(4) 残る危険として手順書に書く: ページの JS が送信の事象の中でフォームを GET に変える場合や、同じ Origin への GET に値を載せる場合は、Guard（GET を許す）も事前の確かめも止められない（値は対象のテスト環境のサーバに届く。第三者には届かない） | T26d-1、T26d-2、T26f |
| 2026-10-11 | Blocker: T26d-2（`execution-policy.ts` は画面の表示の部品を通してブラウザのバンドルにも入り、`process.platform` を使うとブラウザで `process is not defined` になる。離席中の承認の下で設計者が判断） | (1) 今実行できる方式の判定（`execution-policy.ts`）は、プラットフォームを問わない純粋な判定のままにし、`TEST_AUTH_PASSIVE` に `AUTOMATED_LOGIN` を足す。Windows だけであることは、サーバの側の開始の確かめ（暗号化が使えるか。Windows でなければ `checkProtection` が使えないを返し `CREDENTIAL_PROTECTION_UNAVAILABLE`）で強制する。4.3 の「Windows 以外では足さない」と 4.2 の「Windows のときだけ画面を出す」を、「Windows 以外では、開始と資格情報の保存をサーバが拒み、画面はサーバが判定した『この環境では使えない』を出す」に改める（画面の判定はサーバから渡す。T26e）。(2) ワーカーの環境から外す変数に `NODE_OPTIONS` を足す（`--inspect` や `--require` でワーカーに検査の窓や別のコードを入れうるため。`execArgv` は既に空）。(3) ワーカーを起動できなかったときの試しは、送信 `NO`（止めない）で閉じる（ワーカーが動いていないので POST は送られていない）。(4) 実装者の判断を受け入れる: ログインは成功したが状態がない場合は試しを `SUCCEEDED` とし、ジョブは `UNSUPPORTED_AUTH_STATE`、止める要求の場合は `AUTH_RESULT_UNKNOWN` と観測した送信、`LOGIN_CHECK` を自動ログインでないプロファイルで始めると `AUTH_STRATEGY_NOT_EXECUTABLE` | T26d-2、T26e |
| 2026-10-11 | T26R（独立レビュー。Critical 1、Important 1、Minor 3。離席中の承認の下で設計者が判断） | C1（ログインの段で、ページの JS が入力の値を、別の Origin へのサブリソースの GET（画像、iframe、fetch、stylesheet）や、送信の事象の中で GET に変えたフォームで送れる。成功のときも検知しない）への直し: (1) **ログインの段（手動と自動の両方）では、ターゲット設定の `site.allowedOrigins` の外への要求を、種類を問わずすべて止めて記録する**（サブリソース、サブ frame のナビゲーション、main frame のナビゲーション。公開監査と監査の段の判定は変えない。Task 25 の手動のログインの段の振る舞いも、この点で厳しくなる）。(2) **自動ログインでは、値を入れ始めてから、許した送信先への main frame のナビゲーションの POST を観測するまで（観測しなければ結果を待つ時間の上限まで）を「送信の窓」とし、窓の中では、その POST のほかのすべての要求（同じ Origin の GET を含む）を止めて記録する。** 窓の中で要求を止めた場合は、新しい結果 `UNEXPECTED_LOGIN_REQUEST`（ページが、入力の値を送りうる別の要求を出そうとした）で終え、送信が `NO` でなければ止める。(3) 「残る危険」と書いた、同じ Origin への GET や送信の事象の中で GET に変える形は、(2) で止める（手順書の「第三者には届かない」の文を直す）。I1: プロファイルを取り消したら、資格情報のファイルを消して `DELETED` を記録する。M1: 資格情報を読む前と書く前に、`local` と `local/secrets` が reparse point（junction、symlink）でないこと、ファイルが普通のファイルでリンクの数が 1 であることを確かめ、外れたら `CREDENTIAL_STORAGE_UNSAFE`。M2: Gate (q) に `click` を足し、例外は入力の部品と、既存の Interaction の部品（`src/interaction/isolated-auditor.ts`）だけ。M3: 資格情報の Gate の走査に `apps/local-ui/src` を足す | T26g-1、T26g-2 |
| 2026-10-11 | Blocker: T26g-1（止めた要求を Safety Ledger に記録するには、`src/core/evidence-types.ts` と `schemas/page.schema.json` の理由の閉じた一覧に値を足す必要があり、公開監査の成果物のスキーマが変わる） | 案 B を採る: ログインの段で、許可 Origin の外の要求と送信の窓の中の要求を止めたことの記録は、Safety Ledger ではなく、Guard のログインの段の指定（`GuardLoginStage`）の中に持つ（種類と数。値や URL の query は持たない）。ログインの段の Ledger と記録は、もともと外へ出さず保存もしない。公開監査のスキーマと出力は変えない。窓を閉じる時点は、Guard の CDP の層が許した POST を通した時点（Guard の中）。ブラウザ自身の `GET <許可 Origin>/favicon.ico`（query と fragment なし。値を運べない）は、窓の中でも止めるが `UNEXPECTED_LOGIN_REQUEST` の理由に数えない | T26g-1 |
| 2026-10-11 | T26g-1 の報告 | 実装者の追加を受け入れる: 値を入れた後、押す前に `SUBMISSION_WINDOW_SETTLE_MS`（300 ms）待ち、窓の中で要求を止めていたら押さない（`UNEXPECTED_LOGIN_REQUEST`・送信 `NO`）。止めた要求の記録は `LoginStageMonitor`（種類ごとの数だけ）。窓の外に残る危険（POST の後に、ページが値を Cookie・localStorage・変数に残して許可 Origin への GET に載せる形、手動の段の許可 Origin への GET）は手順書に書く（許可 Origin の外へはどちらも届かない） | T26g-1 |
