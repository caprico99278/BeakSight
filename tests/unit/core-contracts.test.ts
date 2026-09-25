import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Page } from 'playwright';
import {
  controlledScroll,
  scrollDocumentToOrigin,
  type ControlledScrollPartialReason,
  type ScrollOriginRestoration,
} from '../../src/browser/controlled-scroll.js';
import type { PageSettlingResult } from '../../src/browser/page-settling.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  FINDING_CATEGORIES,
  INCOMPLETE_REASON_CODES,
  OBSERVATION_STATUSES,
  PAGE_AUDIT_STAGES,
  PARTIAL_FAILURE_REASONS,
  VIEWPORT_PROFILES,
  type EvidencePayloadByType,
  type EvidenceRecord,
  type EvidenceRecordFor,
  type EvidenceType,
  type Finding,
  type FindingCategory,
  type IncompleteReason,
  type IncompleteReasonCode,
  type ObservationStatus,
  type PageAuditOutcome,
  type PageAuditResult,
  type PageAuditStage,
  type PageId,
  type PageSafetySummary,
  type PartialFailureReason,
  type RunSafetySummary,
  type RunSummary,
  type SafetyBlockedActionCounts,
  type SafetyInvariantViolationSummary,
  type ViewportAuditResult,
  type ViewportProfile,
} from '../../src/core/contracts.js';
import {
  INTERACTION_HREF_KINDS,
  INTERACTION_NOT_VERIFIABLE_KINDS,
  INTERACTION_REJECTION_REASONS,
  SAFETY_EVENT_KINDS,
  SAFETY_EVIDENCE_SCOPES,
  SCROLL_INCOMPLETE_REASONS,
  URL_REJECTION_REASONS,
  type AccessibilityEvidence,
  type ColorEvidence,
  type ConsoleEvidence,
  type DomEvidence,
  type EffectiveAuditConfig,
  type InteractionCandidateEvidence,
  type InteractionChangeEvidence,
  type InteractionEvidence,
  type InteractionHrefKindEvidence,
  type InteractionNotVerifiableKind,
  type LayoutCollectionResult,
  type LayoutEvidencePayload,
  type LinkAdmissionEvidence,
  type LinkDiscoveryEvidence,
  type LinkEvidence,
  type LinkNormalizationEvidence,
  type NavigationOutcomeKind,
  type NetworkEvidence,
  type NormalizedHttpUrlEvidence,
  type PerformanceEvidence,
  type SafetyEventKind,
  type SafetyEventsEvidence,
  type ScreenshotEvidence,
  type ScrollEvidence,
  type ScrollIncompleteReason,
  type ScrollPosition,
  type StressLayoutEvidence,
  type UrlRejectionReason,
} from '../../src/core/evidence-types.js';
import type * as CoreContracts from '../../src/core/contracts.js';
import type * as CoreEvidence from '../../src/core/evidence-types.js';
import type { RunStatusInput } from '../../src/core/status.js';
import * as CoreEvidenceValues from '../../src/core/evidence-types.js';
import * as CoreLimits from '../../src/core/limits.js';
import type { CrossPageViewportResult } from '../../src/audit/cross-page-rules.js';
import type { UrlAdmission } from '../../src/crawl/admission-policy.js';
import { discoverLinks } from '../../src/crawl/discover-links.js';
import type { NormalizedHttpUrl, NormalizedUrlResult } from '../../src/crawl/normalize-url.js';
import { collectAccessibilityEvidence } from '../../src/evidence/accessibility-collector.js';
import type { CollectorHandle } from '../../src/evidence/collector-handle.js';
import { collectColorEvidence } from '../../src/evidence/color-collector.js';
import { ConsoleCollector } from '../../src/evidence/console-collector.js';
import { collectDomEvidence } from '../../src/evidence/dom-collector.js';
import { collectInteractionChangeEvidence } from '../../src/evidence/interaction-collector.js';
import { collectLayoutEvidence, collectStressLayout } from '../../src/evidence/layout-collector.js';
import { NetworkCollector } from '../../src/evidence/network-collector.js';
import type { PerformanceCollector } from '../../src/evidence/performance-collector.js';
import { captureScreenshots } from '../../src/evidence/screenshot-collector.js';
import type { InteractionAuditResult } from '../../src/interaction/isolated-auditor.js';
import type { InteractionCandidate, InteractionRejectionReason } from '../../src/safety/interaction-policy.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';
import {
  createEvidenceId,
  createFindingFingerprint,
  createFindingId,
  createPageId,
  createRequestId,
  createRunId,
  createSha256Fingerprint,
  createSha256FingerprintOfBytes,
  isPageId,
  isRunId,
  isSha256Fingerprint,
} from '../../src/core/ids.js';

describe('stable identifiers', () => {
  it('uses explicit prefixes and six-digit sequences', () => {
    expect(createRunId(7)).toBe('RUN-000007');
    expect(createPageId(8)).toBe('PAGE-000008');
    expect(createEvidenceId('network', 12)).toBe('EV-NET-000012');
    expect(createFindingId(42)).toBe('FIND-000042');
  });

  // C16d（C16c の判断1）: ID の形の判定。`createRunId`・`createPageId` が作る形と、スキーマの pattern（`^RUN-[0-9]{6,}$`、
  // `^PAGE-[0-9]{6,}$`）に合わせる。
  it('accepts the run IDs and page IDs that createRunId and createPageId make', () => {
    for (const sequence of [0, 1, 7, 999_999, 1_000_000, 20_260_924_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(isRunId(createRunId(sequence)), String(sequence)).toBe(true);
      expect(isPageId(createPageId(sequence)), String(sequence)).toBe(true);
    }
    expect(isRunId('RUN-000000')).toBe(true);
    expect(isPageId('PAGE-0000001')).toBe(true);
  });

  it.each([
    ['a Japanese word', 'ページ'],
    ['a dot', 'a.b'],
    ['a leading underscore', '_x'],
    ['a leading hyphen', '-x'],
    ['a space', 'a b'],
    ['too few digits', 'PAGE-1'],
    ['five digits', 'PAGE-00001'],
    ['the run prefix', 'RUN-000001'],
    ['a lower-case prefix', 'page-000001'],
    ['full-width digits', 'PAGE-０００００１'],
    ['a trailing newline', 'PAGE-000001\n'],
    ['a trailing space', 'PAGE-000001 '],
    ['a leading space', ' PAGE-000001'],
    ['a sign', 'PAGE--000001'],
    ['a separator', 'PAGE-000001/x'],
    ['the empty string', ''],
  ])('rejects a page ID with %s', (_name, value) => {
    expect(isPageId(value)).toBe(false);
  });

  it.each([
    ['a Japanese word', 'ラン'],
    ['a dot', 'a.b'],
    ['a leading underscore', '_x'],
    ['a leading hyphen', '-x'],
    ['a space', 'a b'],
    ['too few digits', 'RUN-1'],
    ['the page prefix', 'PAGE-000001'],
    ['a lower-case prefix', 'run-000001'],
    ['a trailing newline', 'RUN-000001\n'],
    ['a parent segment', '..'],
    ['the empty string', ''],
  ])('rejects a run ID with %s', (_name, value) => {
    expect(isRunId(value)).toBe(false);
  });

  it('rejects values that are not strings', () => {
    for (const value of [undefined, null, 1, 123456, {}, ['RUN-000001'], new String('RUN-000001')]) {
      expect(isRunId(value)).toBe(false);
      expect(isPageId(value)).toBe(false);
    }
  });

  it('rejects evidence types outside the closed canonical set instead of aliasing prefixes', () => {
    expect(() => createEvidenceId('net' as never, 12)).toThrow('unsupported evidence type');
    expect(() => createEvidenceId('a11y' as never, 12)).toThrow('unsupported evidence type');
    expect(() => createEvidenceId('perf' as never, 12)).toThrow('unsupported evidence type');
    expect(() => createEvidenceId('shot' as never, 12)).toThrow('unsupported evidence type');
  });

  // DEF-002: 接頭辞の表は普通のオブジェクトなので、Object の既定のプロパティ名（継承したもの）を
  // 種類として受け付けてはいけない。
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])(
    'rejects the inherited Object property name %s as an evidence type',
    (type) => {
      expect(() => createEvidenceId(type as EvidenceType, 1)).toThrow(RangeError);
      expect(() => createEvidenceId(type as EvidenceType, 1)).toThrow('unsupported evidence type');
    },
  );

  it('keeps each evidence payload selected by its canonical type', () => {
    const evidence: EvidenceRecord = {
      evidenceId: createEvidenceId('network', 12),
      type: 'network',
      pageId: createPageId(1),
      viewport: 'desktop',
      observedAt: '2026-08-27T00:00:00.000Z',
      payload: {
        requests: [],
        responses: [],
        failures: [],
        omittedRequestCount: 0,
        omittedResponseCount: 0,
        omittedFailureCount: 2,
      },
    };

    if (evidence.type === 'network') {
      expect(evidence.payload.omittedFailureCount).toBe(2);
      expect(evidence.payload.responses).toEqual([]);
    }
  });

  it('sorts identity fields with explicit code-unit order before hashing', () => {
    const first = createFindingFingerprint({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'a', value: 'second-by-code-unit' }, { name: 'Z', value: 'first-by-code-unit' }],
    });
    const second = createFindingFingerprint({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'Z', value: 'first-by-code-unit' }, { name: 'a', value: 'second-by-code-unit' }],
    });

    const expectedInput = JSON.stringify({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'Z', value: 'first-by-code-unit' }, { name: 'a', value: 'second-by-code-unit' }],
    });
    const expected = `sha256:${createHash('sha256').update(expectedInput).digest('hex')}`;

    expect(first).toBe(second);
    expect(first).toBe(expected);
  });

  it('does not mutate caller-owned fingerprint identity fields while sorting', () => {
    const identityFields = [
      { name: 'zeta', value: 'last' },
      { name: 'alpha', value: 'first' },
    ];
    const originalIdentityFields = identityFields.map((field) => ({ ...field }));

    createFindingFingerprint({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields,
    });

    expect(identityFields).toEqual(originalIdentityFields);
  });

  it.each([
    ['targetId', { targetId: 'other-target' }],
    ['ruleId', { ruleId: 'OTHER_RULE' }],
    ['ruleVersion', { ruleVersion: 2 }],
    ['normalizedUrl', { normalizedUrl: 'https://example.test/other' }],
    ['identityFields', { identityFields: [{ name: 'src', value: 'https://example.test/other.png' }] }],
  ] as const)('includes %s in the finding fingerprint', (_name, change) => {
    const input = {
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: 'https://example.test/catalog',
      identityFields: [{ name: 'src', value: 'https://example.test/missing.png' }],
    };

    expect(createFindingFingerprint({ ...input, ...change })).not.toBe(createFindingFingerprint(input));
  });
});

