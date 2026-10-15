// T28c（Task 28 の設計書 3 章の「発見の根拠の写し」）: 発見のジョブの `discovery.json` から候補を探す読み方の owner
// （`src/control/discovery-candidate-lookup.ts`）。画面のサーバ（`apps/local-ui/src/server/discovery-documents.ts`）とシナリオの保存の部品が、
// 同じこの読み方を使う（同じ識別の digest の候補をまとめた後で探す。ジョブの管理と READ の実行と同じまとめ方 `mergeDiscoveryCandidates`）。
import { describe, expect, it } from 'vitest';
import { candidateOfDiscoveryDocument, mergedDiscoveryCandidatesOf } from '../../src/control/discovery-candidate-lookup.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { CREATE_CANDIDATE, READ_CANDIDATE, UPDATE_CANDIDATE } from './approval-samples.js';

const documentOf = (candidates: readonly DiscoveryCandidate[]): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-000001',
  startedAt: '20261012000000',
  finishedAt: '20261012000000',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [
    { url: 'http://127.0.0.1:4173/a', state: 'READ', record: { location: { origin: 'http://127.0.0.1:4173', path: '/a' }, incompleteReasons: [], candidates: [...candidates] }, blockedRequests: 0 },
    { url: 'http://127.0.0.1:4173/b', state: 'NOT_READ', reason: 'EXCLUDED' },
  ],
  omittedUnreadPages: 0,
});

describe('discovery candidate lookup (T28c)', () => {
  it('merges the candidates of a document with the owner of the merge, and is empty without a document', () => {
    const candidates = [CREATE_CANDIDATE, UPDATE_CANDIDATE, CREATE_CANDIDATE];
    expect(mergedDiscoveryCandidatesOf(documentOf(candidates))).toEqual(mergeDiscoveryCandidates(candidates));
    expect(mergedDiscoveryCandidatesOf(null)).toEqual([]);
  });

  it('finds the candidate of an identity digest, and null when the document or the candidate is missing', () => {
    const document = documentOf([CREATE_CANDIDATE, UPDATE_CANDIDATE]);
    expect(candidateOfDiscoveryDocument(document, UPDATE_CANDIDATE.identityDigest)).toEqual(UPDATE_CANDIDATE);
    expect(candidateOfDiscoveryDocument(document, READ_CANDIDATE.identityDigest)).toBeNull();
    expect(candidateOfDiscoveryDocument(null, CREATE_CANDIDATE.identityDigest)).toBeNull();
  });
});
