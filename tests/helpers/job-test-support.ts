// ジョブの管理（`src/control/job/audit-job-manager.ts`）の結合のテストの補助（CCX-18。CC-072）。テストのファイルごとにあった、ジョブの管理の
// 時間の設定、ジョブの状態を待つ関数、起動したワーカーの終わりを待って確かめる関数を、ここに 1 つにした。
// - `CONTROL_JOB_TEST_TIMING`: 偽のワーカーを使うテストの時間の設定（見張りと読み直しを短くする。ファイルごとの違いは写しで上書きする）。
// - `waitForJob`: ジョブの見え方を読み直し（ジョブの管理か、管理データの読み取り）、条件を満たすまで待つ（上限を過ぎたら、最後に読んだ見え方を
//   文に入れて投げる）。
// - `expectWorkersExited`: 起動したワーカーがすべて終わるまで待ち（上限まで）、どれも動いていないことを確かめる。
// - `awaitWorkersExit`: 各テストの後に、起動したワーカーの一覧を空にし、`exit` の事象を待ってから、どれも動いていないことを確かめる。
// - PRE42-CC 組 6b（CC-072 の残り）: 偽のワーカーに埋め込む値の共通の組（`fakeWorkerValuesOf`・`FAKE_WORKER_EXIT_CODES`）、偽のワーカーで
//   ジョブの管理を作る関数（`createFakeWorkerJobManager`）、文脈の出力先を上書きする resolver（`withOutputDirectory`）。
// ワーカーを起動する関数（起動の回数と子の記録）は `worker-fork.ts`。
import type { ChildProcess } from 'node:child_process';
import { expect } from 'vitest';
import { wait as pause } from '../../src/core/deadline.js';
import { EXIT_CODES, FAILURE_EXIT_CODE, INTERRUPTED_EXIT_CODE } from '../../src/cli/exit-codes.js';
import {
  createAuditJobManager,
  type AuditJobManager,
  type AuditJobManagerOptions,
  type AuditJobTiming,
} from '../../src/control/job/audit-job-manager.js';
import { AUDIT_JOB_IPC_DRAIN_WAIT_MS } from '../../src/control/job/job-records.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { WORKER_PROTOCOL_VERSION } from '../../src/control/worker-protocol.js';
import { isProcessRunning } from '../../src/core/process-lock.js';
import type { FakeWorker, FakeWorkerValues } from './fake-audit-worker.js';

/** 偽のワーカーを使うジョブの管理のテストの時間の設定（ms）。 */
export const CONTROL_JOB_TEST_TIMING: AuditJobTiming = Object.freeze({
  readyTimeoutMs: 3_000,
  heartbeatTimeoutMs: 1_500,
  // DEF-143: 「Run の終わり」の段の知らせの後の上限（ふだんの上限より十分に長い）と、見張りの回の遅れの上限（ふだんの上限の半分）。
  finalizingHeartbeatTimeoutMs: 15_000,
  watchdogIntervalMs: 100,
  watchdogLagLimitMs: 750,
  progressWriteIntervalMs: 200,
  forceStopKillAfterMs: 1_000,
  exitWaitMs: 2_000,
  ipcDrainWaitMs: AUDIT_JOB_IPC_DRAIN_WAIT_MS,
  instanceHeartbeatIntervalMs: 1_000,
  unownedWorkerStaleAfterMs: 1_500,
  lockLostKillAfterMs: 1_000,
});

/** 偽のワーカーの合図の間隔（ms。見張りの時間より十分に短い）。 */
export const FAKE_WORKER_HEARTBEAT_INTERVAL_MS = 100;

/** 偽のワーカーの終了コード（CLI の終了コードの表の値。ログインの段の失敗は `FAILURE_EXIT_CODE`）。 */
export const FAKE_WORKER_EXIT_CODES: FakeWorkerValues['exitCodes'] = Object.freeze({
  complete: EXIT_CODES.COMPLETE,
  partial: EXIT_CODES.PARTIAL,
  interrupted: INTERRUPTED_EXIT_CODE,
  configError: EXIT_CODES.CONFIG_ERROR,
  failure: FAILURE_EXIT_CODE,
});

/** 偽のワーカーの Run の ID（このジョブの Run と、形は正しいが別の Run）。テストのファイルごとの値。 */
export interface FakeWorkerRunIds {
  readonly runId: string;
  readonly otherRunId: string;
}

/**
 * 偽のワーカーに埋め込む値（契約の版は `src/` の値、合図の間隔は `FAKE_WORKER_HEARTBEAT_INTERVAL_MS`、終了コードは `FAKE_WORKER_EXIT_CODES`）。
 * 動きごとの値と、違う合図の間隔は `extra` で足す・上書きする。
 */
