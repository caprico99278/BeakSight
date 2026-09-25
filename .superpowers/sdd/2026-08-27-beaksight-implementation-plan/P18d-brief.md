# P18d 指示書: Run のディレクトリの排他的な作成（DEF-009）と、例外の経路の実行時間の超過（R15r-3）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: P18d
- 目的: Run Coordinator の開始と終わりの2つの問題を直す。あわせて、R17r の Minor-1・2 を直す。
  - 同じ秒に始めた2つの Run が、同じディレクトリに書く（DEF-009）。
  - 例外でクロールが止まった経路では、実行時間の超過が記録されない（R15r-3）。
- 設計書:
  - `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md` の第6章と第7章
  - Task 14〜17 の設計書 `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 5.6.3、5.6.7、第7章
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-implementation-plan.md` の P18d
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-009
- レビューの結果: 作業記録置き場の `R15r-review-result.md`（Minor-3）、`R17r-review-result.md`（Minor-1・2）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、P18c（Page Auditor と Interaction の期限。`src/orchestration/page-auditor.ts`、`src/interaction/**`、`src/evidence/layout-collector.ts`）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - 型のエラーが P18c の作業中のファイルから出ている場合は、自分のファイルのエラーでないことを確かめてください。そのうえで、報告に書いてください。

## 変更してよいファイル

- `src/orchestration/run-coordinator.ts`
- `src/core/artifact-layout.ts`（Run のディレクトリを排他的に作る部品を置く場合に限る）
- 新しい理由のコードが必要な場合に限り、次のファイル
  - `src/core/contracts.ts`（理由のコードの一覧）
  - `schemas/run.schema.json` と `schemas/page.schema.json`（理由のコードの enum）
  - `src/presentation/messages.ts`（理由の説明、CLI の文言）
- `src/cli/`（Run のディレクトリを作れなかった場合の表示と終了コード、R17r の Minor-1・2）
- テスト:
  - `tests/unit/run-coordinator.test.ts`
  - `tests/integration/crawl-run.test.ts` など、Run Coordinator の既存の統合テスト
  - `tests/unit/cli.test.ts`、`tests/unit/run-command.test.ts`、`tests/integration/cli.test.ts`
  - `tests/unit/artifact-layout.test.ts`
  - 理由のコードの一覧と、スキーマの一致を確かめる既存のテスト（`tests/unit/schema-enum-consistency.test.ts` など）

## 直すもの

1. **DEF-009 Run のディレクトリの排他的な作成**（設計書 第6章）
   - Run Coordinator は、Run の開始の時点で、Run のディレクトリを排他的に作る。
     - 時点は、PREFLIGHT の前で、対象のサイトにアクセスする前である。
     - 親のディレクトリ（出力先）は、`recursive` で作ってよい。
     - Run のディレクトリそのものは、`recursive` なしで作る。すでにあれば、失敗させる（`EEXIST`）。
   - 作れなかった場合:
     - 対象のサイトにアクセスせずに、Run を終える。Browser も起動しない。
     - Run Status は、`FAILED` とする。
     - 理由のコードと detail を付ける。
       - 既存の理由のコードで、この失敗を正しく表せない場合は、新しいコード（例: `RUN_DIRECTORY_UNAVAILABLE`）を加える。
       - 加える場合は、次のものも合わせて直す。
         - contracts の一覧
         - スキーマの enum
         - `messages.ts` の説明
         - UI05 の対象（カタログや説明の書き漏れの検査が、自動で対象にする場合は、そのままでよい）
   - Run のディレクトリを作れなかった Run の artifact は、書かない。書く場所が、別の Run のディレクトリだからである。
     - CLI は、日本語の文言（`messages.ts`）で、Run のディレクトリを作れなかったことと、そのパスを示し、終了コード 1 で終える。
     - この経路を、`ArtifactWriter` を呼ばずに終える形にする。
     - 形の選び方の例:
       - Run Coordinator が、専用の結果の形を返す。
       - 専用の例外を投げる。
     - どちらにするかは、実装者が決めて報告する。どちらにする場合も、CLI の終了コードは、終了コードの表（`exit-codes.ts`）から取る。
   - テスト:
     - 同じ `runId` の2つの Run で、2つ目が、対象のサイトにアクセスせず、Browser も起動しないことを確かめる。
       - 時計を注入できれば、それを使う。
     - 2つ目の Run が、`FAILED` になり、1つ目の Run のディレクトリの中身を変えないことを確かめる。
     - CLI で、同じ場合に、日本語の文言と終了コード 1 になることを確かめる。
2. **R15r-3 例外の経路の実行時間の超過**（設計書 第7章）
   - 例外でクロールが止まった経路でも、実行時間の上限を過ぎていた場合は、`crawlLimits.maxRuntimeReached` を真にする。
   - 記録の規則は、設計書 5.6.3 と同じにする。監査していない URL が残らない場合は、理由を付けない。
   - Run Status の決め方は、変えない。
   - テスト: 時計を注入して、例外で止まった経路で、上限を過ぎていれば記録されることを確かめる。
3. **R17r の Minor-1**
   - `src/cli/index.ts` の後始末のコメントを、実装に合わせて直す。
   - 直す内容は、「扱われない失敗では、Run Coordinator の `finally` の終わりを待たない。Chromium の終了は、Playwright がプロセスの終了時に行う処理に任せる」である（設計書 第7章）。
4. **期限の注入と、実時間を待つテスト**（R15r-4。P18a の報告の発見事項1）
   - Run Coordinator が Browser を閉じる期限（`BROWSER_CLOSE_TIMEOUT_MS`）を、注入できる形にする。
     - 既定値は、定数のままにする。
     - P18a で、`closeBrowserBeforeDeadline(browser, { timeoutMs? })` が期限を受け取れる形になっている。
   - `tests/unit/run-coordinator.test.ts:1020` 付近の Browser の終了のテスト（10秒を実際に待つもの）を、短い期限を注入する形に直す。
     - テストの結果の条件は、弱めない。
     - 直す前と後の、そのテストの実行時間を、報告に書く。
5. **R17r の Minor-2**
   - 本番の `run` が `finishAuditRun` を通ることを、固定するテストを加える。
     - 例: `runAuditCommand` の中の終了コードの計算と書き出しが、`finishAuditRun` だけにあることを確かめる。
     - 方法は、Run Coordinator を差し替えられる口を使うか、構造の検査にするかを、実装者が選んで報告する。

## 受け入れ条件

- 各修正のテストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。
- 担当のテストと、`npm run typecheck`（自分のファイルについて）が PASS する。
- UI Gate のファイルが、1秒以内に終わる。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。
