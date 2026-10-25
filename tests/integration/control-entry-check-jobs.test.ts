// T43c（Task 43 の設計書 4.3）: 入口の確かめのジョブ（`ENTRY_CHECK`）の、ジョブの管理（`createAuditJobManager` の `startEntryCheck` と、ジョブの終わりの
// 照らし合わせ）を、偽のワーカー（`tests/helpers/fake-audit-worker.ts` の `entry-check` の動き）を本物の `fork` で起動して確かめる（本物のワーカーと
// Chromium での流れは `entry-check-run.test.ts`、子 process の端から端は `entry-check-job-fork.test.ts`）。
// - 開始の確かめは監査と同じ（プロファイル、改訂、モード、ターゲット設定、同時に 1 つ）。公開のプロファイルでも、認証の設定のないテストのプロファイル
//   でも始められる（ログインはしない）。`START` は `ENTRY_CHECK` の種類で、認証の指定を持たない。
// - ジョブの終わり: 親が `entry-check.json` を読み、スキーマ・ジョブの ID・Run の ID・Run Status・件数の要約で確かめてから、ジョブを `FINISHED` にする。
//   読めない・合わないときは `FAILED`（`ENTRY_CHECK_RESULT_INVALID`）。件数の要約のない `FINISHED` は契約の違反。管理データに結果の表はない。
// 管理データと出力先は一時のフォルダだけを使う。起動したワーカーは、すべて止まったことを確かめる。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import {
  ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
  entryCheckSummaryOf,
  type EntryCheckDocument,
} from '../../src/control/entry-check.js';
import type { AuditJobManager, AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { writeFakeWorker, type FakeWorker } from '../helpers/fake-audit-worker.js';
import {
  awaitWorkersExit,
  createFakeWorkerJobManager,
  fakeWorkerValuesOf,
  isJobEnded,
  waitForJob,
  withOutputDirectory,
  type JobViewSource,
} from '../helpers/job-test-support.js';
import { createCountingFork } from '../helpers/worker-fork.js';
import {
  PUBLIC_TARGET_PATH,
  TEST_ORIGIN,
  TEST_TARGET_PATH,
  publicProfile,
  resolveTestContext,
  testAuthProfile,
} from './control-profile-fixtures.js';

const FAKE_RUN_ID = 'RUN-20261017000000';
const OTHER_RUN_ID = 'RUN-20261017000999';
const TARGET_CONFIG_TEXT = JSON.stringify({ target: { id: 'example-test' } });
const PUBLIC_PROFILE_ID = 'example-public-entry';
const TEST_PROFILE_ID = 'example-test-entry';
/** テストの文脈の出力先（`createTestConfig` の既定。リポジトリの root の代わりの一時のフォルダの下）。 */
const OUTPUT_DIRECTORY_NAME = resolveTestContext(TEST_TARGET_PATH)?.targetConfig.output.directory ?? '';
/** 置き換えの印（偽のワーカーが、`START` のジョブの ID に置き換える）。 */
const JOB_ID_PLACEHOLDER = '__JOB_ID__';

const documentFor = (jobId: string, overrides: Partial<EntryCheckDocument> = {}): EntryCheckDocument => ({
  schemaVersion: ENTRY_CHECK_ARTIFACT_SCHEMA_VERSION,
  jobId,
  runId: FAKE_RUN_ID,
  startedAt: '20261017000000',
  finishedAt: '20261017000001',
  runStatus: 'COMPLETE',
  endReason: 'READ',
  landing: { origin: TEST_ORIGIN, path: '/login', inAllowedOrigins: true },
  facts: {
    loginPage: true,
    fields: {
      username: { candidates: 1, selector: '#user' },
      password: { candidates: 1, selector: '#pass' },
      submit: { candidates: 1, selector: '#go' },
    },
    form: { placement: 'NONE', action: null, method: null },
  },
  proposal: {
    loginStartUrl: `${TEST_ORIGIN}/login`,
    sessionLostPathPrefix: '/login',
    loginTransport: 'SCRIPT_REQUEST',
    loginPostEndpoint: null,
    selectors: { username: '#user', password: '#pass', submit: '#go' },
  },
  blockedRequests: 0,
  ...overrides,
});

let workDirectory = '';
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const forks = createCountingFork();
const children = forks.children;
const countingFork: AuditWorkerForker = forks.fork;

interface EntryCheckFake {
  readonly documentText: string | null;
  readonly summary: Readonly<Record<string, unknown>> | null;
  readonly runStatus: string;
}

const fakeWorker = (name: string, values: EntryCheckFake): FakeWorker => {
  const directory = join(workDirectory, name);
  mkdirSync(directory, { recursive: true });
  return writeFakeWorker(directory, 'entry-check', fakeWorkerValuesOf({ runId: FAKE_RUN_ID, otherRunId: OTHER_RUN_ID }, {
    entryCheck: { outputDirectory: resolve(workDirectory, OUTPUT_DIRECTORY_NAME, name), ...values },
  }));
};

/** 今のジョブの管理から、ジョブの見え方を読む（ない間は null）。 */
const currentManager: JobViewSource = { getAuditJob: (jobId) => manager?.getAuditJob(jobId) ?? null };

/** 1 回の入口の確かめのジョブを、偽のワーカーで行う。出力先は、ジョブごとに別のフォルダ（同じ Run の ID を使うため）。 */
async function runEntryCheckJob(
  name: string,
  values: EntryCheckFake,
  profileId = TEST_PROFILE_ID,
): Promise<AuditJobView & { readonly received: readonly Record<string, unknown>[] }> {
  const worker = fakeWorker(name, values);
  await manager?.close();
  manager = createFakeWorkerJobManager({
    database,
    workDirectory,
    worker,
    resolveContext: withOutputDirectory(resolveTestContext, join(OUTPUT_DIRECTORY_NAME, name)),
    forkWorker: countingFork,
  });
  const started = await manager.startEntryCheck({ profileId, expectedRevision: MIN_PROFILE_REVISION });
  if (!started.ok) {
    throw new Error(`the entry check job did not start: ${started.reason}`);
  }
  expect(started.job).toMatchObject({ jobKind: 'ENTRY_CHECK', state: 'STARTING' });
  const ended = await waitForJob(currentManager, started.job.jobId, isJobEnded);
  return { ...ended, received: worker.received() };
}

/** 確かめに通る成果物と、同じ件数の要約。 */
const ok = (overrides: Partial<EntryCheckDocument> = {}): EntryCheckFake => {
  const document = documentFor(JOB_ID_PLACEHOLDER, overrides);
  return { documentText: JSON.stringify(document), summary: { ...entryCheckSummaryOf(document) }, runStatus: document.runStatus };
};

const writeTarget = (path: string): void => {
  mkdirSync(dirname(join(workDirectory, path)), { recursive: true });
  writeFileSync(join(workDirectory, path), TARGET_CONFIG_TEXT, 'utf8');
};

beforeEach(() => {
  workDirectory = mkdtempSync(join(tmpdir(), 'beaksight-control-entry-check-jobs-'));
  writeTarget(PUBLIC_TARGET_PATH);
  writeTarget(TEST_TARGET_PATH);
  database = openControlDatabase(resolveControlDatabasePath(workDirectory));
  forks.reset();
  expect(createProfile(database, publicProfile(PUBLIC_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
  // 認証の設定は保存しない（入口の確かめは、認証の設定がなくても始められる）。
  expect(createProfile(database, testAuthProfile(TEST_PROFILE_ID, MIN_PROFILE_REVISION), { resolveContext: resolveTestContext }).ok).toBe(true);
});

afterEach(async () => {
  await manager?.close();
  manager = undefined;
  await awaitWorkersExit(children);
  closeControlDatabase(database);
  rmSync(workDirectory, { recursive: true, force: true });
});

describe('entry check jobs (T43c): the start', () => {
  it.each([
    ['a public profile', PUBLIC_PROFILE_ID],
    ['a test profile without an auth setup', TEST_PROFILE_ID],
  ])('starts an ENTRY_CHECK job for %s, with a START of the kind and without an authentication', async (_name, profileId) => {
    const ended = await runEntryCheckJob(`start-${profileId}`, ok(), profileId);
    expect(ended).toMatchObject({ jobKind: 'ENTRY_CHECK', state: 'FINISHED', resultRunStatus: 'COMPLETE', endKind: 'RAN', failureReason: null });
    const start = ended.received.find((message) => message['type'] === 'START');
    expect(start).toMatchObject({ jobKind: 'ENTRY_CHECK', startNew: true });
    expect(start?.['authentication']).toBeUndefined();
    expect(forks.count()).toBe(1);
  });

  it('rejects a missing request shape and an unknown profile without starting a worker', async () => {
    const worker = fakeWorker('reject', ok());
    manager = createFakeWorkerJobManager({ database, workDirectory, worker, resolveContext: resolveTestContext, forkWorker: countingFork });
    expect(await manager.startEntryCheck({ profileId: 'missing-profile', expectedRevision: MIN_PROFILE_REVISION }))
      .toMatchObject({ ok: false, reason: 'PROFILE_NOT_FOUND' });
    expect(await manager.startEntryCheck({ profileId: TEST_PROFILE_ID } as never)).toMatchObject({ ok: false, reason: 'INVALID_REQUEST' });
    expect(await manager.startEntryCheck({ profileId: TEST_PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION + 1 }))
      .toMatchObject({ ok: false, reason: 'PROFILE_REVISION_CONFLICT' });
    expect(forks.count()).toBe(0);
    expect(manager.listAuditJobs()).toEqual([]);
  });
});

describe('entry check jobs (T43c): checking entry-check.json at the end of the job', () => {
  it('finishes the job when the document matches the summary (a page that left the allowed origins too)', async () => {
    const left = ok({
      endReason: 'LEFT_ALLOWED_ORIGINS',
      landing: { origin: 'http://localhost:4173', path: null, inAllowedOrigins: false },
      facts: null,
      proposal: null,
    });
    const ended = await runEntryCheckJob('left', left);
    expect(ended).toMatchObject({ state: 'FINISHED', resultRunStatus: 'COMPLETE', failureReason: null });
  });

  it.each([
    ['a missing document', { ...ok(), documentText: null }],
    ['a broken document', { ...ok(), documentText: '{"schemaVersion":' }],
    ['a document of another job', { ...ok(), documentText: JSON.stringify(documentFor('job-other')) }],
    ['a summary that differs from the document', { ...ok(), summary: { endReason: 'READ', loginPage: true, proposedSelectors: 2 } }],
    ['a document that does not pass the schema (a value of a field)', {
      ...ok(),
      documentText: JSON.stringify({ ...documentFor(JOB_ID_PLACEHOLDER), facts: { ...documentFor(JOB_ID_PLACEHOLDER).facts, value: 'x' } }),
    }],
  ])('fails the job with ENTRY_CHECK_RESULT_INVALID for %s', async (name, values) => {
    const ended = await runEntryCheckJob(`invalid-${name.split(' ').join('-')}`, values);
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'ENTRY_CHECK_RESULT_INVALID' });
  });

  it('distrusts a FINISHED of a Run that ran without the summary', async () => {
    const ended = await runEntryCheckJob('no-summary', { ...ok(), summary: null });
    expect(ended).toMatchObject({ state: 'FAILED', failureReason: 'PROTOCOL_VIOLATION' });
  });
});
