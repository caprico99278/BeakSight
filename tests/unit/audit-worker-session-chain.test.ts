// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1）: ワーカーのまとめて実行（ログイン 1 回の後に段を続ける）を、偽の IPC の口と偽のログインの段と
// 偽の流れで確かめる（本物の子 process と Chromium は `tests/integration/stage-chain-fork-default.test.ts`・`stage-chain-fork-cli.test.ts`。中身は
// `stage-chain-fork-cases.ts`）。
// - ログインは 1 回。段ごとに `RUN_STARTED`・`FINISHED`（未完了の理由のコードつき）を送り、途中の段の後に親の `NEXT_STAGE`・`CHAIN_END` を待つ。
// - 次の段の認証の指定の初めの状態は、前の段の持ち越し（factory の最新の状態）。1 分の窓も次の段へ渡す。pacer は同じもの。
// - 状態の値は IPC に出ない。`CHAIN_END`・止める要求・待つ上限では、次の段を始めない。持ち越しがなければ `FAILED`。
// - 待っていないときの `NEXT_STAGE`、違う種類の `NEXT_STAGE` は契約の違反。
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditRunDependencies, AuditRunOutcome } from '../../src/cli/audit-run.js';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId } from '../../src/core/contracts.js';
import type { RunSummaryView } from '../../src/report/view-model.js';
import { startAuditWorker, type AuditWorker, type WorkerChannel } from '../../src/worker/audit-worker-session.js';
import type { LoginStageResult } from '../../src/worker/authenticated-login.js';
import type { DiscoveryRunObserver, DiscoveryRunOutcome, DiscoveryRunRequest } from '../../src/worker/discovery-run.js';
import type { ReadCheckRunObserver, ReadCheckRunOutcome, ReadCheckRunRequest } from '../../src/worker/read-check-run.js';
import { createTestConfig } from '../helpers/test-config.js';

const ORIGIN = 'http://127.0.0.1:4173';
const TARGET_CONFIG_PATH = 'local/targets/example-chain.json';
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example-chain"}}');
const OUTPUT_DIRECTORY = resolve('worker-session-chain-output');
const AUDIT_RUN = 'RUN-20261022010000' as RunId;
const DISCOVERY_RUN = 'RUN-20261022010100' as RunId;
const READ_RUN = 'RUN-20261022010200' as RunId;
/** ログインの段の状態の目印（IPC に出ないことを確かめる）。 */
const LOGIN_VALUE = 'chain-login-marker-1';
/** 監査の段の後の状態の目印（次の段に渡ることを確かめる）。 */
const AUDIT_VALUE = 'chain-audit-marker-2';
const DISCOVERY_VALUE = 'chain-discovery-marker-3';

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-chain',
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

const stateWith = (value: string): Extract<LoginStageResult, { readonly kind: 'AUTHENTICATED' }>['state'] => ({
  cookies: [{ name: 'sid', value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }],
  origins: [],
});

const READ_CHECKS = Object.freeze([{
  readCheckId: 'read-1',
  readCheckRevision: 3,
  targetPage: { origin: ORIGIN, path: '/admin/search' },
  definition: { targetIdentityDigest: `sha256:${'c'.repeat(64)}`, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
}]);

const chainStart = (): Record<string, unknown> => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'START',
  jobId: 'job-audit',
  jobKind: 'AUDIT',
  targetConfigPath: TARGET_CONFIG_PATH,
  startNew: false,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
  authentication: {
    setup: SETUP,
    approvedTestOrigins: [ORIGIN],
    authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: 'AUDIT', automatedLogin: null }),
  },
  chain: { stages: ['AUDIT', 'DISCOVERY', 'READ_CHECK'] },
});

const auditOutcome: AuditRunOutcome = {
  kind: 'RAN',
  runId: AUDIT_RUN,
  runDirectory: resolve(OUTPUT_DIRECTORY, AUDIT_RUN),
  runStatus: 'PARTIAL',
  exitCode: EXIT_CODES.PARTIAL,
  resumeDecision: { kind: 'NEW_RUN' },
  notices: [],
  summary: { incompleteReasons: [{ code: 'MAX_PAGES_REACHED' }, { code: 'NAVIGATION_FAILED' }, { code: 'MAX_PAGES_REACHED' }] } as unknown as RunSummaryView,
  checkpointWarnings: [],
};

