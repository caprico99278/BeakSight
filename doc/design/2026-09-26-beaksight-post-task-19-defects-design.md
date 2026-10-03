# BeakSight Task 19 の後の不具合の修正（DEF-017・DEF-018・DEF-019） 設計書

作成日: 2026-09-26
状態: 実装済み（ユーザーの指示「このクラウドのセッションで進められる範囲で進めて」（2026-09-26）による）
対象範囲: Task 19 の検証で見つかった3件の不具合のうち、実サイトに接続せずに扱えるものの修正と、扱わないものの判断。

## 1. 目的

Task 19 の検証（Windows とクラウドの環境）で、次の3件を不具合の台帳に登録した。

- DEF-017: `--headless` の使い方の説明に、設定の `browser.headed` を上書きすることが書かれていない。
- DEF-018: `tests/unit/schema-validator.test.ts` の一部が、Chromium を起動する。
- DEF-019: `tests/integration/layout-accessibility.test.ts` の1件が、Windows のフォント（Meiryo など）の寸法を前提にしていて、Linux の環境で前提の確かめに失敗する。

この設計で、DEF-017 と DEF-019 を直し、DEF-018 は直さないと決める。DEF-019 を直すと、Windows 以外の環境でも、全体の verify の結果が Windows と同じになる。

## 2. 根拠となる文書と優先順位

- 従う文書: `2026-08-27-beaksight-implementation-tasks.md`、`2026-09-23-beaksight-ui-ssot-design.md`（利用者に見せる文言の置き場所）、`2026-09-25-beaksight-task-19-fixture-full-crawl-readme-design.md`（README の CLI の説明）。
- この設計書が置き換える箇所: なし。
- 引き続き守る不変条件:
  - CLI の利用者向けの文言は `src/presentation/messages.ts` だけが持つ（UI 追補設計書）。
  - テストを削除・弱体化・skip にしない。前提が崩れた環境では、skip にせず目に見える形で失敗させる（RT12r3 の m2）。
  - テストの Chromium は headless だけで起動する。

## 3. 採用する設計

### 3.1 DEF-017（`--headless` の説明）

`CLI_OPTION_DESCRIPTIONS.headless.description` を、`--headed` の説明と同じ形にそろえ、設定を上書きすることを書く。

- 変更後の文: `ブラウザの画面を表示せずに実行します。設定の browser.headed を上書きします。--headed と同時には指定できません。`
- README の表（`README.md` 49 行）は、すでにこの意味で書いてあるので変えない。
- コードの振る舞い（`src/cli/arguments.ts` の上書き）は変えない。

### 3.2 DEF-019（フォントに依存しない fixture）

`fixtures/site/layout-single-line-headings.html` の見出しに、行の縦の寸法を固定した `@font-face` を使う。

- `@font-face` の `src` に、環境ごとの一般的なフォントを `local()` で並べる（`Meiryo`、`Yu Gothic`、`Noto Sans JP`、`Segoe UI`、`DejaVu Sans`、`Liberation Sans`、`Arial`）。どれか1つが見つかれば、その字形を使う。
- 同じ `@font-face` に `ascent-override: 106%`、`descent-override: 44%`、`line-gap-override: 0%` を指定する。これで、行の矩形（フォントの内容領域）の高さが、実際の字形によらず、フォントの大きさの 1.5 倍になる。106% と 44% は、これまで前提にしてきた Meiryo の寸法（約 1.06 と約 0.44）に合わせた値である。
- 設計者の実験（2026-09-26、クラウドの環境、DejaVu Sans、32 px）で、次を確かめた。行の高さは 48 px、4分の1は 12 px。

  | 見出し | 上に出た量 | 下に出た量 | 合計 |
  | --- | --- | --- | --- |
  | `#heading-line-height-10` | 8 px | 8 px | 16 px |
  | `#heading-line-height-11` | 7 px | 6 px | 13 px |
  | `#heading-with-rule` | 7 px | 6 px | 13 px |

  どれも、合計は 12 px を超え、片側ずつは 12 px 以下で 0 より大きい。これはテストの前提のとおりである。同じ fixture を、指定の前（DejaVu Sans のまま）で測ると、行の高さは 36 px で、合計は 1〜4 px だった（前提が崩れる）。
- テストの前提の確かめ（`layout-accessibility.test.ts` 641〜655 行付近）は残す。コメントは、「Windows の既定のフォントを前提にする」から、「fixture の `@font-face` で縦の寸法を固定している。`local()` のどのフォントもない環境では前提が崩れ、ここで目に見える形で失敗する」に書き換える。
- 採用しなかった案:
  - フォントのファイルを fixture に同梱する: 第三者のファイルを加えることになり、ライセンスの確認とユーザーの承認が要る。`local()` と寸法の指定で足りる。
  - 前提が崩れたら skip にする: RT12r3 の m2 の決定に反する。

