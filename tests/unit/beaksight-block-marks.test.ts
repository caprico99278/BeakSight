// BN-a（設計書 `doc/design/2026-10-23-beaksight-bundle-beaksight-block-noise-design.md` 3.1）: BeakSight の遮断の記録の形（ブラウザなし）。
// - Safety Ledger: 止めた要求・移動・WebSocket・監査の段の除外の時点（`phase`）と要求の種類（`resourceType`）。閉じる途中に止めた要求の記録
//   （`blockedClosingRequests`）は、数え、上限で記録を不完全にせず、止めた要求の数と一覧には入れない。
// - safety の Evidence の読み込みの印（`load`）。
// - page.json のスキーマ（1.1 は印を必ず持つ）。LG-4（テストの組の設計書 3.7.3、3.7.5）: 前の版（`page-schema/1.0`）と、その読み替えの口
//   （`src/evidence/beaksight-block-marks.ts`）は捨てた。前の版の page.json と、それを持つ保存（checkpoint）は読まない。
// - network の失敗の印の判定（`isBlockedByClientFailure` を使う。複製しない）。
// - 成果物の書き手の URL の伏せ字が、新しい項目にも当たる。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EvidenceId, PageAuditResult, PageId } from '../../src/core/contracts.js';
import {
  BLOCKED_EVENT_PHASES,
  PAGE_SCHEMA_VERSION,
  SAFETY_EVIDENCE_LOAD_KINDS,
  type NetworkFailureEvidence,
  type NormalizedHttpUrlEvidence,
  type SafetyEventsEvidence,
} from '../../src/core/evidence-types.js';
import { REDACTED } from '../../src/core/redaction.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { redactRecordedRequestUrlsInValue } from '../../src/safety/redact.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';

interface PageSchemaFacts {
  readonly $defs: { readonly blockedEventPhase: { readonly enum: readonly string[] } };
}
const pageSchema = JSON.parse(readFileSync(new URL('../../schemas/page.schema.json', import.meta.url), 'utf8')) as PageSchemaFacts;

/** Ledger の事象の上限（`src/safety/safety-ledger.ts` の `MAX_LEDGER_EVENTS`。超えた分を確かめる）。 */
const LEDGER_EVENT_LIMIT = 256;
const TIMING = Object.freeze({
  startTime: 0, domainLookupStart: -1, domainLookupEnd: -1, connectStart: -1, secureConnectionStart: -1, connectEnd: -1, requestStart: -1, responseStart: -1, responseEnd: -1,
});

