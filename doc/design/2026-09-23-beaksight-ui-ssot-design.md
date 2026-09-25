# BeakSight 表示の共通化とSSOT 追補設計書

作成日: 2026-09-23
状態: ユーザー承認済み（2026-09-23。表示言語、表示用ownerの追加、自動検査の導入について承認）
対象範囲: HTMLレポート、CLI出力、ChatGPT用バンドル、利用者向けメッセージの、表示言語・担当モジュール・自動検査

## 1. 目的

BeakSightには、同じRunの結果を利用者に見せる表示面が3つあります。HTMLレポート（Task 16）、CLIの出力（Task 17）、ChatGPT用バンドル（Task 16）です。
現在の設計書と実装計画は、それぞれの表示面が何を出すかは定めています。一方で、表示面どうしで共有すべき集計、ラベル、色、書式、文言を、どこに1つだけ置くかは定めていません。

このままTask 16とTask 17を実装すると、件数の集計、Severityの呼び方や色、理由の説明文が表示面ごとに作られる可能性が高くなります。そうなると、表示面によって内容が食い違い、ラベル1つの変更にも複数箇所の修正が必要になります。

この追補設計書は、次の3点を定めます。

1. 表示言語を日本語にする。
2. 表示に関わる共通の意味について、担当モジュール（owner）を追加する。
3. 2の構造が崩れていないことを、速く動く自動検査で確かめる。

この設計で目指す状態は次のとおりです。

> 新しいRule、category、severity、状態、理由を1つ追加するとき、変更が必要なのは、その定義を持つカタログと、その値を生み出す処理だけである。各表示面の描画コードは変更しなくてよい。

## 2. 根拠となる文書と優先順位

- 従う文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（以下「実装タスク指示」）
  - `doc/design/2026-08-27-beaksight-implementation-plan.md`（以下「実装計画」）
  - `doc/design/2026-08-27-beaksight-web-audit-design.md`（以下「設計書」）
- この追補設計書が拡張する箇所:
  - 実装タスク指示 第5章「SSOT Owner Matrix」に、第4章の表の行を追加する。既存の行は変更しない。
  - 実装タスク指示 第10章「Architecture Gates」に、第6章のUI Gateを追加する。
  - 実装計画 Task 16 と Task 17 のファイル構成に、第4章のファイルを追加する。
- 引き続き守る不変条件:
  - Reporterは監査判定を行わない（実装タスク指示 第8章、設計書 5.1）。
  - canonical ownerが生成したmodelを後続の処理で再利用する（実装タスク指示 4.3）。
  - URLの正規化と受け入れ判定は `normalizeUrl` と `classifyUrl` だけが行う（ARCH04）。
  - Finding fingerprint、Run Status、Rule登録、Schema検証、最終的なartifactの書き出しのownerは変わらない。
  - HTMLレポートは静的HTMLで、SPAフレームワークを使わない（実装計画 Task 16）。
  - 依存パッケージを追加しない。

## 3. 表示言語

### 3.1 決定事項

利用者に見せる文は、すべて日本語にします。

| 対象 | 言語 |
| --- | --- |
| HTMLレポートの見出し、ラベル、説明文 | 日本語。`<html lang="ja">` とする |
| CLIの標準出力と標準エラー（使い方、設定エラー、実行結果の要約） | 日本語 |
| Findingの `message` | 日本語。文言はRule定義が持つ |
| 未完了・スキップ・ブロック・観測不能などの理由の説明文 | 日本語 |
| ChatGPT用バンドルの `summary.json` などに含まれる、人が読むための説明文 | 日本語 |

次のものは、言語にかかわらず英数字のままにします。これらは機械が読む識別子であり、翻訳すると後段の処理や比較が壊れるためです。

- JSONのキー、`schemaVersion` の値
- `ruleId`、`evidenceId`、`findingId`、`pageId`、`runId`、fingerprint
- Severity、Run Status、各種Statusの値（`ERROR`、`COMPLETE` など）と理由コード
- ファイル名とディレクトリ名

表示面では、これらの値そのものではなく、第4章の表示カタログにある日本語のラベルを表示します。値そのものは、コピーや検索のために併記してかまいません。

### 3.2 既存の英語の文言の扱い

既存コードには英語の文言があります（例: `src/cli/index.ts` の `configuration valid`、`src/config/validate-config.ts` の検証エラー、`src/interaction/isolated-auditor.ts` の理由文）。

