import type { WebVitalsEvidence } from '../core/evidence-types.js';
import { formatDecimal, formatMilliseconds } from '../presentation/format.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import { evidenceOfType } from './rule-helpers.js';

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

type WebVitalName = keyof typeof POOR_WEB_VITAL_THRESHOLDS;

/** 文言で値を書く書式（CLS は単位のない値、それ以外はミリ秒）。 */
const WEB_VITAL_FORMATS: Readonly<Record<WebVitalName, (value: number) => string>> = Object.freeze({
  LCP: formatMilliseconds,
  FCP: formatMilliseconds,
  CLS: (value: number) => formatDecimal(value),
  TTFB: formatMilliseconds,
  INP: formatMilliseconds,
});

const RULE_VERSION = 1;

/**
 * 指標が poor の境界を超えたら WARN を作る Rule。合成計測の値は環境に左右されるので、ERROR にしない。
 * 観測できなかった指標（`NOT_OBSERVED`・`UNSUPPORTED`）と、Web Vitals を収集できなかった Evidence からは、Finding を作らない。
 * 収集が `PARTIAL` でも、観測できた値は判定に使う。
 */
const poorWebVitalRule = (ruleId: string, metric: WebVitalName): AuditRule => ({
  ruleId,
  version: RULE_VERSION,
  category: 'PERFORMANCE',
  severity: 'WARN',
  evaluate(input: PageRuleInput): readonly FindingDraft[] {
    const threshold = POOR_WEB_VITAL_THRESHOLDS[metric];
    const format = WEB_VITAL_FORMATS[metric];
    const drafts: FindingDraft[] = [];
    for (const record of evidenceOfType(input, 'performance')) {
      const vital = record.payload.webVitals?.[metric];
      if (vital === undefined || vital.status !== 'OBSERVED' || !Number.isFinite(vital.value) || vital.value <= threshold) {
        continue;
      }
      drafts.push({
        ruleId,
        ruleVersion: RULE_VERSION,
        category: 'PERFORMANCE',
        severity: 'WARN',
        message: `${metric} の計測値が ${format(vital.value)} で、poor の境界 ${format(threshold)} を`
          + '超えています（合成計測の1回の値です）。',
        evidenceRefs: [record.evidenceId],
        identityFields: [],
      });
    }
    return drafts;
  },
});

/** 性能の page rule（T12c）の一覧。登録は `RULE_CATALOG`（`./rule-catalog.ts`）がまとめて行う。 */
export const PERFORMANCE_RULES: readonly AuditRule[] = Object.freeze([
  poorWebVitalRule('POOR_LCP', 'LCP'),
  poorWebVitalRule('POOR_FCP', 'FCP'),
  poorWebVitalRule('POOR_CLS', 'CLS'),
  poorWebVitalRule('POOR_TTFB', 'TTFB'),
  poorWebVitalRule('POOR_INP', 'INP'),
]);
