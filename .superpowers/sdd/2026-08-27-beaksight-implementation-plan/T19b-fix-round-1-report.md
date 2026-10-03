# T19b 修正の回 1 実装報告

## 結論
完了
RT19 の指摘 I-1、M-1〜M-7 の8件は、コードの行を開いて確かめ、すべて正しいと判断しました。8件とも `README.md` を直しました。README の URL は、例の値（`https://example.com/`、`https://example.com`）だけです。

## 変更したファイル
| パス | 変更の内容 |
| --- | --- |
| `README.md` | I-1、M-1〜M-7 の指摘の箇所だけを直した（下の表） |
| `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/T19b-fix-round-1-report.md` | この報告（新規） |

## 指摘ごとの対応と出どころ

| 指摘 | 判断 | README の変更（変更後の行） | 確かめた出どころ |
| --- | --- | --- | --- |
| I-1 | 正しい | 291 行に1項目を加えた。新しいウィンドウ（`window.open` や `target="_blank"` のリンク）で外部スキームを開こうとした場合は、headless でも `FRAME_CLASSIFICATION_FAILED` の違反になること、ブラウザの環境を閉じること、Run が `ABORTED_BY_SAFETY`（終了コード 3）になること、その理由（frame を判定できない）を書いた。headless を勧める記述（288 行）と、290 行の「headless では違反にしない」の本文は残した | `src/safety/passive-request-guard.ts:1882-1890`（`classifyMainFrame` が `undefined` なら Context を閉じる）、`src/safety/passive-request-guard.ts:663-675`（`FRAME_CLASSIFICATION_FAILED` を記録）、`src/core/status.ts:59-61`（違反が1件以上なら `ABORTED_BY_SAFETY`）、`doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2（106 行）と 4.2.1 の表（126 行） |
| M-1 | 正しい | 259-266 行。値は英数字のコードのままで、表示用の日本語のラベルは入れないこと。Finding の文言（日本語）はそのまま入ること。生の応答の本文は入れないこと。各ページの `page.json` に可視テキストと URL が入ること。アップロードの前に、渡してよい内容かを確かめるよう案内した | `src/report/chatgpt-bundle.ts:6-8,17-21`（`page.json` を読んだバイト列のまま入れる）、`src/audit/layout-rules.ts:200`（日本語の `message`）、`src/core/evidence-types.ts:422-426`（`VisibleTextEvidence.text`）、`src/core/contracts.ts:300`（`pageUrl`） |
| M-2 | 正しい | 148-149 行。BOM 付きの UTF-8（例: PowerShell 5.1 で `-Encoding UTF8` を付けて書いたファイル）は使えること。UTF-16 などの UTF-8 でないファイルは読めないことを書いた | `src/config/load-config.ts:62-69`（BOM を1つ除く）、`src/config/load-config.ts:74`（`readFile(path, 'utf8')`）、`src/config/load-config.ts:80`（`JSON.parse`） |
| M-3 | 正しい | 350 行。文字化けの条件を「`[Console]::OutputEncoding` が既定（コードページ 932）のままの場合」に絞った | `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md:856-857` |
| M-4 | 正しい | 8 行。「同じ Origin の中」を「許可した Origin（`site.allowedOrigins`）の中」にした | `src/crawl/admission-policy.ts:39-41` |
| M-5 | 正しい | 110 行。「Run 全体の実行時間の上限」を「実行時間の上限。この時間を過ぎたら、新しいページの監査を始めません（監査中のページは続けます）」にした | `src/orchestration/run-coordinator.ts:453`（経過時間の判定）、`src/orchestration/run-coordinator.ts:520-527`（新しいページを始める前だけ判定）、`src/orchestration/run-coordinator.ts:545`（超えたことの記録だけ） |
| M-6 | 正しい | 310 行。読み方の欄の末尾に「Run は `COMPLETE` になりません（`PARTIAL`）。」を加えた | `src/core/status.ts:79`（`input.safetyLedgerTruncated` なら `PARTIAL`） |
| M-7（前半） | 正しい | 146 行に1項目を加えた。`config/targets/` の中のすべての `*.json` を読むこと。どれか1つでも JSON として読めないか `target.id` がなければ、選んだ設定に誤りがなくても設定のエラーになること | `src/config/load-config.ts:124-135`（`verifyUniqueTargetIds` が全ファイルを `readTargetConfig` で読む）、`src/config/load-config.ts:78-89`（`CONFIG_JSON_INVALID`、`TARGET_ID_MISSING`）、`src/config/load-config.ts:149-151`（`--config` を省いた場合と `config/targets/` の中を指定した場合に行う） |
| M-7（後半） | 正しい | 246 行。「ページごとに、デスクトップのビューポートの監査の中で1回だけ行います」にした | `src/orchestration/page-auditor.ts:570-572`（ページの監査の中で、`profile === 'desktop'` のときだけ幅の走査を行う） |

- 文は、日本語の書き方の指針に沿って、1つの文に1つの内容で書きました。
- M-2 は、案の文に加えて、PowerShell の `Out-File` の既定の文字コードも書くことを考えました。この環境では確かめられないため、書きませんでした。

## TDDの記録
- README だけの変更なので、テストは書いていません。実行もしていません。
- 関連する検証:
  - `grep -noE 'https?://[^ )`"]*' README.md` → 79、91、92、133 行の `https://example.com/` と `https://example.com` だけ
  - `git diff README.md`（表示だけ）→ HEAD との差には前の回（T19b）の書き直しも含まれます。今回の変更は、上の表の9か所だけです（Edit で1か所ずつ置き換えました）。

## 受け入れ条件の確認
- [x] I-1、M-1〜M-7 のそれぞれについて、直したか、直さなかった理由が報告にある — 上の表のとおり。8件とも直しました。
- [x] `README.md` のほかの部分を変えていない — 指摘に対応する9か所だけを置き換えました。
- [x] README の中の URL が例の値だけである — 上の `grep` の結果で確かめました。

## 発見事項
なし

## 未実行項目
- テストと `npm run verify`: README だけの変更で、ブラウザを起動するテストはこの環境で実行できないため、実行していません。完了を妨げません。
- ブラウザを起動するコマンド: 指示により実行していません。I-1 の振る舞い（`window.open` の経路で `ABORTED_BY_SAFETY` になること）は、コードと設計書で確かめただけです（実際の実行では未確認）。
