// T37c（Task 37 の設計書 3.2・3.4）: 送らずに観察する probe の純粋な部品（`src/discovery/submission-probe-contracts.ts`）。
// - 対象の選び方: 分類が `NEEDS_BINDING`、削除の語でない、外部 Origin でない、ログインの画面でない。押す順は文書の順（要素の位置）で、1 画面 3 回まで。
//   DEF-142: 押す順は、登録・更新の語のあるもの、文字のあるそのほか、文字のないものの順（同じ順の中は文書の順。削除の語の候補は並べない）。
// - 目印の作り方: 型ごと（email・url・数字・日付・text 系）、欄ごとに違う（ほかの目印を含まず、含まれない）、32 まで。
// - 結果の組み立て: 観察の結果を T37b の分類（`classifyApiShapeObservation`）で結果に写す。観察しなかった理由。候補への付け方（識別の digest を変えない）。
import { describe, expect, it } from 'vitest';
import { apiRequestShapeOf, type ApiRequestShape } from '../../src/core/api-request-shape.js';
import { API_SHAPE_NOT_EXECUTABLE_REASONS, apiShapeDigestOf } from '../../src/discovery/api-shape-classification.js';
import type { CandidateFieldType, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  DISCOVERY_CREATE_WORDS,
  DISCOVERY_DESTRUCTIVE_WORDS,
  DISCOVERY_OPENER_WORDS,
  DISCOVERY_ROW_ADD_WORDS,
  DISCOVERY_SUBMITTER_WORDS,
  DISCOVERY_UPDATE_WORDS,
} from '../../src/discovery/classification-words.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import {
  OPENER_SIDE_REQUEST_PROBE_REASON,
  SUBMISSION_PROBE_FILL_FIELD_TYPES,
  SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS,
  SUBMISSION_PROBE_NOT_OBSERVED_REASONS,
  SUBMISSION_PROBE_PRIORITY_WORDS,
  SUBMISSION_PROBE_QUIET_WAIT_MS,
  SUBMISSION_PROBE_REASONS,
  SUBMISSION_PROBE_RESULTS,
  SAME_IDENTITY_PRESSED_PROBE_REASON,
  SUBMISSION_PROBE_NOT_PRESSED_REASONS,
  submissionProbeWordsKeyOf,
  sharedLayoutIdentityDigestOf,
  compareElementPaths,
  isOpenerOnlySubmitter,
  isSubmissionProbeTarget,
  notObservedSubmissionProbeOf,
  observedSubmissionProbeOf,
  submissionProbeFieldActionOf,
  submissionProbeKeyFieldsOf,
  submissionProbeMarkerOf,
  submissionProbeOpenerOf,
  submissionProbePressOrderOf,
  SUBMISSION_PROBE_CONFIRM_WORDS,
  inputCheckSiblingsOf,
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
      // LU-4（設計書 `2026-11-02-beaksight-list-row-update-design.md` の D7）: 同じ識別の候補を先に 1 つ押すので押さなかった `SAME_IDENTITY_PRESSED`。
      .toEqual(['PAGE_CHANGED', 'PRESS_LIMIT_REACHED', 'TARGET_NOT_FOUND', 'PRESS_FAILED', 'CONTEXT_CLOSED_BY_GUARD', 'SAME_IDENTITY_PRESSED',
        'SAME_WORDS_NO_REQUEST', 'DISABLED_SUBMITTER', 'SHARED_LAYOUT_PRESSED', 'DISABLED_FILL_LIMIT_REACHED', 'SAME_STATE_PRESSED',
        // L6/L3-1: 1 画面の進みの見張り（L0）が画面を終えたので押せなかった（L0 の理由と同じ名前）。
        'STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET',
        // L6/L3-1 の続き（A1）: 覆われていたので押さなかった。
        'COVERED_BY_OTHER',
        // SD-1: 削除に関する操作なので押さなかった。
        'DESTRUCTIVE_ACTION_SKIPPED',
        // DEF-289: 押す途中で的が消え続けた・押す輪を終えるまで押しにかからなかった。
        'TARGET_VANISHED', 'NOT_REACHED',
        // DEF-295: 押す前の準備の確かめで止まらない・見えない、状態を作り直せなかった。
        'TARGET_NOT_STABLE', 'TARGET_NOT_VISIBLE', 'STATE_NOT_REBUILT',
        // AIW: AI の操作なので押さなかった。
        'AI_ACTION_SKIPPED',
        // CALDAY: 同じ形の兄弟の代表で済んだ。
        'SAME_SHAPE_NO_CHANGE']);
    // COV-2: ほかの画面の同じ構造の鍵の状態で、同じ候補を押した（押していない理由）。
    expect(SUBMISSION_PROBE_NOT_PRESSED_REASONS).toContain('SAME_STATE_PRESSED');
    // DEF-144: 実行できない理由に、probe だけの `EXTERNAL_SCHEME` を足す。DEF-186: 開き手の側の要求 `OPENER_SIDE_REQUEST` も足す。
    // AIW の 4: 押下で AI の送信が出た `AI_GENERATION_REQUEST` も足す。
    expect(SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS).toEqual([...API_SHAPE_NOT_EXECUTABLE_REASONS, 'EXTERNAL_SCHEME', 'OPENER_SIDE_REQUEST', 'AI_GENERATION_REQUEST']);
    expect(SUBMISSION_PROBE_REASONS).toEqual([...SUBMISSION_PROBE_NOT_EXECUTABLE_REASONS, ...SUBMISSION_PROBE_NOT_OBSERVED_REASONS]);
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
    // DEF-208-2: 確定の語（保存）を、行を足す語（add）より先に押す（前は文書の順で add が先だった）。
    expect(submissionProbePressOrderOf(entries).map(({ id }) => id)).toEqual(['save', 'add', 'text-1', 'search', 'icon-3', 'icon-1', 'icon-2']);
  });

  it('DEF-208-2: takes the row add words as a subset of the create words, and builds the confirm words without them and the opener words', () => {
    expect([...DISCOVERY_ROW_ADD_WORDS]).toEqual(['add', 'new', 'create', '追加', '新規', '作成']);
    expect(Object.isFrozen(DISCOVERY_ROW_ADD_WORDS)).toBe(true);
    for (const word of DISCOVERY_ROW_ADD_WORDS) {
      expect(DISCOVERY_CREATE_WORDS as readonly string[]).toContain(word);
    }
    expect(SUBMISSION_PROBE_CONFIRM_WORDS).toEqual(SUBMISSION_PROBE_PRIORITY_WORDS.filter((word) =>
      !(DISCOVERY_ROW_ADD_WORDS as readonly string[]).includes(word) && !(DISCOVERY_OPENER_WORDS as readonly string[]).includes(word)));
    for (const word of ['保存', '登録', '更新', '変更', 'save', 'update', 'register']) {
      expect(SUBMISSION_PROBE_CONFIRM_WORDS).toContain(word);
    }
    for (const word of ['追加', '新規', '作成', '編集', '修正', 'add', 'new', 'create', 'edit']) {
      expect(SUBMISSION_PROBE_CONFIRM_WORDS).not.toContain(word);
    }
  });

  it('DEF-208-2: presses the confirm words, then the submit words, then the row add and opener words', () => {
    const entries = [
      { id: 'add', path: [0, 0], submitterWords: ['追加'], hasSubmitterText: true },
      { id: 'new', path: [0, 1], submitterWords: ['作成', '新規'], hasSubmitterText: true },
      { id: 'edit', path: [0, 2], submitterWords: ['編集'], hasSubmitterText: true },
      { id: 'submit', path: [0, 3], submitterWords: [], hasSubmitterText: true, hasSubmitWord: true },
      { id: 'text', path: [0, 4], submitterWords: [], hasSubmitterText: true },
      { id: 'register', path: [0, 5], submitterWords: ['登録'], hasSubmitterText: true },
      { id: 'add-and-save', path: [0, 6], submitterWords: ['保存', '追加'], hasSubmitterText: true },
      { id: 'save', path: [0, 7], submitterWords: ['保存'], hasSubmitterText: true },
    ];
    expect(submissionProbePressOrderOf(entries).map(({ id }) => id)).toEqual(['register', 'add-and-save', 'save', 'submit', 'add', 'new', 'edit', 'text']);
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

  // L13（N25）: 1 回の押下の目印の数に上限を置かない（前は 32 個目の後で RangeError）。
  it('makes a different marker for each field (no marker contains another) without a limit on the count', () => {
    const types: CandidateFieldType[] = ['text', 'email', 'url', 'number', 'tel', 'date', 'search', 'textarea'];
    const used: string[] = [];
    for (let index = 0; index < 40; index += 1) used.push(submissionProbeMarkerOf(types[index % types.length] ?? 'text', used));
    expect(new Set(used).size).toBe(40);
    for (const [index, marker] of used.entries()) {
      expect(used.filter((other, otherIndex) => otherIndex !== index && (other.includes(marker) || marker.includes(other)))).toEqual([]);
    }
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

  // ARR-1（設計書 `2026-11-08-beaksight-api-array-keys-design.md` 3.3 の 1）: 目印が一覧の中に入った欄は、その一覧の鍵（型 array）に対応づく。
  it('maps a field whose marker is in an array to the array key (ARR-1)', () => {
    const shape = shapeOf(MARKERS, { name: MARKERS[0], labels: [MARKERS[1]], makers: [], holders: ['u-1'], pair: [MARKERS[0], MARKERS[2]] });
    const record = observedSubmissionProbeOf({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 }, fields, INPUT_FIELDS);
    expect(submissionProbeKeyFieldsOf(record)).toEqual([
      { key: 'holders', type: 'array', field: null },
      { key: 'labels', type: 'array', field: INPUT_FIELDS[1] },
      { key: 'makers', type: 'array', field: null },
      { key: 'name', type: 'string', field: INPUT_FIELDS[0] },
      // ARR-4（`arr-4-array-fields.test.ts`）: 欄の印が 2 つ入る一覧は、印の位置ごとの欄の鍵（道 `key[i]`）に分ける（前は欄のない 1 つの鍵）。同じ欄が
      // `name` にも入る形は、承認が「欄を共有する」で拒む。
      { key: 'pair[0]', type: 'array', field: INPUT_FIELDS[0], element: { key: 'pair', index: 0 } },
      { key: 'pair[1]', type: 'array', field: INPUT_FIELDS[2], element: { key: 'pair', index: 1 } },
    ]);
  });

  it('does not map a marker key whose mark of an array does not agree with the type of the key (ARR-1)', () => {
    const shape = shapeOf(MARKERS, { name: MARKERS[0], labels: [MARKERS[1]] });
    const swapped: ApiRequestShape = {
      ...shape,
      body: {
        ...shape.body,
        markerKeys: shape.body.markerKeys.map(({ key, markers, inArray }) => (inArray === true ? { key, markers } : { key, markers, inArray: true as const })),
      },
    };
    const record = observedSubmissionProbeOf({ shapes: [swapped], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 }, fields, INPUT_FIELDS);
    expect(submissionProbeKeyFieldsOf(record)).toEqual([
      { key: 'labels', type: 'array', field: null },
      { key: 'name', type: 'string', field: null },
    ]);
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
  });
});

// DEF-186（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D6、K2、5.1 の 4）: 一覧の行の「編集」を押すと窓が開き、サイトが自動で下書きを
// POST する形。開き手の語だけの候補が `API_CREATE` を出したら、登録にせず `NOT_EXECUTABLE`・`OPENER_SIDE_REQUEST`（型は残す）。
describe('DEF-186: the request of the opener side (the site posts a draft when a row editor opens)', () => {
  const fields = { filledFieldCount: 0, skippedFieldCount: 0 };
  const observed = (shape: ApiRequestShape) => ({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 });
  const updateShape = (): ApiRequestShape => apiRequestShapeOf({
    method: 'PATCH',
    resourceType: 'fetch',
    url: `${API}/rest/v1/members?id=eq.1`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json' },
    body: { kind: 'TEXT', text: JSON.stringify({ name: 'bsprobe0' }) },
  }, { pagePath: '/admin/members/1/edit', markers: ['bsprobe0'] });

  it('names the opener words in one closed list of the comparison form, each also an update word (K2)', () => {
    expect([...DISCOVERY_OPENER_WORDS]).toEqual(['編集', '修正', 'edit']);
    expect(Object.isFrozen(DISCOVERY_OPENER_WORDS)).toBe(true);
    for (const word of DISCOVERY_OPENER_WORDS) {
      expect(word.normalize('NFKC').toUpperCase().toLowerCase(), word).toBe(word);
      // 候補の `submitterWords` に載る語（送信ボタンの語の閉じた一覧の、更新の語）。
      expect((DISCOVERY_UPDATE_WORDS as readonly string[]).includes(word), word).toBe(true);
      expect((DISCOVERY_SUBMITTER_WORDS as readonly string[]).includes(word), word).toBe(true);
    }
    expect(OPENER_SIDE_REQUEST_PROBE_REASON).toBe('OPENER_SIDE_REQUEST');
  });

  it('tells an opener only by an opener word without a create word (or a destructive word)', () => {
    expect(isOpenerOnlySubmitter(['編集'])).toBe(true);
    expect(isOpenerOnlySubmitter(['edit'])).toBe(true);
    expect(isOpenerOnlySubmitter(['修正'])).toBe(true);
    expect(isOpenerOnlySubmitter(['編集', '登録'])).toBe(false);
    expect(isOpenerOnlySubmitter(['編集', '削除'])).toBe(false);
    expect(isOpenerOnlySubmitter(['保存'])).toBe(false);
    expect(isOpenerOnlySubmitter([])).toBe(false);
  });

  it('records NOT_EXECUTABLE with OPENER_SIDE_REQUEST for an opener only button whose press made API_CREATE (the shape stays)', () => {
    const shape = createShape();
    for (const words of [['編集'], ['edit'], ['修正']]) {
      const record = observedSubmissionProbeOf(observed(shape), fields, [], words);
      expect(record).toMatchObject({
        result: 'NOT_EXECUTABLE', reason: 'OPENER_SIDE_REQUEST', shape, shapeDigest: apiShapeDigestOf(shape), nonReadRequestCount: 1,
      });
    }
  });

  it('keeps API_CREATE with a create word, without an opener word, or without the words; keeps API_UPDATE of an opener', () => {
    const shape = createShape();
    expect(observedSubmissionProbeOf(observed(shape), fields, [], ['編集', '登録'])).toMatchObject({ result: 'API_CREATE', reason: null });
    expect(observedSubmissionProbeOf(observed(shape), fields, [], ['保存'])).toMatchObject({ result: 'API_CREATE', reason: null });
    expect(observedSubmissionProbeOf(observed(shape), fields)).toMatchObject({ result: 'API_CREATE', reason: null });
    expect(observedSubmissionProbeOf(observed(updateShape()), fields, [], ['編集'])).toMatchObject({ result: 'API_UPDATE', reason: null });
  });
});

// LU-4（設計書 `2026-11-02-beaksight-list-row-update-design.md` 4.0 の D7、5.1 の 1・2、5.2 の 3）: 同じ識別の候補は 1 つだけ押し、残りは
// `SAME_IDENTITY_PRESSED`。開き手を押した後に窓の中の保存を押した記録には、開き手の識別・名前があるか・開き手の語（`opener`。値は持たない）を残し、
// その記録の分類には `openedFromRow` を渡す（filter の値が番号の形の PATCH は `API_UPDATE`）。
describe('LU-4: the same identity is pressed once, and the opener of a row editor is recorded', () => {
  const fields = { filledFieldCount: 1, skippedFieldCount: 0 };
  const DIGEST = `sha256:${'a'.repeat(64)}`;
  const rowUpdateShape = (): ApiRequestShape => apiRequestShapeOf({
    method: 'PATCH',
    resourceType: 'fetch',
    url: `${API}/api/items?id=eq.2`,
    origin: { kind: 'APPROVED_API', index: 0 },
    headers: { 'content-type': 'application/json' },
    body: { kind: 'TEXT', text: JSON.stringify({ name: 'bsprobe0' }) },
  }, { pagePath: '/items', markers: ['bsprobe0'] });
  const observed = (shape: ApiRequestShape) => ({ shapes: [shape], nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0 });

  it('names the reason of the same identity, a reason of not pressed', () => {
    expect(SAME_IDENTITY_PRESSED_PROBE_REASON).toBe('SAME_IDENTITY_PRESSED');
    expect(SUBMISSION_PROBE_NOT_PRESSED_REASONS)
      .toEqual(['TARGET_NOT_FOUND', 'PRESS_LIMIT_REACHED', 'EXTERNAL_SCHEME', 'CONTEXT_CLOSED_BY_GUARD', 'SAME_IDENTITY_PRESSED',
        'SAME_WORDS_NO_REQUEST', 'SAME_SHAPE_NO_CHANGE', 'DISABLED_SUBMITTER', 'SHARED_LAYOUT_PRESSED', 'SAME_STATE_PRESSED', 'COVERED_BY_OTHER', 'DESTRUCTIVE_ACTION_SKIPPED', 'AI_ACTION_SKIPPED',
        'TARGET_VANISHED', 'NOT_REACHED', 'TARGET_NOT_STABLE', 'TARGET_NOT_VISIBLE', 'STATE_NOT_REBUILT']);
    for (const reason of SUBMISSION_PROBE_NOT_PRESSED_REASONS) {
      expect((SUBMISSION_PROBE_REASONS as readonly string[]).includes(reason), reason).toBe(true);
    }
    expect((SUBMISSION_PROBE_REASONS as readonly string[]).includes('SAME_IDENTITY_PRESSED')).toBe(true);
    expect(notObservedSubmissionProbeOf('SAME_IDENTITY_PRESSED')).toMatchObject({ result: 'NOT_OBSERVED', reason: 'SAME_IDENTITY_PRESSED', shape: null });
  });

  it('builds the opener from the identity, whether it has a name and its opener words only (no other word, no value)', () => {
    expect(submissionProbeOpenerOf(DIGEST, true, ['編集'])).toEqual({ identityDigest: DIGEST, hasName: true, openerWords: ['編集'] });
    expect(submissionProbeOpenerOf(DIGEST, false, ['edit', '保存'])).toEqual({ identityDigest: DIGEST, hasName: false, openerWords: ['edit'] });
    expect(submissionProbeOpenerOf(DIGEST, true, ['新規'])).toEqual({ identityDigest: DIGEST, hasName: true, openerWords: [] });
    expect(Object.isFrozen(submissionProbeOpenerOf(DIGEST, true, ['編集']))).toBe(true);
  });

  it('copies the opener into the observed and the not observed records, and leaves it out without an opener', () => {
    const opener = submissionProbeOpenerOf(DIGEST, true, ['編集']);
    expect(observedSubmissionProbeOf(observed(rowUpdateShape()), fields, [], ['保存'], opener).opener).toEqual(opener);
    expect(notObservedSubmissionProbeOf('PAGE_CHANGED', fields, [], opener).opener).toEqual(opener);
    expect('opener' in observedSubmissionProbeOf(observed(rowUpdateShape()), fields, [], ['保存'])).toBe(false);
    expect('opener' in notObservedSubmissionProbeOf('PAGE_CHANGED')).toBe(false);
  });

  it('classifies the PATCH with a record id filter as API_UPDATE only with an opener (openedFromRow)', () => {
    const shape = rowUpdateShape();
    expect(observedSubmissionProbeOf(observed(shape), fields, [], ['保存'])).toMatchObject({ result: 'NOT_EXECUTABLE', reason: 'FILTER_NOT_PAGE_VALUE' });
    expect(observedSubmissionProbeOf(observed(shape), fields, [], ['保存'], submissionProbeOpenerOf(DIGEST, true, ['編集'])))
      .toMatchObject({ result: 'API_UPDATE', reason: null, shape });
  });
});

describe('DEF-208-2: the key of the same submitter words', () => {
  it('is the same for the same set of words in any order, and null without words', () => {
    expect(submissionProbeWordsKeyOf(['追加'])).toBe(submissionProbeWordsKeyOf(['追加', '追加']));
    expect(submissionProbeWordsKeyOf(['作成', '新規'])).toBe(submissionProbeWordsKeyOf(['新規', '作成']));
    expect(submissionProbeWordsKeyOf(['追加'])).not.toBe(submissionProbeWordsKeyOf(['保存']));
    expect(submissionProbeWordsKeyOf(['作成'])).not.toBe(submissionProbeWordsKeyOf(['作成', '新規']));
    expect(submissionProbeWordsKeyOf([])).toBeNull();
    // SREV-1105-3 の Minor-1: 範囲（form）が違えば、同じ語の組でも別の鍵。
    expect(submissionProbeWordsKeyOf(['保存'], '[0,1]')).not.toBe(submissionProbeWordsKeyOf(['保存'], '[0,2]'));
    expect(submissionProbeWordsKeyOf(['保存'], 'OUTSIDE_FORM')).toBe(submissionProbeWordsKeyOf(['保存'], 'OUTSIDE_FORM'));
    expect(submissionProbeWordsKeyOf([], '[0,1]')).toBeNull();
  });
});

describe('DEF-208-4: the identity of a shared layout button', () => {
  const facts = { kind: 'BUTTON', submitterWords: ['保存'], hasSubmitterText: true, landmarks: ['nav[]'] };
  it('is the same for the same words, kind, text and landmarks, and differs otherwise', () => {
    const digest = sharedLayoutIdentityDigestOf(facts);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(sharedLayoutIdentityDigestOf({ ...facts, submitterWords: ['保存', '保存'] })).toBe(digest);
    expect(sharedLayoutIdentityDigestOf({ ...facts, submitterWords: ['登録'] })).not.toBe(digest);
    expect(sharedLayoutIdentityDigestOf({ ...facts, kind: 'FORM' })).not.toBe(digest);
    expect(sharedLayoutIdentityDigestOf({ ...facts, hasSubmitterText: false })).not.toBe(digest);
    expect(sharedLayoutIdentityDigestOf({ ...facts, landmarks: ['aside[]'] })).not.toBe(digest);
  });

  it('is null for a button outside the layout landmarks (a body button)', () => {
    expect(sharedLayoutIdentityDigestOf({ ...facts, landmarks: [] })).toBeNull();
  });
});

// SLIM（設計書 `doc/design/2026-11-25-beaksight-discovery-input-check-slim-design.md` 2.1）: 番号だけ違う欄の組は、文書の順で最初の 1 つ（代表）を確かめ、
// 代表に違いが出なかったときだけ残りを確かめない。前に確かめた欄は押す輪の数え（`isFirst`）で省き、省いた兄弟も数えに入れる（後の画面で確かめ直さない）。
describe('SLIM: the input checks of a group of same-shaped fields', () => {
  const walk = (keys: readonly string[], quiet: (key: string) => boolean, earlier: ReadonlySet<number> = new Set()) => {
    const siblings = inputCheckSiblingsOf(keys);
    const asked: number[] = [];
    const checked = keys.flatMap((key, at) => {
      const decision = siblings.decide(key, () => {
        asked.push(at);
        return !earlier.has(at);
      });
      if (!decision.check) return [];
      siblings.settle(key, quiet(key));
      return [`${String(at)}:${decision.role}:${String(decision.siblings)}`];
    });
    return { checked, asked, counts: siblings.counts() };
  };

  it('checks only the representative of a quiet group, every member of a group that showed a difference, and a single field alone', () => {
    expect(walk(['a', 'b', 'a', 'b', 'c'], (key) => key === 'a')).toEqual({
      checked: ['0:REPRESENTATIVE:1', '1:REPRESENTATIVE:1', '3:SIBLING:1', '4:SINGLE:0'],
      asked: [0, 1, 2, 3, 4],
      counts: { checked: 4, skippedEarlier: 0, skippedSibling: 1 },
    });
  });

  it('lets the first field not checked earlier stand for the group', () => {
    expect(walk(['a', 'a', 'a'], () => true, new Set([0]))).toEqual({
      checked: ['1:REPRESENTATIVE:2'], asked: [0, 1, 2], counts: { checked: 1, skippedEarlier: 1, skippedSibling: 1 },
    });
  });
});
