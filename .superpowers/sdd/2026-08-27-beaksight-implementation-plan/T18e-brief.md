# T18e 指示書: ARCH04 の違反の修正、DEF-011（UI Gate のコメントの除去）、DELETE の fixture

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T18e
- 目的:
  - GATE-ARCH04 が検出した違反（`src/audit/cross-page-rules.ts` の、Origin の判定の別の実装）を直す。
  - UI Gate のコメントの除去の誤り（DEF-011）を直す。
- 設計書: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md` の 4.4（T18d の報告を受けて加えた部分）
- 実装計画: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-implementation-plan.md` の T18e
- 上位の文書: `doc/design/2026-08-27-beaksight-implementation-tasks.md` の ARCH04（URL Semantics SSOT）と SSOT Owner Matrix
- 前の報告: 作業記録置き場の `T18d-report.md`
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-011
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（`normalizeUrl`、`classifyUrl`、`canonicalizeAllowedOrigins` の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/audit/cross-page-rules.ts`（ARCH04 の3か所と、`originOf()` に限る）
- `src/crawl/normalize-url.ts`（URL の owner として、許可 Origin の中かの判定の関数を加える場合に限る。既存の関数の振る舞いは変えない）
- `tests/architecture/ui-ssot.test.ts`（DEF-011 と、共通の走査を使う形にすることに限る。検査の規則は変えない）
- `tests/architecture/source-scan.ts`（UI Gate が使うために、足りない機能を加える場合に限る。既存の振る舞いは変えない）
- `tests/architecture/semantic-ownership.test.ts`（ARCH04 の除外が不要になったことを確かめる場合に限る。除外の一覧に、`cross-page-rules.ts` を加えてはいけない）
- テスト: `tests/component/cross-page-rules.test.ts`、`tests/unit/normalize-url.test.ts` など、対応する既存のテスト
- `fixtures/site/delete-request.html`（新規。下の3に限る）
- `tests/integration/safety-gates.test.ts`（下の3に限る。S02 の Interaction の DELETE の確かめ方を、fixture を使う形にすることだけを変える）
- `tests/integration/gate-fixtures.test.ts`（新しい fixture の対照の確認を加えることに限る）

## 直すもの

1. **ARCH04 の違反**（`src/audit/cross-page-rules.ts:213、397、590` 付近と `originOf()`）
   - URL が許可 Origin の中かの判定を、URL の owner の判定に置き換える。
     - `classifyUrl(new URL(url), { allowedOrigins })` の結果で判定できる場合は、それを使う。
     - `classifyUrl` の分類と、今の判定の意味がずれる場合は、URL の owner（`normalize-url.ts`）に、許可 Origin の中かだけを判定する関数を加え、それを使う。
       - ずれる場合の例: 内部の Origin でも、ナビゲーションの対象でないものを、別の分類にする場合
       - 判定の関数は、`classifyUrl` と同じ内部の処理（Origin の正規化と比較）を使い、同じ判定を2つ書かない。
     - どちらにしたかと、その理由を報告する。
   - Rule のファイルの中に、`new URL(...).origin` と `allowedOrigins.has(...)` による判定を残さない。
   - 振る舞いは変えない。
     - 既存の Cross-page のテストが、変更なしで PASS すること。
     - 3か所のそれぞれについて、境界の例（許可 Origin の中、外、http と https の違い、ポートの違い、正規化できない URL）で、前と同じ結果になることを確かめるテストを加える。
       - 前と同じ結果になることの確かめ方: 置き換えの前に、今の実装でそのテストを書いて PASS させ、置き換えの後も PASS すること。
   - GATE-ARCH04 が、除外の一覧に何も加えずに PASS すること。
2. **DEF-011 UI Gate のコメントの除去**
   - RED: 文字列の中に `/*` や `//` がある例で、今の `stripComments` が、後ろのコードを誤って消すことを確かめるテストを、まず書く。
   - 修正:
     - UI Gate（`ui-ssot.test.ts`）のコメントの除去とファイルの読み込みを、`tests/architecture/source-scan.ts` の走査を使う形にする。
     - 同じ処理（ファイルの一覧の取得、読み込み、コメントの除去）を、2か所に持たない。
   - UI Gate の検査の規則そのものは、変えない。
   - 直した後、これまで抜け落ちていた範囲（例: `passive-request-guard.ts:1385` から1481行）にも、UI Gate の検査が働くことを確かめる。
     - その範囲に違反が見つかった場合は、止まって報告する。
   - UI Gate、Architecture の Gate の各ファイルが、1秒以内に終わること。所要時間を報告に書く。

3. **DELETE の fixture**（T18b の報告の判断1）
   - `fixtures/site/delete-request.html` を加える。ボタンを押すと `DELETE /__mutation` を1回送るページで、`put-request.html` と `patch-request.html` と同じ形にする。
   - 対照の確認を、`tests/integration/gate-fixtures.test.ts` に加える。Guard のない Context で押すと、サーバで `delete` が1数えられることを確かめる。
   - `tests/integration/safety-gates.test.ts` の S02 の Interaction の DELETE を、テストの側から加える初期化のスクリプトではなく、この fixture を使う形に直す。
     - ほかのメソッド（POST、PUT、PATCH）と、確かめ方をそろえる。
     - Gate の条件は、弱めない。

## 受け入れ条件

- 各修正のテストが、修正前に RED、修正後に GREEN になる。
  - ARCH04 は、GATE-ARCH04 の FAIL が RED にあたる。
- 既存のテストのケースと期待値を、弱めない。
- `GATE-ARCH01`〜`GATE-ARCH08` と、UI Gate が、すべて PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。ARCH04 の置き換えで、`classifyUrl` を使ったか、判定の関数を加えたかと、その理由を書いてください。
