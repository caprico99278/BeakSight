// T37c（Task 37 の設計書 3.2〜3.4、4 章、5 章、6 章の 1〜3・6）: 発見のジョブ（本物の流れ `executeDiscoveryRun`）の、送らずに観察する probe。
// 通す部品（どれも本物）: 認証つきの factory（監査の段の口。バックエンドを承認したサービスの Origin にする）と Guard、発見の流れ、押す部品
// （`src/interaction/submission-probe.ts`）。サイトは fixture（`startSpaAuthSite` の form のない会員の画面 `memberScreenLayout: 'formless'` と、敵対的な保存
// `hostileMemberSave`）。
// - form のない登録の画面の保存のボタンが `API_CREATE`、更新の画面が `API_UPDATE`。敵対的な形は `NOT_EXECUTABLE`（理由つき）、probe を見分けて別の表へ
//   送る画面は、送った型のまま（偽らない）。削除の語のボタンは押さない。RB-13: 押す順・見えないボタン・外部スキーム・開いた窓の保存の決めは、偽の口の単体
//   （`tests/unit/submission-probe-loop.test.ts`）。
// - 安全の条件: サーバに届いた読み取りでない要求と事前確認は 0（fixture の記録で数え、全部の後に名前つきの時間だけ待って数え直す）。止める経路が働いた
//   証拠（凍結の後に Guard が止めた要求）がある。読み込みの回数は 1 画面 1 回のまま。
// - 目印（`bsprobe` で始まる）・本文の値・秘密（fixture の秘密の値）が、成果物・IPC の要約・管理データ（索引の WAL を含むファイル）に出ない。
// SLIM BD-2: 送信の扱いは本番の既定の PASS_EXCEPT_DELETE だけ（発見の凍結の中は扱いによらず何も送らない。READ_ONLY の回は外した）。両方の Chromium に広げるのは
// 「発見のジョブで何も送らず削除を押さない」と「凍結した Context で保存だけを押す」の 2 場面（`BOTH_CHROMIUM_LAUNCHERS`。遅い組では CLI の起動の設定の 1 つ）。
// ほかは組の先頭の回だけ。敵対的な保存の形は、1 つのサイトで形を替えながら、押す部品で 1 回ずつ押す。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { apiAutoDraftRowsOf } from '../../src/control/approval/api-scenario-autodraft.js';
import { submissionProbesOfDiscoveryDocument } from '../../src/control/discovery-candidate-lookup.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { closeControlDatabase, openControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { createServiceRequestBudget } from '../../src/crawl/service-request-budget.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoverPageCandidates } from '../../src/discovery/discover-page.js';
import {
  discoveryCandidatesOf,
  discoveryReadPagePaths,
  mergeDiscoveryCandidates,
  type DiscoveryDocument,
  type DiscoveryPageEntry,
} from '../../src/discovery/discovery-result.js';
import { probePageCandidates } from '../../src/discovery/probe.js';
import { submissionProbeKeyFieldsOf } from '../../src/discovery/submission-probe-contracts.js';
import { probeDiscoveredSubmissions } from '../../src/interaction/submission-probe.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { AuditStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { executeDiscoveryRun, type DiscoveryRunOutcome } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import {
  LIST_ROW_OPENER_ELEMENTS,
  LIST_ROW_OPENER_ITEMS,
  LIST_ROW_OPENER_PATHS,
  startListRowOpenerSite,
  type ListRowOpenerSite,
} from '../../fixtures/list-row-opener-site.js';
import {
  LIST_ROW_UPDATE_ELEMENTS,
  LIST_ROW_UPDATE_ITEMS,
  LIST_ROW_UPDATE_PATHS,
  LIST_ROW_UPDATE_SHAPES,
  LIST_ROW_UPDATE_VARIANT_SCREENS,
  startListRowUpdateSite,
  type ListRowUpdateShape,
  type ListRowUpdateSite,
} from '../../fixtures/list-row-update-site.js';
import { BOTH_CHROMIUM_LAUNCHERS, useSharedRunBrowser } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { settleLateDeliveries } from '../helpers/loopback-server.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import { TEST_PROBE_QUIET_WAIT_MS, probeQuietWindowsOf } from '../helpers/test-waits.js';
import { auditSendOptionsOf } from '../../src/orchestration/audit-send-options.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_FORMLESS_MEMBER_BOX,
  SPA_GRANT_TYPES,
  SPA_HOSTILE_SAVE_PATHS,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaHostileMemberSave,
} from '../helpers/spa-auth-site-fixture.js';
import { PROBE_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const SEND_POLICY = 'PASS_EXCEPT_DELETE';
type Launch = () => Promise<Browser>;
/** 1 回だけ流す場面の Chromium（組の先頭の回。`chromiumRunsOf` の決まり）。 */
const [ONCE_LABEL, launchOnce] = BOTH_CHROMIUM_LAUNCHERS[0] ?? ['', () => Promise.reject(new Error('no Chromium run'))];
const TEST_TIMEOUT_MS = 240_000;
/** 各ジョブの後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 敵対的な保存のテストで、押した後に静まるまで待つ時間（ms。本番の既定 2 秒より短い、テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
const MAX_PAGES = 6;
const EXISTING_NAME = '既存花子';
/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
/** probe の目印の頭（`submission-probe-contracts.ts` の目印は、数字と日付のほか、この頭を持つ）。 */
const MARKER_PREFIX = 'bsprobe';
/** 押す部品のボタンの語。 */
const SAVE_WORD = '保存';
const REMOVE_WORD = '削除';
const PROFILE_ID = 'example-t37c';
/** 画面の準備を待つ上限（ms）。 */
const UI_TIMEOUT_MS = 15_000;
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

let workDirectory = '';
let runCount = 0;

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-submission-probe-'));
});

