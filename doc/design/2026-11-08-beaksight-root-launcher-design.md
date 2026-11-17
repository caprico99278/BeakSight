# BeakSight リポジトリ直下の起動ファイル 設計書

- 日付: 2026-11-08
- 状態: ユーザーの依頼（2026-11-08）による。形は設計者が決めた（下の 3）。
- 関係する文書: `doc/spec/local-ui.md`（`npm run ui` の決まり）、`doc/spec/getting-started.md`、`README.md`

## 1. 目的

今は `npm run ui` で起動する。今後、起動のオプションの設定や、ライブラリのバージョンの確かめを足す見込みがある。そのための入口を、今のうちにリポジトリ直下に用意する。

ユーザーの依頼（2026-11-08、言葉どおり）: 「現在はnpm run uiで起動できるが、今後はオプション設定起動やライブラリのバージョンチェッカーを導入するなどの必要が出てくる可能性がある。今のうちにリポジトリ直下に起動ファイルを作成しておいてほしい」

## 2. 今の起動

- `npm run ui` = `npm run build && npm run build:ui && node apps/local-ui/launcher/serve.ts`。
- `serve.ts` が、管理データの準備（`setup:local` と同じ）、同時に 1 つだけの確かめ、port の確かめ（既定 4317、`--port`）、待ち受け、ブラウザを開くことを行う。
- `package.json` の `engines` に Node の版の決まりがある。

## 3. 採用する形

1. **起動の本体は 1 つの Node のスクリプト**（`tools/launcher/start.mjs`）。起動の前の確かめと、オプションの受け取りは、すべてここに置く。今後の機能（オプションの設定、バージョンの確かめ）も、ここに足す。
2. **リポジトリ直下の起動ファイル**は、本体を呼ぶだけの薄いもの。
   - `BeakSight.cmd`（Windows。ダブルクリックで起動できる）。自分の置き場所（`%~dp0`）へ移ってから本体を呼ぶ。誤りで止まったとき（終了コードが 0 でない）だけ、窓がすぐ閉じないよう、キーを押すまで待つ。正常に終わったとき（管理画面のブラウザを閉じて画面のサーバが止まったとき、Ctrl+C の止め方で止まったとき。どちらも終了コード 0）は、待たずに終わる。ダブルクリックで開いた窓は、そのまま閉じる（2026-11-08 ユーザーの依頼「ブラウザを閉じたら、バッチジョブも停止するようにして」）。
   - `beaksight.sh`（macOS・Linux 用。`bash beaksight.sh` で起動）。自分の置き場所へ移ってから本体を呼ぶ。
   - どちらも、受けた引数をそのまま本体へ渡す（例: `BeakSight.cmd --port 4400`）。
3. **起動の流れ**（2026-11-08 改訂。ユーザーの依頼「バージョンを満たさないか、node_modulesが存在しない場合は自動アップデート、自動インストールするようにしてほしい」と、判断「BeakSight 専用に置く (推奨)」）:
   1. **Node の用意（起動ファイルの側。Node がなくても動く必要があるため）:**
      - PATH の `node` が `package.json` の `engines.node` を満たせば、それを使う。
      - 満たさない（または `node` がない）ときは、BeakSight 専用の Node を使う。置き場所は `local/runtime/`（Git の外）。すでに条件を満たす版が置いてあれば、それを使う。
      - なければ、nodejs.org の公式の一覧（`https://nodejs.org/dist/index.json`）から、条件を満たすいちばん新しい版を選び、公式の配布物（Windows は `win-x64` の zip、macOS・Linux は該当の tar）と `SHASUMS256.txt` を取ってくる。SHA-256 が合わなければ使わずに止める。取ってくる先は nodejs.org だけ（https）。展開して `local/runtime/node-v<版>-<環境>/` に置く。
      - 以後の処理は、その Node を PATH の先頭に置いて動かす（`npm` も同じ Node のものを使う）。PC 全体の Node と PATH の設定は変えない。
      - Windows は PowerShell のスクリプト（`tools/launcher/bootstrap.ps1`）で行い、`BeakSight.cmd` が呼ぶ。macOS・Linux は `beaksight.sh` の中で、`curl`・`tar`・`shasum`（か `sha256sum`）で行う。
   2. **依存の用意（本体 `tools/launcher/start.mjs`）:** `node_modules` がないか、前に入れたときと `package-lock.json`（の SHA-256）か Node の版が違うときは、`npm ci` で入れ直す。入れたときの記録（lockfile の SHA-256 と Node の版）は `local/runtime/` に置く。`npm ci` が失敗したら、短い説明を出して止まる（終了コード 1）。
   3. `npm run ui -- <受けた引数>` を子のプロセスで動かし、標準入出力をそのまま引き継ぐ。子の終了コードを、そのまま自分の終了コードにする。Ctrl+C は子へ届き、子の止め方（`serve.ts` の決まり）に任せる。
   4. ネットワークにつながらない、取ってこられない、展開できないときは、何が足りないかと、手で入れる方法を短く出して止まる。
   5. **Playwright の Chromium の用意（本体。2026-11-08 ユーザーの依頼「Playwright の Chromium も自動で用意するようにして」）:** 依存を用意した後、BeakSight が使う Chromium（CLI と画面の監査が使う `channel: 'chromium'` のもの。テストの既定の headless shell も同じ命令で入る）が、今の `node_modules` の Playwright の版のものとして置いてあるかを確かめる。確かめ方は、Playwright の API が返す実行ファイルの path があるか。なければ、`node_modules` の Playwright の CLI で `install chromium` を動かす（`npx` で別の版を取ってこない）。Playwright の版が変わって（`npm ci` の後など）実行ファイルが見つからないときも、同じく入れる。入れる先は Playwright の既定の置き場所（利用者のフォルダの `ms-playwright`）で、PC の設定は変えない。取ってくる先は Playwright の公式の配布の場所（Playwright が決める）。失敗したら、短い説明と手で入れる命令を出して止まる。`install-deps`（OS の部品を入れる、管理者の権限が要る）は動かさない。
