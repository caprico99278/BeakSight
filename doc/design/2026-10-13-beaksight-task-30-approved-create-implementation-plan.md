# BeakSight Task 30 承認された CREATE と登録結果の照合 実装計画

作成日: 2026-10-13
設計書: `2026-10-13-beaksight-task-30-approved-create-design.md`（ユーザー承認済み 2026-10-13）

## 進め方

- 実装者は Opus で起動し、TDD（RED → 最小の実装 → GREEN）で進める。報告は日本語。
- 安全の中心（T30b・T30f）は、RED と GREEN を両方の Chromium（テストの既定と CLI の起動の設定）で確かめる。競争のある安全のテストは、回ごとにサーバに届かないこと、全部の回の後に名前つきの時間だけ待ってもう一度数える、止めた証拠が 1 回以上ある、の組み合わせにする。
- 検証は、実装者は関係するテストだけ。`verify:ui`・`verify:all` は実装者に求めない。`verify:all` は T30R の承認の後に 1 回だけ設計者が流す。
- Task 29 の T29d〜T29f と並行するので、`src/control/approval/`・`src/control/data-rules/`・`src/control/store/migrations.ts` に触れるサブタスク（T30a・T30d 以降）は、Task 29 の該当の作業の後に始める。

## サブタスク

| ID | 内容 | 主に変えるファイル | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| T30b | 書き込みの段の Guard（承認の要求の形の POST 1 回、送信の窓、許可 Origin の外、307・308 の再 POST）、送る中身の照合の純粋な関数、factory の入口、中継の方針、Gate（`APIRequestContext` の禁止） | `src/safety/`、`src/browser/context-factory.ts`、`tests/` | — | Task 29 と並行 |
| T30c | フォームの入力の owner（`write-form-submitter.ts`。fill・selectOption・check、送る前の確かめ）と Gate（入力の操作の owner） | `src/browser/`、`tests/architecture/` | T30b | — |
| T30a | 契約（`ActionRun`・結果のコード・シナリオの検証の指定・承認の digest の項目の追加）とスキーマ | `src/control/approval/`、`src/control/actions/`（新）、`schemas/` | G29 の T29d | — |
| T30d | 版 8（版 7 の固定を先に）、書き込みの結果の記録、予約の締めと回復、連続の上限（5 分・24 時間に 5 件）と検証の指定と環境の証跡の確かめ | `src/control/store/migrations.ts`、`src/control/approval/scenario-store.ts`、`src/control/actions/` | T30a、T29d | — |
| T30e | ジョブの管理（`WRITE_CREATE`）と IPC（送る直前の確かめ直しの往復、送信の報告、撤回の STOP） | `src/control/job/`、`src/control/worker-protocol.ts`、`src/worker/` | T30d | — |
| T30f | ワーカーの流れ（画面の確かめ → 確かめ直し → 入力 → 送信 → 判定 → ID → READ の照合 → `action-run.json`） | `src/worker/`、`src/report/` | T30b・T30c・T30e、Task 29 の生成 | — |
| T30g | 画面（開始、結果、`UNKNOWN` の表示、検証の指定の入力） | `apps/local-ui/`、`src/presentation/` | T30f、T29e | — |
| T30h | 永続化する fixture、目印の検査、回帰、手順書 | `fixtures/`、`tests/`、`apps/local-ui/tests/`、`doc/spec/` | T30g | — |
| T30R | 独立レビュー | — | T30h | — |
