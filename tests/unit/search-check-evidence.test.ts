// RCA-5（検索の確かめの設計書 `doc/design/2026-11-18-beaksight-search-check-design.md` 2.2・2.5）: 検索の確かめの判定と、成果物 `read-evidence.json` 1.3 の
// `searchChecks`。
// - 判定: 主の文書かきっかけの読み取りが 500・501・505〜599 は誤り。4xx は誤りにしない。2 回目もログインの画面へ戻されたら誤り。フォームの画面は開けて
//   検索だけ開けなければ誤り。BeakSight が止めた移動・きっかけが読み取りを出さない・たどり直せない・hidden を送らないフォームの組の 5xx は判定できない。
//   空の値で読み取りが出ないのは問題なし。
// - 誤りがあっても Run の状態は COMPLETE（確かめなかった組があれば PARTIAL）。件数の要約に組の数と誤りの数。
// - 版は 1.3 だけを読む（LG-4）。DEF-235 の番号の理由（RECORD_ID_NOT_AVAILABLE）はない。
import { describe, expect, it } from 'vitest';
import { validateArtifact } from '../../src/core/schema-validator.js';
import {
  READ_CHECK_DETAILS,
  READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  readEvidenceRunStatusOf,
  readEvidenceSummaryOf,
  formSearchCheckEvidenceOf,
  searchCheckEvidenceBaseOf,
  searchCheckVerdictOf,
  type ReadCheckDetail,
  type ReadCheckEvidence,
  type ReadEvidenceDocument,
  type SearchCheckEvidence,
} from '../../src/discovery/read-check-evaluation.js';
import type { SearchCheckCombo } from '../../src/discovery/search-check-plan.js';
import type { SearchReadRecord } from '../../src/discovery/search-read-contracts.js';

const read = (status: number | null): SearchReadRecord => ({
  method: 'GET', resourceType: 'fetch', pathShape: '/api/items', queryNames: ['q'], markerQueryNames: ['q'], status,
});
const quiet = { unsentHiddenFields: false, emptyValue: false, blockedByBeakSight: false, loginBouncedAgain: false, searchNotOpened: false, stateNotRebuilt: false, auditStageDetail: null } as const;

describe('the verdict of one search check', () => {
  it('says ERROR only for a server error, a search that does not open and a second bounce to the login page', () => {
    expect(searchCheckVerdictOf({ ...quiet, kind: 'FORM', documentStatus: 500, reads: [] }))
      .toEqual({ result: 'ERROR', detail: 'SERVER_ERROR' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'SCRIPT', documentStatus: null, reads: [read(200), read(505)] }))
      .toEqual({ result: 'ERROR', detail: 'SERVER_ERROR' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'FORM', documentStatus: null, reads: [], searchNotOpened: true }))
      .toEqual({ result: 'ERROR', detail: 'NOT_OPENED' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'FORM', documentStatus: 200, reads: [], loginBouncedAgain: true }))
      .toEqual({ result: 'ERROR', detail: 'LOGIN_BOUNCE' });
  });

  it('does not say ERROR for a 4xx, and says UNDETERMINED when it cannot judge', () => {
    expect(searchCheckVerdictOf({ ...quiet, kind: 'FORM', documentStatus: 422, reads: [] }))
      .toEqual({ result: 'NO_ERROR', detail: 'CLIENT_ERROR_STATUS' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'SCRIPT', documentStatus: null, reads: [read(200)] }))
      .toEqual({ result: 'NO_ERROR', detail: 'OPENED' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'FORM', documentStatus: 500, reads: [], unsentHiddenFields: true }))
      .toEqual({ result: 'UNDETERMINED', detail: 'UNSENT_HIDDEN_FIELDS' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'SCRIPT', documentStatus: null, reads: [] }))
      .toEqual({ result: 'UNDETERMINED', detail: 'NO_READ' });
    // REV-RCA の I-2: 空の値で読み取りが出ないのは、空では検索しないサイトの正しい動き。
    expect(searchCheckVerdictOf({ ...quiet, kind: 'SCRIPT', documentStatus: null, reads: [], emptyValue: true }))
      .toEqual({ result: 'NO_ERROR', detail: 'EMPTY_NOT_SEARCHED' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'FORM', documentStatus: null, reads: [], blockedByBeakSight: true }))
      .toEqual({ result: 'UNDETERMINED', detail: 'BLOCKED_BY_BEAKSIGHT' });
    expect(searchCheckVerdictOf({ ...quiet, kind: 'SCRIPT', documentStatus: null, reads: [], stateNotRebuilt: true }))
      .toEqual({ result: 'UNDETERMINED', detail: 'STATE_NOT_REBUILT' });
  });
});

