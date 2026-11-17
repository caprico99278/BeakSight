// DEF-138（設計書 `2026-10-19-beaksight-session-loss-evidence-design.md` 2.1）: セッションの切れの証拠の部品（`authenticated-run.ts` の
// `sessionLossEvidenceOf`・`observeSessionLossNavigation`）の表を固定する。
// - 頼んだ URL と行き着いた先は path と query の名前だけ（値に見える区切りと名前は伏せる）。行き着いた先は判定と同じ順（main frame の最後の URL、Guard が
//   止めた main frame の移動の先）。
// - 経路は main frame の文書の要求だけを記録する。止めた要求は形ごとに数える（LZ-3a: どちらも数の上限はない）。
// - 鍵の名前の違いは、許可 Origin と承認したサービスの Origin の、ローカル ストレージの鍵と Cookie の名前の違いを、ログインの段の観察と同じ決まりの
//   接頭辞と接尾辞の案と数で残す。値（token、Cookie の値、query の値）はどこにも出ない（目印の値で確かめる）。
// 例の値は、匿名の値（`example.com`）だけを使う。
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import type { AuthenticatedContextStateNames } from '../../src/browser/context-factory.js';
import { MAX_SESSION_LOSS_STORAGE_KEY_CHANGES } from '../../src/core/evidence-types.js';
import {
  observeSessionLossNavigation,
  sessionLossEvidenceOf,
  type SessionLossEvidenceInput,
} from '../../src/orchestration/authenticated-run.js';
import { SafetyLedger } from '../../src/safety/safety-ledger.js';
import { fakePlaywrightRequest } from '../helpers/fake-playwright-request.js';

/** LZ-3a: 撤廃した経路の段と止めた要求の行の数の上限（前の `MAX_SESSION_LOSS_REDIRECT_PATHS`・`MAX_SESSION_LOSS_BLOCKED_REQUESTS`）の写し。 */
const FORMER_MAX_SESSION_LOSS_REDIRECT_PATHS = 10;
const FORMER_MAX_SESSION_LOSS_BLOCKED_REQUESTS = 8;
const APP = 'https://app.example.com';
const API = 'https://api.example.com';
const OTHER = 'https://other.example.com';
const PREFIX = '/login';
/** 目印の値（どこにも出てはいけない）。 */
const TOKEN_VALUE = 'eyJhbGciOiJIUzI1NiJ9.eyJtYXJrZXIiOiJ0b2tlbiJ9.c2lnbmF0dXJlLW1hcmtlcg';
const QUERY_VALUE = 'marker-query-value';
const COOKIE_VALUE = 'marker-cookie-value';

/** `url()` だけを持つ偽の page。 */
const pageAt = (url: string): Page => ({ url: () => url }) as unknown as Page;

const baseInput = (overrides: Partial<SessionLossEvidenceInput> = {}): SessionLossEvidenceInput => ({
  stage: 'desktop:passive',
  requestedUrl: `${APP}/admin/members?page=${QUERY_VALUE}`,
  page: pageAt(`${APP}/login?next=${QUERY_VALUE}&token=${TOKEN_VALUE}`),
  ledger: new SafetyLedger(),
  sessionLostPathPrefix: PREFIX,
  navigation: { urls: [], omitted: 0 },
  stateNames: null,
  allowedOrigins: [APP],
  serviceOrigins: [API],
  ...overrides,
});

const expectNoMarkers = (value: unknown): void => {
  const text = JSON.stringify(value);
  for (const marker of [TOKEN_VALUE, QUERY_VALUE, COOKIE_VALUE]) {
    expect(text).not.toContain(marker);
  }
};

