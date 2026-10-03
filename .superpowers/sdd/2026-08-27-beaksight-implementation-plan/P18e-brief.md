# P18e 指示書: Task 18 の前の整理の仕上げ（RP18 の指摘、CC-025、CC-028 の残り、期限の検証の置き場所、テスト補助の期限、BOM の表記）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: P18e
- 目的: Task 18 の前の整理で残った、小さな項目をまとめて直す。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md` の第5章と第8章
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-implementation-plan.md` の P18e
- 前の報告: 作業記録置き場の次のもの
  - `P18a-report.md`（判断6、発見事項1）
  - `P18b-report.md`（判断1）
  - `P18d-report.md`（判断4）
  - `R17r-review-result.md`（Minor-3）
  - `RP18-review-result.md`（Guard の独立レビューの結果。指摘1〜3を、この指示書で直す）
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-025、CC-028
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/deadline.ts`（期限の値の検証の関数を置くことに限る）
- `src/orchestration/environment.ts`、`src/orchestration/stress-session.ts`、`src/orchestration/run-coordinator.ts`（RP18 の指摘1〜3に限る）
- 期限の注入を下へ渡すために必要な場合に限り、`src/orchestration/preflight.ts`、`src/crawl/site-metadata.ts`、`src/orchestration/page-auditor.ts` の引数
- `src/orchestration/passive-session-close.ts`、`passive-session-open.ts`、`preflight.ts`、`run-coordinator.ts` など、`passiveTimeoutMs` を使っているファイル（呼び出しの置き換えに限る）
- `src/safety/safety-ledger.ts`（CC-028 の型に限る。振る舞いは変えない）
- `src/config/load-config.ts`（BOM の表記に限る）
- `tests/helpers/passive-cleanup.ts`
- テスト:
  - `tests/unit/status.test.ts`、`tests/unit/safety-ledger.test.ts`、`tests/unit/run-coordinator.test.ts`（CC-025）
  - `tests/unit/config.test.ts`（BOM の表記）
  - `tests/unit/deadline.test.ts` など、`deadline.ts` のテスト
  - `tests/integration/passive-session-close.test.ts` など、`closePassiveResources` を使うテスト（期限の注入に限る）
  - `tests/integration/environment.test.ts`、`tests/integration/stress-session.test.ts`（RP18 の指摘に限る）
  - Run 全体のテストを置くファイル（例: `tests/unit/run-coordinator.test.ts`、`tests/integration/crawl-run.test.ts`）

## 直すもの

1. **期限の値の検証の置き場所**（P18a の判断6）
   - `passive-session-close.ts` の `passiveTimeoutMs(value, defaultMs)` を、`src/core/deadline.ts` に汎用の名前で移す。
     - 名前の例: `resolveTimeoutMs`
     - 振る舞いは変えない。`undefined` なら既定値を返す。正の安全な整数でなければ、`RangeError` を投げる。
   - 呼び出し元は、すべて新しい関数を使う。元の関数は消す。再 export もしない。
     - 呼び出し元: `passive-session-close.ts`、`passive-session-open.ts`、`preflight.ts`、`run-coordinator.ts` など
2. **テスト補助の期限**（P18a の発見事項1）
   - `tests/helpers/passive-cleanup.ts` の `closePassiveResources` の期限（今は既定の5秒）を、注入できる形にする。
   - これを使うテストで、実際の時間を待っているものは、短い期限を注入する形に直す。
   - 直す前と後の、そのテストの実行時間を、報告に書く。
3. **CC-028 の残り**（P18b の判断1）
   - 数えられなかった遮断の分類の名前（`#recordUncountedBlockedRequest` の引数）を、閉じたテンプレートの型にする。
     - 型の例: `'blockedRequestsByMethod' | \`blockedRequestsByMethod.${string}.counter\``
   - `#reachedCategories` の型を、`SafetyLedgerRecordCategory` とその型の和にする。
   - 値、JSON、既存のテストは変えない。
   - `evidence-types.ts` の `SafetyLedgerRecordLimits.reachedCategories` とスキーマは、`string` のままにする。
   - 型のテスト（`@ts-expect-error`）で、誤った分類の名前が型のエラーになることを確かめる。
4. **CC-025**（設計書 第8章）
   - `tests/unit/status.test.ts`、`tests/unit/safety-ledger.test.ts`、`tests/unit/run-coordinator.test.ts` の、COMPLETE の Run Status の入力の見本を、`tests/helpers/audit-run-fixture.ts` の `runStatusInput` を使う形にする。
   - テストのケースと期待値は、変えない。置き換えの前後で、PASS の件数が同じであること。
5. **BOM の表記**（R17r の Minor-3）
   - `src/config/load-config.ts` と `tests/unit/config.test.ts` の BOM を、見えない文字のまま書かずに、`'\uFEFF'` と書く。
6. **RP18 の指摘1（Important）: 環境の読み取りの、Context の終了の期限切れ**
   - 場所: `src/orchestration/environment.ts:165` 付近
   - 今は、`closePassivePageAndContext` が返す失敗（期限切れを含む）を捨てている。
   - 閉じる処理の失敗と期限切れを、Run の理由にする（例: `UNHANDLED_FAILURE`、detail は `environment-context-close:<メッセージ>`）。
     - 理由の組み立ては、`src/core/status.ts` の既存の関数（`unhandledFailureReason` など）を使う。
     - 環境の読み取りの結果に、この失敗を載せて、Run Coordinator が Run の理由に加える形にしてよい。形は、実装者が決めて報告する。
   - 作成の期限切れは、今のまま（User-Agent を未観測にするだけ）とする（設計書 4.2）。
   - テスト: 環境の読み取りの Context の終了だけが期限を過ぎる場合に、Run が `COMPLETE` にならず、理由が付くことを確かめる。修正の前に RED になること。
   - ほかの呼び出し元（PREFLIGHT、サイトの metadata、Page Auditor、幅の走査）で、閉じる処理の期限切れを捨てている所がないかも確かめ、あれば同じく直して報告する。
7. **RP18 の指摘2: Run 全体の期限の注入とテスト**
   - Run Coordinator に、期限の注入の口（`deadlines` など）を加え、PREFLIGHT、環境、サイトの metadata、Page Auditor へ下へ渡す。既定値は、`limits.ts` の定数のままにする。
   - 終わらない偽の Browser（作成か終了が終わらないもの）で、Run が期限の中で確定して返ることを確かめるテストを、1件以上加える。
     - 少なくとも、「環境の読み取りの Context の終了だけが止まる」場合を含める（指摘1の再発を防ぐ）。
     - 実際の時間を待たない。短い期限を注入する。
8. **RP18 の指摘3: 幅の走査で、Context を閉じずに投げる経路**
   - 場所: `src/orchestration/stress-session.ts:89` 付近
   - `getSafetyLedger` が投げた場合などに、`opened.context` があれば、閉じてから投げる形にする。ほかの呼び出し元とそろえる。
   - テストで確かめる。
9. **そのほかの RP18 の指摘**
   - 指摘4は、Task 18 の Safety の Gate（T18b）で扱う。P18e では扱わない。
   - 指摘5は、受け入れた（設計書 4.2）。P18e では扱わない。

## 受け入れ条件

- 新しいテストが、修正前に RED、修正後に GREEN になる。
  - 名前の移動や表記の変更のように RED を作れないものは、代わりの確かめ方を報告に書く。
- 既存のテストのケースと期待値を、弱めない。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。直したものの番号ごとに、何をどう直したかを書いてください。
