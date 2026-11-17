// T35R2-fix（T35R2 の C-1）: Run Coordinator を通らないジョブの流れ（発見 `executeDiscoveryRun`、READ の確かめ `executeReadCheckRun`）に、ワーカーと同じく
// 監査の段の口（`auditStage`）つきの認証の指定を渡したときの、承認したサービスの Origin への要求。レビュー担当の実験（T35R2 の `disc.t35r.test.ts`）を
// 写して、確かめの形にした。自前の 127.0.0.1 のサーバ 2 つ（アプリと、承認したサービスの Origin）。Chromium はテストの既定の headless だけ。
// - T37a で意図して直した期待（Task 37 の設計書 3.1。ユーザーの確認済み）: 登録した読み取りの手続きの呼び出し（POST）を、発見と READ の確かめでは
//   通す。届いた POST は、読み込みの数以下。
// - L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4）で意図して直した期待: 1 分あたりの上限で待つこと（DEF-141）と、1 回の Run の上限で
//   断る・止めること（T37a）を撤廃した。前の小さな上限を超える要求でも、断らず・待たず・知らせず・止めずに全部の画面を読む（TEST-SLIM M4 で、発見と READ の
//   確かめの 2 つの場面の it.each にまとめた）。
// 届いた数は、サーバの記録で数える（事前確認を除く）。各流れの後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { LOAD_PEAK_WINDOW_MS } from '../../src/crawl/load-meter.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import type { JobRunNotice } from '../../src/worker/job-site-availability.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const TEST_TIMEOUT_MS = 240_000;
/** 各流れの後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
/** 1 回の読み込みで、ページがサービスの Origin へ送る GET の数（前の小さな上限 2 より多い）。 */
const SERVICE_READS_PER_LOAD = 10;
const MAX_PAGES = 2;
const ADMIN_PATH = '/admin';
const SECOND_PATH = '/admin/b';
const READ_RPC_PATH = '/rpc/read';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
/** SHA-256 の 16 進の桁の数。 */
const SHA256_HEX_LENGTH = 64;
/** READ の確かめの定義の、どの候補にも当たらない識別の digest（読み込みだけを起こす）。 */
const UNMATCHED_IDENTITY_DIGEST = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`;

interface ServerRecord {
  readonly server: 'app' | 'service';
  readonly method: string;
}

/** DEF-141: 注入した待ちで、本物の時間を待つ上限（ms。時刻は待つ時間の分だけ進める）。 */
const FAST_SLEEP_MS = 10;

/** DEF-141: 待ちを短くする時計（`now` は本物の時刻に待った時間を足した値。`sleep` は時刻を進めて、短く待って終わる）。待った時間を記録する。 */
class FastClock {
  #offsetMs = 0;
  readonly sleeps: number[] = [];
  readonly now = (): number => Date.now() + this.#offsetMs;
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.#offsetMs += ms;
    await wait(Math.min(ms, FAST_SLEEP_MS));
  };
}

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T35R2-fix: the service request limit of the discovery and READ check jobs with %s', (_label, launch) => {
  let app: LoopbackHttpServer;
  let service: LoopbackHttpServer;
  let workDirectory = '';
  let runCount = 0;
  const records: ServerRecord[] = [];

  const listenerOf = (server: ServerRecord['server']) => (request: IncomingMessage, response: ServerResponse): void => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const preflight = request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
      if (!preflight) {
        records.push({ server, method: request.method ?? '' });
      }
      const cors = {
        'access-control-allow-origin': typeof request.headers.origin === 'string' ? request.headers.origin : '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(HTTP_NO_CONTENT, cors).end();
      } else if (server === 'app') {
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>管理</title></head><body><h1>管理</h1><main><p id="l">x</p><a href="${SECOND_PATH}">b</a>
<script>for (let i = 0; i < ${SERVICE_READS_PER_LOAD}; i += 1) fetch('${service.origin}/rest/v1/m' + i).catch(() => 0);
fetch('${service.origin}${READ_RPC_PATH}', { method: 'POST', body: '{}' }).catch(() => 0);</script></main></body></html>`);
      } else {
        response.writeHead(HTTP_OK, { ...cors, 'content-type': 'application/json' }).end('{"n":1}');
      }
    });
  };

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-job-audit-stage-'));
    service = await startLoopbackHttpServer(listenerOf('service'));
    app = await startLoopbackHttpServer(listenerOf('app'));
  });

  afterAll(async () => {
    await Promise.all([app?.close(), service?.close()]);
    await rm(workDirectory, { recursive: true, force: true });
  });

  const setup = (): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
    runCount += 1;
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [{ origin: service.origin, path: READ_RPC_PATH, method: 'POST', maxPerPageLoad: 1 }],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },    };
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [] },
      approvedTestOrigins: [app.origin],
      auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: '/auth',
      filterState: filterAuthenticatedState,
      auditStage,
    };
    const base = fastRunConfig(app.origin, ADMIN_PATH, {
      target: { id: `job-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    });
    return { config: { ...base, site: { startUrl: `${app.origin}${ADMIN_PATH}`, allowedOrigins: [app.origin] } }, authentication };
  };

  /** この流れの間に、サービスの Origin に届いた要求の method。 */
  const serviceMethodsSince = (start: number): readonly string[] =>
    records.slice(start).filter(({ server }) => server === 'service').map(({ method }) => method);

  /** この流れの間の、アプリの画面の読み込みの数。 */
  const appLoadsSince = (start: number): number => records.slice(start).filter(({ server }) => server === 'app').length;

  /** ジョブを動かし、成果物の終わりの理由・`authentication`・上限の理由の有無と、知らせの `authentication` を返す。 */
  interface JobResult {
    readonly endReason: string;
    readonly authentication: unknown;
    readonly summaryAuthentication: unknown;
    /** 画面（発見）か定義（READ）ごとに、上限で断った・止めた印があるか。 */
    readonly limitMarks: readonly boolean[];
  }
  type JobRunner = (clock: FastClock, notices: JobRunNotice[]) => Promise<JobResult>;

  const runDiscovery: JobRunner = async (clock, notices) => {
    const { config, authentication } = setup();
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: clock.now, sleep: clock.sleep,
      stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onNotice: (notice) => notices.push(notice) });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    return {
      endReason: document.endReason,
      authentication: document.authentication,
      summaryAuthentication: outcome.summary.authentication,
      limitMarks: document.pages.map((page) => page.state !== 'READ' || page.record.incompleteReasons.includes('SERVICE_READ_REFUSED')),
    };
  };

  const runReadChecks: JobRunner = async (clock, notices) => {
    const { config, authentication } = setup();
    const readCheckOf = (index: number, path: string): WorkerStartReadCheck => ({
      readCheckId: `read-${index}`,
      readCheckRevision: 1,
      targetPage: { origin: app.origin, path },
      definition: { targetIdentityDigest: UNMATCHED_IDENTITY_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    });
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-check-${runCount}`, authentication, readChecks: [readCheckOf(1, ADMIN_PATH), readCheckOf(2, SECOND_PATH)], launchBrowser: launch,
      clock: () => new Date(), now: clock.now, sleep: clock.sleep, stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onNotice: (notice) => notices.push(notice) });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
    return {
      endReason: document.endReason,
      authentication: document.authentication,
      summaryAuthentication: outcome.summary.authentication,
      limitMarks: document.checks.map((check) => check.state === 'NOT_EXECUTED' && check.reason === 'SERVICE_REQUEST_LIMIT_REACHED'),
    };
  };

  // L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4）で直した: 1 回の Run の上限で断る・止めることと、1 分あたりの上限で待つこと（DEF-141）を
  // 撤廃した（LZ-3c: 上限の値も渡さない）。前の小さな上限（2 件）を超えても、断らず、待たず、知らせず、止めずに、2 つの画面を読む。待ちは注入した時計で数える。
  it.each([
    ['the discovery', runDiscovery],
    ['the READ checks', runReadChecks],
  ] as const)('delivers the service origin requests of %s beyond the old limits, without waiting or stopping (L11)', async (_job, runJob) => {
    const clock = new FastClock();
    const notices: JobRunNotice[] = [];
    const start = records.length;
    const result = await runJob(clock, notices);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(appLoadsSince(start)).toBe(MAX_PAGES);
    const methods = serviceMethodsSince(start);
    // どの読み込みでも、サービスの Origin への GET はすべて届いた（断らない）。登録した呼び出し（POST）は読み込みの数以下。
    expect(methods.filter((method) => method === 'GET').length).toBe(MAX_PAGES * SERVICE_READS_PER_LOAD);
    expect(methods.filter((method) => method === 'POST').length).toBeLessThanOrEqual(appLoadsSince(start));
    expect(result.endReason).not.toBe('SERVICE_REQUEST_LIMIT_REACHED');
    expect(result.limitMarks).toEqual([false, false]);
    expect(result.authentication).toMatchObject({ serviceRequestLimitReached: false, serviceRequestPacingWaits: 0, serviceRequestPacingWaitMs: 0 });
    expect(notices.filter((notice) => notice.kind === 'SERVICE_REQUEST_PACING_WAIT')).toEqual([]);
    expect(clock.sleeps.filter((ms) => ms >= LOAD_PEAK_WINDOW_MS / 2)).toEqual([]);
    expect(result.summaryAuthentication).toEqual(result.authentication);
  }, TEST_TIMEOUT_MS);
});
