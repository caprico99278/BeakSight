// R15c: run.json に記録する環境の事実（Task 14〜17 の設計書 5.5、5.6.7）。
// Node の版、OS、CPU のアーキテクチャ、Playwright と Chromium の版、ビューポートごとの実際の User-Agent を集める。
// User-Agent は、Guard の付いた Passive Context で about:blank を開いて読む（対象のサイトにはアクセスしない）。
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { collectRunEnvironment, readToolVersion } from '../../src/orchestration/environment.js';
import {
  PassiveContextCloseDeadlineError,
  type PassiveSessionCloseFailure,
} from '../../src/orchestration/passive-session-close.js';
import { createRunIdFromTime } from '../../src/orchestration/run-id.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import { browserHangingNewContext } from '../helpers/browser-proxies.js';
import { useHeadlessChromium } from '../helpers/chromium.js';
import { createTestConfig } from '../helpers/test-config.js';

let server: FixtureServer;
let browser: Browser;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

useHeadlessChromium((launched) => {
  browser = launched;
});

afterEach(async () => {
  for (const context of browser.contexts()) {
    await context.close();
  }
  vi.restoreAllMocks();
});

/** 注入する短い期限（ms。DEF-008、R15r-4）。実際の期限（`SESSION_OPEN_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を待たない。 */
const INJECTED_TIMEOUT_MS = 300;
/** 期限を過ぎてから戻るまでの余裕。 */
const RETURN_MARGIN_MS = 5_000;
/** 期限のテストの上限。期限を守らない（既定の期限を待つか、止まり続ける）場合は、この時間で失敗する。 */
const DEADLINE_TEST_TIMEOUT_MS = 2 * INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS + 2_000;

async function packageVersion(url: URL): Promise<string> {
  const manifest = JSON.parse(await readFile(url, 'utf8')) as { readonly version: string };
  return manifest.version;
}

function playwrightPackageUrl(): URL {
  return pathToFileURL(createRequire(import.meta.url).resolve('playwright/package.json'));
}

function recordingLedgers(): { readonly create: () => SafetyLedger; readonly recorded: SafetyLedger[] } {
  return { create: () => new SafetyLedger(), recorded: [] };
}

