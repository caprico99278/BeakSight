import { describe, expect, it } from 'vitest';
import { ACCESSIBILITY_RULES } from '../../src/audit/accessibility-rules.js';
import type { AuditRule, FindingDraft, PageRuleInput } from '../../src/audit/rule.js';
import { RuleEngine } from '../../src/audit/rule-engine.js';
import type { EvidenceRecord, ViewportProfile } from '../../src/core/contracts.js';
import type {
  AccessibilityEvidence,
  AccessibilityImpact,
  AccessibilityNodeEvidence,
  AccessibilityRuleEvidence,
  AccessibilityTargetSelector,
  NormalizedHttpUrlEvidence,
} from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';

const PAGE_ID = createPageId(5);
const PAGE_URL = 'http://127.0.0.1:4173/accessibility-rules/page' as NormalizedHttpUrlEvidence;

const node = (
  targetSelectors: readonly AccessibilityTargetSelector[],
  impact: AccessibilityImpact = null,
): AccessibilityNodeEvidence => ({
  impact,
  targetSelectors,
  failureSummary: 'Fix any of the following: ...',
  htmlSnippet: '<div>...</div>',
  truncated: false,
});

const axeRule = (
  ruleId: string,
  impact: AccessibilityImpact,
  nodes: readonly AccessibilityNodeEvidence[],
  omittedNodeCount = 0,
): AccessibilityRuleEvidence => ({
  ruleId,
  impact,
  help: `${ruleId} help`,
  helpUrl: `https://dequeuniversity.invalid/rules/${ruleId}`,
  tags: ['wcag2aa'],
  nodes,
  omittedNodeCount,
});

const accessibilityRecord = (
  violations: readonly AccessibilityRuleEvidence[],
  options: {
    readonly incomplete?: readonly AccessibilityRuleEvidence[];
    readonly partial?: boolean;
    readonly sequence?: number;
    readonly viewport?: ViewportProfile;
  } = {},
): EvidenceRecord => {
  const facts = {
    frameScope: 'SAME_ORIGIN_ONLY' as const,
    violations,
    incomplete: options.incomplete ?? [],
  };
  const payload: AccessibilityEvidence = options.partial === true
    ? { ...facts, status: 'PARTIAL', reason: 'DEADLINE_EXCEEDED', scrollPosition: null }
    : { ...facts, status: 'COMPLETE', scrollPosition: { scrollX: 0, scrollY: 0 } };
  return {
    evidenceId: createEvidenceId('accessibility', options.sequence ?? 1),
    type: 'accessibility',
    pageId: PAGE_ID,
    viewport: options.viewport ?? 'desktop',
    observedAt: '2026-09-24T00:00:00.000Z',
    payload,
  };
};

const input = (evidence: readonly EvidenceRecord[], viewport: ViewportProfile = 'desktop'): PageRuleInput => ({
  pageId: PAGE_ID,
  pageUrl: PAGE_URL,
  viewport,
  evidence,
});

const ruleById = (ruleId: string): AuditRule => {
  const rule = ACCESSIBILITY_RULES.find((candidate) => candidate.ruleId === ruleId);
  expect(rule, `${ruleId} が ACCESSIBILITY_RULES に登録されていること`).toBeDefined();
  return rule as AuditRule;
};

const contrastRule = (): AuditRule => ruleById('COLOR_CONTRAST_VIOLATION');
const axeViolationRule = (): AuditRule => {
  const rule = ACCESSIBILITY_RULES.find((candidate) => candidate.ruleIdPrefix === 'A11Y_');
  expect(rule, 'ruleIdPrefix A11Y_ の Rule が登録されていること').toBeDefined();
  return rule as AuditRule;
};

const identity = (draft: FindingDraft | undefined, name: string): string | undefined =>
  draft?.identityFields.find((field) => field.name === name)?.value;

describe('ACCESSIBILITY_RULES の登録', () => {
  it('COLOR_CONTRAST_VIOLATION と、ruleIdPrefix A11Y_ を持つ Rule の2つが、category ACCESSIBILITY で登録されている', () => {
    expect(ACCESSIBILITY_RULES).toHaveLength(2);
    expect(contrastRule()).toMatchObject({ category: 'ACCESSIBILITY', version: 1 });
    expect(contrastRule().ruleIdPrefix).toBeUndefined();
    expect(axeViolationRule()).toMatchObject({ ruleId: 'A11Y_AXE', category: 'ACCESSIBILITY', version: 1 });
  });

  it('Evidence がない入力からは、例外を投げずに Finding を作らない', () => {
    for (const rule of ACCESSIBILITY_RULES) {
      expect(rule.evaluate(input([]))).toEqual([]);
    }
  });
});

