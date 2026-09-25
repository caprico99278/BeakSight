# BeakSight Task 14 ページ監査 実装計画

作成日: 2026-09-24
状態: ユーザー承認済みの範囲内で、設計者が確定した（2026-09-23 のユーザーの開発指示に基づく）
設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第3章と第4章（とくに 4.5）
上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` Task 14

## 1. 目的

1つのページについて、Desktop と Mobile の両方のビューポートを監査する `PageAuditor` を作る。これまでに作った部品を、1つの流れにつなぐ。部品は、collector、Guard、controlled scroll、Link の抽出、Interaction の監査、Rule Engine である。

## 2. サブタスクの分け方と順序

| ID | 内容 | 主に変更するファイル | 前提 |
| --- | --- | --- | --- |
| P14a | 型と設定と部品の土台 | `src/core/*`、`src/config/validate-config.ts`、`schemas/*`、`src/orchestration/id-allocator.ts`、`src/audit/cross-page-rules.ts`（型の別名だけ）、`src/safety/safety-ledger.ts`（CC-014） | なし |
| P14b | ナビゲーションと、幅の走査のセッションと、Evidence の組み立て | `src/orchestration/page-navigation.ts`、`src/orchestration/stress-session.ts`、`src/orchestration/evidence-builder.ts` | P14a |
| P14c | Passive の段階の Page Auditor（Interaction を除く） | `src/orchestration/page-auditor.ts`、`tests/integration/page-auditor.test.ts` | P14b |
| P14d | Interaction の段階と、Safety の集計 | `src/orchestration/page-auditor.ts`、`tests/integration/page-auditor-interaction.test.ts` | P14c |

- P14a〜P14d は、この順に1つずつ行う。どのサブタスクも、前のサブタスクの型に依存するためである。
- P14d の後に、Task 14 のチェックポイントの独立レビューを行う（実装タスク指示 第12章）。

## 3. 各サブタスク

### P14a 型と設定と部品の土台

- `ViewportAuditResult` に、`navigationOutcome: NavigationOutcomeKind | null` を加える。
  - あわせて、スキーマ、enum の一致のテスト、スキーマの見本を直す。
- `src/audit/cross-page-rules.ts` の `CrossPageViewportResult` を、`ViewportAuditResult` の別名にする。
- `PAGE_AUDIT_STAGES` を、core に置く（設計書 4.5.5）。
- `src/core/limits.ts` に、次の定数を置く。
  - `INTERACTION_CLEANUP_ALLOWANCE_MS`
  - scroll と DOM の準備の待ち方の定数（設計書 4.5.7）
- 時間の設定（`maxRuntimeMs`、`navigationTimeoutMs`、`overallPageTimeoutMs`、`resourceSettlingTimeoutMs`）を、正の整数に限る。設定の検証と、run のスキーマを直す。
- ビューポートの状態をまとめる関数（最も悪いものを取る）を、`src/core/status.ts` に置く。
- `IdAllocator` を、`src/orchestration/id-allocator.ts` に作る（設計書 4.5.3）。
- CC-014: `BlockedExternalActionEvent.reason` を、閉じた一覧にする。
- `PageAuditOutcome` と `PageSafetySummary` の型を、core に置く（設計書 4.5.1）。

### P14b ナビゲーションと、幅の走査のセッションと、Evidence の組み立て

- `navigatePage(page, url, options)` を作る（設計書 4.5.4）。
  - 戻り値は、`navigationOutcome`、`httpStatus`、`finalUrl`、失敗の詳細である。
  - `BLOCKED_EXTERNAL_REDIRECT` は、Ledger の `blockedNavigations` の増加で判定する。
  - fixture の `/__external-redirect` と `/__slow` を使って、統合テストで確かめる。
- `createStressSessionFactory(factory)` を作る（設計書 4.5.6）。
  - いまテストの中にある組み立て（`tests/unit/schema-validator.test.ts` の該当箇所）を、本番のコードにする。
  - Ledger を、後で集計できる形で返す。
- `EvidenceRecord` を組み立てる関数を作る。採番器と時計を受け取る。
- `stageDeadline` を作る（設計書 4.5.7）。

### P14c Passive の段階の Page Auditor

- `PageAuditor.audit(url, pageId)` を作る。Interaction の段階は、まだ呼ばない。設定で Interaction が有効でも、P14d までは実行しない。
- 処理は、設計書 4.5.2 の 1〜8 から、Interaction を除いたものとする。
- 実装計画 Task 14 の Step 1 と Step 3 の統合テストを書く。
  - 壊れた画像と console のエラーがある fixture で、次のことを確かめる。
    - Evidence が先にそろっている。
    - Finding が、正しい Evidence の ID を参照している。
    - スクリーンショットがある。
    - 状態が `AUDITED` である。
  - Mobile でだけ横にはみ出す fixture で、次のことを確かめる。
    - Desktop は `AUDITED` のままである。
    - Mobile に layout の Finding がある。
    - ページ全体の集計が、ビューポートごとの状態を隠さない。
- 次のことも、統合テストで確かめる。
  - ナビゲーションが失敗した場合（期限切れと、外部へのリダイレクト）に、ビューポートが `FAILED` になり、network の Evidence が記録される（設計書 4.3.0）。
  - collector の例外が `COLLECTOR_INCOMPLETE` になる（設計書 4.5.5）。偽の collector を注入して確かめてよい。
  - 大きさの指定のない SVG 画像で、`IMAGE_LOAD_FAILED` が誤って出ないか（T12b の未確認事項）。
    - 誤って出る場合は、止まって報告する。報告を受けて、設計者が既存不具合として登録する。

### P14d Interaction の段階と、Safety の集計

- 設計書 4.5.2 の手順5の Interaction、4.3.1、4.5.7、4.5.8 を実装する。
  - 候補は、除外されるものも含めて、すべて `auditInteraction` に渡す。
  - 期限の計算は、1か所で行う。
- Safety の Evidence（Passive、Interaction、幅の走査）と、`PageSafetySummary` を作る。
- 統合テストで、次のことを確かめる。
  - Interaction の Safety の事象（例: 除外した候補、popup の遮断）から、Safety の Finding ができる。Rule の評価が、Interaction の後に行われることを確かめるためである。
  - 予算が足りないときに、`PARTIAL` と `interaction:budget` が記録される。
  - `InteractionOwnerCleanupError` のときに、`close()` を1回試み、`PARTIAL` と `interaction:cleanup` が記録される。
  - 違反の件数が、`PageSafetySummary` に集計される。

## 4. 各サブタスクの共通の受け入れ条件

- TDD（RED → GREEN → 関連する検証）で進める。
- `npm run verify` が PASS する。
- 共通部品台帳の部品を使い、同じ意味の処理を新しく書かない。
- 変更したファイルの一覧と SHA-256 を、報告に書く。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-24 | 初版 | - | Task 14 |
