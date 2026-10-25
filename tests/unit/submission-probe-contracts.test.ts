// T37c（Task 37 の設計書 3.2・3.4）: 送らずに観察する probe の純粋な部品（`src/discovery/submission-probe-contracts.ts`）。
// - 対象の選び方: 分類が `NEEDS_BINDING`、削除の語でない、外部 Origin でない、ログインの画面でない。押す順は文書の順（要素の位置）で、1 画面 3 回まで。
//   DEF-142: 押す順は、登録・更新の語のあるもの、文字のあるそのほか、文字のないものの順（同じ順の中は文書の順。削除の語の候補は並べない）。
// - 目印の作り方: 型ごと（email・url・数字・日付・text 系）、欄ごとに違う（ほかの目印を含まず、含まれない）、32 まで。
// - 結果の組み立て: 観察の結果を T37b の分類（`classifyApiShapeObservation`）で結果に写す。観察しなかった理由。候補への付け方（識別の digest を変えない）。
import { describe, expect, it } from 'vitest';
import { apiRequestShapeOf, MAX_API_SHAPE_MARKERS, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import { API_SHAPE_NOT_EXECUTABLE_REASONS, apiShapeDigestOf } from '../../src/discovery/api-shape-classification.js';
import type { CandidateFieldType, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_CREATE_WORDS, DISCOVERY_DESTRUCTIVE_WORDS, DISCOVERY_UPDATE_WORDS } from '../../src/discovery/classification-words.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import {
  MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE,
  MAX_SUBMISSION_PROBE_RELOADS_PER_PAGE,
  SUBMISSION_PROBE_FILL_FIELD_TYPES,
  SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS,
  SUBMISSION_PROBE_NOT_OBSERVED_REASONS,
  SUBMISSION_PROBE_PRIORITY_WORDS,
  SUBMISSION_PROBE_QUIET_WAIT_MS,
  SUBMISSION_PROBE_REASONS,
  SUBMISSION_PROBE_RESULTS,
  compareElementPaths,
  isSubmissionProbeTarget,
  notObservedSubmissionProbeOf,
  observedSubmissionProbeOf,
  submissionProbeFieldActionOf,
  submissionProbeKeyFieldsOf,
  submissionProbeMarkerOf,
  submissionProbePressOrderOf,
  withSubmissionProbes,
  type SubmissionProbeTargetPolicy,
} from '../../src/discovery/submission-probe-contracts.js';
import { SAMPLE_ALLOWED_ORIGINS, SAMPLE_ORIGIN, OTHER_ORIGIN, sampleButton, sampleForm, type SampleCandidateOverrides } from './discovery-candidate-samples.js';

const LOGIN_PATH = '/auth';
const POLICY: SubmissionProbeTargetPolicy = {
  allowedOrigins: SAMPLE_ALLOWED_ORIGINS,
  isExcludedPage: (page) => page.path.startsWith(LOGIN_PATH),
};
const CLICK_BINDING = { form: [], submitter: ['click'], ancestor: [], document: [], window: [], inlineHandler: false } as const;

/** 分類と digest つきの候補（成果物の形）。 */
const candidateOf = (base: (overrides?: SampleCandidateOverrides) => ReturnType<typeof sampleButton>, overrides: SampleCandidateOverrides = {}): DiscoveryCandidate => {
  const discovered = base(overrides);
  return { ...discovered, ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }), ...computeCandidateDigests(discovered) };
};

const boundButton = (overrides: SampleCandidateOverrides = {}): DiscoveryCandidate =>
  candidateOf(sampleButton, { jsBinding: CLICK_BINDING, submitterText: '保存', ...overrides });

const API = 'https://api.example.test';

const createShape = (): ApiRequestShape => apiRequestShapeOf({
  method: 'POST',
  resourceType: 'fetch',
  url: `${API}/rest/v1/members`,
  origin: { kind: 'APPROVED_API', index: 0 },
  headers: { 'content-type': 'application/json' },
  body: { kind: 'TEXT', text: JSON.stringify({ name: 'bsprobe0' }) },
}, { pagePath: '/admin/members/new', markers: ['bsprobe0'] });

