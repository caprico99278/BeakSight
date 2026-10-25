// T40b-1（Task 40 の設計書 3.3、5 章）: SPA の fixture（`startSpaAuthSite` の form のない会員の画面）の API の登録のシナリオを、本番の部品の公開の口だけで
// 作る共通の準備（テストの補助。テストのファイルではない）。本物のワーカーのジョブの結合（`write-job-api-start.test.ts`）と、同じ process の中の書き込みの
// 流れの結合（`api-write-create-run.test.ts`）が使う。T41d・T41d-2: API の更新のシナリオ（`createApiUpdateScenario`）も作り、同じ process の中の更新の
// 流れ（`api-write-update-run.test.ts`）と本物のワーカーの更新のジョブ（`write-job-api-update.test.ts`）が使う。承認に縛る digest と API の指定を手で書かない。
// - 発見は本物の流れ（`executeDiscoveryRun`。認証つきの factory と Guard、送らずに観察する probe）。ログインの段は通さず、fixture が出したセッションを
//   認証つきの Run の指定（メモリの状態）で渡す（`spaRunAuthenticationOf`。同じ指定を、同じ process の中の書き込みの流れにも渡す）。
// - 管理データ: 発見のジョブの行と候補の索引、照合の READ（`{id}` の型の画面の READ）、API のシナリオ（送る鍵は欄に対応する鍵、ID は応答の本文の鍵
//   `id`）、入力の規則（テンプレートの空の規則）。承認と許可は、呼ぶ側が行う。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import type { AuditConfig } from '../../src/config/types.js';
import { createScenario, type ScenarioStoreResult } from '../../src/control/approval/scenario-store.js';
import type { ScenarioLimits } from '../../src/control/approval/scenario-contracts.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { discoveryIndexEntryOf, recordDiscoveryCandidates } from '../../src/control/job/discovery-index-store.js';
import { createStartingJob, recordLoginCheckFinished } from '../../src/control/job/job-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import type { ControlDatabase } from '../../src/control/store/control-database.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { discoveryCandidatesOf, discoveryReadPagePaths, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { submissionProbeKeyFieldsOf } from '../../src/discovery/submission-probe-contracts.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { executeDiscoveryRun } from '../../src/worker/discovery-run.js';
import { hasSuccessStorageKey } from '../../src/worker/login-stage-checks.js';
import { ALL_CONFIRMED } from '../unit/approval-samples.js';
import { fastRunConfig } from './run-harness.js';
import { SPA_APP_PATHS, SPA_AUTH_STORAGE_KEY, SPA_BACKEND_PATHS, SPA_GRANT_TYPES, type SpaAuthSite } from './spa-auth-site-fixture.js';

/** 承認したサービスの Origin への要求の上限（設定の上限の値）。 */
export const API_WRITE_SERVICE_REQUEST_LIMITS = Object.freeze({ perMinute: 120, perRun: 600 });
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
export const spaRunAuthenticationOf = (site: SpaAuthSite, extraExcludedPathPrefixes: readonly string[] = []): RunAuthentication => ({
  initialState: { cookies: [], origins: [{ origin: site.appOrigin, localStorage: [{ name: SPA_AUTH_STORAGE_KEY, value: site.issueStoredSession() }] }] },
  approvedTestOrigins: [site.appOrigin],
  auditExclusions: {
    excludedPathPrefixes: [SPA_APP_PATHS.logout, ...extraExcludedPathPrefixes], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS,
  },
  sessionLostPathPrefix: SPA_APP_PATHS.auth,
  filterState: filterAuthenticatedState,
  auditStage: {
    approvedServiceOrigins: [site.backendOrigin],
    auditReadRequests: [],
    scriptLogin: { origin: site.tokenOrigin, path: SPA_BACKEND_PATHS.token, requiredQuery: [{ name: 'grant_type', value: SPA_GRANT_TYPES.password }] },
    serviceRequestLimits: API_WRITE_SERVICE_REQUEST_LIMITS,
  },
  sessionKeyPresent: (state) => hasSuccessStorageKey(state, { origin: site.appOrigin, ...API_WRITE_FIXTURE_SESSION_KEY }),
});

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
  options: { readonly jobId?: string } = {},
): Promise<DiscoveryDocument> => {
  const outcome = await executeDiscoveryRun({
    config: spaApiWriteConfigOf(site, outputDirectory),
    jobId: options.jobId ?? DEFAULT_SPA_DISCOVERY_JOB_ID,
    authentication: spaRunAuthenticationOf(site),
    launchBrowser,
    clock: () => new Date(), now: () => Date.now(), stopSignal: new AbortController().signal, submissionProbeQuietWaitMs: SHORT_QUIET_WAIT_MS,
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
          successCondition: null,
          inputErrorCondition: null,
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
}

/**
 * 発見のジョブの行と候補の索引、照合の READ（`{id}` の型の画面）、API の登録のシナリオ（登録の画面の保存のボタン）と入力の規則（テンプレート）を作る。
 * 作ったシナリオ（規則を付けた版）を返す。プロファイルと認証の設定は、呼ぶ側が先に作る。
 */
export const createApiCreateScenario = (database: ControlDatabase, options: ApiCreateScenarioOptions): Extract<ScenarioStoreResult, { readonly ok: true }> => {
  const { profileId, scenarioId, readCheckId, site, document, at } = options;
  const create = saveButtonOf(document, SPA_APP_PATHS.memberNew);
  expect(create.submissionProbe?.result).toBe('API_CREATE');
  const discoveredAt = at();
  expect(createStartingJob(database, {
    jobId: document.jobId, jobKind: 'DISCOVERY', profileId, profileRevision: MIN_PROFILE_REVISION, startNew: true, createdAt: discoveredAt,
  }, () => null)).toEqual({ ok: true });
  expect(recordLoginCheckFinished(database, document.jobId, 0, discoveredAt)).toBe(true);
  recordDiscoveryCandidates(database, {
    profileId, jobId: document.jobId, at: discoveredAt,
    entries: mergeDiscoveryCandidates(discoveryCandidatesOf(document)).map(discoveryIndexEntryOf), readPagePaths: discoveryReadPagePaths(document),
  });
  // 照合の READ: `{id}` の型の画面の READ（画面の文脈で確かめる）。
  const checked = validateReadCheckDefinition({ targetPagePath: API_WRITE_READ_TEMPLATE_PATH, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] }, null, {
    startUrl: `${site.appOrigin}${SPA_APP_PATHS.admin}`,
    allowedOrigins: [site.appOrigin],
    approvedTestOrigins: [site.appOrigin],
    excludedPathPrefixes: [SPA_APP_PATHS.logout],
    auditPathPrefixes: [SPA_APP_PATHS.admin],
    sessionLostPathPrefix: SPA_APP_PATHS.auth,
  });
  if (!checked.ok) throw new Error(`the READ check was rejected: ${JSON.stringify(checked.errors)}`);
  expect(createReadCheck(database, { readCheckId, profileId, definition: checked.definition, at: at() }).ok).toBe(true);
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
        successCondition: null,
        inputErrorCondition: null,
        recordId: null,
        readVerification: { readCheckId, revision: 1, bindings: [], expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'email' }] },
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
