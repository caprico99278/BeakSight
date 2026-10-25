// T27c（Task 27 の設計書の変更履歴「Blocker: T27c」の行の (2)）: ジョブの種類の一覧（`WORKER_JOB_KINDS`）に `DISCOVERY` と `READ_CHECK` を足した。
// ワーカーは、まだ対応していない種類の `START` を監査として扱わず、明示に拒む（fail-closed。T27d・T27e で対応を足す）:
// - `FAILED`（`JOB_KIND_NOT_SUPPORTED`）を送り、終了コード 1 で終える。
// - 設定を読まない、手動のログインの段も自動ログインの段も呼ばない、監査の中核を呼ばない（Run を作らない）、`FINISHED` を送らない。
// 偽の IPC の口と偽の中核で確かめる（本物の子 process は使わない）。
// T27e: `READ_CHECK` も対応した（`audit-worker-session-read-check.test.ts`）。ワーカーは 4 つの種類すべてに対応する。このファイルは、流れが渡されて
// いない種類（ここでは `READ_CHECK`。偽の依存に READ の確かめの流れを渡さない）の `START` を、同じく明示に拒むことを確かめる。契約が
// `READ_CHECK` に認証の指定と定義の一覧を求めるようになったので、それらを欠く `START` は、契約の違反（`PROTOCOL_VIOLATION`）で、同じく設定を
// 読まず、ログインも監査もしない。
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRunOutcome } from '../../src/cli/audit-run.js';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {AUTOMATED_LOGIN_MAX_LOGIN_ATTEMPTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_JOB_KIND_NOT_SUPPORTED_REASON,
  WORKER_JOB_KINDS,
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerJobKind,
  type WorkerStartAutomatedLogin,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import type { RunSummaryView } from '../../src/report/view-model.js';
import { WORKER_IMPLEMENTED_JOB_KINDS, startAuditWorker, type AuditWorker, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import { createTestConfig } from '../helpers/test-config.js';
import { sampleStartUpdateWrite, sampleStartWrite } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGET_CONFIG_PATH = 'local/targets/example-kind.json';
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example-kind"}}');
const OUTPUT_DIRECTORY = resolve('worker-session-kind-output');
const RUN_ID = 'RUN-20261011000001' as RunId;
const START_TIMEOUT_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
// T27d: `DISCOVERY` は対応した（`audit-worker-session-discovery.test.ts`）。T27e: `READ_CHECK` も対応した。ここで流れを渡さない種類は `READ_CHECK`。
const UNSUPPORTED_JOB_KINDS = ['READ_CHECK'] as const satisfies readonly WorkerJobKind[];
/** `READ_CHECK` の `START` の定義の一覧（T27e。契約が求める）。 */
const READ_CHECKS = Object.freeze([{
  readCheckId: 'read-kind-1',
  readCheckRevision: 1,
  targetPage: { origin: ORIGIN, path: '/admin/search' },
  definition: { targetIdentityDigest: `sha256:${'a'.repeat(64)}`, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
}]);

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-kind',
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
    failureConditions: { invalidCredentials: null, accountLocked: null, mfaRequired: null, credentialExpired: null },
  },
});
const MANUAL_SETUP: AuthSetup = Object.freeze({ ...SETUP, automatedLogin: null });
const AUTOMATED_LOGIN: WorkerStartAutomatedLogin = Object.freeze({ credentialRevision: 1, credentialRoot: resolve('example-kind-credential-root') });

const baseStart = (jobKind: WorkerJobKind): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-kind',
  jobKind,
  targetConfigPath: TARGET_CONFIG_PATH,
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
});

/** 種類ごとに契約が求める項目（`READ_CHECK` は定義の一覧）。 */
const kindFields = (jobKind: WorkerJobKind): Record<string, unknown> => (jobKind === 'READ_CHECK' ? { readChecks: READ_CHECKS } : {});

const automatedStart = (jobKind: WorkerJobKind): Record<string, unknown> => ({
  ...baseStart(jobKind),
  ...kindFields(jobKind),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind, automatedLogin: AUTOMATED_LOGIN }),
    automatedLogin: AUTOMATED_LOGIN,
  },
});

