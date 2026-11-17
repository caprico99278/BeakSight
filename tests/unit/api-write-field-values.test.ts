// T41d（Task 41 の設計書 3.4 の 1）: API の更新の前の読み取りの、値の落ち着きの待ち（`src/browser/api-write-submitter.ts` の `settledFieldValues`）。
// 間隔を置いて 2 回読み、同じになるまで繰り返す。回数の上限を渡したときは、その回数まで落ち着かなければ読めなかったとする
// （`PAGE_UNREADABLE`）。読めない誤りは、そのまま返す。値はメモリの中だけで扱う。
import { describe, expect, it } from 'vitest';
import {
  settledFieldValues,
  settledFieldValuesWhenQuiet,
  type ApiWriteFieldValues,
} from '../../src/browser/api-write-submitter.js';
import { PRODUCTION_OBSERVATION_WINDOWS } from '../../src/core/observation-windows.js';

/** RB-11: 省略したときの間隔（本番の観察の窓の一式）。 */
const API_WRITE_VALUE_SETTLE_INTERVAL_MS = PRODUCTION_OBSERVATION_WINDOWS.write.apiValueSettleIntervalMs;

/** L12b の前の既定の読む回数の上限（10 回。定数は LZ-1 で消した）。今は指定したときだけ当てるので、テストが渡す値として使う。 */
const API_WRITE_VALUE_SETTLE_MAX_READS = 10;

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

  // L12b（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6.2。T25）: 回数の上限（前は既定で `API_WRITE_VALUE_SETTLE_MAX_READS`）は、指定したときだけ当てる。
  it('gives up as unreadable when the values do not settle within a given limit', async () => {
    const changing = Array.from({ length: API_WRITE_VALUE_SETTLE_MAX_READS + 2 }, (_value, index) => values(String(index)));
    const reader = scripted(changing);
    expect(await settledFieldValues(reader.read, reader.wait, API_WRITE_VALUE_SETTLE_INTERVAL_MS, API_WRITE_VALUE_SETTLE_MAX_READS))
      .toEqual({ ok: false, reason: 'PAGE_UNREADABLE' });
    expect(reader.reads).toBe(API_WRITE_VALUE_SETTLE_MAX_READS);
  });

  it('keeps reading past the former limit until the values settle when no limit is given (L12b)', async () => {
    const changing = [...Array.from({ length: API_WRITE_VALUE_SETTLE_MAX_READS + 5 }, (_value, index) => values(String(index))), values('end')];
    const reader = scripted(changing);
    expect(await settledFieldValues(reader.read, reader.wait)).toEqual(values('end'));
    expect(reader.reads).toBe(API_WRITE_VALUE_SETTLE_MAX_READS + 7);
  });

  it('stops as unreadable when the watch ends (L12b)', async () => {
    const stop = new AbortController();
    let reads = 0;
    const read = (): Promise<ApiWriteFieldValues> => {
      reads += 1;
      if (reads === 4) stop.abort();
      return Promise.resolve(values(String(reads)));
    };
    expect(await settledFieldValues(read, () => Promise.resolve(), API_WRITE_VALUE_SETTLE_INTERVAL_MS, undefined, stop.signal))
      .toEqual({ ok: false, reason: 'PAGE_UNREADABLE' });
    expect(reads).toBe(4);
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

  // L12b（T25）: 補いの読み取りも回数の上限を置かず、見張りが終えたら読めなかったとする。
  it('gives up as unreadable when the fallback reads do not settle before the watch ends', async () => {
    const stop = new AbortController();
    let reads = 0;
    const read = (): Promise<ApiWriteFieldValues> => {
      reads += 1;
      if (reads === API_WRITE_VALUE_SETTLE_MAX_READS + 2) stop.abort();
      return Promise.resolve(values(String(reads)));
    };
    expect(await settledFieldValuesWhenQuiet(quietSince(() => null), read, POLICY, () => Promise.resolve(), undefined, stop.signal))
      .toEqual({ ok: false, reason: 'PAGE_UNREADABLE' });
  });

  it('has a named limit for the wait for the requests, shorter than the limit of the settle of a page', () => {
    const { busyTimeoutMs, timeoutMs } = PRODUCTION_OBSERVATION_WINDOWS.discoverySettle;
    expect(busyTimeoutMs).toBeGreaterThan(0);
    expect(busyTimeoutMs).toBeLessThan(timeoutMs);
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
