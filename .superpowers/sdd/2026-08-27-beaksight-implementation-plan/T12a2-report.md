# T12a2 実装報告（要約。設計者が保存）

## 結論

完了した。実装者の報告では、`npm run verify` が PASS した（42ファイル、1631件。build を含む）。

## 変更後の型のシグネチャ（T12b〜T12d、T13 の実装者向け）

```ts
// src/audit/rule.ts（PageRuleInput と FindingDraft は、T12a から変わっていない）
interface AuditRule {
  readonly ruleId: string;
  readonly ruleIdPrefix?: string;   // 空でない文字列。例: 'A11Y_'
  readonly version: number;
  readonly category: FindingCategory;
  readonly severity: Severity;
  evaluate(input: PageRuleInput): readonly FindingDraft[];
}

// src/audit/rule-engine.ts
interface FindingDraftContext {
  readonly pageId: PageId | null;
  readonly pageUrl: NormalizedHttpUrlEvidence | null;
  readonly viewport: ViewportProfile | null;  // null でなければ、予約名 viewport として fingerprint に含める
}
type FindingDraftOwner = Pick<AuditRule, 'ruleId' | 'ruleIdPrefix'>;   // AuditRule をそのまま渡せる
interface FindingDraftEntry {
  readonly owner: FindingDraftOwner;
  readonly context: FindingDraftContext;
  readonly draft: FindingDraft;
}
interface MaterializeFindingDraftsOptions {
  readonly targetId: string;
  readonly firstFindingSequence: number;
  readonly evidenceIds: ReadonlySet<string>;
  readonly drafts: readonly FindingDraftEntry[];
}
interface MaterializeFindingDraftsResult {
  readonly findings: readonly Finding[];
  readonly failures: readonly RuleEvaluationFailure[];   // 1つの Rule につき1件。ruleId の順
  readonly nextFindingSequence: number;
}
const materializeFindingDrafts: (options: MaterializeFindingDraftsOptions) => MaterializeFindingDraftsResult;
type RuleEngineResult = MaterializeFindingDraftsResult;
class RuleEngine { constructor(options: RuleEngineOptions); evaluate(input: PageRuleInput): RuleEngineResult; }
```

- `freezeCatalog` は、次の場合に例外を投げる。
  - 接頭辞が空の場合
  - ほかの Rule の ruleId が、ある Rule の接頭辞で始まる場合
  - 2つの接頭辞が、互いに接頭辞の関係にある場合
- Cross-page rule は、`owner` に、自分の Rule（ruleId）を渡す。ビューポートによらない Finding では、`context.viewport` を null にする。

## 実装者の判断と、設計者の判断

1. 失敗は、Rule を単位にする。1件でも検査に通らない下書きがあれば、その Rule の下書きはすべて捨てる。→ 承認する（T12a と同じ決まり）。
2. ruleId の決まりも、`materializeFindingDrafts` の中で検査する。Cross-page rule も同じ検査を受け、失敗は `RULE_EVALUATION_FAILED` で返す。→ 承認する。
3. 予約名 `viewport` は、文脈のビューポートが null の場合も拒否する。→ 承認する。
4. 文脈（pageId、pageUrl、viewport）は、呼び出し側を信頼し、実行時には検査しない。→ 承認する。呼び出し側は、型付きの Page Auditor と Cross-page の入口の2つだけである。
