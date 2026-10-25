// T43d（Task 43 の設計書 3 章、4.4）: 手動のログインで観察したことの記録の純粋な部品（`src/discovery/login-observation.ts`）。
// - 止めた要求の query: 名前の一覧（値なし。上限つき。値に見える名前・長すぎる名前は伏せる）と、閉じた一覧の名前（今は `grant_type` だけ）の値。値は
//   決まった形（英数字と `_.:-`、上限の長さ、値に見えない）のときだけ残す。同じ名前が 2 回あれば値を残さない。
// - 成功の鍵の名前の差分: ログインの段の始めになく終わりにある名前の、接頭辞と接尾辞の案だけ（T43R-fix の C-1 (a)。値と名前の全体は残さない）。
// - 成功の画面のセレクタの案: ログアウトの要素の、ログアウトの語を含む属性から作った CSS だけ（T43R-fix の C-1 (b)）。ログインの画面にもあった CSS は外し、
//   その画面でちょうど 1 つに当たり、読んだ要素を指す最初の CSS。見つからなければ案を出さない。リンクの `href` の CSS は、`/` で始まり query・fragment・
//   値に見える区切りのない短い値だけ。
// 例の値は匿名の値だけ。
import { describe, expect, it } from 'vitest';
import { REDACTED_PATH_SEGMENT } from '../../src/core/url-path-redaction.js';
import {
  LOGIN_OBSERVED_QUERY_VALUE_NAMES,
  MAX_LOGIN_OBSERVED_QUERY_NAMES,
  MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH,
  MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH,
  LOGIN_OBSERVED_KEY_SEPARATORS,
  MAX_LOGIN_OBSERVED_KEY_PART_LENGTH,
  MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES,
  MIN_LOGIN_OBSERVED_KEY_PART_LENGTH,
  SUCCESS_SELECTOR_CANDIDATE_KINDS,
  isLoginObservedQueryName,
  isLoginObservedQueryValue,
  isLoginObservedStorageKeyShape,
  isLoginObservedSuccessSelector,
  isLogoutAttributeValue,
  loginObservedQueryOf,
  mergeLoginObservedQuery,
  newStorageKeyShapesOf,
  storageKeyShapeOf,
  successSelectorCandidatesOf,
  successSelectorProposalOf,
} from '../../src/discovery/login-observation.js';
import { DISCOVERY_LOGOUT_GENERAL_WORDS } from '../../src/discovery/classification-words.js';

/** URL の search の文字列から、記録の query を作る（部品は `URL` の `searchParams` の組を受ける）。 */
const queryOf = (search: string) => loginObservedQueryOf(new URLSearchParams(search));

/** 値に見える文字列（JWT の形）。 */
const JWT_LIKE = 'eyJtYXJrZXIiOiJ0NDNkIn0.eyJzdWIiOiJleGFtcGxlIn0.bWFya2VyLXNpZ25hdHVyZQ';
/** 値に見える文字列（16 進 40 字）。 */
const HEX_LIKE = 'a'.repeat(8) + '0123456789abcdef0123456789abcdef';

