// RCA-1（設計書 `doc/design/2026-11-18-beaksight-search-check-design.md` 2.1）: 操作さがしが自分で起こした読み取りの記録の契約。
// - 応答の状態の判定: 500・501・505〜599 は誤り、429・502・503・504 はサイトの不調、ほかの 4xx は誤りにしない、応答なしは判定しない。
// - 読み取りの記録は形だけ（path の型・query の名前・目印を運んだ query の名前・状態）。値は残さない。
// - 画面の記録の任意の項目 `searchTriggers` は、記録を作り直しても残り、成果物のスキーマに通る。
import { describe, expect, it } from 'vitest';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  withIncompleteReason,
  type DiscoveryDocument,
  type DiscoveryReadPageRecord,
} from '../../src/discovery/discovery-result.js';
import {
  searchReadRecordOf,
  searchReadVerdictOf,
  withSearchTriggers,
  type DiscoverySearchTriggerRecord,
} from '../../src/discovery/search-read-contracts.js';
import { notObservedSubmissionProbeOf, withSubmissionProbes } from '../../src/discovery/submission-probe-contracts.js';
import { candidateOf } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN as ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const MARKER = 'bsprobe0123456789ab';

describe('the verdict of the status of a read the discovery caused', () => {
  it('counts only 500, 501 and 505 to 599 as an error of the site', () => {
    expect([500, 501, 505, 599].map(searchReadVerdictOf)).toEqual(['SERVER_ERROR', 'SERVER_ERROR', 'SERVER_ERROR', 'SERVER_ERROR']);
    expect([429, 502, 503, 504].map(searchReadVerdictOf)).toEqual(['SITE_UNAVAILABLE', 'SITE_UNAVAILABLE', 'SITE_UNAVAILABLE', 'SITE_UNAVAILABLE']);
    expect([400, 404].map(searchReadVerdictOf)).toEqual(['CLIENT_ERROR', 'CLIENT_ERROR']);
    expect([200, 304].map(searchReadVerdictOf)).toEqual(['OK', 'OK']);
    expect(searchReadVerdictOf(null)).toBe('NO_RESPONSE');
    expect(searchReadVerdictOf(600)).toBe('NON_STANDARD');
  });
});

describe('the record of a read (shape only)', () => {
  it('keeps the path shape, the query names, the names that carried a marker and the status, and no value', () => {
    const record = searchReadRecordOf(
      { method: 'GET', resourceType: 'fetch', url: `${ORIGIN}/api/items/42?word=${MARKER}&status=open`, status: 500 },
      { pagePath: '/items', markers: [MARKER] },
    );
    expect(record).toEqual({
      method: 'GET', resourceType: 'fetch', pathShape: '/api/items/{id}', queryNames: ['status', 'word'], markerQueryNames: ['word'], status: 500,
    });
    expect(JSON.stringify(record)).not.toContain(MARKER);
    expect(JSON.stringify(record)).not.toContain('open');
  });
});

describe('the search triggers of a page record', () => {
  const trigger: DiscoverySearchTriggerRecord = {
    trigger: { kind: 'OPTION', stage: 1, priorPresses: [], field: { kind: 'SELECT', name: 'status', ordinal: 0 }, optionIndex: 2 },
    reads: [{ method: 'GET', resourceType: 'fetch', pathShape: '/api/items', queryNames: ['status'], markerQueryNames: [], status: 500 }],
  };
  const typed: DiscoverySearchTriggerRecord = {
    trigger: { kind: 'TYPED', stage: 1, priorPresses: [], field: { name: 'kw', selector: '#kw', type: 'search' } },
    reads: [{ method: 'GET', resourceType: 'xhr', pathShape: '/api/items', queryNames: ['q'], markerQueryNames: ['q'], status: 200 }],
  };
  const record: DiscoveryReadPageRecord = withSearchTriggers({
    location: { origin: ORIGIN, path: '/items' },
    incompleteReasons: [],
    candidates: [candidateOf(sampleButton({ page: { origin: ORIGIN, path: '/items' }, submitterText: '検索', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } }))],
  }, [trigger]);

  it('appends the triggers and keeps them when the record is rebuilt', () => {
    const both = withSearchTriggers(record, [typed]);
    expect(both.searchTriggers).toEqual([trigger, typed]);
    expect(withSubmissionProbes(both, new Map([[0, notObservedSubmissionProbeOf('PAGE_CHANGED', { filledFieldCount: 0, skippedFieldCount: 0 }, [])]]))
      .searchTriggers).toEqual([trigger, typed]);
    expect(withIncompleteReason(both, 'INCOMPLETE_PAGE_NAVIGATION_LIMIT').searchTriggers).toEqual([trigger, typed]);
    expect(withSearchTriggers(record, [])).toBe(record);
  });

  it('passes the discovery schema, and rejects a value in a read', async () => {
    const documentOf = (pageRecord: unknown): DiscoveryDocument => JSON.parse(JSON.stringify({
      schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION, jobId: 'job-1', runId: 'RUN-20261118010000', startedAt: '20261118010000',
      finishedAt: '20261118010100', runStatus: 'COMPLETE', endReason: 'COMPLETED', pages: [{ url: `${ORIGIN}/items`, state: 'READ', record: pageRecord, blockedRequests: 0 }],
      omittedUnreadPages: 0,
    })) as DiscoveryDocument;
    const ok = await validateArtifact('discovery', documentOf(withSearchTriggers(record, [typed])));
    expect(ok.ok ? [] : ok.errors).toEqual([]);
    const withValue = { ...record, searchTriggers: [{ ...trigger, reads: [{ ...trigger.reads[0], url: `${ORIGIN}/api/items?status=closed` }] }] };
    expect((await validateArtifact('discovery', documentOf(withValue))).ok).toBe(false);
  });
});
