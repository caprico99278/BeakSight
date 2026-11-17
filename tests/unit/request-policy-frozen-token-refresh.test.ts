// DEF-233（設計書 `doc/design/2026-11-09-beaksight-discovery-token-refresh-design.md` 2.1）: 凍結の段で通してよい、サイトの token の更新の判定
// `isFrozenTokenRefreshAdmissible`（Guard の凍結の判定・凍結の段の事前確認・中継の凍結の受け入れが共用する唯一の部品）と、token の更新の形の判定
// `isTokenRefreshRequest`（凍結で止めた更新を `tokenRefreshBlocked` に数える）。
// fix round 2（SREV-233 の C-1・C-2・M-2）: 本物の更新の形に厳しく限る（押下の観察の間も同じ判定）。本文は成功の鍵の値の中の文字列だけでできた JSON の object。
// header は、凍結の前に通した読み取りの値か、成功の鍵の値か、値の決まったものだけ。query の名前は、必須の query の名前とちょうど同じ。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import { topLevelStringsOf, type FrozenRefreshReference } from '../../src/core/session-key-values.js';
import {
  OAUTH_REFRESH_GRANT_VALUE,
  isFrozenTokenRefreshAdmissible,
  hasReferencedRefreshHeaders,
  refreshQueryValuesOf,
  isTokenRefreshRequest,
  type FrozenTokenRefreshContent,
  type HttpRequestFacts,
  type PassiveRequestPolicyOptions,
} from '../../src/safety/request-policy.js';

const APP = 'https://app.example.test';
const SVC = 'https://svc.example.test';
const TOKEN_PATH = '/auth/v1/token';
const REFRESH_URL = `${SVC}${TOKEN_PATH}?grant_type=refresh_token`;

/** 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の口と、スクリプトで送るログインの監査の段の口（操作さがしの PRIMARY の Passive の Context の形）。 */
const POLICY: PassiveRequestPolicyOptions = {
  auditSend: { approvedServiceOrigins: [SVC], dangerousTerms: [...DEFAULT_EXCLUDED_URL_WORDS] },
  auditStage: {
    approvedServiceOrigins: [SVC],
    auditReadRequests: [],
    scriptLogin: { origin: SVC, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
  },
  auditExclusions: { excludedPathPrefixes: ['/private'], auditPathPrefixes: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS },
};

/**
 * fix round 3（N-1）: 比べの相手。凍結の前に確かめた更新の本文の形（refresh token の文字列 1 つ）と header、今の鍵（本物のサイトの形: access token・refresh token・
 * 期限・種類）の根の文字列。
 */
const REFERENCE: FrozenRefreshReference = {
  bodyShape: ['refresh_token'],
  current: topLevelStringsOf(JSON.stringify({ access_token: 'aAccess01', refresh_token: 'rRefresh01', expires_at_ms: 1, token_type: 'bearer' })),
  headers: new Map([['content-type', 'application/json'], ['apikey', 'kKey01'], ['user-agent', 'UA/1']]),
};
/** 本物の更新の本文（JSON の object に refresh token の文字列 1 つ）。 */
const REAL_BODY = JSON.stringify({ refresh_token: 'rRefresh01' });

const fetchFacts = (method: string, url: string, extra: Partial<HttpRequestFacts> = {}): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, resourceType: 'fetch', ...extra });

const contentOf = (overrides: Partial<FrozenTokenRefreshContent> & { readonly text?: string } = {}): FrozenTokenRefreshContent => ({
  body:() => ({ kind: 'TEXT', text: overrides.text ?? REAL_BODY }),
  headers: { 'Content-Type': 'application/json', apikey: 'kKey01', 'User-Agent': 'UA/1' },
  reference: REFERENCE,
  carriesMarker: () => false,
  ...overrides,
});
const REAL = contentOf();
/** Run の中で凍結の前に通した更新の必須の query の値（既定は覚えていない）。 */
const NO_LEARNED: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const admissible = (
  facts: HttpRequestFacts,
  policy: PassiveRequestPolicyOptions,
  content: FrozenTokenRefreshContent | null,
  learned: ReadonlyMap<string, ReadonlySet<string>> = NO_LEARNED,
): boolean => isFrozenTokenRefreshAdmissible(facts, policy, content, learned);

