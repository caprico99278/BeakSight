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

## CC-034 未完了の理由（`IncompleteReason`）の値の確かめの重複（2026-10-01 R1 の報告で登録）

- 場所と内容:
  - `src/orchestration/skipped-page.ts:36-41`: 理由のコードが `INCOMPLETE_REASON_CODES` にあり、`detail` が文字列か null かを、その場で確かめている。
  - `src/orchestration/crawl-frontier.ts` の `restoreEntry`（R1 で追加）: 保存から読んだ SKIPPED の理由を、同じ一覧で同じように確かめている。
  - 再開の機能の R2（保存の読み込み）でも、同じ確かめが要る見込み。
- 振る舞いの違い: なし（R1 の実装者の報告。設計者は未確認）。
- 方針: `src/core/contracts.ts` の近く（理由の閉じた一覧の owner）に、`isIncompleteReason` のような確かめの関数を1つ置き、3か所で使う。R2 では、新しく同じ確かめを書かず、この候補を先に片付けるか、R2 の指示書で扱い方を決める。
- 状態: 未着手（2026-09-23 のユーザー指示により、共通化はユーザーの明示の指示まで着手しない。ただし、新しいコードで同じ重複を増やさない。R2 の設計で扱いを決める）。

## CC-035 `route.abort('blockedbyclient')` の失敗の理由の文字列の重複（2026-10-01 L4 の報告で登録）

- 場所と内容:
  - `src/safety/passive-request-guard.ts:441`: Guard が自分で起こした main frame の失敗の照合に、`'net::ERR_BLOCKED_BY_CLIENT'` を文字列のまま書いている。
  - `src/browser/playwright-errors.ts`（L4 の Blocker の解消で追加）: `route.abort('blockedbyclient')` の失敗の理由の閉じた一覧（`net::ERR_BLOCKED_BY_CLIENT`、`net::ERR_BLOCKED_BY_CLIENT.Inspector`）。
- 振る舞いの違い: Guard の照合は main frame の文書の要求だけが対象で、Chromium は文書の要求では `.Inspector` の付かない理由を報告するので、今の照合は合っている（L4 の実装者の確認。iframe の文書は未確認）。
- 方針: Guard の照合も、`playwright-errors.ts` の一覧のうち文書の要求の値を参照する形にする。Guard の変更になるので、独立レビューの対象にする。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-036 ミリ秒と秒の換算の定数の重複（2026-10-01 R2 の報告で登録）

- 場所: `src/presentation/format.ts:56` の `MILLISECONDS_PER_SECOND`（表示の層、export されていない）と、`src/orchestration/run-checkpoint.ts` の同じ名前の非公開の定数（`os.uptime()` の換算）。
- 振る舞いの違い: なし（どちらも 1000）。
- 方針: `src/core/` に時間の換算の定数を1つ置き、両方で使う。小さいので、ほかの共通化と合わせて行う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-037 テストの見本の保存の組み立ての重複（2026-10-01 R3 の報告で登録）

- 場所: `tests/unit/run-checkpoint.test.ts:118` の `sampleRunState` と、`tests/unit/artifact-writer.test.ts` の `sampleCheckpoint`。frontier と採番器を動かして `createRunCheckpoint` に渡す処理が重なっている。
- 振る舞いの違い: 未確認。
- 方針: `tests/helpers/` に、保存の見本を作る補助を1つ置く。R4a の結合テストでも使う見込みがあるので、R4a で補助を作り、2か所を置き換えるかを R4a の指示書で決める。
- 状態: 未着手。

## CC-038 テストの「待たない関数」の重複（2026-10-01 RL-fix の報告で登録）

- 場所: `NO_PACING_WAIT`（`async () => 0`）を、`tests/component/layout-collector.test.ts`、`tests/integration/site-metadata.test.ts`、`tests/integration/stress-session.test.ts` の3か所にそれぞれ定義している。
- 振る舞いの違い: なし。
- 方針: `tests/helpers/navigation-pacer.ts` に1つ置き、3か所で使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-039 版の表示名が HTML レポートの文言の中にある（2026-10-01 R5a の報告で登録）

- 場所: `src/presentation/messages.ts` の `HTML_REPORT_TEXT.summary.toolVersion` と `HTML_REPORT_TEXT.summary.environment.playwrightVersion`。R5a で、CLI の「版が違うので再開できない」の文言の項目名にも使うようになった。
- 問題: コメントでは「HTML レポートだけで使う」とされていて、置き場所が表示面に偏っている。
- 方針: 複数の表示面で使う表示名を、`RUN_SUMMARY_TEXT` など、表示面に依らない置き場所に移す。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-040 保存からの巡回の記録の作り直しの引数が2か所にある（2026-10-02 R8 の報告で登録）

- 場所: `src/orchestration/run-coordinator.ts` の `restoredCrawlProgress`（`CrawlFrontier.restore` の引数の組み立て）と、`src/orchestration/run-checkpoint.ts` の `checkRunCheckpointConsistency` の作り直しの確かめ（R8）。あわせて、`run-coordinator.ts` の `RESUME_REQUEUE_SKIP_REASON_CODE_SET` と `run-checkpoint.ts` の `requeueSkipReasonCodes` が、同じ Set。
- 振る舞いの違い: なし（どちらも、保存の実効の設定の `maxDepth`・`allowedQueryParameters` と、`RESUME_REQUEUE_SKIP_REASON_CODES` を使う）。
- 方針: 保存から採番器と巡回の記録を作り直す関数を `run-checkpoint.ts` に置き、Run Coordinator と整合の確かめの両方がそれを使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-041 閉じたポートの origin を作るテストの補助が2つのテストにある（2026-10-05 SU1b の報告で登録）

