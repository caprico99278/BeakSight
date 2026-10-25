// T35c（Task 35 の設計書 3.4〜3.7、4 章、5 章の 1〜5）: スクリプトで送るログインの監査の Run（監査の中核 `executeAuditRun` に、監査の段の口つきの
// 認証の指定 `RunAuthentication` を渡す。ワーカーと同じ形）。Chromium はテストの既定の headless と、CLI の起動の設定の両方。
// - 登録した読み取りの手続きの呼び出しは、Desktop と Mobile の読み込みの回数の中で届き、token の更新・計測の送信・WebSocket は届かない。範囲を `/admin`
//   に絞っても `/app.js` は読める。`run.json` に監査の段の数と、承認したサービスの Origin の区分がある。
// - 小さな上限で、上限に届くと Run は PARTIAL・`STOPPED_BY_SERVICE_REQUEST_LIMIT`。サービスの Origin に届いた要求は上限を超えない。再開は新しい予算。
// - DEF-141: 1 分あたりの上限では、ページの途中で要求を断らず、次の読み込みの前に待って最後まで進む（待った回数と時間が `run.json` と知らせに出る）。
//   1 回の Run あたりの上限に届けば、今どおり止まる。
// - ログインの状態の鍵が消えると、セッションの切れで止まる。401 の数が `run.json` に出る。
// - 成果物（ZIP の中身を含む）に、サービスの Origin の URL の query の値（会員のメールアドレス）、token、API の鍵、資格情報が出ない。
// 届いたかは fixture の記録で数える。各 Run の後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { executeAuditRun, type AuditRunOutcome } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { CHECKPOINT_ARTIFACT_DIRECTORY, CHECKPOINT_ARTIFACT_FILE_NAMES, PAGES_ARTIFACT_DIRECTORY } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import { LOAD_PEAK_WINDOW_MS } from '../../src/crawl/load-meter.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import type { RunNotice } from '../../src/orchestration/run-coordinator.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { filesUnder, nonReadRequestsOf, placesWithMarkers } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
/** 各 Run の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 監査の段の token の更新までの時間（ms。ページの監査の間に送られる短さ）。 */
const SHORT_REFRESH_MS = 50;
/** 期限の切れた token（401 を受ける）の有効期限（ms）。 */
const EXPIRED_TOKEN_LIFETIME_MS = 1;
const MAX_PAGES = 6;
/** 設定の上限の値（120・600）と、小さな上限。 */
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const SMALL_LIMITS = Object.freeze({ perMinute: 5, perRun: 3 });
/** DEF-141: 1 分あたりの上限で待った後に、1 回の Run あたりの上限で止まる上限（Run の上限は再開をまたいで数える）。 */
const MINUTE_LIMITS = Object.freeze({ perMinute: 2, perRun: 4 });
const ONE_PER_LOAD = 1;
/** 1 ページの最初の読み込み（Desktop と Mobile）の数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
const EXISTING_NAME = '既存花子';
const SECOND_NAME = '二番次郎';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });

/** DEF-141: 1 回の読み込みでサービスへ 3 件を出す管理画面（`emailFilterRead`）より小さい、1 分あたりの上限（1 回の Run あたりは大きく）。 */
const PACING_LIMITS = Object.freeze({ perMinute: 2, perRun: 600 });
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

