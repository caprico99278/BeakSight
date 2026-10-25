// T37b（Task 37 の設計書 3.2 の「Guard の観察の形」、3.3、4 章、6 章の 1〜3・6）: 凍結した PRIMARY の Context で、送らずに観察する probe の口。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: 認証つきの `BrowserContextFactory`（監査の段の口。バックエンドを
// 承認したサービスの Origin（承認した API の Origin）にする）と、その Guard と中継。サイトは fixture（`startSpaAuthSite` の form のない会員の画面と、
// 敵対的な保存）。押すのはテスト（Playwright の `click`。押す部品は T37c が作る）。
// - 口が有効の間: 承認した API の Origin への事前確認は Guard が満たし、本番の要求は止まり（凍結の後の止めた記録にも入る）、型が口に届く。分類で
//   登録は `API_CREATE`、更新は `API_UPDATE`、敵対的な保存は `NOT_EXECUTABLE`（理由つき。画面を移る保存は `NO_REQUEST`）。
// - 口が無効のとき: 今どおり事前確認も止まり、型は届かない。ほかの Origin の事前確認は、口が有効でも止まる。
// - 安全の条件: 押した後にサーバへ届いた要求は 0（事前確認を含む。fixture の記録で数える）、違反 0、全部の後に名前つきの時間だけ待って数え直す。止める
//   経路が働いた証拠（凍結の後の止めた記録）がある。目印・本文の値・秘密のヘッダの値は、型・記録・例外に出ない（値は出力しない）。
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import { classifyApiShapeObservation } from '../../src/discovery/api-shape-classification.js';
import { AuditStageMonitor, activateInteractionFreeze } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import type { SubmissionObservation, SubmissionObservationResult } from '../../src/safety/submission-observation.js';
import { closeTestContexts, launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_FORMLESS_MEMBER_BOX,
  SPA_GRANT_TYPES,
  SPA_HOSTILE_SAVE_PATHS,
  SPA_MEMBER_FIELDS,
  SPA_STATE_ELEMENTS,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaHostileMemberSave,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 120_000;
const UI_TIMEOUT_MS = 15_000;
/** 押した後、ページの要求が静まるまで待つ時間（ms。設計書 3.2 の既定 2 秒より短い、テストの値）。 */
const QUIET_WAIT_MS = 500;
/** 全部の後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const EXISTING_NAME = '既存花子';
/** 欄に入れる目印（probe の合成の値と同じ形。秘密ではないが、型・記録・例外に値が出ないことを確かめる）。 */
const MARKERS = Object.freeze({ name: 'bsprobeNameK4q', email: 'bsprobeMailR8w@example.invalid', note: 'bsprobeNoteT2z' });
const MARKER_LIST = Object.freeze([MARKERS.name, MARKERS.email, MARKERS.note]);

describe.each(LAUNCHERS)('T37b: the submission observation of the frozen Guard with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await closeTestContexts(browser);
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startSite = async (options: SpaAuthSiteOptions): Promise<{ readonly site: SpaAuthSite; readonly memberId: number }> => {
    spa = await startSpaAuthSite(options);
    return { site: spa, memberId: spa.addMember(EXISTING_NAME) };
  };

  const auditStageOf = (site: SpaAuthSite): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: [],
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: DEFAULT_LIMITS,
  });

  /** 認証つきの factory の PRIMARY の Context で、form のない会員の画面を開き、準備を待って凍結する。 */
  const openFrozenScreen = async (site: SpaAuthSite, pagePath: string) => {
    const base = fastRunConfig(site.appOrigin, pagePath);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${pagePath}`, allowedOrigins: [site.appOrigin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
        filterState: (state) => filterAuthenticatedState(state, [site.appOrigin]),
        auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        auditStage: auditStageOf(site),
      },
      serviceRequestBudget: createServiceRequestBudget({ ...DEFAULT_LIMITS, now: () => Date.now() }),
      auditStageMonitor: new AuditStageMonitor(),
    });
    factories.push(factory);
    const context: BrowserContext = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page: Page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${pagePath}`);
    await page.locator(`#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    await activateInteractionFreeze(page);
    const observation = factory.submissionObservationOf(context);
    if (observation === null) throw new Error('the PRIMARY Context has no submission observation');
    const ledger = () => factory.getSafetyLedger(context).snapshot();
    return { page, observation, ledger, pagePath };
  };

  /**
   * 欄に目印を入れて、保存を押し、ページの保存の処理が終わるのを待つ（送れなかった保存は `error` になる）。画面を移る保存（`navigateOnSave`）は、止めた
   * 移動の後に画面の状態が残らないことがあるので、状態を待たずに静まるまでの時間だけ待つ（`awaitSaveState` が偽）。
   */
  const fillAndPress = async (page: Page, awaitSaveState = true): Promise<void> => {
    await page.fill(SPA_MEMBER_FIELDS.name, MARKERS.name);
    await page.fill(SPA_MEMBER_FIELDS.email, MARKERS.email);
    await page.fill(SPA_MEMBER_FIELDS.note, MARKERS.note);
    await page.click(SPA_MEMBER_FIELDS.submit);
    if (awaitSaveState) {
      await page.locator(`#${SPA_STATE_ELEMENTS.member}[data-state="error"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    }
    await wait(QUIET_WAIT_MS);
  };

  /** 口を有効にして押し、結果を返す。 */
  const observePress = async (
    page: Page,
    observation: SubmissionObservation,
    pagePath: string,
    awaitSaveState = true,
  ): Promise<SubmissionObservationResult> => {
    observation.begin({ pagePath, markers: MARKER_LIST });
    await fillAndPress(page, awaitSaveState);
    return observation.end();
  };

  /** 値（目印、fixture の秘密）が、文字列のどこにも出ない。 */
  const expectNoValues = (site: SpaAuthSite, value: unknown): void => {
    const text = JSON.stringify(value);
    for (const secret of [...MARKER_LIST, ...site.secretValues()]) {
      expect(text.includes(secret)).toBe(false);
    }
  };

  /** 押す前の記録の数から、押した後にサーバへ届いた要求（事前確認を含む）。全部の後に待って数え直す。 */
  const reachedAfter = async (site: SpaAuthSite, before: number): Promise<readonly string[]> => {
    await wait(LATE_REQUEST_WAIT_MS);
    return site.requests.slice(before).map(({ origin, method, path }) => `${origin} ${method} ${path}`);
  };

  const frozenBlocked = (snapshot: ReturnType<SafetyLedger['snapshot']>): readonly string[] =>
    snapshot.blockedInteractionRequests.map(({ method, url, reason }) => `${method} ${url} ${reason}`);

  it('fulfills the preflight, blocks the POST of the formless create screen and receives its shape (API_CREATE); nothing reaches the server', async () => {
    const { site } = await startSite({ memberScreenLayout: 'formless' });
    const { page, observation, ledger, pagePath } = await openFrozenScreen(site, SPA_APP_PATHS.memberNew);
    const before = site.requests.length;
    const result = await observePress(page, observation, pagePath);
    expect(await reachedAfter(site, before)).toEqual([]);
    expect(result).toMatchObject({ nonReadRequestCount: 1, unrecordedShapeCount: 0 });
    expect(result.preflightsFulfilled).toBeGreaterThanOrEqual(1);
    expect(result.shapes[0]).toMatchObject({
      method: 'POST',
      origin: { kind: 'APPROVED_API', index: 0 },
      pathShape: SPA_BACKEND_PATHS.members,
      queryNames: [],
      filters: [],
      contentType: 'application/json',
      prefer: ['return=representation'],
      body: {
        kind: 'OBJECT',
        keys: [{ name: 'email', type: 'string' }, { name: 'name', type: 'string' }, { name: 'note', type: 'string' }],
        markerKeys: [{ key: 'email', markers: [1] }, { key: 'name', markers: [0] }, { key: 'note', markers: [2] }],
      },
    });
    expect(result.shapes[0]?.headerNames).toEqual(expect.arrayContaining(['apikey', 'authorization', 'content-type', 'prefer']));
    // 要求の種類は、Chromium が CDP の Request の段で伝える値のまま（`fetch` の呼び出しでも `xhr` と伝わることがある）。
    expect(['fetch', 'xhr']).toContain(result.shapes[0]?.resourceType);
    expect(classifyApiShapeObservation(result)).toMatchObject({ classification: 'API_CREATE', reason: null });
    const snapshot = ledger();
    expect(frozenBlocked(snapshot)).toContain(`POST ${site.backendOrigin}${SPA_BACKEND_PATHS.members} INTERACTION_FROZEN`);
    expect(frozenBlocked(snapshot).some((entry) => entry.startsWith('OPTIONS '))).toBe(false);
    expect(snapshot.invariantViolations).toEqual([]);
    expectNoValues(site, result);
    expectNoValues(site, snapshot);
    expect(site.memberCount).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('blocks the PATCH of the formless edit screen and receives its shape (API_UPDATE); nothing reaches the server', async () => {
    const { site, memberId } = await startSite({ memberScreenLayout: 'formless' });
    const { page, observation, ledger, pagePath } = await openFrozenScreen(site, spaMemberEditPathOf(memberId));
    const before = site.requests.length;
    const result = await observePress(page, observation, pagePath);
    expect(await reachedAfter(site, before)).toEqual([]);
    expect(result.preflightsFulfilled).toBeGreaterThanOrEqual(1);
    expect(result.shapes[0]).toMatchObject({
      method: 'PATCH',
      origin: { kind: 'APPROVED_API', index: 0 },
      pathShape: SPA_BACKEND_PATHS.members,
      queryNames: ['id'],
      filters: [{ name: 'id', operator: 'eq', valueMatchesPagePath: true }],
    });
    expect(classifyApiShapeObservation(result)).toMatchObject({ classification: 'API_UPDATE', reason: null });
    const snapshot = ledger();
    expect(frozenBlocked(snapshot)).toContain(`PATCH ${site.backendOrigin}${SPA_BACKEND_PATHS.members}?id=eq.${memberId} INTERACTION_FROZEN`);
    expect(snapshot.invariantViolations).toEqual([]);
    expectNoValues(site, result);
    expectNoValues(site, snapshot);
    expect(site.memberOf(memberId)?.name).toBe(EXISTING_NAME);
  }, TEST_TIMEOUT_MS);

  it('keeps blocking the preflight and receives no shape while the observation is inactive', async () => {
    const { site } = await startSite({ memberScreenLayout: 'formless' });
    const { page, observation, ledger } = await openFrozenScreen(site, SPA_APP_PATHS.memberNew);
    const before = site.requests.length;
    await fillAndPress(page);
    observation.begin({ pagePath: SPA_APP_PATHS.memberNew, markers: MARKER_LIST });
    const result = observation.end();
    expect(await reachedAfter(site, before)).toEqual([]);
    expect(result).toEqual({ shapes: [], nonReadRequestCount: 0, readRequestCount: 0, unrecordedShapeCount: 0, preflightsFulfilled: 0 });
    const snapshot = ledger();
    expect(frozenBlocked(snapshot)).toContain(`OPTIONS ${site.backendOrigin}${SPA_BACKEND_PATHS.members} INTERACTION_FROZEN`);
    expect(frozenBlocked(snapshot).some((entry) => entry.startsWith('POST '))).toBe(false);
    expect(snapshot.invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  /** 敵対的な保存の、分類の結果と理由（更新の画面で押す）。 */
  const HOSTILE_CASES: readonly (readonly [SpaHostileMemberSave, string, string | null])[] = [
    ['deleteOnSave', 'NOT_EXECUTABLE', 'DELETE_METHOD'],
    ['upsert', 'NOT_EXECUTABLE', 'UPSERT'],
    ['arrayBody', 'NOT_EXECUTABLE', 'ARRAY_BODY'],
    ['unfilteredPatch', 'NOT_EXECUTABLE', 'FILTER_MISSING'],
    ['rpcCall', 'NOT_EXECUTABLE', 'PROCEDURE_CALL_PATH'],
    ['doubleSend', 'NOT_EXECUTABLE', 'MULTIPLE_REQUESTS'],
    ['softDeleteKey', 'NOT_EXECUTABLE', 'SOFT_DELETE_KEY'],
    ['unapprovedOrigin', 'NOT_EXECUTABLE', 'UNAPPROVED_ORIGIN'],
    ['navigateOnSave', 'NO_REQUEST', null],
    // T37R2-fix-A（Task 37 の設計書 8 章の最後の行の M-1・M-2）。
    ['methodOverrideHeader', 'NOT_EXECUTABLE', 'METHOD_OVERRIDE'],
    ['bodyMethodOverride', 'NOT_EXECUTABLE', 'METHOD_OVERRIDE'],
    ['encodedRpcPath', 'NOT_EXECUTABLE', 'PROCEDURE_CALL_PATH'],
    ['paramRpcPath', 'NOT_EXECUTABLE', 'PROCEDURE_CALL_PATH'],
  ];

  it.each(HOSTILE_CASES)('classifies the hostile save %s as %s (%s); nothing reaches any server', async (hostile, classification, reason) => {
    const { site, memberId } = await startSite({ hostileMemberSave: hostile });
    const { page, observation, ledger, pagePath } = await openFrozenScreen(site, spaMemberEditPathOf(memberId));
    const before = site.requests.length;
    const result = await observePress(page, observation, pagePath, hostile !== 'navigateOnSave');
    expect(await reachedAfter(site, before)).toEqual([]);
    expect(classifyApiShapeObservation(result)).toMatchObject({ classification, reason });
    const snapshot = ledger();
    expect(snapshot.invariantViolations).toEqual([]);
    expect(snapshot.blockedInteractionRequests.length).toBeGreaterThan(0);
    expectNoValues(site, result);
    expectNoValues(site, snapshot);
    expect(site.memberOf(memberId)?.name).toBe(EXISTING_NAME);
    expect(site.memberCount).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('blocks the preflight to the unapproved Origin even while the observation is active (the real request is never sent)', async () => {
    const { site, memberId } = await startSite({ hostileMemberSave: 'unapprovedOrigin' });
    const { page, observation, ledger, pagePath } = await openFrozenScreen(site, spaMemberEditPathOf(memberId));
    const before = site.requests.length;
    const result = await observePress(page, observation, pagePath);
    expect(await reachedAfter(site, before)).toEqual([]);
    expect(result.preflightsFulfilled).toBe(0);
    expect(result.shapes.map(({ method, origin }) => `${method} ${origin.kind}`)).toEqual(['OPTIONS OTHER']);
    expect(frozenBlocked(ledger())).toContain(`OPTIONS ${site.otherOrigin}${SPA_BACKEND_PATHS.members}?id=eq.${memberId} INTERACTION_FROZEN`);
  }, TEST_TIMEOUT_MS);

  it('records what the probe-aware page really sent (another table, no marker in the body), not what it would send to a user', async () => {
    const { site, memberId } = await startSite({ hostileMemberSave: 'probeAware' });
    const { page, observation, pagePath } = await openFrozenScreen(site, spaMemberEditPathOf(memberId));
    const before = site.requests.length;
    const result = await observePress(page, observation, pagePath);
    expect(await reachedAfter(site, before)).toEqual([]);
    expect(result.shapes).toHaveLength(1);
    expect(result.shapes[0]).toMatchObject({ method: 'POST', pathShape: SPA_HOSTILE_SAVE_PATHS.membersShadow, body: { kind: 'OBJECT', keys: [], markerKeys: [] } });
    expectNoValues(site, result);
  }, TEST_TIMEOUT_MS);

  it('counts the blocked navigation of the save that moves to another screen as a read, with no shape', async () => {
    const { site, memberId } = await startSite({ hostileMemberSave: 'navigateOnSave' });
    const { page, observation, ledger, pagePath } = await openFrozenScreen(site, spaMemberEditPathOf(memberId));
    const before = site.requests.length;
    const result = await observePress(page, observation, pagePath, false);
    expect(await reachedAfter(site, before)).toEqual([]);
    expect(result).toMatchObject({ shapes: [], nonReadRequestCount: 0 });
    expect(result.readRequestCount).toBeGreaterThanOrEqual(1);
    expect(frozenBlocked(ledger())).toContain(`GET ${site.appOrigin}${SPA_APP_PATHS.admin} INTERACTION_FROZEN`);
    // 止めた移動は一覧の画面を読まない（main frame の URL が変わったかの見分けと `PAGE_CHANGED` は、押す部品の T37c が決める）。
    expect(page.url()).not.toBe(`${site.appOrigin}${SPA_APP_PATHS.admin}`);
  }, TEST_TIMEOUT_MS);
});
