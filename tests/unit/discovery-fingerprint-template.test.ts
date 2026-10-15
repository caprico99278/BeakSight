// T31b（Task 31 の設計書 3 章の「型にした識別の digest」、11 章の T31b の Blocker の判断（案 D））: 型にした識別の digest
// （`src/discovery/fingerprint.ts`。純粋）。
// - 画面の path と送信先の path で同じ値を持つ区切りの組（値がレコードの ID の形に合う組だけ。ID の形の判定は呼び出し側が渡す）ごとに、その区切りを
//   `{id}` にした digest を求める。組の数には名前つきの上限がある。
// - ID だけが違う 2 つの画面の候補で同じ。欄・method・enctype・path の ID 以外の区切りが違えば違う。今の識別の digest（版 2）は変えない。
// - シナリオの型（更新の画面の path と送信先の path の型）から、組の位置と、候補の具体的な path に戻る ID の値を決める。
// - 索引の行からの求め直しは、版 9（T31e）で索引に一覧を足してから確かめる（この部品は、索引に入れるときに親が候補の全体から求める口）。
// 例の値は、匿名の値（`127.0.0.1`）だけを使う。
import { describe, expect, it } from 'vitest';
import { isSha256Fingerprint } from '../../src/core/ids.js';
import type { DiscoveredCandidate } from '../../src/discovery/candidate-contracts.js';
import {
  CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT,
  MAX_RECORD_ID_SEGMENT_PAIRS,
  PATH_TEMPLATE_ID_SEGMENT,
  computeCandidateDigests,
  concretePathOfTemplate,
  pathTemplateOptionsOf,
  recordIdOfTemplates,
  recordIdSegmentPairOfTemplates,
  recordIdSegmentPairsOf,
  templatedIdentityDigestForRecordIdOf,
  templatedIdentityDigestOf,
  templatedIdentityDigestsOf,
} from '../../src/discovery/fingerprint.js';
import { SAMPLE_ORIGIN, sampleAction, sampleField, sampleForm } from './discovery-candidate-samples.js';

/** テストの ID の形（英数字だけ）。本物の判定は呼び出し側（`src/control/actions/action-outcome.ts`）が渡す。 */
const isTestRecordId = (value: string): boolean => /^[A-Za-z0-9]+$/u.test(value);

