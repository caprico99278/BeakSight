// T24d（Task 24 の設計書 4.2、4.3、7 章「ワーカーと IPC」）: 一時的なビルドのワーカーを、画面のサーバと同じく `child_process.fork`（IPC つき、detached に
// しない）で起動し、127.0.0.1 の fixture のサイト（`/crawl/` の 5 ページ）を監査させる。ワーカーは本番の依存（`PRODUCTION_RUN_DEPENDENCIES`）で動き、
// Browser の起動だけを、テストだけの外へ出ない引数を足した CLI の起動の設定にする（DEF-277。入口は `tests/helpers/test-audit-worker-entry.ts`）。
// - 親の切断で止まる、`START` が来ないと止まる、形の違う `START`・受けないパス・変わった設定で `FAILED`、IPC がなければ何もせずに止まる。
//   （SLIM-GROUP: 最後までの Run・`STOP`・`force` の `STOP` は、ジョブの管理から同じワーカーを動かす `control-audit-jobs-worker.test.ts`。）
// - ワーカーを止めた後に、ワーカーと、ワーカーの子孫（Chromium）のプロセスが残らない（ID と起動の時刻で見分ける）。
// 作業のディレクトリ（cwd）は一時のフォルダで、ターゲット JSON は、その中の `config/targets/` に置く（リポジトリの `config/`・`local/`・
// `artifacts/` を使わない）。
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../../fixtures/server.js';
import { EXIT_CODES, FAILURE_EXIT_CODE } from '../../src/cli/exit-codes.js';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_START_TIMEOUT_MS,
  targetConfigDigestOf,
  validateWorkerToParentMessage,
  type WorkerToParentMessage,
} from '../../src/control/worker-protocol.js';
import { RUN_ARTIFACT_FILE_NAMES, artifactFilePath } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { descendantsOf, listProcesses, stillRunning, waitUntilExited, type ProcessIdentity } from '../helpers/process-tree.js';
import { cliTargetConfig, readJson } from '../helpers/run-harness.js';
import { useSharedTemporaryBuild } from '../helpers/shared-temporary-build.js';
import type { TemporaryBuild } from '../helpers/temporary-build.js';
import { installTestAuditWorkerEntry } from '../helpers/test-audit-worker-entry.js';

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

let server: FixtureServer;
let build: TemporaryBuild;
/** テストだけの入口（一時のビルドの root）。 */
let entry: string;
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
    build = await useSharedTemporaryBuild();
    entry = installTestAuditWorkerEntry(build);
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

  // SLIM-GROUP: 前の FINISHED・STOP・force の 3 場面は外した（同じ本物のワーカーと /crawl/ を、ジョブの管理から `control-audit-jobs-worker.test.ts` が
  // 確かめる。IPC の形と順は `tests/unit/worker-protocol*.test.ts`）。ここはジョブの管理を通さない IPC の場面と、親の切断だけ。
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
