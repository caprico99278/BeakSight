/**
 * ずれの確かめ: Browser の lease（RB-5。設計書 `doc/design/2026-11-15-beaksight-test-rebuild-design.md` 3.5、案 6 章 D）。ワーカーは Browser を 1 つだけ
 * 起こし、段ごとには factory と Context だけを作る。段の境で Browser のプロセスごと捨てていた分離を、次の 2 つで保つことを、本物の Chromium で確かめる。
 * - 段の後に、段の Context が Browser に残らない。残した段の後は、lease が Browser を捨て、次の段は起こし直した Browser を借りる。
 * - 借りた Browser でも、段ごとの factory の Worker の自己検査（DEF-044 の Shared Worker）が働く。
 * 口の操作ごとの一覧（`CONTRACT_PORT_TEST_FILES`）に載り、テストの既定の Chromium の回と CLI の Chromium の回（既定の Context を 1 つ持つ）で流れる。
 * Shared Worker を無効にする引数は、自己検査を確かめるために外す（テストの明示の選択 `sharedWorkers: 'allow'`）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import {
  closeBrowserLease,
  createBrowserLease,
  endPreflightBrowser,
  runPreflight,
  type BrowserLease,
  type PreflightSuccess,
} from '../../src/orchestration/preflight.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { launchHeadlessChromium, testContextsOf } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';

const SHARED_WORKER_PATH = '/shared-worker';
const SHARED_WORKER_HTML = '<!doctype html><html><head><title>lease</title></head><body><script>'
  + "new SharedWorker(URL.createObjectURL(new Blob(['onconnect = () => undefined;'], { type: 'text/javascript' })));"
  + '</script></body></html>';

describe('RB-5: the browser lease keeps the stages apart on one Chromium', () => {
  let server: LoopbackHttpServer;
  let config: AuditConfig;
  let outputDirectory: string;
  let lease: BrowserLease;

  /** 段の始まり（lease から借りた Browser で PREFLIGHT を通す）。 */
  const startStage = async (): Promise<PreflightSuccess> => {
    const preflight = await runPreflight({
      config,
      launchBrowser: () => Promise.reject(new Error('a leased stage does not launch its own browser')),
      browserLease: lease,
      createSafetyLedger: () => new SafetyLedger(),
      outputDirectory,
      contextFactoryOptions: TEST_FACTORY_OPTIONS,
    });
    if (!preflight.ok) {
      throw new Error(`preflight failed: ${preflight.message}`);
    }
    return preflight;
  };

  beforeAll(async () => {
    server = await startLoopbackHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      response.end(SHARED_WORKER_HTML);
    });
    config = createTestConfig(server.origin);
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-lease-'));
    lease = createBrowserLease(() => launchHeadlessChromium({ sharedWorkers: 'allow' }));
    // 場面の前の段（Browser を起こす）。
    await endPreflightBrowser(await startStage());
  });

  afterAll(async () => {
    await closeBrowserLease(lease);
    await server?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  it('leaves no context of a stage on the leased browser, and replaces the browser after a stage that left one', async () => {
    const kept = await startStage();
    const browser: Browser = kept.browser;
    await endPreflightBrowser(kept);
    expect(testContextsOf(browser)).toEqual([]);
    expect(browser.isConnected()).toBe(true);

    const leaking = await startStage();
    expect(leaking.browser).toBe(browser);
    await leaking.factory.createPassiveContext(config.viewports.primaryDesktop);
    await endPreflightBrowser(leaking);
    expect(browser.isConnected()).toBe(false);

    const replaced = await startStage();
    expect(replaced.browser).not.toBe(browser);
    expect(testContextsOf(replaced.browser)).toEqual([]);
    await endPreflightBrowser(replaced);
  });

  it('runs the worker self-check of the factory of a later stage on the leased browser', async () => {
    const earlier = await startStage();
    await endPreflightBrowser(earlier);
    const later = await startStage();
    expect(later.browser).toBe(earlier.browser);
    const context = await later.factory.createPassiveContext(config.viewports.primaryDesktop);
    const page = await later.factory.createPassivePage(context);
    await page.goto(`${server.origin}${SHARED_WORKER_PATH}`, { waitUntil: 'load' }).catch(() => undefined);
    const ledger = later.factory.getSafetyLedger(context);
    await expect.poll(() => ledger.snapshot().invariantViolations.map(({ code }) => code)).toContain('SHARED_WORKER_OBSERVED');
    await expect.poll(() => page.isClosed()).toBe(true);
    await endPreflightBrowser(later);
    expect(testContextsOf(later.browser)).toEqual([]);
  });
});
