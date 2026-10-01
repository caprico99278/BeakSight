// L4（サイトへの負荷の制御の設計書 4.5、第7章）: 監査対象のサイトに送った要求の実績を数える部品 `LoadMeter`。
// 時刻を注入し、許可 Origin とそれ以外の件数、数えない要求（Guard などが止めたもの、キャッシュから返したもの）、
// 1分あたりの最大、状態の取り出しと作り直しを確かめる。L7（設計書 4.8）で、直近の1分の件数を加えた。
import { describe, expect, it } from 'vitest';
import { BLOCKED_BY_CLIENT_FAILURE_TEXTS } from '../../src/browser/playwright-errors.js';
import type { RunLoadRequests } from '../../src/core/contracts.js';
import {
  createLoadMeter,
  LOAD_PEAK_WINDOW_MS,
  type LoadMeter,
  type LoadMeterOptions,
} from '../../src/crawl/load-meter.js';

/** 文書の要求を止めたときに Chromium が報告する理由（`BLOCKED_BY_CLIENT_FAILURE_TEXTS` の1つ目）。 */
const BLOCKED_DOCUMENT_FAILURE_TEXT = BLOCKED_BY_CLIENT_FAILURE_TEXTS[0];

const START_MS = 1_000_000;
const ALLOWED_ORIGIN = 'http://127.0.0.1:8080';
const OTHER_ORIGIN = 'http://127.0.0.1:8081';
const ALLOWED_URL = `${ALLOWED_ORIGIN}/index.html`;
const OTHER_URL = `${OTHER_ORIGIN}/tag.js`;