- 場所: `tests/integration/page-navigation.test.ts` と `tests/integration/passive-session-close.test.ts` の `unusedLoopbackOrigin`。SU1b の `tests/integration/main-frame-load.test.ts` は、3つ目を作らず、テストのサーバを起動してすぐ閉じる形で、閉じたポートを作った。
- 振る舞いの違い: 未確認（同じ目的の補助）。
- 方針: `tests/helpers/` に1つ置き、3つのテストがそれを使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-042 safety が、HTTP の status の範囲を audit から import している（2026-10-05 DEF-029 の報告で登録）

- 場所: `src/safety/passive-request-guard.ts` が、`src/audit/rule-helpers.ts` の `ERROR_HTTP_STATUS_RANGE` と `isHttpStatusInRange` を import する（DEF-029。safety から audit への import は、これが初めて）。
- 問題: HTTP の status の範囲は、Rule だけの概念ではなく、safety と audit の両方が使う。下の層（safety）が上の層（audit）に頼る形になっている。循環はない。
- 方針: status の範囲の定数と判定を `src/core/` に移し、audit と safety の両方がそれを使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-043 接続を記録して閉じるときに切る、テストの中の 127.0.0.1 のサーバが、3つのテストにある（2026-10-05 SU2a の報告で登録）

- 場所: `tests/integration/main-frame-load.test.ts`、`tests/integration/page-navigation.test.ts`、`tests/integration/page-auditor-site-unavailability.test.ts`（DEF-029、DEF-027 の新しいテストにも、似た形があるかもしれない）。
- 振る舞いの違い: 未確認（同じ目的の補助）。
- 方針: `tests/helpers/` に1つ置く（応答しない、ヘッダの後に止める、503 などの場面を選べる形）。CC-041 と合わせて行う。
- 追記（2026-10-06 PC1 の報告）: `tests/integration/resource-delivery.test.ts` の、Range に 206 で答えるサーバ。`tests/component/context-factory.test.ts` の `startBodyServer`、`tests/integration/load-meter.test.ts` の `startCacheableServer` も似た形。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-044 Guard のテストの偽の Context と session が、2つのテストにある（2026-10-05 DEF-027-fix の報告で登録）

- 場所: `tests/integration/passive-request-guard.test.ts` の `createGuardHarness`（export されていない）と、`tests/integration/guard-external-cancel.test.ts` の偽の Context と session。
- 振る舞いの違い: 未確認（同じ目的の補助）。
- 方針: `tests/helpers/` に1つ置き、両方のテストがそれを使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-045 `page.goto` の結果を読み込みの終わり方（`MainFrameLoadSettlement`）に変える数行が、3か所にある（2026-10-05 SU3b の報告で登録）

- 場所: `src/orchestration/page-navigation.ts` の `settleNavigation`（公開していない）、`src/interaction/isolated-auditor.ts` の `loadInteractionTarget` の中、`src/crawl/site-metadata.ts` の `fetchMetadata` の中。
- 振る舞いの違い: なし（応答は `FULFILLED`、例外は `REJECTED`）。
- 方針: `src/browser/main-frame-load.ts` に、`goto` を包んで観測まで作る補助を1つ置き、3か所がそれを使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-046 ms と秒の倍率の定数が3か所にある（2026-10-06 D1 の報告で登録）

- 場所: `src/orchestration/run-checkpoint.ts`、`src/presentation/format.ts`、`src/browser/navigation-diagnostics.ts` の `MILLISECONDS_PER_SECOND`。
- 振る舞いの違い: なし（どれも 1000）。
- 方針: `src/core/` に1つ置き、3か所がそれを使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-047 「読み込みの期限と、今から timeout 後の早い方」の計算が 3 か所にある（2026-10-07 D3-fix-round-1 の報告で登録）

- 場所: `src/orchestration/passive-session-open.ts`（`passiveSessionOpenDeadlineAtMs`）、`src/interaction/isolated-auditor.ts`（session の作成と観察の開始）、`src/evidence/layout-collector.ts`（観察の開始）。
- 方針: `src/core/deadline.ts` に小さな補助を置き、3 か所がそれを使う（evidence と interaction は orchestration を import できないため）。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-048 「最後の実行」を選ぶ処理が 2 か所にある（2026-10-08 BN1 の報告で登録）

- 場所: `src/report/view-model.ts` の `executionsView`（`lastEndReason`。R9）と、`src/cli/output.ts` の `lastExecutionFinishedAt`（BN1。`run-command.ts` も使う）。
- 方針: 表示用モデルの `RunExecutionsView` に、最後の実行の終わりの時刻も持たせ（例: `lastFinishedAt`）、CLI はそれを使う。
- 状態: 未着手（共通化はユーザーの明示の指示まで着手しない）。

## CC-049 使わなくなったページを閉じる期限の項目の整理（2026-10-08 DEF-038 の設計で登録）

- 場所: `src/core/limits.ts` の `PAGE_CLOSE_TIMEOUT_MS`、`PassiveSessionCloseTimeouts.pageCloseTimeoutMs`、`src/orchestration/passive-session-open.ts` の `resolvePassiveSessionDeadlines`、関係するテスト。
- 内容: DEF-038 で、Guard の付いた Passive のページを個別に閉じなくなったので、production では使わない。テストの後片付けの関数（`closePassivePage` など）は残す。
- 追記（DEF-038-fix の報告）: 通らなくなった分岐とコメントもある。`stress-session.ts` の2件の失敗の `AggregateError` の分岐と 63・132 行のコメント、`page-auditor.ts` の `passive-page-close` のラベル・`closeFailureReasons` の `step === 'page'` の分岐・1181 行の `PassivePageCloseDeadlineError` の判定、`PassiveSessionCloseStep` の `'page'`、`PassivePageCloseDeadlineError`、`PASSIVE_PAGE_CLOSE_DEADLINE_MESSAGE`。
- 方針: 項目を除き、テストの後片付けも Context を閉じる形にそろえる。
- 状態: 未着手（ユーザーの明示の指示まで着手しない）。

## CC-050 Guard の CDP の横取りと Playwright の route の二重の判定（2026-10-08 DEF-042-fix で登録）

