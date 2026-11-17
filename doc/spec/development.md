# 開発者向け

BeakSight を開発する人のための、npm のスクリプト、ローカルでの検証の手順、Git に載せない語の検査、アーカイブのスクリプトです。

[README に戻る](../../README.md)・[仕様の索引](README.md)

## npm のスクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | `dist/` を消してから TypeScript をビルドし、`schemas/` を `dist/schemas` に写します（消した src のファイルの出力を `dist/` に残さないためです。管理画面のサーバや監査が動いている間は流さないでください）。 |
| `npm run typecheck` | 型チェックだけを行います（ファイルは出力しません）。 |
| `npm test` | ルートのテスト（`tests/` の unit・integration・heavy の project）を、既定の Chromium で 1 回ずつ実行します。画面のテストと CLI の回は含みません。 |
| `npm run test:unit` | 単体のテストと、部品のテスト（`tests/unit`、`tests/component`）を実行します。 |
| `npm run test:fast` | 単体の系（`tests/unit`、`tests/component`、`tests/architecture`）を実行します（「[テストの組](#テストの組)」）。 |
| `npm run test:integration` | 結合のテストのうち、重い組でないものを実行します。 |
| `npm run test:heavy` | 結合のテストのうち、重い組を実行します。 |
| `npm run test:safety` | 安全の一覧を既定の Chromium で実行し、続けて CLI の回の一覧を CLI の Chromium で実行します。 |
| `npm run test:full` | 全部の組（ルートの全部、CLI の回、画面のテスト）を順に実行します（`build` と `build:ui` の後）。 |
| `npm run verify` | `typecheck`、`build`、`build:ui`、`typecheck:ui`、`test:full` を順に実行します（全部を確かめます）。 |
| `npm run build:ui` | 管理画面をビルドします（`apps/local-ui/dist/`）。 |
| `npm run typecheck:ui` | 管理画面のコードの型チェックを行います（`build:ui` の後）。 |
| `npm run test:ui` | 管理画面とそのサーバのテスト（`apps/local-ui/tests/`）を実行します（`build:ui` と `build` の後。画面から動かす監査のテストは、監査の本体のビルドの出力 `dist/` を使います）。 |
| `npm run verify:ui` | `build:ui`、`typecheck:ui`、`test:ui` を順に実行します。 |
| `npm run verify:all` | `verify` と同じです（全部を確かめます）。 |
| `npm run ui` | 監査の本体（`build`。画面から動かす監査のワーカーが使う `dist/`）と管理画面（`build:ui`）を順にビルドしてから、管理画面を起動します（「[管理画面（ローカル）](local-ui.md)」）。`npm run ui -- --port 4400` で port を指定できます。 |
| `npm run ui:dev` | 管理画面の開発のサーバを起動します。 |
| `npm run setup:local` | ビルドしてから、管理データ（`local-data/beaksight-control.sqlite`）を準備します。何回実行してもよいです（「[管理データの準備](local-setup.md)」）。 |

## ローカルでの検証の手順

1. Chromium を入れます（初回だけ）: `npx playwright install chromium`
2. 全体を確かめます: `npm run verify`
3. fixture の全体の監査を確かめます:

```bash
npx vitest run tests/integration/control-audit-jobs-worker.test.ts
```

fixture の全体の監査のテスト（このファイルの最初の場面）は、次のことを行います。

- テスト用の fixture のサイト（`fixtures/site/full-crawl/`）を、ローカルのサーバで動かします。
- 画面と同じジョブの管理から、ビルドしたワーカーを別のプロセスで起動し、headless で最後まで監査します。
- 既定の設定で、Run が `COMPLETE` になることを確かめます。わざと壊した箇所ごとに期待した Finding が出ること、安全の不変条件の違反がないこと、サーバに届いたリクエストが `GET` と `HEAD` だけであることも確かめます。

テストは、Chromium を headless だけで起動します。実在の外部のサイトにはアクセスしません。

## テストの組

テストは、流す時に合わせて組に分けています。どのファイルがどの組かは、`tests/suites.ts` にだけ書いています（Vitest の設定と、組を流す部品 `tests/run-suite.mjs` は、そこから読みます）。ファイルを足したり分けたりしたときは、`tests/suites.ts` を直します。一覧のファイルが実在すること、一覧が重ならないこと、`tests/` のテストのファイルがどれも Vitest の project のちょうど 1 つに入ることは、Architecture Gate（`tests/architecture/test-suites.test.ts`）が確かめます。

| 組 | 中身 | いつ流すか |
| --- | --- | --- |
| `test:fast` | 単体の系（unit の project: `tests/unit`、`tests/component`、`tests/architecture`） | いつも（変更のたび） |
| `test:safety` | 安全の一覧（`SAFETY_TEST_FILES`。Guard・Context・中継・ブラウザ自身の通信の検査など 32 ファイル）を既定の Chromium で流し、続けて CLI の回の一覧（`CLI_CHROMIUM_TEST_FILES`）を CLI の Chromium で流します。2 つの Chromium の組は、両方の Chromium に広げます | 安全に関わる変更のとき |
| `test:integration` | 結合（`tests/integration`）のうち、重い組でないもの（integration の project） | 変えた所に関係するものを、ファイルを指定して流す |
| `test:heavy` | 結合のうち、重い組（`HEAVY_TEST_FILES`。heavy の project） | 全部の組の中で |
| `test:ui` | 画面とそのサーバのテスト（`apps/local-ui/tests/`。3 つのファイルを同時に流します） | 全部の組の中で。画面を変えたときは関係するファイルだけ |
| `test:full` | ルートの全部（unit・integration・heavy の project を既定の Chromium で 1 回ずつ）、CLI の回、`test:ui` を順に流します。どの回も、回数を重ねるテストを全部の回数で流します（`BEAKSIGHT_TEST_TIER=full`）。2 つの Chromium の組は、CLI の起動の設定の 1 つだけです | Task の区切り（`verify`・`verify:all` から） |

- 重い組の目安は、組み直しの前の測り（2026-10-24。15 並列の混雑の下）で、1 ファイルの時間（フックを含む）が 60 秒以上の結合のファイルです。安全の一覧のファイルは、重くても安全の組に入れます（重い組には入れません）。
- CLI の回の一覧は、安全の一覧のうち、テストの既定の Chromium で流すテストを、同じファイルの中で CLI の Chromium でも流していないものだけです。ほかの安全のファイルは、ファイルの中で両方の Chromium を流しているか、環境変数を読みません。
- ルートの Vitest は、unit の project を先に流し、そのあとに integration と heavy の project を一緒に流します（`sequence.groupOrder`）。単体の時間の検査と、ブラウザを使う結合が CPU を取り合わないようにするためです。結合の並列の数は `vitest.config.ts` の `INTEGRATION_MAX_WORKERS`（今は 6）です。
- 画面のテストは、`apps/local-ui/vitest.config.ts` の `UI_MAX_WORKERS`（今は 3）の数のファイルを同時に流します。どのファイルも、一時の root（管理データ、画面のサーバのロック、出力）をファイルごとに OS の一時のフォルダに作り、port は空きのもの（127.0.0.1 の 0 で得たもの）を使い、process の残りは自分が起動した画面のサーバの子孫だけを数えます。画面のテストを足すときも、この形にします（リポジトリの `local-data/`・`node_modules/.vite`・製品の既定の port 4317 を使いません）。
- 1 つのファイルだけを流すときは、組を選ばずに `npx vitest run <ファイル>` を使います（`--project` を付けると、その project に入っていないファイルは流れません）。
- `test:safety` と `test:full` は、途中の回が失敗しても残りの回を流し、終わりに回ごとの結果を出します。どれかが失敗すれば、終了コードは 1 です。中断（Ctrl+C）の後は、次の回を始めません。
- `test:safety` と `test:full` の後ろに付けた引数（`npm run test:safety -- --reporter=json --outputFile=out.json` など）は、どの回の Vitest にも渡します。`--outputFile` のファイルは、回ごとに名前を分けます（`out.safety-default.json`、`out.safety-cli.json`、`out.root.json`、`out.ui.json`）。
- 同じ場面を何回もくり返して確かめるテスト（ロックの取り合い、ポップアップと閉じる処理の競合など）の回数は、`tests/helpers/test-rounds.ts` にだけ書いています（テストのファイルは `roundsOf` で読みます）。場面ごとに、ふだんの組の値と全部の組の値を持ちます。全部の組の値は、減らす前の回数です（安全の確かめの強さは、全部の組では変わりません）。ふだんの組の値は、競合の場面を少なくとも 1 回は通る数で、止めた証拠の確かめはふだんの組でも行います。全部の組の値は `test:full` のときだけ使います（ファイルを 1 つだけ全部の回数で流すときは、`BEAKSIGHT_TEST_TIER=full` を付けます）。
- 大きなテストのファイルは、並列で流せるように分けています。分けたファイルの本文と共通の補助は、テストでないモジュール（`*-cases.ts`）に 1 つだけ置き、分けたテストのファイルは、そこが公開する登録の関数を呼びます（`isolated-interaction-cases.ts` と、それを流す `isolated-interaction-*.test.ts`）。テストの名前は、分ける前と同じです。
- Chromium（Playwright）の版を上げるときは、`node tests/run-suite.mjs chromium-upgrade` を流します。Chromium の振る舞いに依る「誤って違反・失敗にしない」確かめ（`tests/suites.ts` の `CHROMIUM_UPGRADE_TEST_FILES`）と安全の一覧を、両方の Chromium で流します。この束は、区切りの遅い組では流しません。
- 一時のビルド（ビルドした CLI やワーカーを子の process で動かす結合のテストが使う）は、1 回の Vitest で 1 回だけ作り、結合のテストで共有します（`tests/helpers/shared-temporary-build.ts` の `useSharedTemporaryBuild`。integration と heavy の project の `globalSetup`）。テストだけの入口は、`buildEntryPath` で名前を分けて置きます。ビルドの中身を書き換えるテストと、ビルドのパスで自分の起動したプロセスを見分けるテストは、共有せずに `buildIntoTemporaryDirectory` で自分のビルドを使います。
- 時間の検査は、並行の混雑で揺れない測り方にしています。純粋な計算の速さ（Architecture Gate の 1 ファイル 1 秒の上限 `MAX_GATE_MS`、単体のテストの名前つきの上限）は、壁時計ではなく CPU の時間（`tests/architecture/source-scan.ts` の `startCpuStopwatch`）で、検査の本体の直前から測ります。単体の系に壁時計の経過（`performance.now() - started` の形）を新しく書かないことは、Architecture Gate（`tests/architecture/wall-clock-speed-checks.test.ts`。タイマーの待ちを測るテストは理由つきの除外）が確かめます。タイマーの待ちを確かめる単体のテストのうち、混雑で揺れたもの（DEF-149 のワーカーの生きている合図）は、偽のタイマー（`vi.useFakeTimers`）で進めます。結合のテストで、確かめる判定に関わらない本番の期限が混雑で切れるときは、名前つきの混雑の倍率（`tests/helpers/loaded-deadline.ts` の `LOADED_DEADLINE_FACTOR`）を掛けた期限を注入します（本番の値は変えません）。

### 変えたファイルに関係するテストだけを流す

`node tests/run-suite.mjs related` は、変えたファイルに関係するテストだけを流します。選んだテストは、速い組（直すたびに流す）と遅い組（区切りに流す）に分けます。

```bash
node tests/run-suite.mjs related --list                 # 速い組と遅い組の一覧を出すだけ（流さない）
node tests/run-suite.mjs related                        # 速い組を流す
node tests/run-suite.mjs related --slow                 # 遅い組を流す（CLI の回を含む。2 つの Chromium の組は CLI の起動の設定の 1 つだけ）
node tests/run-suite.mjs related --both-chromium        # 遅い組を、2 つの Chromium の組を両方に広げて流す
node tests/run-suite.mjs related --with-safety          # 安全の一覧を必ず足して、遅い組を両方の Chromium に広げて流す
node tests/run-suite.mjs related src/core/deadline.ts   # 変えたファイルを指定する
```

| 段 | 組 | 流し方 |
| --- | --- | --- |
| 直すたび | 速い組 | `related`（変えたファイルに関係する速い組だけ） |
| 束の区切り | 遅い組（1 つの Chromium） | `related --slow`（束で変えたファイルの和から 1 回選ぶ） |
| Guard・中継・Chromium の起動の部品を変えた束の区切り、Chromium（Playwright）の版を上げるとき | 遅い組（両方の Chromium） | `related --both-chromium` |
| 安全の不具合の束の区切り | 遅い組と安全の一覧（両方の Chromium） | `related --with-safety`（安全の一覧を必ず足し、2 つの Chromium の組を両方に広げる） |
| ロードマップの区切り | 全部 | `npm run verify:all`（承認の後に 1 回） |

- Chromium: ファイルの中で 2 つの Chromium（テストの既定の headless shell と、CLI の起動の設定）で同じ場面を流す組は、入口 `tests/helpers/chromium.ts` の `chromiumRunsOf`（と `BOTH_CHROMIUM_LAUNCHERS`）から受け取ります。遅い組と区切りでは、CLI の起動の設定（本番）の 1 つだけで流します。両方に広げるのは、`--both-chromium`・`--with-safety` と `test:safety` だけです。1 回だけ流す場面は、受け取った組の先頭の回で流します。組を入口に通すことは、Architecture Gate が確かめます。
- 安全の不具合を直す束では、`--with-safety`（安全の一覧と両方の Chromium）を使います。安全の不具合の RED と GREEN は、両方の Chromium で確かめます（直したファイルは `--both-chromium` で流します）。
- 組: 遅い組は `tests/suites.ts` の `SLOW_TEST_FILES` です（一時のビルドの本番を子の process で動かすテスト、画面のサーバを起こすテスト、CLI の Chromium を起こすテスト、1 ファイルが 2 分を超えたテスト）。漏れの確かめの一覧（`BOTH_CHROMIUM_LEAK_CHECK_FILES`）は、その束で両方の Chromium に広げる一覧で、遅い組の一覧ではありません（載るファイルは、CLI の Chromium を起こすので遅い組に入ります）。ほかは速い組です（単体・部品・architecture、同じ process の中だけで済む 2 分以内の結合と画面のテスト）。CLI の回は遅い組の回です。一覧と構造の条件（`tests/architecture/test-group-criteria.ts`）が合うことは、Architecture Gate が確かめます。2 分を超えた結合を細くしたら、`SLOW_LONG_TEST_FILES` から外します。
- 変えたファイルは、引数で渡したファイルです。渡さなければ、Git の表示（`git diff --name-only HEAD` と、`git status --porcelain` の未追跡のファイル）から読みます。
- 台帳: 広く import される部品（`src/safety/redact.ts`・`src/core/contracts.ts`・`src/presentation/messages.ts` など）は、import をたどるとほぼ全部のテストが選ばれます。台帳（`tests/component-test-ledger.ts`）に載る部品を変えたときは、台帳の組だけを選びます。組には、部品の振る舞いを網羅する単体と、本番の通り道で使うことの代表の結合を書きます。
- ほかの変えたファイルは、テストのファイルの import のたどり（Vitest の `related`。ルートの設定と、画面のテストの設定のそれぞれ）で選びます。
- ビルドした本番（ワーカー・CLI・画面のサーバ）を子の process で動かすテストは、import からは見えません。テストのファイルに通る部品の印（`// covers: src/discovery/, src/control/job/` の 1 行）があれば、印の部品に入る変えたファイルがあるときに選びます。印がなければ、変えたファイルが本番の入口から import でたどれる（`tests/architecture/source-scan.ts` の `reachableFiles`）ときに選びます。
- 出力には、安全の一覧と漏れの確かめの一覧のファイルに印を付けます。CLI の回の一覧のファイルは、遅い組で CLI の Chromium の回でも流します。画面のテストを含むときは、先に `npm run build` と `npm run build:ui` が要ります。
- `--` で始まるほかの引数（`--reporter=verbose` のように、値を `=` でつなぐ）は、どの回の Vitest にも渡します。

### テストの環境変数

| 環境変数 | 意味 |
| --- | --- |
| `BEAKSIGHT_TEST_DEFAULT_CHROMIUM` | `cli` のとき、テストの既定の Chromium（`tests/helpers/chromium.ts` の `launchHeadlessChromium`）を、CLI と同じ起動の設定に替えます（どちらも headless）。`test:safety` と `test:full` の CLI の回は、起動の部品がこの値を渡します。既定の Chromium の回では、呼び出した側に値があっても外します。ほかの値と省略は、テストの既定の headless shell です。 |

| `BEAKSIGHT_TEST_BOTH_CHROMIUM` | `both` のとき、2 つの Chromium の組（`tests/helpers/chromium.ts` の `chromiumRunsOf`）を、両方の Chromium に広げます。`test:safety` と `related --with-safety`・`--both-chromium` は、起動の部品がどの回にもこの値を渡します。ほかの回では、呼び出した側に値があっても外します。ほかの値と省略は、CLI の起動の設定の 1 つだけです（ファイルを 1 つだけ両方で流すときは、`BEAKSIGHT_TEST_BOTH_CHROMIUM=both` を付けます）。 |

| `BEAKSIGHT_TEST_TIER` | `full` のとき、同じ場面を何回もくり返して確かめるテストを、全部の組の回数（`tests/helpers/test-rounds.ts` の `full`）で流します。`test:full` は、起動の部品がどの回にもこの値を渡します。ほかの値と省略は、ふだんの組の回数（`regular`）です。 |

環境変数は、npm の scripts の中では書きません（Git Bash と PowerShell で書き方が違うため）。起動の部品 `tests/run-suite.mjs` が、子のプロセスに渡します。環境変数の名前と値は、`tests/helpers/test-run-environment.ts` にだけ書いています（ほかのファイルに書き写さないことは、Architecture Gate が確かめます）。

## Git に載せない語の検査

監査の対象のサイトの名前や、そのサイトの画面の名前・資源の path・欄の名前などは、Git に載るファイルに書きません。GitHub に届く前に止めるため、伏せる語の一覧を使う検査を 3 か所に置いています。どれも、共通の部品 `tools/secret-terms/scan.mjs`（Node の標準だけ）で判定します。

| 検査 | いつ止めるか | 場所 |
| --- | --- | --- |
| Claude Code のフック | Claude Code が Git に載るファイルを書く前（`Write`・`Edit`・`MultiEdit`・`NotebookEdit`、Desktop Commander の `write_file`・`edit_block`） | `.claude/hooks/block-secret-terms.mjs`（`.claude/settings.json` の `PreToolUse`） |
| Git の pre-commit | コミットのとき（コミットする中身の、追加・変更したファイル） | `.githooks/pre-commit` |
| Git の pre-push | push のとき（送るコミットのそれぞれで変わったファイル） | `.githooks/pre-push` |

### 有効にする

Git のフックは、clone ごとに 1 回、次の命令で有効にします（Claude Code のフックは `.claude/settings.json` にあるので、設定は要りません）。

```bash
git config core.hooksPath .githooks
```

### 一覧の置き場所と形

- 置き場所: `local/secret-terms.txt`（`local/` は Git の外です。この PC にだけ置きます）。
- 1 行に 1 語を書きます。`#` で始まる行と空の行は飛ばします。前後の空白は取ります。
- 大文字と小文字は区別しない、ただの部分一致です（正規表現ではありません）。日本語の語も書けます。
- 文字コードは UTF-8（BOM があってもよい）、改行は CRLF でも LF でもかまいません。
- 一覧がないとき（クラウドやほかの PC の clone）は、何も止めません（Git のフックは、標準エラーに 1 行の注意を出します）。

例（架空の語）:

```text
# 伏せる語の一覧
zzforbiddenzz
禁止の語の例
```

### 止まったときの直し方

当たったときは、ファイルの path・行の番号・当たった語の番号（一覧の何行目か）だけを出します。語そのものは、端末やログに残さないため出しません。

```text
secret-terms: doc/spec/example.md:12: 伏せる語の一覧の 3 行目の語が含まれています
secret-terms: Git に載せない語です。一般の形（登録の画面、/rest/v1/<x> など）で書き直してください（語の中身は local/secret-terms.txt で確かめます）。
```

1. 一覧（`local/secret-terms.txt`）の、出た番号の行を見て、どの語かを確かめます。
2. 出た path と行で、その語を一般の形（「登録の画面」、`/rest/v1/<x>` など）に書き直します。
3. コミットで止まったときは、直したファイルを `git add` し直してから、もう一度コミットします。
4. push で止まったときは、出たコミット（`（コミット <sha>）`）に語が入っています。後のコミットで直しても、そのコミットが送る中に残るので止まります。語の入ったコミットを直して（`git rebase -i` など）から push します。

終了コードは、当たらなければ 0、当たれば 1、Git の失敗などで調べられなければ 2 です（1 と 2 は、どちらもコミットと push を止めます）。手で調べるときは、`node tools/secret-terms/scan.mjs --staged`（コミットする中身）、`--push <ローカルの sha> <リモートの sha>`（送るコミット）、`--text <path>`（標準入力の文字列。`<path>` は表示だけ）を使います。一覧の場所は、環境変数 `BEAKSIGHT_SECRET_TERMS_FILE` で変えられます（テスト用）。

### 限界

- 一覧にない語は止められません。新しく伏せる語ができたら、一覧に足します。
- Claude Code のフックが調べるのは、上の道具で書く文字列だけです（`Edit` は `new_string` だけ）。Bash や PowerShell などで書いたファイルは、書くときには止まらず、コミットのとき（pre-commit）に止まります。
- Claude Code のフックは、Git に載らない path（`git check-ignore` で無視されるもの、リポジトリの外）を調べません。
- Git のフックは、`--no-verify` を付けたコミットと push では流れません。付けないでください。

## アーカイブのスクリプト

`tools/archive_beaksight.ps1` は、本番用のソースだけの ZIP を作ります。
依存パッケージ、生成物、テスト、fixture、ドキュメント、リポジトリのメタデータ、エージェントの作業ファイルは、含めません。

```powershell
powershell -ExecutionPolicy Bypass -File tools/archive_beaksight.ps1
```

出力先の既定は、環境変数 `BEAKSIGHT_ARCHIVE_OUTPUT_DIR` の値です。
設定していない場合は、リポジトリと同じ階層の `BeakSight-archive` フォルダです。
`-OutputDirectory` で指定することもできます。
