// DEF-235（設計書 `2026-11-09-beaksight-read-check-record-id-fill-design.md`。FIX-235 の指示書の読み替え）: 番号の入る画面の READ の確かめで、番号を自動で埋める。
// - 元の選び方（`readCheckRecordIdsOf`）: 元 1（操作さがしで読み切れた同じ型の画面）・元 2（点検の段のリンク）・元 3（書き込みで作った登録）の番号を、近い順に
//   重ねずに全部（数で削らない）。型に当たらない・形の違う番号は入れない。
// - 一覧の画面の path（`readCheckListPagePathOf`）と、一覧のリンクからの番号（`recordIdsOfLinkUrls`）。
// - 一致の決まり（`isPageOpenedReadCheckDefinition`・`pageOpenedEvidenceOf`）: 自動の下書きが作った型の定義は、画面が開けたら一致。
// - 番号ごとの結果（`readCheckRecordsEvidenceOf`）: 代表の結果（はっきり違うものが先、次に判定できないもの）と、番号ごとの記録。
// - 新しい理由 `RECORD_ID_NOT_AVAILABLE`（閉じた一覧・結果・表示の文・スキーマ）と、IPC の `recordIds`。
import { describe, expect, it } from 'vitest';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS } from '../../src/control/approval/api-scenario-autodraft.js';
import {
  WORKER_PROTOCOL_VERSION,
  WORKER_READ_CHECK_JOB_KIND,
  targetConfigDigestOf,
  validateParentToWorkerMessage,
  workerAuthenticationDigestOf,
} from '../../src/control/worker-protocol.js';
import { FORM_NAVIGATION_SETUP_ITEMS } from '../helpers/auth-setup-samples.js';
import type { AuthSetup } from '../../src/control/auth/auth-setup-contracts.js';
import {
  READ_CHECK_DETAILS,
  READ_CHECK_DETAIL_RESULTS,
  READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
  pageOpenedEvidenceOf,
  readCheckRecordsEvidenceOf,
  type ReadCheckExecutedEvidence,
} from '../../src/discovery/read-check-evaluation.js';
import {
  READ_CHECK_PAGE_OPENED_EXPECTATIONS,
  isPageOpenedReadCheckDefinition,
  readCheckListPagePathOf,
  readCheckRecordIdsOf,
  recordIdsOfLinkUrls,
} from '../../src/discovery/read-check-record-ids.js';
import { READ_CHECK_DETAIL_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { hasAllowedOrigin } from '../../src/safety/request-policy.js';

const ORIGIN = 'http://127.0.0.1:4173';
const OTHER_ORIGIN = 'http://127.0.0.1:4174';
const TEMPLATE = '/admin/items/{id}';
/** 開始の URL の Origin の URL か（呼ぶ側と同じく、Origin の判定の owner で決める）。 */
const IS_START_ORIGIN = (url: string): boolean => hasAllowedOrigin(url, new Set([ORIGIN]));

describe('DEF-235: the sources of the record ids (all of them, nearest first)', () => {
  it('takes every id of the read pages, then of the audit links, then of the created records, without duplicates', () => {
    expect(readCheckRecordIdsOf({
      template: TEMPLATE,
      isStartOrigin: IS_START_ORIGIN,
      readPagePaths: ['/admin/items', '/admin/items/12', '/admin/items/7', '/admin/other/3'],
      auditLinkUrls: [`${ORIGIN}/admin/items/7`, `${ORIGIN}/admin/items/30`, `${OTHER_ORIGIN}/admin/items/31`, `${ORIGIN}/admin/items/30?x=1`],
      createdRecordIds: ['44', '12', '45'],
    })).toEqual(['12', '7', '30', '44', '45']);
  });

  it('uses a later source when an earlier one has nothing, and gives none when no source has an id', () => {
    expect(readCheckRecordIdsOf({ template: TEMPLATE, isStartOrigin: IS_START_ORIGIN, readPagePaths: [], auditLinkUrls: [], createdRecordIds: ['9'] })).toEqual(['9']);
    expect(readCheckRecordIdsOf({ template: TEMPLATE, isStartOrigin: IS_START_ORIGIN, readPagePaths: ['/admin/items'], auditLinkUrls: [], createdRecordIds: [] })).toEqual([]);
  });

  it('leaves out an id that is not of a usable form or does not look like a record id', () => {
    expect(readCheckRecordIdsOf({
      template: TEMPLATE,
      isStartOrigin: IS_START_ORIGIN,
      readPagePaths: ['/admin/items/new', '/admin/items/edit', '/admin/items/12/extra', '/admin/items/'],
      auditLinkUrls: [`${ORIGIN}/admin/items/a%20b`, 'not a url'],
      createdRecordIds: ['x'.repeat(65), 'a/b', '', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    })).toEqual(['3f2504e0-4f89-11d3-9a0c-0305e82c3301']);
  });

  it('gives none for a definition that is not a template', () => {
    expect(readCheckRecordIdsOf({ template: '/admin/items', isStartOrigin: IS_START_ORIGIN, readPagePaths: ['/admin/items'], auditLinkUrls: [], createdRecordIds: ['1'] })).toEqual([]);
  });

  it('tells the list page of a template (the path before the id) and the ids of its links of the same origin', () => {
    expect(readCheckListPagePathOf(TEMPLATE)).toBe('/admin/items');
    expect(readCheckListPagePathOf('/admin/items/{id}/view')).toBe('/admin/items');
    expect(readCheckListPagePathOf('/admin/items')).toBeNull();
    expect(recordIdsOfLinkUrls(TEMPLATE, IS_START_ORIGIN, [`${ORIGIN}/admin/items/2`, `${ORIGIN}/admin/items/2`, `${OTHER_ORIGIN}/admin/items/3`, `${ORIGIN}/admin/items/new`]))
      .toEqual(['2']);
  });
});

describe('DEF-235: the rule of a template definition made by the automatic draft (the page opened)', () => {
  const evaluated = (overrides: Partial<ReadCheckExecutedEvidence> = {}): ReadCheckExecutedEvidence => ({
    readCheckId: 'read-template',
    readCheckRevision: 1,
    targetKind: 'PAGE',
    targetPagePath: TEMPLATE,
    state: 'EXECUTED',
    result: 'UNDETERMINED',
    detail: 'EXPECTATIONS_EVALUATED',
    url: `${ORIGIN}/admin/items/12`,
    httpStatus: 200,
    blockedRequests: 0,
    structure: null,
    expectations: [],
    ...overrides,
  });

  it('knows the template definition of the automatic draft by its placeholder expectation', () => {
    expect(READ_CHECK_PAGE_OPENED_EXPECTATIONS).toBe(AUTO_DRAFT_READ_CHECK_PLACEHOLDER_EXPECTATIONS);
    expect(isPageOpenedReadCheckDefinition({ targetPagePath: TEMPLATE, parameters: {}, expectations: [...READ_CHECK_PAGE_OPENED_EXPECTATIONS] })).toBe(true);
    expect(isPageOpenedReadCheckDefinition({ targetPagePath: TEMPLATE, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 2 }] })).toBe(false);
    expect(isPageOpenedReadCheckDefinition({ targetPagePath: TEMPLATE, parameters: {}, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] })).toBe(false);
    expect(isPageOpenedReadCheckDefinition({ targetPagePath: '/admin/items', parameters: {}, expectations: [...READ_CHECK_PAGE_OPENED_EXPECTATIONS] })).toBe(false);
  });

  it('says MATCHED for a page that opened and was read, and keeps every other detail', () => {
    expect(pageOpenedEvidenceOf(evaluated())).toEqual(evaluated({ result: 'MATCHED', expectations: [] }));
    for (const detail of ['HTTP_ERROR_STATUS', 'NAVIGATION_FAILED', 'RESULT_PAGE_UNREADABLE', 'SESSION_LOST', 'SERVICE_READ_REFUSED'] as const) {
      const other = evaluated({ detail });
      expect(pageOpenedEvidenceOf(other)).toBe(other);
    }
  });
});

