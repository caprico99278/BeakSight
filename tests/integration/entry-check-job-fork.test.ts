// T43c（Task 43 の設計書 4.3、5 章の 3）: 入口の確かめのジョブ（`ENTRY_CHECK`）を、ジョブの管理（`createAuditJobManager` の `startEntryCheck`）から、
// 本物の子 process（`child_process.fork`。一時のビルドの本番のワーカーの入口）と本物の Chromium（本番の依存。CLI の起動の設定の headless）で、
// 端から端まで確かめる結合テスト。
// - 公開のプロファイルで、値の目印を入れたログインの画面を 1 回読み、`entry-check.json` に案（フォームの送信、3 つのセレクタ）が入り、ジョブは
//   `FINISHED`。サーバへの要求は GET（と HEAD）だけで、開始の URL の文書の要求は 1 回。
// - 欄の値の目印が、成果物、管理データのファイルと WAL と表、親が受けた IPC のメッセージ、ワーカーの標準出力と標準エラー、ジョブの値に出ない。
// 作業のディレクトリ（リポジトリの root の代わり）、管理データ、出力先は、一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import type { EntryCheckDocument } from '../../src/control/entry-check.js';
import { createAuditJobManager, type AuditJobManager, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { ENTRY_CHECK_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait } from '../../src/core/deadline.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { ENTRY_CHECK_SITE_PATHS, ENTRY_CHECK_VALUE_MARKERS, startEntryCheckSite, type EntryCheckSite } from '../helpers/entry-check-site.js';
import { isJobEnded, waitForJob } from '../helpers/job-test-support.js';
import { databaseFilePlaces, databaseTablesText, filesUnder, nonReadRequestsOf, placesWithMarkers, textLeakPlace } from '../helpers/leak-places.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { createRecordingFork } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 600_000;
const PROFILE_ID = 'example-entry-fork';
const TARGET_CONFIG_PATH = 'local/targets/entry-fork.json';
const OUTPUT_DIRECTORY_NAME = 'entry-fork-output';
/** 全部の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
const LATE_REQUEST_WAIT_MS = 1_500;

let build: TemporaryBuild;
let site: EntryCheckSite;
let directory: string;
let database: ControlDatabase;
let manager: AuditJobManager | undefined;
const children: ChildProcess[] = [];
const received: unknown[] = [];
let workerOutput = '';

beforeAll(async () => {
  build = await buildIntoTemporaryDirectory();
  site = await startEntryCheckSite();
  directory = await mkdtemp(join(tmpdir(), 'beaksight-entry-fork-'));
  database = openControlDatabase(resolveControlDatabasePath(directory));
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  await manager?.close();
  await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())))));
  closeControlDatabase(database);
  await site?.close();
  await rm(directory, { recursive: true, force: true });
  await build?.remove();
}, SUITE_TIMEOUT_MS);

describe('T43c: the entry check job end to end (the production worker in a child process)', () => {
  it('reads the login page once, proposes the form login, and leaks no value of a field anywhere', async () => {
    await mkdir(join(directory, 'local', 'targets'), { recursive: true });
    await writeFile(join(directory, TARGET_CONFIG_PATH), JSON.stringify(cliTargetConfig('entry-fork', site.originA, ENTRY_CHECK_SITE_PATHS.prefilled, {
      audit: { screenshots: false },
      output: { directory: join(directory, OUTPUT_DIRECTORY_NAME) },
    })), 'utf8');
    const context: ProfileValidationContext = { targetConfig: await loadConfig(join(directory, TARGET_CONFIG_PATH)) };
    const resolveContext = (path: string): ProfileValidationContext | undefined => (path === TARGET_CONFIG_PATH ? context : undefined);
    expect(createProfile(database, {
      schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
      profileId: PROFILE_ID,
      revision: MIN_PROFILE_REVISION,
      targetConfigPath: TARGET_CONFIG_PATH,
      environment: 'PUBLIC',
      mode: 'PUBLIC_PASSIVE',
      auth: 'NONE',
      approvedTestOrigins: [],
      environmentEvidenceRef: null,
    }, { resolveContext }).ok).toBe(true);
    const recordingFork: AuditWorkerForker = createRecordingFork({
      stdinText: () => '',
      onChild: (child) => children.push(child),
      onReceived: (message) => received.push(message),
      onOutput: (chunk) => { workerOutput += chunk; },
    });
    manager = createAuditJobManager({
      database,
      repositoryRoot: directory,
      workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
      resolveContext: async (path) => resolveContext(path),
      forkWorker: recordingFork,
    });
    const started = await manager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION });
    if (!started.ok) {
      throw new Error(`the entry check job did not start: ${started.reason}`);
    }
    const ended = await waitForJob(manager, started.job.jobId, isJobEnded);
    expect(ended, workerOutput).toMatchObject({ jobKind: 'ENTRY_CHECK', state: 'FINISHED', resultRunStatus: 'COMPLETE', failureReason: null });
    if (ended.runDirectory === null) {
      throw new Error('no run directory');
    }
    const document = JSON.parse(readFileSync(artifactFilePath(join(directory, OUTPUT_DIRECTORY_NAME), `${ended.runDirectory}/${ENTRY_CHECK_ARTIFACT_FILE_NAME}`), 'utf8')) as
      EntryCheckDocument;
    expect(await validateArtifact('entry-check', document)).toEqual({ ok: true });
    expect(document.proposal).toEqual({
      loginStartUrl: `${site.originA}${ENTRY_CHECK_SITE_PATHS.prefilled}`,
      sessionLostPathPrefix: ENTRY_CHECK_SITE_PATHS.prefilled,
      loginTransport: 'FORM_NAVIGATION',
      loginPostEndpoint: { origin: site.originA, path: ENTRY_CHECK_SITE_PATHS.session },
      selectors: { username: '#login-id', password: '#login-password', submit: '#login-submit' },
    });
    const finished = received.find((message) => (message as { type?: unknown }).type === 'FINISHED');
    expect(finished).toMatchObject({ entryCheck: { endReason: 'READ', loginPage: true, proposedSelectors: 3 } });

    // 全部の後に、名前つきの時間だけ待ってから、サーバの記録を数える。
    await wait(LATE_REQUEST_WAIT_MS);
    expect(nonReadRequestsOf(site.requests)).toEqual([]);
    expect(site.requests.filter(({ site: origin }) => origin === 'B')).toEqual([]);
    expect(site.requests.filter(({ path }) => new URL(path, site.originA).pathname === ENTRY_CHECK_SITE_PATHS.prefilled)).toHaveLength(1);

    const databasePath = resolveControlDatabasePath(directory);
    const places = [
      ...databaseFilePlaces(databasePath),
      textLeakPlace('tables', databaseTablesText(databasePath, ['jobs'])),
      textLeakPlace('ipc received', JSON.stringify(received)),
      textLeakPlace('worker output', workerOutput),
      textLeakPlace('job views', JSON.stringify(manager.listAuditJobs())),
      ...filesUnder(join(directory, OUTPUT_DIRECTORY_NAME)),
    ];
    expect(placesWithMarkers(places, Object.values(ENTRY_CHECK_VALUE_MARKERS))).toEqual([]);
  }, SUITE_TIMEOUT_MS);
});