afterAll(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

const startSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
  const site = await startSpaAuthSite(options);
  site.addMember(EXISTING_NAME);
  return site;
};

/** 発見のジョブ（`/admin` から）を動かし、成果物をスキーマで確かめて、成果物の文書と文字列と結果を返す。 */
const discover = async (
  launch: Launch,
  site: SpaAuthSite,
  /** SLIM-2（X2）: probe の観察の長さ（既定はテストの値 `TEST_PROBE_QUIET_WAIT_MS`）。 */
  quietWaitMs: number = TEST_PROBE_QUIET_WAIT_MS,
): Promise<{ readonly document: DiscoveryDocument; readonly text: string; readonly outcome: Extract<DiscoveryRunOutcome, { kind: 'RAN' }> }> => {
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
    },
    sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
  };
  const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
    target: { id: `spa-probe-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    audit: { sendPolicy: SEND_POLICY },
  });
  const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
  const outcome = await executeDiscoveryRun({
    config, jobId: `job-probe-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
    stopSignal: new AbortController().signal, observationWindows: probeQuietWindowsOf(quietWaitMs),
  }, noObserver);
  if (outcome.kind !== 'RAN') {
    throw new Error(`the discovery did not run: ${outcome.kind}`);
  }
  // SLIM-2（X1）: 発見の流れは Browser を閉じて終わる。閉じた後の待ちは、サーバが静まるまで（`LATE_REQUEST_WAIT_MS` まで）。
  await settleLateDeliveries(LATE_REQUEST_WAIT_MS, site);
  const text = readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8');
  const document: unknown = JSON.parse(text);
  const validation = await validateArtifact('discovery', document);
  expect(validation.ok ? [] : validation.errors).toEqual([]);
  return { document: document as DiscoveryDocument, text, outcome };
};

/** 読んだ画面（path で）。 */
const pageOf = (document: DiscoveryDocument, path: string): Extract<DiscoveryPageEntry, { state: 'READ' }> => {
  const found = document.pages.find((page): page is Extract<DiscoveryPageEntry, { state: 'READ' }> =>
    page.state === 'READ' && new URL(page.url).pathname === path);
  if (found === undefined) throw new Error(`the page ${path} was not read`);
  return found;
};

/** 画面の、語を持つボタンの候補。 */
const buttonOf = (document: DiscoveryDocument, path: string, word: string): DiscoveryCandidate => {
  const found = pageOf(document, path).record.candidates.find((candidate) => candidate.kind === 'BUTTON' && candidate.submitterWords.includes(word));
  if (found === undefined) throw new Error(`the page ${path} has no button with the word`);
  return found;
};

/** サーバに届いた、読み取りでない要求と事前確認（全部の後に待って数え直す。SLIM-2（X1）: 待ちは `settleLateDeliveries`）。 */
const reachedNonReads = async (site: SpaAuthSite): Promise<readonly string[]> => {
  await settleLateDeliveries(LATE_REQUEST_WAIT_MS, site);
  return site.requests
    .filter((request) => request.preflight || !READ_METHODS.has(request.method))
    .map(({ origin, method, path }) => `${origin} ${method} ${path}`);
};

/** 読んだ画面ごとの、アプリの文書の読み込みの回数（1 画面 1 回のまま）。 */
const documentLoadsOf = (site: SpaAuthSite, document: DiscoveryDocument): readonly number[] =>
  document.pages.flatMap((page) => (page.state === 'READ'
    ? [site.requests.filter((request) => request.origin === 'app' && request.method === 'GET' && request.path === new URL(page.url).pathname).length]
    : []));

/** 値（目印、fixture の秘密）が、文字列のどこにも出ない。 */
const expectNoValues = (site: SpaAuthSite, text: string): void => {
  expect(text.includes(MARKER_PREFIX)).toBe(false);
  for (const secret of site.secretValues()) {
    expect(text.includes(secret)).toBe(false);
  }
};