describe('DEF-235: one definition with the results of each record', () => {
  const recordEvidence = (recordId: string, result: ReadCheckExecutedEvidence['result'], detail: ReadCheckExecutedEvidence['detail'] = 'EXPECTATIONS_EVALUATED'): ReadCheckExecutedEvidence => ({
    readCheckId: 'read-template',
    readCheckRevision: 2,
    targetKind: 'PAGE',
    targetPagePath: TEMPLATE,
    state: 'EXECUTED',
    result,
    detail,
    url: `${ORIGIN}/admin/items/${recordId}`,
    httpStatus: 200,
    blockedRequests: 0,
    structure: null,
    expectations: [],
    documentRequests: 1,
  });

  it('takes NOT_MATCHED first, then a result that is not MATCHED, then the first one, and keeps every record', () => {
    const matched = readCheckRecordsEvidenceOf([recordEvidence('1', 'MATCHED'), recordEvidence('2', 'MATCHED')]);
    expect(matched).toMatchObject({ result: 'MATCHED', url: `${ORIGIN}/admin/items/1` });
    expect(matched.records?.map(({ url, result }) => [url, result])).toEqual([[`${ORIGIN}/admin/items/1`, 'MATCHED'], [`${ORIGIN}/admin/items/2`, 'MATCHED']]);
    expect(matched.records?.[0]).toEqual({
      result: 'MATCHED', detail: 'EXPECTATIONS_EVALUATED', url: `${ORIGIN}/admin/items/1`, httpStatus: 200, blockedRequests: 0, structure: null, expectations: [],
      documentRequests: 1,
    });
    expect(readCheckRecordsEvidenceOf([recordEvidence('1', 'MATCHED'), recordEvidence('2', 'UNDETERMINED', 'HTTP_ERROR_STATUS'), recordEvidence('3', 'NOT_MATCHED')]))
      .toMatchObject({ result: 'NOT_MATCHED', url: `${ORIGIN}/admin/items/3` });
    expect(readCheckRecordsEvidenceOf([recordEvidence('1', 'MATCHED'), recordEvidence('2', 'READ_BLOCKED_BY_POLICY', 'REQUEST_POLICY')]))
      .toMatchObject({ result: 'READ_BLOCKED_BY_POLICY', detail: 'REQUEST_POLICY' });
  });

  it('passes the schema with the records and the new detail', async () => {
    const documentOf = (checks: readonly unknown[]): unknown => JSON.parse(JSON.stringify({
      schemaVersion: READ_EVIDENCE_ARTIFACT_SCHEMA_VERSION,
      jobId: 'job-read-1',
      runId: 'RUN-20261109000000',
      startedAt: '20261109000000',
      finishedAt: '20261109000100',
      runStatus: 'PARTIAL',
      endReason: 'COMPLETED',
      checks,
    }));
    const filled = readCheckRecordsEvidenceOf([recordEvidence('1', 'MATCHED'), recordEvidence('2', 'NOT_MATCHED')]);
    const missing = { ...recordEvidence('1', 'UNDETERMINED', 'RECORD_ID_NOT_AVAILABLE'), url: null, httpStatus: null };
    expect(await validateArtifact('read-evidence', documentOf([filled, missing]))).toEqual({ ok: true });
    expect((await validateArtifact('read-evidence', documentOf([{ ...filled, records: [{ ...filled.records?.[0], rows: [] }] }]))).ok).toBe(false);
  });
});

