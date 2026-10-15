// T30a（Task 30 の設計書 3 章の「結果の判定」「登録の ID」「READ による照合」「予約の締め」「`UNKNOWN` の後」、ロードマップ 5 章の `ActionResult`）:
// 書き込みの結果の契約（`src/control/actions/action-contracts.ts`）と、純粋な判定（`src/control/actions/action-outcome.ts`）。
// - 予約の締め方: 送信の状態と応答の有無から、`COMMITTED`・`UNKNOWN`・`RELEASED` を決める（`RELEASED` は、送らなかったことを報告できたときだけ）。
// - `ActionResult`: 照合できなければ `VERIFIED` にしない。結果が分からないのに成功と偽らない。送らずに止めたら `BLOCKED`。
import { describe, expect, it } from 'vitest';
import {
  ACTION_BLOCK_REASONS,
  ACTION_OUTCOME_REASONS,
  ACTION_RESULTS,
  RESPONSE_JUDGEMENTS,
  SETTLED_RESERVATION_STATES,
  SUBMISSION_STATES,
  type ActionOutcomeInput,
  type ResponseJudgement,
} from '../../src/control/actions/action-contracts.js';
import {
  MAX_SAFE_RECORD_ID_LENGTH,
  actionOutcomeOf,
  isUsableRecordId,
  recordableRecordIdOf,
  reservationSettlementOf,
  usableRecordIdOf,
  fieldsMatchedOf,
} from '../../src/control/actions/action-outcome.js';
import { MAX_RECORD_ID_LENGTH, WRITE_RESERVATION_STATES } from '../../src/control/approval/scenario-contracts.js';
import { isWriteReservationTransitionAllowed } from '../../src/control/approval/execution-grant.js';
import { READ_CHECK_RESULTS, type ReadCheckResult } from '../../src/discovery/read-check-contracts.js';

describe('action result contracts (T30a)', () => {
  it('has the frozen closed lists', () => {
    expect(ACTION_RESULTS).toEqual(['VERIFIED', 'PARTIAL', 'BLOCKED', 'UNKNOWN', 'FAILED']);
    expect(SUBMISSION_STATES).toEqual(['NOT_SENT', 'SENT', 'UNKNOWN']);
    expect(ACTION_BLOCK_REASONS).toEqual(['PAYLOAD_MISMATCH', 'PRECHECK_FAILED']);
    expect(RESPONSE_JUDGEMENTS).toEqual([
      'SUCCESS',
      'INPUT_ERROR',
      'RATE_LIMITED',
      'SERVER_ERROR',
      'NO_CONDITION_MATCHED',
      'MULTIPLE_CONDITIONS_MATCHED',
      'SESSION_LOST',
      'REPOST_REDIRECT',
      'RESPONSE_NOT_DELIVERED',
    ]);
    expect(ACTION_OUTCOME_REASONS).toEqual([
      'PAYLOAD_MISMATCH',
      'PRECHECK_FAILED',
      'NO_RESPONSE',
      'INPUT_ERROR',
      'RATE_LIMITED',
      'SERVER_ERROR',
      'NO_CONDITION_MATCHED',
      'MULTIPLE_CONDITIONS_MATCHED',
      'SESSION_LOST',
      'REPOST_REDIRECT',
      'RESPONSE_NOT_DELIVERED',
      'RECORD_ID_NOT_FOUND',
      'RECORD_ID_UNSAFE',
      'READ_VERIFICATION_MATCHED',
      'READ_VERIFICATION_NOT_MATCHED',
      'READ_VERIFICATION_UNDETERMINED',
      // T31e fix round 1: UPDATE の結果の理由。
      'RECORD_ID_MISMATCH',
      'UNEXPECTED_FIELD_CHANGE',
      // T31f: UPDATE の更新の後の照合を判定できない（`READ_VERIFICATION_UNDETERMINED` から分けた）。
      'UPDATE_POSTCHECK_UNDETERMINED',
    ]);
    expect(SETTLED_RESERVATION_STATES).toEqual(['COMMITTED', 'UNKNOWN', 'RELEASED']);
    for (const list of [ACTION_RESULTS, SUBMISSION_STATES, ACTION_BLOCK_REASONS, RESPONSE_JUDGEMENTS, ACTION_OUTCOME_REASONS, SETTLED_RESERVATION_STATES]) {
      expect(Object.isFrozen(list)).toBe(true);
    }
  });

  it('uses the block reasons and every response judgement but SUCCESS as outcome reasons (no second list of the same meaning)', () => {
    const reasons: readonly string[] = ACTION_OUTCOME_REASONS;
    expect(ACTION_BLOCK_REASONS.every((reason) => reasons.includes(reason))).toBe(true);
    expect(RESPONSE_JUDGEMENTS.filter((judgement) => !reasons.includes(judgement))).toEqual(['SUCCESS']);
  });

  it('settles a reservation only to the states that the reservation transitions allow from RESERVED', () => {
    expect(SETTLED_RESERVATION_STATES.every((state) => (WRITE_RESERVATION_STATES as readonly string[]).includes(state)
      && isWriteReservationTransitionAllowed('RESERVED', state))).toBe(true);
  });
});

