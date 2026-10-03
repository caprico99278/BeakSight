# BeakSight Task 18 の前の整理 設計書

作成日: 2026-09-25
対象範囲: Task 18（fixture の網羅と Acceptance Gates）に進む前に、Task 14〜17 のレビューで Task 18 の前に行うと決めた項目を直す。

## 1. 目的

Task 18 は、安全と監査の受け入れの Gate（Safety / Auditor Acceptance Gates）を、fixture で確かめる Task である。その前に、次のことを済ませる。

- Run が止まり続ける経路をなくす。
- 登録済みの不具合と共通化候補のうち、Task 18 の前に行うと決めたものを直す。

## 2. 根拠となる文書と優先順位

- 実装タスク指示 `doc/design/2026-08-27-beaksight-implementation-tasks.md`（Safety Invariants、完了の意味）
- Task 14〜17 の設計書 `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`（4.5.5、5.6、第7章）
- 作業記録置き場の次の文書
  - 不具合台帳 `defects.md` の DEF-008、DEF-009
  - 共通化候補台帳 `commonization-candidates.md` の CC-015、CC-025、CC-028
  - R15r のレビューの結果 `R15r-review-result.md` の Minor-3・4

この設計書は、上の文書の該当する部分を拡張する。上の文書と食い違う場合は、この設計書が優先する。

## 3. 対象の一覧

| ID | 内容 | 出どころ |
| --- | --- | --- |
| DEF-008 | Context の作成、page の作成、Context の終了に、期限がない | R15r の Minor-1 |
| R15r-4 | 期限のテストが、実際の時間（5〜10秒）を待っている | R15r の Minor-4 |
| CC-015 | 不変条件の違反の型が、core と Ledger に2つある | T12d0 の報告 |
| CC-028 | Safety Ledger の分類の名前の型が `string` である | C16e の報告 |
| DEF-009 | 同じ秒に始めた2つの Run が、同じディレクトリに書く | R16 の Minor-4 |
| R15r-3 | 例外でクロールが止まった経路では、実行時間の超過が記録されない | R15r の Minor-3 |
| CC-025 | COMPLETE の Run Status の入力の見本が、4か所にある | C16b の報告 |

## 4. DEF-008: Context と page の作成・終了の期限

### 4.1 調査の結果（2026-09-25。読み取り専用の調査による）

- 期限があるのは、次の2つだけである。
  - Interaction の owner の `session.close()`（`observeCloseUntil`）
  - page-auditor で見放した session の `close()`
- 期限がない箇所: 約20か所
  - 作成（`newContext`、Guard の取り付け、`newPage`、`awaitPassiveRequestGuardReady`、`createInteractionSession`）
  - Context の終了（`closePassiveContext`）
  - 呼び出し元: preflight、environment、site-metadata、page-auditor、stress-session、isolated-auditor
- どれか1つが終わらないと、Run Coordinator の `finally` の Browser の終了に進めない。その結果、CLI のプロセスも終わらない。
- `context.close()` が終わらない間も、Guard はリクエストを止め続ける。
  - phase は CLOSING か INVALIDATING のままで、listener と route は外れない。
  - HTTP は `route.abort`、WebSocket は close、CDP で一時停止した Document は `Fetch.failRequest` になる。
- 作成を見放す仕組みは、今のコードにない。そのため、「遅れて成功した」Context の後始末もない。

### 4.2 方針

- **期限は、呼び出す側（`src/orchestration/`）で付ける。** DEF-006（page と Browser の終了の期限）と同じ形である。
  - Guard（`src/safety/passive-request-guard.ts`）と factory（`src/browser/context-factory.ts`）の振る舞いは、変えない。
  - 理由: 4.1 のとおり、閉じる処理が止まっても、Guard はリクエストを止め続ける。期限を過ぎたときに Guard の状態を変えると、安全の境界に関わる。呼び出す側が「待つのをやめる」だけなら、安全の境界は変わらない。
- **期限を過ぎたことは、違反ではなく、未完了の理由にする。**
  - 閉じる処理が期限を過ぎたことは、DEF-006 と同じく、閉じる処理の失敗として記録する。
  - 閉じる処理の期限切れがあれば、Run は `COMPLETE` にならない。どの呼び出し元でも、同じである（RP18 の指摘1を受けて、2026-09-25 に明確にした）。
    - 理由: Context が閉じたことを確かめられていないので、後始末が未完了である。
  - 作成の期限切れの扱いは、呼び出し元ごとに 4.4 の表のとおりにする。
    - 例えば、環境の読み取りの作成の期限切れは、今の作成の失敗と同じく、User-Agent を未観測にするだけである。環境の事実は、監査の必須の部分ではないので、Run は `COMPLETE` になりうる。
  - 遅れて届いた Context の Ledger は、ページの Safety の集計には入らない。一方、Run の集計には入る（Ledger の登録から集計するため）。
    - そのため、Run とページの違反の件数が、食い違うことがある。Run Status の判定は、Run の集計で行うので、保たれる（RP18 の指摘5を受けて、2026-09-25 に受け入れた）。
  - 違反（`ABORTED_BY_SAFETY`）にはしない。安全の不変条件が破られたわけではないためである。
