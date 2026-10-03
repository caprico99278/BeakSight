import { describe, expect, it } from 'vitest';
import { ACCESSIBILITY_RULES } from '../../src/audit/accessibility-rules.js';
import { LAYOUT_RULES } from '../../src/audit/layout-rules.js';
import { PERFORMANCE_RULES } from '../../src/audit/performance-rules.js';
import type { AuditRule, FindingDraft, PageRuleInput } from '../../src/audit/rule.js';
import { RULE_CATALOG, freezeCatalog } from '../../src/audit/rule-catalog.js';
import {
  RuleEngine,
  materializeFindingDrafts,
  toRuleEvaluationFailure,
  type FindingDraftEntry,
} from '../../src/audit/rule-engine.js';
import { SAFETY_RULES } from '../../src/audit/safety-rules.js';
import { TECHNICAL_RULES } from '../../src/audit/technical-rules.js';
import type { EvidenceId, EvidenceRecord, Severity } from '../../src/core/contracts.js';
import type { ConsoleEvidence, NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createFindingFingerprint, createFindingId, createPageId } from '../../src/core/ids.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../../src/core/limits.js';

const TARGET_ID = 'rule-engine-fixture-target';
const PAGE_ID = createPageId(7);
const PAGE_URL = 'http://127.0.0.1:4173/rule-engine/page' as NormalizedHttpUrlEvidence;

const evidenceRecord = (sequence: number): EvidenceRecord => ({
  evidenceId: createEvidenceId('console', sequence),
  type: 'console',
  pageId: PAGE_ID,
  viewport: 'desktop',
  observedAt: '2026-09-24T00:00:00.000Z',
  // Rule Engine は payload を読まない。仮の Rule も evidenceId だけを使う。
  payload: {} as ConsoleEvidence,
});

const EVIDENCE: readonly EvidenceRecord[] = [evidenceRecord(1), evidenceRecord(2), evidenceRecord(3)];

const pageInput = (
  evidence: readonly EvidenceRecord[] = EVIDENCE,
  viewport: PageRuleInput['viewport'] = 'desktop',
): PageRuleInput => ({ pageId: PAGE_ID, pageUrl: PAGE_URL, viewport, evidence });

interface FakeRuleSpec {
  readonly ruleId: string;
  readonly ruleIdPrefix?: string;
  readonly severity?: Severity;
  readonly evaluate: (input: PageRuleInput) => readonly FindingDraft[];
}

const fakeRule = (spec: FakeRuleSpec): AuditRule => ({
  ruleId: spec.ruleId,
  ...(spec.ruleIdPrefix === undefined ? {} : { ruleIdPrefix: spec.ruleIdPrefix }),
  version: 1,
  category: 'DOM',
  severity: spec.severity ?? 'WARN',
  evaluate: spec.evaluate,
});

const draft = (
  ruleId: string,
  severity: Severity,
  evidenceRefs: readonly EvidenceId[],
  identityValue: string,
): FindingDraft => ({
  ruleId,
  ruleVersion: 1,
  category: 'DOM',
  severity,
  message: `${ruleId} の仮の Finding（${identityValue}）`,
  evidenceRefs,
  identityFields: [{ name: 'selector', value: identityValue }],
});

/** Evidence ごとに1件の下書きを、入力の Evidence の順に作る仮の Rule。 */
const perEvidenceRule = (ruleId: string, severity: Severity): AuditRule =>
  fakeRule({
    ruleId,
    severity,
    evaluate: (input) => input.evidence.map((record) => draft(ruleId, severity, [record.evidenceId], record.evidenceId)),
  });

const expectedFingerprint = (
  ruleId: string,
  identityValue: string,
  viewport: PageRuleInput['viewport'] = 'desktop',
): string =>
  createFindingFingerprint({
    targetId: TARGET_ID,
    ruleId,
    ruleVersion: 1,
    normalizedUrl: PAGE_URL,
    identityFields: [
      { name: 'selector', value: identityValue },
      { name: 'viewport', value: viewport },
    ],
  });

