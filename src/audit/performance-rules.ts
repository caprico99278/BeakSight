import { formatDecimal, formatMilliseconds } from '../presentation/format.js';
import { judgedWebVitalsOf, POOR_WEB_VITAL_THRESHOLDS } from './performance-observation.js';
import type { AuditRule, FindingDraft, PageRuleInput } from './rule.js';
import { evidenceOfType } from './rule-helpers.js';

// AUD-6c: 「poor」の境界の値は、表示用モデルも使うので `performance-observation.ts` に移した（値は変えない）。今までの名前のまま公開し直す。
export { POOR_WEB_VITAL_THRESHOLDS };

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
const poorWebVitalRule = (ruleId: string, metric: WebVitalName, plainMessage: string): AuditRule => ({
  ruleId,
  version: RULE_VERSION,
  category: 'PERFORMANCE',
  severity: 'WARN',
  plainMessage,
  evaluate(input: PageRuleInput): readonly FindingDraft[] {
    const threshold = POOR_WEB_VITAL_THRESHOLDS[metric];
    const format = WEB_VITAL_FORMATS[metric];
    const drafts: FindingDraft[] = [];
    for (const record of evidenceOfType(input, 'performance')) {
      // EV-1: LCP は、scroll の段の前に読んだ値があれば、その値で判定する（`judgedWebVitalsOf` の 1 か所。測り直しはしない）。
      const vital = judgedWebVitalsOf(record.payload)?.[metric];
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
  poorWebVitalRule('POOR_LCP', 'LCP', 'ページのいちばん大きな中身が出るまでに、時間がかかりすぎています。見る人が、待たされます。'),
  poorWebVitalRule('POOR_FCP', 'FCP', 'ページを開いてから、最初に何かが表示されるまでに、時間がかかりすぎています。見る人が、待たされます。'),
  poorWebVitalRule('POOR_CLS', 'CLS', '表示の途中で、ページの部品が大きく動きます。読みにくかったり、押しまちがえたりすることがあります。'),
  poorWebVitalRule('POOR_TTFB', 'TTFB', 'ページを開いてから、サイトが返事をするまでに、時間がかかりすぎています。見る人が、待たされます。'),
  poorWebVitalRule('POOR_INP', 'INP', 'ボタンなどを押してから、画面が変わるまでに、時間がかかりすぎています。見る人が、うまく動かないと感じることがあります。'),
]);
