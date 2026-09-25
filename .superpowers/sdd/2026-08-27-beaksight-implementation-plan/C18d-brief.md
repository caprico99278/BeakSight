# C18d 指示書: テストの補助の共通化（CC-029）と、共通のハブのページ

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18d
- 目的:
  - Gate と統合テストに複製されている、テストの補助を、`tests/helpers/` にまとめる（CC-029）。
  - 共通のハブのページを fixture に加え、Auditor の Gate の Run の数を減らせるかを確かめる。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の第5章（CC-029）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18d
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-029（対象の一覧がある）
- 前の報告: 作業記録置き場の `T18b-report.md`、`T18c-report.md`、`C18b-report.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（テスト補助の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `tests/helpers/`（補助を加える、まとめる、移すことに限る）
- 補助を使う形に置き換えるテストのファイル（CC-029 に挙げたもの）
  - `tests/integration/auditor-gates.test.ts`
  - `tests/integration/safety-gates.test.ts`
  - `tests/integration/crawl-run.test.ts`
  - `tests/unit/run-command.test.ts`
  - `tests/integration/preflight.test.ts`
  - `tests/integration/isolated-interaction.test.ts`
  - `tests/integration/external-scheme-navigation.test.ts`
  - `tests/integration/gate-fixtures.test.ts`
- `fixtures/site/`（共通のハブのページを加えることに限る。既存のファイルは変えない）
- `src/` は、変更しません。

## 作るもの

1. **補助の共通化**（CC-029）
   - 次のものを、`tests/helpers/` の中の1か所にまとめる。置き場所とファイルの名前は、実装者が決めて報告する。
     - Run の起動（launcher、同じプロセスの中の `runCli`）
     - Finding の取り出し
     - スキーマの確認
     - GET と HEAD だけが届いたことの確認
     - 出力の取り込み（`capture`）
     - Guard のない対照の page
     - Browser の Proxy（`newContext` の失敗、`context.close()` の停止）
     - Interaction の候補の探索と、入力の組み立て
     - 外部スキームの宛先と経路（名前の書き方をそろえる）
   - 各テストのファイルは、まとめた補助を使う形にする。同じ処理を、テストのファイルの中に残さない。
   - 検証の内容（期待値）は、各テストに残す。
2. **置き換えの前後で、振る舞いを変えない**
   - テストのケースと期待値は、変えない。
   - 置き換えの前後で、各ファイルの PASS の件数が同じであること。前後の件数を、表にして報告する。
   - Gate の確認と対照の確認は、弱めない。
3. **共通のハブのページ**
   - 次のページへのリンクを持つハブのページを、`fixtures/site/` に加える。
     - 404 のページ
     - 壊れた画像のページ
     - JS の例外のページ
     - はみ出しのページ
     - 低いコントラストのページ
   - そのうえで、Auditor の Gate（`auditor-gates.test.ts`）の Run の数を、減らせるかを確かめる。
     - 減らせる場合は、減らす。ただし、各 Gate の確認と対照の確認は、弱めない。
     - 減らせない場合、または減らすと Gate の確認が弱まる場合は、減らさずに、その理由を報告する。
   - Run の数と実行時間の、前後を報告する。

4. **RC18c の M2・M3（テストの追加）**
   - M2:
     - `tests/integration/safety-gates.test.ts` の GATE-S03 の入れ子の OOPIF の場合（792行付近）に、中の frame が OOPIF であることの確認を加える（`oopifTargetUrls()` などで、2つ目の OOPIF があることを見る）。
     - あわせて、OOPIF の Interaction の段階（凍結の後）の確認を、GATE-S03 に1件加える。
   - M3: `src/safety/passive-request-guard.ts` の fail-closed の分岐のうち、テストされていない3つに、注入によるテストを加える。
     - iframe でない target が付いた場合（`:1539` 付近）
     - `waitingForDebugger` が偽の場合（`:1543` 付近）
     - `OOPIF_GUARD_PROTOCOL_FAILED` の場合（`:1577` 付近）
     - どれも、違反が記録され、Context が閉じ、OOPIF が進まないことを確かめる。
     - テストは、`tests/integration/oopif-guard.test.ts` か `tests/integration/passive-request-guard.test.ts` に置く。
     - `src/` は、変えない。テストが FAIL した場合は、止まって報告する。
   - このために、`tests/integration/oopif-guard.test.ts` と `tests/integration/passive-request-guard.test.ts` の変更を、この目的に限って許可する。
   - Chromium は headless だけで起動する（`--site-per-process` は、かまわない）。

## 受け入れ条件

- 置き換えの前後で、各ファイルの PASS の件数が同じである（ハブのページで Run をまとめた場合は、Gate の名前のテストがすべて残っていること）。
- テストのケースと期待値を、削除したり弱めたりしていない。
- すべての Gate（S、A、ARCH、UI）が PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- まとめた補助の一覧（置き場所と名前）
- ファイルごとの、置き換えの前後の PASS の件数
- Auditor の Gate の Run の数と実行時間の、前後
