// T27c（Task 27 の設計書 4.5、変更履歴「Blocker: T27c」の行の (3)）: READ の確かめの契約（`src/discovery/read-check-contracts.ts`）。
// - 期待の種類と結果の閉じた一覧、上限の名前つきの定数（1 回のジョブの READ の上限 20、定義の数の上限は同じ定数）。
// - 定義の JSON Schema（`schemas/control/read-check-definition.schema.json`）の期待の種類（分岐の `const`）と上限が、契約の定数と一致する。
// - CCX-10: 送れる欄の判定（`isSendableField`、`isSendableReadCheckParameter`、`unsendableReadCheckParameterNames`）。保存の確かめ
//   （`src/control/read-check-policy.ts`）と、ワーカーの実行の前の確かめ直し（`src/worker/read-check-run.ts`）が、ここだけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateControlDocument } from '../../src/control/control-schema-validator.js';
import { MAX_CANDIDATE_FIELDS, MAX_FIELD_NAME_LENGTH } from '../../src/discovery/candidate-contracts.js';
import {
  MAX_READ_CHECK_DEFINITIONS_PER_PROFILE,
  MAX_READ_CHECK_DETAIL_FIELD_LENGTH,
  MAX_READ_CHECK_EXPECTATIONS,
  MAX_READ_CHECK_EXPECTED_TEXT_LENGTH,
  MAX_READ_CHECK_PARAMETER_VALUE_LENGTH,
  MAX_READ_CHECK_PARAMETERS,
  MAX_READ_CHECK_ROW_COUNT,
  MAX_READ_CHECKS_PER_JOB,
  MAX_READ_CHECK_PAGE_PATH_LENGTH,
  READ_CHECK_EXPECTATION_KINDS,
  READ_CHECK_RESULTS,
  READ_CHECK_TARGET_KINDS,
  isSendableField,
  isSendableReadCheckParameter,
  readCheckPageUrlOf,
  readCheckTargetKindOf,
  unsendableReadCheckParameterNames,
  type ReadCheckDefinition,
} from '../../src/discovery/read-check-contracts.js';
import { sampleField } from './discovery-candidate-samples.js';

const SCHEMA = JSON.parse(readFileSync(resolve(process.cwd(), 'schemas/control/read-check-definition.schema.json'), 'utf8')) as {
  readonly properties: Record<string, Record<string, unknown>>;
  readonly $defs: Record<string, { readonly properties: Record<string, Record<string, unknown>> }>;
};
const DIGEST = `sha256:${'a'.repeat(64)}`;

const definition = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  targetIdentityDigest: DIGEST,
  parameters: { q: 'example' },
  expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }],
  ...overrides,
});

