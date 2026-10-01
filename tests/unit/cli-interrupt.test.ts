// R5b（中断した Run の再開の設計書 4.7 の「シグナル」、4.7.1）: CLI は、SIGINT・SIGTERM・SIGHUP を受ける。1回目は、文言を標準エラーに
// 書いて止める印を付け（今のページを終えてから止まる）、2回目は、文言を書き終えてから、終了コード 5（INTERRUPTED）ですぐに終える。
// 3回目以降は、何もしない。どのシグナルも、同じ数え方にする。
// 本物の `process` には登録しない（テストのプロセスの振る舞いを変えないため）。偽の `EventEmitter` に登録して、`emit` で確かめる。
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { INTERRUPT_SIGNALS, createInterruptHandler, registerInterruptHandlers } from '../../src/cli/interrupt.js';
import { joinLines } from '../../src/cli/output.js';
import type { CliOutput } from '../../src/cli/output-stream.js';
import { CLI_TEXT } from '../../src/presentation/messages.js';
import { createDeferred, type Deferred } from '../helpers/deferred.js';

/** 1回目のシグナルで、標準エラーに書く文字列。 */
const FIRST_SIGNAL_TEXT = joinLines([CLI_TEXT.interrupt.stopRequested]);
/** 2回目のシグナルで、標準エラーに書く文字列。 */
const SECOND_SIGNAL_TEXT = joinLines([CLI_TEXT.interrupt.exitingNow]);

/**
 * 書き込みの終わりを、テストが決める標準エラー。`write` は、書いた文字列を記録し、`release` を呼ぶまで解決しない。
 */
interface ControlledStderr {
  readonly output: CliOutput;
  readonly texts: string[];
  /** まだ解決していない書き込みを、書いた順に、すべて解決する。 */
  release(): void;
}

const controlledStderr = (): ControlledStderr => {
  const texts: string[] = [];
  const pending: Deferred<void>[] = [];
  return {
    output: {
      write: (text) => {
        texts.push(text);
        const written = createDeferred<void>();
        pending.push(written);
        return written.promise;
      },
    },
    texts,
    release: () => {
      for (const written of pending.splice(0)) {
        written.resolve();
      }
    },
  };
};

/** 解決済みの Promise の続き（`then` の処理）が、すべて走り終わるのを待つ。 */
const flushPromises = (): Promise<void> => new Promise((resolveLater) => setImmediate(resolveLater));

/** 偽の `EventEmitter` に受け手を登録した、テストの1組。 */
const setUp = () => {
  const target = new EventEmitter();
  const controller = new AbortController();
  const stderr = controlledStderr();
  const exits: number[] = [];
  registerInterruptHandlers(target, createInterruptHandler({ controller, stderr: stderr.output, exit: (code) => { exits.push(code); } }));
  return { target, controller, stderr, exits };
};

/** テストの前の、本物の `process` のシグナルの受け手の数。 */
let processListenerCounts: readonly number[] = [];
const countProcessListeners = (): readonly number[] => INTERRUPT_SIGNALS.map((signal) => process.listenerCount(signal));

beforeEach(() => {
  processListenerCounts = countProcessListeners();
});

afterEach(() => {
  // テストは、本物の `process` に受け手を登録しない。
  expect(countProcessListeners()).toEqual(processListenerCounts);
});

describe('CLI interrupt: the signals', () => {
  it('receives exactly SIGINT, SIGTERM and SIGHUP, and the list is frozen', () => {
    expect(INTERRUPT_SIGNALS).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    expect(Object.isFrozen(INTERRUPT_SIGNALS)).toBe(true);
  });

  it('registers one handler for each signal of the list on the given target', () => {
    const { target } = setUp();

    for (const signal of INTERRUPT_SIGNALS) {
      expect(target.listenerCount(signal), signal).toBe(1);
    }
    expect(target.eventNames().sort()).toEqual([...INTERRUPT_SIGNALS].sort());
  });
});

