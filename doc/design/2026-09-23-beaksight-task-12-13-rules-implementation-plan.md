# BeakSight Task 12・13 実装計画

設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md`
上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 12・13
作業記録置き場: `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/`

## 全体の制約

- 基盤修正の実装計画（`2026-09-23-beaksight-foundation-corrections-implementation-plan.md`）の「全体の制約」と同じ。とくに、Git の commit・push と HEAD に戻す操作の禁止、依存パッケージの追加の禁止、実サイトへのアクセスの禁止を守る。
- Rule は Evidence だけを入力にし、ブラウザを操作しない。
- `RULE_CATALOG` への登録は、`src/audit/rule-catalog.ts` だけが行う。
- Finding の文言は日本語。意味的・美的な断定を書かない。

## Rule Catalog の構造（競合を避けるため）

`src/audit/rule-catalog.ts` は、Rule のファイルごとに export された配列を読み込んで、1つの `RULE_CATALOG` にまとめる。

```ts
// 構造の例
import { TECHNICAL_RULES } from './technical-rules.js';
import { LAYOUT_RULES } from './layout-rules.js';
import { ACCESSIBILITY_RULES } from './accessibility-rules.js';
import { PERFORMANCE_RULES } from './performance-rules.js';
import { SAFETY_RULES } from './safety-rules.js';

export const RULE_CATALOG = freezeCatalog([
  ...TECHNICAL_RULES,
  ...LAYOUT_RULES,
  ...ACCESSIBILITY_RULES,
  ...PERFORMANCE_RULES,
  ...SAFETY_RULES,
]);
```

`freezeCatalog` は、同じ ruleId の重複を検出したら例外を投げる。T12a で、各 Rule のファイルを空の配列で作っておく。その後のサブタスクは、それぞれ自分の担当の Rule のファイルの中だけを埋める。

## サブタスク一覧と実行順

| 順 | ID | 内容 | 設計書 | 変更してよい production ファイル | 並列 |
| --- | --- | --- | --- | --- | --- |
| 1 | T12a | Rule の契約、Rule Catalog、Rule Engine | 第3章、第6章 | `src/audit/rule.ts`、`rule-catalog.ts`、`rule-engine.ts`（新規）、空の配列を export する `technical-rules.ts`・`layout-rules.ts`・`accessibility-rules.ts`・`performance-rules.ts`・`safety-rules.ts`（新規） | 単独 |
| 2 | T12b | technical rule（HTTP、LINK のうちページ単位のもの、RESOURCE、JAVASCRIPT、DOM、FORM） | 5.1 | `src/audit/technical-rules.ts` | T12c・T12d・T13 と並列 |
| 2 | T12c | layout・accessibility・performance の Rule | 5.1〜5.3 | `src/audit/layout-rules.ts`、`accessibility-rules.ts`、`performance-rules.ts` | T12b・T12d・T13 と並列 |
| 2 | T12d | safety rule | 5.4 | `src/audit/safety-rules.ts` | T12b・T12c・T13 と並列 |
| 2 | T13 | Cross-page rule（`BROKEN_INTERNAL_LINK` と `TARGET_NAVIGATION_FAILED` を含む） | 第7章 | `src/audit/cross-page-rules.ts`（新規） | T12b・T12c・T12d と並列 |
| 3 | R12 | 独立レビュー | 第10章 | なし | - |

各サブタスクのテストは、対応するテストファイル（`tests/component/<ファイル名>.test.ts`）に書く。

## 各サブタスクの受け入れ条件

### T12a

- `AuditRule`、`FindingDraft`、`PageRuleInput` の型。`PageRuleInput` は、C8 で整えた Evidence の型を使う。
- `RULE_CATALOG` は、同じ ruleId の重複を例外にする（テストで確かめる）。
- `RuleEngine.evaluate(input)`:
  - `RULE_CATALOG` のすべての Rule を評価する。
  - `createFindingFingerprint()` で fingerprint を付ける。
  - 決定論的な順序で並べ替えてから、Finding ID を振る。
  - Rule が例外を投げても、ほかの Rule の評価を続け、失敗を構造化された理由として返す。
  - 入力の Evidence の順序が変わっても、出力が同じになる。
- これらを、テスト用の仮の Rule を注入したテストで確かめる。Engine がテスト用の Rule を受け取れるように、Catalog を引数で渡せる形にしてよい（本番の入口では `RULE_CATALOG` を既定値にする。第二の登録先は作らない）。

### T12b・T12c・T12d

- 設計書の該当する表の Rule が、すべて実装され、登録されている。
- 各 Rule について、成立する Evidence と成立しない Evidence の両方でテストする。
- 観測できなかった値から、Finding を作らない。
- 「交通事故」というリンク文言で `/symptoms` を指すリンクが、Finding にならないことをテストする（T12b）。
- layout の判定の定数の値と、その根拠を報告する（T12c）。

### T13

- `evaluateCrossPageRules(input)` だけが入口。
- 入力の順序が、出力の順序と fingerprint に影響しない。
- リンク先が監査されていない場合は、Finding を作らず、その件数を返す。
- sitemap との違いだけで ERROR にしない。

### R12

- Task 12・13 の独立レビュー（仕様と品質）で、Critical 0・Important 0 にする。
- `npm run verify` が PASS する。
