// AS-b（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.1〜2.3、受け入れ条件 2・3・5）: 監査の段の送信の扱いを、ジョブの管理と本物の
// ワーカー（一時のビルドの `dist/worker/audit-worker.js`。CLI と同じ Chromium の起動）で、127.0.0.1 の fixture のサーバに対して確かめる。
// - `PASS_EXCEPT_DELETE` のプロファイル（表示の設定と同じ欄。`START` の `auditSendPolicy`）の監査のジョブ: ページが自分で出す同じ Origin の POST はサイトに届き、
//   Safety の Evidence（page.json）と `run.json` の `safety.auditSend`（扱いと method ごとの数）に残る。`DELETE` と危険な語（logout）の path の POST は届かない
//   （全部の後に名前つきの時間だけ待ってから数え直す）。違反 0。
// - 既定（`READ_ONLY`）のプロファイルの監査のジョブ: 今どおり、読み取りでない要求は届かない。`run.json` の扱いは `READ_ONLY`・0 件。
// - 値（本文、query の値、Cookie）は、成果物（ZIP の中身を含む）と管理データ（WAL を含む）に出ない（目印の値で確かめる）。
// - テストのジョブのブラウザは headless（`hideJobBrowser` と同じく、表示の設定を切る）。作業のディレクトリ、管理データ、出力先は一時のフォルダだけ。
import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { loadConfig } from '../../src/config/load-config.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  createAuditJobManager,
  type AuditJobContextResolver,
  type AuditJobManager,
  type AuditWorkerForker,
} from '../../src/control/job/audit-job-manager.js';
import { readJob, type AuditJobView } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, saveProfileDisplaySettings } from '../../src/control/store/profile-store.js';
import type { AuditSendPolicyName } from '../../src/core/audit-send-policy.js';
import { isJobEnded, waitForJob, type JobViewSource } from '../helpers/job-test-support.js';
import { databaseFilePlaces, filesUnder, nonReadRequestsOf, placesWithMarkers } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import { readRunArtifacts } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 300_000;
const START_PATH = '/send/index.html';
const SAVE_PATH = '/api/save';
const DELETE_PATH = '/api/items/1';
const LOGOUT_PATH = '/api/logout';
/** ページの読み込みの最小の間隔（ms。ループバックなので短くてよい）。 */
const NAVIGATION_INTERVAL_MS = 200;
const WAIT_OPTIONS = Object.freeze({ limitMs: 180_000, pollMs: 100 });
/** 止めるべき要求の、ジョブの後に遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;

/** 値の目印（本文、query の値、Cookie）。どこにも記録されてはならない。 */
const MARKERS = Object.freeze({
  body: 'asb-body-marker-7c1e',
  query: 'asb-query-marker-2f9a',
  cookie: 'asb-cookie-marker-5d3b',
});

