// T25b round 1（Task 25 の設計書 4.2。設計者の判断: 発見事項 1 は案 B）: Safety Ledger の新しい記録の種類 `blockedAuditExclusions`。
// - 監査の段の除外の口（`auditExclusions`）で Guard が止めた要求の記録（method、URL、main frame のナビゲーションか、理由）と件数。
// - 省略できる項目。何も記録しなかった Ledger（公開監査）の snapshot と Evidence には、項目そのものが現れない。
// - 理由の値 `AUDIT_EXCLUDED_URL` は、この種類の中だけで使う（既存の理由の一覧には足さない）。
// - Safety の事象の種類の一覧（`SAFETY_EVENT_KINDS`）には含めない（表示は、この Task では変えない）。
// 例の値は、匿名の値（`example.com`）だけを使う。
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  BLOCKED_AUDIT_EXCLUSION_REASONS,
  BLOCKED_NAVIGATION_REASONS,
  BLOCKED_REQUEST_REASONS,
  SAFETY_EVENT_KINDS,
  type BlockedAuditExclusionEvent,
} from '../../src/core/evidence-types.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';

/** Ledger の 1 つの記録の種類の、事象の数の上限（`safety-ledger.ts` の `MAX_LEDGER_EVENTS` と同じ値。超えた分の扱いを確かめる）。 */
const LEDGER_EVENT_LIMIT = 256;
/** Ledger の文字列の長さの上限（`safety-ledger.ts` の `MAX_LEDGER_TEXT_LENGTH` と同じ値）。 */
const LEDGER_TEXT_LIMIT = 2_048;

const EVENT: BlockedAuditExclusionEvent = Object.freeze({
  method: 'get',
  url: 'https://example.com/admin/logout',
  mainFrameNavigation: true,
  reason: 'AUDIT_EXCLUDED_URL',
});

const readSchema = (name: string): object =>
  JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as object;

/** 成果物のスキーマをすべて登録した Ajv（スキーマどうしの参照を解決するため）。 */
const ARTIFACT_SCHEMA_NAMES = ['run', 'audit', 'page', 'finding', 'checkpoint', 'checkpoint-page', 'site-unavailable-diagnostic'] as const;
const createAjv = (): Ajv => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  for (const name of ARTIFACT_SCHEMA_NAMES) ajv.addSchema(readSchema(name));
  return ajv;
};

