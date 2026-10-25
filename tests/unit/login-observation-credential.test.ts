// T43R-fix の C-1 (c)（Task 43 の設計書 7 章の T43R の行）: 自動ログインのログインの段の観察の案（成功の鍵の名前の接頭辞と接尾辞、成功の画面のセレクタ）を、
// 入れた資格情報と照らす。比べは資格情報の守りの部品の比べる口（`carriesLoginCredentialInTexts`。要求の比べと同じ比べる形）で、ワーカーは渡された関数で
// 捨てるだけ（`withoutCredentialProposals`）。捨てた数だけを記録する。値を入れる前と捨てた部品は、どの案も含むとみなす（fail-closed）。
// 例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import {
  armLoginCredentialGuard,
  carriesLoginCredentialInTexts,
  createLoginCredentialGuard,
  createPendingLoginCredentialGuard,
  discardLoginCredentialGuard,
} from '../../src/safety/login-credential-guard.js';
import { withoutCredentialProposals } from '../../src/worker/login-stage-observation.js';

const USERNAME = 'entryuser';
const PASSWORD = 'hunter2pass';

describe('T43R-fix C-1 (c): the observation proposals are checked against the login credential', () => {
  it('finds the user name or the password in the texts in the compared forms, and nothing else', () => {
    const guard = createLoginCredentialGuard({ username: USERNAME, password: PASSWORD });
    expect(carriesLoginCredentialInTexts(guard, [`${USERNAME}.`])).toBe(true);
    expect(carriesLoginCredentialInTexts(guard, [`.${encodeURIComponent(PASSWORD)}x`])).toBe(true);
    expect(carriesLoginCredentialInTexts(guard, ['#ENTRYUSER-logout'])).toBe(true);
    expect(carriesLoginCredentialInTexts(guard, ['fixture-', '-token', '#logout'])).toBe(false);
  });

  // T43R2-fix（Task 43 の設計書 7 章の最後の行）: 逆向きの比べ。ユーザー名を区切り（`.`・`:`・`_`・`/`・`-`）と `@` で分けた 4 文字以上の部分が、案の文字列の
  // 部分（同じ区切りで分けたもの）と一致すれば含むとみなす（NFKC と大文字小文字を畳む）。メールの形・ローカル部・大文字小文字の違いを捨てる。
  it('finds a part of the user name in a part of the texts, folding NFKC and the case', () => {
    const email = createLoginCredentialGuard({ username: 'alice@example.com', password: PASSWORD });
    for (const texts of [['alice@example.'], [':alice'], ['.Alice'], ['ＡＬＩＣＥ.'], ['.example'], ['ALICE@EXAMPLE.COM:']]) {
      expect(carriesLoginCredentialInTexts(email, texts), JSON.stringify(texts)).toBe(true);
    }
    // 4 文字より短い部分（`com`）と、一般の語の案は含まない。
    for (const texts of [['.com'], [':token'], ['-token', 'session.'], ['#logout']]) {
      expect(carriesLoginCredentialInTexts(email, texts), JSON.stringify(texts)).toBe(false);
    }
    const plain = createLoginCredentialGuard({ username: 'EntryUser', password: PASSWORD });
    expect(carriesLoginCredentialInTexts(plain, ['.entryuser'])).toBe(true);
    expect(carriesLoginCredentialInTexts(plain, ['entryuser.'])).toBe(true);
  });

  it('treats every text as carrying the credential before the values are put in and after they are discarded', () => {
    const pending = createPendingLoginCredentialGuard();
    expect(carriesLoginCredentialInTexts(pending, ['#logout'])).toBe(true);
    armLoginCredentialGuard(pending, { username: USERNAME, password: PASSWORD });
    expect(carriesLoginCredentialInTexts(pending, ['#logout'])).toBe(false);
    discardLoginCredentialGuard(pending);
    expect(carriesLoginCredentialInTexts(pending, ['#logout'])).toBe(true);
  });

  it('discards the proposals that carry the credential and counts them', () => {
    const guard = createLoginCredentialGuard({ username: USERNAME, password: PASSWORD });
    const carries = (texts: readonly string[]): boolean => carriesLoginCredentialInTexts(guard, texts);
    const observation = {
      storageKeys: { origin: 'http://127.0.0.1:4173', shapes: [{ prefix: `${USERNAME}.`, suffix: '.idToken' }, { prefix: 'fixture-', suffix: '-token' }], omitted: 0 },
      successSelector: { selector: `#${USERNAME}-logout`, kind: 'LOGOUT_CONTROL' as const, logoutWord: 'logout' },
    };
    const kept = withoutCredentialProposals(observation, carries);
    expect(kept).toEqual({
      storageKeys: { origin: 'http://127.0.0.1:4173', shapes: [{ prefix: 'fixture-', suffix: '-token' }], omitted: 0 },
      credentialDiscarded: 2,
    });
    expect(JSON.stringify(kept)).not.toContain(USERNAME);
    expect(withoutCredentialProposals({ successSelector: observation.successSelector }, carries)).toEqual({ credentialDiscarded: 1 });
    expect(withoutCredentialProposals(undefined, carries)).toBeUndefined();
    expect(withoutCredentialProposals({ successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' } }, carries))
      .toEqual({ successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' } });
  });

  // FM2e: ログインの欄の案は手動のログインの段だけが持つ（IPC の契約も自動ログインの結果では拒む）。自動ログインの段の照らしは、案を残さない。
  it('never keeps the login field proposals in the observation of the automated login', () => {
    const guard = createLoginCredentialGuard({ username: USERNAME, password: PASSWORD });
    const carries = (texts: readonly string[]): boolean => carriesLoginCredentialInTexts(guard, texts);
    const loginFields = { username: '#email', password: '#password', submit: '#login' };
    expect(withoutCredentialProposals({ loginFields }, carries)).toBeUndefined();
    expect(withoutCredentialProposals({ successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' }, loginFields }, carries))
      .toEqual({ successSelector: { selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' } });
  });
});
