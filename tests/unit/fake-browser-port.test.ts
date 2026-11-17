// RB-1（設計書 `2026-11-15-beaksight-test-rebuild-design.md` 3.1）: 偽の口（メモリのページ・通信の記録・偽の時計）が、口の型の約束どおりに
// 答えることを確かめる。ブラウザを使わない。本物の口と同じ答えかは、ずれの確かめ（RB-3）が照らす。
import { describe, expect, it } from 'vitest';
import type { NamedPageReader, NetworkEvent, PageEvent } from '../../src/browser/port/browser-port.js';
import { FAKE_UNREACHABLE_NET_ERROR, createFakeBrowserPort, type FakeSite } from '../helpers/fake-browser-port/fake-browser-port.js';
import { createFakeClock } from '../helpers/fake-browser-port/fake-clock.js';

const TOP = 'http://127.0.0.1:1/';
const HANGING = 'http://127.0.0.1:1/hang';
const WAIT = Object.freeze({ timeoutMs: 1_000 });
const VIEWPORT = Object.freeze({ width: 800, height: 600 });

const SITE: FakeSite = Object.freeze({
  [TOP]: {
    finalUrl: `${TOP}home`,
    body: 'User-agent: *',
    answers: { title: { text: 'Home' }, broken: 42 },
    elementAnswers: { title: { value: { text: 'Home' }, elements: [{ backendNodeId: 7, path: [0, 1] }] } },
    requests: [{ url: `${TOP}api`, status: 204 }, { url: `${TOP}gone`, failedWith: 'net::ERR_ABORTED' }],
  },
  [HANGING]: { hangs: true },
});

const TITLE_READER: NamedPageReader<null, string> = Object.freeze({
  id: 'title',
  run: () => ({ text: document.title }),
  parse: (raw: unknown) => (typeof raw === 'object' && raw !== null && typeof (raw as { text?: unknown }).text === 'string'
    ? (raw as { text: string }).text
    : null),
});

const setUp = async () => {
  const clock = createFakeClock();
  const port = createFakeBrowserPort({ clock, site: SITE });
  const browser = port.launch();
  const context = await port.createContext(browser, { viewport: VIEWPORT }, WAIT);
  if (context.status !== 'DONE') {
    throw new Error('context');
  }
  const opened = await port.openPage(context.value, WAIT);
  if (opened.status !== 'DONE') {
    throw new Error('page');
  }
  return { clock, port, browser, context: context.value, page: opened.value };
};

const kindsOf = (events: readonly NetworkEvent[]): readonly string[] => events.map((event) => event.kind);

