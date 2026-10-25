// T24d（Task 24 の設計書 4.2、4.3）: 監査のワーカーの流れ（`src/worker/audit-worker-session.ts`）を、偽の IPC の口と偽の中核で確かめる。
// 本物の子のプロセス・Chromium・fixture のサーバでの確かめは、`tests/integration/audit-worker.test.ts`。
// - 起動から終わりまで: `READY` → `START` の検証 → 設定の読み込み（`--headless` に当たる上書きだけ）→ 中核 → `RUN_STARTED`・`PROGRESS`・
//   `NOTICE` → `FINISHED` → 結果の終了コードで終わる。
// - 失敗: 設定の誤りと予期しない例外は `classifyCliFailure` で分けて `FAILED`、同じ終了コード。
// - 止め方: `STOP`（止める印）、`force` の `STOP` と 2 回目の `STOP`（終了コード 5）、Ctrl+C、IPC の切断、`START` の前の止め方。
// - 信頼の境界: 形の違う `START`、2 回目の `START`、形の違うメッセージ、`START` が来ない、ワーカー自身が作った形の違うメッセージ。
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditRunDependencies, AuditRunObserver, AuditRunOptions, AuditRunOutcome } from '../../src/cli/audit-run.js';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import { ConfigError } from '../../src/config/config-error.js';
import type { AuditConfig, AuditConfigOverrides } from '../../src/config/types.js';
import {
  MAX_WORKER_FAILURE_DETAIL_LENGTH,
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_PROTOCOL_VERSION,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import type { RunId, RunProgressReport } from '../../src/core/contracts.js';
import type { RunSummaryView } from '../../src/report/view-model.js';
import { CLI_TEXT } from '../../src/presentation/messages.js';
import {
  startAuditWorker,
  WORKER_CONFIG_OVERRIDES,
  WORKER_SHOWN_BROWSER_CONFIG_OVERRIDES,
  type AuditWorker,
  type WorkerChannel,
} from '../../src/worker/audit-worker-session.js';
import { HEADED_CONFIG_OVERRIDES, withAuditSendPolicyOverride } from '../../src/config/config-overrides.js';
import { createDeferred, type Deferred } from '../helpers/deferred.js';

const OUTPUT_DIRECTORY = resolve('worker-session-output');
const RUN_ID = 'RUN-20261009000001' as RunId;
const RUN_DIRECTORY = join(OUTPUT_DIRECTORY, RUN_ID);
const TARGET_CONFIG_PATH = 'config/targets/example.json';
/** テストの時間（ワーカーの名前つきの時間の代わりに注入する。ms）。 */
const START_TIMEOUT_MS = 50;
const HEARTBEAT_INTERVAL_MS = 10;
/** 生きている合図を数えるために待つ時間（ms。間隔の数回分）。 */
const HEARTBEAT_OBSERVATION_MS = 80;

/** 親が検証したターゲット JSON の内容と、その SHA-256（T24h-1 の M3）。 */
const TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"example"}}');
const CHANGED_TARGET_CONFIG_BYTES = new TextEncoder().encode('{"target":{"id":"changed"}}');
const START = Object.freeze({
  protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-1', jobKind: 'AUDIT', targetConfigPath: TARGET_CONFIG_PATH, startNew: true,
  targetConfigSha256: targetConfigDigestOf(TARGET_CONFIG_BYTES),
});
const STOP = Object.freeze({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: false });
const FORCE_STOP = Object.freeze({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: true });

const PROGRESS: RunProgressReport = Object.freeze({
  pagesFinished: 1,
  pagesDiscovered: 3,
  maxPages: 10,
  elapsedMs: 100,
  navigationCount: 2,
  pacingWaitMs: 0,
  requests: {
    allowedOrigins: { count: 4, peakPerMinute: 4 },
    otherOrigins: { count: 0, peakPerMinute: 0 },
    servedFromCache: 0,
    withheldOtherOrigins: 0,
  },
  recentPerMinute: { allowedOrigins: 4, otherOrigins: 0 },
});

