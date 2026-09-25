# BeakSight Task 19 実装計画: fixture の全体の監査と README

作成日: 2026-09-25
設計書: `doc/design/2026-09-25-beaksight-task-19-fixture-full-crawl-readme-design.md`

## 1. 目的

設計書の第4章と第5章を、実装者1人が1回の起動で終えられる大きさのサブタスクに分けて行う。

## 2. サブタスクの分け方と順序

| ID | 内容 | 主に変えるファイル | 前提 |
| --- | --- | --- | --- |
| T19a | 専用の fixture のサイトと、本物の CLI での全体の監査の結合テスト（設計書 第4章） | `fixtures/site/full-crawl/*`（新規）、`tests/integration/fixture-full-crawl.test.ts`（新規）、共有に移す場合は `tests/helpers/` と `tests/integration/cli.test.ts` | C18p（Task 19 の前の整理の完了） |
| T19b | README の書き直し（設計書 第5章） | `README.md` | T19a（検証の手順と、実際の出力の構成を README に書くため） |
| RT19 | README の独立の確認（実装と食い違わないか。読み取り専用） | なし | T19b |

- T19a の後に、設計者が `npm run verify` と、全体の監査のテストを実行し、結果を記録する。
- T19a で不具合が見つかった場合は、不具合台帳に登録し、別のサブタスクで直してから T19b に進む。

## 3. 共通の受け入れ条件

- TDD で進める（T19a は、期待した Finding の確かめを先に書き、fixture を足して GREEN にする）。
- すべての Gate（S、A、ARCH、UI）が PASS する。
- テストでは、Chromium を headless だけで起動する。CLI には `--headless` を付ける。
- 実在の外部のサイトにアクセスしない。
- `npm run verify` が PASS する。

## 4. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | 初版 | - | Task 19 |
