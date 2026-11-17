/**
 * AUD-6c（整理の文書 `doc/design/2026-11-09-beaksight-audit-precision-triage.md` の AUD-6c）: 性能の値の境界と、遅い記録の時間の内訳の唯一の決め方（純粋な関数）。
 * - Web Vitals の「poor」の境界（`POOR_WEB_VITAL_THRESHOLDS`）は、ここに置く（性能の Rule と表示用モデルが同じ値を使う。Rule のファイルは表示用モデルから
 *   import できないため。ARCH07）。値は Task 12・13 の設計書 5.2 のまま。
 * - 遅い記録（設計者の判断 2026-11-10）: LCP・FCP・TTFB のどれかが、今の poor の境界を超えた記録。
 * - 時間の内訳（設計者の判断 2026-11-10。Resource Timing だけで決める。要求は増やさない）:
 *   - データの要求が始まるまでの待ち: 最初のデータの要求（資源の分類が `fetch-xhr`）の開始の時刻（文書の読み込みの始まりから）。
 *   - 通信そのものの時間: その要求の開始から、応答の終わりまで。
 */
import type { PerformanceEvidenceFacts, ResourceTimingEvidence, WebVitalsEvidence } from '../core/evidence-types.js';

/**
 * Web Vitals の「poor」の境界（Task 12・13 の設計書 5.2）。値がこの境界を超えると、その指標の Rule が WARN を作る。
 * web-vitals の `rating` は保存していないので、しきい値に照らした評価は、ここの値だけで行う。
 * CLS は単位のない値、それ以外はミリ秒。
 */
export const POOR_WEB_VITAL_THRESHOLDS = Object.freeze({
  LCP: 4000,
  FCP: 3000,
  CLS: 0.25,
  TTFB: 1800,
  INP: 500,
} as const satisfies Readonly<Record<keyof WebVitalsEvidence, number>>);

/** 遅い記録とみなす指標（読み込みの速さの指標。この順）。 */
export const SLOW_LOAD_METRICS = Object.freeze(['LCP', 'FCP', 'TTFB'] as const satisfies readonly (keyof WebVitalsEvidence)[]);
export type SlowLoadMetric = (typeof SLOW_LOAD_METRICS)[number];

/** データの要求とみなす資源の分類。 */
const DATA_RESOURCE_CATEGORY = 'fetch-xhr';

/**
 * EV-1（設計書 `2026-11-16-beaksight-finding-evidence-design.md` 3.1）: 判定に使う Web Vitals（唯一の決め方）。LCP は、scroll の段の前に読んだ値
 * （`lcpBeforeScroll`）があれば、その値に替える（スクロールで後から描かれた塊を数えない）。性能の Rule と表示用モデルの遅い記録が使う。
 * REV-SD2 の M-4: 前の値が観測できていない（`OBSERVED` でない）ときは替えない（後の値を未観測で消さない）。
 */
export const judgedWebVitalsOf = (payload: Pick<PerformanceEvidenceFacts, 'webVitals' | 'lcpBeforeScroll'>): WebVitalsEvidence | null =>
  (payload.webVitals === null || payload.lcpBeforeScroll?.status !== 'OBSERVED' ? payload.webVitals : { ...payload.webVitals, LCP: payload.lcpBeforeScroll });

/** 観測した値が、poor の境界を超えた読み込みの速さの指標（`SLOW_LOAD_METRICS` の順）。 */
export const slowLoadMetricsOf = (webVitals: WebVitalsEvidence | null): readonly SlowLoadMetric[] =>
  webVitals === null
    ? []
    : SLOW_LOAD_METRICS.filter((metric) => {
      const vital = webVitals[metric];
      return vital.status === 'OBSERVED' && Number.isFinite(vital.value) && vital.value > POOR_WEB_VITAL_THRESHOLDS[metric];
    });

/** 遅い記録の時間の内訳。 */
export interface PerformanceBreakdown {
  /** 最初のデータの要求が始まるまでの待ち（ms。文書の読み込みの始まりから）。データの要求がなければ `null`。 */
  readonly waitUntilFirstDataRequestMs: number | null;
  /** 最初のデータの要求と、その通信の時間（ms。開始から応答の終わりまで）。データの要求がなければ `null`。 */
  readonly firstDataRequest: { readonly url: string; readonly communicationMs: number } | null;
}

/** 資源の記録から、時間の内訳を作る（最初のデータの要求は、開始の時刻がいちばん早いもの。同じなら記録の順）。 */
export function performanceBreakdownOf(resources: readonly ResourceTimingEvidence[]): PerformanceBreakdown {
  let first: ResourceTimingEvidence | null = null;
  for (const resource of resources) {
    // 資源の分類（Resource Timing の種類。指摘の category ではない）。
    const { category: resourceCategory } = resource;
    if (resourceCategory === DATA_RESOURCE_CATEGORY && (first === null || resource.startTime < first.startTime)) {
      first = resource;
    }
  }
  if (first === null) {
    return { waitUntilFirstDataRequestMs: null, firstDataRequest: null };
  }
  return {
    waitUntilFirstDataRequestMs: first.startTime,
    firstDataRequest: { url: first.url, communicationMs: Math.max(0, first.responseEnd - first.startTime) },
  };
}