export const fakeWorkerValuesOf = (runIds: FakeWorkerRunIds, extra: Partial<FakeWorkerValues> = {}): FakeWorkerValues => ({
  protocolVersion: WORKER_PROTOCOL_VERSION,
  runId: runIds.runId,
  otherRunId: runIds.otherRunId,
  heartbeatIntervalMs: FAKE_WORKER_HEARTBEAT_INTERVAL_MS,
  exitCodes: FAKE_WORKER_EXIT_CODES,
  ...extra,
});

/** 偽のワーカーでジョブの管理を作る設定（リポジトリの root はテストの作業のフォルダ、ワーカーの入口は偽のワーカー）。 */
export interface FakeWorkerJobManagerOptions extends Omit<AuditJobManagerOptions, 'repositoryRoot' | 'workerPath'> {
  readonly workDirectory: string;
  readonly worker: Pick<FakeWorker, 'path'>;
}

/** 偽のワーカーでジョブの管理を作る（時間は `CONTROL_JOB_TEST_TIMING` に `timing` を重ねる）。 */
export const createFakeWorkerJobManager = ({ workDirectory, worker, timing, ...options }: FakeWorkerJobManagerOptions): AuditJobManager =>
  createAuditJobManager({
    ...options,
    repositoryRoot: workDirectory,
    workerPath: worker.path,
    timing: { ...CONTROL_JOB_TEST_TIMING, ...timing },
  });

/** 文脈を解決する関数（テストの resolver の形）。 */
type ContextResolver = (targetConfigPath: string) => ProfileValidationContext | undefined;

/** `resolve` の文脈のターゲット設定の出力先を `directory` に替える resolver（解決できないパスは、そのまま解決できない）。 */
export const withOutputDirectory = (resolve: ContextResolver, directory: string): ContextResolver => (targetConfigPath) => {
  const context = resolve(targetConfigPath);
  return context === undefined ? undefined : { targetConfig: { ...context.targetConfig, output: { directory } } };
};

/** 状態が変わるのを待つ上限と、読み直す間隔（ms。既定）。 */
export const JOB_WAIT_LIMIT_MS = 15_000;
export const JOB_WAIT_POLL_MS = 25;

/** 待つ上限と読み直す間隔（省略は既定）。 */
export interface JobWaitOptions {
  readonly limitMs?: number;
  readonly pollMs?: number;
}

/** 子の process が終わったと Node が知っているか（`exit` の事象が届いた）。 */
const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/** ジョブの見え方を読む口（`AuditJobManager` はこの形。管理データから読むテストは、この形の値を作る）。 */
export interface JobViewSource {
  getAuditJob(jobId: string): AuditJobView | null;
}

/**
 * ジョブ `jobId` の見え方を `source` から読み直し、`predicate` を満たすまで待つ。上限（既定 `JOB_WAIT_LIMIT_MS`）を過ぎたら、最後に読んだ見え方を
 * 文に入れて投げる。
 */
export async function waitForJob(
  source: JobViewSource,
  jobId: string,
  predicate: (job: AuditJobView) => boolean,
  options: JobWaitOptions = {},
): Promise<AuditJobView> {
  const deadline = Date.now() + (options.limitMs ?? JOB_WAIT_LIMIT_MS);
  for (;;) {
    const job = source.getAuditJob(jobId);
    if (job !== null && predicate(job)) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`the job did not reach the expected state: ${JSON.stringify(job)}`);
    }
    await pause(options.pollMs ?? JOB_WAIT_POLL_MS);
  }
}

/** ジョブが終わった（終わりの時刻がある）。 */
export const isJobEnded = (job: AuditJobView): boolean => job.finishedAt !== null;

/**
 * 起動したワーカーが、すべて終わるまで待ち（上限まで）、どれも動いていないことを確かめる。`requireExitEvent` が真なら、Node が `exit` の事象を
 * 受けていること（終わりのコードかシグナルがあること）も確かめる。
 */
export async function expectWorkersExited(
  children: readonly ChildProcess[],
  options: JobWaitOptions & { readonly requireExitEvent?: boolean } = {},
): Promise<void> {
  const deadline = Date.now() + (options.limitMs ?? JOB_WAIT_LIMIT_MS);
  while (children.some((child) => !hasExited(child)) && Date.now() < deadline) {
    await pause(options.pollMs ?? JOB_WAIT_POLL_MS);
  }
  for (const child of children) {
    if (options.requireExitEvent === true) {
      expect(hasExited(child), `worker ${String(child.pid)} still runs`).toBe(true);
    }
    expect(isProcessRunning(child.pid ?? 0)).toBe(false);
  }
}

/** 各テストの後: 起動したワーカーの一覧を空にし、`exit` の事象を待ってから、どれも動いていないことを確かめる。 */
export async function awaitWorkersExit(children: ChildProcess[]): Promise<void> {
  const exited = children.splice(0);
  await Promise.all(exited.map((child) => (hasExited(child)
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())))));
  for (const child of exited) {
    expect(isProcessRunning(child.pid ?? 0)).toBe(false);
  }
}
