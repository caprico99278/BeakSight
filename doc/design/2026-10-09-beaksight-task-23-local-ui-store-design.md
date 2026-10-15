# BeakSight Task 23 ローカル管理画面の基盤と管理データの保存 設計書

作成日: 2026-10-09
状態: ユーザー承認済み（2026-10-09。依存パッケージの追加の承認を含む）。G23 完了（2026-10-09。ユーザーの長時間離席の指示により承認済みとして閉じた）
対象範囲: ローカルだけで動く管理画面（TanStack Start）の土台、管理データの保存（SQLite）、何もない状態からの環境の準備と初期化の手順、サイトとプロファイルの登録・更新・取り消し・一覧の画面

## 1. 目的

- ロードマップ（`2026-10-09-beaksight-task-22-32-roadmap.md`）の Task 23 を実現する。Task 22 で決めた監査プロファイルを、ローカルの画面から登録・更新でき、再起動しても残るようにする。
- この Task では、監査の実行（Task 24）、認証（Task 25 以降）、書き込みの検証（Task 27 以降）は有効にしない。
- ユーザーの要件（2026-10-09）: 「環境構築時、SQLite が存在しない場合でも正しく環境設定と初期化ができるように設計、手順構築も含めて進めよ」。データベースのファイル、置き場所のフォルダ、SQLite の機能を持つ Node が、どれもない状態から始めても、手順どおりに進めれば正しく準備でき、足りないものは分かりやすく止めて伝える。

## 2. 根拠となる文書と優先順位

- 従う文書: ロードマップ（とくに 1.3、3.2 の I01〜I16、4 章、8 章、Task 23 の章、13 章、15 章）、Task 22 の設計書（`2026-10-09-beaksight-task-22-profile-contract-design.md`）、UI 追補設計書（`2026-09-23-beaksight-ui-ssot-design.md`）、共通部品台帳。
- 調査の結果（事実の出典）: 作業記録の `progress.md` の「T23 SQLite 調査」と「T23 UI 構成 調査」。
- コンセプトアート（ユーザー提供の画像。リポジトリには写さない）は、見た目の方向（左のメニュー、上の帯、要約のカード、暗い背景に琥珀色の差し色）にだけ使う。機能の範囲はロードマップで決める（2026-10-09 ユーザーの判断）。
- 引き続き守る不変条件: I01（旧 JSON は `PUBLIC_PASSIVE`）、I02（公開監査の挙動を変えない）、I08（画面の操作は権限の十分条件ではない。保存の前にサーバで検証し直す）、I11（秘密を保存しない）、I16（実サイトへ接続しない）。Task 22 の Architecture Gate（`control-boundary.test.ts`）、GATE-ARCH08（Ajv は core と control の validator だけ）。

## 3. 採用する設計

### 3.1 全体の形

```text
[ブラウザ（利用者のもの）] --http://127.0.0.1:<port>--> [ローカルの画面のサーバ（Node。apps/local-ui）]
                                                         ├ 起動の部品: 127.0.0.1 だけで待ち受け、Host の確かめ、合言葉（起動ごとの token）→ cookie、
                                                         │            応答の header（no-store、CSP など）、static の配信
                                                         ├ TanStack Start: 画面（Router）、Server Functions（CSRF の middleware つき）
                                                         └ 管理データの部品（src/control/store。SQLite）
                                                                └ local-data/beaksight-control.sqlite（Git の管理の外）
```

- 画面のサーバは、利用者が `npm run ui` で起動する。監査の本体（Playwright、Guard、Run）はこの Task では呼ばない。
- 管理データの読み書きは、すべて `src/control/store/` の部品を通す（SSOT）。画面のサーバの Server Function は、入力を検証し直してから、この部品を呼ぶだけにする。
- 画面の表示の語（日本語のラベル）と書式は、既存の `src/presentation/`（表示カタログ、書式、文言）に足して使う。画面のために別の語の一覧を作らない。

### 3.2 採用しなかった案

- **Nitro で本番のサーバを作る**: Nitro に安定版がない（調査。latest が beta）。Vite のビルドの出力（`dist/server/server.js` の `fetch`）を、自前の小さな起動の部品で包む。
- **npm workspaces**: Vite が workspace の root（リポジトリ全体）を配信の許可の範囲にし、`local/`、`artifacts/`、`local-data/` を配る恐れがある（調査）。ルートの `package.json` に足す構成にする。
- **別のデータベースのドライバ**: `node:sqlite` は Node 24.15.0 で Release candidate になり、実験（何もない状態からの初期化、同時の書き込み、強制終了 240 回）で不合格の項目がなかった。依存を増やさない `node:sqlite` を採る（ロードマップの ADR-010 を、この Task で「条件つきで確定」とする）。

