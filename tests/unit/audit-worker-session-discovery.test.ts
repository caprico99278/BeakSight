// T27d（Task 27 の設計書 4.6 と、変更履歴の「T27b・T27c の報告と T27d の前の判断」の (3)）: ワーカーの流れの、発見のジョブ（`DISCOVERY`）の扱いを、
// 偽の IPC の口と偽のログインの段と偽の発見の流れで確かめる（本物の子 process と Chromium は `discovery-job-fork.test.ts`）。
// - ログインの段（手動）の後に、監査の中核を呼ばずに、発見の流れを、ジョブの ID・設定・ログインの状態つきの認証の指定・止める印で呼ぶ。
// - 発見の流れの観測を IPC に写す: Run を作った → `RUN_STARTED`（新しい Run、出力先からの相対パス）、セッションの切れ → `AUTH_STATE`
//   （`SESSION_LOST`、URL）。終わり → `FINISHED`（Run を実行した結果だけ件数の要約。候補を載せない）と、結果の終了コード。
// - 発見の流れがないワーカーは、設定を読まずに `FAILED`（`JOB_KIND_NOT_SUPPORTED`）で拒む。ログインの段の失敗では、発見の流れを呼ばない。
//   発見の流れの例外（成果物を書けない）は、監査と同じく `FAILED` の理由に分ける。
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_JOB_KIND_NOT_SUPPORTED_REASON,
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import { REDACTED } from '../../src/core/redaction.js';
import { ArtifactWriteError } from '../../src/report/artifact-writer.js';
import { startAuditWorker, type AuditWorker, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import type { LoginStageResult } from '../../src/worker/authenticated-login.js';
import type { DiscoveryRunObserver, DiscoveryRunOutcome, DiscoveryRunRequest } from '../../src/worker/discovery-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGET_CONFIG_PATH = 'local/targets/example-discovery.json';
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example-discovery"}}');
const OUTPUT_DIRECTORY = resolve('worker-session-discovery-output');
const RUN_ID = 'RUN-20261011010000' as RunId;
const START_TIMEOUT_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const SESSION_VALUE = 'session-value-example';

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-discovery',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const discoveryStart = (): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-discovery',
  jobKind: 'DISCOVERY',
  targetConfigPath: TARGET_CONFIG_PATH,
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'DISCOVERY', automatedLogin: null }),
  },
});

const AUTHENTICATED: LoginStageResult = Object.freeze({
  kind: 'AUTHENTICATED',
  state: {
    cookies: [{ name: 'sid', value: SESSION_VALUE, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }],
    origins: [],
  },
});

const ranOutcome: DiscoveryRunOutcome = {
  kind: 'RAN',
  runId: RUN_ID,
  runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID),
  runStatus: 'PARTIAL',
  exitCode: EXIT_CODES.PARTIAL,
  summary: { pagesRead: 3, pagesNotRead: 2, candidates: 5 },
  endReason: 'MAX_PAGES_REACHED',
};

interface Run {
  readonly sent: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly discoveryRequests: readonly DiscoveryRunRequest[];
  readonly calls: { loadConfig: number; login: number; audit: number };
}

const workers: AuditWorker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

