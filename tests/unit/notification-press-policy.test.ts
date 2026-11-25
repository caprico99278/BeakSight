// 通知の枠の閉じる押下の期間の判定（設計書 `doc/design/2026-11-06-beaksight-notification-overlay-design.md` 3.2.1 の 2〜4。NO-2 fix round 2）の単体テスト。
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_URL_WORDS } from '../../src/core/default-excluded-url-words.js';
import {
  NOTIFICATION_DISMISSAL_BLOCK_REASON,
  SCROLL_KEY_PRESS_BLOCK_REASON,
  classifyPassiveRequest,
  notificationPressDecisionOf,
  type HttpRequestFacts,
  type PassiveRequestPolicyOptions,
} from '../../src/safety/request-policy.js';

const ORIGIN = 'http://127.0.0.1:8100';
const OTHER = 'http://127.0.0.1:8300';
const ALLOWED: ReadonlySet<string> = new Set([ORIGIN]);

const facts = (method: string, url: string, extra: Partial<HttpRequestFacts> = {}): HttpRequestFacts => ({
  kind: 'HTTP', method, url, isNavigationRequest: false, isMainFrame: false, ...extra,
});

const auditSend = { approvedServiceOrigins: [], dangerousTerms: DEFAULT_EXCLUDED_URL_WORDS };
const policyOf = (mode: PassiveRequestPolicyOptions['notificationPress']): PassiveRequestPolicyOptions => ({ auditSend, notificationPress: mode });
const reasonOf = (decision: ReturnType<typeof classifyPassiveRequest>): string => (decision.action === 'BLOCK' ? decision.reason : 'ALLOW');

describe('REV-EV4: the key press period on a scrollable region', () => {
  it('stops the main frame navigations (including a form send) and leaves the other requests to the current rules', () => {
    const policy: PassiveRequestPolicyOptions = { auditSend, scrollKeyPress: true };
    expect(reasonOf(classifyPassiveRequest(facts('GET', `${ORIGIN}/moved`, { isNavigationRequest: true, isMainFrame: true }), ALLOWED, policy))).toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    expect(reasonOf(classifyPassiveRequest(facts('POST', `${ORIGIN}/form`, { isNavigationRequest: true, isMainFrame: true }), ALLOWED, policy))).toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    expect(reasonOf(classifyPassiveRequest(facts('GET', `${ORIGIN}/frame`, { isNavigationRequest: true, isMainFrame: false }), ALLOWED, policy))).toBe('ALLOW');
    expect(reasonOf(classifyPassiveRequest(facts('POST', `${ORIGIN}/api/mark`), ALLOWED, policy))).toBe('ALLOW');
  });

  it('FRET: in the press period of a window button, also stops every non-read request of any frame, and lets the reads go', () => {
    const policy: PassiveRequestPolicyOptions = { auditSend, scrollKeyPress: 'DIALOG_PRESS' };
    expect(reasonOf(classifyPassiveRequest(facts('DELETE', `${ORIGIN}/api/items/1`, { isMainFrame: true }), ALLOWED, policy))).toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    expect(reasonOf(classifyPassiveRequest(facts('POST', `${ORIGIN}/api/frame-post`, { isNavigationRequest: true }), ALLOWED, policy))).toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    expect(reasonOf(classifyPassiveRequest(facts('POST', `${OTHER}/beacon`), ALLOWED, policy))).toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    expect(reasonOf(classifyPassiveRequest(facts('GET', `${ORIGIN}/api/list`), ALLOWED, policy))).toBe('ALLOW');
  });

  it('FRET fix round 3: in the press period, also stops a new WebSocket and the reads of a logout or delete path', () => {
    const policy: PassiveRequestPolicyOptions = { auditSend: { ...auditSend, webSockets: true }, scrollKeyPress: 'DIALOG_PRESS' };
    // FRETWS（設計書 `2026-11-25-beaksight-discovery-sibling-press-design.md` 2.2）: 押す期間に止めた接続は、押下の記録の理由（普通の止めと分ける）。
    expect(reasonOf(classifyPassiveRequest({ kind: 'WEBSOCKET', url: 'ws://127.0.0.1:8100/ws' }, ALLOWED, policy))).toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    expect(reasonOf(classifyPassiveRequest(facts('GET', `${ORIGIN}/logout`), ALLOWED, policy))).toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    expect(reasonOf(classifyPassiveRequest(facts('GET', `${ORIGIN}/api/items/1/delete`, { isNavigationRequest: true }), ALLOWED, policy)))
      .toBe(SCROLL_KEY_PRESS_BLOCK_REASON);
    // fix round 4: 操作の前の判定と同じ語（日本語・ログアウトの語を含む）を、符号化を解いてから当てる。案内の語の続く名詞は通す。
    const stopped = ['/api/items/1/Delete', '/api/items/1/de%6Cete', '/api/x?op=remove', '/api/%E5%89%8A%E9%99%A4/1', '/account/unsubscribe',
      '/api/items/1/purge', '/api/items/1/archive', '/session/%E3%83%AD%E3%82%B0%E3%82%A2%E3%82%A6%E3%83%88', '/api/x?q=del%2565te', '/api/items/1/_delete',
      '/api/LogOut', '/api/x?redirect=%2Flogout', '/api/items/1/trash', '/api/items/1/reset'];
    expect(stopped.filter((path) => reasonOf(classifyPassiveRequest(facts('GET', `${ORIGIN}${path}`), ALLOWED, policy)) !== SCROLL_KEY_PRESS_BLOCK_REASON)).toEqual([]);
    expect(reasonOf(classifyPassiveRequest(facts('GET', `${ORIGIN}/api/items/1/deletion/faq`), ALLOWED, policy))).toBe('ALLOW');
    // 押す期間の外（キーの押下の期間だけ）は、WebSocket を今の判定のまま通す。
    expect(reasonOf(classifyPassiveRequest({ kind: 'WEBSOCKET', url: 'ws://127.0.0.1:8100/ws' }, ALLOWED, { ...policy, scrollKeyPress: true }))).toBe('ALLOW');
  });
});

