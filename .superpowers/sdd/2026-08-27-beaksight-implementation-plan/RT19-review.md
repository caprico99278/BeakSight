# RT19 レビュー報告（README の独立の確認）

## 結論

README に、Critical の指摘はありません。Important は1件、Minor は7件です。
- 設計書 第5章の13項目は、すべてあります。載せないこと（実在のサイトの名前、URL、設定の中身）も守っています。
- オプション、終了コード、既定値、設定の探し方、出力のファイル名、Safety の記録の項目は、コードと一致しました。
- Important の1件は、headed の注意の節の「headless では違反にしない」という断定です。`window.open` の経路では、headless でも違反になります。コードとも設計書 4.2.1 とも食い違います。
- 利用者を危険な使い方へ導く記述はありません。

## 確かめ方

- コードを読んで照合しました。実装者の報告（T19b-report.md）の出どころは、鵜呑みにせず、行を開いて確かめました。
- ブラウザを起動しないコマンドを実行しました。
  - `node dist/cli/index.js --help`: 終了コード 0
  - `node dist/cli/index.js validate-config`: 終了コード 0
  - `node dist/cli/index.js validate-config --config config/targets/example.json`: 終了コード 0。表示は README 76-80 行と同じ
  - `validate-config --nope`、`validate-config --config`（値なし）、`validate-config extra`、`foo`、`validate-config --headed --headless`、コマンドなし、`--output a --output b`: どれも終了コード 4。`--output` の重複を除き、使い方も表示した（`--output` の重複は `head` で先頭だけを見た。コード上は使い方を表示する）
  - `foo --help`、`validate-config --headed --headless --help`: 終了コード 0（`--help` が優先される）
  - `validate-config --nope --help`: 終了コード 4（解析できない引数があると `--help` より誤りが優先される）
- `config/targets/` には `example.json` だけがあり、中身は例の値（`example`、`https://example.com/`）だけでした。
- 実行していないもの: `run`、テスト、ブラウザを起動するもの。このため、`report.html` の実際の見え方（幅の走査の Finding のビューポートの欄など）は、コードだけで確かめました（未確認）。Windows PowerShell の表示も、この環境では確かめられません。設計書の記述と照合しただけです。

## 指摘

### Important

#### I-1 「headless では違反にしない」は、`window.open` の経路と食い違う

