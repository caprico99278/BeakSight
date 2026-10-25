// T34c（Task 34 の設計書 3.4、3.5）: スクリプトで送るログインの IPC の契約（`src/control/worker-protocol.ts`、`schemas/control/worker-message.schema.json`）。
// - `AUTH_STATE` の任意の項目 `scriptLogin`: ログインの段の結果の数だけ（通した token の送信、通したログインに伴う送信（項目ごと）、サービスの Origin
//   への読み取り、止めた要求の理由ごとの数）。URL・本文・値は持たない。ログインの段の結果の状態（`AUTHENTICATED` とログインの段の失敗）だけが持て、
//   自動ログインの結果と一緒には持てない。
// - T36c（Task 36 の設計書 3.4。設計者の判断 1）: 止めた理由に `LOGIN_CREDENTIAL_IN_REQUEST`（自動ログインで、資格情報を含む要求を止めた数）を足した。
//   スクリプトで送る自動ログインの結果（`AUTHENTICATED`・`UNSUPPORTED_AUTH_STATE`・`AUTOMATED_LOGIN_FAILED`）も、自動ログインの結果と一緒に数と一覧を
//   持てる（T34c の拒む期待を、意図して直した）。
// - T36R-fix（T36R の M-3。意図して直した期待）: 動いている IPC では、この鍵も必須（T36c は任意にしていた）。版 11 の管理データの、T36c の前の行（鍵がない）は、
//   ジョブの記録の読む口が 0 として読む（`control-store-job-summaries.test.ts`）。
// - `START` の SHA-256（`workerAuthenticationDigestOf`）: プロファイルの承認したサービスの Origin を、項目があるときだけ入れる（版 2 と、サービスの
//   Origin のないプロファイルの値は変わらない）。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import {MAX_LOGIN_SIDE_REQUESTS, type AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  WORKER_AUTH_STATES,
  WORKER_LOGIN_FAILURE_STATES,
  WORKER_PROTOCOL_VERSION,
  WORKER_AUTOMATED_LOGIN_FAILED_STATE,
  WORKER_LOGIN_CREDENTIAL_BLOCK_REASON,
  WORKER_SCRIPT_LOGIN_BLOCK_REASONS,
  WORKER_STOPPED_LOGIN_STAGE_STATE,
  validateWorkerToParentMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';

const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as Record<string, unknown>;

const pointerValue = (document: unknown, pointer: string): unknown =>
  pointer.split('/').slice(1).reduce<unknown>((value, key) =>
    (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), document);

const ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';
const OTHER_SERVICE_ORIGIN = 'http://127.0.0.1:6173';

/** 版 2 の設定（`worker-protocol-auth.test.ts` の値と同じ。版 3 を足す前の SHA-256 を固定する）。 */
const SETUP: AuthSetup = Object.freeze({
  ...FORM_NAVIGATION_SETUP_ITEMS,
  profileId: 'example-auth',
  profileRevision: 1,
  loginStartUrl: `${ORIGIN}/login`,
  loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
  successCondition: { pathPrefix: '/admin', selector: null },
  sessionLostCondition: { pathPrefix: null },
  excludedPaths: ['/admin/logout'],
  auditPathPrefixes: ['/admin'],
  maxLoginAttempts: 2,
  allowedIdpOrigins: [],
  automatedLogin: null,
});
/** フォームの送信の設定の SHA-256（`worker-protocol-auth.test.ts` の T34a の値。LG-3b: 見本を版 2 から版 3 に替えた後の値）。 */
const FORM_DIGEST = '807fe35d8ebbf8494ab8fc64d1de267a97581fbb74501ddf8796a35f26345678';
const MANUAL_BINDING = Object.freeze({ jobKind: 'AUDIT', automatedLogin: null } as const);

const COUNTS = Object.freeze({
  tokenRequestsAllowed: 1,
  sideRequestsAllowed: [2, 0],
  serviceOriginReads: 3,
  blockedByReason: Object.fromEntries(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.map((reason, index) => [reason, index])),
});

const authState = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state, sessionLostUrl: null, ...extra });

const SUCCEEDED_REPORT = Object.freeze({ result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null });

