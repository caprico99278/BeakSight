// PL-6a（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 8.1 の 4）: フォームの形の鍵（`src/discovery/fingerprint.ts` の `formShapeKeyOf`）。
// - 送信先・method・欄の名前の集まり・送信ボタンの語から作る。画面の path と hidden の値（CSRF の token など）を含めない。
// - 今の識別の digest とは別の鍵（識別の digest は画面の path を含むので、送った後に別の path に出た同じフォームでは違う。鍵は同じ）。
// 例の値は、匿名の値（`127.0.0.1`、`example.invalid`）だけを使う。
import { describe, expect, it } from 'vitest';
import { isSha256Fingerprint } from '../../src/core/ids.js';
import type { DiscoveredCandidate } from '../../src/discovery/candidate-contracts.js';
import { CANDIDATE_FORM_SHAPE_KEY_FORMAT, CANDIDATE_IDENTITY_DIGEST_FORMAT, computeCandidateDigests, formShapeKeyOf } from '../../src/discovery/fingerprint.js';
import { OTHER_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

const fields = [
  sampleField('csrf_token', 'hidden', { hasValue: true }),
  sampleField('name', 'text', { required: true }),
  sampleField('email', 'email'),
];
const base = sampleForm({ page: { origin: 'http://127.0.0.1:4173', path: '/members/new' }, action: sampleAction('/members'), fields, submitterText: '登録' });
const keyOf = (overrides: Partial<DiscoveredCandidate> & { readonly submitterText?: string | null }): string =>
  formShapeKeyOf(sampleForm({ page: base.page, action: base.action, fields, submitterText: '登録', ...overrides }));

describe('PL-6a: the form shape key', () => {
  it('is a sha256 digest with its own format, not the identity digest', () => {
    const key = formShapeKeyOf(base);
    expect(isSha256Fingerprint(key)).toBe(true);
    expect(key).not.toBe(computeCandidateDigests(base).identityDigest);
    expect(CANDIDATE_FORM_SHAPE_KEY_FORMAT).not.toBe(CANDIDATE_IDENTITY_DIGEST_FORMAT);
    expect(formShapeKeyOf(sampleForm({ page: base.page, action: base.action, fields, submitterText: '登録' }))).toBe(key);
  });

  it('does not include the page path, nor the values and states of the fields (the token and whether a value is present)', () => {
    const key = formShapeKeyOf(base);
    // 送った後に、送信先の path や一覧の path で同じフォームが出ても同じ鍵（識別の digest は違う）。
    const elsewhere = sampleForm({ page: { origin: base.page.origin, path: '/members' }, action: base.action, fields, submitterText: '登録' });
    expect(formShapeKeyOf(elsewhere)).toBe(key);
    expect(computeCandidateDigests(elsewhere).identityDigest).not.toBe(computeCandidateDigests(base).identityDigest);
    const refilled = [
      sampleField('csrf_token', 'hidden', { hasValue: false }),
      sampleField('name', 'text', { required: false, hasValue: true }),
      sampleField('email', 'email', { hasValue: true }),
    ];
    expect(keyOf({ fields: refilled })).toBe(key);
    // 欄の順に依らない。
    expect(keyOf({ fields: [...fields].reverse() })).toBe(key);
  });

  it('changes with the destination, the method, the method override, the field names and the submitter words', () => {
    const key = formShapeKeyOf(base);
    expect(keyOf({ action: sampleAction('/members/import') })).not.toBe(key);
    expect(keyOf({ action: sampleAction('/members', [], OTHER_ORIGIN) })).not.toBe(key);
    expect(keyOf({ action: sampleAction('/members', ['draft']) })).not.toBe(key);
    expect(keyOf({ formMethod: 'GET' })).not.toBe(key);
    expect(keyOf({ methodOverride: 'PATCH' })).not.toBe(key);
    expect(keyOf({ fields: [...fields, sampleField('nickname')] })).not.toBe(key);
    expect(keyOf({ fields: fields.filter(({ name }) => name !== 'email') })).not.toBe(key);
    expect(keyOf({ fields: [fields[0], fields[1], sampleField('email', 'text')] as never })).not.toBe(key);
    expect(keyOf({ submitterText: '検索' })).not.toBe(key);
  });
});