describe('request identifiers', () => {
  it('uses the REQ- prefix with the shared six-digit sequence format', () => {
    expect(createRequestId(1)).toBe('REQ-000001');
    expect(createRequestId(123_456)).toBe('REQ-123456');
    expect(createRequestId(1_234_567)).toBe('REQ-1234567');
  });

  it('rejects sequences outside the shared sequence contract', () => {
    expect(() => createRequestId(-1)).toThrow(RangeError);
    expect(() => createRequestId(1.5)).toThrow(RangeError);
    expect(() => createRequestId(Number.NaN)).toThrow(RangeError);
  });
});

describe('sha256 fingerprints', () => {
  it('hashes the UTF-8 input and prefixes the lowercase hexadecimal digest with sha256:', () => {
    const input = 'button|Open menu|日本語';

    expect(createSha256Fingerprint(input)).toBe(`sha256:${createHash('sha256').update(input).digest('hex')}`);
    expect(createSha256Fingerprint('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('recognizes only the exact sha256: fingerprint format', () => {
    const valid = createSha256Fingerprint('value');

    expect(isSha256Fingerprint(valid)).toBe(true);
    expect(isSha256Fingerprint(createFindingFingerprint({
      targetId: 'example-target',
      ruleId: 'IMAGE_LOAD_FAILED',
      ruleVersion: 1,
      normalizedUrl: null,
      identityFields: [],
    }))).toBe(true);
    for (const invalid of [
      valid.toUpperCase(),
      `SHA256:${valid.slice('sha256:'.length)}`,
      valid.slice('sha256:'.length),
      valid.slice(0, -1),
      `${valid}0`,
      `${valid}\n`,
      ` ${valid}`,
      `interaction-candidate:${valid}`,
      `sha256:${'g'.repeat(64)}`,
      '',
      null,
      undefined,
      42,
      { toString: () => valid },
    ]) {
      expect(isSha256Fingerprint(invalid)).toBe(false);
    }
  });

  // U16d: ChatGPT 用バンドルの manifest.json の `sha256` は、ファイルのバイト列そのもののハッシュである（CC-006: 書式は ids.ts だけ）。
  it('hashes a byte sequence as is and uses the same sha256: format as the string fingerprint', () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80]);
    const fingerprint = createSha256FingerprintOfBytes(bytes);

    expect(fingerprint).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    expect(isSha256Fingerprint(fingerprint)).toBe(true);
    expect(createSha256FingerprintOfBytes(new Uint8Array())).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    // UTF-8 のバイト列は、同じ文字列の fingerprint と一致する。
    const text = 'button|Open menu|日本語';
    expect(createSha256FingerprintOfBytes(new TextEncoder().encode(text))).toBe(createSha256Fingerprint(text));
    // 部分の view は、その範囲だけをハッシュする。
    const view = bytes.subarray(2, 5);
    expect(createSha256FingerprintOfBytes(view)).toBe(`sha256:${createHash('sha256').update(Buffer.from([0x4e, 0x47, 0x0d])).digest('hex')}`);
    // 入力を変えない。
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80]);
  });
});

describe('C8: evidence identifiers for link and color evidence', () => {
  it('assigns canonical prefixes to the link and color evidence types', () => {
    expect(createEvidenceId('link', 3)).toBe('EV-LINK-000003');
    expect(createEvidenceId('color', 4)).toBe('EV-COLOR-000004');
  });

  it('assigns a canonical prefix to the scroll evidence type (R\'2 I-2)', () => {
    expect(createEvidenceId('scroll', 5)).toBe('EV-SCROLL-000005');
  });

  it('assigns a canonical prefix to the safety evidence type (T12d0)', () => {
    expect(createEvidenceId('safety', 6)).toBe('EV-SAFETY-000006');
  });
});

