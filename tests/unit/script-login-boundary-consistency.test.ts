// T34c（Task 34 の T34b の判断の (3)）: `src/control/` と `src/safety/` は互いを読み込めない（Gate `control-boundary`）ので、スクリプトで送るログインの
// 同じ意味の定義が、境界の両側にある。両側が一致することを、テストの側で 1 か所にまとめて確かめる（`schema-enum-consistency.test.ts` と同じ考え方）。
// - method: 認証の設定の契約の `SCRIPT_LOGIN_METHOD`・`LOGIN_SIDE_REQUEST_METHODS` と、要求の判定の `SUBMISSION_POST_METHOD`。
// - 形: 認証の設定の契約の必須の query の組・スクリプトの送信先・ログインに伴う送信と、要求の判定と Guard の口の形（型の一致は `tsc` で確かめる）。
// - 止めた理由の一覧: IPC の `WORKER_SCRIPT_LOGIN_BLOCK_REASONS` と、要求の判定の `SCRIPT_LOGIN_BLOCK_REASONS`。
import { describe, expect, expectTypeOf, it } from 'vitest';
import { LOGIN_FORM_SUBMISSIONS } from '../../src/browser/login-form-submitter.js';
import {
  LOGIN_SIDE_REQUEST_METHODS,
  LOGIN_TRANSPORTS,
  SCRIPT_LOGIN_METHOD,
  type LoginSideRequest,
  type ScriptLoginQueryParameter,
  type ScriptLoginTarget,
} from '../../src/control/auth/auth-setup-contracts.js';
import { MIN_CREDENTIAL_VALUE_LENGTH } from '../../src/control/credentials/credential-store.js';
import {
  MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH,
  MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS,
  WORKER_LOGIN_STAGE_BLOCK_REASONS,
  WORKER_LOGIN_CREDENTIAL_BLOCK_REASON,
  WORKER_REQUEST_RESOURCE_TYPES,
  WORKER_SCRIPT_LOGIN_BLOCK_REASONS,
  type WorkerLoginStageBlockedRequest,
  type WorkerLoginStageBlockedRequests,
  type WorkerScriptLoginCounts,
} from '../../src/control/worker-protocol.js';
import {
  LOGIN_STAGE_BLOCKED_REQUEST_REASONS,
  MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH,
  MAX_LOGIN_STAGE_BLOCKED_REQUESTS,
  type LoginStageBlockedRequest,
  type LoginStageBlockedRequests,
} from '../../src/safety/login-stage-blocked-requests.js';
import { LOGIN_CREDENTIAL_BLOCK_REASON, MIN_COMPARABLE_CREDENTIAL_LENGTH } from '../../src/safety/login-credential-guard.js';
import type { GuardLoginSideRequest, GuardScriptLogin, ScriptLoginStageCounts } from '../../src/safety/passive-request-guard.js';
import {
  REQUEST_RESOURCE_TYPES,
  SCRIPT_LOGIN_BLOCK_REASONS,
  SUBMISSION_POST_METHOD,
  type RequiredQueryParameter,
} from '../../src/safety/request-policy.js';

describe('T34c: the script login definitions on both sides of the control and safety boundary agree', () => {
  it('uses the same POST method', () => {
    expect(SCRIPT_LOGIN_METHOD).toBe(SUBMISSION_POST_METHOD);
    expect(LOGIN_SIDE_REQUEST_METHODS).toEqual([SUBMISSION_POST_METHOD]);
  });

  it('has the same closed list of the script login block reasons in the IPC and in the request policy', () => {
    expect(WORKER_SCRIPT_LOGIN_BLOCK_REASONS).toEqual(SCRIPT_LOGIN_BLOCK_REASONS);
    // T36c: 自動ログインの資格情報の守りの理由も、両側で同じ。
    expect(WORKER_LOGIN_CREDENTIAL_BLOCK_REASON).toBe(LOGIN_CREDENTIAL_BLOCK_REASON);
  });

  // T36c（設計者の判断 2）: 資格情報の登録の値の最小の長さ（control）と、資格情報の守りの比べの閾値（safety）が同じ。
  it('has the same minimum length of the credential values for the registration and the comparison', () => {
    expect(MIN_CREDENTIAL_VALUE_LENGTH).toBe(MIN_COMPARABLE_CREDENTIAL_LENGTH);
  });

  it('has the same shapes (checked by the type checker)', () => {
    expectTypeOf<ScriptLoginQueryParameter>().toEqualTypeOf<RequiredQueryParameter>();
    expectTypeOf<ScriptLoginTarget>().toMatchTypeOf<GuardScriptLogin['scriptLogin']>();
    expectTypeOf<GuardScriptLogin['scriptLogin']>().toMatchTypeOf<ScriptLoginTarget>();
    expectTypeOf<LoginSideRequest>().toMatchTypeOf<GuardLoginSideRequest>();
    expectTypeOf<ScriptLoginStageCounts['tokenRequestsAllowed']>().toEqualTypeOf<WorkerScriptLoginCounts['tokenRequestsAllowed']>();
    expectTypeOf<ScriptLoginStageCounts['sideRequestsAllowed']>().toEqualTypeOf<WorkerScriptLoginCounts['sideRequestsAllowed']>();
    expectTypeOf<ScriptLoginStageCounts['serviceOriginReads']>().toEqualTypeOf<WorkerScriptLoginCounts['serviceOriginReads']>();
    expectTypeOf<ScriptLoginStageCounts['blockedByScriptReason']>().toEqualTypeOf<WorkerScriptLoginCounts['blockedByReason']>();
  });
});

// T34e: ログインの段で止めた要求の一覧も、境界の両側にある（要求の判定と Guard の側の一覧、IPC の側の一覧）。
describe('T34e: the blocked request list definitions on both sides of the control and safety boundary agree', () => {
  // T34e fix round 1: path の値に見える区切りの判定と伏せた印は `src/core/url-path-redaction.ts` の 1 か所（両側の写しはない）。
  it('has the same reasons, resource types and limits', () => {
    expect(WORKER_LOGIN_STAGE_BLOCK_REASONS).toEqual(LOGIN_STAGE_BLOCKED_REQUEST_REASONS);
    expect(WORKER_REQUEST_RESOURCE_TYPES).toEqual(REQUEST_RESOURCE_TYPES);
    expect(MAX_WORKER_LOGIN_STAGE_BLOCKED_REQUESTS).toBe(MAX_LOGIN_STAGE_BLOCKED_REQUESTS);
    expect(MAX_WORKER_LOGIN_STAGE_BLOCKED_PATH_LENGTH).toBe(MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH);
  });

  it('has the same shape of a blocked request (checked by the type checker)', () => {
    expectTypeOf<LoginStageBlockedRequests>().toMatchTypeOf<WorkerLoginStageBlockedRequests>();
    expectTypeOf<LoginStageBlockedRequest['reason']>().toEqualTypeOf<WorkerLoginStageBlockedRequest['reason']>();
    expectTypeOf<LoginStageBlockedRequest['resourceType']>().toEqualTypeOf<WorkerLoginStageBlockedRequest['resourceType']>();
  });
});

// T36a（Task 36 の設計書 3.2）: 入力の前の確かめの送り方（`src/browser/` は `src/control/` を読めないので、閉じた値を写す）は、認証の設定のログインの
// 送り方と同じ一覧。
describe('T36a: the login form submissions agree with the login transports', () => {
  it('has the same closed list in the same order', () => {
    expect(LOGIN_FORM_SUBMISSIONS).toEqual(LOGIN_TRANSPORTS);
  });
});
