# T12d0 実装報告（要約。設計者が保存）

## 結論

完了した。Evidence の種類 `safety` を加え、事象の型の定義を `src/core/evidence-types.ts` の1か所にまとめた。`npm run verify` は PASS した（47ファイル、1819件。build を含む）。

## シグネチャ（T12d と Task 14 の実装者向け）

```ts
// src/core/evidence-types.ts
export const SAFETY_EVIDENCE_SCOPES = Object.freeze(['PASSIVE', 'INTERACTION'] as const);
export type SafetyEvidenceScope = (typeof SAFETY_EVIDENCE_SCOPES)[number];
export interface SafetyEventsEvidence {
  readonly scope: SafetyEvidenceScope;
  readonly blockedRequestsByMethod: Readonly<Record<string, number>>;
  readonly blockedRequests: readonly BlockedRequestEvent[];
  readonly blockedNavigations: readonly BlockedNavigationEvent[];
  readonly blockedWebSockets: readonly BlockedWebSocketEvent[];
  readonly blockedExternalActions: readonly BlockedExternalActionEvent[];
  readonly excludedInteractionCandidates: readonly ExcludedInteractionCandidateEvent[];
  readonly blockedInteractionRequests: readonly BlockedInteractionRequestEvent[];
  readonly blockedInteractionNavigations: readonly BlockedInteractionNavigationEvent[];
  readonly blockedPopups: readonly BlockedPopupEvent[];
  readonly blockedDownloads: readonly BlockedDownloadEvent[];
  readonly blockedInteractionWebSockets: readonly BlockedInteractionWebSocketEvent[];
  readonly recordLimits: SafetyLedgerRecordLimits;
}

// src/safety/safety-ledger.ts
export function safetyEventsEvidenceFromSnapshot(
  snapshot: SafetyLedgerSnapshot,
  scope: SafetyEvidenceScope,
): SafetyEventsEvidence; // 違反の2項目を除き、scope を付け、deepFreeze して返す
```

- ID は、`createEvidenceId('safety', n)` で作る。形式は `EV-SAFETY-000001` である。
- 理由の閉じた一覧は、core の `as const` の配列にした。対象は `BLOCKED_REQUEST_REASONS`、`INTERACTION_REJECTION_REASONS` など6つである。
- `InteractionRejectionReason` は、`InteractionRejectionReasonEvidence` の別名にした。

## 発見事項と、設計者の判断

1. `BlockedExternalActionEvent.reason` の型が、`string` のままである。
   - 判断: CC-014 として登録する。Task 14 で、閉じた型にする。
2. `SafetyInvariantViolationSummary` と `InvariantViolationEvent` は、同じ形の型が2つある状態である。
   - 判断: CC-015 として登録する。Task 15（Run Status の完成）で、1つにまとめる。
3. 新しいテストのうち4件は、関数がまだないことによる失敗を RED としている。
   - 判断: 受け入れる。振る舞いのテストは、GREEN の後も意味のある検査になっている。
