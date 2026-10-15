// T25g-4（独立レビュー T25R の M4 の続き）: ログインの送信先への送信を止めたとき（`LOGIN_ATTEMPTS_EXCEEDED`）の画面の文言をそろえる。
// 送信を止めた記録は、回数の上限を超えた場合のほか、BeakSight が扱えない形のログイン（JavaScript の fetch で送るログインなど）の場合にも残る。
// - ジョブの画面のログインの状態の説明（`AUDIT_JOB_AUTH_STATE_CATALOG`）と、ジョブの失敗の理由の説明（`AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS`）の
//   両方が、2 つの場合を言う（画面に食い違う説明が並ばない）。
// - 失敗の理由の手順が、2 つの場合のどちらにも合う（フォームの送信でログインするかを確かめ、そうなら資格情報と回数の上限を確かめる）。
// - ラベル、順、色は変えない。
import { describe, expect, it } from 'vitest';
import { AUDIT_JOB_AUTH_STATE_CATALOG } from '../../src/presentation/catalog.js';
import { AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS } from '../../src/presentation/messages.js';

/** 2 つの場合を言う語（回数の上限と、扱えない形のログイン）。 */
const ATTEMPT_LIMIT_PHRASE = '回数の上限';
const UNSUPPORTED_LOGIN_PHRASE = 'BeakSight が扱えない形のログイン';
/** 手順の、扱えない形のログインかを確かめる語と、回数の上限の場合の語。 */
const FORM_SUBMISSION_PHRASE = 'フォームの送信';
const CREDENTIALS_PHRASE = '資格情報';

describe('T25g-4: the screen texts of LOGIN_ATTEMPTS_EXCEEDED agree', () => {
  it('says both cases in the auth state description and in the failure reason description', () => {
    for (const description of [
      AUDIT_JOB_AUTH_STATE_CATALOG.LOGIN_ATTEMPTS_EXCEEDED.description,
      AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.LOGIN_ATTEMPTS_EXCEEDED.description,
    ]) {
      expect(description).toContain(ATTEMPT_LIMIT_PHRASE);
      expect(description).toContain(UNSUPPORTED_LOGIN_PHRASE);
    }
  });

  it('gives an action that fits both cases', () => {
    const { action } = AUDIT_JOB_FAILURE_REASON_DESCRIPTIONS.LOGIN_ATTEMPTS_EXCEEDED;
    expect(action).toContain(FORM_SUBMISSION_PHRASE);
    expect(action).toContain(CREDENTIALS_PHRASE);
    expect(action).toContain(ATTEMPT_LIMIT_PHRASE);
  });

  it('keeps the label, the order and the tone of the auth state', () => {
    const { label, order, tone } = AUDIT_JOB_AUTH_STATE_CATALOG.LOGIN_ATTEMPTS_EXCEEDED;
    expect({ label, order, tone }).toEqual({ label: 'ログインの回数の上限', order: 7, tone: 'critical' });
  });
});
