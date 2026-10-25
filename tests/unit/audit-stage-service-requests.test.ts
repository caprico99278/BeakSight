// T35a（Task 35 の設計書 3.2 の受け渡し）: 監査の段の口（`auditStage`。承認したサービスの Origin、読み取りの手続きの呼び出し、token の送信先、要求の
// 上限）の受け渡しの経路。この段では、Guard の判定（T35b）と Run の流れ（T35c）は作らず、値が届くことまでを確かめる。
// - ワーカーが START の認証の指定から作る（`auditStageOf`）: `SCRIPT_REQUEST` の設定だけ。`FORM_NAVIGATION` は `undefined`（今の振る舞いのまま。LG-3b: 版 2 は捨てた）。
//   要求の上限がなければ上限の値（`DEFAULT_SERVICE_REQUEST_LIMITS`）、読み取りの手続きの呼び出しがなければ空。
// - `RunAuthentication` → factory の指定（`authenticatedContextOptions`）へ写す。口がなければ項目を付けない。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import {
  DEFAULT_SERVICE_REQUEST_LIMITS,
  MAX_SERVICE_REQUESTS_PER_RUN,
  SERVICE_REQUESTS_PER_PAGE_ALLOWANCE,
  defaultServiceRequestLimitsFor,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { MAX_CRAWL_MAX_PAGES } from '../../src/core/limits.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartAuthentication } from '../../src/control/worker-protocol.js';
