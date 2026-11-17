// REV-SD の I-1: 1 画面の範囲の見張り（`src/orchestration/audit-scope-watch.ts`）。本物の Chromium の代表は `tests/integration/audit-scope-move.test.ts`。
import { describe, expect, it } from 'vitest';
import { auditScopeLeftUrl, isPageInAuditScope, watchAuditScope } from '../../src/orchestration/audit-scope-watch.js';

const isOutside = (url: string): boolean => !url.startsWith('https://site.test/') || url.includes('/delete');

/** main frame の移動の事象を起こせる、偽の page。 */
const fakePage = (start: string) => {
  let current = start;
  const main = { url: () => current };
  const listeners = new Set<(frame: { url(): string }) => void>();
  return {
    url: () => current,
    mainFrame: () => main,
    on: (_event: 'framenavigated', listener: (frame: { url(): string }) => void) => listeners.add(listener),
    off: (_event: 'framenavigated', listener: (frame: { url(): string }) => void) => listeners.delete(listener),
    move: (url: string, frame: { url(): string } = main) => {
      if (frame === main) current = url;
      for (const listener of listeners) listener(frame === main ? main : { url: () => url });
    },
  };
};

describe('REV-SD I-1: the audit scope watch of a screen', () => {
  it('judges only http(s) URLs', () => {
    expect(auditScopeLeftUrl('about:blank', isOutside)).toBeNull();
    expect(auditScopeLeftUrl('chrome-error://chromewebdata/', isOutside)).toBeNull();
    expect(auditScopeLeftUrl('https://site.test/a', isOutside)).toBeNull();
    expect(auditScopeLeftUrl('https://other.test/', isOutside)).toBe('https://other.test/');
  });

  it('keeps the first outside URL of the main frame even after the page comes back, ignores child frames, and answers by the page', () => {
    const page = fakePage('about:blank');
    const watch = watchAuditScope(page, isOutside);
    page.move('https://other.test/x', { url: () => 'https://other.test/x' });
    expect([watch.outsideUrl(), isPageInAuditScope(page)]).toEqual([null, true]);
    page.move('https://site.test/account/delete');
    page.move('https://site.test/a');
    expect([watch.outsideUrl(), isPageInAuditScope(page)]).toEqual(['https://site.test/account/delete', false]);
  });

  it('re-reads the current URL when no move was seen, stops after dispose, and does not watch without a judge', () => {
    expect(watchAuditScope(fakePage('https://other.test/'), isOutside).outsideUrl()).toBe('https://other.test/');
    const page = fakePage('https://site.test/a');
    const watch = watchAuditScope(page, isOutside);
    page.move('https://site.test/b');
    watch.dispose();
    page.move('https://other.test/');
    expect(watch.outsideUrl()).toBeNull();
    const unjudged = fakePage('https://other.test/');
    expect([watchAuditScope(unjudged, undefined).outsideUrl(), isPageInAuditScope(unjudged)]).toEqual([null, true]);
  });
});