const discoveryOutcome: DiscoveryRunOutcome = {
  kind: 'RAN',
  runId: DISCOVERY_RUN,
  runDirectory: resolve(OUTPUT_DIRECTORY, DISCOVERY_RUN),
  runStatus: 'COMPLETE',
  exitCode: EXIT_CODES.COMPLETE,
  summary: { pagesRead: 3, pagesNotRead: 0, candidates: 2 },
  endReason: 'COMPLETED',
};

const readOutcome: ReadCheckRunOutcome = {
  kind: 'RAN',
  runId: READ_RUN,
  runDirectory: resolve(OUTPUT_DIRECTORY, READ_RUN),
  runStatus: 'COMPLETE',
  exitCode: EXIT_CODES.COMPLETE,
  summary: { checks: 1, executed: 1 },
  endReason: 'COMPLETED',
};

/** 親の振る舞い（途中の段の `FINISHED` を受けたときに返すメッセージ。`null` は返さない）。 */
type ParentReply = (finishedCount: number) => Record<string, unknown> | null;

interface Run {
  readonly sent: readonly WorkerToParentMessage[];
  readonly exitCode: number;
  readonly calls: { login: number; audit: number; discovery: number; read: number };
  readonly auditDependencies: readonly AuditRunDependencies[];
  readonly discoveryRequests: readonly DiscoveryRunRequest[];
  readonly readRequests: readonly ReadCheckRunRequest[];
  /** FM2R の C-1: 発見と READ の段の最初の読み込みの前に待った時間（ms）。 */
  readonly waits: { readonly discovery: number | null; readonly read: number | null };
}

/** FM2R の C-1: 監査の段と発見の段で上げた最小の間隔（ms。設定の間隔より大きい）。 */
const AUDIT_RAISED_INTERVAL_MS = 400;
const DISCOVERY_RAISED_INTERVAL_MS = 500;
/** タイマーの粒の許容（ms）。待ちの始まりは、段の終わりの記録より少し後なので、待つ時間は上げた間隔より少し短くなりうる。 */
const TIMER_TOLERANCE_MS = 60;

const workers: AuditWorker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

const NEXT_DISCOVERY = { protocol: WORKER_PROTOCOL_VERSION, type: 'NEXT_STAGE', jobId: 'job-discovery', jobKind: 'DISCOVERY' };
const NEXT_READ = { protocol: WORKER_PROTOCOL_VERSION, type: 'NEXT_STAGE', jobId: 'job-read', jobKind: 'READ_CHECK', readChecks: READ_CHECKS };
const CHAIN_END = { protocol: WORKER_PROTOCOL_VERSION, type: 'CHAIN_END' };

/** 段を順に進める親（1 回目の `FINISHED` に発見、2 回目に READ）。 */
const advancingParent: ParentReply = (count) => (count === 1 ? NEXT_DISCOVERY : NEXT_READ);