describe('T37c: the closed lists and the named constants of the submission probe', () => {
  it('keeps the results, the reasons and the limits', () => {
    expect(SUBMISSION_PROBE_RESULTS).toEqual(['API_CREATE', 'API_UPDATE', 'NOT_EXECUTABLE', 'NO_REQUEST', 'NOT_OBSERVED']);
    // DEF-144: Guard が Context を閉じた（`CONTEXT_CLOSED_BY_GUARD`）を、画面が移った（`PAGE_CHANGED`）と分ける。
    expect(SUBMISSION_PROBE_NOT_OBSERVED_REASONS)
      .toEqual(['PAGE_CHANGED', 'PRESS_LIMIT_REACHED', 'TARGET_NOT_FOUND', 'PRESS_FAILED', 'CONTEXT_CLOSED_BY_GUARD']);
    // DEF-144: 実行できない理由に、probe だけの `EXTERNAL_SCHEME` を足す。
    expect(SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS).toEqual([...API_SHAPE_NOT_EXECUTABLE_REASONS, 'EXTERNAL_SCHEME']);
    expect(SUBMISSION_PROBE_REASONS).toEqual([...SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS, ...SUBMISSION_PROBE_NOT_OBSERVED_REASONS]);
    expect(MAX_SUBMISSION_PROBE_PRESSES_PER_PAGE).toBe(3);
    expect(MAX_SUBMISSION_PROBE_RELOADS_PER_PAGE).toBe(1);
    expect(SUBMISSION_PROBE_QUIET_WAIT_MS).toBe(2_000);
  });
});