/** 管理データ（索引）に、ジョブの管理と同じまとめ方で書き、データベースのファイル（WAL を含む）に値が出ないことを確かめる。 */
const expectNoValuesInControlData = async (site: SpaAuthSite, document: DiscoveryDocument): Promise<void> => {
  const directory = await mkdtemp(join(workDirectory, 'control-'));
  const path = resolveControlDatabasePath(directory);
  const database = openControlDatabase(path);
  try {
    expect(createProfile(database, publicProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    recordDiscoveryCandidates(database, {
      profileId: PROFILE_ID,
      jobId: document.jobId,
      at: document.finishedAt,
      entries: mergeDiscoveryCandidates(discoveryCandidatesOf(document)).map(discoveryIndexEntryOf),
      readPagePaths: discoveryReadPagePaths(document),
    });
    for (const file of [path, `${path}-wal`]) {
      if (existsSync(file)) expectNoValues(site, readFileSync(file).toString('latin1') + readFileSync(file).toString('utf8'));
    }
  } finally {
    closeControlDatabase(database);
  }
};

/** 本文の鍵ごとの欄の識別（name と CSS と種類）。 */
const keyFieldsOf = (candidate: DiscoveryCandidate): readonly string[] => (candidate.submissionProbe === undefined
  ? []
  : submissionProbeKeyFieldsOf(candidate.submissionProbe).map(({ key, type, field }) =>
    `${key}:${type} ${field === null ? 'none' : `${String(field.name)} ${String(field.selector)} ${field.type} ${String(field.marker)}`}`));
/** fixture の会員の画面の 3 つの欄（本文の鍵の順。`#id` が一意な CSS）。 */
const MEMBER_KEY_FIELDS = Object.freeze([
  'email:string email #member-email email',
  'name:string name #name text',
  'note:string note #note text',
]);
/** 番号を除いた、鍵と欄の対応。 */
const withoutMarkers = (entries: readonly string[]): readonly string[] => entries.map((entry) => entry.replace(/ [0-9]+$/u, ''));

const frozenBlockedOf = (snapshot: ReturnType<SafetyLedger['snapshot']>): readonly string[] =>
  snapshot.blockedInteractionRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`);

/** 押す部品の factory（describe ごとに作り、`closeFactories` で閉じる）。 */
const factories: BrowserContextFactory[] = [];
const closeFactories = async (): Promise<void> => {
  await Promise.all(factories.splice(0).map((factory) => factory.close()));
};

/** 本物の factory と Guard の PRIMARY の Context で画面を開き、準備の要素を待つ（凍結はしない）。API の Origin を承認したサービスの Origin にする。 */
const openScreen = async (
  browser: Browser,
  site: { readonly appOrigin: string; readonly apiOrigin: string; readonly storedSession?: string; readonly excludedPathPrefixes: readonly string[]; readonly tokenPath: string; readonly tokenQuery: readonly { readonly name: string; readonly value: string }[]; readonly tokenOrigin: string },
  pagePath: string,
  readySelector: string,
) => {
  const base = fastRunConfig(site.appOrigin, pagePath, { audit: { sendPolicy: SEND_POLICY } });
  const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${pagePath}`, allowedOrigins: [site.appOrigin] } };
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
    ...PROBE_FACTORY_OPTIONS,
    ...auditSendOptionsOf(config, [site.apiOrigin]),
    authentication: {
      initialState: { cookies: [], origins: site.storedSession === undefined ? [] : [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.storedSession }] }] },
      filterState: (state) => filterAuthenticatedState(state, [site.appOrigin]),
      auditExclusions: { excludedPathPrefixes: [...site.excludedPathPrefixes], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      auditStage: {
        approvedServiceOrigins: [site.apiOrigin],
        auditReadRequests: [],
        scriptLogin: { origin: site.tokenOrigin, path: site.tokenPath, requiredQuery: [...site.tokenQuery] },
      },
    },
    serviceRequestBudget: createServiceRequestBudget({ now: () => Date.now() }),
    auditStageMonitor: new AuditStageMonitor(),
  });
  factories.push(factory);
  const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
  const page = await factory.createPassivePage(context);
  await page.goto(`${site.appOrigin}${pagePath}`);
  await page.locator(readySelector).first().waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
  const observation = factory.submissionObservationOf(context);
  if (observation === null) throw new Error('the PRIMARY Context has no submission observation');
  return { page, observation, ledger: () => factory.getSafetyLedger(context).snapshot() };
};

/** SPA の fixture の、form のない更新の画面（DEF-142: 指定すれば別の画面）を開く。 */
const openEditScreen = (browser: Browser, site: SpaAuthSite, pagePath = spaMemberEditPathOf(1)): ReturnType<typeof openScreen> => openScreen(browser, {
  appOrigin: site.appOrigin,
  apiOrigin: site.backendOrigin,
  storedSession: site.issueStoredSession(),
  excludedPathPrefixes: [SPA_APP_PATHS.logout],
  tokenOrigin: site.tokenOrigin,
  tokenPath: SPA_BACKEND_PATHS.token,
  tokenQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }],
}, pagePath, `#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`);

const policyOf = (site: SpaAuthSite) => ({
  targetPolicy: { allowedOrigins: new Set([site.appOrigin]), isExcludedPage: (location: { readonly path: string }) => location.path.startsWith(SPA_APP_PATHS.auth) },
  quietWaitMs: SHORT_QUIET_WAIT_MS,
});

