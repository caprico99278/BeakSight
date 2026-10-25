// T41a（Task 41 の設計書 3.1 の「秘密に見える名前の語」）: 秘密に見える名前の方針 6（API の本文の鍵の名前。`src/core/secret-query-names.ts` の一覧、
// 判定は `src/discovery/classify.ts` の `isApiWriteKeyNameSecretLike`）に足した語と、結合文字の形の比べ。
// - 部分一致で足す語: `privkey`・`passwort`・`encryptionkey`・`licensekey`・`hmac`・`securitycode`・`秘密鍵`・`暗証`・`セッション`。
// - 語の単位で足す語: `pw`・`salt`・`ssn`（部分一致にすると `salty`・`basalt`・`classname` などにも当たる）。
// - 足さない語: `refresh`・`card_number`（正当な欄に当たる）。
// - 結合文字の形: NFD にして結合文字を除いた形でも比べる（`tóken` の結合文字の形、`sálť` など）。部品は `src/core/text.ts` の `stripCombiningMarks`。
import { describe, expect, it } from 'vitest';
import {
  API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES,
  API_WRITE_SECRET_LIKE_KEY_SEGMENTS,
  API_WRITE_SECRET_LIKE_KEY_WORDS,
} from '../../src/core/secret-query-names.js';
import { stripCombiningMarks } from '../../src/core/text.js';
import { isApiWriteKeyNameSecretLike } from '../../src/discovery/classify.js';

// T44g（Task 44 の設計書 P4-2。設計者の判断）: 誤検知の語を、名前つきの閉じた一覧（`API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES`）で除く。比べ方は今の部分一致の
// まま、鍵の名前の比べる形（NFKC と大文字小文字を畳み、文字と数字以外を除いた形）が一覧の語にちょうど当たる鍵だけを除く。`session_count`・`hmac_ok` は除かない。
describe('T44g: the excluded false positives of the secret-like names of the API body keys (policy 6, P4-2)', () => {
  it('lists author and footprint as the excluded names', () => {
    expect([...API_WRITE_SECRET_LIKE_KEY_EXCLUDED_NAMES]).toEqual(['author', 'footprint']);
  });

  it.each(['author', 'Author', 'AUTHOR', 'footprint', 'foot_print', 'FootPrint'])('does not treat the excluded key %s as secret-like', (key) => {
    expect(isApiWriteKeyNameSecretLike(key)).toBe(false);
  });

  it.each([
    'author_token', 'authorization', 'author_id_token', 'footprint_otp', 'footprintSecret',
    'accesstoken', 'sessionid', 'refreshtoken', 'mypassword', 'xauthtoken', 'csrftoken', 'userpassword', 'apikey', 'auth',
    'session_count', 'hmac_ok',
  ])('keeps the key %s secret-like (only an exact excluded name is excluded)', (key) => {
    expect(isApiWriteKeyNameSecretLike(key)).toBe(true);
  });
});

describe('T41a: the added words of the secret-like names of the API body keys (policy 6)', () => {
  it('has the added words in the lists, and not refresh or card_number', () => {
    expect(API_WRITE_SECRET_LIKE_KEY_WORDS).toEqual(expect.arrayContaining([
      'privkey', 'passwort', 'encryptionkey', 'licensekey', 'hmac', 'securitycode', '秘密鍵', '暗証', 'セッション',
    ]));
    expect(API_WRITE_SECRET_LIKE_KEY_SEGMENTS).toEqual(expect.arrayContaining(['pw', 'salt', 'ssn']));
    for (const word of ['refresh', 'cardnumber', 'card_number']) {
      expect(API_WRITE_SECRET_LIKE_KEY_WORDS as readonly string[]).not.toContain(word);
      expect(API_WRITE_SECRET_LIKE_KEY_SEGMENTS as readonly string[]).not.toContain(word);
    }
  });

  it.each([
    'privkey', 'user_privkey', 'passwort', 'Passwort_Neu', 'encryption_key', 'encryptionKey', 'license_key', 'LicenseKey', 'hmac', 'hmac_sha256', 'security_code',
    'securityCode', '秘密鍵', 'ユーザーの秘密鍵', '暗証', '暗証コード', 'セッション', 'セッションID',
    'pw', 'user_pw', 'pw2', 'PWHash', 'salt', 'password_salt', 'saltValue', 'ssn', 'user_ssn', 'SSNNumber',
  ])('treats %s as secret-like', (key) => {
    expect(isApiWriteKeyNameSecretLike(key)).toBe(true);
  });

  it.each(['salty', 'basalt', 'classname', 'display_name', 'refresh', 'card_number', 'power', 'pwa_mode', 'assn', 'tenant_id', 'email', 'note'])(
    'does not treat the ordinary key %s as secret-like',
    (key) => {
      expect(isApiWriteKeyNameSecretLike(key)).toBe(false);
    },
  );

  it.each([
    ['tóken', 'a combining acute accent in a substring word'],
    ['tóken', 'a precomposed letter with an accent in a substring word'],
    ['pässwort', 'a combining diaeresis in an added substring word'],
    ['sált', 'a combining accent in a word-unit word'],
    ['user_s̀sn', 'a combining grave accent in a word-unit word'],
    ['p̵w', 'a combining stroke overlay in a word-unit word'],
  ])('treats %s as secret-like (%s)', (key) => {
    expect(isApiWriteKeyNameSecretLike(key)).toBe(true);
  });

  it('strips the combining marks after NFD (the part of the text owner)', () => {
    expect(stripCombiningMarks('tóken')).toBe('token');
    expect(stripCombiningMarks('tóken')).toBe('token');
    expect(stripCombiningMarks('abc')).toBe('abc');
    // 濁点は結合文字に分かれて除かれる（比べる語も同じ形にして比べる）。
    expect(stripCombiningMarks('パスワード')).toBe(stripCombiningMarks('パスワード'));
    expect(stripCombiningMarks('ド')).toBe('ト');
  });

  it('keeps the japanese words with a voiced mark secret-like in both forms', () => {
    expect(isApiWriteKeyNameSecretLike('パスワード')).toBe(true);
    expect(isApiWriteKeyNameSecretLike('パスワード')).toBe(true);
  });
});
