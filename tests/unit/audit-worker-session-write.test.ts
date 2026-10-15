// T30f（Task 30 の設計書 3 章、4 章の「IPC」）: ワーカーの流れ（`audit-worker-session.ts`）の書き込みのジョブ（`WRITE_CREATE`）の振り分け。偽の
// 書き込みの流れ（`executeWriteCreate`）を渡し、ログインの段の後に書き込みの流れを呼ぶこと、確かめ直しの往復（`WRITE_RECHECK_REQUEST` →
// `WRITE_RECHECK_RESULT`）と送信の報告（`WRITE_SUBMISSION`、1 回）が IPC に流れること、`FINISHED`（結果を載せない）と終了コードを確かめる。
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../src/cli/exit-codes.js';
import { AUTH_SETUP_SCHEMA_VERSION_2, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import { startAuditWorker, type AuditWorker, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import type { WriteCreateRunOutcome, WriteCreateRunRequest } from '../../src/worker/write-create-run.js';
import type { WorkerWriteRecheckOutcome } from '../../src/worker/write-ipc.js';
import { createTestConfig } from '../helpers/test-config.js';
import { sampleStartUpdateWrite, sampleStartWrite } from './worker-write-samples.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGET_CONFIG_PATH = 'local/targets/example-write.json';
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example-write"}}');
const OUTPUT_DIRECTORY = resolve('worker-session-write-output');
const RUN_ID = 'RUN-20261013000001' as RunId;

const SETUP: AuthSetup = Object.freeze({
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_2,
  profileId: 'example-write',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/members', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const START = Object.freeze({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-write',
  jobKind: 'WRITE_CREATE',
  targetConfigPath: TARGET_CONFIG_PATH,
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'WRITE_CREATE', automatedLogin: null }),
  },
  write: sampleStartWrite(ORIGIN),
});

const workers: AuditWorker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

interface Run {
  readonly sent: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly requests: readonly WriteCreateRunRequest[];
  readonly rechecks: readonly WorkerWriteRecheckOutcome[];
}

/** T31g-2: 更新の書き込みのジョブの `START`（UPDATE の指定つき）。 */
const UPDATE_START = Object.freeze({
  ...START,
  jobId: 'job-update',
  jobKind: 'WRITE_UPDATE',
  authentication: {
    ...START.authentication,
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'WRITE_UPDATE', automatedLogin: null }),
  },
  write: sampleStartUpdateWrite(ORIGIN),
});

