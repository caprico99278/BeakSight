// DEF-100 fix（サイトへの負荷の手順書 `doc/spec/site-load.md` の「ページの読み込みの間隔」）: Guard の、main frame の文書の要求を送った時刻の
// 記録の口（`PassiveRequestGuardOptions.onMainFrameDocumentSent`）と、factory の `navigationPacer` の渡し方を、本物の Guard と Chromium で確かめる。
// - page の main frame の文書の要求ごとに、送った時点（Request の段階で進めた直後）と、応答を受けた時点（Response の段階）に呼ぶ。iframe の文書の
//   要求では呼ばない。最後の呼び出しは、要求がサーバに届いた後である（次の読み込みの間隔の起点が、届いた時刻より前にならない）。
// - 口の例外は違反 `GUARD_DOCUMENT_SENT_RECORD_FAILED` に記録し、読み込みは続ける。関数でない口と、記録の関数を持たない pacer は `TypeError`。
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { NavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { installPassiveRequestGuard } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

/** iframe のないページ。 */
const PLAIN_PATH = '/plain';
/** 同じ Origin の iframe（`FRAME_PATH`）を持つページ。 */
const FRAMED_PATH = '/framed';
const FRAME_PATH = '/frame';
/** `PLAIN_PATH` への 302 のリダイレクト。 */
const REDIRECT_PATH = '/redirect';
/** 1 回の文書の要求で口が呼ばれる回数（送った時点と、応答を受けた時点）。 */
const CALLS_PER_DOCUMENT = 2;

let browser: Browser;
useHeadlessChromium((launched) => {
  browser = launched;
});

const servers: LoopbackHttpServer[] = [];
const factories: BrowserContextFactory[] = [];
afterEach(async () => {
  for (const factory of factories.splice(0)) {
    await factory.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

/** 受け取った要求の path と時刻（`Date.now()`）を記録する、テストの中だけのサーバ。 */
async function startSite(): Promise<{ readonly origin: string; readonly received: { readonly pathname: string; readonly atMs: number }[] }> {
  const received: { pathname: string; atMs: number }[] = [];
  const server = await startLoopbackHttpServer((request, response) => {
    const pathname = (request.url ?? '/').split(/[?#]/u, 1)[0] ?? '/';
    received.push({ pathname, atMs: Date.now() });
    if (pathname === REDIRECT_PATH) {
      response.writeHead(302, { location: PLAIN_PATH });
      response.end();
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(pathname === FRAMED_PATH ? `<p>framed</p><iframe title="frame" src="${FRAME_PATH}"></iframe>` : '<p>page</p>');
  });
  servers.push(server);
  return { origin: server.origin, received };
}

/** 口が呼ばれた時刻（`Date.now()`）を記録する pacer の記録の口だけを持つ部品。 */
function recordingSentPacer(calls: number[]): Pick<NavigationPacer, 'recordDocumentRequestSent'> {
  return {
    recordDocumentRequestSent: () => {
      calls.push(Date.now());
    },
  };
}

function factoryFor(origin: string, navigationPacer: Pick<NavigationPacer, 'recordDocumentRequestSent'>): BrowserContextFactory {
  const config = createTestConfig(origin, '/');
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), { ...TEST_FACTORY_OPTIONS, navigationPacer });
  factories.push(factory);
  return factory;
}

describe('DEF-100 fix: the Guard records the time a main frame document request was sent and answered', () => {
  it('calls the hook when it sends a main frame document and when its response arrives, and not for an iframe document', async () => {
    const site = await startSite();
    const calls: number[] = [];
    const factory = factoryFor(site.origin, recordingSentPacer(calls));
    const config = createTestConfig(site.origin, '/');
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);

    await page.goto(`${site.origin}${PLAIN_PATH}`, { waitUntil: 'load' });
    expect(calls).toHaveLength(CALLS_PER_DOCUMENT);
    const plainArrival = site.received.find(({ pathname }) => pathname === PLAIN_PATH)?.atMs ?? Number.NaN;
    // 最後の呼び出し（応答を受けた時点）は、要求がサーバに届いた後である。
    expect(calls.at(-1)).toBeGreaterThanOrEqual(plainArrival);

    calls.length = 0;
    await page.goto(`${site.origin}${FRAMED_PATH}`, { waitUntil: 'load' });
    // iframe の文書の要求もサーバに届くが、口は main frame の文書の要求の分だけ呼ばれる。
    expect(site.received.map(({ pathname }) => pathname)).toContain(FRAME_PATH);
    expect(calls).toHaveLength(CALLS_PER_DOCUMENT);

    calls.length = 0;
    await page.goto(`${site.origin}${REDIRECT_PATH}`, { waitUntil: 'load' });
    // リダイレクトの元の要求（302 の応答を含む）と先の要求の、どちらも送った時点と応答を受けた時点で呼ばれる。最後の呼び出しは、リダイレクトの
    // 先がサーバに届いた後である。
    expect(calls).toHaveLength(2 * CALLS_PER_DOCUMENT);
    const redirectedArrival = site.received.filter(({ pathname }) => pathname === PLAIN_PATH).at(-1)?.atMs ?? Number.NaN;
    expect(calls.at(-1)).toBeGreaterThanOrEqual(redirectedArrival);
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
    await factory.closePassiveContext(context);
  });

  it('records GUARD_DOCUMENT_SENT_RECORD_FAILED when the hook throws, and still loads the page', async () => {
    const site = await startSite();
    const factory = factoryFor(site.origin, {
      recordDocumentRequestSent: () => {
        throw new Error('fixture record failure');
      },
    });
    const config = createTestConfig(site.origin, '/');
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);

    const response = await page.goto(`${site.origin}${PLAIN_PATH}`, { waitUntil: 'load' });

    expect(response?.status()).toBe(200);
    expect(await page.textContent('p')).toBe('page');
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual(
      Array.from({ length: CALLS_PER_DOCUMENT }, () => ({ code: 'GUARD_DOCUMENT_SENT_RECORD_FAILED', message: 'fixture record failure' })),
    );
    await factory.closePassiveContext(context);
  });

  it('rejects a hook that is not a function, and a factory pacer without the record function, with TypeError', async () => {
    const site = await startSite();
    const context = await browser.newContext();
    try {
      await expect(installPassiveRequestGuard(context, new SafetyLedger(), new Set([site.origin]), {
        onMainFrameDocumentSent: 'record' as unknown as () => void,
      })).rejects.toThrow(TypeError);
    } finally {
      await context.close();
    }
    expect(() => new BrowserContextFactory(browser, createTestConfig(site.origin, '/'), () => new SafetyLedger(), {
      navigationPacer: {} as unknown as Pick<NavigationPacer, 'recordDocumentRequestSent'>,
    })).toThrow(TypeError);
  });
});
