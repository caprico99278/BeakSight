# BeakSight Task 19 の前の整理 実装計画

作成日: 2026-09-25
設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md`

## 1. 目的

設計書の第4章と第5章を、実装者1人が1回の起動で終えられる大きさのサブタスクに分けて行う。

## 2. サブタスクの分け方と順序

| ID | 内容 | 主に変えるファイル | 前提 |
| --- | --- | --- | --- |
| C18a | DEF-012 の Guard の検出と記録。Ledger、Evidence の型、スキーマ、カタログ、文言、Safety の Rule | `src/safety/passive-request-guard.ts`、`src/safety/safety-ledger.ts`、`src/browser/context-factory.ts`（headed の受け渡しに限る）、`src/core/evidence-types.ts`、`schemas/`、`src/presentation/`、`src/audit/safety-rules.ts` | R18 |
| C18b | GATE-S03 の拡張と独自のスキームの fixture。R18-M2（S08） | `tests/integration/safety-gates.test.ts`、`fixtures/site/*` | C18a |
| C18c | 小さな修正: R18-M1、R18-参考、RP18r-M1・M2、BOM、CC-030 | `tests/architecture/`、`src/audit/safety-rules.ts`（名前だけ）、`src/orchestration/preflight.ts`、`page-auditor.ts` か `layout-collector.ts`、`tests/unit/text.test.ts` | C18a |
| RC18a | Guard の独立レビュー（C18a・C18b） | なし（読み取り専用） | C18b |
| C18g | RC18a の指摘1・3・4: サーバのリダイレクトを止めて記録する。GATE-S03 にこの経路を加える | `src/safety/passive-request-guard.ts`、`src/safety/safety-ledger.ts`、`src/core/evidence-types.ts`、スキーマ、`tests/integration/safety-gates.test.ts`、`fixtures/server.ts` か `fixtures/site/*` | RC18a |
| C18f | RC18a の指摘2: 違反の後は、監査を続けない | `src/orchestration/run-coordinator.ts`、`page-auditor.ts`、`src/interaction/isolated-auditor.ts`、理由のコード（contracts、スキーマ、messages） | RC18a |
| C18h | DEF-013: リダイレクトの対応付けの期限を、応答を受けた時点から数える | `src/safety/passive-request-guard.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/integration/external-scheme-navigation.test.ts` など | C18g、C18f |
| RC18b | C18g・C18f・C18h の Guard の確認のレビュー | なし（読み取り専用） | C18h |
| C18i | RC18b の N1（OOPIF の横取り）と N2（幅の走査の理由） | `src/safety/passive-request-guard.ts`、`src/orchestration/page-auditor.ts`、テスト | RC18b |
| RC18c | C18i の Guard の確認のレビュー | なし（読み取り専用） | C18i |
| C18d | CC-029（テストの補助の共通化）と、共通のハブのページ | `tests/helpers/`、`tests/integration/*`、`fixtures/site/*` | RC18c、C18c |
| C18e | CC-008 の残りと、CC-010 の残り（CC-010 は、まず調べて報告する） | `src/interaction/discover-candidates.ts`、`src/interaction/isolated-auditor.ts` など | C18d |
| C18k | CC-031（C18d の後に残ったテストの補助の重複） | `tests/unit/cli.test.ts`、`tests/integration/report-generation.test.ts`、`environment.test.ts`、`tests/component/discover-links.test.ts`、`fixtures/server.ts`（コメントと宛先）など | C18d（C18e と並行） |
| C18k-fix-round-1 | C18k の報告への判断: 宛先の値を `fixtures/external-scheme-targets.ts` に移す（`fixtures/` から `tests/` を import しない）。`slow-redirect` の `QUIET_PERIOD_MS` | `fixtures/`、`tests/helpers/external-scheme-fixture.ts`、`tests/unit/external-scheme-fixture.test.ts`、`tests/integration/slow-redirect.test.ts` | C18k（C18e と並行） |
| C18n | CC-010 の残りの1: Interaction の理由をコードと詳細に分ける（Evidence、スキーマ、`isolated-auditor.ts`）。`domWork.exhausted` を消す（設計書 5.1） | `src/core/evidence-types.ts`、`schemas/page.schema.json`、`src/interaction/isolated-auditor.ts`、`src/interaction/discover-candidates.ts`（1か所）、`src/report/view-model.ts`（型を通すだけ）、Interaction とスキーマのテスト、`tests/helpers/audit-run-fixture.ts` | C18e |
| C18o | CC-010 の残りの2: Interaction の理由の日本語の説明と表示（設計書 5.1） | `src/presentation/messages.ts`、`src/report/view-model.ts`、`src/report/html-report.ts`、表示のテスト | C18n（C18m と並行） |
| C18m | CC-032: Guard の付いた Passive の page を開いて閉じる処理を、`withGuardedPassivePage` に寄せる | `tests/integration/*`、`tests/component/*` | C18n（Interaction のテストが重なるので、C18n とは並行にしない。C18o とは並行） |
| RC18 | 整理の全体の確認のレビュー | なし（読み取り専用） | C18o、C18m |
| C18p | RC18 の Minor（M1 説明の文、M3 型の分け方、M4 探索のテストの違反の確かめ、M5 CLI のテストの `--headless`、M6 矩形の型の別名、M8 使われない lifecycle の説明を消す） | `src/presentation/messages.ts`、`src/interaction/discover-candidates.ts`、`src/core/evidence-types.ts`、`tests/helpers/gate-harness.ts`、テスト | RC18 |

- C18b と C18c は、変えるファイルが重ならない。そのため、並行で行ってよい。
  - C18a の後に行うのは、C18a がスキーマと `safety-rules.ts` を変えるためである。
  - `safety-rules.ts` は、C18a では Rule の追加、C18c では名前の変更に限る。C18a の後に行えば衝突しない。
- C18d は、C18b が変える `safety-gates.test.ts` の補助を、共通化の対象にする。そのため、C18b の後に行う。
- C18e は、C18d が変える `isolated-interaction.test.ts` の補助に関わる。そのため、C18d の後に行う。
- 並行で行う場合は、両方の指示書に並行であることを書く。
  - 両方とも `npm run verify` を実行しない。verify は、設計者が行う。

## 3. 共通の受け入れ条件

- TDD（RED → GREEN → 関連する検証）で進める。
- すべての Gate（S、A、ARCH、UI）が PASS する。
- 共通部品台帳の部品を使い、同じ意味の処理を新しく書かない。
- 実際の headed のブラウザは、テストで起動しない。
- `npm run verify` が PASS する。並行作業の場合は、設計者が実行する。

## 4. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | 初版 | - | Task 19 の前の整理 |
| 2026-09-25 | C18d の報告 | C18k（CC-031）を加えた。C18e と並行で行う | C18k |
| 2026-09-25 | RC18b | C18i と RC18c を加えた。C18d の前提を RC18c にした | C18i 以降 |
| 2026-09-25 | RC18 | RC18 の Minor を直す C18p を加えた（M2、M6 の一部、M7、M8 の文書は設計者が直した） | C18p |
| 2026-09-25 | C18e の報告 | CC-010 の残りに案A を採り、C18n と C18o を加えた。C18m の前提を C18n に、RC18 の前提を C18o と C18m にした | C18n 以降 |
| 2026-09-25 | C18k の報告 | C18k-fix-round-1（依存の向き）と C18m（CC-032）を加えた。RC18 の前提を C18m にした | C18k 以降 |
| 2026-09-25 | C18g の報告 | C18h（DEF-013）を加えた。RC18b の前提を C18h にした | C18h、RC18b |
| 2026-09-25 | RC18a | C18g と C18f と RC18b を加えた。C18d の前提を RC18b にした | C18d 以降 |
