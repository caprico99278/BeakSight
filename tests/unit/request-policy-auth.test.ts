// T25b（Task 25 の設計書 `2026-10-10-beaksight-task-25-manual-login-session-design.md` 4.2、5 章）: 要求の判定
// （`classifyPassiveRequest`）の 2 つの省略できる口。
// - ログインの段の口（`authSetup`）: 許した Origin と path への、main frame のナビゲーションの POST だけを、残りの回数が 1 以上のときに
//   ALLOW する。query は問わない（path までで比べる）。path は URL の解析器の正規化（dot segment の解決）の後の値で、大文字と小文字を
//   区別して完全一致で比べる（percent-encode は decode しない。許す側の一覧なので、違う書き方は止まる側に倒す）。
// - 監査の段の除外の口（`auditExclusions`）: 許可 Origin への GET と HEAD でも、除外のパス・範囲の外・危険な語に当たる URL を BLOCK する。
// - どちらの口もないときは、今の判定（Task 22 の golden）と同じ。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  classifyPassiveRequest,
  type AuditExclusionPolicy,
  type HttpRequestFacts,
  type LoginStagePolicy,
  type PassiveRequestDecision,
} from '../../src/safety/request-policy.js';

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(['https://example.com']);
const LOGIN_URL = 'https://example.com/login';

