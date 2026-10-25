// DEF-138（設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 3 章の受け入れ条件 3・4）: 発見と READ の確かめのジョブがセッションの切れで
// 止まったとき、成果物（`discovery.json`・`read-evidence.json`）と、観測の口（ワーカーが IPC の `AUTH_STATE` に載せる値）に、同じ証拠が残る。
// - fixture（認証つきの SPA）の 2 ページ目が、クライアントの側でログインの画面へ移る場合（発見）と、サーバの側でリダイレクトする場合（READ の確かめ）。
//   ログインの状態の鍵が消えた場合（`session-key`）も、証拠が残る。
// - 観測の口の値は IPC の契約（`validateWorkerToParentMessage`）を通る。それを管理データに記録すると（親と同じ口 `recordAuthState`）、画面の読む口
//   （`readJob`）が同じ値を返す。
// - token・query の値（移る先の URL の目印）・資格情報が、成果物・IPC の値・管理データ（WAL を含む）に出ない。
// 本物の factory と Guard。Chromium はテストの既定の headless。値は出力しない。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { createStartingJob, readJob, recordAuthState } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_SESSION_LOST_STATE,
  validateWorkerToParentMessage,
  type WorkerStartReadCheck,
} from '../../src/control/worker-protocol.js';
import type { SessionLossEvidence } from '../../src/core/evidence-types.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { ReadEvidenceDocument } from '../../src/discovery/read-check-evaluation.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { executeReadCheckRun } from '../../src/worker/read-check-run.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_SESSION_LOSS_PATH,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const TEST_TIMEOUT_MS = 180_000;
const MAX_PAGES = 4;
const LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const LANDED_PATH = `${SPA_APP_PATHS.auth}?from&ticket`;
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const SHA256_HEX_LENGTH = 64;
const UNMATCHED_DIGEST = `sha256:${'0'.repeat(SHA256_HEX_LENGTH)}`;
const PROFILE_ID = 'session-loss-jobs';
const CREATED_AT = '20261019000000';

/** 観測の口に届いた、セッションの切れの知らせ。 */
interface SessionLostCall {
  readonly url: string;
  readonly sessionLoss: SessionLossEvidence | null;
}

