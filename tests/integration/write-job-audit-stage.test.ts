// T37a fix round 1（Task 37 の設計書 3.1 の「書き込みのジョブ」。T37a の報告の発見事項 1 への設計者の判断）: 書き込みのジョブ（`executeWriteCreateRun`）に、
// ワーカーと同じく監査の段の口（`auditStage`）つきの認証の指定を渡したとき、送信の前に「ログインの状態の鍵が消えた」か「承認したサービスの Origin への
// 要求の上限に届いた」なら、送らずに今の「送っていない」の終わり方（`NOT_SENT`・`PRECHECK_FAILED`）になる。判定は Run Coordinator・発見・READ の
// 確かめと同じ共通の部品（`sessionKeyLostDetailOf`・`isServiceRequestLimitReached`）。成果物の形は変えない。
// - 書き込みの画面は、自前の 127.0.0.1 の fixture（`tests/helpers/write-site-fixture.ts`）。サービスの Origin の代わりに、別の 127.0.0.1 のサーバを
//   承認したサービスの Origin にし、登録の画面のページの JS がそこへ GET を送る（`setServiceReads`）。
// - 比べの回（上限の中、鍵あり）は送る（POST 1）。鍵の消失は、ログインの状態の鍵の判定の口（`sessionKeyPresent`）が偽を返す形（ログアウトの代わり）。
// - 上限は、画面の確かめの読み込みで届く回（書き込みの段を開く前に止める）。書き込みの段の読み込みは、サービスの Origin へ送らないので、上限を動かさない
//   （確かめの回）。押す直前の確かめも置いてある（同じ部品）。
// 届いた POST は、fixture のサーバの記録で数える（全部の後に、名前つきの時間だけ待ってから数え直す）。Chromium はテストの既定の headless と、CLI の起動の
// 設定の両方。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartWrite } from '../../src/control/worker-protocol.js';
import { ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { readCandidatePage } from '../../src/discovery/read-executor.js';
import { InFlightRequestCounter } from '../../src/discovery/settle.js';
import { authenticatedContextOptions, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeWriteCreateRun } from '../../src/worker/write-create-run.js';
import type { WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { WRITE_SITE_PATHS, WRITE_SITE_SESSION_COOKIE, startWriteSite, type WriteSite } from '../helpers/write-site-fixture.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 180_000;
const NAVIGATION_INTERVAL_MS = 300;
const RESULT_TIMEOUT_MS = 3_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
/** 登録の画面を開くたびに、ページの JS がサービスの Origin へ送る GET の数。 */
const SERVICE_READS_PER_LOAD = 10;
/** 上限の中で終わる上限（比べの回と鍵の消失の回）。 */
const WIDE_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
/** 画面の確かめの読み込み（書き込みの段を開く前）で届く上限。 */
const BEFORE_STAGE_LIMITS = Object.freeze({ perMinute: 120, perRun: 2 });
/** 画面の確かめの読み込みでは届かない上限（書き込みの段の読み込みがサービスの Origin へ送れば届く数）。 */
const WITHIN_CHECK_LIMITS = Object.freeze({ perMinute: 120, perRun: SERVICE_READS_PER_LOAD + 2 });
const NAME_VALUE = '上限 太郎';
/** SHA-256 の 16 進の桁の数。 */
const SHA256_HEX_LENGTH = 64;
const UNMATCHED_DIGEST = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

describe.each(LAUNCHERS)('T37a fix round 1: the write job stops before sending at the session key loss and the service request limit with %s', (_label, launch) => {
  let browser: Browser;
  let site: WriteSite;
  let service: LoopbackHttpServer;
  let sessionValue: string;
  let outputDirectory: string;
  let formCandidate: DiscoveryCandidate;
  let searchCandidate: DiscoveryCandidate;
  let runCount = 0;
  /** サービスの Origin の代わりのサーバに届いた GET の数（事前確認を除く）。 */
  let serviceGets = 0;

  const configFor = (): AuditConfig => createTestConfig(site.origin, WRITE_SITE_PATHS.form, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false },
    output: { directory: join(outputDirectory, `run-${runCount}`) },
  });

  const authenticationFor = (
    limits: { readonly perMinute: number; readonly perRun: number },
    sessionKeyPresent: () => boolean,
  ): RunAuthentication => {
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      serviceRequestLimits: limits,
    };
    return {
      initialState: {
        cookies: [{
          name: WRITE_SITE_SESSION_COOKIE, value: sessionValue, domain: new URL(site.origin).hostname, path: '/', expires: -1, httpOnly: true,
          secure: false, sameSite: 'Lax',
        }],
        origins: [],
      },
      approvedTestOrigins: [site.origin],
      auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: WRITE_SITE_PATHS.login,
      filterState: filterAuthenticatedState,
      auditStage,
      sessionKeyPresent,
    };
  };

  beforeAll(async () => {
    browser = await launch();
    site = await startWriteSite();
    sessionValue = site.issueSession();
    service = await startLoopbackHttpServer((request: IncomingMessage, response: ServerResponse) => {
      const cors = {
        'access-control-allow-origin': typeof request.headers.origin === 'string' ? request.headers.origin : '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET',
      };
      if (request.method === 'OPTIONS') {
        response.writeHead(HTTP_NO_CONTENT, cors).end();
        return;
      }
      serviceGets += 1;
      response.writeHead(HTTP_OK, { ...cors, 'content-type': 'application/json' }).end('{"n":1}');
    });
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-write-job-audit-stage-'));
    // 本物の発見の入口で、書き込みの画面の候補を読む（承認に縛る digest を手で書かない）。
    const factory = new BrowserContextFactory(browser, configFor(), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: authenticatedContextOptions({ ...authenticationFor(WIDE_LIMITS, () => true), auditStage: undefined }),
    });
    const readPage = async (path: string): Promise<readonly DiscoveryCandidate[]> => {
      const context = await factory.createPassiveContext(VIEWPORT);
      const page = await factory.createPassivePage(context);
      const counter = new InFlightRequestCounter(page);
      await page.goto(`${site.origin}${path}`);
      const read = await readCandidatePage(page, { classificationPolicy: { allowedOrigins: new Set([site.origin]) }, requestCounter: counter });
      counter.dispose();
      await factory.closePassiveContext(context);
      return read.candidates;
    };
    const form = (await readPage(WRITE_SITE_PATHS.form)).find((candidate) => candidate.formMethod === 'POST' && candidate.action?.path === WRITE_SITE_PATHS.create);
    // T37R-fix-B（M-3）: 照合の READ の対象（一覧の検索の form）。
    const search = (await readPage(WRITE_SITE_PATHS.list)).find((candidate) => candidate.formMethod === 'GET' && candidate.classification === 'READ');
    await factory.close();
    if (form === undefined || search === undefined) {
      throw new Error('the fixture candidates were not found');
    }
    formCandidate = form;
    searchCandidate = search;
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await service?.close();
    await rm(outputDirectory, { recursive: true, force: true });
  });

  beforeEach(() => {
    site.setMode('success');
    site.setServiceReads(service.origin, SERVICE_READS_PER_LOAD);
    site.setListDataRequest(false);
  });

  /** 照合の READ の定義（`verified` なら、一覧の検索で登録した名前の行を 1 行と照らす。ほかは、どの候補にも当たらない定義）。 */
  const readVerificationOf = (verified: boolean): WorkerStartWrite['readVerification'] => ({
    readCheckId: 'rc-verify',
    readCheckRevision: 1,
    targetPage: { origin: site.origin, path: WRITE_SITE_PATHS.list },
    definition: verified
      ? { targetIdentityDigest: searchCandidate.identityDigest, parameters: { q: `${NAME_VALUE} ${runCount}` }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }] }
      : { targetIdentityDigest: UNMATCHED_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
  });

  const writeSpec = (verified = false): WorkerStartWrite => ({
    scenarioId: 'scenario-w',
    scenarioRevision: 1,
    grantId: 'grant-w',
    profileId: 'example-write',
    seedRecord: {
      seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
      seedInput: {
        profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
        executionGrantId: 'grant-w',
      },
      baseDate: '2026-10-17',
      attempt: 0,
    },
    request: { formMethod: 'POST', methodOverride: null, origin: site.origin, path: WRITE_SITE_PATHS.create, enctype: 'application/x-www-form-urlencoded' },
    formPage: { origin: formCandidate.page.origin, path: formCandidate.page.path },
    candidate: { identityDigest: formCandidate.identityDigest, ruleDigest: formCandidate.ruleDigest },
    candidateFields: formCandidate.fields.map(({ name, type, readonly, hidden, disabled }) => ({ name, type, readonly, hidden, disabled })),
    values: { name: `${NAME_VALUE} ${runCount}` },
    verification: {
      successCondition: { pathPrefix: `${WRITE_SITE_PATHS.create}/`, selector: '.registered' },
      inputErrorCondition: { pathPrefix: WRITE_SITE_PATHS.create, selector: '.error' },
      recordId: { source: 'URL_PATH_PATTERN', pathPattern: `${WRITE_SITE_PATHS.create}/{id}` },
    },
    readVerification: readVerificationOf(verified),
    approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, grantId: 'grant-w' }),
  });

  /** 書き込みのジョブを 1 回動かし、`action-run.json`（スキーマで確かめた）と、送信の報告と、この回にサーバへ届いた POST の数を返す。 */
  const runWrite = async (authentication: RunAuthentication, verified = false): Promise<{
    readonly document: ActionRunDocument;
    readonly reports: readonly WorkerWriteSubmissionReport[];
    readonly posts: number;
    readonly serviceGets: number;
  }> => {
    runCount += 1;
    const before = site.postBodies.length;
    const serviceBefore = serviceGets;
    const reports: WorkerWriteSubmissionReport[] = [];
    const outcome = await executeWriteCreateRun({
      config: configFor(), jobId: `job-write-${runCount}`, authentication, write: writeSpec(verified), launchBrowser: launch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      recheck: () => Promise.resolve({ allowed: true }), reportSubmission: (report) => reports.push(report), resultTimeoutMs: RESULT_TIMEOUT_MS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the write run did not run: ${outcome.kind}`);
    }
    await wait(LATE_DELIVERY_SETTLE_MS);
    const document: unknown = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8'));
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
    return { document: document as ActionRunDocument, reports, posts: site.postBodies.length - before, serviceGets: serviceGets - serviceBefore };
  };

  const NOT_SENT = { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' } as const;

  it('sends within the limit with the key (the comparison)', async () => {
    const run = await runWrite(authenticationFor(WIDE_LIMITS, () => true));
    expect(run.document.submission).toBe('SENT');
    expect(run.posts).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('does not send when the login state key disappeared before the write stage', async () => {
    const run = await runWrite(authenticationFor(WIDE_LIMITS, () => false));
    expect(run.document).toMatchObject(NOT_SENT);
    expect(run.reports).toEqual([NOT_SENT]);
    expect(run.posts).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('does not send when the service request limit was reached by the form page check', async () => {
    const run = await runWrite(authenticationFor(BEFORE_STAGE_LIMITS, () => true));
    expect(run.serviceGets).toBeLessThanOrEqual(BEFORE_STAGE_LIMITS.perRun);
    expect(run.document).toMatchObject(NOT_SENT);
    expect(run.reports).toEqual([NOT_SENT]);
    expect(run.posts).toBe(0);
  }, TEST_TIMEOUT_MS);

  // T37R-fix-B（T37R の M-3）: 照合の READ にも、判定できない決まり（`UNDETERMINED`）を当てる。照合の READ の画面の読み込みで、同じ Origin の fetch の
  // POST（データを取る形）を Guard が止めたら、照らした結果に関係なく `UNDETERMINED` になり、書き込みの結果は今の「照合できない」の写し
  // （`PARTIAL`・`READ_VERIFICATION_UNDETERMINED`）。比べの回（止めた要求なし）は `VERIFIED`。
  it('verifies the write by the READ without blocked requests (the comparison of M-3)', async () => {
    const run = await runWrite(authenticationFor(WIDE_LIMITS, () => true), true);
    expect(run.document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', readVerification: { result: 'MATCHED' } });
    expect(run.posts).toBe(1);
  }, TEST_TIMEOUT_MS);

  // T37R-fix-B2（設計書 8 章の最後の行）: 許可 Origin（同じ Origin）への fetch・xhr の止めた要求は、数えて残すだけで判定に使わない。そのため M-3 の
  // 決まりの確かめは、判定に使う事実（止めたサービスの Origin への読み取りでない要求）で行う。
  it('makes the verification READ UNDETERMINED when the list page POST to the service origin was blocked (M-3)', async () => {
    site.setListDataRequest(true, service.origin);
    const run = await runWrite(authenticationFor(WIDE_LIMITS, () => true), true);
    expect(run.document).toMatchObject({
      submission: 'SENT', result: 'PARTIAL', reason: 'READ_VERIFICATION_UNDETERMINED', readVerification: { result: 'UNDETERMINED' },
    });
    expect(run.posts).toBe(1);
  }, TEST_TIMEOUT_MS);

  // T37R-fix-B2: 今の振る舞いの固定。一覧の画面の同じ Origin の fetch の POST を Guard が止めても、照合の READ は判定できないことにはならず、照らした
  // 結果のまま（この画面はサーバが行を描くため `MATCHED`）。
  it('keeps the verification READ judged by its rows when only the same origin fetch POST was blocked (B2)', async () => {
    site.setListDataRequest(true);
    const run = await runWrite(authenticationFor(WIDE_LIMITS, () => true), true);
    expect(run.document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', readVerification: { result: 'MATCHED' } });
    expect(run.posts).toBe(1);
  }, TEST_TIMEOUT_MS);

  // 書き込みの段の Context は、承認したサービスの Origin へ送らない（Guard が止める。上限の部品にも数えない）。そのため、上限は書き込みの段の読み込みでは
  // 動かず、書き込みの段を開く前の確かめで足りる（T37a fix round 1 の報告）。画面の確かめの読み込みの分だけが届き、上限の中なら送る。
  it('sends no service request from the write stage, so the limit stays as it was after the form page check', async () => {
    const run = await runWrite(authenticationFor(WITHIN_CHECK_LIMITS, () => true));
    expect(run.serviceGets).toBe(SERVICE_READS_PER_LOAD);
    expect(run.document.submission).toBe('SENT');
    expect(run.posts).toBe(1);
  }, TEST_TIMEOUT_MS);
});
