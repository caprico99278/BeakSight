// T27a（Task 27 の設計書 4.4）: 発見の候補の 2 つの digest（識別と入力規則）の検査。
// - トークン（hidden の値）が変わっても、値があるかが変わっても、JS の結び付きや分類の入力でない項目が変わっても、どちらも同じ。
// - 名前のある欄を足すと、識別も規則も変わる。制約・必須・選択肢だけを変えると、規則だけが変わる。
// - 欄の順と選択肢の順に依らない。同じ form の 2 つの送信ボタンは、違う識別。
// - 値と label を入れない（候補の型にない項目を足しても digest は変わらない。digest の入力は、型の項目だけ）。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import { isSha256Fingerprint } from '../../src/core/ids.js';
import type { DiscoveredCandidate } from '../../src/discovery/candidate-contracts.js';
import { CANDIDATE_IDENTITY_DIGEST_FORMAT, CANDIDATE_RULE_DIGEST_FORMAT, computeCandidateDigests } from '../../src/discovery/fingerprint.js';
import {
  NO_CONSTRAINTS,
  NO_JS_BINDING,
  OTHER_ORIGIN,
  SAMPLE_ORIGIN,
  sampleAction,
  sampleButton,
  sampleField,
  sampleForm,
} from './discovery-candidate-samples.js';

const baseFields = [
  sampleField('csrf_token', 'hidden', { hasValue: true }),
  sampleField('name', 'text', { required: true, constraints: { ...NO_CONSTRAINTS, maxlength: '40' } }),
  sampleField('category', 'select-one', { options: ['', 'fruit', 'veg'] }),
];
const base = sampleForm({ fields: baseFields, submitterText: '登録' });

const digestsOf = (candidate: DiscoveredCandidate) => computeCandidateDigests(candidate);

