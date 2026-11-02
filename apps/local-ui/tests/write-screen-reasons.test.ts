/**
 * OP-2 の修正の 2 回目（判断 2・判断 1 の行の 1 行）: サイトの画面の一覧の、試せない行の理由と、更新の 1 行。
 * - 試せない理由のコード（`ScenarioDraftRejectionReason`）は、どれも、やさしい 1 行の種類（`writeScreenNotCheckableKindOf`）に振り分けられ、種類ごとに文がある。
 * - 文に技術の語（英字の識別子・Origin・path・API など）は入らない。
 * - 更新の 1 行: 更新の画面がまだ見つからないときは「更新は、次の点検で試します。」、見つかったが更新する欄を決められないときは「登録だけを試します」。
 * 画面のサーバとブラウザは起動しない。
 */
import { describe, expect, it } from 'vitest';
import { SCENARIO_DRAFT_REJECTION_REASONS } from '../../../src/core/scenario-draft-rejection-reasons.js';
import { LOCAL_UI_WRITE_SCREENS_TEXT } from '../../../src/presentation/messages.js';
import {
  INSPECTION_WRITE_OUTCOMES,
  inspectionWriteOutcomeOf,
  WRITE_SCREEN_NOT_CHECKABLE_KINDS,
  WRITE_SCREEN_UPDATE_STATES,
  writeScreenLastResultLinesOf,
  writeScreenNotCheckableKindOf,
  writeScreenRowResultLinesOf,
} from '../src/display/write-screen-values';

const text = LOCAL_UI_WRITE_SCREENS_TEXT;