- 場所: `src/safety/passive-request-guard.ts` の `handlePausedRequest`（CDP。すべての要求）と `context.route('**/*')` の処理（Playwright。許可された要求だけが来る）。
- 内容: 判定は `classifyPassiveRequest` の 1 か所だが、呼ぶ場所が 2 つになった。route は、キャッシュから返す処理（`resourceDelivery`）と二重の網として残している。
- 方針: route の判定を「CDP が許可したものの確認だけ」に整理するか、route をキャッシュの処理だけにする。安全の境界の変更なので、独立レビューの後に判断する。
- 状態: 未着手（ユーザーの明示の指示まで着手しない）。

## CC-052 制御文字の正規表現（`/p{Cc}/u`）が 3 か所にある（2026-10-09 T22b の報告で登録）

- 場所: `src/core/artifact-layout.ts`（非公開）、`src/cli/output.ts`（非公開）、`src/control/profile-policy.ts`（U+2028・U+2029 を加えた版）。
- 方針: core の 1 か所（例: `src/core/text.ts`）に置き、3 か所が使う。
- 状態: 未着手（ユーザーの明示の指示まで着手しない）。

## CC-053 向きを変える文字と、対になっていないサロゲートの判定が 2 か所にある（2026-10-09 T22d の報告で登録）

- 場所: `src/interaction/isolated-auditor.ts`（非公開の `BIDI_CONTROL_PATTERN`（U+061C を含む）、`LONE_SURROGATE_PATTERN`）、`src/control/profile-policy.ts`（`EVIDENCE_BIDI_CONTROL_CHARACTER`、`isWellFormed()`）。
- 方針: `src/core/text.ts` などにまとめる（CC-052 の制御文字とあわせて）。
- 状態: 未着手（ユーザーの明示の指示まで着手しない）。

## CC-054 Architecture Gate の import の指定子の取り出し方が、2 つの Gate で違う（2026-10-09 T22R2 の Minor 1 で登録）

- 場所: `tests/architecture/semantic-ownership.test.ts` の GATE-ARCH08 (T22d) と、`tests/architecture/control-boundary.test.ts` の `moduleSpecifiersOf`（後者は `createRequire`、テンプレート、`new URL` も取り出す）。
- 方針: 取り出しを `tests/architecture/source-scan.ts` の共通の部品にし、両方の Gate で使う。
- 状態: 未着手（ユーザーの明示の指示まで着手しない）。

## CC-055 件数の飽和の加算と、取り消しの証拠の診断の照合が、複数の場所にある（2026-10-09 DEF-052-fix round 2 の報告で登録）

- 件数を安全な整数の上限で止める処理（`saturatingIncrement`、`saturatingAdd`）が `src/safety/safety-ledger.ts` の中にだけあり、Guard（`passive-request-guard.ts` の `#recordDroppedAtCapacity`）では `Math.min` で同じことを書いた。
- 取り消しの証拠の診断の文の照合（正規表現）が、`tests/integration/passive-request-guard.test.ts` と `tests/integration/guard-canceled-document.test.ts` に分かれている（変更の範囲の制約のため。テストの補助に置ける）。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-056 Architecture Gate の import をたどる関数が、2 つの Gate に重なっている（2026-10-09 T23e の報告で登録）

- `tests/architecture/control-boundary.test.ts` と `tests/architecture/local-ui-boundary.test.ts` が、import をたどる関数と指定子の正規表現の一部を、それぞれに持つ（`source-scan.ts` の `scanSource`、`findImportSpecifiers`、`loadSourceFiles` は共用）。CC-054 と関係する。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-057 `isOwnRunLock` が 2 か所にある（2026-10-09 T24c の報告で登録）

- `src/orchestration/run-checkpoint-session.ts` の非公開の `isOwnRunLock` と、T24c で `src/orchestration/run-checkpoint.ts` に足した `isOwnRunLock` が同じ意味。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-058 `--headless` に当たる設定の上書き `{ browser: { headed: false } }` が 2 か所にある（2026-10-09 T24d の報告で登録）

- `src/cli/arguments.ts` と `src/worker/audit-worker-session.ts` の `WORKER_CONFIG_OVERRIDES`。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-059 ファイルの内容の SHA-256 を求める部品が、IPC の契約の中にある（2026-10-09 T24h-1 の報告で登録）

- `src/control/worker-protocol.ts` の `targetConfigDigestOf`。`src/core/` に置けば、ほかの用途（成果物など）とも共有できる。ARCH06（SHA-256 は Finding の fingerprint の owner だけ）の除外も整理できる。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-060 認証済みの状態の型が 2 か所にある（2026-10-10 T25c の報告で登録）

- `src/browser/context-factory.ts` の `AuthenticatedStorageState` と、`src/control/auth/authenticated-state.ts` の `AuthenticatedState` が同じ形。監査の本体は `src/control/` を読めないため別に定義した。`src/core/` に置けば 1 つにできる。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-061 認証の設定の誤りの項目への振り分けが英語の詳細に頼る。テストだけのワーカーの入口が 2 か所にある（2026-10-10 T25e の報告で登録）

- `apps/local-ui/src/server/auth-setup-errors.ts` は、`validateAuthSetup` の誤りの英語の詳細の中の項目の名前で、表示の項目を決めている（検証が項目の位置を返す形のほうが壊れにくい）。
- `apps/local-ui/tests/helpers/auth-worker.ts` と `tests/integration/audit-worker-auth-fork.test.ts` のテストだけのワーカーの入口がよく似ている。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-062 rename のやり直しの決まりと、誤りのコードの取り出しが複数ある（2026-10-10 T26a の報告で登録）

- `src/control/credentials/credential-store.ts` の `CREDENTIAL_RENAME_*` と、`src/report/artifact-writer.ts` の `renameWithRetry`・`RENAME_*` が同じ意味。`artifact-writer.ts` は `src/safety/redact` を読み込むので、`control-boundary` の (b) により `src/control/` から使えない。`src/core/` に移せば 1 か所になる。
- `errorCodeOf` が `control-database.ts`、`contained-artifact-file.ts`、`artifact-writer.ts`、`credential-store.ts` の 4 か所にある。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-063 14 桁の UTC の日時を Date に読み戻す部品が `src/core/` にない（2026-10-10 T26c の報告で登録）

