// L12a（設計書 `doc/design/2026-11-09-beaksight-remove-limits-design.md` 2・3・4 の S11・S12、L12 の判断）: 書き込みの段の押した後の扱い（`writeStage.afterPress`）の、
// 要求の判定（`classifyPassiveRequest`）を表で確かめる。
// - 押した後は、ページの送信を通す（SD-2: 削除・危険な語も。送り先の Origin を問わない。数えない。ナビゲーションの form の送信と WebSocket も）。
// - 承認した送信の照合（承認の送信先への 1 回目）は、今どおり先に働く（照合の印つきで通し、Guard が本文を照らす）。
// - 承認した送信の応答を受けるまでは、承認の送信先とその下への読み取りでない要求を通さない（照合が止めた後の押し直しの形を含む）。
// - 口がなければ（送信の扱いが `READ_ONLY`）、今どおり止める。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  classifyPassiveRequest,
  type HttpRequestFacts,
  type PassiveRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
  type RequestSentContent,
  type WriteStagePolicy,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://app.example.com';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const PRESSED: WriteStagePolicy = Object.freeze({
  writeEndpoint: Object.freeze({ origin: APP_ORIGIN, path: '/members' }),
  remainingPosts: 1,
  submissionWindowOpen: true,
  valuesEntered: true,
});
const afterPress = (approvedWriteResponded: boolean, remainingPosts = 1): PassiveRequestPolicyOptions => ({
  writeStage: Object.freeze({
    ...PRESSED,
    remainingPosts,
    submissionWindowOpen: !approvedWriteResponded,
    afterPress: Object.freeze({ approvedWriteResponded }),
  }),
});
const NO_AFTER_PRESS: PassiveRequestPolicyOptions = { writeStage: Object.freeze({ ...PRESSED, remainingPosts: 0, submissionWindowOpen: false }) };

const NO_OVERRIDES = (): readonly string[] => [];
const sent = (headers: Record<string, string> = { 'content-type': 'application/json' }): RequestSentContent => ({ headers, formMethodOverrides: NO_OVERRIDES });

const facts = (method: string, url: string, options: { readonly navigation?: boolean; readonly mainFrame?: boolean; readonly sentContent?: RequestSentContent } = {}): HttpRequestFacts => {
  const navigation = options.navigation === true;
  return {
    kind: 'HTTP', method, url, isNavigationRequest: navigation, isMainFrame: options.mainFrame ?? navigation, resourceType: navigation ? 'document' : 'fetch',
    ...(options.sentContent === undefined ? {} : { sentContent: options.sentContent }),
  };
};

const decide = (request: PassiveRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, policy);

const PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };

