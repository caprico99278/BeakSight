// DF-3（DEF-167）: 読み込み（DOMContentLoaded）が返った後に、画面のスクリプトがログインの画面へ移すサイトでも、セッションの切れを判定する。
// - fixture（認証つきの SPA）の 2 ページ目（`SPA_SESSION_LOSS_PATH`）が、`load` の後に少し待ってから、ログインの画面へ移る（`client-late`。ログインの状態の
//   鍵は消さない）。ログインの画面は読む範囲の外なので、Guard がその移動を止める（DEF-167 の形）。
// - 監査の Run・発見・READ の確かめの 3 つで、直した後は `AUTH_SESSION_LOST` で止まり、そのページは捨てられ、次のページへの読み込みが 0 件である。直す前は、
//   読み込みの直後の 1 回の判定に記録がなく、Run は続いた（RED）。
// - 対照（`client-late-other`）: 同じ時機に、セッションの切れの path に当たらない画面へ移る（Guard が止める）ときは、止めない（誤検知を増やさない）。
// 本物の factory と Guard。Chromium はテストの既定と、CLI の起動の設定の両方。サーバは 127.0.0.1 だけで待ち受ける。値は出力しない。
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartReadCheck } from '../../src/control/worker-protocol.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { SessionLossEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import { SESSION_LOSS_CHECK_POINTS, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_SESSION_LOSS_PATH,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaSessionLossPage,
} from '../helpers/spa-auth-site-fixture.js';

