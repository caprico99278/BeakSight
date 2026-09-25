# C15x 実装報告（要約。設計者が保存）

## 結論

完了した。次のものを直した。実装者の報告では、`npm run verify` は PASS した（71ファイル、2511件）。

- CC-021
- DEF-006
- DEF-007
- R15 の Minor-1・2
- 古いコメント

Guard、factory、Ledger は、変えていない。

## 新しい部品

- 閉じる処理の期限の定数（`src/core/limits.ts`）
  - `PAGE_CLOSE_TIMEOUT_MS = 5_000`
  - `BROWSER_CLOSE_TIMEOUT_MS = 10_000`
- 理由を組み立てる関数（`src/core/status.ts`）
  - `unhandledFailureReason(scene, error)`
  - `ruleEvaluationFailureReason(failure)`
- page を期限付きで閉じる部品（`src/orchestration/passive-session-close.ts`）
  - `closePassivePageBeforeDeadline(factory, page)`
  - `PassivePageCloseDeadlineError`
- Browser を期限付きで閉じる関数（`src/orchestration/preflight.ts`）
  - `closeBrowserBeforeDeadline(browser)`
- `PageAuditor.audit(url, pageId, attempt?)`。`attempt` は `{ attempt, precedesRetry }` である。
  - 再試行の前の試行のスクリーンショットは、`retry-<n>` に置く。

## 実装者の判断と、設計者の判断

1. CC-021 の上限と制御文字の扱い。2か所の実装は、すでに同じだった。→ 承認する。
2. 件数の上限付きの加算は、`safety-ledger.ts` の1か所だけに残った。使う側がないので、公開しない。→ 承認する。
3. DEF-007 の試行の情報は、`audit` の引数で渡す。→ 承認する。
   - 再試行するかどうかの判断は、Coordinator だけが持つ。
   - Page Auditor は、Desktop の監査の後に、その判断を1回だけ呼ぶ。
4. `environment.ts` の期限は、`navigationTimeoutMs` の中で行う。→ 承認する。
5. Guard と factory は、変えなくてよかった。
   - 期限の後に Context を閉じると、止まっていた page も閉じる。
   - このとき、違反は記録されない。

## 発見事項と、設計者の判断

1. DEF-005 の条件で止まるかどうかは、タイミングで変わる。
   - 実際の Chromium のテストでは、止まる場合も止まらない場合も許し、期限の中で戻ることを確かめる形にした。
   - 期限切れの記録は、偽の page で確実に確かめている。
   - → 承認する。
2. `preflight.ts` の `checkPassiveGuard` と、`run-aggregation.ts` の遮断の件数は、上限なしで足している。
   - → 受け入れる。前者は `> 0` の判定にしか使わない。後者は違反の件数ではなく、現実の件数では上限を超えない。
