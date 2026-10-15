# BeakSight Task 29 LLM なしの自然な業務データの生成 実装計画

作成日: 2026-10-13
設計書: `2026-10-13-beaksight-task-29-natural-data-rules-design.md`（ユーザー承認済み 2026-10-13）

## 進め方

- 実装者は Opus で起動し、TDD（RED → 最小の実装 → GREEN）で進める。報告は日本語。
- 検証は、実装者は関係するテストだけ（`typecheck`・`typecheck:ui`・`build`、関係するテストのファイル、`npx vitest run tests/unit tests/architecture`）。`verify:ui`・`verify:all` は実装者に求めない。`verify:all` は T29R の承認の後に 1 回だけ設計者が流す。
- 書き込みの要求を送るコードは、この Task のどこにも作らない。生成と判定は純粋な関数にする。

## サブタスク

| ID | 内容 | 主に変えるファイル | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| T29a | 契約・スキーマ・理由のコード・意味の種類の閉じた一覧・欄どうしの関係の閉じた一覧・規則の集まりの digest・外部到達の語の一覧（owner 1 か所） | `src/control/data-rules/`（新）、`schemas/control/data-rule.schema.json`、`src/control/control-schema-validator.ts`（名前の行）、テスト | — | T29b と並行 |
| T29b | 決定的な値の取り出しの部品（seed とカウンタ、偏りのない範囲）、汎用の規則（数値・日時・選択・色）、辞書（姓・名とフリガナ、備考の文例、商品名。JSON のデータ）と辞書の固定のテスト | `src/control/data-rules/deterministic-stream.ts`・`generic-values.ts`・`dictionaries/`（新）、テスト | — | T29a と並行 |
| T29c | 業務テンプレート（顧客・予約・商品）、欄の判定（`NEEDS_RULE_INPUT`・`RULE_CONFLICT`・外部到達）、優先順位、欄どうしの関係、メール（`example.invalid`）と電話（`090-0XXX-XXXX`）、一意性の作り直し、`generateScenarioData`・`evaluateRuleSet` | `src/control/data-rules/`、テスト | T29a・T29b | — |
| T29d | 版 6 の写しの固定と版 7（`rule_sets`・`rule_set_revisions`）、規則の保存（追記だけ）、シナリオへの参照の付け直し（2 段）、`currentFactsIn` が規則の最新の版を読む、許可の発行で規則の不足を拒む、Gate | `src/control/store/migrations.ts`、`src/control/data-rules/rule-store.ts`（新）、`src/control/approval/scenario-facts.ts`・`scenario-store.ts`、`tests/architecture/` | T29c | — |
| T29e | 補完の画面（欄ごとの状態、意味の種類、固定の値、範囲、関係、一意にする欄の組、データ例（送らない）、保存で再承認）と文言 | `apps/local-ui/`、`src/presentation/`、`src/control/data-rules-view.ts`（新） | T29d | — |
| T29f | 目印の検査、LLM 依存 0 の Gate、`Math.random` の Gate、回帰、手順書（`doc/spec/` に新しいファイル） | `apps/local-ui/tests/`、`tests/`、`doc/spec/` | T29e | — |
| T29R | 独立レビュー | — | T29f | — |
