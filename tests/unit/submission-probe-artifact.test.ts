// T37c（Task 37 の設計書 3.4）: 候補の任意の項目 `submissionProbe` の契約と JSON Schema（`schemas/control/candidate.schema.json`、
// `schemas/discovery.schema.json`）と、同じ識別の digest の候補のまとめ（`mergeDiscoveryCandidates`）。
// - スキーマの上限は、型の契約（`src/core/api-request-shape.ts`）の名前つきの定数と一致する。閉じた一覧の enum の一致は `schema-enum-consistency.test.ts`。
// - 結果と理由と型の組み合わせ（`NOT_OBSERVED` は型なし、`API_CREATE`・`API_UPDATE` は型あり、など）。値の項目は拒む。
// - 成果物の版は 1.1 のまま（任意の項目）。前の版 1.0 の成果物は `submissionProbe` を持てない。
// - まとめ: 同じ識別の digest で型が違えば別の行として残す（索引に渡す項目は同じ）。同じ型なら 1 件。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { candidateOfDiscoveryDocumentByShape } from '../../src/control/discovery-candidate-lookup.js';
import { discoveryIndexEntryOf, type DiscoveryIndexEntry } from '../../src/control/job/discovery-index-store.js';
import {
  apiRequestShapeOf,
  MAX_API_SHAPE_BODY_KEYS,
  MAX_API_SHAPE_HEADER_NAMES,
  MAX_API_SHAPE_MARKERS,
  MAX_API_SHAPE_MEDIA_TYPE_LENGTH,
  MAX_API_SHAPE_NAME_LENGTH,
  MAX_API_SHAPE_PATH_LENGTH,
  MAX_API_SHAPE_QUERY_NAMES,
  type ApiRequestShape,
} from '../../src/core/api-request-shape.js';
import { MAX_HTTP_METHOD_LENGTH } from '../../src/core/limits.js';
import { validateArtifact } from '../../src/core/schema-validator.js';
import { apiShapeDigestOf } from '../../src/discovery/api-shape-classification.js';
import { MAX_CANDIDATE_FIELDS, MAX_FIELD_NAME_LENGTH, type DiscoveredCandidate, type DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { DISCOVERY_ARTIFACT_SCHEMA_VERSION, DUPLICATE_IDENTITY_CONFLICT_REASON, mergeDiscoveryCandidates, type DiscoveryDocument } from '../../src/discovery/discovery-result.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import {
  MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH,
  notObservedSubmissionProbeOf,
  observedSubmissionProbeOf,
  type SubmissionProbeRecord,
} from '../../src/discovery/submission-probe-contracts.js';
import { NO_JS_BINDING, SAMPLE_ALLOWED_ORIGINS, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'https://api.example.test';
const FIELDS = { filledFieldCount: 3, skippedFieldCount: 1 };
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', 'bsprobe00000000000c'];

const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(discovered),
});

const SAVE = candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: '/admin/members/new' }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } }));

const shapeOf = (method: string, url: string, body: unknown, pagePath = '/admin/members/1/edit'): ApiRequestShape => apiRequestShapeOf({
  method,
  resourceType: 'fetch',
  url,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json', prefer: 'return=representation', authorization: 'Bearer secret-token-value' },
  body: { kind: 'TEXT', text: JSON.stringify(body) },
}, { pagePath, markers: MARKERS });

const CREATE_SHAPE = shapeOf('POST', `${API}/rest/v1/members`, { name: MARKERS[0], email: MARKERS[1], note: MARKERS[2] }, '/admin/members/new');
const OTHER_CREATE_SHAPE = shapeOf('POST', `${API}/rest/v1/members_shadow`, {}, '/admin/members/new');
const UPDATE_SHAPE = shapeOf('PATCH', `${API}/rest/v1/members?id=eq.1&select=*`, { name: MARKERS[0] });

const observed = (shapes: readonly ApiRequestShape[]): SubmissionProbeRecord =>
  observedSubmissionProbeOf({ shapes, nonReadRequestCount: shapes.length, readRequestCount: 0, unrecordedShapeCount: 0 }, FIELDS);

const withProbe = (candidate: DiscoveryCandidate, probe: SubmissionProbeRecord): DiscoveryCandidate => ({ ...candidate, submissionProbe: probe });

const expectValid = (value: unknown): void => {
  const result = validateControlDocument('candidate', JSON.parse(JSON.stringify(value)));
  expect(result.ok ? [] : result.errors).toEqual([]);
};
const expectInvalid = (value: unknown, name: string): void => {
  expect(validateControlDocument('candidate', JSON.parse(JSON.stringify(value))).ok, name).toBe(false);
};

