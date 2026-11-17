// T40b-1（Task 40 の設計書 3.3、5 章）: SPA の fixture（`startSpaAuthSite` の form のない会員の画面）の API の登録のシナリオを、本番の部品の公開の口だけで
// 作る共通の準備（テストの補助。テストのファイルではない）。同じ process の中の書き込みの流れの結合（`api-write-create-run.test.ts`）が使う。T41d・T41d-2:
// API の更新のシナリオ（`createApiUpdateScenario`）も作り、同じ process の中の更新の流れ（`api-write-update-run.test.ts`）が使う。承認に縛る digest と API の
// 指定を手で書かない。
// - 発見は本物の流れ（`executeDiscoveryRun`。認証つきの factory と Guard、送らずに観察する probe）。ログインの段は通さず、fixture が出したセッションを
//   認証つきの Run の指定（メモリの状態）で渡す（`spaRunAuthenticationOf`。同じ指定を、同じ process の中の書き込みの流れにも渡す）。
// - 管理データ: 発見のジョブの行と候補の索引、照合の READ（`{id}` の型の画面の READ）、API のシナリオ（送る鍵は欄に対応する鍵、ID は応答の本文の鍵
//   `id`）、入力の規則（テンプレートの空の規則）。承認と許可は、呼ぶ側が行う。
// - TEST-SLIM W3・W4: 書き込みの結合が共通に使う準備（対象の設定とプロファイルと認証の設定 `openSpaWriteProfile`、自動の下書きから承認した登録
//   `approveSpaCreateDraft`、同じ process の中の書き込みの流れ `runSpaApiWrite`、サーバに届いた要求の数）も、ここに置く。
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import { loadConfig } from '../../src/config/load-config.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { ActionRunDocument } from '../../src/control/actions/action-contracts.js';
import { apiAutoDraftPlanOf, type AutoDraftCreatePlan } from '../../src/control/approval/api-scenario-autodraft.js';
import { createScenario, readScenarioRevisions, type ScenarioStoreResult } from '../../src/control/approval/scenario-store.js';
import type { ScenarioLimits, ScenarioRevision } from '../../src/control/approval/scenario-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION, SITE_PROFILE_SCHEMA_VERSION } from '../../src/control/contracts.js';
import { computeRuleSetDigest } from '../../src/control/data-rules/rule-digest.js';
import { inferRuleSetContent } from '../../src/control/data-rules/rule-set-inference.js';
import { readLatestRuleSet, saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { generateScenarioData } from '../../src/control/data-rules/scenario-data.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { createReadCheck, listReadChecks } from '../../src/control/job/read-check-store.js';
import { writeStartSpecOf } from '../../src/control/job/write-job-start.js';
import type { ProfileValidationContext } from '../../src/control/profile-policy.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import { saveAuthSetup } from '../../src/control/store/auth-setup-store.js';
import { openControlDatabase, type ControlDatabase } from '../../src/control/store/control-database.js';
import { resolveControlDatabasePath } from '../../src/control/store/database-path.js';
import { createProfile } from '../../src/control/store/profile-store.js';
import { isWorkerStartApiWrite, type WorkerStartApiWrite } from '../../src/control/worker-protocol.js';
import { ACTION_EVIDENCE_ARTIFACT_FILE_NAME, ACTION_RUN_ARTIFACT_FILE_NAME, artifactFilePath } from '../../src/core/artifact-layout.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoveryCandidatesOf, discoveryReadPagePaths, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { submissionProbeKeyFieldsOf } from '../../src/discovery/submission-probe-contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { executeWriteCreateRun } from '../../src/worker/write-create-run.js';
import { ALL_CONFIRMED } from '../unit/approval-samples.js';
import { sampleApprovalFacts } from './approval-facts-sample.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from './auth-setup-samples.js';
import { READ_METHODS } from './leak-places.js';
import { settleLateDeliveries } from './loopback-server.js';
import { cliTargetConfig, fastRunConfig } from './run-harness.js';
import { SPA_APP_PATHS, SPA_AUTH_STORAGE_KEY, SPA_BACKEND_PATHS, SPA_GRANT_TYPES, type SpaAuthSite } from './spa-auth-site-fixture.js';
import { TEST_OBSERVATION_WINDOWS, probeQuietWindowsOf } from './test-waits.js';

/** fixture の鍵の名前（`fixture-auth-token`）に当たる、成功の鍵の形。 */
export const API_WRITE_FIXTURE_SESSION_KEY = Object.freeze({ prefix: 'fixture', suffix: '-auth-token' });
/**
 * 照合の READ の `{id}` の型の画面の path。T40b-2: 会員の詳細の画面（fixture の `memberDetailPage`。読んだ値を後から `dl` の文字に描く）にした（照合の READ が
 * 画面の文字でメールアドレスを照らすため。更新の画面は値を欄に入れるので、本文の文字に出ない）。
 */
export const API_WRITE_READ_TEMPLATE_PATH = '/admin/members/{id}';
/** 保存のボタンの語。 */
const SAVE_WORD = '保存';
/** 発見で読む画面の数の上限。 */
const MAX_PAGES = 6;
/** 押した後に静まるまで待つ時間（ms。テストの値。fixture はすぐに送る）。 */
const SHORT_QUIET_WAIT_MS = 500;
const noObserver = { onRunStarted: (): void => undefined, onSessionLost: (): void => undefined };

/**
 * 認証つきの Run の指定（fixture が出したセッションをメモリの状態で渡す。承認したサービスの Origin はバックエンド）。T40b-2: `extraExcludedPathPrefixes` は、
 * 読まないパスに足す（取れた ID が読まないパスに当たる場面を作る）。
 */
export const spaRunAuthenticationOf = (
  site: SpaAuthSite,
  extraExcludedPathPrefixes: readonly string[] = [],
  login: SpaRunLogin = 'SCRIPT_LOGIN',
): RunAuthentication => ({
  initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
  approvedTestOrigins: [site.appOrigin],
  auditExclusions: {
    excludedPathPrefixes: [SPA_APP_PATHS.logout, ...extraExcludedPathPrefixes], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
  },
  sessionLostPathPrefix: SPA_APP_PATHS.auth,
  filterState: filterAuthenticatedState,
  ...(login === 'NO_LOGIN' ? {} : {
    auditStage: {
      // DEF-220: データをアプリと同じ Origin で答える fixture（`sameOriginBackend`）では、テストの Origin をサービスの Origin にしない（プロファイルの決まりと同じ）。
      approvedServiceOrigins: [site.backendOrigin === site.appOrigin ? site.tokenOrigin : site.backendOrigin],
      auditReadRequests: [],
      scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    },
    sessionKeyPresent: (state: Parameters<NonNullable<RunAuthentication['sessionKeyPresent']>>[0]) =>
      hasSuccessStorageKey(state, { origin: site.appOrigin, ...API_WRITE_FIXTURE_SESSION_KEY }),
  }),
});

/**
 * DEF-220: Run の指定のログインの形。`SCRIPT_LOGIN` はスクリプトで送るログインの監査の段の口を持つ形（今まで）、`NO_LOGIN` は口を持たない形（ワーカーがログインのない
 * テスト用のサイトで作る指定と同じく、承認した API の Origin は空。状態は fixture の画面が読むために渡す）。
 */
export type SpaRunLogin = 'SCRIPT_LOGIN' | 'NO_LOGIN';

/** 設定（`/admin` から。出力先は `outputDirectory`）。 */
export const spaApiWriteConfigOf = (site: SpaAuthSite, outputDirectory: string, overrides: Parameters<typeof fastRunConfig>[2] = {}): AuditConfig => {
  const base = fastRunConfig(site.appOrigin, SPA_APP_PATHS.admin, {
    ...overrides, target: { id: 'spa-api-write' }, output: { directory: outputDirectory }, crawl: { maxPages: MAX_PAGES, ...overrides.crawl },
  });
  return { ...base, site: { startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`, allowedOrigins: [site.appOrigin] } };
};

/** `discoverSpaMemberScreens` の発見のジョブの ID の既定（PRE42-CC 組 Z の前からの値）。 */
export const DEFAULT_SPA_DISCOVERY_JOB_ID = 'job-discovery-1';

/**
 * 発見のジョブ（`/admin` から。form のない会員の画面）を動かし、成果物の文書を返す。PRE42-CC 組 Z（SR-1-F の発見）: 同じ管理データで 2 回準備する
 * 呼び出し側は、ジョブの行が重ならないように、発見のジョブの ID（`options.jobId`。既定は `DEFAULT_SPA_DISCOVERY_JOB_ID`）を渡す。
 */
export const discoverSpaMemberScreens = async (
  site: SpaAuthSite,
  outputDirectory: string,
  launchBrowser: () => Promise<Browser>,
  options: { readonly jobId?: string; readonly login?: SpaRunLogin } = {},
): Promise<DiscoveryDocument> => {
  const outcome = await executeDiscoveryRun({
    config: spaApiWriteConfigOf(site, outputDirectory),
    jobId: options.jobId ?? DEFAULT_SPA_DISCOVERY_JOB_ID,
    authentication: spaRunAuthenticationOf(site, [], options.login),
    launchBrowser,
    clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, observationWindows: probeQuietWindowsOf(SHORT_QUIET_WAIT_MS),
  }, noObserver);
  if (outcome.kind !== 'RAN') {
    throw new Error(`the discovery did not run: ${outcome.kind}`);
  }
  return JSON.parse(readFileSync(join(outcome.runDirectory, 'discovery.json'), 'utf8')) as DiscoveryDocument;
};

/** 画面の保存のボタンの、probe の結果を持つ候補（まとめた後）。 */
export const saveButtonOf = (document: DiscoveryDocument, path: string): DiscoveryCandidate => {
  const found = mergeDiscoveryCandidates(discoveryCandidatesOf(document)).find((candidate) =>
    candidate.page.path === path && candidate.kind === 'BUTTON' && candidate.submitterWords.includes(SAVE_WORD) && candidate.submissionProbe !== undefined);
  if (found === undefined) throw new Error(`the page ${path} has no save button with a probe`);
  return found;
};

/** T41d: API の UPDATE のシナリオの準備の指定（台帳は `createApiCreateScenario` で作った登録のシナリオ）。 */
export interface ApiUpdateScenarioOptions {
  readonly profileId: string;
  readonly scenarioId: string;
  readonly ledgerScenarioId: string;
  readonly document: DiscoveryDocument;
  /** 更新の画面（probe した会員の更新の画面）の path。 */
  readonly updatePagePath: string;
  readonly at: () => string;
  /**
   * T41d-2: 照合の READ（`createApiCreateScenario` で作った `{id}` の型の画面の READ。期待は名前の欄の値）。指定すれば、検証の指定と入力の規則（テンプレートの
   * 空の規則）も付け、規則を付けた版を返す（本物の許可と開始の口に通すため）。指定しなければ、今までどおりシナリオだけを作る。
   */
  readonly readCheckId?: string;
}

/**
 * T41d（Task 41 の設計書 3.1）: form のない会員の更新の画面の保存のボタンから、API の UPDATE のシナリオを作る（変える鍵は名前、保つ鍵はメールアドレスと
 * 備考、filter は `id`、台帳は登録のシナリオで、更新の画面の型は `/admin/members/{id}/edit`）。作ったシナリオの今の版を返す。許可と開始の指定は呼ぶ側。
 */
export const createApiUpdateScenario = (database: ControlDatabase, options: ApiUpdateScenarioOptions): Extract<ScenarioStoreResult, { readonly ok: true }> => {
  const update = saveButtonOf(options.document, options.updatePagePath);
  expect(update.submissionProbe?.result).toBe('API_UPDATE');
  const probe = update.submissionProbe;
  if (probe === undefined) throw new Error('the candidate has no probe');
  const keyFields = submissionProbeKeyFieldsOf(probe);
  const created = createScenario(database, {
    scenarioId: options.scenarioId,
    draft: {
      profileId: options.profileId,
      candidateIdentityDigest: update.identityDigest,
      transport: 'API',
      fieldNames: ['name'],
      readChecks: [],
      sideEffectConfirmations: ALL_CONFIRMED,
      limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
      approvalTtlDays: 30,
      ...(options.readCheckId === undefined ? {} : {
        verification: {
          resultJudgement: null,
          recordId: null,
          readVerification: { readCheckId: options.readCheckId, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'name' }] },
        },
      }),
      api: {
        shapeDigest: probe.shapeDigest,
        pageKeys: keyFields.filter(({ field }) => field === null).map(({ key }) => key),
        filterName: 'id',
        recordId: null,
        ledger: { targetCreateScenarioId: options.ledgerScenarioId, formPathTemplate: '/admin/members/{id}/edit' },
        keptKeys: ['email', 'note'],
      },
    },
    discovery: options.document,
    at: options.at(),
  });
  if (!created.ok) throw new Error(`the update scenario was not created: ${JSON.stringify(created)}`);
  if (options.readCheckId === undefined) {
    return created;
  }
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${options.scenarioId}`, scenarioId: options.scenarioId, expectedRevision: null,
    content: { fieldRules: [], relations: [], uniqueKeyFieldNames: [] }, expectedScenarioRevision: created.scenario.revision, at: options.at(),
  });
  expect(saved.ruleSet).toMatchObject({ ok: true, evaluation: { executable: true } });
  if (saved.attachment === null || !saved.attachment.ok) throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  return saved.attachment;
};

/** API のシナリオの準備の指定。 */
export interface ApiCreateScenarioOptions {
  readonly profileId: string;
  readonly scenarioId: string;
  readonly readCheckId: string;
  readonly site: SpaAuthSite;
  readonly document: DiscoveryDocument;
  readonly limits: ScenarioLimits;
  readonly at: () => string;
  /**
   * OP-R（設計書 4.1.9 の R1）: 照合の READ の画面の path（省略は `{id}` の型 `API_WRITE_READ_TEMPLATE_PATH`）。一覧の画面の path を渡せば、照合の専用の印を付ける
   * （自動の下書きと同じ形）。
   */
  readonly readTargetPagePath?: string;
  /** OP-REV6 の I-1: 照合の READ の期待（本文が含む）で比べる欄（省略はメールアドレス `email`）。 */
  readonly expectationFieldName?: string;
}

/**
 * 発見のジョブの行と候補の索引、照合の READ（`{id}` の型の画面）、API の登録のシナリオ（登録の画面の保存のボタン）と入力の規則（テンプレート）を作る。
 * 作ったシナリオ（規則を付けた版）を返す。プロファイルと認証の設定は、呼ぶ側が先に作る。
 */
export const createApiCreateScenario = (database: ControlDatabase, options: ApiCreateScenarioOptions): Extract<ScenarioStoreResult, { readonly ok: true }> => {
  const { profileId, scenarioId, readCheckId, site, document, at } = options;
  const create = saveButtonOf(document, SPA_APP_PATHS.memberNew);
  expect(create.submissionProbe?.result).toBe('API_CREATE');
  recordSpaDiscoveryJob(database, profileId, document, at());
  // 照合の READ: `{id}` の型の画面の READ（画面の文脈で確かめる）。
  const readTargetPagePath = options.readTargetPagePath ?? API_WRITE_READ_TEMPLATE_PATH;
  createSpaReadCheck(database, { site, profileId, readCheckId, targetPagePath: readTargetPagePath, at: at() });
  // シナリオ（送る鍵は欄に対応する鍵）。検証の指定は照合の READ だけ（ID は API の `recordId`）。
  const probe = create.submissionProbe;
  if (probe === undefined) throw new Error('the candidate has no probe');
  const keyFields = submissionProbeKeyFieldsOf(probe);
  const created = createScenario(database, {
    scenarioId,
    draft: {
      profileId,
      candidateIdentityDigest: create.identityDigest,
      transport: 'API',
      fieldNames: keyFields.filter(({ field }) => field !== null).map(({ key }) => key),
      readChecks: [],
      sideEffectConfirmations: ALL_CONFIRMED,
      limits: options.limits,
      approvalTtlDays: 30,
      verification: {
        resultJudgement: null,
        recordId: null,
        readVerification: {
          readCheckId, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: options.expectationFieldName ?? 'email' }],
          ...(readTargetPagePath === API_WRITE_READ_TEMPLATE_PATH ? {} : { verificationOnly: true }),
        },
      },
      api: {
        shapeDigest: probe.shapeDigest,
        pageKeys: keyFields.filter(({ field }) => field === null).map(({ key }) => key),
        filterName: null,
        recordId: { source: 'RESPONSE_BODY_KEY', key: 'id' },
        ledger: null,
      },
    },
    discovery: document,
    at: at(),
  });
  if (!created.ok) throw new Error(`the scenario was not created: ${JSON.stringify(created)}`);
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: null, content: { fieldRules: [], relations: [], uniqueKeyFieldNames: [] },
    expectedScenarioRevision: created.scenario.revision, at: at(),
  });
  expect(saved.ruleSet).toMatchObject({ ok: true, evaluation: { executable: true } });
  if (saved.attachment === null || !saved.attachment.ok) throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  return saved.attachment;
};

