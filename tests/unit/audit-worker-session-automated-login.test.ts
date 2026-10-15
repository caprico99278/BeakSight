// T26d-2（Task 26 の設計書 3 章、4.4、4.5）: ワーカーの流れ（`src/worker/audit-worker-session.ts`）の自動ログインを、偽の IPC の口と、偽の自動ログインの
// 段と、偽の中核で確かめる（本物の子 process・Chromium・fixture のサーバでの端から端は `audit-worker-automated-login-fork.test.ts`）。
// - `AUDIT` で自動ログイン: 自動ログインの段だけを行い（手動のログインの段を呼ばない）、成功なら `AUTHENTICATED`（成功の結果）を送って、状態を
//   監査に渡す。
// - `LOGIN_CHECK`: 自動ログインの段だけを行い、結果を送って終える（中核を呼ばない。`FINISHED` を送らない。成功の終了コード 0）。
// - 成功以外: `AUTOMATED_LOGIN_FAILED`（閉じた一覧の結果、送信、`Retry-After` の期限、理由のコード）と `FAILED`（結果）を送り、監査を始めない。
//   **手動のログインの段へ切り替えない。** 止める要求は `AUTH_RESULT_UNKNOWN` と観測した送信で、終了コード 5。
// - SHA-256 は、ジョブの種類と自動ログインの指定も含めて求め直す（違えば `AUTH_SETUP_CHANGED`。ログインしない）。
// - 自動ログインの段に渡すのは、設定・認証の設定・許可 Origin・資格情報の改訂の番号と根・止める印・読み込みの間隔の部品だけ（値を受け渡さない）。
// - DEF-102 fix: 読み込みの間隔の部品は `START` ごとに 1 つで、自動ログインの段と、その後のジョブ（発見）に同じものを渡す。CCX-22: 監査の Run にも
//   同じものを渡す（ワーカーの側では待たない。待つのは Run Coordinator の読み込みの前）。
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRunDependencies, AuditRunOutcome } from '../../src/cli/audit-run.js';
import { CONFIG_ERROR_EXIT_CODE, EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import type { AuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerJobKind,
  type WorkerStartAutomatedLogin,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import type { RunSummaryView } from '../../src/report/view-model.js';
import { startAuditWorker, type AuditWorker, type WorkerAutomatedLoginStageRequest, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import type { AutomatedLoginStageResult } from '../../src/worker/automated-login.js';
import type { DiscoveryRunOutcome, DiscoveryRunRequest } from '../../src/worker/discovery-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGET_CONFIG_PATH = 'local/targets/example-auto.json';
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example-auto"}}');
const OUTPUT_DIRECTORY = resolve('worker-session-auto-output');
const RUN_ID = 'RUN-20261010000001' as RunId;
const START_TIMEOUT_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const RETRY_AFTER_UNTIL = new Date(Date.UTC(2026, 9, 10, 12, 30, 5));

const SETUP: AuthSetup = Object.freeze({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: 'example-auto',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: {
    usernameSelector: '#user',
    passwordSelector: '#pass',
    submitSelector: '#go',
    failureConditions: {
      invalidCredentials: { pathPrefix: '/login', selector: '#login-failed' },
      accountLocked: null,
      mfaRequired: null,
      credentialExpired: null,
    },
  },
});

const AUTOMATED_LOGIN: WorkerStartAutomatedLogin = Object.freeze({ credentialRevision: 2, credentialRoot: resolve('example-credential-root') });

const STATE: AuthenticatedState = Object.freeze({
  cookies: [{ name: 'sid', value: 'x', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [],
}) as unknown as AuthenticatedState;

const startOf = (jobKind: WorkerJobKind, digestJobKind: WorkerJobKind = jobKind): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-auto',
  jobKind,
  targetConfigPath: TARGET_CONFIG_PATH,
  startNew: false,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: digestJobKind, automatedLogin: AUTOMATED_LOGIN }),
    automatedLogin: AUTOMATED_LOGIN,
  },
});

const ranOutcome: AuditRunOutcome = {
  kind: 'RAN',
  runId: RUN_ID,
  runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID),
  runStatus: 'COMPLETE',
  exitCode: EXIT_CODES.COMPLETE,
  resumeDecision: { kind: 'NEW_RUN' },
  notices: [],
  summary: {} as RunSummaryView,
  checkpointWarnings: [],
};

