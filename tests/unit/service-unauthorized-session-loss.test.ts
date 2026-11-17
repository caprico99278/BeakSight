// DEF-233（設計書 `doc/design/2026-11-09-beaksight-discovery-token-refresh-design.md` 2.3）: 承認したサービスの Origin の 401 を受け、その画面が描けなかった
// （`SERVICE_READ_REFUSED`）なら、セッションの切れ（詳しい理由 `SERVICE_UNAUTHORIZED`）として扱い、DEF-200 のログインし直しへ回す（K = 1 画面）。
// - 判定は操作さがし・READ の確かめ・監査の段が共有する 1 か所（`serviceUnauthorizedSessionLostDetailOf`）。
// - 詳しい理由は閉じた一覧（`SESSION_LOST_DETAILS`。成果物の `endReasonDetail` の一覧 `JOB_END_REASON_DETAILS` と、schema の enum）に入る。
// - 表示のカタログは、今の止まり方の文を使う（増やさない）。
import { describe, expect, it } from 'vitest';
import type { AuditStageServiceRequests } from '../../src/browser/context-factory.js';
import {
  SERVICE_UNAUTHORIZED_DETAIL,
  SESSION_KEY_LOST_DETAIL,
  SESSION_LOST_DETAILS,
} from '../../src/core/contracts.js';
import { JOB_END_REASON_DETAILS } from '../../src/discovery/discovery-result.js';
import {
  jobContextFactoryOptions,
  serviceUnauthorizedCountOf,
  serviceUnauthorizedSessionLostDetailOf,
} from '../../src/orchestration/audit-stage-run.js';
import type { RunAuthentication } from '../../src/orchestration/authenticated-run.js';
import { DISCOVERY_END_REASON_CATALOG, JOB_END_REASON_DETAIL_DESCRIPTIONS } from '../../src/presentation/catalog.js';


const SVC = 'https://svc.example.test';
const AUDIT_STAGE: AuditStageServiceRequests = {
  approvedServiceOrigins: [SVC],
  auditReadRequests: [],
  scriptLogin: { origin: SVC, path: '/auth/v1/token', requiredQuery: [{ name: 'grant_type', value: 'password' }] },
};
const authentication: RunAuthentication = {
  initialState: { cookies: [], origins: [] },
  approvedTestOrigins: ['https://app.example.test'],
  auditExclusions: { excludedPathPrefixes: [], auditPathPrefixes: [], dangerousTerms: [] },
  sessionLostPathPrefix: '/auth',
  filterState: (state) => state,
  auditStage: AUDIT_STAGE,
};

describe('DEF-233 B: serviceUnauthorizedSessionLostDetailOf', () => {
  it('takes a 401 of the page that made the page unreadable as the loss of the session', () => {
    const { factoryOptions, state } = jobContextFactoryOptions(authentication, () => 0, 'REGISTERED');
    if (state === null) throw new Error('the state was not made');
    const before = serviceUnauthorizedCountOf(state);
    expect(serviceUnauthorizedSessionLostDetailOf(state, before, true, true)).toBeNull();
    factoryOptions.onServiceUnauthorizedResponse?.();
    expect(serviceUnauthorizedSessionLostDetailOf(state, before, true, true)).toBe(SERVICE_UNAUTHORIZED_DETAIL);
    // その画面が描けなかった画面でなければ、切れにしない。
    expect(serviceUnauthorizedSessionLostDetailOf(state, before, false, true)).toBeNull();
    // 前の画面の 401 は、次の画面の切れにしない（読み込みの前と後の差だけ）。
    expect(serviceUnauthorizedSessionLostDetailOf(state, serviceUnauthorizedCountOf(state), true, true)).toBeNull();
  });

  // fix round 1（設計書 2.3 の 4）: 自動でログインし直せない（手動のログインの）プロファイルは、止めずに今のとおり続ける。
  it('does not take the 401 as the loss of the session for a profile that cannot sign in again by itself (manual login)', () => {
    const { factoryOptions, state } = jobContextFactoryOptions(authentication, () => 0, 'REGISTERED');
    if (state === null) throw new Error('the state was not made');
    const before = serviceUnauthorizedCountOf(state);
    factoryOptions.onServiceUnauthorizedResponse?.();
    expect(serviceUnauthorizedSessionLostDetailOf(state, before, true, false)).toBeNull();
  });

  it('does nothing without the audit stage', () => {
    expect(serviceUnauthorizedCountOf(null)).toBeNull();
    expect(serviceUnauthorizedSessionLostDetailOf(null, null, true, true)).toBeNull();
  });
});

describe('DEF-233 B: the closed list of the session loss details', () => {
  it('has the key loss and the service 401, and the artifacts use the same list', () => {
    expect(SERVICE_UNAUTHORIZED_DETAIL).toBe('SERVICE_UNAUTHORIZED');
    expect([...SESSION_LOST_DETAILS]).toEqual([SESSION_KEY_LOST_DETAIL, SERVICE_UNAUTHORIZED_DETAIL]);
    expect([...JOB_END_REASON_DETAILS]).toEqual([...SESSION_LOST_DETAILS]);
  });

  it('describes every detail with the current text of the stop by the loss of the session (no new text)', () => {
    for (const detail of SESSION_LOST_DETAILS) {
      expect(JOB_END_REASON_DETAIL_DESCRIPTIONS[detail]).toBe(DISCOVERY_END_REASON_CATALOG.AUTH_SESSION_LOST.description);
    }
  });
});