4. `npm run ui` は、今のまま残す（文書と既存の使い方を壊さない）。
5. 利用者向けの文は日本語で短く、技術の語を減らす。文は本体の 1 か所に置く。

## 4. 変えないもの

- `npm run ui` の中身と、`serve.ts` の決まり（同時に 1 つ、port、ブラウザを閉じたら止まる、管理データの準備）。
- 依存（新しいパッケージは足さない）。

## 5. 今後の足し方（予定。今回は作らない）

- 起動のオプションの設定: 本体で、設定のファイル（たとえば `local/launch.json`。Git の外）を読み、`--port` などの引数に直して渡す。
- ライブラリの個々の版の細かい確かめ（今は lockfile の SHA-256 の違いで `npm ci` し直す）。

## 6. テスト

- 本体の純粋な部分（版の比べ、`index.json` からの版の選び方、SHA-256 の照合、入れ直すかの判定、引数の受け渡し、説明の文）を単体で確かめる。テストではネットワークに出ない（`index.json` と `SHASUMS256.txt` は小さな fixture で代える）。
- `npm ci` を実際に動かすテストと、実際に画面のサーバを起動するテストは作らない。子のプロセスの呼び出しは差し替えて確かめる。
- 実際のダウンロードと展開は、ユーザーが起動ファイルを動かして確かめる。
- `BeakSight.cmd`・`beaksight.sh` は、本体を呼ぶ 1 行と、置き場所へ移ること、引数を渡すことを、文字列の検査で確かめる（Gate の速さの決まり: 1 秒以内、ブラウザや子のプロセスを起動しない）。

## 7. 文書

- `README.md` の起動手順に、`BeakSight.cmd`（ダブルクリック）を足す。`npm run ui` も使えると書く。
- `doc/spec/local-ui.md` の起動の節に、起動ファイルと本体の役目、引数の渡し方を書く。

## 8. 設計変更履歴

| 日付 | 理由 | 内容 | 影響 |
| --- | --- | --- | --- |
| 2026-11-08 | ユーザーの依頼 | 新規作成 | 起動の手順・文書 |
| 2026-11-08 | ユーザーの依頼（自動アップデート・自動インストール）と判断（BeakSight 専用に置く） | 3 を改訂: Node が足りなければ公式の Node 24 を `local/runtime/` に取ってきて使う、依存は `npm ci` で自動で入れる | 起動の手順・文書・ネットワーク（nodejs.org と npm の登録所） |
| 2026-11-08 | ユーザーの依頼「ブラウザを閉じたら、バッチジョブも停止するようにして」 | 3 の 2: `BeakSight.cmd` は終了コードが 0 のときは待たずに終わり、0 でないときだけキーを待つ | 起動の手順 |
| 2026-11-08 | ユーザーの依頼「Playwright の Chromium も自動で用意するようにして」 | 3 の 5 を改訂: Chromium がなければ、node_modules の Playwright の CLI で `install chromium` | 起動の手順・ネットワーク（Playwright の配布の場所） |
