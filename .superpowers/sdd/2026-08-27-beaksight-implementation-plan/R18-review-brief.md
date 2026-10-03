# R18 指示書: Task 18 のチェックポイントの独立レビュー（受け入れの Gate）

あなたは、BeakSight リポジトリ（`C:\Develop\github-repo\BeakSight`）の独立レビュー担当です。BeakSight は、Node.js 24、TypeScript strict、Playwright Library、Vitest、Ajv、fflate の、読み取り専用の Web サイト監査 CLI です。

このレビューは、実装タスク指示 第12章のチェックポイント（Task 18）です。

- Critical と Important がなければ、ユーザーの承認を得て、Task 19 に進みます。
- Task 18 の Gate がすべて PASS することは、実際の監査対象のサイトにアクセスする前の条件です（実装タスク指示 第11章）。

## 厳守事項

- ファイルを一切、編集も作成もしないでください（読み取り専用）。
  - 検証用のスクリプトや出力は、リポジトリの外（一時ディレクトリ）に置いてください。
  - CLI を動かすための一時ビルドだけは、`node_modules/.cache` の下に作り、終わったら削除してください。
  - 一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作ってはいけません。`R-review-common.md` の末尾の「一時ディレクトリの扱い」を読んでから始めてください。
- Git は、表示だけのコマンドを使ってください。
  - 使ってよいのは、`git status`、`git diff`、`git log`、`git show`、`git blame` です。
  - commit、push、checkout、restore、reset、stash、switch、worktree は禁止です。
- テストの実行
  - `npm run build` は、実行しないでください。
  - テストは、対象を絞って、`npx vitest run <対象ファイル>` で実行してください。
  - `npm run typecheck` は、実行してかまいません。
- インターネット上のサイトには、アクセスしないでください。とくに 本来の監査対象のサイトへのアクセスは禁止です。
  - `config/targets/` の実サイトの設定を使った実行はしないでください。GATE-ARCH01 のテストが読むのは構いません。
  - `local/` 配下のファイルは、使わないでください。
  - 検証は、ローカルの fixture と `127.0.0.1` のサーバだけで行ってください。

## 対象

- 設計書:
  - `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md`
  - `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-implementation-plan.md`
  - 参考: `doc/design/2026-09-25-beaksight-pre-task-18-cleanup-design.md`
- 上位の文書:
  - `doc/design/2026-08-27-beaksight-implementation-tasks.md`（第9章 完了の意味、第10章 Architecture Gates、第11章 Acceptance Gates、第12章、SSOT Owner Matrix、Safety Invariants）
  - `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 18
  - `doc/design/2026-08-27-beaksight-web-audit-design.md` の第30・31章
  - UI 追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md` の第6章と完了条件
- 共通部品台帳: `doc/design/beaksight-shared-components.md`
- 実装とテスト:
  - `tests/integration/safety-gates.test.ts`、`tests/helpers/gate-harness.ts`
  - `tests/integration/auditor-gates.test.ts`
  - `tests/architecture/target-isolation.test.ts`、`tests/architecture/semantic-ownership.test.ts`、`tests/architecture/source-scan.ts`、`tests/architecture/ui-ssot.test.ts`
  - `tests/integration/gate-fixtures.test.ts`、`fixtures/site/` の新しいファイル
  - T18e で変えた `src/audit/cross-page-rules.ts`（と、変えた場合の `src/crawl/normalize-url.ts`）
- 報告（作業記録置き場 `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）:
  - `T18a-report.md`、`T18b-report.md`、`T18c-report.md`、`T18d-report.md`、`T18e-report.md`
  - 参考: `RP18-review-result.md`、`RP18r-review-result.md`
  - 報告の中の「設計者の判断」は、設計者が承認した事項です。

## とくに確かめること

1. **Gate がそろっていること**
   - `GATE-S01`〜`GATE-S10`、`GATE-A01`〜`GATE-A10`、`GATE-ARCH01`〜`GATE-ARCH08`、`GATE-UI01`〜`GATE-UI06` の名前のテストが、すべてあり、PASS すること。
   - `it.skip`、`it.todo`、条件付きの skip で、実際には実行されていない Gate がないこと。
2. **Gate が、定義を本当に確かめていること（空振りがないこと）**
   - Safety の Gate が、fixture のサーバの境界で数えていること。
     - Ledger の記録だけで確かめていないこと。
     - 数える対象のパスや、カウンタの名前が正しく、常に真になる確認（DEF-010 と同じ種類の誤り）がないこと。
   - 各 Gate の対照の確認が、本当に対照になっていること。対照の側で、リクエストが実際に届いていること。
   - Auditor の Gate が、実際の Chromium と実際の Rule で、Finding を確かめていること。
   - Architecture の Gate の検出の関数が、違反の例を検出でき、除外の一覧が必要最小限で、理由が妥当であること。
     - とくに、ARCH04 の除外（`request-policy.ts`、`validate-config.ts`、`technical-rules.ts` など）が、URL の意味の SSOT の趣旨に反しないこと。
   - UI Gate が、DEF-011 の修正の後、これまで抜け落ちていた範囲も検査していること。
3. **T18e の修正**
   - `cross-page-rules.ts` の Origin の判定が、URL の owner の判定を使う形になり、振る舞いが変わっていないこと。
4. **全体の整合（実際の CLI での確認）**
   - 一時ビルドの CLI で、fixture のサイト（127.0.0.1）を最後まで監査してください。
     - 開始の URL: 例えば `/crawl/index.html`
     - 設定: 一時的なもの
   - 次のことを確かめてください。
     - Run Status と終了コードが、完了の意味（第9章）のとおりであること
     - artifact（run.json、audit.json、page.json、report.html、バンドル）が、そろってスキーマに合うこと
     - 違反が0件であること
     - GET と HEAD 以外のリクエストが、サーバに届かないこと
   - report.html を、文字として読み、Finding から Evidence とスクリーンショットにたどれること、危険なスキームがリンクになっていないことを確かめてください。
5. **速さ**
   - Architecture と UI の Gate の各ファイルが、1秒以内に終わること。
   - Safety と Auditor の Gate の各ファイルが、1分程度であること。
6. **Task 20 に進む前の条件**
   - 実装タスク指示 第11章の「1件でも FAIL している状態で target-site smoke を実施してはいけません」を、今の状態が満たしているか。

## 報告

意味の通る日本語で、次の形式で返してください。全体で3000字程度までとし、重要度の高いものを優先してください。

- 総合判定: 承認 / 修正が必要
- Gate の一覧の判定: そろっている・PASS しているか（Gate の種類ごと）
- 指摘: 各指摘に、次の項目を書いてください。
  - 重大度（Critical / Important / Minor）
  - 該当箇所（`パス:行`）
  - 問題の内容
  - 根拠（仕様のどの記述か、再現の手順）
  - 期待する状態
- 再実行したコマンドと結果（テスト数、失敗数、終了コード、所要時間）
- 確認できなかった点

重大度の基準は、次のとおりです。

- Critical: 安全性の不変条件の違反、または仕様の中核の欠落
- Important: 仕様からの明確な逸脱、現実的に起きうる不具合、誤りを検出できないテスト（空振りの Gate を含む）
- Minor: それ以外

設計者が報告の中で承認した事項は、それ自体を指摘しなくてかまいません。ただし、その判断が仕様に反すると考える場合は、根拠とともに指摘してください。推測だけの指摘には、「推測」と明記してください。
