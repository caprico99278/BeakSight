/**
 * 監査のジョブの Server Functions を、ビルドした画面のサーバ（一時の root）に HTTP で直接送って確かめる（Task 24 の設計書 4.4、4.8。T24f）。
 * - 入力の検証（`schemas/control/ui-audit-job-*`、`ui-profile-key`）: 合わない入力は 400 で、ジョブを作らない。
 * - CSRF: cross-site の POST と、Origin の違う POST は 403 のままで、ジョブを作らない。
 * - 開始の画面の要点（ターゲット設定の値を読むだけ）と、開始できない理由。
 * - 開始の拒否（プロファイルがない、取り消し、改訂の違い、実行できないモード、同時に 2 つ）。拒否では、ジョブを作らない。
 * - 開始 → 一覧と詳細（進み具合）→ 止める → 一部未完了（PARTIAL）で終わる。終わったジョブは止められない。成果物の一覧。
 * - fixture のサイト（127.0.0.1）に届いた要求は GET と HEAD だけ。ワーカーと Chromium の process が残らない。
 * 管理データ、ターゲット設定、出力先は、一時の root の中だけ。ワーカーは一時の root の `dist/`（`npm run build` の写し）を使う。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT_CODES } from '../../../src/cli/exit-codes.js';
import { READ_METHODS } from '../../../tests/helpers/leak-places.js';
import { descendantsOf, listProcesses, waitUntilExited, type ProcessIdentity } from '../../../tests/helpers/process-tree.js';
import { publicProfileDocument, startTimedSite, writeAuditTargetConfig, type TimedSite } from './helpers/audit-site.ts';
import {
  createTemporaryUiRoot,
  findFreePort,
  parseSetCookie,
  rawRequest,
  startLauncher,
  stopServer,
  type StartedServer,
  type TemporaryUiRoot,
} from './helpers/local-server.ts';
import { callServerFunction, encodeServerFunctionPayload, readServerFunctionIds, type ServerFunctionCall } from './helpers/server-functions.ts';
import { waitForJobViaServerFunctions, type ServerFunctionJobWaitTiming } from './helpers/server-function-job-wait.ts';

/** HTTP の状態。 */
const STATUS = Object.freeze({ OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403 });
/** 止める場面の、ページの読み込みの最小の間隔（ms。最初のページの後、止める要求が届く前に、次のページを終えないように）。 */
const SLOW_INTERVAL_MS = 3_000;
/** 状態が変わるのを待つ上限と、読み直す間隔（ms）。 */
const JOB_WAIT: ServerFunctionJobWaitTiming = Object.freeze({ limitMs: 120_000, stepMs: 250 });
/** ワーカーと Chromium の process が消えるのを待つ上限（ms）。 */
const PROCESS_EXIT_LIMIT_MS = 20_000;
/** テストの値（匿名）。 */
const SLOW_PROFILE = 't24f-slow';
const OTHER_PROFILE = 't24f-other';
const RETIRED_PROFILE = 't24f-retired';
const TEST_MODE_PROFILE = 't24f-test-mode';
/** T25e: 今も実行できないモード（承認した書き込み）と、今は実行できない認証の方式（自動ログイン）のプロファイル。 */
const WRITE_MODE_PROFILE = 't25e-write-mode';
const AUTOMATED_LOGIN_PROFILE = 't25e-automated-login';
/** 設定の既定の値（`src/config/defaults.ts`。ターゲット設定で上書きしない項目）。 */
const DEFAULT_MAX_PAGES = 500;
const DEFAULT_MAX_RUNTIME_MS = 3_600_000;

let root: TemporaryUiRoot | undefined;
let site: TimedSite | undefined;
let server: StartedServer | undefined;
let cookie = '';
let ids: ReadonlyMap<string, string> = new Map();
/** 監査の間に見つけた、画面のサーバの子孫（ワーカーと Chromium）。 */
const descendants: ProcessIdentity[] = [];

