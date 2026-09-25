import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitBeforeDeadline, resolveTimeoutMs, wait, yieldMacrotask } from '../../src/core/deadline.js';

const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMacrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('awaitBeforeDeadline', () => {
  it('returns the fulfilled value when the operation settles before the deadline', async () => {
    const result = await awaitBeforeDeadline(Promise.resolve('value'), Date.now() + 10_000);

    expect(result).toEqual({ status: 'FULFILLED', value: 'value' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns the rejection reason instead of throwing when the operation rejects before the deadline', async () => {
    const reason = new Error('evaluation failed');

    const result = await awaitBeforeDeadline(Promise.reject(reason), Date.now() + 10_000);

    expect(result).toEqual({ status: 'REJECTED', reason });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('returns DEADLINE_EXCEEDED when the operation is still pending at the absolute deadline', async () => {
    vi.useFakeTimers();
    const operation = deferred<string>();
    const pending = awaitBeforeDeadline(operation.promise, Date.now() + 100);

    await vi.advanceTimersByTimeAsync(99);
    operation.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    const beforeDeadline = await pending;

    const secondOperation = deferred<string>();
    const secondPending = awaitBeforeDeadline(secondOperation.promise, Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);

    expect(beforeDeadline).toEqual({ status: 'FULFILLED', value: 'late' });
    expect(await secondPending).toEqual({ status: 'DEADLINE_EXCEEDED' });
  });

  it('treats a deadline that has already passed as exceeded even when the operation already settled', async () => {
    await expect(awaitBeforeDeadline(Promise.resolve('ready'), Date.now() - 1)).resolves.toEqual({
      status: 'DEADLINE_EXCEEDED',
    });
    await expect(awaitBeforeDeadline(Promise.reject(new Error('ready')), Date.now())).resolves.toEqual({
      status: 'DEADLINE_EXCEEDED',
    });
  });

  it('fails closed for a non-finite deadline without scheduling a timer', async () => {
    vi.useFakeTimers();

    const results = await Promise.all([
      awaitBeforeDeadline(Promise.resolve(1), Number.NaN),
      awaitBeforeDeadline(Promise.resolve(2), Number.POSITIVE_INFINITY),
      awaitBeforeDeadline(Promise.resolve(3), Number.NEGATIVE_INFINITY),
    ]);

    expect(results).toEqual([
      { status: 'DEADLINE_EXCEEDED' },
      { status: 'DEADLINE_EXCEEDED' },
      { status: 'DEADLINE_EXCEEDED' },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its deadline timer as soon as the operation settles', async () => {
    vi.useFakeTimers();
    const fulfilled = deferred<string>();
    const rejected = deferred<string>();

    const fulfilledResult = awaitBeforeDeadline(fulfilled.promise, Date.now() + 60_000);
    const rejectedResult = awaitBeforeDeadline(rejected.promise, Date.now() + 60_000);
    expect(vi.getTimerCount()).toBe(2);
    fulfilled.resolve('done');
    rejected.reject(new Error('failed'));
    await fulfilledResult;
    await rejectedResult;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report the deadline early when the deadline is beyond the maximum timer delay', async () => {
    vi.useFakeTimers();
    const maximumTimerDelayMs = 2_147_483_647;
    const operation = deferred<string>();
    const pending = awaitBeforeDeadline(operation.promise, Date.now() + maximumTimerDelayMs + 10_000);

    await vi.advanceTimersByTimeAsync(maximumTimerDelayMs + 5_000);
    operation.resolve('still in time');

    await expect(pending).resolves.toEqual({ status: 'FULFILLED', value: 'still in time' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a rejection handler on the operation so a rejection after the deadline is never unhandled', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const expiredWhilePending = deferred<string>();
      const expiredBeforeCall = deferred<string>();

      const pendingResult = await awaitBeforeDeadline(expiredWhilePending.promise, Date.now() + 5);
      const expiredResult = await awaitBeforeDeadline(expiredBeforeCall.promise, Date.now() - 1);
      expiredWhilePending.reject(new Error('late rejection after deadline'));
      expiredBeforeCall.reject(new Error('late rejection after expired call'));
      await drainMacrotasks(5);

      expect(pendingResult).toEqual({ status: 'DEADLINE_EXCEEDED' });
      expect(expiredResult).toEqual({ status: 'DEADLINE_EXCEEDED' });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

describe('wait', () => {
  it('resolves only after the requested delay', async () => {
    vi.useFakeTimers();
    let resolved = false;
    const pending = wait(250).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(resolved).toBe(true);
  });
});

describe('yieldMacrotask', () => {
  it('yields one macrotask so previously scheduled zero-delay timers run first', async () => {
    let timerRan = false;
    setTimeout(() => {
      timerRan = true;
    }, 0);

    await yieldMacrotask();

    expect(timerRan).toBe(true);
  });
});

// P18e（P18a の判断6）: 注入された待つ時間の上限（ms）の検証は、Passive に限らないので、core の期限の部品に汎用の名前で置く。
describe('resolveTimeoutMs', () => {
  it('returns the default when the timeout is omitted', () => {
    expect(resolveTimeoutMs(undefined, 5_000)).toBe(5_000);
  });

  it('returns an injected positive safe integer as it is', () => {
    expect(resolveTimeoutMs(1, 5_000)).toBe(1);
    expect(resolveTimeoutMs(250, 5_000)).toBe(250);
    expect(resolveTimeoutMs(Number.MAX_SAFE_INTEGER, 5_000)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['a numeric string', '100' as unknown as number],
    ['null', null as unknown as number],
  ])('throws RangeError for %s', (_label, value) => {
    expect(() => resolveTimeoutMs(value, 5_000)).toThrow(RangeError);
  });

  it('is the only timeout validation: the passive-only name is gone from src/ (no re-export either)', async () => {
    const sourceRoot = join(repositoryRoot, 'src');
    const sourceFiles = (await readdir(sourceRoot, { recursive: true }))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replaceAll('\\', '/'));
    const mentioning: string[] = [];
    for (const name of sourceFiles) {
      if ((await readFile(join(sourceRoot, name), 'utf8')).includes('passiveTimeoutMs')) {
        mentioning.push(name);
      }
    }

    expect(mentioning).toEqual([]);
  });
});
