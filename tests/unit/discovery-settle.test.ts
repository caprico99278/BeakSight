// T27b（Task 27 の設計書 4.2）: 落ち着きの待ち（`src/discovery/settle.ts`）の単体テスト。
// - 進行中の要求の数え方（`InFlightRequestCounter`。page の `request` で数え、`requestfinished`・`requestfailed` で減らす。数え始める前に始まった
//   要求の終わりは数えない。`dispose` の後は数えない）。
// - 待ちの条件: 「進行中の要求が 0 の状態が決まった時間続く」かつ「2 回続けて同じ候補の集合」。上限を超えたら `TIMED_OUT`。読み取りの失敗は
//   落ち着いていないとみなす。待ちの間に読み込みを足さない（読み取りの関数を呼ぶだけ）。
// テストは、短い時間の指定（`TEST_POLICY`）で動かす。本番の名前つきの定数の値も確かめる。
import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { dataQuietnessOf } from '../../src/browser/page-settling.js';
import type { Clock } from '../../src/core/clock.js';
import {
  DISCOVERY_NETWORK_QUIET_MS,
  DISCOVERY_RESPONSE_BODY_GRACE_MS,
  DISCOVERY_SETTLE_POLICY,
  DISCOVERY_SETTLE_TIMEOUT_MS,
  InFlightRequestCounter,
  waitForDiscoverySettled,
  waitForDiscoverySettledWatched,
  type DiscoverySettlePolicy,
  type QuietSource,
} from '../../src/discovery/settle.js';

const TEST_POLICY: DiscoverySettlePolicy = Object.freeze({ timeoutMs: 400, networkQuietMs: 40, pollIntervalMs: 5, probeIntervalMs: 10 });

/** いつも静かな源（決まった時刻から静か）。 */
const quietSince = (since: number): QuietSource => ({ quietSinceMs: () => since });

const fakePage = (): { page: Page; emitter: EventEmitter } => {
  const emitter = new EventEmitter();
  return { page: emitter as unknown as Page, emitter };
};
const fakeRequest = (): Request => ({}) as Request;