describe('freezeCatalog と RULE_CATALOG', () => {
  it('同じ ruleId が2回登録されたら、例外を投げる', () => {
    const first = perEvidenceRule('DUPLICATED_RULE', 'WARN');
    const second = perEvidenceRule('DUPLICATED_RULE', 'ERROR');

    expect(() => freezeCatalog([first, perEvidenceRule('OTHER_RULE', 'INFO'), second])).toThrow(/DUPLICATED_RULE/u);
  });

  it('version が正の整数でない Rule の登録は、例外を投げる', () => {
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => freezeCatalog([{ ...perEvidenceRule('BAD_VERSION_RULE', 'WARN'), version }])).toThrow(RangeError);
    }
  });

  it('ほかの Rule の ruleId が、ある Rule の ruleIdPrefix で始まる場合は、例外を投げる', () => {
    const prefixed = fakeRule({ ruleId: 'A11Y_AXE', ruleIdPrefix: 'A11Y_', evaluate: () => [] });
    const colliding = perEvidenceRule('A11Y_CONTRAST', 'WARN');

    expect(() => freezeCatalog([prefixed, colliding])).toThrow(/A11Y_CONTRAST/u);
    // 登録の順によらず検出する。
    expect(() => freezeCatalog([colliding, prefixed])).toThrow(/A11Y_CONTRAST/u);
  });

  it('2つの Rule の ruleIdPrefix が互いに接頭辞の関係にある場合は、例外を投げる', () => {
    const outer = fakeRule({ ruleId: 'AXE_RULE', ruleIdPrefix: 'A11Y_', evaluate: () => [] });
    const inner = fakeRule({ ruleId: 'OTHER_AXE_RULE', ruleIdPrefix: 'A11Y_AXE_', evaluate: () => [] });
    const same = fakeRule({ ruleId: 'SAME_PREFIX_RULE', ruleIdPrefix: 'A11Y_', evaluate: () => [] });

    expect(() => freezeCatalog([outer, inner])).toThrow(/A11Y_AXE_/u);
    expect(() => freezeCatalog([inner, outer])).toThrow(/A11Y_AXE_/u);
    expect(() => freezeCatalog([outer, same])).toThrow(/A11Y_/u);
  });

  it('ruleIdPrefix が空でない文字列でなければ、TypeError を投げる', () => {
    expect(() => freezeCatalog([fakeRule({ ruleId: 'EMPTY_PREFIX_RULE', ruleIdPrefix: '', evaluate: () => [] })])).toThrow(
      TypeError,
    );
  });

  it('接頭辞を持つ Rule 自身の ruleId が、自分の接頭辞で始まっていても受け入れる', () => {
    const catalog = freezeCatalog([
      fakeRule({ ruleId: 'A11Y_AXE', ruleIdPrefix: 'A11Y_', evaluate: () => [] }),
      fakeRule({ ruleId: 'PERF_AXE', ruleIdPrefix: 'PERF_OBSERVED_', evaluate: () => [] }),
      perEvidenceRule('HTTP_4XX', 'ERROR'),
    ]);

    expect(catalog.map((rule) => rule.ruleId)).toEqual(['A11Y_AXE', 'PERF_AXE', 'HTTP_4XX']);
  });

  it('登録済みの別の一覧を渡すと、その一覧との ruleId の重複と接頭辞の衝突も検査し、渡した一覧だけを返す', () => {
    const registered = freezeCatalog([
      fakeRule({ ruleId: 'A11Y_AXE', ruleIdPrefix: 'A11Y_', evaluate: () => [] }),
      perEvidenceRule('HTTP_4XX', 'ERROR'),
    ]);

    expect(() => freezeCatalog([perEvidenceRule('HTTP_4XX', 'WARN')], registered)).toThrow(/HTTP_4XX/u);
    expect(() => freezeCatalog([perEvidenceRule('A11Y_CROSS_PAGE', 'WARN')], registered)).toThrow(/A11Y_CROSS_PAGE/u);
    expect(() =>
      freezeCatalog([fakeRule({ ruleId: 'OTHER_AXE', ruleIdPrefix: 'A11Y_AXE_', evaluate: () => [] })], registered),
    ).toThrow(/A11Y_AXE_/u);
    // 渡した一覧の Rule の ruleId が、登録済みの一覧の Rule の接頭辞で始まる場合も、向きによらず検出する。
    expect(() =>
      freezeCatalog([fakeRule({ ruleId: 'PREFIXED', ruleIdPrefix: 'HTTP_', evaluate: () => [] })], registered),
    ).toThrow(/HTTP_4XX/u);

    const checked = freezeCatalog([perEvidenceRule('CROSS_PAGE_ONLY_RULE', 'INFO')], registered);
    expect(checked.map((rule) => rule.ruleId)).toEqual(['CROSS_PAGE_ONLY_RULE']);
    expect(Object.isFrozen(checked)).toBe(true);
  });

  it('凍結した一覧を、登録の順のまま返す', () => {
    const rules = [perEvidenceRule('SECOND_RULE', 'WARN'), perEvidenceRule('FIRST_RULE', 'ERROR')];
    const catalog = freezeCatalog(rules);

    expect(catalog.map((rule) => rule.ruleId)).toEqual(['SECOND_RULE', 'FIRST_RULE']);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.every((rule) => Object.isFrozen(rule))).toBe(true);
  });

  it('RULE_CATALOG は、5つの Rule のファイルの配列を1つにまとめた、重複のない凍結した一覧である', () => {
    expect(RULE_CATALOG).toEqual([
      ...TECHNICAL_RULES,
      ...LAYOUT_RULES,
      ...ACCESSIBILITY_RULES,
      ...PERFORMANCE_RULES,
      ...SAFETY_RULES,
    ]);
    expect(Object.isFrozen(RULE_CATALOG)).toBe(true);
    expect(new Set(RULE_CATALOG.map((rule) => rule.ruleId)).size).toBe(RULE_CATALOG.length);
  });
});

