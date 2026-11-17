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
      options: Array.from({ length: 50 }, (_value, index) => `v${index}`),
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
    // URL-LEN: 画面と送信先の Origin と path、form の target の長さの上限（前は 2,048・256）はない。
    const action = defs.action;
    for (const node of [defs.location, action]) {
      expect(prop(node, 'origin').maxLength).toBeUndefined();
      expect(prop(node, 'path').maxLength).toBeUndefined();
    }
    expect(prop(schema, 'target').anyOf?.[0]?.maxLength).toBeUndefined();
    // T27R-fix-1（DEF-086）: 送信ボタンの文言は持たず、送信ボタンの語の閉じた一覧の語だけ（重なりなし。enum の一致は `schema-enum-consistency`）。
    expect(prop(schema, 'submitterWords').maxItems).toBe(DISCOVERY_SUBMITTER_WORDS.length);
    expect(prop(schema, 'submitterWords').uniqueItems).toBe(true);
    expect(prop(schema, 'submitterText')).toEqual({});
    const field = defs.field;
    // LZ-2: 選択肢の値と制約の属性の値の長さの上限（前は 256・512）はない。
    expect(prop(field, 'options').anyOf?.[0]?.items?.maxLength).toBeUndefined();
    const constraints = defs.constraints;
    expect(Object.keys(constraints?.properties ?? {})).toEqual([...FIELD_CONSTRAINT_NAMES]);
    expect(constraints?.required).toEqual([...FIELD_CONSTRAINT_NAMES]);
    for (const name of FIELD_CONSTRAINT_NAMES) {
      expect(prop(constraints, name).anyOf?.[0]?.maxLength, name).toBeUndefined();
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
      'INCOMPLETE_LIMIT_REACHED', 'INCOMPLETE_PAGE_NAVIGATION_LIMIT', 'INCOMPLETE_PAGE_SUBRESOURCE_LIMIT',
      // fix round 4（通知の枠の設計書 3.2.3 の 3）: 閉じる押下の押す期間に移動を止めた画面。
      'NOTIFICATION_DISMISSAL_NAVIGATION_BLOCKED', 'SERVICE_READ_REFUSED',
      // L6/L3-1: 1 画面の進みの見張り（L0）が画面を終えた（L0 の理由と同じ名前）。
      'STAGE_UNRESPONSIVE', 'STAGE_NEVER_QUIET',
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
    // URL-LEN: 前の上限（2,048・256）より長い画面と送信先の path、form の target も受ける。
    expectValid(complete(sampleForm({
      page: { origin: 'http://127.0.0.1:4173', path: `/${'p'.repeat(2_049)}` },
      action: { origin: 'http://127.0.0.1:4173', path: `/${'a'.repeat(2_049)}`, queryNames: [] },
      target: 't'.repeat(257),
    })));
  });

  it('rejects values, tokens and labels as extra properties', () => {
    expectInvalid({ ...fullForm, value: 'x' });
    expectInvalid({ ...fullForm, fields: fullForm.fields.map((field) => ({ ...field, value: 'token' })) });
    expectInvalid({ ...fullForm, fields: fullForm.fields.map((field) => ({ ...field, labels: ['名前'] })) });
    expectInvalid({ ...fullForm, fields: [{ ...fullForm.fields[0], options: [{ value: 'a', label: 'A' }] }] });
  });

  // L13（N28・N29・N30）: 欄・選択肢・送信先の query の名前の数と、欄・query の名前の長さに上限を置かない（前は 200・50・50・256）。
  it('accepts any number of fields, option values and query names, and long names', () => {
    const longName = 'n'.repeat(300);
    const [first, , select] = fullForm.fields;
    if (first === undefined || select === undefined) throw new Error('no field');
    expectValid({
      ...fullForm,
      action: { ...fullForm.action, queryNames: Array.from({ length: 51 }, (_value, index) => `q${index}`).concat(longName) },
      fields: [
        ...Array.from({ length: 201 }, (_value, index) => ({ ...first, name: `f${index}` })),
        { ...select, name: longName, options: Array.from({ length: 51 }, (_value, index) => `v${index}`), omittedOptionCount: 0 },
      ],
    });
  });

  it('rejects values outside the closed lists', () => {
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
