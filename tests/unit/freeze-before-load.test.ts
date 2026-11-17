// SAFE-2 の 1（COV-2c の M-1）: まだ読み込んでいない page を凍結の段にする口（`activateInteractionFreezeBeforeLoad`）の条件。
// 条件は、Guard が `PASSIVE_ACTIVE` で、準備のできた page がただ 1 つで、その page が `about:blank`（まだ読み込んでいない）こと。ログインの段や書き込みの段の
// Guard では拒む（凍結の段は Passive の監査と操作さがしのためのもの）。条件の判定は 1 か所（`freezeBeforeLoadRefusalOf`）。
import { describe, expect, it } from 'vitest';
import { freezeBeforeLoadRefusalOf, type FreezeBeforeLoadFacts } from '../../src/safety/passive-request-guard.js';

const ready: FreezeBeforeLoadFacts = Object.freeze({
  phase: 'PASSIVE_ACTIVE',
  pageReady: true,
  onlyOwnerPage: true,
  url: 'about:blank',
  submissionStage: false,
});

describe('the conditions of the freeze before the first load', () => {
  it('admits a ready, only, not yet loaded page of a Passive guard', () => {
    expect(freezeBeforeLoadRefusalOf(ready)).toBeNull();
  });

  it.each([
    ['an already frozen guard', { phase: 'FROZEN_ACTIVE' }],
    ['a closing guard', { phase: 'PASSIVE_CLOSING' }],
    ['a page whose guard is not ready', { pageReady: false }],
    ['a Context with another open page', { onlyOwnerPage: false }],
    ['a page that has loaded an http(s) document', { url: 'https://example.test/' }],
    ['a page on another non-http URL', { url: 'about:srcdoc' }],
    ['a login stage or write stage guard', { submissionStage: true }],
  ] as const)('refuses %s', (_label, change) => {
    expect(freezeBeforeLoadRefusalOf({ ...ready, ...change } as FreezeBeforeLoadFacts)).toEqual(expect.any(String));
  });
});
