# BeakSight Task 23 ローカル管理画面の基盤と管理データの保存 実装計画

作成日: 2026-10-09
状態: ユーザー承認済み（2026-10-09）
設計書: `2026-10-09-beaksight-task-23-local-ui-store-design.md`

## サブタスク

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| T23a | 管理データの部品の土台: 環境の確かめ（4.5）、`resolveControlDatabasePath`、`openControlDatabase`（何もない状態からの準備、止める理由の一覧、版の管理、WAL、`application_id`、`quick_check`）、`withWriteTransaction`、`.gitignore`、Gate（`node:sqlite` と `BEGIN` の置き場所、Git の外）。依存の追加は不要 | 設計の承認 | 完了 |
| T23b | 依存の追加と互換の確かめ（ユーザーの承認の後）: 版を固定して `--ignore-scripts` で入れる、最小の画面（1 画面）、`vite.config.ts`、Nitro なしのビルドと `node:http` の起動、TS 7.0.2 と今の厳しい tsconfig で画面の型チェックが通るか、既存の `npm run verify` の結果と所要時間が変わらないか | 設計と依存の承認 | 完了 |
| T23c | プロファイルの保存: 表（版 1）、作成・更新・取り消し・一覧・取得、改訂の単調増加をトランザクションの中で、履歴、同時の更新、落ちたとき、`getStoreStatus` | T23a | 完了 |
| T23d | `npm run setup:local` と手順書（`doc/spec/local-setup.md`）、表示の誤りの説明（`messages.ts`）、CLI の監査のコマンドが `node:sqlite` を読み込まないことの確かめ | T23a、T23c | 完了 |
| T23e | 画面のサーバの保護: 127.0.0.1、Host、token と cookie、CSRF の middleware、header、static、開発のサーバの設定、`apps/local-ui` の import の範囲の Gate | T23b | 完了 |
| T23f | 画面: 一覧、登録・編集（設定の検証の結果の表示）、取り消し、環境の状態、表示カタログの追加、`tokens.css`、Server Functions（入力のスキーマ）、画面の E2E（Playwright headless、127.0.0.1） | T23c、T23d、T23e | 完了 |
| T23g | スクリプト（`verify:ui`、`verify:all`、`ui`、`ui:dev`）、`doc/spec/local-ui.md`、README と `development.md` の案内、共通部品台帳 | T23f | 完了 |
| T23R | 独立レビュー（読み取り専用。ローカルのサーバの保護、管理データの準備と書き込み、SSOT、何もない状態からの手順の再現） | T23g | 完了 |

- T23a と T23b は、変更するファイルが重ならない（T23a は `src/control/`、`tests/`、`.gitignore`。T23b は `package.json`、`package-lock.json`、`apps/local-ui/`）。並行してよい。`package.json` のスクリプトは T23b と T23g だけが変える（`setup:local` の登録は T23d が T23b の後に行う）。
- T23b で、TS 7.0.2 の型チェックが通らない、Nitro なしで起動できないなど、設計の前提が崩れたら Blocker として止まる。代わりの案（画面だけ TypeScript 6 を使う、TanStack Router の SPA と自前のサーバにする、など）は依存や ADR の変更になるので、ユーザーに確認する。

## 各サブタスクの受け入れ条件

### T23a

- RED → GREEN: 設計書 7 章の「環境の確かめ」「何もない状態からの準備」「版の管理」「Git の外」「Architecture Gate」の各テスト。
- SQLite でないファイルを上書きしないこと（前後のハッシュ）。
- 2 回目の準備が何も変えないこと（冪等）。
- `npm run typecheck`、関係するテスト、`tests/architecture`（各 1 秒以内）。

### T23b

- `npm install --save-exact --ignore-scripts --before=<設計書 4.1 の日付>` の結果（入った版、lockfile の差分の要約、install の script が動いていないこと）。
- 最小の画面のビルド、`node:http` の起動で 127.0.0.1 から 1 画面が出ること（Playwright headless で確かめる）。
- 画面の型チェック（`skipLibCheck:false`、`exactOptionalPropertyTypes:true` を含む今の厳しさ）が通るか。通らない場合の誤りの一覧。
- 既存の `npm run verify` の前後の結果と所要時間。

### T23c

- 設計書 7 章の「書き込み」「落ちたとき」の各テスト。同時の更新は 2 つの子 process で、名前つきの回数。

### T23d

- `npm run setup:local` を、何もない一時のフォルダ（リポジトリの外のコピーではなく、場所を引数で渡せる入口）で実行して、作った・既にあった・各理由の失敗の表示と終了コード。
- 手順書の手順を、上から順に実行して確かめた記録（`local-data/` がない状態から）。

### T23e

- 設計書 7 章の「画面のサーバ」の各テスト。

### T23f

- 設計書 7 章の「画面」の各テスト。UI Gate（既存の文言・カタログの決まり）に合うこと。

### T23g

- `npm run verify:all` が PASS。文書の索引。

## 検証の決まり

- 全体の `npm run verify` と `npm run verify:all` は設計者が実行する。
- 実サイトへは接続しない。画面のテストは 127.0.0.1 の自前のサーバだけ。Chromium は headless だけ。
- 依存の追加は T23b だけが、承認された版だけで行う。
