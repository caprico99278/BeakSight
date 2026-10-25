// T37d（Task 37 の設計書 3.5、6 章の 5。設計者の判断「止めた読み取りの数の扱い」）: 画面の path を対象にした READ と、判定できない読み込みの
// `UNDETERMINED`。本物の factory と Guard。Chromium はテストの既定の headless と、CLI の起動の設定の両方。
// - データを後から API で描く SPA の画面（`startSpaAuthSite`）を、画面の path の定義で読む: 一覧の行の数と文字、詳細の項目が期待どおりなら `MATCHED`、
//   違えば `NOT_MATCHED`。1 定義あたり読み込み 1 回。アプリの Origin への計測の送信（止める）は数えない。
// - サービスの Origin の 401、上限で断った要求、承認したサービスの Origin への読み取りでない要求（登録していない手続きの呼び出し）を止めた画面は、
//   照らした結果に関係なく `UNDETERMINED`（`NOT_MATCHED` にならない）。
// - 今の候補の READ（GET の form の候補）でも、READ の URL の読み込みで上限で断った要求か 401 があれば `UNDETERMINED`（自前の 127.0.0.1 のサーバ）。
// - サーバに届いた読み取りでない要求は、登録した読み取りの手続きの呼び出しのほかは 0（サーバの記録で数え、各ジョブの後に名前つきの時間だけ待って
//   数え直す）。値は出力しない。
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadCheckExpectation } from '../../src/discovery/read-check-contracts.js';
import type { ReadCheckEvidence, ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_MEMBER_DETAIL_TERMS,
  spaMemberDetailPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
/** 各ジョブの後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const MAX_PAGES = 4;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
/** 1 回の読み込みで、テナントの手続きの呼び出し（1 件）だけを通す上限（一覧の読み取りは断られる）。 */
const ONE_REQUEST_LIMITS = Object.freeze({ perMinute: 1, perRun: 1 });
const ONE_PER_LOAD = 1;
/** 期限の切れた token（401 を受ける）の有効期限（ms）。 */
const EXPIRED_TOKEN_LIFETIME_MS = 1;
const FIRST_NAME = '一覧花子';
const SECOND_NAME = '一覧太郎';
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const TENANT_READS: readonly string[] = [SPA_BACKEND_PATHS.rpcResolveTenant];
const ADMIN = SPA_APP_PATHS.admin;
const DETAIL = spaMemberDetailPathOf(1);
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

/** 結果の要約（定義の ID → 結果と詳しい理由。確かめなかった定義は理由）。 */
const outcomesOf = (document: ReadEvidenceDocument): Readonly<Record<string, string>> => Object.fromEntries(document.checks.map((check: ReadCheckEvidence) =>
  [check.readCheckId, check.state === 'EXECUTED' ? `${check.result}/${check.detail}` : `NOT_EXECUTED/${check.reason}`]));

describe.each(LAUNCHERS)('T37d: the READ check of a page path on the SPA fixture with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-read-check-page-'));
  });

  afterEach(async () => {
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const startSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite({ memberDetailPage: true, ...options });
    spa.addMember(FIRST_NAME);
    spa.addMember(SECOND_NAME);
    return spa;
  };

  const setup = (
    site: SpaAuthSite,
    reads: readonly string[],
    limits: AuditStageServiceRequests['serviceRequestLimits'] = DEFAULT_LIMITS,
  ): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
    runCount += 1;
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
      approvedTestOrigins: [site.appOrigin],
      auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage: {
        approvedServiceOrigins: [site.backendOrigin],
        auditReadRequests: reads.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerPageLoad: ONE_PER_LOAD })),
        scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
        serviceRequestLimits: limits,
      },
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(site.appOrigin, ADMIN, {
      target: { id: `read-page-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    });
    return { config: { ...base, site: { startUrl: `${site.appOrigin}${ADMIN}`, allowedOrigins: [site.appOrigin] } }, authentication };
  };

  /** 画面の path の定義。 */
  const pageCheck = (site: SpaAuthSite, readCheckId: string, path: string, expectations: readonly ReadCheckExpectation[]): WorkerStartReadCheck => ({
    readCheckId,
    readCheckRevision: 1,
    targetPage: { origin: site.appOrigin, path },
    definition: { targetPagePath: path, parameters: {}, expectations: [...expectations] },
  });

  /** READ の確かめのジョブを動かし、成果物をスキーマで確かめて返す。 */
  const run = async (
    site: SpaAuthSite,
    readChecks: readonly WorkerStartReadCheck[],
    reads: readonly string[],
    limits?: AuditStageServiceRequests['serviceRequestLimits'],
  ): Promise<ReadEvidenceDocument> => {
    const { config, authentication } = setup(site, reads, limits);
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-page-${runCount}`, authentication, readChecks, launchBrowser: launch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    const document: unknown = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8'));
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    return document as ReadEvidenceDocument;
  };

  /** サーバに届いた、読み取りでない（GET・HEAD・事前確認でない）要求のうち、登録した手続きの呼び出しでないもの。 */
  const unexpectedNonReads = (site: SpaAuthSite, reads: readonly string[]): readonly string[] => {
    const allowed = new Set(reads.map((path) => `backend POST ${path}`));
    return site.requests
      .filter((request) => !request.preflight && !READ_METHODS.has(request.method))
      .map(({ origin, method, path }) => `${origin} ${method} ${path}`)
      .filter((request) => !allowed.has(request));
  };
  /** アプリの画面の読み込みの数（path ごと）。 */
  const appLoadsOf = (site: SpaAuthSite, path: string): number =>
    site.requests.filter((request) => request.origin === 'app' && request.method === 'GET' && request.path === path).length;

  it('reads a page that draws its data later through the API and says MATCHED, once per definition', async () => {
    // テナントの手続きの呼び出しが要る形（登録して通す）と、アプリの Origin への計測の送信（Guard が止める。判定には数えない）。
    const site = await startSite({ preLoginRpc: 'required', rumBeacon: true });
    const document = await run(site, [
      pageCheck(site, 'read-list', ADMIN, [{ kind: 'ROW_COUNT_EQUALS', count: 2 }, { kind: 'TEXT_CONTAINS', text: SECOND_NAME }]),
      pageCheck(site, 'read-detail', DETAIL, [{ kind: 'DETAIL_FIELD_EQUALS', field: SPA_MEMBER_DETAIL_TERMS.name, value: FIRST_NAME }]),
    ], TENANT_READS);
    expect(outcomesOf(document)).toEqual({ 'read-list': 'MATCHED/EXPECTATIONS_EVALUATED', 'read-detail': 'MATCHED/EXPECTATIONS_EVALUATED' });
    expect(document.runStatus).toBe('COMPLETE');
    expect(document.checks.map((check) => [check.targetKind, check.targetPagePath, check.targetIdentityDigest]))
      .toEqual([['PAGE', ADMIN, undefined], ['PAGE', DETAIL, undefined]]);
    // 1 定義あたり読み込み 1 回（候補の画面の読み込みはしない）。
    expect([appLoadsOf(site, ADMIN), appLoadsOf(site, DETAIL)]).toEqual([1, 1]);
    expect(document.authentication?.registeredReadRequestsAllowed).toBeGreaterThan(0);
    expect(document.authentication?.otherNonReadBlocked).toBeGreaterThan(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(unexpectedNonReads(site, TENANT_READS)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('says NOT_MATCHED when the drawn data differs from the expectations', async () => {
    const site = await startSite({});
    const document = await run(site, [
      pageCheck(site, 'read-list', ADMIN, [{ kind: 'ROW_COUNT_EQUALS', count: 5 }]),
      pageCheck(site, 'read-detail', DETAIL, [{ kind: 'DETAIL_FIELD_EQUALS', field: SPA_MEMBER_DETAIL_TERMS.name, value: SECOND_NAME }]),
    ], []);
    expect(outcomesOf(document)).toEqual({ 'read-list': 'NOT_MATCHED/EXPECTATIONS_EVALUATED', 'read-detail': 'NOT_MATCHED/EXPECTATIONS_EVALUATED' });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(unexpectedNonReads(site, [])).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('says UNDETERMINED, not NOT_MATCHED, for a page that could not draw its data because of a 401 of the service', async () => {
    const site = await startSite({ tokenLifetimeMs: EXPIRED_TOKEN_LIFETIME_MS });
    const document = await run(site, [
      pageCheck(site, 'read-list', ADMIN, [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }]),
      pageCheck(site, 'read-detail', DETAIL, [{ kind: 'TEXT_CONTAINS', text: FIRST_NAME }]),
    ], []);
    expect(outcomesOf(document)).toEqual({ 'read-list': 'UNDETERMINED/SERVICE_READ_REFUSED', 'read-detail': 'UNDETERMINED/SERVICE_READ_REFUSED' });
    // 照らした結果（データが描かれていない）は残す。
    const [list] = document.checks;
    expect(list?.state === 'EXECUTED' ? list.expectations.map(({ result }) => result) : []).toEqual(['NOT_MATCHED']);
    expect(document.authentication?.serviceUnauthorizedResponses).toBeGreaterThan(0);
    expect(document.runStatus).toBe('PARTIAL');
    await wait(LATE_REQUEST_WAIT_MS);
    expect(unexpectedNonReads(site, [])).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('says UNDETERMINED for a page whose service read was refused by the limit, and reads no more definitions', async () => {
    const site = await startSite({ preLoginRpc: 'required' });
    const document = await run(site, [
      pageCheck(site, 'read-list', ADMIN, [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }]),
      pageCheck(site, 'read-detail', DETAIL, [{ kind: 'TEXT_CONTAINS', text: FIRST_NAME }]),
    ], TENANT_READS, ONE_REQUEST_LIMITS);
    expect(outcomesOf(document)).toEqual({ 'read-list': 'UNDETERMINED/SERVICE_READ_REFUSED', 'read-detail': 'NOT_EXECUTED/SERVICE_REQUEST_LIMIT_REACHED' });
    expect(document.endReason).toBe('SERVICE_REQUEST_LIMIT_REACHED');
    expect(document.authentication?.serviceRequestLimitReached).toBe(true);
    expect(appLoadsOf(site, DETAIL)).toBe(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.origin === 'backend' && !request.preflight).length).toBeLessThanOrEqual(ONE_REQUEST_LIMITS.perRun);
    expect(unexpectedNonReads(site, TENANT_READS)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T37d fix round 1（T37d の発見事項 6）: 登録した読み取りの手続きの呼び出しを、1 回の読み込みあたりの回数の上限で止めた画面（データは描けていても、
  // 照らした結果に関係なく判定しない）。
  it('says UNDETERMINED for a page whose registered call of a read procedure went over the limit of one load', async () => {
    const listReads: readonly string[] = [SPA_BACKEND_PATHS.rpcListMembers];
    const site = await startSite({ rpcReads: true, repeatedListRpc: true });
    const document = await run(site, [pageCheck(site, 'read-list', ADMIN, [{ kind: 'ROW_COUNT_EQUALS', count: 2 }])], listReads);
    expect(outcomesOf(document)).toEqual({ 'read-list': 'UNDETERMINED/AUDIT_STAGE_REQUEST_BLOCKED' });
    const [list] = document.checks;
    expect(list?.state === 'EXECUTED' ? list.expectations.map(({ result }) => result) : []).toEqual(['MATCHED']);
    await wait(LATE_REQUEST_WAIT_MS);
    // 登録した呼び出しは、上限の 1 回だけ届いた。ほかの読み取りでない要求は届いていない。
    expect(site.requests.filter((request) => request.origin === 'backend' && !request.preflight && request.method === 'POST'
      && request.path === SPA_BACKEND_PATHS.rpcListMembers).length).toBe(ONE_PER_LOAD);
    expect(unexpectedNonReads(site, listReads)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('says UNDETERMINED for a page whose unregistered call of a read procedure of the service was blocked', async () => {
    // 一覧を手続きの呼び出しで読む形（登録していないので、Guard が止める）。
    const site = await startSite({ rpcReads: true });
    const document = await run(site, [pageCheck(site, 'read-list', ADMIN, [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }])], []);
    expect(outcomesOf(document)).toEqual({ 'read-list': 'UNDETERMINED/AUDIT_STAGE_REQUEST_BLOCKED' });
    expect(document.authentication?.otherNonReadBlocked).toBeGreaterThan(0);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(unexpectedNonReads(site, [])).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

// 今の候補の READ（GET の form の候補）: READ の URL の画面が、承認したサービスの Origin から 2 件を読んで描く。2 件とも読めたときだけ一覧を描く。
const LIST_PATH = '/admin/list';
const SEARCH_PATH = '/admin/search';
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const SERVICE_ITEMS_PATH = '/rest/v1/items';

interface ServerRecord {
  readonly server: 'app' | 'service';
  readonly method: string;
}

describe.each(LAUNCHERS)('T37d: the UNDETERMINED rule of the READ check of a candidate with %s', (_label, launch) => {
  let app: LoopbackHttpServer;
  let service: LoopbackHttpServer;
  let workDirectory = '';
  let runCount = 0;
  let serviceStatus = HTTP_OK;
  const records: ServerRecord[] = [];

  const appPageOf = (pathname: string): string => (pathname === SEARCH_PATH
    ? `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>検索</title></head><body><main><h1>検索</h1>
<form method="get" action="${LIST_PATH}"><label>語 <input name="q"></label><button type="submit">表示</button></form></main></body></html>`
    : `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>一覧</title></head><body><main><h1>一覧</h1><ul id="items"></ul>
<script>Promise.all([1, 2].map((n) => fetch('${service.origin}${SERVICE_ITEMS_PATH}?n=' + n).then((r) => { if (!r.ok) throw new Error('x'); return r.json(); })))
.then((all) => { for (const item of all) { const li = document.createElement('li'); li.textContent = item.name; document.getElementById('items').append(li); } })
.catch(() => undefined);</script></main></body></html>`);

  const listenerOf = (server: ServerRecord['server']) => (request: IncomingMessage, response: ServerResponse): void => {
    request.on('data', () => undefined);
    request.on('end', () => {
      const preflight = request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;
      if (!preflight) {
        records.push({ server, method: request.method ?? '' });
      }
      const cors = { 'access-control-allow-origin': typeof request.headers.origin === 'string' ? request.headers.origin : '*' };
      if (request.method === 'OPTIONS') {
        response.writeHead(HTTP_NO_CONTENT, cors).end();
      } else if (server === 'app') {
        const { pathname } = new URL(request.url ?? '/', app.origin);
        response.writeHead(HTTP_OK, { 'content-type': 'text/html; charset=utf-8' }).end(appPageOf(pathname));
      } else {
        response.writeHead(serviceStatus, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ name: '品目' }));
      }
    });
  };

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-read-check-candidate-'));
    service = await startLoopbackHttpServer(listenerOf('service'));
    app = await startLoopbackHttpServer(listenerOf('app'));
  });

  afterAll(async () => {
    await Promise.all([app?.close(), service?.close()]);
    await rm(workDirectory, { recursive: true, force: true });
  });

  const setup = (limits: AuditStageServiceRequests['serviceRequestLimits']): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
    runCount += 1;
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [] },
      approvedTestOrigins: [app.origin],
      auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: '/auth',
      filterState: filterAuthenticatedState,
      auditStage: {
        approvedServiceOrigins: [service.origin],
        auditReadRequests: [],
        scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
        serviceRequestLimits: limits,
      },
    };
    const base = fastRunConfig(app.origin, SEARCH_PATH, {
      target: { id: `read-candidate-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: 1 },
    });
    return { config: { ...base, site: { startUrl: `${app.origin}${SEARCH_PATH}`, allowedOrigins: [app.origin] } }, authentication };
  };

  /** 発見のジョブで、検索の form の候補の識別の digest を読む。 */
  const searchCandidateDigest = async (): Promise<string> => {
    const { config, authentication } = setup(DEFAULT_LIMITS);
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    const page = document.pages.find((entry) => entry.state === 'READ');
    const candidate = page?.state === 'READ' ? page.record.candidates.find((entry) => entry.classification === 'READ') : undefined;
    if (candidate === undefined) {
      throw new Error('the search form was not discovered as READ');
    }
    return candidate.identityDigest;
  };

  const readCandidate = async (digest: string, limits: AuditStageServiceRequests['serviceRequestLimits']): Promise<ReadEvidenceDocument> => {
    const { config, authentication } = setup(limits);
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-candidate-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal,
      readChecks: [{
        readCheckId: 'read-candidate',
        readCheckRevision: 1,
        targetPage: { origin: app.origin, path: SEARCH_PATH },
        definition: { targetIdentityDigest: digest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
      }],
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    const document: unknown = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8'));
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    return document as ReadEvidenceDocument;
  };

  const nonReadsSince = (start: number): readonly string[] =>
    records.slice(start).filter(({ method }) => !READ_METHODS.has(method)).map(({ server, method }) => `${server} ${method}`);

  it('says MATCHED when both service reads are drawn, and UNDETERMINED when one of them was refused by the limit or answered 401', async () => {
    serviceStatus = HTTP_OK;
    const digest = await searchCandidateDigest();
    const start = records.length;
    const drawn = await readCandidate(digest, DEFAULT_LIMITS);
    expect(outcomesOf(drawn)).toEqual({ 'read-candidate': 'MATCHED/EXPECTATIONS_EVALUATED' });
    expect(drawn.checks[0]?.targetKind).toBe('CANDIDATE');
    // 上限（1 回の Run で 1 件）: 2 件目の読み取りを断ったので、一覧は描かれない。照らした結果に関係なく判定しない。
    const limited = await readCandidate(digest, ONE_REQUEST_LIMITS);
    expect(outcomesOf(limited)).toEqual({ 'read-candidate': 'UNDETERMINED/SERVICE_READ_REFUSED' });
    serviceStatus = HTTP_UNAUTHORIZED;
    const unauthorized = await readCandidate(digest, DEFAULT_LIMITS);
    expect(outcomesOf(unauthorized)).toEqual({ 'read-candidate': 'UNDETERMINED/SERVICE_READ_REFUSED' });
    serviceStatus = HTTP_OK;
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReadsSince(start)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
