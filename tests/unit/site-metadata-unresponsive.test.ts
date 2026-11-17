// DEF-245 の 4: robots.txt・sitemap.xml の取得が、期限なしで進みの見張りに「全く反応がない」で終えられたら、その読み込みの観測を時間切れとして受け口
// （`afterNavigation`）へ渡す（Run Coordinator が、サイトが応答しないと判定し、残りを 180 秒ずつ待たずに Run を止める判定へ進む）。ブラウザを使わない。
import { EventEmitter } from 'node:events';
import type { BrowserContext, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { MainFrameLoadObservation } from '../../src/browser/main-frame-load.js';
import { createPageId } from '../../src/core/ids.js';
import { collectSiteMetadata } from '../../src/crawl/site-metadata.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:9';

/** 読み込み（`goto`）が返らず、何の事象も出さない偽のページと、それを作る偽の factory（応答しないサイト）。 */
function hangingFactory(): BrowserContextFactory {
  const events = new EventEmitter();
  const frame = {};
  const context = { close: async () => undefined, pages: () => [page] } as unknown as BrowserContext;
  const page = {
    on: (name: string, listener: (...args: unknown[]) => void) => events.on(name, listener),
    off: (name: string, listener: (...args: unknown[]) => void) => events.off(name, listener),
    mainFrame: () => frame,
    goto: () => new Promise(() => undefined),
    isClosed: () => false,
    close: async () => undefined,
    context: () => context,
  } as unknown as Page;
  const ledger = new SafetyLedger();
  return {
    createPassiveContext: async () => context,
    createPassivePage: async () => page,
    getSafetyLedger: () => ledger,
  } as unknown as BrowserContextFactory;
}

describe('the site metadata of a site that does not respond (DEF-245)', () => {
  it('passes a time-out observation to the receiver when the progress watch ends the load as unresponsive', async () => {
    const observations: MainFrameLoadObservation[] = [];
    await collectSiteMetadata({
      contextFactory: hangingFactory(),
      origin: ORIGIN,
      config: createTestConfig(ORIGIN, '/'),
      pageId: createPageId(1),
      allocator: new IdAllocator(),
      clock: () => new Date(),
      beforeNavigation: async () => 0,
      afterNavigation: (observation) => observations.push(observation),
      quietLimitMs: 50,
    });
    expect(observations[0]).toMatchObject({ navigationOutcome: 'TIMEOUT', httpStatus: null });
  });
});