describe('T27b: the in-flight request counter', () => {
  it('counts requests from the request event to requestfinished or requestfailed', () => {
    const { page, emitter } = fakePage();
    const counter = new InFlightRequestCounter(page);
    expect(counter.inFlight).toBe(0);
    expect(counter.quietSinceMs()).not.toBeNull();
    const [first, second] = [fakeRequest(), fakeRequest()];
    emitter.emit('request', first);
    emitter.emit('request', second);
    expect(counter.inFlight).toBe(2);
    expect(counter.quietSinceMs()).toBeNull();
    emitter.emit('requestfinished', first);
    expect(counter.inFlight).toBe(1);
    emitter.emit('requestfailed', second);
    expect(counter.inFlight).toBe(0);
    expect(counter.quietSinceMs()).not.toBeNull();
  });

  // DEF-265（T37R の I-2 の形に戻した）: 応答（ヘッダ）を受けた要求は、終わりの事象（`requestfinished`・`requestfailed`）か、応答から
  // `DISCOVERY_RESPONSE_BODY_GRACE_MS` の早いほうまで途中に数える（本文の遅い応答で、描かれる前に読まない）。DEF-127: ページが本文を読まない要求
  // （`fetch(...).catch(...)` など）には終わりの事象が来ないが、猶予の後に外れるので、上限まで待たない。
  const requestOf = (url: string): Request => ({ method: () => 'GET', url: () => url }) as unknown as Request;

  it('takes a request whose body the page never reads as ended after the grace, and settles before the limit (DEF-127, DEF-265)', async () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      const { page, emitter } = fakePage();
      const counter = new InFlightRequestCounter(page);
      const unread = requestOf('http://127.0.0.1/api/ping?t=1');
      emitter.emit('request', unread);
      vi.advanceTimersByTime(100);
      emitter.emit('response', { request: () => unread });
      // 猶予の中は途中に数える。
      vi.advanceTimersByTime(DISCOVERY_RESPONSE_BODY_GRACE_MS - 1);
      expect(counter.quietSinceMs()).toBeNull();
      // 猶予の後は外れる（静かになった時刻は、応答から猶予の後）。
      vi.advanceTimersByTime(1);
      expect(counter.inFlight).toBe(0);
      expect(counter.quietSinceMs()).toBe(10_100 + DISCOVERY_RESPONSE_BODY_GRACE_MS);
      // 本文を読まない fetch のくり返し（返し終えた口）は、静まりを止めない。後から来る本文の終わりは、2 回目の数え下げにならない。
      const again = requestOf('http://127.0.0.1/api/ping?t=2');
      emitter.emit('request', again);
      emitter.emit('response', { request: () => again });
      emitter.emit('requestfinished', unread);
      expect(counter.quietSinceMs()).toBe(10_100 + DISCOVERY_RESPONSE_BODY_GRACE_MS);
      counter.dispose();
      expect(emitter.listenerCount('response')).toBe(0);

      // 落ち着きの待ち（本番の指定）は、本文を読まない要求があっても、上限より前に落ち着く。
      const { page: waitPage, emitter: waitEmitter } = fakePage();
      const waitCounter = new InFlightRequestCounter(waitPage);
      const pending = requestOf('http://127.0.0.1/api/unread');
      waitEmitter.emit('request', pending);
      waitEmitter.emit('response', { request: () => pending });
      const settling = waitForDiscoverySettled(waitCounter, async () => ['a']);
      await vi.advanceTimersByTimeAsync(DISCOVERY_SETTLE_TIMEOUT_MS);
      await expect(settling).resolves.toEqual({ status: 'SETTLED' });
      waitCounter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a request as ended at its end event when the event comes within the grace (DEF-265)', () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      const { page, emitter } = fakePage();
      const counter = new InFlightRequestCounter(page);
      const slow = requestOf('http://127.0.0.1/api/slow');
      emitter.emit('request', slow);
      emitter.emit('response', { request: () => slow });
      vi.advanceTimersByTime(1_500);
      expect(counter.quietSinceMs()).toBeNull();
      emitter.emit('requestfinished', slow);
      expect(counter.inFlight).toBe(0);
      expect(counter.quietSinceMs()).toBe(11_500);
      counter.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores the end of a request that started before it began counting, and stops counting after dispose', () => {
    const { page, emitter } = fakePage();
    const counter = new InFlightRequestCounter(page);
    emitter.emit('requestfinished', fakeRequest());
    expect(counter.inFlight).toBe(0);
    counter.dispose();
    emitter.emit('request', fakeRequest());
    expect(counter.inFlight).toBe(0);
    expect(emitter.listenerCount('request') + emitter.listenerCount('requestfinished') + emitter.listenerCount('requestfailed')).toBe(0);
  });
});