describe('L12a: the write stage after the press passes the page sends', () => {
  it('passes the page writes after the approved write responded, to any Origin and to the approved endpoint, without counting', () => {
    const policy = afterPress(true, 0);
    for (let index = 0; index < 25; index += 1) {
      expect(decide(facts('POST', `${APP_ORIGIN}/events/${index}`), policy)).toEqual(PASSED);
    }
    expect(decide(facts('POST', `${APP_ORIGIN}/members`), policy)).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/members/1/confirm`), policy)).toEqual(PASSED);
    expect(decide(facts('PUT', `${OTHER_ORIGIN}/collect`), policy)).toEqual(PASSED);
    expect(decide(facts('PATCH', `${APP_ORIGIN}/members/1`), policy)).toEqual(PASSED);
  });

  it('passes the page form sends (navigations) and the reads, also inside the window', () => {
    const policy = afterPress(false);
    expect(decide(facts('POST', `${APP_ORIGIN}/drafts`, { navigation: true }), policy)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS', auditSendAdmission: true });
    expect(decide(facts('GET', `${APP_ORIGIN}/csrf`), policy)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
    expect(decide(facts('GET', `${OTHER_ORIGIN}/pixel.gif`), policy)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
    expect(decide(facts('GET', `${APP_ORIGIN}/members/1`, { navigation: true }), policy)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
  });

  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: DELETE・削除の上書き・危険な語・許可 Origin の外への main frame の移動も通す。
  it('passes a DELETE, a DELETE override, a dangerous word and a main frame navigation outside the allowed Origins, and keeps blocking a non-http URL', () => {
    const policy = afterPress(true, 0);
    expect(decide(facts('DELETE', `${APP_ORIGIN}/members/1`), policy)).toMatchObject({ action: 'ALLOW' });
    expect(decide(facts('POST', `${APP_ORIGIN}/members/1`, { sentContent: sent({ 'x-http-method-override': 'DELETE' }) }), policy)).toMatchObject({ action: 'ALLOW' });
    expect(decide(facts('POST', `${APP_ORIGIN}/logout`, { navigation: true }), policy)).toMatchObject({ action: 'ALLOW' });
    expect(decide({ kind: 'WEBSOCKET', url: 'wss://app.example.com/delete' }, policy)).toMatchObject({ action: 'ALLOW' });
    expect(decide(facts('GET', `${OTHER_ORIGIN}/`, { navigation: true }), policy)).toMatchObject({ action: 'ALLOW' });
    expect(decide(facts('POST', 'not a url'), policy)).toMatchObject({ action: 'BLOCK' });
  });

  // L12b: リダイレクトの続き（307・308 の本文の送り直し）は、ページが自分で出す送信ではない（承認した送信の送り直しになりうる）ので通さない。
  it('does not pass a non-read redirect replay after the press (L12b)', () => {
    const policy = afterPress(true, 0);
    expect(decide({ ...facts('POST', `${APP_ORIGIN}/elsewhere`, { navigation: true }), redirectReplay: true }, policy)).toMatchObject({ action: 'BLOCK' });
    expect(decide({ ...facts('POST', `${OTHER_ORIGIN}/collect`), redirectReplay: true }, policy)).toMatchObject({ action: 'BLOCK' });
    // 読み取りのリダイレクトは、今どおり通す。
    expect(decide({ ...facts('GET', `${APP_ORIGIN}/members/1`, { navigation: true }), redirectReplay: true }, policy))
      .toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
  });

  it('passes a WebSocket after the press, and keeps blocking it without the after-press policy', () => {
    expect(decide({ kind: 'WEBSOCKET', url: 'wss://app.example.com/live' }, afterPress(false))).toEqual({ action: 'ALLOW', delivery: 'DIRECT', auditSendWebSocketAdmission: true });
    expect(decide({ kind: 'WEBSOCKET', url: 'wss://app.example.com/live' }, NO_AFTER_PRESS)).toMatchObject({ action: 'BLOCK' });
  });

  it('keeps the approved write in the payload check first, and does not pass the endpoint and below before the approved write responded', () => {
    // 承認の送信先への main frame の form の送信（残り 1）は、照合にかける判定のまま（Guard が本文を照らす）。
    expect(decide(facts('POST', `${APP_ORIGIN}/members`, { navigation: true }), afterPress(false))).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    // 照合が止めた後（残り 0）と、応答を受ける前は、承認の送信先とその下を通さない（押して書き換えた本文を、もう一度送る形を含む）。
    const spent = afterPress(false, 0);
    for (const path of ['/members', '/members/', '/MEMBERS', '/members/1/confirm', '/%6dembers']) {
      expect(decide(facts('POST', `${APP_ORIGIN}${path}`, { navigation: true }), spent), path).toMatchObject({ action: 'BLOCK' });
      expect(decide(facts('POST', `${APP_ORIGIN}${path}`), spent), path).toMatchObject({ action: 'BLOCK' });
    }
    // ほかの path は、応答の前でも通す。
    expect(decide(facts('POST', `${APP_ORIGIN}/drafts`), spent)).toEqual(PASSED);
  });

  it('keeps the API approved write in the payload check and guards the concrete check path before the response', () => {
    const api: PassiveRequestPolicyOptions = {
      writeStage: Object.freeze({
        writeEndpoint: Object.freeze({ origin: OTHER_ORIGIN, path: '/api/items/{id}' }),
        apiOrigin: OTHER_ORIGIN,
        apiWritePath: '/api/items/4',
        remainingPosts: 0,
        submissionWindowOpen: true,
        valuesEntered: true,
        afterPress: Object.freeze({ approvedWriteResponded: false }),
      }),
    };
    expect(decide(facts('PATCH', `${OTHER_ORIGIN}/api/items/4`), api)).toMatchObject({ action: 'BLOCK' });
    expect(decide(facts('PATCH', `${OTHER_ORIGIN}/api/items`), api)).toMatchObject({ action: 'BLOCK' });
    expect(decide(facts('POST', `${OTHER_ORIGIN}/api/notes/1`), api)).toEqual(PASSED);
  });

  it('does not use the after-press policy without it (READ_ONLY)', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/events/1`), NO_AFTER_PRESS)).toMatchObject({ action: 'BLOCK' });
    // RB-4b: READ_ONLY が止めるのは読み取りでない要求だけ（許可の外の読み取りは通す）。
    expect(decide(facts('GET', `${OTHER_ORIGIN}/pixel.gif`), NO_AFTER_PRESS)).toMatchObject({ action: 'ALLOW' });
  });
});
