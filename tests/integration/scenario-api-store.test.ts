// T38b（Task 38 の設計書 3.2、4 章、5 章の 1）: form のない登録と更新の画面（fixture の `memberScreenLayout: 'formless'`）の発見の成果物から、API の
// シナリオの下書きを作って保存し、承認や入力の規則がないうちは実行の許可が出ないことを確かめる。
// - 発見は本物の流れ（`executeDiscoveryRun`。認証つきの factory と Guard、送らずに観察する probe）。Chromium はテストの既定の headless と、CLI の起動の
//   設定の両方。
// - 保存の口（`createScenario`）は、候補を型の digest で選び（`candidateOfDiscoveryDocumentByShape`）、`evidence` に `submissionProbe` を含む候補を書く。
//   型・鍵と欄の対応・許すヘッダの名前は値を持たない（目印と fixture の秘密がシナリオと管理データのファイルに出ない）。
// - 登録（CREATE）と更新（UPDATE。台帳は登録のシナリオ）の API のシナリオが保存できる。発行の口（`issueExecutionGrant`）は、API のシナリオを送り方では
//   拒まず（T40a で登録、T41b で更新）、FORM と同じ確かめ（承認、入力の規則など）で拒む。許可を出す通しは、登録が `write-job-api-start.test.ts`、更新が
//   `api-update-grant-start.test.ts`（許可から `START` まで）と `write-job-api-update.test.ts`（本物のワーカーの更新の流れと親の締めまで）。
// - 発見と保存の間に、サーバに届いた読み取りでない要求は 0（fixture の記録で数え、待って数え直す）。
// - T38c: 発見のジョブの行（プロファイルの改訂）を書く。API の登録と更新のシナリオを承認でき（許可は出ない）、プロファイルを直すと再承認（前の発見の
//   候補では下書きを保存できない）、同じ画面の保存の本文の鍵が変わる（fixture の `setHostileMemberSave`）と再承認（`CANDIDATE_SHAPE_CHANGED`）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { wait } from '../../src/core/deadline.js';
import type { AuditConfig } from '../../src/config/types.js';
import {
  approveScenario,
  createScenario,
  issueExecutionGrant,
  readScenario,
  readScenarioApprovalStatus,
  updateScenario,
} from '../../src/control/approval/scenario-store.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { recordIdPatternMatchesPagePath } from '../../src/core/record-id-path-pattern.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, updateProfile } from '../../src/control/store/profile-store.js';
import { dateOfCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoveryCandidatesOf, discoveryReadPagePaths, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { submissionProbeKeyFieldsOf } from '../../src/discovery/submission-probe-contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { launchCliChromium, launchHeadlessChromium } from '../helpers/chromium.js';
import { READ_METHODS } from '../helpers/leak-places.js';
import { fastRunConfig } from '../helpers/run-harness.js';
import {
  SPA_APP_PATHS,
  SPA_AUTH_STORAGE_KEY,
  SPA_BACKEND_PATHS,
  SPA_EXTRA_PAGE_HEADER,
  SPA_GRANT_TYPES,
  spaMemberEditPathOf,
  startSpaAuthSite,
  type SpaAuthSite,
  type SpaHostileMemberSave,
} from '../helpers/spa-auth-site-fixture.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_TARGET_PATH, testWriteProfile } from './control-profile-fixtures.js';

const LAUNCHERS: readonly (readonly [string, () => Promise<Browser>])[] = [
  ['the default test Chromium', () => launchHeadlessChromium()],
  ['the CLI Chromium', () => launchCliChromium()],
];
const TEST_TIMEOUT_MS = 240_000;
/** 遅れて届く要求を待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_000;
/** 押した後に静まるまで待つ時間（ms。テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
const MAX_PAGES = 6;
const DEFAULT_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
const FIXTURE_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
const PROFILE_ID = 'example-t38b';
const MARKER_PREFIX = 'bsprobe';
const SAVE_WORD = '保存';
const CREATED_AT = '20261017100000';
const ISSUE_AT = '20261017100500';
/** T38c: 承認の時刻、確かめの時刻、2 回目の発見の時刻。 */
const APPROVE_AT = '20261017100100';
const CHECK_AT = '20261017100200';
const SECOND_DISCOVERY_AT = '20261017100300';
/** T38R-fix: プロファイルを直した後に発見し直す時刻。 */
const REDISCOVERY_AT = '20261017100230';
const EXTERNAL = Object.freeze({ authSetupDigest: `sha256:${'2'.repeat(64)}`, targetConfigDigest: '3'.repeat(64) });
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

describe.each(LAUNCHERS)('T38b: API scenarios from the discovery of the formless member screens with %s', (_label, launch) => {
  let spa: SpaAuthSite | undefined;
  let workDirectory = '';
  let database: ControlDatabase | undefined;

  beforeAll(async () => {
    workDirectory = await mkdtemp(join(tmpdir(), 'beaksight-scenario-api-store-'));
  });

  afterEach(async () => {
    if (database !== undefined) closeControlDatabase(database);
    database = undefined;
    await spa?.close();
    spa = undefined;
  });

  afterAll(async () => {
    await rm(workDirectory, { recursive: true, force: true });
  });

  /** 発見のジョブ（`/admin` から。form のない会員の画面）を動かし、成果物の文書を返す。 */
  const discover = async (site: SpaAuthSite, jobId = 'job-discovery-1'): Promise<DiscoveryDocument> => {
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
        serviceRequestLimits: DEFAULT_LIMITS,
      },
      sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...FIXTURE_KEY }),
    };
    const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
      target: { id: 'spa-api-scenario' }, output: { directory: join(workDirectory, 'discovery') }, crawl: { maxPages: MAX_PAGES },
    });
    const config: AuditConfig = { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
    const outcome = await executeDiscoveryRun({
      config, jobId, authentication, launchBrowser: launch, clock: () => new Date(), now: () => Date.now(),
      stopSignal: new AbortController().signal, submissionProbeQuietWaitMs: SHORT_QUIET_WAIT_MS,
    }, noObserver);
    if (outcome.kind !== 'RAN') {
      throw new Error(`the discovery did not run: ${outcome.kind}`);
    }
    runDirectories.push(outcome.runDirectory);
    return JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
  };
  /** T38f: 発見の Run のディレクトリ（成果物に目印と値が出ないことを確かめる）。 */
  const runDirectories: string[] = [];

  /**
   * 発見のジョブの行（T38c: 下書きの確かめが、候補を見つけた発見のジョブのプロファイルの改訂を読む）と、索引を書く（ジョブの行は終わった状態にする）。
   */
  const recordDiscovery = (opened: ControlDatabase, document: DiscoveryDocument, at: string, profileRevision: number): void => {
    expect(createStartingJob(opened, {
      jobId: document.jobId, jobKind: 'DISCOVERY', profileId: PROFILE_ID, profileRevision, startNew: true, createdAt: at,
    }, () => null)).toEqual({ ok: true });
    expect(recordLoginCheckFinished(opened, document.jobId, 0, at)).toBe(true);
    recordDiscoveryCandidates(opened, {
      profileId: PROFILE_ID, jobId: document.jobId, at,
      entries: mergeDiscoveryCandidates(discoveryCandidatesOf(document)).map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(document),
    });
  };

  /** 書き込みのモードのプロファイル（承認したサービスの Origin は fixture の API の Origin）を作り、管理データを開く。 */
  const openWithProfile = async (site: SpaAuthSite): Promise<{ readonly opened: ControlDatabase; readonly path: string }> => {
    const directory = await mkdtemp(join(workDirectory, 'control-'));
    const path = resolveControlDatabasePath(directory);
    const opened = openControlDatabase(path);
    database = opened;
    expect(createProfile(opened, profileOf(site, MIN_PROFILE_REVISION), { resolveContext: contextOf(site) }).ok).toBe(true);
    return { opened, path };
  };

  const profileOf = (site: SpaAuthSite, revision: number) => ({ ...testWriteProfile(PROFILE_ID, revision, site.appOrigin), approvedServiceOrigins: [site.backendOrigin] });
  const contextOf = (site: SpaAuthSite) => {
    const context = { targetConfig: createTestConfig(site.appOrigin) };
    return (target: string) => (target === TEST_TARGET_PATH ? context : undefined);
  };

  /** 画面の保存のボタンの、probe の結果を持つ候補（まとめた後）。 */
  const saveButtonOf = (document: DiscoveryDocument, path: string): DiscoveryCandidate => {
    const found = mergeDiscoveryCandidates(discoveryCandidatesOf(document)).find((candidate) =>
      candidate.page.path === path && candidate.kind === 'BUTTON' && candidate.submitterWords.includes(SAVE_WORD) && candidate.submissionProbe !== undefined);
    if (found === undefined) throw new Error(`the page ${path} has no save button with a probe`);
    return found;
  };

  /** 下書き（送る鍵は、欄に対応する鍵。ページが決める鍵は、欄に対応しない鍵）。 */
  const draftOf = (candidate: DiscoveryCandidate, api: Record<string, unknown>): Record<string, unknown> => {
    const probe = candidate.submissionProbe;
    if (probe === undefined) throw new Error('the candidate has no probe');
    const keyFields = submissionProbeKeyFieldsOf(probe);
    return {
      profileId: PROFILE_ID,
      candidateIdentityDigest: candidate.identityDigest,
      transport: 'API',
      fieldNames: keyFields.filter(({ field }) => field !== null).map(({ key }) => key),
      readChecks: [],
      sideEffectConfirmations: { TEST_RECORDS_ONLY: true, NO_EXTERNAL_NOTIFICATION: true, NO_PAYMENT_OR_EXTERNAL_SERVICE: true, NOT_DESTRUCTIVE: true },
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      approvalTtlDays: 30,
      api: {
        shapeDigest: probe.shapeDigest,
        pageKeys: keyFields.filter(({ field }) => field === null).map(({ key }) => key),
        filterName: null,
        recordId: null,
        ledger: null,
        ...api,
      },
    };
  };

  it('saves the CREATE and UPDATE API scenarios, writes the candidate with its probe as the evidence, and issues no grant', async () => {
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    site.addMember('既存花子');
    const document = await discover(site);
    const create = saveButtonOf(document, SPA_APP_PATHS.memberNew);
    const update = saveButtonOf(document, spaMemberEditPathOf(1));
    expect([create.submissionProbe?.result, update.submissionProbe?.result]).toEqual(['API_CREATE', 'API_UPDATE']);

    const directory = await mkdtemp(join(workDirectory, 'control-'));
    const path = resolveControlDatabasePath(directory);
    const opened = openControlDatabase(path);
    database = opened;
    const context = { targetConfig: createTestConfig(site.appOrigin) };
    expect(createProfile(opened, { ...testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION, site.appOrigin), approvedServiceOrigins: [site.backendOrigin] }, {
      resolveContext: (target) => (target === TEST_TARGET_PATH ? context : undefined),
    }).ok).toBe(true);
    recordDiscovery(opened, document, CREATED_AT, MIN_PROFILE_REVISION);

    const created = createScenario(opened, { scenarioId: 'scenario-api-create', draft: draftOf(create, {}), discovery: document, at: CREATED_AT });
    expect(created).toMatchObject({ ok: true });
    const createdView = readScenario(opened, 'scenario-api-create');
    expect(createdView?.current).toMatchObject({ kind: 'CREATE', transport: 'API', request: null, api: { request: { method: 'POST', origin: site.backendOrigin } } });
    expect(createdView?.evidence.submissionProbe?.shapeDigest).toBe(create.submissionProbe?.shapeDigest);

    const [filter] = update.submissionProbe?.shape?.filters ?? [];
    const updated = createScenario(opened, {
      scenarioId: 'scenario-api-update',
      draft: draftOf(update, {
        filterName: filter?.name ?? null,
        ledger: { targetCreateScenarioId: 'scenario-api-create', formPathTemplate: '/admin/members/{id}/edit' },
      }),
      discovery: document,
      at: CREATED_AT,
    });
    expect(updated).toMatchObject({ ok: true });
    expect(readScenario(opened, 'scenario-api-update')?.current).toMatchObject({
      kind: 'UPDATE', transport: 'API', api: { request: { method: 'PATCH' }, filterName: filter?.name, ledger: { targetCreateScenarioId: 'scenario-api-create' } },
    });
    // 型の digest が今の発見の行にない下書きは、候補が見つからない（型で行を選ぶ）。
    expect(updateScenario(opened, {
      scenarioId: 'scenario-api-create', expectedRevision: 1, discovery: document, at: CREATED_AT,
      draft: { ...draftOf(create, {}), api: { ...(draftOf(create, {})['api'] as Record<string, unknown>), shapeDigest: `sha256:${'0'.repeat(64)}` } },
    })).toMatchObject({ ok: false, reason: 'SCENARIO_CANDIDATE_NOT_FOUND' });

    // 許可は出さない。T40a: API の登録は送り方では拒まず、FORM と同じ確かめで拒む（承認していない）。
    expect(issueExecutionGrant(opened, {
      scenarioId: 'scenario-api-create', expectedRevision: 1, grantId: 'grant-api-1', jobId: 'job-write-1', count: 1, external: EXTERNAL, at: ISSUE_AT,
    })).toMatchObject({ ok: false, reason: 'GRANT_APPROVAL_INVALID' });

    // 値（目印、fixture の秘密）は、シナリオと管理データのファイル（WAL を含む）に出ない。
    const stored = JSON.stringify([createdView, readScenario(opened, 'scenario-api-update')]);
    closeControlDatabase(opened);
    database = undefined;
    const files = [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString('latin1')).join('\n');
    for (const text of [stored, files]) {
      expect(text.includes(MARKER_PREFIX)).toBe(false);
      for (const secret of site.secretValues()) {
        expect(text.includes(secret)).toBe(false);
      }
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T38c（Task 38 の設計書 3.3、5 章の 1・2）: API のシナリオを承認でき（許可は出ない）、プロファイルを直すと再承認、型が変わる（同じ画面の保存の本文の
  // 鍵を変える）と再承認。プロファイルを直した後は、前の発見の候補で下書きを保存できない（発見のジョブの改訂が今の改訂と違う）。
  it('approves an API scenario without a grant, and needs a new approval after a profile edit and after the shape of the request changed', async () => {
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    site.addMember('既存花子');
    const first = await discover(site, 'job-discovery-1');
    const create = saveButtonOf(first, SPA_APP_PATHS.memberNew);
    const { opened } = await openWithProfile(site);
    recordDiscovery(opened, first, CREATED_AT, MIN_PROFILE_REVISION);
    expect(createScenario(opened, { scenarioId: 'scenario-api-create', draft: draftOf(create, {}), discovery: first, at: CREATED_AT })).toMatchObject({ ok: true });

    const statusAt = (at: string) => readScenarioApprovalStatus(opened, 'scenario-api-create', EXTERNAL, dateOfCompactUtcTimestamp(at));
    const approveAt = (at: string, receiptId: string, expectedRevision = 1) => approveScenario(opened, {
      scenarioId: 'scenario-api-create', expectedRevision, expectedApprovalDigest: statusAt(at)?.approvalDigest ?? '', receiptId, external: EXTERNAL, at,
    });
    expect(statusAt(APPROVE_AT)?.validity).toEqual({ approved: false, reasons: ['NOT_APPROVED'] });
    expect(approveAt(APPROVE_AT, 'receipt-api-1')).toMatchObject({ ok: true });
    // API の UPDATE（form の UPDATE の指定を持たず、台帳の参照を持つ）も承認できる。
    const update = saveButtonOf(first, spaMemberEditPathOf(1));
    const [filter] = update.submissionProbe?.shape?.filters ?? [];
    expect(createScenario(opened, {
      scenarioId: 'scenario-api-update',
      draft: draftOf(update, {
        filterName: filter?.name ?? null, ledger: { targetCreateScenarioId: 'scenario-api-create', formPathTemplate: '/admin/members/{id}/edit' },
      }),
      discovery: first,
      at: CREATED_AT,
    })).toMatchObject({ ok: true });
    const updateDigest = readScenarioApprovalStatus(opened, 'scenario-api-update', EXTERNAL, dateOfCompactUtcTimestamp(APPROVE_AT))?.approvalDigest ?? '';
    expect(approveScenario(opened, {
      scenarioId: 'scenario-api-update', expectedRevision: 1, expectedApprovalDigest: updateDigest, receiptId: 'receipt-api-update-1', external: EXTERNAL, at: APPROVE_AT,
    })).toMatchObject({ ok: true });
    expect(issueExecutionGrant(opened, {
      scenarioId: 'scenario-api-update', expectedRevision: 1, grantId: 'grant-api-2', jobId: 'job-write-2', count: 1, external: EXTERNAL, at: CHECK_AT,
    // T41b: API の更新も送り方では拒まず、FORM と同じ確かめ（入力の規則がない）で拒む（許可が出る通しは `api-update-grant-start.test.ts`）。
    })).toMatchObject({ ok: false, reason: 'NEEDS_RULE_INPUT' });
    expect(statusAt(CHECK_AT)?.validity).toMatchObject({ approved: true, receiptId: 'receipt-api-1' });
    // 承認だけでは許可を出さない。T40a: API の登録は送り方では拒まず、FORM と同じ確かめ（入力の規則がない）で拒む。
    expect(issueExecutionGrant(opened, {
      scenarioId: 'scenario-api-create', expectedRevision: 1, grantId: 'grant-api-1', jobId: 'job-write-1', count: 1, external: EXTERNAL, at: CHECK_AT,
    })).toMatchObject({ ok: false, reason: 'NEEDS_RULE_INPUT' });

    // プロファイルを直すと再承認。前の発見（前の改訂）の候補では、下書きを保存できない。
    expect(updateProfile(opened, {
      profile: { ...profileOf(site, MIN_PROFILE_REVISION + 1), environmentEvidenceRef: 'evidence/example-test-env/isolation-check-2' },
      expectedRevision: MIN_PROFILE_REVISION,
    }, { resolveContext: contextOf(site) }).ok).toBe(true);
    // T38R-fix（C-2）: 索引を書いた最新の発見のジョブの改訂が今の改訂と違うので、発見し直すまで承認し直せない。
    expect(statusAt(CHECK_AT)?.validity).toEqual({ approved: false, reasons: ['PROFILE_REVISION_CHANGED', 'API_DISCOVERY_PROFILE_STALE'] });
    const stale = updateScenario(opened, { scenarioId: 'scenario-api-create', expectedRevision: 1, discovery: first, draft: draftOf(create, {}), at: CHECK_AT });
    expect(stale.ok ? [] : [stale.reason, ...(stale.draftErrors ?? []).map(({ code }) => code)])
      .toEqual(['SCENARIO_DRAFT_INVALID', 'SCENARIO_API_DISCOVERY_PROFILE_STALE']);
    expect(approveAt(CHECK_AT, 'receipt-api-2')).toMatchObject({ ok: false, reason: 'SCENARIO_NOT_APPROVABLE', invalidityReasons: ['API_DISCOVERY_PROFILE_STALE'] });
    const again = await discover(site, 'job-discovery-1b');
    recordDiscovery(opened, again, REDISCOVERY_AT, MIN_PROFILE_REVISION + 1);
    expect(approveAt(REDISCOVERY_AT, 'receipt-api-2')).toMatchObject({ ok: true });
    expect(statusAt(REDISCOVERY_AT)?.validity).toMatchObject({ approved: true, receiptId: 'receipt-api-2' });

    // 同じ画面の保存の本文の鍵が変わる（論理削除の鍵を足す）と、次の発見の索引に、シナリオの型の digest がない → 再承認。
    site.setHostileMemberSave('softDeleteKey');
    const second = await discover(site, 'job-discovery-2');
    const changed = saveButtonOf(second, SPA_APP_PATHS.memberNew);
    expect(changed.identityDigest).toBe(create.identityDigest);
    expect(changed.submissionProbe?.shapeDigest).not.toBe(create.submissionProbe?.shapeDigest);
    recordDiscovery(opened, second, SECOND_DISCOVERY_AT, MIN_PROFILE_REVISION + 1);
    expect(statusAt(SECOND_DISCOVERY_AT)?.validity).toEqual({ approved: false, reasons: ['CANDIDATE_SHAPE_CHANGED'] });
  }, TEST_TIMEOUT_MS);

  // 型の digest v2（Task 38 の設計書 7 章の最後の行）: ページが付けるヘッダの名前が変わると、型の digest が変わり、承認は `CANDIDATE_SHAPE_CHANGED`。
  // 同じ画面を発見し直しただけ（ブラウザが付けるヘッダを含めて同じ送り方）なら、型の digest は同じで、承認は有効のまま。
  it('needs a new approval when the page supplies another header name (shape digest v2), and keeps it when nothing changed', async () => {
    const third = '20261017100400';
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    site.addMember('既存花子');
    const first = await discover(site, 'job-discovery-1');
    const create = saveButtonOf(first, SPA_APP_PATHS.memberNew);
    const { opened } = await openWithProfile(site);
    recordDiscovery(opened, first, CREATED_AT, MIN_PROFILE_REVISION);
    expect(createScenario(opened, { scenarioId: 'scenario-api-create', draft: draftOf(create, {}), discovery: first, at: CREATED_AT })).toMatchObject({ ok: true });
    const statusAt = (at: string) => readScenarioApprovalStatus(opened, 'scenario-api-create', EXTERNAL, dateOfCompactUtcTimestamp(at));
    expect(approveScenario(opened, {
      scenarioId: 'scenario-api-create', expectedRevision: 1, expectedApprovalDigest: statusAt(APPROVE_AT)?.approvalDigest ?? '', receiptId: 'receipt-api-1',
      external: EXTERNAL, at: APPROVE_AT,
    })).toMatchObject({ ok: true });

    // 同じ送り方で発見し直す: 型の digest は同じ（ブラウザが付けるヘッダの名前は digest に入らない）。承認は有効のまま。
    const again = await discover(site, 'job-discovery-2');
    expect(saveButtonOf(again, SPA_APP_PATHS.memberNew).submissionProbe?.shapeDigest).toBe(create.submissionProbe?.shapeDigest);
    recordDiscovery(opened, again, SECOND_DISCOVERY_AT, MIN_PROFILE_REVISION);
    expect(statusAt(SECOND_DISCOVERY_AT)?.validity).toMatchObject({ approved: true, receiptId: 'receipt-api-1' });

    // ページが付けるヘッダを 1 つ足す: 分類は同じ `API_CREATE` のまま、型の digest が変わり、承認は `CANDIDATE_SHAPE_CHANGED`。
    site.setHostileMemberSave('extraPageHeader');
    const changed = await discover(site, 'job-discovery-3');
    const changedCreate = saveButtonOf(changed, SPA_APP_PATHS.memberNew);
    expect(changedCreate.identityDigest).toBe(create.identityDigest);
    expect(changedCreate.submissionProbe?.result).toBe('API_CREATE');
    expect(changedCreate.submissionProbe?.shape?.headerNames).toContain(SPA_EXTRA_PAGE_HEADER.name);
    expect(changedCreate.submissionProbe?.shapeDigest).not.toBe(create.submissionProbe?.shapeDigest);
    recordDiscovery(opened, changed, third, MIN_PROFILE_REVISION);
    expect(statusAt(third)?.validity).toEqual({ approved: false, reasons: ['CANDIDATE_SHAPE_CHANGED'] });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T38R-fix（C-1）: 承認の後に、保存が 2 つの要求を送る形（`doubleSend`）で発見し直すと、probe は `NOT_EXECUTABLE` になり、索引の型の digest に
  // シナリオの型がないので再承認（`CANDIDATE_SHAPE_CHANGED`）。
  it('T38R-fix C-1: needs a new approval after the save sends two requests (doubleSend)', async () => {
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    site.addMember('既存花子');
    const first = await discover(site, 'job-c1-1');
    const create = saveButtonOf(first, SPA_APP_PATHS.memberNew);
    const { opened } = await openWithProfile(site);
    recordDiscovery(opened, first, CREATED_AT, MIN_PROFILE_REVISION);
    expect(createScenario(opened, { scenarioId: 'scenario-c1', draft: draftOf(create, {}), discovery: first, at: CREATED_AT })).toMatchObject({ ok: true });
    const statusAt = (at: string) => readScenarioApprovalStatus(opened, 'scenario-c1', EXTERNAL, dateOfCompactUtcTimestamp(at));
    expect(approveScenario(opened, {
      scenarioId: 'scenario-c1', expectedRevision: 1, expectedApprovalDigest: statusAt(APPROVE_AT)?.approvalDigest ?? '', receiptId: 'receipt-c1',
      external: EXTERNAL, at: APPROVE_AT,
    })).toMatchObject({ ok: true });
    site.setHostileMemberSave('doubleSend');
    const second = await discover(site, 'job-c1-2');
    expect(saveButtonOf(second, SPA_APP_PATHS.memberNew).submissionProbe?.result).toBe('NOT_EXECUTABLE');
    recordDiscovery(opened, second, SECOND_DISCOVERY_AT, MIN_PROFILE_REVISION);
    expect(statusAt(SECOND_DISCOVERY_AT)?.validity).toEqual({ approved: false, reasons: ['CANDIDATE_SHAPE_CHANGED'] });
  }, TEST_TIMEOUT_MS);

  // T38R2-fix（R2-I-1）: 同じ識別のボタンが 2 つある画面（fixture の `hostileMemberInput: 'duplicateSubmit'`）。1 回目の発見はどちらも 1 つの要求で承認し、
  // 2 回目はもう 1 つのボタンだけが 2 つの要求を送る（最初の型はシナリオの型と同じ）。まとめた後の行は書き込みでない行になり、再承認
  // （`CANDIDATE_SHAPE_CHANGED`）。その行では下書きも保存できない。
  it('T38R2-fix R2-I-1: needs a new approval when another button of the same identity sends two requests of the same first shape', async () => {
    const site = await startSpaAuthSite({ hostileMemberInput: 'duplicateSubmit' });
    spa = site;
    site.addMember('既存花子');
    const saveRowsOf = (document: DiscoveryDocument): readonly DiscoveryCandidate[] => discoveryCandidatesOf(document).filter((candidate) =>
      candidate.page.path === SPA_APP_PATHS.memberNew && candidate.kind === 'BUTTON' && candidate.submitterWords.includes(SAVE_WORD)
      && candidate.submissionProbe !== undefined);
    const first = await discover(site, 'job-r2i1-1');
    const create = saveButtonOf(first, SPA_APP_PATHS.memberNew);
    // 同じ識別の 2 つのボタンを、どちらも押した（どちらも 1 つの要求で、同じ型）。
    expect(saveRowsOf(first).map(({ identityDigest, submissionProbe }) => [identityDigest, submissionProbe?.result, submissionProbe?.shapeDigest])).toEqual([
      [create.identityDigest, 'API_CREATE', create.submissionProbe?.shapeDigest],
      [create.identityDigest, 'API_CREATE', create.submissionProbe?.shapeDigest],
    ]);
    const { opened } = await openWithProfile(site);
    recordDiscovery(opened, first, CREATED_AT, MIN_PROFILE_REVISION);
    expect(createScenario(opened, { scenarioId: 'scenario-r2i1', draft: draftOf(create, {}), discovery: first, at: CREATED_AT })).toMatchObject({ ok: true });
    const statusAt = (at: string) => readScenarioApprovalStatus(opened, 'scenario-r2i1', EXTERNAL, dateOfCompactUtcTimestamp(at));
    expect(approveScenario(opened, {
      scenarioId: 'scenario-r2i1', expectedRevision: 1, expectedApprovalDigest: statusAt(APPROVE_AT)?.approvalDigest ?? '', receiptId: 'receipt-r2i1',
      external: EXTERNAL, at: APPROVE_AT,
    })).toMatchObject({ ok: true });
    expect(statusAt(CHECK_AT)?.validity).toMatchObject({ approved: true });

    site.setDuplicateSaveSendsTwice(true);
    const second = await discover(site, 'job-r2i1-2');
    // 保存のボタン（先）は 1 つの要求、もう 1 つのボタン（後）は 2 つの要求。最初の型は同じ。
    expect(saveRowsOf(second).map(({ submissionProbe }) => [submissionProbe?.result, submissionProbe?.reason, submissionProbe?.shapeDigest])).toEqual([
      ['API_CREATE', null, create.submissionProbe?.shapeDigest],
      ['NOT_EXECUTABLE', 'MULTIPLE_REQUESTS', create.submissionProbe?.shapeDigest],
    ]);
    expect(saveButtonOf(second, SPA_APP_PATHS.memberNew).submissionProbe?.result).toBe('NOT_EXECUTABLE');
    recordDiscovery(opened, second, SECOND_DISCOVERY_AT, MIN_PROFILE_REVISION);
    expect(statusAt(SECOND_DISCOVERY_AT)?.validity).toEqual({ approved: false, reasons: ['CANDIDATE_SHAPE_CHANGED'] });
    const rejected = createScenario(opened, { scenarioId: 'scenario-r2i1-again', draft: draftOf(create, {}), discovery: second, at: SECOND_DISCOVERY_AT });
    expect(rejected.ok ? [] : [rejected.reason, ...(rejected.draftErrors ?? []).map(({ code }) => code)]).toEqual(['SCENARIO_DRAFT_INVALID', 'SCENARIO_API_CANDIDATE_NOT_API']);
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T38R-fix（C-2）: 下書きの後に、承認したサービスの Origin を外すと、承認できない（Origin が型の番号の位置にない。最新の発見の改訂も違う）。
  it('T38R-fix C-2: does not approve a draft whose API origin was removed from the approved service origins after the draft', async () => {
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    site.addMember('既存花子');
    const first = await discover(site, 'job-c2-1');
    const create = saveButtonOf(first, SPA_APP_PATHS.memberNew);
    const { opened } = await openWithProfile(site);
    recordDiscovery(opened, first, CREATED_AT, MIN_PROFILE_REVISION);
    expect(createScenario(opened, { scenarioId: 'scenario-c2', draft: draftOf(create, {}), discovery: first, at: CREATED_AT })).toMatchObject({ ok: true });
    expect(updateProfile(opened, {
      profile: { ...profileOf(site, MIN_PROFILE_REVISION + 1), approvedServiceOrigins: [site.otherOrigin] }, expectedRevision: MIN_PROFILE_REVISION,
    }, { resolveContext: contextOf(site) }).ok).toBe(true);
    const statusAt = (at: string) => readScenarioApprovalStatus(opened, 'scenario-c2', EXTERNAL, dateOfCompactUtcTimestamp(at));
    expect(approveScenario(opened, {
      scenarioId: 'scenario-c2', expectedRevision: 1, expectedApprovalDigest: statusAt(APPROVE_AT)?.approvalDigest ?? '', receiptId: 'receipt-c2',
      external: EXTERNAL, at: APPROVE_AT,
    })).toMatchObject({ ok: false, reason: 'SCENARIO_NOT_APPROVABLE', invalidityReasons: ['API_ORIGIN_NOT_APPROVED', 'API_DISCOVERY_PROFILE_STALE'] });
    expect(statusAt(CHECK_AT)?.validity).toEqual({ approved: false, reasons: ['API_ORIGIN_NOT_APPROVED', 'API_DISCOVERY_PROFILE_STALE', 'NOT_APPROVED'] });
  }, TEST_TIMEOUT_MS);

  // T38f（Task 38 の設計書 5 章の G38）: 承認したサービスの Origin を変えると再承認。論理削除の鍵・method の上書き・承認していない Origin の保存の
  // 送り方は、発見し直した候補の下書きで拒む。目印と値は、管理データ（WAL を含む）と発見の成果物に出ない。発見の probe を含めて、サーバに届いた
  // 読み取りでない要求は 0。
  it('G38: needs a new approval after the approved service origins changed, rejects the hostile shapes in the draft, and keeps no value', async () => {
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    site.addMember('既存花子');
    runDirectories.splice(0);
    const first = await discover(site, 'job-g38-1');
    const create = saveButtonOf(first, SPA_APP_PATHS.memberNew);
    const { opened, path } = await openWithProfile(site);
    recordDiscovery(opened, first, CREATED_AT, MIN_PROFILE_REVISION);
    expect(createScenario(opened, { scenarioId: 'scenario-g38', draft: draftOf(create, {}), discovery: first, at: CREATED_AT })).toMatchObject({ ok: true });
    const statusAt = (at: string) => readScenarioApprovalStatus(opened, 'scenario-g38', EXTERNAL, dateOfCompactUtcTimestamp(at));
    expect(approveScenario(opened, {
      scenarioId: 'scenario-g38', expectedRevision: 1, expectedApprovalDigest: statusAt(APPROVE_AT)?.approvalDigest ?? '', receiptId: 'receipt-g38',
      external: EXTERNAL, at: APPROVE_AT,
    })).toMatchObject({ ok: true });
    expect(statusAt(CHECK_AT)?.validity).toMatchObject({ approved: true });

    // 承認したサービスの Origin だけを変えたプロファイルの改訂も、再承認が要る。
    expect(updateProfile(opened, {
      profile: { ...profileOf(site, MIN_PROFILE_REVISION + 1), approvedServiceOrigins: [site.backendOrigin, site.otherOrigin] },
      expectedRevision: MIN_PROFILE_REVISION,
    }, { resolveContext: contextOf(site) }).ok).toBe(true);
    // T38R-fix（C-2）: 索引を書いた最新の発見のジョブの改訂も今の改訂と違う（発見し直すまで承認し直せない）。
    expect(statusAt(CHECK_AT)?.validity).toEqual({ approved: false, reasons: ['PROFILE_REVISION_CHANGED', 'API_DISCOVERY_PROFILE_STALE'] });

    // 敵対的な保存の送り方で発見し直すと、その候補の下書きは拒まれる（理由は候補の確かめ。probe の分類と、下書きの I21 の照らし直し）。
    const hostile: readonly (readonly [SpaHostileMemberSave, string])[] = [
      ['softDeleteKey', 'SCENARIO_API_CANDIDATE_NOT_API'],
      ['methodOverrideHeader', 'SCENARIO_API_CANDIDATE_NOT_API'],
      ['bodyMethodOverride', 'SCENARIO_API_CANDIDATE_NOT_API'],
      ['unapprovedOrigin', 'SCENARIO_API_CANDIDATE_NOT_API'],
    ];
    for (const [index, [save, code]] of hostile.entries()) {
      site.setHostileMemberSave(save);
      const document = await discover(site, `job-g38-hostile-${String(index)}`);
      const at = `2026101711${String(index).padStart(2, '0')}00`;
      recordDiscovery(opened, document, at, MIN_PROFILE_REVISION + 1);
      const candidate = saveButtonOf(document, SPA_APP_PATHS.memberNew);
      expect(candidate.submissionProbe?.result, save).not.toBe('API_CREATE');
      const result = createScenario(opened, { scenarioId: `scenario-g38-${String(index)}`, draft: draftOf(candidate, {}), discovery: document, at });
      expect(result.ok ? [] : [result.reason, ...(result.draftErrors ?? []).map((error) => error.code)].slice(0, 2), save)
        .toEqual(['SCENARIO_DRAFT_INVALID', code]);
    }

    // 目印と値（fixture の秘密）は、管理データのファイル（WAL を含む）と発見の成果物に出ない。
    closeControlDatabase(opened);
    database = undefined;
    const artifacts = runDirectories.flatMap((directory) => readdirSync(directory, { recursive: true, encoding: 'utf8' })
      .map((name) => join(directory, name))
      .filter((file) => statSync(file).isFile())
      .map((file) => readFileSync(file).toString('latin1')));
    const files = [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString('latin1'));
    expect(artifacts.length).toBeGreaterThan(0);
    for (const text of [...files, ...artifacts]) {
      expect(text.includes(MARKER_PREFIX)).toBe(false);
      for (const secret of site.secretValues()) {
        expect(text.includes(secret)).toBe(false);
      }
    }
    // 発見の probe を含めて、サーバに届いた読み取りでない要求は 0。
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method))).toEqual([]);
  }, TEST_TIMEOUT_MS * 3);

  // T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2 (a)・(b)）: form のない登録の画面の API のシナリオで、`{id}` の照合の READ の期待が行の数
  // だけの下書きと、画面から ID を取る型に登録の画面（`/admin/members/new`）が当たる下書きを、保存で拒む（何も書かない）。生成した値と比べる期待を持ち、
  // 型が登録の画面に当たらない下書きは保存できる。
  // T40R2-fix: (b) の ID の型は保存できて注意の判定が真（意図した変化）。M-1 の毎回同じ値の欄だけの照合は、許可の発行で拒む。
  it('T40R-fix-B / T40R2-fix: rejects a row-count-only template READ, saves a record id pattern the new page matches with a caution, and issues no grant for a constant expectation', async () => {
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    const document = await discover(site);
    const create = saveButtonOf(document, SPA_APP_PATHS.memberNew);
    const { opened } = await openWithProfile(site);
    recordDiscovery(opened, document, CREATED_AT, MIN_PROFILE_REVISION);
    expect(createReadCheck(opened, {
      readCheckId: 'rc-api-member', profileId: PROFILE_ID, at: CREATED_AT,
      definition: { targetPagePath: '/admin/members/{id}', parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] },
    }).ok).toBe(true);
    const verificationOf = (expectations: readonly Record<string, unknown>[], recordId: Record<string, unknown> | null) => ({
      successCondition: null, inputErrorCondition: null, recordId,
      readVerification: { readCheckId: 'rc-api-member', revision: 1, bindings: [], expectations },
    });
    const saveWith = (scenarioId: string, verification: Record<string, unknown>) => createScenario(opened, {
      scenarioId, draft: { ...draftOf(create, { recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } }), verification }, discovery: document, at: CREATED_AT,
    });
    const codesOf = (result: ReturnType<typeof createScenario>): readonly string[] =>
      (result.ok ? [] : [result.reason, ...(result.draftErrors ?? []).map(({ code }) => code)]);

    expect(codesOf(saveWith('scenario-row-count', verificationOf([{ kind: 'ROW_COUNT_EQUALS', count: 1 }], null))))
      .toEqual(['SCENARIO_DRAFT_INVALID', 'SCENARIO_API_READ_VERIFICATION_NOT_BOUND']);
    expect(readScenario(opened, 'scenario-row-count')).toBeNull();
    // T40R2-fix（使える度合い）: 登録の画面に当たる ID の型は保存でき（意図した変化）、注意の判定が真になる（画面が注意を出す）。
    const newPageId = { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' };
    expect(saveWith('scenario-new-page-id', verificationOf([{ kind: 'TEXT_CONTAINS', fieldName: 'email' }], newPageId))).toMatchObject({ ok: true });
    const savedNewPageId = readScenario(opened, 'scenario-new-page-id');
    expect(savedNewPageId?.current.verification.recordId).toEqual(newPageId);
    expect(recordIdPatternMatchesPagePath(savedNewPageId?.current.verification.recordId ?? null, savedNewPageId?.evidence.page.path ?? '')).toBe(true);
    expect(saveWith('scenario-fixed', verificationOf([{ kind: 'ROW_COUNT_EQUALS', count: 1 }, { kind: 'TEXT_CONTAINS', fieldName: 'email' }],
      { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}/edit' }))).toMatchObject({ ok: true });
    expect(recordIdPatternMatchesPagePath(readScenario(opened, 'scenario-fixed')?.current.verification.recordId ?? null, SPA_APP_PATHS.memberNew)).toBe(false);

    // T40R2-fix（M-1）: 照合の READ の期待の欄（email）が、毎回同じ値になる規則（1 つの値だけの固定の一覧）なら、承認しても許可を出さない。生成した値の
    // 規則（テンプレートの合成のメール）に替えると、許可が出る。
    const approveWithRules = (fieldRules: readonly Record<string, unknown>[], expectedRuleSetRevision: number | null, at: string): void => {
      const before = readScenario(opened, 'scenario-fixed');
      const saved = saveRuleSetAndAttach(opened, {
        ruleSetId: 'rules-api-fixed', scenarioId: 'scenario-fixed', expectedRevision: expectedRuleSetRevision,
        content: { fieldRules: fieldRules as never, relations: [], uniqueKeyFieldNames: [] },
        expectedScenarioRevision: before?.revision ?? 0, at,
      });
      expect(saved.ruleSet).toMatchObject({ ok: true, evaluation: { executable: true } });
      const revision = readScenario(opened, 'scenario-fixed')?.revision ?? 0;
      const digest = readScenarioApprovalStatus(opened, 'scenario-fixed', EXTERNAL, dateOfCompactUtcTimestamp(at))?.approvalDigest ?? '';
      expect(approveScenario(opened, {
        scenarioId: 'scenario-fixed', expectedRevision: revision, expectedApprovalDigest: digest, receiptId: `receipt-fixed-${at}`, external: EXTERNAL, at,
      })).toMatchObject({ ok: true });
    };
    const issueAt = (grantId: string, at: string) => issueExecutionGrant(opened, {
      scenarioId: 'scenario-fixed', expectedRevision: readScenario(opened, 'scenario-fixed')?.revision ?? 0, grantId, jobId: `job-${grantId}`, count: 1,
      external: EXTERNAL, at,
    });
    approveWithRules([{ fieldName: 'email', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: ['sample0001@example.invalid'] }],
      null, APPROVE_AT);
    expect(issueAt('grant-fixed-1', APPROVE_AT)).toMatchObject({ ok: false, reason: 'READ_VERIFICATION_NOT_VARYING' });
    approveWithRules([], 1, CHECK_AT);
    expect(issueAt('grant-fixed-2', CHECK_AT)).toMatchObject({ ok: true, grant: { reservation: { state: 'RESERVED' } } });
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // T41a（Task 41 の設計書 3.1、3.3 のページが決める鍵）: form のない会員の更新の画面の API の UPDATE を、変える鍵（名前）と保つ鍵（メールアドレス・備考）で
  // 保存して承認する。シナリオは画面の path を型にした識別の digest を持ち、それは索引の型にした digest の一覧にある（版 14 のまま）。台帳の登録が応答の
  // 鍵から ID を取るときは、その鍵が filter の名前と同じであること（違う台帳では保存できない）。許可は、入力の規則がないので出ない（T41b から送り方では
  // 拒まない）。
  it('T41a: saves and approves an API UPDATE with the changed key and the kept keys, bound to the ledger id, and issues no grant yet', async () => {
    const site = await startSpaAuthSite({ memberScreenLayout: 'formless' });
    spa = site;
    site.addMember('既存花子');
    const document = await discover(site);
    const create = saveButtonOf(document, SPA_APP_PATHS.memberNew);
    const update = saveButtonOf(document, spaMemberEditPathOf(1));
    const { opened } = await openWithProfile(site);
    recordDiscovery(opened, document, CREATED_AT, MIN_PROFILE_REVISION);
    const [filter] = update.submissionProbe?.shape?.filters ?? [];
    expect(filter?.name).toBe('id');
    expect(createScenario(opened, {
      scenarioId: 'scenario-api-create', draft: draftOf(create, { recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' } }), discovery: document, at: CREATED_AT,
    })).toMatchObject({ ok: true });
    expect(createScenario(opened, {
      scenarioId: 'scenario-api-create-other-id', draft: draftOf(create, { recordId: { source: 'RESPONSE_BODY_KEY', key: 'member_id' } }), discovery: document,
      at: CREATED_AT,
    })).toMatchObject({ ok: true });
    const updateDraftOf = (targetCreateScenarioId: string): Record<string, unknown> => {
      const base = draftOf(update, {
        filterName: filter?.name ?? null, ledger: { targetCreateScenarioId, formPathTemplate: '/admin/members/{id}/edit' }, keptKeys: ['email', 'note'],
      });
      return { ...base, fieldNames: ['name'] };
    };

    // 台帳の ID の鍵（member_id）が filter の名前（id）と違えば、保存できない。
    const unbound = createScenario(opened, { scenarioId: 'scenario-api-update-unbound', draft: updateDraftOf('scenario-api-create-other-id'), discovery: document, at: CREATED_AT });
    expect(unbound.ok ? [] : [unbound.reason, ...(unbound.draftErrors ?? []).map(({ code }) => code)])
      .toEqual(['SCENARIO_DRAFT_INVALID', 'SCENARIO_API_FILTER_NOT_BOUND_TO_LEDGER_ID']);

    expect(createScenario(opened, { scenarioId: 'scenario-api-update', draft: updateDraftOf('scenario-api-create'), discovery: document, at: CREATED_AT }))
      .toMatchObject({ ok: true });
    const saved = readScenario(opened, 'scenario-api-update')?.current;
    expect(saved).toMatchObject({ kind: 'UPDATE', transport: 'API', fieldNames: ['name'], update: null });
    expect(saved?.api?.keyFields.map(({ key }) => key)).toEqual(['name']);
    expect(saved?.api?.keptKeys?.map(({ key }) => key)).toEqual(['email', 'note']);
    expect(saved?.api?.pageKeys).toEqual([]);
    const templated = saved?.api?.templatedIdentityDigest ?? '';
    expect(templated).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(discoveryIndexEntryOf(update).templatedIdentityDigests).toContain(templated);

    const digest = readScenarioApprovalStatus(opened, 'scenario-api-update', EXTERNAL, dateOfCompactUtcTimestamp(APPROVE_AT))?.approvalDigest ?? '';
    expect(approveScenario(opened, {
      scenarioId: 'scenario-api-update', expectedRevision: 1, expectedApprovalDigest: digest, receiptId: 'receipt-api-update-1', external: EXTERNAL, at: APPROVE_AT,
    })).toMatchObject({ ok: true });
    expect(readScenarioApprovalStatus(opened, 'scenario-api-update', EXTERNAL, dateOfCompactUtcTimestamp(CHECK_AT))?.validity)
      .toMatchObject({ approved: true, receiptId: 'receipt-api-update-1' });
    expect(issueExecutionGrant(opened, {
      scenarioId: 'scenario-api-update', expectedRevision: 1, grantId: 'grant-api-update-1', jobId: 'job-write-1', count: 1, external: EXTERNAL, at: CHECK_AT,
    // T41b: 送り方では拒まない（入力の規則がないので許可は出ない。許可から START までは `api-update-grant-start.test.ts`）。
    })).toMatchObject({ ok: false, reason: 'NEEDS_RULE_INPUT' });

    // 値（目印、fixture の秘密）は、シナリオに出ない。
    const stored = JSON.stringify(readScenario(opened, 'scenario-api-update'));
    expect(stored.includes(MARKER_PREFIX)).toBe(false);
    for (const secret of site.secretValues()) {
      expect(stored.includes(secret)).toBe(false);
    }
    await wait(LATE_REQUEST_WAIT_MS);
    expect(site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
