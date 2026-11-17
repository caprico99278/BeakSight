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

/** LZ-2 の前の Ledger の文字列の長さの上限（定数は LZ-2 で消した。前の上限を超える長さの場面に使う）。 */
const FORMER_LEDGER_TEXT_LIMIT = 2_048;

const EVENT: BlockedAuditExclusionEvent = Object.freeze({
  method: 'get',
  url: 'https://example.com/admin/logout',
  mainFrameNavigation: true,
  reason: 'AUDIT_EXCLUDED_URL',
  resourceType: 'document',
  phase: 'LOAD',
});

const readSchema = (name: string): object =>
  JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as object;

/** 成果物のスキーマをすべて登録した Ajv（スキーマどうしの参照を解決するため）。 */
const ARTIFACT_SCHEMA_NAMES = ['run', 'audit', 'page', 'finding', 'checkpoint', 'checkpoint-page'] as const;
const createAjv = (): Ajv => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  for (const name of ARTIFACT_SCHEMA_NAMES) ajv.addSchema(readSchema(name));
  return ajv;
};

describe('T25b round 1: the blockedAuditExclusions record of the Safety Ledger', () => {
  it('defines the reason only for this record, and does not add it to the existing reason lists', () => {
    expect(BLOCKED_AUDIT_EXCLUSION_REASONS).toEqual(['AUDIT_EXCLUDED_URL']);
    expect(Object.isFrozen(BLOCKED_AUDIT_EXCLUSION_REASONS)).toBe(true);
    // T35a: 要求の理由の一覧には、サービスの Origin への要求の上限の理由を足した（除外の理由は足していない）。
    // T35R-fix（T35R の C-1）: `SERVICE_ORIGIN_REVISIT` を足した（除外の理由は足さない）。
    // DEF-129: ページが始めた main frame の読み込みの上限の理由を足した（除外の理由は足さない）。DEF-130-fix: 文書でない要求の数の上限の理由を足した。
    // AS-a: 監査の段の送信の扱いで、1 つの読み込みで通す数の上限の理由を足した（除外の理由は足さない）。
    expect(BLOCKED_REQUEST_REASONS).toEqual([
      'NON_READ_METHOD', 'SERVICE_REQUEST_LIMIT_REACHED', 'SERVICE_ORIGIN_REVISIT', 'PAGE_NAVIGATION_LIMIT_REACHED', 'PAGE_SUBRESOURCE_LIMIT_REACHED',
      'AUDIT_SEND_OVER_LIMIT',
      // T44R の I-1。
      'PAGE_LEAVE_REQUEST_LIMIT_REACHED',
      // DEF-210: 通知の枠の閉じる押下の期間の決まりで止めた。
      'NOTIFICATION_DISMISSAL_RESTRICTED',
      // REV-EV4: 横にスクロールする領域のキーの押下の期間の決まりで止めた。
      'SCROLL_KEY_PRESS_RESTRICTED',
    ]);
    expect(BLOCKED_NAVIGATION_REASONS).toEqual(['EXTERNAL_MAIN_FRAME_NAVIGATION']);
    expect(SAFETY_EVENT_KINDS).not.toContain('blockedAuditExclusions');
    expectTypeOf<BlockedAuditExclusionEvent['reason']>().toEqualTypeOf<'AUDIT_EXCLUDED_URL'>();
    expectTypeOf<BlockedAuditExclusionEvent['mainFrameNavigation']>().toEqualTypeOf<boolean>();
  });

  it('does not put the record in the snapshot or the Evidence when nothing was excluded (the public audit output is unchanged)', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'POST', url: 'https://example.com/form', reason: 'NON_READ_METHOD', resourceType: 'document', phase: 'LOAD' });
    const snapshot = ledger.snapshot();
    expect(Object.hasOwn(snapshot, 'blockedAuditExclusions')).toBe(false);
    expect(Object.hasOwn(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'PAGE_AUDIT' }), 'blockedAuditExclusions')).toBe(false);
    expect(Object.hasOwn(new SafetyLedger().snapshot(), 'blockedAuditExclusions')).toBe(false);
  });

  it('records the method (canonical), the URL, whether it was a main frame navigation and the reason, with the count', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedAuditExclusion(EVENT);
    ledger.recordBlockedAuditExclusion({
      ...EVENT, method: 'HEAD', url: 'https://example.com/img/delete.png', mainFrameNavigation: false, resourceType: 'image',
    });
    const snapshot = ledger.snapshot();

    expect(snapshot.blockedAuditExclusions).toEqual({
      count: 2,
      events: [
        {
          method: 'GET', url: 'https://example.com/admin/logout', mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL',
          resourceType: 'document', phase: 'LOAD',
        },
        {
          method: 'HEAD', url: 'https://example.com/img/delete.png', mainFrameNavigation: false, reason: 'AUDIT_EXCLUDED_URL',
          resourceType: 'image', phase: 'LOAD',
        },
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
    expect(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'PAGE_AUDIT' }).blockedAuditExclusions).toEqual(snapshot.blockedAuditExclusions);
  });

  it('keeps the whole URL like the other request records (LZ-2)', () => {
    const ledger = new SafetyLedger();
    const url = `https://example.com/${'a'.repeat(FORMER_LEDGER_TEXT_LIMIT)}`;
    ledger.recordBlockedAuditExclusion({ ...EVENT, url });
    const snapshot = ledger.snapshot();
    expect(snapshot.blockedAuditExclusions?.events[0]?.url).toBe(url);
    expect(snapshot.recordLimits.truncatedTextCount).toBe(0);
  });

  // LZ-3a: 前の事象の数の上限（256）を超える除外も残らず記録する（`safety-ledger-audit-exclusion-limit.test.ts`）。

  it('is accepted by the page schema (Safety Evidence) and the checkpoint schema (Ledger snapshot) as an optional property', () => {
    const ajv = createAjv();
    const validateEvidence = ajv.getSchema('urn:beaksight:schema:page:1.0#/$defs/safetyEventsEvidence');
    const validateSnapshot = ajv.getSchema('urn:beaksight:schema:checkpoint:1.0#/$defs/safetyLedgerSnapshot');
    if (validateEvidence === undefined || validateSnapshot === undefined) throw new Error('schema definitions were not found');

    const without = new SafetyLedger().snapshot();
    const withLedger = new SafetyLedger();
    withLedger.recordBlockedAuditExclusion(EVENT);
    const withRecord = withLedger.snapshot();

    expect(validateEvidence(JSON.parse(JSON.stringify(safetyEventsEvidenceFromSnapshot(without, 'PASSIVE', { kind: 'PAGE_AUDIT' }))))).toBe(true);
    expect(validateEvidence(JSON.parse(JSON.stringify(safetyEventsEvidenceFromSnapshot(withRecord, 'PASSIVE', { kind: 'PAGE_AUDIT' }))))).toBe(true);
    expect(validateSnapshot(JSON.parse(JSON.stringify(without)))).toBe(true);
    expect(validateSnapshot(JSON.parse(JSON.stringify(withRecord)))).toBe(true);
  });

  it('rejects an unknown reason, an unknown property and a missing count in the schema', () => {
    const ajv = createAjv();
    const validateEvidence = ajv.getSchema('urn:beaksight:schema:page:1.0#/$defs/safetyEventsEvidence');
    if (validateEvidence === undefined) throw new Error('schema definition was not found');
    const base = JSON.parse(JSON.stringify(safetyEventsEvidenceFromSnapshot(new SafetyLedger().snapshot(), 'PASSIVE', { kind: 'PAGE_AUDIT' }))) as object;
    const event = {
      method: 'GET', url: 'https://example.com/admin/logout', mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL', resourceType: 'document', phase: 'LOAD',
    };

    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [{ ...event, reason: 'NON_READ_METHOD' }] } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [{ ...event, body: 'x' }] } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { events: [event] } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [event], extra: 1 } })).toBe(false);
    expect(validateEvidence({ ...base, blockedAuditExclusions: { count: 1, events: [event] } })).toBe(true);
  });
});
