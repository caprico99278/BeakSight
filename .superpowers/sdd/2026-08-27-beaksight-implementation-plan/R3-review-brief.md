# R3 指示書: Task 1〜5 と型・スキーマの再レビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `R-review-common.md` を読んでください。そこに書かれている厳守事項・背景・報告の形式に従ってください。

今回の担当は **Task 1〜5 の修正と、型・スキーマの整備の再レビュー** です。

- 対象: 前回のレビュー（`task-01-05-review-2026-09-23.md`）の指摘 R1〜R9 が解消されたかを確かめてください。あわせて、F01〜F05、C1、C2（Safety Ledger と Run Status の部分）、C8、DEF-001b で作られた共通部品と、型・スキーマを確かめてください。
- 主な観点:
  - SSOT（第二のownerがないこと、型の定義が1か所であること、共通部品が使われていること）
  - Target Isolation
  - Completion Semantics（`deriveRunStatus()` の入力と判定）
  - 型とスキーマの一致（`src/core/contracts.ts`、`src/core/evidence-types.ts`、`schemas/*.json`、`validateArtifact()`）
  - 後続の Task 12〜16 がこれらの型を使うときに、足りないものや矛盾がないか
- 主なファイル: `src/config/*`、`src/core/*`、`src/crawl/*`、`src/safety/request-policy.ts`、`src/safety/redact.ts`、`src/safety/safety-ledger.ts`、`schemas/*.json`、`fixtures/server.ts`、`tests/helpers/*`、対応するテスト
