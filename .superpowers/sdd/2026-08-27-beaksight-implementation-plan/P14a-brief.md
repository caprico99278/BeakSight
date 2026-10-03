# P14a 指示書: Task 14 の型・設定・部品の土台

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: P14a
- 目的: Page Auditor（P14c・P14d）の前提になる型、設定の検証、定数、採番器、状態の集計の関数を作る。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の第3章、4.3.0、4.5（とくに 4.5.1、4.5.3、4.5.5、4.5.7、4.5.9）
- 実装計画: `doc/design/2026-09-24-beaksight-task-14-implementation-plan.md` の P14a
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 共通化候補の台帳: 作業記録置き場の `commonization-candidates.md` の CC-014
- 関連する報告: 作業記録置き場の `T13b-report.md`、`RT12b-report.md`（`isLinkTargetVerified` の判断）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別の実装者（RT12f）が、次のファイルを変えています。この3つは変更しないでください。

- `src/evidence/layout-collector.ts`
- `tests/integration/layout-accessibility.test.ts`
- layout の fixture

## 変更してよいファイル

- `src/core/contracts.ts`、`src/core/evidence-types.ts`、`src/core/limits.ts`、`src/core/status.ts`
- `src/config/validate-config.ts`
- `schemas/page.schema.json`、`schemas/run.schema.json`
- `src/safety/safety-ledger.ts`、`src/safety/passive-request-guard.ts`、`src/interaction/isolated-auditor.ts`（CC-014 で必要な場合に限る）
- `src/audit/cross-page-rules.ts`（型の別名と `isLinkTargetVerified` に限る）
- 新規: `src/orchestration/id-allocator.ts`
- テスト:
  - `tests/unit/*`（contracts、config、status、schema-validator、schema-enum-consistency、safety-ledger、新しい `id-allocator.test.ts`）
  - `tests/component/cross-page-rules.test.ts`
  - 型の変更に伴って直す必要のある、既存のテストの見本

## 作るもの

1. **ナビゲーションの結果**（設計書 4.3.0、4.5.4）
   - `ViewportAuditResult` に、`navigationOutcome: NavigationOutcomeKind | null` を加える。
   - スキーマの `viewportAuditResult`、enum の一致のテスト、スキーマの見本を、あわせて直す。
   - `src/audit/cross-page-rules.ts` の `CrossPageViewportResult` を、`ViewportAuditResult` の別名にする。
   - `isLinkTargetVerified` の条件を変える。リンク先のビューポートの `navigationOutcome` が1つでも null でなければ、「検証した」とする。理由のコード `NAVIGATION_FAILED` では判断しない。
   - Cross-page rule のテストの見本を、新しい型に合わせる。出力は変わらないことを確かめる。
2. **`PAGE_AUDIT_STAGES`**（設計書 4.5.5）
   - core に、`as const` の配列として置く。
   - `COLLECTOR_INCOMPLETE` の `detail` を `<段階>:<理由>` の形で作る関数を、1つ置く。置き場所は core。
3. **`PageAuditOutcome` と `PageSafetySummary`**（設計書 4.5.1）
   - `PageAuditOutcome` は、`{ result: PageAuditResult; safety: PageSafetySummary }` とする。
   - `PageSafetySummary` は、少なくとも次の2つを持つ。
     - 違反の件数
     - 記録が不完全かどうか
   - 複数の Ledger の snapshot から、`PageSafetySummary` を作る関数を置く。置き場所は、`src/safety/safety-ledger.ts` か core。
4. **定数**（設計書 4.5.7）
   - `src/core/limits.ts` に、次の定数を置く。値と根拠は、報告に書く。
     - `INTERACTION_CLEANUP_ALLOWANCE_MS`
     - DOM の準備の待ち方の定数（`pollIntervalMs`、`stableWindowMs`）
     - controlled scroll の定数（`stepViewportFraction`、`stepWaitMs`、`stableWindowMs`）
     - scroll の予算の倍率（`resourceSettlingTimeoutMs` の4倍）
5. **時間の設定を、正の整数に限る**（設計書 4.5.7）
   - 対象は、`maxRuntimeMs`、`navigationTimeoutMs`、`overallPageTimeoutMs`、`resourceSettlingTimeoutMs`。
   - 設定の検証と `schemas/run.schema.json` を直す。整数でない値が拒否されるテストを加える。
6. **状態の集計**（設計書 4.2、4.5.9）
   - `src/core/status.ts` に、ビューポートの状態から、ページの状態を導く関数を置く。ページの状態は、最も悪いものとする（`FAILED` ＞ `PARTIAL` ＞ `AUDITED`）。
   - `SKIPPED` の扱いは、設計書 4.2 を読んで決め、報告する。
7. **`IdAllocator`**（設計書第3章、4.5.3）
   - Page、Evidence、Finding の連番を持つ。
   - Evidence は、種類ごとではなく、Run で1つの連番とする。
   - Finding は、次の2つの操作で扱う。
     - 現在の連番を読む。
     - `nextFindingSequence` を受け取って、進める。
   - 戻す操作は、拒否する。
   - ID の書式は、既存の `src/core/ids.ts` の関数を使う。同じ書式を、2か所に書かない。
8. **CC-014**
   - `BlockedExternalActionEvent.reason` を、core の `as const` の配列から導く閉じた型にする。
   - 実際に入る値は、`EXTERNAL_ACTION` と `DOWNLOAD` である。記録する側を確かめ、報告する。
   - スキーマと enum の一致のテストも直す。

9. **コメントの修正**（RT12e の発見事項）
   - `src/core/evidence-types.ts` の `partiallyClippedText` の説明のコメントを、実際の振る舞いに合わせる。
     - 縦方向は、行の高さの4分の1を基準にする。
     - 横方向は、2 px を基準にする。
     - 上下（左右）に出た量は、合計せず、別々に比べる。
     - 見えない子孫のテキストは、判定に使わない。
     - どれも、Rule の設計書 5.1.2 の記述に合わせる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` と `npm run build` は、実行しない。
  - 同時に、別の実装者（RT12f）が layout の collector を変えている。そのため、全体のテストは途中の状態を含む。
  - 全体の verify は、設計者が2つの作業の後に実行する。
- 担当のテストのファイルを指定して `npx vitest run` を実行し、PASS することを確かめる。担当のテストは、unit、`cross-page-rules`、そのほか変更したものである。

## 報告

共通ルールの形式で、日本語で報告してください。P14b〜P14d の実装者が使うので、新しく作った型と関数のシグネチャを一覧にしてください。
