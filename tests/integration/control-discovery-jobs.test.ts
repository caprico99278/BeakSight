// T27d（Task 27 の設計書 4.4、4.6 と、変更履歴の「T27b・T27c の報告と T27d の前の判断」「Blocker: T27d」の行）: 発見のジョブ（`DISCOVERY`）の、
// ジョブの管理（`createAuditJobManager` の `startDiscovery` と、ジョブの終わりの索引の更新）を、偽のワーカー（`tests/helpers/fake-audit-worker.ts`
// の `discovery` の動き）を本物の `fork` で起動して確かめる（本物のワーカーと Chromium での端から端は `discovery-job-fork.test.ts`）。
// - 開始の確かめは監査と同じ（プロファイルが `TEST_AUTH_PASSIVE`、認証の設定が `CURRENT`）。公開の監査のプロファイルは拒む。`START` は
//   `DISCOVERY` の種類と、認証の指定（種類を含む SHA-256）を持つ。
// - ジョブの終わり: 親が `discovery.json` を読み、スキーマ・ジョブの ID・Run の ID・件数の要約で確かめ、同じ識別の digest の候補をまとめて
//   （`DUPLICATE_IDENTITY_CONFLICT`）、索引を 1 つのトランザクションで更新してから、ジョブを `FINISHED` にする。読めない・合わないときは
//   `FAILED`（`DISCOVERY_RESULT_INVALID`）で、索引を変えない。
// - ドリフト: 読んだ画面にあって今回ない候補は `MISSING`、読まなかった画面の候補は `NOT_REVISITED`。候補が 0 件のジョブも、最後のジョブになる。
// - `FINISHED` の件数の要約は、発見のジョブの Run を実行した結果だけ（ほかは契約の違反）。ワーカーが途中で落ちたら中断（索引を変えない）。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import type { AuditJobManager, AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { readDiscoveryIndex } from '../../src/control/job/discovery-index-store.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { workerAuthenticationDigestOf } from '../../src/control/worker-protocol.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  discoverySummaryOf,
  withServiceReadRefused,
  type DiscoveryDocument,
  type DiscoveryPageEntry,
} from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import { writeFakeWorker, type FakeWorker, type FakeWorkerMode } from '../helpers/fake-audit-worker.js';
import { blockingAfterStartFork, createCountingFork } from '../helpers/worker-fork.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
  withOutputDirectory,
  type JobViewSource,
} from '../helpers/job-test-support.js';
import { sampleAction, sampleButton, sampleField, sampleForm } from '../unit/discovery-candidate-samples.js';
import {
  PUBLIC_TARGET_PATH,
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  testAuthProfile,
  testWriteProfile,
} from './control-profile-fixtures.js';

const FAKE_RUN_ID = 'RUN-20261011000000';
const OTHER_RUN_ID = 'RUN-20261011000999';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const PROFILE_ID = 'example-discovery-job';
const PUBLIC_PROFILE_ID = 'example-public-discovery';
const WRITE_PROFILE_ID = 'example-write-discovery';
const TEST_TIMEOUT_MS = 60_000;
/** テストの文脈の出力先（`createTestConfig` の既定。リポジトリの root の代わりの一時のフォルダの下）。 */
const OUTPUT_DIRECTORY_NAME = resolveTestContext(TEST_TARGET_PATH)?.targetConfig.output.directory ?? '';