describe('T27b: waiting for the page to settle', () => {
  it('uses the named limits of the design (500 ms of no request in flight, 5 seconds at most)', () => {
    expect(DISCOVERY_NETWORK_QUIET_MS).toBe(500);
    expect(DISCOVERY_SETTLE_TIMEOUT_MS).toBe(5_000);
    expect(DISCOVERY_SETTLE_POLICY).toMatchObject({ timeoutMs: DISCOVERY_SETTLE_TIMEOUT_MS, networkQuietMs: DISCOVERY_NETWORK_QUIET_MS });
    expect(Object.isFrozen(DISCOVERY_SETTLE_POLICY)).toBe(true);
  });

  it('settles after two consecutive reads of the same candidate set while the network is quiet', async () => {
    const reads: string[][] = [['a'], ['a', 'b'], ['a', 'b']];
    let count = 0;
    const outcome = await waitForDiscoverySettled(quietSince(Date.now() - TEST_POLICY.networkQuietMs), async () => {
      const read = reads[Math.min(count, reads.length - 1)] ?? [];
      count += 1;
      return read;
    }, TEST_POLICY);
    expect(outcome).toEqual({ status: 'SETTLED' });
    expect(count).toBe(3);
  });

  it('does not read before the network has been quiet for the window', async () => {
    let quiet: number | null = null;
    const startedAt = Date.now();
    const source: QuietSource = { quietSinceMs: () => quiet };
    setTimeout(() => { quiet = Date.now(); }, TEST_POLICY.networkQuietMs);
    const readTimes: number[] = [];
    const outcome = await waitForDiscoverySettled(source, async () => {
      readTimes.push(Date.now());
      return ['a'];
    }, TEST_POLICY);
    expect(outcome).toEqual({ status: 'SETTLED' });
    expect((readTimes[0] ?? 0) - startedAt).toBeGreaterThanOrEqual(TEST_POLICY.networkQuietMs * 2 - TEST_POLICY.pollIntervalMs);
  });

  it('times out when the candidate set keeps changing, or the reads fail, or the network never gets quiet', async () => {
    let round = 0;
    const changing = await waitForDiscoverySettled(quietSince(0), async () => {
      round += 1;
      return [`a${round}`];
    }, TEST_POLICY);
    expect(changing).toEqual({ status: 'TIMED_OUT' });

    const failing = await waitForDiscoverySettled(quietSince(0), async () => null, TEST_POLICY);
    expect(failing).toEqual({ status: 'TIMED_OUT' });

    let reads = 0;
    const busyStartedAt = Date.now();
    const busy = await waitForDiscoverySettled({ quietSinceMs: () => null }, async () => {
      reads += 1;
      return ['a'];
    }, TEST_POLICY);
    expect(busy).toEqual({ status: 'TIMED_OUT' });
    expect(reads).toBe(0);
    expect(Date.now() - busyStartedAt).toBeGreaterThanOrEqual(TEST_POLICY.timeoutMs);
  });

  it('does not pair two equal reads when a request ran between them (the quiet window starts again)', async () => {
    let quiet: number | null = 0;
    let count = 0;
    const outcome = await waitForDiscoverySettled({ quietSinceMs: () => quiet }, async () => {
      count += 1;
      if (count === 1) {
        // 1 回目の読み取りの後に、要求が始まって終わる（静かな時間が数え直しになる）。
        quiet = Date.now() + TEST_POLICY.probeIntervalMs;
      }
      return ['a'];
    }, TEST_POLICY);
    expect(outcome).toEqual({ status: 'SETTLED' });
    // 1 回目と 2 回目は組にならず、2 回目と 3 回目で落ち着く。
    expect(count).toBe(3);
  });

  it('does not pair two equal reads when a request starts during the second read', async () => {
    let quiet: number | null = 0;
    let count = 0;
    const outcome = await waitForDiscoverySettled({ quietSinceMs: () => quiet }, async () => {
      count += 1;
      if (count === 2) {
        quiet = null;
        setTimeout(() => { quiet = Date.now(); }, TEST_POLICY.probeIntervalMs);
      }
      return ['a'];
    }, TEST_POLICY);
    expect(outcome).toEqual({ status: 'SETTLED' });
    expect(count).toBe(4);
  });

  // L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1）: 進みの見張りの差し込み口。まだ読んだことのない候補の集合だけを中身の進みにし（周期的に
  // 入れ替わる集合は進みにしない）、見張りが段を終えたら（abort）待ちをやめる。
  it('L0: marks content progress only for a candidate set not read before, and stops when the watch ends the stage', async () => {
    const controller = new AbortController();
    const marks: string[] = [];
    let count = 0;
    const outcome = await waitForDiscoverySettled(quietSince(0), async () => {
      count += 1;
      if (count === 6) {
        controller.abort();
      }
      // 2 つの集合を交互に読む（周期的な入れ替わり）。順と重複は問わない。
      return count % 2 === 0 ? ['b', 'a', 'a'] : ['c'];
    }, { ...TEST_POLICY, timeoutMs: 60_000 }, { mark: (kind) => marks.push(kind), signal: controller.signal });
    expect(outcome).toEqual({ status: 'TIMED_OUT' });
    expect(count).toBe(6);
    expect(marks).toEqual(['BROWSER_RESPONSE', 'BROWSER_RESPONSE']);
  });
});