describe('DEF-233 A1: isFrozenTokenRefreshAdmissible', () => {
  it('admits the real refresh (the registered endpoint, the required query names, a JSON object of a refresh token of the session key)', () => {
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, REAL)).toBe(true);
    expect(admissible(fetchFacts('POST', REFRESH_URL, { resourceType: 'xhr' }), POLICY, REAL)).toBe(true);
    // 中継の形（中身を見ない）は、URL と方針だけを見る。
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, null)).toBe(true);
  });

  // Blocker 1 の後の設計者の判断 (a): 押下の観察の間も同じ判定（観察の間かは見ない）。目印を運ぶものは通さない。
  it('does not admit a request that carries a value the probe entered (the marker)', () => {
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, contentOf({ carriesMarker: () => true }))).toBe(false);
  });

  // fix round 3（N-1）: 本文は、凍結の前に確かめた更新の本文と同じ形で、値は今の鍵の同じ名前の値だけ。
  it('does not admit a body other than the shape of the verified refresh with the values of the same names of the current key (C-1, N-1)', () => {
    const blocked = [
      JSON.stringify({ op: 'wipe' }),
      JSON.stringify({ refresh_token: 'bsprobeMarker1' }),
      // 名前と値の組み替え（access token を refresh token の名前に置く）。
      JSON.stringify({ refresh_token: 'aAccess01' }),
      // 形が違う（名前が増える・別の名前）。
      JSON.stringify({ refresh_token: 'rRefresh01', access_token: 'aAccess01' }),
      JSON.stringify({ a: 'b' }),
      JSON.stringify({ refresh_token: 'rRefresh01', n: 3 }),
      JSON.stringify({ refresh_token: ['rRefresh01'] }),
      JSON.stringify({}),
      JSON.stringify(['rRefresh01']),
      'rRefresh01',
      'refresh_token=rRefresh01',
    ];
    for (const text of blocked) {
      expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, contentOf({ text }))).toBe(false);
    }
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, contentOf({ body: () => ({ kind: 'NONE' }) }))).toBe(false);
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, contentOf({ body: () => ({ kind: 'UNREADABLE' }) }))).toBe(false);
    // 凍結の前に確かめた更新がない Run（比べの相手がない）は、通さない。
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, contentOf({ reference: null }))).toBe(false);
  });

  // fix round 3（N-1）: header は、凍結の前に確かめた更新の要求の header とちょうど同じ（名前の集合と値）。読み取りの header は使わない。
  it('does not admit headers other than exactly the headers of the verified refresh (N-1)', () => {
    const withHeaders = (headers: Readonly<Record<string, string>>): FrozenTokenRefreshContent => contentOf({ headers });
    const real = { 'content-type': 'application/json', apikey: 'kKey01', 'user-agent': 'UA/1' };
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, withHeaders(real))).toBe(true);
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, withHeaders({ ...real, 'x-draft': 'bsprobeMarker1' }))).toBe(false);
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, withHeaders({ ...real, 'x-n0': '0' }))).toBe(false);
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, withHeaders({ ...real, apikey: 'kOther' }))).toBe(false);
    // 名前が足りない（名前の有無で運ぶ形）。
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, withHeaders({ 'content-type': 'application/json', apikey: 'kKey01' }))).toBe(false);
    expect(hasReferencedRefreshHeaders({ 'Content-Type': 'application/json', APIKEY: 'kKey01', 'User-Agent': 'UA/1' }, REFERENCE)).toBe(true);
    expect(hasReferencedRefreshHeaders(undefined, REFERENCE)).toBe(false);
  });

  it('does not admit query names other than the required query names (M-2)', () => {
    for (const url of [`${REFRESH_URL}&decoy=x`, `${REFRESH_URL}&grant_type=refresh_token`, `${SVC}${TOKEN_PATH}`, `${SVC}${TOKEN_PATH}?other=refresh_token`,
      `${SVC}${TOKEN_PATH}?grant_type=password&decoy=x`]) {
      expect(admissible(fetchFacts('POST', url), POLICY, REAL)).toBe(false);
      expect(admissible(fetchFacts('POST', url), POLICY, null)).toBe(false);
    }
  });

  // 必須の query の値は、OAuth の標準の更新の値か、Run の中で凍結の前に通した更新の値だけ（値が違うと、サーバでは別の処理になりうる）。
  it('admits the required query value only when it is the standard refresh value or a value learned before the freeze in the Run', () => {
    expect(OAUTH_REFRESH_GRANT_VALUE).toBe('refresh_token');
    const other = `${SVC}${TOKEN_PATH}?grant_type=refresh_token_press`;
    expect(admissible(fetchFacts('POST', other), POLICY, REAL)).toBe(false);
    expect(admissible(fetchFacts('POST', other), POLICY, null)).toBe(false);
    const learned: ReadonlyMap<string, ReadonlySet<string>> = new Map([['grant_type', new Set(['refresh_token_press'])]]);
    expect(admissible(fetchFacts('POST', other), POLICY, REAL, learned)).toBe(true);
    expect(admissible(fetchFacts('POST', other), POLICY, null, learned)).toBe(true);
    // fix round 4（3 回目の確かめ直しの M-1）: 覚えた値があるときは、その値だけ（標準の値も通さない）。
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, REAL, learned)).toBe(false);
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, null, learned)).toBe(false);
    // 覚えた値が標準の値なら、標準の値を通す。
    const standard: ReadonlyMap<string, ReadonlySet<string>> = new Map([['grant_type', new Set([OAUTH_REFRESH_GRANT_VALUE])]]);
    expect(admissible(fetchFacts('POST', REFRESH_URL), POLICY, REAL, standard)).toBe(true);
    expect(admissible(fetchFacts('POST', other), POLICY, REAL, standard)).toBe(false);
    expect(refreshQueryValuesOf(other, POLICY)).toEqual([['grant_type', 'refresh_token_press']]);
    expect(refreshQueryValuesOf(`${other}&decoy=x`, POLICY)).toEqual([]);
  });

  it('does not admit the sign-in itself (the required query), another path, another origin or another method', () => {
    expect(admissible(fetchFacts('POST', `${SVC}${TOKEN_PATH}?grant_type=password`), POLICY, REAL)).toBe(false);
    expect(admissible(fetchFacts('POST', `${SVC}/rest/v1/items?grant_type=refresh_token`), POLICY, REAL)).toBe(false);
    expect(admissible(fetchFacts('POST', `${APP}${TOKEN_PATH}?grant_type=refresh_token`), POLICY, REAL)).toBe(false);
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'post']) {
      expect(admissible(fetchFacts(method, REFRESH_URL), POLICY, REAL)).toBe(false);
    }
  });

  it('does not admit credentials in the URL, a DELETE override or a navigation', () => {
    expect(admissible(fetchFacts('POST', `https://user:secret@svc.example.test${TOKEN_PATH}?grant_type=refresh_token`), POLICY, REAL))
      .toBe(false);
    const overridden = fetchFacts('POST', REFRESH_URL, {
      sentContent: { headers: { 'X-HTTP-Method-Override': 'DELETE' }, formMethodOverrides: () => [] },
    });
    expect(admissible(overridden, POLICY, REAL)).toBe(false);
    expect(admissible(fetchFacts('POST', REFRESH_URL, { isNavigationRequest: true, resourceType: 'document' }), POLICY, REAL))
      .toBe(false);
  });

  it('does not admit under READ_ONLY (no audit send policy) or without the audit stage', () => {
    const { auditSend: _send, ...readOnly } = POLICY;
    void _send;
    expect(admissible(fetchFacts('POST', REFRESH_URL), readOnly, REAL)).toBe(false);
    const { auditStage: _stage, ...noStage } = POLICY;
    void _stage;
    expect(admissible(fetchFacts('POST', REFRESH_URL), noStage, REAL)).toBe(false);
  });

  it('does not admit in a context that withholds the service origin requests, nor with the write stage (RB-14b: the login stage cannot come with the audit stage)', () => {
    const withheld: PassiveRequestPolicyOptions = { ...POLICY, auditStage: { ...POLICY.auditStage!, serviceOriginRequestsWithheld: true } };
    expect(admissible(fetchFacts('POST', REFRESH_URL), withheld, REAL)).toBe(false);
    const write: PassiveRequestPolicyOptions = { ...POLICY, writeStage: { writeEndpoint: { origin: APP, path: '/save' }, remainingPosts: 1 } };
    expect(admissible(fetchFacts('POST', REFRESH_URL), write, REAL)).toBe(false);
  });

  it('does not read the body or the marker of a request that fails the URL conditions (read only when needed)', () => {
    let read = 0;
    const counted = contentOf({ body: () => { read += 1; return { kind: 'TEXT', text: REAL_BODY }; }, carriesMarker: () => { read += 1; return false; } });
    admissible(fetchFacts('GET', REFRESH_URL), POLICY, counted);
    admissible(fetchFacts('POST', `${REFRESH_URL}&next=logout`), POLICY, counted);
    expect(read).toBe(0);
    admissible(fetchFacts('POST', REFRESH_URL), POLICY, counted);
    expect(read).toBe(2);
  });
});