describe('C8: incomplete reason codes', () => {
  const expectedCodes = [
    'DEADLINE_EXCEEDED',
    'EVALUATION_FAILED',
    'PAGE_CLOSED',
    'NAVIGATION_FAILED',
    'DOM_READINESS_FAILED',
    'SCROLL_TARGET_UNRESOLVED',
    'SCROLL_NOT_ADVANCED',
    'INNER_SCROLL_CONTAINER_NOT_TRAVERSED',
    'INNER_SCROLL_SCAN_LIMIT_REACHED',
    'SCROLL_TARGET_UNSTABLE',
    'POSITION_NOT_AT_ORIGIN',
    'LAYOUT_COMPARISON_LIMIT_REACHED',
    'RESOURCE_LIMIT_REACHED',
    'INVALID_BROWSER_DATA',
    'PREFLIGHT_FAILED',
    // P18d（DEF-009）: Run のディレクトリを作れなかった（同じ名前のものがすでにある場合を含む）。Run Status の入力は `preflightFailed`。
    'RUN_DIRECTORY_UNAVAILABLE',
    'SAFETY_INVARIANT_VIOLATION',
    'SAFETY_LEDGER_TRUNCATED',
    'UNHANDLED_FAILURE',
    'MAX_PAGES_REACHED',
    'MAX_DEPTH_REACHED',
    'MAX_RUNTIME_REACHED',
    'REQUIRED_ARTIFACT_INVALID',
    'EXECUTION_INCOMPLETE',
    'REQUIRED_WORK_SKIPPED',
    'REQUIRED_WORK_BLOCKED',
    'REQUIRED_WORK_TIMED_OUT',
    'REQUIRED_WORK_NOT_OBSERVED',
    'REQUIRED_WORK_NOT_VERIFIED',
    'REQUIRED_WORK_FAILED',
    'COLLECTOR_INCOMPLETE',
    'RULE_EVALUATION_FAILED',
    // P14d（Task 14〜17 の設計書 4.5.4）: 描画プロセスの crash。crash した段階の理由の detail は `<段階>:PAGE_CRASHED`。
    'PAGE_CRASHED',
    // C18f（Task 19 の前の整理の設計書 4.5）: 安全の不変条件の違反を検出したため、その監査（ページ、ビューポート）を始めなかった。
    'SAFETY_VIOLATION_ABORT',
  ] as const;

  it('defines one frozen closed list that covers collector partial reasons and every Run Status input', () => {
    expect(INCOMPLETE_REASON_CODES).toEqual(expectedCodes);
    expect(Object.isFrozen(INCOMPLETE_REASON_CODES)).toBe(true);
    expectTypeOf<IncompleteReasonCode>().toEqualTypeOf<(typeof expectedCodes)[number]>();
    for (const reason of PARTIAL_FAILURE_REASONS) {
      expect(INCOMPLETE_REASON_CODES).toContain(reason);
    }
  });

  it('derives every collector partial reason type from the closed list', () => {
    expectTypeOf<PartialFailureReason>().toExtend<IncompleteReasonCode>();
    expectTypeOf<ControlledScrollPartialReason>().toExtend<IncompleteReasonCode>();
    expectTypeOf<Extract<ScrollOriginRestoration, { status: 'NOT_RESTORED' }>['reason']>()
      .toExtend<IncompleteReasonCode>();
    expectTypeOf<Extract<PageSettlingResult, { status: 'PARTIAL' }>['reason']>().toExtend<IncompleteReasonCode>();
    expectTypeOf<Extract<PerformanceEvidence, { status: 'PARTIAL' }>['reason']>().toExtend<IncompleteReasonCode>();
    expectTypeOf<Extract<AccessibilityEvidence, { status: 'PARTIAL' }>['reason']>().toExtend<IncompleteReasonCode>();
    expectTypeOf<Extract<LayoutCollectionResult, { status: 'PARTIAL' }>['reason']>().toExtend<IncompleteReasonCode>();
    expectTypeOf<Extract<StressLayoutEvidence, { status: 'FAILED' }>['reason']>().toExtend<IncompleteReasonCode>();
    expectTypeOf<IncompleteReason>().toEqualTypeOf<{
      readonly code: IncompleteReasonCode;
      readonly detail: string | null;
    }>();
  });
});

describe('C8: finding categories', () => {
  it('defines the closed category list of the Task 12/13 rules design chapter 4 on Finding', () => {
    expect(FINDING_CATEGORIES).toEqual([
      'HTTP',
      'LINK',
      'RESOURCE',
      'JAVASCRIPT',
      'DOM',
      'FORM',
      'ACCESSIBILITY',
      'LAYOUT',
      'PERFORMANCE',
      'CROSS_PAGE',
      'SAFETY',
    ]);
    expect(Object.isFrozen(FINDING_CATEGORIES)).toBe(true);
    expectTypeOf<FindingCategory>().toEqualTypeOf<(typeof FINDING_CATEGORIES)[number]>();
    expectTypeOf<Finding['category']>().toEqualTypeOf<FindingCategory>();
  });
});

