// T40R-fix-B（Task 40 の設計書 7 章の「T40R」の行の I-2 (a)・(b)）: API のシナリオの保存の確かめ。
// - (a) `{id}` の照合の READ は、生成した値と比べる期待（`TEXT_CONTAINS`・`DETAIL_FIELD_EQUALS`）を 1 つ以上求める（行の数だけの READ は、ID を取り違えて
//   も一致しうるので、API の登録の照合に使えない）。判定は `read-check-contracts.ts` の `hasGeneratedValueExpectation` の 1 か所（IPC も同じ部品）。
//   候補の READ（結び付けで生成した値を送る）と FORM のシナリオは今のまま。理由は `SCENARIO_API_READ_VERIFICATION_NOT_BOUND`。
// - (b) 画面から ID を取る形（検証の指定の `recordId` の `URL_PATH_PATTERN`）で、書き込みの画面の path がその型に当たる（`new` を ID として取りうる）なら
//   拒む。当たるかは、ワーカーが ID を取る部品と同じ判定（`fingerprint.ts` の `recordIdOfPathPattern`）。応答の本文から取る形と要素から取る形は対象の外。
//   FORM のシナリオは今のまま。理由は `SCENARIO_API_RECORD_ID_PATTERN_MATCHES_FORM_PAGE`。
import { describe, expect, it } from 'vitest';
import { SCENARIO_DRAFT_REJECTION_REASONS, validateScenarioDraft, type ScenarioDraftValidationResult } from '../../src/control/approval/scenario-policy.js';
import { apiRequestShapeOf } from '../../src/core/api-request-shape.js';
import type { DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { recordIdOfPathPattern, recordIdPatternMatchesPagePath } from '../../src/core/record-id-path-pattern.js';
import { GENERATED_VALUE_EXPECTATION_KINDS, hasGeneratedValueExpectation } from '../../src/discovery/read-check-contracts.js';
import { observedSubmissionProbeOf, type SubmissionProbeInputField } from '../../src/discovery/submission-probe-contracts.js';
import { LOCAL_UI_WRITE_TEXT, SCENARIO_DRAFT_REJECTION_DESCRIPTIONS } from '../../src/presentation/messages.js';
import { ALL_CONFIRMED, CREATE_CANDIDATE as FORM_CANDIDATE, FULL_VERIFICATION, PROFILE_ID, READ_CHECK_FACTS, candidateOf, sampleDraft } from './approval-samples.js';
import { NO_JS_BINDING, SAMPLE_ORIGIN, sampleButton } from './discovery-candidate-samples.js';

const API = 'http://127.0.0.2:4174';
const MARKERS = ['bsprobe00000000000a', 'bsprobe00000000000b@example.invalid'];
const NEW_PATH = '/admin/members/new';

const INPUT_FIELDS: readonly SubmissionProbeInputField[] = [
  { name: 'name', selector: '#name', type: 'text', marker: 0 },
  { name: 'email', selector: '#member-email', type: 'email', marker: 1 },
];

const CANDIDATE: DiscoveryCandidate = {
  ...candidateOf(sampleButton({ page: { origin: SAMPLE_ORIGIN, path: NEW_PATH }, submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'] } })),
  submissionProbe: observedSubmissionProbeOf({
    shapes: [apiRequestShapeOf({
      method: 'POST',
      resourceType: 'fetch',
      url: `${API}/rest/v1/members?select=*`,
      origin: { kind: 'APPROVED_API', index: 0 },
      headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: { kind: 'TEXT', text: JSON.stringify({ name: MARKERS[0], email: MARKERS[1] }) },
    }, { pagePath: NEW_PATH, markers: MARKERS })],
    nonReadRequestCount: 1, readRequestCount: 0, unrecordedShapeCount: 0,
  }, { filledFieldCount: 2, skippedFieldCount: 0 }, INPUT_FIELDS),
};

const READ_FACTS = [
  { readCheckId: 'rc-page', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE', pageTemplate: true },
  { readCheckId: 'rc-search', profileId: PROFILE_ID, revision: 1, canceledAt: null, parameterNames: ['q'], targetKind: 'CANDIDATE' },
] as const;

const CONTEXT = { scenarioId: null, scenarios: [], approvedServiceOrigins: [API], profileRevisions: { discoveryJob: 2, current: 2 } };

type Expectations = readonly Record<string, unknown>[];
const TEXT_OF_EMAIL = { kind: 'TEXT_CONTAINS', fieldName: 'email' };
const DETAIL_OF_NAME = { kind: 'DETAIL_FIELD_EQUALS', field: '名前', fieldName: 'name' };
const ONE_ROW = { kind: 'ROW_COUNT_EQUALS', count: 1 };

/** API の登録の下書き（照合の READ、検証の指定の ID の取り方、API の ID の取り方は引数）。 */
const apiDraftOf = (
  read: { readonly readCheckId: string; readonly bindings: readonly Record<string, string>[]; readonly expectations: Expectations },
  recordId: Record<string, unknown> | null = null,
  apiRecordId: Record<string, unknown> | null = { source: 'RESPONSE_BODY_KEY', key: 'id' },
): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  candidateIdentityDigest: CANDIDATE.identityDigest,
  transport: 'API',
  fieldNames: ['name', 'email'],
  readChecks: [],
  sideEffectConfirmations: ALL_CONFIRMED,
  limits: { maxCreatesPerRun: 1, maxCumulativeCreates: 20 },
  approvalTtlDays: 30,
  verification: { successCondition: null, inputErrorCondition: null, recordId, readVerification: { ...read, revision: 1 } },
  api: { shapeDigest: CANDIDATE.submissionProbe?.shapeDigest, pageKeys: [], filterName: null, recordId: apiRecordId, ledger: null },
});

const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));
const validateApi = (draft: Record<string, unknown>): ScenarioDraftValidationResult => validateScenarioDraft(draft, CANDIDATE, READ_FACTS, CONTEXT);
const templateRead = (expectations: Expectations) => ({ readCheckId: 'rc-page', bindings: [], expectations });

describe('T40R-fix-B: the shared parts of the save checks', () => {
  it('lists the expectations compared with a generated value, and tells whether a READ has one', () => {
    expect(GENERATED_VALUE_EXPECTATION_KINDS).toEqual(['TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS']);
    expect(Object.isFrozen(GENERATED_VALUE_EXPECTATION_KINDS)).toBe(true);
    expect(hasGeneratedValueExpectation([ONE_ROW])).toBe(false);
    expect(hasGeneratedValueExpectation([])).toBe(false);
    expect(hasGeneratedValueExpectation([{ kind: 'ROW_COUNT_AT_LEAST' }])).toBe(false);
    expect(hasGeneratedValueExpectation([ONE_ROW, TEXT_OF_EMAIL])).toBe(true);
    expect(hasGeneratedValueExpectation([{ kind: 'DETAIL_FIELD_EQUALS' }])).toBe(true);
  });

  it.each<readonly [string, string, string, string | null]>([
    ['the new page against an id pattern of the same depth', '/admin/members/new', '/admin/members/{id}', 'new'],
    ['a record page', '/admin/members/42', '/admin/members/{id}', '42'],
    ['another depth', '/admin/members/new', '/admin/members/{id}/edit', null],
    ['another fixed segment', '/admin/users/new', '/admin/members/{id}', null],
    ['an id in the middle', '/admin/members/7/edit', '/admin/members/{id}/edit', '7'],
    ['an empty id segment', '/admin/members/', '/admin/members/{id}', ''],
  ])('takes the record id from %s as the worker does', (_label, pathname, pattern, recordId) => {
    expect(recordIdOfPathPattern(pathname, pattern)).toBe(recordId);
  });
});

describe('T40R-fix-B (a): the page path template READ of an API scenario needs an expectation compared with a generated value', () => {
  it('adds the reason at the end of the closed list, with its description', () => {
    // T40R2-fix: ID の型の理由は注意に下げたので、一覧の最後は (a) の理由だけ。T41a: その後ろに 2 つを足した（`scenario-api-update-contract.test.ts`）。
    expect(SCENARIO_DRAFT_REJECTION_REASONS.slice(-3, -2)).toEqual(['SCENARIO_API_READ_VERIFICATION_NOT_BOUND']);
    expect(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS.SCENARIO_API_READ_VERIFICATION_NOT_BOUND.description.length).toBeGreaterThan(0);
  });

  it.each<readonly [string, Expectations, readonly string[]]>([
    ['a row count only', [ONE_ROW], ['SCENARIO_API_READ_VERIFICATION_NOT_BOUND']],
    ['a text of a generated value', [TEXT_OF_EMAIL], []],
    ['a row count and a detail of a generated value', [ONE_ROW, DETAIL_OF_NAME], []],
  ])('judges a template READ with %s', (_label, expectations, codes) => {
    expect(codesOf(validateApi(apiDraftOf(templateRead(expectations))))).toEqual(codes);
  });

  it('keeps a READ candidate bound to a generated value with a row count only, and the FORM scenario as it is', () => {
    expect(codesOf(validateApi(apiDraftOf({ readCheckId: 'rc-search', bindings: [{ parameterName: 'q', fieldName: 'name' }], expectations: [ONE_ROW] }))))
      .toEqual([]);
    expect(codesOf(validateScenarioDraft(sampleDraft({ verification: { ...FULL_VERIFICATION, readVerification: {
      ...FULL_VERIFICATION.readVerification, expectations: [ONE_ROW] } } }), FORM_CANDIDATE, READ_CHECK_FACTS, CONTEXT))).toEqual([]);
  });
});

// T40R2-fix（Task 40 の設計書 7 章の「T40R2」の行。使える度合い）: 書き込みの画面に当たる ID の型は、保存で拒まない（正当な REST の組を拒むだけで、
// 取り違えはワーカーの押す前の値との比べと、毎回変わる値の照合で防ぐ）。保存の画面と詳細の画面に注意を出す（判定は core の
// `recordIdPatternMatchesPagePath`。`recordIdOfPathPattern` をそのまま使う）。理由のコードは閉じた一覧から外した（拒む理由ではないため）。
describe('T40R2-fix: the record id pattern the page of the write matches is saved, with a caution', () => {
  it.each<readonly [string, Record<string, unknown> | null, boolean]>([
    ['a pattern the page of the write matches (new as the id)', { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' }, true],
    ['a pattern of another depth', { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}/edit' }, false],
    ['an element', { source: 'ELEMENT', selector: '#member-id' }, false],
    ['no record id of the verification spec (the response body key)', null, false],
  ])('saves %s, and tells whether to show the caution', (_label, recordId, caution) => {
    expect(codesOf(validateApi(apiDraftOf(templateRead([TEXT_OF_EMAIL]), recordId)))).toEqual([]);
    expect(recordIdPatternMatchesPagePath(recordId as Parameters<typeof recordIdPatternMatchesPagePath>[0], NEW_PATH)).toBe(caution);
  });

  it('also saves the pattern when the API takes no record id from the response body, and no longer lists the reason', () => {
    expect(codesOf(validateApi(apiDraftOf(templateRead([TEXT_OF_EMAIL]), { source: 'URL_PATH_PATTERN', pathPattern: '/admin/members/{id}' }, null))))
      .toEqual([]);
    expect(SCENARIO_DRAFT_REJECTION_REASONS as readonly string[]).not.toContain('SCENARIO_API_RECORD_ID_PATTERN_MATCHES_FORM_PAGE');
    expect(Object.keys(SCENARIO_DRAFT_REJECTION_DESCRIPTIONS)).not.toContain('SCENARIO_API_RECORD_ID_PATTERN_MATCHES_FORM_PAGE');
    expect(LOCAL_UI_WRITE_TEXT.recordIdPatternCaution.length).toBeGreaterThan(0);
  });

  it('keeps the FORM scenario as it is (out of this check; the form page /members/new against /members/{id})', () => {
    expect(FORM_CANDIDATE.page.path).toBe('/members/new');
    expect(FULL_VERIFICATION.recordId).toEqual({ source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' });
    expect(codesOf(validateScenarioDraft(sampleDraft({ verification: FULL_VERIFICATION }), FORM_CANDIDATE, READ_CHECK_FACTS, CONTEXT))).toEqual([]);
  });
});