const manualStart = (jobKind: WorkerJobKind): Record<string, unknown> => ({
  ...baseStart(jobKind),
  ...kindFields(jobKind),
  authentication: {
    setup: MANUAL_SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(MANUAL_SETUP, [ORIGIN], { jobKind, automatedLogin: null }),
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

interface Calls {
  loadConfig: number;
  readTargetConfig: number;
  manualLogin: number;
  automatedLogin: number;
  audit: number;
}

interface Run {
  readonly sent: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly calls: Calls;
}

const workers: AuditWorker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

async function runWorker(start: Record<string, unknown>): Promise<Run> {
  const sent: WorkerToParentMessage[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  const calls: Calls = { loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 };
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
  const worker = startAuditWorker({
    channel,
    stderr: { write: () => Promise.resolve() },
    exit: () => undefined,
    loadConfig: () => {
      calls.loadConfig += 1;
      return Promise.resolve(config);
    },
    readTargetConfig: () => {
      calls.readTargetConfig += 1;
      return Promise.resolve(TARGET_CONFIG_BYTES);
    },
    executeAuditRun: () => {
      calls.audit += 1;
      return Promise.resolve(ranOutcome);
    },
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    runLoginStage: () => {
      calls.manualLogin += 1;
      return Promise.resolve({ kind: 'AUTH_SETUP_REQUIRED' });
    },
    runAutomatedLoginStage: () => {
      calls.automatedLogin += 1;
      return Promise.resolve({ kind: 'AUTH_RESULT_UNKNOWN', submitted: 'NO', retryAfterUntil: null });
    },
    startTimeoutMs: START_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  workers.push(worker);
  listeners.forEach((listener) => listener(start));
  const exitCode = await worker.exited;
  return { sent, exitCode, calls };
}

const meaningful = (run: Run): readonly WorkerToParentMessage[] => run.sent.filter(({ type }) => type !== 'HEARTBEAT' && type !== 'READY');

describe('worker job kinds (T27c)', () => {
  it('lists DISCOVERY and READ_CHECK after AUDIT and LOGIN_CHECK, and the worker implements all of them (T27d, T27e)', () => {
    // T30d: 書き込みのジョブ `WRITE_CREATE` を一覧に足した（ワーカーの対応は T30f。それまでは `JOB_KIND_NOT_SUPPORTED` で拒む。下の場合）。
    // T31e: 更新の書き込みのジョブ `WRITE_UPDATE` を一覧に足した（ワーカーの対応は T31g。それまでは `JOB_KIND_NOT_SUPPORTED` で拒む）。
    // T43c: 入口の確かめのジョブ `ENTRY_CHECK` を一覧の後ろに足した（ワーカーも対応する。流れが渡されていなければ拒む）。
    expect(WORKER_JOB_KINDS).toEqual(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK']);
    // T30f: ワーカーが書き込みのジョブに対応した（流れが渡されていなければ、下の場合のとおり `JOB_KIND_NOT_SUPPORTED` で拒む）。
    // T31g-2: 更新の書き込みのジョブにも対応した（同じ書き込みの流れ。流れが渡されていなければ、同じく拒む）。
    expect(WORKER_IMPLEMENTED_JOB_KINDS).toEqual(['AUDIT', 'LOGIN_CHECK', 'DISCOVERY', 'READ_CHECK', 'WRITE_CREATE', 'WRITE_UPDATE', 'ENTRY_CHECK']);
    expect(Object.isFrozen(WORKER_IMPLEMENTED_JOB_KINDS)).toBe(true);
  });

  it.each(UNSUPPORTED_JOB_KINDS)('accepts the shape of an authenticated START of %s with its definitions (the contract knows the kind)', (jobKind) => {
    expect(validateParentToWorkerMessage(automatedStart(jobKind)).ok).toBe(true);
    expect(validateParentToWorkerMessage(manualStart(jobKind)).ok).toBe(true);
  });

  it.each(UNSUPPORTED_JOB_KINDS)('rejects the shape of a START of %s without authentication or without definitions (T27e)', (jobKind) => {
    expect(validateParentToWorkerMessage(baseStart(jobKind)).ok).toBe(false);
    expect(validateParentToWorkerMessage({ ...baseStart(jobKind), ...kindFields(jobKind) }).ok).toBe(false);
    const { readChecks: _readChecks, ...withoutDefinitions } = automatedStart(jobKind);
    expect(validateParentToWorkerMessage(withoutDefinitions).ok).toBe(false);
  });
});

describe('audit worker session (T27c): a START of a job kind the worker does not implement yet', () => {
  it.each(UNSUPPORTED_JOB_KINDS)('rejects %s without authentication as a contract violation: no config, no login, no audit (T27e)', async (jobKind) => {
    const run = await runWorker({ ...baseStart(jobKind), ...kindFields(jobKind) });

    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['PROTOCOL_VIOLATION']);
    expect(meaningful(run).map(({ type }) => type)).toEqual(['FAILED']);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
  });

  it.each([
    ...UNSUPPORTED_JOB_KINDS.map((jobKind) => [`${jobKind} with the manual login`, manualStart(jobKind)] as const),
    ...UNSUPPORTED_JOB_KINDS.map((jobKind) => [`${jobKind} with the automated login`, automatedStart(jobKind)] as const),
  ])('rejects %s: FAILED with JOB_KIND_NOT_SUPPORTED, no config, no login, no audit', async (_name, start) => {
    const run = await runWorker(start);

    expect(meaningful(run).map(({ type }) => type)).toEqual(['FAILED']);
    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual([WORKER_JOB_KIND_NOT_SUPPORTED_REASON]);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  // T30d: 書き込みのジョブは、書き込みの流れが渡されていなければ（T30f）、設定を読まず、ログインも監査もせずに `JOB_KIND_NOT_SUPPORTED` で拒む。
  // T30e: 契約の検証（認証の指定と書き込みの指定が要る）を通った `START` だけ。通らない `START` は契約の違反（`PROTOCOL_VIOLATION`）。
  it.each([
    ['without authentication', { ...baseStart('WRITE_CREATE'), write: sampleStartWrite(ORIGIN) }],
    ['without the write specification', manualStart('WRITE_CREATE')],
  ] as const)('rejects a WRITE_CREATE START %s as a contract violation: no config, no login, no audit (T30e)', async (_name, start) => {
    const run = await runWorker(start);

    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['PROTOCOL_VIOLATION']);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
  });

  it.each([
    ['with the manual login', { ...manualStart('WRITE_CREATE'), write: sampleStartWrite(ORIGIN) }],
    ['with the automated login', { ...automatedStart('WRITE_CREATE'), write: sampleStartWrite(ORIGIN) }],
  ] as const)('rejects a WRITE_CREATE START %s: FAILED with JOB_KIND_NOT_SUPPORTED, no config, no login, no audit (T30d)', async (_name, start) => {
    const run = await runWorker(start);

    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual([WORKER_JOB_KIND_NOT_SUPPORTED_REASON]);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
  });

  // T31f: 更新の書き込みのジョブ（`WRITE_UPDATE`）は、UPDATE の指定のない `START` は契約の違反（`PROTOCOL_VIOLATION`）。T31g-2: 確かめを通った
  // `START` も、書き込みの流れが渡されていなければ `JOB_KIND_NOT_SUPPORTED` で拒む（`WRITE_CREATE` と同じ）。どちらも設定を読まず、ログインも監査もしない。
  it.each([
    ['without authentication', { ...baseStart('WRITE_UPDATE'), write: sampleStartUpdateWrite(ORIGIN) }],
    ['without the update block', { ...manualStart('WRITE_UPDATE'), write: sampleStartWrite(ORIGIN) }],
  ] as const)('rejects a WRITE_UPDATE START %s as a contract violation: no config, no login, no audit (T31f)', async (_name, start) => {
    const run = await runWorker(start);

    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['PROTOCOL_VIOLATION']);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
  });

  it.each([
    ['with the manual login', { ...manualStart('WRITE_UPDATE'), write: sampleStartUpdateWrite(ORIGIN) }],
    ['with the automated login', { ...automatedStart('WRITE_UPDATE'), write: sampleStartUpdateWrite(ORIGIN) }],
  ] as const)('rejects a valid WRITE_UPDATE START %s: FAILED with JOB_KIND_NOT_SUPPORTED, no config, no login, no audit (T31f)', async (_name, start) => {
    expect(validateParentToWorkerMessage(start).ok).toBe(true);
    const run = await runWorker(start);

    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual([WORKER_JOB_KIND_NOT_SUPPORTED_REASON]);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
  });

  // T30e: 依頼していない確かめ直しの結果は、親を信用しない（契約の違反）。
  it('rejects a WRITE_RECHECK_RESULT without a pending recheck request as a contract violation (T30e)', async () => {
    const run = await runWorker({ protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: true, reason: null });

    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['PROTOCOL_VIOLATION']);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
  });

  // T43c: 入口の確かめのジョブも、流れ（`executeEntryCheck`）が渡されていなければ、設定を読まず、ログインも監査もせずに `JOB_KIND_NOT_SUPPORTED` で拒む。
  it('rejects an ENTRY_CHECK START without its flow: FAILED with JOB_KIND_NOT_SUPPORTED, no config, no login, no audit (T43c)', async () => {
    const start = baseStart('ENTRY_CHECK');
    expect(validateParentToWorkerMessage(start).ok).toBe(true);
    const run = await runWorker(start);

    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual([WORKER_JOB_KIND_NOT_SUPPORTED_REASON]);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
    expect(run.calls).toEqual({ loadConfig: 0, readTargetConfig: 0, manualLogin: 0, automatedLogin: 0, audit: 0 });
  });

  it('still runs an AUDIT START (control: the implemented kinds are not rejected)', async () => {
    const run = await runWorker(baseStart('AUDIT'));

    expect(meaningful(run).map(({ type }) => type)).toEqual(['FINISHED']);
    expect(run.calls.audit).toBe(1);
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
  });
});
