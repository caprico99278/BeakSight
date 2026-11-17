// T33c（Task 33 の設計書 `2026-10-16-beaksight-task-33-observation-fixture-design.md` 3.3、6 章の G33 の 3）・T35c: スクリプトで送るログインの SPA
// （`tests/helpers/spa-auth-site-fixture.ts`）の監査の段で、登録のない手続きの呼び出し・token の更新・WebSocket・計測の送信が届かず、秘密が成果物に出ないこと。
// 通す部品（どれも本物。Chromium は入口 `BOTH_CHROMIUM_LAUNCHERS` で選ぶ）:
// - 監査の段: 監査の中核 `executeAuditRun`（認証つきの Run の指定 `RunAuthentication` で、ワーカーと同じ形。状態は `issueStoredSession()` の
//   値を、アプリの Origin の localStorage に入れたもの。絞り込みは `filterAuthenticatedState`）。Run のディレクトリの成果物（`page.json` の Safety の
//   Evidence、`visible-text.txt`、ほかのすべてのファイル）を読む。
// - C8（監査の段）: 実テスト環境の観察の形（テナントを決める手続きの呼び出し、アプリの Origin への計測の送信）を、fixture の指定（`preLoginRpc`・
//   `rumBeacon`）で再現して固定する。
// - SLIM-GROUP L-4: ログインの段の場面（前の C1a・C1b・C7a・C7b）は、同じ Guard と段の写しなので消した（`guard-script-login.test.ts` の :204・:233・:249・:325、
//   `script-login-worker-stage.test.ts` の :178・:199）。C2b は C2 に、C4（登録した読み取りの呼び出しが届く）は C8a に畳んだ。
// 全部の回の後に、サーバが静まるまで（`LATE_REQUEST_WAIT_MS` まで）待ってから、fixture の記録を数え直す。値（資格情報、token、API の鍵）は出力しない。
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { PAGES_ARTIFACT_DIRECTORY } from '../../src/core/artifact-layout.js';
import type { SafetyEventsEvidence } from '../../src/core/evidence-types.js';
import { REDACTED } from '../../src/core/redaction.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { BOTH_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { filesUnder, placesWithMarkers } from '../helpers/leak-places.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_GRANT_TYPES,
  SPA_STATE_ELEMENTS,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaAuthSiteRequest,
} from '../helpers/spa-auth-site-fixture.js';

/** 1 つの場面の上限（ms。監査の中核の Run を含む）。 */
const TEST_TIMEOUT_MS = 180_000;
/** 全部の回の後に、遅れて届く要求を待つ時間の上限（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** ログインの送信の回数の上限（認証の設定の値）。 */
const MAX_LOGIN_ATTEMPTS = 1;
/** 監査の段の token の更新までの時間（ms。ページの監査の間に送られる短さ）。 */
const SHORT_REFRESH_MS = 100;
/** 監査するページの数（`/admin` だけ）。 */
const AUDIT_MAX_PAGES = 1;
/** fixture の既存の会員の名前（一覧が出たかを、見えている文字で確かめる）。 */
const EXISTING_NAME = '既存花子';

/** T35c: 成果物では、承認したサービスの Origin の URL の query の値をすべて伏せる（名前は残す）。 */
const redactedRefreshTokenPath = `${SPA_BACKEND_PATHS.token}?grant_type=${REDACTED}`;
const listPath = `${SPA_BACKEND_PATHS.members}?select=*`;

/** アプリの Origin でない Origin（バックエンド・認証・ほか）に届いた要求。 */
const backendRequestsOf = (spa: SpaAuthSite): readonly SpaAuthSiteRequest[] => spa.requests.filter((request) => request.origin !== 'app');

/** 監査とログインの設定（開始の URL と、許可 Origin。許可 Origin は、アプリと token・API のバックエンドの 2 つ）。 */
const configOf = (spa: SpaAuthSite, startPath: string, base: AuditConfig): AuditConfig => ({
  ...base,
  site: { startUrl: `${spa.appOrigin}${startPath}`, allowedOrigins: [spa.appOrigin, spa.tokenOrigin] },
});

