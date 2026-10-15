# BeakSight Task 26 テスト環境の自動ログイン 実装計画

作成日: 2026-10-10
状態: ユーザー承認済み（2026-10-10。設計書の承認に含む）
設計書: `2026-10-10-beaksight-task-26-automated-login-design.md`

## サブタスク

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| T26a | 資格情報の暗号化の部品（DPAPI。`src/control/credentials/dpapi-protector.ts`）とファイルの部品（場所、形 `beaksight-credential/1`、entropy、icacls の権限、置き換え、削除、読み出し、一時のファイルの片付け、往復の確かめ。`credential-store.ts`）、ファイルの JSON Schema、Gate（`child_process`・`powershell`・`icacls`・`ProtectedData`・`local/secrets` の置き場所）（設計書 4.1） | G25 | 未着手 |
| T26b | 認証の設定の版 2（`automatedLogin`、`failureConditions`、回数 1）と検証の誤り、版 1 の読み込み、保存の部品の対応（設計書 4.3）。今実行できる方式は変えない（ワーカーが自動ログインを行えるようになる前に `AUTOMATED_LOGIN` を実行できる方式にすると、手動のログインの段へ流れるおそれがあるため。T26d で変える） | G25 | 未着手 |
| T26c | 管理データの版 4（ジョブの表の作り直しと `job_kind`、新しい失敗の理由、`auto_login_attempts`、`auto_login_holds`、`credential_events`）、上限の判定（1 回、間隔、24 時間、`Retry-After`、止める・解く）、開始の前の確かめ、試しの記録（設計書 4.5） | T26a、T26b | 未着手 |
| T26d | 入力の部品（`src/browser/login-form-submitter.ts`。フォームを読むだけの確かめ、`fill`・`click`、誤りを固定のコードに）、自動ログインの段（ワーカー、headless、結果の分類、成功の判定の共通の部品）、`LOGIN_CHECK` のジョブ、IPC（`START` の改訂の番号とファイルの場所、`AUTH_STATE` の結果）、ワーカーの環境からデバッグの変数を外す、ログインの段の Ledger と console を出さない、Gate (q) を `src/` 全体に、今実行できる方式に `AUTOMATED_LOGIN`（Windows だけ。`execution-policy.ts`）（設計書 4.3、4.4、4.5） | T26c | 未着手 |
| T26e | 画面（資格情報の登録・変更・削除、ログインの検証、止めた状態と解除、上限の表示、監査の開始の案内、ジョブの結果）、文言とカタログ（設計書 4.2、4.6） | T26d | 未着手 |
| T26f | 目印の検査（ユーザー名とパスワード。設計書 4.7 の場所のすべて）、手順書（`doc/spec/authenticated-audit.md` と索引） | T26e | 未着手 |
| T26R | 独立レビュー（読み取り専用。資格情報の保存と変更、自動ログインの段の通信、結果の区別、上限、秘密、公開監査の不変） | T26f | 未着手 |

- T26a（`src/control/credentials/`、`schemas/control/` の資格情報のファイルのスキーマ、新しい Gate のテスト）と T26b（`src/control/auth/`、`src/control/store/auth-setup-store.ts`、`schemas/control/auth-setup*.schema.json`）は、変更するファイルがほぼ重ならないので並行してよい。両方が触れる `src/control/control-schema-validator.ts`（スキーマの名前の一覧）と、その一致のテストは、名前を足す行だけを変え、作業の前と後に `git diff` で相手の変更を壊していないかを確かめる。

## 検証の決まり

- 全体の `npm run verify:all` は設計者が実行する。
- 実サイト・実テスト環境へは接続しない。テストは 127.0.0.1 の fixture だけ。Chromium は headless だけ。
- 安全に関わる変更（T26d）は、テストの既定の Chromium と CLI の起動の設定の両方で確かめる。
- 資格情報は、実行ごとに作る目印の値だけを使う。本物の資格情報を使わない。報告とファイルに値を書かない。
- 本物の DPAPI と icacls を使うテストは、一時のフォルダだけに書く。リポジトリの `local/` に書かない。Windows の資格情報マネージャーに登録しない。PowerShell の cmdlet の引数や誤りの文に目印の値が載る書き方をしない（イベントログに残るため）。
- リポジトリの `local-data/`、`local/`、出力先に書かない・読まない。