- `src/control/job/auto-login-limits.ts` の `dateOfCompactUtcTimestamp`。書く側の `formatCompactUtcTimestamp` と同じ `src/core/utc-timestamp.ts` に置くのが本来の形。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-064 ログインの送信先かの判定を包む関数の置き場所（2026-10-10 T26d-1 の報告で登録）

- `src/worker/login-stage-checks.ts` の `isLoginEndpointPost`（要求の判定の owner に残りの回数 1 の口を渡す）は、`src/browser/login-form-submitter.ts` からは層の都合で使えず、引数で受けている。本来の置き場所は `src/safety/request-policy.ts`。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-065 資格情報を保存できるプラットフォームの値と、起動のときの準備の手順が複数ある（2026-10-11 T26e の報告で登録）

- 保存できるプラットフォームの値（`'win32'`）が、`src/control/credentials/dpapi-protector.ts`、`credential-store.ts`、`apps/local-ui/src/server/credential-runtime.ts` の 3 か所にある。`credential-store.ts` が公開すれば 1 か所になる。
- 起動のときの準備（`removeTemporaryFiles` の後に `checkProtection`）が、`src/control/setup-local.ts` と `apps/local-ui/src/server/credential-runtime.ts` にある（画面のサーバは `setup-local.ts` を import できない）。`src/control/credentials/` に置けば 1 か所になる。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-066 フォルダの下のすべてのファイル（ZIP の中を含む）を目印で探すテストの補助が複数ある（2026-10-11 T26f の報告で登録）

- `apps/local-ui/tests/helpers/secret-markers.ts`（T26f）と、T25f・T26d-2 のテストの中の同じ意味の関数。テストの補助を 1 つにすれば、UTF-16LE や `-EncodedCommand` の読み方も共有できる。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-067 飽和する数の足し算と、ブラウザ自身の favicon の path の定数が 2 か所にある（2026-10-11 T26g-1 の報告で登録）

- `src/safety/passive-request-guard.ts` の `LoginStageMonitor` の `saturatingCount` と、`src/safety/safety-ledger.ts` の非公開の `saturatingIncrement`。
- `src/safety/request-policy.ts` の `BROWSER_DEFAULT_FAVICON_PATH` と、`tests/helpers/chromium.ts` の同じ名前の定数（テストは製品の定数を使えば 1 か所になる）。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-068 「標準の prototype の getter とメソッドで読む」処理が、ブラウザの中の関数ごとにある（2026-10-11 DEF-069-fix の報告で登録）

- `src/evidence/dom-collector.ts`、`src/interaction/discover-candidates.ts`、`src/browser/login-form-submitter.ts`（と DEF-072・073 の直しの後の collector）。`page.evaluate` の関数は外の関数を参照できないため、共有には文字列の組み立てや JSHandle の受け渡しが要る（CSP、型、evaluate の回数の代償）。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-069 NFKC と大文字小文字の畳み込みが 2 か所にある（2026-10-11 T27a の報告で登録）

- `src/discovery/classify.ts` の `foldText` と、`src/safety/request-policy.ts` の非公開の `unicodeFoldedPath`。`src/core/text.ts` に置けば 1 か所になる（`src/safety/` は `src/control/` からの間接の検査で import できない）。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## CC-070 発見のジョブの流れが、監査の中核の非公開の処理を書き写している（2026-10-11 T27d の報告で登録）

- 出力先の開始のロックと動いている Run の確かめ（`src/cli/audit-run.ts` の非公開の `acquireOutputStartLock`・`findActiveRun`）、セッションの切れの判定（`page-auditor.ts` の `#authSessionLostAfterNavigation`）、Link の Evidence から `INTERNAL_NAVIGABLE` の URL を取り出す処理（Run Coordinator の `internalNavigableLinks`）と、`src/worker/discovery-run.ts` の同じ意味の処理。画面の記録の型（`DiscoveryPageRecord` と `DiscoveryReadPageRecord`。純粋な部品の Gate のため 2 つ。型の一致はコンパイルで確かめる）。
- 扱い: 登録だけ。ユーザーの指示まで着手しない。

## 2026-10-11 の整理（`CC-plan.md`）

- 済み: CC-001〜033（`selectorFor` は見送りのまま）、CC-057（`core/process-lock.ts` の 1 か所。`run-checkpoint.ts` は公開し直すだけ）。
- 新しく見つけたもの: N1（誤りの文の取り出しの戻り。7 か所）、N2（`DATABASE_OPEN_FAILED` への振り分け 2 か所）、N3（秘密に見える名前の 3 つの方針）、N4（画面の側の control の値の直書き）、N5（ms の倍率の定数の増加）、N6（意図した重複）。
- 共通化の順とまとめ方、設計者の判断は `CC-plan.md` に書いた。CC-049 は共通化ではなく整理として残す。
- 2026-10-11 CCX-4: N3 は済み（`src/core/secret-query-names.ts` に 3 つの方針を名前つきで。Gate `secret-name-policies`）。
- 2026-10-11 CCX-2: CC-035 は済み（`BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT`）、CC-042 は Guard の側が済み（`src/core/http-status.ts`。`src/worker/automated-login.ts` の import は T27e の後）、CC-055・067 の前半は済み（`src/core/saturating-count.ts`）。Gate `safety-commonization`。新しい候補: `src/crawl/site-metadata.ts` の `MIN/MAX_SUCCESS_HTTP_STATUS`（`SUCCESS_HTTP_STATUS_RANGE` と同じ意味）、Guard の `NAVIGATION_ABORTED_ERROR_TEXT` を `playwright-errors.ts` へ。
- 2026-10-12 CCX-1: CC-034 と CC-040 は済み（`src/core/contracts.ts` の確かめの関数、`run-checkpoint.ts` の `restoreRunCheckpointCrawl`。Gate `incomplete-reason-ownership`）。
- 2026-10-12 CCX-5: CC-065 と N2 は済み（`credential-platform.ts`、`credential-preparation.ts`、`controlStoreFailureOf`。Gate (x)）。N1 は Phase 2 で `src/core/errors.ts` に同じ振る舞いの部品を足して置き換える。
- 2026-10-12 CCX-8: CC-037、038、041、043（一部。認証の fixture 3 つは残り）、044、055 の後半、067 の後半は済み（`tests/helpers/`）。
- 2026-10-12 CCX-6: CC-070 は済み（`src/orchestration/output-start-lock.ts`、`authenticated-run.ts` の `sessionLostUrlOf`、`run-coordinator.ts` の `internalNavigableUrlsOf`。Gate `run-lock-session-ownership`）。画面の記録の型 2 つは見送りのまま。新しい候補: `src/audit/cross-page-rules.ts` の同じ意味の否定の式（`INTERNAL_NAVIGABLE` と `normalized.ok`）、`src/control/job/job-store.ts` の同じ名前で意味の違う `isSessionLostUrl`（名前を変える候補）。