describe('T43d: the query names and the closed list value of a blocked request', () => {
  it('has the closed list and the limits', () => {
    expect(LOGIN_OBSERVED_QUERY_VALUE_NAMES).toEqual(['grant_type']);
    expect(Object.isFrozen(LOGIN_OBSERVED_QUERY_VALUE_NAMES)).toBe(true);
    expect(MAX_LOGIN_OBSERVED_QUERY_NAMES).toBe(4);
    expect(MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH).toBe(64);
    expect(MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH).toBe(32);
  });

  it('keeps the names without values, and the grant_type value only', () => {
    expect(queryOf('?grant_type=password&redirect=%2Fadmin&email=someone%40example.invalid')).toEqual({
      names: ['email', 'grant_type', 'redirect'],
      omitted: 0,
      values: [{ name: 'grant_type', value: 'password' }],
    });
    expect(queryOf('')).toBeNull();
    expect(queryOf('?')).toBeNull();
    expect(JSON.stringify(queryOf('?redirect=%2Fadmin&email=someone%40example.invalid'))).not.toContain('example.invalid');
  });

  it('hides a value-like name and a long name, and counts the names over the limit', () => {
    const query = queryOf(`?${JWT_LIKE}=1&${'n'.repeat(MAX_LOGIN_OBSERVED_QUERY_NAME_LENGTH + 1)}=2&a=1&b=2&c=3&d=4`);
    // 伏せた名前は 1 つにまとまる（重ならない名前の数で数える）。
    expect(query).toEqual({ names: [REDACTED_PATH_SEGMENT, 'a', 'b', 'c'], omitted: 1, values: [] });
    expect(JSON.stringify(query)).not.toContain(JWT_LIKE);
  });

  it('does not keep the grant_type value when it is not a short fixed word, or when it is given twice', () => {
    expect(queryOf(`?grant_type=${JWT_LIKE}`)?.values).toEqual([]);
    expect(queryOf(`?grant_type=${HEX_LIKE}`)?.values).toEqual([]);
    expect(queryOf(`?grant_type=${'p'.repeat(MAX_LOGIN_OBSERVED_QUERY_VALUE_LENGTH + 1)}`)?.values).toEqual([]);
    expect(queryOf('?grant_type=pass%20word')?.values).toEqual([]);
    expect(queryOf('?grant_type=password&grant_type=refresh_token')?.values).toEqual([]);
    expect(queryOf('?grant_type=')?.values).toEqual([]);
    expect(queryOf('?Grant_Type=password')?.values).toEqual([]);
    expect(queryOf('?grant_type=refresh_token')?.values).toEqual([{ name: 'grant_type', value: 'refresh_token' }]);
  });

  it('merges the names of the same row, keeping the limit and the omitted count', () => {
    const first = queryOf('?grant_type=password&a=1');
    const merged = mergeLoginObservedQuery(first, queryOf('?b=1&c=2&d=3'));
    expect(merged).toEqual({ names: ['a', 'b', 'c', 'grant_type'], omitted: 1, values: [{ name: 'grant_type', value: 'password' }] });
    expect(mergeLoginObservedQuery(null, null)).toBeNull();
    expect(mergeLoginObservedQuery(null, first)).toEqual(first);
  });

  it('checks a recorded name and a recorded value', () => {
    expect(isLoginObservedQueryName('grant_type')).toBe(true);
    expect(isLoginObservedQueryName(REDACTED_PATH_SEGMENT)).toBe(true);
    expect(isLoginObservedQueryName(JWT_LIKE)).toBe(false);
    expect(isLoginObservedQueryName('')).toBe(false);
    expect(isLoginObservedQueryName('a\nb')).toBe(false);
    expect(isLoginObservedQueryValue('grant_type', 'password')).toBe(true);
    expect(isLoginObservedQueryValue('redirect', 'password')).toBe(false);
    expect(isLoginObservedQueryValue('grant_type', JWT_LIKE)).toBe(false);
  });
});

