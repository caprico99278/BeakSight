// T37a fix round 1（Task 37 の設計書 3.1 の「書き込みのジョブ」。T37a の報告の発見事項 1 への設計者の判断）: 書き込みのジョブ（`executeWriteCreateRun`）に、
// ワーカーと同じく監査の段の口（`auditStage`）つきの認証の指定を渡したとき、送信の前に「ログインの状態の鍵が消えた」か「承認したサービスの Origin への
// 要求の上限に届いた」なら、送らずに今の「送っていない」の終わり方（`NOT_SENT`・`PRECHECK_FAILED`）になる。判定は Run Coordinator・発見・READ の
// 確かめと同じ共通の部品（`sessionKeyLostDetailOf`。LZ-3c: 上限の判定 `isServiceRequestLimitReached` は、いつも偽なので捨てた）。成果物の形は変えない。
// - 書き込みの画面は、自前の 127.0.0.1 の fixture（`tests/helpers/write-site-fixture.ts`）。サービスの Origin の代わりに、別の 127.0.0.1 のサーバを
//   承認したサービスの Origin にし、登録の画面のページの JS がそこへ GET を送る（`setServiceReads`）。
// - 比べの回（上限の中、鍵あり）は送る（POST 1）。鍵の消失は、ログインの状態の鍵の判定の口（`sessionKeyPresent`）が偽を返す形（ログアウトの代わり）。
// - サービスの要求の上限は L11 で撤廃した（撤廃の確かめは `job-audit-stage-limit.test.ts`・`guard-audit-stage.test.ts`）。
// 届いた POST は、fixture のサーバの記録で数える（全部の後に、名前つきの時間だけ待ってから数え直す）。Chromium はテストの既定の headless。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { DEFAULT_CHROMIUM_LAUNCHERS } from '../helpers/chromium.js';
import { settleLateDeliveries, startLoopbackHttpServer, type LoopbackHttpServer } from '../helpers/loopback-server.js';
import { TEST_FACTORY_OPTIONS, createTestConfig } from '../helpers/test-config.js';
import { TEST_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { WRITE_SITE_PATHS, WRITE_SITE_SESSION_COOKIE, startWriteSite, type WriteSite } from '../helpers/write-site-fixture.js';

const TEST_TIMEOUT_MS = 180_000;
const NAVIGATION_INTERVAL_MS = 300;
const RESULT_TIMEOUT_MS = 3_000;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_DELIVERY_SETTLE_MS = 2_000;
const VIEWPORT = Object.freeze({ width: 1280, height: 800 });
/** 登録の画面を開くたびに、ページの JS がサービスの Origin へ送る GET の数。 */
const SERVICE_READS_PER_LOAD = 10;
const NAME_VALUE = '上限 太郎';
/** SHA-256 の 16 進の桁の数。 */
const SHA256_HEX_LENGTH = 64;
const UNMATCHED_DIGEST = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;

describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T37a fix round 1: the write job stops before sending at the session key loss and the service request limit with %s', (_label, launch) => {
  let browser: Browser;
  let site: WriteSite;
  let service: LoopbackHttpServer;
  let sessionValue: string;
  let outputDirectory: string;
  let formCandidate: DiscoveryCandidate;
  let searchCandidate: DiscoveryCandidate;
  let runCount = 0;

  const configFor = (): AuditConfig => createTestConfig(site.origin, WRITE_SITE_PATHS.form, {
    crawl: { minNavigationIntervalMs: NAVIGATION_INTERVAL_MS },
    audit: { screenshots: false },
    output: { directory: join(outputDirectory, `run-${runCount}`) },
  });

  const authenticationFor = (sessionKeyPresent: () => boolean): RunAuthentication => {
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [service.origin],
      auditReadRequests: [],
      scriptLogin: { origin: service.origin, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
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
      response.writeHead(HTTP_OK, { ...cors, 'content-type': 'application/json' }).end('{"n":1}');
    });
    outputDirectory = await mkdtemp(join(tmpdir(), 'beaksight-write-job-audit-stage-'));
    // 本物の発見の入口で、書き込みの画面の候補を読む（承認に縛る digest を手で書かない）。
    const factory = new BrowserContextFactory(browser, configFor(), () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: authenticatedContextOptions({ ...authenticationFor(() => true), auditStage: undefined }),
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
      resultJudgement: 'FORM_STRUCTURE',
      recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [`${WRITE_SITE_PATHS.create}/{id}`] },
    },
    readVerification: readVerificationOf(verified),
    approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: 'example-write', scenarioId: 'scenario-w', scenarioRevision: 1, grantId: 'grant-w' }),
  });

  /** 書き込みのジョブを 1 回動かし、`action-run.json`（スキーマで確かめた）と、送信の報告と、この回にサーバへ届いた POST の数を返す。 */
  const runWrite = async (authentication: RunAuthentication, verified = false): Promise<{
    readonly document: ActionRunDocument;
    readonly reports: readonly WorkerWriteSubmissionReport[];
    readonly posts: number;
  }> => {
    runCount += 1;
    const before = site.postBodies.length;
    const reports: WorkerWriteSubmissionReport[] = [];
    const outcome = await executeWriteCreateRun({
      config: configFor(), jobId: `job-write-${runCount}`, authentication, write: writeSpec(verified), launchBrowser: launch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      recheck: () => Promise.resolve({ allowed: true }), reportSubmission: (report) => reports.push(report), resultTimeoutMs: RESULT_TIMEOUT_MS,
      observationWindows: TEST_OBSERVATION_WINDOWS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the write run did not run: ${outcome.kind}`);
    }
    // TEST-TIME-B（案 9）: Browser を閉じた後なので、受けている途中の要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(LATE_DELIVERY_SETTLE_MS, site, service);
    const document: unknown = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8'));
    expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
    return { document: document as ActionRunDocument, reports, posts: site.postBodies.length - before };
  };

  const NOT_SENT = { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' } as const;

  it('does not send when the login state key disappeared before the write stage', async () => {
    const run = await runWrite(authenticationFor(() => false));
    expect(run.document).toMatchObject(NOT_SENT);
    expect(run.reports).toEqual([NOT_SENT]);
    expect(run.posts).toBe(0);
  }, TEST_TIMEOUT_MS);

  // PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1 の「事前の確かめ」）: 送る前に答え合わせの READ を読み、判定できなければ送らない
  // （`VERIFICATION_READ_UNAVAILABLE`）。送る回の比べは、読める照合の READ の定義（`verified`）で行う。この回は、鍵の消失の回の比べ（鍵あり）も兼ねる。
  // T37R-fix-B（T37R の M-3）: 照合の READ にも、判定できない決まり（`UNDETERMINED`）を当てる。照合の READ の画面の読み込みで、同じ Origin の fetch の
  // POST（データを取る形）を Guard が止めたら、照らした結果に関係なく `UNDETERMINED` になり、書き込みの結果は今の「照合できない」の写し
  // （`PARTIAL`・`READ_VERIFICATION_UNDETERMINED`）。比べの回（止めた要求なし）は `VERIFIED`。
  it('verifies the write by the READ without blocked requests (the comparison of M-3)', async () => {
    const run = await runWrite(authenticationFor(() => true), true);
    expect(run.document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', readVerification: { result: 'MATCHED' } });
    expect(run.posts).toBe(1);
  }, TEST_TIMEOUT_MS);

  // T37R-fix-B2（設計書 8 章の最後の行）: 許可 Origin（同じ Origin）への fetch・xhr の止めた要求は、数えて残すだけで判定に使わない。そのため M-3 の
  // 決まりの確かめは、判定に使う事実（止めたサービスの Origin への読み取りでない要求）で行う。
  // PL-6a: 送る前の答え合わせの READ にも同じ決まりを当てる。同じ一覧の画面を、送る前にも読むので、送る前の答え合わせが判定できず、送らずに止める
  // （`BLOCKED`・`PRECHECK_FAILED`・`VERIFICATION_READ_UNAVAILABLE`。前は送ってから照合できない `PARTIAL`。送らない側に変わった）。
  it('makes the verification READ UNDETERMINED when the list page POST to the service origin was blocked (M-3)', async () => {
    site.setListDataRequest(true, service.origin);
    const run = await runWrite(authenticationFor(() => true), true);
    expect(run.document).toMatchObject({
      ...NOT_SENT, precheckDetail: 'VERIFICATION_READ_UNAVAILABLE', result: 'BLOCKED', readVerification: null,
    });
    expect(run.reports).toEqual([NOT_SENT]);
    expect(run.posts).toBe(0);
  }, TEST_TIMEOUT_MS);

  // T37R-fix-B2: 今の振る舞いの固定。一覧の画面の同じ Origin の fetch の POST を Guard が止めても、照合の READ は判定できないことにはならず、照らした
  // 結果のまま（この画面はサーバが行を描くため `MATCHED`）。
  it('keeps the verification READ judged by its rows when only the same origin fetch POST was blocked (B2)', async () => {
    site.setListDataRequest(true);
    const run = await runWrite(authenticationFor(() => true), true);
    expect(run.document).toMatchObject({ submission: 'SENT', result: 'VERIFIED', readVerification: { result: 'MATCHED' } });
    expect(run.posts).toBe(1);
  }, TEST_TIMEOUT_MS);
});
