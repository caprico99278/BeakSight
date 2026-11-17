// L1（設計書 `2026-11-09-beaksight-remove-limits-design.md` 6 の L1）: Page Auditor の段の期限を撤廃し、進みの見張り（L0 の `watchProgress`）につないだことの
// 結合のテスト（既定の Chromium）。
// - 1 つの段が固まるページ（accessibility の段の最中に main thread を止める）: その段だけが「応答しなかった」になり、前の段の記録（console・network
//   を含む）は残り、監査は戻る（同じ Page Auditor で次のページを監査できる）。
// 反応なしの長さは、テストでは短くする（製品は `PROGRESS_WATCH_QUIET_LIMIT_MS`）。
// 読み込みが長く続いても見放さないことは progress-watch の 'waits for a slow page that keeps progressing beyond the quiet limit' が、
// Interaction の候補を段の期限で打ち切らないことは navigation-pacing の 'checks every Interaction candidate after a long wait before the first one' が確かめる。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { EvidenceType, PageAuditOutcome } from '../../src/core/contracts.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor, type PageAuditorDependencies } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS, type TestConfigOverrides } from '../helpers/test-config.js';

const PAGES: Readonly<Record<string, string>> = Object.freeze({
  '/plain': '<!doctype html><html lang="en"><head><title>plain</title></head><body><main><h1>plain</h1><p>text</p></main></body></html>',
});

let browser: Browser;
let server: LoopbackHttpServer | undefined;
const temporaryDirectories: string[] = [];

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  const leftover = testContextsOf(browser);
  for (const context of leftover) {
    await context.close();
  }
  await server?.close();
  server = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
  expect(leftover, 'Contexts left in the browser after the test').toHaveLength(0);
});

const startServer = async (): Promise<LoopbackHttpServer> => {
  server = await startLoopbackHttpServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return server;
};

const normalized = (url: string, config: AuditConfig): NormalizedHttpUrlEvidence => {
  const result = normalizeUrl(url, url, new Set(config.crawl.allowedQueryParameters));
  if (!result.ok) {
    throw new Error(`fixture URL must normalize: ${url}`);
  }
  return result.url;
};

const createAuditor = async (
  origin: string,
  overrides: TestConfigOverrides,
  extra: Partial<Pick<PageAuditorDependencies, 'collectors' | 'progressWatchQuietLimitMs'>> = {},
): Promise<{ readonly auditor: PageAuditor; readonly config: AuditConfig; readonly allocator: IdAllocator }> => {
  const config = createTestConfig(origin, '/', overrides);
  const allocator = new IdAllocator();
  const screenshotRootDirectory = await mkdtemp(join(tmpdir(), 'beaksight-progress-watch-'));
  temporaryDirectories.push(screenshotRootDirectory);
  const auditor = new PageAuditor({
    contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory,
    navigationPacer: createTestNavigationPacer(config),
    safetyViolationRecorded: () => false,
    ...extra,
  });
  return { auditor, config, allocator };
};

const evidenceTypesOf = (outcome: PageAuditOutcome, viewport: 'desktop' | 'mobile'): EvidenceType[] =>
  [...new Set(outcome.result.evidence.filter((record) => record.viewport === viewport).map((record) => record.type))].sort();

const expectPageSchema = async (outcome: PageAuditOutcome): Promise<void> => {
  await expect(validateArtifact('page', JSON.parse(JSON.stringify(outcome.result)) as unknown)).resolves.toEqual({ ok: true });
};

describe('L1: the page auditor stages without deadlines, watched by the progress watch', () => {
  it('ends only the frozen stage as unresponsive, keeps the records of the earlier stages, and goes on to the next page', async () => {
    const { origin } = await startServer();
    const { auditor, config, allocator } = await createAuditor(
      origin,
      { viewports: { stressWidths: [] }, audit: { interactions: false } },
      {
        progressWatchQuietLimitMs: 5_000,
        collectors: {
          // accessibility の段の最中に、ページの main thread を止める（ページの中の JS。BeakSight の main thread ではない）。
          collectAccessibilityEvidence: async (page) => {
            await page.evaluate(() => {
              for (;;) {
                // 止める。
              }
            });
            throw new Error('not reached');
          },
        },
      },
    );

    const outcome = await auditor.audit(normalized(`${origin}/plain`, config), allocator.allocatePageId());

    for (const viewport of ['desktop', 'mobile'] as const) {
      const result = outcome.result.viewports[viewport];
      expect(result.status, viewport).toBe('PARTIAL');
      expect(result.incompleteReasons, viewport).toEqual([{ code: 'STAGE_UNRESPONSIVE', detail: 'accessibility' }]);
      const types = evidenceTypesOf(outcome, viewport);
      for (const type of ['dom', 'layout', 'scroll', 'network', 'console', 'safety'] as const) {
        expect(types, `${viewport} ${type}`).toContain(type);
      }
      expect(types, viewport).not.toContain('accessibility');
    }
    await expectPageSchema(outcome);

    // 次のページへ進める（同じ Page Auditor で、固まらないページを監査する）。
    const { auditor: next, config: nextConfig, allocator: nextAllocator } = await createAuditor(
      origin,
      { viewports: { stressWidths: [] }, audit: { interactions: false } },
      { progressWatchQuietLimitMs: 5_000 },
    );
    const nextOutcome = await next.audit(normalized(`${origin}/plain`, nextConfig), nextAllocator.allocatePageId());
    expect(nextOutcome.result.status).toBe('AUDITED');
  }, 3 * 60_000);
});
