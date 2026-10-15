import { describe, expect, it } from 'vitest';
import {
  BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT,
  BLOCKED_BY_CLIENT_FAILURE_TEXTS,
  isBlockedByClientFailure,
} from '../../src/browser/playwright-errors.js';

// CCX-2（CC-035）: Guard が自分で止めた文書の要求の失敗の理由は、`playwright-errors.ts` の一覧の文書の要求の値を使う（Guard に直書きしない）。
describe('the blocked-by-client failure text of document requests (CCX-2, CC-035)', () => {
  it('is the Chromium reason for document requests', () => {
    expect(BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT).toBe('net::ERR_BLOCKED_BY_CLIENT');
  });

  it('is the first entry of the closed list of blocked-by-client failure texts', () => {
    expect(BLOCKED_BY_CLIENT_FAILURE_TEXTS[0]).toBe(BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT);
    expect(isBlockedByClientFailure(BLOCKED_BY_CLIENT_DOCUMENT_FAILURE_TEXT)).toBe(true);
  });
});
