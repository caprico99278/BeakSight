// T34e（Task 34 の設計書 3.5 と 8 章の T34e の行）: ログインの段で止めた読み取りでない要求の一覧の IPC の契約（`src/control/worker-protocol.ts`、
// `schemas/control/worker-message.schema.json`。スキーマの版は上げない）。
// - `AUTH_STATE` の任意の項目 `blockedRequests`: 一覧（Origin、path、要求の種類、理由、回数。上限 `MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS`）と、一覧に
//   入れなかった数（`unlisted`）。手動のログインの段の結果の状態（`AUTHENTICATED` とログインの段の失敗）だけが持て、自動ログインの結果と一緒には持てない。
//   送るのは、止めた要求があったときだけ（一覧も数も空の値は拒む）。
// - Origin は正規の直列化。path は `/` で始まり（query・fragment なし）、制御文字なし、上限の長さまで。T34e fix round 1: 値に見える区切り
//   （`src/core/url-path-redaction.ts`）が残っていない（伏せた区切り `[REDACTED]` は受ける。送信先の path は伏せない）。同じ Origin・path・種類・理由の行は
//   重ねない。回数は 1 以上。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';
import {
  MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH,
  MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS,
  MAX_WORKER_NOTICE_URL_LENGTH,
  WORKER_LOGIN_FAILURE_STATES,
  WORKER_LOGIN_CREDENTIAL_BLOCK_REASON,
  WORKER_LOGIN_STAGE_BLOCK_REASONS,
  WORKER_PROTOCOL_VERSION,
  WORKER_REQUEST_RESOURCE_TYPES,
  WORKER_SCRIPT_LOGIN_BLOCK_REASONS,
  validateWorkerToParentMessage,
} from '../../src/control/worker-protocol.js';

const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'worker-message.schema.json'), 'utf8')) as Record<string, unknown>;

const pointerValue = (document: unknown, pointer: string): unknown =>
  pointer.split('/').slice(1).reduce<unknown>((value, key) =>
    (typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined), document);

const ORIGIN = 'http://127.0.0.1:4173';
const SERVICE_ORIGIN = 'http://127.0.0.1:5173';

const ENTRY = Object.freeze({ origin: SERVICE_ORIGIN, path: '/rest/v1/rpc/log_login', resourceType: 'fetch', reason: 'UNREGISTERED_NON_READ', count: 2 });
const BLOCKED = Object.freeze({
  requests: [ENTRY, { origin: ORIGIN, path: `/session/${REDACTED_PATH_SEGMENT}`, resourceType: 'document', reason: 'NON_READ_METHOD', count: 1 }],
  unlisted: 0,
});
const COUNTS = Object.freeze({
  tokenRequestsAllowed: 1,
  sideRequestsAllowed: [],
  serviceOriginReads: 0,
  blockedByReason: Object.fromEntries(WORKER_SCRIPT_LOGIN_BLOCK_REASONS.map((reason) => [reason, 0])),
});
const SUCCEEDED_REPORT = Object.freeze({ result: 'SUCCEEDED', submitted: 'YES', retryAfterUntil: null, formInvalidReason: null });

const authState = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ protocol: WORKER_PROTOCOL_VERSION, type: 'AUTH_STATE', state, sessionLostUrl: null, ...extra });
const withRequests = (requests: readonly unknown[], unlisted = 0): Record<string, unknown> =>
  authState('LOGIN_TIMEOUT', { blockedRequests: { requests, unlisted } });
const withEntry = (change: Record<string, unknown>): Record<string, unknown> => withRequests([{ ...ENTRY, ...change }]);