describe('READ check contracts (T27c)', () => {
  it('has the closed lists of the expectation kinds and the results', () => {
    expect(READ_CHECK_EXPECTATION_KINDS).toEqual(['ROW_COUNT_EQUALS', 'ROW_COUNT_AT_LEAST', 'TEXT_CONTAINS', 'DETAIL_FIELD_EQUALS']);
    expect(READ_CHECK_RESULTS).toEqual([
      'MATCHED', 'NOT_MATCHED', 'UNDETERMINED', 'READ_BLOCKED_BY_POLICY', 'READ_CANDIDATE_DRIFTED', 'READ_CANDIDATE_NOT_READ',
    ]);
    expect(Object.isFrozen(READ_CHECK_EXPECTATION_KINDS)).toBe(true);
    expect(Object.isFrozen(READ_CHECK_RESULTS)).toBe(true);
  });

  it('limits the READ of one job to 20 and uses the same constant for the definitions of one profile', () => {
    expect(MAX_READ_CHECKS_PER_JOB).toBe(20);
    expect(MAX_READ_CHECK_DEFINITIONS_PER_PROFILE).toBe(MAX_READ_CHECKS_PER_JOB);
    expect(MAX_READ_CHECK_PARAMETERS).toBeLessThanOrEqual(MAX_CANDIDATE_FIELDS);
  });

  it('has the expectation kinds of the schema as the const of each branch, in the order of the contract', () => {
    const kinds = (SCHEMA.properties.expectations?.items as { oneOf: { $ref: string }[] }).oneOf
      .map(({ $ref }) => SCHEMA.$defs[$ref.split('/').at(-1) ?? '']?.properties.kind?.const);
    expect(kinds).toEqual([...READ_CHECK_EXPECTATION_KINDS]);
  });

  it('has the limits of the schema equal to the named constants', () => {
    const parameters = SCHEMA.properties.parameters ?? {};
    expect(parameters.maxProperties).toBe(MAX_READ_CHECK_PARAMETERS);
    expect((parameters.propertyNames as Record<string, unknown>).maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect((parameters.additionalProperties as Record<string, unknown>).maxLength).toBe(MAX_READ_CHECK_PARAMETER_VALUE_LENGTH);
    expect(SCHEMA.properties.expectations?.maxItems).toBe(MAX_READ_CHECK_EXPECTATIONS);
    expect(SCHEMA.$defs.rowCount).toMatchObject({ maximum: MAX_READ_CHECK_ROW_COUNT });
    expect(SCHEMA.$defs.textContains?.properties.text).toMatchObject({ maxLength: MAX_READ_CHECK_EXPECTED_TEXT_LENGTH });
    expect(SCHEMA.$defs.detailFieldEquals?.properties.field).toMatchObject({ maxLength: MAX_READ_CHECK_DETAIL_FIELD_LENGTH });
    expect(SCHEMA.$defs.detailFieldEquals?.properties.value).toMatchObject({ maxLength: MAX_READ_CHECK_EXPECTED_TEXT_LENGTH });
  });

  it('accepts a definition of every expectation kind and rejects the shapes outside the contract', () => {
    expect(validateControlDocument('read-check-definition', definition({
      parameters: {},
      expectations: [
        { kind: 'ROW_COUNT_EQUALS', count: 0 },
        { kind: 'ROW_COUNT_AT_LEAST', count: MAX_READ_CHECK_ROW_COUNT },
        { kind: 'TEXT_CONTAINS', text: '一覧' },
        { kind: 'DETAIL_FIELD_EQUALS', field: '名前', value: 'example' },
      ],
    })).ok).toBe(true);
    for (const [name, value] of [
      ['an unknown property', definition({ label: 'x' })],
      ['a digest of another shape', definition({ targetIdentityDigest: 'a'.repeat(64) })],
      ['no expectation', definition({ expectations: [] })],
      ['too many expectations', definition({ expectations: Array.from({ length: MAX_READ_CHECK_EXPECTATIONS + 1 }, () => ({ kind: 'ROW_COUNT_EQUALS', count: 1 })) })],
      ['an unknown expectation kind', definition({ expectations: [{ kind: 'STATUS_EQUALS', count: 1 }] })],
      ['a negative row count', definition({ expectations: [{ kind: 'ROW_COUNT_EQUALS', count: -1 }] })],
      ['a row count over the limit', definition({ expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: MAX_READ_CHECK_ROW_COUNT + 1 }] })],
      ['a fractional row count', definition({ expectations: [{ kind: 'ROW_COUNT_EQUALS', count: 1.5 }] })],
      ['an empty text', definition({ expectations: [{ kind: 'TEXT_CONTAINS', text: '' }] })],
      ['a text over the limit', definition({ expectations: [{ kind: 'TEXT_CONTAINS', text: 'x'.repeat(MAX_READ_CHECK_EXPECTED_TEXT_LENGTH + 1) }] })],
      ['a detail without the field', definition({ expectations: [{ kind: 'DETAIL_FIELD_EQUALS', value: 'x' }] })],
      ['an extra property of an expectation', definition({ expectations: [{ kind: 'TEXT_CONTAINS', text: 'x', count: 1 }] })],
      ['a parameter value that is not a string', definition({ parameters: { q: 1 } })],
      ['a parameter value over the limit', definition({ parameters: { q: 'x'.repeat(MAX_READ_CHECK_PARAMETER_VALUE_LENGTH + 1) } })],
      ['an empty parameter name', definition({ parameters: { '': 'x' } })],
      ['too many parameters', definition({ parameters: Object.fromEntries(Array.from({ length: MAX_READ_CHECK_PARAMETERS + 1 }, (_, index) => [`p${index}`, 'x'])) })],
    ] as const) {
      expect(validateControlDocument('read-check-definition', value).ok, name).toBe(false);
    }
  });
});

