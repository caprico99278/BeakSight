// FM2e（手を減らす段 2 の設計書 3A.4）: 手動のログインの段の観察のログインの欄の案（`loginFields`）から、自動ログインの設定の画面の 3 つのセレクタの案を
// 作る（`loginFieldDraftsOf`。純粋な部品）。案には推測の印と根拠（`LOGIN_FIELD_SINGLE_CANDIDATE`。出どころは `INFERRED`）を付ける。案のない欄は `null`。
// 認証の設定として受けない形の CSS は案にしない（信用しない値の読み直し）。例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import { DRAFT_VALUE_GROUND_ORIGINS } from '../../src/control/approval/draft-value-origin.js';
import { loginFieldDraftsOf } from '../../src/control/login-observation-draft.js';
import { DRAFT_VALUE_TEXT } from '../../src/presentation/messages.js';

const inferred = (value: string) => ({ value, origin: 'INFERRED', ground: 'LOGIN_FIELD_SINGLE_CANDIDATE' });

describe('FM2e: the selector drafts of the automated login from the login field proposals', () => {
  it('marks the ground as inferred, with the text', () => {
    expect(DRAFT_VALUE_GROUND_ORIGINS.LOGIN_FIELD_SINGLE_CANDIDATE).toBe('INFERRED');
    expect(DRAFT_VALUE_TEXT.grounds.LOGIN_FIELD_SINGLE_CANDIDATE.length).toBeGreaterThan(0);
  });

  it('makes a draft of each proposed field with the inferred mark, and none for a field without a proposal', () => {
    expect(loginFieldDraftsOf({ loginFields: { username: '#email', password: 'input[name="password"]', submit: null } })).toEqual({
      username: inferred('#email'),
      password: inferred('input[name="password"]'),
      submit: null,
    });
  });

  it('makes no draft without the proposals, or with a CSS that the auth setup does not accept', () => {
    expect(loginFieldDraftsOf(undefined)).toBeNull();
    expect(loginFieldDraftsOf({ successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' } })).toBeNull();
    expect(loginFieldDraftsOf({ loginFields: { username: 'text=メール', password: '#password', submit: '#a\n#b' } })).toEqual({
      username: null,
      password: inferred('#password'),
      submit: null,
    });
    expect(loginFieldDraftsOf({ loginFields: { username: 'text=メール', password: null, submit: null } })).toBeNull();
  });
});