## CC-071 画面のテストの補助（`openPage` と CSP の記録、`tabTo`、`screenshot`）が、画面のテストのファイルごとにある（2026-10-12 T27f の報告で登録）

- `apps/local-ui/tests/` の `auth-ui-flows`、`credential-ui-flows`、`discovery-ui-flows` など。`apps/local-ui/tests/helpers/` に寄せる候補（Phase 2）。
- 2026-10-12 CCX-3: CC-052 と CC-053 は済み（`src/core/text.ts`。Gate `text-character-classes`）。`toWellFormed()` の置き換えを core に寄せるかは残り。

- CC-064・CC-069 の状態（2026-10-12）: 済み（CCX-15）。`isLoginEndpointPost` と `LOGIN_POST_METHOD` は `src/safety/request-policy.ts`（`ONE_REMAINING_POST` は非公開）。NFKC と大文字小文字の畳み込みは `src/core/text.ts` の `foldNfkcCase`。Gate は `text-character-classes` の (d) と `safety-commonization` の (d)。`login-form-submitter.ts` は `isAllowedAction` を引数で受ける形のまま（入力の部品が許可 Origin を知らずに済む）。
- CC-045・CC-047 の状態（2026-10-12）: 済み（CCX-7a・7b）。`page.goto` の終わり方は `src/browser/main-frame-load.ts` の `settleMainFrameLoad`、期限の早い方は `src/core/deadline.ts` の `deadlineWithinTimeoutAtMs`。Gate は `tests/architecture/load-deadline-commonization.test.ts`（除外 0）。テストの補助 `tests/integration/main-frame-load.test.ts` の `settleGoto` は同じ形の包みが残る（軽微。Gate は `src/` だけを見る）。

## CC-072 ジョブの管理のテストの補助が 5 つのテストファイルに重複している（2026-10-12 DEF-084 の報告で登録）

- `TEST_TIMING`、`waitForJob`・`waitForEnd`、`expectWorkersExited`、afterEach の子の終わりを待つ処理が、`tests/integration/control-audit-jobs*.test.ts`、`control-discovery-jobs.test.ts`、`control-read-check-jobs.test.ts` にある。`control-audit-jobs-auto-login.test.ts` の `countingFork` は、環境を記録する受け手を `createCountingFork`（`tests/helpers/worker-fork.ts`）に渡せる形にすれば共通化できる。
- 扱い: Phase 2 の共通化で行う。
- CC-058・059・062・063 の状態（2026-10-12）: 済み（CCX-11）。`src/config/config-overrides.ts` の `HEADLESS_CONFIG_OVERRIDES`、`src/core/ids.ts` の `sha256HexOfBytes`・`sha256HexOfText`（ARCH06 の除外 3 行を消した）、`src/core/rename-retry.ts` と `src/core/errors.ts` の `errorCodeOf`、`src/core/utc-timestamp.ts` の `parseCompactUtcTimestamp`・`dateOfCompactUtcTimestamp`（画面は読み戻せない値を「未観測」で表示）。Gate `core-small-parts-ownership`。

## CC-073 誤りのコードの取り出しが、ほかにもインラインで書かれている（2026-10-12 CCX-11 の報告で登録）

- `src/cli/audit-run.ts:732`、`src/config/load-config.ts:46`（`isFileNotFound`）、`src/core/artifact-layout.ts:281,309`、`src/core/process-lock.ts:181`。`src/core/errors.ts` の `errorCodeOf` を使えば 1 か所になる。
- 扱い: Phase 2 の共通化で行う。
- CC-054・CC-056 の状態（2026-10-12）: 済み（CCX-9）。`tests/architecture/source-scan.ts` の `findModuleReferences`（静的・副作用・動的 import、`require`、`createRequire`、`getBuiltinModule`、`new URL(…, import.meta.url)`）と `findImportChains`・`reachableFiles`。9 つの Gate を置き換え、規則 `module-references.test.ts`（指定子を取り出す正規表現を `source-scan.ts` の外に書かない）。CC-054 の「`control-boundary` は `new URL` も取り出す」は誤りだった（今回足した）。

## CC-074 Gate の相対パスの判定と、狭い取り出しの利用者（2026-10-12 CCX-9 の報告で登録）

- 指定子と相対パスの文字列リテラルを合わせる書き方（`literal.startsWith('./') || literal.startsWith('../')`）が 5 つの Gate にある。
- `findImportSpecifiers` の利用者（ARCH02/03/07、ui-ssot、text-character-classes、secret-name-policies、read-check-ssot、credential の (r)）は `require`・`createRequire` を見ていない。広い取り出しに変えるかは別に判断する。
- 扱い: Phase 2。