async function runWorker(options: {
  readonly reply: ParentReply;
  readonly carryAudit?: boolean;
  /** 監査の段の中で、親から受ける（止める要求など）。 */
  readonly duringAudit?: (emit: (value: unknown) => void) => void;
  readonly nextStageTimeoutMs?: number;
}): Promise<Run> {
  const sent: WorkerToParentMessage[] = [];
  const waits: { discovery: number | null; read: number | null } = { discovery: null, read: null };
  const listeners: ((value: unknown) => void)[] = [];
  const emit = (value: unknown): void => listeners.forEach((listener) => listener(value));
  const calls = { login: 0, audit: 0, discovery: 0, read: 0 };
  const auditDependencies: AuditRunDependencies[] = [];
  const discoveryRequests: DiscoveryRunRequest[] = [];
  const readRequests: ReadCheckRunRequest[] = [];
  let finished = 0;
  const channel: WorkerChannel = {
    send: (message) => {
      sent.push(message);
      if (message.type === 'FINISHED') {
        finished += 1;
        const reply = options.reply(finished);
        if (reply !== null) {
          setImmediate(() => emit(reply));
        }
      }
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
    loadConfig: () => Promise.resolve(config),
    readTargetConfig: () => Promise.resolve(TARGET_CONFIG_BYTES),
    executeAuditRun: async (_config, dependencies, _options, observer) => {
      calls.audit += 1;
      auditDependencies.push(dependencies);
      observer.onRunStarted?.({ runId: AUDIT_RUN, runDirectory: resolve(OUTPUT_DIRECTORY, AUDIT_RUN), resumeDecision: { kind: 'NEW_RUN' } });
      options.duringAudit?.(emit);
      if (options.carryAudit !== false) {
        dependencies.stageCarry?.record({
          latestState: stateWith(AUDIT_VALUE),
          serviceRequestWindowMs: [1_000, 2_000],
          // FM2R の C-1: 監査の段の最後の読み込みと段の終わりは今、サイトの不調で上げた間隔は `AUDIT_RAISED_INTERVAL_MS`。
          navigation: { lastNavigationStartedAtMs: Date.now(), stageEndedAtMs: Date.now(), minIntervalMs: AUDIT_RAISED_INTERVAL_MS },
        });
      }
      return auditOutcome;
    },
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    runLoginStage: () => {
      calls.login += 1;
      return Promise.resolve({ kind: 'AUTHENTICATED', state: stateWith(LOGIN_VALUE) });
    },
    executeDiscovery: async (request: DiscoveryRunRequest, observer: DiscoveryRunObserver) => {
      calls.discovery += 1;
      discoveryRequests.push(request);
      observer.onRunStarted({ runId: DISCOVERY_RUN, runDirectory: resolve(OUTPUT_DIRECTORY, DISCOVERY_RUN) });
      // FM2R の C-1: 発見の段の最初の読み込みの前に待った時間（前の段の持ち越しから待つ）。
      waits.discovery = await request.navigationPacer?.beforeNavigation() ?? null;
      request.stageCarry?.record({
        latestState: stateWith(DISCOVERY_VALUE),
        serviceRequestWindowMs: [3_000],
        navigation: { lastNavigationStartedAtMs: Date.now(), stageEndedAtMs: Date.now(), minIntervalMs: DISCOVERY_RAISED_INTERVAL_MS },
      });
      return discoveryOutcome;
    },
    executeReadCheck: async (request: ReadCheckRunRequest, observer: ReadCheckRunObserver) => {
      calls.read += 1;
      readRequests.push(request);
      waits.read = await request.navigationPacer?.beforeNavigation() ?? null;
      observer.onRunStarted({ runId: READ_RUN, runDirectory: resolve(OUTPUT_DIRECTORY, READ_RUN) });
      return readOutcome;
    },
    startTimeoutMs: 2_000,
    heartbeatIntervalMs: 1_000,
    ...(options.nextStageTimeoutMs === undefined ? {} : { nextStageTimeoutMs: options.nextStageTimeoutMs }),
  });
  workers.push(worker);
  emit(chainStart());
  const exitCode = await worker.exited;
  return { sent, exitCode, calls, auditDependencies, discoveryRequests, readRequests, waits };
}

const meaningful = (run: Run): readonly WorkerToParentMessage[] => run.sent.filter(({ type }) => type !== 'HEARTBEAT' && type !== 'READY');

