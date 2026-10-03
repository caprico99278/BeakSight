# T12a 実装報告（要約。設計者が保存）

## 結論

完了した。`npm run verify` は PASS した（42ファイル、1617件。build を含む）。

## 作った型のシグネチャ

```ts
// src/audit/rule.ts
interface PageRuleInput {
  readonly pageId: PageId;
  readonly pageUrl: NormalizedHttpUrlEvidence;
  readonly viewport: ViewportProfile;
  readonly evidence: readonly EvidenceRecord[];
}
interface FindingDraft {
  readonly ruleId: string;
  readonly ruleVersion: number;                  // 正の整数
  readonly category: FindingCategory;
  readonly severity: Severity;                   // 下書きの値を正とする
  readonly message: string;                      // 日本語。空は不可
  readonly evidenceRefs: readonly EvidenceId[];  // 1件以上。入力にある ID だけ
  readonly identityFields: readonly FindingFingerprintIdentityField[]; // { name, value }（src/core/ids.ts）
}
interface AuditRule {
  readonly ruleId: string;
  readonly version: number;
  readonly category: FindingCategory;
  readonly severity: Severity;                   // その Rule の既定の値
  evaluate(input: PageRuleInput): readonly FindingDraft[];
}

// src/audit/rule-catalog.ts
const freezeCatalog: (rules: readonly AuditRule[]) => readonly AuditRule[];
const RULE_CATALOG: readonly AuditRule[];

// src/audit/rule-engine.ts
interface RuleEngineOptions {
  readonly targetId: string;
  readonly firstFindingSequence: number;
  readonly catalog?: readonly AuditRule[];
}
interface RuleEvaluationFailure {
  readonly code: 'RULE_EVALUATION_FAILED';
  readonly ruleId: string;
  readonly message: string;
}
interface RuleEngineResult {
  readonly findings: readonly Finding[];
  readonly failures: readonly RuleEvaluationFailure[];
  readonly nextFindingSequence: number;
}
class RuleEngine {
  constructor(options: RuleEngineOptions);
  evaluate(input: PageRuleInput): RuleEngineResult;
}
```

- 各 Rule のファイルは、`export const TECHNICAL_RULES: readonly AuditRule[] = Object.freeze([]);` の形で配列を export する。
- Rule の評価の失敗を表す理由のコードとして、`RULE_EVALUATION_FAILED` を加えた。

## 実装者の判断と、設計者の判断

1. ビューポートは、Engine が `identityFields` に `{ name: 'viewport', value }` を加えて、fingerprint に含める。→ 承認する。
   - `viewport` は Engine の予約名にする。Rule が `viewport` の名前の同一性の要素を返した場合は、その Rule の失敗とする。
   - この決まりは、T12a2 で、Cross-page rule と共有する関数に移す。
2. 下書きの ruleId が Rule の ruleId と一致するかは、検査していない。→ T12a2 で直す。
   - `AuditRule` に、任意の `ruleIdPrefix` を加える。
   - `ruleIdPrefix` を持たない Rule の下書きは、ruleId が Rule の ruleId と一致しなければならない。
   - `ruleIdPrefix` を持つ Rule（`A11Y_` の axe の Rule）の下書きは、ruleId がその接頭辞で始まらなければならない。
   - Catalog は、ほかの Rule の ruleId が、ある Rule の接頭辞で始まらないことを検査する。
3. 下書きの形の検査（空の ruleId など）に通らない下書きは、その Rule の失敗として扱う。→ 承認する。
4. `evidenceRefs` の重複を除き、コード単位の順に並べ替える。→ 承認する。入力の順序に左右されないことを優先する。
5. 同じ fingerprint の下書きは、失敗にしない。並び順は、文言と Evidence の参照でも決める。→ 承認する。
6. 本物の Rule も、Evidence がない入力で例外を投げてはいけない。→ 承認する。T12b〜T12d の指示書に書く。
7. 失敗の文字列は英語にする。→ 承認する。利用者に見せる文は、理由のコードをもとに、表示のカタログで作る（UI追補設計書）。
