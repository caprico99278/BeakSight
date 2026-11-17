// AS-a（設計書 `doc/design/2026-10-19-beaksight-audit-send-policy-design.md` 2.2・2.3）: 監査の段の送信の扱い `PASS_EXCEPT_DELETE` の、
// 要求の判定の口（`classifyPassiveRequest` の `auditSend`）、Guard の口の確かめ（`PassiveRequestGuardOptions.auditSend`）、Safety Ledger の通した要求の記録。
// - 通す: ナビゲーションでない、method が GET・HEAD でも DELETE でもない要求で、送り先が許可 Origin か承認したサービスの Origin、path と query に危険な語が
//   なく（今の監査の段の除外と同じ比べ方）（`auditSendAdmission`）。RB-4a（X2）で数の上限の名残を外した。
// - 止める（今どおり）: DELETE、文書のナビゲーション、ほかの Origin、危険な語、ログインの段・書き込みの段の口と一緒（口を使わない。fail-closed）。
// - スクリプトで送るログインの監査の段の口と一緒: 登録していない読み取りでない要求を通す。token の更新と、サービスの Origin へ送らない Context の
//   サービスの Origin への要求は、今どおり止める。
// 例の値は、匿名の値（`example.com`、`example.invalid`）だけを使う。
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import type { BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  installPassiveRequestGuard,
  isGuardAuditSend,
  type GuardAuditSend,
} from '../../src/safety/passive-request-guard.js';
import {
  classifyPassiveRequest,
  type AuditSendPolicy,
  type AuditStagePolicy,
  type HttpRequestFacts,
  type PassiveRequestDecision,
  type PassiveRequestFacts,
  type PassiveRequestPolicyOptions,
  type RequestResourceType,
} from '../../src/safety/request-policy.js';
import { SafetyLedger, safetyEventsEvidenceFromSnapshot } from '../../src/safety/safety-ledger.js';

const APP_ORIGIN = 'https://example.com';
const SERVICE_ORIGIN = 'https://service.example.invalid';
const OTHER_ORIGIN = 'https://other.example.invalid';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN]);
const DANGEROUS_TERMS = Object.freeze(['logout', 'delete', 'remove', 'cancel']);
const TOKEN_PATH = '/auth/v1/token';

const auditSend = (): AuditSendPolicy => ({
  approvedServiceOrigins: [SERVICE_ORIGIN],
  dangerousTerms: DANGEROUS_TERMS,
});

const facts = (
  method: string,
  url: string,
  resourceType: RequestResourceType = 'fetch',
  isNavigationRequest = false,
  isMainFrame = false,
): HttpRequestFacts => ({ kind: 'HTTP', method, url, isNavigationRequest, isMainFrame, resourceType });

const decide = (request: PassiveRequestFacts, policy: PassiveRequestPolicyOptions = { auditSend: auditSend() }): PassiveRequestDecision =>
  classifyPassiveRequest(request, ALLOWED_ORIGINS, policy);

const PASSED = { action: 'ALLOW', delivery: 'DIRECT', auditSendAdmission: true };
const NON_READ = { action: 'BLOCK', category: 'REQUEST', reason: 'NON_READ_METHOD' };

