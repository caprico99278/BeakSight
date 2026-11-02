/**
 * T43b（Task 43 の設計書 4.2。区分 a）: 開始の URL から、作成の画面が埋める案（`src/display/start-url-draft.ts`。ブラウザと
 * ビルドを使わない純粋な部品の確かめ）。
 * - プロファイルの ID の案は、ホスト名から `PROFILE_ID_PATTERN` に合う形に直したもの。合う形にできなければ空。
 * - 許可 Origin の案は、開始の URL の Origin（1 つ）。受けない開始の URL では、案を出さない。
 * - 認証の設定の案（監査の path と成功の画面の path）は、MI-3 で `src/control/auth/auth-setup-proposal.ts` へ移した（確かめは `tests/unit/auth-setup-proposal.test.ts`）。
 * - 作るファイルの場所は `local/targets/<profileId>.json` の形だけ（プロファイルの ID の形に合わない値ではパスを作らない）。
 */
import { describe, expect, it } from 'vitest';
import { PROFILE_ID_PATTERN } from '../../../src/control/contracts.js';
import { isAcceptedTargetConfigPath } from '../../../src/control/profile-policy.js';
import {
  generatedTargetConfigPathOf,
  profileDraftOf,
  profileIdSuggestionOf,
  uniqueProfileIdOf,
} from '../src/display/start-url-draft';

describe('T43b: the profile id suggested from the start URL', () => {
  it('makes the host name fit the profile id pattern', () => {
    expect(profileIdSuggestionOf('https://www.Example.test/admin/')).toBe('www-example-test');
    expect(profileIdSuggestionOf('http://127.0.0.1:8080/')).toBe('127-0-0-1');
    expect(profileIdSuggestionOf('https://xn--r8jz45g.example.test/')).toBe('xn--r8jz45g-example-test');
    expect(profileIdSuggestionOf('http://[::1]:8080/')).toBe('1');
    expect(profileIdSuggestionOf('https://under_score.example.test/')).toBe('under-score-example-test');
  });

  it('cuts a long host name to the longest prefix that fits, without a trailing hyphen', () => {
    const host = `${'a'.repeat(40)}.${'b'.repeat(40)}.example.test`;
    const suggestion = profileIdSuggestionOf(`https://${host}/`);
    expect(PROFILE_ID_PATTERN.test(suggestion)).toBe(true);
    expect(suggestion.endsWith('-')).toBe(false);
    expect(`${host.replaceAll('.', '-')}`.startsWith(suggestion)).toBe(true);
    expect(suggestion.length).toBeGreaterThan(40);
  });

  it('suggests nothing for a value that is not an accepted start URL', () => {
    for (const value of ['', 'example.test', 'ftp://example.test/', 'https://user@example.test/', 'https://example.test/#x']) {
      expect(profileIdSuggestionOf(value), value).toBe('');
    }
  });
});

describe('T43b: the profile draft', () => {
  it('suggests the id and the origin of the start URL as the allowed origin', () => {
    expect(profileDraftOf('https://example.test/admin/?x=1')).toEqual({ profileId: 'example-test', allowedOrigins: ['https://example.test'] });
    expect(profileDraftOf('http://127.0.0.1:4173/')).toEqual({ profileId: '127-0-0-1', allowedOrigins: ['http://127.0.0.1:4173'] });
  });

  it('suggests nothing for a rejected start URL', () => {
    expect(profileDraftOf('https://example.test/#top')).toEqual({ profileId: '', allowedOrigins: [] });
    expect(profileDraftOf('')).toEqual({ profileId: '', allowedOrigins: [] });
  });
});

describe('T43b: the path of the generated target configuration file', () => {
  it('is always local/targets/<id>.json, accepted by the profile path rule', () => {
    expect(generatedTargetConfigPathOf('example-test')).toBe('local/targets/example-test.json');
    expect(isAcceptedTargetConfigPath(generatedTargetConfigPathOf('example-test') ?? '')).toBe(true);
  });

  it('makes no path for a value that is not a profile id (it never writes to an arbitrary path)', () => {
    // CC-101（T43R-fix-D2）: Windows の予約名（`con`・`nul`・`com1` など）でも、パスを作らない（画面は場所を示さない）。
    for (const bad of ['', '../x', 'a/b', 'A', '-a', 'a.json', 'a\\b', 'a:b', `a${'b'.repeat(63)}`, 'con', 'nul', 'aux', 'prn', 'com1', 'lpt9']) {
      expect(generatedTargetConfigPathOf(bad), bad).toBeUndefined();
    }
  });
});

// MI-3: 認証の設定の案（T43b の `authSetupDraftOf`）の確かめは、移した先の `tests/unit/auth-setup-proposal.test.ts` へ移した。

// MI-1（設計書 `doc/design/2026-10-26-beaksight-minimal-input-ux-design.md` 4.2 の「隠す値」の表）: 名前の案が、既にあるプロファイルの名前や作るファイルの
// 名前と重なるときは、`-2`、`-3`…を付ける（形の決まり `PROFILE_ID_PATTERN` と長さの上限を守る）。
describe('MI-1: the profile id that does not collide with the taken names', () => {
  it('keeps the suggestion when it is free, and adds -2, -3 when it is taken', () => {
    expect(uniqueProfileIdOf('shop-example-test', new Set())).toBe('shop-example-test');
    expect(uniqueProfileIdOf('shop-example-test', new Set(['shop-example-test']))).toBe('shop-example-test-2');
    expect(uniqueProfileIdOf('shop-example-test', new Set(['shop-example-test', 'shop-example-test-2']))).toBe('shop-example-test-3');
  });

  it('cuts the suggestion so that the numbered name still fits the pattern and its length limit', () => {
    const longest = 'a'.repeat(63);
    expect(PROFILE_ID_PATTERN.test(longest)).toBe(true);
    const numbered = uniqueProfileIdOf(longest, new Set([longest]));
    expect(numbered).toBe(`${'a'.repeat(61)}-2`);
    expect(PROFILE_ID_PATTERN.test(numbered)).toBe(true);
    // 切った末尾がハイフンなら、番号の前に二重のハイフンを作らない。
    const hyphenAtCut = `${'a'.repeat(60)}-bc`;
    expect(uniqueProfileIdOf(hyphenAtCut, new Set([hyphenAtCut]))).toBe(`${'a'.repeat(60)}-2`);
  });

  it('does not use a Windows reserved name, and gives no name for an empty suggestion', () => {
    expect(uniqueProfileIdOf('con', new Set())).toBe('con-2');
    expect(uniqueProfileIdOf('', new Set())).toBe('');
  });
});
