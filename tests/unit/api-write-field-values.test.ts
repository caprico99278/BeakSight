// T41d（Task 41 の設計書 3.4 の 1）: API の更新の前の読み取りの、値の落ち着きの待ち（`src/browser/api-write-submitter.ts` の `settledFieldValues`）。
// 間隔を置いて 2 回読み、同じになるまで繰り返す。上限の回数（`API_WRITE_VALUE_SETTLE_MAX_READS`）まで落ち着かなければ読めなかったとする
// （`PAGE_UNREADABLE`）。読めない誤りは、そのまま返す。値はメモリの中だけで扱う。
import { describe, expect, it } from 'vitest';
import {
  API_WRITE_VALUE_QUIET_TIMEOUT_MS,
  API_WRITE_VALUE_SETTLE_INTERVAL_MS,
  API_WRITE_VALUE_SETTLE_MAX_READS,
  settledFieldValues,
  settledFieldValuesWhenQuiet,
  type ApiWriteFieldValues,
} from '../../src/browser/api-write-submitter.js';
import { DISCOVERY_SETTLE_TIMEOUT_MS } from '../../src/discovery/settle.js';

/** 決めた順に結果を返す読み取りと、待った時間の記録。 */
const scripted = (results: readonly ApiWriteFieldValues[]) => {
  const waits: number[] = [];
  let reads = 0;
  return {
    read: (): Promise<ApiWriteFieldValues> => {
      const result = results[Math.min(reads, results.length - 1)];
      reads += 1;
      if (result === undefined) throw new Error('no scripted result');
      return Promise.resolve(result);
    },
    wait: (ms: number): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
    get reads() {
      return reads;
    },
    waits,
  };
};

const values = (...items: string[]): ApiWriteFieldValues => ({ ok: true, values: items });

describe('T41d: the settled values of the fields (settledFieldValues)', () => {
  it('has named limits', () => {
    expect(API_WRITE_VALUE_SETTLE_INTERVAL_MS).toBeGreaterThan(0);
    expect(API_WRITE_VALUE_SETTLE_MAX_READS).toBeGreaterThanOrEqual(2);
  });

  it('returns the values when two reads an interval apart are the same', async () => {
    const reader = scripted([values('a', 'b'), values('a', 'b')]);
    expect(await settledFieldValues(reader.read, reader.wait)).toEqual(values('a', 'b'));
    expect(reader.reads).toBe(2);
    expect(reader.waits).toEqual([API_WRITE_VALUE_SETTLE_INTERVAL_MS]);
  });

  it('waits while the page fills the values later, and returns the values once they stay the same', async () => {
    const reader = scripted([values('', ''), values('a', ''), values('a', 'b'), values('a', 'b')]);
    expect(await settledFieldValues(reader.read, reader.wait)).toEqual(values('a', 'b'));
    expect(reader.reads).toBe(4);
  });

  it('gives up as unreadable when the values do not settle within the limit', async () => {
    const changing = Array.from({ length: API_WRITE_VALUE_SETTLE_MAX_READS + 2 }, (_value, index) => values(String(index)));
    const reader = scripted(changing);
    expect(await settledFieldValues(reader.read, reader.wait)).toEqual({ ok: false, reason: 'PAGE_UNREADABLE' });
    expect(reader.reads).toBe(API_WRITE_VALUE_SETTLE_MAX_READS);
  });

  it('returns a read failure at once', async () => {
    const first = scripted([{ ok: false, reason: 'FIELD_NOT_FOUND' }]);
    expect(await settledFieldValues(first.read, first.wait)).toEqual({ ok: false, reason: 'FIELD_NOT_FOUND' });
    expect(first.reads).toBe(1);
    const later = scripted([values('a'), { ok: false, reason: 'FIELD_AMBIGUOUS' }]);
    expect(await settledFieldValues(later.read, later.wait)).toEqual({ ok: false, reason: 'FIELD_AMBIGUOUS' });
  });

  it('compares the values by position and count', async () => {
    const reader = scripted([values('a', 'b'), values('b', 'a'), values('b', 'a')]);
    expect(await settledFieldValues(reader.read, reader.wait)).toEqual(values('b', 'a'));
    expect(reader.reads).toBe(3);
  });
});

// T41R-fix（Task 41 の設計書 8 章の「T41R の途中の報告」の (1)）: 要求が止んだ後に落ち着いた値（`settledFieldValuesWhenQuiet`）。落ち着きの判定は READ の
// owner の部品（`waitForDiscoverySettled`）で、進行中の要求がなく静かな時間が過ぎ、2 回続けて同じ値（位置も比べる）になったときだけ値を返す。
describe('T41R-fix: the values of the fields settled after the requests stopped (settledFieldValuesWhenQuiet)', () => {
  const POLICY = { timeoutMs: 400, networkQuietMs: 20, pollIntervalMs: 5, probeIntervalMs: 10 };
  const quietSince = (since: () => number | null) => ({ quietSinceMs: since });

  // T41R2-fix（設計書 8 章の「T41R2」の (3)）: 開いたままの要求があり上限に届いたら、止めずに、間隔を置いた 2 回の読み取りの落ち着き（`settledFieldValues`）で
  // 進む（realtime の SPA）。
  it('falls back to two reads an interval apart when a request stays in flight up to the limit', async () => {
    const reader = scripted([values('a', 'b'), values('a', 'b')]);
    expect(await settledFieldValuesWhenQuiet(quietSince(() => null), reader.read, POLICY, reader.wait)).toEqual(values('a', 'b'));
    expect(reader.reads).toBe(2);
    expect(reader.waits).toEqual([API_WRITE_VALUE_SETTLE_INTERVAL_MS]);
  });

  it('gives up as unreadable when the fallback reads do not settle', async () => {
    const changing = Array.from({ length: API_WRITE_VALUE_SETTLE_MAX_READS + 2 }, (_value, index) => values(String(index)));
    const reader = scripted(changing);
    expect(await settledFieldValuesWhenQuiet(quietSince(() => null), reader.read, POLICY, reader.wait)).toEqual({ ok: false, reason: 'PAGE_UNREADABLE' });
  });

  it('has a named limit for the wait for the requests, shorter than the limit of the settle of a page', () => {
    expect(API_WRITE_VALUE_QUIET_TIMEOUT_MS).toBeGreaterThan(0);
    expect(API_WRITE_VALUE_QUIET_TIMEOUT_MS).toBeLessThan(DISCOVERY_SETTLE_TIMEOUT_MS);
  });

  it('returns the values once the requests have stopped and two reads are the same', async () => {
    const start = Date.now();
    const reader = scripted([values('a', 'b'), values('a', 'b')]);
    expect(await settledFieldValuesWhenQuiet(quietSince(() => start), reader.read, POLICY)).toEqual(values('a', 'b'));
    expect(reader.reads).toBe(2);
  });

  it('keeps reading while the values change, and compares them by position', async () => {
    const start = Date.now();
    const reader = scripted([values('a', 'b'), values('b', 'a'), values('b', 'a')]);
    expect(await settledFieldValuesWhenQuiet(quietSince(() => start), reader.read, POLICY)).toEqual(values('b', 'a'));
    expect(reader.reads).toBe(3);
  });

  it('gives the read failure at the limit', async () => {
    const start = Date.now();
    const reader = scripted([{ ok: false, reason: 'FIELD_NOT_FOUND' }]);
    expect(await settledFieldValuesWhenQuiet(quietSince(() => start), reader.read, POLICY, reader.wait)).toEqual({ ok: false, reason: 'FIELD_NOT_FOUND' });
  });
});
