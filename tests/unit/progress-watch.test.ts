// L0（設計書 `2026-11-09-beaksight-remove-limits-design.md` 5 の 1・6 の L0）: 進みの見張りの部品（`src/core/progress-watch.ts`）の単体のテスト。
// 偽の時計（vitest の fake timers。`Date.now` も進める）で、次を確かめる。
// - 進み（中身の進み）が続く間は、反応なしの長さを何倍超えても終えない。
// - 全く反応がない状態が反応なしの長さ続くと、「応答しなかった」で終える。
// - 中身の進みがなく、ページの自発の変化（通信・画面の変化）だけが続くと、「静まらない」で終える。
// - Run の時間の上限（指定したときだけ）で、段の途中でも終える。
// - 終えた段の理由は、閉じた一覧の理由（`STAGE_UNRESPONSIVE`・`STAGE_NEVER_QUIET`）で記録し、表示のカタログに文がある。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INCOMPLETE_REASON_CODES, isIncompleteReason } from '../../src/core/contracts.js';
import {
  PROGRESS_SIGNAL_KINDS,
  PROGRESS_WATCH_END_REASON_CODES,
  PROGRESS_WATCH_QUIET_LIMIT_MS,
  progressWatchEndReason,
  watchProgress,
  withReadPartSignals,
  type ProgressSignals,
} from '../../src/core/progress-watch.js';
import { readInParts } from '../../src/core/read-in-parts.js';
import { describeIncompleteReason, nextStepOfIncompleteReason } from '../../src/presentation/messages.js';

const LIMIT_MS = 1_000;

/** `ms` だけ偽の時計を進める（タイマーと、その後の Promise の続きを流す）。 */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};

/** 呼ぶまで終わらない段（外から `finish` で終える）。 */
const pendingWork = <T>(): { readonly promise: Promise<T>; readonly finish: (value: T) => void } => {
  let finish: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
};

