# 共通化候補台帳

この台帳は、既存コードで同じ意味の処理・定数・理由コードが複数箇所に重複しているものを記録します。
記録した時点では、まだ対応を決めていません。対応するときは、設計者が設計を書き、独立した実装サブタスクとして扱います（`.claude/skills/beaksight-dev/references/shared-components-policy.md`）。

## 状態の見直し（2026-09-25）

2026-09-25、設計者が、すべての候補の状態を見直した。CC-001〜011 は、基盤修正の設計書（`doc/design/2026-09-23-beaksight-foundation-corrections-design.md`）第3章のとおり実施していたが、この台帳の状態の欄を更新していなかった。各候補の「状態」の欄を、実際に合わせて直した。

## 実施の決定（2026-09-23）

2026-09-23、ユーザーが正式に開発を指示し、共通化候補の計画と実施時期を本作業の中で決めるよう求めた。実施時期は `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` 第3章で決めた。下の各候補の「状態」は、その決定を反映していない場合があるので、設計書を正とする。

## 保留の指示（2026-09-23 時点。上の決定で解除）

2026-09-23、ユーザーから「別途、開発指示するまで保留でよい」と指示があった。
この台帳のすべての候補は、ユーザーが明示的に開発を指示するまで着手しない。
ただし、新しく書くコードで同じ重複を増やさないことは、引き続き守る（`doc/design/beaksight-shared-components.md` 第4章）。

## 2026-09-23 初回登録について

- 登録の根拠: 2026-09-23に、読み取り専用の調査サブエージェントが `src/` と `tests/` を調べた報告。
- 確認の程度: CC-001、CC-002、CC-004、CC-005 は、設計者が `grep` で重複箇所の存在を確かめた。それ以外は調査の報告のままで、設計者は未確認。
- 行番号は2026-09-23時点のもの。対応するときは、改めて現在のコードで確かめること。
- この時点では、Task 11が独立レビューとユーザー承認の待ちで、Task 12以降は未着手。どの候補も、Task 11の承認前に着手してはならない。

---

## CC-001: 期限付きでPromiseを待つ処理と、部分結果の組み立てが3か所で複製されている

- 状態: 完了（2026-09-23、F01・F02。`src/core/deadline.ts`。3か所は共通化しない例外がある。基盤修正の設計書 3.2）
- 見つけた日と経緯: 2026-09-23、スキル整備のための重複調査
- 重複している箇所: `src/browser/page-settling.ts:25-100`、`src/browser/controlled-scroll.ts:34-134`、`src/evidence/performance-collector.ts:209-213,373-400,1148-1166`
- 違い: `DEADLINE` シンボル、`beforeDeadline<T>()`、部分結果の組み立ては、ほぼ同じ実装。成功を表す語が `'SETTLED'`（page-settling）と `'COMPLETE'`（ほか2つ）で違う。
- 放置した場合の影響: 期限の判定に不具合が見つかったとき、3か所のうち一部だけが直される。
- 共通化の案: `src/core/deadline.ts` のような共通の置き場に、期限付き待機、`wait`、タイムアウトの競争をまとめる。`isolated-auditor.ts` と `passive-request-guard.ts` にある手書きのタイムアウト処理（`Promise.race` と `setTimeout`）も、同じ部品で書けるかを検討する。
- 対応するサブタスク: 未定

## CC-002: 不明な値をエラーメッセージに変換する処理が3通りあり、振る舞いが違う

- 状態: 完了（2026-09-23、F01・F02。`src/core/errors.ts`）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所: `src/evidence/network-collector.ts:139`、`src/interaction/isolated-auditor.ts:107`、`src/safety/passive-request-guard.ts:138`
- 違い: network は切り詰めも例外への防御もしない。isolated は512文字で切り詰め、`instanceof Error` を使う。guard は2048文字で切り詰め、`Reflect.get` を使う。取り出せなかったときの代替文言も別々（`isolated-auditor.ts:60`、`passive-request-guard.ts:37`）。
- 放置した場合の影響: 悪意のあるページが投げた例外の扱いが、経路によって違う。network 側では、長すぎる文字列や、取り出すと例外になる値がそのまま流れる可能性がある（未確認）。
- 共通化の案: 例外を投げない安全な文字列化と、上限付きの切り詰めを1つの部品にする。どの振る舞いを正とするかを先に設計で決める（shared-components-policy.md 3.1）。
- 対応するサブタスク: 未定

## CC-003: 小さな判定関数や補助関数が複数箇所で定義されている

- 状態: 完了（2026-09-23、F01・F02。`src/core/guards.ts`、`immutable.ts`、`text.ts`）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所:
  - `deepFreeze`: `src/config/load-config.ts:39-47`、`src/evidence/performance-collector.ts:416`
  - `isRecord`: `src/config/validate-config.ts:5`、`src/config/load-config.ts:16`、`src/evidence/performance-collector.ts:406`
  - `compareCodeUnits`: `src/core/ids.ts:71-79`、`src/crawl/normalize-url.ts:12-20`
  - 数値の検査（正の有限数、0以上の整数など）: `validate-config.ts:11`、`status.ts:21`、`isolated-auditor.ts:223`、`layout-collector.ts:143-160`、`performance-collector.ts:412`、`discover-candidates.ts:38`、`crawl-queue.ts:14`
  - 文字列の切り詰め: `performance-collector.ts:402`、`discover-candidates.ts:230-239`、`safety-ledger.ts:202-215`、`isolated-auditor.ts:155,163,172`（同じ名前でも `null` を返すものと例外を投げるものがある）
  - 空白の正規化 `replace(/\s+/gu, ' ').trim()`: `dom-collector.ts:118`、`color-collector.ts:168`、`layout-collector.ts:277`、`discover-links.ts:29`、`discover-candidates.ts:388,667`（ブラウザ内のものを含む）
