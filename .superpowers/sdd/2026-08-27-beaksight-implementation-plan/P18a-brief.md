# P18a 指示書: DEF-008 の部品と、Interaction 以外の呼び出し元（期限の注入を含む）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: P18a
- 目的: Context と page の作成・終了に期限を付ける部品を作り、PREFLIGHT、環境、サイトの metadata、幅の走査で使う。期限は、注入できるようにする。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md` の第4章（とくに 4.2〜4.4）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-implementation-plan.md` の P18a
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-008（と、参考の DEF-005、DEF-006）
- 前の報告: 作業記録置き場の `C15x-report.md`（DEF-006 の部品）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、P18b（Safety の型。`src/core/contracts.ts` と `src/safety/safety-ledger.ts`）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - 型のエラーが P18b の作業中のファイルから出ている場合は、自分のファイルのエラーでないことを確かめてください。そのうえで、報告に書いてください。

## 変更してよいファイル

- `src/core/limits.ts`（期限の定数を加えることに限る）
- `src/orchestration/passive-session-close.ts`
- 新規: `src/orchestration/passive-session-open.ts`（名前は変えてよい。報告する）
- `src/orchestration/preflight.ts`、`src/orchestration/environment.ts`、`src/orchestration/stress-session.ts`
- `src/crawl/site-metadata.ts`
- テスト:
  - 上の各ファイルに対応する、既存の単体テストと統合テスト
  - 新規の部品のテスト
  - DEF-006 の期限のテスト（実際の時間を待つもの。短い期限を注入する形に直すことに限る）

次のファイルは、変更しません。

- `src/safety/**`、`src/browser/context-factory.ts`（Guard と factory の振る舞いは変えない）
- `src/orchestration/page-auditor.ts`、`src/interaction/**`、`src/evidence/layout-collector.ts`（P18c で行う）
- `src/orchestration/run-coordinator.ts`（P18d で行う）

これらの変更が必要になった場合は、止まって Blocker として報告してください。

## 作るもの

1. **期限の定数**（設計書 4.2）
   - `src/core/limits.ts` に、次の2つを置く。
     - `CONTEXT_CLOSE_TIMEOUT_MS = 5_000`
     - `SESSION_OPEN_TIMEOUT_MS = 10_000`
2. **部品**（設計書 4.3）
   - `closePassiveContextBeforeDeadline(factory, context, options?)`
     - Context を期限付きで閉じる。
     - 失敗と期限切れを、今の `PassiveSessionCloseFailure` と同じ形で返す。
     - `closePassivePageAndContext` は、これを使う形にする。
   - `openPassiveSessionBeforeDeadline(factory, viewport, deadlineAtMs, options?)`
     - Context と page を、期限付きで作る。
     - 結果は、次の3つを区別できる形にする。
       1. 成功
       2. 今の失敗（`ContextConstructionError` など）
       3. 期限切れ
     - 期限切れの後に Context が届いた場合は、その Context を `closePassiveContextBeforeDeadline` で閉じる。その結果は、呼び出し元が渡した記録の口に渡すか、捨てる。どちらにするかは、実装者が決めて報告する。
     - Context は作れたが、page の作成が期限を過ぎた場合は、その Context を閉じる。
   - 期限は、`deadline.ts` の `awaitBeforeDeadline` を使って待つ。同じ意味の処理を、新しく書かない。
   - 期限の値は、省略できる引数か、依存として注入できる形にする。既定値は、`limits.ts` の定数とする。
3. **呼び出し元**（設計書 4.4）
   - 次の4つの呼び出し元の Context と page の作成と終了を、部品を使う形にする。
     - PREFLIGHT（`preflight.ts`）
     - 環境の読み取り（`environment.ts`）
     - サイトの metadata（`site-metadata.ts`）
     - 幅の走査の session（`stress-session.ts`）
       - `layout-collector.ts` の `session.close()` は変えない（P18c で行う）。
       - `stress-session.ts` が返す session の `close()` の中で、期限を守る形にする。
   - 期限を過ぎたときの扱いは、設計書 4.4 の表のとおりにする。今の失敗の扱いは変えずに、「期限を過ぎた」という新しい失敗の形だけを加える。
   - 期限を過ぎた後も、呼び出し元が戻ること。
4. **期限の注入**（R15r-4）
   - DEF-006 のテスト（page の終了の5秒、Browser の終了の10秒を実際に待つもの）を、短い期限を注入する形に直す。
     - `closePassivePageBeforeDeadline` と `closeBrowserBeforeDeadline` に、期限を注入できる形を加える。既定値は、今の定数のままにする。
   - テストの結果の条件は、弱めない。
   - 報告に、直す前と後の、そのテストの実行時間を書く。

## テスト

- 部品:
  - 閉じる処理と作る処理が終わらない偽の factory・Context で、期限の中で期限切れが返る。
  - 期限切れの後に届いた Context が、閉じられる。
  - page の作成が期限を過ぎた場合に、Context が閉じられる。
  - 今の失敗（`ContextConstructionError` など）の扱いが、変わらない。
- 呼び出し元: 各呼び出し元で、作成か終了が終わらない場合に、期限の中で戻り、設計書 4.4 の表の扱いになる。
- どのテストも、実際の時間を待たない。短い期限を注入する。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。
- Guard と factory のファイルを、変えていない。
- 担当のテストと、`npm run typecheck`（自分のファイルについて）が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。P18c の実装者が使うので、作った部品のシグネチャと振る舞いを一覧にしてください。
