// T35c（Task 35 の設計書 3.4〜3.7、4 章、5 章の 1〜5）: スクリプトで送るログインの監査の Run（監査の中核 `executeAuditRun` に、監査の段の口つきの
// 認証の指定 `RunAuthentication` を渡す。ワーカーと同じ形）。安全の漏れの確かめの場面は、テストの既定の headless と CLI の起動の設定の両方で、
// ほかは既定の Chromium だけで流す。
// - 登録した読み取りの手続きの呼び出しは、Desktop と Mobile の読み込みの回数の中で届き、token の更新・計測の送信・WebSocket は届かない。範囲を `/admin`
//   に絞っても `/app.js` は読める。`run.json` に監査の段の数と、承認したサービスの Origin の区分がある。
// - 保存に監査の段の数がなければ、再開しない。
// - ログインの状態の鍵が消えると、セッションの切れで止まる。401 の数が `run.json` に出る。
// - 成果物（ZIP の中身を含む）に、サービスの Origin の URL の query の値（会員のメールアドレス）、token、API の鍵、資格情報が出ない。
// 届いたかは fixture の記録で数える。各 Run の後に、名前つきの時間（`LATE_REQUEST_WAIT_MS`）だけ待ってから数え直す。値は出力しない。
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import { executeAuditRun, type AuditRunOutcome } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { CHECKPOINT_ARTIFACT_DIRECTORY, CHECKPOINT_ARTIFACT_FILE_NAMES, PAGES_ARTIFACT_DIRECTORY } from '../../src/core/artifact-layout.js';
import type { RunSummary } from '../../src/core/contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { BOTH_CHROMIUM_LAUNCHERS, DEFAULT_CHROMIUM_LAUNCHERS, type BothChromiumLauncher } from '../helpers/chromium.js';
import { filesUnder, nonReadRequestsOf, placesWithMarkers } from '../helpers/leak-places.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { createQuietLimitedRunCoordinator, fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
} from '../helpers/spa-auth-site-fixture.js';

const TEST_TIMEOUT_MS = 240_000;
/** 各 Run の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 監査の段の token の更新までの時間（ms。ページの監査の間に送られる短さ）。 */
const SHORT_REFRESH_MS = 50;
/** 期限の切れた token（401 を受ける）の有効期限（ms）。 */
const EXPIRED_TOKEN_LIFETIME_MS = 1;
const MAX_PAGES = 6;
const ONE_PER_LOAD = 1;
/** 1 ページの最初の読み込み（Desktop と Mobile）の数。 */
const PRIMARY_LOADS_PER_PAGE = 2;
const EXISTING_NAME = '既存花子';
const SECOND_NAME = '二番次郎';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });

/**
 * 1 つの describe の中で、サイト・作業場所・Run の口を用意する（安全の漏れの組と、既定の Chromium だけの組で同じ口を使う）。`runNumber` は、出力先の名前に
 * 使う、これまでの Run の数。
 */