## 4. 詳細設計

### 4.1 依存パッケージ（ユーザーの承認が必要）

ルートの `package.json` に、版を固定して（`^` なし）足す。

| パッケージ | 版 | 公開日 | 種類 | 用途 |
| --- | --- | --- | --- | --- |
| `@tanstack/react-start` | 1.168.60 | 2026-09-30 | dependencies | Start の本体（Server Functions、middleware、CSRF、Vite の plugin） |
| `@tanstack/react-router` | 1.170.41 | 2026-09-30 | dependencies | 画面の遷移（Start がこの版に固定している） |
| `@tanstack/react-query` | 5.103.2 | 2026-09-21 | dependencies | 状態の再取得（Task 24 の進捗の表示で本格的に使う） |
| `@tanstack/react-form` | 1.33.5 | 2026-08-11 | dependencies | プロファイルの編集のフォーム |
| `react`、`react-dom` | 19.3.0 | 2026-09-09 | dependencies | 画面 |
| `vite` | 8.2.4 | 2026-10-06 | devDependencies | 画面の開発とビルド。今 vitest が間接に使っている 8.2.2 も、この版にそろう |
| `@vitejs/plugin-react` | 6.1.1 | 2026-08-28 | devDependencies | React の変換 |
| `@types/react`、`@types/react-dom` | 19.3.0 | 2026-09-09 | devDependencies | 型 |

- **2 週間の例外**: 供給網の安全のため、公開から 2 週間たった版を選ぶのを原則にした。しかし、2 週間たった版は、Start が Critical の XSS（GHSA-qx66-fv34-fjm8。Server Functions の応答）、Vite が 2026-10-06 の advisory 3 件の対象だった。直った版（Start と Router は 9 日、Vite は 3 日）を例外として採る。今の lockfile の vite 8.2.2（vitest が使う）も advisory の対象で、この追加で直る。
- **入れ方**: `npm install --save-exact --ignore-scripts`（install の script を動かさない。2026-05 の @tanstack の乗っ取りの事件の手口が install の script だったため。調査では、入る予定のパッケージに install の script を持つものは 0 件）。間接の依存は、`--before`（直接の依存の最も新しい公開日の翌日、2026-10-07）で、それより後に公開された版を入れない。lockfile を固定し、以後は `npm ci --ignore-scripts` で入れる。
- **大きさ**: 間接の依存は約 116 個（新しく約 97 個）、展開後で約 99MB（推測。調査）。
- **入れないもの**: nitro（beta）、devtools、zod の直接の依存（入力の検証は既存の ajv と、Task 22 の検証の部品で行う）。
- **Node の版**: `package.json` の `engines` を `>=24.15.0 <25` に上げる（`node:sqlite` が Release candidate になり、警告が出なくなった版。今の環境は 24.15.0 で影響なし）。手順書では、最新の 24 系（2026-10-09 時点で 24.21.0。24.15.0 より後に SQLite の安全の修正がある）を勧める。Node の更新は利用者の環境の変更なので、強制はしない。

### 4.2 置き場所

```text
apps/local-ui/
  vite.config.ts            # 127.0.0.1、strictPort、allowedHosts、fs の deny（local/、artifacts/、local-data/、.git）
  tsconfig.json             # 画面用（jsx、Bundler の解決）。ルートの tsconfig の厳しさを引き継ぐ
  src/start.ts              # Start の設定。CSRF の middleware を明示で付ける
  src/router.tsx
  src/routes/               # 画面
  src/server/               # Server Functions（入力の検証 → src/control/store を呼ぶだけ）
  src/components/           # React の部品
  src/styles/tokens.css     # 画面の色と余白の唯一の定義
  launcher/                 # 起動の部品（node:http。4.4）
  tests/                    # 画面とサーバのテスト（vitest の別の設定。4.8）
src/control/store/          # 管理データの部品（Node 専用。4.3）
src/control/environment/    # 環境の確かめ（Node の版、node:sqlite の有無、local-data の場所。4.5）
local-data/                 # 管理データ（Git の管理の外）
doc/spec/local-ui.md        # 画面の起動と使い方
doc/spec/local-setup.md     # 環境の準備と初期化の手順（4.6）
```

- ルートの `tsconfig.json`（`include` を明示）と `vitest.config.ts`（`tests/**/*.test.ts`）には `apps/` を入れない。既存の `npm run verify` の対象と所要時間を変えない。`src/control/store/` と `src/control/environment/` は既存の型チェックとテスト（`tests/unit`、`tests/integration`）で確かめる。
- `apps/local-ui/` から `src/` の部品を import してよいのは、`src/control/`、`src/presentation/`、`src/config/`（設定の検証の表示のため）だけにする。`playwright`、`src/browser/`、`src/safety/`、`src/orchestration/` などは import しない（Architecture Gate を足す）。

