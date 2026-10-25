// T34c（Task 34 の設計書 3.3、3.4、3.5）: ワーカーのログインの段の、ログインの送り方ごとの部品（`src/worker/login-stage-checks.ts`）。
// - `loginStageGuardOf`: ログインの送り方（`loginTransportOf`）から、ログインの段の Guard の口（フォームの送信先か、スクリプトの口）を作る唯一の対応。
// - `loginStageAttemptsExceeded`: `SCRIPT_REQUEST` は monitor の「上限を超えて止めた token の送信の数」、`FORM_NAVIGATION` は今どおり Safety Ledger の
//   止めた送信先への POST で決める。
// - `hasSuccessStorageKey`: 成功のローカル ストレージの鍵の形（Origin、接頭辞、接尾辞。重ならない）に当たる鍵の名前があるか（値は見ない）。
// - `scriptLoginCountsOf`: IPC に載せる数（`SCRIPT_REQUEST` だけ）。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { describe, expect, it } from 'vitest';
import {  AUTH_SETUP_SCHEMA_VERSION_3,
  type AuthSetup,
  type AuthSetupV3,
} from '../../src/control/auth/auth-setup-contracts.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthenticatedState } from '../../src/control/auth/authenticated-state.js';
import { WORKER_SCRIPT_LOGIN_BLOCK_REASONS } from '../../src/control/worker-protocol.js';
import { LoginStageMonitor } from '../../src/safety/passive-request-guard.js';
import { canonicalPassiveAllowedOrigins } from '../../src/safety/request-policy.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import {
  hasSuccessStorageKey,
  loginStageAttemptsExceeded,
  loginStageGuardOf,
  scriptLoginCountsOf,
} from '../../src/worker/login-stage-checks.js';

const ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
const ALLOWED = canonicalPassiveAllowedOrigins(new Set([ORIGIN]));

const FORM_V2: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-auth',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: [],
  auditPathPrefixes: [],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});
const FORM_V3: AuthSetupV3 = Object.freeze({
  ...FORM_V2,
  schemaVersion: AUTH_SETUP_SCHEMA_VERSION_3,
  loginTransport: 'FORM_NAVIGATION',
  scriptLogin: null,
  loginSideRequests: [],
  successStorageKey: null,
});
const SCRIPT_V3: AuthSetupV3 = Object.freeze({
  ...FORM_V3,
  loginPostEndpoints: [],
  loginTransport: 'SCRIPT_REQUEST',
  scriptLogin: { origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  loginSideRequests: [{ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/resolve', method: 'POST' as const, maxPerLoginStage: 2 }],
  successStorageKey: { origin: ORIGIN, prefix: 'sb-', suffix: '-auth-token' },
});

const stateWith = (origin: string, names: readonly string[]): AuthenticatedState => ({
  cookies: [],
  origins: [{ origin, localStorage: names.map((name) => ({ name, value: 'v' })) }],
});

describe('T34c: the login stage parts for each login transport', () => {
  it('maps the form navigation login (version 2 and 3) to the login POST endpoints only', () => {
    expect(loginStageGuardOf(FORM_V2, [SERVICE_ORIGIN])).toEqual({ loginPostEndpoints: FORM_V2.loginPostEndpoints });
    expect(loginStageGuardOf(FORM_V3, [])).toEqual({ loginPostEndpoints: FORM_V3.loginPostEndpoints });
  });

  it('maps the script login to the script login stage of the Guard with the approved service origins', () => {
    expect(loginStageGuardOf(SCRIPT_V3, [SERVICE_ORIGIN])).toEqual({
      loginPostEndpoints: [],
      scriptRequest: {
        scriptLogin: SCRIPT_V3.scriptLogin,
        loginSideRequests: SCRIPT_V3.loginSideRequests,
        approvedServiceOrigins: [SERVICE_ORIGIN],
      },
    });
  });

  it('gives no send allowance to a script login setup without a script target, only the service origins for the manual stage reads (T44R M-1)', () => {
    // 送信先は空のまま（自動ログインの段は factory が Context を作らない）。承認したサービスの Origin は、手動のログインの段だけが Guard に渡す。
    expect(loginStageGuardOf({ ...SCRIPT_V3, scriptLogin: null }, [SERVICE_ORIGIN]))
      .toEqual({ loginPostEndpoints: [], manualServiceReadOrigins: [SERVICE_ORIGIN] });
  });

  it('counts the script login attempts over the limit from the monitor, and the form login from the ledger', () => {
    const ledger = new SafetyLedger();
    const monitor = new LoginStageMonitor();
    ledger.recordBlockedRequest({ method: 'POST', url: `${ORIGIN}/login`, reason: 'NON_READ_METHOD', resourceType: 'document', phase: 'LOAD' });
    // フォームの送信のログインは、今どおり Ledger の止めた送信先への POST で決める。
    expect(loginStageAttemptsExceeded(ledger, monitor, ALLOWED, FORM_V2)).toBe(true);
    expect(loginStageAttemptsExceeded(ledger, monitor, ALLOWED, FORM_V3)).toBe(true);
    // スクリプトで送るログインは、Ledger を読み直さない（上限を超えて止めた token の送信がなければ偽）。
    expect(loginStageAttemptsExceeded(ledger, monitor, ALLOWED, SCRIPT_V3)).toBe(false);
    expect(loginStageAttemptsExceeded(new SafetyLedger(), monitor, ALLOWED, FORM_V2)).toBe(false);
  });

  it('finds the success storage key by its name shape on its origin only (no overlap of the prefix and the suffix)', () => {
    const key = { origin: ORIGIN, prefix: 'sb-', suffix: '-auth-token' };
    expect(hasSuccessStorageKey(stateWith(ORIGIN, ['sb-abc-auth-token']), key)).toBe(true);
    expect(hasSuccessStorageKey(stateWith(ORIGIN, ['other', 'sb-x-auth-token']), key)).toBe(true);
    expect(hasSuccessStorageKey(stateWith(SERVICE_ORIGIN, ['sb-abc-auth-token']), key)).toBe(false);
    expect(hasSuccessStorageKey(stateWith(ORIGIN, ['sb-abc-auth-tokens', 'xsb-abc-auth-token']), key)).toBe(false);
    // 接頭辞と接尾辞が重なる名前（`sb-` と `-auth-token` が `-` を共有する）は当たらない。
    expect(hasSuccessStorageKey(stateWith(ORIGIN, ['sb-auth-token']), key)).toBe(false);
    expect(hasSuccessStorageKey(stateWith(ORIGIN, ['sb--auth-token']), key)).toBe(true);
    expect(hasSuccessStorageKey(stateWith(ORIGIN, ['sb-uth-token']), { ...key, suffix: 'b-uth-token' })).toBe(false);
    expect(hasSuccessStorageKey(stateWith(ORIGIN, ['session']), { origin: ORIGIN, prefix: '', suffix: 'session' })).toBe(true);
    expect(hasSuccessStorageKey({ cookies: [], origins: [] }, key)).toBe(false);
  });

  it('gives the IPC counts of the script login only', () => {
    const monitor = new LoginStageMonitor();
    expect(scriptLoginCountsOf(monitor, FORM_V2)).toBeUndefined();
    expect(scriptLoginCountsOf(monitor, SCRIPT_V3)).toEqual({
      tokenRequestsAllowed: 0,
      sideRequestsAllowed: [],
      serviceOriginReads: 0,
      blockedByReason: Object.fromEntries(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [reason, 0])),
    });
  });
});