## CC-075 時間の単位の定数（`SECOND_MS`・`MINUTE_MS` など）が別々にある（2026-10-12 T28a の報告で登録）

- `src/control/job/auto-login-limits.ts` と `src/control/approval/scenario-contracts.ts`。CC-046（ms と秒の倍率）と合わせて `src/core/` に 1 つ置く。
- 扱い: Phase 2。

## CC-076 実際の method を求める式と `_method` の欄の名前の判定が 3 か所にある（2026-10-12 T28a の報告で登録）

- `src/discovery/classify.ts` に 2 か所、`src/control/approval/scenario-policy.ts` に 1 か所（`foldNfkcCase(name) === METHOD_OVERRIDE_FIELD_NAME`）。候補の契約の owner（`src/discovery/candidate-contracts.ts` など）に置く。
- 扱い: T28c か Phase 2（安全の判定に関わるので早めに）。

## CC-077 「JSON の写し → スキーマで確かめ → 凍結」の手順が 2 か所にある（2026-10-12 T28a の報告で登録）

- `src/control/read-check-policy.ts` と `src/control/approval/scenario-policy.ts`。
- 扱い: Phase 2。

## CC-078 発見の索引・READ の定義の、トランザクションの中で使える読み出しがない。鍵を並べた JSON の作りが 2 か所（2026-10-12 T28c の報告で登録）

- `scenario-store.ts` は、`readDiscoveryIndex` が自分でトランザクションを開くため、`discovery_jobs` の rowid と `read_checks` の列を直接 SELECT して確かめ直している。索引と READ の定義の owner が、トランザクションの中で使える読み出しを公開すれば 1 か所になる。
- 鍵を並べた JSON（`withSortedKeys`）が `src/control/worker-protocol.ts`（非公開）と `src/control/auth/auth-setup-digest.ts` にある。`src/core/` に置く。
- 扱い: Phase 2。

## CC-079 トランザクションの中で使う書き込みの関数を、ファイルの間で受け渡せない（2026-10-13 T28d の Blocker で登録）

- Gate `control-store-boundary` の (g) は、SQL を書くファイルが `withWriteTransaction` の外から届く書き込みの宣言を公開することを違反にする。そのため、表の書き込みを複数の部品に分けると、同じトランザクションで別の部品の書き込みを呼べない。今は 1 ファイル（`scenario-store.ts`）に集めて避けた。
- 扱い: Gate を弱めずに、トランザクションの口（接続を受け取る書き込みの関数を、トランザクションの中からだけ呼べる型にする、など）の決まりを、必要になったときに設計する。CC-078 と合わせて考える。
- CC-073・CC-076・CC-078 の後半の状態（2026-10-13）: 済み（CCX-12）。`errorCodeOf` を 5 か所で使う（Gate `core-small-parts-ownership` の (c) を広げた）、`src/discovery/candidate-contracts.ts` の `isMethodOverrideFieldName`・`effectiveFormMethodOf`（Gate (f)）、`src/core/sorted-keys-json.ts` の `sortedKeysJsonOf`（Gate (e)）。残り: `src/safety/egress-proxy.ts` の型つきの `error.code` の比べ、`probe.ts`（ブラウザの中の関数）の `_method` の比べは `toLowerCase` で NFKC でない（全角の `＿ｍｅｔｈｏｄ` は `METHOD_OVERRIDE_UNRECOGNIZED` になり止める側。ブラウザの中なので owner を使えない）。CC-078 の前半（トランザクションの中で使える読み出し）は残り。

## CC-080 シナリオの画面まわりの重複（2026-10-13 T28e の報告で登録）

- 承認の外の事実（ターゲットの設定と認証の設定の digest）の求め方が `apps/local-ui/src/server/scenario-facts.ts` にある。Task 30 のジョブの管理も同じものが要るので、`src/control/` の 1 か所に移す。
- 候補の画面・READ の画面・シナリオの画面に、プロファイルの要点の欄と、欄の属性・制約の文字の組み立てが重複している。
- `WRITE_AUDIT_MODE` が Node の部品を読み込むファイルにあり、ブラウザから使えない。
- 扱い: (a) は Task 30 の前、(b)(c) は Phase 2。

## CC-081 画面の端から端の目印の検査の流れが、テストのファイルごとにある（2026-10-13 T28f の報告で登録）

- `apps/local-ui/tests/discovery-secret-markers.test.ts`（T27g）と `scenario-approval-secret-markers.test.ts`（T28f）に、`authSetupOf`、`prepareProfile`、`registerCredentialOnPage`、`credentialsOf`、ジョブの終わりの待ち、`screenPlaces`、`functionPlaces`、`searchedPlaces` が同じ意味で書かれている。T28e の `scenario-secret-markers.test.ts` とも重なる。`apps/local-ui/tests/helpers/` に「画面の端から端の目印の検査の流れ」の補助としてまとめる。
- 扱い: Phase 2（CC-066・071 と合わせて）。

## CC-082 Task 29 の初めの重複（2026-10-13 T29a・T29b の報告で登録）

- 欄の名前の語の並びの一致と ASCII の語の判定が、`src/discovery/classify.ts`（非公開。`fieldNameHasDestructiveWord` の中）と `src/control/data-rules/external-delivery-words.ts` にある。`classify.ts` に「欄の名前が語の一覧の語に当たるか」を公開すれば 1 か所になる。
- Gate の「import をたどって禁じた層に届かない」検出の関数が、`approval-ssot.test.ts` と `data-rules-boundary.test.ts` でほぼ同じ形（`source-scan.ts` に寄せる）。
- 日付の読み書き（`YYYY-MM-DD`・ISO の週・時刻）が `generic-rules.ts` にあり、増えたら `src/core/` にまとめる。
- 扱い: 1 つ目は T29c で（語の判定を足すので）、ほかは Phase 2。CC-077（スキーマで確かめた凍結した写し）にも `rule-set-policy.ts` が加わった。