describe('progress watch (L0)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has a named quiet limit of tens of seconds to a few minutes', () => {
    expect(PROGRESS_WATCH_QUIET_LIMIT_MS).toBeGreaterThanOrEqual(30_000);
    expect(PROGRESS_WATCH_QUIET_LIMIT_MS).toBeLessThanOrEqual(5 * 60_000);
    expect(PROGRESS_SIGNAL_KINDS).toEqual(['BROWSER_RESPONSE', 'READ_PART', 'PAGE_NETWORK', 'DOM_CHANGE']);
  });

  it('does not end the stage while content progress continues, even far beyond the quiet limit', async () => {
    const work = pendingWork<string>();
    let signals: ProgressSignals | undefined;
    const watched = watchProgress((given) => {
      signals = given;
      return work.promise;
    }, { quietLimitMs: LIMIT_MS });
    // 反応なしの長さの 20 倍の間、長さの半分ごとに中身の進み（ブラウザの応答と、分けて読む回）がある。
    for (let index = 0; index < 40; index += 1) {
      await advance(LIMIT_MS / 2);
      signals?.mark(index % 2 === 0 ? 'BROWSER_RESPONSE' : 'READ_PART');
    }
    expect(signals?.signal.aborted).toBe(false);
    work.finish('done');
    await expect(watched).resolves.toEqual({ status: 'FULFILLED', value: 'done' });
  });

  it('ends the stage as unresponsive when nothing at all happens for the quiet limit, and aborts the signal', async () => {
    let signals: ProgressSignals | undefined;
    const watched = watchProgress((given) => {
      signals = given;
      return new Promise<never>(() => undefined);
    }, { quietLimitMs: LIMIT_MS });
    await advance(LIMIT_MS - 1);
    expect(signals?.signal.aborted).toBe(false);
    await advance(1);
    await expect(watched).resolves.toEqual({ status: 'ENDED', end: 'STAGE_UNRESPONSIVE' });
    expect(signals?.signal.aborted).toBe(true);
  });

  it('counts the quiet time from the last progress, not from the start', async () => {
    let signals: ProgressSignals | undefined;
    let ended = false;
    const watched = watchProgress((given) => {
      signals = given;
      return new Promise<never>(() => undefined);
    }, { quietLimitMs: LIMIT_MS });
    void watched.then(() => {
      ended = true;
    });
    await advance(LIMIT_MS - 100);
    signals?.track(Promise.resolve('read'));
    await advance(LIMIT_MS - 1);
    expect(ended).toBe(false);
    await advance(100);
    await expect(watched).resolves.toEqual({ status: 'ENDED', end: 'STAGE_UNRESPONSIVE' });
  });

  it('ends the stage as not settling when only the page itself keeps changing without content progress', async () => {
    let signals: ProgressSignals | undefined;
    const watched = watchProgress((given) => {
      signals = given;
      return new Promise<never>(() => undefined);
    }, { quietLimitMs: LIMIT_MS });
    // 時計・アニメーションのような周期的な変化（画面の変化と通信）だけが続く。
    for (let elapsed = 0; elapsed < LIMIT_MS; elapsed += 100) {
      signals?.mark(elapsed % 200 === 0 ? 'DOM_CHANGE' : 'PAGE_NETWORK');
      await advance(100);
    }
    await expect(watched).resolves.toEqual({ status: 'ENDED', end: 'STAGE_NEVER_QUIET' });
    expect(signals?.signal.aborted).toBe(true);
  });

  it('L1: counts the page network and the screen changes as content progress when the stage says so (a load)', async () => {
    const work = pendingWork<string>();
    let signals: ProgressSignals | undefined;
    const watched = watchProgress((given) => {
      signals = given;
      return work.promise;
    }, { quietLimitMs: LIMIT_MS, contentKinds: PROGRESS_SIGNAL_KINDS });
    for (let index = 0; index < 20; index += 1) {
      await advance(LIMIT_MS / 2);
      signals?.mark(index % 2 === 0 ? 'PAGE_NETWORK' : 'DOM_CHANGE');
    }
    work.finish('loaded');
    await expect(watched).resolves.toEqual({ status: 'FULFILLED', value: 'loaded' });
  });

  it('ends the stage at the run time limit only when one is given, even while progress continues', async () => {
    let signals: ProgressSignals | undefined;
    const watched = watchProgress((given) => {
      signals = given;
      return new Promise<never>(() => undefined);
    }, { quietLimitMs: LIMIT_MS, runDeadlineAtMs: Date.now() + 3 * LIMIT_MS });
    for (let elapsed = 0; elapsed < 3 * LIMIT_MS; elapsed += 100) {
      signals?.mark('BROWSER_RESPONSE');
      await advance(100);
    }
    await expect(watched).resolves.toEqual({ status: 'ENDED', end: 'RUN_TIME_LIMIT' });
    // 上限を指定しなければ（null）、上限では終えない。
    const unlimited = pendingWork<number>();
    let unlimitedSignals: ProgressSignals | undefined;
    const unlimitedWatched = watchProgress((given) => {
      unlimitedSignals = given;
      return unlimited.promise;
    }, { quietLimitMs: LIMIT_MS, runDeadlineAtMs: null });
    for (let elapsed = 0; elapsed < 5 * LIMIT_MS; elapsed += 100) {
      unlimitedSignals?.mark('READ_PART');
      await advance(100);
    }
    unlimited.finish(7);
    await expect(unlimitedWatched).resolves.toEqual({ status: 'FULFILLED', value: 7 });
  });

  it('returns a rejection of the stage as REJECTED, and contains a late rejection after the stage ended', async () => {
    await expect(watchProgress(() => Promise.reject(new Error('boom')), { quietLimitMs: LIMIT_MS }))
      .resolves.toMatchObject({ status: 'REJECTED' });
    let rejectLate: (error: Error) => void = () => undefined;
    const watched = watchProgress(() => new Promise<never>((_resolve, reject) => {
      rejectLate = reject;
    }), { quietLimitMs: LIMIT_MS });
    await advance(LIMIT_MS);
    await expect(watched).resolves.toEqual({ status: 'ENDED', end: 'STAGE_UNRESPONSIVE' });
    rejectLate(new Error('late'));
    await advance(0);
  });

  it('marks a read part for every part read through readInParts', async () => {
    const marks: string[] = [];
    const signals: Pick<ProgressSignals, 'mark'> = { mark: (kind) => marks.push(kind) };
    const parts = await readInParts(0, withReadPartSignals(async (cursor: number) => ({ part: cursor, next: cursor < 2 ? cursor + 1 : null }), signals));
    expect(parts).toEqual([0, 1, 2]);
    expect(marks).toEqual(['READ_PART', 'READ_PART', 'READ_PART']);
  });

  it('records the end of a stage with a reason of the closed list, with a catalog sentence', () => {
    expect(PROGRESS_WATCH_END_REASON_CODES).toEqual(['STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET']);
    for (const code of PROGRESS_WATCH_END_REASON_CODES) {
      expect(INCOMPLETE_REASON_CODES).toContain(code);
      // 画面の文は 1 文（句点は文の終わりの 1 つだけ）。
      expect(describeIncompleteReason(code).match(/。/gu)).toHaveLength(1);
      expect(nextStepOfIncompleteReason(code).length).toBeGreaterThan(0);
    }
    expect(progressWatchEndReason('settling', 'STAGE_UNRESPONSIVE')).toEqual({ code: 'STAGE_UNRESPONSIVE', detail: 'settling' });
    expect(progressWatchEndReason('scroll', 'STAGE_NEVER_QUIET')).toEqual({ code: 'STAGE_NEVER_QUIET', detail: 'scroll' });
    // Run の時間の上限は、段の理由（`<段>:MAX_RUNTIME_REACHED`）として記録する。
    expect(progressWatchEndReason('dom', 'RUN_TIME_LIMIT')).toEqual({ code: 'COLLECTOR_INCOMPLETE', detail: 'dom:MAX_RUNTIME_REACHED' });
    for (const end of ['STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET', 'RUN_TIME_LIMIT'] as const) {
      expect(isIncompleteReason(progressWatchEndReason('layout', end))).toBe(true);
      expect(Object.isFrozen(progressWatchEndReason('layout', end))).toBe(true);
    }
  });
});
