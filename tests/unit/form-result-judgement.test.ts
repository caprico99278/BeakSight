// PL-6a（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 8.1。調査 FV-0 の実験の 45 場面）: フォームの書き込みの結果の判定を、人が入れる
// 条件（path の前方一致と CSS セレクタ）から、構造の判定 (b2) に変えた純粋な部品（`src/control/actions/action-outcome.ts`）の確かめ。
// - 判定の順（登録・更新とも）: 4xx は入力の誤り（429 は今どおり）、5xx・応答なしは結果が分からない。2xx・3xx は照合（登録は答え合わせの READ、更新は
//   更新の後の照合）で決め、一致しないときは、送った値を保った同じ「フォームの形」がもう一度出たときだけ入力の誤り。ほかは判定できない。
// - 4xx の扱いは、API の判定（`apiResponseJudgementOf`）と同じ部品（`errorResponseJudgementOf`）。
// - 登録の ID は、送った後の URL を ID の型（2 つまで）に当てる。ID の区切りは core の `isRecordIdLikePathSegment` だけ。押す前の URL の値と違うときだけ。
// - 送る前の確かめ（事前の READ）: 値がもう見えていれば送らない（`VALUE_ALREADY_PRESENT`）。読めなければ送らない（`VERIFICATION_READ_UNAVAILABLE`）。
// 表は FV-0 の記録（作業記録 `fv-0/rows.json`）の場面の事実を写したもの（サイトの名前・domain は持たない。127.0.0.1 の fixture と自前のサイト）。
// 受け入れ: 誤って失敗 0、事前の確かめで誤って成功 0（実験の (b2) の結果と同じ。誤って成功の 1 件は事前の確かめで送らない）。
import { describe, expect, it } from 'vitest';
import {
  CLIENT_ERROR_HTTP_STATUS_RANGE,
  SERVER_ERROR_HTTP_STATUS_RANGE,
} from '../../src/core/http-status.js';
import { PRECHECK_FAILURE_DETAILS, type ActionOutcome, type FormUpdatePostcheck } from '../../src/control/actions/action-contracts.js';
import {
  actionOutcomeOf,
  apiResponseJudgementOf,
  errorResponseJudgementOf,
  formResultJudgementOf,
  isFormStructureStatus,
  preSubmitReadStopOf,
  recordIdOfResultUrl,
} from '../../src/control/actions/action-outcome.js';
import { MAX_FORM_RECORD_ID_PATTERNS } from '../../src/control/approval/scenario-contracts.js';
import type { ReadCheckResult } from '../../src/discovery/read-check-contracts.js';

const ORIGIN = 'http://127.0.0.1:4173';
const url = (path: string): string => `${ORIGIN}${path}`;

/** FV-0 の 1 場面の事実（送った後の観察）。 */
interface Scene {
  readonly label: string;
  /** サイトで実際に登録・更新されたか（実験のサーバの記録）。 */
  readonly truth: boolean;
  /** 送信の後の main frame の最後の文書の状態（応答がなければ null）。 */
  readonly status: number | null;
  readonly before: string;
  readonly after: string;
  readonly patterns: readonly string[];
  readonly sameForm: boolean;
  readonly kept: boolean;
  /** 送る前の READ（登録だけ）と送った後の READ（応答がなければ null）。 */
  readonly readBefore: ReadCheckResult;
  readonly readAfter: ReadCheckResult | null;
  /** 更新だけ: 更新の後の照合と対象の ID。 */
  readonly update?: { readonly postcheck: FormUpdatePostcheck; readonly targetRecordId: string };
  /** 実験の (b2) と事前の確かめの結果（`結果(理由)`）。 */
  readonly expected: string;
}

const FIXTURE_CREATE = ['/members/{id}', '/members/{id}/edit'];
const FIXTURE_UPDATE = ['/members/{id}'];
const ALT_CREATE = ['/m/{id}', '/m/{id}/edit'];
const ALT_UPDATE = ['/m/{id}'];