describe('C8: evidence payload types', () => {
  const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const collectorFiles = [
    'src/evidence/accessibility-collector.ts',
    'src/evidence/color-collector.ts',
    'src/evidence/console-collector.ts',
    'src/evidence/dom-collector.ts',
    'src/evidence/interaction-collector.ts',
    'src/evidence/layout-collector.ts',
    'src/evidence/network-collector.ts',
    'src/evidence/performance-collector.ts',
    'src/evidence/screenshot-collector.ts',
    'src/crawl/discover-links.ts',
    'src/browser/controlled-scroll.ts',
  ] as const;

  it.each(collectorFiles)('%s imports its Evidence types from src/core/evidence-types.ts instead of defining them', async (path) => {
    const source = await readFile(join(repositoryRoot, path), 'utf8');
    const definedEvidenceTypes = [...source.matchAll(/^export (?:interface|type) (\w*(?:Evidence|ScrollPosition))\b/gmu)]
      .map((match) => match[1]);

    expect(definedEvidenceTypes).toEqual([]);
    expect(source).toContain("from '../core/evidence-types.js'");
  });

  it('keeps src/core independent of the other source directories', async () => {
    const coreDirectory = join(repositoryRoot, 'src', 'core');
    const coreFiles = (await readdir(coreDirectory)).filter((name) => name.endsWith('.ts'));
    expect(coreFiles).toContain('evidence-types.ts');
    for (const name of coreFiles) {
      const source = await readFile(join(coreDirectory, name), 'utf8');
      const specifiers = [...source.matchAll(/\bfrom '([^']+)'/gu)].map((match) => match[1]);
      expect(specifiers.filter((specifier) => specifier?.startsWith('../')), name).toEqual([]);
    }
  });

  it('selects each collector output as the payload of its evidence type', () => {
    expectTypeOf<EvidencePayloadByType['network']>().toEqualTypeOf<NetworkEvidence>();
    expectTypeOf<EvidencePayloadByType['console']>().toEqualTypeOf<ConsoleEvidence>();
    expectTypeOf<EvidencePayloadByType['dom']>().toEqualTypeOf<DomEvidence>();
    expectTypeOf<EvidencePayloadByType['link']>().toEqualTypeOf<LinkDiscoveryEvidence>();
    expectTypeOf<EvidencePayloadByType['layout']>().toEqualTypeOf<LayoutEvidencePayload>();
    expectTypeOf<EvidencePayloadByType['color']>().toEqualTypeOf<ColorEvidence>();
    expectTypeOf<EvidencePayloadByType['performance']>().toEqualTypeOf<PerformanceEvidence>();
    expectTypeOf<EvidencePayloadByType['accessibility']>().toEqualTypeOf<AccessibilityEvidence>();
    expectTypeOf<EvidencePayloadByType['interaction']>().toEqualTypeOf<InteractionEvidence>();
    expectTypeOf<EvidencePayloadByType['screenshot']>().toEqualTypeOf<ScreenshotEvidence>();
    expectTypeOf<EvidencePayloadByType['scroll']>().toEqualTypeOf<ScrollEvidence>();
    expectTypeOf<EvidencePayloadByType['safety']>().toEqualTypeOf<SafetyEventsEvidence>();

    expectTypeOf(NetworkCollector.attach).returns.toEqualTypeOf<CollectorHandle<NetworkEvidence>>();
    expectTypeOf(ConsoleCollector.attach).returns.toEqualTypeOf<CollectorHandle<ConsoleEvidence>>();
    expectTypeOf(collectDomEvidence).returns.resolves.toEqualTypeOf<DomEvidence>();
    expectTypeOf(discoverLinks).returns.resolves.toEqualTypeOf<LinkDiscoveryEvidence>();
    expectTypeOf(collectLayoutEvidence).returns.resolves.toEqualTypeOf<LayoutCollectionResult>();
    expectTypeOf(collectStressLayout).returns.resolves.toEqualTypeOf<readonly StressLayoutEvidence[]>();
    expectTypeOf(collectColorEvidence).returns.resolves.toEqualTypeOf<ColorEvidence>();
    expectTypeOf<PerformanceCollector['collect']>().returns.resolves.toEqualTypeOf<PerformanceEvidence>();
    expectTypeOf(collectAccessibilityEvidence).returns.resolves.toEqualTypeOf<AccessibilityEvidence>();
    expectTypeOf(collectInteractionChangeEvidence).returns.toEqualTypeOf<InteractionChangeEvidence>();
    expectTypeOf(captureScreenshots).returns.resolves.toEqualTypeOf<readonly ScreenshotEvidence[]>();
    expectTypeOf(scrollDocumentToOrigin).returns.resolves.toEqualTypeOf<Readonly<ScrollPosition>>();
    expectTypeOf(controlledScroll).returns.resolves.toEqualTypeOf<ScrollEvidence>();
    expectTypeOf<InteractionAuditResult>().toExtend<InteractionEvidence>();
  });

  // F05: src/core は src/crawl・src/safety・src/config を import できないため、定義は core に1か所だけ置く。
  // 元の owner は、core の型をそのまま自分の型の名前で公開する（型の別名）。同じ形をもう一度書かない。
  const ownerTypeAliases = [
    ['src/crawl/normalize-url.ts', 'NormalizedHttpUrl', 'NormalizedHttpUrlEvidence'],
    ['src/crawl/normalize-url.ts', 'NormalizedUrlResult', 'LinkNormalizationEvidence'],
    ['src/crawl/admission-policy.ts', 'UrlAdmission', 'LinkAdmissionEvidence'],
    ['src/safety/interaction-policy.ts', 'InteractionHrefKind', 'InteractionHrefKindEvidence'],
    ['src/safety/interaction-policy.ts', 'InteractionBoundingBox', 'InteractionBoundingBoxEvidence'],
    ['src/safety/interaction-policy.ts', 'InteractionCandidate', 'InteractionCandidateEvidence'],
    ['src/safety/interaction-policy.ts', 'InteractionRejectionReason', 'InteractionRejectionReasonEvidence'],
    ['src/config/types.ts', 'Viewport', 'ViewportSizeEvidence'],
    ['src/config/types.ts', 'AuditConfig', 'EffectiveAuditConfig'],
    ['src/browser/controlled-scroll.ts', 'ScrollTarget', 'ScrollTargetEvidence'],
    ['src/browser/controlled-scroll.ts', 'ScrollObservation', 'ScrollObservationEvidence'],
    ['src/browser/controlled-scroll.ts', 'InnerScrollScan', 'InnerScrollScanEvidence'],
    ['src/browser/controlled-scroll.ts', 'ControlledScrollPartialReason', 'ScrollIncompleteReason'],
    ['src/browser/controlled-scroll.ts', 'ScrollOriginRestoration', 'ScrollRestorationEvidence'],
    ['src/browser/controlled-scroll.ts', 'ScrollResult', 'ScrollEvidence'],
  ] as const;

  it.each(ownerTypeAliases)('%s defines %s only as an alias of the core type %s', async (path, ownerType, coreType) => {
    const source = await readFile(join(repositoryRoot, path), 'utf8');
    const definitions = [...source.matchAll(new RegExp(`^export (?:interface|type) ${ownerType}\\b.*$`, 'gmu'))]
      .map((match) => match[0]);

    expect(definitions).toEqual([`export type ${ownerType} = ${coreType};`]);
    expect(source).toContain("from '../core/evidence-types.js'");
  });

  it('defines each shared domain type once, in src/core/evidence-types.ts', async () => {
    const coreTypes = ownerTypeAliases.map(([, , coreType]) => coreType);
    const sourceRoot = join(repositoryRoot, 'src');
    const sourceFiles = (await readdir(sourceRoot, { recursive: true }))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replaceAll('\\', '/'));
    const definingFiles = new Map<string, string[]>();
    for (const name of sourceFiles) {
      const source = await readFile(join(sourceRoot, name), 'utf8');
      for (const coreType of coreTypes) {
        if (new RegExp(`^export (?:interface|type) ${coreType}\\b`, 'mu').test(source)) {
          definingFiles.set(coreType, [...(definingFiles.get(coreType) ?? []), name]);
        }
      }
    }

    for (const coreType of coreTypes) {
      expect(definingFiles.get(coreType), coreType).toEqual(['core/evidence-types.ts']);
    }
  });

  // T12d0（Task 12・13 の設計書 5.4.1）: Safety Ledger の事象の型と、safety の Evidence の型は、core に1か所だけ置く。
  // `src/safety/safety-ledger.ts` は、core の型を import して使い、同じ名前で re-export するだけにする。
  const safetyEvidenceCoreTypes = [
    'BlockedRequestEvent',
    'BlockedNavigationEvent',
    'BlockedWebSocketEvent',
    'BlockedExternalActionEvent',
    'ExcludedInteractionCandidateEvent',
    'BlockedInteractionRequestEvent',
    'BlockedInteractionNavigationEvent',
    'BlockedPopupEvent',
    'BlockedDownloadEvent',
    'BlockedInteractionWebSocketEvent',
    'SafetyLedgerRecordLimits',
    'SafetyEventsEvidence',
  ] as const;

  it('defines the Safety Ledger event types and the safety Evidence once, in src/core/evidence-types.ts (T12d0)', async () => {
    const sourceRoot = join(repositoryRoot, 'src');
    const sourceFiles = (await readdir(sourceRoot, { recursive: true }))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replaceAll('\\', '/'));
    const definingFiles = new Map<string, string[]>();
    for (const name of sourceFiles) {
      const source = await readFile(join(sourceRoot, name), 'utf8');
      for (const coreType of safetyEvidenceCoreTypes) {
        if (new RegExp(`^export (?:interface|type) ${coreType}\\b`, 'mu').test(source)) {
          definingFiles.set(coreType, [...(definingFiles.get(coreType) ?? []), name]);
        }
      }
    }

    for (const coreType of safetyEvidenceCoreTypes) {
      expect(definingFiles.get(coreType), coreType).toEqual(['core/evidence-types.ts']);
    }
    const ledgerSource = await readFile(join(repositoryRoot, 'src/safety/safety-ledger.ts'), 'utf8');
    expect(ledgerSource).toContain("from '../core/evidence-types.js'");
    // snapshot の型は、Evidence の項目を並べ直さず、Evidence の型から導く。
    expect(ledgerSource).toMatch(/^export interface SafetyLedgerSnapshot extends Omit<SafetyEventsEvidence, 'scope'> \{$/mu);
  });

  it('defines the closed lists of the safety Evidence scopes and the Interaction rejection reasons once (T12d0)', () => {
    expect(SAFETY_EVIDENCE_SCOPES).toEqual(['PASSIVE', 'INTERACTION']);
    expect(Object.isFrozen(SAFETY_EVIDENCE_SCOPES)).toBe(true);
    expectTypeOf<SafetyEventsEvidence['scope']>().toEqualTypeOf<ValueOf<typeof SAFETY_EVIDENCE_SCOPES>>();
    expect(INTERACTION_REJECTION_REASONS).toEqual([
      'SUBMISSION_CONTROL',
      'RESET_CONTROL',
      'FORM_ASSOCIATED',
      'NAVIGATION_HREF',
      'EXTERNAL_ACTION',
      'DOWNLOAD',
      'DISABLED',
      'NOT_VISIBLE',
      'MALFORMED_CANDIDATE',
    ]);
    expect(Object.isFrozen(INTERACTION_REJECTION_REASONS)).toBe(true);
    expectTypeOf<InteractionRejectionReason>().toEqualTypeOf<ValueOf<typeof INTERACTION_REJECTION_REASONS>>();
    expectTypeOf<ValueOf<SafetyEventsEvidence['excludedInteractionCandidates']>['reason']>()
      .toEqualTypeOf<InteractionRejectionReason>();
  });

  // C16e（Task 14〜17 の設計書 6.1.10）: Safety の事象の記録の種類の値の一覧は、core が持つ。
  it('defines the closed list of the Safety event kinds once, as the event lists of SafetyEventsEvidence, in their order (C16e)', () => {
    // 実行時の検査: 空の Safety Ledger から作った記録の、配列の項目（記録の項目の順）と一致する。
    const empty = safetyEventsEvidenceFromSnapshot(new SafetyLedger().snapshot(), 'PASSIVE');
    const eventListNames = Object.entries(empty)
      .filter(([, value]) => Array.isArray(value))
      .map(([name]) => name);
    expect(eventListNames.length).toBeGreaterThan(0);
    expect(SAFETY_EVENT_KINDS).toEqual(eventListNames);
    expect(Object.isFrozen(SAFETY_EVENT_KINDS)).toBe(true);

    // 型の検査: 型は配列から導き、`SafetyEventsEvidence` の配列の項目の鍵の型と等しい（書き漏れも余分もない）。
    type EventListKey = {
      readonly [TKey in keyof SafetyEventsEvidence]-?: SafetyEventsEvidence[TKey] extends readonly unknown[] ? TKey : never;
    }[keyof SafetyEventsEvidence];
    expectTypeOf<SafetyEventKind>().toEqualTypeOf<ValueOf<typeof SAFETY_EVENT_KINDS>>();
    expectTypeOf<SafetyEventKind>().toEqualTypeOf<EventListKey>();
    // @ts-expect-error 事象の一覧ではない項目は、種類ではない。
    const notAKind: SafetyEventKind = 'recordLimits';
    // @ts-expect-error 件数の項目（配列ではない）は、種類ではない。
    const notAList: SafetyEventKind = 'blockedRequestsByMethod';
    // @ts-expect-error `scope` は、種類ではない。
    const notAnEvent: SafetyEventKind = 'scope';
    // @ts-expect-error 種類を鍵にした表は、すべての種類を持たなければならない。
    const missing = { blockedRequests: true } as const satisfies Record<SafetyEventKind, true>;
    expect([notAKind, notAList, notAnEvent, missing]).toHaveLength(4);
  });

  it('defines the closed list of Interaction href kinds once, as a frozen constant, and derives the type from it', () => {
    expect(INTERACTION_HREF_KINDS).toEqual(['NONE', 'SAME_ORIGIN_HTTP', 'EXTERNAL_ORIGIN_HTTP', 'SPECIAL_SCHEME', 'MALFORMED']);
    expect(Object.isFrozen(INTERACTION_HREF_KINDS)).toBe(true);
    expectTypeOf<InteractionHrefKindEvidence>().toEqualTypeOf<(typeof INTERACTION_HREF_KINDS)[number]>();
  });

  // I15a（Task 14〜17 の設計書 5.4.1）: Interaction の NOT_VERIFIABLE の区分。
  it('defines the closed list of the NOT_VERIFIABLE kinds of Interaction once, and derives the Evidence field from it (I15a)', () => {
    expect(INTERACTION_NOT_VERIFIABLE_KINDS).toEqual(['OBSERVED_NO_CHANGE', 'CHECK_NOT_COMPLETED']);
    expect(Object.isFrozen(INTERACTION_NOT_VERIFIABLE_KINDS)).toBe(true);
    expectTypeOf<InteractionNotVerifiableKind>().toEqualTypeOf<ValueOf<typeof INTERACTION_NOT_VERIFIABLE_KINDS>>();
    expectTypeOf<InteractionEvidence['notVerifiableKind']>().toEqualTypeOf<InteractionNotVerifiableKind | null>();
  });

  it('defines the closed list of scroll incomplete reasons once, as a frozen constant, and derives the type from it (F11)', async () => {
    const source = await readFile(join(repositoryRoot, 'src/core/evidence-types.ts'), 'utf8');

    expect(source).toMatch(/^export type ScrollIncompleteReason = \(typeof SCROLL_INCOMPLETE_REASONS\)\[number\];$/mu);
    expect(SCROLL_INCOMPLETE_REASONS).toEqual([
      ...PARTIAL_FAILURE_REASONS,
      'SCROLL_TARGET_UNRESOLVED',
      'SCROLL_NOT_ADVANCED',
      'INNER_SCROLL_CONTAINER_NOT_TRAVERSED',
      'INNER_SCROLL_SCAN_LIMIT_REACHED',
      'SCROLL_TARGET_UNSTABLE',
    ]);
    expect(Object.isFrozen(SCROLL_INCOMPLETE_REASONS)).toBe(true);
    for (const reason of SCROLL_INCOMPLETE_REASONS) {
      expect(INCOMPLETE_REASON_CODES).toContain(reason);
    }
    expectTypeOf<ScrollIncompleteReason>().toEqualTypeOf<(typeof SCROLL_INCOMPLETE_REASONS)[number]>();
    expectTypeOf<ControlledScrollPartialReason>().toEqualTypeOf<ScrollIncompleteReason>();
  });

  it('records the count of omitted scroll observations on both scroll results (F11)', () => {
    expectTypeOf<Extract<ScrollEvidence, { status: 'COMPLETE' }>['omittedObservationCount']>().toEqualTypeOf<number>();
    expectTypeOf<Extract<ScrollEvidence, { status: 'PARTIAL' }>['omittedObservationCount']>().toEqualTypeOf<number>();
  });

  it('records the count of scroll target switches on both scroll results (F12)', () => {
    expectTypeOf<Extract<ScrollEvidence, { status: 'COMPLETE' }>['targetSwitchCount']>().toEqualTypeOf<number>();
    expectTypeOf<Extract<ScrollEvidence, { status: 'PARTIAL' }>['targetSwitchCount']>().toEqualTypeOf<number>();
  });

  it('checks Interaction href kinds against the core constant instead of listing the values again', async () => {
    const source = await readFile(join(repositoryRoot, 'src/safety/interaction-policy.ts'), 'utf8');

    expect(source).toContain('INTERACTION_HREF_KINDS');
    expect(source).not.toMatch(/\[\s*'NONE'\s*,/u);
    expect(source).not.toMatch(/'SAME_ORIGIN_HTTP'\s*,\s*'EXTERNAL_ORIGIN_HTTP'/u);
  });

  it('makes each owner type the core type itself', () => {
    expectTypeOf<InteractionCandidate>().toEqualTypeOf<InteractionCandidateEvidence>();
    expectTypeOf<UrlAdmission>().toEqualTypeOf<LinkAdmissionEvidence>();
    expectTypeOf<NormalizedUrlResult>().toEqualTypeOf<LinkNormalizationEvidence>();
    expectTypeOf<NormalizedHttpUrl>().toEqualTypeOf<NormalizedHttpUrlEvidence>();
    expectTypeOf<AuditConfig>().toEqualTypeOf<EffectiveAuditConfig>();
  });
});

