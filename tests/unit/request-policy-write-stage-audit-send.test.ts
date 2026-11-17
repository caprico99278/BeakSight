// OP-N（設計書 `doc/design/2026-10-27-beaksight-one-pass-flow-design.md` 4.1.7 の N2）: 書き込みの段の口（`writeStage`）と、監査の段の送信の扱い
// `PASS_EXCEPT_DELETE` の口（`auditSend`）を一緒に渡したときの、要求の判定（`classifyPassiveRequest`）を表で確かめる。
// - 値を入れる前（送信の窓を開く前）: 監査の段と同じ判定（`auditSendDecisionOf`）で、サイトが自動で送る読み取りでない要求を通す。加えて書き込みの段では、
//   送り先を許可 Origin と承認したサービスの Origin に限り、承認した送信の送信先（Origin と path）への要求は通さない（数える書き込みは承認した 1 件だけ）。
// - 値を入れた後（窓の中）: 通さない（N1 を優先。今どおり止める）。
// - 押した後（窓を閉じた後。`valuesEntered`）: 通さない（OP-REV3 の C-2。値はヘッダや Cookie でも運べ、照らしきれないため。N2 で通すのは値を入れる前だけ）。
// - OP-REV3（I-1）: 承認した送信の送信先とその下の path は、正規化した形（末尾の `/`、`//`、大文字と小文字、`%XX`）でも除く。
// - WebSocket は、書き込みの段では通さない（値を入れる前に開いた接続は、値を入れた後も開いたままになるため）。
// - ログインの段の口と一緒なら、今どおり使わない。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import {
  classifyPassiveRequest,
  recordPathShapeOf,
  type AuditSendPolicy,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestPolicyOptions,
  type RequestSentContent,
  type WriteStagePolicy,
} from '../../src/safety/request-policy.js';

const APP_ORIGIN = 'https://app.example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const DANGEROUS_TERMS = Object.freeze(['logout', 'delete']);

const auditSend = (): AuditSendPolicy => ({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  dangerousTerms: DANGEROUS_TERMS,
  webSockets: true,
});

const FORM_BEFORE_FILL: WriteStagePolicy = Object.freeze({
  writeEndpoint: Object.freeze({ origin: APP_ORIGIN, path: '/members' }),
  remainingPosts: 0,
  submissionWindowOpen: false,
});
const FORM_AFTER_FILL: WriteStagePolicy = Object.freeze({ ...FORM_BEFORE_FILL, submissionWindowOpen: true, valuesEntered: true });
const FORM_AFTER_PRESS: WriteStagePolicy = Object.freeze({ ...FORM_BEFORE_FILL, submissionWindowOpen: false, valuesEntered: true });

const NO_OVERRIDES = (): readonly string[] => [];
const sent = (): RequestSentContent => ({ headers: { 'content-type': 'application/json' }, formMethodOverrides: NO_OVERRIDES });

const facts = (method: string, url: string, sentContent?: RequestSentContent, isNavigationRequest = false): HttpRequestFacts => ({
  kind: 'HTTP', method, url, isNavigationRequest, isMainFrame: isNavigationRequest, resourceType: isNavigationRequest ? 'document' : 'fetch',
  ...(sentContent === undefined ? {} : { sentContent }),
});

const decide = (request: HttpRequestFacts, policy: PassiveRequestPolicyOptions): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, policy);

const PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };
const NON_READ = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };

