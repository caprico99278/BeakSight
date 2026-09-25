# C15x 指示書: Task 15 の後の整理（CC-021、DEF-006、DEF-007、R15 の Minor-1・2）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C15x
- 目的: Task 15 の間に見つけた、共通化の候補1つと、潜在的な不具合1つを直す。
  - CC-021: 理由の組み立てと、件数の加算の重複
  - DEF-006: page を閉じる処理に期限がない
- 共通化候補の台帳: 作業記録置き場の `commonization-candidates.md` の CC-021
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-006（原因は、DEF-005 の調査にある）
- 関連する報告: `DEF-005-report.md`、`R15d-report.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。不具合がいつからあったかを確かめるために、HEAD に戻すことも禁止です。

このサブタスクは単独で実行します。CC-021 は、振る舞いを変えない整理です。

R15e の変更も、作業ツリーに残っています。`run-coordinator.ts` は、R15e の後の形を前提にしてください。

## 変更してよいファイル

- `src/core/status.ts`（理由の組み立ての関数を置く場合）
- `src/core/limits.ts`（閉じる処理の期限の定数を置く場合）
- `src/safety/safety-ledger.ts`（上限付きの加算を公開する場合）
- `src/orchestration/page-auditor.ts`、`src/orchestration/run-coordinator.ts`、`src/orchestration/run-aggregation.ts`（使う側の置き換えに限る）
- `src/orchestration/passive-session-close.ts`（DEF-006）
- `src/browser/context-factory.ts`（DEF-006 で必要な場合に限る）
- `tests/helpers/passive-cleanup.ts`（DEF-006）
- `src/crawl/site-metadata.ts`、`src/orchestration/preflight.ts`、`src/orchestration/environment.ts`（R15 の Minor-1・2 と、コメントの修正に限る）
- `src/orchestration/page-auditor.ts`、`src/orchestration/run-coordinator.ts`（DEF-007 に限る）
- テスト: 対応する unit・component・integration のテスト

`src/safety/passive-request-guard.ts` を変える必要が出た場合は、止まって報告してください。

## 修正する内容

### 1. CC-021 理由の組み立てと、件数の加算

- `UNHANDLED_FAILURE` の理由（`<場面>:<メッセージ>`）を作る関数を、1つにする。
  - 置き場所は、`src/core/status.ts` の `collectorIncompleteReason` の近くとする。
  - メッセージの上限と、制御文字の扱いは、今の2か所の実装のうち、厳しい方にそろえる。どちらにそろえたかを、報告する。
- Rule の評価の失敗の理由（`${ruleId}:${message}`）を作る関数を、1つにする。
- 違反の件数の、上限付きの加算を、1つの関数にする。`safety-ledger.ts` の `saturatingAdd` を公開して使うか、core に置く。
- 使う側を、すべて置き換える。同じ意味の処理が残っていないことを、`grep` で確かめて報告する。
- 既存のテストは、変更なしで PASS すること。新しい関数には、単体テストを書くこと。

### 2. DEF-006 page を閉じる処理の期限

- 背景（DEF-005 の調査による）
  - エラーページを表示している page で、次のナビゲーションも失敗し、その直後に `page.close()` を呼ぶことがある。この場合、Chromium は page を閉じず、`page.close()` は永久に終わらない。
  - `context.close()` なら、止まった page もすぐに閉じる。
- 修正:
  - `closePassivePageAndContext` で、page を閉じる処理を、期限付きで待つ（`awaitBeforeDeadline`）。
    - 期限は、名前を付けた定数にする（例: `PAGE_CLOSE_TIMEOUT_MS`）。値と根拠を報告する。
  - 期限を過ぎた場合は、page を閉じる処理の失敗として記録する。そのうえで、Context を閉じる処理に進む。
    - Guard が Context を閉じていない場合に限る。
    - 期限を過ぎた後に遅れて返る結果と例外は、封じ込める。
  - `tests/helpers/passive-cleanup.ts` も、同じ扱いにする。ほかのテストで同じ問題が起きないようにするためである。
  - Guard の `closePassiveGuardedPage` と、factory の `closePassivePage` を変える必要があるかを調べ、報告する。
    - 変えなくても、上の対応で止まらなくなる場合は、変えない。
    - Guard を変える必要がある場合は、止まって報告する。
- テスト:
  - DEF-005 で見つかった条件を、再現する（エラーページで2回目のナビゲーションも失敗し、その直後に閉じる）。
  - `closePassivePageAndContext` が、期限の中で戻り、Context が閉じていることを確かめる。修正前に RED、修正後に GREEN になること。
    - 修正前は、テストの期限で失敗することを、RED とする。
  - 期限を過ぎたことが、閉じる処理の失敗として記録されることを確かめる。
  - Page Auditor の閉じる処理（理由の `passive-page-close`）と、幅の走査のセッションの閉じる処理（例外）で、振る舞いが設計どおりであることを確かめる。

### 3. R15 の Minor-1・2 期限のない処理（作業記録置き場の `R15-review-result.md`）

- `src/crawl/site-metadata.ts` の、page を閉じる処理（`closePassivePage` の直接の呼び出し）にも、DEF-006 と同じ期限を付ける。
  - 期限を過ぎた場合は、Context を閉じる処理に進む。
  - 使える場合は、DEF-006 で作る部品を使う。
- `browser.close()` に期限を付ける。対象は、`run-coordinator.ts` と `preflight.ts` にある。
  - 期限は、名前を付けた定数にする。
  - 期限を過ぎた場合は、閉じる処理の失敗として、理由を記録する。
  - Run は、確定して返す。
- `environment.ts` の User-Agent を読む `page.evaluate` に、期限を付ける。
  - 期限を過ぎた場合は、null とする。
- それぞれの期限を過ぎた場合の振る舞いを、テストで確かめる。偽の Browser や page を使ってよい。

### 4. DEF-007 再試行でスクリーンショットが上書きされる（不具合台帳の DEF-007）

- 再試行の前の試行のスクリーンショットを、`pages/<pageId>/retry-<n>/<ビューポート>/` に置く。最終の試行のものは、これまでの場所に置く。
- Coordinator から Page Auditor に、試行を区別する情報を渡す。
  - 渡し方は、実装者が決めて報告する。例えば、`audit` の引数か、依存の追加である。
  - スクリーンショットのパスの組み立ては、1か所のままにする。
- テストで、次のことを確かめる。修正前に RED、修正後に GREEN になること。
  - 再試行したページで、最初の試行の `screenshot` の Evidence が、最初の試行の画像を指す。
  - 最終の試行の画像が、上書きしていない。

### 5. 古いコメント（R15e の発見事項）

- 次の2つの説明を、「Ledger は、Run の Ledger の登録から集計する」という今の形に合わせて直す。
  - `src/orchestration/preflight.ts` の `safetyLedgers`
  - `src/orchestration/environment.ts` の `onSafetyLedger`

## 受け入れ条件

- DEF-006 と DEF-007 のテストは、修正前に RED、修正後に GREEN になる。
- CC-021 は、既存のテストが変更なしで PASS する。
- 同じ意味の処理が残っていないことを、`grep` で確かめて報告する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。新しく作った関数と定数の、シグネチャと値を書いてください。