/** 発見のジョブの行（ログインの確かめは済み）と候補の索引を管理データに書き、まとめた候補を返す。 */
export const recordSpaDiscoveryJob = (database: ControlDatabase, profileId: string, document: DiscoveryDocument, at: string): readonly DiscoveryCandidate[] => {
  expect(createStartingJob(database, {
    jobId: document.jobId, jobKind: 'DISCOVERY', profileId, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: at,
  }, () => null)).toEqual({ ok: true });
  expect(recordLoginCheckFinished(database, document.jobId, 0, at)).toBe(true);
  const candidates = mergeDiscoveryCandidates(discoveryCandidatesOf(document));
  recordDiscoveryCandidates(database, {
    profileId, jobId: document.jobId, at, entries: candidates.map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(document),
  });
  return candidates;
};

/** 照合の READ（画面の path の READ。画面の文脈で確かめる）を作る。 */
export const createSpaReadCheck = (
  database: ControlDatabase,
  options: { readonly site: SpaAuthSite; readonly profileId: string; readonly readCheckId: string; readonly targetPagePath: string; readonly at: string },
): void => {
  const { site } = options;
  const checked = validateReadCheckDefinition({ targetPagePath: options.targetPagePath, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, null, {
    startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`,
    allowedOrigins: [site.appOrigin],
    approvedTestOrigins: [site.appOrigin],
    excludedPathPrefixes: [SPA_APP_PATHS.logout],
    auditPathPrefixes: [SPA_APP_PATHS.admin],
    sessionLostPathPrefix: SPA_APP_PATHS.auth,
  });
  if (!checked.ok) throw new Error(`the READ check was rejected: ${JSON.stringify(checked.errors)}`);
  expect(createReadCheck(database, { readCheckId: options.readCheckId, profileId: options.profileId, definition: checked.definition, at: options.at }).ok).toBe(true);
};

/**
 * TEST-SLIM W3・W4: 書き込みの結合の、対象の設定のファイル（`directory` の下）とプロファイル（`TEST_APPROVED_WRITE`）を作り、管理データを開いて返す。
 * `approvedServiceOrigins` が null ならログインのない形（`auth: 'NONE'`。認証の設定を持たない）、配列なら手渡しのセッションの形（承認したサービスの Origin と、
 * 画面の遷移の認証の設定）。
 */
export const openSpaWriteProfile = async (
  site: SpaAuthSite,
  directory: string,
  profileId: string,
  approvedServiceOrigins: readonly string[] | null,
): Promise<ControlDatabase> => {
  const database = openControlDatabase(resolveControlDatabasePath(directory));
  const targetConfigPath = `local/targets/${profileId}.json`;
  await mkdir(join(directory, 'local', 'targets'), { recursive: true });
  await writeFile(join(directory, targetConfigPath), JSON.stringify(cliTargetConfig(profileId, site.appOrigin, SPA_APP_PATHS.admin, {
    audit: { screenshots: false }, output: { directory: join(directory, 'unused-output') },
  })), 'utf8');
  const context: ProfileValidationContext = { targetConfig: await loadConfig(join(directory, targetConfigPath)) };
  const resolveContext = (path: string): ProfileValidationContext | undefined => (path === targetConfigPath ? context : undefined);
  expect(createProfile(database, {
    schemaVersion: SITE_PROFILE_SCHEMA_VERSION, profileId, revision: MIN_PROFILE_REVISION, targetConfigPath, environment: 'TEST',
    mode: 'TEST_APPROVED_WRITE', auth: approvedServiceOrigins === null ? 'NONE' : 'MANUAL_SESSION', approvedTestOrigins: [site.appOrigin],
    ...(approvedServiceOrigins === null || approvedServiceOrigins.length === 0 ? {} : { approvedServiceOrigins: [...approvedServiceOrigins] }),
    environmentEvidenceRef: `evidence/${profileId}/isolation-check-1`,
  }, { resolveContext })).toMatchObject({ ok: true });
  if (approvedServiceOrigins !== null) {
    expect(saveAuthSetup(database, {
      ...FORM_NAVIGATION_SETUP_ITEMS, profileId, profileRevision: MIN_PROFILE_REVISION,
      loginStartUrl: `${site.appOrigin}${SPA_APP_PATHS.auth}`, loginPostEndpoints: [{ origin: site.appOrigin, path: SPA_APP_PATHS.auth }],
      successCondition: { pathPrefix: SPA_APP_PATHS.admin, selector: null }, sessionLostCondition: { pathPrefix: SPA_APP_PATHS.auth },
      excludedPaths: [SPA_APP_PATHS.logout], auditPathPrefixes: [SPA_APP_PATHS.admin], maxLoginAttempts: 2, allowedIdpOrigins: [], automatedLogin: null,
    }, { resolveContext })).toMatchObject({ ok: true });
  }
  return database;
};

/** TEST-SLIM W4: 登録の画面（`SPA_APP_PATHS.memberNew`）の行の、本番の自動の下書きの計画（承認したテストの Origin はアプリの Origin）。 */
export const spaCreateAutoDraftPlanOf = (
  site: SpaAuthSite,
  profileId: string,
  candidates: readonly DiscoveryCandidate[],
  approvedServiceOrigins: readonly string[],
): AutoDraftCreatePlan | undefined => apiAutoDraftPlanOf({
  profileId,
  candidates,
  context: {
    scenarioId: null, scenarios: [], approvedServiceOrigins, approvedTestOrigins: [site.appOrigin],
    profileRevisions: { discoveryJob: MIN_PROFILE_REVISION, current: MIN_PROFILE_REVISION },
  },
  scenarios: [],
}).creates.find(({ row }) => row.candidate.page.path === SPA_APP_PATHS.memberNew);

/** TEST-SLIM W4: 承認した登録のシナリオ（入力の規則を付けた版）と、実行の許可ごとの書き込みの開始の指定（値は本番の部品で生成）。 */
export interface ApprovedSpaCreate {
  readonly revision: ScenarioRevision;
  readonly writeFor: (grantId: string) => { readonly write: WorkerStartApiWrite; readonly values: Readonly<Record<string, string | null>> };
}

/**
 * TEST-SLIM W4: 自動の下書き（`spaCreateAutoDraftPlanOf` の `NEW`）に、承認の前の人の確かめ（副作用の確認）と照合の READ（`{id}` の型の画面。期待は
 * メールアドレス）を足して保存し、本番の推した入力の規則を付ける。書き込みの開始の指定は、本番の値の生成（許可ごとに別の seed）と `writeStartSpecOf` で作る。
 */
export const approveSpaCreateDraft = (
  database: ControlDatabase,
  options: {
    readonly site: SpaAuthSite;
    readonly profileId: string;
    readonly document: DiscoveryDocument;
    readonly plan: AutoDraftCreatePlan | undefined;
    readonly scenarioId: string;
    readonly readCheckId: string;
    readonly baseDate: string;
    readonly at: () => string;
  },
): ApprovedSpaCreate => {
  const { site, profileId, plan, scenarioId, readCheckId, at } = options;
  if (plan?.status !== 'NEW') throw new Error(`the automatic draft of the create page was not made: ${JSON.stringify(plan)}`);
  createSpaReadCheck(database, { site, profileId, readCheckId, targetPagePath: API_WRITE_READ_TEMPLATE_PATH, at: at() });
  const created = createScenario(database, {
    scenarioId,
    draft: {
      ...plan.draft,
      sideEffectConfirmations: ALL_CONFIRMED,
      verification: {
        resultJudgement: null, recordId: null,
        readVerification: { readCheckId, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] },
      },
    },
    discovery: options.document,
    at: at(),
  });
  if (!created.ok) throw new Error(`the scenario was not created: ${JSON.stringify(created)}`);
  const inferred = inferRuleSetContent(created.scenario.current, created.scenario.evidence);
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${scenarioId}`, scenarioId, expectedRevision: null, content: inferred.content, expectedScenarioRevision: created.scenario.revision, at: at(),
  });
  expect(saved.ruleSet).toMatchObject({ ok: true, evaluation: { executable: true } });
  if (saved.attachment === null || !saved.attachment.ok) throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  const attachedRevision = saved.attachment.scenario.revision;
  const stored = readScenarioRevisions(database, scenarioId).find(({ revision }) => revision === attachedRevision);
  const rules = readLatestRuleSet(database, scenarioId);
  const readCheck = listReadChecks(database, profileId).find((view) => view.readCheckId === readCheckId);
  if (stored === undefined || rules === null || readCheck === undefined) throw new Error('the scenario revision, the rules or the READ check is missing');
  return {
    revision: stored.scenario,
    writeFor: (grantId) => {
      const generated = generateScenarioData({
        ruleSet: rules.ruleSet,
        scenario: stored.scenario,
        candidate: stored.evidence,
        seedInput: { profileId, scenarioId, scenarioRevision: stored.revision, ruleSetDigest: computeRuleSetDigest(rules.ruleSet), executionGrantId: grantId },
        usedUniqueKeys: [],
        usedPhoneNumbers: [],
        baseDate: options.baseDate,
      });
      if (!generated.ok) throw new Error(`the values were not generated: ${JSON.stringify(generated.problems)}`);
      const spec = writeStartSpecOf({
        scenario: stored.scenario, evidence: stored.evidence, grantId, values: generated.values, readCheck,
        targetPage: { origin: site.appOrigin, path: API_WRITE_READ_TEMPLATE_PATH }, profileId, seedRecord: generated.seedRecord,
        approvalFacts: sampleApprovalFacts({ kind: 'CREATE', profileId, scenarioId, scenarioRevision: stored.revision, grantId }),
      });
      if (spec === null || !isWorkerStartApiWrite(spec)) throw new Error('the API write specification was not built');
      return { write: spec, values: generated.values };
    },
  };
};

/** TEST-SLIM W3・W4: 書き込みの流れの結果（書き込みの記録と、Guard の要約の送る中身の照合の理由ごとの数）。 */
export interface SpaApiWriteRun {
  readonly document: ActionRunDocument;
  readonly payloadBlocks: Readonly<Record<string, number>>;
}

/** 書き込みの流れの読み込みの最小の間隔（ms。ループバックの fixture なので短くする）と、押した後に結果を待つ上限（ms）。 */
const SPA_WRITE_NAVIGATION_INTERVAL_MS = 300;
const SPA_WRITE_RESULT_TIMEOUT_MS = 5_000;

/**
 * TEST-SLIM W3・W4: 同じ process の中の書き込みの流れ（`executeWriteCreateRun`。親の許可の確かめ直しは通す）を 1 回動かし、記録（スキーマに通る）を返す。
 * `sendPolicy` は監査の段の送信の扱い（省略はテストの設定の既定）。
 */
export const runSpaApiWrite = async (options: {
  readonly site: SpaAuthSite;
  readonly outputDirectory: string;
  readonly jobId: string;
  readonly write: WorkerStartApiWrite;
  readonly launchBrowser: () => Promise<Browser>;
  readonly login?: SpaRunLogin;
  readonly sendPolicy?: 'PASS_EXCEPT_DELETE';
}): Promise<SpaApiWriteRun> => {
  const outcome = await executeWriteCreateRun({
    config: spaApiWriteConfigOf(options.site, options.outputDirectory, {
      crawl: { minNavigationIntervalMs: SPA_WRITE_NAVIGATION_INTERVAL_MS },
      ...(options.sendPolicy === undefined ? {} : { audit: { sendPolicy: options.sendPolicy } }),
    }),
    jobId: options.jobId,
    authentication: spaRunAuthenticationOf(options.site, [], options.login),
    write: options.write,
    launchBrowser: options.launchBrowser,
    clock: () => new Date(),
    now: () => Date.now(),
    stopSignal: new AbortController().signal,
    recheck: () => Promise.resolve({ allowed: true }),
    reportSubmission: () => undefined,
    resultTimeoutMs: SPA_WRITE_RESULT_TIMEOUT_MS,
    observationWindows: TEST_OBSERVATION_WINDOWS,
  }, noObserver);
  if (outcome.kind !== 'RAN') throw new Error(`the write flow did not run: ${outcome.kind}`);
  const document = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_RUN_ARTIFACT_FILE_NAME), 'utf8')) as ActionRunDocument;
  expect(await validateArtifact('action-run', document)).toEqual({ ok: true });
  const evidence = JSON.parse(readFileSync(artifactFilePath(outcome.runDirectory, ACTION_EVIDENCE_ARTIFACT_FILE_NAME), 'utf8')) as {
    readonly guard?: { readonly blockedByPayloadReason?: Readonly<Record<string, number>> };
  };
  return { document, payloadBlocks: evidence.guard?.blockedByPayloadReason ?? {} };
};