/** 偽の時計（`advance` で進める）。 */
class FakeClock {
  nowMs = START_MS;
  readonly now = (): number => this.nowMs;

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

/** 要求を見分ける鍵（本番では Playwright の `Request`）。 */
const requestKey = (): object => ({});

function meterWith(clock: FakeClock, overrides: Partial<LoadMeterOptions> = {}): LoadMeter {
  return createLoadMeter({ allowedOrigins: [ALLOWED_ORIGIN], now: clock.now, ...overrides });
}

/** `count` 件の要求が、今の時刻に、`url` で終わった。 */
function finish(meter: LoadMeter, url: string, count = 1): void {
  for (let index = 0; index < count; index += 1) {
    meter.recordRequestFinished(requestKey(), url);
  }
}

const EMPTY_REQUESTS: RunLoadRequests = {
  allowedOrigins: { count: 0, peakPerMinute: 0 },
  otherOrigins: { count: 0, peakPerMinute: 0 },
  servedFromCache: 0,
  withheldOtherOrigins: 0,
};

function expectDeeplyFrozen(value: unknown, path = 'snapshot'): void {
  if (typeof value !== 'object' || value === null) {
    return;
  }
  expect(Object.isFrozen(value), `${path} is frozen`).toBe(true);
  for (const [key, child] of Object.entries(value)) {
    expectDeeplyFrozen(child, `${path}.${key}`);
  }
}

describe('LoadMeter の数え方', () => {
  it('何も数えていなければ、すべて 0 の記録を返す', () => {
    expect(meterWith(new FakeClock()).snapshot()).toEqual(EMPTY_REQUESTS);
  });

  it('要求の URL が許可 Origin に含まれるかで、allowedOrigins と otherOrigins に分けて数える', () => {
    const meter = meterWith(new FakeClock());

    finish(meter, ALLOWED_URL, 3);
    finish(meter, OTHER_URL, 2);

    expect(meter.snapshot()).toEqual({
      ...EMPTY_REQUESTS,
      allowedOrigins: { count: 3, peakPerMinute: 3 },
      otherOrigins: { count: 2, peakPerMinute: 2 },
    });
  });

  it('許可 Origin の判定は Guard と同じ（既定のポートと大文字の host を同じ Origin とみなし、URL でないものと data: は外とする）', () => {
    const meter = createLoadMeter({ allowedOrigins: ['https://example.test'], now: new FakeClock().now });

    finish(meter, 'https://example.test:443/a.css');
    finish(meter, 'https://EXAMPLE.test/b.js');
    finish(meter, 'http://example.test/c.png');
    finish(meter, 'data:image/png;base64,AAAA');
    finish(meter, 'not a url');

    expect(meter.snapshot().allowedOrigins.count).toBe(2);
    expect(meter.snapshot().otherOrigins.count).toBe(3);
  });

  it.each(BLOCKED_BY_CLIENT_FAILURE_TEXTS)('失敗の理由が %s の要求（Guard などが止めた要求）は数えない', (errorText) => {
    const meter = meterWith(new FakeClock());

    meter.recordRequestFailed(requestKey(), ALLOWED_URL, errorText);
    meter.recordRequestFailed(requestKey(), OTHER_URL, errorText);

    expect(meter.snapshot()).toEqual(EMPTY_REQUESTS);
  });

  it('止めた理由と前方だけが同じ、一覧にない理由の失敗は数える（多めに数える側）', () => {
    const meter = meterWith(new FakeClock());

    meter.recordRequestFailed(requestKey(), ALLOWED_URL, `${BLOCKED_DOCUMENT_FAILURE_TEXT}.Other`);

    expect(meter.snapshot().allowedOrigins).toEqual({ count: 1, peakPerMinute: 1 });
  });

  it('ほかの理由の失敗と、理由のない失敗は数える（送ったかもしれないので、多めに数える側）', () => {
    const meter = meterWith(new FakeClock());

    meter.recordRequestFailed(requestKey(), ALLOWED_URL, 'net::ERR_CONNECTION_REFUSED');
    meter.recordRequestFailed(requestKey(), ALLOWED_URL, 'net::ERR_ABORTED');
    meter.recordRequestFailed(requestKey(), OTHER_URL, null);

    expect(meter.snapshot()).toEqual({
      ...EMPTY_REQUESTS,
      allowedOrigins: { count: 2, peakPerMinute: 2 },
      otherOrigins: { count: 1, peakPerMinute: 1 },
    });
  });

  it('キャッシュから返した印の付いた要求は数えず、servedFromCache を増やす', () => {
    const meter = meterWith(new FakeClock());
    const fromCache = requestKey();
    const fromNetwork = requestKey();

    meter.recordServedFromRunCache(fromCache);
    meter.recordRequestFinished(fromCache, ALLOWED_URL);
    meter.recordRequestFinished(fromNetwork, ALLOWED_URL);

    expect(meter.snapshot()).toEqual({
      ...EMPTY_REQUESTS,
      allowedOrigins: { count: 1, peakPerMinute: 1 },
      servedFromCache: 1,
    });
  });

  it('同じ要求に印を2回付けても、servedFromCache は1回だけ増やす。印の付いた要求の失敗も数えない', () => {
    const meter = meterWith(new FakeClock());
    const fromCache = requestKey();

    meter.recordServedFromRunCache(fromCache);
    meter.recordServedFromRunCache(fromCache);
    meter.recordRequestFailed(fromCache, OTHER_URL, 'net::ERR_FAILED');

    expect(meter.snapshot()).toEqual({ ...EMPTY_REQUESTS, servedFromCache: 1 });
  });

  it('recordWithheld で、送らなかった要求の数（withheldOtherOrigins）を増やす', () => {
    const meter = meterWith(new FakeClock());

    meter.recordWithheld();
    meter.recordWithheld();

    expect(meter.snapshot()).toEqual({ ...EMPTY_REQUESTS, withheldOtherOrigins: 2 });
  });
});

describe('LoadMeter の1分あたりの最大', () => {
  it(`${LOAD_PEAK_WINDOW_MS}ms より短い間の要求は、同じ1分に数える（境界の前）`, () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL);
    clock.advance(LOAD_PEAK_WINDOW_MS - 1);
    finish(meter, ALLOWED_URL);

    expect(LOAD_PEAK_WINDOW_MS).toBe(60_000);
    expect(meter.snapshot().allowedOrigins).toEqual({ count: 2, peakPerMinute: 2 });
  });

  it(`${LOAD_PEAK_WINDOW_MS}ms たった要求は、直近の1分から外す（境界の後）`, () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL);
    clock.advance(LOAD_PEAK_WINDOW_MS);
    finish(meter, ALLOWED_URL);