- **期限の値**（`src/core/limits.ts` に置く）
  - `CONTEXT_CLOSE_TIMEOUT_MS = 5_000`: Context の終了を待つ上限。page の終了（`PAGE_CLOSE_TIMEOUT_MS`）と同じ値である。
  - `SESSION_OPEN_TIMEOUT_MS = 10_000`: Context と page の作成（Guard の取り付けと準備を含む）を待つ上限。
  - 呼び出し元に、より短い全体の期限がある場合（ページの期限、Interaction の候補の予算など）は、短い方を使う。
- **遅れて届いた Context の後始末**
  - 作成が期限を過ぎた後に、Context が届いた場合は、それを `closePassiveContext` で閉じる。
    - この終了も、`CONTEXT_CLOSE_TIMEOUT_MS` の期限で待つ。
    - 結果は捨てる（P18a の報告の判断1を受けて、2026-09-25 に決定）。
      - 期限を過ぎたこと自体は、呼び出し元が、すでに失敗か未完了として記録している。
      - 閉じる処理が終わらない間も、Guard はリクエストを止め続ける。最後は、Browser の終了で片付く。
      - 部品は、結果を受け取る口（`onLateContextRelease`）を持つ。今は、どの呼び出し元も使わない。
  - page だけが遅れて届いた場合は、Context を閉じれば一緒に閉じる。
  - 後始末の部品は、1か所に置く（4.3）。`isolated-auditor.ts` の `releaseLateValue` と同じ考え方である。
- **期限は注入できるようにする**（R15r-4）
  - 期限の値は、部品の省略できる引数か、依存として注入できる形にする。既定値は `limits.ts` の定数とする。
  - DEF-006 の既存のテスト（page の終了の5秒、Browser の終了の10秒を実際に待つもの）も、短い期限を注入する形に直す。
  - テストの結果の条件は、弱めない。

### 4.3 部品

`src/orchestration/passive-session-close.ts` と、新しい `src/orchestration/passive-session-open.ts` に置く。名前は例であり、実装者が決めて報告する。

- `closePassiveContextBeforeDeadline(factory, context, options?)`
  - Context を期限付きで閉じ、失敗の記録を返す。
  - `closePassivePageAndContext` は、これを使う。
- `openPassiveSessionBeforeDeadline(factory, viewport, deadlineAtMs, options?)`
  - Context と page を、期限付きで作る。
  - 期限を過ぎた場合は、期限切れを返す。遅れて届いた Context は、4.2 のとおり閉じる。
  - Guard の取り付けの失敗（`ContextConstructionError`）など、今の失敗の扱いは変えない。
- `createInteractionSession` を期限付きで作る部品も、同じ考え方で置く。
  - 置き場所は、Interaction の owner の境界に合わせて決める。`isolated-auditor.ts` の中の既存の部品（`awaitInteractionBrowserWork` など）を使える場合は、使う。

### 4.4 呼び出し元ごとの、期限を過ぎたときの扱い

| 呼び出し元 | 期限を過ぎたときの扱い |
| --- | --- |
| PREFLIGHT（`preflight.ts`） | PREFLIGHT の失敗とする（Run は `FAILED`）。対象のサイトには、アクセスしない |
| 環境の読み取り（`environment.ts`） | 今の失敗の扱い（User-Agent を未観測にする）と同じにする |
| サイトの metadata（`site-metadata.ts`） | 今の取得の失敗の扱いと同じにする。閉じる処理の期限切れは、`closeFailures` に記録する |
| Page Auditor（`page-auditor.ts`） | ビューポートの失敗として、`COLLECTOR_INCOMPLETE` か `DEADLINE_EXCEEDED` の理由を付ける（今の段階の失敗の扱いと同じ）。閉じる処理の期限切れは、閉じる処理の失敗として記録する |
| 幅の走査（`stress-session.ts`、`layout-collector.ts`） | 幅の走査を未完了とする（今の失敗の扱いと同じ） |
| Interaction（`isolated-auditor.ts`） | その候補の結果を `NOT_VERIFIABLE`（`CHECK_NOT_COMPLETED`）とする。凍結の失敗の後の無効化（`failClosed`）を待つ処理にも、呼び出す側で期限を付ける |

- どの場合も、今の失敗の扱いを変えずに、「期限を過ぎた」という新しい失敗の形だけを加える。
- 期限を過ぎた後も、Run は確定して返り、CLI は終わること。

### 4.5 Guard のレビュー