describe('F08: Evidence shapes changed by R4 and the F07 findings', () => {
  it('records the collection scroll position in DOM and accessibility Evidence (R4 M1)', () => {
    expectTypeOf<DomEvidence['scrollPosition']>().toEqualTypeOf<ScrollPosition>();
    expectTypeOf<Extract<AccessibilityEvidence, { status: 'COMPLETE' }>['scrollPosition']>()
      .toEqualTypeOf<ScrollPosition>();
    expectTypeOf<Extract<AccessibilityEvidence, { status: 'PARTIAL' }>['scrollPosition']>()
      .toEqualTypeOf<ScrollPosition | null>();
  });

  it('returns PARTIAL layout results for the deadline and the comparison limit (R4 M2)', () => {
    expectTypeOf<Extract<LayoutCollectionResult, { status: 'PARTIAL' }>['reason']>()
      .toEqualTypeOf<'DEADLINE_EXCEEDED' | 'LAYOUT_COMPARISON_LIMIT_REACHED'>();
  });

  it('keeps Link only in link Evidence and does not pass it to the DOM collector (R\'2 m3)', () => {
    expectTypeOf(collectDomEvidence).parameters.toEqualTypeOf<[Page, PageId]>();
    expectTypeOf<DomEvidence>().not.toHaveProperty('links');
    expectTypeOf<DomEvidence['truncation']>().not.toHaveProperty('omittedLinkCount');
    expectTypeOf<EvidencePayloadByType['link']>().toEqualTypeOf<LinkDiscoveryEvidence>();
  });

  it('types the screenshot viewport as a viewport profile (F07 finding 4)', () => {
    expectTypeOf<ScreenshotEvidence['viewport']>().toEqualTypeOf<ViewportProfile>();
  });
});