describe('DEF-138: sessionLossEvidenceOf (the evidence of the load where the session was lost)', () => {
  it('records the requested and the landed paths with the query names only, and the landed URL from the page', () => {
    const evidence = sessionLossEvidenceOf(baseInput());
    expect(evidence.stage).toBe('desktop:passive');
    expect(evidence.requestedPath).toBe('/admin/members?page');
    expect(evidence.landedPath).toBe('/login?next&token');
    expect(evidence.landedBy).toBe('PAGE_URL');
    expectNoMarkers(evidence);
  });

  it('takes the landed URL from the main frame navigation blocked by the Guard when the page did not move (the same order as the judgement)', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedAuditExclusion({ method: 'GET', url: `${APP}/login/expired?reason=${QUERY_VALUE}`, mainFrameNavigation: true, reason: 'AUDIT_EXCLUDED_URL', resourceType: 'document', phase: 'LOAD' });
    const evidence = sessionLossEvidenceOf(baseInput({ page: pageAt(`${APP}/admin/members`), ledger }));
    expect(evidence.landedPath).toBe('/login/expired?reason');
    expect(evidence.landedBy).toBe('BLOCKED_REDIRECT');
    // 止めた main frame の移動の先は page の事象に出ないので、Ledger の記録から経路の最後に足す。
    expect(evidence.redirectPaths).toEqual([{ originKind: 'ALLOWED', path: '/login/expired?reason' }]);
    expect(evidence.blockedRequests).toEqual([{ method: 'GET', originKind: 'ALLOWED', path: '/login/expired', reason: 'AUDIT_EXCLUDED_URL', count: 1 }]);
    expectNoMarkers(evidence);
  });

  it('keeps the page URL as the landed URL when the session key was lost without a login path (and a null path for a page without a URL)', () => {
    expect(sessionLossEvidenceOf(baseInput({ stage: 'session-key', page: pageAt(`${APP}/admin`) }))).toMatchObject({ landedPath: '/admin', landedBy: 'PAGE_URL' });
    expect(sessionLossEvidenceOf(baseInput({ page: pageAt('about:blank') })).landedPath).toBeNull();
  });

  // LZ-3a: 経路の段の数の上限（前は 10）は撤廃した。前の上限を超える段も残らず残す（`redirectPathsOmitted` は前の記録の形のために残し、0）。
  it('records every step of the route of the main frame documents with the origin kinds, and redacts value-like segments', () => {
    const urls = [
      `${APP}/admin/members`,
      `${OTHER}/sso/${TOKEN_VALUE}`,
      `${API}/session/refresh`,
      ...Array.from({ length: FORMER_MAX_SESSION_LOSS_REDIRECT_PATHS }, (_value, index) => `${APP}/step/${index}`),
    ];
    const evidence = sessionLossEvidenceOf(baseInput({ navigation: { urls, omitted: 0 } }));
    expect(evidence.redirectPaths.slice(0, 3)).toEqual([
      { originKind: 'ALLOWED', path: '/admin/members' },
      { originKind: 'OTHER', path: '/sso/[REDACTED]' },
      { originKind: 'SERVICE', path: '/session/refresh' },
    ]);
    expect(evidence.redirectPaths).toHaveLength(urls.length);
    expect(evidence.redirectPathsOmitted).toBe(0);
    expectNoMarkers(evidence);
  });

  // LZ-3a: 行の数の上限（前は 8）は撤廃した。前の上限を超える行も残らず残す。
  it('aggregates the requests blocked by the Guard by the shape, and keeps every row beyond the former limit', () => {
    const ledger = new SafetyLedger();
    ledger.recordBlockedRequest({
      method: 'POST', url: `${API}/token?grant_type=refresh_token&refresh_token=${TOKEN_VALUE}`, reason: 'NON_READ_METHOD', resourceType: 'fetch', phase: 'LOAD',
    });
    ledger.recordBlockedRequest({ method: 'POST', url: `${API}/token?grant_type=refresh_token`, reason: 'NON_READ_METHOD', resourceType: 'fetch', phase: 'LOAD' });
    ledger.recordBlockedNavigation({ method: 'GET', url: `${OTHER}/sso?ticket=${QUERY_VALUE}`, reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION', phase: 'LOAD' });
    for (let index = 0; index < FORMER_MAX_SESSION_LOSS_BLOCKED_REQUESTS + 2; index += 1) {
      ledger.recordBlockedRequest({ method: 'POST', url: `${APP}/beacon/${index}`, reason: 'NON_READ_METHOD', resourceType: 'ping', phase: 'LOAD' });
    }
    const evidence = sessionLossEvidenceOf(baseInput({ ledger }));
    // 2 行（/token と /sso）と、/beacon の 10 行。
    expect(evidence.blockedRequests).toHaveLength(FORMER_MAX_SESSION_LOSS_BLOCKED_REQUESTS + 4);
    // main frame の移動を止めた記録と監査の段の除外を先に、ページが出した要求を後に並べる。
    expect(evidence.blockedRequests[0]).toEqual({ method: 'GET', originKind: 'OTHER', path: '/sso', reason: 'EXTERNAL_MAIN_FRAME_NAVIGATION', count: 1 });
    expect(evidence.blockedRequests[1]).toEqual({ method: 'POST', originKind: 'SERVICE', path: '/token', reason: 'NON_READ_METHOD', count: 2 });
    expect(evidence.blockedRequestsUnlisted).toBe(0);
    expectNoMarkers(evidence);
  });

  it('records the key name differences of the allowed and the service origins as shapes and counts, without values', () => {
    const stateNames: AuthenticatedContextStateNames = {
      given: {
        cookies: [{ domain: 'app.example.com', name: 'sid' }, { domain: '.other.example.com', name: 'tracking' }],
        origins: [{ origin: APP, names: ['fixture-auth-token', 'app.settings'] }],
        indexedDB: [],
      },
      read: {
        cookies: [{ domain: 'api.example.com', name: 'session_id' }, { domain: '.other.example.com', name: 'tracking2' }],
        origins: [{ origin: APP, names: ['app.settings', 'login-redirect'] }, { origin: OTHER, names: ['other-token'] }],
        indexedDB: [],
      },
    };
    const evidence = sessionLossEvidenceOf(baseInput({ stateNames }));
    expect(evidence.storageKeyChange).toEqual([
      { storage: 'LOCAL_STORAGE', originKind: 'ALLOWED', change: 'REMOVED', count: 1, shapes: [{ prefix: '', suffix: '-token' }] },
      { storage: 'LOCAL_STORAGE', originKind: 'ALLOWED', change: 'ADDED', count: 1, shapes: [] },
      { storage: 'COOKIE', originKind: 'ALLOWED', change: 'REMOVED', count: 1, shapes: [] },
      { storage: 'COOKIE', originKind: 'SERVICE', change: 'ADDED', count: 1, shapes: [{ prefix: 'session_', suffix: '' }] },
    ]);
    expectNoMarkers(evidence);
  });

  it('has no key name differences when the state was not read (null), and an empty list when nothing changed', () => {
    const given = { cookies: [], origins: [{ origin: APP, names: ['fixture-auth-token'] }], indexedDB: [{ origin: APP, names: ['auth-db'] }] };
    expect(sessionLossEvidenceOf(baseInput({ stateNames: { given, read: null } })).storageKeyChange).toBeNull();
    expect(sessionLossEvidenceOf(baseInput({ stateNames: null })).storageKeyChange).toBeNull();
    expect(sessionLossEvidenceOf(baseInput({ stateNames: { given, read: given } })).storageKeyChange).toEqual([]);
  });

  // DEF-139（設計書 `2026-10-20-beaksight-login-state-carryover-design.md` 2.1）: IndexedDB のデータベースの名前の違いも、同じ決まり（形と数）で残す。
  it('records the IndexedDB database name differences of the allowed and the service origins, without values', () => {
    const stateNames: AuthenticatedContextStateNames = {
      given: { cookies: [], origins: [], indexedDB: [{ origin: APP, names: ['auth.token-db', 'cache-db'] }] },
      read: { cookies: [], origins: [], indexedDB: [{ origin: APP, names: ['cache-db'] }, { origin: API, names: ['session_store'] }, { origin: OTHER, names: ['x'] }] },
    };
    expect(sessionLossEvidenceOf(baseInput({ stateNames })).storageKeyChange).toEqual([
      { storage: 'INDEXED_DB', originKind: 'ALLOWED', change: 'REMOVED', count: 1, shapes: [{ prefix: 'auth.', suffix: '' }] },
      { storage: 'INDEXED_DB', originKind: 'SERVICE', change: 'ADDED', count: 1, shapes: [{ prefix: 'session_', suffix: '' }] },
    ]);
    expect(MAX_SESSION_LOSS_STORAGE_KEY_CHANGES).toBe(3 * 3 * 2);
  });
});

describe('DEF-138: observeSessionLossNavigation (the route of the main frame documents of a load)', () => {
  /** `request` の事象を出せる偽の page（main frame は 1 つ）。 */
  const fakePage = (): { readonly page: Page; readonly emit: (url: string, mainFrame: boolean, navigation: boolean) => void } => {
    const emitter = new EventEmitter();
    const mainFrame = {};
    const page = { on: emitter.on.bind(emitter), off: emitter.off.bind(emitter), mainFrame: () => mainFrame } as unknown as Page;
    const emit = (url: string, isMain: boolean, navigation: boolean): void => {
      emitter.emit('request', fakePlaywrightRequest({ url, navigation, frame: isMain ? mainFrame : {} }));
    };
    return { page, emit };
  };

  // LZ-3a: 段の数の上限（前は 10）は撤廃した。
  it('records every main frame navigation request beyond the former limit, and stops after dispose', () => {
    const { page, emit } = fakePage();
    const observer = observeSessionLossNavigation(page);
    emit(`${APP}/admin`, true, true);
    emit(`${APP}/app.js`, true, false);
    emit(`${APP}/frame`, false, true);
    for (let index = 0; index < FORMER_MAX_SESSION_LOSS_REDIRECT_PATHS + 1; index += 1) {
      emit(`${APP}/step/${index}`, true, true);
    }
    observer.dispose();
    emit(`${APP}/after`, true, true);
    const record = observer.snapshot();
    expect(record.urls[0]).toBe(`${APP}/admin`);
    expect(record.urls).toHaveLength(FORMER_MAX_SESSION_LOSS_REDIRECT_PATHS + 2);
    expect(record.omitted).toBe(0);
    expect(record.urls).not.toContain(`${APP}/after`);
  });
});
