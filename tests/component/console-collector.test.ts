import type { ConsoleMessage, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { ConsoleCollector } from '../../src/evidence/console-collector.js';

/** L2 の前の件数の上限（console 1,000・pageerror 200。定数は LZ-1 で消した）。 */
const MAX_CONSOLE_MESSAGES = 1_000;
const MAX_PAGE_ERRORS = 200;

type Listener = (...arguments_: readonly unknown[]) => void;

class FakePage {
  readonly #listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...arguments_: readonly unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(...arguments_);
    }
  }
}

function consoleMessage(type: string, text: string, url = 'https://fixture.test/page.html'): ConsoleMessage {
  return {
    type: () => type,
    text: () => text,
    location: () => ({ url, lineNumber: 1, columnNumber: 2 }),
  } as unknown as ConsoleMessage;
}

function pageError(name: string, message: string, stack: string | undefined): Error {
  const error = new Error(message);
  error.name = name;
  if (stack === undefined) {
    delete error.stack;
  } else {
    error.stack = stack;
  }
  return error;
}

describe('ConsoleCollector limits', () => {
  it('L2: records every console message beyond the former limit and omits none', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);

    for (let index = 0; index < MAX_CONSOLE_MESSAGES + 25; index += 1) {
      page.emit('console', consoleMessage(index % 2 === 0 ? 'error' : 'warning', `message ${index}`));
    }
    page.emit('console', consoleMessage('log', 'ignored log'));

    const evidence = await handle.snapshot();
    expect(evidence.consoleMessages).toHaveLength(MAX_CONSOLE_MESSAGES + 25);
    expect(evidence.consoleMessages[0]?.text).toBe('message 0');
    expect(evidence.consoleMessages.at(-1)?.text).toBe(`message ${MAX_CONSOLE_MESSAGES + 24}`);
    expect(evidence.omittedConsoleMessageCount).toBe(0);
    expect(evidence.omittedPageErrorCount).toBe(0);
  });

  it('L2: records every page error beyond the former limit and omits none', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);

    for (let index = 0; index < MAX_PAGE_ERRORS + 3; index += 1) {
      page.emit('pageerror', pageError('Error', `failure ${index}`, `Error: failure ${index}`));
    }

    const evidence = await handle.snapshot();
    expect(evidence.pageErrors).toHaveLength(MAX_PAGE_ERRORS + 3);
    expect(evidence.pageErrors.at(-1)?.message).toBe(`failure ${MAX_PAGE_ERRORS + 2}`);
    expect(evidence.omittedPageErrorCount).toBe(0);
    expect(evidence.omittedConsoleMessageCount).toBe(0);
  });

  // URL-LEN・LZ-2: 場所の URL も文も、前の上限より長くても切り詰めない。
  it('keeps the whole console text and the whole location URL', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);
    const longUrl = `https://fixture.test/${'u'.repeat(2_049)}`;
    const longText = 't'.repeat(2_049);

    page.emit('console', consoleMessage('error', longText, longUrl));

    const evidence = await handle.snapshot();
    expect(evidence.consoleMessages[0]).toMatchObject({ text: longText, location: { url: longUrl }, truncated: false });
  });

  it('keeps the whole page error name, message, and stack', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);
    const name = 'N'.repeat(257);
    const message = 'm'.repeat(2_049);
    const stack = 's'.repeat(8_193);

    page.emit('pageerror', pageError(name, message, stack));
    page.emit('pageerror', pageError('TypeError', 'small', undefined));

    const evidence = await handle.snapshot();
    expect(evidence.pageErrors[0]).toEqual({ name, message, stack, truncated: false });
    expect(evidence.pageErrors[1]).toEqual({
      name: 'TypeError',
      message: 'small',
      stack: null,
      truncated: false,
    });
  });

  it('records hostile page error fields without throwing from the event listener', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);
    const hostile = new Error('hidden');
    for (const key of ['name', 'message', 'stack']) {
      Object.defineProperty(hostile, key, {
        get(): string {
          throw new Error(`${key} getter must not be trusted`);
        },
      });
    }

    expect(() => page.emit('pageerror', hostile)).not.toThrow();

    const evidence = await handle.snapshot();
    expect(evidence.pageErrors).toHaveLength(1);
    expect(evidence.pageErrors[0]?.stack).toBeNull();
    expect(typeof evidence.pageErrors[0]?.name).toBe('string');
    expect(typeof evidence.pageErrors[0]?.message).toBe('string');
    expect(JSON.stringify(evidence)).not.toContain('getter must not be trusted');
  });
});
