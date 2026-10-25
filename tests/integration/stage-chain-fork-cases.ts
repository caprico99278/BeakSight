// FM2d（設計書 `2026-10-19-beaksight-fewer-manual-steps-design.md` 3A.1、5 章の 2026-10-22 の FM2d の Blocker の行）: まとめて実行（`startStageChain`）を、ジョブの
// 管理から、本物の子 process（一時のビルド）と本物の Chromium（headless）で、端から端まで確かめる結合テスト。Run の Browser は、テストの既定の Chromium と
// CLI の起動の設定の両方（テストだけの入口の `launchRunBrowser`）。
// - ログインは連鎖ごとに 1 回（サーバの記録 `successfulLogins` で数える）。段ごとにジョブの行と Run が 1 つずつ。READ の定義が 0 件なら READ を行わない（失敗に
//   しない）。定義があれば、発見の段の索引から決めた対象の画面で READ を行う。
// - 段の間に、ほかのジョブを始められない（連鎖の間に繰り返し始めて、どれも `JOB_ALREADY_ACTIVE`）。
// - 途中の段のジョブの行は、始めた時の改訂のまま（手動のログインの自動の登録を連鎖の最後に 1 回だけ行うことは、偽のワーカーの `control-stage-chain.test.ts`）。
// - 「やめる」で、次の段を始めない（連鎖を `USER_STOPPED` で止める）。
// - ログインの状態（秘密の目印）が、成果物・管理データ（ファイル・WAL・表）・IPC・ワーカーの出力・ジョブの値に書かれない。
// 作業のディレクトリ、管理データ、出力先は一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
// TS-c（設計書 `doc/design/2026-10-24-beaksight-test-suite-tiers-design.md` 3.3）: テストのファイルではない（Vitest は直接は流さない）。前の
// `stage-chain-fork.test.ts` を Run の Browser ごとに 2 つのテストのファイル（`stage-chain-fork-default.test.ts`・`stage-chain-fork-cli.test.ts`）に分けて
// 並列で流すため、本文と共通の補助をここに残し（複製しない）、登録の関数（`registerChainedRunCases`）を公開する。最上位の準備（一時のビルドなど）は、
// 読み込んだテストのファイルごとに登録される。テストの名前は、分ける前と同じ。
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { createAuditJobManager, type AuditJobManager, type AuditJobStartResult, type AuditWorkerForker } from '../../src/control/job/audit-job-manager.js';
import { readDiscoveryIndex } from '../../src/control/job/discovery-index-store.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import { createReadCheck, readRecentReadCheckResults } from '../../src/control/job/read-check-store.js';
import type { StageChainView } from '../../src/control/job/stage-chain-policy.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile } from '../../src/control/store/profile-store.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { wait as sleep } from '../../src/core/deadline.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import {
  DISCOVERY_SITE_LOGIN_FIELDS,
  DISCOVERY_SITE_PATHS,
  DISCOVERY_SITE_READ_CHECK_PATHS,
  startDiscoverySite,
  type DiscoverySite,
} from '../helpers/discovery-site-fixture.js';
import { databaseFilePlaces, databaseTablesText, filesUnder, nonReadRequestsOf, placesWithMarkers, textLeakPlace, type LeakPlace } from '../helpers/leak-places.js';
import { cliTargetConfig } from '../helpers/run-harness.js';
import { buildIntoTemporaryDirectory, type TemporaryBuild } from '../helpers/temporary-build.js';
import { TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE } from '../helpers/test-chromium-args.js';
import { testLoginWorkerEntrySource } from '../helpers/test-login-worker-entry.js';
import { STDIN_CREDENTIALS_EXPRESSION, STDIN_CREDENTIALS_PRELUDE, createRecordingFork, hideJobBrowser } from '../helpers/worker-fork-support.js';

const SUITE_TIMEOUT_MS = 900_000;
const TEST_TIMEOUT_MS = 600_000;
const WAIT_LIMIT_MS = 300_000;
const WAIT_POLL_MS = 100;
/** 連鎖の間に、ほかのジョブを始めてみる間隔（ms）。 */
const START_ATTEMPT_INTERVAL_MS = 20;
const LOGIN_TIMEOUT_MS = 60_000;
const PROFILE_ID = 'example-chain-fork';
const TARGET_CONFIG_PATH = 'local/targets/chain-fork.json';
const OUTPUT_DIRECTORY_NAME = 'chain-fork-output';
const NAVIGATION_INTERVAL_MS = 200;
const MAX_PAGES = 30;
/** FM2R の C-1: 境目の間隔を確かめる回の、読み込みの最小の間隔（ms）とページの上限（短くするため小さく）。 */
const BOUNDARY_INTERVAL_MS = 6_000;
const BOUNDARY_MAX_PAGES = 4;

