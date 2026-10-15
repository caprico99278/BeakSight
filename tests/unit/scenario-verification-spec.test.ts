// T30a（Task 30 の設計書 2 章のユーザーの判断 4、3 章の「結果の判定」「登録の ID」「READ による照合」「検証の指定」、10 章の 5）: シナリオの
// 検証の指定（`scenario-contracts.ts` の `ScenarioVerification`）と、下書きの確かめ（`scenario-policy.ts` の `validateScenarioDraft`）の検証の指定の
// 確かめ、未指定の項目の判定（`missingVerificationItemsOf`）、検証の指定の前に保存した版の読み方（`storedScenarioRevisionOf`）。
// - 形（`SCENARIO_INPUT_INVALID` だけ）: 結果の条件の形、path の型の `{id}`（ちょうど 1 つ、区切りの全体）、ID の取り方の閉じた一覧、READ の参照、
//   結び付けの件数と重複、期待の種類（`ROW_COUNT_AT_LEAST` は使えない）と件数と値の範囲。
// - 中身: READ の定義が同じプロファイルの有効な今の版（Task 28 の照らす READ の定義と同じ理由）、結び付ける READ の送る値が定義にある
//   （`SCENARIO_VERIFICATION_PARAMETER_UNKNOWN`）、結び付けと期待の欄が送る欄にある（`SCENARIO_VERIFICATION_FIELD_NOT_SENT`）。
// - 下書きに検証の指定がなければ、すべて未指定（承認はできるが、実行の許可は出せない）。
import { describe, expect, it } from 'vitest';
import {
  MAX_RECORD_ID_PATH_PATTERN_LENGTH,
  MAX_RESULT_CONDITION_PATH_LENGTH,
  MAX_VERIFICATION_BINDINGS,
  MAX_VERIFICATION_EXPECTATIONS,
  MAX_VERIFICATION_ROW_COUNT,
  MAX_VERIFICATION_SELECTOR_LENGTH,
  MIN_VERIFICATION_ROW_COUNT,
  RECORD_ID_PLACEHOLDER,
  RECORD_ID_SOURCES,
  SCENARIO_VERIFICATION_ITEMS,
  UNSPECIFIED_VERIFICATION,
  VERIFICATION_EXPECTATION_KINDS,
  type ScenarioVerification,
} from '../../src/control/approval/scenario-contracts.js';
import {
  SCENARIO_DRAFT_REJECTION_REASONS,
  missingVerificationItemsOf,
  storedScenarioRevisionOf,
  validateScenarioDraft,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { MAX_AUTH_SETUP_URL_LENGTH, MAX_SUCCESS_SELECTOR_LENGTH } from '../../src/control/auth/auth-setup-contracts.js';
import { MAX_CANDIDATE_URL_PART_LENGTH } from '../../src/discovery/candidate-contracts.js';
import {
  MAX_READ_CHECK_EXPECTATIONS,
  MAX_READ_CHECK_PARAMETERS,
  MAX_READ_CHECK_ROW_COUNT,
  READ_CHECK_EXPECTATION_KINDS,
} from '../../src/discovery/read-check-contracts.js';
import { CREATE_CANDIDATE, FULL_VERIFICATION, READ_CHECK_FACTS, sampleDraft, sampleScenario } from './approval-samples.js';

const codesOf = (result: ScenarioDraftValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));

/** 検証の指定の一部を変えた下書き（送る欄は `name`・`email`）。 */
const draftWith = (verification: unknown): Record<string, unknown> => sampleDraft({ verification });
const withItem = (item: Partial<Record<keyof ScenarioVerification, unknown>>): Record<string, unknown> =>
  draftWith({ ...FULL_VERIFICATION, ...item });
const READ = FULL_VERIFICATION.readVerification;
const withRead = (change: Record<string, unknown>): Record<string, unknown> => withItem({ readVerification: { ...READ, ...change } });

