# 開発者向け

BeakSight を開発する人のための、npm のスクリプト、ローカルでの検証の手順、アーカイブのスクリプトです。

[README に戻る](../../README.md)・[仕様の索引](README.md)

## npm のスクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | TypeScript をビルドし、`schemas/` を `dist/schemas` に写します。 |
| `npm run typecheck` | 型チェックだけを行います（ファイルは出力しません）。 |
| `npm test` | すべてのテストを実行します。 |
| `npm run test:unit` | 単体のテストと、部品のテスト（`tests/unit`、`tests/component`）を実行します。 |
| `npm run test:integration` | 結合のテスト（`tests/integration`）を実行します。 |
| `npm run verify` | `typecheck`、`test`、`build` を順に実行します。 |
| `npm run build:ui` | 管理画面をビルドします（`apps/local-ui/dist/`）。 |
| `npm run typecheck:ui` | 管理画面のコードの型チェックを行います（`build:ui` の後）。 |
| `npm run test:ui` | 管理画面とそのサーバのテスト（`apps/local-ui/tests/`）を実行します（`build:ui` と `build` の後。画面から動かす監査のテストは、監査の本体のビルドの出力 `dist/` を使います）。 |
| `npm run verify:ui` | `build:ui`、`typecheck:ui`、`test:ui` を順に実行します。 |
| `npm run verify:all` | `verify` と `verify:ui` を順に実行します。 |
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

## アーカイブのスクリプト

`tools/archive_beaksight.ps1` は、本番用のソースだけの ZIP を作ります。
依存パッケージ、生成物、テスト、fixture、ドキュメント、リポジトリのメタデータ、エージェントの作業ファイルは、含めません。

```powershell
powershell -ExecutionPolicy Bypass -File tools/archive_beaksight.ps1
```

出力先の既定は、環境変数 `BEAKSIGHT_ARCHIVE_OUTPUT_DIR` の値です。
設定していない場合は、リポジトリと同じ階層の `BeakSight-archive` フォルダです。
`-OutputDirectory` で指定することもできます。
