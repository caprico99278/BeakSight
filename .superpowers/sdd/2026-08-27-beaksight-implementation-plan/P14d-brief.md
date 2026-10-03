# P14d 指示書: Interaction の段階と、crash の理由

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: P14d
- 目的:
  - Page Auditor に、Interaction の段階を加える。
  - crash の専用の理由 `PAGE_CRASHED` を加える。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`
  - 4.3（Safety）
  - 4.3.1（Interaction の候補の渡し方）
  - 4.5.2 の手順5の Interaction
  - 4.5.4 の crash
  - 4.5.7（Interaction の予算。候補ごとの期限は、`navigationTimeoutMs` と `interactionTimeoutMs` の2倍の和）
  - 4.5.8（後片付けの失敗）
- 実装計画: `doc/design/2026-09-24-beaksight-task-14-implementation-plan.md` の P14d
- 前の報告: 作業記録置き場の `P14a-report.md`、`P14b-report.md`、`P14c-report.md`
- Interaction の監査の入口: `src/interaction/isolated-auditor.ts` の `auditInteraction` と `InteractionOwnerCleanupError`、`src/interaction/discover-candidates.ts` の `discoverInteractionCandidates`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/orchestration/page-auditor.ts`
- `src/core/contracts.ts`（`INCOMPLETE_REASON_CODES` に `PAGE_CRASHED` を加えることに限る）
- `schemas/run.schema.json`、`schemas/page.schema.json`（理由のコードの enum に限る）
- テスト:
  - `tests/integration/page-auditor.test.ts`
  - 新規の `tests/integration/page-auditor-interaction.test.ts`
  - `tests/unit/core-contracts.test.ts`、`tests/unit/schema-enum-consistency.test.ts`、`tests/unit/schema-validator.test.ts`（理由のコードの追加に伴うものに限る）
- `fixtures/site/` への新しいページの追加

`src/interaction/` の中は、変更しないでください。変更が必要になった場合は、止まって報告してください。

## 作るもの

1. **Interaction の段階**（Desktop だけ。設定の `audit.interactions` が有効な場合）
   - Passive の page で、`discoverInteractionCandidates` を呼び、候補を見つける。
     - 呼ぶのは、Link の抽出の後、Safety の Evidence と Rule の評価の前である（設計書 4.5.2）。
   - 候補は、機械的に除外されるものも含めて、すべて `auditInteraction` に渡す（設計書 4.3.1）。呼び出しの前に取り除かない。
   - `sessionFactory` は、`(viewport) => contextFactory.createInteractionSession(viewport)` とする。
   - `navigationTimeoutMs` と `timeoutMs` には、設定の値を渡す。
   - Interaction の段階の予算と、候補ごとの期限は、設計書 4.5.7 のとおりにする。
     - 段階の期限は、Interaction の段階の開始の時刻に、`overallPageTimeoutMs` を足した時刻とする。
     - 候補ごとの期限は、次の2つの早い方とする。
       - 段階の期限
       - 現在の時刻に、`navigationTimeoutMs` と、`interactionTimeoutMs` の2倍を足した時刻
     - 次の候補の見積もりが、段階の期限に収まらない場合は、そこで止める。
       - 残りの件数を、detail に書く（例: `interaction:budget` と件数）。detail の形は、実装者が決めて報告する。
       - ビューポートを `PARTIAL` にする。
     - 期限の計算は、1か所で行う。`stageDeadline` を使える箇所では使う。
   - 候補の発見の `completeness` が `COMPLETE` でない場合は、ビューポートを `PARTIAL` にする。理由は `interaction-discovery:<completeness>` とする。
   - 各候補の結果（`InteractionAuditResult`）を、`interaction` の Evidence として記録する。
     - 記録するのは、Evidence の部分である。`safety` の snapshot は含めない。
     - Interaction の Safety の snapshot は、候補ごとに、次の2つに使う。
       - Safety の Evidence（scope は `INTERACTION`、ビューポートは Desktop）を作る。
       - `summarizePageSafety` の入力にする。
   - 結果の状態が、確かめられなかったこと（NOT_VERIFIABLE、BLOCKED、EXECUTION_FAILED など）を表す場合がある。
     - このとき、ビューポートを `PARTIAL` にするかどうかは、既存の完了の判定（`REQUIRED_WORK_*` の理由のコード）と照らして、実装者が決めて報告する。
     - 判断に迷う場合は、止まって報告する。
2. **後片付けの失敗**（設計書 4.5.8）
   - `InteractionOwnerCleanupError` が起きた場合は、次のようにする。
     - エラーが保持する session で、`close()` を1回試みる。上限は `INTERACTION_CLEANUP_ALLOWANCE_MS` とする。
     - Desktop を `PARTIAL` にし、理由を `interaction:cleanup` とする。
     - エラーが保持する Safety の snapshot も、集計に含める。
   - そのページの残りの候補は、監査しない。件数は、予算の場合と同じように記録する。
3. **Rule の評価の順序**
   - Interaction の Safety の Evidence を、Desktop の Rule の入力に含めてから、Rule を評価する。
4. **`PAGE_CRASHED`**（設計書 4.5.4）
   - 次の3か所に加える。
     - `INCOMPLETE_REASON_CODES`
     - スキーマの enum
     - enum の一致のテスト
   - crash した段階の理由は、`<段階>:PAGE_CRASHED` とする。
     - P14c では、`pageFailureReason(page)` の値（`EVALUATION_FAILED`）にしていた。これを置き換える。
   - ビューポートの状態は、これまでどおり `FAILED` とする。

## テスト

- `tests/integration/page-auditor-interaction.test.ts` を作り、fixture のサーバで確かめる。
  1. `aria-expanded` のトグルがあるページで、次のことを確かめる。
     - `interaction` の Evidence が、`VERIFIED` として記録される。
     - Desktop が `AUDITED` になる。
  2. 除外される候補（`mailto:`、ダウンロード、submit など）があるページで、次のことを確かめる。
     - 除外の事実が、Interaction の Safety の Evidence にある。
     - それをもとに、Safety の Finding ができる。例: `SAFETY_INTERACTION_CANDIDATE_EXCLUDED`、`SAFETY_EXTERNAL_ACTION_BLOCKED`。
     - これで、Rule の評価が Interaction の後に行われることを確かめる。
  3. 予算が足りない場合（小さい `overallPageTimeoutMs`、多くの候補）に、次のことを確かめる。
     - `PARTIAL` と `interaction:budget` が記録される。
     - 残りの件数が記録される。
  4. `InteractionOwnerCleanupError` の場合（偽の session で起こしてよい）に、次のことを確かめる。
     - `close()` が1回だけ試みられる。
     - `PARTIAL` と `interaction:cleanup` が記録される。
     - 残りの候補は、監査されない。
  5. 違反の件数が、`PageAuditOutcome.safety` に集計される。偽の snapshot を使ってよい。
  6. 設定で Interaction が無効な場合は、候補を探さず、理由も付かない。
  7. Mobile では、Interaction を行わない。
  8. 結果が `page` のスキーマに合う。後に Context が残らない。
- `tests/integration/page-auditor.test.ts` の crash のテストを、`PAGE_CRASHED` に合わせて直す。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存の Page Auditor のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のことを書いてください。

- 実装で判断したこと。とくに、次の2つ。
  - Interaction の結果とビューポートの状態の関係
  - 予算の detail の形
- 1ページの Interaction の段階の所要時間の目安。fixture で測った値でよい。
