# BeakSight 中断した Run の再開 実装計画

設計書: `doc/design/2026-10-01-beaksight-resumable-run-design.md`
目標: ページごとの保存、端末の再起動にも耐えるロックと保存の書き方、自動の再開、Ctrl+C の扱い、実行の記録を作り、中断した Run を途中から続けられるようにする。
作業記録置き場: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`
前提: 負荷の制御の実装計画（`2026-10-01-beaksight-site-load-control-implementation-plan.md`）の L1〜L6 と同じ作業ツリーで進める。`run-coordinator.ts` と `src/cli/` に触れるサブタスクは、L の側の該当のサブタスクの後に行う。

## 全体の制約

- 実装者は Git の commit・push をしない。HEAD に戻す操作（checkout、restore、reset、stash、switch など）も禁止。表示だけの `git status`・`git diff`・`git log`・`git blame`・`git show` は使ってよい。
- 依存パッケージの追加・更新をしない。実在の外部のサイト（本来の監査対象のサイトを含む）にアクセスしない。`local/` と `artifacts/` の中を読まない。検証はローカルの fixture で行う。
- `src/**` は target に依存しない形に保つ。
- テストの Chromium は headless だけで起動する。
- ファイルを書く処理は `src/report/artifact-writer.ts` だけに置く（ARCH08。例外を増やさない）。
- テストを削除・弱体化・skip にしない。
- 共通部品台帳の部品と同じ意味の処理を、新しく書かない。

## サブタスク一覧

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| R1 | frontier・待ち行列・採番器の、状態の取り出しと作り直し | なし | 完了（2026-10-02 までに。fix-round を含む） |
| R2 | 保存の形式（`checkpoint.schema.json`、`checkpoint-page.schema.json`、スキーマの名前 `checkpoint`、`checkpoint-page`）と `run-checkpoint.ts`（保存の内容の作成と読み込み、ロックの判定。ファイルは書かない） | R1、L4 | 完了（2026-10-02 までに。fix-round を含む） |
| R3 | `ArtifactWriter` の保存の書き出し（`fsync`、`state.prev.json`）、ロックの作成・更新・削除、再開のときの後始末、最後の書き出しで残った古いファイルを消すこと | R2 | 完了（2026-10-02 までに。fix-round を含む） |
| R4a | 保存のセッション（`run-checkpoint-session.ts`。ロック、ハートビート、保存、最後の状態の書き出し）と、Run Coordinator の保存の時期（新しい Run） | R3、L7 | 完了（2026-10-02 までに。fix-round を含む） |
| R4a2a | 保存のセッションの再開の始め方（古いロックの判定と作り直し、読み直し、後始末）。ArtifactWriter のロックを読む関数 | R4a | 完了（2026-10-02 までに。fix-round を含む） |
| R4a2b | Run Coordinator の保存からの作り直しと続き（最後の処理だけの再開、違反の確かめ直しを含む）。「中断しなかった場合と同じ」の結合テスト | R4a2a | 完了（2026-10-02 までに。fix-round を含む） |
| R4b1 | 理由のコード `RUN_INTERRUPTED`、保存の時刻 `savedAt`、実行の記録の整合、保存の終わり方と実行の終わり方の判定の関数（`run-checkpoint.ts`）、再開のときに前の回の実行の記録を閉じること | R4a2b | 完了（2026-10-02 までに。fix-round を含む） |
| R4b2 | Run Coordinator の止める印、保存の終わり方（`checkpointConclusion()`）、最後の状態の中身、`run.json` の `executions`、1回の実行ごとの時間の上限の確かめ | R4b1 | 完了（2026-10-02 までに。fix-round を含む） |
| R5a | CLI の再開の流れ: 出力先の実行中の Run の確かめ、途中の Run を探して選ぶ（`state.json` だけで絞り込む）、`--new`、版の確かめ（BeakSight と Playwright）、知らせの文言、保存のセッションを作って渡すこと、Run の後の `finish`・`abandon`、終了コード 4 の結果 `RUN_UNAVAILABLE`、Browser の起動で Playwright のシグナルの処理を止めること | R4b2、L6 | 完了（2026-10-02 までに。fix-round を含む） |
| R5b | シグナル（1回目は止める印、2回目はすぐに終える）、終了コード 5（`INTERRUPTED`）、README（再開、`--new`、Ctrl+C、終了コード、`maxRuntimeMs` の意味、同じ出力先で同時に1つ、タスク スケジューラの例、進み具合の行の数え方） | R5a | 完了（2026-10-02 までに。fix-round を含む） |
| R6 | 実行の記録の表示（表示用モデル、HTML、CLI、`summary.json`） | R5b | 完了（2026-10-02 までに。fix-round を含む） |
| RR | 独立レビュー（読み取り専用） | R6 | 未着手 |

R1 は、L のサブタスクとファイルが重ならないので、L2〜L4 と並行で行ってよい。

## R1: 状態の取り出しと作り直し

**変更するファイル**
- 変更: `src/crawl/crawl-queue.ts`、`src/orchestration/crawl-frontier.ts`、`src/orchestration/id-allocator.ts`
- テスト: `tests/unit/crawl-queue.test.ts`、`tests/unit/id-allocator.test.ts`、frontier の単体テスト（既存の置き場所に合わせる。なければ `tests/unit/crawl-frontier.test.ts` を新規）

**手順**
1. RED: 取り出した状態（JSON にできる値）から作り直したものが、元と同じ振る舞いをする（次の `next()` の URL、`discover` の結果、採番する ID）。作り直すときに、指定した理由の SKIPPED と `AUDITING` が `QUEUED` に戻り、待ち行列の先頭に元の発見の順で並ぶ。採番器は、作り直した連番から続ける。不正な状態（連番が負、記録とキューの食い違い、閉じた一覧にない状態）を拒む。
2. 最小実装 → GREEN。
3. 関連する検証: `tests/unit/run-coordinator.test.ts`、`tests/integration/crawl-run.test.ts`。

**守ること**
- 使っている採番器の連番を戻す口は作らない。作り直しは、新しいインスタンスを作るときだけ。
- 待ち行列の FIFO と重複の排除は `CrawlQueue` が持ち続ける。frontier に重複の排除を書かない。

## R2: 保存の形式と `run-checkpoint.ts`

**変更するファイル**
- 新規: `schemas/checkpoint.schema.json`（ページの結果は `page.schema.json` の定義を `$ref`。実効の設定は `run.schema.json` の定義を `$ref` で使う。必要なら、参照できるように `run.schema.json` の `$defs` に移す）
- 変更: `src/core/schema-validator.ts`（名前 `checkpoint`）
- 新規: `src/orchestration/run-checkpoint.ts`（Run の状態から保存の内容を作る。保存の内容を検証して、再開の状態を作る。3.2 の再開できるかの判定。4.4 のロックの判定（時刻、OS の起動の時刻、プロセスが動いているかを注入する））
- テスト: `tests/unit/run-checkpoint.test.ts`（新規）、`tests/unit/schema-validator.test.ts`

**手順**
1. RED: 保存の内容の作成と読み込みの往復。壊れた内容を拒む。3.2 の表のそれぞれの判定。ロックの判定の3つの条件（OS の起動の時刻の誤差 120秒、プロセスが動いている、ハートビートが5分以内）のそれぞれで「古い」と判定される場合。
2. 最小実装 → GREEN。

## R3: `ArtifactWriter` の保存、ロック、後始末

**変更するファイル**
- 変更: `src/report/artifact-writer.ts`（保存の書き出し: 一時ファイル → `fsync` → `state.json` を `state.prev.json` に → 名前を変える → 可能ならディレクトリの `fsync`。ページの保存の書き出し。ロックの排他的な作成、更新、削除。再開のときの後始末（監査の途中のページのディレクトリ、一時ファイル、PREFLIGHT の一時ファイル）。最後の書き出しで、今回書かないファイルが前の回から残っていれば消す）
- 変更: 必要なら `src/core/artifact-layout.ts`（保存のパスの組み立て）
- テスト: `tests/unit/artifact-writer.test.ts`、`tests/unit/artifact-layout.test.ts`

**手順**
1. RED: 書き出しの順（注入したファイルの操作で `fsync` と名前の変更の順を確かめる）。`state.prev.json` への移し替え。ロックの排他（2つ目の作成が失敗する）。後始末が Run のディレクトリの外に及ばない（パスの確かめ）。最後の書き出しで古い `visible-text.txt` が消える。
2. 最小実装 → GREEN。
3. 関連する検証: `tests/architecture`（ARCH08 が PASS し、例外が増えていない）。

## R4a: 保存のセッションと保存の時期（新しい Run）

- 指示書: 作業記録置き場の `R4a-brief.md` と `R4a-blocker-resolution-brief.md`。
- 保存のセッション（`src/orchestration/run-checkpoint-session.ts`）、保存の書き手の interface（`run-checkpoint.ts`）、Run Coordinator の保存の時期と、保存に失敗した場合の `CHECKPOINT_WRITE_FAILED`。ページの中の Ledger の snapshot は、そのページの保存に入れる（設計書 4.1）。

## R4a2: 保存からの再開の流れ

- 保存の値から、frontier、採番器、`RunProgress`、`pagesStarted`、Ledger の snapshot、robots/sitemap の Evidence、pacer と meter を作り直して、続きから巡回する。最後の処理の Safety の集計に、保存した snapshot を含める。
- 違反の検出のフラグが立っていれば、または保存した snapshot に違反があれば（最後のページの違反はフラグにまだ立っていないことがある。R2 の報告）、新しいページを始めずに最後の処理だけを行う。
- 再開の始め方（ロックの作り直しと読み直し、後始末）をセッションに加える（設計書 4.4、4.5）。
- テスト: `tests/integration/resume-run.test.ts`（新規。fixture のサイトでの「中断しなかった場合と同じ」）。監査の途中のページが最初から監査し直される。違反の後の再開で新しいページを始めない。

## R4b1: 理由のコード、保存の時刻、終わり方の判定

- 指示書: 作業記録置き場の `R4b1-brief.md`。
- 変更: `src/core/contracts.ts`（`RUN_INTERRUPTED`。`RunProgressReport.pagesFinished` の説明）、`schemas/run.schema.json`（理由の enum）、`schemas/checkpoint.schema.json`（`savedAt`）、`src/presentation/messages.ts`（理由の説明）、`src/orchestration/run-checkpoint.ts`（`savedAt`、待ち行列に戻す理由、実行の記録の整合、`decideRunExecutionEndReason`、`decideRunCheckpointConclusion`、`closeInterruptedRunExecutions`）、`src/orchestration/run-coordinator.ts`（保存の時刻を渡すことと、再開のときに前の回の実行の記録を閉じることだけ）。
- テスト: `tests/unit/run-checkpoint.test.ts`、`tests/helpers/run-checkpoint-samples.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`、`tests/unit/run-coordinator.test.ts`、`tests/integration/resume-run.test.ts`。

## R4b2: 止める印、保存の終わり方、`executions`

- 指示書: 作業記録置き場の `R4b2-brief.md`。
- 変更: `src/orchestration/run-coordinator.ts`（`stopSignal`、`RUN_INTERRUPTED` の SKIPPED と Run の理由、最後の状態の中身（巡回の終わりの値）、最後に書けた保存の記録、`checkpointConclusion()`、`run.executions`）、`src/core/contracts.ts`（`RunSummary.executions`、`RunExecution`）、`schemas/run.schema.json`（`executions`）。`src/core/status.ts` は変えない（新しい SKIPPED の理由が PARTIAL になることを、テストで確かめる）。
- テスト: `tests/unit/run-coordinator.test.ts`、`tests/integration/resume-run.test.ts`（止める印の形と実行時間の上限の形の「中断しなかった場合と同じ」）、`tests/helpers/audit-run-fixture.ts`、`tests/unit/schema-enum-consistency.test.ts`、`tests/unit/schema-validator.test.ts`、`tests/unit/core-contracts.test.ts`。

## R5a: CLI の再開の流れ

- 設計書 4.7、4.7.1。指示書: 作業記録置き場の `R5a-brief.md`。
- 変更: `src/cli/arguments.ts`（`--new`）、`src/cli/run-command.ts`（実行中の Run の確かめ、途中の Run を探す、版の確かめ、知らせ、保存のセッション、Run の後の `finish`・`abandon`、`handleSIGINT`・`handleSIGTERM`・`handleSIGHUP` を `false`）、`src/cli/exit-codes.ts`（`RUN_UNAVAILABLE`）、`src/cli/output.ts`（知らせの行）、`src/presentation/messages.ts`（文言）、`src/orchestration/run-checkpoint.ts`（`RUN_VERSION_FIELDS`、途中の Run を選ぶ関数）、`src/report/artifact-writer.ts`（`state.json` だけを読む関数と、終わった Run の保存の片付け）、`src/orchestration/environment.ts`（Playwright の版を読む関数の export）、`src/core/artifact-layout.ts`（Run のディレクトリの一覧）。
- テスト: `tests/unit/cli.test.ts`、`tests/unit/exit-codes.test.ts`、`tests/integration/cli.test.ts`、`tests/unit/run-checkpoint.test.ts`、`tests/unit/artifact-writer.test.ts`、`tests/unit/artifact-layout.test.ts`。

## R5b: シグナルと README

- 設計書 4.7 の「シグナル」。指示書: 作業記録置き場の `R5b-brief.md`。
- 変更: `src/cli/index.ts`（シグナルの登録）、`src/cli/main.ts`（止める印を渡す口）、`src/cli/exit-codes.ts`（`INTERRUPTED`）、`src/presentation/messages.ts`（シグナルの文言）、`README.md`。
- 手順: Windows で子のプロセスに SIGINT を送れない場合は、止める印を注入する形で確かめ、シグナルの配線（`process.on` の登録と、1回目・2回目の振る舞い）は、`process.emit('SIGINT')` などで単体で確かめる。実際の Ctrl+C は、設計者がローカルの fixture のサイトで確かめる（設計書 第10章）。

## R6: 実行の記録の表示

**変更するファイル**
- 変更: 表示用モデル（`src/report/view-model.ts`）、`src/report/html-report.ts`、CLI の結果の表示、`src/report/chatgpt-bundle.ts`（`summary.json`）、`src/presentation/messages.ts`
- テスト: 表示の単体テスト、`tests/architecture/ui-ssot.test.ts`

## RR: 独立レビュー

- 読み取り専用のレビュー担当に、設計書と R1〜R6 の報告を渡す。とくに、再開の後も違反の後に監査を始めない決まりが守られること、保存と後始末が Run のディレクトリの外に及ばないこと、「中断しなかった場合と同じ」の確かめが十分なこと、ロックの判定が端末の再起動で誤らないことを確かめる。
- Critical 0件、Important 0件で完了とする。