describe('the close press period of a notification frame', () => {
  it('does nothing outside the press period', () => {
    expect(notificationPressDecisionOf(facts('POST', `${OTHER}/x`), ALLOWED, { auditSend })).toBeNull();
  });

  it('AUDIT: stops only the sends with a credential in the URL, and leaves the moves and the other sends to the current rules (RB-14a, X11)', () => {
    const policy = policyOf('AUDIT');
    const blocked = [
      facts('POST', `${ORIGIN}/api/notice?access_token=abc`),
      facts('POST', `${ORIGIN.replace('://', '://user:pass@')}/api/notice`),
    ];
    expect(blocked.map((request) => reasonOf(classifyPassiveRequest(request, ALLOWED, policy)))).toEqual(blocked.map(() => NOTIFICATION_DISMISSAL_BLOCK_REASON));
    const current = [
      facts('POST', `${OTHER}/v/notice`),
      facts('POST', `${OTHER}/v/beacon`, { resourceType: 'ping' }),
      facts('GET', `${ORIGIN}/moved`, { isNavigationRequest: true, isMainFrame: true }),
      facts('POST', `${ORIGIN}/api/form`, { isNavigationRequest: true, isMainFrame: true }),
      facts('GET', `${OTHER}/img.png`),
    ];
    expect(current.map((request) => notificationPressDecisionOf(request, ALLOWED, policy))).toEqual(current.map(() => null));
    // SD-2: 許可 Origin の外への main frame の移動と DELETE も止めない（移った画面は点検しない。削除は押す前の判定が受け持つ）。
    expect(classifyPassiveRequest(facts('GET', `${OTHER}/moved`, { isNavigationRequest: true, isMainFrame: true }), ALLOWED, policy).action).toBe('ALLOW');
    expect(classifyPassiveRequest(facts('DELETE', `${ORIGIN}/api/notice`), ALLOWED, policy).action).toBe('ALLOW');
  });

  it('DISCOVERY: lets only the frozen reads go to the current rules, and stops every other request', () => {
    const policy = policyOf('DISCOVERY');
    expect(notificationPressDecisionOf(facts('GET', `${ORIGIN}/api/items`), ALLOWED, policy)).toBeNull();
    const blocked = [
      facts('POST', `${ORIGIN}/api/notice-dismissed`),
      facts('DELETE', `${ORIGIN}/api/notice`),
      facts('GET', `${OTHER}/img.png`),
      facts('GET', `${ORIGIN}/moved`, { isNavigationRequest: true, isMainFrame: true }),
    ];
    expect(blocked.map((request) => reasonOf(classifyPassiveRequest(request, ALLOWED, policy)))).toEqual(blocked.map(() => NOTIFICATION_DISMISSAL_BLOCK_REASON));
  });
});