describe('T37c: the targets of the submission probe (design 3.2)', () => {
  it('takes a NEEDS_BINDING button and a JS-bound form', () => {
    expect(boundButton().classification).toBe('NEEDS_BINDING');
    expect(isSubmissionProbeTarget(boundButton(), POLICY)).toBe(true);
    const form = candidateOf(sampleForm, { jsBinding: { ...CLICK_BINDING, submitter: [], form: ['submit'] }, submitterText: '保存' });
    expect(form.classification).toBe('NEEDS_BINDING');
    expect(isSubmissionProbeTarget(form, POLICY)).toBe(true);
  });

  it('skips a candidate that is not NEEDS_BINDING (display only, create, read)', () => {
    expect(isSubmissionProbeTarget(candidateOf(sampleButton), POLICY)).toBe(false);
    expect(isSubmissionProbeTarget(candidateOf(sampleForm, { submitterText: '登録' }), POLICY)).toBe(false);
    expect(isSubmissionProbeTarget(candidateOf(sampleForm, { formMethod: 'GET' }), POLICY)).toBe(false);
  });

  it('skips a candidate with a destructive word, even when the classification says NEEDS_BINDING', () => {
    expect(boundButton({ submitterText: '削除' }).classification).toBe('NOT_EXECUTABLE');
    expect(isSubmissionProbeTarget(boundButton({ submitterText: '削除' }), POLICY)).toBe(false);
    // 分類を偽った入力（語は削除の語）でも押さない。
    const forged: DiscoveryCandidate = { ...boundButton({ submitterText: 'delete' }), classification: 'NEEDS_BINDING', reasonCode: 'JS_BOUND' };
    expect(isSubmissionProbeTarget(forged, POLICY)).toBe(false);
  });

  it('skips a candidate of an external Origin (the page or the action)', () => {
    expect(isSubmissionProbeTarget(boundButton({ page: { origin: OTHER_ORIGIN, path: '/page' } }), POLICY)).toBe(false);
    const forged: DiscoveryCandidate = {
      ...candidateOf(sampleForm, { jsBinding: { ...CLICK_BINDING, submitter: [], form: ['submit'] }, submitterText: '保存' }),
      action: { origin: OTHER_ORIGIN, path: '/x', queryNames: [] },
      classification: 'NEEDS_BINDING',
      reasonCode: 'JS_BOUND',
    };
    expect(isSubmissionProbeTarget(forged, POLICY)).toBe(false);
  });

  it('skips a candidate of the login screen', () => {
    expect(isSubmissionProbeTarget(boundButton({ page: { origin: SAMPLE_ORIGIN, path: `${LOGIN_PATH}/sign-in` } }), POLICY)).toBe(false);
  });

  it('orders the presses by the document order of the elements within the same rank', () => {
    const entries = [
      { id: 'd', path: [0, 1, 5], submitterWords: [], hasSubmitterText: false },
      { id: 'a', path: [0, 1, 0, 2], submitterWords: [], hasSubmitterText: false },
      { id: 'c', path: [0, 1, 3], submitterWords: [], hasSubmitterText: false },
      { id: 'b', path: [0, 1, 0, 7], submitterWords: [], hasSubmitterText: false },
      { id: 'e', path: [0, 2], submitterWords: [], hasSubmitterText: false },
    ];
    // DEF-142: 上限（1 画面 3 回）は押す部品が数える（見えない対象は数えない）。順の部品は、すべての対象を順に並べる。
    expect(submissionProbePressOrderOf(entries).map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(entries.map(({ id }) => id)).toEqual(['d', 'a', 'c', 'b', 'e']);
    expect(compareElementPaths([0, 1], [0, 1, 0])).toBeLessThan(0);
    expect(compareElementPaths([0, 2], [0, 1, 9])).toBeGreaterThan(0);
    expect(compareElementPaths([0, 2], [0, 2])).toBe(0);
  });
});

describe('DEF-142: the press order of the submission probe (the create and update buttons first)', () => {
  it('names the closed list of the create and update words from the classification words (no destructive word)', () => {
    expect(SUBMISSION_PROBE_PRIORITY_WORDS).toEqual([...DISCOVERY_UPDATE_WORDS, ...DISCOVERY_CREATE_WORDS]);
    expect(Object.isFrozen(SUBMISSION_PROBE_PRIORITY_WORDS)).toBe(true);
    for (const word of ['保存', '登録', '作成', '追加', '更新', 'save', 'create', 'add', 'update']) {
      expect(SUBMISSION_PROBE_PRIORITY_WORDS).toContain(word);
    }
    expect(SUBMISSION_PROBE_PRIORITY_WORDS.filter((word) => (DISCOVERY_DESTRUCTIVE_WORDS as readonly string[]).includes(word))).toEqual([]);
  });

  it('presses the buttons with a create or update word first, then the other buttons with text, then the buttons without text', () => {
    const entries = [
      { id: 'icon-1', path: [0, 1, 0], submitterWords: [], hasSubmitterText: false },
      { id: 'text-1', path: [0, 1, 1], submitterWords: [], hasSubmitterText: true },
      { id: 'icon-2', path: [0, 1, 2], submitterWords: [], hasSubmitterText: false },
      { id: 'search', path: [0, 1, 3], submitterWords: ['search'], hasSubmitterText: true },
      { id: 'save', path: [0, 1, 9], submitterWords: ['保存'], hasSubmitterText: true },
      { id: 'add', path: [0, 1, 4, 0], submitterWords: ['add'], hasSubmitterText: true },
      { id: 'icon-3', path: [0, 0, 9], submitterWords: [], hasSubmitterText: false },
    ];
    expect(submissionProbePressOrderOf(entries).map(({ id }) => id)).toEqual(['add', 'save', 'text-1', 'search', 'icon-3', 'icon-1', 'icon-2']);
  });

  // T44c（設計者の判断）: 「送信」「確定」「submit」の語の印（probe だけが読む `hasSubmitWord`）のあるボタンは、登録・更新の語の次の段。
  it('presses the buttons with a submit word after the create and update buttons and before the other buttons with text (T44c)', () => {
    const entries = [
      { id: 'icon', path: [0, 0], submitterWords: [], hasSubmitterText: false },
      { id: 'text', path: [0, 1], submitterWords: [], hasSubmitterText: true },
      { id: 'submit', path: [0, 2], submitterWords: [], hasSubmitterText: true, hasSubmitWord: true },
      { id: 'save', path: [0, 3], submitterWords: ['保存'], hasSubmitterText: true },
      { id: 'confirm', path: [0, 4], submitterWords: [], hasSubmitterText: true, hasSubmitWord: true },
      { id: 'save-submit', path: [0, 5], submitterWords: ['save'], hasSubmitterText: true, hasSubmitWord: true },
    ];
    expect(submissionProbePressOrderOf(entries).map(({ id }) => id)).toEqual(['save', 'save-submit', 'submit', 'confirm', 'text', 'icon']);
  });

  it('takes every create and update word as the first rank', () => {
    for (const word of SUBMISSION_PROBE_PRIORITY_WORDS) {
      const entries = [
        { id: 'icon', path: [0, 0], submitterWords: [], hasSubmitterText: false },
        { id: 'text', path: [0, 1], submitterWords: [], hasSubmitterText: true },
        { id: 'word', path: [0, 2], submitterWords: [word], hasSubmitterText: true },
      ];
      expect(submissionProbePressOrderOf(entries).map(({ id }) => id)).toEqual(['word', 'text', 'icon']);
    }
  });

  it('never orders a candidate with a destructive word (even with a create or update word)', () => {
    const entries = [
      { id: 'icon', path: [0, 0], submitterWords: [], hasSubmitterText: false },
      { id: 'save-and-delete', path: [0, 1], submitterWords: ['保存', '削除'], hasSubmitterText: true },
      { id: 'delete', path: [0, 2], submitterWords: ['delete'], hasSubmitterText: true },
      { id: 'save', path: [0, 3], submitterWords: ['save'], hasSubmitterText: true },
    ];
    expect(submissionProbePressOrderOf(entries).map(({ id }) => id)).toEqual(['save', 'icon']);
  });
});

describe('T37c: the fields and the synthetic markers (design 3.2 の入力)', () => {
  it('fills the text-like inputs and textarea, selects a select and never touches password, file, hidden, checkbox, radio', () => {
    expect(SUBMISSION_PROBE_FILL_FIELD_TYPES).toEqual(['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'textarea']);
    for (const type of SUBMISSION_PROBE_FILL_FIELD_TYPES) expect(submissionProbeFieldActionOf(type)).toBe('FILL');
    expect(submissionProbeFieldActionOf('select-one')).toBe('SELECT');
    expect(submissionProbeFieldActionOf('select-multiple')).toBe('SELECT');
    for (const type of ['password', 'file', 'hidden', 'checkbox', 'radio', 'range', 'color', 'month', 'week', 'time', 'datetime-local'] as const) {
      expect(submissionProbeFieldActionOf(type)).toBe('SKIP');
    }
  });

  it('makes a marker of the field type (email, url, digits, date, text)', () => {
    expect(submissionProbeMarkerOf('email', [])).toMatch(/^bsprobe[0-9a-f]{12}@example\.invalid$/u);
    expect(submissionProbeMarkerOf('url', [])).toMatch(/^https:\/\/example\.invalid\/bsprobe[0-9a-f]{12}$/u);
    expect(submissionProbeMarkerOf('number', [])).toMatch(/^[1-9][0-9]{8}$/u);
    expect(submissionProbeMarkerOf('tel', [])).toMatch(/^[1-9][0-9]{8}$/u);
    expect(submissionProbeMarkerOf('date', [])).toBe('2001-02-03');
    expect(submissionProbeMarkerOf('date', ['x'])).toBe('2002-02-03');
    for (const type of ['text', 'search', 'textarea'] as const) expect(submissionProbeMarkerOf(type, [])).toMatch(/^bsprobe[0-9a-f]{12}$/u);
  });

  it('makes a different marker for each field (no marker contains another) up to 32 markers', () => {
    const types: CandidateFieldType[] = ['text', 'email', 'url', 'number', 'tel', 'date', 'search', 'textarea'];
    const used: string[] = [];
    for (let index = 0; index < MAX_API_SHAPE_MARKERS; index += 1) used.push(submissionProbeMarkerOf(types[index % types.length] ?? 'text', used));
    expect(new Set(used).size).toBe(MAX_API_SHAPE_MARKERS);
    for (const [index, marker] of used.entries()) {
      expect(used.filter((other, otherIndex) => otherIndex !== index && (other.includes(marker) || marker.includes(other)))).toEqual([]);
    }
    expect(() => submissionProbeMarkerOf('text', used)).toThrow(RangeError);
  });

  it('draws again when the random draw overlaps a marker in use', () => {
    const draws = ['000000000001', '000000000001', '0000000000a2'];
    const randomHex = (): string => draws.shift() ?? 'ffffffffffff';
    const first = submissionProbeMarkerOf('text', [], randomHex);
    expect(submissionProbeMarkerOf('text', [first], randomHex)).toBe('bsprobe0000000000a2');
  });
});

describe('T37c: the probe record of a candidate (design 3.4)', () => {
  const fields = { filledFieldCount: 2, skippedFieldCount: 1 };

  it('maps the observation to the T37b classification, the shape and the digest (no value)', () => {
    const shape = createShape();
    const record = observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 2, unrecordedShapeCount: 0 }, fields);
    expect(record).toEqual({
      result: 'API_CREATE', reason: null, shape, shapeDigest: apiShapeDigestOf(shape),
      nonReadRequestCount: 1, readRequestCount: 2, unrecordedShapeCount: 0, filledFieldCount: 2, skippedFieldCount: 1,
      // T38a: 欄の範囲（渡さなければ空）。
      inputFields: [],
    });
    expect(JSON.stringify(record).includes('bsprobe0')).toBe(false);
  });

  it('is NO_REQUEST without a non-read request and NOT_EXECUTABLE with the reason of the table', () => {
    expect(observedSubmissionProbeOf({ shapes: [], nonReadRequestCount: 0, readRequestCount: 1, unrecordedShapeCount: 0 }, fields))
      .toMatchObject({ result: 'NO_REQUEST', reason: null, shape: null, shapeDigest: null, readRequestCount: 1 });
    const shape = createShape();
    expect(observedSubmissionProbeOf({ shapes: [shape, shape], nonReadRequestCount: 2, readRequestCount: 0, unrecordedShapeCount: 0 }, fields))
      .toMatchObject({ result: 'NOT_EXECUTABLE', reason: 'MULTIPLE_REQUESTS', shapeDigest: apiShapeDigestOf(shape) });
  });

  it('is NOT_OBSERVED with the reason and no shape', () => {
    expect(notObservedSubmissionProbeOf('PAGE_CHANGED')).toEqual({
      result: 'NOT_OBSERVED', reason: 'PAGE_CHANGED', shape: null, shapeDigest: null,
      nonReadRequestCount: 0, readRequestCount: 0, unrecordedShapeCount: 0, filledFieldCount: 0, skippedFieldCount: 0,
      inputFields: [],
    });
    expect(notObservedSubmissionProbeOf('PRESS_FAILED', fields)).toMatchObject({ filledFieldCount: 2, skippedFieldCount: 1 });
  });

  it('adds the probes to the candidates of a screen without changing the identity and the rule digests', () => {
    const button = boundButton();
    const other = candidateOf(sampleButton);
    const record = { location: button.page, incompleteReasons: [], candidates: [button, other] };
    const probe = notObservedSubmissionProbeOf('PAGE_CHANGED');
    const probed = withSubmissionProbes(record, new Map([[0, probe]]));
    expect(probed.candidates[0]).toEqual({ ...button, submissionProbe: probe });
    expect(probed.candidates[0]?.identityDigest).toBe(button.identityDigest);
    expect(probed.candidates[0]?.ruleDigest).toBe(button.ruleDigest);
    expect(probed.candidates[1]).toEqual(other);
    expect('submissionProbe' in (probed.candidates[1] ?? {})).toBe(false);
    expect(withSubmissionProbes(record, new Map())).toBe(record);
  });
});

describe('T38a: the fields of the probe, the markers of each press and the keys of the body (Task 38 design 3.1)', () => {
  const fields = { filledFieldCount: 3, skippedFieldCount: 1 };
  const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid', '123456789'] as const;
  const INPUT_FIELDS = [
    { name: 'name', selector: '#name', type: 'text', marker: 0 },
    { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
    { name: null, selector: 'input[type="number"]', type: 'number', marker: 2 },
    { name: 'kind', selector: null, type: 'select-one', marker: null },
  ] as const;
  const shapeOf = (markers: readonly string[], body: Record<string, unknown>): ApiRequestShape => apiRequestShapeOf({
    method: 'POST',
    resourceType: 'fetch',
    url: `${API}/rest/v1/members`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json' },
    body: { kind: 'TEXT', text: JSON.stringify(body) },
  }, { pagePath: '/admin/members/new', markers });

  it('records the fields of each marker (the name, the unique CSS and the type; no value) and the selected fields', () => {
    const shape = shapeOf(MARKERS, { name: MARKERS[0], email: MARKERS[1], age: Number(MARKERS[2]), kind: 'a' });
    const record = observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 }, fields, INPUT_FIELDS);
    expect(record.inputFields).toEqual(INPUT_FIELDS);
    for (const marker of MARKERS) {
      expect(JSON.stringify(record).includes(marker)).toBe(false);
    }
    expect(notObservedSubmissionProbeOf('PAGE_CHANGED', fields, INPUT_FIELDS).inputFields).toEqual(INPUT_FIELDS);
  });

  it('builds the fields of the keys of the body from the probe (a key with one marker has its field; the others have none)', () => {
    const shape = shapeOf(MARKERS, { name: MARKERS[0], email: MARKERS[1], age: Number(MARKERS[2]), both: `${MARKERS[0]} ${MARKERS[2]}`, tenant: 't' });
    const record = observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 }, fields, INPUT_FIELDS);
    expect(submissionProbeKeyFieldsOf(record)).toEqual([
      { key: 'age', type: 'number', field: INPUT_FIELDS[2] },
      { key: 'both', type: 'string', field: null },
      { key: 'email', type: 'string', field: INPUT_FIELDS[1] },
      { key: 'name', type: 'string', field: INPUT_FIELDS[0] },
      { key: 'tenant', type: 'string', field: null },
    ]);
    // 型のない結果と、T38a の前の結果（欄の範囲がない）は、組み立てない。
    expect(submissionProbeKeyFieldsOf(notObservedSubmissionProbeOf('PAGE_CHANGED'))).toEqual([]);
    const { inputFields: _omitted, ...before } = record;
    expect(submissionProbeKeyFieldsOf(before)).toEqual([]);
  });

  it('keeps the digest of a press independent of the earlier presses (the numbers start from 0 for each press)', () => {
    const first = ['bsprobe00000000000a', 'bsprobe00000000000b'];
    const second = ['bsprobe00000000000c', 'bsprobe00000000000d'];
    const firstShape = shapeOf(first, { name: first[0], note: first[1] });
    const secondShape = shapeOf(second, { name: second[0], note: second[1] });
    expect(apiShapeDigestOf(secondShape)).toBe(apiShapeDigestOf(firstShape));
    // 番号を足していく形（前の押下の目印を前に並べる）では、2 回目の digest が変わる（T38a の前の問題）。
    const cumulative = shapeOf([...first, ...second], { name: second[0], note: second[1] });
    expect(apiShapeDigestOf(cumulative)).not.toBe(apiShapeDigestOf(firstShape));
  });

  it('makes new marker values for each press: avoids the markers of the earlier presses, and counts the limit for the press', () => {
    const draws = ['000000000001', '000000000001', '0000000000a2'];
    const randomHex = (): string => draws.shift() ?? 'ffffffffffff';
    const earlier = [submissionProbeMarkerOf('text', [], randomHex)];
    // 今の押下の目印は空でも、前の押下の目印と同じ値・重なる値は使わない。
    expect(submissionProbeMarkerOf('text', [], randomHex, earlier)).toBe('bsprobe0000000000a2');
    // date は、前の押下の目印も数えて年を進める（同じ値を使わない）。
    expect(submissionProbeMarkerOf('date', [], undefined, ['2001-02-03'])).toBe('2002-02-03');
    // 上限は 1 回の押下の目印の数（前の押下の目印は数えない）。
    const many = Array.from({ length: MAX_API_SHAPE_MARKERS }, (_value, index) => `bsprobeearlier${String(index)}x`);
    expect(submissionProbeMarkerOf('text', [], undefined, many)).toMatch(/^bsprobe[0-9a-f]{12}$/u);
  });
});