// T43R-fix の C-1 (a)（意図して直した期待。Task 43 の設計書 7 章の T43R の行）: 鍵の名前の全体は残さず、区切りで分けた最初と最後の部分だけを、接頭辞と
// 接尾辞の案にする（間の部分に入りうる利用者の名前や ID を残さない）。
describe('T43R-fix C-1 (a): the prefix and the suffix of the new local storage keys (the success key name)', () => {
  const USER = 'entry-user';

  it('has the limits and the separators', () => {
    expect(MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES).toBe(4);
    expect(LOGIN_OBSERVED_KEY_SEPARATORS).toEqual(['.', ':', '_', '/', '-']);
    expect(MIN_LOGIN_OBSERVED_KEY_PART_LENGTH).toBe(2);
    expect(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH).toBe(64);
  });

  // T43R2-fix（意図して直した期待。Task 43 の設計書 7 章の最後の行）: 最初と最後の部分は、閉じた一覧の一般の語（`LOGIN_STORAGE_KEY_GENERAL_WORDS`）に
  // 当たる側だけを出す（NFKC と大文字小文字を畳んで比べる）。当たらない側は空。両方とも当たらなければ案を出さない（利用者の名前が端に来る形を残さない）。
  it('keeps only the end parts that are the general words, and a user name at either end is nowhere', () => {
    expect(storageKeyShapeOf('fixture-auth-token')).toEqual({ prefix: '', suffix: '-token' });
    expect(storageKeyShapeOf(`LibAuth.clientid0123456789abc.${USER}.idToken`)).toEqual({ prefix: '', suffix: '.idToken' });
    expect(storageKeyShapeOf('entryuser.session.token')).toEqual({ prefix: '', suffix: '.token' });
    expect(storageKeyShapeOf('alice@example.com:session:token')).toEqual({ prefix: '', suffix: ':token' });
    expect(storageKeyShapeOf('alice/auth/token')).toEqual({ prefix: '', suffix: '/token' });
    expect(storageKeyShapeOf('session.x.refresh')).toEqual({ prefix: 'session.', suffix: '.refresh' });
    expect(storageKeyShapeOf('ＳＥＳＳＩＯＮ:alice')).toEqual({ prefix: 'ＳＥＳＳＩＯＮ:', suffix: '' });
    // 区切りが 1 つで両側とも一般の語なら、重ならないように後ろの側だけ。
    expect(storageKeyShapeOf('auth-token')).toEqual({ prefix: '', suffix: '-token' });
    const shapes = newStorageKeyShapesOf(['theme'], ['theme', `LibAuth.clientid0123456789abc.${USER}.idToken`, `LibAuth.clientid0123456789abc.${USER}.accessToken`,
      'fixture-auth-token', 'app.session.entryuser']);
    expect(shapes).toEqual({
      shapes: [{ prefix: '', suffix: '-token' }, { prefix: '', suffix: '.accessToken' }, { prefix: '', suffix: '.idToken' }],
      omitted: 1,
    });
    for (const marker of [USER, 'clientid', 'entryuser', 'LibAuth', 'fixture']) {
      expect(JSON.stringify(shapes)).not.toContain(marker);
    }
  });

  it('gives no proposal when neither end is a general word, or for a name without a separator, a value-like end part, or a name already there', () => {
    for (const name of ['hunter2', 'token', `${USER}`, 'app.session.entryuser', 'app:token:alice', 'user_alice_profile', 'LibAuth.x.LastAuthUser',
      `${HEX_LIKE}.x.alice`, `alice.x.${HEX_LIKE}`, `${'k'.repeat(MAX_LOGIN_OBSERVED_KEY_PART_LENGTH + 1)}.x.alice`]) {
      expect(storageKeyShapeOf(name), name).toBeNull();
    }
    expect(newStorageKeyShapesOf(['theme'], ['theme'])).toBeNull();
    expect(newStorageKeyShapesOf([], ['app:token:alice', 'fixture-auth-token'])).toEqual({ shapes: [{ prefix: '', suffix: '-token' }], omitted: 1 });
  });

  it('counts the proposals over the limit, and checks a recorded shape', () => {
    const shapes = newStorageKeyShapesOf([], ['a1.x.token', 'a2.x.auth', 'a3.x.session', 'a4.x.jwt', 'a5.x.access']);
    expect(shapes?.shapes).toHaveLength(MAX_LOGIN_OBSERVED_STORAGE_KEY_NAMES);
    expect(shapes?.omitted).toBe(1);
    for (const shape of [{ prefix: '', suffix: '-token' }, { prefix: 'session.', suffix: '' }, { prefix: 'auth:', suffix: '.idToken' }]) {
      expect(isLoginObservedStorageKeyShape(shape), JSON.stringify(shape)).toBe(true);
    }
    for (const shape of [
      { prefix: '', suffix: '' }, { prefix: 'fixture-', suffix: '-token' }, { prefix: '', suffix: '.entryuser' }, { prefix: '', suffix: 'token' },
      { prefix: 'session', suffix: '' }, { prefix: '', suffix: `-${USER}.token` }, { prefix: '-', suffix: '' }, { prefix: `${JWT_LIKE}.`, suffix: '' },
    ]) {
      expect(isLoginObservedStorageKeyShape(shape), JSON.stringify(shape)).toBe(false);
    }
  });
});