- DEF-008 の修正の後に、Guard の独立レビューを行う。Guard のファイルを変えなくても、行う。
- 確かめること:
  - 期限を過ぎた後も、Guard がリクエストを止め続けること。
  - 遅れて届いた Context が閉じられること。
  - 違反の記録が、今までと変わらないこと。
  - Run が止まり続ける経路が、残っていないこと。

## 5. CC-015 と CC-028: Safety の型

- **CC-015**
  - `src/core/contracts.ts` の `SafetyInvariantViolationSummary` と、`src/safety/safety-ledger.ts` の `InvariantViolationEvent` を、core の1つの型にする。
  - Ledger の型は、core の型の別名にする。
- **CC-028**
  - Safety Ledger の分類の名前（`reachedCategories` など）の型を、`SafetyEventKind`（`src/core/evidence-types.ts`）と `'invariantViolations'` に絞る。
- どちらも、振る舞いと JSON の形を変えない。型の変更だけである。
- 安全の部品なので、4.5 の Guard のレビューの対象に含める。

## 6. DEF-009: Run のディレクトリの排他的な作成

- Run Coordinator は、Run の開始の時点（PREFLIGHT の前）で、Run のディレクトリを排他的に作る。
  - 親のディレクトリ（出力先）は、`recursive` で作ってよい。
  - Run のディレクトリそのものは、`recursive` なしで作り、すでにあれば失敗させる（`EEXIST`）。
- 作れなかった場合:
  - 対象のサイトにアクセスせずに、Run を終える。
  - Run Status は `FAILED` とし、PREFLIGHT の失敗と同じ扱いにする。
  - 理由には、Run のディレクトリを作れなかったことが分かるコードと detail を付ける。
    - 既存の理由のコードで表せない場合は、新しいコードを加える。
    - その場合は、スキーマ、`messages.ts` の説明、UI05 も合わせて直す。
- 失敗した Run の artifact は、書かない。書く場所が、別の Run のディレクトリだからである。
  - CLI は、終了コード 1 で終える。
  - 日本語の文言で、Run のディレクトリがすでにあることを示す。
- テスト: 同じ `runId` の2つの Run で、2つ目が対象のサイトにアクセスせずに `FAILED` になり、1つ目の artifact を変えないことを確かめる。

## 7. R15r-3: 例外でクロールが止まった経路の、実行時間の超過の記録

- 例外でクロールが止まった経路でも、実行時間の上限を過ぎていた場合は、`crawlLimits.maxRuntimeReached` を真にする。
- 記録の規則は、設計書 5.6.3 と同じにする。監査していない URL が残らない場合は、理由を付けない。
- Run Status の決め方は、変えない。

## 8. CC-025: COMPLETE の入力の見本

- 次の3つのテストファイルは、`tests/helpers/audit-run-fixture.ts` の `runStatusInput` を使う形にする。
  - `tests/unit/status.test.ts`
  - `tests/unit/safety-ledger.test.ts`
  - `tests/unit/run-coordinator.test.ts`
- テストのケースと期待値は、変えない。

## 9. 対象外

- CC-008 の残り（`discover-candidates.ts` の中の複製）と、CC-010 の残り（理由のコードと英文の混在）。Task 18 の後、Task 19 の前に行う。
- Guard と factory の振る舞いの変更。
- 実サイトへのアクセス（機能の完成まで禁止）。

## 10. 完了条件

- [ ] 4〜8章の各修正に対応するテストが、修正前に RED、修正後に GREEN になる。構造の変更は、代わりの確かめ方を記録する。
- [ ] 作成と終了の処理が終わらない偽の Browser や Context で、Run が期限の中で確定して返り、CLI が終わることを確かめる。
- [ ] 期限のテストが、実際の時間を待たない。
- [ ] Guard の独立レビューで、Critical 0・Important 0 である。
- [ ] `npm run verify` が PASS する。
- [ ] 共通部品台帳、不具合台帳、共通化候補台帳が更新されている。

## 10.1 整理の完了（2026-09-25）

- P18a〜P18e を行い、RP18（Guard の独立レビュー）と RP18r（確認のレビュー）で、Critical 0・Important 0 になった。
- 最後の verify は、89ファイル・3141件で PASS した。
- 残りの Minor（RP18r の Minor-1・2）は、Task 18 の後の整理で行う。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | RP18 | 4.2 に、閉じる処理の期限切れでは Run を `COMPLETE` にしないことの明確化、作成の期限切れの扱い、Run とページの違反の件数の食い違いを加えた | P18e |
| 2026-09-25 | P18a の報告 | 4.2 の、遅れて届いた Context の結果の扱いを、「捨てる」に直した | P18c、P18d |
| 2026-09-25 | 初版。R15r、R16、C16b、C16e で、Task 18 の前に行うと決めた項目 | - | Task 18 の前の整理 |