describe('DEF-001b: accessibility audit scope', () => {
  it('requires the same-origin frame scope on both COMPLETE and PARTIAL accessibility Evidence', () => {
    expectTypeOf<Extract<AccessibilityEvidence, { status: 'COMPLETE' }>['frameScope']>()
      .toEqualTypeOf<'SAME_ORIGIN_ONLY'>();
    expectTypeOf<Extract<AccessibilityEvidence, { status: 'PARTIAL' }>['frameScope']>()
      .toEqualTypeOf<'SAME_ORIGIN_ONLY'>();
  });
});

describe('C8: page and run results', () => {
  it('keeps a separate audit state for the desktop and mobile viewports of a page', () => {
    expectTypeOf<PageAuditResult['viewports']>().toEqualTypeOf<Readonly<Record<ViewportProfile, ViewportAuditResult>>>();
    expectTypeOf<ViewportProfile>().toEqualTypeOf<'desktop' | 'mobile'>();
    expectTypeOf<ViewportAuditResult['incompleteReasons']>().toEqualTypeOf<readonly IncompleteReason[]>();
    expectTypeOf<PageAuditResult['incompleteReasons']>().toEqualTypeOf<readonly IncompleteReason[]>();
    expectTypeOf<RunSummary['incompleteReasons']>().toEqualTypeOf<readonly IncompleteReason[]>();
  });
});

describe('F07 M5: page identity, viewport, and URL rejection reason types', () => {
  it('keeps the requested URL, the final URL, and the HTTP status of each viewport', () => {
    expectTypeOf<ViewportAuditResult['requestedUrl']>().toEqualTypeOf<NormalizedHttpUrlEvidence>();
    expectTypeOf<ViewportAuditResult['finalUrl']>().toEqualTypeOf<string | null>();
    expectTypeOf<ViewportAuditResult['httpStatus']>().toEqualTypeOf<number | null>();
    expectTypeOf<PageAuditResult['pageUrl']>().toEqualTypeOf<NormalizedHttpUrlEvidence>();
  });

  it('types the viewport of Evidence and Findings as a viewport profile or null', () => {
    expect(VIEWPORT_PROFILES).toEqual(['desktop', 'mobile']);
    expect(Object.isFrozen(VIEWPORT_PROFILES)).toBe(true);
    expectTypeOf<ViewportProfile>().toEqualTypeOf<(typeof VIEWPORT_PROFILES)[number]>();
    expectTypeOf<EvidenceRecordFor<EvidenceType>['viewport']>().toEqualTypeOf<ViewportProfile | null>();
    expectTypeOf<EvidenceRecord['viewport']>().toEqualTypeOf<ViewportProfile | null>();
    expectTypeOf<Finding['viewport']>().toEqualTypeOf<ViewportProfile | null>();
  });

  it('defines the closed list of URL rejection reasons once and uses it for normalization and admission', () => {
    expect(URL_REJECTION_REASONS).toEqual(['INVALID_URL', 'UNSUPPORTED_SCHEME', 'CREDENTIALS_NOT_ALLOWED', 'URL_TOO_LONG']);
    expect(Object.isFrozen(URL_REJECTION_REASONS)).toBe(true);
    expectTypeOf<UrlRejectionReason>().toEqualTypeOf<(typeof URL_REJECTION_REASONS)[number]>();
    expectTypeOf<Extract<LinkNormalizationEvidence, { ok: false }>['reason']>().toEqualTypeOf<UrlRejectionReason>();
    expectTypeOf<Extract<LinkAdmissionEvidence, { kind: 'REJECTED_INVALID' }>['reason']>()
      .toEqualTypeOf<UrlRejectionReason>();
  });

  it('bounds Link Evidence with an omitted count and a truncation mark', () => {
    expectTypeOf<LinkDiscoveryEvidence['omittedLinkCount']>().toEqualTypeOf<number>();
    expectTypeOf<LinkEvidence['truncated']>().toEqualTypeOf<boolean>();
  });

  it('keeps the blocked action counts of the run summary as counts', () => {
    expectTypeOf<RunSafetySummary['blockedActions']>().toEqualTypeOf<SafetyBlockedActionCounts>();
    expectTypeOf<RunSummary['safety']>().toEqualTypeOf<RunSafetySummary>();
  });
});

describe('partial failure reasons and observation statuses', () => {
  it('defines the closed list of partial failure reasons once', () => {
    expect(PARTIAL_FAILURE_REASONS).toEqual(['DEADLINE_EXCEEDED', 'EVALUATION_FAILED', 'PAGE_CLOSED']);
    expect(Object.isFrozen(PARTIAL_FAILURE_REASONS)).toBe(true);
    expectTypeOf<PartialFailureReason>().toEqualTypeOf<'DEADLINE_EXCEEDED' | 'EVALUATION_FAILED' | 'PAGE_CLOSED'>();
  });

  it('defines the closed list of observation statuses once', () => {
    expect(OBSERVATION_STATUSES).toEqual(['OBSERVED', 'NOT_OBSERVED', 'UNSUPPORTED']);
    expect(Object.isFrozen(OBSERVATION_STATUSES)).toBe(true);
    expectTypeOf<ObservationStatus>().toEqualTypeOf<'OBSERVED' | 'NOT_OBSERVED' | 'UNSUPPORTED'>();
  });
});

type ValueOf<TValues extends readonly unknown[]> = TValues[number];