- 利用者に直接表示される文言（CLIの出力、設定エラー）は、Task 17で日本語の文言カタログに置き換えます。
- 内部の例外メッセージと、Evidenceに記録される理由文は、この追補設計書だけを根拠に書き換えません。これらは、表示する時点で理由コードを経由して日本語の説明文に変換します。理由コードそのものの整理は、共通化候補 CC-009 と CC-010 として保留中で、ユーザーの開発指示を待ちます。

### 3.3 Windowsでの文字化け

CLIは日本語を標準出力に書きます。Windows PowerShellでは、コンソールの文字コードの設定によって、UTF-8の日本語が文字化けすることがあります。
Task 17では、Windows PowerShellで日本語の出力が読めることを確認する手順を検証に含めてください。文字化けする場合の対処（出力側で行うか、利用者の環境設定として案内するか）は、Task 17の設計で決めます。

## 4. 追加するowner

実装タスク指示 第5章の表に、次の行を追加します。

| Semantic | Owner | 責務 |
| --- | --- | --- |
| 表示用語彙（ラベル、表示順、色トークン名、説明） | `src/presentation/catalog.ts` | Severity、Run Status、Page Audit Status、Interaction Status、Finding category、Viewport、Evidenceの種類について、日本語のラベルと表示のしかたを定義する。値の意味は定義しない |
| 表示用の書式 | `src/presentation/format.ts` | 日時（`Asia/Tokyo`）、時間、データ量、指標値、件数、割合の表示書式。観測できなかった値の表示（「未観測」） |
| 利用者向けの文言 | `src/presentation/messages.ts` | 理由コードから日本語の説明文への変換、CLIの文言、設定エラーの文言 |
| 表示用モデルと表示用の集計 | `src/report/view-model.ts` | 確定したRunから表示用モデルを1回だけ組み立てる。Severity別の件数、サイト品質とSafetyを分けた集計、ページ・Finding・Evidence・Screenshotの対応づけを行う |
| HTML部品とHTMLエスケープ | `src/report/html-components.ts` | HTMLの唯一のエスケープ関数と、エスケープを必ず通す部品関数（バッジ、表、Finding行、URL表示、Evidence参照、Screenshot参照、節の見出し、文書全体の骨組み） |
| 表示トークンとスタイルシート | `src/report/html-tokens.ts` | 色、余白、文字サイズなどのCSSカスタムプロパティと、レポートの唯一のスタイルシート |
| CLIの終了コード | `src/cli/exit-codes.ts` | Run Statusと `CONFIG_ERROR` から終了コードへの対応表（設計書 第28章） |

### 4.1 依存の向き

```text
src/core（型と値の定義）
   ↑
src/presentation（catalog / format / messages）
   ↑
src/report（view-model → html-components / html-tokens → html-report、chatgpt-bundle）
src/cli（exit-codes、messages を使って出力）
src/config（設定エラーの文言に messages を使う）
```

- `src/presentation/**` が import してよいのは `src/core/**` と `src/config/types.ts` だけです。`src/presentation/` の中どうしの import（例: `format.ts` が `messages.ts` の日本語の単位を使う）は、同じ表示の層の中なので許されます（2026-09-24 U16a の判断を設計者が承認。責務の分け方は変えていない）。ブラウザ、安全判定、クロール、Rule評価のモジュールには依存しません。表示の定義が、監査の処理の内部構造に引きずられないようにするためです。
- `src/report/html-report.ts` は、`html-components.ts` の部品を組み合わせるだけにします。HTMLのタグを含む文字列を直接書きません。
- `src/report/chatgpt-bundle.ts` と CLI の結果表示は、`view-model.ts` が組み立てた表示用モデルを使います。件数の集計をやり直しません。

### 4.2 各ownerの境界

- **カタログは意味を決めない。** どのRuleがどのcategoryに属し、どのseverityになるかは、Rule Catalog（`src/audit/rule-catalog.ts`）が決めます。カタログは、そのcategoryをどう呼び、どの順に並べるかだけを持ちます。
- **Findingの文言はRuleが持つ。** `messages.ts` は、Findingの `message` を作り直したり言い換えたりしません。
- **表示用モデルは判定しない。** `view-model.ts` は、確定した情報を数え、並べ、対応づけるだけです。新しいFindingを作ったり、severityやRun Statusを決め直したりしません。Run Statusは `deriveRunStatus()` の結果をそのまま使います。
- **URLの判定を作り直さない。** URL表示の部品は、リンクにするかテキストにするかを、`normalizeUrl` と `classifyUrl` の結果で決めます。`mailto:` や `tel:` を見分けるための独自の正規表現を書きません。
- **エスケープは1か所。** HTMLに値を入れる処理は、`html-components.ts` のエスケープ関数か、それを通す部品だけが行います。