describe('collectRunEnvironment (R15c)', () => {
  it('collects the Node, OS, Playwright and Chromium facts and a real User-Agent per viewport', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const config = createTestConfig(server.origin);
    const ledgers = recordingLedgers();
    const closeFailures: PassiveSessionCloseFailure[] = [];
    const factory = new BrowserContextFactory(browser, config, ledgers.create);

    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: (ledger) => ledgers.recorded.push(ledger),
      onCloseFailure: (failure) => closeFailures.push(failure),
    });

    expect(environment.nodeVersion).toBe(process.version);
    expect(environment.platform).toBe(process.platform);
    expect(environment.osRelease).toBe(release());
    expect(environment.arch).toBe(process.arch);
    expect(environment.playwrightVersion).toBe(await packageVersion(playwrightPackageUrl()));
    expect(environment.chromiumVersion).toBe(browser.version());
    expect(environment.userAgents.desktop).toMatch(/^Mozilla\/5\.0 .*Chrome\//u);
    expect(environment.userAgents.mobile).toMatch(/^Mozilla\/5\.0 .*Chrome\//u);
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.userAgents)).toBe(true);

    // ビューポートごとに1つの Guard の付いた Context を作り、その Ledger を呼び出し側に渡す。
    // about:blank は Guard に遮断されない（違反も、遮断したナビゲーションも、リクエストもない）。
    expect(ledgers.recorded).toHaveLength(2);
    for (const ledger of ledgers.recorded) {
      const snapshot = ledger.snapshot();
      expect(snapshot.invariantViolationCount).toBe(0);
      expect(snapshot.blockedNavigations).toEqual([]);
      expect(snapshot.blockedRequests).toEqual([]);
    }
    // 作った Context は閉じている。対象のサイトにはアクセスしていない。
    expect(browser.contexts()).toEqual([]);
    expect(server.getRequestObservations()).toEqual([]);
    // 閉じる処理は、どれも期限の中で終わった（RP18 の指摘1）。
    expect(closeFailures).toEqual([]);
  });

  it('matches the environment of the run schema together with the run ID and the tool version', async () => {
    const config = createTestConfig(server.origin);
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger());
    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: () => undefined,
      onCloseFailure: () => undefined,
    });
    const run = {
      schemaVersion: 'run-schema/1.0',
      runId: createRunIdFromTime(new Date('2026-09-24T01:02:03.000Z')),
      toolVersion: await readToolVersion(),
      target: { id: config.target.id },
      startUrl: config.site.startUrl,
      allowedOrigins: [...config.site.allowedOrigins],
      runStatus: 'FAILED',
      startedAt: '2026-09-24T01:02:03.000Z',
      finishedAt: '2026-09-24T01:02:04.000Z',
      discoveredPageCount: 0,
      auditedPageCount: 0,
      partialPageCount: 0,
      failedPageCount: 0,
      skippedPageCount: 0,
      viewportPageCounts: {
        desktop: { audited: 0, partial: 0, failed: 0, skipped: 0 },
        mobile: { audited: 0, partial: 0, failed: 0, skipped: 0 },
      },
      environment,
      effectiveConfig: config,
      safety: {
        guardEnabled: true,
        blockedRequestsByMethod: {},
        blockedActions: { requests: 0, navigations: 0, externalActions: 0, popups: 0, downloads: 0, webSockets: 0 },
        excludedInteractionCandidateCount: 0,
        invariantViolationCount: 0,
        invariantViolations: [],
        recordTruncated: false,
      },
      unverifiedInteractionCount: 0,
      unverifiedInternalLinkCount: 0,
      retries: [],
      crawlLimits: { maxPagesReached: false, maxDepthReached: false, maxRuntimeReached: false },
      incompleteReasons: [{ code: 'PREFLIGHT_FAILED', detail: 'BROWSER_LAUNCH' }],
    } satisfies RunSummary;

    await expect(validateArtifact('run', run)).resolves.toEqual({ ok: true });
  });

  it('records null for Chromium and the User-Agents when no browser was launched', async () => {
    const recorded: SafetyLedger[] = [];

    const environment = await collectRunEnvironment({
      config: createTestConfig(server.origin),
      browser: null,
      factory: null,
      onSafetyLedger: (ledger) => recorded.push(ledger),
      onCloseFailure: () => undefined,
    });

    expect(environment.chromiumVersion).toBeNull();
    expect(environment.userAgents).toEqual({ desktop: null, mobile: null });
    expect(environment.nodeVersion).toBe(process.version);
    expect(recorded).toEqual([]);
  });

  it('records null for a User-Agent that could not be read and still hands over the Ledger with the violation', async () => {
    server.resetRequestObservations();
    const config = createTestConfig(server.origin);
    const recorded: SafetyLedger[] = [];
    // page が開いている Context では、Guard の取り付けが失敗する（Guard が Context を閉じる）。
    const factory = new BrowserContextFactory(
      browserOpeningPageAfterNewContext(browser),
      config,
      () => new SafetyLedger(),
    );

    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: (ledger) => recorded.push(ledger),
      onCloseFailure: () => undefined,
    });

    expect(environment.userAgents).toEqual({ desktop: null, mobile: null });
    expect(environment.chromiumVersion).toBe(browser.version());
    expect(recorded).toHaveLength(2);
    for (const ledger of recorded) {
      expect(ledger.snapshot().invariantViolations.map((violation) => violation.code)).toContain('GUARD_INSTALLATION_FAILED');
    }
    expect(browser.contexts()).toEqual([]);
    expect(server.getRequestObservations()).toEqual([]);
  });

  // R15 の Minor-2: User-Agent を読む `page.evaluate` が終わらない場合は、期限（`crawl.navigationTimeoutMs`）で見切り、null にする。
  it('records null for a User-Agent whose evaluation does not finish before the navigation timeout', async () => {
    const navigationTimeoutMs = 1_000;
    const config = createTestConfig(server.origin, '/', { crawl: { navigationTimeoutMs } });
    class HangingEvaluationFactory extends BrowserContextFactory {
      override async createPassivePage(context: BrowserContext): Promise<Page> {
        const page = await super.createPassivePage(context);
        vi.spyOn(page, 'evaluate').mockImplementation(() => new Promise<never>(() => undefined));
        return page;
      }
    }
    const recorded: SafetyLedger[] = [];
    const factory = new HangingEvaluationFactory(browser, config, () => new SafetyLedger());

    const startedAt = performance.now();
    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: (ledger) => recorded.push(ledger),
      onCloseFailure: () => undefined,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(environment.userAgents).toEqual({ desktop: null, mobile: null });
    // 2つのビューポートで、それぞれ期限まで待つ。止まり続けない。
    expect(elapsedMs).toBeLessThan(2 * navigationTimeoutMs + 10_000);
    expect(recorded).toHaveLength(2);
    for (const ledger of recorded) {
      expect(ledger.snapshot().invariantViolations).toEqual([]);
    }
    expect(browser.contexts()).toEqual([]);
  });

  // DEF-008（Task 18 の前の整理の設計書 4.4）: 作成か終了が終わらない場合も、期限の中で戻る。扱いは、今の失敗と同じ
  // （User-Agent を null にする）。
  it('records null for the User-Agents within the open deadline when creating the Context does not finish', async () => {
    const config = createTestConfig(server.origin);
    const recorded: SafetyLedger[] = [];
    const factory = new BrowserContextFactory(browserHangingNewContext(browser), config, () => new SafetyLedger());

    const startedAt = performance.now();
    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: (ledger) => recorded.push(ledger),
      onCloseFailure: () => undefined,
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(environment.userAgents).toEqual({ desktop: null, mobile: null });
    expect(environment.chromiumVersion).toBe(browser.version());
    expect(elapsedMs).toBeLessThan(2 * INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);
    // Context を作れていないので、Ledger は渡さない（今の、Context を作れなかった場合と同じ）。
    expect(recorded).toEqual([]);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('records null for the User-Agents and closes the Contexts when creating the page does not finish', async () => {
    const config = createTestConfig(server.origin);
    class HangingPageFactory extends BrowserContextFactory {
      override async createPassivePage(): Promise<Page> {
        return new Promise<never>(() => undefined);
      }
    }
    const recorded: SafetyLedger[] = [];
    const factory = new HangingPageFactory(browser, config, () => new SafetyLedger());

    const startedAt = performance.now();
    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: (ledger) => recorded.push(ledger),
      onCloseFailure: () => undefined,
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(environment.userAgents).toEqual({ desktop: null, mobile: null });
    expect(elapsedMs).toBeLessThan(2 * INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);
    expect(recorded).toHaveLength(2);
    for (const ledger of recorded) {
      expect(ledger.snapshot().invariantViolations).toEqual([]);
    }
    expect(browser.contexts()).toEqual([]);
    expect(server.getRequestObservations()).toEqual([]);
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('keeps the User-Agents and returns within the close deadline when closing the Context does not finish', async () => {
    const config = createTestConfig(server.origin);
    class HangingContextCloseFactory extends BrowserContextFactory {
      override async closePassiveContext(): Promise<void> {
        await new Promise<never>(() => undefined);
      }
    }
    const factory = new HangingContextCloseFactory(browser, config, () => new SafetyLedger());
    const closeFailures: PassiveSessionCloseFailure[] = [];

    const startedAt = performance.now();
    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: () => undefined,
      onCloseFailure: (failure) => closeFailures.push(failure),
      deadlines: { contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    // 閉じる処理の失敗は、今と同じく User-Agent の値を変えない。
    expect(environment.userAgents.desktop).toMatch(/^Mozilla\/5\.0 .*Chrome\//u);
    expect(environment.userAgents.mobile).toMatch(/^Mozilla\/5\.0 .*Chrome\//u);
    expect(elapsedMs).toBeLessThan(2 * INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);
    // RP18 の指摘1: 閉じる処理の期限切れは捨てずに、呼び出し側（Run Coordinator）に渡す（Run の理由にするため）。
    expect(closeFailures.map(({ step }) => step)).toEqual(['context', 'context']);
    for (const { error } of closeFailures) {
      expect(error).toBeInstanceOf(PassiveContextCloseDeadlineError);
    }
  }, DEADLINE_TEST_TIMEOUT_MS);

  // RP18 の指摘1: page を閉じる処理の失敗も、捨てずに渡す（Context は、そのあと閉じる）。
  it('hands over a page close failure and still closes the Context', async () => {
    const config = createTestConfig(server.origin);
    const pageCloseError = new Error('fixture page close failure');
    class FailingPageCloseFactory extends BrowserContextFactory {
      override async closePassivePage(): Promise<void> {
        throw pageCloseError;
      }
    }
    const factory = new FailingPageCloseFactory(browser, config, () => new SafetyLedger());
    const closeFailures: PassiveSessionCloseFailure[] = [];

    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: () => undefined,
      onCloseFailure: (failure) => closeFailures.push(failure),
    });

    expect(environment.userAgents.desktop).toMatch(/^Mozilla\/5\.0 .*Chrome\//u);
    expect(closeFailures).toEqual([{ step: 'page', error: pageCloseError }, { step: 'page', error: pageCloseError }]);
    expect(browser.contexts()).toEqual([]);
  });

  // RP18 の指摘1: page の作成が期限を過ぎ、部品が Context を閉じる処理も期限を過ぎた場合も、その失敗を渡す。
  it('hands over the Context close failure of the open component when creating the page does not finish', async () => {
    const config = createTestConfig(server.origin);
    class HangingPageAndContextCloseFactory extends BrowserContextFactory {
      override async createPassivePage(): Promise<Page> {
        return new Promise<never>(() => undefined);
      }

      override async closePassiveContext(): Promise<void> {
        await new Promise<never>(() => undefined);
      }
    }
    const factory = new HangingPageAndContextCloseFactory(browser, config, () => new SafetyLedger());
    const closeFailures: PassiveSessionCloseFailure[] = [];

    const startedAt = performance.now();
    const environment = await collectRunEnvironment({
      config,
      browser,
      factory,
      onSafetyLedger: () => undefined,
      onCloseFailure: (failure) => closeFailures.push(failure),
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS, contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    // 作成の期限切れは、今のまま User-Agent を null にするだけである（設計書 4.2）。
    expect(environment.userAgents).toEqual({ desktop: null, mobile: null });
    expect(elapsedMs).toBeLessThan(4 * INJECTED_TIMEOUT_MS + RETURN_MARGIN_MS);
    expect(closeFailures.map(({ step }) => step)).toEqual(['context', 'context']);
    for (const { error } of closeFailures) {
      expect(error).toBeInstanceOf(PassiveContextCloseDeadlineError);
    }
  }, DEADLINE_TEST_TIMEOUT_MS + 2 * INJECTED_TIMEOUT_MS);

  it('throws only for invalid arguments', async () => {
    const config = createTestConfig(server.origin);

    await expect(collectRunEnvironment(undefined as never)).rejects.toThrow(TypeError);
    await expect(
      collectRunEnvironment({
        config,
        browser: null,
        factory: null,
        onSafetyLedger: () => undefined,
        onCloseFailure: () => undefined,
        deadlines: { sessionOpenTimeoutMs: 0 },
      }),
    ).rejects.toThrow(RangeError);
    await expect(collectRunEnvironment({
      config,
      browser: null,
      factory: null,
      onSafetyLedger: undefined as never,
      onCloseFailure: () => undefined,
    })).rejects.toThrow(TypeError);
    // RP18 の指摘1: 閉じる処理の失敗を受け取る口は、省略できない（失敗を捨てさせない）。
    await expect(collectRunEnvironment({
      config,
      browser: null,
      factory: null,
      onSafetyLedger: () => undefined,
      onCloseFailure: undefined as never,
    })).rejects.toThrow(TypeError);
    await expect(collectRunEnvironment({
      config: null as never,
      browser: null,
      factory: null,
      onSafetyLedger: () => undefined,
      onCloseFailure: () => undefined,
    })).rejects.toThrow(TypeError);
  });
});

describe('readToolVersion (R15c)', () => {
  it('reads the version of the BeakSight package.json', async () => {
    await expect(readToolVersion()).resolves.toBe(await packageVersion(new URL('../../package.json', import.meta.url)));
  });
});