import { authenticatedContextOptions, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { auditStageOf } from '../../src/worker/audit-stage-requests.js';

const ORIGIN = 'http://127.0.0.1:4173';
/** T44f: ページの上限（既定の上限 `MAX_SERVICE_REQUESTS_PER_RUN` より小さい値になる、小さい上限）。 */
const SMALL_MAX_PAGES = 3;
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';

/** フォームの送信のログインの設定（LG-3b: 前は版 2 の文書だった）。 */
const FORM_BASE: AuthSetupV3 = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-auth',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 1,
  allowedIdpOrigins: [],
  automatedLogin: null,
});
const SCRIPT_V3: AuthSetupV3 = Object.freeze({
  ...FORM_BASE,
  loginPostEndpoints: [],
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [],
  successStorageKey: { origin: ORIGIN, prefix: 'app-', suffix: '-auth-token' },
});
const FORM_V3: AuthSetupV3 = Object.freeze({
  ...SCRIPT_V3,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  loginTransport: 'FORM_NAVIGATION',
  scriptLogin: null,
  successStorageKey: null,
});
const READ = Object.freeze({ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/list_members', method: 'POST', maxPerPageLoad: 2 } as const);

const authenticationOf = (setup: WorkerStartAuthentication['setup'], services?: readonly string[]): WorkerStartAuthentication => ({
  setup,
  approvedTestOrigins: [ORIGIN],
  ...(services === undefined ? {} : { approvedServiceOrigins: services }),
  authenticationSha256: '0'.repeat(64),
});

const runAuthentication = (auditStage?: RunAuthentication['auditStage']): RunAuthentication => ({
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: [ORIGIN],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
  sessionLostPathPrefix: '/login',
  filterState: filterAuthenticatedState,
  ...(auditStage === undefined ? {} : { auditStage }),
});

describe('T35a: the audit stage of a script login Run from START', () => {
  it('gives no audit stage to a form navigation setup (version 2 and version 3)', () => {
    expect(auditStageOf(authenticationOf(FORM_BASE), SMALL_MAX_PAGES)).toBeUndefined();
    expect(auditStageOf(authenticationOf(FORM_V3, [SERVICE_ORIGIN]), SMALL_MAX_PAGES)).toBeUndefined();
  });

  it('gives the service origins, the token target, no read request and the default limits to a script login setup without the items', () => {
    expect(auditStageOf(authenticationOf(SCRIPT_V3, [SERVICE_ORIGIN]), SMALL_MAX_PAGES)).toEqual({
      approvedServiceOrigins: [SERVICE_ORIGIN],
      auditReadRequests: [],
      scriptLogin: SCRIPT_V3.scriptLogin,
      serviceRequestLimits: DEFAULT_SERVICE_REQUEST_LIMITS,
    });
  });

  it('copies the read requests and the limits of the setup', () => {
    const setup: AuthSetupV3 = { ...SCRIPT_V3, auditReadRequests: [READ], serviceRequestLimits: { perMinute: 30, perRun: 90 } };
    const stage = auditStageOf(authenticationOf(setup, [SERVICE_ORIGIN]), SMALL_MAX_PAGES);
    expect(stage).toEqual({
      approvedServiceOrigins: [SERVICE_ORIGIN],
      auditReadRequests: [READ],
      scriptLogin: SCRIPT_V3.scriptLogin,
      serviceRequestLimits: { perMinute: 30, perRun: 90 },
    });
    expect(Object.isFrozen(stage)).toBe(true);
  });
});

// T44f（Task 44 の設計書 P3-3。設計者の判断の案 (a)）: 上限の欄が空のときの、1 回の Run あたりの上限の既定は、ページの上限に比べた値
// （`max(MAX_SERVICE_REQUESTS_PER_RUN, ページの上限 × SERVICE_REQUESTS_PER_PAGE_ALLOWANCE)`）。1 分あたりの上限は変えない。設定に書いた値は、そのまま使う。
describe('T44f: the default limit per Run follows the page limit', () => {
  it('takes the larger of the default and the page limit times the named allowance per page, and keeps the limit per minute', () => {
    expect(SERVICE_REQUESTS_PER_PAGE_ALLOWANCE).toBe(200);
    const perRunOf = (maxPages: number): number | undefined => auditStageOf(authenticationOf(SCRIPT_V3, [SERVICE_ORIGIN]), maxPages)?.serviceRequestLimits.perRun;
    expect(perRunOf(3)).toBe(MAX_SERVICE_REQUESTS_PER_RUN);
    expect(perRunOf(50)).toBe(MAX_SERVICE_REQUESTS_PER_RUN);
    expect(perRunOf(51)).toBe(51 * SERVICE_REQUESTS_PER_PAGE_ALLOWANCE);
    expect(perRunOf(140)).toBe(28_000);
    expect(perRunOf(500)).toBe(100_000);
    expect(auditStageOf(authenticationOf(SCRIPT_V3, [SERVICE_ORIGIN]), 500)?.serviceRequestLimits.perMinute).toBe(DEFAULT_SERVICE_REQUEST_LIMITS.perMinute);
    expect(defaultServiceRequestLimitsFor(140)).toEqual({ perMinute: DEFAULT_SERVICE_REQUEST_LIMITS.perMinute, perRun: 28_000 });
  });

  // T44R（Task 44 のレビューの M-3）: ページの上限の上限（`MAX_CRAWL_MAX_PAGES`）でも、1 回の Run の上限は安全な整数。上限を超える値は上限として数える。
  it('keeps the per run limit a safe integer at the page limit bound, and counts a larger value as the bound (T44R M-3)', () => {
    const atBound = defaultServiceRequestLimitsFor(MAX_CRAWL_MAX_PAGES).perRun;
    expect(atBound).toBe(MAX_CRAWL_MAX_PAGES * SERVICE_REQUESTS_PER_PAGE_ALLOWANCE);
    expect(Number.isSafeInteger(atBound)).toBe(true);
    expect(defaultServiceRequestLimitsFor(Number.MAX_SAFE_INTEGER).perRun).toBe(atBound);
  });

  it('uses the values written in the setup as they are, whatever the page limit', () => {
    const setup: AuthSetupV3 = { ...SCRIPT_V3, serviceRequestLimits: { perMinute: 30, perRun: 90 } };
    expect(auditStageOf(authenticationOf(setup, [SERVICE_ORIGIN]), 500)?.serviceRequestLimits).toEqual({ perMinute: 30, perRun: 90 });
  });
});

describe('T35a: the audit stage passes to the factory options', () => {
  it('copies the audit stage to the factory options, and adds no item without it', () => {
    const stage = auditStageOf(authenticationOf({ ...SCRIPT_V3, auditReadRequests: [READ] }, [SERVICE_ORIGIN]), SMALL_MAX_PAGES);
    expect(authenticatedContextOptions(runAuthentication(stage)).auditStage).toEqual(stage);
    expect(authenticatedContextOptions(runAuthentication())).not.toHaveProperty('auditStage');
  });
});
