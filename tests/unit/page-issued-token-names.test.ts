// T31R2-fix-1（C-1。DEF-108 の残り）: 書き込みの照合で名前だけを照らす（値を読まない）欄の名前の判定（`src/discovery/read-check-contracts.ts` の
// `isPageIssuedTokenFieldName`）。ページが読み込みごとに作る値（CSRF のトークンなど）の閉じた一覧の語に、語の単位で当たる名前だけ。ほかの秘密に
// 見える名前（`code`・`key`・`ticket` など）は当たらない（その欄がある画面は、書き込みの期待の作り手が止める）。
import { describe, expect, it } from 'vitest';
import { PAGE_ISSUED_TOKEN_FIELD_WORDS } from '../../src/core/secret-query-names.js';
import { isPageIssuedTokenFieldName, isUnreadableSecretField } from '../../src/discovery/read-check-contracts.js';

describe('T31R2-fix-1: the names of the values that the page issues on each load', () => {
  it('has a closed list of words', () => {
    expect(PAGE_ISSUED_TOKEN_FIELD_WORDS).toEqual(['csrf', 'xsrf', 'token', 'nonce', 'csrfmiddlewaretoken']);
    expect(Object.isFrozen(PAGE_ISSUED_TOKEN_FIELD_WORDS)).toBe(true);
  });

  it.each([
    'csrf_token', 'xsrf-token', 'authenticity_token', '_token', 'token', 'nonce', '__RequestVerificationToken', 'csrfmiddlewaretoken', '_csrf',
    'X-CSRF-Token', 'form[_token]',
  ])('matches %s', (name) => {
    expect(isPageIssuedTokenFieldName(name)).toBe(true);
  });

  it.each(['code', 'key', 'ticket', 'state', 'api_key', 'session', 'tokenizer', 'nonces_count', 'lock_version', 'id', 'member[_destroy]', ''])(
    'does not match %s',
    (name) => {
      expect(isPageIssuedTokenFieldName(name)).toBe(false);
    },
  );
});

// T31R2-fix-1（C-1）: 値を読めず照らせない、秘密に見える名前の欄の判定（書き込みの期待の作り手と、シナリオの下書きの確かめが共用する）。
describe('T31R2-fix-1: the fields with a secret-like name whose value cannot be read and checked', () => {
  type Field = Parameters<typeof isUnreadableSecretField>[0];
  const field = (name: string, type: Field['type'], flags: Partial<Pick<Field, 'hidden' | 'readonly' | 'disabled'>> = {}): Field =>
    ({ name, type, hidden: false, readonly: false, disabled: false, ...flags });

  it.each<[string, Field]>([
    ['a hidden code', field('code', 'hidden', { hidden: true })],
    ['a readonly key', field('key', 'text', { readonly: true })],
    ['an invisible ticket', field('ticket', 'text', { hidden: true })],
    ['an invisible checkbox named state', field('state', 'checkbox', { hidden: true })],
    ['a hidden-type field that the probe saw as visible', field('api_key', 'hidden')],
  ])('matches %s', (_label, candidate) => {
    expect(isUnreadableSecretField(candidate)).toBe(true);
  });

  it.each<[string, Field]>([
    ['the CSRF hidden (a page-issued token)', field('authenticity_token', 'hidden', { hidden: true })],
    ['a disabled hidden code', field('code', 'hidden', { hidden: true, disabled: true })],
    ['an invisible file named key', field('key', 'file', { hidden: true })],
    ['a visible, editable code', field('code', 'text')],
    ['a hidden field with a name that does not look secret', field('lock_version', 'hidden', { hidden: true })],
    ['a field without a name', field('', 'hidden', { hidden: true })],
  ])('does not match %s', (_label, candidate) => {
    expect(isUnreadableSecretField(candidate)).toBe(false);
  });
});
