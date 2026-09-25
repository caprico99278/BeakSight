# C2 指示書: 安全まわりの修正（Safety Ledger・Run Status・ダウンロード・session close）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C2
- 目的: レビュー指摘 R3、R6、V1/M3、I1/Q3 を修正する。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 4.1、4.7、6.3、6.5
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C2
- レビュー記録（指摘の詳細と再現条件）: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/` の `task-01-05-review-2026-09-23.md`（R3、R6）、`task-06-10-review-2026-09-23.md`（V1）、`task-11-review-2026-09-23-spec.md`（I1、M3）、`task-11-review-2026-09-23-quality.md`（Q3）
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（F01 で新設した deadline・errors・guards・immutable・text・limits）

同時に、ほかの実装者が別の範囲の修正（C1: 設定・クロール、C4: スクロールと収集位置、C7: performance・network・console・axe）を行っています。担当範囲の外のファイルは変更しないでください。

## 変更してよいファイル

- `src/safety/safety-ledger.ts`
- `src/safety/passive-request-guard.ts`
- `src/core/status.ts`
- `src/browser/context-factory.ts`
- テスト: `tests/unit/safety-ledger.test.ts`、`tests/unit/status.test.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/component/context-factory.test.ts`、`tests/integration/isolated-interaction.test.ts`（I1 に関わるテストの修正だけ）、および新規のテストファイル
- `fixtures/site/` への新しいページの追加（必要な場合のみ）

## 修正する内容

- **R3**（設計書 6.3）: Safety Ledger の記録上限への到達を `invariantViolations` に入れず、「記録が不完全」という別の事実（`truncated` と切り捨てた件数など）として記録する。本物の違反は、記録が満杯でも上書きしない。違反には別の上限を持たせ、上限に達しても件数は数え続ける。HTTPメソッドの長さの上限を超えた値は、違反ではなく、切り詰めて記録する。`deriveRunStatus()` の入力に「Ledger の記録が不完全」を加え、その場合は `PARTIAL` にする（`ABORTED_BY_SAFETY` にはしない）。再現条件: POST のブロックを257回記録すると `ABORTED_BY_SAFETY` になる。33文字以上のメソッドを1回記録すると違反になる。
- **R6**（6.5）: `deriveRunStatus()` に渡す安全違反の件数が、有限の0以上の整数でない場合（`Infinity`、`1.5`、負の数、`NaN`）は、`ABORTED_BY_SAFETY` を返す。
- **V1 / M3**（4.7）: Passive Context と Interaction Context を `acceptDownloads: false` で作る。Passive フェーズでページが起こしたダウンロードも、Safety Ledger の `blockedDownloads` に記録する（フェーズを区別できる形にする）。再現条件: ページのスクリプトが `<a download>` を click すると、ファイルが保存され、`blockedDownloads` が空になる。修正後は、保存されず、記録されること。
- **I1 / Q3**（4.1）: Guard が invalidation を経て終端に達した場合、`InteractionGuardedSession.close()` は、前回の close が非終端で失敗していたかどうかにかかわらず、factory の `closePassiveContext()` と同じく invalidated を表すエラーで reject する。所有の解放は `CLOSED` の時点で行う。`tests/component/context-factory.test.ts:382` 付近と `tests/integration/isolated-interaction.test.ts:2505` 付近の、`.resolves` を期待しているテストは、仕様違反を固定しているので、reject を期待する形に直す（設計書 4.1 に明記した是正であり、弱体化ではない）。この修正で `src/interaction/isolated-auditor.ts` の変更が必要になった場合は、変更せずに止まって報告する（isolated-auditor は C3 の担当）。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。
- `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/component/context-factory.test.ts`、`tests/unit/safety-ledger.test.ts`、`tests/unit/status.test.ts` がすべて PASS する。

## 報告

共通ルールの形式で報告してください。各項目（例: R1、V2）ごとに、RED・GREEN の結果を示してください。

## 追加の指示（F02b の報告を受けて）

- `src/core/text.ts` の `truncateText` は、入力が文字列かどうかを確かめない。そのため、共通化の前の `.slice` なら TypeError を投げていた入力（型に違反する数値など）も、そのまま返してしまう。`truncateText` が、文字列でない入力に対して TypeError を投げるようにする。`src/core/text.ts` の変更はこの1点だけとし、`tests/unit/text.test.ts` にテストを追加する。

## 追加の指示（F03 の完了を受けて）

- 新しく書くテストでは、`tests/helpers/` のテスト補助（`createTestConfig`、`useHeadlessChromium`、`closePassiveResources`、`createDeferred`）を使う。
