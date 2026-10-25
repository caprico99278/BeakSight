// T27c（Task 27 の設計書 4.5、変更履歴「Blocker: T27c」の行の (1)(4)）: READ の確かめの定義の検証（`src/control/read-check-policy.ts`。純粋な関数）。
// - 定義の形は JSON Schema（`read-check-definition`）で確かめる（期待の閉じた一覧、値の長さと件数の上限）。
// - 送る値は、対象の候補の、名前があり、見えていて、readonly でも disabled でもない欄だけ（候補の欄でない・hidden・readonly・disabled は拒む）。
// - 秘密に見える名前（伏せ字の一覧と同じ判定 `isSecretUrlQueryParameterName`）の欄に値を送る定義は拒む（黙って落とさない）。
// - 対象の候補が分からない（渡されない、識別の digest が違う）、今の分類が READ でない定義は拒む。
// - 候補（`DiscoveryCandidate`）は引数で受ける（保存の口が成果物 `discovery.json` から読んで渡す。T27f）。
import { describe, expect, it } from 'vitest';
import {
  READ_CHECK_DEFINITION_REJECTION_REASONS,
  assertStorableReadCheckDefinition,
  validateReadCheckDefinition,
  type ReadCheckPageContext,
  type ReadCheckValidationResult,
} from '../../src/control/read-check-policy.js';
import type { DiscoveredCandidate, DiscoveryCandidate } from '../../src/discovery/candidate-contracts.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import { MAX_READ_CHECK_PARAMETER_VALUE_LENGTH, type ReadCheckDefinition } from '../../src/discovery/read-check-contracts.js';
import { SAMPLE_ALLOWED_ORIGINS, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const candidateOf = (discovered: DiscoveredCandidate): DiscoveryCandidate => ({
  ...discovered,
  ...classifyCandidate(discovered, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(discovered),
});

/** 一覧の検索の GET の form（READ）。欄の種類をひととおり持つ。 */
const READ_CANDIDATE = candidateOf(sampleForm({
  page: { origin: 'http://127.0.0.1:4173', path: '/admin/items' },
  formMethod: 'GET',
  action: sampleAction('/admin/items'),
  submitterText: '表示',
  fields: [
    sampleField('q'),
    sampleField('category', 'select-one', { options: ['a', 'b'] }),
    sampleField('mode', 'hidden'),
    sampleField('kept', 'text', { readonly: true }),
    sampleField('locked', 'text', { disabled: true }),
    sampleField('invisible', 'text', { hidden: true }),
    sampleField('state'),
    sampleField('API-Key'),
    sampleField(''),
  ],
}));

/** 登録の POST の form（READ でない）。 */
const CREATE_CANDIDATE = candidateOf(sampleForm({ submitterText: '登録', fields: [sampleField('name')] }));

const definition = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  targetIdentityDigest: READ_CANDIDATE.identityDigest,
  parameters: { q: 'example', category: 'a' },
  expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }],
  ...overrides,
});

const codesOf = (result: ReadCheckValidationResult): readonly string[] => (result.ok ? [] : result.errors.map(({ code }) => code));