### 4.3 管理データの保存（`src/control/store/`）

**ファイルの場所**: `local-data/beaksight-control.sqlite`。場所を決めるのは `resolveControlDatabasePath(repoRoot)` だけ（唯一の owner）。テストは一時のフォルダを渡せるよう、開く部品は場所を引数で受ける。本番の入口（`npm run setup:local`、`npm run ui`）は必ず `resolveControlDatabasePath` を使う。

**開いて準備する部品** `openControlDatabase(path)`（唯一の入口。冪等）:

1. 環境の確かめ（4.5）を通っていること。
2. フォルダがなければ作る（`mkdirSync` の `recursive`）。フォルダの代わりに同じ名前のファイルがあれば止める。
3. ファイルがあり、大きさが 0 でなければ、先頭 16 byte が SQLite の印（`SQLite format 3` と 0 の byte）かを確かめる。違えば「SQLite のファイルではない」として止める。**上書き・削除・移動はしない**（利用者のデータを壊さない）。
4. `new DatabaseSync(path, { timeout: CONTROL_DB_BUSY_TIMEOUT_MS })` で開く（選択肢は常にオブジェクトで渡す。`undefined` を渡すと実行時に失敗するため）。
5. `PRAGMA journal_mode=WAL` を行い、結果が `wal` であることを確かめる（違えば止める）。`synchronous` は既定（FULL）のまま。
6. `PRAGMA application_id` を確かめる。0（新しいファイル）なら BeakSight の値を書く。別の値なら「BeakSight の管理データではない」として止める。
7. 版の管理（migration）: `PRAGMA user_version` を読む。アプリが知る版より大きければ「新しい版の BeakSight で作られた」として止める（書かない）。小さければ、版ごとに `BEGIN IMMEDIATE` → DDL → `PRAGMA user_version=N` → `COMMIT` を行う。失敗したら必ず `ROLLBACK` する（自動では戻らないことを調査で確かめた）。`user_version` が 0 なのに表がある場合は止める。
8. `PRAGMA quick_check` が `ok` であることを確かめる。

止めるときの誤りは、閉じた一覧の理由の値（例: `NODE_SQLITE_UNAVAILABLE`、`NODE_VERSION_UNSUPPORTED`、`DATA_DIRECTORY_NOT_DIRECTORY`、`NOT_A_SQLITE_FILE`、`NOT_A_BEAKSIGHT_DATABASE`、`DATABASE_FROM_NEWER_VERSION`、`DATABASE_LOCKED`、`DATABASE_READ_ONLY`、`DATABASE_INTEGRITY_FAILED`、`MIGRATION_FAILED`）と、利用者への日本語の説明（`src/presentation/messages.ts`）で表す。SQLite の errcode 14 は「フォルダがない」と「別のプログラムがファイルを開いている」の両方で出るので、フォルダの有無を先に確かめて文を分ける。

**書き込みの決まり**: 書き込みは、この部品の `withWriteTransaction(fn)` だけで行う（`BEGIN IMMEDIATE`、失敗で `ROLLBACK`、成功で `COMMIT`）。deferred の `BEGIN` は使わない（調査で、待ちが効かずに大量に失敗した）。Architecture Gate で、`src/control/store/` の外から `node:sqlite` を import すること、`BEGIN` の文字列を書くことを止める。

**表（版 1）**:

| 表 | 内容 |
| --- | --- |
| `profiles` | プロファイルの今の状態（`profile_id` 主キー、`revision`、`status`（`ACTIVE` / `RETIRED`）、`document`（Task 22 の `SiteProfile` の JSON）、`updated_at`） |
| `profile_revisions` | 改訂の履歴（`profile_id`、`revision`、`document`、`change_kind`（`CREATED` / `UPDATED` / `RETIRED`）、`recorded_at`）。主キーは `profile_id` と `revision` |
| `store_meta` | 作った版、作った日時（診断用） |

- 保存の前に、Task 22 の `validateSiteProfile` を通す（不正な値は保存しない）。更新では、同じトランザクションの中で今の改訂を読み、`assertProfileRevisionAdvance` で改訂が増えることを確かめる。
- 取り消し（`RETIRED`）は、行を消さず、改訂を 1 つ進めて状態を変える。取り消したプロファイルは一覧で区別して表示し、Task 24 で実行の対象にしない。
- 表の `STRICT` を使い、型の誤りを入れない。日時は既存の書式の owner（`src/core/utc-timestamp.ts` など）を使う。
- 秘密（パスワード、token、cookie）は保存しない（I11）。プロファイルの JSON にも秘密の欄はない（Task 22）。