    expect(meter.snapshot().allowedOrigins).toEqual({ count: 2, peakPerMinute: 1 });
  });

  it('古い時刻を捨て、それまでの最大を保ち、直近の1分の件数だけで新しい最大を数える', () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL, 3);
    clock.advance(LOAD_PEAK_WINDOW_MS);
    finish(meter, ALLOWED_URL, 3);
    // 古い3件を捨てたので、直近の1分は3件で、最大は 3 のまま。
    expect(meter.snapshot().allowedOrigins).toEqual({ count: 6, peakPerMinute: 3 });

    clock.advance(1);
    finish(meter, ALLOWED_URL);
    // 古い3件が残っていれば 7 になる。捨てているので 4。
    expect(meter.snapshot().allowedOrigins).toEqual({ count: 7, peakPerMinute: 4 });
  });

  it('区分ごとに、別々に最大を数える', () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL, 2);
    finish(meter, OTHER_URL, 5);
    clock.advance(LOAD_PEAK_WINDOW_MS);
    finish(meter, ALLOWED_URL, 4);

    expect(meter.snapshot()).toEqual({
      ...EMPTY_REQUESTS,
      allowedOrigins: { count: 6, peakPerMinute: 4 },
      otherOrigins: { count: 5, peakPerMinute: 5 },
    });
  });

  it('数えない要求（止めた要求、キャッシュから返した要求）は、1分あたりの最大にも入れない', () => {
    const meter = meterWith(new FakeClock());
    const fromCache = requestKey();

    meter.recordServedFromRunCache(fromCache);
    meter.recordRequestFinished(fromCache, ALLOWED_URL);
    meter.recordRequestFailed(requestKey(), ALLOWED_URL, BLOCKED_DOCUMENT_FAILURE_TEXT);
    finish(meter, ALLOWED_URL);

    expect(meter.snapshot().allowedOrigins).toEqual({ count: 1, peakPerMinute: 1 });
  });

  it('時計が戻った場合は、戻る前の最後の時刻に終わった要求として数える', () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL);
    clock.advance(-LOAD_PEAK_WINDOW_MS);
    finish(meter, ALLOWED_URL);
    clock.advance(LOAD_PEAK_WINDOW_MS + LOAD_PEAK_WINDOW_MS - 1);
    finish(meter, ALLOWED_URL);

    // 2件目は1件目と同じ時刻として扱う。3件目は、1件目から 59,999ms 後なので、3件とも同じ1分に入る。
    expect(meter.snapshot().allowedOrigins).toEqual({ count: 3, peakPerMinute: 3 });
  });
});