/** レコード `id` の更新の画面の候補。 */
const editForm = (id: string, overrides: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate => sampleForm({
  page: { origin: SAMPLE_ORIGIN, path: `/members/${id}/edit` },
  action: sampleAction(`/members/${id}`),
  methodOverride: 'PATCH',
  submitterText: '更新',
  fields: [sampleField('name'), sampleField('note', 'textarea'), sampleField('_method', 'hidden', { hasValue: true })],
  ...overrides,
});

const FORM_TEMPLATE = `/members/${PATH_TEMPLATE_ID_SEGMENT}/edit`;
const ACTION_TEMPLATE = `/members/${PATH_TEMPLATE_ID_SEGMENT}`;

/** シナリオの型で求めた、型にした識別の digest。 */
const templatedOf = (candidate: DiscoveredCandidate): string | null => {
  const pair = recordIdSegmentPairOfTemplates(FORM_TEMPLATE, ACTION_TEMPLATE);
  return pair === null ? null : templatedIdentityDigestOf(candidate, pair);
};

describe('T31b: templated identity digest of a candidate', () => {
  it('has the placeholder, a versioned format mark and a named limit of the segment pairs', () => {
    expect(PATH_TEMPLATE_ID_SEGMENT).toBe('{id}');
    expect(CANDIDATE_TEMPLATE_IDENTITY_DIGEST_FORMAT).toBe('beaksight-candidate-template-identity/1');
    expect(MAX_RECORD_ID_SEGMENT_PAIRS).toBe(8);
  });

  it('is the same for two pages of different records, while the identity digests differ', () => {
    const first = editForm('1');
    const second = editForm('20');
    expect(computeCandidateDigests(first).identityDigest).not.toBe(computeCandidateDigests(second).identityDigest);
    const digest = templatedOf(first);
    expect(digest !== null && isSha256Fingerprint(digest)).toBe(true);
    expect(templatedOf(second)).toBe(digest);
    // 今の識別の digest とも違う（型にした形は別の印）。
    expect(digest).not.toBe(computeCandidateDigests(first).identityDigest);
  });

  it.each([
    ['another field', editForm('2', { fields: [sampleField('name'), sampleField('_method', 'hidden', { hasValue: true })] })],
    ['another field type', editForm('2', {
      fields: [sampleField('name', 'email'), sampleField('note', 'textarea'), sampleField('_method', 'hidden', { hasValue: true })],
    })],
    ['another method override', editForm('2', { methodOverride: 'PUT' })],
    ['another enctype', editForm('2', { enctype: 'multipart/form-data' })],
    ['another segment of the page path', { ...editForm('2'), page: { origin: SAMPLE_ORIGIN, path: '/staff/2/edit' } }],
    ['another segment of the action path', { ...editForm('2'), action: sampleAction('/people/2') }],
    ['another query name of the action', { ...editForm('2'), action: sampleAction('/members/2', ['back']) }],
  ])('differs when the structure differs (%s)', (_label, candidate) => {
    expect(templatedOf(candidate)).not.toBe(templatedOf(editForm('1')));
  });

  it('finds the pairs of segments with the same value of the record id form, in the order of the positions, up to the limit', () => {
    expect(recordIdSegmentPairsOf(editForm('7'), isTestRecordId)).toEqual([
      // `members` も両方の path にあり、ID の形に合う（ID の形の判定は呼び出し側のもの）。
      { pageSegment: 1, actionSegment: 1 },
      { pageSegment: 2, actionSegment: 2 },
    ]);
    // ID の形に合わない値（空、記号）は拾わない。送信先がない候補は組がない。
    expect(recordIdSegmentPairsOf(editForm('a-b'), isTestRecordId)).toEqual([{ pageSegment: 1, actionSegment: 1 }]);
    expect(recordIdSegmentPairsOf({ ...editForm('7'), action: null }, isTestRecordId)).toEqual([]);
    const many = Array.from({ length: MAX_RECORD_ID_SEGMENT_PAIRS + 2 }, (_unused, index) => `s${index}`).join('/');
    const crowded = { ...editForm('7'), page: { origin: SAMPLE_ORIGIN, path: `/${many}` }, action: sampleAction(`/${many}`) };
    expect(recordIdSegmentPairsOf(crowded, isTestRecordId)).toHaveLength(MAX_RECORD_ID_SEGMENT_PAIRS);
  });

  it('lists the templated digests of every pair (sorted, without duplicates), and the list has the digest of the scenario template', () => {
    const digests = templatedIdentityDigestsOf(editForm('7'), isTestRecordId);
    expect(digests).toHaveLength(2);
    expect([...digests].sort()).toEqual(digests);
    expect(digests).toContain(templatedOf(editForm('7')));
    // 別のレコードの画面の一覧も、シナリオの型の digest を持つ（`members` の区切りを `{id}` にした digest は、ID の区切りの値で違う）。
    const other = templatedIdentityDigestsOf(editForm('8'), isTestRecordId);
    expect(other).toContain(templatedOf(editForm('7')));
    expect(other).not.toEqual(digests);
    expect(Object.isFrozen(digests)).toBe(true);
  });

  it('returns null for a pair outside the paths or of segments with different values', () => {
    expect(templatedIdentityDigestOf(editForm('7'), { pageSegment: 9, actionSegment: 2 })).toBeNull();
    expect(templatedIdentityDigestOf(editForm('7'), { pageSegment: 3, actionSegment: 2 })).toBeNull();
    expect(templatedIdentityDigestOf({ ...editForm('7'), action: null }, { pageSegment: 2, actionSegment: 2 })).toBeNull();
  });
});

describe('T31b: the pair and the record id of the scenario templates', () => {
  it('finds the position of the placeholder in each template (exactly one, a whole segment)', () => {
    expect(recordIdSegmentPairOfTemplates(FORM_TEMPLATE, ACTION_TEMPLATE)).toEqual({ pageSegment: 2, actionSegment: 2 });
    expect(recordIdSegmentPairOfTemplates('/{id}/edit', '/members/{id}')).toEqual({ pageSegment: 1, actionSegment: 2 });
    for (const [form, action] of [
      ['/members/edit', ACTION_TEMPLATE],
      [FORM_TEMPLATE, '/members'],
      ['/members/{id}/{id}', ACTION_TEMPLATE],
      ['/members/x{id}/edit', ACTION_TEMPLATE],
      [FORM_TEMPLATE, '/members/{id}.json'],
    ]) {
      expect(recordIdSegmentPairOfTemplates(form ?? '', action ?? ''), `${form} ${action}`).toBeNull();
    }
  });

  it('returns the record id when both templates give back the paths of the candidate with the same value', () => {
    expect(recordIdOfTemplates(editForm('42'), FORM_TEMPLATE, ACTION_TEMPLATE)).toBe('42');
    // 片方だけ戻る、2 つで違う値、区切りの数が違う、送信先がない、は null。
    expect(recordIdOfTemplates(editForm('42'), '/staff/{id}/edit', ACTION_TEMPLATE)).toBeNull();
    expect(recordIdOfTemplates({ ...editForm('42'), action: sampleAction('/members/43') }, FORM_TEMPLATE, ACTION_TEMPLATE)).toBeNull();
    expect(recordIdOfTemplates(editForm('42'), '/members/{id}', ACTION_TEMPLATE)).toBeNull();
    expect(recordIdOfTemplates({ ...editForm('42'), action: null }, FORM_TEMPLATE, ACTION_TEMPLATE)).toBeNull();
    expect(recordIdOfTemplates(editForm('42'), '/members/{id}/{id}', ACTION_TEMPLATE)).toBeNull();
  });
});

// T31h-1（Task 31 の設計書 3 章の「UPDATE の指定」。T31h-1 の Blocker の判断（案 B））: 候補から作れる path の型の組の一覧。画面が、候補の具体的な
// path から ID の区切りを選んで型を作るための口（`'{id}'` を画面に書き写さない）。組の列挙は `recordIdSegmentPairsOf` と同じ。
describe('T31h-1: the path template options of a candidate', () => {
  it('lists, for each pair of the same segments of the record id form, the two templates and the record id, in the order of the pairs', () => {
    expect(pathTemplateOptionsOf(editForm('7'), isTestRecordId)).toEqual([
      { formPathTemplate: `/${PATH_TEMPLATE_ID_SEGMENT}/7/edit`, actionPathTemplate: `/${PATH_TEMPLATE_ID_SEGMENT}/7`, recordId: 'members' },
      { formPathTemplate: FORM_TEMPLATE, actionPathTemplate: ACTION_TEMPLATE, recordId: '7' },
    ]);
    expect(Object.isFrozen(pathTemplateOptionsOf(editForm('7'), isTestRecordId))).toBe(true);
  });

  it('gives templates that the scenario template functions give back to the candidate paths with the same record id', () => {
    for (const option of pathTemplateOptionsOf(editForm('42'), isTestRecordId)) {
      expect(recordIdOfTemplates(editForm('42'), option.formPathTemplate, option.actionPathTemplate)).toBe(option.recordId);
      const pair = recordIdSegmentPairOfTemplates(option.formPathTemplate, option.actionPathTemplate);
      expect(pair === null ? null : templatedIdentityDigestOf(editForm('42'), pair)).not.toBeNull();
    }
  });

  it('uses the record id judgement of the caller, has no option without an action, and keeps the limit of the pairs', () => {
    expect(pathTemplateOptionsOf(editForm('a-b'), isTestRecordId).map(({ recordId }) => recordId)).toEqual(['members']);
    expect(pathTemplateOptionsOf(editForm('7'), () => false)).toEqual([]);
    expect(pathTemplateOptionsOf({ ...editForm('7'), action: null }, isTestRecordId)).toEqual([]);
    const many = Array.from({ length: MAX_RECORD_ID_SEGMENT_PAIRS + 2 }, (_unused, index) => `s${index}`).join('/');
    const crowded = { ...editForm('7'), page: { origin: SAMPLE_ORIGIN, path: `/${many}` }, action: sampleAction(`/${many}`) };
    expect(pathTemplateOptionsOf(crowded, isTestRecordId)).toHaveLength(MAX_RECORD_ID_SEGMENT_PAIRS);
  });

  it('leaves out a pair whose templates do not give back the paths (a placeholder text already in the path)', () => {
    const odd = { ...editForm('7'), page: { origin: SAMPLE_ORIGIN, path: `/members/7/${PATH_TEMPLATE_ID_SEGMENT}` } };
    expect(pathTemplateOptionsOf(odd, isTestRecordId).map(({ recordId }) => recordId)).toEqual([]);
  });
});

// CCX-28（T31f の共通化の候補 1）: 型に ID を入れる純粋な関数（`concretePathOfTemplate`）。型の `{id}` の区切り（ちょうど 1 つ、区切りの全体）を
// ID にした具体的な path。型の形が違う、ID が空か区切りの `/` を含むときは null。ID の形（登録の ID として使える形）の判定は呼び出し側が行う。
describe('CCX-28: the concrete path of a template', () => {
  it('puts the record id into the {id} segment of a template', () => {
    expect(concretePathOfTemplate(FORM_TEMPLATE, '42')).toBe('/members/42/edit');
    expect(concretePathOfTemplate(ACTION_TEMPLATE, 'rec_42-a')).toBe('/members/rec_42-a');
    expect(concretePathOfTemplate(`/${PATH_TEMPLATE_ID_SEGMENT}`, '7')).toBe('/7');
  });

  it('returns the concrete paths of the candidate with the record id of the templates (round trip)', () => {
    const candidate = editForm('5');
    const recordId = recordIdOfTemplates(candidate, FORM_TEMPLATE, ACTION_TEMPLATE);
    expect(recordId).toBe('5');
    expect(concretePathOfTemplate(FORM_TEMPLATE, recordId ?? '')).toBe(candidate.page.path);
    expect(concretePathOfTemplate(ACTION_TEMPLATE, recordId ?? '')).toBe(candidate.action?.path);
  });

  it.each<readonly [string, string, string]>([
    ['a template without {id}', '/members/new', '42'],
    ['a template with {id} twice', `/members/${PATH_TEMPLATE_ID_SEGMENT}/${PATH_TEMPLATE_ID_SEGMENT}`, '42'],
    ['a template with {id} inside a segment', `/members/x${PATH_TEMPLATE_ID_SEGMENT}`, '42'],
    ['an empty record id', FORM_TEMPLATE, ''],
    ['a record id with a path separator', FORM_TEMPLATE, '4/2'],
  ])('returns null for %s', (_label, template, recordId) => {
    expect(concretePathOfTemplate(template, recordId)).toBeNull();
  });
});

// T31i（T31g-2 の共通化の候補）: 具体的な画面の候補から、対象のレコードの ID と同じ値の区切りの組で型にした識別の digest を求める口（ワーカーの
// 書き込みの流れとテストが使う）。組がちょうど 1 つのときだけ。0 や 2 つ以上は null（どの区切りが ID か決められない。止める側）。
describe('T31i: the templated identity digest for a record id', () => {
  it('is the templated digest of the scenario templates when exactly one pair has the record id', () => {
    expect(templatedIdentityDigestForRecordIdOf(editForm('7'), '7')).toBe(templatedOf(editForm('7')));
    expect(templatedIdentityDigestForRecordIdOf(editForm('20'), '20')).toBe(templatedOf(editForm('7')));
  });

  it.each([
    ['no segment with the record id', editForm('7'), '8'],
    ['two pairs with the record id', { ...editForm('7'), page: { origin: SAMPLE_ORIGIN, path: '/members/7/edit/7' } }, '7'],
    ['no action', { ...editForm('7'), action: null }, '7'],
    ['an empty record id', editForm('7'), ''],
  ] as const)('is null for %s', (_label, candidate, recordId) => {
    expect(templatedIdentityDigestForRecordIdOf(candidate, recordId)).toBeNull();
  });
});
