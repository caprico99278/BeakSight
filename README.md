# BeakSight

BeakSightは、公開Webサイトを読み取り専用で自動巡回し、決定論的に検証可能な異常を検出して、後段の意味監査（例: ChatGPTへの手動アップロード）に必要な証跡を構造化データとして収集するツールです。

固定URL一覧・固定DOM selector・固定メニュー構造に依存したE2Eテストは、サイトが改修されるたびに保守負荷が高くなります。BeakSightはトップページを起点に同一Origin内の到達可能ページを自動発見し、人間が公開サイトを巡回して確認する作業のうち、機械的に判定できる範囲をPlaywrightで自動化します。自動側では意味的・美的な断定を行わず、パフォーマンス・アクセシビリティ・レイアウト・インタラクション等の証跡を出力することに専念します。

詳細な設計方針は [doc/design/](doc/design/) を参照してください。

## 現在の実装状況

- `validate-config` コマンド: 実装済み。設定ファイルの読み込み・検証を行います。
- `run` コマンド: 未実装（実行コーディネーターは未配線）。現時点では固定のエラーを返します。

## セットアップ

```bash
npm install
npx playwright install
```

Node.js `>=24 <25` が必要です（`package.json` の `engines` 参照）。

## npm スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run build` | TypeScriptをビルドし、`schemas/` を `dist/schemas` にコピー |
| `npm run typecheck` | 型チェックのみ実行（出力なし） |
| `npm test` | 全テストを実行 |
| `npm run test:unit` | 単体・コンポーネントテストのみ実行 |
| `npm run test:integration` | 結合テストのみ実行 |
| `npm run verify` | typecheck → test → build を順に実行 |

## 設定（ターゲットサイト）

監査対象サイトは `config/targets/` 配下のJSONファイルで指定します。

```json
{
  "target": { "id": "example" },
  "site": {
    "startUrl": "https://example.com/",
    "allowedOrigins": ["https://example.com"]
  }
}
```

- `--config <path>` を指定しない場合、`config/targets/` 配下（再帰的に）に `*.json` が**ちょうど1つ**だけ存在することが前提になります。複数、または0個の場合はエラーになります。
- `target.id` は必須かつ一意である必要があります（同一の `id` を持つ設定が複数見つかると起動時にエラーになります）。
- `config/targets/example.json` は、Gitで公開しても問題のない汎用的なサンプル設定です。

```bash
node dist/cli/index.js validate-config
node dist/cli/index.js validate-config --config config/targets/example.json --headed --output artifacts/example
```

## ローカル専用の設定（顧客を特定できる実際のターゲット設定）

顧客を特定できる実際のターゲット設定（実サイトのURLなど）は `config/targets/` には置かず、Git管理対象外の `local/` ディレクトリに置いてください。

```
local/targets/<対象名>.json
```

```bash
node dist/cli/index.js validate-config --config local/targets/<対象名>.json
```

`local/` 配下のファイルは `loadConfig()` の自動選択（`config/targets/` の走査）には一切含まれないため、常に `--config` で明示的に参照する必要があります。`.gitignore` により `local/` 配下は（このREADMEが置かれているリポジトリ直下のファイルを除き）Gitの追跡対象外です。

## アーカイブスクリプト

`tools/archive_beaksight.ps1` は、依存関係・生成物・テスト・フィクスチャ・ドキュメント・リポジトリメタデータ・エージェント作業ファイルを除いた本番用ソースのみのZIPを作成します。

```powershell
powershell -ExecutionPolicy Bypass -File tools/archive_beaksight.ps1
```

出力先は既定で環境変数 `BEAKSIGHT_ARCHIVE_OUTPUT_DIR`（未設定時はリポジトリと同じ階層の `BeakSight-archive` フォルダ）です。`-OutputDirectory` で明示的に指定することもできます。
