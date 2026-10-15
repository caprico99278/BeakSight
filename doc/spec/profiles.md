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

すべての項目が必須です。知らない項目があると、拒否されます。

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
- プロファイルのないターゲット JSON は、次のプロファイルと同じに扱います: `environment` が `PUBLIC`、`mode` が `PUBLIC_PASSIVE`、`auth` が `NONE`、`approvedTestOrigins` が空、`environmentEvidenceRef` が `null`、`revision` が `1`。
- このときの `profileId` は、`target.id` から作ります。小文字にし、小文字の英数字とハイフン以外を `-` にし、続く `-` を 1 つにまとめ、先頭の `-` を除き、63 文字までにします（例: `Example_Site` は `example-site`）。それでも上の形に合わなければ、`legacy-target` にします。
- 公開の監査の判定（Guard）、URL の扱い、停止と再開、出力の形式（「[出力](output.md)」）は、プロファイルの追加の前と変わりません。
