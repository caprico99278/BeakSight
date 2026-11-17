/**
 * ずれの確かめ: 口の操作ごと（RB-3。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 2 章 2・3.3、案 4 章 A）。
 * - 同じ場面を、本物の口（`PlaywrightBrowserPort`。テストの既定の Chromium）と偽の口（`createFakeBrowserPort`。`contract-site.ts` の台本）で流し、
 *   同じ答えを返すことを確かめる。ほかのテストは、偽の口の答えを前提として信じる（2 章 3）。
 * - 対象は、今の口にある操作（B・C・P・R・N）。押す・入れる（A）、止める・通す（I）などは、口に足す段で、ここに場面を足す。
 * - Browser はファイルで 1 回だけ起こし、場面ごとに Context を作る（2 章 6）。本物の Chromium の版を上げるときは、この束を両方の Chromium で流す
 *   （`tests/run-suite.mjs chromium-upgrade`）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PlaywrightBrowserPort } from '../../src/browser/playwright/playwright-browser-port.js';
import type { BrowserHandle, BrowserPort, ContextHandle, NetworkEvent, PageEvent, PageHandle } from '../../src/browser/port/browser-port.js';
import { closeTestContexts, isBrowserFaviconRequest, launchHeadlessChromium } from '../helpers/chromium.js';
import { createFakeBrowserPort } from '../helpers/fake-browser-port/fake-browser-port.js';
import { createFakeClock, type FakeClock } from '../helpers/fake-browser-port/fake-clock.js';
import { closedLoopbackOrigin } from '../helpers/loopback-server.js';
import { readPngPixels } from '../helpers/png-pixels.js';
import {
  CONTRACT_PATHS,
  contractStorageStateOf,
  fakeSiteOf,
  HEADING_READER,
  ITEMS_READER,
  REFUSING_READER,
  startContractSite,
  type ContractSite,
} from './contract-site.js';

/** 口の操作の待ち（本物の操作が終わるまでの上限）。 */
const OPERATION_WAIT = Object.freeze({ timeoutMs: 10_000 });
/** 応答しないページの移動の待ち（期限切れを確かめる短い値）。 */
const HANG_WAIT_MS = 300;
const VIEWPORT = Object.freeze({ width: 640, height: 480 });

/** 場面を流す所（本物か偽の口と、その Browser）。 */
interface Arena {
  readonly port: BrowserPort;
  readonly browser: BrowserHandle;
  /** もう 1 つ Browser を起こす（閉じる場面のため）。 */
  readonly launchAnother: () => Promise<BrowserHandle>;
  /** `ms` の間の待ちを含む操作を待つ（偽の口は、偽の時計を進める）。 */
  readonly elapse: <T>(operation: Promise<T>, ms: number) => Promise<T>;
}

type Scene<T> = (arena: Arena, site: ContractSite) => Promise<T>;

let site: ContractSite;
let browser: Browser;
let realPort: PlaywrightBrowserPort;
let realBrowser: BrowserHandle;
const extraBrowsers: Browser[] = [];

beforeAll(async () => {
  site = await startContractSite(`${await closedLoopbackOrigin()}/unreachable`);
  browser = await launchHeadlessChromium();
  realPort = new PlaywrightBrowserPort({
    openContext: (opened, spec) => opened.newContext({
      viewport: spec.viewport,
      ...(spec.storageState === undefined ? {} : { storageState: structuredClone(spec.storageState) as never }),
    }),
  });
  realBrowser = realPort.adoptBrowser(browser);
});

afterEach(async () => {
  await closeTestContexts(browser);
});

afterAll(async () => {
  await Promise.all(extraBrowsers.map((extra) => extra.close().catch(() => undefined)));
  await browser?.close();
  await site?.close();
});

const realArena = (): Arena => ({
  port: realPort,
  browser: realBrowser,
  launchAnother: async () => {
    const another = await launchHeadlessChromium();
    extraBrowsers.push(another);
    return realPort.adoptBrowser(another);
  },
  elapse: (operation) => operation,
});

const fakeArena = (): Arena => {
  const clock: FakeClock = createFakeClock();
  const port = createFakeBrowserPort({ clock, site: fakeSiteOf(site) });
  return {
    port,
    browser: port.launch(),
    launchAnother: () => Promise.resolve(port.launch()),
    elapse: async (operation, ms) => {
      await clock.advance(ms);
      return operation;
    },
  };
};