describe('DEF-138: the session loss evidence of the discovery and READ check jobs', () => {
  let site: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-session-loss-jobs-'));
  });

  afterEach(async () => {
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const startSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
    site = await startSpaAuthSite(options);
    site.addMember('既存花子');
    return site;
  };

  const setup = (spa: SpaAuthSite, auditPathPrefixes: readonly string[]): { readonly config: AuditConfig; readonly authentication: RunAuthentication } => {
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
      auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes, dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage,
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: spa.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(spa.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `loss-job-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    });
    return { config: { ...base, site: { startUrl: `${spa.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [spa.appOrigin] } }, authentication };
  };

  const observerInto = (calls: SessionLostCall[]) => ({
    onRunStarted: (): void => undefined,
    onSessionLost: (url: string, sessionLoss: SessionLossEvidence | null): void => {
      calls.push({ url, sessionLoss });
    },
  });

  const discover = async (spa: SpaAuthSite, auditPathPrefixes: readonly string[]) => {
    const { config, authentication } = setup(spa, auditPathPrefixes);
    const calls: SessionLostCall[] = [];
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-discovery-${runCount}`, authentication, launchBrowser: () => launchHeadlessChromium(), clock: () => new Date(),
      now: () => Date.now(), stopSignal: new AbortController().signal,
    }, observerInto(calls));
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    const text = readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8');
    const document = JSON.parse(text) as DiscoveryDocument;
    expect((await validateArtifact('discovery', document)).ok).toBe(true);
    return { document, text, calls };
  };

  const readCheck = async (spa: SpaAuthSite, auditPathPrefixes: readonly string[]) => {
    const { config, authentication } = setup(spa, auditPathPrefixes);
    const definition: WorkerStartReadCheck = {
      readCheckId: 'read-1',
      readCheckRevision: 1,
      targetPage: { origin: spa.appOrigin, path: SPA_SESSION_LOSS_PATH },
      definition: { targetIdentityDigest: UNMATCHED_DIGEST, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    };
    const calls: SessionLostCall[] = [];
    const outcome = await executeReadCheckRun({
      config, jobId: `job-read-${runCount}`, authentication, readChecks: [definition], launchBrowser: () => launchHeadlessChromium(),
      clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
    }, observerInto(calls));
    if (outcome.kind !== 'RAN') {
      throw new Error(`the READ check did not run: ${outcome.kind}`);
    }
    const text = readFileSync(join(outcome.runDirectory, 'read-evidence.json'), 'utf8');
    const document = JSON.parse(text) as ReadEvidenceDocument;
    expect((await validateArtifact('read-evidence', document)).ok).toBe(true);
    return { document, text, calls };
  };

  /** 観測の口の値を IPC の `AUTH_STATE` にして確かめ、その JSON を返す（ワーカーが送る形）。 */
  const ipcTextOf = (call: SessionLostCall): string => {
    const message = {
      protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state: WORKER_SESSION_LOST_STATE, sessionLostUrl: call.url,
      ...(call.sessionLoss === null ? {} : { sessionLoss: call.sessionLoss }),
    };
    expect(validateWorkerToParentMessage(message).ok).toBe(true);
    return JSON.stringify(message);
  };

  /** 親と同じ口で管理データに記録し、読む口が同じ値を返すことと、ファイル（WAL を含む）に値が出ないことを確かめる。 */
  const expectStoredWithoutValues = (call: SessionLostCall, markers: readonly string[]): void => {
    const root = join(workDirectory, `db-${runCount}`);
    const database = openControlDatabase(resolveControlDatabasePath(root));
    try {
      expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
      expect(createStartingJob(database, {
        jobId: `job-db-${runCount}`, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: CREATED_AT,
      }, () => null).ok).toBe(true);
      expect(recordAuthState(database, `job-db-${runCount}`, WORKER_SESSION_LOST_STATE, call.url, null, call.sessionLoss)).toBe(true);
      expect(readJob(database, `job-db-${runCount}`)?.sessionLoss).toEqual(call.sessionLoss);
      for (const path of [resolveControlDatabasePath(root), `${resolveControlDatabasePath(root)}-wal`]) {
        if (existsSync(path)) {
          const bytes = readFileSync(path);
          for (const marker of markers) {
            expect(bytes.includes(Buffer.from(marker, 'utf8'))).toBe(false);
          }
        }
      }
    } finally {
      closeControlDatabase(database);
    }
  };

  const markersOf = (spa: SpaAuthSite): readonly string[] => [...spa.sessionLossMarkers(), ...spa.secretValues()];
  const expectNoMarkers = (text: string, markers: readonly string[]): void => {
    for (const marker of markers) {
      expect(text.includes(marker)).toBe(false);
    }
  };

  it('keeps the evidence of the discovery stopped by a client side move to the login page, in the artifact, the IPC and the control data', async () => {
    const spa = await startSite({ sessionLossPage: 'client' });
    const { document, text, calls } = await discover(spa, []);
    expect(document.endReason).toBe('AUTH_SESSION_LOST');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    const loss = document.sessionLoss;
    expect(call?.sessionLoss).toEqual(loss);
    expect(loss).toMatchObject({ stage: null, requestedPath: SPA_SESSION_LOSS_PATH, landedPath: LANDED_PATH, landedBy: 'PAGE_URL' });
    expect(loss?.redirectPaths).toContainEqual({ originKind: 'ALLOWED', path: LANDED_PATH });
    expect(loss?.storageKeyChange).toContainEqual({
      storage: 'LOCAL_STORAGE', originKind: 'ALLOWED', change: 'REMOVED', count: 1, shapes: [{ prefix: '', suffix: '-token' }],
    });
    const markers = markersOf(spa);
    expectNoMarkers(text, markers);
    if (call === undefined) throw new Error('no session lost call');
    // 止まったページの URL（`sessionLostUrl`）は今のまま伏せ字の後の URL なので、証拠の部分だけを目印で確かめる。
    expectNoMarkers(JSON.stringify(call.sessionLoss), markers);
    ipcTextOf(call);
    expectStoredWithoutValues({ url: `${spa.appOrigin}${SPA_SESSION_LOSS_PATH}`, sessionLoss: call.sessionLoss }, markers);
  }, TEST_TIMEOUT_MS);

  it('keeps the evidence of the READ check stopped by a server side redirect that the Guard stops', async () => {
    const spa = await startSite({ sessionLossPage: 'server' });
    const { document, text, calls } = await readCheck(spa, [SPA_APP_PATHS.admin]);
    expect(document.endReason).toBe('AUTH_SESSION_LOST');
    const [call] = calls;
    expect(call?.sessionLoss).toEqual(document.sessionLoss);
    expect(document.sessionLoss).toMatchObject({ requestedPath: SPA_SESSION_LOSS_PATH, landedPath: LANDED_PATH, landedBy: 'BLOCKED_REDIRECT' });
    expect(document.sessionLoss?.blockedRequests).toContainEqual({
      method: 'GET', originKind: 'ALLOWED', path: SPA_APP_PATHS.auth, reason: 'AUDIT_EXCLUDED_URL', count: 1,
    });
    const markers = markersOf(spa);
    expectNoMarkers(text, markers);
    if (call === undefined) throw new Error('no session lost call');
    // 止まったページの URL（`sessionLostUrl`。T25f の伏せ字の後の値で、伏せ字の一覧にない名前の値は残る）は今のまま。証拠の部分を目印で確かめる。
    ipcTextOf(call);
    expectNoMarkers(JSON.stringify(call.sessionLoss), markers);
  }, TEST_TIMEOUT_MS);

  it('keeps the evidence with the stage session-key when the login state key disappears', async () => {
    const spa = await startSite({ clearSessionAfterList: true });
    const { document, text } = await discover(spa, []);
    expect(document.endReason).toBe('AUTH_SESSION_LOST');
    expect(document.endReasonDetail).toBe('session-key');
    expect(document.sessionLoss).toMatchObject({ stage: 'session-key', requestedPath: SPA_APP_PATHS.admin, landedBy: 'PAGE_URL' });
    expect(document.sessionLoss?.storageKeyChange).toContainEqual(expect.objectContaining({ storage: 'LOCAL_STORAGE', change: 'REMOVED' }));
    expectNoMarkers(text, markersOf(spa));
  }, TEST_TIMEOUT_MS);
});
