# BeakSight Task 31 承認された UPDATE と前後の差分の照合 実装計画

作成日: 2026-10-13
設計書: `2026-10-13-beaksight-task-31-approved-update-design.md`（ユーザー承認済み 2026-10-13）

## 進め方

- 実装者は Opus で起動し、TDD（RED → 最小の実装 → GREEN）で進める。報告は日本語。
- 安全の中心（T31c・T31g）は、RED と GREEN を両方の Chromium（テストの既定と CLI の起動の設定）で確かめる。競争のある安全のテストは、回ごとにサーバに届かないこと、全部の回の後に名前つきの時間だけ待ってもう一度数える、止めた証拠が 1 回以上ある、の組み合わせにする。
- 検証は、実装者は関係するテストだけ。`verify:ui`・`verify:all` は実装者に求めない。`verify:all` は T31R の承認の後に 1 回だけ設計者が流す。
- Task 30 の残り（T30f〜T30R）と並行する。同じファイルに触れるサブタスクは同時に動かさない。管理データの版 9 は G30 の後（版 8 が公開になってから写しを固定する）。

## サブタスク

| ID | 内容 | 主に変えるファイル | 依存 | 並行 |
| --- | --- | --- | --- | --- |
| T31a | 語の一覧: 状態の欄の語の追加、無効化の語の閉じた一覧（選択肢の値と文言の除外。CREATE の生成にも効く） | `src/discovery/classification-words.ts`、`src/control/data-rules/`（選択肢の除外） | — | T30f・T31b と並行 |
| T31b | 契約: UPDATE の指定（台帳の参照、path の型 2 つ、欄の役割）、下書きの確かめ、型にした識別の digest、承認の有効性、承認の digest の版 3、理由の閉じた一覧、スキーマ | `src/control/approval/`、`src/discovery/fingerprint.ts`、`schemas/control/scenario.schema.json` | T30d | T30f・T31a と並行 |
| T31c | 照合の拡張: 保つ欄の値、状態の名前の hidden の値、同じ名前の hidden と checkbox の組（値を照らす passthrough の一般化）と Gate | `src/safety/write-payload-policy.ts`、`passive-request-guard.ts`（型） | T30f | — |
| T31d | UPDATE の値の生成（変える欄だけ。履歴と重ならない、メールと電話は既定で保つ） | `src/control/data-rules/` | T31a・T31b | — |
| T31e | 版 9（版 8 の写しの固定を先に）: ジョブの種類 `WRITE_UPDATE`、UPDATE の結果（対象の ID、変えた欄の前と新しい値、後の照合）、対象の ID と許可・予約の結び付け、発行の中の自動の選択（`TARGET_SELECTION_CHANGED`） | `src/control/store/migrations.ts`、`src/control/approval/scenario-store.ts`、`src/control/actions/` | G30、T31b | — |
| T31f | ジョブの管理と IPC（`START` の UPDATE の指定） | `src/control/job/`、`src/control/worker-protocol.ts` | T31e | — |
| T31g | ワーカーの流れ（前の読み取り → 確かめ直し → 入力 → 送信 → 判定（ID の一致） → 後の読み取り → READ → `action-run.json`）と、入力の部品の前と後の値の読み取り | `src/worker/`、`src/browser/write-form-submitter.ts` | T31c・T31f | — |
| T31h | 画面（UPDATE の指定の入力、開始の予定のレコード、前後の差分） | `apps/local-ui/`、`src/presentation/` | T31g、T30g | — |
| T31i | 永続化する fixture（`lock_version`、状態の欄、Rails 型の checkbox、`_method`、副作用）、目印の検査、回帰、手順書 | `fixtures/`、`tests/`、`apps/local-ui/tests/`、`doc/spec/` | T31h | — |
| T31R | 独立レビュー | — | T31i | — |