const started = (): StartedServer => {
  if (server === undefined) {
    throw new Error('サーバが起動していない');
  }
  return server;
};

const call = (name: string, method: 'GET' | 'POST', data?: unknown): Promise<ServerFunctionCall> =>
  callServerFunction({ port: started().port, origin: started().origin, cookie, ids }, name, method, data);

const valueOf = async <T>(name: string, method: 'GET' | 'POST', data?: unknown): Promise<T> => {
  const result = await call(name, method, data);
  expect(result.response.status, `${name} ${result.response.body.slice(0, 200)}`).toBe(STATUS.OK);
  return result.value as T;
};

interface JobRow {
  readonly jobId: string;
  readonly profileId: string;
  readonly state: string;
}
interface JobDetail extends JobRow {
  readonly runId: string | null;
  readonly runStatus: string | null;
  readonly endKind: string | null;
  readonly exitCode: number | null;
  readonly active: boolean;
  readonly forceStopAvailable: boolean;
  readonly lastProgress: { readonly pagesFinished: number; readonly maxPages: number } | null;
  readonly artifacts: readonly { readonly kind: string; readonly href: string }[];
}

const listJobs = (): Promise<readonly JobRow[]> => valueOf<readonly JobRow[]>('listAuditJobsFn', 'GET');
const getJob = (jobId: string): Promise<JobDetail | null> => valueOf<JobDetail | null>('getAuditJobFn', 'GET', { jobId });

/** 画面のサーバの子孫（ワーカーと Chromium）を記録する（後で、残っていないことを確かめる）。 */
const recordDescendants = async (): Promise<readonly ProcessIdentity[]> => {
  const found = descendantsOf(started().child.pid ?? 0, await listProcesses());
  descendants.push(...found);
  return found;
};

beforeAll(async () => {
  root = createTemporaryUiRoot('built');
  site = await startTimedSite();
  const slowConfig = writeAuditTargetConfig(root.root, SLOW_PROFILE, site.origin, { minNavigationIntervalMs: SLOW_INTERVAL_MS, screenshots: false });
  const otherConfig = writeAuditTargetConfig(root.root, OTHER_PROFILE, site.origin, { minNavigationIntervalMs: SLOW_INTERVAL_MS, screenshots: false });
  ids = readServerFunctionIds(`${root.root}/apps/local-ui/dist/server/server.js`);
  server = await startLauncher(root, await findFreePort());
  const exchange = await rawRequest(server.port, `${server.tokenUrl.pathname}${server.tokenUrl.search}`);
  cookie = parseSetCookie(exchange.headers['set-cookie'])?.pair ?? '';
  for (const document of [
    publicProfileDocument(SLOW_PROFILE, slowConfig),
    publicProfileDocument(OTHER_PROFILE, otherConfig),
    publicProfileDocument(RETIRED_PROFILE, otherConfig),
    {
      ...publicProfileDocument(TEST_MODE_PROFILE, otherConfig),
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [site.origin],
      environmentEvidenceRef: 't24f-evidence',
    },
    {
      ...publicProfileDocument(WRITE_MODE_PROFILE, otherConfig),
      environment: 'TEST',
      mode: 'TEST_APPROVED_WRITE',
      auth: 'MANUAL_SESSION',
      approvedTestOrigins: [site.origin],
      environmentEvidenceRef: 't25e-evidence',
    },
    {
      ...publicProfileDocument(AUTOMATED_LOGIN_PROFILE, otherConfig),
      environment: 'TEST',
      mode: 'TEST_AUTH_PASSIVE',
      auth: 'AUTOMATED_LOGIN',
      approvedTestOrigins: [site.origin],
      environmentEvidenceRef: 't25e-evidence',
    },
  ]) {
    expect(await valueOf('createProfileFn', 'POST', { profile: document })).toMatchObject({ ok: true });
  }
  expect(await valueOf('retireProfileFn', 'POST', { profileId: RETIRED_PROFILE, expectedRevision: 1 })).toMatchObject({ ok: true });
});

