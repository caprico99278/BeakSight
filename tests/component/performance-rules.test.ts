import { describe, expect, it } from 'vitest';
import { PERFORMANCE_RULES, POOR_WEB_VITAL_THRESHOLDS } from '../../src/audit/performance-rules.js';
import type { AuditRule, PageRuleInput } from '../../src/audit/rule.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import type { EvidenceRecord, ViewportProfile } from '../../src/core/contracts.js';
import type {
  NormalizedHttpUrlEvidence,
  UnobservedWebVitalStatus,
  WebVitalEvidence,
  WebVitalsEvidence,
} from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';

const PAGE_ID = createPageId(9);
const PAGE_URL = 'http://127.0.0.1:4173/performance-rules/page' as NormalizedHttpUrlEvidence;

const observed = <T>(value: number): WebVitalEvidence<T> => ({
  status: 'OBSERVED',
  value,
  id: 'v5-1',
  navigationType: 'navigate',
  attribution: null,
});

const unobserved = <T>(status: UnobservedWebVitalStatus = 'NOT_OBSERVED'): WebVitalEvidence<T> => ({
  status,
  value: null,
  id: null,
  navigationType: null,
  attribution: null,
});

const allUnobserved = (): WebVitalsEvidence => ({
  CLS: unobserved(),
  FCP: unobserved(),
  INP: unobserved(),
  LCP: unobserved(),
  TTFB: unobserved(),
});

const performanceRecord = (
  webVitals: WebVitalsEvidence | null,
  options: { readonly partial?: boolean; readonly sequence?: number; readonly viewport?: ViewportProfile } = {},
): EvidenceRecord => {
  const facts = {
    webVitals,
    navigationTiming: null,
    resources: [],
    resourceSummaries: null,
    resourceCoverage: null,
    serverTiming: [],
    telemetryHeaders: [],
    telemetryCandidates: [],
    truncation: null,
  };
  return {
    evidenceId: createEvidenceId('performance', options.sequence ?? 1),
    type: 'performance',
    pageId: PAGE_ID,
    viewport: options.viewport ?? 'desktop',
    observedAt: '2026-09-24T00:00:00.000Z',
    payload: options.partial === true
      ? { ...facts, status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED' }
      : { ...facts, status: 'COMPLETE', reason: 'COLLECTED' },
  };
};

const input = (evidence: readonly EvidenceRecord[], viewport: ViewportProfile = 'desktop'): PageRuleInput => ({
  pageId: PAGE_ID,
  pageUrl: PAGE_URL,
  viewport,
  evidence,
});

const ruleById = (ruleId: string): AuditRule => {
  const rule = PERFORMANCE_RULES.find((candidate) => candidate.ruleId === ruleId);
  expect(rule, `${ruleId} が PERFORMANCE_RULES に登録されていること`).toBeDefined();
  return rule as AuditRule;
};

const CASES = [
  { ruleId: 'POOR_LCP', metric: 'LCP', threshold: 4000, poor: 4001, boundary: 4000, text: ['4001 ms', '4000 ms'] },
  { ruleId: 'POOR_FCP', metric: 'FCP', threshold: 3000, poor: 3250.5, boundary: 3000, text: ['3250.5 ms', '3000 ms'] },
  { ruleId: 'POOR_CLS', metric: 'CLS', threshold: 0.25, poor: 0.31, boundary: 0.25, text: ['0.31', '0.25'] },
  { ruleId: 'POOR_TTFB', metric: 'TTFB', threshold: 1800, poor: 2400, boundary: 1800, text: ['2400 ms', '1800 ms'] },
  { ruleId: 'POOR_INP', metric: 'INP', threshold: 500, poor: 640, boundary: 500, text: ['640 ms', '500 ms'] },
] as const;

describe('PERFORMANCE_RULES', () => {
  it('設計書 5.2 の5つの Rule が、category PERFORMANCE・severity WARN で登録され、しきい値が表のとおりである', () => {
    expect(PERFORMANCE_RULES.map((rule) => rule.ruleId).sort()).toEqual(CASES.map(({ ruleId }) => ruleId).sort());
    for (const { ruleId, metric, threshold } of CASES) {
      expect(ruleById(ruleId)).toMatchObject({ category: 'PERFORMANCE', severity: 'WARN', version: 1 });
      expect(POOR_WEB_VITAL_THRESHOLDS[metric]).toBe(threshold);
    }
  });

  it('Evidence がない入力や、Web Vitals のない Evidence からは、例外を投げずに Finding を作らない', () => {
    for (const rule of PERFORMANCE_RULES) {
      expect(rule.evaluate(input([]))).toEqual([]);
      expect(rule.evaluate(input([performanceRecord(null)]))).toEqual([]);
    }
  });

  for (const { ruleId, metric, poor, boundary, text } of CASES) {
    describe(ruleId, () => {
      it(`${metric} が poor の境界を超えると、値としきい値を含む WARN を作る`, () => {
        const record = performanceRecord({ ...allUnobserved(), [metric]: observed(poor) });
        const drafts = ruleById(ruleId).evaluate(input([record]));
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({
          ruleId,
          ruleVersion: 1,
          category: 'PERFORMANCE',
          severity: 'WARN',
          evidenceRefs: [record.evidenceId],
          identityFields: [],
        });
        for (const fact of text) {
          expect(drafts[0]?.message).toContain(fact);
        }
      });

      it(`${metric} が poor の境界ちょうど以下なら、Finding を作らない`, () => {
        const record = performanceRecord({ ...allUnobserved(), [metric]: observed(boundary) });
        expect(ruleById(ruleId).evaluate(input([record]))).toEqual([]);
      });

      it(`${metric} が NOT_OBSERVED か UNSUPPORTED なら、Finding を作らない`, () => {
        const records = [
          performanceRecord({ ...allUnobserved(), [metric]: unobserved('NOT_OBSERVED') }, { sequence: 1 }),
          performanceRecord({ ...allUnobserved(), [metric]: unobserved('UNSUPPORTED') }, { sequence: 2 }),
        ];
        expect(ruleById(ruleId).evaluate(input(records))).toEqual([]);
      });
    });
  }

  it('PARTIAL の収集でも、観測できた値は判定に使う', () => {
    const record = performanceRecord({ ...allUnobserved(), LCP: observed(5200) }, { partial: true });
    expect(ruleById('POOR_LCP').evaluate(input([record]))).toHaveLength(1);
  });

  it('別のビューポートの Evidence は、判定に使わない', () => {
    const record = performanceRecord({ ...allUnobserved(), LCP: observed(5200) }, { viewport: 'mobile' });
    expect(ruleById('POOR_LCP').evaluate(input([record]))).toEqual([]);
  });

  it('すべての下書きが Engine の検査に通る', () => {
    const record = performanceRecord({
      CLS: observed(0.5),
      FCP: observed(3500),
      INP: observed(800),
      LCP: observed(6000),
      TTFB: observed(2000),
    });
    const engine = new RuleEngine({ targetId: 'performance-rules-test', firstFindingSequence: 1, catalog: PERFORMANCE_RULES });
    const result = engine.evaluate(input([record]));
    expect(result.failures).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual(CASES.map(({ ruleId }) => ruleId).sort());
  });
});