/** Run の Browser の起動（テストだけの入口の値）。 */
const RUN_BROWSERS = [
  ['the default test Chromium', `() => ${TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE}`],
  ['the CLI launch settings', 'undefined'],
] as const;

/**
 * テストだけの入口の本文（一時のビルドの root に書く）。CC-091（PRE42-CC の組 6a）: 共用の `testLoginWorkerEntrySource`（CLI の起動の設定の
 * headless のログイン用の Browser）に、Run の Browser の起動の口を `additionalHooks` で足す。手動のログインの資格情報は、標準入力から受ける
 * （`worker-fork-support.ts` の準備。`[セレクタ, 値]` の組と、送るボタンのセレクタ）。`runBrowser` は、Run の Browser の起動（`undefined` は本番の起動）。
 */
const entrySourceOf = (runBrowser: string): string => testLoginWorkerEntrySource({
  distPrefix: './dist/',
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  prelude: `${STDIN_CREDENTIALS_PRELUDE}const launchRunBrowser = ${runBrowser};\n`,
  credentialsExpression: STDIN_CREDENTIALS_EXPRESSION,
  additionalHooks: '\n  ...(launchRunBrowser === undefined ? {} : { launchRunBrowser }),',
});

let build: TemporaryBuild;
const children: ChildProcess[] = [];

interface Workspace {
  readonly directory: string;
  readonly database: ControlDatabase;
  readonly site: DiscoverySite;
  readonly received: unknown[];
  /** 親がメッセージを受けた時刻（`received` と同じ順。FM2R の C-1 の境目の時刻）。 */
  readonly receivedAt: number[];
  /** FM2R の I-2: 子の process のメッセージを受けるたびに呼ぶ（ジョブの管理の受け手より先に呼ばれる）。 */
  onWorkerMessage: ((message: unknown) => void) | undefined;
  workerOutput: string;
  manager: AuditJobManager | undefined;
}

let workspace: Workspace | undefined;

const current = (): Workspace => {
  if (workspace === undefined) {
    throw new Error('no workspace');
  }
  return workspace;
};

beforeAll(async () => {
  build = await buildIntoTemporaryDirectory();
}, SUITE_TIMEOUT_MS);

afterAll(async () => {
  const leftovers = children.filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of leftovers) {
    child.kill();
  }
  await build?.remove();
  expect(leftovers.length, 'workers left running after the tests').toBe(0);
}, SUITE_TIMEOUT_MS);

afterEach(async () => {
  if (workspace === undefined) {
    return;
  }
  await workspace.manager?.close();
  await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())))));
  closeControlDatabase(workspace.database);
  await workspace.site.close();
  await rm(workspace.directory, { recursive: true, force: true });
  workspace = undefined;
}, SUITE_TIMEOUT_MS);