// RB-8（再構築の設計書 2 章 4）: 落ち着きの待ちと進行中の要求の数え方は、差し込んだ時計（`Clock`）で時刻を読み、待つ。本番の長さ（上限 5 秒・本文の猶予 2 秒）でも、
// 壁の時計では待たない。
describe('RB-8: the settle wait and the counter on an injected clock', () => {
  /** 待つたびに、待った分だけ進む時計。 */
  const steppingClock = (startAtMs = 0): Clock => {
    let nowMs = startAtMs;
    return { now: () => nowMs, date: () => new Date(nowMs), sleep: async (ms) => { nowMs += ms; } };
  };

  it('settles or times out by the production policy on the injected clock without waiting on the wall clock', async () => {
    const clock = steppingClock();
    expect(await waitForDiscoverySettled(quietSince(0), async () => ['a'], DISCOVERY_SETTLE_POLICY, undefined, undefined, clock))
      .toEqual({ status: 'SETTLED' });
    expect(clock.now()).toBeGreaterThanOrEqual(DISCOVERY_NETWORK_QUIET_MS);
    let round = 0;
    const changing = steppingClock();
    expect(await waitForDiscoverySettled(quietSince(0), async () => [`a${String(round += 1)}`], DISCOVERY_SETTLE_POLICY, undefined, undefined, changing))
      .toEqual({ status: 'TIMED_OUT' });
    // 壁の時計で待たないことは、場面の時間の見張り（既定 5 秒。上限 5 秒の待ちを 2 回）が確かめる。
    expect(changing.now()).toBeGreaterThanOrEqual(DISCOVERY_SETTLE_TIMEOUT_MS);
  });

  it('takes the response time and the body grace from the injected clock and windows', () => {
    let nowMs = 1_000;
    const clock: Clock = { now: () => nowMs, date: () => new Date(nowMs), sleep: async () => undefined };
    const { page, emitter } = fakePage();
    const counter = new InFlightRequestCounter(page, { clock, responseBodyGraceMs: 30 });
    const unread = { method: () => 'GET', url: () => 'http://127.0.0.1/api/ping' } as unknown as Request;
    emitter.emit('request', unread);
    emitter.emit('response', { request: () => unread });
    nowMs += 29;
    expect(counter.quietSinceMs()).toBeNull();
    nowMs += 1;
    expect(counter.quietSinceMs()).toBe(1_030);
    counter.dispose();
  });
});

// L6/L3-1 の続き（T9。設計者の判断 2026-11-10 の案 A）: 落ち着きの待ちは、時間の上限（`timeoutMs`）でなく、子の見張りで終える。まだ読んだことのない候補の集合を
// 読む間は待ち続け、新しい集合が見張りの長さの間出なければ、待ちだけを終えて `TIMED_OUT`（呼ぶ側は `INCOMPLETE_SETTLE_TIMEOUT` を付けて候補を読む）。
describe('L6/L3-1 (T9): the settle wait ended by a child progress watch', () => {
  /** 前の時間の上限に当たる値（テストの値）と、子の見張りの長さ。 */
  const FORMER_TIMEOUT_MS = 200;
  const CHILD_QUIET_LIMIT_MS = 300;
  const policy: DiscoverySettlePolicy = { ...TEST_POLICY, timeoutMs: FORMER_TIMEOUT_MS };

  it('keeps waiting past the former time limit while new candidate sets keep appearing, and settles once they stop changing', async () => {
    let count = 0;
    const outcome = await waitForDiscoverySettledWatched(quietSince(0), async () => {
      count += 1;
      // 前の時間の上限の倍より長く、新しい集合が出続ける（後から描かれる候補）。その後は同じ集合。
      return count <= 40 ? [`set-${String(count)}`] : ['final'];
    }, policy, { quietLimitMs: CHILD_QUIET_LIMIT_MS });
    expect(outcome).toEqual({ status: 'SETTLED' });
    expect(count).toBeGreaterThan(40);
  });

  // L10 の調べ（`/pop/` の `CDP_SESSION_DETACHED`）: 凍結の中で読み込んだ文書が誤りの画面（`chrome-error://`）に替わると、候補の集合が読めない（場所がない）ので、
  // 子の見張りは新しい集合を見ないまま見張りの長さだけ待っていた。文書が消えたと分かったら（`documentGone`）、待たずに待ちを終える（呼ぶ側は読めなかったとする）。
  it('stops waiting at once when the document is gone (the error page after a blocked move), not after the watch length', async () => {
    const quietLimitMs = 3_000;
    const startedAt = Date.now();
    let gone = false;
    setTimeout(() => { gone = true; }, 100);
    const outcome = await waitForDiscoverySettledWatched(quietSince(0), async () => null, { ...policy, timeoutMs: 60_000 },
      { quietLimitMs, documentGone: () => gone });
    expect(outcome).toEqual({ status: 'TIMED_OUT' });
    expect(Date.now() - startedAt).toBeLessThan(quietLimitMs / 2);
  });

  it('ends only the wait when the candidate sets only alternate (no new set for the watch length)', async () => {
    let count = 0;
    const outcome = await waitForDiscoverySettledWatched(quietSince(0), async () => {
      count += 1;
      return count % 2 === 0 ? ['a'] : ['b'];
    }, { ...policy, timeoutMs: 60_000 }, { quietLimitMs: CHILD_QUIET_LIMIT_MS });
    expect(outcome).toEqual({ status: 'TIMED_OUT' });
  });
});