// L7（サイトへの負荷の制御の設計書 4.8）: 区分ごとの、直近の1分（`LOAD_PEAK_WINDOW_MS`）に終わった要求の件数。実行中の進み具合の
// 表示に使う。数え方は `LoadMeter` だけが持つ（表示の側で数え直さない）。
describe('LoadMeter の直近の1分の件数', () => {
  it('何も数えていなければ、どちらの区分も 0 を返す', () => {
    expect(meterWith(new FakeClock()).recentPerMinute()).toEqual({ allowedOrigins: 0, otherOrigins: 0 });
  });

  it('区分ごとに、直近の1分に終わった要求の件数を返す', () => {
    const meter = meterWith(new FakeClock());

    finish(meter, ALLOWED_URL, 3);
    finish(meter, OTHER_URL, 2);

    expect(meter.recentPerMinute()).toEqual({ allowedOrigins: 3, otherOrigins: 2 });
  });

  it(`今の時刻から ${LOAD_PEAK_WINDOW_MS}ms より短い前に終わった要求は数える（境界の前）`, () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL);
    finish(meter, OTHER_URL);
    clock.advance(LOAD_PEAK_WINDOW_MS - 1);

    expect(meter.recentPerMinute()).toEqual({ allowedOrigins: 1, otherOrigins: 1 });
  });

  it(`今の時刻から ${LOAD_PEAK_WINDOW_MS}ms 以上前に終わった要求は数えない（境界の後）`, () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL);
    finish(meter, OTHER_URL);
    clock.advance(LOAD_PEAK_WINDOW_MS);

    expect(meter.recentPerMinute()).toEqual({ allowedOrigins: 0, otherOrigins: 0 });
  });

  it('区分ごとに別々に数え、古いものだけを外す', () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, OTHER_URL, 4);
    clock.advance(1);
    finish(meter, ALLOWED_URL, 2);
    clock.advance(LOAD_PEAK_WINDOW_MS - 1);
    finish(meter, ALLOWED_URL);

    // 許可 Origin の外の4件は、ちょうど1分前なので外す。許可 Origin の2件は 59,999ms 前なので数える。
    expect(meter.recentPerMinute()).toEqual({ allowedOrigins: 3, otherOrigins: 0 });
    // 1分あたりの最大と件数は、変えない。
    expect(meter.snapshot()).toEqual({
      ...EMPTY_REQUESTS,
      allowedOrigins: { count: 3, peakPerMinute: 3 },
      otherOrigins: { count: 4, peakPerMinute: 4 },
    });
  });

  it('数えない要求（止めた要求、キャッシュから返した要求）は、直近の1分の件数にも入れない', () => {
    const meter = meterWith(new FakeClock());
    const fromCache = requestKey();

    meter.recordServedFromRunCache(fromCache);
    meter.recordRequestFinished(fromCache, ALLOWED_URL);
    meter.recordRequestFailed(requestKey(), OTHER_URL, BLOCKED_DOCUMENT_FAILURE_TEXT);
    meter.recordWithheld();
    finish(meter, ALLOWED_URL);

    expect(meter.recentPerMinute()).toEqual({ allowedOrigins: 1, otherOrigins: 0 });
  });

  it('件数を返しても、その後の1分あたりの最大の数え方は変わらない', () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);

    finish(meter, ALLOWED_URL, 2);
    clock.advance(LOAD_PEAK_WINDOW_MS - 1);
    expect(meter.recentPerMinute()).toEqual({ allowedOrigins: 2, otherOrigins: 0 });
    finish(meter, ALLOWED_URL);

    expect(meter.snapshot().allowedOrigins).toEqual({ count: 3, peakPerMinute: 3 });
  });

  it('作り直した後は、作り直した後に終わった要求だけを数える（直近の1分の時刻は引き継がない）', () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);
    finish(meter, ALLOWED_URL, 3);

    const restored = meterWith(clock, { initial: meter.snapshot() });
    expect(restored.recentPerMinute()).toEqual({ allowedOrigins: 0, otherOrigins: 0 });
    finish(restored, OTHER_URL);
    expect(restored.recentPerMinute()).toEqual({ allowedOrigins: 0, otherOrigins: 1 });
  });

  it('凍結した、JSON にできる値を返す', () => {
    const meter = meterWith(new FakeClock());
    finish(meter, ALLOWED_URL);

    const recent = meter.recentPerMinute();

    expectDeeplyFrozen(recent, 'recentPerMinute');
    expect(JSON.parse(JSON.stringify(recent))).toEqual(recent);
    expect(Object.keys(recent).sort()).toEqual(['allowedOrigins', 'otherOrigins']);
  });

  it('now() が 0 以上の安全な整数を返さなければ RangeError を投げる', () => {
    for (const invalid of [-1, 1.5, Number.NaN]) {
      const meter = createLoadMeter({ allowedOrigins: [ALLOWED_ORIGIN], now: () => invalid });
      expect(() => meter.recentPerMinute()).toThrow(RangeError);
    }
  });
});

describe('LoadMeter の状態の取り出しと作り直し', () => {
  it('snapshot は、run.json の load.requests と同じ形の、凍結した、JSON にできる値を返す', () => {
    const meter = meterWith(new FakeClock());
    finish(meter, ALLOWED_URL);
    meter.recordWithheld();

    const snapshot = meter.snapshot();

    expectDeeplyFrozen(snapshot);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(Object.keys(snapshot).sort()).toEqual(['allowedOrigins', 'otherOrigins', 'servedFromCache', 'withheldOtherOrigins']);
    // 取り出した後に数えても、取り出した値は変わらない。
    finish(meter, ALLOWED_URL);
    expect(snapshot.allowedOrigins.count).toBe(1);
  });

  it('取り出した記録を initial にして作り直すと、同じ記録から続ける', () => {
    const clock = new FakeClock();
    const meter = meterWith(clock);
    finish(meter, ALLOWED_URL, 3);
    finish(meter, OTHER_URL, 2);
    meter.recordServedFromRunCache(requestKey());
    meter.recordWithheld();

    const restored = meterWith(clock, { initial: meter.snapshot() });

    expect(restored.snapshot()).toEqual(meter.snapshot());
    finish(restored, OTHER_URL);
    restored.recordServedFromRunCache(requestKey());
    restored.recordWithheld();
    expect(restored.snapshot()).toEqual({
      allowedOrigins: { count: 3, peakPerMinute: 3 },
      otherOrigins: { count: 3, peakPerMinute: 2 },
      servedFromCache: 2,
      withheldOtherOrigins: 2,
    });
  });

  it('作り直した後の1分あたりの最大は、initial の値と、作り直した後の最大の、大きい方（直近の1分の時刻は引き継がない）', () => {
    const clock = new FakeClock();
    const initial: RunLoadRequests = {
      allowedOrigins: { count: 10, peakPerMinute: 5 },
      otherOrigins: { count: 4, peakPerMinute: 2 },
      servedFromCache: 0,
      withheldOtherOrigins: 0,
    };
    const restored = meterWith(clock, { initial });

    // 作り直した後の直近の1分は、作り直した後の要求だけを数える（2件では initial の最大 5 を超えない）。
    finish(restored, ALLOWED_URL, 2);
    expect(restored.snapshot().allowedOrigins).toEqual({ count: 12, peakPerMinute: 5 });
    // 作り直した後の1分の件数が initial の最大を超えたら、その件数を最大にする。
    finish(restored, ALLOWED_URL, 4);
    expect(restored.snapshot().allowedOrigins).toEqual({ count: 16, peakPerMinute: 6 });
    expect(restored.snapshot().otherOrigins).toEqual({ count: 4, peakPerMinute: 2 });
  });

  it('initial の値を写して持つ（後から initial を変えても、記録は変わらない）', () => {
    const initial = {
      allowedOrigins: { count: 1, peakPerMinute: 1 },
      otherOrigins: { count: 0, peakPerMinute: 0 },
      servedFromCache: 0,
      withheldOtherOrigins: 0,
    };
    const restored = meterWith(new FakeClock(), { initial });

    initial.allowedOrigins.count = 100;

    expect(restored.snapshot().allowedOrigins.count).toBe(1);
  });
});

