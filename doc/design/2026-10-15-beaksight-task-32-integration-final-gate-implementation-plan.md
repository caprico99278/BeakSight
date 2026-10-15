# BeakSight Task 32 全体統合・最終 Completion Gate 実装計画

作成日: 2026-10-15
状態: 確定（設計書 `2026-10-15-beaksight-task-32-integration-final-gate-design.md` のユーザー承認 2026-10-15）

## 1. 進め方

- 実装者・調査担当・レビュー担当は Opus で起動する。指示書は作業記録置き場に `<ID>-brief.md` として置く。
- 実装者は関係するテストだけを流す。`verify:all` は T32R の承認の後に 1 回だけ（ユーザーの指示）。揺らぎは記録し、流し直さない（ユーザーの判断 2）。
- 同じファイルに触れる実装者を同時に動かさない。並行にできる組は 3 章の表に書く。

## 2. サブタスク

| ID | 内容 | 主に変えるファイル | 依存 |
| --- | --- | --- | --- |
| T32a（DEF-110-fix） | Guard の close の失敗を、Context がもう存在しないと確かめられたときだけ違反にしない | `src/safety/passive-request-guard.ts`、`src/browser/context-factory.ts`（最小）、Guard のテスト | なし（進行中） |
| T32b（CCX-29） | CC-039、CC-087 の後半、CC-080 (b)(c) | `src/presentation/`、`src/report/html-report.ts`（参照だけ）、`src/cli/output.ts`、`src/control/worker-protocol.ts`、`src/control/contracts.ts`・`scenario-contracts.ts`、`apps/local-ui/src/`（画面の部品） | なし（進行中） |
| T32c | 報告の契約とスキーマ: `action-evidence.json`・`approval-summary.json` の型（`action-contracts.ts` または `action-report-contracts.ts`）、`schemas/action-evidence.schema.json`・`approval-summary.schema.json`、`schema-validator.ts`、`schema-enum-consistency` の表、名前（`artifact-layout.ts`） | 左のとおり | T32b の後（`contracts.ts` の重なりを避ける） |
| T32d | START の拡張: 親が `write.approvalFacts` を集めて入れる（`write-job-start.ts`、`audit-job-manager.ts` の準備）。IPC の契約とスキーマ | `src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`、`src/control/job/` | T32b・T32c |
| T32e | ワーカーが 2 つの JSON を書く（照合の READ の証拠と Guard の数を残す。`action-run.json` と同じ事実から 1 回だけ組み立てる） | `src/worker/write-create-run.ts`、`src/report/artifact-writer.ts`、`src/worker/read-check-run.ts`（証拠を返すだけなら変えない） | T32a・T32d |
| T32f | HTML と ZIP: `action-view-model.ts`、`action-report.ts`、`ACTION_REPORT_TEXT`、`deterministic-zip.ts`（`chatgpt-bundle.ts` から出す。監査のバンドルのバイト列が前と同じ）、`action-bundle.ts`、ワーカーから書く | `src/report/`、`src/presentation/messages.ts`、`src/worker/write-create-run.ts`（呼ぶ所だけ） | T32e |
| T32g | 親の確かめと画面の配布、台帳の画面: 締めで新しいファイルを確かめる、`artifact-files.ts` の許可の一覧と style の hash の名前の一覧、結果の画面の成果物の欄、台帳のルートと読み出しの口 | `src/control/job/audit-job-manager.ts`、`src/control/actions/write-result-facts.ts`、`apps/local-ui/src/` | T32f |
| T32h | 通しの E2E（設計書 4.2）と成果物を開く確かめ。人が開く確かめの項目の表の案 | `apps/local-ui/tests/full-flow.test.ts`（新規）、`tests/helpers/`（補助を足す場合） | T32g |
| T32i | 認証の対比（設計書 4.3） | `tests/integration/auth-mode-contrast.test.ts`（新規）、fixture の補助 | なし |
| T32j-1 | CC-050 と DEF-113: 段階×判定→動作と記録の関数、route の役割の明記、CDP の付いていない page の明示の理由、回帰のテスト | `src/safety/passive-request-guard.ts`、Guard のテスト | T32a |
| T32j-2 | CC-068 の共通化: ページの中で読む部品と型つきの組み立て、15 関数の置き換え、Gate | 新しい部品のモジュール、`src/evidence/`・`src/browser/`・`src/crawl/`・`src/interaction/`・`src/discovery/` のページの中の関数、`tests/architecture/` | T32j-1 と並行可（ファイルが重ならない範囲） |
| T32j-3 | 要素の橋渡しの調査（読み取りだけ。backendNodeId で isolated world に取り直す形を実機で） | なし（scratchpad） | なし |
| T32j-4 | ログインの form と候補の発見の読み取りを isolated world へ移す（偽りのテスト、結果の不変） | `src/browser/login-form-submitter.ts`、`src/interaction/discover-candidates.ts`、橋渡しの部品 | T32j-2・T32j-3 |
| T32k | `closePassivePage`・`closePassiveGuardedPage` の扱いと、CC-072・CC-081 の残り | `src/browser/context-factory.ts`、`src/orchestration/passive-session-close.ts`、テストの補助、`tests/architecture/` | T32a・T32j の後 |
| T32l | 文書（設計書 4.5）と匿名の設定の例 | `README.md`、`doc/spec/**`、`config/targets/`（例） | T32g・T32i の後（画面の手順を書くため） |
| T32m | 証拠のまとめ（設計書 4.8）: 対応表、検証の記録、残りのリスク | 作業記録（設計者）、`doc/spec/` のリスクの文書（T32l と合わせる） | T32h・T32l |
| T32R | 独立レビュー（通しの安全、書き込みの報告の秘密と人の値、CC-050・CC-068 の安全、文書と実際の一致）→ 修正 → 再レビュー → `verify:all` 1 回 | 読み取りだけ | T32a〜T32m |
| T32n | 実テスト環境（設計書 4.9）: 手順書の最終の確かめ、ユーザーへの事前の確かめ、ユーザーが起動しログイン、設計者が見張りと記録、書き込みの前で止めて諮る | 記録だけ | T32R、ユーザーの承認 |