const ranOutcome = (exitCode: number = EXIT_CODES.COMPLETE): AuditRunOutcome => ({
  kind: 'RAN',
  runId: RUN_ID,
  runDirectory: RUN_DIRECTORY,
  runStatus: exitCode === EXIT_CODES.PARTIAL ? 'PARTIAL' : 'COMPLETE',
  exitCode,
  resumeDecision: { kind: 'NEW_RUN' },
  notices: [],
  summary: {} as RunSummaryView,
  checkpointWarnings: [],
});

/** 偽の IPC の口（送ったメッセージを記録し、親のメッセージと切断を起こせる）。 */
interface FakeChannel extends WorkerChannel {
  readonly sent: WorkerToParentMessage[];
  emit(value: unknown): void;
  disconnect(): void;
}

function fakeChannel(): FakeChannel {
  const sent: WorkerToParentMessage[] = [];
  const messageListeners: ((value: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  let connected = true;
  return {
    sent,
    send: (message) => {
      if (!connected) {
        return Promise.resolve(false);
      }
      sent.push(message);
      return Promise.resolve(true);
    },
    onMessage: (listener) => {
      messageListeners.push(listener);
    },
    onDisconnect: (listener) => {
      disconnectListeners.push(listener);
    },
    emit: (value) => {
      for (const listener of messageListeners) {
        listener(value);
      }
    },
    disconnect: () => {
      connected = false;
      for (const listener of disconnectListeners) {
        listener();
      }
    },
  };
}

interface Harness {
  readonly channel: FakeChannel;
  readonly worker: AuditWorker;
  readonly stderr: string[];
  readonly loadConfigCalls: (readonly [string, AuditConfigOverrides])[];
  readonly runCalls: { readonly dependencies: AuditRunDependencies; readonly options: AuditRunOptions; readonly observer: AuditRunObserver }[];
  /** 中核の結果（テストが決める）。 */
  readonly outcome: Deferred<AuditRunOutcome>;
  /** 中核が呼ばれた。 */
  readonly runStarted: Promise<void>;
  readonly exits: number[];
}

const workers: AuditWorker[] = [];
/** 最後に作ったワーカーが、ターゲット JSON を読んだパス。 */
let targetConfigReadCalls: string[] = [];

afterEach(async () => {
  // 終わっていないワーカーのタイマーを残さない。
  for (const worker of workers.splice(0)) {
    worker.dispose();
  }
});

function startHarness(options: {
  readonly loadConfigError?: unknown;
  /** ターゲット JSON を読むたびに返す内容（順に使い、尽きたら最後のもの。`Error` なら読めない）。既定は親が検証した内容。 */
  readonly targetConfigReads?: readonly (Uint8Array | Error)[];
} = {}): Harness {
  const reads = [...(options.targetConfigReads ?? [TARGET_CONFIG_BYTES])];
  const readCalls: string[] = [];
  targetConfigReadCalls = readCalls;
  const channel = fakeChannel();
  const stderr: string[] = [];
  const loadConfigCalls: (readonly [string, AuditConfigOverrides])[] = [];
  const runCalls: Harness['runCalls'] = [];
  const outcome = createDeferred<AuditRunOutcome>();
  const runStartedDeferred = createDeferred<undefined>();
  const exits: number[] = [];
  const worker = startAuditWorker({
    channel,
    stderr: { write: (text) => { stderr.push(text); return Promise.resolve(); } },
    exit: (code) => { exits.push(code); },
    readTargetConfig: (path) => {
      readCalls.push(path);
      const next = reads.length > 1 ? reads.shift() : reads[0];
      return next instanceof Error || next === undefined ? Promise.reject(next ?? new Error('no content')) : Promise.resolve(next);
    },
    loadConfig: (path, overrides) => {
      loadConfigCalls.push([path, overrides]);
      if (options.loadConfigError !== undefined) {
        return Promise.reject(options.loadConfigError);
      }
      return Promise.resolve({ output: { directory: OUTPUT_DIRECTORY } } as AuditConfig);
    },
    executeAuditRun: (_config, dependencies, runOptions, observer) => {
      runCalls.push({ dependencies, options: runOptions, observer });
      runStartedDeferred.resolve(undefined);
      return outcome.promise;
    },
    runDependencies: { launchBrowser: () => Promise.reject(new Error('not used')), clock: () => new Date(), now: () => Date.now() },
    startTimeoutMs: START_TIMEOUT_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  workers.push(worker);
  return {
    channel, worker, stderr, loadConfigCalls, runCalls, outcome, exits,
    runStarted: runStartedDeferred.promise.then(() => undefined),
  };
}

const typesOf = (messages: readonly WorkerToParentMessage[]): string[] =>
  messages.map(({ type }) => type).filter((type) => type !== 'HEARTBEAT');

const onlyRunCall = (harness: Harness): Harness['runCalls'][number] => {
  expect(harness.runCalls).toHaveLength(1);
  const call = harness.runCalls[0];
  if (call === undefined) {
    throw new Error('the audit core was not called');
  }
  return call;
};

const failedOf = (harness: Harness): Extract<WorkerToParentMessage, { readonly type: 'FAILED' }>[] =>
  harness.channel.sent.filter((message): message is Extract<WorkerToParentMessage, { readonly type: 'FAILED' }> => message.type === 'FAILED');

// FM-2（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 2.2）: `START` の `showJobBrowser` が真なら、ジョブのブラウザを表示する上書き
// （`WORKER_SHOWN_BROWSER_CONFIG_OVERRIDES`。設定の owner の `HEADED_CONFIG_OVERRIDES`）で設定を読む。偽か省略は今どおり headless。
describe('audit worker session (FM-2): the job browser display', () => {
  it.each<[string, Record<string, unknown>, boolean]>([
    ['shown', { showJobBrowser: true }, true],
    ['not shown', { showJobBrowser: false }, false],
    ['absent (as before)', {}, false],
  ])('reads the configuration with the headed override when the job browser is %s', async (_label, item, headed) => {
    const harness = startHarness();
    harness.channel.emit({ ...START, ...item });
    await harness.runStarted;
    // AS-b: 監査の段の送信の扱いの上書きも一緒に渡す（項目がなければ読み取りだけ）。
    expect(harness.loadConfigCalls).toEqual([[TARGET_CONFIG_PATH, { browser: { headed }, audit: { sendPolicy: 'READ_ONLY' } }]]);
    expect(WORKER_SHOWN_BROWSER_CONFIG_OVERRIDES).toBe(HEADED_CONFIG_OVERRIDES);
    expect(HEADED_CONFIG_OVERRIDES).toEqual({ browser: { headed: true } });
    expect(Object.isFrozen(HEADED_CONFIG_OVERRIDES)).toBe(true);
  });
});

// AS-b（設計書 `2026-10-19-beaksight-audit-send-policy-design.md` 2.1）: `START` の `auditSendPolicy` を、実効の設定の上書き（`audit.sendPolicy`）として
// 当てて読む。項目がない `START`（書き込み・ログインの確かめ・入口の確かめと、項目を持たない監査）は、ターゲット JSON の値によらず `READ_ONLY` で読む
// （fail-closed。書き込みとログインの段には口を渡さない）。上書きの形は設定の owner の部品（`withAuditSendPolicyOverride`）が作る。
describe('audit worker session (AS-b): the audit send policy', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['PASS_EXCEPT_DELETE', { auditSendPolicy: 'PASS_EXCEPT_DELETE' }, 'PASS_EXCEPT_DELETE'],
    ['READ_ONLY', { auditSendPolicy: 'READ_ONLY' }, 'READ_ONLY'],
    ['absent', {}, 'READ_ONLY'],
  ])('reads the configuration with the audit send policy %s', async (_label, item, sendPolicy) => {
    const harness = startHarness();
    harness.channel.emit({ ...START, showJobBrowser: true, ...item });
    await harness.runStarted;
    expect(harness.loadConfigCalls).toEqual([[TARGET_CONFIG_PATH, { browser: { headed: true }, audit: { sendPolicy } }]]);
    const [[, overrides] = []] = harness.loadConfigCalls;
    expect(Object.isFrozen(overrides)).toBe(true);
    expect(withAuditSendPolicyOverride(HEADED_CONFIG_OVERRIDES, 'PASS_EXCEPT_DELETE')).toEqual({ browser: { headed: true }, audit: { sendPolicy: 'PASS_EXCEPT_DELETE' } });
    expect(HEADED_CONFIG_OVERRIDES).toEqual({ browser: { headed: true } });
  });
});

// PRE42-BN（2026-10-24 のユーザーの判断）: `START` の `profileName` を、監査の中核の指定（`AuditRunOptions.profileName`）にそのまま渡す（ChatGPT 用
// バンドルのファイル名だけに使う）。項目のない `START` は、指定に項目を入れない（名前の部分のない今の形）。
describe('audit worker session (PRE42-BN): the profile name for the bundle name', () => {
  it.each<[string, Record<string, unknown>, AuditRunOptions]>([
    ['given', { profileName: '管理画面' }, { startNew: true, profileName: '管理画面' }],
    ['absent', {}, { startNew: true }],
  ])('passes the profile name to the audit core when it is %s', async (_label, item, options) => {
    const harness = startHarness();
    harness.channel.emit({ ...START, ...item });
    await harness.runStarted;
    expect(onlyRunCall(harness).options).toEqual(options);
  });
});

describe('audit worker session: from READY to FINISHED', () => {
  it('sends READY, reads the configuration with the headless override only, runs the core, relays the observer and finishes', async () => {
    const harness = startHarness();
    expect(typesOf(harness.channel.sent)).toEqual(['READY']);

    harness.channel.emit(START);
    await harness.runStarted;
    const call = onlyRunCall(harness);
    expect(harness.loadConfigCalls).toEqual([[TARGET_CONFIG_PATH, { browser: { headed: false }, audit: { sendPolicy: 'READ_ONLY' } }]]);
    expect(WORKER_CONFIG_OVERRIDES).toEqual({ browser: { headed: false } });
    expect(Object.isFrozen(WORKER_CONFIG_OVERRIDES)).toBe(true);
    expect(call.options).toEqual({ startNew: true });
    expect(call.dependencies.stopSignal?.aborted).toBe(false);

    call.observer.onRunStarted?.({ runId: RUN_ID, runDirectory: RUN_DIRECTORY, resumeDecision: { kind: 'RESUME', runId: RUN_ID, runDirectory: RUN_DIRECTORY, completedPages: 2 } });
    call.observer.onProgress?.(PROGRESS);
    call.observer.onNotice?.({ kind: 'SITE_UNAVAILABLE_RECHECK', url: `http://127.0.0.1/${'p'.repeat(MAX_WORKER_NOTICE_URL_LENGTH)}`, delayMs: 30_000, attempt: 1, maxAttempts: 4 });
    call.observer.onNotice?.({ kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10_000 });
    harness.outcome.resolve(ranOutcome(EXIT_CODES.PARTIAL));

    expect(await harness.worker.exited).toBe(EXIT_CODES.PARTIAL);
    expect(harness.exits).toEqual([EXIT_CODES.PARTIAL]);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'RUN_STARTED', 'PROGRESS', 'NOTICE', 'NOTICE', 'FINISHED']);
    const [, runStarted, progress, recheck, slowdown, finished] = harness.channel.sent.filter(({ type }) => type !== 'HEARTBEAT');
    expect(runStarted).toEqual({
      protocol: WORKER_PROTOCOL_VERSION, type: 'RUN_STARTED', runId: RUN_ID, runDirectory: RUN_ID, resumeDecision: { kind: 'RESUME', completedPages: 2 },
    });
    expect(progress).toEqual({ protocol: WORKER_PROTOCOL_VERSION, type: 'PROGRESS', report: PROGRESS });
    expect(recheck?.type === 'NOTICE' && recheck.notice.kind === 'SITE_UNAVAILABLE_RECHECK' ? recheck.notice.url.length : 0)
      .toBe(MAX_WORKER_NOTICE_URL_LENGTH);
    expect(slowdown).toEqual({ protocol: WORKER_PROTOCOL_VERSION, type: 'NOTICE', notice: { kind: 'SITE_UNAVAILABLE_SLOWDOWN', minIntervalMs: 10_000 } });
    expect(finished).toEqual({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'FINISHED',
      outcome: { kind: 'RAN', exitCode: EXIT_CODES.PARTIAL, runId: RUN_ID, runDirectory: RUN_ID, runStatus: 'PARTIAL' },
    });
    // 送ったメッセージは、どれも契約の検証を通る。
    expect(harness.channel.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
    expect(harness.stderr).toEqual([]);
  });

  it.each([
    ['RUN_ACTIVE', { kind: 'RUN_ACTIVE', activeRunId: RUN_ID, exitCode: EXIT_CODES.RUN_UNAVAILABLE } as AuditRunOutcome,
      { kind: 'RUN_ACTIVE', exitCode: EXIT_CODES.RUN_UNAVAILABLE, runId: RUN_ID, runDirectory: null, runStatus: null }],
    // DEF-057 の開始のロック: 別の起動が開始の段にいて、実行中の Run の ID がまだ決まっていない。
    ['RUN_ACTIVE (the run id is not decided yet)', { kind: 'RUN_ACTIVE', activeRunId: null, exitCode: EXIT_CODES.RUN_UNAVAILABLE } as AuditRunOutcome,
      { kind: 'RUN_ACTIVE', exitCode: EXIT_CODES.RUN_UNAVAILABLE, runId: null, runDirectory: null, runStatus: null }],
    ['VERSION_MISMATCH', { kind: 'VERSION_MISMATCH', runId: RUN_ID, runDirectory: RUN_DIRECTORY, differences: [], exitCode: EXIT_CODES.RUN_UNAVAILABLE } as AuditRunOutcome,
      { kind: 'VERSION_MISMATCH', exitCode: EXIT_CODES.RUN_UNAVAILABLE, runId: RUN_ID, runDirectory: RUN_ID, runStatus: null }],
    ['RUN_DIRECTORY_UNAVAILABLE (without the cause)', {
      kind: 'RUN_DIRECTORY_UNAVAILABLE', runId: RUN_ID, runDirectory: RUN_DIRECTORY, runStatus: 'FAILED', alreadyExists: false,
      cause: new Error('EPERM secret'), exitCode: EXIT_CODES.FAILED, resumeDecision: { kind: 'NEW_RUN' }, notices: [],
    } as AuditRunOutcome,
    { kind: 'RUN_DIRECTORY_UNAVAILABLE', exitCode: EXIT_CODES.FAILED, runId: RUN_ID, runDirectory: RUN_ID, runStatus: 'FAILED' }],
    ['RESUME_UNAVAILABLE (without the cause)', {
      kind: 'RESUME_UNAVAILABLE', runId: RUN_ID, runDirectory: RUN_DIRECTORY, reason: 'LOCK_HELD_BY_ACTIVE_RUN', cause: new Error('secret'),
      exitCode: EXIT_CODES.RUN_UNAVAILABLE, resumeDecision: { kind: 'NEW_RUN' }, notices: [],
    } as AuditRunOutcome,
    { kind: 'RESUME_UNAVAILABLE', exitCode: EXIT_CODES.RUN_UNAVAILABLE, runId: RUN_ID, runDirectory: RUN_ID, runStatus: null }],
  ] as const)('sends only the fields for the screen for the outcome %s', async (_name, outcome, expected) => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    harness.outcome.resolve(outcome);

    expect(await harness.worker.exited).toBe(outcome.exitCode);
    const finished = harness.channel.sent.find(({ type }) => type === 'FINISHED');
    expect(finished).toEqual({ protocol: WORKER_PROTOCOL_VERSION, type: 'FINISHED', outcome: expected });
    expect(JSON.stringify(harness.channel.sent)).not.toContain('secret');
  });

  // DEF-143（設計書 `2026-10-20-beaksight-worker-heartbeat-heavy-steps-design.md` 4 章の判断）: 中核が「Run の終わり」の段に入ったら、親へ段の知らせ
  // （`RUN_FINALIZING`）を送る（親は、その段の間だけ途絶えの上限を延ばす）。
  it('relays the start of the finalizing stage of the core as RUN_FINALIZING, before FINISHED', async () => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    const call = onlyRunCall(harness);
    call.observer.onRunStarted?.({ runId: RUN_ID, runDirectory: RUN_DIRECTORY, resumeDecision: { kind: 'NEW_RUN' } });
    call.observer.onProgress?.(PROGRESS);
    call.observer.onFinalizing?.();
    harness.outcome.resolve(ranOutcome());

    expect(await harness.worker.exited).toBe(EXIT_CODES.COMPLETE);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'RUN_STARTED', 'PROGRESS', 'RUN_FINALIZING', 'FINISHED']);
    expect(harness.channel.sent.find(({ type }) => type === 'RUN_FINALIZING')).toEqual({ protocol: WORKER_PROTOCOL_VERSION, type: 'RUN_FINALIZING' });
    expect(harness.channel.sent.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
    expect(harness.stderr).toEqual([]);
  });

  it('sends heartbeats at the interval while it lives, and stops them after it exits', async () => {
    // DEF-149（TS-d）: 間隔と待つ時間を壁時計で待たず、偽のタイマー（注入した時計）で進める。混雑でタイマーが遅れると、待ちの終わりと合図の
    // タイマーが同じ回に並び、数える前に合図が 1 つしか出ていないことがあった。偽のタイマーでは、進めた時間の分だけ合図が出る。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const harness = startHarness();
      harness.channel.emit(START);
      await harness.runStarted;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_OBSERVATION_MS);
      const heartbeats = harness.channel.sent.filter(({ type }) => type === 'HEARTBEAT').length;
      expect(heartbeats).toBeGreaterThanOrEqual(2);
      harness.outcome.resolve(ranOutcome());
      await harness.worker.exited;
      const afterExit = harness.channel.sent.length;
      await vi.advanceTimersByTimeAsync(HEARTBEAT_OBSERVATION_MS);
      expect(harness.channel.sent).toHaveLength(afterExit);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('audit worker session: failures', () => {
  // T24h-1 の M3: 親の検証とワーカーの読み込みの間に設定が変わったら、監査を始めない。
  it.each([
    ['the configuration differs before it is read', [CHANGED_TARGET_CONFIG_BYTES], false],
    ['the configuration cannot be read', [new Error('ENOENT')], false],
    ['the configuration changes while it is read', [TARGET_CONFIG_BYTES, CHANGED_TARGET_CONFIG_BYTES], true],
  ] as const)('sends FAILED CONFIG_CHANGED and exits with the code of the configuration error when %s', async (_name, reads, readsConfig) => {
    const harness = startHarness({ targetConfigReads: reads });
    harness.channel.emit(START);

    expect(await harness.worker.exited).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FAILED']);
    expect(failedOf(harness)[0]?.reason).toBe('CONFIG_CHANGED');
    expect(harness.loadConfigCalls.length > 0).toBe(readsConfig);
    expect(harness.runCalls).toEqual([]);
    expect(targetConfigReadCalls.every((path) => path === TARGET_CONFIG_PATH)).toBe(true);
  });

  it('checks the configuration before and after reading it when it did not change', async () => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    expect(targetConfigReadCalls).toEqual([TARGET_CONFIG_PATH, TARGET_CONFIG_PATH]);
    harness.outcome.resolve(ranOutcome());
    expect(await harness.worker.exited).toBe(EXIT_CODES.COMPLETE);
  });

  it('sends FAILED CONFIG_ERROR and exits with the code of the configuration error', async () => {
    const harness = startHarness({ loadConfigError: new ConfigError('CONFIG_INVALID', 'invalid configuration: crawl\nmaxPages', ['crawl']) });
    harness.channel.emit(START);

    expect(await harness.worker.exited).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FAILED']);
    expect(failedOf(harness)).toEqual([{
      protocol: WORKER_PROTOCOL_VERSION, type: 'FAILED', reason: 'CONFIG_ERROR', detail: 'invalid configuration: crawl maxPages',
    }]);
    expect(harness.runCalls).toEqual([]);
  });

  it('sends FAILED UNEXPECTED_FAILURE with a short clean detail for an unexpected exception, and exits with 1', async () => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    harness.outcome.reject(new Error(`boom\r\n${'x'.repeat(MAX_WORKER_FAILURE_DETAIL_LENGTH * 2)}`));

    expect(await harness.worker.exited).toBe(FAILURE_EXIT_CODE);
    const [failed] = failedOf(harness);
    expect(failed?.reason).toBe('UNEXPECTED_FAILURE');
    expect(failed?.detail.startsWith('boom  x')).toBe(true);
    expect(failed?.detail).toHaveLength(MAX_WORKER_FAILURE_DETAIL_LENGTH);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FAILED']);
  });

  it('sends FAILED UNEXPECTED_FAILURE and exits with 1 on an unhandled failure', async () => {
    const harness = startHarness();
    harness.worker.failUnexpectedly(new Error('unhandled'));

    expect(await harness.worker.exited).toBe(FAILURE_EXIT_CODE);
    expect(failedOf(harness).map(({ reason, detail }) => [reason, detail])).toEqual([['UNEXPECTED_FAILURE', 'unhandled']]);
  });
});

