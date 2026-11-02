// DEF-180（OP-DEF）: 作業（ジョブ）の境目で、読み込みの間隔（`crawl.minNavigationIntervalMs`）が守られること。まとめて実行の段の間は、ワーカーの中で pacer を
// 持ち越す（`RunStageCarry`。`stage-chain-fork-cases.ts`）。ここでは、ワーカーが替わる境目を、ジョブの管理から本物の子 process（一時のビルド）と本物の
// Chromium で確かめる。間隔は、サーバに届いた時刻（サーバの記録）で測る。Run の Browser は、テストの既定の Chromium と CLI の起動の設定の両方。
// - 単独の作業どうし: 点検のジョブが終わった直後に、次の点検のジョブを始める。
// - 下調べと、その後に続けて始める点検（OP-1 の `thenStartAudit`。ジョブの管理が始める）。
// 作業のディレクトリ、管理データ、出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobContextResolver, type AuditJobManager } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { wait as sleep } from '../../src/core/deadline.js';
import { READ_METHODS, nonReadRequestsOf } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE } from '../helpers/test-chromium-args.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';
import { createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 600_000;
const TEST_TIMEOUT_MS = 300_000;
const WAIT_LIMIT_MS = 240_000;
const WAIT_POLL_MS = 50;
/** 境目を確かめる読み込みの最小の間隔（ms。ワーカーと Chromium の起動の時間より長く）。 */
const BOUNDARY_INTERVAL_MS = 6_000;
/** 1 つの点検で読むページの上限（短くするため小さく）。 */
const MAX_PAGES = 2;
/** ログインを待つ時間（ms。公開の画面だけのプロファイルはログインしない）。 */
const LOGIN_TIMEOUT_MS = 30_000;
const START_PATH = '/p/0';
const PAGE_COUNT = 3;

/** Run の Browser の起動（テストだけの入口の値。`undefined` は本番の起動）。 */
const RUN_BROWSERS = [
  ['the default test Chromium', `() => ${TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE}`],
  ['the CLI launch settings', 'undefined'],
] as const;

const entrySourceOf = (runBrowser: string): string => testLoginWorkerEntrySource({
  distPrefix: './dist/',
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  prelude: `const launchRunBrowser = ${runBrowser};\n`,
  credentialsExpression: null,
  additionalHooks: '\n  ...(launchRunBrowser === undefined ? {} : { launchRunBrowser }),',
});

/** サーバに届いた要求（method、path、届いた時刻）。 */
interface ArrivedRequest {
  readonly method: string;
  readonly path: string;
  readonly at: number;
}

interface Workspace {
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly server: LoopbackHttpServer;
  readonly requests: ArrivedRequest[];
  /** ワーカーの process が終わった時刻（起動の順）。 */
  readonly workerExits: number[];
  manager: AuditJobManager | undefined;
}

let build: TemporaryBuild;
const children: ChildProcess[] = [];
let workspace: Workspace | undefined;

beforeAll(async () => {
  build = await buildIntoTemporaryDirectory();
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = children.filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of leftovers) {
    child.kill();
  }
  await build?.remove();
  expect(leftovers.length, 'workers left running after the tests').toBe(0);
}, SUITE_TIMEOUT_MS);

afterEach(async () => {
  if (workspace === undefined) {
    return;
  }
  await workspace.manager?.close();
  await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())))));
  closeControlDatabase(workspace.database);
  await workspace.server.close();
  await rm(workspace.directory, { recursive: true, force: true });
  workspace = undefined;
}, SUITE_TIMEOUT_MS);

