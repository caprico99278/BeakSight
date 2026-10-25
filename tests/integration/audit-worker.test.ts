// T24d（Task 24 の設計書 4.2、4.3、7 章「ワーカーと IPC」）: 一時的なビルドのワーカー（`<一時ビルド>/dist/worker/audit-worker.js`）を、
// 画面のサーバと同じく `child_process.fork`（IPC つき、detached にしない）で起動し、127.0.0.1 の fixture のサイト（`/crawl/` の 5 ページ）を
// 監査させる。ワーカーは本番の依存（`PRODUCTION_RUN_DEPENDENCIES`。CLI と同じ Chromium の起動の設定）で動く。
// - `READY` → `START` → `RUN_STARTED` → `PROGRESS` → `FINISHED` の順と値、Run の成果物、終了コード。送られたメッセージは、どれも契約の検証を通る。
// - `STOP` で PARTIAL（`STOPPED_BY_SIGNAL`）、`force` の `STOP` で終了コード 5、親の切断で止まる、`START` が来ないと止まる、形の違う `START` で
//   `FAILED`、IPC がなければ何もせずに止まる。
// - ワーカーを止めた後に、ワーカーと、ワーカーの子孫（Chromium）のプロセスが残らない（ID と起動の時刻で見分ける）。
// - fixture のサーバに届いた要求が、GET と HEAD だけ。標準出力には何も書かない。
// 作業のディレクトリ（cwd）は一時のフォルダで、ターゲット JSON は、その中の `config/targets/` に置く（リポジトリの `config/`・`local/`・
// `artifacts/` を使わない）。
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE, exitCodeForRunStatus } from '../../src/cli/exit-codes.js';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_START_TIMEOUT_MS,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { descendantsOf, listProcesses, stillRunning, waitUntilExited, type ProcessIdentity } from '../helpers/process-tree.js';
import { cliTargetConfig, expectOnlyReadRequests, readJson } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';

/** ビルドと、ワーカーの数回の Run を含む、`beforeAll` と各テストの上限。 */
const SUITE_TIMEOUT_MS = 300_000;
/** ワーカーのプロセスが終わるまでの上限（これを過ぎたら、テストを失敗にして、後片付けで止める）。 */
const WORKER_PROCESS_LIMIT_MS = 120_000;
/** ワーカーが終わった後に、Chromium のプロセスが消えるのを待つ上限（ms。調査では 2 秒以内に消えた）。 */
const CHROMIUM_EXIT_LIMIT_MS = 15_000;
/** `START` が来ないときに、ワーカーが終わるまでの上限（名前つきの待ちの時間と、起動の時間の余裕）。 */
const START_TIMEOUT_EXIT_LIMIT_MS = WORKER_START_TIMEOUT_MS + 20_000;
const START_PATH = '/crawl/index.html';
/**
 * 止める場面のページの読み込みの最小の間隔（ms）。1 ページ目の `PROGRESS` を受けてから止める要求を送るまでに、2 ページ目の読み込みが
 * 始まらないようにするための値（止める要求は、IPC で数ミリ秒で届く）。
 */
const STOPPING_NAVIGATION_INTERVAL_MS = 3_000;
/**
 * 最後まで監査する場面のページの読み込みの最小の間隔（ms）。1 ページ目の `PROGRESS` の後に、プロセスの一覧を読む間（PowerShell の起動を
 * 含めて数秒）も、Chromium が動いているようにするための値。
 */
const FULL_RUN_NAVIGATION_INTERVAL_MS = 2_000;

let server: FixtureServer;
let build: TemporaryBuild;
let workDirectory: string;
/** 起動したワーカー（後片付けで、残っていれば止める）。 */
const workers: WorkerProcess[] = [];

/** 起動したワーカーと、受けたもの。 */
interface WorkerProcess {
  readonly child: ChildProcess;
  readonly messages: unknown[];
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** 終わり（終了コードとシグナル）。 */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  /** `predicate` を満たすメッセージを受けるまで待つ（受けた順の、最初のもの）。終わるか上限を過ぎたら reject する。 */
  waitForMessage(predicate: (message: WorkerToParentMessage) => boolean): Promise<WorkerToParentMessage>;
}

const isWorkerMessage = (value: unknown): value is WorkerToParentMessage => validateWorkerToParentMessage(value).ok;