describe('CCX-10: the sendable fields of a READ check (the only judgement for the store and the worker)', () => {
  const fields = [
    sampleField('q', 'search'),
    sampleField('status', 'select-one', { options: ['', 'open'] }),
    sampleField('mode', 'hidden'),
    sampleField('kept', 'text', { readonly: true }),
    sampleField('locked', 'text', { disabled: true }),
    sampleField('invisible', 'text', { hidden: true }),
    sampleField('', 'text'),
    sampleField('choice', 'radio', { options: ['a'] }),
    sampleField('choice', 'radio', { options: ['b'], disabled: true }),
    sampleField('pick', 'radio', { options: ['a'] }),
    sampleField('pick', 'radio', { options: ['b'] }),
  ];
  const candidate = { fields };

  it('sends only a named, visible field that is neither readonly nor disabled', () => {
    expect(fields.map(isSendableField)).toEqual([true, true, false, false, false, false, false, true, false, true, true]);
  });

  it('allows a parameter only when the candidate has fields of that name and all of them are sendable (fail-closed)', () => {
    expect(['q', 'status', 'pick'].map((name) => isSendableReadCheckParameter(candidate, name))).toEqual([true, true, true]);
    expect(['mode', 'kept', 'locked', 'invisible', '', 'choice', 'missing'].map((name) => isSendableReadCheckParameter(candidate, name)))
      .toEqual([false, false, false, false, false, false, false]);
  });

  // DEF-094（T28e fix round 1。設計者の判断）: パスワードの欄とファイルの欄は、名前にかかわらず送れない（`isUnsendableFieldType`。シナリオの
  // 送る欄と同じ決め）。保存の確かめ（`READ_PARAMETER_NOT_ALLOWED`）とワーカーの確かめ直し（`PARAMETER_NOT_SENDABLE`）と画面の表示が変わる。
  it('does not send a password or a file field, whatever the name is (DEF-094)', () => {
    const typed = [sampleField('attachment', 'file'), sampleField('pin', 'password'), sampleField('note', 'text')];
    expect(typed.map(isSendableField)).toEqual([false, false, true]);
    expect(['attachment', 'pin', 'note'].map((name) => isSendableReadCheckParameter({ fields: typed }, name))).toEqual([false, false, true]);
    expect(unsendableReadCheckParameterNames({ fields: typed }, { note: 'x', attachment: 'y', pin: 'z' })).toEqual(['attachment', 'pin']);
  });

  it('lists the names of the parameters that are not sendable, in the definition order', () => {
    expect(unsendableReadCheckParameterNames(candidate, { q: 'x', status: 'open' })).toEqual([]);
    expect(unsendableReadCheckParameterNames(candidate, {})).toEqual([]);
    expect(unsendableReadCheckParameterNames(candidate, { invisible: 'x', q: 'x', missing: 'y', choice: 'a' })).toEqual(['invisible', 'missing', 'choice']);
  });
});