- README: 284 行「そのため、headless では、移動の試みを Safety の記録（外部スキームへの移動の試み）に残すだけにします。違反にはしません。」（283 行と 326 行も、同じ前提で書かれている）
- コード: `src/safety/passive-request-guard.ts:1885-1890`、`src/safety/passive-request-guard.ts:663-675`（`classifyMainFrame`）
  - `window.open` による移動は、frame の種類を判定できません。この場合は、headless でも `FRAME_CLASSIFICATION_FAILED` の不変条件の違反を記録し、Context を閉じます。Run は `ABORTED_BY_SAFETY` になります。
  - 設計書 `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.2（106 行）と 4.2.1 の表（126 行。「`window.open`、`<a target=_blank>`: headless でも既存の違反」）も、同じ扱いです。
- 影響: headless の利用者の Run が、`FRAME_CLASSIFICATION_FAILED` で `ABORTED_BY_SAFETY` になることがあります。README を読んだ利用者は、その理由を README の中で見つけられません。危険な使い方に導くものではありません。
- 直し方の案: 284 行の後に、次の1項目を加える。
  - 「ただし、ページのスクリプトが新しいウィンドウ（`window.open` や `target="_blank"` のリンク）で外部スキームを開こうとした場合は、headless でも安全の不変条件の違反（`FRAME_CLASSIFICATION_FAILED`）になり、Run は `ABORTED_BY_SAFETY` になります。」

### Minor

#### M-1 ChatGPT 用のバンドルの値を「英数字のコードのまま」と言い切っている。また、可視テキストが入ることを書いていない

- README: 259-260 行「ページの HTML などの、生の応答の本文は含めません。」「バンドルの中の値は、英数字のコードのままです。日本語のラベルは入れません。」
- コード:
  - `src/report/chatgpt-bundle.ts:29-31`（`findingsView`）: `findings.json` は Finding をそのまま入れます。Finding の `message` は、Rule が作った日本語の文言です（例: `src/audit/layout-rules.ts:200`）。
  - `src/report/chatgpt-bundle.ts:6-8,21-22`: 各ページの `page.json` を、そのまま入れます。`page.json` の DOM の Evidence は、ページの可視テキストを持ちます（`src/core/evidence-types.ts:422-426`、`src/report/artifact-writer.ts:294`）。
  - 設計書 6.1.9 の意味は、「表示用の日本語のラベル（理由の説明など）を入れない」です。値がすべて英数字、という意味ではありません。
- 影響: 利用者は ChatGPT へ手動でアップロードします。何が外に出るかを正しく知る必要があります。
- 直し方の案: 259-260 行を次のようにする。
  - 「状態、理由、重大度などの値は、英数字のコードのままです。表示用の日本語のラベルは入れません。Finding の文言（日本語）は、そのまま入ります。」
  - 「ページの HTML などの、生の応答の本文は含めません。ただし、各ページの `page.json` には、ページの可視テキストと URL が入ります。アップロードする前に、扱ってよい内容かを確かめてください。」

#### M-2 BOM の説明で、PowerShell 5.1 で書いたファイルならどれでも読めるように書いている

- README: 147 行「Windows PowerShell 5.1 で書いたファイルも、そのまま使えます。」
- コード: `src/config/load-config.ts:62-69,74,80`。UTF-8 として読み、先頭の BOM を1つだけ除きます。
  - PowerShell 5.1 の `>` や `Out-File` は、既定で UTF-16 LE で書きます。`Set-Content` は、既定で ANSI（コードページ 932）で書きます。どちらも読めません（UTF-16 LE の場合は `CONFIG_JSON_INVALID`）。
  - 設計書 Task 14〜17 第7章の理由（「PowerShell 5.1 は、既定で BOM を付けて書く」）は、`-Encoding UTF8` を指定した場合の話です。
- 直し方の案: 「UTF-8 の BOM 付きのファイル（例: Windows PowerShell 5.1 で `-Encoding UTF8` を付けて書いたファイル）も、そのまま使えます。UTF-16 などの、UTF-8 でないファイルは読めません。」

#### M-3 PowerShell の文字化けの条件を、絞らずに書いている

- README: 343 行「Windows PowerShell 5.1 で、出力をパイプやリダイレクトに渡すと、文字化けします。」
- 出どころ: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` 856-858 行。文字化けするのは、`[Console]::OutputEncoding` が既定（コードページ 932）のままの場合だけです。
- 直し方の案: 「Windows PowerShell 5.1 で、出力をパイプやリダイレクトに渡すと、`[Console]::OutputEncoding` が既定（コードページ 932）のままの場合に、文字化けします。」

#### M-4 巡回の範囲を「同じ Origin の中」と書いている

- README: 8 行「開始の URL から、同じ Origin の中でたどれるページを自動で見つけます。」
- コード: `src/crawl/admission-policy.ts:40`。巡回に入れるのは、`site.allowedOrigins` の Origin のどれかに合う URL です。Origin は複数にできます（README 99 行の説明とも合わない）。
- 直し方の案: 「開始の URL から、許可した Origin（`site.allowedOrigins`）の中でたどれるページを自動で見つけます。」

#### M-5 `crawl.maxRuntimeMs` を、Run 全体の実行時間の上限と書いている

- README: 110 行「Run 全体の実行時間の上限」
- コード: `src/orchestration/run-coordinator.ts:453,519-525,545`。経過時間で止めるのは、新しいページを始める前だけです（545 行は、超えたことの記録だけ）。上限に達しても、監査中のページは続けます（そのページの期限まで）。その後の書き出しの時間も数えません。
- 直し方の案: 「この時間を過ぎたら、新しいページの監査を始めません（監査中のページは続けます）」

#### M-6 `recordTruncated` のときに `COMPLETE` にならないことを書いていない

- README: 303 行「記録が上限に達したか。達した場合、遮断した件数は下限です。」
- コード: `src/core/status.ts:79`（`input.safetyLedgerTruncated` なら `PARTIAL`）
- 直し方の案: 読み方の欄の末尾に「達した場合、Run は `COMPLETE` になりません（`PARTIAL`）。」を加える。

