# BeakSight Task 19 の後の不具合の修正（DEF-017・DEF-019） 実装計画

設計書: `doc/design/2026-09-26-beaksight-post-task-19-defects-design.md`
目標: `--headless` の説明を直し、1行の見出しの fixture をフォントに依存しない形にして、Linux の環境でも全体の verify を PASS させる。
作業記録置き場: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`

## 全体の制約

- 実装者は Git の commit・push をしない。HEAD に戻す操作（checkout、restore、reset、stash など）も禁止。表示だけの `git status`・`git diff`・`git log`・`git blame`・`git show` は使ってよい。コミットとプッシュは、クラウドの環境で設計者だけが行う。
- 依存パッケージの追加・更新をしない。実サイトにアクセスしない。検証はローカルの fixture で行う。
- `src/**` は target に依存しない形に保つ。
- テストの Chromium は headless だけで起動する。
- DEF-017 と DEF-019 は、変更するファイルが重ならないので、並行で行ってよい。

## サブタスク一覧

| ID | 内容 | 依存 | 状態 |
| --- | --- | --- | --- |
| DEF-017 | `--headless` の説明に、設定を上書きすることを書く | なし | 完了 |
| DEF-019 | 1行の見出しの fixture の縦の寸法を `@font-face` で固定する | なし | 完了 |
| DEF-018 | 直さない（設計書 3.3） | - | 対応しない |

## DEF-017: `--headless` の説明

**変更するファイル**
- 変更: `src/presentation/messages.ts`（`CLI_OPTION_DESCRIPTIONS.headless.description`）
- テスト: `tests/unit/cli.test.ts`

**手順**
1. RED: `tests/unit/cli.test.ts` に、`--headed` と `--headless` の説明が、どちらも `browser.headed` を上書きすることを書いていることを確かめるテストを加える。使い方の表示（`--help`）で、`--headless` の次の行が `CLI_OPTION_DESCRIPTIONS.headless.description` であることも、既存の「lists --help with its Japanese description among the options of the usage」と同じ形で確かめる。`npx vitest run tests/unit/cli.test.ts` で、説明の確かめが失敗することを見る。
2. 最小実装: 説明の文を、設計書 3.1 の文に変える。
3. GREEN: `npx vitest run tests/unit/cli.test.ts`
4. 関連する検証: `npx vitest run tests/architecture tests/integration/cli.test.ts`、`npm run typecheck`

## DEF-019: 1行の見出しの fixture

**変更するファイル**
- 変更: `fixtures/site/layout-single-line-headings.html`
- 変更: `tests/integration/layout-accessibility.test.ts`（前提のコメントだけ）

**手順**
1. RED: `npx vitest run tests/integration/layout-accessibility.test.ts -t "compares the overshoot above and below"` が、前提の確かめ（`#heading-line-height-10` の合計が行の高さの4分の1を超えない）で失敗することを見る。
2. 最小実装: 設計書 3.2 のとおり、fixture に `@font-face`（`local()` の並びと、`ascent-override: 106%`、`descent-override: 44%`、`line-gap-override: 0%`）を加え、`.single-line-heading` の `font-family` をそれに変える。fixture のコメントも、寸法を固定している理由に合わせて直す。
3. GREEN: 同じコマンド。
4. テストのコメント（641〜644 行付近）を、設計書 3.2 のとおりに書き換える。assert は変えない。
5. 関連する検証: `npx vitest run tests/integration/layout-accessibility.test.ts`（ファイル全体。同じ fixture の「compares the overhang on the left and on the right」を含む）