const ALLOW_INSPECT_REDIRECTS: PassiveRequestDecision = { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
const ALLOW_DIRECT: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT' };
const BLOCK_NON_READ_METHOD: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
const BLOCK_EXTERNAL_NAVIGATION: PassiveRequestDecision = {
  action: 'BLOCK',
  category: 'NAVIGATION',
  reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION',
};
const BLOCK_AUDIT_EXCLUDED: PassiveRequestDecision = {
  action: 'BLOCK',
  category: 'AUDIT_EXCLUSION',
  reason: 'AUDIT_EXCLUDED_URL',
};

const LOGIN_STAGE: LoginStagePolicy = Object.freeze({
  loginPostEndpoints: Object.freeze([Object.freeze({ origin: 'https://example.com', path: '/login' })]),
  remainingPosts: 1,
});

const mainFrameNavigation = (method: string, url: string): HttpRequestFacts => ({
  kind: 'HTTP',
  method,
  url,
  isNavigationRequest: true,
  isMainFrame: true,
});

describe('T25b: the login stage policy (authSetup) of classifyPassiveRequest', () => {
  it('allows a main frame navigation POST to an allowed login endpoint while posts remain', () => {
    expect(classifyPassiveRequest(mainFrameNavigation('POST', LOGIN_URL), ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE }))
      .toEqual(ALLOW_INSPECT_REDIRECTS);
  });

  it('ignores the query of the request (the endpoint is the origin and the path)', () => {
    expect(classifyPassiveRequest(
      mainFrameNavigation('POST', `${LOGIN_URL}?next=%2Fadmin`),
      ALLOWED_ORIGINS,
      { authSetup: LOGIN_STAGE },
    )).toEqual(ALLOW_INSPECT_REDIRECTS);
  });

  it('compares the path after the URL parser resolves dot segments, on both the endpoint and the request', () => {
    const dotted: LoginStagePolicy = {
      loginPostEndpoints: [{ origin: 'https://example.com', path: '/account/../login' }],
      remainingPosts: 1,
    };
    expect(classifyPassiveRequest(mainFrameNavigation('POST', LOGIN_URL), ALLOWED_ORIGINS, { authSetup: dotted }))
      .toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classifyPassiveRequest(
      mainFrameNavigation('POST', 'https://example.com/account/../login'),
      ALLOWED_ORIGINS,
      { authSetup: LOGIN_STAGE },
    )).toEqual(ALLOW_INSPECT_REDIRECTS);
  });

  it('blocks a POST that is not a navigation (fetch, XHR, sendBeacon) to the login endpoint', () => {
    expect(classifyPassiveRequest({
      kind: 'HTTP',
      method: 'POST',
      url: LOGIN_URL,
      isNavigationRequest: false,
      isMainFrame: false,
    }, ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE })).toEqual(BLOCK_NON_READ_METHOD);
    expect(classifyPassiveRequest({
      kind: 'HTTP',
      method: 'POST',
      url: LOGIN_URL,
      isNavigationRequest: false,
      isMainFrame: true,
    }, ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE })).toEqual(BLOCK_NON_READ_METHOD);
  });

  it('blocks a navigation POST of a sub frame to the login endpoint', () => {
    expect(classifyPassiveRequest({
      kind: 'HTTP',
      method: 'POST',
      url: LOGIN_URL,
      isNavigationRequest: true,
      isMainFrame: false,
    }, ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE })).toEqual(BLOCK_NON_READ_METHOD);
  });

  it.each([
    ['a trailing slash', 'https://example.com/login/'],
    ['another letter case', 'https://example.com/Login'],
    ['a longer path', 'https://example.com/login2'],
    ['a child path', 'https://example.com/login/extra'],
    ['another path', 'https://example.com/admin/update'],
    ['a percent-encoded letter', 'https://example.com/%6Cogin'],
    ['another scheme', 'http://example.com/login'],
    ['another port', 'https://example.com:8443/login'],
    ['another host', 'https://example.invalid/login'],
    ['credentials in the URL', 'https://user:secret@example.com/login'],
    ['an unparsable URL', 'not a URL'],
  ])('blocks a main frame navigation POST to %s', (_label, url) => {
    expect(classifyPassiveRequest(mainFrameNavigation('POST', url), ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE }))
      .toEqual(BLOCK_NON_READ_METHOD);
  });

  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'blocks the login POST when the remaining posts are %s (an integer of 1 or more is required)',
    (remainingPosts) => {
      expect(classifyPassiveRequest(
        mainFrameNavigation('POST', LOGIN_URL),
        ALLOWED_ORIGINS,
        { authSetup: { ...LOGIN_STAGE, remainingPosts } },
      )).toEqual(BLOCK_NON_READ_METHOD);
    },
  );

  it.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post'])('blocks the method %s to the login endpoint', (method) => {
    expect(classifyPassiveRequest(mainFrameNavigation(method, LOGIN_URL), ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE }))
      .toEqual(BLOCK_NON_READ_METHOD);
  });

  it('blocks a login endpoint whose origin is not an allowed origin (both lists must agree)', () => {
    const outside: LoginStagePolicy = {
      loginPostEndpoints: [{ origin: 'https://example.invalid', path: '/login' }],
      remainingPosts: 1,
    };
    expect(classifyPassiveRequest(
      mainFrameNavigation('POST', 'https://example.invalid/login'),
      ALLOWED_ORIGINS,
      { authSetup: outside },
    )).toEqual(BLOCK_NON_READ_METHOD);
  });

  it.each([
    ['a relative path without the leading slash', 'login'],
    ['a scheme-relative path', '//example.com/login'],
    ['a path with a query', '/login?x=1'],
    ['a path with a fragment', '/login#x'],
    ['an empty path', ''],
  ])('never matches an endpoint with %s (fail closed)', (_label, path) => {
    const malformed: LoginStagePolicy = { loginPostEndpoints: [{ origin: 'https://example.com', path }], remainingPosts: 1 };
    expect(classifyPassiveRequest(mainFrameNavigation('POST', LOGIN_URL), ALLOWED_ORIGINS, { authSetup: malformed }))
      .toEqual(BLOCK_NON_READ_METHOD);
  });

  it('never matches an endpoint whose origin is not an origin', () => {
    const malformed: LoginStagePolicy = { loginPostEndpoints: [{ origin: 'not an origin', path: '/login' }], remainingPosts: 1 };
    expect(classifyPassiveRequest(mainFrameNavigation('POST', LOGIN_URL), ALLOWED_ORIGINS, { authSetup: malformed }))
      .toEqual(BLOCK_NON_READ_METHOD);
  });

  it('keeps the other decisions: GET and HEAD, the external main frame navigation, and the WebSocket', () => {
    const policy = { authSetup: LOGIN_STAGE };
    expect(classifyPassiveRequest(mainFrameNavigation('GET', LOGIN_URL), ALLOWED_ORIGINS, policy)).toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classifyPassiveRequest(mainFrameNavigation('HEAD', LOGIN_URL), ALLOWED_ORIGINS, policy)).toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classifyPassiveRequest(mainFrameNavigation('GET', 'https://example.invalid/'), ALLOWED_ORIGINS, policy))
      .toEqual(BLOCK_EXTERNAL_NAVIGATION);
    expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: 'wss://example.com/login' }, ALLOWED_ORIGINS, policy))
      .toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
  });
});