/** DEF-186・LU-4: 仮のサイトの一覧の画面を開き（準備の要素を待つ）、発見（凍結）と probe を通す。 */
const probeListScreen = async (browser: Browser, site: { readonly appOrigin: string; readonly apiOrigin: string }, pagePath: string, readySelector: string) => {
  const { page, observation, ledger } = await openScreen(browser, {
    appOrigin: site.appOrigin, apiOrigin: site.apiOrigin, excludedPathPrefixes: [], tokenOrigin: site.apiOrigin, tokenPath: '/token', tokenQuery: [],
  }, pagePath, readySelector);
  const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
  expect(discovered.incompleteReasons).toEqual([]);
  const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
    targetPolicy: { allowedOrigins: new Set([site.appOrigin]), isExcludedPage: () => false },
    quietWaitMs: SHORT_QUIET_WAIT_MS,
  });
  await wait(LATE_REQUEST_WAIT_MS);
  return { probed, ledger };
};

// ---------- 両方の Chromium に広げる 2 場面（遅い組では CLI の起動の設定の 1 つ） ----------

describe.each(BOTH_CHROMIUM_LAUNCHERS)('T37c: the submission probe sends nothing and never presses the delete button (%s)', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let browser: Browser | undefined;

  afterEach(async () => {
    await closeFactories();
    await browser?.close();
    browser = undefined;
    await spa?.close();
    spa = undefined;
  });

  it('probes the formless create screen (API_CREATE) and the edit screen (API_UPDATE) without sending anything, and never presses the delete button', async () => {
    const site = await startSite({ memberScreenLayout: 'formless' });
    spa = site;
    const { document, text, outcome } = await discover(() => launch(), site);
    const editPath = spaMemberEditPathOf(1);

    const create = buttonOf(document, SPA_APP_PATHS.memberNew, SAVE_WORD);
    expect(create.classification).toBe('NEEDS_BINDING');
    expect(create.submissionProbe).toMatchObject({
      result: 'API_CREATE',
      reason: null,
      nonReadRequestCount: 1,
      filledFieldCount: 3,
      skippedFieldCount: 0,
      shape: {
        method: 'POST',
        origin: { kind: 'APPROVED_API', index: 0 },
        pathShape: SPA_BACKEND_PATHS.members,
        filters: [],
        body: { kind: 'OBJECT', keys: [{ name: 'email', type: 'string' }, { name: 'name', type: 'string' }, { name: 'note', type: 'string' }] },
      },
    });
    // 3 つの欄の目印が、本文の 3 つの鍵に対応する（目印の値は出さない。番号だけ）。
    expect(create.submissionProbe?.shape?.body.markerKeys.map(({ key }) => key)).toEqual(['email', 'name', 'note']);
    expect(create.submissionProbe?.shapeDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const update = buttonOf(document, editPath, SAVE_WORD);
    expect(update.submissionProbe).toMatchObject({
      result: 'API_UPDATE',
      reason: null,
      shape: { method: 'PATCH', pathShape: SPA_BACKEND_PATHS.members, filters: [{ name: 'id', operator: 'eq', valueMatchesPagePath: true }] },
    });
    // T38a: form のない画面の保存（BUTTON。form の外の欄が範囲）の、本文の鍵ごとの欄。欄の範囲の 3 つの欄に、その押下の目印の番号 0〜2。値はない。
    for (const save of [create, update]) {
      expect(save.fields).toEqual([]);
      expect(withoutMarkers(keyFieldsOf(save))).toEqual(MEMBER_KEY_FIELDS);
      expect(save.submissionProbe?.inputFields?.map(({ name, marker }) => `${String(name)} ${String(marker)}`).sort())
        .toEqual(['email 1', 'name 0', 'note 2'].sort());
    }
    // 削除の語のボタンは、実行できない候補で、押さない（probe の結果を持たない）。
    const remove = buttonOf(document, editPath, REMOVE_WORD);
    expect(remove.classification).toBe('NOT_EXECUTABLE');
    expect(remove.submissionProbe).toBeUndefined();
    // probe の対象でない候補（一覧の画面）も、結果を持たない。
    for (const candidate of pageOf(document, SPA_APP_PATHS.admin).record.candidates) {
      expect(candidate.submissionProbe).toBeUndefined();
    }

    // 安全: サーバに届いた読み取りでない要求と事前確認は 0。
    expect(await reachedNonReads(site)).toEqual([]);
    expect(update.submissionProbe?.nonReadRequestCount).toBe(1);
    expect(site.memberCount).toBe(1);
    expect(site.memberOf(1)?.name).toBe(EXISTING_NAME);
    // 読み込みは 1 画面 1 回のまま（probe は読み込み直さない）。
    expect(documentLoadsOf(site, document).every((count) => count === 1)).toBe(true);
    expect(document.runStatus).toBe('COMPLETE');

    // 値は、成果物・IPC の要約・管理データに出ない。
    expectNoValues(site, text);
    expectNoValues(site, JSON.stringify(outcome.summary));
    await expectNoValuesInControlData(site, document);
    // 画面に返す probe の結果の読み方（識別の digest ごと）も、型の名前だけ。
    const views = submissionProbesOfDiscoveryDocument(document, create.identityDigest);
    expect(views.map(({ result }) => result)).toEqual(['API_CREATE']);
    expectNoValues(site, JSON.stringify(views));
  }, TEST_TIMEOUT_MS);

  it('presses only the save button in the frozen Context: the Guard blocks the PATCH (recorded after the freeze), the delete button is never pressed', async () => {
    const site = await startSite({ memberScreenLayout: 'formless' });
    spa = site;
    browser = await launch();
    const { page, observation, ledger } = await openEditScreen(browser, site);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    expect(discovered.incompleteReasons).toEqual([]);
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, policyOf(site));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.slice(before).map(({ origin, method, path }) => `${origin} ${method} ${path}`)).toEqual([]);
    const save = probed.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD));
    const remove = probed.candidates.find((candidate) => candidate.submitterWords.includes(REMOVE_WORD));
    expect(save?.submissionProbe).toMatchObject({ result: 'API_UPDATE', filledFieldCount: 3 });
    expect(remove?.submissionProbe).toBeUndefined();
    const snapshot = ledger();
    // 止める経路が働いた証拠（凍結の後の止めた記録）。削除のボタンの DELETE は、押していないので止めた記録にもない。
    expect(frozenBlockedOf(snapshot)).toContain(`PATCH ${SPA_BACKEND_PATHS.members} INTERACTION_FROZEN`);
    expect(snapshot.blockedInteractionRequests.some(({ method }) => method === 'DELETE')).toBe(false);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
    expect(JSON.stringify(snapshot).includes(MARKER_PREFIX)).toBe(false);
    expect(site.memberOf(1)?.name).toBe(EXISTING_NAME);
  }, TEST_TIMEOUT_MS);
});