describe('OP-N (N2): the audit send policy in the write stage', () => {
  const before: PassiveRequestPolicyOptions = { writeStage: FORM_BEFORE_FILL, auditSend: auditSend() };

  it('passes the requests that the site sends by itself before the values are typed, to the test Origin and the approved service Origin', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`), before)).toEqual(PASSED);
    expect(decide(facts('PUT', `${SERVICE_ORIGIN}/rest/v1/rpc/usage`), before)).toEqual(PASSED);
    expect(decide(facts('PATCH', `${SERVICE_ORIGIN}/rest/v1/media?id=eq.1`), before)).toEqual(PASSED);
  });

  // RB-4b: 書き込みの最中も、サイトの通信は止めない（form の送信、許可の外、値を入れた後、押した後）。DELETE と危険な語は止める。
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.4）: DELETE と危険な語も通す（承認した送信先の照合は残す。下の場面）。
  it('passes a DELETE, a dangerous word, a form post and a request outside the test and the approved service Origins', () => {
    expect(decide(facts('DELETE', `${SERVICE_ORIGIN}/rest/v1/previews?id=eq.1`), before)).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/logout`), before)).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`, undefined, true), before)).toMatchObject({ action: 'ALLOW', auditSendAdmission: true });
    expect(decide(facts('POST', `${OTHER_ORIGIN}/collect`), before)).toEqual(PASSED);
    expect(decide(facts('POST', 'not a url'), before)).toMatchObject({ action: 'BLOCK' });
  });

  it('does not pass a request to the endpoint of the approved send (only the approved one write is counted)', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/members`), before)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/members?draft=1`), before)).toEqual(NON_READ);
    expect(decide(facts('PATCH', `${APP_ORIGIN}/members`), before)).toEqual(NON_READ);
  });

  // OP-REV3（I-1）: 承認した送信先とその下の path を、正規化した形でも除く（比べ方は監査の段の除外の前方一致と同じ部品）。
  it('does not pass a request to the endpoint of the approved send in another path form, nor to a path under it', () => {
    for (const path of ['/members/', '//members', '/MEMBERS', '/Members/', '/%6dembers', '/%2Fmembers', '/members/1', '/members;x', '/a/../members']) {
      expect(decide(facts('POST', `${APP_ORIGIN}${path}`), before), path).toEqual(NON_READ);
    }
    // ほかの Origin の同じ path は、送り先の決まり（許可 Origin と承認したサービスの Origin）で判定する。
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/members-list`), before)).toEqual(PASSED);
  });

  // LU-SFIX1（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.3 の 3。LU-SREV1 の Important-1）: path の形の更新（型の最後の区切りが `{id}`）では、
  // `{id}` の 1 つ上の path（表の一覧の path）も守る。filter の形の期待（`/api/items`）と同じ強さ（同じ比べ方）。
  it('does not pass a request to the list path one above the record id of a path-form endpoint, as the filter-form endpoint does', () => {
    const pathForm: PassiveRequestPolicyOptions = {
      writeStage: Object.freeze({ ...FORM_BEFORE_FILL, writeEndpoint: Object.freeze({ origin: SERVICE_ORIGIN, path: '/api/items/{id}' }) }),
      auditSend: auditSend(),
    };
    const filterForm: PassiveRequestPolicyOptions = {
      writeStage: Object.freeze({ ...FORM_BEFORE_FILL, writeEndpoint: Object.freeze({ origin: SERVICE_ORIGIN, path: '/api/items' }) }),
      auditSend: auditSend(),
    };
    for (const [method, path] of [
      ['POST', '/api/items'], ['PATCH', '/api/items'], ['PATCH', '/api/items?id=eq.5'], ['PATCH', '/api/items/5'], ['POST', '/api/items/5'],
      ['PATCH', '/API/ITEMS'], ['PATCH', '/api/items/'], ['PATCH', '/api//items'], ['PATCH', '/api/itemsX/5'], ['PATCH', '/api/%69tems'],
    ] as const) {
      expect(decide(facts(method, `${SERVICE_ORIGIN}${path}`), pathForm), `${method} ${path}`).toEqual(NON_READ);
      expect(decide(facts(method, `${SERVICE_ORIGIN}${path}`), filterForm), `${method} ${path} (filter form)`).toEqual(NON_READ);
    }
    // 別の表は、どちらの形でも今のとおり通る。
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/api/notes/1`), pathForm)).toEqual(PASSED);
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/api/notes/1`), filterForm)).toEqual(PASSED);
    // 1 つ上の path が根なら、その Origin のすべての path を守る（fail-closed）。
    const rootPathForm: PassiveRequestPolicyOptions = {
      writeStage: Object.freeze({ ...FORM_BEFORE_FILL, writeEndpoint: Object.freeze({ origin: SERVICE_ORIGIN, path: '/{id}' }) }),
      auditSend: auditSend(),
    };
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/api/notes/1`), rootPathForm)).toEqual(NON_READ);
    expect(decide(facts('POST', `${APP_ORIGIN}/rpc/status`), rootPathForm)).toEqual(PASSED);
  });

  // LU-SFIX3-B（LU-SREV3 の Important-2）: フォームの更新の守る型（`guardedPathShape`）があれば、窓の前に守るのは、その型と表の path（承認の送信先の具体的な
  // path の代わり）。別の表は今のとおり通る。型の作り方は `recordPathShapeOf` の 1 か所（最後の区切りが対象の番号のときだけ）。
  it('guards the record path shape and the table path of a form update with the guarded path shape, and keeps another table passing', () => {
    const concrete: PassiveRequestPolicyOptions = {
      writeStage: Object.freeze({ ...FORM_BEFORE_FILL, writeEndpoint: Object.freeze({ origin: SERVICE_ORIGIN, path: '/members/4' }) }),
      auditSend: auditSend(),
    };
    const shaped: PassiveRequestPolicyOptions = {
      writeStage: Object.freeze({
        ...FORM_BEFORE_FILL, writeEndpoint: Object.freeze({ origin: SERVICE_ORIGIN, path: '/members/4' }), guardedPathShape: '/members/{id}',
      }),
      auditSend: auditSend(),
    };
    for (const path of ['/members/5', '/members', '/MEMBERS/5', '/members/']) {
      expect(decide(facts('POST', `${SERVICE_ORIGIN}${path}`), concrete), `${path} (concrete)`).toEqual(PASSED);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}${path}`), shaped), path).toEqual(NON_READ);
    }
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/members/4`), shaped)).toEqual(NON_READ);
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/notes/1`), shaped)).toEqual(PASSED);
    expect(recordPathShapeOf('/members/4', '4')).toBe('/members/{id}');
    expect(recordPathShapeOf('/members/4/edit', '4')).toBeNull();
    expect(recordPathShapeOf('/members', '4')).toBeNull();
    expect(recordPathShapeOf('/members/4', '')).toBeNull();
    expect(recordPathShapeOf('/members/{id}', '{id}')).toBeNull();
  });

  // RB-4b（ユーザーの判断。前の N1 と OP-REV3 の C-2 を置き換えた）: 値を入れた後も押した後も、サイトの送信を止めない。
  it('passes the non-read requests of the site after the values are typed and after the press', () => {
    const afterFill: PassiveRequestPolicyOptions = { writeStage: FORM_AFTER_FILL, auditSend: auditSend() };
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/usage`, sent()), afterFill)).toEqual(PASSED);
    const afterPress: PassiveRequestPolicyOptions = { writeStage: FORM_AFTER_PRESS, auditSend: auditSend() };
    expect(decide(facts('PUT', `${APP_ORIGIN}/rpc/status`), afterPress)).toMatchObject({ action: 'ALLOW', auditSendAdmission: true });
  });

  it('passes a WebSocket only with the realtime pass-through (the Guard gives it to the write stage)', () => {
    const socket = { kind: 'WEBSOCKET', url: `wss://${new URL(SERVICE_ORIGIN).host}/realtime` } as const;
    expect(classifyPassiveRequest(socket, ALLOWED_ORIGINS, { writeStage: FORM_AFTER_FILL, auditSend: auditSend() }))
      .toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
    expect(classifyPassiveRequest(socket, ALLOWED_ORIGINS, { writeStage: FORM_AFTER_FILL, realtimePassThrough: true }))
      .toEqual({ action: 'ALLOW', delivery: 'DIRECT', auditSendWebSocketAdmission: true });
  });

  it('passes the reads of the site outside the allowed Origins', () => {
    expect(decide(facts('GET', `${OTHER_ORIGIN}/widget.js`), before)).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
  });

  describe('in the API write stage with the audit stage of a script login audit', () => {
    const API_BEFORE_FILL: WriteStagePolicy = Object.freeze({
      writeEndpoint: Object.freeze({ origin: SERVICE_ORIGIN, path: '/rest/v1/members' }),
      remainingPosts: 0,
      apiOrigin: SERVICE_ORIGIN,
      submissionWindowOpen: false,
    });
    const AUDIT_STAGE: AuditStagePolicy = Object.freeze({
      approvedServiceOrigins: Object.freeze([SERVICE_ORIGIN]),
      auditReadRequests: Object.freeze([]),
      scriptLogin: Object.freeze({ origin: SERVICE_ORIGIN, path: '/auth/v1/token', requiredQuery: Object.freeze([]) }),
    });
    const apiBefore: PassiveRequestPolicyOptions = { writeStage: API_BEFORE_FILL, auditStage: AUDIT_STAGE, auditSend: { ...auditSend(), approvedServiceOrigins: [] } };

    it('passes an unregistered procedure call to the approved service Origin before the values are typed, and not the approved write endpoint', () => {
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/usage`), apiBefore)).toEqual(PASSED);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/members`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/members?select=id`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/members/`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/REST/v1//members`), apiBefore)).toMatchObject(NON_READ);
      expect(decide(facts('DELETE', `${SERVICE_ORIGIN}/rest/v1/previews`), apiBefore)).toEqual(PASSED);
    });
  });
});