describe('COLOR_CONTRAST_VIOLATION', () => {
  it('axe の color-contrast の violation を、要素ごとに、impact の対応で決めた severity の Finding にする', () => {
    const record = accessibilityRecord([
      axeRule('color-contrast', 'serious', [node(['#muted-text'], 'serious'), node(['.note > span'], 'moderate')]),
    ]);
    const drafts = contrastRule().evaluate(input([record]));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      ruleId: 'COLOR_CONTRAST_VIOLATION',
      ruleVersion: 1,
      category: 'ACCESSIBILITY',
      severity: 'ERROR',
      evidenceRefs: [record.evidenceId],
    });
    expect(identity(drafts[0], 'target')).toBe('["#muted-text"]');
    expect(drafts[0]?.message).toContain('color-contrast');
    expect(drafts[0]?.message).toContain('#muted-text');
    expect(drafts[0]?.message).toContain('serious');
    expect(drafts[1]?.severity).toBe('WARN');
  });

  it('color-contrast 以外の violation と、incomplete は、COLOR_CONTRAST_VIOLATION にしない', () => {
    const record = accessibilityRecord([axeRule('image-alt', 'critical', [node(['img'])])], {
      incomplete: [axeRule('color-contrast', 'serious', [node(['#unknown-background'])])],
    });
    expect(contrastRule().evaluate(input([record]))).toEqual([]);
  });
});

describe('A11Y_ の Rule', () => {
  it('color-contrast 以外の violation を、A11Y_ と大文字の snake case の ruleId の Finding にする', () => {
    const record = accessibilityRecord([
      axeRule('image-alt', 'critical', [node(['img.hero'], 'critical')]),
      axeRule('landmark-one-main', 'moderate', [node(['html'], 'moderate')]),
      axeRule('region', 'minor', [node(['#footer-note'], 'minor')]),
      axeRule('aria-allowed-attr', null, [node([['#widget-host', 'button']], null)]),
      axeRule('color-contrast', 'serious', [node(['#muted'], 'serious')]),
    ]);
    const drafts = axeViolationRule().evaluate(input([record]));
    expect(drafts.map((draft) => [draft.ruleId, draft.severity])).toEqual([
      ['A11Y_IMAGE_ALT', 'ERROR'],
      ['A11Y_LANDMARK_ONE_MAIN', 'WARN'],
      ['A11Y_REGION', 'INFO'],
      ['A11Y_ARIA_ALLOWED_ATTR', 'WARN'],
    ]);
    expect(identity(drafts[3], 'target')).toBe('[["#widget-host","button"]]');
    expect(drafts[3]?.message).toContain('#widget-host');
    for (const draft of drafts) {
      expect(draft.category).toBe('ACCESSIBILITY');
    }
  });

  it('要素の impact がなければ、ルールの impact で severity を決める', () => {
    const record = accessibilityRecord([axeRule('button-name', 'serious', [node(['#icon-button'], null)])]);
    expect(axeViolationRule().evaluate(input([record]))[0]?.severity).toBe('ERROR');
  });

  it('記録された要素がない violation は、ルール単位の1件にし、記録しなかった件数を文言に含める', () => {
    const record = accessibilityRecord([axeRule('duplicate-id', 'minor', [], 3)]);
    const drafts = axeViolationRule().evaluate(input([record]));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.ruleId).toBe('A11Y_DUPLICATE_ID');
    expect(drafts[0]?.identityFields).toEqual([]);
    expect(drafts[0]?.message).toContain('3 件');
  });

  it('incomplete と、PARTIAL の収集で観測されなかったものからは、Finding を作らない', () => {
    const record = accessibilityRecord([], {
      incomplete: [axeRule('aria-hidden-focus', 'serious', [node(['#menu'])])],
      partial: true,
    });
    expect(axeViolationRule().evaluate(input([record]))).toEqual([]);
  });

  it('PARTIAL の収集でも、記録された violation は Finding にする', () => {
    const record = accessibilityRecord([axeRule('link-name', 'serious', [node(['a.icon'])])], { partial: true });
    expect(axeViolationRule().evaluate(input([record])).map((draft) => draft.ruleId)).toEqual(['A11Y_LINK_NAME']);
  });

  it('大文字の snake case にできない axe のルールID は、Finding にしない', () => {
    const record = accessibilityRecord([axeRule('---', 'serious', [node(['#x'])])]);
    expect(axeViolationRule().evaluate(input([record]))).toEqual([]);
  });

  it('別のビューポートの Evidence は、判定に使わない', () => {
    const record = accessibilityRecord([axeRule('image-alt', 'critical', [node(['img'])])], { viewport: 'mobile' });
    expect(axeViolationRule().evaluate(input([record]))).toEqual([]);
  });
});

describe('ACCESSIBILITY_RULES と Rule Engine', () => {
  it('すべての下書きが Engine の検査に通る', () => {
    const record = accessibilityRecord([
      axeRule('color-contrast', 'serious', [node(['#a'], 'serious')]),
      axeRule('image-alt', 'critical', [node(['img'], 'critical')]),
      axeRule('region', null, []),
    ]);
    const engine = new RuleEngine({
      targetId: 'accessibility-rules-test',
      firstFindingSequence: 1,
      catalog: ACCESSIBILITY_RULES,
    });
    const result = engine.evaluate(input([record]));
    expect(result.failures).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId).sort()).toEqual([
      'A11Y_IMAGE_ALT',
      'A11Y_REGION',
      'COLOR_CONTRAST_VIOLATION',
    ]);
  });
});