**管理データの部品の公開の関数（Task 23 の範囲）**: `openControlDatabase`、`closeControlDatabase`、`listProfiles`、`getProfile`、`createProfile`、`updateProfile`、`retireProfile`、`getStoreStatus`（版、場所、件数、`quick_check` の結果。画面の「環境の状態」に出す）。

### 4.4 ローカルの画面のサーバの保護（`apps/local-ui/launcher/`）

- **待ち受け**: `127.0.0.1` だけ。`0.0.0.0`、`::`、LAN のアドレスでは待ち受けない（設定で変えられない）。port は既定の値（名前つきの定数）を使い、使用中なら止めて伝える（別の port を自動で選ばない。`--port` で明示はできる）。
- **Host の確かめ**: `Host` が `127.0.0.1:<port>` または `localhost:<port>` でなければ 421 で拒否する（DNS rebinding の対策。Start の CSRF の確かめは Host から期待する origin を作るので、これが前提になる）。
- **合言葉（起動ごとの token）**: 起動のたびに暗号的な乱数の token を作り、コンソールに `http://127.0.0.1:<port>/?token=…` を表示する。最初のアクセスで token を確かめたら、`HttpOnly`、`SameSite=Strict`、`Path=/` の cookie に替え、token を除いた URL へ移す。cookie がない要求は、画面の要求でも Server Function でも拒否する（ほかの利用者や、同じ PC のほかのプログラムからの操作を防ぐ）。token はログやファイルに書かない（コンソールの表示だけ）。
- **CSRF**: `src/start.ts` で Start の CSRF の middleware を明示で付ける（`src/start.ts` を置くと既定の保護が外れるため）。Server Function の要求は `Sec-Fetch-Site: same-origin`（なければ `Origin`）が一致しなければ 403。書き込みは Server Function（POST）だけで行い、Server Routes では書き込まない。
- **応答の header**: すべての応答に `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Content-Security-Policy`（`default-src 'self'`、script は nonce つき、`frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'self'`）、`Cross-Origin-Opener-Policy: same-origin`。
- **static の配信**: ビルドの出力の `dist/client` の中だけ。パスの正規化と、外へ出るパス（`..`、絶対パス、別のドライブ）の拒否。
- **開発のサーバ（`npm run ui:dev`）**: Vite の `server.host: '127.0.0.1'`、`strictPort: true`、`allowedHosts` は既定（空）のまま、`server.fs.deny` に `local/`、`artifacts/`、`local-data/`、`.git` を足す。開発のサーバでも token と header の確かめを同じ部品で行う（Vite の middleware として差し込む）。手段は T23a の実験で決める。
- **入力の検証**: Server Function の入力は、サーバで JSON のスキーマ（`schemas/control/`）と Task 22 の検証で確かめる。画面の側の確かめは補助だけ。

### 4.5 環境の確かめ（`src/control/environment/`）

- `checkControlEnvironment()`: 次を確かめ、結果（合否と理由の値）を返す。
  - Node の版が `engines` の下限（24.15.0）以上か。
  - `process.getBuiltinModule('node:sqlite')` が使えるか（使えなければ `NODE_SQLITE_UNAVAILABLE`）。`node:sqlite` は、この確かめを通った後に、動的に読み込む（静的な import だと、確かめの前に読み込みで落ちて、分かりやすく伝えられないため。調査で確かめた）。
  - 今の CLI の監査のコマンド（`run`、`validate-config`）は、この確かめも `node:sqlite` も読み込まない（影響させない）。
- 下限の版の値は `package.json` の `engines` と一致することをテストで確かめる（二重定義の検出）。

### 4.6 何もない状態からの準備と初期化（ユーザーの要件）

**手順書** `doc/spec/local-setup.md`（README からは起動の手順だけを短く案内する）:

1. Node.js 24 の最新（24.15.0 以上が必須）を入れる。`node -v` で確かめる。SQLite は Node に組み込まれているので、**別に入れるものはない**ことを明記する。
2. `npm ci --ignore-scripts` で依存を入れる。
3. `npx playwright install chromium`（既存の監査のため。管理画面だけなら不要と明記）。
4. `npm run setup:local` で管理データを準備する。
5. `npm run ui` で画面を起動し、コンソールに出た URL をブラウザで開く。

**`npm run setup:local`**（冪等。何回実行してもよい）:

- 環境の確かめ（4.5）→ `local-data/` を作る → データベースを作るか開く → 版を最新にする → `quick_check` → 結果を日本語で表示する（場所、版、プロファイルの件数、「作った」か「既にあった」か）。
- 失敗したら、理由ごとの日本語の説明と、利用者が取るべき手順を表示し、0 でない終了コードで終わる。手順の例:
  - Node が古い → Node 24 の最新を入れる。
  - SQLite でないファイル・BeakSight のものでないファイル → そのファイルを別の名前に変えるか別の場所へ移してから、もう一度実行する（BeakSight は消さない）。
  - 新しい版のデータベース → 新しい版の BeakSight を使う。
  - 別のプログラムが開いている → 画面のサーバやほかのプログラムを閉じる。
