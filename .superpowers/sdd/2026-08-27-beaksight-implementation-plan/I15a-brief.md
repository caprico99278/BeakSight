# I15a 指示書: Interaction の NOT_VERIFIABLE の区分を、Evidence に持たせる

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: I15a
- 目的: Task 15 の Run Status への反映（設計書 5.4.1）に使うため、Interaction の Evidence に、`NOT_VERIFIABLE` の区分を持たせる。
- 設計書: `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 5.4.1
- 前の報告: 作業記録置き場の `P14d-report.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/core/evidence-types.ts`（Interaction の型に限る）
- `schemas/page.schema.json`（Interaction の定義に限る）
- `src/interaction/isolated-auditor.ts`
- `src/evidence/interaction-collector.ts`（必要な場合に限る）
- テスト:
  - `tests/integration/isolated-interaction.test.ts`
  - `tests/unit/schema-validator.test.ts`（Interaction の見本に限る）
  - `tests/unit/schema-enum-consistency.test.ts`
  - `tests/unit/core-contracts.test.ts`
  - `tests/integration/page-auditor-interaction.test.ts`（見本の更新に限る）

## 作るもの

1. **閉じた一覧**
   - core に、`INTERACTION_NOT_VERIFIABLE_KINDS = ['OBSERVED_NO_CHANGE', 'CHECK_NOT_COMPLETED'] as const` と、その型を置く。
     - `OBSERVED_NO_CHANGE`: 確かめる手順を最後まで行った。そのうえで、変化が見えなかったか、サイトの振る舞いのために確かめられないと結論した。
       - 例: `No observable change before interaction deadline`、`Target state changed on focus during preparation`
     - `CHECK_NOT_COMPLETED`: 確かめる手順を、終えられなかった。
       - 例: 期限切れ（読み込み、下準備、安定性の確認、持続の確認）、下準備の失敗、作業量の上限、比べられない（`could not be compared`）
2. **Evidence の項目**
   - `InteractionEvidence` に、`notVerifiableKind: InteractionNotVerifiableKind | null` を加える。
     - `status` が `NOT_VERIFIABLE` の場合だけ、値を持つ。ほかの状態では null とする。
   - スキーマも直す。
     - `NOT_VERIFIABLE` のときは、null でないこと。
     - ほかの状態のときは、null であること。
     - JSON Schema の `if` と `then` で表せる範囲で表す。
3. **理由との対応**
   - `isolated-auditor.ts` で `NOT_VERIFIABLE` を返すすべての経路で、区分を決める。
   - 区分は、理由の定数と1対1に対応させる。対応表は、1か所にまとめる。
   - 対応表に、すべての理由の定数を載せる。
     - 新しい理由を加えたときに、対応表に載せ忘れると、テストか型で失敗するようにする。
   - 対応表を、報告に書く。
   - 判断に迷う理由があれば、止まらずに `CHECK_NOT_COMPLETED` に寄せる。その理由と、寄せた判断を報告する。
     - `CHECK_NOT_COMPLETED` に寄せると、Run が PARTIAL になる。完了の偽りを避ける側の判断である。

## テスト

- 次の場合の区分を確かめる。既存の fixture を使ってよい。
  - 何もしないボタン: `OBSERVED_NO_CHANGE`
  - focus で状態が変わるボタン: `OBSERVED_NO_CHANGE`
  - 読み込みの期限切れ: `CHECK_NOT_COMPLETED`
  - 下準備の期限切れ: `CHECK_NOT_COMPLETED`
  - 作業量の上限: `CHECK_NOT_COMPLETED`
- `VERIFIED` などの状態では、null になる。
- スキーマで、次の2つが拒まれる。
  - `NOT_VERIFIABLE` なのに null の見本
  - ほかの状態なのに値がある見本
- 対応表に、すべての理由が載っていることを確かめる。

## 受け入れ条件

- 各項目で、修正前に RED、修正後に GREEN になる。
- 既存の Interaction のテストは、すべて PASS する。
- `tests/integration/isolated-interaction.test.ts` を2回続けて実行し、2回とも PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。このサブタスクでは build を実行してよい。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、対応表を含めてください。
