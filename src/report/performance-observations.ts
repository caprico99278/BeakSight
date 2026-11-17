/**
 * AUD-6c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-6c）: 性能の値の観測の範囲の、表示用モデルの部品（呼ぶのは `view-model.ts`
 * だけ。バンドルの `summary.json` にだけ出す）。
 * - 単位は、各ページの最終の試行の performance の Evidence（再試行の前の試行のものは除く）。
 * - 測った段は、記録の段（`capture.phase`。前の版の記録は `null`）。観測の時間と測る前の操作は、記録の値（前の版の記録は `null`）。
 * - INP の状態は、記録のまま（未観測は `NOT_OBSERVED` のまま。0 や良い値にしない）。Web Vitals のない記録は `null`。
 * - 遅い指標と時間の内訳の決め方は `src/audit/performance-observation.ts` の 1 か所。内訳は、遅い記録だけに付ける。
 */
import {
  judgedWebVitalsOf,
  performanceBreakdownOf,
  slowLoadMetricsOf,
  type PerformanceBreakdown,
  type SlowLoadMetric,
} from '../audit/performance-observation.js';
import type { PageAuditResult, PageAuditStage, PageId, RunSummary, ViewportProfile } from '../core/contracts.js';
import type { PerformanceOperationsEvidence, WebVitalStatus } from '../core/evidence-types.js';
import { earlierAttemptEvidenceIds } from './artifact-writer.js';

/** 性能の記録 1 つの観測の範囲。 */
export interface PerformanceObservationView {
  readonly pageId: PageId;
  readonly viewport: ViewportProfile | null;
  readonly stage: PageAuditStage | null;
  readonly observedForMs: number | null;
  readonly operations: PerformanceOperationsEvidence | null;
  readonly inp: WebVitalStatus | null;
  readonly slowMetrics: readonly SlowLoadMetric[];
  /** 遅い記録の時間の内訳（遅くない記録は `null`）。 */
  readonly breakdown: PerformanceBreakdown | null;
}

/**
 * 1 つのページの観測の範囲（作るのは、ここだけ。記録の順）。MEM-4（DEF-266）: 表示用モデルが、ページを 1 つずつ足して、ページの順に並べる。
 */
export function performanceObservationsOfPage(run: Pick<RunSummary, 'retries'>, page: PageAuditResult): readonly PerformanceObservationView[] {
  const earlier = earlierAttemptEvidenceIds(run, page);
  const observations: PerformanceObservationView[] = [];
  for (const record of page.evidence) {
    if (record.type !== 'performance' || earlier.has(record.evidenceId)) {
      continue;
    }
    const { payload } = record;
    // EV-1: 判定に使う値（LCP は scroll の段の前の値。`judgedWebVitalsOf` の 1 か所）。
    const slowMetrics = slowLoadMetricsOf(judgedWebVitalsOf(payload));
    observations.push({
      pageId: page.pageId,
      viewport: record.viewport,
      stage: record.capture?.phase ?? null,
      observedForMs: payload.observedForMs ?? null,
      operations: payload.operationsBeforeMeasurement === undefined ? null : { ...payload.operationsBeforeMeasurement },
      inp: payload.webVitals?.INP.status ?? null,
      slowMetrics,
      breakdown: slowMetrics.length === 0 ? null : performanceBreakdownOf(payload.resources),
    });
  }
  return observations;
}
