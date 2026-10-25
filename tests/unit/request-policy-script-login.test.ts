// T34b（Task 34 の設計書 `2026-10-16-beaksight-task-34-script-login-design.md` 3.3、4 章）: 要求の判定（`classifyPassiveRequest`）の、
// ログインの段のスクリプトで送るログインの口（`authSetup.scriptRequest`）。
// - 要求の種類（`resourceType`）は、閉じた一覧（`REQUEST_RESOURCE_TYPES`）に正規化する（`requestResourceTypeOf`。知らない値と省略は `other`）。
// - token の送信: `POST`、種類が fetch か xhr、Origin・path・必須の query（名前と値の組の完全な一致。余分な組も重複も許さない）が一致、
//   残りの回数が 1 以上、のときだけ ALLOW（`loginStageAdmission` は `SCRIPT_LOGIN_TOKEN`）。
// - 登録したログインに伴う送信: `POST`、fetch か xhr、Origin と path が一致（query は問わない）、その項目の残りが 1 以上、のときだけ ALLOW
//   （`LOGIN_SIDE_REQUEST` と項目の位置）。
// - それ以外の読み取りでない要求は、今どおり `NON_READ_METHOD` で止め、スクリプトのログインの理由（`SCRIPT_LOGIN_BLOCK_REASONS`）を添える。
// - 承認したサービスの Origin への GET と HEAD（ナビゲーションでない要求）は ALLOW（`SERVICE_ORIGIN_READ`）。main frame の移動は今どおり止め、
//   サブ frame の移動は許可 Origin の外として止める。
// - 送信の窓の中（スクリプトのログイン）で通すのは、token の送信（回数の中）、ログインに伴う送信、サービスの Origin への読み取り、許可 Origin の中の
//   読み取り。それ以外は `SUBMISSION_WINDOW`。
// - スクリプトの口がない（`FORM_NAVIGATION`）ときの判定は変わらない（記録の形も変わらない）。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  REQUEST_RESOURCE_TYPES,
  SCRIPT_LOGIN_BLOCK_REASONS,
  SCRIPT_REQUEST_RESOURCE_TYPES,
  classifyPassiveRequest,
  isLoginEndpointPost,
  requestResourceTypeOf,
  requestResourceTypeOfRequest,
  type HttpRequestFacts,
  type LoginStagePolicy,
  type PassiveRequestDecision,
  type RequestResourceType,
  type ScriptLoginBlockReason,
  type WriteStagePolicy,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const TOKEN_PATH = '/auth/v1/token';
const TOKEN_URL = `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=password`;
const SIDE_PATH = '/functions/v1/sync';
const SIDE_URL = `${SERVICE_ORIGIN}${SIDE_PATH}`;
const APP_SIDE_PATH = '/rest/v1/rpc/tenant';
const APP_SIDE_URL = `${APP_ORIGIN}${APP_SIDE_PATH}`;
const FORM_PATH = '/login';
const FORM_URL = `${APP_ORIGIN}${FORM_PATH}`;
/** 回数の指定（token と、ログインに伴う送信の項目ごと）。 */
const ONE = 1;
const NONE = 0;

/** スクリプトで送るログインの口（token の残り、ログインに伴う送信の各項目の残り、送信の窓）。 */
const scriptStage = (
  remainingPosts: number,
  sideRemaining: readonly [number, number] = [ONE, ONE],
  submissionWindowOpen = false,
): LoginStagePolicy => ({
  loginPostEndpoints: [{ origin: APP_ORIGIN, path: FORM_PATH }],
  remainingPosts,
  submissionWindowOpen,
  scriptRequest: {
    scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
    loginSideRequests: [
      { origin: SERVICE_ORIGIN, path: SIDE_PATH, method: 'POST', remainingPosts: sideRemaining[0] },
      { origin: APP_ORIGIN, path: APP_SIDE_PATH, method: 'POST', remainingPosts: sideRemaining[1] },
    ],
    approvedServiceOrigins: [SERVICE_ORIGIN],
  },
});
const SCRIPT = scriptStage(ONE);
/** フォームの送信のログイン（今の形。スクリプトの口なし）。 */
const FORM_STAGE: LoginStagePolicy = { loginPostEndpoints: [{ origin: APP_ORIGIN, path: FORM_PATH }], remainingPosts: ONE };