const LAUNCHERS = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI launch settings', () => launchCliChromium()],
] as const;
const TEST_TIMEOUT_MS = 180_000;
const MAX_PAGES = 4;
const LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
/** 移る先の path の表記（query は名前だけ）。 */
const LANDED_PATH = `${SPA_APP_PATHS.auth}?from&ticket`;
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const SHA256_HEX_LENGTH = 64;
const UNMATCHED_DIGEST = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`;
/** 読み込みの直後より後の時機（監査の Run の場所の印 `<ビューポート>:<段階>:<時機>` の時機）。 */
const LATER_POINTS: readonly string[] = [
  SESSION_LOSS_CHECK_POINTS.settled,
  SESSION_LOSS_CHECK_POINTS.beforeNextLoad,
  SESSION_LOSS_CHECK_POINTS.pageEnd,
];

describe.each(LAUNCHERS)('DF-3 (DEF-167): the session loss after a late script move to the login page (%s)', (_name, launch) => {
  let site: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    // 起動できることを先に確かめる（起動の失敗を、判定の失敗と取り違えない）。
    const browser: Browser = await launch();
    await browser.close();
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-session-loss-late-'));
  });

  afterEach(async () => {
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const startSite = async (page: SpaSessionLossPage): Promise<SpaAuthSite> => {
    const spa = await startSpaAuthSite({ sessionLossPage: page });
    site = spa;
    spa.addMember('既存花子');
    return spa;
  };

  /** 認証の指定と設定（読む範囲は管理画面の下だけ。ログインの画面へ移る移動は、Guard が止める）。 */
  const setup = (spa: SpaAuthSite): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
    runCount += 1;
    const auditStage: AuditStageServiceRequests = {
      approvedServiceOrigins: [spa.backendOrigin],
      auditReadRequests: [],
      scriptLogin: { origin: spa.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
      serviceRequestLimits: LIMITS,
    };
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: spa.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: spa.issueStoredSession() }] }] },
      approvedTestOrigins: [spa.appOrigin],
      auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [SPA_APP_PATHS.admin], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage,
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: spa.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(spa.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `late-${runCount}` }, output: { directory: join(workDirectory, `run-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    });
    return { config: { ...base, site: { startUrl: `${spa.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [spa.appOrigin] } }, authentication };
  };

  /** アプリの Origin の画面の読み込み（GET の path と query。アプリのスクリプトは除く。届いた順）。 */
  const pageLoadsOf = (spa: SpaAuthSite): readonly string[] => spa.requests
    .filter(({ origin, method, path }) => origin === 'app' && method === 'GET' && path !== SPA_APP_PATHS.script)
    .map(({ path }) => path);

  /** 移る画面の最初の読み込みの後の、ほかの画面の読み込み（移る画面の読み直しを除く）。 */
  const loadsAfterLatePage = (spa: SpaAuthSite): readonly string[] => {
    const loads = pageLoadsOf(spa);
    const first = loads.indexOf(SPA_SESSION_LOSS_PATH);
    expect(first, 'the late moving page was loaded').toBeGreaterThanOrEqual(0);
    return loads.slice(first + 1).filter((path) => path !== SPA_SESSION_LOSS_PATH);
  };

  const expectOnlyReads = (spa: SpaAuthSite): void => {
    expect(spa.requests.filter(({ method, preflight }) => !READ_METHODS.has(method) && !preflight)).toEqual([]);
    // ログインの画面へは移らない（Guard が読む範囲の外として止める）。
    expect(pageLoadsOf(spa).filter((path) => path.startsWith(SPA_APP_PATHS.auth))).toEqual([]);
  };

  const expectLateEvidence = (loss: SessionLossEvidence | null | undefined): void => {
    expect(loss).toMatchObject({ requestedPath: SPA_SESSION_LOSS_PATH, landedPath: LANDED_PATH, landedBy: 'BLOCKED_REDIRECT' });
    expect(loss?.blockedRequests).toContainEqual({ method: 'GET', originKind: 'ALLOWED', path: SPA_APP_PATHS.auth, reason: 'AUDIT_EXCLUDED_URL', count: 1 });
  };

  const audit = async (spa: SpaAuthSite): Promise<RunSummary> => {
    const { config, authentication } = setup(spa);
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launch(), clock: () => new Date(), now: () => Date.now(), authentication,
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    return JSON.parse(readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8')) as RunSummary;
  };

  const discover = async (spa: SpaAuthSite): Promise<{ readonly document: DiscoveryDocument; readonly lost: number }> => {
    const { config, authentication } = setup(spa);
    let lost = 0;
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, authentication, launchBrowser: () => launch(), clock: () => new Date(),
      now: () => Date.now(), stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => { lost += 1; } });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
    expect((await validateArtifact('discovery', document)).ok).toBe(true);
    return { document, lost };
  };

  const readCheck = async (spa: SpaAuthSite): Promise<ReadEvidenceDocument> => {
    const { config, authentication } = setup(spa);
    const definition: WorkerStartReadCheck = {
      readCheckId: 'read-1',
      readCheckRevision: 1,
      targetPage: { origin: spa.appOrigin, path: SPA_SESSION_LOSS_PATH },
      definition: { targetIdentityDigest: UNMATCHED_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    };
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-${runCount}`, authentication, readChecks: [definition], launchBrowser: () => launch(),
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    const document = JSON.parse(readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8')) as ReadEvidenceDocument;
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    return document;
  };

  it('stops the audit Run at a page that moves to the login page after the load, discards it, and loads no next page', async () => {
    const spa = await startSite('client-late');
    const run = await audit(spa);
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(run.incompleteReasons).toContainEqual({ code: 'AUTH_SESSION_LOST', detail: null });
    const loss = run.authentication?.sessionLoss;
    // 場所の印は、読み込みの直後（`desktop:passive`）より後の時機（`desktop:passive:<時機>`）。
    const [viewport, stage, point] = (loss?.stage ?? '').split(':');
    expect([viewport, stage]).toEqual(['desktop', 'passive']);
    expect(LATER_POINTS).toContain(point);
    expectLateEvidence(loss);
    // そのページは捨て（モバイルを読み込まない）、次のページへの読み込みは 0 件。
    expect(pageLoadsOf(spa).filter((path) => path === SPA_SESSION_LOSS_PATH)).toHaveLength(1);
    expect(loadsAfterLatePage(spa)).toEqual([]);
    expectOnlyReads(spa);
  }, TEST_TIMEOUT_MS);

  it('does not stop the audit Run at a page that moves after the load to a page outside the session lost path (control)', async () => {
    const spa = await startSite('client-late-other');
    const run = await audit(spa);
    expect(run.executions.at(-1)?.endReason).not.toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(run.incompleteReasons.filter(({ code }) => code === 'AUTH_SESSION_LOST')).toEqual([]);
    expect(run.authentication?.sessionLoss ?? null).toBeNull();
    expect(loadsAfterLatePage(spa).length).toBeGreaterThan(0);
    expectOnlyReads(spa);
  }, TEST_TIMEOUT_MS);

  it('stops the discovery at a page that moves to the login page after the load, and reads no next page', async () => {
    const spa = await startSite('client-late');
    const { document, lost } = await discover(spa);
    expect(document.endReason).toBe('AUTH_SESSION_LOST');
    expect(lost).toBe(1);
    expectLateEvidence(document.sessionLoss);
    expect(document.pages.filter((page) => page.state === 'READ').map(({ url }) => new URL(url).pathname)).not.toContain(SPA_SESSION_LOSS_PATH);
    expect(loadsAfterLatePage(spa)).toEqual([]);
    expectOnlyReads(spa);
  }, TEST_TIMEOUT_MS);

  it('does not stop the discovery at a page that moves after the load outside the session lost path (control)', async () => {
    const spa = await startSite('client-late-other');
    const { document, lost } = await discover(spa);
    expect(document.endReason).not.toBe('AUTH_SESSION_LOST');
    expect(lost).toBe(0);
    expect(loadsAfterLatePage(spa).length).toBeGreaterThan(0);
    expectOnlyReads(spa);
  }, TEST_TIMEOUT_MS);

  it('stops the READ check at a target page that moves to the login page after the load, and loads no next page', async () => {
    const spa = await startSite('client-late');
    const document = await readCheck(spa);
    expect(document.endReason).toBe('AUTH_SESSION_LOST');
    expectLateEvidence(document.sessionLoss);
    expect(pageLoadsOf(spa).filter((path) => path === SPA_SESSION_LOSS_PATH)).toHaveLength(1);
    expect(loadsAfterLatePage(spa)).toEqual([]);
    expectOnlyReads(spa);
  }, TEST_TIMEOUT_MS);

  it('does not stop the READ check at a target page that moves after the load outside the session lost path (control)', async () => {
    const spa = await startSite('client-late-other');
    const document = await readCheck(spa);
    expect(document.endReason).not.toBe('AUTH_SESSION_LOST');
    expect(document.sessionLoss ?? null).toBeNull();
    expectOnlyReads(spa);
  }, TEST_TIMEOUT_MS);
});