## CC-083 基準日（Asia/Tokyo の `YYYY-MM-DD`）の計算が 2 か所にある（2026-10-13 T30e で発見）

- 場所: `src/control/job/write-job-start.ts` の `writeBaseDateOf` と、`apps/local-ui/src/server/data-rule-functions.ts` の `exampleBaseDate`。
- 案: `src/core/`（日時の書式の owner）か `src/control/data-rules/` に 1 つ置き、両方が使う。
- 扱い: Phase 2。

## CC-084 `ACTION_RUN_ARTIFACT_FILE_NAME` が成果物の名前の owner の外にある（2026-10-13 T30e で発見）

- 場所: `src/control/job/write-job-start.ts`。ほかの成果物の名前は `src/core/artifact-layout.ts`。
- 案: `src/core/artifact-layout.ts` に移す。T30f がワーカーの側で同じ名前を使うので、そこで重ねないこと（T30f は `write-job-start.ts` から import するか、移すなら報告）。
- 扱い: T30f か Phase 2。

- CC-077・CC-078 の前半の状態（2026-10-13）: 済み（CCX-17）。`src/control/schema-checked-copy.ts`、`readDiscoveryIndexIn`・`noDiscoveryJobRecordedAfterIn`・`listReadChecksIn`、Gate `control-read-ownership`。残り: スキーマで確かめない JSON の写し（`scenario-store.ts` の `draftCopyOf`、`rule-store.ts`）、CC-079。

- CC-066・CC-071・CC-081 の状態（2026-10-13）: 済み（CCX-16）。`apps/local-ui/tests/helpers/ui-page.ts`・`scenario-marker-flow.ts`・`secret-markers.ts`、Gate `ui-test-helper-reuse`。残り: T25f・T26f の端から端の流れ、画面のテストの `started`・`rootOf`・`callFunction` など（CC-072 と合わせて）、`dev-server`・`launcher-server` の CSP の確かめ。

- CC-072 の状態（2026-10-13）: 済み（CCX-18）。`tests/helpers/job-test-support.ts`、`worker-fork.ts` の `createCountingFork({ onFork })`、Gate `control-test-helper-reuse`。残り: 偽のワーカーの引数の組み立て、`managerWith`、テストの値の定数、`tests/unit` の同じ形の待ち。

- CC-046・CC-075・CC-048 の状態（2026-10-13）: 済み（CCX-19）。`src/core/time-units.ts`、`RunExecutionsView.lastFinishedAt`、Gate `time-units-ownership`。残り: T30g の `write-job-functions.ts` の `MINUTE_MS`（Gate の除外 1。T30g の後に置き換える）。

- CC-065・CC-083 の状態（2026-10-13）: CC-065 は CCX-5 で済み（`credential-platform.ts` の `CREDENTIAL_PLATFORM`、`credential-preparation.ts` の `prepareCredentialStorage`。本文の「登録だけ」は古い）。CC-083 は済み（CCX-20。`src/core/base-date.ts`）。送れる欄の型の一覧 `VALUE_INPUT_FIELD_TYPES` も CCX-20 で寄せた。

## CC-085 Run Coordinator が外から pacer を受け取れない（2026-10-13 DEF-102 fix の報告で登録）

- 監査（AUDIT）のジョブは、自動ログインの後、ワーカーの側でログインの段の pacer で待ってから Run Coordinator を始めている。Run Coordinator（`src/orchestration/`、`src/cli/audit-run.ts`）が pacer か記録を受け取る形にすれば、待ちの置き換えができる。
- 扱い: Phase 2。

- CC-049・CC-085 の状態（2026-10-14）: CC-085 は済み（CCX-22）。CC-049 は大部分が済み（CCX-21）。残り: `run-coordinator.ts` の page の場面の名前 2 つ・`step === 'page'`・コメント、`PassiveSessionCloseStep` の `'page'`、`closePassivePage`・`closePassiveGuardedPage`（T30R-fix-1 の後に判断）。

## CC-086 スキーマの誤りの位置を構造で返さない（2026-10-14 CCX-23 の報告で登録）

- `src/core/schema-validator.ts` の誤りは文（`describeSchemaError`）だけで、instancePath と、なくなった項目の名前を構造で返さない。CCX-23 fix round 1 では、認証の設定の検証が文の形から位置を作る。schema-validator が位置を返せば、その組み立てがなくなる。
- 扱い: Phase 2。
- CC-049・CC-061 の状態（2026-10-14）: CC-049 は済み（CCX-21・CCX-23。残りは `closePassivePage`・`closePassiveGuardedPage` の判断だけ）。CC-061 のテストだけのワーカーの入口は済み（`tests/helpers/test-login-worker-entry.ts`。`write-job-harness.ts` の 3 つ目の写しは残り）。誤りの位置は CCX-23 fix round 1。

## CC-087 JSON Pointer の書き方と戻し方が 2 か所。規則の誤りの位置を文字列で置き換える所がある（2026-10-14 CCX-24 の報告で登録）

- 書く側は `src/core/schema-validator.ts` の `escapeJsonPointerSegment`（Ajv を読み込むファイル）、戻す側は画面の `apps/local-ui/src/server/auth-setup-errors.ts` の `segmentsOf`（ブラウザと共用で Node の部品を読めない）。純粋な `src/core/json-pointer.ts` に両方を置けばまとめられる。
- `src/control/worker-protocol.ts` の 780 行あたりは、自分で作った規則の誤りの文の位置の前置き（`/readChecks/0`）を `/write/readVerification` に文字列で置き換えている。誤りを位置つきで作る形にすれば、置き換えがなくなる。
- 扱い: Phase 2。CC-086 の状態: 済み（CCX-24）。

## CC-088 Gate の既定の import の見分けが `write-stage-boundary` の中にある（2026-10-14 T30R-fix-1 の報告で登録）