describe('AS-a: the audit send policy of the request policy (classifyPassiveRequest)', () => {
  it('passes the page requests that are not reads, not DELETE and not navigations, to the allowed and the approved service Origin', () => {
    expect(decide(facts('POST', `${APP_ORIGIN}/api/save`))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/save`, 'xhr'))).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/collect`, 'ping'))).toEqual(PASSED);
    expect(decide(facts('PUT', `${APP_ORIGIN}/api/save`))).toEqual(PASSED);
    expect(decide(facts('PATCH', `${APP_ORIGIN}/api/save`))).toEqual(PASSED);
    expect(decide(facts('OPTIONS', `${APP_ORIGIN}/api/save`))).toEqual(PASSED);
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/get_members`))).toEqual(PASSED);
    expect(decide(facts('POST', `${SERVICE_ORIGIN}/_serverFn/abc`, 'other'))).toEqual(PASSED);
  });

  it('does not change reads, and keeps blocking WebSockets when the option has no WebSocket count', () => {
    expect(decide(facts('GET', `${APP_ORIGIN}/api/list`))).toEqual({ action: 'ALLOW', delivery: 'DIRECT' });
    // AS-c: WebSocket は、口に WebSocket の印（`webSockets`）があるときだけ通す（`audit-send-wider.test.ts`）。
    expect(decide({ kind: 'WEBSOCKET', url: 'wss://example.com/socket' })).toEqual({ action: 'BLOCK', category: 'WEBSOCKET', reason: 'PASSIVE_WEBSOCKET' });
  });

  // AS-c: ほかの Origin への要求は、送り先の Origin の制限をなくしたので通す（`audit-send-wider.test.ts`）。
  // RB-4b: ページの script の form の送信（文書のナビゲーション）は通す（main frame は届け方 `INSPECT_REDIRECTS`）。本文の `_method=DELETE` は止める。
  // SD-2（設計書 `2026-11-16-beaksight-action-based-delete-guard-design.md` 2.1・2.4）: DELETE・削除の上書き・危険な語・読まないパスでも止めない。
  it('passes DELETE (any case), a DELETE override, dangerous terms, excluded paths and form posts, and blocks a non-http URL', () => {
    const excluding: PassiveRequestPolicyOptions = {
      auditSend: auditSend(),
      auditExclusions: { excludedPathPrefixes: ['/admin/danger'], auditPathPrefixes: ['/admin'], dangerousTerms: [] },
    };
    for (const request of [
      facts('DELETE', `${APP_ORIGIN}/api/session`),
      facts('delete', `${SERVICE_ORIGIN}/api/session`),
      facts('POST', `${APP_ORIGIN}/form`, 'document', true, false),
      facts('POST', `${OTHER_ORIGIN}/api/save`),
      facts('POST', `${APP_ORIGIN}/api/logout`),
      facts('PUT', `${APP_ORIGIN}/api/save?action=cancel`),
    ]) {
      expect(decide(request)).toEqual(PASSED);
    }
    expect(decide({
      ...facts('POST', `${APP_ORIGIN}/form`, 'document', true, true),
      sentContent: { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, formMethodOverrides: () => ['DELETE'] },
    })).toEqual({ ...PASSED, delivery: 'INSPECT_REDIRECTS' });
    expect(decide(facts('POST', `${APP_ORIGIN}/admin/danger/zone`), excluding)).toEqual(PASSED);
    expect(decide(facts('POST', 'not a url'))).toEqual(NON_READ);
  });


  // OP-N・RB-4b: 書き込みの段の口と一緒のときも、送信の窓の中でも使う（決まりの全体は `request-policy-write-stage-audit-send.test.ts`）。RB-14b: ログインの段の
  // 口とは一緒に作れない（型）。
  it('uses the policy inside the submission window of the write stage', () => {
    const writeStage = { writeEndpoint: { origin: APP_ORIGIN, path: '/members' }, remainingPosts: 1, submissionWindowOpen: true };
    expect(decide(facts('POST', `${APP_ORIGIN}/api/save`), { auditSend: auditSend(), writeStage })).toEqual(PASSED);
    expect(decide(facts('POST', `${APP_ORIGIN}/api/save`), { auditSend: auditSend(), writeStage: { ...writeStage, submissionWindowOpen: false } })).toEqual(PASSED);
  });

  describe('together with the audit stage of a script login audit', () => {
    const auditStage = (withheld = false): AuditStagePolicy => ({
      approvedServiceOrigins: [SERVICE_ORIGIN],
      auditReadRequests: [],
      scriptLogin: { origin: SERVICE_ORIGIN, path: TOKEN_PATH, requiredQuery: [{ name: 'grant_type', value: 'password' }] },
      ...(withheld ? { serviceOriginRequestsWithheld: true } : {}),
    });

    it('passes the unregistered requests that are not reads', () => {
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/get_members`), { auditSend: auditSend(), auditStage: auditStage() })).toEqual(PASSED);
      expect(decide(facts('POST', `${APP_ORIGIN}/_serverFn/abc`), { auditSend: auditSend(), auditStage: auditStage() })).toEqual(PASSED);
    });

    // AS-c: token の更新は通す（サービスの Origin へ送らない Context では今どおり止める）。
    it('passes the token refresh, and keeps blocking the service Origin of a Context that does not send to it', () => {
      expect(decide(facts('POST', `${SERVICE_ORIGIN}${TOKEN_PATH}?grant_type=refresh_token`), { auditSend: auditSend(), auditStage: auditStage() }))
        .toEqual(PASSED);
      expect(decide(facts('POST', `${SERVICE_ORIGIN}/rest/v1/rpc/get_members`), { auditSend: auditSend(), auditStage: auditStage(true) }))
        .toEqual({ ...NON_READ, auditStageBlock: 'UNREGISTERED_NON_READ' });
      // 許可 Origin への要求は、サービスの Origin へ送らない Context でも通す。
      expect(decide(facts('POST', `${APP_ORIGIN}/api/save`), { auditSend: auditSend(), auditStage: auditStage(true) })).toEqual(PASSED);
    });

  });
});

