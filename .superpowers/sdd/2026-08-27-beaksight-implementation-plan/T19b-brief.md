# T19b 指示書: README の書き直し

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T19b
- 目的: 利用者向けの `README.md` を、今の実装に合わせて日本語で書き直す。
- 設計書: `doc/design/2026-09-25-beaksight-task-19-fixture-full-crawl-readme-design.md` の **第5章**（載せること13項目と、載せないこと）
- 実装計画: `doc/design/2026-09-25-beaksight-task-19-fixture-full-crawl-readme-implementation-plan.md` の T19b
- 関係する設計書:
  - `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第7章（終了コード、`--help`、PowerShell の案内、オプションの重複）
  - `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2、4.2.1、4.3、4.5（外部スキーム、headed の制約、違反の後に監査を続けないこと）
  - `doc/design/2026-08-27-beaksight-web-audit-design.md`（読み取り専用の保証、Safety Ledger、RUM/APM の扱い）
- 前のサブタスクの報告: 作業記録置き場の `T19a-report.md`（全体の監査の結果と、発見事項3）
- 日本語の書き方: `.claude/skills/beaksight-dev/references/japanese-writing-guide.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。このサブタスクは、ほかの実装者と並行ではありません。

## 作業

1. 今の `README.md` を読み、活かせる部分（冒頭の概要など）と、古い部分（「`run` コマンド: 未実装」など）を分ける。
2. 設計書 第5章の13項目を、この順を目安に書く。**書く事実は、すべてコードで確かめる。** 確かめた出どころ（ファイル:行）を、報告に一覧で書く。
   - オプションと使い方: `src/cli/arguments.ts`、`src/cli/main.ts`、`--help` の実際の出力
   - 終了コード: `src/cli/exit-codes.ts`
   - 出力の構成とファイルの名前: `src/core/artifact-layout.ts`、`src/report/artifact-writer.ts`。できれば、fixture の全体の監査（`tests/integration/fixture-full-crawl.test.ts`）で実際に書かれたファイルの一覧で確かめる
   - 既定の設定の値（出力先、ビューポート、上限など、README に書くもの）: `src/config/defaults.ts`
   - 設定の探し方（`--config` を省いたとき）: `src/config/` の読み込みの処理
   - Safety の記録の項目: `src/core/evidence-types.ts` の `SAFETY_EVENT_KINDS` と、表示の名前（`src/presentation/catalog.ts`）
3. 次のことを、必ず書く。
   - **headed での実行の注意**（設計書 第5章の9）: ページのスクリプトによる外部スキーム（`mailto:`、`tel:` など）への移動は、止められないこと。headed では外部のアプリ（メールや電話のアプリ）が起動しうること。その場合は、安全の違反として記録し、Run が `ABORTED_BY_SAFETY` になること。サーバのリダイレクトによる外部スキームへの移動は止めること。headless を勧めること。
   - **幅の走査の結果の記録**（T19a の発見事項3）: 幅の走査（例: 幅 320、768、1024）で見つかったはみ出しは、Desktop の Evidence に含めて記録されること。レポートでの見え方を、実際の出力で確かめて説明する。
   - **Windows PowerShell の日本語の表示**: パイプやリダイレクトの前に `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` を実行すること。結果は UTF-8 の `report.html` と JSON でも見られること。
   - **ローカルでの検証の手順**: `npm run verify`、fixture の全体の監査のテスト（`npx vitest run tests/integration/fixture-full-crawl.test.ts`）。
   - **Playwright の Chromium**: `npx playwright install chromium` で Chromium だけを入れること（ほかのブラウザは使わない）。
4. 例の値には、実在のサイトを使わない（`https://example.com/` のような例の値を使う）。実在の監査対象のサイトの名前、URL、設定の中身を書かない。`config/targets/example.json` の中身を書き写す場合は、今のファイルの中身が例の値だけであることを確かめる。
5. 文は、日本語の書き方の指針に従う（結論を先に、1つの文に1つの内容、英単語を助詞でつなぐだけの文を書かない）。コードの識別子、ファイル名、コマンド、状態の値、理由のコードは、英数字のままにする。

## 確かめ方

- README のコマンドの例を、実際に実行して確かめる（`node dist/cli/index.js --help`、`validate-config` など。ブラウザを起動する `run` は、fixture の全体の監査のテストの結果で代えてよい）。
- 実行する場合は、Chromium を headless だけで起動する。`run` を実行する場合は、必ず `--headless` を付け、fixture のサーバだけを対象にする。
- ビルドが必要な場合は `npm run build` を実行してよい。

## 変えてよいファイル

- `README.md`
- 上に無いファイルを変える必要が出たら（コードと README の食い違いが見つかった場合など）、変えずに発見事項として報告する。README を実装に合わせられない場合は、Blocker として止まる。

## 受け入れ条件

- 設計書 第5章の13項目を、すべて含む。載せないことを守っている。
- 書いた事実の出どころ（ファイル:行）を、報告に一覧で示している。
- コマンドの例を実行して確かめた結果を、報告に示している。
- `npm run verify` が PASS する（README の変更でテストは変わらないが、全体を確かめる）。

## 厳守事項

- **Chromium は headless だけで起動する。** headed（`--headed` や `headless: false`）で起動してはいけない。
- 本来の監査対象のサイトを含む、実在の外部のサイトにアクセスしない。`config/targets/` と `local/` の実サイトの設定を使わない（`config/targets/example.json` は、例の値だけであることを確かめてから、読むだけにする）。
- `git commit`、`git push`、HEAD に戻す操作は禁止。
- 依存パッケージを追加・更新しない。ブラウザをインストールしない。
- Blocker に当たったら、回避策を自分で考えずに止まり、報告する。

## 報告

共通ルールの形式で、日本語で報告してください。README の章立て、事実の出どころの一覧、コマンドの確かめの結果、見つかった食い違いを入れてください。
