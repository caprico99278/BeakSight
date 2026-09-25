# R''2 指示書: 型・スキーマ・DOM・設定の修正の最後の確認

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

## 担当

確認のレビュー R'2（`Rp2-review-result.md`）の I-2・m2・m3・m4・m5 について、次の修正で解消したかを確かめてください。あわせて、F12 の値の一覧（enum）の SSOT 化が正しいかを確かめてください。

- 修正の報告: `F09-report.md`、`F11-report.md`、`F12-report.md`

## とくに確かめること

- scroll の Evidence の種類が、型（`EvidencePayloadByType`）、ID の接頭辞、スキーマのすべてで一致していること。
- Link が1か所（link の Evidence）だけに格納され、DOM の Evidence に複製がないこと（実装タスク指示 4.3、ARCH03）。Task 14〜17 の設計書（`doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md`）の記述とも合っていること。
- shadow root の中の入力欄が記録されること。
- 設定の検証（`startUrl` の正規化、locale、timezone）が、実行時の判定と一致していること。
- 値の一覧（enum）が core の1か所にだけあり、スキーマの enum と一致すること。`tests/unit/schema-enum-consistency.test.ts` が、表の外の enum を本当に検出できること。例えば、表の一部を外したらどうなるかを、コードを読んで確かめる。ファイルは編集しないこと。
- 共通部品台帳（`doc/design/beaksight-shared-components.md`）の記述が、実装と合っていること。
- Task 12 以降の実装者がこれらの型を使うときに、足りないものや矛盾がないこと。

## 対象のファイル

- `src/core/contracts.ts`、`src/core/evidence-types.ts`、`src/core/ids.ts`
- `schemas/*.json`
- `src/evidence/dom-collector.ts`、`src/evidence/performance-collector.ts`、`src/evidence/console-collector.ts`、`src/evidence/layout-collector.ts`（F12 の置き換えの部分）
- `src/config/validate-config.ts`
- `tests/unit/schema-enum-consistency.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/config.test.ts`、`tests/component/dom-collector.test.ts`
