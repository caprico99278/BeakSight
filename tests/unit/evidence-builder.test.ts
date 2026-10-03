// P14b（Task 14〜17 の設計書 第3章、4.5.3）: Page Auditor は、collector の出力を1つの関数で EvidenceRecord に包む。
// ID は Run で1つの採番器（IdAllocator）から、observedAt は注入した時計から作る。結果は深く凍結する。
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EvidenceRecordFor, PageId } from '../../src/core/contracts.js';
import type { ConsoleEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';
import { createEvidenceRecord } from '../../src/orchestration/evidence-builder.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';

const pageId: PageId = createPageId(7);
const fixedClock = (): Date => new Date('2026-09-24T01:02:03.456Z');

function consolePayload(): ConsoleEvidence {
  // 外側だけを凍結し、中の配列とオブジェクトは変更できるままにする（浅い凍結の payload でも深く凍結されることを確かめる）。
  return Object.freeze({
    consoleMessages: [],
    pageErrors: [{ name: 'Error', message: 'fixture failure', stack: null, truncated: false }],
    omittedConsoleMessageCount: 0,
    omittedPageErrorCount: 0,
  });
}

describe('createEvidenceRecord', () => {
  it('wraps a payload with an Evidence ID from the allocator, the page, the viewport and the clock time', () => {
    const allocator = new IdAllocator();
    const payload = consolePayload();

    const record = createEvidenceRecord(
      { type: 'console', pageId, viewport: 'desktop', payload },
      { allocator, clock: fixedClock },
    );

    expect(record).toEqual({
      evidenceId: createEvidenceId('console', 1),
      type: 'console',
      pageId,
      viewport: 'desktop',
      observedAt: '2026-09-24T01:02:03.456Z',
      payload,
    });
  });

  it('uses the one Run-wide Evidence sequence of the allocator across Evidence types', () => {
    const allocator = new IdAllocator();
    const context = { allocator, clock: fixedClock };

    const first = createEvidenceRecord({ type: 'console', pageId, viewport: 'mobile', payload: consolePayload() }, context);
    const second = createEvidenceRecord({ type: 'console', pageId, viewport: null, payload: consolePayload() }, context);
    const third = allocator.allocateEvidenceId('network');

    expect([first.evidenceId, second.evidenceId, third]).toEqual([
      createEvidenceId('console', 1),
      createEvidenceId('console', 2),
      createEvidenceId('network', 3),
    ]);
    expect([first.viewport, second.viewport]).toEqual(['mobile', null]);
  });

  it('reads the clock once per record and writes its ISO 8601 string', () => {
    const allocator = new IdAllocator();
    let calls = 0;
    const clock = (): Date => {
      calls += 1;
      return new Date(Date.UTC(2026, 8, 24, 0, 0, calls));
    };

    const first = createEvidenceRecord({ type: 'console', pageId, viewport: 'desktop', payload: consolePayload() }, { allocator, clock });
    const second = createEvidenceRecord({ type: 'console', pageId, viewport: 'desktop', payload: consolePayload() }, { allocator, clock });

    expect(calls).toBe(2);
    expect([first.observedAt, second.observedAt]).toEqual(['2026-09-24T00:00:01.000Z', '2026-09-24T00:00:02.000Z']);
  });

  it('deeply freezes the record, including nested values of a payload that was only shallowly frozen', () => {
    const record = createEvidenceRecord(
      { type: 'console', pageId, viewport: 'desktop', payload: consolePayload() },
      { allocator: new IdAllocator(), clock: fixedClock },
    );

    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.payload)).toBe(true);
    expect(Object.isFrozen(record.payload.pageErrors)).toBe(true);
    expect(Object.isFrozen(record.payload.pageErrors[0])).toBe(true);
    expect(Object.isFrozen(record.payload.consoleMessages)).toBe(true);
  });

  it('is not changed by later changes to the caller payload', () => {
    const payload = {
      consoleMessages: [],
      pageErrors: [{ name: 'Error', message: 'original', stack: null, truncated: false }],
      omittedConsoleMessageCount: 0,
      omittedPageErrorCount: 0,
    };

    const record = createEvidenceRecord(
      { type: 'console', pageId, viewport: 'desktop', payload },
      { allocator: new IdAllocator(), clock: fixedClock },
    );
    payload.pageErrors.push({ name: 'Error', message: 'added later', stack: null, truncated: false });
    payload.omittedPageErrorCount = 5;

    expect(record.payload.pageErrors).toEqual([{ name: 'Error', message: 'original', stack: null, truncated: false }]);
    expect(record.payload.omittedPageErrorCount).toBe(0);
  });

  it('ties the payload type to the Evidence type', () => {
    const record = createEvidenceRecord(
      { type: 'console', pageId, viewport: 'desktop', payload: consolePayload() },
      { allocator: new IdAllocator(), clock: fixedClock },
    );
    expectTypeOf(record).toEqualTypeOf<EvidenceRecordFor<'console'>>();

    // 型の検査だけを行う（呼び出さない）。
    const mismatched = (): unknown => createEvidenceRecord(
      // @ts-expect-error: console の payload を network の Evidence にはできない。
      { type: 'network', pageId, viewport: 'desktop', payload: consolePayload() },
      { allocator: new IdAllocator(), clock: fixedClock },
    );
    expect(typeof mismatched).toBe('function');
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'throws RangeError for the Object prototype key %s as an Evidence type without advancing the sequence',
    (type) => {
      const allocator = new IdAllocator();

      expect(() => createEvidenceRecord(
        { type: type as 'console', pageId, viewport: 'desktop', payload: consolePayload() },
        { allocator, clock: fixedClock },
      )).toThrow(RangeError);
      expect(allocator.allocateEvidenceId('console')).toBe(createEvidenceId('console', 1));
    },
  );

  it.each([
    ['a clock that returns an invalid Date', { viewport: 'desktop', clock: () => new Date(Number.NaN) }],
    ['a clock that does not return a Date', { viewport: 'desktop', clock: () => '2026-09-24T00:00:00.000Z' }],
    ['a clock that is not a function', { viewport: 'desktop', clock: 'now' }],
    ['a viewport outside VIEWPORT_PROFILES', { viewport: 'tablet', clock: fixedClock }],
  ])('throws RangeError for %s without advancing the Evidence sequence', (_label, { viewport, clock }) => {
    const allocator = new IdAllocator();

    expect(() => createEvidenceRecord(
      { type: 'console', pageId, viewport: viewport as 'desktop', payload: consolePayload() },
      { allocator, clock: clock as () => Date },
    )).toThrow(RangeError);
    expect(allocator.allocateEvidenceId('console')).toBe(createEvidenceId('console', 1));
  });

  it('throws RangeError for an unknown Evidence type without advancing the Evidence sequence', () => {
    const allocator = new IdAllocator();

    expect(() => createEvidenceRecord(
      { type: 'unknown' as 'console', pageId, viewport: 'desktop', payload: consolePayload() },
      { allocator, clock: fixedClock },
    )).toThrow(RangeError);
    expect(allocator.allocateEvidenceId('console')).toBe(createEvidenceId('console', 1));
  });

  it('throws RangeError for a page ID that is not a string without advancing the Evidence sequence', () => {
    const allocator = new IdAllocator();

    expect(() => createEvidenceRecord(
      { type: 'console', pageId: 7 as unknown as PageId, viewport: 'desktop', payload: consolePayload() },
      { allocator, clock: fixedClock },
    )).toThrow(RangeError);
    expect(allocator.allocateEvidenceId('console')).toBe(createEvidenceId('console', 1));
  });
});
