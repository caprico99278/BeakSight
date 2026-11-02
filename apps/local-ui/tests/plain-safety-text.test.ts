/**
 * PL-S（設計書 `doc/design/2026-10-26-beaksight-plain-ui-design.md` 7 章・9 章）: 安全のために人が決めることを、やさしい言葉で出す文言（カタログ）を固定する。
 * 画面に出ることは、それぞれの画面のテスト（`scenario-ui`・`automated-login-setup-ui`・`audit-send-settings-ui`）が確かめる。ここでは文の中身だけを見る。
 * - 書き込みの結果が分からないとき、BeakSight はデータを消さないこと（7 章の表の文）。OP-3（設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1 の D6）:
 *   隔離が未確認の注意は、すべて消した（カタログに戻さない）。
 * - 書き込みの OK のダイアログの「何を・どこへ・何件」（9 章の 3）と、副作用の 4 つの約束が現在形で、確かめてから押す形（9 章の 4）。
 * - 自動ログインにする確定のダイアログの、送る先・テスト用のアカウント・保存の場所・回数の決まり（9 章の 2。数は定義元の定数から）。
 * - 「削除のほかを通す」がオンの印（9 章の 5）。
 */
import { describe, expect, it } from 'vitest';
import { AUTO_LOGIN_DAILY_MAX_ATTEMPTS, AUTO_LOGIN_DAILY_WINDOW_MS, AUTO_LOGIN_MIN_INTERVAL_MS } from '../../../src/control/job/auto-login-limits.js';
import { DAY_MS, MINUTE_MS } from '../../../src/core/time-units.js';
import { SIDE_EFFECT_CONFIRMATION_CATALOG } from '../../../src/presentation/catalog.js';
import { formatInteger } from '../../../src/presentation/format.js';
import { ISOLATION_NOTICE_FRAGMENT } from './helpers/screen-shape.ts';
import {
  LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT,
  LOCAL_UI_DISPLAY_SETTINGS_TEXT,
  LOCAL_UI_SCENARIO_TEXT,
  LOCAL_UI_WRITE_TEXT,
} from '../../../src/presentation/messages.js';

const writeText = LOCAL_UI_WRITE_TEXT;
const approveDialog = LOCAL_UI_SCENARIO_TEXT.approveDialog;
const automatedDialog = LOCAL_UI_AUTOMATED_LOGIN_SETUP_TEXT.dialog;

describe('PL-S: the plain safety text of the write screens', () => {
  it('has no notice about the isolation of the test site any more (D6)', () => {
    expect(writeText).not.toHaveProperty('isolationUnverified');
    for (const value of Object.values(writeText)) {
      expect(typeof value === 'string' ? value : '').not.toContain(ISOLATION_NOTICE_FRAGMENT);
    }
  });

  it('tells what, where and how many on the approval dialog, and that a sent write cannot be undone', () => {
    expect(approveDialog.targetCreate('/admin/members/new', formatInteger(1)))
      .toBe('/admin/members/new の画面で、作り物のデータを 1 件登録します。送ったら取り消せません。');
    expect(approveDialog.targetUpdate('/admin/members/1/edit', formatInteger(1)))
      .toBe('/admin/members/1/edit の画面で、作り物のデータで 1 件更新します。送ったら取り消せません。');
  });

  it('writes the four promises in the present tense, to be checked before pressing, and "やめる" if one is wrong', () => {
    for (const spec of Object.values(SIDE_EFFECT_CONFIRMATION_CATALOG)) {
      expect(spec.description ?? '', spec.label).not.toMatch(/確かめました/u);
    }
    expect(approveDialog.sideEffectsNote).toContain('4 つとも本当か確かめてから');
    expect(approveDialog.sideEffectsNote).toContain(`1 つでも違えば「${approveDialog.cancel}」`);
    expect(approveDialog.sideEffectsNote).not.toMatch(/確かめたことにして/u);
  });

  it('tells plainly that the result of a write is unknown, and that BeakSight does not delete the data it made', () => {
    expect(`${writeText.unknownHeading}。${writeText.unknownBody}`)
      .toContain('送ったかどうか分かりません。テスト用のサイトでデータがあるか確かめてください。');
    expect(writeText.noCleanup).toBe('作ったデータは消しません。片付けはテスト用のサイトの管理者に頼んでください。');
  });
});

describe('PL-S: the plain safety text of the dialog that switches to the automated login', () => {
  it('tells where the password goes by the host only, the test account only, the place of the storage and the limits from the owner', () => {
    expect(automatedDialog.destination('127.0.0.1:4173')).toBe('パスワードを入れる先: 手でログインしたときと同じ、127.0.0.1:4173 のログインの画面です。');
    expect(automatedDialog.testAccountOnly).toBe('テスト用のアカウントだけを入れてください。本番のパスワードは入れないでください。');
    expect(automatedDialog.storage).toBe('パスワードは、このパソコンの中に、今のユーザーだけが開ける形で保存します。');
    const limits = automatedDialog.limits(
      formatInteger(AUTO_LOGIN_MIN_INTERVAL_MS / MINUTE_MS),
      formatInteger(AUTO_LOGIN_DAILY_WINDOW_MS / DAY_MS),
      formatInteger(AUTO_LOGIN_DAILY_MAX_ATTEMPTS),
    );
    expect(limits).toBe('自動ログインは 5 分に 1 回、1 日に 10 回までです。うまくいかないと止まり、あなたが確かめるまで再開しません。');
  });
});

// OP-I（I1。設計書 `2026-10-27-beaksight-one-pass-flow-design.md` 4.1.5）: 「削除のほかを通す」はサイトの既定になったので、要点の「守りを緩めています」の印は
// なくした（カタログからも消した）。切り替えの説明は、既定が通す側であることを言う。
describe('OP-I: the audit send policy passes the sends except deletes by default', () => {
  it('has no relaxed mark, and the hint tells the default and how to go back to the reading only', () => {
    expect(Object.hasOwn(LOCAL_UI_DISPLAY_SETTINGS_TEXT, 'auditSendRelaxed')).toBe(false);
    expect(LOCAL_UI_DISPLAY_SETTINGS_TEXT.auditSendHint.startsWith('既定は通す側です。')).toBe(true);
    expect(LOCAL_UI_DISPLAY_SETTINGS_TEXT.auditSendHint).toContain('削除と危険な語の送信は止めます。');
    expect(LOCAL_UI_DISPLAY_SETTINGS_TEXT.auditSendHint).toContain('外すと見るだけになります');
  });
});
