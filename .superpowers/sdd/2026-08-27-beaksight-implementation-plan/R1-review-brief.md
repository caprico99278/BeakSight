# R1 指示書: Task 11 の仕様の再レビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

今回の担当は **Task 11 の仕様への適合の再レビュー** です。

- 対象: 前回の仕様レビュー（`task-11-review-2026-09-23-spec.md`）の指摘 I1〜I3、M1〜M3 が解消されたかを確かめてください。あわせて、基盤修正の設計書の 4.1〜4.8、4.7、5.5（discover-candidates の分）、8.1（DEF-001）に照らして、Task 11 の範囲に新たな逸脱がないかを確かめてください。
- 主な実装ファイル: `src/interaction/discover-candidates.ts`、`src/interaction/isolated-auditor.ts`、`src/safety/interaction-policy.ts`、`src/safety/passive-request-guard.ts`、`src/browser/context-factory.ts`、`src/evidence/interaction-collector.ts`、`src/safety/safety-ledger.ts`
- 主なテスト: `tests/integration/isolated-interaction.test.ts`、`tests/integration/passive-request-guard.test.ts`、`tests/component/context-factory.test.ts`、`tests/unit/interaction-policy.test.ts`、`tests/unit/safety-ledger.test.ts`
- 関係する報告: `C2-report.md`、`C3-report.md`、`F02b-report.md`