function useSpaAuditRun(launch: BothChromiumLauncher) {
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

  const auditStageOf = (site: SpaAuthSite, reads: readonly string[]): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: reads.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerPageLoad: ONE_PER_LOAD })),
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
  });

  /** 監査の段の口つきの認証の指定で、`/admin` から監査する（`name` は出力先）。 */
  const auditAdmin = async (
    site: SpaAuthSite,
    name: string,
    options: {
      readonly auditStage: AuditStageServiceRequests;
      readonly auditPathPrefixes?: readonly string[];
      readonly excludedPaths?: readonly string[];
      readonly startNew?: boolean;
      /** L11: 止める印（再開できる止まった実行を作るため）。 */
      readonly stopSignal?: AbortSignal;
    },
  ): Promise<{ readonly outcome: AuditRunOutcome; readonly runDirectory: string; readonly run: RunSummary }> => {
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
    const outcome = await executeAuditRun(config, {
      launchBrowser: () => launch(),
      clock: () => new Date(),
      now: () => Date.now(),
      ...(options.stopSignal === undefined ? {} : { stopSignal: options.stopSignal }),
      authentication,
      // DEF-245 の A: 見張りの反応なしの長さを短くする（本番は 180 秒）。
      createRunCoordinator: createQuietLimitedRunCoordinator,
    }, { startNew: options.startNew ?? true }, {});
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    // TEST-TIME-B（案 9）: Run は Browser を閉じて終わるので、受けている途中の要求が 0 になってから短い余白だけ待つ（上限は前の固定の待ち）。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, site);
    const run = JSON.parse(readFileSync(join(outcome.runDirectory, 'run.json'), 'utf8')) as RunSummary;
    return { outcome, runDirectory: outcome.runDirectory, run };
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

  return { startSite, auditStageOf, auditAdmin, backendRequests, backendNonReads, pageDocuments, visibleText, runNumber: (): number => runCount };
}

// TEST-SLIM M2: 読み取りでない要求（token の更新・計測の送信・WebSocket）が届かず、成果物に秘密が出ない場面は、2 つの Chromium で流す（安全の漏れの確かめ）。
describe.each(BOTH_CHROMIUM_LAUNCHERS)('T35c: the audit Run of the script login audit, the requests and values that must not leak, with %s', (_label, launch) => {
  const { startSite, auditStageOf, auditAdmin, backendRequests, backendNonReads, pageDocuments, visibleText, runNumber } = useSpaAuditRun(launch);

  // FIN-1: この Run の送信の扱いは、テストの設定の既定（`createTestConfig` の READ_ONLY）。
  it('READ_ONLY: reads the list by the registered calls on the Desktop and Mobile loads; blocks the refresh and the beacon, lets the WebSocket through; leaks nothing', async () => {
    const site = await startSite({
      rpcReads: true, preLoginRpc: 'required', refreshAfterMs: SHORT_REFRESH_MS, rumBeacon: true, websocket: true, emailFilterRead: true,
    });
    const memberEmail = site.memberOf(1)?.email ?? '';
    const { run, runDirectory } = await auditAdmin(site, `complete-${runNumber()}`, {
      auditStage: auditStageOf(site, [SPA_BACKEND_PATHS.rpcListMembers, SPA_BACKEND_PATHS.rpcResolveTenant]),
      auditPathPrefixes: [SPA_APP_PATHS.admin],
      excludedPaths: ['/admin/members'],
    });
    expect(run.runStatus).toBe('COMPLETE');
    expect(run.executions.at(-1)?.endReason).toBe('COMPLETED');
    // 範囲を `/admin` に絞っても、範囲の外の静的な資源（アプリのスクリプト）は読める。
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script).length).toBeGreaterThan(0);
    // 届いた読み取りでない要求は、登録した手続きの呼び出しと、監査の WebSocket（FIN-1・WSO: 監査の段の WebSocket は止めない）だけ（Desktop と Mobile の
    // 読み込みに 1 回ずつ）。
    expect([...backendNonReads(site)].sort()).toEqual([
      ...Array.from({ length: PRIMARY_LOADS_PER_PAGE }, () => `POST ${SPA_BACKEND_PATHS.rpcListMembers}`),
      ...Array.from({ length: PRIMARY_LOADS_PER_PAGE }, () => `POST ${SPA_BACKEND_PATHS.rpcResolveTenant}`),
      ...Array.from({ length: PRIMARY_LOADS_PER_PAGE }, () => `UPGRADE ${SPA_BACKEND_PATHS.realtime}`),
    ].sort());
    expect(site.refreshes).toBe(0);
    expect(site.rumBeacons).toBe(0);
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
});