/** 認証の設定（送信先に token の送信先を登録する。成功の条件は管理画面の一覧の表）。 */
const setupOf = (spa: SpaAuthSite): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-spa',
  profileRevision: 1,
  loginStartUrl: `${spa.appOrigin}${SPA_APP_PATHS.auth}`,
  loginPostEndpoints: [{ origin: spa.tokenOrigin, path: SPA_BACKEND_PATHS.token }],
  successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: `#${SPA_STATE_ELEMENTS.members}` },
  sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
  excludedPaths: [SPA_APP_PATHS.logout],
  auditPathPrefixes: [],
  maxLoginAttempts: MAX_LOGIN_ATTEMPTS,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** Run のディレクトリの、すべての `page.json` の Safety の Evidence。 */
const safetyEvidenceOf = (runDirectory: string): readonly SafetyEventsEvidence[] => {
  const pagesDirectory = join(runDirectory, PAGES_ARTIFACT_DIRECTORY);
  return readdirSync(pagesDirectory).flatMap((pageId) => {
    const document = JSON.parse(readFileSync(join(pagesDirectory, pageId, 'page.json'), 'utf8')) as {
      readonly evidence: readonly { readonly type: string; readonly payload: unknown }[];
    };
    return document.evidence.filter(({ type }) => type === 'safety').map(({ payload }) => payload as SafetyEventsEvidence);
  });
};

