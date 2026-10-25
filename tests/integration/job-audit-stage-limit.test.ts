// T35R2-fix（T35R2 の C-1）: Run Coordinator を通らないジョブの流れ（発見 `executeDiscoveryRun`、READ の確かめ `executeReadCheckRun`）に、ワーカーと同じく
// 監査の段の口（`auditStage`）つきの認証の指定を渡したときの、承認したサービスの Origin への要求。レビュー担当の実験（T35R2 の `disc.t35r.test.ts`）を
// 写して、確かめの形にした。自前の 127.0.0.1 のサーバ 2 つ（アプリと、承認したサービスの Origin）。Chromium はテストの既定の headless と、CLI の起動の
// 設定の両方。
// - 上限の部品を、Run と同じ共通の部品（`src/orchestration/audit-stage-run.ts`）で作って factory に渡し、ジョブの全体で数える: サービスの Origin に
//   届いた数は `perRun` 以下。
// - T37a で意図して直した期待（Task 37 の設計書 3.1。ユーザーの確認済み）: 前は、登録した読み取りの手続きの呼び出し（POST）を、これらの流れでは
//   通さなかった（届いた POST は 0）。今は、発見と READ の確かめでは通す（1 回の読み込みあたりの回数の中、上限の中）。届いた POST は、読み込みの数
//   以下で、届いた数の合計は今どおり `perRun` 以下。
// - T37a: 上限に届いたら、残りの画面（定義）を読まずに終わり（`SERVICE_REQUEST_LIMIT_REACHED`。PARTIAL）、成果物の
//   `authentication.serviceRequestLimitReached` が真。上限で断った要求のあった画面は `SERVICE_READ_REFUSED` を持つ。
// - DEF-141: 1 分あたりの上限では断らず、次の読み込みの前に待って続ける（待った回数と時間が成果物と知らせに出る）。上の場面の `SMALL_LIMITS` は
//   `perRun` と同じ値なので、今どおり 1 回の Run あたりの上限で止まる。
// 届いた数は、サーバの記録で数える（事前確認を除く）。各流れの後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
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
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
/** 各流れの後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;
/** 1 回の読み込みで、ページがサービスの Origin へ送る GET の数（上限より多い）。 */
const SERVICE_READS_PER_LOAD = 10;
const SMALL_LIMITS = Object.freeze({ perMinute: 2, perRun: 2 });
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

/** DEF-141: 1 回の読み込みのサービスへの GET（`SERVICE_READS_PER_LOAD`）より小さい 1 分あたりの上限（1 回の Run あたりは大きく）。 */
const PACING_LIMITS = Object.freeze({ perMinute: 3, perRun: 600 });
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