## 3. 並行の組

- 今: T32a（Guard）と T32b（表示・プロトコル・画面の部品）は重ならない。
- T32i（新しいテストのファイルだけ）は、ほかのどれとも並行にできる。
- T32c は T32b の後（`src/control/contracts.ts` と `schema-enum-consistency` の重なり）。
- T32j は T32a の後（`passive-request-guard.ts`）。T32j と T32c〜T32g は、ブラウザの中の関数のファイル（`write-form-submitter.ts` など）が重ならない範囲で並行にする（指示書で範囲を分ける）。

## 4. 各サブタスクの受け入れ条件の要点

- T32c: 新しいスキーマが既存の契約の配列と一致（`schema-enum-consistency`）、承認の `bound` は `approval-receipt.schema.json` と `$ref` で共有（二重に定義しない）、秘密の項目を持たない（スキーマの `additionalProperties: false`）。
- T32e: `VERIFIED`・`PARTIAL`・`UNKNOWN`・`FAILED`・`BLOCKED` の各回で 2 つの JSON ができ、スキーマに合う。`action-run.json` と重なる値が一致。秘密の目印が出ない。人の値の印が UPDATE の変えた欄と READ の `observedValue` で真。両方の Chromium。
- T32f: HTML のエスケープ、注意の表示、UI Gate（文言・タグ・状態の文字列）、ZIP の決定論、監査のバンドルのバイト列が変わらない。
- T32g: 食い違う報告を配らない、許可の一覧の外のファイルを配らない、CSP を弱めない、台帳の画面の CSRF と表示。
- T32h: 設計書 4.2 のすべて。サーバに届いた書き込みの POST が CREATE 1・UPDATE 1、全部の後に 2 秒待って数え直す。
- T32i: 設計書 4.3 のすべて。両方の Chromium。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-10-15 | 初版 | 設計書の初版に合わせて作成。 | Task 32 |
| 2026-10-15 | CC-050・DEF-113・CC-068 のユーザーの判断 | T32j を T32j-1〜4 に分けた。 | 作業 F |
