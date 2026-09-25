# T12c 指示書: layout・accessibility・performance の Rule

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## 共通の前提

- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md`
- 実装計画: `doc/design/2026-09-23-beaksight-task-12-13-rules-implementation-plan.md`
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 12・13
- Rule の契約: T12a で作った `src/audit/rule.ts`、`src/audit/rule-catalog.ts`、`src/audit/rule-engine.ts`。作業記録置き場の `T12a-report.md` と `T12a2-report.md` に、シグネチャの一覧がある。T12a2 の後の型を正とする。
- 本物の Rule は、Evidence がない入力でも、例外を投げてはいけない（T12a の既定の Engine のテストが、これを確かめる）。
- 下書きの ruleId は、Rule の ruleId と一致させる。同一性の要素の名前に、予約名 `viewport` を使わない（設計書 第6章）。
- Evidence の型: `src/core/evidence-types.ts`、`src/core/contracts.ts`
- Rule は、Evidence だけを入力にする。ブラウザを操作しない。意味的な判断や美的な判断を、Finding にしない。
- Finding の `message` は、日本語で書く。文言には、判定に使った事実（URL、ステータス、値としきい値など）を含める。
- 観測できなかった値（`NOT_OBSERVED`、`UNSUPPORTED`、null）から Finding を作らない。
- 判定に使う定数は、その Rule のファイルの中に、名前付きの定数として置く。
- 各 Rule について、成立する Evidence と成立しない Evidence の両方でテストする。テストは、`tests/component/<ファイル名>.test.ts` に書く。
- Rule の登録は、自分の担当のファイルが export する配列に加えるだけにする。`rule-catalog.ts` は変更しない。

同時に、ほかの実装者が別の Rule のファイルを実装しています。担当のファイル以外は変更しないでください。

## 変更してよいファイル

- `src/audit/layout-rules.ts`（`LAYOUT_RULES`）、`src/audit/accessibility-rules.ts`（`ACCESSIBILITY_RULES`）、`src/audit/performance-rules.ts`（`PERFORMANCE_RULES`）と、それぞれのテスト

## 実装する内容

設計書 5.1〜5.3 のうち、category が `LAYOUT`、`ACCESSIBILITY`、`PERFORMANCE` の Rule を実装する。

- **layout**: `ELEMENT_OVERLAP`、`CONTENT_COLLISION`、`OVERSIZED_FIXED_ELEMENT` の割合などの定数は、設計書 14.8（誤検知を避ける）に沿って決める。値と、そう決めた根拠を報告する。
- **layout**: 重なりの候補は、position・z-index・overflow・visibility の事実を考慮する。固定要素と、その子孫の重なりは、`FIXED_ELEMENT_OCCLUSION` か `OVERSIZED_FIXED_ELEMENT` で扱う。`ELEMENT_OVERLAP` の対象にはしない。
- **layout**: 収集が PARTIAL だった layout の Evidence も判定に使ってよい。ただし、収集されなかった部分について「問題なし」とはみなさない。
- **accessibility**: severity は、axe の impact の対応（設計書 5.3）で決める。`color-contrast` は `COLOR_CONTRAST_VIOLATION`、それ以外は `A11Y_<axeのルールIDを大文字の snake case にしたもの>` とする。`incomplete` は Finding にしない。
- **accessibility**: `A11Y_` で始まる Rule は、`ruleIdPrefix: 'A11Y_'` を持つ1つの Rule として実装する。`COLOR_CONTRAST_VIOLATION` は、別の Rule とする（設計書 第6章の ruleId の決まり）。
- **performance**: しきい値は、設計書 5.2 の表のとおりにする。観測できなかった指標からは、Finding を作らない。

## 受け入れ条件

- 担当の Rule が、すべて実装され、登録されている。
- 各 Rule について、成立する場合と成立しない場合のテストがある。修正前（実装前）に RED、実装後に GREEN になる。
- `npm run typecheck` と、担当のテストが PASS する。

## 報告

共通ルールの形式で報告してください。実装した Rule の一覧（ruleId、version、category、severity、判定の要点）を書いてください。
