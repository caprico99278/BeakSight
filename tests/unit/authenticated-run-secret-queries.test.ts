// T25f round 1（Task 25 の設計書 4.6。T25f の報告の発見事項 1・2）:
// (1) 認証つきの Run では、ターゲット設定の `crawl.allowedQueryParameters` に、伏せ字の一覧（`SECRET_URL_QUERY_PARAMETER_NAMES`）に当たる名前が
//     あれば、監査を始めない（認証つきの Run の指定を確かめる 1 か所 `assertRunAuthentication` から。設定のエラー `CONFIG_INVALID`。ワーカーは
//     `FAILED`（`CONFIG_ERROR`）で終え、画面は `CONFIG_ERROR` の手順で案内する）。公開監査では今のまま始まる。
// (2) 認証つきの Run では、ワーカーが送る `FAILED` の `detail` の URL の秘密を伏せる（公開監査の `detail` は今のまま）。
// ブラウザは起動しない（監査の Browser の起動の関数は、呼ばれたかだけを数える）。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAuditRun, type AuditRunDependencies, type AuditRunOutcome } from '../../src/cli/audit-run.js';
import { CONFIG_ERROR_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { classifyCliFailure } from '../../src/cli/failure.js';
import { ConfigError } from '../../src/config/config-error.js';
import type { AuditConfig } from '../../src/config/types.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  workerAuthenticationDigestOf,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import { REDACTED } from '../../src/core/redaction.js';
import {
  assertRunAuthentication,
  secretAllowedQueryParameters,
  type RunAuthentication,
} from '../../src/orchestration/authenticated-run.js';
import { RunCoordinator } from '../../src/orchestration/run-coordinator.js';
import {
  AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS,
  AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION,
} from '../../src/presentation/messages.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { runLoginStage } from '../../src/worker/authenticated-login.js';
import { startAuditWorker, type AuditWorker, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import { runCli } from '../../src/cli/main.js';
import { captureCliOutput } from '../helpers/run-harness.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
/** 秘密の目印（誤りの文の URL の query に入れる仮の値）。 */
const SECRET_MARKER = 'secret-marker-5d21e8';
const TARGET_CONFIG_PATH = 'config/targets/example-auth.json';
const TARGET_BYTES = new TextEncoder().encode('{"target":{"id":"example-auth"}}');

const configWith = (allowedQueryParameters: readonly string[], outputDirectory = 'unused-output'): AuditConfig =>
  createTestConfig(ORIGIN, '/admin', { crawl: { allowedQueryParameters: [...allowedQueryParameters] }, output: { directory: outputDirectory } });

const authentication: RunAuthentication = {
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [ORIGIN],
  auditExclusions: { excludedPathPrefixes: ['/admin/logout'], auditPathPrefixes: ['/admin'], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
};

const workDirectories: string[] = [];
const workers: AuditWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
  for (const directory of workDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function workDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-authenticated-secret-queries-'));
  workDirectories.push(directory);
  return directory;
}

describe('T25f round 1 (1): an authenticated Run does not keep a secret query parameter name in crawl.allowedQueryParameters', () => {
  it('finds the names of the redaction list in crawl.allowedQueryParameters (the comparison of the redaction owner)', () => {
    expect(secretAllowedQueryParameters(configWith(['page', 'Access-Token', 'q', 'state']))).toEqual(['Access-Token', 'state']);
    expect(secretAllowedQueryParameters(configWith(['page', 'q', 'keyword']))).toEqual([]);
  });

  it('rejects the authentication with a ConfigError (CONFIG_INVALID) that names the parameters and is classified as CONFIG_ERROR', () => {
    let thrown: unknown;
    try {
      assertRunAuthentication(authentication, configWith(['page', 'token']));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).kind).toBe('CONFIG_INVALID');
    expect((thrown as ConfigError).details.join('\n')).toContain('"token"');
    expect(classifyCliFailure(thrown)).toMatchObject({ kind: 'CONFIG_ERROR', exitCode: CONFIG_ERROR_EXIT_CODE });
    expect(() => assertRunAuthentication(authentication, configWith(['page', 'q']))).not.toThrow();
  });

  // T44g（Task 44 の P4-1 の発見事項 4）: 公開監査も、同じ部品と理由（`secretAllowedQueryParameters`・`CONFIG_INVALID`）で拒む（書き手が、公開監査でも
  // 保存と成果物の URL の秘密に見える名前の値を伏せるので、その名前をページの URL に残すと再開できない）。
  it('makes the RunCoordinator constructor reject it with and without the authentication', () => {
    let launched = 0;
    const base = {
      launchBrowser: async () => {
        launched += 1;
        throw new Error('not launched');
      },
      createSafetyLedger: () => new SafetyLedger(),
      clock: () => new Date(),
      now: () => Date.now(),
      outputDirectory: 'unused-output',
    };
    expect(() => new RunCoordinator({ ...base, config: configWith(['token']), authentication })).toThrow(ConfigError);
    expect(() => new RunCoordinator({ ...base, config: configWith(['token']) })).toThrow(ConfigError);
    expect(() => new RunCoordinator({ ...base, config: configWith(['page', 'q']) })).not.toThrow();
    expect(launched).toBe(0);
  });

  it('shows the reason with the parameter name on the CLI for the public audit, and launches no Browser', async () => {
    const directory = await workDirectory();
    const configPath = join(directory, 'public-secret.json');
    await writeFile(configPath, JSON.stringify({
      target: { id: 'public-secret' },
      site: { startUrl: `${ORIGIN}/`, allowedOrigins: [ORIGIN] },
      crawl: { minNavigationIntervalMs: 0, allowedQueryParameters: ['page', 'token'] },
    }), 'utf8');
    let launched = 0;
    const stdout = captureCliOutput();
    const stderr = captureCliOutput();
    const code = await runCli(['run', '--config', configPath, '--output', join(directory, 'output'), '--headless'], { stdout: stdout.output, stderr: stderr.output }, {
      run: {
        launchBrowser: async () => {
          launched += 1;
          throw new Error('not launched');
        },
        clock: () => new Date(),
        now: () => Date.now(),
      },
    });
    expect(code).toBe(CONFIG_ERROR_EXIT_CODE);
    expect(launched).toBe(0);
    expect(`${stdout.text()}${stderr.text()}`).toContain('crawl.allowedQueryParameters must not contain "token"');
  });

  it('guides the screen with the CONFIG_ERROR action', () => {
    expect(AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.CONFIG_ERROR.action).toContain(AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION);
    expect(AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION).toContain('crawl.allowedQueryParameters');
    // T44g: 公開の監査も同じ理由で始めないので、画面の案内は公開の監査にも当てはまる文にする。
    expect(AUTHENTICATED_RUN_SECRET_QUERY_PARAMETERS_ACTION).toContain('公開の監査');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// ワーカー（同じ process の中で、偽の IPC の口とログインの段で動かす）
// ---------------------------------------------------------------------------------------------------------------

const setup: AuthSetup = {
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-auth',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
};

interface WorkerResult {
  readonly messages: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly launched: number;
  /** ログイン用の Browser を起動した回数（`realLoginStage` のとき。偽のログインの段では 0）。 */
  readonly loginLaunches: number;
}

/** ワーカーを、偽の IPC の口で動かす（`authenticated` なら認証つきの `START`。ログインの段は、空の状態で成功する偽）。 */
async function runWorker(input: {
  readonly authenticated: boolean;
  readonly config: AuditConfig;
  readonly executeAuditRun: typeof executeAuditRun;
  /** 真なら、本物のログインの段（`runLoginStage`）に、起動の回数を数えるログイン用の Browser の起動を渡す（起動したら投げる）。 */
  readonly realLoginStage?: boolean;
}): Promise<WorkerResult> {
  const messages: WorkerToParentMessage[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  let launched = 0;
  let loginLaunches = 0;
  let resolveExit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const channel: WorkerChannel = {
    send: (message) => {
      messages.push(message);
      if (message.type === 'READY') {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({
              protocol: WORKER_PROTOCOL_VERSION,
              type: 'START',
              jobId: 'job-secret-queries',
              jobKind: 'AUDIT',
              targetConfigPath: TARGET_CONFIG_PATH,
              startNew: true,
              targetConfigSha256: targetConfigDigestOf(TARGET_BYTES),
              ...(input.authenticated
                ? {
                  authentication: {
                    setup,
                    approvedTestOrigins: [ORIGIN],
                    authenticationSha256: workerAuthenticationDigestOf(setup, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: null }),
                  },
                }
                : {}),
            });
          }
        });
      }
      return Promise.resolve(true);
    },
    onMessage: (listener) => {
      listeners.push(listener);
    },
    onDisconnect: () => undefined,
  };
  const runDependencies: AuditRunDependencies = {
    launchBrowser: async () => {
      launched += 1;
      throw new Error('not launched');
    },
    clock: () => new Date(),
    now: () => Date.now(),
  };
  const worker = startAuditWorker({
    channel,
    stderr: { write: () => Promise.resolve() },
    exit: (code) => resolveExit(code),
    loadConfig: async () => input.config,
    readTargetConfig: async () => TARGET_BYTES,
    executeAuditRun: input.executeAuditRun,
    runDependencies,
    runLoginStage: input.realLoginStage === true
      ? (request) => runLoginStage(request, {
        launchLoginBrowser: async () => {
          loginLaunches += 1;
          throw new Error('the login Browser is not launched in this test');
        },
      })
      : async (request) => {
        request.onAwaitingLogin();
        return { kind: 'AUTHENTICATED', state: { cookies: [], origins: [] } };
      },
  });
  workers.push(worker);
  const exitCode = await exited;
  return { messages, exitCode, launched, loginLaunches };
}

const failedOf = (messages: readonly WorkerToParentMessage[]): Extract<WorkerToParentMessage, { readonly type: 'FAILED' }>[] =>
  messages.flatMap((message) => (message.type === 'FAILED' ? [message] : []));

describe('T25f round 1 (1): the worker does not start an authenticated Run with a secret allowed query parameter', () => {
  it('ends with FAILED (CONFIG_ERROR) without launching the audit Browser, and the public audit starts as it does now', async () => {
    const authenticated = await runWorker({
      authenticated: true,
      config: configWith(['token'], join(await workDirectory(), 'output')),
      executeAuditRun,
    });
    expect(failedOf(authenticated.messages).map(({ reason }) => reason)).toEqual(['CONFIG_ERROR']);
    expect(authenticated.exitCode).toBe(CONFIG_ERROR_EXIT_CODE);
    expect(authenticated.launched).toBe(0);
    expect(authenticated.messages.some((message) => message.type === 'RUN_STARTED')).toBe(false);

    // T44g（Task 44 の P4-1 の発見事項 4）: 公開監査も、同じ理由（`CONFIG_ERROR`）で始めない（監査の Browser を起動しない）。
    const publicRun = await runWorker({ authenticated: false, config: configWith(['token'], join(await workDirectory(), 'output')), executeAuditRun });
    expect(failedOf(publicRun.messages).map(({ reason }) => reason)).toEqual(['CONFIG_ERROR']);
    expect(publicRun.exitCode).toBe(CONFIG_ERROR_EXIT_CODE);
    expect(publicRun.launched).toBe(0);
    expect(publicRun.messages.some((message) => message.type === 'RUN_STARTED')).toBe(false);
  });
});

describe('T25f round 2: the worker checks the authenticated Run before the login stage', () => {
  it('ends with FAILED (CONFIG_ERROR) without launching the login Browser and without AWAITING_LOGIN', async () => {
    const result = await runWorker({
      authenticated: true,
      config: configWith(['page', 'token'], join(await workDirectory(), 'output')),
      executeAuditRun,
      realLoginStage: true,
    });
    expect(result.loginLaunches).toBe(0);
    expect(result.messages.filter((message) => message.type === 'AUTH_STATE')).toEqual([]);
    expect(failedOf(result.messages).map(({ reason }) => reason)).toEqual(['CONFIG_ERROR']);
    expect(result.exitCode).toBe(CONFIG_ERROR_EXIT_CODE);
    expect(result.launched).toBe(0);
  });
});

describe('T25f round 1 (2): the FAILED detail of an authenticated Run has the URL secrets redacted', () => {
  const failingRun = (async (): Promise<AuditRunOutcome> => {
    throw new Error(`page.goto: net::ERR_ABORTED at ${ORIGIN}/admin/report?token=${SECRET_MARKER}&page=2`);
  }) as unknown as typeof executeAuditRun;

  it('redacts the secret query value in the FAILED detail of an authenticated Run', async () => {
    const result = await runWorker({ authenticated: true, config: configWith([]), executeAuditRun: failingRun });
    const [failed] = failedOf(result.messages);
    expect(failed?.reason).toBe('UNEXPECTED_FAILURE');
    expect(failed?.detail).toContain(`token=${REDACTED}&page=2`);
    expect(JSON.stringify(result.messages)).not.toContain(SECRET_MARKER);
  });

  it('keeps the FAILED detail of the public audit as it is', async () => {
    const result = await runWorker({ authenticated: false, config: configWith([]), executeAuditRun: failingRun });
    const [failed] = failedOf(result.messages);
    expect(failed?.reason).toBe('UNEXPECTED_FAILURE');
    expect(failed?.detail).toContain(`token=${SECRET_MARKER}&page=2`);
  });
});
