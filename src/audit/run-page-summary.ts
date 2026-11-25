/**
 * MEM-3b（DEF-266。設計書 `2026-11-13-beaksight-run-memory-scaling-design.md` 3 章の MEM-3。実装タスク指示 5 章の `Run page storage`）: Run のページの要約の、型と
 * 作り方の唯一の owner。Run Coordinator は、ページを終えたときに本体（`PageAuditResult`）から要約を作り、本体は圧縮して置き場所
 * （`src/core/run-page-store.ts`）に入れる。Run の終わりの集計（Run の Finding、数え上げ、Cross-page rule、止めた理由）は、要約だけから作る。
 * - 要約は、評価の形（再試行の前の試行の Evidence を除いたもの）から作る（数え上げと Cross-page rule の入力と同じ。設計書 5.6.4）。
 * - 数え上げの owner は `src/orchestration/run-aggregation.ts`、Cross-page rule の材料の取り出しの owner は `cross-page-rules.ts` の `crossPagePageFactsOf`。
 *   ここは、それぞれが読む項目を、本体から写すだけ（数えない・判定しない）。
 */
import type { EvidenceRecord, EvidenceRecordFor, PageAuditResult } from '../core/contracts.js';
import { crossPagePageFactsOf, type CrossPagePageFacts } from './cross-page-rules.js';

/**
 * ページの要約（生で持つもの）。ページの ID・URL・状態・理由・ビューポートの結果・Finding は本体のまま。
 * - `evidence`: Interaction の Evidence だけ（Interaction の結果の数え上げ `countInteractionOutcomes` が読む）。
 * - `crossPage`: Cross-page rule の材料（`crossPagePageFactsOf`）。
 */
export interface RunPageSummary extends Pick<PageAuditResult, 'pageId' | 'pageUrl' | 'status' | 'incompleteReasons' | 'viewports' | 'findings' | 'sameness'> {
  readonly evidence: readonly EvidenceRecordFor<'interaction'>[];
  /**
   * Cross-page rule の材料。取り出しが例外を投げた（壊れた Evidence）ときは、その例外（`failure`）を持つ。例外は、Run の終わりの Cross-page rule の段で
   * 投げ直す（`crossPageFactsOfSummary`。本体から評価していたときと同じ段の失敗にする）。
   */
  readonly crossPage: { readonly ok: true; readonly facts: CrossPagePageFacts } | { readonly ok: false; readonly failure: unknown };
}

const isInteractionRecord = (record: EvidenceRecord): record is EvidenceRecordFor<'interaction'> => record.type === 'interaction';

/** 材料の取り出し（例外は結果に持つ）。 */
const crossPageOf = (page: Parameters<typeof crossPagePageFactsOf>[0]): RunPageSummary['crossPage'] => {
  try {
    return { ok: true, facts: crossPagePageFactsOf(page) };
  } catch (failure) {
    return { ok: false, failure };
  }
};

/** ページの結果（評価の形）の要約（入力を変えない）。 */
export function runPageSummaryOf(page: PageAuditResult): RunPageSummary {
  return {
    pageId: page.pageId,
    pageUrl: page.pageUrl,
    status: page.status,
    incompleteReasons: page.incompleteReasons,
    viewports: page.viewports,
    findings: page.findings,
    evidence: page.evidence.filter(isInteractionRecord),
    crossPage: crossPageOf(page),
    // DUP: 軽い点検にしたか、点検を省いたページの記録（`run.json` の数に使う）。
    ...(page.sameness === undefined ? {} : { sameness: page.sameness }),
  };
}

/** 要約の Cross-page rule の材料。取り出しが失敗していたら、その例外を投げ直す。 */
export function crossPageFactsOfSummary(summary: RunPageSummary): CrossPagePageFacts {
  if (!summary.crossPage.ok) {
    throw summary.crossPage.failure;
  }
  return summary.crossPage.facts;
}

/**
 * 本体の Evidence の先頭に `records` を加えたとき（開始の URL のページの metadata の Evidence。設計書 5.6.2）の要約（加えた本体から作った要約と同じ）。
 */
export function runPageSummaryWithLeadingEvidence(summary: RunPageSummary, records: readonly EvidenceRecord[]): RunPageSummary {
  if (records.length === 0) {
    return summary;
  }
  const evidence = [...records.filter(isInteractionRecord), ...summary.evidence];
  if (!summary.crossPage.ok) {
    return { ...summary, evidence };
  }
  const leading = crossPageOf({ pageId: summary.pageId, pageUrl: summary.pageUrl, viewports: summary.viewports, evidence: records });
  if (!leading.ok) {
    return { ...summary, evidence, crossPage: leading };
  }
  const { facts } = summary.crossPage;
  return {
    ...summary,
    evidence,
    crossPage: {
      ok: true,
      facts: {
        ...facts,
        evidenceIds: [...leading.facts.evidenceIds, ...facts.evidenceIds],
        documents: [...leading.facts.documents, ...facts.documents],
        links: [...leading.facts.links, ...facts.links],
        networks: [...leading.facts.networks, ...facts.networks],
      },
    },
  };
}