/** 同じ場面を本物と偽の口で流し、答えが同じことを確かめる（本物の答えを返す）。 */
const expectSameAnswers = async <T>(scene: Scene<T>): Promise<T> => {
  const real = await scene(realArena(), site);
  const fake = await scene(fakeArena(), site);
  expect(real).toEqual(fake);
  return real;
};

const doneValue = <T>(outcome: { readonly status: string; readonly value?: T }): T => {
  if (outcome.status !== 'DONE' || outcome.value === undefined) {
    throw new Error(`the port operation did not finish: ${outcome.status}`);
  }
  return outcome.value;
};

const openContextAndPage = async (
  { port, browser: handle }: Arena,
  spec: Parameters<BrowserPort['createContext']>[1] = { viewport: VIEWPORT },
): Promise<{ readonly context: ContextHandle; readonly page: PageHandle }> => {
  const context = doneValue(await port.createContext(handle, spec, OPERATION_WAIT));
  return { context, page: doneValue(await port.openPage(context, OPERATION_WAIT)) };
};

const url = (path: string): string => `${site.origin}${path}`;
const LOAD = Object.freeze({ waitUntil: 'load', ...OPERATION_WAIT } as const);

describe('RB-3: the real browser port answers as the fake browser port', () => {
  it('B: a Browser is connected with a version, and after closing it a Context cannot be created', async () => {
    await expectSameAnswers(async ({ port, launchAnother }) => {
      const another = await launchAnother();
      const before = { version: port.browserVersion(another) !== '', connected: port.isBrowserConnected(another) };
      const closed = await port.closeBrowser(another, OPERATION_WAIT);
      return { before, closed, connected: port.isBrowserConnected(another), create: await port.createContext(another, { viewport: VIEWPORT }, OPERATION_WAIT) };
    });
  });

  it('C: closing a Context closes its page once, and the closed Context opens no page and reads no state', async () => {
    await expectSameAnswers(async (arena) => {
      const { port } = arena;
      const { context, page } = await openContextAndPage(arena);
      const events: PageEvent['kind'][] = [];
      port.onPageEvent(page, (event) => events.push(event.kind));
      const pagesBefore = port.contextPages(context).length;
      const closed = await port.closeContext(context, OPERATION_WAIT);
      return {
        pagesBefore,
        closed,
        events,
        pageClosed: port.isPageClosed(page),
        pagesAfter: port.contextPages(context).length,
        open: await port.openPage(context, OPERATION_WAIT),
        state: await port.readStorageState(context, OPERATION_WAIT),
      };
    });
  });

  it('C3: the storage state given to a Context is read back in the same shape', async () => {
    await expectSameAnswers(async (arena) => {
      const { context } = await openContextAndPage(arena, { viewport: VIEWPORT, storageState: contractStorageStateOf(site.origin) });
      return arena.port.readStorageState(context, OPERATION_WAIT);
    });
  });

  it('P2: navigation answers the response after redirects, the body, a 404 with an empty body, NET_ERROR and TIMED_OUT', async () => {
    await expectSameAnswers(async (arena) => {
      const { port, elapse } = arena;
      const { page } = await openContextAndPage(arena);
      const top = await port.navigate(page, url(CONTRACT_PATHS.top), LOAD);
      const topUrl = port.pageUrl(page);
      const loaded = await port.waitForLoadState(page, 'load', OPERATION_WAIT);
      return {
        top,
        topUrl,
        loaded,
        redirect: await port.navigate(page, url(CONTRACT_PATHS.redirect), LOAD),
        robots: await port.navigate(page, url(CONTRACT_PATHS.robots), { ...LOAD, readBody: true }),
        missing: await port.navigate(page, url(CONTRACT_PATHS.missing), { ...LOAD, readBody: true }),
        unreachable: await port.navigate(page, site.unreachableUrl, LOAD),
        hang: await elapse(port.navigate(page, url(CONTRACT_PATHS.hang), { waitUntil: 'load', timeoutMs: HANG_WAIT_MS }), HANG_WAIT_MS),
      };
    });
  });

  it('P: the frames are listed with their parents, and the page events arrive in order', async () => {
    await expectSameAnswers(async (arena) => {
      const { port } = arena;
      const { page } = await openContextAndPage(arena);
      await port.navigate(page, url(CONTRACT_PATHS.frames), LOAD);
      const frames = port.frames(page);
      const events: PageEvent[] = [];
      port.onPageEvent(page, (event) => {
        if (event.kind !== 'framenavigated' || event.isMainFrame) {
          events.push(event);
        }
      });
      await port.navigate(page, url(CONTRACT_PATHS.events), LOAD);
      await vi.waitFor(() => expect(events.map(({ kind }) => kind)).toContain('pageerror'), OPERATION_WAIT.timeoutMs);
      return { frames, events };
    });
  });

  it('R: the readers answer in both worlds, the isolated world is not forged by the page, and a closed page is PAGE_GONE', async () => {
    const answers = await expectSameAnswers(async (arena) => {
      const { port } = arena;
      const { page } = await openContextAndPage(arena);
      await port.navigate(page, url(CONTRACT_PATHS.top), LOAD);
      const main = await port.read(page, HEADING_READER, null, { world: 'MAIN', ...OPERATION_WAIT });
      const isolated = await port.read(page, HEADING_READER, null, { world: 'ISOLATED', ...OPERATION_WAIT });
      const refused = await port.read(page, REFUSING_READER, null, { world: 'MAIN', ...OPERATION_WAIT });
      const first = doneValue(await port.readElements(page, ITEMS_READER, null, OPERATION_WAIT));
      const second = doneValue(await port.readElements(page, ITEMS_READER, null, OPERATION_WAIT));
      const { page: forgedPage } = await openContextAndPage(arena);
      await port.navigate(forgedPage, url(CONTRACT_PATHS.forged), LOAD);
      const forged = await port.read(forgedPage, HEADING_READER, null, { world: 'ISOLATED', ...OPERATION_WAIT });
      await port.closePage(page, OPERATION_WAIT);
      return {
        main,
        isolated,
        refused,
        forged,
        items: first.value,
        paths: first.elements.map(({ path }) => path),
        sameElements: first.elements.map(({ backendNodeId }) => backendNodeId).join() === second.elements.map(({ backendNodeId }) => backendNodeId).join(),
        backendNodeIds: first.elements.every(({ backendNodeId }) => Number.isSafeInteger(backendNodeId) && backendNodeId > 0),
        goneRead: await port.read(page, HEADING_READER, null, { world: 'MAIN', ...OPERATION_WAIT }),
        goneElements: await port.readElements(page, ITEMS_READER, null, OPERATION_WAIT),
      };
    });
    expect(answers.sameElements && answers.backendNodeIds).toBe(true);
  });

  it('R6: a screenshot of the viewport is written', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'beaksight-contract-'));
    try {
      const outputPath = join(directory, 'viewport.png');
      await expectSameAnswers(async (arena) => {
        const { page } = await openContextAndPage(arena);
        await arena.port.navigate(page, url(CONTRACT_PATHS.top), LOAD);
        return arena.port.screenshot(page, { fullPage: false, outputPath, ...OPERATION_WAIT });
      });
      const image = readPngPixels(outputPath);
      expect({ width: image.width, height: image.height }).toEqual(VIEWPORT);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('N1: the requests of a page arrive in order with their facts, and end in a response or a failure', async () => {
    await expectSameAnswers(async (arena) => {
      const { port } = arena;
      const { page } = await openContextAndPage(arena);
      const events: NetworkEvent[] = [];
      port.onNetwork(page, (event) => events.push(event));
      await port.navigate(page, url(CONTRACT_PATHS.network), LOAD);
      const ownRequests = (): readonly Extract<NetworkEvent, { kind: 'request' }>[] => events
        .filter((event): event is Extract<NetworkEvent, { kind: 'request' }> => event.kind === 'request')
        .filter(({ method, url: requestUrl }) => !isBrowserFaviconRequest(method, requestUrl, site.origin));
      const endsOf = (id: string): readonly string[] => events
        .filter((event) => event.kind !== 'request' && event.id === id)
        .map((event) => (event.kind === 'response' ? `response ${String(event.status)}` : event.kind === 'failed' ? `failed ${event.errorText}` : event.kind));
      await vi.waitFor(() => expect(ownRequests().map(({ id }) => endsOf(id).length > 0 && endsOf(id).at(-1) !== 'response 200')).toEqual([true, true, true]), OPERATION_WAIT.timeoutMs);
      return ownRequests().map(({ id, method, url: requestUrl, resourceType, isNavigation, isMainFrame, redirectedFromId, pageId }) => ({
        method,
        url: requestUrl,
        resourceType,
        isNavigation,
        isMainFrame,
        redirected: redirectedFromId !== null,
        onPage: pageId === page.id,
        ends: endsOf(id),
      }));
    });
  });
});