describe('BN-a: the Safety Ledger records the phase and the resource type of the stopped events', () => {
  it('keeps the phase and the resource type of a stopped request, navigation, WebSocket and audit exclusion', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'post', url: 'https://example.com/api', reason: 'NON_READ_METHOD', resourceType: 'fetch', phase: 'LOAD' });
    ledger.recordBlockedRequest({ method: 'DELETE', url: 'https://example.com/api', reason: 'NON_READ_METHOD', resourceType: 'xhr', phase: 'CLOSING' });
    ledger.recordBlockedNavigation({ method: 'GET', url: 'https://other.example/', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION', phase: 'LOAD' });
    ledger.recordBlockedWebSocket({ url: 'wss://example.com/s', reason: 'PASSIVE_WEBSOCKET', phase: 'CLOSING' });
    ledger.recordBlockedAuditExclusion({
      method: 'GET', url: 'https://example.com/logout', mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL', resourceType: 'document', phase: 'LOAD',
    });
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequests).toEqual([
      { method: 'POST', url: 'https://example.com/api', reason: 'NON_READ_METHOD', resourceType: 'fetch', phase: 'LOAD' },
      { method: 'DELETE', url: 'https://example.com/api', reason: 'NON_READ_METHOD', resourceType: 'xhr', phase: 'CLOSING' },
    ]);
    expect(snapshot.blockedRequestsByMethod).toEqual({ POST: 1, DELETE: 1 });
    expect(snapshot.blockedNavigations[0]?.phase).toBe('LOAD');
    expect(snapshot.blockedWebSockets[0]?.phase).toBe('CLOSING');
    expect(snapshot.blockedAuditExclusions?.events[0]).toMatchObject({ resourceType: 'document', phase: 'LOAD' });
    expect(snapshot.blockedClosingRequests).toBeUndefined();
  });

  it('keeps the speculative mark of a stopped prefetch request (BN-R1 M-2), and writes nothing for the other requests', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'GET', url: 'https://example.com/a', reason: 'SERVICE_REQUEST_LIMIT_REACHED', resourceType: 'fetch', phase: 'LOAD', speculative: true });
    ledger.recordBlockedAuditExclusion({
      method: 'GET', url: 'https://example.com/delete.js', mainFrameNavigation: false, reason: 'AUDIT_EXCLUDED_URL', resourceType: 'fetch', phase: 'LOAD', speculative: true,
    });
    ledger.recordBlockedAuditExclusion({
      method: 'GET', url: 'https://example.com/logout', mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL', resourceType: 'document', phase: 'LOAD',
    });
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedRequests[0]?.speculative).toBe(true);
    expect(snapshot.blockedAuditExclusions?.events.map(({ speculative }) => speculative)).toEqual([true, undefined]);
    expect(Object.hasOwn(snapshot.blockedAuditExclusions?.events[1] ?? {}, 'speculative')).toBe(false);
  });

  it('counts the requests stopped while closing apart from the blocked request counts, and does not truncate the record at the event limit', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < LEDGER_EVENT_LIMIT + 2; index += 1) {
      ledger.recordBlockedClosingRequest({ method: 'get', url: `https://example.com/poll?i=${String(index)}`, resourceType: 'fetch' });
    }
    ledger.recordBlockedClosingRequest(null);
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedClosingRequests?.count).toBe(LEDGER_EVENT_LIMIT + 3);
    expect(snapshot.blockedClosingRequests?.events).toHaveLength(LEDGER_EVENT_LIMIT);
    expect(snapshot.blockedClosingRequests?.events[0]).toEqual({ method: 'GET', url: 'https://example.com/poll?i=0', resourceType: 'fetch', phase: 'CLOSING' });
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.blockedRequestsByMethod).toEqual({});
    expect(snapshot.recordLimits).toMatchObject({ truncated: false, droppedEventCount: 2, reachedCategories: ['blockedClosingRequests'] });
    expect(Object.isFrozen(snapshot.blockedClosingRequests)).toBe(true);
    expect(Object.isFrozen(snapshot.blockedClosingRequests?.events[0])).toBe(true);
  });

  it('still truncates the record when another record reached its limit next to the closing record', () => {
    const ledger = new SafetyLedger();
    for (let index = 0; index < LEDGER_EVENT_LIMIT + 1; index += 1) {
      ledger.recordBlockedClosingRequest({ method: 'GET', url: `https://example.com/poll?i=${String(index)}`, resourceType: 'fetch' });
      ledger.recordBlockedWebSocket({ url: `wss://example.com/s${String(index)}`, reason: 'PASSIVE_WEBSOCKET', phase: 'LOAD' });
    }
    expect(ledger.snapshot().recordLimits.truncated).toBe(true);
  });
});

describe('BN-a: the load of the safety evidence', () => {
  it('puts the load after the scope, and keeps every load kind', () => {
    const snapshot = new SafetyLedger().snapshot();
    expect(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'PAGE_AUDIT' }).load).toEqual({ kind: 'PAGE_AUDIT' });
    expect(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'STRESS_WIDTH', width: 768 }).load).toEqual({ kind: 'STRESS_WIDTH', width: 768 });
    const interaction = safetyEventsEvidenceFromSnapshot(snapshot, 'INTERACTION', { kind: 'INTERACTION', candidateIndex: 2 });
    expect(Object.keys(interaction).slice(0, 2)).toEqual(['scope', 'load']);
    expect(Object.isFrozen(interaction.load)).toBe(true);
    expect(SAFETY_EVIDENCE_LOAD_KINDS).toEqual(['PAGE_AUDIT', 'STRESS_WIDTH', 'INTERACTION']);
  });
});

/**
 * 1 つの network の失敗と、1 つの止めた要求と閉じる途中の記録を持つ、Desktop のページの結果。`marks` が偽なら、page-schema/1.0 の書き手の形
 * （1.1 の印を除いた形）にする。
 */
