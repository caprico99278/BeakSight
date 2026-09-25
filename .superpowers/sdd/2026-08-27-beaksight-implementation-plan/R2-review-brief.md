# R2 指示書: Task 11 の品質の再レビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

今回の担当は **Task 11 のコード品質の再レビュー** です。別の担当者が仕様の再レビューを並行して行うので、あなたは品質（正しさ、堅牢性、保守性、テストの質）に集中してください。

- 対象: 前回の品質レビュー（`task-11-review-2026-09-23-quality.md`）の指摘 Q1〜Q6 が解消されたかを確かめてください。あわせて、その後の変更（C2・C3・F02b・F04・C8）で、新たな品質の問題が入っていないかを確かめてください。
- 観点: 非同期処理の正しさ（競合、unhandledRejection、解除漏れ）、敵対的なページへの耐性（無限ループ、巨大なDOM、奇妙な値）、型の健全性、テストの質（時間に依存する不安定さを含む。`isolated-interaction.test.ts` を少なくとも2回続けて実行してください）。
- 対象ファイル: R1 と同じ（`src/interaction/*`、`src/safety/interaction-policy.ts`、`passive-request-guard.ts`、`safety-ledger.ts`、`src/browser/context-factory.ts`、`src/evidence/interaction-collector.ts` と、そのテスト）
