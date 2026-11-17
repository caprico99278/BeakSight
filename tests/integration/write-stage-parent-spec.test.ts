// RB-fix-456（DEF-278）: フォームの形の書き込みで、親（ジョブの管理）が作った書き込みの段の指定（`NEXT_STAGE` の `write`）を、本物の書き込みの段が使う通しの
// 確かめ（1 場面）。親の側は `control-write-jobs.test.ts` と同じ道（点検を偽のワーカーで通し、偽のワーカーが受けた `START` と `NEXT_STAGE` を読む）、
// ワーカーの側は段の入口（`runChainStageOnce`）に、`START` と同じ確かめ（`validatedChainWriteOf`）を通した指定を与え、本物の書き込みの流れ
// （`executeWriteCreateRun`）と本物の Chromium（テストの既定の headless）で、127.0.0.1 の fixture のサイト（`write-site-fixture.ts`）に送る。
// - 承認に縛る digest は、本物の発見の入口（`readCandidatePage`）で読んだ候補から取る（手で書かない）。確かめ直しの往復は、テストが偽の親として許す。
// - 管理データと出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。値は匿名の合成のテストデータだけ。
// - WSO（2 場面目）: 「チェックした画面だけ」の点検。親は点検の段 1 つと読む画面（登録の画面と、照合の READ の一覧の画面）を渡し、点検の段の後に書き込みの段を
//   続ける。本物の点検の段（`executeAuditRun`。同じ Chromium）は、その画面だけを読み、一覧のリンク先（会員の画面）へ広げない。続く本物の書き込みの段が 1 件送る。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import { createScenario } from '../../src/control/approval/scenario-store.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { validateParentToWorkerMessage, type WorkerNextStageMessage, type WorkerStartMessage } from '../../src/control/worker-protocol.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { CHECKED_WRITE_SCREENS_SCOPE, type AuditPageScopeKind } from '../../src/core/audit-page-scope.js';
import { executeAuditRun } from '../../src/cli/audit-run.js';
import { createNavigationPacer } from '../../src/crawl/navigation-pacer.js';
import { discoveryReadPagePaths, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { runChainStageOnce, validatedChainWriteOf, type ChainStageRunners } from '../../src/worker/chain-stage.js';
import { executeWriteCreateRun } from '../../src/worker/write-create-run.js';
import type { WorkerWriteSubmissionReport } from '../../src/worker/write-ipc.js';
import { browserSharedForRun } from '../helpers/browser-proxies.js';
import { chainWriteWorkerValues, runWriteChain } from '../helpers/chain-write-support.js';
import { launchHeadlessChromium } from '../helpers/chromium.js';
import { writeFakeWorker } from '../helpers/fake-audit-worker.js';
import { awaitWorkersExit, createFakeWorkerJobManager, withOutputDirectory } from '../helpers/job-test-support.js';
import { createTestConfig } from '../helpers/test-config.js';
import { TEST_SHORT_SETTLE_OBSERVATION_WINDOWS } from '../helpers/test-waits.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  attachNameRulesAndApprove,
  createWriteSiteReadCheck,
  readWriteSiteCandidates,
  writeSiteAuthSetupOf,
  writeSiteCreateDraftOf,
  writeSiteRunAuthenticationOf,
  type WriteSiteCandidates,
} from '../helpers/write-site-candidates.js';
import { WRITE_SITE_PATHS, startWriteSite, type WriteSite } from '../helpers/write-site-fixture.js';
import { TEST_TARGET_PATH, testWriteProfile } from './control-profile-fixtures.js';
import { DISCOVERY_JOB_ID, discoveryDocumentOf } from './execution-grant-fixtures.js';

const PROFILE_ID = 'example-parent-spec';
const SCENARIO_ID = 'scenario-parent-spec';
const OUTPUT_DIRECTORY = 'parent-spec-output';
/** 押した後に結果を待つ上限（ms。ループバックの fixture）。 */
const RESULT_TIMEOUT_MS = 3_000;

let browser: Browser;
let site: WriteSite;
let workDirectory: string;
let database: ControlDatabase;
let candidates: WriteSiteCandidates;
/** 偽のワーカーが親から受けた `START` と、書き込みの段の `NEXT_STAGE`。 */
let parent: { readonly start: WorkerStartMessage; readonly next: WorkerNextStageMessage };
const forks = createCountingFork();

const nowText = (): string => formatCompactUtcTimestamp(new Date(), 'test time');
const configFor = () => createTestConfig(site.origin, WRITE_SITE_PATHS.form, {
  crawl: { minNavigationIntervalMs: 0 },
  audit: { screenshots: false },
  output: { directory: join(workDirectory, OUTPUT_DIRECTORY) },
});
const resolveContext = (path: string) => (path === TEST_TARGET_PATH ? { targetConfig: configFor() } : undefined);
/** 点検の発見の段の成果物（登録の画面と一覧の検索の候補）。 */
const discovery = (): DiscoveryDocument => discoveryDocumentOf(DISCOVERY_JOB_ID, [candidates.form, candidates.search]);