const documentOf = (candidates: readonly DiscoveryCandidate[]): DiscoveryDocument => ({
  schemaVersion: DISCOVERY_ARTIFACT_SCHEMA_VERSION,
  jobId: 'job-1',
  runId: 'RUN-20261017010000',
  startedAt: '20261017010000',
  finishedAt: '20261017010100',
  runStatus: 'COMPLETE',
  endReason: 'COMPLETED',
  maxPages: 10,
  pages: [{ url: `${SAMPLE_ORIGIN}/admin/members/new`, state: 'READ', record: { location: SAVE.page, incompleteReasons: [], candidates }, blockedRequests: 1 }],
  omittedUnreadPages: 0,
});

type JsonSchema = Record<string, unknown> & { readonly properties?: Record<string, JsonSchema>; readonly $defs?: Record<string, JsonSchema>; readonly items?: JsonSchema; readonly anyOf?: readonly JsonSchema[] };
const candidateSchema = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas', 'control', 'candidate.schema.json'), 'utf8')) as JsonSchema;
const defs = candidateSchema.$defs ?? {};
const prop = (node: JsonSchema | undefined, key: string): JsonSchema => node?.properties?.[key] ?? {};

describe('T37c: the submissionProbe item of the candidate schema', () => {
  it('uses the named limits of the shape contract', () => {
    const shape = defs['apiRequestShape'];
    expect(prop(shape, 'method').maxLength).toBe(MAX_HTTP_METHOD_LENGTH);
    expect(prop(shape, 'resourceType').maxLength).toBe(MAX_API_SHAPE_NAME_LENGTH);
    expect(prop(shape, 'pathShape').maxLength).toBe(MAX_API_SHAPE_PATH_LENGTH);
    expect(prop(shape, 'queryNames').maxItems).toBe(MAX_API_SHAPE_QUERY_NAMES);
    expect(prop(shape, 'queryNames').items?.maxLength).toBe(MAX_API_SHAPE_NAME_LENGTH);
    expect(prop(shape, 'filters').maxItems).toBe(MAX_API_SHAPE_QUERY_NAMES);
    expect(prop(shape, 'headerNames').maxItems).toBe(MAX_API_SHAPE_HEADER_NAMES);
    expect(prop(shape, 'headerNames').items?.maxLength).toBe(MAX_API_SHAPE_NAME_LENGTH);
    expect(prop(shape, 'contentType').anyOf?.[0]?.maxLength).toBe(MAX_API_SHAPE_MEDIA_TYPE_LENGTH);
    const body = defs['apiRequestBody'];
    expect(prop(body, 'keys').maxItems).toBe(MAX_API_SHAPE_BODY_KEYS);
    expect(prop(body, 'markerKeys').maxItems).toBe(MAX_API_SHAPE_BODY_KEYS);
    expect(prop(body, 'markerKeys').items?.properties?.['markers']?.maxItems).toBe(MAX_API_SHAPE_MARKERS);
    expect(prop(body, 'markerKeys').items?.properties?.['markers']?.items?.maximum).toBe(MAX_API_SHAPE_MARKERS - 1);
    expect(candidateSchema.required).not.toContain('submissionProbe');
  });

  it('accepts a candidate without a probe and with each kind of the probe', () => {
    expectValid(SAVE);
    expectValid(withProbe(SAVE, observed([CREATE_SHAPE])));
    expectValid(withProbe(SAVE, observed([UPDATE_SHAPE])));
    expectValid(withProbe(SAVE, observed([])));
    expectValid(withProbe(SAVE, observed([CREATE_SHAPE, CREATE_SHAPE])));
    expectValid(withProbe(SAVE, observedSubmissionProbeOf({ shapes: [], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 1 }, FIELDS)));
    for (const reason of ['PAGE_CHANGED', 'PRESS_LIMIT_REACHED', 'TARGET_NOT_FOUND', 'PRESS_FAILED'] as const) {
      expectValid(withProbe(SAVE, notObservedSubmissionProbeOf(reason)));
    }
  });

  it('rejects a broken combination, a value item and an unknown reason', () => {
    const create = observed([CREATE_SHAPE]);
    const notObserved = notObservedSubmissionProbeOf('PAGE_CHANGED');
    const cases: readonly (readonly [string, unknown])[] = [
      ['NOT_OBSERVED with a shape', { ...notObserved, shape: CREATE_SHAPE, shapeDigest: create.shapeDigest }],
      ['NOT_OBSERVED with a NOT_EXECUTABLE reason', { ...notObserved, reason: 'UPSERT' }],
      ['NOT_EXECUTABLE with a NOT_OBSERVED reason', { ...observed([CREATE_SHAPE, CREATE_SHAPE]), reason: 'PAGE_CHANGED' }],
      ['API_CREATE without a shape', { ...create, shape: null, shapeDigest: null }],
      ['API_CREATE with a reason', { ...create, reason: 'UPSERT' }],
      ['NO_REQUEST with a shape', { ...observed([]), shape: CREATE_SHAPE, shapeDigest: create.shapeDigest }],
      ['an unknown reason', { ...notObserved, reason: 'SOMETHING' }],
      ['an unknown result', { ...create, result: 'CREATE' }],
      ['a value item', { ...create, value: 'x' }],
      ['a marker list', { ...create, markers: MARKERS }],
      ['a body value in the shape', { ...create, shape: { ...CREATE_SHAPE, body: { ...CREATE_SHAPE.body, values: ['x'] } } }],
      ['a header value in the shape', { ...create, shape: { ...CREATE_SHAPE, headers: { authorization: 'x' } } }],
      ['a negative count', { ...create, readRequestCount: -1 }],
      ['a broken digest', { ...create, shapeDigest: 'sha256:x' }],
      ['an index on another Origin kind', { ...create, shape: { ...CREATE_SHAPE, origin: { kind: 'OTHER', index: 0 } } }],
    ];
    for (const [name, probe] of cases) {
      expectInvalid({ ...SAVE, submissionProbe: probe }, name);
    }
  });

  it('never writes the markers, the body values or the secret header value into the probe', () => {
    const text = JSON.stringify(withProbe(SAVE, observed([CREATE_SHAPE])));
    for (const value of [...MARKERS, 'secret-token-value']) {
      expect(text.includes(value), value).toBe(false);
    }
  });
});

