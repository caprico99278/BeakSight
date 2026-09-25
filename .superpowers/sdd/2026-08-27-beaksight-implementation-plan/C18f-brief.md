# C18f 指示書: 違反の後は、監査を続けない（RC18a の指摘2）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18f
- 目的: 安全の不変条件の違反を検出した後は、新しいページ、ビューポート、Interaction の候補を始めない。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の 4.5
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18f
- レビューの結果: 作業記録置き場の `RC18a-review-result.md`（指摘2）
- 再現の記録: `C:\Users\ocean\AppData\Local\Temp\claude\C--Develop-github-repo-BeakSight\c7d3723a-f7c4-4979-913c-ece0b3289778\scratchpad\rc18a\probe3-scripted.log`（読むだけにする）
- 上位の文書: `doc/design/2026-08-27-beaksight-implementation-tasks.md`（完了の意味、Safety Invariants）、`doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 5.6
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18g（外部スキームへのリダイレクト）と並行で実行します。** C18g が変えるファイルは、次のとおりです。

- `src/safety/passive-request-guard.ts`、`src/safety/safety-ledger.ts`
- `src/core/evidence-types.ts`
- `src/presentation/catalog.ts`、`src/audit/safety-rules.ts`
- `fixtures/`
- `tests/integration/safety-gates.test.ts`、`external-scheme-navigation.test.ts`、`passive-request-guard.test.ts`、`gate-fixtures.test.ts`

守ってほしいことは、次のとおりです。

- 下の「変更してよいファイル」の外は、変更しないでください。
- `schemas/page.schema.json` は、C18g も変える可能性があります。
  - あなたが変えてよいのは、理由のコードの一覧（enum）の部分だけです。
  - 編集の前に、必ずファイルを読み直してください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。ほかの実装者の作業中のファイルから出たエラーは、そのことを確かめて報告に書いてください。

## 変更してよいファイル

- `src/orchestration/run-coordinator.ts`
- `src/orchestration/page-auditor.ts`
- `src/interaction/isolated-auditor.ts`（次の候補を始めない処理に限る）
- `src/core/contracts.ts`（理由のコードを加える場合に限る）
- `schemas/run.schema.json`、`schemas/page.schema.json`（理由のコードの一覧に限る）
- `src/presentation/messages.ts`（理由の説明を加える場合に限る）
- テスト:
  - `tests/unit/run-coordinator.test.ts`
  - `tests/integration/crawl-run.test.ts`
  - `tests/integration/page-auditor.test.ts`
  - `tests/integration/page-auditor-interaction.test.ts`
  - `tests/integration/isolated-interaction.test.ts`（次の候補を始めないことのテストに限る）
  - 理由のコードの一覧とスキーマの一致を確かめる既存のテスト

## 作るもの

1. **違反の検出**
   - 違反（安全の不変条件の違反）が、どこかの Ledger に1件でも記録されたことを、Run の途中で知る方法を作る。
   - 方法は、次のどちらかにする。どちらにしたかと、その理由を報告する。
     - Run Coordinator が、各ページの後（とビューポートの後）に、Ledger の登録（Run の間に作ったすべての Ledger）を調べる。
     - 違反の通知を受ける。
   - 違反の種類は、問わない。
2. **止める**（設計書 4.5）
   - 違反を検出した後は、次のことをしない。
     - 新しいページを始める。
     - 同じページの、次のビューポートを始める。
     - Interaction の、次の候補を始める。
   - 残りのページは、理由付きの `SKIPPED` にする。
     - 理由のコードは、既存のもので正しく表せなければ、新しいもの（例: `SAFETY_VIOLATION_ABORT`）を加える。
     - 加える場合は、次のものを合わせて直す。
       - contracts の一覧
       - スキーマの enum
       - `messages.ts` の説明
       - UI05（書き漏れの検査が、自動で対象にすること）
   - 始めなかったビューポートや候補も、正直に記録する。例えば、未完了の理由や、`CHECK_NOT_COMPLETED` である。記録の形は、今の未完了の扱いに合わせる。
   - すでに始めた処理の後始末（Context と Browser を閉じること）は、今までどおり行う。
   - 書き出し（artifact、HTML、バンドル）は、今までどおり行う。Run Status は、`deriveRunStatus` が `ABORTED_BY_SAFETY` と導く。
3. **テスト**
   - 違反を起こすページが複数あるサイトで、Run を行う。
     - 例: 読み込みの後に Guard の違反を起こすページを、3つ持つサイト。
     - 違反の起こし方は、既存のテストの方法を使ってよい。例えば、headed を注入して外部スキームへ移動する fixture（`fixtures/site/external-scheme-navigation.html`）、または Guard の取り付けに違反を起こす Browser の差し替えである。
   - 確かめること:
     - 違反は、最初の1回（最初のページの、最初のビューポート）だけで、2回目以降が起きない。
     - 残りのページが、理由付きの `SKIPPED` になる。
     - Run Status が、`ABORTED_BY_SAFETY` になる。
     - artifact が書き出され、スキーマに合う。
   - Interaction の候補: 1つの候補で違反が起きた後に、次の候補を始めないことを確かめる。
   - 修正の前に RED になること。RC18a の再現では、違反は6件だった。
   - 実際の時間を待たない。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。headed の扱いは、設定を `headed: true` にして、headless のブラウザで確かめる。
- 外部スキームの URL には、実在する宛先を使わない。

## 受け入れ条件

- 各テストが、修正前に RED、修正後に GREEN になる。
- 既存のテストのケースと期待値を、弱めない。
  - 違反の後も監査を続けることを前提にした既存のテストがある場合は、止まって報告する。
- Run Status を決めるのは、`deriveRunStatus` だけのままである。
- すべての Gate（S、A、ARCH、UI）が PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- 違反の検出の方法と、止める処理の場所（ファイル:行）
- 新しい理由のコード（加えた場合）
- 始めなかったビューポートと候補の記録の形