describe('the searchChecks of read-evidence.json 1.3', () => {
  const combo: Extract<SearchCheckCombo, { readonly kind: 'FORM' }> = {
    kind: 'FORM', key: `sha256:${'b'.repeat(64)}`, page: { origin: 'http://127.0.0.1:4173', path: '/items' }, targetIdentityDigest: `sha256:${'c'.repeat(64)}`,
    parameters: { q: '' }, change: { kind: 'TEXT', field: 'q', text: 'FULL_WIDTH' }, unsentHiddenFields: false,
  };
  const error: SearchCheckEvidence = { ...searchCheckEvidenceBaseOf(combo), state: 'EXECUTED', result: 'ERROR', detail: 'SERVER_ERROR', httpStatus: 500, reads: [] };
  const left: SearchCheckEvidence = { ...searchCheckEvidenceBaseOf(combo), state: 'NOT_EXECUTED', reason: 'STOPPED' };
  const documentOf = (searchChecks: readonly SearchCheckEvidence[], endReason: ReadEvidenceDocument['endReason'] = 'COMPLETED'): ReadEvidenceDocument => ({
    schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION, jobId: 'job-1', runId: 'RUN-20261118010101', startedAt: '20261118010101',
    finishedAt: '20261118010102', runStatus: 'COMPLETE', endReason, checks: [], searchChecks,
  });

  it('writes the version 1.3, passes the schema, and has no detail of the record ids', async () => {
    expect(READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION).toBe('read-evidence-schema/1.3');
    const result = await validateArtifact('read-evidence', JSON.parse(JSON.stringify(documentOf([error, left]))));
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect((await validateArtifact('read-evidence', { ...JSON.parse(JSON.stringify(documentOf([]))), schemaVersion: 'read-evidence-schema/1.2' })).ok).toBe(false);
    expect(READ_CHECK_DETAILS as readonly string[]).not.toContain('RECORD_ID_NOT_AVAILABLE');
  });

  // RCA-7: GET のフォームの組を定義の READ と同じ手順で読んだ結果から、組の成果物を作る。
  it('makes the evidence of a form combo from the READ evidence, a second session loss after a re-login as LOGIN_BOUNCE', () => {
    const read = (detail: ReadCheckDetail, httpStatus: number | null): ReadCheckEvidence => ({
      readCheckId: 'x', readCheckRevision: 1, targetKind: 'CANDIDATE', targetIdentityDigest: combo.targetIdentityDigest, state: 'EXECUTED',
      result: 'UNDETERMINED', detail, url: null, httpStatus, blockedRequests: 0, structure: null, expectations: [],
    });
    expect(formSearchCheckEvidenceOf(combo, read('HTTP_ERROR_STATUS', 500), false)).toMatchObject({ result: 'ERROR', detail: 'SERVER_ERROR', httpStatus: 500 });
    expect(formSearchCheckEvidenceOf(combo, read('EXPECTATIONS_EVALUATED', 200), false)).toMatchObject({ result: 'NO_ERROR', detail: 'OPENED' });
    expect(formSearchCheckEvidenceOf(combo, read('CANDIDATE_NOT_FOUND', null), false)).toMatchObject({ result: 'UNDETERMINED', detail: 'STATE_NOT_REBUILT' });
    expect(formSearchCheckEvidenceOf(combo, read('SESSION_LOST', null), false)).toMatchObject({ state: 'NOT_EXECUTED', reason: 'AUTH_SESSION_LOST' });
    expect(formSearchCheckEvidenceOf(combo, read('SESSION_LOST', null), true)).toMatchObject({ result: 'ERROR', detail: 'LOGIN_BOUNCE' });
  });

  it('keeps COMPLETE with an error, PARTIAL with a check not done, and counts the checks and the errors', () => {
    expect(readEvidenceRunStatusOf(documentOf([error]))).toBe('COMPLETE');
    expect(readEvidenceRunStatusOf(documentOf([error, left], 'STOPPED'))).toBe('PARTIAL');
    expect(readEvidenceSummaryOf(documentOf([error, left]))).toEqual({ checks: 0, executed: 0, searchChecks: 2, searchCheckErrors: 1 });
  });
});
