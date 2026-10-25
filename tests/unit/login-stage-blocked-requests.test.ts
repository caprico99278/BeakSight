// T34e（Task 34 の設計書 3.5 と 8 章の T34e の行）: ログインの段で止めた読み取りでない要求の一覧（`src/safety/login-stage-blocked-requests.ts`）。
// - 一覧の 1 行は、Origin と path（query・fragment・本文・値なし）、要求の種類、止めた理由、回数。同じ Origin・path・種類・理由は重ねず、回数を足す。
// - 上限（`MAX_LOGIN_STAGE_BLOCKED_REQUESTS`）を超えた新しい行は、一覧に入れずに数だけ（`unlisted`）。一覧に入っている行は、上限の後も回数を足す。
// - T34e fix round 1: path は、値に見える区切り（`src/core/url-path-redaction.ts`）を `[REDACTED]` にする。送信先の path（`/auth/v1/token` など）は
//   伏せない。長い path は上限で切り、切った後にも値に見える区切りが残らない。
// - HTTP(S) でない URL や読めない URL は、一覧に入れずに数だけ。
// - ワーカーが IPC に載せる値（`loginStageBlockedRequestsOf`）は、止めた要求がなければ `undefined`。
// 例の値は、匿名の値（`127.0.0.1`、`example`）だけを使う。
import { describe, expect, it } from 'vitest';
import { REDACTED_PATH_SEGMENT, hasValueLikePathSegment } from '../../src/core/url-path-redaction.js';
import {
  LOGIN_STAGE_BLOCKED_REQUEST_REASONS,
  isLoginStageBlockedRequestReason,
  LoginStageBlockedRequestList,
  MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH,
  MAX_LOGIN_STAGE_BLOCKED_REQUESTS,
} from '../../src/safety/login-stage-blocked-requests.js';
import { LOGIN_CREDENTIAL_BLOCK_REASON } from '../../src/safety/login-credential-guard.js';
import { LoginStageMonitor } from '../../src/safety/passive-request-guard.js';
import { SCRIPT_LOGIN_BLOCK_REASONS } from '../../src/safety/request-policy.js';
import { loginStageBlockedRequestsOf } from '../../src/worker/login-stage-checks.js';

const APP = 'http://127.0.0.1:4173';
const SERVICE = 'http://127.0.0.1:5173';
/** path の中の値（JWT の形）の目印（一覧に出ない）。 */
const VALUE_MARKER = 'eyJtYXJrZXIiOiJ0MzRlIn0.eyJzdWIiOiJleGFtcGxlIn0.bWFya2VyLXNpZ25hdHVyZQ';
/** 切る位置にかかる区切りの、上限の中に入る長さ（値に見える長さ）と、区切りを作る繰り返しの数。 */
const CUT_SEGMENT_HEAD_LENGTH = 32;
const CUT_SEGMENT_REPEAT = 10;
/** query の値の目印（一覧に出ない）。 */
const QUERY_MARKER = 'marker-query-value-t34e';