const setupFor = (site: DiscoverySite, profileRevision: number): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: PROFILE_ID,
  profileRevision,
  loginStartUrl: `${site.origin}${DISCOVERY_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin: site.origin, path: DISCOVERY_SITE_PATHS.login }],
  successCondition: { pathPrefix: DISCOVERY_SITE_PATHS.admin, selector: '#admin-ok' },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [DISCOVERY_SITE_PATHS.logout, DISCOVERY_SITE_READ_CHECK_PATHS.privateArea],
  auditPathPrefixes: [DISCOVERY_SITE_PATHS.admin],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});

/** 作業の場所・プロファイル・認証の設定・ジョブの管理を作る。 */
async function prepare(runBrowser: string, crawl: { readonly intervalMs: number; readonly maxPages: number } = {
  intervalMs: NAVIGATION_INTERVAL_MS, maxPages: MAX_PAGES,
}): Promise<AuditJobManager> {
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-chain-fork-'));
  workspace = {
    directory,
    database: openControlDatabase(resolveControlDatabasePath(directory)),
    site: await startDiscoverySite({ readCheckPages: true }),
    received: [],
    receivedAt: [],
    onWorkerMessage: undefined,
    workerOutput: '',
    manager: undefined,
  };
  const space = workspace;
  await mkdir(join(directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(directory, TARGET_CONFIG_PATH), JSON.stringify(cliTargetConfig('chain-fork', space.site.origin, DISCOVERY_SITE_PATHS.admin, {
    crawl: { minNavigationIntervalMs: crawl.intervalMs, maxPages: crawl.maxPages },
    audit: { screenshots: false },
    output: { directory: join(directory, OUTPUT_DIRECTORY_NAME) },
  })), 'utf8');
  const resolveContext = async (path: string): Promise<ProfileValidationContext | undefined> =>
    (path === TARGET_CONFIG_PATH ? { targetConfig: await loadConfig(join(directory, path)) } : undefined);
  const context = await resolveContext(TARGET_CONFIG_PATH);
  const contextResolver = (): ProfileValidationContext | undefined => context;
  expect(createProfile(space.database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId: PROFILE_ID,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath: TARGET_CONFIG_PATH,
    environment: 'TEST',
    mode: 'TEST_AUTH_PASSIVE',
    auth: 'MANUAL_SESSION',
    approvedTestOrigins: [space.site.origin],
    environmentEvidenceRef: 'evidence/example-chain-fork/isolation-check-1',
  }, { resolveContext: contextResolver }).ok).toBe(true);
  hideJobBrowser(space.database, PROFILE_ID);
  expect(saveAuthSetup(space.database, setupFor(space.site, MIN_PROFILE_REVISION), { resolveContext: contextResolver }).ok).toBe(true);
  const entry = join(build.rootDirectory, `${Date.now()}-chain-worker-test-entry.mjs`);
  await writeFile(entry, entrySourceOf(runBrowser), 'utf8');
  const fields: [string, string][] = [];
  await space.site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  const manualCredentials = JSON.stringify({ fields, submit: DISCOVERY_SITE_LOGIN_FIELDS.submit });
  const recordingFork: AuditWorkerForker = createRecordingFork({
    entry,
    stdinText: () => manualCredentials,
    onChild: (child) => children.push(child),
    onReceived: (message) => {
      space.received.push(message);
      space.receivedAt.push(Date.now());
      space.onWorkerMessage?.(message);
    },
    onOutput: (chunk) => { space.workerOutput += chunk; },
  });
  space.manager = createAuditJobManager({
    database: space.database,
    repositoryRoot: directory,
    workerPath: join(build.distDirectory, 'worker', 'audit-worker.js'),
    resolveContext,
    forkWorker: recordingFork,
  });
  return space.manager;
}

/** 連鎖が終わり（最後の段のジョブの行も終わり）、ワーカーが終わるまで待つ。 */
async function waitForChainEnd(manager: AuditJobManager, chainId: string): Promise<StageChainView> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const chain = manager.getStageChainOfJob(chainId);
    const jobs = (chain?.stages ?? []).flatMap(({ jobId }) => (jobId === null ? [] : [manager.getAuditJob(jobId)]));
    if (chain !== null && chain.state !== 'RUNNING' && jobs.every((job) => job?.finishedAt !== null) && manager.runningWorkerCount() === 0) {
      return chain;
    }
    if (Date.now() > deadline) {
      throw new Error(`the chain did not end: ${JSON.stringify(chain)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

/** 連鎖の間、ほかのジョブ（入口の確かめ）を繰り返し始めてみる。連鎖が終わるまでの結果を返す。 */
async function startAttemptsDuring(manager: AuditJobManager, chainId: string): Promise<readonly AuditJobStartResult[]> {
  const results: AuditJobStartResult[] = [];
  while (manager.getStageChainOfJob(chainId)?.state === 'RUNNING') {
    const result = await manager.startEntryCheck({ profileId: PROFILE_ID, expectedRevision: getProfile(current().database, PROFILE_ID)?.profile.revision ?? 0 });
    // 連鎖が終わった後に通ったものは、連鎖の間の空きではない（数えない。終わりを待つ）。
    if (result.ok) {
      expect(manager.getStageChainOfJob(chainId)?.state, 'a job started while the chain was running').not.toBe('RUNNING');
      await waitForJobEnd(manager, result.job.jobId);
      break;
    }
    results.push(result);
    await sleep(START_ATTEMPT_INTERVAL_MS);
  }
  return results;
}

async function waitForJobEnd(manager: AuditJobManager, jobId: string): Promise<AuditJobView> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const job = manager.getAuditJob(jobId);
    if (job !== null && job.finishedAt !== null && manager.runningWorkerCount() === 0) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`the job did not end: ${JSON.stringify(job)}`);
    }
    await sleep(WAIT_POLL_MS);
  }
}

