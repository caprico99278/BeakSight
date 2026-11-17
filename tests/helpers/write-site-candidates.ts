/**
 * 書き込みの fixture のサイト（`write-site-fixture.ts`）を、同じ process の中の書き込みの流れで使う準備の共通（`write-create-run.test.ts`・
 * `write-stage-parent-spec.test.ts`・`write-job-harness.ts`）。
 * - `writeSiteRunAuthenticationOf`: fixture が作ったセッションを入れた、認証つきの Run の指定（ログインの段を通さない）。
 * - `readWriteSiteCandidates`: 本物の発見の入口（`readCandidatePage`）で、登録の画面・一覧の検索・任意の欄のある登録の画面の候補を読む（承認に縛る digest を
 *   手で書かない）。
 * - `writeSiteAuthSetupOf`: このサイトの手動のログインの認証の設定。
 * - 承認までの準備: 照合の READ（`createWriteSiteReadCheck`）、CREATE の下書き（`writeSiteCreateDraftOf`）、規則を付けて承認（`attachNameRulesAndApprove`）。
 */
import type { Browser } from 'playwright';
import { BrowserContextFactory } from '../../src/browser/context-factory.js';
import type { AuditConfig } from '../../src/config/types.js';
import type { ScenarioLimits } from '../../src/control/approval/scenario-contracts.js';
import type { ScenarioDraftInput } from '../../src/control/approval/scenario-policy.js';
import {
  approveScenario,
  readScenarioApprovalStatus,
  type ApprovalExternalFacts,
  type ScenarioStoreResult,
} from '../../src/control/approval/scenario-store.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { MIN_PROFILE_REVISION } from '../../src/control/contracts.js';
import { saveRuleSetAndAttach } from '../../src/control/data-rules/rule-store.js';
import { createReadCheck } from '../../src/control/job/read-check-store.js';
import { validateReadCheckDefinition } from '../../src/control/read-check-policy.js';
import type { ControlDatabase } from '../../src/control/store/control-database.js';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { readCandidatePage } from '../../src/discovery/read-executor.js';
import { InFlightRequestCounter } from '../../src/discovery/settle.js';
import { authenticatedContextOptions, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { ALL_CONFIRMED } from '../unit/approval-samples.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from './auth-setup-samples.js';
import { TEST_FACTORY_OPTIONS } from './test-config.js';
import { WRITE_JOB_READ_CHECK_ID, WRITE_JOB_VERIFICATION, WRITE_SITE_PATHS, WRITE_SITE_SESSION_COOKIE } from './write-site-fixture.js';

const VIEWPORT = Object.freeze({ width: 1280, height: 800 });

/** fixture が作ったセッション（`issueSession` の値）を入れた、認証つきの Run の指定。 */
export const writeSiteRunAuthenticationOf = (origin: string, sessionValue: string): RunAuthentication => ({
  initialState: {
    cookies: [{
      name: WRITE_SITE_SESSION_COOKIE, value: sessionValue, domain: new URL(origin).hostname, path: '/', expires: -1, httpOnly: true,
      secure: false, sameSite: 'Lax',
    }],
    origins: [],
  },
  approvedTestOrigins: [origin],
  auditExclusions: { excludedPathPrefixes: ['/logout'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: WRITE_SITE_PATHS.login,
  filterState: filterAuthenticatedState,
});

/** 読んだ候補（登録の画面・一覧の検索・任意の欄のある登録の画面）。 */
export interface WriteSiteCandidates {
  readonly form: DiscoveryCandidate;
  readonly search: DiscoveryCandidate;
  readonly optional: DiscoveryCandidate;
}

/** 本物の発見の入口で、このサイトの候補を読む。 */
export async function readWriteSiteCandidates(browser: Browser, config: AuditConfig, authentication: RunAuthentication): Promise<WriteSiteCandidates> {
  const origin = new URL(config.site.startUrl).origin;
  const factory = new BrowserContextFactory(browser, config, () => new SafetyLedger(), {
    ...TEST_FACTORY_OPTIONS, authentication: authenticatedContextOptions(authentication),
  });
  const read = async (path: string): Promise<readonly DiscoveryCandidate[]> => {
    const context = await factory.createPassiveContext(VIEWPORT);
    const page = await factory.createPassivePage(context);
    const counter = new InFlightRequestCounter(page);
    await page.goto(`${origin}${path}`);
    const candidates = await readCandidatePage(page, { classificationPolicy: { allowedOrigins: new Set([origin]) }, requestCounter: counter });
    counter.dispose();
    await factory.closePassiveContext(context);
    return candidates.candidates;
  };
  const isCreate = (candidate: DiscoveryCandidate): boolean => candidate.formMethod === 'POST' && candidate.action?.path === WRITE_SITE_PATHS.create;
  const form = (await read(WRITE_SITE_PATHS.form)).find(isCreate);
  const search = (await read(WRITE_SITE_PATHS.list)).find((candidate) => candidate.formMethod === 'GET' && candidate.classification === 'READ');
  const optional = (await read(WRITE_SITE_PATHS.optionalForm)).find(isCreate);
  await factory.close();
  if (form === undefined || search === undefined || optional === undefined) {
    throw new Error('the fixture candidates were not found');
  }
  return { form, search, optional };
}

/** 一覧の検索の候補から、照合の READ の定義（`WRITE_JOB_READ_CHECK_ID`）を作る。 */
export const createWriteSiteReadCheck = (database: ControlDatabase, profileId: string, search: DiscoveryCandidate, at: string): void => {
  const checked = validateReadCheckDefinition({
    targetIdentityDigest: search.identityDigest, parameters: { q: 'x' }, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }],
  }, search);
  if (!checked.ok) {
    throw new Error(`the READ check was rejected: ${JSON.stringify(checked.errors)}`);
  }
  const created = createReadCheck(database, { readCheckId: WRITE_JOB_READ_CHECK_ID, profileId, definition: checked.definition, at });
  if (!created.ok) {
    throw new Error(`the READ check was not created: ${created.reason}`);
  }
};

/** 登録の画面の候補から作る CREATE のシナリオの下書き（送る欄は `name`・`email`・`newsletter`、検証は `WRITE_JOB_VERIFICATION`）。 */
export const writeSiteCreateDraftOf = (
  profileId: string,
  form: DiscoveryCandidate,
  limits: ScenarioLimits = { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
): ScenarioDraftInput => ({
  profileId,
  candidateIdentityDigest: form.identityDigest,
  fieldNames: ['name', 'email', 'newsletter'],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits,
  approvalTtlDays: 30,
  verification: WRITE_JOB_VERIFICATION,
});

/** 作ったシナリオに、変える欄 `name` の人の固定の値の規則を付け、渡された本物の事実で承認する。 */
export const attachNameRulesAndApprove = (database: ControlDatabase, created: ScenarioStoreResult, input: {
  readonly scenarioId: string;
  readonly names: readonly string[];
  readonly facts: ApprovalExternalFacts;
  readonly now: Date;
  readonly at: string;
}): void => {
  if (!created.ok) {
    throw new Error(`the scenario was not created: ${created.reason}`);
  }
  const saved = saveRuleSetAndAttach(database, {
    ruleSetId: `rules-${input.scenarioId}`, scenarioId: input.scenarioId, expectedRevision: null, expectedScenarioRevision: created.scenario.revision, at: input.at,
    content: {
      fieldRules: [{ fieldName: 'name', semanticKind: 'FIXED_LIST', method: 'FROM_FIXED_LIST', range: null, fixedValues: [...input.names] }],
      relations: [],
      uniqueKeyFieldNames: ['name'],
    },
  });
  if (saved.attachment === null || !saved.attachment.ok) {
    throw new Error(`the input rules were not attached: ${JSON.stringify(saved)}`);
  }
  const status = readScenarioApprovalStatus(database, input.scenarioId, input.facts, input.now);
  const approved = approveScenario(database, {
    scenarioId: input.scenarioId, expectedRevision: saved.attachment.scenario.revision, expectedApprovalDigest: status?.approvalDigest ?? '',
    receiptId: `receipt-${input.scenarioId}`, external: input.facts, at: input.at,
  });
  if (!approved.ok) {
    throw new Error(`the scenario was not approved: ${approved.reason} ${JSON.stringify(status)}`);
  }
};

/** このサイトの手動のログインの認証の設定（最初の改訂のプロファイル）。 */
export const writeSiteAuthSetupOf = (profileId: string, origin: string): AuthSetup => ({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId,
  profileRevision: MIN_PROFILE_REVISION,
  loginStartUrl: `${origin}${WRITE_SITE_PATHS.login}`,
  loginPostEndpoints: [{ origin, path: WRITE_SITE_PATHS.login }],
  successCondition: { pathPrefix: WRITE_SITE_PATHS.list, selector: '#search' },
  sessionLostCondition: { pathPrefix: WRITE_SITE_PATHS.login },
  excludedPaths: ['/logout'],
  auditPathPrefixes: [WRITE_SITE_PATHS.list],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});
