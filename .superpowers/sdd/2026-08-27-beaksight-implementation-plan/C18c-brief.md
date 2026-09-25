# C18c 指示書: 小さな修正（ARCH04 の検出、`example` の名前、PREFLIGHT のメッセージ、幅の走査の理由、BOM、CC-030）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18c
- 目的: Task 18 のレビューと、その前の整理のレビューで、後に回した小さな項目をまとめて直す。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の第5章
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18c
- 前の報告: 作業記録置き場の次のもの
  - `R18-review-result.md`（M1、M4、参考）
  - `RP18r-review-result.md`（Minor-1・2）
  - `P18e-report.md`（発見事項1）
  - `T18d-report.md`、`T18e-report.md`
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-030
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18b（`tests/integration/safety-gates.test.ts`、`tests/helpers/gate-harness.ts`、`fixtures/site/`、`tests/integration/gate-fixtures.test.ts`）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - ほかの実装者の作業中のファイルから、型のエラーやテストの失敗が出た場合は、自分のファイルのものでないことを確かめて、報告に書いてください。

## 変更してよいファイル

- `tests/architecture/semantic-ownership.test.ts`（ARCH04 の検出に限る）
- `tests/architecture/ui-ssot.test.ts`、`tests/architecture/source-scan.ts`（CC-030 に限る）
- `src/audit/safety-rules.ts`（変数名の変更に限る）
- `src/orchestration/preflight.ts`（PREFLIGHT のメッセージに限る）
- `src/orchestration/page-auditor.ts`、`src/evidence/layout-collector.ts`（幅の走査の、閉じる処理の期限切れの理由に限る）
- `tests/unit/text.test.ts`（BOM の表記に限る）
- テスト（対応するものに限る）:
  - `tests/component/safety-rules.test.ts`
  - `tests/integration/preflight.test.ts`
  - `tests/integration/page-auditor.test.ts`
  - `tests/integration/stress-session.test.ts`
  - Layout の collector のテスト

## 直すもの

1. **ARCH04 の検出を広げる**（R18 の M1）
   - 次の書き方を検出する。
     - `.has(` と `.includes(` の引数に `origin` を含む場合（式や呼び出しを含む）
       - 例: `allowedOrigins.has(new URL(url).origin)`、`allowedOrigins.has(originOf(url))`
     - または、許可 Origin の集合（`allowedOrigins`）を、owner と除外の一覧の外で、判定に使うこと
   - どちらの規則にするかは、実装者が決めて報告する。
   - 検出の関数の単体テストに、上の書き方を違反の例として加える。
   - 今の `src/` で、GATE-ARCH04 が PASS することを確かめる。
     - 新しい誤検知が出た場合は、除外の一覧に理由を付けて加える。
     - 本当の違反が見つかった場合は、止まって報告する。
2. **`example` の変数名を変える**（R18 の参考）
   - `src/audit/safety-rules.ts` の変数名 `example`（「例」の意味の一般の語）を、意味の同じ別の名前（例: `sample`）に変える。
   - Finding の文言と、JSON の形は、変えない。
   - 既存の Safety の Rule のテストが、変更なしで PASS すること。
   - `src/` の中に `example` の語が残っていないことを、grep で確かめ、報告に書く。
     - ただし、テストの fixture や、`example.invalid` のような予約のドメインは除く。
3. **PREFLIGHT のメッセージ**（RP18r の Minor-1）
   - PREFLIGHT が失敗した場合も、閉じる処理の失敗（期限切れを含む）を、PREFLIGHT のメッセージに含める。
   - 対象の場合: 作成の期限切れの場合と、すでに失敗が決まっている場合
   - Run Status は、今までどおり `FAILED` か `ABORTED_BY_SAFETY` とする。
   - テストで確かめる。修正の前に RED になること。
4. **幅の走査の理由**（RP18r の Minor-2）
   - 幅の走査の、閉じる処理の期限切れが、段階の理由から読み取れるようにする。
     - 例: 理由の detail に、`CLOSE_DEADLINE_EXCEEDED` のような語を含める。
   - 新しい理由のコードは、加えない。既存のコードの detail で表す。
   - テストで確かめる。修正の前に RED になること。
5. **BOM の表記**（P18e の発見事項1）
   - `tests/unit/text.test.ts:12` の見えない BOM の文字を、表記（バックスラッシュと `uFEFF`）に直す。テストの意味は変えない。
   - ファイルの中に、見えない BOM のバイト（EF BB BF）が残っていないことを確かめる。
6. **CC-030 UI Gate の文字列リテラルの取り出し**（R18 の M4）
   - UI Gate の文字列リテラルの取り出しを、`source-scan.ts` の走査の `literals` に移す。
   - UI Gate の規則は、変えない。
     - とくに、テンプレートの `${…}` で区切った部分の扱いで、UI01 などの規則が広がらないようにする。
     - どう扱ったかを報告する。
   - R18 が挙げた、入れ子のテンプレートの取り違え（`src/report/html-components.ts` の例）がなくなることを、単体テストで確かめる。
   - UI Gate が、今の `src/` で PASS すること。

## 受け入れ条件

- 各修正のテストが、修正前に RED、修正後に GREEN になる。
  - 名前の変更と表記の変更のように RED を作れないものは、代わりの確かめ方を報告に書く。
- 既存のテストのケースと期待値を、弱めない。
- Architecture と UI の Gate の各ファイルが、1秒以内に終わる。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。直したものの番号ごとに、何をどう直したかを書いてください。