/** 照合が止めた数の合計。 */
export const blockedPayloadCountOf = (blocks: Readonly<Record<string, number>>): number => Object.values(blocks).reduce((sum, count) => sum + count, 0);

/** サーバに届いた読み取りでない要求（事前確認を含む）の数。 */
export const spaNonReadCountOf = (site: SpaAuthSite): number =>
  site.requests.filter((request) => request.preflight || !READ_METHODS.has(request.method)).length;

/** サーバに届いた会員の API への `method` の要求（事前確認を除く。`since` 番目の記録から。`origin` は fixture の受け手の区分で絞る）の数。 */
export const spaMemberRequestCountOf = (site: SpaAuthSite, method: string, since = 0, origin?: string): number => site.requests.slice(since)
  .filter((request) => !request.preflight && request.method === method && request.path.startsWith(SPA_BACKEND_PATHS.members)
    && (origin === undefined || request.origin === origin)).length;

/** 全部の場面の後に、遅れて届く要求を見逃さないために待つ時間（ms）。 */
export const SPA_WRITE_LATE_DELIVERY_SETTLE_MS = 1_500;

/**
 * 遅れて届く要求を待ってから、`nonReadsBefore` の後に届いた読み取りでない要求が `expected` 件であることを確かめる。SLIM-2（X1）: 呼ぶのは、流れが Browser を
 * 閉じた後（全部の場面の後）だけなので、待ちはサーバが静まるまで（`SPA_WRITE_LATE_DELIVERY_SETTLE_MS` まで。`settleLateDeliveries`）。
 */
export const expectSettledSpaNonReads = async (site: SpaAuthSite, nonReadsBefore: number, expected: number): Promise<void> => {
  await settleLateDeliveries(SPA_WRITE_LATE_DELIVERY_SETTLE_MS, site);
  expect(spaNonReadCountOf(site) - nonReadsBefore, 'non-read requests that reached the server after the settle wait').toBe(expected);
};
