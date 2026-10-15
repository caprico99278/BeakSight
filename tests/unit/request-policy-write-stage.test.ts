// T30b（Task 30 の設計書 `2026-10-13-beaksight-task-30-approved-create-design.md` 3 章の「書き込みの段」、4 章、5 章）: 要求の判定
// （`classifyPassiveRequest`）の書き込みの段の口（`writeStage`）。
// - 書き込みの段では、承認の要求の形（Origin と path。query と fragment なし）に完全に一致する main frame のナビゲーションの POST だけを、
//   残りの回数が 1 のときに ALLOW する（送る中身の照合は、その後に Guard が行う）。
// - 許可 Origin の外の読み取りの要求と、送信の窓の中のすべての読み取りの要求を `WRITE_STAGE` で止める（ログインの段と同じ考え方）。
// - ログインの段・公開監査・認証つきの監査の判定は変わらない（固定の表。作成の時点の値をそのまま期待値として書いた golden）。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  SUBMISSION_STAGE_BLOCK_REASONS,
  WRITE_STAGE_BLOCK_REASONS,
  LOGIN_STAGE_BLOCK_REASONS,
  classifyPassiveRequest,
  isWriteEndpointUrl,
  type AuditExclusionPolicy,
  type HttpRequestFacts,
  type LoginStagePolicy,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
  type WriteStagePolicy,
} from '../../src/safety/request-policy.js';

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(['https://example.com']);
const WRITE_URL = 'https://example.com/items';
const SAME_ORIGIN_URL = 'https://example.com/pixel?u=marker';
const OUTSIDE_URL = 'https://example.invalid/pixel?u=marker';

const WRITE_CLOSED: WriteStagePolicy = Object.freeze({
  writeEndpoint: Object.freeze({ origin: 'https://example.com', path: '/items' }),
  remainingPosts: 1,
});
const WRITE_OPEN: WriteStagePolicy = Object.freeze({ ...WRITE_CLOSED, submissionWindowOpen: true });
const WRITE_SPENT: WriteStagePolicy = Object.freeze({ ...WRITE_CLOSED, remainingPosts: 0 });
const LOGIN_STAGE: LoginStagePolicy = Object.freeze({
  loginPostEndpoints: Object.freeze([Object.freeze({ origin: 'https://example.com', path: '/login' })]),
  remainingPosts: 1,
});
const AUDIT_EXCLUSIONS: AuditExclusionPolicy = Object.freeze({
  excludedPathPrefixes: Object.freeze(['/logout']),
  auditPathPrefixes: Object.freeze([]),
  dangerousTerms: Object.freeze(['delete']),
});