describe('DEF-233 A1: isTokenRefreshRequest (the shape counted as tokenRefreshBlocked)', () => {
  it('is the token refresh shape of the audit stage, whatever the audit send policy', () => {
    expect(isTokenRefreshRequest(fetchFacts('POST', REFRESH_URL), POLICY)).toBe(true);
    const { auditSend: _send, ...readOnly } = POLICY;
    void _send;
    expect(isTokenRefreshRequest(fetchFacts('POST', REFRESH_URL), readOnly)).toBe(true);
    expect(isTokenRefreshRequest(fetchFacts('POST', `${REFRESH_URL}&next=logout`), POLICY)).toBe(true);
  });

  it('is not the sign-in, another endpoint, another method or a context without the audit stage', () => {
    expect(isTokenRefreshRequest(fetchFacts('POST', `${SVC}${TOKEN_PATH}?grant_type=password`), POLICY)).toBe(false);
    expect(isTokenRefreshRequest(fetchFacts('POST', `${SVC}/rest/v1/items`), POLICY)).toBe(false);
    expect(isTokenRefreshRequest(fetchFacts('GET', REFRESH_URL), POLICY)).toBe(false);
    expect(isTokenRefreshRequest(fetchFacts('POST', REFRESH_URL), {})).toBe(false);
  });
});
