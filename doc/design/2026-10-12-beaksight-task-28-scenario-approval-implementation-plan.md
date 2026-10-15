# BeakSight Task 28 シナリオの承認・保存・再承認 実装計画

作成日: 2026-10-12
設計書: `2026-10-12-beaksight-task-28-scenario-approval-design.md`（ユーザー承認済み 2026-10-12）

## 進め方

- 実装者は Opus で起動し、TDD（RED → 最小の実装 → GREEN）で進める。報告は日本語。
- 検証は、実装者は関係するテストだけ（`typecheck`・`typecheck:ui`・`build`、関係するテストのファイル、`npx vitest run tests/unit tests/architecture`）。`verify:ui`・`verify:all` は実装者に求めない。`verify:all` は T28R の承認の後に 1 回だけ設計者が流す。
- 書き込みの要求を送るコードは、この Task のどこにも作らない。

## サブタスク

| ID | 内容 | 主に変えるファイル | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| T28a | 契約・スキーマ・理由のコード・既定値の定数・承認の digest・再承認の判定（純粋。時計を注入） | `src/control/approval/`（新）、`schemas/control/scenario.schema.json`・`approval-receipt.schema.json`、`src/control/control-schema-validator.ts`（名前の行）、テスト | — | T28b と並行 |
| T28b | モードの拡張（`TEST_APPROVED_WRITE` で認証の設定・`DISCOVERY`・`READ_CHECK` を許す。`AUDIT` は今のまま） | `src/control/execution-policy.ts`、`src/control/auth/auth-setup-policy.ts`、`src/control/job/audit-job-manager.ts`（開始の判定の所だけ）、画面の出し分け（`apps/local-ui/src/` の該当の所）、テスト | — | T28a と並行 |
| T28c | 管理データの版 6（先に版 5 の文と CHECK の一覧を写しで固定）と、シナリオ・版の写し・承認の記録の保存（版の衝突、取り消したプロファイルの拒否、発見の根拠の写し） | `src/control/store/migrations.ts`、`src/control/approval/`（保存の部品）、`tests/architecture/control-store-boundary.test.ts`（許すファイルの一覧）、テスト | T28a | — |
| T28d | 実行の許可と予約（発行・消費・確かめ直し・撤回・入力の規則の参照を付ける口）、競合のテスト（`BEGIN IMMEDIATE`） | `src/control/approval/`、テスト | T28c | — |
| T28e | 画面（一覧・作成・詳細・承認・撤回・差分・履歴）と文言とカタログ、画面向けの公開し直し `src/control/approval-view.ts` | `apps/local-ui/`、`src/presentation/`、`src/control/approval-view.ts` | T28d | — |
| T28f | 目印の検査（シナリオの写し・承認の記録・画面）、回帰、手順書（`doc/spec/` に新しいファイルと索引） | `apps/local-ui/tests/`、`tests/`、`doc/spec/` | T28e | — |
| T28R | 独立レビュー | — | T28f | — |

## Gate（各サブタスクで足す）

- 承認が有効かの判定を owner（`approval-validity.ts`）の外に書かない。
- `src/control/approval/` が、ブラウザ・ワーカー・書き込みの要求を送る部品を import しない。
- 承認の記録の表に UPDATE・DELETE の文を書かない（追記だけ）。