/** ページが読み込みで自分で出す送信（同じ Origin の POST、`DELETE`、危険な語の path の POST）。 */
const PAGE_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>送信のページ</title></head><body>
<main><h1>送信のページ</h1><p>読み込みで送信を出すページ。</p></main>
<script>
fetch('${SAVE_PATH}?token=${MARKERS.query}', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '${MARKERS.body}' }).catch(() => undefined);
fetch('${DELETE_PATH}', { method: 'DELETE' }).catch(() => undefined);
fetch('${LOGOUT_PATH}', { method: 'POST', body: '${MARKERS.body}' }).catch(() => undefined);
</script>
</body></html>`;

interface RecordingSite {
  readonly server: LoopbackHttpServer;
  readonly requests: { readonly method: string; readonly path: string }[];
}

const startSite = async (): Promise<RecordingSite> => {
  const requests: { method: string; path: string }[] = [];
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const method = request.method ?? 'GET';
    if (path !== '/favicon.ico') {
      requests.push({ method, path });
    }
    request.resume();
    if (method === 'GET' && path === START_PATH) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `sid=${MARKERS.cookie}; Path=/; HttpOnly; SameSite=Lax`,
      });
      response.end(PAGE_HTML);
      return;
    }
    if (method === 'GET' && (path === '/robots.txt' || path === '/sitemap.xml')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('ok');
  };
  return { server: await startLoopbackHttpServer(listener), requests };
};

let site: RecordingSite;
let build: TemporaryBuild;
let workDirectory: string;
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
/** 本物の `fork` で起動し、起動した子を記録する（CC-097: `worker-fork.ts` の補助）。 */
const forks = createCountingFork();
const workers: readonly ChildProcess[] = forks.children;
const recordingFork: AuditWorkerForker = forks.fork;

const loadConfigContext: AuditJobContextResolver = async (targetConfigPath) => ({
  targetConfig: await loadConfig(join(workDirectory, targetConfigPath)),
});

const newManager = (): AuditJobManager => {
  manager = createAuditJobManager({
    database,
    repositoryRoot: workDirectory,
    workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
    resolveContext: loadConfigContext,
    forkWorker: recordingFork,
  });
  return manager;
};

const databaseJobs: JobViewSource = { getAuditJob: (jobId) => readJob(database, jobId) };

/** 公開の監査のプロファイルを作り、監査の段の送信の扱いを保存する（ジョブのブラウザは headless）。出力先を返す。 */
async function prepareProfile(name: string, auditSendPolicy: AuditSendPolicyName): Promise<string> {
  const outputDirectory = join(workDirectory, `${name}-output`);
  const targetConfigPath = `config/targets/${name}.json`;
  await writeFile(join(workDirectory, targetConfigPath), JSON.stringify(cliTargetConfig(name, site.server.origin, START_PATH, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS, maxPages: 1 },
    audit: { performance: false, accessibility: false, interactions: false, screenshots: false },
    output: { directory: outputDirectory },
  })), 'utf8');
  const context = await loadConfigContext(targetConfigPath);
  const created = createProfile(database, {
    schemaVersion: 'beaksight-profile/1',
    profileId: name,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath,
    environment: 'PUBLIC',
    mode: 'PUBLIC_PASSIVE',
    auth: 'NONE',
    approvedTestOrigins: [],
    environmentEvidenceRef: null,
  }, { resolveContext: () => context });
  expect(created.ok).toBe(true);
  expect(saveProfileDisplaySettings(database, name, { showJobBrowser: false, auditSendPolicy })).toMatchObject({ ok: true });
  return outputDirectory;
}

/** ジョブを始めて終わりまで待つ。 */
async function runJob(profileId: string): Promise<AuditJobView> {
  const result = await newManager().startAuditJob({ profileId, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
  if (!result.ok) {
    throw new Error(`the job did not start: ${result.reason}`);
  }
  return waitForJob(databaseJobs, result.job.jobId, isJobEnded, WAIT_OPTIONS);
}

/**
 * 値の目印が出た場所（`<目印の名前>: <場所>`）。
 * - 本文と Cookie の目印: 成果物のすべて（ZIP の中身を含む）と、管理データとその WAL。
 * - query の値の目印: `run.json` と、管理データとその WAL。公開の監査のページの記録（page.json の network の Evidence と止めた要求の URL、その写しの audit.json・
 *   report.html・バンドル）は、AS-b の前から query の値を含む URL をそのまま記録する（読み取りだけでも、止めた POST の URL が残る）ので、ここでは数えない
 *   （AS-b の報告の発見事項）。Safety Ledger の通した要求の記録は query を持たない（`passedAuditSendRequests` の path だけ。上で確かめる）。
 */
const markerPlacesOf = (outputDirectory: string): readonly string[] => {
  const database = databaseFilePlaces(resolveControlDatabasePath(workDirectory));
  const files = filesUnder(outputDirectory);
  const runJson = files.filter(([path]) => /[\\/]run\.json$/u.test(path));
  return [
    ...[MARKERS.body, MARKERS.cookie].flatMap((marker) => placesWithMarkers([...files, ...database], [marker]).map((place) => `value: ${place}`)),
    ...placesWithMarkers([...runJson, ...database], [MARKERS.query]).map((place) => `query: ${place}`),
  ];
};

describe('AS-b: the audit send policy with the real worker', () => {
  beforeAll(async () => {
    site = await startSite();
    build = await buildIntoTemporaryDirectory();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-send-worker-'));
    await mkdir(join(workDirectory, 'config', 'targets'), { recursive: true });
    database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  }, SUITE_TIMEOUT_MS);

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    const leftovers = workers.filter((child) => child.exitCode === null && child.signalCode === null);
    for (const child of leftovers) {
      child.kill();
    }
    if (database !== undefined) {
      closeControlDatabase(database);
    }
    await build?.remove();
    await site?.server.close();
    if (workDirectory !== undefined) {
      await rm(workDirectory, { recursive: true, force: true });
    }
    expect(leftovers.length, 'workers left running after the tests').toBe(0);
  }, SUITE_TIMEOUT_MS);

  it('lets the POST of the page reach the site with PASS_EXCEPT_DELETE, blocks DELETE and the dangerous path, and records the policy and the counts', async () => {
    const since = site.requests.length;
    const outputDirectory = await prepareProfile('asb-pass', 'PASS_EXCEPT_DELETE');
    const job = await runJob('asb-pass');
    expect(job).toMatchObject({ state: 'FINISHED', endKind: 'RAN', failureReason: null });
    await wait(LATE_REQUEST_WAIT_MS);

    const nonReads = nonReadRequestsOf(site.requests, since);
    expect(nonReads.length).toBeGreaterThan(0);
    expect([...new Set(nonReads)]).toEqual([`POST ${SAVE_PATH}`]);

    const { run, pages } = readRunArtifacts(outputDirectory);
    expect(run?.effectiveConfig.audit.sendPolicy).toBe('PASS_EXCEPT_DELETE');
    expect(run?.safety.invariantViolationCount).toBe(0);
    expect(run?.safety.auditSend).toEqual({
      policy: 'PASS_EXCEPT_DELETE',
      passedRequests: nonReads.length,
      passedRequestsByMethod: { POST: nonReads.length },
      // AS-c: 同じ Origin への POST だけ。WebSocket の接続はない。
      passedOtherOriginRequests: 0,
      passedWebSockets: 0,
      passedWebSocketsOutsideGuard: 0,
      passedDangerousWebSockets: 0,
    });
    // 止めた `DELETE` と危険な語の POST は、今どおり止めた要求として数える。
    expect(run?.safety.blockedRequestsByMethod['DELETE']).toBeGreaterThan(0);
    // ページの記録（Safety の Evidence）に、通した要求の method・Origin・path・回数が残る（値なし）。
    const pageText = JSON.stringify(pages);
    expect(pageText).toContain('"passedAuditSendRequests"');
    expect(pageText).toContain(`"path":"${SAVE_PATH}"`);
    expect(JSON.stringify(pages.map((page) => (page as unknown as { readonly evidence?: readonly { readonly payload?: { readonly passedAuditSendRequests?: unknown } }[] }).evidence
      ?.map((evidence) => evidence.payload?.passedAuditSendRequests) ?? []))).not.toContain(MARKERS.query);
    expect(markerPlacesOf(outputDirectory)).toEqual([]);
  }, SUITE_TIMEOUT_MS);

  it('keeps blocking every non-read request of the page with the default READ_ONLY', async () => {
    const since = site.requests.length;
    const outputDirectory = await prepareProfile('asb-read-only', 'READ_ONLY');
    const job = await runJob('asb-read-only');
    expect(job).toMatchObject({ state: 'FINISHED', endKind: 'RAN', failureReason: null });
    await wait(LATE_REQUEST_WAIT_MS);

    expect(nonReadRequestsOf(site.requests, since)).toEqual([]);
    const { run, pages } = readRunArtifacts(outputDirectory);
    expect(run?.effectiveConfig.audit.sendPolicy).toBe('READ_ONLY');
    expect(run?.safety.invariantViolationCount).toBe(0);
    expect(run?.safety.auditSend).toEqual({
      policy: 'READ_ONLY', passedRequests: 0, passedRequestsByMethod: {}, passedOtherOriginRequests: 0, passedWebSockets: 0,
      passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0,
    });
    expect(run?.safety.blockedRequestsByMethod['POST']).toBeGreaterThan(0);
    expect(JSON.stringify(pages)).not.toContain('"passedAuditSendRequests"');
    expect(markerPlacesOf(outputDirectory)).toEqual([]);
  }, SUITE_TIMEOUT_MS);
});