- `tests/architecture/write-stage-boundary.test.ts` の `staticClauseOf` を、`tests/architecture/source-scan.ts` の `ModuleReference` に寄せる（例 `defaultBinding` を持たせる）。CC-074 と合わせて考える。
- 扱い: Phase 2。

- CC-087 の前半の状態（2026-10-14）: 済み（CCX-25・CCX-26）。後半（`worker-protocol.ts` の位置の前置きの文字列の置き換え）は残り。
- CC-088 の追記（2026-10-14 T30R2-fix-1）: Gate (e2) の `closingParenthesisOf` が `source-scan.ts` の内部の `matchingParenthesis` と同じ処理。export して共用する。

## CC-089 `scanSource` の冒頭の走査が重い（2026-10-14 DEF-107 fix の報告で登録）

- `tests/architecture/source-scan.ts` の `scanSource` は、`src/`（約 210ms）と `apps/local-ui/`（約 72ms）の走査に時間がかかる。速くすれば、すべての Gate の時間が縮む。
- 扱い: Phase 2。
- CC-089 の状態（2026-10-14）: 済み。

- T31f の共通化の候補の状態（2026-10-14）: 1（型に ID を入れる）・3（ID の形の一致）・4（使われない `readWriteGenerationHistory`）は済み（CCX-28）。2（`fieldsMatchedOf` を `action-outcome.ts` へ）は T31g-2。

## 2026-10-15 の状態（CCX-29。Task 32）

- CC-039: 済み。版の表示名は `RUN_SUMMARY_TEXT.toolVersion`・`RUN_SUMMARY_TEXT.playwrightVersion`。`html-report.ts` と `cli/output.ts`（`RUN_VERSION_FIELD_LABELS`）が使う。固定のテストは `html-report.test.ts` の CCX-29 の 1 件。
- CC-080: (a) は済み（前から）。(b) 済み: `apps/local-ui/src/components/ProfileSummary.tsx`（候補・READ・シナリオの画面）、`apps/local-ui/src/display/candidate-fields.ts` の `candidateFieldFlagsText`・`candidateFieldConstraintsText`（候補の画面、`ScenarioForm`、シナリオの詳細、`DataRuleForm`）。固定のテストは `apps/local-ui/tests/profile-field-summary.test.ts`。(c) 済み: `WRITE_AUDIT_MODE` の定義は import のない `src/control/contracts.ts`。ブラウザで値が要るときはここから直接読む（`approval-view.ts` を通すと Node の部品に届く）。
- CC-087 の後半: 済み。`worker-protocol.ts` の `readCheckItemRuleErrors(at, readCheck, duplicate)` が位置の区切りを引数に取り、`jsonPointerOf` で組み立てる。文字列の置き換えはなくなった。固定のテストは `worker-protocol-read-check.test.ts`・`worker-protocol-write.test.ts` の CCX-29 の 2 件。

## CC-090 スキーマのテストの補助が 3 つのテストに重複（2026-10-15 T32c の報告で登録）

- `tests/unit/action-run-schema.test.ts`・`action-evidence-schema.test.ts`・`approval-summary-schema.test.ts` に、`$ref` の先の解決 `resolveRef`、項目の名前の走査 `propertyNamesOf`、秘密の語の一覧 `SECRET_PROPERTY_WORDS` がある。`tests/unit/helpers/` に出す候補。
- 扱い: Task 32 の T32k（テストの補助の残り）で片付ける。

## CC-091 fork のワーカーのテストの補助の重複（2026-10-15 T32i の報告で登録）

- `tests/integration/auth-mode-contrast.test.ts` と自動ログインの fork のテスト（`audit-worker-automated-login-fork.test.ts`）に、テストだけのワーカーの入口の本文（`testLoginWorkerEntrySource`・`ENTRY_SOURCE`）と、`filesUnder`・`tableText`・`leakedPlaces`・`nonReadRequestsOf` がほぼ同じ形である。`tests/helpers/` に移す候補。
- 扱い: Task 32 の T32k で、CC-090 とあわせて片付ける。
- CC-050 の状態（2026-10-15）: 済み（T32j-1）。`decideGuardRequest` と `recordGuardVerdictBeforeBlock` を CDP の 2 か所と route が使う。判定 `classifyPassiveRequest` は 1 か所のまま。route の役割（CDP の付いていない page の網と、キャッシュの返し）をコードに明記。
- CC-068 の状態（2026-10-15）: 1（部品と型つきの組み立てと Gate）は済み（T32j-2。`src/browser/in-page-readers.ts`）。2（ログインの form と候補の発見の isolated world への移行）は T32j-4。

## CC-092 要素のメソッドを `Element.prototype.xxx.call(...)` で呼ぶ書き方が、ページの中の関数ごとにある（2026-10-15 T32j-2 の報告で登録）

- 部品にすると、配列の展開か `bind` が要り、ページの JS が書き換えられる入口が増える（T32j-2 の数えるテストの対照で `bind` 1 回の増加を検出した）。
- 扱い: 共通化しない（安全の側を優先）。理由とともに記録だけ。共通化するなら引数の個数ごとの形にする。
- CC-090 の状態（2026-10-15）: 済み（T32k）。`tests/helpers/schema-test-support.ts`、見本は `tests/helpers/approval-facts-sample.ts` の `sampleApprovalSummary` と `tests/helpers/action-report-samples.ts` の `sampleExecutedRead`。
- CC-091 の状態（2026-10-15）: 済み（T32k）。`tests/helpers/leak-places.ts`、`tests/helpers/auto-login-worker-entry.ts`。残り: `discovery-job-fork` の入口の本文（形が大きく違う）。

## CC-093 `READ_METHODS` の写しが結合のテストの約 8 ファイルに残る（2026-10-15 T32k の報告で登録）

- `automated-login*`・`discovery-*` などのテスト。`tests/helpers/leak-places.ts` の 1 か所にまとめる。`filesUnder` は `resume-run`・`artifact-writer` のテストに別の意味の同じ名前がある（寄せない）。
- 扱い: 余力があれば Task 32 の中で。
