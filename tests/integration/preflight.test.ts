// R15c: Run の前の確認（PREFLIGHT。Task 14〜17 の設計書 5.6.7）。
// 出力先、スキーマ、開始の URL、Chromium の起動、Guard の付いた Passive Context を、この順に確かめる。
// どれかが失敗した場合は、対象のサイトにアクセスせずに `PREFLIGHT_FAILED` を返し、起動した Chromium を閉じる。
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { MAX_ERROR_MESSAGE_LENGTH } from '../../src/core/limits.js';
import { PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE } from '../../src/orchestration/passive-session-close.js';
import { PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE } from '../../src/orchestration/passive-session-open.js';
import {
  BROWSER_CLOSE_DEADLINE_MESSAGE,
  PREFLIGHT_CHECKS,
  runPreflight,
  type BrowserLauncher,
  type PreflightFailure,
  type PreflightResult,
} from '../../src/orchestration/preflight.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { browserOpeningPageAfterNewContext } from '../helpers/browser-opening-page.js';
import {
  browserFailingNewContext,
  browserHangingNewContext,
  neverSettles,
  overrideBrowser,
} from '../helpers/browser-proxies.js';
import { createRunLauncher, type RunLauncher } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

/** 閉じる処理の期限を過ぎてから、戻るまでの余裕。 */
const CLOSE_MARGIN_MS = 5_000;
/**
 * 注入する短い期限（ms。R15r-4）。実際の期限（`BROWSER_CLOSE_TIMEOUT_MS`、`SESSION_OPEN_TIMEOUT_MS`、`CONTEXT_CLOSE_TIMEOUT_MS`）を
 * 待たない。
 */
const INJECTED_TIMEOUT_MS = 300;
/** 期限のテストの上限。注入した期限を守らない（既定の期限を待つか、止まり続ける）場合は、この時間で失敗する。 */
const DEADLINE_TEST_TIMEOUT_MS = INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS + 5_000;

let server: FixtureServer;
let workDirectory: string | undefined;
/** テストで作ったすべての launcher。後片付けで、残っている Browser を閉じる。 */
const launchers: RunLauncher[] = [];

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const launcher of launchers.splice(0)) {
    await launcher.closeAll();
  }
  if (workDirectory !== undefined) {
    await rm(workDirectory, { recursive: true, force: true });
    workDirectory = undefined;
  }
});

async function createWorkDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-preflight-'));
  workDirectory = directory;
  return directory;
}

/**
 * 本物の headless Chromium を起動し、起動の要求（`calls`）と起動した Browser（`browsers`）を記録する launcher（`createRunLauncher`）。
 * `wrap` で、返す Browser を差し替えられる。後片付けのため、作った launcher を覚えておく。
 */
function recordingLauncher(wrap?: (browser: Browser) => Browser): RunLauncher {
  const launcher = createRunLauncher(wrap);
  launchers.push(launcher);
  return launcher;
}

function ledgerFactory(): { readonly create: () => SafetyLedger; readonly created: SafetyLedger[] } {
  const created: SafetyLedger[] = [];
  return {
    create: () => {
      const ledger = new SafetyLedger();
      created.push(ledger);
      return ledger;
    },
    created,
  };
}

function expectFailure(result: PreflightResult, check: PreflightFailure['failedCheck']): PreflightFailure {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('expected a preflight failure');
  }
  expect(result.failedCheck).toBe(check);
  expect(result.reason).toEqual({ code: 'PREFLIGHT_FAILED', detail: check });
  expect(result.message.length).toBeGreaterThan(0);
  expect(result.message.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_LENGTH);
  expect(Object.isFrozen(result)).toBe(true);
  return result;
}

function expectNoTargetRequests(): void {
  expect(server.getRequestObservations()).toEqual([]);
  expect(server.getCounters().get).toBe(0);
}