function startWorker(options: { readonly ipc: boolean } = { ipc: true }): WorkerProcess {
  const entry = join(build.distDirectory, 'worker', 'audit-worker.js');
  const child = options.ipc
    ? fork(entry, [], { cwd: workDirectory, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' })
    : spawn(process.execPath, [entry], { cwd: workDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
  const messages: unknown[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const waiters: (() => void)[] = [];
  child.on('message', (message: unknown) => {
    messages.push(message);
    for (const waiter of waiters.splice(0)) {
      waiter();
    }
  });
  const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolvePromise) => {
    child.on('exit', (code, signal) => {
      resolvePromise({ code, signal });
      for (const waiter of waiters.splice(0)) {
        waiter();
      }
    });
  });
  const worker: WorkerProcess = {
    child,
    messages,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    waitForMessage: (predicate) =>
      new Promise((resolvePromise, rejectPromise) => {
        const deadline = setTimeout(() => rejectPromise(new Error(`no expected message within ${WORKER_PROCESS_LIMIT_MS} ms`)), WORKER_PROCESS_LIMIT_MS);
        const check = (): void => {
          const found = messages.find((message): message is WorkerToParentMessage => isWorkerMessage(message) && predicate(message));
          if (found !== undefined) {
            clearTimeout(deadline);
            resolvePromise(found);
            return;
          }
          if (child.exitCode !== null || child.signalCode !== null) {
            clearTimeout(deadline);
            rejectPromise(new Error(`the worker exited before the expected message: ${JSON.stringify(messages)} ${stderr}`));
            return;
          }
          waiters.push(check);
        };
        check();
      }),
  };
  workers.push(worker);
  return worker;
}

/** ワーカーの終わりを、上限まで待つ。 */
async function exitOf(worker: WorkerProcess, limitMs: number = WORKER_PROCESS_LIMIT_MS) {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<null>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(null), limitMs);
  });
  const result = await Promise.race([worker.exited, limit]);
  clearTimeout(timer);
  expect(result, `the worker did not exit within ${limitMs} ms: ${worker.stderr()}`).not.toBeNull();
  return result ?? { code: null, signal: null };
}

/** `name` の場面のターゲット JSON を、作業のディレクトリの `config/targets/` に書き、そのパス（cwd からの相対）と出力先を返す。 */
async function writeTarget(name: string, crawl: Record<string, unknown>): Promise<{ readonly targetConfigPath: string; readonly outputDirectory: string }> {
  const outputDirectory = join(workDirectory, `${name}-output`);
  const config = cliTargetConfig(name, server.origin, START_PATH, {
    crawl,
    audit: { screenshots: false },
    output: { directory: outputDirectory },
  });
  await writeFile(join(workDirectory, 'config', 'targets', `${name}.json`), JSON.stringify(config), 'utf8');
  return { targetConfigPath: `config/targets/${name}.json`, outputDirectory };
}

/** 作業のディレクトリの中のターゲット JSON の SHA-256（親が開始の直前に求める値。T24h-1 の M3）。読めなければ、形だけ正しい値。 */
const digestOfTarget = (targetConfigPath: string): string => {
  const path = join(workDirectory, targetConfigPath);
  return targetConfigDigestOf(existsSync(path) ? readFileSync(path) : new Uint8Array());
};

const startMessage = (targetConfigPath: string, extra: Record<string, unknown> = {}) => ({
  protocol: WORKER_PROTOCOL_VERSION, type: 'START', jobId: 'job-1', jobKind: 'AUDIT', targetConfigPath, startNew: true,
  targetConfigSha256: digestOfTarget(targetConfigPath), ...extra,
});

/** HEARTBEAT を除いた、受けたメッセージの種類の並び。 */
const typesOf = (worker: WorkerProcess): string[] =>
  worker.messages.map((message) => (isWorkerMessage(message) ? message.type : 'INVALID')).filter((type) => type !== 'HEARTBEAT');

/** ワーカーの子孫（Chromium）。Chromium が動いている間に読む。 */
async function chromiumOf(worker: WorkerProcess): Promise<readonly ProcessIdentity[]> {
  const descendants = descendantsOf(worker.child.pid ?? 0, await listProcesses());
  expect(descendants.length, 'the worker has no child process (Chromium) while it audits').toBeGreaterThan(0);
  return descendants;
}