describe('T27a: candidate digests', () => {
  it('returns two sha256 digests that differ from each other', () => {
    const { identityDigest, ruleDigest } = digestsOf(base);
    expect(isSha256Fingerprint(identityDigest)).toBe(true);
    expect(isSha256Fingerprint(ruleDigest)).toBe(true);
    expect(identityDigest).not.toBe(ruleDigest);
    // 同じ入力は、いつも同じ digest。
    expect(digestsOf(sampleForm({ fields: baseFields, submitterText: '登録' }))).toEqual(digestsOf(base));
  });

  it('keeps both digests when only the values change (tokens, prefilled values, value presence)', () => {
    // 候補は値を持たない。読み込み直しで変わるのは「値があるか」だけで、digest には入れない。
    const reloaded = sampleForm({
      fields: [
        sampleField('csrf_token', 'hidden', { hasValue: false }),
        sampleField('name', 'text', { required: true, constraints: { ...NO_CONSTRAINTS, maxlength: '40' }, hasValue: true }),
        sampleField('category', 'select-one', { options: ['', 'fruit', 'veg'], hasValue: true }),
      ],
      submitterText: '登録',
    });
    expect(digestsOf(reloaded)).toEqual(digestsOf(base));
  });

  it('ignores values and labels even if a caller passes them (only the contract fields are read)', () => {
    const withSecrets = {
      ...base,
      value: 'token-value-marker',
      label: 'label-marker',
      fields: base.fields.map((field) => ({ ...field, value: 'token-value-marker', labels: ['label-marker'], optionLabels: ['果物'] })),
    } as unknown as DiscoveredCandidate;
    expect(digestsOf(withSecrets)).toEqual(digestsOf(base));
  });

  it('keeps both digests when the order of the fields or of the options changes', () => {
    const reordered = sampleForm({
      fields: [
        sampleField('category', 'select-one', { options: ['veg', '', 'fruit'] }),
        baseFields[1] ?? sampleField('missing'),
        baseFields[0] ?? sampleField('missing'),
      ],
      submitterText: '登録',
    });
    expect(digestsOf(reordered)).toEqual(digestsOf(base));
  });

  it('changes both digests when a named field is added', () => {
    const added = sampleForm({ fields: [...baseFields, sampleField('note', 'textarea')], submitterText: '登録' });
    const before = digestsOf(base);
    const after = digestsOf(added);
    expect(after.identityDigest).not.toBe(before.identityDigest);
    expect(after.ruleDigest).not.toBe(before.ruleDigest);
  });

  it('ignores unnamed fields (they are not submitted)', () => {
    expect(digestsOf(sampleForm({ fields: [...baseFields, sampleField('')], submitterText: '登録' }))).toEqual(digestsOf(base));
  });

  it('changes only the rule digest when only the constraints, the flags or the option values change', () => {
    const before = digestsOf(base);
    const changes: readonly DiscoveredCandidate[] = [
      sampleForm({ fields: [baseFields[0] ?? sampleField('x'),
        sampleField('name', 'text', { required: true, constraints: { ...NO_CONSTRAINTS, maxlength: '80' } }), baseFields[2] ?? sampleField('x')],
      submitterText: '登録' }),
      sampleForm({ fields: [baseFields[0] ?? sampleField('x'),
        sampleField('name', 'text', { required: false, constraints: { ...NO_CONSTRAINTS, maxlength: '40' } }), baseFields[2] ?? sampleField('x')],
      submitterText: '登録' }),
      sampleForm({ fields: [baseFields[0] ?? sampleField('x'), baseFields[1] ?? sampleField('x'),
        sampleField('category', 'select-one', { options: ['', 'fruit', 'veg', 'meat'] })], submitterText: '登録' }),
      sampleForm({ fields: [baseFields[0] ?? sampleField('x'), baseFields[1] ?? sampleField('x'),
        sampleField('category', 'select-one', { options: ['', 'fruit', 'veg'], omittedOptionCount: 3 })], submitterText: '登録' }),
      sampleForm({ fields: [baseFields[0] ?? sampleField('x'), baseFields[1] ?? sampleField('x'),
        sampleField('category', 'select-one', { options: ['', 'fruit', 'veg'], disabled: true })], submitterText: '登録' }),
      sampleForm({ fields: [sampleField('csrf_token', 'hidden', { hasValue: true, readonly: true }), baseFields[1] ?? sampleField('x'),
        baseFields[2] ?? sampleField('x')], submitterText: '登録' }),
    ];
    for (const changed of changes) {
      const after = digestsOf(changed);
      expect(after.identityDigest).toBe(before.identityDigest);
      expect(after.ruleDigest).not.toBe(before.ruleDigest);
    }
  });

  it('changes the identity digest for a different screen, method, action, field type or submit button', () => {
    const before = digestsOf(base).identityDigest;
    const changes: readonly DiscoveredCandidate[] = [
      { ...base, page: { origin: SAMPLE_ORIGIN, path: '/other' } },
      { ...base, page: { origin: OTHER_ORIGIN, path: '/page' } },
      { ...base, formMethod: 'GET' },
      { ...base, methodOverride: 'PATCH' },
      { ...base, action: sampleAction('/other-action') },
      { ...base, action: sampleAction('/action', [], OTHER_ORIGIN) },
      { ...base, action: sampleAction('/action', ['mode']) },
      { ...base, fields: [baseFields[0] ?? sampleField('x'), sampleField('name', 'email'), baseFields[2] ?? sampleField('x')] },
      // 同じ form の 2 つの送信ボタン（`登録` と `下書き保存`）は、語の組が違うので、違う候補（T27R-fix-1: 文言ではなく、分類の語で比べる）。
      sampleForm({ fields: baseFields, submitterText: '下書き保存' }),
      sampleForm({ fields: baseFields, submitterText: null }),
      { ...base, kind: 'BUTTON' },
    ];
    for (const changed of changes) {
      expect(digestsOf(changed).identityDigest).not.toBe(before);
    }
  });

  it('keeps both digests when only the JS bindings, the enctype, the target or the incomplete reasons change', () => {
    const before = digestsOf(base);
    for (const changed of [
      { ...base, jsBinding: { ...NO_JS_BINDING, form: ['submit' as const] } },
      { ...base, enctype: 'multipart/form-data' as const },
      { ...base, target: '_blank' },
      { ...base, incompleteReasons: ['INCOMPLETE_SETTLE_TIMEOUT' as const] },
    ]) {
      expect(digestsOf(changed)).toEqual(before);
    }
  });

  it('keeps the order of the query names out of the identity, and keeps the identity of buttons outside forms stable', () => {
    expect(digestsOf({ ...base, action: sampleAction('/action', ['b', 'a']) }).identityDigest)
      .toBe(digestsOf({ ...base, action: sampleAction('/action', ['a', 'b']) }).identityDigest);
    expect(digestsOf(sampleButton({ submitterText: '保存' }))).toEqual(digestsOf(sampleButton({ submitterText: '保存' })));
    expect(digestsOf(sampleButton({ submitterText: '保存' })).identityDigest)
      .not.toBe(digestsOf(sampleButton({ submitterText: '削除' })).identityDigest);
  });

  it('keeps the identity digest when only the row text of a button differs and its classification words are the same (T27R-fix-1, DEF-086)', () => {
    const editRowA = digestsOf(sampleButton({ submitterText: '山田 太郎 を編集' })).identityDigest;
    expect(digestsOf(sampleButton({ submitterText: '佐藤 花子 を編集' })).identityDigest).toBe(editRowA);
    expect(digestsOf(sampleForm({ submitterText: '注文 A-1 を削除' })).identityDigest).toBe(digestsOf(sampleForm({ submitterText: '削除' })).identityDigest);
    // 語のない文言は、行が違っても、ボタンのない form と同じ（語の空の一覧）。
    expect(digestsOf(sampleButton({ submitterText: '山田 太郎' })).identityDigest).toBe(digestsOf(sampleButton({ submitterText: null })).identityDigest);
    // 語の組が違えば、違う候補。
    expect(digestsOf(sampleButton({ submitterText: '山田 太郎 を削除' })).identityDigest).not.toBe(editRowA);
    // 識別の digest の入力の形を変えたので、版を上げた。
    expect(CANDIDATE_IDENTITY_DIGEST_FORMAT).toBe('beaksight-candidate-identity/2');
    expect(CANDIDATE_RULE_DIGEST_FORMAT).toBe('beaksight-candidate-rules/1');
  });

  it('does not change its input', () => {
    const before = JSON.stringify(base);
    digestsOf(base);
    expect(JSON.stringify(base)).toBe(before);
  });
});
