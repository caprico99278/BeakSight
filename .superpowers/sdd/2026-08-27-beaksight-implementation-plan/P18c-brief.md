# P18c 指示書: DEF-008 の Page Auditor と Interaction の呼び出し元

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: P18c
- 目的: Page Auditor と Interaction の、Context と page の作成・終了に、期限を付ける。P18a で作った部品を使う。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md` の第4章（とくに 4.2〜4.4）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-implementation-plan.md` の P18c
- 前の報告: 作業記録置き場の `P18a-report.md`（作った部品のシグネチャと振る舞い）
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-008
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、P18d（Run Coordinator と CLI。`src/orchestration/run-coordinator.ts`、`src/cli/`、理由のコードの一覧とスキーマ、`messages.ts`）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - 型のエラーが P18d の作業中のファイルから出ている場合は、自分のファイルのエラーでないことを確かめてください。そのうえで、報告に書いてください。

## 変更してよいファイル

- `src/orchestration/page-auditor.ts`
- `src/interaction/isolated-auditor.ts`
- `src/evidence/layout-collector.ts`（幅の走査の session の `close()` に限る）
- `src/orchestration/passive-session-open.ts`、`src/orchestration/passive-session-close.ts`（P18a の部品に、足りない機能を加えることに限る。既存の振る舞いは変えない）
- テスト:
  - `tests/integration/page-auditor.test.ts`
  - `tests/integration/isolated-interaction.test.ts`
  - Page Auditor と Interaction の既存の単体テスト
  - P18a の部品のテスト（部品を加えた場合に限る）

次のファイルは、変更しません。

- `src/safety/**`、`src/browser/context-factory.ts`（Guard と factory の振る舞いは変えない）
- `src/orchestration/run-coordinator.ts`、`src/cli/`、`src/core/contracts.ts`、スキーマ、`messages.ts`（P18d が変える）

新しい理由のコードが必要になった場合は、止まって報告してください。既存の理由のコード（`COLLECTOR_INCOMPLETE`、`DEADLINE_EXCEEDED`、閉じる処理の失敗など）で表せるかを、先に確かめてください。

## 作るもの

1. **Page Auditor**（設計書 4.4 の表）
   - ビューポートごとの Context と page の作成を、P18a の部品を使う形にする。
     - 期限は、`SESSION_OPEN_TIMEOUT_MS` とページの期限のうち、短い方にする。
   - Context の終了（`finally` と、`ContextConstructionError` のとき）を、期限付きにする。
   - 期限を過ぎたときの扱い:
     - 作成の期限切れ: ビューポートの失敗とし、今の段階の失敗と同じ理由（`COLLECTOR_INCOMPLETE` か `DEADLINE_EXCEEDED`）を付ける。
     - 終了の期限切れ: 閉じる処理の失敗として記録する。
2. **Interaction**（設計書 4.4 の表）
   - `createInteractionSession` を、期限付きで待つ。
     - 期限は、Interaction の候補の予算の中にする。
     - 期限を過ぎた後に届いた session は、閉じる。
     - `isolated-auditor.ts` の既存の部品（`awaitInteractionBrowserWork`、`releaseLateValue` など）を使える場合は、使う。同じ意味の処理を、新しく書かない。
   - 期限を過ぎた場合は、その候補の結果を `NOT_VERIFIABLE`（`CHECK_NOT_COMPLETED`）とする。
   - 凍結の失敗の後の無効化（`activateInteractionFreeze` の `failClosed`）を待つ処理にも、呼び出す側で期限を付ける。
     - 期限を過ぎた場合も、今の失敗の扱い（違反の記録を含む）は変えない。待つのをやめるだけである。
3. **幅の走査の session の `close()`**（`layout-collector.ts`）
   - P18a で、`stress-session.ts` の session の `close()` が期限を守る形になっている。その場合は、`layout-collector.ts` の変更は不要である。
   - 必要かどうかを確かめて、報告する。
   - P18a で、`createStressSessionFactory(factory, { deadlines?, notAfterMs? })` に `notAfterMs` が加わった。Page Auditor から、ページの期限を `notAfterMs` として渡す。
4. **期限の注入と、実時間を待つテスト**（R15r-4。P18a の報告の発見事項1）
   - Page Auditor の期限（page と Context の終了、作成）を、注入できる形にする。既定値は、`limits.ts` の定数のままにする。
   - `tests/integration/page-auditor.test.ts:623` 付近の DEF-006 のテスト（page の終了の5秒を実際に待つもの）を、短い期限を注入する形に直す。
     - テストの結果の条件は、弱めない。
     - 直す前と後の、そのテストの実行時間を、報告に書く。

## テスト

- 作成と終了が終わらない偽の factory・Context・session を使う。次のことを確かめる。
  - ページの監査が、期限の中で終わる。
  - 設計書 4.4 の表の理由が付く。
  - Run が止まり続けない。
- Interaction の session の作成が終わらない場合:
  - 候補の結果が `CHECK_NOT_COMPLETED` になる。
  - 遅れて届いた session が閉じられる。
- `failClosed` が終わらない場合: 待つのをやめる。違反の記録は、今までと同じである。
- どのテストも、実際の時間を待たない。短い期限を注入する。
- 既存の Page Auditor と Interaction のテストが、変更なしで PASS する。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。
- Guard と factory のファイルを、変えていない。
- 担当のテストと、`npm run typecheck`（自分のファイルについて）が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。期限を付けた箇所の一覧（ファイル:行、期限の値、期限を過ぎたときの扱い）を書いてください。Guard の独立レビュー（RP18）で使います。
