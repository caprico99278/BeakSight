// ML-a（設計書 `2026-10-19-beaksight-manual-login-pass-through-design.md` 2.1、2.2）: 親とワーカーの IPC の、手動のログインの形。
// - 親 → ワーカーの「ログインを終えた」（`LOGIN_CONFIRMED`。項目なし）。
// - `AUTH_STATE` の、手動のログインの段で通した読み取りでない要求の一覧（`passedRequests`。止めた一覧と同じ形と規則。ログインの段の結果だけが持てる）。
// 値（query の値、本文）は形の上で持てない。
import { describe, expect, it } from 'vitest';
import {
  PARENT_TO_WORKER_MESSAGE_TYPES,
  WORKER_PROTOCOL_VERSION,
  validateParentToWorkerMessage,
  validateWorkerToParentMessage,
} from '../../src/control/worker-protocol.js';

const PASSED = Object.freeze({
  requests: [
    { origin: 'https://service.example.invalid', path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1, query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] } },
    { origin: 'https://service.example.invalid', path: '/rest/v1/rpc/current_tenant', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 2 },
  ],
  unlisted: 0,
});

const authState = (state: string, extra: Record<string, unknown> = {}) => ({
  protocol: WORKER_PROTOCOL_VERSION,
  type: 'AUTH_STATE',
  state,
  sessionLostUrl: state === 'SESSION_LOST' ? 'https://app.example.com/auth' : null,
  ...extra,
});

describe('ML-a: the login confirmation from the parent', () => {
  it('accepts LOGIN_CONFIRMED without items, and rejects extra items', () => {
    expect(PARENT_TO_WORKER_MESSAGE_TYPES).toContain('LOGIN_CONFIRMED');
    expect(validateParentToWorkerMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'LOGIN_CONFIRMED' }).ok).toBe(true);
    expect(validateParentToWorkerMessage({ protocol: WORKER_PROTOCOL_VERSION, type: 'LOGIN_CONFIRMED', password: 'x' }).ok).toBe(false);
  });
});

describe('ML-a: the requests passed in the manual login stage', () => {
  it('accepts the list on the results of the login stage', () => {
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', { passedRequests: PASSED })).ok).toBe(true);
    expect(validateWorkerToParentMessage(authState('LOGIN_TIMEOUT', { passedRequests: PASSED })).ok).toBe(true);
  });

  // ML-a-fix（ML-R の I-1）: 行の「token の送信より前に最初に見た」印（`beforeToken`。`true` だけ）。
  it('accepts the mark of the first observation before the token request, and only the value true', () => {
    const [, rpc] = PASSED.requests;
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', { passedRequests: { requests: [{ ...rpc, beforeToken: true }], unlisted: 0 } })).ok).toBe(true);
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', { passedRequests: { requests: [{ ...rpc, beforeToken: false }], unlisted: 0 } })).ok).toBe(false);
  });

  it('rejects the list on a lost session, an empty list, a value-like path, a query value outside the closed list and a repeated row', () => {
    expect(validateWorkerToParentMessage(authState('SESSION_LOST', { passedRequests: PASSED })).ok).toBe(false);
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', { passedRequests: { requests: [], unlisted: 0 } })).ok).toBe(false);
    const [token, rpc] = PASSED.requests;
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', {
      passedRequests: { requests: [{ ...rpc, path: '/rest/v1/eyJhbGciOiJIUzI1NiJ9abcDEF0123456789xyz' }], unlisted: 0 },
    })).ok).toBe(false);
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', {
      passedRequests: { requests: [{ ...token, query: { names: ['code'], omitted: 0, values: [{ name: 'code', value: 'secret' }] } }], unlisted: 0 },
    })).ok).toBe(false);
    expect(validateWorkerToParentMessage(authState('AUTHENTICATED', { passedRequests: { requests: [rpc, rpc], unlisted: 0 } })).ok).toBe(false);
  });
});
