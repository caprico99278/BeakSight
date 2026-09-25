# BeakSight Task 18 受け入れの Gate 実装計画

作成日: 2026-09-25
設計書: `doc/design/2026-09-25-beaksight-task-18-acceptance-gates-design.md`

## 1. 目的

設計書の第4章を、実装者1人が1回の起動で終えられる大きさのサブタスクに分けて行う。

## 2. サブタスクの分け方と順序

| ID | 内容 | 主に変えるファイル | 前提 |
| --- | --- | --- | --- |
| T18a | 足りない fixture と、DEF-010 | `fixtures/server.ts`、`fixtures/site/*`、`tests/integration/isolated-interaction.test.ts` | P18e |
| T18b | Safety の Gate（S01〜S10）と、終了コード 3 を最後まで通すこと | 新規 `tests/integration/safety-gates.test.ts`、`tests/helpers/`（補助の追加） | T18a |
| T18c | Auditor の Gate（A01〜A10） | 新規 `tests/integration/auditor-gates.test.ts` | T18a |
| T18d | Architecture の Gate（ARCH01〜08） | 新規 `tests/architecture/target-isolation.test.ts`、`tests/architecture/semantic-ownership.test.ts` | P18e |
| T18e | ARCH04 の違反の修正（`cross-page-rules.ts` を URL の owner の判定を使う形にする）と、DEF-011（UI Gate のコメントの除去の誤り。共通の走査を使う形にする） | `src/audit/cross-page-rules.ts`、`src/crawl/normalize-url.ts`（判定の関数を加える場合）、`tests/architecture/ui-ssot.test.ts`、`tests/architecture/source-scan.ts` | T18b、T18c、T18d |
| R18 | Task 18 のチェックポイントの独立レビュー | なし（読み取り専用） | T18e |

- T18b と T18c と T18d は、変えるファイルが重ならない。そのため、並行で行ってよい。
  - ただし、T18b と T18c が、同じ新しい補助を `tests/helpers/` に置く必要が出た場合は、衝突する。
  - そのため、T18b の指示書では、新しい補助を `tests/helpers/gate-harness.ts` に置くことにする。
  - T18c は、それを使わず、既存の補助だけを使う。必要なら、自分のファイルの中に置く。T18c の終了後に、設計者が重複を見て、共通化を判断する。
  - T18d は、テストのファイルだけで完結する。
- T18d は、`src/` を変えない。検査が違反を見つけた場合は、止まって報告する。違反の修正は、設計者が別のサブタスクにする。
- 並行で行う場合は、どの指示書にも、並行であることを書く。
  - どれも `npm run verify` を実行しない。verify は、設計者が行う。

## 3. 各サブタスクの要点

### T18a

- fixture を加える。
  - PATCH を送るページ（Passive と Interaction の両方で使えるもの）
  - Worker 自身が POST を試みる Service Worker と、それを登録するページ
  - `popup-target.html` と `navigation-target.html`
- DEF-010: `isolated-interaction.test.ts` の、ポップアップと移動の先の確認のパスを直す。
  - 直した確認が、修正の前の状態で意味を持つこと（ファイルがあれば GET が数えられる）を確かめる。
- 既存のテストが、変更なしで PASS すること。

### T18b

- 設計書 4.2 のとおり。
- サーバの境界で数える補助を、`tests/helpers/gate-harness.ts` に置く。
  - 例: 差分の数え方、パスでの絞り込み

### T18c

- 設計書 4.3 のとおり。
- 実行時間を抑えるため、1回の Run で、複数の Gate を確かめてよい。

### T18d

- 設計書 4.4 のとおり。
- `config/targets/*.json` は、読むだけである。対象のサイトには、アクセスしない。

### R18

- 実装タスク指示 第12章のチェックポイントのレビューである。
- Task 14〜18 の全体と、Task 18 の前の整理を、対象に含める。
- Critical 0・Important 0 の後、ユーザーの承認を得る。

## 4. 共通の受け入れ条件

- Gate のテストの名前に、Gate の ID をそのまま含める。
- 既存のテストを、弱めない。
- Architecture と UI の Gate の各ファイルは、1秒以内に終わる。
- `npm run verify` が PASS する。並行作業の場合は、設計者が実行する。

## 5. 設計変更履歴

| 日付 | 契機 | 変更内容 | 影響範囲 |
| --- | --- | --- | --- |
| 2026-09-25 | 初版 | - | Task 18 |
| 2026-09-25 | T18d の報告 | T18e を加えた（ARCH04 の違反と DEF-011） | T18e、R18 |