describe('DEF-235: the new reason RECORD_ID_NOT_AVAILABLE', () => {
  it('is in the closed list, says UNDETERMINED and has one sentence for the screen', () => {
    expect(READ_CHECK_DETAILS).toContain('RECORD_ID_NOT_AVAILABLE');
    expect(READ_CHECK_DETAILS.slice(-2)).toEqual(['SERVICE_READ_REFUSED', 'AUDIT_STAGE_REQUEST_BLOCKED']);
    expect(READ_CHECK_DETAIL_RESULTS.RECORD_ID_NOT_AVAILABLE).toBe('UNDETERMINED');
    expect(READ_CHECK_DETAIL_DESCRIPTIONS.RECORD_ID_NOT_AVAILABLE).toBe('見る登録がまだないため、見ていません。');
  });
});

describe('DEF-235: the record ids of START', () => {
  const SETUP: AuthSetup = Object.freeze({
    ...FORM_NAVIGATION_SETUP_ITEMS,
    profileId: 'example-read',
    profileRevision: 1,
    loginStartUrl: `${ORIGIN}/login`,
    loginPostEndpoints: [{ origin: ORIGIN, path: '/login' }],
    successCondition: { pathPrefix: '/admin', selector: null },
    sessionLostCondition: { pathPrefix: null },
    excludedPaths: [],
    auditPathPrefixes: ['/admin'],
    maxLoginAttempts: 2,
    allowedIdpOrigins: [],
    automatedLogin: null,
  });
  const templateCheck = (extra: Record<string, unknown>, path = TEMPLATE): Record<string, unknown> => ({
    readCheckId: 'read-1',
    readCheckRevision: 1,
    targetPage: { origin: ORIGIN, path },
    definition: { targetPagePath: path, parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] },
    ...extra,
  });
  const errorsOf = (readCheck: Record<string, unknown>): readonly string[] => {
    const checked = validateParentToWorkerMessage({
      protocol: WORKER_PROTOCOL_VERSION,
      type: 'START',
      jobId: 'job-read',
      jobKind: WORKER_READ_CHECK_JOB_KIND,
      targetConfigPath: 'local/targets/example-read.json',
      startNew: true,
      targetConfigSha256: targetConfigDigestOf(new TextEncoder().encode('{}')),
      authentication: {
        setup: SETUP,
        approvedTestOrigins: [ORIGIN],
        authenticationSha256: workerAuthenticationDigestOf(SETUP, [ORIGIN], { jobKind: WORKER_READ_CHECK_JOB_KIND, automatedLogin: null }),
      },
      readChecks: [readCheck],
    });
    return checked.ok ? [] : checked.errors;
  };

  it('accepts the record ids of a template definition, many of them, and none at all', () => {
    expect(errorsOf(templateCheck({ recordIds: ['12', '7'] }))).toEqual([]);
    expect(errorsOf(templateCheck({ recordIds: Array.from({ length: 100 }, (_value, index) => String(index + 1)) }))).toEqual([]);
    expect(errorsOf(templateCheck({}))).toEqual([]);
  });

  it('rejects the record ids of a definition that is not a template, a duplicate, an empty list and an unsafe id', () => {
    expect(errorsOf(templateCheck({ recordIds: ['1'] }, '/admin/items'))).toEqual(['/readChecks/0/recordIds is allowed only for a page path template']);
    expect(errorsOf(templateCheck({ recordIds: ['1', '1'] }))).toEqual(['/readChecks/0/recordIds must be unique']);
    expect(errorsOf(templateCheck({ recordIds: [] })).length).toBeGreaterThan(0);
    expect(errorsOf(templateCheck({ recordIds: ['a/b'] })).length).toBeGreaterThan(0);
  });
});