const facts = (
  method: string,
  url: string,
  resourceType: RequestResourceType | undefined,
  isNavigationRequest = false,
  isMainFrame = false,
): HttpRequestFacts => ({ kind: 'HTTP', method, url, isNavigationRequest, isMainFrame, resourceType });
const decide = (request: HttpRequestFacts, authSetup: LoginStagePolicy = SCRIPT): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, { authSetup });

const token: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'SCRIPT_LOGIN_TOKEN' } };
const side = (index: number): PassiveRequestDecision =>
  ({ action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'LOGIN_SIDE_REQUEST', index } });
const serviceRead: PassiveRequestDecision = { action: 'ALLOW', delivery: 'DIRECT', loginStageAdmission: { kind: 'SERVICE_ORIGIN_READ' } };
const blocked = (scriptLoginBlock: ScriptLoginBlockReason): PassiveRequestDecision =>
  ({ action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD', scriptLoginBlock });
const nonRead: PassiveRequestDecision = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };

describe('T34b: the closed lists of the script login', () => {
  it('closes the list of the script login block reasons and the script request types', () => {
    expect(SCRIPT_LOGIN_BLOCK_REASONS).toEqual([
      'TOKEN_REQUEST_OVER_LIMIT',
      'TOKEN_REQUEST_NOT_SCRIPT',
      'TOKEN_REQUEST_QUERY_MISMATCH',
      'SIDE_REQUEST_OVER_LIMIT',
      'SIDE_REQUEST_NOT_SCRIPT',
      'UNREGISTERED_NON_READ',
      // T36c（Task 36 の設計書 3.3。設計者の判断 1）: 自動ログインで、資格情報を含む要求を止めた理由（判定は返さない。Guard が数える）。
      'LOGIN_CREDENTIAL_IN_REQUEST',
    ]);
    expect(SCRIPT_REQUEST_RESOURCE_TYPES).toEqual(['fetch', 'xhr']);
    expect(Object.isFrozen(SCRIPT_LOGIN_BLOCK_REASONS)).toBe(true);
    expect(Object.isFrozen(REQUEST_RESOURCE_TYPES)).toBe(true);
    for (const type of SCRIPT_REQUEST_RESOURCE_TYPES) {
      expect(REQUEST_RESOURCE_TYPES).toContain(type);
    }
  });

  it.each([
    ['Fetch', 'fetch'],
    ['XHR', 'xhr'],
    ['fetch', 'fetch'],
    ['Ping', 'ping'],
    ['Document', 'document'],
    ['Script', 'script'],
    ['CSPViolationReport', 'cspviolationreport'],
    ['Other', 'other'],
    ['beacon', 'other'],
    ['', 'other'],
    [undefined, 'other'],
    [42, 'other'],
  ] as const)('normalizes the request type %j to %j', (value, expected) => {
    expect(requestResourceTypeOf(value)).toBe(expected);
  });
});

// DEF-120: Guard が要求（Playwright の `Request`）の種類を読む口。口がない・関数でない・投げる・文字列でないときは `other`（投げない。fail-closed）。
describe('DEF-120: reading the request type of a request object never throws', () => {
  const throwingReader = (): string => {
    throw new Error('closed');
  };
  const requests: readonly (readonly [string, unknown, RequestResourceType])[] = [
    ['a Playwright like request', { resourceType: (): string => 'fetch' }, 'fetch'],
    ['an upper case type', { resourceType: (): string => 'XHR' }, 'xhr'],
    ['no reader', {}, 'other'],
    ['a reader that is not a function', { resourceType: 'fetch' }, 'other'],
    ['a reader that throws', { resourceType: throwingReader }, 'other'],
    ['a reader that returns a number', { resourceType: (): number => 1 }, 'other'],
    ['an unknown type', { resourceType: (): string => 'beacon' }, 'other'],
    ['null', null, 'other'],
    ['a string', 'fetch', 'other'],
  ];
  it.each(requests)('reads %s', (_label, request, expected) => {
    expect(requestResourceTypeOfRequest(request)).toBe(expected);
  });

  it('calls the reader on the request (the receiver is kept)', () => {
    const request = { type: 'fetch', resourceType(this: { readonly type: string }): string { return this.type; } };
    expect(requestResourceTypeOfRequest(request)).toBe('fetch');
  });

  const throwingGetter = (): never => {
    throw new Error('detached');
  };
  it('does not read a getter that throws', () => {
    const request = Object.defineProperty({}, 'resourceType', { get: throwingGetter });
    expect(requestResourceTypeOfRequest(request)).toBe('other');
  });
});

describe('T34b: the token request of the script login', () => {
  it.each(['fetch', 'xhr'] as const)('allows the token POST (%s) with the exact query', (type) => {
    expect(decide(facts('POST', TOKEN_URL, type))).toEqual(token);
  });

  it('compares the query values after decoding (the server reads the decoded values) and in any order of one pair', () => {
    expect(decide(facts('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=pass%77ord`, 'fetch'))).toEqual(token);
  });

  it.each([
    ['a document POST (form navigation)', facts('POST', TOKEN_URL, 'document', true, true)],
    ['a document POST of a sub frame', facts('POST', TOKEN_URL, 'document', true, false)],
    ['a beacon (ping)', facts('POST', TOKEN_URL, 'ping')],
    ['a script type', facts('POST', TOKEN_URL, 'script')],
    ['an other type', facts('POST', TOKEN_URL, 'other')],
    ['an omitted type', facts('POST', TOKEN_URL, undefined)],
  ])('blocks %s to the token endpoint even with the exact query', (_label, request) => {
    expect(decide(request)).toEqual(blocked('TOKEN_REQUEST_NOT_SCRIPT'));
  });

  it.each([
    ['another grant', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=refresh_token`],
    ['another case of the value', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=Password`],
    ['an extra pair', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=password&x=1`],
    ['a duplicated pair', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=password&grant_type=password`],
    ['no query', `${SERVICE_ORIGIN}${TOKEN_PATH}`],
    ['an empty value', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=`],
    ['a fragment', `${TOKEN_URL}#x`],
  ])('blocks the token POST with %s as a query mismatch', (_label, url) => {
    expect(decide(facts('POST', url, 'fetch'))).toEqual(blocked('TOKEN_REQUEST_QUERY_MISMATCH'));
  });

  it.each([
    ['another origin', `${OTHER_ORIGIN}${TOKEN_PATH}?grant_type=password`],
    ['another scheme', `http://service.example.invalid${TOKEN_PATH}?grant_type=password`],
    ['another port', `https://service.example.invalid:8443${TOKEN_PATH}?grant_type=password`],
    ['another path', `${SERVICE_ORIGIN}/auth/v1/token/?grant_type=password`],
    ['another case of the path', `${SERVICE_ORIGIN}/auth/v1/Token?grant_type=password`],
    ['credentials in the URL', `https://user:pass@service.example.invalid${TOKEN_PATH}?grant_type=password`],
    ['an unparsable URL', 'not a url'],
  ])('blocks the token POST to %s as unregistered', (_label, url) => {
    expect(decide(facts('POST', url, 'fetch'))).toEqual(blocked('UNREGISTERED_NON_READ'));
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'post'])('blocks %s to the token endpoint as unregistered', (method) => {
    expect(decide(facts(method, TOKEN_URL, 'fetch'))).toEqual(blocked('UNREGISTERED_NON_READ'));
  });

  it.each([NONE, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('blocks the token POST over the limit (remaining %s)', (remaining) => {
    expect(decide(facts('POST', TOKEN_URL, 'fetch'), scriptStage(remaining))).toEqual(blocked('TOKEN_REQUEST_OVER_LIMIT'));
  });

  it('does not allow the token POST when the service origin is not approved (fail closed)', () => {
    const stage = SCRIPT.scriptRequest;
    if (stage === undefined) throw new Error('the script stage is missing');
    const unapproved: LoginStagePolicy = { ...SCRIPT, scriptRequest: { ...stage, approvedServiceOrigins: [] } };
    expect(decide(facts('POST', TOKEN_URL, 'fetch'), unapproved)).toEqual(blocked('UNREGISTERED_NON_READ'));
  });
});

describe('T34b: the registered login side requests', () => {
  it('allows each registered side request (fetch or xhr, any query) with its index', () => {
    expect(decide(facts('POST', SIDE_URL, 'fetch'))).toEqual(side(0));
    expect(decide(facts('POST', `${SIDE_URL}?a=1`, 'xhr'))).toEqual(side(0));
    expect(decide(facts('POST', APP_SIDE_URL, 'fetch'))).toEqual(side(1));
  });

  it('counts each item by itself', () => {
    expect(decide(facts('POST', SIDE_URL, 'fetch'), scriptStage(ONE, [NONE, ONE]))).toEqual(blocked('SIDE_REQUEST_OVER_LIMIT'));
    expect(decide(facts('POST', APP_SIDE_URL, 'fetch'), scriptStage(ONE, [NONE, ONE]))).toEqual(side(1));
    expect(decide(facts('POST', APP_SIDE_URL, 'fetch'), scriptStage(ONE, [ONE, NONE]))).toEqual(blocked('SIDE_REQUEST_OVER_LIMIT'));
    // token の残りとは別に数える。
    expect(decide(facts('POST', SIDE_URL, 'fetch'), scriptStage(NONE))).toEqual(side(0));
  });

  it.each([
    ['a beacon (ping)', facts('POST', APP_SIDE_URL, 'ping')],
    ['a document POST', facts('POST', APP_SIDE_URL, 'document', true, true)],
    ['an omitted type', facts('POST', SIDE_URL, undefined)],
  ])('blocks %s to a registered side path', (_label, request) => {
    expect(decide(request)).toEqual(blocked('SIDE_REQUEST_NOT_SCRIPT'));
  });

  it('blocks another method, another path and another origin as unregistered', () => {
    expect(decide(facts('PUT', SIDE_URL, 'fetch'))).toEqual(blocked('UNREGISTERED_NON_READ'));
    expect(decide(facts('POST', `${SIDE_URL}/x`, 'fetch'))).toEqual(blocked('UNREGISTERED_NON_READ'));
    expect(decide(facts('POST', `${OTHER_ORIGIN}${SIDE_PATH}`, 'fetch'))).toEqual(blocked('UNREGISTERED_NON_READ'));
  });

  it('does not allow a registered item whose method is not POST', () => {
    const stage = SCRIPT.scriptRequest;
    if (stage === undefined) throw new Error('the script stage is missing');
    const putItem: LoginStagePolicy = {
      ...SCRIPT,
      scriptRequest: { ...stage, loginSideRequests: [{ origin: SERVICE_ORIGIN, path: SIDE_PATH, method: 'PUT', remainingPosts: ONE }] },
    };
    expect(decide(facts('PUT', SIDE_URL, 'fetch'), putItem)).toEqual(blocked('UNREGISTERED_NON_READ'));
  });
});

describe('T34b: the other requests of the script login stage', () => {
  it('blocks an unregistered POST in the allowed origins and the form navigation POST of the setup', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/cdn-cgi/rum`, 'fetch'))).toEqual(blocked('UNREGISTERED_NON_READ'));
    // スクリプトのログインでは、フォームの送信先へのページの移動の POST も通さない（種類が document の POST は止める）。
    expect(decide(facts('POST', FORM_URL, 'document', true, true))).toEqual(blocked('UNREGISTERED_NON_READ'));
  });

  it.each(['GET', 'HEAD'])('allows a %s read of the approved service origin (not a navigation)', (method) => {
    expect(decide(facts(method, `${SERVICE_ORIGIN}/rest/v1/members?select=*`, 'fetch'))).toEqual(serviceRead);
    expect(decide(facts(method, `${SERVICE_ORIGIN}/logo.png`, 'image'))).toEqual(serviceRead);
  });

  it('does not navigate to the approved service origin (no crawl)', () => {
    expect(decide(facts('GET', `${SERVICE_ORIGIN}/`, 'document', true, true)))
      .toEqual({ action: 'BLOCK', category: 'NAVIGATION', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION' });
    expect(decide(facts('GET', `${SERVICE_ORIGIN}/`, 'document', true, false)))
      .toEqual({ action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'OUTSIDE_ALLOWED_ORIGINS' });
  });

  it('keeps the reads of the allowed origins and blocks the reads outside the allowed and service origins', () => {
    expect(decide(facts('GET', `${APP_ORIGIN}/app.js`, 'script'))).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
    expect(decide(facts('GET', `${APP_ORIGIN}/admin`, 'document', true, true))).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(decide(facts('GET', `${OTHER_ORIGIN}/pixel`, 'image')))
      .toEqual({ action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'OUTSIDE_ALLOWED_ORIGINS' });
  });

  it('keeps the submission window for the listed requests only', () => {
    const open = scriptStage(ONE, [ONE, ONE], true);
    expect(decide(facts('POST', TOKEN_URL, 'fetch'), open)).toEqual(token);
    expect(decide(facts('POST', SIDE_URL, 'fetch'), open)).toEqual(side(0));
    expect(decide(facts('GET', `${SERVICE_ORIGIN}/rest/v1/members`, 'fetch'), open)).toEqual(serviceRead);
    expect(decide(facts('GET', `${APP_ORIGIN}/app.js`, 'script'), open)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
    expect(decide(facts('GET', `${APP_ORIGIN}/admin`, 'document', true, true), open)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(decide(facts('GET', `${OTHER_ORIGIN}/pixel`, 'image'), open))
      .toEqual({ action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'SUBMISSION_WINDOW' });
    expect(decide(facts('POST', `${APP_ORIGIN}/cdn-cgi/rum`, 'fetch'), open)).toEqual(blocked('UNREGISTERED_NON_READ'));
  });

  it('does not allow any script POST when the login stage and the write stage are combined (fail closed)', () => {
    const writeStage: WriteStagePolicy = { writeEndpoint: { origin: APP_ORIGIN, path: '/items' }, remainingPosts: ONE };
    const combined = classifyPassiveRequest(facts('POST', TOKEN_URL, 'fetch'), ALLOWED_ORIGINS, { authSetup: SCRIPT, writeStage });
    expect(combined.action).toBe('BLOCK');
    expect(classifyPassiveRequest(facts('POST', SIDE_URL, 'fetch'), ALLOWED_ORIGINS, { authSetup: SCRIPT, writeStage }).action).toBe('BLOCK');
  });
});

describe('T34b: the form navigation login (FORM_NAVIGATION) and the other stages keep the current decisions', () => {
  it('keeps the form navigation POST and blocks a script POST without the script login detail', () => {
    expect(decide(facts('POST', FORM_URL, 'document', true, true), FORM_STAGE)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    expect(decide(facts('POST', FORM_URL, undefined, true, true), FORM_STAGE)).toEqual({ action: 'ALLOW', delivery: 'INSPECT_REDIRECTS' });
    const script = decide(facts('POST', TOKEN_URL, 'fetch'), FORM_STAGE);
    expect(script).toEqual(nonRead);
    expect(Object.keys(script).sort()).toEqual(['action', 'category', 'reason']);
    expect(decide(facts('GET', `${SERVICE_ORIGIN}/rest/v1/members`, 'fetch'), FORM_STAGE))
      .toEqual({ action: 'BLOCK', category: 'LOGIN_STAGE', reason: 'OUTSIDE_ALLOWED_ORIGINS' });
  });

  it('keeps the public audit decisions with the request type (no added detail)', () => {
    const post = classifyPassiveRequest(facts('POST', TOKEN_URL, 'fetch'), ALLOWED_ORIGINS);
    expect(Object.keys(post).sort()).toEqual(['action', 'category', 'reason']);
    expect(post).toEqual(nonRead);
    const read = classifyPassiveRequest(facts('GET', `${SERVICE_ORIGIN}/rest/v1/members`, 'fetch'), ALLOWED_ORIGINS);
    expect(Object.keys(read).sort()).toEqual(['action', 'delivery']);
  });

  it('keeps the login endpoint check of the form navigation login', () => {
    expect(isLoginEndpointPost(FORM_URL, ALLOWED_ORIGINS, FORM_STAGE.loginPostEndpoints)).toBe(true);
    expect(isLoginEndpointPost(TOKEN_URL, ALLOWED_ORIGINS, FORM_STAGE.loginPostEndpoints)).toBe(false);
  });
});
