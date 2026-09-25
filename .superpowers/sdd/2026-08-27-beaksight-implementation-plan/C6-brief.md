# C6 指示書: layout の Evidence と性能の修正

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: C6
- 目的: レビュー指摘 V5（layout の分）、V8、V9（layout の分）を修正する。
- 設計書: `doc/design/2026-09-23-beaksight-foundation-corrections-design.md` の 5.4（layout の分）、5.6、5.8（layout の分）
- 実装計画: `doc/design/2026-09-23-beaksight-foundation-corrections-implementation-plan.md` の C6
- レビュー記録（指摘の詳細と再現条件）: 作業記録置き場（`.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`）の `task-06-10-review-2026-09-23.md`（V5、V8、V9）
- 共通部品: `doc/design/beaksight-shared-components.md`、`src/core/`（deadline・errors・guards・immutable・text・limits）、`src/evidence/visibility.ts`
- これまでの修正の報告: 作業記録置き場の `F01-report.md`、`F02a-report.md`、`F02b-report.md`、`F02c-report.md`、および `C4-report.md`、`C5-report.md`（layout-collector に、収集位置の記録と可視判定の変更が入っている）

このサブタスクは単独で実行します。

## 変更してよいファイル

- `src/evidence/layout-collector.ts`
- テスト: `tests/component/layout-collector.test.ts`、`tests/integration/layout-accessibility.test.ts`、および新規のテストファイル
- `fixtures/site/` への新しいページの追加

## 修正する内容

- **V8**（設計書 5.6）: `selectorFor` は、候補の件数の上限を確かめてから呼ぶ。兄弟の走査は、selector の深さと長さの上限の範囲に限る。16,000要素のページで、layout の収集が1秒以内に終わることを目安とし、テストで確かめる（CIの揺れを考え、テストのしきい値は実測の数倍にしてよいが、実測値を報告する）。再現条件: 2000要素で255ms、8000要素で2.5秒、16000要素で9.7秒（要素数の2乗で遅くなる）。
- **V8**（5.6）: layout の収集に期限を付ける（`src/core/deadline.ts`）。期限を過ぎた場合は、部分結果と理由を返す。
- **V8**（5.6）: `collectStressLayout` は、ある幅の収集が失敗しても、それまでの幅の結果を保持し、失敗した幅を理由付きで記録する。
- **V5（layout の分）**（5.4）: 可視の主要要素（見出し、段落、画像、ボタン、リンク、入力欄、固定要素）どうしの重なりの候補を、上限付きで記録する。重なりの記録には、visibility、position、z-index、overflow の事実を含める（設計書 §14.8）。固定要素については、固定要素の面積とビューポートの面積の比も記録する。どの重なりを Finding にするかは Rule（Task 12）が決めるので、collector は判定しない。
- **V9（layout の分）**（5.8）: 上限により切り捨てた場合は、切り捨てた件数か印を Evidence に残す。

## 受け入れ条件

- 上の各項目について、修正前に RED になるテストを先に書き、修正後に GREEN になる。レビュー記録の「実測」の条件を、テストの入力に使う。
- 担当範囲の既存のテストと、`npm run typecheck` が PASS する。
- 変更した Evidence の形を、報告に一覧で示す（C8 で型を整えるときに使う）。

## 報告

共通ルールの形式で報告してください。各項目（例: Q1、V4）ごとに、RED と GREEN の結果を示してください。
