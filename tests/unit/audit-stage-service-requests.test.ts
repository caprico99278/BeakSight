// T35a（Task 35 の設計書 3.2 の受け渡し）: 監査の段の口（`auditStage`。承認したサービスの Origin、読み取りの手続きの呼び出し、token の送信先）の受け渡しの
// 経路。この段では、Guard の判定（T35b）と Run の流れ（T35c）は作らず、値が届くことまでを確かめる。
// - ワーカーが START の認証の指定から作る（`auditStageOf`）: `SCRIPT_REQUEST` の設定だけ。`FORM_NAVIGATION` は `undefined`（今の振る舞いのまま。LG-3b: 版 2 は捨てた）。
//   読み取りの手続きの呼び出しがなければ空。
// - LZ-3c: 要求の上限（前は `serviceRequestLimits`。既定は `defaultServiceRequestLimitsFor`）は口に持たない。前に保存した設定の上限の項目は、受けて使わない。
// - `RunAuthentication` → factory の指定（`authenticatedContextOptions`）へ写す。口がなければ項目を付けない。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import type { AuthSetupV3 } from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import { filterAuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import type { WorkerStartAuthentication } from '../../src/control/worker-protocol.js';
import { authenticatedContextOptions, type RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { auditStageOf } from '../../src/worker/audit-stage-requests.js';

const ORIGIN = 'http://127.0.0.1:4173';
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
    expect(auditStageOf(authenticationOf(FORM_BASE))).toBeUndefined();
    expect(auditStageOf(authenticationOf(FORM_V3, [SERVICE_ORIGIN]))).toBeUndefined();
  });

  it('gives the service origins, the token target and no read request to a script login setup without the items', () => {
    expect(auditStageOf(authenticationOf(SCRIPT_V3, [SERVICE_ORIGIN]))).toEqual({
      approvedServiceOrigins: [SERVICE_ORIGIN],
      auditReadRequests: [],
      scriptLogin: SCRIPT_V3.scriptLogin,
    });
  });

  // LZ-3c: 前に保存した設定の上限の項目（`serviceRequestLimits`）は受けて、口には写さない（上限の値は Guard へもワーカーへも渡らない）。
  it('copies the read requests of the setup, and no request limits even when the setup has the former item (LZ-3c)', () => {
    const setup: AuthSetupV3 = { ...SCRIPT_V3, auditReadRequests: [READ], serviceRequestLimits: { perMinute: 30, perRun: 90 } };
    const stage = auditStageOf(authenticationOf(setup, [SERVICE_ORIGIN]));
    expect(stage).toEqual({
      approvedServiceOrigins: [SERVICE_ORIGIN],
      auditReadRequests: [READ],
      scriptLogin: SCRIPT_V3.scriptLogin,
    });
    expect(Object.isFrozen(stage)).toBe(true);
  });
});

describe('T35a: the audit stage passes to the factory options', () => {
  it('copies the audit stage to the factory options, and adds no item without it', () => {
    const stage = auditStageOf(authenticationOf({ ...SCRIPT_V3, auditReadRequests: [READ] }, [SERVICE_ORIGIN]));
    expect(authenticatedContextOptions(runAuthentication(stage)).auditStage).toEqual(stage);
    expect(authenticatedContextOptions(runAuthentication())).not.toHaveProperty('auditStage');
  });
});
