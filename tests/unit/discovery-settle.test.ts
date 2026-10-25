// T27b（Task 27 の設計書 4.2）: 落ち着きの待ち（`src/discovery/settle.ts`）の単体テスト。
// - 進行中の要求の数え方（`InFlightRequestCounter`。page の `request` で数え、`requestfinished`・`requestfailed` で減らす。数え始める前に始まった
//   要求の終わりは数えない。`dispose` の後は数えない）。
// - 待ちの条件: 「進行中の要求が 0 の状態が決まった時間続く」かつ「2 回続けて同じ候補の集合」。上限を超えたら `TIMED_OUT`。読み取りの失敗は
//   落ち着いていないとみなす。待ちの間に読み込みを足さない（読み取りの関数を呼ぶだけ）。
// テストは、短い時間の指定（`TEST_POLICY`）で動かす。本番の名前つきの定数の値も確かめる。
import { EventEmitter } from 'node:events';
import type { Page, Request } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import {
  DISCOVERY_NETWORK_QUIET_MS,
  DISCOVERY_RESPONSE_BODY_GRACE_MS,
  DISCOVERY_SETTLE_POLICY,
  DISCOVERY_SETTLE_TIMEOUT_MS,
  InFlightRequestCounter,
  waitForDiscoverySettled,
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

  // DEF-127（T37a fix round 1）: ページが応答の本文を読まない要求は、`requestfinished` が来ないことがある（実機で確かめた）。T37R-fix-B（T37R の I-2）:
  // 応答を受けた要求は、応答から猶予（既定 2 秒）までは進行中に数え（本文が遅い応答を待つ）、猶予を過ぎたら外す。静かになった時刻は、猶予の終わり。
  it('keeps a request in flight for the grace after its response, then takes it out at the end of the grace (DEF-127, T37R I-2)', () => {
    vi.useFakeTimers({ now: 10_000 });
    try {
      expect(DISCOVERY_RESPONSE_BODY_GRACE_MS).toBe(2_000);
      const { page, emitter } = fakePage();
      const counter = new InFlightRequestCounter(page);
      const [unread, finished, waiting] = [fakeRequest(), fakeRequest(), fakeRequest()];
      emitter.emit('request', unread);
      emitter.emit('request', finished);
      emitter.emit('request', waiting);
      emitter.emit('response', { request: () => unread });
      emitter.emit('response', { request: () => finished });
      expect(counter.inFlight).toBe(3);
      vi.advanceTimersByTime(500);
      // 本文の終わりが来た要求は、すぐに外れる（2 回目の数え下げにならない）。
      emitter.emit('requestfinished', finished);
      emitter.emit('requestfinished', finished);
      expect(counter.inFlight).toBe(2);
      emitter.emit('requestfailed', waiting);
      expect(counter.inFlight).toBe(1);
      expect(counter.quietSinceMs()).toBeNull();
      vi.advanceTimersByTime(DISCOVERY_RESPONSE_BODY_GRACE_MS - 500 - 1);
      expect(counter.quietSinceMs()).toBeNull();
      vi.advanceTimersByTime(1);
      expect(counter.inFlight).toBe(0);
      expect(counter.quietSinceMs()).toBe(10_000 + DISCOVERY_RESPONSE_BODY_GRACE_MS);
      // 静かになった時刻は、読み直しても変わらない（落ち着きの待ちの「読み取りの間も静か」の比べ）。
      vi.advanceTimersByTime(300);
      expect(counter.quietSinceMs()).toBe(10_000 + DISCOVERY_RESPONSE_BODY_GRACE_MS);
      counter.dispose();
      expect(emitter.listenerCount('response')).toBe(0);
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
});