describe('T37c: the version of discovery.json with the probe', () => {
  it('keeps the writer version 1.1 and accepts the probe in a 1.1 document', async () => {
    expect(DISCOVERY_ARTIFACT_SCHEMA_VERSION).toBe('discovery-schema/1.1');
    const result = await validateArtifact('discovery', JSON.parse(JSON.stringify(documentOf([withProbe(SAVE, observed([CREATE_SHAPE]))]))));
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe('T37c: merging the candidates with probes (design 3.4)', () => {
  /** 索引の 1 件の、型の digest の一覧（T38d。行ごとに違う）のほかの項目。 */
  const withoutShapes = (entry: DiscoveryIndexEntry): Omit<DiscoveryIndexEntry, 'shapeDigests' | 'keyFieldDigests'> => {
    // T38R-fix の I-1: 鍵と欄の対応の digest の一覧も、型ごとの行で違う。
    const { shapeDigests: _shapes, keyFieldDigests: _keyFields, ...rest } = entry;
    return rest;
  };

  it('keeps one row for the same identity and the same shape', () => {
    const first = withProbe(SAVE, observed([CREATE_SHAPE]));
    const second = withProbe(SAVE, observed([CREATE_SHAPE]));
    expect(mergeDiscoveryCandidates([first, second])).toEqual([first]);
  });

  it('keeps another row for the same identity with another shape (the order of first appearance)', () => {
    const create = withProbe(SAVE, observed([CREATE_SHAPE]));
    const shadow = withProbe(SAVE, observed([OTHER_CREATE_SHAPE]));
    const merged = mergeDiscoveryCandidates([create, shadow, create]);
    expect(merged).toEqual([create, shadow]);
    // 索引に渡す項目は、型の digest の一覧のほかは同じ（索引は識別の digest で 1 件にまとめ、T38d: 型の一覧を合わせる）。
    expect(withoutShapes(discoveryIndexEntryOf(merged[0] as DiscoveryCandidate)))
      .toEqual(withoutShapes(discoveryIndexEntryOf(merged[1] as DiscoveryCandidate)));
    expect(merged.map((row) => discoveryIndexEntryOf(row).shapeDigests)).toEqual([[apiShapeDigestOf(CREATE_SHAPE)], [apiShapeDigestOf(OTHER_CREATE_SHAPE)]]);
  });

  it('keeps a row without a shape apart from a row with a shape', () => {
    const create = withProbe(SAVE, observed([CREATE_SHAPE]));
    const changed = withProbe(SAVE, notObservedSubmissionProbeOf('PAGE_CHANGED'));
    expect(mergeDiscoveryCandidates([changed, create, SAVE])).toEqual([changed, create]);
  });

  it('applies the conflict of the contents to every row of the identity and keeps each shape', () => {
    const bound = withProbe(SAVE, observed([CREATE_SHAPE]));
    const unbound = candidateOf(sampleButton({ page: SAVE.page, submitterText: '保存' }));
    expect(unbound.identityDigest).toBe(SAVE.identityDigest);
    const other = withProbe(unbound, observed([OTHER_CREATE_SHAPE]));
    const merged = mergeDiscoveryCandidates([bound, other]);
    expect(merged).toHaveLength(2);
    for (const row of merged) {
      expect(row).toMatchObject({ classification: 'DISPLAY_ONLY', reasonCode: DUPLICATE_IDENTITY_CONFLICT_REASON });
    }
    expect(merged.map((row) => row.submissionProbe?.shapeDigest)).toEqual([bound.submissionProbe?.shapeDigest, other.submissionProbe?.shapeDigest]);
    expect(withoutShapes(discoveryIndexEntryOf(merged[0] as DiscoveryCandidate)))
      .toEqual(withoutShapes(discoveryIndexEntryOf(merged[1] as DiscoveryCandidate)));
  });
});

describe('T38a: the fields of the probe in the candidate schema and the lookup by the shape (Task 38 design 3.1)', () => {
  const INPUT_FIELDS = [
    { name: 'name', selector: '#name', type: 'text', marker: 0 },
    { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
    { name: null, selector: null, type: 'text', marker: 2 },
    { name: 'kind', selector: 'select[name="kind"]', type: 'select-one', marker: null },
  ] as const;
  const withFields = (shapes: readonly ApiRequestShape[]): SubmissionProbeRecord =>
    observedSubmissionProbeOf({ shapes, nonReadRequestCount: shapes.length, readRequestCount: 0, unrecordedShapeCount: 0 }, FIELDS, INPUT_FIELDS);

  it('uses the named limits for the fields of the probe', () => {
    const items = prop(defs['submissionProbe'], 'inputFields').items;
    expect(prop(defs['submissionProbe'], 'inputFields').maxItems).toBe(MAX_CANDIDATE_FIELDS);
    expect(prop(items, 'name').anyOf?.[0]?.maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect(prop(items, 'selector').anyOf?.[0]?.maxLength).toBe(MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH);
    expect(prop(items, 'marker').anyOf?.[0]?.maximum).toBe(MAX_API_SHAPE_MARKERS - 1);
    expect((defs['submissionProbe']?.['required'] as readonly string[] | undefined) ?? []).not.toContain('inputFields');
  });

  it('accepts the fields of the probe (and a probe written before T38a without them)', () => {
    expectValid(withProbe(SAVE, withFields([CREATE_SHAPE])));
    expectValid(withProbe(SAVE, notObservedSubmissionProbeOf('PAGE_CHANGED', FIELDS, INPUT_FIELDS)));
    const { inputFields: _omitted, ...before } = withFields([CREATE_SHAPE]);
    expectValid(withProbe(SAVE, before as SubmissionProbeRecord));
  });

  it('rejects a value, a marker out of the range and an unknown type in the fields of the probe', () => {
    const probe = withFields([CREATE_SHAPE]);
    const cases: readonly (readonly [string, unknown])[] = [
      ['a value', [{ ...INPUT_FIELDS[0], value: 'x' }]],
      ['a marker value', [{ ...INPUT_FIELDS[0], markerValue: MARKERS[0] }]],
      ['a marker out of the range', [{ ...INPUT_FIELDS[0], marker: MAX_API_SHAPE_MARKERS }]],
      ['an unknown type', [{ ...INPUT_FIELDS[0], type: 'button' }]],
      ['a too long selector', [{ ...INPUT_FIELDS[0], selector: `#${'a'.repeat(MAX_SUBMISSION_PROBE_FIELD_SELECTOR_LENGTH)}` }]],
      ['a missing selector', [{ name: 'name', type: 'text', marker: 0 }]],
    ];
    for (const [name, inputFields] of cases) {
      expectInvalid({ ...SAVE, submissionProbe: { ...probe, inputFields } }, name);
    }
  });

  it('looks up the row by the identity digest and the shape digest (rows of the same identity with other shapes stay apart)', () => {
    const create = withProbe(SAVE, withFields([CREATE_SHAPE]));
    const shadow = withProbe(SAVE, withFields([OTHER_CREATE_SHAPE]));
    const document = documentOf([create, shadow]);
    expect(candidateOfDiscoveryDocumentByShape(document, SAVE.identityDigest, create.submissionProbe?.shapeDigest ?? '')).toEqual(create);
    expect(candidateOfDiscoveryDocumentByShape(document, SAVE.identityDigest, shadow.submissionProbe?.shapeDigest ?? '')).toEqual(shadow);
    expect(candidateOfDiscoveryDocumentByShape(document, SAVE.identityDigest, apiShapeDigestOf(UPDATE_SHAPE))).toBeNull();
    expect(candidateOfDiscoveryDocumentByShape(null, SAVE.identityDigest, create.submissionProbe?.shapeDigest ?? '')).toBeNull();
  });

  it('never finds a row by the shape from a probe written before T38a (the numbers of the markers were not reset then)', () => {
    const { inputFields: _omitted, ...before } = withFields([CREATE_SHAPE]);
    const old = withProbe(SAVE, before as SubmissionProbeRecord);
    expect(candidateOfDiscoveryDocumentByShape(documentOf([old]), SAVE.identityDigest, before.shapeDigest ?? '')).toBeNull();
  });
});