/** ワーカーが終わり、その子孫（Chromium）も残っていない。 */
async function expectNoProcessLeft(worker: WorkerProcess, descendants: readonly ProcessIdentity[]): Promise<void> {
  expect(worker.child.exitCode !== null || worker.child.signalCode !== null).toBe(true);
  expect(await waitUntilExited(descendants, CHROMIUM_EXIT_LIMIT_MS), 'processes left after the worker exited').toEqual([]);
}

const readRun = async (runDirectory: string): Promise<RunSummary> =>
  await readJson(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.run)) as RunSummary;

describe('audit worker in a child process (Task 24 design 4.2, 4.3)', () => {
  beforeAll(async () => {
    server = await startFixtureServer();
    build = await buildIntoTemporaryDirectory();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-worker-'));
    await mkdir(join(workDirectory, 'config', 'targets'), { recursive: true });
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    // 終わっていないワーカーを、子孫ごと止める（テストが失敗した場合の後片付け。このテストが起動して、まだ終わりを受けていないものだけ）。
    const leftovers = workers.filter(({ child }) => child.exitCode === null && child.signalCode === null);
    for (const { child } of leftovers) {
      const leftDescendants = descendantsOf(child.pid ?? 0, await listProcesses());
      child.kill();
      for (const descendant of await stillRunning(leftDescendants)) {
        try {
          process.kill(descendant.processId);
        } catch {
          // すでに終わった。
        }
      }
    }
    await build?.remove();
    await server?.close();
    if (workDirectory !== undefined) {
      await rm(workDirectory, { recursive: true, force: true });
    }
    expect(leftovers.length, 'worker processes left running after the tests').toBe(0);
  }, SUITE_TIMEOUT_MS);

  it('runs READY -> START -> RUN_STARTED -> PROGRESS -> FINISHED, writes the Run and exits with its exit code', async () => {
    server.resetCounters();
    server.resetRequestObservations();
    const { targetConfigPath, outputDirectory } = await writeTarget('worker-full', { minNavigationIntervalMs: FULL_RUN_NAVIGATION_INTERVAL_MS });
    const worker = startWorker();
    await worker.waitForMessage(({ type }) => type === 'READY');
    worker.child.send(startMessage(targetConfigPath));
    await worker.waitForMessage(({ type }) => type === 'PROGRESS');
    const chromium = await chromiumOf(worker);
    const finished = await worker.waitForMessage(({ type }) => type === 'FINISHED');
    const exit = await exitOf(worker);

    // 順と値。
    const types = typesOf(worker);
    expect(types[0]).toBe('READY');
    expect(types[1]).toBe('RUN_STARTED');
    expect(types.at(-1)).toBe('FINISHED');
    // DEF-143: 「Run の終わり」の段に入る知らせ（`RUN_FINALIZING`）は、`FINISHED` の直前に 1 回。
    expect(types.at(-2)).toBe('RUN_FINALIZING');
    expect(types.slice(2, -2).every((type) => type === 'PROGRESS' || type === 'NOTICE')).toBe(true);
    expect(types.filter((type) => type === 'PROGRESS').length).toBeGreaterThan(0);
    expect(types).not.toContain('INVALID');
    expect(worker.messages.every((message) => validateWorkerToParentMessage(message).ok)).toBe(true);
    const runStarted = worker.messages.find((message) => isWorkerMessage(message) && message.type === 'RUN_STARTED') as Extract<WorkerToParentMessage, { readonly type: 'RUN_STARTED' }>;
    expect(runStarted.resumeDecision).toEqual({ kind: 'NEW_RUN', completedPages: null });
    if (finished.type !== 'FINISHED') {
      throw new Error('not FINISHED');
    }
    expect(finished.outcome.kind).toBe('RAN');
    expect(finished.outcome.runId).toBe(runStarted.runId);
    expect(finished.outcome.runDirectory).toBe(runStarted.runDirectory);

    // 成果物と終了コード。
    const runDirectory = join(outputDirectory, finished.outcome.runDirectory ?? '');
    const run = await readRun(runDirectory);
    expect(await validateArtifact('run', run)).toEqual({ ok: true });
    expect(run.runId).toBe(finished.outcome.runId);
    expect(run.runStatus).toBe(finished.outcome.runStatus);
    expect(existsSync(artifactFilePath(runDirectory, RUN_ARTIFACT_FILE_NAMES.report))).toBe(true);
    expect(exit).toEqual({ code: finished.outcome.exitCode, signal: null });
    expect(finished.outcome.exitCode).toBe(exitCodeForRunStatus(run.runStatus));
    const lastProgress = [...worker.messages].reverse().find((message) => isWorkerMessage(message) && message.type === 'PROGRESS');
    const pagesFinished = lastProgress !== undefined && isWorkerMessage(lastProgress) && lastProgress.type === 'PROGRESS' ? lastProgress.report.pagesFinished : -1;
    expect(pagesFinished).toBeGreaterThan(0);
    expect(pagesFinished).toBeLessThanOrEqual(run.discoveredPageCount);
    expect(run.safety.invariantViolationCount).toBe(0);

    // 標準出力に何も書かない。プロセスが残らない。サーバに届いた要求は GET と HEAD だけ。
    expect(worker.stdout()).toBe('');
    await expectNoProcessLeft(worker, chromium);
    expectOnlyReadRequests(server.getCounters(), server.getRequestObservations());
  }, SUITE_TIMEOUT_MS);

  it('stops with STOP like the first Ctrl+C: PARTIAL with STOPPED_BY_SIGNAL, FINISHED and the exit code of PARTIAL', async () => {
    const { targetConfigPath, outputDirectory } = await writeTarget('worker-stop', { minNavigationIntervalMs: STOPPING_NAVIGATION_INTERVAL_MS });
    const worker = startWorker();
    await worker.waitForMessage(({ type }) => type === 'READY');
    worker.child.send(startMessage(targetConfigPath));
    await worker.waitForMessage(({ type }) => type === 'PROGRESS');
    const chromium = await chromiumOf(worker);
    worker.child.send({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: false });
    const finished = await worker.waitForMessage(({ type }) => type === 'FINISHED');
    const exit = await exitOf(worker);

    if (finished.type !== 'FINISHED') {
      throw new Error('not FINISHED');
    }
    expect(finished.outcome).toMatchObject({ kind: 'RAN', runStatus: 'PARTIAL', exitCode: EXIT_CODES.PARTIAL });
    expect(exit).toEqual({ code: EXIT_CODES.PARTIAL, signal: null });
    const run = await readRun(join(outputDirectory, finished.outcome.runDirectory ?? ''));
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL']);
    expect(worker.stdout()).toBe('');
    await expectNoProcessLeft(worker, chromium);
  }, SUITE_TIMEOUT_MS);

  it('exits at once with the exit code 5 on a STOP with force, without FINISHED', async () => {
    const { targetConfigPath } = await writeTarget('worker-force', { minNavigationIntervalMs: STOPPING_NAVIGATION_INTERVAL_MS });
    const worker = startWorker();
    await worker.waitForMessage(({ type }) => type === 'READY');
    worker.child.send(startMessage(targetConfigPath));
    await worker.waitForMessage(({ type }) => type === 'PROGRESS');
    const chromium = await chromiumOf(worker);
    worker.child.send({ protocol: WORKER_PROTOCOL_VERSION, type: 'STOP', force: true });
    const exit = await exitOf(worker);

    expect(exit).toEqual({ code: INTERRUPTED_EXIT_CODE, signal: null });
    expect(typesOf(worker)).not.toContain('FINISHED');
    expect(worker.stdout()).toBe('');
    await expectNoProcessLeft(worker, chromium);
  }, SUITE_TIMEOUT_MS);

  it('stops the Run when the parent disconnects, and exits with the exit code of the Run (PARTIAL)', async () => {
    const { targetConfigPath, outputDirectory } = await writeTarget('worker-disconnect', { minNavigationIntervalMs: STOPPING_NAVIGATION_INTERVAL_MS });
    const worker = startWorker();
    await worker.waitForMessage(({ type }) => type === 'READY');
    worker.child.send(startMessage(targetConfigPath));
    const runStarted = await worker.waitForMessage(({ type }) => type === 'RUN_STARTED');
    await worker.waitForMessage(({ type }) => type === 'PROGRESS');
    const chromium = await chromiumOf(worker);
    worker.child.disconnect();
    const exit = await exitOf(worker);

    expect(exit).toEqual({ code: EXIT_CODES.PARTIAL, signal: null });
    if (runStarted.type !== 'RUN_STARTED') {
      throw new Error('not RUN_STARTED');
    }
    const run = await readRun(join(outputDirectory, runStarted.runDirectory));
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.executions.map(({ endReason }) => endReason)).toEqual(['STOPPED_BY_SIGNAL']);
    await expectNoProcessLeft(worker, chromium);
  }, SUITE_TIMEOUT_MS);

  it('sends FAILED PROTOCOL_VIOLATION for a START in a wrong shape, and exits with 1 without auditing', async () => {
    server.resetCounters();
    const { targetConfigPath, outputDirectory } = await writeTarget('worker-malformed', { minNavigationIntervalMs: 0 });
    const worker = startWorker();
    await worker.waitForMessage(({ type }) => type === 'READY');
    // 画面から変えられない上書き（間隔）を付けた START。
    worker.child.send(startMessage(targetConfigPath, { overrides: { crawl: { minNavigationIntervalMs: 0 } } }));
    const failed = await worker.waitForMessage(({ type }) => type === 'FAILED');
    const exit = await exitOf(worker);

    expect(failed).toMatchObject({ type: 'FAILED', reason: 'PROTOCOL_VIOLATION' });
    expect(exit).toEqual({ code: FAILURE_EXIT_CODE, signal: null });
    expect(typesOf(worker)).toEqual(['READY', 'FAILED']);
    expect(existsSync(outputDirectory)).toBe(false);
    expect(server.getCounters().get).toBe(0);
  }, SUITE_TIMEOUT_MS);

  // T24h-1 の M3: 親が検証した後にターゲット JSON が変わったら（SHA-256 が違えば）、監査を始めない。
  it('sends FAILED CONFIG_CHANGED and exits with the code of the configuration error when the target configuration changed', async () => {
    server.resetCounters();
    const { targetConfigPath, outputDirectory } = await writeTarget('worker-config-changed', { minNavigationIntervalMs: 0 });
    const checkedDigest = digestOfTarget(targetConfigPath);
    // 親が検証した後に、間隔を変えた（同じ形で、内容だけが違う）。
    await writeTarget('worker-config-changed', { minNavigationIntervalMs: 1 });
    const worker = startWorker();
    await worker.waitForMessage(({ type }) => type === 'READY');
    worker.child.send(startMessage(targetConfigPath, { targetConfigSha256: checkedDigest }));
    const failed = await worker.waitForMessage(({ type }) => type === 'FAILED');
    const exit = await exitOf(worker);

    expect(failed).toMatchObject({ type: 'FAILED', reason: 'CONFIG_CHANGED' });
    expect(exit).toEqual({ code: EXIT_CODES.CONFIG_ERROR, signal: null });
    expect(typesOf(worker)).toEqual(['READY', 'FAILED']);
    expect(existsSync(outputDirectory)).toBe(false);
    expect(server.getCounters().get).toBe(0);
  }, SUITE_TIMEOUT_MS);

  it('sends FAILED PROTOCOL_VIOLATION for a target path that is not accepted, without reading it', async () => {
    const worker = startWorker();
    await worker.waitForMessage(({ type }) => type === 'READY');
    worker.child.send(startMessage('config/targets/../../outside.json'));
    const failed = await worker.waitForMessage(({ type }) => type === 'FAILED');
    const exit = await exitOf(worker);

    expect(failed).toMatchObject({ type: 'FAILED', reason: 'PROTOCOL_VIOLATION' });
    expect(exit).toEqual({ code: FAILURE_EXIT_CODE, signal: null });
  }, SUITE_TIMEOUT_MS);

  it('sends FAILED START_TIMEOUT and exits with 1 when START does not come', async () => {
    const worker = startWorker();
    const failed = await worker.waitForMessage(({ type }) => type === 'FAILED');
    const exit = await exitOf(worker, START_TIMEOUT_EXIT_LIMIT_MS);

    expect(failed).toMatchObject({ type: 'FAILED', reason: 'START_TIMEOUT' });
    expect(exit).toEqual({ code: FAILURE_EXIT_CODE, signal: null });
    expect(typesOf(worker)).toEqual(['READY', 'FAILED']);
  }, SUITE_TIMEOUT_MS);

  it('does nothing and exits with a non-zero code without IPC', async () => {
    const worker = startWorker({ ipc: false });
    const exit = await exitOf(worker);

    expect(exit.code).toBe(FAILURE_EXIT_CODE);
    expect(worker.stdout()).toBe('');
    expect(worker.messages).toEqual([]);
    // 出力先も作らない（作業のディレクトリには、ターゲット JSON と、前の場面の出力先だけがある）。
    expect((await readdir(workDirectory)).filter((name) => !name.endsWith('-output'))).toEqual(['config']);
  }, SUITE_TIMEOUT_MS);
});