const authentication = (): RunAuthentication => writeSiteRunAuthenticationOf(site.origin, site.issueSession());

/** プロファイル・認証の設定・照合の READ・発見の索引・シナリオ（規則を付け、本物の事実で承認）を作る（`write-site-candidates.ts` の準備）。 */
async function prepareApprovedScenario(): Promise<void> {
  mkdirSync(dirname(join(workDirectory, TEST_TARGET_PATH)), { recursive: true });
  writeFileSync(join(workDirectory, TEST_TARGET_PATH), JSON.stringify({ target: { id: PROFILE_ID } }), 'utf8');
  expect(createProfile(database, testWriteProfile(PROFILE_ID, MIN_PROFILE_REVISION, site.origin), { resolveContext }).ok).toBe(true);
  expect(saveAuthSetup(database, writeSiteAuthSetupOf(PROFILE_ID, site.origin), { resolveContext }).ok).toBe(true);
  createWriteSiteReadCheck(database, PROFILE_ID, candidates.search, nowText());
  recordDiscoveryCandidates(database, {
    profileId: PROFILE_ID, jobId: DISCOVERY_JOB_ID, at: nowText(),
    entries: mergeDiscoveryCandidates([candidates.form, candidates.search]).map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(discovery()),
  });
  const created = createScenario(database, { scenarioId: SCENARIO_ID, draft: writeSiteCreateDraftOf(PROFILE_ID, candidates.form), discovery: discovery(), at: nowText() });
  const stored = getProfile(database, PROFILE_ID);
  const facts = stored === null ? null : await approvalExternalFactsOf(stored, {
    database, repositoryRoot: workDirectory, credentialStore: { readMetadata: () => Promise.resolve(null) },
  });
  if (facts === null) {
    throw new Error('the external facts are not available');
  }
  // WSO: 2 場面目の書き込みも値を作れるよう、名前の候補を 2 つにする（送った値は生成の履歴に入り、同じ値は作らない）。
  attachNameRulesAndApprove(database, created, { scenarioId: SCENARIO_ID, names: ['試験 花子', '試験 次郎'], facts, now: new Date(), at: nowText() });
}

/** 点検を偽のワーカーで通し、偽のワーカーが受けた `START` と、書き込みの段の `NEXT_STAGE` を返す（WSO: `scope` は点検の範囲）。 */
async function parentMessages(scope?: AuditPageScopeKind): Promise<{ readonly start: WorkerStartMessage; readonly next: WorkerNextStageMessage }> {
  const directory = join(workDirectory, scope === undefined ? 'worker' : 'worker-scoped');
  mkdirSync(directory, { recursive: true });
  const outputDirectory = resolve(workDirectory, OUTPUT_DIRECTORY);
  const worker = writeFakeWorker(directory, 'chain', chainWriteWorkerValues({
    outputDirectory,
    discovery: discovery(),
    writeRunId: 'RUN-20261115000000',
    write: { outputDirectory, recheck: 1, onReject: 'report', submission: { submission: 'NOT_SENT', blockReason: null }, actionRunText: null, end: 'finish' },
  }));
  const manager = createFakeWorkerJobManager({
    database, workDirectory, worker, resolveContext: withOutputDirectory(resolveContext, OUTPUT_DIRECTORY), forkWorker: forks.fork,
  });
  let ended: unknown = null;
  try {
    ended = (await runWriteChain(manager, PROFILE_ID, MIN_PROFILE_REVISION, undefined, scope)).chain;
  } finally {
    await manager.close();
  }
  const messages = worker.received().flatMap((message) => {
    const checked = validateParentToWorkerMessage(message);
    return checked.ok ? [checked.message] : [];
  });
  const start = messages.find((message): message is WorkerStartMessage => message.type === 'START');
  const next = messages.find((message): message is WorkerNextStageMessage => message.type === 'NEXT_STAGE' && message.write !== undefined);
  if (start === undefined || next === undefined) {
    throw new Error(`the parent did not send the write stage: ${JSON.stringify({ chain: ended, received: worker.received() })}`);
  }
  return { start, next };
}

beforeAll(async () => {
  browser = await launchHeadlessChromium();
  site = await startWriteSite();
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-write-stage-parent-spec-'));
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  candidates = await readWriteSiteCandidates(browser, configFor(), authentication());
  // 親の側（点検を偽のワーカーで通す。`control-write-jobs.test.ts` の道）。場面は、親が作った指定を段に与えてから。
  await prepareApprovedScenario();
  parent = await parentMessages();
});