describe('audit worker session (FM2d): the chained run', () => {
  it('logs in once, runs the audit, the discovery and the READ check, and carries the latest state, the window and the pacer', async () => {
    const run = await runWorker({ reply: advancingParent });

    expect(run.calls).toEqual({ login: 1, audit: 1, discovery: 1, read: 1 });
    // 監査の段: ログインの状態から始め、外の pacer と持ち越しの口を渡す（手動のログインでも pacer を渡す）。
    const [auditDependencies] = run.auditDependencies;
    expect(auditDependencies?.authentication?.initialState).toEqual(stateWith(LOGIN_VALUE));
    expect(auditDependencies?.navigationPacer).toBeDefined();
    expect(auditDependencies?.stageCarry?.serviceRequestWindowMs).toEqual([]);
    // 発見の段: 監査の段の最新の状態と窓から始め、同じ pacer を使う。
    const [discovery] = run.discoveryRequests;
    expect(discovery?.jobId).toBe('job-discovery');
    expect(discovery?.authentication.initialState).toEqual(stateWith(AUDIT_VALUE));
    expect(discovery?.stageCarry?.serviceRequestWindowMs).toEqual([1_000, 2_000]);
    // FM2R の C-1: 発見の段の pacer は、監査の段の持ち越し（段の終わり・上げた間隔）から作った新しいもので、最初の読み込みの前に上げた間隔だけ待つ。
    expect(discovery?.navigationPacer).not.toBe(auditDependencies?.navigationPacer);
    expect(run.waits.discovery ?? 0).toBeGreaterThanOrEqual(AUDIT_RAISED_INTERVAL_MS - TIMER_TOLERANCE_MS);
    // READ の段: 発見の段の最新の状態と窓、親が渡した定義。
    const [read] = run.readRequests;
    expect(read?.jobId).toBe('job-read');
    expect(read?.readChecks).toEqual(READ_CHECKS);
    expect(read?.authentication.initialState).toEqual(stateWith(DISCOVERY_VALUE));
    expect(read?.stageCarry?.serviceRequestWindowMs).toEqual([3_000]);
    expect(read?.navigationPacer).not.toBe(discovery?.navigationPacer);
    expect(run.waits.read ?? 0).toBeGreaterThanOrEqual(DISCOVERY_RAISED_INTERVAL_MS - TIMER_TOLERANCE_MS);

    expect(meaningful(run).map((message) => (message.type === 'RUN_STARTED' ? `RUN_STARTED:${message.runId}` : message.type))).toEqual([
      'AUTH_STATE', `RUN_STARTED:${AUDIT_RUN}`, 'FINISHED', `RUN_STARTED:${DISCOVERY_RUN}`, 'FINISHED', `RUN_STARTED:${READ_RUN}`, 'FINISHED',
    ]);
    const finished = meaningful(run).filter((message) => message.type === 'FINISHED');
    expect(finished.map((message) => (message.type === 'FINISHED' ? message.incompleteReasonCodes : null)))
      .toEqual([['MAX_PAGES_REACHED', 'NAVIGATION_FAILED'], [], []]);
    expect(run.exitCode).toBe(EXIT_CODES.COMPLETE);
    expect(run.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
    // 状態の値は IPC に出ない。
    const ipc = JSON.stringify(run.sent);
    for (const marker of [LOGIN_VALUE, AUDIT_VALUE, DISCOVERY_VALUE]) {
      expect(ipc).not.toContain(marker);
    }
  });

  it('does not start the next stage on CHAIN_END, and exits with the exit code of the finished stage', async () => {
    const run = await runWorker({ reply: () => CHAIN_END });
    expect(run.calls).toEqual({ login: 1, audit: 1, discovery: 0, read: 0 });
    expect(run.exitCode).toBe(EXIT_CODES.PARTIAL);
  });

  it('does not start the next stage after a stop during a stage, nor wait for the parent', async () => {
    const run = await runWorker({
      reply: advancingParent,
      duringAudit: (emit) => emit({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: false }),
    });
    expect(run.calls).toEqual({ login: 1, audit: 1, discovery: 0, read: 0 });
    expect(run.exitCode).toBe(EXIT_CODES.PARTIAL);
  });

  it('does not start the next stage on a stop while it waits for the next stage', async () => {
    const run = await runWorker({ reply: () => ({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: false }) });
    expect(run.calls).toEqual({ login: 1, audit: 1, discovery: 0, read: 0 });
    expect(run.exitCode).toBe(EXIT_CODES.PARTIAL);
  });

  it('ends without the next stage when the parent does not answer in time', async () => {
    const run = await runWorker({ reply: () => null, nextStageTimeoutMs: 50 });
    expect(run.calls).toEqual({ login: 1, audit: 1, discovery: 0, read: 0 });
    expect(run.exitCode).toBe(EXIT_CODES.PARTIAL);
  });

  it('fails the next stage when the latest state of the previous stage was not carried over (fail-closed)', async () => {
    const run = await runWorker({ reply: advancingParent, carryAudit: false });
    expect(run.calls).toEqual({ login: 1, audit: 1, discovery: 0, read: 0 });
    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['UNEXPECTED_FAILURE']);
    expect(run.exitCode).toBe(FAILURE_EXIT_CODE);
  });

  it('treats NEXT_STAGE of another kind as a protocol violation', async () => {
    const run = await runWorker({ reply: () => NEXT_READ });
    expect(run.calls.read).toBe(0);
    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['PROTOCOL_VIOLATION']);
  });

  it('treats NEXT_STAGE while the worker does not wait as a protocol violation', async () => {
    const run = await runWorker({ reply: advancingParent, duringAudit: (emit) => emit(NEXT_DISCOVERY) });
    expect(run.calls.discovery).toBe(0);
    expect(meaningful(run).flatMap((message) => (message.type === 'FAILED' ? [message.reason] : []))).toEqual(['PROTOCOL_VIOLATION']);
  });
});
