import type {
  EvidenceId,
  EvidenceRecord,
  FindingCategory,
  PageId,
  Severity,
  ViewportProfile,
} from '../core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../core/evidence-types.js';
import type { FindingFingerprintIdentityField } from '../core/ids.js';

/**
 * page rule の入力（Task 12・13 の設計書 第6章）。1ページ・1ビューポートの、ID 付きの Evidence と、ページの ID・URL・ビューポート。
 * Rule は、ここに含まれない情報を読まない。
 */
export interface PageRuleInput {
  readonly pageId: PageId;
  /** 正規化したページのURL（`PageAuditResult.pageUrl` と同じ値。fingerprint の対象になる）。 */
  readonly pageUrl: NormalizedHttpUrlEvidence;
  readonly viewport: ViewportProfile;
  readonly evidence: readonly EvidenceRecord[];
}

/**
 * Rule が返す Finding の下書き。Finding の ID と fingerprint は持たない（Rule Engine が付ける）。
 * `severity` は、この下書きの値を正とする（A11Y のように、入力によって同じ Rule の severity が変わる場合があるため）。
 */
export interface FindingDraft {
  readonly ruleId: string;
  /** 正の整数。 */
  readonly ruleVersion: number;
  readonly category: FindingCategory;
  readonly severity: Severity;
  /** 利用者向けの日本語の文言。判定に使った事実を含め、意味的・美的な断定を書かない。 */
  readonly message: string;
  /** 1件以上。すべて `PageRuleInput.evidence` の `evidenceId` のどれかであること。 */
  readonly evidenceRefs: readonly EvidenceId[];
  /**
   * fingerprint の同一性の要素（安定した対象の識別子。例: 資源のURL、selector、要素の id、axe のルールと target）。
   * targetId・ruleId・ruleVersion・ページのURL・ビューポートは `materializeFindingDrafts` が加えるので、ここには書かない。
   * 名前 `viewport` は予約名で、使うと検査の失敗になる。
   */
  readonly identityFields: readonly FindingFingerprintIdentityField[];
}

/**
 * page rule の契約。登録は `RULE_CATALOG`（`src/audit/rule-catalog.ts`）だけで行う。
 * ruleId の決まり（設計書 第6章）: `ruleIdPrefix` を持たない Rule の下書きは、ruleId が `ruleId` と一致すること。
 * `ruleIdPrefix` を持つ Rule の下書きは、ruleId がその接頭辞で始まり、かつ接頭辞より長いこと。反した場合は、その Rule の失敗になる。
 */
export interface AuditRule {
  readonly ruleId: string;
  /**
   * 評価のたびに ruleId を作る Rule（例: axe の結果を対応づける Rule）が持つ、下書きの ruleId の接頭辞。空でない文字列。
   * ほかの Rule の ruleId がこの接頭辞で始まってはならず、2つの Rule の接頭辞が互いに接頭辞の関係にあってもならない（`freezeCatalog` が検査する）。
   */
  readonly ruleIdPrefix?: string;
  /** 正の整数。判定を変えたら上げる。 */
  readonly version: number;
  readonly category: FindingCategory;
  /** この Rule の既定の severity。下書きの severity が異なる場合は、下書きの値を正とする。 */
  readonly severity: Severity;
  evaluate(input: PageRuleInput): readonly FindingDraft[];
}