describe('runPreflight (R15c)', () => {
  it('checks the items in the documented order', () => {
    expect(PREFLIGHT_CHECKS).toEqual(['OUTPUT_DIRECTORY', 'SCHEMA', 'START_URL', 'BROWSER_LAUNCH', 'PASSIVE_GUARD']);
  });

  it('returns the launched Browser and a guarded context factory without touching the target site', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = join(await createWorkDirectory(), 'nested', 'artifacts');
    const launcher = recordingLauncher();
    const ledgers = ledgerFactory();

    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgers.create,
      outputDirectory,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(Object.isFrozen(result)).toBe(true);
    expect(launcher.calls).toEqual([{ headless: true }]);
    expect(result.browser).toBe(launcher.browsers[0]);
    expect(result.browser.isConnected()).toBe(true);
    expect(result.factory).toBeInstanceOf(BrowserContextFactory);
    // Guard を確かめた Context と page は、すぐに閉じている。
    expect(result.browser.contexts()).toEqual([]);
    // Guard を確かめた Context の Ledger を返す（Run の Safety の集計に含めるため）。違反はない。
    expect(result.safetyLedgers).toEqual(ledgers.created);
    expect(result.safetyLedgers).toHaveLength(1);
    expect(result.safetyLedgers[0]?.snapshot().invariantViolationCount).toBe(0);
    // 出力先のディレクトリを作り、一時ファイルは消している。
    expect(await readdir(outputDirectory)).toEqual([]);
    expectNoTargetRequests();

    // 返した factory は、そのまま Guard の付いた Context を作れる。
    const context = await result.factory.createPassiveContext(createTestConfig(server.origin).viewports.primaryDesktop);
    await result.factory.closePassiveContext(context);
    expectNoTargetRequests();
  });

  it('passes headless: false to the launcher when the configuration asks for a headed browser', async () => {
    const outputDirectory = await createWorkDirectory();
    const calls: { readonly headless: boolean }[] = [];
    const config = createTestConfig(server.origin);
    const headedConfig: AuditConfig = { ...config, browser: { ...config.browser, headed: true } };
    const failingLauncher: BrowserLauncher = async (options) => {
      calls.push({ headless: options.headless });
      throw new Error('headed launch is not available in the test');
    };

    const result = await runPreflight({
      config: headedConfig,
      launchBrowser: failingLauncher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
    });

    expectFailure(result, 'BROWSER_LAUNCH');
    expect(calls).toEqual([{ headless: false }]);
  });

  it('fails OUTPUT_DIRECTORY without launching Chromium when the output directory cannot be written', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const directory = await createWorkDirectory();
    const blockingFile = join(directory, 'not-a-directory');
    await writeFile(blockingFile, 'occupied');
    const launcher = recordingLauncher();
    const ledgers = ledgerFactory();

    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgers.create,
      outputDirectory: join(blockingFile, 'artifacts'),
    });

    const failure = expectFailure(result, 'OUTPUT_DIRECTORY');
    expect(failure.safetyLedgers).toEqual([]);
    expect(launcher.calls).toEqual([]);
    expect(ledgers.created).toEqual([]);
    expectNoTargetRequests();
  });

  it('fails OUTPUT_DIRECTORY when the output path is an existing file', async () => {
    const directory = await createWorkDirectory();
    const blockingFile = join(directory, 'artifacts');
    await writeFile(blockingFile, 'occupied');
    const launcher = recordingLauncher();

    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory: blockingFile,
    });

    expectFailure(result, 'OUTPUT_DIRECTORY');
    expect(launcher.calls).toEqual([]);
  });

  it('fails START_URL without launching Chromium when the start URL is outside the allowed origins', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher();
    const config = createTestConfig(server.origin);
    // loadConfig の検証を通らない設定でも、PREFLIGHT は開始の URL を自分で確かめる。
    const externalStart: AuditConfig = {
      ...config,
      site: { ...config.site, startUrl: 'http://127.0.0.1:9/external-start.html' },
    };

    const result = await runPreflight({
      config: externalStart,
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
    });

    const failure = expectFailure(result, 'START_URL');
    expect(failure.message).toContain('EXTERNAL_RECORD_ONLY');
    expect(launcher.calls).toEqual([]);
    expectNoTargetRequests();
  });

  it('fails START_URL when the start URL cannot be parsed', async () => {
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher();
    const config = createTestConfig(server.origin);

    const result = await runPreflight({
      config: { ...config, site: { ...config.site, startUrl: 'not a url' } },
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
    });

    expectFailure(result, 'START_URL');
    expect(launcher.calls).toEqual([]);
  });

  it('fails BROWSER_LAUNCH with a bounded message when the injected launcher rejects', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const ledgers = ledgerFactory();
    const longMessage = `spawn failed ${'x'.repeat(MAX_ERROR_MESSAGE_LENGTH * 2)}`;

    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: async () => {
        throw new Error(longMessage);
      },
      createSafetyLedger: ledgers.create,
      outputDirectory,
    });

    const failure = expectFailure(result, 'BROWSER_LAUNCH');
    expect(failure.message).toBe(longMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH));
    expect(failure.safetyLedgers).toEqual([]);
    expect(ledgers.created).toEqual([]);
    expectNoTargetRequests();
  });

  it('fails PASSIVE_GUARD, keeps the Ledger with the violation and closes Chromium when the Guard cannot be installed', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher((browser) => browserOpeningPageAfterNewContext(browser));
    const ledgers = ledgerFactory();

    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgers.create,
      outputDirectory,
    });

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(launcher.calls).toHaveLength(1);
    // Guard の取り付けの失敗は、Ledger の違反として残る。その Ledger を返す。
    expect(failure.safetyLedgers).toEqual(ledgers.created);
    expect(failure.safetyLedgers).toHaveLength(1);
    expect(failure.safetyLedgers[0]?.snapshot().invariantViolations.map((violation) => violation.code))
      .toContain('GUARD_INSTALLATION_FAILED');
    // 起動した Chromium は閉じている（Context も残らない）。
    const [realBrowser] = launcher.browsers;
    expect(realBrowser?.isConnected()).toBe(false);
    expect(realBrowser?.contexts()).toEqual([]);
    expectNoTargetRequests();
  });

  it('fails PASSIVE_GUARD and closes Chromium when creating the Context fails', async () => {
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher((browser) => browserFailingNewContext(browser, 'newContext failed in the test'));

    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
    });

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(failure.message).toContain('newContext failed in the test');
    expect(launcher.browsers[0]?.isConnected()).toBe(false);
  });

  // R15 の Minor-2: Browser を閉じる処理が終わらない場合は、`BROWSER_CLOSE_TIMEOUT_MS` で見切り、失敗のメッセージに加えて返す。
  it('returns the PASSIVE_GUARD failure with the browser close deadline when closing Chromium does not finish', async () => {
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher((browser) => overrideBrowser(
      browserFailingNewContext(browser, 'newContext failed in the test'),
      { close: neverSettles },
    ));

    const startedAt = performance.now();
    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
      deadlines: { browserCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(failure.message).toContain('newContext failed in the test');
    expect(failure.message).toContain(`browser close failed: ${BROWSER_CLOSE_DEADLINE_MESSAGE}`);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS);
  }, INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS + 20_000);

  // DEF-008（Task 18 の前の整理の設計書 4.4）: Context と page の作成、Context を閉じる処理が終わらない場合も、期限の中で戻り、
  // PREFLIGHT の失敗（PASSIVE_GUARD）にする。対象のサイトにはアクセスしない。
  it('fails PASSIVE_GUARD within the open deadline and closes Chromium when creating the Context does not finish', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher((browser) => browserHangingNewContext(browser));
    const ledgers = ledgerFactory();

    const startedAt = performance.now();
    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgers.create,
      outputDirectory,
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(failure.message).toContain(PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS);
    // Context を作れていないので、その Ledger は返さない（Ledger は、Run の Ledger の登録には入っている）。
    expect(failure.safetyLedgers).toEqual([]);
    expect(launcher.browsers[0]?.isConnected()).toBe(false);
    expectNoTargetRequests();
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('fails PASSIVE_GUARD within the open deadline and closes the Context when creating the page does not finish', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher();
    const ledgers = ledgerFactory();
    vi.spyOn(BrowserContextFactory.prototype, 'createPassivePage').mockImplementation(() => new Promise<never>(() => undefined));
    const closeContext = vi.spyOn(BrowserContextFactory.prototype, 'closePassiveContext');

    const startedAt = performance.now();
    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgers.create,
      outputDirectory,
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(failure.message).toContain(PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS);
    // 作った Context の Ledger は返す。Context は、部品が閉じた（違反はない）。
    expect(failure.safetyLedgers).toEqual(ledgers.created);
    expect(failure.safetyLedgers).toHaveLength(1);
    expect(failure.safetyLedgers[0]?.snapshot().invariantViolationCount).toBe(0);
    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(launcher.browsers[0]?.isConnected()).toBe(false);
    expectNoTargetRequests();
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('fails PASSIVE_GUARD within the close deadline when closing the guarded Context does not finish', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher();
    vi.spyOn(BrowserContextFactory.prototype, 'closePassiveContext').mockImplementation(() => new Promise<never>(() => undefined));

    const startedAt = performance.now();
    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
      deadlines: { contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(failure.message).toBe(`guarded context close failed: ${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}`);
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS);
    // Chromium を閉じると、閉じきれなかった Context も閉じる。
    expect(launcher.browsers[0]?.isConnected()).toBe(false);
    expectNoTargetRequests();
  }, DEADLINE_TEST_TIMEOUT_MS);

  // RP18r の Minor-1: PREFLIGHT が失敗した場合も、閉じる処理の失敗（期限切れを含む）を、メッセージに含める（隠さない）。
  it('keeps the Context close deadline in the message when creating the page does not finish', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher();
    vi.spyOn(BrowserContextFactory.prototype, 'createPassivePage').mockImplementation(() => new Promise<never>(() => undefined));
    const closeContext = vi.spyOn(BrowserContextFactory.prototype, 'closePassiveContext')
      .mockImplementation(() => new Promise<never>(() => undefined));

    const startedAt = performance.now();
    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
      deadlines: { sessionOpenTimeoutMs: INJECTED_TIMEOUT_MS, contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(failure.message).toBe(
      `${PASSIVE_SESSION_OPEN_DEADLINE_MESSAGE}; guarded context close failed: ${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}`,
    );
    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(2 * INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS);
    expect(launcher.browsers[0]?.isConnected()).toBe(false);
    expectNoTargetRequests();
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('keeps the Context close deadline in the message when the check has already failed', async () => {
    server.resetRequestObservations();
    server.resetCounters();
    const outputDirectory = await createWorkDirectory();
    const launcher = recordingLauncher();
    vi.spyOn(BrowserContextFactory.prototype, 'createPassivePage').mockRejectedValue(new Error('newPage failed in the test'));
    vi.spyOn(BrowserContextFactory.prototype, 'closePassiveContext').mockImplementation(() => new Promise<never>(() => undefined));

    const startedAt = performance.now();
    const result = await runPreflight({
      config: createTestConfig(server.origin),
      launchBrowser: launcher.launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
      deadlines: { contextCloseTimeoutMs: INJECTED_TIMEOUT_MS },
    });
    const elapsedMs = performance.now() - startedAt;

    const failure = expectFailure(result, 'PASSIVE_GUARD');
    expect(failure.message).toBe(
      `newPage failed in the test; guarded context close failed: ${PASSIVE_CONTEXT_CLOSE_DEADLINE_MESSAGE}`,
    );
    expect(elapsedMs).toBeLessThan(INJECTED_TIMEOUT_MS + CLOSE_MARGIN_MS);
    expect(launcher.browsers[0]?.isConnected()).toBe(false);
    expectNoTargetRequests();
  }, DEADLINE_TEST_TIMEOUT_MS);

  it('throws only for invalid arguments', async () => {
    const outputDirectory = await createWorkDirectory();
    const config = createTestConfig(server.origin);
    const valid = {
      config,
      launchBrowser: recordingLauncher().launcher,
      createSafetyLedger: ledgerFactory().create,
      outputDirectory,
    };

    await expect(runPreflight(undefined as never)).rejects.toThrow(TypeError);
    await expect(runPreflight({ ...valid, launchBrowser: undefined as never })).rejects.toThrow(TypeError);
    await expect(runPreflight({ ...valid, createSafetyLedger: undefined as never })).rejects.toThrow(TypeError);
    await expect(runPreflight({ ...valid, outputDirectory: '' })).rejects.toThrow(TypeError);
    await expect(runPreflight({ ...valid, config: null as never })).rejects.toThrow(TypeError);
    await expect(runPreflight({ ...valid, deadlines: { sessionOpenTimeoutMs: 0 } })).rejects.toThrow(RangeError);
    await expect(runPreflight({ ...valid, deadlines: { browserCloseTimeoutMs: -1 } })).rejects.toThrow(RangeError);
  });
});