// L6/L3-1 の続き（設計者の判断 2026-11-10）: 発見の進行中の要求の数え方を、口ごとの静まり（`src/browser/page-settling.ts` の `dataQuietnessOf`）に合わせる。
// 口は `requestEndpointKeyOf`（メソッドと Origin と path）。一度応答を返し終えた口へのくり返し（ポーリング）は、静まりを止めない。新しい口は待つ。
describe('L6/L3-1: the in-flight request counter by endpoint', () => {
  const requestOf = (method: string, url: string): Request => ({ method: () => method, url: () => url }) as unknown as Request;

  it('stays quiet while a request repeats to an endpoint that has already answered (polling)', () => {
    const { page, emitter } = fakePage();
    const counter = new InFlightRequestCounter(page);
    const first = requestOf('GET', 'http://127.0.0.1/api/items?page=1');
    emitter.emit('request', first);
    expect(counter.quietSinceMs()).toBeNull();
    emitter.emit('requestfinished', first);
    const quiet = counter.quietSinceMs();
    expect(quiet).not.toBeNull();
    // 同じ口へのくり返し（query だけ違う）。
    const again = requestOf('GET', 'http://127.0.0.1/api/items?page=2');
    emitter.emit('request', again);
    expect(counter.quietSinceMs()).toBe(quiet);
    const activity = counter.dataActivity();
    expect(activity.endpoints?.inFlight).toHaveLength(1);
    expect(dataQuietnessOf(activity).pending).toBe(0);
    emitter.emit('requestfinished', again);
    // くり返しの終わりは、静かになった時刻を動かさない。
    expect(counter.quietSinceMs()).toBe(quiet);
  });

  it('waits for a request to an endpoint that has not answered yet', () => {
    const { page, emitter } = fakePage();
    const counter = new InFlightRequestCounter(page);
    const first = requestOf('GET', 'http://127.0.0.1/api/items');
    emitter.emit('request', first);
    emitter.emit('requestfinished', first);
    const other = requestOf('GET', 'http://127.0.0.1/api/other');
    emitter.emit('request', other);
    expect(counter.quietSinceMs()).toBeNull();
    expect(dataQuietnessOf(counter.dataActivity()).pending).toBe(1);
    // 同じ path でも、メソッドが違えば別の口。
    emitter.emit('requestfinished', other);
    emitter.emit('request', requestOf('POST', 'http://127.0.0.1/api/items'));
    expect(counter.quietSinceMs()).toBeNull();
  });

  // COV-4 の決まり（`dataQuietnessOf` の `failed`）に揃える: 失敗で終わった口も終わった口に入れる。失敗し続ける口へのくり返しで、静まらなくならない。
  it('stays quiet while a request repeats to an endpoint that has already ended in failure', () => {
    const { page, emitter } = fakePage();
    const counter = new InFlightRequestCounter(page);
    const blocked = requestOf('POST', 'http://127.0.0.1/api/save');
    emitter.emit('request', blocked);
    expect(counter.quietSinceMs()).toBeNull();
    emitter.emit('requestfailed', blocked);
    const quiet = counter.quietSinceMs();
    emitter.emit('request', requestOf('POST', 'http://127.0.0.1/api/save'));
    expect(counter.quietSinceMs()).toBe(quiet);
    const activity = counter.dataActivity();
    expect(activity.endpoints?.failed).toEqual([JSON.stringify(['POST', 'http://127.0.0.1', '/api/save'])]);
    expect(dataQuietnessOf(activity).pending).toBe(0);
  });
});