async function runWorker(options: {
  readonly executeDiscovery?: (request: DiscoveryRunRequest, observer: DiscoveryRunObserver) => Promise<DiscoveryRunOutcome>;
  readonly login?: LoginStageResult;
}): Promise<Run> {
  const sent: WorkerToParentMessage[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  const discoveryRequests: DiscoveryRunRequest[] = [];
  const calls = { loadConfig: 0, login: 0, audit: 0 };
  const channel: WorkerChannel = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve(true);
    },
    onMessage: (listener) => {
      listeners.push(listener);
    },
    onDisconnect: () => undefined,
  };
  const config = { ...createTestConfig(ORIGIN, '/admin'), output: { directory: OUTPUT_DIRECTORY } };
  const { executeDiscovery } = options;
  const worker = startAuditWorker({
    channel,
    stderr: { write: () => Promise.resolve() },
    exit: () => undefined,
    loadConfig: () => {
      calls.loadConfig += 1;
      return Promise.resolve(config);
    },
    readTargetConfig: () => Promise.resolve(TARGET_CONFIG_BYTES),
    executeAuditRun: () => {
      calls.audit += 1;
      return Promise.reject(new Error('the audit must not run for a discovery job'));
    },
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    runLoginStage: () => {
      calls.login += 1;
      return Promise.resolve(options.login ?? AUTHENTICATED);
    },
    ...(executeDiscovery === undefined
      ? {}
      : {
        executeDiscovery: (request: DiscoveryRunRequest, observer: DiscoveryRunObserver) => {
          discoveryRequests.push(request);
          return executeDiscovery(request, observer);
        },
      }),
    startTimeoutMs: START_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  workers.push(worker);
  listeners.forEach((listener) => listener(discoveryStart()));
  const exitCode = await worker.exited;
  return { sent, exitCode, discoveryRequests, calls };
}

const meaningful = (run: Run): readonly WorkerToParentMessage[] => run.sent.filter(({ type }) => type !== 'HEARTBEAT' && type !== 'READY');

describe('audit worker session (T27d): the discovery job', () => {
  it('logs in, runs the discovery flow instead of the audit, and sends RUN_STARTED, SESSION_LOST and FINISHED with the counts only', async () => {
    const run = await runWorker({
      executeDiscovery: async (_request, observer) => {
        observer.onRunStarted({ runId: RUN_ID, runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID) });
        observer.onSessionLost(`${ORIGIN}/login?expired=1`, null);
        return ranOutcome;
      },
    });

    expect(run.calls).toEqual({ loadConfig: 1, login: 1, audit: 0 });
    expect(run.discoveryRequests).toHaveLength(1);
    const [request] = run.discoveryRequests;
    expect(request?.jobId).toBe('job-discovery');
    expect(request?.authentication.initialState).toEqual(AUTHENTICATED.kind === 'AUTHENTICATED' ? AUTHENTICATED.state : null);
    expect(request?.authentication.approvedTestOrigins).toEqual([ORIGIN]);
    expect(request?.authentication.sessionLostPathPrefix).toBe('/login');
    expect(request?.stopSignal.aborted).toBe(false);
    expect(meaningful(run)).toEqual([
      { protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state: 'AUTHENTICATED', sessionLostUrl: null },
      {
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'RUN_STARTED',
        runId: RUN_ID,
        runDirectory: RUN_ID,
        resumeDecision: { kind: 'NEW_RUN', completedPages: null },
      },
      // T44g（P4-1）: セッションの切れの URL は、query のすべての値を伏せる（`redactRecordedRequestUrl`）。
      { protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state: 'SESSION_LOST', sessionLostUrl: `${ORIGIN}/login?expired=${REDACTED}` },
      {
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'FINISHED',
        outcome: { kind: 'RAN', exitCode: EXIT_CODES.PARTIAL, runId: RUN_ID, runDirectory: RUN_ID, runStatus: 'PARTIAL' },
        discovery: { pagesRead: 3, pagesNotRead: 2, candidates: 5 },
      },
    ]);
    expect(run.exitCode).toBe(EXIT_CODES.PARTIAL);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
    expect(JSON.stringify(run.sent)).not.toContain(SESSION_VALUE);
  });

  // DEF-143: 発見の流れが成果物を組み立てて書く段に入ったら、監査と同じ口（`RUN_FINALIZING`）で親へ知らせる。
  it('relays the start of the finalizing stage of the discovery flow as RUN_FINALIZING, before FINISHED', async () => {
    const run = await runWorker({
      executeDiscovery: async (_request, observer) => {
        observer.onRunStarted({ runId: RUN_ID, runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID) });
        observer.onFinalizing?.();
        return ranOutcome;
      },
    });
    expect(meaningful(run).map(({ type }) => type)).toEqual(['AUTH_STATE', 'RUN_STARTED', 'RUN_FINALIZING', 'FINISHED']);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  it('sends FINISHED without the counts when the discovery did not start a Run (RUN_ACTIVE)', async () => {
    const run = await runWorker({ executeDiscovery: async () => ({ kind: 'RUN_ACTIVE', activeRunId: RUN_ID, exitCode: EXIT_CODES.RUN_UNAVAILABLE }) });
    expect(meaningful(run).at(-1)).toEqual({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'FINISHED',
      outcome: { kind: 'RUN_ACTIVE', exitCode: EXIT_CODES.RUN_UNAVAILABLE, runId: RUN_ID, runDirectory: null, runStatus: null },
    });
    expect(run.exitCode).toBe(EXIT_CODES.RUN_UNAVAILABLE);
  });

  it('rejects the discovery job without the discovery flow, before reading the config and logging in', async () => {
    const run = await runWorker({});
    expect(meaningful(run).map((message) => (message.type === 'FAILED' ? message.reason : message.type))).toEqual([WORKER_JOB_KIND_NOT_SUPPORTED_REASON]);
    expect(run.calls).toEqual({ loadConfig: 0, login: 0, audit: 0 });
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
  });

  it('does not run the discovery flow when the login stage fails', async () => {
    const run = await runWorker({ executeDiscovery: async () => ranOutcome, login: { kind: 'LOGIN_TIMEOUT' } });
    expect(run.discoveryRequests).toEqual([]);
    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['LOGIN_TIMEOUT']);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
  });

  it('turns a failure to write discovery.json into FAILED (ARTIFACT_WRITE_FAILED), without FINISHED', async () => {
    const run = await runWorker({ executeDiscovery: async () => Promise.reject(new ArtifactWriteError(resolve(OUTPUT_DIRECTORY, 'x'), new Error('disk full'))) });
    expect(meaningful(run).map(({ type }) => type)).toEqual(['AUTH_STATE', 'FAILED']);
    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['ARTIFACT_WRITE_FAILED']);
  });
});
