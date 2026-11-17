// PL-F 修正の 1 回目（安全のレビュー PL-REV の Minor 2）: 自由に書く文の「秘密に見える値」の唯一の判定（`src/core/secret-like-text.ts` の
// `isSecretLikeText`）。当てるもの（userinfo のある URL、秘密に見える名前の `name=value`、認証の scheme の後に値が続く形）と、通すもの（query のある
// ふつうの URL、語の一部に auth・session を含む参照、日本語の文）を表で固定する。値は匿名の合成のテストデータだけ。
import { describe, expect, it } from 'vitest';
import { isSecretLikeText } from '../../src/core/secret-like-text.js';

describe('isSecretLikeText', () => {
  it.each([
    // レビューで受けてしまった 3 つの値。
    ['a secret-like name and its value', 'password=hunter2'],
    ['a Bearer scheme and its value', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
    ['a URL with userinfo', 'https://user:pass@example.invalid/x'],
    // ほかの形。
    ['a secret-like name in the query of a URL', 'https://wiki.example.invalid/page?id=3&access_token=abc123'],
    ['a secret-like name inside a sentence', '記録は passwd=abc を参照'],
    ['a percent-encoded secret-like name', 'api%5Fkey=abcdef'],
    ['a Basic scheme and its value', 'Basic dXNlcjpwYXNzd29yZA=='],
    ['a lowercase bearer scheme and its value', 'authorization: bearer abc123def'],
    ['a URL with a user name only', 'ssh://deploy@example.invalid/repo'],
  ])('finds %s', (_name, text) => {
    expect(isSecretLikeText(text)).toBe(true);
  });

  it.each([
    ['a URL with an ordinary query', 'https://wiki.example.invalid/page?id=3'],
    ['a reference that contains auth in a word', 'auth-server-isolation'],
    ['a reference that contains session in a word', 'session-store-isolation-check'],
    ['a path-like reference', 'evidence/example-test-env/isolation-check-1'],
    ['a Japanese sentence', '本番から切り離されていることをチケットで確かめた'],
    ['a Japanese sentence with a number', 'チケット 123 認証サーバの隔離'],
    ['the unverified reference', 'isolation-unverified-20261027'],
    ['an ordinary name and value', 'ticket-id=ABC-123'],
    ['a sentence with an ordinary word after Basic', 'Basic check of the isolation'],
    ['an empty text', ''],
  ])('passes %s', (_name, text) => {
    expect(isSecretLikeText(text)).toBe(false);
  });
});