interface Run {
  readonly sent: WorkerToParentMessage[];
  readonly exitCode: number;
  readonly stageRequests: readonly WorkerAutomatedLoginStageRequest[];
  readonly manualCalls: number;
  readonly auditRuns: readonly AuditRunDependencies[];
  /** 監査の中核が呼ばれた時刻（`Date.now()`）。 */
  readonly auditCalledAt: readonly number[];
  readonly discoveryRequests: readonly DiscoveryRunRequest[];
}

/** `runWorker` の省略できる指定（DEF-102 fix）。 */
interface RunWorkerOptions {
  /** 設定のページの読み込みの最小の間隔（ms。既定は `createTestConfig` の 0）。 */
  readonly minNavigationIntervalMs?: number;
  /** 発見の流れの偽物（`DISCOVERY` の `START` に使う）。 */
  readonly executeDiscovery?: (request: DiscoveryRunRequest) => Promise<DiscoveryRunOutcome>;
}

const workers: AuditWorker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

/** ワーカーを始め、`START` を送り、終わるまで待つ。`onStage` は自動ログインの段の偽物（止める要求を送るための口を受ける）。 */
async function runWorker(
  start: Record<string, unknown>,
  onStage: (request: WorkerAutomatedLoginStageRequest, emit: (value: unknown) => void) => Promise<AutomatedLoginStageResult>,
  options: RunWorkerOptions = {},
): Promise<Run> {
  const sent: WorkerToParentMessage[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  const emit = (value: unknown): void => listeners.forEach((listener) => listener(value));
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
  const stageRequests: WorkerAutomatedLoginStageRequest[] = [];
  const auditRuns: AuditRunDependencies[] = [];
  const auditCalledAt: number[] = [];
  const discoveryRequests: DiscoveryRunRequest[] = [];
  let manualCalls = 0;
  const config = {
    ...createTestConfig(ORIGIN, '/admin', options.minNavigationIntervalMs === undefined ? {} : { crawl: { minNavigationIntervalMs: options.minNavigationIntervalMs } }),
    output: { directory: OUTPUT_DIRECTORY },
  };
  const { executeDiscovery } = options;
  const worker = startAuditWorker({
    channel,
    stderr: { write: () => Promise.resolve() },
    exit: () => undefined,
    loadConfig: () => Promise.resolve(config),
    readTargetConfig: () => Promise.resolve(TARGET_CONFIG_BYTES),
    executeAuditRun: (_config, dependencies) => {
      auditCalledAt.push(Date.now());
      auditRuns.push(dependencies);
      return Promise.resolve(ranOutcome);
    },
    ...(executeDiscovery === undefined
      ? {}
      : {
        executeDiscovery: (request: DiscoveryRunRequest) => {
          discoveryRequests.push(request);
          return executeDiscovery(request);
        },
      }),
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    runLoginStage: () => {
      manualCalls += 1;
      return Promise.resolve({ kind: 'AUTH_SETUP_REQUIRED' });
    },
    runAutomatedLoginStage: (request) => {
      stageRequests.push(request);
      return onStage(request, emit);
    },
    startTimeoutMs: START_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  workers.push(worker);
  emit(start);
  const exitCode = await worker.exited;
  return { sent, exitCode, stageRequests, manualCalls, auditRuns, auditCalledAt, discoveryRequests };
}

const meaningful = (run: Run): WorkerToParentMessage[] => run.sent.filter(({ type }) => type !== 'HEARTBEAT' && type !== 'READY');

const authStatesOf = (run: Run): unknown[] => meaningful(run).flatMap((message) =>
  (message.type === 'AUTH_STATE' ? [{ state: message.state, automatedLogin: message.automatedLogin }] : []));

const failedReasonsOf = (run: Run): string[] => meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []));

describe('audit worker session (T26d-2): the automated login', () => {
  it('runs the automated login stage only, sends AUTHENTICATED with the result, and passes the state to the audit (AUDIT)', async () => {
    const run = await runWorker(startOf('AUDIT'), async () => ({ kind: 'AUTHENTICATED', state: STATE }));

    expect(run.manualCalls).toBe(0);
    expect(run.stageRequests).toHaveLength(1);
    const [request] = run.stageRequests;
    expect(Object.keys(request ?? {}).sort()).toEqual(['approvedTestOrigins', 'automatedLogin', 'config', 'navigationPacer', 'setup', 'signal']);
    expect(request).toMatchObject({ setup: SETUP, approvedTestOrigins: [ORIGIN], automatedLogin: AUTOMATED_LOGIN });
    expect(authStatesOf(run)).toEqual([
      { state: 'AUTHENTICATED', automatedLogin: { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null } },
    ]);
    expect(run.auditRuns).toHaveLength(1);
    expect(run.auditRuns[0]?.authentication?.initialState).toBe(STATE);
    expect(meaningful(run).map(({ type }) => type)).toEqual(['AUTH_STATE', 'FINISHED']);
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  it('ends a successful LOGIN_CHECK without the audit core, without FINISHED, with the exit code 0 (the state is discarded)', async () => {
    const run = await runWorker(startOf('LOGIN_CHECK'), async () => ({ kind: 'AUTHENTICATED', state: STATE }));

    expect(run.manualCalls).toBe(0);
    expect(run.auditRuns).toEqual([]);
    expect(meaningful(run).map(({ type }) => type)).toEqual(['AUTH_STATE']);
    expect(authStatesOf(run)).toEqual([
      { state: 'AUTHENTICATED', automatedLogin: { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null } },
    ]);
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
    expect(JSON.stringify(run.sent)).not.toContain('sid');
  });

  it.each([
    ['INVALID_CREDENTIALS (sent)', { kind: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null },
      { result: 'INVALID_CREDENTIALS', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null }],
    ['RATE_LIMITED with the deadline', { kind: 'RATE_LIMITED', submitted: 'YES', retryAfterUntil: RETRY_AFTER_UNTIL },
      { result: 'RATE_LIMITED', submitted: 'YES', retryAfterUntil: '20261010123005', formInvalidReason: null }],
    ['LOGIN_FORM_INVALID with the reason code', { kind: 'LOGIN_FORM_INVALID', submitted: 'NO', retryAfterUntil: null, formInvalidReason: 'ACTION_NOT_ALLOWED' },
      { result: 'LOGIN_FORM_INVALID', submitted: 'NO', retryAfterUntil: null, formInvalidReason: 'ACTION_NOT_ALLOWED' }],
    ['AUTH_RESULT_UNKNOWN (may have been sent)', { kind: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN', retryAfterUntil: null },
      { result: 'AUTH_RESULT_UNKNOWN', submitted: 'UNKNOWN', retryAfterUntil: null, formInvalidReason: null }],
    ['CREDENTIAL_UNAVAILABLE (not sent)', { kind: 'CREDENTIAL_UNAVAILABLE', submitted: 'NO', retryAfterUntil: null },
      { result: 'CREDENTIAL_UNAVAILABLE', submitted: 'NO', retryAfterUntil: null, formInvalidReason: null }],
  ] as const)('sends AUTOMATED_LOGIN_FAILED with %s and FAILED, and never falls back to the manual login (AUDIT and LOGIN_CHECK)', async (_name, result, report) => {
    for (const jobKind of ['AUDIT', 'LOGIN_CHECK'] as const) {
      const run = await runWorker(startOf(jobKind), async () => result as AutomatedLoginStageResult);
      expect(run.manualCalls, jobKind).toBe(0);
      expect(run.auditRuns, jobKind).toEqual([]);
      expect(authStatesOf(run), jobKind).toEqual([{ state: 'AUTOMATED_LOGIN_FAILED', automatedLogin: report }]);
      expect(failedReasonsOf(run), jobKind).toEqual([report.result]);
      expect(meaningful(run).map(({ type }) => type), jobKind).toEqual(['AUTH_STATE', 'FAILED']);
      expect(run.exitCode, jobKind).toBe(FAILURE_EXIT_CODE);
      expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok), jobKind).toBe(true);
    }
  });

  it('sends UNSUPPORTED_AUTH_STATE with the successful result when the login succeeded without a state', async () => {
    const run = await runWorker(startOf('AUDIT'), async () => ({ kind: 'UNSUPPORTED_AUTH_STATE', submitted: 'YES', retryAfterUntil: null }));
    expect(authStatesOf(run)).toEqual([
      { state: 'UNSUPPORTED_AUTH_STATE', automatedLogin: { result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null } },
    ]);
    expect(failedReasonsOf(run)).toEqual(['UNSUPPORTED_AUTH_STATE']);
    expect(run.auditRuns).toEqual([]);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
  });

  it('ends a stopped automated login with AUTH_RESULT_UNKNOWN and the observed submission, the exit code 5 and no FAILED', async () => {
    const run = await runWorker(startOf('LOGIN_CHECK'), async (request, emit) => {
      emit({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: false });
      expect(request.signal.aborted).toBe(true);
      return { kind: 'STOPPED', submitted: 'NO' };
    });
    expect(authStatesOf(run)).toEqual([
      { state: 'AUTOMATED_LOGIN_FAILED', automatedLogin: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'NO', retryAfterUntil: null, formInvalidReason: null } },
    ]);
    expect(failedReasonsOf(run)).toEqual([]);
    expect(run.exitCode).toBe(INTERRUPTED_EXIT_CODE);
  });

  it('refuses to log in when the digest does not include the same job kind (AUTH_SETUP_CHANGED)', async () => {
    const run = await runWorker(startOf('LOGIN_CHECK', 'AUDIT'), async () => ({ kind: 'AUTHENTICATED', state: STATE }));
    expect(run.stageRequests).toEqual([]);
    expect(run.manualCalls).toBe(0);
    expect(failedReasonsOf(run)).toEqual(['AUTH_SETUP_CHANGED']);
    expect(run.exitCode).toBe(CONFIG_ERROR_EXIT_CODE);
  });
});

// DEF-099 fix round 1: 自動ログインの段が「送った後に応答がなかった」（`responseAfterSubmission: false`）を返したら、`AUTH_STATE` の結果に同じ印を
// 載せる（親が試しを 2 回と数える）。応答があった回は、印を載せない（今どおり）。
describe('audit worker session (DEF-099 fix round 1): the response after the login submission', () => {
  it('reports an unanswered submission with the mark', async () => {
    const run = await runWorker(startOf('LOGIN_CHECK'), async () =>
      ({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null, responseAfterSubmission: false }));
    expect(authStatesOf(run)).toEqual([{
      state: 'AUTOMATED_LOGIN_FAILED',
      automatedLogin: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null, responseAfterSubmission: false },
    }]);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  it('reports a stopped stage after an unanswered submission with the mark', async () => {
    const run = await runWorker(startOf('LOGIN_CHECK'), async () => ({ kind: 'STOPPED', submitted: 'YES', responseAfterSubmission: false }));
    expect(authStatesOf(run)).toEqual([{
      state: 'AUTOMATED_LOGIN_FAILED',
      automatedLogin: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null, responseAfterSubmission: false },
    }]);
  });

  it('does not add the mark for an answered submission', async () => {
    const run = await runWorker(startOf('LOGIN_CHECK'), async () => ({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null }));
    expect(authStatesOf(run)).toEqual([{
      state: 'AUTOMATED_LOGIN_FAILED',
      automatedLogin: { result: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null },
    }]);
  });
});

// DEF-102 fix（サイトへの負荷の手順書の「ページの読み込みの間隔」）: 自動ログインの段とジョブに、同じ読み込みの間隔の部品を渡す。
describe('audit worker session (DEF-102 fix): the navigation pacing across the automated login', () => {
  /** 間隔の確かめに使う、設定のページの読み込みの最小の間隔（ms）。 */
  const INTERVAL_MS = 300;

  it('passes the pacer of the automated login stage to the discovery job', async () => {
    const run = await runWorker(startOf('DISCOVERY'), async () => ({ kind: 'AUTHENTICATED', state: STATE }), {
      minNavigationIntervalMs: INTERVAL_MS,
      executeDiscovery: async () => ({
        kind: 'RAN',
        runId: RUN_ID,
        runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID),
        runStatus: 'COMPLETE',
        exitCode: EXIT_CODES.COMPLETE,
        summary: { pagesRead: 1, pagesNotRead: 0, candidates: 0 },
      }),
    });

    expect(run.stageRequests).toHaveLength(1);
    expect(run.discoveryRequests).toHaveLength(1);
    expect(run.discoveryRequests[0]?.navigationPacer).toBe(run.stageRequests[0]?.navigationPacer);
  });

  it('passes the pacer of the automated login stage to the audit core without waiting itself (CCX-22)', async () => {
    let sentAt = Number.NaN;
    const run = await runWorker(startOf('AUDIT'), async (request) => {
      // ログインの段の Guard が、最後の要求の応答を受けた時刻を記録した場面。
      await request.navigationPacer.beforeNavigation();
      sentAt = Date.now();
      request.navigationPacer.recordDocumentRequestSent();
      return { kind: 'AUTHENTICATED', state: STATE };
    }, { minNavigationIntervalMs: INTERVAL_MS });

    expect(run.auditRuns).toHaveLength(1);
    expect(run.auditRuns[0]?.navigationPacer).toBe(run.stageRequests[0]?.navigationPacer);
    // ワーカーの側では待たない（この部品の読み込みの開始は、ログインの段の 1 回だけ。間隔の待ちは、Run Coordinator が最初の読み込みの前に行う）。
    expect(run.stageRequests[0]?.navigationPacer.snapshot().navigationCount).toBe(1);
    expect(run.auditCalledAt[0]).toBeGreaterThanOrEqual(sentAt);
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
  });
});
