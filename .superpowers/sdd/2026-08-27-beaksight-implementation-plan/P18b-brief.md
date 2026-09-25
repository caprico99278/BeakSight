# P18b 指示書: Safety の型（CC-015、CC-028）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: P18b
- 目的: 不変条件の違反の型を1つにし（CC-015）、Safety Ledger の分類の名前の型を閉じた一覧にする（CC-028）。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md` の第5章
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-implementation-plan.md` の P18b
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-015、CC-028
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、P18a（Context と page の期限。`src/orchestration/` と `src/crawl/site-metadata.ts`、`src/core/limits.ts`）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - 型のエラーが P18a の作業中のファイルから出ている場合は、自分のファイルのエラーでないことを確かめてください。そのうえで、報告に書いてください。

## 変更してよいファイル

- `src/core/contracts.ts`（CC-015 に限る）
- `src/safety/safety-ledger.ts`（CC-015 と CC-028 に限る）
- 型の名前が変わる場合に限り、その型を import しているファイル。ただし、`src/orchestration/`、`src/crawl/site-metadata.ts`、`src/core/limits.ts` は P18a が変えるので、変えない。
  - これらのファイルの import を変える必要がある場合は、Ledger の側で、今の名前を別名として残してください。
- テスト: `tests/unit/safety-ledger.test.ts`、`tests/unit/core-contracts.test.ts`（型のテストを加えることに限る）

## 作るもの

1. **CC-015**
   - 不変条件の違反の型を、core（`src/core/contracts.ts`）の1つにする。
     - 対象: `SafetyInvariantViolationSummary`（core）と `InvariantViolationEvent`（Ledger）
   - Ledger の `InvariantViolationEvent` は、core の型の別名にする。
   - 振る舞いと JSON の形は、変えない。
2. **CC-028**
   - Safety Ledger の分類の名前（`reachedCategories` など。`safety-ledger.ts:271, 282` 付近と、139〜216行の呼び出し）の型を、次のものに絞る。
     - `SafetyEventKind`（`src/core/evidence-types.ts`）
     - `'invariantViolations'`
   - 振る舞いは変えない。
3. **確かめ方**
   - 型の変更なので、RED は型の検査で作る。
     - `@ts-expect-error` で、誤った分類の名前が型のエラーになることを確かめる。
     - 誤った形の違反が型のエラーになることも、同じように確かめる。
   - 既存のテストが、変更なしで PASS することで、振る舞いが変わらないことを確かめる。

## 受け入れ条件

- 型のテストが、修正前に RED（`@ts-expect-error` が使われない）、修正後に GREEN になる。
- 既存のテストのケースと期待値を、変えない。
- 担当のテストと、`npm run typecheck`（自分のファイルについて）が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。