describe('T34c: the script login counts of AUTH_STATE', () => {
  it('has the closed list of the block reasons in the schema, and the side request limit of the setup', () => {
    // T36R-fix: 資格情報の理由も必須（動いている IPC）。
    expect(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.at(-1)).toBe(WORKER_LOGIN_CREDENTIAL_BLOCK_REASON);
    expect(pointerValue(SCHEMA, '/$defs/scriptLoginCounts/properties/blockedByReason/required')).toEqual([...WORKER_SCRIPT_LOGIN_BLOCK_REASONS]);
    expect(Object.keys(pointerValue(SCHEMA, '/$defs/scriptLoginCounts/properties/blockedByReason/properties') as object))
      .toEqual([...WORKER_SCRIPT_LOGIN_BLOCK_REASONS]);
    expect(pointerValue(SCHEMA, '/$defs/scriptLoginCounts/properties/sideRequestsAllowed/maxItems')).toBe(MAX_LOGIN_SIDE_REQUESTS);
    expect(pointerValue(SCHEMA, '/$defs/authState/properties/scriptLogin')).toEqual({ $ref: '#/$defs/scriptLoginCounts' });
    expect(Object.isFrozen(WORKER_SCRIPT_LOGIN_BLOCK_REASONS)).toBe(true);
  });

  it.each(['AUTHENTICATED', ...WORKER_LOGIN_FAILURE_STATES])('accepts %s with the counts', (state) => {
    const message = authState(state, { scriptLogin: COUNTS });
    expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
  });

  // T34R-fix-a（T34R の I-1）: 止める印で終わった手動のログインの段は、最後の状態（`AWAITING_LOGIN`）に数を付けて送る（新しい状態は足さない）。
  // T34c の時点では拒んでいた形で、意図して受けるように変えた（止める要求を送っていないジョブの、この形は親が違反にする）。
  it('accepts the counts with AWAITING_LOGIN (the login stage ended by the stop signal)', () => {
    expect(WORKER_STOPPED_LOGIN_STAGE_STATE).toBe('AWAITING_LOGIN');
    const message = authState(WORKER_STOPPED_LOGIN_STAGE_STATE, { scriptLogin: COUNTS });
    expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
  });

  it('accepts the counts with no registered side request', () => {
    const message = authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, sideRequestsAllowed: [] } });
    expect(validateWorkerToParentMessage(message).ok).toBe(true);
  });

  // T36R-fix（T36R の M-3。意図して直した期待）: 動いている IPC では、資格情報の理由の鍵がない数を拒む。
  it('rejects the counts without the credential reason on the IPC', () => {
    const { [WORKER_LOGIN_CREDENTIAL_BLOCK_REASON]: _credential, ...before } = COUNTS.blockedByReason;
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, blockedByReason: before } })).ok).toBe(false);
  });

  // T36c（意図して直した期待）: スクリプトで送る自動ログインの結果は、自動ログインの結果と一緒に数と一覧を持てる。
  const FAILED_REPORT = Object.freeze({ result: 'AUTH_RESULT_UNKNOWN', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null });
  const BLOCKED = Object.freeze({ requests: [], unlisted: 1 });
  it.each([
    ['AUTHENTICATED', SUCCEEDED_REPORT],
    ['UNSUPPORTED_AUTH_STATE', SUCCEEDED_REPORT],
    [WORKER_AUTOMATED_LOGIN_FAILED_STATE, FAILED_REPORT],
  ] as const)('accepts %s of the automated login with the counts and the blocked list', (state, report) => {
    const message = authState(state, { automatedLogin: report, scriptLogin: COUNTS, blockedRequests: BLOCKED });
    expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
  });

  const reasonsWith = (entries: Record<string, unknown>): Record<string, unknown> => ({ ...COUNTS.blockedByReason, ...entries });
  const { UNREGISTERED_NON_READ: _omitted, ...missingReason } = COUNTS.blockedByReason;

  it.each([
    ['SESSION_LOST', authState('SESSION_LOST', { sessionLostUrl: `${ORIGIN}/admin`, scriptLogin: COUNTS })],
    ['the automated login state without the result', authState(WORKER_AUTOMATED_LOGIN_FAILED_STATE, { scriptLogin: COUNTS })],
    ['the automated login result with the stop state', authState(WORKER_STOPPED_LOGIN_STAGE_STATE, { automatedLogin: SUCCEEDED_REPORT, scriptLogin: COUNTS })],
    ['a negative count', authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, tokenRequestsAllowed: -1 } })],
    ['a fractional count', authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, serviceOriginReads: 1.5 } })],
    ['too many side request items', authState('AUTHENTICATED', {
      scriptLogin: { ...COUNTS, sideRequestsAllowed: Array.from({ length: MAX_LOGIN_SIDE_REQUESTS + 1 }, () => 0) } })],
    ['an unknown reason', authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, blockedByReason: reasonsWith({ OTHER: 1 }) } })],
    ['a missing reason', authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, blockedByReason: missingReason } })],
    ['a URL in the counts', authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, url: `${SERVICE_ORIGIN}/auth/v1/token` } })],
    ['no side request list', authState('AUTHENTICATED', { scriptLogin: { ...COUNTS, sideRequestsAllowed: undefined } })],
  ] as const)('rejects the counts with %s', (_name, message) => {
    expect(validateWorkerToParentMessage(JSON.parse(JSON.stringify(message)) as unknown).ok).toBe(false);
  });

  it('keeps every auth state without the counts', () => {
    for (const state of WORKER_AUTH_STATES.filter((value) => value !== 'SESSION_LOST' && value !== 'AUTOMATED_LOGIN_FAILED')) {
      expect(validateWorkerToParentMessage(authState(state)).ok).toBe(true);
    }
  });
});

describe('T34c: the START digest binds the approved service origins only when there are some', () => {
  it('keeps the form navigation digest without service origins and with an empty list', () => {
    expect(workerAuthenticationDigestOf(SETUP, [ORIGIN], MANUAL_BINDING)).toBe(FORM_DIGEST);
    expect(workerAuthenticationDigestOf(SETUP, [ORIGIN], { ...MANUAL_BINDING, approvedServiceOrigins: [] })).toBe(FORM_DIGEST);
  });

  it('changes the digest with the service origins, and with other service origins', () => {
    const withService = workerAuthenticationDigestOf(SETUP, [ORIGIN], { ...MANUAL_BINDING, approvedServiceOrigins: [SERVICE_ORIGIN] });
    expect(withService).not.toBe(FORM_DIGEST);
    expect(workerAuthenticationDigestOf(SETUP, [ORIGIN], { ...MANUAL_BINDING, approvedServiceOrigins: [OTHER_SERVICE_ORIGIN] })).not.toBe(withService);
    expect(workerAuthenticationDigestOf(SETUP, [ORIGIN], { ...MANUAL_BINDING, approvedServiceOrigins: [SERVICE_ORIGIN] })).toBe(withService);
  });
});