### 4.3 型の開き

`Finding.category`、`PageAuditResult.incompleteReasons`、`RunSummary.incompleteReasons` は、現在 `string` です。
このままでは、カタログにすべての値が揃っていることを型で保証できません。

- `Finding.category` は、Task 12でRule Catalogを設計するときに、閉じたunion型にするかどうかを決めます。
- 理由コードは、Task 15とTask 16の設計で扱います。ただし、既存コードの理由コードの整理（CC-009）は、ユーザーの開発指示があるまで保留です。

どちらもJSON Schemaの変更を伴うため、スキーマの版を上げるかどうかも併せて判断します。

### 4.4 型と関数の詳細

各ownerの関数名、型名、引数は、この追補設計書では決めません。
Task 12、15、16、17の設計書で、それぞれのTaskの範囲に合わせて決めます。
ただし、どの設計書でも、第4章の表にあるファイルと責務の分け方を変えてはいけません。変える必要が出た場合は、この追補設計書を改訂し、ユーザーの承認を得ます。

## 5. 実装の時期

| owner | 作るTask |
| --- | --- |
| `src/presentation/catalog.ts` | Task 16（Finding categoryのラベルはTask 12の結果を使う） |
| `src/presentation/format.ts` | Task 16 |
| `src/presentation/messages.ts` | Task 16（理由の説明文）、Task 17（CLIと設定エラーの文言） |
| `src/report/view-model.ts` | Task 16 |
| `src/report/html-components.ts` | Task 16 |
| `src/report/html-tokens.ts` | Task 16 |
| `src/cli/exit-codes.ts` | Task 17 |

Task 12からTask 15の設計では、この追補設計書で定めた表示の分担を前提にします。
例えば、Task 12のRule定義は日本語の `message` を持ち、表示用のラベルや色を持ちません。Task 15の完了状態の判定は、理由を文字列ではなくコードとして渡します（CC-009の保留とは別に、新しく作るコードには最初から適用します）。

## 6. UI Gate（自動検査）

### 6.1 検査の内容

`tests/architecture/ui-ssot.test.ts` に、次の検査を置きます。

| ID | 検査の内容 | 対象 |
| --- | --- | --- |
| GATE-UI01 | Severity、Run Status、各種Statusの値の文字列リテラル（`'ERROR'`、`'COMPLETE'` など）が、表示面のコードに直接書かれていない | `src/report/**`、`src/cli/**`（`src/cli/exit-codes.ts` を除く） |
| GATE-UI02 | 色の値（`#` から始まる16進数、`rgb(`、`rgba(`、`hsl(`、`hsla(`）が、トークンの定義ファイル以外にない | `src/**`（`src/report/html-tokens.ts` を除く）。collectorがページから取得した色の値を扱う箇所は、検査の対象外として一覧で明示する |
| GATE-UI03 | HTMLのタグを含む文字列が、HTML部品のファイル以外にない | `src/report/**`（`src/report/html-components.ts` を除く） |
| GATE-UI04 | 表示用の集計関数を呼んでいるのが、表示用モデルの組み立て処理だけである | `src/**`（`src/report/view-model.ts` を除く） |
| GATE-UI05 | 表示カタログに、Severity、各種Status、Finding category、Evidenceの種類の全値が揃っている。書式関数が「未観測」を0や空文字にしない | `src/presentation/**` を実行して確かめる |
| GATE-UI06 | 日本語の文（ひらがな・カタカナ・漢字を含む文字列リテラル）が、文言カタログとRule定義以外にない。コメントは対象外 | `src/**`（`src/presentation/messages.ts`、`src/presentation/catalog.ts`、`src/audit/*-rules.ts` を除く） |

GATE-UI01〜04と06は、ソースコードの文字列を調べる静的な検査です。GATE-UI05は、カタログのモジュールを読み込んで値を調べる、実行時の検査です。

### 6.2 速さの要件

検査が遅いと、開発のたびに待ち時間が発生して生産性が落ちます。また、遅い検査は実行が省略されがちになり、検査の意味がなくなります。そのため、UI Gateには次の要件を課します。