/** Run のディレクトリの、すべてのページの見えている文字（つないだもの）。 */
const visibleTextOf = (runDirectory: string): string => {
  const pagesDirectory = join(runDirectory, PAGES_ARTIFACT_DIRECTORY);
  return readdirSync(pagesDirectory)
    .filter((pageId) => existsSync(join(pagesDirectory, pageId, 'visible-text.txt')))
    .map((pageId) => readFileSync(join(pagesDirectory, pageId, 'visible-text.txt'), 'utf8')).join('\n');
};

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T33c・T35c: the audit stage of the script login SPA with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  // SLIM-2（X7）: 監査の Run ごとに Chromium を起こし直さない（Run は自分の Context だけを閉じる）。
  const runBrowser = useSharedRunBrowser(() => launch());

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-spa-baseline-'));
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

  /** 監査の中核で、認証済みの状態（localStorage）から `/admin` を監査する。Run のディレクトリを返す。 */
  /**
   * T35c（Task 35 の設計書 3.2〜3.4、5 章の 1・2）: `scriptAudit` を渡すと、スクリプトで送るログインの監査の Run（許可 Origin はアプリの Origin だけ、
   * token と API のバックエンドは承認したサービスの Origin、監査の段の口 `auditStage` に登録した読み取りの手続きの呼び出し `reads`）で監査する。
   */
  const auditAdmin = async (
    site: SpaAuthSite,
    name: string,
    auditPathPrefixes: readonly string[] = [],
    scriptAudit?: { readonly reads: readonly string[] },
  ): Promise<string> => {
    const setup = setupOf(site);
    const approvedTestOrigins = scriptAudit === undefined ? [site.appOrigin, site.tokenOrigin] : [site.appOrigin];
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
      approvedTestOrigins,
      auditExclusions: { excludedPathPrefixes: setup.excludedPaths, auditPathPrefixes, dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      ...(scriptAudit === undefined
        ? {}
        : {
          auditStage: {
            approvedServiceOrigins: [site.tokenOrigin],
            auditReadRequests: scriptAudit.reads.map((path) => ({ origin: site.backendOrigin, path, method: 'POST', maxPerPageLoad: 1 })),
            scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },          },
        }),
    };
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `spa-${name}` }, output: { directory: join(workDirectory, name) }, crawl: { maxPages: AUDIT_MAX_PAGES },
      // SLIM-GROUP L-4: 確かめるのは届いた要求と止めた記録だけなので、性能と accessibility の収集は外す（Desktop と Mobile の読み込みは残す）。
      audit: { performance: false, accessibility: false },
    });
    const config: AuditConfig = scriptAudit === undefined
      ? configOf(site, SPA_APP_PATHS.admin, base)
      : { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const outcome = await executeAuditRun(config, {
      launchBrowser: runBrowser, clock: () => new Date(), now: () => Date.now(), authentication,
    }, { startNew: true });
    expect(outcome.kind).toBe('RAN');
    if (outcome.kind !== 'RAN') {
      throw new Error(`the audit did not run: ${outcome.kind}`);
    }
    // SLIM-2（X1）: Run は自分の Context を閉じて終わるので、閉じた後の数え直しの待ちは、サーバが静まるまで。
    await settleLateDeliveries(LATE_REQUEST_WAIT_MS, site);
    return outcome.runDirectory;
  };

  /** C6: Run のディレクトリのすべてのファイル（ZIP の中身を含む）に、資格情報と token の目印が出ない。API の鍵が出た場所を返す（固定する）。 */
  const expectNoSecretIn = (site: SpaAuthSite, runDirectory: string): readonly string[] => {
    const places = filesUnder(runDirectory);
    expect(places.length).toBeGreaterThan(0);
    const apiKey = site.apiKeyMarker();
    const others = site.secretValues().filter((value) => value !== apiKey);
    expect(placesWithMarkers(places, others)).toEqual([]);
    return placesWithMarkers(places, [apiKey]).map((place) => place.slice(runDirectory.length + 1).split('\\').join('/'));
  };

  // T35c（Task 35 の設計書 3.3、5 章の 1）: スクリプトで送るログインの監査の Run は、読む範囲を `/admin` に絞っても、範囲の外のアプリのスクリプトと一覧を読む
  // （前の C2b を畳んだ）。届いたのは一覧の GET だけ（Bearer つき）。事前確認は Guard が満たし、バックエンドに届かない。
  it('C2: the audit stage from the stored state, with the read range narrowed to /admin, reads the app script and the list with the Bearer; nothing else reaches the backend', async () => {
    const site = await startSite();
    const runDirectory = await auditAdmin(site, 'c2', [SPA_APP_PATHS.admin], { reads: [] });
    const backend = backendRequestsOf(site);
    expect(backend.length).toBeGreaterThan(0);
    expect(backend.filter((request) => !(request.origin === 'backend' && request.method === 'GET' && request.path === listPath && !request.preflight)))
      .toEqual([]);
    expect(backend.every((request) => request.bearerValid === true)).toBe(true);
    expect(site.requests.filter((request) => request.origin === 'app' && request.path === SPA_APP_PATHS.script).length).toBeGreaterThan(0);
    const excluded = safetyEvidenceOf(runDirectory).flatMap((safety) => safety.blockedAuditExclusions?.events ?? []);
    expect(excluded.some(({ url }) => url === `${site.appOrigin}${SPA_APP_PATHS.script}`)).toBe(false);
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(safetyEvidenceOf(runDirectory).flatMap((safety) => [...safety.blockedRequests, ...safety.blockedWebSockets])).toEqual([]);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T35c で意図して直した期待（Task 35 の設計書 3.6・3.7、5 章の 2）: 止めた token の更新の数が、`run.json` の `authentication` にも残る（スクリプトで
  // 送るログインの監査の Run）。止めて page.json に記録することは前のまま。token の Origin は承認したサービスの Origin なので、page.json の URL は
  // query の値を伏せる（前は `grant_type` の値が見えた）。
  it('C3: the token refresh POST of the audit stage is blocked, recorded in page.json and counted in run.json; it never reaches the backend', async () => {
    const site = await startSite({ refreshAfterMs: SHORT_REFRESH_MS });
    const runDirectory = await auditAdmin(site, 'c3', [], { reads: [] });
    const run = JSON.parse(readFileSync(join(runDirectory, 'run.json'), 'utf8')) as { readonly authentication?: { readonly tokenRefreshBlocked: number } };
    expect(run.authentication?.tokenRefreshBlocked).toBeGreaterThan(0);
    expect(backendRequestsOf(site).filter((request) => request.method !== 'GET')).toEqual([]);
    expect(site.refreshes).toBe(0);
    const blocked = safetyEvidenceOf(runDirectory).flatMap((safety) => safety.blockedRequests);
    expect(blocked.length).toBeGreaterThan(0);
    expect(new Set(blocked.map(({ method, url, reason }) => JSON.stringify([method, url, reason]))))
      .toEqual(new Set([JSON.stringify(['POST', `${site.tokenOrigin}${redactedRefreshTokenPath}`, 'NON_READ_METHOD'])]));
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // FIN-1（WSO・SD-2）: 監査の段の WebSocket は止めない（届き、止めた記録はない）。秘密は成果物に出ない。
  it('C5: the WebSocket of the admin screen reaches the backend on the audit stage and is not recorded as stopped', async () => {
    const site = await startSite({ websocket: true });
    const runDirectory = await auditAdmin(site, 'c5');
    expect(backendRequestsOf(site).filter((request) => request.method === 'UPGRADE').length).toBeGreaterThan(0);
    expect(safetyEvidenceOf(runDirectory).flatMap((safety) => safety.blockedWebSockets)).toEqual([]);
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  /** Run のディレクトリの、すべてのページの止めた要求（`<method> <URL> <理由>` の集合）。 */
  const blockedRequestSetOf = (runDirectory: string): ReadonlySet<string> => new Set(safetyEvidenceOf(runDirectory)
    .flatMap((safety) => safety.blockedRequests).map(({ method, url, reason }) => `${method} ${url} ${reason}`));

  // T35c で意図して直した期待（Task 35 の設計書 3.2、5 章の 2）: 前は、テナントを決める手続きの呼び出し（必須）が止まり、一覧を読まなかった。登録すれば
  // Desktop と Mobile の読み込みで 1 回ずつ届き、一覧を読む。止めて記録するのは計測の送信だけ（今どおり）。
  it('C8a: on the audit stage, the registered tenant RPC (required) reaches the backend and the list is read; the measurement beacon is blocked', async () => {
    const site = await startSite({ preLoginRpc: 'required', rumBeacon: true, postLoginFunction: 'continueOnFailure' });
    const runDirectory = await auditAdmin(site, 'c8a', [], { reads: [SPA_BACKEND_PATHS.rpcResolveTenant] });
    expect(backendRequestsOf(site).filter(({ method }) => method === 'POST').map(({ path }) => path))
      .toEqual([SPA_BACKEND_PATHS.rpcResolveTenant, SPA_BACKEND_PATHS.rpcResolveTenant]);
    expect(site.rumBeacons).toBe(0);
    // サーバの関数の呼び出しは、ログインの直後だけに出る（`/admin` の読み込みでは出ない）ので、監査の段の記録にない。
    expect(site.functionCalls).toBe(0);
    expect(blockedRequestSetOf(runDirectory)).toEqual(new Set([`POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`]));
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T35c: スクリプトで送るログインの監査の Run で、手続きの呼び出しを登録しないときは、前と同じく止まる（期待は前のまま）。
  it('C8b: on the audit stage, with the tenant RPC optional, the RPC and the beacon are blocked but the list is read with the Bearer', async () => {
    const site = await startSite({ preLoginRpc: 'optional', rumBeacon: true });
    const runDirectory = await auditAdmin(site, 'c8b', [], { reads: [] });
    const backend = backendRequestsOf(site);
    expect(backend.length).toBeGreaterThan(0);
    expect(backend.filter((request) => !(request.method === 'GET' && request.path === listPath && request.bearerValid === true))).toEqual([]);
    expect(blockedRequestSetOf(runDirectory)).toEqual(new Set([
      `POST ${site.appOrigin}${SPA_APP_PATHS.rum} NON_READ_METHOD`,
      `POST ${site.backendOrigin}${SPA_BACKEND_PATHS.rpcResolveTenant} NON_READ_METHOD`,
    ]));
    expect(visibleTextOf(runDirectory)).toContain(EXISTING_NAME);
    expect(expectNoSecretIn(site, runDirectory)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
