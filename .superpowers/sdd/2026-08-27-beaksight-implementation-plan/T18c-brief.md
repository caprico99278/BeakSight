# T18c 指示書: Auditor の Gate（GATE-A01〜A10）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T18c
- 目的: Auditor の Gate（A01〜A10）を、実際の Chromium で fixture を監査して確かめる、名前付きの統合テストにする。
- 設計書: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md`（とくに 4.1 と 4.3）
- 実装計画: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-implementation-plan.md` の T18c
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 18 の Step 3
  - `doc/design/2026-08-27-beaksight-web-audit-design.md` の第31章
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md` の完了の意味
- 前の報告: 作業記録置き場の `T18a-report.md`（fixture の一覧）
- 共通部品台帳: `doc/design/beaksight-shared-components.md`（テスト補助の行）

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、T18b（`tests/integration/safety-gates.test.ts`、`tests/helpers/gate-harness.ts`）と T18d（`tests/architecture/` の新しいファイル）と並行で実行します。**

- 下の「変更してよいファイル」の外は、変更しないでください。
- `tests/helpers/gate-harness.ts` は、T18b が作るので、使わないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。
  - ほかの実装者の作業中のファイルから、型のエラーやテストの失敗が出た場合は、自分のファイルのものでないことを確かめて、報告に書いてください。

## 変更してよいファイル

- 新規: `tests/integration/auditor-gates.test.ts`
- `src/`、`fixtures/`、`tests/helpers/` は、変更しません。
  - 補助が足りない場合は、テストのファイルの中に置いてください。後で、設計者が共通化を判断します。
  - Gate のテストが、今のコードで FAIL した場合は、監査の誤りの可能性があります。止まって、事実を報告してください。
  - fixture が足りない場合も、止まって報告してください。

## 作るもの

1. **テストの名前**: `GATE-A01` 〜 `GATE-A10` を、テストの名前の先頭にそのまま含める。1つの Gate に、複数のテストがあってよい。
2. **確かめ方**（設計書 4.3 の表）
   - A01〜A09 は、実際の Chromium で、fixture のページを、Run Coordinator か CLI（同じプロセスの中の `runCli`）を通して監査する。
     - 実行時間を抑えるため、1回の Run で、複数の Gate を確かめてよい。
     - 例: 開始のページから、404 のページ、壊れた画像、JS の例外、横のはみ出し、低いコントラストをたどれる設定にする。
   - 各 Gate で確かめること:
     - A01: 404 のページで、`HTTP_4XX` の Finding が出る。
     - A02: 壊れた内部リンクで、`BROKEN_INTERNAL_LINK` の Finding が出る。
     - A03: 捕まえられない JS の例外で、`PAGE_ERROR` の Finding が出る。
     - A04: 壊れた画像で、`IMAGE_LOAD_FAILED` の Finding が出る。
     - A05: 横のはみ出しで、`DOCUMENT_HORIZONTAL_OVERFLOW` の Finding が出る。
     - A06: 低いコントラストで、`COLOR_CONTRAST_VIOLATION` の Finding が出る。
     - A07: 安全なアコーディオンが、Interaction の結果で `VERIFIED` になる。
     - A08: 安全でない Interaction が、遮断されるか検証されない（`BLOCKED_BY_SAFETY`、`REJECTED_UNSAFE` など）。サーバの側で、POST などが届かないことも確かめる。
     - A09: クロールの上限（ページ数か深さ）で、Run が `PARTIAL` になる。理由 `MAX_PAGES_REACHED` か `MAX_DEPTH_REACHED` が付く。
     - A10: スキーマに合わない artifact がある場合に、`COMPLETE` にならない。
       - スキーマに合わない artifact は、実際の Run では作れない。そのため、`finishAuditRun`（`src/cli/run-command.ts`）に、スキーマに合わない Run を渡して確かめる。
       - 見本は、`tests/helpers/audit-run-fixture.ts` で作る。
       - 導き直した後の Run Status が `PARTIAL` で、理由 `REQUIRED_ARTIFACT_INVALID` が付き、終了コードが 2 になることを確かめる。
   - Finding の確かめ方: Rule の ID、ページ、ビューポート、Evidence の参照があることを確かめる。
   - 完了の意味: ERROR の Finding がある Run でも、ほかに未完了の理由がなければ、Run Status が `COMPLETE` になることを、1件以上確かめる。Finding の件数で Run Status が決まらないことを示すためである。
3. **実行時間**
   - ファイル全体で、1分程度までを目安とする。所要時間を報告に書く。

## 受け入れ条件

- `GATE-A01`〜`GATE-A10` の名前のテストが、すべてあり、PASS する。
- 各 Gate の確認が、実装の誤りを検出できる形である。
  - 対照の確認を置く。例えば、同じ Run の問題のないページには、その Finding が出ないこと。
  - 対照の確認が置けない Gate は、その理由を報告に書く。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次の3つを入れてください。

- Gate ごとに、何を、どの fixture で確かめたか
- 対照の確認の有無
- Run の構成（開始の URL、上限、たどったページ）