/** 公開の画面（`/p/<n>`。次のページへのリンクつき）。ほかの path は 404。届いた要求を時刻つきで記録する。 */
const pageListener = (requests: ArrivedRequest[]) => (request: IncomingMessage, response: ServerResponse): void => {
  const at = Date.now();
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  requests.push({ method: request.method ?? '', path: `${url.pathname}${url.search}`, at });
  const match = /^\/p\/(\d+)$/u.exec(url.pathname);
  if (match === null || !READ_METHODS.has(request.method ?? '')) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('');
    return;
  }
  const index = Number(match[1]);
  const links = Array.from({ length: PAGE_COUNT }, (_value, page) => (page === index ? '' : `<li><a href="/p/${page}">ページ ${page}</a></li>`)).join('');
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>ページ ${index}</title></head>`
    + `<body><main><h1>ページ ${index}</h1><ul>${links}</ul></main></body></html>`);
};

async function prepare(runBrowser: string, profileId: string): Promise<AuditJobManager> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-job-boundary-'));
  const requests: ArrivedRequest[] = [];
  workspace = {
    directory,
    database: openControlDatabase(resolveControlDatabasePath(directory)),
    server: await startLoopbackHttpServer(pageListener(requests)),
    requests,
    workerExits: [],
    manager: undefined,
  };
  const space = workspace;
  await mkdir(join(directory, 'config', 'targets'), { recursive: true });
  const targetConfigPath = `config/targets/${profileId}.json`;
  await writeFile(join(directory, targetConfigPath), JSON.stringify(cliTargetConfig(profileId, space.server.origin, START_PATH, {
    crawl: { minNavigationIntervalMs: BOUNDARY_INTERVAL_MS, maxPages: MAX_PAGES },
    audit: { screenshots: false },
    output: { directory: join(directory, `${profileId}-output`) },
  })), 'utf8');
  const resolveContext: AuditJobContextResolver = async (path) => ({ targetConfig: await loadConfig(join(directory, path)) });
  const context = await resolveContext(targetConfigPath);
  expect(createProfile(space.database, {
    schemaVersion: 'beaksight-profile/1',
    profileId,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath,
    environment: 'PUBLIC',
    mode: 'PUBLIC_PASSIVE',
    auth: 'NONE',
    approvedTestOrigins: [],
    environmentEvidenceRef: null,
  }, { resolveContext: () => context }).ok).toBe(true);
  hideJobBrowser(space.database, profileId);
  const entry = join(build.rootDirectory, `${Date.now()}-${profileId}-boundary-worker-test-entry.mjs`);
  await writeFile(entry, entrySourceOf(runBrowser), 'utf8');
  space.manager = createAuditJobManager({
    database: space.database,
    repositoryRoot: directory,
    workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
    resolveContext,
    forkWorker: createRecordingFork({
      entry,
      onChild: (child) => {
        children.push(child);
        child.once('exit', () => space.workerExits.push(Date.now()));
      },
    }),
  });
  return space.manager;
}

async function waitForJobEnd(manager: AuditJobManager, jobId: string): Promise<AuditJobView> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const job = manager.getAuditJob(jobId);
    if (job !== null && job.finishedAt !== null && manager.runningWorkerCount() === 0) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`the job did not end: ${JSON.stringify(job)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

/** 境目（1 つ目のワーカーが終わった時刻）の前の最後の要求と、後の最初の要求の間（サーバに届いた時刻）。 */
function boundaryGapMs(space: Workspace): number {
  const boundary = space.workerExits[0];
  if (boundary === undefined) {
    throw new Error('the first worker did not exit');
  }
  const before = space.requests.filter(({ at }) => at <= boundary);
  const after = space.requests.filter(({ at }) => at > boundary);
  const last = before.at(-1);
  const first = after[0];
  if (last === undefined || first === undefined) {
    throw new Error(`no requests around the boundary: ${JSON.stringify(space.requests)}`);
  }
  // 測った値は、報告のために出力する（値は時刻の差だけ）。
  process.stdout.write(`[DEF-180] boundary gap ${String(first.at - last.at)} ms (${last.path} -> ${first.path})\n`);
  return first.at - last.at;
}

/** サーバに届いた要求は、読み取り（GET と HEAD）だけ。 */
function expectOnlyReads(space: Workspace): void {
  expect(nonReadRequestsOf(space.requests)).toEqual([]);
}

describe.each(RUN_BROWSERS)('DEF-180: the navigation interval at the boundary between jobs (%s)', (_name, runBrowser) => {
  it('keeps the interval from a single audit job to the next single audit job started right after it (server arrival times)', async () => {
    const manager = await prepare(runBrowser, 'boundary-single');
    const space = current();
    const first = await manager.startAuditJob({ profileId: 'boundary-single', expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!first.ok) {
      throw new Error(`the first job did not start: ${first.reason}`);
    }
    expect(await waitForJobEnd(manager, first.job.jobId)).toMatchObject({ state: 'FINISHED' });
    const second = await manager.startAuditJob({ profileId: 'boundary-single', expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!second.ok) {
      throw new Error(`the second job did not start: ${second.reason}`);
    }
    expect(await waitForJobEnd(manager, second.job.jobId)).toMatchObject({ state: 'FINISHED' });
    expect(boundaryGapMs(space), `the gap at the job boundary (${BOUNDARY_INTERVAL_MS} ms configured)`).toBeGreaterThanOrEqual(BOUNDARY_INTERVAL_MS);
    expectOnlyReads(space);
  }, TEST_TIMEOUT_MS);

  it('keeps the interval from the entry check to the audit the job manager starts right after it (OP-1 thenStartAudit)', async () => {
    const manager = await prepare(runBrowser, 'boundary-follow-up');
    const space = current();
    const started = await manager.startEntryCheck({ profileId: 'boundary-follow-up', expectedRevision: MIN_PROFILE_REVISION, thenStartAudit: true });
    if (!started.ok) {
      throw new Error(`the entry check did not start: ${started.reason}`);
    }
    const deadline = Date.now() + WAIT_LIMIT_MS;
    let followUp = manager.entryCheckFollowUpOf(started.job.jobId);
    while (followUp?.state === 'WAITING' && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
      followUp = manager.entryCheckFollowUpOf(started.job.jobId);
    }
    if (followUp?.state !== 'STARTED') {
      throw new Error(`the audit did not start after the entry check: ${JSON.stringify(followUp)}`);
    }
    expect(await waitForJobEnd(manager, followUp.jobId)).toMatchObject({ state: 'FINISHED', jobKind: 'AUDIT' });
    expect(boundaryGapMs(space), `the gap at the job boundary (${BOUNDARY_INTERVAL_MS} ms configured)`).toBeGreaterThanOrEqual(BOUNDARY_INTERVAL_MS);
    expectOnlyReads(space);
  }, TEST_TIMEOUT_MS);
});

function current(): Workspace {
  if (workspace === undefined) {
    throw new Error('no workspace');
  }
  return workspace;
}