const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${TEST_ORIGIN}/admin/login`,
  loginPostEndpoints: [{ origin: TEST_ORIGIN, path: '/admin/login' }],
  successCondition: { pathPrefix: '/admin/dashboard', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin/'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

const ALLOWED: ReadonlySet<string> = new Set([TEST_ORIGIN]);
const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: ALLOWED }),
  ...computeCandidateDigests(discovered),
});
const location = (path: string) => ({ origin: TEST_ORIGIN, path });
const SEARCH = candidateOf(sampleForm({
  page: location('/admin/items'), formMethod: 'GET', action: sampleAction('/admin/items', [], TEST_ORIGIN), submitterText: '検索',
  fields: [sampleField('q', 'search')],
}));
const SEARCH_REQUIRED = candidateOf(sampleForm({
  page: location('/admin/items'), formMethod: 'GET', action: sampleAction('/admin/items', [], TEST_ORIGIN), submitterText: '検索',
  fields: [sampleField('q', 'search', { required: true })],
}));
const CREATE = candidateOf(sampleForm({
  page: location('/admin/items/new'), action: sampleAction('/admin/items', [], TEST_ORIGIN), submitterText: '登録',
  fields: [sampleField('name')],
}));
const BUTTON = candidateOf(sampleButton({ page: location('/admin') }));
const OTHER_BUTTON = candidateOf(sampleButton({ page: location('/admin/other') }));

const readEntry = (path: string, candidates: readonly DiscoveryCandidate[]): DiscoveryPageEntry =>
  ({ url: `${TEST_ORIGIN}${path}`, state: 'READ', record: { location: location(path), incompleteReasons: [], candidates }, blockedRequests: 0 });

const documentFor = (jobId: string, pages: readonly DiscoveryPageEntry[], overrides: Partial<DiscoveryDocument> = {}): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId,
  runId: FAKE_RUN_ID,
  startedAt: '20261011000000',
  finishedAt: '20261011000100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages,
  omittedUnreadPages: 0,
  ...overrides,
});

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;

const countingFork: AuditWorkerForker = forks.fork;

/** 偽のワーカー（`discovery` の動き）。`document` は、ジョブの ID を受けてから作る（ジョブの ID は開始の結果で決まる）。 */
const fakeWorker = (
  mode: FakeWorkerMode,
  discovery: { readonly documentText: string | null; readonly summary: Readonly<Record<string, unknown>> | null; readonly runStatus?: string },
  name = 'discovery',
): FakeWorker => {
  const directory = join(workDirectory, name);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, mode, fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, {
    discovery: {
      outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY_NAME, name),
      documentText: discovery.documentText,
      summary: discovery.summary,
      runStatus: discovery.runStatus ?? 'COMPLETE',
    },
  }));
};

/** 置き換えの印（偽のワーカーが、`START` のジョブの ID に置き換える）。 */
const JOB_ID_PLACEHOLDER = '__JOB_ID__';

/** 1 回の発見のジョブを、偽のワーカーで行う。出力先は、ジョブごとに別のフォルダ（同じ Run の ID を使うため）。 */
async function runDiscoveryJob(
  name: string,
  documentOf: (jobId: string) => { readonly text: string | null; readonly summary: Readonly<Record<string, unknown>> | null; readonly runStatus?: string },
  mode: FakeWorkerMode = 'discovery',
  forkWorker: AuditWorkerForker = countingFork,
  profileId = PROFILE_ID,
): Promise<AuditJobView & { readonly received: readonly Record<string, unknown>[] }> {
  const discovery = documentOf(JOB_ID_PLACEHOLDER);
  const worker = fakeWorker(mode, { documentText: discovery.text, summary: discovery.summary, ...(discovery.runStatus === undefined ? {} : { runStatus: discovery.runStatus }) }, name);
  await manager?.close();
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, join(OUTPUT_DIRECTORY_NAME, name)),
    forkWorker,
  });
  const started = await manager.startDiscovery({ profileId, expectedRevision: MIN_PROFILE_REVISION });
  if (!started.ok) {
    throw new Error(`the discovery job did not start: ${started.reason}`);
  }
  expect(started.job).toMatchObject({ jobKind: 'DISCOVERY', state: 'STARTING' });
  const ended = await waitForJob(currentManager, started.job.jobId, isJobEnded);
  return { ...ended, received: worker.received() };
}

/** 今のジョブの管理から、ジョブの見え方を読む（ない間は null）。 */
const currentManager: JobViewSource = { getAuditJob: (jobId) => manager?.getAuditJob(jobId) ?? null };

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

const okDocument = (pages: readonly DiscoveryPageEntry[], overrides: Partial<DiscoveryDocument> = {}) => (jobId: string) => {
  const document = documentFor(jobId, pages, overrides);
  return { text: JSON.stringify(document), summary: { ...discoverySummaryOf(document) }, runStatus: document.runStatus };
};

const driftsOf = (): Readonly<Record<string, string>> =>
  Object.fromEntries(readDiscoveryIndex(database, PROFILE_ID).candidates.map(({ identityDigest, drift }) => [identityDigest, drift]));

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-discovery-jobs-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  expect(createProfile(database, testAuthProfile(PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  expect(saveAuthSetup(database, SETUP, { resolveContext: resolveTestContext }).ok).toBe(true);
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('discovery jobs (T27d): the start', () => {
  it('starts a DISCOVERY job with the checks of the audit, and sends START with the kind and the authentication', async () => {
    const ended = await runDiscoveryJob('start', okDocument([readEntry('/admin', [BUTTON])]));
    expect(ended).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED', resultRunStatus: 'COMPLETE', endKind: 'RAN', failureReason: null });
    expect(forks.count()).toBe(1);
  });

  it('rejects a public profile, a missing request shape and an unknown profile without starting a worker', async () => {
    expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    const worker = fakeWorker('discovery', { documentText: null, summary: null });
    manager = createFakeWorkerJobManager({ database, workDirectory, worker, resolveContext: resolveTestContext, forkWorker: countingFork });
    expect(await manager.startDiscovery({ profileId: PUBLIC_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION })).toMatchObject({ ok: false, reason: 'MODE_NOT_EXECUTABLE' });
    expect(await manager.startDiscovery({ profileId: 'missing-profile', expectedRevision: MIN_PROFILE_REVISION })).toMatchObject({ ok: false, reason: 'PROFILE_NOT_FOUND' });
    expect(await manager.startDiscovery({ profileId: PROFILE_ID } as never)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    expect(forks.count()).toBe(0);
    expect(manager.listAuditJobs()).toEqual([]);
  });

  it('sends a START of the kind DISCOVERY with the authentication bound to the kind', async () => {
    const { received } = await runDiscoveryJob('start-message', okDocument([readEntry('/admin', [BUTTON])]));
    const start = received.find((message) => message['type'] === 'START');
    expect(start).toMatchObject({ jobKind: 'DISCOVERY', authentication: { approvedTestOrigins: [TEST_ORIGIN] } });
    const authentication = start?.['authentication'] as { readonly setup: AuthSetup; readonly authenticationSha256: string };
    expect(authentication.authenticationSha256)
      .toBe(workerAuthenticationDigestOf(authentication.setup, [TEST_ORIGIN], { jobKind: 'DISCOVERY', automatedLogin: null }));
  });

  // T28b（Task 28 の設計書 2 章のユーザーの判断 1、4.5）: 書き込みのモード（`TEST_APPROVED_WRITE`）のプロファイルでも、認証の設定を保存して、発見の
  // ジョブを始められる（確かめは認証つきの読み取りの監査と同じ）。認証つきの監査（`AUDIT`）は、今までどおり `MODE_NOT_EXECUTABLE` で、ワーカーを
  // 起動しない。
  it('saves the auth setup of a write mode profile, starts its DISCOVERY job, and still rejects its AUDIT (T28b)', async () => {
    expect(createProfile(database, testWriteProfile(WRITE_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
    expect(saveAuthSetup(database, { ...SETUP, profileId: WRITE_PROFILE_ID }, { resolveContext: resolveTestContext })).toMatchObject({ ok: true });
    const ended = await runDiscoveryJob('write-mode', okDocument([readEntry('/admin', [BUTTON])]), 'discovery', countingFork, WRITE_PROFILE_ID);
    expect(ended).toMatchObject({ profileId: WRITE_PROFILE_ID, jobKind: 'DISCOVERY', state: 'FINISHED', resultRunStatus: 'COMPLETE', failureReason: null });
    expect(ended.received.find((message) => message['type'] === 'START'))
      .toMatchObject({ jobKind: 'DISCOVERY', authentication: { approvedTestOrigins: [TEST_ORIGIN] } });
    expect(readDiscoveryIndex(database, WRITE_PROFILE_ID).candidates.map(({ identityDigest }) => identityDigest)).toEqual([BUTTON.identityDigest]);
    expect(forks.count()).toBe(1);
    expect(await manager?.startAuditJob({ profileId: WRITE_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true }))
      .toEqual({ ok: false, reason: 'MODE_NOT_EXECUTABLE', errors: [] });
    expect(await manager?.startLoginCheck({ profileId: WRITE_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION }))
      .toEqual({ ok: false, reason: 'AUTH_STRATEGY_NOT_EXECUTABLE', errors: [] });
    expect(forks.count()).toBe(1);
    expect(manager?.listAuditJobs().map(({ jobKind }) => jobKind)).toEqual(['DISCOVERY']);
  }, TEST_TIMEOUT_MS);
});


describe('discovery jobs (T27d): recording discovery.json into the index at the end of the job', () => {
  it('records the candidates (merging a duplicate identity into DUPLICATE_IDENTITY_CONFLICT) and then finishes the job', async () => {
    const ended = await runDiscoveryJob('first', okDocument([
      readEntry('/admin', [BUTTON]),
      readEntry('/admin/items', [SEARCH, SEARCH_REQUIRED]),
      readEntry('/admin/items/new', [CREATE]),
    ]));
    expect(ended).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE', failureReason: null });
    const index = readDiscoveryIndex(database, PROFILE_ID);
    expect(index.latestJobId).toBe(ended.jobId);
    expect(index.latestReadPagePaths).toEqual(['/admin', '/admin/items', '/admin/items/new']);
    expect(Object.fromEntries(index.candidates.map(({ identityDigest, classification, reasonCode, drift }) => [identityDigest, [classification, reasonCode, drift]])))
      .toEqual({
        [BUTTON.identityDigest]: ['DISPLAY_ONLY', 'NO_KNOWN_ACTION', 'NEW'],
        [SEARCH.identityDigest]: ['DISPLAY_ONLY', 'DUPLICATE_IDENTITY_CONFLICT', 'NEW'],
        [CREATE.identityDigest]: ['CREATE', 'CREATE_WORD', 'NEW'],
      });
  });

  it('tells UNCHANGED, CHANGED, MISSING (pages read again) and NOT_REVISITED (pages not read) in the next job', async () => {
    await runDiscoveryJob('base', okDocument([
      readEntry('/admin', [BUTTON]),
      readEntry('/admin/items', [SEARCH]),
      readEntry('/admin/items/new', [CREATE]),
      readEntry('/admin/other', [OTHER_BUTTON]),
    ]));
    const second = await runDiscoveryJob('changed', okDocument([
      readEntry('/admin', []),
      readEntry('/admin/items', [SEARCH_REQUIRED]),
      readEntry('/admin/items/new', [CREATE]),
    ], { runStatus: 'PARTIAL', endReason: 'MAX_PAGES_REACHED' }));
    expect(second).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL' });
    expect(driftsOf()).toEqual({
      [BUTTON.identityDigest]: 'MISSING',
      [SEARCH.identityDigest]: 'CHANGED',
      [CREATE.identityDigest]: 'UNCHANGED',
      [OTHER_BUTTON.identityDigest]: 'NOT_REVISITED',
    });
  });

  it('records a job without candidates as the latest job', async () => {
    await runDiscoveryJob('with', okDocument([readEntry('/admin', [BUTTON])]));
    const empty = await runDiscoveryJob('without', okDocument([readEntry('/admin', [])]));
    expect(readDiscoveryIndex(database, PROFILE_ID)).toMatchObject({ latestJobId: empty.jobId, latestReadPagePaths: ['/admin'] });
    expect(driftsOf()).toEqual({ [BUTTON.identityDigest]: 'MISSING' });
  });

  it('fails the job with DISCOVERY_RESULT_INVALID and keeps the index when discovery.json is missing, broken or does not match', async () => {
    const valid = okDocument([readEntry('/admin', [BUTTON])]);
    for (const [name, documentOf] of [
      ['missing', (jobId: string) => ({ ...valid(jobId), text: null })],
      ['not-json', (jobId: string) => ({ ...valid(jobId), text: '{"schemaVersion":' })],
      ['schema', (jobId: string) => ({ ...valid(jobId), text: JSON.stringify({ ...documentFor(jobId, []), cookies: [] }) })],
      ['other-job', (jobId: string) => ({ ...valid(jobId), text: JSON.stringify(documentFor(`${jobId}-other`, [readEntry('/admin', [BUTTON])])) })],
      ['other-run', (jobId: string) => ({ ...valid(jobId), text: JSON.stringify(documentFor(jobId, [readEntry('/admin', [BUTTON])], { runId: OTHER_RUN_ID })) })],
      ['other-summary', (jobId: string) => ({ ...valid(jobId), summary: { pagesRead: 2, pagesNotRead: 0, candidates: 1 } })],
    ] as const) {
      const ended = await runDiscoveryJob(name, documentOf);
      expect(ended, name).toMatchObject({ state: 'FAILED', failureReason: 'DISCOVERY_RESULT_INVALID' });
    }
    expect(readDiscoveryIndex(database, PROFILE_ID)).toEqual({ latestJobId: null, latestSeenAt: null, latestReadPagePaths: [], candidates: [] });
  });

  // DEF-084（DEF-080）: 子が最後のメッセージを送ってから終わると、混雑の下で、親の `exit` が最後の `message`（`FINISHED`）より先に来ることが
  // ある。`START` の直後に親をふさいで、その形を決まって作る。`FINISHED` を受けてから `discovery.json` を確かめる（件数の要約が合わなければ
  // `DISCOVERY_RESULT_INVALID`。`WORKER_EXITED` にしない）。
  it('checks discovery.json with the counts of FINISHED even when the exit of the worker arrives before its last messages (DEF-084)', async () => {
    const valid = okDocument([readEntry('/admin', [BUTTON])]);
    const otherSummary = await runDiscoveryJob(
      'blocked-other-summary',
      (jobId) => ({ ...valid(jobId), summary: { pagesRead: 2, pagesNotRead: 0, candidates: 1 } }),
      'discovery',
      blockingAfterStartFork(countingFork),
    );
    expect(otherSummary).toMatchObject({ state: 'FAILED', failureReason: 'DISCOVERY_RESULT_INVALID' });
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });

  it('finishes a FAILED discovery Run without changing the index', async () => {
    const ended = await runDiscoveryJob('failed-run', okDocument([], { runStatus: 'FAILED', endReason: 'PREFLIGHT_FAILED' }));
    expect(ended).toMatchObject({ state: 'FINISHED', resultRunStatus: 'FAILED' });
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });

  it('treats FINISHED without the counts of a discovery Run as a protocol violation', async () => {
    const ended = await runDiscoveryJob('no-summary', (jobId) => ({ ...okDocument([readEntry('/admin', [BUTTON])])(jobId), summary: null }));
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });

  it('interrupts the job and keeps the index when the worker exits during the crawl (the discovery job does not resume)', async () => {
    const ended = await runDiscoveryJob('crash', okDocument([readEntry('/admin', [BUTTON])]), 'discovery-crash');
    expect(ended).toMatchObject({ state: 'INTERRUPTED', failureReason: 'WORKER_EXITED' });
    expect(readDiscoveryIndex(database, PROFILE_ID).latestJobId).toBeNull();
  });
});

// T37a（Task 37 の設計書 3.1）: 監査の段の口のある発見のジョブ。成果物の監査の段の数（`authentication`）は、IPC の要約と照らし合わせる（合わなければ
// `DISCOVERY_RESULT_INVALID`）。サービスの読み取りが届かなかった画面（`SERVICE_READ_REFUSED`）は、読み切れた画面の path に入らないので、その画面の前の
// 候補は `MISSING` にならず `NOT_REVISITED` になる。
describe('discovery jobs (T37a): the counts of the audit stage and the pages with a refused service read', () => {
  const AUTHENTICATION = Object.freeze({
    registeredReadRequestsAllowed: 2,
    tokenRefreshBlocked: 0,
    otherNonReadBlocked: 1,
    serviceUnauthorizedResponses: 0,
    serviceRequestLimitReached: true,
  });

  it('finishes when the counts of FINISHED match discovery.json, and fails with DISCOVERY_RESULT_INVALID when they do not', async () => {
    const pages = [readEntry('/admin', [BUTTON])];
    const matched = await runDiscoveryJob('authentication', okDocument(pages, { authentication: AUTHENTICATION }));
    expect(matched).toMatchObject({ state: 'FINISHED', failureReason: null });
    for (const [name, documentOf] of [
      ['other-counts', (jobId: string) => ({
        ...okDocument(pages, { authentication: AUTHENTICATION })(jobId),
        summary: { pagesRead: 1, pagesNotRead: 0, candidates: 1, authentication: { ...AUTHENTICATION, serviceRequestLimitReached: false } },
      })],
      ['missing-counts', (jobId: string) => ({ ...okDocument(pages, { authentication: AUTHENTICATION })(jobId), summary: { pagesRead: 1, pagesNotRead: 0, candidates: 1 } })],
      ['extra-counts', (jobId: string) => ({ ...okDocument(pages)(jobId), summary: { pagesRead: 1, pagesNotRead: 0, candidates: 1, authentication: AUTHENTICATION } })],
    ] as const) {
      const ended = await runDiscoveryJob(name, documentOf);
      expect(ended, name).toMatchObject({ state: 'FAILED', failureReason: 'DISCOVERY_RESULT_INVALID' });
    }
  });

  it('keeps the candidates of a page with a refused service read as NOT_REVISITED, not MISSING', async () => {
    await runDiscoveryJob('refused-base', okDocument([readEntry('/admin', [BUTTON]), readEntry('/admin/other', [OTHER_BUTTON])]));
    const refused: DiscoveryPageEntry = {
      url: `${TEST_ORIGIN}/admin`,
      state: 'READ',
      record: withServiceReadRefused({ location: location('/admin'), incompleteReasons: [], candidates: [] }),
      blockedRequests: 0,
    };
    const second = await runDiscoveryJob('refused', okDocument([refused, readEntry('/admin/other', [])], {
      runStatus: 'PARTIAL', endReason: 'SERVICE_REQUEST_LIMIT_REACHED', authentication: AUTHENTICATION,
    }));
    expect(second).toMatchObject({ state: 'FINISHED', resultRunStatus: 'PARTIAL', failureReason: null });
    expect(readDiscoveryIndex(database, PROFILE_ID).latestReadPagePaths).toEqual(['/admin/other']);
    expect(driftsOf()).toEqual({ [BUTTON.identityDigest]: 'NOT_REVISITED', [OTHER_BUTTON.identityDigest]: 'MISSING' });
  });
});