const pageOf = (schemaVersion: string, marks: boolean): unknown => {
  const failure: NetworkFailureEvidence = {
    requestId: 'REQ-000001', url: 'https://example.test/api?token=secret-a', method: 'POST', resourceType: 'fetch', errorText: 'net::ERR_BLOCKED_BY_CLIENT.Inspector',
    timing: TIMING, isNavigationRequest: false, isMainFrame: false, truncated: false, blockedByBeakSight: true, phase: 'LOAD',
  };
  const ledger = new SafetyLedger();
  ledger.recordBlockedRequest({ method: 'POST', url: 'https://example.test/api?token=secret-a', reason: 'NON_READ_METHOD', resourceType: 'fetch', phase: 'LOAD' });
  if (marks) {
    ledger.recordBlockedClosingRequest({ method: 'GET', url: 'https://example.test/poll?token=secret-b', resourceType: 'fetch' });
  }
  const marked: SafetyEventsEvidence = safetyEventsEvidenceFromSnapshot(ledger.snapshot(), 'PASSIVE', { kind: 'PAGE_AUDIT' });
  const { load: _load, ...withoutLoad } = marked;
  const safety: unknown = marks
    ? marked
    : { ...withoutLoad, blockedRequests: marked.blockedRequests.map(({ resourceType: _type, phase: _phase, ...event }) => event) };
  const { blockedByBeakSight: _blocked, phase: _failurePhase, ...unmarkedFailure } = failure;
  const pageId = 'PAGE-000001' as PageId;
  const evidence: readonly unknown[] = [
    {
      evidenceId: 'EV-NET-000001' as EvidenceId, type: 'network', pageId, viewport: 'desktop', observedAt: '2026-10-23T00:00:00.000Z',
      payload: { requests: [], responses: [], failures: [marks ? failure : unmarkedFailure], omittedRequestCount: 0, omittedResponseCount: 0, omittedFailureCount: 0 },
    },
    { evidenceId: 'EV-SAFETY-000001' as EvidenceId, type: 'safety', pageId, viewport: 'desktop', observedAt: '2026-10-23T00:00:00.000Z', payload: safety },
  ];
  const viewport = {
    requestedUrl: 'https://example.test/' as NormalizedHttpUrlEvidence, finalUrl: 'https://example.test/', httpStatus: 200, status: 'AUDITED' as const,
    incompleteReasons: [], navigationOutcome: 'OK' as const,
  };
  const page: Omit<PageAuditResult, 'schemaVersion' | 'evidence'> & { readonly evidence: readonly unknown[] } = {
    pageId, pageUrl: 'https://example.test/' as NormalizedHttpUrlEvidence, status: 'AUDITED',
    viewports: { desktop: viewport, mobile: viewport }, evidence, findings: [], incompleteReasons: [],
  };
  return { schemaVersion, ...page };
};

const schemaErrorsOf = async (value: unknown): Promise<readonly string[]> => {
  const validation = await validateArtifact('page', value);
  return validation.ok ? [] : validation.errors;
};

describe('BN-a: the page.json schema version', () => {
  // 読める版の一覧とスキーマの enum の一致は `schema-enum-consistency.test.ts` が確かめる。
  it('writes page-schema/1.1 and keeps the phases of the schema', () => {
    expect(PAGE_SCHEMA_VERSION).toBe('page-schema/1.1');
    expect(pageSchema.$defs.blockedEventPhase.enum).toEqual([...BLOCKED_EVENT_PHASES]);
  });

  it('accepts a page.json of page-schema/1.1 with the marks, and rejects a page.json of page-schema/1.0 with or without them (LG-4)', async () => {
    expect(await schemaErrorsOf(pageOf(PAGE_SCHEMA_VERSION, true))).toEqual([]);
    expect(await schemaErrorsOf(pageOf('page-schema/1.0', false))).not.toEqual([]);
    expect(await schemaErrorsOf(pageOf('page-schema/1.0', true))).not.toEqual([]);
  });

  it('rejects a page.json of page-schema/1.1 without the marks', async () => {
    expect(await schemaErrorsOf(pageOf(PAGE_SCHEMA_VERSION, false))).not.toEqual([]);
  });
});

describe('BN-a: the URL redaction of the artifact writer reaches the new records', () => {
  it('redacts the URL of the requests stopped while closing, and keeps the marks', () => {
    const redacted = redactRecordedRequestUrlsInValue(pageOf(PAGE_SCHEMA_VERSION, true)) as PageAuditResult;
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('secret-a');
    expect(serialized).not.toContain('secret-b');
    const safety = redacted.evidence.find(({ type }) => type === 'safety')?.payload as SafetyEventsEvidence;
    expect(safety.blockedClosingRequests?.events[0]).toEqual({ method: 'GET', url: `https://example.test/poll?token=${REDACTED}`, resourceType: 'fetch', phase: 'CLOSING' });
    expect(safety.blockedRequests[0]).toMatchObject({ url: `https://example.test/api?token=${REDACTED}`, resourceType: 'fetch', phase: 'LOAD' });
    expect(safety.load).toEqual({ kind: 'PAGE_AUDIT' });
  });
});