/** Task 22 の golden と同じ組み合わせ（7 method × 許可 Origin の内・外 × main frame のナビゲーション・サブリソース）。 */
const GOLDEN_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
const GOLDEN_URLS = ['https://example.com/catalog', 'https://example.invalid/catalog'] as const;
const GOLDEN_SHAPES = [
  { isNavigationRequest: true, isMainFrame: true },
  { isNavigationRequest: false, isMainFrame: false },
] as const;
const GOLDEN_FACTS: readonly HttpRequestFacts[] = GOLDEN_METHODS.flatMap((method) =>
  GOLDEN_URLS.flatMap((url) => GOLDEN_SHAPES.map((shape) => ({ kind: 'HTTP' as const, method, url, ...shape }))));

describe('T25b: the policies leave the golden combinations unchanged when they do not apply', () => {
  it('has the 28 golden combinations', () => {
    expect(GOLDEN_FACTS).toHaveLength(28);
  });

  it.each(GOLDEN_FACTS)('$method $url (navigation $isNavigationRequest) decides the same with an empty policy', (facts) => {
    expect(classifyPassiveRequest(facts, ALLOWED_ORIGINS, {})).toEqual(classifyPassiveRequest(facts, ALLOWED_ORIGINS));
  });

  it.each(GOLDEN_FACTS)('$method $url (navigation $isNavigationRequest) decides the same with a login stage for another path', (facts) => {
    // T26g-1: ログインの段では、許可 Origin の外への GET と HEAD のサブリソースも止める（golden のほかの組み合わせは同じ）。
    const outsideRead = (facts.method === 'GET' || facts.method === 'HEAD') && !facts.isNavigationRequest
      && !facts.url.startsWith('https://example.com/');
    expect(classifyPassiveRequest(facts, ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE })).toEqual(outsideRead
      ? { action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'OUTSIDE_ALLOWED_ORIGINS' }
      : classifyPassiveRequest(facts, ALLOWED_ORIGINS));
  });

  it.each(GOLDEN_FACTS)('$method $url (navigation $isNavigationRequest) decides the same with exclusions that do not match', (facts) => {
    const exclusions: AuditExclusionPolicy = {
      excludedPathPrefixes: ['/logout'],
      auditPathPrefixes: ['/catalog'],
      dangerousTerms: ['delete'],
    };
    expect(classifyPassiveRequest(facts, ALLOWED_ORIGINS, { auditExclusions: exclusions }))
      .toEqual(classifyPassiveRequest(facts, ALLOWED_ORIGINS));
  });
});

const EXCLUSIONS: AuditExclusionPolicy = Object.freeze({
  excludedPathPrefixes: Object.freeze(['/admin/logout', '/admin/session/end']),
  auditPathPrefixes: Object.freeze(['/admin']),
  dangerousTerms: Object.freeze(['logout', 'sign-out', 'delete']),
});

const subresource = (method: string, url: string): HttpRequestFacts => ({
  kind: 'HTTP',
  method,
  url,
  isNavigationRequest: false,
  isMainFrame: false,
});

