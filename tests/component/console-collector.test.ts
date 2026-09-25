import type { ConsoleMessage, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  MAX_CONSOLE_MESSAGES,
  MAX_CONSOLE_TEXT_LENGTH,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_ERROR_NAME_LENGTH,
  MAX_PAGE_ERRORS,
  MAX_STACK_LENGTH,
  MAX_URL_LENGTH,
} from '../../src/core/limits.js';
import { ConsoleCollector } from '../../src/evidence/console-collector.js';

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
  it('bounds the number of console messages and records how many were omitted', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);

    for (let index = 0; index < MAX_CONSOLE_MESSAGES + 25; index += 1) {
      page.emit('console', consoleMessage(index % 2 === 0 ? 'error' : 'warning', `message ${index}`));
    }
    page.emit('console', consoleMessage('log', 'ignored log'));

    const evidence = await handle.snapshot();
    expect(evidence.consoleMessages).toHaveLength(MAX_CONSOLE_MESSAGES);
    expect(evidence.consoleMessages[0]?.text).toBe('message 0');
    expect(evidence.omittedConsoleMessageCount).toBe(25);
    expect(evidence.omittedPageErrorCount).toBe(0);
  });

  it('bounds the number of page errors and records how many were omitted', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);

    for (let index = 0; index < MAX_PAGE_ERRORS + 3; index += 1) {
      page.emit('pageerror', pageError('Error', `failure ${index}`, `Error: failure ${index}`));
    }

    const evidence = await handle.snapshot();
    expect(evidence.pageErrors).toHaveLength(MAX_PAGE_ERRORS);
    expect(evidence.pageErrors[0]?.message).toBe('failure 0');
    expect(evidence.omittedPageErrorCount).toBe(3);
    expect(evidence.omittedConsoleMessageCount).toBe(0);
  });

  it('bounds console text and location URL and marks the truncated message', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);

    page.emit('console', consoleMessage(
      'error',
      't'.repeat(MAX_CONSOLE_TEXT_LENGTH + 100),
      `https://fixture.test/${'u'.repeat(MAX_URL_LENGTH)}`,
    ));
    page.emit('console', consoleMessage('warning', 'short warning'));

    const evidence = await handle.snapshot();
    expect(evidence.consoleMessages[0]?.text).toBe('t'.repeat(MAX_CONSOLE_TEXT_LENGTH));
    expect(evidence.consoleMessages[0]?.location.url).toHaveLength(MAX_URL_LENGTH);
    expect(evidence.consoleMessages[0]?.truncated).toBe(true);
    expect(evidence.consoleMessages[1]).toMatchObject({ text: 'short warning', truncated: false });
  });

  it('bounds page error name, message, and stack and marks the truncated error', async () => {
    const page = new FakePage();
    const handle = ConsoleCollector.attach(page as unknown as Page);

    page.emit('pageerror', pageError(
      'N'.repeat(MAX_ERROR_NAME_LENGTH + 10),
      'm'.repeat(MAX_ERROR_MESSAGE_LENGTH + 10),
      's'.repeat(MAX_STACK_LENGTH + 10),
    ));
    page.emit('pageerror', pageError('TypeError', 'small', undefined));

    const evidence = await handle.snapshot();
    expect(evidence.pageErrors[0]).toEqual({
      name: 'N'.repeat(MAX_ERROR_NAME_LENGTH),
      message: 'm'.repeat(MAX_ERROR_MESSAGE_LENGTH),
      stack: 's'.repeat(MAX_STACK_LENGTH),
      truncated: true,
    });
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
