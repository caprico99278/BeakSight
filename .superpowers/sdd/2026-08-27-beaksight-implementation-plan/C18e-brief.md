# C18e 指示書: CC-008 の残り（discover-candidates の中の複製）と、CC-010 の残り（理由のコードと英文の混在）

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。末尾の「一時ディレクトリの扱い」も守ってください。

## サブタスク

- ID: C18e
- 目的:
  - `src/interaction/discover-candidates.ts` の中の複製を、1つにまとめる（CC-008 の残り）。
  - Interaction の `reason` の欄で、理由のコードと英文が混ざっている点を、整理する（CC-010 の残り）。
- 設計書: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-design.md` の第5章（CC-008 の残り、CC-010 の残り）
- 実装計画: `doc/design/2026-09-25-beaksight-pre-task-19-cleanup-implementation-plan.md` の C18e
- 共通化候補: 作業記録置き場の `commonization-candidates.md` の CC-008 と CC-010
- 関係する設計書:
  - 基盤修正の設計書 `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の第3章と 5.5（可視判定）
  - Task 14〜17 の設計書 `doc/design/2026-09-23-beaksight-task-14-17-pipeline-report-cli-design.md` の 6.1.5（理由の表示）
  - UI 追補設計書 `doc/design/2026-09-23-beaksight-ui-ssot-design.md`
- 共通部品台帳: `doc/design/beaksight-shared-components.md`

これまでの変更は、作業ツリーにそのまま残っています。HEAD に戻す操作は禁止です。

**このサブタスクは、C18k（テストの補助の重複。`tests/helpers/`、`tests/unit/cli.test.ts`、`tests/integration/report-generation.test.ts`・`environment.test.ts`・`safety-gates.test.ts`・`external-scheme-navigation.test.ts`・`oopif-guard.test.ts`・`gate-fixtures.test.ts`、`tests/component/discover-links.test.ts`、`fixtures/`）と並行で実行します。**

- 下の「変えてよいファイル」の外は、変更しないでください。
- `npm run verify` と `npm run build` は、実行しないでください。全体の verify は、設計者が行います。
- 担当のテストと `npm run typecheck` は、実行してかまいません。ほかの実装者の作業中のファイルから出たエラーは、そのことを確かめて報告に書いてください。

## 進め方（2段階）

### 第1段階: CC-008 の残り（実装する）

- `discover-candidates.ts` の中の、`discoverInteractionCandidates` と `inspectInteractionCandidateHandle` で複製されている処理を、1つにまとめる。
  - 対象: 作業量のカウンタ、要素の走査、テキストの切り詰め、可視判定、アクセシブルネーム、候補の組み立て
- これらは、ブラウザの中で動く処理（`page.evaluate` に渡す関数）である。そのため、まとめ方には制約がある（関数の外の変数を参照できない、など）。
  - まとめ方は、実装者が決めて報告する。
  - 例: 1つの関数の中に、共通の内側の関数を置く。
- **振る舞いを変えない。**
  - 既存の Interaction のテスト、Gate（S、A）、DOM の作業量の上限のテストが、変更なしで PASS すること。
  - 候補の一覧と、各候補の値が、まとめる前と後で同じであることを、fixture のページでの比べ方で確かめる。
    - 例: まとめる前に、fixture のページごとの候補の JSON を、一時ディレクトリに保存する。まとめた後に、同じ JSON と比べる。
- 変えてよいファイル: `src/interaction/discover-candidates.ts`、対応するテスト（`tests/integration/isolated-interaction.test.ts`、discover-candidates の単体テストと結合テスト）。C18k が変えるテストのファイルは、変えない。

### 第2段階: CC-010 の残り（まず調べて報告し、設計者の判断を待つ）

- まず、次のことを調べて、報告する。**実装はしない。**
  - Interaction の `reason` の欄に入る値の一覧。理由のコード（英数字）と英文の、どちらか。
    - 出どころのファイル:行
  - その値が使われる場所。
    - Evidence
    - スキーマ（page.json）
    - 表示用モデル
    - HTML
    - バンドル
    - Rule
  - 理由のコードと、技術的な詳細（英文）を分ける案。
    - 例: `reason` をコードだけにし、`detail` を別の項目にする。
  - その案の影響の範囲。
    - JSON の形とスキーマの変更
    - 既存のテストの期待値
    - 表示の文言（`messages.ts`）
- 第1段階を終えて、第2段階の調べた結果を報告したら、止まる。第2段階の実装は、設計者の判断の後に、別の指示で行う。

## 受け入れ条件（第1段階）

- 既存のテストのケースと期待値を、変えない。弱めない。
- 候補の一覧と各候補の値が、まとめる前と後で同じである（比べ方と結果を報告する）。
- すべての Gate（S、A、ARCH、UI）が PASS する。
- `npm run typecheck` が PASS する。
- `npm run verify` は実行しない（並行作業のため）。関係するテスト（Interaction、Gate の S と A）を、対象を絞って実行する。

## 厳守事項（このサブタスクに固有のもの）

- **Chromium は headless だけで起動する。** headed（`headless: false`）で起動してはいけない。

## 報告

共通ルールの形式で、日本語で報告してください。報告には、次のものを入れてください。

- 第1段階: まとめ方、変更したファイル、まとめる前と後の比べ方と結果、テストの結果（件数）
- 第2段階: 調べた結果と、案と、その影響の範囲
