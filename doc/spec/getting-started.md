# 導入（最初の監査まで）

BeakSight を何もない状態から使い始め、最初の公開の監査を終えるまでの手順です。
3 つのモードを通して使う順は「[通しの使い方](end-to-end-usage.md)」にあります。

[README に戻る](../../README.md)・[仕様の索引](README.md)

## 必要なもの

| もの | 内容 |
| --- | --- |
| Node.js | 24.15.0 以上の 24 系（`package.json` の `engines` は `>=24.15.0 <25`）。SQLite は Node.js に組み込まれているので、別に入れません（「[管理データの準備](local-setup.md)」）。 |
| 依存のパッケージ | リポジトリの `package-lock.json` の版のまま入れます。 |
| Playwright の Chromium | 監査に使います。Chromium だけを使います。 |
| Windows | BeakSight が Windows を求めるのは、自動ログイン（`AUTOMATED_LOGIN`）だけです。資格情報を Windows の暗号化（DPAPI）で保存するためです（「[自動ログインの手順](automated-login.md)」）。 |
| ローカルのディスク | 管理データ（`local-data/`）は、ローカルのディスクに置きます。ネットワークのドライブや同期のフォルダでの動作は確かめていません。 |

- Windows 以外の OS で、管理画面と、認証つきの監査と書き込みを通して動かすことは、確かめていません。

## 初期設定

リポジトリの直下で、上から順に行います。

```powershell
node -v
npm ci --ignore-scripts
npx playwright install chromium
npm run build
```

- `node -v` が `v24.15.0` 以上であることを確かめます。
- `npm ci --ignore-scripts` は、固定した版のまま、install の script を動かさずに依存を入れます。
- `npx playwright install chromium` は、監査に使う Chromium を入れます。BeakSight は headless でも、この通常の Chromium を使います（「[headless で使うブラウザ](cli.md#headless-で使うブラウザ)」）。
- `npm run build` は、CLI と監査のワーカー（`dist/`）をビルドします。

管理画面を使うときは、続けて管理データを準備します。

```powershell
npm run setup:local
```

- 成功すると「管理データの準備ができました。」と表示し、終了コード 0 で終えます。止まったときの理由と手順は「[困ったとき](local-setup.md#困ったとき)」にあります。
- `npm run ui` も起動の初めに同じ準備を行うので、`setup:local` を省いても、正しく準備してから起動します。

## 最初の監査（CLI）

CLI は、公開の監査（`PUBLIC_PASSIVE`）だけを行います。

1. 監査の対象の設定のファイルを作ります。顧客を特定できる実際の設定は、Git の管理の外の `local/targets/<対象名>.json` に置きます（「[`config/targets/` と `local/` の使い分け](configuration.md#configtargets-と-local-の使い分け)」）。書き方は「[監査の対象の設定](configuration.md)」にあります。
2. サイトへの負荷を決めます。読み込みの間隔（`crawl.minNavigationIntervalMs`。既定 5 秒）と、ページの上限（`crawl.maxPages`。既定 500）を、サイトの運営者と決めた値にします（「[サイトへの負荷](site-load.md)」）。最初は、ページの上限を小さくして始めることを勧めます。
3. 設定を確かめます。監査は行わず、ブラウザも起動しません。

   ```powershell
   node dist/cli/index.js validate-config --config local/targets/<対象名>.json
   ```

4. 監査します（headless を勧めます）。

   ```powershell
   node dist/cli/index.js run --config local/targets/<対象名>.json --headless --output artifacts
   ```

5. 結果を見ます。出力先の `RUN-YYYYMMDDHHmmss` のディレクトリの `report.html` をブラウザで開きます（「[出力と結果の読み方](output.md)」）。終了コードの意味は「[終了コード](cli.md#終了コード)」にあります。

- Ctrl+C を 1 回押すと、今のページの監査を終えてから止まります。同じコマンドを実行すると、続きから再開します（「[中断と再開](resume.md)」）。

## 最初の監査（管理画面）

1. 画面を起動します。

   ```powershell
   npm run ui
   ```

2. コンソールに出た `http://127.0.0.1:4317/?token=…` の URL をブラウザで開きます。URL の `token` は起動ごとの合言葉なので、ほかの人に渡しません（「[画面の起動](local-ui.md#画面の起動)」）。
3. 左のメニューの「新しいプロファイル」で、公開の監査のプロファイルを作ります。

   | 項目 | 値 |
   | --- | --- |
   | 名前（profileId） | 小文字の英数字とハイフン（例: `example-public`）。保存した後は変えられません。 |
   | 設定のファイル | `config/targets/` か `local/targets/` の中の JSON。選ぶと、その場で設定の誤りを確かめます。 |
   | 環境 | 公開（本番）（`PUBLIC`） |
   | 監査モード | 公開の監査（読むだけ）（`PUBLIC_PASSIVE`） |
   | 認証の方式 | ログインしない（`NONE`） |

   画面の選択肢には、日本語の名前だけが出ます（括弧の中はコードの値です）。

4. 「サイトとプロファイル」の一覧の、そのプロファイルの行の「最後の Run」の列にある「監査を始める」を押し（プロファイルの詳細の画面にはありません）、開始の画面で設定の要点（開始の URL、ページの上限、時間の上限、ページの読み込みの間隔）を確かめて、「監査を始める」を押します。
5. 監査のジョブの画面で、進み具合と結果を見ます。終わった後は、HTML レポートを開き、`run.json`・`audit.json`・ChatGPT 用のバンドルを落とせます（「[監査の実行](local-ui.md#監査の実行)」）。

- 画面から設定の値（間隔と上限）は変えられません。変えるときは、設定のファイルを直します。
- 監査は、画面全体で同時に 1 つだけです。

## 次に読むもの

- 3 つのモードを通して使う: 「[通しの使い方](end-to-end-usage.md)」
- 成果物を ChatGPT などの外へ渡す前に: 「[成果物を外へ渡す前の確かめ](anonymization.md)」
- 守りの範囲と、未解決の不具合: 「[読み取り専用と安全](safety.md)」、「[リスクと監査の記録](risks-and-audit-logs.md)」