/** 登録の場面（既定は、事前の READ は見えない、送った後の READ は一致）。 */
const create = (
  label: string,
  truth: boolean,
  status: number | null,
  before: string,
  after: string,
  patterns: readonly string[],
  facts: Partial<Pick<Scene, 'sameForm' | 'kept' | 'readBefore' | 'readAfter'>>,
  expected: string,
): Scene => ({
  label, truth, status, before: url(before), after: url(after), patterns, sameForm: false, kept: false, readBefore: 'NOT_MATCHED',
  readAfter: status === null ? null : 'MATCHED', ...facts, expected,
});

/** 更新の場面（更新の後の照合の READ は、更新が一致したときだけ読む）。 */
const updateScene = (
  label: string,
  truth: boolean,
  status: number | null,
  before: string,
  after: string,
  patterns: readonly string[],
  target: string,
  postcheck: FormUpdatePostcheck,
  facts: Partial<Pick<Scene, 'sameForm' | 'kept' | 'readAfter'>>,
  expected: string,
): Scene => ({
  label, truth, status, before: url(before), after: url(after), patterns, sameForm: false, kept: false, readBefore: 'NOT_MATCHED',
  readAfter: status !== null && postcheck === 'UPDATED' ? 'MATCHED' : null, update: { postcheck, targetRecordId: target }, ...facts, expected,
});

const NM = 'NOT_MATCHED' as const;

