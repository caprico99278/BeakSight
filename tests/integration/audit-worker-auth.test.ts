// T25d（Task 25 の設計書 3 章、4.4）: 認証つきのワーカーの流れ（`startAuditWorker` の認証つきの `START` と、ログインの段 `runLoginStage`）を、
// 同じ process の中で、本物の監査の中核（`executeAuditRun`）と、127.0.0.1 の fixture のサーバ（`authenticated-site-fixture.ts` の `loginForm`）で
// 確かめる。人の操作は、テストだけの口（`onLoginPageReady`）で代える。Chromium は headless だけ（ログイン用の Browser も監査の Browser も、
// テストの既定と CLI の起動の設定の両方）。
// - ログイン → `AUTHENTICATED`（ログイン用の Browser を閉じた後）→ 管理画面の監査 → COMPLETE。ログインの段で、ほかの POST・beacon は届かない。
// - 時間切れ → `LOGIN_TIMEOUT`。誤った資格情報で回数の上限を超える → `LOGIN_ATTEMPTS_EXCEEDED`（サーバに届いた POST は上限の回数まで）。
//   Context が閉じた → `AUTH_SETUP_REQUIRED`。成功の条件に当たったが許可 Origin の状態がない → `UNSUPPORTED_AUTH_STATE`。
//   設定の SHA-256 の違い → `AUTH_SETUP_CHANGED`（ログインしない）。ログインを待つ間の `STOP` → 終了コード 5。
// - 期限切れのサーバ → `SESSION_LOST`（止まったページの URL）と Run の `AUTH_SESSION_LOST`。再開では、もう一度ログインしてから再開する。
// - 秘密: 親に送ったメッセージのすべてと、標準エラーに、Cookie と localStorage の目印が出ない。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun, type AuditRunDependencies } from '../../src/cli/audit-run.js';
import { CONFIG_ERROR_EXIT_CODE, EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { loadConfig } from '../../src/config/load-config.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import { runLoginStage, type LoginStageDependencies } from '../../src/worker/authenticated-login.js';
import { startAuditWorker, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import {
  AUTH_SITE_LOGIN_FIELDS,
  AUTH_SITE_PATHS,
  startAuthenticatedSite,
  type AuthenticatedSite,
  type AuthenticatedSiteOptions,
} from '../helpers/authenticated-site-fixture.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { cliTargetConfig } from '../helpers/run-harness.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
/** テストのログインを待つ時間（ms。人の操作を待たない場面）。 */
const SHORT_LOGIN_TIMEOUT_MS = 2_000;
/** テストのログインを待つ時間（ms。テストの口が入力する場面。CPU の混雑に余裕をもつ）。 */
const LONG_LOGIN_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;
const TEST_TIMEOUT_MS = 180_000;
const MAX_PAGES = 4;
const MAX_LOGIN_ATTEMPTS = 2;
/** 期限切れまでの管理画面の数（1 ページ目の Desktop、幅 1 つ、Mobile の 3 回）。 */
const EXPIRING_ADMIN_PAGES = 3;
const NAVIGATION_SETTLE_TIMEOUT_MS = 10_000;
/** ログインの画面の、許していない送信先（ログインの段で、届かないこと）。 */
const OTHER_POST_PATH = '/admin/update';
const BEACON_PATH = '/beacon';

interface WorkerRun {
  readonly messages: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly stderr: string;
  /** `AUTHENTICATED` を送った時点で、ログイン用の Browser（最初に起動した Browser）がつながっていたか。送っていなければ `null`。 */
  readonly loginBrowserConnectedAtAuthenticated: boolean | null;
}

describe.each(LAUNCHERS)('T25d: the authenticated worker flow in process (%s)', (_name, launch) => {
  let workDirectory: string;
  let site: AuthenticatedSite | undefined;
  const browsers: Browser[] = [];
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-worker-auth-'));
    await mkdir(join(workDirectory, 'config', 'targets'), { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((browser) => browser.close().catch(() => undefined)));
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const startSite = async (options: AuthenticatedSiteOptions = {}): Promise<AuthenticatedSite> => {
    site = await startAuthenticatedSite({ loginForm: true, ...options });
    return site;
  };

  const setupFor = (started: AuthenticatedSite, overrides: Partial<AuthSetup> = {}): AuthSetup => ({
    schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
    profileId: 'example-auth',
    profileRevision: 1,
    loginStartUrl: `${started.originA}${AUTH_SITE_PATHS.login}`,
    loginPostEndpoints: [{ origin: started.originA, path: AUTH_SITE_PATHS.login }],
    successCondition: { pathPrefix: AUTH_SITE_PATHS.admin, selector: '#admin-ok' },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: [AUTH_SITE_PATHS.adminLogout],
    auditPathPrefixes: [AUTH_SITE_PATHS.admin],
    maxLoginAttempts: MAX_LOGIN_ATTEMPTS,
    allowedIdpOrigins: [],
    automatedLogin: null,
    ...overrides,
  });

  /** 作業のディレクトリに、ターゲット JSON を書く（同じ名前なら同じ出力先。再開の場面で使う）。 */
  const writeTarget = async (started: AuthenticatedSite, name: string): Promise<string> => {
    const config = cliTargetConfig(name, started.originA, AUTH_SITE_PATHS.admin, {
      crawl: { minNavigationIntervalMs: 0, maxPages: MAX_PAGES },
      viewports: { stressWidths: [600] },
      audit: { screenshots: false },
      output: { directory: join(workDirectory, `${name}-output`) },
    });
    const path = `config/targets/${name}.json`;
    await writeFile(join(workDirectory, path), JSON.stringify(config), 'utf8');
    return path;
  };

  const launcher = async (): Promise<Browser> => {
    const browser = await launch();
    browsers.push(browser);
    return browser;
  };

  /** ワーカーを同じ process の中で動かし、終わるまで待つ。`afterReady` は `READY` の後、`START` の代わりに何を送るかを決める。 */
  async function runWorker(input: {
    readonly started: AuthenticatedSite;
    readonly targetConfigPath: string;
    readonly setup: AuthSetup;
    readonly startNew: boolean;
    readonly login: Omit<LoginStageDependencies, 'launchLoginBrowser'>;
    readonly digest?: string;
    /** `AUTH_STATE`（`AWAITING_LOGIN`）を受けたら、`STOP` を送る。 */
    readonly stopWhileWaiting?: boolean;
  }): Promise<WorkerRun> {
    runCount += 1;
    const approvedTestOrigins = [input.started.originA];
    const messages: WorkerToParentMessage[] = [];
    const listeners: ((value: unknown) => void)[] = [];
    let stderr = '';
    let loginBrowserConnectedAtAuthenticated: boolean | null = null;
    const loginBrowserIndex = browsers.length;
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const emit = (value: unknown): void => {
      for (const listener of listeners) listener(value);
    };
    const channel: WorkerChannel = {
      send: (message) => {
        messages.push(message);
        if (message.type === 'READY') {
          queueMicrotask(() => emit({
            protocol: WORKER_PROTOCOL_VERSION,
            type: 'START',
            jobId: `job-${runCount}`,
            jobKind: 'AUDIT',
            targetConfigPath: input.targetConfigPath,
            startNew: input.startNew,
            targetConfigSha256: targetConfigSha256Of(input.targetConfigPath),
            authentication: {
              setup: input.setup,
              approvedTestOrigins,
              authenticationSha256: input.digest ?? workerAuthenticationDigestOf(input.setup, approvedTestOrigins, { jobKind: 'AUDIT', automatedLogin: null }),
            },
          }));
        }
        if (message.type === 'AUTH_STATE' && message.state === 'AUTHENTICATED') {
          loginBrowserConnectedAtAuthenticated = browsers[loginBrowserIndex]?.isConnected() ?? null;
        }
        if (message.type === 'AUTH_STATE' && message.state === 'AWAITING_LOGIN' && input.stopWhileWaiting === true) {
          queueMicrotask(() => emit({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: false }));
        }
        return Promise.resolve(true);
      },
      onMessage: (listener) => {
        listeners.push(listener);
      },
      onDisconnect: () => undefined,
    };
    const targetBytes = new Map<string, Uint8Array>();
    const targetConfigSha256Of = (path: string): string => targetConfigDigestOf(targetBytes.get(path) ?? new Uint8Array());
    targetBytes.set(input.targetConfigPath, new Uint8Array(await readFile(join(workDirectory, input.targetConfigPath))));
    const runDependencies: AuditRunDependencies = { launchBrowser: launcher, clock: () => new Date(), now: () => Date.now() };
    const worker = startAuditWorker({
      channel,
      stderr: { write: (text) => { stderr += text; return Promise.resolve(); } },
      exit: (code) => resolveExit(code),
      loadConfig: (path, overrides) => loadConfig(join(workDirectory, path), overrides),
      readTargetConfig: async (path) => new Uint8Array(await readFile(join(workDirectory, path))),
      executeAuditRun,
      runDependencies,
      runLoginStage: (request) => runLoginStage(request, { launchLoginBrowser: launcher, pollIntervalMs: POLL_INTERVAL_MS, ...input.login }),
    });
    try {
      const exitCode = await exited;
      return { messages, exitCode, stderr, loginBrowserConnectedAtAuthenticated };
    } finally {
      worker.dispose();
    }
  }

  const authStatesOf = (run: WorkerRun): readonly string[] =>
    run.messages.flatMap((message) => (message.type === 'AUTH_STATE' ? [message.state] : []));
  const typesOf = (run: WorkerRun): readonly string[] =>
    run.messages.map(({ type }) => type).filter((type) => type !== 'HEARTBEAT' && type !== 'PROGRESS');
  const failedReasonOf = (run: WorkerRun): string | null =>
    run.messages.flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))[0] ?? null;
  const postsOf = (started: AuthenticatedSite): readonly string[] =>
    started.requests.filter(({ method }) => method !== 'GET' && method !== 'HEAD').map(({ method, path }) => `${method} ${path}`);

  /** 人の操作の代わり: ログインの画面で、正しい資格情報を入れて送る。 */
  const typeCorrectCredentials = (started: AuthenticatedSite) => async (page: Page): Promise<void> => {
    await started.fillCredentials((selector, value) => page.fill(selector, value));
    await page.click(AUTH_SITE_LOGIN_FIELDS.submit);
  };

  /** 送ったメッセージのすべてと標準エラーに、秘密の目印がない。 */
  const expectNoSecrets = (run: WorkerRun, started: AuthenticatedSite): void => {
    const markers = started.secretValues();
    expect(markers.length).toBeGreaterThan(0);
    const text = `${JSON.stringify(run.messages)}\n${run.stderr}`;
    expect(markers.filter((marker) => text.includes(marker))).toEqual([]);
    for (const message of run.messages) {
      expect(validateWorkerToParentMessage(message).ok).toBe(true);
    }
  };

  it('logs in, sends AUTHENTICATED after closing the login Browser, audits the admin pages and completes; no other POST reaches the server', async () => {
    const started = await startSite();
    const targetConfigPath = await writeTarget(started, `complete-${runCount}`);
    const run = await runWorker({
      started,
      targetConfigPath,
      setup: setupFor(started),
      startNew: true,
      login: {
        loginTimeoutMs: LONG_LOGIN_TIMEOUT_MS,
        onLoginPageReady: async (page) => {
          // ログインの段の Guard: 許していない送信先への fetch の POST と beacon は届かない。
          await page.evaluate(([otherPath, beaconPath]) => {
            void fetch(otherPath, { method: 'POST', body: 'x' }).catch(() => undefined);
            navigator.sendBeacon(beaconPath, 'x');
          }, [OTHER_POST_PATH, BEACON_PATH] as const);
          await typeCorrectCredentials(started)(page);
        },
      },
    });

    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
    expect(authStatesOf(run)).toEqual(['AWAITING_LOGIN', 'AUTHENTICATED']);
    expect(typesOf(run)).toEqual(['READY', 'AUTH_STATE', 'AUTH_STATE', 'RUN_STARTED', 'FINISHED']);
    expect(run.loginBrowserConnectedAtAuthenticated).toBe(false);
    const finished = run.messages.find((message) => message.type === 'FINISHED');
    expect(finished?.type === 'FINISHED' ? finished.outcome.runStatus : null).toBe('COMPLETE');
    expect(started.successfulLogins).toBe(1);
    expect(postsOf(started)).toEqual([`POST ${AUTH_SITE_PATHS.login}`]);
    const adminRequests = started.requests.filter(({ path }) => path.startsWith(`${AUTH_SITE_PATHS.admin}`));
    expect(adminRequests.filter(({ authenticated }) => !authenticated)).toEqual([]);
    expect(adminRequests.filter(({ authenticated }) => authenticated).length).toBeGreaterThan(0);
    expectNoSecrets(run, started);
    expect(browsers.every((browser) => !browser.isConnected())).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('ends with LOGIN_TIMEOUT when the success condition is not met in time, without starting the audit', async () => {
    const started = await startSite();
    const targetConfigPath = await writeTarget(started, `timeout-${runCount}`);
    const run = await runWorker({
      started, targetConfigPath, setup: setupFor(started), startNew: true, login: { loginTimeoutMs: SHORT_LOGIN_TIMEOUT_MS },
    });

    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(authStatesOf(run)).toEqual(['AWAITING_LOGIN', 'LOGIN_TIMEOUT']);
    expect(failedReasonOf(run)).toBe('LOGIN_TIMEOUT');
    expect(typesOf(run)).not.toContain('RUN_STARTED');
    expect(postsOf(started)).toEqual([]);
    expect(browsers.every((browser) => !browser.isConnected())).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('ends with LOGIN_ATTEMPTS_EXCEEDED after wrong credentials, and the server receives the login POST only up to the limit', async () => {
    const started = await startSite();
    const targetConfigPath = await writeTarget(started, `attempts-${runCount}`);
    const run = await runWorker({
      started,
      targetConfigPath,
      setup: setupFor(started),
      startNew: true,
      login: {
        loginTimeoutMs: LONG_LOGIN_TIMEOUT_MS,
        onLoginPageReady: async (page) => {
          for (let attempt = 0; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
            await page.goto(`${started.originA}${AUTH_SITE_PATHS.login}`);
            await page.fill(AUTH_SITE_LOGIN_FIELDS.user, 'wrong-user');
            await page.fill(AUTH_SITE_LOGIN_FIELDS.pass, 'wrong-pass');
            await Promise.all([
              page.waitForEvent('framenavigated', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined),
              page.click(AUTH_SITE_LOGIN_FIELDS.submit),
            ]);
            await page.waitForLoadState('load', { timeout: NAVIGATION_SETTLE_TIMEOUT_MS }).catch(() => undefined);
          }
        },
      },
    });

    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(authStatesOf(run)).toEqual(['AWAITING_LOGIN', 'LOGIN_ATTEMPTS_EXCEEDED']);
    expect(failedReasonOf(run)).toBe('LOGIN_ATTEMPTS_EXCEEDED');
    expect(postsOf(started)).toEqual(Array.from({ length: MAX_LOGIN_ATTEMPTS }, () => `POST ${AUTH_SITE_PATHS.login}`));
    expect(started.successfulLogins).toBe(0);
  }, TEST_TIMEOUT_MS);

  it.each([
    ['the login Context is closed', 'AUTH_SETUP_REQUIRED', {}, () => async (page: Page) => {
      await page.context().close();
    }],
    ['the success condition is met without an approved-origin state', 'UNSUPPORTED_AUTH_STATE', {
      successCondition: { pathPrefix: AUTH_SITE_PATHS.publicPage, selector: null },
    }, (started: AuthenticatedSite) => async (page: Page) => {
      await page.goto(`${started.originA}${AUTH_SITE_PATHS.publicPage}`);
    }],
  ] as const)('ends with %s → %s', async (_case, state, overrides, hookFor) => {
    const started = await startSite();
    const targetConfigPath = await writeTarget(started, `ended-${runCount}`);
    const run = await runWorker({
      started,
      targetConfigPath,
      setup: setupFor(started, overrides),
      startNew: true,
      login: { loginTimeoutMs: LONG_LOGIN_TIMEOUT_MS, onLoginPageReady: hookFor(started) },
    });

    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(authStatesOf(run)).toEqual(['AWAITING_LOGIN', state]);
    expect(failedReasonOf(run)).toBe(state);
    expect(typesOf(run)).not.toContain('RUN_STARTED');
    expect(postsOf(started)).toEqual([]);
    expect(browsers.every((browser) => !browser.isConnected())).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('ends with AUTH_SETUP_CHANGED when the digest differs from the setup, without launching the login Browser', async () => {
    const started = await startSite();
    const targetConfigPath = await writeTarget(started, `changed-${runCount}`);
    const setup = setupFor(started);
    const run = await runWorker({
      started,
      targetConfigPath,
      setup,
      startNew: true,
      digest: workerAuthenticationDigestOf({ ...setup, maxLoginAttempts: 1 }, [started.originA], { jobKind: 'AUDIT', automatedLogin: null }),
      login: { loginTimeoutMs: SHORT_LOGIN_TIMEOUT_MS },
    });

    expect(run.exitCode).toBe(CONFIG_ERROR_EXIT_CODE);
    expect(failedReasonOf(run)).toBe('AUTH_SETUP_CHANGED');
    expect(authStatesOf(run)).toEqual([]);
    expect(browsers).toHaveLength(0);
    expect(started.requests).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('stops while waiting for the login (STOP) with exit code 5, closing the login Browser', async () => {
    const started = await startSite();
    const targetConfigPath = await writeTarget(started, `stop-${runCount}`);
    const run = await runWorker({
      started, targetConfigPath, setup: setupFor(started), startNew: true, login: { loginTimeoutMs: LONG_LOGIN_TIMEOUT_MS }, stopWhileWaiting: true,
    });

    expect(run.exitCode).toBe(INTERRUPTED_EXIT_CODE);
    expect(authStatesOf(run)).toEqual(['AWAITING_LOGIN']);
    expect(typesOf(run)).not.toContain('FAILED');
    expect(typesOf(run)).not.toContain('RUN_STARTED');
    expect(browsers.every((browser) => !browser.isConnected())).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('sends SESSION_LOST with the lost page on an expiring server (Run: AUTH_SESSION_LOST), and logs in again to resume', async () => {
    // ログインの後の管理画面の表示（成功の条件）も、セッションの管理画面の数に入る（1 回）。
    const started = await startSite({ maxAdminPages: EXPIRING_ADMIN_PAGES + 1 });
    const targetConfigPath = await writeTarget(started, `expiring-${runCount}`);
    const login = { loginTimeoutMs: LONG_LOGIN_TIMEOUT_MS, onLoginPageReady: typeCorrectCredentials(started) };
    const first = await runWorker({ started, targetConfigPath, setup: setupFor(started), startNew: true, login });

    expect(first.exitCode).toBe(EXIT_CODES.PARTIAL);
    expect(authStatesOf(first)).toEqual(['AWAITING_LOGIN', 'AUTHENTICATED', 'SESSION_LOST']);
    const lost = first.messages.find((message) => message.type === 'AUTH_STATE' && message.state === 'SESSION_LOST');
    const lostUrl = lost?.type === 'AUTH_STATE' ? lost.sessionLostUrl : null;
    expect(lostUrl?.startsWith(`${started.originA}${AUTH_SITE_PATHS.admin}/`)).toBe(true);
    const typesBeforeEnd = typesOf(first);
    expect(typesBeforeEnd.indexOf('AUTH_STATE', typesBeforeEnd.indexOf('RUN_STARTED'))).toBeLessThan(typesBeforeEnd.indexOf('FINISHED'));
    const firstFinished = first.messages.find((message) => message.type === 'FINISHED');
    expect(firstFinished?.type === 'FINISHED' ? firstFinished.outcome.runStatus : null).toBe('PARTIAL');
    expectNoSecrets(first, started);

    const resumed = await runWorker({ started, targetConfigPath, setup: setupFor(started), startNew: false, login });
    expect(authStatesOf(resumed).slice(0, 2)).toEqual(['AWAITING_LOGIN', 'AUTHENTICATED']);
    const runStarted = resumed.messages.find((message) => message.type === 'RUN_STARTED');
    expect(runStarted?.type === 'RUN_STARTED' ? runStarted.resumeDecision.kind : null).toBe('RESUME');
    expect(started.successfulLogins).toBe(2);
    expect(postsOf(started)).toEqual([`POST ${AUTH_SITE_PATHS.login}`, `POST ${AUTH_SITE_PATHS.login}`]);
    expectNoSecrets(resumed, started);
    expect(browsers.every((browser) => !browser.isConnected())).toBe(true);
  }, TEST_TIMEOUT_MS);
});
