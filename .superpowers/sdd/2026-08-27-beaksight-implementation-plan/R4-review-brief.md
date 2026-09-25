# R4 指示書: Task 6〜10 の再レビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

今回の担当は **Task 6〜10 の修正の再レビュー** です。

- 対象: 前回のレビュー（`task-06-10-review-2026-09-23.md`）の指摘 V1〜V14 が解消されたかを確かめてください。あわせて、C4、C4b、C5、C5b、C6、C7、DEF-001、F02a で、新たな問題が入っていないかを確かめてください。
- 主な観点:
  - 偽の COMPLETE がないこと
  - 観測できなかった値を 0 にしていないこと
  - 敵対的なページで上限が守られ、切り捨てが記録されること
  - 可視判定が統一されていること（`src/core/visibility.ts`、`checkVisibility`）
  - 収集時のスクロール位置の契約
  - Evidence before Finding
  - Guard の付いた Context で安全違反が起きないこと（DEF-001）
- 主なファイル: `src/browser/*`（controlled-scroll、page-settling、page-failure）、`src/evidence/*`、対応するテストと fixture
- 実地の検証は、ローカルの `setContent` と `127.0.0.1` のサーバだけで行ってください。