// T37d（Task 37 の設計書 3.5）: READ の定義の対象は、READ の候補の識別の digest（`targetIdentityDigest`）か、画面の path（`targetPagePath`）のどちらか
// 1 つ。画面の path の定義は、送る値を持たない（空だけ受ける）。画面の path は、`/` で始まり query と fragment を持たない、正規の形の path だけ。
describe('T37d: the two targets of a READ check definition (a READ candidate or a page path)', () => {
  const pageDefinition = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    targetPagePath: '/admin/members',
    parameters: {},
    expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }],
    ...overrides,
  });

  it('has the closed list of the target kinds and the limit of the page path equal to the schema', () => {
    expect(READ_CHECK_TARGET_KINDS).toEqual(['CANDIDATE', 'PAGE']);
    expect(Object.isFrozen(READ_CHECK_TARGET_KINDS)).toBe(true);
    expect(SCHEMA.properties.targetPagePath).toMatchObject({ maxLength: MAX_READ_CHECK_PAGE_PATH_LENGTH });
  });

  it('accepts a page path definition with no parameters, and tells the target kind of each definition', () => {
    expect(validateControlDocument('read-check-definition', pageDefinition()).ok).toBe(true);
    expect(validateControlDocument('read-check-definition', pageDefinition({ targetPagePath: '/' })).ok).toBe(true);
    expect(readCheckTargetKindOf(pageDefinition() as unknown as ReadCheckDefinition)).toBe('PAGE');
    expect(readCheckTargetKindOf(definition() as unknown as ReadCheckDefinition)).toBe('CANDIDATE');
  });

  it('rejects a definition with both targets, with no target, or a page path definition with parameters', () => {
    for (const [name, value] of [
      ['both targets', pageDefinition({ targetIdentityDigest: DIGEST })],
      ['no target', { parameters: {}, expectations: [{ kind: 'ROW_COUNT_AT_LEAST', count: 1 }] }],
      ['a page path with a parameter', pageDefinition({ parameters: { q: 'x' } })],
      ['a page path that does not start with a slash', pageDefinition({ targetPagePath: 'admin' })],
      ['an empty page path', pageDefinition({ targetPagePath: '' })],
      ['a page path of another host', pageDefinition({ targetPagePath: '//example.invalid/admin' })],
      ['a page path with a query', pageDefinition({ targetPagePath: '/admin?id=1' })],
      ['a page path with a fragment', pageDefinition({ targetPagePath: '/admin#top' })],
      ['a page path with a backslash', pageDefinition({ targetPagePath: '/\\example.invalid' })],
      ['a page path with a space', pageDefinition({ targetPagePath: '/admin page' })],
      ['a page path over the limit', pageDefinition({ targetPagePath: `/${'a'.repeat(MAX_READ_CHECK_PAGE_PATH_LENGTH)}` })],
    ] as const) {
      expect(validateControlDocument('read-check-definition', value).ok, name).toBe(false);
    }
  });

  it('builds the page URL only from a canonical path on an http(s) origin (fail-closed)', () => {
    const origin = 'http://127.0.0.1:4173';
    expect(readCheckPageUrlOf(origin, '/admin/members')).toBe(`${origin}/admin/members`);
    expect(readCheckPageUrlOf(origin, '/')).toBe(`${origin}/`);
    expect(readCheckPageUrlOf(origin, '/a%20b')).toBe(`${origin}/a%20b`);
    for (const path of ['admin', '//example.invalid/x', '/a/../b', '/a/./b', '/\\example.invalid', '/a\tb', '/会員', '/a b', '/a?b', '/a#b', '', `/${'a'.repeat(MAX_READ_CHECK_PAGE_PATH_LENGTH)}`]) {
      expect(readCheckPageUrlOf(origin, path), JSON.stringify(path)).toBeNull();
    }
    expect(readCheckPageUrlOf('ftp://127.0.0.1', '/admin')).toBeNull();
    expect(readCheckPageUrlOf('http://127.0.0.1:4173/base', '/admin')).toBeNull();
    expect(readCheckPageUrlOf('not a url', '/admin')).toBeNull();
  });
});