/** FV-0 の 45 場面（実験の記録の順）。 */
const SCENES: readonly Scene[] = [
  // fixture（tests/helpers/write-site-fixture.ts）の登録。
  create('fixture success', true, 200, '/members/new', '/members/1002', FIXTURE_CREATE, {}, 'VERIFIED(READ_VERIFICATION_MATCHED)'),
  create('fixture stay-on-form', true, 200, '/members/new', '/members/new', FIXTURE_CREATE, { sameForm: true }, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  create('fixture no-condition', true, 200, '/members/new', '/members/done', FIXTURE_CREATE, {}, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  create('fixture input-error', false, 200, '/members/new', '/members', FIXTURE_CREATE, { readAfter: NM }, 'UNKNOWN(NO_CONDITION_MATCHED)'),
  create('fixture server-error', false, 500, '/members/new', '/members', FIXTURE_CREATE, { readAfter: NM }, 'UNKNOWN(SERVER_ERROR)'),
  create('fixture no-record-id', true, 200, '/members/new', '/members/x/registered', FIXTURE_CREATE, {}, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  create('fixture unsafe-record-id', true, 200, '/members/new', '/members/a.b', FIXTURE_CREATE, {}, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  create('fixture both-conditions', true, 200, '/members/new', '/members/1007?both=1', FIXTURE_CREATE, {}, 'VERIFIED(READ_VERIFICATION_MATCHED)'),
  create('fixture read-mismatch', false, 200, '/members/new', '/members/1008', FIXTURE_CREATE, { readAfter: NM }, 'UNKNOWN(READ_VERIFICATION_NOT_MATCHED)'),
  create('fixture hang', true, null, '/members/new', '/members/new', FIXTURE_CREATE, {}, 'UNKNOWN(NO_RESPONSE)'),
  // fixture の更新。
  updateScene('fixture update success', true, 200, '/members/1010/edit', '/members/1010', FIXTURE_UPDATE, '1010', 'UPDATED', {},
    'VERIFIED(READ_VERIFICATION_MATCHED)'),
  updateScene('fixture update id-mismatch', true, 200, '/members/1011/edit', '/members/10119', FIXTURE_UPDATE, '1011', 'UPDATED', {},
    'UNKNOWN(RECORD_ID_MISMATCH)'),
  // 自前のサイト（作業記録 fv-0/alt-site.mjs）の登録。
  create('alt detail-303', true, 200, '/m/new', '/m/2002', ALT_CREATE, {}, 'VERIFIED(READ_VERIFICATION_MATCHED)'),
  create('alt edit-303', true, 200, '/m/new', '/m/2003/edit', ALT_CREATE, {}, 'VERIFIED(READ_VERIFICATION_MATCHED)'),
  create('alt list-303', true, 200, '/m/new', '/m', ALT_CREATE, {}, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  create('alt same-flash-303', true, 200, '/m/new', '/m/new', ALT_CREATE, { sameForm: true }, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  create('alt same-flash-200', true, 200, '/m/new', '/m', ALT_CREATE, { sameForm: true }, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  create('alt error-200-render', false, 200, '/m/new', '/m', ALT_CREATE, { sameForm: true, kept: true, readAfter: NM }, 'FAILED(INPUT_ERROR)'),
  create('alt error-200-render-cleared', false, 200, '/m/new', '/m', ALT_CREATE, { sameForm: true, readAfter: NM }, 'UNKNOWN(NO_CONDITION_MATCHED)'),
  create('alt error-422-render', false, 422, '/m/new', '/m', ALT_CREATE, { sameForm: true, kept: true, readAfter: NM }, 'FAILED(INPUT_ERROR)'),
  create('alt error-302-back', false, 200, '/m/new', '/m/new', ALT_CREATE, { sameForm: true, kept: true, readAfter: NM }, 'FAILED(INPUT_ERROR)'),
  create('alt error-other-page', false, 200, '/m/new', '/m', ALT_CREATE, { readAfter: NM }, 'UNKNOWN(NO_CONDITION_MATCHED)'),
  create('alt error-303-other', false, 200, '/m/new', '/m/error', ALT_CREATE, { readAfter: NM }, 'UNKNOWN(NO_CONDITION_MATCHED)'),
  create('alt server-500', false, 500, '/m/new', '/m', ALT_CREATE, { readAfter: NM }, 'UNKNOWN(SERVER_ERROR)'),
  create('alt server-500-after-create', true, 500, '/m/new', '/m', ALT_CREATE, {}, 'UNKNOWN(SERVER_ERROR)'),
  create('alt hang', true, null, '/m/new', '/m/new', ALT_CREATE, {}, 'UNKNOWN(NO_RESPONSE)'),
  // 検索が問い合わせの文字を画面に返すサイト（+echo）: 事前の READ で値が見えるので、送らない（実験の「誤って成功」の 1 件を含む）。
  create('alt detail-303 +echo', true, 200, '/m/new', '/m/2009', ALT_CREATE, { readBefore: 'MATCHED' }, 'BLOCKED(VALUE_ALREADY_PRESENT)'),
  create('alt detail-303-no-create +echo', false, 200, '/m/new', '/m/2001', ALT_CREATE, { readBefore: 'MATCHED' }, 'BLOCKED(VALUE_ALREADY_PRESENT)'),
  create('alt detail-303-no-create', false, 200, '/m/new', '/m/2001', ALT_CREATE, { readAfter: NM }, 'UNKNOWN(READ_VERIFICATION_NOT_MATCHED)'),
  create('alt error-200-render +echo', false, 200, '/m/new', '/m', ALT_CREATE, { sameForm: true, kept: true, readBefore: 'MATCHED' },
    'BLOCKED(VALUE_ALREADY_PRESENT)'),
  // 自分の画面へ送る form（+selfpost）。
  create('alt detail-303 +selfpost', true, 200, '/m/new', '/m/2010', ALT_CREATE, {}, 'VERIFIED(READ_VERIFICATION_MATCHED)'),
  create('alt error-200-render +selfpost', false, 200, '/m/new', '/m/new', ALT_CREATE, { sameForm: true, kept: true, readAfter: NM },
    'FAILED(INPUT_ERROR)'),
  create('alt same-flash-200 +selfpost', true, 200, '/m/new', '/m/new', ALT_CREATE, { sameForm: true }, 'PARTIAL(RECORD_ID_NOT_FOUND)'),
  // 答え合わせの READ の結び付けが外れたサイト（+READ外れ。メールだけで検索する）。
  create('alt detail-303 +read-unbound', true, 200, '/m/new', '/m/2012', ALT_CREATE, { readAfter: NM }, 'UNKNOWN(READ_VERIFICATION_NOT_MATCHED)'),
  create('alt same-flash-303 +read-unbound', true, 200, '/m/new', '/m/new', ALT_CREATE, { sameForm: true, readAfter: NM },
    'UNKNOWN(NO_CONDITION_MATCHED)'),
  create('alt error-200-render +read-unbound', false, 200, '/m/new', '/m', ALT_CREATE, { sameForm: true, kept: true, readAfter: NM },
    'FAILED(INPUT_ERROR)'),
  create('alt error-200-render-cleared +read-unbound', false, 200, '/m/new', '/m', ALT_CREATE, { sameForm: true, readAfter: NM },
    'UNKNOWN(NO_CONDITION_MATCHED)'),
  // 自前のサイトの更新。
  updateScene('alt u-detail-303', true, 200, '/m/2014/edit', '/m/2014', ALT_UPDATE, '2014', 'UPDATED', {}, 'VERIFIED(READ_VERIFICATION_MATCHED)'),
  updateScene('alt u-edit-flash-303', true, 200, '/m/2015/edit', '/m/2015/edit', ALT_UPDATE, '2015', 'UPDATED', { sameForm: true, kept: true },
    'VERIFIED(READ_VERIFICATION_MATCHED)'),
  updateScene('alt u-list-303', true, 200, '/m/2016/edit', '/m', ALT_UPDATE, '2016', 'UPDATED', {}, 'VERIFIED(READ_VERIFICATION_MATCHED)'),
  updateScene('alt u-error-200', false, 200, '/m/2017/edit', '/m/2017', ALT_UPDATE, '2017', 'UNCHANGED', { sameForm: true, kept: true },
    'FAILED(INPUT_ERROR)'),
  updateScene('alt u-error-422', false, 422, '/m/2018/edit', '/m/2018', ALT_UPDATE, '2018', 'UNCHANGED', { sameForm: true, kept: true },
    'FAILED(INPUT_ERROR)'),
  updateScene('alt u-error-302-back', false, 200, '/m/2019/edit', '/m/2019/edit', ALT_UPDATE, '2019', 'UNCHANGED', { sameForm: true, kept: true },
    'FAILED(INPUT_ERROR)'),
  updateScene('alt u-500', false, 500, '/m/2020/edit', '/m/2020', ALT_UPDATE, '2020', 'UNCHANGED', {}, 'UNKNOWN(SERVER_ERROR)'),
  updateScene('alt u-hang', true, null, '/m/2021/edit', '/m/2021/edit', ALT_UPDATE, '2021', 'UNDETERMINED', {}, 'UNKNOWN(NO_RESPONSE)'),
];

/** 1 場面を、ワーカーと同じ順で判定する（事前の確かめ → 送信 → ID → 照合 → 判定 → 結果）。 */
const resultOf = (scene: Scene): string => {
  if (scene.update === undefined) {
    const stop = preSubmitReadStopOf(scene.readBefore);
    if (stop !== null) {
      return `BLOCKED(${stop})`;
    }
  }
  const recordId = scene.status === null ? null : recordIdOfResultUrl(scene.patterns, scene.before, scene.after);
  const judged = formResultJudgementOf({
    httpStatus: scene.status, sameForm: scene.sameForm, sameFormKeptValues: scene.kept, recordId, readVerification: scene.readAfter,
    ...(scene.update === undefined ? {} : { update: scene.update }),
  });
  const fieldsMatched = scene.update === undefined
    ? undefined
    : { UPDATED: true, UNCHANGED: false, CHANGED_OTHERWISE: false, UNDETERMINED: null }[scene.update.postcheck];
  const outcome: ActionOutcome = actionOutcomeOf({
    submission: 'SENT', responseJudgement: judged.responseJudgement, recordId: judged.recordId, readVerification: scene.readAfter,
    ...(scene.update === undefined || fieldsMatched === undefined ? {} : { update: { targetRecordId: scene.update.targetRecordId, fieldsMatched } }),
  });
  return `${outcome.result}(${outcome.reason})`;
};

describe('PL-6a: the form result judgement (b2) on the FV-0 scenes', () => {
  it('has the 45 scenes of the experiment', () => {
    expect(SCENES).toHaveLength(45);
  });

  it.each(SCENES.map((scene) => [scene.label, scene] as const))('judges %s as in the experiment (b2 with the check before sending)', (_label, scene) => {
    expect(resultOf(scene)).toBe(scene.expected);
  });

  it('never judges a write that the site made as an input error, and never reports a success that the site did not make', () => {
    const results = SCENES.map((scene) => ({ scene, result: resultOf(scene) }));
    const falseFailures = results.filter(({ scene, result }) => scene.truth && result.startsWith('FAILED'));
    const falseSuccesses = results.filter(({ scene, result }) => !scene.truth && (result.startsWith('VERIFIED') || result.startsWith('PARTIAL')));
    expect(falseFailures.map(({ scene }) => scene.label)).toEqual([]);
    expect(falseSuccesses.map(({ scene }) => scene.label)).toEqual([]);
    // 実験の (b2) の数: 正しく決めた 26（ここでは事前の確かめで止めた 1 件を除く 25）、判定できない 18、送らない 3。
    const blocked = results.filter(({ result }) => result.startsWith('BLOCKED'));
    expect(blocked).toHaveLength(3);
  });
});

describe('PL-6a: the status part of the judgement (shared with the API judgement)', () => {
  const statuses = [100, 199, 200, 204, 299, 300, 302, 303, 304, 399, 400, 401, 404, 409, 422, 429, 451, 499, 500, 502, 503, 599, 600, 700];

  it('judges a 4xx as an input error (429 as rate limited), a 5xx as a server error, and nothing else', () => {
    expect(errorResponseJudgementOf(400)).toBe('INPUT_ERROR');
    expect(errorResponseJudgementOf(422)).toBe('INPUT_ERROR');
    expect(errorResponseJudgementOf(429)).toBe('RATE_LIMITED');
    expect(errorResponseJudgementOf(500)).toBe('SERVER_ERROR');
    for (const status of [100, 200, 303, 399, 600, Number.NaN, 4.5]) {
      expect(errorResponseJudgementOf(status)).toBeNull();
    }
  });

  it('uses the same part for the API and the form: every 4xx and 5xx gives the same judgement', () => {
    for (const status of statuses) {
      const error = errorResponseJudgementOf(status);
      const inRange = (status >= CLIENT_ERROR_HTTP_STATUS_RANGE.min && status <= CLIENT_ERROR_HTTP_STATUS_RANGE.max)
        || (status >= SERVER_ERROR_HTTP_STATUS_RANGE.min && status <= SERVER_ERROR_HTTP_STATUS_RANGE.max);
      expect(error !== null, `status ${status}`).toBe(inRange);
      if (error !== null) {
        expect(apiResponseJudgementOf(status)).toBe(error);
        for (const sameFormKeptValues of [false, true]) {
          expect(formResultJudgementOf({ httpStatus: status, sameForm: true, sameFormKeptValues, recordId: '7', readVerification: null }))
            .toEqual({ responseJudgement: error, recordId: null });
        }
      }
    }
  });

  it('judges by the structure only for a 2xx or 3xx status', () => {
    expect(statuses.filter(isFormStructureStatus)).toEqual([200, 204, 299, 300, 302, 303, 304, 399]);
    // 1xx と 600 以上は、決められない（結果が分からない）。
    for (const status of [100, 199, 600, 700]) {
      expect(formResultJudgementOf({ httpStatus: status, sameForm: false, sameFormKeptValues: false, recordId: '7', readVerification: 'MATCHED' }))
        .toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
    }
  });

  it('gives no judgement without a response', () => {
    expect(formResultJudgementOf({ httpStatus: null, sameForm: true, sameFormKeptValues: true, recordId: '7', readVerification: 'MATCHED' }))
      .toEqual({ responseJudgement: null, recordId: null });
  });
});

describe('PL-6a: the create judgement of a 2xx or 3xx response', () => {
  const judge = (facts: { readonly sameForm?: boolean; readonly kept?: boolean; readonly recordId?: string | null; readonly read: ReadCheckResult | null }) =>
    formResultJudgementOf({
      httpStatus: 200, sameForm: facts.sameForm ?? false, sameFormKeptValues: facts.kept ?? false, recordId: facts.recordId ?? null,
      readVerification: facts.read,
    });

  it('is a success when the READ matches (with the record id or without it)', () => {
    expect(judge({ read: 'MATCHED', recordId: '12' })).toEqual({ responseJudgement: 'SUCCESS', recordId: '12' });
    expect(judge({ read: 'MATCHED' })).toEqual({ responseJudgement: 'SUCCESS', recordId: null });
    // 同じフォームが値を保って出ても、READ が一致すれば成功（送った値で登録できた）。
    expect(judge({ read: 'MATCHED', sameForm: true, kept: true })).toEqual({ responseJudgement: 'SUCCESS', recordId: null });
  });

  it('is an input error only when the READ does not match and the same form shows again with the sent values kept', () => {
    expect(judge({ read: 'NOT_MATCHED', sameForm: true, kept: true })).toEqual({ responseJudgement: 'INPUT_ERROR', recordId: null });
    expect(judge({ read: 'NOT_MATCHED', sameForm: true, kept: false })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
    expect(judge({ read: 'NOT_MATCHED' })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
    // READ を判定できないなら、同じフォームが値を保って出ても入力の誤りにしない。
    expect(judge({ read: 'UNDETERMINED', sameForm: true, kept: true })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
    expect(judge({ read: null, sameForm: true, kept: true })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
  });

  it('keeps the record id of a READ that does not match, so that the result is UNKNOWN (not a failure)', () => {
    const judged = judge({ read: 'NOT_MATCHED', recordId: '12', sameForm: true, kept: true });
    expect(judged).toEqual({ responseJudgement: 'SUCCESS', recordId: '12' });
    expect(actionOutcomeOf({ submission: 'SENT', ...judged, readVerification: 'NOT_MATCHED' }))
      .toEqual({ result: 'UNKNOWN', reason: 'READ_VERIFICATION_NOT_MATCHED' });
  });

  it('is a success that cannot be verified when the READ cannot be judged, the record id is new, and the form does not show again', () => {
    expect(judge({ read: 'UNDETERMINED', recordId: '12' })).toEqual({ responseJudgement: 'SUCCESS', recordId: '12' });
    expect(actionOutcomeOf({ submission: 'SENT', responseJudgement: 'SUCCESS', recordId: '12', readVerification: 'UNDETERMINED' }))
      .toEqual({ result: 'PARTIAL', reason: 'READ_VERIFICATION_UNDETERMINED' });
    expect(judge({ read: 'UNDETERMINED', recordId: '12', sameForm: true })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
    expect(judge({ read: 'UNDETERMINED' })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
  });
});

describe('PL-6a: the update judgement of a 2xx or 3xx response', () => {
  const judge = (postcheck: FormUpdatePostcheck, facts: { readonly sameForm?: boolean; readonly kept?: boolean; readonly recordId?: string | null } = {}) =>
    formResultJudgementOf({
      httpStatus: 200, sameForm: facts.sameForm ?? false, sameFormKeptValues: facts.kept ?? false, recordId: facts.recordId ?? null,
      readVerification: null, update: { targetRecordId: '41', postcheck },
    });

  it('is a success with the target id when the fields are updated (or with another id from the URL, which is a mismatch)', () => {
    expect(judge('UPDATED')).toEqual({ responseJudgement: 'SUCCESS', recordId: '41' });
    expect(judge('UPDATED', { recordId: '41' })).toEqual({ responseJudgement: 'SUCCESS', recordId: '41' });
    expect(judge('UPDATED', { recordId: '419' })).toEqual({ responseJudgement: 'SUCCESS', recordId: '419' });
    expect(actionOutcomeOf({
      submission: 'SENT', responseJudgement: 'SUCCESS', recordId: '419', readVerification: null, update: { targetRecordId: '41', fieldsMatched: true },
    })).toEqual({ result: 'UNKNOWN', reason: 'RECORD_ID_MISMATCH' });
  });

  it('is an input error only when nothing changed and the same form shows again with the sent values kept', () => {
    expect(judge('UNCHANGED', { sameForm: true, kept: true })).toEqual({ responseJudgement: 'INPUT_ERROR', recordId: null });
    expect(judge('UNCHANGED', { sameForm: true })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
    expect(judge('UNCHANGED')).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
  });

  it('keeps an unexpected field change UNKNOWN, and does not judge without the postcheck', () => {
    const changed = judge('CHANGED_OTHERWISE', { sameForm: true, kept: true });
    expect(changed).toEqual({ responseJudgement: 'SUCCESS', recordId: '41' });
    expect(actionOutcomeOf({ submission: 'SENT', ...changed, readVerification: null, update: { targetRecordId: '41', fieldsMatched: false } }))
      .toEqual({ result: 'UNKNOWN', reason: 'UNEXPECTED_FIELD_CHANGE' });
    expect(judge('UNDETERMINED', { sameForm: true, kept: true })).toEqual({ responseJudgement: 'NO_CONDITION_MATCHED', recordId: null });
  });
});

describe('PL-6a: the record id from the URL after sending', () => {
  it('takes a record-id-like segment of the first pattern that fits, only when it differs from the URL before the click', () => {
    expect(recordIdOfResultUrl(['/items/{id}'], url('/items/new'), url('/items/12'))).toBe('12');
    expect(recordIdOfResultUrl(['/items/{id}', '/items/{id}/edit'], url('/items/new'), url('/items/12/edit'))).toBe('12');
    const uuid = '3f2c8a10-5b7e-4c1d-9a2b-0e6f7d8c9b10';
    expect(recordIdOfResultUrl(['/items/{id}'], url('/items/new'), url(`/items/${uuid}`))).toBe(uuid);
    // ID の形でない区切り（`new`・`done`・`error`・`a.b`）は ID にしない。
    for (const path of ['/items/done', '/items/error', '/items/a.b', '/items/x']) {
      expect(recordIdOfResultUrl(['/items/{id}'], url('/items/new'), url(path)), path).toBeNull();
    }
  });

  it('does not take the value that the URL before the click already gives, nor any value when the URL did not change', () => {
    expect(recordIdOfResultUrl(['/items/{id}/edit'], url('/items/7/edit'), url('/items/7/edit'))).toBeNull();
    expect(recordIdOfResultUrl(['/items/{id}'], url('/items/7'), url('/items/7?saved=1'))).toBeNull();
    expect(recordIdOfResultUrl(['/items/{id}'], url('/items/12'), url('/items/12'))).toBeNull();
    expect(recordIdOfResultUrl(['/items/{id}'], url('/items/new'), url('/items/new'))).toBeNull();
  });

  it('gives null without a pattern, for a URL that cannot be read, and for a pattern that does not fit', () => {
    expect(recordIdOfResultUrl([], url('/items/new'), url('/items/12'))).toBeNull();
    expect(recordIdOfResultUrl(['/items/{id}'], 'not a url', url('/items/12'))).toBeNull();
    expect(recordIdOfResultUrl(['/items/{id}'], url('/items/new'), 'not a url')).toBeNull();
    expect(recordIdOfResultUrl(['/orders/{id}'], url('/items/new'), url('/items/12'))).toBeNull();
  });

  it('allows two patterns at most in the contract', () => {
    expect(MAX_FORM_RECORD_ID_PATTERNS).toBe(2);
  });
});

describe('PL-6a: the READ before sending', () => {
  it('stops before sending when the value is already visible, or when the READ cannot be judged', () => {
    expect(preSubmitReadStopOf('NOT_MATCHED')).toBeNull();
    expect(preSubmitReadStopOf('MATCHED')).toBe('VALUE_ALREADY_PRESENT');
    expect(preSubmitReadStopOf('UNDETERMINED')).toBe('VERIFICATION_READ_UNAVAILABLE');
    expect(PRECHECK_FAILURE_DETAILS).toEqual(expect.arrayContaining(['VALUE_ALREADY_PRESENT', 'VERIFICATION_READ_UNAVAILABLE']));
  });
});
