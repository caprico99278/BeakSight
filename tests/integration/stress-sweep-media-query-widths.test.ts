// L14（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 6 の L14、網羅の設計書 3.3）: 幅の走査に、CSS の media query の境目の両側の幅を
// 足すことの結合のテスト（既定の Chromium）。境目のあるページ（`<style>` の `@media` と、`<link media>` の外部の CSS）で、境目の両側の幅を走査する。
// 設定の幅は空にして、足した幅だけを走査させる。サーバは、このテストの中の 127.0.0.1 のサーバだけを使う。
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { NormalizedHttpUrlEvidence } from '../../src/core/evidence-types.js';
import { normalizeUrl } from '../../src/crawl/normalize-url.js';
import { IdAllocator } from '../../src/orchestration/id-allocator.js';
import { PageAuditor } from '../../src/orchestration/page-auditor.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { testContextsOf, useHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { createTestNavigationPacer } from '../helpers/navigation-pacer.js';
import { createTestConfig, TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const TEST_TIMEOUT_MS = 3 * 60_000;

const RESOURCES: Readonly<Record<string, { readonly type: string; readonly body: string }>> = Object.freeze({
  '/responsive': {
    type: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="en"><head><title>responsive</title>'
      + '<style>nav{display:none}@media (min-width: 700px){nav{display:block}}</style>'
      + '<link rel="stylesheet" href="/wide.css" media="(max-width: 1100px)">'
      + '</head><body><main><h1>responsive</h1><nav>menu</nav></main></body></html>',
  },
  '/wide.css': { type: 'text/css; charset=utf-8', body: 'main{padding:1px}' },
  '/plain': {
    type: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="en"><head><title>plain</title></head><body><main><h1>plain</h1></main></body></html>',
  },
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
    const resource = RESOURCES[request.url ?? ''];
    if (resource === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': resource.type }).end(resource.body);
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

const sweptWidthsOf = async (path: string): Promise<readonly number[] | null> => {
  const { origin } = await startServer();
  const config = createTestConfig(origin, '/', {
    viewports: { stressWidths: [] },
    audit: { interactions: false, performance: false, accessibility: false, screenshots: false },
  });
  const allocator = new IdAllocator();
  const root = await mkdtemp(join(tmpdir(), 'beaksight-media-query-widths-'));
  temporaryDirectories.push(root);
  const auditor = new PageAuditor({
    contextFactory: new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS),
    config,
    allocator,
    clock: () => new Date(),
    now: () => Date.now(),
    screenshotRootDirectory: root,
    navigationPacer: createTestNavigationPacer(config),
    safetyViolationRecorded: () => false,
  });
  const outcome = await auditor.audit(normalized(`${origin}${path}`, config), allocator.allocatePageId());
  const layout = outcome.result.evidence.find((record) => record.viewport === 'desktop' && record.type === 'layout');
  const payload = layout?.payload as { readonly stressSweep: readonly { readonly width: number }[] | null } | undefined;
  return payload?.stressSweep?.map((entry) => entry.width) ?? null;
};

describe('L14: the stress sweep adds the widths on both sides of a media query boundary', () => {
  it('sweeps both sides of the boundaries of a style element and a linked stylesheet', async () => {
    // SWR: 広い順に回す。
    expect(await sweptWidthsOf('/responsive')).toEqual([1101, 1100, 700, 699]);
  }, TEST_TIMEOUT_MS);

  it('adds no width to a page without media queries', async () => {
    expect(await sweptWidthsOf('/plain')).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