describe('CLI interrupt: the first, second and later signals', () => {
  it('on the first SIGINT, writes the message to stderr and sets the stop signal, without exiting', async () => {
    const { target, controller, stderr, exits } = setUp();

    target.emit('SIGINT');

    expect(stderr.texts).toEqual([FIRST_SIGNAL_TEXT]);
    // 止める印は、書き込みの終わりを待たずに付ける（今のページの後に止めるため。書き込みが遅れても、止めるのを遅らせない）。
    expect(controller.signal.aborted).toBe(true);
    stderr.release();
    await flushPromises();
    expect(exits).toEqual([]);
  });

  it('on the second SIGINT, writes the message and exits with 5 (INTERRUPTED) only after the write has finished', async () => {
    const { target, stderr, exits } = setUp();

    target.emit('SIGINT');
    target.emit('SIGINT');

    expect(stderr.texts).toEqual([FIRST_SIGNAL_TEXT, SECOND_SIGNAL_TEXT]);
    await flushPromises();
    // 書き込みが終わるまでは、終えない。
    expect(exits).toEqual([]);
    stderr.release();
    await flushPromises();
    expect(exits).toEqual([INTERRUPTED_EXIT_CODE]);
    expect(INTERRUPTED_EXIT_CODE).toBe(5);
  });

  it('does nothing on the third and later signals', async () => {
    const { target, controller, stderr, exits } = setUp();

    target.emit('SIGINT');
    target.emit('SIGINT');
    stderr.release();
    await flushPromises();
    target.emit('SIGINT');
    target.emit('SIGTERM');
    target.emit('SIGHUP');
    stderr.release();
    await flushPromises();

    expect(stderr.texts).toEqual([FIRST_SIGNAL_TEXT, SECOND_SIGNAL_TEXT]);
    expect(exits).toEqual([INTERRUPTED_EXIT_CODE]);
    expect(controller.signal.aborted).toBe(true);
  });

  it('counts every signal of the list together: SIGTERM after SIGINT is the second one', async () => {
    const { target, controller, stderr, exits } = setUp();

    target.emit('SIGINT');
    expect(controller.signal.aborted).toBe(true);
    target.emit('SIGTERM');
    stderr.release();
    await flushPromises();

    expect(stderr.texts).toEqual([FIRST_SIGNAL_TEXT, SECOND_SIGNAL_TEXT]);
    expect(exits).toEqual([INTERRUPTED_EXIT_CODE]);
  });

  it('receives SIGHUP as well (for example, the terminal window is closed): the first sets the stop signal, the second exits', async () => {
    const { target, controller, stderr, exits } = setUp();

    target.emit('SIGHUP');
    expect(stderr.texts).toEqual([FIRST_SIGNAL_TEXT]);
    expect(controller.signal.aborted).toBe(true);
    target.emit('SIGHUP');
    stderr.release();
    await flushPromises();

    expect(stderr.texts).toEqual([FIRST_SIGNAL_TEXT, SECOND_SIGNAL_TEXT]);
    expect(exits).toEqual([INTERRUPTED_EXIT_CODE]);
  });

  it('receives SIGTERM as the first signal too', () => {
    const { target, controller, stderr, exits } = setUp();

    target.emit('SIGTERM');

    expect(stderr.texts).toEqual([FIRST_SIGNAL_TEXT]);
    expect(controller.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
  });

  it('keeps a separate count for each handler', async () => {
    const first = setUp();
    const second = setUp();

    first.target.emit('SIGINT');
    second.target.emit('SIGINT');
    first.stderr.release();
    second.stderr.release();
    await flushPromises();

    expect(first.stderr.texts).toEqual([FIRST_SIGNAL_TEXT]);
    expect(second.stderr.texts).toEqual([FIRST_SIGNAL_TEXT]);
    expect(first.exits).toEqual([]);
    expect(second.exits).toEqual([]);
  });
});