describe('OP-2 fix round 2: the plain line of a row that cannot be tried', () => {
  it('sorts every reason code into a kind that has a line', () => {
    for (const reason of SCENARIO_DRAFT_REJECTION_REASONS) {
      const kind = writeScreenNotCheckableKindOf(reason);
      expect(WRITE_SCREEN_NOT_CHECKABLE_KINDS, reason).toContain(kind);
      expect(text.notCheckable[kind].length, reason).toBeGreaterThan(0);
    }
    expect(Object.keys(text.notCheckable).sort()).toEqual([...WRITE_SCREEN_NOT_CHECKABLE_KINDS].sort());
  });

  it('gives the lines of the examples for a secret-looking field and an answer check that cannot be decided', () => {
    expect(text.notCheckable[writeScreenNotCheckableKindOf('SCENARIO_FORM_HAS_UNREADABLE_SECRET_FIELD')])
      .toBe('パスワードなどの秘密に見える欄があるため、試せません。');
    expect(text.notCheckable[writeScreenNotCheckableKindOf('SCENARIO_FIELD_SECRET_LIKE')]).toBe(text.notCheckable.SECRET_FIELD);
    expect(text.notCheckable[writeScreenNotCheckableKindOf('SCENARIO_API_READ_VERIFICATION_NOT_BOUND')])
      .toBe('答え合わせのしかたを決められないため、試せません。');
    expect(writeScreenNotCheckableKindOf('SCENARIO_FIELD_DANGEROUS_WORD')).toBe('DESTRUCTIVE');
    expect(writeScreenNotCheckableKindOf('SCENARIO_API_DISCOVERY_PROFILE_STALE')).toBe('SITE_CHANGED');
  });

  // OP-K（K2）: 本物のテスト環境で「扱えない」になった 2 つの理由に、合った 1 行を出す（画面が自動で送る秘密に見える名前の項目と、入れた値と送る中身の結び付き）。
  it('gives the lines that fit a secret-looking key sent by the page and a field sent in another shape (OP-K K2)', () => {
    expect(writeScreenNotCheckableKindOf('SCENARIO_API_PAGE_KEY_SECRET_LIKE')).toBe('SECRET_KEY');
    expect(text.notCheckable.SECRET_KEY).toBe('画面が自動で送る項目に、秘密に見える名前のものがあるため、試せません。');
    expect(writeScreenNotCheckableKindOf('SCENARIO_API_FIELD_KEY_MISMATCH')).toBe('FIELD_SHAPE');
    expect(text.notCheckable.FIELD_SHAPE).toBe('入れた値と、送る中身の結び付きが分からないため、試せません。');
  });

  it('has the lines of the update', () => {
    expect([...WRITE_SCREEN_UPDATE_STATES].sort()).toEqual(['MAY_NOTIFY', 'NEXT_INSPECTION', 'NOT_DECIDABLE']);
    expect(text.update.NEXT_INSPECTION).toBe('更新は、次の点検で試します。');
    expect(text.update.NOT_DECIDABLE).toBe('更新する欄を決められないため、登録だけを試します。');
    // OP-F（M-3）: 点検の中で見つかった更新の画面が知らせを送ることがあり、チェックがそれを確かめていない。
    expect(text.update.MAY_NOTIFY).toBe('更新の画面は、メールや電話への知らせを送ることがあります。もう一度チェックすると、更新も試します。');
  });

  it('uses no technical words in the lines', () => {
    for (const line of [...Object.values(text.notCheckable), ...Object.values(text.update), ...Object.values(text.lastResult.notSentReasons)]) {
      expect(line, line).not.toMatch(/[A-Za-z]{2,}|\//u);
    }
  });
});

// OP-F（設計者の判断の 4）: 前の点検の結果の 1 行。送らずに締めた回（準備が通らなかった・止めた）は、前に確かめた結果を隠さず、「前回は試せませんでした」と理由の
// 1 行を出す。前に確かめた結果があれば、それも 1 行で残す。
describe('OP-F: the lines of the last result of a row', () => {
  const tried = (result: 'VERIFIED' | 'UNKNOWN' | 'BLOCKED') => ({ tried: result, notSentReason: null });
  it('keeps the usual line when the last write was tried', () => {
    expect(writeScreenLastResultLinesOf({ create: tried('VERIFIED'), update: tried('VERIFIED') }, false))
      .toEqual({ notTried: null, confirmed: text.lastResult.line(text.lastResult.created, text.lastResult.updated) });
    expect(writeScreenLastResultLinesOf({ create: tried('VERIFIED'), update: null }, true)).toEqual({ notTried: null, confirmed: text.lastResult.createdOnly });
  });

  it('says that the last one was not tried with its reason, and keeps the result checked before', () => {
    expect(writeScreenLastResultLinesOf({ create: { tried: 'VERIFIED', notSentReason: 'PRECHECK_FAILED' }, update: null }, true)).toEqual({
      notTried: text.lastResult.notTried(text.lastResult.notSentReasons.PRECHECK_FAILED),
      confirmed: text.lastResult.createdOnly,
    });
    expect(writeScreenLastResultLinesOf({ create: { tried: null, notSentReason: 'PAYLOAD_MISMATCH' }, update: null }, true)).toEqual({
      notTried: text.lastResult.notTried(text.lastResult.notSentReasons.PAYLOAD_MISMATCH),
      confirmed: null,
    });
    expect(writeScreenLastResultLinesOf({ create: tried('VERIFIED'), update: { tried: 'VERIFIED', notSentReason: 'PRECHECK_FAILED' } }, false)).toEqual({
      notTried: text.lastResult.updateNotTriedLast(text.lastResult.notSentReasons.PRECHECK_FAILED),
      confirmed: text.lastResult.line(text.lastResult.created, text.lastResult.updated),
    });
    expect(text.lastResult.notTried(text.lastResult.notSentReasons.PRECHECK_FAILED).startsWith('前回は試せませんでした。')).toBe(true);
  });
});

// OP-G（指示書の 3。完了の正直さ）: 点検の要点の書き込みの 1 行は、実際に送った段と結果から決める（前は、書き込みの段があれば結果によらず「登録・更新も行いました」）。
describe('OP-G: the line of the inspection summary tells what was really written', () => {
  it('says what was done, what could not be confirmed and what could not be tried, and says nothing without a checked screen', () => {
    const verified = (kind: 'CREATE' | 'UPDATE') => ({ kind, result: 'VERIFIED' as const });
    expect(inspectionWriteOutcomeOf({ stopReason: null, writes: [verified('CREATE'), verified('UPDATE')] })).toBe('WROTE');
    expect(inspectionWriteOutcomeOf({ stopReason: null, writes: [verified('CREATE')] })).toBe('CREATED');
    // 登録が確かめられなかった（UI-W3 の部 B）、更新が確かめられなかった、試せなかった画面が残った: どれも「確かめられなかった・試せなかったものがある」。
    expect(inspectionWriteOutcomeOf({ stopReason: null, writes: [{ kind: 'CREATE', result: 'PARTIAL' }] })).toBe('NOT_CONFIRMED');
    expect(inspectionWriteOutcomeOf({ stopReason: null, writes: [verified('CREATE'), { kind: 'UPDATE', result: null }] })).toBe('NOT_CONFIRMED');
    expect(inspectionWriteOutcomeOf({ stopReason: 'WRITE_NOT_TRIED', writes: [verified('CREATE')] })).toBe('NOT_CONFIRMED');
    // 1 つも試せなかった（UI-W3 の部 A）と、チェックした画面のない点検。
    expect(inspectionWriteOutcomeOf({ stopReason: 'WRITE_NOT_TRIED', writes: [] })).toBe('NOT_TRIED');
    expect(inspectionWriteOutcomeOf({ stopReason: null, writes: [] })).toBeNull();
    expect(inspectionWriteOutcomeOf({ stopReason: 'STAGE_FAILED', writes: [] })).toBeNull();
    for (const outcome of INSPECTION_WRITE_OUTCOMES) {
      expect(text.inspectionWrite[outcome].length).toBeGreaterThan(0);
      expect(text.inspectionWrite[outcome]).not.toMatch(/[A-Za-z]/u);
    }
  });
});

// OP-H（撮影 UI-W4 の 2）: 一覧の行の結果の文。順は「登録しました。」→「更新しました。」→（あれば）更新の 1 行。どの文も句点で終わる。並びと文の組み立ては
// 表示の値の 1 か所（`writeScreenRowResultLinesOf`）。
describe('OP-H: the result lines of a row, in order and each ending with a full stop', () => {
  const tried = (result: 'VERIFIED' | 'UNKNOWN') => ({ tried: result, notSentReason: null });
  it('says the registration, then the update, then the line of the update to come', () => {
    expect(writeScreenRowResultLinesOf({ state: 'CHECKED', lastResult: { create: tried('VERIFIED'), update: tried('VERIFIED') }, updateState: null }))
      .toEqual([{ kind: 'LAST_RESULT', text: '登録しました。更新しました。' }]);
    expect(writeScreenRowResultLinesOf({ state: 'CHECKED', lastResult: { create: tried('VERIFIED'), update: null }, updateState: 'NEXT_INSPECTION' }))
      .toEqual([{ kind: 'LAST_RESULT', text: '登録しました。' }, { kind: 'UPDATE_STATE', text: '更新は、次の点検で試します。', updateState: 'NEXT_INSPECTION' }]);
    expect(writeScreenRowResultLinesOf({ state: 'CHECKED', lastResult: { create: tried('VERIFIED'), update: tried('VERIFIED') }, updateState: 'MAY_NOTIFY' })
      .map(({ kind }) => kind)).toEqual(['LAST_RESULT', 'UPDATE_STATE']);
    // 前の点検の結果がない行は、更新の 1 行だけ。チェックできない行は、更新の 1 行を出さない。
    expect(writeScreenRowResultLinesOf({ state: 'CHECKABLE', lastResult: null, updateState: 'NEXT_INSPECTION' }))
      .toEqual([{ kind: 'UPDATE_STATE', text: text.update.NEXT_INSPECTION, updateState: 'NEXT_INSPECTION' }]);
    expect(writeScreenRowResultLinesOf({ state: 'NOT_CHECKABLE', lastResult: null, updateState: 'NEXT_INSPECTION' })).toEqual([]);
    // 送らずに締めた回の 1 行は、結果の前。
    expect(writeScreenRowResultLinesOf({
      state: 'CHECKED', lastResult: { create: { tried: 'VERIFIED', notSentReason: 'PRECHECK_FAILED' }, update: null }, updateState: 'NEXT_INSPECTION',
    }).map(({ kind }) => kind)).toEqual(['LAST_NOT_TRIED', 'LAST_RESULT', 'UPDATE_STATE']);
  });

  it('ends every result line with a full stop', () => {
    const results = ['VERIFIED', 'UNKNOWN'] as const;
    for (const create of results) {
      for (const update of [...results, null]) {
        for (const pending of [true, false]) {
          const { confirmed } = writeScreenLastResultLinesOf({ create: tried(create), update: update === null ? null : tried(update) }, pending);
          expect(confirmed, `${create} ${String(update)} ${String(pending)}`).toMatch(/。$/u);
        }
      }
    }
  });
});