- `npm run ui` も起動の初めに同じ準備（同じ部品 `openControlDatabase`）を行う。`setup:local` を忘れても画面は正しく準備してから起動する。
- 消すこと（データベースの初期化、作り直し）は、この Task では作らない（ロードマップの非スコープの「DB 初期化の自動化」）。手順書に、手で別の名前に変えれば次の準備で新しく作られることだけを書く。

**Git の管理の外であることの保証**: `.gitignore` に `/local-data/` を足す。自動のテストで、`.gitignore` に `/local-data/` があり、`resolveControlDatabasePath` の結果が `local-data/` の下にあることを確かめる（Node の `fs` と文字列だけ。Git のコマンドを呼ばない）。

### 4.7 画面（Task 23 の範囲）

コンセプトアートの見た目の方向（左のメニュー、上の帯、カードとパネル、暗い背景と琥珀色の差し色）に合わせる。色と余白は `apps/local-ui/src/styles/tokens.css` で一か所に定義する。文字の大きさと対比は読みやすさを優先する（暗い背景で、本文の文字と背景の対比を十分にとる）。

| 画面 | 内容 |
| --- | --- |
| サイトとプロファイルの一覧 | プロファイルごとに、名前（`profileId`）、公開／テストの別、監査モード、状態（有効・取り消し）、改訂、最後の更新日時。「最後の Run の状態」の欄は置くが、Task 24 までは「まだ実行の機能がない」と表示する |
| プロファイルの登録・編集 | Task 22 の `SiteProfile` の各項目。設定のファイル（`targetConfigPath`）を選び、その設定の検証の結果（既存の設定の検証の部品の結果と日本語の説明）を表示する。保存の前に、Task 22 の検証の結果（誤りの理由の日本語の説明）を表示する。`TEST_*` のモードは保存はできるが、「認証と書き込みは後の Task で有効になる。今は実行できない」と明示する |
| 取り消し | 確認のダイアログの後に取り消す。取り消しは元に戻せない（新しい改訂で作り直す）ことを明示する |
| 環境の状態 | Node の版、SQLite の版、管理データの場所・版・件数・`quick_check` の結果、画面のサーバの待ち受け（127.0.0.1 だけ） |

- メニューには、Task 23 で使える画面だけを出す（ダッシュボード、Run、承認などは、その Task で足す）。
- コンセプトアートにある点数、予約、通知、利用者のアイコン、「AI が検出」は作らない（ロードマップにない）。
- 表示の語（モード、環境、認証の方式、状態のラベル）は `src/presentation/catalog.ts` に、文言は `src/presentation/messages.ts` に足す。画面の部品は、それを使って描くだけにする。
- キーボードだけで操作でき、状態と誤りが読める（ロードマップ 8.2）。

### 4.8 検証のスクリプト

| スクリプト | 内容 |
| --- | --- |
| `npm run verify` | 今のまま（型、全テスト、ビルド）。`src/control/store/` と `src/control/environment/` のテストを含む |
| `npm run build:ui` | 画面のビルド（`vite build`） |
| `npm run typecheck:ui` | 画面の型チェック（`build:ui` の後。生成される route の型を使うため） |
| `npm run test:ui` | 画面のサーバと画面のテスト（`apps/local-ui/tests/`。別の vitest の設定） |
| `npm run verify:ui` | `build:ui` → `typecheck:ui` → `test:ui` |
| `npm run verify:all` | `verify` → `verify:ui` |
| `npm run setup:local` | 4.6 |
| `npm run ui` | ビルドした画面を起動 |
| `npm run ui:dev` | 開発のサーバ |

## 5. SSOT と安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| プロファイルの型と検証 | `src/control/contracts.ts`、`profile-policy.ts`（Task 22） | 利用のみ。保存の前と更新のトランザクションの中で使う |
| 管理データの場所・開き方・書き込み | `src/control/store/`（新設） | 唯一の owner。ほかから `node:sqlite` を使わない（Gate） |
| 環境の確かめ | `src/control/environment/`（新設） | 唯一の owner |
| 設定の検証 | `src/config/load-config.ts`、`validate-config.ts` | 利用のみ（画面のサーバから。結果の表示） |
| 表示の語・書式・文言 | `src/presentation/` | 拡張（モードなどのラベル、管理データの誤りの説明、画面の文言） |
| スキーマの検証 | `src/core/schema-validator.ts`、`src/control/control-schema-validator.ts` | 利用のみ。Server Function の入力のスキーマを `schemas/control/` に足す |
| 公開監査（Guard、Run、出力） | 既存 | 変更なし。画面のサーバから import しない（Gate） |