// ---------- 1 回だけの場面（組の先頭の回） ----------

describe(`T37c: the discovery job scenes of the submission probe (${ONCE_LABEL})`, () => {
  const launch = useSharedRunBrowser(launchOnce);
  let spa: SpaAuthSite | undefined;

  afterEach(async () => {
    await spa?.close();
    spa = undefined;
  });

  const startJobSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
    spa = await startSite(options);
    return spa;
  };

  it('records the field of each key of the body on the form screens (FORM candidates) (T38a)', async () => {
    const site = await startJobSite({});
    const { document, text } = await discover(launch, site);
    const formOf = (path: string): DiscoveryCandidate => {
      const found = pageOf(document, path).record.candidates.find((candidate) => candidate.kind === 'FORM' && candidate.submitterWords.includes(SAVE_WORD));
      if (found === undefined) throw new Error(`the page ${path} has no form with the save word`);
      return found;
    };
    const create = formOf(SPA_APP_PATHS.memberNew);
    expect(create.submissionProbe?.result).toBe('API_CREATE');
    expect(withoutMarkers(keyFieldsOf(create))).toEqual(MEMBER_KEY_FIELDS);
    const update = formOf(spaMemberEditPathOf(1));
    // form の更新の画面は、本文に論理削除の鍵（`deleted`）を入れるので、実行できない形（T37b の分類）。鍵と欄の対応は、型があるので組み立てる。
    expect(update.submissionProbe).toMatchObject({ result: 'NOT_EXECUTABLE', reason: 'SOFT_DELETE_KEY' });
    // 更新の画面の論理削除の欄（checkbox）は触らない（数だけ）。本文の `deleted` の鍵は、欄に対応しない（ページが決める値）。
    expect(update.submissionProbe?.skippedFieldCount).toBeGreaterThanOrEqual(1);
    expect(keyFieldsOf(update).filter((entry) => entry.startsWith('deleted:'))).toEqual(['deleted:boolean none']);
    expect(withoutMarkers(keyFieldsOf(update)).filter((entry) => !entry.startsWith('deleted:'))).toEqual(MEMBER_KEY_FIELDS);
    expect(await reachedNonReads(site)).toEqual([]);
    expectNoValues(site, text);
  }, TEST_TIMEOUT_MS);

  // RB-13: DEF-144（外部スキームへ移る押下の後に保存を押す）と DEF-145（押下で開いた窓の中の保存）の押す順は、偽の口の単体
  // （`tests/unit/submission-probe-loop.test.ts`）へ移した。DEF-147 の分類と下書きは単体（api-shape-classification・scenario-api-draft）にある。
});

/**
 * 敵対的な保存の、更新の画面の結果と理由（null は理由なし）。画面を移るだけの保存は、DEF-242（凍結の段の Guard が一覧への移動に 204 で応え、文書が残る）の後は、
 * 送信のない `NO_REQUEST`。
 */
