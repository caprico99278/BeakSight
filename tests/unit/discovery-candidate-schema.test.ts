// T27a（Task 27 の設計書 4.1）: 候補の契約（`src/discovery/candidate-contracts.ts`）と JSON Schema（`schemas/control/candidate.schema.json`）の
// 一致の検査。
// - スキーマの上限は、契約の名前つきの定数と一致する。閉じた一覧の enum の一致は `schema-enum-consistency.test.ts` の対応表。
// - 分類と指紋をかけた候補（成果物 `discovery.json` の候補の形）がスキーマに通る。値・トークン・label の項目、上限を超えた選択肢、
//   閉じた一覧の外の値、form の外のボタンの送信先などは拒まれる。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_SCHEMA_NAMES, validateControlDocument } from '../../src/control/control-schema-validator.js';
import { MAX_URL_LENGTH } from '../../src/core/limits.js';
import {
  CANDIDATE_CLASSIFICATIONS,
  CANDIDATE_FIELD_TAGS,
  CANDIDATE_FIELD_TYPES,
  CANDIDATE_KINDS,
  CANDIDATE_REASON_CODES,
  FIELD_CONSTRAINT_NAMES,
  FORM_ENCTYPES,
  FORM_METHODS,
  INCOMPLETE_REASONS,
  LISTENER_KINDS,
  MAX_ACTION_QUERY_NAMES,
  MAX_CANDIDATE_FIELDS,
  MAX_CANDIDATE_URL_PART_LENGTH,
  MAX_CONSTRAINT_VALUE_LENGTH,
  MAX_FIELD_NAME_LENGTH,
  MAX_FORM_TARGET_LENGTH,
  MAX_OPTION_VALUE_LENGTH,
  MAX_SELECT_OPTION_VALUES,
  MAX_SUBMITTER_TEXT_LENGTH,
  METHOD_OVERRIDE_FIELD_NAME,
  METHOD_OVERRIDE_VALUES,
  UNSENDABLE_FIELD_TYPES,
  isUnsendableFieldType,
  type DiscoveredCandidate,
  type DiscoveryCandidate,
} from '../../src/discovery/candidate-contracts.js';
import { DISCOVERY_SUBMITTER_WORDS } from '../../src/discovery/classification-words.js';
import { classifyCandidate } from '../../src/discovery/classify.js';
import { computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import {
  NO_CONSTRAINTS,
  NO_JS_BINDING,
  SAMPLE_ALLOWED_ORIGINS,
  sampleButton,
  sampleField,
  sampleForm,
} from './discovery-candidate-samples.js';

const CANDIDATE_SCHEMA_PATH = resolve(process.cwd(), 'schemas', 'control', 'candidate.schema.json');
const CANDIDATE_SCHEMA_ID = 'urn:beaksight:schema:control:candidate:1';

type JsonSchema = Record<string, unknown> & {
  readonly properties?: Record<string, JsonSchema>;
  readonly $defs?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
};

const schema = JSON.parse(readFileSync(CANDIDATE_SCHEMA_PATH, 'utf8')) as JsonSchema;
const defs = schema.$defs ?? {};
const prop = (node: JsonSchema | undefined, key: string): JsonSchema => node?.properties?.[key] ?? {};

/** 分類と指紋をかけた、成果物の候補。 */
const complete = (candidate: DiscoveredCandidate): DiscoveryCandidate => ({
  ...candidate,
  ...classifyCandidate(candidate, { allowedOrigins: SAMPLE_ALLOWED_ORIGINS }),
  ...computeCandidateDigests(candidate),
});

const fullForm = complete(sampleForm({
  formMethod: 'GET',
  action: { origin: 'http://127.0.0.1:4173', path: '/search/results', queryNames: ['lang'] },
  fields: [
    sampleField('csrf_token', 'hidden', { hasValue: true }),
    sampleField('q', 'search', { required: true, constraints: { ...NO_CONSTRAINTS, pattern: '[^<>]*', maxlength: '50' } }),
    sampleField('category', 'select-one', {
      options: Array.from({ length: MAX_SELECT_OPTION_VALUES }, (_value, index) => `v${index}`),
      omittedOptionCount: 2,
      hasValue: true,
    }),
    sampleField('in_stock', 'checkbox', { options: ['1'] }),
  ],
  submitterText: '検索',
  incompleteReasons: ['INCOMPLETE_SETTLE_TIMEOUT'],
}));
const fullButton = complete(sampleButton({ submitterText: '保存', jsBinding: { ...NO_JS_BINDING, submitter: ['click'], document: ['click'] } }));

const expectValid = (value: unknown): void => {
  const result = validateControlDocument('candidate', value);
  expect(result.ok ? [] : result.errors).toEqual([]);
};
const expectInvalid = (value: unknown): void => {
  expect(validateControlDocument('candidate', value).ok).toBe(false);
};

describe('T27a: the candidate schema and the contract constants', () => {
  it('is registered as a control schema with its id', () => {
    expect(CONTROL_SCHEMA_NAMES).toContain('candidate');
    expect(schema.$id).toBe(CANDIDATE_SCHEMA_ID);
  });

  it('uses the named limits of the contract', () => {
    expect(MAX_SELECT_OPTION_VALUES).toBe(50);
    expect(MAX_CANDIDATE_URL_PART_LENGTH).toBe(MAX_URL_LENGTH);
    const location = defs.location;
    expect(prop(location, 'origin').maxLength).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    expect(prop(location, 'path').maxLength).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    const action = defs.action;
    expect(prop(action, 'origin').maxLength).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    expect(prop(action, 'path').maxLength).toBe(MAX_CANDIDATE_URL_PART_LENGTH);
    expect(prop(action, 'queryNames').maxItems).toBe(MAX_ACTION_QUERY_NAMES);
    expect(prop(action, 'queryNames').items?.maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect(prop(schema, 'fields').maxItems).toBe(MAX_CANDIDATE_FIELDS);
    // T27R-fix-1（DEF-086）: 送信ボタンの文言は持たず、送信ボタンの語の閉じた一覧の語だけ（重なりなし。enum の一致は `schema-enum-consistency`）。
    expect(prop(schema, 'submitterWords').maxItems).toBe(DISCOVERY_SUBMITTER_WORDS.length);
    expect(prop(schema, 'submitterWords').uniqueItems).toBe(true);
    expect(prop(schema, 'submitterText')).toEqual({});
    expect(prop(schema, 'target').anyOf?.[0]?.maxLength).toBe(MAX_FORM_TARGET_LENGTH);
    const field = defs.field;
    expect(prop(field, 'name').maxLength).toBe(MAX_FIELD_NAME_LENGTH);
    expect(prop(field, 'options').anyOf?.[0]?.maxItems).toBe(MAX_SELECT_OPTION_VALUES);
    expect(prop(field, 'options').anyOf?.[0]?.items?.maxLength).toBe(MAX_OPTION_VALUE_LENGTH);
    const constraints = defs.constraints;
    expect(Object.keys(constraints?.properties ?? {})).toEqual([...FIELD_CONSTRAINT_NAMES]);
    expect(constraints?.required).toEqual([...FIELD_CONSTRAINT_NAMES]);
    for (const name of FIELD_CONSTRAINT_NAMES) {
      expect(prop(constraints, name).anyOf?.[0]?.maxLength, name).toBe(MAX_CONSTRAINT_VALUE_LENGTH);
    }
    const binding = defs.jsBinding;
    expect(binding?.required).toEqual(['form', 'submitter', 'ancestor', 'document', 'window', 'inlineHandler']);
  });

  it('keeps the closed lists frozen and without duplicates', () => {
    for (const values of [CANDIDATE_KINDS, CANDIDATE_CLASSIFICATIONS, CANDIDATE_REASON_CODES, FORM_METHODS, METHOD_OVERRIDE_VALUES,
      FORM_ENCTYPES, CANDIDATE_FIELD_TAGS, CANDIDATE_FIELD_TYPES, LISTENER_KINDS, INCOMPLETE_REASONS, FIELD_CONSTRAINT_NAMES]) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(new Set<string>(values).size).toBe(values.length);
    }
    expect(CANDIDATE_KINDS).toEqual(['FORM', 'BUTTON']);
    expect(CANDIDATE_CLASSIFICATIONS).toEqual([
      'READ', 'CREATE', 'UPDATE', 'NOT_EXECUTABLE', 'NEEDS_BINDING', 'UNSUPPORTED_READ_TRANSPORT', 'BLOCKED_EXTERNAL', 'DISPLAY_ONLY',
    ]);
    expect(METHOD_OVERRIDE_VALUES).toEqual(['PUT', 'PATCH', 'DELETE']);
    // T27b: 凍結の条件、読み取りの失敗、上限の 3 つを足した。T37a: サービスの読み取りが届かなかった画面（`SERVICE_READ_REFUSED`）を足した。
    // DEF-129: ページが始めた main frame の読み込みを上限で止めた画面（`INCOMPLETE_PAGE_NAVIGATION_LIMIT`）を足した。
    // DEF-130-fix: ページが出す文書でない要求を上限で止めた画面（`INCOMPLETE_PAGE_SUBRESOURCE_LIMIT`）を足した。
    expect(INCOMPLETE_REASONS).toEqual([
      'INCOMPLETE_SETTLE_TIMEOUT', 'INCOMPLETE_FRAME_OR_CLOSED_SHADOW', 'INCOMPLETE_FREEZE_UNAVAILABLE', 'INCOMPLETE_READ_FAILED',
      'INCOMPLETE_LIMIT_REACHED', 'INCOMPLETE_PAGE_NAVIGATION_LIMIT', 'INCOMPLETE_PAGE_SUBRESOURCE_LIMIT', 'SERVICE_READ_REFUSED',
    ]);
    expect(METHOD_OVERRIDE_FIELD_NAME).toBe('_method');
  });

  // DEF-094: 値を送れない欄の型（閉じた一覧）。欄の型の一覧の部分で、ほかの型は送れる型。
  it('has the closed list of the field types whose value is never sent (DEF-094)', () => {
    expect(UNSENDABLE_FIELD_TYPES).toEqual(['password', 'file']);
    expect(Object.isFrozen(UNSENDABLE_FIELD_TYPES)).toBe(true);
    for (const type of CANDIDATE_FIELD_TYPES) {
      expect(isUnsendableFieldType(type), type).toBe(type === 'password' || type === 'file');
    }
  });

  it('has no property that could hold a value, a token or an option label', () => {
    const names = JSON.stringify(schema).match(/"[A-Za-z]+"\s*:/gu) ?? [];
    for (const forbidden of ['"value":', '"values":', '"label":', '"labels":', '"token":', '"optionLabels":']) {
      expect(names, forbidden).not.toContain(forbidden);
    }
  });
});

describe('T27a: candidate schema validation', () => {
  it('accepts classified and fingerprinted candidates (a form and a button)', () => {
    expectValid(fullForm);
    expectValid(fullButton);
    expectValid(complete(sampleForm({ formMethod: 'POST', methodOverride: 'DELETE', submitterText: null })));
    expectValid(complete(sampleForm({ formMethod: 'DIALOG', enctype: 'text/plain', target: null })));
  });

  it('rejects values, tokens and labels as extra properties', () => {
    expectInvalid({ ...fullForm, value: 'x' });
    expectInvalid({ ...fullForm, fields: fullForm.fields.map((field) => ({ ...field, value: 'token' })) });
    expectInvalid({ ...fullForm, fields: fullForm.fields.map((field) => ({ ...field, labels: ['名前'] })) });
    expectInvalid({ ...fullForm, fields: [{ ...fullForm.fields[0], options: [{ value: 'a', label: 'A' }] }] });
  });

  it('rejects more option values than the limit, and values outside the closed lists', () => {
    const tooMany = Array.from({ length: MAX_SELECT_OPTION_VALUES + 1 }, (_value, index) => `v${index}`);
    expectInvalid({ ...fullForm, fields: [{ ...fullForm.fields[0], options: tooMany }] });
    expectInvalid({ ...fullForm, fields: [{ ...fullForm.fields[0], omittedOptionCount: -1 }] });
    expectInvalid({ ...fullForm, classification: 'DELETE' });
    expectInvalid({ ...fullForm, reasonCode: 'SOMETHING' });
    expectInvalid({ ...fullForm, kind: 'LINK' });
    expectInvalid({ ...fullForm, formMethod: 'get' });
    expectInvalid({ ...fullForm, methodOverride: 'POST' });
    expectInvalid({ ...fullForm, enctype: 'application/json' });
    expectInvalid({ ...fullForm, fields: [{ ...fullForm.fields[0], type: 'submit' }] });
    expectInvalid({ ...fullForm, jsBinding: { ...fullForm.jsBinding, document: ['focus'] } });
    expectInvalid({ ...fullForm, jsBinding: { ...fullForm.jsBinding, document: ['click', 'click'] } });
    expectInvalid({ ...fullForm, incompleteReasons: ['INCOMPLETE_SETTLE_TIMEOUT', 'INCOMPLETE_SETTLE_TIMEOUT'] });
    expectInvalid({ ...fullForm, identityDigest: 'not-a-digest' });
    // T27R-fix-1（DEF-086）: 文言の項目と、閉じた一覧の外の語（表の行の中身など）と、重なった語は拒む。
    expectInvalid({ ...fullForm, submitterText: '検索' });
    expectInvalid({ ...fullForm, submitterWords: ['山田 太郎 を編集'] });
    expectInvalid({ ...fullForm, submitterWords: ['検索', '検索'] });
    expectInvalid({ ...fullForm, submitterWords: null });
    expectInvalid({ ...fullForm, submitterWords: 'x'.repeat(MAX_SUBMITTER_TEXT_LENGTH + 1) });
    expectInvalid({ ...fullForm, page: { origin: 'http://127.0.0.1:4173', path: 'no-leading-slash' } });
  });

  it('rejects a form without a method or an action, and a button outside a form with form properties', () => {
    expectInvalid({ ...fullForm, formMethod: null });
    expectInvalid({ ...fullForm, action: null });
    expectInvalid({ ...fullForm, enctype: null });
    expectInvalid({ ...fullButton, formMethod: 'POST' });
    expectInvalid({ ...fullButton, action: { origin: 'http://127.0.0.1:4173', path: '/x', queryNames: [] } });
    expectInvalid({ ...fullButton, methodOverride: 'DELETE' });
    expectInvalid({ ...fullButton, enctype: 'text/plain' });
    expectInvalid({ ...fullButton, fields: fullForm.fields });
  });
});
