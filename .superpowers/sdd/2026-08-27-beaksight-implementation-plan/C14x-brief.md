# C14x 指示書: Task 14 の後の整理（CC-017、CC-018、CC-019、DEF-003）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C14x
- 目的: Task 14 の間に見つけた、次のものを直す。
  - 共通化の候補3つ（CC-017、CC-018、CC-019）
  - 既存不具合1つ（DEF-003）
- 共通化候補の台帳: 作業記録置き場の `commonization-candidates.md` の CC-017、CC-018、CC-019
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-003
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。不具合がいつからあったかを確かめるために、HEAD に戻すことも禁止です。

このサブタスクは単独で実行します。振る舞いは変えません（DEF-003 を除く）。

## 変更してよいファイル

- `src/browser/`（新しい共通の関数を置くファイル。既存のファイルに加えてもよい）
- `src/interaction/isolated-auditor.ts`（CC-017 の置き換えに限る）
- `src/orchestration/page-navigation.ts`（CC-017 の置き換えに限る）
- `src/orchestration/page-auditor.ts`、`src/orchestration/stress-session.ts`（CC-018 に限る）
- `src/safety/interaction-policy.ts`（DEF-003 に限る）
- `tests/helpers/`（CC-019 に限る）
- `src/orchestration/page-auditor.ts` と `src/browser/context-factory.ts`（R14r2 の Minor の修正に限る）
- テスト: 対応する unit・component・integration のテスト

## 修正する内容

1. **CC-017 Playwright の期限切れの判定**
   - 期限切れの判定の関数を、`src/browser/` に1つ置く（例: `isPlaywrightTimeoutError(error): boolean`）。
   - 判定の方法は、次の2つで確かめる。
     - Playwright の `errors.TimeoutError` の `instanceof`
     - `name === 'TimeoutError'`
   - 両方で判定するかどうかは、既存の2つの呼び出し元の振る舞いが変わらないように決め、報告する。
   - `isolated-auditor.ts` の `isTimeoutError` と、`page-navigation.ts` の判定を、この関数に置き換える。
   - 単体テストを加える。
2. **CC-018 page と Context を閉じる処理**
   - 次の処理を、1つの部品にする（`src/orchestration/` の下）。
     - page を閉じてから、Context を閉じる。
     - Guard がすでに閉じていれば、Context は閉じ直さない。
     - 失敗の一覧を返す。
   - 使い分けは、次のとおり。
     - `page-auditor.ts`: 失敗を、理由として使う。
     - `stress-session.ts`: これまでどおり、失敗を例外にする。単独の失敗はその例外、両方の失敗は `AggregateError`。
   - 既存の Page Auditor と幅の走査のテストが、変更なしで PASS すること。
3. **DEF-003 除外理由の記録先の表**
   - まず、不具合を再現するテストを書き、RED を確かめる。
     - 対象は、`interactionRejectionLedgerRecord('constructor' as InteractionRejectionReason)` など。
     - 期待する結果は、例外になること（fail-closed）。
   - `Object.hasOwn` で確かめる形にして、GREEN にする。

4. **CC-019 テスト用の Browser の Proxy**
   - 「`newContext` の直後に page を1つ開く Browser の Proxy」を、`tests/helpers/` に1つの補助としてまとめる。
   - 次の4つのファイルの重複を、その補助に置き換える。
     - `tests/component/context-factory.test.ts`
     - `tests/integration/page-auditor.test.ts`
     - `tests/integration/page-auditor-interaction.test.ts`
     - `tests/integration/stress-session.test.ts`
   - テストの条件は変えない。

5. **R14r2 の Minor**（作業記録置き場の `R14r2-review-result.md`）
   1. Context の構築の失敗の理由（`passive-context:...` など）に、元の原因のメッセージを含める。
      - `ContextConstructionError` の場合は、`cause` のメッセージを、上限付きで detail に含める。
      - テストで確かめる。
   2. 候補の発見が止まり続ける場合に、`interaction-discovery:DEADLINE_EXCEEDED` が記録され、監査が戻ることを確かめるテストを加える。
      - 発見は、差し替えてよい。
      - このテストは、見放す時刻を渡さない誤りを検出できる形にする。
   3. `createInteractionSession` の JSDoc を、実際の動作に合わせる。
      - どの失敗の場合に、誰が Context を閉じるかを書く。

## 受け入れ条件

- DEF-003 のテストと、R14r2 の Minor 1 と 2 のテストは、修正前に RED、修正後に GREEN になる。
- CC-017、CC-018、CC-019 は、振る舞いを変えない整理である。
  - 既存のテストは、変更なしで、すべて PASS する。
  - 新しい部品には、単体テストがある。
- 同じ意味の処理が、ほかに残っていないことを、`grep` で確かめて報告する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。新しく作った部品のシグネチャを一覧にしてください。
