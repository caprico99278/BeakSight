// RCA-8（検索の確かめの設計書 2.4）: 検索の確かめの結果の見せ方の材料。見るだけの確かめの誤りと、操作さがしの 5xx を、画面の名前・どう試したか・起きたことだけで
// 並べる（欄の名前・URL・値は入れない）。出すものがなければ null。
import { describe, expect, it } from 'vitest';
import type { DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import type { SearchCheckEvidence } from '../../src/discovery/read-check-evaluation.js';
import { searchCheckOutcomeOf } from '../../src/discovery/search-check-results.js';
import { SAMPLE_ORIGIN as ORIGIN } from './discovery-candidate-samples.js';

const KEY = `sha256:${'a'.repeat(64)}`;
const executed = (detail: 'OPENED' | 'SERVER_ERROR'): SearchCheckEvidence => ({
  key: KEY, trigger: 'FORM', pagePath: '/items', how: { kind: 'TEXT', field: 'q', text: 'FULL_WIDTH' }, state: 'EXECUTED',
  result: detail === 'OPENED' ? 'NO_ERROR' : 'ERROR', detail, httpStatus: detail === 'OPENED' ? 200 : 500, reads: [],
});
const discovery = (status: number): Pick<DiscoveryDocument, 'pages'> => ({
  pages: [{
    url: `${ORIGIN}/orders`, state: 'READ', blockedRequests: 0,
    record: {
      location: { origin: ORIGIN, path: '/orders' }, incompleteReasons: [], candidates: [], screenName: { heading: '注文の一覧', title: null },
      searchTriggers: [{
        trigger: { kind: 'OPTION', stage: 1, priorPresses: [], field: { kind: 'SELECT', name: 'status', ordinal: 0 }, optionIndex: 2 },
        reads: [{ method: 'GET', resourceType: 'fetch', pathShape: '/api/orders', queryNames: ['status'], markerQueryNames: [], status }],
      }],
    },
  }],
} as Pick<DiscoveryDocument, 'pages'>);

describe('the outcome of the search checks for the screens', () => {
  // REV-RCA の M-2: 操作さがしの 5xx は、見るだけの確かめの誤りと分けて別の一覧にし（同じ画面・同じ種類は 1 つ）、ためした数と誤りの数に混ぜない。
  it('lists the errors of the search checks and, apart, the 5xx of the discovery, with the screen name and how it was tried only', () => {
    const page = discovery(500).pages[0];
    const doubled = { pages: [page, page] } as Pick<DiscoveryDocument, 'pages'>;
    const outcome = searchCheckOutcomeOf({ searchChecks: [executed('OPENED'), executed('SERVER_ERROR')] }, doubled);
    expect(outcome).toEqual({
      tried: 2,
      errors: [{ screenName: null, tried: { by: 'SEARCH_CHECK', how: { kind: 'TEXT', field: 'q', text: 'FULL_WIDTH' } }, happened: 'SERVER_ERROR' }],
      explorationErrors: [{ screenName: '注文の一覧', tried: { by: 'EXPLORATION', trigger: 'OPTION' }, happened: 'SERVER_ERROR' }],
    });
  });

  it('gives null when there is no search check and no error of the discovery', () => {
    expect(searchCheckOutcomeOf(null, discovery(200))).toBeNull();
    expect(searchCheckOutcomeOf(null, null)).toBeNull();
    expect(searchCheckOutcomeOf({ searchChecks: [] }, null)).toEqual({ tried: 0, errors: [], explorationErrors: [] });
  });
});
