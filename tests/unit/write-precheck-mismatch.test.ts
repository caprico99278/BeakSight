// OP-L（L1）: 送る前の確かめで候補が合わなかったときの、どこが違ったかの理由の閉じた一覧（`PRECHECK_CANDIDATE_MISMATCH_REASONS`）が、API の入力の前の確かめの
// 理由（`API_WRITE_INPUT_REASONS`）とスキーマの enum からずれないことを確かめる。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { API_WRITE_INPUT_REASONS } from '../../src/browser/api-write-submitter.js';
import { PRECHECK_CANDIDATE_MISMATCH_REASONS } from '../../src/control/actions/action-contracts.js';

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