describe('T34e: the list of the non-read requests blocked in the login stage', () => {
  it('has the script login reasons and the form login reason, and the limits', () => {
    // T36R-fix（T36R の M-2。意図して直した期待）: 資格情報の理由は数だけで、行の理由の一覧には入れない。
    expect(LOGIN_STAGE_BLOCKED_REQUEST_REASONS).toEqual([
      ...SCRIPT_LOGIN_BLOCK_REASONS.filter((reason) => reason !== LOGIN_CREDENTIAL_BLOCK_REASON),
      'NON_READ_METHOD',
    ]);
    expect(isLoginStageBlockedRequestReason(LOGIN_CREDENTIAL_BLOCK_REASON)).toBe(false);
    expect(LOGIN_STAGE_BLOCKED_REQUEST_REASONS.every(isLoginStageBlockedRequestReason)).toBe(true);
    expect(Object.isFrozen(LOGIN_STAGE_BLOCKED_REQUEST_REASONS)).toBe(true);
    expect(MAX_LOGIN_STAGE_BLOCKED_REQUESTS).toBe(8);
  });

  it('keeps the origin and the path only, and adds up the same origin, path, type and reason', () => {
    const list = new LoginStageBlockedRequestList();
    list.record(`${SERVICE}/rest/v1/rpc/resolve_tenant`, 'fetch', 'UNREGISTERED_NON_READ');
    list.record(`${SERVICE}/rest/v1/rpc/resolve_tenant?tenant=${QUERY_MARKER}#${QUERY_MARKER}`, 'fetch', 'UNREGISTERED_NON_READ');
    list.record(`${SERVICE}/rest/v1/rpc/resolve_tenant`, 'xhr', 'UNREGISTERED_NON_READ');
    list.record(`${SERVICE}/rest/v1/rpc/resolve_tenant`, 'fetch', 'SIDE_REQUEST_OVER_LIMIT');
    list.record(`${APP}/cdn-cgi/rum`, 'ping', 'NON_READ_METHOD');
    const snapshot = list.snapshot();
    expect(snapshot).toEqual({
      requests: [
        // T43d（意図して直した期待。Task 43 の設計書 4.4）: 同じ行の query の名前（値なし）を足す。値と fragment は持たない。
        {
          origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', resourceType: 'fetch', reason: 'UNREGISTERED_NON_READ', count: 2,
          query: { names: ['tenant'], omitted: 0, values: [] },
        },
        { origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', resourceType: 'xhr', reason: 'UNREGISTERED_NON_READ', count: 1 },
        { origin: SERVICE, path: '/rest/v1/rpc/resolve_tenant', resourceType: 'fetch', reason: 'SIDE_REQUEST_OVER_LIMIT', count: 1 },
        { origin: APP, path: '/cdn-cgi/rum', resourceType: 'ping', reason: 'NON_READ_METHOD', count: 1 },
      ],
      unlisted: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain(QUERY_MARKER);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.requests)).toBe(true);
    expect(snapshot.requests.every((request) => Object.isFrozen(request))).toBe(true);
  });

  it('lists up to the limit, counts the new requests over it as unlisted, and still adds up the listed ones', () => {
    const list = new LoginStageBlockedRequestList();
    for (let index = 0; index < MAX_LOGIN_STAGE_BLOCKED_REQUESTS + 2; index += 1) {
      list.record(`${SERVICE}/rest/v1/rpc/call_${index}`, 'fetch', 'UNREGISTERED_NON_READ');
    }
    list.record(`${SERVICE}/rest/v1/rpc/call_0`, 'fetch', 'UNREGISTERED_NON_READ');
    const snapshot = list.snapshot();
    expect(snapshot.requests).toHaveLength(MAX_LOGIN_STAGE_BLOCKED_REQUESTS);
    expect(snapshot.requests[0]).toMatchObject({ path: '/rest/v1/rpc/call_0', count: 2 });
    expect(snapshot.unlisted).toBe(2);
  });

  it('keeps the endpoint path, hides the value-like segments, and cuts a long path at the limit without leaving a value-like segment', () => {
    const list = new LoginStageBlockedRequestList();
    // T43d（意図して直した期待）: `grant_type` の決まった形の値は残すようになったので、値を残さない名前（`code`）で、query の値が出ないことを確かめる。
    list.record(`${SERVICE}/auth/v1/token?code=${QUERY_MARKER}`, 'fetch', 'TOKEN_REQUEST_QUERY_MISMATCH');
    list.record(`${APP}/session/${VALUE_MARKER}/end`, 'document', 'NON_READ_METHOD');
    const long = `/${'p'.repeat(MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH + 10)}`;
    list.record(`${APP}${long}`, 'fetch', 'NON_READ_METHOD');
    // 上限の位置で切ると値に見える区切りになる区切り（全体は `.` を含むので値に見えない）。切った後にも伏せる。
    const head = `/${'p'.repeat(MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH - CUT_SEGMENT_HEAD_LENGTH - 2)}`;
    list.record(`${APP}${head}/${'Ab12'.repeat(CUT_SEGMENT_REPEAT)}.x`, 'fetch', 'NON_READ_METHOD');
    const { requests } = list.snapshot();
    expect(requests.map(({ path }) => path)).toEqual([
      '/auth/v1/token',
      `/session/${REDACTED_PATH_SEGMENT}/end`,
      long.slice(0, MAX_LOGIN_STAGE_BLOCKED_PATH_LENGTH),
      `${head}/${REDACTED_PATH_SEGMENT}`,
    ]);
    expect(requests.some(({ path }) => hasValueLikePathSegment(path))).toBe(false);
    const text = JSON.stringify(requests);
    expect(text).not.toContain(QUERY_MARKER);
    expect(text).not.toContain(VALUE_MARKER);
  });

  it('does not list a URL that is not HTTP(S) or cannot be read, and counts it as unlisted', () => {
    const list = new LoginStageBlockedRequestList();
    list.record('data:text/plain,abc', 'other', 'NON_READ_METHOD');
    list.record('not a url', 'other', 'NON_READ_METHOD');
    expect(list.snapshot()).toEqual({ requests: [], unlisted: 2 });
  });

  // T43d（Task 43 の設計書 4.4）: 行に query の名前の一覧（値なし。上限つき）と、閉じた一覧の名前（`grant_type`）の決まった形の値を足す。値の違う
  // `grant_type` は別の行にし、名前は同じ行の間で足し合わせる。query のない行は項目を持たない。
  // ML-a-fix（ML-R の M-1）: token の形の行（閉じた一覧の `grant_type` の値を記録した行）は、上限の外で必ず残す（上限で一覧が埋まっていたら、token の形でない
  // 最後の行を一覧から外し、その回数を数だけにする。一覧の行の数は上限のまま）。
  it('keeps a token shaped row over the limit by moving the last other row to the unlisted count (ML-a-fix M-1)', () => {
    const list = new LoginStageBlockedRequestList();
    for (let index = 0; index < MAX_LOGIN_STAGE_BLOCKED_REQUESTS; index += 1) {
      list.record(`${APP}/collect/beacon_${index}`, 'ping', 'NON_READ_METHOD');
    }
    list.record(`${APP}/collect/beacon_7`, 'ping', 'NON_READ_METHOD');
    list.record(`${SERVICE}/auth/v1/token?grant_type=password`, 'fetch', 'NON_READ_METHOD');
    list.record(`${SERVICE}/auth/v1/token?grant_type=password`, 'fetch', 'NON_READ_METHOD');
    const { requests, unlisted } = list.snapshot();
    expect(requests).toHaveLength(MAX_LOGIN_STAGE_BLOCKED_REQUESTS);
    expect(requests.at(-1)).toMatchObject({ path: '/auth/v1/token', count: 2, query: { values: [{ name: 'grant_type', value: 'password' }] } });
    expect(requests.map(({ path }) => path)).not.toContain('/collect/beacon_7');
    expect(unlisted).toBe(2);
  });

  // ML-a-fix（ML-R の I-1）: 行に「token の送信より前に最初に見た」印（`beforeToken: true`。値を持たない）を残せる。同じ行の後の回は、最初の回の印のまま。
  it('keeps the mark of the first observation before the token request (ML-a-fix I-1)', () => {
    const list = new LoginStageBlockedRequestList();
    list.record(`${SERVICE}/rest/v1/rpc/resolve_tenant`, 'fetch', 'NON_READ_METHOD', true);
    list.record(`${SERVICE}/rest/v1/rpc/resolve_tenant`, 'fetch', 'NON_READ_METHOD', false);
    list.record(`${SERVICE}/rest/v1/members`, 'fetch', 'NON_READ_METHOD', false);
    list.record(`${SERVICE}/rest/v1/rpc/after_login`, 'fetch', 'NON_READ_METHOD');
    expect(list.snapshot().requests.map(({ path, count, beforeToken }) => [path, count, beforeToken])).toEqual([
      ['/rest/v1/rpc/resolve_tenant', 2, true],
      ['/rest/v1/members', 1, undefined],
      ['/rest/v1/rpc/after_login', 1, undefined],
    ]);
  });

  it('keeps the query names and the grant_type value of a row, and separates the rows by the grant_type value', () => {
    const list = new LoginStageBlockedRequestList();
    list.record(`${SERVICE}/auth/v1/token?grant_type=password`, 'fetch', 'NON_READ_METHOD');
    list.record(`${SERVICE}/auth/v1/token?grant_type=password&redirect_to=${QUERY_MARKER}`, 'fetch', 'NON_READ_METHOD');
    list.record(`${SERVICE}/auth/v1/token?grant_type=refresh_token`, 'fetch', 'NON_READ_METHOD');
    list.record(`${SERVICE}/auth/v1/token?grant_type=${VALUE_MARKER}`, 'fetch', 'NON_READ_METHOD');
    const { requests } = list.snapshot();
    expect(requests).toEqual([
      {
        origin: SERVICE, path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 2,
        query: { names: ['grant_type', 'redirect_to'], omitted: 0, values: [{ name: 'grant_type', value: 'password' }] },
      },
      {
        origin: SERVICE, path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
        query: { names: ['grant_type'], omitted: 0, values: [{ name: 'grant_type', value: 'refresh_token' }] },
      },
      // 値に見える `grant_type` の値は残さない（名前だけ）。
      {
        origin: SERVICE, path: '/auth/v1/token', resourceType: 'fetch', reason: 'NON_READ_METHOD', count: 1,
        query: { names: ['grant_type'], omitted: 0, values: [] },
      },
    ]);
    const text = JSON.stringify(requests);
    expect(text).not.toContain(QUERY_MARKER);
    expect(text).not.toContain(VALUE_MARKER);
    expect(requests.every((request) => request.query === undefined || Object.isFrozen(request.query))).toBe(true);
  });

  it('gives the IPC list from the login stage monitor only when a request was blocked', () => {
    expect(loginStageBlockedRequestsOf(new LoginStageMonitor())).toBeUndefined();
    expect(new LoginStageMonitor().snapshot().blockedRequests).toEqual({ requests: [], unlisted: 0 });
  });
});