#### M-7 `config/targets/` の中の、選んでいない設定も読むことを書いていない。幅の走査の「1回だけ」の範囲が分かりにくい

- README 145 行: `--config` を省いた場合と、`config/targets/` の中を指定した場合は、`config/targets/` の中のすべての `*.json` を読みます（`src/config/load-config.ts:126-137,151-153`）。どれか1つでも JSON として読めないか、`target.id` がなければ、選んだ設定に誤りがなくても設定のエラーになります。
  - 直し方の案: 145 行に「このとき、`config/targets/` の中のすべての `*.json` を読みます。どれか1つでも JSON として読めないか、`target.id` がない場合も、設定のエラーになります。」を加える。
- README 244 行「幅の走査は、デスクトップのビューポートで1回だけ行います。」: Run で1回とも読めます。コード（`src/orchestration/page-auditor.ts:570-572`）では、ページごとに、デスクトップの監査の中で1回です。
  - 直し方の案: 「幅の走査は、ページごとに、デスクトップのビューポートの監査の中で1回だけ行います。」

## 観点ごとの確認の結果

### 1. 事実の記述とコードの照合

| README の記述（行） | 照合したコード | 結果 |
| --- | --- | --- |
| コマンド（37-40） | `src/cli/arguments.ts:17`、`src/cli/main.ts:46-53`、`--help` の出力 | 確認して問題なし。`validate-config` はブラウザを起動しない（`run-command.js` を読み込むのは `run` のときだけ） |
| オプション（44-50） | `src/cli/arguments.ts:24-30,119-123` | 確認して問題なし。`--headless` が `browser.headed: false` で上書きすることも確かめた |
| 同時の指定、重複、不正な引数、使い方の表示（52-55） | `src/cli/arguments.ts:80-117`、`src/cli/output.ts:52-57,105-111`、実行の結果 | 確認して問題なし |
| 既定の headless（56）、既定値の表（106-126） | `src/config/defaults.ts:3-37` | すべての値が一致した。110 行の意味は M-5 |
| 必須の項目と検証（85-100、128-129） | `src/config/validate-config.ts:92-123,131-147,161-184` | 確認して問題なし |
| `--config` を省いたときの扱い（141-147） | `src/config/load-config.ts:93-163` | 一致した。M-2 と M-7 を除く |
| `local/` と `artifacts/` は Git の管理の対象外（134、194） | `.gitignore` | 確認して問題なし |
| 終了コード（149-161） | `src/cli/exit-codes.ts:18-35`、`src/cli/main.ts:40-68`、`src/cli/run-command.ts:108-118` | 確認して問題なし。Run のディレクトリがすでにある場合の終了コード 1（193）も一致した |
| Run の ID（166） | `src/orchestration/run-id.ts:20-37` | 確認して問題なし（UTC の `RUN-YYYYMMDDHHmmss`） |
| 出力の構成とファイル名（168-188） | `src/core/artifact-layout.ts:24-76`、`src/orchestration/page-auditor.ts:1142-1158` | 確認して問題なし |
| UTF-8（BOM なし）と LF、スキーマの検証、`visible-text.txt`（190-192） | `src/report/artifact-writer.ts:1-12,65-80,294-301`、`src/core/status.ts:83` | 確認して問題なし |
| Run のディレクトリがある場合は監査を始めない（193） | `src/orchestration/run-coordinator.ts:374-396` | 確認して問題なし（PREFLIGHT もブラウザの起動も行わない） |
| CLI の表示（200-206） | `src/cli/output.ts:162-194` | 確認して問題なし |
| HTML レポートの節（212-221） | `src/presentation/catalog.ts:354-432`、`src/report/html-report.ts:306-315`、`src/report/html-components.ts:268-281` | 確認して問題なし |
| Run Status（225-230） | `src/core/status.ts:55-95`、`src/presentation/catalog.ts:113-138`、`src/orchestration/run-coordinator.ts:512-518` | 確認して問題なし |
| Finding と Evidence（234-237） | `src/presentation/catalog.ts`（重大度のラベル「エラー」「警告」「情報」「安全」）、`src/report/html-components.ts:404-418` | 確認して問題なし |
| 幅の走査の記録（241-247） | `src/orchestration/page-auditor.ts:570-606,1115-1118`、`src/audit/layout-rules.ts:109-121,190-202,209`、`src/report/html-components.ts:414-417`、`src/presentation/format.ts:31` | コードでは一致した（M-7 の言い回しを除く）。実際の `report.html` では未確認 |
| ChatGPT 用のバンドル（251-260） | `src/report/chatgpt-bundle.ts:1-22,29-31`、`src/core/limits.ts:204` | ファイルの一覧と 64 MiB は一致した。259-260 行は M-1 |
| 読み取り専用の保証の範囲（264-277） | `src/safety/request-policy.ts:28-72`、`src/browser/context-factory.ts:97`、`src/core/evidence-types.ts:1317-1327`、`src/safety/passive-request-guard.ts:1668-1773` | 確認して問題なし |
| headed の注意（281-288） | `src/safety/passive-request-guard.ts:1856-1904,1180-1190,1285-1307`、`src/orchestration/preflight.ts:170` | 283、285-288 行は一致した。284 行は I-1 |
| Safety Ledger の項目と表示（296-303） | `src/core/contracts.ts:376-394`、`src/report/html-report.ts:416-456`、`src/presentation/messages.ts:286-317` | 項目の名前と表示の名前は一致した。303 行は M-6 |
| Safety の記録の種類と表示の名前（310-322） | `src/core/evidence-types.ts:1813-1825`、`src/presentation/catalog.ts:270-339` | 11種類とも、名前、順、表示の名前が一致した |
| 外部スキームの理由（326-327） | `src/presentation/catalog.ts:331-338` | 確認して問題なし |
| RUM/APM（331-336） | `src/audit/performance-rules.ts:37-72`（重大度はすべて `WARN`）、`src/evidence/performance-collector.ts:62-66`、`src/presentation/messages.ts:16` | 確認して問題なし |
| npm のスクリプト（356-363） | `package.json` の `scripts` | 確認して問題なし |
| fixture の全体の監査のテスト（371-381） | `tests/integration/fixture-full-crawl.test.ts:1-13,137-145,181-184,256-257,270` | 確認して問題なし |
| アーカイブのスクリプト（385-394） | `tools/archive_beaksight.ps1:1-13,116-122` | 確認して問題なし |