describe('AS-a: the audit send option of the Guard (PassiveRequestGuardOptions.auditSend)', () => {
  const VALID: GuardAuditSend = Object.freeze({
    policy: 'PASS_EXCEPT_DELETE',
    approvedServiceOrigins: [SERVICE_ORIGIN],
    dangerousTerms: DANGEROUS_TERMS,
  });
  const fakeContext = {} as BrowserContext;

  it('accepts only the PASS_EXCEPT_DELETE shape', () => {
    expect(isGuardAuditSend(VALID)).toBe(true);
    expect(isGuardAuditSend({ ...VALID, policy: 'READ_ONLY' })).toBe(false);
    expect(isGuardAuditSend({ ...VALID, approvedServiceOrigins: [1] })).toBe(false);
    expect(isGuardAuditSend({ ...VALID, dangerousTerms: undefined })).toBe(false);
    expect(isGuardAuditSend(null)).toBe(false);
  });

  it('refuses a malformed option and the combination with the login stage or the write stage (TypeError)', async () => {
    await expect(installPassiveRequestGuard(fakeContext, new SafetyLedger(), ALLOWED_ORIGINS, {
      auditSend: { ...VALID, policy: 'READ_ONLY' } as unknown as GuardAuditSend,
    })).rejects.toThrow(TypeError);
    await expect(installPassiveRequestGuard(fakeContext, new SafetyLedger(), ALLOWED_ORIGINS, {
      auditSend: VALID,
      loginStage: { loginPostEndpoints: [{ origin: APP_ORIGIN, path: '/login' }], maxLoginPosts: 1 },
    })).rejects.toThrow(TypeError);
    await expect(installPassiveRequestGuard(fakeContext, new SafetyLedger(), ALLOWED_ORIGINS, {
      auditSend: VALID,
      writeStage: {} as never,
    })).rejects.toThrow(TypeError);
  });
});

describe('AS-a: the passed audit send requests of the Safety Ledger', () => {
  it('does not put the record in the snapshot when nothing was passed', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({ method: 'POST', url: `${APP_ORIGIN}/form`, reason: 'NON_READ_METHOD', resourceType: 'document', phase: 'LOAD' });
    expect('passedAuditSendRequests' in ledger.snapshot()).toBe(false);
  });

  it('records the method, the Origin, the path (value-like segments hidden) and the count, without query values, and keeps it out of the Evidence', () => {
    const ledger = new SafetyLedger();
    ledger.recordPassedAuditSendRequest({ method: 'post', url: `${APP_ORIGIN}/api/save?token=secret-value#frag` });
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${APP_ORIGIN}/api/save?token=other-secret` });
    ledger.recordPassedAuditSendRequest({ method: 'PUT', url: `${SERVICE_ORIGIN}/members/0123456789abcdef0123456789abcdef/name` });
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: 'not a url' });
    const snapshot = ledger.snapshot();
    expect(snapshot.passedAuditSendRequests).toEqual({
      count: 4,
      byMethod: { POST: 3, PUT: 1 },
      requests: [
        { method: 'POST', origin: APP_ORIGIN, path: '/api/save', count: 2 },
        { method: 'PUT', origin: SERVICE_ORIGIN, path: '/members/[REDACTED]/name', count: 1 },
      ],
      unlisted: 1,
      // AS-c: ほかの Origin へ通した数（Guard が見分けて渡す。渡さなければ数えない）。
      otherOrigins: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(snapshot.recordLimits.truncated).toBe(false);
    // AS-b: 成果物への出し方は、止めた要求と同じく Safety の Evidence（値なし。Ledger の記録の写し）。
    expect(safetyEventsEvidenceFromSnapshot(snapshot, 'PASSIVE', { kind: 'PAGE_AUDIT' }).passedAuditSendRequests).toEqual(snapshot.passedAuditSendRequests);
  });

  it('is accepted by the checkpoint schema of the Ledger snapshot as an optional property, and rejects values in it', () => {
    const ajv = new Ajv({ allErrors: true, strict: true });
    for (const name of ['run', 'audit', 'page', 'finding', 'checkpoint', 'checkpoint-page']) {
      ajv.addSchema(JSON.parse(readFileSync(new URL(`../../schemas/${name}.schema.json`, import.meta.url), 'utf8')) as object);
    }
    const validateSnapshot = ajv.getSchema('urn:beaksight:schema:checkpoint:1.0#/$defs/safetyLedgerSnapshot');
    const ledger = new SafetyLedger();
    ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${APP_ORIGIN}/api/save?token=secret-value` });
    const snapshot = JSON.parse(JSON.stringify(ledger.snapshot())) as Record<string, unknown>;
    expect(validateSnapshot?.(snapshot)).toBe(true);
    const withQuery = JSON.parse(JSON.stringify(snapshot)) as { passedAuditSendRequests: { requests: Record<string, unknown>[] } };
    withQuery.passedAuditSendRequests.requests[0] = { ...withQuery.passedAuditSendRequests.requests[0], query: 'token=secret-value' };
    expect(validateSnapshot?.(withQuery)).toBe(false);
  });

  // LZ-3a: 一覧の行の数の上限（前は 256）は撤廃した。前の上限を超える行も残らず一覧に入れる。
  it('keeps every row beyond the former limit, without making the record incomplete', () => {
    const ledger = new SafetyLedger();
    const rows = 300;
    for (let index = 0; index < rows; index += 1) {
      ledger.recordPassedAuditSendRequest({ method: 'POST', url: `${APP_ORIGIN}/api/item-${index}` });
    }
    const snapshot = ledger.snapshot();
    expect(snapshot.passedAuditSendRequests?.count).toBe(rows);
    expect(snapshot.passedAuditSendRequests?.byMethod).toEqual({ POST: rows });
    expect(snapshot.passedAuditSendRequests?.requests.length).toBe(rows);
    expect(snapshot.passedAuditSendRequests?.unlisted).toBe(0);
    expect(snapshot.recordLimits.truncated).toBe(false);
  });
});