const ALLOW_INSPECT: PassiveRequestDecision = { action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' };
const ALLOW_DIRECT: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT' };
const NON_READ: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };
const EXTERNAL_NAVIGATION: PassiveRequestDecision = { action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' };
const WEBSOCKET: PassiveRequestDecision = { action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' };
const EXCLUDED: PassiveRequestDecision = { action: 'BLOCK', category: 'AUDIT_EXCLUSION', reason: 'AUDIT_EXCLUDED_URL' };
const writeStageBlock = (reason: (typeof WRITE_STAGE_BLOCK_REASONS)[number]): PassiveRequestDecision =>
  ({ action: 'BLOCK', category: 'WRITE_STAGE', reason });
const loginStageBlock = (reason: (typeof LOGIN_STAGE_BLOCK_REASONS)[number]): PassiveRequestDecision =>
  ({ action: 'BLOCK', category: 'LOGIN_STAGE', reason });

const request = (method: string, url: string, isNavigationRequest: boolean, isMainFrame: boolean): HttpRequestFacts =>
  ({ kind: 'HTTP', method, url, isNavigationRequest, isMainFrame });
const mainFrame = (method: string, url: string): HttpRequestFacts => request(method, url, true, true);
const subFrame = (method: string, url: string): HttpRequestFacts => request(method, url, true, false);
const subresource = (method: string, url: string): HttpRequestFacts => request(method, url, false, false);

describe('T30b: the reasons of the write stage are the reasons of the login stage (one list)', () => {
  it('shares the closed list', () => {
    expect(WRITE_STAGE_BLOCK_REASONS).toBe(SUBMISSION_STAGE_BLOCK_REASONS);
    expect(LOGIN_STAGE_BLOCK_REASONS).toBe(SUBMISSION_STAGE_BLOCK_REASONS);
    expect(SUBMISSION_STAGE_BLOCK_REASONS).toEqual(['OUTSIDE_ALLOWED_ORIGINS', 'SUBMISSION_WINDOW', 'SUBMISSION_WINDOW_BROWSER_FAVICON']);
  });
});

describe('T30b: the write stage table', () => {
  it.each<[string, HttpRequestFacts, WriteStagePolicy, PassiveRequestDecision]>([
    ['the approved POST (window closed)', mainFrame('POST', WRITE_URL), WRITE_CLOSED, ALLOW_INSPECT],
    ['the approved POST (window open)', mainFrame('POST', WRITE_URL), WRITE_OPEN, ALLOW_INSPECT],
    ['the approved POST after the count is spent', mainFrame('POST', WRITE_URL), WRITE_SPENT, NON_READ],
    ['the approved POST with a query', mainFrame('POST', `${WRITE_URL}?again=1`), WRITE_CLOSED, NON_READ],
    ['the approved POST with an empty query', mainFrame('POST', `${WRITE_URL}?`), WRITE_CLOSED, NON_READ],
    ['the approved POST with a fragment', mainFrame('POST', `${WRITE_URL}#x`), WRITE_CLOSED, NON_READ],
    ['a POST to another path', mainFrame('POST', 'https://example.com/items/1'), WRITE_CLOSED, NON_READ],
    ['a POST to another origin', mainFrame('POST', 'https://example.invalid/items'), WRITE_CLOSED, NON_READ],
    ['a POST with credentials in the URL', mainFrame('POST', 'https://u:p@example.com/items'), WRITE_CLOSED, NON_READ],
    ['the approved URL from a sub frame', subFrame('POST', WRITE_URL), WRITE_CLOSED, NON_READ],
    ['the approved URL from a sub resource (fetch, beacon)', subresource('POST', WRITE_URL), WRITE_CLOSED, NON_READ],
    ['a PUT to the approved URL', mainFrame('PUT', WRITE_URL), WRITE_CLOSED, NON_READ],
    ['a lowercase post', mainFrame('post', WRITE_URL), WRITE_CLOSED, NON_READ],
    ['a GET of the approved URL (window closed)', mainFrame('GET', WRITE_URL), WRITE_CLOSED, ALLOW_INSPECT],
    ['a GET of the approved URL (window open: a form switched to GET)', mainFrame('GET', `${WRITE_URL}?name=marker`), WRITE_OPEN, writeStageBlock('SUBMISSION_WINDOW')],
    ['a same origin image (window closed)', subresource('GET', SAME_ORIGIN_URL), WRITE_CLOSED, ALLOW_DIRECT],
    ['a same origin image (window open)', subresource('GET', SAME_ORIGIN_URL), WRITE_OPEN, writeStageBlock('SUBMISSION_WINDOW')],
    ['a same origin sub frame (window open)', subFrame('GET', SAME_ORIGIN_URL), WRITE_OPEN, writeStageBlock('SUBMISSION_WINDOW')],
    ['the plain browser favicon (window open)', subresource('GET', 'https://example.com/favicon.ico'), WRITE_OPEN, writeStageBlock('SUBMISSION_WINDOW_BROWSER_FAVICON')],
    ['an outside image (window closed)', subresource('GET', OUTSIDE_URL), WRITE_CLOSED, writeStageBlock('OUTSIDE_ALLOWED_ORIGINS')],
    ['an outside sub frame (window closed)', subFrame('GET', OUTSIDE_URL), WRITE_CLOSED, writeStageBlock('OUTSIDE_ALLOWED_ORIGINS')],
    ['an outside HEAD (window closed)', subresource('HEAD', OUTSIDE_URL), WRITE_CLOSED, writeStageBlock('OUTSIDE_ALLOWED_ORIGINS')],
    ['an unparsable URL', subresource('GET', 'not a url'), WRITE_CLOSED, writeStageBlock('OUTSIDE_ALLOWED_ORIGINS')],
    ['an outside main frame (window closed)', mainFrame('GET', OUTSIDE_URL), WRITE_CLOSED, EXTERNAL_NAVIGATION],
    ['an outside main frame (window open)', mainFrame('GET', OUTSIDE_URL), WRITE_OPEN, EXTERNAL_NAVIGATION],
    ['a same origin POST sub resource (window open)', subresource('POST', SAME_ORIGIN_URL), WRITE_OPEN, NON_READ],
  ])('%s', (_name, facts, writeStage, expected) => {
    expect(classifyPassiveRequest(facts, ALLOWED_ORIGINS, { writeStage })).toEqual(expected);
  });

  it('blocks every WebSocket in the write stage', () => {
    expect(classifyPassiveRequest({ kind: 'WEBSOCKET', url: 'wss://example.com/ws' }, ALLOWED_ORIGINS, { writeStage: WRITE_OPEN })).toEqual(WEBSOCKET);
  });

  it('blocks the approved POST when the approved origin is not an allowed origin', () => {
    expect(classifyPassiveRequest(mainFrame('POST', WRITE_URL), new Set(['https://example.invalid']), { writeStage: WRITE_CLOSED })).toEqual(NON_READ);
  });

  it('applies the audit exclusions to the reads of the write stage, after the approved POST', () => {
    const policy: PassiveRequestPolicyOptions = { writeStage: WRITE_CLOSED, auditExclusions: AUDIT_EXCLUSIONS };
    expect(classifyPassiveRequest(mainFrame('GET', 'https://example.com/logout'), ALLOWED_ORIGINS, policy)).toEqual(EXCLUDED);
    expect(classifyPassiveRequest(mainFrame('POST', WRITE_URL), ALLOWED_ORIGINS, policy)).toEqual(ALLOW_INSPECT);
  });

  it('allows neither POST when both the login stage and the write stage are given (fail closed)', () => {
    const both: PassiveRequestPolicyOptions = { authSetup: LOGIN_STAGE, writeStage: WRITE_CLOSED };
    expect(classifyPassiveRequest(mainFrame('POST', WRITE_URL), ALLOWED_ORIGINS, both)).toEqual(NON_READ);
    expect(classifyPassiveRequest(mainFrame('POST', 'https://example.com/login'), ALLOWED_ORIGINS, both)).toEqual(NON_READ);
    expect(classifyPassiveRequest(subresource('GET', OUTSIDE_URL), ALLOWED_ORIGINS, both)).toEqual(loginStageBlock('OUTSIDE_ALLOWED_ORIGINS'));
  });

  it('compares the write endpoint URL in the same way (isWriteEndpointUrl)', () => {
    const endpoint = WRITE_CLOSED.writeEndpoint;
    expect(isWriteEndpointUrl(WRITE_URL, endpoint)).toBe(true);
    expect(isWriteEndpointUrl('https://example.com/a/../items', endpoint)).toBe(true);
    expect(isWriteEndpointUrl('HTTPS://EXAMPLE.COM/items', endpoint)).toBe(true);
    for (const url of [`${WRITE_URL}?x`, `${WRITE_URL}?`, `${WRITE_URL}#`, 'https://example.com/Items', 'https://example.com/it%65ms', 'https://u@example.com/items', 'x']) {
      expect(isWriteEndpointUrl(url, endpoint), url).toBe(false);
    }
  });
});

/**
 * 固定の表（作成の時点の値。T30b の前と同じ判定であることを確かめる golden）。ログインの段（窓の開け閉め）・公開監査（口なし）・認証つきの監査
 * （除外の口だけ）で、代表の要求の判定が変わらない。
 */
describe('T30b: the decisions of the login stage, the public audit and the authenticated audit do not change', () => {
  const LOGIN_OPEN: LoginStagePolicy = Object.freeze({ ...LOGIN_STAGE, submissionWindowOpen: true });
  const cases: readonly (readonly [string, HttpRequestFacts, PassiveRequestPolicyOptions | undefined, PassiveRequestDecision])[] = [
    ['public: approved-looking POST', mainFrame('POST', WRITE_URL), undefined, NON_READ],
    ['public: same origin GET', mainFrame('GET', WRITE_URL), undefined, ALLOW_INSPECT],
    ['public: outside image', subresource('GET', OUTSIDE_URL), undefined, ALLOW_DIRECT],
    ['public: outside main frame', mainFrame('GET', OUTSIDE_URL), undefined, EXTERNAL_NAVIGATION],
    ['public: same origin POST sub resource', subresource('POST', SAME_ORIGIN_URL), {}, NON_READ],
    ['audit: POST', mainFrame('POST', WRITE_URL), { auditExclusions: AUDIT_EXCLUSIONS }, NON_READ],
    ['audit: excluded GET', mainFrame('GET', 'https://example.com/logout'), { auditExclusions: AUDIT_EXCLUSIONS }, EXCLUDED],
    ['audit: dangerous term', subresource('GET', 'https://example.com/items/1/delete'), { auditExclusions: AUDIT_EXCLUSIONS }, EXCLUDED],
    ['audit: outside image', subresource('GET', OUTSIDE_URL), { auditExclusions: AUDIT_EXCLUSIONS }, ALLOW_DIRECT],
    ['audit: same origin GET', subresource('GET', SAME_ORIGIN_URL), { auditExclusions: AUDIT_EXCLUSIONS }, ALLOW_DIRECT],
    ['login: login POST', mainFrame('POST', 'https://example.com/login'), { authSetup: LOGIN_STAGE }, ALLOW_INSPECT],
    ['login: login POST with a query', mainFrame('POST', 'https://example.com/login?next=1'), { authSetup: LOGIN_STAGE }, ALLOW_INSPECT],
    ['login: login POST spent', mainFrame('POST', 'https://example.com/login'), { authSetup: { ...LOGIN_STAGE, remainingPosts: 0 } }, NON_READ],
    ['login: other POST', mainFrame('POST', WRITE_URL), { authSetup: LOGIN_STAGE }, NON_READ],
    ['login: outside image', subresource('GET', OUTSIDE_URL), { authSetup: LOGIN_STAGE }, loginStageBlock('OUTSIDE_ALLOWED_ORIGINS')],
    ['login: same origin image in the window', subresource('GET', SAME_ORIGIN_URL), { authSetup: LOGIN_OPEN }, loginStageBlock('SUBMISSION_WINDOW')],
    ['login: favicon in the window', subresource('GET', 'https://example.com/favicon.ico'), { authSetup: LOGIN_OPEN }, loginStageBlock('SUBMISSION_WINDOW_BROWSER_FAVICON')],
    ['login: same origin image outside the window', subresource('GET', SAME_ORIGIN_URL), { authSetup: LOGIN_STAGE }, ALLOW_DIRECT],
    ['login with exclusions: login POST', mainFrame('POST', 'https://example.com/login'), { authSetup: LOGIN_STAGE, auditExclusions: AUDIT_EXCLUSIONS }, ALLOW_INSPECT],
  ];
  it.each(cases)('%s', (_name, facts, policy, expected) => {
    expect(classifyPassiveRequest(facts, ALLOWED_ORIGINS, policy)).toEqual(expected);
  });
});