describe('T34e: the blocked requests of the login stage in AUTH_STATE', () => {
  it('has the closed lists and the limits in the schema', () => {
    const item = '/$defs/loginStageBlockedRequests/properties/requests/items';
    expect(pointerValue(SCHEMA, '/$defs/authState/properties/blockedRequests')).toEqual({ $ref: '#/$defs/loginStageBlockedRequests' });
    expect(pointerValue(SCHEMA, '/$defs/loginStageBlockedRequests/properties/requests/maxItems')).toBe(MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS);
    expect(pointerValue(SCHEMA, `${item}/properties/origin/maxLength`)).toBe(MAX_WORKER_NOTICE_URL_LENGTH);
    expect(pointerValue(SCHEMA, `${item}/properties/path/maxLength`)).toBe(MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH);
    expect(pointerValue(SCHEMA, `${item}/properties/resourceType/enum`)).toEqual([...WORKER_REQUEST_RESOURCE_TYPES]);
    expect(pointerValue(SCHEMA, `${item}/properties/reason/enum`)).toEqual([...WORKER_LOGIN_STAGE_BLOCK_REASONS]);
    // T36R-fix（T36R の M-2。意図して直した期待）: 資格情報の理由は数だけで、行の理由の一覧には入れない。
    expect(WORKER_LOGIN_STAGE_BLOCK_REASONS).toEqual([
      ...WORKER_SCRIPT_LOGIN_BLOCK_REASONS.filter((reason) => reason !== WORKER_LOGIN_CREDENTIAL_BLOCK_REASON),
      'NON_READ_METHOD',
    ]);
    expect(MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS).toBe(8);
    for (const list of [WORKER_LOGIN_STAGE_BLOCK_REASONS, WORKER_REQUEST_RESOURCE_TYPES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  // T34R-fix-a（T34R の I-1）: 止める印で終わった手動のログインの段の `AWAITING_LOGIN` も、一覧を持てる（T34e の時点では拒んでいた形で、意図して
  // 受けるように変えた。止める要求を送っていないジョブの、この形は親が違反にする）。
  it.each(['AUTHENTICATED', ...WORKER_LOGIN_FAILURE_STATES, 'AWAITING_LOGIN'])('accepts %s with the blocked requests', (state) => {
    const message = authState(state, { blockedRequests: BLOCKED });
    expect(validateWorkerToParentMessage(message)).toEqual({ ok: true, message });
  });

  it('accepts the list with the script login counts, a full list with unlisted requests, and the unlisted count only', () => {
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', { scriptLogin: COUNTS, blockedRequests: BLOCKED })).ok).toBe(true);
    const full = Array.from({ length: MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS }, (_, index) => ({ ...ENTRY, path: `/rest/v1/rpc/call_${index}` }));
    expect(validateWorkerToParentMessage(withRequests(full, 3)).ok).toBe(true);
    expect(validateWorkerToParentMessage(withRequests([], 1)).ok).toBe(true);
    // T34e fix round 1: 送信先の path は伏せない（そのまま受ける）。
    expect(validateWorkerToParentMessage(withEntry({ path: '/auth/v1/token', reason: 'TOKEN_REQUEST_QUERY_MISMATCH' })).ok).toBe(true);
    expect(validateWorkerToParentMessage(withEntry({ path: `/${'p'.repeat(MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH - 1)}` })).ok).toBe(true);
  });

  it.each([
    ['SESSION_LOST', authState('SESSION_LOST', { sessionLostUrl: `${ORIGIN}/admin`, blockedRequests: BLOCKED })],
    // T36c（意図して直した期待）: 自動ログインの段の結果は一覧を持てるようになった。止める印の状態と自動ログインの結果の組は、今も拒む。
    ['the automated login result with the stop state', authState('AWAITING_LOGIN', { automatedLogin: SUCCEEDED_REPORT, blockedRequests: BLOCKED })],
    ['nothing blocked', withRequests([], 0)],
    ['too many requests', withRequests(Array.from({ length: MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS + 1 },
      (_, index) => ({ ...ENTRY, path: `/rest/v1/rpc/call_${index}` })))],
    ['a duplicated request', withRequests([ENTRY, ENTRY])],
    ['an origin that is not canonical', withEntry({ origin: `${SERVICE_ORIGIN}/` })],
    ['an origin with a path', withEntry({ origin: `${SERVICE_ORIGIN}/rest` })],
    ['a path with a query', withEntry({ path: '/rest/v1/rpc/log_login?x=1' })],
    ['a path with a fragment', withEntry({ path: '/rest/v1/rpc/log_login#x' })],
    // T36R-fix（T36R の M-2）: 資格情報の理由の行は作らない（数だけ）。
    ['a row with the credential reason', withEntry({ reason: 'LOGIN_CREDENTIAL_IN_REQUEST' })],
    ['a path without the leading slash', withEntry({ path: 'rest/v1/rpc/log_login' })],
    ['a path with a JWT segment', withEntry({ path: '/session/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' })],
    ['a path with a long base64url segment', withEntry({ path: '/reset/AbCdEfGhIjKlMnOpQrStUv12' })],
    ['a path with a long hexadecimal segment', withEntry({ path: `/k/${'0'.repeat(32)}` })],
    ['a path that is only the redacted marker', withEntry({ path: REDACTED_PATH_SEGMENT })],
    ['a path with a line break', withEntry({ path: '/rest/v1\n/rpc' })],
    ['a path that is too long', withEntry({ path: `/${'p'.repeat(MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH)}` })],
    ['an unknown reason', withEntry({ reason: 'OTHER' })],
    ['an unknown resource type', withEntry({ resourceType: 'beacon' })],
    ['a count of zero', withEntry({ count: 0 })],
    ['a value in the request', withEntry({ body: 'x' })],
    ['a negative unlisted count', withRequests([ENTRY], -1)],
  ] as const)('rejects the blocked requests with %s', (_name, message) => {
    expect(validateWorkerToParentMessage(JSON.parse(JSON.stringify(message)) as unknown).ok).toBe(false);
  });
});