- 違い: 大半は同じ。切り詰めは振る舞いが違う。
- 放置した場合の影響: 小さいが、今後の実装で同じ関数がさらに増える。
- 共通化の案: `src/core/` の下に、型の判定、不変化、テキスト処理の置き場を作る。ブラウザ内で使うものは CC-008 と一緒に扱う。
- 対応するサブタスク: 未定

## CC-004: 許可Originの正規化が2か所にある（URLの意味のSSOTに関わる）

- 状態: 完了（2026-09-23、F02c。`canonicalizeAllowedOrigins` を `src/crawl/normalize-url.ts` に置いた）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所: `src/crawl/admission-policy.ts:11-24`（`canonicalizeAllowedOrigins`）、`src/safety/request-policy.ts:31-48`（`canonicalPassiveAllowedOrigins`）
- 違い: 調査の報告では、ロジックまで同じ。
- 放置した場合の影響: クロールの受け入れ判定（URL admission）とPassive HTTPの安全判定で、「許可されたOrigin」の解釈がずれる可能性がある。SSOT Owner MatrixのURL admissionとPassive HTTP authorityの境界に関わるため、影響が大きい。
- 共通化の案: どちらのownerが正規化を持つか、または `normalizeUrl` の側に寄せるかを、設計者がOwner Matrixと照らして決める。ARCH04の検査対象に含めるかも判断する。
- 対応するサブタスク: 未定

## CC-005: `http:` / `https:` の判定が9か所に直接書かれている

- 状態: 完了（2026-09-23、F02c。`isHttpProtocol`。ブラウザ内の判定は対象外）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所: `validate-config.ts:18`、`admission-policy.ts:16,27`、`normalize-url.ts:51`、`discover-links.ts:34`、`request-policy.ts:37`、`discover-candidates.ts:271`、`isolated-auditor.ts:557`、`passive-request-guard.ts:809`
- 違い: 未確認。
- 放置した場合の影響: 許可するschemeの方針を変えるときに、直し漏れが起きる。URLの意味の判断が `normalizeUrl` / `classifyUrl` の外に散らばっている状態で、ARCH04（URL Semantics SSOT）の趣旨に反する可能性がある。
- 共通化の案: URLのownerが提供する判定関数に寄せる。ブラウザ内の判定は CC-008 と一緒に扱う。
- 対応するサブタスク: 未定

## CC-006: 採番とハッシュの書式が `core/ids.ts` の外にもある

- 状態: 完了（2026-09-23、F02c。`src/core/ids.ts`）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所: `sha256:` の書式が `core/ids.ts:68` と `discover-candidates.ts:226-228`、その検証用の正規表現が `interaction-policy.ts:68-69`。6桁の採番が `core/ids.ts:4,31` と `network-collector.ts:119-121`（`REQ-` の接頭辞は `ids.ts` にない）。
- 違い: 未確認。
- 放置した場合の影響: IDの書式はSSOT Owner Matrixで `src/core/ids.ts` がownerと定められている。書式が変わったときに、一部のIDだけ古い書式のまま残る。
- 共通化の案: `core/ids.ts` に寄せる。
- 対応するサブタスク: 未定

## CC-007: 同じ意味の上限値が複数のファイルに直接書かれている

- 状態: 完了（2026-09-23、F01・F02・C7。`src/core/limits.ts`）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所:
  - URLの最大長 2048: `passive-request-guard.ts:34`、`performance-collector.ts:5,218`、`interaction-policy.ts:48`
  - テキスト長 512: `isolated-auditor.ts:54`、`performance-collector.ts:7,217`、`accessibility-collector.ts:5`、`interaction-policy.ts:47`
  - IDやテキストの長さ 256: `performance-collector.ts:6,216`、`passive-request-guard.ts:35`、`COLOR_LIMITS`、`INTERACTION_CANDIDATE_LIMITS`、`LAYOUT_THRESHOLDS`
  - HTTPメソッドの長さ 32: `passive-request-guard.ts:33`、`safety-ledger.ts:69`
  - selectorの上限（長さ512、深さ8）: `color-collector.ts:7-8`、`layout-collector.ts:14-15`
  - ジオメトリの許容誤差 0.5px: `layout-collector.ts:8`、`interaction-collector.ts:22`
  - telemetry ヘッダの名前一覧: `performance-collector.ts:20-29` と `network-collector.ts:5-49`
- 違い: 値は同じ。ただし、同じ数値でも意味が違うものが混ざっている可能性がある（shared-components-policy.md 第4章「意味が違う場合」）。
- 放置した場合の影響: 上限を変えたときに、一部の経路だけ古い上限が残る。
- 共通化の案: 意味ごとに分けて定義元を決める。同じ数値でも意味が違うものは、無理にまとめない。
- 対応するサブタスク: 未定

## CC-008: ブラウザ内のDOM走査と可視判定が重複し、「可視」の定義が4通りある