describe('READ check definition validation (T27c)', () => {
  it('has the closed list of the rejection reasons', () => {
    expect(READ_CHECK_DEFINITION_REJECTION_REASONS).toEqual([
      'READ_CHECK_INPUT_INVALID',
      'READ_PARAMETER_SECRET_LIKE',
      'READ_PARAMETER_NOT_ALLOWED',
      'READ_CANDIDATE_UNKNOWN',
      'READ_CANDIDATE_NOT_READ',
      'READ_CHECK_LIMIT_EXCEEDED',
      'READ_CHECK_PROFILE_NOT_FOUND',
      'READ_CHECK_NOT_FOUND',
      'READ_CHECK_REVISION_CONFLICT',
      'READ_CHECK_CANCELED',
      // T27f（T27c の申し送り 6）: 取り消したプロファイルでは、定義を作らない・変えない。
      'READ_CHECK_PROFILE_RETIRED',
      // T27R-fix-1（DEF-088）: 送る値の名前か値が、発見の分類の危険な語に当たる。
      'READ_PARAMETER_DANGEROUS_WORD',
      // T28b fix round 1: READ の確かめを許さないモードのプロファイル（公開の監査）では、定義を作らない・変えない。
      'READ_CHECK_PROFILE_NOT_ELIGIBLE',
      // T37d: 画面の path の定義の理由（下の T37d の場面で確かめる）。
      'READ_PAGE_PATH_INVALID',
      'READ_PAGE_START_URL_UNKNOWN',
      'READ_PAGE_ORIGIN_NOT_ALLOWED',
      'READ_PAGE_PATH_EXCLUDED',
      'READ_PAGE_PATH_DANGEROUS_WORD',
    ]);
    expect(Object.isFrozen(READ_CHECK_DEFINITION_REJECTION_REASONS)).toBe(true);
  });

  it('accepts the visible, editable fields of a READ candidate, and returns a frozen copy', () => {
    const input = definition();
    const result = validateReadCheckDefinition(input, READ_CANDIDATE);
    expect(result).toEqual({ ok: true, definition: input });
    if (result.ok) {
      expect(Object.isFrozen(result.definition)).toBe(true);
      expect(Object.isFrozen(result.definition.parameters)).toBe(true);
      expect(result.definition).not.toBe(input);
    }
    // 送る値のない定義（一覧をそのまま読む）も受ける。
    expect(validateReadCheckDefinition(definition({ parameters: {} }), READ_CANDIDATE).ok).toBe(true);
  });

  it.each([
    ['a hidden field', 'mode'],
    ['a readonly field', 'kept'],
    ['a disabled field', 'locked'],
    ['a field that is not visible', 'invisible'],
    ['a name that is not a field of the candidate', 'page'],
  ])('rejects %s with READ_PARAMETER_NOT_ALLOWED', (_name, field) => {
    const result = validateReadCheckDefinition(definition({ parameters: { q: 'example', [field]: 'x' } }), READ_CANDIDATE);
    expect(codesOf(result)).toEqual(['READ_PARAMETER_NOT_ALLOWED']);
    expect(result.ok ? '' : result.errors[0]?.detail).toContain(field);
  });

  // DEF-094（T28e fix round 1。設計者の判断）: GET の form のファイルの欄は、名前が秘密に見えなくても送れない欄（`isSendableField` が
  // `isUnsendableFieldType` を見る）。修正の前は、値を入れた定義を保存できた。
  it('rejects a value for a file field of a READ form with READ_PARAMETER_NOT_ALLOWED (DEF-094)', () => {
    const withFile = candidateOf(sampleForm({
      page: { origin: 'http://127.0.0.1:4173', path: '/admin/files' },
      formMethod: 'GET',
      action: sampleAction('/admin/files'),
      submitterText: '表示',
      fields: [sampleField('q'), sampleField('attachment', 'file')],
    }));
    expect(withFile.classification).toBe('READ');
    const result = validateReadCheckDefinition(
      definition({ targetIdentityDigest: withFile.identityDigest, parameters: { q: 'example', attachment: 'x' } }),
      withFile,
    );
    expect(codesOf(result)).toEqual(['READ_PARAMETER_NOT_ALLOWED']);
    expect(result.ok ? '' : result.errors[0]?.detail).toContain('attachment');
  });

  it.each([
    ['state', 'state'],
    ['API-Key (the same comparison as the redaction)', 'API-Key'],
  ])('rejects a secret-like name %s with READ_PARAMETER_SECRET_LIKE (even when it is an editable field)', (_name, field) => {
    expect(codesOf(validateReadCheckDefinition(definition({ parameters: { [field]: 'x' } }), READ_CANDIDATE))).toEqual(['READ_PARAMETER_SECRET_LIKE']);
  });

  it('reports every parameter that is rejected, and never puts the values in the details', () => {
    const value = 'value-marker-t27c';
    const result = validateReadCheckDefinition(definition({ parameters: { mode: value, state: value, kept: value, q: value } }), READ_CANDIDATE);
    expect(codesOf(result)).toEqual(['READ_PARAMETER_NOT_ALLOWED', 'READ_PARAMETER_SECRET_LIKE', 'READ_PARAMETER_NOT_ALLOWED']);
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it.each([
    ['a Japanese dangerous word in a value', { q: '削除' }],
    ['a dangerous word in the second value', { q: 'りんご', category: '取り消し' }],
    ['full-width letters of a dangerous word in a value', { q: 'ＤＥＬＥＴＥ' }],
    ['a percent-encoded dangerous word in a value', { q: '%E5%89%8A%E9%99%A4' }],
  ])('rejects %s with READ_PARAMETER_DANGEROUS_WORD, without the value in the details (T27R-fix-1, DEF-088)', (_name, parameters) => {
    const result = validateReadCheckDefinition(definition({ parameters }), READ_CANDIDATE);
    expect(codesOf(result)).toEqual(['READ_PARAMETER_DANGEROUS_WORD']);
    for (const value of Object.values(parameters)) {
      expect(result.ok ? [] : result.errors.map(({ detail }) => detail).join(' ')).not.toContain(value);
    }
  });

  it('rejects a dangerous word in a name, also when the candidate is unknown (T27R-fix-1, DEF-088)', () => {
    expect(codesOf(validateReadCheckDefinition(definition({ parameters: { '削除': 'x' } }), null)))
      .toEqual(['READ_CANDIDATE_UNKNOWN', 'READ_PARAMETER_DANGEROUS_WORD']);
    // 秘密に見える名前の確かめが先。
    expect(codesOf(validateReadCheckDefinition(definition({ parameters: { token: '削除' } }), READ_CANDIDATE)))
      .toEqual(['READ_PARAMETER_SECRET_LIKE']);
  });

  it('rejects an unknown candidate (none given, or another identity digest)', () => {
    expect(codesOf(validateReadCheckDefinition(definition(), null))).toEqual(['READ_CANDIDATE_UNKNOWN']);
    expect(codesOf(validateReadCheckDefinition(definition({ targetIdentityDigest: CREATE_CANDIDATE.identityDigest }), READ_CANDIDATE)))
      .toEqual(['READ_CANDIDATE_UNKNOWN']);
    // 候補が分からなくても、秘密に見える名前は拒む。
    expect(codesOf(validateReadCheckDefinition(definition({ parameters: { code: 'x' } }), null)))
      .toEqual(['READ_CANDIDATE_UNKNOWN', 'READ_PARAMETER_SECRET_LIKE']);
  });

  it('rejects a candidate whose current classification is not READ', () => {
    expect(CREATE_CANDIDATE.classification).toBe('CREATE');
    expect(codesOf(validateReadCheckDefinition(definition({ targetIdentityDigest: CREATE_CANDIDATE.identityDigest, parameters: {} }), CREATE_CANDIDATE)))
      .toEqual(['READ_CANDIDATE_NOT_READ']);
  });

  it('rejects the shapes outside the contract with READ_CHECK_INPUT_INVALID (before the candidate checks)', () => {
    for (const input of [
      null,
      'definition',
      definition({ expectations: [{ kind: 'STATUS_EQUALS' }] }),
      definition({ parameters: { q: 'x'.repeat(MAX_READ_CHECK_PARAMETER_VALUE_LENGTH + 1) } }),
      definition({ note: 'extra' }),
    ]) {
      const codes = codesOf(validateReadCheckDefinition(input, READ_CANDIDATE));
      expect(codes.length, JSON.stringify(input)?.slice(0, 60)).toBeGreaterThan(0);
      expect([...new Set(codes)], JSON.stringify(input)?.slice(0, 60)).toEqual(['READ_CHECK_INPUT_INVALID']);
    }
  });

  it('does not change the input', () => {
    const input = definition();
    const before = JSON.stringify(input);
    validateReadCheckDefinition(input, READ_CANDIDATE);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// T37d（Task 37 の設計書 3.5）: 画面の path の定義の保存の検証。path は `/` で始まる正規の形（query と fragment を持たない。長さの上限）。プロファイルの
// 開始の URL（ターゲット設定の `site.startUrl`）と同じ Origin で組み立てた URL が、許可 Origin（ターゲット設定とプロファイルの両方）の中で、読まない
// パス・読む範囲の外・ログインの画面・危険な語に当たらないこと。対象の候補は見ない。
describe('T37d: the validation of a page path READ check definition', () => {
  const ORIGIN = 'http://127.0.0.1:4173';
  const CONTEXT: ReadCheckPageContext = Object.freeze({
    startUrl: `${ORIGIN}/admin`,
    allowedOrigins: [ORIGIN],
    approvedTestOrigins: [ORIGIN],
    excludedPathPrefixes: ['/admin/secret'],
    auditPathPrefixes: [],
    sessionLostPathPrefix: '/auth',
  });
  const pageDefinition = (path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    targetPagePath: path,
    parameters: {},
    expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }],
    ...overrides,
  });

  it('adds the reasons of a page path to the end of the closed list', () => {
    expect(READ_CHECK_DEFINITION_REJECTION_REASONS.slice(-5)).toEqual([
      'READ_PAGE_PATH_INVALID',
      'READ_PAGE_START_URL_UNKNOWN',
      'READ_PAGE_ORIGIN_NOT_ALLOWED',
      'READ_PAGE_PATH_EXCLUDED',
      'READ_PAGE_PATH_DANGEROUS_WORD',
    ]);
  });

  it('accepts a page path on the origin of the start URL, without looking at the candidate', () => {
    const input = pageDefinition('/admin/members');
    expect(validateReadCheckDefinition(input, null, CONTEXT)).toEqual({ ok: true, definition: input });
    expect(validateReadCheckDefinition(input, CREATE_CANDIDATE, CONTEXT).ok).toBe(true);
  });

  it.each([
    ['dot segments', '/admin/../members'],
    ['a brace (encoded by the URL parser)', '/admin{members}'],
    ['a character the URL parser encodes', '/会員'],
    ['a percent sign that is not an escape', '/admin%zz'],
  ])('rejects a path with %s with READ_PAGE_PATH_INVALID', (_name, path) => {
    expect(codesOf(validateReadCheckDefinition(pageDefinition(path), null, CONTEXT))).toEqual(['READ_PAGE_PATH_INVALID']);
  });

  it('rejects the shapes of the schema (query, fragment, another host, parameters) with READ_CHECK_INPUT_INVALID', () => {
    for (const path of ['/admin?x=1', '/admin#x', '//example.invalid/admin', 'admin']) {
      expect([...new Set(codesOf(validateReadCheckDefinition(pageDefinition(path), null, CONTEXT)))], path).toEqual(['READ_CHECK_INPUT_INVALID']);
    }
    expect([...new Set(codesOf(validateReadCheckDefinition(pageDefinition('/admin', { parameters: { q: 'x' } }), null, CONTEXT)))])
      .toEqual(['READ_CHECK_INPUT_INVALID']);
  });

  it('rejects a page path when the start URL is unknown or not allowed', () => {
    expect(codesOf(validateReadCheckDefinition(pageDefinition('/admin'), null, null))).toEqual(['READ_PAGE_START_URL_UNKNOWN']);
    expect(codesOf(validateReadCheckDefinition(pageDefinition('/admin'), null))).toEqual(['READ_PAGE_START_URL_UNKNOWN']);
    expect(codesOf(validateReadCheckDefinition(pageDefinition('/admin'), null, { ...CONTEXT, startUrl: 'not a url' })))
      .toEqual(['READ_PAGE_START_URL_UNKNOWN']);
    expect(codesOf(validateReadCheckDefinition(pageDefinition('/admin'), null, { ...CONTEXT, approvedTestOrigins: ['http://127.0.0.1:4174'] })))
      .toEqual(['READ_PAGE_ORIGIN_NOT_ALLOWED']);
    expect(codesOf(validateReadCheckDefinition(pageDefinition('/admin'), null, { ...CONTEXT, allowedOrigins: ['http://127.0.0.1:4174'] })))
      .toEqual(['READ_PAGE_ORIGIN_NOT_ALLOWED']);
  });

  it.each([
    ['an excluded path', '/admin/secret/list', CONTEXT],
    ['an excluded path in capitals', '/ADMIN/SECRET', CONTEXT],
    ['an excluded path in percent-encoding', '/admin/%73ecret', CONTEXT],
    ['the login screen (the session lost path)', '/auth/login', CONTEXT],
    ['a path outside the audit path prefixes', '/other', { ...CONTEXT, auditPathPrefixes: ['/admin'] }],
  ])('rejects %s with READ_PAGE_PATH_EXCLUDED', (_name, path, context) => {
    expect(codesOf(validateReadCheckDefinition(pageDefinition(path), null, context))).toEqual(['READ_PAGE_PATH_EXCLUDED']);
  });

  it.each([
    ['a dangerous word', '/admin/members/1/delete'],
    ['a dangerous word in full-width letters encoded', '/admin/%EF%BC%A4%EF%BC%A5%EF%BC%AC%EF%BC%A5%EF%BC%B4%EF%BC%A5'],
    ['the logout path', '/admin/logout'],
  ])('rejects %s with READ_PAGE_PATH_DANGEROUS_WORD', (_name, path) => {
    expect(codesOf(validateReadCheckDefinition(pageDefinition(path), null, CONTEXT))).toEqual(['READ_PAGE_PATH_DANGEROUS_WORD']);
  });

  it('accepts a path inside the audit path prefixes, and stores only the checked shape', () => {
    expect(validateReadCheckDefinition(pageDefinition('/admin/members'), null, { ...CONTEXT, auditPathPrefixes: ['/admin'] }).ok).toBe(true);
    expect(assertStorableReadCheckDefinition(pageDefinition('/admin/members') as unknown as ReadCheckDefinition)).toEqual(pageDefinition('/admin/members'));
    expect(() => assertStorableReadCheckDefinition(pageDefinition('/a/../b') as unknown as ReadCheckDefinition)).toThrow(RangeError);
    expect(() => assertStorableReadCheckDefinition(pageDefinition('/a', { parameters: { q: 'x' } }) as unknown as ReadCheckDefinition)).toThrow(RangeError);
  });
});