- `src/**` に対象のサイト固有の情報を入れない。管理データ（`local-data/`）は Git の管理の外。
- 画面のサーバは外から到達できない（127.0.0.1、Host の確かめ、token、CSRF）。

## 6. 共通部品と共通仕様

| 区分 | 名前 | 置き場所 | 扱い |
| --- | --- | --- | --- |
| 利用する既存の部品 | `validateSiteProfile`、`assertProfileRevisionAdvance`、`validateControlDocument` | `src/control/` | 利用のみ |
| 利用する既存の部品 | 表示カタログ、書式、文言 | `src/presentation/` | 拡張 |
| 利用する既存の部品 | 設定の読み込みと検証 | `src/config/` | 利用のみ |
| 利用する既存の部品 | UTC の日時の書式、パスの安全な判定（`isPortableRelativeArtifactPath`） | `src/core/` | 利用のみ |
| 新しく作る共通部品 | 管理データの部品、環境の確かめ、起動の部品（Host・token・header・static） | `src/control/store/`、`src/control/environment/`、`apps/local-ui/launcher/` | 新設。台帳に追記 |

- 後続の Task で使う見込み: 管理データの部品は Task 24（Job、Run の管理）、Task 28（承認、件数の予約。原子的なトランザクション）で表を足す。起動の部品の保護は、Task 24 以降の Server Routes（成果物の配信）でも使う。
- 変更容易性: 表を足すときは、版の管理に版を 1 つ足すだけにする。モードや状態を足すときは、Task 22 の一覧と表示カタログだけを変える。

## 7. テスト設計

- **環境の確かめ**: Node の版が低い場合と `node:sqlite` がない場合（`--no-experimental-sqlite` の子 process で再現）に、理由の値と日本語の説明で止まる。CLI の `run` と `validate-config` が `node:sqlite` を読み込まない（子 process で確かめる）。下限の版が `engines` と一致する。
- **何もない状態からの準備**: フォルダがない、ファイルがない、0 byte、SQLite でないファイル（上書きしないことをハッシュで確かめる）、`application_id` が違う、`user_version` が新しい、`user_version` が 0 で表がある、読み取り専用、フォルダの位置にファイルがある、日本語と空白のパス、2 回目の実行（冪等）。
- **版の管理**: 途中で失敗する DDL が元に戻る（表も版も）。
- **書き込み**: プロファイルの作成・更新・取り消し、改訂の単調増加（同時に 2 つの process から更新して、片方だけが成功し、もう片方が改訂の不一致で拒否される）、不正なプロファイルは保存されない、履歴が残る。
- **落ちたとき**: 書き込みの途中で子 process を強制終了 → 開き直して `quick_check` が ok、途中の書き込みがない（名前つきの回数）。
- **Git の外**: `.gitignore` と場所の確かめ。
- **Architecture Gate**: `node:sqlite` の import は `src/control/store/` の中だけ。`apps/local-ui/` が import してよい範囲（4.2）。`BEGIN` の直書きの禁止。各 Gate は 1 秒以内。
- **画面のサーバ**（ビルドしたサーバを 127.0.0.1 の空き port で起動して確かめる）: 127.0.0.1 以外で待ち受けない、Host が違えば 421、token がなければ拒否、token から cookie への交換と URL からの token の除去、Server Function の CSRF（`Sec-Fetch-Site: cross-site`、Origin の不一致、両方なし）で 403、すべての応答の header、static のパスの外への拒否。
- **画面**（Playwright の headless の Chromium で、127.0.0.1 の画面のサーバだけを開く）: プロファイルの登録、一覧での表示、更新、取り消し、再起動後に残っている、誤りの表示、キーボードだけの操作。外部への通信がないこと（要求の記録で確かめる）。
- 既存の `npm run verify` の結果と所要時間が大きく変わらない（変更の前後で記録する）。

## 8. 対象ファイル

| パス | 責務 | 種類 |
| --- | --- | --- |
| `package.json`、`package-lock.json` | 依存、`engines`、スクリプト | 変更 |
| `.gitignore` | `/local-data/` | 変更 |
| `src/control/store/*` | 管理データ | 新規 |
| `src/control/environment/*` | 環境の確かめ | 新規 |
| `src/control/setup-local.ts`（入口） | `npm run setup:local` | 新規 |
| `schemas/control/*` | Server Function の入力のスキーマ | 新規 |
| `src/presentation/catalog.ts`、`messages.ts` | 表示の語と文言 | 変更 |
| `apps/local-ui/**` | 画面とサーバ | 新規 |
| `tests/unit/*`、`tests/integration/*`、`tests/architecture/*` | 部品と Gate のテスト | 新規・変更 |
| `doc/spec/local-setup.md`、`doc/spec/local-ui.md`、`doc/spec/README.md`、`README.md`（起動の手順を短く）、`doc/spec/development.md`（スクリプト） | 文書 | 新規・変更 |

