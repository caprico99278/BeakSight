// T43c（Task 43 の設計書 4.3）: ワーカーの流れの、入口の確かめのジョブ（`ENTRY_CHECK`）の扱いを、偽の IPC の口と偽の入口の確かめの流れで確かめる
// （本物の Chromium は `entry-check-run.test.ts`、子 process の端から端は `entry-check-job-fork.test.ts`）。
// - ログインの段を呼ばず、監査の中核も呼ばずに、入口の確かめの流れを、ジョブの ID・設定・止める印で呼ぶ（認証の指定は渡さない）。
// - 観測を IPC に写す: Run を作った → `RUN_STARTED`（新しい Run、出力先からの相対パス）。終わり → `FINISHED`（Run を実行した結果だけ件数の要約。
//   事実と案と URL を載せない）と、結果の終了コード。Run を実行しなかった結果（`RUN_ACTIVE`）は要約を付けない。
// - 流れの例外（成果物を書けない）は、監査と同じく `FAILED` の理由に分け、詳細の URL の秘密を伏せる。
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODES, RUN_UNAVAILABLE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import { ArtifactWriteError } from '../../src/report/artifact-writer.js';
import { startAuditWorker, type AuditWorker, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import type { EntryCheckRunObserver, EntryCheckRunOutcome, EntryCheckRunRequest } from '../../src/worker/entry-check-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGET_CONFIG_PATH = 'local/targets/example-entry.json';
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example-entry"}}');
const OUTPUT_DIRECTORY = resolve('worker-session-entry-check-output');
const RUN_ID = 'RUN-20261017010000' as RunId;
const START_TIMEOUT_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const SECRET_TOKEN = 'entry-secret-token-value';

const entryStart = (): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-entry',
  jobKind: 'ENTRY_CHECK',
  targetConfigPath: TARGET_CONFIG_PATH,
  startNew: true,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
});

const ranOutcome: EntryCheckRunOutcome = {
  kind: 'RAN',
  runId: RUN_ID,
  runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID),
  runStatus: 'COMPLETE',
  exitCode: EXIT_CODES.COMPLETE,
  summary: { endReason: 'READ', loginPage: true, proposedSelectors: 3 },
};

interface Run {
  readonly sent: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly requests: readonly EntryCheckRunRequest[];
  readonly calls: { loadConfig: number; login: number; automatedLogin: number; audit: number };
}

const workers: AuditWorker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

async function runWorker(executeEntryCheck: (request: EntryCheckRunRequest, observer: EntryCheckRunObserver) => Promise<EntryCheckRunOutcome>): Promise<Run> {
  const sent: WorkerToParentMessage[] = [];
  const listeners: ((value: unknown) => void)[] = [];
  const requests: EntryCheckRunRequest[] = [];
  const calls = { loadConfig: 0, login: 0, automatedLogin: 0, audit: 0 };
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
  const config = { ...createTestConfig(ORIGIN, '/login'), output: { directory: OUTPUT_DIRECTORY } };
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
      return Promise.reject(new Error('the audit must not run for an entry check job'));
    },
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    runLoginStage: () => {
      calls.login += 1;
      return Promise.reject(new Error('the login stage must not run for an entry check job'));
    },
    runAutomatedLoginStage: () => {
      calls.automatedLogin += 1;
      return Promise.reject(new Error('the automated login must not run for an entry check job'));
    },
    executeEntryCheck: (request, observer) => {
      requests.push(request);
      return executeEntryCheck(request, observer);
    },
    startTimeoutMs: START_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  workers.push(worker);
  listeners.forEach((listener) => listener(entryStart()));
  const exitCode = await worker.exited;
  return { sent, exitCode, requests, calls };
}

const meaningful = (run: Run): readonly WorkerToParentMessage[] => run.sent.filter(({ type }) => type !== 'HEARTBEAT' && type !== 'READY');

describe('audit worker session (T43c): the entry check job', () => {
  it('runs the entry check flow without the login stage and the audit, and sends RUN_STARTED and FINISHED with the summary', async () => {
    const run = await runWorker(async (_request, observer) => {
      observer.onRunStarted({ runId: RUN_ID, runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID) });
      return ranOutcome;
    });
    expect(run.calls).toEqual({ loadConfig: 1, login: 0, automatedLogin: 0, audit: 0 });
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]).toMatchObject({ jobId: 'job-entry' });
    expect(Object.keys(run.requests[0] ?? {})).not.toContain('authentication');
    expect(meaningful(run)).toEqual([
      {
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'RUN_STARTED',
        runId: RUN_ID,
        runDirectory: RUN_ID,
        resumeDecision: { kind: 'NEW_RUN', completedPages: null },
      },
      {
        protocol: WORKER_PROTOCOL_VERSION,
        type: 'FINISHED',
        outcome: { kind: 'RAN', exitCode: EXIT_CODES.COMPLETE, runId: RUN_ID, runDirectory: RUN_ID, runStatus: 'COMPLETE' },
        entryCheck: { endReason: 'READ', loginPage: true, proposedSelectors: 3 },
      },
    ]);
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  // T44g（Task 44 の設計書 P4-5。DEF-143 の残り）: 入口の確かめの流れが成果物を書く段に入ったら、監査と同じ口（`RUN_FINALIZING`）で親へ知らせる。
  it('relays the start of the finalizing stage of the entry check flow as RUN_FINALIZING, before FINISHED', async () => {
    const run = await runWorker(async (_request, observer) => {
      observer.onRunStarted({ runId: RUN_ID, runDirectory: resolve(OUTPUT_DIRECTORY, RUN_ID) });
      observer.onFinalizing?.();
      return ranOutcome;
    });
    expect(meaningful(run).map(({ type }) => type)).toEqual(['RUN_STARTED', 'RUN_FINALIZING', 'FINISHED']);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
  });

  it('sends FINISHED without the summary for a Run that did not run', async () => {
    const run = await runWorker(() => Promise.resolve({ kind: 'RUN_ACTIVE', activeRunId: null, exitCode: RUN_UNAVAILABLE_EXIT_CODE }));
    expect(meaningful(run)).toEqual([{
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'FINISHED',
      outcome: { kind: 'RUN_ACTIVE', exitCode: RUN_UNAVAILABLE_EXIT_CODE, runId: null, runDirectory: null, runStatus: null },
    }]);
    expect(run.exitCode).toBe(RUN_UNAVAILABLE_EXIT_CODE);
  });

  it('reports a failure of the flow as FAILED, hiding the secrets of a URL in the detail', async () => {
    const run = await runWorker(() => Promise.reject(new ArtifactWriteError(`${ORIGIN}/login?token=${SECRET_TOKEN}`, new Error('disk full'))));
    const failed = meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message] : []));
    expect(failed.map(({ reason }) => reason)).toEqual(['ARTIFACT_WRITE_FAILED']);
    expect(failed.every(({ detail }) => !detail.includes(SECRET_TOKEN))).toBe(true);
  });
});
