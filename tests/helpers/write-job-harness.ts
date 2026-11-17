// T30f・T30h-1（Task 30 の設計書 6 章、8 章の G30）: 点検（まとめて実行）の書き込みの段を、ジョブの管理（`createAuditJobManager`）から本物のワーカー
// （`child_process.fork`。一時のビルド）と本物の Chromium（headless だけ）で動かす結合テストの共通の準備（テストの補助。テストのファイルではない）。
// `navigation-pacing.test.ts` が使う（SLIM W-1: 単独で書き込みを始める口は外した。RB-6: 書き込みの連鎖の fork のテストは消した）。
// - 子 process の入口は、テストだけの入口（一時のビルドの root に書く `.mjs`）。本番の process の組み立て（`runAuditWorkerProcess`）を、テストだけの
//   口で呼ぶ: 手動のログインの段の Browser を CLI の起動の設定の headless に替え、人の操作の代わりに、テストが標準入力で渡した仮の資格情報を入れる。
//   書き込みの流れの Browser は本番の依存のまま（CLI の起動の設定の headless）。
// - 準備は、本番の部品の公開の口だけで行う: 書き込みのモードのプロファイルと認証の設定 → 発見（本物のワーカー）→ 発見の成果物の候補から
//   照合の READ の定義 → シナリオ（作成 → 入力の規則 → 本物の事実で承認）。許可は点検の書き込みの段が発行する。承認に縛る digest を手で書かない。
// - ジョブの管理の時計は、テストが進め・戻せる（`clockOffsetMs`）。ワーカーの時計は本物の時計なので、ワーカーが書く時刻（送った時刻など）が管理の
//   時計より前にならないように、テストは管理の時計を本物の時計より前（負の値）に置いて進める。
// - 秘密の目印（セッションの値、資格情報、CSRF、readonly の値）を探す場所: 管理データのファイルと WAL、IPC、ワーカーの出力、ジョブの値、出力先の
//   すべてのファイル。
// 作業のディレクトリ（リポジトリの root の代わり）、管理データ、出力先は、一時のフォルダだけ。サーバは 127.0.0.1 だけで待ち受ける。
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { wait as sleep } from '../../src/core/deadline.js';
import { loadConfig } from '../../src/config/load-config.js';
import { approvalExternalFactsOf } from '../../src/control/approval-external-facts.js';
import { createScenario, type ApprovalExternalFacts } from '../../src/control/approval/scenario-store.js';
import type { ScenarioLimits } from '../../src/control/approval/scenario-contracts.js';
import type { ScenarioDraftInput } from '../../src/control/approval/scenario-policy.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import {
  createAuditJobManager,
  type AuditJobManager,
  type AuditWorkerForker,
} from '../../src/control/job/audit-job-manager.js';
import type { AuditJobView } from '../../src/control/job/job-store.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { closeControlDatabase, openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile, getProfile, saveProfileDisplaySettings } from '../../src/control/store/profile-store.js';
import { AUDIT_SEND_READ_ONLY, type AuditSendPolicyName } from '../../src/core/audit-send-policy.js';
import { createCredentialStore, type CredentialStore } from '../../src/control/credentials/credential-store.js';
import { validateWorkerToParentMessage, type WorkerToParentMessage } from '../../src/control/worker-protocol.js';
import { DISCOVERY_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { formatCompactUtcTimestamp } from '../../src/core/utc-timestamp.js';
import { discoveryCandidatesOf, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { PATH_TEMPLATE_ID_SEGMENT } from '../../src/discovery/fingerprint.js';
import { ALL_CONFIRMED } from '../unit/approval-samples.js';
import { databaseFilePlaces, filesUnder, placesWithMarkers } from './leak-places.js';
import { settleLateDeliveries } from './loopback-server.js';
import { descendantsOf, listProcesses } from './process-tree.js';
import { cliTargetConfig } from './run-harness.js';
import { useSharedTemporaryBuild } from './shared-temporary-build.js';
import { buildEntryPath, type TemporaryBuild } from './temporary-build.js';
import { TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE } from './test-chromium-args.js';
import { testLoginWorkerEntrySource } from './test-login-worker-entry.js';
import { TEST_WAITS_HOOK_SOURCE } from './test-waits.js';
import { STDIN_CREDENTIALS_EXPRESSION, STDIN_CREDENTIALS_PRELUDE, createRecordingFork } from './worker-fork-support.js';
import { attachNameRulesAndApprove, createWriteSiteReadCheck, writeSiteAuthSetupOf, writeSiteCreateDraftOf } from './write-site-candidates.js';
import {
  WRITE_JOB_VERIFICATION,
  WRITE_SITE_LOGIN_FIELDS,
  WRITE_SITE_PATHS,
  startWriteSite,
  writeSiteEditPathOf,
  writeSiteRecordPathOf,
  type WriteSite,
} from './write-site-fixture.js';

const WAIT_LIMIT_MS = 180_000;
const WAIT_POLL_MS = 100;
const PROCESS_EXIT_LIMIT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 60_000;
const ENTRY_FILE_NAME = 'write-worker-test-entry.mjs';
const OUTPUT_DIRECTORY_NAME = 'write-fork-output';
const ENOUGH_PAGES = 10;

/** 読み込みの最小の間隔（ms。ループバックの fixture なので短くする）。 */
export const WRITE_JOB_NAVIGATION_INTERVAL_MS = 400;
/**
 * サーバに届いた時刻の長さで許す不足（ms。`navigation-pacing.test.ts` の同じ根拠）。DEF-100 fix から 0（pacer は、前の読み込みの
 * 文書の要求の応答を受けた時刻からも間隔を数えるので、届く間隔は設定以上。前は 250）。
 */
export const SERVER_ARRIVAL_DELAY_TOLERANCE_MS = 0;
/** 全部の回の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
export const LATE_DELIVERY_SETTLE_MS = 2_000;
/**
 * SLIM-2（X1）: 全部のジョブが終わった後（ワーカーが Browser を閉じて終えた後）に、遅れて届く要求を数え直す前の待ち。サイトが静まるまで
 * （`LATE_DELIVERY_SETTLE_MS` まで。`settleLateDeliveries`）。ジョブの途中では使わない。
 */
export const settleWriteJobSite = (harness: { readonly site: WriteSite }): Promise<void> => settleLateDeliveries(LATE_DELIVERY_SETTLE_MS, harness.site);
/** GET と HEAD（読み込みの要求の method。CC-091: 定義は `leak-places.ts` の 1 か所）。 */
export { READ_METHODS } from './leak-places.js';
/** 1 分（ms。管理の時計を進めるときの単位）。 */
export const MINUTE_MS = 60_000;


/**
 * テストだけの入口（一時のビルドの root に書く）。CC-061 の後半（PRE42-CC の組 6a）: 本文は、共用の `testLoginWorkerEntrySource`（CLI の起動の
 * 設定の headless のログイン用の Browser）。資格情報は、ファイルにも環境変数にも書かず、標準入力から受ける（`[セレクタ, 値]` の組と、送るボタンの
 * セレクタ。`worker-fork-support.ts` の準備）。
 */
const ENTRY_SOURCE = testLoginWorkerEntrySource({
  distPrefix: './dist/',
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  prelude: STDIN_CREDENTIALS_PRELUDE,
  credentialsExpression: STDIN_CREDENTIALS_EXPRESSION,
  loginLaunch: 'CLI',
  // TEST-TIME-B: 押した後の静まりの窓と probe の観察を短くする（テストだけの口）。
  additionalHooks: TEST_WAITS_HOOK_SOURCE,
});

/**
 * OP-2: Run の Browser（とログイン用の Browser）の起動の設定。`CLI` は CLI の起動の設定（上の入口のまま）、`TEST_DEFAULT` はテストの既定の headless shell。
 * SLIM-2（X6）: 既定は `TEST_DEFAULT`（CLI の Chromium の重い起動を、制御の場面で払わない）。書き込みの安全を 2 つの Chromium で確かめる場面だけが、`CLI` を
 * 明示して選ぶ（NL-2・OP-2 の `describe.each(['CLI', 'TEST_DEFAULT'])`）。
 */
export type WriteJobRunBrowser = 'CLI' | 'TEST_DEFAULT';

/** OP-2: Run の Browser をテストの既定の headless shell にした入口。 */
const TEST_DEFAULT_ENTRY_SOURCE = testLoginWorkerEntrySource({
  distPrefix: './dist/',
  loginTimeoutMs: LOGIN_TIMEOUT_MS,
  prelude: STDIN_CREDENTIALS_PRELUDE,
  credentialsExpression: STDIN_CREDENTIALS_EXPRESSION,
  loginLaunch: 'TEST_DEFAULT',
  additionalHooks: `\n  launchRunBrowser: () => ${TEST_DEFAULT_CHROMIUM_LAUNCH_SOURCE},${TEST_WAITS_HOOK_SOURCE}`,
});

/** シナリオの準備の選択肢。 */
export interface WriteJobScenarioOptions {
  readonly scenarioId: string;
  /** 人の固定の値の規則で決める名前（照合の READ の検索の値。シナリオごとに別の値にする）。 */
  readonly names: readonly string[];
  readonly limits?: ScenarioLimits;
}

/** T31g-2: UPDATE のシナリオの準備の指定（参照する CREATE のシナリオ、変える欄 `name` の値の候補、保つ欄）。 */
export interface WriteJobUpdateScenarioOptions extends WriteJobScenarioOptions {
  readonly targetCreateScenarioId: string;
  readonly keepFieldNames: readonly string[];
}

/**
 * T31g-2・T31i: 発見の成果物の更新の画面の候補（`/members/<id>/edit`）から作る UPDATE のシナリオの下書き（path の型は `/members/{id}/edit` と
 * `/members/{id}`、変える欄は `name`）。シナリオの変更の回（T31i）も使う。
 */
export const updateScenarioDraftOf = (profileId: string, document: DiscoveryDocument, scenario: WriteJobUpdateScenarioOptions): ScenarioDraftInput => {
  const edit = discoveryCandidatesOf(document).find((candidate) => candidate.kind === 'FORM' && /^\/members\/[^/]+\/edit$/u.test(candidate.page.path));
  expect(edit?.classification).toBe('UPDATE');
  if (edit === undefined) {
    throw new Error('the update form candidate was not discovered');
  }
  return {
    profileId,
    candidateIdentityDigest: edit.identityDigest,
    fieldNames: ['name'],
    readChecks: [],
    sideEffectConfirmations: ALL_CONFIRMED,
    limits: scenario.limits ?? { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
    approvalTtlDays: 30,
    verification: WRITE_JOB_VERIFICATION,
    update: {
      targetCreateScenarioId: scenario.targetCreateScenarioId,
      formPathTemplate: writeSiteEditPathOf(PATH_TEMPLATE_ID_SEGMENT),
      actionPathTemplate: writeSiteRecordPathOf(PATH_TEMPLATE_ID_SEGMENT),
      keepFieldNames: [...scenario.keepFieldNames],
    },
  };
};

export interface WriteJobHarness {
  readonly site: WriteSite;
  readonly database: ControlDatabase;
  /** 管理データのファイルのパス（WAL は、このパスに `-wal` を付けたもの）。 */
  readonly databasePath: string;
  readonly profileId: string;
  readonly children: readonly ChildProcess[];
  readonly manager: AuditJobManager;
  /** ジョブの管理の時計の、本物の時計からのずれ（ms）。 */
  clockOffsetMs: number;
  /** 管理の時計の今の時刻（UTC の 14 桁）。 */
  nowText(): string;
  /** ジョブの管理を作り直す（画面のサーバの再起動）。前の管理は閉じる。 */
  recreateManager(): Promise<AuditJobManager>;
  /**
   * OP-F（安全のレビューの M-1）: ジョブの管理が資格情報のメタデータを読むたびに呼ぶ受け手（読む前に、呼び出しの stack の文を渡す。null で外す）。親が書き込みの段を
   * 準備している間に「やめる」を押す場面を、時間に頼らずに作るためのテストの口（読む値は変えない）。
   */
  setCredentialMetadataReadHook(hook: ((stack: string) => void) | null): void;
  /** 発見のジョブ（本物のワーカー）を行い、成果物を返す。 */
  discover(): Promise<{ readonly job: AuditJobView; readonly document: DiscoveryDocument }>;
  /** 照合の READ の定義を作る（初めの 1 回だけ。発見の成果物の一覧の検索の候補から）。 */
  createReadCheck(document: DiscoveryDocument): void;
  /** 発見の成果物の候補からシナリオを作り、入力の規則を付け、本物の事実で承認する。 */
  approvedScenario(document: DiscoveryDocument, options: WriteJobScenarioOptions): Promise<void>;
  /**
   * T31g-2: 発見の成果物の更新の画面の候補（`/members/<id>/edit`）から UPDATE のシナリオを作り（path の型は `/members/{id}/edit` と
   * `/members/{id}`、変える欄は `name`）、入力の規則を付け、本物の事実で承認する。
   */
  approvedUpdateScenario(document: DiscoveryDocument, options: WriteJobUpdateScenarioOptions): Promise<void>;
  /** 本物の事実（承認に渡す）。 */
  externalFacts(): Promise<ApprovalExternalFacts>;
  /** ジョブが終わるまで待つ（ワーカーが止まるまで）。 */
  waitForEnd(jobId: string): Promise<AuditJobView>;
  /** 届いた登録の POST（`since` 番目の記録から）。 */
  createPosts(since?: number): readonly string[];
  /** T31g-2: 届いた更新の POST（`/members/<id>`。`since` 番目の記録から）。 */
  updatePosts(since?: number): readonly string[];
  /** ワーカーから受けたメッセージ（形が正しいものだけ）。 */
  workerMessages(): readonly WorkerToParentMessage[];
  /** 出力先の Run のディレクトリのファイル。 */
  runDirectoryOf(job: AuditJobView): string;
  /**
   * 読み込みの間隔（ログインの段の着地の後の、ワーカーの読み込み）。届いた順の読み込みが `expected`（`<method> <path>`。query を除く）と同じで、
   * 隣り合う 2 つの読み込みの届いた時刻の差が、どれも設定の間隔以上（T30R-fix-1 の M-4: 全体の長さだけでなく、間隔を 1 つずつ確かめる）。
   * redirect の続き（登録の POST の直後の GET。同じ読み込みの続きで、間隔の待ちを挟まない）は除く。
   */
  expectPacedNavigations(since: number, expected: readonly string[]): void;
  /** 秘密の目印が出た場所。 */
  leakedPlaces(): readonly string[];
  /** 送った値（合成のテストデータ）が出た場所（管理データのファイル・WAL・出力先のファイル。`values` のどれか）。 */
  placesContaining(values: readonly string[]): readonly string[];
  /** ワーカーがすべて終わり、その子孫（Chromium）が残っていないこと。 */
  expectNoProcessLeft(): Promise<void>;
  close(): Promise<void>;
}

/** 準備をする（一時のビルド、fixture のサイト、管理データ、プロファイルと認証の設定、ジョブの管理）。 */
export async function startWriteJobHarness(options: {
  readonly profileId: string;
  readonly clockOffsetMs?: number;
  /** OP-2: Run の Browser の起動の設定（SLIM-2（X6）: 省略は `TEST_DEFAULT`）。 */
  readonly runBrowser?: WriteJobRunBrowser;
  /**
   * NL-2（設計書 `2026-11-06-beaksight-no-login-test-site-design.md` 7 章）: ログインのないサイト（`startWriteSite` の `noLogin`）と、環境 `TEST` × 認証の方式
   * `NONE` のプロファイル（認証の設定を保存しない）。省略は今のまま（ログインのあるサイトと手動のログインのプロファイル）。
   */
  readonly noLogin?: boolean;
  /** NL fix round 1（SREV-NL の M-3）: 監査の段の送信の扱い（省略は今のまま `READ_ONLY`）。 */
  readonly auditSendPolicy?: AuditSendPolicyName;
}): Promise<WriteJobHarness> {
  const { profileId } = options;
  const noLogin = options.noLogin === true;
  const targetConfigPath = `local/targets/${profileId}.json`;
  // TEST-TIME-A: 一時ビルドは、1 回の vitest で共有する（harness を起こすたびにビルドしない）。入口は名前を分けて書く（`buildEntryPath`）。
  const build: TemporaryBuild = await useSharedTemporaryBuild();
  const directory = await mkdtemp(join(tmpdir(), 'beaksight-write-job-'));
  const database = openControlDatabase(resolveControlDatabasePath(directory));
  const site = await startWriteSite({ noLogin });
  const children: ChildProcess[] = [];
  const workerPids: number[] = [];
  const received: unknown[] = [];
  let workerOutput = '';
  let clockOffsetMs = options.clockOffsetMs ?? 0;
  const nowText = (): string => formatCompactUtcTimestamp(new Date(Date.now() + clockOffsetMs), 'test time');

  await mkdir(join(directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(directory, targetConfigPath), JSON.stringify(cliTargetConfig(profileId, site.origin, WRITE_SITE_PATHS.list, {
    crawl: { minNavigationIntervalMs: WRITE_JOB_NAVIGATION_INTERVAL_MS, maxPages: ENOUGH_PAGES },
    audit: { screenshots: false },
    output: { directory: join(directory, OUTPUT_DIRECTORY_NAME) },
  })), 'utf8');
  const context: ProfileValidationContext = { targetConfig: await loadConfig(join(directory, targetConfigPath)) };
  const resolveContext = (path: string): ProfileValidationContext | undefined => (path === targetConfigPath ? context : undefined);
  expect(createProfile(database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION,
    profileId,
    revision: MIN_PROFILE_REVISION,
    targetConfigPath,
    environment: 'TEST',
    mode: 'TEST_APPROVED_WRITE',
    auth: noLogin ? 'NONE' : 'MANUAL_SESSION',
    approvedTestOrigins: [site.origin],
    environmentEvidenceRef: `evidence/${profileId}/isolation-check-1`,
  }, { resolveContext }).ok).toBe(true);
  // FM-2: テストのジョブのブラウザは今どおり headless（プロファイルの表示の設定を切る。既定は表示）。
  // OP-I（I1）: 送信の扱いは今までどおり読み取りだけ（サイトの既定は `PASS_EXCEPT_DELETE` になった。人が詳しい内容で選んだ形）。
  expect(saveProfileDisplaySettings(database, profileId, { showJobBrowser: false, auditSendPolicy: options.auditSendPolicy ?? AUDIT_SEND_READ_ONLY }).ok).toBe(true);
  // NL-2: ログインのないサイトのプロファイルは、認証の設定を保存しない。
  if (!noLogin) {
    expect(saveAuthSetup(database, writeSiteAuthSetupOf(profileId, site.origin), { resolveContext }).ok).toBe(true);
  }
  const entry = buildEntryPath(build, ENTRY_FILE_NAME);
  await writeFile(entry, options.runBrowser === 'CLI' ? ENTRY_SOURCE : TEST_DEFAULT_ENTRY_SOURCE, 'utf8');
  const fields: [string, string][] = [];
  await site.fillCredentials(async (selector, value) => {
    fields.push([selector, value]);
  });
  const manualCredentials = JSON.stringify({ fields, submit: WRITE_SITE_LOGIN_FIELDS.submit });
  const recordingFork: AuditWorkerForker = createRecordingFork({
    entry,
    stdinText: () => manualCredentials,
    onChild: (child) => {
      children.push(child);
      if (child.pid !== undefined) {
        workerPids.push(child.pid);
      }
    },
    onReceived: (message) => received.push(message),
    onOutput: (chunk) => { workerOutput += chunk; },
  });
  let credentialMetadataReadHook: ((stack: string) => void) | null = null;
  const realCredentialStore = createCredentialStore(directory);
  const credentialStore: CredentialStore = {
    ...realCredentialStore,
    readMetadata: (id) => {
      credentialMetadataReadHook?.(new Error('credential metadata read').stack ?? '');
      return realCredentialStore.readMetadata(id);
    },
  };
  const managerOf = (): AuditJobManager => createAuditJobManager({
    database,
    repositoryRoot: directory,
    credentials: { root: directory, store: credentialStore },
    // DEF-277: fork するのはテストだけの入口（`recordingFork` の `entry`）。製品の入口の名前を書かない。
    workerPath: entry,
    resolveContext: async (path) => (path === targetConfigPath ? { targetConfig: await loadConfig(join(directory, path)) } : undefined),
    forkWorker: recordingFork,
    now: () => new Date(Date.now() + clockOffsetMs),
  });
  let manager = managerOf();

  const externalFacts = async (): Promise<ApprovalExternalFacts> => {
    const stored = getProfile(database, profileId);
    const value = stored === null ? null : await approvalExternalFactsOf(stored, {
      // OP-2: ジョブの管理と同じ資格情報のファイルの部品（点検の中のログインの直後の登録で、自動ログインになったプロファイルの事実もそろえる）。
      database, repositoryRoot: directory, credentialStore: createCredentialStore(directory),
    });
    if (value === null) {
      throw new Error('the external facts are not available');
    }
    return value;
  };

  const waitForEnd = async (jobId: string): Promise<AuditJobView> => {
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
  };

  const runDirectoryOf = (job: AuditJobView): string => {
    if (job.runDirectory === null) {
      throw new Error('the job has no Run directory');
    }
    return join(directory, OUTPUT_DIRECTORY_NAME, job.runDirectory);
  };

  /** OP-2: 今のプロファイルの改訂（点検の中のログインの直後の登録で進む）。 */
  const currentProfileRevision = (): number => getProfile(database, profileId)?.profile.revision ?? MIN_PROFILE_REVISION;

  /** 作ったシナリオに、変える欄 `name` の人の固定の値の規則を付け、本物の事実で承認する。 */
  const attachRulesAndApprove = async (created: ReturnType<typeof createScenario>, scenario: WriteJobScenarioOptions): Promise<void> => {
    const facts = await externalFacts();
    attachNameRulesAndApprove(database, created, {
      scenarioId: scenario.scenarioId, names: scenario.names, facts, now: new Date(Date.now() + clockOffsetMs), at: nowText(),
    });
  };

  const dataPlaces = (): (readonly [string, Buffer])[] => {
    const databasePath = resolveControlDatabasePath(directory);
    return [
      ...databaseFilePlaces(databasePath),
      ...filesUnder(join(directory, OUTPUT_DIRECTORY_NAME)),
    ];
  };

  return {
    site,
    database,
    databasePath: resolveControlDatabasePath(directory),
    profileId,
    children,
    get manager() {
      return manager;
    },
    get clockOffsetMs() {
      return clockOffsetMs;
    },
    set clockOffsetMs(value: number) {
      clockOffsetMs = value;
    },
    nowText,
    setCredentialMetadataReadHook: (hook) => {
      credentialMetadataReadHook = hook;
    },
    async recreateManager() {
      await manager.close();
      manager = managerOf();
      return manager;
    },
    async discover() {
      const started = await manager.startDiscovery({ profileId, expectedRevision: currentProfileRevision() });
      if (!started.ok) {
        throw new Error(`the discovery job did not start: ${JSON.stringify(started)}`);
      }
      const job = await waitForEnd(started.job.jobId);
      expect(job).toMatchObject({ jobKind: 'DISCOVERY', state: 'FINISHED', resultRunStatus: 'COMPLETE' });
      const document = JSON.parse(readFileSync(artifactFilePath(runDirectoryOf(job), DISCOVERY_ARTIFACT_FILE_NAME), 'utf8')) as DiscoveryDocument;
      expect(await validateArtifact('discovery', document)).toEqual({ ok: true });
      return { job, document };
    },
    createReadCheck(document) {
      const search = discoveryCandidatesOf(document).find((candidate) => candidate.kind === 'FORM' && candidate.page.path === WRITE_SITE_PATHS.list);
      expect(search?.classification).toBe('READ');
      if (search === undefined) {
        throw new Error('the search candidate was not discovered');
      }
      createWriteSiteReadCheck(database, profileId, search, nowText());
    },
    async approvedScenario(document, scenario) {
      const form = discoveryCandidatesOf(document).find((candidate) => candidate.kind === 'FORM' && candidate.page.path === WRITE_SITE_PATHS.form);
      expect(form?.classification).toBe('CREATE');
      if (form === undefined) {
        throw new Error('the form candidate was not discovered');
      }
      await attachRulesAndApprove(createScenario(database, {
        scenarioId: scenario.scenarioId,
        draft: writeSiteCreateDraftOf(profileId, form, scenario.limits),
        discovery: document,
        at: nowText(),
      }), scenario);
    },
    async approvedUpdateScenario(document, scenario) {
      await attachRulesAndApprove(createScenario(database, {
        scenarioId: scenario.scenarioId,
        draft: updateScenarioDraftOf(profileId, document, scenario),
        discovery: document,
        at: nowText(),
      }), scenario);
    },
    externalFacts,
    waitForEnd,
    createPosts: (since = 0) => site.requests.slice(since)
      .filter(({ method, path }) => method === 'POST' && path.split('?')[0] === WRITE_SITE_PATHS.create).map(({ path }) => path),
    updatePosts: (since = 0) => site.requests.slice(since)
      .filter(({ method, path }) => method === 'POST' && /^\/members\/[^/]+$/u.test(path.split('?')[0] ?? path)).map(({ path }) => path),
    workerMessages: () => received.flatMap((message) => {
      const checked = validateWorkerToParentMessage(message);
      return checked.ok ? [checked.message] : [];
    }),
    runDirectoryOf,
    expectPacedNavigations(since, expected) {
      const requests = site.requests.slice(since);
      const loginPost = requests.findIndex(({ method, path }) => method === 'POST' && path === WRITE_SITE_PATHS.login);
      expect(loginPost).toBeGreaterThanOrEqual(0);
      // ログインの段の着地（ログインの POST の後の最初の画面）の後。T30R-fix-1（M-4）: redirect の続きは、登録の POST の直後に届いた GET として
      // 除く（登録の POST は 303 で応答し、ブラウザが同じ読み込みの続きとして移り先を読む。前は `/members/<id>` の形の path で除いていた）。T31g-2:
      // 更新の POST（`/members/<id>`）の直後の GET も同じ（ログインの POST でない書き込みの POST の直後の GET）。
      const pathOf = (path: string): string => path.split('?')[0] ?? path;
      const afterLanding = requests.slice(loginPost + 2);
      const navigations = afterLanding.filter(({ method }, index) => {
        const previous = afterLanding[index - 1];
        return !(method === 'GET' && previous !== undefined && previous.method === 'POST' && pathOf(previous.path) !== WRITE_SITE_PATHS.login);
      });
      expect(navigations.map(({ method, path }) => `${method} ${pathOf(path)}`)).toEqual(expected);
      const intervals = navigations.slice(1).map((current, index) => ({
        between: `${navigations[index]?.method ?? ''} ${pathOf(navigations[index]?.path ?? '')} -> ${current.method} ${pathOf(current.path)}`,
        ms: current.at - (navigations[index]?.at ?? current.at),
      }));
      expect(intervals.filter(({ ms }) => ms < WRITE_JOB_NAVIGATION_INTERVAL_MS - SERVER_ARRIVAL_DELAY_TOLERANCE_MS)).toEqual([]);
      expect(intervals).toHaveLength(Math.max(expected.length - 1, 0));
    },
    leakedPlaces() {
      const places: (readonly [string, Buffer])[] = [
        ...dataPlaces(),
        ['ipc received', Buffer.from(JSON.stringify(received), 'utf8')],
        ['worker output', Buffer.from(workerOutput, 'utf8')],
        ['job views', Buffer.from(JSON.stringify(manager.listAuditJobs()), 'utf8')],
      ];
      const markers = site.secretValues();
      expect(markers.length).toBeGreaterThanOrEqual(5);
      return placesWithMarkers(places, markers);
    },
    placesContaining(values) {
      return dataPlaces().flatMap(([place, bytes]) => (values.some((value) => bytes.includes(Buffer.from(value, 'utf8'))) ? [place] : []));
    },
    async expectNoProcessLeft() {
      const deadline = Date.now() + PROCESS_EXIT_LIMIT_MS;
      for (;;) {
        const workersDone = children.every((child) => child.exitCode !== null || child.signalCode !== null);
        const processes = await listProcesses();
        const descendants = workerPids.flatMap((pid) => descendantsOf(pid, processes));
        if (workersDone && descendants.length === 0) {
          return;
        }
        if (Date.now() > deadline) {
          expect(descendants.map(({ name }) => name), 'processes left after the worker exited').toEqual([]);
          expect(workersDone).toBe(true);
          return;
        }
        await sleep(WAIT_POLL_MS);
      }
    },
    async close() {
      await manager.close();
      await Promise.all(children.map((child) => (child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())))));
      closeControlDatabase(database);
      await site.close();
      await build.remove();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