- 状態: 完了（2026-09-25。残りの2点は CC-033 に分けた。C18e で `discover-candidates.ts` の中の複製を `interactionCandidateProbe` にまとめた。256件の fixture のページで、まとめる前と後の結果が同じことを確かめた）。以前の経緯: 2026-09-23、C5 で可視判定を統一した
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所:
  - `src/interaction/discover-candidates.ts` の中で、`discoverInteractionCandidates`（`:371-574`）と `inspectInteractionCandidateHandle`（`:613-810`）が、作業量のカウンタ、要素の走査、テキストの切り詰め、可視判定、アクセシブルネーム、候補の組み立てをほぼ複製している。
  - `selectorFor`: `color-collector.ts:222-241`、`layout-collector.ts:278-301`
  - overflow の判定: `color-collector.ts:317,321`、`layout-collector.ts:414,416`
  - 可視判定: `dom-collector.ts:122`（aria-hidden を見るが祖先をたどらない）、`color-collector.ts:269` と `layout-collector.ts:316`（祖先をたどり、opacity も見る）、`discover-candidates.ts:421`（インライン style を正規表現で見る）
  - 矩形の型: `RectangleEvidence`（`layout-collector.ts:22`）と `InteractionBoundingBox`（`interaction-policy.ts:8`）が同じ8フィールド
- 違い: 可視判定は定義そのものが違う。
- 放置した場合の影響: 同じ要素が、あるcollectorでは「見えている」、別のcollectorでは「見えていない」と記録される。後段のRuleやChatGPTでの意味監査で、Evidenceどうしが食い違って見える。定義の違いが意図されたものでなければ、既存不具合にあたる可能性がある。
- 共通化の案: まず「可視」の定義をどうするか（用途ごとに分けるのか、1つにするのか）を設計で決める。ブラウザ内の共通処理の渡し方（スクリプトの注入など）も併せて設計する。`discover-candidates.ts` の中の重複は、Task 11の承認後、同じファイルの中で先に整理できる可能性がある。
- 対応するサブタスク: 未定

## CC-009: 状態と理由のコードが各ファイルで別々に定義され、表記も揃っていない

- 状態: 完了（2026-09-23、F02・C8。部分失敗の理由と観測状態を `src/core/contracts.ts` に置き、`incompleteReasons` を構造化した）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所:
  - 部分失敗の理由 `'DEADLINE_EXCEEDED' | 'EVALUATION_FAILED' | 'PAGE_CLOSED'`: `page-settling.ts:21`、`controlled-scroll.ts:30`、`performance-collector.ts:202`
  - 期限切れの表記が `'TIMED_OUT'`（`passive-request-guard.ts:350`、`isolated-auditor.ts:67,262`）と `'DEADLINE_EXCEEDED'`（`isolated-auditor.ts:63` ほか）で混在
  - 観測状態: `contracts.ts:39` の `'OBSERVED' | 'NOT_OBSERVED'` と、`performance-collector.ts:42` の独自の `WebVitalStatus`
  - safety の理由コード（`'NON_READ_METHOD'` など）: `safety-ledger.ts:4,10,15` と `request-policy.ts:18-24` にリテラルで二重に書かれている
  - `InvariantViolationEvent.code` が `string` で、約30種類のコードが `passive-request-guard.ts` に散らばっている
  - `incompleteReasons` が `string[]`（`contracts.ts:112,125`）
- 違い: 表記の揺れがある。
- 放置した場合の影響: Task 15（完了状態）とTask 16（レポート）で、理由を集計したり説明文に変えたりするときに、同じ意味の理由が別物として数えられる。表示用の文言カタログ（ui-ux-ssot.md 第5章）と1対1に対応づけられない。
- 共通化の案: 状態と理由を閉じたunion型として定義元を決める。Task 15の設計の前に整理しておくのが望ましい。
- 対応するサブタスク: 未定

## CC-010: 利用者向けの文言が直書きされ、書式も揃っていない

- 状態: 完了（2026-09-25、C18n と C18o で完了。Interaction の理由をコードと詳細に分け、日本語の説明を `messages.ts` に置いた）。以前の記録: 一部完了（2026-09-25、Task 16・17 で、利用者に見せる文言を `src/presentation/messages.ts` に集めた）。残りは、Interaction の `reason` などの欄で、理由のコードと英文が混ざっている点である。表示では、技術的な詳細として、そのまま示している（設計書 6.1.5）。この残りは、Interaction の同じファイルに触れる CC-008 と一緒に、Task 18 の後、Task 19 の前に行う（2026-09-25 設計者の決定）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所:
  - 同じ `reason` の欄に、`'SUBMISSION_CONTROL'` のようなコードと英文が混在: `isolated-auditor.ts:427-434` ほか
  - 同じ英文の直書き: `'Interaction activity was blocked by safety freeze'`（`isolated-auditor.ts:205,456,507,513`）、`'Passive request guard context was invalidated'`（guard 内に5回）、`'Invalid bounded interaction handle resolution envelope'`（`discover-candidates.ts:131-199` に8回）
  - 書式の揺れ: 設定の検証とCLIは小文字始まり、実行時の `Error` は大文字始まりの文、`schema-validator.ts:26-33` は `/path message` の形式