const HOSTILE_CASES: readonly (readonly [SpaHostileMemberSave, string])[] = [
  ['deleteOnSave', 'NOT_EXECUTABLE DELETE_METHOD'],
  ['upsert', 'NOT_EXECUTABLE UPSERT'],
  ['arrayBody', 'NOT_EXECUTABLE ARRAY_BODY'],
  ['unfilteredPatch', 'NOT_EXECUTABLE FILTER_MISSING'],
  ['rpcCall', 'NOT_EXECUTABLE PROCEDURE_CALL_PATH'],
  ['doubleSend', 'NOT_EXECUTABLE MULTIPLE_REQUESTS'],
  ['softDeleteKey', 'NOT_EXECUTABLE SOFT_DELETE_KEY'],
  ['unapprovedOrigin', 'NOT_EXECUTABLE UNAPPROVED_ORIGIN'],
  ['navigateOnSave', 'NO_REQUEST null'],
];

describe(`T37c: the press part of the submission probe with the real factory and Guard (${ONCE_LABEL})`, () => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;

  beforeAll(async () => {
    browser = await launchOnce();
  });

  afterEach(async () => {
    await closeFactories();
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  const startPressSite = async (options: SpaAuthSiteOptions): Promise<SpaAuthSite> => {
    spa = await startSite(options);
    return spa;
  };

  /** 画面を開いて発見（凍結）し、押す部品を通す。 */
  const probeEditScreen = async (site: SpaAuthSite, pagePath?: string, onPageMoved?: (url: string) => void) => {
    const { page, observation, ledger } = await openEditScreen(browser, site, pagePath);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, {
      ...policyOf(site), ...(onPageMoved === undefined ? {} : { onPageMoved: ({ url }: { readonly url: string }) => onPageMoved(new URL(url).pathname) }),
    });
    await wait(LATE_REQUEST_WAIT_MS);
    return { probed, ledger, discovered, reached: site.requests.slice(before) };
  };

  // 1 つのサイトで敵対的な保存の形を替えながら（次に読み込んだ画面から効く）、同じ更新の画面を 1 回ずつ押す。DEF-242: 画面を移るだけの保存は、止めた移動の
  // 行き先が移り先として渡る。probe を見分けて別の表へ送る画面は、送った型のまま（偽らない）。
  it('records each hostile save as it was, and no request reaches any server', async () => {
    const site = await startPressSite({ memberScreenLayout: 'formless' });
    const results: string[] = [];
    for (const [hostile] of HOSTILE_CASES) {
      site.setHostileMemberSave(hostile);
      const moved: string[] = [];
      const { probed, ledger } = await probeEditScreen(site, undefined, (path) => moved.push(path));
      const probe = probed.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD))?.submissionProbe;
      results.push(`${String(probe?.result)} ${String(probe?.reason)}`);
      expect(ledger().invariantViolations).toEqual([]);
      expectNoValues(site, JSON.stringify(probed));
      if (hostile === 'navigateOnSave') {
        expect(frozenBlockedOf(ledger())).toContain(`GET ${SPA_APP_PATHS.admin} INTERACTION_FROZEN`);
        expect(moved).toContain(SPA_APP_PATHS.admin);
      }
    }
    expect(results).toEqual(HOSTILE_CASES.map(([, expected]) => expected));
    site.setHostileMemberSave('probeAware');
    const { probed } = await probeEditScreen(site);
    const aware = probed.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD))?.submissionProbe;
    expect(aware).toMatchObject({ shape: { method: 'POST', pathShape: SPA_HOSTILE_SAVE_PATHS.membersShadow, body: { kind: 'OBJECT', keys: [], markerKeys: [] } } });
    expect(aware?.result).not.toBe('API_UPDATE');
    expect(await reachedNonReads(site)).toEqual([]);
    expect(site.memberCount).toBe(1);
    expect(site.memberOf(1)?.name).toBe(EXISTING_NAME);
  }, TEST_TIMEOUT_MS);

  // RB-13: DEF-142（保存を先に押し、見えないボタンは押さない）と T44c・COV-1（見えるボタンは全部押す）の押す順は、偽の口の単体
  // （`tests/unit/submission-probe-loop.test.ts`）へ移した。

  // T44c: 押す前の読み直しは、送信ボタンの文言の語の印（`hasSubmitWord`）を読む。候補には入れない。T38a: 同じ要求の 2 回目の押下の型の digest は 1 回目と同じ。
  it('reads the submit word mark for the press order only (T44c), and keeps the shape digest of the second press (T38a)', async () => {
    const site = await startPressSite({ memberScreenLayout: 'formless', secondSaveButton: true });
    const { page } = await openEditScreen(browser, site);
    const reread = await probePageCandidates(page, Date.now() + UI_TIMEOUT_MS);
    if (reread.status !== 'READ') throw new Error('the probe did not read the page');
    expect(reread.candidates.filter((candidate) => candidate.kind === 'BUTTON').map((candidate) => `${candidate.submitterWords.join('+') || '-'} ${String(candidate.hasSubmitWord)}`))
      .toEqual(['保存 false', '- true', '削除 false']);
    const discoveredOnce = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    expect(JSON.stringify(discoveredOnce).includes('hasSubmitWord')).toBe(false);
    await closeFactories();

    const { probed, ledger, reached } = await probeEditScreen(site);
    expect(reached).toEqual([]);
    const probes = probed.candidates.filter((candidate) => candidate.kind === 'BUTTON' && candidate.submissionProbe !== undefined)
      .map((candidate) => candidate.submissionProbe);
    expect(probes).toHaveLength(2);
    const [first, second] = probes;
    expect(first?.result).toBe('API_UPDATE');
    expect(second?.result).toBe('API_UPDATE');
    expect(second?.shapeDigest).toBe(first?.shapeDigest);
    for (const probe of [first, second]) {
      expect(probe?.shape?.body.markerKeys.flatMap(({ markers }) => markers).sort()).toEqual([0, 1, 2]);
      expect(probe?.inputFields?.map(({ marker }) => marker).sort()).toEqual([0, 1, 2]);
    }
    expect(ledger().blockedInteractionRequests.filter(({ method }) => method === 'PATCH')).toHaveLength(2);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
    expect(ledger().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('never presses outside the frozen stage (PRESS_FAILED, no blocked write in the Context)', async () => {
    const site = await startPressSite({ memberScreenLayout: 'formless' });
    // 凍結した別の Context で記録を作り、凍結していない Context の page に渡す。
    const frozen = await openEditScreen(browser, site);
    const discovered = await discoverPageCandidates(frozen.page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const passive = await openEditScreen(browser, site);
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(passive.page, passive.observation, discovered, policyOf(site));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.slice(before).filter((request) => request.method !== 'GET')).toEqual([]);
    expect(probed.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD))?.submissionProbe)
      .toMatchObject({ result: 'NOT_OBSERVED', reason: 'PRESS_FAILED', filledFieldCount: 0 });
    const snapshot = passive.ledger();
    expect(snapshot.blockedInteractionRequests).toEqual([]);
    expect(Object.keys(snapshot.blockedRequestsByMethod).filter((method) => method !== 'GET')).toEqual([]);
    expect(snapshot.invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

/** LU-4: 形ごとの、窓の中の保存の型の path（A_PATH は path の最後の番号が `{id}` の型）。 */
const LIST_ROW_UPDATE_SAVE_PATH_SHAPES: Readonly<Record<ListRowUpdateShape, string>> = Object.freeze({
  A_FILTER: LIST_ROW_UPDATE_PATHS.items,
  A_PATH: `${LIST_ROW_UPDATE_PATHS.items}/{id}`,
  A_DRAFT: LIST_ROW_UPDATE_PATHS.items,
});
const ROW_SELECTOR_OPENER = `#${LIST_ROW_OPENER_ELEMENTS.table} tbody tr`;
const ROW_SELECTOR_UPDATE = `#${LIST_ROW_UPDATE_ELEMENTS.table} tbody tr`;
const reachedNonReadsOfList = (site: ListRowOpenerSite | ListRowUpdateSite): string[] => site.requests
  .filter((request) => request.preflight || !READ_METHODS.has(request.method))
  .map(({ origin, method, path }) => `${origin} ${method} ${path}`);

// DEF-186（設計書 `2026-11-02-beaksight-list-row-update-design.md` 3 章の A_DRAFT、5.1 の 4）と LU-4（4.0 の D7・K6、5.1 の 1〜3）: 一覧の行の「編集」の
// 押下で窓が開く画面（仮のサイト `fixtures/list-row-opener-site.ts`・`list-row-update-site.ts`）。凍結した Context なので、サーバに届く読み取りでない要求と
// 事前確認は 0。
describe(`DEF-186 and LU-4: the row editors of a list screen with the real factory and Guard (${ONCE_LABEL})`, () => {
  let browser: Browser;
  let site: ListRowOpenerSite | ListRowUpdateSite | undefined;

  beforeAll(async () => {
    browser = await launchOnce();
  });

  afterEach(async () => {
    await closeFactories();
    await site?.close();
    site = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('DEF-186: records OPENER_SIDE_REQUEST for the row editor that posts a draft, presses the save in the opened dialog next, and sends nothing', async () => {
    const opener = await startListRowOpenerSite();
    site = opener;
    const { probed, ledger } = await probeListScreen(browser, opener, LIST_ROW_OPENER_PATHS.list, ROW_SELECTOR_OPENER);
    expect(reachedNonReadsOfList(opener)).toEqual([]);
    const editors = probed.candidates.filter((candidate) => candidate.submitterWords.includes(LIST_ROW_OPENER_ELEMENTS.editText));
    expect(editors).toHaveLength(LIST_ROW_OPENER_ITEMS.length);
    expect(editors[0]?.submissionProbe).toMatchObject({
      result: 'NOT_EXECUTABLE',
      reason: 'OPENER_SIDE_REQUEST',
      shape: { method: 'POST', pathShape: LIST_ROW_OPENER_PATHS.drafts },
    });
    const save = probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_OPENER_ELEMENTS.saveText));
    expect(save?.submissionProbe).toMatchObject({ nonReadRequestCount: 1, filledFieldCount: 1, shape: { method: 'PATCH', pathShape: LIST_ROW_OPENER_PATHS.items } });
    const remove = probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_OPENER_ELEMENTS.removeText));
    expect(remove?.submissionProbe).toBeUndefined();
    expect(apiAutoDraftRowsOf(probed.candidates).filter(({ kind }) => kind === 'CREATE')).toEqual([]);
    const snapshot = ledger();
    expect(frozenBlockedOf(snapshot)).toContain(`POST ${LIST_ROW_OPENER_PATHS.drafts} INTERACTION_FROZEN`);
    expect(frozenBlockedOf(snapshot)).toContain(`PATCH ${LIST_ROW_OPENER_PATHS.items} INTERACTION_FROZEN`);
    expect(snapshot.blockedInteractionRequests.some(({ method }) => method === 'DELETE')).toBe(false);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it.each(LIST_ROW_UPDATE_SHAPES)('LU-4: presses one row editor of %s, records the opener on the save as API_UPDATE, and sends nothing', async (shape) => {
    const update = await startListRowUpdateSite();
    site = update;
    const { probed, ledger } = await probeListScreen(browser, update, LIST_ROW_UPDATE_PATHS.screens[shape], ROW_SELECTOR_UPDATE);
    expect(reachedNonReadsOfList(update)).toEqual([]);
    const editors = probed.candidates.filter((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.editText));
    expect(editors).toHaveLength(LIST_ROW_UPDATE_ITEMS.length);
    // 同じ識別の「編集」は、文書の順で最初の 1 つだけを押す（残りは押す回数を使わない）。
    expect(new Set(editors.map(({ identityDigest }) => identityDigest)).size).toBe(1);
    expect(editors[0]?.submissionProbe?.result).not.toBe('NOT_OBSERVED');
    expect(editors.slice(1).map(({ submissionProbe }) => submissionProbe?.reason)).toEqual(['SAME_IDENTITY_PRESSED', 'SAME_IDENTITY_PRESSED']);
    const removers = probed.candidates.filter((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.removeText));
    expect(removers).toHaveLength(LIST_ROW_UPDATE_ITEMS.length);
    expect(removers.map(({ submissionProbe }) => submissionProbe)).toEqual(removers.map(() => undefined));
    const save = probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.saveText));
    expect(save?.submissionProbe).toMatchObject({
      result: 'API_UPDATE',
      reason: null,
      nonReadRequestCount: 1,
      filledFieldCount: 1,
      shape: { method: 'PATCH', pathShape: LIST_ROW_UPDATE_SAVE_PATH_SHAPES[shape] },
      opener: { identityDigest: editors[0]?.identityDigest, hasName: true, openerWords: [LIST_ROW_UPDATE_ELEMENTS.editText] },
    });
    expect(probed.candidates.filter(({ submissionProbe }) => submissionProbe !== undefined && submissionProbe.result !== 'NOT_OBSERVED')).toHaveLength(2);
    const snapshot = ledger();
    expect(frozenBlockedOf(snapshot)).toContain(`PATCH ${shape === 'A_PATH' ? `${LIST_ROW_UPDATE_PATHS.items}/1` : LIST_ROW_UPDATE_PATHS.items} INTERACTION_FROZEN`);
    expect(snapshot.blockedInteractionRequests.some(({ method }) => method === 'DELETE')).toBe(false);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
  }, TEST_TIMEOUT_MS);

  // LU-SFIX1（LU-SREV1 の Minor-3・Minor-4）: 窓が続けて開く形で、開き手の事実は「編集」の後の「保存」だけに付く。開いた窓の中の iframe は、窓の中の候補の
  // 理由に出る。
  it('LU-SFIX1: records the opener only on the save after the row editor, and the frame in the opened dialog as an incomplete reason', async () => {
    const update = await startListRowUpdateSite();
    site = update;
    const chain = await probeListScreen(browser, update, LIST_ROW_UPDATE_VARIANT_SCREENS.chain, ROW_SELECTOR_UPDATE);
    const editor = chain.probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.editText));
    expect(chain.probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.saveText))?.submissionProbe).toMatchObject({
      result: 'NO_REQUEST',
      opener: { identityDigest: editor?.identityDigest, hasName: true, openerWords: [LIST_ROW_UPDATE_ELEMENTS.editText] },
    });
    const next = chain.probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.nextText));
    expect(next?.submissionProbe?.result).toBe('NO_REQUEST');
    expect(next?.submissionProbe?.opener).toBeUndefined();
    await closeFactories();
    const frame = await probeListScreen(browser, update, LIST_ROW_UPDATE_VARIANT_SCREENS.frame, ROW_SELECTOR_UPDATE);
    expect(frame.probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.editText))?.incompleteReasons).toEqual([]);
    const save = frame.probed.candidates.find((candidate) => candidate.submitterWords.includes(LIST_ROW_UPDATE_ELEMENTS.saveText));
    expect(save?.incompleteReasons).toContain('INCOMPLETE_FRAME_OR_CLOSED_SHADOW');
    expect(save?.submissionProbe).toMatchObject({ result: 'API_UPDATE', shape: { method: 'PATCH', pathShape: `${LIST_ROW_UPDATE_PATHS.items}/{id}` } });
    expect(reachedNonReadsOfList(update)).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