### 2. 設計書 第5章の13項目と、載せないこと

- 13項目は、すべてあります。確認して問題なし。
  - 1 概要（1-13 行）、2 必要なもの（15-27）、3 使い方（29-80）、4 設定（82-147）、5 終了コード（149-161）、6 出力の構成（163-194）、7 結果の読み方（196-260）、8 読み取り専用の保証の範囲（262-277）、9 headed の注意（279-288）、10 Safety Ledger（290-327）、11 RUM/APM（329-336）、12 Windows PowerShell（338-350）、13 開発者向け（352-394）
- 載せないこと: 守っています。確認して問題なし。

### 3. 例の値

- README の URL は `https://example.com/` と `https://example.com` だけでした（79、91、92、133 行）。対象名は `example` と `<対象名>` だけでした。実在のサイトの名前や URL はありません。確認して問題なし。

### 4. 日本語

- 全体として、意味の通る文です。1つの文に1つの内容で書かれています。識別子はバッククォートで囲まれています。確認して問題なし。
- 事実の正確さに関わる言い回しは、M-3、M-5、M-7 に書きました。

### 5. 危険な使い方への誘導

- headed を勧める記述はありません。headless を既定とし、勧めています（56、70、281 行）。headed のオプションの説明（48 行）から、注意の節へのリンクがあります。どうしても headed で実行する場合の隔離の案内（288 行）もあります。
- ブラウザは `npx playwright install chromium` で Chromium だけを入れる案内です（19、23、367 行）。
- 実際の設定を `config/targets/` に置かない案内（134 行）があります。
- 確認して問題なし。
- 補足（指摘ではない）: 389 行の `-ExecutionPolicy Bypass` は、リポジトリの中の自分のスクリプトを1回だけ実行する形です。スクリプトの先頭のコメント（`tools/archive_beaksight.ps1:4`）とも同じです。