- 違い: 書式の揺れがある。
- 放置した場合の影響: CLIとHTMLレポートで同じ理由が違う言葉で表示される。表示言語を決めたときに、直すべき箇所が散らばっている。
- 共通化の案: 理由コードと説明文を分け、説明文を文言カタログにまとめる（ui-ux-ssot.md 第5章）。表示言語はユーザーの確認が必要。
- 対応するサブタスク: C18e（調査）、C18n（Evidence とスキーマ）、C18o（説明と表示）。方針は設計書 `2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 5.1（案A。2026-09-25 設計者の決定）

## CC-011: テストの準備処理が各テストファイルに複製されている

- 状態: 完了（2026-09-23、F03。`tests/helpers/`）
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所:
  - `configFor()`（`DEFAULT_CONFIG` からテスト用の設定を作る）: 7ファイル（`context-factory`、`controlled-scroll`、`layout-accessibility`、`performance-evidence`、`technical-evidence`、`screenshot-collector`、`isolated-interaction`）
  - `chromium.launch({ headless: true })` の beforeAll / afterAll: 9ファイル
  - `closePassivePage` / `closePassiveContext` の afterEach: 5ファイル
  - `Deferred<T>`: 4ファイル（`context-factory`、`network-collector`、`isolated-interaction`、`passive-request-guard`）
- 違い: `isolated-interaction` の `configFor()` だけは全項目を直書きしている。
- 放置した場合の影響: `AuditConfig` の形が変わるたびに、7ファイルのテストを直すことになる。
- 共通化の案: `tests/helpers/` を作り、設定の生成、ブラウザとfactoryの起動と終了、`Deferred` を置く。検証の内容は各テストに残す（shared-components-policy.md 第4章）。
- 対応するサブタスク: 未定

## CC-012: CLIの終了コードが定数化されておらず、設定エラーがスタックトレースで出る

- 状態: 完了（2026-09-25、U17a）。`src/cli/exit-codes.ts` と `ConfigError`。
- 見つけた日と経緯: 2026-09-23、同上
- 重複している箇所: `src/cli/index.ts`（終了コード `0`、`1`、`4` の直書き。`loadConfig` の例外を捕捉していない）
- 違い: 該当なし。これは重複ではなく、Task 17で直す予定の部分。
- 放置した場合の影響: Task 17の完了条件（スタックトレースを出さない、終了コードの対応）を満たさない。ただし、Task 1の時点のスタブとしては計画どおりの可能性がある。
- 共通化の案: Task 17の設計で、終了コードの対応表を1つ定義する（ui-ux-ssot.md 第5章）。
- 対応するサブタスク: Task 17

## CC-013 Rule のファイルの重複した補助処理（2026-09-24 T12c の報告で登録）

- 現象: 次の2つの処理が、Rule のファイルごとに別々に書かれている。
  - 入力のビューポートの、ある種類の Evidence を取り出す処理
  - 文言の中の数値を丸める処理（`formatNumber`）
  - 対象は `layout-rules.ts`、`accessibility-rules.ts`、`performance-rules.ts` で、ほかの Rule のファイルにもある可能性がある。
- 方針:
  - Evidence を取り出す処理は、`src/audit/rule-helpers.ts` にまとめる。
  - 数値の書式は、`src/presentation/format.ts`（UI追補設計書の owner）にまとめる。
- 追加（T12d の報告）: 重複を除いて並べる処理も、Rule のファイルごとに書かれている。例は、`safety-rules.ts` の `distinctSorted` と、`technical-rules.ts` の `joinDistinct` である。これも `rule-helpers.ts` にまとめる。
- 実施の時期: T12f。T12d と T13b の後、Task 14 の前に行う。Rule のファイルが新しく、呼び出し元が少ないうちに行うためである。

## CC-014 外部アクションの遮断の理由の型（2026-09-24 T12d0 の報告で登録）

- 現象: `BlockedExternalActionEvent.reason` の型は `string` のままである。実際に入る値は、`EXTERNAL_ACTION` と `DOWNLOAD` だけである。
- 方針: core に `as const` の配列を置き、Ledger とスキーマを閉じた一覧にする。
- 実施の時期: Task 14。Page Auditor が Safety の Evidence を作るときに、あわせて行う。
- 状態: CC-014 は P14a で完了した（2026-09-24）。

## CC-015 不変条件の違反の型の重複（2026-09-24 T12d0 の報告で登録）

- 現象: `src/core/contracts.ts` の `SafetyInvariantViolationSummary` と、`src/safety/safety-ledger.ts` の `InvariantViolationEvent` は、同じ形（`code`、`message`）の型である。
- 方針: core の型を1つにする。Ledger の型は、その別名にする。
- 実施の時期: Task 15。Run Status と Safety の集計を完成させるときに、あわせて行う。
- 実施の時期の変更（2026-09-25）: Task 15 では行われなかった。2つの型は、まだ別々にある（`contracts.ts:353`、`safety-ledger.ts:39`）。
  - Task 18 の前の整理で、CC-028 と DEF-008 と同じく、Guard のレビューを受けて行う。
- 状態: 完了（2026-09-25、P18b）。Ledger の `InvariantViolationEvent` は、core の `SafetyInvariantViolationSummary` の別名になった。

## CC-016 文言の中の一覧の書式（2026-09-24 T12f の報告で登録）

- 現象: 文言の中で値を並べる区切りの「、」が、Rule のファイルごとに文字列リテラルとして書かれている。場所は `technical-rules.ts`、`safety-rules.ts`、`cross-page-rules.ts` など。
- 現象: `cross-page-rules.ts` の `formatList`（件数を省く表記）と `formatStatuses`（ビューポートごとの状態の表記）は、表示の書式にあたる。
- 方針: 一覧の書式を1か所にまとめる。移し先は、文言カタログ（`src/presentation/messages.ts`）か、書式の owner とする。どちらにするかは、GATE-UI06（日本語の文字列を置いてよいファイル）に合わせて決める。
- 実施の時期: Task 16。文言カタログと書式の owner を作るときに行う。
- 状態: CC-013 は、T12f で完了した。
- 実施の時期の変更（2026-09-25）: Task 16 では行わなかった。C17a で行う。
  - 置き場所: `src/presentation/messages.ts`。U17a で加えた `cliListText` を、Rule と CLI で共通の一覧の文言の関数にする。
  - `、` は、GATE-UI06 の日本語の文字の範囲（ひらがな・カタカナ・漢字）に入らない。ただし、文言の書式なので、`messages.ts` に置く。
- 状態: 完了（2026-09-25、C17a）。`listText` と `truncatedListText` を `messages.ts` に置いた。`messages.ts` の外の `.join('、')` は、UI Gate で検出する。

## CC-017 Playwright の期限切れの判定の重複（2026-09-24 P14b の報告で登録）

- 現象: Playwright の期限切れの例外を判定する処理が、2か所にある。
  - `src/interaction/isolated-auditor.ts` の `isTimeoutError`（`error.name === 'TimeoutError'` で判定）
  - `src/orchestration/page-navigation.ts`（`errors.TimeoutError` の `instanceof` で判定）
- 方針: `src/browser/` に、共通の判定の関数を1つ置き、両方から使う。
- 実施の時期: Task 14 のチェックポイントの後、Task 15 の前に行う。Interaction の監査は何度も直した箇所なので、単独のサブタスクで、テストを添えて行う。
- 状態: 完了（2026-09-24、C14x）。

## CC-018 page と Context を閉じる処理の重複（2026-09-24 P14c の報告で登録）

- 現象: 「page を閉じてから Context を閉じる。Guard がすでに閉じていれば、Context は閉じ直さない」処理が、2か所にある。
  - `src/orchestration/page-auditor.ts`: 失敗を、理由として返す。
  - `src/orchestration/stress-session.ts` の `createSessionHandle`: 失敗を、例外として投げる。
- 方針: 閉じる処理と、その結果（失敗の一覧）を返す部品を、1つにする。例外にするか理由にするかは、呼び出し側で決める。
- 実施の時期: Task 14 のチェックポイントの後に、CC-017 と DEF-003 と同じサブタスクで行う。
- 同じサブタスクで、次の2つも行う（P14d の報告）。
  - 倍数の定数の移動と、古いコメントの修正は、P14e で済んだ。
- 状態: 完了（2026-09-24、C14x）。

## CC-019 Guard の取り付けを失敗させるテスト用の Browser の Proxy の重複（2026-09-24 P14f の報告で登録）

- 現象: 「`newContext` の直後に page を1つ開く Browser の Proxy」が、4つのテストファイルにそれぞれ書かれている。
  - `tests/component/context-factory.test.ts`
  - `tests/integration/page-auditor.test.ts`
  - `tests/integration/page-auditor-interaction.test.ts`
  - `tests/integration/stress-session.test.ts`
- 方針: `tests/helpers/` に1つの補助としてまとめ、4つのファイルから使う。
- 実施の時期: C14x（Task 14 の後の整理）で行う。
- 状態: 完了（2026-09-24、C14x）。

## CC-020 ビューポートと、設定の大きさの対応づけの重複（2026-09-24 R15c の報告で登録）

- 現象: Desktop・Mobile と、設定の `primaryDesktop`・`primaryMobile` の対応づけが、2か所にある。
  - `src/orchestration/page-auditor.ts` の `viewportSizeOf`（公開されていない）
  - `src/orchestration/environment.ts`
- 方針: 1つの関数にして、1か所に置く。Page Auditor、環境の事実、Run Coordinator は、その関数を使う。
- 実施の時期: R15d で行う。Run Coordinator でも、同じ対応づけが必要になるためである。
- 状態: 完了（2026-09-24、R15d。`src/config/viewport-size.ts` の `viewportSizeFor`）。

## CC-021 理由の組み立てと、件数の加算の重複（2026-09-24 R15d の報告で登録）

- 現象:
  - `UNHANDLED_FAILURE` の `<場面>:<メッセージ>` の組み立てが、2か所にある。
    - `page-auditor.ts` の非公開の `unhandledFailure`
    - `run-coordinator.ts` の `unhandledFailureReason`
  - Rule の評価の失敗の理由の `${ruleId}:${message}` が、2か所にある。
    - `page-auditor.ts`
    - `run-coordinator.ts`
  - 違反の件数の上限付きの加算が、2か所にある。
    - `run-aggregation.ts` の `mergeSafetySummaries`
    - `safety-ledger.ts` の非公開の `saturatingAdd`
- 方針: 理由の組み立ては、`src/core/status.ts` の `collectorIncompleteReason` の近くに、1つずつ関数として置く。加算は、1つの関数を公開して、両方から使う。
- 実施の時期: Task 16 の前の整理のサブタスクで行う。
- 状態: 完了（2026-09-24、C15x）。`unhandledFailureReason` と `ruleEvaluationFailureReason` を、`src/core/status.ts` に置いた。

## CC-022 `REQUIRED_ARTIFACT_INVALID` の detail の組み立ての重複（2026-09-25 U16b の報告で登録）

- 場所:
  - `src/orchestration/run-coordinator.ts` の `invalidArtifactReasons`
  - `src/report/artifact-writer.ts` の `requiredArtifactInvalidReason`
- 内容: 同じ書式（`<スキーマ>:<ID>:<最初の誤り>`）を、2か所で組み立てている。
- 影響: いまは振る舞いが同じである。ただし、片方の書式だけが変わると、重複した理由を除く処理が働かなくなる。
- 方針: `src/core/status.ts` に、組み立ての関数を1つ置く。
- 実施の時期: C16a（2026-09-25 設計者の決定）
- 状態: 完了（2026-09-25、C16a）。

## CC-023 artifact の配置の名前とパスの重複（2026-09-25 U16b の報告で登録）

- 場所:
  - `src/orchestration/page-auditor.ts` の `SCREENSHOT_ARTIFACT_DIRECTORY` と、スクリーンショットのパスの組み立て
  - `src/report/artifact-writer.ts` の `PAGES_DIRECTORY` と、ページの artifact のパス
  - `src/orchestration/run-coordinator.ts` の `runArtifactDirectory`
- 内容: `pages` のディレクトリの名前と、artifact のパスの組み立てが、3か所に分かれている。そのため、report が orchestration を import している。
- 方針: `src/core/artifact-layout.ts` に、配置の owner を1つ置く（設計書 6.1.8）。
- 実施の時期: C16a（2026-09-25 設計者の決定）
- 状態: 完了（2026-09-25、C16a）。

## CC-024 表示のテストの、Run の見本の組み立ての重複（2026-09-25 設計者が C16a の検証で登録）

- 場所:
  - `tests/unit/view-model.test.ts`
  - `tests/unit/artifact-writer.test.ts`
- 内容: Evidence、Finding、ページ、`RunSummary`、`AuditRunResult` の見本を組み立てる関数が、2つのファイルに複製されている。
  - `record`、`screenshot`、`dom`、`finding`、`page`、`runSummary`、`auditRun` など
- 影響:
  - U16c、U16d、U17a でも、同じ見本が必要になる。このままだと、さらに複製が増える。
  - 契約の型が変わると、複製のすべてを直す必要がある。
- 方針: `tests/helpers/audit-run-fixture.ts` に、見本を組み立てる関数を1つにまとめる。既存の2つのテストは、それを使う形にする。
- 実施の時期: C16b。U16c・U16d の前に行う（2026-09-25 設計者の決定）。
- 状態: 完了（2026-09-25、C16b）。

## CC-025 COMPLETE の Run Status の入力の見本の重複（2026-09-25 C16b の報告で登録）

- 場所:
  - `tests/helpers/audit-run-fixture.ts` の `runStatusInput`
  - `tests/unit/status.test.ts:24`
  - `tests/unit/safety-ledger.test.ts:24`
  - `tests/unit/run-coordinator.test.ts:1089`
- 内容: `deriveRunStatus` が `COMPLETE` を返す入力の見本が、4か所にある。
- 影響: いまは振る舞いが同じである。`RunStatusInput` に項目が増えると、4か所を直す必要がある。
- 方針: 3つのテストファイルは、補助の `runStatusInput` を使う形にする。
- 実施の時期: Task 18 の前の整理（2026-09-25 設計者の決定）。
- 状態: 完了（2026-09-25、P18e）。`status.test.ts` と `safety-ledger.test.ts` は、`runStatusInput()` を使う。`run-coordinator.test.ts:1089` の見本は、今のファイルにはなかった（登録の時点の行番号の誤り）。

## CC-026 JSON の書式の組み立ての重複（2026-09-25 U16d の報告で登録）

- 場所:
  - `src/report/artifact-writer.ts` の `serializeJson`（private）
  - `src/report/chatgpt-bundle.ts` の `jsonBytes`
- 内容: 同じ書式（字下げ2文字、末尾に LF、UTF-8）を、2か所で組み立てている。
- 影響: いまは振る舞いが同じである。片方だけが変わると、同じ Run の JSON の書式がずれる。
- 方針: `src/report/` の1か所に、書式の関数を置く。
- 実施の時期: C16c。U16c の後、Task 16 のレビューの前に行う（2026-09-25 設計者の決定）。
- 状態: 完了（2026-09-25、C16c）。`src/report/artifact-json.ts`。

## CC-027 artifact の相対パスの検証の重複（2026-09-25 U16d の報告で登録）

- 場所:
  - `src/evidence/screenshot-collector.ts` の `portableRelativeArtifactPath`（private）
  - `src/report/artifact-writer.ts` の `SAFE_PATH_SEGMENT`
  - `src/report/chatgpt-bundle.ts` の `assertScreenshotEntryPath`
- 内容: artifact の相対パスが安全かどうかの検証（`..`、絶対パス、制御文字などを拒む）が、少しずつ違う規則で3か所にある。
- 影響: 撮る側と読む側で規則がずれると、撮れたスクリーンショットをバンドルに入れられないことがある。逆に、片方だけが緩い場合もある。
- 方針: `src/core/artifact-layout.ts` に、検証の関数を1つ置く。3か所は、それを使う。
  - 規則は、いちばん厳しいもの（すべての制御文字を拒む）に合わせる。
  - `pages/` で始まることは、バンドルの側の追加の条件として残してよい。
- 実施の時期: C16c（2026-09-25 設計者の決定）。
- 状態: 完了（2026-09-25、C16c）。`isPortableRelativeArtifactPath` と `isPortableArtifactPathSegment` を、`src/core/artifact-layout.ts` に置いた。
- 見直しの条件: 利用者が入れた文字列を、artifact のパスに使うことになった場合は、次のものも拒むように規則を見直す。
  - Windows の予約名、末尾の `.` と空白
  - 区切りの途中のコロン、Cf の文字、対になっていないサロゲート

## CC-028 Safety Ledger の分類の名前が、文字列の型である（2026-09-25 C16e の報告で登録）

- 場所: `src/safety/safety-ledger.ts:271, 282`（`reachedCategories`）と、139〜216行の呼び出し
- 内容:
  - 事象の一覧の名前（`'blockedRequests'` など）を、分類の名前として、`string` の型のまま渡している。
  - 同じ名前の一覧は、core の `SAFETY_EVENT_KINDS` にある。
- 影響: いまは振る舞いが同じである。書き間違えても、型のエラーにならない。
- 方針: 分類の名前の型を、`SafetyEventKind` と `'invariantViolations'` に絞る。
- 実施の時期: Task 18 の前の整理（2026-09-25 設計者の決定）。
  - 安全の部品なので、DEF-008 と同じサブタスクで、Guard のレビューを受けて行う。
- 状態: 一部完了（2026-09-25、P18b）。事象の記録の分類の名前は、`SafetyLedgerRecordCategory` に絞った。数えられなかった遮断の分類の名前（`blockedRequestsByMethod` の形）は、P18e で、閉じたテンプレートの型にする。
- 状態: 完了（2026-09-25、P18e）。数えられなかった遮断の分類の名前も、閉じたテンプレートの型にした（`SafetyLedgerUncountedBlockedRequestCategory`、`SafetyLedgerReachedCategory`）。

## CC-029 Gate と統合テストの、Run の起動と確認の補助の重複（2026-09-25 T18c の報告で登録）

- 場所:
  - `tests/integration/auditor-gates.test.ts`（`launcher`、`findingsOf`、`expectSchemaValid`、読み取りだけのリクエストの確認、`capture`）
  - `tests/integration/crawl-run.test.ts`（同じ形の補助）
  - `tests/unit/run-command.test.ts`（`capture`）
  - `tests/helpers/gate-harness.ts`（T18b で作った、サーバの境界で数える補助）
  - `tests/integration/preflight.test.ts` の `recordingLauncher` と、`newContext` を失敗させる Proxy（`gate-harness.ts` の `createGateLauncher` と `browserFailingNewContext` と同じ役割。T18b の報告）
  - `tests/integration/isolated-interaction.test.ts:1001-1019` の `candidateNamed` と `input`（`gate-harness.ts` の `discoverInteractionCandidate` と `interactionAuditInput` と同じ役割。T18b の報告）
  - 外部スキームの宛先、経路、経路ごとの移動の処理（`tests/integration/external-scheme-navigation.test.ts:28-45, 87-142`、`gate-harness.ts` の `EXTERNAL_SCHEME_TARGETS` と `EXTERNAL_SCHEME_ROUTES`、fixture の中）。経路の名前の書き方もそろっていない（C18b の報告）
  - 試験用のパス（`/external-scheme-redirect-frame.html`、`/__external-scheme-redirect`）の定数が、3つのテストファイルに同じ形である（C18g の報告）
  - `--site-per-process` の Chromium の起動が、3つのテストファイルにある（C18i の報告）
- 内容: Run の起動、Finding の取り出し、スキーマの確認、リクエストの確認、出力の取り込みの補助が、テストのファイルごとに複製されている。
- 影響: Run Coordinator や CLI の引数が変わると、複数のファイルを直す必要がある。
- 方針: `tests/helpers/` に1つにまとめる。検証の内容は、各テストに残す。
- 実施の時期: Task 18 の後の整理（2026-09-25 設計者の決定）。
  - あわせて、共通のハブのページを fixture に加えて、Auditor の Gate の Run の数を減らすことを検討する（T18c の判断1）。
- 状態: 完了（2026-09-25、C18d）。`tests/helpers/` の `run-harness.ts`、`browser-proxies.ts`、`external-scheme-fixture.ts` にまとめた。ハブのページで、Auditor の Gate の Run を8から5に減らした。範囲の外に残った重複は、CC-031 とした。

## CC-030 UI Gate の文字列リテラルの取り出しの近似（2026-09-25 T18e の報告で登録）

- 場所: `tests/architecture/ui-ssot.test.ts` の `STRING_LITERAL_PATTERN`
- 内容:
  - UI Gate は、走査の結果の `code` に、正規表現をかけて文字列リテラルを取り出している。
  - `source-scan.ts` の走査は、すでに文字列リテラルを分けて持っている（`literals`）。
  - そのため、同じことを2通りで行っている。正規表現のリテラルの中の引用符を、文字列の始まりとみなしうる近似も残っている。
- 影響: いまの `src/` では、誤りは起きていない。
- 方針:
  - UI Gate の文字列リテラルの取り出しを、走査の `literals` に移す。
  - ただし、テンプレートの `${…}` で区切った部分ごとの判定になると、UI01 の規則が広がる。規則を変えずに移す方法を、先に設計で決める。
- 実施の時期: Task 18 の後の整理（2026-09-25 設計者の決定）。
- 状態: 完了（2026-09-25、C18c）。走査に `wholeLiterals` を加え、UI Gate の文字列リテラルの取り出しを移した。`STRING_LITERAL_PATTERN` は消した。

## CC-031 CC-029 の後に残った、テストの補助の重複（2026-09-25 C18d の報告で登録）

- 場所と内容:
  - `tests/unit/cli.test.ts:518` の `capture`（`run-harness.ts` の `captureCliOutput` と同じ役割）
  - `tests/integration/report-generation.test.ts:31` の launcher と、Run Coordinator の組み立て（`createRunLauncher` と同じ役割）
    - この launcher は、要求された `headless` の値を、そのまま Chromium に渡している。
  - `tests/integration/environment.test.ts:55` の `browserWithHangingNewContext`（`browserHangingNewContext` と同じ役割）
  - `tests/component/discover-links.test.ts:17` の `chromium.launch()`（`launchHeadlessChromium` と同じ役割）
  - `QUIET_PERIOD_MS = 300` が、4つのファイルにある。
  - headless と headed の注入の組み合わせ（`MODES`、`FACTORY_MODES`）が、3つのファイルにある。題名の書き方もそろっていない。
  - Guard の付いた Passive の page を開いて閉じる処理が、複数の形で書かれている。
  - `fixtures/server.ts:76` のコメントが、移る前の場所（`gate-harness.ts`）を指している。`fixtures/server.ts:79` と fixture の HTML に、宛先の値の複製がある。
- 影響:
  - 振る舞いの違いはない。
  - ただし、要求の値のままで headed を起動しうる launcher が残っている。安全の面から、先に直す。
- 方針: `tests/helpers/` の補助を使う形にする。fixture の中の宛先の値は、サーバとページの間で1か所にできるかを確かめる。
- 実施の時期: C18k（C18e と並行。2026-09-25 設計者の決定）
- 状態: 完了（C18k、C18k-fix-round-1。2026-09-25）。Guard の付いた page の処理の残りは CC-032 へ。全体の verify で確かめた（2026-09-25、98ファイル、3,523件）

## CC-032 Guard の付いた Passive の page を開いて閉じる処理の、残りの複製（2026-09-25 C18k の報告で登録）

- 場所と内容:
  - `createPassiveContext` と `closePassiveResources` の組を、テストごとに書いている。C18k で `withGuardedPassivePage`（`tests/helpers/gate-harness.ts`）を作ったが、置き換えたのは C18k の範囲のファイルだけである。
  - 残りの候補: `slow-redirect`、`isolated-interaction`、`page-auditor`、`page-auditor-interaction`、`layout-accessibility`、`layout-evidence-scale`、`accessibility-evidence`、`accessibility-guard-safety`、`controlled-scroll`、`page-navigation`、`performance-evidence`、`screenshot-collector`、`site-metadata`、`stress-session`、`technical-evidence` の各テスト
  - 対象の外: `passive-session-open`、`passive-session-close`、`context-factory`、`run-coordinator`、`schema-validator`、`preflight` のテスト。開く処理と閉じる処理そのもの、または別の組み立てを試すためである。
- 影響: 振る舞いの違いはない。閉じ方の書き漏れ（Context が残る）を防ぐ効果がある。
- 方針:
  - 開く → 1つの処理 → 閉じる、の形と同じものだけを、`withGuardedPassivePage` に置き換える。
  - 途中で Context の状態を変える、閉じる処理の結果を確かめる、などの違いがあるテストは、置き換えずに報告する。
  - 置き換えの前後で、各ファイルの PASS の件数とテストの名前が同じであることを確かめる。
- 実施の時期: C18m。C18e（CC-008 と CC-010）が終わった後で、RC18 の前に行う（2026-09-25 設計者の決定）。Interaction のテストが C18e と重なるため、並行にしない。
- 状態: 完了（C18m。2026-09-25）。8ファイルで71件を置き換えた。残り（`layout-accessibility` の4件、`controlled-scroll`、`page-navigation`、`performance-evidence` など）は、途中で閉じる、非同期の準備がある、など形が違うので対象にしない（設計者の判断）

## CC-033 CC-008 の残り: `selectorFor` の複製と、矩形の型の複製（2026-09-25 RC18 の M6 で登録）

- 場所と内容:
  - `selectorFor`: `src/evidence/color-collector.ts:236` と `src/evidence/layout-collector.ts:539`。どちらも、ブラウザの中で動く関数の中の内側の関数である。id があれば `#id`、なければ `tag:nth-of-type(n)` を上限の深さまでつなぐ。layout の側は、同じ親の子の番号を覚えておいて、速く数える。
  - 矩形の型: `RectangleEvidence` と `InteractionBoundingBoxEvidence`（`src/core/evidence-types.ts`）。項目（x、y、top、right、bottom、left、width、height）が同じで、並び順だけが違う。
- 方針と時期:
  - `selectorFor`: 共通化しない（2026-09-25 設計者の決定）。別々の `page.evaluate` の関数の中にあり、関数の外の値を参照できない。共通化には、関数の文字列を注入するなどの仕組みが要り、得られるものより複雑さが大きい。layout の側の、番号を覚えておく形は、多くの要素を調べるための速さの工夫である。
  - 矩形の型: `InteractionBoundingBoxEvidence` を `RectangleEvidence` の型の別名にする（C18p）。スキーマの定義は変えない。
- 状態: `selectorFor` は見送り。矩形の型は C18p で行う。
