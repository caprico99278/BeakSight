// BN-c の fix（発見事項 1）: 止めた要求の失敗の理由の一覧と判定は `src/core/blocked-by-client-failures.ts` の 1 か所に定義する
// （LG-4: `src/browser/playwright-errors.ts` からの re-export は捨てた）。
// L4（サイトへの負荷の制御の設計書 4.5）: `route.abort('blockedbyclient')` で止めた要求の失敗の理由の、完全一致の閉じた一覧。
// Chromium は、文書の要求では `net::ERR_BLOCKED_BY_CLIENT`、文書以外の要求では `net::ERR_BLOCKED_BY_CLIENT.Inspector` を報告する。
import { describe, expect, it } from 'vitest';
import { BLOCKED_BY_CLIENT_FAILURE_TEXTS, isBlockedByClientFailure } from '../../src/core/blocked-by-client-failures.js';

describe('isBlockedByClientFailure (L4)', () => {
  it('lists exactly the two failure texts Chromium reports for requests aborted with blockedbyclient', () => {
    expect([...BLOCKED_BY_CLIENT_FAILURE_TEXTS]).toEqual(['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_CLIENT.Inspector']);
    expect(Object.isFrozen(BLOCKED_BY_CLIENT_FAILURE_TEXTS)).toBe(true);
  });

  it.each(['net::ERR_BLOCKED_BY_CLIENT', 'net::ERR_BLOCKED_BY_CLIENT.Inspector'])('reports %s as blocked by the client', (text) => {
    expect(isBlockedByClientFailure(text)).toBe(true);
  });

  it.each([
    ['another failure', 'net::ERR_CONNECTION_REFUSED'],
    ['an aborted request', 'net::ERR_ABORTED'],
    ['a longer text with the same prefix', 'net::ERR_BLOCKED_BY_CLIENT.Other'],
    ['a different case', 'net::err_blocked_by_client'],
    ['surrounding spaces', ' net::ERR_BLOCKED_BY_CLIENT '],
    ['a trailing space', 'net::ERR_BLOCKED_BY_CLIENT.Inspector '],
    ['a related but different reason', 'net::ERR_BLOCKED_BY_RESPONSE'],
    ['an empty text', ''],
    ['null', null],
    ['undefined', undefined],
  ])('does not report %s as blocked by the client (unknown reasons are counted)', (_label, text) => {
    expect(isBlockedByClientFailure(text)).toBe(false);
  });
});