describe('T25b: the audit stage exclusions (auditExclusions) of classifyPassiveRequest', () => {
  const classify = (facts: HttpRequestFacts): PassiveRequestDecision =>
    classifyPassiveRequest(facts, ALLOWED_ORIGINS, { auditExclusions: EXCLUSIONS });

  it('allows a GET and a HEAD inside the audit paths that hits no exclusion', () => {
    expect(classify(mainFrameNavigation('GET', 'https://example.com/admin/users?page=2'))).toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classify(mainFrameNavigation('HEAD', 'https://example.com/admin'))).toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classify(subresource('GET', 'https://example.com/admin/app.js'))).toEqual(ALLOW_DIRECT);
  });

  it.each([
    ['the excluded path', 'https://example.com/admin/logout'],
    ['a child of the excluded path', 'https://example.com/admin/logout/confirm'],
    ['the excluded path as a string prefix', 'https://example.com/admin/logout-now'],
    ['another excluded path', 'https://example.com/admin/session/end?x=1'],
    ['the excluded path in another letter case', 'https://example.com/admin/LOGOUT'],
    ['the excluded path percent-encoded', 'https://example.com/admin/%6Cogout'],
  ])('blocks %s for the main frame navigation and the sub request', (_label, url) => {
    expect(classify(mainFrameNavigation('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('HEAD', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it.each([
    ['another path', 'https://example.com/public/page'],
    ['the root', 'https://example.com/'],
    ['the audit path in another letter case', 'https://example.com/ADMIN/users'],
    ['an encoded slash that leaves the audit path', 'https://example.com/admin%2F..%2Fpublic'],
  ])('blocks a request outside the audit paths: %s', (_label, url) => {
    expect(classify(mainFrameNavigation('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it('does not limit the paths when the audit paths are empty', () => {
    const unlimited: AuditExclusionPolicy = { ...EXCLUSIONS, auditPathPrefixes: [] };
    expect(classifyPassiveRequest(mainFrameNavigation('GET', 'https://example.com/public/page'), ALLOWED_ORIGINS, {
      auditExclusions: unlimited,
    })).toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classifyPassiveRequest(mainFrameNavigation('GET', 'https://example.com/admin/logout'), ALLOWED_ORIGINS, {
      auditExclusions: unlimited,
    })).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it.each([
    ['in the path', 'https://example.com/admin/items/5/delete'],
    ['in the path in upper case', 'https://example.com/admin/items/5/DELETE'],
    ['in the query', 'https://example.com/admin/items?action=delete'],
    ['in the query in mixed case', 'https://example.com/admin/items?action=DeLeTe'],
    ['in the query name', 'https://example.com/admin/items?sign-out=1'],
    ['percent-encoded in the query', 'https://example.com/admin/items?action=%64elete'],
    ['percent-encoded in the path', 'https://example.com/admin/%6Cogout-all'],
    ['percent-encoded twice', 'https://example.com/admin/items?action=%2564elete'],
    ['as part of a longer word', 'https://example.com/admin/items/undeleted'],
  ])('blocks a dangerous term %s', (_label, url) => {
    expect(classify(mainFrameNavigation('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it('does not look at the fragment (it is not sent to the server)', () => {
    expect(classify(mainFrameNavigation('GET', 'https://example.com/admin/items#delete'))).toEqual(ALLOW_INSPECT_REDIRECTS);
  });

  it('blocks a URL whose percent-encoding cannot be decoded (fail closed)', () => {
    expect(classify(mainFrameNavigation('GET', 'https://example.com/admin/items?q=%E0%A4%A'))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('GET', 'https://example.com/admin/%ZZ'))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it('does not apply the exclusions to the requests outside the allowed origins (they keep the current decisions)', () => {
    expect(classify(subresource('GET', 'https://example.invalid/delete.png'))).toEqual(ALLOW_DIRECT);
    expect(classify(subresource('GET', 'https://example.invalid/public/page'))).toEqual(ALLOW_DIRECT);
    expect(classify(mainFrameNavigation('GET', 'https://example.invalid/admin/logout'))).toEqual(BLOCK_EXTERNAL_NAVIGATION);
  });

  it('keeps the non-read method and the WebSocket decisions first', () => {
    expect(classify(mainFrameNavigation('POST', 'https://example.com/admin/logout'))).toEqual(BLOCK_NON_READ_METHOD);
    expect(classify(subresource('DELETE', 'https://example.com/admin/items'))).toEqual(BLOCK_NON_READ_METHOD);
    expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: 'wss://example.com/admin' }, ALLOWED_ORIGINS, {
      auditExclusions: EXCLUSIONS,
    })).toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
  });

  it('blocks an unparsable URL while the exclusions are given (fail closed; without them it is allowed as today)', () => {
    expect(classify(subresource('GET', 'not a URL'))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classifyPassiveRequest(subresource('GET', 'not a URL'), ALLOWED_ORIGINS)).toEqual(ALLOW_DIRECT);
  });
});

// T25g-1（独立レビュー T25R の C1）: 監査の段の除外は、path の途中の連続した `/`（`/admin//purge`）と、segment の `;` から後の path の
// 引数（`/admin;x=1/purge`）でも外れない。サーバが、連続した `/` を 1 つにまとめる、path の引数を外す、のどちらで読んでもよいように、
// それらの形（percent-encode の decode と `.` `..` の解決との組み合わせを含む）のどれか 1 つでも除外に当たれば止める。読む範囲は、
// すべての形が当たらなければ止める。
describe('T25g-1: the audit stage exclusions are not bypassed by repeated slashes or segment parameters', () => {
  const classify = (facts: HttpRequestFacts): PassiveRequestDecision =>
    classifyPassiveRequest(facts, ALLOWED_ORIGINS, { auditExclusions: EXCLUSIONS });

  it.each([
    ['repeated slashes before the excluded segment', '/admin//session/end'],
    ['repeated slashes inside the excluded path', '/admin/session//end'],
    ['three slashes', '/admin///session///end'],
    ['a parameter on the parent segment', '/admin;x=1/session/end'],
    ['a parameter on the middle segment', '/admin/session;jsessionid=1/end'],
    ['an empty parameter', '/admin;/session/end'],
    ['both together', '/admin;x=1//session;y=2/end'],
    ['an encoded slash that makes repeated slashes', '/admin/%2Fsession/end'],
    ['an encoded slash pair inside the excluded path', '/admin/session%2F%2Fend'],
    ['an encoded semicolon', '/admin%3Bx=1/session/end'],
    ['a twice-encoded semicolon', '/admin%253Bx=1/session/end'],
    ['repeated slashes in upper case', '/admin//SESSION/END'],
    ['a parameter in mixed case', '/admin;X=1/Session/End'],
    ['an encoded letter with repeated slashes', '/admin//%73ession/end'],
  ])('blocks the excluded path with %s', (_label, path) => {
    const url = `https://example.com${path}`;
    expect(classify(mainFrameNavigation('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('HEAD', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it.each([
    // `/admin//../public` そのものは、URL の解析器（とブラウザ）が `/admin/public` に解決してから送るので、encode した `/` で作る。
    ['an encoded slash that makes repeated slashes before a parent segment', '/admin/%2F../public'],
    ['a parameter on the parent segment', '/admin;x=1/..;y=2/public'],
    ['an encoded semicolon on the parent segment', '/admin/..%3Bx=1/public'],
  ])('blocks a path that leaves the audit paths with %s', (_label, path) => {
    const url = `https://example.com${path}`;
    expect(classify(mainFrameNavigation('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it.each([
    ['repeated slashes', '/admin//items/delete'],
    ['a parameter', '/admin;x=1/items/sign-out'],
  ])('still blocks a dangerous term with %s', (_label, path) => {
    expect(classify(subresource('GET', `https://example.com${path}`))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it.each([
    ['repeated slashes', '/admin//users'],
    ['a session parameter', '/admin/users;jsessionid=1'],
    ['a parameter on the audit path', '/admin;x=1/users'],
  ])('keeps allowing a path inside the audit paths that hits no exclusion, with %s', (_label, path) => {
    expect(classify(mainFrameNavigation('GET', `https://example.com${path}`))).toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classify(subresource('GET', `https://example.com${path}`))).toEqual(ALLOW_DIRECT);
  });

  it.each([
    ['repeated slashes', 'https://example.com//login'],
    ['a parameter', 'https://example.com/login;jsessionid=1'],
    ['a trailing parameter', 'https://example.com/login;'],
  ])('keeps the login endpoint an exact match: a POST to the login endpoint written with %s is blocked', (_label, url) => {
    expect(classifyPassiveRequest(mainFrameNavigation('POST', url), ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE }))
      .toEqual(BLOCK_NON_READ_METHOD);
  });

  it('keeps the decisions without the exclusions (public audit) for these spellings', () => {
    for (const path of ['/admin//session/end', '/admin;x=1/session/end', '/admin/%2F../public']) {
      expect(classifyPassiveRequest(mainFrameNavigation('GET', `https://example.com${path}`), ALLOWED_ORIGINS))
        .toEqual(ALLOW_INSPECT_REDIRECTS);
    }
  });
});

// T25g-1 round 1: 除外のパスと危険な語は、decode した path を Unicode の正規化（NFKC）と大文字小文字の畳み込みにかけた形でも比べる
// （`ſ` が `s`、ケルビン記号が `k`、全角の英字と記号が ASCII になる）。読む範囲（`auditPathPrefixes`）の判定は、畳み込みの形を使わない
// （今のまま。大文字と小文字を区別し、すべての形が当たらなければ止める）。
describe('T25g-1 round 1: the audit stage exclusions compare the Unicode-normalized and case-folded forms too', () => {
  /** 畳み込みを確かめるための除外（`k` を含む除外のパスを足す）。 */
  const FOLD_EXCLUSIONS: AuditExclusionPolicy = {
    ...EXCLUSIONS,
    excludedPathPrefixes: [...EXCLUSIONS.excludedPathPrefixes, '/admin/kick'],
  };
  const classify = (facts: HttpRequestFacts): PassiveRequestDecision =>
    classifyPassiveRequest(facts, ALLOWED_ORIGINS, { auditExclusions: FOLD_EXCLUSIONS });

  it.each([
    ['the long s (U+017F) in the excluded path', '/admin/%C5%BFession/end'],
    ['the long s written as is', '/admin/ſession/end'],
    ['the Kelvin sign (U+212A) in the excluded path', '/admin/Kick'],
    ['full-width letters of the excluded path', '/admin/ｓｅｓｓｉｏｎ/ｅｎｄ'],
    ['full-width upper-case letters of the excluded path', '/admin/ＳＥＳＳＩＯＮ/end'],
    ['full-width solidus between the excluded segments', '/admin／session／end'],
    ['a full-width semicolon parameter', '/admin；x=1/session/end'],
    ['full-width letters of a dangerous term', '/admin/items/ｄｅｌｅｔｅ'],
    ['full-width upper-case letters of a dangerous term', '/admin/ＬＯＧＯＵＴ'],
    ['a dangerous term with the long s', '/admin/ſign-out'],
    ['full-width letters of a dangerous term in the query', '/admin/items?op=ｄｅｌｅｔｅ'],
  ])('blocks %s', (_label, path) => {
    const url = `https://example.com${path}`;
    expect(classify(mainFrameNavigation('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(subresource('GET', url))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it.each([
    ['a Japanese path', '/admin/設定/一覧'],
    ['a Japanese path with half-width katakana (NFKC changes it, but it hits no exclusion)', '/admin/ｶﾞｲﾄﾞ'],
    ['full-width letters that hit no exclusion', '/admin/ｕｓｅｒｓ'],
  ])('keeps allowing %s', (_label, path) => {
    const url = `https://example.com${path}`;
    expect(classify(mainFrameNavigation('GET', url))).toEqual(ALLOW_INSPECT_REDIRECTS);
    expect(classify(subresource('GET', url))).toEqual(ALLOW_DIRECT);
  });

  it('does not widen the audit paths by the folded forms: full-width letters of the audit path stay outside', () => {
    expect(classify(mainFrameNavigation('GET', 'https://example.com/ａｄｍｉｎ/users'))).toEqual(BLOCK_AUDIT_EXCLUDED);
    expect(classify(mainFrameNavigation('GET', 'https://example.com/ADMIN/users'))).toEqual(BLOCK_AUDIT_EXCLUDED);
  });

  it('does not use the folded forms for the audit paths: an upper-case audit path keeps matching itself', () => {
    const upperCaseAuditPath: AuditExclusionPolicy = { ...FOLD_EXCLUSIONS, auditPathPrefixes: ['/Admin'] };
    expect(classifyPassiveRequest(mainFrameNavigation('GET', 'https://example.com/Admin/users'), ALLOWED_ORIGINS, {
      auditExclusions: upperCaseAuditPath,
    })).toEqual(ALLOW_INSPECT_REDIRECTS);
  });

  it('keeps the login endpoint an exact match: full-width letters or the long s do not reach the login endpoint', () => {
    for (const url of ['https://example.com/ｌｏｇｉｎ', 'https://example.com/%EF%BD%8Cogin', 'https://example.com/LOGIN']) {
      expect(classifyPassiveRequest(mainFrameNavigation('POST', url), ALLOWED_ORIGINS, { authSetup: LOGIN_STAGE }))
        .toEqual(BLOCK_NON_READ_METHOD);
    }
  });
});