const jobsOf = (manager: AuditJobManager, chain: StageChainView): readonly AuditJobView[] =>
  chain.stages.flatMap(({ jobId }) => {
    const job = jobId === null ? null : manager.getAuditJob(jobId);
    return job === null ? [] : [job];
  });

/** 発見の段の `discovery.json`。 */
function discoveryDocumentOf(job: AuditJobView): DiscoveryDocument {
  if (job.runDirectory === null) {
    throw new Error('the job has no Run directory');
  }
  return JSON.parse(readFileSync(artifactFilePath(join(current().directory, OUTPUT_DIRECTORY_NAME, job.runDirectory), DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
}

/** 発見の結果から、READ の確かめの定義を 1 つ作る（候補に照らす検証と保存を直接呼ぶ）。 */
function createDefinition(document: DiscoveryDocument): void {
  const form = discoveryCandidatesOf(document).find((candidate) => candidate.page.path === DISCOVERY_SITE_READ_CHECK_PATHS.orders && candidate.kind === 'FORM');
  if (form === undefined) {
    throw new Error('no form on the orders page');
  }
  const checked = validateReadCheckDefinition({
    targetIdentityDigest: form.identityDigest, parameters: { q: 'りんご', status: 'open' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }],
  }, form);
  if (!checked.ok) {
    throw new Error(`the definition was rejected: ${JSON.stringify(checked.errors)}`);
  }
  expect(createReadCheck(current().database, { readCheckId: 'read-orders', profileId: PROFILE_ID, definition: checked.definition, at: '20261022000000' }).ok)
    .toBe(true);
}

/**
 * 目印が出た場所。管理データのファイルと WAL と表、IPC、ワーカーの出力、ジョブの値、索引、発見と READ の確かめの成果物は、すべての秘密の目印で探す。監査の段の
 * 成果物は、見えている文と form の値を残す仕様（認証つきの監査の「見えている文とスクリーンショットは伏せません」）なので、ログインの状態と資格情報の目印
 * （セッションの値、資格情報、localStorage の値）で探す。
 */
function leakedPlaces(): readonly string[] {
  const space = current();
  const databasePath = resolveControlDatabasePath(space.directory);
  const outputDirectory = join(space.directory, OUTPUT_DIRECTORY_NAME);
  const auditRunDirectories = (space.manager?.listAuditJobs() ?? [])
    .flatMap(({ jobKind, runDirectory }) => (jobKind === 'AUDIT' && runDirectory !== null ? [join(outputDirectory, runDirectory)] : []));
  const isAuditArtifact = ([place]: LeakPlace): boolean => auditRunDirectories.some((directory) => place.startsWith(directory));
  const artifacts = filesUnder(outputDirectory);
  const places: readonly LeakPlace[] = [
    ...databaseFilePlaces(databasePath),
    textLeakPlace('tables', databaseTablesText(databasePath, ['jobs', 'discovery_candidates', 'discovery_jobs', 'read_checks', 'read_check_results'])),
    textLeakPlace('ipc received', JSON.stringify(space.received)),
    textLeakPlace('worker output', space.workerOutput),
    textLeakPlace('job views', JSON.stringify(space.manager?.listAuditJobs() ?? [])),
    textLeakPlace('index', JSON.stringify(readDiscoveryIndex(space.database, PROFILE_ID))),
    ...artifacts.filter((place) => !isAuditArtifact(place)),
  ];
  const markers = space.site.secretValues();
  const loginMarkers = space.site.loginStateValues();
  expect(markers.length).toBeGreaterThan(5);
  expect(auditRunDirectories.length).toBeGreaterThan(0);
  return [...placesWithMarkers(places, markers), ...placesWithMarkers(artifacts.filter(isAuditArtifact), loginMarkers)];
}

const workerMessages = (): readonly WorkerToParentMessage[] => current().received.flatMap((message) => {
  const checked = validateWorkerToParentMessage(message);
  return checked.ok ? [checked.message] : [];
});

/** Run の Browser の名前（`RUN_BROWSERS` の 1 つ目の値）。 */
export type ChainedRunBrowserName = (typeof RUN_BROWSERS)[number][0];

/**
 * TS-c: Run の Browser が `runBrowserName` の、まとめて実行の端から端のテストを登録する（`stage-chain-fork-default.test.ts` と
 * `stage-chain-fork-cli.test.ts` が 1 つずつ呼ぶ）。describe の名前は分ける前と同じ。本文は、分ける前の位置と字下げのまま。
 */
export function registerChainedRunCases(runBrowserName: ChainedRunBrowserName): void {
describe.each(RUN_BROWSERS.filter(([name]) => name === runBrowserName))('FM2d: the chained run end to end (%s)', (_name, runBrowser) => {
  it('logs in once per chain, runs the stages without a gap, skips the READ check without a definition, and registers the login once at the end', async () => {
    const manager = await prepare(runBrowser);
    const space = current();

    // 1 回目: READ の定義がない。監査 → 発見の後に、READ を行わずに終える。
    const started = await manager.startStageChain({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!started.ok) {
      throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
    }
    expect(started.job.jobKind).toBe('AUDIT');
    const attempts = await startAttemptsDuring(manager, started.job.jobId);
    const first = await waitForChainEnd(manager, started.job.jobId);
    // 段の間に、ほかのジョブを始められなかった（どれも同時に 1 つの枠で拒まれた）。
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((attempt) => !attempt.ok && attempt.reason === 'JOB_ALREADY_ACTIVE')).toBe(true);
    expect(first).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(first.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    const firstJobs = jobsOf(manager, first);
    expect(firstJobs.map(({ jobKind, state, profileRevision }) => [jobKind, state, profileRevision]))
      .toEqual([['AUDIT', 'FINISHED', MIN_PROFILE_REVISION], ['DISCOVERY', 'FINISHED', MIN_PROFILE_REVISION]]);
    expect(new Set(firstJobs.map(({ runId }) => runId)).size).toBe(2);
    // ログインは 1 回（サーバの記録）。読み取りでない要求は、ログインの POST だけ。
    expect(space.site.successfulLogins).toBe(1);
    expect(nonReadRequestsOf(space.site.requests)).toEqual([`POST ${DISCOVERY_SITE_PATHS.login}`]);
    // 段ごとに RUN_STARTED と FINISHED（未完了の理由のコードつき）。ログインの段の知らせは最初の段だけ。
    const messages = workerMessages();
    expect(messages.filter(({ type }) => type === 'RUN_STARTED')).toHaveLength(2);
    expect(messages.filter((message) => message.type === 'FINISHED' && message.incompleteReasonCodes !== undefined)).toHaveLength(2);
    expect(messages.filter((message) => message.type === 'AUTH_STATE' && message.state === 'AUTHENTICATED')).toHaveLength(1);
    // 改訂は、連鎖の途中で進まない（どの段の行も始めた時の改訂）。この fixture のログイン（フォームの送信）は通した送信がないので、手動のログインの
    // 自動の登録は起きない（連鎖の最後に 1 回だけ登録することは、偽のワーカーの `control-stage-chain.test.ts` で確かめる）。
    expect(manager.getAuditJob(started.job.jobId)?.loginStage?.autoRegistration).toBeUndefined();
    const revisionAfterFirst = getProfile(space.database, PROFILE_ID)?.profile.revision ?? 0;
    expect(revisionAfterFirst).toBe(MIN_PROFILE_REVISION);

    // 2 回目: 発見の結果から READ の定義を作る。監査 → 発見 → READ を行い、READ の結果を記録する。ログインは 1 回。
    const discoveryJob = firstJobs[1];
    if (discoveryJob === undefined) {
      throw new Error('no discovery job');
    }
    createDefinition(discoveryDocumentOf(discoveryJob));
    const restarted = await manager.startStageChain({ profileId: PROFILE_ID, expectedRevision: revisionAfterFirst, startNew: true });
    if (!restarted.ok) {
      throw new Error(`the second chain did not start: ${JSON.stringify(restarted)}`);
    }
    const second = await waitForChainEnd(manager, restarted.job.jobId);
    expect(second).toMatchObject({ state: 'FINISHED', stopReason: null });
    expect(second.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'DONE']]);
    const secondJobs = jobsOf(manager, second);
    expect(secondJobs.map(({ jobKind, state, profileRevision }) => [jobKind, state, profileRevision]))
      .toEqual([['AUDIT', 'FINISHED', revisionAfterFirst], ['DISCOVERY', 'FINISHED', revisionAfterFirst], ['READ_CHECK', 'FINISHED', revisionAfterFirst]]);
    expect(space.site.successfulLogins).toBe(2);
    expect(nonReadRequestsOf(space.site.requests)).toEqual([`POST ${DISCOVERY_SITE_PATHS.login}`, `POST ${DISCOVERY_SITE_PATHS.login}`]);
    const readJob = secondJobs[2];
    expect(readRecentReadCheckResults(space.database, PROFILE_ID).some(({ jobId }) => jobId === readJob?.jobId)).toBe(true);
    expect(getProfile(space.database, PROFILE_ID)?.profile.revision ?? 0).toBe(revisionAfterFirst);

    // ログインの状態（秘密の目印）が、どこにも書かれていない。
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('stops the whole chain on the stop of the audit stage, and does not start the next stage', async () => {
    const manager = await prepare(runBrowser);
    const space = current();
    const started = await manager.startStageChain({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!started.ok) {
      throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
    }
    // 監査の段の Run が始まってから止める。
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while (manager.getAuditJob(started.job.jobId)?.runId === null && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
    }
    expect(manager.stopAuditJob(started.job.jobId).ok).toBe(true);
    const chain = await waitForChainEnd(manager, started.job.jobId);
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    // FM2R の I-5: 連鎖が止まった段に印（`STOPPED`）を付ける。
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'STOPPED'], ['DISCOVERY', 'NOT_STARTED'], ['READ_CHECK', 'NOT_STARTED']]);
    expect(manager.listAuditJobs().map(({ jobKind }) => jobKind)).toEqual(['AUDIT']);
    expect(space.site.successfulLogins).toBe(1);
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // FM2R の I-2（レビューの X2・X2b）: 監査の段の `FINISHED` の直後（次の段へ進めている間・進めた直後）に、古い段（監査の段）の ID で「やめる」を押しても
  // 受け、連鎖の全体を止める。READ の段は始めない。発見の段を始めていれば、その段を止める。読み取りでない要求は、ログインの POST だけ。
  it.each([
    ['setImmediate', (stop: () => void) => { setImmediate(stop); }],
    ['5 ms', (stop: () => void) => { setTimeout(stop, 5); }],
    ['50 ms', (stop: () => void) => { setTimeout(stop, 50); }],
  ] as const)('accepts the stop with the old stage id right after the FINISHED of the audit stage (%s), and stops the whole chain', async (_timing, schedule) => {
    const manager = await prepare(runBrowser, { intervalMs: NAVIGATION_INTERVAL_MS, maxPages: BOUNDARY_MAX_PAGES });
    const space = current();
    const chainIdHolder = { value: '' };
    let stopResult: ReturnType<AuditJobManager['stopAuditJob']> | null = null;
    let seen = false;
    space.onWorkerMessage = (message) => {
      const checked = validateWorkerToParentMessage(message);
      if (!seen && checked.ok && checked.message.type === 'FINISHED') {
        seen = true;
        schedule(() => {
          stopResult = manager.stopAuditJob(chainIdHolder.value);
        });
      }
    };
    const started = await manager.startStageChain({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!started.ok) {
      throw new Error(`the chain did not start: ${JSON.stringify(started)}`);
    }
    chainIdHolder.value = started.job.jobId;
    const chain = await waitForChainEnd(manager, started.job.jobId);
    expect(seen).toBe(true);
    expect(stopResult, 'the stop with the old stage id').toMatchObject({ ok: true });
    expect(chain).toMatchObject({ state: 'STOPPED', stopReason: 'USER_STOPPED' });
    // 監査の段は終えている（次の段へ進める前に止めたなら、その段に止まった印）。発見の段は、始めていないか、始めていれば止めた。READ の段は始めない。
    expect(['DONE', 'STOPPED']).toContain(chain.stages[0]?.state);
    expect(['NOT_STARTED', 'STOPPED']).toContain(chain.stages[1]?.state);
    expect(chain.stages[2]).toMatchObject({ kind: 'READ_CHECK', state: 'NOT_STARTED' });
    expect(manager.listAuditJobs().every(({ jobKind }) => jobKind !== 'READ_CHECK')).toBe(true);
    expect(space.site.successfulLogins).toBe(1);
    expect(nonReadRequestsOf(space.site.requests)).toEqual([`POST ${DISCOVERY_SITE_PATHS.login}`]);
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  // FM2R の C-1（レビューの X1）: 再開した監査の段は外の pacer を使わない。次の段の pacer が監査の段の最後の読み込みを知らないと、境目の間隔が設定を
  // 下回る。サーバに届いた管理画面の HTML の時刻で、監査の段の最後の要求から発見の段の最初の要求までが、設定の間隔以上であることを確かめる。
  it('keeps the interval at the boundary from a resumed audit stage to the discovery stage (server arrival times)', async () => {
    const manager = await prepare(runBrowser, { intervalMs: BOUNDARY_INTERVAL_MS, maxPages: BOUNDARY_MAX_PAGES });
    const space = current();
    // 1 回目: 監査の段が何画面か読んだ後に止める（再開できる監査を作る）。
    const first = await manager.startStageChain({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: true });
    if (!first.ok) {
      throw new Error(`the chain did not start: ${JSON.stringify(first)}`);
    }
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while (space.site.requests.filter(({ adminDocument, authenticated }) => adminDocument && authenticated).length < 3 && Date.now() < deadline) {
      await sleep(WAIT_POLL_MS);
    }
    expect(manager.stopAuditJob(first.job.jobId).ok).toBe(true);
    await waitForChainEnd(manager, first.job.jobId);

    // 2 回目: 前回の続きから再開する（監査の段は再開の Run Coordinator）。
    const since = Date.now();
    const receivedBefore = space.received.length;
    const second = await manager.startStageChain({ profileId: PROFILE_ID, expectedRevision: MIN_PROFILE_REVISION, startNew: false });
    if (!second.ok) {
      throw new Error(`the resumed chain did not start: ${JSON.stringify(second)}`);
    }
    const chain = await waitForChainEnd(manager, second.job.jobId);
    expect(chain.stages.map(({ kind, state }) => [kind, state])).toEqual([['AUDIT', 'DONE'], ['DISCOVERY', 'DONE'], ['READ_CHECK', 'NOT_NEEDED']]);
    // 2 回目の RUN_STARTED（受けた時刻つき）。1 つ目は監査の段（再開）、2 つ目は発見の段。
    const runStarts = space.received.slice(receivedBefore).flatMap((message, index) => {
      const checked = validateWorkerToParentMessage(message);
      return checked.ok && checked.message.type === 'RUN_STARTED' ? [{ message: checked.message, at: space.receivedAt[receivedBefore + index] ?? 0 }] : [];
    });
    expect(runStarts[0]?.message.resumeDecision.kind).toBe('RESUME');
    const discoveryStartedAt = runStarts[1]?.at ?? null;
    expect(discoveryStartedAt).not.toBeNull();
    // 境目: 発見の段の Run が始まった後の最初の管理画面の HTML と、その前の最後の管理画面の HTML（監査の段の最後の要求）。
    const documents = space.site.requests.filter(({ at, adminDocument }) => at >= since && adminDocument);
    const firstDiscoveryIndex = documents.findIndex(({ at }) => discoveryStartedAt !== null && at >= discoveryStartedAt);
    expect(firstDiscoveryIndex).toBeGreaterThan(0);
    const boundaryGap = (documents[firstDiscoveryIndex]?.at ?? 0) - (documents[firstDiscoveryIndex - 1]?.at ?? 0);
    expect(boundaryGap, `the gap at the stage boundary (${BOUNDARY_INTERVAL_MS} ms configured)`).toBeGreaterThanOrEqual(BOUNDARY_INTERVAL_MS);
    expect(nonReadRequestsOf(space.site.requests).every((request) => request === `POST ${DISCOVERY_SITE_PATHS.login}`)).toBe(true);
    expect(leakedPlaces()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
}
