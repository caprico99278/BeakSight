// T37R-fix-A（Task 37 の設計書 8 章の T37R の行の M-4）: Guard の段階を読む口（`passiveRequestGuardStageOf`。読み取りだけ）と、probe の押す前の
// 凍結の確かめ（`src/interaction/submission-probe.ts` の `interactionFreezeHolds`）がそれを使うこと。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: `BrowserContextFactory` と Guard、127.0.0.1 の自前のサーバ。
// - 口は、凍結の前に `PASSIVE_ACTIVE`、凍結の後に `FROZEN_ACTIVE`、Context を閉じた後に `CLOSED` を返す。Guard のない Context の page は `null`。
// - 口を読んでも、段階も要求の扱いも変わらない（読み取りだけ）。
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import { activateInteractionFreeze, passiveRequestGuardStageOf } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 60_000;
const PAGE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>段階</title><link rel="icon" href="data:,"></head><body><p>段階</p></body></html>';

describe.each(LAUNCHERS)('T37R-fix-A: the Guard stage reader with %s', (_label, launch) => {
  let browser: Browser;
  let server: LoopbackHttpServer | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await server?.close();
    server = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('reads PASSIVE_ACTIVE, FROZEN_ACTIVE and CLOSED through the lifecycle, without changing the stage', async () => {
    server = await startLoopbackHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(PAGE_HTML);
    });
    const config = fastRunConfig(server.origin, '/');
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), TEST_FACTORY_OPTIONS);
    factories.push(factory);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop);
    const page = await factory.createPassivePage(context);
    await page.goto(`${server.origin}/`);
    expect(passiveRequestGuardStageOf(page)).toBe('PASSIVE_ACTIVE');
    expect(passiveRequestGuardStageOf(page)).toBe('PASSIVE_ACTIVE');
    await activateInteractionFreeze(page);
    expect(passiveRequestGuardStageOf(page)).toBe('FROZEN_ACTIVE');
    await factory.closePassiveContext(context);
    expect(passiveRequestGuardStageOf(page)).toBe('CLOSED');
    expect(factory.getSafetyLedger(context).snapshot().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('reads null for a page of a Context without the Guard', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    expect(passiveRequestGuardStageOf(page)).toBeNull();
    await context.close();
  }, TEST_TIMEOUT_MS);
});
