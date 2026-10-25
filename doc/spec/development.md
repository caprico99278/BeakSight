# 開発者向け

BeakSight を開発する人のための、npm のスクリプト、ローカルでの検証の手順、アーカイブのスクリプトです。

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
npx vitest run tests/integration/fixture-full-crawl.test.ts
```

fixture の全体の監査のテストは、次のことを行います。

- テスト用の fixture のサイト（`fixtures/site/full-crawl/`）を、ローカルのサーバで動かします。
- ビルドした CLI を別のプロセスで起動し、`--headless` で最後まで監査します。
- 既定の設定で、Run が `COMPLETE` になることを確かめます。わざと壊した箇所ごとに期待した Finding が出ること、安全の不変条件の違反がないこと、サーバに届いたリクエストが `GET` と `HEAD` だけであることも確かめます。

テストは、Chromium を headless だけで起動します。実在の外部のサイトにはアクセスしません。

## テストの組

テストは、流す時に合わせて組に分けています。どのファイルがどの組かは、`tests/suites.ts` にだけ書いています（Vitest の設定と、組を流す部品 `tests/run-suite.mjs` は、そこから読みます）。ファイルを足したり分けたりしたときは、`tests/suites.ts` を直します。一覧のファイルが実在すること、一覧が重ならないこと、`tests/` のテストのファイルがどれも Vitest の project のちょうど 1 つに入ることは、Architecture Gate（`tests/architecture/test-suites.test.ts`）が確かめます。

| 組 | 中身 | いつ流すか |
| --- | --- | --- |
| `test:fast` | 単体の系（unit の project: `tests/unit`、`tests/component`、`tests/architecture`） | いつも（変更のたび） |
| `test:safety` | 安全の一覧（`SAFETY_TEST_FILES`。Guard・Context・中継・ブラウザ自身の通信の検査など 32 ファイル）を既定の Chromium で流し、続けて CLI の回の一覧（`CLI_CHROMIUM_TEST_FILES`）を CLI の Chromium で流します | 安全に関わる変更のとき |
| `test:integration` | 結合（`tests/integration`）のうち、重い組でないもの（integration の project） | 変えた所に関係するものを、ファイルを指定して流す |
| `test:heavy` | 結合のうち、重い組（`HEAVY_TEST_FILES`。heavy の project） | 全部の組の中で |
| `test:ui` | 画面とそのサーバのテスト（`apps/local-ui/tests/`。3 つのファイルを同時に流します） | 全部の組の中で。画面を変えたときは関係するファイルだけ |
| `test:full` | ルートの全部（unit・integration・heavy の project を既定の Chromium で 1 回ずつ）、CLI の回、`test:ui` を順に流します。どの回も、回数を重ねるテストを全部の回数で流します（`BEAKSIGHT_TEST_TIER=full`） | Task の区切り（`verify`・`verify:all` から） |

- 重い組の目安は、組み直しの前の測り（2026-10-24。15 並列の混雑の下）で、1 ファイルの時間（フックを含む）が 60 秒以上の結合のファイルです。安全の一覧のファイルは、重くても安全の組に入れます（重い組には入れません）。
- CLI の回の一覧は、安全の一覧のうち、テストの既定の Chromium で流すテストを、同じファイルの中で CLI の Chromium でも流していないものだけです。ほかの安全のファイルは、ファイルの中で両方の Chromium を流しているか、環境変数を読みません。
- ルートの Vitest は、unit の project を先に流し、そのあとに integration と heavy の project を一緒に流します（`sequence.groupOrder`）。単体の時間の検査と、ブラウザを使う結合が CPU を取り合わないようにするためです。結合の並列の数は `vitest.config.ts` の `INTEGRATION_MAX_WORKERS`（今は 6）です。
- 画面のテストは、`apps/local-ui/vitest.config.ts` の `UI_MAX_WORKERS`（今は 3）の数のファイルを同時に流します。どのファイルも、一時の root（管理データ、画面のサーバのロック、出力）をファイルごとに OS の一時のフォルダに作り、port は空きのもの（127.0.0.1 の 0 で得たもの）を使い、process の残りは自分が起動した画面のサーバの子孫だけを数えます。画面のテストを足すときも、この形にします（リポジトリの `local-data/`・`node_modules/.vite`・製品の既定の port 4317 を使いません）。
- 1 つのファイルだけを流すときは、組を選ばずに `npx vitest run <ファイル>` を使います（`--project` を付けると、その project に入っていないファイルは流れません）。
- `test:safety` と `test:full` は、途中の回が失敗しても残りの回を流し、終わりに回ごとの結果を出します。どれかが失敗すれば、終了コードは 1 です。中断（Ctrl+C）の後は、次の回を始めません。
- `test:safety` と `test:full` の後ろに付けた引数（`npm run test:safety -- --reporter=json --outputFile=out.json` など）は、どの回の Vitest にも渡します。`--outputFile` のファイルは、回ごとに名前を分けます（`out.safety-default.json`、`out.safety-cli.json`、`out.root.json`、`out.ui.json`）。
- 同じ場面を何回もくり返して確かめるテスト（ロックの取り合い、ポップアップと閉じる処理の競合など）の回数は、`tests/helpers/test-rounds.ts` にだけ書いています（テストのファイルは `roundsOf` で読みます）。場面ごとに、ふだんの組の値と全部の組の値を持ちます。全部の組の値は、減らす前の回数です（安全の確かめの強さは、全部の組では変わりません）。ふだんの組の値は、競合の場面を少なくとも 1 回は通る数で、止めた証拠の確かめはふだんの組でも行います。全部の組の値は `test:full` のときだけ使います（ファイルを 1 つだけ全部の回数で流すときは、`BEAKSIGHT_TEST_TIER=full` を付けます）。
- 大きなテストのファイルは、並列で流せるように分けています。分けたファイルの本文と共通の補助は、テストでないモジュール（`*-cases.ts`）に 1 つだけ置き、分けたテストのファイルは、そこが公開する登録の関数を呼びます（`isolated-interaction-cases.ts` と、それを流す `isolated-interaction-*.test.ts` の 4 つ。`stage-chain-fork-cases.ts` と、Run の Browser ごとの `stage-chain-fork-default.test.ts`・`stage-chain-fork-cli.test.ts`）。テストの名前は、分ける前と同じです。
- 時間の検査は、並行の混雑で揺れない測り方にしています。純粋な計算の速さ（Architecture Gate の 1 ファイル 1 秒の上限 `MAX_GATE_MS`、単体のテストの名前つきの上限）は、壁時計ではなく CPU の時間（`tests/architecture/source-scan.ts` の `startCpuStopwatch`）で、検査の本体の直前から測ります。単体の系に壁時計の経過（`performance.now() - started` の形）を新しく書かないことは、Architecture Gate（`tests/architecture/wall-clock-speed-checks.test.ts`。タイマーの待ちを測るテストは理由つきの除外）が確かめます。タイマーの待ちを確かめる単体のテストのうち、混雑で揺れたもの（DEF-149 のワーカーの生きている合図）は、偽のタイマー（`vi.useFakeTimers`）で進めます。結合のテストで、確かめる判定に関わらない本番の期限が混雑で切れるときは、名前つきの混雑の倍率（`tests/helpers/loaded-deadline.ts` の `LOADED_DEADLINE_FACTOR`）を掛けた期限を注入します（本番の値は変えません）。

### テストの環境変数

| 環境変数 | 意味 |
| --- | --- |
| `BEAKSIGHT_TEST_DEFAULT_CHROMIUM` | `cli` のとき、テストの既定の Chromium（`tests/helpers/chromium.ts` の `launchHeadlessChromium`）を、CLI と同じ起動の設定に替えます（どちらも headless）。`test:safety` と `test:full` の CLI の回は、起動の部品がこの値を渡します。既定の Chromium の回では、呼び出した側に値があっても外します。ほかの値と省略は、テストの既定の headless shell です。 |

| `BEAKSIGHT_TEST_TIER` | `full` のとき、同じ場面を何回もくり返して確かめるテストを、全部の組の回数（`tests/helpers/test-rounds.ts` の `full`）で流します。`test:full` は、起動の部品がどの回にもこの値を渡します。ほかの値と省略は、ふだんの組の回数（`regular`）です。 |

環境変数は、npm の scripts の中では書きません（Git Bash と PowerShell で書き方が違うため）。起動の部品 `tests/run-suite.mjs` が、子のプロセスに渡します。環境変数の名前と値は、`tests/helpers/test-run-environment.ts` にだけ書いています（ほかのファイルに書き写さないことは、Architecture Gate が確かめます）。

## アーカイブのスクリプト

`tools/archive_beaksight.ps1` は、本番用のソースだけの ZIP を作ります。
依存パッケージ、生成物、テスト、fixture、ドキュメント、リポジトリのメタデータ、エージェントの作業ファイルは、含めません。

```powershell
powershell -ExecutionPolicy Bypass -File tools/archive_beaksight.ps1
```

出力先の既定は、環境変数 `BEAKSIGHT_ARCHIVE_OUTPUT_DIR` の値です。
設定していない場合は、リポジトリと同じ階層の `BeakSight-archive` フォルダです。
`-OutputDirectory` で指定することもできます。