describe('LoadMeter の入力の確かめ', () => {
  it('入力がオブジェクトでない、許可 Origin が文字列の配列でない、now が関数でないなら TypeError', () => {
    const { now } = new FakeClock();
    expect(() => createLoadMeter(undefined as unknown as LoadMeterOptions)).toThrow(TypeError);
    expect(() => createLoadMeter({ allowedOrigins: ALLOWED_ORIGIN as unknown as string[], now })).toThrow(TypeError);
    expect(() => createLoadMeter({ allowedOrigins: [1 as unknown as string], now })).toThrow(TypeError);
    expect(() => createLoadMeter({ allowedOrigins: [ALLOWED_ORIGIN], now: 1 as unknown as () => number })).toThrow(TypeError);
  });

  it('initial がオブジェクトでなければ TypeError、値が 0 以上の安全な整数でなければ RangeError', () => {
    const { now } = new FakeClock();
    const base = { allowedOrigins: [ALLOWED_ORIGIN], now };
    expect(() => createLoadMeter({ ...base, initial: null as unknown as RunLoadRequests })).toThrow(TypeError);
    expect(() => createLoadMeter({
      ...base,
      initial: { ...EMPTY_REQUESTS, allowedOrigins: null as unknown as RunLoadRequests['allowedOrigins'] },
    })).toThrow(TypeError);
    for (const invalid of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1' as unknown as number]) {
      expect(() => createLoadMeter({
        ...base,
        initial: { ...EMPTY_REQUESTS, otherOrigins: { count: invalid, peakPerMinute: 0 } },
      })).toThrow(RangeError);
      expect(() => createLoadMeter({
        ...base,
        initial: { ...EMPTY_REQUESTS, allowedOrigins: { count: 0, peakPerMinute: invalid } },
      })).toThrow(RangeError);
      expect(() => createLoadMeter({ ...base, initial: { ...EMPTY_REQUESTS, servedFromCache: invalid } })).toThrow(RangeError);
      expect(() => createLoadMeter({ ...base, initial: { ...EMPTY_REQUESTS, withheldOtherOrigins: invalid } })).toThrow(RangeError);
    }
  });

  it('now() が 0 以上の安全な整数を返さなければ、数える呼び出しが RangeError を投げ、記録を変えない', () => {
    for (const invalid of [-1, 1.5, Number.NaN]) {
      const meter = createLoadMeter({ allowedOrigins: [ALLOWED_ORIGIN], now: () => invalid });
      expect(() => meter.recordRequestFinished(requestKey(), ALLOWED_URL)).toThrow(RangeError);
      expect(() => meter.recordRequestFailed(requestKey(), OTHER_URL, 'net::ERR_FAILED')).toThrow(RangeError);
      expect(meter.snapshot()).toEqual(EMPTY_REQUESTS);
    }
  });
});