afterAll(async () => {
  await awaitWorkersExit(forks.children);
  closeControlDatabase(database);
  await browser?.close();
  await site?.close();
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('DEF-278: the real write stage uses the write specification the parent made', () => {
  it('passes the parent NEXT_STAGE write through the stage entry, and the real form write sends one POST to the site', async () => {
    const reports = await runRealWriteStage(parent.start, parent.next);

    expect(site.requests.filter(({ method, path }) => method === 'POST' && path.split('?')[0] === WRITE_SITE_PATHS.create)).toHaveLength(1);
    expect(reports.map(({ submission }) => submission)).toEqual(['SENT']);
  });
});

/** WSO: 本物の書き込みの段を、親が作った `NEXT_STAGE` の指定で 1 回行う（1 場面目と同じ入口）。送った報告を返す。 */
async function runRealWriteStage(start: WorkerStartMessage, next: WorkerNextStageMessage): Promise<readonly WorkerWriteSubmissionReport[]> {
  const write = validatedChainWriteOf(start, next);
  expect(write).not.toBeNull();
  const reports: WorkerWriteSubmissionReport[] = [];
  const runners: ChainStageRunners = {
    audit: async () => 1,
    discover: null,
    readCheck: null,
    write: async (stage, checkedWrite, config, stageAuthentication, navigationPacer, stageCarry) => (await executeWriteCreateRun({
      config, jobId: stage.jobId, authentication: stageAuthentication, write: checkedWrite,
      launchBrowser: async () => browserSharedForRun(browser), clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal,
      recheck: async () => ({ allowed: true }), reportSubmission: (report) => reports.push(report), navigationPacer, stageCarry,
      resultTimeoutMs: RESULT_TIMEOUT_MS, observationWindows: TEST_SHORT_SETTLE_OBSERVATION_WINDOWS,
    }, { onRunStarted: () => undefined, onSessionLost: () => undefined })).exitCode,
    unsupported: () => 1,
  };
  await runChainStageOnce({
    stage: { kind: 'WRITE_CREATE', jobId: next.jobId, readChecks: undefined, write: write ?? undefined },
    runOptions: { startNew: true },
    config: configFor(),
    automatedLogin: false,
    seed: {
      authentication: authentication(),
      navigationPacer: createNavigationPacer({ minIntervalMs: 0, now: () => Date.now(), sleep: async () => undefined }),
      serviceRequestWindowMs: [],
    },
  }, runners);
  return reports;
}

describe('WSO: the inspection of the checked screens only reads the checked screen and its list, then writes', () => {
  it('reads only the screens the parent gave, does not follow the links of the list, and the write stage sends one POST', async () => {
    // 一覧に、会員の画面へのリンクを出す（読む画面の外。サイトの全部の画面の点検なら読みに行く）。
    site.enableUpdatePages();
    site.addMember('既存 太郎');
    const { start, next } = await parentMessages(CHECKED_WRITE_SCREENS_SCOPE);
    expect(start.chain?.stages).toEqual(['AUDIT']);
    expect(start.chain?.writeStages).toBe(true);
    const pages = start.chain?.checkedScreenPages ?? [];
    expect(pages.map(({ path }) => path)).toEqual([WRITE_SITE_PATHS.form, WRITE_SITE_PATHS.list]);

    // 本物の点検の段（親が渡した画面だけ）。
    const before = site.requests.length;
    const outcome = await executeAuditRun(configFor(), {
      launchBrowser: async () => browserSharedForRun(browser), clock: () => new Date(), now: () => Date.now(), authentication: authentication(),
      observationWindows: TEST_SHORT_SETTLE_OBSERVATION_WINDOWS,
    }, { startNew: true, pageScope: pages.map(({ origin, path }) => `${origin}${path}`) });
    expect(outcome.kind).toBe('RAN');
    const readPaths = new Set(site.requests.slice(before)
      .filter(({ method }) => method === 'GET')
      .map(({ path }) => path.split('?')[0] ?? '')
      // REV-WSO の I-2: sitemap.xml は取りに行かない（robots.txt だけ）。
      .filter((path) => path !== '/robots.txt'));
    expect([...readPaths].sort()).toEqual([WRITE_SITE_PATHS.list, WRITE_SITE_PATHS.form].sort());

    // 続く本物の書き込みの段。
    const posts = (): number => site.requests.filter(({ method, path }) => method === 'POST' && path.split('?')[0] === WRITE_SITE_PATHS.create).length;
    const postsBefore = posts();
    const reports = await runRealWriteStage(start, next);
    expect(posts() - postsBefore).toBe(1);
    expect(reports.map(({ submission }) => submission)).toEqual(['SENT']);
  });
});