// T43R-fix の C-1 (b)（意図して直した期待）: 成功の画面のセレクタの案は、ログアウトの要素の、ログアウトの語を含む属性から作った CSS だけ。残りは閉じた一覧の
// 一般の語と区切りだけ。nav・header の中の要素の案はやめた。
describe('T43R-fix C-1 (b): the proposal of the success screen selector from the logout attributes only', () => {
  const USER = 'entry-user';
  const logout = { logoutWord: 'logout' };
  const check = (selector: string, matches = 1, matchesElement = true) => ({ selector, matches, matchesElement });

  it('has the logout control kind only, and the general words in the closed list', () => {
    expect(SUCCESS_SELECTOR_CANDIDATE_KINDS).toEqual(['LOGOUT_CONTROL']);
    expect(DISCOVERY_LOGOUT_GENERAL_WORDS).toContain('button');
    expect(Object.isFrozen(DISCOVERY_LOGOUT_GENERAL_WORDS)).toBe(true);
  });

  it('builds the CSS only from the attributes with a logout word and the general words', () => {
    expect(successSelectorCandidatesOf({ tag: 'a', id: 'logout', name: '', type: '', href: '/menu/logout' })).toEqual(['#logout', 'a[href="/menu/logout"]']);
    // 一般の語の一覧にない語（`auth` など）を含む href は使わない（id は使う）。
    expect(successSelectorCandidatesOf({ tag: 'a', id: 'logout', name: '', type: '', href: '/auth/logout' })).toEqual(['#logout']);
    expect(successSelectorCandidatesOf({ tag: 'button', id: 'btnLogout', name: 'sign-out', type: 'button', href: '' }))
      .toEqual(['#btnLogout', 'button[name="sign-out"]']);
    // 利用者の名前が入る属性、ログアウトの語のない属性、type の CSS は案にしない。
    expect(successSelectorCandidatesOf({ tag: 'a', id: `profile-${USER}`, name: '', type: '', href: `/users/${USER}` })).toEqual([]);
    expect(successSelectorCandidatesOf({ tag: 'a', id: `logout-${USER}`, name: '', type: '', href: `/logout/${USER}` })).toEqual([]);
    expect(successSelectorCandidatesOf({ tag: 'button', id: 'home', name: 'menu', type: 'button', href: '' })).toEqual([]);
    expect(isLogoutAttributeValue('help-logout')).toBe(false);
    expect(isLogoutAttributeValue('LogoutButton')).toBe(true);
    // query、fragment、値に見える区切り、`/` で始まらない値、長い値の href は使わない。
    for (const href of ['/logout?next=%2F', '/logout#top', `/session/${JWT_LIKE}/logout`, 'https://example.invalid/logout', 'logout', `/${'l'.repeat(200)}/logout`]) {
      expect(successSelectorCandidatesOf({ tag: 'a', id: '', name: '', type: '', href })).toEqual([]);
    }
  });

  it('checks a recorded selector', () => {
    for (const selector of ['#logout', '#logout-btn', 'button[name="signout"]', 'a[href="/logout"]', 'a[href="/menu/logout"]']) {
      expect(isLoginObservedSuccessSelector(selector), selector).toBe(true);
    }
    for (const selector of [`#profile-${USER}`, `a[href="/users/${USER}"]`, 'button[type="button"]', '#\\-', 'text=logout', '#logout, #x', '#home']) {
      expect(isLoginObservedSuccessSelector(selector), selector).toBe(false);
    }
  });

  it('takes the first CSS that matches exactly the read element, leaving out the CSS of the login page', () => {
    expect(successSelectorProposalOf([{ ...logout, checks: [check('a[href="/logout"]', 2, false), check('#logout')] }], new Set()))
      .toEqual({ selector: '#logout', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' });
    expect(successSelectorProposalOf([{ ...logout, checks: [check('#logout')] }, { ...logout, checks: [check('#logout-btn')] }], new Set(['#logout'])))
      .toEqual({ selector: '#logout-btn', kind: 'LOGOUT_CONTROL', logoutWord: 'logout' });
    expect(successSelectorProposalOf([{ ...logout, checks: [check('#logout', 1, false)] }], new Set())).toBeNull();
    expect(successSelectorProposalOf([], new Set())).toBeNull();
  });
});
