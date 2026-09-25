# T18a 指示書: Task 18 の足りない fixture と、DEF-010

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: T18a
- 目的:
  - Task 18 の受け入れの Gate に必要な、足りない fixture を加える。
  - 既存のテストの欠陥 DEF-010 を直す。
- 設計書: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md`（とくに第3章と 4.2）
- 実装計画: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-implementation-plan.md` の T18a
- 不具合台帳: 作業記録置き場の `defects.md` の DEF-010
- 上位の実装計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 18 の Step 1
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

このサブタスクは単独で実行します。

## 変更してよいファイル

- `fixtures/server.ts`（必要な場合に限る。既存の振る舞いは変えない）
- `fixtures/site/`（ファイルを加えることに限る。既存のファイルは変えない）
- `tests/integration/isolated-interaction.test.ts`（DEF-010 に限る）
- `tests/integration/fixture-server.test.ts`（fixture のサーバを変えた場合に、そのテストを加えることに限る）
- 新しい fixture を確かめるテスト（既存のテストのファイルか、新規のファイル）

`src/` は、変更しません。

## 作るもの

1. **PATCH を送るページ**
   - Passive の段階で、ページのスクリプトが PATCH を送ろうとするページを置く。
   - Interaction の段階で、ボタンを押すと PATCH を送ろうとするページも置く。
   - 既存の `put-request.html` などと同じ形にする。
2. **Worker 自身がリクエストを試みる Service Worker**
   - Worker が、自分の中から、fixture のサーバへ POST を試みるスクリプトを置く。
     - 例: install か activate の時に `fetch(..., { method: 'POST' })` を呼ぶ。
   - それを登録するページを置く。
   - 既存の `service-worker.html` と `fixture-service-worker.js` は、変えない。
3. **移動の先のページ**
   - `fixtures/site/popup-target.html` と `fixtures/site/navigation-target.html` を置く。
   - これらのページへの GET が、サーバで記録されることを確かめる。
     - Passive の Context で、直接そのページを開けば、GET が記録されること。
     - これは、DEF-010 を直した確認が意味を持つための、対照の確認である。
4. **DEF-010**
   - `tests/integration/isolated-interaction.test.ts:1846-1847、1864` 付近の確認のパスを、`/popup-target.html` と `/navigation-target.html`（先頭に `/`）に直す。
   - 直した確認が、正しく働くことを確かめる。
     - 移動やポップアップの遮断を、一時的に働かないようにすることは、できない（`src/` を変えないため）。
     - 代わりに、上の3の対照の確認で、これらのページへの GET が数えられることを示す。
   - 直した後も、テストが PASS すること。
     - もし FAIL した場合は、遮断が働いていない可能性がある。止まって、事実を報告してください。
5. **新しい fixture の確かめ**
   - 新しいページと Worker が、期待どおりのリクエストを試みることを、確かめる。
     - Guard のない、対照の Context で確かめる。
     - 例: 対照の Context では、PATCH や Worker の POST がサーバに届く。
   - 既存の同じ形の対照のテストがあれば、それに合わせる。

## 受け入れ条件

- 新しい fixture を確かめるテストが、fixture がない状態で RED、置いた後に GREEN になる。
- 既存のテストは、DEF-010 のパスの修正のほかは、変えない。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する。

## 報告

共通ルールの形式で、日本語で報告してください。T18b と T18c の実装者が使うので、加えた fixture のパスと、それぞれが試みるリクエスト（メソッドとパス）の一覧を書いてください。