describe('audit worker session: the trust boundary (fail-closed)', () => {
  it.each([
    ['a START with an unaccepted path', { ...START, targetConfigPath: '../outside.json' }],
    ['a START with an extra property', { ...START, overrides: { crawl: { minNavigationIntervalMs: 0 } } }],
    ['a START with a wrong protocol version', { ...START, protocol: 'beaksight-worker-message/0' }],
    ['a message of the worker', { protocol: WORKER_PROTOCOL_VERSION, type: 'READY' }],
    ['a string', 'START'],
  ] as const)('sends FAILED PROTOCOL_VIOLATION for %s before START, and exits with 1 without reading the configuration', async (_name, value) => {
    const harness = startHarness();
    harness.channel.emit(value);

    expect(await harness.worker.exited).toBe(FAILURE_EXIT_CODE);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FAILED']);
    expect(failedOf(harness)[0]?.reason).toBe('PROTOCOL_VIOLATION');
    expect(harness.loadConfigCalls).toEqual([]);
    expect(harness.runCalls).toEqual([]);
  });

  it('sends FAILED START_TIMEOUT and exits with 1 when START does not come in time', async () => {
    const harness = startHarness();

    expect(await harness.worker.exited).toBe(FAILURE_EXIT_CODE);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FAILED']);
    expect(failedOf(harness)[0]?.reason).toBe('START_TIMEOUT');
    expect(harness.loadConfigCalls).toEqual([]);
  });

  it.each([
    ['a second START', START],
    ['a STOP with a wrong field', { ...STOP, force: 'yes' }],
    ['an unknown message', { protocol: WORKER_PROTOCOL_VERSION, type: 'PAUSE' }],
  ] as const)('stops the Run on %s during the Run, ignores the parent after it, and does not send FINISHED', async (_name, value) => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    const call = onlyRunCall(harness);

    harness.channel.emit(value);
    expect(call.dependencies.stopSignal?.aborted).toBe(true);
    expect(failedOf(harness).map(({ reason }) => reason)).toEqual(['PROTOCOL_VIOLATION']);
    // 信用しない相手の後のメッセージ（強制の STOP も）は受けない。
    harness.channel.emit(FORCE_STOP);
    expect(harness.exits).toEqual([]);
    harness.outcome.resolve(ranOutcome(EXIT_CODES.PARTIAL));

    expect(await harness.worker.exited).toBe(EXIT_CODES.PARTIAL);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FAILED']);
    expect(harness.runCalls).toHaveLength(1);
  });

  it('does not send a message that it built in a wrong shape: it sends FAILED, stops the Run, and does not send FINISHED', async () => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    const call = onlyRunCall(harness);

    // 出力先の外の Run のディレクトリ（相対パスが `..` から始まる）。
    call.observer.onRunStarted?.({ runId: RUN_ID, runDirectory: resolve(OUTPUT_DIRECTORY, '..', RUN_ID), resumeDecision: { kind: 'NEW_RUN' } });
    call.observer.onProgress?.({ ...PROGRESS, pagesFinished: -1 });
    expect(call.dependencies.stopSignal?.aborted).toBe(true);
    harness.outcome.resolve(ranOutcome());

    expect(await harness.worker.exited).toBe(EXIT_CODES.COMPLETE);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FAILED']);
    expect(failedOf(harness)[0]?.reason).toBe('PROTOCOL_VIOLATION');
  });
});