describe('reservation settlement (T30a)', () => {
  it.each([
    ['NOT_SENT', false, 'RELEASED'],
    ['NOT_SENT', true, 'UNKNOWN'],
    ['SENT', true, 'COMMITTED'],
    ['SENT', false, 'UNKNOWN'],
    ['UNKNOWN', true, 'UNKNOWN'],
    ['UNKNOWN', false, 'UNKNOWN'],
  ] as const)('settles %s with a response %s as %s', (submission, responseReceived, settled) => {
    expect(reservationSettlementOf(submission, responseReceived)).toBe(settled);
  });

  it('never releases a reservation unless the worker reported that the POST was not sent', () => {
    for (const submission of SUBMISSION_STATES) {
      for (const responseReceived of [true, false]) {
        const settled = reservationSettlementOf(submission, responseReceived);
        expect(settled === 'RELEASED').toBe(submission === 'NOT_SENT' && !responseReceived);
      }
    }
  });
});

/** 送って応答を受けた入力。 */
const sent = (
  responseJudgement: ResponseJudgement,
  recordId: string | null = null,
  readVerification: ReadCheckResult | null = null,
): ActionOutcomeInput => ({ submission: 'SENT', responseJudgement, recordId, readVerification });

describe('action result of an outcome (T30a)', () => {
  it.each<readonly [string, ActionOutcomeInput, string, string]>([
    ['blocked by the payload check', { submission: 'NOT_SENT', blockReason: 'PAYLOAD_MISMATCH' }, 'BLOCKED', 'PAYLOAD_MISMATCH'],
    ['blocked by a check before sending', { submission: 'NOT_SENT', blockReason: 'PRECHECK_FAILED' }, 'BLOCKED', 'PRECHECK_FAILED'],
    ['sent without a response', { submission: 'SENT', responseJudgement: null, recordId: null, readVerification: null }, 'UNKNOWN', 'NO_RESPONSE'],
    ['not known whether sent', { submission: 'UNKNOWN' }, 'UNKNOWN', 'NO_RESPONSE'],
    ['an input error', sent('INPUT_ERROR'), 'FAILED', 'INPUT_ERROR'],
    ['a 429', sent('RATE_LIMITED'), 'FAILED', 'RATE_LIMITED'],
    // T30a fix round 1（設計者の判断。設計書 11 章）: 5xx は、サーバが 5xx の前に登録を済ませていることがあるので、失敗と言い切らない。
    ['a 5xx', sent('SERVER_ERROR'), 'UNKNOWN', 'SERVER_ERROR'],
    ['no condition matched', sent('NO_CONDITION_MATCHED'), 'UNKNOWN', 'NO_CONDITION_MATCHED'],
    ['two conditions matched', sent('MULTIPLE_CONDITIONS_MATCHED'), 'UNKNOWN', 'MULTIPLE_CONDITIONS_MATCHED'],
    ['a lost session', sent('SESSION_LOST'), 'UNKNOWN', 'SESSION_LOST'],
    ['a 307 or 308 redirect (the second POST was stopped)', sent('REPOST_REDIRECT'), 'UNKNOWN', 'REPOST_REDIRECT'],
    // T30R2-fix-1（M-b）: 応答をブラウザに返せなかった（今の画面は POST の応答ではない）。
    ['a response that could not be delivered to the browser', sent('RESPONSE_NOT_DELIVERED'), 'UNKNOWN', 'RESPONSE_NOT_DELIVERED'],
    ['a success without a record id', sent('SUCCESS', null, 'MATCHED'), 'PARTIAL', 'RECORD_ID_NOT_FOUND'],
    ['a success with a matched READ', sent('SUCCESS', '42', 'MATCHED'), 'VERIFIED', 'READ_VERIFICATION_MATCHED'],
    ['a success with a READ that does not match', sent('SUCCESS', '42', 'NOT_MATCHED'), 'UNKNOWN', 'READ_VERIFICATION_NOT_MATCHED'],
    ['a success without a record id and with a READ that does not match', sent('SUCCESS', null, 'NOT_MATCHED'), 'UNKNOWN',
      'READ_VERIFICATION_NOT_MATCHED'],
    ['a success with an undetermined READ', sent('SUCCESS', '42', 'UNDETERMINED'), 'PARTIAL', 'READ_VERIFICATION_UNDETERMINED'],
    ['a success with a READ that was not run', sent('SUCCESS', '42', null), 'PARTIAL', 'READ_VERIFICATION_UNDETERMINED'],
    ['a success with a READ blocked by the policy', sent('SUCCESS', '42', 'READ_BLOCKED_BY_POLICY'), 'PARTIAL', 'READ_VERIFICATION_UNDETERMINED'],
    ['a success with a READ of a drifted candidate', sent('SUCCESS', '42', 'READ_CANDIDATE_DRIFTED'), 'PARTIAL', 'READ_VERIFICATION_UNDETERMINED'],
    ['a success with an empty record id', sent('SUCCESS', '', 'MATCHED'), 'PARTIAL', 'RECORD_ID_NOT_FOUND'],
    ['a success with a too long record id', sent('SUCCESS', 'x'.repeat(MAX_RECORD_ID_LENGTH + 1), 'MATCHED'), 'PARTIAL', 'RECORD_ID_NOT_FOUND'],
    ['a success with a record id with a line break', sent('SUCCESS', '4\n2', 'MATCHED'), 'PARTIAL', 'RECORD_ID_NOT_FOUND'],
    // T30f: 登録の ID は path の 1 区切りに入れて安全な閉じた形（英数字・`_`・`-`、1〜64 文字）だけ。外れれば `RECORD_ID_UNSAFE`。
    ['a success with a record id with a slash', sent('SUCCESS', '4/2', 'MATCHED'), 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['a success with a record id with dots', sent('SUCCESS', '..', 'MATCHED'), 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['a success with a record id with a space', sent('SUCCESS', 'ID 42', 'MATCHED'), 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['a success with a percent-encoded record id', sent('SUCCESS', '4%2F2', 'MATCHED'), 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['a success with a non-ASCII record id', sent('SUCCESS', '４２', 'MATCHED'), 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['a success with a record id over 64 characters', sent('SUCCESS', 'a'.repeat(MAX_SAFE_RECORD_ID_LENGTH + 1), 'MATCHED'), 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['a success with a 64-character record id', sent('SUCCESS', `a_-${'9'.repeat(MAX_SAFE_RECORD_ID_LENGTH - 3)}`, 'MATCHED'), 'VERIFIED',
      'READ_VERIFICATION_MATCHED'],
    ['an unsafe record id with a READ that does not match', sent('SUCCESS', '4/2', 'NOT_MATCHED'), 'UNKNOWN', 'READ_VERIFICATION_NOT_MATCHED'],
  ])('decides %s', (_label, input, result, reason) => {
    const outcome = actionOutcomeOf(input);
    expect(outcome).toEqual({ result, reason });
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it('narrows the usable record id to the closed safe form, and keeps a recordable id for the artifact (T30f)', () => {
    expect(MAX_SAFE_RECORD_ID_LENGTH).toBe(64);
    for (const usable of ['42', 'abc_DEF-9', 'a'.repeat(MAX_SAFE_RECORD_ID_LENGTH)]) {
      expect(isUsableRecordId(usable), usable).toBe(true);
      expect(usableRecordIdOf(usable)).toBe(usable);
    }
    for (const unsafe of [null, '', '4/2', '..', '.', 'a b', '4%2F2', '４２', 'a'.repeat(MAX_SAFE_RECORD_ID_LENGTH + 1), '4\n2']) {
      expect(isUsableRecordId(unsafe), String(unsafe)).toBe(false);
      expect(usableRecordIdOf(unsafe)).toBeNull();
    }
    // 記録してよい ID（成果物の `recordId`）: 1 文字以上、上限以下、制御文字・行の区切り・対でないサロゲートを含まない。形の外でも記録する（判定は
    // `RECORD_ID_UNSAFE` になる）。
    expect(recordableRecordIdOf('4/2')).toBe('4/2');
    for (const unrecordable of [null, '', '4\n2', 'x'.repeat(MAX_RECORD_ID_LENGTH + 1), '\ud800']) {
      expect(recordableRecordIdOf(unrecordable)).toBeNull();
    }
  });

  it('returns VERIFIED only for a success with a record id and a matched READ (every combination)', () => {
    for (const responseJudgement of [null, ...RESPONSE_JUDGEMENTS]) {
      for (const recordId of [null, '42']) {
        for (const readVerification of [null, ...READ_CHECK_RESULTS]) {
          const { result } = actionOutcomeOf({ submission: 'SENT', responseJudgement, recordId, readVerification });
          expect(result === 'VERIFIED').toBe(responseJudgement === 'SUCCESS' && recordId !== null && readVerification === 'MATCHED');
          expect(result === 'BLOCKED').toBe(false);
        }
      }
    }
  });

  it('returns FAILED only for an input error or a 429 (a 5xx is not a certain failure)', () => {
    const failed = RESPONSE_JUDGEMENTS.filter((responseJudgement) => actionOutcomeOf(sent(responseJudgement, '42', 'MATCHED')).result === 'FAILED');
    expect(failed).toEqual(['INPUT_ERROR', 'RATE_LIMITED']);
  });

  it('never returns BLOCKED after sending, and never returns a sent result without sending', () => {
    for (const blockReason of ACTION_BLOCK_REASONS) {
      expect(actionOutcomeOf({ submission: 'NOT_SENT', blockReason }).result).toBe('BLOCKED');
    }
    expect(actionOutcomeOf({ submission: 'UNKNOWN' }).result).toBe('UNKNOWN');
  });
});

// T31e fix round 1（Task 31 の設計書 3 章の「結果の判定」「更新の後の照合」）: UPDATE の書き込みの結果。
describe('action result of an UPDATE outcome (T31e fix round 1)', () => {
  /** UPDATE の送った入力（既定は、対象 `42` の更新で欄がすべて一致）。 */
  const updated = (
    recordId: string | null,
    fieldsMatched: boolean | null,
    readVerification: ReadCheckResult | null = 'MATCHED',
    responseJudgement: ResponseJudgement = 'SUCCESS',
  ): ActionOutcomeInput => ({ submission: 'SENT', responseJudgement, recordId, readVerification, update: { targetRecordId: '42', fieldsMatched } });

  it.each<readonly [string, ActionOutcomeInput, string, string]>([
    ['an update of the target with every field matched', updated('42', true), 'VERIFIED', 'READ_VERIFICATION_MATCHED'],
    ['an update with another record id', updated('43', true), 'UNKNOWN', 'RECORD_ID_MISMATCH'],
    ['an update with a field that changed unexpectedly', updated('42', false), 'UNKNOWN', 'UNEXPECTED_FIELD_CHANGE'],
    ['an unexpected change without a record id', updated(null, false), 'UNKNOWN', 'UNEXPECTED_FIELD_CHANGE'],
    ['an unexpected change with another record id', updated('43', false), 'UNKNOWN', 'UNEXPECTED_FIELD_CHANGE'],
    // T31f: 更新の後の照合を判定できない（証拠がない・照合できない欄がある）ときは、専用の理由（READ の判定できないとは分ける）。
    ['an update whose fields could not be checked', updated('42', null), 'PARTIAL', 'UPDATE_POSTCHECK_UNDETERMINED'],
    ['an update whose fields and READ could not be checked', updated('42', null, 'UNDETERMINED'), 'PARTIAL', 'UPDATE_POSTCHECK_UNDETERMINED'],
    ['an update without a record id', updated(null, true), 'PARTIAL', 'RECORD_ID_NOT_FOUND'],
    ['an update with an unsafe record id', updated('4/2', true), 'PARTIAL', 'RECORD_ID_UNSAFE'],
    ['an update whose READ did not match', updated('42', true, 'NOT_MATCHED'), 'UNKNOWN', 'READ_VERIFICATION_NOT_MATCHED'],
    ['an update whose READ could not be judged', updated('42', true, 'UNDETERMINED'), 'PARTIAL', 'READ_VERIFICATION_UNDETERMINED'],
    ['an update with an input error', updated(null, null, null, 'INPUT_ERROR'), 'FAILED', 'INPUT_ERROR'],
  ])('%s', (_label, input, result, reason) => {
    expect(actionOutcomeOf(input)).toEqual({ result, reason });
  });
});

// T31g-2（T31f の共通化の候補 2）: 更新の後の照合の結果（締め `scenario-store.ts` とワーカーが使う唯一の判定）。
describe('fields matched of the update evidence (T31g-2)', () => {
  const fieldOf = (matched: boolean | null) => ({ fieldName: 'f', role: 'KEPT' as const, previousValue: null, newValue: null, matched });
  it.each([
    ['no evidence', null, null],
    ['an evidence without fields', { fields: [] }, null],
    ['all fields matched', { fields: [fieldOf(true), fieldOf(true)] }, true],
    ['a field that did not match', { fields: [fieldOf(true), fieldOf(false), fieldOf(null)] }, false],
    ['a field that could not be checked', { fields: [fieldOf(true), fieldOf(null)] }, null],
  ] as const)('%s', (_label, evidence, expected) => {
    expect(fieldsMatchedOf(evidence)).toBe(expected);
  });
});
