// U17a（Task 14〜17 の設計書 6.1.5）: 設定のエラーは、種類のコードと詳細の一覧を持つ `ConfigError` で表す。
import { describe, expect, it } from 'vitest';
import { CONFIG_ERROR_KINDS, ConfigError, isConfigError } from '../../src/config/config-error.js';
import { CONFIG_ERROR_DESCRIPTIONS, describeConfigError } from '../../src/presentation/messages.js';

const JAPANESE_CHARACTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

describe('ConfigError', () => {
  it('has the kind code, the technical message and the list of details', () => {
    const error = new ConfigError('CONFIG_INVALID', 'invalid configuration', ['crawl.maxPages must be a positive integer', 'site.allowedOrigins must not be empty']);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ConfigError');
    expect(error.kind).toBe('CONFIG_INVALID');
    expect(error.message).toBe('invalid configuration');
    expect(error.details).toEqual(['crawl.maxPages must be a positive integer', 'site.allowedOrigins must not be empty']);
    expect(isConfigError(error)).toBe(true);
  });

  it('copies and freezes the details, and has no details when none are given', () => {
    const details = ['first'];
    const error = new ConfigError('CONFIG_FILE_NOT_FOUND', 'missing');
    const withDetails = new ConfigError('CONFIG_FILE_NOT_FOUND', 'missing', details);
    details.push('second');

    expect(error.details).toEqual([]);
    expect(withDetails.details).toEqual(['first']);
    expect(Object.isFrozen(withDetails.details)).toBe(true);
  });

  it('keeps the cause', () => {
    const cause = new Error('ENOENT');
    expect(new ConfigError('CONFIG_FILE_NOT_FOUND', 'missing', [], { cause }).cause).toBe(cause);
  });

  it('rejects a kind that is not in the list', () => {
    expect(() => new ConfigError('NOT_A_KIND' as never, 'x')).toThrow(RangeError);
  });

  it('is told apart from other errors', () => {
    expect(isConfigError(new Error('x'))).toBe(false);
    expect(isConfigError({ kind: 'CONFIG_INVALID', details: [] })).toBe(false);
    expect(isConfigError(null)).toBe(false);
  });

  it('has a list of kinds that is frozen and has no duplicates', () => {
    expect(Object.isFrozen(CONFIG_ERROR_KINDS)).toBe(true);
    expect(new Set(CONFIG_ERROR_KINDS).size).toBe(CONFIG_ERROR_KINDS.length);
  });
});

describe('Japanese descriptions of the configuration errors (messages.ts)', () => {
  it('has exactly one Japanese description for every kind', () => {
    expect(Object.keys(CONFIG_ERROR_DESCRIPTIONS).sort()).toEqual([...CONFIG_ERROR_KINDS].sort());
    for (const kind of CONFIG_ERROR_KINDS) {
      const description = describeConfigError(kind);
      expect(description, kind).toMatch(JAPANESE_CHARACTER);
      expect(description, kind).not.toContain(kind);
    }
  });

  it('gives different kinds different descriptions', () => {
    const descriptions = CONFIG_ERROR_KINDS.map((kind) => describeConfigError(kind));
    expect(new Set(descriptions).size).toBe(CONFIG_ERROR_KINDS.length);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CONFIG_ERROR_DESCRIPTIONS)).toBe(true);
  });
});
