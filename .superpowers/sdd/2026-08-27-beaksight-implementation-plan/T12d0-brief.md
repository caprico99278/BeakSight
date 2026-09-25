# T12d0 指示書: Safety の Evidence の種類 `safety` を加える

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: T12d0
- 目的: T12d（Safety の Rule）の入力となる Evidence の種類 `safety` を加える。事象の型の定義は、1か所にまとめる。
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の 5.4.1
- 前の報告: 作業記録置き場の `T12d-report.md`（Blocker）

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/evidence-types.ts`、`src/core/contracts.ts`、`src/core/ids.ts`
- `src/safety/safety-ledger.ts`、`src/safety/interaction-policy.ts`（型の定義を core に移し、別名にすることに限る）
- `schemas/page.schema.json`
- テスト: `tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-enum-consistency.test.ts`、`tests/unit/safety-ledger.test.ts`（存在する場合）、`tests/unit/interaction-policy.test.ts`

## 作るもの

1. **core の型**（`src/core/evidence-types.ts`）
   - 次の型を、`src/safety/safety-ledger.ts` から移す。
     - 事象の型: `BlockedRequestEvent`、`BlockedNavigationEvent`、`BlockedWebSocketEvent`、`BlockedExternalActionEvent`、`ExcludedInteractionCandidateEvent`、`BlockedInteractionRequestEvent`、`BlockedInteractionNavigationEvent`、`BlockedPopupEvent`、`BlockedDownloadEvent`、`BlockedInteractionWebSocketEvent`
     - `SafetyLedgerRecordLimits`
   - 事象の `reason` のような閉じた一覧は、`as const` の配列と、そこから導く型にする。この決まりは、共通部品台帳 2.2（enum の置き場所）に従う。
   - Interaction の候補の除外理由を、`INTERACTION_REJECTION_REASONS` として core に置く。`src/safety/interaction-policy.ts` の `InteractionRejectionReason` は、その別名にする。
   - 新しく、次の2つを定義する。
     - `SAFETY_EVIDENCE_SCOPES = ['PASSIVE', 'INTERACTION']`
     - `SafetyEventsEvidence`。持つ項目は、`scope`、`blockedRequestsByMethod`、`blocked*` の各配列、`excludedInteractionCandidates`、`recordLimits`。
2. **Ledger の型**（`src/safety/safety-ledger.ts`）
   - 移した型は、core から import して使う。既存の import 元を壊さないため、必要なら同じ名前で re-export する。
   - `SafetyLedgerSnapshot` は、`SafetyEventsEvidence` から `scope` を除いた型に、`invariantViolations` と `invariantViolationCount` を加えた型として定義する。
   - 振る舞いは変えない。
   - 型の定義は1か所にする。同じ項目の並びを、2か所に書かない。
3. **Evidence の種類**
   - `EVIDENCE_TYPES` に `safety` を加え、`EvidencePayloadByType` に `safety: SafetyEventsEvidence` を加える。
   - `src/core/ids.ts` の接頭辞の表に、`safety: 'SAFETY'` を加える。
4. **snapshot から Evidence の中身を作る関数**
   - `safetyEventsEvidenceFromSnapshot(snapshot, scope)` を、`src/safety/safety-ledger.ts` に置く。この関数は、違反の項目を除いた中身を返す。
   - Task 14 の Page Auditor が使う。T12d のテストの見本づくりにも使える。
5. **スキーマ**（`schemas/page.schema.json`）
   - `safety` の Evidence の分岐を加える。
   - `evidenceId` の pattern は、ID の接頭辞に合わせる。
   - enum は、core の配列と一致させる。`schema-enum-consistency` のテストで確かめる。
6. **テスト**
   - `schema-validator.test.ts` の Evidence の見本の表に、`safety` の見本を加える。
   - スキーマの検証が通る見本と、通らない見本のテストを加える。
   - `safetyEventsEvidenceFromSnapshot` の単体テストを加える。確かめること:
     - 違反の項目を含まないこと
     - scope が付くこと
     - 凍結されていること

## 受け入れ条件

- 新しいテストは、修正前に RED、修正後に GREEN になる。
- 既存の Safety Ledger と Guard のテストは、すべて PASS のまま。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。T12d と Task 14 の実装者が使うので、次の2つのシグネチャを書いてください。

- `SafetyEventsEvidence`
- `safetyEventsEvidenceFromSnapshot`