describe.each(LAUNCHERS)('T35R2-fix: the service request limit of the discovery and READ check jobs with %s', (_label, launch) => {
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

  const setup = (
    limits: { readonly perMinute: number; readonly perRun: number } = SMALL_LIMITS,
  ): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
    runCount += 1;
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [{ origin: service.origin, path: READ_RPC_PATH, method: 'POST', maxPerPageLoad: 1 }],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      serviceRequestLimits: limits,
    };
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

  it('keeps the service origin requests of the discovery within perRun, and ends at the limit (PARTIAL)', async () => {
    const { config, authentication } = setup();
    const start = records.length;
    const outcome = await executeDiscoveryRun({
      config, jobId: 'job-discovery', authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    // T37a: 最初の画面で上限に届いたので、2 つ目の画面は読まない（前は 2 ページを読んだ）。
    expect(appLoadsSince(start)).toBe(1);
    const methods = serviceMethodsSince(start);
    expect(methods.length).toBeLessThanOrEqual(SMALL_LIMITS.perRun);
    expect(methods.filter((method) => method === 'POST').length).toBeLessThanOrEqual(appLoadsSince(start));
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    expect(document.endReason).toBe('SERVICE_REQUEST_LIMIT_REACHED');
    expect(document.runStatus).toBe('PARTIAL');
    expect(document.authentication?.serviceRequestLimitReached).toBe(true);
    expect(document.pages.map((page) => (page.state === 'READ' ? page.record.incompleteReasons.includes('SERVICE_READ_REFUSED') : page.reason)))
      .toEqual([true, 'SERVICE_REQUEST_LIMIT_REACHED']);
    expect(outcome.summary.authentication).toEqual(document.authentication);
  }, TEST_TIMEOUT_MS);

  it('keeps the service origin requests of the READ checks within perRun, and ends at the limit (PARTIAL)', async () => {
    const { config, authentication } = setup();
    const readCheckOf = (index: number): WorkerStartReadCheck => ({
      readCheckId: `read-${index}`,
      readCheckRevision: 1,
      targetPage: { origin: app.origin, path: ADMIN_PATH },
      definition: { targetIdentityDigest: UNMATCHED_IDENTITY_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    });
    const start = records.length;
    const outcome = await executeReadCheckRun({
      config, jobId: 'job-read-check', authentication, readChecks: [readCheckOf(1), readCheckOf(2)], launchBrowser: launch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    // 対象の画面を読んだ（アプリの読み込みがあった）。T37a: その読み込みで上限に届いたので、どの定義の READ の URL も読まない。
    expect(appLoadsSince(start)).toBe(1);
    const methods = serviceMethodsSince(start);
    expect(methods.length).toBeLessThanOrEqual(SMALL_LIMITS.perRun);
    expect(methods.filter((method) => method === 'POST').length).toBeLessThanOrEqual(appLoadsSince(start));
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
    expect(document.endReason).toBe('SERVICE_REQUEST_LIMIT_REACHED');
    expect(document.runStatus).toBe('PARTIAL');
    expect(document.checks.map((check) => (check.state === 'NOT_EXECUTED' ? check.reason : check.state)))
      .toEqual(['SERVICE_REQUEST_LIMIT_REACHED', 'SERVICE_REQUEST_LIMIT_REACHED']);
    expect(document.authentication?.serviceRequestLimitReached).toBe(true);
    expect(outcome.summary.authentication).toEqual(document.authentication);
  }, TEST_TIMEOUT_MS);

  // DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 2.2、3 章の 1・3）: 1 分あたりの上限より多くの要求を 1 回の読み込みで出す画面でも、
  // ページの途中で断らず、次の画面の読み込みの前に待って最後まで読む。待った回数と時間が成果物の `authentication` と知らせに出る。待ちは注入した時計で
  // 短くする（本物の 60 秒を待たない）。
  it('waits before the next page of the discovery by the per minute limit, reads every page and records the waits (DEF-141)', async () => {
    const { config, authentication } = setup(PACING_LIMITS);
    const clock = new FastClock();
    const notices: JobRunNotice[] = [];
    const start = records.length;
    const outcome = await executeDiscoveryRun({
      config, jobId: 'job-discovery-pacing', authentication, launchBrowser: launch, clock: () => new Date(), now: clock.now, sleep: clock.sleep,
      stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onNotice: (notice) => notices.push(notice) });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(appLoadsSince(start)).toBe(MAX_PAGES);
    // どの読み込みでも、サービスの Origin への GET はすべて届いた（断らない）。
    expect(serviceMethodsSince(start).filter((method) => method === 'GET').length).toBe(MAX_PAGES * SERVICE_READS_PER_LOAD);
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    expect(document.endReason).not.toBe('SERVICE_REQUEST_LIMIT_REACHED');
    expect(document.pages.filter((page) => page.state === 'READ').map((page) => page.record.incompleteReasons.includes('SERVICE_READ_REFUSED')))
      .toEqual([false, false]);
    expect(document.authentication?.serviceRequestLimitReached).toBe(false);
    const waits = document.authentication?.serviceRequestPacingWaits ?? 0;
    expect(waits).toBeGreaterThan(0);
    const pacing = notices.filter((notice) => notice.kind === 'SERVICE_REQUEST_PACING_WAIT');
    expect(pacing).toHaveLength(waits);
    expect(document.authentication?.serviceRequestPacingWaitMs).toBe(pacing.reduce((sum, { waitMs }) => sum + waitMs, 0));
    expect(pacing.every(({ waitMs }) => waitMs > 0 && waitMs <= LOAD_PEAK_WINDOW_MS)).toBe(true);
    expect(clock.sleeps).toEqual(expect.arrayContaining(pacing.map(({ waitMs }) => waitMs)));
    expect(outcome.summary.authentication).toEqual(document.authentication);
  }, TEST_TIMEOUT_MS);

  it('waits before the next load of the READ checks by the per minute limit, and records the waits (DEF-141)', async () => {
    const { config, authentication } = setup(PACING_LIMITS);
    const clock = new FastClock();
    const notices: JobRunNotice[] = [];
    const readCheckOf = (index: number, path: string): WorkerStartReadCheck => ({
      readCheckId: `read-${index}`,
      readCheckRevision: 1,
      targetPage: { origin: app.origin, path },
      definition: { targetIdentityDigest: UNMATCHED_IDENTITY_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    });
    const start = records.length;
    const outcome = await executeReadCheckRun({
      config, jobId: 'job-read-check-pacing', authentication, readChecks: [readCheckOf(1, ADMIN_PATH), readCheckOf(2, SECOND_PATH)], launchBrowser: launch,
      clock: () => new Date(), now: clock.now, sleep: clock.sleep, stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined, onNotice: (notice) => notices.push(notice) });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    // 2 つの対象の画面をどちらも読んだ（上限で止まらない）。
    expect(appLoadsSince(start)).toBe(2);
    expect(serviceMethodsSince(start).filter((method) => method === 'GET').length).toBe(2 * SERVICE_READS_PER_LOAD);
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
    expect(document.endReason).not.toBe('SERVICE_REQUEST_LIMIT_REACHED');
    expect(document.authentication?.serviceRequestLimitReached).toBe(false);
    const waits = document.authentication?.serviceRequestPacingWaits ?? 0;
    expect(waits).toBeGreaterThan(0);
    const pacing = notices.filter((notice) => notice.kind === 'SERVICE_REQUEST_PACING_WAIT');
    expect(pacing).toHaveLength(waits);
    expect(document.authentication?.serviceRequestPacingWaitMs).toBe(pacing.reduce((sum, { waitMs }) => sum + waitMs, 0));
    expect(outcome.summary.authentication).toEqual(document.authentication);
  }, TEST_TIMEOUT_MS);
});