describe.each(LAUNCHERS)('T35c: the audit Run of the script login audit with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-spa-audit-run-'));
  });

  afterEach(async () => {
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  const startSite = async (options: SpaAuthSiteOptions = {}): Promise<SpaAuthSite> => {
    spa = await startSpaAuthSite(options);
    spa.addMember(EXISTING_NAME);
    return spa;
  };

  const auditStageOf = (
    site: SpaAuthSite,
    reads: readonly string[],
    limits: { readonly perMinute: number; readonly perRun: number } = DEFAULT_LIMITS,
  ): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: reads.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerPageLoad: ONE_PER_LOAD })),
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: limits,
  });

  /**
   * 監査の段の口つきの認証の指定で、`/admin` から監査する（`name` は出力先）。DEF-141: `fastClock` なら、注入した時計で待ちを短くする（`now` は本物の時刻に
   * 待った時間を足した値、`sleep` は時刻を進めてすぐ終わる）。
   */
  const auditAdmin = async (
    site: SpaAuthSite,
    name: string,
    options: {
      readonly auditStage: AuditStageServiceRequests;
      readonly auditPathPrefixes?: readonly string[];
      readonly excludedPaths?: readonly string[];
      readonly startNew?: boolean;
      readonly fastClock?: boolean;
      readonly onNotice?: (notice: RunNotice) => void;
    },
  ): Promise<{ readonly outcome: AuditRunOutcome; readonly runDirectory: string; readonly run: RunSummary; readonly clock: FastClock }> => {
    runCount += 1;
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
      approvedTestOrigins: [site.appOrigin],
      auditExclusions: {
        excludedPathPrefixes: [SPA_APP_PATHS.logout, ...(options.excludedPaths ?? [])],
        auditPathPrefixes: options.auditPathPrefixes ?? [],
        dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
      },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage: options.auditStage,
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `spa-${name}` }, output: { directory: join(workDirectory, name) }, crawl: { maxPages: MAX_PAGES },
    });
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const clock = new FastClock();
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launch(),
      clock: () => new Date(),
      now: options.fastClock === true ? clock.now : () => Date.now(),
      ...(options.fastClock === true ? { sleep: clock.sleep } : {}),
      authentication,
    }, { startNew: options.startNew ?? true }, options.onNotice === undefined ? {} : { onNotice: options.onNotice });
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    const run = JSON.parse(readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8')) as RunSummary;
    return { outcome, runDirectory: outcome.runDirectory, run, clock };
  };

  /** バックエンドに届いた本番の（事前確認でない）要求。 */
  const backendRequests = (site: SpaAuthSite) => site.requests.filter((request) => request.origin !== 'app' && !request.preflight);
  const backendNonReads = (site: SpaAuthSite): readonly string[] => nonReadRequestsOf(backendRequests(site));
  const pageDocuments = (runDirectory: string) => readdirSync(join(runDirectory, PAGES_ARTIFACT_DIRECTORY)).map((pageId) =>
    JSON.parse(readFileSync(join(runDirectory, PAGES_ARTIFACT_DIRECTORY, pageId, 'page.json'), 'utf8')) as {
      readonly pageUrl: string;
      readonly viewports: Readonly<Record<string, { readonly status: string }>>;
    });
  const visibleText = (runDirectory: string): string => filesUnder(runDirectory)
    .filter(([path]) => path.endsWith('visible-text.txt')).map(([, bytes]) => bytes.toString('utf8')).join('\n');

  it('reads the list by the registered calls on the Desktop and Mobile loads; blocks the refresh, the beacon and the WebSocket; leaks nothing', async () => {
    const site = await startSite({
      rpcReads: true, preLoginRpc: 'required', refreshAfterMs: SHORT_REFRESH_MS, rumBeacon: true, websocket: true, emailFilterRead: true,
    });
    const memberEmail = site.memberOf(1)?.email ?? '';
    const { run, runDirectory } = await auditAdmin(site, `complete-${runCount}`, {
      auditStage: auditStageOf(site, [SPA_BACKEND_PATHS.rpcListMembers, SPA_BACKEND_PATHS.rpcResolveTenant]),
      auditPathPrefixes: [SPA_APP_PATHS.admin],
      excludedPaths: ['/admin/members'],
    });
    expect(run.runStatus).toBe('COMPLETE');
    expect(run.executions.at(-1)?.endReason).toBe('COMPLETED');
    // 範囲を `/admin` に絞っても、範囲の外の静的な資源（アプリのスクリプト）は読める。
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script).length).toBeGreaterThan(0);
    // 届いた読み取りでない要求は、登録した手続きの呼び出しだけ（Desktop と Mobile の読み込みに 1 回ずつ）。
    expect([...backendNonReads(site)].sort()).toEqual([
      ...Array.from({ length: PRIMARY_LOADS_PER_PAGE }, () => `POST ${SPA_BACKEND_PATHS.rpcListMembers}`),
      ...Array.from({ length: PRIMARY_LOADS_PER_PAGE }, () => `POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`),
    ].sort());
    expect(site.refreshes).toBe(0);
    expect(site.rumBeacons).toBe(0);
    expect(backendRequests(site).filter(({ method }) => method === 'UPGRADE')).toEqual([]);
    expect(visibleText(runDirectory)).toContain(EXISTING_NAME);
    const [admin] = pageDocuments(runDirectory);
    expect(admin?.viewports['desktop']?.status).toBe('AUDITED');
    expect(admin?.viewports['mobile']?.status).toBe('AUDITED');
    expect(run.authentication).toMatchObject({ registeredReadRequestsAllowed: 2 * PRIMARY_LOADS_PER_PAGE, serviceRequestLimitReached: false });
    expect(run.authentication?.otherNonReadBlocked).toBeGreaterThan(0);
    expect(run.load.approvedServiceOrigins?.count).toBeGreaterThan(0);
    // 成果物（ZIP の中身を含む）に、会員のメールアドレス（サービスの Origin の URL の query の値）と秘密の目印が出ない。
    expect(memberEmail.length).toBeGreaterThan(0);
    expect(placesWithMarkers(filesUnder(runDirectory), [memberEmail, encodeURIComponent(memberEmail), ...site.secretValues()])).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T35R-fix で意図して直した期待（T35R の I-3）: 前は、再開の実行が新しい予算で数えた（再開で上限の数だけ、また届いた）。ユーザーの判断「1 回の Run で
  // 600 件」どおり、Run の上限の数を保存で引き継ぐので、Run の上限に届いた後の再開では、サービスの Origin にもう届かず、同じ終わり方で止まる。
  it('stops at the service request limit (PARTIAL), keeps the requests within the limit of the whole Run across the resume', async () => {
    const site = await startSite();
    site.addMember(SECOND_NAME);
    const auditStage = auditStageOf(site, [], SMALL_LIMITS);
    const name = `limit-${runCount}`;
    const first = await auditAdmin(site, name, { auditStage });
    expect(first.run.runStatus).toBe('PARTIAL');
    expect(first.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    expect(first.run.incompleteReasons.map(({ code }) => code)).toContain('SERVICE_REQUEST_LIMIT_REACHED');
    expect(first.run.authentication?.serviceRequestLimitReached).toBe(true);
    // 全部の後に、もう一度待って数え直す。
    await wait(LATE_REQUEST_WAIT_MS);
    const afterFirst = backendRequests(site).length;
    expect(afterFirst).toBeLessThanOrEqual(SMALL_LIMITS.perRun);
    expect(first.run.load.approvedServiceOrigins?.count).toBe(afterFirst);
    const second = await auditAdmin(site, name, { auditStage, startNew: false });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(second.run.executions).toHaveLength(2);
    expect(second.run.runStatus).toBe('PARTIAL');
    expect(second.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    expect(backendRequests(site).length).toBeLessThanOrEqual(SMALL_LIMITS.perRun);
  }, TEST_TIMEOUT_MS);

  // DEF-141（設計書 `2026-10-20-beaksight-service-request-pacing-design.md` 3 章の 1〜3）で意図して直した期待: 前は、1 分あたりの上限で、ページの読み込みの
  // 途中で要求を断り、Run を止めた（T35R-fix の I-3 の「1 分あたりの上限で止まり、再開で続く」）。今は、1 回の読み込みで上限を超える要求を出す画面
  // （`emailFilterRead`。管理画面の 1 回の読み込みで、サービスへ 3 件）でも、ページの途中で断らず、次の読み込みの前に、窓の中の数が上限を下回るまで待って、
  // 最後まで進む。待ちは注入した時計で短くする（本物の 60 秒を待たない）。
  it('waits before the next load by the per minute limit without refusing a request in a page, and completes the Run (DEF-141)', async () => {
    const site = await startSite({ emailFilterRead: true });
    site.addMember(SECOND_NAME);
    const notices: RunNotice[] = [];
    const { run, runDirectory, clock } = await auditAdmin(site, `pacing-${runCount}`, {
      auditStage: auditStageOf(site, [], PACING_LIMITS),
      fastClock: true,
      onNotice: (notice) => notices.push(notice),
    });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(run.runStatus).toBe('COMPLETE');
    expect(run.executions.at(-1)?.endReason).toBe('COMPLETED');
    expect(run.incompleteReasons.map(({ code }) => code)).not.toContain('SERVICE_REQUEST_LIMIT_REACHED');
    expect(run.authentication?.serviceRequestLimitReached).toBe(false);
    // 管理画面の Desktop と Mobile の読み込みで、サービスへの 3 件がどれも届いた（ページの途中で断らない）。
    const listReads = backendRequests(site).filter(({ method, path }) => method === 'GET' && path.startsWith(`${SPA_BACKEND_PATHS.members}?select=`));
    expect(listReads.length).toBeGreaterThanOrEqual(3 * PRIMARY_LOADS_PER_PAGE);
    const [admin] = pageDocuments(runDirectory).filter(({ pageUrl }) => pageUrl.endsWith(SPA_APP_PATHS.admin));
    expect(admin?.viewports['desktop']?.status).toBe('AUDITED');
    expect(admin?.viewports['mobile']?.status).toBe('AUDITED');
    // 待った回数と時間が `run.json` と知らせに出る。1 回の待ちは 1 分以内。待った時間は、注入した待ちの合計。
    const waits = run.authentication?.serviceRequestPacingWaits ?? 0;
    expect(waits).toBeGreaterThan(0);
    const pacingNotices = notices.filter((notice) => notice.kind === 'SERVICE_REQUEST_PACING_WAIT');
    expect(pacingNotices).toHaveLength(waits);
    expect(pacingNotices.every(({ waitMs }) => waitMs > 0 && waitMs <= LOAD_PEAK_WINDOW_MS)).toBe(true);
    expect(pacingNotices.at(-1)).toMatchObject({ waitCount: waits, totalWaitMs: run.authentication?.serviceRequestPacingWaitMs });
    expect(run.authentication?.serviceRequestPacingWaitMs).toBe(pacingNotices.reduce((sum, { waitMs }) => sum + waitMs, 0));
    expect(clock.sleeps).toEqual(expect.arrayContaining(pacingNotices.map(({ waitMs }) => waitMs)));
  }, TEST_TIMEOUT_MS);

  // DEF-141（設計書 2.3）: 1 回の Run あたりの上限は今どおり止める（1 分あたりの上限で待った後でも）。再開をまたいでも、届いた数の合計は Run の上限を超えない。
  it('stops at the per run limit after waiting by the per minute limit, keeping the total within the limit across the resume (DEF-141)', async () => {
    const site = await startSite({ emailFilterRead: true });
    site.addMember(SECOND_NAME);
    const auditStage = auditStageOf(site, [], MINUTE_LIMITS);
    const name = `minute-${runCount}`;
    const first = await auditAdmin(site, name, { auditStage, fastClock: true });
    expect(first.run.runStatus).toBe('PARTIAL');
    expect(first.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    expect(first.run.authentication?.serviceRequestLimitReached).toBe(true);
    expect(first.run.authentication?.serviceRequestPacingWaits).toBeGreaterThan(0);
    await wait(LATE_REQUEST_WAIT_MS);
    const afterFirst = backendRequests(site).length;
    expect(afterFirst).toBeLessThanOrEqual(MINUTE_LIMITS.perRun);
    const second = await auditAdmin(site, name, { auditStage, startNew: false, fastClock: true });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(second.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    expect(backendRequests(site).length).toBeLessThanOrEqual(MINUTE_LIMITS.perRun);
    // 待った回数と時間は、再開をまたいで足す（前の実行の数より小さくならない）。
    expect(second.run.authentication?.serviceRequestPacingWaits).toBeGreaterThanOrEqual(first.run.authentication?.serviceRequestPacingWaits ?? 0);
  }, TEST_TIMEOUT_MS);

  /** 最初の実行の保存（`checkpoint/state.json`）の負荷の記録を書き換える（T35R2-fix の M-1。保存の改ざんの代わり）。 */
  const tamperCheckpointLoad = (runDirectory: string, change: (load: Record<string, unknown>) => void): void => {
    const statePath = join(runDirectory, CHECKPOINT_ARTIFACT_DIRECTORY, CHECKPOINT_ARTIFACT_FILE_NAMES.state);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { readonly load: Record<string, unknown> };
    change(state.load);
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
  };

  // T35R2-fix（T35R2 の M-1）: 保存の上限の数を小さく書き換えても、負荷の記録（`approvedServiceOrigins.count`）の大きい方から数えるので、再開で上限を
  // 超えない。
  it('resumes from the larger count of the checkpoint and the load record of the service origins', async () => {
    const site = await startSite();
    site.addMember(SECOND_NAME);
    const auditStage = auditStageOf(site, [], SMALL_LIMITS);
    const name = `tamper-lower-${runCount}`;
    const first = await auditAdmin(site, name, { auditStage });
    expect(first.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    tamperCheckpointLoad(first.runDirectory, (load) => {
      const counts = load['auditStageCounts'] as Record<string, number>;
      counts['serviceRequestsAdmitted'] = 0;
      counts['serviceRequestLimitRefused'] = 0;
    });
    await auditAdmin(site, name, { auditStage, startNew: false });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendRequests(site).length).toBeLessThanOrEqual(SMALL_LIMITS.perRun);
  }, TEST_TIMEOUT_MS);

  // T35R2-fix（T35R2 の M-1）: 監査の段の口がある Run で、保存に監査の段の数がなければ、再開しない（理由つきの例外で止め、サービスの Origin に届かない）。
  it('does not resume a checkpoint without the counts of the audit stage', async () => {
    const site = await startSite();
    site.addMember(SECOND_NAME);
    const auditStage = auditStageOf(site, [], SMALL_LIMITS);
    const name = `tamper-delete-${runCount}`;
    const first = await auditAdmin(site, name, { auditStage });
    expect(first.run.executions.at(-1)?.endReason).toBe('STOPPED_BY_SERVICE_REQUEST_LIMIT');
    tamperCheckpointLoad(first.runDirectory, (load) => {
      delete load['auditStageCounts'];
      delete load['approvedServiceOrigins'];
    });
    const afterFirst = backendRequests(site).length;
    await expect(auditAdmin(site, name, { auditStage, startNew: false })).rejects.toThrow(/AUDIT_STAGE_COUNTS_MISSING/u);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(backendRequests(site).length).toBe(afterFirst);
  }, TEST_TIMEOUT_MS);

  it('stops by the session loss when the login state key disappears', async () => {
    const site = await startSite({ clearSessionAfterList: true });
    const { run } = await auditAdmin(site, `key-${runCount}`, { auditStage: auditStageOf(site, []) });
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(run.incompleteReasons.map(({ code }) => code)).toContain('AUTH_SESSION_LOST');
  }, TEST_TIMEOUT_MS);

  it('records the number of 401 responses of the service origin in run.json', async () => {
    const site = await startSite({ tokenLifetimeMs: EXPIRED_TOKEN_LIFETIME_MS });
    const { run } = await auditAdmin(site, `unauthorized-${runCount}`, { auditStage: auditStageOf(site, []), excludedPaths: ['/admin/members'] });
    expect(run.authentication?.serviceUnauthorizedResponses).toBeGreaterThan(0);
    expect(backendRequests(site).every((request) => request.bearerValid !== true)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
