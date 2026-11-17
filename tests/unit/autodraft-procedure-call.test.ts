// DEF-208-3（設計書 `2026-11-05-beaksight-discovery-coverage-design.md` 3.6 の H）: サーバの関数の呼び出し（`/functions/` の下）を手続きの呼び出しとして扱い、
// 欄に結び付く鍵が 0 の登録の型を、一覧の行（自動の下書き）にしない。
// - 候補は、調べ（DEF-208-research）の伏せた写しの登録の画面の「登録」の候補の形を、一般の名前に置き換えたもの（`/functions/v1/<名前>` への POST で、本文の
//   1 つの鍵に 5 つの欄の目印がまとめて入り、欄にちょうど 1 つ結び付く鍵はない）。
import { describe, expect, it } from 'vitest';
import { apiAutoDraftRowsOf } from '../../src/control/approval/api-scenario-autodraft.js';
import { API_PROCEDURE_PATH_SEGMENTS, hasApiProcedureCallSegment, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import { classifyApiShapeObservation } from '../../src/discovery/api-shape-classification.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';

const SHAPE = {
  method: 'POST',
  resourceType: 'xhr',
  origin: { kind: 'APPROVED_API', index: 0 },
  pathShape: '/functions/v1/compose-text',
  queryNames: [],
  omittedQueryNameCount: 0,
  filters: [],
  headerNames: ['accept', 'authorization', 'content-type'],
  omittedHeaderNameCount: 0,
  contentType: 'application/json',
  prefer: [],
  body: {
    kind: 'OBJECT',
    keys: [
      { name: 'current_text', type: 'string' },
      { name: 'instruction', type: 'string' },
      { name: 'max_chars', type: 'number' },
      { name: 'purpose', type: 'string' },
      { name: 'reference', type: 'string' },
    ],
    omittedKeyCount: 0,
    markerKeys: [{ key: 'reference', markers: [1, 3, 4, 7, 8] }],
    stateKeyPresent: false,
  },
} as unknown as ApiRequestShape;

const inputFields = Array.from({ length: 9 }, (_value, marker) => ({
  name: null,
  selector: marker === 0 ? null : `#field-${String(marker)}`,
  type: marker === 6 ? 'number' : 'text',
  marker,
}));

const candidateOf = (shape: ApiRequestShape, markerKeys = shape.body.markerKeys): DiscoveryCandidate => ({
  page: { origin: 'http://127.0.0.1:1/', path: '/admin/staff/new' },
  kind: 'BUTTON',
  formMethod: null,
  methodOverride: null,
  action: null,
  enctype: null,
  target: null,
  fields: [],
  submitterWords: ['登録'],
  jsBinding: { form: [], submitter: ['click'], ancestor: [], document: [], window: [], inlineHandler: false },
  incompleteReasons: [],
  classification: 'NEEDS_BINDING',
  reasonCode: 'JS_DELEGATED',
  hasStateField: false,
  identityDigest: `sha256:${'1'.repeat(64)}`,
  ruleDigest: `sha256:${'2'.repeat(64)}`,
  submissionProbe: {
    result: 'API_CREATE',
    reason: null,
    shape: { ...shape, body: { ...shape.body, markerKeys } },
    shapeDigest: `sha256:${'3'.repeat(64)}`,
    nonReadRequestCount: 1,
    readRequestCount: 0,
    unrecordedShapeCount: 0,
    filledFieldCount: 9,
    skippedFieldCount: 4,
    inputFields,
  },
} as unknown as DiscoveryCandidate);

describe('DEF-208-3 H: the server function call and the create shape without a key bound to a field', () => {
  it('takes a path under /functions/ as a procedure call, like /rpc/', () => {
    expect(API_PROCEDURE_PATH_SEGMENTS).toEqual(['rpc', 'functions']);
    expect(hasApiProcedureCallSegment('/functions/v1/compose-text')).toBe(true);
    expect(hasApiProcedureCallSegment('/rest/v1/rpc/list_items')).toBe(true);
    expect(hasApiProcedureCallSegment('/%66unctions/v1/compose-text')).toBe(true);
    expect(hasApiProcedureCallSegment('/rest/v1/items')).toBe(false);
    expect(classifyApiShapeObservation({ shapes: [SHAPE], nonReadRequestCount: 1 })).toMatchObject({
      classification: 'NOT_EXECUTABLE',
      reason: 'PROCEDURE_CALL_PATH',
    });
  });

  it('does not make a row of the create shape whose keys are bound to no field (the copied candidate)', () => {
    expect(apiAutoDraftRowsOf([candidateOf(SHAPE)])).toEqual([]);
  });

  it('still makes a row of a create shape with a key bound to exactly one field', () => {
    const shape = { ...SHAPE, pathShape: '/rest/v1/staff' } as unknown as ApiRequestShape;
    const rows = apiAutoDraftRowsOf([candidateOf(shape, [{ key: 'reference', markers: [1] }])]);
    expect(rows.map(({ kind }) => kind)).toEqual(['CREATE']);
  });
});
