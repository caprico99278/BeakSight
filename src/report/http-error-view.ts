/**
 * AUD-7（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-7）: 4xx・5xx の指摘の区分と、Finding にしなかった応答の、表示用モデルの
 * 部品（呼ぶのは `view-model.ts` だけ。区分の決め方は `src/audit/http-error-classes.ts` の 1 か所で、ここは引くだけ）。
 * - 指摘の応答は、指摘が参照する network の Evidence の応答のうち、Rule が同じで、Finding にした区分（`EXPECTED_BRANCH` でない）で、URL が指摘の文に字句として
 *   現れるもの（BeakSight の遮断との関係の、対象の照らし方 `containsUrlToken` と同じ）。
 * - 画面の誤りの表示は、同じページ・ビューポートの、最終の試行の DOM の記録から読む（Rule と同じ `errorDisplayOfRecords`）。
 * - `COLLECTION_CAUSED` は、ここでは付けない（BeakSight の遮断との関係から、表示用モデルが付ける）。
 * - 事実（本文の要旨を含む）は、記録とバンドルにだけ出す（HTML の本文には出さない）。
 */
import {
  HTTP_ERROR_CLASS_RULE_IDS,
  classifiedHttpErrorsOf,
  errorDisplayOfRecords,
  strongestHttpErrorClass,
  type ClassifiedHttpError,
  type HttpErrorClass,
  type HttpErrorClassRuleId,
  type HttpErrorFacts,
  type HttpErrorRuleClass,
} from '../audit/http-error-classes.js';
import type { EvidenceId, Finding, PageAuditResult, PageId, RunSummary, ViewportProfile } from '../core/contracts.js';
import { earlierAttemptEvidenceIds } from './artifact-writer.js';
import { containsUrlToken } from './beaksight-block-relation.js';

/** 指摘の 1 つの応答（事実と、その応答の Rule が決めた区分）。 */
export type HttpErrorResponseView = HttpErrorFacts & { readonly errorClass: HttpErrorRuleClass };

/** 指摘の区分（まとめた応答のうち、いちばん強い区分。BeakSight の遮断と結び付く指摘は `COLLECTION_CAUSED`）と、応答の事実。 */
export interface HttpErrorFindingView {
  readonly errorClass: HttpErrorClass;
  readonly responses: readonly HttpErrorResponseView[];
}

/** Finding にしなかった（`EXPECTED_BRANCH`）応答の 1 つ。 */
export type HttpErrorNotCountedView = HttpErrorFacts & {
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  readonly ruleId: HttpErrorClassRuleId;
};

/** Finding にしなかった応答の数と事実（バンドルの `summary.json` にだけ出す）。 */
export interface HttpErrorsNotCountedView {
  readonly total: number;
  /** Rule ごとの数（0 件の Rule は持たない。`HTTP_ERROR_CLASS_RULE_IDS` の順）。 */
  readonly byRule: readonly { readonly ruleId: HttpErrorClassRuleId; readonly count: number }[];
  readonly responses: readonly HttpErrorNotCountedView[];
}

interface ClassifiedLoad {
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  readonly errors: readonly ClassifiedHttpError[];
}

const isClassRuleId = (ruleId: string): ruleId is HttpErrorClassRuleId => (HTTP_ERROR_CLASS_RULE_IDS as readonly string[]).includes(ruleId);

/**
 * MEM-4（DEF-266）: 4xx・5xx の区分を、ページを 1 つずつ足して集めるもの（ページを持たない。持つのは、最終の試行の network の Evidence ごとの、区分を付けた
 * 誤りの応答だけ。同じ ID の network の Evidence が 2 か所にある不正な Run では、先にあるもの）。
 */
export interface HttpErrorCollector {
  /** ページを足す（URL の発見の順に）。 */
  readonly addPage: (page: PageAuditResult) => void;
  /** 指摘の区分（区分を持つ Rule でない指摘・応答の文脈のない前の版の記録の指摘は `null`）。 */
  readonly findingViewOf: (finding: Finding) => HttpErrorFindingView | null;
  /** Finding にしなかった応答の数と事実。 */
  readonly notCounted: () => HttpErrorsNotCountedView;
}

/** 4xx・5xx の区分を集めるもの（`HttpErrorCollector`）を作る。 */
export function createHttpErrorCollector(run: Pick<RunSummary, 'retries'>): HttpErrorCollector {
  const loads = new Map<EvidenceId, ClassifiedLoad>();
  return {
    addPage: (page) => {
      const earlier = earlierAttemptEvidenceIds(run, page);
      const finalRecords = page.evidence.filter((record) => !earlier.has(record.evidenceId));
      for (const record of finalRecords) {
        if (record.type !== 'network' || loads.has(record.evidenceId)) {
          continue;
        }
        const errorDisplay = errorDisplayOfRecords(finalRecords.filter((candidate) => candidate.viewport === record.viewport));
        loads.set(record.evidenceId, { pageId: page.pageId, viewport: record.viewport, errors: classifiedHttpErrorsOf(record.payload, errorDisplay) });
      }
    },
    findingViewOf: (finding) => httpErrorFindingViewOf(loads, finding),
    notCounted: () => httpErrorsNotCountedOf(loads),
  };
}

/** 指摘の区分（区分を持つ Rule でない指摘・応答の文脈のない前の版の記録の指摘は `null`）。 */
function httpErrorFindingViewOf(loads: ReadonlyMap<EvidenceId, ClassifiedLoad>, finding: Finding): HttpErrorFindingView | null {
  if (!isClassRuleId(finding.ruleId)) {
    return null;
  }
  const responses = finding.evidenceRefs.flatMap((evidenceId) => (loads.get(evidenceId)?.errors ?? []).filter((error) =>
    error.ruleId === finding.ruleId && error.errorClass !== 'EXPECTED_BRANCH' && containsUrlToken(finding.message, error.facts.url)))
    .map(({ facts, errorClass }): HttpErrorResponseView => ({ ...facts, errorClass }));
  const errorClass = strongestHttpErrorClass(responses.map((response) => response.errorClass));
  return errorClass === null ? null : { errorClass, responses };
}

/** Finding にしなかった（`EXPECTED_BRANCH`）応答の数と事実（数えるのは、ここだけ。最終の試行の network の Evidence の応答の順）。 */
function httpErrorsNotCountedOf(loads: ReadonlyMap<EvidenceId, ClassifiedLoad>): HttpErrorsNotCountedView {
  const responses: HttpErrorNotCountedView[] = [];
  for (const { pageId, viewport, errors } of loads.values()) {
    for (const { ruleId, errorClass, facts } of errors) {
      if (errorClass === 'EXPECTED_BRANCH') {
        responses.push({ pageId, viewport, ruleId, ...facts });
      }
    }
  }
  const byRule = HTTP_ERROR_CLASS_RULE_IDS.flatMap((ruleId) => {
    const count = responses.filter((response) => response.ruleId === ruleId).length;
    return count === 0 ? [] : [{ ruleId, count }];
  });
  return { total: responses.length, byRule, responses };
}
