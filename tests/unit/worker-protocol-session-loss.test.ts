// DEF-138（設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 2.2、3 章の受け入れ条件 4）: IPC の `AUTH_STATE` の任意の `sessionLoss`。
// - `SESSION_LOST` だけが持てる。形は `run.json` の `authentication.sessionLoss` と同じ（スキーマを参照する）。
// - path の表記は query の名前だけ（値を持たない）。値に見える区切り、fragment、絶対の URL、上限を超える数、受けない鍵の名前の案を拒む。
// 例の値は、匿名の値だけを使う。
import { describe, expect, it } from 'vitest';
import { MAX_SESSION_LOSS_BLOCKED_REQUESTS, MAX_SESSION_LOSS_REDIRECT_PATHS, type SessionLossEvidence } from '../../src/core/evidence-types.js';
import { WORKER_PROTOCOL_VERSION, WORKER_SESSION_LOST_STATE, validateWorkerToParentMessage } from '../../src/control/worker-protocol.js';

const URL_OF_PAGE = 'http://127.0.0.1:4173/admin/expired';

const EVIDENCE: SessionLossEvidence = {
  stage: 'desktop:passive',
  requestedPath: '/admin/expired',
  landedPath: '/auth?from&ticket',
  landedBy: 'PAGE_URL',
  redirectPaths: [{ originKind: 'ALLOWED', path: '/admin/expired' }, { originKind: 'ALLOWED', path: '/auth?from&ticket' }],
  redirectPathsOmitted: 0,
  blockedRequests: [{ method: 'POST', originKind: 'SERVICE', path: '/auth/v1/token', reason: 'NON_READ_METHOD', count: 2 }],
  blockedRequestsUnlisted: 0,
  storageKeyChange: [{ storage: 'LOCAL_STORAGE', originKind: 'ALLOWED', change: 'REMOVED', count: 1, shapes: [{ prefix: '', suffix: '-token' }] }],
};

const message = (state: string, sessionLoss: unknown): unknown => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'AUTH_STATE',
  state,
  sessionLostUrl: state === WORKER_SESSION_LOST_STATE ? URL_OF_PAGE : null,
  sessionLoss,
});

describe('DEF-138: the session loss evidence of AUTH_STATE', () => {
  it('accepts the evidence on SESSION_LOST (and the evidence without the key name differences)', () => {
    expect(validateWorkerToParentMessage(message(WORKER_SESSION_LOST_STATE, EVIDENCE)).ok).toBe(true);
    expect(validateWorkerToParentMessage(message(WORKER_SESSION_LOST_STATE, { ...EVIDENCE, storageKeyChange: null, stage: null })).ok).toBe(true);
  });

  it.each([
    ['another state', message('AUTHENTICATED', EVIDENCE)],
    ['a query value in the landed path', message(WORKER_SESSION_LOST_STATE, { ...EVIDENCE, landedPath: '/auth?ticket=abc' })],
    ['a whole URL as the requested path', message(WORKER_SESSION_LOST_STATE, { ...EVIDENCE, requestedPath: 'http://127.0.0.1:4173/admin' })],
    ['a value-like segment in a route path', message(WORKER_SESSION_LOST_STATE, {
      ...EVIDENCE, redirectPaths: [{ originKind: 'OTHER', path: '/sso/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln' }],
    })],
    ['a fragment in a path', message(WORKER_SESSION_LOST_STATE, { ...EVIDENCE, landedPath: '/auth#token' })],
    ['a query in a blocked request path', message(WORKER_SESSION_LOST_STATE, {
      ...EVIDENCE, blockedRequests: [{ ...EVIDENCE.blockedRequests[0], path: '/auth/v1/token?grant_type' }],
    })],
    ['too many route steps', message(WORKER_SESSION_LOST_STATE, {
      ...EVIDENCE, redirectPaths: Array.from({ length: MAX_SESSION_LOSS_REDIRECT_PATHS + 1 }, () => EVIDENCE.redirectPaths[0]),
    })],
    ['too many blocked request rows', message(WORKER_SESSION_LOST_STATE, {
      ...EVIDENCE, blockedRequests: Array.from({ length: MAX_SESSION_LOSS_BLOCKED_REQUESTS + 1 }, () => EVIDENCE.blockedRequests[0]),
    })],
    ['a whole key name as a shape', message(WORKER_SESSION_LOST_STATE, {
      ...EVIDENCE, storageKeyChange: [{ ...EVIDENCE.storageKeyChange?.[0], shapes: [{ prefix: 'alice-session-', suffix: '' }] }],
    })],
    ['an unknown origin kind', message(WORKER_SESSION_LOST_STATE, { ...EVIDENCE, redirectPaths: [{ originKind: 'THIRD', path: '/a' }] })],
    ['an extra item (a value)', message(WORKER_SESSION_LOST_STATE, { ...EVIDENCE, cookieValue: 'abc' })],
  ])('rejects %s', (_case, value) => {
    expect(validateWorkerToParentMessage(value).ok).toBe(false);
  });
});
