// OP-L（L1）: 送る前の確かめで候補が合わなかったときの、どこが違ったかの理由の閉じた一覧（`PRECHECK_CANDIDATE_MISMATCH_REASONS`）が、API の入力の前の確かめの
// 理由（`API_WRITE_INPUT_REASONS`）とスキーマの enum からずれないことを確かめる。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_WRITE_INPUT_REASONS, pressTimeSubmitterWordsOf, pressTimeWordsMatchApproved } from '../../src/browser/api-write-submitter.js';
import { PRECHECK_CANDIDATE_MISMATCH_REASONS } from '../../src/control/actions/action-contracts.js';
import type { PressTimeFacts } from '../../src/discovery/isolated-read.js';

/** 押す時点の事実（文言だけを変える。つながっている送信ボタン）。 */
const pressFactsOf = (text: string): PressTimeFacts => ({
  connected: true, localName: 'button', type: 'submit', role: null, disabled: false, text, overrides: [false, false, false, false], formOwnerMatches: true,
});
/** 前の文言の上限（256）より長い前置き。 */
const LONG_PREFIX = 'x'.repeat(300);

// LZ-3c: 押す時点の語は、文言を切らずに全部から求める（前は 256 で切った）。照合が厳しくなる向きだけ: 前の長さの後ろの語も比べ、削除の語なら押さない。
describe('LZ-3c: the words of the submitter at the press time are taken from the whole text', () => {
  it('takes a word after the former length, and does not press a delete word there', () => {
    expect(pressTimeSubmitterWordsOf(pressFactsOf(`${LONG_PREFIX} create`))?.words).toEqual(['create']);
    // 前に承認した語（前の長さで切った文言の語。ここでは空）とは合わないので押さない（もう一度の承認が要る）。
    expect(pressTimeWordsMatchApproved(pressFactsOf(`${LONG_PREFIX} create`), [])).toBe(false);
    expect(pressTimeWordsMatchApproved(pressFactsOf(`${LONG_PREFIX} delete`), [])).toBe(false);
    // 前の長さの中の語は、今までどおり合う。
    expect(pressTimeWordsMatchApproved(pressFactsOf('create'), ['create'])).toBe(true);
  });
});

/** 候補を読む確かめ（form と API の更新）だけの理由（API の入力の前の確かめの理由でないもの）。 */
const CANDIDATE_READ_REASONS = ['IDENTITY_NOT_FOUND', 'IDENTITY_AMBIGUOUS', 'RULE_DIGEST_CHANGED', 'RECORD_ID_NOT_IN_PATH'];
/** API の入力の前の確かめ（`inspectApiWriteInput`）が返しうる理由（入れる・押すときの理由を除く）。 */
const API_INSPECTION_REASONS = [
  'SPEC_INVALID', 'PAGE_UNREADABLE', 'FIELD_NOT_FOUND', 'FIELD_AMBIGUOUS', 'FIELD_TYPE_NOT_SUPPORTED', 'FIELD_NOT_VISIBLE', 'FIELD_NOT_EDITABLE',
  'SUBMITTER_NOT_FOUND', 'SUBMITTER_AMBIGUOUS', 'SUBMITTER_INSIDE_LINK',
];

describe('OP-L L1: the precheck candidate mismatch reasons', () => {
  it('are the candidate reading reasons and the API inspection reasons (all in API_WRITE_INPUT_REASONS)', () => {
    expect([...PRECHECK_CANDIDATE_MISMATCH_REASONS].sort()).toEqual([...CANDIDATE_READ_REASONS, ...API_INSPECTION_REASONS].sort());
    for (const reason of API_INSPECTION_REASONS) {
      expect(API_WRITE_INPUT_REASONS).toContain(reason);
    }
  });

  it('match the enum of the action evidence schema', () => {
    const schema = JSON.parse(readFileSync('schemas/action-evidence.schema.json', 'utf8')) as {
      readonly $defs: { readonly candidateMismatch: { readonly properties: { readonly reason: { readonly enum: readonly string[] } } } };
    };
    expect(schema.$defs.candidateMismatch.properties.reason.enum).toEqual([...PRECHECK_CANDIDATE_MISMATCH_REASONS]);
  });
});
