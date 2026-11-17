/**
 * OP-2 の修正の 2 回目（判断 2・判断 1 の行の 1 行）: サイトの画面の一覧の、試せない行の理由と、更新の 1 行。
 * - 試せない理由のコード（`ScenarioDraftRejectionReason`）は、どれも、やさしい 1 行の種類（`writeScreenNotCheckableKindOf`）に振り分けられ、種類ごとに文がある。
 * - 文に技術の語（英字の識別子・Origin・path・API など）は入らない。
 * - 更新の 1 行: 更新の画面がまだ見つからないときは「更新は、サイトの全部の画面を点検したときに試します。」（WSO）、見つかったが更新する欄を決められないときは
 *   「登録だけを試します」。
 * 画面のサーバとブラウザは起動しない。
 */
import { describe, expect, it } from 'vitest';
import { SCENARIO_DRAFT_REJECTION_REASONS } from '../../../src/core/scenario-draft-rejection-reasons.js';
import {
  PRECHECK_FAILED_BLOCK_REASON,
  PRECHECK_FAILURE_DETAILS,
  actionRunPrecheckDetailOf,
  type PrecheckFailureDetail,
} from '../../../src/control/actions/action-contracts.js';
import { SUBMISSION_PROBE_REASON_CATALOG } from '../../../src/presentation/catalog.js';
import { LOCAL_UI_WRITE_SCREENS_TEXT } from '../../../src/presentation/messages.js';
import {
  apiKeyPathDisplayText,
  INSPECTION_WRITE_OUTCOMES,
  inspectionWriteOutcomeOf,
  WRITE_SCREEN_NOT_CHECKABLE_KINDS,
  WRITE_SCREEN_UPDATE_STATES,
  writeScreenLastResultLinesOf,
  writeScreenListRowUpdateNotSentTextOf,
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
    expect(text.update.NEXT_INSPECTION).toBe('更新は、サイトの全部の画面を点検したときに試します。');
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

// LU-13（設計書 `2026-11-02-beaksight-list-row-update-design.md` 5.6）: 一覧の行から開く更新が送らずに止まったときは、更新の 1 行を短い 1 文にする（番号や
// 技術の語は出さない）。ほかの理由は、今の「前回は更新を試せませんでした」の 1 行のまま。
describe('LU-13: the short line of a list row update that was not sent', () => {
  const notSent = (notSentDetail: PrecheckFailureDetail | null) =>
    ({ create: { tried: 'VERIFIED' as const, notSentReason: null }, update: { tried: null, notSentReason: 'PRECHECK_FAILED' as const, notSentDetail } });
  const rowNotFound = '更新できませんでした（作った行が一覧の最初のページに見つかりませんでした）。';
  const openerNotFound = '更新できませんでした（一覧の行の『編集』が見つかりませんでした）。';
  const expected: Readonly<Partial<Record<PrecheckFailureDetail, string>>> = {
    ROW_NOT_UNIQUE: rowNotFound,
    OPENER_NOT_FOUND: openerNotFound,
    OPENER_UNNAMED: openerNotFound,
    OPENER_DELETE_LIKE: openerNotFound,
    PRIOR_VALUES_NOT_ACCEPTED: '更新できませんでした。',
    TARGET_RECORD_UNUSABLE: '更新できませんでした。',
  };

  it('says the short line for each reason of a list row update, in place of the usual line', () => {
    // カタログの鍵は、一覧の行の更新の 6 つの理由（どれも送らずに止めた理由の閉じた一覧の中）。
    expect(Object.keys(text.lastResult.listRowUpdateNotSent).sort()).toEqual(Object.keys(expected).sort());
    for (const detail of Object.keys(expected) as PrecheckFailureDetail[]) {
      expect(PRECHECK_FAILURE_DETAILS, detail).toContain(detail);
      expect(writeScreenLastResultLinesOf(notSent(detail), false).notTried, detail).toBe(expected[detail]);
      expect(writeScreenRowResultLinesOf({ state: 'CHECKED', lastResult: notSent(detail), updateState: null })[0], detail)
        .toEqual({ kind: 'LAST_NOT_TRIED', text: expected[detail] });
    }
  });

  it('keeps the usual line for the other reasons and when the reason is not known', () => {
    const usual = text.lastResult.updateNotTriedLast(text.lastResult.notSentReasons.PRECHECK_FAILED);
    for (const detail of [null, ...PRECHECK_FAILURE_DETAILS.filter((item) => expected[item] === undefined)]) {
      expect(writeScreenLastResultLinesOf(notSent(detail), false).notTried, String(detail)).toBe(usual);
    }
    expect(writeScreenLastResultLinesOf({ create: { tried: 'VERIFIED', notSentReason: null }, update: { tried: null, notSentReason: 'PRECHECK_FAILED' } }, false).notTried)
      .toBe(usual);
    // 登録の回が送らずに締めた回なら、登録の 1 行が先（今のまま）。
    expect(writeScreenLastResultLinesOf({ create: { tried: null, notSentReason: 'PRECHECK_FAILED' }, update: notSent('ROW_NOT_UNIQUE').update }, false).notTried)
      .toBe(text.lastResult.notTried(text.lastResult.notSentReasons.PRECHECK_FAILED));
    expect(writeScreenListRowUpdateNotSentTextOf(null)).toBeNull();
  });

  it('uses no technical words or numbers in the lines', () => {
    for (const line of Object.values(text.lastResult.listRowUpdateNotSent)) {
      expect(line, line).not.toMatch(/[A-Za-z0-9０-９]|\//u);
      expect(line, line).toMatch(/^更新できませんでした/u);
      expect(line, line).toMatch(/。$/u);
    }
  });
});

// LU-13 fix round 1（案 A）: 書き込みのジョブの記録（`action-run.json`）から、送らずに止めた具体的な理由を読む 1 か所（ジョブの画面と一覧の行が使う）。
describe('LU-13 fix round 1: the detail of a write stopped before sending, read from the action run', () => {
  it('reads the detail only when the write stopped at the precheck, and null otherwise', () => {
    expect(PRECHECK_FAILED_BLOCK_REASON).toBe('PRECHECK_FAILED');
    expect(actionRunPrecheckDetailOf({ blockReason: 'PRECHECK_FAILED', precheckDetail: 'ROW_NOT_UNIQUE' })).toBe('ROW_NOT_UNIQUE');
    expect(actionRunPrecheckDetailOf({ blockReason: 'PRECHECK_FAILED' })).toBeNull();
    expect(actionRunPrecheckDetailOf({ blockReason: 'PAYLOAD_MISMATCH', precheckDetail: 'ROW_NOT_UNIQUE' })).toBeNull();
    expect(actionRunPrecheckDetailOf({ blockReason: null })).toBeNull();
    expect(actionRunPrecheckDetailOf(null)).toBeNull();
  });
});

// LU-13 fix round 1（案 (a)(b)(c)。D3）: 名前のないアイコンだけの開き手で更新を扱えない画面は、今の `NOT_DECIDABLE` の 1 行のまま、文だけを
// 「この画面の更新は自動で扱えません。」にする（ほかの状態と、名前のある開き手の画面は今のまま）。
describe('LU-13 fix round 1: the line of a screen whose update opens only from an icon without a name', () => {
  it('says that the update of the screen cannot be handled automatically, only for NOT_DECIDABLE', () => {
    expect(text.updateOpenerUnnamed).toBe('この画面の更新は自動で扱えません。');
    expect(text.updateOpenerUnnamed).not.toMatch(/[A-Za-z0-9]|\//u);
    expect(writeScreenRowResultLinesOf({ state: 'CHECKABLE', lastResult: null, updateState: 'NOT_DECIDABLE', updateOpenerUnnamedOnly: true }))
      .toEqual([{ kind: 'UPDATE_STATE', text: text.updateOpenerUnnamed, updateState: 'NOT_DECIDABLE' }]);
    expect(writeScreenRowResultLinesOf({ state: 'CHECKABLE', lastResult: null, updateState: 'NOT_DECIDABLE', updateOpenerUnnamedOnly: false }))
      .toEqual([{ kind: 'UPDATE_STATE', text: text.update.NOT_DECIDABLE, updateState: 'NOT_DECIDABLE' }]);
    expect(writeScreenRowResultLinesOf({ state: 'CHECKABLE', lastResult: null, updateState: 'NEXT_INSPECTION', updateOpenerUnnamedOnly: true }))
      .toEqual([{ kind: 'UPDATE_STATE', text: text.update.NEXT_INSPECTION, updateState: 'NEXT_INSPECTION' }]);
    expect(writeScreenRowResultLinesOf({ state: 'NOT_CHECKABLE', lastResult: null, updateState: 'NOT_DECIDABLE', updateOpenerUnnamedOnly: true })).toEqual([]);
  });
});

// LU-13（指示書の 3）: 操作さがしの新しい理由の文は、利用者向けの短い日本語（技術の語を出さない）。
describe('LU-13: the plain lines of the new reasons of the operation search', () => {
  it('says the new reasons in short plain words', () => {
    expect(SUBMISSION_PROBE_REASON_CATALOG.OPENER_SIDE_REQUEST.label).toBe('開いたときにサイトが自動で送ったので、登録として扱わない');
    expect(SUBMISSION_PROBE_REASON_CATALOG.SAME_IDENTITY_PRESSED.label).toBe('同じボタンは 1 つだけ押すので、ここは押さなかった');
    expect(SUBMISSION_PROBE_REASON_CATALOG.CREATE_PATH_HAS_ID.label).toBe('もうあるデータに向けた送信なので、登録として扱わない');
    for (const reason of ['OPENER_SIDE_REQUEST', 'SAME_IDENTITY_PRESSED', 'CREATE_PATH_HAS_ID'] as const) {
      expect(SUBMISSION_PROBE_REASON_CATALOG[reason].label, reason).not.toMatch(/[A-Za-z]|\//u);
    }
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
      .toEqual([{ kind: 'LAST_RESULT', text: '登録しました。' }, { kind: 'UPDATE_STATE', text: '更新は、サイトの全部の画面を点検したときに試します。', updateState: 'NEXT_INSPECTION' }]);
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

// ARR-5（DEF-234）: 並びの行の欄の鍵（道 `key[i]`・`key[i].name`）の、利用者に分かる言い方（部品は `apiKeyPathDisplayText` の 1 か所）。
describe('ARR-5: the text of a key of a row of a list', () => {
  it('says the row from 1 with the headings of the screen first', () => {
    expect(apiKeyPathDisplayText('quals[0]', { list: '資格' })).toBe('資格（1 行目）');
    expect(apiKeyPathDisplayText('careers[1].name', { list: '職歴', inner: '名前' })).toBe('職歴（2 行目）の 名前');
  });

  it('does not show the names of the keys or the brackets without the headings', () => {
    for (const key of ['quals[0]', 'careers[1].name', 'skills[19]']) {
      const shown = apiKeyPathDisplayText(key) ?? '';
      expect(shown).not.toMatch(/[A-Za-z[\].]/u);
    }
    expect(apiKeyPathDisplayText('careers[1].name')).toBe('並びの項目（2 行目）の 中の項目');
  });

  it('leaves a key that is not a path to the current text', () => {
    expect(apiKeyPathDisplayText('quals')).toBeNull();
    expect(apiKeyPathDisplayText('title')).toBeNull();
  });
});