## 9. 対象外

- 監査の実行、進捗、結果の表示（Task 24）。認証（Task 25 以降）。操作の候補、承認、書き込み（Task 27 以降）。
- データベースの初期化・作り直し・バックアップ・復元の自動化（ロードマップの非スコープ）。
- 複数の人の権限の管理、LAN や外部への公開。
- コンセプトアートにあってロードマップにない機能（点数、予約、通知、利用者のアイコン）。
- 電源断やネットワークドライブでの動作の保証（調査で未確認。手順書に、ローカルのディスクに置くよう書く）。

## 10. 完了条件（G23）

- [ ] ユーザーが依存パッケージの追加を承認し、版を固定した lockfile で入っている（`--ignore-scripts`）。
- [ ] 何もない状態（`local-data/` がない）から、手順書どおりに `npm run setup:local` と `npm run ui` で準備と起動ができる。足りないもの（Node の版、SQLite の機能、壊れたファイルなど）は、日本語の説明で止まる。
- [ ] 画面でプロファイルを登録・更新・取り消しでき、画面のサーバを起動し直しても残る。
- [ ] 127.0.0.1 以外で待ち受けない。Host の違い、token なし、不正な Origin、CSRF を拒否する。
- [ ] `npm run verify` と `npm run verify:all` が PASS。既存の公開監査の挙動が変わらない（golden の回帰が PASS）。
- [ ] 独立レビューで Critical 0 件、Important 0 件。
- [ ] 実サイトへの接続なし。認証と書き込みの機能は有効になっていない。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-09 | 初版（G22 の承認と、ユーザーの要件「SQLite が存在しない場合でも正しく環境設定と初期化ができる」。調査 2 件） | - | Task 23 |
| 2026-10-09 | Blocker: T23b（`vite.config.ts` が import する TanStack の Vite の plugin の型の宣言が、babel と unplugin の型を参照し、`skipLibCheck:false` で 16 件の誤り。すべて外部の `.d.ts`。画面のコード `src/**` だけなら今の厳しさで 0 件） | 型チェックを 2 つに分ける。画面のコード（`apps/local-ui/src/**`、`launcher/**`）は、今の厳しさ（`skipLibCheck:false` を含む）のまま。ビルドの設定のファイル（`vite.config.ts`）だけは、別の tsconfig（`tsconfig.config.json`）で `skipLibCheck:true` にする（外部の `.d.ts` の確かめだけを省く。`vite.config.ts` 自身は strict で確かめる）。`typecheck:ui` は両方を行う。依存は足さない（`@types/babel__*` は入れない）。生成のファイル `src/routeTree.gen.ts` を Git に入れるかは T23g で決める（`.gitignore` は T23a と T23g だけが変える） | T23b |
| 2026-10-09 | T23b の発見（開発のサーバの `fs.allow` がリポジトリの root。deny にない `package.json` などが `/@fs/` で配られる。起動の部品が中継の origin を `127.0.0.1` に固定しているので、`localhost` で開くと CSRF の Origin が合わない見込み） | T23e の範囲に加える: 開発のサーバの `fs.allow` を、画面が import してよい範囲（`apps/local-ui`、`src/control`、`src/presentation`、`src/config`、`src/core` のうち必要なもの、`node_modules`）に絞り、開発のサーバにも token の middleware を掛ける。画面の正式な URL は `http://127.0.0.1:<port>` だけにし、`localhost` の Host は 421 で拒否する（4.4 の「`localhost:<port>` も許す」を改める。Origin の不一致を作らないため） | T23e |
| 2026-10-09 | T23a の報告（発見事項 1、2、4、8） | (1) `node:sqlite` の読み込みは `src/control/store/sqlite-module.ts` の 1 か所だけにし、環境の確かめ（`src/control/environment/`）はそれを呼ぶ。(2) 4.3 の手順の順を「誰のデータベースかの確かめ（`application_id`、`user_version`、表の有無）→ WAL」に改める（WAL に切り替えるとファイルのヘッダが書き換わるので、ほかのプログラムのファイルを変えないため）。(3) 止める理由に `DATA_DIRECTORY_NOT_WRITABLE`、`DATABASE_WAL_UNAVAILABLE`、`DATABASE_OPEN_FAILED`（予備）を足す（15 個）。(4) 版 1 の移行はまだ公開していないので、T23c で版 1 に表を入れる（公開した後の移行は変えない）。(5) 生の接続（`ControlDatabase.connection`）を `src/control/store/` の外で使わないことを Gate で確かめ、書き込みの関数はすべて `withWriteTransaction` の中で行う（T23c） | T23a、T23c |
| 2026-10-09 | T23c の報告（発見事項 1、2、4） | (1) ターゲット設定のパスの形の確かめは、Task 22 の owner（`profile-policy.ts` の `isAcceptedTargetConfigPath`）を公開して使う。保存の部品は、文脈の解決（ファイルを読む呼び出し側の関数）を呼ぶ前に、この確かめを行い、通らないパスでは呼ばない。(2) 更新と取り消しの「前の改訂」は、保存されていた値なので、Task 22 の `assertProfileRevisionAdvance` の決まりどおり形（スキーマ）と行との一致だけを確かめ、今のターゲット設定での検証し直しはしない（設計者の指示書の誤りを正す。ターゲット設定が変わっても、正しい新しい改訂で更新でき、取り消しもできる）。更新の「次の改訂」は今のとおり `validateSiteProfile` を通す。(3) 取り消しの次の文書（改訂を 1 つ進めた写し）は、Task 22 の owner に新しい関数（例 `retiredRevisionOf`）を足して作る（改訂の数え方の owner を 1 つに保つ。返す値は `ValidatedSiteProfile` にしない＝実行に使えない）。(4) 取り消した `profileId` は使い直せない（履歴を保つ）。画面で、別の `profileId` で作るよう案内する | T23c round 1、T23f |
| 2026-10-09 | T23e の報告（発見事項 1、2、3、7） | (1) 守りの部品の唯一の owner は `apps/local-ui/launcher/request-guard.ts`（本番と開発のサーバで共用）。(2) **受け入れる危険**: cookie は port で分かれず、同じ PC の 127.0.0.1 のほかの port のサーバにも送られる（`__Host-` の接頭辞は https が要るので使えない）。ほかの port の画面からの Server Function は same-site として CSRF で 403 になる。同じ PC で動くほかのプログラムからの攻撃は、管理データのファイル（`local-data/`）を直接読めるので、もともと守りの範囲の外とし、`doc/spec/local-ui.md` に明記する。(3) Vite の内部の middleware の並びに依存して守りを先頭に置いている（テストで検出できる）。Vite の版を上げるときは、このテストを必ず通す。(4) `@tanstack/react-start/server` は、`skipLibCheck:false` で型の宣言の誤りが出るので、画面のコードから import しない（context で渡す）。(5) 拒否の応答の日本語の本文は、T23f で `src/presentation/messages.ts` に移す | T23e、T23f、T23g |
| 2026-10-09 | T23c round 2、T23d の報告と、T23f の準備の確かめ | (1) 止める理由は実際には 13 個（環境の 2 個を含む）。前の行の「15 個」は数え違いで、13 個が正しい。(2) `npm run setup:local` の失敗の終了コードは、既存の owner（`src/cli/exit-codes.ts`）の `FAILURE_EXIT_CODE`（1）を使う（`src/cli` は `src/control` を import しない Gate があり、循環しない）。(3) T23a の Gate (c) は、`node:sqlite` をモジュールとして指す形（中身がちょうど `node:sqlite` の文字列）だけを数え、利用者向けの文言は数えない。(4) 画面のサーバで設定の検証の結果を出すために `src/config/load-config.ts` を使うと、`validate-config.ts` を通して `src/safety/interaction-policy.ts`（`src/core` だけを import する純粋な決まりの一覧）に届く。画面の import の範囲の Gate（`local-ui-boundary.test.ts`）で、この 1 ファイルだけを例外として許し、そこから先に禁止の範囲がないことを Gate で確かめる | T23d、T23f |
| 2026-10-09 | T23R（独立レビュー。Important 1、Minor 5） | (1) 開発のサーバも、待ち受けを `127.0.0.1` に固定する（Vite の CLI の `--host` などで変えられたら起動を止める）。守りの部品は、要求を受けた socket の手元のアドレス（`localAddress`）が `127.0.0.1` であることも確かめる。(2) Gate の強化（小文字の SQL、関数の引数の分解、`Reflect.get` などでの生の接続の参照、`withWriteTransaction` の外の書き込み）。(3) 画面のサーバの起動の失敗（port の使用中、`--port` の誤り）を、`messages.ts` の日本語の説明にする。(4) README の依存の入れ方を `npm ci --ignore-scripts` に合わせる。(5) 画面のテストが、リポジトリの `node_modules/.vite` に書かないようにする。(6) 「今実行できるモード」の一覧は Task 24 で `src/control` の owner へ移す（Task 24 の設計に入れる） | T23h、T23c round 3 |
