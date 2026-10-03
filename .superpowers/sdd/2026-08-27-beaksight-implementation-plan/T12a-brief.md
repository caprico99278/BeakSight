# T12a 指示書: Rule の契約、Rule Catalog、Rule Engine

最初に `.superpowers/sdd/2026-08-27-beaksight-implementation-plan/implementer-common-rules.md` を読み、そのルールに従ってください。

## サブタスク

- ID: T12a
- 目的: Task 12 の土台として、次の3つを作る。
  - Rule の契約（型）
  - 唯一の登録先 `RULE_CATALOG`
  - Rule を評価して Finding を作る `RuleEngine`
- 設計書: `doc/design/2026-09-23-beaksight-task-12-13-rules-design.md` の第3章と第6章
- 実装計画: `doc/design/2026-09-23-beaksight-task-12-13-rules-implementation-plan.md` の T12a と「Rule Catalog の構造」
- 上位の計画: `doc/design/2026-08-27-beaksight-implementation-plan.md` の Task 12（Step 2）
- 型: `src/core/contracts.ts`（`Finding`、`FindingCategory`、`Severity`、`IncompleteReason`、`EvidenceRecord`）、`src/core/evidence-types.ts`、`src/core/ids.ts`（`createFindingId`、`createFindingFingerprint`）
- 型の整備の報告: 作業記録置き場の `C8-report.md`、`F05-report.md`

このサブタスクは単独で実行します。

## 変更してよいファイル

- 新規: `src/audit/rule.ts`、`src/audit/rule-catalog.ts`、`src/audit/rule-engine.ts`
- 新規（空の配列だけを export する）: `src/audit/technical-rules.ts`、`src/audit/layout-rules.ts`、`src/audit/accessibility-rules.ts`、`src/audit/performance-rules.ts`、`src/audit/safety-rules.ts`
- `src/core/contracts.ts`: Rule の評価の失敗を表す理由のコード（例: `RULE_EVALUATION_FAILED`）を `INCOMPLETE_REASON_CODES` に加える場合に限る。`schemas/run.schema.json` の理由のコードの一覧も、同じように合わせる。
- テスト: `tests/component/rule-engine.test.ts`（新規）、`tests/unit/core-contracts.test.ts`、`tests/unit/schema-validator.test.ts`（理由のコードの追加に伴う修正だけ）

## 作るもの

1. **`src/audit/rule.ts`**
   - `AuditRule` の型: `ruleId`、`version`（正の整数）、`category`（`FindingCategory`）、`severity`（`Severity`）、`evaluate(input: PageRuleInput): readonly FindingDraft[]`。
   - `FindingDraft` の型: `ruleId`、`ruleVersion`、`category`、`severity`、`message`（日本語）、`evidenceRefs`（1件以上の `EvidenceId`）、fingerprint の同一性の要素（安定した対象の識別子の配列）。ID と fingerprint は持たない。
   - `PageRuleInput` の型: ページのID、正規化したページのURL、ビューポート（`ViewportProfile`）、ID 付きの Evidence（`EvidenceRecord` の配列）。
   - A11Y のように、同じ Rule の severity が入力によって変わる場合は、`FindingDraft` の severity を正とする。`AuditRule.severity` は、その Rule の既定の値とする。
2. **`src/audit/rule-catalog.ts`**
   - `RULE_CATALOG` は、各 Rule のファイルが export する配列（`TECHNICAL_RULES` など）を読み込んで、1つにまとめる。
   - 同じ ruleId が2回登録されていたら、例外を投げる。
   - 結果は凍結する。
3. **`src/audit/rule-engine.ts`**
   - `RuleEngine.evaluate(input)` は、Catalog のすべての Rule を評価する。
   - Catalog は、引数か、コンストラクタへの DI で受け取れるようにする。本番の既定値は `RULE_CATALOG` とする。テスト用の仮の Rule を渡せるようにするためであり、第二の登録先は作らない。
   - Engine の処理は、次の順に行う。
     1. 各 `FindingDraft` の `evidenceRefs` が、入力の Evidence の ID に含まれていることを確かめる。含まれていなければ、その Rule の失敗として扱う。
     2. `createFindingFingerprint()` で fingerprint を付ける。対象は `targetId`、`ruleId`、正規化したページのURL、ビューポート、同一性の要素。`targetId` は Engine の生成時に DI で受け取る（`AuditConfig.target.id` から）。
     3. severity の順（ERROR、WARN、INFO、SAFETY の順。この順序は `src/core/contracts.ts` の `Severity` の値の配列から取るか、Engine の中の1か所に定数として置く）、ruleId、fingerprint の順に並べ替える。
     4. `createFindingId()` で Finding ID を振る。連番の開始値は DI で受け取る（Run 全体で一意にするため。パイプライン設計書 第3章の採番器）。
   - Rule が例外を投げた場合も、ほかの Rule の評価は続ける。失敗した Rule は、構造化された理由（ruleId と、上限付きのエラーの文字列）として、結果に含めて返す。
   - 出力は凍結する。
   - 入力の Evidence の順序を変えても、出力（Finding の順序、ID、fingerprint）が同じになる。

## 受け入れ条件

- テスト用の仮の Rule を使って、次のことを確かめるテストがある。いずれも、修正前に RED、修正後に GREEN になること。
  - 同じ ruleId の重複を例外にする。
  - Finding を決定論的に並べ替え、ID を振る。
  - 入力の順序を変えても、出力が同じになる。
  - Rule の例外を封じ込め、ほかの Rule の評価を続ける。
  - 存在しない Evidence を参照する Draft を、失敗として扱う。
  - fingerprint が `createFindingFingerprint()` の結果と一致する。
- 空の Rule のファイルが5つあり、`RULE_CATALOG` は空の配列として作られる。
- `npm run typecheck` が PASS する。
- `npm run verify` が PASS する（このサブタスクでは build を実行してよい）。

## 報告

共通ルールの形式で報告してください。T12b・T12c・T12d・T13 の実装者が使えるように、作った型のシグネチャを一覧にしてください。