### 3.3 DEF-018（直さない）

直さない。理由は次のとおり。

- `npm run test:unit` の対象は `tests/unit` と `tests/component` である。`tests/component` の4ファイル（`browser-settings`、`dom-collector`、`visibility`、`context-factory`）は、もともと Chromium を起動する。`test:unit` は、ブラウザのない環境で動くことを約束していない。
- 対象の describe（「C8: real collector output from local fixtures」）は、同じファイルの `validPage` などの見本のデータ（約 800 行）を使う。別のファイルへ移すと、見本のデータの複製か、大きな切り出しが要る。得られるものに比べて、変更が大きい。
- Chromium のない環境での失敗は、Chromium を入れれば解消する（2026-09-26 のクラウドの verify で、このファイルは PASS した）。

DEF-018 は「対応しない（理由付き）」として台帳を閉じる。

## 4. 詳細設計

第3章のとおり。型、関数、状態の変更はない。

## 5. SSOTと安全性への影響

| 項目 | owner | この設計での扱い |
| --- | --- | --- |
| CLI の利用者向けの文言 | `src/presentation/messages.ts` | 文を1つ変える |
| 引数の解釈と設定の上書き | `src/cli/arguments.ts` | 変更なし |
| 見切れの判定の閾値 | `src/evidence/layout-collector.ts` の `LAYOUT_THRESHOLDS` | 変更なし（テストは引き続き定義元を参照する） |

`src/**` に target 固有の情報は入らない。安全性の振る舞いは変わらない。

## 6. 共通部品と共通仕様

| 区分 | 名前 | 置き場所 | この設計での扱い |
| --- | --- | --- | --- |
| 利用する既存の部品 | `CLI_OPTION_DESCRIPTIONS` | `src/presentation/messages.ts` | 文を変える |
| 利用する既存の部品 | `LAYOUT_THRESHOLDS.clippedTextLineMinOutsideRatio` | `src/evidence/layout-collector.ts` | 利用のみ |
| 新しく作る共通部品 | なし | - | - |

- 変更容易性の確認: CLI のオプションを1つ加えるときに変えるファイルは、これまでと同じ（`src/cli/arguments.ts` と `src/presentation/messages.ts`）。

## 7. テスト設計

- DEF-017: `tests/unit/cli.test.ts` に、`--headless` と `--headed` の説明が、どちらも設定の `browser.headed` を上書きすることを書いていることを確かめるテストを加える（RED: 今の `--headless` の説明で失敗する）。あわせて、使い方の表示にその説明が出ることを、既存の使い方の表示のテストと同じ形で確かめる。
- DEF-019: 既存のテスト「compares the overshoot above and below a single line separately, and does not report the heading (I1)」が RED（Linux の環境で、前提の確かめの assert で失敗する）。fixture を変えて GREEN にする。同じ fixture を使う「compares the overhang on the left and on the right of a line separately (I1)」も PASS し続けること。

## 8. 対象ファイル

| パス | 責務 | 変更の種類 |
| --- | --- | --- |
| `src/presentation/messages.ts` | CLI の文言 | 変更（DEF-017） |
| `tests/unit/cli.test.ts` | CLI の単体テスト | 変更（DEF-017） |
| `fixtures/site/layout-single-line-headings.html` | 1行の見出しの fixture | 変更（DEF-019） |
| `tests/integration/layout-accessibility.test.ts` | layout の結合テスト | 変更（DEF-019。前提のコメントだけ） |

## 9. 対象外

- DEF-018 の移動（第 3.3 節の理由）。
- DEF-016（HTML でない 404 の Finding）。Task 20 の結果を見てから決める。
- Task 20・Task 21（実サイトへの接続。ユーザーの Windows の PC で行う）。
- README の変更（すでにコードの振る舞いに合っている）。

## 10. 完了条件

- [ ] `npx vitest run tests/unit/cli.test.ts` が PASS する。
- [ ] `npx vitest run tests/integration/layout-accessibility.test.ts` が、クラウドの環境（Linux）で PASS する。
- [ ] `npm run verify` が、クラウドの環境で PASS する（全件 PASS）。
- [ ] Windows での verify は、ユーザーの PC で Task 20 の前に行う（このセッションでは未実行として扱う）。

## 11. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-26 | 初版 | - | - |