describe('RuleEngine', () => {
  it('Finding を severity・ruleId・fingerprint の順に並べ替えてから、開始値からの連番で ID を振る', () => {
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 10,
      catalog: [
        perEvidenceRule('Z_SAFETY_RULE', 'SAFETY'),
        perEvidenceRule('B_INFO_RULE', 'INFO'),
        perEvidenceRule('C_WARN_RULE', 'WARN'),
        perEvidenceRule('A_WARN_RULE', 'WARN'),
        perEvidenceRule('Y_ERROR_RULE', 'ERROR'),
      ],
    });

    const result = engine.evaluate(pageInput(EVIDENCE.slice(0, 2)));

    const expectedRuleOrder = ['Y_ERROR_RULE', 'A_WARN_RULE', 'C_WARN_RULE', 'B_INFO_RULE', 'Z_SAFETY_RULE'];
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(
      expectedRuleOrder.flatMap((ruleId) => [ruleId, ruleId]),
    );
    for (const ruleId of expectedRuleOrder) {
      const fingerprints = result.findings.filter((finding) => finding.ruleId === ruleId).map((finding) => finding.fingerprint);
      expect(fingerprints).toEqual([...fingerprints].sort());
    }
    expect(result.findings.map((finding) => finding.findingId)).toEqual(
      Array.from({ length: 10 }, (_, index) => createFindingId(10 + index)),
    );
    expect(result.nextFindingSequence).toBe(20);
    expect(result.failures).toEqual([]);
  });

  it('下書きの severity を正として並べ替える', () => {
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      catalog: [
        fakeRule({
          ruleId: 'A11Y_LIKE_RULE',
          severity: 'WARN',
          evaluate: (input) => [
            draft('A11Y_LIKE_RULE', 'INFO', [input.evidence[0]!.evidenceId], 'minor'),
            draft('A11Y_LIKE_RULE', 'ERROR', [input.evidence[1]!.evidenceId], 'critical'),
          ],
        }),
      ],
    });

    const result = engine.evaluate(pageInput());

    expect(result.findings.map((finding) => finding.severity)).toEqual(['ERROR', 'INFO']);
  });

  it('入力の Evidence の順序を変えても、Finding の順序・ID・fingerprint・evidenceRefs が同じになる', () => {
    const catalog = [
      perEvidenceRule('WARN_RULE', 'WARN'),
      perEvidenceRule('ERROR_RULE', 'ERROR'),
      fakeRule({
        ruleId: 'AGGREGATE_RULE',
        severity: 'INFO',
        evaluate: (input) => [
          draft('AGGREGATE_RULE', 'INFO', input.evidence.map((record) => record.evidenceId), 'aggregate'),
        ],
      }),
    ];
    const evaluate = (evidence: readonly EvidenceRecord[]) =>
      new RuleEngine({ targetId: TARGET_ID, firstFindingSequence: 1, catalog }).evaluate(pageInput(evidence));

    const forward = evaluate(EVIDENCE);
    const reversed = evaluate([...EVIDENCE].reverse());
    const rotated = evaluate([EVIDENCE[1]!, EVIDENCE[2]!, EVIDENCE[0]!]);

    expect(forward.findings).toHaveLength(7);
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it('Finding の fingerprint は、targetId・ruleId・ページのURL・ビューポート・同一性の要素から createFindingFingerprint() で作る', () => {
    const catalog = [perEvidenceRule('FINGERPRINT_RULE', 'WARN')];
    const input = pageInput(EVIDENCE.slice(0, 1));

    const desktop = new RuleEngine({ targetId: TARGET_ID, firstFindingSequence: 1, catalog }).evaluate(input);
    const mobile = new RuleEngine({ targetId: TARGET_ID, firstFindingSequence: 1, catalog }).evaluate({
      ...input,
      viewport: 'mobile',
    });

    const evidenceId = EVIDENCE[0]!.evidenceId;
    expect(desktop.findings).toEqual([
      {
        schemaVersion: 'finding-schema/1.0',
        findingId: createFindingId(1),
        fingerprint: expectedFingerprint('FINGERPRINT_RULE', evidenceId),
        ruleId: 'FINGERPRINT_RULE',
        ruleVersion: 1,
        category: 'DOM',
        severity: 'WARN',
        pageId: PAGE_ID,
        pageUrl: PAGE_URL,
        viewport: 'desktop',
        message: `FINGERPRINT_RULE の仮の Finding（${evidenceId}）`,
        evidenceRefs: [evidenceId],
      },
    ]);
    expect(mobile.findings[0]?.fingerprint).toBe(expectedFingerprint('FINGERPRINT_RULE', evidenceId, 'mobile'));
    expect(mobile.findings[0]?.fingerprint).not.toBe(desktop.findings[0]?.fingerprint);
  });

  it('Rule が例外を投げても、ほかの Rule の評価を続け、失敗を ruleId と上限付きの文字列で返す', () => {
    const longMessage = 'x'.repeat(MAX_ERROR_MESSAGE_LENGTH + 100);
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      catalog: [
        fakeRule({
          ruleId: 'THROWING_RULE',
          evaluate: () => {
            throw new Error(longMessage);
          },
        }),
        perEvidenceRule('HEALTHY_RULE', 'ERROR'),
        fakeRule({
          ruleId: 'THROWING_NON_ERROR_RULE',
          evaluate: () => {
            // 例外として Error 以外の値が投げられても封じ込めることを確かめる。
            throw 'plain failure';
          },
        }),
      ],
    });

    const result = engine.evaluate(pageInput());

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['HEALTHY_RULE', 'HEALTHY_RULE', 'HEALTHY_RULE']);
    expect(result.failures).toEqual([
      { code: 'RULE_EVALUATION_FAILED', ruleId: 'THROWING_NON_ERROR_RULE', message: 'plain failure' },
      { code: 'RULE_EVALUATION_FAILED', ruleId: 'THROWING_RULE', message: longMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH) },
    ]);
    expect(result.nextFindingSequence).toBe(4);
  });

  it('存在しない Evidence を参照する下書きや、Evidence を参照しない下書きを返した Rule を、失敗として扱う', () => {
    const unknownEvidenceId = createEvidenceId('console', 999);
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      catalog: [
        fakeRule({
          ruleId: 'UNKNOWN_REF_RULE',
          evaluate: (input) => [
            draft('UNKNOWN_REF_RULE', 'WARN', [input.evidence[0]!.evidenceId], 'valid'),
            draft('UNKNOWN_REF_RULE', 'WARN', [input.evidence[1]!.evidenceId, unknownEvidenceId], 'invalid'),
          ],
        }),
        fakeRule({
          ruleId: 'EMPTY_REF_RULE',
          evaluate: () => [draft('EMPTY_REF_RULE', 'WARN', [], 'empty')],
        }),
        perEvidenceRule('HEALTHY_RULE', 'INFO'),
      ],
    });

    const result = engine.evaluate(pageInput());

    // 失敗した Rule の下書きは、正しいものも含めて Finding にしない。
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['HEALTHY_RULE', 'HEALTHY_RULE', 'HEALTHY_RULE']);
    expect(result.failures.map((failure) => [failure.code, failure.ruleId])).toEqual([
      ['RULE_EVALUATION_FAILED', 'EMPTY_REF_RULE'],
      ['RULE_EVALUATION_FAILED', 'UNKNOWN_REF_RULE'],
    ]);
    expect(result.failures.find((failure) => failure.ruleId === 'UNKNOWN_REF_RULE')?.message).toContain(unknownEvidenceId);
  });

  it('ruleIdPrefix を持たない Rule が、自分と異なる ruleId の下書きを返したら、その Rule の失敗とし、正しい下書きも捨てる', () => {
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      catalog: [
        fakeRule({
          ruleId: 'OWNER_RULE',
          evaluate: (input) => [
            draft('OWNER_RULE', 'WARN', [input.evidence[0]!.evidenceId], 'valid'),
            draft('SOMEONE_ELSE_RULE', 'WARN', [input.evidence[1]!.evidenceId], 'mismatch'),
          ],
        }),
        perEvidenceRule('HEALTHY_RULE', 'INFO'),
      ],
    });

    const result = engine.evaluate(pageInput());

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['HEALTHY_RULE', 'HEALTHY_RULE', 'HEALTHY_RULE']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ code: 'RULE_EVALUATION_FAILED', ruleId: 'OWNER_RULE' });
    expect(result.failures[0]?.message).toContain('SOMEONE_ELSE_RULE');
    expect(result.nextFindingSequence).toBe(4);
  });

  it('ruleIdPrefix を持つ Rule の下書きは、接頭辞で始まり接頭辞より長い ruleId なら Finding になる', () => {
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      catalog: [
        fakeRule({
          ruleId: 'A11Y_AXE',
          ruleIdPrefix: 'A11Y_',
          evaluate: (input) => [
            draft('A11Y_IMAGE_ALT', 'ERROR', [input.evidence[0]!.evidenceId], 'img'),
            draft('A11Y_COLOR_CONTRAST', 'WARN', [input.evidence[1]!.evidenceId], 'p'),
          ],
        }),
      ],
    });

    const result = engine.evaluate(pageInput());

    expect(result.failures).toEqual([]);
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['A11Y_IMAGE_ALT', 'A11Y_COLOR_CONTRAST']);
  });

  it('ruleIdPrefix を持つ Rule の下書きが、接頭辞で始まらないか接頭辞と同じ ruleId なら、その Rule の失敗とする', () => {
    for (const wrongRuleId of ['HTTP_4XX', 'A11Y_', 'a11y_IMAGE_ALT']) {
      const engine = new RuleEngine({
        targetId: TARGET_ID,
        firstFindingSequence: 1,
        catalog: [
          fakeRule({
            ruleId: 'A11Y_AXE',
            ruleIdPrefix: 'A11Y_',
            evaluate: (input) => [
              draft('A11Y_IMAGE_ALT', 'ERROR', [input.evidence[0]!.evidenceId], 'img'),
              draft(wrongRuleId, 'WARN', [input.evidence[1]!.evidenceId], 'wrong'),
            ],
          }),
          perEvidenceRule('HEALTHY_RULE', 'INFO'),
        ],
      });

      const result = engine.evaluate(pageInput());

      expect(result.findings.map((finding) => finding.ruleId)).toEqual(['HEALTHY_RULE', 'HEALTHY_RULE', 'HEALTHY_RULE']);
      expect(result.failures.map((failure) => [failure.code, failure.ruleId])).toEqual([
        ['RULE_EVALUATION_FAILED', 'A11Y_AXE'],
      ]);
      expect(result.failures[0]?.message).toContain(wrongRuleId);
    }
  });

  it('Rule が予約名 viewport の同一性の要素を返したら、その Rule の失敗とする', () => {
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      catalog: [
        fakeRule({
          ruleId: 'VIEWPORT_RULE',
          evaluate: (input) => [
            {
              ...draft('VIEWPORT_RULE', 'WARN', [input.evidence[0]!.evidenceId], 'selector'),
              identityFields: [{ name: 'viewport', value: 'mobile' }],
            },
          ],
        }),
        perEvidenceRule('HEALTHY_RULE', 'INFO'),
      ],
    });

    const result = engine.evaluate(pageInput());

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['HEALTHY_RULE', 'HEALTHY_RULE', 'HEALTHY_RULE']);
    expect(result.failures.map((failure) => failure.ruleId)).toEqual(['VIEWPORT_RULE']);
    expect(result.failures[0]?.message).toContain('viewport');
  });

  it('出力を深く凍結する', () => {
    const engine = new RuleEngine({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      catalog: [
        perEvidenceRule('FROZEN_RULE', 'WARN'),
        fakeRule({
          ruleId: 'FAILING_RULE',
          evaluate: () => {
            throw new Error('failure');
          },
        }),
      ],
    });

    const result = engine.evaluate(pageInput());

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings)).toBe(true);
    expect(result.findings.every((finding) => Object.isFrozen(finding) && Object.isFrozen(finding.evidenceRefs))).toBe(true);
    expect(Object.isFrozen(result.failures)).toBe(true);
    expect(result.failures.every((failure) => Object.isFrozen(failure))).toBe(true);
  });

  it('注入した Catalog も、同じ ruleId の重複を例外にする', () => {
    expect(
      () =>
        new RuleEngine({
          targetId: TARGET_ID,
          firstFindingSequence: 1,
          catalog: [perEvidenceRule('SAME_RULE', 'WARN'), perEvidenceRule('SAME_RULE', 'INFO')],
        }),
    ).toThrow(/SAME_RULE/u);
  });

  it('連番の開始値が0以上の安全な整数でなければ、生成時に RangeError を投げる', () => {
    for (const firstFindingSequence of [-1, 1.5, Number.NaN]) {
      expect(() => new RuleEngine({ targetId: TARGET_ID, firstFindingSequence })).toThrow(RangeError);
    }
  });

  it('Catalog を注入しなければ RULE_CATALOG を評価し、Evidence のない入力からは Finding も失敗も作らない', () => {
    // Finding は1件以上の Evidence を参照するので、Evidence のない入力から正しい Finding はできない。
    // RULE_CATALOG のどの Rule も、この入力で例外を投げてはいけない。
    const result = new RuleEngine({ targetId: TARGET_ID, firstFindingSequence: 5 }).evaluate(pageInput([]));

    expect(result).toEqual({ findings: [], failures: [], nextFindingSequence: 5 });
  });
});

