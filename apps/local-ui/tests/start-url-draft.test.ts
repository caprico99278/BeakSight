/**
 * T43b（Task 43 の設計書 4.2。区分 a）: 開始の URL から、作成の画面と認証の設定の画面が埋める案（`src/display/start-url-draft.ts`。ブラウザと
 * ビルドを使わない純粋な部品の確かめ）。
 * - プロファイルの ID の案は、ホスト名から `PROFILE_ID_PATTERN` に合う形に直したもの。合う形にできなければ空。
 * - 許可 Origin の案は、開始の URL の Origin（1 つ）。受けない開始の URL では、案を出さない。
 * - 認証の設定の案は、監査の path と成功の画面の path（どちらも開始の URL の path）。開始の URL が読めなければ案を出さない。
 * - 作るファイルの場所は `local/targets/<profileId>.json` の形だけ（プロファイルの ID の形に合わない値ではパスを作らない）。
 */
import { describe, expect, it } from 'vitest';
import { PROFILE_ID_PATTERN } from '../../../src/control/contracts.js';
import { isAcceptedTargetConfigPath } from '../../../src/control/profile-policy.js';
import { authSetupDraftOf, generatedTargetConfigPathOf, profileDraftOf, profileIdSuggestionOf } from '../src/display/start-url-draft';

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

describe('T43b: the auth setup draft', () => {
  it('fills the audit path and the success path with the path of the start URL', () => {
    expect(authSetupDraftOf('/admin/')).toEqual({ auditPathPrefixes: ['/admin/'], successPathPrefix: '/admin/' });
    expect(authSetupDraftOf('/')).toEqual({ auditPathPrefixes: ['/'], successPathPrefix: '/' });
  });

  it('fills nothing without the path', () => {
    expect(authSetupDraftOf(null)).toEqual({ auditPathPrefixes: [], successPathPrefix: '' });
  });
});