// L11（設計書 `2026-11-09-beaksight-remove-limits-design.md` 4）: 要求の上限（1 分あたりで待つ・1 回の Run の上限で止める）の撤廃は
// 単体 `service-request-budget.test.ts`・`service-request-limit-run.test.ts` が確かめる。
describe.each(DEFAULT_CHROMIUM_LAUNCHERS)('T35c: the audit Run of the script login audit with %s', (_label, launch) => {
  const { startSite, auditStageOf, auditAdmin, backendRequests, runNumber } = useSpaAuditRun(launch);

  /** 最初の実行の保存（`checkpoint/state.json`）の負荷の記録を書き換える（T35R2-fix の M-1。保存の改ざんの代わり）。 */
  const tamperCheckpointLoad = (runDirectory: string, change: (load: Record<string, unknown>) => void): void => {
    const statePath = join(runDirectory, CHECKPOINT_ARTIFACT_DIRECTORY, CHECKPOINT_ARTIFACT_FILE_NAMES.state);
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as { readonly load: Record<string, unknown> };
    change(state.load);
    writeFileSync(statePath, JSON.stringify(state), 'utf8');
  };

  // L11 で意図して捨てた場面: 「保存の上限の数を小さく書き換えても、再開で 1 回の Run の上限を超えない」（T35R2-fix の M-1）は、守る上限がなくなったので確かめない。
  // 数を大きい方から引き継ぐ決まりそのものは、単体のテスト（`tests/unit/audit-stage-review-fixes.test.ts` の `resumedAuditStageCounts`）で確かめている。

  // T35R2-fix（T35R2 の M-1）: 監査の段の口がある Run で、保存に監査の段の数がなければ、再開しない（理由つきの例外で止め、サービスの Origin に届かない）。
  // L11 で直した: 上限で止まる実行は作れなくなったので、止める印（始める前に立てる）で、再開できる止まった実行を作る。
  it('does not resume a checkpoint without the counts of the audit stage', async () => {
    const site = await startSite();
    site.addMember(SECOND_NAME);
    const auditStage = auditStageOf(site, []);
    const name = `tamper-delete-${runNumber()}`;
    const stop = new AbortController();
    stop.abort();
    const first = await auditAdmin(site, name, { auditStage, stopSignal: stop.signal });
    expect(first.run.executions.at(-1)?.endReason).not.toBe('COMPLETED');
    tamperCheckpointLoad(first.runDirectory, (load) => {
      delete load['auditStageCounts'];
      delete load['approvedServiceOrigins'];
    });
    const afterFirst = backendRequests(site).length;
    await expect(auditAdmin(site, name, { auditStage, startNew: false })).rejects.toThrow(/AUDIT_STAGE_COUNTS_MISSING/u);
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, site);
    expect(backendRequests(site).length).toBe(afterFirst);
  }, TEST_TIMEOUT_MS);

  it('stops by the session loss when the login state key disappears', async () => {
    const site = await startSite({ clearSessionAfterList: true });
    const { run } = await auditAdmin(site, `key-${runNumber()}`, { auditStage: auditStageOf(site, []) });
    expect(run.runStatus).toBe('PARTIAL');
    expect(run.executions.at(-1)?.endReason).toBe('STOPPED_BY_AUTH_SESSION_LOST');
    expect(run.incompleteReasons.map(({ code }) => code)).toContain('AUTH_SESSION_LOST');
  }, TEST_TIMEOUT_MS);

  it('records the number of 401 responses of the service origin in run.json', async () => {
    const site = await startSite({ tokenLifetimeMs: EXPIRED_TOKEN_LIFETIME_MS });
    const { run } = await auditAdmin(site, `unauthorized-${runNumber()}`, { auditStage: auditStageOf(site, []), excludedPaths: ['/admin/members'] });
    expect(run.authentication?.serviceUnauthorizedResponses).toBeGreaterThan(0);
    expect(backendRequests(site).every((request) => request.bearerValid !== true)).toBe(true);
  }, TEST_TIMEOUT_MS);
});
