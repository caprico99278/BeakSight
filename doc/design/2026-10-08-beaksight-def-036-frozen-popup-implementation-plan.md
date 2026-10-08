# BeakSight DEF-036 凍結中のポップアップ 実装計画

- 設計書: `2026-10-08-beaksight-def-036-frozen-popup-design.md`

## サブタスク一覧

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| DEF-036-fix | 凍結中のポップアップを閉じない（記録だけ）。POST と GET の RED のテスト（くり返し）、fixture、既存のテストの直し | なし | 完了（2026-10-08。round-1、round-2 を含む） |
| DEF-036-gate | GATE-S04 に POST の場面を加える（`safety-gates.test.ts`。BN1 と同じファイルなので、BN1 の後） | DEF-036-fix、BN1 | 完了（2026-10-08） |
| DEF-036R | 独立レビュー（読み取り専用） | DEF-036-gate | 完了（2026-10-08。DEF-038〜040 の指摘を経て、NPR3 で承認） |
