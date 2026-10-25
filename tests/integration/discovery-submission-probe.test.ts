// T37c（Task 37 の設計書 3.2〜3.4、4 章、5 章、6 章の 1〜3・6）: 発見のジョブ（本物の流れ `executeDiscoveryRun`）の、送らずに観察する probe。
// 通す部品（どれも本物。Chromium はテストの既定の headless と、CLI の起動の設定の両方）: 認証つきの factory（監査の段の口。バックエンドを承認した
// サービスの Origin にする）と Guard、発見の流れ、押す部品（`src/interaction/submission-probe.ts`）。サイトは fixture（`startSpaAuthSite` の form のない
// 会員の画面 `memberScreenLayout: 'formless'` と、敵対的な保存 `hostileMemberSave`）。
// - form のない登録の画面の保存のボタンが `API_CREATE`、更新の画面が `API_UPDATE`。敵対的な形は `NOT_EXECUTABLE`（理由つき）、画面を移る保存は
//   `NOT_OBSERVED`（`PAGE_CHANGED`。両方の Chromium。T37c fix round 1 で固定）、probe を見分けて別の表へ送る画面は、送った型のまま（偽らない）。削除の語の
//   ボタンは押さない。1 画面の押下は 3 回まで（4 つ目からは `PRESS_LIMIT_REACHED`。T37c fix round 1）。DEF-142: 先頭の文字のないボタンより先に
//   保存のボタンを押し（`API_CREATE`）、見えないボタンは押す回数を使わずに飛ばす（`TARGET_NOT_FOUND`）。
// - 安全の条件: ジョブの全体で、サーバに届いた読み取りでない要求と事前確認は 0（fixture の記録で数え、全部の後に名前つきの時間だけ待って数え直す）。
//   止める経路が働いた証拠（凍結の後に Guard が止めた要求の数 `blockedRequests` と、probe の型の数）がある。読み込みの回数は 1 画面 1 回のまま。
// - 目印（`bsprobe` で始まる）・本文の値・秘密（fixture の秘密の値）が、成果物・IPC の要約・管理データ（索引の WAL を含むファイル）に出ない。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import { BrowserContextFactory, type AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { scenarioApiKeyFieldsOfProbe, scenarioApiPublicationStateKeysOf } from '../../src/control/approval/scenario-contracts.js';
import { validateScenarioDraft } from '../../src/control/approval/scenario-policy.js';
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
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_EXTERNAL_SCHEME_BUTTON,
  SPA_PUBLICATION_STATUS_FIELD,
  SPA_EXTRA_PRESS_PATH_PREFIX,
  SPA_EXTRA_PRESS_TARGET_WORDS,
  SPA_FORMLESS_MEMBER_BOX,
  SPA_GRANT_TYPES,
  SPA_HIDDEN_PRESS_PATH_PREFIX,
  SPA_HIDDEN_PRESS_TARGET_WORDS,
  SPA_HOSTILE_SAVE_PATHS,
  SPA_CROWDED_ICON_BUTTON_COUNT,
  SPA_ICON_BUTTON_COUNT,
  SPA_TOOLBAR_PRESS_WORDS,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaAuthSiteOptions,
  type SpaHostileMemberSave,
} from '../helpers/spa-auth-site-fixture.js';
import { TEST_FACTORY_OPTIONS } from '../helpers/test-config.js';
import { ALL_CONFIRMED } from '../unit/approval-samples.js';
import { publicProfile, resolveTestContext } from './control-profile-fixtures.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
/** 各ジョブの後に、遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 敵対的な保存のテストで、押した後に静まるまで待つ時間（ms。本番の既定 2 秒より短い、テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
const MAX_PAGES = 6;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
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

describe.each(LAUNCHERS)('T37c: the submission probe of the discovery job on the SPA fixture with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  let runCount = 0;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-discovery-submission-probe-'));
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

  const auditStageOf = (site: SpaAuthSite): AuditStageServiceRequests => ({
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: [],
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: DEFAULT_LIMITS,
  });

  /** 発見のジョブ（`/admin` から）を動かし、成果物をスキーマで確かめて、成果物の文書と文字列と結果を返す。 */
  const discover = async (
    site: SpaAuthSite,
    quietWaitMs?: number,
  ): Promise<{ readonly document: DiscoveryDocument; readonly text: string; readonly outcome: Extract<DiscoveryRunOutcome, { kind: 'RAN' }> }> => {
    runCount += 1;
    const authentication: RunAuthentication = {
      initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
      approvedTestOrigins: [site.appOrigin],
      auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
      sessionLostPathPrefix: SPA_APP_PATHS.auth,
      filterState: filterAuthenticatedState,
      auditStage: auditStageOf(site),
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: `spa-probe-${runCount}` }, output: { directory: join(workDirectory, `job-${runCount}`) }, crawl: { maxPages: MAX_PAGES },
    });
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const outcome = await executeDiscoveryRun({
      config, jobId: `job-probe-${runCount}`, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal, ...(quietWaitMs === undefined ? {} : { submissionProbeQuietWaitMs: quietWaitMs }),
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    await wait(LATE_REQUEST_WAIT_MS);
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

  /** サーバに届いた、読み取りでない要求と事前確認（全部の後に待って数え直す）。 */
  const reachedNonReads = async (site: SpaAuthSite): Promise<readonly string[]> => {
    await wait(LATE_REQUEST_WAIT_MS);
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

  it('probes the formless create screen (API_CREATE) and the edit screen (API_UPDATE) without sending anything, and never presses the delete button', async () => {
    const site = await startSite({ memberScreenLayout: 'formless' });
    const { document, text, outcome } = await discover(site);
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
    // 削除の語のボタンは、実行できない候補で、押さない（probe の結果を持たない）。
    const remove = buttonOf(document, editPath, REMOVE_WORD);
    expect(remove.classification).toBe('NOT_EXECUTABLE');
    expect(remove.submissionProbe).toBeUndefined();
    // probe の対象でない候補（一覧の画面）も、結果を持たない。
    for (const candidate of pageOf(document, SPA_APP_PATHS.admin).record.candidates) {
      expect(candidate.submissionProbe).toBeUndefined();
    }

    // 安全: サーバに届いた読み取りでない要求と事前確認は 0。止める経路が働いた（型は、凍結の段の Guard が本番の要求を止めたときだけ口に届く）。
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

  /**
   * 敵対的な保存の、更新の画面の結果と理由（null は理由なし）。T37c fix round 1: 画面を移る保存は、両方の Chromium で `NOT_OBSERVED`・`PAGE_CHANGED`
   * （3 回とも。凍結の段の Guard が一覧への移動を止め、main frame が Chromium の誤りの画面に替わるので、URL が変わる）に固定した。
   */
  const HOSTILE_CASES: readonly (readonly [SpaHostileMemberSave, readonly (readonly [string, string | null])[]])[] = [
    ['deleteOnSave', [['NOT_EXECUTABLE', 'DELETE_METHOD']]],
    ['upsert', [['NOT_EXECUTABLE', 'UPSERT']]],
    ['arrayBody', [['NOT_EXECUTABLE', 'ARRAY_BODY']]],
    ['unfilteredPatch', [['NOT_EXECUTABLE', 'FILTER_MISSING']]],
    ['rpcCall', [['NOT_EXECUTABLE', 'PROCEDURE_CALL_PATH']]],
    ['doubleSend', [['NOT_EXECUTABLE', 'MULTIPLE_REQUESTS']]],
    ['softDeleteKey', [['NOT_EXECUTABLE', 'SOFT_DELETE_KEY']]],
    ['unapprovedOrigin', [['NOT_EXECUTABLE', 'UNAPPROVED_ORIGIN']]],
    ['navigateOnSave', [['NOT_OBSERVED', 'PAGE_CHANGED']]],
  ];

  it.each(HOSTILE_CASES)('records the hostile save %s as it was (no request reaches any server)', async (hostile, expected) => {
    const site = await startSite({ hostileMemberSave: hostile });
    const { document, text } = await discover(site, SHORT_QUIET_WAIT_MS);
    const probe = buttonOf(document, spaMemberEditPathOf(1), SAVE_WORD).submissionProbe;
    expect(expected.map(([result, reason]) => `${result} ${String(reason)}`)).toContain(`${String(probe?.result)} ${String(probe?.reason)}`);
    expect(document.endReason).not.toBe('SAFETY_VIOLATION');
    expect(await reachedNonReads(site)).toEqual([]);
    expect(site.memberCount).toBe(1);
    expect(site.memberOf(1)?.name).toBe(EXISTING_NAME);
    expect(documentLoadsOf(site, document).every((count) => count === 1)).toBe(true);
    expectNoValues(site, text);
  }, TEST_TIMEOUT_MS);

  it('records what the probe-aware page really sent (another table, no marker in the body), not what it would send to a user', async () => {
    const site = await startSite({ hostileMemberSave: 'probeAware' });
    const { document, text } = await discover(site, SHORT_QUIET_WAIT_MS);
    const probe = buttonOf(document, spaMemberEditPathOf(1), SAVE_WORD).submissionProbe;
    expect(probe).toMatchObject({ shape: { method: 'POST', pathShape: SPA_HOSTILE_SAVE_PATHS.membersShadow, body: { kind: 'OBJECT', keys: [], markerKeys: [] } } });
    expect(probe?.result).not.toBe('API_UPDATE');
    expect(await reachedNonReads(site)).toEqual([]);
    expectNoValues(site, text);
  }, TEST_TIMEOUT_MS);

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

  it('records the field of each key of the body on the formless screens (BUTTON: the fields outside the forms are its scope) (T38a)', async () => {
    const site = await startSite({ memberScreenLayout: 'formless' });
    const { document, text, outcome } = await discover(site);
    for (const path of [SPA_APP_PATHS.memberNew, spaMemberEditPathOf(1)]) {
      const save = buttonOf(document, path, SAVE_WORD);
      expect(save.kind).toBe('BUTTON');
      expect(save.fields).toEqual([]);
      expect(withoutMarkers(keyFieldsOf(save))).toEqual(MEMBER_KEY_FIELDS);
      // 欄の範囲（form の外の欄）: 3 つの欄に、その押下の目印の番号 0〜2。値はない。
      expect(save.submissionProbe?.inputFields?.map(({ name, marker }) => `${String(name)} ${String(marker)}`).sort())
        .toEqual(['email 1', 'name 0', 'note 2'].sort());
    }
    expect(await reachedNonReads(site)).toEqual([]);
    expectNoValues(site, text);
    expectNoValues(site, JSON.stringify(outcome.summary));
    await expectNoValuesInControlData(site, document);
  }, TEST_TIMEOUT_MS);

  it('records the field of each key of the body on the form screens (FORM candidates) (T38a)', async () => {
    const site = await startSite({});
    const { document, text } = await discover(site);
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

  // DEF-144（設計書 `2026-10-20-beaksight-probe-external-scheme-design.md` 3 章の 2）: 押す前には見分けられず、押した JS が外部スキームへ移るボタンが、保存の
  // ボタンの前にある画面。違反を記録して発見を続け、その画面を 1 回だけ読み込み直して保存を押し（`API_CREATE`）、次の画面へ進む。
  it('keeps discovering after a press that moves to an external scheme: reloads the page once and presses the save button (DEF-144)', async () => {
    const site = await startSite({ externalSchemeButton: true });
    const { document, text } = await discover(site, SHORT_QUIET_WAIT_MS);
    expect(document.endReason).not.toBe('SAFETY_VIOLATION');
    expect(document.runStatus).not.toBe('ABORTED_BY_SAFETY');
    const page = pageOf(document, SPA_APP_PATHS.memberNew);
    expect(buttonOf(document, SPA_APP_PATHS.memberNew, SPA_EXTERNAL_SCHEME_BUTTON.word).submissionProbe)
      .toMatchObject({ result: 'NOT_EXECUTABLE', reason: 'EXTERNAL_SCHEME' });
    expect(buttonOf(document, SPA_APP_PATHS.memberNew, SAVE_WORD).submissionProbe).toMatchObject({ result: 'API_CREATE', reason: null });
    // 違反の中身はその画面の記録に残り、読み込み直しは 1 回（アプリの文書の読み込みは 2 回）。
    expect(page.reloadedForProbe).toBe(true);
    expect(page.safetyViolations?.map((violation) => [violation.stage, violation.invariantViolations.map(({ code }) => code)]))
      .toEqual([['SUBMISSION_PROBE', ['EXTERNAL_SCHEME_NAVIGATION_ATTEMPTED']]]);
    expect(site.requests.filter((request) => request.origin === 'app' && request.method === 'GET' && request.path === SPA_APP_PATHS.memberNew))
      .toHaveLength(2);
    // 次の画面へ進んだ（その画面の後にも読んだ画面がある）。
    const readPaths = document.pages.flatMap((entry) => (entry.state === 'READ' ? [new URL(entry.url).pathname] : []));
    expect(readPaths.indexOf(SPA_APP_PATHS.memberNew)).toBeLessThan(readPaths.length - 1);
    // 数: 外部スキームで押さなかった候補と、読み込み直した画面。
    expect(document.externalSchemeProbes?.notPressed).toBeGreaterThanOrEqual(1);
    expect(document.externalSchemeProbes?.reloadedPages).toBe(document.pages.filter((entry) => entry.state === 'READ' && entry.reloadedForProbe === true).length);
    expect(await reachedNonReads(site)).toEqual([]);
    expect(site.memberCount).toBe(1);
    expectNoValues(site, text);
  }, TEST_TIMEOUT_MS);

  // DEF-145（設計書 `2026-10-21-beaksight-probe-navigation-and-dialog-design.md` 3 章の 2・3）: 「新規作成」を押すとダイアログが開き、その中に保存（API の登録の
  // 要求を出す）がある画面。押す前は見えない保存を、開いた後に先に押して `API_CREATE`。読み込み直しはしない。
  it('presses the save button in the dialog that a press opened (DEF-145)', async () => {
    const site = await startSite({ saveInDialog: true });
    const { document, text } = await discover(site, SHORT_QUIET_WAIT_MS);
    const opener = pageOf(document, SPA_APP_PATHS.memberNew).record.candidates.find((candidate) =>
      candidate.kind === 'BUTTON' && candidate.submissionProbe !== undefined && !candidate.submitterWords.includes(SAVE_WORD));
    expect(opener?.submissionProbe).toMatchObject({ result: 'NO_REQUEST' });
    expect(buttonOf(document, SPA_APP_PATHS.memberNew, SAVE_WORD).submissionProbe).toMatchObject({
      result: 'API_CREATE',
      reason: null,
      filledFieldCount: 3,
      shape: { method: 'POST', pathShape: SPA_BACKEND_PATHS.members },
    });
    expect(document.endReason).not.toBe('SAFETY_VIOLATION');
    // 読み込み直しはしない（1 画面 1 回）。サーバには何も届かない。
    expect(documentLoadsOf(site, document).every((count) => count === 1)).toBe(true);
    expect(document.externalSchemeProbes?.reloadedPages).toBe(0);
    expect(await reachedNonReads(site)).toEqual([]);
    expect(site.memberCount).toBe(1);
    expectNoValues(site, text);
  }, TEST_TIMEOUT_MS);

  // T44c（Task 44 の設計書 P1-3）: 押す数の上限で押せなかった登録・更新の語の候補の数を、成果物に残す（見えないボタンは数えない）。
  it('records the number of the candidates with a create or update word not pressed because of the press limit (T44c)', async () => {
    const site = await startSite({ crowdedEditScreen: true });
    const { document, text } = await discover(site, SHORT_QUIET_WAIT_MS);
    // 更新の画面 1 つ（会員 1 人）の、上限で押せなかった道具のボタン 2 つ。
    expect(document.pressLimitProbes).toEqual({ priorityNotPressed: 2 });
    expect(buttonOf(document, spaMemberEditPathOf(1), SAVE_WORD).submissionProbe).toMatchObject({ result: 'API_UPDATE', reason: null });
    for (const word of SPA_HIDDEN_PRESS_TARGET_WORDS) {
      expect(pageOf(document, spaMemberEditPathOf(1)).record.candidates.filter((candidate) => candidate.submitterWords.includes(word))
        .map((candidate) => candidate.submissionProbe?.reason)).toContain('TARGET_NOT_FOUND');
    }
    expect(document.endReason).not.toBe('SAFETY_VIOLATION');
    expect(await reachedNonReads(site)).toEqual([]);
    expect(site.memberCount).toBe(1);
    expectNoValues(site, text);
  }, TEST_TIMEOUT_MS);

  // DEF-147（設計書 `2026-10-21-beaksight-api-state-keys-design.md` 3 章の 2・4）: 公開の状態の欄（status）のある登録の画面。probe の結果は `API_CREATE`
  // （論理削除の鍵にしない）で、API のシナリオの下書きを作れる。サーバには何も届かない。
  it('records API_CREATE for the create screen with a publication state field, and the API scenario draft can be made (DEF-147)', async () => {
    const site = await startSite({ publicationStatusField: true });
    const { document, text } = await discover(site, SHORT_QUIET_WAIT_MS);
    const create = buttonOf(document, SPA_APP_PATHS.memberNew, SAVE_WORD);
    const probe = create.submissionProbe;
    expect(probe).toMatchObject({ result: 'API_CREATE', reason: null, shape: { method: 'POST', pathShape: SPA_BACKEND_PATHS.members } });
    expect(probe?.shape?.body.keys.map(({ name }) => name)).toContain(SPA_PUBLICATION_STATUS_FIELD.id);
    if (probe === undefined || probe.shapeDigest === null) {
      throw new Error('the create screen has no probe');
    }
    // 下書き（欄に対応する鍵を送り、欄に対応しない鍵（公開の状態の select など）をページが決める鍵として許す）。
    const fielded = scenarioApiKeyFieldsOfProbe(probe).map(({ key }) => key);
    const pageKeys = (probe.shape?.body.keys ?? []).map(({ name }) => name).filter((name) => !fielded.includes(name));
    const draft = validateScenarioDraft({
      profileId: PROFILE_ID,
      candidateIdentityDigest: create.identityDigest,
      transport: 'API',
      fieldNames: fielded,
      readChecks: [],
      sideEffectConfirmations: ALL_CONFIRMED,
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      approvalTtlDays: 30,
      api: { shapeDigest: probe.shapeDigest, pageKeys, filterName: null, recordId: null, ledger: null },
    }, create, [], { scenarioId: null, scenarios: [], approvedServiceOrigins: [site.backendOrigin], profileRevisions: { discoveryJob: 1, current: 1 } });
    expect(draft.ok ? [] : draft.errors.map(({ code }) => code)).toEqual([]);
    if (draft.ok && draft.content.api !== undefined) {
      // 承認の画面の注意の印に使う鍵。
      expect(scenarioApiPublicationStateKeysOf(draft.content.api)).toEqual([SPA_PUBLICATION_STATUS_FIELD.id]);
    }
    expect(await reachedNonReads(site)).toEqual([]);
    expect(site.memberCount).toBe(1);
    expectNoValues(site, text);
  }, TEST_TIMEOUT_MS);
});

describe.each(LAUNCHERS)('T37c: the press part of the submission probe with the real factory and Guard with %s', (_label, launch) => {
  let browser: Browser;
  let spa: SpaAuthSite | undefined;
  const factories: BrowserContextFactory[] = [];

  beforeAll(async () => {
    browser = await launch();
  });

  afterEach(async () => {
    await Promise.all(factories.splice(0).map((factory) => factory.close()));
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  /** 認証つきの factory の PRIMARY の Context で、form のない更新の画面（DEF-142: 指定すれば別の画面）を開き、準備を待つ（凍結はしない）。 */
  const openEditScreen = async (site: SpaAuthSite, pagePath = spaMemberEditPathOf(1)) => {
    const base = fastRunConfig(site.appOrigin, pagePath);
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${pagePath}`, allowedOrigins: [site.appOrigin] } };
    const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
      ...TEST_FACTORY_OPTIONS,
      authentication: {
        initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
        filterState: (state) => filterAuthenticatedState(state, [site.appOrigin]),
        auditExclusions: { excludedPathPrefixes: [SPA_APP_PATHS.logout], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
        auditStage: {
          approvedServiceOrigins: [site.backendOrigin],
          auditReadRequests: [],
          scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
          serviceRequestLimits: DEFAULT_LIMITS,
        },
      },
      serviceRequestBudget: createServiceRequestBudget({ ...DEFAULT_LIMITS, now: () => Date.now() }),
      auditStageMonitor: new AuditStageMonitor(),
    });
    factories.push(factory);
    const context = await factory.createPassiveContext(config.viewports.primaryDesktop, 'PRIMARY');
    const page = await factory.createPassivePage(context);
    await page.goto(`${site.appOrigin}${pagePath}`);
    await page.locator(`#${SPA_FORMLESS_MEMBER_BOX}[data-state="ready"]`).waitFor({ state: 'attached', timeout: UI_TIMEOUT_MS });
    const observation = factory.submissionObservationOf(context);
    if (observation === null) throw new Error('the PRIMARY Context has no submission observation');
    return { page, observation, ledger: () => factory.getSafetyLedger(context).snapshot() };
  };

  const policyOf = (site: SpaAuthSite) => ({
    targetPolicy: { allowedOrigins: new Set([site.appOrigin]), isExcludedPage: (location: { readonly path: string }) => location.path.startsWith(SPA_APP_PATHS.auth) },
    quietWaitMs: SHORT_QUIET_WAIT_MS,
  });

  const frozenBlocked = (snapshot: ReturnType<SafetyLedger['snapshot']>): readonly string[] =>
    snapshot.blockedInteractionRequests.map(({ method, url, reason }) => `${method} ${new URL(url).pathname} ${reason}`);

  it('presses only the save button in the frozen Context: the Guard blocks the PATCH (recorded after the freeze), the delete button is never pressed', async () => {
    spa = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    const site = spa;
    site.addMember(EXISTING_NAME);
    const { page, observation, ledger } = await openEditScreen(site);
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
    expect(frozenBlocked(snapshot)).toContain(`PATCH ${SPA_BACKEND_PATHS.members} INTERACTION_FROZEN`);
    expect(snapshot.blockedInteractionRequests.some(({ method }) => method === 'DELETE')).toBe(false);
    expect(snapshot.invariantViolations).toEqual([]);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
    expect(JSON.stringify(snapshot).includes(MARKER_PREFIX)).toBe(false);
    expect(site.memberOf(1)?.name).toBe(EXISTING_NAME);
  }, TEST_TIMEOUT_MS);

  it('presses at most 3 targets on a screen in the document order; the 4th and later are NOT_OBSERVED with PRESS_LIMIT_REACHED (T37c fix round 1)', async () => {
    spa = await startSpaAuthSite({ memberScreenLayout: 'formless', extraPressTargets: 3 });
    const site = spa;
    site.addMember(EXISTING_NAME);
    const { page, observation, ledger } = await openEditScreen(site);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, policyOf(site));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.slice(before).map(({ origin, method, path }) => `${origin} ${method} ${path}`)).toEqual([]);
    // 押す対象は、保存と足した 3 つの 4 つ（文書の順）。削除のボタンは対象でない。
    const resultOf = (word: string): string | undefined => {
      const probe = probed.candidates.find((candidate) => candidate.submitterWords.includes(word))?.submissionProbe;
      return probe === undefined ? undefined : `${probe.result} ${String(probe.reason)}`;
    };
    const [first, second, third] = SPA_EXTRA_PRESS_TARGET_WORDS;
    // 足したボタンの POST は、承認した API の Origin への filter のない object の本文なので、登録の形（`API_CREATE`）。
    expect([SAVE_WORD, first, second, third].map((word) => resultOf(word ?? ''))).toEqual([
      'API_UPDATE null',
      'API_CREATE null',
      'API_CREATE null',
      'NOT_OBSERVED PRESS_LIMIT_REACHED',
    ]);
    expect(resultOf(REMOVE_WORD)).toBeUndefined();
    // 押下は 3 回だけ: 凍結の後に止めた書き込みは、保存の PATCH と、足した 1 つ目と 2 つ目の POST だけ（3 つ目の path はない）。
    const writes = ledger().blockedInteractionRequests
      .filter(({ method }) => method === 'PATCH' || method === 'POST' || method === 'DELETE')
      .map(({ method, url }) => `${method} ${new URL(url).pathname}`);
    expect(writes).toEqual([
      `PATCH ${SPA_BACKEND_PATHS.members}`,
      `POST ${SPA_EXTRA_PRESS_PATH_PREFIX}1`,
      `POST ${SPA_EXTRA_PRESS_PATH_PREFIX}2`,
    ]);
    expect(ledger().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('presses the save button before the leading icon buttons, and skips the invisible buttons without using a press (DEF-142)', async () => {
    spa = await startSpaAuthSite({ pressPriorityTargets: true });
    const site = spa;
    site.addMember(EXISTING_NAME);
    const { page, observation, ledger } = await openEditScreen(site, SPA_APP_PATHS.memberNew);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const buttons = discovered.candidates.filter((candidate) => candidate.kind === 'BUTTON');
    // 押す対象: 文字のないボタン 3 つ（先頭）、見えないボタン 3 つ、保存のボタン。どれも JS の結び付きの候補。
    expect(buttons.filter((candidate) => candidate.submitterWords.length === 0)).toHaveLength(SPA_ICON_BUTTON_COUNT);
    expect(buttons.every((candidate) => candidate.classification === 'NEEDS_BINDING')).toBe(true);
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, policyOf(site));
    await wait(LATE_REQUEST_WAIT_MS);
    // 安全: サーバには何も届かない（fixture の記録で数える）。
    expect(site.requests.slice(before).map(({ origin, method, path }) => `${origin} ${method} ${path}`)).toEqual([]);
    expect(site.memberCount).toBe(1);
    const resultOf = (candidate: DiscoveryCandidate): string =>
      `${String(candidate.submissionProbe?.result)} ${String(candidate.submissionProbe?.reason)}`;
    const probedButtons = probed.candidates.filter((candidate) => candidate.kind === 'BUTTON');
    const save = probedButtons.find((candidate) => candidate.submitterWords.includes(SAVE_WORD));
    // 保存のボタンを先に押して、登録の形（`API_CREATE`）。
    expect(save?.submissionProbe).toMatchObject({ result: 'API_CREATE', reason: null, filledFieldCount: 3, shape: { method: 'POST', pathShape: SPA_BACKEND_PATHS.members } });
    // 見えないボタンは `TARGET_NOT_FOUND`（押す回数を使わない）。
    expect(SPA_HIDDEN_PRESS_TARGET_WORDS.map((word) => {
      const hidden = probedButtons.find((candidate) => candidate.submitterWords.includes(word));
      return hidden === undefined ? 'missing' : resultOf(hidden);
    })).toEqual(SPA_HIDDEN_PRESS_TARGET_WORDS.map(() => 'NOT_OBSERVED TARGET_NOT_FOUND'));
    // 残りの 2 回は文字のないボタン（文書の順。何も送らない）、3 つ目は上限（1 画面 3 回のまま）。
    expect(probedButtons.filter((candidate) => candidate.submitterWords.length === 0).map(resultOf)).toEqual([
      'NO_REQUEST null',
      'NO_REQUEST null',
      'NOT_OBSERVED PRESS_LIMIT_REACHED',
    ]);
    // 押下は 3 回だけ: 凍結の後に止めた書き込みは、保存の POST だけ（見えないボタンの path はない）。
    const writes = ledger().blockedInteractionRequests
      .filter(({ method }) => method === 'PATCH' || method === 'POST' || method === 'DELETE')
      .map(({ method, url }) => `${method} ${new URL(url).pathname}`);
    expect(writes).toEqual([`POST ${SPA_BACKEND_PATHS.members}`]);
    expect(writes.some((write) => write.includes(SPA_HIDDEN_PRESS_PATH_PREFIX))).toBe(false);
    expect(ledger().invariantViolations).toEqual([]);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
  }, TEST_TIMEOUT_MS);

  // T44c（Task 44 の設計書 P1-3）: 押す候補の多い更新の画面（先頭に文字のないボタン 6 つ、保存の後に登録・更新の語の道具のボタン 4 つ、最後に見えないボタン 3 つ）。
  // 見えないボタンは、押す数を数える前に除く（押す数の上限の後でも `TARGET_NOT_FOUND`。`PRESS_LIMIT_REACHED` に数えない）。
  it('removes the invisible buttons before counting the presses: they stay TARGET_NOT_FOUND even after the press limit (T44c)', async () => {
    spa = await startSpaAuthSite({ crowdedEditScreen: true });
    const site = spa;
    site.addMember(EXISTING_NAME);
    const { page, observation, ledger } = await openEditScreen(site);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, policyOf(site));
    await wait(LATE_REQUEST_WAIT_MS);
    // 安全: サーバには何も届かない（fixture の記録で数える）。
    expect(site.requests.slice(before).map(({ origin, method, path }) => `${origin} ${method} ${path}`)).toEqual([]);
    const resultOf = (candidate: DiscoveryCandidate | undefined): string =>
      `${String(candidate?.submissionProbe?.result)} ${String(candidate?.submissionProbe?.reason)}`;
    const buttons = probed.candidates.filter((candidate) => candidate.kind === 'BUTTON');
    const byWord = (word: string): readonly DiscoveryCandidate[] => buttons.filter((candidate) => candidate.submitterWords.includes(word));
    // 保存を先に押して `API_UPDATE`、続く道具のボタン 2 つは何も送らない（1 画面 3 回）。残りの道具のボタンは上限。
    expect(resultOf(byWord(SAVE_WORD)[0])).toBe('API_UPDATE null');
    expect(SPA_TOOLBAR_PRESS_WORDS.map((word) => resultOf(byWord(word)[0]))).toEqual([
      'NO_REQUEST null',
      'NO_REQUEST null',
      'NOT_OBSERVED PRESS_LIMIT_REACHED',
      'NOT_OBSERVED PRESS_LIMIT_REACHED',
    ]);
    // 見えないボタンは、押す数の上限の後に並んでいても `TARGET_NOT_FOUND`。
    expect(SPA_HIDDEN_PRESS_TARGET_WORDS.map((word) => resultOf(byWord(word)[0]))).toEqual(SPA_HIDDEN_PRESS_TARGET_WORDS.map(() => 'NOT_OBSERVED TARGET_NOT_FOUND'));
    // 文字のないボタンは、どれも上限（登録・更新の語のあるものを先に押す）。
    expect(buttons.filter((candidate) => candidate.submitterWords.length === 0).map(resultOf))
      .toEqual(Array.from({ length: SPA_CROWDED_ICON_BUTTON_COUNT }, () => 'NOT_OBSERVED PRESS_LIMIT_REACHED'));
    // 押下は 3 回だけ: 凍結の後に止めた書き込みは、保存の PATCH だけ（見えないボタンの path はない）。
    const writes = ledger().blockedInteractionRequests
      .filter(({ method }) => method === 'PATCH' || method === 'POST' || method === 'DELETE')
      .map(({ method, url }) => `${method} ${new URL(url).pathname}`);
    expect(writes).toEqual([`PATCH ${SPA_BACKEND_PATHS.members}`]);
    expect(ledger().invariantViolations).toEqual([]);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
  }, TEST_TIMEOUT_MS);

  // T44c（設計者の判断）: 押す前の読み直しは、送信ボタンの文言の「送信」「確定」「submit」の語の印（`hasSubmitWord`）を読む。候補（識別の digest と成果物）には
  // 入れない。
  it('reads the submit word mark of the button 送信 for the press order only, not into the candidate (T44c)', async () => {
    spa = await startSpaAuthSite({ memberScreenLayout: 'formless', secondSaveButton: true });
    const site = spa;
    site.addMember(EXISTING_NAME);
    const { page } = await openEditScreen(site);
    const reread = await probePageCandidates(page, Date.now() + UI_TIMEOUT_MS);
    if (reread.status !== 'READ') throw new Error('the probe did not read the page');
    const buttons = reread.candidates.filter((candidate) => candidate.kind === 'BUTTON');
    const marks = buttons.map((candidate) => `${candidate.submitterWords.join('+') || '-'} ${String(candidate.hasSubmitWord)}`);
    // 保存（更新の語）は印なし、送信のボタン（分類の語なし）は印あり、削除は印なし。
    expect(marks).toEqual(['保存 false', '- true', '削除 false']);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    expect(JSON.stringify(discovered).includes('hasSubmitWord')).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('records PAGE_CHANGED for the save that moves to another screen: the Guard blocks the move and the main frame becomes the error page (T37c fix round 1)', async () => {
    spa = await startSpaAuthSite({ hostileMemberSave: 'navigateOnSave' });
    const site = spa;
    site.addMember(EXISTING_NAME);
    const { page, observation, ledger } = await openEditScreen(site);
    const startUrl = page.mainFrame().url();
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, policyOf(site));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.slice(before)).toEqual([]);
    expect(probed.candidates.find((candidate) => candidate.submitterWords.includes(SAVE_WORD))?.submissionProbe)
      .toMatchObject({ result: 'NOT_OBSERVED', reason: 'PAGE_CHANGED', filledFieldCount: 3 });
    // 一覧への移動は凍結の後に止めた記録に入り、main frame は一覧でなく Chromium の誤りの画面になる（URL が変わる）。
    expect(frozenBlocked(ledger())).toContain(`GET ${SPA_APP_PATHS.admin} INTERACTION_FROZEN`);
    expect(page.mainFrame().url()).not.toBe(startUrl);
    expect(new URL(page.mainFrame().url()).protocol).toBe('chrome-error:');
    expect(ledger().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('keeps the shape digest of the second press equal to the first for the same request (the marker numbers start from 0 for each press) (T38a)', async () => {
    spa = await startSpaAuthSite({ memberScreenLayout: 'formless', secondSaveButton: true });
    const site = spa;
    site.addMember(EXISTING_NAME);
    const { page, observation, ledger } = await openEditScreen(site);
    const discovered = await discoverPageCandidates(page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const before = site.requests.length;
    const probed = await probeDiscoveredSubmissions(page, observation, discovered, policyOf(site));
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.slice(before)).toEqual([]);
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
    // 2 回とも押して止めた（凍結の後の止めた記録に PATCH が 2 つ）。目印の値は記録に出ない。
    expect(ledger().blockedInteractionRequests.filter(({ method }) => method === 'PATCH')).toHaveLength(2);
    expect(JSON.stringify(probed).includes(MARKER_PREFIX)).toBe(false);
    expect(ledger().invariantViolations).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('never presses outside the frozen stage (PRESS_FAILED, no blocked write in the Context)', async () => {
    spa = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    const site = spa;
    site.addMember(EXISTING_NAME);
    // 凍結した別の Context で記録を作り、凍結していない Context の page に渡す。
    const frozen = await openEditScreen(site);
    const discovered = await discoverPageCandidates(frozen.page, { classificationPolicy: { allowedOrigins: new Set([site.appOrigin]) } });
    const passive = await openEditScreen(site);
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
