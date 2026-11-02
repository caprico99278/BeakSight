// T30a（Task 30 の設計書 2 章のユーザーの判断 4、3 章の「結果の判定」「登録の ID」「READ による照合」「検証の指定」、10 章の 5）: シナリオの
// 検証の指定（`scenario-contracts.ts` の `ScenarioVerification`）と、下書きの確かめ（`scenario-policy.ts` の `validateScenarioDraft`）の検証の指定の
// 確かめ、未指定の項目の判定（`missingVerificationItemsOf`）、検証の指定の前に保存した版の読み方（`storedScenarioRevisionOf`）。
// - 形（`SCENARIO_INPUT_INVALID` だけ）: 結果の条件の形、path の型の `{id}`（ちょうど 1 つ、区切りの全体）、ID の取り方の閉じた一覧、READ の参照、
//   結び付けの件数と重複、期待の種類（`ROW_COUNT_AT_LEAST` は使えない）と件数と値の範囲。
// - 中身: READ の定義が同じプロファイルの有効な今の版（Task 28 の照らす READ の定義と同じ理由）、結び付ける READ の送る値が定義にある
//   （`SCENARIO_VERIFICATION_PARAMETER_UNKNOWN`）、結び付けと期待の欄が送る欄にある（`SCENARIO_VERIFICATION_FIELD_NOT_SENT`）。
// - 下書きに検証の指定がなければ、すべて未指定（承認はできるが、実行の許可は出せない）。
// - PL-6a（設計書 `2026-10-26-beaksight-plain-ui-design.md` 8.1、設計者の判断 (a)〜(c)・(f)）: 成功の条件と入力の誤りの条件はなくした。結果の判定のしかたの
//   印（`resultJudgement`）は下書きの確かめが送り方から付ける（form は `FORM_STRUCTURE`。入れるなら同じ値）。form の ID の取り方は ID の型の一覧
//   （`URL_PATH_PATTERNS`、1〜2 件）だけ。照合の READ は照合の専用の印（`verificationOnly`）を持てる。前に保存した文書の成否の条件は、読むときに捨てる。
import { describe, expect, it } from 'vitest';
import {
  MAX_FORM_RECORD_ID_PATTERNS,
  MAX_RECORD_ID_PATH_PATTERN_LENGTH,
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
  assertStorableScenarioRevision,
  missingVerificationItemsOf,
  storedScenarioRevisionOf,
  validateScenarioDraft,
  type ScenarioDraftValidationResult,
} from '../../src/control/approval/scenario-policy.js';
import { MAX_SUCCESS_SELECTOR_LENGTH } from '../../src/control/auth/auth-setup-contracts.js';
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
    expect(SCENARIO_VERIFICATION_ITEMS).toEqual(['resultJudgement', 'recordId', 'readVerification']);
    expect(RECORD_ID_SOURCES).toEqual(['URL_PATH_PATTERN', 'ELEMENT', 'URL_PATH_PATTERNS']);
    expect(MAX_FORM_RECORD_ID_PATTERNS).toBe(2);
    expect(VERIFICATION_EXPECTATION_KINDS).toEqual(['ROW_COUNT_EQUALS', 'TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS']);
    expect(VERIFICATION_EXPECTATION_KINDS.every((kind) => (READ_CHECK_EXPECTATION_KINDS as readonly string[]).includes(kind))).toBe(true);
    expect(VERIFICATION_EXPECTATION_KINDS).not.toContain('ROW_COUNT_AT_LEAST');
    for (const list of [SCENARIO_VERIFICATION_ITEMS, RECORD_ID_SOURCES, VERIFICATION_EXPECTATION_KINDS]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
    expect(RECORD_ID_PLACEHOLDER).toBe('{id}');
    expect(MAX_RECORD_ID_PATH_PATTERN_LENGTH).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    expect(MAX_VERIFICATION_SELECTOR_LENGTH).toBe(MAX_SUCCESS_SELECTOR_LENGTH);
    expect([MIN_VERIFICATION_ROW_COUNT, MAX_VERIFICATION_ROW_COUNT]).toEqual([1, MAX_READ_CHECK_ROW_COUNT]);
    expect(MAX_VERIFICATION_BINDINGS).toBe(MAX_READ_CHECK_PARAMETERS);
    expect(MAX_VERIFICATION_EXPECTATIONS).toBe(MAX_READ_CHECK_EXPECTATIONS);
    expect(UNSPECIFIED_VERIFICATION).toEqual({ resultJudgement: null, recordId: null, readVerification: null });
    expect(Object.isFrozen(UNSPECIFIED_VERIFICATION)).toBe(true);
  });

  it('has the verification reasons in the closed list of the draft rejection reasons', () => {
    expect(SCENARIO_DRAFT_REJECTION_REASONS).toEqual(expect.arrayContaining([
      'SCENARIO_VERIFICATION_PARAMETER_UNKNOWN',
      'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
    ]));
    // PL-6a: 2 つの条件の重なりの理由は、条件がなくなったので一覧から外した。
    expect(SCENARIO_DRAFT_REJECTION_REASONS).not.toContain('SCENARIO_VERIFICATION_CONDITIONS_AMBIGUOUS');
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

  it('accepts path patterns with the path characters of Task 26 (percent encoding, sub-delims), two at most, in the input order', () => {
    const patterns = ['/members/%E7%99%BB%E9%8C%B2;done/{id}', '/{id}'];
    const result = validateScenarioDraft(withItem({ recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: patterns } }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok && result.content.verification.recordId).toEqual({ source: 'URL_PATH_PATTERNS', pathPatterns: patterns });
  });

  it('sets the result judgement of a form from the transport (a person does not type it)', () => {
    const { resultJudgement: _omitted, ...withoutJudgement } = FULL_VERIFICATION;
    const result = validateScenarioDraft(draftWith(withoutJudgement), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok && result.content.verification.resultJudgement).toBe('FORM_STRUCTURE');
  });

  it('keeps the verification only mark of the READ verification only when it is true', () => {
    const marked = validateScenarioDraft(withRead({ verificationOnly: true }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(marked.ok && marked.content.verification.readVerification?.verificationOnly).toBe(true);
    const unmarked = validateScenarioDraft(withRead({ verificationOnly: false }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(unmarked.ok && Object.hasOwn(unmarked.content.verification.readVerification ?? {}, 'verificationOnly')).toBe(false);
  });

  // PL-5 の 9 の (4)（設計書 8.1）: form の ID の取り方は不足に数えない（決められなければ null のまま、結果は ID なしの PARTIAL）。答え合わせは不足のまま。
  it('treats a draft without a verification spec as unspecified but for the result judgement (the draft and the approval are still possible)', () => {
    const result = validateScenarioDraft(sampleDraft(), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok && result.content.verification).toEqual({ ...UNSPECIFIED_VERIFICATION, resultJudgement: 'FORM_STRUCTURE' });
    expect(result.ok && missingVerificationItemsOf(result.content.verification)).toEqual(['readVerification']);
  });

  it('accepts a spec with unspecified items (null), and reports them as missing', () => {
    const result = validateScenarioDraft(withItem({ recordId: null, readVerification: null }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(missingVerificationItemsOf(result.content.verification)).toEqual(['readVerification']);
    }
  });

  const longText = (length: number): string => 'a'.repeat(length);

  it.each<readonly [string, unknown]>([
    ['a verification spec that is not an object', 'yes'],
    ['an unknown verification item', { ...FULL_VERIFICATION, extra: null }],
    ['a missing verification item', (({ recordId: _omitted, ...rest }) => rest)(FULL_VERIFICATION)],
    // PL-6a: 成否の条件の項目は受けない（前の下書きの形）。結果の判定のしかたの印は、送り方の値だけ。
    ['the retired success condition', { ...FULL_VERIFICATION, successCondition: null }],
    ['the retired input error condition', { ...FULL_VERIFICATION, inputErrorCondition: { pathPrefix: '/members', selector: '.error' } }],
    ['a result judgement of another kind', { ...FULL_VERIFICATION, resultJudgement: 'SUCCESS_CONDITION' }],
    ['a null result judgement for a form', { ...FULL_VERIFICATION, resultJudgement: null }],
    // PL-6a: form の ID の取り方は ID の型の一覧だけ（1〜2 件、重なりなし）。API の取り方（型 1 つ、要素）は受けない。
    ['a single path pattern of an API scenario', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' } }],
    ['no path pattern', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [] } }],
    ['three path patterns', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/a/{id}', '/b/{id}', '/c/{id}'] } }],
    ['the same path pattern twice', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/a/{id}', '/a/{id}'] } }],
    ['path patterns that are not an array', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: '/a/{id}' } }],
    ['a verification only mark that is not a boolean', { ...FULL_VERIFICATION, readVerification: { ...READ, verificationOnly: 'yes' } }],
    ['an element selector with a line separator', { ...FULL_VERIFICATION, recordId: { source: 'ELEMENT', selector: '#id\u2028' } }],
    ['a path pattern with "//"', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members//{id}'] } }],
    ['a path pattern with ".."', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/../{id}'] } }],
    ['a path pattern with a space', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/my members/{id}'] } }],
    ['an unknown record id source', { ...FULL_VERIFICATION, recordId: { source: 'QUERY', name: 'id' } }],
    ['a path pattern without the placeholder', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/'] } }],
    ['a path pattern with two placeholders', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/{id}/members/{id}'] } }],
    ['a placeholder that is not a whole segment', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/m-{id}'] } }],
    ['another brace in a path pattern', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/{name}/{id}'] } }],
    ['a path pattern that does not start with "/"', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['members/{id}'] } }],
    ['a path pattern with a query', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/{id}?x=1'] } }],
    ['the second path pattern broken', { ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: ['/members/{id}', '/members/{id}/{id}'] } }],
    ['a too long path pattern', {
      ...FULL_VERIFICATION, recordId: { source: 'URL_PATH_PATTERNS', pathPatterns: [`/{id}/${longText(MAX_RECORD_ID_PATH_PATTERN_LENGTH)}`] },
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

  it('reports the verification errors after the READ checks and before the limits', () => {
    const result = validateScenarioDraft(sampleDraft({
      readChecks: [{ readCheckId: 'rc-canceled', revision: 1 }],
      verification: {
        ...FULL_VERIFICATION,
        readVerification: { ...READ, bindings: [{ parameterName: 'q', fieldName: 'include_disabled' }] },
      },
      approvalTtlDays: 31,
    }), CREATE_CANDIDATE, READ_CHECK_FACTS);
    expect(codesOf(result)).toEqual([
      'SCENARIO_READ_CHECK_CANCELED',
      'SCENARIO_VERIFICATION_FIELD_NOT_SENT',
      'SCENARIO_TTL_ABOVE_DEFAULT',
    ]);
  });
});

describe('missing verification items (T30a)', () => {
  it('returns no item for a full spec, and every item for an unspecified spec (in the order of the closed list)', () => {
    expect(missingVerificationItemsOf(FULL_VERIFICATION)).toEqual([]);
    // PL-5 の 9 の (4)（設計書 8.1）: form の ID の取り方は不足に数えない（決められなければ null のまま。結果は ID なしの PARTIAL）。
    expect(missingVerificationItemsOf(UNSPECIFIED_VERIFICATION)).toEqual(SCENARIO_VERIFICATION_ITEMS.filter((item) => item !== 'recordId'));
  });

  it.each(SCENARIO_VERIFICATION_ITEMS.filter((item) => item !== 'recordId').map((item) => [item] as const))('returns %s when only that item is unspecified', (item) => {
    const missing = missingVerificationItemsOf({ ...FULL_VERIFICATION, [item]: null });
    expect(missing).toEqual([item]);
    expect(Object.isFrozen(missing)).toBe(true);
  });

  it('returns no item when only the record id of a form scenario is unspecified (PL-5 9 (4))', () => {
    const missing = missingVerificationItemsOf({ ...FULL_VERIFICATION, recordId: null });
    expect(missing).toEqual([]);
    expect(Object.isFrozen(missing)).toBe(true);
  });
});

// LG-3（2026-10-24 の設計 3.7.2）: 検証の指定の前に保存した版（`verification` の項目がない）は、すべて未指定として読み替えずに誤りにする。
describe('stored scenario revisions before the verification spec (T30a, LG-3)', () => {
  it('rejects a revision stored before the verification spec, and keeps a stored spec', () => {
    const { verification: _omitted, ...legacy } = sampleScenario();
    expect(() => storedScenarioRevisionOf(JSON.parse(JSON.stringify(legacy)) as unknown)).toThrow(RangeError);
    expect(storedScenarioRevisionOf(JSON.parse(JSON.stringify(sampleScenario())) as unknown)).toEqual(sampleScenario());
  });

  it('rejects a stored revision with a broken verification spec (no silent default)', () => {
    expect(() => storedScenarioRevisionOf({ ...sampleScenario(), verification: null })).toThrow(RangeError);
    expect(() => storedScenarioRevisionOf({ ...sampleScenario(), verification: { successCondition: null } })).toThrow(RangeError);
  });
});

// PL-6a（設計者の判断 (c)）: 前に保存した文書の成否の条件の項目は、スキーマが受け、読むときに捨てる（結果の判定のしかたの印がなければ null。未指定なので実行の
// 許可は出ない）。新しく書く文書は新しい形だけ（保存の前の確かめ直しが拒む）。
describe('PL-6a: stored scenario revisions with the retired result conditions', () => {
  const legacyVerification = {
    successCondition: { pathPrefix: '/members/', selector: '.registered' },
    inputErrorCondition: { pathPrefix: '/members/new', selector: '.error' },
    recordId: { source: 'URL_PATH_PATTERN', pathPattern: '/members/{id}' },
    readVerification: FULL_VERIFICATION.readVerification,
  };

  it('reads a revision stored with the conditions and drops them, without the result judgement', () => {
    const read = storedScenarioRevisionOf(JSON.parse(JSON.stringify({ ...sampleScenario(), verification: legacyVerification })) as unknown);
    expect(read.verification).toEqual({ resultJudgement: null, recordId: legacyVerification.recordId, readVerification: legacyVerification.readVerification });
    expect(Object.hasOwn(read.verification, 'successCondition')).toBe(false);
    expect(missingVerificationItemsOf(read.verification)).toEqual(['resultJudgement']);
    expect(Object.isFrozen(read.verification)).toBe(true);
  });

  it('does not store a revision with the retired conditions or without the result judgement', () => {
    expect(() => assertStorableScenarioRevision({ ...sampleScenario(), verification: legacyVerification } as never)).toThrow(RangeError);
    const { resultJudgement: _omitted, ...withoutJudgement } = FULL_VERIFICATION;
    expect(() => assertStorableScenarioRevision({ ...sampleScenario(), verification: withoutJudgement } as never)).toThrow(RangeError);
    expect(assertStorableScenarioRevision(sampleScenario())).toEqual(sampleScenario());
  });
});

// T37d fix round 1（T37d の発見事項 2。設計者の判断 5 の重ねの守り）: 書き込みの照合の READ に、画面の path を読む定義は使わない。シナリオの保存の
// 時点で、専用の理由で拒む（結び付けの名前の誤りとは言わない）。開始の拒否（`WRITE_READ_VERIFICATION_PAGE_TARGET`）は、そのまま残る。
describe('T37d fix round 1: the verification READ of a page path definition', () => {
  const PAGE_FACT = { readCheckId: 'rc-page', profileId: READ_CHECK_FACTS[0]?.profileId ?? '', revision: 1, canceledAt: null, parameterNames: [], targetKind: 'PAGE' } as const;
  const FACTS = [...READ_CHECK_FACTS, PAGE_FACT];

  it('has the reason after the reasons before it in the closed list', () => {
    // T38b で API の下書きの理由を、この後に足した。
    expect(SCENARIO_DRAFT_REJECTION_REASONS[SCENARIO_DRAFT_REJECTION_REASONS.indexOf('SCENARIO_TTL_ABOVE_DEFAULT') + 1])
      .toBe('SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET');
  });

  it('rejects a page path definition as the verification READ with its own reason, and still accepts a candidate definition', () => {
    expect(codesOf(validateScenarioDraft(withRead({ readCheckId: 'rc-page', revision: 1 }), CREATE_CANDIDATE, FACTS)))
      .toEqual(['SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET']);
    expect(validateScenarioDraft(draftWith(FULL_VERIFICATION), CREATE_CANDIDATE, FACTS).ok).toBe(true);
  });

  it('keeps the reason of a binding to a field that is not sent', () => {
    expect(codesOf(validateScenarioDraft(withRead({ readCheckId: 'rc-page', revision: 1, bindings: [{ parameterName: 'q', fieldName: 'include_disabled' }] }),
      CREATE_CANDIDATE, FACTS))).toEqual(['SCENARIO_VERIFICATION_READ_CHECK_PAGE_TARGET', 'SCENARIO_VERIFICATION_FIELD_NOT_SENT']);
  });
});
