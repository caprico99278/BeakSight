# P14f 指示書: Guard の取り付けの失敗の Ledger、発見の期限、collector の期限の余裕

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: P14f
- 目的: 確認のレビュー R14r の Important-1 と、Minor-1〜3 を直す。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`
  - 4.3（構築の失敗の扱い）
  - 4.5.7（発見の期限、予算の数え始め、collector の期限の余裕、時計の前提）
- レビューの結果: 作業記録置き場の `R14r-review-result.md`
  - 再現のスクリプトは、`C:\Users\ocean\AppData\Local\Temp\claude\C--Develop-github-repo-BeakSight\c7d3723a-f7c4-4979-913c-ece0b3289778\scratchpad\verify\i2.verify.ts` にある。
  - このスクリプトは、読んで参考にしてよい。リポジトリには入れない。

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/browser/context-factory.ts`
- `src/orchestration/page-auditor.ts`
- `src/orchestration/stress-session.ts`
- `src/core/limits.ts`（`COLLECTOR_DEADLINE_MARGIN_MS` を加えることに限る）
- テスト: `tests/component/context-factory.test.ts`、`tests/integration/page-auditor.test.ts`、`tests/integration/page-auditor-interaction.test.ts`、`tests/integration/stress-session.test.ts`、`tests/unit/limits.test.ts`

`src/safety/passive-request-guard.ts` は、変更しないでください。変更が必要になった場合は、止まって報告してください。

## 修正する内容

1. **Important-1 構築の失敗の Ledger**
   - `BrowserContextFactory` の `createPassiveContext` と `createInteractionSession` を直す。
     - 構築に失敗した場合は、Context が閉じられたかどうかに関係なく、`ContextConstructionError` を投げる。
     - このエラーは、その Context の Ledger を持つ（例: `ledger` のプロパティ）。
     - 構築の失敗には、Guard の取り付けの失敗と、page の作成の失敗の両方を含む。
   - factory は、失敗した Context と Ledger の対応を消さない。`getSafetyLedger` で、後から取り出せるようにする。
   - Page Auditor（Passive、Interaction）と、幅の走査の session で、このエラーの Ledger を、次の2つに含める。
     - Safety の Evidence
     - `summarizePageSafety` の入力
   - テストで、次のことを確かめる。修正前に RED、修正後に GREEN になること。
     - `newContext` の直後に page を1つ開く Browser の Proxy を、factory に渡す。これで、Guard の取り付けを失敗させる。
     - Passive、Interaction、幅の走査の3つの経路で、`GUARD_INSTALLATION_FAILED` の違反が、`outcome.safety.invariantViolationCount` に数えられる。
     - Passive の経路で、Desktop の safety の Evidence が作られる。
     - Context が残らない。
   - 既存の context-factory のテストは、PASS のままであること。エラーの型が変わるテストは、新しい仕様に合わせて直してよい。条件は弱めないこと。
2. **Minor-1 発見の期限と、予算の数え始め**
   - 候補の発見は、Passive の段階の期限の中で行う。
   - Interaction の段階の予算は、発見が終わった時刻から数える。
   - テストで、次のことを確かめる。修正前に RED、修正後に GREEN になること。
     - `overallPageTimeoutMs` が見積もりと等しい設定（例: 6000 = 2000 + 2 × 2000）で、1件目の候補が監査される。
   - I1 のテストの注記が実際と合わない場合は、直す。
3. **Minor-2 collector の期限の余裕**
   - `COLLECTOR_DEADLINE_MARGIN_MS` を、`src/core/limits.ts` に置く。値と根拠は、報告に書く。
   - 期限を受け取る collector には、ページの期限からこの値を引いた時刻を渡す。
   - テストで、次のことを確かめる。
     - 期限で止まる collector（差し替えてよい）の PARTIAL の Evidence が、記録される。
4. **Minor-3**
   - 構築に失敗した Interaction の Context を閉じる処理の場面の名前を、`interaction-context-close` にする。
   - 注入する `now` は、`Date.now` と同じ基準でなければならない。この前提を、`PageAuditor` の JSDoc に書く。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存のテストは、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。
