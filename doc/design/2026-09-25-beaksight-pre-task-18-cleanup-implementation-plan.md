# BeakSight Task 18 の前の整理 実装計画

作成日: 2026-09-25
設計書: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md`

## 1. 目的

設計書の第4〜8章を、実装者1人が1回の起動で終えられる大きさのサブタスクに分けて行う。

## 2. サブタスクの分け方と順序

| ID | 内容 | 主に変えるファイル | 前提 |
| --- | --- | --- | --- |
| P18a | DEF-008 の部品と、Interaction 以外の呼び出し元。期限の注入（R15r-4） | `src/core/limits.ts`、`src/orchestration/passive-session-close.ts`、新規 `passive-session-open.ts`、`preflight.ts`、`environment.ts`、`stress-session.ts`、`src/crawl/site-metadata.ts` | R17r |
| P18b | CC-015 と CC-028（Safety の型） | `src/core/contracts.ts`、`src/safety/safety-ledger.ts` | R17r |
| P18c | DEF-008 の Page Auditor と Interaction の呼び出し元 | `src/orchestration/page-auditor.ts`、`src/interaction/isolated-auditor.ts`、`src/evidence/layout-collector.ts` | P18a |
| P18d | DEF-009 と R15r-3（Run Coordinator） | `src/orchestration/run-coordinator.ts`、`src/cli/`（文言と終了コードの経路） | P18a |
| RP18 | Guard の独立レビュー（P18a〜P18d の全体） | なし（読み取り専用） | P18c、P18d |
| P18e | RP18 の指摘1〜3の修正、CC-025、CC-028 の残り、期限の検証の置き場所、テスト補助の期限、BOM の表記 | `src/orchestration/environment.ts`、`stress-session.ts`、`run-coordinator.ts`、`src/core/deadline.ts`、`src/safety/safety-ledger.ts`（型）、テスト | RP18 |
| RP18r | RP18 の指摘の修正の確認のレビュー | なし（読み取り専用） | P18e |

- P18a と P18b は、変えるファイルが重ならない。そのため、並行で行ってよい。
- P18c と P18d も、変えるファイルが重ならない。そのため、並行で行ってよい。
  - ただし、P18d で理由のコードを加える場合は、`contracts.ts`、スキーマ、`messages.ts` に触れる。P18c は、これらに触れない。
- 並行で行う場合は、両方の指示書に、並行であることを書く。
  - 両方とも `npm run verify` を実行しない。verify は、設計者が行う。

## 3. 各サブタスクの要点

### P18a

- `CONTEXT_CLOSE_TIMEOUT_MS` と `SESSION_OPEN_TIMEOUT_MS` を、`limits.ts` に置く。
- 部品を作る（設計書 4.3）。
  - `closePassiveContextBeforeDeadline`
  - `openPassiveSessionBeforeDeadline`
  - 遅れて届いた Context を閉じる処理
- PREFLIGHT、環境、サイトの metadata、幅の走査の Context と page を、部品を使う形にする（設計書 4.4）。
- 期限を注入できるようにする。DEF-006 の既存のテストも、短い期限を注入する形に直す。
- テスト: 作成と終了が終わらない偽の factory で、各呼び出し元が期限の中で戻ることを確かめる。

### P18b

- 設計書 第5章のとおりにする。型だけの変更である。
- 振る舞いと JSON の形が変わらないことを、既存のテストで確かめる。

### P18c

- Page Auditor の Context と page の作成と終了を、P18a の部品を使う形にする。
- Interaction の session の作成と、`failClosed` を待つ処理に、期限を付ける（設計書 4.4）。
- テスト: 偽の factory で、ページの監査が期限の中で終わり、正しい理由が付くことを確かめる。

### P18d

- 設計書 第6章（DEF-009）と第7章（R15r-3）のとおりにする。
- CLI は、Run のディレクトリを作れなかった場合に、日本語の文言と終了コード 1 で終える。
- R17r の Minor-1・2 も行う。
  - `src/cli/index.ts` の後始末のコメントを、実装に合わせて直す。
  - 本番の `run` が `finishAuditRun` を通ることを、固定するテストを加える。

### RP18

- 設計書 4.5 のとおり。
- P18b の型の変更も、対象に含める。

### P18e

- 設計書 第8章のとおりにする。
- R17r の Minor-3 も行う。BOM を `'\uFEFF'` と書く形に直す（`load-config.ts`、`config.test.ts`）。
- P18a の報告の残りも行う。
  - `passiveTimeoutMs`（期限の値の検証）を、`src/core/deadline.ts` に、汎用の名前（例: `resolveTimeoutMs`）で移す。
  - `tests/helpers/passive-cleanup.ts` の `closePassiveResources` の期限（5秒）を、注入できる形にする。
- CC-028 の残りも行う（P18b の報告の判断1）。
  - 数えられなかった遮断の分類の名前を、閉じたテンプレートの型にする。
  - `#reachedCategories` の型を、`SafetyLedgerRecordCategory` とその型の和にする。
  - 値、JSON、既存のテストは変えない。
- RP18 の指摘があれば、あわせて直す。

## 4. 共通の受け入れ条件

- TDD（RED → GREEN → 関連する検証）で進める。
- 共通部品台帳の部品を使い、同じ意味の処理を新しく書かない。
- 期限のテストは、実際の時間を待たない。
- `npm run verify` が PASS する。並行作業の場合は、設計者が実行する。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | 初版 | - | Task 18 の前の整理 |
| 2026-09-25 | RP18 | P18e に RP18 の指摘1〜3を加えた。Important があるので、確認のレビュー RP18r を加えた | P18e、Task 18 |
| 2026-09-25 | R17r | P18d に R17r の Minor-1・2、P18e に Minor-3 を加えた | P18d、P18e |
