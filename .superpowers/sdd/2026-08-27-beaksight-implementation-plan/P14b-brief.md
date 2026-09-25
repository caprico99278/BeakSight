# P14b 指示書: ナビゲーション、幅の走査のセッション、Evidence の組み立て、段階の期限

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: P14b
- 目的: Page Auditor（P14c・P14d）が使う部品を4つ作る。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`
  - 4.3.0
  - 4.5.3（採番と、Evidence の組み立て）
  - 4.5.4（ナビゲーションの結果）
  - 4.5.6（幅の走査）
  - 4.5.7（期限）
- 実装計画: `doc/design/2026-09-24-beaksight-task-14-implementation-plan.md` の P14b
- 前の報告: 作業記録置き場の `P14a-report.md`。P14a で作った型と関数のシグネチャは、ここにある。
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

同時に、別のレビュー担当が、layout の collector を読み取り専用で確かめています。既存のファイルの変更は、下の「変更してよいファイル」に限ってください。

## 変更してよいファイル

- 新規: `src/orchestration/page-navigation.ts`、`src/orchestration/stress-session.ts`、`src/orchestration/evidence-builder.ts`、`src/orchestration/stage-deadline.ts`
  - ファイルの分け方は、責務が明確なら変えてよい。その場合は、理由を報告する。
- 新規のテスト: `tests/unit/stage-deadline.test.ts`、`tests/unit/evidence-builder.test.ts`、`tests/integration/page-navigation.test.ts`、`tests/integration/stress-session.test.ts`
- `fixtures/server.ts` と `fixtures/site/`
  - 変更してよいのは、ナビゲーションの失敗を再現するためのものに限る。
  - 既存の `/__external-redirect` と `/__slow` で足りない場合に限る。

## 作るもの

1. **`navigatePage(page, url, options)`**（設計書 4.5.4）
   - `page.goto(url, { waitUntil: 'domcontentloaded', timeout })` で開く。
   - 戻り値は、次のものを持つ。
     - `navigationOutcome`（`NavigationOutcomeKind`）
     - `httpStatus`（number か null）
     - `finalUrl`（正規化した文字列か null）
     - 失敗の詳細（上限付きの文字列か null）
   - `navigationOutcome` は、次の規則で決める。
     - 応答を得た場合は、`OK`。4xx・5xx も `OK` とする。
     - Playwright の期限切れの場合は、`TIMEOUT`。
     - 失敗の前後で、Passive の Ledger の `blockedNavigations` の件数が増えた場合は、`BLOCKED_EXTERNAL_REDIRECT`。Ledger は、引数で受け取る。
     - それ以外は、`FAILED`。
   - 最終URLの正規化には、既存の `normalizeUrl` を使う。`allowedQueryParameters` は、引数で受け取る。
   - 例外は投げず、結果として返す。例外を投げてよいのは、引数が不正な場合だけである。
   - 統合テストで、次のことを確かめる。
     - 200 の場合と、404 の場合
     - 期限切れ（`/__slow`）
     - 外部へのリダイレクト（`/__external-redirect`）
     - つながらないポート
     - 最終URLの正規化
2. **`createStressSessionFactory(factory)`**（設計書 4.5.6）
   - `collectStressLayout` に渡す `PassiveStressSessionFactory` を作る。
   - 走査のセッションは、`BrowserContextFactory` の Passive Context を使う。
   - いまテストの中にある組み立て（`tests/unit/schema-validator.test.ts` の該当箇所）を、本番のコードにする。
     - テストのほうは、この部品を使うように直さなくてよい。
     - 直す場合は、変更してよいファイルに `tests/unit/schema-validator.test.ts` を加えたものとして扱ってよい。
   - 作ったセッションの Ledger を、後で集計できるようにする。例えば、ファクトリが、作った Ledger の一覧を返すようにする。
   - セッションを閉じるときの失敗を、隠さない。
   - 統合テストで、次のことを確かめる。
     - 2つの幅で `collectStressLayout` を実際に動かし、結果が得られる。
     - Ledger が2つ集まる。
3. **Evidence の組み立て**（設計書 4.5.3）
   - `EvidenceRecord` を作る関数を1つ作る。
     - 引数は、種類、pageId、viewport、payload、採番器（`IdAllocator`）、時計（`() => Date`）。
     - `observedAt` は、時計の ISO 8601 の文字列にする。
     - 結果は、深く凍結する。
   - 種類と payload の型の対応は、型で保証する（`EvidenceRecordFor<T>`）。
4. **`stageDeadline(pageDeadlineAtMs, nowMs, stageBudgetMs)`**（設計書 4.5.7）
   - ページの期限と、「現在の時刻に段階の予算を足した時刻」の、早い方を返す。
   - 予算が null の場合は、ページの期限を返す。
   - 引数が不正な場合は、`RangeError` にする。

## 受け入れ条件

- 各部品のテストが、修正前に RED、修正後に GREEN になる。
- 共通部品台帳にある部品を使う。同じ意味の処理を、新しく書かない。
  - 例: URL の正規化、ID の書式、凍結、エラーの文字列の上限。
- `npm run typecheck` と、担当のテストが PASS する。
- `npm run verify` は実行しない。同時に、レビュー担当が同じテストを実行しているため。全体の verify は、設計者が行う。

## 報告

共通ルールの形式で、日本語で報告してください。P14c・P14d の実装者が使うので、作った関数のシグネチャを一覧にしてください。
