# 監査プロファイル

サイトと環境ごとに、監査の方式（監査モード）を選ぶための「監査プロファイル」の形と決まりです。

[README に戻る](../../README.md)・[仕様の索引](README.md)

> 監査プロファイルは、管理画面（「[管理画面（ローカル）](local-ui.md)」）の「新しいプロファイル」で登録し、管理データ（SQLite）に保存します。管理画面からの監査、ログインの確かめ、操作の候補の発見、READ の確かめ、書き込みは、すべてプロファイルから始めます。
>
> CLI（`run`、`validate-config`）は、プロファイルを読みません。監査の対象の設定のファイル（ターゲット JSON。「[監査の対象の設定](configuration.md)」）だけで、公開の監査（`PUBLIC_PASSIVE`）を行います。

## 監査プロファイルとは

監査プロファイルは、1 つのサイトの 1 つの環境（本番の公開の環境か、テスト環境か）について、どの監査モードで監査するかを決める JSON の文書です。
管理画面で登録すると、管理データに保存します。ターゲット JSON とは別の文書で、ターゲット JSON を相対パスで参照します。

- ターゲット JSON には、監査モードを書けません（下の「[旧ターゲット JSON の扱い](#旧ターゲット-json-の扱い)」）。
- 本番とテスト環境は、別のプロファイルにします。
- URL の文字列や名前（`test`、`staging` など）だけで、BeakSight がテスト環境と見なすことはありません。テスト環境かどうかは、プロファイルの `environment` と、環境の確認の参照（`environmentEvidenceRef`）で決めます。

## 管理画面でのプロファイルの作り方

左のメニューの「新しいプロファイル」で作ります。画面の先頭の「対象のサイトの設定」で、次のどちらかを選びます。

| 選び方 | 内容 |
| --- | --- |
| 開始の URL から新しく作る（既定） | 「開始の URL」を入れると、画面がその場で案を埋めます。保存すると、対象の設定のファイルを作ってから、プロファイルを保存します。 |
| すでにある設定のファイルを使う | 「設定のファイル」で、`config/targets/` か `local/targets/` の中の JSON を選びます（前の使い方。CLI で使っている設定のファイルも選べます）。選ぶと、その場で設定の誤りを確かめます。 |

### 開始の URL からの案

- 「開始の URL」を入れると、次の欄に案を埋めます。案は保存するまで案のままで、変えたい欄だけを直します。
  - 「名前（profileId）」: ホスト名を、名前の決まり（小文字の英数字とハイフン）に合う形に直したもの。合う形にできなければ空です。
  - 「許可 Origin（1 行に 1 つ）」: 開始の URL の Origin。ほかの Origin を足すときは、1 行に 1 つ書きます。
  - 「テスト環境の Origin（1 行に 1 つ）」: テスト環境のモードのとき、許可 Origin を写します。
- 利用者が直した欄は、その後に開始の URL を変えても、案に追従しません。欄を空に戻すと、また追従します。
- 開始の URL は、設定のファイルと同じ決まり（`http:` か `https:`、利用者名とパスワードを含まない）で確かめます。fragment（`#` の後）も持てません。

### 作るファイル

- 保存すると、`local/targets/<名前>.json` を作ります（画面の「保存すると作る設定のファイル」に出ます）。中身は、`target.id`（名前）、`site.startUrl`、`site.allowedOrigins`、負荷（`crawl`）と出力（`output`）です。負荷は、最初の監査のための控えめな値で作ります。ページの上限（`crawl.maxPages`）は 3、ページの読み込みの間隔（`crawl.minNavigationIntervalMs`）は 10 秒（`10000`）です（`GENERATED_TARGET_CRAWL_LIMITS`）。ほかの負荷の項目と出力は既定値です（「[既定値](configuration.md#既定値)」）。CLI の既定値（ページの上限 500、間隔 5 秒）は変わりません。
- **読む範囲を広げるときは、作ったファイルを直します。** `crawl.maxPages` と `crawl.minNavigationIntervalMs` などを、サイトの運営者と決めた値にします（「[サイトへの負荷](site-load.md)」）。ページの上限・時間の上限・読み込みの間隔の 3 つは、プロファイルの詳細の「監査の負荷」でも変えられます（「[管理画面](local-ui.md#サイトへの負荷の決まり)」）。ほかの項目は、画面からは変えられません。ファイルを直したら `node dist/cli/index.js validate-config --config local/targets/<名前>.json` で確かめます。
- 同じ名前のファイルがあれば、上書きせずに止めます（`TARGET_CONFIG_EXISTS`。プロファイルも作りません）。
- 名前が Windows の予約名（`con`、`nul`、`aux`、`prn`、`com1`〜`com9`、`lpt1`〜`lpt9` など。大文字と小文字を問いません）のときは、作りません（`TARGET_CONFIG_NAME_RESERVED`。プロファイルも作りません）。名前を入れた時点で、「保存すると作る設定のファイル」に理由が出ます。保存を押しても、欄の誤りとして止まります。
- 置き場所のフォルダ（`local` か `local/targets`）が、ほかの場所へのリンク（junction・シンボリックリンク）か、フォルダでないときは、何も書かずに止まります（`TARGET_CONFIG_LOCATION_UNSAFE`。プロファイルも作りません）。フォルダがなければ作り、作った後にもう一度確かめます。
- 書く前に、プロファイルの決まりと設定の決まりで確かめます（合わなければ `TARGET_SITE_INVALID` か `TARGET_CONFIG_INVALID`。ファイルは作りません）。書いた後に読み直してから、プロファイルを保存します。プロファイルの保存に失敗したときは、作ったファイルの中身が同じときだけ消します（途中にリンクがあれば消しません）。
- ファイルは、一時のファイルに書いてから、ハードリンクで置きます（同じ名前のファイルを上書きしないため）。ハードリンクを張れない置き場所（`local/targets/` のフォルダ）では、書けずに止まります（`TARGET_CONFIG_WRITE_FAILED`。プロファイルも作りません）。

### 欄の出し分けと初めの値

- 「監査モード」を選ぶと、「環境」と「認証の方式」の初めの値を、受ける組み合わせ（下の「[受ける組み合わせ](#受ける組み合わせ)」）に合わせます。
- 「テスト環境の Origin」の欄は、テスト環境のモード（`TEST_AUTH_PASSIVE`・`TEST_APPROVED_WRITE`）のときだけ出します。
- 「テスト環境であることを確かめた記録の参照」の欄は、環境がテスト環境（`TEST`）のときだけ出します（公開の監査のモードで環境をテスト環境にしたときも出ます）。
- 隠した欄の値は送りません。隠した欄に関わる保存の誤りは、フォームの上に出します。

### 保存の後

- 保存すると、「次の手順」のリンク（認証の設定を開く、資格情報を登録する、ログインを確かめる、監査を始める）と、「プロファイルの「次にすること」を見る」が出ます。
- プロファイルの詳細の欄「次にすること」に、「認証の設定」「資格情報」「ログインの確かめ」「監査の開始」の 4 つの手順を、「済み」「要る」「古い（直す）」「要らない」で並べます。「要る」と「古い（直す）」の手順には、その画面を開くリンク（「…を開く」「…を直す」）が付きます。上から順に済ませます。
- プロファイルの詳細の欄「監査を始める」から、監査を始められます。始められないとき（書き込みのモード、取り消したプロファイル、今は実行できない認証の方式など）は、ボタンを消さずに理由を出します。
- 「サイトとプロファイル」の一覧でも、監査を始められない行には、短い理由を出します。
- ログインの確かめが成功した後にも、「次の手順」のリンクが出ます。

## プロファイルの形

```json
{
  "schemaVersion": "beaksight-profile/1",
  "profileId": "example-test",
  "revision": 1,
  "targetConfigPath": "local/targets/example-test.json",
  "environment": "TEST",
  "mode": "TEST_AUTH_PASSIVE",
  "auth": "MANUAL_SESSION",
  "approvedTestOrigins": ["http://127.0.0.1:8080"],
  "environmentEvidenceRef": "isolation-check-2026-10-09"
}
```

`approvedServiceOrigins` のほかは、すべての項目が必須です。知らない項目があると、拒否されます。

| 項目 | 意味 |
| --- | --- |
| `schemaVersion` | プロファイルの形の版。`"beaksight-profile/1"` だけを受けます。 |
| `profileId` | プロファイルの ID。 |
| `revision` | プロファイルの改訂の番号。 |
| `targetConfigPath` | 参照するターゲット JSON への相対パス。 |
| `environment` | 環境の種類（`PUBLIC` か `TEST`）。 |
| `mode` | 監査モード（`PUBLIC_PASSIVE`、`TEST_AUTH_PASSIVE`、`TEST_APPROVED_WRITE`）。 |
| `auth` | 認証の方式（`NONE`、`MANUAL_SESSION`、`AUTOMATED_LOGIN`）。 |
| `approvedTestOrigins` | テスト環境の認証・書き込みのモードで、認証と書き込みを許す Origin の一覧。 |
| `environmentEvidenceRef` | テスト環境が本番から隔離されていることを確かめた記録への、秘密を含まない参照（記録の ID など）。隔離が未確認のときは、未確認であることが分かる参照。ないときは `null`。 |
| `approvedServiceOrigins` | 任意。スクリプトで送るログインの、認証のサービスと API の Origin の一覧（画面の名前「承認したサービスの Origin（1 行に 1 つ）」）。ないときは空と同じです。下の「[`approvedServiceOrigins`](#approvedserviceorigins)」。 |

## 監査モード、環境、認証の方式

監査モード:

| 値 | 意味 |
| --- | --- |
| `PUBLIC_PASSIVE` | 公開の監査。ログインせず、`GET` と `HEAD` だけで観測します（今の BeakSight の監査。「[読み取り専用と安全](safety.md)」）。 |
| `TEST_AUTH_PASSIVE` | テスト環境で、ログインした後の画面を、読み取りだけで監査します（「[認証つきの監査の手順](authenticated-audit.md)」）。 |
| `TEST_APPROVED_WRITE` | テスト環境で、承認した書き込みの操作だけを行います。書き込みの前の準備（認証の設定、操作の候補の発見、READ の確かめ）、書き込みのシナリオ（作成・変更・承認・撤回）、入力の規則、承認された登録（CREATE）と更新（UPDATE）を使えます。このモードの読み取りの監査（`AUDIT`）は使えません（下の「[モードごとに使える操作](#モードごとに使える操作)」）。 |

環境:

| 値 | 意味 |
| --- | --- |
| `PUBLIC` | 本番の公開の環境。 |
| `TEST` | テスト環境。 |

認証の方式:

| 値 | 意味 |
| --- | --- |
| `NONE` | ログインしません。 |
| `MANUAL_SESSION` | 利用者が、BeakSight が開いたブラウザで手でログインした状態を使います（「[認証つきの監査の手順](authenticated-audit.md)」）。 |
| `AUTOMATED_LOGIN` | BeakSight が、画面で保存したテスト用のアカウントの資格情報で、ログインの操作を行います（Windows だけ。「[自動ログインの手順](automated-login.md)」）。 |

## モードごとに使える操作

管理画面とジョブの管理は、どのモードのプロファイルで何を使えるかを、1 つの表（`src/control/execution-policy.ts` の `PROFILE_OPERATION_POLICY`）だけで決めます。表にない組み合わせは、始めずに理由を返します（モードが理由なら `MODE_NOT_EXECUTABLE`、認証の方式が理由なら `AUTH_STRATEGY_NOT_EXECUTABLE`）。

| 操作 | `PUBLIC_PASSIVE` | `TEST_AUTH_PASSIVE` | `TEST_APPROVED_WRITE` |
| --- | --- | --- | --- |
| 監査（`AUDIT`） | 使える（`NONE`） | 使える（手動のログインと自動ログイン） | 使えない（`MODE_NOT_EXECUTABLE`） |
| 認証の設定の保存 | 使えない | 使える（手動のログインと自動ログイン） | 使える（手動のログインと自動ログイン） |
| 資格情報の保存と変更 | 使えない | 自動ログインだけ | 自動ログインだけ |
| ログインの確かめ（`LOGIN_CHECK`） | 使えない（`AUTH_STRATEGY_NOT_EXECUTABLE`） | 自動ログインだけ | 自動ログインだけ |
| 操作の候補の発見（`DISCOVERY`） | 使えない（`MODE_NOT_EXECUTABLE`） | 使える | 使える |
| READ の確かめ（`READ_CHECK`。定義の保存を含む） | 使えない（`MODE_NOT_EXECUTABLE`） | 使える | 使える |
| 書き込みのシナリオ（`SCENARIO`。作成・変更・承認。書き込みの実行ではない） | 使えない（シナリオの画面とサーバの理由は `SCENARIO_MODE_NOT_WRITE`） | 使えない（同じ） | 使える（手動のログインと自動ログイン。「[書き込みのシナリオの承認の手順](scenario-approval.md)」） |
| 承認された登録（`WRITE_CREATE`） | 使えない（`MODE_NOT_EXECUTABLE`） | 使えない（`MODE_NOT_EXECUTABLE`） | 使える（手動のログインと自動ログイン。「[承認された登録の手順](approved-create.md)」） |
| 承認された更新（`WRITE_UPDATE`） | 使えない（`MODE_NOT_EXECUTABLE`） | 使えない（`MODE_NOT_EXECUTABLE`） | 使える（手動のログインと自動ログイン。「[承認された更新の手順](approved-update.md)」） |

- `TEST_APPROVED_WRITE` で使える操作の条件（認証の設定が今のプロファイルの改訂のものであること、自動ログインなら資格情報と上限、Windows だけであること）は、`TEST_AUTH_PASSIVE` と同じです。
- `TEST_APPROVED_WRITE` でサイトへ書き込みの要求を送るのは、承認された登録と更新のジョブだけです。ほかの操作（ログインの確かめ、操作の候補の発見、READ の確かめ、シナリオ、入力の規則）が送るのは、ログインの送信と、`GET`・`HEAD` だけです（「[操作の候補の発見と READ の確かめの手順](discovery-and-read-check.md)」）。
- `TEST_APPROVED_WRITE` の監査（`AUDIT`）は実行できません。管理画面の一覧にも「監査を始める」を出しません。ログインした後の画面を読み取りだけで監査するときは、`TEST_AUTH_PASSIVE` のプロファイルを別に作ります。

## 受ける組み合わせ

環境、監査モード、認証の方式の組み合わせは、次の表の行だけを受けます。表にない組み合わせは、すべて拒否します。

| `environment` | `mode` | `auth` | `approvedTestOrigins` | `environmentEvidenceRef` |
| --- | --- | --- | --- | --- |
| `PUBLIC` | `PUBLIC_PASSIVE` | `NONE` | 空 | `null` |
| `TEST` | `PUBLIC_PASSIVE` | `NONE` | 空 | `null` か、空でない文字列（任意） |
| `TEST` | `TEST_AUTH_PASSIVE` | `MANUAL_SESSION` か `AUTOMATED_LOGIN` | 1 件以上 | 空でない文字列（必須） |
| `TEST` | `TEST_APPROVED_WRITE` | `MANUAL_SESSION` か `AUTOMATED_LOGIN` | 1 件以上 | 空でない文字列（必須） |

認証の方式の欄に 2 つの値を持つ行があるので、受ける組み合わせは 6 通りです。

- `PUBLIC_PASSIVE` は、どの環境でも認証なし（`NONE`）です。
- `PUBLIC` の環境では、`TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE` を選べません。

### テスト環境の `PUBLIC_PASSIVE`

テスト環境を `PUBLIC_PASSIVE` で監査するのは、**ログインの前の画面だけ**を監査する使い方です。
ログインはしません。ログインの後ろの画面の監査は、`TEST_AUTH_PASSIVE` の役割です。

## 各値の規則

値の規則に 1 つでも合わなければ、プロファイルを拒否します。

### `profileId`

- 小文字の英数字とハイフンだけで、先頭は英数字、全体で 1〜63 文字です（`^[a-z0-9][a-z0-9-]{0,62}$`）。
- 顧客名など、対象を特定できる名前を避けるのは、運用の決まりです。BeakSight は形だけを判定します。

### `revision`

- 1 以上の整数です（JavaScript で正確に扱える整数の範囲。`9007199254740991` まで）。
  - 整数でない値、1 より小さい値は、形の誤り（`PROFILE_SCHEMA_INVALID`）です。
  - 正確に扱える範囲を超える整数（`9007199254740992` 以上）も `PROFILE_SCHEMA_INVALID` ですが、形の確かめ（スキーマ）は通るので、ほかの規則の誤りのコードと一緒に返ります（下の「[拒否のコード](#拒否のコード)」）。
- 同じ `profileId` のプロファイルを改訂するときは、前の改訂より大きい値だけを受けます。同じ値と小さい値は拒否します（`PROFILE_REVISION_NOT_ADVANCED`）。
- `profileId` の違うプロファイルは、改訂として受けません（`PROFILE_REVISION_NOT_ADVANCED`）。
- 改訂の確かめでは、前と次の改訂の番号が、どちらも 1 以上の正確に扱える整数のときだけ比べます。そうでない値（`NaN`、無限大、小数、文字列、`null`、負の数など）は、比べずに `PROFILE_REVISION_NOT_ADVANCED` にします（形の誤りなら `PROFILE_SCHEMA_INVALID` も返します）。
- 改訂の確かめは、次の改訂として、上の検証（「[各値の規則](#各値の規則)」のすべて）で受けたプロファイルだけを受けます。検証を通していない値、検証で受けた値を写した値は、`PROFILE_SCHEMA_INVALID` で拒否します（組み合わせの規則を確かめていないプロファイルを、改訂として受けないためです）。前の改訂（保存してあった値）は、形だけを確かめます。
- 改訂の確かめは、例外を投げずに、当たった誤りのコードをすべて返します（写せない値も、拒否の結果になります）。

### `targetConfigPath`

- 区切りが `/` の相対パスです。
- 使える文字は、ASCII の英字（`A`〜`Z`、`a`〜`z`）、数字（`0`〜`9`）、`.`、`_`、`/`、`-` だけです。`%`、空白、全角の文字、英字以外の文字（`é` など）、制御文字、文字の向きを変える文字、ゼロ幅の文字を含むパスは拒否します。
- `config/targets/` か `local/targets/` の下の、名前のある `.json` のファイルだけを受けます（例: `config/targets/example.json`、`local/targets/example-test.json`）。
- 絶対パス、ドライブ名（`C:` など）、`\`、`..`（親のディレクトリ。名前の中にあっても）、`:` を含むパスは拒否します。
- パスの先のターゲット JSON は、プロファイルを使う側が読みます。BeakSight の判定は、パスの形だけを見ます。

### `approvedTestOrigins`

- `TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE` では、1 件以上が必要です。`PUBLIC_PASSIVE` では、空にします。
- 各値は、Origin の正規の書き方（`new URL(値).origin` と同じ文字列）にします。末尾の `/`、パス、大文字、既定のポート（`:443` など）を含む書き方は拒否します。
  - 受ける例: `https://example.com`、`http://127.0.0.1:8080`
  - 拒否する例: `https://example.com/`、`https://example.com/login`、`HTTPS://EXAMPLE.COM`、`https://example.com:443`
- scheme は `https:` です。`http:` は、host がループバックのアドレス（`localhost`、`127.0.0.1`、`[::1]`）のときだけ受けます（例: `http://example.com` は拒否）。
- 同じ値を 2 回書けません。
- 参照するターゲット JSON の `site.allowedOrigins` に含まれる Origin だけを受けます。監査の範囲の外に、認証と書き込みの許可を作らないためです（例: `site.allowedOrigins` が `https://example.com` だけなら、`https://example.invalid` は拒否）。

### `environmentEvidenceRef`

- テスト環境が本番から隔離されていることを確かめた記録への、秘密を含まない参照です。パスワードやトークンを書かないでください。
- 隔離をまだ確かめていないテスト環境で、読み取りの段（認証つきの監査、自動ログイン、操作の候補の発見と READ の確かめ）だけを行うときは、未確認であることが分かる参照（例 `isolation-unverified-20261016`）を入れます（「[実テスト環境の手順](real-test-environment.md)」）。
- 1〜200 文字です。文字の数は UTF-16 のコード単位で数えます（絵文字などの一部の文字は、1 文字で 2 と数えます）。
- 次の値は拒否します。
  - 空白とゼロ幅の文字（U+200B〜U+200D、U+2060、U+FEFF）だけの値
  - 改行、制御文字を含む値
  - 文字の向きを変える文字（U+202A〜U+202E、U+2066〜U+2069、U+200E、U+200F）を含む値
  - 対になっていないサロゲート（UTF-16 の壊れた文字）を含む値
- `PUBLIC` の環境では `null` にします。
- `TEST` の環境の `PUBLIC_PASSIVE` では、任意です。`TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE` では、必須です。
- BeakSight が判定するのは、参照があるかと、その形だけです。参照の中身（確かめた記録か、未確認の印か）は読みません。そのため、未確認の参照でも、書き込みの実行の許可を拒みません。書き込み（`TEST_APPROVED_WRITE`）に進む前に、隔離の扱いを人が判断します（「[実テスト環境の手順](real-test-environment.md)」）。

### `approvedServiceOrigins`

- スクリプトで送るログイン（「[スクリプトで送るログイン](authenticated-audit.md#スクリプトで送るログイン)」）で、画面のスクリプトが送る先の、認証のサービスと API の Origin です。任意の項目で、ないときは空と同じです。項目のないプロファイルは、今までと同じ文書のままです。
- `TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE` だけで書けます。`PUBLIC_PASSIVE` では空にします（`PROFILE_SERVICE_ORIGIN_INVALID`）。
- 4 件までです。同じ値を 2 回書けません（どちらも `PROFILE_SCHEMA_INVALID`）。
- 書き方は `approvedTestOrigins` と同じです。Origin の正規の書き方で、scheme は `https:`。`http:` は、host がループバックのアドレスのときだけ受けます（`PROFILE_SERVICE_ORIGIN_INVALID`）。
- 参照するターゲット JSON の `site.allowedOrigins`（監査で読む範囲）に含まれる Origin は書けません（`PROFILE_SERVICE_ORIGIN_INSIDE_TARGET`）。サービスの Origin を書いても、巡回の対象、読み込みの数え方、robots.txt と sitemap.xml の取得の対象は広げません。
- ログインの段では、この Origin への読み取り（ページの移動でないもの）と、認証の設定に登録した送信だけを通します。監査の段の扱いは今までどおりです（許可 Origin の外への読み取りは送ります）。
- この項目を変えると、プロファイルの改訂が進みます。認証の設定は保存し直しが要り、書き込みのシナリオの承認は「要再承認」になります（どの項目の編集でも同じです）。

## 拒否のコード

拒否したときは、次のコード（1 件以上）と、英語の技術的な詳細を返します。管理画面は、項目ごとに日本語の理由を表示します。

| コード | 意味 |
| --- | --- |
| `PROFILE_SCHEMA_INVALID` | プロファイルの形の誤り: 知らない項目、項目の不足、値の型の誤り、一覧にない値、`schemaVersion` の違い、`revision` が 1 以上の整数でない、`profileId` の形の誤り、`approvedTestOrigins` の重複、`environmentEvidenceRef` が空の文字列か 200 文字（コードポイント）を超える。これらの形の誤り（スキーマの誤り）があるときは、このコードだけを返し、下の規則は確かめません。`revision` が正確に扱える整数の範囲を超えるときもこのコードですが、スキーマは通るので、ほかの規則のコードと一緒に返ります。改訂の確かめでは、写せない値、形の誤り、検証で受けていない次の改訂も、このコードです。 |
| `PROFILE_ID_INVALID` | `profileId` の形の誤り（形の確かめの後に、もう一度確かめる規則。形の誤りは、ふつうは `PROFILE_SCHEMA_INVALID` になります）。 |
| `PROFILE_TARGET_PATH_INVALID` | `targetConfigPath` の誤り。 |
| `PROFILE_MODE_ENVIRONMENT_MISMATCH` | 監査モードを、その環境で選べない（例: `PUBLIC` の環境の `TEST_AUTH_PASSIVE`）。`PUBLIC` の環境で `environmentEvidenceRef` が `null` でない場合も、このコードです。 |
| `PROFILE_AUTH_MISMATCH` | 認証の方式が、監査モードに合わない（例: `PUBLIC_PASSIVE` の `MANUAL_SESSION`、`TEST_AUTH_PASSIVE` の `NONE`）。 |
| `PROFILE_TEST_ORIGINS_REQUIRED` | `TEST_AUTH_PASSIVE` か `TEST_APPROVED_WRITE` で、`approvedTestOrigins` が空。 |
| `PROFILE_TEST_ORIGIN_INVALID` | `approvedTestOrigins` の値の書き方か scheme の誤り。`PUBLIC_PASSIVE` で `approvedTestOrigins` が空でない場合も、このコードです。 |
| `PROFILE_TEST_ORIGIN_OUTSIDE_TARGET` | `approvedTestOrigins` の値が、参照するターゲット JSON の `site.allowedOrigins` に含まれない。 |
| `PROFILE_ENVIRONMENT_EVIDENCE_REQUIRED` | `TEST_AUTH_PASSIVE` か `TEST_APPROVED_WRITE` で、`environmentEvidenceRef` が `null`。値が空白とゼロ幅の文字だけの場合、UTF-16 のコード単位で 200 を超える場合、改行・制御文字・文字の向きを変える文字・対になっていないサロゲートを含む場合も、このコードです。 |
| `PROFILE_SERVICE_ORIGIN_INVALID` | `approvedServiceOrigins` の値の書き方か scheme の誤り。`PUBLIC_PASSIVE` で空でない場合も、このコードです。 |
| `PROFILE_SERVICE_ORIGIN_INSIDE_TARGET` | `approvedServiceOrigins` の値が、参照するターゲット JSON の `site.allowedOrigins` に含まれる。 |
| `PROFILE_REVISION_NOT_ADVANCED` | 改訂の `revision` が、前の改訂より大きくない。前か次の `revision` が、1 以上の正確に扱える整数でない（比べられない）。または、前の改訂と `profileId` が違う。 |

形が正しいときは、当たった規則のコードを、すべて返します（例: `PUBLIC` の環境の `TEST_AUTH_PASSIVE` と `NONE` は、`PROFILE_MODE_ENVIRONMENT_MISMATCH` と `PROFILE_AUTH_MISMATCH` の両方を返します。`approvedTestOrigins` や `environmentEvidenceRef` にも誤りがあれば、そのコードも返します）。
`revision` が正確に扱える整数の範囲を超えるときは、`PROFILE_SCHEMA_INVALID` と、ほかの規則のコードを一緒に返します（例: `revision` が `1e300` で、`PUBLIC` の環境の `TEST_AUTH_PASSIVE` なら、`PROFILE_SCHEMA_INVALID` と `PROFILE_MODE_ENVIRONMENT_MISMATCH` などを返します）。

### 判定を呼ぶ側の決まり

プロファイルの判定は、参照するターゲット JSON を読み込んだ結果（プロファイルを使う側が、これまでの設定の読み込みで読んだもの）を受け取って、`approvedTestOrigins` が `site.allowedOrigins` に含まれるかを確かめます。

- 受け取ったターゲット JSON の形が正しくない（読み込みの結果でない値を渡した。たとえば `site.allowedOrigins` がない）ときは、判定がそれを読む場合（`TEST_AUTH_PASSIVE` と `TEST_APPROVED_WRITE` で、`approvedTestOrigins` の値の書き方が正しい場合）に、拒否の結果を返さずに、例外（`TypeError`）で止まります。これは呼び出し側の誤りで、そのプロファイルを受けることはありません（止まる側なので安全です）。
- プロファイルの値の誤りは、例外ではなく、上の拒否のコードで返します。

## 旧ターゲット JSON の扱い

プロファイルのない、これまでのターゲット JSON だけの監査は、つねに `PUBLIC_PASSIVE` です。

- ターゲット JSON には、監査モードを書けません。`mode`、`environment`、`auth`、`profile` などの項目を書くと、知らない項目として設定のエラー（`unknown configuration key`）になります。
- プロファイルのないターゲット JSON での監査（CLI）は、認証のない公開の監査です。管理データにプロファイルを作りません。
- 公開の監査の判定（Guard）、URL の扱い、停止と再開、出力の形式（「[出力](output.md)」）は、プロファイルの追加の前と変わりません。
