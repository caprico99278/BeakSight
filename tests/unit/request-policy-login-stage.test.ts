// T26g-1（Task 26 の設計書 4.4、変更履歴の「T26R」の行の C1 の (1)・(2)、「Blocker: T26g-1」の行）: 要求の判定（`classifyPassiveRequest`）の
// ログインの段の口（`authSetup`）の、許可 Origin の制限と、自動ログインの送信の窓。
// - ログインの段では、許可 Origin の外への GET と HEAD のサブリソースとサブ frame のナビゲーションを止める（`LOGIN_STAGE` の
//   `OUTSIDE_ALLOWED_ORIGINS`）。main frame の移動、GET と HEAD 以外、WebSocket は、今の判定のまま止める（記録の種類も今のまま）。
// - 送信の窓が開いている間は、許した送信先への main frame のナビゲーションの POST のほかの読み取りの要求を、同じ Origin でも止める
//   （`SUBMISSION_WINDOW`）。ブラウザ自身の `GET <許可 Origin>/favicon.ico`（query と fragment なし）だけは、止めるが理由を分ける
//   （`SUBMISSION_WINDOW_BROWSER_FAVICON`。値を運べない）。query つきの favicon は `SUBMISSION_WINDOW`。
//   すでに今の判定で止まる要求（GET と HEAD 以外、許可 Origin の外への main frame の移動、WebSocket）は、窓の中でも今の判定のまま
//   （窓の中で止めたことは、Guard がログインの段の記録に数える）。
// - ログインの段の口がない（公開監査と監査の段）ときの判定は変わらない。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  BROWSER_DEFAULT_FAVICON_PATH,
  LOGIN_STAGE_BLOCK_REASONS,
  classifyPassiveRequest,
  type HttpRequestFacts,
  type LoginStagePolicy,
  type PassiveRequestDecision,
} from '../../src/safety/request-policy.js';

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(['https://example.com']);
const LOGIN_URL = 'https://example.com/login';
const OUTSIDE_URL = 'https://example.invalid/pixel?u=marker';
const SAME_ORIGIN_URL = 'https://example.com/pixel?u=marker';

const CLOSED: LoginStagePolicy = Object.freeze({
  loginPostEndpoints: Object.freeze([Object.freeze({ origin: 'https://example.com', path: '/login' })]),
  remainingPosts: 1,
});
const OPEN: LoginStagePolicy = Object.freeze({ ...CLOSED, submissionWindowOpen: true });

const outside: PassiveRequestDecision = { action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'OUTSIDE_ALLOWED_ORIGINS' };
const inWindow: PassiveRequestDecision = { action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'SUBMISSION_WINDOW' };
const favicon: PassiveRequestDecision = { action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'SUBMISSION_WINDOW_BROWSER_FAVICON' };

const request = (method: string, url: string, isNavigationRequest: boolean, isMainFrame: boolean): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest, isMainFrame });
const subresource = (method: string, url: string): HttpRequestFacts => request(method, url, false, false);
const subFrame = (method: string, url: string): HttpRequestFacts => request(method, url, true, false);
const mainFrame = (method: string, url: string): HttpRequestFacts => request(method, url, true, true);