describe('T25b round 1: the blockedAuditExclusions record of the Safety Ledger', () => {
  it('defines the reason only for this record, and does not add it to the existing reason lists', () => {
    expect(BLOCKED_AUDIT_EXCLUSION_REASONS).toEqual(['AUDIT_EXCLUDED_URL']);
    expect(Object.isFrozen(BLOCKED_AUDIT_EXCLUSION_REASONS)).toBe(true);
    expect(BLOCKED_REQUEST_REASONS).toEqual(['NON_READ_METHOD']);
    expect(BLOCKED_NAVIGATION_REASONS).toEqual(['EXTERNAL_MAIN_FRAME_NAVIGATION']);
    expect(SAFETY_EVENT_KINDS).not.toContain('blockedAuditExclusions');
    expectTypeOf<BlockedAuditExclusionEvent['reason']>().toEqualTypeOf<'AUDIT_EXCLUDED_URL'>();
    expectTypeOf<BlockedAuditExclusionEvent['mainFrameNavigation']>().toEqualTypeOf<boolean>();
  });

  it('does not put the record in the snapshot or the Evidence when nothing was excluded (the public audit output is unchanged)', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'POST', url: 'https://example.com/form', reason: 'NON_READ_METHOD' });
    const snapshot = ledger.snapshot();
    expect(Object.hasOwn(snapshot, 'blockedAuditExclusions')).toBe(false);
    expect(Object.hasOwn(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE'), 'blockedAuditExclusions')).toBe(false);
    expect(Object.hasOwn(new SafetyLedger().snapshot(), 'blockedAuditExclusions')).toBe(false);
  });

  it('records the method (canonical), the URL, whether it was a main frame navigation and the reason, with the count', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedAuditExclusion(EVENT);
    ledger.recordBlockedAuditExclusion({ ...EVENT, method: 'HEAD', url: 'https://example.com/img/delete.png', mainFrameNavigation: false });
    const snapshot = ledger.snapshot();

    expect(snapshot.blockedAuditExclusions).toEqual({
      count: 2,
      events: [
        { method: 'GET', url: 'https://example.com/admin/logout', mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL' },
        { method: 'HEAD', url: 'https://example.com/img/delete.png', mainFrameNavigation: false, reason: 'AUDIT_EXCLUDED_URL' },
      ],
    });
    expect(Object.isFrozen(snapshot.blockedAuditExclusions)).toBe(true);
    expect(Object.isFrozen(snapshot.blockedAuditExclusions?.events)).toBe(true);
    expect(Object.isFrozen(snapshot.blockedAuditExclusions?.events[0])).toBe(true);
    // ほかの記録には入らない（読み取りの要求の件数を、読み取り以外の件数に混ぜない）。
    expect(snapshot.blockedRequests).toEqual([]);
    expect(snapshot.blockedNavigations).toEqual([]);
    expect(snapshot.blockedRequestsByMethod).toEqual({});
    expect(snapshot.invariantViolations).toEqual([]);
    expect(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE').blockedAuditExclusions).toEqual(snapshot.blockedAuditExclusions);
  });

  it('truncates the URL like the other request records', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedAuditExclusion({ ...EVENT, url: `https://example.com/${'a'.repeat(LEDGER_TEXT_LIMIT)}` });
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedAuditExclusions?.events[0]?.url.length).toBeLessThanOrEqual(LEDGER_TEXT_LIMIT);
    expect(snapshot.recordLimits.truncatedTextCount).toBe(1);
  });

  it('keeps counting beyond the event limit, and records the dropped events in the record limits', () => {
    const ledger = new SafetyLedger();
    const total = LEDGER_EVENT_LIMIT + 3;
    for (let index = 0; index < total; index += 1) {
      ledger.recordBlockedAuditExclusion({ ...EVENT, url: `https://example.com/admin/logout?n=${index}` });
    }
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedAuditExclusions?.count).toBe(total);
    expect(snapshot.blockedAuditExclusions?.events).toHaveLength(LEDGER_EVENT_LIMIT);
    // T25c（指示書の作るもの 6）: 除外の記録は、設定どおりに止めた記録で、件数（`count`）が正しく残るので、この記録だけが上限を超えても
    // 不完全（`truncated`）にしない（Run を PARTIAL にしない）。記録しなかった件数と、上限に達した分類は、事実として残す。
    expect(snapshot.recordLimits).toMatchObject({
      truncated: false,
      droppedEventCount: total - LEDGER_EVENT_LIMIT,
      reachedCategories: ['blockedAuditExclusions'],
    });
  });

  it('is accepted by the page schema (Safety Evidence) and the checkpoint schema (Ledger snapshot) as an optional property', () => {
    const ajv = createAjv();
    const validateEvidence = ajv.getSchema('urn:beaksight:schema:page:1.0#/$defs/safetyEventsEvidence');
    const validateSnapshot = ajv.getSchema('urn:beaksight:schema:checkpoint:1.0#/$defs/safetyLedgerSnapshot');
    if (validateEvidence === undefined || validateSnapshot === undefined) throw new Error('schema definitions were not found');

    const without = new SafetyLedger().snapshot();
    const withLedger = new SafetyLedger();
    withLedger.recordBlockedAuditExclusion(EVENT);
    const withRecord = withLedger.snapshot();

    expect(validateEvidence(JSON.parse(JSON.stringify(safetyEventsEvidenceFromSnapshot(without, 'PASSIVE'))))).toBe(true);
    expect(validateEvidence(JSON.parse(JSON.stringify(safetyEventsEvidenceFromSnapshot(withRecord, 'PASSIVE'))))).toBe(true);
    expect(validateSnapshot(JSON.parse(JSON.stringify(without)))).toBe(true);
    expect(validateSnapshot(JSON.parse(JSON.stringify(withRecord)))).toBe(true);
  });

  it('rejects an unknown reason, an unknown property and a missing count in the schema', () => {
    const ajv = createAjv();
    const validateEvidence = ajv.getSchema('urn:beaksight:schema:page:1.0#/$defs/safetyEventsEvidence');
    if (validateEvidence === undefined) throw new Error('schema definition was not found');
    const base = JSON.parse(JSON.stringify(safetyEventsEvidenceFromSnapshot(new SafetyLedger().snapshot(), 'PASSIVE'))) as object;
    const event = { method: 'GET', url: 'https://example.com/admin/logout', mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL' };

    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [{ ...event, reason: 'NON_READ_METHOD' }] } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [{ ...event, body: 'x' }] } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { events: [event] } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [event], extra: 1 } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [event] } })).toBe(true);
  });
});
