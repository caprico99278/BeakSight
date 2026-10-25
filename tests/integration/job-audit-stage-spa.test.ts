// T37a（Task 37 の設計書 3.1、6 章の 4）: Run Coordinator を通らないジョブ（発見 `executeDiscoveryRun`、READ の確かめ `executeReadCheckRun`、書き込み
// `executeWriteCreateRun`）に、ワーカーと同じく監査の段の口（`auditStage`）つきの認証の指定を渡したときの、SPA の fixture（`startSpaAuthSite`）での振る舞い。
// 本物の factory と Guard。Chromium はテストの既定の headless と、CLI の起動の設定の両方。
// - 発見と READ は、登録した読み取りの手続きの呼び出しを通す: テナントの手続きの呼び出しが要る形（`preLoginRpc: 'required'`、`rpcReads`）で、登録すると
//   一覧と更新の画面へのリンクが描け、発見が `/edit` の画面に届く（登録しないと届かない）。登録した呼び出しのほかの読み取りでない要求は届かない。
// - 書き込みのジョブは、登録した呼び出しを通さない（届いた POST は 0）。
// - ログインの状態の鍵が消えると、発見と READ はセッションの切れで終わり、詳しい理由は `session-key`。
// - サービスの Origin からの 401 の数が成果物に残り、その画面は読み切れなかった印（`SERVICE_READ_REFUSED`）を持つ。
// 届いたかは fixture の記録で数える。各ジョブの後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
import { readFileSync } from 'node:fs';
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
import type { WorkerStartReadCheck, WorkerStartWrite } from '../../src/control/worker-protocol.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { PAGE_SUBRESOURCE_REQUEST_LIMIT } from '../../src/safety/passive-request-guard.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { executeWriteCreateRun } from '../../src/worker/write-create-run.js';
import { sampleApprovalFacts } from '../helpers/approval-facts-sample.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  spaMemberEditPathOf,
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
const MAX_PAGES = 6;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const ONE_PER_LOAD = 1;
/** 期限の切れた token（401 を受ける）の有効期限（ms）。 */
const EXPIRED_TOKEN_LIFETIME_MS = 1;
const EXISTING_NAME = '既存花子';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
/** SHA-256 の 16 進の桁の数。 */
const SHA256_HEX_LENGTH = 64;
/** どの候補にも当たらない識別の digest（読み込みだけを起こす）。 */
const UNMATCHED_DIGEST = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`;
/** 登録する読み取りの手続きの呼び出し（テナントと一覧）。 */
const REGISTERED_READS: readonly string[] = [SPA_BACKEND_PATHS.rpcResolveTenant, SPA_BACKEND_PATHS.rpcListMembers];
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

describe.each(LAUNCHERS)('T37a: the audit stage of the discovery, READ check and write jobs on the SPA fixture with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-job-audit-stage-spa-'));
  });

  afterEach(async () => {
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const startSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  const auditStageOf = (site: SpaAuthSite, reads: readonly string[]): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: reads.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerPageLoad: ONE_PER_LOAD })),
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: DEFAULT_LIMITS,
  });

  /** 監査の段の口つきの認証の指定と、`/admin` から始める設定（ワーカーと同じ形）。 */
  const setup = (site: SpaAuthSite, reads: readonly string[]): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
    runCount += 1;
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
      approvedTestOrigins: [site.appOrigin],
      auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage: auditStageOf(site, reads),
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `spa-job-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    });
    return { config: { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } }, authentication };
  };

  /** 発見のジョブを動かし、成果物をスキーマで確かめて返す。 */
  const discover = async (site: SpaAuthSite, reads: readonly string[]): Promise<DiscoveryDocument> => {
    const { config, authentication } = setup(site, reads);
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    const document: unknown = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8'));
    expect((await validateArtifact('discovery', document)).ok).toBe(true);
    expect(outcome.summary.authentication).toEqual((document as DiscoveryDocument).authentication);
    return document as DiscoveryDocument;
  };

  /** READ の確かめのジョブを動かし（`/admin` を対象の画面にした、どの候補にも当たらない定義 2 つ）、成果物をスキーマで確かめて返す。 */
  const readCheck = async (site: SpaAuthSite, reads: readonly string[]): Promise<ReadEvidenceDocument> => {
    const { config, authentication } = setup(site, reads);
    const definitionOf = (index: number): WorkerStartReadCheck => ({
      readCheckId: `read-${index}`,
      readCheckRevision: 1,
      targetPage: { origin: site.appOrigin, path: SPA_APP_PATHS.admin },
      definition: { targetIdentityDigest: UNMATCHED_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    });
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-${runCount}`, authentication, readChecks: [definitionOf(1), definitionOf(2)], launchBrowser: launch,
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    const document: unknown = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8'));
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    expect(outcome.summary.authentication).toEqual((document as ReadEvidenceDocument).authentication);
    return document as ReadEvidenceDocument;
  };

  /** バックエンドとアプリに届いた、読み取りでない（GET・HEAD・事前確認でない）要求。 */
  const nonReads = (site: SpaAuthSite): readonly string[] => site.requests
    .filter((request) => !request.preflight && !READ_METHODS.has(request.method))
    .map(({ origin, method, path }) => `${origin} ${method} ${path}`);
  const readPaths = (document: DiscoveryDocument): readonly string[] =>
    document.pages.flatMap((page) => (page.state === 'READ' ? [new URL(page.url).pathname] : []));

  it('passes the registered calls in the discovery, which reaches the edit page; without them it does not', async () => {
    const editPath = spaMemberEditPathOf(1);
    const registered = await startSite({ preLoginRpc: 'required', rpcReads: true });
    const withCalls = await discover(registered, REGISTERED_READS);
    expect(readPaths(withCalls)).toContain(editPath);
    // 登録した呼び出しは、上限で断られず、401 もない（サービスの読み取りが届かなかった印はない）。DEF-127（T37a fix round 1）: fixture のテナントの
    // 呼び出しは応答の本文を読まないが、落ち着きの待ちは時間切れにならず、どの画面も読み切れる（Run Status は COMPLETE）。
    for (const page of withCalls.pages) {
      expect(page.state === 'READ' ? page.record.incompleteReasons : []).toEqual([]);
      // DEF-130-fix: ふつうの SPA の画面の文書でない要求（JS、API の読み取りなど）は、1 画面の読み込みあたりの上限の中で、数が成果物に残る。
      if (page.state === 'READ') {
        expect(page.subresourceRequests).toBeGreaterThan(0);
        expect(page.subresourceRequests).toBeLessThan(PAGE_SUBRESOURCE_REQUEST_LIMIT);
      }
    }
    expect(withCalls.runStatus).toBe('COMPLETE');
    expect(withCalls.authentication?.registeredReadRequestsAllowed).toBeGreaterThan(0);
    expect(withCalls.authentication?.serviceRequestLimitReached).toBe(false);
    // 届いた読み取りでない要求は、登録した手続きの呼び出しだけ（全部の後に待って数え直す）。
    await wait(LATE_REQUEST_WAIT_MS);
    const allowed = new Set(REGISTERED_READS.map((path) => `backend POST ${path}`));
    expect(nonReads(registered).length).toBeGreaterThan(0);
    expect(nonReads(registered).filter((request) => !allowed.has(request))).toEqual([]);
    await registered.close();

    const unregistered = await startSite({ preLoginRpc: 'required', rpcReads: true });
    const withoutCalls = await discover(unregistered, []);
    expect(readPaths(withoutCalls)).not.toContain(editPath);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReads(unregistered)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('passes the registered calls in the READ check', async () => {
    const site = await startSite({ preLoginRpc: 'required', rpcReads: true });
    const document = await readCheck(site, REGISTERED_READS);
    expect(document.authentication?.registeredReadRequestsAllowed).toBeGreaterThan(0);
    await wait(LATE_REQUEST_WAIT_MS);
    const allowed = new Set(REGISTERED_READS.map((path) => `backend POST ${path}`));
    expect(nonReads(site).length).toBeGreaterThan(0);
    expect(nonReads(site).filter((request) => !allowed.has(request))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('passes no registered call in the write job (NOT_SENT, no POST at the server)', async () => {
    const site = await startSite({ preLoginRpc: 'required', rpcReads: true });
    const { config, authentication } = setup(site, REGISTERED_READS);
    const write: WorkerStartWrite = {
      scenarioId: 'scenario-t37a',
      scenarioRevision: 1,
      grantId: 'grant-t37a',
      profileId: 'example-t37a',
      seedRecord: {
        seed: 'e'.repeat(SHA256_HEX_LENGTH) as never,
        seedInput: {
          profileId: 'example-t37a', scenarioId: 'scenario-t37a', scenarioRevision: 1, ruleSetDigest: `sha256:${'f'.repeat(SHA256_HEX_LENGTH)}`,
          executionGrantId: 'grant-t37a',
        },
        baseDate: '2026-10-17',
        attempt: 0,
      },
      request: { formMethod: 'POST', methodOverride: null, origin: site.appOrigin, path: SPA_APP_PATHS.memberNew, enctype: 'application/x-www-form-urlencoded' },
      // 承認の候補は、この画面にない（候補の確かめで送らずに止まる）。画面の読み込みで、テナントの手続きの呼び出しが出る。
      formPage: { origin: site.appOrigin, path: SPA_APP_PATHS.admin },
      candidate: { identityDigest: UNMATCHED_DIGEST, ruleDigest: UNMATCHED_DIGEST },
      candidateFields: [{ name: 'name', type: 'text', readonly: false, hidden: false, disabled: false }],
      values: { name: 'テスト' },
      verification: {
        successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: '#members' },
        inputErrorCondition: { pathPrefix: SPA_APP_PATHS.memberNew, selector: '.error' },
        recordId: { source: 'URL_PATH_PATTERN', pathPattern: `${SPA_APP_PATHS.admin}/members/{id}/edit` },
      },
      readVerification: {
        readCheckId: 'rc-t37a',
        readCheckRevision: 1,
        targetPage: { origin: site.appOrigin, path: SPA_APP_PATHS.admin },
        definition: { targetIdentityDigest: UNMATCHED_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
      },
      approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId: 'example-t37a', scenarioId: 'scenario-t37a', scenarioRevision: 1, grantId: 'grant-t37a' }),
    };
    const outcome = await executeWriteCreateRun({
      config, jobId: `job-write-${runCount}`, authentication, write, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal, recheck: () => Promise.resolve({ allowed: true }), reportSubmission: () => undefined,
    }, noObserver);
    expect(outcome.kind).toBe('RAN');
    await wait(LATE_REQUEST_WAIT_MS);
    // 画面は読んだ（アプリの読み込みがあった）が、登録した呼び出しを含めて、読み取りでない要求は届いていない。
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.admin).length).toBeGreaterThan(0);
    expect(nonReads(site)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('ends the discovery and the READ check by the session loss with the detail session-key when the login state key disappears', async () => {
    const site = await startSite({ clearSessionAfterList: true });
    const discovery = await discover(site, []);
    expect(discovery.endReason).toBe('AUTH_SESSION_LOST');
    expect(discovery.endReasonDetail).toBe('session-key');
    expect(discovery.runStatus).toBe('PARTIAL');
    expect(discovery.pages.some((page) => page.state === 'NOT_READ' && page.reason === 'AUTH_SESSION_LOST')).toBe(true);
    const evidence = await readCheck(site, []);
    expect(evidence.endReason).toBe('AUTH_SESSION_LOST');
    expect(evidence.endReasonDetail).toBe('session-key');
    expect(evidence.runStatus).toBe('PARTIAL');
    expect(evidence.checks.map((check) => check.state)).toEqual(['NOT_EXECUTED', 'NOT_EXECUTED']);
  }, TEST_TIMEOUT_MS);

  it('keeps the number of the 401 responses in the artifacts, and marks the page as not read in full', async () => {
    const site = await startSite({ tokenLifetimeMs: EXPIRED_TOKEN_LIFETIME_MS });
    const discovery = await discover(site, []);
    expect(discovery.authentication?.serviceUnauthorizedResponses).toBeGreaterThan(0);
    expect(discovery.endReasonDetail).toBeUndefined();
    const admin = discovery.pages.find((page) => page.state === 'READ' && new URL(page.url).pathname === SPA_APP_PATHS.admin);
    expect(admin?.state === 'READ' ? admin.record.incompleteReasons : []).toContain('SERVICE_READ_REFUSED');
    expect(discovery.runStatus).toBe('PARTIAL');
    const evidence = await readCheck(site, []);
    expect(evidence.authentication?.serviceUnauthorizedResponses).toBeGreaterThan(0);
    // 候補が見つからなくても、401 のあった画面では消えたと言わない（`READ_CANDIDATE_DRIFTED` でなく `UNDETERMINED`）。
    expect(evidence.checks.map((check) => (check.state === 'EXECUTED' ? check.result : check.state))).toEqual(['UNDETERMINED', 'UNDETERMINED']);
  }, TEST_TIMEOUT_MS);
});