describe('F12: types derived from the core value arrays', () => {
  it('lists every Evidence type of EvidencePayloadByType in EVIDENCE_TYPES', () => {
    expectTypeOf<EvidenceType>().toEqualTypeOf<keyof EvidencePayloadByType>();
    expectTypeOf<EvidenceType>().toEqualTypeOf<ValueOf<typeof CoreContracts.EVIDENCE_TYPES>>();
  });

  it('derives the status types of the contracts from their arrays', () => {
    expectTypeOf<CoreContracts.RunStatus>().toEqualTypeOf<ValueOf<typeof CoreContracts.RUN_STATUSES>>();
    expectTypeOf<CoreContracts.PageAuditStatus>().toEqualTypeOf<ValueOf<typeof CoreContracts.PAGE_AUDIT_STATUSES>>();
    expectTypeOf<CoreContracts.Severity>().toEqualTypeOf<ValueOf<typeof CoreContracts.SEVERITIES>>();
    expectTypeOf<CoreContracts.InteractionStatus>().toEqualTypeOf<ValueOf<typeof CoreContracts.INTERACTION_STATUSES>>();
    expectTypeOf<RunSummary['runStatus']>().toEqualTypeOf<CoreContracts.RunStatus>();
    expectTypeOf<PageAuditResult['status']>().toEqualTypeOf<CoreContracts.PageAuditStatus>();
    expectTypeOf<ViewportAuditResult['status']>().toEqualTypeOf<CoreContracts.PageAuditStatus>();
    expectTypeOf<Finding['severity']>().toEqualTypeOf<CoreContracts.Severity>();
    expectTypeOf<InteractionEvidence['status']>().toEqualTypeOf<CoreContracts.InteractionStatus>();
  });

  it('derives the Evidence field types from their arrays', () => {
    expectTypeOf<CoreEvidence.ScrollTargetEvidence>().toEqualTypeOf<ValueOf<typeof CoreEvidence.SCROLL_TARGETS>>();
    expectTypeOf<Extract<CoreEvidence.ScrollRestorationEvidence, { status: 'NOT_RESTORED' }>['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.SCROLL_RESTORATION_FAILURE_REASONS>>();
    expectTypeOf<CoreEvidence.ConsoleMessageEvidence['type']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.CONSOLE_MESSAGE_TYPES>>();
    expectTypeOf<CoreEvidence.VisibleTextEvidence['source']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.VISIBLE_TEXT_SOURCES>>();
    expectTypeOf<CoreEvidence.SemanticRegionKind>().toEqualTypeOf<ValueOf<typeof CoreEvidence.SEMANTIC_REGION_KINDS>>();
    expectTypeOf<CoreEvidence.SubmitControlEvidence['type']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.SUBMIT_CONTROL_TYPES>>();
    expectTypeOf<CoreEvidence.FixedHeadingOverlapEvidence['overlayPosition']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.FIXED_ELEMENT_POSITIONS>>();
    expectTypeOf<CoreEvidence.FixedElementEvidence['position']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.FIXED_ELEMENT_POSITIONS>>();
    expectTypeOf<CoreEvidence.LayoutIncompleteReason>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.LAYOUT_INCOMPLETE_REASONS>>();
    expectTypeOf<CoreEvidence.StressLayoutFailureStage>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.STRESS_LAYOUT_FAILURE_STAGES>>();
    expectTypeOf<CoreEvidence.StressLayoutFailureReason>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.STRESS_LAYOUT_FAILURE_REASONS>>();
    expectTypeOf<CoreEvidence.ColorUnavailableReason>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.COLOR_UNAVAILABLE_REASONS>>();
    expectTypeOf<Exclude<CoreEvidence.INPAttributionEvidence['interactionType'], undefined>>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.INP_INTERACTION_TYPES>>();
    expectTypeOf<CoreEvidence.WebVitalNavigationType>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.WEB_VITAL_NAVIGATION_TYPES>>();
    expectTypeOf<CoreEvidence.UnobservedWebVitalStatus>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.UNOBSERVED_WEB_VITAL_STATUSES>>();
    expectTypeOf<CoreEvidence.ServerTimingEvidence['source']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.SERVER_TIMING_SOURCES>>();
    expectTypeOf<CoreEvidence.ResourceCategory>().toEqualTypeOf<ValueOf<typeof CoreEvidence.RESOURCE_CATEGORIES>>();
    expectTypeOf<CoreEvidence.ResourceCategoryBasis>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.RESOURCE_CATEGORY_BASES>>();
    expectTypeOf<CoreEvidence.TelemetryHeaderEvidence['direction']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.TELEMETRY_HEADER_DIRECTIONS>>();
    expectTypeOf<ValueOf<CoreEvidence.TelemetryCandidateEvidence['matchingBasis']>>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.TELEMETRY_MATCHING_BASES>>();
    expectTypeOf<CoreEvidence.PerformanceIncompleteReason>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.PERFORMANCE_INCOMPLETE_REASONS>>();
    expectTypeOf<CoreEvidence.AccessibilityImpact>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.ACCESSIBILITY_IMPACTS> | null>();
    expectTypeOf<Extract<AccessibilityEvidence, { status: 'PARTIAL' }>['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.ACCESSIBILITY_INCOMPLETE_REASONS>>();
    expectTypeOf<InteractionChangeEvidence['identityStatus']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.INTERACTION_IDENTITY_STATUSES>>();
    // F16（R5 の N-5）: 対象自身の属性が根拠になった場合の、変わった属性の名前。
    expectTypeOf<InteractionChangeEvidence['changedAttributes']>().toEqualTypeOf<readonly string[]>();
    // F17（F16 の発見事項7）: 変わった属性の名前を上限で切り詰めたか。
    expectTypeOf<InteractionChangeEvidence['changedAttributesTruncated']>().toEqualTypeOf<boolean>();
    // F18（R6 の M-4）: 対象が details の summary の場合の、click の前後の親の details の open の値。
    expectTypeOf<InteractionChangeEvidence['detailsOpenBefore']>().toEqualTypeOf<boolean | null>();
    expectTypeOf<InteractionChangeEvidence['detailsOpenAfter']>().toEqualTypeOf<boolean | null>();
    expectTypeOf<ScreenshotEvidence['captureType']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.SCREENSHOT_CAPTURE_TYPES>>();
    // T12d0: Safety Ledger の事象の理由。
    expectTypeOf<CoreEvidence.BlockedRequestEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.BLOCKED_REQUEST_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedNavigationEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.BLOCKED_NAVIGATION_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedWebSocketEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.BLOCKED_WEBSOCKET_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedInteractionRequestEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.INTERACTION_FROZEN_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedInteractionNavigationEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.INTERACTION_FROZEN_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedPopupEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.INTERACTION_FROZEN_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedInteractionWebSocketEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.INTERACTION_FROZEN_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedDownloadEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.BLOCKED_DOWNLOAD_REASONS>>();
    expectTypeOf<CoreEvidence.ExcludedInteractionCandidateEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.INTERACTION_REJECTION_REASONS>>();
    // CC-014（P14a）: 外部への作用の理由は、Interaction の候補を実行しない理由のうち、外部への作用にあたるものだけ。
    expectTypeOf<CoreEvidence.BlockedExternalActionEvent['reason']>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidence.BLOCKED_EXTERNAL_ACTION_REASONS>>();
    expectTypeOf<CoreEvidence.BlockedExternalActionEvent['reason']>().toEqualTypeOf<'EXTERNAL_ACTION' | 'DOWNLOAD'>();
  });

  it('keeps the values of the Safety Ledger event reasons as frozen arrays (T12d0)', async () => {
    const coreEvidence = await import('../../src/core/evidence-types.js');
    const reasonLists = {
      BLOCKED_REQUEST_REASONS: ['NON_READ_METHOD'],
      BLOCKED_NAVIGATION_REASONS: ['EXTERNAL_MAIN_FRAME_NAVIGATION'],
      BLOCKED_WEBSOCKET_REASONS: ['PASSIVE_WEBSOCKET'],
      INTERACTION_FROZEN_REASONS: ['INTERACTION_FROZEN'],
      BLOCKED_DOWNLOAD_REASONS: ['PASSIVE_DOWNLOAD', 'INTERACTION_FROZEN'],
      // CC-014（P14a）: 外部への作用のため実行しなかった Interaction の候補の理由。
      BLOCKED_EXTERNAL_ACTION_REASONS: ['EXTERNAL_ACTION', 'DOWNLOAD'],
    } as const;
    for (const [name, values] of Object.entries(reasonLists)) {
      const actual = (coreEvidence as Record<string, unknown>)[name];
      expect(actual, name).toEqual(values);
      expect(Object.isFrozen(actual), name).toBe(true);
    }
  });

  it('keeps the values of the reason types that are now derived from arrays', () => {
    expectTypeOf<CoreEvidence.ScrollRestorationFailureReason>()
      .toEqualTypeOf<PartialFailureReason | Extract<IncompleteReasonCode, 'POSITION_NOT_AT_ORIGIN'>>();
    expectTypeOf<CoreEvidence.LayoutIncompleteReason>()
      .toEqualTypeOf<Extract<PartialFailureReason, 'DEADLINE_EXCEEDED'> | Extract<IncompleteReasonCode, 'LAYOUT_COMPARISON_LIMIT_REACHED'>>();
    expectTypeOf<CoreEvidence.StressLayoutFailureReason>()
      .toEqualTypeOf<PartialFailureReason | Extract<IncompleteReasonCode, 'NAVIGATION_FAILED'>>();
    expectTypeOf<CoreEvidence.PerformanceIncompleteReason>().toEqualTypeOf<
      Exclude<PartialFailureReason, 'PAGE_CLOSED'> | Extract<IncompleteReasonCode, 'INVALID_BROWSER_DATA' | 'RESOURCE_LIMIT_REACHED'>
    >();
    expectTypeOf<CoreEvidence.AccessibilityIncompleteReason>().toEqualTypeOf<Exclude<PartialFailureReason, 'PAGE_CLOSED'>>();
    expectTypeOf<CoreEvidence.UnobservedWebVitalStatus>().toEqualTypeOf<Exclude<ObservationStatus, 'OBSERVED'>>();
  });
});

// P14a（Task 14〜17 の設計書 4.3.0、4.5.1、4.5.5）: Page Auditor の前提になる契約。
describe('P14a: page audit contracts', () => {
  it('records the navigation outcome kind of each viewport and lets Cross-page rules read the same type (4.3.0)', () => {
    expectTypeOf<ViewportAuditResult['navigationOutcome']>().toEqualTypeOf<NavigationOutcomeKind | null>();
    expectTypeOf<CrossPageViewportResult>().toEqualTypeOf<ViewportAuditResult>();
  });

  it('defines the page audit stages once as a frozen constant and derives the type from it (4.5.5)', () => {
    expect(PAGE_AUDIT_STAGES).toEqual([
      'navigation',
      'settling',
      'scroll',
      'dom',
      'layout',
      'stress-layout',
      'color',
      'accessibility',
      'performance',
      'screenshot',
      'links',
      'interaction-discovery',
      'interaction',
      'safety',
      'rules',
    ]);
    expect(Object.isFrozen(PAGE_AUDIT_STAGES)).toBe(true);
    expectTypeOf<PageAuditStage>().toEqualTypeOf<ValueOf<typeof PAGE_AUDIT_STAGES>>();
  });

  it('returns the page result and keeps the safety summary outside it (4.5.1)', () => {
    expectTypeOf<PageAuditOutcome['result']>().toEqualTypeOf<PageAuditResult>();
    expectTypeOf<PageAuditOutcome['safety']>().toEqualTypeOf<PageSafetySummary>();
    expectTypeOf<PageSafetySummary['invariantViolationCount']>().toEqualTypeOf<number>();
    expectTypeOf<PageSafetySummary['recordTruncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<PageSafetySummary['invariantViolations']>().toEqualTypeOf<readonly SafetyInvariantViolationSummary[]>();
    expectTypeOf<PageAuditResult>().not.toHaveProperty('safety');
  });

  // P18b（CC-015）: 不変条件の違反の型は、core のこの1つだけ。形は `code` と `message` の文字列で、JSON の形を変えない。
  it('keeps one core shape of an invariant violation for the page and run summaries (P18b, CC-015)', () => {
    expectTypeOf<SafetyInvariantViolationSummary>().toEqualTypeOf<{ readonly code: string; readonly message: string }>();
    expectTypeOf<RunSafetySummary['invariantViolations']>().toEqualTypeOf<readonly SafetyInvariantViolationSummary[]>();
    // @ts-expect-error 違反には `code` が要る。
    const missingCode: SafetyInvariantViolationSummary = { message: 'missing code' };
    // @ts-expect-error 違反の `message` は文字列である。
    const nullMessage: SafetyInvariantViolationSummary = { code: 'NULL_MESSAGE', message: null };
    expect([missingCode, nullMessage]).toHaveLength(2);
  });
});

// R15a（Task 14〜17 の設計書 5.6.1、5.6.2、5.6.5）: Run の結果、サイトの metadata、sitemap の切り詰め、RunSummary の追加。
describe('R15a: run result, site metadata, and run summary contracts', () => {
  it('defines the closed lists of site metadata kinds and outcomes once, as frozen constants (5.6.2)', () => {
    expect(CoreEvidenceValues.SITE_METADATA_KINDS).toEqual(['ROBOTS_TXT', 'SITEMAP_XML']);
    expect(Object.isFrozen(CoreEvidenceValues.SITE_METADATA_KINDS)).toBe(true);
    expect(CoreEvidenceValues.SITE_METADATA_OUTCOMES).toEqual(['OK', 'NOT_FOUND', 'FAILED']);
    expect(Object.isFrozen(CoreEvidenceValues.SITE_METADATA_OUTCOMES)).toBe(true);
    expectTypeOf<CoreEvidence.SiteMetadataKind>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidenceValues.SITE_METADATA_KINDS>>();
    expectTypeOf<CoreEvidence.SiteMetadataOutcome>()
      .toEqualTypeOf<ValueOf<typeof CoreEvidenceValues.SITE_METADATA_OUTCOMES>>();
  });

  it('shapes the metadata Evidence as robots.txt or sitemap.xml with bounded text and sitemap URLs (5.6.2)', () => {
    type Metadata = EvidencePayloadByType['metadata'];
    expectTypeOf<Metadata['kind']>().toEqualTypeOf<CoreEvidence.SiteMetadataKind>();
    expectTypeOf<Metadata['url']>().toEqualTypeOf<string>();
    expectTypeOf<Metadata['outcome']>().toEqualTypeOf<CoreEvidence.SiteMetadataOutcome>();
    expectTypeOf<Metadata['httpStatus']>().toEqualTypeOf<number | null>();
    expectTypeOf<Metadata['text']>().toEqualTypeOf<string | null>();
    expectTypeOf<Metadata['textTruncated']>().toEqualTypeOf<boolean>();
    // sitemap の URL は、sitemap の場合だけ値を持つ。
    expectTypeOf<Extract<Metadata, { kind: 'ROBOTS_TXT' }>['sitemapUrls']>().toEqualTypeOf<null>();
    expectTypeOf<Extract<Metadata, { kind: 'ROBOTS_TXT' }>['sitemapUrlsTruncated']>().toEqualTypeOf<false>();
    expectTypeOf<Extract<Metadata, { kind: 'SITEMAP_XML' }>['sitemapUrls']>().toEqualTypeOf<readonly string[] | null>();
    expectTypeOf<Extract<Metadata, { kind: 'SITEMAP_XML' }>['sitemapUrlsTruncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<Metadata>().not.toHaveProperty('source');
    expectTypeOf<Metadata>().not.toHaveProperty('value');
  });

  it('marks whether the sitemap Evidence for Cross-page rules was truncated (5.6.2)', () => {
    expectTypeOf<CoreEvidence.SitemapEvidence['truncated']>().toEqualTypeOf<boolean>();
  });

  it('names the bounds of the site metadata text and the sitemap URLs in src/core/limits.ts (5.6.2)', () => {
    for (const limit of [CoreLimits.MAX_SITE_METADATA_TEXT_LENGTH, CoreLimits.MAX_SITEMAP_URLS]) {
      expect(Number.isSafeInteger(limit) && limit > 0, String(limit)).toBe(true);
    }
    // 目安（R15a の指示書）: 本文は数十万文字、sitemap の URL は数万件。
    expect(CoreLimits.MAX_SITE_METADATA_TEXT_LENGTH).toBeGreaterThanOrEqual(100_000);
    expect(CoreLimits.MAX_SITE_METADATA_TEXT_LENGTH).toBeLessThan(1_000_000);
    expect(CoreLimits.MAX_SITEMAP_URLS).toBeGreaterThanOrEqual(10_000);
    expect(CoreLimits.MAX_SITEMAP_URLS).toBeLessThan(100_000);
  });

  it('adds the partial page count, the unverified internal link count, and the retries to the run summary (5.6.5)', () => {
    expectTypeOf<RunSummary['partialPageCount']>().toEqualTypeOf<number>();
    expectTypeOf<RunSummary['unverifiedInternalLinkCount']>().toEqualTypeOf<number>();
    expectTypeOf<RunSummary['retries']>().toEqualTypeOf<readonly CoreContracts.RunRetryRecord[]>();
    expectTypeOf<CoreContracts.RunRetryRecord['url']>().toEqualTypeOf<NormalizedHttpUrlEvidence>();
    expectTypeOf<CoreContracts.RunRetryRecord['attempt']>().toEqualTypeOf<number>();
    expectTypeOf<CoreContracts.RunRetryRecord['navigationOutcome']>().toEqualTypeOf<NavigationOutcomeKind>();
    expectTypeOf<CoreContracts.RunRetryRecord['detail']>().toEqualTypeOf<string | null>();
  });

  it('points from a retry record to the Evidence of the first attempt kept on the page (5.6.4, R15 Minor-6)', () => {
    expectTypeOf<CoreContracts.RunRetryRecord['evidenceIds']>().toEqualTypeOf<readonly CoreContracts.EvidenceId[]>();
  });

  it('defines the confirmed run as the run summary, the pages, the findings, and the Run Status input (5.6.1, 6.1.1)', () => {
    expectTypeOf<CoreContracts.AuditRunResult>().toEqualTypeOf<{
      readonly run: RunSummary;
      readonly pages: readonly PageAuditResult[];
      readonly findings: readonly Finding[];
      readonly statusInput: RunStatusInput;
    }>();
  });
});
