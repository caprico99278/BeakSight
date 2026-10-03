# RC18 指示書: Task 19 の前の整理の、全体の確認のレビュー

最初に、作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `RC18a-review-brief.md` を読んでください。厳守事項、重大度の基準、報告の形式は、その指示書に従ってください。

`R-review-common.md` の末尾の「一時ディレクトリの扱い」も、必ず守ってください。一時ディレクトリに、リポジトリへのリンク（ジャンクション、シンボリックリンク）を作ってはいけません。

**ファイルを編集しないでください（読み取り専用のレビューです）。** 確かめのためのスクリプトやテストは、一時ディレクトリに置いてかまいません。

**Chromium は headless だけで起動してください。headed（`headless: false`）で起動してはいけません。** 外部スキームの URL には、実在する宛先を使わないでください（`tel:+10000000000`、`mailto:nobody@example.invalid`、`beaksight-test-app:probe`）。本来の監査対象のサイトを含む実在の外部のサイトには、接続しないでください。`config/targets/` と `local/` の実サイトの設定は使わないでください。`git commit`、`git push`、HEAD に戻す操作は禁止です。

## 担当

Task 19 の前の整理（C18a〜C18o）の全体を確かめ、Task 19 に進んでよいかを判断する材料を返してください。Guard（DEF-012、DEF-013、OOPIF）は RC18a〜RC18c でレビュー済みです。その後に Guard の製品のコードは変わっていません（`git diff --stat` で確かめてください）。ここでは、主にその後の変更と、整理の全体の完了条件を見てください。

- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md`（とくに 第5章、5.1、第8章の完了条件）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md`
- 報告: `C18c-report.md`、`C18d-report.md`、`C18e-report.md`、`C18k-report.md`、`C18k-fix-round-1-report.md`、`C18n-report.md`、`C18o-report.md`、`C18m-report.md`
- 前のレビューの結果: `RC18a-review-result.md`、`RC18b-review-result.md`、`RC18c-review-result.md`
- 台帳: `defects.md`、`commonization-candidates.md`、`doc/design/beaksight-shared-components.md`

## とくに確かめること

1. **Interaction の理由のコード化（C18n、C18o。設計書 5.1）**
   - Evidence の `reason`、`work.reason`、`lifecycle.reason` に、英文が入る経路が残っていないこと。`isolated-auditor.ts` のすべての経路を読んで確かめてください。
   - status とコードの組み合わせが、型とスキーマの両方で正しく制限されていること。スキーマの enum とコードの一覧が一致していること。
   - `reasonDetail` に入るエラーの文言が、上限付きで整えられていること。機微な情報（URL の問い合わせの部分など）の扱いが、前と変わっていないこと。
   - `CLICK_TIMED_OUT`、`CLICK_FAILED`、`EXECUTION_FAILED` が正しく見分けられること。
   - Safety Ledger の記録と、Interaction の status・`notVerifiableKind`・Run Status の決め方が変わっていないこと。
   - 日本語の説明が、コードの意味と合っていること（誤解を招く説明がないか）。HTML で、詳細がエスケープされること。
2. **候補の探索の処理の統合（C18e）**
   - `interactionCandidateProbe` が、ブラウザの中で関数の外の値を参照していないこと。
   - 探索・解決・読み取りの3つのモードで、作業量の数え方と打ち切りの状態が、前と同じであること（C18e の比べ方の報告を読み、必要なら fixture で確かめてください）。
   - 2つ目の引数の有無で入力を見分ける方法に、誤って別のモードとして動く危険がないこと。
3. **テストの補助の共通化（C18d、C18k、C18k-fix-round-1、C18m）**
   - テストの確かめる内容が、置き換えで弱まっていないこと（期待値の削除、`expect` の減少、空振りする確かめ）。とくに、Gate（S、A）の確かめと対照の確かめ。
   - テストが Chromium を headed で起動する経路が、残っていないこと（要求された `headless` の値をそのまま渡す launcher など）。
   - `fixtures/` が `tests/` を import していないこと。
   - `withGuardedPassivePage` が、閉じる処理の失敗を隠すことで、閉じる処理を確かめるべきテストの意味を失わせていないこと。
4. **SSOT と共通化**
   - 新しく作ったもの（コードの一覧、説明、`reasonParts`、`ReasonView<TCode>`、テストの補助）に、第二の owner や複製がないこと。
   - UI Gate と ARCH の Gate が、今の変更の後も意味のある検査をしていること（1ファイル1秒以内であること）。
5. **完了条件と台帳**
   - 設計書 第8章の完了条件の各項目が満たされているか。
   - 不具合台帳（DEF-008〜014）と共通化候補（CC-008、CC-010、CC-029〜032）の状態の記述が、実装と合っているか。
   - 共通部品台帳の記述が、実装と合っているか（名前、置き場所、責務）。
6. **全体**
   - すべての Gate（S、A、ARCH、UI）が PASS すること。
   - `npm run verify` の結果は、設計者が実行したもの（下）を使ってかまいません。必要なら、対象を絞ってテストを実行してください。

## 設計者の verify

- 2026-09-25、C18m と C18o の後: `npm run verify` の終了コード 0。型チェック PASS、98ファイル、3,629件が PASS（失敗 0）。ビルド PASS。テストの所要時間は 328秒。

## 報告

`RC18a-review-brief.md` の形式で、日本語で返してください。指摘ごとに、重大度（Critical / Important / Minor）、場所（ファイル:行）、根拠、直し方の案を書いてください。最後に、Task 19 に進んでよいかの意見を書いてください。
