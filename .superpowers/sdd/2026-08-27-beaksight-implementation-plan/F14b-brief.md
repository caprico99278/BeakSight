# F14b 指示書: 残りの失敗の理由からも、制御文字と Call log を取り除く

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: F14b
- 目的: F14 では、click の失敗の理由だけを `clickFailureReason` で整えた。ほかの2か所の理由にも、Playwright のエラーの ANSI の制御文字と `Call log:` 以降がそのまま入りうる。この2か所も同じように整える。
- 背景: F14 の実装報告の発見事項1。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/interaction/isolated-auditor.ts`
- テスト: `tests/integration/isolated-interaction.test.ts`

## 修正する内容

- 下準備のスクロールの失敗（`SCROLL_PREPARATION_FAILED_REASON_PREFIX` に `errorMessage(error)` を付ける箇所）と、`auditInteraction` の包括的な catch（`errorMessage(error)` で EXECUTION_FAILED にする箇所）の2か所で、理由を作るときに、F14 の関数と同じ処理を使う。
- 処理を2か所に写さず、1つの関数を使う。関数の名前が click に限った意味に見える場合は、用途に合う名前に変える。
- 変えるのは、理由の文字列の中身だけにする。状態（NOT_VERIFIABLE、EXECUTION_FAILED）は変えない。

## 受け入れ条件

- 2か所それぞれで、ANSI の制御文字と `Call log:` を含むエラーが、整った理由になることを確かめるテストを加える。修正前に RED、修正後に GREEN になること。
- `tests/integration/isolated-interaction.test.ts` のすべてのテストが PASS する。
- `npm run typecheck` が PASS する。

## 報告

共通ルールの形式で報告してください。