describe('materializeFindingDrafts', () => {
  const OWNER = { ruleId: 'MATERIALIZE_RULE', version: 1, category: 'DOM' } as const;
  const EVIDENCE_IDS: ReadonlySet<EvidenceId> = new Set(EVIDENCE.map((record) => record.evidenceId));

  const entry = (
    context: FindingDraftEntry['context'],
    identityValue: string,
    evidenceRef: EvidenceId = EVIDENCE[0]!.evidenceId,
    owner: FindingDraftEntry['owner'] = OWNER,
  ): FindingDraftEntry => ({
    owner,
    context,
    draft: draft(owner.ruleId, 'WARN', [evidenceRef], identityValue),
  });

  it('viewport が null でなければ予約名 viewport の要素を fingerprint に含め、null なら含めない', () => {
    const result = materializeFindingDrafts({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      evidenceIds: EVIDENCE_IDS,
      drafts: [
        entry({ pageId: PAGE_ID, pageUrl: PAGE_URL, viewport: 'desktop' }, 'with-viewport'),
        entry({ pageId: PAGE_ID, pageUrl: PAGE_URL, viewport: null }, 'without-viewport'),
      ],
    });

    const withViewport = result.findings.find((finding) => finding.message.includes('with-viewport'));
    const withoutViewport = result.findings.find((finding) => finding.message.includes('without-viewport'));
    expect(result.failures).toEqual([]);
    expect(withViewport?.viewport).toBe('desktop');
    expect(withViewport?.fingerprint).toBe(expectedFingerprint('MATERIALIZE_RULE', 'with-viewport', 'desktop'));
    expect(withoutViewport?.viewport).toBeNull();
    expect(withoutViewport?.fingerprint).toBe(
      createFindingFingerprint({
        targetId: TARGET_ID,
        ruleId: 'MATERIALIZE_RULE',
        ruleVersion: 1,
        normalizedUrl: PAGE_URL,
        identityFields: [{ name: 'selector', value: 'without-viewport' }],
      }),
    );
  });

  it('同じ下書きでも、viewport が null の場合と null でない場合とで fingerprint が異なる', () => {
    const materialize = (viewport: PageRuleInput['viewport'] | null) =>
      materializeFindingDrafts({
        targetId: TARGET_ID,
        firstFindingSequence: 1,
        evidenceIds: EVIDENCE_IDS,
        drafts: [entry({ pageId: PAGE_ID, pageUrl: PAGE_URL, viewport }, 'same')],
      }).findings[0]?.fingerprint;

    expect(materialize(null)).not.toBe(materialize('desktop'));
    expect(materialize('desktop')).not.toBe(materialize('mobile'));
  });

  it('予約名 viewport の同一性の要素を持つ下書きは、viewport が null でも検査の失敗とし、その Rule の下書きをすべて捨てる', () => {
    const reservedOwner = { ruleId: 'RESERVED_RULE', version: 1, category: 'DOM' } as const;
    const context = { pageId: null, pageUrl: null, viewport: null } as const;
    const result = materializeFindingDrafts({
      targetId: TARGET_ID,
      firstFindingSequence: 3,
      evidenceIds: EVIDENCE_IDS,
      drafts: [
        entry(context, 'valid', EVIDENCE[0]!.evidenceId, reservedOwner),
        {
          owner: reservedOwner,
          context,
          draft: {
            ...draft('RESERVED_RULE', 'WARN', [EVIDENCE[1]!.evidenceId], 'reserved'),
            identityFields: [{ name: 'viewport', value: 'desktop' }],
          },
        },
        entry(context, 'healthy'),
      ],
    });

    expect(result.findings.map((finding) => [finding.findingId, finding.ruleId])).toEqual([
      [createFindingId(3), 'MATERIALIZE_RULE'],
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ code: 'RULE_EVALUATION_FAILED', ruleId: 'RESERVED_RULE' });
    expect(result.failures[0]?.message).toContain('viewport');
    expect(result.nextFindingSequence).toBe(4);
  });

  it('下書きの ruleVersion か category が、持ち主の Rule の定義と異なれば、その Rule の失敗とし、正しい下書きも捨てる', () => {
    const context = { pageId: PAGE_ID, pageUrl: PAGE_URL, viewport: 'desktop' } as const;
    const versionOwner = { ruleId: 'VERSION_OWNER_RULE', version: 2, category: 'DOM' } as const;
    const categoryOwner = { ruleId: 'CATEGORY_OWNER_RULE', version: 1, category: 'FORM' } as const;
    const result = materializeFindingDrafts({
      targetId: TARGET_ID,
      firstFindingSequence: 1,
      evidenceIds: EVIDENCE_IDS,
      drafts: [
        // draft() は ruleVersion 1・category DOM の下書きを作る。
        { owner: versionOwner, context, draft: { ...draft('VERSION_OWNER_RULE', 'WARN', [EVIDENCE[0]!.evidenceId], 'v'), ruleVersion: 2 } },
        { owner: versionOwner, context, draft: draft('VERSION_OWNER_RULE', 'WARN', [EVIDENCE[1]!.evidenceId], 'v1') },
        { owner: categoryOwner, context, draft: { ...draft('CATEGORY_OWNER_RULE', 'WARN', [EVIDENCE[0]!.evidenceId], 'c'), category: 'FORM' } },
        { owner: categoryOwner, context, draft: draft('CATEGORY_OWNER_RULE', 'WARN', [EVIDENCE[1]!.evidenceId], 'dom') },
        entry(context, 'healthy'),
      ],
    });

    expect(result.findings.map((finding) => finding.ruleId)).toEqual(['MATERIALIZE_RULE']);
    expect(result.failures.map((failure) => [failure.code, failure.ruleId])).toEqual([
      ['RULE_EVALUATION_FAILED', 'CATEGORY_OWNER_RULE'],
      ['RULE_EVALUATION_FAILED', 'VERSION_OWNER_RULE'],
    ]);
    expect(result.failures.find((failure) => failure.ruleId === 'VERSION_OWNER_RULE')?.message).toContain('version');
    expect(result.failures.find((failure) => failure.ruleId === 'CATEGORY_OWNER_RULE')?.message).toContain('category');
  });

  it('pageId と pageUrl が null の下書きから、pageId・pageUrl・viewport が null の Finding を作る', () => {
    const result = materializeFindingDrafts({
      targetId: TARGET_ID,
      firstFindingSequence: 42,
      evidenceIds: EVIDENCE_IDS,
      drafts: [entry({ pageId: null, pageUrl: null, viewport: null }, 'cross-page')],
    });

    expect(result).toEqual({
      findings: [
        {
          schemaVersion: 'finding-schema/1.0',
          findingId: createFindingId(42),
          fingerprint: createFindingFingerprint({
            targetId: TARGET_ID,
            ruleId: 'MATERIALIZE_RULE',
            ruleVersion: 1,
            normalizedUrl: null,
            identityFields: [{ name: 'selector', value: 'cross-page' }],
          }),
          ruleId: 'MATERIALIZE_RULE',
          ruleVersion: 1,
          category: 'DOM',
          severity: 'WARN',
          pageId: null,
          pageUrl: null,
          viewport: null,
          message: 'MATERIALIZE_RULE の仮の Finding（cross-page）',
          evidenceRefs: [EVIDENCE[0]!.evidenceId],
        },
      ],
      failures: [],
      nextFindingSequence: 43,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.findings[0])).toBe(true);
  });

  it('下書きの並び順によらず、同じ順序・ID・fingerprint の Finding を作る', () => {
    const drafts = [
      entry({ pageId: PAGE_ID, pageUrl: PAGE_URL, viewport: 'desktop' }, 'a', EVIDENCE[0]!.evidenceId),
      entry({ pageId: null, pageUrl: null, viewport: null }, 'b', EVIDENCE[1]!.evidenceId),
      entry({ pageId: PAGE_ID, pageUrl: PAGE_URL, viewport: 'mobile' }, 'c', EVIDENCE[2]!.evidenceId),
    ];
    const materialize = (entries: readonly FindingDraftEntry[]) =>
      materializeFindingDrafts({ targetId: TARGET_ID, firstFindingSequence: 1, evidenceIds: EVIDENCE_IDS, drafts: entries });

    expect(materialize([...drafts].reverse())).toEqual(materialize(drafts));
  });

  it('targetId が空か、連番の開始値が0以上の安全な整数でなければ、例外を投げる', () => {
    expect(() =>
      materializeFindingDrafts({ targetId: '', firstFindingSequence: 1, evidenceIds: EVIDENCE_IDS, drafts: [] }),
    ).toThrow(TypeError);
    expect(() =>
      materializeFindingDrafts({ targetId: TARGET_ID, firstFindingSequence: -1, evidenceIds: EVIDENCE_IDS, drafts: [] }),
    ).toThrow(RangeError);
  });
});

describe('toRuleEvaluationFailure', () => {
  it('例外を、RULE_EVALUATION_FAILED の失敗と上限付きの文字列に変える（Page rule と Cross-page rule が共有する）', () => {
    const longMessage = 'y'.repeat(MAX_ERROR_MESSAGE_LENGTH + 10);

    expect(toRuleEvaluationFailure('SOME_RULE', new Error(longMessage))).toEqual({
      code: 'RULE_EVALUATION_FAILED',
      ruleId: 'SOME_RULE',
      message: longMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    });
    expect(toRuleEvaluationFailure('OTHER_RULE', 'plain failure')).toMatchObject({
      code: 'RULE_EVALUATION_FAILED',
      ruleId: 'OTHER_RULE',
    });
  });
});