describe('audit worker session: stopping', () => {
  it('sets the stop mark on STOP (like the first Ctrl+C of the CLI), and finishes the Run with its exit code', async () => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    const call = onlyRunCall(harness);

    harness.channel.emit(STOP);
    expect(call.dependencies.stopSignal?.aborted).toBe(true);
    expect(harness.exits).toEqual([]);
    expect(harness.stderr.join('')).toContain(CLI_TEXT.interrupt.stopRequested);
    harness.outcome.resolve(ranOutcome(EXIT_CODES.PARTIAL));

    expect(await harness.worker.exited).toBe(EXIT_CODES.PARTIAL);
    expect(typesOf(harness.channel.sent)).toEqual(['READY', 'FINISHED']);
  });

  it.each([
    ['a STOP with force', [FORCE_STOP]],
    ['a second STOP', [STOP, STOP]],
    ['a STOP after a Ctrl+C', ['ctrl-c', STOP]],
    ['a second Ctrl+C', ['ctrl-c', 'ctrl-c']],
  ] as const)('exits at once with the exit code 5 on %s, without FINISHED', async (_name, steps) => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    for (const step of steps) {
      if (step === 'ctrl-c') {
        harness.worker.interrupt();
      } else {
        harness.channel.emit(step);
      }
    }

    expect(await harness.worker.exited).toBe(INTERRUPTED_EXIT_CODE);
    expect(harness.stderr.join('')).toContain(CLI_TEXT.interrupt.exitingNow);
    harness.outcome.resolve(ranOutcome());
    await Promise.resolve();
    expect(harness.exits).toEqual([INTERRUPTED_EXIT_CODE]);
    expect(typesOf(harness.channel.sent)).toEqual(['READY']);
  });

  it('sets the stop mark when the parent disconnects during the Run, and exits with the exit code of the Run', async () => {
    const harness = startHarness();
    harness.channel.emit(START);
    await harness.runStarted;
    const call = onlyRunCall(harness);

    harness.channel.disconnect();
    expect(call.dependencies.stopSignal?.aborted).toBe(true);
    harness.outcome.resolve(ranOutcome(EXIT_CODES.PARTIAL));

    expect(await harness.worker.exited).toBe(EXIT_CODES.PARTIAL);
    expect(harness.exits).toEqual([EXIT_CODES.PARTIAL]);
  });

  it.each([
    ['STOP', (harness: Harness) => harness.channel.emit(STOP)],
    ['a Ctrl+C', (harness: Harness) => harness.worker.interrupt()],
    ['the disconnection of the parent', (harness: Harness) => harness.channel.disconnect()],
  ] as const)('exits with the exit code 5 without starting a Run on %s before START', async (_name, act) => {
    const harness = startHarness();
    act(harness);

    expect(await harness.worker.exited).toBe(INTERRUPTED_EXIT_CODE);
    harness.channel.emit(START);
    await Promise.resolve();
    expect(harness.loadConfigCalls).toEqual([]);
    expect(harness.runCalls).toEqual([]);
    expect(harness.exits).toEqual([INTERRUPTED_EXIT_CODE]);
  });
});
