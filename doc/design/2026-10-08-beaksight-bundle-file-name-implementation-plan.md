# BeakSight ChatGPT 用バンドルのファイル名に日時を加える 実装計画

- 設計書: `2026-10-08-beaksight-bundle-file-name-design.md`

## 全体の制約

- Git の commit・push と、HEAD に戻す操作は禁止。報告は日本語。依存を変えない。実サイトにアクセスしない。

## サブタスク一覧

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| BN1 | 名前の関数と見分ける関数（`artifact-layout.ts`）、UTC の 14 桁の書式の共用、`writePresentation` の新しい名前と古いバンドルの片付け、CLI の結果の行、README、テスト | なし | 完了（2026-10-08） |

## BN1

**変更するファイル**
- 変更: `src/core/artifact-layout.ts`、core の日時の書式の置き場（新設か既存）、`src/orchestration/run-id.ts`、`src/report/artifact-writer.ts`、`src/cli/run-command.ts`（必要なら）、`src/cli/output.ts`、`README.md`
- テスト: `tests/unit/artifact-layout.test.ts`、`tests/unit/artifact-writer.test.ts`、`tests/unit/cli.test.ts`、Run の ID のテスト、バンドルの名前を使う結合テスト（`tests/integration/cli.test.ts`、`fixture-full-crawl.test.ts`、`safety-gates.test.ts` など）

**受け入れ条件**: 設計書 4 のテストが RED から GREEN になる。Run の ID の振る舞いは変わらない。関連する検証、Architecture Gates、型チェックが PASS する。