describe('scenario verification spec contracts (T30a)', () => {
  it('has the frozen closed lists and the named limits', () => {
    expect(SCENARIO_VERIFICATION_ITEMS).toEqual(['successCondition', 'inputErrorCondition', 'recordId', 'readVerification']);
    expect(RECORD_ID_SOURCES).toEqual(['URL_PATH_PATTERN', 'ELEMENT']);
    expect(VERIFICATION_EXPECTATION_KINDS).toEqual(['ROW_COUNT_EQUALS', 'TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS']);
    expect(VERIFICATION_EXPECTATION_KINDS.every((kind) => (READ_CHECK_EXPECTATION_KINDS as readonly string[]).includes(kind))).toBe(true);
    expect(VERIFICATION_EXPECTATION_KINDS).not.toContain('ROW_COUNT_AT_LEAST');
    for (const list of [SCENARIO_VERIFICATION_ITEMS, RECORD_ID_SOURCES, VERIFICATION_EXPECTATION_KINDS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect(RECORD_ID_PLACEHOLDER).toBe('{id}');
    expect(MAX_RECORD_ID_PATH_PATTERN_LENGTH).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    expect(MAX_RESULT_CONDITION_PATH_LENGTH).toBe(MAX_AUTH_SETUP_URL_LENGTH);
    expect(MAX_VERIFICATION_SELECTOR_LENGTH).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    expect([MIN_VERIFICATION_ROW_COUNT, MAX_VERIFICATION_ROW_COUNT]).toEqual([1, MAX_READ_CHECK_ROW_COUNT]);
    expect(MAX_VERIFICATION_BINDINGS).toBe(MAX_READ_CHECK_PARAMETERS);
    expect(MAX_VERIFICATION_EXPECTATIONS).toBe(MAX_READ_CHECK_EXPECTATIONS);
    expect(UNSPECIFIED_VERIFICATION).toEqual({ successCondition: null, inputErrorCondition: null, recordId: null, readVerification: null });
    expect(Object.isFrozen(UNSPECIFIED_VERIFICATION)).toBe(true);
  });

  it('has the verification reasons in the closed list of the draft rejection reasons', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toEqual(expect.arrayContaining([
      'SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS',
      'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
      'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
    ]));
  });
});

describe('scenario draft validation of the verification spec (T30a)', () => {
  it('accepts a full spec and keeps it in the content (bindings in code unit order, expectations in the input order)', () => {
    const verification = {
      ...FULL_VERIFICATION,
      readVerification: {
        readCheckId: 'rc-1',
        revision: 2,
        bindings: [{ parameterName: 'status', fieldName: 'email' }, { parameterName: 'q', fieldName: 'name' }],
        expectations: [
          { kind: 'TEXT_CONTAINS', fieldName: 'email' },
          { kind: 'DETAIL_FIELD_EQUALS', field: '氏名', fieldName: 'name' },
          { kind: 'ROW_COUNT_EQUALS', count: 1 },
        ],
      },
    };
    const result = validateScenarioDraft(draftWith(verification), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.content.verification).toEqual({
        ...verification,
        readVerification: {
          ...verification.readVerification,
          bindings: [{ parameterName: 'q', fieldName: 'name' }, { parameterName: 'status', fieldName: 'email' }],
        },
      });
      expect(Object.isFrozen(result.content.verification.readVerification?.bindings)).toBe(true);
    }
  });

  it('accepts path patterns and paths with the path characters of Task 26 (percent encoding, sub-delims)', () => {
    const result = validateScenarioDraft(withItem({
      successCondition: { pathPrefix: '/members/%E7%99%BB%E9%8C%B2;done', selector: '.ok' },
      recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/{id}' },
    }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok).toBe(true);
  });

  it('accepts an element as the record id source and conditions without a selector', () => {
    const result = validateScenarioDraft(withItem({
      successCondition: { pathPrefix: '/members/', selector: null },
      inputErrorCondition: { pathPrefix: '/registered/', selector: null },
      recordId: { source: 'ELEMENT', selector: '#record-id' },
    }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok && result.content.verification.recordId).toEqual({ source: 'ELEMENT', selector: '#record-id' });
  });

  it('treats a draft without a verification spec as all unspecified (the draft and the approval are still possible)', () => {
    const result = validateScenarioDraft(sampleDraft(), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok && result.content.verification).toEqual(UNSPECIFIED_VERIFICATION);
  });

  it('accepts a spec with unspecified items (null), and reports them as missing', () => {
    const result = validateScenarioDraft(withItem({ recordId: null, readVerification: null }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(missingVerificationItemsOf(result.content.verification)).toEqual(['recordId', 'readVerification']);
    }
  });

  const longText = (length: number): string => 'a'.repeat(length);

  it.each<readonly [string, unknown]>([
    ['a verification spec that is not an object', 'yes'],
    ['an unknown verification item', { ...FULL_VERIFICATION, extra: null }],
    ['a missing verification item', (({ recordId: _omitted, ...rest }) => rest)(FULL_VERIFICATION)],
    ['a condition without a selector property', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/members/' } }],
    ['a condition with an unknown property', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/a', selector: null, status: 200 } }],
    ['a condition path prefix that does not start with "/"', { ...FULL_VERIFICATION, successCondition: { pathPrefix: 'members', selector: null } }],
    ['a too long condition path prefix', {
      ...FULL_VERIFICATION, inputErrorCondition: { pathPrefix: `/${longText(MAX_RESULT_CONDITION_PATH_LENGTH)}`, selector: null },
    }],
    ['an empty condition selector', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/a', selector: '' } }],
    ['a too long condition selector', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/a', selector: longText(MAX_VERIFICATION_SELECTOR_LENGTH + 1) } }],
    // T30a fix round 1: path とセレクタの細かい形は、Task 26 の判定の owner（`auth-setup-policy.ts` の `isAcceptedPath`・`isAcceptedSelector`）で確かめる。
    ['a condition path prefix with "//"', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '//members/', selector: null } }],
    ['a condition path prefix with ".."', { ...FULL_VERIFICATION, inputErrorCondition: { pathPrefix: '/members/../admin', selector: null } }],
    ['a condition path prefix with an encoded dot', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/members/%2E%2E/', selector: null } }],
    ['a condition path prefix with a space', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/members list/', selector: null } }],
    ['a condition path prefix with a query', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/members?x=1', selector: null } }],
    ['a condition selector with a line break', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/a', selector: '.ok\n.ng' } }],
    ['a condition selector with a control character', { ...FULL_VERIFICATION, inputErrorCondition: { pathPrefix: '/b', selector: '.error\u0007' } }],
    ['a condition selector with a lone surrogate', { ...FULL_VERIFICATION, successCondition: { pathPrefix: '/a', selector: '.ok\ud800' } }],
    ['an element selector with a line separator', { ...FULL_VERIFICATION, recordId: { source: 'ELEMENT', selector: '#id\u2028' } }],
    ['a path pattern with "//"', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members//{id}' } }],
    ['a path pattern with ".."', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/../{id}' } }],
    ['a path pattern with a space', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/my members/{id}' } }],
    ['an unknown record id source', { ...FULL_VERIFICATION, recordId: { source: 'QUERY', name: 'id' } }],
    ['a path pattern without the placeholder', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/' } }],
    ['a path pattern with two placeholders', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/{id}/members/{id}' } }],
    ['a placeholder that is not a whole segment', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/m-{id}' } }],
    ['another brace in a path pattern', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/{name}/{id}' } }],
    ['a path pattern that does not start with "/"', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: 'members/{id}' } }],
    ['a path pattern with a query', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}?x=1' } }],
    ['a too long path pattern', {
      ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: `/{id}/${longText(MAX_RECORD_ID_PATH_PATTERN_LENGTH)}` },
    }],
    ['an element source without a selector', { ...FULL_VERIFICATION, recordId: { source: 'ELEMENT', selector: ' ' } }],
    ['an element source with a path pattern', { ...FULL_VERIFICATION, recordId: { source: 'ELEMENT', pathPattern: '/members/{id}' } }],
    ['a bad READ check id', { ...FULL_VERIFICATION, readVerification: { ...READ, readCheckId: 'RC 1' } }],
    ['a zero READ check revision', { ...FULL_VERIFICATION, readVerification: { ...READ, revision: 0 } }],
    ['no binding', { ...FULL_VERIFICATION, readVerification: { ...READ, bindings: [] } }],
    ['too many bindings', { ...FULL_VERIFICATION, readVerification: {
      ...READ, bindings: Array.from({ length: MAX_VERIFICATION_BINDINGS + 1 }, (_value, index) => ({ parameterName: `p${index}`, fieldName: 'name' })),
    } }],
    ['a duplicate binding parameter', { ...FULL_VERIFICATION, readVerification: {
      ...READ, bindings: [{ parameterName: 'q', fieldName: 'name' }, { parameterName: 'q', fieldName: 'email' }],
    } }],
    ['a binding with an empty field name', { ...FULL_VERIFICATION, readVerification: { ...READ, bindings: [{ parameterName: 'q', fieldName: '' }] } }],
    ['no expectation', { ...FULL_VERIFICATION, readVerification: { ...READ, expectations: [] } }],
    ['a duplicate expectation', { ...FULL_VERIFICATION, readVerification: {
      ...READ, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1 }, { kind: 'ROW_COUNT_EQUALS', count: 1 }],
    } }],
    ['too many expectations', { ...FULL_VERIFICATION, readVerification: {
      ...READ, expectations: Array.from({ length: MAX_VERIFICATION_EXPECTATIONS + 1 }, () => ({ kind: 'ROW_COUNT_EQUALS', count: 1 })),
    } }],
    ['an expectation of at least rows', { ...FULL_VERIFICATION, readVerification: { ...READ, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] } }],
    ['an expectation of zero rows', { ...FULL_VERIFICATION, readVerification: { ...READ, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 0 }] } }],
    ['an expectation of too many rows', {
      ...FULL_VERIFICATION, readVerification: { ...READ, expectations: [{ kind: 'ROW_COUNT_EQUALS', count: MAX_VERIFICATION_ROW_COUNT + 1 }] },
    }],
    ['a text expectation with a fixed text', { ...FULL_VERIFICATION, readVerification: { ...READ, expectations: [{ kind: 'TEXT_CONTAINS', text: 'x' }] } }],
    ['a detail expectation without the detail field', {
      ...FULL_VERIFICATION, readVerification: { ...READ, expectations: [{ kind: 'DETAIL_FIELD_EQUALS', fieldName: 'name' }] },
    }],
  ])('rejects the shape of a verification spec with %s (SCENARIO_INPUT_INVALID only)', (_label, verification) => {
    const result = validateScenarioDraft(draftWith(verification), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(codesOf(result).length).toBeGreaterThan(0);
    expect(new Set(codesOf(result))).toEqual(new Set(['SCENARIO_INPUT_INVALID']));
  });

  it.each<readonly [string, Record<string, unknown>, readonly string[]]>([
    ['a READ check that is not a definition of the profile', withRead({ readCheckId: 'rc-missing' }), ['SCENARIO_READ_CHECK_NOT_FOUND']],
    ['a READ check of another profile', withRead({ readCheckId: 'rc-other', revision: 1 }), ['SCENARIO_READ_CHECK_NOT_FOUND']],
    ['a canceled READ check', withRead({ readCheckId: 'rc-canceled', revision: 1 }), ['SCENARIO_READ_CHECK_CANCELED']],
    ['an old READ check revision', withRead({ revision: 1 }), ['SCENARIO_READ_CHECK_REVISION_MISMATCH']],
    ['a binding of a parameter that the READ check does not send', withRead({ bindings: [{ parameterName: 'page', fieldName: 'name' }] }),
      ['SCENARIO_VERIFICATION_PARAMETER_UNKNOWN']],
    ['a binding to a field that is not sent', withRead({ bindings: [{ parameterName: 'q', fieldName: 'include_disabled' }] }), ['SCENARIO_VERIFICATION_FIELD_NOT_SENT']],
    ['a text expectation of a field that is not sent', withRead({ expectations: [{ kind: 'TEXT_CONTAINS', fieldName: 'include_disabled' }] }),
      ['SCENARIO_VERIFICATION_FIELD_NOT_SENT']],
    ['a detail expectation of a field that is not sent', withRead({ expectations: [{ kind: 'DETAIL_FIELD_EQUALS', field: '氏名', fieldName: 'kept' }] }),
      ['SCENARIO_VERIFICATION_FIELD_NOT_SENT']],
  ])('rejects %s', (_label, draft, codes) => {
    expect(codesOf(validateScenarioDraft(draft, CREATE_CANDIDATE, READ_CHECK_FACTS))).toEqual(codes);
  });

  // T30a fix round 1: 成功の条件と入力の誤りの条件が同時に当たりうる（path の前方一致が同じで、セレクタも同じか、どちらかにない）なら拒む
  // （Task 26 の `mayMatchTogether`）。
  it.each<readonly [string, unknown, unknown, boolean]>([
    ['the same path and no selector on either', { pathPrefix: '/members/', selector: null }, { pathPrefix: '/members/', selector: null }, true],
    ['the same path and a selector on one side', { pathPrefix: '/members/', selector: '.ok' }, { pathPrefix: '/members/', selector: null }, true],
    ['the same path and the same selector', { pathPrefix: '/members/', selector: '.ok' }, { pathPrefix: '/members/', selector: '.ok' }, true],
    ['the same path and other selectors', { pathPrefix: '/members/', selector: '.ok' }, { pathPrefix: '/members/', selector: '.error' }, false],
    ['other paths without a selector', { pathPrefix: '/members/', selector: null }, { pathPrefix: '/members/new', selector: null }, false],
  ])('checks whether the success and the input error conditions may match together (%s)', (_label, successCondition, inputErrorCondition, ambiguous) => {
    const result = validateScenarioDraft(withItem({ successCondition, inputErrorCondition }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(codesOf(result)).toEqual(ambiguous ? ['SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS'] : []);
  });

  it('does not check the overlap while one of the conditions is unspecified', () => {
    expect(validateScenarioDraft(withItem({ inputErrorCondition: null }), CREATE_CANDIDATE, READ_CHECK_FACTS).ok).toBe(true);
  });

  it('names the READ check and the field in the errors, without values', () => {
    const result = validateScenarioDraft(withRead({
      bindings: [{ parameterName: 'page', fieldName: 'include_disabled' }],
    }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map(({ code, fieldName, readCheckId }) => [code, fieldName, readCheckId])).toEqual([
        ['SCENARIO_VERIFICATION_PARAMETER_UNKNOWN', null, 'rc-1'],
        ['SCENARIO_VERIFICATION_FIELD_NOT_SENT', 'include_disabled', 'rc-1'],
      ]);
    }
  });

  it('does not check the bindings against a READ check that is not usable (one error per reference)', () => {
    expect(codesOf(validateScenarioDraft(withRead({ readCheckId: 'rc-canceled', revision: 1, bindings: [{ parameterName: 'page', fieldName: 'name' }] }),
      CREATE_CANDIDATE, READ_CHECK_FACTS))).toEqual(['SCENARIO_READ_CHECK_CANCELED']);
  });

  it('reports the verification errors after the READ checks and before the limits (the overlap of the conditions first)', () => {
    const result = validateScenarioDraft(sampleDraft({
      readChecks: [{ readCheckId: 'rc-canceled', revision: 1 }],
      verification: {
        ...FULL_VERIFICATION,
        inputErrorCondition: { pathPrefix: '/members/', selector: null },
        readVerification: { ...READ, bindings: [{ parameterName: 'q', fieldName: 'include_disabled' }] },
      },
      approvalTtlDays: 31,
    }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(codesOf(result)).toEqual([
      'SCENARIO_READ_CHECK_CANCELED',
      'SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS',
      'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
      'SCENARIO_TTL_ABOVE_DEFAULT',
    ]);
  });
});

describe('missing verification items (T30a)', () => {
  it('returns no item for a full spec, and every item for an unspecified spec (in the order of the closed list)', () => {
    expect(missingVerificationItemsOf(FULL_VERIFICATION)).toEqual([]);
    expect(missingVerificationItemsOf(UNSPECIFIED_VERIFICATION)).toEqual(SCENARIO_VERIFICATION_ITEMS);
  });

  it.each(SCENARIO_VERIFICATION_ITEMS.map((item) => [item] as const))('returns %s when only that item is unspecified', (item) => {
    const missing = missingVerificationItemsOf({ ...FULL_VERIFICATION, [item]: null });
    expect(missing).toEqual([item]);
    expect(Object.isFrozen(missing)).toBe(true);
  });
});

describe('stored scenario revisions before the verification spec (T30a)', () => {
  it('reads a revision stored before the verification spec as all unspecified, and keeps a stored spec', () => {
    const { verification: _omitted, ...legacy } = sampleScenario();
    expect(storedScenarioRevisionOf(JSON.parse(JSON.stringify(legacy)) as unknown)).toEqual({ ...legacy, verification: UNSPECIFIED_VERIFICATION });
    expect(storedScenarioRevisionOf(JSON.parse(JSON.stringify(sampleScenario())) as unknown)).toEqual(sampleScenario());
  });

  it('rejects a stored revision with a broken verification spec (no silent default)', () => {
    expect(() => storedScenarioRevisionOf({ ...sampleScenario(), verification: null })).toThrow(RangeError);
    expect(() => storedScenarioRevisionOf({ ...sampleScenario(), verification: { successCondition: null } })).toThrow(RangeError);
  });
});