/** 偽の親（確かめ直しに `allowed` で答える）と偽の書き込みの流れで、ワーカーを 1 回動かす。 */
async function runWorker(allowed: boolean, start: Readonly<Record<string, unknown>> = START): Promise<Run> {
  const sent: WorkerToParentMessage[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  const requests: WriteCreateRunRequest[] = [];
  const rechecks: WorkerWriteRecheckOutcome[] = [];
  const channel: WorkerChannel = {
    send: (message) => {
      sent.push(message);
      if (message.type === 'WRITE_RECHECK_REQUEST') {
        const answer = allowed
          ? { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: true, reason: null }
          : { protocol: WORKER_PROTOCOL_VERSION, type: 'WRITE_RECHECK_RESULT', allowed: false, reason: 'GRANT_INVALID' };
        setTimeout(() => listeners.forEach((listener) => listener(answer)), 0);
      }
      return Promise.resolve(true);
    },
    onMessage: (listener) => {
      listeners.push(listener);
    },
    onDisconnect: () => undefined,
  };
  const config = { ...createTestConfig(ORIGIN, '/members/new'), output: { directory: OUTPUT_DIRECTORY } };
  const worker = startAuditWorker({
    channel,
    stderr: { write: () => Promise.resolve() },
    exit: () => undefined,
    loadConfig: () => Promise.resolve(config),
    readTargetConfig: () => Promise.resolve(TARGET_CONFIG_BYTES),
    executeAuditRun: () => Promise.reject(new Error('the audit must not run')),
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    runLoginStage: () => Promise.resolve({ kind: 'AUTHENTICATED', state: { cookies: [], origins: [] } }),
    executeWriteCreate: async (request, observer): Promise<WriteCreateRunOutcome> => {
      requests.push(request);
      observer.onRunStarted({ runId: RUN_ID, runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID) });
      const recheck = await request.recheck();
      rechecks.push(recheck);
      request.reportSubmission(recheck.allowed
        ? { submission: 'SENT', blockReason: null }
        : { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' });
      return {
        kind: 'RAN', runId: RUN_ID, runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID), runStatus: recheck.allowed ? 'COMPLETE' : 'PARTIAL',
        exitCode: recheck.allowed ? EXIT_CODES.COMPLETE : EXIT_CODES.PARTIAL, result: recheck.allowed ? 'VERIFIED' : 'BLOCKED',
      };
    },
    startTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_000,
  });
  workers.push(worker);
  listeners.forEach((listener) => listener(start));
  const exitCode = await worker.exited;
  return { sent, exitCode, requests, rechecks };
}

const meaningful = (run: Run): readonly string[] => run.sent.map(({ type }) => type).filter((type) => type !== 'HEARTBEAT' && type !== 'READY');

describe('T30f: the WRITE_CREATE job of the audit worker session', () => {
  it('logs in, runs the write flow with the write specification, relays the recheck and the submission report, and finishes', async () => {
    const run = await runWorker(true);
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]?.write).toEqual(START.write);
    // T32d: 承認の要約（`write.approvalFacts`）も、そのまま書き込みの流れの入口に届く（ワーカーは照らさない）。
    expect(run.requests[0]?.write.approvalFacts).toEqual(START.write.approvalFacts);
    expect(run.requests[0]?.write.approvalFacts.scenario.kind).toBe('CREATE');
    expect(run.requests[0]?.jobId).toBe('job-write');
    expect(run.rechecks).toEqual([{ allowed: true }]);
    expect(meaningful(run)).toEqual(['AUTH_STATE', 'RUN_STARTED', 'WRITE_RECHECK_REQUEST', 'WRITE_SUBMISSION', 'FINISHED']);
    expect(run.sent.find((message) => message.type === 'WRITE_SUBMISSION')).toMatchObject({ submission: 'SENT', blockReason: null });
    const finished = run.sent.find((message) => message.type === 'FINISHED');
    expect(finished).toMatchObject({ outcome: { kind: 'RAN', runId: RUN_ID, runStatus: 'COMPLETE' } });
    expect(finished).not.toHaveProperty('readCheck');
    expect(finished).not.toHaveProperty('discovery');
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  // T31g-2: 更新の書き込みのジョブも、同じ書き込みの流れ（`write.update` を持つ指定）に渡す。
  it('runs the write flow for a WRITE_UPDATE START with the update specification, and finishes (T31g-2)', async () => {
    const run = await runWorker(true, UPDATE_START);
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]?.write).toEqual(UPDATE_START.write);
    expect(run.requests[0]?.write.update).toBeDefined();
    expect(run.requests[0]?.write.approvalFacts.scenario.kind).toBe('UPDATE');
    expect(meaningful(run)).toEqual(['AUTH_STATE', 'RUN_STARTED', 'WRITE_RECHECK_REQUEST', 'WRITE_SUBMISSION', 'FINISHED']);
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  it('passes a rejected recheck to the write flow, which reports NOT_SENT', async () => {
    const run = await runWorker(false);
    expect(run.rechecks).toEqual([{ allowed: false, reason: 'GRANT_INVALID' }]);
    expect(run.sent.find((message) => message.type === 'WRITE_SUBMISSION')).toMatchObject({ submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' });
    expect(run.exitCode).toBe(EXIT_CODES.PARTIAL);
  });
});
