// AS-c（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 5 章の「ユーザーの言葉と選択（AS-c）」「AS-c の Blocker」の行の A・D）: スクリプトで
// 送るログインの監査で、監査の段の送信の扱い `PASS_EXCEPT_DELETE` のときは token の更新を通し、更新した状態を Run の中で次の Context へ引き継ぐ（T25c の世代つきの
// 引き継ぎ。メモリの中だけ）。
// - fixture（`startSpaAuthSite`）は、画面を開くたびに token を更新してから描き（`refreshOnLoad`）、更新で前の token を無効にし、使い終えた refresh token の
//   再使用でセッションを消す（`refreshRotation`）。更新を止めると、最初の画面でログインの画面へ移る（セッションの切れ）。引き継がないと、次の Context が
//   古い refresh token を使ってセッションを消す。
// - 既定（`READ_ONLY`）: token の更新を止めるので、セッションの切れで止まる（AS-c の前の `PASS_EXCEPT_DELETE` と同じ止め方。RED の形）。
// - `PASS_EXCEPT_DELETE`: すべての画面を認証のまま監査する。更新は Context ごとに 1 回で、再使用はない。
// - token・API の鍵・資格情報（目印）は、成果物（保存 `checkpoint/` と `run.json` を含む。ZIP の中身も）に出ない。
// Chromium はテストの既定の headless と、CLI の起動の設定の両方。届いたかは fixture の記録で数える。
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { AuditSendPolicyName } from '../../src/core/audit-send-policy.js';
import type { RunSummary } from '../../src/core/contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { filesUnder, placesWithMarkers } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  startSpaAuthSite,
  type SpaAuthSite,
} from '../helpers/spa-auth-site-fixture.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
const LATE_REQUEST_WAIT_MS = 1_000;
/** 監査する画面の数（管理画面と、会員の登録と更新の画面。どれも開くたびに token を更新する）。 */
const MAX_PAGES = 3;
/** 1 つの画面の最初の読み込み（Desktop と Mobile）の数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const SERVICE_REQUEST_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });

describe.each(LAUNCHERS)('AS-c: the token refresh and the state inheritance with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-audit-send-refresh-'));
  });

  afterEach(async () => {
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  /** 画面を開くたびに token を入れ替えるサイトを、扱い `sendPolicy` で監査する。 */
  const auditRotatingSite = async (sendPolicy: AuditSendPolicyName): Promise<{ readonly site: SpaAuthSite; readonly run: RunSummary; readonly runDirectory: string }> => {
    spa = await startSpaAuthSite({ refreshOnLoad: true, refreshRotation: true });
    const site = spa;
    site.addMember('既存花子');
    site.addMember('二番次郎');
    runCount += 1;
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
      approvedTestOrigins: [site.appOrigin],
      auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage: {
        approvedServiceOrigins: [site.backendOrigin],
        auditReadRequests: [],
        scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
        serviceRequestLimits: SERVICE_REQUEST_LIMITS,
      },
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `refresh-${runCount}` },
      output: { directory: join(workDirectory, `run-${runCount}`) },
      crawl: { maxPages: MAX_PAGES },
      audit: { sendPolicy },
    });
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launch(), clock: () => new Date(), now: () => Date.now(), authentication,
    }, { startNew: true });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    const run = JSON.parse(readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8')) as RunSummary;
    return { site, run, runDirectory: outcome.runDirectory };
  };

  it('stops by the session loss with READ_ONLY because the token refresh is blocked (the form of the RED before AS-c)', async () => {
    const { site, run } = await auditRotatingSite('READ_ONLY');
    expect(site.refreshes).toBe(0);
    expect(run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(run.safety.auditSend).toEqual({
      policy: 'READ_ONLY', passedRequests: 0, passedRequestsByMethod: {}, passedOtherOriginRequests: 0, passedWebSockets: 0,
      passedWebSocketsOutsideGuard: 0, passedDangerousWebSockets: 0,
    });
  }, TEST_TIMEOUT_MS);

  it('audits every page while signed in with PASS_EXCEPT_DELETE, refreshing once per load and handing the new state to the next Context', async () => {
    const { site, run, runDirectory } = await auditRotatingSite('PASS_EXCEPT_DELETE');
    expect(run.executions.at(-1)?.endReason).toBe('COMPLETED');
    expect(run.incompleteReasons.map(({ code }) => code)).not.toContain('AUTH_SESSION_LOST');
    expect(run.auditedPageCount).toBe(MAX_PAGES);
    // 更新は、最初の読み込みのたびに 1 回（古い refresh token の再使用はない。引き継ぎが効いた）。
    expect(site.refreshes).toBe(MAX_PAGES * PRIMARY_LOADS_PER_PAGE);
    expect(site.reusedRefreshes).toBe(0);
    expect(run.safety.invariantViolationCount).toBe(0);
    expect(run.safety.auditSend?.policy).toBe('PASS_EXCEPT_DELETE');
    expect(run.safety.auditSend?.passedRequests).toBeGreaterThanOrEqual(site.refreshes);
    // token・API の鍵・資格情報は、保存と run.json を含む成果物に出ない（ZIP の中身も）。
    expect(placesWithMarkers(filesUnder(runDirectory), site.secretValues())).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