afterAll(async () => {
  await stopServer(server);
  expect(await waitUntilExited(descendants, PROCESS_EXIT_LIMIT_MS)).toEqual([]);
  await site?.close();
  root?.remove();
});

describe('audit job Server Functions: registration and input validation', () => {
  it('lists the audit job Server Functions by name', () => {
    expect([...ids.keys()]).toEqual(expect.arrayContaining([
      'auditStartSummaryFn',
      'getAuditJobFn',
      'listAuditJobsFn',
      'startAuditJobFn',
      'stopAuditJobFn',
    ]));
  });

  it('rejects inputs that do not match the schemas with 400, and creates no job', async () => {
    const rejected: readonly [string, 'GET' | 'POST', unknown][] = [
      ['startAuditJobFn', 'POST', { profileId: SLOW_PROFILE, expectedRevision: 1 }],
      ['startAuditJobFn', 'POST', { profileId: 'NOT VALID', expectedRevision: 1, startNew: true }],
      ['startAuditJobFn', 'POST', { profileId: SLOW_PROFILE, expectedRevision: 0, startNew: true }],
      ['startAuditJobFn', 'POST', { profileId: SLOW_PROFILE, expectedRevision: '1', startNew: true }],
      ['startAuditJobFn', 'POST', { profileId: SLOW_PROFILE, expectedRevision: 1, startNew: 'yes' }],
      ['startAuditJobFn', 'POST', { profileId: SLOW_PROFILE, expectedRevision: 1, startNew: true, minNavigationIntervalMs: 0 }],
      ['stopAuditJobFn', 'POST', { jobId: 'NOT-A-JOB', force: false }],
      ['stopAuditJobFn', 'POST', { jobId: 'job-1' }],
      ['stopAuditJobFn', 'POST', { jobId: 'job-1', force: 'true' }],
      ['getAuditJobFn', 'GET', { jobId: '' }],
      ['getAuditJobFn', 'GET', { jobId: '../job' }],
      ['auditStartSummaryFn', 'GET', { profileId: 1 }],
    ];
    for (const [name, method, data] of rejected) {
      const result = await call(name, method, data);
      expect(result.response.status, `${name} ${JSON.stringify(data)}`).toBe(STATUS.BAD_REQUEST);
    }
    expect(await listJobs()).toEqual([]);
  });

  it('keeps the CSRF protection: a cross-site or other-origin POST is 403, and creates no job', async () => {
    const id = ids.get('startAuditJobFn') ?? '';
    const body = encodeServerFunctionPayload({ profileId: SLOW_PROFILE, expectedRevision: 1, startNew: true });
    for (const headers of [
      { 'sec-fetch-site': 'cross-site', origin: started().origin },
      { 'sec-fetch-site': 'same-site', origin: 'http://127.0.0.1:1' },
      { origin: 'http://attacker.invalid' },
    ]) {
      const response = await rawRequest(started().port, `/_serverFn/${id}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', ...headers },
        body,
      });
      expect(response.status, JSON.stringify(headers)).toBe(STATUS.FORBIDDEN);
    }
    expect(await listJobs()).toEqual([]);
  });
});

describe('audit job Server Functions: the start screen summary and the rejections', () => {
  it('returns the target summary (read only) for an executable profile', async () => {
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: SLOW_PROFILE })).toEqual({
      profileId: SLOW_PROFILE,
      revision: 1,
      mode: 'PUBLIC_PASSIVE',
      status: 'ACTIVE',
      targetConfigPath: `config/targets/${SLOW_PROFILE}.json`,
      target: {
        startUrl: `${site?.origin ?? ''}/crawl/index.html`,
        maxPages: DEFAULT_MAX_PAGES,
        maxRuntimeMs: DEFAULT_MAX_RUNTIME_MS,
        minNavigationIntervalMs: SLOW_INTERVAL_MS,
      },
      blocker: null,
      errorCodes: [],
      configError: null,
      // T25e: 公開の監査は、認証の設定を使わない。
      authRequired: false,
      authSetup: null,
      authSetupErrors: [],
      // T26e: 公開の監査には、自動ログインの状態がない。ログインの確かめは、自動ログインのプロファイルだけ。
      nextAllowedAt: null,
      auth: 'NONE',
      autoLogin: null,
      loginCheck: { blocker: 'AUTH_STRATEGY_NOT_EXECUTABLE', errorCodes: [], authSetupErrors: [], nextAllowedAt: null },
      // FM2d: 公開の監査は、まとめて実行しない（ログインしない）。
      chain: null,
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: 'not-there' })).toBeNull();
  });

  // T25e（T25d の申し送り 1）: 認証つきの読み取りの監査（`TEST_AUTH_PASSIVE`）は、認証の設定があれば開始できるモードになった。認証の設定が
  // なければ `AUTH_SETUP_MISSING` で拒む。承認した書き込みの監査は、今も `MODE_NOT_EXECUTABLE`。T26d-2 round 1: 自動ログインは方式として実行できる
  // ので、認証の設定がなければ、手動のログインと同じく `AUTH_SETUP_MISSING` で拒む（資格情報などの確かめは、その後にジョブの管理が行う）。
  it('shows why a retired profile, a missing auth setup, a not-yet-executable mode or auth strategy cannot start', async () => {
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: RETIRED_PROFILE })).toMatchObject({ status: 'RETIRED', blocker: 'PROFILE_RETIRED' });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: TEST_MODE_PROFILE })).toMatchObject({
      mode: 'TEST_AUTH_PASSIVE',
      blocker: 'AUTH_SETUP_MISSING',
      authRequired: true,
      authSetup: null,
      authSetupErrors: [],
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: WRITE_MODE_PROFILE })).toMatchObject({
      mode: 'TEST_APPROVED_WRITE',
      blocker: 'MODE_NOT_EXECUTABLE',
      authRequired: false,
    });
    expect(await valueOf('auditStartSummaryFn', 'GET', { profileId: AUTOMATED_LOGIN_PROFILE })).toMatchObject({
      mode: 'TEST_AUTH_PASSIVE',
      blocker: 'AUTH_SETUP_MISSING',
      authRequired: true,
      authSetup: null,
      authSetupErrors: [],
    });
  });

  it('rejects the start with the reason (not found, retired, revision conflict, auth setup, mode, auth strategy), and creates no job', async () => {
    const cases: readonly [Record<string, unknown>, string][] = [
      [{ profileId: 'not-there', expectedRevision: 1, startNew: true }, 'PROFILE_NOT_FOUND'],
      [{ profileId: RETIRED_PROFILE, expectedRevision: 2, startNew: true }, 'PROFILE_RETIRED'],
      [{ profileId: SLOW_PROFILE, expectedRevision: 2, startNew: true }, 'PROFILE_REVISION_CONFLICT'],
      [{ profileId: TEST_MODE_PROFILE, expectedRevision: 1, startNew: false }, 'AUTH_SETUP_MISSING'],
      [{ profileId: WRITE_MODE_PROFILE, expectedRevision: 1, startNew: false }, 'MODE_NOT_EXECUTABLE'],
      [{ profileId: AUTOMATED_LOGIN_PROFILE, expectedRevision: 1, startNew: true }, 'AUTH_SETUP_MISSING'],
    ];
    for (const [data, reason] of cases) {
      expect(await valueOf('startAuditJobFn', 'POST', data), JSON.stringify(data)).toEqual({ ok: false, reason, errorCodes: [], authSetupErrors: [] });
    }
    expect(await listJobs()).toEqual([]);
  });
});

describe('audit job Server Functions: start, list, detail, one at a time, stop', () => {
  let jobId = '';

  it('starts a job, lists it, and shows its detail', async () => {
    const result = await valueOf<{ ok: boolean; jobId: string }>('startAuditJobFn', 'POST', { profileId: SLOW_PROFILE, expectedRevision: 1, startNew: true });
    expect(result.ok).toBe(true);
    jobId = result.jobId;
    const jobs = await listJobs();
    expect(jobs.map((job) => [job.jobId, job.profileId])).toEqual([[jobId, SLOW_PROFILE]]);
    const detail = await getJob(jobId);
    expect(detail).toMatchObject({ jobId, profileId: SLOW_PROFILE, active: true, forceStopAvailable: false, startNew: true });
    // T25e: 公開の監査のジョブには、認証の状態がない。
    expect(detail).toMatchObject({ lastAuthState: null, sessionLostUrl: null });
    expect(await valueOf('getAuditJobFn', 'GET', { jobId: 'no-such-job' })).toBeNull();
  });

  it('runs only one job at a time (another start is rejected while the first one runs)', async () => {
    expect(await valueOf('startAuditJobFn', 'POST', { profileId: OTHER_PROFILE, expectedRevision: 1, startNew: true }))
      .toEqual({ ok: false, reason: 'JOB_ALREADY_ACTIVE', errorCodes: [], authSetupErrors: [] });
    expect(await valueOf('startAuditJobFn', 'POST', { profileId: SLOW_PROFILE, expectedRevision: 1, startNew: false }))
      .toEqual({ ok: false, reason: 'JOB_ALREADY_ACTIVE', errorCodes: [], authSetupErrors: [] });
    expect((await listJobs()).length).toBe(1);
  });

  it('reports the progress, then stops the job (PARTIAL), and refuses to stop it again', async () => {
    const running = await waitForJobViaServerFunctions(getJob, jobId, (job) => job.state === 'RUNNING' && job.lastProgress !== null, JOB_WAIT);
    expect(running.lastProgress?.pagesFinished).toBeGreaterThanOrEqual(1);
    expect(running.runId).toMatch(/^RUN-\d+$/u);
    expect((await recordDescendants()).length).toBeGreaterThan(0);

    const stopped = await valueOf<{ ok: boolean; job: JobRow }>('stopAuditJobFn', 'POST', { jobId, force: false });
    expect(stopped).toMatchObject({ ok: true, job: { jobId, state: 'STOPPING' } });
    expect(await getJob(jobId)).toMatchObject({ state: 'STOPPING', forceStopAvailable: false, active: true });

    const finished = await waitForJobViaServerFunctions(getJob, jobId, (job) => !job.active, JOB_WAIT);
    expect(finished).toMatchObject({ state: 'FINISHED', runStatus: 'PARTIAL', endKind: 'RAN', exitCode: EXIT_CODES.PARTIAL, active: false });
    expect(finished.artifacts.map((artifact) => artifact.kind)).toEqual(['REPORT', 'RUN_JSON', 'AUDIT_JSON', 'BUNDLE']);
    expect(finished.artifacts.every((artifact) => artifact.href.startsWith(`/artifacts/${jobId}/`))).toBe(true);

    expect(await valueOf('stopAuditJobFn', 'POST', { jobId, force: true })).toEqual({ ok: false, reason: 'JOB_NOT_ACTIVE' });
    expect(await valueOf('stopAuditJobFn', 'POST', { jobId: 'no-such-job', force: false })).toEqual({ ok: false, reason: 'JOB_NOT_FOUND' });
  });

  it('sent only GET and HEAD requests to the fixture site', () => {
    const methods = new Set(site?.requests().map((request) => request.method));
    expect([...methods].filter((method) => !READ_METHODS.has(method))).toEqual([]);
    expect(site?.requests().length).toBeGreaterThan(0);
  });
});