- **実行時間の上限**: `tests/architecture/ui-ssot.test.ts` 全体を、開発者のPCで**1秒以内**に終えること。Vitestが表示するこのファイルの所要時間で判定する。
- **ファイルの読み込みは1回だけ**: 対象ディレクトリのファイル一覧の取得とファイルの読み込みは、テストファイルの中で1回だけ行い、各検査で共有する（`beforeAll` などで読み込む）。検査ごとに同じファイルを読み直さない。
- **軽い手段で検査する**: Node.js標準の `fs` で読み、正規表現と文字列の検索で判定する。次のものは使わない。
  - TypeScriptのコンパイラAPIや、ASTの解析
  - ESLintなどの外部ツールや、新しい依存パッケージ
  - ブラウザの起動、fixtureサーバの起動、子プロセスの起動
  - `npm run build` を前提にすること（`dist/` を読まない）
- **コメントの除去も軽く行う**: GATE-UI06でコメントを除外するときは、行コメントとブロックコメントを正規表現で取り除く程度の近似でよい。厳密な字句解析はしない。近似で誤検知が出た場合は、除外の一覧に理由を付けて加える。
- **常に実行される場所に置く**: 別のコマンドにせず、`npm test` と `npm run verify` で毎回実行されるようにする。
- **計測して記録する**: UI Gateを実装したときと変更したときに、所要時間を報告書に記録する。上限を超えた場合は、不具合として扱う。

この速さの要件は、Task 18で実装するArchitecture Gates（`tests/architecture/*.test.ts`）にも同じように適用します。

### 6.3 実装の時期

- GATE-UI01〜UI05は、Task 16で表示のownerを作るときに一緒に作ります。
- GATE-UI01のCLI部分とGATE-UI06は、Task 17で作ります。
- Task 18で、ARCH01〜08と併せて、UI Gateがすべて成立していることを確かめます。

## 7. 対象ファイル

| パス | 責務 | 変更の種類 | 時期 |
| --- | --- | --- | --- |
| `src/presentation/catalog.ts` | 表示用語彙 | 新規 | Task 16 |
| `src/presentation/format.ts` | 表示用の書式 | 新規 | Task 16 |
| `src/presentation/messages.ts` | 利用者向けの文言 | 新規 | Task 16、17 |
| `src/report/view-model.ts` | 表示用モデルと集計 | 新規 | Task 16 |
| `src/report/html-components.ts` | HTML部品とエスケープ | 新規 | Task 16 |
| `src/report/html-tokens.ts` | 表示トークンとスタイルシート | 新規 | Task 16 |
| `src/report/html-report.ts` | 部品を組み合わせてレポートを作る | 実装計画どおり新規 | Task 16 |
| `src/report/chatgpt-bundle.ts` | 表示用モデルからバンドルを作る | 実装計画どおり新規 | Task 16 |
| `src/cli/exit-codes.ts` | 終了コードの対応表 | 新規 | Task 17 |
| `src/cli/index.ts` | CLI | 変更 | Task 17 |
| `tests/architecture/ui-ssot.test.ts` | UI Gate | 新規 | Task 16、17 |

## 8. 対象外

- 既存コードの理由コードと文言の整理（CC-009、CC-010）。ユーザーの開発指示があるまで保留します。
- 日本語以外の表示言語への切り替え。必要になった時点で、`messages.ts` と `catalog.ts` を切り替え可能にする設計を別に行います。
- HTMLレポートの見た目のデザイン（配色の具体的な値、レイアウト）。Task 16の設計で決めます。
- Task 12以降の実装そのもの。Task 11の承認前には着手しません。

## 9. 完了条件

この追補設計書そのものの完了条件です。各Taskの完了条件は、各Taskの設計書に書きます。

- [ ] Task 16とTask 17の設計書が、第4章のowner、第3章の表示言語、第6章のUI Gateを含んでいる。
- [ ] UI Gate（GATE-UI01〜06）がすべてPASSし、`tests/architecture/ui-ssot.test.ts` の所要時間が1秒以内である。
- [ ] Task 18の完了時に、ARCH01〜08とUI Gateがすべて成立している。
- [ ] 共通部品台帳（`doc/design/beaksight-shared-components.md`）に、第4章のownerが載っている。

## 10. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-23 | 初版。ユーザーの決定（表示言語は日本語、表示用ownerの追加を承認、自動検査は速さを考慮して導入） | - | Task 12、15、16、17、18 |
