# Task 20 の実行の手順書（ユーザーの Windows の PC で行う）

- 作成: 2026-10-01 設計者（クラウドのセッション）
- 根拠: 実装計画 `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 20、実装タスク指示 `doc/design/2026-08-27-beaksight-implementation-tasks.md` の第11章（Acceptance Gates）
- 読み替え:
  - 実装計画の対象 URL は、ユーザーの指示（2026-09）により、デモのサイト `https://demo.playwright.dev/todomvc/` にする。
  - 本来の監査対象のサイトには接続しない（Task 21 は、完成とユーザーの明示の承認の後）。
  - 実装計画の Step 6 の `git add` と `git commit` は行わない（スキル第8章の読み替え）。結果は、この手順書の末尾の形式で `progress.md` に記録する。

## 0. 実行の前に知っておくこと（headed の制約）

- headed では、ブラウザの画面を表示して実行する。
- ページのスクリプトが外部スキーム（`mailto:`、`tel:` など）へ移動しようとした場合、BeakSight はその移動を止められない。headed では、メールや電話のアプリが起動する可能性がある。
- その場合、BeakSight は違反（`EXTERNAL_SCHEME_NAVIGATION_IN_HEADED_MODE`）を記録してブラウザの環境を閉じ、Run は `ABORTED_BY_SAFETY`（終了コード 3）になる。起動そのものは防げない。
- 危険を下げるため、`mailto:` と `tel:` の既定のアプリがない環境（仮想マシンなど）での実行を勧める。
- 実行中は、表示されたブラウザを手で操作しない。

## 1. 事前の Gate（1つでも FAIL なら、デモのサイトに接続しない）

PowerShell で、リポジトリのディレクトリ（作業ブランチ `feature/20260923-01-epn0gb` を取り込んだもの）で実行する。

```powershell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
npm run verify
npx vitest run tests/integration/safety-gates.test.ts tests/integration/auditor-gates.test.ts tests/architecture
```

- 期待: `verify` は 101 ファイル、3,661 件の PASS、型チェックとビルドの PASS。Gate のテストも、すべて PASS。
- DEF-015（vitest のワーカーの異常終了）が起きた場合は、ファイルを記録し、同じコマンドを1回だけ実行し直す。2回目も失敗したら、止めて設計者に渡す。
- DEF-019 の fixture（`layout-single-line-headings.html`）の結果が Windows でも PASS するかを、特に見る。

## 2. smoke 専用の設定を、リポジトリの外に作る

標準の設定（`config/targets/example.json`）は変えない。設定は `config/targets/` の中に置かない（`--config` を省いたときの探索の対象になるため）。出力もリポジトリの外に置く。

```powershell
$smokeDir = Join-Path $env:TEMP 'beaksight-task20'
New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
@'
{
  "target": { "id": "task20-todomvc-smoke" },
  "site": {
    "startUrl": "https://demo.playwright.dev/todomvc/",
    "allowedOrigins": ["https://demo.playwright.dev"]
  },
  "crawl": { "maxPages": 5 },
  "browser": { "headed": true },
  "output": { "directory": "OUTPUT_DIR" }
}
'@.Replace('OUTPUT_DIR', ($smokeDir -replace '\\', '/') + '/output') | Set-Content -Encoding UTF8 -Path (Join-Path $smokeDir 'todomvc-smoke.json')
node dist/cli/index.js validate-config --config (Join-Path $smokeDir 'todomvc-smoke.json')
```

- `Set-Content -Encoding UTF8` は BOM 付きの UTF-8 で書く。BeakSight は先頭の BOM を1つ取り除いて読む（README「`--config` を省いたときの扱い」）。`-Encoding` を省くと UTF-8 にならず、読めない。
- `validate-config` が終了コード 0 になることを確かめる。
- 並行の数の設定の項目はない。Run Coordinator は、ページを1つずつ処理する（`src/orchestration/run-coordinator.ts` の 513 行からのループ）。

## 3. headed で smoke を実行する

```powershell
node dist/cli/index.js run --config (Join-Path $smokeDir 'todomvc-smoke.json') --headed
$LASTEXITCODE
```

- 終了コードを記録する（0: COMPLETE、1: FAILED、2: PARTIAL、3: ABORTED_BY_SAFETY、4: CONFIG_ERROR）。
- 外部のアプリが起動した場合は、その事実（何が起動したか）を記録する。その時点で smoke は FAIL とし、Task 21 には進まない。

## 4. 結果の確かめ（`$smokeDir\output\RUN-<時刻>\`）

`run.json` の `safety`（Safety Ledger の要約）で、次を確かめる。

| 項目 | 期待 |
| --- | --- |
| `guardEnabled` | `true` |
| `invariantViolationCount` | `0`（`invariantViolations` は空） |
| `recordTruncated` | `false` |
| `blockedRequestsByMethod` | GET と HEAD 以外があっても失敗ではない。止めた記録であることと、Run の状態が正直に `PARTIAL` などになっていることを確かめる |

あわせて、次を確かめる。

- フォームの入力と送信をしていない。外部のアプリが起動していない。
- `run.json`、`audit.json`、各ページの `page.json` がある（スキーマで検証してから書かれる。合わなければ `COMPLETE` にならない）。
- 監査したページの数が 5 以下で、上限に達した場合は `MAX_PAGES_REACHED` の SKIPPED がある。
- `report.html` を開き、次を目視で確かめる（Task 19 の未実行項目）。
  - 日本語の表示が崩れていない。
  - 幅の走査（320、768、1024 など）で見つかったはみ出しの Finding が、ビューポートの欄「デスクトップ」で、文言の先頭に幅が付いて出ている（あれば）。
- DEF-016 の判断のため、HTTP の 4xx のページがあれば、その本文の種類（HTML か text/plain か）と、出た文書の構造の Finding を記録する。

## 5. smoke の判定

- PASS: Run が `COMPLETE`、またはサイトの事情で確認できなかった部分を正直に `PARTIAL` と報告している。かつ、安全の不変条件の違反が 0、必要な出力がそろっている。
- FAIL: 安全の不変条件の違反が1件でもある、外部のアプリが起動した、必要な出力がない、のどれか。FAIL の場合は、ただちに止め、Task 21 に進まない。

## 6. 記録（設計者に渡すもの）

次を、会話に貼るか `progress.md` に追記する（出力のファイルそのものは Git に入れない。スクリーンショットとページの可視テキストを含むため）。

```text
- Gate: verify <件数と結果>、Gate のテスト <結果>、DEF-015 <起きた/起きない>
- smoke: 終了コード <n>、Run Status <値>、監査したページ <n>、SKIPPED <n>（理由）
- Safety: guardEnabled <値>、invariantViolationCount <n>、recordTruncated <値>、blockedRequestsByMethod <値>
- 外部のアプリの起動: <なし/あり（内容）>
- report.html の目視: 日本語 <可否>、幅の走査の Finding の表示 <内容>
- DEF-016 の材料: 4xx のページ <URL のパスと本文の種類と Finding>
- 判定: PASS / FAIL
```
