import { describe, expect, expectTypeOf, it } from 'vitest';
import type { PageRuleInput } from '../../src/audit/rule.js';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
  SUCCESS_HTTP_STATUS_RANGE,
  distinctSorted,
  evidenceOfType,
  isHttpStatusInRange,
  type HttpStatusRange,
} from '../../src/audit/rule-helpers.js';
import type { EvidenceRecord, EvidenceRecordFor, ViewportProfile } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { createEvidenceId, createPageId } from '../../src/core/ids.js';

const PAGE_ID = createPageId(1);
const OBSERVED_AT = '2026-09-24T00:00:00.000Z';

/** 種類とビューポートだけを見る関数なので、payload の中身は使わない。 */
const record = (
  type: 'performance' | 'safety' | 'layout',
  sequence: number,
  viewport: ViewportProfile | null,
): EvidenceRecord => ({
  evidenceId: createEvidenceId(type, sequence),
  type,
  pageId: PAGE_ID,
  viewport,
  observedAt: OBSERVED_AT,
  payload: {},
} as EvidenceRecord);

const input = (viewport: ViewportProfile, evidence: readonly EvidenceRecord[]): PageRuleInput => ({
  pageId: PAGE_ID,
  pageUrl: 'http://127.0.0.1:4173/' as NormalizedHttpUrlEvidence,
  viewport,
  evidence,
});

describe('evidenceOfType', () => {
  it('returns only the records of the given type collected in the viewport of the input, in input order', () => {
    const evidence = [
      record('performance', 2, 'desktop'),
      record('safety', 1, 'desktop'),
      record('performance', 1, 'desktop'),
      record('performance', 3, 'mobile'),
      record('performance', 4, null),
      record('layout', 1, 'desktop'),
    ];

    const desktop = evidenceOfType(input('desktop', evidence), 'performance');
    expect(desktop.map((item) => item.evidenceId)).toEqual([
      createEvidenceId('performance', 2),
      createEvidenceId('performance', 1),
    ]);
    expect(evidenceOfType(input('mobile', evidence), 'performance').map((item) => item.evidenceId)).toEqual([
      createEvidenceId('performance', 3),
    ]);
    expect(evidenceOfType(input('desktop', evidence), 'accessibility')).toEqual([]);
    expect(evidenceOfType(input('desktop', []), 'safety')).toEqual([]);
  });

  it('returns records typed by the requested evidence type', () => {
    const records = evidenceOfType(input('desktop', [record('safety', 1, 'desktop')]), 'safety');
    expectTypeOf(records).toEqualTypeOf<readonly EvidenceRecordFor<'safety'>[]>();
    expect(records[0]?.type).toBe('safety');
  });
});

describe('HTTP のステータスの範囲', () => {
  it('2xx・4xx・5xx・4xx と 5xx の範囲を、両端を含めて判定する', () => {
    const cases: readonly [HttpStatusRange, readonly number[], readonly number[]][] = [
      [SUCCESS_HTTP_STATUS_RANGE, [200, 299], [199, 300]],
      [CLIENT_ERROR_HTTP_STATUS_RANGE, [400, 499], [399, 500]],
      [SERVER_ERROR_HTTP_STATUS_RANGE, [500, 599], [499, 600]],
      [ERROR_HTTP_STATUS_RANGE, [400, 499, 500, 599], [399, 600]],
    ];
    for (const [range, inside, outside] of cases) {
      for (const status of inside) {
        expect(isHttpStatusInRange(status, range), `${status}`).toBe(true);
      }
      for (const status of outside) {
        expect(isHttpStatusInRange(status, range), `${status}`).toBe(false);
      }
    }
  });

  it('観測できなかったステータス（null）は、どの範囲にも入らない', () => {
    expect(isHttpStatusInRange(null, SUCCESS_HTTP_STATUS_RANGE)).toBe(false);
    expect(isHttpStatusInRange(null, ERROR_HTTP_STATUS_RANGE)).toBe(false);
  });

  it('範囲は凍結されている', () => {
    for (const range of [
      SUCCESS_HTTP_STATUS_RANGE,
      CLIENT_ERROR_HTTP_STATUS_RANGE,
      SERVER_ERROR_HTTP_STATUS_RANGE,
      ERROR_HTTP_STATUS_RANGE,
    ]) {
      expect(Object.isFrozen(range)).toBe(true);
    }
  });
});

describe('distinctSorted', () => {
  it('removes duplicates and orders the values by UTF-16 code units, not by locale', () => {
    expect(distinctSorted(['b', 'a', 'B', 'a', 'é', 'e', 'b'])).toEqual(['B', 'a', 'b', 'e', 'é']);
    expect(distinctSorted([])).toEqual([]);
  });

  it('accepts any iterable and does not change its input', () => {
    const values = ['z', 'y', 'z'];
    expect(distinctSorted(values)).toEqual(['y', 'z']);
    expect(values).toEqual(['z', 'y', 'z']);
    expect(distinctSorted(new Set(['c', 'a'])).join(',')).toBe('a,c');
    expect(distinctSorted(new Map([['k2', 1], ['k1', 2]]).keys())).toEqual(['k1', 'k2']);
  });

  it('keeps the string subtype of the values', () => {
    type Code = 'A' | 'B';
    const codes: readonly Code[] = ['B', 'A'];
    expectTypeOf(distinctSorted(codes)).toEqualTypeOf<Code[]>();
  });
});