describe('RB-1: fake browser port', () => {
  it('navigates to a scripted page and records its requests in order, for the context and for the page', async () => {
    const { port, context, page } = await setUp();
    const other = await port.openPage(context, WAIT);
    const pageEvents: NetworkEvent[] = [];
    const contextEvents: NetworkEvent[] = [];
    port.onNetwork(page, (event) => pageEvents.push(event));
    port.onNetwork(context, (event) => contextEvents.push(event));

    await expect(port.navigate(page, TOP, { waitUntil: 'load', timeoutMs: 1_000, readBody: true }))
      .resolves.toEqual({ status: 'RESPONDED', httpStatus: 200, finalUrl: `${TOP}home`, body: 'User-agent: *' });
    expect(port.pageUrl(page)).toBe(`${TOP}home`);
    expect(kindsOf(port.networkLog())).toEqual(['request', 'response', 'finished', 'request', 'response', 'finished', 'request', 'failed']);
    expect(port.networkLog().flatMap((event) => (event.kind === 'request' ? [[event.url, event.isNavigation]] : [])))
      .toEqual([[TOP, true], [`${TOP}api`, false], [`${TOP}gone`, false]]);
    expect(pageEvents).toEqual(port.networkLog());
    expect(contextEvents).toEqual(port.networkLog());

    if (other.status === 'DONE') {
      await port.navigate(other.value, TOP, { waitUntil: 'load', timeoutMs: 1_000 });
    }
    expect(pageEvents).toHaveLength(8);
    expect(contextEvents).toHaveLength(16);
  });

  it('answers NET_ERROR for an unscripted URL and TIMED_OUT for a hanging one only after the fake clock reaches the timeout', async () => {
    const { clock, port, page } = await setUp();
    await expect(port.navigate(page, 'http://127.0.0.1:1/none', { waitUntil: 'load', timeoutMs: 1_000 }))
      .resolves.toEqual({ status: 'NET_ERROR', code: FAKE_UNREACHABLE_NET_ERROR });
    expect(kindsOf(port.networkLog())).toEqual(['request', 'failed']);

    let settled: unknown = 'pending';
    void port.navigate(page, HANGING, { waitUntil: 'load', timeoutMs: 1_000 }).then((outcome) => {
      settled = outcome;
    });
    await clock.advance(999);
    expect(settled).toBe('pending');
    await clock.advance(1);
    expect(settled).toEqual({ status: 'TIMED_OUT' });
  });

  it('reads the recorded answer through the reader parse, and fails closed for a wrong shape, a closed page, and a missing answer', async () => {
    const { port, page } = await setUp();
    await port.navigate(page, TOP, { waitUntil: 'load', timeoutMs: 1_000 });
    await expect(port.read(page, TITLE_READER, null, { world: 'ISOLATED', timeoutMs: 1_000 })).resolves.toEqual({ status: 'DONE', value: 'Home' });
    const elementReader = { id: 'title', run: () => ({ value: null, elements: [] }), parse: TITLE_READER.parse };
    await expect(port.readElements(page, elementReader, null, WAIT))
      .resolves.toEqual({ status: 'DONE', value: { value: 'Home', elements: [{ backendNodeId: 7, path: [0, 1] }] } });
    await expect(port.read(page, { ...TITLE_READER, id: 'broken' }, null, { world: 'MAIN', timeoutMs: 1_000 }))
      .resolves.toEqual({ status: 'FAILED', reason: 'ANSWER_SHAPE' });
    await expect(port.read(page, { ...TITLE_READER, id: 'unknown' }, null, { world: 'MAIN', timeoutMs: 1_000 })).rejects.toThrow(/no answer/u);
    await port.closePage(page, WAIT);
    await expect(port.read(page, TITLE_READER, null, { world: 'MAIN', timeoutMs: 1_000 })).resolves.toEqual({ status: 'PAGE_GONE' });
  });

  it('closes the pages of a closed context and of a crashed page, and returns the stored state', async () => {
    const { port, context, page } = await setUp();
    const events: PageEvent[] = [];
    port.onPageEvent(page, (event) => events.push(event));
    const storageState = { cookies: [], origins: [{ origin: TOP, localStorage: [{ name: 'k', value: 'v' }] }] };
    const stored = await port.createContext(port.launch(), { viewport: VIEWPORT, storageState }, WAIT);
    if (stored.status === 'DONE') {
      // RB-3: 本物と同じく、読んだ状態の Origin は IndexedDB（なければ空）を持つ。
      await expect(port.readStorageState(stored.value, WAIT)).resolves
        .toEqual({ status: 'DONE', value: { ...storageState, origins: [{ ...storageState.origins[0], indexedDB: [] }] } });
    }

    await port.closeContext(context, WAIT);
    expect(events).toEqual([{ kind: 'close' }]);
    expect(port.contextPages(context)).toEqual([]);
    await expect(port.openPage(context, WAIT)).resolves.toEqual({ status: 'PAGE_GONE' });

    const { port: second, page: crashed } = await setUp();
    const crashEvents: PageEvent[] = [];
    second.onPageEvent(crashed, (event) => crashEvents.push(event));
    second.crashPage(crashed);
    expect(crashEvents).toEqual([{ kind: 'crash' }]);
    expect(second.isPageClosed(crashed)).toBe(true);
  });

  it('resolves the sleeps of the fake clock in due order as it advances', async () => {
    const clock = createFakeClock(100);
    const order: string[] = [];
    void clock.sleep(30).then(() => order.push(`b@${String(clock.now())}`));
    void clock.sleep(10).then(() => order.push(`a@${String(clock.now())}`));
    expect(clock.pendingSleepCount()).toBe(2);
    await clock.advance(20);
    expect(order).toEqual(['a@110']);
    await clock.advance(20);
    expect(order).toEqual(['a@110', 'b@130']);
    expect(clock.now()).toBe(140);
    expect(clock.date().getTime()).toBe(140);
  });
});