describe('T26g-1: the login stage keeps every request inside the allowed origins', () => {
  it('closes the list of the login stage reasons', () => {
    expect(LOGIN_STAGE_BLOCK_REASONS).toEqual(['OUTSIDE_ALLOWED_ORIGINS', 'SUBMISSION_WINDOW', 'SUBMISSION_WINDOW_BROWSER_FAVICON']);
    expect(BROWSER_DEFAULT_FAVICON_PATH).toBe('/favicon.ico');
  });

  it.each(['GET', 'HEAD'])('blocks a %s sub resource and a sub frame navigation outside the allowed origins', (method) => {
    expect(classifyPassiveRequest(subresource(method, OUTSIDE_URL), ALLOWED_ORIGINS, { authSetup: CLOSED })).toEqual(outside);
    expect(classifyPassiveRequest(subFrame(method, OUTSIDE_URL), ALLOWED_ORIGINS, { authSetup: CLOSED })).toEqual(outside);
  });

  it('blocks an unparsable URL of a sub resource (fail closed)', () => {
    expect(classifyPassiveRequest(subresource('GET', 'not a url'), ALLOWED_ORIGINS, { authSetup: CLOSED })).toEqual(outside);
  });

  it('keeps the current decisions (and records) for the other requests outside the allowed origins', () => {
    const policy = { authSetup: CLOSED };
    expect(classifyPassiveRequest(mainFrame('GET', OUTSIDE_URL), ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    expect(classifyPassiveRequest(subresource('POST', OUTSIDE_URL), ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
    expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: 'wss://example.invalid/ws' }, ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
  });

  it('allows reading inside the allowed origins and the allowed login POST while the window is closed', () => {
    const policy = { authSetup: CLOSED };
    expect(classifyPassiveRequest(subresource('GET', SAME_ORIGIN_URL), ALLOWED_ORIGINS, policy)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
    expect(classifyPassiveRequest(mainFrame('GET', SAME_ORIGIN_URL), ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(classifyPassiveRequest(mainFrame('POST', LOGIN_URL), ALLOWED_ORIGINS, policy)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
  });

  it('does not change the decisions without the login stage (public audit and the audit stage)', () => {
    expect(classifyPassiveRequest(subresource('GET', OUTSIDE_URL), ALLOWED_ORIGINS)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
    expect(classifyPassiveRequest(subFrame('GET', OUTSIDE_URL), ALLOWED_ORIGINS, {})).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
  });
});

describe('T26g-1: the submission window of the automated login', () => {
  it('allows only the allowed login POST', () => {
    expect(classifyPassiveRequest(mainFrame('POST', LOGIN_URL), ALLOWED_ORIGINS, { authSetup: OPEN }))
      .toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
  });

  it.each([
    ['a same origin image', subresource('GET', SAME_ORIGIN_URL)],
    ['a same origin HEAD', subresource('HEAD', SAME_ORIGIN_URL)],
    ['a same origin main frame GET (a form switched to GET)', mainFrame('GET', `${LOGIN_URL}?user=marker`)],
    ['a same origin sub frame', subFrame('GET', SAME_ORIGIN_URL)],
    ['an outside image', subresource('GET', OUTSIDE_URL)],
    ['a favicon with a query', subresource('GET', `https://example.com${'/favicon.ico'}?u=marker`)],
    ['a favicon outside the allowed origins', subresource('GET', 'https://example.invalid/favicon.ico')],
    ['a favicon of another path', subresource('GET', 'https://example.com/favicon.ico/x')],
  ])('blocks %s as the submission window', (_name, facts) => {
    expect(classifyPassiveRequest(facts, ALLOWED_ORIGINS, { authSetup: OPEN })).toEqual(inWindow);
  });

  it('separates the plain browser favicon of an allowed origin (it cannot carry a value)', () => {
    expect(classifyPassiveRequest(subresource('GET', 'https://example.com/favicon.ico'), ALLOWED_ORIGINS, { authSetup: OPEN })).toEqual(favicon);
    expect(classifyPassiveRequest(subresource('GET', 'https://example.com/favicon.ico#x'), ALLOWED_ORIGINS, { authSetup: OPEN })).toEqual(inWindow);
    expect(classifyPassiveRequest(subresource('HEAD', 'https://example.com/favicon.ico'), ALLOWED_ORIGINS, { authSetup: OPEN })).toEqual(inWindow);
  });

  it('keeps the current decisions (and records) for the non-read requests, the outside main frame and the WebSocket in the window', () => {
    const policy = { authSetup: OPEN };
    expect(classifyPassiveRequest(mainFrame('GET', OUTSIDE_URL), ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    expect(classifyPassiveRequest(subresource('POST', SAME_ORIGIN_URL), ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' });
    expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: 'wss://example.com/ws' }, ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
  });
});
