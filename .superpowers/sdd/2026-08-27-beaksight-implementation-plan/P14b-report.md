# P14b 実装報告（要約。設計者が保存）

## 結論

完了した。4つの部品を、TDD で作った。新しいテスト55件と `npm run typecheck` は PASS した。verify は、並行作業のため実行していない。

## P14c・P14d で使う関数

```ts
// src/orchestration/page-navigation.ts
navigatePage(page, url, { timeoutMs, ledger, allowedQueryParameters }): Promise<{
  navigationOutcome, httpStatus: number | null, finalUrl: NormalizedHttpUrlEvidence | null, failureDetail: string | null
}>
// src/orchestration/stress-session.ts
createStressSessionFactory(factory: BrowserContextFactory): {
  createSession: PassiveStressSessionFactory, ledgers: () => readonly SafetyLedger[]
}
// src/orchestration/evidence-builder.ts
createEvidenceRecord({ type, pageId, viewport, payload }, { allocator, clock }): EvidenceRecordFor<T>
// src/orchestration/stage-deadline.ts
stageDeadline(pageDeadlineAtMs, nowMs, stageBudgetMs | null): number
```

- `navigatePage` の振る舞い
  - 応答がない `goto` も、`OK` として扱う。このとき、`httpStatus` は null になる。
  - 結果の種類は、`TIMEOUT` → `BLOCKED_EXTERNAL_REDIRECT` → `FAILED` の順に判定する。
  - 例外は、引数が不正な場合にだけ投げる。
- `createStressSessionFactory` の振る舞い
  - page を作れなかった場合は、Context を閉じてから、元の例外を投げる。
  - page と Context の両方を閉じられなかった場合は、`AggregateError` を投げる。
- `createEvidenceRecord` の振る舞い
  - payload を `structuredClone` で複製してから、深く凍結する。

## 発見事項と、設計者の判断

1. Playwright の期限切れの判定が、2か所にある。1つは `isolated-auditor.ts` の `isTimeoutError`、もう1つは `page-navigation.ts` である。
   - 判断: CC-017 として登録する。
   - 実施するのは、Task 14 のチェックポイントの後である。Interaction の監査は、何度も直した箇所なので、単独のサブタスクで行う。
2. `src/core/ids.ts` の `formatEvidencePrefix` は、普通のオブジェクトの表を引く。そのため、`'constructor'` などの既定のプロパティ名を受け付けてしまう（推測）。
   - 判断: 既存不具合 DEF-002 として登録し、直す。
3. Ledger が上限（256件）に達した後の遮断は、判定できない。
   - 判断: 受け入れる。ビューポートごとに新しい Context と Ledger を作るので、問題にならない。
